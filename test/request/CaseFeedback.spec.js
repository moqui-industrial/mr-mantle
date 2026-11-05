// Case feedback (impl-customer-service P13: CS-FEEDBACK, CS-JOBS, F16, F61; mantle.request.CaseFeedbackServices,
// CaseFeedback.js; Commons' FormInvitation, FormPublication.js): a feedback form made and published with its refusals
// (permission, another organization's, no rating) and the delivery policy's (an unpublished form); a resolved case invited once
// by the rule after the commit, a second try answering ALREADY_INVITED, a case of an organization with no policy invited by
// nothing; the send job sending it once with its link, and a rerun sending nothing; the Feedback page's read (the form, the
// customer's label, never the case) and a forged token's NotFound, as a good one's on another organization's site; a submit
// refused without its rating, then a rating of 2 with a comment kept as one response, a repeat answering the first, the low
// score's follow-up assigned to the team's manager and told, never naming the comment; a feedback form refused as a queue's
// case template; the follow-up recorded by the manager and refused an agent of another team; the framework's
// update#FormResponse and delete#FormResponse refused on the invited response and unchanged for a response with no
// invitation. Standalone: spec-local organizations, customer, team, queue, site, groups and users, artifact authorization
// disabled (the rules are the services' own checks). Run: ./moq test mr-mantle --spec CaseFeedback
const prefix = "CFB"
const org = prefix + "_ORG",
    otherOrg = prefix + "_OTHER_ORG",
    customer = prefix + "_CUST",
    otherCustomer = prefix + "_CUST2",
    siteId = prefix + "_SITE",
    otherSiteId = prefix + "_OTHER_SITE",
    since = "2000-01-01T00:00:00Z"
const S = "mantle.request.SupportCaseServices.",
    F = "mantle.request.CaseFeedbackServices.",
    D = "org.moqui.impl.ScreenServices."
const INVITATION = "mantle.party.FormInvitation",
    FOLLOW_UP = "mantle.request.support.FeedbackFollowUp",
    CAPABILITY = "mantle.party.ExternalAccessCapability"
const find = (entity, conditions = {}) => ec.entity.find(entity).condition(conditions).disableAuthz()
const one = (entity, conditions) => find(entity, conditions).one()
const rows = (entity, conditions) => Array.from(find(entity, conditions).list())
const state = {}

