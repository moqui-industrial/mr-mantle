// Case assignment (design-customer-service §9 AgentTeams, AssignmentRules; impl-customer-service P5, CS-ASSIGNMENT, F3, F71;
// SupportAssignmentEntities.xml). A service queue's assignment rules are effective-dated rows of its organization, in order
// (sequenceNum); the first whose typed conditions all hold for the case wins, and its distribution picks an agent: manual
// leaves the case for an agent to take, round robin takes the next eligible member after the rule's cursor, least open the
// eligible member with the fewest open cases. An agent is eligible when a current member of the rule's team (the queue's by
// default; optionally only some members), not marked ineligible by their participation row, under the most open cases (their
// participation's, else the rule's), and, when the rule respects schedules, in their working hours now (P4's business time on
// their participation's calendar, else their own schedule calendar, else the team's; none works around the clock). An agent
// out of their hours gives their round robin turn to their substitute when the substitute is eligible. No eligible agent: the
// rule's fallback, else the queue's fallback assignee, else the case stays unassigned and the queue team's managers are told
// (SupportCaseUnassigned). The rule's cursor (ServiceAssignmentCursor) is locked for the assignment, so two intakes at once
// take two slots. assign#Case runs from ensure#CaseProfile (a new case) and update#Case (a move to another queue); preview
// runs the same evaluator without writing. Reassignment never touches the case's clocks. A queue with no rule keeps P2's
// behaviour. A team's user group (SVT_<team>, the audience of its saved replies) follows its members, and its organization's
// (SVO_<organization>, the audience of its service-wide replies) the members of all its teams and its service managers and
// administrators (F131).
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const time = ec.resource.script("component://mr-mantle/service/mantle/work/BusinessTime.js")
const {find, one, rows, call, denied, access, ms} = lib

const RULE = "mantle.request.support.ServiceAssignmentRule",
    CONDITION = "mantle.request.support.ServiceAssignmentCondition",
    CURSOR = "mantle.request.support.ServiceAssignmentCursor",
    PARTICIPATION = "mantle.request.support.ServiceTeamParticipation",
    PROFILE = "mantle.request.support.CaseProfile",
    REQUEST = "mantle.request.Request",
    RELATIONSHIP = "mantle.party.PartyRelationship"
const distributions = ["AdManual", "AdRoundRobin", "AdLeastOpen"]
// the operators each condition field takes
const operatorsOf = {
    AcfType: ["AcoIs", "AcoIsNot"],
    AcfBand: ["AcoIs", "AcoIsNot"],
    AcfPriority: ["AcoIs", "AcoIsNot", "AcoAtMost", "AcoAtLeast"],
    AcfChannel: ["AcoIs", "AcoIsNot"],
    AcfTag: ["AcoHas", "AcoHasNot"],
    AcfCustomer: ["AcoIs", "AcoIsNot"]
}
const enumTypeOf = {AcfType: "RequestType", AcfBand: "CasePriorityBand", AcfChannel: "SalesChannel", AcfTag: "RequestTag"}

// SupportCases.js, read once for this evaluation of the module (a script is evaluated afresh on each load)
let casesModule = null
const cases = () =>
    casesModule || (casesModule = ec.resource.script("component://mr-mantle/service/mantle/request/SupportCases.js"))
const blank = value => value == null || String(value).trim() === ""
const text = value => (blank(value) ? null : String(value).trim())
const yn = (value, fallback = "N") => (value === true || value === "Y" || value === "true" ? "Y" : blank(value) ? fallback : "N")
const now = () => ec.user.nowTimestamp
const listOf = value =>
    value == null
        ? []
        : (typeof value === "string" ? value.split(",") : Array.from(value))
              .map(String)
              .map(s => s.trim())
              .filter(Boolean)
const enumText = enumId => (enumId ? one("moqui.basic.Enumeration", {enumId})?.description || enumId : "")
const partyName = partyId => (partyId ? lib.partyNames([partyId])[partyId] || partyId : "")
const openStatuses = ["ReqSubmitted", "ReqReviewed", "ReqInProgress", "ReqWaitingCustomer", "ReqOnHold"]

