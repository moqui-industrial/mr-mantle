// People's leave entitlement (mantle.humanres.LeaveServices find#Policies, get#Policy, store#Policy, store#AccrualRule,
// assign#Policy, store#BlockedInterval, preview#Allocation, allocate#Leave, get#Balances, get#MyBalances, find#Ledger, run#Accrual,
// run#AccrualJob and accrue#Assignment; IronStone People design §7 LeavePolicies, LeavePolicyDetail, LeaveAllocations and
// LeaveBalances, §16.2 LeaveServices, PE-07; impl-people P11; P12: preview#Request, submit#Request, get#Request, decide#Request with
// the PeopleLeaveApproval topic's approve#Request and refuse#Request, find#Requests, get#TeamAbsences and get#AbsenceProjection, the
// Team absence projected calendar; design §7 LeaveRequests and LeaveRequestDetail, §13 TeamCalendar, PE-21, PE-24). Every service
// checks the caller's People scope first (People.js scopeOf) and reads and writes with authorization off after it.
//
// The records (PeopleLeaveEntities.xml):
// - a policy (LeavePolicy) is an employer's dated rules for one leave type (the HR vocabulary PeopleLeaveType): its unit (days or
//   hours), paid meaning, allocation requirement, negative limit, evidence and accrual frequency; its accrual steps
//   (LeaveAccrualRule) are dated: by months of service, an amount a period, a cap, a carry-over limit at a year's end and a
//   rounding step; a change from a date ends a step and starts another;
// - an employment is under one policy of a leave type at a time (LeavePolicyAssignment), from a date, with an opening balance
//   posted once;
// - blocked and mandatory days (LeaveBlockedInterval) of an employer, a department or a leave type; they refuse or require leave
//   once requests exist (P12) and cancel nothing;
// - an allocation (LeaveAllocation) grants an entitlement period's leave once (a second grant of the policy for an overlapping
//   period is refused) or adjusts a balance with a reason;
// - the ledger (LeaveLedgerEntry): every movement of a balance with its source and a unique source key, posted once, never
//   changed or deleted. A balance as of a date is the sum of the entries effective by then; a correction is another entry.
//
// The accrual (run#AccrualJob, daily; run#Accrual for HR): each assignment in its own transaction (accrue#Assignment, the
// operation people.leave.accrual), a failure logged with the employment and policy and the rest going on. Each accrual period of
// the policy's frequency (calendar months, quarters or years, in the user's zone) that has ended posts once, keyed by employment,
// policy and period, in arrears: the step in effect on the period's last day for the months of service then, in proportion to the
// days of the period the assignment, the employment and the policy cover, rounded, not above the cap. At a year's end the balance
// above the step's carry-over limit expires once (keyed by employment, leave type and year); what is left of a grant after its
// expiry day expires once (keyed by the allocation), as far as the balance holds it. A second run posts nothing.
//
// Writes to one employment's entitlement (an opening, an allocation, an accrual) lock its employment relationship row first, so
// they serialize; the unique source key refuses a second posting even so.
//
// Who: an HR reader of the employer (PEOPLE_HR_VIEW) reads its policies; an HR editor (and PEOPLE_HR_EDIT) changes, assigns,
// blocks, allocates and runs the accrual. Balances: the person (PEOPLE_SELF_SERVICE) their own, a manager (PEOPLE_TEAM_VIEW) their
// live reports' at the line's employers (balances only), an HR reader the employer's; the ledger's movements the person and HR.
// Missing and unauthorized records are refused alike (RECORD_UNAVAILABLE). No leave reason is in a list, a notice or the calendar: a
// request's reason (LeaveRequest.reason, ai-opt-out) is read on the request alone, by the person, who asked, their approvers and HR;
// a legacy EmploymentLeave reason never; an allocation's reason by HR (P12, F202).
const people = ec.resource.script("component://mr-mantle/service/mantle/humanres/People.js")
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const {find, one, rows, denied, call, dateText} = lib

const POLICY = "mantle.humanres.leave.LeavePolicy"
const RULE = "mantle.humanres.leave.LeaveAccrualRule"
const ASSIGNMENT = "mantle.humanres.leave.LeavePolicyAssignment"
const BLOCK = "mantle.humanres.leave.LeaveBlockedInterval"
const ALLOCATION = "mantle.humanres.leave.LeaveAllocation"
const ENTRY = "mantle.humanres.leave.LeaveLedgerEntry"
const RELATIONSHIP = "mantle.party.PartyRelationship"
const EMPLOYMENT_ASSIGNMENT = "mantle.humanres.employment.EmploymentAssignment"
const ENUM = "moqui.basic.Enumeration"
const dayMs = 24 * 60 * 60 * 1000
const stateTexts = {current: "In effect", future: "Coming", ended: "Ended"}
const frequencyMonths = {LafMonthly: 1, LafQuarterly: 3, LafYearly: 12}
const frequencyWords = {LafMonthly: "a month", LafQuarterly: "a quarter", LafYearly: "a year"}
// the most employments one assignment or allocation run takes, and the most rows a list or an export gives
const batchCap = 500
const exportCap = 5000
// an ended assignment is still looked at by the accrual for a year after its end (its last periods and expiries)
const accrualLookBackMs = 366 * dayMs

const ms = lib.ms
const nowMs = () => ms(ec.user.nowTimestamp)
const text = value => String(value ?? "").trim()
const given = value => value != null
const truthy = value => value === true || value === "true" || value === "Y"
const stamp = millis => (millis == null ? null : new Date(Number(millis)))
const unique = people.unique
const stampOf = row => ms(row?.lastUpdatedStamp) ?? 0
const voided = row => row.thruDate != null && ms(row.thruDate) <= (ms(row.fromDate) ?? -Infinity)
const openAt = (row, at) => (ms(row.fromDate) ?? -Infinity) <= at && (ms(row.thruDate) ?? Infinity) > at
const stateOf = (row, at) =>
    (ms(row.fromDate) ?? -Infinity) > at ? "future" : (ms(row.thruDate) ?? Infinity) <= at ? "ended" : "current"
const likeText = value => "%" + String(value).replace(/[\\%_]/g, character => "\\" + character) + "%"
// a decimal of an entity or a parameter as a number (a BigDecimal's valueOf throws), null when empty
function num(value) {
    if (value == null || value === "") return null
    if (typeof value === "number") return value
    if (typeof value?.toNumber === "function") return value.toNumber()
    const parsed = Number(String(value))
    return Number.isFinite(parsed) ? parsed : NaN
}
const r4 = value => Math.round(value * 10000) / 10000
const decimal = value => (value == null ? null : String(r4(value)))
const roundTo = (value, increment) => r4(Math.round(value / increment + 1e-9) * increment)
const amountText = (value, unitText) => {
    const shown = r4(value || 0)
    return shown + " " + String(unitText || "").toLowerCase()
}

// ===== days =====
const dayOf = millis => ec.l10n.format(new Date(Number(millis)), "yyyy-MM-dd")
const startOfDay = day =>
    ms(ec.l10n.parseTimestamp(String(day).slice(0, 10) + " 00:00:00.000", "yyyy-MM-dd HH:mm:ss.SSS", null, null))
const todayStart = () => startOfDay(dayOf(nowMs()))
// an effective date: the start of today when empty, else the date given (a date alone is its start in the user's zone)
const effective = value => (value == null || value === "" ? todayStart() : ec.user.timestampMillis(value))
// a day parameter (a date, or a date and time) as yyyy-MM-dd in the user's zone, null when empty
const dayParam = value => (value == null || value === "" ? null : dayOf(ec.user.timestampMillis(value)))
// a calendar date (a Date at UTC midnight, from Date.UTC) as yyyy-MM-dd
const utcDayText = date =>
    [date.getUTCFullYear(), String(date.getUTCMonth() + 1).padStart(2, "0"), String(date.getUTCDate()).padStart(2, "0")].join("-")
function addDays(day, count) {
    const [y, m, d] = String(day).slice(0, 10).split("-").map(Number)
    const date = new Date(Date.UTC(y, m - 1, d + count))
    return utcDayText(date)
}
function addMonths(day, count) {
    const [y, m] = String(day).slice(0, 10).split("-").map(Number)
    const date = new Date(Date.UTC(y, m - 1 + count, 1))
    return utcDayText(date)
}
// the first day of the accrual period holding a day: its month, quarter or year
function periodStart(day, frequencyEnumId) {
    const [y, m] = String(day).slice(0, 10).split("-").map(Number)
    const months = frequencyMonths[frequencyEnumId]
    const first = months === 12 ? 1 : Math.floor((m - 1) / months) * months + 1
    return y + "-" + String(first).padStart(2, "0") + "-01"
}
// whole months of service from the employment's first day to a day
function serviceMonths(fromDay, day) {
    const [y1, m1, d1] = String(fromDay).slice(0, 10).split("-").map(Number)
    const [y2, m2, d2] = String(day).slice(0, 10).split("-").map(Number)
    return Math.max(0, (y2 - y1) * 12 + (m2 - m1) - (d2 < d1 ? 1 : 0))
}

// ===== names =====
function enumTexts(enumIds) {
    const ids = unique((enumIds || []).filter(Boolean))
    if (!ids.length) return {}
    return Object.fromEntries(
        Array.from(find(ENUM).condition("enumId", "in", ids).list()).map(row => [row.enumId, row.description || row.enumId])
    )
}
function policyNames(policyIds) {
    const ids = unique((policyIds || []).filter(Boolean))
    if (!ids.length) return {}
    return Object.fromEntries(
        Array.from(find(POLICY).condition("leavePolicyId", "in", ids).list()).map(row => [
            row.leavePolicyId,
            row.policyName || row.leavePolicyId
        ])
    )
}

// ===== scope =====
function readerScope(what) {
    const userScope = people.scopeOf()
    if (!userScope.capabilities.hrView) denied("PERMISSION_DENIED", what + " needs PEOPLE_HR_VIEW")
    return userScope
}
function editorScope(what) {
    const userScope = people.scopeOf()
    const caps = userScope.capabilities
    if (!caps.hrView || !caps.hrEdit) denied("PERMISSION_DENIED", what + " needs PEOPLE_HR_VIEW and PEOPLE_HR_EDIT")
    return userScope
}
const hrEmployers = userScope => (userScope.capabilities.hrView ? userScope.organizationPartyIds : [])
const canEditAt = (userScope, organizationPartyId) =>
    !!(
        userScope.capabilities.hrView &&
        userScope.capabilities.hrEdit &&
        userScope.organizationPartyIds.includes(organizationPartyId)
    )
function readablePolicy(userScope, leavePolicyId) {
    const id = text(leavePolicyId)
    const row = id ? one(POLICY, {leavePolicyId: id}) : null
    if (!row || !hrEmployers(userScope).includes(row.organizationPartyId))
        denied("RECORD_UNAVAILABLE", "Leave policy " + id + " is not available")
    return row
}
function editablePolicy(userScope, leavePolicyId) {
    const id = text(leavePolicyId)
    const row = id ? one(POLICY, {leavePolicyId: id}) : null
    if (!row || !canEditAt(userScope, row.organizationPartyId))
        denied("RECORD_UNAVAILABLE", "Leave policy " + id + " is not available")
    return row
}
// a policy's revision: the later change of it and its accrual steps, what a change of either names
const policyRevision = leavePolicyId =>
    String(Math.max(stampOf(one(POLICY, {leavePolicyId})), ...rows(RULE, {leavePolicyId}).map(stampOf)))
function checkRevision(leavePolicyId, expected) {
    const revision = policyRevision(leavePolicyId)
    if (text(expected) !== revision)
        denied("REVISION_CHANGED", "This policy changed since you read it; open it again (revision " + revision + ")")
}
// An employment relationship (PrtEmployee), or null.
const employmentRow = partyRelationshipId =>
    partyRelationshipId ? one(RELATIONSHIP, {partyRelationshipId, relationshipTypeEnumId: "PrtEmployee"}) : null
// How the scope admits an employment's balances: self (the person's own), team (a live report at the line's employer), hr (an HR
// reader of the employer); RECORD_UNAVAILABLE when none of kinds admits it.
function employmentAccess(userScope, partyRelationshipId, kinds) {
    const row = employmentRow(text(partyRelationshipId))
    const caps = userScope.capabilities
    const found = []
    if (row) {
        if (caps.self && row.fromPartyId === userScope.partyId) found.push("self")
        if (caps.team && ((userScope.reportLines || {})[row.fromPartyId] || []).includes(row.toPartyId)) found.push("team")
        if (hrEmployers(userScope).includes(row.toPartyId)) found.push("hr")
    }
    if (!row || !found.some(kind => kinds.includes(kind)))
        denied("RECORD_UNAVAILABLE", "Employment " + text(partyRelationshipId) + " is not available")
    return {row, kinds: found}
}
// lock an employment's entitlement: every write of its ledger takes its relationship row first
const lockEmployment = partyRelationshipId => find(RELATIONSHIP, {partyRelationshipId}).forUpdate(true).one()

// ===== the ledger =====
// An employment's entries of a leave type, each {sourceKey, amount, effectiveMs, entryTypeEnumId}, by effective date.
function entriesOf(partyRelationshipId, leaveTypeEnumId) {
    return rows(ENTRY, {partyRelationshipId, leaveTypeEnumId})
        .map(row => ({
            leaveLedgerEntryId: row.leaveLedgerEntryId,
            sourceKey: row.sourceKey,
            amount: num(row.amount) || 0,
            effectiveMs: ms(row.effectiveDate) ?? 0,
            entryTypeEnumId: row.entryTypeEnumId,
            unitEnumId: row.unitEnumId
        }))
        .sort((a, b) => a.effectiveMs - b.effectiveMs)
}
const balanceAt = (entries, at) => r4(entries.reduce((sum, entry) => (entry.effectiveMs <= at ? sum + entry.amount : sum), 0))
const keyPosted = (entries, sourceKey) => entries.some(entry => entry.sourceKey === sourceKey)
// Post an entry (once: its source key is unique) and add it to the entries read.
function post(entries, values) {
    const fields = Object.assign({}, values, {
        amount: decimal(values.amount),
        effectiveDate: stamp(values.effectiveMs),
        postedDate: stamp(nowMs()),
        postedByUserId: ec.user.userId || null
    })
    delete fields.effectiveMs
    const created = call("create#" + ENTRY, fields)
    entries.push({
        leaveLedgerEntryId: created.leaveLedgerEntryId,
        sourceKey: values.sourceKey,
        amount: r4(values.amount),
        effectiveMs: values.effectiveMs,
        entryTypeEnumId: values.entryTypeEnumId,
        unitEnumId: values.unitEnumId
    })
    entries.sort((a, b) => a.effectiveMs - b.effectiveMs)
    return created.leaveLedgerEntryId
}
// The movements of entries effective by a time, by kind.
function sums(entries, at) {
    const out = {opening: 0, granted: 0, accrued: 0, consumed: 0, expired: 0, adjusted: 0, balance: 0}
    const kinds = {
        LletOpening: "opening",
        LletGrant: "granted",
        LletAccrual: "accrued",
        LletConsumption: "consumed",
        LletExpiry: "expired",
        LletAdjustment: "adjusted",
        LletReversal: "adjusted"
    }
    for (const entry of entries) {
        if (entry.effectiveMs > at) continue
        const kind = kinds[entry.entryTypeEnumId] || "adjusted"
        out[kind] += entry.amount
        out.balance += entry.amount
    }
    for (const key of Object.keys(out)) out[key] = r4(out[key])
    return out
}

