// People's payroll exchange (mantle.humanres.PayrollExchangeServices preview#Batch, reconcile#Batch, execute#Batch, get#Batch,
// find#Batches, find#ExchangeRuns, find#ExportScopes and export#InputsTransfer; IronStone People design §8.4 external processing
// and migration, PayrollExchange, §15; PE-19; impl-people P28). Three kinds of batch, each previewed (every row resolved and named),
// reconciled (identities and totals compared with what the sender signed off, at a revision) and executed (each row, or each
// employee's rows, in a transaction of its own: one that fails is named and the rest go on):
// - export: a pay group's period's approved inputs (each its employment, kind, component or input name, day, quantity or amount and
//   its source key) for an external processor, written through the framework's export target payrollExchangeInputs (so Admin's
//   Exports lists it) and stored with its manifest (the rows, employees, totals and the file's hash);
// - history: pay records of a former system before the cutover day, each a legacy pay record (EmploymentPayHistory, internal payroll
//   N: shown as recorded, never recalculated, never an obligation); a day People paid the employment (a final or issued slip) or a
//   record of the day with other amounts is refused, one with the same amounts is known, so no amount counts twice;
// - results: an external processor's lines (worker, component, amount) for a group in external processing, as a pay run of the
//   period whose employments carry them (PayrollRun.exchangeBatchId): it is approved and finalized as any run, so the same slips,
//   obligations and Accounting handoff follow (PayrollObligations.js); the group must be live and Accounting's payroll-origin
//   projection in place (requireLive, requireProjection: the user's call of Nov 11, 2026, F30). An employee with a refused line is
//   refused whole.
// A file replayed (the same kind, scope and content) answers the batch it made (repeated): nothing is added. Who: a payroll reader
// (PAYROLL_VIEW) reads the batches of the employers in their People scope; an export needs PAYROLL_EDIT too; an import PEOPLE_IMPORT,
// PAYROLL_VIEW and PAYROLL_EDIT (People's import permission, impl-people §4). Another employer's batch is a missing one.
const people = ec.resource.script("component://mr-mantle/service/mantle/humanres/People.js")
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const {find, one, rows, denied, call, calendarDateText, dateText} = lib
const inputs = () => ec.resource.script("component://mr-mantle/service/mantle/humanres/PayInputs.js")
const obligations = () => ec.resource.script("component://mr-mantle/service/mantle/humanres/PayrollObligations.js")
const attendance = () => ec.resource.script("component://mr-mantle/service/mantle/humanres/Attendance.js")
const transferLib = () => ec.resource.script("component://framework/service/org/moqui/admin/DataTransferLib.js")
const approvals = () => ec.resource.script("component://mr-mantle/service/mantle/humanres/Approvals.js")

const BATCH = "mantle.humanres.payroll.PayrollExchangeBatch"
const ROW = "mantle.humanres.payroll.PayrollExchangeRow"
const GROUP = "mantle.humanres.payroll.PayrollGroup"
const GROUP_PERIOD = "mantle.humanres.payroll.PayrollGroupPeriod"
const INPUT = "mantle.humanres.payroll.PayrollInput"
const RUN = "mantle.humanres.payroll.PayrollRun"
const UNIT = "mantle.humanres.payroll.PayrollRunEmployment"
const RESULT = "mantle.humanres.payroll.PayrollRunResult"
const COMPONENT = "mantle.humanres.payroll.PayrollComponent"
const TERM = "mantle.humanres.payroll.PayrollComponentTerm"
const SLIP = "mantle.humanres.payroll.Payslip"
const OBLIGATION = "mantle.humanres.payroll.PayrollObligation"
const HISTORY = "mantle.humanres.employment.EmploymentPayHistory"
const RELATIONSHIP = "mantle.party.PartyRelationship"
const PERIOD = "mantle.party.time.TimePeriod"
const EXPORT_TARGET = "payrollExchangeInputs"

const kinds = {export: "PxkExport", history: "PxkHistory", results: "PxkResults"}
const kindTexts = {
    PxkExport: "Export of approved inputs",
    PxkHistory: "Import of payroll history",
    PxkResults: "Import of a processor's results"
}
const statusTexts = {PxbPreviewed: "Previewed", PxbReconciled: "Reconciled", PxbExecuted: "Done"}
const outcomeTexts = {
    ready: "Ready",
    known: "Recorded already",
    duplicate: "Repeated in the file",
    refused: "Refused",
    exported: "Exported",
    applied: "Applied",
    failed: "Failed"
}
const inputTypeTexts = {
    PitWorked: "Worked hours",
    PitPaidLeave: "Paid leave",
    PitUnpaidLeave: "Unpaid leave",
    PitPieces: "Pieces",
    PitReimbursement: "Expense reimbursement",
    PitAdjustment: "Adjustment",
    PitAdvanceRecovery: "Advance recovery",
    PitOverpaymentRecovery: "Overpayment recovery"
}
const kindSigns = {PckEarning: "gross", PckDeduction: "deductions", PckContribution: "contributions"}
const factStatuses = ["PssFinal", "PssIssued"]
const importBounds = {maxRows: 5000, maxColumns: 30, maxCell: 200}
const importMaxBytes = 1048576
const listCap = 2000
const runCap = 200
const exportColumns = [
    "worker",
    "workerName",
    "employment",
    "inputKind",
    "component",
    "inputName",
    "date",
    "quantity",
    "unit",
    "amount",
    "currency",
    "rate",
    "sourceKey"
]

const ms = lib.ms
const text = value => String(value ?? "").trim()
const unique = people.unique
const zero = () => toDecimal(0)
const decimalOf = value => (value == null || value === "" ? zero() : toDecimal(value))
const nowMs = () => ms(ec.user.nowTimestamp)
const stamp = millis => (millis == null ? null : new Date(Number(millis)))
const moneyText = (amount, currencyUomId) =>
    amount == null || amount === "" ? "" : currencyUomId ? ec.l10n.formatCurrency(amount, currencyUomId) : String(amount)
const plainAmount = value => (value == null || value === "" ? "" : String(toDecimal(value)))
const rowsIn = (entityName, field, ids) => {
    const out = []
    const list = unique(Array.from(ids || []).filter(Boolean))
    for (let index = 0; index < list.length; index += 1000)
        out.push(
            ...Array.from(
                find(entityName)
                    .condition(field, "in", list.slice(index, index + 1000))
                    .list()
            )
        )
    return out
}
const dayNoon = dayText => ec.l10n.parseTimestamp(dayText + " 12:00:00", "yyyy-MM-dd HH:mm:ss")
const dayValue = value => {
    const given = text(value).slice(0, 10)
    return /^\d{4}-\d{2}-\d{2}$/.test(given) && Number.isFinite(Date.parse(given + "T12:00:00Z")) ? given : null
}
// a plain amount, with commas only as thousands separators (1,234.50): "1.234,50" is no amount, never read as 1.23450
const amountOf = value => {
    const given = text(value)
    if (!/^([0-9]+|[0-9]{1,3}(,[0-9]{3})+)(\.[0-9]+)?$/.test(given)) return null
    return toDecimal(given.replace(/,/g, ""))
}
const revisionOf = value => String(lib.hash(value)).slice(0, 48)

// ===== access =====
function readerScope() {
    const userScope = people.scopeOf()
    if (!userScope.capabilities.payrollView) denied("PERMISSION_DENIED", "Payroll exchange is not available")
    return userScope
}
const exportsPay = caps => !!(caps.payrollView && caps.payrollEdit)
const imports = caps => !!(caps.import && caps.payrollView && caps.payrollEdit)
function scopeFor(exchangeKindEnumId) {
    const userScope = people.scopeOf()
    const caps = userScope.capabilities
    if (exchangeKindEnumId === "PxkExport") {
        if (!exportsPay(caps)) denied("PERMISSION_DENIED", "Exporting pay inputs needs PAYROLL_VIEW and PAYROLL_EDIT")
    } else if (!imports(caps)) denied("PERMISSION_DENIED", "Importing payroll needs PEOPLE_IMPORT, PAYROLL_VIEW and PAYROLL_EDIT")
    return userScope
}
function groupIn(userScope, payrollGroupId) {
    const id = text(payrollGroupId)
    if (!id) denied("GROUP_REQUIRED", "Choose the pay group")
    const group = one(GROUP, {payrollGroupId: id})
    if (!group || !userScope.organizationPartyIds.includes(group.organizationPartyId))
        denied("RECORD_UNAVAILABLE", "Pay group " + id + " is not available")
    return group
}
function batchIn(userScope, payrollExchangeBatchId) {
    const id = text(payrollExchangeBatchId)
    const batch = id ? one(BATCH, {payrollExchangeBatchId: id}) : null
    if (!batch || !userScope.organizationPartyIds.includes(batch.organizationPartyId))
        denied("RECORD_UNAVAILABLE", "Payroll exchange " + id + " is not available")
    return batch
}
const external = group => group?.externalProcessing === "Y"
function requireExternal(group) {
    if (!external(group))
        denied(
            "NOT_EXTERNAL",
            "This pay group is calculated here: a processor's results are imported only for a group in external processing (Pay groups)"
        )
}

