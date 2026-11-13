// People's pay inputs and hours for pay (mantle.humanres.PayrollInputServices get#Reconciliation, prepare#Inputs,
// store#Adjustment, find#Adjustments, decide#Adjustment and the PeoplePayAdjustmentApproval topic's services, and the source
// guards Mantle's time and invoice writers call; IronStone People design §6 HoursForPay, §8.1 PayrollInput and
// PayrollInputSource, §8 PayAdjustments, §12 ApprovalPolicies; PE-09, PE-07, PE-05; impl-people P24, F44).
//
// What a pay group's period pays (prepare#Inputs), per employment whose primary pay assignment puts it in the group on a day of
// the period, each employment in its own transaction under its lock, a refusal named and the rest going on:
// - worked hours of a day from the group's time basis alone (PayrollGroup.timeBasisEnumId): the approved timesheets' entries
//   (PtbTimesheets) or the approved attendance days (PtbAttendance: a corrected day, or a past day recorded with no flag); the
//   other stream is comparison evidence, never more paid hours; a group on the working schedule (PtbSchedule) records no time.
//   The day's entitlement (WORKED:<employment>:<day>) is one, whichever stream or adjustment pays it, so a day is paid once;
// - a time entry's pieces on an approved week, whatever the basis (PIECES:<entry>);
// - each working day of approved leave (LrsApproved, or a cancellation still asked), paid or unpaid as the policy says, in the
//   hours the employment's schedule plans for it (Leave.js chargedDays; LEAVE:<request>:<day>);
// - an approved expense claim reserved for payroll (ExpenseServices reserve#ClaimSettlement), in the group's currency
//   (CLAIM:<claim>).
// An unapproved week (or, on attendance, an unresolved day), a time entry on a worker invoice, a day of a person employed twice
// that no entry's employer settles, and a claim that conflicts with its reservation block that employment alone: nothing of it
// is prepared until it is fixed (or an adjustment resolves the day). Preparing again makes nothing twice: an input whose sources
// are as they were is kept, one whose sources changed (or are gone) is voided and prepared again unless it is finalized, and a
// source consumed once (PayrollInputSource.activeSourceKey, unique) or an entitlement paid once (activeEntitlementKey, unique)
// is never taken twice. Inputs from sources are approved: their sources are. Nothing here makes money move (design §2:
// calculation changes no money); no legacy payroll service or PayrollAdjustment row is read.
//
// Adjustments (store#Adjustment): a payroll editor's reasoned input of an employment: an amount of an earning or deduction
// component (a bonus; recurring, one dated input per prepared period through the recurrence end), a recovery of an advance's
// outstanding amount through a deduction component, or the hours of a day payroll resolves (a worked day's entitlement, so the
// stream does not pay it again). Each waits for a People approval of kind PakPayAdjustment (the employer's payroll approvers by
// default, never one who made or changed it, nor the person it pays) and is approved or refused by decide#Adjustment; a changed
// adjustment supersedes its request. A finalized input is never changed: a correction is a new input linked to it.
//
// Pay never leaves its lane (design §1.1, §2): amounts are answered only to a payroll reader (PAYROLL_VIEW) of the employer; the
// reconciliation, which a manager reads for their reports, carries hours and counts and never an amount; the approval notice
// names no person and no amount. Each service checks its caller first and reads and writes with authorization off after it.
const people = ec.resource.script("component://mr-mantle/service/mantle/humanres/People.js")
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const {find, one, rows, denied, call, dateText} = lib
const approvals = () => ec.resource.script("component://mr-mantle/service/mantle/humanres/Approvals.js")
const leave = () => ec.resource.script("component://mr-mantle/service/mantle/humanres/Leave.js")
const schedules = () => ec.resource.script("component://mr-mantle/service/mantle/humanres/Schedules.js")
const expense = () => ec.resource.script("component://mr-mantle/service/mantle/humanres/Expense.js")

const INPUT = "mantle.humanres.payroll.PayrollInput"
const SOURCE = "mantle.humanres.payroll.PayrollInputSource"
const GROUP = "mantle.humanres.payroll.PayrollGroup"
const GROUP_PERIOD = "mantle.humanres.payroll.PayrollGroupPeriod"
const ASSIGNMENT = "mantle.humanres.payroll.PayrollAssignment"
const COMPONENT = "mantle.humanres.payroll.PayrollComponent"
const TERM = "mantle.humanres.payroll.PayrollComponentTerm"
const PERIOD = "mantle.party.time.TimePeriod"
const RELATIONSHIP = "mantle.party.PartyRelationship"
const EMPLOYMENT = "mantle.humanres.employment.Employment"
const TIME_ENTRY = "mantle.work.time.TimeEntry"
const TIMESHEET = "mantle.work.time.Timesheet"
const ATTENDANCE_DAY = "mantle.humanres.attendance.AttendanceDay"
const LEAVE_REQUEST = "mantle.humanres.leave.LeaveRequest"
const LEAVE_SEGMENT = "mantle.humanres.leave.LeaveRequestSegment"
const LEAVE_POLICY = "mantle.humanres.leave.LeavePolicy"
const CLAIM = "mantle.humanres.expense.ExpenseClaim"
const ADVANCE = "mantle.humanres.expense.EmployeeAdvance"
const INVOICE = "mantle.account.invoice.Invoice"
const APPROVAL = "mantle.humanres.approval.PeopleApproval"
const KIND = "PakPayAdjustment"

const day = 24 * 60 * 60 * 1000
// the most employments a preparation or reconciliation reads, the time entries of one employment's period, and the periods a
// recurring adjustment makes
const memberCap = 500
const entryCap = 5000
const recurrenceCap = 24
const listCap = 2000
const maxTextLength = 255
// the hours an attendance stream and a timesheet stream may differ by before the reconciliation says so
const differenceHours = 0.25

const typeTexts = {
    PitWorked: "Worked hours",
    PitPaidLeave: "Paid leave",
    PitUnpaidLeave: "Unpaid leave",
    PitPieces: "Pieces",
    PitReimbursement: "Expense reimbursement",
    PitAdjustment: "Adjustment",
    PitAdvanceRecovery: "Advance recovery"
}
const inputNames = {
    PitWorked: "workedHours",
    PitPaidLeave: "paidLeaveHours",
    PitUnpaidLeave: "unpaidLeaveHours",
    PitPieces: "pieces",
    PitReimbursement: "reimbursement"
}
// the inputs of time a payroll editor may record for a day (a resolution of the reconciliation)
const resolutionTypes = ["PitWorked", "PitPaidLeave", "PitUnpaidLeave", "PitPieces"]
const statusTexts = {
    PinProposed: "Waiting for approval",
    PinApproved: "Approved",
    PinRefused: "Refused",
    PinVoided: "Voided",
    PinFinalized: "Finalized"
}
const basisTexts = {
    PtbTimesheets: "Approved timesheets",
    PtbAttendance: "Attendance",
    PtbSchedule: "Working schedule"
}
// the states that hold an entitlement and its sources
const liveStatuses = ["PinProposed", "PinApproved", "PinFinalized"]

const ms = lib.ms
const text = value => String(value ?? "").trim()
const blank = value => value == null || String(value).trim() === ""
const truthy = value => value === true || value === "true" || value === "Y"
const nowMs = () => ms(ec.user.nowTimestamp)
const unique = people.unique
const openAt = (row, at) => (ms(row.fromDate) ?? -Infinity) <= at && (ms(row.thruDate) ?? Infinity) > at
const voided = row => row.thruDate != null && ms(row.thruDate) <= (ms(row.fromDate) ?? -Infinity)
const overlaps = (row, fromMs, thruMs) =>
    !voided(row) && (ms(row.fromDate) ?? -Infinity) < thruMs && (ms(row.thruDate) ?? Infinity) > fromMs
const stampOf = row => ms(row?.lastUpdatedStamp) ?? 0
const splitIds = value =>
    blank(value)
        ? []
        : unique((Array.isArray(value) ? value : String(value).split(/[\s,;]+/)).map(id => text(id)).filter(Boolean))
const rowsIn = (entityName, field, ids) => (ids.length ? Array.from(find(entityName).condition(field, "in", ids).list()) : [])
const zero = () => toDecimal(0)
const decimalOf = value => (value == null || value === "" ? zero() : toDecimal(value))
const hoursText = value => ec.l10n.format(decimalOf(value), "#,##0.##")
const plain = value => (value == null ? "" : String(value))
const shortText = value => {
    const found = text(value)
    return found.length > maxTextLength ? found.substring(0, maxTextLength - 1) + "…" : found
}

// ===== days =====
// A group's days are calendar days in its workweek's zone (else the user's): a time entry counts on the day it starts there.
const zoneOf = group => text(group?.workweekTimeZone) || ec.user.timeZone
const dayStart = (dayText, zone) => ms(ec.l10n.parseTimestamp(dayText + " 00:00:00", "yyyy-MM-dd HH:mm:ss", null, zone))
const dayOf = (value, zone) => ec.l10n.format(new Date(ms(value)), "yyyy-MM-dd", null, zone)
function addDays(dayText, count) {
    const [y, m, d] = dayText.split("-").map(Number)
    const date = new Date(Date.UTC(y, m - 1, d + count))
    return [
        date.getUTCFullYear(),
        String(date.getUTCMonth() + 1).padStart(2, "0"),
        String(date.getUTCDate()).padStart(2, "0")
    ].join("-")
}
function daysFrom(fromDay, thruDay) {
    const out = []
    for (let current = fromDay; current <= thruDay && out.length < 400; current = addDays(current, 1)) out.push(current)
    return out
}
// a day given as a date (the user's zone) or as day text
function dayParam(value) {
    if (blank(value)) return null
    const found = text(value)
    if (/^\d{4}-\d{2}-\d{2}$/.test(found)) return found
    if (/^\d{4}-\d{2}-\d{2}[ T]/.test(found)) return found.slice(0, 10)
    return ec.l10n.format(new Date(ec.user.timestampMillis(value)), "yyyy-MM-dd")
}