// ===== policies =====
const ruleState = (rule, at) => stateOf(rule, at)
function ruleText(rule, unitText, frequencyEnumId) {
    const parts = [amountText(num(rule.amount), unitText) + " " + (frequencyWords[frequencyEnumId] || "")]
    if (Number(rule.serviceMonthsFrom || 0) > 0) parts.push("from " + Number(rule.serviceMonthsFrom) + " months of service")
    return parts.join(" ").trim()
}
function policyRow(userScope, row, rules, at, assignedCounts, texts) {
    const state = stateOf(row, at)
    const unitText = texts[row.unitEnumId] || ""
    const live = rules
        .filter(rule => openAt(rule, Math.max(at, ms(row.fromDate) ?? -Infinity)))
        .sort((a, b) => Number(a.serviceMonthsFrom || 0) - Number(b.serviceMonthsFrom || 0))
    return {
        leavePolicyId: row.leavePolicyId,
        policyName: row.policyName || row.leavePolicyId,
        organizationPartyId: row.organizationPartyId,
        organizationName: people.organizationNames([row.organizationPartyId])[row.organizationPartyId] || row.organizationPartyId,
        leaveTypeEnumId: row.leaveTypeEnumId,
        leaveTypeText: texts[row.leaveTypeEnumId] || row.leaveTypeEnumId || "",
        unitEnumId: row.unitEnumId,
        unitText,
        isPaid: row.isPaid === "Y",
        allocationRequired: row.allocationRequired === "Y",
        evidenceRequired: row.evidenceRequired === "Y",
        negativeLimit: num(row.negativeLimit) || 0,
        accrualFrequencyEnumId: row.accrualFrequencyEnumId || null,
        frequencyText: row.accrualFrequencyEnumId ? texts[row.accrualFrequencyEnumId] || "" : "No accrual",
        accrualText: !row.accrualFrequencyEnumId
            ? "Allocations only"
            : live.length
              ? live.map(rule => ruleText(rule, unitText, row.accrualFrequencyEnumId)).join("; ")
              : "No accrual step in effect",
        description: row.description || "",
        fromDateText: dateText(row.fromDate),
        thruDateText: dateText(row.thruDate),
        state,
        stateText: state === "ended" ? "Closed" : stateTexts[state],
        assignedCount: assignedCounts ? assignedCounts[row.leavePolicyId] || 0 : null,
        canEdit: canEditAt(userScope, row.organizationPartyId),
        revision: policyRevision(row.leavePolicyId)
    }
}
const liveCondition = at => {
    const factory = ec.entity.conditionFactory
    return factory.makeCondition(
        factory.makeCondition("thruDate", "is-null", null),
        "or",
        factory.makeCondition("thruDate", "greater", stamp(at))
    )
}
// How many employments each policy has now or to come.
function assignedCounts(leavePolicyIds) {
    const counts = {}
    if (!leavePolicyIds.length) return counts
    for (const row of Array.from(
        find(ASSIGNMENT).condition("leavePolicyId", "in", leavePolicyIds).condition(liveCondition(nowMs())).list()
    ))
        if (!voided(row)) counts[row.leavePolicyId] = (counts[row.leavePolicyId] || 0) + 1
    return counts
}
// find#Policies: the policies of the employers an HR reader reads, by name (term, ignoring case), of an employer (ORGANIZATION_DENIED
// outside the scope) and leave type, in effect on asOfDate (now) unless includeEnded. Paged.
function findPolicies(p) {
    const userScope = readerScope("Leave policies")
    if (p.organizationPartyId) people.requireOrganization(userScope, p.organizationPartyId)
    const employers = hrEmployers(userScope).filter(id => !p.organizationPartyId || id === p.organizationPartyId)
    if (!employers.length) return Object.assign(lib.pageList([], p, "policies"), {policies: []})
    const at = p.asOfDate ? people.asOfMillis(p.asOfDate) : nowMs()
    const factory = ec.entity.conditionFactory
    let query = find(POLICY).condition("organizationPartyId", "in", employers)
    if (text(p.leaveTypeEnumId)) query = query.condition("leaveTypeEnumId", text(p.leaveTypeEnumId))
    if (!truthy(p.includeEnded)) query = query.condition(liveCondition(at))
    const term = text(p.term)
    if (term)
        query = query.condition(
            factory.makeCondition(
                ["leavePolicyId", "policyName"].map(field => factory.makeCondition(field, "like", likeText(term)).ignoreCase()),
                "or"
            )
        )
    const count = query.count()
    const paged = lib.page(query.orderBy(["policyName", "leavePolicyId"]), p, "policies", count)
    const ids = paged.rows.map(row => row.leavePolicyId)
    const rulesById = {}
    if (ids.length)
        for (const rule of Array.from(find(RULE).condition("leavePolicyId", "in", ids).list()))
            if (!voided(rule)) (rulesById[rule.leavePolicyId] || (rulesById[rule.leavePolicyId] = [])).push(rule)
    const texts = enumTexts(paged.rows.flatMap(row => [row.leaveTypeEnumId, row.unitEnumId, row.accrualFrequencyEnumId]))
    const counts = assignedCounts(ids)
    const out = Object.assign({}, paged)
    delete out.rows
    out.policies = paged.rows.map(row => policyRow(userScope, row, rulesById[row.leavePolicyId] || [], at, counts, texts))
    return out
}
// get#Policy: one policy an HR reader reads, its accrual steps, the employments under it now or to come (and ended ones), its blocked
// and mandatory days, and how many entries were posted under it.
function getPolicy(p) {
    const userScope = readerScope("A leave policy")
    const row = readablePolicy(userScope, p.leavePolicyId)
    const at = Math.max(nowMs(), ms(row.fromDate) ?? -Infinity)
    const rules = rows(RULE, {leavePolicyId: row.leavePolicyId}).filter(rule => !voided(rule))
    const texts = enumTexts([row.leaveTypeEnumId, row.unitEnumId, row.accrualFrequencyEnumId, "LbkBlocked", "LbkMandatory"])
    const unitText = texts[row.unitEnumId] || ""
    const now = nowMs()
    const rank = state => (state === "current" ? 0 : state === "future" ? 1 : 2)
    const ruleRows = rules
        .map(rule => {
            const state = ruleState(rule, at)
            return {
                leaveAccrualRuleId: rule.leaveAccrualRuleId,
                serviceMonthsFrom: Number(rule.serviceMonthsFrom || 0),
                amount: num(rule.amount),
                capAmount: num(rule.capAmount),
                carryLimit: num(rule.carryLimit),
                roundingIncrement: num(rule.roundingIncrement),
                ruleText: ruleText(rule, unitText, row.accrualFrequencyEnumId),
                fromDateText: dateText(rule.fromDate),
                thruDateText: dateText(rule.thruDate),
                state,
                stateText: stateTexts[state]
            }
        })
        .sort((a, b) => rank(a.state) - rank(b.state) || a.serviceMonthsFrom - b.serviceMonthsFrom)
    const assignments = rows(ASSIGNMENT, {leavePolicyId: row.leavePolicyId}).filter(assignment => !voided(assignment))
    const persons = people.personNames(unique(assignments.map(assignment => assignment.partyId)))
    const assignmentRows = assignments
        .map(assignment => {
            const state = stateOf(assignment, now)
            return {
                leavePolicyAssignmentId: assignment.leavePolicyAssignmentId,
                partyRelationshipId: assignment.partyRelationshipId,
                partyId: assignment.partyId,
                personName: persons[assignment.partyId] || assignment.partyId,
                fromDateText: dateText(assignment.fromDate),
                thruDateText: dateText(assignment.thruDate),
                openingAmount: num(assignment.openingAmount),
                state,
                stateText: stateTexts[state],
                revision: String(stampOf(assignment))
            }
        })
        .sort((a, b) => rank(a.state) - rank(b.state) || a.personName.localeCompare(b.personName))
        .slice(0, batchCap)
    const blocks = rows(BLOCK, {leavePolicyId: row.leavePolicyId})
    const units = people.organizationNames(unique(blocks.map(block => block.departmentPartyId).filter(Boolean)))
    const blockTypes = enumTexts(blocks.map(block => block.leaveTypeEnumId))
    const today = dayOf(now)
    const blockRows = blocks
        .map(block => {
            const fromDay = lib.calendarDateText(block.fromDay)
            const thruDay = lib.calendarDateText(block.thruDay)
            const state = block.cancelledDate ? "cancelled" : thruDay < today ? "ended" : fromDay > today ? "future" : "current"
            return {
                leaveBlockedIntervalId: block.leaveBlockedIntervalId,
                blockKindEnumId: block.blockKindEnumId,
                kindText: texts[block.blockKindEnumId] || "",
                fromDay,
                thruDay,
                departmentPartyId: block.departmentPartyId || null,
                departmentName: block.departmentPartyId ? units[block.departmentPartyId] || block.departmentPartyId : "",
                leaveTypeEnumId: block.leaveTypeEnumId || null,
                leaveTypeText: block.leaveTypeEnumId ? blockTypes[block.leaveTypeEnumId] || "" : "Every leave type",
                scopeText: [
                    block.departmentPartyId ? units[block.departmentPartyId] || block.departmentPartyId : "Every department",
                    block.leaveTypeEnumId ? blockTypes[block.leaveTypeEnumId] || block.leaveTypeEnumId : "every leave type"
                ].join(", "),
                overrideAllowed: block.overrideAllowed === "Y",
                reason: block.reason || "",
                state,
                stateText: {current: "In effect", future: "Coming", ended: "Past", cancelled: "Cancelled"}[state],
                revision: String(stampOf(block))
            }
        })
        .sort((a, b) => (a.state === "cancelled") - (b.state === "cancelled") || a.fromDay.localeCompare(b.fromDay))
    const postedCount = find(ENTRY).condition("leavePolicyId", row.leavePolicyId).count()
    const policy = Object.assign(policyRow(userScope, row, rules, at, assignedCounts([row.leavePolicyId]), texts), {
        postedCount,
        canAssign: canEditAt(userScope, row.organizationPartyId) && stateOf(row, now) !== "ended"
    })
    return {policy, rules: ruleRows, assignments: assignmentRows, blockedIntervals: blockRows}
}
// A current value of People's leave types (an ended one is refused for a new policy).
function checkLeaveType(leaveTypeEnumId) {
    const row = leaveTypeEnumId ? one(ENUM, {enumId: leaveTypeEnumId}) : null
    if (!row || row.enumTypeId !== "PeopleLeaveType" || (row.thruDate != null && ms(row.thruDate) <= nowMs()))
        denied("TYPE_INVALID", "Choose a leave type")
    return row
}
const checkUnit = unitEnumId => {
    if (!["LuDays", "LuHours"].includes(unitEnumId)) denied("UNIT_INVALID", "Choose days or hours")
    return unitEnumId
}
const checkFrequency = frequencyEnumId => {
    if (frequencyEnumId && !Object.hasOwn(frequencyMonths, frequencyEnumId))
        denied("FREQUENCY_INVALID", "Choose monthly, quarterly or yearly, or no accrual")
    return frequencyEnumId || null
}
function checkLimit(value) {
    const limit = num(value)
    if (limit == null) return 0
    if (Number.isNaN(limit) || limit < 0) denied("LIMIT_INVALID", "The negative limit is zero or more")
    return limit
}
const indicator = value => (truthy(value) ? "Y" : "N")
// store#Policy: a new policy of an employer, a change of one at its revision (its type, unit once posted and employer never
// change), or its close from a date.
function storePolicy(p) {
    const userScope = editorScope("Changing a leave policy")
    const id = text(p.leavePolicyId)
    const reason = text(p.changeReason) || null
    if (!id) {
        const organizationPartyId = text(p.organizationPartyId)
        if (!organizationPartyId) denied("ORGANIZATION_REQUIRED", "Choose the employer")
        if (!canEditAt(userScope, organizationPartyId))
            denied("ORGANIZATION_DENIED", "Organization " + organizationPartyId + " is not available")
        const name = text(p.policyName)
        if (!name) denied("NAME_REQUIRED", "Name the policy")
        checkLeaveType(text(p.leaveTypeEnumId))
        const created = call("create#" + POLICY, {
            policyName: name,
            organizationPartyId,
            leaveTypeEnumId: text(p.leaveTypeEnumId),
            unitEnumId: checkUnit(text(p.unitEnumId) || "LuDays"),
            isPaid: given(p.isPaid) ? indicator(p.isPaid) : "Y",
            allocationRequired: given(p.allocationRequired) ? indicator(p.allocationRequired) : "Y",
            negativeLimit: decimal(checkLimit(p.negativeLimit)),
            evidenceRequired: indicator(p.evidenceRequired),
            accrualFrequencyEnumId: checkFrequency(text(p.accrualFrequencyEnumId)),
            fromDate: stamp(effective(p.fromDate)),
            description: text(p.description) || null
        })
        return {leavePolicyId: created.leavePolicyId, revision: policyRevision(created.leavePolicyId)}
    }
    const row = editablePolicy(userScope, id)
    checkRevision(id, p.expectedRevision)
    if (text(p.organizationPartyId) && text(p.organizationPartyId) !== row.organizationPartyId)
        denied("OWNER_CHANGE", "A policy stays its employer's; start one for another")
    if (text(p.leaveTypeEnumId) && text(p.leaveTypeEnumId) !== row.leaveTypeEnumId)
        denied("TYPE_CHANGE", "A policy keeps its leave type; start one for another")
    const changes = {leavePolicyId: id}
    const audited = (field, value) => {
        changes[field] = value
        changes[field + "_changeReason"] = reason
    }
    if (given(p.policyName)) {
        if (!text(p.policyName)) denied("NAME_REQUIRED", "Name the policy")
        if (text(p.policyName) !== row.policyName) audited("policyName", text(p.policyName))
    }
    if (given(p.description)) changes.description = text(p.description) || null
    if (text(p.unitEnumId) && text(p.unitEnumId) !== row.unitEnumId) {
        checkUnit(text(p.unitEnumId))
        if (find(ENTRY).condition("leavePolicyId", id).count() > 0)
            denied("UNIT_IN_USE", "Entries were posted in " + row.unitEnumId + "; start another policy for another unit")
        changes.unitEnumId = text(p.unitEnumId)
    }
    for (const field of ["isPaid", "allocationRequired", "evidenceRequired"])
        if (given(p[field]) && indicator(p[field]) !== (row[field] || "N")) audited(field, indicator(p[field]))
    if (given(p.negativeLimit)) {
        const limit = checkLimit(p.negativeLimit)
        if (limit !== (num(row.negativeLimit) || 0)) audited("negativeLimit", decimal(limit))
    }
    if (given(p.accrualFrequencyEnumId)) {
        const frequency = checkFrequency(text(p.accrualFrequencyEnumId))
        if (frequency !== (row.accrualFrequencyEnumId || null)) {
            if (find(ENTRY).condition("leavePolicyId", id).condition("entryTypeEnumId", "LletAccrual").count() > 0)
                denied("FREQUENCY_IN_USE", "Accruals were posted monthly, quarterly or yearly; start another policy to change it")
            audited("accrualFrequencyEnumId", frequency)
        }
    }
    if (truthy(p.end)) {
        const thruMs = effective(p.thruDate)
        if (thruMs < todayStart()) denied("DATE_PAST", "A policy closes today or later")
        audited("thruDate", stamp(Math.max(thruMs, ms(row.fromDate) ?? -Infinity)))
    }
    if (Object.keys(changes).length > 1) call("update#" + POLICY, changes)
    return {leavePolicyId: id, revision: policyRevision(id)}
}

// ===== store#AccrualRule =====
function ruleValues(p, base) {
    const pick = field => (given(p[field]) && p[field] !== "" ? num(p[field]) : base ? num(base[field]) : null)
    const months =
        given(p.serviceMonthsFrom) && p.serviceMonthsFrom !== "" ? num(p.serviceMonthsFrom) : num(base?.serviceMonthsFrom) || 0
    if (Number.isNaN(months) || months < 0 || !Number.isInteger(months))
        denied("SERVICE_INVALID", "Months of service is a whole number, zero or more")
    const amount = pick("amount")
    if (amount == null || Number.isNaN(amount) || amount <= 0) denied("AMOUNT_INVALID", "Enter the amount accrued each period")
    const cap = given(p.capAmount) ? (p.capAmount === "" ? null : num(p.capAmount)) : num(base?.capAmount)
    if (cap != null && (Number.isNaN(cap) || cap <= 0)) denied("CAP_INVALID", "The cap is more than zero, or none")
    const carry = given(p.carryLimit) ? (p.carryLimit === "" ? null : num(p.carryLimit)) : num(base?.carryLimit)
    if (carry != null && (Number.isNaN(carry) || carry < 0))
        denied("CARRY_INVALID", "The carry-over limit is zero or more, or none")
    const rounding = given(p.roundingIncrement)
        ? p.roundingIncrement === ""
            ? null
            : num(p.roundingIncrement)
        : num(base?.roundingIncrement)
    if (rounding != null && (Number.isNaN(rounding) || rounding <= 0))
        denied("ROUNDING_INVALID", "The rounding step is more than zero")
    return {
        serviceMonthsFrom: months,
        amount: decimal(amount),
        capAmount: decimal(cap),
        carryLimit: decimal(carry),
        roundingIncrement: decimal(rounding)
    }
}
// another step in effect at the same time for the same months of service
function checkRuleOverlap(leavePolicyId, months, fromMs, thruMs, exceptId) {
    const clash = rows(RULE, {leavePolicyId}).find(
        rule =>
            rule.leaveAccrualRuleId !== exceptId &&
            !voided(rule) &&
            Number(rule.serviceMonthsFrom || 0) === months &&
            (ms(rule.fromDate) ?? -Infinity) < (thruMs ?? Infinity) &&
            (ms(rule.thruDate) ?? Infinity) > fromMs
    )
    if (clash)
        denied(
            "OVERLAP",
            "Another step for " + months + " months of service is in effect then; change or end it from a date instead"
        )
}
const accrualsPosted = leavePolicyId =>
    find(ENTRY).condition("leavePolicyId", leavePolicyId).condition("entryTypeEnumId", "LletAccrual").count() > 0
// store#AccrualRule: a step added from a date, changed from a date (before its start in place; after it the step ends then and
// another starts), or ended from a date, at the policy's revision.
function storeAccrualRule(p) {
    const userScope = editorScope("Changing a leave policy")
    const policy = editablePolicy(userScope, p.leavePolicyId)
    checkRevision(policy.leavePolicyId, p.expectedRevision)
    if (!policy.accrualFrequencyEnumId) denied("FREQUENCY_REQUIRED", "Set how often the policy accrues first")
    if (stateOf(policy, nowMs()) === "ended") denied("DATE_OUTSIDE", "The policy is closed")
    const fromMs = Math.max(effective(p.fromDate), ms(policy.fromDate) ?? -Infinity)
    // a step of a policy that has posted accruals changes from today on: the periods it posted keep their entries
    if (fromMs < todayStart() && accrualsPosted(policy.leavePolicyId))
        denied("DATE_PAST", "Accruals were posted under this policy: change its steps from today or later")
    const id = text(p.leaveAccrualRuleId)
    const reason = text(p.changeReason) || null
    if (!id) {
        const values = ruleValues(p, null)
        checkRuleOverlap(policy.leavePolicyId, values.serviceMonthsFrom, fromMs, null, null)
        const created = call(
            "create#" + RULE,
            Object.assign({leavePolicyId: policy.leavePolicyId, fromDate: stamp(fromMs)}, values)
        )
        return {leaveAccrualRuleId: created.leaveAccrualRuleId, revision: policyRevision(policy.leavePolicyId)}
    }
    const rule = one(RULE, {leaveAccrualRuleId: id})
    if (!rule || rule.leavePolicyId !== policy.leavePolicyId)
        denied("RECORD_UNAVAILABLE", "Accrual step " + id + " is not available")
    if (rule.thruDate != null && ms(rule.thruDate) <= fromMs) denied("RULE_ENDED", "The step has ended by then")
    if (truthy(p.end)) {
        call("update#" + RULE, {
            leaveAccrualRuleId: id,
            thruDate: stamp(Math.max(fromMs, ms(rule.fromDate) ?? -Infinity)),
            thruDate_changeReason: reason
        })
        return {leaveAccrualRuleId: id, revision: policyRevision(policy.leavePolicyId)}
    }
    const values = ruleValues(p, rule)
    if (fromMs <= (ms(rule.fromDate) ?? -Infinity)) {
        checkRuleOverlap(policy.leavePolicyId, values.serviceMonthsFrom, ms(rule.fromDate), ms(rule.thruDate), id)
        call("update#" + RULE, Object.assign({leaveAccrualRuleId: id}, values))
        return {leaveAccrualRuleId: id, revision: policyRevision(policy.leavePolicyId)}
    }
    checkRuleOverlap(policy.leavePolicyId, values.serviceMonthsFrom, fromMs, ms(rule.thruDate), id)
    call("update#" + RULE, {leaveAccrualRuleId: id, thruDate: stamp(fromMs), thruDate_changeReason: reason})
    const created = call(
        "create#" + RULE,
        Object.assign({leavePolicyId: policy.leavePolicyId, fromDate: stamp(fromMs), thruDate: rule.thruDate}, values)
    )
    return {leaveAccrualRuleId: created.leaveAccrualRuleId, revision: policyRevision(policy.leavePolicyId)}
}

