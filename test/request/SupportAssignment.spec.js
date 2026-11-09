// Case assignment (impl-customer-service P5: CS-ASSIGNMENT; mantle.request.SupportCaseServices assign#Case,
// save#AssignmentRule, preview#Assignment, save#ServiceTeamMember's participation, sync#ServiceTeamGroup; Assignment.js):
// a queue with no rule assigns nothing (P2's default); the rule saves with their typed conditions and refusals, a draft
// changed in place and a published rule replaced by a new row; round robin skipping the agent outside their hours (P4's
// business time on the agent's calendar); a condition sending a case to another rule;
// two concurrent intakes taking two slots under the cursor's lock; no eligible agent leaving the case unassigned and telling
// the team's manager, and the rule's fallback; a move into another queue reassigning by its rule and keeping the clocks;
// preview through the same evaluator; the participation refusals and the team's user group following its members.
// Standalone: spec-local organizations, customers, groups and users. Run: ./moq test mr-mantle --spec SupportAssignment
const prefix = "SAS"
const org = prefix + "_ORG",
    otherOrg = prefix + "_OTHER_ORG",
    customer = prefix + "_CUST",
    zone = "America/Chicago",
    since = "2000-01-01T00:00:00Z"
const S = "mantle.request.SupportCaseServices.",
    L = "mantle.request.SlaServices."
const chicago = (day, clock) => new Date(Date.parse(day + "T" + clock + ":00-06:00")).getTime()
const find = (entity, conditions = {}) => ec.entity.find(entity).condition(conditions).disableAuthz()
const one = (entity, conditions) => find(entity, conditions).one()
const rows = (entity, conditions) => Array.from(find(entity, conditions).list())
const state = {}

