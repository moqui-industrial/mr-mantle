// People's approval rules and decisions (mantle.humanres.PeopleApprovalServices, PositionServices request#PositionApproval and
// decide#PositionApproval, PeopleServices find#Lookups and store#Lookup; IronStone People design §12 ApprovalPolicies, Lookups,
// §13 Approvals, PE-15; impl-people P5): the routing order (an employee's override, then the nearest department's rule, then the
// employer's rule, then the manager; the step's alternate and the HR fallback when no one of the role may decide); the requester
// never an approver; a request no one may decide waits and is sent once a rule names someone; a position's activation decided
// by its department head through the notice, a retried decision answering the first; new terms superseding a waiting request
// and a source changed since refused; two steps each required, a refusal with its reason; the HR vocabularies ended, never
// deleted; the lifecycle participant's rules handed to a new approver. Standalone: spec-local organizations, departments,
// people, employments, groups and users, with artifact authorization disabled (the rules are the services' own checks).
// Run: ./moq test mr-mantle --spec PeopleApprovals
const prefix = "PEOPLE_APR_SPEC"
const orgA = prefix + "_A",
    orgB = prefix + "_B",
    since = "2000-01-01T00:00:00Z"
const A = "mantle.humanres.PeopleApprovalServices."
const S = "mantle.humanres.PositionServices."
const P = "mantle.humanres.PeopleServices."
const O = "mantle.humanres.OrganizationServices."
const NOTIFY = "org.moqui.ui.NotificationServices."
const state = {}

// a call as a user: its result with its error text ("" when it succeeds), in its own transaction
function run(username, service, parameters = {}) {
    login(username)
    ec.artifactExecution.disableAuthz()
    ec.message.pushErrors()
    try {
        const out = ec.service.sync().name(service).parameters(parameters).requireNewTransaction(true).call() || {}
        return Object.assign({}, out, {error: ec.message.hasError() ? ec.message.getErrorsString() : ""})
    } catch (error) {
        return {error: String(error.message || error)}
    } finally {
        ec.message.clearErrors()
        ec.message.popErrors()
        login("john.doe")
        ec.artifactExecution.disableAuthz()
    }
}
// the reason code of a refusal, or "" when the call succeeds
const code = out => (out.error ? /[A-Z][A-Z0-9_]{3,}(?=:)/.exec(out.error)?.[0] || out.error : "")
function organization(partyId, name) {
    call("create#mantle.party.Party", {partyId, partyTypeEnumId: "PtyOrganization", ownerPartyId: partyId})
    call("create#mantle.party.Organization", {partyId, organizationName: name})
    call("create#mantle.party.PartyRole", {partyId, roleTypeId: "OrgInternal"})
}
function person(kind) {
    const partyId = prefix + "_" + kind
    call("create#mantle.party.Party", {partyId, partyTypeEnumId: "PtyPerson"})
    call("create#mantle.party.Person", {partyId, firstName: "Apr", lastName: kind})
    return partyId
}
function employ(partyId, organizationPartyId) {
    call("mantle.humanres.EmploymentServices.create#Employment", {
        fromPartyId: partyId,
        toPartyId: organizationPartyId,
        fromDate: since
    })
    return partyId
}
// a user of a spec-local group with the permissions: the person given, else a new agent of the organizations
function user(kind, permissions, organizationPartyIds, partyId = null) {
    const id = prefix + "_U_" + kind
    call("create#moqui.security.UserGroup", {userGroupId: id, description: "People approvals " + kind})
    for (const permission of permissions)
        call("create#moqui.security.UserGroupPermission", {userGroupId: id, userPermissionId: permission, fromDate: since})
    if (!partyId) {
        partyId = person("USER_" + kind)
        for (const organizationPartyId of organizationPartyIds)
            call("create#mantle.party.PartyRelationship", {
                relationshipTypeEnumId: "PrtAgent",
                fromPartyId: partyId,
                toPartyId: organizationPartyId,
                toRoleTypeId: "OrgInternal",
                fromDate: since
            })
    }
    call("create#moqui.security.UserAccount", {
        userId: id,
        username: id,
        partyId,
        currentPassword: "16ac58bbfa332c1c55bd98b53e60720bfa90d394",
        passwordHashType: "SHA",
        timeZone: ec.user.userAccount?.timeZone || "America/Chicago"
    })
    call("create#moqui.security.UserGroupMember", {userId: id, userGroupId: id, fromDate: since})
    return id
}
const approverIds = step => (step?.approverPartyIds || []).join(",")
const route = (parameters, username = state.admin) =>
    run(
        username,
        A + "resolve#Approvers",
        Object.assign({organizationPartyId: orgA, approvalKindEnumId: "PakPosition"}, parameters)
    )