// ===== the employments a batch takes =====
// The employments an assignment or allocation run takes: those named (partyRelationshipIds), else the current employees of the
// policy's employer, of a department and the units under it when one is given (by the assignment in effect now); each once,
// capped. A department outside the employer is refused (DEPARTMENT_INVALID).
function batchEmployments(policy, p) {
    const named = unique(
        []
            .concat(Array.from(p.partyRelationshipIds || []))
            .concat(text(p.partyRelationshipId) ? [text(p.partyRelationshipId)] : [])
            .map(text)
            .filter(Boolean)
    )
    if (named.length) return named.slice(0, batchCap)
    const current = Array.from(
        people
            .current(people.employmentFind().condition("toPartyId", policy.organizationPartyId), nowMs())
            .orderBy("fromPartyId")
            .list()
    )
    const departmentPartyId = text(p.departmentPartyId)
    if (!departmentPartyId) return current.map(row => row.partyRelationshipId).slice(0, batchCap)
    const units = people.unitsUnder([policy.organizationPartyId])
    if (!units.includes(departmentPartyId)) denied("DEPARTMENT_INVALID", "Choose a department of the employer")
    const within = new Set([departmentPartyId].concat(people.unitsUnder([departmentPartyId])))
    const assigned = people.assignmentsAt(unique(current.map(row => row.fromPartyId)), nowMs())
    return current
        .filter(row => {
            const assignment = assigned[policy.organizationPartyId + "/" + row.fromPartyId]
            return assignment && within.has(assignment.departmentPartyId)
        })
        .map(row => row.partyRelationshipId)
        .slice(0, batchCap)
}
// An employment of the policy's employer, or null: an employment of another employer is refused as a missing one is
// (EMPLOYMENT_OUTSIDE), and its person is not named.
function policyEmployment(policy, partyRelationshipId) {
    const row = employmentRow(partyRelationshipId)
    return row && row.toPartyId === policy.organizationPartyId ? row : null
}
// a row of a batch: the person, and the outcome (ready, done, repeated or refused with its code)
function refusedRow(row, error) {
    row.outcome = "refused"
    row.reasonCode = lib.reasonCode(error) || "FAILED"
    row.message = String(error?.message || error).replace(/^[A-Z][A-Z0-9_]+: /, "")
    return row
}
const outcomeTexts = {ready: "Ready", done: "Done", repeated: "Already done", refused: "Refused"}
function withTexts(batchRows) {
    const persons = people.personNames(unique(batchRows.map(row => row.partyId).filter(Boolean)))
    for (const row of batchRows) {
        row.personName = persons[row.partyId] || row.partyId || row.partyRelationshipId
        row.outcomeText = outcomeTexts[row.outcome] || row.outcome
        row.message = row.message || ""
    }
    return batchRows.sort((a, b) => String(a.personName).localeCompare(String(b.personName)))
}
// Run fn for one row in its own transaction; a refusal or failure names the row and the rest go on.
function inOwnTransaction(row, what, fn) {
    ec.message.pushErrors()
    try {
        ec.transaction.runRequireNew(null, what + " " + row.partyRelationshipId + " failed", () => {
            fn()
            if (ec.message.hasError()) throw new Error(ec.message.getErrorsString())
        })
    } catch (error) {
        if (!lib.reasonCode(error)) ec.logger.error(what + " " + row.partyRelationshipId + " failed: " + error.message)
        refusedRow(row, error)
    } finally {
        ec.message.clearErrors()
        ec.message.popErrors()
    }
}

// ===== assign#Policy =====
// Whether an employment may be put under the policy from a date: the employer's (EMPLOYMENT_OUTSIDE), employed then
// (DATE_OUTSIDE), under no other policy of the type then (ASSIGNMENT_OVERLAP), and with no entries of the type in another unit
// (UNIT_MISMATCH).
function checkAssignable(policy, employment, fromMs, thruMs, partyRelationshipId) {
    if (!employment || employment.toPartyId !== policy.organizationPartyId)
        denied("EMPLOYMENT_OUTSIDE", "Employment " + partyRelationshipId + " is not one of the policy's employer")
    if (!openAt(employment, fromMs)) denied("DATE_OUTSIDE", "The person is not employed on that date")
    const clash = rows(ASSIGNMENT, {partyRelationshipId, leaveTypeEnumId: policy.leaveTypeEnumId}).find(
        row => !voided(row) && (ms(row.fromDate) ?? -Infinity) < (thruMs ?? Infinity) && (ms(row.thruDate) ?? Infinity) > fromMs
    )
    if (clash)
        denied(
            "ASSIGNMENT_OVERLAP",
            "Already under " + (policyNames([clash.leavePolicyId])[clash.leavePolicyId] || clash.leavePolicyId) + " then"
        )
    const other = find(ENTRY)
        .condition({partyRelationshipId, leaveTypeEnumId: policy.leaveTypeEnumId})
        .condition("unitEnumId", "not-equals", policy.unitEnumId)
        .count()
    if (other > 0) denied("UNIT_MISMATCH", "Their balance of this leave type is kept in another unit")
}
// assign#Policy: employments put under a policy from a date (named, a department's or the employer's current employees), each in its
// own transaction, a refusal named and the rest going on; with preview, the rows without writing. An opening balance is posted once
// on the assignment's start. Or with end, an assignment ended from a date.
function assignPolicy(p) {
    const userScope = editorScope("Assigning a leave policy")
    if (truthy(p.end)) {
        const row = one(ASSIGNMENT, {leavePolicyAssignmentId: text(p.leavePolicyAssignmentId)})
        const policy = row ? one(POLICY, {leavePolicyId: row.leavePolicyId}) : null
        if (!row || !policy || !canEditAt(userScope, policy.organizationPartyId))
            denied("RECORD_UNAVAILABLE", "Assignment " + text(p.leavePolicyAssignmentId) + " is not available")
        if (text(p.expectedRevision) !== String(stampOf(row)))
            denied("REVISION_CHANGED", "This assignment changed since you read it; open the policy again")
        const thruMs = effective(p.thruDate)
        if (row.thruDate != null && ms(row.thruDate) <= thruMs) denied("ASSIGNMENT_ENDED", "The assignment has ended by then")
        call("update#" + ASSIGNMENT, {
            leavePolicyAssignmentId: row.leavePolicyAssignmentId,
            thruDate: stamp(Math.max(thruMs, ms(row.fromDate) ?? -Infinity)),
            thruDate_changeReason: text(p.reason) || null
        })
        return {rows: [], assignedCount: 0, refusedCount: 0, ended: true}
    }
    const policy = editablePolicy(userScope, p.leavePolicyId)
    const fromMs = effective(p.fromDate)
    const thruMs = p.thruDate ? effective(p.thruDate) : null
    if (thruMs != null && thruMs <= fromMs) denied("DATES_INVALID", "The end is after the start")
    if (fromMs < (ms(policy.fromDate) ?? -Infinity))
        denied("POLICY_NOT_IN_EFFECT", "The policy starts on " + dateText(policy.fromDate))
    if (policy.thruDate != null && fromMs >= ms(policy.thruDate)) denied("POLICY_CLOSED", "The policy is closed by then")
    const opening = num(p.openingAmount)
    if (Number.isNaN(opening)) denied("AMOUNT_INVALID", "The opening balance is a number")
    const operationKey = text(p.operationKey) || null
    const batchRows = batchEmployments(policy, p).map(partyRelationshipId => {
        const employment = policyEmployment(policy, partyRelationshipId)
        const row = {partyRelationshipId, partyId: employment?.fromPartyId || null, outcome: "ready"}
        try {
            if (operationKey && rows(ASSIGNMENT, {operationKey, partyRelationshipId, leavePolicyId: policy.leavePolicyId}).length)
                row.outcome = "repeated"
            else checkAssignable(policy, employment, fromMs, thruMs, partyRelationshipId)
        } catch (error) {
            refusedRow(row, error)
        }
        return row
    })
    if (!truthy(p.preview))
        for (const row of batchRows.filter(row => row.outcome === "ready"))
            inOwnTransaction(row, "Assigning a leave policy to employment", () => {
                lockEmployment(row.partyRelationshipId)
                checkAssignable(
                    policy,
                    policyEmployment(policy, row.partyRelationshipId),
                    fromMs,
                    thruMs,
                    row.partyRelationshipId
                )
                const created = call("create#" + ASSIGNMENT, {
                    leavePolicyId: policy.leavePolicyId,
                    partyRelationshipId: row.partyRelationshipId,
                    partyId: row.partyId,
                    organizationPartyId: policy.organizationPartyId,
                    leaveTypeEnumId: policy.leaveTypeEnumId,
                    fromDate: stamp(fromMs),
                    thruDate: stamp(thruMs),
                    openingAmount: decimal(opening),
                    reason: text(p.reason) || null,
                    operationKey,
                    assignedByUserId: ec.user.userId || null
                })
                row.leavePolicyAssignmentId = created.leavePolicyAssignmentId
                if (opening != null && opening !== 0)
                    post(entriesOf(row.partyRelationshipId, policy.leaveTypeEnumId), {
                        partyRelationshipId: row.partyRelationshipId,
                        partyId: row.partyId,
                        organizationPartyId: policy.organizationPartyId,
                        leaveTypeEnumId: policy.leaveTypeEnumId,
                        leavePolicyId: policy.leavePolicyId,
                        entryTypeEnumId: "LletOpening",
                        unitEnumId: policy.unitEnumId,
                        amount: opening,
                        effectiveMs: fromMs,
                        sourceKey: "opening:" + created.leavePolicyAssignmentId,
                        leavePolicyAssignmentId: created.leavePolicyAssignmentId,
                        description: text(p.reason) || null
                    })
                row.outcome = "done"
            })
    withTexts(batchRows)
    return {
        rows: batchRows,
        assignedCount: batchRows.filter(row => row.outcome === "done").length,
        readyCount: batchRows.filter(row => row.outcome === "ready").length,
        repeatedCount: batchRows.filter(row => row.outcome === "repeated").length,
        refusedCount: batchRows.filter(row => row.outcome === "refused").length,
        ended: false
    }
}

// ===== store#BlockedInterval =====
function blockValues(p, organizationPartyId, base) {
    const fromDay =
        given(p.fromDate) && p.fromDate !== "" ? dayParam(p.fromDate) : base ? lib.calendarDateText(base.fromDay) : null
    const thruDay =
        given(p.thruDate) && p.thruDate !== "" ? dayParam(p.thruDate) : base ? lib.calendarDateText(base.thruDay) : null
    if (!fromDay || !thruDay) denied("DATE_REQUIRED", "Enter the first and last day")
    if (thruDay < fromDay) denied("DATES_INVALID", "The last day is on or after the first")
    const kind = text(p.blockKindEnumId) || base?.blockKindEnumId || "LbkBlocked"
    if (!["LbkBlocked", "LbkMandatory"].includes(kind)) denied("KIND_INVALID", "Choose blocked or mandatory")
    const departmentPartyId = given(p.departmentPartyId) ? text(p.departmentPartyId) || null : base?.departmentPartyId || null
    if (departmentPartyId && !people.unitsUnder([organizationPartyId]).includes(departmentPartyId))
        denied("DEPARTMENT_INVALID", "Choose a department of the employer")
    const leaveTypeEnumId = given(p.leaveTypeEnumId) ? text(p.leaveTypeEnumId) || null : base?.leaveTypeEnumId || null
    if (leaveTypeEnumId) {
        const row = one(ENUM, {enumId: leaveTypeEnumId})
        if (!row || row.enumTypeId !== "PeopleLeaveType") denied("TYPE_INVALID", "Choose a leave type")
    }
    return {
        fromDay,
        thruDay,
        blockKindEnumId: kind,
        departmentPartyId,
        leaveTypeEnumId,
        overrideAllowed: given(p.overrideAllowed) ? indicator(p.overrideAllowed) : base?.overrideAllowed || "N",
        reason: given(p.reason) ? text(p.reason) || null : base?.reason || null
    }
}
// store#BlockedInterval: blocked or mandatory days entered on a policy (its employer's; a department of it and a leave type
// narrow them), a change of them at their revision, or their cancellation (kept). Approved leave is not cancelled; the requests it
// overlaps are listed for review once leave requests exist.
function storeBlockedInterval(p) {
    const userScope = editorScope("Changing blocked days")
    const id = text(p.leaveBlockedIntervalId)
    if (!id) {
        const policy = editablePolicy(userScope, p.leavePolicyId)
        const values = blockValues(p, policy.organizationPartyId, null)
        const created = call(
            "create#" + BLOCK,
            Object.assign({leavePolicyId: policy.leavePolicyId, organizationPartyId: policy.organizationPartyId}, values)
        )
        return {
            leaveBlockedIntervalId: created.leaveBlockedIntervalId,
            overlappingRequests: overlappingRequests(one(BLOCK, {leaveBlockedIntervalId: created.leaveBlockedIntervalId}))
        }
    }
    const row = one(BLOCK, {leaveBlockedIntervalId: id})
    if (!row || !canEditAt(userScope, row.organizationPartyId))
        denied("RECORD_UNAVAILABLE", "Blocked days " + id + " are not available")
    if (text(p.expectedRevision) !== String(stampOf(row)))
        denied("REVISION_CHANGED", "These days changed since you read them; open the policy again")
    if (row.cancelledDate) denied("BLOCK_CANCELLED", "These days were cancelled")
    if (truthy(p.cancel)) {
        call("update#" + BLOCK, {
            leaveBlockedIntervalId: id,
            cancelledDate: stamp(nowMs()),
            cancelledByUserId: ec.user.userId || null,
            cancelledDate_changeReason: text(p.reason) || null
        })
        return {leaveBlockedIntervalId: id, overlappingRequests: []}
    }
    call("update#" + BLOCK, Object.assign({leaveBlockedIntervalId: id}, blockValues(p, row.organizationPartyId, row)))
    return {leaveBlockedIntervalId: id, overlappingRequests: overlappingRequests(one(BLOCK, {leaveBlockedIntervalId: id}))}
}
// P12: the leave asked for or approved on blocked days, to review (nothing is cancelled): the employer's requests waiting or approved
// on its days, of its leave type and department (or a unit under it) when it names them; no reason.
function overlappingRequests(block) {
    if (!block || block.cancelledDate) return []
    const fromDay = lib.calendarDateText(block.fromDay)
    const thruDay = lib.calendarDateText(block.thruDay)
    let query = find("mantle.humanres.leave.LeaveRequest")
        .condition("organizationPartyId", block.organizationPartyId)
        .condition("statusEnumId", "in", ["LrsRequested", "LrsApproved", "LrsCancelRequested"])
        .condition("fromDay", "less-equals", thruDay)
        .condition("thruDay", "greater-equals", fromDay)
    if (block.leaveTypeEnumId) query = query.condition("leaveTypeEnumId", block.leaveTypeEnumId)
    let found = Array.from(query.limit(batchCap).list())
    if (block.departmentPartyId) {
        const within = new Set([block.departmentPartyId].concat(people.unitsUnder([block.departmentPartyId])))
        found = found.filter(row => within.has(row.departmentPartyId))
    }
    const persons = people.personNames(unique(found.map(row => row.partyId)))
    return found.map(row => ({
        leaveRequestId: row.leaveRequestId,
        personName: persons[row.partyId] || row.partyId,
        fromDay: lib.calendarDateText(row.fromDay),
        thruDay: lib.calendarDateText(row.thruDay),
        statusEnumId: row.statusEnumId
    }))
}