// ===== the file =====
function readFile(p) {
    let source = ""
    let fileName = text(p.fileName)
    const file = p.importFile
    if (file && Number(file.size) > 0) {
        if (Number(file.size) > importMaxBytes)
            denied("FILE_TOO_LARGE", "The file is larger than " + importMaxBytes / 1024 + " KiB")
        source = String(file.getString("UTF-8") || "")
        fileName = fileName || text(file.getName())
    } else source = String(p.importText || "")
    if (!source.trim()) denied("FILE_REQUIRED", "Choose the file")
    if (source.length > importMaxBytes) denied("FILE_TOO_LARGE", "The file is larger than " + importMaxBytes / 1024 + " KiB")
    let parsed
    try {
        parsed = transferLib().parseDelimited(source, text(p.delimiter) === "tab" ? "\t" : text(p.delimiter) || ",", importBounds)
    } catch (error) {
        denied("FILE_UNREADABLE", String(error?.message ?? error))
    }
    return {source, fileName, parsed}
}
// A file's column by its header, ignoring case and spaces: the first of the names given.
function columnsOf(parsed, wanted) {
    const squash = value =>
        text(value)
            .toLowerCase()
            .replace(/[\s_-]+/g, "")
    const out = {}
    for (const [field, spec] of Object.entries(wanted)) {
        out[field] = parsed.headers.find(header => spec.names.map(squash).includes(squash(header))) || null
        if (!out[field] && spec.required) denied("COLUMN_MISSING", "The file has no column " + spec.names[0])
    }
    return out
}

// ===== preview#Batch =====
// A batch read and each row resolved, nothing made: an export of the period's approved inputs, or an import file's rows. A file
// (or, for an export, the same inputs) seen already for the same scope answers its batch (repeated).
function previewBatch(p) {
    const exchangeKindEnumId =
        kinds[text(p.exchangeKind)] || (kindTexts[text(p.exchangeKindEnumId)] ? text(p.exchangeKindEnumId) : null)
    if (!exchangeKindEnumId) denied("KIND_INVALID", "Choose an export of inputs, an import of history or an import of results")
    const userScope = scopeFor(exchangeKindEnumId)
    if (exchangeKindEnumId === "PxkExport") return previewExport(userScope, p)
    if (exchangeKindEnumId === "PxkHistory") return previewHistory(userScope, p)
    return previewResults(userScope, p)
}
function newBatch(values, rowList) {
    const existing = one(BATCH, {batchKey: values.batchKey})
    if (existing) return Object.assign(batchAnswer(existing), {repeated: true})
    const created = call(
        "create#" + BATCH,
        Object.assign(
            {
                statusId: "PxbPreviewed",
                rowCount: rowList.length,
                createdByUserId: ec.user.userId || null,
                createdDate: ec.user.nowTimestamp
            },
            values
        )
    )
    rowList.forEach((row, index) =>
        call(
            "create#" + ROW,
            Object.assign(
                {payrollExchangeBatchId: created.payrollExchangeBatchId, rowSeqId: String(index + 1).padStart(5, "0")},
                row
            )
        )
    )
    const batch = one(BATCH, {payrollExchangeBatchId: created.payrollExchangeBatchId})
    countRows(batch)
    return Object.assign(batchAnswer(one(BATCH, {payrollExchangeBatchId: batch.payrollExchangeBatchId})), {repeated: false})
}
function countRows(batch) {
    const counts = {ready: 0, skipped: 0, error: 0, applied: 0}
    for (const row of rows(ROW, {payrollExchangeBatchId: batch.payrollExchangeBatchId})) {
        if (row.outcome === "ready") counts.ready++
        else if (row.outcome === "known" || row.outcome === "duplicate") counts.skipped++
        else if (row.outcome === "refused" || row.outcome === "failed") counts.error++
        else if (row.outcome === "applied" || row.outcome === "exported") counts.applied++
    }
    call("update#" + BATCH, {
        payrollExchangeBatchId: batch.payrollExchangeBatchId,
        readyCount: counts.ready,
        skippedCount: counts.skipped,
        errorCount: counts.error,
        appliedCount: counts.applied
    })
}
function signedOff(p, exchangeKindEnumId) {
    const count = text(p.expectedCount)
    const out = {
        expectedCount: count === "" ? null : /^\d+$/.test(count) ? Number(count) : NaN,
        expectedGross: text(p.expectedGross) === "" ? null : amountOf(p.expectedGross),
        expectedNet: text(p.expectedNet) === "" ? null : amountOf(p.expectedNet)
    }
    if (
        Number.isNaN(out.expectedCount) ||
        (text(p.expectedGross) && !out.expectedGross) ||
        (text(p.expectedNet) && !out.expectedNet)
    )
        denied("SIGNOFF_INVALID", "The signed-off count is a whole number and the totals are amounts")
    if (exchangeKindEnumId === "PxkResults" && (out.expectedCount == null || out.expectedNet == null))
        denied("SIGNOFF_REQUIRED", "Give what the processor signed off: the employees and the net total (and the gross)")
    return out
}

// export: the period's approved inputs of the group, each a row with its source key
function approvedInputs(group, timePeriodId) {
    return Array.from(
        find(INPUT)
            .condition({payrollGroupId: group.payrollGroupId, timePeriodId, statusId: "PinApproved"})
            .orderBy(["partyRelationshipId", "inputDate", "payrollInputId"])
            .limit(listCap + 1)
            .list()
    )
}
function previewExport(userScope, p) {
    const group = groupIn(userScope, p.payrollGroupId)
    const period = inputs().periodOf(group, p.timePeriodId)
    const found = approvedInputs(group, period.timePeriodId)
    if (found.length > listCap) denied("TOO_MANY_ROWS", "More than " + listCap + " inputs: export the period in the Data area")
    if (!found.length) denied("NOTHING_TO_EXPORT", "No approved pay input of " + period.text + " waits")
    const components = Object.fromEntries(
        rowsIn(
            COMPONENT,
            "payrollComponentId",
            found.map(row => row.payrollComponentId)
        ).map(row => [row.payrollComponentId, row])
    )
    const members = new Set(
        inputs()
            .groupMembers(group, period, inputs().zoneOf(group), unique(found.map(row => row.partyRelationshipId)))
            .map(member => member.partyRelationshipId)
    )
    const rowList = found.map(input => {
        const row = {
            partyId: input.partyId,
            partyRelationshipId: input.partyRelationshipId,
            workerText: input.partyId,
            payrollInputId: input.payrollInputId,
            payrollComponentId: input.payrollComponentId || null,
            componentText: input.payrollComponentId
                ? components[input.payrollComponentId]?.componentCode || input.payrollComponentId
                : input.inputName || inputTypeTexts[input.inputTypeEnumId] || input.inputTypeEnumId,
            sourceKey: input.entitlementKey || input.payrollInputId,
            payDate: input.inputDate,
            quantity: input.quantity ?? null,
            amount: input.amount ?? null,
            currencyUomId: input.currencyUomId || null,
            outcome: "ready"
        }
        if (!members.has(input.partyRelationshipId))
            Object.assign(row, {
                outcome: "refused",
                reasonCode: "NOT_IN_GROUP",
                message: "The group does not pay this employee in the period"
            })
        return row
    })
    const fingerprint = transferLib().sha(JSON.stringify(found.map(row => [row.payrollInputId, ms(row.lastUpdatedStamp)])))
    return newBatch(
        {
            exchangeKindEnumId: "PxkExport",
            organizationPartyId: group.organizationPartyId,
            payrollGroupId: group.payrollGroupId,
            timePeriodId: period.timePeriodId,
            currencyUomId: group.currencyUomId,
            sourceSystem: text(p.sourceSystem) || null,
            fileName: ("PayInputs-" + (group.groupName || group.payrollGroupId) + "-" + period.fromDay + ".csv").replace(
                /[^A-Za-z0-9._-]/g,
                "_"
            ),
            fileHash: fingerprint,
            batchKey: ["PxkExport", group.payrollGroupId, period.timePeriodId, fingerprint].join(":").slice(0, 255)
        },
        rowList
    )
}

// a worker named by People's person id or work email among those the employer employs or employed (Attendance.js's resolver)
const workerOf = (workerIdKind, organizationPartyId) =>
    attendance().workerResolver(workerIdKind === "workEmail" ? "workEmail" : "partyId", organizationPartyId)
function workerKind(p) {
    const workerIdKind = text(p.workerIdKind) || "partyId"
    if (!["partyId", "workEmail"].includes(workerIdKind)) denied("WORKER_KIND_INVALID", "Name workers by People id or work email")
    return workerIdKind
}
function sourceOf(p) {
    const sourceSystem = text(p.sourceSystem)
    if (!sourceSystem) denied("SOURCE_REQUIRED", "Name the system the file comes from")
    return sourceSystem
}

