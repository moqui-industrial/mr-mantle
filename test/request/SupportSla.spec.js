// Service levels of support cases (impl-customer-service P4: CS-SLA, CS-JOBS, D23; F64, F83; mantle.request.SlaServices,
// Sla.js; the SupportCaseSla rules of entity/Request.eecas.xml): with no policy a case has no clocks, and a request that is
// not a case gets nothing from the rules (Mantle's default); the policy saves and their refusals (permission, targets,
// equal-rank overlap); selection by precedence (customer over the default) bound at intake, and a policy started later
// leaving an open case on its row; a case's clocks from intake on the team's working hours, the case's due date written by
// the clock; first response met by a sent reply only (a note, an acknowledgement and a send that failed do not); waiting for
// the customer pausing resolution until the customer replies, and an internal hold not; a status change by another path
// (the Request entity) recorded; a reopen starting a new resolution episode and keeping the first breach; a manager's
// correction keeping the earlier figure; the scan naming a failing clock and warning the rest; another organization's case
// refused. Standalone: spec-local organizations, customers, groups and users; the clock pinned from Friday 6 Nov 2026 16:30
// in Chicago. Run: ./moq test mr-mantle --spec SupportSla
const prefix = "SLA"
const org = prefix + "_ORG",
    otherOrg = prefix + "_OTHER_ORG",
    customer = prefix + "_CUST",
    vip = prefix + "_VIP",
    zone = "America/Chicago",
    since = "2000-01-01T00:00:00Z"
const S = "mantle.request.SupportCaseServices.",
    L = "mantle.request.SlaServices."
const EPISODE = "mantle.request.support.CaseSlaEpisode",
    EVENT = "mantle.request.support.CaseSlaEvent"