const policy = (parameters, username = state.admin) =>
    run(
        username,
        A + "store#Policy",
        Object.assign({organizationPartyId: orgA, approvalKindEnumId: "PakPosition", fromDate: since}, parameters)
    )
// a planned seat of A in the department, as HR, and its revision
function seat(departmentPartyId, name) {
    const created = run(state.hr, S + "store#Position", {
        organizationPartyId: orgA,
        departmentPartyId,
        emplPositionClassId: state.classId,
        description: name
    })
    return {emplPositionId: created.emplPositionId, revision: created.revision}
}
const positionOf = emplPositionId => run(state.hr, S + "get#Position", {emplPositionId})
// the unread PeoplePositionApproval notices of a position, by user
function notices(emplPositionId) {
    const messageIds = Array.from(
        ec.entity
            .find("moqui.security.user.NotificationMessage")
            .condition({topic: "PeoplePositionApproval", recordId: emplPositionId})
            .disableAuthz()
            .list()
    ).map(row => row.notificationMessageId)
    if (!messageIds.length) return {}
    const found = {}
    for (const row of Array.from(
        ec.entity
            .find("moqui.security.user.NotificationMessageUser")
            .condition("notificationMessageId", "in", messageIds)
            .condition("viewedDate", "is-null", null)
            .disableAuthz()
            .list()
    ))
        found[row.userId] = row.notificationMessageId
    return found
}
const decisionCount = peopleApprovalId =>
    ec.entity.find("mantle.humanres.approval.PeopleApprovalDecision").condition({peopleApprovalId}).disableAuthz().count()

spec({
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        organization(orgA, "People Apr Spec A")
        organization(orgB, "People Apr Spec B")
        for (const kind of ["HEAD", "MGR", "WORKER", "APPROVER", "ALT", "FALLBACK", "HRO", "LEFT"])
            state[kind] = employ(person(kind), orgA)
        state.BETA = employ(person("BETA"), orgB)
        // the worker's manager at A
        call("create#mantle.party.PartyRelationship", {
            relationshipTypeEnumId: "PrtManager",
            fromPartyId: state.MGR,
            toPartyId: state.WORKER,
            fromDate: since
        })
        state.admin = user("ADMIN", ["PEOPLE_CONFIGURE", "PEOPLE_HR_VIEW"], [orgA])
        // HR decides steps as everyone does, with PEOPLE_REQUEST_APPROVE (the user's call, impl-people §4): it asks here, and may
        // not decide its own request
        state.hr = user("HR", ["PEOPLE_HR_VIEW", "PEOPLE_HR_EDIT", "PEOPLE_REQUEST_APPROVE"], [orgA])
        state.reader = user("READER", ["PEOPLE_DIRECTORY_VIEW"], [orgA])
        state.owner = user("OWNER", ["PEOPLE_APPROVAL_OWNER_CHANGE"], [orgA])
        const approve = ["PEOPLE_TEAM_VIEW", "PEOPLE_REQUEST_APPROVE"]
        for (const kind of ["HEAD", "MGR", "APPROVER", "ALT", "LEFT"]) state["u" + kind] = user(kind, approve, [], state[kind])
        state.uFALLBACK = user("FALLBACK", ["PEOPLE_HR_VIEW", "PEOPLE_HR_EDIT", "PEOPLE_REQUEST_APPROVE"], [], state.FALLBACK)
        // an HR editor of A without PEOPLE_REQUEST_APPROVE: decides no step, an HR-routed one included
        state.uHRO = user("HRO", ["PEOPLE_HR_VIEW", "PEOPLE_HR_EDIT"], [], state.HRO)
        // A's departments: Stores (led by HEAD) with Backroom under it (no lead); Office (led by HEAD); Lab (no lead); Yard (led
        // by HEAD); a team under Stores
        const unit = (unitKind, organizationName, parentPartyId, headPartyId = null) =>
            run(state.hr, O + "store#Unit", {unitKind, organizationName, parentPartyId, headPartyId, fromDate: since}).partyId
        state.stores = unit("department", "Stores", orgA, state.HEAD)
        state.backroom = unit("department", "Backroom", state.stores)
        state.office = unit("department", "Office", orgA, state.HEAD)
        state.lab = unit("department", "Lab", orgA)
        state.yard = unit("department", "Yard", orgA, state.HEAD)
        state.team = unit("team", "Floor", state.stores)
        state.depot = unit("department", "Depot", orgA)
        state.shed = unit("department", "Shed", orgA)
        state.classId = run(state.hr, S + "store#JobClass", {title: "Apr spec clerk"}).emplPositionClassId
    },
    cleanupSpec() {
        ec.message.clearErrors()
        login("john.doe")
    }
})