// ===== a team's user group (F3): its saved replies' audience, in step with its members =====
// A team's group (SVT_<team>) holds the users of its members; its organization's group (SVO_<organization>) the users of the
// members of all its teams: the audience of a service-wide reply of that organization, so a reply never reaches another
// organization's users (a group spanning organizations would show it to them in Comms).
const teamGroupId = teamPartyId => "SVT_" + teamPartyId
const organizationGroupId = organizationPartyId => "SVO_" + organizationPartyId
// The group, made on first use or renamed, and its members: a current UserGroupMember for each user of the parties, ended for
// a user who is no longer one. Idempotent.
function syncGroup(userGroupId, description, groupTypeEnumId, memberPartyIds) {
    const group = one("moqui.security.UserGroup", {userGroupId})
    if (!group) call("create#moqui.security.UserGroup", {userGroupId, description, groupTypeEnumId})
    else if (group.description !== description) {
        group.set("description", description)
        group.update()
    }
    const wanted = new Set(
        memberPartyIds.length
            ? Array.from(find("moqui.security.UserAccount").condition("partyId", "in", memberPartyIds).list()).map(
                  row => row.userId
              )
            : []
    )
    const live = Array.from(
        find("moqui.security.UserGroupMember", {userGroupId}).conditionDate("fromDate", "thruDate", now()).list()
    )
    for (const row of live)
        if (!wanted.has(row.userId)) {
            row.set("thruDate", now())
            row.update()
        }
    const has = new Set(live.map(row => row.userId))
    for (const userId of wanted)
        if (!has.has(userId)) call("create#moqui.security.UserGroupMember", {userGroupId, userId, fromDate: now()})
    return Array.from(wanted)
}
const membersOf = teamPartyId =>
    cases()
        .currentRows(RELATIONSHIP, {toPartyId: teamPartyId, relationshipTypeEnumId: "PrtServiceTeam"})
        .map(row => row.fromPartyId)
// The parties of the users who hold a service-wide permission (SUPPORT_CASE_MANAGE, SUPPORT_POLICY_EDIT: a service manager or
// administrator, on no team perhaps) through a current group, and who work for the organization (F131): they share the
// organization's service-wide replies.
const MANAGING = ["SUPPORT_CASE_MANAGE", "SUPPORT_POLICY_EDIT"]
function managersOf(organizationPartyId) {
    const groupIds = new Set(
        Array.from(
            find("moqui.security.UserGroupPermission")
                .condition("userPermissionId", "in", MANAGING)
                .conditionDate("fromDate", "thruDate", now())
                .list()
        ).map(row => row.userGroupId)
    )
    if (!groupIds.size) return []
    const userIds = new Set(
        Array.from(
            find("moqui.security.UserGroupMember")
                .condition("userGroupId", "in", Array.from(groupIds))
                .conditionDate("fromDate", "thruDate", now())
                .list()
        ).map(row => row.userId)
    )
    if (!userIds.size) return []
    const partyIds = new Set(
        Array.from(find("moqui.security.UserAccount").condition("userId", "in", Array.from(userIds)).list())
            .filter(row => row.partyId && row.disabled !== "Y")
            .map(row => row.partyId)
    )
    return Array.from(partyIds).filter(partyId => cases().organizationsOf(partyId).includes(organizationPartyId))
}
// The team's group and its organization's.
function syncTeamGroup(teamPartyId) {
    if (!teamPartyId) return {userGroupId: null}
    const userGroupId = teamGroupId(teamPartyId)
    const nameOf = partyId => one("mantle.party.Organization", {partyId})?.organizationName || partyId
    const userIds = syncGroup(userGroupId, "Service team " + nameOf(teamPartyId), "UgtServiceTeam", membersOf(teamPartyId))
    const organizationPartyId = one("mantle.party.Party", {partyId: teamPartyId})?.ownerPartyId
    if (organizationPartyId && organizationPartyId !== "_NA_") {
        const teamIds = rows("mantle.party.Party", {ownerPartyId: organizationPartyId})
            .map(row => row.partyId)
            .filter(partyId => one("mantle.party.PartyRole", {partyId, roleTypeId: "OrgTeam"}))
        syncGroup(
            organizationGroupId(organizationPartyId),
            "Service agents of " + nameOf(organizationPartyId),
            "UgtServiceOrganization",
            Array.from(new Set(teamIds.flatMap(membersOf).concat(managersOf(organizationPartyId))))
        )
    }
    return {userGroupId, userIds}
}

// ===== participation =====
const participationOf = (teamPartyId, partyId, date) => cases().currentRow(PARTICIPATION, {teamPartyId, partyId}, date) || null
// The schedule an agent's hours are read on: their participation's calendar, their own schedule calendar, else the team's.
function agentSchedule(teamPartyId, partyId, participation) {
    const calendarId =
        participation?.calendarId || time.scheduleCalendarId(partyId) || time.scheduleCalendarId(teamPartyId) || null
    return calendarId ? time.scheduleOf({calendarId}) : null
}
// Whether a schedule has working time at the instant. Hours not set (no working-hours series in effect or to come, as
// get#WorkingHours reads them): around the clock. Set: the instant is in an occurrence, less holidays (an off week of a
// two-weekly series, or hours that start later, are out of hours).
function inHours(ctx, schedule, atMs) {
    if (!schedule?.calendarId) return true
    ctx.hoursSet = ctx.hoursSet || new Map()
    if (!ctx.hoursSet.has(schedule.calendarId))
        ctx.hoursSet.set(schedule.calendarId, time.workingHours({calendarId: schedule.calendarId}).configured)
    if (!ctx.hoursSet.get(schedule.calendarId)) return true
    const span = time.calendarOf(ctx, schedule, atMs, atMs + time.minuteMs)
    return span.configured && time.intersect(span.work, [[atMs, atMs + time.minuteMs]]).length > 0
}
const openCaseCount = partyId =>
    find("mantle.request.support.CaseRequestParty", {partyId, roleTypeId: "Assignee"})
        .condition("thruDate", null)
        .condition("statusId", "in", openStatuses)
        .count()

