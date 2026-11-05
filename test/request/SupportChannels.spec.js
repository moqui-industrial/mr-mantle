// Support channels (impl-customer-service P6: CS-CHANNELS; F10, F12, F61, F62, F79, F84; Channels.js,
// mantle.request.SupportCaseServices save#ServiceRoute, preview#ServiceRoute, log#CaseCall, review#HeldRequest, and the queue
// paths of create#RequestFromEmail, create#IntakeToken and create#IntakeRequest, and of the forum's create#CaseFromTopic): a
// route's save and its refusals; mail to a queue from a customer's contact a case timed by its received date, acknowledged
// once with the route's text and the acknowledgement no response; a reply joining by its references, a verified token
// joining and a stranger's token not; an automatic reply attached, no reply to the case, nothing sent, and an automatic
// message on no case making nothing; an unknown sender and staff held for review, accepted or dismissed; the dry run; the
// queue's intake token (the party-less RequestCategory kind) issued, used with the queue's limit and revoked; a logged call
// meeting first response and an internal one not; a forum topic escalated through a route a Submitted case on channel
// ScForum. Standalone: spec-local organizations, customers, groups and users, artifact authorization disabled (the rules
// are the services' own checks). Run: ./moq test mr-mantle --spec SupportChannels
const prefix = "SCH"
const org = prefix + "_ORG",
    otherOrg = prefix + "_OTHER_ORG",
    customer = prefix + "_CUST",
    contact = prefix + "_CONTACT",
    stranger = prefix + "_STRANGER",
    employee = prefix + "_EMP",
    account = prefix + "_ACCOUNT",
    since = "2000-01-01T00:00:00Z"
const S = "mantle.request.SupportCaseServices.",
    R = "mantle.request.RequestServices.",
    F = "mantle.forum.ForumServices."
const REQUEST = "mantle.request.Request",
    PROFILE = "mantle.request.support.CaseProfile",
    EPISODE = "mantle.request.support.CaseSlaEpisode",
    MAIL = "mantle.request.RequestEmailMessage"