feature(
    "a request routes by the employee's override, the nearest department's rule, the employer's rule, else the manager; the alternate and the HR fallback take a step no one of its role may decide; the requester never decides",
    {
        when() {
            const out = {}
            // no rule: the worker's manager
            const none = route({subjectPartyId: state.WORKER})
            out.none = [none.basis, approverIds(none.steps[0]), none.steps[0].via]
            // the employer's rule: a named person
            const typeRule = policy({sequenceNum: 1, approverRoleEnumId: "ParPerson", approverPartyId: state.APPROVER})
            const typed = route({departmentPartyId: state.backroom, subjectPartyId: state.WORKER})
            out.type = [typed.basis, approverIds(typed.steps[0])]
            // Stores' rule, the department head: Backroom has no lead, so its head is Stores' (HEAD)
            const storesRule = policy({departmentPartyId: state.stores, approverRoleEnumId: "ParDepartmentHead"})
            const departmental = route({departmentPartyId: state.backroom, subjectPartyId: state.WORKER})
            out.department = [departmental.basis, approverIds(departmental.steps[0]), departmental.steps[0].explanation]
            // the worker's override
            const overrideRule = policy({
                employeePartyId: state.WORKER,
                approverRoleEnumId: "ParPerson",
                approverPartyId: state.ALT
            })
            const overridden = route({departmentPartyId: state.backroom, subjectPartyId: state.WORKER})
            out.employee = [overridden.basis, approverIds(overridden.steps[0])]
            // HEAD asks: the head may not decide their own request; no alternate and no fallback, so it waits
            const own = route({departmentPartyId: state.stores, requesterPartyId: state.HEAD})
            out.own = [approverIds(own.steps[0]), own.steps[0].via, own.unresolved, own.steps[0].explanation]
            // the HR fallback takes it, then the step's alternate before the fallback
            const fallbackRule = policy({approverRoleEnumId: "ParHrFallback", approverPartyId: state.FALLBACK})
            const fellBack = route({departmentPartyId: state.stores, requesterPartyId: state.HEAD})
            out.fallback = [approverIds(fellBack.steps[0]), fellBack.steps[0].via]
            const withAlternate = policy({
                peopleApprovalPolicyId: storesRule.peopleApprovalPolicyId,
                alternatePartyId: state.MGR,
                fromDate: null,
                expectedRevision: storesRule.revision,
                changeReason: "Cover for the head"
            })
            const alternated = route({departmentPartyId: state.stores, requesterPartyId: state.HEAD})
            out.alternate = [approverIds(alternated.steps[0]), alternated.steps[0].via]
            out.refusals = {
                hr: code(policy({approverRoleEnumId: "ParManager", sequenceNum: 2}, state.hr)),
                other: code(policy({organizationPartyId: orgB, approverRoleEnumId: "ParManager"})),
                team: code(policy({departmentPartyId: state.team, approverRoleEnumId: "ParManager"})),
                person: code(policy({approverRoleEnumId: "ParPerson", sequenceNum: 3})),
                outsider: code(policy({approverRoleEnumId: "ParPerson", sequenceNum: 3, approverPartyId: state.BETA})),
                self: code(policy({employeePartyId: state.MGR, approverRoleEnumId: "ParPerson", approverPartyId: state.MGR})),
                step: code(policy({sequenceNum: 1, approverRoleEnumId: "ParManager"})),
                revision: code(
                    policy({
                        peopleApprovalPolicyId: storesRule.peopleApprovalPolicyId,
                        alternatePartyId: "",
                        expectedRevision: "0"
                    })
                ),
                reader: code(route({departmentPartyId: state.stores}, state.reader))
            }
            // the rows in effect, and the alternate's change dated with the row before it ended
            const listed = run(state.hr, A + "find#Policies", {organizationPartyId: orgA, approvalKindEnumId: "PakPosition"})
            out.listed = listed.policies.map(row => [row.scopeText, row.stepText, row.roleText, row.alternateName])
            out.canEdit = listed.policies.some(row => row.canEdit)
            out.history = run(state.admin, A + "find#Policies", {organizationPartyId: orgA, includeEnded: true}).policiesCount
            // the employer's rule, the override and the fallback end, so the requests below route by department
            const end = row =>
                code(
                    policy({
                        peopleApprovalPolicyId: row.peopleApprovalPolicyId,
                        thruDate: ec.user.nowTimestamp,
                        expectedRevision: row.revision
                    })
                )
            // an end dated in the past is from now: the period the rule was in effect stays as it was
            const before = ec.user.timestampMillis(ec.user.nowTimestamp) - 1000
            const backdated = code(
                policy({
                    peopleApprovalPolicyId: overrideRule.peopleApprovalPolicyId,
                    thruDate: "2001-01-01T00:00:00Z",
                    expectedRevision: overrideRule.revision
                })
            )
            const overrideEnd = ec.entity
                .find("mantle.humanres.approval.PeopleApprovalPolicy")
                .condition("peopleApprovalPolicyId", overrideRule.peopleApprovalPolicyId)
                .disableAuthz()
                .one().thruDate
            out.ended = [end(typeRule), backdated, end(fallbackRule)]
            out.overrideEndedNow = ec.user.timestampMillis(overrideEnd) >= before
            out.storesRule = withAlternate.peopleApprovalPolicyId
            return out
        },
        then({
            none,
            type,
            department,
            employee,
            own,
            fallback,
            alternate,
            refusals,
            listed,
            canEdit,
            history,
            ended,
            overrideEndedNow
        }) {
            none == ["default", state.MGR, "route"]
            type == ["type", state.APPROVER]
            department == ["department", state.HEAD, "Department head of Stores: Apr HEAD"]
            employee == ["employee", state.ALT]
            own[0] == ""
            own[1] == null
            own[2] == true
            own[3] ==
                "Department head of Stores: Apr HEAD may not decide their own request; no one may decide, so the request waits"
            fallback == [state.FALLBACK, "fallback"]
            alternate == [state.MGR, "alternate"]
            refusals ==
                {
                    hr: "PERMISSION_DENIED",
                    other: "ORGANIZATION_DENIED",
                    team: "NOT_A_DEPARTMENT",
                    person: "APPROVER_REQUIRED",
                    outsider: "NOT_EMPLOYED",
                    self: "SELF_APPROVAL",
                    step: "STEP_EXISTS",
                    revision: "REVISION_CHANGED",
                    reader: "PERMISSION_DENIED"
                }
            listed ==
                [
                    ["Department Stores", "Step 1", "Department head", "Apr MGR"],
                    ["Employee Apr WORKER", "Step 1", "Named person", ""],
                    ["Whole employer", "Step 1", "Named person", ""],
                    ["Whole employer", "Fallback", "HR fallback", ""]
                ]
            canEdit == false
            history == 5
            ended == ["", "", ""]
            overrideEndedNow == true
        }
    }
)