// ===== access =====
// A payroll reader (PAYROLL_VIEW) reads every employment of the employers in their People scope; with manager, a manager
// (PEOPLE_TEAM_VIEW) reads their live reports at their lines' employers, without amounts (the reconciliation alone).
function readerScope(manager = false) {
    const userScope = people.scopeOf()
    const caps = userScope.capabilities
    if (caps.payrollView) return {userScope, payroll: true, reportLines: null}
    if (manager && caps.team && userScope.reportPartyIds.length)
        return {userScope, payroll: false, reportLines: userScope.reportLines || {}}
    denied("PERMISSION_DENIED", manager ? "Hours for pay are not available" : "Pay inputs are not available")
}
function editorScope() {
    const userScope = people.scopeOf()
    if (!(userScope.capabilities.payrollView && userScope.capabilities.payrollEdit))
        denied("PERMISSION_DENIED", "Preparing pay inputs needs PAYROLL_VIEW and PAYROLL_EDIT")
    return {userScope, payroll: true, reportLines: null}
}
// the employers a reader reaches: a payroll reader's People employers, a manager's lines' employers
const employersOf = access =>
    access.payroll ? access.userScope.organizationPartyIds : unique(Object.values(access.reportLines || {}).flat())
// whether the reader reads an employment's hours: a payroll reader by its employer, a manager by a live line to its person there
const readsMember = (access, member) =>
    access.payroll
        ? access.userScope.organizationPartyIds.includes(member.organizationPartyId)
        : ((access.reportLines || {})[member.partyId] || []).includes(member.organizationPartyId)
function groupFor(access, payrollGroupId) {
    const id = text(payrollGroupId)
    const group = id ? one(GROUP, {payrollGroupId: id}) : null
    if (!group || !employersOf(access).includes(group.organizationPartyId))
        denied("RECORD_UNAVAILABLE", "Pay group " + id + " is not available")
    return group
}
function periodOf(group, timePeriodId) {
    const id = text(timePeriodId)
    const link = id ? one(GROUP_PERIOD, {payrollGroupId: group.payrollGroupId, timePeriodId: id}) : null
    const period = link ? one(PERIOD, {timePeriodId: id}) : null
    if (!period) denied("PERIOD_UNAVAILABLE", "Choose a prepared period of the pay group")
    const fromDay = lib.calendarDateText(period.fromDate)
    const thruDay = lib.calendarDateText(period.thruDate)
    return {timePeriodId: id, fromDay, thruDay, payDate: lib.calendarDateText(link.payDate), text: fromDay + " to " + thruDay}
}
// An employment (PrtEmployee with its Employment row) of an employer in a payroll scope; refused alike when missing or outside.
function employmentIn(userScope, partyRelationshipId) {
    const id = text(partyRelationshipId)
    const row = id ? one(RELATIONSHIP, {partyRelationshipId: id}) : null
    if (
        !row ||
        row.relationshipTypeEnumId !== "PrtEmployee" ||
        !userScope.organizationPartyIds.includes(row.toPartyId) ||
        !one(EMPLOYMENT, {partyRelationshipId: id})
    )
        denied("RECORD_UNAVAILABLE", "Employment " + id + " is not available")
    return row
}

// ===== the group's employments =====
// The employments whose primary pay assignment puts them in the group on a day of the period, each with those days (the
// assignment and the employment both in effect at noon of the day, in the group's zone).
// P25 review: the assignments of the period are found by their dates in the database and in employment order, so a group with
// many past assignments loses no current member and a cut is always the same one; at most cap employments (a preparation's
// memberCap; a pay run asks more), the answer marked truncated when there are more, so a caller that must have every member
// (a run's population) refuses instead of paying some.
function groupMembers(group, period, zone, wanted = null, cap = memberCap) {
    const fromMs = dayStart(period.fromDay, zone)
    const thruMs = dayStart(addDays(period.thruDay, 1), zone)
    const factory = ec.entity.conditionFactory
    const query = find(ASSIGNMENT)
        .condition({payrollGroupId: group.payrollGroupId, isPrimary: "Y"})
        .condition(factory.makeCondition("fromDate", "less", new Date(thruMs), true))
        .condition(factory.makeCondition("thruDate", "greater", new Date(fromMs), true))
    if (wanted) query.condition("partyRelationshipId", "in", wanted.length ? wanted : ["-"])
    const assignmentCap = cap * 4
    const found = Array.from(
        query
            .orderBy("partyRelationshipId")
            .limit(assignmentCap + 1)
            .list()
    )
    const assignments = found.slice(0, assignmentCap).filter(row => overlaps(row, fromMs, thruMs))
    const byEmployment = {}
    for (const row of assignments) (byEmployment[row.partyRelationshipId] ||= []).push(row)
    const relationships = rowsIn(RELATIONSHIP, "partyRelationshipId", Object.keys(byEmployment)).sort((a, b) =>
        String(a.partyRelationshipId).localeCompare(String(b.partyRelationshipId))
    )
    const periodDays = daysFrom(period.fromDay, period.thruDay)
    const members = []
    for (const relationship of relationships) {
        const own = byEmployment[relationship.partyRelationshipId]
        const days = periodDays.filter(dayText => {
            const noon = dayStart(dayText, zone) + day / 2
            return openAt(relationship, noon) && own.some(row => openAt(row, noon))
        })
        if (!days.length) continue
        members.push({
            partyRelationshipId: relationship.partyRelationshipId,
            partyId: relationship.fromPartyId,
            organizationPartyId: relationship.toPartyId,
            relationship,
            days
        })
    }
    const kept = members.slice(0, cap)
    kept.truncated = members.length > cap || found.length > assignmentCap
    return kept
}

// ===== fingerprints =====
// What a source was when an input consumed it: a change of any of these since makes the input stale.
const fingerprintOf = {
    [TIME_ENTRY]: entry =>
        [
            entry.hours,
            entry.vendorHourRate,
            entry.vendorPieceRate,
            entry.pieceCount,
            ms(entry.fromDate),
            entry.partyId,
            entry.timesheetId
        ]
            .map(plain)
            .join("|"),
    [ATTENDANCE_DAY]: row =>
        [row.workedMinutes, row.statusEnumId, row.attendanceCorrectionId, row.flagsText].map(plain).join("|"),
    [LEAVE_REQUEST]: (request, hours) => [request.statusEnumId, request.leavePolicyId, hours].map(plain).join("|"),
    [CLAIM]: (claim, invoice) =>
        [claim.statusEnumId, claim.reservedRouteEnumId, invoice?.invoiceTotal, invoice?.currencyUomId].map(plain).join("|")
}

// ===== evidence =====
const hasPieces = entry => entry.pieceCount != null && decimalOf(entry.pieceCount).compare(0) > 0
// The person's employments (PrtEmployee) that settle which employment a time entry of a day belongs to.
function personEmployments(partyId) {
    return Array.from(find(RELATIONSHIP).condition({fromPartyId: partyId, relationshipTypeEnumId: "PrtEmployee"}).list())
}
// Which employment a day's entry is: the one employment then, else the one of the entry's employer (vendorPartyId), else none.
function ownerOf(entry, dayText, member, employments, zone) {
    const noon = dayStart(dayText, zone) + day / 2
    const open = employments.filter(row => !voided(row) && openAt(row, noon))
    if (open.length <= 1) return "ours"
    const matching = open.filter(row => row.toPartyId === entry.vendorPartyId)
    if (matching.length === 1) return matching[0].partyRelationshipId === member.partyRelationshipId ? "ours" : "theirs"
    return "ambiguous"
}
function timesheetEvidence(member, zone) {
    const daySet = new Set(member.days)
    const firstMs = dayStart(member.days[0], zone)
    const lastMs = dayStart(addDays(member.days[member.days.length - 1], 1), zone)
    const entries = Array.from(
        find(TIME_ENTRY)
            .condition("partyId", member.partyId)
            .condition("fromDate", "greater-equals", new Date(firstMs))
            .condition("fromDate", "less", new Date(lastMs))
            .orderBy(["fromDate", "timeEntryId"])
            .limit(entryCap)
            .list()
    )
    const sheets = Object.fromEntries(
        rowsIn(TIMESHEET, "timesheetId", unique(entries.map(row => row.timesheetId).filter(Boolean))).map(row => [
            row.timesheetId,
            row
        ])
    )
    const employments = personEmployments(member.partyId)
    const out = {
        submitted: zero(),
        approved: zero(),
        byDay: {},
        pieces: [],
        unapproved: {},
        invoiced: [],
        ambiguous: [],
        sheets
    }
    for (const entry of entries) {
        const entryDay = dayOf(entry.fromDate, zone)
        if (!daySet.has(entryDay)) continue
        const owner = ownerOf(entry, entryDay, member, employments, zone)
        if (owner === "theirs") continue
        if (owner === "ambiguous") {
            out.ambiguous.push({entry, day: entryDay})
            continue
        }
        const hours = decimalOf(entry.hours)
        out.submitted = out.submitted.add(hours)
        const sheet = entry.timesheetId ? sheets[entry.timesheetId] : null
        if (sheet?.statusId !== "TmshApproved") {
            const key = entry.timesheetId || "none"
            const week = (out.unapproved[key] ||= {
                timesheetId: entry.timesheetId || null,
                statusId: sheet?.statusId || null,
                days: [],
                pieces: false
            })
            if (!week.days.includes(entryDay)) week.days.push(entryDay)
            if (hasPieces(entry)) week.pieces = true
            continue
        }
        out.approved = out.approved.add(hours)
        ;(out.byDay[entryDay] ||= []).push(entry)
        if (entry.vendorInvoiceId) out.invoiced.push({entry, day: entryDay})
        if (hasPieces(entry)) out.pieces.push({entry, day: entryDay})
    }
    return out
}
// A day of attendance pays when it is approved for pay: corrected (its approved correction's minutes), or a past day recorded
// with no flag. A day with a correction asked, or flagged and not corrected, is unresolved; today's and later are not yet.
function attendanceEvidence(member, zone) {
    const days = Array.from(
        find(ATTENDANCE_DAY)
            .condition("partyRelationshipId", member.partyRelationshipId)
            .condition("attendanceDate", "greater-equals", member.days[0])
            .condition("attendanceDate", "less-equals", member.days[member.days.length - 1])
            .orderBy("attendanceDate")
            .list()
    )
    const daySet = new Set(member.days)
    const today = dayOf(nowMs(), zone)
    const out = {present: zero(), approved: zero(), byDay: {}, unresolved: [], notYet: []}
    for (const row of days) {
        const dayText = lib.calendarDateText(row.attendanceDate)
        if (!daySet.has(dayText)) continue
        const hours = decimalOf(row.workedMinutes).divide(60, 4, "HALF_UP")
        out.present = out.present.add(hours)
        const corrected = row.statusEnumId === "AdsCorrected"
        if (row.statusEnumId === "AdsCorrectionAsked" || (!corrected && !blank(row.flagsText))) {
            out.unresolved.push(dayText)
            continue
        }
        if (!corrected && dayText >= today) {
            out.notYet.push(dayText)
            continue
        }
        out.approved = out.approved.add(hours)
        out.byDay[dayText] = {row, hours}
    }
    return out
}
// Approved leave on the employment's days: each working day it charges, in the hours the schedule plans for it.
function leaveEvidence(member) {
    const requests = Array.from(
        find(LEAVE_REQUEST)
            .condition("partyRelationshipId", member.partyRelationshipId)
            .condition("fromDay", "less-equals", member.days[member.days.length - 1])
            .condition("thruDay", "greater-equals", member.days[0])
            .list()
    )
    const daySet = new Set(member.days)
    const out = {taken: [], waiting: []}
    for (const request of requests) {
        if (request.statusEnumId === "LrsRequested") {
            out.waiting.push(request)
            continue
        }
        if (!["LrsApproved", "LrsCancelRequested"].includes(request.statusEnumId)) continue
        const policy = request.leavePolicyId ? one(LEAVE_POLICY, {leavePolicyId: request.leavePolicyId}) : null
        const segments = rows(LEAVE_SEGMENT, {leaveRequestId: request.leaveRequestId}).map(row => ({
            fromDay: lib.calendarDateText(row.fromDay),
            thruDay: lib.calendarDateText(row.thruDay),
            dayPartEnumId: row.dayPartEnumId || "LdpFull"
        }))
        const charged = leave().chargedDays(member.relationship, segments, "LuHours")
        const days = charged
            .filter(row => daySet.has(row.day) && Number(row.charged) > 0)
            .map(row => ({day: row.day, hours: toDecimal(String(row.charged))}))
        if (days.length) out.taken.push({request, paid: policy?.isPaid === "Y", days})
    }
    return out
}
// Approved claims of the employment reserved for payroll and not yet paid by it; one whose currency is not the group's, or
// whose invoice left the received state (another route took it on), conflicts.
function claimEvidence(member, group) {
    const claims = Array.from(
        find(CLAIM).condition({partyRelationshipId: member.partyRelationshipId, reservedRouteEnumId: "EcrPayroll"}).list()
    )
    const out = {ready: [], conflicts: []}
    for (const claim of claims) {
        if (claim.statusEnumId !== "EcsApproved") continue
        const invoice = one(INVOICE, {invoiceId: claim.invoiceId})
        const taken = !!find(SOURCE)
            .condition({sourceEntityName: CLAIM, sourceId: claim.invoiceId})
            .condition("activeSourceKey", "is-not-null", null)
            .count()
        const conflict =
            invoice?.currencyUomId !== group.currencyUomId
                ? "in " + (invoice?.currencyUomId || "no currency") + ", not the group's " + group.currencyUomId
                : invoice?.statusId !== "InvoiceReceived" && !taken
                  ? "no longer held for payroll by finance"
                  : null
        if (conflict) out.conflicts.push({claim, text: "Expense claim " + claim.invoiceId + " is " + conflict})
        else out.ready.push({claim, invoice})
    }
    return out
}
// The live inputs of an employment in the group's period, with their sources.
function liveInputs(member, group, period) {
    const inputs = Array.from(
        find(INPUT)
            .condition({
                partyRelationshipId: member.partyRelationshipId,
                payrollGroupId: group.payrollGroupId,
                timePeriodId: period.timePeriodId
            })
            .condition("statusId", "in", liveStatuses)
            .list()
    )
    const sources = rowsIn(
        SOURCE,
        "payrollInputId",
        inputs.map(row => row.payrollInputId)
    )
    const byInput = {}
    for (const row of sources) (byInput[row.payrollInputId] ||= []).push(row)
    return inputs.map(input => ({input, sources: byInput[input.payrollInputId] || []}))
}
// The worked-day entitlements of the employment held by an adjustment (a day payroll resolved), whichever group or period.
function resolvedDays(member) {
    const keys = member.days.map(dayText => "WORKED:" + member.partyRelationshipId + ":" + dayText)
    return new Set(
        rowsIn(INPUT, "activeEntitlementKey", keys)
            .filter(row => row.isAdjustment === "Y")
            .map(row => lib.calendarDateText(row.inputDate))
    )
}