const find = (entity, conditions = {}) => ec.entity.find(entity).condition(conditions).disableAuthz()
const one = (entity, conditions) => find(entity, conditions).one()
const rows = (entity, conditions) => Array.from(find(entity, conditions).list())
const current = (entity, conditions) => rows(entity, conditions).filter(row => !row.thruDate)
const ms = value =>
    value == null
        ? null
        : typeof value === "number"
          ? value
          : /^\d+$/.test(String(value))
            ? Number(value)
            : new Date(value).getTime()
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
function profileOf(requestId, wait = true) {
    const end = Date.now() + (wait ? 4000 : 250)
    let profile = one(PROFILE, {requestId})
    while (!profile && Date.now() < end) profile = one(PROFILE, {requestId})
    return profile
}
function user(kind, permissions, organizationPartyId = org) {
    const id = prefix + "_" + kind
    call("create#moqui.security.UserGroup", {userGroupId: id, description: "Support channel " + kind})
    for (const permission of permissions)
        call("create#moqui.security.UserGroupPermission", {userGroupId: id, userPermissionId: permission, fromDate: since})
    call("create#mantle.party.Party", {partyId: id, partyTypeEnumId: "PtyPerson"})
    call("create#mantle.party.Person", {partyId: id, firstName: "Channel", lastName: kind})
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
        timeZone: ec.user.userAccount?.timeZone || "America/Chicago"
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
// a received message in the spec's account, its received date two hours ago unless given
let messageCount = 0
const receivedAt = Math.floor((Date.now() - 2 * 3600000) / 1000) * 1000
function receive(fields) {
    messageCount++
    const id = prefix + "MSG" + messageCount
    call(
        "store#moqui.basic.email.EmailMessage",
        Object.assign(
            {
                emailMessageId: id,
                emailAccountId: account,
                statusId: "ES_RECEIVED",
                contentType: "text/plain",
                messageDate: new Date(receivedAt),
                receivedDate: new Date(receivedAt),
                isRead: "N",
                hasAttachment: "N",
                toAddresses: "help@sch.example",
                messageId: "<sch-" + messageCount + "-" + receivedAt + "@example.com>",
                rootEmailMessageId: id
            },
            fields
        )
    )
    return id
}
// the queue's mail rule action, as run#EmailRules runs it for the rule's owner
const mail = (emailMessageId, value = state.queue) =>
    run("john.doe", R + "create#RequestFromEmail", {emailMessageId, emailAccountId: account, ruleOwnerUserId: state.admin, value})
const requestOf = emailMessageId => rows(MAIL, {emailMessageId})[0]?.requestId || null
const acksOf = requestId =>
    rows(MAIL, {requestId})
        .map(row => one("moqui.basic.email.EmailMessage", {emailMessageId: row.emailMessageId}))
        .filter(row => row && row.statusId !== "ES_RECEIVED")

spec({
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        party(org, "Channel Spec Org", "OrgInternal")
        party(otherOrg, "Channel Spec Other Org", "OrgInternal")
        party(customer, "Channel Spec Customer", "Customer", org)
        party(contact, "Dana", null, org, "PtyPerson", "dana.sch@example.com")
        call("create#mantle.party.PartyRelationship", {
            relationshipTypeEnumId: "PrtContact",
            fromPartyId: contact,
            toPartyId: customer,
            fromDate: since
        })
        party(stranger, "Sam", "Customer", otherOrg, "PtyPerson", "sam.sch@example.com")
        party(employee, "Erin", null, org, "PtyPerson", "erin.sch@example.com")
        call("create#mantle.party.PartyRelationship", {
            relationshipTypeEnumId: "PrtEmployee",
            fromPartyId: employee,
            toPartyId: org,
            toRoleTypeId: "OrgInternal",
            fromDate: since
        })
        state.admin = user("ADMIN", ["SUPPORT_POLICY_EDIT", "SUPPORT_CASE_MANAGE", "SUPPORT_CASE_EDIT"])
        state.agent = user("AGENT", ["SUPPORT_CASE_EDIT"])
        state.reader = user("READER", [])
        state.otherAdmin = user("OTHER_ADMIN", ["SUPPORT_POLICY_EDIT", "SUPPORT_CASE_EDIT"], otherOrg)
        call("store#moqui.basic.email.EmailAccount", {
            emailAccountId: account,
            ownerUserId: state.admin,
            accountKindEnumId: "EakShared",
            emailAddress: "help@sch.example",
            accountName: "SCH help",
            statusId: "EasActive"
        })
        call("store#moqui.basic.email.EmailIdentity", {
            emailIdentityId: prefix + "_IDENTITY",
            emailAccountId: account,
            emailAddress: "help@sch.example",
            displayName: "Channel Spec Help",
            isDefault: "Y"
        })
        call("store#moqui.basic.email.EmailTextBlock", {
            emailTextBlockId: prefix + "_ACK",
            ownerUserId: state.admin,
            title: "Ack",
            bodyHtml: "<p>Thanks: case ${requestId} in ${queueName} is open.</p>"
        })
        state.queue = run(state.admin, S + "save#ServiceQueue", {
            organizationPartyId: org,
            description: "Channel Support"
        }).requestCategoryId
        state.otherQueue = run(state.otherAdmin, S + "save#ServiceQueue", {
            organizationPartyId: otherOrg,
            description: "Other Support"
        }).requestCategoryId
        run(state.admin, S + "save#ServiceDefaults", {
            organizationPartyId: org,
            defaultCategoryId: state.queue,
            unknownSenderEnumId: "SusReview"
        })
        run(state.otherAdmin, S + "save#ServiceDefaults", {organizationPartyId: otherOrg, defaultCategoryId: state.otherQueue})
        run(state.admin, "mantle.request.SlaServices.save#Policy", {
            organizationPartyId: org,
            policyName: "Channel spec",
            fromDate: new Date(receivedAt - 86400000),
            targets: [{priorityBandEnumId: "CpbNormal", firstResponseMinutes: 240, resolutionMinutes: 960, warningMinutes: 60}]
        })
    },
    setup() {
        ec.artifactExecution.disableAuthz()
    },
    cleanup() {
        ec.artifactExecution.enableAuthz()
        login("john.doe")
    }
})