// ===== the rules =====
const rulesOf = (organizationPartyId, requestCategoryId, date = now()) =>
    cases()
        .currentRows(RULE, {organizationPartyId, requestCategoryId}, date)
        .sort((a, b) => (a.sequenceNum ?? 99) - (b.sequenceNum ?? 99) || Number(ms(a.fromDate)) - Number(ms(b.fromDate)))
const conditionsOf = assignmentRuleId =>
    rows(CONDITION, {assignmentRuleId}).sort((a, b) => String(a.conditionSeqId).localeCompare(String(b.conditionSeqId)))
// The band of a priority (CasePriorityBand: enumCode its first priority, optionValue its last).
function bandOf(priority) {
    if (priority == null || priority === "") return null
    const value = Number(priority)
    return (
        rows("moqui.basic.Enumeration", {enumTypeId: "CasePriorityBand"}).find(
            row => value >= Number(row.enumCode) && value <= Number(row.optionValue)
        )?.enumId || null
    )
}
// The facts of a case the conditions read.
function factsOf(requestId) {
    const request = one(REQUEST, {requestId})
    const parties = cases().currentRows("mantle.request.RequestParty", {requestId})
    return {
        requestId,
        organizationPartyId: parties.find(row => row.roleTypeId === "OrgInternal")?.partyId || null,
        requestCategoryId: request?.requestCategoryId || null,
        requestTypeEnumId: request?.requestTypeEnumId || null,
        priority: request?.priority ?? null,
        salesChannelEnumId: request?.salesChannelEnumId || null,
        customerPartyId: parties.find(row => row.roleTypeId === "Customer")?.partyId || null,
        assigneePartyId: parties.find(row => row.roleTypeId === "Assignee")?.partyId || null,
        tagEnumIds: cases()
            .currentRows("mantle.request.RequestTag", {requestId})
            .map(row => row.tagEnumId)
    }
}
// Whether one condition holds for the facts, with its text.
function holds(condition, facts) {
    const value = condition.conditionValue
    const is = condition.operatorEnumId
    let actual
    switch (condition.fieldEnumId) {
        case "AcfType":
            actual = facts.requestTypeEnumId
            break
        case "AcfBand":
            actual = bandOf(facts.priority)
            break
        case "AcfChannel":
            actual = facts.salesChannelEnumId
            break
        case "AcfCustomer":
            actual = facts.customerPartyId
            break
        case "AcfPriority": {
            const priority = facts.priority == null ? null : Number(facts.priority)
            if (priority == null) return false
            if (is === "AcoAtMost") return priority <= Number(value)
            if (is === "AcoAtLeast") return priority >= Number(value)
            return is === "AcoIs" ? priority === Number(value) : priority !== Number(value)
        }
        case "AcfTag": {
            const has = (facts.tagEnumIds || []).includes(value)
            return is === "AcoHas" ? has : !has
        }
        default:
            return false
    }
    return is === "AcoIs" ? actual === value : actual !== value
}
function conditionText(condition) {
    const value =
        condition.fieldEnumId === "AcfCustomer"
            ? partyName(condition.conditionValue)
            : enumTypeOf[condition.fieldEnumId]
              ? enumText(condition.conditionValue)
              : condition.conditionValue
    return enumText(condition.fieldEnumId) + " " + enumText(condition.operatorEnumId) + " " + (value || "")
}

