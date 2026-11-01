// Payment terms: a term's installment and discount lines (SettlementTermLine, effective-dated), the due schedule an
// invoice keeps from them when it is issued (InvoiceDueSchedule), and the prompt-payment discount open on a day. Dates
// are computed as checkSet#InvoiceDueDate computes the due date: calendar days after the invoice's day in the user's zone.
const lib = ec.resource.script("component://mr-mantle/service/mantle/account/InvoiceWorkflowLib.js")
const {find, one, rows, call, denied} = lib
const I = lib.invoiceEntity,
    L = "mantle.account.invoice.SettlementTermLine",
    S = "mantle.account.invoice.InvoiceDueSchedule"
const lineFields = ["sequenceNum", "portionPercent", "daysBasis", "discountPercent", "discountDays"]

// The lines of a term in effect on a date, in sequence.
function linesInEffect(settlementTermId, date = ec.user.nowTimestamp) {
    if (!settlementTermId) return []
    const cf = ec.entity.conditionFactory
    return Array.from(
        find(L, {settlementTermId})
            .condition("fromDate", "less-equals", date)
            .condition(
                cf.makeCondition(
                    [cf.makeCondition("thruDate", "is-null", null), cf.makeCondition("thruDate", "greater", date)],
                    "or"
                )
            )
            .orderBy("sequenceNum")
            .list()
    )
}
const number = (value, label) => {
    if (value == null || value === "" || isNaN(Number(value))) denied("TERM_LINE_INVALID", "Give the " + label + " of each line")
    return toDecimal(value)
}
// The lines a request gives, checked: portions over 0 that add up to 100, whole days, a discount of 0 to 100 percent
// within the portion's days.
function requestedLines(value) {
    let list = value == null || value === "" ? [] : value
    if (typeof list === "string") list = lib.json(list, null)
    if (!Array.isArray(list) && !(list && typeof list.length === "number")) denied("TERM_LINE_INVALID", "Give the term's lines")
    list = Array.from(list)
    if (list.length > 12) denied("TERM_LINE_INVALID", "A term has at most 12 lines")
    const lines = list.map((row, index) => {
        const portionPercent = number(row.portionPercent, "portion"),
            daysBasis = number(row.daysBasis, "due days"),
            discountPercent = toDecimal(row.discountPercent || 0),
            discountDays = toDecimal(row.discountDays || 0)
        if (portionPercent.compare(0) <= 0 || portionPercent.compare(100) > 0)
            denied("TERM_LINE_INVALID", "A line's portion is more than 0 and at most 100 percent")
        if (daysBasis.compare(0) < 0 || discountDays.compare(0) < 0 || discountPercent.compare(0) < 0)
            denied("TERM_LINE_INVALID", "Days and discounts are not negative")
        if (discountPercent.compare(100) >= 0) denied("TERM_LINE_INVALID", "A discount is less than 100 percent")
        if (discountDays.compare(daysBasis) > 0) denied("TERM_LINE_INVALID", "A discount ends on or before its portion is due")
        if (discountPercent.isZero() && !discountDays.isZero())
            denied("TERM_LINE_INVALID", "A line with discount days needs a discount percent")
        return {
            sequenceNum: index + 1,
            portionPercent: String(portionPercent),
            daysBasis: Math.trunc(daysBasis.toNumber()),
            discountPercent: String(discountPercent),
            discountDays: Math.trunc(discountDays.toNumber())
        }
    })
    if (lines.length) {
        const total = lines.reduce((sum, row) => sum.add(row.portionPercent), toDecimal(0))
        if (!total.eq(100)) denied("TERM_PORTIONS_INVALID", "The portions of a term add up to 100 percent")
    }
    return lines
}
// The days of a term with the lines given: its last portion's; null when no lines are given.
function lineDays(value) {
    if (value == null || value === "") return null
    const lines = requestedLines(value)
    return lines.length ? Math.max(...lines.map(row => row.daysBasis)) : null
}
const sameLines = (current, requested) =>
    current.length === requested.length &&
    current.every((row, index) =>
        lineFields.every(field => toDecimal(row[field] ?? 0).eq(toDecimal(requested[index][field] ?? 0)))
    )
