// People's pay runs (mantle.humanres.PayrollRunServices; IronStone People design §8.1 PayrollRun and PayrollRunEmployment, §8.2
// steps 1 to 5, PayRuns, PayRunDetail; PE-10; impl-people P25): a pay group's run for one of its prepared periods, its population
// employment by employment, the calculation of each employment in its own transaction, review, and approval by a distinct payroll
// approver bound to the exact population, amounts and source revisions.
//
// Pay never leaves its lane (design §1.1, §2): every answer here is a payroll reader's (PAYROLL_VIEW) of an employer in their People
// scope; selecting, calculating and asking approval need PAYROLL_EDIT too; deciding is a payroll approver's (PAYROLL_APPROVE) through
// a People approval of kind PakPayrollRun, never one who selected or calculated the run. Another employer's run is a missing one
// (RECORD_UNAVAILABLE). The approval notice names the group and the period, never a person or an amount.
//
// Calculation changes no money (design §2, §8.3): no invoice, payment or ledger entry is made here; the results are drafts until
// P27's finalization. The legacy payroll services and PayrollAdjustment rows are not read (design §8.4).
//
// The calculation of an employment (design §8.1's sequence; the rules this module decides, recorded in impl-people P25):
// - its days in the group (its primary assignment of the group in effect at noon of the day, P24's groupMembers) are split into
//   segments where its primary assignment, its salary, its pay rates or the structure's lines and their terms change (a mid-period
//   change splits; P25 review, finding 3);
// - each segment is prorated by the group's policy: calendar days, or the working days or scheduled hours of the employee's working
//   schedule (no schedule blocks a part period then: NO_SCHEDULE); the numerator and denominator are shown;
// - each segment computes its structure's published lines in dependency order (PayrollConfiguration.js calculationOrder and
//   computeTerm: the evaluator, each term's own rounding stage) over these named inputs, which win over an assignment's own values
//   and a line's parameters: periodsPerYear (the group's), periodFraction (the segment's share), annualSalary (the salary in effect,
//   made annual by its frequency and multiplied by periodFraction), fullAnnualSalary (not prorated), hourlyRate and pieceRate (the
//   worker pay rates in effect), and the approved inputs of the segment's days: workedHours, paidLeaveHours, unpaidLeaveHours,
//   pieces and reimbursement (zero when there are none);
// - a fixed amount is prorated by the segment's share in a part period when its term says so (PayrollComponentTerm.prorated, by
//   default for an earning, a deduction and an employer contribution; the user's call of Nov 12, 2026), else paid whole;
// - a component that reads a segment's input (directly or through a component it depends on, a prorated fixed amount included) is
//   summed over the segments; one that reads none (a fixed amount paid whole, a constant formula) is computed once, from the last
//   segment;
// - an input of time is the segment's of its day, and one on a day the group does not pay the employee blocks (INPUT_OUTSIDE_DAYS);
//   a reimbursement, owed whatever its day, is paid with the last segment;
// - an approved adjustment or advance recovery adds its amount to its component's line;
// - each money line is rounded to the currency (ec.l10n.roundCurrency) once, after its segments and adjustments: a payslip line is
//   money, so gross, deductions, contributions and net are sums of rounded lines; a statistical value keeps its precision and unit
//   and enters no total;
// - the group's localization is called once with the period's lines (its items are rounded by it), then net and employer cost; a
//   negative net blocks the employment (NEGATIVE_NET).
// A blocking finding (missing setup, a missing input, a cycle, a currency mismatch) leaves that employment in error with its reason
// code while the others are calculated.
//
// impl-people P26 (design §8.2 corrections, §8.1 Payslip; PE-10): the kinds of run and the slips.
// - A regular run is one a group and period (activeRunKey). An off-cycle run (any number a period, any pay date: a slip of the same
//   day keeps its own identity) pays the approved adjustments of the period no live run took, for the employments that have them
//   or those named, with no salary or structure line. A correction run (create#Correction, one at a time a slip) recalculates the
//   original slip's employment as it is now, with the inputs the original and its corrections took and those approved since, and
//   pays the change: its lines are the difference from what the original and the corrections before it paid (a negative change is
//   to recover), and the original stays.
// - Inputs a live run of another kind took are that run's: a run does not pay them again and is not blocked by them.
// - When a run is approved its calculated employments become slips (PayrollResults.js makeSlips: preview slips in preview mode);
//   when its approval is taken back (selected or calculated again) its preview slips are withdrawn. Calculating an approved run
//   with nothing to calculate leaves its approval as it is (P25 review's finding).
const people = ec.resource.script("component://mr-mantle/service/mantle/humanres/People.js")
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const {find, one, rows, denied, call, dateText} = lib
const configuration = () => ec.resource.script("component://mr-mantle/service/mantle/humanres/PayrollConfiguration.js")
const inputs = () => ec.resource.script("component://mr-mantle/service/mantle/humanres/PayInputs.js")
const approvals = () => ec.resource.script("component://mr-mantle/service/mantle/humanres/Approvals.js")
const schedules = () => ec.resource.script("component://mr-mantle/service/mantle/humanres/Schedules.js")
const slips = () => ec.resource.script("component://mr-mantle/service/mantle/humanres/PayrollResults.js")

const RUN = "mantle.humanres.payroll.PayrollRun"
const UNIT = "mantle.humanres.payroll.PayrollRunEmployment"
const RESULT = "mantle.humanres.payroll.PayrollRunResult"
const GROUP = "mantle.humanres.payroll.PayrollGroup"
const ASSIGNMENT = "mantle.humanres.payroll.PayrollAssignment"
const STRUCTURE = "mantle.humanres.payroll.PayrollStructure"
const LINE = "mantle.humanres.payroll.PayrollStructureComponent"
const COMPONENT = "mantle.humanres.payroll.PayrollComponent"
const TERM = "mantle.humanres.payroll.PayrollComponentTerm"
const LOCALIZATION = "mantle.humanres.payroll.PayrollLocalization"
const PROFILE = "mantle.humanres.payroll.PayrollTaxProfile"
const INPUT = "mantle.humanres.payroll.PayrollInput"
const SALARY = "mantle.humanres.employment.EmploymentSalary"
const RATE = "mantle.humanres.rate.RateAmount"
const RELATIONSHIP = "mantle.party.PartyRelationship"
const PERIOD = "mantle.party.time.TimePeriod"
const SLIP = "mantle.humanres.payroll.Payslip"
const KIND = "PakPayrollRun"

const day = 24 * 60 * 60 * 1000
const listCap = 2000
const batchDefault = 100
const batchCap = 500
// the most employments a run's population holds: a group with more is refused (POPULATION_TOO_LARGE), never paid in part
const populationCap = 10000
// a calculation call stops taking new employments after this long; the rest stay pending for the next call
const timeBudgetMs = 60 * 1000

const kindTexts = {PrkRegular: "Regular", PrkOffCycle: "Off-cycle", PrkCorrection: "Correction"}
const runStateTexts = {
    PrnDraft: "Draft",
    PrnCalculating: "Calculating",
    PrnReview: "Review",
    PrnApproved: "Approved",
    PrnFinalizing: "Finalizing",
    PrnFinalized: "Finalized",
    PrnCancelled: "Cancelled"
}
const unitStates = {
    PruPending: ["pending", "Pending"],
    PruCalculated: ["calculated", "Calculated"],
    PruError: ["error", "Error"],
    PruExcluded: ["excluded", "Excluded"],
    PruFinalized: ["finalized", "Finalized"]
}
const liveRunStatuses = ["PrnDraft", "PrnCalculating", "PrnReview", "PrnApproved", "PrnFinalizing", "PrnFinalized"]
const changeableStatuses = ["PrnDraft", "PrnCalculating", "PrnReview", "PrnApproved"]
const componentKinds = {
    PckEarning: "Earning",
    PckDeduction: "Deduction",
    PckContribution: "Employer contribution",
    PckStatistical: "Statistical"
}
// a salary's periods a year by its frequency; a week-based salary only in a group of the same frequency (its own explicit
// periodsPerYear), so no 52 or 26 is assumed (design §8.1: no implicit calendar)
const calendarFrequencies = {PayrollYear: 1, PayrollSemiYear: 2, PayrollQuarter: 4, PayrollMonth: 12, PayrollSemiMonth: 24}
// the inputs that change within a period, so a component reading them is summed over its segments
const segmentNames = [
    "periodFraction",
    "annualSalary",
    "fullAnnualSalary",
    "hourlyRate",
    "pieceRate",
    "workedHours",
    "paidLeaveHours",
    "unpaidLeaveHours",
    "pieces",
    "reimbursement"
]
const timeInputNames = ["workedHours", "paidLeaveHours", "unpaidLeaveHours", "pieces"]

const ms = lib.ms
const text = value => String(value ?? "").trim()
const blank = value => value == null || String(value).trim() === ""
const nowMs = () => ms(ec.user.nowTimestamp)
const unique = people.unique
const zero = () => toDecimal(0)
const decimalOf = value => (value == null || value === "" ? zero() : toDecimal(value))
const openAt = (row, at) => (ms(row.fromDate) ?? -Infinity) <= at && (ms(row.thruDate) ?? Infinity) > at
const voided = row => row.thruDate != null && ms(row.thruDate) <= (ms(row.fromDate) ?? -Infinity)
const splitIds = value =>
    blank(value)
        ? []
        : unique((Array.isArray(value) ? value : String(value).split(/[\s,;]+/)).map(id => text(id)).filter(Boolean))
const rowsIn = (entityName, field, ids) => (ids.length ? Array.from(find(entityName).condition(field, "in", ids).list()) : [])
const moneyText = (amount, currencyUomId) =>
    amount == null ? "" : currencyUomId ? ec.l10n.formatCurrency(amount, currencyUomId) : String(amount)
function shortDay(dayText) {
    const [y, m, d] = dayText.split("-").map(Number)
    return ec.l10n.format(new Date(Date.UTC(y, m - 1, d, 12)), "d MMM", null, "UTC")
}

// a fingerprint short enough for an approval's sourceRevision (63 characters)
const revisionText = value => String(lib.hash(value)).slice(0, 48)

// ===== access =====
function readerScope() {
    const userScope = people.scopeOf()
    if (!userScope.capabilities.payrollView) denied("PERMISSION_DENIED", "Pay runs are not available")
    return userScope
}
const edits = userScope => !!(userScope.capabilities.payrollView && userScope.capabilities.payrollEdit)
function editorScope() {
    const userScope = people.scopeOf()
    if (!edits(userScope)) denied("PERMISSION_DENIED", "Preparing a pay run needs PAYROLL_VIEW and PAYROLL_EDIT")
    return userScope
}
function runIn(userScope, payrollRunId) {
    const id = text(payrollRunId)
    const run = id ? one(RUN, {payrollRunId: id}) : null
    if (!run || !userScope.organizationPartyIds.includes(run.organizationPartyId))
        denied("RECORD_UNAVAILABLE", "Pay run " + id + " is not available")
    return run
}
const groupOfRun = run => one(GROUP, {payrollGroupId: run.payrollGroupId})
function withPreparer(run) {
    const userIds = splitIds(run.preparedByUserIds)
    if (ec.user.userId && !userIds.includes(ec.user.userId)) userIds.push(ec.user.userId)
    return userIds.join(",") || null
}
// P26 review: an approved run one of whose slips a correction run (not cancelled) corrects keeps its approval: its slips stand as
// the originals the corrections pay the change from, so a later change is corrected too, never recalculated into the original.
function checkUncorrected(run) {
    if (run.statusId !== "PrnApproved") return
    const slipIds = rows(SLIP, {payrollRunId: run.payrollRunId}).map(row => row.payslipId)
    const correcting = rowsIn(RUN, "correctsPayslipId", slipIds).find(row => row.statusId !== "PrnCancelled")
    if (correcting)
        denied(
            "RUN_CORRECTED",
            "Pay run " +
                correcting.payrollRunId +
                " corrects a payslip of this approved run, so the run stays as approved: correct its payslips instead"
        )
}
function checkChangeable(run) {
    if (!changeableStatuses.includes(run.statusId))
        denied(
            "RUN_CLOSED",
            "This pay run is " + (runStateTexts[run.statusId] || run.statusId).toLowerCase() + "; it is not changed"
        )
}

