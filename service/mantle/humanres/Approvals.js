// People's approval rules, routing and decisions (mantle.humanres.PeopleApprovalServices find#Policies, store#Policy,
// resolve#Approvers, record#Decision, find#OwnedApprovals and transfer#ApprovalOwner; the domain request and decision services
// call request, sourceChanged, summary and recordDecision here; IronStone People design §12 ApprovalPolicies, §13 Approvals,
// PE-15; impl-people P5).
//
// The records (PeopleApprovalEntities.xml):
// - a rule is a dated PeopleApprovalPolicy row of an employer and a kind of approval (PeopleApprovalKind): a step (sequenceNum)
//   decided by a role (department head, manager, named person, HR officer), with an alternate; a ParHrFallback row names the
//   employer's HR fallback for the kind, a person who decides any step no one else may;
// - a request (PeopleApproval) is bound to its source's revision; its decisions (PeopleApprovalDecision) are facts of their own.
//
// Routing (resolve): the rules in effect naming the request's employee (an override), else those of the nearest department at or
// above the source's department, else the employer's type rule; with none, one step by the employee's manager (the head of the
// department for a request about no one, a position). Each step's approvers are those of its role who may decide: an enabled
// account holding PEOPLE_REQUEST_APPROVE (HR-routed steps too: the user's call, impl-people §4), never the requester or the person the request is
// about, nor one who decided another step of it (every step is a different approver), nor one who no longer works for the
// employer (a leaver: P6's separation calls reroute). When none may, the step's alternate decides, else the HR fallback, else the
// step is unresolved and the request waits: nothing is approved by default.
//
// Deciding (recordDecision): the caller must be one of the current step's approvers, at the revision the request was made for
// (a source changed since is SOURCE_CHANGED, and its request superseded by the domain's change); a decision retried by the same
// user answers the first. The last step's approval approves the request, a refusal (with its reason) refuses it; the domain
// service then acts (PositionServices.decide#PositionApproval activates the position). The approvers of the step waiting get one
// notification of the kind's topic, which the framework's approve#NotificationMessage and refuse#NotificationMessage decide
// through the domain's handlers; the notices are read once the step is decided or the request ends.
const people = ec.resource.script("component://mr-mantle/service/mantle/humanres/People.js")
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const {find, one, rows, denied, call, dateText} = lib
const ms = lib.ms

const POLICY = "mantle.humanres.approval.PeopleApprovalPolicy"
const APPROVAL = "mantle.humanres.approval.PeopleApproval"
const DECISION = "mantle.humanres.approval.PeopleApprovalDecision"
const RELATIONSHIP = "mantle.party.PartyRelationship"
const POSITION = "mantle.humanres.position.EmplPosition"
const CHANGE = "mantle.humanres.employment.EmploymentChange"
const MESSAGE = "moqui.security.user.NotificationMessage"
const MESSAGE_USER = "moqui.security.user.NotificationMessageUser"
const decideRoles = ["ParDepartmentHead", "ParManager", "ParPerson", "ParHr"]
const roles = decideRoles.concat(["ParHrFallback"])
const statusTexts = {
    PapPending: "Waiting",
    PapApproved: "Approved",
    PapRefused: "Refused",
    PapSuperseded: "Superseded by a change"
}
const decisionTexts = {PpdApproved: "Approved", PpdRefused: "Refused"}
// the permission that lets a person decide a step, of every role, HR-routed steps included (an HR editor without it decides
// none: the user's call, impl-people §4, Nov 11, 2026)
const approvePermissions = ["PEOPLE_REQUEST_APPROVE"]
// a parent chain longer than this is taken to be a cycle
const maxDepth = 50
// the most rows a policy list, a re-route and an owner lookup read
const policyCap = 500
const pendingCap = 500

// The kinds of approval built, each with its source record, topic and what its notice says. Each phase adds its kind with its
// decision service (impl-people §4).
const kinds = {
    PakPosition: {
        topic: "PeoplePositionApproval",
        sourceEntityName: POSITION,
        sourceField: "emplPositionId",
        // what the notice and the summary say of the source: its name, employer and department, no pay
        describe(sourceId) {
            const position = one(POSITION, {emplPositionId: sourceId})
            if (!position) return {label: "position " + sourceId}
            const positionClass = position.emplPositionClassId
                ? one("mantle.humanres.position.EmplPositionClass", {emplPositionClassId: position.emplPositionClassId})
                : null
            const names = people.organizationNames([position.organizationPartyId, position.departmentPartyId].filter(Boolean))
            const positionName = position.description || positionClass?.title || sourceId
            return {
                label: "position " + positionName,
                message: {
                    emplPositionId: sourceId,
                    positionName,
                    organizationName: names[position.organizationPartyId] || position.organizationPartyId || "",
                    departmentName: position.departmentPartyId ? names[position.departmentPartyId] || "" : ""
                }
            }
        }
    },
    // P6: a transfer or a separation (PeopleServices.apply#EmploymentChange and decide#EmploymentChange). The request is bound to
    // the change row and the employment's revision (People.js employmentRevision), so a change of the employment meanwhile (another
    // change applied, a manager changed on the chart) supersedes it.
    PakEmploymentChange: {
        topic: "PeopleEmploymentChangeApproval",
        sourceEntityName: CHANGE,
        sourceField: "employmentChangeId",
        revision(sourceId) {
            const change = one(CHANGE, {employmentChangeId: sourceId})
            if (!change) return "0"
            return String(ms(change.lastUpdatedStamp) ?? 0) + ":" + people.employmentRevision(change.partyRelationshipId)
        },
        // what the notice says: the kind of change and the person (a separation's title names no one), employer and department
        describe(sourceId) {
            const change = one(CHANGE, {employmentChangeId: sourceId})
            if (!change) return {label: "employment change " + sourceId}
            const kindText = (enumTexts([change.changeKindEnumId])[change.changeKindEnumId] || "change").toLowerCase()
            const personName = people.personNames([change.partyId])[change.partyId] || change.partyId
            const names = people.organizationNames([change.organizationPartyId, change.departmentPartyId].filter(Boolean))
            const organizationName = names[change.organizationPartyId] || change.organizationPartyId || ""
            const separation = change.changeKindEnumId === "EckSeparation"
            return {
                label: kindText + " of " + personName,
                message: {
                    employmentChangeId: sourceId,
                    partyId: change.partyId,
                    changeText: kindText,
                    personName,
                    subjectText: separation ? "an employment's end" : "the " + kindText + " of " + personName,
                    organizationName,
                    departmentName: change.departmentPartyId ? names[change.departmentPartyId] || "" : ""
                }
            }
        }
    }
}
function kindOf(approvalKindEnumId) {
    const kind = kinds[approvalKindEnumId]
    if (!kind) denied("KIND_INVALID", "Choose a kind of approval")
    return kind
}
// a source's revision: its last change, what a request names
function revisionOf(kind, sourceId) {
    if (kind.revision) return kind.revision(sourceId)
    const row = one(kind.sourceEntityName, {[kind.sourceField]: sourceId})
    return String(ms(row?.lastUpdatedStamp) ?? 0)
}

const text = value => String(value ?? "").trim()
const unique = people.unique
const nowMs = () => ms(ec.user.nowTimestamp)
const effective = value => (value == null || value === "" ? nowMs() : ec.user.timestampMillis(value))
const stampOf = row => ms(row?.lastUpdatedStamp) ?? 0
function enumTexts(enumIds) {
    const ids = unique(enumIds.filter(Boolean))
    if (!ids.length) return {}
    return Object.fromEntries(
        Array.from(find("moqui.basic.Enumeration").condition("enumId", "in", ids).list()).map(row => [
            row.enumId,
            row.description || row.enumId
        ])
    )
}

// ===== scope =====
function requireAny(permissions, what) {
    if (!permissions.some(permission => lib.access.has(permission)))
        denied("PERMISSION_DENIED", what + " needs " + permissions.join(" or "))
}
// The People scope of a reader of rules and routes: the People administrator (PEOPLE_CONFIGURE) and an HR reader.
function ruleReader(what) {
    const userScope = people.scopeOf()
    const caps = userScope.capabilities
    if (!caps.configure && !caps.hrView) denied("PERMISSION_DENIED", what + " needs PEOPLE_CONFIGURE or PEOPLE_HR_VIEW")
    return userScope
}