feature(
    "HR asks for a seat's activation and may not decide it; its department head approves it from the notice, which activates it, and the same decision retried answers the first",
    {
        when() {
            policy({departmentPartyId: state.office, approverRoleEnumId: "ParDepartmentHead"})
            const position = seat(state.office, "Office clerk")
            const ask = (parameters = {}) =>
                run(
                    state.hr,
                    S + "request#PositionApproval",
                    Object.assign(
                        {
                            emplPositionId: position.emplPositionId,
                            expectedRevision: position.revision,
                            justification: "Front desk cover",
                            operationKey: "APR-SPEC-1"
                        },
                        parameters
                    )
                )
            const refusals = {
                justification: code(ask({justification: " ", operationKey: null})),
                revision: code(ask({expectedRevision: "0", operationKey: null})),
                reader: code(run(state.reader, S + "request#PositionApproval", {emplPositionId: position.emplPositionId}))
            }
            const requested = ask()
            const retried = ask()
            const again = code(ask({operationKey: "APR-SPEC-2"}))
            const waiting = notices(position.emplPositionId)
            // P8: the decision waits on the department head alone (find#DueWork's decision), and the requester reads it among
            // their own requests with who decides it
            const dueOf = username =>
                (run(username, "mantle.humanres.PeopleServices.find#DueWork", {kinds: "decision"}).dueWork || [])
                    .filter(row => row.sourceId === position.emplPositionId)
                    .map(row => row.title)
            const due = {head: dueOf(state.uHEAD), other: dueOf(state.uAPPROVER)}
            const mine = (run(state.hr, "mantle.humanres.PeopleServices.find#MyRequests").requests || [])
                .filter(row => row.sourceId === position.emplPositionId)
                .map(row => [row.statusText, row.nextApproverText].join(" | "))
            const message = ec.entity
                .find("moqui.security.user.NotificationMessage")
                .condition("notificationMessageId", waiting[state.uHEAD])
                .disableAuthz()
                .one()
            const decide = (username, parameters = {}) =>
                code(
                    run(
                        username,
                        S + "decide#PositionApproval",
                        Object.assign({emplPositionId: position.emplPositionId}, parameters)
                    )
                )
            const deciders = {
                hr: decide(state.hr),
                other: decide(state.uAPPROVER),
                reader: decide(state.reader),
                noReason: decide(state.uHEAD, {decision: "refuse"})
            }
            const approved = run(state.uHEAD, NOTIFY + "approve#NotificationMessage", {
                notificationMessageId: waiting[state.uHEAD]
            })
            const afterApprove = positionOf(position.emplPositionId)
            const retriedDecision = run(state.uHEAD, NOTIFY + "approve#NotificationMessage", {
                notificationMessageId: waiting[state.uHEAD]
            })
            const direct = run(state.uHEAD, S + "decide#PositionApproval", {emplPositionId: position.emplPositionId})
            due.after = dueOf(state.uHEAD)
            return {
                due,
                mine,
                refusals,
                requested: [requested.error, requested.statusId, requested.unresolved, requested.waitingText],
                retried: [retried.peopleApprovalId === requested.peopleApprovalId, retried.repeated],
                again,
                notified: Object.keys(waiting),
                title: message?.titleText || message?.title || "",
                deciders,
                approved: approved.error,
                position: [
                    afterApprove.position.statusId,
                    afterApprove.approval.statusId,
                    afterApprove.position.canRequestApproval
                ],
                decisions: afterApprove.approval.decisions.map(row => [row.decidedByName, row.decisionText]),
                retriedDecision: retriedDecision.error,
                direct: [direct.error, direct.repeated, direct.activated],
                count: decisionCount(requested.peopleApprovalId),
                unread: Object.keys(notices(position.emplPositionId))
            }
        },
        then({
            due,
            mine,
            refusals,
            requested,
            retried,
            again,
            notified,
            title,
            deciders,
            approved,
            position,
            decisions,
            retriedDecision,
            direct,
            count,
            unread
        }) {
            refusals == {justification: "JUSTIFICATION_REQUIRED", revision: "REVISION_CHANGED", reader: "PERMISSION_DENIED"}
            requested == ["", "PapPending", false, "Waiting for Apr HEAD"]
            retried == [true, true]
            again == "APPROVAL_PENDING"
            notified == [state.uHEAD]
            title.includes("Office clerk")
            deciders == {hr: "SELF_APPROVAL", other: "NOT_APPROVER", reader: "PERMISSION_DENIED", noReason: "REASON_REQUIRED"}
            approved == ""
            position == ["EmpsActive", "PapApproved", false]
            decisions == [["Apr HEAD", "Approved"]]
            retriedDecision == ""
            direct == ["", true, false]
            count == 1
            unread == []
            due == {head: ["Approve position Office clerk"], other: [], after: []}
            mine == ["Waiting | Apr HEAD"]
        }
    }
)