// ===== preview#Allocation and allocate#Leave =====
function allocationTerms(policy, p) {
    const adjustment = truthy(p.adjustment)
    const amount = num(p.amount)
    if (amount == null || Number.isNaN(amount) || amount === 0 || (!adjustment && amount < 0))
        denied("AMOUNT_INVALID", adjustment ? "Enter the adjustment, more or less than zero" : "Enter the amount granted")
    const reason = text(p.reason) || null
    if (adjustment && !reason) denied("REASON_REQUIRED", "Give the reason for the adjustment")
    let periodFromDay = dayParam(p.periodFromDate)
    let periodThruDay = dayParam(p.periodThruDate)
    if (!adjustment && (!periodFromDay || !periodThruDay)) denied("PERIOD_REQUIRED", "Enter the entitlement period")
    if (adjustment && !periodFromDay) periodFromDay = dayOf(nowMs())
    if (adjustment && !periodThruDay) periodThruDay = periodFromDay
    if (periodThruDay < periodFromDay) denied("DATES_INVALID", "The period ends on or after it starts")
    const expiryDay = dayParam(p.expiryDate)
    if (expiryDay && (adjustment || expiryDay < periodFromDay))
        denied("EXPIRY_INVALID", "A grant expires on or after its period starts")
    return {adjustment, amount: r4(amount), reason, periodFromDay, periodThruDay, expiryDay}
}
// Whether an employment may be granted under the policy for the period: the employer's (EMPLOYMENT_OUTSIDE), under the policy in
// the period (NOT_ASSIGNED), not granted for an overlapping period already (DUPLICATE_PERIOD, a grant only), and within the
// negative limit after a deduction (NEGATIVE_LIMIT). Its balance now.
function checkAllocatable(policy, employment, terms, partyRelationshipId) {
    if (!employment || employment.toPartyId !== policy.organizationPartyId)
        denied("EMPLOYMENT_OUTSIDE", "Employment " + partyRelationshipId + " is not one of the policy's employer")
    const fromMs = startOfDay(terms.periodFromDay)
    const thruMs = startOfDay(addDays(terms.periodThruDay, 1))
    const under = rows(ASSIGNMENT, {partyRelationshipId, leavePolicyId: policy.leavePolicyId}).some(
        row => !voided(row) && (ms(row.fromDate) ?? -Infinity) < thruMs && (ms(row.thruDate) ?? Infinity) > fromMs
    )
    if (!under) denied("NOT_ASSIGNED", "Not under " + (policy.policyName || policy.leavePolicyId) + " in that period")
    if (!terms.adjustment) {
        const granted = rows(ALLOCATION, {partyRelationshipId, leavePolicyId: policy.leavePolicyId}).find(
            row =>
                row.isAdjustment !== "Y" &&
                lib.calendarDateText(row.periodFromDay) <= terms.periodThruDay &&
                lib.calendarDateText(row.periodThruDay) >= terms.periodFromDay
        )
        if (granted)
            denied(
                "DUPLICATE_PERIOD",
                "Already granted for " +
                    lib.calendarDateText(granted.periodFromDay) +
                    " to " +
                    lib.calendarDateText(granted.periodThruDay) +
                    "; adjust with a reason instead"
            )
    }
    const balance = balanceAt(entriesOf(partyRelationshipId, policy.leaveTypeEnumId), nowMs())
    if (terms.amount < 0 && balance + terms.amount < -(num(policy.negativeLimit) || 0))
        denied("NEGATIVE_LIMIT", "The balance would go below the policy's limit")
    return balance
}
function allocationRows(policy, terms, p, operationKey) {
    return batchEmployments(policy, p).map(partyRelationshipId => {
        const employment = policyEmployment(policy, partyRelationshipId)
        const row = {partyRelationshipId, partyId: employment?.fromPartyId || null, amount: terms.amount, outcome: "ready"}
        try {
            if (operationKey && rows(ENTRY, {sourceKey: "allocation:" + operationKey + ":" + partyRelationshipId}).length)
                row.outcome = "repeated"
            else row.priorBalance = checkAllocatable(policy, employment, terms, partyRelationshipId)
        } catch (error) {
            refusedRow(row, error)
        }
        return row
    })
}
function allocationAnswer(policy, terms, batchRows, operationKey) {
    withTexts(batchRows)
    const unitText = enumTexts([policy.unitEnumId])[policy.unitEnumId] || ""
    const counted = outcome => batchRows.filter(row => row.outcome === outcome).length
    const ready = counted("ready")
    const done = counted("done")
    return {
        rows: batchRows,
        readyCount: ready,
        allocatedCount: done,
        repeatedCount: counted("repeated"),
        refusedCount: counted("refused"),
        total: r4((ready + done) * terms.amount),
        unitText,
        operationKey
    }
}
// preview#Allocation: the employments a grant or adjustment would reach and each one's outcome, with the count and total, and the
// operation key its confirmation posts with (one run of allocate#Leave).
function previewAllocation(p) {
    const userScope = editorScope("Allocating leave")
    const policy = editablePolicy(userScope, p.leavePolicyId)
    const terms = allocationTerms(policy, p)
    const operationKey =
        "ALLOC-" +
        String(lib.hash({userId: ec.user.userId, leavePolicyId: policy.leavePolicyId, terms, at: nowMs()}))
            .replace(/[^A-Za-z0-9]/g, "")
            .slice(0, 32)
    return allocationAnswer(policy, terms, allocationRows(policy, terms, p, null), operationKey)
}
// allocate#Leave: the grant or adjustment of a preview posted, each employment in its own transaction under its lock, once per
// operation key (a retry answers the rows already posted as repeated); a refusal named and the rest going on.
function allocateLeave(p) {
    const userScope = editorScope("Allocating leave")
    const policy = editablePolicy(userScope, p.leavePolicyId)
    const operationKey = text(p.operationKey)
    if (!operationKey) denied("OPERATION_REQUIRED", "Preview the allocation first")
    const terms = allocationTerms(policy, p)
    const batchRows = allocationRows(policy, terms, p, operationKey)
    for (const row of batchRows.filter(row => row.outcome === "ready"))
        inOwnTransaction(row, "Allocating leave to employment", () => {
            lockEmployment(row.partyRelationshipId)
            const sourceKey = "allocation:" + operationKey + ":" + row.partyRelationshipId
            const entries = entriesOf(row.partyRelationshipId, policy.leaveTypeEnumId)
            if (keyPosted(entries, sourceKey)) {
                row.outcome = "repeated"
                return
            }
            row.priorBalance = checkAllocatable(
                policy,
                policyEmployment(policy, row.partyRelationshipId),
                terms,
                row.partyRelationshipId
            )
            const allocation = call("create#" + ALLOCATION, {
                leavePolicyId: policy.leavePolicyId,
                partyRelationshipId: row.partyRelationshipId,
                partyId: row.partyId,
                organizationPartyId: policy.organizationPartyId,
                leaveTypeEnumId: policy.leaveTypeEnumId,
                amount: decimal(terms.amount),
                periodFromDay: terms.periodFromDay,
                periodThruDay: terms.periodThruDay,
                expiryDay: terms.expiryDay,
                isAdjustment: terms.adjustment ? "Y" : "N",
                reason: terms.reason,
                operationKey,
                allocatedByUserId: ec.user.userId || null,
                allocatedDate: stamp(nowMs())
            })
            const entryId = post(entries, {
                partyRelationshipId: row.partyRelationshipId,
                partyId: row.partyId,
                organizationPartyId: policy.organizationPartyId,
                leaveTypeEnumId: policy.leaveTypeEnumId,
                leavePolicyId: policy.leavePolicyId,
                entryTypeEnumId: terms.adjustment ? "LletAdjustment" : "LletGrant",
                unitEnumId: policy.unitEnumId,
                amount: terms.amount,
                effectiveMs: terms.adjustment
                    ? Math.min(nowMs(), startOfDay(terms.periodFromDay))
                    : startOfDay(terms.periodFromDay),
                sourceKey,
                leaveAllocationId: allocation.leaveAllocationId,
                periodFromDay: terms.periodFromDay,
                periodThruDay: terms.periodThruDay,
                description: terms.reason
            })
            call("update#" + ALLOCATION, {leaveAllocationId: allocation.leaveAllocationId, leaveLedgerEntryId: entryId})
            row.leaveAllocationId = allocation.leaveAllocationId
            row.outcome = "done"
        })
    return allocationAnswer(policy, terms, batchRows, operationKey)
}

// ===== get#Balances, get#MyBalances and find#Ledger =====
// The employments whose balances the caller reads (each {partyRelationshipId, partyId, organizationPartyId, kinds}): their own
// (self), their live reports' at the line's employers (team) and an HR reader's employers' employments current on the date (hr);
// selfOnly their own alone.
function balanceReach(userScope, at, selfOnly, organizationPartyId) {
    const caps = userScope.capabilities
    const reach = new Map()
    const add = (row, kind) => {
        const id = row.partyRelationshipId
        const entry = reach.get(id) || {
            partyRelationshipId: id,
            partyId: row.fromPartyId || row.partyId,
            organizationPartyId: row.toPartyId || row.organizationPartyId,
            kinds: []
        }
        if (!entry.kinds.includes(kind)) entry.kinds.push(kind)
        reach.set(id, entry)
    }
    if (caps.self) for (const row of userScope.employments || []) add(row, "self")
    if (selfOnly) return Array.from(reach.values())
    if (caps.team)
        for (const [partyId, organizationPartyIds] of Object.entries(userScope.reportLines || {})) {
            if (!organizationPartyIds.length) continue
            for (const row of Array.from(
                people
                    .current(
                        people
                            .employmentFind()
                            .condition("fromPartyId", partyId)
                            .condition("toPartyId", "in", organizationPartyIds),
                        null
                    )
                    .list()
            ))
                add(row, "team")
        }
    const employers = hrEmployers(userScope).filter(id => !organizationPartyId || id === organizationPartyId)
    if (employers.length)
        for (const row of Array.from(people.current(people.employmentFind().condition("toPartyId", "in", employers), at).list()))
            add(row, "hr")
    return Array.from(reach.values())
}
// The balance rows of employments as of a time: one per employment and leave type that has entries by then or a policy in effect
// then; each with its policy, the movements by kind, the balance and what is available (pending reservations come with leave
// requests).
function balanceRows(reach, at, leaveTypeEnumId) {
    const ids = reach.map(row => row.partyRelationshipId)
    if (!ids.length) return []
    let entryQuery = find(ENTRY).condition("partyRelationshipId", "in", ids).condition("effectiveDate", "less-equals", stamp(at))
    if (leaveTypeEnumId) entryQuery = entryQuery.condition("leaveTypeEnumId", leaveTypeEnumId)
    const entriesByKey = {}
    for (const row of Array.from(entryQuery.list())) {
        const key = row.partyRelationshipId + "/" + row.leaveTypeEnumId
        ;(entriesByKey[key] || (entriesByKey[key] = [])).push({
            amount: num(row.amount) || 0,
            effectiveMs: ms(row.effectiveDate) ?? 0,
            entryTypeEnumId: row.entryTypeEnumId,
            unitEnumId: row.unitEnumId,
            leavePolicyId: row.leavePolicyId
        })
    }
    let assignmentQuery = find(ASSIGNMENT).condition("partyRelationshipId", "in", ids)
    if (leaveTypeEnumId) assignmentQuery = assignmentQuery.condition("leaveTypeEnumId", leaveTypeEnumId)
    const assignmentsByKey = {}
    for (const row of Array.from(assignmentQuery.list()))
        if (!voided(row) && openAt(row, at)) assignmentsByKey[row.partyRelationshipId + "/" + row.leaveTypeEnumId] = row
    const keys = unique(Object.keys(entriesByKey).concat(Object.keys(assignmentsByKey)))
    const policyIds = unique(
        Object.values(assignmentsByKey)
            .map(row => row.leavePolicyId)
            .concat(Object.values(entriesByKey).flatMap(list => list.map(entry => entry.leavePolicyId)))
    )
    const policies = Object.fromEntries(
        policyIds.length
            ? Array.from(find(POLICY).condition("leavePolicyId", "in", policyIds).list()).map(row => [row.leavePolicyId, row])
            : []
    )
    const typeIds = keys.map(key => key.split("/")[1])
    const texts = enumTexts(typeIds.concat(Object.values(policies).map(row => row.unitEnumId)).concat(["LuDays", "LuHours"]))
    const byId = new Map(reach.map(row => [row.partyRelationshipId, row]))
    // P12: what the requests waiting for approval reserve, by employment and leave type
    const pendingByKey = {}
    for (const row of Array.from(
        find("mantle.humanres.leave.LeaveRequest")
            .condition("partyRelationshipId", "in", ids)
            .condition("statusEnumId", "LrsRequested")
            .list()
    )) {
        if (leaveTypeEnumId && row.leaveTypeEnumId !== leaveTypeEnumId) continue
        const key = row.partyRelationshipId + "/" + row.leaveTypeEnumId
        pendingByKey[key] = r4((pendingByKey[key] || 0) + (num(row.chargedAmount) || 0))
    }
    const persons = people.personNames(unique(reach.map(row => row.partyId)))
    const organizations = people.organizationNames(unique(reach.map(row => row.organizationPartyId)))
    return keys
        .map(key => {
            const [partyRelationshipId, typeId] = key.split("/")
            const employment = byId.get(partyRelationshipId)
            const entries = entriesByKey[key] || []
            const assignment = assignmentsByKey[key]
            const policy = policies[assignment?.leavePolicyId] || policies[entries[entries.length - 1]?.leavePolicyId] || null
            const unitEnumId = policy?.unitEnumId || entries[0]?.unitEnumId || null
            const moved = sums(entries, at)
            const pending = pendingByKey[key] || 0
            return Object.assign(
                {
                    partyRelationshipId,
                    partyId: employment.partyId,
                    personName: persons[employment.partyId] || employment.partyId,
                    organizationPartyId: employment.organizationPartyId,
                    organizationName: organizations[employment.organizationPartyId] || employment.organizationPartyId,
                    leaveTypeEnumId: typeId,
                    leaveTypeText: texts[typeId] || typeId,
                    unitEnumId,
                    unitText: texts[unitEnumId] || "",
                    leavePolicyId: assignment?.leavePolicyId || null,
                    policyName: assignment ? policies[assignment.leavePolicyId]?.policyName || assignment.leavePolicyId : "",
                    negativeLimit: num(policy?.negativeLimit) || 0,
                    pending,
                    available: r4(moved.balance - pending),
                    canSeeLedger: employment.kinds.includes("self") || employment.kinds.includes("hr")
                },
                moved
            )
        })
        .sort((a, b) => a.personName.localeCompare(b.personName) || a.leaveTypeText.localeCompare(b.leaveTypeText))
}
// get#Balances: the balances the caller reads as of asOfDate (now), narrowed to an employment, a person, an employer
// (ORGANIZATION_DENIED outside the scope), a department (the assignment in effect then) or a leave type; paged by employment.
function getBalances(p, selfOnly = false) {
    const userScope = people.scopeOf()
    const caps = userScope.capabilities
    if (selfOnly ? !caps.self : !caps.self && !caps.team && !caps.hrView)
        denied("PERMISSION_DENIED", "Leave balances need PEOPLE_SELF_SERVICE, PEOPLE_TEAM_VIEW or PEOPLE_HR_VIEW")
    const at = p.asOfDate ? people.asOfMillis(p.asOfDate) : nowMs()
    const organizationPartyId = selfOnly ? null : text(p.organizationPartyId) || null
    if (organizationPartyId) people.requireOrganization(userScope, organizationPartyId)
    let reach = balanceReach(userScope, at, selfOnly, organizationPartyId)
    if (!selfOnly) {
        if (text(p.partyRelationshipId)) {
            employmentAccess(userScope, p.partyRelationshipId, ["self", "team", "hr"])
            reach = reach.filter(row => row.partyRelationshipId === text(p.partyRelationshipId))
            if (!reach.length) {
                // an employment ended before the date: its HR reader or the person still reads its balance
                const access = employmentAccess(userScope, p.partyRelationshipId, ["self", "hr"])
                reach = [
                    {
                        partyRelationshipId: access.row.partyRelationshipId,
                        partyId: access.row.fromPartyId,
                        organizationPartyId: access.row.toPartyId,
                        kinds: access.kinds
                    }
                ]
            }
        }
        if (organizationPartyId) reach = reach.filter(row => row.organizationPartyId === organizationPartyId)
        if (text(p.partyId)) reach = reach.filter(row => row.partyId === text(p.partyId))
        if (text(p.departmentPartyId)) {
            const within = new Set([text(p.departmentPartyId)].concat(people.unitsUnder([text(p.departmentPartyId)])))
            const assigned = people.assignmentsAt(unique(reach.map(row => row.partyId)), at)
            reach = reach.filter(row => within.has(assigned[row.organizationPartyId + "/" + row.partyId]?.departmentPartyId))
        }
    }
    const persons = people.personNames(unique(reach.map(row => row.partyId)))
    reach.sort((a, b) => String(persons[a.partyId] || "").localeCompare(String(persons[b.partyId] || "")))
    const paged = lib.pageList(reach, p, "balances")
    return Object.assign(paged, {
        balances: balanceRows(paged.balances, at, text(p.leaveTypeEnumId) || null),
        asOfText: dateText(at)
    })
}
function getStaffBalances(p) {
    return getBalances(p, false)
}
function getMyBalances(p) {
    return getBalances({asOfDate: p.asOfDate, leaveTypeEnumId: p.leaveTypeEnumId}, true)
}
// What an entry came from, in the reader's words.
function sourceText(row, allocations, policies, withReasons = true) {
    const allocation = row.leaveAllocationId && withReasons ? allocations[row.leaveAllocationId] : null
    const period = row.periodFromDay
        ? lib.calendarDateText(row.periodFromDay) +
          (row.periodThruDay && lib.calendarDateText(row.periodThruDay) !== lib.calendarDateText(row.periodFromDay)
              ? " to " + lib.calendarDateText(row.periodThruDay)
              : "")
        : ""
    const policyName = policies[row.leavePolicyId] || ""
    switch (row.entryTypeEnumId) {
        case "LletOpening":
            return "Opening balance under " + policyName
        case "LletGrant":
            return "Allocation for " + period + (allocation?.reason ? ": " + allocation.reason : "")
        case "LletAdjustment":
            return "Adjustment" + (allocation?.reason ? ": " + allocation.reason : "")
        case "LletAccrual":
            return "Accrual for " + period + " under " + policyName
        case "LletExpiry":
            return row.description || "Expired"
        default:
            return row.description || ""
    }
}
// find#Ledger: an employment's movements (the person's own or an HR reader's of the employer; a manager reads balances alone), of a
// leave type, effective from fromDate through asOfDate (now), each with its source and the balance after it, and the balance
// before the first; and its legacy EmploymentLeave rows, labelled historical and counted in no balance (no reason).
function findLedger(p) {
    const userScope = people.scopeOf()
    const access = employmentAccess(userScope, p.partyRelationshipId, ["self", "hr"])
    const partyRelationshipId = access.row.partyRelationshipId
    // P12 (F202): an allocation's or adjustment's reason is HR's note, read by HR of the employer and not by the person
    const hrReads = access.kinds.includes("hr")
    const at = p.asOfDate ? people.asOfMillis(p.asOfDate) : nowMs()
    const fromMs = p.fromDate ? effective(p.fromDate) : null
    let query = find(ENTRY)
        .condition("partyRelationshipId", partyRelationshipId)
        .condition("effectiveDate", "less-equals", stamp(at))
    if (text(p.leaveTypeEnumId)) query = query.condition("leaveTypeEnumId", text(p.leaveTypeEnumId))
    const all = Array.from(query.orderBy(["effectiveDate", "leaveLedgerEntryId"]).list())
    const allocations = Object.fromEntries(
        unique(all.map(row => row.leaveAllocationId).filter(Boolean)).length
            ? Array.from(
                  find(ALLOCATION)
                      .condition("leaveAllocationId", "in", unique(all.map(row => row.leaveAllocationId).filter(Boolean)))
                      .list()
              ).map(row => [row.leaveAllocationId, row])
            : []
    )
    const policies = policyNames(all.map(row => row.leavePolicyId))
    const texts = enumTexts(all.flatMap(row => [row.entryTypeEnumId, row.leaveTypeEnumId, row.unitEnumId]))
    const running = {}
    const opening = {}
    const shown = []
    for (const row of all) {
        const typeId = row.leaveTypeEnumId
        const before = running[typeId] || 0
        running[typeId] = r4(before + (num(row.amount) || 0))
        if (fromMs != null && (ms(row.effectiveDate) ?? 0) < fromMs) {
            opening[typeId] = running[typeId]
            continue
        }
        shown.push({
            leaveLedgerEntryId: row.leaveLedgerEntryId,
            effectiveDateText: dateText(row.effectiveDate),
            entryTypeEnumId: row.entryTypeEnumId,
            entryTypeText: texts[row.entryTypeEnumId] || row.entryTypeEnumId,
            leaveTypeEnumId: typeId,
            leaveTypeText: texts[typeId] || typeId,
            amount: r4(num(row.amount) || 0),
            unitText: texts[row.unitEnumId] || "",
            balanceAfter: running[typeId],
            sourceText: sourceText(row, allocations, policies, hrReads),
            leaveAllocationId: row.leaveAllocationId || null,
            postedDateText: dateText(row.postedDate)
        })
    }
    const legacyTexts = {}
    const legacy = rows("mantle.humanres.employment.EmploymentLeave", {partyRelationshipId})
    Object.assign(legacyTexts, enumTexts(legacy.map(row => row.leaveTypeEnumId)))
    const historical = legacy
        .map(row => ({
            fromDay: lib.calendarDateText(row.fromDate),
            thruDay: row.thruDate ? lib.calendarDateText(row.thruDate) : "",
            leaveTypeText: legacyTexts[row.leaveTypeEnumId] || row.leaveTypeEnumId || "",
            approvedText: row.leaveApproved === "Y" ? "Approved" : row.leaveApproved === "N" ? "Not approved" : "",
            label: "Historical (recorded before People; not in the balance)"
        }))
        .sort((a, b) => a.fromDay.localeCompare(b.fromDay))
    const persons = people.personNames([access.row.fromPartyId])
    shown.reverse()
    return Object.assign(lib.pageList(shown, p, "entries", {noLimitCap: exportCap}), {
        partyRelationshipId,
        personName: persons[access.row.fromPartyId] || access.row.fromPartyId,
        openingBalances: Object.entries(opening).map(([typeId, value]) => ({
            leaveTypeEnumId: typeId,
            leaveTypeText: texts[typeId] || typeId,
            balance: value
        })),
        historical,
        asOfText: dateText(at)
    })
}

