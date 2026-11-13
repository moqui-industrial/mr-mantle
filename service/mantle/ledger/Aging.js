// The aging of an organization's receivables or payables as of a day (LedgerReportServices.run#Aging; design-accounting
// §13 Aging, F36): each invoice open on that day (issued by then, less what was applied by then), each portion of its due
// schedule in the bucket of its days past due on that day. Days are calendar days compared in JavaScript, so a past day
// buckets the same on every database. More open invoices than one report reads are named (complete false), never cut
// silently.
const policy = ec.resource.script("component://mr-mantle/service/mantle/ledger/AccountingPolicy.js")
const invoiceLib = ec.resource.script("component://mr-mantle/service/mantle/account/InvoiceWorkflowLib.js")
const terms = () => ec.resource.script("component://mr-mantle/service/mantle/account/PaymentTerms.js")
const {find, denied} = policy
const I = "mantle.account.invoice.Invoice"
const RECEIVABLE_STATUSES = ["InvoiceFinalized", "InvoiceSent", "InvoiceAcked", "InvoicePmtRecvd", "InvoiceWriteOff"]
const PAYABLE_STATUSES = ["InvoiceApproved", "InvoicePmtSent", "InvoiceBilledThrough"]
const INVOICE_LIMIT = 5000
const BATCH = 500
const today = () => ec.l10n.format(ec.user.nowTimestamp, "yyyy-MM-dd")
const dayNumber = day => {
    const [year, month, date] = String(day).split("-").map(Number)
    return Date.UTC(year, month - 1, date) / 86400000
}
const dayOf = value =>
    value == null || value === ""
        ? null
        : /^\d{4}-\d{2}-\d{2}$/.test(String(value))
          ? String(value)
          : policy.lib.bookDay(null, value)

function buckets(periodDays) {
    const labels = ["Current"]
    for (let index = 0; index < 4; index++) labels.push(index * periodDays + 1 + "–" + (index + 1) * periodDays + " days")
    labels.push("Over " + 4 * periodDays + " days")
    return labels
}
// The bucket of a portion due on a day, as of another: 0 not yet due (or due that day), 1–4 the periods, 5 beyond.
function bucketOf(dueDay, asOf, periodDays) {
    if (!dueDay) return 0
    const late = dayNumber(asOf) - dayNumber(dueDay)
    if (late <= 0) return 0
    return Math.min(5, Math.ceil(late / periodDays))
}
const empty = () => [0, 1, 2, 3, 4, 5].map(() => toDecimal(0))

// The open portions of invoices, as of the end of a day (now when none is given): what each invoice still owes, and each
// portion of its due schedule (PaymentTerms.schedules) with what is left of it, what was applied settling the earliest
// portions first; a portion past the schedule (rounding, or a total changed since it was written) is due on the invoice's
// due day. Invoices with nothing open are left out. Aging, dunning and the credit check age by these portions.
function openPortions(invoices, asOfEnd = null) {
    const list = Array.from(invoices || [])
    if (!list.length) return {}
    const totals = invoiceLib.totalsMany(list, asOfEnd)
    const schedules = terms().schedules(list, asOfEnd || ec.user.nowTimestamp)
    const out = {}
    for (const invoice of list) {
        const value = totals[invoice.invoiceId]
        if (!value || value.unpaidTotal.isZero()) continue
        const fallbackDay = dayOf(invoice.dueDate) || dayOf(invoice.accountingDate) || dayOf(invoice.invoiceDate)
        const portions = []
        const rows = schedules[invoice.invoiceId]?.rows || []
        if (!rows.length || value.unpaidTotal.compare(0) < 0) portions.push({dueDay: fallbackDay, amount: value.unpaidTotal})
        else {
            let paid = value.invoiceTotal.subtract(value.unpaidTotal)
            let aged = toDecimal(0)
            for (const portion of rows) {
                let left = toDecimal(portion.amount ?? 0)
                const settled = paid.compare(left) >= 0 ? left : paid.compare(0) > 0 ? paid : toDecimal(0)
                left = left.subtract(settled)
                paid = paid.subtract(settled)
                if (left.isZero()) continue
                portions.push({dueDay: portion.dueDateText || fallbackDay, amount: left})
                aged = aged.add(left)
            }
            const rest = value.unpaidTotal.subtract(aged)
            if (!rest.isZero()) portions.push({dueDay: fallbackDay, amount: rest})
        }
        out[invoice.invoiceId] = {invoiceTotal: value.invoiceTotal, unpaidTotal: value.unpaidTotal, portions}
    }
    return out
}
// What of each invoice is past due on a day (portions due before it) and its oldest such due day; with asOfEnd (a past
// day's end) what was open then.
function pastDue(invoices, day, asOfEnd = null) {
    const opens = openPortions(invoices, asOfEnd)
    const out = {}
    for (const [invoiceId, value] of Object.entries(opens)) {
        const due = value.portions.filter(portion => portion.dueDay && portion.dueDay < day)
        if (!due.length) continue
        const oldest = due.map(portion => portion.dueDay).sort()[0]
        out[invoiceId] = {
            amount: due.reduce((sum, portion) => sum.add(portion.amount), toDecimal(0)),
            oldestDueDay: oldest,
            daysOverdue: dayNumber(day) - dayNumber(oldest),
            unpaidTotal: value.unpaidTotal
        }
    }
    return out
}