// ===== labels =====
function periodTextOf(timePeriodId) {
    const period = timePeriodId ? one(PERIOD, {timePeriodId}) : null
    return period ? lib.calendarDateText(period.fromDate) + " to " + lib.calendarDateText(period.thruDate) : timePeriodId || ""
}
// The group's name and the period, what a notice and a list name a run by: never a person or an amount.
function runLabel(run) {
    const group = groupOfRun(run)
    return {groupName: group?.groupName || run.payrollGroupId, periodText: periodTextOf(run.timePeriodId)}
}

// ===== create#Run =====
// A run of a pay group in the caller's payroll scope for one of its prepared periods: the group's employer and currency, the
// period's pay date unless another is given, a regular run (the kinds off-cycle and correction wait on payslips' corrections:
// KIND_NOT_AVAILABLE); its population selected at once. Refused: a period whose inputs another live run took (INPUTS_CONSUMED) or
// with a live regular run already (RUN_EXISTS), an ended group (GROUP_ENDED). An operation key answers a retry with the first run.
function createRun(p) {
    const userScope = editorScope()
    const group = one(GROUP, {payrollGroupId: text(p.payrollGroupId)})
    if (!group || !userScope.organizationPartyIds.includes(group.organizationPartyId))
        denied("RECORD_UNAVAILABLE", "Pay group " + text(p.payrollGroupId) + " is not available")
    const operationKey = text(p.operationKey) || null
    if (operationKey) {
        const first = one(RUN, {operationKey, createdByUserId: ec.user.userId})
        if (first) return {payrollRunId: first.payrollRunId, repeated: true}
    }
    const period = inputs().periodOf(group, p.timePeriodId)
    const zone = inputs().zoneOf(group)
    if ((ms(group.thruDate) ?? Infinity) <= inputs().dayStart(period.fromDay, zone))
        denied("GROUP_ENDED", "This pay group ended before the period")
    const runKindEnumId = text(p.runKindEnumId) || "PrkRegular"
    if (!kindTexts[runKindEnumId]) denied("KIND_INVALID", "Choose the kind of run")
    // P26: a correction run is made from the slip it corrects (create#Correction)
    if (runKindEnumId === "PrkCorrection")
        denied("KIND_NOT_AVAILABLE", "A correction run is made from the payslip it corrects: Correct pay on the payslip")
    const regular = runKindEnumId === "PrkRegular"
    let activeRunKey = null
    let initialIds = null
    if (regular) {
        // the period's inputs a live regular run took are not paid again by another
        const taken = Array.from(
            find(INPUT)
                .condition({payrollGroupId: group.payrollGroupId, timePeriodId: period.timePeriodId})
                .condition("payrollRunId", "is-not-null", null)
                .selectField("payrollRunId")
                .distinct(true)
                .list()
        ).map(row => row.payrollRunId)
        const takenBy = rowsIn(RUN, "payrollRunId", taken).filter(
            row => row.statusId !== "PrnCancelled" && row.runKindEnumId === "PrkRegular"
        )
        if (takenBy.length)
            denied(
                "INPUTS_CONSUMED",
                "The pay inputs of " +
                    period.text +
                    " are taken by pay run " +
                    takenBy[0].payrollRunId +
                    "; they are not paid twice"
            )
        activeRunKey = group.payrollGroupId + ":" + period.timePeriodId + ":" + runKindEnumId
        const existing = one(RUN, {activeRunKey})
        if (existing) denied("RUN_EXISTS", "Pay run " + existing.payrollRunId + " is this period's regular run already")
    } else {
        // P26: an off-cycle run pays the approved adjustments of the period no run took, for the employments that have them (or
        // those named)
        initialIds = unpaidAdjustmentOwners(group, period, splitIds(p.partyRelationshipIds))
        if (!initialIds.length)
            denied("NOTHING_TO_PAY", "No approved adjustment of the period waits to be paid: an off-cycle run pays those alone")
    }
    const payDay = blank(p.payDate) ? period.payDate : dayOf(p.payDate)
    const created = call("create#" + RUN, {
        organizationPartyId: group.organizationPartyId,
        payrollGroupId: group.payrollGroupId,
        timePeriodId: period.timePeriodId,
        currencyUomId: group.currencyUomId,
        payDate: payDay,
        runKindEnumId,
        statusId: "PrnDraft",
        cutoffDate: blank(p.cutoffDate) ? null : new Date(ec.user.timestampMillis(p.cutoffDate)),
        activeRunKey,
        description: text(p.description) || null,
        preparedByUserIds: ec.user.userId || null,
        operationKey,
        createdByUserId: ec.user.userId,
        createdDate: ec.user.nowTimestamp
    })
    const run = one(RUN, {payrollRunId: created.payrollRunId})
    const selected = syncPopulation(run, group, period, zone, initialIds)
    return {payrollRunId: run.payrollRunId, repeated: false, selectedCount: selected.addedCount}
}
// The employments of a group's period with an approved adjustment (an input to a component) no run took: an off-cycle run's
// population; wanted narrows it.
function unpaidAdjustmentOwners(group, period, wanted) {
    const query = find(INPUT)
        .condition({payrollGroupId: group.payrollGroupId, timePeriodId: period.timePeriodId, statusId: "PinApproved"})
        .condition("payrollComponentId", "is-not-null", null)
        .condition("payrollRunId", "is-null", null)
    if (wanted.length) query.condition("partyRelationshipId", "in", wanted)
    return unique(
        Array.from(query.selectField("partyRelationshipId").distinct(true).limit(populationCap).list()).map(
            row => row.partyRelationshipId
        )
    )
}
const dayOf = value => {
    const found = text(value)
    if (/^\d{4}-\d{2}-\d{2}/.test(found)) return found.slice(0, 10)
    return ec.l10n.format(new Date(ec.user.timestampMillis(value)), "yyyy-MM-dd")
}

// ===== select#Employments =====
// The population kept in step with the group: an employment the group pays on a day of the period joins as pending, one it no
// longer pays (and has not been excluded) leaves; excluded employments stay with their reason. A unit leaving or changing state
// releases the inputs its calculation took.
// P26: an off-cycle or a correction run keeps the population it was made with (initialIds when made): its employments leave when the
// group no longer pays them in the period, and none joins.
function syncPopulation(run, group, period, zone, initialIds = null) {
    const regular = run.runKindEnumId === "PrkRegular"
    const wanted = regular
        ? null
        : initialIds || rows(UNIT, {payrollRunId: run.payrollRunId}).map(unit => unit.partyRelationshipId)
    const members = inputs().groupMembers(group, period, zone, wanted, populationCap)
    if (members.truncated)
        denied(
            "POPULATION_TOO_LARGE",
            "The pay group pays more than " + populationCap + " employees in the period; split it into smaller groups"
        )
    const memberIds = new Set(members.map(member => member.partyRelationshipId))
    const units = rows(UNIT, {payrollRunId: run.payrollRunId})
    const byEmployment = Object.fromEntries(units.map(unit => [unit.partyRelationshipId, unit]))
    let addedCount = 0
    let removedCount = 0
    for (const member of members) {
        if (byEmployment[member.partyRelationshipId]) continue
        call("create#" + UNIT, {
            payrollRunId: run.payrollRunId,
            partyRelationshipId: member.partyRelationshipId,
            partyId: member.partyId,
            statusId: "PruPending",
            attemptCount: 0
        })
        addedCount++
    }
    for (const unit of units) {
        if (memberIds.has(unit.partyRelationshipId) || unit.statusId === "PruExcluded") continue
        clearUnit(run, unit)
        call("delete#" + UNIT, {payrollRunEmploymentId: unit.payrollRunEmploymentId})
        removedCount++
    }
    return {addedCount, removedCount, memberCount: members.length}
}
// a unit's draft results removed and the inputs its calculation took released
function clearUnit(run, unit) {
    for (const result of rows(RESULT, {payrollRunEmploymentId: unit.payrollRunEmploymentId}))
        call("delete#" + RESULT, {payrollRunResultId: result.payrollRunResultId})
    for (const input of rows(INPUT, {payrollRunId: run.payrollRunId, partyRelationshipId: unit.partyRelationshipId}))
        call("update#" + INPUT, {payrollInputId: input.payrollInputId, payrollRunId: null})
}
// A changed run (population, pay date, a calculation) is reviewed again: an approval it had no longer holds and a request waiting
// is superseded.
function reopenForChange(run, statusId) {
    // P26: an approval taken back withdraws the run's preview slips
    if (run.statusId === "PrnApproved") slips().withdrawSlips(run.payrollRunId, "The run's approval was taken back")
    call("update#" + RUN, {
        payrollRunId: run.payrollRunId,
        statusId,
        preparedByUserIds: withPreparer(run),
        approvedRevision: null,
        approvedDate: null
    })
    approvals().sourceChanged(KIND, run.payrollRunId, RUN, true)
}
// The population brought in step with the group (refresh), employments excluded with a reason (excludeIds), or included again
// (includeIds); the pay date changed (payDate). Each is a change the approval binds, so the run is reviewed again.
function selectEmployments(p) {
    const userScope = editorScope()
    let run = runIn(userScope, p.payrollRunId)
    checkChangeable(run)
    const group = groupOfRun(run)
    const period = inputs().periodOf(group, run.timePeriodId)
    const zone = inputs().zoneOf(group)
    const excludeIds = splitIds(p.excludeIds)
    const includeIds = splitIds(p.includeIds)
    const reason = text(p.exclusionReason)
    if (excludeIds.length && !reason) denied("REASON_REQUIRED", "Say why the employees are left out of this run")
    // P26 review: selecting an approved run takes its approval back, which a corrected one keeps
    checkUncorrected(run)
    const synced = syncPopulation(run, group, period, zone)
    const units = Object.fromEntries(rows(UNIT, {payrollRunId: run.payrollRunId}).map(unit => [unit.partyRelationshipId, unit]))
    let excludedCount = 0
    let includedCount = 0
    for (const id of excludeIds) {
        const unit = units[id]
        if (!unit) denied("RECORD_UNAVAILABLE", "Employment " + id + " is not in this run")
        if (unit.statusId === "PruExcluded") continue
        clearUnit(run, unit)
        call("update#" + UNIT, {
            payrollRunEmploymentId: unit.payrollRunEmploymentId,
            statusId: "PruExcluded",
            statusId_changeReason: reason,
            exclusionReason: reason,
            reasonCode: null,
            message: null,
            grossAmount: null,
            deductionAmount: null,
            contributionAmount: null,
            localEmployeeAmount: null,
            localEmployerAmount: null,
            netAmount: null,
            employerCostAmount: null,
            sourceRevision: null
        })
        excludedCount++
    }
    for (const id of includeIds) {
        const unit = units[id]
        if (!unit) denied("RECORD_UNAVAILABLE", "Employment " + id + " is not in this run")
        if (unit.statusId !== "PruExcluded") continue
        call("update#" + UNIT, {
            payrollRunEmploymentId: unit.payrollRunEmploymentId,
            statusId: "PruPending",
            exclusionReason: null
        })
        includedCount++
    }
    const changes = {}
    if (!blank(p.payDate)) {
        const payDay = dayOf(p.payDate)
        if (payDay !== lib.calendarDateText(run.payDate)) changes.payDate = payDay
    }
    if (Object.keys(changes).length) call("update#" + RUN, Object.assign({payrollRunId: run.payrollRunId}, changes))
    run = one(RUN, {payrollRunId: run.payrollRunId})
    const changed = synced.addedCount || synced.removedCount || excludedCount || includedCount || Object.keys(changes).length
    if (changed || run.statusId === "PrnApproved") {
        const pending = rows(UNIT, {payrollRunId: run.payrollRunId}).some(unit => unit.statusId === "PruPending")
        reopenForChange(run, pending ? "PrnDraft" : "PrnReview")
    }
    return {
        payrollRunId: run.payrollRunId,
        addedCount: synced.addedCount,
        removedCount: synced.removedCount,
        excludedCount,
        includedCount
    }
}