// Replace a term's lines in effect: the lines in effect end now and the new ones start now; the same lines change nothing.
// No lines given leaves them as they are; an empty list ends them. Called by store#SettlementTerm, which checked the
// permission and the term.
function storeLines(p) {
    if (p.lines == null) return {linesChanged: false}
    const requested = requestedLines(p.lines),
        now = ec.user.nowTimestamp,
        current = linesInEffect(p.settlementTermId, now)
    if (sameLines(current, requested)) return {linesChanged: false, lineCount: current.length}
    for (const row of current)
        call("update#" + L, {
            settlementTermLineId: row.settlementTermLineId,
            thruDate: now,
            thruDate_changeReason: p.changeReason
        })
    for (const row of requested)
        call(
            "create#" + L,
            Object.assign({}, row, {
                settlementTermId: p.settlementTermId,
                fromDate: now,
                changeReason: p.changeReason,
                changedByUserId: ec.user.userId
            })
        )
    return {linesChanged: true, lineCount: requested.length}
}
// The terms' lines in effect now, for the settings screen.
function termLines(p) {
    const cf = ec.entity.conditionFactory,
        now = ec.user.nowTimestamp
    const found = Array.from(
        find(L)
            .condition("fromDate", "less-equals", now)
            .condition(
                cf.makeCondition(
                    [cf.makeCondition("thruDate", "is-null", null), cf.makeCondition("thruDate", "greater", now)],
                    "or"
                )
            )
            .orderBy("settlementTermId,sequenceNum")
            .limit(500)
            .list()
    )
    return {
        termLines: found.map(row =>
            Object.assign(lib.display(row), {
                lineText:
                    String(row.portionPercent) +
                    "% due in " +
                    row.daysBasis +
                    " days" +
                    (toDecimal(row.discountPercent || 0).isZero()
                        ? ""
                        : ", " + String(row.discountPercent) + "% off within " + row.discountDays + " days")
            })
        )
    }
}
// Calendar days (yyyy-MM-dd): an invoice's book day, a day some days later, and a date or timestamp's day. A schedule is
// kept and compared in days, so the zone of the server or the user never moves a due or discount date.
const day = value => (value == null || value === "" ? null : lib.policy.calendarDateText(value))
// The day of a timestamp in the user's zone (a day text stays as it is).
const stampDay = value =>
    value == null || value === ""
        ? null
        : /^\d{4}-\d{2}-\d{2}$/.test(String(value))
          ? String(value)
          : lib.entityLib.bookDay(null, value)