// ===== the plan =====
// What a period pays an employment: the planned inputs (each an entitlement with its sources), what blocks it and what is only
// said. With a cutoff, an entitlement not yet prepared whose sources changed after it waits for the next preparation.
function planOf(group, period, zone, member, cutoffMs = null) {
    const basis = group.timeBasisEnumId
    const sheets = timesheetEvidence(member, zone)
    const attendance = attendanceEvidence(member, zone)
    const leaveFound = leaveEvidence(member)
    const claims = claimEvidence(member, group)
    const resolved = resolvedDays(member)
    const problems = []
    const notes = []
    const planned = []
    const prid = member.partyRelationshipId
    const after = stamp => cutoffMs != null && stamp > cutoffMs
    // the timesheet weeks that block: every unapproved week on the timesheet basis (a day payroll resolved blocks nothing), a week
    // with pieces on any basis (P24 review: pieces are paid from approved weeks alone, so one not approved waited unseen)
    const blockingWeeks = Object.values(sheets.unapproved)
        .map(week =>
            Object.assign({}, week, {
                days: basis === "PtbTimesheets" ? week.days.filter(dayText => !resolved.has(dayText)) : week.days
            })
        )
        .filter(week => week.days.length && (basis === "PtbTimesheets" || week.pieces))
    if (blockingWeeks.length)
        problems.push({
            code: "WEEK_NOT_APPROVED",
            text:
                "Time not approved on " +
                blockingWeeks
                    .map(week => week.days.sort()[0] + (week.days.length > 1 ? " and " + (week.days.length - 1) + " more" : ""))
                    .join(", ")
        })
    // an entry on a worker invoice whose hours the basis would pay, or whose pieces payroll pays on any basis (P24 review: on the
    // attendance basis an invoiced entry's pieces were paid too)
    const invoiced = sheets.invoiced.filter(
        found => (basis === "PtbTimesheets" && !resolved.has(found.day)) || hasPieces(found.entry)
    )
    if (invoiced.length)
        problems.push({
            code: "WORKER_INVOICED",
            text: "Time entries on a worker invoice: " + unique(invoiced.map(found => found.entry.timeEntryId)).join(", ")
        })
    if (sheets.ambiguous.length && basis === "PtbTimesheets")
        problems.push({
            code: "EMPLOYMENT_AMBIGUOUS",
            text: "Time of another employment too on " + unique(sheets.ambiguous.map(found => found.day)).join(", ")
        })
    const unresolvedDays = attendance.unresolved.filter(dayText => !resolved.has(dayText))
    if (basis === "PtbAttendance" && unresolvedDays.length)
        problems.push({code: "ATTENDANCE_UNRESOLVED", text: "Attendance to resolve on " + unresolvedDays.join(", ")})
    for (const conflict of claims.conflicts) problems.push({code: "CLAIM_CONFLICT", text: conflict.text})
    if (leaveFound.waiting.length)
        notes.push({code: "LEAVE_WAITING", text: leaveFound.waiting.length + " leave request(s) still waiting for approval"})
    if (basis === "PtbAttendance" && attendance.notYet.length)
        notes.push({code: "DAYS_NOT_YET", text: "Attendance of " + attendance.notYet.join(", ") + " is not final yet"})

    // worked hours, from the basis's stream alone
    if (basis === "PtbTimesheets")
        for (const [dayText, entries] of Object.entries(sheets.byDay)) {
            if (resolved.has(dayText)) continue
            const rates = unique(entries.map(entry => plain(entry.vendorHourRate)))
            const quantity = entries.reduce((sum, entry) => sum.add(decimalOf(entry.hours)), zero())
            if (quantity.isZero()) continue
            planned.push({
                entitlementKey: "WORKED:" + prid + ":" + dayText,
                inputTypeEnumId: "PitWorked",
                inputDate: dayText,
                quantity,
                quantityUomId: "TF_hr",
                rateAmount: rates.length === 1 && rates[0] !== "" ? toDecimal(rates[0]) : null,
                deferred: entries.some(entry => after(stampOf(sheets.sheets[entry.timesheetId]))),
                sources: entries.map(entry => ({
                    sourceEntityName: TIME_ENTRY,
                    sourceId: entry.timeEntryId,
                    sourcePart: "hours",
                    sourceKey: TIME_ENTRY + ":" + entry.timeEntryId + ":hours",
                    quantity: decimalOf(entry.hours),
                    sourceRevision: fingerprintOf[TIME_ENTRY](entry)
                }))
            })
        }
    if (basis === "PtbAttendance")
        for (const [dayText, found] of Object.entries(attendance.byDay)) {
            if (resolved.has(dayText) || found.hours.isZero()) continue
            planned.push({
                entitlementKey: "WORKED:" + prid + ":" + dayText,
                inputTypeEnumId: "PitWorked",
                inputDate: dayText,
                quantity: found.hours,
                quantityUomId: "TF_hr",
                deferred: after(stampOf(found.row)),
                sources: [
                    {
                        sourceEntityName: ATTENDANCE_DAY,
                        sourceId: found.row.attendanceDayId,
                        sourcePart: "hours",
                        sourceKey: ATTENDANCE_DAY + ":" + found.row.attendanceDayId,
                        quantity: found.hours,
                        sourceRevision: fingerprintOf[ATTENDANCE_DAY](found.row)
                    }
                ]
            })
        }
    // pieces, whatever the basis
    for (const {entry, day: dayText} of sheets.pieces)
        planned.push({
            entitlementKey: "PIECES:" + entry.timeEntryId,
            inputTypeEnumId: "PitPieces",
            inputDate: dayText,
            quantity: decimalOf(entry.pieceCount),
            quantityUomId: "OTH_ea",
            rateAmount: entry.vendorPieceRate == null ? null : toDecimal(entry.vendorPieceRate),
            deferred: after(stampOf(sheets.sheets[entry.timesheetId])),
            sources: [
                {
                    sourceEntityName: TIME_ENTRY,
                    sourceId: entry.timeEntryId,
                    sourcePart: "pieces",
                    sourceKey: TIME_ENTRY + ":" + entry.timeEntryId + ":pieces",
                    quantity: decimalOf(entry.pieceCount),
                    sourceRevision: fingerprintOf[TIME_ENTRY](entry)
                }
            ]
        })
    // leave, paid or unpaid, a day at a time
    for (const taken of leaveFound.taken)
        for (const found of taken.days)
            planned.push({
                entitlementKey: "LEAVE:" + taken.request.leaveRequestId + ":" + found.day,
                inputTypeEnumId: taken.paid ? "PitPaidLeave" : "PitUnpaidLeave",
                inputDate: found.day,
                quantity: found.hours,
                quantityUomId: "TF_hr",
                deferred: after(ms(taken.request.decidedDate) ?? stampOf(taken.request)),
                sources: [
                    {
                        sourceEntityName: LEAVE_REQUEST,
                        sourceId: taken.request.leaveRequestId,
                        sourcePart: found.day,
                        sourceKey: LEAVE_REQUEST + ":" + taken.request.leaveRequestId + ":" + found.day,
                        quantity: found.hours,
                        sourceRevision: fingerprintOf[LEAVE_REQUEST](taken.request, String(found.hours))
                    }
                ]
            })
    // claims reserved for payroll
    for (const {claim, invoice} of claims.ready) {
        const reservedDay = claim.reservedDate ? dayOf(claim.reservedDate, zone) : period.thruDay
        planned.push({
            entitlementKey: "CLAIM:" + claim.invoiceId,
            inputTypeEnumId: "PitReimbursement",
            inputDate: reservedDay < period.fromDay || reservedDay > period.thruDay ? period.thruDay : reservedDay,
            amount: decimalOf(invoice?.invoiceTotal),
            currencyUomId: invoice?.currencyUomId || null,
            deferred: after(ms(claim.reservedDate) ?? stampOf(claim)),
            sources: [
                {
                    sourceEntityName: CLAIM,
                    sourceId: claim.invoiceId,
                    sourcePart: "claim",
                    sourceKey: CLAIM + ":" + claim.invoiceId,
                    amount: decimalOf(invoice?.invoiceTotal),
                    sourceRevision: fingerprintOf[CLAIM](claim, invoice)
                }
            ]
        })
    }
    return {basis, sheets, attendance, leave: leaveFound, claims, resolved, planned, problems, notes}
}
const signatureOf = (quantity, amount, sources) =>
    [plain(quantity), plain(amount)].concat(sources.map(row => row.sourceKey + "=" + row.sourceRevision).sort()).join(";")