// ===== the evaluator =====
// The agents a rule may give the case to, each with whether it is eligible now and why not.
function candidatesOf(rule, queue, ctx) {
    const teamPartyId = rule.eligibleTeamPartyId || queue?.responsibleTeamPartyId || null
    if (!teamPartyId) return {teamPartyId: null, candidates: []}
    const only = listOf(rule.eligiblePartyIds)
    const atMs = Number(ms(now()))
    // the team's agents (its managers only when the rule names them)
    const members = cases()
        .teamMembers(teamPartyId)
        .filter(row => row.fromRoleTypeId !== "Manager" || only.includes(row.fromPartyId))
        .map(row => row.fromPartyId)
        .filter((partyId, index, all) => all.indexOf(partyId) === index)
        .filter(partyId => !only.length || only.includes(partyId))
        .sort()
    const candidates = members.map(partyId => {
        const participation = participationOf(teamPartyId, partyId)
        const party = one("mantle.party.Party", {partyId})
        const open = openCaseCount(partyId)
        const max = participation?.maxActiveCases ?? rule.maxOpenCases ?? null
        let reason = null
        if (!party || party.disabled === "Y") reason = "MEMBER_UNAVAILABLE"
        else if (participation?.assignmentEligible === "N") reason = "NOT_ELIGIBLE"
        else if (max != null && open >= Number(max)) reason = "AT_MAX_LOAD"
        else if (rule.respectSchedule !== "N" && !inHours(ctx, agentSchedule(teamPartyId, partyId, participation), atMs))
            reason = "OUTSIDE_HOURS"
        return {
            partyId,
            name: partyName(partyId),
            openCaseCount: open,
            maxActiveCases: max,
            substitutePartyId: participation?.substitutePartyId || null,
            eligible: !reason,
            reason
        }
    })
    return {teamPartyId, candidates}
}
// The agent a rule's distribution picks among its candidates (round robin after the cursor's last agent, an out-of-hours
// agent's turn to an eligible substitute; least open the fewest open cases, then after the cursor), or null.
function pick(rule, candidates, cursor) {
    const eligible = candidates.filter(row => row.eligible)
    if (rule.distributionEnumId === "AdLeastOpen") {
        if (!eligible.length) return null
        const fewest = Math.min(...eligible.map(row => row.openCaseCount))
        const tied = eligible.filter(row => row.openCaseCount === fewest)
        return rotateAfter(tied, cursor?.lastPartyId)[0]
    }
    // round robin over every candidate in order, so an agent who is out keeps their place in the turn
    for (const row of rotateAfter(candidates, cursor?.lastPartyId)) {
        if (row.eligible) return row
        if (row.reason === "OUTSIDE_HOURS" && row.substitutePartyId) {
            const substitute = eligible.find(other => other.partyId === row.substitutePartyId)
            if (substitute) return Object.assign({}, substitute, {turnOf: row.partyId})
        }
    }
    return null
}
// The rows after the one with the given party (cyclic), that one last; all of them when it is not among them.
function rotateAfter(list, partyId) {
    const index = partyId ? list.findIndex(row => row.partyId === partyId) : -1
    return index < 0 ? list.slice() : list.slice(index + 1).concat(list.slice(0, index + 1))
}
// A fallback assignee that the case may have: a person of the queue's team, else one who works for the organization.
function fallbackOk(partyId, queue, organizationPartyId) {
    if (!partyId) return false
    const checked = lib.check(() => cases().checkAssignee(partyId, queue, organizationPartyId))
    return checked.allowed
}
// Evaluate the queue's rules for the facts: {rule, outcome (AoAssigned, AoFallback, AoManual, AoNoAgent; null when the queue
// has no rule), assigneePartyId, reason, teamPartyId, evaluated: each rule with its conditions and whether they held,
// candidates}. With a rule given (a draft to try), that rule alone.
function evaluate(facts, options = {}) {
    const queue = cases().queueOf(facts.requestCategoryId)?.queue || null
    const rules = options.rule
        ? [options.rule]
        : facts.organizationPartyId && facts.requestCategoryId
          ? rulesOf(facts.organizationPartyId, facts.requestCategoryId)
          : []
    const evaluated = rules.map(rule => {
        const conditions = (options.conditions && options.rule ? options.conditions : conditionsOf(rule.assignmentRuleId)).map(
            row => ({
                fieldEnumId: row.fieldEnumId,
                operatorEnumId: row.operatorEnumId,
                conditionValue: row.conditionValue,
                text: conditionText(row),
                holds: holds(row, facts)
            })
        )
        return {
            assignmentRuleId: rule.assignmentRuleId,
            ruleName: rule.ruleName || rule.assignmentRuleId,
            conditions,
            matches: conditions.every(row => row.holds)
        }
    })
    const result = {rule: null, outcome: null, assigneePartyId: null, reason: "", teamPartyId: null, evaluated, candidates: []}
    if (!rules.length) {
        result.reason = "The queue has no assignment rule"
        return result
    }
    const winner = rules.find((rule, index) => evaluated[index].matches) || null
    const queueFallback = queue?.fallbackAssigneePartyId || null
    if (!winner) {
        if (fallbackOk(queueFallback, queue, facts.organizationPartyId))
            return Object.assign(result, {
                outcome: "AoFallback",
                assigneePartyId: queueFallback,
                reason: "No rule matched; the queue's fallback " + partyName(queueFallback)
            })
        return Object.assign(result, {outcome: "AoNoAgent", reason: "No rule matched and the queue has no fallback"})
    }
    result.rule = winner
    if (winner.distributionEnumId === "AdManual")
        return Object.assign(result, {
            outcome: "AoManual",
            reason: (winner.ruleName || winner.assignmentRuleId) + ": left for an agent to take"
        })
    const ctx = time.forCall()
    const found = candidatesOf(winner, queue, ctx)
    result.teamPartyId = found.teamPartyId
    result.candidates = found.candidates.map(row =>
        Object.assign({}, row, {reasonText: row.reason ? reasonTexts[row.reason] || row.reason : "Eligible"})
    )
    const chosen = pick(winner, found.candidates, options.cursor || cursorOf(winner))
    if (chosen)
        return Object.assign(result, {
            outcome: "AoAssigned",
            assigneePartyId: chosen.partyId,
            turnOf: chosen.turnOf || null,
            reason:
                (winner.ruleName || winner.assignmentRuleId) +
                ": " +
                enumText(winner.distributionEnumId) +
                " to " +
                chosen.name +
                (chosen.turnOf ? " for " + partyName(chosen.turnOf) : "")
        })
    for (const fallback of [winner.fallbackPartyId, queueFallback])
        if (fallbackOk(fallback, queue, facts.organizationPartyId))
            return Object.assign(result, {
                outcome: "AoFallback",
                assigneePartyId: fallback,
                reason: (winner.ruleName || winner.assignmentRuleId) + ": no eligible agent; the fallback " + partyName(fallback)
            })
    return Object.assign(result, {
        outcome: "AoNoAgent",
        reason: (winner.ruleName || winner.assignmentRuleId) + ": no eligible agent"
    })
}
const reasonTexts = {
    MEMBER_UNAVAILABLE: "Not available",
    NOT_ELIGIBLE: "Not taking cases",
    AT_MAX_LOAD: "At their most open cases",
    OUTSIDE_HOURS: "Outside their working hours"
}
const rootOf = rule => rule.rootRuleId || rule.assignmentRuleId
const cursorOf = (rule, lock = false) => {
    const query = find(CURSOR, {rootRuleId: rootOf(rule)})
    return (lock ? query.forUpdate(true) : query).one()
}
// The rule's cursor, locked for the assignment (made when missing: a rule loaded as data).
function lockedCursor(rule) {
    let cursor = cursorOf(rule, true)
    if (!cursor) {
        call("create#" + CURSOR, {rootRuleId: rootOf(rule), assignedCount: 0})
        cursor = cursorOf(rule, true)
    }
    return cursor
}