feature("a queue's routes: mail with an acknowledgement, a replacement ending the first; the refusals", {
    when() {
        const route = {
            requestCategoryId: state.queue,
            channelEnumId: "SrcEmail",
            emailAccountId: account,
            acknowledge: "Y",
            ackTextBlockId: prefix + "_ACK",
            replyEmailIdentityId: prefix + "_IDENTITY"
        }
        const first = run(state.admin, S + "save#ServiceRoute", Object.assign({}, route, {defaultPriority: 3}))
        const second = run(state.admin, S + "save#ServiceRoute", Object.assign({}, route, {serviceRouteId: first.serviceRouteId}))
        state.mailRoute = second.serviceRouteId
        return {
            first,
            second,
            firstRow: one("mantle.request.support.ServiceRoute", {serviceRouteId: first.serviceRouteId}),
            inEffect: current("mantle.request.support.ServiceRoute", {requestCategoryId: state.queue}),
            agent: run(state.agent, S + "save#ServiceRoute", route),
            otherOrg: run(state.otherAdmin, S + "save#ServiceRoute", route),
            channel: run(state.admin, S + "save#ServiceRoute", Object.assign({}, route, {channelEnumId: "SrcPigeon"})),
            site: run(state.admin, S + "save#ServiceRoute", {requestCategoryId: state.queue, channelEnumId: "SrcForum"}),
            priority: run(state.admin, S + "save#ServiceRoute", Object.assign({}, route, {defaultPriority: 12})),
            block: run(state.admin, S + "save#ServiceRoute", Object.assign({}, route, {ackTextBlockId: "NO_SUCH_BLOCK"}))
        }
    },
    then({first, second, firstRow, inEffect, agent, otherOrg, channel, site, priority, block}) {
        first.error == ""
        second.error == ""
        firstRow.thruDate != null
        inEffect.length == 1
        inEffect[0].serviceRouteId == second.serviceRouteId
        code(agent) == "PERMISSION_DENIED"
        code(otherOrg) == "RECORD_UNAVAILABLE"
        code(channel) == "CHANNEL_INVALID"
        code(site) == "SITE_REQUIRED"
        code(priority) == "PRIORITY_INVALID"
        code(block) == "TEXT_BLOCK_UNAVAILABLE"
    }
})

feature("mail from a customer's contact is a case in the queue, timed by its received date, acknowledged once and no response", {
    when() {
        const id = receive({
            fromAddress: "dana.sch@example.com",
            fromName: "Dana Spec",
            subject: "SCH Thermostat is dark",
            bodyText: "It stopped this morning."
        })
        const out = mail(id)
        const requestId = requestOf(id)
        state.mailCase = requestId
        state.firstMessage = id
        const profile = profileOf(requestId)
        const acks = acksOf(requestId)
        const ackEvents = acks
            .map(ack => one("mantle.party.communication.CommunicationEvent", {emailMessageId: ack.emailMessageId}))
            .filter(Boolean)
            .filter(event =>
                one("mantle.request.RequestCommEvent", {requestId, communicationEventId: event.communicationEventId})
            )
        return {
            out,
            request: one(REQUEST, {requestId}),
            customerRow: current("mantle.request.RequestParty", {requestId, roleTypeId: "Customer"})[0],
            reporterRow: current("mantle.request.RequestParty", {requestId, roleTypeId: "Reporter"})[0],
            profile,
            first: one(EPISODE, {requestId, clockEnumId: "SlcFirstResponse", sequenceNum: 1}),
            acks,
            ackEvents,
            again: mail(id),
            count: rows(MAIL, {emailMessageId: id}).length
        }
    },
    then({out, request, customerRow, reporterRow, profile, first, acks, ackEvents, again, count}) {
        out.created == true
        request.requestCategoryId == state.queue
        request.statusId == "ReqSubmitted"
        request.salesChannelEnumId == "ScEmail"
        customerRow.partyId == customer
        reporterRow.partyId == contact
        profile != null
        ms(profile.intakeDate) == receivedAt
        profile.emailMessageId == state.firstMessage
        first != null
        ms(first.startDate) == receivedAt
        first.stateEnumId == "SlsRunning"
        acks.length == 1
        acks[0].bodyText.includes("case " + request.requestId + " in Channel Support is open")
        String(acks[0].headersString).includes("Auto-Submitted")
        ackEvents.length == 0
        again.created == false
        count == 1
    }
})

