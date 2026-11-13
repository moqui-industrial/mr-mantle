const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/AccountingPolicy.js")
const payrollOrigin = () => ec.resource.script("component://mr-mantle/service/mantle/account/PayrollOrigin.js")
const SUMMARY = "mantle.ledger.transaction.AcctgTransAndEntrySummary"
function base(p, before = false) {
    const s = lib.organization(p, "reportRead")
    lib.dimensions(s.organizationPartyId, p)
    if (p.amountUomId) lib.currency(p.amountUomId)
    let q = lib.find(SUMMARY, {
        organizationPartyId: s.organizationPartyId,
        isPosted: "Y"
    })
    for (const field of ["glAccountId", "amountUomId", "debitCreditFlag", "amount"]) q = q.selectField(field)
    if (p.glAccountId) {
        lib.record({
            kind: "accounts",
            recordId: p.glAccountId,
            organizationPartyId: s.organizationPartyId
        })
        q = q.condition("glAccountId", p.glAccountId)
    }
    if (p.amountUomId) q = q.condition("amountUomId", p.amountUomId)
    if (p.facilityId) q = q.condition("facilityId", p.facilityId)
    if (p.costCenterId) q = q.condition("costCenterId", p.costCenterId)
    const dates = before
        ? lib.accountingDateCondition({
              thruDate: p.fromDate || new Date(0),
              thruDay: p.fromAccountingDate || "1970-01-01"
          })
        : lib.accountingDateCondition({
              fromDate: p.fromDate,
              thruDate: p.thruDate,
              fromDay: p.fromAccountingDate,
              thruDay: p.thruAccountingDate
          })
    if (dates) q = q.condition(dates)
    return {q, s}
}
function options(p) {
    const out = Object.assign({}, p)
    // Always recompute these internal bounds; comparison options may inherit the main report's values.
    out.fromAccountingDate = p.fromDate ? ec.l10n.format(p.fromDate, "yyyy-MM-dd") : null
    out.thruAccountingDate = p.thruDate ? ec.l10n.format(p.thruDate, "yyyy-MM-dd") : null
    delete out.period
    if (p.timePeriodId) {
        // the organization's own period or one of an organization it rolls up to, whose periods it books in
        const period = lib.record({
            kind: "periods",
            recordId: p.timePeriodId,
            organizationPartyId: p.organizationPartyId
        })
        // the period's days start at midnight in the user's zone, as undated postings are booked by that zone's day
        const fromDay = lib.calendarDateText(period.fromDate)
        const afterDay = lib.calendarDateText(Date.parse(lib.calendarDateText(period.thruDate)) + 86400000)
        out.fromDate = ec.l10n.parseTimestamp(fromDay, "yyyy-MM-dd")
        out.thruDate = ec.l10n.parseTimestamp(afterDay, "yyyy-MM-dd")
        out.fromAccountingDate = fromDay
        out.thruAccountingDate = afterDay
        out.period = period
    }
    if (
        (out.fromDate && !Number.isFinite(lib.ms(out.fromDate))) ||
        (out.thruDate && !Number.isFinite(lib.ms(out.thruDate))) ||
        (out.fromDate && out.thruDate && lib.ms(out.fromDate) >= lib.ms(out.thruDate))
    )
        throw new Error("Choose an increasing report date range")
    return out
}
function trial(p) {
    p = options(p)
    const {q, s} = base(p),
        totals = new Map()
    const entry = r => {
        const key = r.glAccountId + ":" + r.amountUomId
        if (!totals.has(key))
            totals.set(key, {
                glAccountId: r.glAccountId,
                amountUomId: r.amountUomId,
                beginning: toDecimal(0),
                debits: toDecimal(0),
                credits: toDecimal(0),
                ending: toDecimal(0)
            })
        return totals.get(key)
    }
    const movement = Array.from(q.list()),
        beginning = Array.from(base(p, true).q.list())
    if (p.period?.isClosed === "Y" && !p.facilityId && !p.costCenterId) {
        const currencies = [...new Set(movement.map(r => r.amountUomId))],
            baseCurrency = lib.preference(s.organizationPartyId).baseCurrencyUomId
        if (p.amountUomId && p.amountUomId !== baseCurrency && !movement.length)
            return {
                reportRows: [],
                organizationPartyId: s.organizationPartyId,
                asOf: ec.l10n.format(ec.user.nowTimestamp, "yyyy-MM-dd HH:mm:ss"),
                complete: true
            }
        if (currencies.some(c => c !== baseCurrency)) throw new Error("Closed-period summaries cannot represent mixed currencies")
        let summaries = lib.find("mantle.ledger.account.GlAccountOrgTimePeriod", {
            organizationPartyId: s.organizationPartyId,
            timePeriodId: p.timePeriodId
        })
        if (p.glAccountId) summaries = summaries.condition("glAccountId", p.glAccountId)
        const stored = Array.from(summaries.list())
        if ([...movement, ...beginning].some(r => !stored.some(summary => summary.glAccountId === r.glAccountId)))
            throw new Error("Closed-period summary is incomplete; run period close reconciliation")
        for (const row of stored)
            Object.assign(
                entry({
                    glAccountId: row.glAccountId,
                    amountUomId: baseCurrency
                }),
                {
                    beginning: toDecimal(row.beginningBalance || 0),
                    debits: toDecimal(row.postedDebits || 0),
                    credits: toDecimal(row.postedCredits || 0),
                    ending: toDecimal(row.endingBalance || 0),
                    closedSummary: true
                }
            )
    } else {
        for (const row of beginning) {
            const total = entry(row)
            total.beginning = total.beginning.add(toDecimal(row.amount).multiply(row.debitCreditFlag === "D" ? 1 : -1))
        }
        for (const row of movement) {
            const total = entry(row)
            const field = row.debitCreditFlag === "D" ? "debits" : "credits"
            total[field] = total[field].add(row.amount)
        }
        for (const row of totals.values()) row.ending = row.beginning.add(row.debits).subtract(row.credits)
    }
    const ids = [...new Set([...totals.values()].map(r => r.glAccountId))]
    const names = Object.fromEntries(
        ids.length
            ? Array.from(lib.find("mantle.ledger.account.GlAccount").condition("glAccountId", "in", ids).list()).map(r => [
                  r.glAccountId,
                  {name: r.accountName, isDebit: r.isDebit}
              ])
            : []
    )
    return {
        reportRows: [...totals.values()].map(r => {
            const account = names[r.glAccountId]
            if (r.closedSummary && account?.isDebit !== "Y") {
                r.beginning = r.beginning.negate()
                r.ending = r.ending.negate()
            }
            return Object.assign(r, {accountName: account?.name})
        }),
        asOf: ec.l10n.format(ec.user.nowTimestamp, "yyyy-MM-dd HH:mm:ss"),
        organizationPartyId: s.organizationPartyId,
        complete: true
    }
}
function ledger(p) {
    p = options(p)
    const {s} = base(p)
    let q = lib.find("mantle.ledger.transaction.AcctgTransAndEntry", {
        organizationPartyId: s.organizationPartyId,
        isPosted: "Y"
    })
    for (const field of ["glAccountId", "amountUomId", "facilityId", "costCenterId"])
        if (p[field]) q = q.condition(field, p[field])
    const dates = lib.accountingDateCondition({
        fromDate: p.fromDate,
        thruDate: p.thruDate,
        fromDay: p.fromAccountingDate,
        thruDay: p.thruAccountingDate
    })
    if (dates) q = q.condition(dates)
    // People P27 review (AC-23): a reader without PAYROLL_VIEW sees an account's payroll-origin lines as one masked "Payroll" line
    // (no entry, date or person), so the account's balances still reconcile
    const origin = payrollOrigin()
    const masking = !origin.canRead()

    const balances = {}
    for (const row of Array.from(base(p, true).q.list())) {
        const key = row.glAccountId + ":" + row.amountUomId
        balances[key] = (balances[key] || toDecimal(0)).add(toDecimal(row.amount).multiply(row.debitCreditFlag === "D" ? 1 : -1))
    }
    const selected = Array.from(q.orderBy("glAccountId,transactionDate,acctgTransId,acctgTransEntrySeqId").limit(10001).list())
    if (selected.length > 10000) throw new Error("Narrow the ledger to at most 10,000 lines")
    // The bounded result must run in book-day order even when creators use different time zones.
    const effectiveDay = row =>
        row.accountingDate ? lib.calendarDateText(row.accountingDate) : ec.l10n.format(row.transactionDate, "yyyy-MM-dd")
    selected.sort(
        (a, b) =>
            a.glAccountId.localeCompare(b.glAccountId) ||
            effectiveDay(a).localeCompare(effectiveDay(b)) ||
            lib.ms(a.transactionDate) - lib.ms(b.transactionDate) ||
            a.acctgTransId.localeCompare(b.acctgTransId) ||
            a.acctgTransEntrySeqId.localeCompare(b.acctgTransEntrySeqId)
    )
    const reportRows = []
    const maskedRows = {}
    for (const row of selected) {
        const key = row.glAccountId + ":" + row.amountUomId
        balances[key] = (balances[key] || toDecimal(0)).add(toDecimal(row.amount).multiply(row.debitCreditFlag === "D" ? 1 : -1))
        const debits = row.debitCreditFlag === "D" ? toDecimal(row.amount) : toDecimal(0)
        const credits = row.debitCreditFlag === "C" ? toDecimal(row.amount) : toDecimal(0)
        if (masking && row.payrollOrigin === "Y") {
            // the account's payroll lines folded into its one "Payroll" line, at the first one's place
            let masked = maskedRows[key]
            if (!masked) {
                masked = maskedRows[key] = {
                    glAccountId: row.glAccountId,
                    accountName: row.accountName,
                    amountUomId: row.amountUomId,
                    description: "Payroll",
                    payrollMasked: true,
                    debits: toDecimal(0),
                    credits: toDecimal(0)
                }
                reportRows.push(masked)
            }
            masked.debits = masked.debits.add(debits)
            masked.credits = masked.credits.add(credits)
            masked.ending = balances[key]
            continue
        }
        reportRows.push(Object.assign(lib.display(row), {debits, credits, ending: balances[key]}))
    }
    return {
        reportRows,
        organizationPartyId: s.organizationPartyId,
        asOf: ec.l10n.format(ec.user.nowTimestamp, "yyyy-MM-dd HH:mm:ss"),
        complete: true
    }
}
function report(op, p) {
    const result = (op === "trial" ? trial : ledger)(p)
    if (!p.compareFromDate && !p.compareThruDate) return Object.assign(result, {comparisonRows: []})
    if (!p.compareFromDate || !p.compareThruDate) throw new Error("Choose both comparison dates")
    const comparison = (op === "trial" ? trial : ledger)(
        Object.assign({}, p, {
            timePeriodId: null,
            fromDate: p.compareFromDate,
            thruDate: p.compareThruDate
        })
    )
    if (op === "trial") {
        const values = new Map(comparison.reportRows.map(row => [row.glAccountId + ":" + row.amountUomId, row]))
        for (const row of result.reportRows) {
            const key = row.glAccountId + ":" + row.amountUomId
            row.comparisonEnding = values.get(key)?.ending || toDecimal(0)
            row.change = row.ending.subtract(row.comparisonEnding)
            values.delete(key)
        }
        for (const row of values.values())
            result.reportRows.push(
                Object.assign({}, row, {
                    beginning: toDecimal(0),
                    debits: toDecimal(0),
                    credits: toDecimal(0),
                    ending: toDecimal(0),
                    comparisonEnding: row.ending,
                    change: row.ending.negate()
                })
            )
    }
    return Object.assign(result, {comparisonRows: comparison.reportRows})
}
// The invoice reconciliation of a fiscal period (design §13 InvoiceReconciliation): for receivables or payables, the
// period's documents whose open amount differs from their receivable or payable postings, the payments whose applied
// amount differs from theirs, unposted and unbalanced transactions, receivable or payable postings without an invoice,
// and applications of the period to invoices dated after it; with the aging's open total against the ledger balance at
// the period's end. The organization's own records only, and a period of the organization.
const RECEIVABLE_STATUSES = ["InvoiceFinalized", "InvoiceSent", "InvoiceAcked", "InvoicePmtRecvd", "InvoiceWriteOff"]
const PAYABLE_STATUSES = ["InvoiceApproved", "InvoicePmtSent", "InvoiceBilledThrough"]
// An invoice's open amount in the base currency: its own in the base currency; one in another currency at the rate it
// posted at (its total and what was applied each at that rate, as its posting and its applications' postings hold them);
// null when it kept no rate to the base currency.
function openInBase(invoice, applied, currency) {
    const total = toDecimal(invoice.invoiceTotal ?? 0)
    if (!currency || !invoice.currencyUomId || invoice.currencyUomId === currency) return total.subtract(applied)
    if (!invoice.exchangeRate || invoice.exchangeRateToUomId !== currency) return null
    const rate = toDecimal(invoice.exchangeRate)
    return lib.lib.money(total.multiply(rate), currency).subtract(lib.lib.money(applied.multiply(rate), currency))
}
function invoiceReconciliation(p) {
    const s = lib.organization(p, "reportRead")
    if (!p.timePeriodId) throw new Error("PERIOD_REQUIRED: Choose a fiscal period")
    const period = lib.record({kind: "periods", recordId: p.timePeriodId, organizationPartyId: s.organizationPartyId})
    if (period.partyId !== s.organizationPartyId) lib.denied("PERIOD_UNAVAILABLE", "Choose a fiscal period of this organization")
    const org = s.organizationPartyId
    const payable = p.invoiceType === "payable"
    const accountClass = payable ? "ACCOUNTS_PAYABLE" : "ACCOUNTS_RECEIVABLE"
    const sign = payable ? -1 : 1
    const fromDay = lib.calendarDateText(period.fromDate)
    const afterDay = lib.calendarDateText(Date.parse(lib.calendarDateText(period.thruDate)) + 86400000)
    const fromStamp = ec.l10n.parseTimestamp(fromDay, "yyyy-MM-dd"),
        afterStamp = ec.l10n.parseTimestamp(afterDay, "yyyy-MM-dd")
    const inPeriod = lib.accountingDateCondition({fromDate: fromStamp, thruDate: afterStamp, fromDay, thruDay: afterDay})
    const toEnd = lib.accountingDateCondition({thruDate: afterStamp, thruDay: afterDay})
    const cf = ec.entity.conditionFactory
    const invoiceInPeriod = cf.makeCondition(
        [
            cf.makeCondition(
                [
                    cf.makeCondition("accountingDate", "is-not-null", null),
                    cf.makeCondition("accountingDate", "greater-equals", fromDay),
                    cf.makeCondition("accountingDate", "less", afterDay)
                ],
                "and"
            ),
            cf.makeCondition(
                [
                    cf.makeCondition("accountingDate", "is-null", null),
                    cf.makeCondition("invoiceDate", "greater-equals", fromStamp),
                    cf.makeCondition("invoiceDate", "less", afterStamp)
                ],
                "and"
            )
        ],
        "or"
    )
    const currency = lib.preference(org).baseCurrencyUomId
    const reportRows = []
    const rowPayments = new Map()
    const add = (check, checkText, sourceKind, sourceId, description, documentAmount, glAmount) => {
        const row = {
            check,
            checkText,
            sourceKind,
            sourceId,
            description: description || "",
            documentAmount,
            glAmount,
            difference: documentAmount != null && glAmount != null ? toDecimal(documentAmount).subtract(glAmount) : null
        }
        reportRows.push(row)
        return row
    }
    // the net on the receivable or payable accounts of the postings of some documents, through the period's end
    const glNet = (field, ids) => {
        const out = {}
        if (!ids.length) return out
        for (const row of lib
            .find("mantle.ledger.transaction.AcctgTransAndEntryGlaSummary", {organizationPartyId: org, isPosted: "Y"})
            .condition(field, "in", ids)
            .condition("glAccountClassEnumId", accountClass)
            .condition(toEnd)
            .selectField(field)
            .selectField("debitCreditFlag")
            .selectField("amount")
            .list())
            out[row[field]] = (out[row[field]] || toDecimal(0)).add(
                toDecimal(row.amount ?? 0).multiply(row.debitCreditFlag === "D" ? sign : -sign)
            )
        return out
    }
    const appliedThroughEnd = (field, ids) => {
        const out = {}
        if (!ids.length) return out
        for (const row of lib
            .find("mantle.account.payment.PaymentApplication")
            .condition(field, "in", ids)
            .condition("appliedDate", "less", afterStamp)
            .list())
            out[row[field]] = (out[row[field]] || toDecimal(0)).add(toDecimal(row.amountApplied ?? 0))
        return out
    }
    // documents of the period, at most listLimit of each kind: a longer list is reported incomplete, never as no
    // differences
    const limit = Math.max(0, Number(p.listLimit ?? 500))
    const incompleteChecks = []
    const bounded = (check, list) => {
        if (list.length <= limit) return list
        incompleteChecks.push(check)
        return list.slice(0, limit)
    }
    const invoices = bounded(
        "invoiceVsGl",
        Array.from(
            lib
                .find("mantle.account.invoice.Invoice", {[payable ? "toPartyId" : "fromPartyId"]: org})
                .condition("statusId", "in", payable ? PAYABLE_STATUSES : RECEIVABLE_STATUSES)
                .condition(invoiceInPeriod)
                .orderBy("invoiceDate,invoiceId")
                .limit(limit + 1)
                .list()
        )
    )
    const invoiceIds = invoices.map(row => row.invoiceId)
    const invoiceGl = glNet("invoiceId", invoiceIds),
        invoiceApplied = appliedThroughEnd("invoiceId", invoiceIds)
    for (const invoice of invoices) {
        const open = openInBase(invoice, invoiceApplied[invoice.invoiceId] || toDecimal(0), currency)
        if (open == null) {
            if (!incompleteChecks.includes("invoiceVsGl")) incompleteChecks.push("invoiceVsGl")
            continue
        }
        const gl = invoiceGl[invoice.invoiceId] || toDecimal(0)
        if (!open.eq(gl))
            add(
                "invoiceVsGl",
                "Open amount differs from the ledger",
                payable ? "bills" : "invoices",
                invoice.invoiceId,
                invoice.description || invoice.referenceNumber,
                open,
                gl
            )
    }
    const payments = bounded(
        "paymentVsGl",
        Array.from(
            lib
                .find("mantle.account.payment.Payment", {[payable ? "fromPartyId" : "toPartyId"]: org})
                .condition("statusId", "in", ["PmntDelivered", "PmntConfirmed"])
                .condition("effectiveDate", "greater-equals", fromStamp)
                .condition("effectiveDate", "less", afterStamp)
                .orderBy("effectiveDate,paymentId")
                .limit(limit + 1)
                .list()
        )
    )
    const paymentIds = payments.map(row => row.paymentId)
    const paymentGl = glNet("paymentId", paymentIds),
        paymentApplied = appliedThroughEnd("paymentId", paymentIds)
    for (const payment of payments) {
        // a payment in another currency clears its invoices at their rates (post#PaymentApplication), so the ledger holds
        // no amount of its own to compare; it is left out and the check is named incomplete
        if (payment.amountUomId && currency && payment.amountUomId !== currency) {
            if (!incompleteChecks.includes("paymentVsGl")) incompleteChecks.push("paymentVsGl")
            continue
        }
        const applied = paymentApplied[payment.paymentId] || toDecimal(0)
        const gl = (paymentGl[payment.paymentId] || toDecimal(0)).negate()
        if (!applied.eq(gl))
            add(
                "paymentVsGl",
                "Applied amount differs from the ledger",
                "payments",
                payment.paymentId,
                payment.paymentRefNum || payment.comments,
                applied,
                gl
            )
    }
    // transactions of the period
    const unpostedTransactions = bounded(
        "notPosted",
        Array.from(
            lib
                .find("mantle.ledger.transaction.AcctgTrans", {organizationPartyId: org})
                .condition(
                    cf.makeCondition(
                        [cf.makeCondition("isPosted", "is-null", null), cf.makeCondition("isPosted", "equals", "N")],
                        "or"
                    )
                )
                .condition(inPeriod)
                .orderBy("acctgTransId")
                .limit(limit + 1)
                .list()
        )
    )
    for (const tx of unpostedTransactions)
        add(
            "notPosted",
            "Transaction not posted",
            "journals",
            tx.acctgTransId,
            tx.description || tx.acctgTransTypeEnumId,
            null,
            null
        )
    const net = {}
    for (const row of lib
        .find("mantle.ledger.transaction.AcctgTransAndEntrySummary", {organizationPartyId: org, isPosted: "Y"})
        .condition(inPeriod)
        .selectField("acctgTransId")
        .selectField("debitCreditFlag")
        .selectField("amount")
        .list())
        net[row.acctgTransId] = (net[row.acctgTransId] || toDecimal(0)).add(
            toDecimal(row.amount ?? 0).multiply(row.debitCreditFlag === "D" ? 1 : -1)
        )
    for (const id of Object.keys(net).sort())
        if (!net[id].isZero()) add("unbalanced", "Debits and credits differ", "journals", id, null, null, net[id])
    const noInvoice = {}
    for (const row of lib
        .find("mantle.ledger.transaction.AcctgTransAndEntryGlaSummary", {organizationPartyId: org, isPosted: "Y"})
        .condition("glAccountClassEnumId", accountClass)
        .condition("invoiceId", "is-null", null)
        .condition("reverseOfAcctgTransId", "is-null", null)
        .condition("reversedByAcctgTransId", "is-null", null)
        .condition(inPeriod)
        .selectField("acctgTransId")
        .selectField("debitCreditFlag")
        .selectField("amount")
        .list())
        noInvoice[row.acctgTransId] = (noInvoice[row.acctgTransId] || toDecimal(0)).add(
            toDecimal(row.amount ?? 0).multiply(row.debitCreditFlag === "D" ? sign : -sign)
        )
    for (const id of Object.keys(noInvoice).sort())
        add(
            "noInvoice",
            (payable ? "Payable" : "Receivable") + " posting without an invoice",
            "journals",
            id,
            null,
            null,
            noInvoice[id]
        )
    for (const row of lib
        .find("mantle.account.payment.PaymentApplicationAndInvoice", {[payable ? "toPartyId" : "fromPartyId"]: org})
        .condition("appliedDate", "greater-equals", fromStamp)
        .condition("appliedDate", "less", afterStamp)
        .condition("invoiceDate", "greater-equals", afterStamp)
        .list()) {
        add(
            "applicationAfterPeriod",
            "Applied in the period to a later invoice",
            payable ? "bills" : "invoices",
            row.invoiceId,
            "Payment " + row.paymentId,
            row.amountApplied,
            null
        )
        rowPayments.set(reportRows[reportRows.length - 1], row.paymentId)
    }
    // the aging's open total against the ledger at the period's end, summed in the queries
    const side = payable ? "toPartyId" : "fromPartyId"
    const statuses = payable ? PAYABLE_STATUSES : RECEIVABLE_STATUSES
    const issued = lib
        .find("mantle.account.invoice.InvoiceTotalSum", {[side]: org, currencyUomId: currency})
        .condition("statusId", "in", statuses)
        .condition("invoiceDate", "less", afterStamp)
        .selectField("invoiceTotalSum")
        .one()
    const applied = lib
        .find("mantle.account.payment.InvoiceAppliedSum", {[side]: org, currencyUomId: currency})
        .condition("statusId", "in", statuses)
        .condition("invoiceDate", "less", afterStamp)
        .condition("appliedDate", "less", afterStamp)
        .selectField("amountAppliedSum")
        .one()
    let agingOpen = toDecimal(issued?.invoiceTotalSum ?? 0).subtract(toDecimal(applied?.amountAppliedSum ?? 0))
    // invoices in other currencies at the rates they posted at, as the ledger holds them; at most 5,000, else unavailable
    const foreign = Array.from(
        lib
            .find("mantle.account.invoice.Invoice", {[side]: org})
            .condition("currencyUomId", "not-equals", currency)
            .condition("statusId", "in", statuses)
            .condition("invoiceDate", "less", afterStamp)
            .orderBy("invoiceId")
            .limit(5001)
            .list()
    )
    if (foreign.length > 5000) {
        incompleteChecks.push("agingVsLedger")
        agingOpen = null
    } else {
        const foreignApplied = appliedThroughEnd(
            "invoiceId",
            foreign.map(row => row.invoiceId)
        )
        for (const invoice of foreign) {
            const open = openInBase(invoice, foreignApplied[invoice.invoiceId] || toDecimal(0), currency)
            if (open == null) {
                incompleteChecks.push("agingVsLedger")
                agingOpen = null
                break
            }
            agingOpen = agingOpen.add(open)
        }
    }
    // People P27 review (AC-23): a reader without PAYROLL_VIEW gets no exception row of a payroll-origin invoice, payment or
    // transaction (the summary's totals are aggregates and keep them)
    if (!payrollOrigin().canRead() && reportRows.length) {
        const keyed = reportRows.map(row => ({
            row,
            invoiceId: ["invoices", "bills"].includes(row.sourceKind) ? row.sourceId : null,
            paymentId: row.sourceKind === "payments" ? row.sourceId : rowPayments.get(row) || null,
            acctgTransId: row.sourceKind === "journals" ? row.sourceId : null
        }))
        const kept = new Set(
            payrollOrigin()
                .visibleRows(keyed, {invoice: ["invoiceId"], payment: ["paymentId"], transaction: ["acctgTransId"]})
                .map(entry => entry.row)
        )
        reportRows.splice(0, reportRows.length, ...reportRows.filter(row => kept.has(row)))
    }
    let ledgerBalance = toDecimal(0)
    for (const row of lib
        .find("mantle.ledger.transaction.AcctgTransAndEntryGlaSummary", {organizationPartyId: org, isPosted: "Y"})
        .condition("glAccountClassEnumId", accountClass)
        .condition(toEnd)
        .selectField("debitCreditFlag")
        .selectField("amount")
        .list())
        ledgerBalance = ledgerBalance.add(toDecimal(row.amount ?? 0).multiply(row.debitCreditFlag === "D" ? sign : -sign))
    return {
        reportRows,
        summary: {
            agingOpen,
            ledgerBalance,
            difference: agingOpen == null ? null : agingOpen.subtract(ledgerBalance),
            currencyUomId: currency
        },
        complete: !incompleteChecks.length,
        incompleteChecks,
        period: Object.assign(lib.display(period), {fromDay, thruDay: lib.calendarDateText(period.thruDate)}),
        organizationPartyId: org,
        asOf: ec.l10n.format(ec.user.nowTimestamp, "yyyy-MM-dd HH:mm:ss")
    }
}
// The statement reports' figures (impl-accounting §4, F16): each fiscal period's GL summary rows, a closed period's as its
// close stored them and an open period's summed from its posted entries when the report runs, so no report depends on
// realTimeGlSummary. Only the organization's own periods are read (F6).
const DAY = 86400000
const SUMMARY_FIELDS = [
    "timePeriodId",
    "organizationPartyId",
    "glAccountId",
    "accountCode",
    "accountName",
    "isDebit",
    "isTemporary",
    "glAccountClassEnumId",
    "beginningBalance",
    "endingBalance",
    "postedDebits",
    "postedCredits",
    "postedDebitsNoClosing",
    "postedCreditsNoClosing"
]
// A fiscal period's days: fromDay and thruDay inclusive, afterDay the day after, and their midnights in the user's zone
// for postings dated by timestamp.
function periodDays(period) {
    const fromDay = lib.calendarDateText(period.fromDate)
    const thruDay = lib.calendarDateText(period.thruDate)
    const afterDay = lib.calendarDateText(Date.parse(thruDay) + DAY)
    return {
        fromDay,
        thruDay,
        afterDay,
        fromStamp: ec.l10n.parseTimestamp(fromDay, "yyyy-MM-dd"),
        afterStamp: ec.l10n.parseTimestamp(afterDay, "yyyy-MM-dd")
    }
}
function blankTotal() {
    return {
        before: toDecimal(0),
        debits: toDecimal(0),
        credits: toDecimal(0),
        debitsNoClosing: toDecimal(0),
        creditsNoClosing: toDecimal(0)
    }
}
// The days condition of a span: from a day (inclusive) to a day (exclusive), by book day.
function spanCondition(fromDay, afterDay) {
    const stamp = day => ec.l10n.parseTimestamp(day, "yyyy-MM-dd")
    return lib.accountingDateCondition({
        fromDate: fromDay ? stamp(fromDay) : null,
        thruDate: stamp(afterDay),
        fromDay,
        thruDay: afterDay
    })
}
// Each account's posted net (debits positive) of an organization over a days condition, with the currencies posted.
function netTotals(org, dates, currencies) {
    const net = {}
    for (const row of lib
        .find(SUMMARY, {organizationPartyId: org, isPosted: "Y"})
        .condition(dates)
        .selectField("glAccountId")
        .selectField("debitCreditFlag")
        .selectField("amountUomId")
        .selectField("amount")
        .list()) {
        currencies.add(row.amountUomId)
        net[row.glAccountId] = (net[row.glAccountId] || toDecimal(0)).add(
            toDecimal(row.amount ?? 0).multiply(row.debitCreditFlag === "D" ? 1 : -1)
        )
    }
    return net
}
// Each account's posted totals of an organization for a span of days: all its postings before the first day (debits
// positive; given when the caller carries them from an earlier span), and the span's debits and credits with and without
// the net income closing entries; with the currencies of those postings. Period close stores these as the period's
// summary rows; the statement reports sum an open period here.
function periodTotals(org, days, before = null) {
    const totals = {},
        currencies = new Set()
    const total = id => totals[id] || (totals[id] = blankTotal())
    const earlier = before || netTotals(org, spanCondition(null, days.fromDay), currencies)
    for (const [id, net] of Object.entries(earlier)) total(id).before = toDecimal(net)
    const span = lib.accountingDateCondition({
        fromDate: days.fromStamp,
        thruDate: days.afterStamp,
        fromDay: days.fromDay,
        thruDay: days.afterDay
    })
    for (const row of lib
        .find(SUMMARY, {organizationPartyId: org, isPosted: "Y"})
        .condition(span)
        .selectField("glAccountId")
        .selectField("debitCreditFlag")
        .selectField("acctgTransTypeEnumId")
        .selectField("amountUomId")
        .selectField("amount")
        .list()) {
        currencies.add(row.amountUomId)
        const entry = total(row.glAccountId),
            amount = toDecimal(row.amount ?? 0),
            side = row.debitCreditFlag === "D" ? "debits" : "credits"
        entry[side] = entry[side].add(amount)
        // the columns without closing entries leave out net income closing, as Mantle's recalculation does
        if (row.acctgTransTypeEnumId !== "AttNetIncomeClosing")
            entry[side + "NoClosing"] = entry[side + "NoClosing"].add(amount)
    }
    return {totals, currencies: [...currencies].filter(Boolean)}
}
// The fiscal periods a report names, each with the organization whose figures it holds: refused unless each is the
// organization's own or one of an organization it rolls up to, whose periods it books in (P11); with childOrgPeriods also
// the periods of the organizations that roll up to it with the same type and start, each for its own organization, for the
// organizations the user may read only.
function reportPeriods(p) {
    const s = lib.organization(p, "reportRead")
    const org = s.organizationPartyId
    const chain = lib.organizationChain(org)
    const ids = Array.from(p.timePeriodIdList || []).filter(Boolean)
    if (!ids.length) lib.denied("PERIOD_REQUIRED", "Choose a fiscal period")
    const periods = ids.map(id => {
        const period = lib.one("mantle.party.time.TimePeriod", {timePeriodId: id})
        if (!period || !chain.includes(period.partyId))
            lib.denied("PERIOD_UNAVAILABLE", "Choose fiscal periods of this organization")
        return period
    })
    const owners = periods.map(() => org)
    if (p.childOrgPeriods) {
        const readable = new Set(s.organizationPartyIds || [])
        const children = Array.from(
            lib.call("mantle.ledger.LedgerServices.expand#ChildOrganizationList", {organizationPartyId: org}).orgPartyIdList || []
        ).filter(id => id !== org && readable.has(id))
        if (children.length)
            for (const period of periods.slice())
                for (const child of lib
                    .find("mantle.party.time.TimePeriod", {timePeriodTypeId: period.timePeriodTypeId, fromDate: period.fromDate})
                    .condition("partyId", "in", children)
                    .orderBy("partyId")
                    .list()) {
                    periods.push(child)
                    owners.push(child.partyId)
                }
    }
    return {s, org, periods, owners}
}
function summaryRow(period, org, glAccountId, account, entry) {
    const sign = account?.isDebit === "Y" ? 1 : -1
    const beginning = entry.before.multiply(sign)
    return {
        timePeriodId: period.timePeriodId,
        organizationPartyId: org,
        glAccountId,
        accountCode: account?.accountCode,
        accountName: account?.accountName,
        isDebit: account?.isDebit,
        isTemporary: account?.isTemporary,
        glAccountClassEnumId: account?.glAccountClassEnumId,
        beginningBalance: beginning,
        postedDebits: entry.debits,
        postedCredits: entry.credits,
        postedDebitsNoClosing: entry.debitsNoClosing,
        postedCreditsNoClosing: entry.creditsNoClosing,
        endingBalance: beginning.add(entry.debits.subtract(entry.credits).multiply(sign)),
        closedSummary: false
    }
}
// A closed period's stored summary rows, with postings in another currency than the base named in reasons; null when the
// period has none stored.
function storedRows(period, org, days, baseCurrency, reasons) {
    const stored = lib.rows("mantle.ledger.report.GlAccountOrgTimePeriodDetail", {
        organizationPartyId: org,
        timePeriodId: period.timePeriodId
    })
    if (!stored.length) return null
    const span = lib.accountingDateCondition({
        fromDate: days.fromStamp,
        thruDate: days.afterStamp,
        fromDay: days.fromDay,
        thruDay: days.afterDay
    })
    const others = lib
        .find("mantle.ledger.transaction.AcctgTrans", {organizationPartyId: org, isPosted: "Y"})
        .condition("amountUomId", "not-equals", baseCurrency)
        .condition(span)
        .count()
    if (others) reasons.push((period.periodName || period.timePeriodId) + " has postings in other currencies, added without conversion")
    return stored.map(row => Object.assign(lib.pick(row, SUMMARY_FIELDS), {closedSummary: true}))
}
// The periods' summary rows: a closed period's stored rows, else its posted entries summed. The postings before an open
// period are summed once for each organization, at its earliest open period, and carried forward by the postings between
// one period's first day and the next's. A closed period without stored rows, and postings in another currency than the
// base, are named in reasons.
function periodSummaries(p) {
    const {org, periods, owners} = reportPeriods(p)
    const currencyUomId = lib.preference(org).baseCurrencyUomId
    const incompleteReasons = [],
        summaryRows = []
    const order = periods
        .map((period, index) => ({period, owner: owners[index], days: periodDays(period)}))
        .sort((a, b) => a.owner.localeCompare(b.owner) || a.days.fromDay.localeCompare(b.days.fromDay))
    const carried = new Map()
    for (const {period, owner, days} of order) {
        const name = period.periodName || period.timePeriodId
        if (period.isClosed === "Y") {
            const stored = storedRows(period, owner, days, currencyUomId, incompleteReasons)
            if (stored) {
                summaryRows.push(...stored)
                continue
            }
            incompleteReasons.push(name + " is closed without stored summaries; its figures are summed from its posted entries")
        }
        const currencies = new Set()
        let before = null
        const state = carried.get(owner)
        if (state) {
            before = Object.assign({}, state.before)
            if (state.day < days.fromDay)
                for (const [id, net] of Object.entries(netTotals(owner, spanCondition(state.day, days.fromDay), currencies)))
                    before[id] = (before[id] || toDecimal(0)).add(net)
        }
        const {totals, currencies: posted} = periodTotals(owner, days, before)
        for (const currency of posted) currencies.add(currency)
        carried.set(owner, {
            day: days.fromDay,
            before: Object.fromEntries(Object.entries(totals).map(([id, entry]) => [id, entry.before]))
        })
        const others = [...currencies].filter(currency => currency && currency !== currencyUomId)
        if (others.length) incompleteReasons.push(name + " has postings in " + others.join(", ") + ", added without conversion")
        const ids = Object.keys(totals).sort()
        if (!ids.length) continue
        const accounts = new Map(
            Array.from(lib.find("mantle.ledger.account.GlAccount").condition("glAccountId", "in", ids).list()).map(row => [
                row.glAccountId,
                row
            ])
        )
        summaryRows.push(...ids.map(id => summaryRow(period, owner, id, accounts.get(id), totals[id])))
    }
    return {
        organizationPartyId: org,
        timePeriodList: periods,
        summaryRows,
        currencyUomId,
        asOf: ec.l10n.format(ec.user.nowTimestamp, "yyyy-MM-dd HH:mm:ss"),
        complete: !incompleteReasons.length,
        incompleteReasons
    }
}
// The book days condition of a fiscal period the user may read in the organization (get#AccountLedgerInfo's entries).
function periodCondition(p) {
    const {periods} = reportPeriods(p)
    const days = periodDays(periods[0])
    return {
        condition: lib.accountingDateCondition({
            fromDate: days.fromStamp,
            thruDate: days.afterStamp,
            fromDay: days.fromDay,
            thruDay: days.afterDay
        })
    }
}
// The summary rows totaled by period, account class and side, as get#PeriodSeriesSummary reads them.
function classSummaries(p) {
    const out = periodSummaries(p)
    const classes = p.classIdList ? new Set(Array.from(p.classIdList)) : null
    const grouped = new Map()
    for (const row of out.summaryRows) {
        if (classes && !classes.has(row.glAccountClassEnumId)) continue
        const key = row.timePeriodId + ":" + row.glAccountClassEnumId + ":" + row.isDebit
        if (!grouped.has(key))
            grouped.set(key, {
                timePeriodId: row.timePeriodId,
                glAccountClassEnumId: row.glAccountClassEnumId,
                isDebit: row.isDebit,
                postedDebitsNoClosing: toDecimal(0),
                postedCreditsNoClosing: toDecimal(0),
                beginningBalance: toDecimal(0),
                endingBalance: toDecimal(0)
            })
        const total = grouped.get(key)
        for (const field of ["postedDebitsNoClosing", "postedCreditsNoClosing", "beginningBalance", "endingBalance"])
            total[field] = total[field].add(toDecimal(row[field] ?? 0))
    }
    return Object.assign(out, {classRows: [...grouped.values()], summaryRows: null})
}