// ===== the accrual =====
// The step in effect at a time for the months of service then: of those reached, the one with the most months.
function stepFor(rules, at, months) {
    return (
        rules
            .filter(rule => openAt(rule, at) && Number(rule.serviceMonthsFrom || 0) <= months)
            .sort((a, b) => Number(b.serviceMonthsFrom || 0) - Number(a.serviceMonthsFrom || 0))[0] || null
    )
}
// accrue#Assignment: what an assignment has due by asOfDate (now, never later), under the employment's lock: each ended period's
// accrual, a year's carry-over expiry and a grant's expiry, in date order, each posted once by its key.
function accrueAssignment(p) {
    const assignment = one(ASSIGNMENT, {leavePolicyAssignmentId: text(p.leavePolicyAssignmentId)})
    if (!assignment || voided(assignment)) return {posted: 0}
    const policy = one(POLICY, {leavePolicyId: assignment.leavePolicyId})
    const partyRelationshipId = assignment.partyRelationshipId
    const employment = lockEmployment(partyRelationshipId)
    if (!policy || !employment) return {posted: 0}
    const asOf = Math.min(nowMs(), p.asOfDate ? ec.user.timestampMillis(p.asOfDate) : nowMs())
    const typeId = policy.leaveTypeEnumId
    const entries = entriesOf(partyRelationshipId, typeId)
    const base = {
        partyRelationshipId,
        partyId: assignment.partyId,
        organizationPartyId: policy.organizationPartyId,
        leaveTypeEnumId: typeId,
        leavePolicyId: policy.leavePolicyId,
        unitEnumId: policy.unitEnumId,
        leavePolicyAssignmentId: assignment.leavePolicyAssignmentId
    }
    const unitText = enumTexts([policy.unitEnumId])[policy.unitEnumId] || ""
    const events = []
    // the accrual periods that have ended, inside the assignment, the employment and the policy
    const frequency = policy.accrualFrequencyEnumId
    const rules = rows(RULE, {leavePolicyId: policy.leavePolicyId}).filter(rule => !voided(rule))
    const startMs = Math.max(
        ms(assignment.fromDate) ?? -Infinity,
        ms(policy.fromDate) ?? -Infinity,
        ms(employment.fromDate) ?? -Infinity
    )
    const endMs = Math.min(
        ms(assignment.thruDate) ?? Infinity,
        ms(policy.thruDate) ?? Infinity,
        ms(employment.thruDate) ?? Infinity,
        asOf
    )
    if (frequency && rules.length && Number.isFinite(startMs) && startMs < endMs) {
        const months = frequencyMonths[frequency]
        for (let day = periodStart(dayOf(startMs), frequency); ; day = addMonths(day, months)) {
            const periodFromMs = startOfDay(day)
            const nextDay = addMonths(day, months)
            const periodThruMs = startOfDay(nextDay)
            if (periodThruMs > asOf || periodFromMs >= endMs) break
            events.push({at: startOfDay(addDays(nextDay, -1)), kind: "accrual", day, nextDay, periodFromMs, periodThruMs})
        }
    }
    // what is left of a grant after its expiry day
    for (const allocation of rows(ALLOCATION, {partyRelationshipId, leavePolicyId: policy.leavePolicyId})) {
        if (allocation.isAdjustment === "Y" || !allocation.expiryDay) continue
        const expiresMs = startOfDay(addDays(lib.calendarDateText(allocation.expiryDay), 1))
        if (expiresMs <= asOf) events.push({at: expiresMs, kind: "expiry", allocation})
    }
    events.sort((a, b) => a.at - b.at)
    let posted = 0
    for (const event of events) {
        if (event.kind === "accrual") {
            const sourceKey = "accrual:" + partyRelationshipId + ":" + policy.leavePolicyId + ":" + event.day
            const lastDay = addDays(event.nextDay, -1)
            if (!keyPosted(entries, sourceKey)) {
                const covered = Math.min(endMs, event.periodThruMs) - Math.max(startMs, event.periodFromMs)
                const months = serviceMonths(dayOf(ms(employment.fromDate)), lastDay)
                const rule = stepFor(rules, event.at, months)
                if (covered > 0 && rule) {
                    const span = event.periodThruMs - event.periodFromMs
                    const fraction = covered >= span ? 1 : covered / span
                    let amount = roundTo((num(rule.amount) || 0) * fraction, num(rule.roundingIncrement) || 0.01)
                    const notes = []
                    if (fraction < 1)
                        notes.push("Part period: " + Math.round(covered / dayMs) + " of " + Math.round(span / dayMs) + " days")
                    const cap = num(rule.capAmount)
                    const balance = balanceAt(entries, event.at)
                    if (cap != null && balance + amount > cap) {
                        amount = r4(Math.max(0, cap - balance))
                        notes.push("Capped at " + amountText(cap, unitText))
                    }
                    post(
                        entries,
                        Object.assign({}, base, {
                            entryTypeEnumId: "LletAccrual",
                            amount,
                            effectiveMs: event.at,
                            sourceKey,
                            leaveAccrualRuleId: rule.leaveAccrualRuleId,
                            periodFromDay: event.day,
                            periodThruDay: lastDay,
                            description: notes.join("; ") || null
                        })
                    )
                    posted++
                }
            }
            // a year's end: the balance above the carry-over limit expires once
            if (event.nextDay.endsWith("-01-01")) {
                const rule = stepFor(rules, event.at, serviceMonths(dayOf(ms(employment.fromDate)), lastDay))
                const limit = num(rule?.carryLimit)
                const year = lastDay.slice(0, 4)
                const carryKey = "carry:" + partyRelationshipId + ":" + typeId + ":" + year
                if (limit != null && !keyPosted(entries, carryKey)) {
                    const balance = balanceAt(entries, event.periodThruMs - 1)
                    if (balance > limit) {
                        post(
                            entries,
                            Object.assign({}, base, {
                                entryTypeEnumId: "LletExpiry",
                                amount: -r4(balance - limit),
                                effectiveMs: event.periodThruMs,
                                sourceKey: carryKey,
                                leaveAccrualRuleId: rule.leaveAccrualRuleId,
                                periodFromDay: year + "-01-01",
                                periodThruDay: lastDay,
                                description:
                                    "Over the carry-over limit of " + amountText(limit, unitText) + " at the end of " + year
                            })
                        )
                        posted++
                    }
                }
            }
        } else {
            const allocation = event.allocation
            const expiryKey = "expire:" + allocation.leaveAllocationId
            if (keyPosted(entries, expiryKey)) continue
            const left = Math.min(num(allocation.amount) || 0, Math.max(0, balanceAt(entries, event.at - 1)))
            if (left <= 0) continue
            post(
                entries,
                Object.assign({}, base, {
                    entryTypeEnumId: "LletExpiry",
                    amount: -r4(left),
                    effectiveMs: event.at,
                    sourceKey: expiryKey,
                    leaveAllocationId: allocation.leaveAllocationId,
                    periodFromDay: lib.calendarDateText(allocation.periodFromDay),
                    periodThruDay: lib.calendarDateText(allocation.periodThruDay),
                    description:
                        "Allocation for " +
                        lib.calendarDateText(allocation.periodFromDay) +
                        " to " +
                        lib.calendarDateText(allocation.periodThruDay) +
                        " not used by " +
                        lib.calendarDateText(allocation.expiryDay)
                })
            )
            posted++
        }
    }
    return {posted}
}
// The assignments the accrual looks at: not voided, started by the date, ended no more than a year before it; of the policies
// given, else of every policy.
function accrualAssignments(leavePolicyIds, asOf, partyRelationshipIds) {
    let query = find(ASSIGNMENT)
        .condition("fromDate", "less", stamp(asOf))
        .condition(liveCondition(asOf - accrualLookBackMs))
        .orderBy(["leavePolicyId", "partyRelationshipId"])
    if (leavePolicyIds) query = query.condition("leavePolicyId", "in", leavePolicyIds.length ? leavePolicyIds : ["_NA_"])
    if (partyRelationshipIds?.length) query = query.condition("partyRelationshipId", "in", partyRelationshipIds)
    return Array.from(query.list()).filter(row => !voided(row))
}
// Each assignment's accrual in its own transaction (accrue#Assignment); a failure logged by its employment and policy, the rest going
// on.
function accrueAll(assignments, asOf) {
    const failedList = []
    let posted = 0
    for (const assignment of assignments) {
        ec.message.pushErrors()
        try {
            const out =
                ec.service
                    .sync()
                    .name("mantle.humanres.LeaveServices.accrue#Assignment")
                    .parameters({leavePolicyAssignmentId: assignment.leavePolicyAssignmentId, asOfDate: stamp(asOf)})
                    .requireNewTransaction(true)
                    .disableAuthz()
                    .call() || {}
            if (ec.message.hasError()) throw new Error(ec.message.getErrorsString())
            posted += Number(out.posted || 0)
        } catch (error) {
            ec.logger.error(
                "The leave accrual of employment " +
                    assignment.partyRelationshipId +
                    " under policy " +
                    assignment.leavePolicyId +
                    " failed: " +
                    error.message
            )
            failedList.push({
                partyRelationshipId: assignment.partyRelationshipId,
                leavePolicyId: assignment.leavePolicyId,
                message: String(error.message)
            })
        } finally {
            ec.message.clearErrors()
            ec.message.popErrors()
        }
    }
    return {posted, assignmentCount: assignments.length, failed: failedList.length, failedList}
}
// run#Accrual: an HR editor's run of the accrual by a date (now, never later) for a policy of theirs, or every policy of their
// employers.
function runAccrual(p) {
    const userScope = editorScope("Running the leave accrual")
    const asOf = Math.min(nowMs(), p.asOfDate ? people.asOfMillis(p.asOfDate) : nowMs())
    const policyIds = text(p.leavePolicyId)
        ? [editablePolicy(userScope, p.leavePolicyId).leavePolicyId]
        : userScope.organizationPartyIds.length
          ? Array.from(
                find(POLICY)
                    .condition("organizationPartyId", "in", userScope.organizationPartyIds)
                    .selectField(["leavePolicyId"])
                    .list()
            ).map(row => row.leavePolicyId)
          : []
    return accrueAll(accrualAssignments(policyIds, asOf, null), asOf)
}
// run#AccrualJob: the daily job, every assignment of every policy (or the employments given), by now.
function runAccrualJob(p) {
    const asOf = nowMs()
    const only = Array.from(p.partyRelationshipIds || [])
        .map(String)
        .filter(Boolean)
    return accrueAll(accrualAssignments(null, asOf, only), asOf)
}

// ===== leave requests (P12; design-people §7 LeaveRequests and LeaveRequestDetail, §13 TeamCalendar) =====
// A request of an employment for a leave type: its segments (whole days, or the morning or the afternoon of one day), charged in
// the policy's unit from the employment's working schedule (People.js Schedules: the hours each day plans, no schedule a standard
// Monday-to-Friday week of 8 hours) less the holidays of its calendar and of the employer: a whole working day is a day (its hours
// for an hours policy), a half day half of it, a day off or a holiday nothing. It waits for a People approval of kind PakLeave
// (Approvals.js, the person's manager unless a rule says otherwise); a step no one may decide is a block, not an approval. While it
// waits it reserves its amount (pending, read by get#Balances); the last approval recounts the days, checks the other requests of
// the day and the balance with the other reservations under the employment's lock and posts the leave taken once
// (sourceKey leave:<id>), then projects it as WetTimeOff work efforts with a leave-start reminder. A cancellation of approved leave
// is asked by the person (approved by the same route) or made by an HR editor of the employer at once; it posts the reversal once
// (leave-reversal:<id>) and cancels the projection. The person's reason is read only by them, their approvers and HR: never in a
// list, a notice, the calendar or the projection.
const REQUEST = "mantle.humanres.leave.LeaveRequest"
const SEGMENT = "mantle.humanres.leave.LeaveRequestSegment"
const WORK_EFFORT = "mantle.work.effort.WorkEffort"
const leaveKind = "PakLeave"
const approvals = () => ec.resource.script("component://mr-mantle/service/mantle/humanres/Approvals.js")
const schedules = () => ec.resource.script("component://mr-mantle/service/mantle/humanres/Schedules.js")
// a leave segment holds no booking, but its person organizes it: one booked on it is withdrawn with it (impl-maintenance F356)
const bookings = () => ec.resource.script("component://mr-mantle/service/mantle/work/ResourceBookingDecisions.js")
const requestStatusTexts = {
    LrsRequested: "Waiting for approval",
    LrsApproved: "Approved",
    LrsRefused: "Refused",
    LrsWithdrawn: "Withdrawn",
    LrsCancelRequested: "Cancellation asked",
    LrsCancelled: "Cancelled"
}
// the states that take their days (another request of the same day is refused) and the one that reserves its amount
const holdingStates = ["LrsRequested", "LrsApproved", "LrsCancelRequested"]
const partTexts = {LdpFull: "Whole day", LdpMorning: "Morning", LdpAfternoon: "Afternoon"}
const weekdayTexts = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
// the longest request, in days, and the most requests a list reads
const maxRequestDays = 366
const requestCap = 500
// with no working schedule: Monday to Friday, 8 hours a day
const standardDayHours = 8
// a leave-start reminder a day before
const reminderMinutes = 1440

const isoDayOfText = day => {
    const [y, m, d] = String(day).slice(0, 10).split("-").map(Number)
    const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay()
    return weekday === 0 ? 7 : weekday
}
function daysFrom(fromDay, thruDay) {
    const out = []
    for (let day = fromDay; day <= thruDay && out.length <= maxRequestDays; day = addDays(day, 1)) out.push(day)
    return out
}
const slotsOf = part => (part === "LdpMorning" ? ["AM"] : part === "LdpAfternoon" ? ["PM"] : ["AM", "PM"])
const datesTextOf = (fromDay, thruDay) => (fromDay === thruDay ? fromDay : fromDay + " to " + thruDay)
const requestRow = id => (id ? one(REQUEST, {leaveRequestId: id}) : null)
const segmentsOf = leaveRequestId =>
    rows(SEGMENT, {leaveRequestId})
        .map(row => ({
            segmentSeqId: row.segmentSeqId,
            fromDay: lib.calendarDateText(row.fromDay),
            thruDay: lib.calendarDateText(row.thruDay),
            dayPartEnumId: row.dayPartEnumId || "LdpFull",
            workEffortId: row.workEffortId || null
        }))
        .sort((a, b) => a.fromDay.localeCompare(b.fromDay))

