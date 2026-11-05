// Saved replies on a case (impl-customer-service P5: CS-REPLIES, D24; mantle.request.SupportCaseServices preview#SavedReply,
// apply#SavedReply; SavedReplies.js): the preview resolves the variables for the case and names an unsupported variable and
// one with no value as errors, the recipient and each action's check; a personal reply is its owner's only and a team's
// reply its members'; the apply runs the actions and sends the reply through the mail client in one transaction, filed on
// the case once sent; a retry answers the first result; a send that failed is retried by its message ID without a second
// reply; a stale revision, no permission and another organization's case are refused; Comms' find#EmailTextBlocks still
// lists the user's own and shared blocks. Standalone: spec-local organizations, customer and contact, users, team, mail
// server and account; the mail capture keeps the sends. Run: ./moq test mr-mantle --spec SupportReplies
const prefix = "SRP"
const org = prefix + "_ORG",
    otherOrg = prefix + "_OTHER_ORG",
    customer = prefix + "_CUST",
    contact = prefix + "_CONTACT",
    since = "2000-01-01T00:00:00Z"
const S = "mantle.request.SupportCaseServices."
const find = (entity, conditions = {}) => ec.entity.find(entity).condition(conditions).disableAuthz()
const one = (entity, conditions) => find(entity, conditions).one()
const rows = (entity, conditions) => Array.from(find(entity, conditions).list())
const capture = ec.factory.getTool("MailCapture")
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
    call("create#moqui.security.UserGroup", {userGroupId: id, description: "Saved reply " + kind})
    for (const permission of permissions)
        call("create#moqui.security.UserGroupPermission", {userGroupId: id, userPermissionId: permission, fromDate: since})
    call("create#mantle.party.Party", {partyId: id, partyTypeEnumId: "PtyPerson"})
    call("create#mantle.party.Person", {partyId: id, firstName: "Reply", lastName: kind})
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
function party(partyId, name, roleTypeId, ownerPartyId, typeId = "PtyOrganization") {
    call("create#mantle.party.Party", {partyId, partyTypeEnumId: typeId, ownerPartyId: ownerPartyId || "_NA_"})
    if (typeId === "PtyOrganization") call("create#mantle.party.Organization", {partyId, organizationName: name})
    else call("create#mantle.party.Person", {partyId, firstName: name, lastName: "Spec"})
    if (roleTypeId) call("create#mantle.party.PartyRole", {partyId, roleTypeId})
}
function email(partyId, address) {
    const contactMechId = call("create#mantle.party.contact.ContactMech", {
        contactMechTypeEnumId: "CmtEmailAddress",
        infoString: address
    }).contactMechId
    call("create#mantle.party.contact.PartyContactMech", {
        partyId,
        contactMechId,
        contactMechPurposeId: "EmailPrimary",
        fromDate: since
    })
}
// a text block of a user (a Comms text block: own, or shared with a group the user is in), with its saved reply facts
function block(username, title, bodyHtml, userGroupId = null, actions = []) {
    login(username)
    ec.artifactExecution.disableAuthz()
    const emailTextBlockId = call("org.moqui.impl.EmailClientServices.create#EmailTextBlock", {
        title,
        bodyHtml,
        userGroupId
    }).emailTextBlockId
    login("john.doe")
    ec.artifactExecution.disableAuthz()
    call("create#mantle.request.support.SavedReply", {emailTextBlockId, organizationPartyId: org, localeId: "en"})
    actions.forEach((action, index) =>
        call("create#mantle.request.support.SavedReplyAction", Object.assign({emailTextBlockId, sequenceNum: index + 1}, action))
    )
    return emailTextBlockId
}
const newCase = (organizationPartyId = org, customerPartyId = customer, username = state.agent) =>
    run(username, S + "create#Case", {
        organizationPartyId,
        customerPartyId,
        contactPartyId: customerPartyId === customer ? contact : null,
        requestName: "Spec reply case"
    }).requestId