// history: worker, pay date, gross and net (a currency and a record key optional), before the cutover
function historyEmployment(partyId, organizationPartyId, dayText) {
    const atMs = ms(dayNoon(dayText))
    const all = Array.from(people.employmentFind().condition({fromPartyId: partyId, toPartyId: organizationPartyId}).list())
    const open = all.filter(row => (ms(row.fromDate) ?? -Infinity) <= atMs && (ms(row.thruDate) ?? Infinity) > atMs)
    // a final pay after the last day: an employment that ended within the 31 days before
    const ended = all.filter(row => row.thruDate != null && ms(row.thruDate) <= atMs && atMs - ms(row.thruDate) <= 31 * 86400000)
    const candidates = open.length ? open : ended
    if (!candidates.length) return {problem: ["NOT_EMPLOYED", "The worker was not employed by the employer that day"]}
    if (candidates.length > 1)
        return {problem: ["EMPLOYMENT_AMBIGUOUS", "The worker had more than one employment there that day"]}
    return {employment: candidates[0]}
}
// The first day People's own pay of an employment covers: the earliest start of a final or issued slip's period, or its pay day when
// earlier (a regular slip of January covers from January 1 whatever day it was paid), or null when People has not paid it.
function paidFrom(partyRelationshipId) {
    let first = null
    for (const slip of rows(SLIP, {partyRelationshipId}).filter(found => factStatuses.includes(found.statusId))) {
        const period = slip.timePeriodId ? one(PERIOD, {timePeriodId: slip.timePeriodId}) : null
        const days = [calendarDateText(slip.payDate), period ? calendarDateText(period.fromDate) : ""].filter(Boolean)
        for (const day of days) if (!first || day < first) first = day
    }
    return first
}
// what a history row would make now: a day People's own pay covers (PAID_HERE: on or after the start of the first period People paid
// the employment, so a former system's pay of a period People paid never counts beside it), the day's record with other amounts
// (CONFLICT), the same record (known), or ready
function historyState(row) {
    const day = calendarDateText(row.payDate)
    const from = paidFrom(row.partyRelationshipId)
    if (from && day >= from)
        return {
            outcome: "refused",
            reasonCode: "PAID_HERE",
            message: "People pays this employment from " + from + ": history is the pay before it, so no period counts twice"
        }
    const record = rows(HISTORY, {partyRelationshipId: row.partyRelationshipId}).find(
        found => calendarDateText(found.payDate) === day
    )
    if (!record) return {outcome: "ready", reasonCode: null, message: null}
    const same =
        decimalOf(record.payAmount).eq(decimalOf(row.grossAmount)) &&
        decimalOf(record.netPayAmount).eq(decimalOf(row.netAmount)) &&
        text(record.currencyUomId) === text(row.currencyUomId)
    return same
        ? {outcome: "known", reasonCode: null, message: "Recorded already with the same amounts"}
        : {
              outcome: "refused",
              reasonCode: "CONFLICT",
              message: "A pay record of this employment on " + day + " has other amounts"
          }
}
function previewHistory(userScope, p) {
    const organizationPartyId = text(p.organizationPartyId)
    if (!organizationPartyId) denied("ORGANIZATION_REQUIRED", "Choose the employer")
    people.requireOrganization(userScope, organizationPartyId)
    const cutover = dayValue(p.cutoverDate)
    if (!cutover) denied("CUTOVER_REQUIRED", "Give the cutover day: history is the pay before it")
    const sourceSystem = sourceOf(p)
    const workerIdKind = workerKind(p)
    const defaultCurrency = text(p.currencyUomId) || null
    if (defaultCurrency && !one("moqui.basic.Uom", {uomId: defaultCurrency}))
        denied("CURRENCY_INVALID", defaultCurrency + " is no currency")
    const signoff = signedOff(p, "PxkHistory")
    const {source, fileName, parsed} = readFile(p)
    const columns = columnsOf(parsed, {
        worker: {names: ["worker", "employee", "person"], required: true},
        payDate: {names: ["payDate", "date", "paid"], required: true},
        gross: {names: ["gross", "grossPay"], required: true},
        net: {names: ["net", "netPay"], required: true},
        currency: {names: ["currency"]}
    })
    const resolve = workerOf(workerIdKind, organizationPartyId)
    const seen = new Set()
    const rowList = parsed.rows.map(found => {
        const cell = field => (columns[field] ? text(found.sourceValues[columns[field]]) : "")
        const row = {lineNumber: found.rowNumber, workerText: cell("worker").slice(0, 200), outcome: "ready"}
        const refuse = (reasonCode, message) => Object.assign(row, {outcome: "refused", reasonCode, message})
        try {
            const partyId = resolve(row.workerText)
            const day = dayValue(cell("payDate"))
            const gross = amountOf(cell("gross"))
            const net = amountOf(cell("net"))
            const currencyUomId = cell("currency") || defaultCurrency
            Object.assign(row, {
                payDate: day,
                grossAmount: gross,
                netAmount: net,
                currencyUomId: currencyUomId || null
            })
            if (found.sourceError) refuse("ROW_INVALID", found.sourceError)
            else if (!partyId) refuse("WORKER_UNKNOWN", "No person is " + (row.workerText || "named"))
            else if (partyId === "_AMBIGUOUS_") refuse("WORKER_AMBIGUOUS", "More than one person has that work email")
            else if (!day) refuse("DATE_INVALID", "The pay date is read as yyyy-MM-dd")
            else if (day >= cutover) refuse("AFTER_CUTOVER", "History is the pay before the cutover day " + cutover)
            else if (gross == null || net == null || net.compare(gross) > 0)
                refuse("AMOUNT_INVALID", "Gross and net are amounts, the net at most the gross")
            else if (!currencyUomId || !one("moqui.basic.Uom", {uomId: currencyUomId}))
                refuse("CURRENCY_INVALID", "Name the currency of the amounts")
            else {
                const employed = historyEmployment(partyId, organizationPartyId, day)
                Object.assign(row, {partyId})
                if (employed.problem) refuse(employed.problem[0], employed.problem[1])
                else {
                    const key = employed.employment.partyRelationshipId + "|" + day
                    Object.assign(row, {partyRelationshipId: employed.employment.partyRelationshipId, sourceKey: key})
                    if (seen.has(key)) Object.assign(row, {outcome: "duplicate", message: "Repeated in the file"})
                    else Object.assign(row, historyState(row))
                    seen.add(key)
                }
            }
        } catch (error) {
            ec.logger.error("Payroll history line " + found.rowNumber + " could not be read: " + error.message)
            refuse("ROW_INVALID", "This row could not be read")
        }
        return row
    })
    const hash = transferLib().sha(source)
    return newBatch(
        Object.assign(
            {
                exchangeKindEnumId: "PxkHistory",
                organizationPartyId,
                cutoverDate: cutover,
                currencyUomId: defaultCurrency,
                sourceSystem,
                fileName: fileName || "payroll-history.csv",
                fileHash: hash,
                batchKey: ["PxkHistory", organizationPartyId, cutover, hash].join(":").slice(0, 255)
            },
            signoff
        ),
        rowList
    )
}

