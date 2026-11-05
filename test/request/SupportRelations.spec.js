// Merge, split and closing of support cases (impl-customer-service P8: CS-MERGE, CS-JOBS; CaseRelations.js,
// mantle.request.SupportCaseServices preview#MergeCases, merge#Cases, preview#SplitCase, split#Case, create#FollowUpCase,
// close#ResolvedCases, get#CaseLineage; Sla.js carryOnMerge; the reply paths of Sla.js recordMessage and Channels.js
// mailIntake): a merge of one customer's cases keeping the kept case's own clock and carrying the source's breach as an
// obligation, the source's messages referenced without counting as a reply or response, the source no longer worked, a retry
// answering the first result, and the refusals (another customer, another organization, an agent, a stale revision); a split
// starting its clock at the chosen message's receipt, the source staying open, a manager's start with its reason; a customer's
// reply within the reopen window reopening, after it (and after auto-close, and to a cancelled case) making a follow-up case,
// to a merged case going to the case kept, and to a plain request doing nothing (Mantle's default); auto-close setting the
// close date, keeping ReqCompleted, naming a failing case, and a rerun changing nothing; mail answering a merged case threading
// to the case kept and the customer's mail to a closed case making its follow-up. Standalone: spec-local organizations,
// customers, groups and users, artifact authorization disabled (the rules are the services' own checks), the effective time
// moved ahead and back. Run: ./moq test mr-mantle --spec SupportRelations
const prefix = "REL"
const org = prefix + "_ORG",
    otherOrg = prefix + "_OTHER_ORG",
    customer = prefix + "_CUST",
    otherCustomer = prefix + "_CUST2",
    elsewhereCustomer = prefix + "_CUST3",
    contact = prefix + "_CONTACT",
    account = prefix + "_ACCOUNT",
    since = "2000-01-01T00:00:00Z"
const S = "mantle.request.SupportCaseServices.",
    R = "mantle.request.RequestServices."
const REQUEST = "mantle.request.Request",
    PROFILE = "mantle.request.support.CaseProfile",
    EPISODE = "mantle.request.support.CaseSlaEpisode",
    EVENT = "mantle.request.support.CaseSlaEvent",
    RELATION = "mantle.request.support.CaseRelation",
    ITEM = "mantle.request.support.CaseRelationItem",
    LINK = "mantle.request.RequestCommEvent",
    MAIL = "mantle.request.RequestEmailMessage"
const hour = 3600000,
    day = 24 * hour
const find = (entity, conditions = {}) => ec.entity.find(entity).condition(conditions).disableAuthz()
const one = (entity, conditions) => find(entity, conditions).one()
const rows = (entity, conditions) => Array.from(find(entity, conditions).list())
const at = value => (value == null ? null : /^-?\d+$/.test(String(value)) ? Number(value) : Date.parse(String(value)))
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
// the effective time: some time before the spec's base time (now when it started), or ahead of it. A follow-up of a reply runs
// after the commit on the real clock, so a case it follows up is made at or before the base time, never ahead of it.
const back = millis => ec.user.setEffectiveTime(state.base - millis)
const ahead = millis => ec.user.setEffectiveTime(state.base + millis)
// a value that appears after the commit (the follow-up of a reply runs then)
function waitFor(read, millis = 5000) {
    const end = Date.now() + millis
    let value = read()
    while (!value && Date.now() < end) value = read()
    return value
}
function user(kind, permissions, organizationPartyId = org) {
    const id = prefix + "_" + kind
    call("create#moqui.security.UserGroup", {userGroupId: id, description: "Case relation " + kind})
    for (const permission of permissions)
        call("create#moqui.security.UserGroupPermission", {userGroupId: id, userPermissionId: permission, fromDate: since})
    call("create#mantle.party.Party", {partyId: id, partyTypeEnumId: "PtyPerson"})
    call("create#mantle.party.Person", {partyId: id, firstName: "Relation", lastName: kind})
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
        timeZone: "America/Chicago"
    })
    call("create#moqui.security.UserGroupMember", {userId: id, userGroupId: id, fromDate: since})
    return id
}
function party(partyId, name, roleTypeId, ownerPartyId, typeId = "PtyOrganization", email = null) {
    call("create#mantle.party.Party", {partyId, partyTypeEnumId: typeId, ownerPartyId: ownerPartyId || "_NA_"})
    if (typeId === "PtyOrganization") call("create#mantle.party.Organization", {partyId, organizationName: name})
    else call("create#mantle.party.Person", {partyId, firstName: name, lastName: "Spec"})
    if (roleTypeId) call("create#mantle.party.PartyRole", {partyId, roleTypeId})
    if (email)
        call("mantle.party.ContactServices.create#EmailAddress", {
            partyId,
            emailAddress: email,
            contactMechPurposeId: "EmailPrimary"
        })
}
let caseCount = 0
const newCase = (customerPartyId = customer, organizationPartyId = org, username = state.agent) => {
    caseCount++
    return run(username, S + "create#Case", {organizationPartyId, customerPartyId, requestName: "Relation case " + caseCount})
        .requestId
}
const move = (requestId, toStatusId, extra = {}) =>
    run(state.manager, S + "transition#Case", Object.assign({requestId, toStatusId}, extra))