// ===== who may decide =====
// The enabled accounts of the parties ({partyId: [userId]}): not disabled, not terminated.
function accountsOf(partyIds) {
    const found = {}
    if (!partyIds.length) return found
    const now = nowMs()
    for (const row of Array.from(find("moqui.security.UserAccount").condition("partyId", "in", partyIds).list())) {
        if (row.disabled === "Y" || (ms(row.terminateDate) ?? Infinity) <= now) continue
        ;(found[row.partyId] || (found[row.partyId] = [])).push(row.userId)
    }
    return found
}
// The users among userIds who hold one of the permissions through a group they are an active member of (ALL_USERS for all).
function usersHolding(userIds, permissions) {
    if (!userIds.length) return new Set()
    const groupIds = unique(
        Array.from(find("moqui.security.UserGroupPermission").condition("userPermissionId", "in", permissions).list())
            .filter(row => lib.active(row))
            .map(row => row.userGroupId)
    )
    if (!groupIds.length) return new Set()
    if (groupIds.includes("ALL_USERS")) return new Set(userIds)
    return new Set(
        Array.from(
            find("moqui.security.UserGroupMember")
                .condition("userId", "in", userIds)
                .condition("userGroupId", "in", groupIds)
                .list()
        )
            .filter(row => lib.active(row))
            .map(row => row.userId)
    )
}
// The parties among partyIds who may decide (an account holding one of the permissions), each with its user.
function deciders(partyIds, permissions) {
    const accounts = accountsOf(unique(partyIds.filter(Boolean)))
    const holding = usersHolding(Object.values(accounts).flat(), permissions)
    const found = []
    for (const partyId of unique(partyIds.filter(Boolean))) {
        const userId = (accounts[partyId] || []).find(id => holding.has(id))
        if (userId) found.push({partyId, userId})
    }
    return found
}
// The departments at and above a department, up to its employer (department rows only), on the date.
function departmentChain(departmentPartyId, organizationPartyId, at) {
    const chain = []
    let current = departmentPartyId
    for (let depth = 0; current && current !== organizationPartyId && depth < maxDepth; depth++) {
        if (!one("mantle.party.PartyRole", {partyId: current, roleTypeId: "OrgDepartment"})) break
        chain.push(current)
        const parent = Array.from(
            people
                .current(find(RELATIONSHIP).condition({relationshipTypeEnumId: "PrtOrgRollup", fromPartyId: current}), at)
                .list()
        )[0]
        current = parent?.toPartyId || null
    }
    return chain
}
// The lead of a unit on the date: its current Manager membership (P3).
function leadOf(unitPartyId, at) {
    const row = Array.from(
        people
            .current(
                find(RELATIONSHIP).condition({
                    relationshipTypeEnumId: "PrtMember",
                    toPartyId: unitPartyId,
                    fromRoleTypeId: "Manager"
                }),
                at
            )
            .orderBy("-fromDate")
            .list()
    )[0]
    return row?.fromPartyId || null
}
// The people of the employer's staff (a current employee or agent of it) among partyIds.
function staffOf(partyIds, organizationPartyId, at) {
    if (!partyIds.length) return []
    return unique(
        Array.from(
            people
                .current(
                    find(RELATIONSHIP)
                        .condition("relationshipTypeEnumId", "in", ["PrtEmployee", "PrtAgent"])
                        .condition("toPartyId", organizationPartyId)
                        .condition("fromPartyId", "in", partyIds),
                    at
                )
                .selectField("fromPartyId")
                .list()
        ).map(row => row.fromPartyId)
    )
}
// The employer's HR editors: the staff of the employer whose account holds PEOPLE_HR_EDIT.
function hrEditorsOf(organizationPartyId, at) {
    const groupIds = unique(
        rows("moqui.security.UserGroupPermission", {userPermissionId: "PEOPLE_HR_EDIT"})
            .filter(row => lib.active(row))
            .map(row => row.userGroupId)
    )
    if (!groupIds.length) return []
    const userIds = unique(
        Array.from(find("moqui.security.UserGroupMember").condition("userGroupId", "in", groupIds).list())
            .filter(row => lib.active(row))
            .map(row => row.userId)
    )
    if (!userIds.length) return []
    const partyIds = unique(
        Array.from(find("moqui.security.UserAccount").condition("userId", "in", userIds).list())
            .map(row => row.partyId)
            .filter(Boolean)
    )
    return staffOf(partyIds, organizationPartyId, at)
}

// ===== routing =====
// The rule rows in effect for an employer and kind on the date, steps first by sequenceNum.
function rulesInEffect(organizationPartyId, approvalKindEnumId, at) {
    return Array.from(
        people
            .current(find(POLICY).condition({organizationPartyId, approvalKindEnumId}), at)
            .orderBy(["sequenceNum", "fromDate"])
            .list()
    )
}
// The rows that route a request: the employee's override, the nearest department's rule, the type rule, or none.
function chooseRules(rules, request, at) {
    const steps = rules.filter(row => row.approverRoleEnumId !== "ParHrFallback")
    if (request.subjectPartyId) {
        const override = steps.filter(row => row.employeePartyId === request.subjectPartyId)
        if (override.length) return {basis: "employee", rows: override}
    }
    const general = steps.filter(row => !row.employeePartyId)
    for (const departmentPartyId of departmentChain(request.departmentPartyId, request.organizationPartyId, at)) {
        const departmentRows = general.filter(row => row.departmentPartyId === departmentPartyId)
        if (departmentRows.length) return {basis: "department", rows: departmentRows, departmentPartyId}
    }
    const typeRows = general.filter(row => !row.departmentPartyId)
    if (typeRows.length) return {basis: "type", rows: typeRows}
    // no rule: the person's manager, or for a request about no one (a position) the head of its department
    const role = request.subjectPartyId ? "ParManager" : "ParDepartmentHead"
    return {basis: "default", rows: [{sequenceNum: 1, approverRoleEnumId: role, peopleApprovalPolicyId: null}]}
}
const basisTexts = {
    employee: "The rule for this employee",
    department: "The department's rule",
    type: "The employer's rule",
    default: "No rule: the manager decides",
    defaultHead: "No rule: the head of the department decides"
}
// The candidates of a step's role, before who may decide: the department head (the lead of the nearest department with one), the
// manager (the request's person's reporting lines at the employer; the department head for a request about no one), the named
// person, HR (the designated officer, else the employer's HR editors).
function roleCandidates(row, request, at) {
    const headOf = () => {
        for (const departmentPartyId of departmentChain(
            row.departmentPartyId || request.departmentPartyId,
            request.organizationPartyId,
            at
        )) {
            const lead = leadOf(departmentPartyId, at)
            if (lead) return {partyIds: [lead], of: departmentPartyId}
        }
        return {partyIds: [], of: row.departmentPartyId || request.departmentPartyId || null}
    }
    switch (row.approverRoleEnumId) {
        case "ParDepartmentHead":
            return headOf()
        case "ParManager":
            if (!request.subjectPartyId) return headOf()
            return {
                partyIds: people
                    .linesOf({reportPartyIds: [request.subjectPartyId]}, at)
                    .filter(line => line.organizationPartyIds.includes(request.organizationPartyId))
                    .map(line => line.managerPartyId),
                of: request.subjectPartyId
            }
        case "ParPerson":
            return {partyIds: row.approverPartyId ? [row.approverPartyId] : []}
        case "ParHr":
            return {
                partyIds: row.approverPartyId ? [row.approverPartyId] : hrEditorsOf(request.organizationPartyId, at)
            }
    }
    return {partyIds: []}
}
// The route of a request on the date: the basis of its rules and each step with who may decide it and how it was found (route,
// alternate, fallback; none when unresolved). excludedByStep: the parties who decided each step (sequenceNum: [partyId]), so a
// person decides one step of a request at most.
function resolve(request, at, excludedByStep = {}) {
    const rules = rulesInEffect(request.organizationPartyId, request.approvalKindEnumId, at)
    const chosen = chooseRules(rules, request, at)
    const fallbackPartyIds = rules
        .filter(row => row.approverRoleEnumId === "ParHrFallback" && row.approverPartyId)
        .map(row => row.approverPartyId)
    const self = [request.requesterPartyId, request.subjectPartyId].filter(Boolean)
    const steps = chosen.rows.map((row, index) => {
        const sequenceNum = Number(row.sequenceNum || index + 1)
        const others = Object.entries(excludedByStep)
            .filter(([step]) => Number(step) !== sequenceNum)
            .flatMap(([, partyIds]) => partyIds)
        const excluded = new Set(self.concat(others))
        const candidates = roleCandidates(row, request, at)
        // who may decide: not excluded, working for the employer now (a leaver decides nothing), an account holding the permission
        const pick = partyIds => {
            const open = partyIds.filter(partyId => !excluded.has(partyId))
            const staff = new Set(staffOf(unique(open), request.organizationPartyId, at))
            return deciders(
                open.filter(partyId => staff.has(partyId)),
                approvePermissions
            )
        }
        let approvers = pick(candidates.partyIds)
        let via = approvers.length ? "route" : null
        if (!approvers.length && row.alternatePartyId) {
            approvers = pick([row.alternatePartyId])
            if (approvers.length) via = "alternate"
        }
        if (!approvers.length && fallbackPartyIds.length) {
            approvers = pick(fallbackPartyIds)
            if (approvers.length) via = "fallback"
        }
        return {
            sequenceNum,
            peopleApprovalPolicyId: row.peopleApprovalPolicyId || null,
            approverRoleEnumId: row.approverRoleEnumId,
            candidatePartyIds: candidates.partyIds,
            candidateOf: candidates.of || null,
            alternatePartyId: row.alternatePartyId || null,
            selfExcluded: candidates.partyIds.some(partyId => self.includes(partyId)),
            approvers,
            via
        }
    })
    return {basis: chosen.basis, departmentPartyId: chosen.departmentPartyId || null, steps, fallbackPartyIds}
}
// The steps as text for a preview and a summary: each step's role, who decides it and why.
function explain(route, request) {
    const partyIds = unique(
        route.steps
            .flatMap(step =>
                step.candidatePartyIds.concat(
                    step.approvers.map(row => row.partyId),
                    [step.alternatePartyId, step.candidateOf]
                )
            )
            .concat(route.fallbackPartyIds, [request.subjectPartyId, request.requesterPartyId])
            .filter(Boolean)
    )
    const names = Object.assign({}, people.organizationNames(partyIds), people.personNames(partyIds))
    const roleTexts = enumTexts(route.steps.map(step => step.approverRoleEnumId))
    const nameOf = partyId => names[partyId] || partyId
    return route.steps.map((step, index) => {
        const roleText = roleTexts[step.approverRoleEnumId] || step.approverRoleEnumId
        const of = step.candidateOf ? " of " + nameOf(step.candidateOf) : ""
        const approverNames = step.approvers.map(row => nameOf(row.partyId))
        const found = step.candidatePartyIds.map(nameOf)
        let detail
        if (step.via === "route") detail = approverNames.join(", ")
        else {
            const why = !found.length
                ? "none"
                : step.selfExcluded
                  ? found.join(", ") + " may not decide their own request"
                  : found.join(", ") + " may not decide"
            detail =
                why +
                (step.via === "alternate"
                    ? "; the alternate " + approverNames.join(", ") + " decides"
                    : step.via === "fallback"
                      ? "; the HR fallback " + approverNames.join(", ") + " decides"
                      : "; no one may decide, so the request waits")
        }
        return {
            sequenceNum: step.sequenceNum,
            stepText: route.steps.length > 1 ? "Step " + (index + 1) + " of " + route.steps.length : "One step",
            approverRoleEnumId: step.approverRoleEnumId,
            roleText,
            approverPartyIds: step.approvers.map(row => row.partyId),
            approverNames: approverNames.join(", "),
            via: step.via,
            unresolved: !step.via,
            explanation: roleText + of + ": " + detail
        }
    })
}