// results: worker, component and amount (a currency optional), for a group in external processing
function publishedTerm(payrollComponentId, atMs) {
    return (
        rows(TERM, {payrollComponentId, statusId: "PtsPublished"}).find(
            term => (ms(term.fromDate) ?? -Infinity) <= atMs && (ms(term.thruDate) ?? Infinity) > atMs
        ) || null
    )
}
// the employment's unit in the period's run of external results, if it has one
function resultsUnit(group, timePeriodId, partyRelationshipId) {
    const run = one(RUN, {activeRunKey: group.payrollGroupId + ":" + timePeriodId + ":PrkRegular"})
    return run ? one(UNIT, {payrollRunId: run.payrollRunId, partyRelationshipId}) : null
}
// what an employee's results would make now: paid already in the period (ALREADY_PAID: a net pay obligation of the employment for a
// run of the group's period), in the period's run already (known), or ready
function resultsState(group, timePeriodId, partyRelationshipId) {
    if (resultsUnit(group, timePeriodId, partyRelationshipId))
        return {outcome: "known", reasonCode: null, message: "In the period's pay run already"}
    const runIds = rows(RUN, {payrollGroupId: group.payrollGroupId, timePeriodId})
        .filter(run => run.statusId !== "PrnCancelled")
        .map(run => run.payrollRunId)
    const paid = rowsIn(OBLIGATION, "payrollRunId", runIds).some(
        row => row.partyRelationshipId === partyRelationshipId && row.obligationKindEnumId === "PokNetPay"
    )
    if (paid)
        return {
            outcome: "refused",
            reasonCode: "ALREADY_PAID",
            message: "The employee's pay of the period has an invoice already"
        }
    return {outcome: "ready", reasonCode: null, message: null}
}
function previewResults(userScope, p) {
    const group = groupIn(userScope, p.payrollGroupId)
    requireExternal(group)
    const period = inputs().periodOf(group, p.timePeriodId)
    const sourceSystem = sourceOf(p)
    const workerIdKind = workerKind(p)
    const signoff = signedOff(p, "PxkResults")
    const {source, fileName, parsed} = readFile(p)
    const columns = columnsOf(parsed, {
        worker: {names: ["worker", "employee", "person"], required: true},
        component: {names: ["component", "code", "line"], required: true},
        amount: {names: ["amount", "value"], required: true},
        currency: {names: ["currency"]}
    })
    const organizationPartyId = group.organizationPartyId
    const resolve = workerOf(workerIdKind, organizationPartyId)
    const payMs = ms(dayNoon(period.payDate))
    const components = new Map(rows(COMPONENT, {organizationPartyId}).map(row => [text(row.componentCode).toLowerCase(), row]))
    // the group's members of the period, by person
    const zone = inputs().zoneOf(group)
    const read = parsed.rows.map(found => {
        const cell = field => (columns[field] ? text(found.sourceValues[columns[field]]) : "")
        return {found, worker: cell("worker").slice(0, 200), component: cell("component").slice(0, 60), cell}
    })
    const partyIds = unique(read.map(entry => resolve(entry.worker)).filter(id => id && id !== "_AMBIGUOUS_"))
    const employmentIds = partyIds.length
        ? Array.from(
              people
                  .employmentFind()
                  .condition("fromPartyId", "in", partyIds)
                  .condition("toPartyId", organizationPartyId)
                  .selectField("partyRelationshipId")
                  .list()
          ).map(row => row.partyRelationshipId)
        : []
    const memberOf = {}
    for (const member of inputs().groupMembers(group, period, zone, employmentIds.length ? employmentIds : ["-"]))
        (memberOf[member.partyId] ||= []).push(member)
    const seen = new Set()
    const rowList = read.map(({found, worker, component, cell}) => {
        const row = {lineNumber: found.rowNumber, workerText: worker, componentText: component, outcome: "ready"}
        const refuse = (reasonCode, message) => Object.assign(row, {outcome: "refused", reasonCode, message})
        try {
            const partyId = resolve(worker)
            const amount = amountOf(cell("amount"))
            const currencyUomId = cell("currency") || group.currencyUomId
            const componentRow = components.get(component.toLowerCase()) || null
            Object.assign(row, {amount, currencyUomId})
            if (found.sourceError) refuse("ROW_INVALID", found.sourceError)
            else if (!partyId) refuse("WORKER_UNKNOWN", "No person is " + (worker || "named"))
            else if (partyId === "_AMBIGUOUS_") refuse("WORKER_AMBIGUOUS", "More than one person has that work email")
            else {
                const members = memberOf[partyId] || []
                Object.assign(row, {partyId})
                if (!members.length) refuse("NOT_IN_GROUP", "The group does not pay this worker in the period")
                else if (members.length > 1)
                    refuse("EMPLOYMENT_AMBIGUOUS", "The worker has more than one employment in the group")
                else {
                    Object.assign(row, {partyRelationshipId: members[0].partyRelationshipId})
                    const term = componentRow ? publishedTerm(componentRow.payrollComponentId, payMs) : null
                    if (!componentRow || !term)
                        refuse(
                            "COMPONENT_UNKNOWN",
                            "No pay component " + (component || "named") + " is published on the pay date"
                        )
                    else if (amount == null || !ec.l10n.roundCurrency(amount, group.currencyUomId).eq(amount))
                        refuse("AMOUNT_INVALID", "The amount is a positive amount in the currency's units")
                    else if (currencyUomId !== group.currencyUomId)
                        refuse("CURRENCY_MISMATCH", "The group pays in " + group.currencyUomId)
                    else {
                        Object.assign(row, {payrollComponentId: componentRow.payrollComponentId})
                        const key = members[0].partyRelationshipId + "|" + componentRow.payrollComponentId
                        if (seen.has(key)) refuse("LINE_REPEATED", "The employee has this component twice in the file")
                        seen.add(key)
                    }
                }
            }
        } catch (error) {
            ec.logger.error("Payroll results line " + found.rowNumber + " could not be read: " + error.message)
            refuse("ROW_INVALID", "This row could not be read")
        }
        return row
    })
    settleEmployees(group, period.timePeriodId, rowList)
    const hash = transferLib().sha(source)
    return newBatch(
        Object.assign(
            {
                exchangeKindEnumId: "PxkResults",
                organizationPartyId,
                payrollGroupId: group.payrollGroupId,
                timePeriodId: period.timePeriodId,
                currencyUomId: group.currencyUomId,
                sourceSystem,
                fileName: fileName || "payroll-results.csv",
                fileHash: hash,
                batchKey: ["PxkResults", group.payrollGroupId, period.timePeriodId, hash].join(":").slice(0, 255)
            },
            signoff
        ),
        rowList
    )
}
// An employee's results are one slip: a refused line refuses the employee's other lines (EMPLOYEE_INCOMPLETE), a negative net refuses
// them all (NEGATIVE_NET), and the employee's state now (known, ALREADY_PAID) is each line's.
function employeeTotals(lines, componentsById) {
    const totals = {gross: zero(), deductions: zero(), contributions: zero()}
    for (const line of lines) {
        const kind = kindSigns[componentsById[line.payrollComponentId]?.componentKindEnumId]
        if (kind) totals[kind] = totals[kind].add(decimalOf(line.amount))
    }
    totals.net = totals.gross.subtract(totals.deductions)
    totals.employerCost = totals.gross.add(totals.contributions)
    return totals
}
function settleEmployees(group, timePeriodId, rowList) {
    const componentsById = Object.fromEntries(
        rowsIn(
            COMPONENT,
            "payrollComponentId",
            rowList.map(row => row.payrollComponentId)
        ).map(row => [row.payrollComponentId, row])
    )
    const byEmployment = {}
    for (const row of rowList) if (row.partyRelationshipId) (byEmployment[row.partyRelationshipId] ||= []).push(row)
    for (const [partyRelationshipId, lines] of Object.entries(byEmployment)) {
        const live = lines.filter(row => row.outcome !== "refused")
        if (!live.length) continue
        if (live.length < lines.length) {
            for (const row of live)
                Object.assign(row, {
                    outcome: "refused",
                    reasonCode: "EMPLOYEE_INCOMPLETE",
                    message: "Another line of this employee was refused: an employee's results are applied whole"
                })
            continue
        }
        if (employeeTotals(live, componentsById).net.compare(0) < 0) {
            for (const row of live)
                Object.assign(row, {outcome: "refused", reasonCode: "NEGATIVE_NET", message: "The employee's net is negative"})
            continue
        }
        const state = resultsState(group, timePeriodId, partyRelationshipId)
        for (const row of live) Object.assign(row, state)
    }
}