const sameAs = (live, plannedInput) =>
    signatureOf(live.input.quantity, live.input.amount, live.sources) ===
    signatureOf(plannedInput.quantity ?? null, plannedInput.amount ?? null, plannedInput.sources)

// What preparing would do for an employment: the inputs to make, those kept as they are, those to void (a source changed or
// gone), those paid elsewhere, and the problems that block it.
function changesOf(group, period, zone, member, cutoffMs) {
    const plan = planOf(group, period, zone, member, cutoffMs)
    const live = liveInputs(member, group, period)
    const liveByKey = new Map(
        live.filter(row => row.input.activeEntitlementKey).map(row => [row.input.activeEntitlementKey, row])
    )
    const plannedKeys = new Set(plan.planned.map(row => row.entitlementKey))
    const elsewhere = new Map(
        rowsIn(
            INPUT,
            "activeEntitlementKey",
            plan.planned.map(row => row.entitlementKey).filter(key => !liveByKey.has(key))
        ).map(row => [row.activeEntitlementKey, row])
    )
    const changes = {plan, create: [], keep: [], void: [], elsewhere: [], deferred: [], finalizedChanged: []}
    for (const plannedInput of plan.planned) {
        const existing = liveByKey.get(plannedInput.entitlementKey)
        if (existing) {
            if (sameAs(existing, plannedInput)) changes.keep.push(existing.input)
            else if (existing.input.statusId === "PinFinalized") changes.finalizedChanged.push(existing.input)
            else if (existing.input.isAdjustment === "Y") changes.keep.push(existing.input)
            else {
                changes.void.push({input: existing.input, reason: "Its source changed since it was prepared"})
                changes.create.push(plannedInput)
            }
        } else if (elsewhere.has(plannedInput.entitlementKey)) changes.elsewhere.push(elsewhere.get(plannedInput.entitlementKey))
        else if (plannedInput.deferred) changes.deferred.push(plannedInput)
        else changes.create.push(plannedInput)
    }
    // an input prepared from sources that no longer pay (a week reopened, leave cancelled, a day no longer approved)
    for (const row of live)
        if (row.input.isAdjustment !== "Y" && !plannedKeys.has(row.input.activeEntitlementKey)) {
            if (row.input.statusId === "PinFinalized") changes.finalizedChanged.push(row.input)
            else changes.void.push({input: row.input, reason: "Its source no longer pays it"})
        }
    // a source another live input holds (not one voided here) is never taken twice
    const voidedIds = new Set(changes.void.map(row => row.input.payrollInputId))
    const sourceKeys = changes.create.flatMap(row => row.sources.map(source => source.sourceKey))
    const held = rowsIn(SOURCE, "activeSourceKey", sourceKeys).filter(row => !voidedIds.has(row.payrollInputId))
    if (held.length)
        plan.problems.push({
            code: "SOURCE_CONSUMED",
            text: "Already paid by another pay input: " + unique(held.map(row => row.sourceId)).join(", ")
        })
    if (changes.finalizedChanged.length)
        plan.notes.push({
            code: "PAID_SOURCE_CHANGED",
            text:
                changes.finalizedChanged.length +
                " finalized input(s) differ from their sources: a correction pays the difference"
        })
    if (changes.elsewhere.length)
        plan.notes.push({
            code: "PREPARED_ELSEWHERE",
            text: changes.elsewhere.length + " day(s) already prepared in another period or group"
        })
    if (changes.deferred.length)
        plan.notes.push({
            code: "AFTER_CUTOFF",
            text: changes.deferred.length + " input(s) changed after the cutoff wait for the next preparation"
        })
    return changes
}

// ===== writes =====
function createInput(member, group, period, values, operationKey) {
    const created = call("create#" + INPUT, {
        partyRelationshipId: member.partyRelationshipId,
        partyId: member.partyId,
        organizationPartyId: member.organizationPartyId,
        payrollGroupId: group.payrollGroupId,
        timePeriodId: period.timePeriodId,
        inputTypeEnumId: values.inputTypeEnumId,
        inputName: inputNames[values.inputTypeEnumId] || null,
        payrollComponentId: values.payrollComponentId || null,
        inputDate: values.inputDate,
        quantity: values.quantity ?? null,
        quantityUomId: values.quantity != null ? values.quantityUomId || null : null,
        amount: values.amount ?? null,
        currencyUomId: values.amount != null ? values.currencyUomId || null : null,
        rateAmount: values.rateAmount ?? null,
        statusId: values.statusId || "PinApproved",
        entitlementKey: values.entitlementKey || null,
        activeEntitlementKey: values.entitlementKey || null,
        isAdjustment: values.isAdjustment ? "Y" : "N",
        reason: values.reason || null,
        evidence: values.evidence || null,
        seriesInputId: values.seriesInputId || null,
        correctionOfInputId: values.correctionOfInputId || null,
        operationKey: operationKey || null,
        createdByUserId: ec.user.userId,
        createdDate: ec.user.nowTimestamp,
        changedByUserIds: values.isAdjustment ? ec.user.userId : null
    })
    const payrollInputId = created.payrollInputId
    // an adjustment's entitlement is its own until it is made
    if (!values.entitlementKey) {
        const key = "ADJ:" + payrollInputId
        call("update#" + INPUT, {payrollInputId, entitlementKey: key, activeEntitlementKey: key})
    }
    for (const source of values.sources || []) {
        const sourceKey = source.sourceKey.replace("{input}", payrollInputId)
        call("create#" + SOURCE, {
            payrollInputId,
            sourceEntityName: source.sourceEntityName,
            sourceId: source.sourceId,
            sourcePart: source.sourcePart || null,
            sourceKey,
            activeSourceKey: sourceKey,
            quantity: source.quantity ?? null,
            amount: source.amount ?? null,
            sourceRevision: source.sourceRevision || null,
            createdDate: ec.user.nowTimestamp
        })
    }
    return payrollInputId
}
// An input set aside (voided) or refused: its entitlement and sources released, so they are free to be paid again.
function releaseInput(input, statusId, reason) {
    call("update#" + INPUT, {
        payrollInputId: input.payrollInputId,
        statusId,
        statusId_changeReason: shortText(reason) || null,
        activeEntitlementKey: null,
        voidReason: statusId === "PinVoided" ? shortText(reason) || null : input.voidReason || null,
        voidedDate: statusId === "PinVoided" ? ec.user.nowTimestamp : input.voidedDate || null
    })
    for (const source of rows(SOURCE, {payrollInputId: input.payrollInputId}))
        if (source.activeSourceKey)
            call("update#" + SOURCE, {payrollInputSourceId: source.payrollInputSourceId, activeSourceKey: null})
}
const lockEmployment = partyRelationshipId => find(RELATIONSHIP, {partyRelationshipId}).forUpdate(true).one()
// The time entries new inputs take, locked and read again before they are consumed (P24 review): a worker invoice locks the
// entries it bills before it checks what payroll consumed (InvoiceServices create#TimeEntryInvoiceItems), so whichever commits
// first the other sees; one invoiced or changed since it was read refuses this employment's preparation, to be prepared again.
function lockEntries(changes) {
    const wanted = changes.create.flatMap(row => row.sources.filter(source => source.sourceEntityName === TIME_ENTRY))
    const ids = unique(wanted.map(source => source.sourceId))
    if (!ids.length) return
    const locked = Object.fromEntries(
        Array.from(find(TIME_ENTRY).condition("timeEntryId", "in", ids).forUpdate(true).list()).map(entry => [
            entry.timeEntryId,
            entry
        ])
    )
    const invoiced = ids.filter(id => locked[id]?.vendorInvoiceId)
    if (invoiced.length) denied("WORKER_INVOICED", "Time entries on a worker invoice: " + invoiced.join(", "))
    const changed = wanted.filter(
        source => !locked[source.sourceId] || fingerprintOf[TIME_ENTRY](locked[source.sourceId]) !== source.sourceRevision
    )
    if (changed.length)
        denied(
            "SOURCE_CHANGED",
            "Time entry " + unique(changed.map(source => source.sourceId)).join(", ") + " changed; prepare again"
        )
}