function aging(p) {
    const payable = p.invoiceType === "payable"
    const s = policy.organization(p, "read")
    const c = s.capabilities
    if (!(c.reportRead || c.admin || c.systemAdmin || (payable ? c.apRead : c.arRead)))
        denied("PERMISSION_DENIED", (payable ? "Payables" : "Receivables") + " or report read authority is required")
    const organizationPartyId = s.organizationPartyId
    // a calendar day (a Date parameter), not a moment in the user's zone
    const asOf = p.asOfDate ? policy.calendarDateText(p.asOfDate) : today()
    if (asOf > today()) denied("AS_OF_FUTURE", "Age as of today or an earlier day")
    const periodDays = Math.max(1, Math.min(365, Number(p.periodDays) || 30))
    const asOfEnd = ec.l10n.parseTimestamp(asOf + " 23:59:59.999", "yyyy-MM-dd HH:mm:ss.SSS")
    const statuses = payable ? PAYABLE_STATUSES : RECEIVABLE_STATUSES
    const orgField = payable ? "toPartyId" : "fromPartyId",
        partyField = payable ? "fromPartyId" : "toPartyId"
    const scoped = query => {
        let q = query.condition(orgField, organizationPartyId).condition("statusId", "in", statuses)
        q = q.condition("invoiceDate", "less-equals", asOfEnd)
        if (p.partyId) q = q.condition(partyField, p.partyId)
        if (p.currencyUomId) q = q.condition("currencyUomId", p.currencyUomId)
        return q
    }
    // open as of the day: unpaid now, or paid by an application after it
    const ids = new Set()
    for (const row of scoped(find(I))
        .condition("unpaidTotal", "not-equals", toDecimal(0))
        .selectField("invoiceId")
        .orderBy("invoiceId")
        .limit(INVOICE_LIMIT + 1)
        .list())
        ids.add(row.invoiceId)
    for (const view of [
        "mantle.account.payment.PaymentApplicationAndInvoice",
        "mantle.account.payment.PaymentApplicationToInvoice"
    ])
        for (const row of scoped(find(view))
            .condition("appliedDate", "greater", asOfEnd)
            .selectField("invoiceId")
            .distinct(true)
            .limit(INVOICE_LIMIT + 1)
            .list())
            ids.add(row.invoiceId)
    const incomplete = ids.size > INVOICE_LIMIT
    const candidateIds = Array.from(ids).sort().slice(0, INVOICE_LIMIT)
    const groups = new Map()
    const detailRows = []
    let invoiceCount = 0,
        read = 0
    const names = {}
    for (let start = 0; start < candidateIds.length; start += BATCH) {
        const batch = Array.from(
            scoped(find(I))
                .condition("invoiceId", "in", candidateIds.slice(start, start + BATCH))
                .list()
        )
        read += batch.length
        if (!batch.length) continue
        const opens = openPortions(batch, asOfEnd)
        const open = batch.filter(row => opens[row.invoiceId])
        if (!open.length) continue
        Object.assign(names, policy.lib.partyNames(open.map(row => row[partyField])))
        // People P27 (AC-23): a payroll-origin invoice is a reader of payroll's; anyone else sees them as one "Payroll" row a
        // currency, so the totals still reconcile, and never its person or its detail
        const origin = ec.resource.script("component://mr-mantle/service/mantle/account/PayrollOrigin.js")
        const payroll = origin.canRead() ? new Set() : new Set(origin.payrollInvoiceIds(open.map(row => row.invoiceId)))
        for (const invoice of open) {
            const masked = payroll.has(invoice.invoiceId)
            const partyId = masked ? "_PAYROLL_" : invoice[partyField]
            if (masked) names[partyId] = "Payroll"
            if (!names[partyId]) continue
            const value = opens[invoice.invoiceId]
            const currency = invoice.currencyUomId
            const amounts = empty()
            for (const portion of value.portions) {
                const index = bucketOf(portion.dueDay, asOf, periodDays)
                amounts[index] = amounts[index].add(portion.amount)
            }
            invoiceCount++
            const key = partyId + "|" + currency
            if (!groups.has(key))
                groups.set(key, {partyId, partyName: names[partyId], currencyUomId: currency, amounts: empty(), invoiceCount: 0})
            const group = groups.get(key)
            group.invoiceCount++
            for (let index = 0; index < 6; index++) group.amounts[index] = group.amounts[index].add(amounts[index])
            if (p.partyId && !masked && detailRows.length < 500) {
                const index = amounts.findIndex(amount => !amount.isZero())
                detailRows.push({
                    invoiceId: invoice.invoiceId,
                    referenceNumber: invoice.referenceNumber || "",
                    invoiceDateText: dayOf(invoice.accountingDate) || dayOf(invoice.invoiceDate) || "",
                    dueDateText: dayOf(invoice.dueDate) || "",
                    currencyUomId: currency,
                    invoiceTotal: value.invoiceTotal,
                    openAmount: value.unpaidTotal,
                    bucket: index < 0 ? 0 : index,
                    daysPastDue: Math.max(0, dayNumber(asOf) - dayNumber(dayOf(invoice.dueDate) || asOf))
                })
            }
        }
    }
    const shape = (amounts, currency) => ({
        current: ec.l10n.roundCurrency(amounts[0], currency),
        period1: ec.l10n.roundCurrency(amounts[1], currency),
        period2: ec.l10n.roundCurrency(amounts[2], currency),
        period3: ec.l10n.roundCurrency(amounts[3], currency),
        period4: ec.l10n.roundCurrency(amounts[4], currency),
        periodRemaining: ec.l10n.roundCurrency(amounts[5], currency),
        total: ec.l10n.roundCurrency(
            amounts.reduce((sum, amount) => sum.add(amount), toDecimal(0)),
            currency
        )
    })
    const rows = Array.from(groups.values())
        .map(group =>
            Object.assign(
                {
                    partyId: group.partyId,
                    partyName: group.partyName,
                    currencyUomId: group.currencyUomId,
                    invoiceCount: group.invoiceCount
                },
                shape(group.amounts, group.currencyUomId)
            )
        )
        .sort((a, b) => a.currencyUomId.localeCompare(b.currencyUomId) || b.total.compare(a.total))
    const byCurrency = new Map()
    for (const group of groups.values()) {
        if (!byCurrency.has(group.currencyUomId)) byCurrency.set(group.currencyUomId, empty())
        const sums = byCurrency.get(group.currencyUomId)
        for (let index = 0; index < 6; index++) sums[index] = sums[index].add(group.amounts[index])
    }
    const totals = Array.from(byCurrency.entries())
        .map(([currency, amounts]) => Object.assign({currencyUomId: currency}, shape(amounts, currency)))
        .sort((a, b) => a.currencyUomId.localeCompare(b.currencyUomId))
    const complete = !incomplete
    return {
        organizationPartyId,
        asOfDate: asOf,
        asOfDateText: asOf,
        invoiceType: payable ? "payable" : "receivable",
        periodDays,
        bucketLabels: buckets(periodDays),
        agingRows: rows,
        totals,
        detailRows,
        invoiceCount,
        complete,
        incompleteReason: complete
            ? null
            : "More than " +
              INVOICE_LIMIT +
              " invoices were open on the day; the report covers the first " +
              read +
              ". Choose a customer or currency to see the rest."
    }
}

;({
    bucketOf,
    openPortions,
    pastDue,
    execute(op, parameters) {
        if (op !== "aging") throw new Error("Unknown aging operation " + op)
        return aging(parameters)
    }
})