// ===== reconcile#Batch =====
// What a batch would do now, compared with what its sender signed off: each ready or known row checked again (an input changed or
// taken since, a day recorded or paid since), the totals (an export's rows, employees and amounts by currency; history's records,
// gross and net; results' employees, gross, deductions, contributions and net, each employee's), the differences from the signed-off
// count and totals, and, for results, the group's live reasons. Read alone (look) or kept as the batch's reconciliation at its
// revision, which an execution names.
function reconcileBatch(p) {
    const userScope = readerScope()
    const batch = batchIn(userScope, p.payrollExchangeBatchId)
    if (batch.statusId === "PxbExecuted") return Object.assign(batchAnswer(batch), {reconciliation: reconciliationOf(batch)})
    scopeFor(batch.exchangeKindEnumId)
    const changes = {}
    for (const field of ["expectedCount", "expectedGross", "expectedNet"])
        if (p[field] != null && text(p[field]) !== "") changes[field] = p[field]
    if (Object.keys(changes).length) {
        const given = signedOff(
            Object.assign(
                {expectedCount: batch.expectedCount, expectedGross: batch.expectedGross, expectedNet: batch.expectedNet},
                changes
            ),
            batch.exchangeKindEnumId
        )
        call("update#" + BATCH, Object.assign({payrollExchangeBatchId: batch.payrollExchangeBatchId}, given))
    }
    const current = one(BATCH, {payrollExchangeBatchId: batch.payrollExchangeBatchId})
    const found = reconciled(current, true)
    call("update#" + BATCH, {
        payrollExchangeBatchId: current.payrollExchangeBatchId,
        statusId: "PxbReconciled",
        reconcileRevision: found.revision,
        manifestJson: JSON.stringify(found.summary),
        reconciledByUserId: ec.user.userId || null,
        reconciledDate: ec.user.nowTimestamp
    })
    countRows(current)
    const after = one(BATCH, {payrollExchangeBatchId: current.payrollExchangeBatchId})
    return Object.assign(batchAnswer(after), {reconciliation: found.summary})
}
// The reconciliation of a batch now: with write, each changed row's outcome kept. {summary, revision}.
function reconciled(batch, write) {
    const list = rows(ROW, {payrollExchangeBatchId: batch.payrollExchangeBatchId}).sort((a, b) =>
        a.rowSeqId.localeCompare(b.rowSeqId)
    )
    const group = batch.payrollGroupId ? one(GROUP, {payrollGroupId: batch.payrollGroupId}) : null
    const update = (row, state) => {
        if (row.outcome === state.outcome && (row.reasonCode || null) === (state.reasonCode || null)) return
        Object.assign(row, state)
        if (write)
            call("update#" + ROW, {
                payrollExchangeBatchId: row.payrollExchangeBatchId,
                rowSeqId: row.rowSeqId,
                outcome: state.outcome,
                reasonCode: state.reasonCode || null,
                message: state.message || null
            })
    }
    const live = row => row.outcome === "ready" || row.outcome === "known"
    if (batch.exchangeKindEnumId === "PxkExport") {
        const inputsNow = Object.fromEntries(
            rowsIn(
                INPUT,
                "payrollInputId",
                list.map(row => row.payrollInputId)
            ).map(row => [row.payrollInputId, row])
        )
        for (const row of list.filter(live)) {
            const input = inputsNow[row.payrollInputId]
            const same =
                input &&
                input.statusId === "PinApproved" &&
                decimalOf(input.amount).eq(decimalOf(row.amount)) &&
                decimalOf(input.quantity).eq(decimalOf(row.quantity))
            update(
                row,
                same
                    ? {outcome: "ready", reasonCode: null, message: null}
                    : {
                          outcome: "refused",
                          reasonCode: "INPUT_CHANGED",
                          message: "The input changed since the preview: preview again"
                      }
            )
        }
    } else if (batch.exchangeKindEnumId === "PxkHistory") {
        for (const row of list.filter(live)) update(row, historyState(row))
    } else {
        const byEmployment = {}
        for (const row of list.filter(live)) (byEmployment[row.partyRelationshipId] ||= []).push(row)
        for (const [partyRelationshipId, lines] of Object.entries(byEmployment)) {
            const state = resultsState(group, batch.timePeriodId, partyRelationshipId)
            for (const row of lines) update(row, state)
        }
    }
    const ready = list.filter(row => row.outcome === "ready")
    const currencyUomId = batch.currencyUomId
    const summary = {
        kind: batch.exchangeKindEnumId,
        rowCount: list.length,
        readyCount: ready.length,
        knownCount: list.filter(row => row.outcome === "known" || row.outcome === "duplicate").length,
        refusedCount: list.filter(row => row.outcome === "refused").length,
        employeeCount: unique(ready.map(row => row.partyRelationshipId)).length,
        totals: [],
        employees: [],
        differences: [],
        liveReasons: []
    }
    const difference = (what, expected, found, asMoney) => {
        if (expected == null) return
        const same = asMoney ? decimalOf(expected).eq(decimalOf(found)) : Number(expected) === Number(found)
        if (!same)
            summary.differences.push({
                what,
                expectedText: asMoney ? moneyText(expected, currencyUomId) : String(expected),
                foundText: asMoney ? moneyText(found, currencyUomId) : String(found)
            })
    }
    if (batch.exchangeKindEnumId === "PxkExport") {
        const byCurrency = {}
        for (const row of ready)
            if (row.amount != null) {
                const key = row.currencyUomId || currencyUomId
                byCurrency[key] = (byCurrency[key] || zero()).add(decimalOf(row.amount))
            }
        const quantities = {}
        for (const row of ready)
            if (row.quantity != null)
                quantities[row.componentText] = (quantities[row.componentText] || zero()).add(decimalOf(row.quantity))
        summary.totals = Object.entries(byCurrency)
            .map(([key, value]) => ({what: "Amounts in " + key, value: plainAmount(value), valueText: moneyText(value, key)}))
            .concat(
                Object.entries(quantities).map(([key, value]) => ({
                    what: "Quantity of " + key,
                    value: plainAmount(value),
                    valueText: plainAmount(value)
                }))
            )
        summary.sourceKeys = ready.map(row => row.sourceKey)
    } else if (batch.exchangeKindEnumId === "PxkHistory") {
        const gross = ready.reduce((sum, row) => sum.add(decimalOf(row.grossAmount)), zero())
        const net = ready.reduce((sum, row) => sum.add(decimalOf(row.netAmount)), zero())
        summary.totals = [
            {what: "Records", value: String(ready.length), valueText: String(ready.length)},
            {what: "Gross", value: plainAmount(gross), valueText: moneyText(gross, currencyUomId)},
            {what: "Net", value: plainAmount(net), valueText: moneyText(net, currencyUomId)}
        ]
        // each employee's history a year (year to date as the history holds it)
        const byYear = {}
        for (const row of ready) {
            const key = row.partyRelationshipId + "|" + calendarDateText(row.payDate).slice(0, 4)
            const entry = (byYear[key] ||= {
                partyId: row.partyId,
                year: calendarDateText(row.payDate).slice(0, 4),
                gross: zero(),
                net: zero(),
                count: 0
            })
            entry.gross = entry.gross.add(decimalOf(row.grossAmount))
            entry.net = entry.net.add(decimalOf(row.netAmount))
            entry.count++
        }
        const names = people.personNames(unique(Object.values(byYear).map(entry => entry.partyId)))
        summary.employees = Object.values(byYear)
            .slice(0, 500)
            .map(entry => ({
                personName: names[entry.partyId] || entry.partyId,
                periodText: entry.year,
                countText: String(entry.count),
                grossText: moneyText(entry.gross, currencyUomId),
                netText: moneyText(entry.net, currencyUomId)
            }))
            .sort((a, b) => a.personName.localeCompare(b.personName) || a.periodText.localeCompare(b.periodText))
        difference("Records", batch.expectedCount, ready.length, false)
        difference("Gross", batch.expectedGross, gross, true)
        difference("Net", batch.expectedNet, net, true)
    } else {
        const componentsById = Object.fromEntries(
            rowsIn(
                COMPONENT,
                "payrollComponentId",
                ready.map(row => row.payrollComponentId)
            ).map(row => [row.payrollComponentId, row])
        )
        const byEmployment = {}
        for (const row of ready) (byEmployment[row.partyRelationshipId] ||= []).push(row)
        const all = {gross: zero(), deductions: zero(), contributions: zero(), net: zero()}
        const names = people.personNames(unique(ready.map(row => row.partyId)))
        for (const lines of Object.values(byEmployment)) {
            const totals = employeeTotals(lines, componentsById)
            for (const key of Object.keys(all)) all[key] = all[key].add(totals[key])
            if (summary.employees.length < 500)
                summary.employees.push({
                    personName: names[lines[0].partyId] || lines[0].partyId,
                    countText: String(lines.length),
                    grossText: moneyText(totals.gross, currencyUomId),
                    deductionsText: moneyText(totals.deductions, currencyUomId),
                    netText: moneyText(totals.net, currencyUomId)
                })
        }
        summary.employees.sort((a, b) => a.personName.localeCompare(b.personName))
        summary.totals = [
            {
                what: "Employees",
                value: String(Object.keys(byEmployment).length),
                valueText: String(Object.keys(byEmployment).length)
            },
            {what: "Gross", value: plainAmount(all.gross), valueText: moneyText(all.gross, currencyUomId)},
            {what: "Deductions", value: plainAmount(all.deductions), valueText: moneyText(all.deductions, currencyUomId)},
            {
                what: "Employer contributions",
                value: plainAmount(all.contributions),
                valueText: moneyText(all.contributions, currencyUomId)
            },
            {what: "Net", value: plainAmount(all.net), valueText: moneyText(all.net, currencyUomId)}
        ]
        difference("Employees", batch.expectedCount, Object.keys(byEmployment).length, false)
        difference("Gross", batch.expectedGross, all.gross, true)
        difference("Net", batch.expectedNet, all.net, true)
        summary.liveReasons = group ? obligations().liveReasons(group) : []
        if (group && !external(group))
            summary.liveReasons.unshift({
                reasonCode: "NOT_EXTERNAL",
                message: "The pay group is no longer in external processing"
            })
    }
    const revision = revisionOf({
        rows: list.map(row => row.rowSeqId + ":" + row.outcome + ":" + (row.reasonCode || "")),
        totals: summary.totals.map(total => total.what + "=" + total.value),
        expected: [batch.expectedCount, batch.expectedGross, batch.expectedNet].map(value => (value == null ? "" : String(value)))
    })
    return {summary, revision}
}
function reconciliationOf(batch) {
    return lib.json(batch.manifestJson, null)
}

