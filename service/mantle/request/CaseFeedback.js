// Case feedback (design-customer-service §7 SatisfactionResults, ResponseDetail, §8 Feedback, §9 FeedbackForms,
// FeedbackFormDetail, FeedbackDeliveryPolicy; impl-customer-service P13, CS-FEEDBACK, CS-JOBS, F16, F61; SupportFeedbackEntities.xml,
// FormPublicationEntities.xml). A resolved case's customer is invited once to rate how it was handled:
// - The form is a feedback form: a dated DbForm of the organization (purpose DbfpCaseFeedback; DbForm.ownerPartyId) changed by
//   dated fields and options as a case template is (CaseTemplates.js: save, successor, end, conditions, checks), every field
//   customer-visible. Its rating is its first choice field whose option keys are whole numbers, and the key chosen is the
//   score. A response reads the form as of its time.
// - The policy (FeedbackDeliveryPolicy, dated): which resolved cases, the delay, once per case or per resolution, the form, the
//   channel, the link's days, the reminders, the low score and the follow-up team.
// - The invitation is Commons' FormInvitation (FormPublication.js) with the case's resolution episode as its context, made
//   after the commit of a case's resolution (SupportCaseFeedbackInvitation rule) under the policy then in effect, once per
//   case or per resolution episode (invitationKey); the send job (send_CaseFeedbackInvitations) mails it after the delay and
//   reminds, bounded and idempotent by invitation, each in its own transaction, a failing one named and the rest going on.
//   The link is an ExternalAccessCapability of the FormInvitation record kind, on the Support app's Feedback page of the
//   organization's site (PublicApps.sitesFor), made at each send and ending when the invitation expires.
// - The page (PASS Support app, Feedback; operations getCaseFeedbackInvitation and submitCaseFeedback): get#Invitation answers
//   the form as of now and the customer's label, never the case; submit#CaseFeedback, throttled per requester, checks the
//   values on the server (the form's show and require rules again) and keeps one durable FormResponse; a repeat answers the
//   first. A score at or under the policy's low score makes a FeedbackFollowUp, assigned to the follow-up team's manager and
//   told to them (CaseFeedbackFollowUp topic, which names no comment).
// - A response that answers an invitation is never changed (FormPublication.eecas.xml).
// Each service checks its permission and organization (SupportCases.js); refusals carry reason codes, the page's are PASS error
// kinds. Nothing acts on an organization with no policy.
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const cases = ec.resource.script("component://mr-mantle/service/mantle/request/SupportCases.js")
const templates = ec.resource.script("component://mr-mantle/service/mantle/request/CaseTemplates.js")
const publications = ec.resource.script("component://mr-mantle/service/mantle/party/FormPublication.js")
const externalAccess = () => ec.resource.script("component://mr-mantle/service/mantle/party/ExternalAccess.js")
const apps = () => ec.resource.script("component://mr-mantle/service/mantle/public/PublicApps.js")
const {find, one, rows, call, denied, access, ms} = lib

const FORM = "moqui.screen.form.DbForm",
    FIELD = "moqui.screen.form.DbFormField",
    RESPONSE = "moqui.screen.form.FormResponse",
    POLICY = "mantle.request.support.FeedbackDeliveryPolicy",
    FOLLOW_UP = "mantle.request.support.FeedbackFollowUp",
    INVITATION = "mantle.party.FormInvitation",
    EPISODE = "mantle.request.support.CaseSlaEpisode",
    PROFILE = "mantle.request.support.CaseProfile",
    REQUEST = "mantle.request.Request",
    MESSAGE = "moqui.basic.email.EmailMessage"
const S = "org.moqui.impl.ScreenServices."
const PURPOSE = "DbfpCaseFeedback",
    PUBLICATION_PURPOSE = "FppCaseFeedback",
    RECORD_TYPE = "FormInvitation",
    SCOPE = "CaseFeedback",
    TOPIC = "CaseFeedbackFollowUp",
    TEMPLATE = "MANTLE_CASE_FEEDBACK_EMAIL"
const CUSTOMER = "CfaCustomer"
const dayMs = 86400000
// the posts one requester may make in ten minutes (PASS's throttling of the Feedback page)
const POST_LIMIT = 30
// a send that fails is tried again on the next runs, up to this many times, then left Not delivered
const MAX_ATTEMPTS = 3

const blank = value => value == null || String(value).trim() === ""
const text = value => (blank(value) ? null : String(value).trim())
const now = () => ec.user.nowTimestamp
const nowMs = () => Number(ms(now()))
const stamp = millis => (millis == null ? null : new Date(Number(millis)))
const L = words => ec.l10n.localize(words)
const dateText = value => (value == null ? "" : ec.l10n.format(new Date(Number(ms(value))), "d MMM yyyy"))
const listOf = value => cases.listOf(value)
const hasExpression = value => String(value ?? "").includes("${")
const fail = (kind, message) => {
    const error = new Error(message)
    error.moquiErrorKind = kind
    throw error
}
const unavailable = () => fail("NotFound", "This page is not available")
function intIn(value, low, high, fallback, label) {
    if (blank(value)) return fallback
    const number = Number(value)
    if (!Number.isInteger(number) || number < low || number > high)
        denied("POLICY_INVALID", label + " is a whole number from " + low + " to " + high)
    return number
}