// The partner ledger (design-accounting §13 PartnerLedger): each customer's (or supplier's) movements on the
// organization's receivable (or payable) accounts in a span of days, by book day, with its opening balance, running
// balance and totals; each line names its invoice, payment or journal entry. More than 5,000 lines are named
// (complete false) and the balances are then unavailable, never cut silently.
const PARTNER_LINE_LIMIT = 5000
function partnerLedger(p) {
    p = options(p)
    const s = lib.organization(p, "reportRead")
    const org = s.organizationPartyId
    const payable = p.invoiceType === "payable"
    const accountClass = payable ? "ACCOUNTS_PAYABLE" : "ACCOUNTS_RECEIVABLE"
    // what the party owes (receivable) or is owed (payable) is positive
    const sign = payable ? -1 : 1
    if (p.partyId) lib.counterparty(p.partyId)
    if (p.amountUomId) lib.currency(p.amountUomId)
    const query = dates => {
        let q = lib.find("mantle.ledger.transaction.AcctgTransAndEntryGlaSummary", {
            organizationPartyId: org,
            isPosted: "Y",
            glAccountClassEnumId: accountClass
        })
        if (p.partyId) q = q.condition("otherPartyId", p.partyId)
        if (p.partyId && masking) q = q.condition(payrollOrigin().transactionCondition())
        if (p.amountUomId) q = q.condition("amountUomId", p.amountUomId)
        if (masking) q = q.selectField("payrollOrigin")
        return dates ? q.condition(dates) : q
    }
    // People P27 review (AC-23): a reader without PAYROLL_VIEW sees the payroll-origin lines as one masked "Payroll" party (its
    // opening, one line of their debits and credits, and its closing), so the totals still reconcile; asked for one party, none of
    // its payroll lines
    const masking = !payrollOrigin().canRead()
    const PAYROLL_PARTY = "_PAYROLL_"
    const partyOf = row => (masking && row.payrollOrigin === "Y" ? PAYROLL_PARTY : row.otherPartyId)
    const signed = row => toDecimal(row.amount ?? 0).multiply(row.debitCreditFlag === "D" ? sign : -sign)
    const groups = new Map()
    const group = (partyId, amountUomId) => {
        const key = (partyId || "") + ":" + amountUomId
        if (!groups.has(key))
            groups.set(key, {partyId, amountUomId, opening: toDecimal(0), debits: toDecimal(0), credits: toDecimal(0), lines: []})
        return groups.get(key)
    }
    if (p.fromDate) {
        const before = lib.accountingDateCondition({thruDate: p.fromDate, thruDay: p.fromAccountingDate})
        for (const row of query(before)
            .selectField("otherPartyId")
            .selectField("amountUomId")
            .selectField("debitCreditFlag")
            .selectField("amount")
            .list()) {
            const total = group(partyOf(row), row.amountUomId)
            total.opening = total.opening.add(signed(row))
        }
    }
    const span = lib.accountingDateCondition({
        fromDate: p.fromDate,
        thruDate: p.thruDate,
        fromDay: p.fromAccountingDate,
        thruDay: p.thruAccountingDate
    })
    let q = query(span)
    for (const field of [
        "acctgTransId",
        "acctgTransEntrySeqId",
        "transactionDate",
        "accountingDate",
        "otherPartyId",
        "glAccountId",
        "accountCode",
        "accountName",
        "invoiceId",
        "paymentId",
        "debitCreditFlag",
        "amountUomId",
        "amount",
        "txDescription"
    ])
        q = q.selectField(field)
    const ordered = q.orderBy("otherPartyId,transactionDate,acctgTransId,acctgTransEntrySeqId")
    const selected = Array.from(ordered.limit(PARTNER_LINE_LIMIT + 1).list())
    const complete = selected.length <= PARTNER_LINE_LIMIT
    const lines = selected.slice(0, PARTNER_LINE_LIMIT)
    const day = row => lib.bookDay(row.accountingDate, row.transactionDate)
    lines.sort(
        (a, b) =>
            day(a).localeCompare(day(b)) ||
            lib.ms(a.transactionDate) - lib.ms(b.transactionDate) ||
            a.acctgTransId.localeCompare(b.acctgTransId) ||
            a.acctgTransEntrySeqId.localeCompare(b.acctgTransEntrySeqId)
    )
    for (const row of lines) {
        const total = group(partyOf(row), row.amountUomId)
        const debit = row.debitCreditFlag === "D"
        total[debit ? "debits" : "credits"] = total[debit ? "debits" : "credits"].add(toDecimal(row.amount ?? 0))
        total.lines.push(row)
    }
    const names = lib.lib.partyNames([...groups.values()].map(row => row.partyId).filter(id => id !== PAYROLL_PARTY))
    const nameOf = partyId =>
        !partyId ? "No party" : partyId === PAYROLL_PARTY ? "Payroll" : names[partyId] || "Private contact"
    const sorted = [...groups.values()].sort(
        (a, b) => nameOf(a.partyId).localeCompare(nameOf(b.partyId)) || a.amountUomId.localeCompare(b.amountUomId)
    )
    const reportRows = [],
        partyRows = []
    for (const total of sorted) {
        const partyId = total.partyId && names[total.partyId] ? total.partyId : null
        const partyName = nameOf(total.partyId)
        const head = {partyId, partyName, amountUomId: total.amountUomId}
        let balance = total.opening
        reportRows.push(Object.assign({rowType: "opening", description: "Opening balance", balance: total.opening}, head))
        if (total.partyId === PAYROLL_PARTY) {
            // the masked party's lines as one: no entry, day, account or document
            for (const row of total.lines) balance = balance.add(signed(row))
            if (total.lines.length)
                reportRows.push(
                    Object.assign({}, head, {
                        rowType: "entry",
                        description: "Payroll",
                        payrollMasked: true,
                        debit: complete ? total.debits : null,
                        credit: complete ? total.credits : null,
                        balance: complete ? balance : null
                    })
                )
        }
        for (const row of total.partyId === PAYROLL_PARTY ? [] : total.lines) {
            balance = balance.add(signed(row))
            const sourceKind = row.invoiceId ? (payable ? "bills" : "invoices") : row.paymentId ? "payments" : "journals"
            reportRows.push(
                Object.assign({}, head, {
                    rowType: "entry",
                    acctgTransId: row.acctgTransId,
                    bookDay: day(row),
                    glAccountId: row.glAccountId,
                    accountName: row.accountName,
                    sourceKind,
                    sourceId: row.invoiceId || row.paymentId || row.acctgTransId,
                    description: row.txDescription || "",
                    debit: row.debitCreditFlag === "D" ? row.amount : null,
                    credit: row.debitCreditFlag === "C" ? row.amount : null,
                    balance: complete ? balance : null
                })
            )
        }
        const closing = complete ? balance : null
        reportRows.push(
            Object.assign(
                {
                    rowType: "closing",
                    description: "Closing balance",
                    debit: complete ? total.debits : null,
                    credit: complete ? total.credits : null
                },
                head,
                {balance: closing}
            )
        )
        partyRows.push(
            Object.assign({}, head, {
                opening: total.opening,
                debits: complete ? total.debits : null,
                credits: complete ? total.credits : null,
                closing,
                lineCount: total.lines.length
            })
        )
    }
    return {
        reportRows,
        partyRows,
        organizationPartyId: org,
        invoiceType: payable ? "payable" : "receivable",
        asOf: ec.l10n.format(ec.user.nowTimestamp, "yyyy-MM-dd HH:mm:ss"),
        complete,
        incompleteReason: complete
            ? null
            : "More than 5,000 lines match; the first 5,000 are listed and the balances are unavailable. " +
              "Choose fewer days or one party."
    }
}