function run(username, service, parameters) {
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
const code = out => (/([A-Z][A-Z0-9_]+):/.exec(out.error || "") || [])[1] || (out.error ? "ERROR" : "")
function user(kind, permissions, organizationPartyId = org) {
    const id = prefix + "_" + kind
    call("create#moqui.security.UserGroup", {userGroupId: id, description: "Assignment " + kind})
    for (const permission of permissions)
        call("create#moqui.security.UserGroupPermission", {userGroupId: id, userPermissionId: permission, fromDate: since})
    call("create#mantle.party.Party", {partyId: id, partyTypeEnumId: "PtyPerson"})
    call("create#mantle.party.Person", {partyId: id, firstName: "Assign", lastName: kind})
    call("create#mantle.party.PartyRelationship", {
        relationshipTypeEnumId: "PrtAgent",
        fromPartyId: id,
        toPartyId: organizationPartyId,
        toRoleTypeId: "OrgInternal",
        fromDate: since
    })
    call("create#moqui.security.UserAccount", {
        userId: id,
        username: id,
        partyId: id,
        currentPassword: "16ac58bbfa332c1c55bd98b53e60720bfa90d394",
        passwordHashType: "SHA",
        timeZone: zone
    })
    call("create#moqui.security.UserGroupMember", {userId: id, userGroupId: id, fromDate: since})
    return id
}
function party(partyId, name, roleTypeId, ownerPartyId) {
    call("create#mantle.party.Party", {partyId, partyTypeEnumId: "PtyOrganization", ownerPartyId: ownerPartyId || "_NA_"})
    call("create#mantle.party.Organization", {partyId, organizationName: name})
    if (roleTypeId) call("create#mantle.party.PartyRole", {partyId, roleTypeId})
}
const team = name => run(state.admin, S + "save#ServiceTeam", {organizationPartyId: org, teamName: name}).teamPartyId
const join = (teamPartyId, partyId, roleTypeId = "Agent") =>
    run(state.admin, S + "save#ServiceTeamMember", {teamPartyId, partyId, roleTypeId})
const queue = (description, teamPartyId) =>
    run(state.admin, S + "save#ServiceQueue", {organizationPartyId: org, description, responsibleTeamPartyId: teamPartyId})
        .requestCategoryId
// a case made through create#Case (its rules run in the same call), with its assignee
function newCase(requestCategoryId, fields = {}) {
    const out = run(
        state.admin,
        S + "create#Case",
        Object.assign({organizationPartyId: org, customerPartyId: customer, requestCategoryId, requestName: "Spec case"}, fields)
    )
    assert(!out.error, out.error)
    return out.requestId
}
const assigneeOf = requestId =>
    rows("mantle.request.RequestParty", {requestId, roleTypeId: "Assignee"}).filter(row => !row.thruDate)[0]?.partyId || null
const now = (day, clockText) => ec.user.setEffectiveTime(chicago(day, clockText))

spec({
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        // Date-effective defaults and rules must exist before the scenarios advance into their November dates.
        now("2026-11-02", "00:00")
        party(org, "Assignment Spec Org", "OrgInternal")
        party(otherOrg, "Assignment Spec Other Org", "OrgInternal")
        party(customer, "Assignment Spec Customer", "Customer", org)
        state.admin = user("ADMIN", ["SUPPORT_POLICY_EDIT", "SUPPORT_CASE_MANAGE", "SUPPORT_CASE_EDIT", "WORKING_HOURS_EDIT"])
        state.manager = user("MANAGER", ["SUPPORT_CASE_MANAGE", "SUPPORT_CASE_EDIT"])
        state.agent1 = user("AGENT1", ["SUPPORT_CASE_EDIT"])
        state.agent2 = user("AGENT2", ["SUPPORT_CASE_EDIT"])
        state.agent3 = user("AGENT3", ["SUPPORT_CASE_EDIT"])
        state.otherAdmin = user("OTHER_ADMIN", ["SUPPORT_POLICY_EDIT", "SUPPORT_CASE_MANAGE", "SUPPORT_CASE_EDIT"], otherOrg)
        state.team = team("Spec assignment team")
        for (const partyId of [state.agent1, state.agent2]) join(state.team, partyId)
        join(state.team, state.manager, "Manager")
        state.queue = queue("Spec assigned queue", state.team)
        state.plainQueue = queue("Spec queue with no rule", state.team)
        run(state.admin, S + "save#ServiceDefaults", {organizationPartyId: org, defaultCategoryId: state.queue})
        // agent 2 works Monday to Friday 9:00-17:00 in Chicago (a calendar of the organization their participation names);
        // agent 1 has no hours (around the clock)
        const calendarId = call("create#mantle.work.calendar.Calendar", {
            calendarName: "Agent 2's hours",
            ownerPartyId: org,
            calendarKindEnumId: "CalkResource",
            timeZone: zone
        }).calendarId
        const hours = run(state.admin, "mantle.work.CalendarServices.store#WorkingHours", {
            calendarId,
            workDays: "1,2,3,4,5",
            workStart: "09:00",
            workEnd: "17:00",
            timeZone: zone
        })
        assert(!hours.error, hours.error)
        const participation = run(state.admin, S + "save#ServiceTeamMember", {
            teamPartyId: state.team,
            partyId: state.agent2,
            participation: true,
            calendarId
        })
        assert(!participation.error, participation.error)
        state.otherQueue = run(state.otherAdmin, S + "save#ServiceQueue", {
            organizationPartyId: otherOrg,
            description: "Other"
        }).requestCategoryId
    },
    setup() {
        ec.artifactExecution.disableAuthz()
        now("2026-11-02", "00:00")
    },
    cleanup() {
        ec.user.setEffectiveTime(null)
        ec.artifactExecution.enableAuthz()
        login("john.doe")
    }
})

feature("a queue with no assignment rule assigns nothing (P2's default)", {
    when() {
        const requestId = newCase(state.plainQueue)
        return {assignee: assigneeOf(requestId), profile: one("mantle.request.support.CaseProfile", {requestId})}
    },
    then({assignee, profile}) {
        assignee == null
        profile.assignmentOutcomeEnumId == null
    }
})