// ===== get#Reconciliation =====
// The group's period, employment by employment: the basis, hours scheduled, present (attendance), submitted and approved
// (timesheets), payable by the basis, leave paid and unpaid, pieces, claims reserved for payroll (a count), what is prepared
// and its state, the other stream's difference, and the problems and notes; with partyRelationshipId, that employment's days,
// sources and inputs. Hours and counts only: no amount, so a manager reads their reports' rows too.
function getReconciliation(p) {
    const access = readerScope(true)
    const group = groupFor(access, p.payrollGroupId)
    const period = periodOf(group, p.timePeriodId)
    const zone = zoneOf(group)
    const members = groupMembers(group, period, zone).filter(member => readsMember(access, member))
    const names = people.personNames(unique(members.map(member => member.partyId)))
    const term = text(p.term).toLowerCase()
    const state = text(p.state)
    const found = []
    let opened = null
    for (const member of members) {
        const personName = names[member.partyId] || member.partyId
        if (term && !personName.toLowerCase().includes(term)) continue
        let changes
        try {
            changes = changesOf(group, period, zone, member, null)
        } catch (error) {
            ec.logger.error("Hours for pay of employment " + member.partyRelationshipId + " were not read: " + error.message)
            found.push({
                partyRelationshipId: member.partyRelationshipId,
                partyId: member.partyId,
                personName,
                state: "failed",
                stateText: "Not read",
                problemsText: "Not read: see the log"
            })
            continue
        }
        const row = reconciliationRow(group, member, personName, changes, zone)
        if (state && row.state !== state) continue
        found.push(row)
        if (text(p.partyRelationshipId) === member.partyRelationshipId)
            opened = employmentDetail(group, period, member, personName, changes, access.payroll)
    }
    found.sort((a, b) => String(a.personName).localeCompare(String(b.personName)))
    const counts = {ready: 0, blocked: 0, prepared: 0, changed: 0}
    for (const row of found) if (counts[row.state] != null) counts[row.state]++
    return Object.assign(lib.pageList(found, p, "employments"), {
        group: {
            payrollGroupId: group.payrollGroupId,
            groupName: group.groupName,
            organizationPartyId: group.organizationPartyId,
            basisEnumId: group.timeBasisEnumId,
            basisText: basisTexts[group.timeBasisEnumId] || "",
            timeZone: zone
        },
        period,
        counts,
        employment: opened,
        canPrepare: access.payroll && !!access.userScope.capabilities.payrollEdit
    })
}
const stateTexts = {
    ready: "Ready to prepare",
    blocked: "Blocked",
    prepared: "Prepared",
    changed: "Changed since prepared",
    nothing: "Nothing to pay"
}
function reconciliationRow(group, member, personName, changes, zone) {
    const plan = changes.plan
    let scheduled = null
    try {
        const planned = schedules().scheduledDays([member.partyId], member.days)[member.partyId] || null
        if (planned) scheduled = member.days.reduce((sum, dayText) => sum.add(decimalOf(planned[dayText]?.hours)), zero())
    } catch (error) {
        ec.logger.error("The working schedule of " + member.partyId + " was not read for hours for pay: " + error.message)
    }
    const sumOf = type =>
        plan.planned.filter(row => row.inputTypeEnumId === type).reduce((sum, row) => sum.add(decimalOf(row.quantity)), zero())
    const payable =
        plan.basis === "PtbTimesheets"
            ? plan.sheets.approved
            : plan.basis === "PtbAttendance"
              ? plan.attendance.approved
              : scheduled
    const live = changes.keep.length + changes.finalizedChanged.length
    const state = plan.problems.length
        ? "blocked"
        : changes.void.length
          ? "changed"
          : changes.create.length
            ? "ready"
            : live
              ? "prepared"
              : "nothing"
    // the other stream, comparison evidence only
    let differenceText = ""
    if (plan.basis !== "PtbSchedule") {
        const other = plan.basis === "PtbTimesheets" ? plan.attendance.present : plan.sheets.submitted
        if (!other.isZero()) {
            const gap = other.subtract(payable ?? zero())
            if (Math.abs(gap.toNumber()) > differenceHours)
                differenceText =
                    (plan.basis === "PtbTimesheets" ? "Attendance " : "Timesheets ") +
                    (gap.compare(0) > 0 ? "+" : "") +
                    hoursText(gap)
        }
    }
    return {
        partyRelationshipId: member.partyRelationshipId,
        partyId: member.partyId,
        personName,
        organizationPartyId: member.organizationPartyId,
        dayCount: member.days.length,
        scheduledText: scheduled == null ? "No schedule" : hoursText(scheduled),
        presentText: hoursText(plan.attendance.present),
        submittedText: hoursText(plan.sheets.submitted),
        approvedText: hoursText(plan.sheets.approved),
        payableText: payable == null ? "" : hoursText(payable),
        paidLeaveText: hoursText(sumOf("PitPaidLeave")),
        unpaidLeaveText: hoursText(sumOf("PitUnpaidLeave")),
        piecesText: hoursText(sumOf("PitPieces")),
        claimCount: plan.claims.ready.length,
        differenceText,
        preparedCount: live,
        toPrepareCount: changes.create.length,
        toVoidCount: changes.void.length,
        state,
        stateText: stateTexts[state],
        problems: plan.problems,
        notes: plan.notes,
        problemsText: plan.problems.map(row => row.text).join("; "),
        notesText: plan.notes.map(row => row.text).join("; ")
    }
}
// An employment's days (scheduled, present, submitted and approved time, leave, what is prepared), the sources behind them
// (the timesheets with their state, the attendance days to resolve, the leave requests) and its live inputs (no amount).
// A manager reads its time inputs alone (P24 review): an adjustment, an advance recovery or a reimbursement is pay, payroll's.
function employmentDetail(group, period, member, personName, changes, payroll) {
    const plan = changes.plan
    const live = liveInputs(member, group, period).filter(row => payroll || resolutionTypes.includes(row.input.inputTypeEnumId))
    const inputsByDay = {}
    for (const row of live) (inputsByDay[lib.calendarDateText(row.input.inputDate)] ||= []).push(row.input)
    const days = member.days
        .map(dayText => {
            const entries = plan.sheets.byDay[dayText] || []
            const attended = plan.attendance.byDay[dayText]
            const dayInputs = inputsByDay[dayText] || []
            const leaveHours = plan.planned
                .filter(
                    row =>
                        row.inputDate === dayText &&
                        (row.inputTypeEnumId === "PitPaidLeave" || row.inputTypeEnumId === "PitUnpaidLeave")
                )
                .reduce((sum, row) => sum.add(row.quantity), zero())
            return {
                day: dayText,
                approvedText: entries.length
                    ? hoursText(entries.reduce((sum, entry) => sum.add(decimalOf(entry.hours)), zero()))
                    : "",
                presentText: attended
                    ? hoursText(attended.hours)
                    : plan.attendance.unresolved.includes(dayText)
                      ? "To resolve"
                      : "",
                leaveText: leaveHours.isZero() ? "" : hoursText(leaveHours),
                resolved: plan.resolved.has(dayText),
                inputsText: dayInputs
                    .map(
                        input =>
                            typeTexts[input.inputTypeEnumId] + (input.quantity != null ? " " + hoursText(input.quantity) : "")
                    )
                    .join(", ")
            }
        })
        .filter(row => row.approvedText || row.presentText || row.leaveText || row.inputsText)
    const sheets = Object.values(plan.sheets.sheets).map(sheet => ({
        timesheetId: sheet.timesheetId,
        weekText: dayOf(sheet.fromDate, ec.user.timeZone) + " to " + dayOf(sheet.thruDate, ec.user.timeZone),
        statusId: sheet.statusId || "TmshInProcess",
        statusText: sheet.statusId === "TmshApproved" ? "Approved" : sheet.statusId === "TmshCompleted" ? "Submitted" : "Open"
    }))
    const leaveRows = plan.leave.taken
        .map(taken => ({
            leaveRequestId: taken.request.leaveRequestId,
            text:
                (taken.paid ? "Paid" : "Unpaid") +
                " leave " +
                lib.calendarDateText(taken.request.fromDay) +
                " to " +
                lib.calendarDateText(taken.request.thruDay),
            stateText: "Approved"
        }))
        .concat(
            plan.leave.waiting.map(request => ({
                leaveRequestId: request.leaveRequestId,
                text: "Leave " + lib.calendarDateText(request.fromDay) + " to " + lib.calendarDateText(request.thruDay),
                stateText: "Waiting for approval"
            }))
        )
    return {
        partyRelationshipId: member.partyRelationshipId,
        partyId: member.partyId,
        personName,
        days,
        timesheets: sheets,
        unresolvedDays: plan.attendance.unresolved,
        leave: leaveRows,
        inputs: live.map(row => inputRow(row.input, false)),
        problems: plan.problems,
        notes: plan.notes
    }
}