// ===== assign#Case =====
// Run the rules on a case: a new one (intake) or one moved into another queue (reassign). An assigned case stays so at
// intake; a move gives it the rule's agent, or leaves it unassigned when none is eligible. Records the rule, outcome and
// reason on its profile and the result on the rule's cursor; tells the agent (SupportCaseAssigned) or the queue team's
// managers (SupportCaseUnassigned). No permission (a rule, as ensure#CaseProfile): update#Case checks its own.
function assignCase(p) {
    const profile = one(PROFILE, {requestId: p.requestId})
    if (!profile) return {outcome: null, reason: "NOT_A_CASE"}
    const facts = factsOf(p.requestId)
    if (!p.reassign && facts.assigneePartyId)
        return {outcome: null, assigneePartyId: facts.assigneePartyId, reason: "Already assigned"}
    const queueRules = rulesOf(facts.organizationPartyId, facts.requestCategoryId)
    if (!queueRules.length) return {outcome: null, assigneePartyId: facts.assigneePartyId, reason: "No rule"}
    // lock every cursor of the queue's rules, in the order of their ids (the same for every intake, whatever the rules'
    // order), so the evaluation reads the turn it will move
    const cursors = new Map()
    for (const rule of queueRules.slice().sort((a, b) => String(rootOf(a)).localeCompare(String(rootOf(b)))))
        cursors.set(rule.assignmentRuleId, lockedCursor(rule))
    const result = evaluate(facts)
    // the case as the rule sees it (no user scope: a rule run after an intake's commit has no user)
    const parties = cases().partiesOf(p.requestId)
    const theCase = {
        requestId: String(p.requestId),
        request: one(REQUEST, {requestId: p.requestId}),
        parties,
        customerPartyId: facts.customerPartyId,
        assigneePartyId: facts.assigneePartyId
    }
    if (result.assigneePartyId) {
        if (result.assigneePartyId !== facts.assigneePartyId) cases().assignParty(theCase, result.assigneePartyId)
    } else if (result.outcome === "AoNoAgent" && p.reassign && facts.assigneePartyId) cases().assignParty(theCase, null)
    if (result.outcome === "AoNoAgent") notifyUnassigned(theCase, facts, result)
    profile.set("assignmentRuleId", result.rule?.assignmentRuleId || null)
    profile.set("assignmentOutcomeEnumId", result.outcome)
    profile.set("assignmentReason", String(result.reason || "").substring(0, 255))
    profile.update()
    const cursor = result.rule ? cursors.get(result.rule.assignmentRuleId) : null
    if (cursor) {
        if (result.outcome === "AoAssigned" && result.rule.distributionEnumId === "AdRoundRobin")
            cursor.set("lastPartyId", result.turnOf || result.assigneePartyId)
        else if (result.outcome === "AoAssigned") cursor.set("lastPartyId", result.assigneePartyId)
        cursor.set("lastRequestId", p.requestId)
        cursor.set("lastOutcomeEnumId", result.outcome)
        cursor.set("lastResultText", String(result.reason || "").substring(0, 255))
        cursor.set("lastAssignedDate", now())
        cursor.set("assignedCount", Number(cursor.assignedCount || 0) + (result.assigneePartyId ? 1 : 0))
        cursor.update()
    }
    return {
        outcome: result.outcome,
        assigneePartyId: result.assigneePartyId,
        assignmentRuleId: result.rule?.assignmentRuleId || null,
        reason: result.reason
    }
}
// No eligible agent: the case stays unassigned and the managers of the queue's team (else the rule's team) are told.
function notifyUnassigned(theCase, facts, result) {
    try {
        const queue = cases().queueOf(facts.requestCategoryId)?.queue
        const teamPartyId = queue?.responsibleTeamPartyId || result.teamPartyId
        const managers = teamPartyId
            ? cases()
                  .teamMembers(teamPartyId)
                  .filter(row => row.fromRoleTypeId === "Manager")
                  .map(row => row.fromPartyId)
            : []
        const userIds = managers.length
            ? Array.from(find("moqui.security.UserAccount").condition("partyId", "in", managers).list()).map(row => row.userId)
            : []
        if (!userIds.length) return []
        const nm = ec
            .makeNotificationMessage()
            .topic("SupportCaseUnassigned")
            .userIds(userIds)
            .message({
                requestId: theCase.requestId,
                requestName: theCase.request.requestName || theCase.requestId,
                customerName: partyName(theCase.customerPartyId),
                queueName: one("mantle.request.RequestCategory", {requestCategoryId: facts.requestCategoryId})?.description || "",
                reason: result.reason,
                recordEntityName: REQUEST,
                recordId: theCase.requestId
            })
        if (typeof nm.record === "function") nm.record(REQUEST, theCase.requestId)
        nm.send()
        return userIds
    } catch (error) {
        ec.logger.error("Case " + theCase.requestId + ": the unassigned notice was not sent: " + error.message)
        return []
    }
}