// ===== an employment's facts =====
function periodFacts(run) {
    const group = groupOfRun(run)
    const period = inputs().periodOf(group, run.timePeriodId)
    const zone = inputs().zoneOf(group)
    return {group, period, zone, periodDays: inputs().daysFrom(period.fromDay, period.thruDay)}
}
const noonOf = (dayText, zone) => inputs().dayStart(dayText, zone) + day / 2
const groupBy = (list, field) => {
    const out = {}
    for (const row of list) (out[row[field]] ||= []).push(row)
    return out
}
// rows by an id list, a thousand ids a query
function rowsInChunks(entityName, field, ids, filter = null) {
    const out = []
    for (let index = 0; index < ids.length; index += 1000) {
        const query = find(entityName).condition(field, "in", ids.slice(index, index + 1000))
        if (filter) filter(query)
        out.push(...Array.from(query.list()))
    }
    return out
}
// The rows the calculation of a run's employments reads, for many employments at once (P25 review: a run's revision and its stale
// check read them in a few queries for the whole run, not a few for each employee): each employment's relationship and its days
// in the group (P24's groupMembers), its primary assignments of the group, its salaries, the person's worker pay rates
// (RaprVendor, not a project's: an hour's TF_hr and a piece's OTH_ea, the employer's or general), the inputs of the group's period
// (approved, and those still waiting, which are only noted) and its tax profiles; shared, the structures, their lines and their
// components' published terms, and the other live runs that took inputs. forUnit answers one employment's.
function factsOf(run, facts, units) {
    const {group, period, zone} = facts
    const ids = unique(units.map(unit => unit.partyRelationshipId))
    const few = ids.length <= 200
    const members = new Map(
        inputs()
            .groupMembers(group, period, zone, few ? ids : null, populationCap)
            .map(member => [member.partyRelationshipId, member])
    )
    const relationships = Object.fromEntries(
        rowsInChunks(RELATIONSHIP, "partyRelationshipId", ids).map(row => [row.partyRelationshipId, row])
    )
    const assignments = groupBy(
        rowsInChunks(ASSIGNMENT, "partyRelationshipId", ids, query =>
            query.condition("payrollGroupId", group.payrollGroupId)
        ).filter(row => row.isPrimary !== "N" && !voided(row)),
        "partyRelationshipId"
    )
    const salaries = groupBy(
        rowsInChunks(SALARY, "partyRelationshipId", ids).filter(row => !voided(row)),
        "partyRelationshipId"
    )
    const partyIds = unique(Object.values(relationships).map(row => row.fromPartyId))
    const rates = groupBy(
        rowsInChunks(RATE, "partyId", partyIds, query =>
            query.condition("ratePurposeEnumId", "RaprVendor").condition("workEffortId", "is-null", null)
        ).filter(row => !row.organizationPartyId || row.organizationPartyId === group.organizationPartyId),
        "partyId"
    )
    const periodInputs = groupBy(
        few
            ? rowsInChunks(INPUT, "partyRelationshipId", ids, query =>
                  query.condition({payrollGroupId: group.payrollGroupId, timePeriodId: run.timePeriodId})
              )
            : rows(INPUT, {payrollGroupId: group.payrollGroupId, timePeriodId: run.timePeriodId}),
        "partyRelationshipId"
    )
    const profiles = groupBy(rowsInChunks(PROFILE, "partyRelationshipId", ids), "partyRelationshipId")
    const structureIds = unique(
        Object.values(assignments)
            .flat()
            .map(row => row.payrollStructureId)
            .filter(Boolean)
    )
    const structures = Object.fromEntries(
        rowsIn(STRUCTURE, "payrollStructureId", structureIds).map(row => [row.payrollStructureId, row])
    )
    const lines = groupBy(rowsIn(LINE, "payrollStructureId", structureIds), "payrollStructureId")
    const componentIds = unique(
        Object.values(lines)
            .flat()
            .map(line => line.payrollComponentId)
    )
    const terms = groupBy(
        rowsIn(TERM, "payrollComponentId", componentIds).filter(term => term.statusId === "PtsPublished"),
        "payrollComponentId"
    )
    const otherRunIds = unique(
        Object.values(periodInputs)
            .flat()
            .map(row => row.payrollRunId)
            .filter(id => id && id !== run.payrollRunId)
    )
    const liveOthers = new Set(
        rowsIn(RUN, "payrollRunId", otherRunIds)
            .filter(row => row.statusId !== "PrnCancelled")
            .map(row => row.payrollRunId)
    )
    // P26: the runs whose inputs this run's calculation counts as its own: itself, and for a correction the original's and its
    // corrections' (what was paid); an off-cycle run pays adjustments alone
    const before = run.correctsPayslipId ? correctionBase(run) : null
    const ownRunIds = new Set([run.payrollRunId].concat(before ? before.runIds : []))
    const shared = {
        structures,
        lines,
        terms,
        liveOthers,
        ownRunIds,
        before,
        // P26 review: a correction of an off-cycle slip pays the change of its adjustments alone, never a salary or structure line
        adjustmentsOnly: run.runKindEnumId === "PrkOffCycle" || before?.original?.runKindEnumId === "PrkOffCycle"
    }
    return {
        members,
        forUnit(unitRow) {
            const id = unitRow.partyRelationshipId
            const relationship = relationships[id] || null
            return {
                relationship,
                member: members.get(id) || null,
                assignments: assignments[id] || [],
                salaries: salaries[id] || [],
                rates: (relationship && rates[relationship.fromPartyId]) || [],
                periodInputs: periodInputs[id] || [],
                profiles: profiles[id] || [],
                shared
            }
        }
    }
}
// the inputs a run takes: approved, not finalized, not taken by another live run (P26: a correction counts the inputs its original
// and that original's corrections took as its own; an off-cycle run takes adjustments alone)
function takenInputs(run, found) {
    const {liveOthers, ownRunIds, adjustmentsOnly} = found.shared
    const periodInputs = found.periodInputs
    const approved = periodInputs.filter(
        row => row.statusId === "PinApproved" && (!adjustmentsOnly || (row.payrollComponentId && row.amount != null))
    )
    const elsewhere = row => row.payrollRunId && !ownRunIds.has(row.payrollRunId) && liveOthers.has(row.payrollRunId)
    return {
        taken: approved.filter(row => !elsewhere(row)),
        elsewhere: approved.filter(elsewhere),
        waiting: periodInputs.filter(row => row.statusId === "PinProposed")
    }
}
// A correction run's base: what its original slip and the corrections before it paid, and their runs (PayrollResults.js).
function correctionBase(run) {
    const original = one(SLIP, {payslipId: run.correctsPayslipId})
    if (!original) return {missing: true, runIds: [], lines: {}, totals: {}, key: "missing"}
    return Object.assign({original}, slips().paidBefore(original, run.payrollRunId))
}
// A structure's lines in effect at a moment for an assignment: published, within their dates (a line's own, else the
// structure's), an elective one only when the assignment elects it; and a component's published term then.
function linesIn(structure, found, at, assignment) {
    const elected = splitIds(assignment.electedComponentIds)
    return (found.shared.lines[structure.payrollStructureId] || []).filter(line => {
        if (line.statusId !== "PtsPublished") return false
        const from = ms(line.fromDate) ?? ms(structure.fromDate) ?? -Infinity
        if (from > at || (ms(line.thruDate) ?? Infinity) <= at) return false
        return line.eligibilityEnumId !== "PleElected" || elected.includes(line.payrollComponentId)
    })
}
const termIn = (found, payrollComponentId, at) =>
    (found.shared.terms[payrollComponentId] || []).find(term => openAt(term, at)) || null
// The rules a day is calculated by (P25 review, finding 3): the structure in effect or not, its lines and each line's term, so a
// term or a line that changes within the period splits it as a salary does.
function rulesKey(assignment, found, at) {
    const structure = found.shared.structures[assignment.payrollStructureId]
    if (!structure) return "none"
    const open = structure.statusId === "PtsPublished" && openAt(structure, at)
    return (
        (open ? "open:" : "closed:") +
        linesIn(structure, found, at, assignment)
            .map(
                line =>
                    line.payrollStructureComponentId +
                    "=" +
                    (termIn(found, line.payrollComponentId, at)?.payrollComponentTermId || "")
            )
            .sort()
            .join(",")
    )
}
// What an employment's results were calculated from, as one fingerprint: its days in the group and the employment's dates, its
// assignments, salaries and pay rates (each row's last change), the inputs it takes (their kind, quantity, amount, day and
// component), the structures' lines and their components' terms, the group's policy, the employment's tax profiles, and for a part
// period prorated by the schedule the scheduled hours of each day. A change of any makes the results stale and an approval of them
// no longer good. For many employments at once: a Map of payrollRunEmploymentId to fingerprint.
function fingerprintsOf(run, facts, units, loaded = null) {
    const out = new Map()
    if (!units.length) return out
    const {group, zone, periodDays} = facts
    const all = loaded || factsOf(run, facts, units)
    const stamp = row => ms(row?.lastUpdatedStamp) ?? 0
    const founds = units.map(unit => all.forUnit(unit))
    // the scheduled hours of a part period, when the group prorates by the schedule
    const planned = {}
    if (group.prorationEnumId === "PprWorkingDays" || group.prorationEnumId === "PprHours") {
        const partial = founds
            .filter(found => found.member)
            .filter(found => {
                const segments = segmentsOf(found.member, found, zone)
                return segments.length > 1 || found.member.days.length < periodDays.length
            })
            .map(found => found.member.partyId)
        if (partial.length)
            try {
                Object.assign(planned, schedules().scheduledDays(unique(partial), periodDays))
            } catch (error) {
                ec.logger.error(
                    "The working schedules of a pay run's employees were not read for its fingerprint: " + error.message
                )
            }
    }
    units.forEach((unit, index) => {
        const found = founds[index]
        const structureIds = unique(found.assignments.map(row => row.payrollStructureId))
        const lines = structureIds.flatMap(id => found.shared.lines[id] || [])
        const terms = unique(lines.map(line => line.payrollComponentId)).flatMap(id => found.shared.terms[id] || [])
        const {taken} = takenInputs(run, found)
        const scheduled = found.member && planned[found.member.partyId]
        const value = {
            group: stamp(group),
            employment: found.relationship
                ? (ms(found.relationship.fromDate) ?? "") + ":" + (ms(found.relationship.thruDate) ?? "")
                : "",
            days: found.member ? found.member.days.join(",") : "",
            assignments: found.assignments.map(row => row.payrollAssignmentId + ":" + stamp(row)).sort(),
            salaries: found.salaries.map(row => ms(row.fromDate) + ":" + stamp(row)).sort(),
            rates: found.rates.map(row => row.rateAmountId + ":" + stamp(row)).sort(),
            inputs: taken
                .map(row =>
                    [
                        row.payrollInputId,
                        row.inputTypeEnumId,
                        row.quantity,
                        row.amount,
                        lib.calendarDateText(row.inputDate),
                        row.payrollComponentId
                    ]
                        .map(part => (part == null ? "" : String(part)))
                        .join("|")
                )
                .sort(),
            structures: structureIds
                .map(id => found.shared.structures[id])
                .filter(Boolean)
                .map(row => row.payrollStructureId + ":" + stamp(row))
                .sort(),
            lines: lines.map(row => row.payrollStructureComponentId + ":" + stamp(row)).sort(),
            terms: terms.map(row => row.payrollComponentTermId + ":" + stamp(row)).sort(),
            profiles: found.profiles.map(row => row.payrollTaxProfileId + ":" + stamp(row)).sort(),
            schedule: scheduled ? periodDays.map(dayText => String(scheduled[dayText]?.hours ?? "")).join(",") : "",
            // P26: a correction's base, the slips it pays the change from
            corrects: found.shared.before ? found.shared.before.key : ""
        }
        out.set(unit.payrollRunEmploymentId, revisionText(value))
    })
    return out
}