const revision = requestId => run(state.agent, S + "update#Case", {requestId}).revision
// the message once its send commits (send#Draft sends after the commit, on a service worker)
function messageOf(emailMessageId) {
    const end = Date.now() + 5000
    let message = one("moqui.basic.email.EmailMessage", {emailMessageId})
    while (message && !["ES_SENT", "ES_BOUNCED"].includes(message.statusId) && message.sendError == null && Date.now() < end)
        message = one("moqui.basic.email.EmailMessage", {emailMessageId})
    return message
}
const filed = (requestId, emailMessageId) => {
    const end = Date.now() + 5000
    const count = () =>
        rows("mantle.request.RequestCommEvent", {requestId}).filter(
            row =>
                one("mantle.party.communication.CommunicationEvent", {communicationEventId: row.communicationEventId})
                    ?.emailMessageId == emailMessageId
        ).length
    let found = count()
    while (!found && Date.now() < end) found = count()
    return found
}

// a published site of the organization with the Support app (P15), made or removed
function supportSite(on) {
    const siteId = prefix + "_SITE"
    if (!on) {
        for (const entity of ["mantle.public.PublicSiteApp", "mantle.public.PublicSiteHost", "mantle.public.PublicSite"])
            find(entity, {siteId}).deleteAll()
        return
    }
    call("create#mantle.public.PublicSite", {
        siteId,
        name: "Reply spec site",
        state: "published",
        registrationMode: "invitation",
        locale: "en",
        timeZone: "UTC",
        policyRevision: 1,
        generation: 1
    })
    call("create#mantle.public.PublicSiteHost", {hostname: "srp.example.test", siteId, canonical: "Y"})
    call("create#mantle.public.PublicSiteApp", {
        siteId,
        appMountId: "support",
        app: "support",
        pathPrefix: "/support",
        enabled: "Y",
        targetId: org
    })
}

spec({
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        capture.enable()
        party(org, "Reply Spec Org", "OrgInternal")
        party(otherOrg, "Reply Spec Other Org", "OrgInternal")
        party(customer, "Reply Spec Customer", "Customer", org)
        party(contact, "Riley", null, null, "PtyPerson")
        party(prefix + "_OTHER_CUST", "Reply Spec Other Customer", "Customer", otherOrg)
        email(contact, "riley@reply-customer.example")
        email(customer, "office@reply-customer.example")
        call("create#mantle.party.PartyRelationship", {
            relationshipTypeEnumId: "PrtContact",
            fromPartyId: contact,
            toPartyId: customer,
            fromDate: since
        })
        state.admin = user("ADMIN", ["SUPPORT_POLICY_EDIT", "SUPPORT_CASE_MANAGE", "SUPPORT_CASE_EDIT"])
        state.agent = user("AGENT", ["SUPPORT_CASE_EDIT"])
        state.agent2 = user("AGENT2", ["SUPPORT_CASE_EDIT"])
        state.reader = user("READER", [])
        state.otherAdmin = user("OTHER_ADMIN", ["SUPPORT_POLICY_EDIT", "SUPPORT_CASE_MANAGE", "SUPPORT_CASE_EDIT"], otherOrg)
        state.team = run(state.admin, S + "save#ServiceTeam", {organizationPartyId: org, teamName: "Spec reply team"}).teamPartyId
        run(state.admin, S + "save#ServiceTeamMember", {teamPartyId: state.team, partyId: state.agent})
        state.queue = run(state.admin, S + "save#ServiceQueue", {
            organizationPartyId: org,
            description: "Spec reply queue",
            responsibleTeamPartyId: state.team
        }).requestCategoryId
        run(state.admin, S + "save#ServiceDefaults", {organizationPartyId: org, defaultCategoryId: state.queue})
        const otherQueue = run(state.otherAdmin, S + "save#ServiceQueue", {
            organizationPartyId: otherOrg,
            description: "Other"
        }).requestCategoryId
        run(state.otherAdmin, S + "save#ServiceDefaults", {organizationPartyId: otherOrg, defaultCategoryId: otherQueue})
        call("create#moqui.basic.email.EmailServer", {
            emailServerId: prefix + "_MAIL",
            smtpHost: "127.0.0.1",
            smtpPort: 9,
            smtpStartTls: "N",
            smtpSsl: "N"
        })
        call("create#moqui.basic.email.EmailAccount", {
            emailAccountId: prefix + "_ACCOUNT",
            ownerPartyId: org,
            accountKindEnumId: "EakShared",
            emailServerId: prefix + "_MAIL",
            emailAddress: "service@reply-org.example",
            accountName: "Reply spec service mail",
            statusId: "EasActive",
            recordFilingEnumId: "ErfLinkedOnly"
        })
        for (const userId of [state.agent, state.agent2])
            call("create#moqui.basic.email.EmailAccountUser", {
                emailAccountId: prefix + "_ACCOUNT",
                userId,
                fromDate: since,
                permissionEnumId: "EapSend"
            })
        // the team's reply (shared with the team's group) with a tag and the wait for the customer; a personal one; one with
        // a variable no reply may use and one with a value the case lacks
        state.groupId = "SVT_" + state.team
        state.teamReply = block(
            state.agent,
            "Spec need details",
            "<p>Hello {{contactFirstName}}, this is {{agentName}} about case {{caseId}} for {{customerName}}.</p>",
            state.groupId,
            [
                {actionEnumId: "SraAddTag", tagEnumId: "RtgFollowUp"},
                {actionEnumId: "SraSetStatus", statusId: "ReqWaitingCustomer"}
            ]
        )
        state.personal = block(state.agent, "Spec personal", "<p>Thanks, {{customerName}}.</p>")
        state.unsupported = block(state.agent, "Spec unsupported", "<p>Your refund of {{refundAmount}} is on its way.</p>")
        state.forbidden = block(state.agent, "Spec forbidden", "<p>Done.</p>", null, [
            {actionEnumId: "SraSetStatus", statusId: "ReqDraft"}
        ])
    },
    setup() {
        ec.artifactExecution.disableAuthz()
    },
    cleanup() {
        ec.artifactExecution.enableAuthz()
        login("john.doe")
    },
    cleanupSpec() {
        capture.reset()
        ec.artifactExecution.enableAuthz()
    }
})