// ===== execute#Batch =====
// A reconciled batch done at the revision reconciled (RECONCILE_STALE: something changed since; reconcile again), with no difference
// from what its sender signed off (TOTALS_DIFFER) and at least one ready row (NOTHING_READY). An export is written and stored with its
// manifest; history's ready rows each recorded in a transaction of its own; results' employees each in a transaction of their own into
// the period's pay run. A batch done already answers as it ended (repeated).
function executeBatch(p) {
    const userScope = readerScope()
    let batch = batchIn(userScope, p.payrollExchangeBatchId)
    scopeFor(batch.exchangeKindEnumId)
    if (batch.statusId === "PxbExecuted") return Object.assign(batchAnswer(batch), {repeated: true})
    if (batch.statusId !== "PxbReconciled") denied("NOT_RECONCILED", "Reconcile the batch before it is done")
    const now = reconciled(batch, false)
    if (now.revision !== batch.reconcileRevision)
        denied("RECONCILE_STALE", "The batch changed since it was reconciled: reconcile it again")
    if (now.summary.differences.length)
        denied(
            "TOTALS_DIFFER",
            "The file does not match what was signed off: " +
                now.summary.differences
                    .map(found => found.what + " " + found.foundText + ", signed off " + found.expectedText)
                    .join("; ")
        )
    if (!now.summary.readyCount) denied("NOTHING_READY", "No row of the batch is ready")
    if (batch.exchangeKindEnumId === "PxkExport") executeExport(batch, now.summary)
    else if (batch.exchangeKindEnumId === "PxkHistory") executeHistory(batch)
    else executeResults(batch)
    batch = one(BATCH, {payrollExchangeBatchId: batch.payrollExchangeBatchId})
    countRows(batch)
    call("update#" + BATCH, {
        payrollExchangeBatchId: batch.payrollExchangeBatchId,
        statusId: "PxbExecuted",
        executedByUserId: ec.user.userId || null,
        executedDate: ec.user.nowTimestamp
    })
    return Object.assign(batchAnswer(one(BATCH, {payrollExchangeBatchId: batch.payrollExchangeBatchId})), {repeated: false})
}
// The export written through the framework's export target (its record kept there, listed in Admin's Exports), then stored with its
// manifest: the batch, the scope, the rows, employees and totals, the source keys and the file's hash.
function executeExport(batch, summary) {
    const out = ec.service
        .sync()
        .name("org.moqui.admin.DataTransferServices.run#Export")
        .parameters({
            targetId: EXPORT_TARGET,
            scopeKey: batch.payrollGroupId + ":" + batch.timePeriodId,
            selection: {batch: batch.payrollExchangeBatchId},
            fieldList: exportColumns,
            operationKey: "payroll-exchange-" + batch.payrollExchangeBatchId
        })
        .call()
    if (ec.message.hasError()) throw new Error(ec.message.getErrorsString())
    if (!out?.exported) denied(text(out?.reasonCode) || "EXPORT_REFUSED", text(out?.reason) || "The export was refused")
    const root = ec.user.getPreference("mantle.content.large.root") || "dbresource://mantle/content"
    const folder = root + "/payrollExchange/" + batch.payrollExchangeBatchId + "/"
    const fileName = text(out.filename) || batch.fileName
    ec.resource.getLocationReference(folder + fileName).putText(String(out.fileText || ""))
    const group = one(GROUP, {payrollGroupId: batch.payrollGroupId})
    const period = one(PERIOD, {timePeriodId: batch.timePeriodId})
    const manifest = {
        exchange: batch.payrollExchangeBatchId,
        kind: "payroll inputs",
        employer: batch.organizationPartyId,
        payGroup: batch.payrollGroupId,
        payGroupName: group?.groupName || null,
        period: period ? calendarDateText(period.fromDate) + " to " + calendarDateText(period.thruDate) : batch.timePeriodId,
        currency: batch.currencyUomId,
        file: fileName,
        fileSha256: transferLib().sha(String(out.fileText || "")),
        rows: Number(out.rowCount || 0),
        employees: summary.employeeCount,
        totals: summary.totals.map(total => ({what: total.what, value: total.value})),
        sourceKeys: summary.sourceKeys || [],
        fields: Array.from(out.fieldList || []).map(field => field.name || field),
        omittedFields: Array.from(out.omittedFieldList || []).map(field => field.name || field),
        exportedBy: ec.user.userId || null,
        exportedAt: dateText(ec.user.nowTimestamp)
    }
    const manifestName = fileName.replace(/\.csv$/i, "") + "-manifest.json"
    ec.resource.getLocationReference(folder + manifestName).putText(JSON.stringify(manifest, null, 2))
    for (const row of rows(ROW, {payrollExchangeBatchId: batch.payrollExchangeBatchId, outcome: "ready"}))
        call("update#" + ROW, {payrollExchangeBatchId: row.payrollExchangeBatchId, rowSeqId: row.rowSeqId, outcome: "exported"})
    call("update#" + BATCH, {
        payrollExchangeBatchId: batch.payrollExchangeBatchId,
        transferId: out.transferId || null,
        fileName,
        contentLocation: folder + fileName,
        manifestLocation: folder + manifestName,
        manifestJson: JSON.stringify(Object.assign({}, summary, {manifest}))
    })
}
// one row (or one employee's rows) in a transaction of its own: its outcome, a failure named and the rest going on
function apart(what, work) {
    let outcome = null
    ec.message.pushErrors()
    try {
        ec.transaction.runRequireNew(null, what + " failed", () => {
            outcome = work()
            if (ec.message.hasError()) throw new Error(ec.message.getErrorsString())
        })
    } catch (error) {
        if (!lib.reasonCode(error)) ec.logger.error(what + " failed: " + error.message)
        outcome = {
            outcome: "failed",
            reasonCode: lib.reasonCode(error) || "FAILED",
            message: String(error?.message || error)
                .replace(/^[A-Z][A-Z0-9_]+: /, "")
                .slice(0, 250)
        }
    } finally {
        ec.message.clearErrors()
        ec.message.popErrors()
    }
    return outcome
}
function markRow(row, outcome) {
    call("update#" + ROW, {
        payrollExchangeBatchId: row.payrollExchangeBatchId,
        rowSeqId: row.rowSeqId,
        outcome: outcome.outcome,
        reasonCode: outcome.reasonCode || null,
        message: outcome.message || null,
        resultRef: outcome.resultRef || null
    })
}
function executeHistory(batch) {
    for (const row of rows(ROW, {payrollExchangeBatchId: batch.payrollExchangeBatchId, outcome: "ready"})) {
        const outcome = apart("Payroll history row " + row.rowSeqId + " of exchange " + batch.payrollExchangeBatchId, () => {
            find(RELATIONSHIP, {partyRelationshipId: row.partyRelationshipId}).forUpdate(true).one()
            const state = historyState(row)
            if (state.outcome !== "ready") return state
            call("create#" + HISTORY, {
                partyRelationshipId: row.partyRelationshipId,
                payDate: calendarDateText(row.payDate),
                internalPayroll: "N",
                payAmount: row.grossAmount,
                netPayAmount: row.netAmount,
                currencyUomId: row.currencyUomId
            })
            return {outcome: "applied", resultRef: row.sourceKey}
        })
        markRow(row, outcome)
    }
}
// Results: the period's pay run of the group's external results (one live regular run a group and period: made here, or one an earlier
// batch made while it is not approved yet), then each employee in a transaction of their own: a calculated employment of the run with
// the provider's lines (each its component's published term on the pay date) and totals, and the period's approved inputs of the
// employment taken by the run, so they are finalized with it. The run is in review: it is asked for approval, approved and finalized
// as any run (PayRunDetail).
function executeResults(batch) {
    const group = one(GROUP, {payrollGroupId: batch.payrollGroupId})
    requireExternal(group)
    obligations().requireLive(group)
    obligations().requireProjection(batch.organizationPartyId)
    const period = inputs().periodOf(group, batch.timePeriodId)
    const activeRunKey = group.payrollGroupId + ":" + period.timePeriodId + ":PrkRegular"
    let payrollRunId = null
    ec.transaction.runRequireNew(null, "Making the pay run of exchange " + batch.payrollExchangeBatchId + " failed", () => {
        const existing = find(RUN, {activeRunKey}).forUpdate(true).one()
        if (existing) {
            if (!existing.exchangeBatchId)
                denied("RUN_EXISTS", "Pay run " + existing.payrollRunId + " is this period's regular run, calculated here")
            if (!["PrnDraft", "PrnReview"].includes(existing.statusId))
                denied(
                    "RUN_CLOSED",
                    "Pay run " + existing.payrollRunId + " of this period is approved already: its results stay as approved"
                )
            payrollRunId = existing.payrollRunId
            // whoever imports into the run prepared it too, so they never approve it (as a calculation adds its user)
            const preparers = text(existing.preparedByUserIds)
                .split(",")
                .map(id => id.trim())
                .filter(Boolean)
            if (ec.user.userId && !preparers.includes(ec.user.userId)) {
                preparers.push(ec.user.userId)
                call("update#" + RUN, {payrollRunId, preparedByUserIds: preparers.join(",")})
            }
        } else
            payrollRunId = call("create#" + RUN, {
                organizationPartyId: group.organizationPartyId,
                payrollGroupId: group.payrollGroupId,
                timePeriodId: period.timePeriodId,
                currencyUomId: group.currencyUomId,
                payDate: period.payDate,
                runKindEnumId: "PrkRegular",
                statusId: "PrnReview",
                activeRunKey,
                exchangeBatchId: batch.payrollExchangeBatchId,
                description:
                    "Results of " + (batch.sourceSystem || "the processor") + ", exchange " + batch.payrollExchangeBatchId,
                preparedByUserIds: ec.user.userId || null,
                createdByUserId: ec.user.userId || null,
                createdDate: ec.user.nowTimestamp,
                calculatedDate: ec.user.nowTimestamp
            }).payrollRunId
    })
    const run = one(RUN, {payrollRunId})
    const payMs = ms(dayNoon(period.payDate))
    const byEmployment = {}
    for (const row of rows(ROW, {payrollExchangeBatchId: batch.payrollExchangeBatchId, outcome: "ready"}))
        (byEmployment[row.partyRelationshipId] ||= []).push(row)
    let added = 0
    for (const [partyRelationshipId, lines] of Object.entries(byEmployment)) {
        const outcome = apart(
            "Payroll results of " + partyRelationshipId + " in exchange " + batch.payrollExchangeBatchId,
            () => {
                find(RELATIONSHIP, {partyRelationshipId}).forUpdate(true).one()
                const state = resultsState(group, period.timePeriodId, partyRelationshipId)
                if (state.outcome !== "ready") return state
                const components = Object.fromEntries(
                    rowsIn(
                        COMPONENT,
                        "payrollComponentId",
                        lines.map(line => line.payrollComponentId)
                    ).map(row => [row.payrollComponentId, row])
                )
                const totals = employeeTotals(lines, components)
                if (totals.net.compare(0) < 0) denied("NEGATIVE_NET", "The employee's net is negative")
                const sorted = lines.slice().sort((a, b) => a.rowSeqId.localeCompare(b.rowSeqId))
                const payrollRunEmploymentId = call("create#" + UNIT, {
                    payrollRunId,
                    partyRelationshipId,
                    partyId: lines[0].partyId,
                    statusId: "PruCalculated",
                    grossAmount: totals.gross,
                    deductionAmount: totals.deductions,
                    contributionAmount: totals.contributions,
                    localEmployeeAmount: zero(),
                    localEmployerAmount: zero(),
                    netAmount: totals.net,
                    employerCostAmount: totals.employerCost,
                    segmentCount: 1,
                    splitText: "As calculated by " + (batch.sourceSystem || "the processor"),
                    // the provider's results are the facts the approval binds: they change only by another import
                    sourceRevision: revisionOf({
                        exchange: batch.payrollExchangeBatchId,
                        lines: sorted.map(line => line.payrollComponentId + "=" + String(line.amount))
                    }),
                    attemptCount: 1,
                    calculatedDate: ec.user.nowTimestamp
                }).payrollRunEmploymentId
                sorted.forEach((line, index) => {
                    const component = components[line.payrollComponentId]
                    const statistical = component.componentKindEnumId === "PckStatistical"
                    call("create#" + RESULT, {
                        payrollRunEmploymentId,
                        payrollRunId,
                        payrollComponentId: component.payrollComponentId,
                        componentCode: component.componentCode,
                        resultName: component.componentName || component.componentCode,
                        componentKindEnumId: component.componentKindEnumId,
                        amount: line.amount,
                        currencyUomId: statistical ? null : group.currencyUomId,
                        inTotals: statistical ? "N" : "Y",
                        sequenceNum: index + 1,
                        explanation:
                            "As calculated by " +
                            (batch.sourceSystem || "the processor") +
                            " (payroll exchange " +
                            batch.payrollExchangeBatchId +
                            ", line " +
                            line.lineNumber +
                            ")",
                        payrollComponentTermId: publishedTerm(component.payrollComponentId, payMs)?.payrollComponentTermId || null
                    })
                })
                // the period's approved inputs of the employment, which the processor was sent, finalized with this run
                for (const input of rows(INPUT, {
                    partyRelationshipId,
                    payrollGroupId: group.payrollGroupId,
                    timePeriodId: period.timePeriodId,
                    statusId: "PinApproved"
                }))
                    if (!input.payrollRunId) call("update#" + INPUT, {payrollInputId: input.payrollInputId, payrollRunId})
                return {outcome: "applied", resultRef: payrollRunEmploymentId}
            }
        )
        if (outcome.outcome === "applied") added++
        for (const line of lines) markRow(line, outcome)
    }
    call("update#" + BATCH, {payrollExchangeBatchId: batch.payrollExchangeBatchId, payrollRunId})
    if (added) {
        if (run.statusId !== "PrnReview")
            call("update#" + RUN, {payrollRunId, statusId: "PrnReview", calculatedDate: ec.user.nowTimestamp})
        // a request waiting on the run asked for another population: superseded, as a change of a calculated run supersedes it
        approvals().sourceChanged("PakPayrollRun", payrollRunId, RUN, true)
    }
}

