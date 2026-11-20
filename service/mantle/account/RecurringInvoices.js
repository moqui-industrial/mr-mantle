// Recurring invoices (AC-09; mantle.account.RecurringInvoiceServices): invoice-only schedules that copy a template
// invoice's lines into a new draft each period. A period (schedule and day) makes one draft however often generation is
// retried: the schedule is locked and the occurrence row answers a retry. A failure is recorded on its occurrence in a
// transaction of its own and the organization's billers are notified; the next run tries again.
const lib = ec.resource.script("component://mr-mantle/service/mantle/account/InvoiceWorkflowLib.js")
const {find, one, rows, call, denied, has} = lib
const S = "mantle.account.invoice.InvoiceSchedule"
const O = "mantle.account.invoice.InvoiceScheduleOccurrence"
const INTERVALS = {TF_wk: "week", TF_mon: "month", TF_yr: "year"}
const MAX_PER_RUN = 12
const today = () => ec.l10n.format(ec.user.nowTimestamp, "yyyy-MM-dd")
const dayText = value =>
    value == null || value === ""
        ? null
        : /^\d{4}-\d{2}-\d{2}$/.test(String(value))
          ? String(value)
          : lib.policy.calendarDateText(value)
const pad = n => String(n).padStart(2, "0")

// The day of the schedule's occurrence number index (0 the start day): weeks add days; months and years keep the start's
// day of the month, the month's last day when it is shorter.
function occurrenceDay(schedule, index) {
    const [year, month, date] = dayText(schedule.startDate).split("-").map(Number)
    const quantity = Number(schedule.intervalQuantity || 1) * index
    if (schedule.intervalUomId === "TF_wk") {
        const value = new Date(Date.UTC(year, month - 1, date + 7 * quantity))
        return value.getUTCFullYear() + "-" + pad(value.getUTCMonth() + 1) + "-" + pad(value.getUTCDate())
    }
    const months = schedule.intervalUomId === "TF_yr" ? 12 * quantity : quantity
    const target = new Date(Date.UTC(year, month - 1 + months, 1))
    const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate()
    return target.getUTCFullYear() + "-" + pad(target.getUTCMonth() + 1) + "-" + pad(Math.min(date, last))
}
// The occurrence after a day: the first of the schedule's days later than it.
function nextAfter(schedule, day) {
    for (let index = 0; index < 5000; index++) {
        const candidate = occurrenceDay(schedule, index)
        if (candidate > day) return candidate
    }
    denied("SCHEDULE_INVALID", "The schedule has no further occurrence")
}
function isOccurrence(schedule, day) {
    for (let index = 0; index < 5000; index++) {
        const candidate = occurrenceDay(schedule, index)
        if (candidate === day) return true
        if (candidate > day) return false
    }
    return false
}

// The schedule's template invoice and the side it bills: receivable when the organization issues it. A payroll-origin invoice
// (a pay run's net pay or payee invoice, PayrollOrigin.js) is no template for anyone (SEC-BOS-92): its lines are a payslip's,
// and a copy would carry no mark; it is refused as a missing one, so its existence is not told.
function templateScope(organizationPartyId, templateInvoiceId) {
    const template = templateInvoiceId ? one(lib.invoiceEntity, {invoiceId: templateInvoiceId}) : null
    if (!template || ![template.fromPartyId, template.toPartyId].includes(organizationPartyId) || template.payrollOrigin === "Y")
        denied("TEMPLATE_UNAVAILABLE", "Choose an invoice of the organization as the template")
    if (template.statusId === "InvoiceCancelled") denied("TEMPLATE_UNAVAILABLE", "A cancelled invoice is not a template")
    const receivable = template.fromPartyId === organizationPartyId
    return {
        template,
        receivable,
        partyId: receivable ? template.toPartyId : template.fromPartyId,
        editPermission: receivable ? "RECEIVABLE_EDIT" : "PAYABLE_EDIT",
        viewPermission: receivable ? "RECEIVABLE_VIEW" : "PAYABLE_VIEW"
    }
}
function scheduleScope(p, need) {
    const schedule = p.invoiceScheduleId ? one(S, {invoiceScheduleId: p.invoiceScheduleId}) : null
    if (!schedule) denied("SCHEDULE_UNAVAILABLE", "The schedule is not available")
    const scope = templateScope(schedule.organizationPartyId, schedule.templateInvoiceId)
    const permission = need === "edit" ? scope.editPermission : null
    lib.organization(schedule.organizationPartyId, permission)
    if (need !== "edit" && !has(scope.viewPermission) && !has("ACCOUNTING_VIEW") && !has("ACCOUNTING_ADMIN"))
        denied("PERMISSION_DENIED", scope.viewPermission + " authority is required")
    return Object.assign(scope, {schedule: lib.map(schedule)})
}