const chicago = (day, clock) => new Date(Date.parse(day + "T" + clock + ":00-06:00")).getTime()
const at = value => (value == null ? null : /^-?\d+$/.test(String(value)) ? Number(value) : Date.parse(String(value)))
const find = (entity, conditions = {}) => ec.entity.find(entity).condition(conditions).disableAuthz()
const one = (entity, conditions) => find(entity, conditions).one()
const rows = (entity, conditions) => Array.from(find(entity, conditions).list())
const clock = (requestId, clockEnumId, sequenceNum = 1) => one(EPISODE, {requestId, clockEnumId, sequenceNum})
const events = requestId => rows(EVENT, {requestId}).map(row => row.eventTypeEnumId)
const state = {}
// the targets of the Normal band: first response 4 business hours, resolution 16, a warning an hour before each
const normal = {priorityBandEnumId: "CpbNormal", firstResponseMinutes: 240, resolutionMinutes: 960, warningMinutes: 60}

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
const now = (day, clockText) => ec.user.setEffectiveTime(chicago(day, clockText))
function user(kind, permissions, organizationPartyId = org) {
    const id = prefix + "_" + kind
    call("create#moqui.security.UserGroup", {userGroupId: id, description: "Service level " + kind})
    for (const permission of permissions)
        call("create#moqui.security.UserGroupPermission", {userGroupId: id, userPermissionId: permission, fromDate: since})
    call("create#mantle.party.Party", {partyId: id, partyTypeEnumId: "PtyPerson"})
    call("create#mantle.party.Person", {partyId: id, firstName: "Sla", lastName: kind})
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
const newCase = (customerPartyId = customer, priority = 5) =>
    run(state.agent, S + "create#Case", {organizationPartyId: org, customerPartyId, requestName: "Spec case", priority}).requestId
const move = (requestId, toStatusId, extra = {}) =>
    run(state.manager, S + "transition#Case", Object.assign({requestId, toStatusId}, extra))
// a message on the case, as Chatter and the mail filing leave one: a note, or a mail in a state (ES_SENT once sent)
function message(requestId, typeId, fromPartyId, mailStatusId, purposeEnumId) {
    let emailMessageId = null
    if (mailStatusId)
        emailMessageId = call("create#moqui.basic.email.EmailMessage", {
            statusId: mailStatusId,
            subject: "Re: Spec case",
            body: "An answer",
            sentDate: mailStatusId === "ES_SENT" ? ec.user.nowTimestamp : null
        }).emailMessageId
    const communicationEventId = call("create#mantle.party.communication.CommunicationEvent", {
        communicationEventTypeId: typeId,
        statusId: mailStatusId === "ES_SENT" ? "CeSent" : "CeReady",
        fromPartyId,
        toPartyId: customer,
        entryDate: ec.user.nowTimestamp,
        emailMessageId,
        body: "An answer"
    }).communicationEventId
    if (purposeEnumId) call("create#mantle.party.communication.CommunicationEventPurpose", {communicationEventId, purposeEnumId})
    run("john.doe", "create#mantle.request.RequestCommEvent", {requestId, communicationEventId})
    return communicationEventId
}

spec({
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        now("2026-11-06", "16:30")
        party(org, "Service Level Spec Org", "OrgInternal")
        party(otherOrg, "Service Level Spec Other Org", "OrgInternal")
        party(customer, "Service Level Spec Customer", "Customer", org)
        party(vip, "Service Level Spec Key Customer", "Customer", org)
        state.admin = user("ADMIN", ["SUPPORT_POLICY_EDIT", "SUPPORT_CASE_MANAGE", "SUPPORT_CASE_EDIT"])
        state.manager = user("MANAGER", ["SUPPORT_CASE_MANAGE", "SUPPORT_CASE_EDIT"])
        state.agent = user("AGENT", ["SUPPORT_CASE_EDIT"])
        state.otherAdmin = user("OTHER_ADMIN", ["SUPPORT_POLICY_EDIT", "SUPPORT_CASE_MANAGE", "SUPPORT_CASE_EDIT"], otherOrg)
        // a team with Monday-to-Friday 9:00-17:00 in Chicago, its queue, and the organization's policy; Monday the 9th is a holiday
        state.team = run(state.admin, S + "save#ServiceTeam", {organizationPartyId: org, teamName: "Spec level team"}).teamPartyId
        for (const partyId of [state.agent, state.manager])
            run(state.admin, S + "save#ServiceTeamMember", {teamPartyId: state.team, partyId})
        login(state.admin)
        ec.artifactExecution.disableAuthz()
        call("create#moqui.security.UserGroupPermission", {
            userGroupId: state.admin,
            userPermissionId: "WORKING_HOURS_EDIT",
            fromDate: since
        })
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        const hours = run(state.admin, "mantle.work.CalendarServices.store#WorkingHours", {
            partyId: state.team,
            workDays: "1,2,3,4,5",
            workStart: "09:00",
            workEnd: "17:00",
            timeZone: zone
        })
        assert(!hours.error, hours.error)
        call("create#mantle.work.effort.WorkEffort", {
            workEffortTypeEnumId: "WetEvent",
            purposeEnumId: "WepHoliday",
            workEffortName: "Spec holiday",
            ownerPartyId: org,
            allDayStart: "2026-11-09"
        })
        state.queue = run(state.admin, S + "save#ServiceQueue", {
            organizationPartyId: org,
            description: "Spec level queue",
            responsibleTeamPartyId: state.team
        }).requestCategoryId
        run(state.admin, S + "save#ServiceDefaults", {organizationPartyId: org, defaultCategoryId: state.queue})
    },
    setup() {
        ec.artifactExecution.disableAuthz()
    },
    cleanup() {
        ec.artifactExecution.enableAuthz()
        login("john.doe")
    }
})

feature("with no policy a case has no clocks; a request that is not a case gets nothing from the rules (Mantle's default)", {
    when() {
        const requestId = newCase()
        // a plain request (no service queue): its status, due date and messages go by the rules untouched
        const plainId = call("create#mantle.request.Request", {requestName: "Not a case", statusId: "ReqSubmitted"}).requestId
        const due = new Date(chicago("2026-11-20", "12:00"))
        call("update#mantle.request.Request", {requestId: plainId, statusId: "ReqReviewed", responseRequiredDate: due})
        message(plainId, "Email", state.agent, "ES_SENT")
        return {
            requestId,
            episodes: rows(EPISODE, {requestId}),
            kinds: events(requestId),
            plain: one("mantle.request.Request", {requestId: plainId}),
            plainEvents: events(plainId),
            plainEpisodes: rows(EPISODE, {requestId: plainId})
        }
    },
    then({requestId, episodes, kinds, plain, plainEvents, plainEpisodes}) {
        requestId != null
        episodes.length == 0
        kinds == ["SetNoPolicy"]
        plain.statusId == "ReqReviewed"
        at(plain.responseRequiredDate) == chicago("2026-11-20", "12:00")
        plainEvents.length == 0
        plainEpisodes.length == 0
    }
})