// ===== get#Batch, find#Batches =====
// a user's name, read once a call (the call's own cache)
function userName(userId, cache) {
    if (!userId) return ""
    if (!cache.has(userId)) {
        const account = one("moqui.security.UserAccount", {userId})
        cache.set(userId, account?.userFullName || account?.username || userId)
    }
    return cache.get(userId)
}
function periodText(timePeriodId) {
    const period = timePeriodId ? one(PERIOD, {timePeriodId}) : null
    return period ? calendarDateText(period.fromDate) + " to " + calendarDateText(period.thruDate) : ""
}
function batchAnswer(batch) {
    return {
        payrollExchangeBatchId: batch.payrollExchangeBatchId,
        exchangeKindEnumId: batch.exchangeKindEnumId,
        statusId: batch.statusId,
        rowCount: Number(batch.rowCount || 0),
        readyCount: Number(batch.readyCount || 0),
        appliedCount: Number(batch.appliedCount || 0),
        skippedCount: Number(batch.skippedCount || 0),
        errorCount: Number(batch.errorCount || 0),
        payrollRunId: batch.payrollRunId || null,
        transferId: batch.transferId || null
    }
}
function batchRow(batch, groups, organizations, users) {
    const caps = people.capabilities()
    return Object.assign(batchAnswer(batch), {
        kindText: kindTexts[batch.exchangeKindEnumId] || batch.exchangeKindEnumId,
        statusText: statusTexts[batch.statusId] || batch.statusId,
        organizationPartyId: batch.organizationPartyId,
        organizationName: organizations[batch.organizationPartyId] || batch.organizationPartyId,
        payrollGroupId: batch.payrollGroupId || null,
        groupName: batch.payrollGroupId ? groups[batch.payrollGroupId]?.groupName || batch.payrollGroupId : "",
        timePeriodId: batch.timePeriodId || null,
        periodText: batch.timePeriodId
            ? periodText(batch.timePeriodId)
            : batch.cutoverDate
              ? "Before " + calendarDateText(batch.cutoverDate)
              : "",
        cutoverDateText: batch.cutoverDate ? calendarDateText(batch.cutoverDate) : "",
        currencyUomId: batch.currencyUomId || null,
        sourceSystem: batch.sourceSystem || "",
        fileName: batch.fileName || "",
        expectedCount: batch.expectedCount ?? null,
        expectedGrossText: moneyText(batch.expectedGross, batch.currencyUomId),
        expectedNetText: moneyText(batch.expectedNet, batch.currencyUomId),
        createdByName: userName(batch.createdByUserId, users),
        createdDateText: dateText(batch.createdDate),
        reconciledDateText: dateText(batch.reconciledDate),
        executedByName: userName(batch.executedByUserId, users),
        executedDateText: dateText(batch.executedDate),
        canWork: batch.exchangeKindEnumId === "PxkExport" ? exportsPay(caps) : imports(caps)
    })
}
function getBatch(p) {
    const userScope = readerScope()
    const batch = batchIn(userScope, p.payrollExchangeBatchId)
    const groups = batch.payrollGroupId ? {[batch.payrollGroupId]: one(GROUP, {payrollGroupId: batch.payrollGroupId})} : {}
    const organizations = people.organizationNames([batch.organizationPartyId])
    const row = batchRow(batch, groups, organizations, new Map())
    const open = batch.statusId !== "PxbExecuted"
    const reconciliation = batch.statusId === "PxbPreviewed" ? null : reconciliationOf(batch)
    Object.assign(row, {
        canReconcile: row.canWork && open,
        canExecute:
            row.canWork &&
            batch.statusId === "PxbReconciled" &&
            !!reconciliation &&
            !reconciliation.differences?.length &&
            !(batch.exchangeKindEnumId === "PxkResults" && reconciliation.liveReasons?.length) &&
            Number(batch.readyCount || 0) > 0,
        files:
            batch.contentLocation && row.canWork
                ? {
                      file: {location: batch.contentLocation, fileName: batch.contentLocation.split("/").pop()},
                      manifest: batch.manifestLocation
                          ? {location: batch.manifestLocation, fileName: batch.manifestLocation.split("/").pop()}
                          : null
                  }
                : null
    })
    let query = find(ROW, {payrollExchangeBatchId: batch.payrollExchangeBatchId})
    const outcome = text(p.outcome)
    if (outcome === "problems") query = query.condition("outcome", "in", ["refused", "failed"])
    else if (outcome) query = query.condition("outcome", outcome)
    const rowList = Array.from(query.orderBy("rowSeqId").limit(listCap).list())
    const names = people.personNames(unique(rowList.map(found => found.partyId).filter(Boolean)))
    return {
        batch: row,
        reconciliation,
        rows: rowList.map(found => ({
            rowSeqId: found.rowSeqId,
            lineNumber: found.lineNumber ?? null,
            workerText: found.workerText || "",
            personName: found.partyId ? names[found.partyId] || "" : "",
            componentText: found.componentText || "",
            payDateText: found.payDate ? calendarDateText(found.payDate) : "",
            amountText:
                batch.exchangeKindEnumId === "PxkHistory"
                    ? [moneyText(found.grossAmount, found.currencyUomId), moneyText(found.netAmount, found.currencyUomId)]
                          .filter(Boolean)
                          .join(" gross, ") + (found.netAmount != null ? " net" : "")
                    : found.amount != null
                      ? moneyText(found.amount, found.currencyUomId)
                      : found.quantity != null
                        ? String(found.quantity)
                        : "",
            sourceKey: found.sourceKey || "",
            outcome: found.outcome,
            outcomeText: outcomeTexts[found.outcome] || found.outcome,
            reasonCode: found.reasonCode || "",
            message: found.message || ""
        }))
    }
}
function findBatches(p) {
    const userScope = readerScope()
    if (!userScope.organizationPartyIds.length) return {batches: []}
    let query = find(BATCH).condition("organizationPartyId", "in", userScope.organizationPartyIds)
    const kind = kinds[text(p.exchangeKind)]
    if (kind) query = query.condition("exchangeKindEnumId", kind)
    const found = Array.from(query.orderBy("-createdDate").limit(50).list())
    const groups = Object.fromEntries(
        rowsIn(
            GROUP,
            "payrollGroupId",
            found.map(row => row.payrollGroupId)
        ).map(row => [row.payrollGroupId, row])
    )
    const organizations = people.organizationNames(unique(found.map(row => row.organizationPartyId)))
    const users = new Map()
    return {batches: found.map(row => batchRow(row, groups, organizations, users))}
}