const resolve = requestId => move(requestId, "ReqCompleted", {resolutionEnumId: "RrCompleted"})
// a message on the case as Chatter and the mail filing leave one: the customer's (or anyone's) note or mail, now
function message(requestId, typeId, fromPartyId, sent = false) {
    let emailMessageId = null
    if (sent)
        emailMessageId = call("create#moqui.basic.email.EmailMessage", {
            statusId: "ES_SENT",
            subject: "Re: Relation case",
            body: "An answer",
            sentDate: ec.user.nowTimestamp
        }).emailMessageId
    const communicationEventId = call("create#mantle.party.communication.CommunicationEvent", {
        communicationEventTypeId: typeId,
        statusId: sent ? "CeSent" : "CeReady",
        fromPartyId,
        toPartyId: fromPartyId === customer ? org : customer,
        entryDate: ec.user.nowTimestamp,
        emailMessageId,
        body: "A message from " + fromPartyId
    }).communicationEventId
    run("john.doe", "create#" + LINK, {requestId, communicationEventId})
    return communicationEventId
}
const clock = (requestId, clockEnumId, sequenceNum = 1) =>
    rows(EPISODE, {requestId, clockEnumId, sequenceNum}).find(row => !row.carriedFromEpisodeId) || null
const carried = requestId => rows(EPISODE, {requestId}).filter(row => !!row.carriedFromEpisodeId)
const relationsFrom = (fromRequestId, relationTypeEnumId) => rows(RELATION, {fromRequestId, relationTypeEnumId})
const followUpOf = requestId => waitFor(() => relationsFrom(requestId, "CrtFollowUp")[0]?.toRequestId || null)
// a received mail in the spec's account from the contact, answering a message id when given
let mailCount = 0
function receive(inReplyTo = null) {
    mailCount++
    const id = prefix + "MSG" + mailCount
    call("store#moqui.basic.email.EmailMessage", {
        emailMessageId: id,
        emailAccountId: account,
        statusId: "ES_RECEIVED",
        contentType: "text/plain",
        subject: inReplyTo ? "Re: My thermostat" : "My thermostat",
        body: "Mail " + mailCount,
        fromAddress: "pat.rel@example.com",
        toAddresses: "help@rel.example",
        messageDate: ec.user.nowTimestamp,
        receivedDate: ec.user.nowTimestamp,
        isRead: "N",
        hasAttachment: "N",
        messageId: "<rel-" + mailCount + "-" + state.base + "@example.com>",
        inReplyTo,
        rootEmailMessageId: id
    })
    run("john.doe", R + "create#RequestFromEmail", {
        emailMessageId: id,
        emailAccountId: account,
        ruleOwnerUserId: state.admin,
        value: state.queue
    })
    return id
}
const mailRequest = emailMessageId => rows(MAIL, {emailMessageId}).map(row => row.requestId)