// The segments a request names: a list of {fromDate, thruDate, dayPartEnumId}, or one given by fromDate, thruDate and
// dayPartEnumId; each a run of days, a part only on one day; none overlapping another.
function segmentsParam(p) {
    const given = Array.isArray(p.segments) || (p.segments && typeof p.segments === "object" && p.segments.length != null)
    const list = given ? Array.from(p.segments) : [{fromDate: p.fromDate, thruDate: p.thruDate, dayPartEnumId: p.dayPartEnumId}]
    const segments = list.map(item => {
        const fromDay = dayParam(item?.fromDate ?? item?.fromDay)
        const thruDay = dayParam(item?.thruDate ?? item?.thruDay) || fromDay
        const part = text(item?.dayPartEnumId) || "LdpFull"
        if (!fromDay) denied("DATE_REQUIRED", "Enter the first day of the leave")
        if (thruDay < fromDay) denied("DATES_INVALID", "The last day is on or after the first")
        if (!partTexts[part]) denied("PART_INVALID", "Choose the whole day, the morning or the afternoon")
        if (part !== "LdpFull" && thruDay !== fromDay) denied("PART_INVALID", "A morning or an afternoon is of one day")
        if (daysFrom(fromDay, thruDay).length > maxRequestDays) denied("TOO_LONG", "A request is at most a year")
        return {fromDay, thruDay, dayPartEnumId: part}
    })
    if (!segments.length) denied("DATE_REQUIRED", "Enter the first day of the leave")
    const taken = new Set()
    for (const segment of segments)
        for (const day of daysFrom(segment.fromDay, segment.thruDay))
            for (const slot of slotsOf(segment.dayPartEnumId)) {
                if (taken.has(day + slot)) denied("SEGMENTS_OVERLAP", "The days of a request do not repeat")
                taken.add(day + slot)
            }
    return segments.sort((a, b) => a.fromDay.localeCompare(b.fromDay))
}

// The employment a request is for: the one named (the person's own, or one of an employer an HR editor changes), else the
// caller's own when they have one; the access kinds the caller has to it (self, hr).
function requestEmployment(userScope, partyRelationshipId) {
    const caps = userScope.capabilities
    if (!text(partyRelationshipId)) {
        const own = (userScope.employments || []).filter(row => !row.thruDate || ms(row.thruDate) > nowMs())
        if (!caps.self || !own.length) denied("EMPLOYMENT_REQUIRED", "Choose the employment the leave is for")
        if (own.length > 1) denied("EMPLOYMENT_REQUIRED", "You work for more than one employer: choose the employment")
        partyRelationshipId = own[0].partyRelationshipId
    }
    const row = employmentRow(text(partyRelationshipId))
    const kinds = []
    if (row) {
        if (caps.self && row.fromPartyId === userScope.partyId) kinds.push("self")
        if (canEditAt(userScope, row.toPartyId)) kinds.push("hr")
    }
    if (!row || !kinds.length) denied("RECORD_UNAVAILABLE", "Employment " + text(partyRelationshipId) + " is not available")
    return {row, kinds}
}

// The days of segments as the employment's schedule and holidays charge them: each day with its hours planned, its holiday,
// its part and what it charges in the unit.
function chargedDays(employment, segments, unitEnumId) {
    const partyId = employment.fromPartyId
    const organizationPartyId = employment.toPartyId
    const allDays = unique(segments.flatMap(segment => daysFrom(segment.fromDay, segment.thruDay))).sort()
    let planned = null
    try {
        planned = schedules().scheduledDays([partyId], allDays)[partyId] || null
    } catch (error) {
        ec.logger.error("Leave of " + partyId + ": the working schedule was not read, a standard week counts: " + error.message)
    }
    let calendarHolidays = {}
    if (planned) {
        const calendarIds = unique(Object.values(planned).flatMap(entry => entry.holidayCategoryIds || []))
        if (calendarIds.length) calendarHolidays = schedules().holidaysOf(calendarIds, allDays)
    }
    const employerHolidays = {}
    if (allDays.length)
        for (const row of Array.from(
            find(WORK_EFFORT)
                .condition("purposeEnumId", "WepHoliday")
                .condition("ownerPartyId", organizationPartyId)
                .condition("allDayStart", "in", allDays)
                .list()
        ))
            employerHolidays[lib.calendarDateText(row.allDayStart)] = row.workEffortName || "Holiday"
    const out = []
    for (const segment of segments)
        for (const day of daysFrom(segment.fromDay, segment.thruDay)) {
            const plannedDay = planned ? planned[day] : null
            const hours = plannedDay ? r4(plannedDay.hours) : isoDayOfText(day) <= 5 ? standardDayHours : 0
            const holiday =
                employerHolidays[day] ||
                (plannedDay
                    ? (plannedDay.holidayCategoryIds || []).map(id => calendarHolidays[id]?.[day]).find(name => name)
                    : null) ||
                null
            const share = segment.dayPartEnumId === "LdpFull" ? 1 : 0.5
            const working = hours > 0 && !holiday
            const charged = !working ? 0 : unitEnumId === "LuHours" ? r4(hours * share) : share
            out.push({
                day,
                weekdayText: weekdayTexts[isoDayOfText(day)],
                dayPartEnumId: segment.dayPartEnumId,
                partText: partTexts[segment.dayPartEnumId],
                hours,
                holidayName: holiday || "",
                charged,
                note: holiday ? "Holiday: " + holiday : hours > 0 ? "" : "Not a working day",
                source: plannedDay ? "schedule" : "standard"
            })
        }
    return out
}

// The policy of a leave type an employment is under on a day, or null.
function policyOn(partyRelationshipId, leaveTypeEnumId, day) {
    const at = startOfDay(day) + dayMs / 2
    const assignment = rows(ASSIGNMENT, {partyRelationshipId, leaveTypeEnumId}).find(row => !voided(row) && openAt(row, at))
    return assignment ? one(POLICY, {leavePolicyId: assignment.leavePolicyId}) : null
}
// What the other requests of an employment and type waiting for approval reserve.
function pendingOf(partyRelationshipId, leaveTypeEnumId, exceptId = null) {
    return r4(
        rows(REQUEST, {partyRelationshipId, leaveTypeEnumId, statusEnumId: "LrsRequested"})
            .filter(row => row.leaveRequestId !== exceptId)
            .reduce((sum, row) => sum + (num(row.chargedAmount) || 0), 0)
    )
}
// The other requests of the person (any employment) that hold a day and part of these segments.
function overlapping(partyId, segments, exceptId = null) {
    const wanted = new Set()
    for (const segment of segments)
        for (const day of daysFrom(segment.fromDay, segment.thruDay))
            for (const slot of slotsOf(segment.dayPartEnumId)) wanted.add(day + slot)
    const first = segments[0].fromDay
    const last = segments
        .map(segment => segment.thruDay)
        .sort()
        .pop()
    const others = Array.from(
        find(REQUEST)
            .condition("partyId", partyId)
            .condition("statusEnumId", "in", holdingStates)
            .condition("fromDay", "less-equals", last)
            .condition("thruDay", "greater-equals", first)
            .list()
    ).filter(row => row.leaveRequestId !== exceptId)
    return others.filter(row =>
        segmentsOf(row.leaveRequestId).some(segment =>
            daysFrom(segment.fromDay, segment.thruDay).some(day =>
                slotsOf(segment.dayPartEnumId).some(slot => wanted.has(day + slot))
            )
        )
    )
}
// The blocked and mandatory days of the employer on the request's days that apply to it (its department, or a unit above it, and
// its leave type, when the interval names them).
function blocksOn(organizationPartyId, departmentPartyId, leaveTypeEnumId, fromDay, thruDay) {
    const within = departmentPartyId
        ? new Set([departmentPartyId].concat(unitsAbove(departmentPartyId, organizationPartyId)))
        : null
    return Array.from(
        find(BLOCK)
            .condition("organizationPartyId", organizationPartyId)
            .condition("cancelledDate", "is-null", null)
            .condition("fromDay", "less-equals", thruDay)
            .condition("thruDay", "greater-equals", fromDay)
            .list()
    ).filter(
        row =>
            (!row.leaveTypeEnumId || row.leaveTypeEnumId === leaveTypeEnumId) &&
            (!row.departmentPartyId || (within && within.has(row.departmentPartyId)))
    )
}
// the departments above a department, to the employer (a blocked interval of a department holds for the units under it)
function unitsAbove(departmentPartyId, organizationPartyId) {
    const out = []
    let current = departmentPartyId
    for (let depth = 0; depth < 12 && current && current !== organizationPartyId; depth++) {
        const parent = Array.from(
            find(RELATIONSHIP)
                .condition("relationshipTypeEnumId", "PrtOrgRollup")
                .condition("fromPartyId", current)
                .conditionDate("fromDate", "thruDate", stamp(nowMs()))
                .list()
        )[0]
        current = parent ? parent.toPartyId : null
        if (current && current !== organizationPartyId) out.push(current)
    }
    return out
}

// What a request would be: its employment, policy, days charged, the balance and the reservations, the blocked days, the other
// requests of its days and its approvers, with each problem that blocks it and each warning. checkFor: a request already made
// (its own reservation and days are left out).
function assess(userScope, p, existing = null) {
    const employment = existing
        ? {row: employmentRow(existing.partyRelationshipId), kinds: []}
        : requestEmployment(userScope, p.partyRelationshipId)
    const row = employment.row
    if (!row) denied("RECORD_UNAVAILABLE", "This employment is not available")
    const segments = existing ? segmentsOf(existing.leaveRequestId) : segmentsParam(p)
    const leaveTypeEnumId = existing ? existing.leaveTypeEnumId : text(p.leaveTypeEnumId)
    if (!leaveTypeEnumId) denied("TYPE_REQUIRED", "Choose the leave type")
    const typeRow = one(ENUM, {enumId: leaveTypeEnumId})
    if (!typeRow || typeRow.enumTypeId !== "PeopleLeaveType") denied("TYPE_INVALID", "Choose a leave type")
    const fromDay = segments[0].fromDay
    const thruDay = segments
        .map(segment => segment.thruDay)
        .sort()
        .pop()
    const problems = []
    const warnings = []
    const problem = (code, message) => problems.push({code, message})
    // the employment covers the days
    const employedFrom = row.fromDate ? dayOf(ms(row.fromDate)) : null
    const employedThru = row.thruDate ? dayOf(ms(row.thruDate) - 1) : null
    if ((employedFrom && fromDay < employedFrom) || (employedThru && thruDay > employedThru))
        problem(
            "DATE_OUTSIDE",
            "The leave is outside the employment (" + (employedFrom || "") + " to " + (employedThru || "") + ")"
        )
    const policy = existing
        ? one(POLICY, {leavePolicyId: existing.leavePolicyId}) || policyOn(row.partyRelationshipId, leaveTypeEnumId, fromDay)
        : policyOn(row.partyRelationshipId, leaveTypeEnumId, fromDay)
    if (!policy)
        problem("NO_POLICY", "No " + (typeRow.description || "leave") + " policy applies to this employment then: HR assigns one")
    const unitEnumId = policy?.unitEnumId || "LuDays"
    const days = chargedDays(row, segments, unitEnumId)
    const chargedAmount = r4(days.reduce((sum, day) => sum + day.charged, 0))
    if (!chargedAmount) problem("NOTHING_CHARGED", "These days are not working days: there is nothing to take")
    // the balance now, what the other waiting requests reserve and what is left after this one
    const entries = entriesOf(row.partyRelationshipId, leaveTypeEnumId)
    const balance = balanceAt(entries, Infinity)
    const pending = pendingOf(row.partyRelationshipId, leaveTypeEnumId, existing?.leaveRequestId || null)
    const available = r4(balance - pending)
    const remainder = r4(available - chargedAmount)
    const negativeLimit = num(policy?.negativeLimit) || 0
    const needsBalance = policy ? truthy(policy.allocationRequired) : false
    if (policy && needsBalance && remainder < -negativeLimit)
        problem(
            "BALANCE_INSUFFICIENT",
            "Not enough leave: " +
                amountText(available, unitTextOf(unitEnumId)) +
                " available for " +
                amountText(chargedAmount, unitTextOf(unitEnumId))
        )
    // the other requests of the same days
    const clashes = overlapping(row.fromPartyId, segments, existing?.leaveRequestId || null)
    if (clashes.length)
        problem(
            "OVERLAP",
            "Leave is already asked for or approved on " +
                clashes
                    .map(other => datesTextOf(lib.calendarDateText(other.fromDay), lib.calendarDateText(other.thruDay)))
                    .join(", ")
        )
    // blocked and mandatory days
    const assignment = people.assignmentsAt([row.fromPartyId], startOfDay(fromDay) + dayMs / 2)[
        row.toPartyId + "/" + row.fromPartyId
    ]
    const departmentPartyId = existing ? existing.departmentPartyId || null : assignment?.departmentPartyId || null
    const blocks = blocksOn(row.toPartyId, departmentPartyId, leaveTypeEnumId, fromDay, thruDay)
    const blockRows = blocks.map(block => ({
        leaveBlockedIntervalId: block.leaveBlockedIntervalId,
        blockKindEnumId: block.blockKindEnumId,
        fromDay: lib.calendarDateText(block.fromDay),
        thruDay: lib.calendarDateText(block.thruDay),
        overrideAllowed: block.overrideAllowed === "Y",
        reason: block.reason || ""
    }))
    let overrideBlocked = false
    for (const block of blockRows) {
        if (block.blockKindEnumId === "LbkMandatory") {
            warnings.push({code: "MANDATORY_DAYS", message: "Mandatory leave from " + block.fromDay + " to " + block.thruDay})
            continue
        }
        const what =
            "Leave is blocked from " + block.fromDay + " to " + block.thruDay + (block.reason ? " (" + block.reason + ")" : "")
        if (block.overrideAllowed) {
            overrideBlocked = true
            warnings.push({code: "BLOCKED_OVERRIDABLE", message: what + ": the approver decides"})
        } else problem("BLOCKED_DAY", what)
    }
    // who would approve: a step no one may decide is a block
    let route = {steps: [], unresolved: false}
    if (!existing) {
        route = approvals().previewRoute({
            approvalKindEnumId: leaveKind,
            organizationPartyId: row.toPartyId,
            departmentPartyId,
            subjectPartyId: row.fromPartyId,
            requesterPartyId: ec.user.userAccount?.partyId || null
        })
        if (route.unresolved) problem("NO_APPROVER", "No one may approve this leave yet: HR sets who approves it")
    }
    if (policy && truthy(policy.evidenceRequired))
        warnings.push({code: "EVIDENCE_REQUIRED", message: "This leave needs evidence: give it to HR"})
    const texts = enumTexts([leaveTypeEnumId, unitEnumId])
    const persons = people.personNames([row.fromPartyId])
    const organizations = people.organizationNames([row.toPartyId])
    return {
        employment: row,
        kinds: employment.kinds,
        segments,
        fromDay,
        thruDay,
        leaveTypeEnumId,
        leaveTypeText: texts[leaveTypeEnumId] || leaveTypeEnumId,
        policy,
        unitEnumId,
        unitText: texts[unitEnumId] || "",
        departmentPartyId,
        days,
        chargedAmount,
        balance,
        pending,
        available,
        remainder,
        negativeLimit,
        needsBalance,
        overrideBlocked,
        blocks: blockRows,
        route,
        problems,
        warnings,
        personName: persons[row.fromPartyId] || row.fromPartyId,
        organizationName: organizations[row.toPartyId] || row.toPartyId
    }
}
const unitTextOf = unitEnumId => (unitEnumId === "LuHours" ? "hours" : "days")
function assessmentAnswer(found) {
    return {
        partyRelationshipId: found.employment.partyRelationshipId,
        partyId: found.employment.fromPartyId,
        personName: found.personName,
        organizationPartyId: found.employment.toPartyId,
        organizationName: found.organizationName,
        leaveTypeEnumId: found.leaveTypeEnumId,
        leaveTypeText: found.leaveTypeText,
        leavePolicyId: found.policy?.leavePolicyId || null,
        policyName: found.policy?.policyName || "",
        unitEnumId: found.unitEnumId,
        unitText: found.unitText,
        datesText: datesTextOf(found.fromDay, found.thruDay),
        days: found.days,
        chargedAmount: found.chargedAmount,
        balance: found.balance,
        pending: found.pending,
        available: found.available,
        remainder: found.remainder,
        needsBalance: found.needsBalance,
        blocks: found.blocks.map(block => Object.assign({}, block)),
        approverSteps: found.route.steps.map(step => ({
            stepText: step.stepText,
            approverNames: step.approverNames,
            explanation: step.explanation
        })),
        problems: found.problems,
        warnings: found.warnings,
        canSubmit: !found.problems.length
    }
}

// preview#Request: what a request would charge and whether it may be made. Refuses only what names no request (no employment of
// the caller's, no type, dates the wrong way); the rest are problems in the answer.
function previewRequest(p) {
    const userScope = people.scopeOf()
    return assessmentAnswer(assess(userScope, p))
}