// ===== prepare#Inputs =====
// A group's period prepared (or previewed): for each employment of it (or of partyRelationshipIds), in its own transaction under
// its lock, the inputs its approved sources pay made once, those whose sources changed voided and made again, nothing for an
// employment something blocks (named, the rest going on). A retry, or preparing again, makes nothing twice.
function prepareInputs(p) {
    const preview = truthy(p.preview)
    const access = preview ? readerScope(false) : editorScope()
    const group = groupFor(access, p.payrollGroupId)
    const period = periodOf(group, p.timePeriodId)
    if ((ms(group.thruDate) ?? Infinity) <= dayStart(period.fromDay, zoneOf(group)))
        denied("GROUP_ENDED", "This pay group ended before the period")
    const zone = zoneOf(group)
    const wanted = splitIds(p.partyRelationshipIds)
    const members = groupMembers(group, period, zone, wanted.length ? wanted : null)
    const cutoffMs = blank(p.cutoffDate) ? null : ec.user.timestampMillis(p.cutoffDate)
    const operationKey = text(p.operationKey) || null
    const names = people.personNames(unique(members.map(member => member.partyId)))
    const out = []
    for (const member of members) {
        const row = {
            partyRelationshipId: member.partyRelationshipId,
            partyId: member.partyId,
            personName: names[member.partyId] || member.partyId,
            outcome: "ready",
            createdCount: 0,
            keptCount: 0,
            voidedCount: 0,
            reasonCode: null,
            message: ""
        }
        const work = () => {
            if (!preview) lockEmployment(member.partyRelationshipId)
            const changes = changesOf(group, period, zone, member, cutoffMs)
            row.keptCount = changes.keep.length
            if (changes.plan.problems.length) {
                row.outcome = "blocked"
                row.reasonCode = changes.plan.problems[0].code
                row.message = changes.plan.problems.map(problem => problem.text).join("; ")
                return
            }
            row.createdCount = changes.create.length
            row.voidedCount = changes.void.length
            row.message = changes.plan.notes.map(note => note.text).join("; ")
            if (preview) return
            lockEntries(changes)
            for (const found of changes.void) releaseInput(found.input, "PinVoided", found.reason)
            for (const plannedInput of changes.create) createInput(member, group, period, plannedInput, operationKey)
            row.outcome = changes.create.length || changes.void.length ? "done" : "repeated"
        }
        if (preview)
            try {
                work()
            } catch (error) {
                refused(row, error, "Hours for pay of " + member.partyRelationshipId)
            }
        else {
            ec.message.pushErrors()
            try {
                ec.transaction.runRequireNew(null, "Preparing pay inputs of " + member.partyRelationshipId + " failed", () => {
                    work()
                    if (ec.message.hasError()) throw new Error(ec.message.getErrorsString())
                })
            } catch (error) {
                refused(row, error, "Preparing pay inputs of " + member.partyRelationshipId)
            } finally {
                ec.message.clearErrors()
                ec.message.popErrors()
            }
        }
        out.push(row)
    }
    out.sort((a, b) => String(a.personName).localeCompare(String(b.personName)))
    return {
        rows: out,
        createdCount: out.reduce(
            (sum, row) => sum + (row.outcome === "blocked" || row.outcome === "refused" ? 0 : row.createdCount),
            0
        ),
        blockedCount: out.filter(row => row.outcome === "blocked" || row.outcome === "refused").length,
        period
    }
}
function refused(row, error, what) {
    if (!lib.reasonCode(error)) ec.logger.error(what + " failed: " + error.message)
    row.outcome = "refused"
    row.reasonCode = lib.reasonCode(error) || "FAILED"
    row.message = String(error?.message || error).replace(/^[A-Z][A-Z0-9_]+: /, "")
}

// ===== adjustments =====
// The primary pay group of an employment on a day, and its prepared period holding the day.
function groupOn(partyRelationshipId, dayText) {
    const candidates = Array.from(find(ASSIGNMENT).condition({partyRelationshipId, isPrimary: "Y"}).list()).filter(
        row => !voided(row)
    )
    for (const assignment of candidates) {
        const group = one(GROUP, {payrollGroupId: assignment.payrollGroupId})
        if (!group) continue
        const zone = zoneOf(group)
        if (!openAt(assignment, dayStart(dayText, zone) + day / 2)) continue
        return {group, zone}
    }
    denied("NO_PAY_GROUP", "The employment is in no pay group on " + dayText)
}
function periodHolding(group, dayText) {
    for (const link of rows(GROUP_PERIOD, {payrollGroupId: group.payrollGroupId})) {
        const period = one(PERIOD, {timePeriodId: link.timePeriodId})
        if (period && lib.calendarDateText(period.fromDate) <= dayText && lib.calendarDateText(period.thruDate) >= dayText)
            return periodOf(group, link.timePeriodId)
    }
    denied("PERIOD_NOT_PREPARED", "The pay group has no prepared period holding " + dayText + "; prepare its periods first")
}
// A component an adjustment may be to: the employer's, not ended, an earning or a deduction (a recovery a deduction), with a
// published term in effect on the day in the group's currency.
function adjustableComponent(employerPartyId, payrollComponentId, dayText, zone, group, recovery) {
    const component = payrollComponentId ? one(COMPONENT, {payrollComponentId}) : null
    if (!component || component.organizationPartyId !== employerPartyId)
        denied("RECORD_UNAVAILABLE", "Pay component " + (payrollComponentId || "") + " is not available")
    const allowed = recovery ? ["PckDeduction"] : ["PckEarning", "PckDeduction"]
    if (!allowed.includes(component.componentKindEnumId))
        denied("KIND_INVALID", recovery ? "An advance is recovered through a deduction" : "Adjust an earning or a deduction")
    const at = dayStart(dayText, zone) + day / 2
    if ((ms(component.thruDate) ?? Infinity) <= at) denied("COMPONENT_ENDED", "This component has ended")
    const term = rows(TERM, {payrollComponentId}).find(row => row.statusId === "PtsPublished" && openAt(row, at))
    if (!term) denied("COMPONENT_NOT_IN_EFFECT", "The component has no published term on " + dayText)
    if (term.currencyUomId && term.currencyUomId !== group.currencyUomId)
        denied("CURRENCY_MISMATCH", "The component is in " + term.currencyUomId + ", the pay group in " + group.currencyUomId)
    return component
}
function amountParam(value, label, allowNegative = false) {
    if (blank(value)) return null
    let found
    try {
        found = toDecimal(String(value).trim())
    } catch (error) {
        denied("AMOUNT_INVALID", label + " is not a number")
    }
    if (found.isZero() || (!allowNegative && found.compare(0) < 0)) denied("AMOUNT_INVALID", label + " is more than zero")
    return found
}
// An adjustment's series (the inputs of one recurrence, or the one input), each read again.
const seriesOf = input =>
    input.seriesInputId
        ? Array.from(find(INPUT).condition("seriesInputId", input.seriesInputId).orderBy("inputDate").list())
        : [input]
const leadOf = input => (input.seriesInputId ? one(INPUT, {payrollInputId: input.seriesInputId}) : input)
const seriesRevision = lead => String(Math.max(0, ...seriesOf(lead).map(stampOf)))
function readableInput(userScope, payrollInputId) {
    const id = text(payrollInputId)
    const input = id ? one(INPUT, {payrollInputId: id}) : null
    if (!input || !userScope.organizationPartyIds.includes(input.organizationPartyId))
        denied("RECORD_UNAVAILABLE", "Pay input " + id + " is not available")
    return input
}
// What an advance has left to recover: its outstanding amount less the recoveries made and not voided or refused.
function advanceLeft(advance, exceptSeriesId = null) {
    const outstanding = expense().advanceMoney(advance).outstanding
    const recoveries = Array.from(
        find(SOURCE)
            .condition({sourceEntityName: ADVANCE, sourceId: advance.employeeAdvanceId})
            .condition("activeSourceKey", "is-not-null", null)
            .list()
    )
    const inputs = rowsIn(
        INPUT,
        "payrollInputId",
        recoveries.map(row => row.payrollInputId)
    ).filter(input => !exceptSeriesId || (input.seriesInputId || input.payrollInputId) !== exceptSeriesId)
    return inputs.reduce((left, input) => left.subtract(decimalOf(input.amount)), decimalOf(outstanding))
}