// ===== feedback forms =====
// A feedback form of one of the user's organizations; a missing form, one that is not a feedback form and another
// organization's are refused alike (RECORD_UNAVAILABLE).
function feedbackForm(formId) {
    const form = blank(formId) ? null : one(FORM, {formId})
    if (!form || form.purposeEnumId !== PURPOSE || !form.ownerPartyId)
        denied("RECORD_UNAVAILABLE", "Feedback form " + (formId || "") + " is not available")
    try {
        cases.requireOrganization(form.ownerPartyId)
    } catch (error) {
        denied("RECORD_UNAVAILABLE", "Feedback form " + formId + " is not available")
    }
    return form
}
// The form's rating as of a date: its first choice field (buttons or a list) whose option keys are whole numbers, with the
// lowest and highest score; null when it has none.
function ratingOf(fields) {
    for (const field of fields) {
        if (!["DBFFT_radio", "DBFFT_drop-down"].includes(field.fieldTypeEnumId) || !field.options.length) continue
        const keys = field.options.map(option => String(option.key))
        if (!keys.every(key => /^\d{1,3}$/.test(key))) continue
        const scores = keys.map(Number)
        return {fieldName: field.fieldName, title: field.title, low: Math.min(...scores), high: Math.max(...scores)}
    }
    return null
}
const formFields = (formId, asOfDate = null, drafts = false) => templates.formAt(formId, asOfDate, drafts)
// The default form: a required rating 1 to 5 (or 1 to 3), an optional reason and comment, and the customer's consent to be
// contacted about the answer.
function seedFields(scale) {
    const labels =
        scale === 3
            ? ["1 | 1 - Not satisfied", "2 | 2 - Satisfied", "3 | 3 - Very satisfied"]
            : [
                  "1 | 1 - Very dissatisfied",
                  "2 | 2 - Dissatisfied",
                  "3 | 3 - Neither",
                  "4 | 4 - Satisfied",
                  "5 | 5 - Very satisfied"
              ]
    return [
        {
            newFieldName: "rating",
            title: "How satisfied are you with how we handled your request?",
            fieldTypeEnumId: "DBFFT_radio",
            isRequired: "Y",
            optionText: labels.join("\n")
        },
        {
            newFieldName: "reason",
            title: "What mattered most?",
            fieldTypeEnumId: "DBFFT_drop-down",
            isRequired: "N",
            optionText: [
                "solved | Whether my problem was solved",
                "speed | How quickly it was handled",
                "communication | How we kept me informed",
                "other | Something else"
            ].join("\n")
        },
        {
            newFieldName: "comment",
            title: "Anything you would like to tell us?",
            fieldTypeEnumId: "DBFFT_text-area",
            isRequired: "N"
        },
        {
            newFieldName: "contactOk",
            title: "You may contact me about my answer",
            fieldTypeEnumId: "DBFFT_check",
            isRequired: "N",
            optionText: "Y | Yes"
        }
    ]
}
// create#FeedbackForm: a new dated feedback form of the organization, its fields drafts until published: the default
// rating scale (5, or 3), or the fields of another of its feedback forms as of now.
function createFeedbackForm(p) {
    cases.requirePermission("SUPPORT_POLICY_EDIT")
    const organizationPartyId = cases.requireOrganization(p.organizationPartyId)
    const description = text(p.description)
    if (!description) denied("NAME_REQUIRED", "A feedback form needs a name")
    if (hasExpression(description) || hasExpression(p.comments)) denied("NO_EXPRESSIONS", "A name holds ${, which it may not")
    let fields
    if (!blank(p.sourceFormId)) {
        const source = feedbackForm(p.sourceFormId)
        if (source.ownerPartyId !== organizationPartyId) denied("RECORD_UNAVAILABLE", "Copy a form of the same organization")
        fields = formFields(source.formId).map(field => ({
            newFieldName: field.fieldName,
            title: field.title,
            tooltip: field.tooltip || null,
            fieldTypeEnumId: field.fieldTypeEnumId,
            isRequired: field.required ? "Y" : "N",
            optionText: field.options.map(option => option.key + " | " + option.text).join("\n")
        }))
        if (!fields.length) denied("FORM_NOT_PUBLISHED", "The form to copy has no published field")
    } else {
        const scale = blank(p.scale) ? 5 : Number(p.scale)
        if (scale !== 5 && scale !== 3) denied("SCALE_INVALID", "The rating is 1 to 5 or 1 to 3")
        fields = seedFields(scale)
    }
    const formId = call("create#" + FORM, {
        purposeEnumId: PURPOSE,
        isDated: "Y",
        ownerPartyId: organizationPartyId,
        description: description.substring(0, 255),
        comments: text(p.comments)
    }).formId
    for (const field of fields) templates.execute("saveField", Object.assign({formId, audienceEnumId: CUSTOMER}, field))
    return {formId}
}
// The problems of a feedback form as of a date (drafts too by default): a case template's (CaseTemplates.js) and no rating.
function problemsOf(formId, asOfDate = null, drafts = true) {
    const problems = templates.problemsOf(formId, asOfDate, drafts)
    if (!ratingOf(formFields(formId, asOfDate, drafts)))
        problems.push({
            code: "RATING_REQUIRED",
            message: L("The form needs a rating: a choice whose values are the scores (1, 2, 3...)"),
            fieldName: null
        })
    return problems
}
// publish#FeedbackForm: the drafts start at fromDate (now or later), refused while the form has a problem (FORM_INVALID).
function publishFeedbackForm(p) {
    cases.requirePermission("SUPPORT_POLICY_EDIT")
    const form = feedbackForm(p.formId)
    const problems = problemsOf(form.formId, null, true)
    if (problems.length) denied("FORM_INVALID", problems.map(problem => problem.message).join("; "))
    const out = call(S + "publish#DbForm", {formId: form.formId, fromDate: p.fromDate || null})
    return {formId: form.formId, publishedFieldNames: Array.from(out.publishedFieldNames || [])}
}
// A field, option or condition of a feedback form, through the case template rules, every field customer-visible.
function saveField(p) {
    feedbackForm(p.formId)
    const parameters = Object.assign({}, p, {audienceEnumId: CUSTOMER})
    return templates.execute("saveField", parameters)
}
function saveCondition(p) {
    feedbackForm(p.formId)
    return templates.execute("saveCondition", p)
}
function endPart(p) {
    feedbackForm(p.formId)
    return templates.execute("endPart", p)
}
function rename(p) {
    cases.requirePermission("SUPPORT_POLICY_EDIT")
    const form = feedbackForm(p.formId)
    const description = text(p.description)
    if (!description) denied("NAME_REQUIRED", "A feedback form needs a name")
    if (hasExpression(description) || hasExpression(p.comments)) denied("NO_EXPRESSIONS", "A name holds ${, which it may not")
    call("update#" + FORM, {formId: form.formId, description: description.substring(0, 255), comments: text(p.comments)})
    return {formId: form.formId}
}
// get#FeedbackForm: the form with its drafts for its editor (the case template read), its rating, its problems and the
// policies that use it now.
function getFeedbackForm(p) {
    const form = feedbackForm(p.formId)
    const template = templates.execute("getTemplate", {formId: form.formId, includeDrafts: p.includeDrafts !== false}).template
    template.problems = problemsOf(form.formId, null, true)
    template.rating = ratingOf(formFields(form.formId))
    template.policies = cases
        .currentRows(POLICY, {organizationPartyId: form.ownerPartyId})
        .filter(row => row.formId === form.formId)
        .map(row => row.feedbackPolicyId)
    return {form: template}
}