feature("new terms supersede a waiting request and its notice; a decision on a source changed since the request is refused", {
    when() {
        const position = seat(state.office, "Office runner")
        const requested = run(state.hr, S + "request#PositionApproval", {
            emplPositionId: position.emplPositionId,
            expectedRevision: position.revision,
            justification: "Mail and errands"
        })
        const firstNotice = notices(position.emplPositionId)[state.uHEAD]
        const changed = run(state.hr, S + "store#Position", {
            emplPositionId: position.emplPositionId,
            expectedRevision: position.revision,
            standardHoursPerWeek: "20"
        })
        const superseded = positionOf(position.emplPositionId)
        const onOldNotice = code(run(state.uHEAD, NOTIFY + "approve#NotificationMessage", {notificationMessageId: firstNotice}))
        // asked again at the new terms, then the seat changed by another writer: the decision is refused and the seat stays planned
        const again = run(state.hr, S + "request#PositionApproval", {
            emplPositionId: position.emplPositionId,
            expectedRevision: changed.revision,
            justification: "Mail and errands, part time"
        })
        call("update#mantle.humanres.position.EmplPosition", {emplPositionId: position.emplPositionId, standardHoursPerWeek: 24})
        const changedSince = code(run(state.uHEAD, S + "decide#PositionApproval", {emplPositionId: position.emplPositionId}))
        const after = positionOf(position.emplPositionId)
        return {
            superseded: [superseded.approval.statusId, superseded.position.canRequestApproval],
            onOldNotice,
            again: [again.error, again.peopleApprovalId !== requested.peopleApprovalId],
            changedSince,
            after: [after.position.statusId, after.approval.statusId, after.approval.waiting]
        }
    },
    then({superseded, onOldNotice, again, changedSince, after}) {
        superseded == ["PapSuperseded", true]
        onOldNotice == "NOT_PENDING"
        again == ["", true]
        changedSince == "SOURCE_CHANGED"
        after == ["EmpsPlanned", "PapSuperseded", false]
    }
})