// ===== a request's state =====
const requestOf = approval => ({
    organizationPartyId: approval.organizationPartyId,
    approvalKindEnumId: approval.approvalKindEnumId,
    departmentPartyId: approval.departmentPartyId,
    subjectPartyId: approval.subjectPartyId,
    requesterPartyId: approval.requestedByPartyId
})
const decisionsOf = approval =>
    rows(DECISION, {peopleApprovalId: approval.peopleApprovalId}).sort((a, b) => ms(a.decisionDate) - ms(b.decisionDate))
// A waiting request whose source changed since is superseded, whatever its row says (the domain's change marks it).
function statusOf(approval) {
    if (approval.statusId !== "PapPending") return approval.statusId
    const kind = kinds[approval.approvalKindEnumId]
    return kind && revisionOf(kind, approval.sourceId) !== approval.sourceRevision ? "PapSuperseded" : "PapPending"
}
// A request's route now, with its decisions: each step approved or not, the current step (the first not approved).
function stateOf(approval, decisions = decisionsOf(approval)) {
    const approvedBy = {}
    for (const row of decisions)
        if (row.decisionEnumId === "PpdApproved")
            (approvedBy[row.sequenceNum] || (approvedBy[row.sequenceNum] = [])).push(row.decidedByPartyId)
    const route = resolve(requestOf(approval), nowMs(), approvedBy)
    const steps = route.steps.map(step => Object.assign({}, step, {done: !!approvedBy[step.sequenceNum]}))
    return {route: Object.assign({}, route, {steps}), steps, current: steps.find(step => !step.done) || null, decisions}
}
const stepLabel = (steps, step) =>
    steps.length > 1 ? "step " + (steps.indexOf(step) + 1) + " of " + steps.length : "one approval"

// ===== notices =====
function noticeQuery(approval) {
    const kind = kinds[approval.approvalKindEnumId]
    return find(MESSAGE).condition({topic: kind.topic, recordEntityName: kind.sourceEntityName, recordId: approval.sourceId})
}
// The unread copies of a source's notices, marked read so the request leaves every approver's list.
function clearNotices(approval) {
    const messageIds = Array.from(noticeQuery(approval).selectField("notificationMessageId").list()).map(
        row => row.notificationMessageId
    )
    if (!messageIds.length) return 0
    let cleared = 0
    for (const user of Array.from(
        find(MESSAGE_USER).condition("notificationMessageId", "in", messageIds).condition("viewedDate", "is-null", null).list()
    )) {
        call("update#" + MESSAGE_USER, {
            notificationMessageId: user.notificationMessageId,
            userId: user.userId,
            viewedDate: ec.user.nowTimestamp
        })
        cleared++
    }
    return cleared
}
// The step waiting, to its approvers: one message for the step, unless the unread notices already go to them. A request no one
// may decide waits with no notice. A failure is logged and the change stays.
function notify(approval, state = null) {
    try {
        state = state || stateOf(approval)
        const step = statusOf(approval) === "PapPending" ? state.current : null
        const userIds = step ? unique(step.approvers.map(row => row.userId)) : []
        const messageIds = Array.from(noticeQuery(approval).selectField("notificationMessageId").list()).map(
            row => row.notificationMessageId
        )
        const unread = messageIds.length
            ? unique(
                  Array.from(
                      find(MESSAGE_USER)
                          .condition("notificationMessageId", "in", messageIds)
                          .condition("viewedDate", "is-null", null)
                          .list()
                  ).map(row => row.userId)
              )
            : []
        if (unread.length === userIds.length && unread.every(userId => userIds.includes(userId))) return {notifiedCount: 0}
        clearNotices(approval)
        if (!userIds.length) return {notifiedCount: 0}
        const kind = kinds[approval.approvalKindEnumId]
        const described = kind.describe(approval.sourceId)
        ec.makeNotificationMessage()
            .topic(kind.topic)
            .reason("approval")
            .message(
                Object.assign({}, described.message, {
                    peopleApprovalId: approval.peopleApprovalId,
                    sourceRevision: approval.sourceRevision,
                    stepText: stepLabel(state.steps, step)
                })
            )
            .record(kind.sourceEntityName, approval.sourceId)
            .actorUserId(approval.requestedByUserId || ec.user.userId)
            .userIds(userIds)
            .send()
        return {notifiedCount: userIds.length}
    } catch (error) {
        ec.logger.error("Approval notice of request " + approval.peopleApprovalId + " was not sent: " + error.message)
        return {notifiedCount: 0}
    }
}
// The waiting requests of an employer and kind (every kind when none is given) routed again after a rule, a reporting line or
// an approver's employment changed: a request that had no approver is sent to the one it has now, and one whose approvers
// changed to the new ones (the old notices read). P6's separation calls it for the leaver's employers, so a decision waiting
// on them goes to the step's alternate, else the HR fallback, else waits. Each on its own: a failure is logged and the rest go
// on.
function reroute(organizationPartyId, approvalKindEnumId = null) {
    let notified = 0
    const conditions = {organizationPartyId, statusId: "PapPending"}
    if (approvalKindEnumId) conditions.approvalKindEnumId = approvalKindEnumId
    const pending = Array.from(find(APPROVAL).condition(conditions).limit(pendingCap).list())
    for (const approval of pending) {
        try {
            if (statusOf(approval) === "PapPending") notified += notify(approval).notifiedCount
        } catch (error) {
            ec.logger.error("Approval request " + approval.peopleApprovalId + " was not routed again: " + error.message)
        }
    }
    return notified
}