spec({
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        party(org, "Relation Spec Org", "OrgInternal")
        party(otherOrg, "Relation Spec Other Org", "OrgInternal")
        party(customer, "Relation Spec Customer", "Customer", org)
        party(otherCustomer, "Relation Spec Other Customer", "Customer", org)
        party(elsewhereCustomer, "Relation Spec Other Organization's Customer", "Customer", otherOrg)
        party(contact, "Pat", null, org, "PtyPerson", "pat.rel@example.com")
        call("create#mantle.party.PartyRelationship", {
            relationshipTypeEnumId: "PrtContact",
            fromPartyId: contact,
            toPartyId: customer,
            fromDate: since
        })
        state.admin = user("ADMIN", ["SUPPORT_POLICY_EDIT", "SUPPORT_CASE_MANAGE", "SUPPORT_CASE_EDIT"])
        state.manager = user("MANAGER", ["SUPPORT_CASE_MANAGE", "SUPPORT_CASE_EDIT"])
        state.agent = user("AGENT", ["SUPPORT_CASE_EDIT"])
        state.otherManager = user("OTHER_MANAGER", ["SUPPORT_POLICY_EDIT", "SUPPORT_CASE_MANAGE", "SUPPORT_CASE_EDIT"], otherOrg)
        call("store#moqui.basic.email.EmailAccount", {
            emailAccountId: account,
            ownerUserId: state.admin,
            accountKindEnumId: "EakShared",
            emailAddress: "help@rel.example",
            accountName: "REL help",
            statusId: "EasActive"
        })
        // the queue (no team: around the clock), the defaults with a 14-day reopen window and a 7-day auto-close, a policy
        // with a one-hour first response
        const settingsFrom = new Date(Date.now() - 90 * day)
        state.queue = run(state.admin, S + "save#ServiceQueue", {
            organizationPartyId: org,
            description: "Relation Support",
            fromDate: settingsFrom
        }).requestCategoryId
        run(state.admin, S + "save#ServiceDefaults", {
            organizationPartyId: org,
            defaultCategoryId: state.queue,
            reopenWindowDays: 14,
            autoCloseDays: 7,
            fromDate: settingsFrom
        })
        const policy = run(state.admin, "mantle.request.SlaServices.save#Policy", {
            organizationPartyId: org,
            policyName: "Relation spec",
            timeZone: "America/Chicago",
            fromDate: settingsFrom,
            targets: [{priorityBandEnumId: "CpbNormal", firstResponseMinutes: 60, resolutionMinutes: 6000, warningMinutes: 30}]
        })
        assert(!policy.error, policy.error)
        state.otherQueue = run(state.otherManager, S + "save#ServiceQueue", {
            organizationPartyId: otherOrg,
            description: "Other",
            fromDate: settingsFrom
        }).requestCategoryId
        run(state.otherManager, S + "save#ServiceDefaults", {
            organizationPartyId: otherOrg,
            defaultCategoryId: state.otherQueue,
            fromDate: settingsFrom
        })
        state.base = Math.floor(Date.now() / 1000) * 1000
    },
    setup() {
        ec.artifactExecution.disableAuthz()
    },
    cleanup() {
        ec.user.setEffectiveTime(null)
        ec.artifactExecution.enableAuthz()
        login("john.doe")
    }
})