feature("a request no one may decide waits, approved by no one, and is sent once its rule names an alternate", {
    when() {
        const labRule = policy({departmentPartyId: state.lab, approverRoleEnumId: "ParDepartmentHead"})
        const position = seat(state.lab, "Lab tech")
        const requested = run(state.hr, S + "request#PositionApproval", {
            emplPositionId: position.emplPositionId,
            expectedRevision: position.revision,
            justification: "Testing"
        })
        const waiting = {
            unread: notices(position.emplPositionId),
            head: code(run(state.uHEAD, S + "decide#PositionApproval", {emplPositionId: position.emplPositionId})),
            position: positionOf(position.emplPositionId)
        }
        policy({
            peopleApprovalPolicyId: labRule.peopleApprovalPolicyId,
            alternatePartyId: state.APPROVER,
            expectedRevision: labRule.revision
        })
        const sent = Object.keys(notices(position.emplPositionId))
        const decided = run(state.uAPPROVER, S + "decide#PositionApproval", {emplPositionId: position.emplPositionId})
        return {
            requested: [requested.statusId, requested.unresolved, requested.waitingText],
            waiting: [
                Object.keys(waiting.unread),
                waiting.head,
                waiting.position.position.statusId,
                waiting.position.approval.waiting
            ],
            sent,
            decided: [decided.error, decided.activated, decided.positionStatusId]
        }
    },
    then({requested, waiting, sent, decided}) {
        requested == ["PapPending", true, "Waiting: no one may decide one approval yet"]
        waiting == [[], "NOT_APPROVER", "EmpsPlanned", true]
        sent == [state.uAPPROVER]
        decided == ["", true, "EmpsActive"]
    }
})

feature("a two-step rule needs each step, decided by another approver; a refusal needs its reason and leaves the seat planned", {
    when() {
        policy({departmentPartyId: state.yard, sequenceNum: 1, approverRoleEnumId: "ParDepartmentHead"})
        policy({departmentPartyId: state.yard, sequenceNum: 2, approverRoleEnumId: "ParPerson", approverPartyId: state.APPROVER})
        const position = seat(state.yard, "Yard hand")
        const requested = run(state.hr, S + "request#PositionApproval", {
            emplPositionId: position.emplPositionId,
            expectedRevision: position.revision,
            justification: "Deliveries"
        })
        const decide = (username, parameters = {}) =>
            run(username, S + "decide#PositionApproval", Object.assign({emplPositionId: position.emplPositionId}, parameters))
        const early = code(decide(state.uAPPROVER))
        const first = decide(state.uHEAD)
        const afterFirst = positionOf(position.emplPositionId)
        const firstAgain = decide(state.uHEAD)
        const countAfterRetry = decisionCount(requested.peopleApprovalId)
        const next = Object.keys(notices(position.emplPositionId))
        const noReason = code(decide(state.uAPPROVER, {decision: "refuse"}))
        const refused = decide(state.uAPPROVER, {decision: "refuse", reason: "No budget this year"})
        const after = positionOf(position.emplPositionId)
        return {
            early,
            first: [first.error, first.statusId, first.activated],
            steps: afterFirst.approval.steps.map(step => [step.stepText, step.stateText, step.approverNames]),
            firstAgain: [firstAgain.error, firstAgain.repeated, countAfterRetry],
            next,
            noReason,
            refused: [refused.error, refused.statusId, refused.positionStatusId],
            after: [after.approval.statusText, after.approval.decisions.map(row => [row.decisionText, row.reason])],
            unread: Object.keys(notices(position.emplPositionId))
        }
    },
    then({early, first, steps, firstAgain, next, noReason, refused, after, unread}) {
        early == "NOT_APPROVER"
        first == ["", "PapPending", false]
        steps ==
            [
                ["Step 1 of 2", "Approved", "Apr HEAD"],
                ["Step 2 of 2", "Waiting", "Apr APPROVER"]
            ]
        firstAgain == ["", true, 1]
        next == [state.uAPPROVER]
        noReason == "REASON_REQUIRED"
        refused == ["", "PapRefused", "EmpsPlanned"]
        after ==
            [
                "Refused",
                [
                    ["Approved", ""],
                    ["Refused", "No budget this year"]
                ]
            ]
        unread == []
    }
})