// ===== requests (the domain services call these after their own checks) =====
// A request of a kind for a source at its current revision; a retry with the same operation key answers the first, and a
// source with a request waiting at this revision is refused (APPROVAL_PENDING). Routed and sent to the first step's approvers;
// with none it waits.
function request(p) {
    const kind = kindOf(p.approvalKindEnumId)
    const sourceId = text(p.sourceId)
    const operationKey = text(p.operationKey) || null
    const requesterPartyId = ec.user.userAccount?.partyId || null
    const existing = rows(APPROVAL, {sourceEntityName: kind.sourceEntityName, sourceId})
    if (operationKey) {
        const first = existing.find(row => row.operationKey === operationKey && row.requestedByUserId === ec.user.userId)
        if (first) return Object.assign(summaryOf(first), {repeated: true})
    }
    const revision = revisionOf(kind, sourceId)
    for (const row of existing.filter(row => row.statusId === "PapPending")) {
        if (row.sourceRevision === revision)
            denied("APPROVAL_PENDING", "This " + kind.describe(sourceId).label + " is already waiting for approval")
        // a request at an earlier revision is superseded (its source changed outside the domain's change)
        supersede(row)
    }
    const created = call("create#" + APPROVAL, {
        approvalKindEnumId: p.approvalKindEnumId,
        sourceEntityName: kind.sourceEntityName,
        sourceId,
        sourceRevision: revision,
        organizationPartyId: p.organizationPartyId,
        departmentPartyId: p.departmentPartyId || null,
        subjectPartyId: p.subjectPartyId || null,
        requestedByUserId: ec.user.userId,
        requestedByPartyId: requesterPartyId,
        requestedDate: ec.user.nowTimestamp,
        effectiveDate: p.effectiveDate == null || p.effectiveDate === "" ? null : new Date(effective(p.effectiveDate)),
        justification: text(p.justification) || null,
        statusId: "PapPending",
        operationKey
    })
    const approval = one(APPROVAL, {peopleApprovalId: created.peopleApprovalId})
    notify(approval)
    return Object.assign(summaryOf(approval), {repeated: false})
}
function supersede(approval) {
    call("update#" + APPROVAL, {
        peopleApprovalId: approval.peopleApprovalId,
        statusId: "PapSuperseded",
        closedDate: ec.user.nowTimestamp
    })
    clearNotices(approval)
}
// Work on the sources' subject that leaves what was asked as it was (P9: a working schedule assigned to an employment whose
// transfer or separation waits): the requests waiting at the sources' revision before the work are bound to the revision after it,
// so the work neither supersedes them nor leaves them stale, and their step is sent again (the earlier notices, which name the
// earlier revision, read). A request already stale before the work stays so. Answers what the work answers.
function keepWaiting(approvalKindEnumId, sourceIds, work) {
    const kind = kindOf(approvalKindEnumId)
    const kept = []
    for (const sourceId of unique(sourceIds || [])) {
        const revision = revisionOf(kind, sourceId)
        for (const approval of rows(APPROVAL, {sourceEntityName: kind.sourceEntityName, sourceId, statusId: "PapPending"}))
            if (approval.sourceRevision === revision) kept.push(approval)
    }
    const result = work()
    for (const approval of kept) {
        call("update#" + APPROVAL, {
            peopleApprovalId: approval.peopleApprovalId,
            sourceRevision: revisionOf(kind, approval.sourceId)
        })
        clearNotices(approval)
        notify(one(APPROVAL, {peopleApprovalId: approval.peopleApprovalId}))
    }
    return result
}
// A source changed (new terms): its requests waiting at an earlier revision are superseded and their notices read; the change
// is asked for again.
function sourceChanged(approvalKindEnumId, sourceId) {
    const kind = kindOf(approvalKindEnumId)
    const revision = revisionOf(kind, sourceId)
    let superseded = 0
    for (const approval of rows(APPROVAL, {sourceEntityName: kind.sourceEntityName, sourceId, statusId: "PapPending"}))
        if (approval.sourceRevision !== revision) {
            supersede(approval)
            superseded++
        }
    return superseded
}
// The latest request of a source as its record shows it: state, requester, dates, justification, each step with who decides it,
// the decisions, and whether the caller may decide the step waiting. Null when it has none.
function sourceSummary(approvalKindEnumId, sourceId) {
    const kind = kindOf(approvalKindEnumId)
    const latest = Array.from(
        find(APPROVAL).condition({sourceEntityName: kind.sourceEntityName, sourceId}).orderBy("-requestedDate").limit(1).list()
    )[0]
    return latest ? summaryOf(latest) : null
}
function summaryOf(approval) {
    const statusId = statusOf(approval)
    const decisions = decisionsOf(approval)
    const state = stateOf(approval, decisions)
    const request = requestOf(approval)
    const steps = explain(state.route, request).map((step, index) =>
        Object.assign(step, {
            done: state.steps[index].done,
            stateText: state.steps[index].done ? "Approved" : state.steps[index] === state.current ? "Waiting" : "Next"
        })
    )
    const partyIds = unique(
        decisions
            .map(row => row.decidedByPartyId)
            .concat([approval.requestedByPartyId])
            .filter(Boolean)
    )
    const names = people.personNames(partyIds)
    const callerPartyId = ec.user.userAccount?.partyId || null
    const current = statusId === "PapPending" ? state.current : null
    const stepNumber = sequenceNum => {
        const index = state.steps.findIndex(step => step.sequenceNum === Number(sequenceNum))
        return index < 0 ? "" : state.steps.length > 1 ? "Step " + (index + 1) : ""
    }
    return {
        peopleApprovalId: approval.peopleApprovalId,
        approvalKindEnumId: approval.approvalKindEnumId,
        sourceId: approval.sourceId,
        sourceRevision: approval.sourceRevision,
        statusId,
        statusText: statusTexts[statusId] || statusId,
        waiting: statusId === "PapPending",
        unresolved: !!current && !current.via,
        waitingText: !current
            ? ""
            : current.via
              ? "Waiting for " + steps[state.steps.indexOf(current)].approverNames
              : "Waiting: no one may decide " + stepLabel(state.steps, current) + " yet",
        requestedByName: names[approval.requestedByPartyId] || approval.requestedByUserId || "",
        requestedDateText: dateText(approval.requestedDate),
        effectiveDateText: dateText(approval.effectiveDate),
        justification: approval.justification || "",
        closedDateText: dateText(approval.closedDate),
        steps,
        decisions: decisions.map(row => ({
            peopleApprovalDecisionId: row.peopleApprovalDecisionId,
            stepText: stepNumber(row.sequenceNum),
            decidedByName: names[row.decidedByPartyId] || row.decidedByUserId || "",
            decisionEnumId: row.decisionEnumId,
            decisionText: decisionTexts[row.decisionEnumId] || row.decisionEnumId,
            decisionDateText: dateText(row.decisionDate),
            reason: row.reason || ""
        })),
        canDecide:
            !!current &&
            !!callerPartyId &&
            current.approvers.some(row => row.partyId === callerPartyId && row.userId === ec.user.userId)
    }
}