// Posted amounts by account (design-accounting §13 PostedSummary): each account's posted debits, credits and net in a
// span of days in one currency, with its balance before and after, by book day. Without a fiscal period the through day
// (or time) is included, as Mantle's run#PostedAmountSummary always read it.
function postedSummary(p) {
    p = options(p)
    const s = lib.organization(p, "reportRead")
    const org = s.organizationPartyId
    const currencyUomId = p.amountUomId || lib.preference(org).baseCurrencyUomId
    lib.currency(currencyUomId)
    const sums = dates => {
        let q = lib.find("mantle.ledger.report.PostedAmountSummary", {
            organizationPartyId: org,
            amountUomId: currencyUomId,
            isPosted: "Y"
        })
        if (dates) q = q.condition(dates)
        for (const field of ["glAccountId", "accountCode", "accountName", "glAccountClassEnumId", "debitCreditFlag", "amount"])
            q = q.selectField(field)
        return Array.from(q.list())
    }
    const accounts = new Map()
    const account = row => {
        if (!accounts.has(row.glAccountId))
            accounts.set(row.glAccountId, {
                glAccountId: row.glAccountId,
                accountCode: row.accountCode,
                accountName: row.accountName,
                glAccountClassEnumId: row.glAccountClassEnumId,
                amountUomId: currencyUomId,
                beginningBalance: toDecimal(0),
                debitAmount: toDecimal(0),
                creditAmount: toDecimal(0)
            })
        return accounts.get(row.glAccountId)
    }
    if (p.fromDate)
        for (const row of sums(lib.accountingDateCondition({thruDate: p.fromDate, thruDay: p.fromAccountingDate}))) {
            const total = account(row)
            const amount = toDecimal(row.amount ?? 0).multiply(row.debitCreditFlag === "D" ? 1 : -1)
            total.beginningBalance = total.beginningBalance.add(amount)
        }
    // through a day given without a period includes it, as Mantle's report always did; a period ends on its last day
    const span = lib.accountingDateCondition({
        fromDate: p.fromDate,
        thruDate: p.thruDate,
        fromDay: p.fromAccountingDate,
        thruDay: p.thruAccountingDate,
        inclusive: !p.timePeriodId
    })
    for (const row of sums(span)) {
        const total = account(row),
            field = row.debitCreditFlag === "D" ? "debitAmount" : "creditAmount"
        total[field] = total[field].add(toDecimal(row.amount ?? 0))
    }
    const classIds = [...new Set([...accounts.values()].map(row => row.glAccountClassEnumId).filter(Boolean))]
    const classNames = Object.fromEntries(
        classIds.length
            ? Array.from(lib.find("moqui.basic.Enumeration").condition("enumId", "in", classIds).list()).map(row => [
                  row.enumId,
                  row.description
              ])
            : []
    )
    const resultList = [...accounts.values()]
        .map(row => {
            const netAmount = row.debitAmount.subtract(row.creditAmount)
            return Object.assign(row, {
                className: classNames[row.glAccountClassEnumId] || row.glAccountClassEnumId || "",
                netAmount,
                endingBalance: row.beginningBalance.add(netAmount)
            })
        })
        .sort((a, b) => String(a.accountCode || a.glAccountId).localeCompare(String(b.accountCode || b.glAccountId)))
    return {
        resultList,
        organizationPartyId: org,
        currencyUomId,
        asOf: ec.l10n.format(ec.user.nowTimestamp, "yyyy-MM-dd HH:mm:ss"),
        complete: true
    }
}
const operations = {
    invoiceReconciliation,
    periodSummaries,
    classSummaries,
    partnerLedger,
    postedSummary,
    periodAccess: p => ({organizationPartyId: reportPeriods(p).org}),
    periodCondition,
    options
}
;({
    execute: (op, p) => {
        if (operations[op]) return operations[op](p)
        if (!["trial", "ledger"].includes(op)) throw new Error("Unknown finance report " + op)
        return report(op, p)
    },
    periodTotals,
    periodDays,
    blankTotal
})