feature(
    "People's vocabularies are a whitelist; a value is added, renamed and ended, never deleted, and an ended one is listed only when asked",
    {
        when() {
            const store = (parameters, username = state.admin) => run(username, P + "store#Lookup", parameters)
            const families = run(state.hr, P + "find#Lookups", {}).families.map(row => row.enumTypeId)
            const added = store({enumTypeId: "TerminationReason", description: "Apr spec relocation", sequenceNum: "5"})
            const refusals = {
                family: code(store({enumTypeId: "PeopleApproverRole", description: "Anyone"})),
                duplicate: code(store({enumTypeId: "TerminationReason", description: "APR SPEC RELOCATION"})),
                hr: code(store({enumTypeId: "TerminationReason", description: "Apr spec other"}, state.hr)),
                reader: code(run(state.reader, P + "find#Lookups", {enumTypeId: "TerminationReason"})),
                sequence: code(store({enumTypeId: "TerminationReason", description: "Apr spec x", sequenceNum: "x"}))
            }
            const renamed = store({
                enumTypeId: "TerminationReason",
                enumId: added.enumId,
                description: "Apr spec moved away",
                expectedRevision: added.revision
            })
            const ended = store({
                enumTypeId: "TerminationReason",
                enumId: added.enumId,
                end: true,
                expectedRevision: renamed.revision
            })
            const listed = names =>
                run(state.hr, P + "find#Lookups", Object.assign({enumTypeId: "TerminationReason"}, names))
                    .values.filter(row => row.enumId === added.enumId)
                    .map(row => [row.description, row.ended, row.canEdit])
            const levels = run(state.admin, P + "find#Lookups", {enumTypeId: "SkillLevel"}).values.map(row => row.enumCode)
            // an ended skill type is required by no new job class (the user's call: People's choices leave ended values out)
            const skill = store({enumTypeId: "SkillType", description: "Apr spec forklift"})
            store({enumTypeId: "SkillType", enumId: skill.enumId, end: true, expectedRevision: skill.revision})
            const endedSkill = code(
                run(state.hr, S + "store#JobRequirement", {emplPositionClassId: state.classId, skillTypeEnumId: skill.enumId})
            )
            return {
                endedSkill,
                families,
                refusals,
                renamed: renamed.error,
                ended: ended.error,
                afterEnd: code(
                    store({
                        enumTypeId: "TerminationReason",
                        enumId: added.enumId,
                        description: "Again",
                        expectedRevision: ended.revision
                    })
                ),
                current: listed({}),
                withEnded: listed({includeEnded: true}),
                kept: ec.entity.find("moqui.basic.Enumeration").condition("enumId", added.enumId).disableAuthz().count(),
                levels
            }
        },
        then({families, refusals, renamed, ended, afterEnd, current, withEnded, kept, levels, endedSkill}) {
            families ==
                ["TerminationReason", "TerminationType", "SkillType", "SkillLevel", "PeopleLeaveType", "QualificationType"]
            refusals ==
                {
                    family: "FAMILY_INVALID",
                    duplicate: "DUPLICATE_VALUE",
                    hr: "PERMISSION_DENIED",
                    reader: "PERMISSION_DENIED",
                    sequence: "SEQUENCE_INVALID"
                }
            renamed == ""
            ended == ""
            afterEnd == "VALUE_ENDED"
            current == []
            withEnded == [["Apr spec moved away", true, false]]
            kept == 1
            levels == ["1", "2", "3", "4", "5"]
            endedSkill == "VALUE_ENDED"
        }
    }
)