// ===== the delivery policy =====
const policyAt = (organizationPartyId, date) => cases.currentRow(POLICY, {organizationPartyId}, date)
// save#InvitationPolicy: the organization's policy from fromDate (now), ending the current one; end ends it with none after.
function saveInvitationPolicy(p) {
    cases.requirePermission("SUPPORT_POLICY_EDIT")
    const organizationPartyId = cases.requireOrganization(p.organizationPartyId)
    if (p.end === true || p.end === "true" || p.end === "Y") {
        const current = policyAt(organizationPartyId)
        if (!current) denied("POLICY_UNAVAILABLE", "The organization invites no feedback")
        call("update#" + POLICY, {
            feedbackPolicyId: current.feedbackPolicyId,
            thruDate: now(),
            changeReason: text(p.changeReason)
        })
        return {feedbackPolicyId: current.feedbackPolicyId, ended: true}
    }
    const form = feedbackForm(p.formId)
    if (form.ownerPartyId !== organizationPartyId) denied("RECORD_UNAVAILABLE", "Choose a feedback form of the organization")
    if (!ratingOf(formFields(form.formId))) denied("FORM_NOT_PUBLISHED", "Publish the feedback form, with its rating, first")
    const types = listOf(p.requestTypeEnumIds)
    for (const enumId of types)
        if (!one("moqui.basic.Enumeration", {enumId, enumTypeId: "RequestType"}))
            denied("TYPE_INVALID", enumId + " is not a case type")
    const queues = listOf(p.requestCategoryIds)
    for (const requestCategoryId of queues)
        if (cases.queueOf(requestCategoryId)?.organizationPartyId !== organizationPartyId)
            denied("QUEUE_UNAVAILABLE", requestCategoryId + " is not a queue of the organization")
    const frequencyEnumId = text(p.frequencyEnumId) || "FdfPerCase"
    if (!["FdfPerCase", "FdfPerResolution"].includes(frequencyEnumId))
        denied("POLICY_INVALID", "Invite once per case or once per resolution")
    const channelEnumId = text(p.channelEnumId) || "FdcEmail"
    if (channelEnumId !== "FdcEmail") denied("POLICY_INVALID", "Feedback invitations go by email")
    const teamPartyId = text(p.followUpTeamPartyId)
    if (teamPartyId) cases.requireTeam(teamPartyId, organizationPartyId)
    if (p.fromDate && Number(ms(p.fromDate)) < nowMs() - 5000) denied("DATE_PAST", "A policy starts now or later")
    const values = {
        formId: form.formId,
        requestTypeEnumIds: types.join(",") || null,
        requestCategoryIds: queues.join(",") || null,
        delayMinutes: intIn(p.delayMinutes, 0, 43200, 60, "The delay in minutes"),
        frequencyEnumId,
        channelEnumId,
        tokenDays: intIn(p.tokenDays, 1, 90, 14, "The link's days"),
        reminderCount: intIn(p.reminderCount, 0, 3, 1, "The reminders"),
        reminderDays: intIn(p.reminderDays, 1, 30, 3, "The days between reminders"),
        lowScoreThreshold: blank(p.lowScoreThreshold) ? null : intIn(p.lowScoreThreshold, 0, 100, null, "The low score"),
        followUpTeamPartyId: teamPartyId,
        followUpDays: intIn(p.followUpDays, 1, 30, 2, "The follow-up days"),
        changeReason: text(p.changeReason)
    }
    const feedbackPolicyId = cases.startRow(POLICY, "feedbackPolicyId", {organizationPartyId}, values, {fromDate: p.fromDate})
    return {feedbackPolicyId}
}