feature("the preview resolves the case's values, names the recipient and checks each action; variable errors are errors", {
    when() {
        state.caseA = newCase()
        const preview = run(state.agent, S + "preview#SavedReply", {
            requestId: state.caseA,
            emailTextBlockId: state.teamReply
        }).preview
        const unsupported = run(state.agent, S + "preview#SavedReply", {
            requestId: state.caseA,
            emailTextBlockId: state.unsupported
        }).preview
        const forbidden = run(state.agent, S + "preview#SavedReply", {
            requestId: state.caseA,
            emailTextBlockId: state.forbidden
        }).preview
        const applyUnsupported = run(state.agent, S + "apply#SavedReply", {
            requestId: state.caseA,
            emailTextBlockId: state.unsupported,
            operationKey: prefix + "-unsupported"
        })
        return {preview, unsupported, forbidden, applyUnsupported}
    },
    then({preview, unsupported, forbidden, applyUnsupported}) {
        preview.bodyHtml.includes("Hello Riley, this is Reply AGENT about case " + state.caseA + " for Reply Spec Customer")
        preview.errors.length == 0
        preview.recipients.map(row => row.address) == ["riley@reply-customer.example"]
        preview.actions.map(row => row.allowed) == [true, true]
        preview.canApply == true
        unsupported.errors.map(row => row.reasonCode) == ["UNSUPPORTED_VARIABLE"]
        unsupported.canApply == false
        forbidden.actions[0].reasonCode == "TRANSITION_NOT_ALLOWED"
        forbidden.canApply == false
        code(applyUnsupported) == "UNSUPPORTED_VARIABLE"
    }
})

feature("a personal reply is its owner's only, a team's reply its members'; Comms still lists the user's own and shared blocks", {
    when() {
        const otherAgent = run(state.agent2, S + "preview#SavedReply", {requestId: state.caseA, emailTextBlockId: state.personal})
        const nonMember = run(state.agent2, S + "preview#SavedReply", {requestId: state.caseA, emailTextBlockId: state.teamReply})
        login(state.agent)
        const listed = call("org.moqui.impl.EmailClientServices.find#EmailTextBlocks", {}).textBlockList.map(
            row => row.emailTextBlockId
        )
        login(state.agent2)
        const listed2 = call("org.moqui.impl.EmailClientServices.find#EmailTextBlocks", {}).textBlockList.map(
            row => row.emailTextBlockId
        )
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        return {otherAgent, nonMember, listed, listed2}
    },
    then({otherAgent, nonMember, listed, listed2}) {
        code(otherAgent) == "REPLY_UNAVAILABLE"
        code(nonMember) == "REPLY_UNAVAILABLE"
        listed.includes(state.teamReply)
        listed.includes(state.personal)
        !listed2.includes(state.teamReply)
        !listed2.includes(state.personal)
    }
})