// ===== the transfer targets (the framework's org.moqui.admin.DataTransferServices) =====
// find#ExchangeRuns: the payrollExchange import target's runs (Admin's Imports): the history and results imports of the employers a
// payroll reader reads (a scope key narrows), newest first, as summaries with the parameters that open each in PayrollExchange. None
// otherwise.
function findExchangeRuns(p) {
    let organizationPartyIds
    try {
        organizationPartyIds = readerScope().organizationPartyIds
    } catch (error) {
        return {runList: []}
    }
    if (text(p.scopeKey)) organizationPartyIds = organizationPartyIds.filter(id => id === text(p.scopeKey))
    if (!organizationPartyIds.length) return {runList: []}
    let query = find(BATCH)
        .condition("organizationPartyId", "in", organizationPartyIds)
        .condition("exchangeKindEnumId", "in", ["PxkHistory", "PxkResults"])
    if (p.fromDate != null && p.fromDate !== "")
        query = query.condition("createdDate", "greater-equals", stamp(Number(p.fromDate)))
    if (p.thruDate != null && p.thruDate !== "") query = query.condition("createdDate", "less", stamp(Number(p.thruDate)))
    const found = Array.from(
        query
            .orderBy("-createdDate")
            .limit(Math.min(Number(p.maxRows) || 100, runCap))
            .list()
    )
    const organizations = people.organizationNames(unique(found.map(row => row.organizationPartyId)))
    const users = new Map()
    return {
        runList: found.map(row => ({
            runId: row.payrollExchangeBatchId,
            fileLabel: (row.fileName || "Payroll file") + " (" + (kindTexts[row.exchangeKindEnumId] || "").toLowerCase() + ")",
            scopeKey: row.organizationPartyId,
            scopeTitle: organizations[row.organizationPartyId] || row.organizationPartyId,
            state:
                row.statusId === "PxbExecuted"
                    ? Number(row.errorCount || 0)
                        ? "partial"
                        : "complete"
                    : row.statusId === "PxbReconciled"
                      ? "validated"
                      : "staged",
            stateText: statusTexts[row.statusId] || null,
            startedDate: ms(row.createdDate),
            userName: userName(row.executedByUserId || row.createdByUserId, users),
            rowCount: Number(row.rowCount || 0),
            appliedCount: Number(row.appliedCount || 0),
            errorCount: Number(row.errorCount || 0),
            skippedCount: Number(row.skippedCount || 0),
            ownerParameters: {payrollExchangeBatchId: row.payrollExchangeBatchId}
        }))
    }
}
// find#ExportScopes: the payrollExchangeInputs export target's scopes: each prepared period of the pay groups of the employers a payroll
// exporter (PAYROLL_VIEW and PAYROLL_EDIT) reads, from about a year back to two months ahead, as group:period. None otherwise.
function findExportScopes() {
    let userScope
    try {
        userScope = people.scopeOf()
    } catch (error) {
        return {scopeList: []}
    }
    if (!exportsPay(userScope.capabilities) || !userScope.organizationPartyIds.length) return {scopeList: []}
    const groups = Array.from(find(GROUP).condition("organizationPartyId", "in", userScope.organizationPartyIds).list())
    if (!groups.length) return {scopeList: []}
    const links = rowsIn(
        GROUP_PERIOD,
        "payrollGroupId",
        groups.map(group => group.payrollGroupId)
    )
    const periods = Object.fromEntries(
        rowsIn(
            PERIOD,
            "timePeriodId",
            links.map(link => link.timePeriodId)
        ).map(row => [row.timePeriodId, row])
    )
    const from = nowMs() - 400 * 86400000
    const thru = nowMs() + 62 * 86400000
    const byId = Object.fromEntries(groups.map(group => [group.payrollGroupId, group]))
    return {
        scopeList: links
            .map(link => ({link, period: periods[link.timePeriodId]}))
            .filter(({period}) => period && (ms(period.thruDate) ?? 0) >= from && (ms(period.fromDate) ?? 0) <= thru)
            .sort(
                (a, b) =>
                    String(byId[a.link.payrollGroupId].groupName).localeCompare(String(byId[b.link.payrollGroupId].groupName)) ||
                    (ms(b.period.fromDate) ?? 0) - (ms(a.period.fromDate) ?? 0)
            )
            .slice(0, runCap)
            .map(({link, period}) => ({
                scopeKey: link.payrollGroupId + ":" + link.timePeriodId,
                title:
                    (byId[link.payrollGroupId].groupName || link.payrollGroupId) +
                    ", " +
                    calendarDateText(period.fromDate) +
                    " to " +
                    calendarDateText(period.thruDate)
            }))
    }
}
// The pay inputs file, written as the framework's delimited writer writes it: a cell a spreadsheet would read as a formula written as
// text, a plain number (-10.00, 8) as it is, so a processor reads a negative amount as the number.
function inputsFile(headers, records) {
    return transferLib().writeDelimited(headers, records)
}
// export#InputsTransfer (run#TargetExport): a pay group's period's approved inputs as delimited text, or an export batch's ready rows
// (selection.batch), for a payroll exporter of the group's employer: the fields asked for alone (the amount and the rate a payroll
// reader's, which the registration names). A refusal a person can act on is answered.
function exportInputs(p) {
    const refused = (reasonCode, reason) => ({refused: true, reasonCode, reason, rowCount: 0})
    let userScope
    try {
        userScope = people.scopeOf()
    } catch (error) {
        return refused("PERMISSION_DENIED", "Pay inputs are not available")
    }
    if (!exportsPay(userScope.capabilities))
        return refused("PERMISSION_DENIED", "Exporting pay inputs needs PAYROLL_VIEW and PAYROLL_EDIT")
    const [payrollGroupId, timePeriodId] = text(p.scopeKey).split(":")
    const group = payrollGroupId ? one(GROUP, {payrollGroupId}) : null
    if (
        !group ||
        !userScope.organizationPartyIds.includes(group.organizationPartyId) ||
        !one(GROUP_PERIOD, {payrollGroupId, timePeriodId})
    )
        return refused("SCOPE_INVALID", "Choose a pay group's period")
    const batchId = text(p.selection?.batch)
    let found
    if (batchId) {
        const batch = one(BATCH, {payrollExchangeBatchId: batchId})
        if (
            !batch ||
            batch.exchangeKindEnumId !== "PxkExport" ||
            batch.payrollGroupId !== payrollGroupId ||
            batch.timePeriodId !== timePeriodId
        )
            return refused("BATCH_INVALID", "That payroll exchange is not an export of this period")
        const ids = rows(ROW, {payrollExchangeBatchId: batchId})
            .filter(row => row.outcome === "ready" || row.outcome === "exported")
            .map(row => row.payrollInputId)
        found = rowsIn(INPUT, "payrollInputId", ids).sort(
            (a, b) =>
                String(a.partyRelationshipId).localeCompare(String(b.partyRelationshipId)) ||
                String(calendarDateText(a.inputDate)).localeCompare(String(calendarDateText(b.inputDate))) ||
                String(a.payrollInputId).localeCompare(String(b.payrollInputId))
        )
    } else found = approvedInputs(group, timePeriodId)
    const rowCount = found.length
    if (p.countOnly === true || p.countOnly === "true" || (p.maxRows != null && rowCount > Number(p.maxRows))) return {rowCount}
    const names = people.personNames(unique(found.map(row => row.partyId)))
    const components = Object.fromEntries(
        rowsIn(
            COMPONENT,
            "payrollComponentId",
            found.map(row => row.payrollComponentId)
        ).map(row => [row.payrollComponentId, row])
    )
    const wanted = Array.from(p.fieldList || [])
        .map(String)
        .filter(name => exportColumns.includes(name))
    const records = found.map(input => {
        const record = {
            worker: input.partyId,
            workerName: names[input.partyId] || "",
            employment: input.partyRelationshipId,
            inputKind: inputTypeTexts[input.inputTypeEnumId] || input.inputTypeEnumId,
            component: input.payrollComponentId ? components[input.payrollComponentId]?.componentCode || "" : "",
            inputName: input.inputName || "",
            date: calendarDateText(input.inputDate),
            quantity: input.quantity == null ? "" : String(input.quantity),
            unit: input.quantityUomId || "",
            amount: plainAmount(input.amount),
            currency: input.currencyUomId || "",
            rate: plainAmount(input.rateAmount),
            sourceKey: input.entitlementKey || input.payrollInputId
        }
        return Object.fromEntries(wanted.map(name => [name, record[name]]))
    })
    return {
        rowCount,
        fileText: inputsFile(wanted, records),
        fileName: (
            "PayInputs-" +
            (group.groupName || payrollGroupId) +
            "-" +
            periodText(timePeriodId).slice(0, 10) +
            ".csv"
        ).replace(/[^A-Za-z0-9._-]/g, "_"),
        contentType: "text/csv"
    }
}

const operations = {
    previewBatch,
    reconcileBatch,
    executeBatch,
    getBatch,
    findBatches,
    findExchangeRuns,
    findExportScopes,
    exportInputs
}
function run(op, p) {
    if (!Object.hasOwn(operations, op)) throw new Error("Unknown payroll exchange operation " + op)
    return operations[op](p || {})
}
;({execute: run})