// ===== invitations =====
// queue#Invitation (the SupportCaseFeedbackInvitation rule): create#Invitation after the commit of the resolution, only where
// some organization has a policy; a failure to queue is logged, never the change's.
function queueInvitation(p) {
    if (find(POLICY, {}).count() === 0 || !one(PROFILE, {requestId: p.requestId})) return {queued: false}
    ec.message.pushErrors()
    try {
        try {
            ec.service
                .special()
                .name("mantle.request.CaseFeedbackServices.create#Invitation")
                .parameters({requestId: p.requestId})
                .registerOnCommit()
        } catch (error) {
            ec.service
                .sync()
                .name("mantle.request.CaseFeedbackServices.create#Invitation")
                .parameters({requestId: p.requestId})
                .disableAuthz()
                .call()
        }
    } catch (error) {
        ec.logger.error("Case " + p.requestId + ": the feedback invitation was not queued: " + error.message)
    } finally {
        ec.message.clearErrors()
        ec.message.popErrors()
    }
    return {queued: true}
}
// The email of a party: its primary one, else any current one.
function emailOf(partyId) {
    if (!partyId) return null
    const mechs = rows("mantle.party.contact.PartyContactMech", {partyId}).filter(row => lib.active(row))
    if (!mechs.length) return null
    const addresses = Array.from(
        find("mantle.party.contact.ContactMech")
            .condition(
                "contactMechId",
                "in",
                mechs.map(row => row.contactMechId)
            )
            .condition("contactMechTypeEnumId", "CmtEmailAddress")
            .list()
    )
    const primary = mechs.find(
        row => row.contactMechPurposeId === "EmailPrimary" && addresses.some(mech => mech.contactMechId === row.contactMechId)
    )
    const chosen = primary ? addresses.find(mech => mech.contactMechId === primary.contactMechId) : addresses[0]
    return text(chosen?.infoString)
}
// Whether a party works for an internal organization (a staff reporter is never the one invited).
const isStaff = partyId =>
    !!partyId &&
    rows("mantle.party.PartyRelationship", {fromPartyId: partyId})
        .filter(row => lib.active(row) && ["PrtEmployee", "PrtAgent", "PrtMember"].includes(row.relationshipTypeEnumId))
        .some(row => cases.isInternal(row.toPartyId))
// create#Invitation: for a resolved case, the invitation its organization's current policy makes, once by its key (per case,
// or per resolution episode), scheduled after the delay; else why none ({created: false, reason}).
function createInvitation(p) {
    const requestId = p.requestId
    const request = one(REQUEST, {requestId})
    if (!request || !one(PROFILE, {requestId})) return {created: false, reason: "NOT_A_CASE"}
    if (request.statusId !== "ReqCompleted") return {created: false, reason: "NOT_RESOLVED"}
    const parties = cases.partiesOf(requestId)
    const organizationPartyId = cases.roleParty(parties, "OrgInternal")
    const policy = organizationPartyId ? policyAt(organizationPartyId) : null
    if (!policy) return {created: false, reason: "NO_POLICY"}
    const types = listOf(policy.requestTypeEnumIds),
        queues = listOf(policy.requestCategoryIds)
    if (
        (types.length && !types.includes(request.requestTypeEnumId)) ||
        (queues.length && !queues.includes(request.requestCategoryId))
    )
        return {created: false, reason: "NOT_ELIGIBLE"}
    const customerPartyId = cases.roleParty(parties, "Customer")
    if (!customerPartyId || cases.isInternal(customerPartyId)) return {created: false, reason: "NO_CUSTOMER"}
    const reporter = cases.roleParty(parties, "Reporter")
    const contactPartyId = reporter && !isStaff(reporter) && emailOf(reporter) ? reporter : customerPartyId
    const emailAddress = emailOf(contactPartyId)
    if (!emailAddress) return {created: false, reason: "NO_ADDRESS"}
    if (!ratingOf(formFields(policy.formId))) {
        ec.logger.error("Case " + requestId + ": feedback form " + policy.formId + " has no published rating; no invitation")
        return {created: false, reason: "FORM_NOT_PUBLISHED"}
    }
    // the context: the case's latest resolution episode (its clocks, P4), else the case itself
    const episode = rows(EPISODE, {requestId, clockEnumId: "SlcResolution"}).sort(
        (a, b) => Number(b.sequenceNum || 0) - Number(a.sequenceNum || 0)
    )[0]
    const resolution = episode ? episode.caseSlaEpisodeId : String(ms(request.lastUpdatedStamp) || nowMs())
    const invitationKey = "case:" + requestId + (policy.frequencyEnumId === "FdfPerResolution" ? ":resolution:" + resolution : "")
    const earlier = one(INVITATION, {invitationKey})
    if (earlier) return {created: false, reason: "ALREADY_INVITED", invitationId: earlier.invitationId}
    const publicationId = publications.publicationFor(organizationPartyId, policy.formId, PUBLICATION_PURPOSE, L("Case feedback"))
    const scheduledMs = nowMs() + Number(policy.delayMinutes || 0) * 60000
    const invitationId = call("create#" + INVITATION, {
        publicationId,
        formId: policy.formId,
        organizationPartyId,
        partyId: customerPartyId,
        contactPartyId,
        emailAddress,
        contextEntityName: episode ? EPISODE : REQUEST,
        contextId: episode ? episode.caseSlaEpisodeId : requestId,
        recordEntityName: REQUEST,
        recordId: requestId,
        policyId: policy.feedbackPolicyId,
        invitationKey,
        statusEnumId: "FinScheduled",
        scheduledDate: stamp(scheduledMs),
        expireDate: stamp(scheduledMs + Number(policy.tokenDays || 14) * dayMs),
        reminderCount: 0,
        attemptCount: 0,
        createdDate: now()
    }).invitationId
    return {created: true, invitationId}
}
// The address the invitation is sent from: the organization's email, else its first shared mailbox, else no-reply at the
// site's host.
function senderOf(organizationPartyId, url) {
    const own = emailOf(organizationPartyId)
    if (own) return own
    const account = rows("moqui.basic.email.EmailAccount", {ownerPartyId: organizationPartyId}).find(row => row.emailAddress)
    if (account) return account.emailAddress
    const host = /^https?:\/\/([^/:]+)/.exec(String(url || ""))?.[1]
    return host ? "no-reply@" + host : null
}
const encode = value =>
    String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