// ===== an employment calculated =====
const failure = (errorCode, message) => ({ok: false, errorCode, message})
function salaryPeriodsPerYear(salary, group) {
    const id = salary.timePeriodTypeId
    if (calendarFrequencies[id]) return calendarFrequencies[id]
    if (id && id === group.timePeriodTypeId && group.periodsPerYear != null) return group.periodsPerYear
    return null
}
const quotient = (numerator, denominator) => toDecimal(String(numerator)).divide(toDecimal(String(denominator)), 20)
// The segments of an employment's days: consecutive days with one assignment, salary, pair of pay rates and set of rules (the
// structure's lines and their terms in effect).
function segmentsOf(member, found, zone) {
    const segments = []
    for (const dayText of member.days) {
        const noon = noonOf(dayText, zone)
        const assignment = found.assignments.find(row => openAt(row, noon)) || null
        const salary = found.salaries.find(row => openAt(row, noon)) || null
        const hourly =
            found.rates
                .filter(row => openAt(row, noon) && (row.timePeriodUomId === "TF_hr" || !row.timePeriodUomId))
                .sort((a, b) => (ms(b.fromDate) ?? 0) - (ms(a.fromDate) ?? 0))[0] || null
        const piece =
            found.rates
                .filter(row => openAt(row, noon) && row.timePeriodUomId === "OTH_ea")
                .sort((a, b) => (ms(b.fromDate) ?? 0) - (ms(a.fromDate) ?? 0))[0] || null
        const key = [
            assignment?.payrollAssignmentId,
            ms(salary?.fromDate),
            hourly?.rateAmountId,
            piece?.rateAmountId,
            assignment ? rulesKey(assignment, found, noon) : ""
        ].join("|")
        const last = segments[segments.length - 1]
        if (last && last.key === key && inputs().addDays(last.days[last.days.length - 1], 1) === dayText) last.days.push(dayText)
        else segments.push({key, days: [dayText], assignment, salary, hourly, piece})
    }
    return segments
}
// The share of the period each segment is, by the group's proration: calendar days, or the working days or hours of the person's
// schedule. A whole period is 1; a part period by working days or hours needs a schedule.
function prorate(segments, member, group, periodDays) {
    const whole = segments.length === 1 && segments[0].days.length === periodDays.length
    if (whole) return {ok: true, shares: [{numerator: 1, denominator: 1, fraction: toDecimal(1), unit: "whole period"}]}
    const policy = group.prorationEnumId
    if (!policy) return failure("PRORATION_REQUIRED", "The pay group has no proration policy for a part period")
    if (policy === "PprCalendarDays")
        return {
            ok: true,
            shares: segments.map(segment => ({
                numerator: segment.days.length,
                denominator: periodDays.length,
                fraction: quotient(segment.days.length, periodDays.length),
                unit: "calendar days"
            }))
        }
    let planned = null
    try {
        planned = schedules().scheduledDays([member.partyId], periodDays)[member.partyId] || null
    } catch (error) {
        ec.logger.error("The working schedule of " + member.partyId + " was not read for a pay run: " + error.message)
    }
    if (!planned)
        return failure(
            "NO_SCHEDULE",
            "A part period is prorated by " +
                (policy === "PprHours" ? "hours" : "working days") +
                ", and the employee has no working schedule"
        )
    const measure = dayText =>
        policy === "PprHours"
            ? decimalOf(planned[dayText]?.hours)
            : decimalOf(planned[dayText]?.hours).compare(0) > 0
              ? toDecimal(1)
              : zero()
    const denominator = periodDays.reduce((sum, dayText) => sum.add(measure(dayText)), zero())
    if (denominator.compare(0) <= 0) return failure("NO_SCHEDULE", "The employee's schedule has no working time in the period")
    return {
        ok: true,
        shares: segments.map(segment => {
            const numerator = segment.days.reduce((sum, dayText) => sum.add(measure(dayText)), zero())
            return {
                numerator,
                denominator,
                fraction: quotient(numerator, denominator),
                unit: policy === "PprHours" ? "scheduled hours" : "working days"
            }
        })
    }
}
// A segment's structure computed: its published lines in effect at its first day (an elective line only when the assignment
// elects it; the segment has the same lines and terms on each of its days), in dependency order, each term over the segment's
// values, a prorated fixed amount by the segment's share in a part period (the term's setting, the user's call of Nov 12, 2026).
// Answers the lines by code, or the first blocking finding.
function computeSegment(segment, values, group, zone, found, share) {
    const config = configuration()
    const at = noonOf(segment.days[0], zone)
    const structure = found.shared.structures[segment.assignment.payrollStructureId] || null
    if (!structure || structure.statusId !== "PtsPublished" || !openAt(structure, at))
        return failure("STRUCTURE_NOT_IN_EFFECT", "The pay structure " + (structure?.structureName || "") + " is not in effect")
    if (structure.currencyUomId !== group.currencyUomId)
        return failure(
            "CURRENCY_MISMATCH",
            "The structure is in " + structure.currencyUomId + ", the group pays in " + group.currencyUomId
        )
    const lines = linesIn(structure, found, at, segment.assignment)
    const components = config.componentsById(lines.map(line => line.payrollComponentId))
    const working = lines.map(line => {
        const component = components[line.payrollComponentId]
        return {line, component, term: component ? termIn(found, component.payrollComponentId, at) : null}
    })
    const part = share && !share.fraction.eq(toDecimal(1)) ? share : null
    const ordered = config.calculationOrder(working)
    const firstBlocking = ordered.findings.find(finding => finding.blocking)
    if (firstBlocking) return failure(firstBlocking.code, firstBlocking.message)
    const assignmentValues = config.storedValues(segment.assignment.inputValues)
    const computed = {}
    const lineOf = {}
    for (const code of ordered.order) {
        const item = ordered.byCode[code]
        const term = item.term
        const statistical = item.component.componentKindEnumId === "PckStatistical"
        if (!statistical && term.currencyUomId !== group.currencyUomId)
            return failure(
                "CURRENCY_MISMATCH",
                code + " is in " + term.currencyUomId + ", the group pays in " + group.currencyUomId
            )
        const named = Object.assign({}, config.storedValues(item.line.parameterValues), assignmentValues, values)
        for (const dependency of config.splitNames(term.dependencyCodes)) named[dependency] = String(computed[dependency])
        const prorated = part && config.proratesFixed(term, item.component)
        const result = config.computeTerm(
            term,
            named,
            prorated
                ? {fraction: part.fraction, text: String(part.numerator) + "/" + String(part.denominator) + " " + part.unit}
                : null
        )
        if (!result.ok)
            return failure(
                result.errorCode,
                result.errorCode === "MISSING_INPUT"
                    ? code + " needs " + result.missingNames.join(", ")
                    : code + ": " + (result.message || result.errorCode)
            )
        computed[code] = result.amount
        lineOf[code] = {item, term, amount: result.amount, explanation: result.explanation}
    }
    return {ok: true, order: ordered.order, lines: lineOf}
}
// Whether a component's term reads an input that changes within the period, directly or through a component it reads (a fixed
// amount prorated in a part period reads the share).
function readsSegment(code, lines, seen = new Set()) {
    if (seen.has(code)) return false
    seen.add(code)
    const line = lines[code]
    if (!line) return false
    const config = configuration()
    // a prorated fixed amount reads the segment's share
    if (config.proratesFixed(line.term, line.item.component)) return true
    if (config.splitNames(line.term.inputNames).some(name => segmentNames.includes(name))) return true
    return config.splitNames(line.term.dependencyCodes).some(dependency => readsSegment(dependency, lines, seen))
}
// The calculation of one employment of a run: its segments, each computed, the lines combined, its adjustments, rounding,
// the localization and the totals. Reads and computes only; answers {ok, results, totals, ...} or a blocking failure.
function computeEmployment(run, group, period, zone, periodDays, member, found) {
    // P26: inputs another live run took (an off-cycle run's adjustments) are that run's, paid there and not here
    const {taken, waiting} = takenInputs(run, found)
    const segments = segmentsOf(member, found, zone)
    if (!segments.length || segments.some(segment => !segment.assignment))
        return failure("NO_ASSIGNMENT", "The employee has no primary pay assignment in this group on a day of the period")
    const prorated = prorate(segments, member, group, periodDays)
    if (!prorated.ok) return prorated
    // each input of time or a reimbursement to the segment of its day (P25 review): an hour or a piece on a day the group does not
    // pay the employee is not paid quietly (INPUT_OUTSIDE_DAYS: the period's inputs are prepared again), and a reimbursement, an
    // amount owed whatever its day, is paid with the last segment
    const segmentOfDay = new Map()
    segments.forEach((segment, index) => segment.days.forEach(dayText => segmentOfDay.set(dayText, index)))
    const segmentInputs = segments.map(() => [])
    for (const input of taken) {
        if (!input.inputName) continue
        const dayText = lib.calendarDateText(input.inputDate)
        let index = segmentOfDay.get(dayText)
        if (index == null && input.inputName === "reimbursement") index = segments.length - 1
        if (index == null)
            return failure(
                "INPUT_OUTSIDE_DAYS",
                "An input of " +
                    (dayText || "no day") +
                    " is on a day the group does not pay the employee; prepare the inputs again"
            )
        segmentInputs[index].push(input)
    }
    const segmentResults = []
    const splitParts = []
    for (const [index, segment] of segments.entries()) {
        const share = prorated.shares[index]
        const structure = found.shared.structures[segment.assignment.payrollStructureId] || null
        const basis = structure?.payBasisEnumId
        if ((basis === "PpbSalaried" || basis === "PpbMixed") && !segment.salary)
            return failure("SALARY_MISSING", "The structure pays a salary and the employee has none from " + segment.days[0])
        if ((basis === "PpbHourly" || basis === "PpbMixed") && !segment.hourly)
            return failure(
                "RATE_MISSING",
                "The structure pays by the hour and the employee has no pay rate from " + segment.days[0]
            )
        const values = {periodsPerYear: String(group.periodsPerYear), periodFraction: String(share.fraction)}
        if (segment.salary) {
            if (segment.salary.currencyUomId && segment.salary.currencyUomId !== group.currencyUomId)
                return failure("CURRENCY_MISMATCH", "The salary is not in the pay group's currency, " + group.currencyUomId)
            const perYear = salaryPeriodsPerYear(segment.salary, group)
            if (perYear == null)
                return failure(
                    "SALARY_FREQUENCY",
                    "The salary's frequency is not one a year divides exactly, and the group pays at another frequency"
                )
            const fullAnnual = decimalOf(segment.salary.amount).multiply(toDecimal(String(perYear)))
            values.fullAnnualSalary = String(fullAnnual)
            values.annualSalary = String(fullAnnual.multiply(share.fraction))
        }
        for (const [name, rate] of [
            ["hourlyRate", segment.hourly],
            ["pieceRate", segment.piece]
        ])
            if (rate) {
                if (rate.rateCurrencyUomId && rate.rateCurrencyUomId !== group.currencyUomId)
                    return failure("CURRENCY_MISMATCH", "The pay rate is not in the pay group's currency, " + group.currencyUomId)
                values[name] = String(rate.rateAmount)
            }
        for (const name of timeInputNames.concat(["reimbursement"])) values[name] = "0"
        for (const input of segmentInputs[index]) {
            const add = input.inputName === "reimbursement" ? input.amount : input.quantity
            values[input.inputName] = String(decimalOf(values[input.inputName]).add(decimalOf(add)))
        }
        const computed = computeSegment(segment, values, group, zone, found, share)
        if (!computed.ok) return computed
        segmentResults.push(computed)
        const daysText =
            segment.days.length === 1
                ? shortDay(segment.days[0])
                : shortDay(segment.days[0]) + " to " + shortDay(segment.days[segment.days.length - 1])
        splitParts.push(
            daysText +
                (share.unit === "whole period"
                    ? " (the whole period)"
                    : " (" + String(share.numerator) + "/" + String(share.denominator) + " " + share.unit + ")")
        )
    }
    // the lines combined: a line reading a segment's input summed, another taken once from the last segment that has it
    const last = segmentResults[segmentResults.length - 1]
    const codes = unique(segmentResults.flatMap(found => found.order))
    const byCode = {}
    for (const code of codes) {
        const having = segmentResults.filter(found => found.lines[code])
        const lastLine = having[having.length - 1].lines[code]
        const summed = segmentResults.length > 1 && readsSegment(code, having[having.length - 1].lines)
        const amount = summed ? having.reduce((sum, found) => sum.add(found.lines[code].amount), zero()) : lastLine.amount
        const explanation =
            segmentResults.length === 1
                ? lastLine.explanation
                : summed
                  ? having
                        .map((found, index) => splitParts[segmentResults.indexOf(found)] + ": " + found.lines[code].explanation)
                        .join("; ")
                  : lastLine.explanation + " (once for the period)"
        byCode[code] = {
            component: lastLine.item.component,
            term: lastLine.term,
            sequenceNum: lastLine.item.line.sequenceNum,
            amount,
            explanation
        }
    }
    return finishEmployment(run, group, period, zone, member, byCode, taken, waiting, {
        ownRunIds: found.shared.ownRunIds,
        assignment: last && segments[segments.length - 1].assignment,
        segmentCount: segments.length,
        splitText: splitParts.join("; ")
    })
}
// An employment's lines finished (P26: shared by a regular or correction run's calculation and an off-cycle run's): the approved
// adjustments and advance recoveries added to their components' lines, each money line rounded to the currency once, the totals,
// the localization once over the period's lines, net (a negative one blocks) and employer cost.
function finishEmployment(run, group, period, zone, member, byCode, taken, waiting, extra) {
    const results = []
    // approved adjustments and advance recoveries: each adds to its component's line
    for (const input of taken) {
        if (!input.payrollComponentId || input.amount == null) continue
        const component = one(COMPONENT, {payrollComponentId: input.payrollComponentId})
        if (!component) continue
        const code = component.componentCode
        const what = (input.inputTypeEnumId === "PitAdvanceRecovery" ? "advance recovery " : "adjustment ") + String(input.amount)
        if (byCode[code]) {
            byCode[code].amount = byCode[code].amount.add(decimalOf(input.amount))
            byCode[code].explanation += "; " + what
        } else byCode[code] = {component, term: null, sequenceNum: 900, amount: decimalOf(input.amount), explanation: what}
    }
    // each money line rounded to the currency once
    const currencyUomId = group.currencyUomId
    for (const [code, line] of Object.entries(byCode)) {
        const statistical = line.component.componentKindEnumId === "PckStatistical"
        if (statistical) continue
        const rounded = ec.l10n.roundCurrency(line.amount, currencyUomId)
        if (!rounded.eq(line.amount)) line.explanation += ", rounded to the currency: " + String(rounded)
        line.amount = rounded
        byCode[code] = line
    }
    const sum = kind =>
        Object.values(byCode)
            .filter(line => line.component.componentKindEnumId === kind)
            .reduce((total, line) => total.add(line.amount), zero())
    const gross = sum("PckEarning")
    const deductions = sum("PckDeduction")
    const contributions = sum("PckContribution")
    // the localization, once, over the period's lines
    const localItems = []
    if (group.payrollLocalizationId) {
        const localization = one(LOCALIZATION, {payrollLocalizationId: group.payrollLocalizationId})
        if (!localization)
            return failure("LOCALIZATION_INVALID", group.payrollLocalizationId + " is not a registered localization")
        const profileRow = rows(PROFILE, {
            partyRelationshipId: member.partyRelationshipId,
            payrollLocalizationId: localization.payrollLocalizationId
        }).find(row => !voided(row) && openAt(row, noonOf(period.thruDay, zone)))
        const out = call(localization.calculationServiceName, {
            payrollLocalizationId: localization.payrollLocalizationId,
            organizationPartyId: group.organizationPartyId,
            currencyUomId,
            asOfDate: new Date(noonOf(period.thruDay, zone)),
            payFacts: Object.values(byCode)
                .filter(line => line.component.componentKindEnumId !== "PckStatistical")
                .map(line => ({
                    componentCode: line.component.componentCode,
                    componentKindEnumId: line.component.componentKindEnumId,
                    amount: line.amount
                })),
            profile: profileRow ? lib.json(profileRow.profileValues, {}) || {} : {}
        })
        const blocking = Array.from(out.findings || []).find(finding => finding.blocking)
        if (blocking) return failure(blocking.code || "LOCALIZATION_BLOCKED", blocking.message || "The localization refused")
        for (const item of Array.from(out.items || []))
            localItems.push({
                itemCode: item.itemCode,
                itemName: item.itemName,
                party: item.party,
                amount: ec.l10n.roundCurrency(decimalOf(item.amount), currencyUomId),
                explanation: item.explanation || ""
            })
    }
    const localSum = party =>
        localItems.filter(item => item.party === party).reduce((total, item) => total.add(item.amount), zero())
    const net = gross.subtract(deductions).subtract(localSum("employee"))
    if (net.compare(0) < 0) return failure("NEGATIVE_NET", "The net is negative: it needs a recovery, not a payment")
    for (const [code, line] of Object.entries(byCode))
        results.push({
            payrollComponentId: line.component.payrollComponentId,
            componentCode: code,
            resultName: line.component.componentName || code,
            componentKindEnumId: line.component.componentKindEnumId,
            amount: line.amount,
            currencyUomId: line.component.componentKindEnumId === "PckStatistical" ? null : currencyUomId,
            quantityUomId: line.term?.quantityUomId || null,
            inTotals: line.component.componentKindEnumId !== "PckStatistical",
            sequenceNum: line.sequenceNum ?? null,
            explanation: line.explanation,
            payrollComponentTermId: line.term?.payrollComponentTermId || null
        })
    for (const item of localItems)
        results.push({
            payrollComponentId: null,
            componentCode: item.itemCode,
            resultName: item.itemName,
            componentKindEnumId: null,
            localizationParty: item.party,
            amount: item.amount,
            currencyUomId,
            inTotals: true,
            sequenceNum: 1000,
            explanation: item.explanation
        })
    return {
        ok: true,
        results,
        // the inputs this run marks: not those its correction's base runs took (theirs, paid there)
        takenIds: taken
            .filter(row => !row.payrollRunId || row.payrollRunId === run.payrollRunId || !extra.ownRunIds?.has(row.payrollRunId))
            .map(row => row.payrollInputId),
        waitingCount: waiting.length,
        assignment: extra.assignment || null,
        segmentCount: extra.segmentCount ?? null,
        splitText: extra.splitText || null,
        totals: {
            gross,
            deductions,
            contributions,
            localEmployee: localSum("employee"),
            localEmployer: localSum("employer"),
            net: ec.l10n.roundCurrency(net, currencyUomId),
            employerCost: gross.add(contributions).add(localSum("employer"))
        }
    }
}
// P26: an off-cycle run's employment: the approved adjustments of the period no live run took (each to its component's line), with
// no salary or structure line, then rounded, localized and totalled as any employment.
// P26 review: a correction of an off-cycle slip (forCorrection) is calculated the same way, and with nothing left to pay its lines
// are none, so the adjustments paid before are recovered.
function computeOffCycle(run, group, period, zone, member, found, forCorrection = false) {
    const {taken, waiting} = takenInputs(run, found)
    if (!taken.length && !forCorrection)
        return failure("NOTHING_TO_PAY", "No approved adjustment of this employee waits to be paid in the period")
    return finishEmployment(run, group, period, zone, member, {}, taken, waiting, {
        ownRunIds: found.shared.ownRunIds,
        splitText: "Off-cycle: the period's approved adjustments"
    })
}
const resultKey = row => (row.componentCode || "") + "|" + (row.localizationParty || "")
// P26: a correction run's employment: calculated as it is now (computeEmployment over the original's inputs, its corrections' and
// those approved since), less what the original slip and the corrections before this one paid, line by line (a line no longer paid
// is recovered whole); its totals are the changes. Nothing changed answers NO_CHANGE; a withdrawn original ORIGINAL_WITHDRAWN.
function correctionOf(run, now, found) {
    const before = found.shared.before
    if (!before || before.missing || before.original.statusId === "PssWithdrawn")
        return failure(
            "ORIGINAL_WITHDRAWN",
            "The slip this run corrects was withdrawn when its run's approval was taken back; cancel this run"
        )
    const nowLines = Object.fromEntries(now.results.map(row => [resultKey(row), row]))
    const keys = unique(Object.keys(nowLines).concat(Object.keys(before.lines)))
    const changed = []
    for (const key of keys) {
        const current = nowLines[key]
        const paid = before.lines[key]
        const nowAmount = decimalOf(current?.amount)
        const paidAmount = decimalOf(paid?.amount)
        const change = nowAmount.subtract(paidAmount)
        if (change.isZero()) continue
        const base = current || {
            payrollComponentId: paid.payrollComponentId || null,
            componentCode: paid.componentCode,
            resultName: paid.itemName,
            componentKindEnumId: paid.componentKindEnumId || null,
            localizationParty: paid.localizationParty || null,
            currencyUomId: paid.currencyUomId || null,
            quantityUomId: paid.quantityUomId || null,
            inTotals: paid.inTotals !== "N",
            sequenceNum: paid.sequenceNum ?? null,
            payrollComponentTermId: paid.payrollComponentTermId || null
        }
        const amountText = value =>
            base.currencyUomId
                ? moneyText(value, base.currencyUomId)
                : String(value) + (base.quantityUomId ? " " + base.quantityUomId : "")
        changed.push(
            Object.assign({}, base, {
                amount: change,
                previousAmount: paidAmount,
                explanation:
                    "Now " +
                    amountText(nowAmount) +
                    ", paid " +
                    amountText(paidAmount) +
                    (current ? ": " + current.explanation : ": no longer paid")
            })
        )
    }
    if (!changed.length) return failure("NO_CHANGE", "Nothing changed since the original slip: there is nothing to correct")
    const minus = (field, beforeField) => decimalOf(now.totals[field]).subtract(decimalOf(before.totals[beforeField || field]))
    return Object.assign({}, now, {
        results: changed,
        splitText: "Correction of payslip " + before.original.payslipId + (now.splitText ? "; now " + now.splitText : ""),
        totals: {
            gross: minus("gross"),
            deductions: minus("deductions"),
            contributions: minus("contributions"),
            localEmployee: minus("localEmployee"),
            localEmployer: minus("localEmployer"),
            net: minus("net"),
            employerCost: minus("employerCost")
        }
    })
}
// One unit calculated and written, in the caller's transaction (calculateRun gives each its own): the employment locked, its results
// replaced, the inputs it takes marked with the run and those it no longer takes released; a blocking finding leaves it in error.
// One another call calculated since it was listed, as it still is, is left as it is ("unchanged").
function calculateUnit(run, facts, unitId) {
    const {group, period, zone, periodDays} = facts
    let unit = one(UNIT, {payrollRunEmploymentId: unitId})
    find(RELATIONSHIP, {partyRelationshipId: unit.partyRelationshipId}).forUpdate(true).one()
    unit = one(UNIT, {payrollRunEmploymentId: unitId})
    if (unit.statusId === "PruExcluded") return "unchanged"
    const loaded = factsOf(run, facts, [unit])
    if (unit.statusId === "PruCalculated" && unit.sourceRevision === fingerprintsOf(run, facts, [unit], loaded).get(unitId))
        return "unchanged"
    const found = loaded.forUnit(unit)
    const member = found.member
    // P26 review: a correction of an off-cycle slip recalculates its adjustments alone (as the off-cycle run did), not the period's
    // salary and structure lines, which its original never paid
    const offCycleBase = found.shared.before?.original?.runKindEnumId === "PrkOffCycle"
    let outcome = !member
        ? failure("NOT_IN_GROUP", "The group no longer pays this employee in the period; select the population again")
        : run.runKindEnumId === "PrkOffCycle" || offCycleBase
          ? computeOffCycle(run, group, period, zone, member, found, offCycleBase)
          : computeEmployment(run, group, period, zone, periodDays, member, found)
    if (outcome.ok && run.runKindEnumId === "PrkCorrection") outcome = correctionOf(run, outcome, found)
    clearUnit(run, unit)
    const base = {
        payrollRunEmploymentId: unitId,
        attemptCount: Number(unit.attemptCount || 0) + 1,
        calculatedDate: ec.user.nowTimestamp
    }
    if (!outcome.ok) {
        call(
            "update#" + UNIT,
            Object.assign(base, {
                statusId: "PruError",
                reasonCode: outcome.errorCode,
                message: outcome.message,
                grossAmount: null,
                deductionAmount: null,
                contributionAmount: null,
                localEmployeeAmount: null,
                localEmployerAmount: null,
                netAmount: null,
                employerCostAmount: null,
                splitText: null,
                segmentCount: null,
                sourceRevision: fingerprintsOf(run, facts, [unit], loaded).get(unitId)
            })
        )
        return "error"
    }
    for (const payrollInputId of outcome.takenIds) call("update#" + INPUT, {payrollInputId, payrollRunId: run.payrollRunId})
    for (const result of outcome.results)
        call(
            "create#" + RESULT,
            Object.assign({payrollRunEmploymentId: unitId, payrollRunId: run.payrollRunId}, result, {
                inTotals: result.inTotals === false || result.inTotals === "N" ? "N" : "Y"
            })
        )
    const totals = outcome.totals
    call(
        "update#" + UNIT,
        Object.assign(base, {
            statusId: "PruCalculated",
            reasonCode: null,
            message: outcome.waitingCount
                ? outcome.waitingCount +
                  (outcome.waitingCount === 1 ? " input waits" : " inputs wait") +
                  " for approval and is not paid here"
                : null,
            payrollAssignmentId: outcome.assignment?.payrollAssignmentId || null,
            payrollStructureId: outcome.assignment?.payrollStructureId || null,
            grossAmount: totals.gross,
            deductionAmount: totals.deductions,
            contributionAmount: totals.contributions,
            localEmployeeAmount: totals.localEmployee,
            localEmployerAmount: totals.localEmployer,
            netAmount: totals.net,
            employerCostAmount: totals.employerCost,
            segmentCount: outcome.segmentCount,
            splitText: outcome.splitText,
            sourceRevision: fingerprintsOf(run, facts, [unit]).get(unitId)
        })
    )
    return "calculated"
}