// store#Adjustment: a payroll editor's adjustment made (and its approval asked), changed while it waits (the request asked
// again), or withdrawn (voided, the request superseded), at the revision read.
function storeAdjustment(p) {
    const {userScope} = editorScope()
    if (text(p.payrollInputId)) return changeAdjustment(userScope, p)
    const employment = employmentIn(userScope, p.partyRelationshipId)
    // locked before its checks (P24 review): two recoveries of one advance at once cannot both pass its outstanding
    lockEmployment(employment.partyRelationshipId)
    const inputTypeEnumId = text(p.inputTypeEnumId) || (text(p.employeeAdvanceId) ? "PitAdvanceRecovery" : "PitAdjustment")
    if (!typeTexts[inputTypeEnumId] || inputTypeEnumId === "PitReimbursement")
        denied("TYPE_INVALID", "Choose an adjustment, an advance recovery or the hours of a day")
    const reason = shortText(p.reason)
    if (!reason) denied("REASON_REQUIRED", "Give the reason for the adjustment")
    const dayText = dayParam(p.inputDate ?? p.fromDate) || ec.l10n.format(ec.user.nowTimestamp, "yyyy-MM-dd")
    const noon = dayStart(dayText, ec.user.timeZone) + day / 2
    if (!openAt(employment, noon)) denied("DATE_OUTSIDE", "The employment is not in effect on " + dayText)
    const {group, zone} = groupOn(employment.partyRelationshipId, dayText)
    const member = {
        partyRelationshipId: employment.partyRelationshipId,
        partyId: employment.fromPartyId,
        organizationPartyId: employment.toPartyId
    }
    const evidence = shortText(p.evidence) || null
    const correction = text(p.correctionOfInputId) ? readableInput(userScope, p.correctionOfInputId) : null
    if (correction) {
        if (correction.partyRelationshipId !== employment.partyRelationshipId)
            denied("CORRECTION_INVALID", "A correction is of the same employment's input")
        if (correction.statusId !== "PinFinalized")
            denied("CORRECTION_INVALID", "Only a finalized input is corrected; void or change one not finalized")
    }
    const recovery = inputTypeEnumId === "PitAdvanceRecovery"
    const resolution = resolutionTypes.includes(inputTypeEnumId)
    let values
    if (resolution) {
        const quantity = amountParam(p.quantity, "The quantity", !!correction)
        if (!quantity) denied("QUANTITY_REQUIRED", "Enter the quantity")
        if (inputTypeEnumId !== "PitPieces" && quantity.abs().compare(24) > 0)
            denied("QUANTITY_INVALID", "A day has at most 24 hours")
        const period = periodHolding(group, dayText)
        const key =
            inputTypeEnumId === "PitWorked" && !correction ? "WORKED:" + employment.partyRelationshipId + ":" + dayText : null
        if (key && one(INPUT, {activeEntitlementKey: key}))
            denied("ENTITLEMENT_PAID", "The hours of " + dayText + " are prepared already; void them or correct them instead")
        values = [
            {
                period,
                inputDate: dayText,
                quantity,
                quantityUomId: inputTypeEnumId === "PitPieces" ? "OTH_ea" : "TF_hr",
                entitlementKey: key
            }
        ]
    } else {
        const component = adjustableComponent(employment.toPartyId, text(p.payrollComponentId), dayText, zone, group, recovery)
        const amount = amountParam(p.amount, "The amount", !!correction)
        if (!amount) denied("AMOUNT_REQUIRED", "Enter the amount")
        if (!blank(p.currencyUomId) && text(p.currencyUomId) !== group.currencyUomId)
            denied("CURRENCY_MISMATCH", "An adjustment is in the pay group's currency, " + group.currencyUomId)
        let advance = null
        if (recovery) {
            advance = text(p.employeeAdvanceId) ? one(ADVANCE, {employeeAdvanceId: text(p.employeeAdvanceId)}) : null
            if (!advance || advance.partyRelationshipId !== employment.partyRelationshipId)
                denied("RECORD_UNAVAILABLE", "Employee advance " + text(p.employeeAdvanceId) + " is not available")
            if (advance.currencyUomId !== group.currencyUomId)
                denied(
                    "CURRENCY_MISMATCH",
                    "The advance is in " + advance.currencyUomId + ", the pay group in " + group.currencyUomId
                )
        }
        // one input a period from the day's through the recurrence end's (each at its period's first day after the first)
        const thruDay = dayParam(p.recurThruDate)
        if (thruDay && (recovery || correction)) denied("RECURRENCE_INVALID", "A recovery or a correction does not recur")
        if (thruDay && thruDay < dayText) denied("RECURRENCE_INVALID", "The recurrence ends on or after the first date")
        const first = periodHolding(group, dayText)
        const periods = [first]
        if (thruDay) {
            let next = addDays(first.thruDay, 1)
            while (next <= thruDay) {
                if (periods.length >= recurrenceCap)
                    denied("RECURRENCE_INVALID", "A recurrence makes at most " + recurrenceCap + " inputs")
                const period = periodHolding(group, next)
                periods.push(period)
                next = addDays(period.thruDay, 1)
            }
        }
        if (advance) {
            const left = advanceLeft(advance)
            if (amount.compare(left) > 0)
                denied("AMOUNT_OVER_OUTSTANDING", "The advance has " + ec.l10n.format(left, "#,##0.00") + " left to recover")
        }
        values = periods.map((period, index) => ({
            period,
            inputDate: index === 0 ? dayText : period.fromDay,
            amount,
            currencyUomId: group.currencyUomId,
            payrollComponentId: component.payrollComponentId,
            advance
        }))
    }
    const operationKey = text(p.operationKey) || null
    if (operationKey) {
        const first = Array.from(
            find(INPUT)
                .condition({operationKey, createdByUserId: ec.user.userId, isAdjustment: "Y"})
                .orderBy("payrollInputId")
                .limit(1)
                .list()
        )[0]
        if (first) return adjustmentAnswer(leadOf(first), true)
    }
    let leadId = null
    for (const value of values) {
        const payrollInputId = createInput(
            member,
            group,
            value.period,
            {
                inputTypeEnumId,
                payrollComponentId: value.payrollComponentId || null,
                inputDate: value.inputDate,
                quantity: value.quantity ?? null,
                quantityUomId: value.quantityUomId || null,
                amount: value.amount ?? null,
                currencyUomId: value.currencyUomId || null,
                statusId: "PinProposed",
                entitlementKey: value.entitlementKey || null,
                isAdjustment: true,
                reason,
                evidence,
                seriesInputId: leadId,
                correctionOfInputId: correction?.payrollInputId || null,
                sources: value.advance
                    ? [
                          {
                              sourceEntityName: ADVANCE,
                              sourceId: value.advance.employeeAdvanceId,
                              sourcePart: "recovery",
                              // each recovery its own key: an advance is recovered over several inputs
                              sourceKey: ADVANCE + ":" + value.advance.employeeAdvanceId + ":{input}",
                              amount: value.amount,
                              sourceRevision: null
                          }
                      ]
                    : []
            },
            operationKey
        )
        if (!leadId) {
            leadId = payrollInputId
            if (values.length > 1) call("update#" + INPUT, {payrollInputId, seriesInputId: payrollInputId})
        }
    }
    const lead = one(INPUT, {payrollInputId: leadId})
    askApproval(lead, reason)
    return adjustmentAnswer(one(INPUT, {payrollInputId: leadId}), false)
}
function askApproval(lead, reason) {
    approvals().request({
        approvalKindEnumId: KIND,
        sourceEntityName: INPUT,
        sourceId: lead.payrollInputId,
        organizationPartyId: lead.organizationPartyId,
        subjectPartyId: lead.partyId,
        effectiveDate: lead.inputDate ? new Date(dayStart(lib.calendarDateText(lead.inputDate), ec.user.timeZone)) : null,
        justification: reason
    })
}
const adjustmentAnswer = (lead, repeated) => ({
    payrollInputId: lead.payrollInputId,
    statusId: lead.statusId,
    revision: seriesRevision(lead),
    inputCount: seriesOf(lead).length,
    repeated
})
// A waiting adjustment changed (its amount or quantity, component, evidence or reason; the date of a one-off one) and asked for
// again, or withdrawn (void) while it is not finalized; at the series' revision.
function changeAdjustment(userScope, p) {
    const found = readableInput(userScope, p.payrollInputId)
    if (found.isAdjustment !== "Y") denied("NOT_ADJUSTMENT", "A prepared input changes with its source, not here")
    lockEmployment(found.partyRelationshipId)
    const lead = leadOf(found)
    const series = seriesOf(lead)
    if (!blank(p.expectedRevision) && text(p.expectedRevision) !== seriesRevision(lead))
        denied("REVISION_CHANGED", "This adjustment changed since it was read; open it again")
    const reason = shortText(p.reason)
    if (truthy(p.void)) {
        if (series.some(input => input.statusId === "PinFinalized"))
            denied("INPUT_FINALIZED", "A finalized input is corrected, not voided")
        const live = series.filter(input => input.statusId === "PinProposed" || input.statusId === "PinApproved")
        if (!live.length) denied("NOT_LIVE", "This adjustment is " + (statusTexts[lead.statusId] || lead.statusId).toLowerCase())
        if (!reason) denied("REASON_REQUIRED", "Give the reason for withdrawing it")
        for (const input of live) releaseInput(input, "PinVoided", reason)
        approvals().sourceChanged(KIND, lead.payrollInputId, INPUT, true)
        return adjustmentAnswer(one(INPUT, {payrollInputId: lead.payrollInputId}), false)
    }
    if (series.some(input => input.statusId !== "PinProposed"))
        denied("NOT_PROPOSED", "Only an adjustment waiting for approval changes; withdraw it and make another")
    const changes = {}
    const evidence = p.evidence === undefined ? undefined : shortText(p.evidence) || null
    if (evidence !== undefined) changes.evidence = evidence
    if (reason) changes.reason = reason
    if (!blank(p.amount)) {
        if (lead.amount == null) denied("AMOUNT_INVALID", "This adjustment is a quantity")
        changes.amount = amountParam(p.amount, "The amount", !!lead.correctionOfInputId)
        const advanceSource = rows(SOURCE, {payrollInputId: lead.payrollInputId}).find(row => row.sourceEntityName === ADVANCE)
        if (advanceSource) {
            const advance = one(ADVANCE, {employeeAdvanceId: advanceSource.sourceId})
            const left = advanceLeft(advance, lead.seriesInputId || lead.payrollInputId)
            if (changes.amount.compare(left) > 0)
                denied("AMOUNT_OVER_OUTSTANDING", "The advance has " + ec.l10n.format(left, "#,##0.00") + " left to recover")
        }
    }
    if (!blank(p.quantity)) {
        if (lead.quantity == null) denied("QUANTITY_INVALID", "This adjustment is an amount")
        changes.quantity = amountParam(p.quantity, "The quantity", !!lead.correctionOfInputId)
    }
    if (!blank(p.payrollComponentId) && text(p.payrollComponentId) !== lead.payrollComponentId) {
        if (!lead.payrollComponentId) denied("COMPONENT_INVALID", "This adjustment is of hours, not a component")
        const group = one(GROUP, {payrollGroupId: lead.payrollGroupId})
        adjustableComponent(
            lead.organizationPartyId,
            text(p.payrollComponentId),
            lib.calendarDateText(lead.inputDate),
            zoneOf(group),
            group,
            lead.inputTypeEnumId === "PitAdvanceRecovery"
        )
        changes.payrollComponentId = text(p.payrollComponentId)
    }
    const changedBy = unique(splitIds(lead.changedByUserIds).concat([ec.user.userId])).join(",")
    for (const input of series)
        call("update#" + INPUT, Object.assign({payrollInputId: input.payrollInputId, changedByUserIds: changedBy}, changes))
    for (const source of rows(SOURCE, {payrollInputId: lead.payrollInputId}))
        if (source.sourceEntityName === ADVANCE && changes.amount)
            call("update#" + SOURCE, {payrollInputSourceId: source.payrollInputSourceId, amount: changes.amount})
    const changed = one(INPUT, {payrollInputId: lead.payrollInputId})
    approvals().sourceChanged(KIND, lead.payrollInputId, INPUT)
    askApproval(changed, changed.reason)
    return adjustmentAnswer(one(INPUT, {payrollInputId: lead.payrollInputId}), false)
}