feature("a merge keeps the kept case's clock and carries the source's breach; the source is no longer worked; the refusals", {
    when() {
        back(3 * hour)
        const target = newCase()
        const source = newCase()
        const other = newCase(otherCustomer)
        const elsewhere = newCase(elsewhereCustomer, otherOrg, state.otherManager)
        const note = run(state.agent, R + "add#RequestComment", {
            requestId: source,
            body: "Internal: same unit"
        }).communicationEventId
        const reply = message(source, "Email", customer)
        // two hours on, both first responses are breached
        back(hour)
        run("john.doe", "mantle.request.SlaServices.scan#CaseSla", {limit: 2000})
        const targetFirst = clock(target, "SlcFirstResponse")
        const sourceFirst = clock(source, "SlcFirstResponse")
        const sources = [source]
        const preview = run(state.manager, S + "preview#MergeCases", {targetRequestId: target, sourceRequestIds: [source, other]})
        const ok = run(state.manager, S + "preview#MergeCases", {targetRequestId: target, sourceRequestIds: sources})
        const params = {
            targetRequestId: target,
            sourceRequestIds: sources,
            reason: "The same thermostat",
            operationKey: prefix + "-MERGE-1",
            caseRevisions: ok.preview?.caseRevisions
        }
        const refused = {
            agent: run(state.agent, S + "preview#MergeCases", {targetRequestId: target, sourceRequestIds: sources}),
            otherOrg: run(state.manager, S + "merge#Cases", Object.assign({}, params, {sourceRequestIds: [elsewhere]})),
            otherCustomer: run(state.manager, S + "merge#Cases", Object.assign({}, params, {sourceRequestIds: [other]})),
            stale: run(state.manager, S + "merge#Cases", Object.assign({}, params, {caseRevisions: target + ":1"})),
            noReason: run(state.manager, S + "merge#Cases", Object.assign({}, params, {reason: null})),
            self: run(state.manager, S + "preview#MergeCases", {targetRequestId: target, sourceRequestIds: [target]})
        }
        const merged = run(state.manager, S + "merge#Cases", params)
        const again = run(state.manager, S + "merge#Cases", params)
        // the kept case answered late: its own clock and the carried one are met late together
        message(target, "Email", state.agent, true)
        state.merged = {target, source}
        return {
            target,
            source,
            note,
            reply,
            preview: preview.preview,
            ok: ok.preview,
            refused,
            merged,
            again,
            targetFirst,
            sourceFirst,
            sourceRequest: one(REQUEST, {requestId: source}),
            sourceProfile: one(PROFILE, {requestId: source}),
            targetFirstAfter: clock(target, "SlcFirstResponse"),
            sourceFirstAfter: one(EPISODE, {caseSlaEpisodeId: sourceFirst.caseSlaEpisodeId}),
            carriedRows: carried(target),
            onTarget: rows(LINK, {requestId: target}).map(row => row.communicationEventId),
            replyEvents: rows(EVENT, {requestId: target, communicationEventId: reply}),
            items: rows(ITEM, {caseRelationId: merged.caseRelationIds?.[0]}),
            moveSource: move(source, "ReqInProgress"),
            updateSource: run(state.manager, S + "update#Case", {requestId: source, priority: 3}),
            // the note is on both cases: its author may delete it from neither (it would leave both)
            deleteNote: run(state.agent, R + "delete#RequestComment", {requestId: target, communicationEventId: note}),
            lineage: run(state.agent, S + "get#CaseLineage", {requestId: source}).lineage,
            targetLineage: run(state.agent, S + "get#CaseLineage", {requestId: target}).lineage
        }
    },
    then(r) {
        r.preview.canMerge == false
        r.preview.problems.map(row => row.code) == ["CUSTOMER_MISMATCH"]
        r.ok.canMerge == true
        r.ok.carried.some(row => row.requestId == r.source && row.breachedText != "")
        code(r.refused.agent) == "PERMISSION_DENIED"
        code(r.refused.otherOrg) == "RECORD_UNAVAILABLE"
        code(r.refused.otherCustomer) == "CUSTOMER_MISMATCH"
        code(r.refused.stale) == "STALE_CASE"
        code(r.refused.noReason) == "REASON_REQUIRED"
        code(r.refused.self) == "SAME_CASE"
        r.merged.error == ""
        r.merged.mergedRequestIds == [r.source]
        r.again.alreadyApplied == true
        r.again.caseRelationIds == r.merged.caseRelationIds
        relationsFrom(r.source, "CrtMerge").length == 1
        // the source: cancelled as a duplicate, closed, its own clock Merged with its breach kept
        r.sourceRequest.statusId == "ReqCancelled"
        r.sourceRequest.requestResolutionEnumId == "RrDuplicate"
        r.sourceProfile.closedDate != null
        r.sourceFirst.breachedDate != null
        r.sourceFirstAfter.stateEnumId == "SlsMerged"
        at(r.sourceFirstAfter.breachedDate) == at(r.sourceFirst.breachedDate)
        // the kept case's own clock as it was (not restarted), and the source's carried with its due time and breach
        at(r.targetFirstAfter.startDate) == at(r.targetFirst.startDate)
        at(r.targetFirstAfter.dueDate) == at(r.targetFirst.dueDate)
        r.carriedRows.length == 2
        r.carriedRows.some(
            row =>
                row.carriedFromEpisodeId == r.sourceFirst.caseSlaEpisodeId &&
                at(row.breachedDate) == at(r.sourceFirst.breachedDate)
        )
        // the response met both late
        r.targetFirstAfter.stateEnumId == "SlsMissed"
        r.carriedRows.find(row => row.clockEnumId == "SlcFirstResponse").stateEnumId == "SlsMissed"
        // the source's messages referenced with their audience, no new reply on the kept case
        r.onTarget.includes(r.reply)
        r.onTarget.includes(r.note)
        r.replyEvents.length == 0
        r.items.some(row => row.communicationEventId == r.reply && row.audienceEnumId == "CfaCustomer")
        r.items.some(row => row.communicationEventId == r.note && row.audienceEnumId == "CfaInternal")
        r.items.some(row => row.itemTypeEnumId == "CriClock" && row.carriedEpisodeId != null)
        code(r.moveSource) == "CASE_MERGED"
        code(r.updateSource) == "CASE_MERGED"
        r.deleteNote.error.includes("by a merge or split; it stays")
        one("mantle.party.communication.CommunicationEvent", {communicationEventId: r.note}) != null
        r.lineage.mergedIntoRequestId == r.target
        r.lineage.actionable == false
        r.targetLineage.relations.some(row => row.relationText == "Merged from" && row.otherRequestId == r.source)
    }
})