// ===== preview#Assignment =====
// What the rules would do for a case (requestId) or for the facts given, without writing: each rule and whether its conditions
// hold, the winning rule's agents with why each is or is not eligible now, and the agent it would pick. With assignmentRuleId,
// that rule alone (a draft to try). Needs SUPPORT_POLICY_EDIT, SUPPORT_CASE_MANAGE or SUPPORT_CASE_EDIT and the organization.
function preview(p) {
    if (!["SUPPORT_POLICY_EDIT", "SUPPORT_CASE_MANAGE", "SUPPORT_CASE_EDIT"].some(permission => access.has(permission)))
        denied("PERMISSION_DENIED", "SUPPORT_POLICY_EDIT, SUPPORT_CASE_MANAGE or SUPPORT_CASE_EDIT is required")
    let facts
    if (p.requestId) {
        const theCase = cases().caseOf(p.requestId)
        facts = factsOf(theCase.requestId)
    } else {
        const organizationPartyId = cases().requireOrganization(p.organizationPartyId)
        facts = {
            organizationPartyId,
            requestCategoryId: p.requestCategoryId || null,
            requestTypeEnumId: p.requestTypeEnumId || "RqtSupport",
            priority: blank(p.priority) ? 5 : Number(p.priority),
            salesChannelEnumId: p.salesChannelEnumId || null,
            customerPartyId: p.customerPartyId || null,
            tagEnumIds: listOf(p.tagEnumIds)
        }
    }
    let rule = null
    if (p.assignmentRuleId) {
        rule = one(RULE, {assignmentRuleId: p.assignmentRuleId})
        if (!rule || rule.organizationPartyId !== facts.organizationPartyId)
            denied("RECORD_UNAVAILABLE", "Rule " + p.assignmentRuleId + " is not available")
        if (!facts.requestCategoryId) facts.requestCategoryId = rule.requestCategoryId
    }
    const result = evaluate(facts, rule ? {rule} : {})
    return {
        outcome: result.outcome,
        outcomeText: result.outcome ? enumText(result.outcome) : "No assignment rule",
        assigneePartyId: result.assigneePartyId,
        assigneeName: partyName(result.assigneePartyId),
        assignmentRuleId: result.rule?.assignmentRuleId || null,
        ruleName: result.rule?.ruleName || "",
        reason: result.reason,
        rules: result.evaluated,
        candidates: result.candidates
    }
}