// ===== find#Adjustments =====
const inputRow = (input, withAmounts, names = {}, components = {}, periods = {}) => {
    const component = input.payrollComponentId ? components[input.payrollComponentId] : null
    const period = input.timePeriodId ? periods[input.timePeriodId] : null
    return {
        payrollInputId: input.payrollInputId,
        partyRelationshipId: input.partyRelationshipId,
        partyId: input.partyId,
        personName: names[input.partyId] || input.partyId,
        organizationPartyId: input.organizationPartyId,
        inputTypeEnumId: input.inputTypeEnumId,
        typeText: typeTexts[input.inputTypeEnumId] || input.inputTypeEnumId,
        componentText: component ? component.componentName || component.componentCode : "",
        payrollComponentId: input.payrollComponentId || null,
        inputDateText: lib.calendarDateText(input.inputDate),
        periodText: period ? lib.calendarDateText(period.fromDate) + " to " + lib.calendarDateText(period.thruDate) : "",
        timePeriodId: input.timePeriodId || null,
        quantityText: input.quantity == null ? "" : hoursText(input.quantity) + (input.quantityUomId === "TF_hr" ? " h" : ""),
        amount: withAmounts && input.amount != null ? String(input.amount) : null,
        currencyUomId: withAmounts ? input.currencyUomId || null : null,
        amountText:
            withAmounts && input.amount != null
                ? ec.l10n.format(decimalOf(input.amount), "#,##0.00") + " " + (input.currencyUomId || "")
                : "",
        statusId: input.statusId,
        stateText: statusTexts[input.statusId] || input.statusId,
        reason: withAmounts ? input.reason || "" : "",
        evidence: withAmounts ? input.evidence || "" : "",
        isAdjustment: input.isAdjustment === "Y",
        seriesInputId: input.seriesInputId || null,
        correctionOfInputId: input.correctionOfInputId || null,
        voidReason: input.voidReason || ""
    }
}
// The adjustments of the employers a payroll reader reads, newest first: by employer, employment, person's name, component,
// period, state, or those waiting for the caller's decision (show decide); each with its amount or quantity, its source, its
// state, its approval and what the caller may do. Paged.
function findAdjustments(p) {
    const {userScope} = readerScope(false)
    const caps = userScope.capabilities
    const organizationPartyIds = text(p.organizationPartyId) ? [text(p.organizationPartyId)] : userScope.organizationPartyIds
    people.requireOrganization(userScope, text(p.organizationPartyId) || null)
    if (!organizationPartyIds.length) return Object.assign(lib.pageList([], p, "adjustments"), {canEdit: false})
    let query = find(INPUT)
        .condition("organizationPartyId", "in", organizationPartyIds)
        .condition("isAdjustment", "Y")
        .orderBy(["-createdDate", "-payrollInputId"])
    if (text(p.partyRelationshipId)) query = query.condition("partyRelationshipId", text(p.partyRelationshipId))
    if (text(p.payrollComponentId)) query = query.condition("payrollComponentId", text(p.payrollComponentId))
    if (text(p.timePeriodId)) query = query.condition("timePeriodId", text(p.timePeriodId))
    if (text(p.payrollGroupId)) query = query.condition("payrollGroupId", text(p.payrollGroupId))
    if (text(p.statusId)) query = query.condition("statusId", text(p.statusId))
    let inputs = Array.from(query.limit(listCap).list())
    const leads = new Map()
    for (const input of inputs) {
        const leadId = input.seriesInputId || input.payrollInputId
        if (!leads.has(leadId)) leads.set(leadId, leadId === input.payrollInputId ? input : one(INPUT, {payrollInputId: leadId}))
    }
    const summaries = {}
    for (const [leadId] of leads)
        try {
            summaries[leadId] = approvals().sourceSummary(KIND, leadId, INPUT)
        } catch (error) {
            ec.logger.error("The approval of pay adjustment " + leadId + " was not read: " + error.message)
        }
    if (text(p.show) === "decide")
        inputs = inputs.filter(input => summaries[input.seriesInputId || input.payrollInputId]?.canDecide)
    const names = people.personNames(unique(inputs.map(input => input.partyId)))
    const term = text(p.term).toLowerCase()
    if (term)
        inputs = inputs.filter(input =>
            String(names[input.partyId] || input.partyId)
                .toLowerCase()
                .includes(term)
        )
    const components = Object.fromEntries(
        rowsIn(COMPONENT, "payrollComponentId", unique(inputs.map(input => input.payrollComponentId).filter(Boolean))).map(
            row => [row.payrollComponentId, row]
        )
    )
    const periods = Object.fromEntries(
        rowsIn(PERIOD, "timePeriodId", unique(inputs.map(input => input.timePeriodId).filter(Boolean))).map(row => [
            row.timePeriodId,
            row
        ])
    )
    const sources = rowsIn(
        SOURCE,
        "payrollInputId",
        inputs.map(input => input.payrollInputId)
    )
    const sourceOf = {}
    for (const row of sources) sourceOf[row.payrollInputId] = row
    const canEdit = !!caps.payrollEdit
    const out = inputs.map(input => {
        const leadId = input.seriesInputId || input.payrollInputId
        const lead = leads.get(leadId) || input
        const series = input.seriesInputId ? inputs.filter(row => row.seriesInputId === input.seriesInputId) : [input]
        const summary = summaries[leadId] || null
        const source = sourceOf[input.payrollInputId]
        const row = inputRow(input, true, names, components, periods)
        return Object.assign(row, {
            leadInputId: leadId,
            revision: seriesRevision(lead),
            seriesText: input.seriesInputId ? series.indexOf(input) + 1 + " of " + seriesOf(lead).length : "",
            sourceText:
                source?.sourceEntityName === ADVANCE
                    ? "Advance " + source.sourceId
                    : input.correctionOfInputId
                      ? "Corrects " + input.correctionOfInputId
                      : input.evidence || "",
            employeeAdvanceId: source?.sourceEntityName === ADVANCE ? source.sourceId : null,
            approvalText: summary ? (summary.waiting ? summary.waitingText : summary.statusText) : "",
            canDecide: !!summary?.canDecide,
            canChange: canEdit && input.statusId === "PinProposed",
            canWithdraw: canEdit && (input.statusId === "PinProposed" || input.statusId === "PinApproved"),
            canCorrect: canEdit && input.statusId === "PinFinalized"
        })
    })
    return Object.assign(lib.pageList(out, p, "adjustments"), {canEdit})
}

// ===== decide#Adjustment =====
// A decision of the waiting request of an adjustment (its first input's id, or any of its series), by an approver of its step
// who reads payroll (PeopleApprovalServices.record#Decision: never one who made or changed it, nor the person it pays, at the
// revision asked): the last approval approves every input of it; a refusal (its reason required) refuses them and frees their
// entitlement.
function decideAdjustment(p) {
    const {userScope} = readerScope(false)
    const found = readableInput(userScope, p.payrollInputId)
    if (found.isAdjustment !== "Y") denied("NOT_ADJUSTMENT", "Only an adjustment is decided")
    const lead = leadOf(found)
    const decision = text(p.decision) || "approve"
    lockEmployment(lead.partyRelationshipId)
    const decided = call("mantle.humanres.PeopleApprovalServices.record#Decision", {
        approvalKindEnumId: KIND,
        sourceEntityName: INPUT,
        peopleApprovalId: text(p.peopleApprovalId) || null,
        sourceId: lead.payrollInputId,
        decision,
        reason: text(p.reason) || null,
        sourceRevision: text(p.sourceRevision) || null,
        operationKey: text(p.operationKey) || null
    })
    if (!decided.repeated) {
        const series = seriesOf(lead).filter(input => input.statusId === "PinProposed")
        // a recovery approved only within what its advance has left then (P24 review: the advance may have been repaid since)
        const advanceSource =
            decided.complete && lead.inputTypeEnumId === "PitAdvanceRecovery"
                ? rows(SOURCE, {payrollInputId: lead.payrollInputId}).find(row => row.sourceEntityName === ADVANCE)
                : null
        if (advanceSource) {
            const advance = one(ADVANCE, {employeeAdvanceId: advanceSource.sourceId})
            const left = advance ? advanceLeft(advance, lead.seriesInputId || lead.payrollInputId) : zero()
            if (decimalOf(lead.amount).compare(left) > 0)
                denied("AMOUNT_OVER_OUTSTANDING", "The advance has " + ec.l10n.format(left, "#,##0.00") + " left to recover")
        }
        if (decided.complete)
            for (const input of series) call("update#" + INPUT, {payrollInputId: input.payrollInputId, statusId: "PinApproved"})
        else if (decided.statusId === "PapRefused") for (const input of series) releaseInput(input, "PinRefused", text(p.reason))
    }
    const after = one(INPUT, {payrollInputId: lead.payrollInputId})
    return {
        payrollInputId: lead.payrollInputId,
        peopleApprovalId: decided.peopleApprovalId,
        statusId: after.statusId,
        approved: after.statusId === "PinApproved",
        repeated: !!decided.repeated
    }
}
function decideNotice(p, decision) {
    const message = p.message || {}
    if (p.recordEntityName && p.recordEntityName !== INPUT) denied("SOURCE_INVALID", "Not a pay adjustment approval")
    return decideAdjustment({
        payrollInputId: text(p.recordId),
        decision,
        reason: p.reason,
        peopleApprovalId: message.peopleApprovalId,
        sourceRevision: message.sourceRevision
    })
}

// ===== the source guards (Mantle's time and invoice writers) =====
// Of the source records named, those a live pay input consumed, and those a finalized one did.
function sourceUse(sourceEntityName, sourceIds) {
    const ids = unique((sourceIds || []).map(id => text(id)).filter(Boolean))
    if (!ids.length) return {consumedIds: [], finalizedIds: []}
    const sources = Array.from(
        find(SOURCE)
            .condition("sourceEntityName", sourceEntityName)
            .condition("sourceId", "in", ids)
            .condition("activeSourceKey", "is-not-null", null)
            .list()
    )
    const inputs = Object.fromEntries(
        rowsIn(INPUT, "payrollInputId", unique(sources.map(row => row.payrollInputId))).map(row => [row.payrollInputId, row])
    )
    return {
        consumedIds: unique(sources.map(row => row.sourceId)),
        finalizedIds: unique(
            sources.filter(row => inputs[row.payrollInputId]?.statusId === "PinFinalized").map(row => row.sourceId)
        )
    }
}
// A change of source records a pay input consumed: refused when a finalized input paid one (PAY_FINALIZED: a correction pays a
// difference); an input not finalized is voided, its entitlement and sources freed, so the next preparation reads them again
// (an authorized rate change, a reopened week). Answers how many inputs were voided.
function releaseSources(p) {
    const sourceEntityName = text(p.sourceEntityName)
    const use = sourceUse(sourceEntityName, Array.from(p.sourceIdList || []))
    if (use.finalizedIds.length)
        denied(
            "PAY_FINALIZED",
            "Payroll has paid " + use.finalizedIds.join(", ") + ": it is not changed (a correction pays a difference)"
        )
    if (!use.consumedIds.length) return {voidedCount: 0}
    const sources = Array.from(
        find(SOURCE)
            .condition("sourceEntityName", sourceEntityName)
            .condition("sourceId", "in", use.consumedIds)
            .condition("activeSourceKey", "is-not-null", null)
            .list()
    )
    const inputs = rowsIn(INPUT, "payrollInputId", unique(sources.map(row => row.payrollInputId)))
    const reason = shortText(p.reason) || "Its source changed"
    for (const input of inputs) releaseInput(input, "PinVoided", reason)
    return {voidedCount: inputs.length}
}
function checkSourceUse(p) {
    return sourceUse(text(p.sourceEntityName), Array.from(p.sourceIdList || []))
}

const operations = {
    getReconciliation,
    prepareInputs,
    storeAdjustment,
    findAdjustments,
    decideAdjustment,
    approveNotice: p => decideNotice(p, "approve"),
    refuseNotice: p => decideNotice(p, "refuse"),
    checkSourceUse,
    releaseSources
}
function run(op, p) {
    if (!Object.hasOwn(operations, op)) throw new Error("Unknown pay input operation " + op)
    return operations[op](p || {})
}
;({
    execute: run,
    // P25 (PayrollRuns.js): a run's population is the group's employments of the period, read as preparation reads them
    groupMembers,
    periodOf,
    zoneOf,
    dayStart,
    addDays,
    daysFrom
})