feature("the apply runs the actions and sends the reply on the case's thread, filed once sent; a retry answers the first", {
    when() {
        capture.clear()
        const before = revision(state.caseA)
        // P15 (F60): with a published site with the Support app the reply to the case's contact carries the case's link
        supportSite(true)
        let applied
        try {
            applied = run(state.agent, S + "apply#SavedReply", {
                requestId: state.caseA,
                emailTextBlockId: state.teamReply,
                caseRevision: before,
                operationKey: prefix + "-apply"
            })
        } finally {
            supportSite(false)
        }
        const message = messageOf(applied.emailMessageId)
        const retry = run(state.agent, S + "apply#SavedReply", {
            requestId: state.caseA,
            emailTextBlockId: state.teamReply,
            caseRevision: before,
            operationKey: prefix + "-apply"
        })
        return {
            applied,
            message,
            retry,
            sent: capture.getMessages().filter(row => row.toList.includes("riley@reply-customer.example")),
            request: one("mantle.request.Request", {requestId: state.caseA}),
            tags: rows("mantle.request.RequestTag", {requestId: state.caseA}).map(row => row.tagEnumId),
            filed: filed(state.caseA, applied.emailMessageId),
            stale: run(state.agent, S + "apply#SavedReply", {
                requestId: state.caseA,
                emailTextBlockId: state.personal,
                caseRevision: before,
                operationKey: prefix + "-stale"
            })
        }
    },
    then(r) {
        r.applied.error == ""
        r.applied.alreadyApplied == false
        r.message.statusId == "ES_SENT"
        r.retry.alreadyApplied == true
        r.retry.emailMessageId == r.applied.emailMessageId
        r.sent.length == 1
        r.sent[0].subject.includes(state.caseA)
        r.message.body.includes("https://srp.example.test/support/CustomerCase?token=")
        rows("mantle.party.ExternalAccessCapability", {recordType: "Request", recordId: state.caseA}).length == 1
        r.request.statusId == "ReqWaitingCustomer"
        r.tags.includes("RtgFollowUp")
        r.filed == 1
        code(r.stale) == "STALE_CASE"
    }
})

feature("a failed delivery keeps its failed state and is retried by its message ID without a second reply", {
    when() {
        const requestId = newCase()
        capture.disable()
        let failed
        try {
            failed = run(state.agent, S + "apply#SavedReply", {
                requestId,
                emailTextBlockId: state.personal,
                operationKey: prefix + "-failed"
            })
            messageOf(failed.emailMessageId)
        } finally {
            capture.enable()
        }
        const failedMessage = one("moqui.basic.email.EmailMessage", {emailMessageId: failed.emailMessageId})
        capture.clear()
        const retried = run(state.agent, S + "apply#SavedReply", {
            requestId,
            emailTextBlockId: state.personal,
            operationKey: prefix + "-failed"
        })
        const message = messageOf(failed.emailMessageId)
        return {
            failed,
            failedMessage,
            retried,
            message,
            sent: capture.count(),
            drafts: rows("moqui.basic.email.EmailMessage", {emailAccountId: prefix + "_ACCOUNT"}).filter(row =>
                String(row.subject || "").includes(requestId)
            ).length
        }
    },
    then(r) {
        r.failed.error == ""
        r.failedMessage.sendError != null
        r.retried.alreadyApplied == true
        r.retried.result.retried == true
        r.retried.emailMessageId == r.failed.emailMessageId
        r.message.statusId == "ES_SENT"
        // no Support site now: the reply goes without the link (logged)
        !String(r.message.body).includes("CustomerCase?token=")
        r.sent == 1
        r.drafts == 1
    }
})

feature("the apply is refused without the permission and on another organization's case", {
    when() {
        const otherCase = newCase(otherOrg, prefix + "_OTHER_CUST", state.otherAdmin)
        return {
            reader: run(state.reader, S + "apply#SavedReply", {
                requestId: state.caseA,
                emailTextBlockId: state.personal,
                operationKey: prefix + "-reader"
            }),
            other: run(state.agent, S + "apply#SavedReply", {
                requestId: otherCase,
                emailTextBlockId: state.personal,
                operationKey: prefix + "-other"
            })
        }
    },
    then({reader, other}) {
        code(reader) == "PERMISSION_DENIED"
        code(other) == "RECORD_UNAVAILABLE"
    }
})