// Add a schedule, change one (its future occurrences; a made occurrence keeps its invoice) or change its state
// (pause, resume, end).
function store(p) {
    let existing = null
    if (p.invoiceScheduleId) {
        existing = find(S, {invoiceScheduleId: p.invoiceScheduleId}).forUpdate(true).one()
        if (!existing) denied("SCHEDULE_UNAVAILABLE", "The schedule is not available")
    }
    const organizationPartyId = existing ? existing.organizationPartyId : p.organizationPartyId
    const templateInvoiceId = p.templateInvoiceId || existing?.templateInvoiceId
    const scope = templateScope(organizationPartyId, templateInvoiceId)
    lib.organization(organizationPartyId, scope.editPermission)
    const party = one("mantle.party.Party", {partyId: scope.partyId})
    if (party?.privateOwnerUserId && party.privateOwnerUserId !== ec.user.userId)
        denied("TEMPLATE_UNAVAILABLE", "Choose an invoice of the organization as the template")
    if (existing && p.statusId && p.statusId !== existing.statusId) {
        const allowed = one("moqui.basic.StatusFlowTransition", {
            statusFlowId: "Default",
            statusId: existing.statusId,
            toStatusId: p.statusId
        })
        if (!allowed) denied("STATE_TRANSITION_INVALID", "The schedule cannot change to that state")
        call("update#" + S, {invoiceScheduleId: existing.invoiceScheduleId, statusId: p.statusId})
        return {invoiceScheduleId: existing.invoiceScheduleId}
    }
    const values = {
        intervalUomId: p.intervalUomId || existing?.intervalUomId || "TF_mon",
        intervalQuantity: Number(p.intervalQuantity ?? existing?.intervalQuantity ?? 1),
        startDate: dayText(p.startDate) || dayText(existing?.startDate) || today(),
        endDate: p.endDate === "" ? null : dayText(p.endDate) || dayText(existing?.endDate),
        settlementTermId: p.settlementTermId ?? existing?.settlementTermId ?? scope.template.settlementTermId ?? null,
        description:
            String(p.description ?? existing?.description ?? "")
                .trim()
                .slice(0, 255) || null
    }
    if (!INTERVALS[values.intervalUomId]) denied("INTERVAL_INVALID", "Repeat every week, month or year")
    if (!Number.isInteger(values.intervalQuantity) || values.intervalQuantity < 1 || values.intervalQuantity > 60)
        denied("INTERVAL_INVALID", "Repeat every 1 to 60 periods")
    if (values.endDate && values.endDate < values.startDate) denied("END_BEFORE_START", "The schedule ends before it starts")
    if (values.settlementTermId && !one("mantle.account.invoice.SettlementTerm", {settlementTermId: values.settlementTermId}))
        denied("TERM_INVALID", "Choose a payment term")
    if (!rows("mantle.account.invoice.InvoiceItem", {invoiceId: templateInvoiceId}).length)
        denied("TEMPLATE_EMPTY", "The template invoice has no lines")
    if (!existing) {
        const created = call(
            "create#" + S,
            Object.assign({}, values, {
                organizationPartyId,
                partyId: scope.partyId,
                templateInvoiceId,
                nextDate: values.startDate,
                statusId: "IschActive",
                createdByUserId: ec.user.userId,
                createdDate: ec.user.nowTimestamp
            })
        )
        return {invoiceScheduleId: created.invoiceScheduleId}
    }
    // the next occurrence is the first of the changed schedule after the last one made, or its start
    const made = Array.from(
        find(O, {invoiceScheduleId: existing.invoiceScheduleId, statusId: "IsoGenerated"})
            .orderBy("-occurrenceDate")
            .limit(1)
            .list()
    )
    const merged = Object.assign({}, lib.map(existing), values)
    const nextDate = made.length ? nextAfter(merged, dayText(made[0].occurrenceDate)) : values.startDate
    call(
        "update#" + S,
        Object.assign({}, values, {
            invoiceScheduleId: existing.invoiceScheduleId,
            templateInvoiceId,
            nextDate,
            statusId: values.endDate && nextDate > values.endDate ? "IschEnded" : existing.statusId
        })
    )
    return {invoiceScheduleId: existing.invoiceScheduleId}
}