// ===== calculate#Run =====
// The run's pending and failed employments calculated, and those whose sources changed since they were calculated (stale), each in
// its own transaction: one that fails is left in error with its reason code and the others go on. Bounded: at most batchSize
// employments a call (100 by default, 500 at most), stopping after a minute; the rest stay pending, and calling again resumes
// them. A calculated employment whose sources are as they were is not calculated again, so a resumed or repeated call makes no
// second result. The run is in review once nothing is pending.
function calculateRun(p) {
    const userScope = editorScope()
    const run = runIn(userScope, p.payrollRunId)
    checkChangeable(run)
    const facts = periodFacts(run)
    const batchSize = Math.min(batchCap, Math.max(1, Number(p.batchSize) || batchDefault))
    const units = rows(UNIT, {payrollRunId: run.payrollRunId})
    const prints = fingerprintsOf(
        run,
        facts,
        units.filter(unit => unit.statusId === "PruCalculated")
    )
    const work = units.filter(
        unit =>
            unit.statusId === "PruPending" ||
            unit.statusId === "PruError" ||
            (unit.statusId === "PruCalculated" && unit.sourceRevision !== prints.get(unit.payrollRunEmploymentId))
    )
    // P25 review's finding: an approved run with nothing to calculate keeps its approval (and its slips); one with work whose slips
    // are corrected is not recalculated (P26 review)
    if (work.length) checkUncorrected(run)
    if (run.statusId === "PrnApproved" && !work.length)
        return {
            payrollRunId: run.payrollRunId,
            processedCount: 0,
            calculatedCount: 0,
            errorCount: 0,
            remainingCount: 0,
            statusId: run.statusId
        }
    const startedMs = Date.now()
    let calculatedCount = 0
    let errorCount = 0
    let done = 0
    for (const unit of work) {
        if (done >= batchSize || Date.now() - startedMs > timeBudgetMs) break
        done++
        let outcome = "error"
        ec.message.pushErrors()
        try {
            ec.transaction.runRequireNew(null, "Calculating pay of " + unit.partyRelationshipId + " failed", () => {
                outcome = calculateUnit(run, facts, unit.payrollRunEmploymentId)
                if (ec.message.hasError()) throw new Error(ec.message.getErrorsString())
            })
        } catch (error) {
            outcome = "error"
            const reasonCode = lib.reasonCode(error) || "FAILED"
            if (!lib.reasonCode(error))
                ec.logger.error("Calculating pay of " + unit.partyRelationshipId + " failed: " + error.message)
            ec.message.clearErrors()
            try {
                ec.transaction.runRequireNew(null, "Recording a pay calculation's error failed", () =>
                    call("update#" + UNIT, {
                        payrollRunEmploymentId: unit.payrollRunEmploymentId,
                        statusId: "PruError",
                        reasonCode,
                        message: String(error?.message || error).replace(/^[A-Z][A-Z0-9_]+: /, ""),
                        attemptCount: Number(unit.attemptCount || 0) + 1
                    })
                )
            } catch (inner) {
                ec.logger.error("The error of pay unit " + unit.payrollRunEmploymentId + " was not recorded: " + inner.message)
            }
        } finally {
            ec.message.clearErrors()
            ec.message.popErrors()
        }
        if (outcome === "calculated") calculatedCount++
        else if (outcome === "error") errorCount++
    }
    const after = rows(UNIT, {payrollRunId: run.payrollRunId})
    const remainingCount = after.filter(unit => unit.statusId === "PruPending").length + Math.max(0, work.length - done)
    const statusId = remainingCount ? "PrnCalculating" : "PrnReview"
    if (done || run.statusId !== statusId) {
        reopenForChange(run, statusId)
        call("update#" + RUN, {payrollRunId: run.payrollRunId, calculatedDate: ec.user.nowTimestamp, returnedReason: null})
    }
    return {
        payrollRunId: run.payrollRunId,
        processedCount: done,
        calculatedCount,
        errorCount,
        remainingCount,
        statusId
    }
}