feature("a reply joins its case by its references; the case's token joins for its contact, not for a stranger", {
    when() {
        const first = one("moqui.basic.email.EmailMessage", {emailMessageId: state.firstMessage})
        const reply = receive({
            fromAddress: "dana.sch@example.com",
            subject: "Re: SCH Thermostat is dark",
            bodyText: "Still dark.",
            inReplyTo: first.messageId,
            referencesHeader: first.messageId
        })
        const replied = mail(reply)
        const token = receive({
            fromAddress: "dana.sch@example.com",
            subject: "More [Request " + state.mailCase + "]",
            bodyText: "A photo."
        })
        const tokened = mail(token)
        const guessed = receive({
            fromAddress: "sam.sch@example.com",
            subject: "Mine [Request " + state.mailCase + "]",
            bodyText: "Let me in."
        })
        const guessedOut = mail(guessed)
        // a stranger naming the case's Message-ID in forged headers joins nothing (not from or to that message)
        const forged = receive({
            fromAddress: "sam.sch@example.com",
            subject: "Re: SCH Thermostat is dark",
            bodyText: "Me too.",
            inReplyTo: first.messageId,
            referencesHeader: first.messageId
        })
        const forgedOut = mail(forged)
        return {
            replied,
            tokened,
            guessedOut,
            guessedRequest: requestOf(guessed),
            forgedOut,
            forgedRequest: requestOf(forged),
            acks: acksOf(state.mailCase).length
        }
    },
    then({replied, tokened, guessedOut, guessedRequest, forgedOut, forgedRequest, acks}) {
        forgedOut.joined == false
        forgedRequest != state.mailCase
        replied.joined == true
        replied.requestId == state.mailCase
        tokened.joined == true
        tokened.requestId == state.mailCase
        guessedOut.joined == false
        guessedRequest != state.mailCase
        // replies are never acknowledged
        acks == 1
    }
})

feature("an automatic reply attaches to its case as no reply, sends nothing and makes no case; one on no case makes nothing", {
    when() {
        const first = one("moqui.basic.email.EmailMessage", {emailMessageId: state.firstMessage})
        const before = rows(REQUEST, {requestCategoryId: state.queue}).length
        const auto = receive({
            fromAddress: "dana.sch@example.com",
            subject: "Out of office",
            bodyText: "Away until Monday.",
            inReplyTo: first.messageId,
            headersString: "Auto-Submitted: auto-replied"
        })
        const attached = mail(auto)
        const event = one("mantle.party.communication.CommunicationEvent", {emailMessageId: auto})
        const loose = receive({
            fromAddress: "dana.sch@example.com",
            subject: "Newsletter",
            bodyText: "News.",
            headersString: "Precedence: bulk"
        })
        const ignored = mail(loose)
        return {
            attached,
            purpose: event
                ? one("mantle.party.communication.CommunicationEventPurpose", {
                      communicationEventId: event.communicationEventId,
                      purposeEnumId: "CpAcknowledgement"
                  })
                : null,
            replies: rows("mantle.request.support.CaseSlaEvent", {
                requestId: state.mailCase,
                eventTypeEnumId: "SetCustomerReply"
            }).filter(row => row.communicationEventId === event?.communicationEventId),
            ignored,
            looseRequest: requestOf(loose),
            after: rows(REQUEST, {requestCategoryId: state.queue}).length,
            before,
            acks: acksOf(state.mailCase).length
        }
    },
    then({attached, purpose, replies, ignored, looseRequest, after, before, acks}) {
        attached.joined == true
        attached.requestId == state.mailCase
        purpose != null
        replies.length == 0
        ignored.created == false
        looseRequest == null
        after == before
        acks == 1
    }
})