feature("the policy saves: the default and a customer's, and their refusals", {
    when() {
        const policy = {organizationPartyId: org, policyName: "Spec standard", targets: [normal]}
        const agent = run(state.agent, L + "save#Policy", policy)
        const noTargets = run(state.admin, L + "save#Policy", Object.assign({}, policy, {targets: []}))
        const badWarning = run(
            state.admin,
            L + "save#Policy",
            Object.assign({}, policy, {targets: [Object.assign({}, normal, {warningMinutes: 999})]})
        )
        const otherOrgs = run(state.otherAdmin, L + "save#Policy", policy)
        const standard = run(
            state.admin,
            L + "save#Policy",
            Object.assign({}, policy, {fromDate: new Date(chicago("2026-11-01", "00:00"))})
        )
        state.standard = standard.serviceLevelPolicyId
        // a second default over the same dates is an equal-ranked overlap
        const overlap = run(state.admin, L + "save#Policy", Object.assign({}, policy, {policyName: "Spec duplicate"}))
        state.vipPolicy = run(state.admin, L + "save#Policy", {
            organizationPartyId: org,
            policyName: "Spec key customer",
            customerPartyId: vip,
            fromDate: new Date(chicago("2026-11-01", "00:00")),
            targets: [Object.assign({}, normal, {firstResponseMinutes: 60})]
        }).serviceLevelPolicyId
        return {
            agent,
            noTargets,
            badWarning,
            otherOrgs,
            standard,
            overlap,
            list: run(state.manager, L + "find#Policies", {organizationPartyId: org})
        }
    },
    then({agent, noTargets, badWarning, otherOrgs, standard, overlap, list}) {
        code(agent) == "PERMISSION_DENIED"
        code(noTargets) == "TARGETS_REQUIRED"
        code(badWarning) == "TARGET_INVALID"
        code(otherOrgs) == "RECORD_UNAVAILABLE"
        standard.error == ""
        code(overlap) == "EQUAL_RANK_OVERLAP"
        list.policies.map(row => row.rankText) == ["Customer", "Default"]
    }
})

feature("a case received Friday 16:30 gets its clocks on the team's hours, past the weekend and the Monday holiday", {
    when() {
        now("2026-11-06", "16:30")
        state.caseA = newCase()
        const vipCase = newCase(vip)
        return {
            first: clock(state.caseA, "SlcFirstResponse"),
            resolution: clock(state.caseA, "SlcResolution"),
            request: one("mantle.request.Request", {requestId: state.caseA}),
            vipFirst: clock(vipCase, "SlcFirstResponse")
        }
    },
    then({first, resolution, request, vipFirst}) {
        first.serviceLevelPolicyId == state.standard
        at(first.dueDate) == chicago("2026-11-10", "12:30")
        at(first.warningDate) == chicago("2026-11-10", "11:30")
        at(resolution.dueDate) == chicago("2026-11-11", "16:30")
        at(request.responseRequiredDate) == chicago("2026-11-11", "16:30")
        vipFirst.serviceLevelPolicyId == state.vipPolicy
        at(vipFirst.dueDate) == chicago("2026-11-10", "09:30")
    }
})