// a call as a user: its result with its error text ("" when it succeeds), in its own transaction
function run(username, service, parameters) {
    login(username)
    ec.artifactExecution.disableAuthz()
    ec.message.pushErrors()
    try {
        const out = ec.service.sync().name(service).parameters(parameters).requireNewTransaction(true).call() || {}
        return Object.assign({}, out, {error: ec.message.hasError() ? ec.message.getErrorsString() : ""})
    } catch (error) {
        return {error: String(error.message || error), kind: error.moquiErrorKind || null}
    } finally {
        ec.message.clearErrors()
        ec.message.popErrors()
        login("john.doe")
        ec.artifactExecution.disableAuthz()
    }
}
const code = out => (/([A-Z][A-Z0-9_]+):/.exec(out.error || "") || [])[1] || (out.error ? "ERROR" : "")
// a PASS operation (its checks are the token's, not the user's): its result, or the error kind
function page(service, input) {
    ec.artifactExecution.disableAuthz()
    ec.message.pushErrors()
    try {
        // as pass.Facade calls it, so the error's kind reaches the page
        return ec.service.sync().throwOnError(true).name(service).parameters({input}).requireNewTransaction(true).call().result
    } catch (error) {
        return {kind: error.moquiErrorKind || "Error", error: String(error.message)}
    } finally {
        ec.message.clearErrors()
        ec.message.popErrors()
        login("john.doe")
        ec.artifactExecution.disableAuthz()
    }
}
function waitFor(read, millis = 5000) {
    const end = Date.now() + millis
    let value = read()
    while (!value && Date.now() < end) value = read()
    return value
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
function user(kind, permissions, organizationPartyId = org) {
    const id = prefix + "_" + kind
    call("create#moqui.security.UserGroup", {userGroupId: id, description: "Case feedback " + kind})
    for (const permission of permissions)
        call("create#moqui.security.UserGroupPermission", {userGroupId: id, userPermissionId: permission, fromDate: since})
    party(id, "Feedback " + kind, null, organizationPartyId, "PtyPerson")
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
let caseCount = 0
function resolvedCase(organizationPartyId = org, customerPartyId = customer, username = state.agent) {
    caseCount++
    const requestId = run(username, S + "create#Case", {
        organizationPartyId,
        customerPartyId,
        requestName: "Feedback case " + caseCount
    }).requestId
    const manager = organizationPartyId === org ? state.manager : state.otherManager
    run(manager, S + "transition#Case", {requestId, toStatusId: "ReqCompleted", resolutionEnumId: "RrCompleted"})
    return requestId
}
const invitationOf = requestId => rows(INVITATION, {recordEntityName: "mantle.request.Request", recordId: requestId})[0] || null
// a link of the invitation with a token the spec knows (the send job's own token is mailed, never kept)
function link(invitationId, token) {
    call("create#" + CAPABILITY, {
        organizationPartyId: org,
        partyId: customer,
        recordType: "FormInvitation",
        recordId: invitationId,
        scopes: "CaseFeedback",
        tokenDigest: ec.user.singleUseCodeHash(token),
        fromDate: ec.user.nowTimestamp,
        thruDate: new Date(Date.now() + 7 * 86400000),
        createdByUserId: ec.user.userId
    })
    return token
}

spec({
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        party(org, "Feedback Spec Org", "OrgInternal", null, "PtyOrganization", "service@feedback-spec.example.test")
        party(otherOrg, "Feedback Spec Other Org", "OrgInternal")
        party(customer, "Feedback Spec Customer", "Customer", org, "PtyOrganization", "buyer@feedback-customer.example.test")
        party(otherCustomer, "Feedback Spec Other Customer", "Customer", otherOrg, "PtyOrganization", "buyer@other.example.test")
        state.admin = user("ADMIN", ["SUPPORT_POLICY_EDIT", "SUPPORT_CASE_MANAGE", "SUPPORT_CASE_EDIT"])
        state.manager = user("MANAGER", ["SUPPORT_CASE_MANAGE", "SUPPORT_CASE_EDIT"])
        state.agent = user("AGENT", ["SUPPORT_CASE_EDIT"])
        state.otherAdmin = user("OTHER_ADMIN", ["SUPPORT_POLICY_EDIT", "SUPPORT_CASE_MANAGE", "SUPPORT_CASE_EDIT"], otherOrg)
        state.otherManager = user("OTHER_MANAGER", ["SUPPORT_CASE_MANAGE", "SUPPORT_CASE_EDIT"], otherOrg)
        state.otherAgent = user("OTHER_AGENT", ["SUPPORT_CASE_EDIT"], otherOrg)
        state.team = run(state.admin, S + "save#ServiceTeam", {
            organizationPartyId: org,
            teamName: "Feedback spec team"
        }).teamPartyId
        run(state.admin, S + "save#ServiceTeamMember", {teamPartyId: state.team, partyId: state.agent})
        run(state.admin, S + "save#ServiceTeamMember", {teamPartyId: state.team, partyId: state.manager, roleTypeId: "Manager"})
        state.queue = run(state.admin, S + "save#ServiceQueue", {
            organizationPartyId: org,
            description: "Feedback spec queue",
            responsibleTeamPartyId: state.team
        }).requestCategoryId
        run(state.admin, S + "save#ServiceDefaults", {organizationPartyId: org, defaultCategoryId: state.queue})
        const otherQueue = run(state.otherAdmin, S + "save#ServiceQueue", {
            organizationPartyId: otherOrg,
            description: "Feedback spec other queue"
        }).requestCategoryId
        run(state.otherAdmin, S + "save#ServiceDefaults", {organizationPartyId: otherOrg, defaultCategoryId: otherQueue})
        // the organization's PASS site with the Support app (its Feedback page is the invitation's link)
        call("create#mantle.public.PublicSite", {
            siteId,
            name: "Feedback spec site",
            state: "published",
            registrationMode: "invitation",
            locale: "en",
            timeZone: "UTC",
            policyRevision: 1,
            generation: 1
        })
        call("create#mantle.public.PublicSiteHost", {hostname: "feedback-spec.example.test", siteId, canonical: "Y"})
        call("create#mantle.public.PublicSiteApp", {
            siteId,
            appMountId: "support",
            app: "support",
            pathPrefix: "/support",
            enabled: "Y",
            targetId: org
        })
        // another organization's site with the Support app: a link of the organization's is not its
        call("create#mantle.public.PublicSite", {
            siteId: otherSiteId,
            name: "Feedback spec other site",
            state: "published",
            registrationMode: "invitation",
            locale: "en",
            timeZone: "UTC",
            policyRevision: 1,
            generation: 1
        })
        call("create#mantle.public.PublicSiteApp", {
            siteId: otherSiteId,
            appMountId: "support",
            app: "support",
            pathPrefix: "/support",
            enabled: "Y",
            targetId: otherOrg
        })
    },
    cleanupSpec() {
        ec.artifactExecution.disableAuthz()
        // the site is listed by PASS's Sites; nothing else of this spec is another's
        for (const entity of ["mantle.public.PublicSiteApp", "mantle.public.PublicSiteHost", "mantle.public.PublicSite"])
            for (const id of [siteId, otherSiteId]) find(entity, {siteId: id}).deleteAll()
        ec.artifactExecution.enableAuthz()
        login("john.doe")
    },
    setup() {
        ec.artifactExecution.disableAuthz()
    },
    cleanup() {
        ec.artifactExecution.enableAuthz()
        login("john.doe")
    }
})

feature("a feedback form is made and published by the administrator, and the policy takes only a published one", {
    when() {
        const created = run(state.admin, F + "create#FeedbackForm", {organizationPartyId: org, description: "After a case"})
        const formId = (state.formId = created.formId)
        const refused = {
            agent: code(run(state.agent, F + "create#FeedbackForm", {organizationPartyId: org, description: "Mine"})),
            otherOrganization: code(run(state.otherAdmin, F + "save#FeedbackFormField", {formId, title: "Theirs"})),
            unpublished: code(run(state.admin, F + "save#InvitationPolicy", {organizationPartyId: org, formId, delayMinutes: 0}))
        }
        // a form with no rating cannot be published
        const bare = run(state.admin, F + "create#FeedbackForm", {organizationPartyId: org, description: "No rating"}).formId
        run(state.admin, F + "end#FeedbackFormPart", {formId: bare, part: "field", fieldName: "rating"})
        refused.noRating = code(run(state.admin, F + "publish#FeedbackForm", {formId: bare}))
        const published = run(state.admin, F + "publish#FeedbackForm", {formId})
        const policy = run(state.admin, F + "save#InvitationPolicy", {
            organizationPartyId: org,
            formId,
            delayMinutes: 0,
            tokenDays: 14,
            reminderCount: 1,
            lowScoreThreshold: 2,
            followUpTeamPartyId: state.team
        })
        state.policyId = policy.feedbackPolicyId
        // a feedback form is edited by the case template rules but is never a queue's case template
        refused.asQueueTemplate = code(run(state.admin, S + "save#CaseTemplate", {formId, requestCategoryId: state.queue}))
        const form = run(state.admin, F + "get#FeedbackForm", {formId}).form
        return {created, refused, published, policy, form}
    },
    then({created, refused, published, policy, form}) {
        !created.error
        refused.agent == "PERMISSION_DENIED"
        refused.otherOrganization == "RECORD_UNAVAILABLE"
        refused.unpublished == "FORM_NOT_PUBLISHED"
        refused.noRating == "FORM_INVALID"
        refused.asQueueTemplate == "TEMPLATE_UNAVAILABLE"
        published.publishedFieldNames.includes("rating")
        !policy.error
        form.rating.fieldName == "rating"
        form.rating.high == 5
        form.policies.includes(policy.feedbackPolicyId)
        form.fields.every(field => field.audienceEnumId == "CfaCustomer")
    }
})

feature("a resolved case is invited once after the commit; an organization with no policy invites nothing", {
    when() {
        const requestId = (state.requestId = resolvedCase())
        const invitation = waitFor(() => invitationOf(requestId))
        state.invitationId = invitation?.invitationId
        const again = run("john.doe", F + "create#Invitation", {requestId})
        const otherCase = resolvedCase(otherOrg, otherCustomer, state.otherAgent)
        const none = run("john.doe", F + "create#Invitation", {requestId: otherCase})
        return {invitation, again, none, otherInvited: invitationOf(otherCase)}
    },
    then({invitation, again, none, otherInvited}) {
        invitation.statusEnumId == "FinScheduled"
        invitation.partyId == customer
        invitation.emailAddress == "buyer@feedback-customer.example.test"
        invitation.policyId == state.policyId
        invitation.formId == state.formId
        again.reason == "ALREADY_INVITED"
        again.invitationId == invitation.invitationId
        none.reason == "NO_POLICY"
        otherInvited == null
    }
})

feature("the job sends the invitation once with its Support link, and a rerun sends nothing", {
    when() {
        const first = run("john.doe", F + "send#Invitations", {invitationIds: state.invitationId})
        const sent = one(INVITATION, {invitationId: state.invitationId})
        const links = rows(CAPABILITY, {recordType: "FormInvitation", recordId: state.invitationId})
        const rerun = run("john.doe", F + "send#Invitations", {invitationIds: state.invitationId})
        const message = sent.emailMessageId ? one("moqui.basic.email.EmailMessage", {emailMessageId: sent.emailMessageId}) : null
        return {first, sent, links, rerun, message}
    },
    then({first, sent, links, rerun, message}) {
        first.sent == 1
        sent.statusEnumId == "FinSent"
        sent.nextReminderDate != null
        links.length == 1
        links[0].scopes == "CaseFeedback"
        rerun.sent == 0
        rerun.reminded == 0
        String(message.body).includes("https://feedback-spec.example.test/support/Feedback?token=")
        !String(message.body).includes(state.requestId)
    }
})

feature("the Feedback page reads the form and the customer's label, refuses a forged token, and keeps one response", {
    when() {
        const token = (state.token = link(state.invitationId, "CfbSpecFeedbackLinkToken" + "0".repeat(24)))
        const read = page(F + "get#Invitation", {siteId, token})
        // a forged token, and the organization's good one on another organization's site (read and answer)
        const forged = [
            page(F + "get#Invitation", {siteId, token: "x".repeat(48)}),
            page(F + "get#Invitation", {siteId: otherSiteId, token}),
            page(F + "submit#CaseFeedback", {siteId: otherSiteId, token, values: {rating: "1"}})
        ].map(out => out.kind)
        const noRating = page(F + "submit#CaseFeedback", {siteId, token, values: {comment: "No stars"}})
        const outOfScale = page(F + "submit#CaseFeedback", {siteId, token, values: {rating: "9"}})
        const submitted = page(F + "submit#CaseFeedback", {
            siteId,
            token,
            values: JSON.stringify({rating: "2", reason: "speed", comment: "It took a week", contactOk: "Y", requestId: "X"})
        })
        const repeat = page(F + "submit#CaseFeedback", {siteId, token, values: {rating: "5"}})
        const invitation = one(INVITATION, {invitationId: state.invitationId})
        state.formResponseId = invitation.formResponseId
        const answers = rows("moqui.screen.form.FormResponseAnswer", {formResponseId: invitation.formResponseId})
        const followUp = rows(FOLLOW_UP, {invitationId: state.invitationId})[0]
        state.followUpId = followUp?.followUpId
        const notice = rows("moqui.security.user.NotificationMessage", {topic: "CaseFeedbackFollowUp"}).find(row =>
            String(row.messageJson).includes(followUp?.followUpId)
        )
        const after = page(F + "get#Invitation", {siteId, token})
        return {read, forged, noRating, outOfScale, submitted, repeat, invitation, answers, followUp, notice, after}
    },
    then({read, forged, noRating, outOfScale, submitted, repeat, invitation, answers, followUp, notice, after}) {
        read.invitation.customerName == "Feedback Spec Customer"
        read.invitation.organizationName == "Feedback Spec Org"
        read.fields.find(field => field.fieldName == "rating").options.length == 5
        read.fields.find(field => field.fieldName == "rating").required == true
        !JSON.stringify(read).includes(state.requestId)
        read.capabilities.canSubmit == true
        forged.join() == "NotFound,NotFound,NotFound"
        noRating.kind == "Unprocessable"
        outOfScale.kind == "Unprocessable"
        submitted.alreadyApplied == false
        submitted.receipt.scoreText == "2 of 5"
        repeat.alreadyApplied == true
        invitation.statusEnumId == "FinResponded"
        invitation.score == 2
        answers.find(row => row.fieldName == "comment").valueText == "It took a week"
        !answers.some(row => row.fieldName == "requestId")
        followUp.score == 2
        followUp.assigneePartyId == state.manager
        followUp.statusEnumId == "FfsOpen"
        notice != null
        !String(notice.messageJson).includes("It took a week")
        after.invitation.answered == true
        after.fields.length == 0
    }
})

feature("the follow-up is the manager's or its team's; the framework services cannot change or delete an invited response", {
    when() {
        const recorded = run(state.manager, F + "record#FeedbackFollowUp", {
            followUpId: state.followUpId,
            actionEnumId: "FfaCall",
            note: "Called; the replacement ships tomorrow",
            statusEnumId: "FfsDone"
        })
        const refusedAgent = code(run(state.otherAgent, F + "record#FeedbackFollowUp", {followUpId: state.followUpId, note: "x"}))
        const followUp = one(FOLLOW_UP, {followUpId: state.followUpId})
        const update = code(
            run("john.doe", D + "update#FormResponse", {formResponseId: state.formResponseId, responseMap: {rating: "5"}})
        )
        const remove = code(run("john.doe", D + "delete#FormResponse", {formResponseId: state.formResponseId}))
        const kept = rows("moqui.screen.form.FormResponseAnswer", {formResponseId: state.formResponseId})
        // a response with no invitation: the framework services work as before
        const plain = run("john.doe", D + "create#FormResponse", {
            formId: state.formId,
            responseMap: {rating: "4"}
        }).formResponseId
        const plainUpdate = run("john.doe", D + "update#FormResponse", {formResponseId: plain, responseMap: {rating: "3"}})
        const plainValue = one("moqui.screen.form.FormResponseAnswer", {formResponseId: plain, fieldName: "rating"})?.valueText
        const plainDelete = run("john.doe", D + "delete#FormResponse", {formResponseId: plain})
        return {
            recorded,
            refusedAgent,
            followUp,
            update,
            remove,
            kept,
            plainUpdate,
            plainValue,
            plainDelete,
            plainGone: !one("moqui.screen.form.FormResponse", {formResponseId: plain})
        }
    },
    then({recorded, refusedAgent, followUp, update, remove, kept, plainUpdate, plainValue, plainDelete, plainGone}) {
        !recorded.error
        refusedAgent == "RECORD_UNAVAILABLE"
        followUp.statusEnumId == "FfsDone"
        followUp.closedDate != null
        String(followUp.note).includes("the replacement ships tomorrow")
        update == "RESPONSE_LOCKED"
        remove == "RESPONSE_LOCKED"
        kept.find(row => row.fieldName == "rating").valueText == "2"
        !plainUpdate.error
        plainValue == "3"
        !plainDelete.error
        plainGone == true
    }
})