// P26: whether a run's employment is still calculated from the sources it was (its fingerprint now against sourceRevision), for a
// preview slip's reader.
function unitHolds(run, payrollRunEmploymentId, sourceRevision) {
    const unit = one(UNIT, {payrollRunEmploymentId})
    if (!unit || unit.statusId !== "PruCalculated") return false
    return fingerprintsOf(run, periodFacts(run), [unit]).get(payrollRunEmploymentId) === (sourceRevision || unit.sourceRevision)
}

// ===== the run's revision =====
// What an approval binds: the pay date, each employment's state, exclusion and totals, and the fingerprint its results came from
// beside the fingerprint of its sources now (so a changed input, salary, rate, assignment, rule or profile is another revision).
function runRevision(payrollRunId, known = null) {
    const run = one(RUN, {payrollRunId})
    if (!run) return "0"
    const all = rows(UNIT, {payrollRunId})
    const prints =
        known ||
        fingerprintsOf(
            run,
            periodFacts(run),
            all.filter(unit => unit.statusId === "PruCalculated")
        )
    const units = all.sort((a, b) => String(a.payrollRunEmploymentId).localeCompare(String(b.payrollRunEmploymentId)))
    const value = {
        payDate: lib.calendarDateText(run.payDate),
        period: run.timePeriodId,
        units: units.map(unit =>
            [
                unit.payrollRunEmploymentId,
                unit.statusId,
                unit.exclusionReason,
                unit.grossAmount,
                unit.deductionAmount,
                unit.contributionAmount,
                unit.localEmployeeAmount,
                unit.netAmount,
                unit.employerCostAmount,
                unit.sourceRevision,
                unit.statusId === "PruCalculated" ? prints.get(unit.payrollRunEmploymentId) : ""
            ]
                .map(part => (part == null ? "" : String(part)))
                .join("|")
        )
    }
    return revisionText(value)
}
// the calculated employments' fingerprints now, and those whose sources changed since
function nowPrints(run, units) {
    return fingerprintsOf(
        run,
        periodFacts(run),
        units.filter(unit => unit.statusId === "PruCalculated")
    )
}
const staleOf = (units, prints) =>
    units.filter(unit => unit.statusId === "PruCalculated" && unit.sourceRevision !== prints.get(unit.payrollRunEmploymentId))

// ===== submit#Run =====
// Approval asked of a run in review: every employment calculated or excluded (an error is resolved or excluded first:
// UNITS_UNRESOLVED; one still pending: CALCULATION_INCOMPLETE), at least one calculated (NOTHING_CALCULATED), none stale
// (SOURCE_CHANGED: calculate again). A People approval of kind PakPayrollRun at the run's revision.
function submitRun(p) {
    const userScope = editorScope()
    const run = runIn(userScope, p.payrollRunId)
    if (run.statusId !== "PrnReview") denied("NOT_IN_REVIEW", "Only a run in review is sent for approval")
    const units = rows(UNIT, {payrollRunId: run.payrollRunId})
    if (units.some(unit => unit.statusId === "PruPending"))
        denied("CALCULATION_INCOMPLETE", "Some employees are not calculated yet")
    const errors = units.filter(unit => unit.statusId === "PruError")
    if (errors.length)
        denied(
            "UNITS_UNRESOLVED",
            errors.length +
                (errors.length === 1 ? " employee is" : " employees are") +
                " in error: fix and calculate again, or exclude with a reason"
        )
    if (!units.some(unit => unit.statusId === "PruCalculated")) denied("NOTHING_CALCULATED", "No employee is calculated")
    if (staleOf(units, nowPrints(run, units)).length)
        denied("SOURCE_CHANGED", "Some results changed since they were calculated; calculate again")
    const asked = approvals().request({
        approvalKindEnumId: KIND,
        sourceEntityName: RUN,
        sourceId: run.payrollRunId,
        organizationPartyId: run.organizationPartyId,
        effectiveDate: null,
        justification: text(p.justification) || null,
        operationKey: text(p.operationKey) || null
    })
    return {payrollRunId: run.payrollRunId, peopleApprovalId: asked.peopleApprovalId, waitingText: asked.waitingText || ""}
}