feature(
    "a split starts its clock at the chosen message's receipt and leaves the source open; a manager's start needs its reason",
    {
        when() {
            back(50 * 60000)
            const source = newCase()
            const issue = message(source, "Email", customer)
            const received = at(one("mantle.party.communication.CommunicationEvent", {communicationEventId: issue}).entryDate)
            back(30 * 60000)
            const base = {requestId: source, communicationEventIds: [issue], requestName: "A second issue"}
            const preview = run(state.agent, S + "preview#SplitCase", base)
            const notOnCase = run(
                state.agent,
                S + "split#Case",
                Object.assign({}, base, {communicationEventIds: ["NO_SUCH_MESSAGE"], operationKey: prefix + "-S0"})
            )
            const agentStart = run(
                state.agent,
                S + "split#Case",
                Object.assign({}, base, {
                    intakeDate: new Date(state.base - 2 * hour),
                    startReason: "Phoned",
                    operationKey: prefix + "-S1"
                })
            )
            const noReason = run(
                state.manager,
                S + "split#Case",
                Object.assign({}, base, {intakeDate: new Date(state.base - 2 * hour), operationKey: prefix + "-S2"})
            )
            const split = run(state.agent, S + "split#Case", Object.assign({}, base, {operationKey: prefix + "-S3"}))
            const managed = run(
                state.manager,
                S + "split#Case",
                Object.assign({}, base, {
                    communicationEventIds: [],
                    requestName: "A third issue",
                    intakeDate: new Date(state.base - 2 * hour),
                    startReason: "The customer phoned it in then",
                    operationKey: prefix + "-S4"
                })
            )
            return {
                source,
                issue,
                received,
                preview: preview.preview,
                notOnCase,
                agentStart,
                noReason,
                split,
                managed,
                sourceRequest: one(REQUEST, {requestId: source}),
                newProfile: one(PROFILE, {requestId: split.requestId}),
                newFirst: clock(split.requestId, "SlcFirstResponse"),
                newCustomer: rows("mantle.request.RequestParty", {requestId: split.requestId, roleTypeId: "Customer"})[0]
                    ?.partyId,
                onNew: rows(LINK, {requestId: split.requestId}).map(row => row.communicationEventId),
                replyEvents: rows(EVENT, {requestId: split.requestId, communicationEventId: issue}),
                managedProfile: one(PROFILE, {requestId: managed.requestId})
            }
        },
        then(r) {
            r.preview.messages.some(
                row => row.communicationEventId == r.issue && row.chosen && row.audienceEnumId == "CfaCustomer"
            )
            r.preview.startFrom == "message"
            code(r.notOnCase) == "EVIDENCE_UNAVAILABLE"
            code(r.agentStart) == "PERMISSION_DENIED"
            code(r.noReason) == "START_REASON_REQUIRED"
            r.split.error == ""
            r.sourceRequest.statusId == "ReqSubmitted"
            at(r.newProfile.intakeDate) == r.received
            at(r.newFirst.startDate) == r.received
            r.newCustomer == customer
            r.onNew.includes(r.issue)
            r.replyEvents.length == 0
            relationsFrom(r.source, "CrtSplit").length == 2
            r.managed.error == ""
            at(r.managedProfile.intakeDate) == state.base - 2 * hour
        }
    }
)