feature("an unknown sender and staff are held for review, not cases; a held request is accepted or dismissed", {
    when() {
        const unknown = receive({
            fromAddress: "nobody.sch@example.net",
            fromName: "Nora Body",
            subject: "SCH who are you",
            bodyText: "Hello."
        })
        mail(unknown)
        const staff = receive({fromAddress: "erin.sch@example.com", subject: "SCH internal note", bodyText: "FYI."})
        mail(staff)
        const unknownId = requestOf(unknown),
            staffId = requestOf(staff)
        state.held = unknownId
        const reporter = current("mantle.request.RequestParty", {requestId: unknownId, roleTypeId: "Reporter"})[0]
        const heldProfile = profileOf(unknownId, false)
        const staffProfile = profileOf(staffId, false)
        const reporterRole = one("mantle.party.PartyRole", {partyId: reporter?.partyId, roleTypeId: "Customer"})
        const other = run(state.otherAdmin, S + "review#HeldRequest", {requestId: unknownId, decision: "accept"})
        const reader = run(state.reader, S + "review#HeldRequest", {requestId: unknownId, decision: "accept"})
        const staffAccept = run(state.agent, S + "review#HeldRequest", {requestId: staffId, decision: "accept"})
        const accepted = run(state.agent, S + "review#HeldRequest", {requestId: unknownId, decision: "accept"})
        const dismissed = run(state.agent, S + "review#HeldRequest", {
            requestId: staffId,
            decision: "dismiss",
            reason: "Internal"
        })
        return {
            request: one(REQUEST, {requestId: unknownId}),
            notes: rows("mantle.request.RequestNote", {requestId: unknownId}),
            acks: acksOf(unknownId).length,
            heldProfile,
            staffProfile,
            reporterRole,
            other,
            reader,
            staffAccept,
            accepted,
            acceptedProfile: one(PROFILE, {requestId: unknownId}),
            again: run(state.agent, S + "review#HeldRequest", {requestId: unknownId, decision: "dismiss"}),
            dismissed,
            staffRequest: one(REQUEST, {requestId: staffId})
        }
    },
    then(r) {
        r.request.requestCategoryId == state.queue
        r.notes.some(note => String(note.noteText).includes("unknown sender"))
        r.acks == 0
        r.heldProfile == null
        r.staffProfile == null
        r.reporterRole == null
        code(r.other) == "RECORD_UNAVAILABLE"
        code(r.reader) == "PERMISSION_DENIED"
        code(r.staffAccept) == "CUSTOMER_REQUIRED"
        r.accepted.isCase == true
        r.acceptedProfile != null
        code(r.again) == "NOT_HELD"
        r.dismissed.statusId == "ReqCancelled"
        r.staffRequest.statusId == "ReqCancelled"
    }
})

feature("the dry run names the outcome without writing; a route that ignores unknown senders makes nothing", {
    when() {
        const before = rows(REQUEST, {requestCategoryId: state.queue}).length
        const preview = p =>
            run(
                state.admin,
                S + "preview#ServiceRoute",
                Object.assign({requestCategoryId: state.queue, emailAccountId: account}, p)
            )
        const customerOut = preview({fromAddress: "dana.sch@example.com", subject: "New"})
        const unknownOut = preview({fromAddress: "x.sch@example.org", subject: "Hi"})
        const autoOut = preview({
            fromAddress: "dana.sch@example.com",
            subject: "Away",
            headersString: "Auto-Submitted: auto-replied"
        })
        const tokenOut = preview({fromAddress: "dana.sch@example.com", subject: "[Request " + state.mailCase + "] more"})
        const agentOut = run(state.agent, S + "preview#ServiceRoute", {
            requestCategoryId: state.queue,
            fromAddress: "dana.sch@example.com"
        })
        run(state.admin, S + "save#ServiceRoute", {
            serviceRouteId: state.mailRoute,
            requestCategoryId: state.queue,
            channelEnumId: "SrcEmail",
            emailAccountId: account,
            acknowledge: "Y",
            ackTextBlockId: prefix + "_ACK",
            unknownSenderEnumId: "SusIgnore"
        })
        const ignoredId = receive({fromAddress: "y.sch@example.org", subject: "SCH ignored", bodyText: "Hi."})
        const ignored = mail(ignoredId)
        return {
            customerOut,
            unknownOut,
            autoOut,
            tokenOut,
            agentOut,
            ignored,
            made: requestOf(ignoredId),
            before,
            after: rows(REQUEST, {requestCategoryId: state.queue}).length
        }
    },
    then({customerOut, unknownOut, autoOut, tokenOut, agentOut, ignored, made, before, after}) {
        customerOut.preview.outcome == "case"
        customerOut.preview.customerPartyId == customer
        customerOut.preview.acknowledged == true
        unknownOut.preview.outcome == "held"
        unknownOut.preview.senderKind == "unknown"
        autoOut.preview.outcome == "ignore"
        tokenOut.preview.outcome == "join"
        tokenOut.preview.threadBy == "token"
        code(agentOut) == "PERMISSION_DENIED"
        ignored.created == false
        made == null
        after == before
    }
})