// One invitation's email in its own error frame: the message id and whether it went (sent or queued).
function mail(invitation, url, reminder) {
    const organizationName = cases.partyName(invitation.organizationPartyId)
    const request = one(REQUEST, {requestId: invitation.recordId})
    const fromAddress = senderOf(invitation.organizationPartyId, url)
    if (!fromAddress) return {went: false, error: "The organization has no email address to send from"}
    const subject =
        (reminder ? L("Reminder") + ": " : "") +
        L("How did we do?") +
        " " +
        organizationName +
        " · " +
        (request?.requestName || "")
    const body =
        "<p>" +
        encode(L("Hello") + " " + cases.partyName(invitation.contactPartyId) + ",") +
        "</p><p>" +
        encode(L("Your request") + " “" + (request?.requestName || "") + "” " + L("with") + " " + organizationName) +
        " " +
        encode(L("is resolved. Would you tell us how we handled it? It takes a minute.")) +
        '</p><p><a href="' +
        encode(url) +
        '">' +
        encode(L("Rate our service")) +
        "</a></p><p><small>" +
        encode(L("The link works until") + " " + dateText(invitation.expireDate) + ". " + L("You can answer once.")) +
        "</small></p>"
    let emailMessageId = null,
        error = null
    ec.message.pushErrors()
    try {
        const out =
            ec.service
                .sync()
                .name("org.moqui.impl.EmailServices.send#EmailTemplate")
                .parameters({
                    emailTemplateId: TEMPLATE,
                    toAddresses: invitation.emailAddress,
                    bodyParameters: {subject, fromAddress, fromName: organizationName},
                    body
                })
                .requireNewTransaction(true)
                .disableAuthz()
                .call() || {}
        if (ec.message.hasError()) error = ec.message.getErrorsString()
        else emailMessageId = out.emailMessageId || null
    } catch (thrown) {
        error = thrown.message
    } finally {
        ec.message.clearErrors()
        ec.message.popErrors()
    }
    const message = emailMessageId ? one(MESSAGE, {emailMessageId}) : null
    const went = ["ES_SENT", "ES_READY", "ES_SCHEDULED"].includes(message?.statusId)
    return {went, emailMessageId, error: went ? null : error || "The email was not sent"}
}
// send#Invitation: one invitation, locked, in the job's new transaction: a scheduled one due is sent (a case reopened since
// is not), a sent one due a reminder is reminded; anything else is left as it is, so a rerun sends nothing twice.
function sendInvitation(p) {
    const invitation = find(INVITATION, {invitationId: p.invitationId}).forUpdate(true).one()
    if (!invitation) return {done: "missing"}
    const at = nowMs()
    const reminder = invitation.statusEnumId === "FinSent"
    if (invitation.statusEnumId === "FinScheduled") {
        if (Number(ms(invitation.scheduledDate)) > at) return {done: "notDue"}
    } else if (reminder) {
        if (invitation.formResponseId || !invitation.nextReminderDate || Number(ms(invitation.nextReminderDate)) > at)
            return {done: "notDue"}
    } else return {done: "notDue"}
    const set = values => {
        for (const [name, value] of Object.entries(values)) invitation.set(name, value)
        invitation.update()
    }
    if (Number(ms(invitation.expireDate)) <= at) {
        set({statusEnumId: "FinExpired", nextReminderDate: null})
        return {done: "expired"}
    }
    const request = one(REQUEST, {requestId: invitation.recordId})
    if (!reminder && request?.statusId !== "ReqCompleted") {
        set({statusEnumId: "FinSuppressed", lastError: L("The case was reopened before the invitation was sent")})
        return {done: "suppressed"}
    }
    // a send not made (no link, or the mail not gone): tried again on the next runs, a first send up to MAX_ATTEMPTS times
    // and then Not delivered; a reminder not made is not tried again
    const notSent = error => {
        const attempts = Number(invitation.attemptCount || 0) + 1
        set({
            attemptCount: attempts,
            lastError: String(error).substring(0, 250),
            statusEnumId: !reminder && attempts >= MAX_ATTEMPTS ? "FinFailed" : invitation.statusEnumId,
            nextReminderDate: reminder ? null : invitation.nextReminderDate
        })
        return {done: "failed", error}
    }
    const issued = (() => {
        try {
            return externalAccess().create({
                recordType: RECORD_TYPE,
                recordId: invitation.invitationId,
                scopes: SCOPE,
                thruDate: invitation.expireDate
            })
        } catch (error) {
            ec.message.clearErrors()
            return {error: error.message}
        }
    })()
    if (!issued.url) return notSent(issued.error || L("The organization has no published site with the Support app"))
    const sent = mail(invitation, issued.url, reminder)
    const policy = one(POLICY, {feedbackPolicyId: invitation.policyId})
    if (!sent.went) return notSent(sent.error)
    const reminders = Number(invitation.reminderCount || 0) + (reminder ? 1 : 0)
    const nextMs = at + Number(policy?.reminderDays || 3) * dayMs
    set({
        statusEnumId: "FinSent",
        sentDate: invitation.sentDate || now(),
        lastSentDate: now(),
        reminderCount: reminders,
        nextReminderDate:
            reminders < Number(policy?.reminderCount ?? 0) && nextMs < Number(ms(invitation.expireDate)) ? stamp(nextMs) : null,
        emailMessageId: sent.emailMessageId,
        lastError: null
    })
    return {done: reminder ? "reminded" : "sent"}
}
// expire#Invitation: one sent, unanswered invitation past its expiry, locked in the job's new transaction, marked expired;
// anything else is left as it is.
function expireInvitation(p) {
    const invitation = find(INVITATION, {invitationId: p.invitationId}).forUpdate(true).one()
    if (!invitation || invitation.statusEnumId !== "FinSent" || Number(ms(invitation.expireDate)) > nowMs())
        return {done: "notDue"}
    invitation.set("statusEnumId", "FinExpired")
    invitation.set("nextReminderDate", null)
    invitation.update()
    return {done: "expired"}
}
// send#Invitations (the send_CaseFeedbackInvitations job): a bounded batch of the scheduled invitations due, then of the
// reminders due, oldest first, each sent in its own transaction; a failing one is logged with its id and the rest go on. The
// sent ones past their expiry are marked expired.
function sendInvitations(p) {
    const limit = Math.max(1, Math.min(1000, Number(p.limit) || 100))
    const scope = listOf(p.invitationIds)
    const due = (status, dateField) => {
        let query = find(INVITATION, {statusEnumId: status}).condition(dateField, "less-equals", now())
        if (scope.length) query = query.condition("invitationId", "in", scope)
        return Array.from(query.orderBy(dateField).limit(limit).list()).map(row => row.invitationId)
    }
    const counts = {sent: 0, reminded: 0, expired: 0, suppressed: 0, failed: 0}
    const failedList = []
    const ids = due("FinScheduled", "scheduledDate")
    for (const invitationId of ids.concat(due("FinSent", "nextReminderDate")).slice(0, limit)) {
        ec.message.pushErrors()
        try {
            const out =
                ec.service
                    .sync()
                    .name("mantle.request.CaseFeedbackServices.send#Invitation")
                    .parameters({invitationId})
                    .requireNewTransaction(true)
                    .disableAuthz()
                    .call() || {}
            if (ec.message.hasError()) throw new Error(ec.message.getErrorsString())
            if (counts[out.done] != null) counts[out.done]++
            if (out.done === "failed") failedList.push({invitationId, message: out.error || "not delivered"})
        } catch (error) {
            ec.logger.error("Feedback invitation " + invitationId + " was not sent: " + error.message)
            counts.failed++
            failedList.push({invitationId, message: error.message})
        } finally {
            ec.message.clearErrors()
            ec.message.popErrors()
        }
    }
    // the sent ones past their expiry, unanswered
    let expiring = find(INVITATION, {statusEnumId: "FinSent"}).condition("expireDate", "less-equals", now())
    if (scope.length) expiring = expiring.condition("invitationId", "in", scope)
    for (const row of Array.from(expiring.limit(limit).list())) {
        ec.message.pushErrors()
        try {
            const out =
                ec.service
                    .sync()
                    .name("mantle.request.CaseFeedbackServices.expire#Invitation")
                    .parameters({invitationId: row.invitationId})
                    .requireNewTransaction(true)
                    .disableAuthz()
                    .call() || {}
            if (ec.message.hasError()) throw new Error(ec.message.getErrorsString())
            if (out.done === "expired") counts.expired++
        } catch (error) {
            ec.logger.error("Feedback invitation " + row.invitationId + " was not marked expired: " + error.message)
            counts.failed++
            failedList.push({invitationId: row.invitationId, message: error.message})
        } finally {
            ec.message.clearErrors()
            ec.message.popErrors()
        }
    }
    return Object.assign(counts, {failedList})
}