// ===== record#Decision =====
// A decision of the step waiting of a request (by peopleApprovalId, else the latest of the kind's source), at the revision the
// caller read (sourceRevision, from the notice): approve, or refuse with a reason. A decision this user already made of the
// request answers the first (repeated). Refused: a caller without PEOPLE_REQUEST_APPROVE (PERMISSION_DENIED);
// no request (RECORD_UNAVAILABLE); another decision than the caller's first (ALREADY_DECIDED); a request no longer waiting
// (NOT_PENDING); a notice of an earlier request or revision (REVISION_CHANGED); a source changed since the request
// (SOURCE_CHANGED); a refusal with no reason (REASON_REQUIRED); the requester or the person it is about (SELF_APPROVAL); anyone
// not an approver of the step waiting (NOT_APPROVER).
function recordDecision(p) {
    requireAny(approvePermissions, "Deciding an approval")
    const decision = text(p.decision) || "approve"
    if (!["approve", "refuse"].includes(decision)) denied("DECISION_INVALID", "Approve or refuse")
    const decisionEnumId = decision === "approve" ? "PpdApproved" : "PpdRefused"
    let approval = text(p.peopleApprovalId) ? one(APPROVAL, {peopleApprovalId: text(p.peopleApprovalId)}) : null
    if (!approval && text(p.sourceId) && kinds[p.approvalKindEnumId]) {
        const kind = kinds[p.approvalKindEnumId]
        approval = Array.from(
            find(APPROVAL)
                .condition({sourceEntityName: kind.sourceEntityName, sourceId: text(p.sourceId)})
                .orderBy("-requestedDate")
                .limit(1)
                .list()
        )[0]
    }
    if (!approval || (p.approvalKindEnumId && approval.approvalKindEnumId !== p.approvalKindEnumId))
        denied("RECORD_UNAVAILABLE", "This approval is not available")
    // the row is locked and read again, so two approvers of one step do not both record it and a decision made meanwhile (a
    // refusal, the last approval, a supersession) is seen
    approval = find(APPROVAL, {peopleApprovalId: approval.peopleApprovalId}).forUpdate(true).one()
    const userId = ec.user.userId
    const partyId = ec.user.userAccount?.partyId || null
    const decisions = decisionsOf(approval)
    const own = decisions.find(row => row.decidedByUserId === userId)
    if (own) {
        if (own.decisionEnumId !== decisionEnumId)
            denied("ALREADY_DECIDED", "You already " + decisionTexts[own.decisionEnumId].toLowerCase() + " this request")
        return answer(one(APPROVAL, {peopleApprovalId: approval.peopleApprovalId}), own, true)
    }
    const statusId = statusOf(approval)
    if (statusId === "PapSuperseded" && approval.statusId === "PapPending")
        denied("SOURCE_CHANGED", "It changed since approval was asked; it is asked for again at its new terms")
    if (statusId !== "PapPending") denied("NOT_PENDING", "This request is " + (statusTexts[statusId] || statusId).toLowerCase())
    if (text(p.sourceRevision) && text(p.sourceRevision) !== approval.sourceRevision)
        denied("REVISION_CHANGED", "This notice is of an earlier version; open the request again")
    const reason = text(p.reason) || null
    if (decision === "refuse" && !reason) denied("REASON_REQUIRED", "Give the reason for refusing")
    if (partyId && [approval.requestedByPartyId, approval.subjectPartyId].includes(partyId))
        denied("SELF_APPROVAL", "You may not decide your own request; another approver decides it")
    const state = stateOf(approval, decisions)
    const step = state.current
    if (!step || !step.approvers.some(row => row.userId === userId))
        denied(
            "NOT_APPROVER",
            step && step.via ? "This step is decided by someone else" : "No one may decide this step yet; it waits"
        )
    const created = call("create#" + DECISION, {
        peopleApprovalId: approval.peopleApprovalId,
        sequenceNum: step.sequenceNum,
        peopleApprovalPolicyId: step.peopleApprovalPolicyId,
        approverRoleEnumId: step.approverRoleEnumId,
        decisionEnumId,
        decisionDate: ec.user.nowTimestamp,
        decidedByUserId: userId,
        decidedByPartyId: partyId,
        sourceRevision: approval.sourceRevision,
        reason,
        operationKey: text(p.operationKey) || null
    })
    const recorded = one(DECISION, {peopleApprovalDecisionId: created.peopleApprovalDecisionId})
    let nextStatusId = "PapPending"
    if (decision === "refuse") nextStatusId = "PapRefused"
    else if (!stateOf(approval).current) nextStatusId = "PapApproved"
    if (nextStatusId !== "PapPending") {
        call("update#" + APPROVAL, {
            peopleApprovalId: approval.peopleApprovalId,
            statusId: nextStatusId,
            closedDate: ec.user.nowTimestamp
        })
        clearNotices(approval)
    } else notify(approval)
    return answer(one(APPROVAL, {peopleApprovalId: approval.peopleApprovalId}), recorded, false)
}
const answer = (approval, decision, repeated) => ({
    peopleApprovalId: approval.peopleApprovalId,
    peopleApprovalDecisionId: decision.peopleApprovalDecisionId,
    decisionEnumId: decision.decisionEnumId,
    statusId: approval.statusId,
    complete: approval.statusId === "PapApproved",
    sourceId: approval.sourceId,
    repeated
})

// ===== find#Policies =====
// The rule rows of the employers in the caller's scope (one employer and a kind asked for), in effect on the date, or every row
// with includeEnded; each with its names, state and revision, and whether the caller may change it (PEOPLE_CONFIGURE).
function findPolicies(p) {
    const userScope = ruleReader("Approval rules")
    const organizationPartyId = text(p.organizationPartyId)
    if (organizationPartyId) people.requireOrganization(userScope, organizationPartyId)
    const organizationPartyIds = organizationPartyId ? [organizationPartyId] : userScope.organizationPartyIds
    if (!organizationPartyIds.length) return Object.assign(lib.pageList([], p, "policies"), {asOfDate: nowMs()})
    const at = people.asOfMillis(p.asOfDate)
    let query = find(POLICY).condition("organizationPartyId", "in", organizationPartyIds)
    if (text(p.approvalKindEnumId)) query = query.condition("approvalKindEnumId", text(p.approvalKindEnumId))
    if (!(p.includeEnded === true || p.includeEnded === "true")) {
        const factory = ec.entity.conditionFactory
        query = query.condition(
            factory.makeCondition(
                factory.makeCondition("thruDate", "is-null", null),
                "or",
                factory.makeCondition("thruDate", "greater", people.stamp(at))
            )
        )
    }
    const found = Array.from(query.limit(policyCap).list())
    const partyIds = unique(
        found
            .flatMap(row => [
                row.organizationPartyId,
                row.departmentPartyId,
                row.employeePartyId,
                row.approverPartyId,
                row.alternatePartyId
            ])
            .filter(Boolean)
    )
    const names = Object.assign({}, people.organizationNames(partyIds), people.personNames(partyIds))
    const texts = enumTexts(found.flatMap(row => [row.approvalKindEnumId, row.approverRoleEnumId]))
    const canEdit = !!userScope.capabilities.configure
    const policyRows = found
        .map(row => {
            const fromMs = ms(row.fromDate)
            const thruMs = ms(row.thruDate)
            const state = thruMs != null && thruMs <= at ? "ended" : fromMs != null && fromMs > at ? "future" : "current"
            const scopeText = row.employeePartyId
                ? "Employee " + (names[row.employeePartyId] || row.employeePartyId)
                : row.departmentPartyId
                  ? "Department " + (names[row.departmentPartyId] || row.departmentPartyId)
                  : "Whole employer"
            return {
                peopleApprovalPolicyId: row.peopleApprovalPolicyId,
                organizationPartyId: row.organizationPartyId,
                organizationName: names[row.organizationPartyId] || row.organizationPartyId,
                approvalKindEnumId: row.approvalKindEnumId,
                kindText: texts[row.approvalKindEnumId] || row.approvalKindEnumId,
                departmentPartyId: row.departmentPartyId || null,
                departmentName: row.departmentPartyId ? names[row.departmentPartyId] || row.departmentPartyId : "",
                employeePartyId: row.employeePartyId || null,
                employeeName: row.employeePartyId ? names[row.employeePartyId] || row.employeePartyId : "",
                scopeText,
                sequenceNum: row.sequenceNum ?? null,
                stepText: row.approverRoleEnumId === "ParHrFallback" ? "Fallback" : "Step " + (row.sequenceNum ?? 1),
                approverRoleEnumId: row.approverRoleEnumId,
                roleText: texts[row.approverRoleEnumId] || row.approverRoleEnumId,
                approverPartyId: row.approverPartyId || null,
                approverName: row.approverPartyId ? names[row.approverPartyId] || row.approverPartyId : "",
                alternatePartyId: row.alternatePartyId || null,
                alternateName: row.alternatePartyId ? names[row.alternatePartyId] || row.alternatePartyId : "",
                description: row.description || "",
                fromDate: row.fromDate,
                thruDate: row.thruDate,
                fromDateText: dateText(row.fromDate),
                thruDateText: dateText(row.thruDate),
                state,
                stateText: state === "ended" ? "Ended" : state === "future" ? "From " + dateText(row.fromDate) : "In effect",
                canEdit: canEdit && state !== "ended",
                revision: String(stampOf(row))
            }
        })
        .sort(
            (a, b) =>
                a.organizationName.localeCompare(b.organizationName) ||
                a.kindText.localeCompare(b.kindText) ||
                a.scopeText.localeCompare(b.scopeText) ||
                (a.sequenceNum ?? 99) - (b.sequenceNum ?? 99) ||
                (ms(a.fromDate) ?? 0) - (ms(b.fromDate) ?? 0)
        )
    return Object.assign(lib.pageList(policyRows, p, "policies"), {asOfDate: at})
}