// The draft a period would make: its day, due day (the term's days after it), lines and total, and whether it is made.
function preview(p) {
    const scope = scheduleScope(p, "view")
    const schedule = scope.schedule
    const day = dayText(p.occurrenceDate) || dayText(schedule.nextDate)
    if (!isOccurrence(schedule, day)) denied("OCCURRENCE_INVALID", "The day is not one of the schedule's")
    const occurrence = one(O, {invoiceScheduleId: schedule.invoiceScheduleId, occurrenceDate: day})
    const template = scope.template
    const lines = templateLines(template.invoiceId).map(line =>
        Object.assign(lib.display(line), {lineTotal: lib.lineTotal(line, template.currencyUomId)})
    )
    const total = lines.reduce((sum, line) => sum.add(line.lineTotal), toDecimal(0))
    const term = schedule.settlementTermId
        ? one("mantle.account.invoice.SettlementTerm", {settlementTermId: schedule.settlementTermId})
        : null
    const termDays =
        term?.termValue != null && /Days$/.test(term.termTypeEnumId || "") ? toDecimal(term.termValue).toNumber() : null
    const names = lib.partyNames([schedule.partyId])
    return {
        occurrenceDate: day,
        invoiceDate: day,
        dueDate: termDays == null ? null : addDays(day, termDays),
        partyId: schedule.partyId,
        partyName: names[schedule.partyId] || schedule.partyId,
        currencyUomId: template.currencyUomId,
        lines,
        total,
        invoiceId: occurrence?.invoiceId || null,
        occurrenceStatusId: occurrence?.statusId || null,
        errorMessage: occurrence?.errorMessage || null
    }
}
function addDays(day, days) {
    const [year, month, date] = day.split("-").map(Number)
    const value = new Date(Date.UTC(year, month - 1, date + days))
    return value.getUTCFullYear() + "-" + pad(value.getUTCMonth() + 1) + "-" + pad(value.getUTCDate())
}
// The template's lines a period copies: every line but its calculated tax lines (which the draft gets again when it is
// issued) and the lines under one left out, each keeping its line number so a child keeps its parent.
function templateLines(invoiceId) {
    const all = rows("mantle.account.invoice.InvoiceItem", {invoiceId}).sort((a, b) =>
        String(a.invoiceItemSeqId).localeCompare(String(b.invoiceItemSeqId))
    )
    const skipped = new Set(all.filter(line => line.taxCalculated === "Y").map(line => line.invoiceItemSeqId))
    let grew = true
    while (grew) {
        grew = false
        for (const line of all)
            if (!skipped.has(line.invoiceItemSeqId) && line.parentItemSeqId && skipped.has(line.parentItemSeqId)) {
                skipped.add(line.invoiceItemSeqId)
                grew = true
            }
    }
    return all.filter(line => !skipped.has(line.invoiceItemSeqId))
}
// The fields of a template line a draft copies: all but the template's identity, its stamps and what it was billed from.
// Links to other records (the invoice it came from, an asset, a financial account movement, a payroll adjustment, an
// opportunity) and a tax line's rate fields are not copied.
const LINE_SKIP = new Set([
    "invoiceId",
    "lastUpdatedStamp",
    "taxCalculated",
    "parentInvoiceId",
    "parentInvoiceItemSeqId",
    "assetId",
    "finAccountTransId",
    "payrollAdjustmentId",
    "salesOpportunityId",
    "taxAuthorityRateId",
    "taxPercentage",
    "taxableAmount",
    "taxRoundingAmount"
])