// submit#Request: the person (or an HR editor of the employer) asks for leave: assessed again under the employment's lock, refused
// with the first problem, made and sent for approval. A retry with the same operationKey answers the first.
function submitRequest(p) {
    const userScope = people.scopeOf()
    const operationKey = text(p.operationKey) || null
    const firstOf = () =>
        operationKey
            ? Array.from(find(REQUEST).condition({operationKey, requestedByUserId: ec.user.userId}).limit(1).list())[0]
            : null
    let first = firstOf()
    if (first) return Object.assign(requestAnswer(first), {repeated: true})
    const employment = requestEmployment(userScope, p.partyRelationshipId)
    lockEmployment(employment.row.partyRelationshipId)
    // a retry that waited on the lock answers the first too
    first = firstOf()
    if (first) return Object.assign(requestAnswer(first), {repeated: true})
    const found = assess(userScope, Object.assign({}, p, {partyRelationshipId: employment.row.partyRelationshipId}))
    if (found.problems.length) denied(found.problems[0].code, found.problems.map(item => item.message).join("; "))
    const reason = text(p.reason) || null
    const created = call("create#" + REQUEST, {
        partyRelationshipId: found.employment.partyRelationshipId,
        partyId: found.employment.fromPartyId,
        organizationPartyId: found.employment.toPartyId,
        departmentPartyId: found.departmentPartyId,
        leaveTypeEnumId: found.leaveTypeEnumId,
        leavePolicyId: found.policy.leavePolicyId,
        unitEnumId: found.unitEnumId,
        statusEnumId: "LrsRequested",
        fromDay: found.fromDay,
        thruDay: found.thruDay,
        chargedAmount: decimal(found.chargedAmount),
        reason,
        overrideBlocked: found.overrideBlocked ? "Y" : "N",
        requestedByUserId: ec.user.userId || null,
        requestedDate: ec.user.nowTimestamp,
        operationKey
    })
    found.segments.forEach((segment, index) =>
        call("create#" + SEGMENT, {
            leaveRequestId: created.leaveRequestId,
            segmentSeqId: String(index + 1).padStart(2, "0"),
            fromDay: segment.fromDay,
            thruDay: segment.thruDay,
            dayPartEnumId: segment.dayPartEnumId
        })
    )
    askApproval(requestRow(created.leaveRequestId))
    return Object.assign(requestAnswer(requestRow(created.leaveRequestId)), {repeated: false})
}
// A People approval of the request at its revision, to its route's first step (the reason is never the justification).
function askApproval(request) {
    return approvals().request({
        approvalKindEnumId: leaveKind,
        sourceId: request.leaveRequestId,
        organizationPartyId: request.organizationPartyId,
        departmentPartyId: request.departmentPartyId || null,
        subjectPartyId: request.partyId,
        effectiveDate: startOfDay(lib.calendarDateText(request.fromDay))
    })
}
const requestAnswer = request => ({
    leaveRequestId: request.leaveRequestId,
    statusEnumId: request.statusEnumId,
    statusText: requestStatusTexts[request.statusEnumId] || request.statusEnumId,
    chargedAmount: num(request.chargedAmount) || 0
})

// ===== who reads and decides a request =====
// How the scope admits a request: self (the person's), requester (who asked for it), hr (an HR reader of the employer; hrEdit
// when they change it), team (a manager of the person at the employer), approver (one who may decide its step waiting or decided
// a step of it). Missing and unauthorized alike: RECORD_UNAVAILABLE.
function requestAccess(userScope, request, summary) {
    const caps = userScope.capabilities
    const kinds = []
    if (request) {
        if (caps.self && request.partyId === userScope.partyId) kinds.push("self")
        if (request.requestedByUserId && request.requestedByUserId === ec.user.userId) kinds.push("requester")
        if (hrEmployers(userScope).includes(request.organizationPartyId)) kinds.push("hr")
        if (canEditAt(userScope, request.organizationPartyId)) kinds.push("hrEdit")
        if (caps.team && ((userScope.reportLines || {})[request.partyId] || []).includes(request.organizationPartyId))
            kinds.push("team")
        const partyId = userScope.partyId
        if (
            summary &&
            (summary.canDecide || (partyId && Array.from(summary.decisions || []).some(row => row.decidedByPartyId === partyId)))
        )
            kinds.push("approver")
    }
    return kinds
}
function readableRequest(userScope, leaveRequestId) {
    const request = requestRow(text(leaveRequestId))
    const summary = request ? approvals().sourceSummary(leaveKind, request.leaveRequestId) : null
    const kinds = requestAccess(userScope, request, summary && summaryDeciders(request, summary))
    if (!request || !kinds.length) denied("RECORD_UNAVAILABLE", "Leave request " + text(leaveRequestId) + " is not available")
    return {request, summary, kinds}
}
// the approval summary with the deciders' parties (sourceSummary names them): the parties of the request's decisions
function summaryDeciders(request, summary) {
    const decided = rows("mantle.humanres.approval.PeopleApproval", {sourceEntityName: REQUEST, sourceId: request.leaveRequestId})
        .flatMap(approval =>
            rows("mantle.humanres.approval.PeopleApprovalDecision", {peopleApprovalId: approval.peopleApprovalId})
        )
        .map(row => ({decidedByPartyId: row.decidedByPartyId}))
    return {canDecide: summary.canDecide, decisions: decided}
}
// Whether the caller reads the person's reason: the person, the one who asked, HR of the employer and the approvers.
const readsReason = kinds => kinds.some(kind => ["self", "requester", "hr", "approver"].includes(kind))

// get#Request: a request the caller may read, with its days and what each charges, its balance statement (the balance, the other
// reservations, this request and what is left), its approval (steps, decisions, who decides now), the decision notice, and what the
// caller may do: approve or refuse (an approver of the step waiting), withdraw (the person or who asked, while it waits), cancel
// (the person asks it of approved leave; an HR editor of the employer cancels at once). The reason only to those readsReason admits.
function getRequest(p) {
    const userScope = people.scopeOf()
    const {request, summary, kinds} = readableRequest(userScope, p.leaveRequestId)
    const found = assess(userScope, {}, request)
    const status = request.statusEnumId
    const own = kinds.includes("self") || kinds.includes("requester")
    const decided = rows("mantle.humanres.approval.PeopleApproval", {sourceEntityName: REQUEST, sourceId: request.leaveRequestId})
        .flatMap(approval =>
            rows("mantle.humanres.approval.PeopleApprovalDecision", {peopleApprovalId: approval.peopleApprovalId})
        )
        .sort((a, b) => (ms(a.decisionDate) || 0) - (ms(b.decisionDate) || 0))
    const last = decided[decided.length - 1] || null
    const names = people.personNames(unique(decided.map(row => row.decidedByPartyId).filter(Boolean)))
    // HR's cancellation at once is its own notice (who, when and why); the others are the last decision's
    const hrName = () => {
        const partyId = one("moqui.security.UserAccount", {userId: request.cancelledByUserId})?.partyId
        return (partyId && people.personNames([partyId])[partyId]) || request.cancelledByUserId
    }
    const notice =
        status === "LrsCancelled" && request.cancelledByUserId
            ? {
                  outcomeText: "Cancelled",
                  decidedByName: hrName(),
                  decidedDateText: dateText(request.cancelledDate),
                  reason: request.cancelReason || ""
              }
            : ["LrsApproved", "LrsRefused", "LrsCancelled"].includes(status) && last
              ? {
                    outcomeText: requestStatusTexts[status],
                    decidedByName: names[last.decidedByPartyId] || last.decidedByUserId || "",
                    decidedDateText: dateText(last.decisionDate),
                    reason: last.decisionEnumId === "PpdRefused" ? last.reason || "" : ""
                }
              : null
    const charged = num(request.chargedAmount) || 0
    // the balance statement: the posted balance (with this leave once taken), the other reservations, and what is left
    const statement = {
        balance: found.balance,
        pending: found.pending,
        thisRequest: charged,
        reserved: status === "LrsRequested",
        taken: ["LrsApproved", "LrsCancelRequested"].includes(status),
        remainder: status === "LrsRequested" ? r4(found.available - charged) : found.available
    }
    const segmentRows = segmentsOf(request.leaveRequestId).map(segment =>
        Object.assign({}, segment, {
            partText: partTexts[segment.dayPartEnumId],
            datesText: datesTextOf(segment.fromDay, segment.thruDay)
        })
    )
    return {
        request: {
            leaveRequestId: request.leaveRequestId,
            partyRelationshipId: request.partyRelationshipId,
            partyId: request.partyId,
            personName: found.personName,
            organizationPartyId: request.organizationPartyId,
            organizationName: found.organizationName,
            leaveTypeEnumId: request.leaveTypeEnumId,
            leaveTypeText: found.leaveTypeText,
            leavePolicyId: request.leavePolicyId,
            policyName: found.policy?.policyName || "",
            unitText: found.unitText,
            statusEnumId: status,
            statusText: requestStatusTexts[status] || status,
            fromDay: found.fromDay,
            thruDay: found.thruDay,
            datesText: datesTextOf(found.fromDay, found.thruDay),
            chargedAmount: charged,
            chargedText: amountText(charged, found.unitText),
            overrideBlocked: request.overrideBlocked === "Y",
            requestedDateText: dateText(request.requestedDate),
            decidedDateText: dateText(request.decidedDate),
            cancelledDateText: dateText(request.cancelledDate),
            reason: readsReason(kinds) ? request.reason || "" : null,
            revision: String(stampOf(request))
        },
        segments: segmentRows,
        days: found.days,
        statement,
        blocks: found.blocks,
        approval: summary,
        notice,
        access: kinds,
        canDecide: !!summary?.canDecide && ["LrsRequested", "LrsCancelRequested"].includes(status),
        canWithdraw: own && status === "LrsRequested",
        canAskCancel: kinds.includes("self") && status === "LrsApproved",
        canCancel:
            kinds.includes("hrEdit") &&
            request.partyId !== userScope.partyId &&
            ["LrsApproved", "LrsCancelRequested"].includes(status)
    }
}

// ===== decide#Request and the topic's services =====
// approve or refuse (the step waiting, through record#Decision at the request's revision: the last approval of a request recounts,
// checks and posts the leave taken once; of a cancellation posts the reversal once; a refusal needs a reason), withdraw (the person
// or who asked, while it waits), cancel (approved leave: the person asks it, which waits for approval; an HR editor of the
// employer cancels it at once, with a reason). Each under the employment's lock. A decision retried answers the first.
function decideRequest(p) {
    const userScope = people.scopeOf()
    const action = text(p.decision) || "approve"
    if (!["approve", "refuse", "withdraw", "cancel"].includes(action))
        denied("DECISION_INVALID", "Approve, refuse, withdraw or cancel")
    let request = requestRow(text(p.leaveRequestId))
    if (!request) denied("RECORD_UNAVAILABLE", "Leave request " + text(p.leaveRequestId) + " is not available")
    lockEmployment(request.partyRelationshipId)
    request = requestRow(request.leaveRequestId)
    // one who reads no part of it is answered as for a missing request, whatever they ask
    const summary = approvals().sourceSummary(leaveKind, request.leaveRequestId)
    const kinds = requestAccess(userScope, request, summary && summaryDeciders(request, summary))
    if (!kinds.length) denied("RECORD_UNAVAILABLE", "Leave request " + request.leaveRequestId + " is not available")
    if (action === "approve" || action === "refuse") return decideApproval(userScope, request, action, p)
    if (text(p.expectedRevision) && text(p.expectedRevision) !== String(stampOf(request)))
        denied("REVISION_CHANGED", "This request changed since you read it; open it again")
    if (action === "withdraw") {
        if (!kinds.includes("self") && !kinds.includes("requester"))
            denied("NOT_YOURS", "Only the person or who asked for it withdraws a request")
        if (request.statusEnumId !== "LrsRequested") denied("NOT_PENDING", "Only a request waiting for approval is withdrawn")
        setStatus(request, {statusEnumId: "LrsWithdrawn", cancelledDate: ec.user.nowTimestamp})
        approvals().sourceChanged(leaveKind, request.leaveRequestId)
        return Object.assign(requestAnswer(requestRow(request.leaveRequestId)), {repeated: false})
    }
    // cancel
    if (request.statusEnumId === "LrsRequested" && (kinds.includes("self") || kinds.includes("requester")))
        return decideRequest(Object.assign({}, p, {decision: "withdraw"}))
    if (!["LrsApproved", "LrsCancelRequested"].includes(request.statusEnumId))
        denied("NOT_APPROVED", "Only approved leave is cancelled")
    // HR cancels another person's leave at once, never their own (which they ask to cancel, as anyone does: no self-approval)
    if (kinds.includes("hrEdit") && request.partyId !== userScope.partyId) {
        const reason = text(p.reason)
        if (!reason) denied("REASON_REQUIRED", "Give the reason for cancelling")
        cancelTaken(request, {cancelledByUserId: ec.user.userId || null, cancelReason: reason})
        if (request.statusEnumId === "LrsCancelRequested") approvals().sourceChanged(leaveKind, request.leaveRequestId)
        tellPerson(requestRow(request.leaveRequestId), "Cancelled by HR")
        return Object.assign(requestAnswer(requestRow(request.leaveRequestId)), {repeated: false})
    }
    if (!kinds.includes("self")) denied("NOT_YOURS", "Only the person asks to cancel their leave, or HR cancels it")
    if (request.statusEnumId === "LrsCancelRequested") denied("CANCEL_PENDING", "Its cancellation already waits for approval")
    setStatus(request, {statusEnumId: "LrsCancelRequested"})
    askApproval(requestRow(request.leaveRequestId))
    return Object.assign(requestAnswer(requestRow(request.leaveRequestId)), {repeated: false})
}
function setStatus(request, values) {
    call("update#" + REQUEST, Object.assign({leaveRequestId: request.leaveRequestId}, values))
}
function decideApproval(userScope, request, action, p) {
    const asked = request.statusEnumId
    const decided = call("mantle.humanres.PeopleApprovalServices.record#Decision", {
        approvalKindEnumId: leaveKind,
        peopleApprovalId: text(p.peopleApprovalId) || null,
        sourceId: request.leaveRequestId,
        decision: action,
        reason: text(p.reason) || null,
        sourceRevision: text(p.sourceRevision) || null,
        operationKey: text(p.operationKey) || null
    })
    if (decided.repeated) return Object.assign(requestAnswer(requestRow(request.leaveRequestId)), {repeated: true})
    if (asked === "LrsRequested") {
        if (decided.complete) {
            // recounted, checked against the other requests and the balance with the other reservations, then taken once
            const found = assess(userScope, {}, request)
            const blocking = found.problems.filter(item => item.code !== "NO_APPROVER")
            if (blocking.length) denied(blocking[0].code, blocking.map(item => item.message).join("; "))
            takeLeave(request, found)
            tellPerson(requestRow(request.leaveRequestId), "Approved")
        } else if (decided.statusId === "PapRefused") {
            setStatus(request, {statusEnumId: "LrsRefused", decidedDate: ec.user.nowTimestamp})
            tellPerson(requestRow(request.leaveRequestId), "Refused")
        }
    } else if (asked === "LrsCancelRequested") {
        if (decided.complete) {
            cancelTaken(request)
            tellPerson(requestRow(request.leaveRequestId), "Cancelled")
        } else if (decided.statusId === "PapRefused") {
            setStatus(request, {statusEnumId: "LrsApproved"})
            tellPerson(requestRow(request.leaveRequestId), "Cancellation refused")
        }
    } else denied("NOT_PENDING", "This request is " + (requestStatusTexts[asked] || asked).toLowerCase())
    return Object.assign(requestAnswer(requestRow(request.leaveRequestId)), {repeated: false})
}
// The leave taken: the consumption posted once (leave:<id>, when the policy keeps a balance), the request approved with what it
// charges now, and its projection.
function takeLeave(request, found) {
    const entries = entriesOf(request.partyRelationshipId, request.leaveTypeEnumId)
    const sourceKey = "leave:" + request.leaveRequestId
    let consumptionEntryId = null
    if (found.needsBalance && found.chargedAmount && !keyPosted(entries, sourceKey))
        consumptionEntryId = post(entries, {
            partyRelationshipId: request.partyRelationshipId,
            partyId: request.partyId,
            organizationPartyId: request.organizationPartyId,
            leaveTypeEnumId: request.leaveTypeEnumId,
            leavePolicyId: request.leavePolicyId,
            entryTypeEnumId: "LletConsumption",
            unitEnumId: found.unitEnumId,
            amount: -found.chargedAmount,
            effectiveMs: startOfDay(found.fromDay),
            sourceKey,
            periodFromDay: found.fromDay,
            periodThruDay: found.thruDay,
            description: "Leave taken " + datesTextOf(found.fromDay, found.thruDay)
        })
    setStatus(request, {
        statusEnumId: "LrsApproved",
        decidedDate: ec.user.nowTimestamp,
        chargedAmount: decimal(found.chargedAmount),
        consumptionEntryId
    })
    project(requestRow(request.leaveRequestId), found.days)
}
// A cancellation of approved leave: the reversal of what was taken posted once (leave-reversal:<id>), the projection cancelled.
function cancelTaken(request, values = {}) {
    const entries = entriesOf(request.partyRelationshipId, request.leaveTypeEnumId)
    const sourceKey = "leave-reversal:" + request.leaveRequestId
    let reversalEntryId = null
    const taken = request.consumptionEntryId ? one(ENTRY, {leaveLedgerEntryId: request.consumptionEntryId}) : null
    if (taken && !keyPosted(entries, sourceKey)) {
        const fromDay = lib.calendarDateText(request.fromDay)
        reversalEntryId = post(entries, {
            partyRelationshipId: request.partyRelationshipId,
            partyId: request.partyId,
            organizationPartyId: request.organizationPartyId,
            leaveTypeEnumId: request.leaveTypeEnumId,
            leavePolicyId: request.leavePolicyId,
            entryTypeEnumId: "LletReversal",
            unitEnumId: taken.unitEnumId,
            amount: -(num(taken.amount) || 0),
            effectiveMs: ms(taken.effectiveDate) ?? startOfDay(fromDay),
            sourceKey,
            reversedEntryId: taken.leaveLedgerEntryId,
            periodFromDay: fromDay,
            periodThruDay: lib.calendarDateText(request.thruDay),
            description: "Leave cancelled " + datesTextOf(fromDay, lib.calendarDateText(request.thruDay))
        })
    }
    setStatus(
        request,
        Object.assign({statusEnumId: "LrsCancelled", cancelledDate: ec.user.nowTimestamp, reversalEntryId}, values)
    )
    for (const segment of segmentsOf(request.leaveRequestId)) {
        if (!segment.workEffortId) continue
        const effort = one(WORK_EFFORT, {workEffortId: segment.workEffortId})
        if (effort && effort.statusId !== "WeCancelled") {
            call("update#" + WORK_EFFORT, {workEffortId: segment.workEffortId, statusId: "WeCancelled"})
            bookings().keptEventCancelled(segment.workEffortId)
        }
    }
}
// Approved leave as the person's WetTimeOff work efforts, one a segment ("Out of office": no type, no reason), which capacity
// (mantle.work.ResourceServices.get#PartyCapacity) and the calendars read: whole days all day, a morning from 08:00 and an afternoon
// from 13:00 for half the day's planned hours (capacity takes that many hours off the day). A reminder of the first, a day before
// its start, for the person (the reminder job sends it on the WorkEffortReminder topic).
function project(request, days) {
    const hoursOf = Object.fromEntries(days.map(day => [day.day, day.hours || standardDayHours]))
    let first = null
    for (const segment of segmentsOf(request.leaveRequestId)) {
        if (segment.workEffortId) continue
        const fromMs = startOfDay(segment.fromDay)
        const values = {
            workEffortTypeEnumId: "WetTimeOff",
            workEffortName: "Out of office",
            statusId: "WeApproved",
            ownerPartyId: request.partyId,
            timeUomId: "TF_hr"
        }
        if (segment.dayPartEnumId === "LdpFull")
            Object.assign(values, {
                allDayStart: segment.fromDay,
                allDayEnd: segment.thruDay,
                estimatedStartDate: stamp(fromMs),
                estimatedCompletionDate: stamp(startOfDay(addDays(segment.thruDay, 1)))
            })
        else {
            const halfMs = (hoursOf[segment.fromDay] / 2) * 60 * 60 * 1000
            const startMs = fromMs + (segment.dayPartEnumId === "LdpMorning" ? 8 : 13) * 60 * 60 * 1000
            Object.assign(values, {
                estimatedStartDate: stamp(startMs),
                estimatedCompletionDate: stamp(startMs + halfMs),
                estimatedWorkDuration: r4(hoursOf[segment.fromDay] / 2)
            })
        }
        const workEffortId = call("create#" + WORK_EFFORT, values).workEffortId
        call("create#mantle.work.effort.WorkEffortParty", {
            workEffortId,
            partyId: request.partyId,
            roleTypeId: "Assignee",
            fromDate: ec.user.nowTimestamp,
            statusId: "WeptAssigned"
        })
        call("update#" + SEGMENT, {leaveRequestId: request.leaveRequestId, segmentSeqId: segment.segmentSeqId, workEffortId})
        if (!first) first = workEffortId
    }
    if (first)
        call("create#mantle.work.effort.WorkEffortReminder", {
            workEffortId: first,
            partyId: request.partyId,
            reminderSeqId: "01",
            offsetMinutes: reminderMinutes,
            methodEnumId: "WermNotification"
        })
}
// The decision told to the person (and to who asked, when another): PeopleLeaveDecision, with the days and the outcome only, to
// them alone (directOnly, People follow-up 1). A failure is logged and the decision stays.
function tellPerson(request, outcomeText) {
    try {
        const partyUsers = Array.from(find("moqui.security.UserAccount").condition("partyId", request.partyId).list()).map(
            row => row.userId
        )
        const userIds = unique(partyUsers.concat(request.requestedByUserId ? [request.requestedByUserId] : [])).filter(
            userId => userId && userId !== ec.user.userId
        )
        if (!userIds.length) return
        ec.makeNotificationMessage()
            .topic("PeopleLeaveDecision")
            .message({
                leaveRequestId: request.leaveRequestId,
                datesText: datesTextOf(lib.calendarDateText(request.fromDay), lib.calendarDateText(request.thruDay)),
                outcomeText
            })
            .record(REQUEST, request.leaveRequestId)
            .userIds(userIds)
            .directOnly()
            .send()
    } catch (error) {
        ec.logger.error("Leave decision notice of " + request.leaveRequestId + " was not sent: " + error.message)
    }
}
function decideNotice(p, decision) {
    const message = p.message || {}
    if (p.recordEntityName && p.recordEntityName !== REQUEST) denied("SOURCE_INVALID", "Not a leave approval")
    return decideRequest({
        leaveRequestId: p.recordId,
        peopleApprovalId: message.peopleApprovalId,
        sourceRevision: message.sourceRevision,
        decision,
        reason: p.reason
    })
}
const approveNotice = p => decideNotice(p, "approve")
const refuseNotice = p => decideNotice(p, "refuse")