// ===== the Feedback page (PASS operations) =====
// The organization the Support app of a published site serves.
function served(siteId) {
    const site = siteId && one("mantle.public.PublicSite", {siteId})
    if (!site || site.state !== "published") unavailable()
    const mount = apps().mount(siteId, "support")
    if (!mount?.targetId) unavailable()
    return mount.targetId
}
// A post counts against its requester's limit first (the framework's sign-in limits, as a token lookup does).
function throttle() {
    const key = ec.resource.script("component://framework/service/org/moqui/public/Account.js").requesterKey()
    const allowed = ec.service
        .sync()
        .throwOnError(true)
        .name("org.moqui.public.AccountServices.record#Attempt")
        .parameters({input: {key: "feedback-post:" + key, limit: POST_LIMIT, windowMillis: 600000}})
        .requireNewTransaction(true)
        .call().result.allowed
    if (!allowed) fail("Tarpit", "Too many attempts. Wait a few minutes and try again.")
}
// The invitation a page's token opens on the site (ExternalAccess.check): NotFound for a forged, expired, revoked or another
// site's token, and for an invitation no longer reachable.
function invitationFor(p) {
    const organizationPartyId = served(p.siteId)
    if (blank(p.token)) unavailable()
    const checked = externalAccess().check({token: p.token, scope: SCOPE, recordType: RECORD_TYPE, organizationPartyId})
    const invitation = one(INVITATION, {invitationId: checked.recordId})
    if (!invitation) unavailable()
    return invitation
}
// What the page shows of a field: its kind, label, help, whether required, its options, and its show and require rules.
const kinds = {
    DBFFT_radio: "radio",
    "DBFFT_drop-down": "select",
    DBFFT_check: "checks",
    "DBFFT_text-line": "text",
    "DBFFT_text-area": "textarea",
    "DBFFT_date-time": "date"
}
const ruleOf = rule => (rule ? {field: rule.field, operator: rule.operator, values: cases.listOf(rule.value)} : null)
function pageFields(formId) {
    return formFields(formId)
        .filter(field => field.audienceEnumId === CUSTOMER && kinds[field.fieldTypeEnumId])
        .map(field => ({
            fieldName: field.fieldName,
            kind: kinds[field.fieldTypeEnumId],
            title: field.title,
            tooltip: field.tooltip || "",
            required: !!field.required,
            options: field.options.map(option => ({key: option.key, text: option.text})),
            show: ruleOf(field.show),
            require: ruleOf(field.require)
        }))
}
function receiptOf(invitation) {
    const form = one(FORM, {formId: invitation.formId})
    const rating = ratingOf(formFields(invitation.formId, invitation.responseDate))
    return {
        submittedText: dateText(invitation.responseDate),
        scoreText: invitation.score == null || !rating ? "" : invitation.score + " " + L("of") + " " + rating.high,
        message: L("Thank you. Your answer is recorded."),
        formName: form?.description || ""
    }
}
// get#Invitation: the form as of now (its customer fields with their rules), the organization's name and the customer's
// label, and the receipt once answered. Never the case, its messages or its people.
function getInvitation(p) {
    const invitation = invitationFor(p)
    const form = one(FORM, {formId: invitation.formId})
    const answered = !!invitation.formResponseId
    return {
        invitation: {
            title: L("How did we do?"),
            formName: form?.description || "",
            organizationName: cases.partyName(invitation.organizationPartyId),
            customerName: cases.partyName(invitation.partyId),
            expiresText: dateText(invitation.expireDate),
            answered
        },
        fields: answered ? [] : pageFields(invitation.formId),
        receipt: answered ? receiptOf(invitation) : null,
        capabilities: {canSubmit: !answered}
    }
}
// The values a page sends: a map, or its JSON text (a form post through a remote frontend).
function valuesOf(value) {
    if (value == null || value === "") return {}
    if (typeof value === "string") {
        const parsed = lib.json(value, null)
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) fail("Unprocessable", "Reload the page and try again")
        return parsed
    }
    return Object.assign({}, value)
}
// submit#CaseFeedback: the customer's answer, checked on the server against the form as of now (its show and require rules
// again, each value of its type, nothing that is not on the form), kept as one FormResponse linked from the invitation; a
// repeat answers the first. A low score makes the follow-up.
function submitCaseFeedback(p) {
    throttle()
    const found = invitationFor(p)
    const invitation = find(INVITATION, {invitationId: found.invitationId}).forUpdate(true).one()
    if (invitation.formResponseId) return {receipt: receiptOf(invitation), alreadyApplied: true}
    const checked = templates.checkValues(invitation.formId, valuesOf(p.values), "customer", null, false)
    if (!checked.valid) fail("Unprocessable", checked.errors.map(error => error.message).join("; "))
    const rating = ratingOf(formFields(invitation.formId))
    const scoreValue = rating ? checked.values[rating.fieldName] : null
    const score = blank(scoreValue) ? null : Number(scoreValue)
    const responseDate = now()
    const formResponseId = call(S + "create#FormResponse", {
        formId: invitation.formId,
        formLocation: "DbForm#" + invitation.formId,
        responseDate,
        responseMap: checked.values
    }).formResponseId
    invitation.set("formResponseId", formResponseId)
    invitation.set("responseDate", responseDate)
    invitation.set("score", score)
    invitation.set("statusEnumId", "FinResponded")
    invitation.set("nextReminderDate", null)
    invitation.update()
    const policy = one(POLICY, {feedbackPolicyId: invitation.policyId})
    if (score != null && policy?.lowScoreThreshold != null && score <= Number(policy.lowScoreThreshold))
        followUp(invitation, score, policy, rating)
    return {receipt: receiptOf(invitation), alreadyApplied: false}
}