// ===== store#Policy =====
// A new rule row from a date (now when empty), a row's new terms (the row in effect ends on the change's date and the new one
// starts; a row not yet in effect is changed in place), or a row's end (thruDate alone). Refused: a caller without
// PEOPLE_CONFIGURE (PERMISSION_DENIED); no employer (ORGANIZATION_REQUIRED) or one outside the scope (ORGANIZATION_DENIED); a
// kind not built (KIND_INVALID); a role that is not one (ROLE_INVALID); a named person's role without the person
// (APPROVER_REQUIRED); a department that is not one (NOT_A_DEPARTMENT) or not the employer's (DEPARTMENT_OUTSIDE); an employee,
// approver or alternate the employer does not employ (NOT_EMPLOYED); a rule for an employee naming them to decide
// (SELF_APPROVAL); a step at a place another row of the same scope holds then (STEP_EXISTS); an end on or before the start or a
// change dated before the row (DATES_INVALID); a row outside the scope (RECORD_UNAVAILABLE); a revision other than the one read
// (REVISION_CHANGED). The waiting requests of the employer and kind are routed again.
const policyFields = [
    "organizationPartyId",
    "approvalKindEnumId",
    "departmentPartyId",
    "employeePartyId",
    "sequenceNum",
    "approverRoleEnumId",
    "approverPartyId",
    "alternatePartyId",
    "description"
]
function checkDepartment(departmentPartyId, organizationPartyId, at) {
    if (!departmentPartyId) return null
    const name = people.organizationNames([departmentPartyId])[departmentPartyId] || departmentPartyId
    if (!one("mantle.party.PartyRole", {partyId: departmentPartyId, roleTypeId: "OrgDepartment"}))
        denied("NOT_A_DEPARTMENT", name + " is not a department")
    let above = departmentPartyId
    for (let depth = 0; above && depth < maxDepth; depth++) {
        const parent = Array.from(
            people.current(find(RELATIONSHIP).condition({relationshipTypeEnumId: "PrtOrgRollup", fromPartyId: above}), at).list()
        )[0]
        if (!parent) break
        if (parent.toPartyId === organizationPartyId) return departmentPartyId
        above = parent.toPartyId
    }
    denied("DEPARTMENT_OUTSIDE", name + " is not a department of this employer")
}
function checkEmployed(partyId, organizationPartyId, at, what) {
    if (!partyId) return null
    const employed = people
        .current(people.employmentFind().condition({fromPartyId: partyId, toPartyId: organizationPartyId}), at)
        .count()
    if (!employed) denied("NOT_EMPLOYED", "The " + what + " is not employed by this employer")
    return partyId
}
// A person who works for the employer (a current employee or agent): who may be named to decide.
function checkStaff(partyId, organizationPartyId, at, what) {
    if (!partyId) return null
    if (!staffOf([partyId], organizationPartyId, at).length)
        denied("NOT_EMPLOYED", "The " + what + " does not work for this employer")
    return partyId
}
function validatePolicy(values, at) {
    const organizationPartyId = values.organizationPartyId
    kindOf(values.approvalKindEnumId)
    if (!roles.includes(values.approverRoleEnumId)) denied("ROLE_INVALID", "Choose who decides the step")
    if (["ParPerson", "ParHrFallback"].includes(values.approverRoleEnumId) && !values.approverPartyId)
        denied("APPROVER_REQUIRED", "Choose the person who decides")
    if (!["ParPerson", "ParHr", "ParHrFallback"].includes(values.approverRoleEnumId)) values.approverPartyId = null
    if (values.approverRoleEnumId === "ParHrFallback") {
        values.sequenceNum = null
        values.employeePartyId = null
        values.departmentPartyId = null
        values.alternatePartyId = null
    } else {
        const sequenceNum = values.sequenceNum == null || values.sequenceNum === "" ? 1 : Number(values.sequenceNum)
        if (!Number.isInteger(sequenceNum) || sequenceNum < 1 || sequenceNum > 20)
            denied("STEP_INVALID", "A step is a whole number from 1 to 20")
        values.sequenceNum = sequenceNum
    }
    values.departmentPartyId = checkDepartment(values.departmentPartyId, organizationPartyId, at)
    checkEmployed(values.employeePartyId, organizationPartyId, at, "employee")
    checkStaff(values.approverPartyId, organizationPartyId, at, "approver")
    checkStaff(values.alternatePartyId, organizationPartyId, at, "alternate")
    if (values.employeePartyId && [values.approverPartyId, values.alternatePartyId].includes(values.employeePartyId))
        denied("SELF_APPROVAL", "An employee's rule may not name them to decide their own requests")
    return values
}
// Another row of the same scope at the same place in effect in the period (a fallback's place is its person).
function sameStep(values, fromMs, thruMs, exceptId) {
    return rows(POLICY, {
        organizationPartyId: values.organizationPartyId,
        approvalKindEnumId: values.approvalKindEnumId
    }).find(
        row =>
            row.peopleApprovalPolicyId !== exceptId &&
            (row.approverRoleEnumId === "ParHrFallback") === (values.approverRoleEnumId === "ParHrFallback") &&
            (values.approverRoleEnumId === "ParHrFallback"
                ? row.approverPartyId === values.approverPartyId
                : (row.departmentPartyId || null) === (values.departmentPartyId || null) &&
                  (row.employeePartyId || null) === (values.employeePartyId || null) &&
                  Number(row.sequenceNum ?? 1) === values.sequenceNum) &&
            (ms(row.fromDate) ?? -Infinity) < (thruMs ?? Infinity) &&
            fromMs < (ms(row.thruDate) ?? Infinity)
    )
}
function storePolicy(p) {
    const userScope = people.scopeOf()
    if (!userScope.capabilities.configure) denied("PERMISSION_DENIED", "Changing approval rules needs PEOPLE_CONFIGURE")
    const given = field => p[field] != null
    const blankToNull = value => text(value) || null
    if (!text(p.peopleApprovalPolicyId)) {
        const organizationPartyId = text(p.organizationPartyId)
        if (!organizationPartyId) denied("ORGANIZATION_REQUIRED", "Choose the employer")
        people.requireOrganization(userScope, organizationPartyId)
        const fromMs = effective(p.fromDate)
        const thruMs = text(p.thruDate) ? effective(p.thruDate) : null
        if (thruMs != null && thruMs <= fromMs) denied("DATES_INVALID", "A rule ends after it starts")
        const values = validatePolicy(
            Object.fromEntries(policyFields.map(field => [field, blankToNull(p[field])])),
            Math.max(fromMs, nowMs())
        )
        if (sameStep(values, fromMs, thruMs, null))
            denied("STEP_EXISTS", "Another rule holds this step then; change that rule instead")
        const created = call(
            "create#" + POLICY,
            Object.assign(values, {
                fromDate: new Date(fromMs),
                thruDate: thruMs == null ? null : new Date(thruMs),
                changedByUserId: ec.user.userId
            })
        )
        reroute(organizationPartyId, values.approvalKindEnumId)
        const row = one(POLICY, {peopleApprovalPolicyId: created.peopleApprovalPolicyId})
        return {peopleApprovalPolicyId: row.peopleApprovalPolicyId, revision: String(stampOf(row))}
    }
    const row = one(POLICY, {peopleApprovalPolicyId: text(p.peopleApprovalPolicyId)})
    if (!row || !userScope.organizationPartyIds.includes(row.organizationPartyId))
        denied("RECORD_UNAVAILABLE", "This rule is not available")
    const revision = String(stampOf(row))
    if (text(p.expectedRevision) !== revision)
        denied("REVISION_CHANGED", "This rule changed since you read it; open it again (revision " + revision + ")")
    const reason = text(p.changeReason) || null
    const rowFromMs = ms(row.fromDate) ?? -Infinity
    const rowThruMs = ms(row.thruDate)
    if (rowThruMs != null && rowThruMs <= nowMs()) denied("RULE_ENDED", "This rule has ended")
    const terms = policyFields.filter(field => field !== "organizationPartyId" && given(field))
    const changed = terms.filter(field => (blankToNull(p[field]) ?? null) !== (row[field] == null ? null : String(row[field])))
    // an end alone
    if (!changed.length) {
        if (!text(p.thruDate)) return {peopleApprovalPolicyId: row.peopleApprovalPolicyId, revision}
        // an end is never dated before now: the period a rule was in effect, and the decisions made under it, stay as they were
        const thruMs = Math.max(effective(p.thruDate), nowMs())
        if (thruMs <= rowFromMs) denied("DATES_INVALID", "A rule ends after it starts")
        call("update#" + POLICY, {
            peopleApprovalPolicyId: row.peopleApprovalPolicyId,
            thruDate: new Date(thruMs),
            thruDate_changeReason: reason,
            changedByUserId: ec.user.userId
        })
        reroute(row.organizationPartyId, row.approvalKindEnumId)
        const ended = one(POLICY, {peopleApprovalPolicyId: row.peopleApprovalPolicyId})
        return {peopleApprovalPolicyId: ended.peopleApprovalPolicyId, revision: String(stampOf(ended))}
    }
    const values = Object.fromEntries(policyFields.map(field => [field, row[field] == null ? null : String(row[field])]))
    for (const field of changed) values[field] = blankToNull(p[field])
    values.organizationPartyId = row.organizationPartyId
    // a change takes effect from its date, never before now (the row's history stays as it was), or a row not yet in effect from
    // its own start
    const fromMs = rowFromMs > nowMs() ? rowFromMs : Math.max(effective(p.fromDate), nowMs())
    if (fromMs < rowFromMs) denied("DATES_INVALID", "A change starts on or after the rule's start")
    validatePolicy(values, Math.max(fromMs, nowMs()))
    if (sameStep(values, fromMs, rowThruMs, row.peopleApprovalPolicyId))
        denied("STEP_EXISTS", "Another rule holds this step then; change that rule instead")
    let resultId = row.peopleApprovalPolicyId
    if (rowFromMs >= fromMs) {
        // a row not yet in effect is changed in place, each field audited with the reason
        const changes = {peopleApprovalPolicyId: row.peopleApprovalPolicyId, changedByUserId: ec.user.userId}
        for (const field of policyFields)
            if ((values[field] ?? null) !== (row[field] == null ? null : String(row[field]))) {
                changes[field] = values[field]
                changes[field + "_changeReason"] = reason
            }
        call("update#" + POLICY, changes)
    } else {
        // the row in effect ends on the change's date and the next starts
        call("update#" + POLICY, {
            peopleApprovalPolicyId: row.peopleApprovalPolicyId,
            thruDate: new Date(fromMs),
            thruDate_changeReason: reason,
            changedByUserId: ec.user.userId
        })
        resultId = call(
            "create#" + POLICY,
            Object.assign(values, {fromDate: new Date(fromMs), thruDate: row.thruDate, changedByUserId: ec.user.userId})
        ).peopleApprovalPolicyId
    }
    reroute(row.organizationPartyId, row.approvalKindEnumId)
    const stored = one(POLICY, {peopleApprovalPolicyId: resultId})
    return {peopleApprovalPolicyId: stored.peopleApprovalPolicyId, revision: String(stampOf(stored))}
}