feature("a customer's reply reopens within the window and after it makes a follow-up; one to a cancelled case and a merged one", {
    when() {
        // resolved twenty days ago (past the window), three days ago (within it), cancelled yesterday
        back(20 * day)
        const late = newCase()
        resolve(late)
        back(3 * day)
        const reopened = newCase()
        resolve(reopened)
        back(day)
        const cancelled = newCase()
        move(cancelled, "ReqCancelled", {resolutionEnumId: "RrRejected", reason: "Asked by mistake"})
        const plain = call("create#" + REQUEST, {requestName: "Not a case", statusId: "ReqCompleted"}).requestId
        // the replies now: one reopens with a new resolution clock, the late and cancelled ones make follow-ups, the one to
        // the merged case goes to the case kept, the plain request's does nothing; the manager can no longer reopen the late one
        ahead(0)
        message(reopened, "Email", contact)
        message(cancelled, "Email", customer)
        message(plain, "Email", customer)
        const toMerged = message(state.merged.source, "Email", customer)
        message(late, "Email", customer)
        return {
            reopened: one(REQUEST, {requestId: reopened}),
            secondClock: clock(reopened, "SlcResolution", 2),
            lateRequest: one(REQUEST, {requestId: late}),
            lateFollowUp: followUpOf(late),
            cancelledFollowUp: followUpOf(cancelled),
            plainRelations: relationsFrom(plain, "CrtFollowUp"),
            toMerged,
            keptLinks: rows(LINK, {requestId: state.merged.target}).map(row => row.communicationEventId),
            lateReopen: move(late, "ReqInProgress", {reason: "Try again"}),
            openFollowUp: run(state.agent, S + "create#FollowUpCase", {requestId: reopened}),
            late
        }
    },
    then(r) {
        r.reopened.statusId == "ReqInProgress"
        r.secondClock != null
        r.lateRequest.statusId == "ReqCompleted"
        r.lateFollowUp != null
        one(PROFILE, {requestId: r.lateFollowUp}) != null
        rows("mantle.request.RequestParty", {requestId: r.lateFollowUp, roleTypeId: "Customer"})[0].partyId == customer
        one(REQUEST, {requestId: r.lateFollowUp}).statusId == "ReqSubmitted"
        r.cancelledFollowUp != null
        r.plainRelations.length == 0
        r.keptLinks.includes(r.toMerged)
        code(r.lateReopen) == "REOPEN_WINDOW_PASSED"
        code(r.openFollowUp) == "CASE_OPEN"
        run(state.agent, S + "get#CaseLineage", {requestId: r.late}).lineage.relations.some(
            row => row.relationText == "Followed up by"
        )
    }
})