// Make one period's draft. The schedule is locked first; a period already made answers its invoice. Called in a
// transaction of its own by generate#Invoices and the job; it checks no permission.
function occurrence(p) {
    const schedule = find(S, {invoiceScheduleId: p.invoiceScheduleId}).forUpdate(true).one()
    if (!schedule) denied("SCHEDULE_UNAVAILABLE", "The schedule is not available")
    // the state read again under the lock: the job makes only an active schedule's periods, and nothing is made once ended
    if (schedule.statusId === "IschEnded") denied("SCHEDULE_ENDED", "The schedule has ended")
    if (p.requireActive && schedule.statusId !== "IschActive") return {skipped: true}
    const day = dayText(p.occurrenceDate) || dayText(schedule.nextDate)
    const existing = one(O, {invoiceScheduleId: schedule.invoiceScheduleId, occurrenceDate: day})
    if (existing?.invoiceId) return {invoiceId: existing.invoiceId, occurrenceDate: day, alreadyGenerated: true}
    if (!isOccurrence(schedule, day)) denied("OCCURRENCE_INVALID", "The day is not one of the schedule's")
    if (schedule.endDate && day > dayText(schedule.endDate)) denied("SCHEDULE_ENDED", "The schedule has ended")
    const template = one(lib.invoiceEntity, {invoiceId: schedule.templateInvoiceId})
    if (!template || template.statusId === "InvoiceCancelled")
        denied("TEMPLATE_UNAVAILABLE", "The template invoice is not available")
    const lines = templateLines(template.invoiceId)
    if (!lines.length) denied("TEMPLATE_EMPTY", "The template invoice has no lines")
    const invoiceDate = ec.l10n.parseTimestamp(day + " 00:00:00", "yyyy-MM-dd HH:mm:ss")
    const made = call("mantle.account.InvoiceServices.create#Invoice", {
        fromPartyId: template.fromPartyId,
        toPartyId: template.toPartyId,
        invoiceTypeEnumId: template.invoiceTypeEnumId,
        currencyUomId: template.currencyUomId,
        invoiceDate,
        settlementTermId: schedule.settlementTermId || null,
        description: schedule.description || template.description || null
    })
    // each line as the template has it (its number, parent, adjustment flag, tax authority and day), in the draft
    for (const line of lines)
        call(
            "create#mantle.account.invoice.InvoiceItem",
            Object.assign(
                Object.fromEntries(
                    Object.entries(lib.map(line)).filter(([field, value]) => !LINE_SKIP.has(field) && value != null)
                ),
                {invoiceId: made.invoiceId}
            )
        )
    const values = {
        invoiceScheduleId: schedule.invoiceScheduleId,
        occurrenceDate: day,
        invoiceId: made.invoiceId,
        statusId: "IsoGenerated",
        errorMessage: null,
        attemptCount: Number(existing?.attemptCount || 0) + 1,
        lastAttemptDate: ec.user.nowTimestamp
    }
    call((existing ? "update#" : "create#") + O, values)
    if (day >= dayText(schedule.nextDate)) {
        const nextDate = nextAfter(lib.map(schedule), day)
        const ended = schedule.endDate && nextDate > dayText(schedule.endDate)
        call("update#" + S, {
            invoiceScheduleId: schedule.invoiceScheduleId,
            nextDate,
            statusId: ended ? "IschEnded" : schedule.statusId
        })
    }
    return {invoiceId: made.invoiceId, occurrenceDate: day, alreadyGenerated: false}
}
// A failed period, recorded in its own transaction, and its notice to the organization's billers.
function recordFailure(p) {
    const schedule = one(S, {invoiceScheduleId: p.invoiceScheduleId})
    const existing = one(O, {invoiceScheduleId: p.invoiceScheduleId, occurrenceDate: p.occurrenceDate})
    if (existing?.invoiceId) return {}
    // one notice for a period's failure, not one each night it fails again
    const notifyNow = existing?.statusId !== "IsoFailed"
    call((existing ? "update#" : "create#") + O, {
        invoiceScheduleId: p.invoiceScheduleId,
        occurrenceDate: p.occurrenceDate,
        statusId: "IsoFailed",
        errorMessage: String(p.errorMessage || "").slice(0, 255),
        attemptCount: Number(existing?.attemptCount || 0) + 1,
        lastAttemptDate: ec.user.nowTimestamp
    })
    if (!schedule || !notifyNow) return {}
    const receivable =
        one(lib.invoiceEntity, {invoiceId: schedule.templateInvoiceId})?.fromPartyId === schedule.organizationPartyId
    ec.resource.script("component://mr-mantle/service/mantle/account/Payables.js").execute("notify", {
        topic: "RecurringInvoiceFailed",
        permission: receivable ? "RECEIVABLE_EDIT" : "PAYABLE_EDIT",
        organizationPartyId: schedule.organizationPartyId,
        recordEntityName: S,
        recordId: p.invoiceScheduleId,
        message: {
            invoiceScheduleId: p.invoiceScheduleId,
            organizationPartyId: schedule.organizationPartyId,
            occurrenceDate: p.occurrenceDate,
            errorMessage: String(p.errorMessage || "").slice(0, 255)
        }
    })
    return {}
}
// One period in its own transaction; a failure recorded and named, the caller going on.
function attempt(invoiceScheduleId, occurrenceDate, requireActive = false) {
    try {
        return lib.probe("mantle.account.RecurringInvoiceServices.generate#Occurrence", {
            invoiceScheduleId,
            occurrenceDate,
            requireActive
        })
    } catch (error) {
        ec.logger.error("Recurring invoice " + invoiceScheduleId + " for " + occurrenceDate + ": " + error.message)
        try {
            lib.probe("mantle.account.RecurringInvoiceServices.record#OccurrenceFailure", {
                invoiceScheduleId,
                occurrenceDate,
                errorMessage: error.message
            })
        } catch (recordError) {
            ec.logger.error("Recurring invoice failure not recorded: " + recordError.message)
        }
        return {failed: true, errorMessage: error.message, reasonCode: lib.entityLib.reasonCode(error)}
    }
}
// A user's generation of a period (the schedule's next by default), for the side's edit permission.
function generate(p) {
    const scope = scheduleScope(p, "edit")
    const day = dayText(p.occurrenceDate) || dayText(scope.schedule.nextDate)
    if (scope.schedule.statusId === "IschEnded") denied("SCHEDULE_ENDED", "The schedule has ended")
    const out = attempt(scope.schedule.invoiceScheduleId, day)
    if (out.failed) denied(out.reasonCode || "GENERATION_FAILED", out.errorMessage.replace(/^[A-Z_]+: /, ""))
    return out
}
// The job: every active schedule's periods due through today (at most 12 each), each its own draft; a failure is
// recorded and the others go on.
function run() {
    const now = today()
    const due = Array.from(
        find(S, {statusId: "IschActive"}).condition("nextDate", "less-equals", now).orderBy("nextDate").limit(500).list()
    )
    let generatedCount = 0,
        failedCount = 0
    for (const schedule of due) {
        let day = dayText(schedule.nextDate)
        for (let count = 0; count < MAX_PER_RUN && day && day <= now; count++) {
            if (schedule.endDate && day > dayText(schedule.endDate)) break
            const out = attempt(schedule.invoiceScheduleId, day, true)
            if (out.skipped) break
            if (out.failed) {
                failedCount++
                break
            }
            if (!out.alreadyGenerated) generatedCount++
            day = dayText(one(S, {invoiceScheduleId: schedule.invoiceScheduleId})?.nextDate)
        }
    }
    return {scheduleCount: due.length, generatedCount, failedCount}
}

const operations = {store, preview, occurrence, recordFailure, generate, run}
;({
    occurrenceDay,
    nextAfter,
    execute(op, parameters) {
        if (!operations[op]) throw new Error("Unknown recurring invoice operation " + op)
        return operations[op](parameters)
    }
})