feature("the rule saves: typed conditions and their refusals; a draft changes in place, a published rule is replaced", {
    when() {
        const rule = {organizationPartyId: org, requestCategoryId: state.queue, ruleName: "Spec round robin"}
        const agent = run(state.agent1, S + "save#AssignmentRule", rule)
        const unknownField = run(
            state.admin,
            S + "save#AssignmentRule",
            Object.assign({}, rule, {
                conditions: [{fieldEnumId: "AcfSubject", operatorEnumId: "AcoIs", conditionValue: "x"}]
            })
        )
        const wrongOperator = run(
            state.admin,
            S + "save#AssignmentRule",
            Object.assign({}, rule, {
                conditions: [{fieldEnumId: "AcfTag", operatorEnumId: "AcoAtMost", conditionValue: "RtgVip"}]
            })
        )
        const badValue = run(
            state.admin,
            S + "save#AssignmentRule",
            Object.assign({}, rule, {
                conditions: [{fieldEnumId: "AcfType", operatorEnumId: "AcoIs", conditionValue: "RtgVip"}]
            })
        )
        const badPriority = run(
            state.admin,
            S + "save#AssignmentRule",
            Object.assign({}, rule, {
                conditions: [{fieldEnumId: "AcfPriority", operatorEnumId: "AcoAtMost", conditionValue: "12"}]
            })
        )
        const otherQueue = run(
            state.admin,
            S + "save#AssignmentRule",
            Object.assign({}, rule, {requestCategoryId: state.otherQueue})
        )
        const otherOrg = run(state.otherAdmin, S + "save#AssignmentRule", rule)
        const outsider = run(state.admin, S + "save#AssignmentRule", Object.assign({}, rule, {eligiblePartyIds: state.agent3}))
        // a draft, its condition added in place, then published; then a change of the published rule
        const draft = run(state.admin, S + "save#AssignmentRule", Object.assign({}, rule, {draft: true, sequenceNum: 20}))
        const added = run(state.admin, S + "save#AssignmentRule", {
            assignmentRuleId: draft.assignmentRuleId,
            draft: true,
            conditionAction: "add",
            fieldEnumId: "AcfPriority",
            operatorEnumId: "AcoAtLeast",
            conditionValue: "3"
        })
        const published = run(state.admin, S + "save#AssignmentRule", {assignmentRuleId: draft.assignmentRuleId})
        const replaced = run(state.admin, S + "save#AssignmentRule", {
            assignmentRuleId: draft.assignmentRuleId,
            conditionAction: "update",
            conditionSeqId: "01",
            fieldEnumId: "AcfPriority",
            operatorEnumId: "AcoAtLeast",
            conditionValue: "1"
        })
        state.rule = replaced.assignmentRuleId
        const first = one("mantle.request.support.ServiceAssignmentRule", {assignmentRuleId: draft.assignmentRuleId})
        const second = one("mantle.request.support.ServiceAssignmentRule", {assignmentRuleId: replaced.assignmentRuleId})
        return {
            agent,
            unknownField,
            wrongOperator,
            badValue,
            badPriority,
            otherQueue,
            otherOrg,
            outsider,
            sameDraft: added.assignmentRuleId == draft.assignmentRuleId,
            published,
            first,
            second,
            conditions: rows("mantle.request.support.ServiceAssignmentCondition", {assignmentRuleId: replaced.assignmentRuleId}),
            cursor: one("mantle.request.support.ServiceAssignmentCursor", {rootRuleId: draft.assignmentRuleId})
        }
    },
    then(r) {
        code(r.agent) == "PERMISSION_DENIED"
        code(r.unknownField) == "CONDITION_FIELD_UNKNOWN"
        code(r.wrongOperator) == "CONDITION_OPERATOR_INVALID"
        code(r.badValue) == "CONDITION_VALUE_INVALID"
        code(r.badPriority) == "CONDITION_VALUE_INVALID"
        code(r.otherQueue) == "QUEUE_UNAVAILABLE"
        code(r.otherOrg) == "RECORD_UNAVAILABLE"
        code(r.outsider) == "MEMBER_UNAVAILABLE"
        r.sameDraft == true
        r.published.error == ""
        r.first.thruDate != null
        r.second.previousRuleId == r.first.assignmentRuleId
        r.second.rootRuleId == r.first.assignmentRuleId
        r.second.thruDate == null
        r.conditions.length == 1
        r.conditions[0].conditionValue == "1"
        r.cursor != null
    }
})

feature("round robin skips the agent outside their hours and alternates in hours; no eligible agent tells the manager", {
    when() {
        // Sunday 03:00 in Chicago: agent 2 is outside their hours, agent 1 works around the clock
        now("2026-11-08", "03:00")
        const sunday = [newCase(state.queue), newCase(state.queue)].map(assigneeOf)
        const preview = run(state.admin, S + "preview#Assignment", {organizationPartyId: org, requestCategoryId: state.queue})
        // agent 1 not taking cases while agent 2 is out: no one, and the team's manager is told
        run(state.admin, S + "save#ServiceTeamMember", {
            teamPartyId: state.team,
            partyId: state.agent1,
            participation: true,
            assignmentEligible: "N"
        })
        const noOne = newCase(state.queue)
        run(state.admin, S + "save#ServiceTeamMember", {
            teamPartyId: state.team,
            partyId: state.agent1,
            participation: true,
            assignmentEligible: "Y"
        })
        // Monday 10:00: both in their hours, round robin alternates
        now("2026-11-09", "10:00")
        const monday = [newCase(state.queue), newCase(state.queue)].map(assigneeOf)
        return {
            sunday,
            preview,
            noOneAssignee: assigneeOf(noOne),
            noOneProfile: one("mantle.request.support.CaseProfile", {requestId: noOne}),
            told: rows("moqui.security.user.NotificationMessage", {topic: "SupportCaseUnassigned"}).filter(row =>
                String(row.messageJson || "").includes(noOne)
            ),
            monday
        }
    },
    then(r) {
        r.sunday == [state.agent1, state.agent1]
        r.preview.assigneePartyId == state.agent1
        r.preview.candidates.find(row => row.partyId == state.agent2).reason == "OUTSIDE_HOURS"
        r.noOneAssignee == null
        r.noOneProfile.assignmentOutcomeEnumId == "AoNoAgent"
        r.told.length == 1
        r.monday.includes(state.agent1)
        r.monday.includes(state.agent2)
    }
})