feature("a note and a send that failed do not meet first response; a sent reply does", {
    when() {
        now("2026-11-10", "09:15")
        message(state.caseA, "Comment", state.agent)
        message(state.caseA, "Email", state.agent, "ES_READY")
        // an automatic acknowledgement, sent, is no response
        const acknowledgement = message(state.caseA, "Email", state.agent, "ES_SENT", "CpAcknowledgement")
        const before = clock(state.caseA, "SlcFirstResponse").stateEnumId
        assert(acknowledgement)
        now("2026-11-10", "09:45")
        message(state.caseA, "Email", state.agent, "ES_SENT")
        return {before, after: clock(state.caseA, "SlcFirstResponse"), kinds: events(state.caseA)}
    },
    then({before, after, kinds}) {
        before == "SlsRunning"
        after.stateEnumId == "SlsMet"
        at(after.actualDate) == chicago("2026-11-10", "09:45")
        kinds.filter(kind => kind == "SetResponse").length == 1
    }
})

feature(
    "waiting for the customer pauses resolution until the customer replies, an internal hold does not, and another path's move is recorded",
    {
        when() {
            now("2026-11-10", "10:00")
            const waiting = move(state.caseA, "ReqWaitingCustomer", {reason: "Asked for the serial number"})
            const paused = clock(state.caseA, "SlcResolution")
            const pausedDue = one("mantle.request.Request", {requestId: state.caseA}).responseRequiredDate
            // the customer's reply ends the wait: the case moves back to In progress and the clock resumes
            now("2026-11-11", "10:00")
            message(state.caseA, "Email", customer)
            const resumed = clock(state.caseA, "SlcResolution")
            const replied = one("mantle.request.Request", {requestId: state.caseA}).statusId
            move(state.caseA, "ReqOnHold", {reason: "Waiting on the warehouse"})
            const held = clock(state.caseA, "SlcResolution").stateEnumId
            // a move by another path (the Request entity, as Projects' triage and complete#RequestFromWork write it)
            call("update#mantle.request.Request", {requestId: state.caseA, statusId: "ReqInProgress"})
            const pause = rows(EVENT, {requestId: state.caseA, eventTypeEnumId: "SetPause"})[0]
            return {
                waiting,
                paused,
                pausedDue,
                resumed,
                replied,
                held,
                pause,
                statuses: rows(EVENT, {requestId: state.caseA, eventTypeEnumId: "SetStatus"})
            }
        },
        then({waiting, paused, pausedDue, resumed, replied, held, pause, statuses}) {
            waiting.error == ""
            paused.stateEnumId == "SlsPaused"
            pausedDue == null
            pause.reasonText == "Asked for the serial number"
            // 14.5 h were left at the pause; from Wednesday 10:00 that is Thursday 16:30; 8 h of working time paused
            resumed.stateEnumId == "SlsRunning"
            at(resumed.dueDate) == chicago("2026-11-12", "16:30")
            resumed.pausedMinutes == 480
            replied == "ReqInProgress"
            statuses[1].reasonText == "The customer replied"
            held == "SlsRunning"
            statuses.map(row => row.statusId) == ["ReqWaitingCustomer", "ReqInProgress", "ReqOnHold", "ReqInProgress"]
        }
    }
)

feature(
    "a reopen starts a new resolution episode and keeps the first breach; a policy row started later leaves the open case on its row",
    {
        when() {
            now("2026-11-06", "16:30")
            const caseB = newCase()
            // no response by Tuesday 13:00: the scan records the breach
            now("2026-11-10", "13:00")
            run("john.doe", L + "scan#CaseSla", {})
            const breached = clock(caseB, "SlcFirstResponse")
            // the standard policy replaced from now: an open case keeps its row, a new one takes the new row
            const replaced = run(state.admin, L + "save#Policy", {
                serviceLevelPolicyId: state.standard,
                targets: [Object.assign({}, normal, {resolutionMinutes: 480})]
            })
            const caseC = newCase()
            move(caseB, "ReqCompleted", {resolutionEnumId: "RrCompleted"})
            now("2026-11-10", "14:00")
            const reopened = move(caseB, "ReqInProgress", {reason: "Still broken"})
            return {
                breached,
                replaced,
                caseC: clock(caseC, "SlcResolution").serviceLevelPolicyId,
                caseB: clock(caseB, "SlcResolution").serviceLevelPolicyId,
                first: clock(caseB, "SlcFirstResponse"),
                resolved: clock(caseB, "SlcResolution"),
                second: clock(caseB, "SlcResolution", 2),
                reopened
            }
        },
        then({breached, replaced, caseC, caseB, first, resolved, second, reopened}) {
            at(breached.breachedDate) == chicago("2026-11-10", "12:30")
            replaced.serviceLevelPolicyId != state.standard
            caseC == replaced.serviceLevelPolicyId
            caseB == state.standard
            reopened.error == ""
            first.stateEnumId == "SlsUnmet"
            at(first.breachedDate) == chicago("2026-11-10", "12:30")
            resolved.stateEnumId == "SlsMet"
            second.stateEnumId == "SlsRunning"
            second.serviceLevelPolicyId == state.standard
            at(second.startDate) == chicago("2026-11-10", "14:00")
        }
    }
)