// ===== resolve#Approvers =====
// The route of an example request, explained (ResolvePreview): an employer and kind, the department (or a position's, which
// gives its employer and department), the person it is about and who asks. Refused: a caller who reads no rule
// (PERMISSION_DENIED); an employer outside the scope (ORGANIZATION_DENIED); a position outside it (RECORD_UNAVAILABLE); a
// department not the employer's (DEPARTMENT_OUTSIDE, NOT_A_DEPARTMENT); a person or requester the employer does not employ
// (NOT_EMPLOYED).
function resolveApprovers(p) {
    const userScope = ruleReader("Approval routes")
    kindOf(p.approvalKindEnumId || "PakPosition")
    let organizationPartyId = text(p.organizationPartyId)
    let departmentPartyId = text(p.departmentPartyId) || null
    if (text(p.emplPositionId)) {
        const position = one(POSITION, {emplPositionId: text(p.emplPositionId)})
        if (!position || !userScope.organizationPartyIds.includes(position.organizationPartyId))
            denied("RECORD_UNAVAILABLE", "Position " + text(p.emplPositionId) + " is not available")
        organizationPartyId = position.organizationPartyId
        departmentPartyId = departmentPartyId || position.departmentPartyId || null
    }
    if (!organizationPartyId) denied("ORGANIZATION_REQUIRED", "Choose the employer")
    people.requireOrganization(userScope, organizationPartyId)
    const at = nowMs()
    checkDepartment(departmentPartyId, organizationPartyId, at)
    const subjectPartyId = checkEmployed(text(p.subjectPartyId) || null, organizationPartyId, at, "person")
    const requesterPartyId = text(p.requesterPartyId) || null
    const request = {
        organizationPartyId,
        approvalKindEnumId: p.approvalKindEnumId || "PakPosition",
        departmentPartyId,
        subjectPartyId,
        requesterPartyId
    }
    const route = resolve(request, at)
    const steps = explain(route, request)
    return {
        basis: route.basis,
        basisText:
            basisTexts[route.basis === "default" && !subjectPartyId ? "defaultHead" : route.basis] +
            (route.departmentPartyId
                ? " (" + (people.organizationNames([route.departmentPartyId])[route.departmentPartyId] || "") + ")"
                : ""),
        steps,
        unresolved: steps.some(step => step.unresolved)
    }
}

// ===== the lifecycle participant (find#OwnedApprovals, transfer#ApprovalOwner) =====
// What a user owns of People's approvals: the requests waiting for their decision (decided by them or re-routed when the rule
// or reporting line naming them changes; not transferable) and the rule rows in effect naming them to decide (approver,
// alternate or HR fallback; handed to a new approver). Names only. The caller's own, or another user's with
// PEOPLE_APPROVAL_OWNER_CHANGE.
function ownerAccount(userId) {
    if (!ec.user.userId) denied("PERMISSION_DENIED", "Sign in to see approvals")
    if (userId !== ec.user.userId && !lib.access.has("PEOPLE_APPROVAL_OWNER_CHANGE"))
        denied("PERMISSION_DENIED", "PEOPLE_APPROVAL_OWNER_CHANGE is required for another user's approvals")
    return one("moqui.security.UserAccount", {userId})
}
function findOwnedApprovals(p) {
    const account = ownerAccount(text(p.userId))
    const partyId = account?.partyId
    const resourceList = []
    if (!partyId) return {resourceList}
    const now = nowMs()
    const factory = ec.entity.conditionFactory
    // the rows not ended, those in effect and those starting later
    const named = Array.from(
        find(POLICY)
            .condition(
                factory.makeCondition(
                    [
                        factory.makeCondition("approverPartyId", "equals", partyId),
                        factory.makeCondition("alternatePartyId", "equals", partyId)
                    ],
                    "or"
                )
            )
            .condition(
                factory.makeCondition(
                    factory.makeCondition("thruDate", "is-null", null),
                    "or",
                    factory.makeCondition("thruDate", "greater", people.stamp(now))
                )
            )
            .limit(policyCap)
            .list()
    )
    const names = people.organizationNames(unique(named.map(row => row.organizationPartyId)))
    const texts = enumTexts(named.flatMap(row => [row.approvalKindEnumId, row.approverRoleEnumId]))
    for (const row of named)
        resourceList.push({
            resourceId: "policy:" + row.peopleApprovalPolicyId,
            resourceName:
                (texts[row.approvalKindEnumId] || row.approvalKindEnumId) +
                " rule of " +
                (names[row.organizationPartyId] || row.organizationPartyId) +
                (row.approverRoleEnumId === "ParHrFallback" ? ", HR fallback" : ", step " + (row.sequenceNum ?? 1)),
            resourceKind: "approvalRule",
            transferable: true,
            note: row.alternatePartyId === partyId && row.approverPartyId !== partyId ? "Alternate" : "Approver"
        })
    const pending = Array.from(find(APPROVAL).condition("statusId", "PapPending").limit(pendingCap).list())
    for (const approval of pending) {
        try {
            if (statusOf(approval) !== "PapPending") continue
            const current = stateOf(approval).current
            if (!current || !current.approvers.some(row => row.partyId === partyId)) continue
            resourceList.push({
                resourceId: "approval:" + approval.peopleApprovalId,
                resourceName:
                    (enumTexts([approval.approvalKindEnumId])[approval.approvalKindEnumId] || "Approval") +
                    ": " +
                    kinds[approval.approvalKindEnumId].describe(approval.sourceId).label,
                resourceKind: "approval",
                transferable: false,
                note: "Waiting for their decision; routed to the new approver once the rule or reporting line naming them changes"
            })
        } catch (error) {
            ec.logger.error(
                "Approval request " + approval.peopleApprovalId + " could not be read for its owner: " + error.message
            )
        }
    }
    return {resourceList}
}
// A rule row naming fromUserId's person to decide handed to toUserId's: the row in effect ends now and its copy names the new
// person, with the reason (a row not yet in effect is changed in place); the waiting requests of its employer and kind are
// routed again. With PEOPLE_APPROVAL_OWNER_CHANGE (the offboarding operator), or by fromUserId when they also change the
// employer's rules (PEOPLE_CONFIGURE in its scope): a rule is the employer's, so its approver alone does not choose who decides
// in their place (PERMISSION_DENIED). Refused: a resource that is not a rule row naming the person (RECORD_UNAVAILABLE), a waiting
// request (NOT_TRANSFERABLE: it follows its route), a new owner with no enabled account and person (OWNER_INVALID), one the
// employer does not employ (NOT_EMPLOYED) or the rule's own employee (SELF_APPROVAL).
function transferApprovalOwner(p) {
    const from = ownerAccount(text(p.fromUserId))
    const to = one("moqui.security.UserAccount", {userId: text(p.toUserId)})
    const resourceId = text(p.approvalResourceId)
    if (resourceId.startsWith("approval:"))
        denied("NOT_TRANSFERABLE", "A waiting request follows its route; hand over the rule or reporting line instead")
    const row = resourceId.startsWith("policy:")
        ? one(POLICY, {peopleApprovalPolicyId: resourceId.slice("policy:".length)})
        : null
    const fromPartyId = from?.partyId
    if (
        !row ||
        !fromPartyId ||
        ![row.approverPartyId, row.alternatePartyId].includes(fromPartyId) ||
        (ms(row.thruDate) ?? Infinity) <= nowMs()
    )
        denied("RECORD_UNAVAILABLE", "This approval rule is not available")
    if (!lib.access.has("PEOPLE_APPROVAL_OWNER_CHANGE")) {
        const userScope = people.scopeOf()
        if (!userScope.capabilities.configure || !userScope.organizationPartyIds.includes(row.organizationPartyId))
            denied(
                "PERMISSION_DENIED",
                "Handing over an approval rule needs PEOPLE_APPROVAL_OWNER_CHANGE, or PEOPLE_CONFIGURE of its employer"
            )
    }
    if (!to || !to.partyId || to.disabled === "Y" || (ms(to.terminateDate) ?? Infinity) <= nowMs())
        denied("OWNER_INVALID", "The new approver needs an enabled account with a person")
    if (to.partyId === fromPartyId) denied("OWNER_INVALID", "The new approver is the current one")
    const values = Object.fromEntries(policyFields.map(field => [field, row[field] == null ? null : String(row[field])]))
    if (values.approverPartyId === fromPartyId) values.approverPartyId = to.partyId
    if (values.alternatePartyId === fromPartyId) values.alternatePartyId = to.partyId
    const now = nowMs()
    checkStaff(to.partyId, row.organizationPartyId, now, "new approver")
    if (values.employeePartyId && [values.approverPartyId, values.alternatePartyId].includes(values.employeePartyId))
        denied("SELF_APPROVAL", "An employee's rule may not name them to decide their own requests")
    const reason = text(p.reason) || "Handed over from " + (people.personNames([fromPartyId])[fromPartyId] || fromPartyId)
    if ((ms(row.fromDate) ?? -Infinity) > now) {
        // a row not yet in effect names the new person in place, audited with the reason
        const changes = {peopleApprovalPolicyId: row.peopleApprovalPolicyId, changedByUserId: ec.user.userId}
        for (const field of ["approverPartyId", "alternatePartyId"])
            if (values[field] !== (row[field] ?? null)) {
                changes[field] = values[field]
                changes[field + "_changeReason"] = reason
            }
        call("update#" + POLICY, changes)
    } else {
        call("update#" + POLICY, {
            peopleApprovalPolicyId: row.peopleApprovalPolicyId,
            thruDate: new Date(now),
            thruDate_changeReason: reason,
            changedByUserId: ec.user.userId
        })
        call(
            "create#" + POLICY,
            Object.assign(values, {fromDate: new Date(now), thruDate: row.thruDate, changedByUserId: ec.user.userId})
        )
    }
    reroute(row.organizationPartyId, row.approvalKindEnumId)
    return {transferred: true}
}