feature("a condition sends a case to the rule it matches; a rule's fallback takes a case no agent can", {
    when() {
        now("2026-11-09", "10:00")
        // an urgent-band rule first, for agent 2 only, at most one case more than they hold: its fallback is agent 1
        const held = find("mantle.request.support.CaseRequestParty", {partyId: state.agent2, roleTypeId: "Assignee"})
            .condition("thruDate", null)
            .condition("statusId", "in", ["ReqSubmitted", "ReqReviewed", "ReqInProgress", "ReqWaitingCustomer", "ReqOnHold"])
            .count()
        const urgent = run(state.admin, S + "save#AssignmentRule", {
            organizationPartyId: org,
            requestCategoryId: state.queue,
            ruleName: "Spec urgent",
            sequenceNum: 1,
            distributionEnumId: "AdLeastOpen",
            eligiblePartyIds: state.agent2,
            maxOpenCases: held + 1,
            fallbackPartyId: state.agent1,
            conditions: [{fieldEnumId: "AcfBand", operatorEnumId: "AcoIs", conditionValue: "CpbUrgent"}]
        })
        const first = newCase(state.queue, {priority: 1})
        const second = newCase(state.queue, {priority: 2})
        const normal = newCase(state.queue, {priority: 5})
        const result = {
            urgent,
            first: one("mantle.request.support.CaseProfile", {requestId: first}),
            firstAssignee: assigneeOf(first),
            second: one("mantle.request.support.CaseProfile", {requestId: second}),
            secondAssignee: assigneeOf(second),
            normal: one("mantle.request.support.CaseProfile", {requestId: normal})
        }
        run(state.admin, S + "save#AssignmentRule", {assignmentRuleId: urgent.assignmentRuleId, end: true})
        return result
    },
    then(r) {
        r.urgent.error == ""
        r.first.assignmentRuleId == r.urgent.assignmentRuleId
        r.firstAssignee == state.agent2
        r.second.assignmentOutcomeEnumId == "AoFallback"
        r.secondAssignee == state.agent1
        r.normal.assignmentRuleId == state.rule
    }
})

feature("two intakes at once take two slots: the rule's cursor is locked with the assignment", {
    when() {
        const parallelQueue = queue("Spec parallel queue", state.team)
        run(state.admin, S + "save#AssignmentRule", {
            organizationPartyId: org,
            requestCategoryId: parallelQueue,
            ruleName: "Spec parallel",
            distributionEnumId: "AdRoundRobin",
            respectSchedule: "N"
        })
        const made = parallel(
            2,
            (thread, args) => {
                ec.user.setEffectiveTime(args.fixtureTime)
                login(args.admin)
                ec.artifactExecution.disableAuthz()
                return call(args.service, {
                    organizationPartyId: args.org,
                    customerPartyId: args.customer,
                    requestCategoryId: args.queue,
                    requestName: "Parallel " + thread
                }).requestId
            },
            {admin: state.admin, service: S + "create#Case", org, customer, queue: parallelQueue,
                fixtureTime: chicago("2026-11-02", "00:00")},
            {transaction: false}
        )
        return {assignees: made.map(assigneeOf)}
    },
    then({assignees}) {
        assignees.length == 2
        assignees[0] != null
        assignees[1] != null
        assignees[0] != assignees[1]
    }
})