// ===== the follow-up =====
const managersOf = teamPartyId =>
    teamPartyId
        ? cases
              .currentRows("mantle.party.PartyRelationship", {
                  toPartyId: teamPartyId,
                  relationshipTypeEnumId: "PrtServiceTeam",
                  fromRoleTypeId: "Manager"
              })
              .map(row => row.fromPartyId)
              .sort()
        : []
// The low score's follow-up, assigned to the follow-up team's (else the case's queue team's) first manager and told to the
// team's managers; the notice names the case and the score, never the comment. A notice that fails is logged.
function followUp(invitation, score, policy, rating) {
    const request = one(REQUEST, {requestId: invitation.recordId})
    const teamPartyId =
        policy.followUpTeamPartyId || cases.queueOf(request?.requestCategoryId)?.queue?.responsibleTeamPartyId || null
    const managers = managersOf(teamPartyId)
    const followUpId = call("create#" + FOLLOW_UP, {
        invitationId: invitation.invitationId,
        formResponseId: invitation.formResponseId,
        requestId: invitation.recordId,
        organizationPartyId: invitation.organizationPartyId,
        score,
        teamPartyId,
        assigneePartyId: managers[0] || null,
        dueDate: stamp(nowMs() + Number(policy.followUpDays || 2) * dayMs),
        statusEnumId: "FfsOpen",
        createdDate: now()
    }).followUpId
    try {
        const partyIds = managers.length ? managers : cases.teamMembers(teamPartyId).map(row => row.fromPartyId)
        const userIds = partyIds.length
            ? Array.from(find("moqui.security.UserAccount").condition("partyId", "in", partyIds).list()).map(row => row.userId)
            : []
        if (userIds.length) {
            const message = ec
                .makeNotificationMessage()
                .topic(TOPIC)
                .userIds(userIds)
                .message({
                    followUpId,
                    formResponseId: invitation.formResponseId,
                    requestId: invitation.recordId,
                    requestName: request?.requestName || invitation.recordId,
                    customerName: cases.partyName(invitation.partyId),
                    scoreText: score + (rating ? " " + L("of") + " " + rating.high : "")
                })
            if (typeof message.record === "function") message.record(REQUEST, invitation.recordId)
            message.send()
        }
    } catch (error) {
        ec.message.clearErrors()
        ec.logger.error(
            "Feedback follow-up " + followUpId + " on case " + invitation.recordId + " was not told: " + error.message
        )
    }
    return followUpId
}
// record#FeedbackFollowUp: the follow-up's assignee, due date, action, note and state, by a service manager, or an agent of
// its team; the response is never changed.
function recordFollowUp(p) {
    const row = blank(p.followUpId) ? null : find(FOLLOW_UP, {followUpId: p.followUpId}).forUpdate(true).one()
    if (!row) denied("RECORD_UNAVAILABLE", "Follow-up " + (p.followUpId || "") + " is not available")
    try {
        cases.requireOrganization(row.organizationPartyId)
    } catch (error) {
        denied("RECORD_UNAVAILABLE", "Follow-up " + p.followUpId + " is not available")
    }
    const userPartyId = ec.user.userAccount?.partyId
    const manager = access.has("SUPPORT_CASE_MANAGE")
    if (!manager && !(access.has("SUPPORT_CASE_EDIT") && userPartyId && cases.isTeamMember(userPartyId, row.teamPartyId)))
        denied("PERMISSION_DENIED", "SUPPORT_CASE_MANAGE, or a member of the follow-up team, is required")
    const changes = {updatedByUserId: ec.user.userId}
    if (p.assigneePartyId !== undefined && p.assigneePartyId !== null) {
        const assignee = text(p.assigneePartyId)
        if (
            assignee &&
            row.teamPartyId &&
            !cases.isTeamMember(assignee, row.teamPartyId) &&
            !managersOf(row.teamPartyId).includes(assignee)
        )
            denied("ASSIGNEE_UNAVAILABLE", cases.partyName(assignee) + " is not in the follow-up team")
        if (assignee && !manager && assignee !== userPartyId)
            denied("PERMISSION_DENIED", "Only a manager assigns it to someone else")
        changes.assigneePartyId = assignee
    }
    if (!blank(p.dueDate)) changes.dueDate = p.dueDate
    if (!blank(p.actionEnumId)) {
        if (!one("moqui.basic.Enumeration", {enumId: p.actionEnumId, enumTypeId: "FeedbackFollowUpAction"}))
            denied("ACTION_INVALID", p.actionEnumId + " is not a follow-up action")
        changes.actionEnumId = p.actionEnumId
    }
    if (!blank(p.note)) {
        const line =
            "[" + ec.l10n.format(new Date(nowMs()), "yyyy-MM-dd HH:mm") + " " + (ec.user.username || "") + "] " + text(p.note)
        changes.note = (row.note ? row.note + "\n" : "") + line.substring(0, 2000)
    }
    if (!blank(p.statusEnumId)) {
        if (!["FfsOpen", "FfsAcknowledged", "FfsDone"].includes(p.statusEnumId))
            denied("STATUS_INVALID", p.statusEnumId + " is not a follow-up state")
        changes.statusEnumId = p.statusEnumId
        changes.closedDate = p.statusEnumId === "FfsDone" ? now() : null
    }
    for (const [name, value] of Object.entries(changes)) row.set(name, value)
    row.update()
    return {followUpId: row.followUpId}
}