feature(
    "a queue's intake token: issued, a form of a customer a case and of an unknown address held, the queue's limit, revoked",
    {
        when() {
            run(state.admin, S + "save#ServiceRoute", {
                requestCategoryId: state.queue,
                channelEnumId: "SrcWebForm",
                rateLimitPerHour: 3,
                tokenValidDays: 30
            })
            const agent = run(state.agent, R + "create#IntakeToken", {requestCategoryId: state.queue})
            const other = run(state.otherAdmin, R + "create#IntakeToken", {requestCategoryId: state.queue})
            const issued = run(state.admin, R + "create#IntakeToken", {requestCategoryId: state.queue})
            const form = fields =>
                run(
                    "john.doe",
                    R + "create#IntakeRequest",
                    Object.assign(
                        {
                            token: issued.token,
                            firstName: "Dana",
                            lastName: "Spec",
                            requestName: "SCH form",
                            description: "From the form"
                        },
                        fields
                    )
                )
            const customerForm = form({emailAddress: "dana.sch@example.com"})
            const unknownForm = form({emailAddress: "zed.sch@example.org", firstName: "Zed"})
            const third = form({emailAddress: "una.sch@example.org", firstName: "Una"})
            const overLimit = form({emailAddress: "vic.sch@example.org", firstName: "Vic"})
            // a party-less kind is reached by its token only, never by a signed-in contact
            let contactPath = ""
            try {
                ec.resource
                    .script("component://mr-mantle/service/mantle/party/ExternalAccess.js")
                    .check({recordType: "RequestCategory", scope: "CaseIntake", recordId: state.queue, organizationPartyId: org})
            } catch (error) {
                contactPath = String(error.message)
            }
            const removed = run(state.admin, R + "remove#IntakeToken", {requestCategoryId: state.queue})
            const afterRemove = form({emailAddress: "dana.sch@example.com"})
            return {
                agent,
                other,
                issued,
                customerForm,
                unknownForm,
                overLimit,
                contactPath,
                removed,
                afterRemove,
                customerRequest: one(REQUEST, {requestId: customerForm.requestId}),
                customerProfile: profileOf(customerForm.requestId),
                unknownProfile: profileOf(unknownForm.requestId, false),
                capability: one("mantle.party.ExternalAccessCapability", {
                    recordType: "RequestCategory",
                    recordId: state.queue,
                    revokedDate: null
                })
            }
        },
        then(r) {
            code(r.agent) == "PERMISSION_DENIED"
            code(r.other) == "ORGANIZATION_REQUIRED" || code(r.other) == "RECORD_UNAVAILABLE" || r.other.error.length > 0
            r.issued.token != null
            r.customerForm.received == true
            r.customerRequest.requestCategoryId == state.queue
            r.customerRequest.salesChannelEnumId == "ScWeb"
            r.customerProfile != null
            r.unknownForm.requestId != null
            r.unknownProfile == null
            r.overLimit.error.includes("no more requests")
            r.contactPath.includes("not available")
            r.removed.error == ""
            r.afterRemove.error.includes("not available")
            r.capability == null
        }
    }
)

feature("a logged call: one that reached the customer meets first response, an internal one does not; the refusals", {
    when() {
        const made = run(state.agent, S + "create#Case", {
            organizationPartyId: org,
            customerPartyId: customer,
            contactPartyId: contact,
            requestName: "SCH call case"
        })
        const requestId = made.requestId
        const internal = run(state.agent, S + "log#CaseCall", {
            requestId,
            direction: "out",
            summary: "Asked the warehouse",
            internal: "Y",
            durationMinutes: 3
        })
        const firstAfterInternal = one(EPISODE, {requestId, clockEnumId: "SlcFirstResponse", sequenceNum: 1})?.stateEnumId
        const reached = run(state.agent, S + "log#CaseCall", {
            requestId,
            direction: "out",
            summary: "Walked through a reset",
            outcomeEnumId: "CcoReached",
            durationMinutes: 12
        })
        const event = one("mantle.party.communication.CommunicationEvent", {communicationEventId: reached.communicationEventId})
        return {
            internal,
            firstAfterInternal,
            reached,
            event,
            linked: one("mantle.request.RequestCommEvent", {requestId, communicationEventId: reached.communicationEventId}),
            first: one(EPISODE, {requestId, clockEnumId: "SlcFirstResponse", sequenceNum: 1}),
            noSummary: run(state.agent, S + "log#CaseCall", {requestId, summary: " "}),
            reader: run(state.reader, S + "log#CaseCall", {requestId, summary: "x"}),
            strangerCall: run(state.agent, S + "log#CaseCall", {requestId, summary: "x", contactPartyId: stranger}),
            otherOrg: run(state.otherAdmin, S + "log#CaseCall", {requestId, summary: "x"})
        }
    },
    then(r) {
        r.internal.error == ""
        r.firstAfterInternal == "SlsRunning"
        r.reached.error == ""
        r.event.communicationEventTypeId == "Phone"
        r.event.fromPartyId == state.agent
        r.event.toPartyId == contact
        ms(r.event.datetimeEnded) - ms(r.event.datetimeStarted) == 12 * 60000
        r.linked != null
        r.first.stateEnumId == "SlsMet"
        code(r.noSummary) == "SUMMARY_REQUIRED"
        code(r.reader) == "PERMISSION_DENIED"
        code(r.strangerCall) == "CONTACT_UNAVAILABLE"
        code(r.otherOrg) == "RECORD_UNAVAILABLE"
    }
})