feature("a move into another queue reassigns the case by that queue's rule and keeps its clocks", {
    when() {
        now("2026-11-09", "10:00")
        run(state.admin, L + "save#Policy", {
            organizationPartyId: org,
            policyName: "Spec assignment level",
            fromDate: new Date(chicago("2026-11-01", "00:00")),
            targets: [{priorityBandEnumId: "CpbNormal", firstResponseMinutes: 240, resolutionMinutes: 960, warningMinutes: 60}]
        })
        const team2 = team("Spec second team")
        join(team2, state.agent3)
        const queue2 = queue("Spec second queue", team2)
        run(state.admin, S + "save#AssignmentRule", {
            organizationPartyId: org,
            requestCategoryId: queue2,
            ruleName: "Spec second"
        })
        const requestId = newCase(state.plainQueue, {assigneePartyId: state.agent1})
        const clocks = () =>
            rows("mantle.request.support.CaseSlaEpisode", {requestId}).map(row => row.caseSlaEpisodeId + "|" + row.dueDate)
        const before = clocks()
        const moved = run(state.agent1, S + "update#Case", {requestId, requestCategoryId: queue2})
        return {before, after: clocks(), moved, assignee: assigneeOf(requestId)}
    },
    then({before, after, moved, assignee}) {
        before.length > 0
        after == before
        moved.error == ""
        assignee == state.agent3
    }
})

feature("participation refusals; hours that start later are out of hours; the team's user group follows its members", {
    when() {
        const groupId = "SVT_" + state.team
        const members = () =>
            rows("moqui.security.UserGroupMember", {userGroupId: groupId})
                .filter(row => !row.thruDate)
                .map(row => row.userId)
                .sort()
        const before = members()
        const substitute = run(state.admin, S + "save#ServiceTeamMember", {
            teamPartyId: state.team,
            partyId: state.agent2,
            participation: true,
            substitutePartyId: state.agent3
        })
        const calendarId = call("create#mantle.work.calendar.Calendar", {
            calendarName: "Other org calendar",
            ownerPartyId: otherOrg,
            calendarKindEnumId: "CalkShared"
        }).calendarId
        const calendar = run(state.admin, S + "save#ServiceTeamMember", {
            teamPartyId: state.team,
            partyId: state.agent2,
            participation: true,
            calendarId
        })
        // hours that start in two weeks (Monday 23 November): on Monday 9 November agent 2 is out of hours, not around the clock
        now("2026-11-09", "11:00")
        const laterId = call("create#mantle.work.calendar.Calendar", {
            calendarName: "Agent 2's later hours",
            ownerPartyId: org,
            calendarKindEnumId: "CalkResource",
            timeZone: zone
        }).calendarId
        const laterHours = run(state.admin, "mantle.work.CalendarServices.store#WorkingHours", {
            calendarId: laterId,
            workDays: "1,2,3,4,5",
            workStart: "09:00",
            workEnd: "17:00",
            timeZone: zone,
            fromDate: new Date(chicago("2026-11-23", "00:00"))
        })
        assert(!laterHours.error, laterHours.error)
        run(state.admin, S + "save#ServiceTeamMember", {
            teamPartyId: state.team,
            partyId: state.agent2,
            participation: true,
            calendarId: laterId
        })
        const later = run(state.admin, S + "preview#Assignment", {organizationPartyId: org, requestCategoryId: state.queue})
        const max = run(state.admin, S + "save#ServiceTeamMember", {
            teamPartyId: state.team,
            partyId: state.agent2,
            participation: true,
            maxActiveCases: 3,
            substitutePartyId: state.agent1
        })
        join(state.team, state.agent3)
        const joined = members()
        run(state.admin, S + "save#ServiceTeamMember", {teamPartyId: state.team, partyId: state.agent3, end: true})
        return {
            before,
            substitute,
            calendar,
            max,
            later: later.candidates?.find(row => row.partyId == state.agent2)?.reason,
            joined,
            left: members(),
            // the organization's group: its teams' members and its service administrator, on no team (F131)
            organization: rows("moqui.security.UserGroupMember", {userGroupId: "SVO_" + org})
                .filter(row => !row.thruDate)
                .map(row => row.userId),
            group: one("moqui.security.UserGroup", {userGroupId: groupId}),
            participation: rows("mantle.request.support.ServiceTeamParticipation", {
                teamPartyId: state.team,
                partyId: state.agent2
            }).filter(row => !row.thruDate)
        }
    },
    then(r) {
        r.before == [state.agent1, state.agent2, state.manager].sort()
        code(r.substitute) == "SUBSTITUTE_UNAVAILABLE"
        code(r.calendar) == "CALENDAR_UNAVAILABLE"
        r.max.participationId != null
        r.later == "OUTSIDE_HOURS"
        r.joined.includes(state.agent3)
        !r.left.includes(state.agent3)
        r.organization.includes(state.admin)
        r.organization.includes(state.agent1)
        !r.organization.includes(state.otherAdmin)
        r.group.groupTypeEnumId == "UgtServiceTeam"
        r.participation.length == 1
        r.participation[0].maxActiveCases == 3
        r.participation[0].substitutePartyId == state.agent1
    }
})