// ===== the caller's own requests and the decisions waiting on them (P8; design §3 SelfService MyRequests, MyTeam Decisions) =====
// the most requests and notices one list reads
const ownCap = 200
// A request's line as its requester or approver reads it: the kind, what it is about (the kind's own label, no pay), the
// requester, the dates and the state.
function lineOf(approval, statusId = statusOf(approval)) {
    const kind = kinds[approval.approvalKindEnumId]
    const described = kind ? kind.describe(approval.sourceId) : {label: approval.sourceId}
    return {
        peopleApprovalId: approval.peopleApprovalId,
        approvalKindEnumId: approval.approvalKindEnumId,
        kindText: enumTexts([approval.approvalKindEnumId])[approval.approvalKindEnumId] || approval.approvalKindEnumId,
        summary: described.label ? described.label.charAt(0).toUpperCase() + described.label.slice(1) : approval.sourceId,
        message: described.message || {},
        sourceEntityName: approval.sourceEntityName,
        sourceId: approval.sourceId,
        subjectPartyId: approval.subjectPartyId || null,
        organizationPartyId: approval.organizationPartyId,
        requestedDate: approval.requestedDate,
        requestedDateText: dateText(approval.requestedDate),
        effectiveDateText: dateText(approval.effectiveDate),
        statusId,
        statusText: statusTexts[statusId] || statusId
    }
}
// find#MyRequests: the People requests the caller made (any kind, newest first; with openOnly those waiting), each with its
// state, who decides the step waiting (or that no one may yet) and a refusal's reason, the requester's own to read. No supplied
// user or party is read: they are the caller's.
function findMyRequests(p) {
    if (!ec.user.userId) denied("PERMISSION_DENIED", "Your requests are not available")
    let query = find(APPROVAL).condition("requestedByUserId", ec.user.userId)
    if (p.openOnly === true || p.openOnly === "true") query = query.condition("statusId", "PapPending")
    const found = Array.from(query.orderBy("-requestedDate").limit(ownCap).list())
    const requests = found.map(approval => {
        const statusId = statusOf(approval)
        const line = lineOf(approval, statusId)
        delete line.message
        let nextText = ""
        let returnReason = ""
        if (statusId === "PapPending") {
            const state = stateOf(approval)
            const route = explain(state.route, requestOf(approval))
            const index = state.current ? state.steps.indexOf(state.current) : -1
            nextText = index < 0 ? "" : route[index].unresolved ? "No one may decide it yet" : route[index].approverNames
        } else if (statusId === "PapRefused") {
            const refused = decisionsOf(approval).filter(row => row.decisionEnumId === "PpdRefused")
            returnReason = refused.length ? refused[refused.length - 1].reason || "" : ""
        }
        return Object.assign(line, {nextApproverText: nextText, returnReason})
    })
    return lib.pageList(requests, p, "requests")
}
// How many of the caller's own requests wait (get#SelfService's count).
function openRequestCount() {
    if (!ec.user.userId) return 0
    return Array.from(
        find(APPROVAL).condition({requestedByUserId: ec.user.userId, statusId: "PapPending"}).limit(ownCap).list()
    ).filter(approval => statusOf(approval) === "PapPending").length
}
// The decisions waiting on the caller: the requests waiting whose notices reached them and whose step waiting they may decide
// now (an approver of it, PEOPLE_REQUEST_APPROVE), newest first. Read from the notices, so a request whose route never reached
// the caller is not read; each is checked against its route now, so a step another decided or one routed elsewhere is not theirs.
// Each line's title names the request as its notice does (a separation names no one).
function waitingFor(limit = 50) {
    const userId = ec.user.userId
    const partyId = ec.user.userAccount?.partyId || null
    if (!userId || !partyId || !approvePermissions.some(permission => lib.access.has(permission))) return []
    const topics = Object.values(kinds).map(kind => kind.topic)
    const notices = Array.from(
        find("moqui.security.user.NotificationMessageByUser", {userId})
            .condition("topic", "in", topics)
            .selectField(["notificationMessageId", "messageJson", "sentDate"])
            .orderBy("-sentDate")
            .limit(ownCap)
            .list()
    )
    const approvalIds = unique(notices.map(row => lib.json(row.messageJson, {})?.peopleApprovalId).filter(Boolean))
    if (!approvalIds.length) return []
    const pending = Array.from(
        find(APPROVAL).condition("peopleApprovalId", "in", approvalIds).condition("statusId", "PapPending").list()
    )
    const found = []
    for (const approval of pending) {
        if (found.length >= limit) break
        try {
            if (statusOf(approval) !== "PapPending") continue
            const state = stateOf(approval)
            if (!state.current || !state.current.approvers.some(row => row.partyId === partyId && row.userId === userId)) continue
            const line = lineOf(approval)
            const message = line.message
            delete line.message
            found.push(
                Object.assign(line, {
                    title: "Approve " + (message.subjectText || line.summary.charAt(0).toLowerCase() + line.summary.slice(1)),
                    organizationName: message.organizationName || "",
                    stepText: stepLabel(state.steps, state.current),
                    requestedByName:
                        people.personNames([approval.requestedByPartyId].filter(Boolean))[approval.requestedByPartyId] || ""
                })
            )
        } catch (error) {
            // one request that cannot be read is logged and the rest go on
            ec.logger.error("People decision " + approval.peopleApprovalId + " could not be read: " + error.message)
        }
    }
    return found.sort((a, b) => (ms(b.requestedDate) || 0) - (ms(a.requestedDate) || 0))
}

const operations = {
    findPolicies,
    storePolicy,
    resolveApprovers,
    recordDecision,
    findOwnedApprovals,
    transferApprovalOwner,
    findMyRequests
}
function run(op, p) {
    if (!Object.hasOwn(operations, op)) throw new Error("Unknown approval operation " + op)
    return operations[op](p || {})
}
;({
    execute: run,
    // for the domain modules (Positions.js): a request of a source, its change, its summary and the kinds' sources
    request,
    sourceChanged,
    sourceSummary,
    // P9: a change beside a waiting request that leaves what was asked as it was (a working schedule assigned)
    keepWaiting,
    // for P6's separation and manager change (People's employment changes): an employer's waiting requests routed again
    reroute,
    // P8: the decisions waiting on the caller (find#DueWork, the Today source, MyTeam) and their own open requests (get#SelfService)
    waitingFor,
    openRequestCount
})