function bookDay(invoice) {
    return lib.entityLib.bookDay(invoice.accountingDate, invoice.invoiceDate || ec.user.nowTimestamp)
}
function addDays(dayText, days) {
    const [year, month, date] = dayText.split("-").map(Number)
    const value = new Date(Date.UTC(year, month - 1, date + days))
    const pad = n => String(n).padStart(2, "0")
    return value.getUTCFullYear() + "-" + pad(value.getUTCMonth() + 1) + "-" + pad(value.getUTCDate())
}
// The lines of a term in effect at the end of a calendar day in the user's zone, in sequence: an invoice takes the lines
// of its book day, as the rest of its schedule is in days, so a line changed later that day applies and the time of day
// of the invoice's timestamp does not matter.
function linesOfDay(settlementTermId, dayText) {
    if (!settlementTermId) return []
    const next = ec.l10n.parseTimestamp(addDays(dayText, 1) + " 00:00:00", "yyyy-MM-dd HH:mm:ss")
    const cf = ec.entity.conditionFactory
    return Array.from(
        find(L, {settlementTermId})
            .condition("fromDate", "less", next)
            .condition(
                cf.makeCondition(
                    [cf.makeCondition("thruDate", "is-null", null), cf.makeCondition("thruDate", "greater-equals", next)],
                    "or"
                )
            )
            .orderBy("sequenceNum")
            .list()
    )
}
// The schedule an invoice's term gives it: each line's portion of the total and its discount, the last portion taking
// what rounding leaves; a term without lines is one portion due on the invoice's due date.
function plannedSchedule(invoice, total) {
    const currency = invoice.currencyUomId,
        start = bookDay(invoice),
        lines = linesOfDay(invoice.settlementTermId, start)
    if (!lines.length)
        return [
            {scheduleSeqId: "01", dueDate: stampDay(invoice.dueDate), amount: total, settlementTermId: invoice.settlementTermId}
        ]
    let left = total
    return lines.map((line, index) => {
        const last = index === lines.length - 1
        const amount = last ? left : ec.l10n.roundCurrency(total.multiply(line.portionPercent).divide(100), currency)
        left = left.subtract(amount)
        const discount = toDecimal(line.discountPercent || 0)
        return {
            scheduleSeqId: String(index + 1).padStart(2, "0"),
            dueDate: addDays(start, Number(line.daysBasis || 0)),
            amount,
            discountDate: discount.isZero() ? null : addDays(start, Number(line.discountDays || 0)),
            discountAmount: discount.isZero() ? null : ec.l10n.roundCurrency(amount.multiply(discount).divide(100), currency),
            settlementTermId: invoice.settlementTermId,
            settlementTermLineId: line.settlementTermLineId
        }
    })
}
// Write an issued invoice's due schedule once (the InvoiceIssuedDueSchedule SECA): nothing for a credit memo, an invoice
// with no date or no total, or one that has its schedule.
function writeSchedule(p) {
    const invoice = one(I, {invoiceId: p.invoiceId})
    if (!invoice || !invoice.invoiceDate || invoice.invoiceTypeEnumId === "InvoiceCreditMemo") return {written: false}
    if (find(S, {invoiceId: p.invoiceId}).count() > 0) return {written: false}
    const total = lib.totals(invoice).invoiceTotal
    if (total.compare(0) <= 0) return {written: false}
    for (const row of plannedSchedule(invoice, total)) call("create#" + S, Object.assign({invoiceId: p.invoiceId}, row))
    return {written: true}
}
// An issued invoice changed back for edits (Resume Changes, the InvoiceResumedDueSchedule SECA): its schedule is removed,
// so issuing it again writes the schedule of what it then is. Nothing is applied to an invoice being changed.
function clearSchedule(p) {
    const stored = rows(S, {invoiceId: p.invoiceId})
    for (const row of stored) call("delete#" + S, {invoiceId: row.invoiceId, scheduleSeqId: row.scheduleSeqId})
    return {cleared: stored.length}
}
const inIds = (entity, field, ids) => (ids.length ? Array.from(find(entity).condition(field, "in", ids).list()) : [])
// The schedules of invoices by invoice ID (stored, else planned from the term without storing), read in a few queries:
// each row with its discount open on the day given, the discount still available then (open discounts less prompt-payment
// credits already issued, at most the unpaid total) and the next portion due on or after that day.
function schedules(invoices, onDate = ec.user.nowTimestamp) {
    const list = Array.from(invoices || [])
    const ids = list.map(row => row.invoiceId)
    const onDay = stampDay(onDate)
    const stored = {},
        taken = {}
    for (const row of inIds(S, "invoiceId", ids)) (stored[row.invoiceId] = stored[row.invoiceId] || []).push(lib.map(row))
    const credits = inIds(I, "creditForInvoiceId", ids).filter(row => row.statusId !== "InvoiceCancelled")
    const discountCredits = new Set(
        inIds(
            "mantle.account.invoice.InvoiceItem",
            "invoiceId",
            credits.map(row => row.invoiceId)
        )
            .filter(item => item.itemTypeEnumId === "ItemPromptDiscount")
            .map(item => item.invoiceId)
    )
    for (const row of credits.filter(row => discountCredits.has(row.invoiceId)))
        taken[row.creditForInvoiceId] = (taken[row.creditForInvoiceId] || toDecimal(0)).add(row.invoiceTotal ?? 0)
    const totals = lib.totalsMany(list)
    return Object.fromEntries(
        list.map(invoice => {
            const own = (stored[invoice.invoiceId] || []).sort((a, b) => a.scheduleSeqId.localeCompare(b.scheduleSeqId))
            const scheduleRows = own.length ? own : plannedSchedule(invoice, totals[invoice.invoiceId].invoiceTotal)
            let open = toDecimal(0)
            const out = scheduleRows.map(row => {
                const discountDateText = day(row.discountDate)
                const available = row.discountAmount != null && discountDateText != null && onDay <= discountDateText
                if (available) open = open.add(row.discountAmount)
                return Object.assign({}, row, {dueDateText: day(row.dueDate), discountDateText, discountOpen: available})
            })
            const unpaid = totals[invoice.invoiceId].unpaidTotal
            let discountAvailable = open.subtract(taken[invoice.invoiceId] || 0)
            if (discountAvailable.compare(0) < 0) discountAvailable = toDecimal(0)
            if (discountAvailable.compare(unpaid) > 0) discountAvailable = unpaid
            const openRows = out.filter(row => row.discountOpen)
            const next = out.find(row => row.dueDateText && row.dueDateText >= onDay) || out[out.length - 1]
            return [
                invoice.invoiceId,
                {
                    rows: out,
                    stored: own.length > 0,
                    discountAvailable,
                    discountDate: openRows.length ? openRows[0].discountDateText : null,
                    discountDateText: openRows.length ? openRows[0].discountDateText : null,
                    nextDueDate: next?.dueDateText ?? null
                }
            ]
        })
    )
}
function schedule(invoice, onDate = ec.user.nowTimestamp) {
    return schedules([invoice], onDate)[invoice.invoiceId]
}
// The account a prompt-payment discount posts to: the organization's ItemPromptDiscount account for the side (outgoing
// for customer invoices, incoming for bills).
function discountAccount(organizationPartyId, receivable) {
    const found = call("mantle.ledger.InvoiceAutoPostServices.get#InvoiceItemGlAccount", {
        organizationPartyId,
        itemTypeEnumId: "ItemPromptDiscount",
        direction: receivable ? "O" : "I"
    })
    if (!found.glAccountId) denied("DISCOUNT_ACCOUNT_MISSING", "The prompt-payment discount account is not configured")
    return found.glAccountId
}
// A prompt-payment discount credit on an invoice (create#InvoiceCreditMemo with promptDiscount): the side's edit
// permission or PAYMENT_EDIT, and no more than the due schedule offers on the credit's day.
// The discount must be open on the credit's day and on today's, so a lapsed discount is never taken by dating it back. The
// invoice is locked first; the credit goes to the side's discount account, and another account makes it a write-off.
function checkPromptDiscount(p) {
    if (!lib.has(p.editPermission) && !lib.has("PAYMENT_EDIT"))
        denied("PERMISSION_DENIED", p.editPermission + " or PAYMENT_EDIT authority is required")
    const invoice = find(I, {invoiceId: p.invoiceId}).forUpdate(true).one()
    const amount = toDecimal(p.amount ?? 0)
    for (const onDate of [p.onDate || ec.user.nowTimestamp, ec.user.nowTimestamp]) {
        const offered = schedule(invoice, onDate).discountAvailable
        if (offered.isZero() || amount.compare(offered) > 0)
            denied("DISCOUNT_NOT_AVAILABLE", "The invoice's terms offer no discount of this amount on the date and today")
    }
    const account = discountAccount(p.organizationPartyId, p.receivable)
    if (p.glAccountId && p.glAccountId !== account)
        denied(
            "DISCOUNT_ACCOUNT_FIXED",
            "A prompt-payment discount posts to the discount account; another account is a write-off"
        )
    return {discountGlAccountId: account}
}
// The read service: an invoice's schedule for a user who may read it.
function dueSchedule(p) {
    const scope = lib.readInvoice(p)
    const out = schedule(scope.record, p.onDate || ec.user.nowTimestamp)
    return {
        scheduleRows: out.rows.map(row =>
            Object.assign(lib.display(row), {
                dueDateText: row.dueDateText,
                discountDateText: row.discountDateText,
                discountOpen: row.discountOpen
            })
        ),
        scheduleStored: out.stored,
        discountAvailable: out.discountAvailable,
        discountDateText: out.discountDateText
    }
}

const operations = {storeLines, termLines, writeSchedule, clearSchedule, dueSchedule}
function execute(op, parameters) {
    if (!operations[op]) throw new Error("Unknown payment terms operation " + op)
    const result = operations[op](parameters)
    ec.context.putAll(result)
    return result
}
;({execute, checkPromptDiscount, lineDays, linesInEffect, linesOfDay, schedule, schedules, discountAccount, day, stampDay, addDays})