// ===== approve#Run and return#Run =====
// The approver's decision of the run's approval at the revision they read (the notice's): the approval approves the run, at that
// revision, and a return (its reason required) sends it back to review with the reason. Refused by record#Decision: who selected,
// calculated or asked (SELF_APPROVAL), anyone not the step's approver (NOT_APPROVER), a run changed since (SOURCE_CHANGED).
function decideRun(p, decision) {
    const userScope = readerScope()
    const message = p.message || {}
    if (p.recordEntityName && p.recordEntityName !== RUN) denied("SOURCE_INVALID", "Not a pay run approval")
    const run = runIn(userScope, text(p.payrollRunId) || text(p.recordId))
    const decided = call("mantle.humanres.PeopleApprovalServices.record#Decision", {
        approvalKindEnumId: KIND,
        sourceEntityName: RUN,
        peopleApprovalId: text(p.peopleApprovalId) || text(message.peopleApprovalId) || null,
        sourceId: run.payrollRunId,
        decision,
        reason: text(p.reason) || null,
        sourceRevision: text(p.sourceRevision) || text(message.sourceRevision) || null,
        operationKey: text(p.operationKey) || null
    })
    if (!decided.repeated) {
        if (decided.complete) {
            call("update#" + RUN, {
                payrollRunId: run.payrollRunId,
                statusId: "PrnApproved",
                approvedRevision: runRevision(run.payrollRunId),
                approvedDate: ec.user.nowTimestamp,
                returnedReason: null
            })
            // P26: the approved results become slips (preview slips in preview mode)
            slips().makeSlips(one(RUN, {payrollRunId: run.payrollRunId}))
        } else if (decided.statusId === "PapRefused")
            call("update#" + RUN, {payrollRunId: run.payrollRunId, returnedReason: text(p.reason) || null})
    }
    const after = one(RUN, {payrollRunId: run.payrollRunId})
    return {
        payrollRunId: run.payrollRunId,
        statusId: after.statusId,
        approved: after.statusId === "PrnApproved",
        repeated: !!decided.repeated
    }
}

// ===== create#Correction =====
// P26 (design §8.2): a correction of a slip, a run of its own (kind correction) for the slip's group, period and employment, with the
// reason (the changed source or rule) and a pay date (the original's when empty: a slip of the same day keeps its own identity).
// A correction of a correction corrects its original. Calculated, approved and slipped as any run; its slip names the original,
// which stays. Refused: a slip outside the payroll scope (RECORD_UNAVAILABLE), a withdrawn original (SLIP_WITHDRAWN), no reason
// (REASON_REQUIRED), a correction of the slip already open (CORRECTION_EXISTS) and an employment the group no longer pays in the
// period (NOT_IN_GROUP). An operation key answers a retry with the first run. No invoice or payment is made.
function createCorrection(p) {
    const userScope = editorScope()
    const id = text(p.payslipId)
    const slip = id ? one(SLIP, {payslipId: id}) : null
    if (!slip || !userScope.organizationPartyIds.includes(slip.organizationPartyId))
        denied("RECORD_UNAVAILABLE", "Payslip " + id + " is not available")
    const operationKey = text(p.operationKey) || null
    if (operationKey) {
        const first = one(RUN, {operationKey, createdByUserId: ec.user.userId})
        if (first) return {payrollRunId: first.payrollRunId, originalPayslipId: first.correctsPayslipId, repeated: true}
    }
    const original = slips().originalOf(slip)
    if (!original || original.statusId === "PssWithdrawn")
        denied(
            "SLIP_WITHDRAWN",
            "This slip was withdrawn when its run's approval was taken back; correct the slip of the run approved again"
        )
    const reason = text(p.reason)
    if (!reason) denied("REASON_REQUIRED", "Say what changed: the source or rule the correction follows")
    // P26 review: the original locked, so two corrections made at once are not both open
    find(SLIP).condition("payslipId", original.payslipId).forUpdate(true).one()
    const open = rows(RUN, {correctsPayslipId: original.payslipId}).find(row =>
        ["PrnDraft", "PrnCalculating", "PrnReview"].includes(row.statusId)
    )
    if (open)
        denied("CORRECTION_EXISTS", "Pay run " + open.payrollRunId + " corrects this slip already; finish or cancel it first")
    const group = one(GROUP, {payrollGroupId: original.payrollGroupId})
    const period = inputs().periodOf(group, original.timePeriodId)
    const zone = inputs().zoneOf(group)
    const created = call("create#" + RUN, {
        organizationPartyId: original.organizationPartyId,
        payrollGroupId: original.payrollGroupId,
        timePeriodId: original.timePeriodId,
        currencyUomId: original.currencyUomId,
        payDate: blank(p.payDate) ? lib.calendarDateText(original.payDate) : dayOf(p.payDate),
        runKindEnumId: "PrkCorrection",
        statusId: "PrnDraft",
        correctsPayslipId: original.payslipId,
        correctionReason: reason,
        description: text(p.description) || null,
        preparedByUserIds: ec.user.userId || null,
        operationKey,
        createdByUserId: ec.user.userId,
        createdDate: ec.user.nowTimestamp
    })
    const run = one(RUN, {payrollRunId: created.payrollRunId})
    const selected = syncPopulation(run, group, period, zone, [original.partyRelationshipId])
    if (!selected.addedCount)
        denied("NOT_IN_GROUP", "The pay group no longer pays this employee in the slip's period; nothing is recalculated")
    return {payrollRunId: run.payrollRunId, originalPayslipId: original.payslipId, repeated: false}
}

// ===== cancel#Run =====
// A run not approved (draft, calculating or in review; P25 review, finding 5) cancelled by a payroll editor, with the reason: the
// inputs its calculation took are released, its regular key is freed so the period may be run again, and a request waiting for
// its approval is superseded. Its population and draft results stay as they were, read as a cancelled run's. An approved run is
// returned or changed first (RUN_NOT_CANCELLABLE); a finalizing, finalized or cancelled one is not cancelled. A repeat answers the
// cancellation.
const cancellableStatuses = ["PrnDraft", "PrnCalculating", "PrnReview"]
function cancelRun(p) {
    const userScope = editorScope()
    let run = runIn(userScope, p.payrollRunId)
    run = find(RUN, {payrollRunId: run.payrollRunId}).forUpdate(true).one()
    if (run.statusId === "PrnCancelled") return {payrollRunId: run.payrollRunId, statusId: run.statusId, repeated: true}
    if (!cancellableStatuses.includes(run.statusId))
        denied(
            "RUN_NOT_CANCELLABLE",
            run.statusId === "PrnApproved"
                ? "An approved pay run is not cancelled: select or calculate it again first, which takes back its approval"
                : "This pay run is " + (runStateTexts[run.statusId] || run.statusId).toLowerCase() + "; it is not cancelled"
        )
    const reason = text(p.reason)
    if (!reason) denied("REASON_REQUIRED", "Say why the pay run is cancelled")
    let releasedCount = 0
    for (const input of rows(INPUT, {payrollRunId: run.payrollRunId})) {
        call("update#" + INPUT, {payrollInputId: input.payrollInputId, payrollRunId: null})
        releasedCount++
    }
    call("update#" + RUN, {
        payrollRunId: run.payrollRunId,
        statusId: "PrnCancelled",
        statusId_changeReason: reason,
        cancelReason: reason,
        activeRunKey: null
    })
    approvals().sourceChanged(KIND, run.payrollRunId, RUN, true)
    return {payrollRunId: run.payrollRunId, statusId: "PrnCancelled", releasedCount, repeated: false}
}