// ===== save#AssignmentRule =====
// Check a condition: an allowlisted field, an operator it takes, and a value of its type.
function checkCondition(condition, organizationPartyId) {
    const fieldEnumId = text(condition.fieldEnumId)
    const operatorEnumId = text(condition.operatorEnumId)
    const value = text(condition.conditionValue)
    if (!operatorsOf[fieldEnumId]) denied("CONDITION_FIELD_UNKNOWN", (fieldEnumId || "") + " is not a field a rule reads")
    if (!operatorsOf[fieldEnumId].includes(operatorEnumId))
        denied("CONDITION_OPERATOR_INVALID", enumText(fieldEnumId) + " does not take " + (enumText(operatorEnumId) || "it"))
    const invalid = () => denied("CONDITION_VALUE_INVALID", (value || "No value") + " is not a " + enumText(fieldEnumId))
    if (!value) invalid()
    if (enumTypeOf[fieldEnumId]) {
        if (one("moqui.basic.Enumeration", {enumId: value})?.enumTypeId !== enumTypeOf[fieldEnumId]) invalid()
    } else if (fieldEnumId === "AcfPriority") {
        if (!/^[1-9]$/.test(value)) invalid()
    } else if (fieldEnumId === "AcfCustomer") {
        if (!cases().servedCustomer(value, organizationPartyId)) invalid()
    }
    return {fieldEnumId, operatorEnumId, conditionValue: value}
}
// The rule's conditions after this save: the list given, else the row's with one row added, changed or removed.
function conditionsAfter(p, existing, organizationPartyId) {
    if (p.conditions != null) return Array.from(p.conditions).map(row => checkCondition(row, organizationPartyId))
    const list = existing ? conditionsOf(existing.assignmentRuleId).map(row => lib.map(row)) : []
    const action = text(p.conditionAction)
    if (!action) return list.map(row => checkCondition(row, organizationPartyId))
    const index = list.findIndex(row => row.conditionSeqId === p.conditionSeqId)
    if (action === "remove") {
        if (index < 0) denied("CONDITION_UNKNOWN", "The rule has no condition " + (p.conditionSeqId || ""))
        list.splice(index, 1)
    } else if (action === "update") {
        if (index < 0) denied("CONDITION_UNKNOWN", "The rule has no condition " + (p.conditionSeqId || ""))
        list[index] = Object.assign({}, list[index], checkCondition(p, organizationPartyId))
    } else if (action === "add") list.push(checkCondition(p, organizationPartyId))
    else denied("CONDITION_ACTION_UNKNOWN", action + " is not add, update or remove")
    return list.map(row => checkCondition(row, organizationPartyId))
}
function endRule(rule, at) {
    rule.set("thruDate", at)
    rule.update()
}
// A rule of a service queue of the organization, from a date (a draft has none and changes in place; a published rule's
// change is a new row naming and ending it), or ended with end. Needs SUPPORT_POLICY_EDIT and the organization.
function saveRule(p) {
    if (!access.has("SUPPORT_POLICY_EDIT")) denied("PERMISSION_DENIED", "SUPPORT_POLICY_EDIT is required")
    const existing = p.assignmentRuleId ? one(RULE, {assignmentRuleId: p.assignmentRuleId}) : null
    if (p.assignmentRuleId && !existing) denied("RECORD_UNAVAILABLE", "Rule " + p.assignmentRuleId + " is not available")
    const organizationPartyId = cases().requireOrganization(existing?.organizationPartyId || p.organizationPartyId)
    if (existing && p.organizationPartyId && p.organizationPartyId !== existing.organizationPartyId)
        denied("RECORD_UNAVAILABLE", "A rule stays its organization's")
    const draft = p.draft === true || p.draft === "Y" || p.draft === "true"
    const fromDate = draft ? null : p.fromDate || now()
    if (p.end === true || p.end === "Y" || p.end === "true") {
        if (!existing?.fromDate) denied("RECORD_UNAVAILABLE", "Only a published rule is ended")
        endRule(existing, p.fromDate || now())
        return {assignmentRuleId: existing.assignmentRuleId}
    }
    const pickField = field => (p[field] !== undefined && p[field] !== null ? p[field] : existing ? existing[field] : null)
    const requestCategoryId = text(pickField("requestCategoryId"))
    const queue = cases().queueOf(requestCategoryId)
    if (!queue || queue.organizationPartyId !== organizationPartyId)
        denied("QUEUE_UNAVAILABLE", "Choose a service queue of " + partyName(organizationPartyId))
    const ruleName = text(pickField("ruleName"))
    if (!ruleName) denied("NAME_REQUIRED", "A rule needs a name")
    const distributionEnumId = text(pickField("distributionEnumId")) || "AdRoundRobin"
    if (!distributions.includes(distributionEnumId)) denied("DISTRIBUTION_UNKNOWN", distributionEnumId + " is not a distribution")
    const eligibleTeamPartyId = text(pickField("eligibleTeamPartyId"))
    if (eligibleTeamPartyId) cases().requireTeam(eligibleTeamPartyId, organizationPartyId)
    const teamPartyId = eligibleTeamPartyId || queue.queue.responsibleTeamPartyId || null
    if (distributionEnumId !== "AdManual" && !teamPartyId) denied("TEAM_REQUIRED", "The rule needs a team: the queue has none")
    const eligible = listOf(pickField("eligiblePartyIds"))
    for (const partyId of eligible)
        if (!teamPartyId || !cases().isTeamMember(partyId, teamPartyId))
            denied("MEMBER_UNAVAILABLE", partyName(partyId) + " is not a member of the rule's team")
    const maxRaw = pickField("maxOpenCases")
    const maxOpenCases = blank(maxRaw) ? null : Number(maxRaw)
    if (maxOpenCases != null && !(Number.isInteger(maxOpenCases) && maxOpenCases > 0))
        denied("MAX_LOAD_INVALID", "The most open cases is a whole number above zero")
    const fallbackPartyId = text(pickField("fallbackPartyId"))
    if (fallbackPartyId) cases().checkAssignee(fallbackPartyId, queue.queue, organizationPartyId)
    const sequenceRaw = pickField("sequenceNum")
    const conditions = conditionsAfter(p, existing, organizationPartyId)
    const fields = {
        requestCategoryId,
        ruleName: ruleName.substring(0, 255),
        sequenceNum: blank(sequenceRaw) ? 10 : Number(sequenceRaw),
        distributionEnumId,
        eligibleTeamPartyId,
        eligiblePartyIds: eligible.join(",") || null,
        respectSchedule: yn(pickField("respectSchedule"), "Y"),
        maxOpenCases,
        fallbackPartyId,
        changeReason: text(p.changeReason)
    }
    // a draft changes in place; a published row is replaced by a new one that names it
    const editDraft = existing && !existing.fromDate
    let assignmentRuleId
    if (editDraft) {
        assignmentRuleId = existing.assignmentRuleId
        call("update#" + RULE, Object.assign({assignmentRuleId, fromDate}, fields))
        for (const row of rows(CONDITION, {assignmentRuleId})) row.delete()
    } else {
        assignmentRuleId = call(
            "create#" + RULE,
            Object.assign(
                {organizationPartyId, previousRuleId: existing?.assignmentRuleId || null, fromDate, thruDate: null},
                fields
            )
        ).assignmentRuleId
        call("update#" + RULE, {assignmentRuleId, rootRuleId: existing ? rootOf(existing) : assignmentRuleId})
    }
    conditions.forEach((row, index) =>
        call("create#" + CONDITION, {
            assignmentRuleId,
            conditionSeqId: String(index + 1).padStart(2, "0"),
            fieldEnumId: row.fieldEnumId,
            operatorEnumId: row.operatorEnumId,
            conditionValue: row.conditionValue
        })
    )
    const replaces = editDraft ? existing.previousRuleId : existing?.assignmentRuleId
    if (!draft && replaces) {
        const replaced = one(RULE, {assignmentRuleId: replaces})
        if (replaced?.fromDate && (!replaced.thruDate || Number(ms(replaced.thruDate)) > Number(ms(fromDate))))
            endRule(replaced, fromDate)
    }
    const root = one(RULE, {assignmentRuleId})
    if (!one(CURSOR, {rootRuleId: rootOf(root)})) call("create#" + CURSOR, {rootRuleId: rootOf(root), assignedCount: 0})
    return {assignmentRuleId}
}