feature("a manager corrects a clock with a reason, the earlier figure kept; another organization's case is refused", {
    when() {
        const episode = clock(state.caseA, "SlcResolution")
        const corrected = {
            requestId: state.caseA,
            caseSlaEpisodeId: episode.caseSlaEpisodeId,
            dueDate: new Date(chicago("2026-11-13", "12:00"))
        }
        const agent = run(state.agent, L + "correct#CaseSla", Object.assign({reason: "Agreed with the customer"}, corrected))
        const noReason = run(state.manager, L + "correct#CaseSla", corrected)
        const done = run(state.manager, L + "correct#CaseSla", Object.assign({reason: "Agreed with the customer"}, corrected))
        const correction = rows(EVENT, {requestId: state.caseA, eventTypeEnumId: "SetCorrection"})[0]
        return {
            agent,
            noReason,
            done,
            correction,
            previous: at(episode.dueDate),
            history: run(state.agent, L + "get#CaseSlaHistory", {requestId: state.caseA}),
            other: run(state.otherAdmin, L + "get#CaseSlaHistory", {requestId: state.caseA})
        }
    },
    then({agent, noReason, done, correction, previous, history, other}) {
        code(agent) == "PERMISSION_DENIED"
        code(noReason) == "REASON_REQUIRED"
        done.error == ""
        at(correction.previousDueDate) == previous
        at(correction.dueDate) == chicago("2026-11-13", "12:00")
        history.clocks.map(row => row.label) == ["First response", "Resolution"]
        history.events.some(row => row.typeText == "Corrected" && row.reasonText == "Agreed with the customer")
        code(other) == "RECORD_UNAVAILABLE"
    }
})

feature("the scan names a clock that fails and warns the rest, once", {
    when() {
        now("2026-11-12", "09:00")
        const fresh = newCase()
        // a clock on a request that is not a case fails; the fresh case is warned when its warning time comes
        call("create#mantle.request.Request", {
            requestId: prefix + "_NOT_A_CASE",
            requestName: "Not a case",
            statusId: "ReqSubmitted"
        })
        const broken = call("create#" + EPISODE, {
            requestId: prefix + "_NOT_A_CASE",
            clockEnumId: "SlcResolution",
            sequenceNum: 1,
            stateEnumId: "SlsRunning",
            startDate: new Date(chicago("2026-11-01", "09:00")),
            dueDate: new Date(chicago("2026-11-02", "09:00"))
        }).caseSlaEpisodeId
        now("2026-11-12", "12:00")
        const scanned = run("john.doe", L + "scan#CaseSla", {limit: 2000})
        const again = run("john.doe", L + "scan#CaseSla", {limit: 2000})
        return {
            broken,
            scanned,
            again,
            warnings: rows(EVENT, {requestId: fresh, eventTypeEnumId: "SetWarning"}),
            first: clock(fresh, "SlcFirstResponse")
        }
    },
    then({broken, scanned, again, warnings, first}) {
        scanned.failedList.some(row => row.caseSlaEpisodeId == broken && row.requestId == prefix + "_NOT_A_CASE")
        warnings.length == 1
        first.warnedDate != null
        again.failedList.some(row => row.caseSlaEpisodeId == broken)
        rows(EVENT, {requestId: first.requestId, eventTypeEnumId: "SetWarning"}).length == 1
    }
})