feature("a forum topic escalated through a route is a Submitted case in the queue on channel ScForum, its poster the customer", {
    when() {
        // the forum's writes that take an operation id (as mr-pass's Integrations spec)
        const forum = (name, input) =>
            call(name, {
                input: /publish#Post$|create#CaseFromTopic$|store#Category$/.test(name)
                    ? Object.assign({operationId: ec.user.randomString(32)}, input)
                    : input
            }).result
        const siteId = forum("mantle.public.SiteServices.create#Site", {
            name: "Channel spec forum",
            ownerPartyId: ec.user.userAccount.partyId
        }).siteId
        forum("mantle.public.SiteServices.update#Site", {siteId, state: "published", expectedRevision: 1})
        const categoryId = forum(F + "store#Category", {siteId, name: "Help"}).contactListId
        forum(F + "set#CategoryAccess", {
            siteId,
            contactListId: categoryId,
            visibility: "public",
            publicationState: "published",
            expectedRevision: 1,
            confirm: true
        })
        const poster = call("mantle.party.PartyServices.create#Person", {firstName: "Pat", lastName: "Poster"}).partyId
        call("mantle.party.PartyServices.create#PartyUserAccount", {
            partyId: poster,
            username: "sch.poster",
            emailAddress: "pat.sch@example.test",
            newPassword: "moqui1!!",
            newPasswordVerify: "moqui1!!"
        })
        const at = Date.now()
        call("create#mantle.public.PublicSiteParty", {
            siteId,
            partyId: poster,
            state: "active",
            role: "member",
            joinedAt: at,
            revision: 1
        })
        call("create#mantle.public.PublicSiteProfile", {
            siteId,
            partyId: poster,
            handle: "pat",
            displayName: "pat",
            discoverability: "members",
            revision: 1
        })
        for (const partyId of [poster, ec.user.userAccount.partyId]) {
            call("create#mantle.marketing.contact.ContactListParty", {
                contactListId: categoryId,
                partyId,
                statusId: "CLPT_ACCEPTED",
                fromDate: at - 1000
            })
            call("store#mantle.forum.ForumMemberState", {
                siteId,
                partyId,
                trustLevel: "basic",
                approvedContributions: 10,
                dailyTopics: 0,
                dailyReplies: 0,
                revision: 1
            })
        }
        login("sch.poster", "moqui1!!")
        const rootId = forum(F + "publish#Post", {
            siteId,
            contactListId: categoryId,
            title: "SCH heater",
            body: "<p>No heat</p>"
        }).rootCommEventId
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        const route = run(state.admin, S + "save#ServiceRoute", {
            requestCategoryId: state.queue,
            channelEnumId: "SrcForum",
            siteId,
            forumContactListId: categoryId,
            defaultPriority: 4
        })
        const clash = run(state.otherAdmin, S + "save#ServiceRoute", {
            requestCategoryId: state.otherQueue,
            channelEnumId: "SrcForum",
            siteId,
            forumContactListId: categoryId
        })
        const created = forum(F + "create#CaseFromTopic", {
            siteId,
            rootCommEventId: rootId,
            postIds: [rootId],
            reason: "Heater fault"
        })
        return {
            route,
            clash,
            request: one(REQUEST, {requestId: created.requestId}),
            profile: profileOf(created.requestId),
            customerRow: current("mantle.request.RequestParty", {requestId: created.requestId, roleTypeId: "Customer"})[0],
            poster
        }
    },
    then({route, clash, request, profile, customerRow, poster}) {
        route.error == ""
        code(clash) == "ROUTE_EXISTS"
        request.statusId == "ReqSubmitted"
        request.requestCategoryId == state.queue
        request.salesChannelEnumId == "ScForum"
        request.priority == 4
        customerRow.partyId == poster
        profile != null
    }
})