// ===== find#Requests =====
// The requests the caller reads: their own (mine, or self-service alone), their reports' (a manager at the line's employers), and
// an HR reader's employers'; narrowed by a person, an employer, a state, a leave type and days; toDecide: those whose step waiting
// the caller decides. Newest first. No reason in any row.
function findRequests(p) {
    const userScope = people.scopeOf()
    const caps = userScope.capabilities
    if (!caps.self && !caps.team && !caps.hrView && !caps.requestApprove)
        denied(
            "PERMISSION_DENIED",
            "Leave requests need PEOPLE_SELF_SERVICE, PEOPLE_TEAM_VIEW, PEOPLE_REQUEST_APPROVE or PEOPLE_HR_VIEW"
        )
    const factory = ec.entity.conditionFactory
    const reach = []
    if (caps.self && userScope.partyId) reach.push(factory.makeCondition("partyId", "equals", userScope.partyId))
    const mine = truthy(p.mine)
    if (!mine) {
        for (const [partyId, organizationPartyIds] of Object.entries(userScope.reportLines || {}))
            if (organizationPartyIds.length)
                reach.push(
                    factory.makeCondition(
                        factory.makeCondition("partyId", "equals", partyId),
                        "and",
                        factory.makeCondition("organizationPartyId", "in", organizationPartyIds)
                    )
                )
        const employers = hrEmployers(userScope)
        if (employers.length) reach.push(factory.makeCondition("organizationPartyId", "in", employers))
    }
    let waiting = null
    if (!mine && caps.requestApprove) {
        waiting = new Set(
            approvals()
                .waitingFor(requestCap)
                .filter(row => row.approvalKindEnumId === leaveKind)
                .map(row => row.sourceId)
        )
        if (waiting.size) reach.push(factory.makeCondition("leaveRequestId", "in", Array.from(waiting)))
    }
    if (!reach.length) return Object.assign(lib.pageList([], p, "requests"), {})
    let query = find(REQUEST).condition(reach.length === 1 ? reach[0] : factory.makeCondition(reach, "or"))
    if (text(p.partyId)) query = query.condition("partyId", text(p.partyId))
    if (text(p.organizationPartyId)) query = query.condition("organizationPartyId", text(p.organizationPartyId))
    if (text(p.leaveTypeEnumId)) query = query.condition("leaveTypeEnumId", text(p.leaveTypeEnumId))
    const statuses = String(p.statusEnumId || "")
        .split(",")
        .map(text)
        .filter(Boolean)
    if (statuses.length) query = query.condition("statusEnumId", "in", statuses)
    if (dayParam(p.fromDate)) query = query.condition("thruDay", "greater-equals", dayParam(p.fromDate))
    if (dayParam(p.thruDate)) query = query.condition("fromDay", "less-equals", dayParam(p.thruDate))
    if (truthy(p.toDecide)) {
        const ids = waiting ? Array.from(waiting) : []
        query = query.condition("leaveRequestId", "in", ids.length ? ids : ["_NA_"])
    }
    const found = Array.from(query.orderBy(["-fromDay", "-requestedDate"]).limit(requestCap).list())
    const persons = people.personNames(unique(found.map(row => row.partyId)))
    const organizations = people.organizationNames(unique(found.map(row => row.organizationPartyId)))
    const texts = enumTexts(found.flatMap(row => [row.leaveTypeEnumId, row.unitEnumId]))
    const requests = found.map(row => {
        const fromDay = lib.calendarDateText(row.fromDay)
        const thruDay = lib.calendarDateText(row.thruDay)
        const amount = num(row.chargedAmount) || 0
        const parts = rows(SEGMENT, {leaveRequestId: row.leaveRequestId}).map(segment => segment.dayPartEnumId)
        return {
            leaveRequestId: row.leaveRequestId,
            partyId: row.partyId,
            personName: persons[row.partyId] || row.partyId,
            organizationPartyId: row.organizationPartyId,
            organizationName: organizations[row.organizationPartyId] || row.organizationPartyId,
            leaveTypeEnumId: row.leaveTypeEnumId,
            leaveTypeText: texts[row.leaveTypeEnumId] || row.leaveTypeEnumId,
            fromDay,
            thruDay,
            datesText: datesTextOf(fromDay, thruDay),
            partText: parts.length === 1 && parts[0] !== "LdpFull" ? partTexts[parts[0]] : "",
            chargedAmount: amount,
            chargedText: amountText(amount, texts[row.unitEnumId] || ""),
            statusEnumId: row.statusEnumId,
            statusText: requestStatusTexts[row.statusEnumId] || row.statusEnumId,
            toDecide: !!waiting && waiting.has(row.leaveRequestId),
            own: row.partyId === userScope.partyId,
            requestedDateText: dateText(row.requestedDate)
        }
    })
    return lib.pageList(requests, p, "requests")
}

// ===== absences (the team calendar and its projected collection) =====
// An employee's colleagues (the user's call of Nov 11, 2026): the people who now share a department or team with them (a current
// PrtMember of the same unit, as member or lead) or a manager (a live line of the same manager at the employer), each with the
// employers that employ both now, where their approved leave is shown as days alone: {partyId: [organizationPartyId]}.
const unitRoleIds = ["OrgDepartment", "OrgTeam"]
function colleaguesOf(userScope) {
    const me = userScope.partyId
    const mine = unique((userScope.employments || []).map(row => row.organizationPartyId))
    const out = {}
    if (!me || !mine.length) return out
    const add = (partyId, organizationPartyIds) => {
        if (partyId === me) return
        const shared = organizationPartyIds.filter(organizationPartyId => mine.includes(organizationPartyId))
        if (shared.length) out[partyId] = unique((out[partyId] || []).concat(shared))
    }
    const member = () => people.current(find(RELATIONSHIP).condition("relationshipTypeEnumId", "PrtMember"), null)
    // the units: a department's members are its employees' assignments' rows, a team's its members'
    const unitIds = unique(Array.from(member().condition("fromPartyId", me).list()).map(row => row.toPartyId))
    const units = unitIds.length
        ? unique(
              Array.from(
                  find("mantle.party.PartyRole")
                      .condition("partyId", "in", unitIds)
                      .condition("roleTypeId", "in", unitRoleIds)
                      .list()
              ).map(row => row.partyId)
          )
        : []
    if (units.length) {
        const mates = unique(Array.from(member().condition("toPartyId", "in", units).list()).map(row => row.fromPartyId)).filter(
            partyId => partyId !== me
        )
        const employed = people.employersOfParties(mates, null)
        for (const partyId of mates) add(partyId, employed[partyId] || [])
    }
    // the manager: the other reports of my managers, at the employers where the line is mine too
    const managers = people.managersByEmployment([me], null)
    const myLines = {}
    for (const [key, managerPartyIds] of Object.entries(managers))
        for (const managerPartyId of managerPartyIds)
            (myLines[managerPartyId] || (myLines[managerPartyId] = [])).push(key.split("/")[0])
    const managerIds = Object.keys(myLines)
    if (managerIds.length)
        for (const line of people.linesOf({managerPartyIds: managerIds}, null))
            add(
                line.partyId,
                line.organizationPartyIds.filter(organizationPartyId =>
                    myLines[line.managerPartyId].includes(organizationPartyId)
                )
            )
    return out
}
// The approved leave of the people the caller sees, from start through end (days): their own, a manager's live reports at the
// line's employers, an HR reader's employers' employees, and an employee's colleagues (colleaguesOf); each segment as "Out" with
// its days (a morning or an afternoon said so), the person, never the leave type or the reason; openable: whether the caller reads
// the request (the person, HR or the manager; never a colleague), which the calendar then links.
function absences(userScope, startDay, endDay) {
    const caps = userScope.capabilities
    const factory = ec.entity.conditionFactory
    const reach = []
    if (caps.self && userScope.partyId) reach.push(factory.makeCondition("partyId", "equals", userScope.partyId))
    const lineReach = Object.entries(userScope.reportLines || {})
    if (caps.self) lineReach.push(...Object.entries(colleaguesOf(userScope)))
    for (const [partyId, organizationPartyIds] of lineReach)
        if (organizationPartyIds.length)
            reach.push(
                factory.makeCondition(
                    factory.makeCondition("partyId", "equals", partyId),
                    "and",
                    factory.makeCondition("organizationPartyId", "in", organizationPartyIds)
                )
            )
    const employers = hrEmployers(userScope)
    if (employers.length) reach.push(factory.makeCondition("organizationPartyId", "in", employers))
    if (!reach.length) return []
    const found = Array.from(
        find(REQUEST)
            .condition(reach.length === 1 ? reach[0] : factory.makeCondition(reach, "or"))
            .condition("statusEnumId", "in", ["LrsApproved", "LrsCancelRequested"])
            .condition("fromDay", "less-equals", endDay)
            .condition("thruDay", "greater-equals", startDay)
            .limit(requestCap * 4)
            .list()
    )
    const persons = people.personNames(unique(found.map(row => row.partyId)))
    const out = []
    for (const row of found)
        for (const segment of segmentsOf(row.leaveRequestId)) {
            if (segment.thruDay < startDay || segment.fromDay > endDay) continue
            const personName = persons[row.partyId] || row.partyId
            const part = segment.dayPartEnumId === "LdpFull" ? "" : " (" + partTexts[segment.dayPartEnumId].toLowerCase() + ")"
            out.push({
                key: "absence|" + row.leaveRequestId + "|" + segment.segmentSeqId,
                leaveRequestId: row.leaveRequestId,
                partyId: row.partyId,
                personName,
                title: personName + " · Out" + part,
                fromDay: segment.fromDay,
                thruDay: segment.thruDay,
                dayPartEnumId: segment.dayPartEnumId,
                allDay: segment.dayPartEnumId === "LdpFull",
                openable:
                    row.partyId === userScope.partyId ||
                    employers.includes(row.organizationPartyId) ||
                    ((userScope.reportLines || {})[row.partyId] || []).includes(row.organizationPartyId),
                lastUpdatedMs: stampOf(row)
            })
        }
    return out.sort((a, b) => a.fromDay.localeCompare(b.fromDay) || a.personName.localeCompare(b.personName))
}
// get#TeamAbsences: the team calendar's items from start to end (yyyy-MM-dd), as Commons' Calendar.qvue takes them (kind absence,
// read only: whole days all day, a half day from 08:00 or 13:00 for four hours).
function getTeamAbsences(p) {
    const userScope = people.scopeOf()
    const caps = userScope.capabilities
    if (!caps.self && !caps.team && !caps.hrView)
        denied("PERMISSION_DENIED", "The team calendar needs PEOPLE_SELF_SERVICE, PEOPLE_TEAM_VIEW or PEOPLE_HR_VIEW")
    const startDay = dayParam(p.start) || dayOf(nowMs())
    const endDay = dayParam(p.end) || addDays(startDay, 31)
    if (endDay < startDay) denied("DATES_INVALID", "The end is on or after the start")
    const eventList = absences(userScope, startDay, endDay).map(item => ({
        kind: "absence",
        key: item.key,
        leaveRequestId: item.leaveRequestId,
        openable: item.openable,
        partyId: item.partyId,
        title: item.title,
        start: item.allDay ? item.fromDay : item.fromDay + (item.dayPartEnumId === "LdpMorning" ? " 08:00" : " 13:00"),
        end: item.allDay ? addDays(item.thruDay, 1) : item.fromDay + (item.dayPartEnumId === "LdpMorning" ? " 12:00" : " 17:00"),
        allDay: item.allDay,
        canEdit: false
    }))
    return {eventList, startDay, endDay}
}
// get#AbsenceProjection: Team absence's projected CalDAV collection (mantle.work.CalendarDavServices, CX-SYNC): whether the caller
// is admitted (a People user who sees absences: self-service, a manager or an HR reader), and with checkOnly false the events of
// the range (start, end in epoch millis; 90 days back to a year ahead when none) as the ICalendar tool writes them.
function getAbsenceProjection(p) {
    const userScope = people.scopeOf()
    const caps = userScope.capabilities
    const admitted = !!(caps.self || caps.team || caps.hrView)
    if (!admitted || truthy(p.checkOnly)) return {admitted, eventList: []}
    const startDay = p.start != null && p.start !== "" ? dayOf(Number(p.start)) : addDays(dayOf(nowMs()), -90)
    const endDay = p.end != null && p.end !== "" ? dayOf(Number(p.end)) : addDays(dayOf(nowMs()), 366)
    const eventList = absences(userScope, startDay, endDay).map(item => {
        const halfStart = item.dayPartEnumId === "LdpMorning" ? 8 : 13
        const startMs = startOfDay(item.fromDay) + halfStart * 60 * 60 * 1000
        return {
            uid: "people-absence-" + item.leaveRequestId + "-" + item.key.split("|").pop(),
            sequence: 0,
            summary: item.title,
            status: "CONFIRMED",
            allDay: item.allDay,
            start: item.allDay ? null : startMs,
            end: item.allDay ? null : startMs + 4 * 60 * 60 * 1000,
            startDate: item.allDay ? item.fromDay : null,
            endDate: item.allDay ? addDays(item.thruDay, 1) : null,
            timeZone: ec.user.timeZone || null,
            lastModified: item.lastUpdatedMs || null
        }
    })
    return {admitted, eventList}
}

const operations = {
    findPolicies,
    getPolicy,
    storePolicy,
    storeAccrualRule,
    assignPolicy,
    storeBlockedInterval,
    previewAllocation,
    allocateLeave,
    getBalances: getStaffBalances,
    getMyBalances,
    findLedger,
    accrueAssignment,
    runAccrual,
    runAccrualJob,
    // P12
    previewRequest,
    submitRequest,
    getRequest,
    decideRequest,
    approveNotice,
    refuseNotice,
    findRequests,
    getTeamAbsences,
    getAbsenceProjection
}
function run(op, p) {
    if (!Object.hasOwn(operations, op)) throw new Error("Unknown leave operation " + op)
    return operations[op](p || {})
}
// colleaguesOf: for the team calendar's shifts (Shifts.js, P14), which reach the same people as its absences
;({execute: run, colleaguesOf})