// ===== the Support app's readiness =====
// The Support app on a site (PublicApps.js, Forum's site readiness): its target an internal organization with a service
// policy, a feedback policy for the Feedback page, and a canonical host for the links.
function appReadiness(p) {
    const organization = !!p.targetId && cases.isInternal(p.targetId)
    return {
        checks: [
            {name: "organization", ready: organization},
            {
                name: "service policy",
                ready:
                    organization && !!cases.currentRow("mantle.request.support.ServicePolicy", {organizationPartyId: p.targetId})
            },
            {name: "feedback policy", ready: organization && !!policyAt(p.targetId)},
            {name: "canonical host", ready: !!apps().pageUrl(p.siteId, p.app || "support", "/")}
        ]
    }
}

const operations = {
    createFeedbackForm,
    publishFeedbackForm,
    saveField,
    saveCondition,
    endPart,
    rename,
    getFeedbackForm,
    saveInvitationPolicy,
    queueInvitation,
    createInvitation,
    sendInvitation,
    expireInvitation,
    sendInvitations,
    getInvitation,
    submitCaseFeedback,
    recordFollowUp,
    appReadiness
}
// the PASS operations answer the page's error kinds; Mantle's reads and writes below the checks run without artifact
// authorization
const pageOperations = new Set(["getInvitation", "submitCaseFeedback"])
;({
    PURPOSE,
    ratingOf,
    formFields,
    problemsOf,
    policyAt,
    execute(op, parameters) {
        if (!operations[op]) throw new Error("Unknown case feedback operation " + op)
        const wasDisabled = ec.artifactExecution.disableAuthz()
        try {
            return operations[op](parameters || {})
        } catch (error) {
            // a refusal a PASS page shows says nothing of the record
            if (pageOperations.has(op) && !error.moquiErrorKind) {
                const code = lib.reasonCode(error)
                if (code === "RESPONSE_LOCKED" || !code) throw error
                ec.message.clearErrors()
                fail("Unprocessable", String(error.message).replace(/^[A-Z][A-Z0-9_]+: /, ""))
            }
            throw error
        } finally {
            if (!wasDisabled) ec.artifactExecution.enableAuthz()
        }
    }
})