// ===== participation (save#ServiceTeamMember) =====
// A member's participation from a date (fromDate, else now), replacing the row in effect: eligible, the most open cases, the
// substitute (another current member of the team) and the calendar (the organization's, the team's or the member's own).
function saveParticipation(p, teamPartyId, organizationPartyId) {
    const current = participationOf(teamPartyId, p.partyId)
    const value = (field, fallback) => (p[field] !== undefined && p[field] !== null ? p[field] : (current?.[field] ?? fallback))
    const maxRaw = value("maxActiveCases", null)
    const maxActiveCases = blank(maxRaw) ? null : Number(maxRaw)
    if (maxActiveCases != null && !(Number.isInteger(maxActiveCases) && maxActiveCases >= 0))
        denied("MAX_LOAD_INVALID", "The most open cases is a whole number")
    const substitutePartyId = text(value("substitutePartyId", null))
    if (substitutePartyId && (substitutePartyId === p.partyId || !cases().isTeamMember(substitutePartyId, teamPartyId)))
        denied("SUBSTITUTE_UNAVAILABLE", partyName(substitutePartyId) + " is not another member of the team")
    const calendarId = text(value("calendarId", null))
    if (calendarId) {
        const calendar = one("mantle.work.calendar.Calendar", {calendarId})
        if (!calendar || ![organizationPartyId, teamPartyId, p.partyId].includes(calendar.ownerPartyId))
            denied("CALENDAR_UNAVAILABLE", "Calendar " + calendarId + " is not the organization's, the team's or the member's")
    }
    const participationId = cases().startRow(
        PARTICIPATION,
        "participationId",
        {teamPartyId, partyId: p.partyId},
        {
            assignmentEligible: yn(value("assignmentEligible", "Y"), "Y"),
            maxActiveCases,
            substitutePartyId,
            calendarId
        },
        {fromDate: p.participationFromDate || null}
    )
    return participationId
}
function endParticipation(teamPartyId, partyId, at) {
    for (const row of cases().currentRows(PARTICIPATION, {teamPartyId, partyId}, at)) {
        row.set("thruDate", at)
        row.update()
    }
}

const operations = {
    assign: assignCase,
    preview,
    save: saveRule,
    syncTeamGroup: p => syncTeamGroup(p.teamPartyId)
}
;({
    teamGroupId,
    organizationGroupId,
    syncTeamGroup,
    saveParticipation,
    endParticipation,
    participationOf,
    rulesOf,
    conditionsOf,
    conditionText,
    operatorsOf,
    enumTypeOf,
    reasonTexts,
    execute: (op, parameters) => {
        if (!operations[op]) throw new Error("Unknown case assignment operation " + op)
        const wasDisabled = ec.artifactExecution.disableAuthz()
        try {
            return operations[op](parameters || {})
        } finally {
            if (!wasDisabled) ec.artifactExecution.enableAuthz()
        }
    }
})