feature("offboarding lists the rules and waiting requests that name a person and hands a rule to a new approver", {
    when() {
        const position = seat(state.lab, "Lab assistant")
        run(state.hr, S + "request#PositionApproval", {
            emplPositionId: position.emplPositionId,
            expectedRevision: position.revision,
            justification: "Samples"
        })
        const owned = username => run(state.owner, A + "find#OwnedApprovals", {userId: username}).resourceList || []
        const before = owned(state.uAPPROVER)
        const rule = before.find(row => row.resourceId.startsWith("policy:") && row.note === "Alternate")
        const request = before.find(row => row.resourceId.startsWith("approval:"))
        const transfer = (resourceId, username = state.owner) =>
            code(
                run(username, A + "transfer#ApprovalOwner", {
                    fromUserId: state.uAPPROVER,
                    toUserId: state.uALT,
                    approvalResourceId: resourceId,
                    reason: "Leaving"
                })
            )
        const refusals = {
            other: code(run(state.hr, A + "find#OwnedApprovals", {userId: state.uAPPROVER})),
            request: transfer(request.resourceId),
            notOwner: transfer(rule.resourceId, state.hr),
            // the approver alone does not choose who decides in their place
            self: transfer(rule.resourceId, state.uAPPROVER)
        }
        const moved = transfer(rule.resourceId)
        return {
            before: before.map(row => [row.resourceKind, row.transferable]).sort(),
            requestName: request.resourceName,
            refusals,
            moved,
            after: owned(state.uAPPROVER).filter(row => row.resourceId === rule.resourceId).length,
            alternate: owned(state.uALT).filter(row => row.resourceKind === "approvalRule" && row.note === "Alternate").length,
            sent: Object.keys(notices(position.emplPositionId))
        }
    },
    then({before, requestName, refusals, moved, after, alternate, sent}) {
        before ==
            [
                ["approval", false],
                ["approvalRule", true],
                ["approvalRule", true]
            ]
        requestName == "Position activation: position Lab assistant"
        refusals ==
            {other: "PERMISSION_DENIED", request: "NOT_TRANSFERABLE", notOwner: "PERMISSION_DENIED", self: "PERMISSION_DENIED"}
        moved == ""
        after == 0
        alternate == 1
        sent == [state.uALT]
    }
})

feature(
    "an HR-routed step is decided only with PEOPLE_REQUEST_APPROVE; one who no longer works for the employer decides nothing",
    {
        when() {
            // Depot: decided by HR, its designated officer an HR editor without PEOPLE_REQUEST_APPROVE, so the request waits
            policy({departmentPartyId: state.depot, approverRoleEnumId: "ParHr", approverPartyId: state.HRO})
            const depotSeat = seat(state.depot, "Depot clerk")
            const depot = run(state.hr, S + "request#PositionApproval", {
                emplPositionId: depotSeat.emplPositionId,
                expectedRevision: depotSeat.revision,
                justification: "Stock"
            })
            const hrDecision = code(run(state.uHRO, S + "decide#PositionApproval", {emplPositionId: depotSeat.emplPositionId}))
            // Shed: a named approver who then leaves A (the employment ends), so the step goes to its alternate
            policy({
                departmentPartyId: state.shed,
                approverRoleEnumId: "ParPerson",
                approverPartyId: state.LEFT,
                alternatePartyId: state.ALT
            })
            const before = route({departmentPartyId: state.shed})
            const employment = ec.entity
                .find("mantle.party.PartyRelationship")
                .condition({relationshipTypeEnumId: "PrtEmployee", fromPartyId: state.LEFT, toPartyId: orgA})
                .disableAuthz()
                .one()
            call("update#mantle.party.PartyRelationship", {
                partyRelationshipId: employment.partyRelationshipId,
                thruDate: ec.user.nowTimestamp
            })
            const after = route({departmentPartyId: state.shed})
            const shedSeat = seat(state.shed, "Shed hand")
            run(state.hr, S + "request#PositionApproval", {
                emplPositionId: shedSeat.emplPositionId,
                expectedRevision: shedSeat.revision,
                justification: "Loading"
            })
            return {
                depot: [depot.statusId, depot.unresolved],
                hrDecision,
                before: [approverIds(before.steps[0]), before.steps[0].via],
                after: [approverIds(after.steps[0]), after.steps[0].via],
                leaverDecision: code(run(state.uLEFT, S + "decide#PositionApproval", {emplPositionId: shedSeat.emplPositionId})),
                sent: Object.keys(notices(shedSeat.emplPositionId))
            }
        },
        then({depot, hrDecision, before, after, leaverDecision, sent}) {
            depot == ["PapPending", true]
            hrDecision == "PERMISSION_DENIED"
            before == [state.LEFT, "route"]
            after == [state.ALT, "alternate"]
            leaverDecision == "NOT_APPROVER"
            sent == [state.uALT]
        }
    }
)