// ===== get#Run =====
function unitRow(unit, names, currencyUomId, prior, staleIds) {
    const [state, stateText] = unitStates[unit.statusId] || ["pending", unit.statusId]
    const stale = staleIds.has(unit.payrollRunEmploymentId)
    const priorNet = prior[unit.partyRelationshipId]
    const variance = unit.netAmount != null && priorNet != null ? decimalOf(unit.netAmount).subtract(decimalOf(priorNet)) : null
    return {
        payrollRunEmploymentId: unit.payrollRunEmploymentId,
        partyRelationshipId: unit.partyRelationshipId,
        partyId: unit.partyId,
        personName: names[unit.partyId] || unit.partyId,
        state: stale ? "stale" : state,
        stateText: stale ? "Changed since calculated" : stateText,
        reasonCode: unit.reasonCode || null,
        message: unit.exclusionReason || unit.message || "",
        exclusionReason: unit.exclusionReason || "",
        grossText: moneyText(unit.grossAmount, currencyUomId),
        deductionText: moneyText(unit.deductionAmount, currencyUomId),
        netText: moneyText(unit.netAmount, currencyUomId),
        employerCostText: moneyText(unit.employerCostAmount, currencyUomId),
        varianceText: variance == null ? "" : (variance.compare(0) > 0 ? "+" : "") + moneyText(variance, currencyUomId),
        splitText: unit.splitText || "",
        segmentCount: unit.segmentCount ?? null,
        attemptCount: unit.attemptCount ?? 0,
        calculatedDateText: dateText(unit.calculatedDate)
    }
}
// The nets of a group's previous run (the latest earlier period's live run), by employment: the variance from prior comparable pay.
function priorNets(run) {
    const period = one(PERIOD, {timePeriodId: run.timePeriodId})
    const earlier = Array.from(
        find(RUN)
            .condition({payrollGroupId: run.payrollGroupId, runKindEnumId: "PrkRegular"})
            .condition("payrollRunId", "not-equals", run.payrollRunId)
            .condition("statusId", "in", ["PrnReview", "PrnApproved", "PrnFinalizing", "PrnFinalized"])
            .list()
    )
    const periods = Object.fromEntries(
        rowsIn(PERIOD, "timePeriodId", unique(earlier.map(row => row.timePeriodId))).map(row => [row.timePeriodId, row])
    )
    const fromMs = ms(period?.fromDate) ?? Infinity
    const previous = earlier
        .filter(row => (ms(periods[row.timePeriodId]?.fromDate) ?? Infinity) < fromMs)
        .sort((a, b) => ms(periods[b.timePeriodId].fromDate) - ms(periods[a.timePeriodId].fromDate))[0]
    if (!previous) return {}
    return Object.fromEntries(
        rows(UNIT, {payrollRunId: previous.payrollRunId, statusId: "PruCalculated"}).map(unit => [
            unit.partyRelationshipId,
            unit.netAmount
        ])
    )
}
// A run as PayRunDetail shows it: its header (group, period, pay date, kind, state, who may act), the progress counts, the totals
// of the calculated employments and of the excluded ones' count, the approval (its state, who decides, the decisions) and whether
// an approval still holds, the steps' progress, the population (paged, filtered by state) with each employment's totals,
// variance and reason; with partyRelationshipId, that employment's result lines, its split and the inputs it took.
function getRun(p) {
    const userScope = readerScope()
    const run = runIn(userScope, p.payrollRunId)
    const group = groupOfRun(run)
    const currencyUomId = run.currencyUomId
    const units = rows(UNIT, {payrollRunId: run.payrollRunId})
    const prints = nowPrints(run, units)
    const stale = staleOf(units, prints)
    const staleIds = new Set(stale.map(unit => unit.payrollRunEmploymentId))
    const counts = {total: units.length, pending: 0, calculated: 0, error: 0, excluded: 0, stale: stale.length}
    for (const unit of units)
        counts[(unitStates[unit.statusId] || ["pending"])[0]] = (counts[(unitStates[unit.statusId] || ["pending"])[0]] || 0) + 1
    const calculated = units.filter(unit => unit.statusId === "PruCalculated")
    const total = field => calculated.reduce((sum, unit) => sum.add(decimalOf(unit[field])), zero())
    const totals = {
        gross: total("grossAmount"),
        deductions: total("deductionAmount"),
        contributions: total("contributionAmount"),
        localEmployee: total("localEmployeeAmount"),
        localEmployer: total("localEmployerAmount"),
        net: total("netAmount"),
        employerCost: total("employerCostAmount")
    }
    const totalsText = Object.fromEntries(Object.entries(totals).map(([key, value]) => [key, moneyText(value, currencyUomId)]))
    const approval = approvals().sourceSummary(KIND, run.payrollRunId, RUN)
    const approvedNow = run.statusId === "PrnApproved"
    const approvalHolds = approvedNow && run.approvedRevision === runRevision(run.payrollRunId, prints)
    const canEdit = edits(userScope) && changeableStatuses.includes(run.statusId)
    const done = counts.calculated + counts.error + counts.excluded
    const label = runLabel(run)
    let state =
        {PrnDraft: "draft", PrnCalculating: "calculating", PrnReview: "review", PrnApproved: "approved"}[run.statusId] || "closed"
    let stateText = runStateTexts[run.statusId] || run.statusId
    if (run.statusId === "PrnReview" && approval?.waiting) [state, stateText] = ["waiting", "Waiting for approval"]
    else if (run.statusId === "PrnReview" && run.returnedReason)
        [state, stateText] = ["returned", "Returned: " + run.returnedReason]
    else if (approvedNow && !approvalHolds) [state, stateText] = ["stale", "Approval no longer holds: calculate again"]
    else if (run.statusId === "PrnCancelled" && run.cancelReason) stateText = "Cancelled: " + run.cancelReason
    const names = people.personNames(unique(units.map(unit => unit.partyId)))
    const prior = priorNets(run)
    let list = units.map(unit => unitRow(unit, names, currencyUomId, prior, staleIds))
    if (text(p.state)) list = list.filter(row => row.state === text(p.state))
    if (text(p.term)) list = list.filter(row => row.personName.toLowerCase().includes(text(p.term).toLowerCase()))
    list.sort((a, b) => String(a.personName).localeCompare(String(b.personName)))
    let employment = null
    if (text(p.partyRelationshipId)) {
        const unit = units.find(row => row.partyRelationshipId === text(p.partyRelationshipId))
        if (unit) {
            const results = rows(RESULT, {payrollRunEmploymentId: unit.payrollRunEmploymentId})
                .sort(
                    (a, b) =>
                        (Number(a.sequenceNum) || 0) - (Number(b.sequenceNum) || 0) ||
                        String(a.componentCode).localeCompare(String(b.componentCode))
                )
                .map(result => ({
                    componentCode: result.componentCode,
                    resultName: result.resultName,
                    kindText: result.localizationParty
                        ? result.localizationParty === "employer"
                            ? "Localization, employer"
                            : "Localization, employee"
                        : componentKinds[result.componentKindEnumId] || "",
                    amountText: result.currencyUomId
                        ? moneyText(result.amount, result.currencyUomId)
                        : String(result.amount ?? "") + (result.quantityUomId ? " " + result.quantityUomId : ""),
                    inTotals: result.inTotals === "Y",
                    explanation: result.explanation || ""
                }))
            const taken = rows(INPUT, {payrollRunId: run.payrollRunId, partyRelationshipId: unit.partyRelationshipId}).map(
                input => ({
                    payrollInputId: input.payrollInputId,
                    inputDateText: lib.calendarDateText(input.inputDate),
                    typeText:
                        one("moqui.basic.Enumeration", {enumId: input.inputTypeEnumId})?.description || input.inputTypeEnumId,
                    quantityText:
                        input.amount != null
                            ? moneyText(input.amount, input.currencyUomId)
                            : String(input.quantity ?? "") + " " + (input.quantityUomId || "")
                })
            )
            employment = Object.assign(unitRow(unit, names, currencyUomId, prior, staleIds), {results, inputs: taken})
        }
    }
    return Object.assign(
        {
            run: {
                payrollRunId: run.payrollRunId,
                organizationPartyId: run.organizationPartyId,
                organizationName:
                    people.organizationNames([run.organizationPartyId])[run.organizationPartyId] || run.organizationPartyId,
                payrollGroupId: run.payrollGroupId,
                groupName: label.groupName,
                timePeriodId: run.timePeriodId,
                periodText: label.periodText,
                payDateText: lib.calendarDateText(run.payDate),
                currencyUomId,
                runKindEnumId: run.runKindEnumId,
                kindText: kindTexts[run.runKindEnumId] || run.runKindEnumId,
                statusId: run.statusId,
                state,
                stateText,
                returnedReason: run.returnedReason || "",
                cancelReason: run.cancelReason || "",
                // P26: a correction run's original slip and reason, and the run's slips
                correctsPayslipId: run.correctsPayslipId || null,
                correctionReason: run.correctionReason || "",
                payslipCount: Array.from(
                    find(SLIP)
                        .condition("payrollRunId", run.payrollRunId)
                        .condition("statusId", "not-equals", "PssWithdrawn")
                        .list()
                ).length,
                approvedDateText: dateText(run.approvedDate),
                calculatedDateText: dateText(run.calculatedDate),
                readinessText: configuration().groupReadiness(
                    group,
                    group.payrollLocalizationId ? one(LOCALIZATION, {payrollLocalizationId: group.payrollLocalizationId}) : null,
                    nowMs()
                ).message
            },
            counts,
            progressPercent: counts.total ? Math.round((done * 100) / counts.total) : 0,
            totals,
            totalsText,
            approval,
            approvalHolds,
            steps: {
                population: counts.total > 0,
                calculated: counts.total > 0 && counts.pending === 0,
                resolved: counts.total > 0 && counts.pending === 0 && counts.error === 0 && stale.length === 0,
                approved: approvalHolds
            },
            canEdit,
            canCancel: edits(userScope) && cancellableStatuses.includes(run.statusId),
            canCalculate: canEdit && (counts.pending > 0 || counts.error > 0 || stale.length > 0),
            canSubmit:
                edits(userScope) &&
                run.statusId === "PrnReview" &&
                !approval?.waiting &&
                counts.pending === 0 &&
                counts.error === 0 &&
                stale.length === 0 &&
                counts.calculated > 0,
            canDecide: !!approval?.canDecide,
            employment
        },
        lib.pageList(list, p, "employments", {noLimitCap: listCap})
    )
}

// ===== find#Runs =====
// The runs of the employers in the caller's payroll scope, newest period first: each its group, period, pay date, kind, worker
// count, errors, gross and net of its calculated employments, and its state. show attention: the runs that need payroll's work
// (an employee in error or pending, returned by the approver, an approval that no longer holds).
function findRuns(p) {
    const userScope = readerScope()
    if (!userScope.organizationPartyIds.length) return Object.assign({}, lib.pageList([], p, "runs"))
    const query = find(RUN).condition("organizationPartyId", "in", userScope.organizationPartyIds)
    if (text(p.organizationPartyId)) query.condition("organizationPartyId", text(p.organizationPartyId))
    if (text(p.payrollGroupId)) query.condition("payrollGroupId", text(p.payrollGroupId))
    if (text(p.statusId)) query.condition("statusId", text(p.statusId))
    else query.condition("statusId", "not-equals", "PrnCancelled")
    const runs = Array.from(query.orderBy("-createdDate").limit(listCap).list())
    const runIds = runs.map(row => row.payrollRunId)
    const units = rowsIn(UNIT, "payrollRunId", runIds)
    const byRun = {}
    for (const unit of units) (byRun[unit.payrollRunId] ||= []).push(unit)
    const groups = Object.fromEntries(
        rowsIn(GROUP, "payrollGroupId", unique(runs.map(row => row.payrollGroupId))).map(row => [row.payrollGroupId, row])
    )
    const periods = Object.fromEntries(
        rowsIn(PERIOD, "timePeriodId", unique(runs.map(row => row.timePeriodId))).map(row => [row.timePeriodId, row])
    )
    const orgNames = people.organizationNames(unique(runs.map(row => row.organizationPartyId)))
    let list = runs.map(run => {
        const own = byRun[run.payrollRunId] || []
        const count = statusId => own.filter(unit => unit.statusId === statusId).length
        const calculated = own.filter(unit => unit.statusId === "PruCalculated")
        const sum = field => calculated.reduce((total, unit) => total.add(decimalOf(unit[field])), zero())
        const period = periods[run.timePeriodId]
        const approvalHolds = run.statusId !== "PrnApproved" || run.approvedRevision === runRevision(run.payrollRunId)
        const attention =
            changeableStatuses.includes(run.statusId) &&
            (count("PruError") > 0 ||
                (run.statusId === "PrnCalculating" && count("PruPending") > 0) ||
                !!run.returnedReason ||
                !approvalHolds)
        let stateText = runStateTexts[run.statusId] || run.statusId
        if (!approvalHolds) stateText = "Approval no longer holds"
        else if (run.statusId === "PrnReview" && run.returnedReason) stateText = "Returned"
        return {
            payrollRunId: run.payrollRunId,
            organizationPartyId: run.organizationPartyId,
            organizationName: orgNames[run.organizationPartyId] || run.organizationPartyId,
            payrollGroupId: run.payrollGroupId,
            groupName: groups[run.payrollGroupId]?.groupName || run.payrollGroupId,
            timePeriodId: run.timePeriodId,
            periodText: period ? lib.calendarDateText(period.fromDate) + " to " + lib.calendarDateText(period.thruDate) : "",
            periodFrom: period ? lib.calendarDateText(period.fromDate) : "",
            payDateText: lib.calendarDateText(run.payDate),
            kindText: kindTexts[run.runKindEnumId] || run.runKindEnumId,
            workerCount: own.filter(unit => unit.statusId !== "PruExcluded").length,
            excludedCount: count("PruExcluded"),
            errorCount: count("PruError"),
            pendingCount: count("PruPending"),
            grossText: moneyText(sum("grossAmount"), run.currencyUomId),
            netText: moneyText(sum("netAmount"), run.currencyUomId),
            statusId: run.statusId,
            state: !approvalHolds ? "stale" : run.statusId === "PrnReview" && run.returnedReason ? "returned" : run.statusId,
            stateText,
            attention
        }
    })
    if (text(p.show) === "attention") list = list.filter(row => row.attention)
    list.sort((a, b) => b.periodFrom.localeCompare(a.periodFrom) || String(b.payrollRunId).localeCompare(String(a.payrollRunId)))
    return Object.assign({canCreate: edits(userScope)}, lib.pageList(list, p, "runs", {noLimitCap: listCap}))
}

const operations = {
    findRuns,
    createRun,
    selectEmployments,
    calculateRun,
    getRun,
    submitRun,
    cancelRun,
    createCorrection,
    approveRun: p => decideRun(p, "approve"),
    returnRun: p => decideRun(p, "refuse")
}
function run(op, p) {
    if (!Object.hasOwn(operations, op)) throw new Error("Unknown pay run operation " + op)
    return operations[op](p || {})
}
;({
    execute: run,
    // for Approvals.js (PakPayrollRun): the revision an approval binds, and the run's group and period as a notice names them
    runRevision,
    runLabel,
    // for PayrollResults.js (P26): whether a slip's employment is still as its run calculated it
    unitHolds
})