feature("auto-close sets the close date and keeps the status, names a case that fails, changes nothing on a rerun", {
    when() {
        ahead(0)
        const closing = newCase()
        const broken = newCase()
        resolve(closing)
        resolve(broken)
        // a clock left running on a resolved case: it is not closed, and named
        call("create#" + EPISODE, {
            requestId: broken,
            clockEnumId: "SlcResolution",
            sequenceNum: 9,
            stateEnumId: "SlsRunning",
            startDate: ec.user.nowTimestamp,
            dueDate: new Date(state.base + 30 * day)
        })
        ahead(8 * day)
        const first = run("john.doe", S + "close#ResolvedCases", {limit: 2000, requestIds: [closing, broken]})
        const closedDate = one(PROFILE, {requestId: closing}).closedDate
        const second = run("john.doe", S + "close#ResolvedCases", {limit: 2000, requestIds: [closing, broken]})
        // after auto-close, a reply within the fourteen days makes a follow-up, and a reopen is refused
        message(closing, "Email", customer)
        return {
            closing,
            broken,
            first,
            second,
            closedDate,
            closedAgain: one(PROFILE, {requestId: closing}).closedDate,
            request: one(REQUEST, {requestId: closing}),
            brokenProfile: one(PROFILE, {requestId: broken}),
            followUp: followUpOf(closing),
            reopen: move(closing, "ReqInProgress", {reason: "Try again"})
        }
    },
    then(r) {
        r.first.closedCount == 1
        r.closedDate != null
        r.request.statusId == "ReqCompleted"
        r.first.failedList.some(row => row.requestId == r.broken && row.message.includes("CLOCK_OPEN"))
        r.brokenProfile.closedDate == null
        r.second.closedCount == 0
        r.second.failedList.some(row => row.requestId == r.broken)
        at(r.closedAgain) == at(r.closedDate)
        r.followUp != null
        code(r.reopen) == "CASE_CLOSED"
    }
})

feature("mail answering a merged case threads to the case kept; the customer's mail to a closed case makes its follow-up", {
    when() {
        // the mail cases are made after the commit on the real clock, so these start now; the closed case's reply comes
        // twenty days on (its follow-up is made in the mail's own transaction)
        ec.user.setEffectiveTime(null)
        const first = receive()
        const second = receive()
        const kept = waitFor(() => mailRequest(first)[0] || null)
        const source = waitFor(() => mailRequest(second)[0] || null)
        waitFor(() => one(PROFILE, {requestId: kept}) && one(PROFILE, {requestId: source}))
        const merged = run(state.manager, S + "merge#Cases", {
            targetRequestId: kept,
            sourceRequestIds: [source],
            reason: "One thermostat",
            operationKey: prefix + "-MERGE-2"
        })
        const toMerged = receive(one("moqui.basic.email.EmailMessage", {emailMessageId: second}).messageId)
        resolve(kept)
        ahead(20 * day)
        const toClosed = receive(one("moqui.basic.email.EmailMessage", {emailMessageId: first}).messageId)
        return {kept, source, merged, toMerged, toClosed, followUp: relationsFrom(kept, "CrtFollowUp")[0]?.toRequestId || null}
    },
    then(r) {
        r.merged.error == ""
        mailRequest(r.toMerged) == [r.kept]
        r.followUp != null
        mailRequest(r.toClosed) == [r.followUp]
        one(PROFILE, {requestId: r.followUp}).emailMessageId == r.toClosed
        one(REQUEST, {requestId: r.followUp}).salesChannelEnumId == "ScEmail"
    }
})
