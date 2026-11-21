// Marketing's surveys and form publications (mantle.marketing.MarketingFormServices, F of IronStone Marketing design §14.2; design §10
// Surveys, SurveyDistribution, Responses and ResponseDetail; impl-marketing P12, F20, F21, F53, F70, F80). CC0 1.0 Universal plus
// Grant of Patent License.
//
// - The forms are the survey builder's (mantle.party.FormDefinitionServices) of Marketing's purposes, registered in Mantle's seed data
//   (data/10-seed/MarketingAndCommerce.xml: the survey, the lead form and the registration questions; edited with MARKETING_CONTENT_EDIT, read
//   with MARKETING_AUDIENCE_VIEW or MARKETING_REPORT_VIEW, in the organizations get#FormScope answers). No case feedback or People
//   form is reached here: those are other purposes, and a response is read only through a submission to a Marketing publication.
// - The publications are Commons' (FormPublication.js); these are thin wrappers that add Marketing's checks: the form a Marketing
//   one of the caller's organizations, the site one whose marketing mount targets the form's organization (SITE_INVALID), the
//   campaign an open one of the organization (its context record and a CampaignAssociation of kind CakForm), the subscription choice
//   a Marketing list of the organization; publish#Publication opens one once its readiness holds (a published form, a site).
// - Invitations (create#Invitations): an invitation send, an ordinary CampaignSend of the publication's campaign (P8) naming the
//   publication; its preparation and dispatch decide who is invited (the topic's accepted, consenting, unsuppressed members: the
//   promotional eligibility), and each recipient's message carries their own link (build#CampaignDelivery: the FormInvitation once per
//   recipient and an ExternalAccess capability of the scope MarketingSurvey per attempt; the token never kept).
// - Responses: a submission's response of a Marketing publication of the scope, read with the form as of its submission; the
//   respondent named only for an audience reader; the summary adds the option scores of answered scored questions, the answered count
//   and the maximum apart, an unscored or unanswered question left out.
// Refusals carry reason codes (EntityLib.js denied).
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const marketingAccess = ec.resource.script("component://mr-mantle/service/mantle/marketing/MarketingAccess.js")
const forms = () => ec.resource.script("component://mr-mantle/service/mantle/party/FormDefinitions.js")
const publications = () => ec.resource.script("component://mr-mantle/service/mantle/party/FormPublication.js")
const apps = () => ec.resource.script("component://mr-mantle/service/mantle/public/PublicApps.js")
const audiences = () => ec.resource.script("component://mr-mantle/service/mantle/marketing/MarketingAudiences.js").audience
const {find, one, rows, call, denied, ms} = lib

const PUBLICATION = "mantle.party.FormPublication"
const INVITATION = "mantle.party.FormInvitation"
const SUBMISSION = "mantle.party.FormSubmission"
const FORM = "moqui.screen.form.DbForm"
const CAMPAIGN = "mantle.marketing.campaign.MarketingCampaign"
const ASSOCIATION = "mantle.marketing.campaign.CampaignAssociation"
const SEND = "mantle.marketing.campaign.CampaignSend"
const LIST = "mantle.marketing.contact.ContactList"
// Marketing's purposes of the builder and their publication purposes
const PURPOSES = ["DbfpSurvey", "DbfpLead", "DbfpRegistration"]
const PUBLICATION_PURPOSES = ["FppSurvey", "FppLead", "FppRegistration"]
const openCampaignStatuses = ["MKTG_CAMP_PLANNED", "MKTG_CAMP_APPROVED", "MKTG_CAMP_INPROGRESS"]
const limits = {rows: 200, stats: 5000, invitationDays: 30}
const accessTexts = {FpaInvited: "Invited recipients", FpaAnonymous: "Anyone with the link", FpaAccount: "Signed-in accounts"}
const repeatTexts = {FprOnce: "Once", FprMany: "Several times"}

const blank = value => value == null || String(value).trim() === ""
const text = value => (blank(value) ? null : String(value).trim())
const nowMs = () => Number(ms(ec.user.nowTimestamp))
const L = words => ec.l10n.localize(words)
const organizationName = partyId => (partyId ? one("mantle.party.Organization", {partyId})?.organizationName || partyId : "")
const partyName = partyId => {
    if (!partyId) return ""
    const person = one("mantle.party.Person", {partyId})
    if (person) return [person.firstName, person.lastName].filter(Boolean).join(" ") || partyId
    return organizationName(partyId)
}
const enumText = enumId => (enumId ? one("moqui.basic.Enumeration", {enumId})?.description || enumId : "")

// ===== scope =====
// get#FormScope (the purposes' scope service, FormDefinitions.js): the organizations of the caller's Marketing scope; none for a
// caller who reads nothing of Marketing.
function formScope() {
    const userScope = marketingAccess.scope()
    return {organizationPartyIds: userScope.capabilities.anyRead ? marketingAccess.organizationIds(userScope) : []}
}
function readScope() {
    const userScope = marketingAccess.scope()
    if (!userScope.capabilities.anyRead) denied("PERMISSION_DENIED", "Marketing surveys are not open to you")
    return userScope
}
// A form of Marketing's purposes the caller edits (view: or reads), else RECORD_UNAVAILABLE alike.
function marketingForm(formId, view = false) {
    const form = forms().formOf(formId, {view, purposes: PURPOSES, noun: "survey"})
    return form
}
// A publication of a Marketing form of the scope (view: read), else RECORD_UNAVAILABLE.
function marketingPublication(publicationId, view = false, lock = false) {
    const row = blank(publicationId) ? null : one(PUBLICATION, {publicationId: text(publicationId)})
    if (!row || !PUBLICATION_PURPOSES.includes(row.purposeEnumId))
        denied("RECORD_UNAVAILABLE", "Publication " + (publicationId || "") + " is not available")
    const found = publications().publicationOf(row.publicationId, {view, lock})
    if (!PURPOSES.includes(found.form.purposeEnumId))
        denied("RECORD_UNAVAILABLE", "Publication " + publicationId + " is not available")
    return found
}
// The sites a publication of the organization may be answered on: published, with a marketing mount targeting it.
function sitesOf(organizationPartyId) {
    return apps()
        .sitesFor("marketing", organizationPartyId)
        .map(siteId => one("mantle.public.PublicSite", {siteId}))
        .filter(site => site && site.state === "published")
        .map(site => ({value: site.siteId, label: site.name || site.siteId}))
}
function requireSite(siteId, organizationPartyId) {
    if (blank(siteId)) return null
    if (!sitesOf(organizationPartyId).some(site => site.value === String(siteId)))
        denied("SITE_INVALID", "Choose a published site whose Marketing pages serve the organization")
    return String(siteId)
}
// An open campaign of the organization, else RECORD_UNAVAILABLE or CAMPAIGN_CLOSED.
function campaignOf(marketingCampaignId, organizationPartyId) {
    const campaign = blank(marketingCampaignId) ? null : one(CAMPAIGN, {marketingCampaignId: text(marketingCampaignId)})
    if (!campaign || campaign.organizationPartyId !== organizationPartyId)
        denied("RECORD_UNAVAILABLE", "Campaign " + (marketingCampaignId || "") + " is not available")
    if (!openCampaignStatuses.includes(campaign.statusId))
        denied("CAMPAIGN_CLOSED", "Campaign " + (campaign.campaignName || campaign.marketingCampaignId) + " is closed")
    return campaign
}
// A Marketing list of the organization (not a mailbox, not archived) a respondent may choose to subscribe to.
function subscriptionListOf(contactListId, organizationPartyId) {
    if (blank(contactListId)) return null
    const list = one(LIST, {contactListId: text(contactListId)})
    const audience = audiences()
    if (
        !list ||
        list.ownerPartyId !== organizationPartyId ||
        !audience.listTypes.includes(list.contactListTypeEnumId) ||
        audience.archived(list)
    )
        denied("RECORD_UNAVAILABLE", "List " + contactListId + " is not available")
    return list.contactListId
}
// The campaign link of a publication: its context record and a CampaignAssociation (CakForm), made once.
function linkCampaign(publicationId, campaign) {
    const existing = rows(ASSOCIATION, {
        marketingCampaignId: campaign.marketingCampaignId,
        associationKindEnumId: "CakForm",
        sourceId: publicationId
    }).find(row => lib.active(row))
    if (existing) return
    call("create#" + ASSOCIATION, {
        marketingCampaignId: campaign.marketingCampaignId,
        associationKindEnumId: "CakForm",
        sourceId: publicationId,
        purpose: "Survey",
        fromDate: ec.user.nowTimestamp,
        createdByUserId: ec.user.userId
    })
}
// The page a publication is answered on, when its site has the Marketing mount.
const pageUrlOf = row =>
    row.siteId && row.accessEnumId !== "FpaInvited"
        ? apps().pageUrl(row.siteId, "marketing", "/SubmitForm?publication=" + encodeURIComponent(row.publicationId))
        : null

// ===== store#Publication, publish#Publication =====
const STORED = [
    "accessEnumId",
    "repeatEnumId",
    "siteId",
    "description",
    "titleText",
    "introText",
    "completionMessage",
    "thruDate"
]
function storePublication(p) {
    const userScope = readScope()
    marketingAccess.requireCapability(userScope, "contentEdit")
    let form,
        row = null
    if (!blank(p.publicationId)) {
        const found = marketingPublication(p.publicationId, false, true)
        row = found.row
        form = found.form
    } else form = marketingForm(p.formId)
    const org = form.ownerPartyId
    marketingAccess.requireOrganization(userScope, org)
    const input = {}
    for (const name of STORED) if (p[name] !== undefined && p[name] !== null) input[name] = p[name]
    if (p.siteId !== undefined && p.siteId !== null) input.siteId = requireSite(p.siteId, org)
    let campaign = null
    if (!blank(p.marketingCampaignId)) {
        campaign = campaignOf(p.marketingCampaignId, org)
        if (row?.contextId && row.contextId !== campaign.marketingCampaignId && row.contextEntityName === CAMPAIGN)
            denied("CAMPAIGN_FIXED", "A publication keeps its campaign; make another for a different campaign")
        input.contextEntityName = CAMPAIGN
        input.contextId = campaign.marketingCampaignId
    }
    const subscriptionListId =
        p.subscriptionListId !== undefined && p.subscriptionListId !== null
            ? subscriptionListOf(p.subscriptionListId, org)
            : undefined
    const out = row
        ? publications().execute(
              "storePublication",
              Object.assign({publicationId: row.publicationId, expectedRevision: p.expectedRevision}, input)
          )
        : publications().execute("storePublication", Object.assign({formId: form.formId}, input))
    if (subscriptionListId !== undefined) call("update#" + PUBLICATION, {publicationId: out.publicationId, subscriptionListId})
    if (campaign) linkCampaign(out.publicationId, campaign)
    return {publicationId: out.publicationId, created: out.created}
}
// What a publication still needs to open: a published form, a site with the Marketing mount for the organization (the page and the
// invitation links), and for invitations a campaign (an invitation send is the campaign's).
function readinessOf(row) {
    const checks = [
        {name: "form", label: L("The form's questions are published"), ready: forms().formAt(row.formId, null, false).length > 0},
        {
            name: "site",
            label: L("A site whose Marketing pages serve the organization"),
            ready: !!row.siteId && sitesOf(row.organizationPartyId).some(site => site.value === row.siteId)
        }
    ]
    // P13: a lead form's answers go to Sales by its lead rule (MarketingLeads.js): one is current before it opens
    if (row.purposeEnumId === "FppLead")
        checks.push({
            name: "leadRule",
            label: L("A lead rule hands its answers to a sales team"),
            ready: ec.resource
                .script("component://mr-mantle/service/mantle/marketing/MarketingLeads.js")
                .routed(row.publicationId)
        })
    if (row.accessEnumId === "FpaInvited")
        checks.push({
            name: "campaign",
            label: L("A campaign for its invitation sends"),
            ready: row.contextEntityName === CAMPAIGN && !!row.contextId
        })
    return checks
}
function publishPublication(p) {
    const userScope = readScope()
    marketingAccess.requireCapability(userScope, "contentEdit")
    const {row} = marketingPublication(p.publicationId, false, true)
    const missing = readinessOf(row).filter(check => !check.ready)
    if (missing.length) denied("NOT_READY", L("Before it opens") + ": " + missing.map(check => check.label).join("; "))
    const fromDate = blank(p.fromDate) ? ec.user.nowTimestamp : p.fromDate
    if (Number(ms(fromDate)) < nowMs() - 5000) denied("INTERVAL_INVALID", "It opens now or later")
    publications().execute("storePublication", {publicationId: row.publicationId, expectedRevision: p.expectedRevision, fromDate})
    const after = one(PUBLICATION, {publicationId: row.publicationId})
    return {publicationId: row.publicationId, state: publications().stateOf(after)}
}

// ===== find#Publications, get#Publication =====
function publicationRow(row, form) {
    const view = publications().publicationView(row, form)
    const campaign =
        row.contextEntityName === CAMPAIGN && row.contextId ? one(CAMPAIGN, {marketingCampaignId: row.contextId}) : null
    return Object.assign(view, {
        accessText: L(accessTexts[row.accessEnumId] || row.accessEnumId || ""),
        repeatText: L(repeatTexts[row.repeatEnumId] || row.repeatEnumId || ""),
        purposeText: enumText(row.purposeEnumId),
        marketingCampaignId: campaign?.marketingCampaignId || null,
        campaignName: campaign ? campaign.campaignName || campaign.marketingCampaignId : "",
        siteName: row.siteId ? one("mantle.public.PublicSite", {siteId: row.siteId})?.name || row.siteId : "",
        subscriptionListId: row.subscriptionListId || null,
        subscriptionListName: row.subscriptionListId
            ? one(LIST, {contactListId: row.subscriptionListId})?.contactListName || row.subscriptionListId
            : "",
        pageUrl: pageUrlOf(row)
    })
}
// find#Publications: the Marketing publications of the scope, of one form or campaign when named, newest first.
function findPublications(p) {
    const userScope = readScope()
    let query = find(PUBLICATION)
        .condition("purposeEnumId", "in", PUBLICATION_PURPOSES)
        .orderBy("-createdDate")
        .limit(limits.rows)
    const ids = marketingAccess.organizationIds(userScope)
    query = query.condition("organizationPartyId", "in", ids.length ? ids : ["-"])
    if (!blank(p.formId)) query = query.condition("formId", text(p.formId))
    if (!blank(p.marketingCampaignId))
        query = query.condition("contextEntityName", CAMPAIGN).condition("contextId", text(p.marketingCampaignId))
    const out = []
    for (const row of Array.from(query.list())) {
        const form = one(FORM, {formId: row.formId})
        if (!form || !PURPOSES.includes(form.purposeEnumId) || form.ownerPartyId !== row.organizationPartyId) continue
        out.push(publicationRow(row, form))
    }
    return {publications: out}
}
// The invitation sends of a publication with their counts (invited, answered) and state.
function invitationSends(row) {
    return rows(SEND, {formPublicationId: row.publicationId})
        .sort((a, b) => String(b.createdDate || "").localeCompare(String(a.createdDate || "")))
        .map(send => {
            const invited = find(INVITATION, {publicationId: row.publicationId, recordId: send.campaignSendId}).count()
            const answered = find(INVITATION, {
                publicationId: row.publicationId,
                recordId: send.campaignSendId,
                statusEnumId: "FinResponded"
            }).count()
            return {
                campaignSendId: send.campaignSendId,
                sendName: send.sendName || send.campaignSendId,
                topicName: one(LIST, {contactListId: send.contactListId})?.contactListName || send.contactListId || "",
                statusText: one("moqui.basic.StatusItem", {statusId: send.statusId})?.description || send.statusId,
                invited,
                answered,
                expiresText: lib.dateText(row.thruDate)
            }
        })
}
// get#Publication: one publication of the scope (or, with formId only, what a new one of that form offers): its view, readiness,
// invitation sends, the sites, campaigns and lists to choose from, and what the caller may do.
function getPublication(p) {
    const userScope = readScope()
    const caps = userScope.capabilities
    let row = null,
        form
    if (!blank(p.publicationId)) {
        const found = marketingPublication(p.publicationId, true)
        row = found.row
        form = found.form
    } else form = marketingForm(p.formId, true)
    const org = form.ownerPartyId
    const canEdit = !!caps.contentEdit && forms().canEdit(forms().registrationOf(form.purposeEnumId))
    const registration = forms().registrationOf(form.purposeEnumId)
    const choices = {
        accessOptions: forms()
            .accessKinds(registration)
            .map(value => ({value, label: L(accessTexts[value] || value)})),
        siteOptions: sitesOf(org),
        campaignOptions: Array.from(
            find(CAMPAIGN, {organizationPartyId: org})
                .condition("statusId", "in", openCampaignStatuses)
                .orderBy("campaignName")
                .limit(100)
                .list()
        ).map(campaign => ({value: campaign.marketingCampaignId, label: campaign.campaignName || campaign.marketingCampaignId})),
        listOptions: Array.from(
            find(LIST, {ownerPartyId: org})
                .condition("contactListTypeEnumId", "in", audiences().listTypes)
                .orderBy("contactListName")
                .limit(100)
                .list()
        )
            .filter(list => !audiences().archived(list))
            .map(list => ({value: list.contactListId, label: list.contactListName || list.contactListId}))
    }
    const formView = {formId: form.formId, formName: form.description || form.formId, purposeText: enumText(form.purposeEnumId)}
    if (!row) return {publication: null, form: formView, readiness: [], invitationSends: [], choices, canEdit, canInvite: false}
    const view = publicationRow(row, form)
    const state = view.state
    return {
        publication: view,
        form: formView,
        readiness: readinessOf(row),
        invitationSends: invitationSends(row),
        choices,
        canEdit: canEdit && state !== "closed",
        canPublish: canEdit && (state === "draft" || state === "scheduled"),
        canClose: canEdit && state !== "closed" && state !== "draft",
        canInvite: !!caps.sendEdit && row.accessEnumId === "FpaInvited" && state !== "closed" && !!view.marketingCampaignId
    }
}

// ===== create#Invitations =====
// An invitation send of the publication's campaign to a topic (and audience), from a template when named: an ordinary draft send that
// names the publication; its approval, release and dispatch are the send's own. {campaignSendId}.
function createInvitations(p) {
    const userScope = readScope()
    marketingAccess.requireCapability(userScope, "sendEdit")
    const {row, form} = marketingPublication(p.publicationId, true)
    if (row.accessEnumId !== "FpaInvited") denied("PUBLICATION_NOT_OFFERED", "This publication is answered without an invitation")
    if (publications().stateOf(row) === "closed") denied("PUBLICATION_CLOSED", "The publication is closed")
    if (row.contextEntityName !== CAMPAIGN || !row.contextId)
        denied("CAMPAIGN_REQUIRED", "Give the publication a campaign first: an invitation send is the campaign's")
    if (!row.siteId) denied("NOT_READY", "Give the publication a site first: its invitation links open there")
    const made = call("mantle.marketing.CampaignSendServices.create#Send", {
        marketingCampaignId: row.contextId,
        sendName: text(p.sendName) || L("Invitation") + ": " + (row.titleText || form.description || row.publicationId),
        contactListId: p.contactListId,
        messageTemplateId: text(p.messageTemplateId),
        sendingProfileId: text(p.sendingProfileId),
        listIds: p.listIds || null,
        segmentIds: p.segmentIds || null,
        excludeListIds: p.excludeListIds || null,
        excludeSegmentIds: p.excludeSegmentIds || null
    })
    call("update#" + SEND, {campaignSendId: made.campaignSendId, formPublicationId: row.publicationId})
    return {campaignSendId: made.campaignSendId}
}
// The invitation link of one recipient of an invitation send, for build#CampaignDelivery: the FormInvitation made once per recipient
// (FinSent, its attempts counted) and a capability of the scope MarketingSurvey made for this attempt. {url, invitationId} or
// {suppress}.
function invitationLink(send, recipient, address) {
    const row = one(PUBLICATION, {publicationId: send.formPublicationId})
    if (!row || row.organizationPartyId !== send.organizationPartyId || row.accessEnumId !== "FpaInvited")
        return {suppress: "The survey is not available"}
    if (publications().stateOf(row) !== "open") return {suppress: "The survey is not open"}
    const thruMs = row.thruDate != null ? Number(ms(row.thruDate)) : nowMs() + limits.invitationDays * 86400000
    const made = publications().invite(row, {
        partyId: recipient.partyId,
        contactPartyId: recipient.partyId,
        emailAddress: address,
        invitationKey: "mkt-send:" + send.campaignSendId + ":" + recipient.partyId,
        recordEntityName: SEND,
        recordId: send.campaignSendId,
        statusEnumId: "FinSent",
        expireDate: new Date(thruMs)
    })
    const invitation = find(INVITATION, {invitationId: made.invitationId}).forUpdate(true).one()
    if (invitation.formResponseId) return {suppress: "The recipient has answered the survey"}
    if (["FinRevoked", "FinExpired"].includes(invitation.statusEnumId)) return {suppress: "The invitation is withdrawn"}
    invitation.set("statusEnumId", "FinSent")
    invitation.set("lastSentDate", ec.user.nowTimestamp)
    if (!invitation.sentDate) invitation.set("sentDate", ec.user.nowTimestamp)
    invitation.set("attemptCount", Number(invitation.attemptCount || 0) + 1)
    invitation.update()
    const access = ec.resource.script("component://mr-mantle/service/mantle/party/ExternalAccess.js")
    const capability = access.create({
        recordType: "FormInvitation",
        recordId: invitation.invitationId,
        scopes: "MarketingSurvey",
        thruDate: invitation.expireDate || new Date(thruMs)
    })
    const url = apps().pageUrl(row.siteId, "marketing", "/SubmitForm?token=" + encodeURIComponent(capability.token))
    if (!url) return {suppress: "The survey's site has no Marketing page"}
    return {url, invitationId: invitation.invitationId}
}

// ===== responses =====
// The submissions of a Marketing publication a reader of the scope may read, by the filters; only these, so a form's case feedback or
// any response not submitted to a Marketing publication is never in reach.
function submissionQuery(userScope, p) {
    const ids = marketingAccess.organizationIds(userScope)
    let query = find(SUBMISSION).condition("organizationPartyId", "in", ids.length ? ids : ["-"])
    if (!blank(p.formId)) query = query.condition("formId", text(p.formId))
    if (!blank(p.publicationId)) query = query.condition("publicationId", text(p.publicationId))
    if (!blank(p.fromDate)) query = query.condition("submittedDate", "greater-equals", p.fromDate)
    if (!blank(p.thruDate)) query = query.condition("submittedDate", "less", p.thruDate)
    return query
}
const isMarketingPublication = publicationId => {
    const row = publicationId ? one(PUBLICATION, {publicationId}) : null
    return !!row && PUBLICATION_PURPOSES.includes(row.purposeEnumId)
}
// The respondent as a reader may see them: named for an audience reader, else "A respondent"; anonymous when none was verified.
function respondentText(userScope, submission) {
    if (!submission.partyId) return L("Anonymous")
    return userScope.capabilities.audienceRead ? partyName(submission.partyId) : L("A respondent")
}
// A response's answers keyed by field (its FormResponseAnswer rows).
const answerMapOf = formResponseId =>
    Object.fromEntries(
        rows("moqui.screen.form.FormResponseAnswer", {formResponseId}).map(answer => [answer.fieldName, answer.valueText])
    )
// The form as of a date, cached per run of a summary by the rows in effect (a version), so each response reads its own questions.
function versionedForm(formId) {
    const definitions = forms()
    const fieldRows = rows("moqui.screen.form.DbFormField", {formId})
    const optionRows = rows("moqui.screen.form.DbFormFieldOption", {formId})
    const cache = new Map()
    const inEffect = (row, at) =>
        row.fromDate != null && Number(ms(row.fromDate)) <= at && (row.thruDate == null || Number(ms(row.thruDate)) > at)
    return date => {
        const at = Number(ms(date))
        const key =
            fieldRows
                .filter(row => inEffect(row, at))
                .map(row => row.fieldName)
                .join(",") +
            "|" +
            optionRows
                .filter(row => inEffect(row, at))
                .map(row => row.fieldName + ":" + row.sequenceNum)
                .join(",")
        if (!cache.has(key)) cache.set(key, definitions.formAt(formId, date, false))
        return cache.get(key)
    }
}
// A response's score with the form of its date: the selected options' scores of the answered scored questions (single choices), the
// number answered and the maximum of those apart; null when the form has no scored question then.
function scoreOfResponse(fields, answers) {
    let total = 0,
        answered = 0,
        maximum = 0,
        scoredQuestions = 0
    for (const field of fields) {
        const scored = field.options.filter(option => option.score != null)
        if (!scored.length || forms().TYPES[field.fieldTypeEnumId]?.multiple) continue
        scoredQuestions++
        const value = answers[field.fieldName]
        const option = blank(value) ? null : field.options.find(item => item.key === String(value))
        if (!option || option.score == null) continue
        answered++
        total += Number(option.score)
        maximum += Math.max(...scored.map(item => Number(item.score)))
    }
    return scoredQuestions ? {total, answered, maximum, scoredQuestions} : null
}
const scoreText = score => (score && score.answered ? score.total + " " + L("of") + " " + score.maximum : "")
// find#Responses: a form's responses (and its publication's, when named) for a reader of the scope, newest first, with the form and
// publication choices and the summary; {formOptions, formId, publicationOptions, publicationId, rows, stats}.
function findResponses(p) {
    const userScope = readScope()
    const found = forms().execute("findForms", {purposeEnumIds: PURPOSES, organizationPartyId: text(p.organizationPartyId)})
    const formOptions = Array.from(found.forms || []).map(form => ({
        value: form.formId,
        label: form.description + " (" + form.purposeText + ")"
    }))
    const formId =
        !blank(p.formId) && formOptions.some(option => option.value === String(p.formId))
            ? String(p.formId)
            : formOptions[0]?.value || null
    if (!blank(p.formId) && formId !== String(p.formId)) denied("RECORD_UNAVAILABLE", "Survey " + p.formId + " is not available")
    const publicationOptions = formId
        ? findPublications({formId}).publications.map(row => ({
              value: row.publicationId,
              label: (row.description || row.formName) + " · " + row.accessText + " · " + row.stateText
          }))
        : []
    const publicationId =
        !blank(p.publicationId) && publicationOptions.some(option => option.value === String(p.publicationId))
            ? String(p.publicationId)
            : null
    if (!blank(p.publicationId) && !publicationId)
        denied("RECORD_UNAVAILABLE", "Publication " + p.publicationId + " is not available")
    if (!formId) return {formOptions, formId: null, publicationOptions, publicationId: null, rows: [], stats: null}
    const formAtDate = versionedForm(formId)
    const submissions = Array.from(
        submissionQuery(userScope, {formId, publicationId, fromDate: p.fromDate, thruDate: p.thruDate})
            .orderBy("-submittedDate")
            .limit(limits.rows)
            .list()
    ).filter(row => isMarketingPublication(row.publicationId))
    const publicationNames = new Map()
    const out = submissions.map(submission => {
        if (!publicationNames.has(submission.publicationId)) {
            const publication = one(PUBLICATION, {publicationId: submission.publicationId})
            publicationNames.set(
                submission.publicationId,
                publication?.description || publication?.titleText || submission.publicationId
            )
        }
        const score = scoreOfResponse(formAtDate(submission.submittedDate), answerMapOf(submission.formResponseId))
        return {
            formSubmissionId: submission.formSubmissionId,
            formResponseId: submission.formResponseId,
            publicationId: submission.publicationId,
            publicationText: publicationNames.get(submission.publicationId),
            submittedText: lib.dateText(submission.submittedDate),
            respondentText: respondentText(userScope, submission),
            viaText: submission.invitationId ? L("Invitation") : submission.partyId ? L("Signed in") : L("Public page"),
            scoreText: scoreText(score)
        }
    })
    return {
        formOptions,
        formId,
        publicationOptions,
        publicationId,
        rows: out,
        stats: responseStats(userScope, {formId, publicationId, fromDate: p.fromDate, thruDate: p.thruDate})
    }
}
// get#Response: one response submitted to a Marketing publication of the scope, with the form as of its submission (its questions,
// option texts and scores then); anything else (a case's feedback, a response of no Marketing publication, another organization's)
// answers RECORD_UNAVAILABLE.
function getResponse(p) {
    const userScope = readScope()
    const submission = blank(p.formResponseId) ? null : one(SUBMISSION, {formResponseId: text(p.formResponseId)})
    if (
        !submission ||
        !isMarketingPublication(submission.publicationId) ||
        !marketingAccess.covers(userScope, submission.organizationPartyId)
    )
        denied("RECORD_UNAVAILABLE", "Response " + (p.formResponseId || "") + " is not available")
    const form = one(FORM, {formId: submission.formId})
    if (!form || !PURPOSES.includes(form.purposeEnumId))
        denied("RECORD_UNAVAILABLE", "Response " + p.formResponseId + " is not available")
    const registration = forms().registrationOf(form.purposeEnumId)
    if (!forms().canView(registration)) denied("RECORD_UNAVAILABLE", "Response " + p.formResponseId + " is not available")
    const publication = one(PUBLICATION, {publicationId: submission.publicationId})
    const answers = answerMapOf(submission.formResponseId)
    const fields = forms().formAt(submission.formId, submission.submittedDate, false)
    const score = scoreOfResponse(fields, answers)
    const versions = new Set(
        rows("moqui.screen.form.DbFormField", {formId: submission.formId})
            .filter(row => row.fromDate != null && Number(ms(row.fromDate)) <= Number(ms(submission.submittedDate)))
            .map(row => Number(ms(row.fromDate)))
    )
    return {
        response: {
            formResponseId: submission.formResponseId,
            formSubmissionId: submission.formSubmissionId,
            formId: submission.formId,
            formText: form.description || form.formId,
            versionText: versions.size ? L("Version") + " " + versions.size : "",
            publicationId: submission.publicationId,
            publicationText: publication?.description || publication?.titleText || submission.publicationId,
            respondentText: respondentText(userScope, submission),
            viaText: submission.invitationId ? L("Invitation") : submission.partyId ? L("Signed in") : L("Public page"),
            submittedText: lib.dateText(submission.submittedDate),
            scoreText: scoreText(score),
            scoreDetailText: score
                ? score.answered + " " + L("of") + " " + score.scoredQuestions + " " + L("scored questions answered")
                : "",
            effectsText: submission.effectsText || "",
            answers: forms()
                .answersOf(submission.formId, submission.submittedDate, answers)
                .map(answer => ({title: answer.title, valueText: answer.displayText}))
        }
    }
}
// The summary of a form's (or publication's) responses: invited, delivered and answered, the response rate, the scores (average total
// of the answered scored questions, with the answered count and maximum apart) and each choice's answers by option, each response read
// with the form of its date. Over limits.stats submissions it is truncated.
function responseStats(userScope, p) {
    const formAtDate = versionedForm(p.formId)
    const submissions = Array.from(
        submissionQuery(userScope, p)
            .orderBy("-submittedDate")
            .limit(limits.stats + 1)
            .list()
    ).filter(row => isMarketingPublication(row.publicationId))
    const truncated = submissions.length > limits.stats
    if (truncated) submissions.length = limits.stats
    let invitationQuery = find(INVITATION, {formId: p.formId})
    if (!blank(p.publicationId)) invitationQuery = invitationQuery.condition("publicationId", text(p.publicationId))
    const invitations = Array.from(invitationQuery.list()).filter(
        row => row.recordEntityName === SEND && marketingAccess.covers(userScope, row.organizationPartyId)
    )
    const invited = invitations.length
    const delivered = invitations.filter(row => ["FinSent", "FinResponded"].includes(row.statusEnumId)).length
    const answeredInvitations = invitations.filter(row => row.statusEnumId === "FinResponded").length
    const questions = new Map()
    let scoredResponses = 0,
        scoreTotal = 0,
        answeredTotal = 0,
        maximumTotal = 0
    for (const submission of submissions) {
        const fields = formAtDate(submission.submittedDate)
        const answers = answerMapOf(submission.formResponseId)
        const score = scoreOfResponse(fields, answers)
        if (score && score.answered) {
            scoredResponses++
            scoreTotal += score.total
            answeredTotal += score.answered
            maximumTotal += score.maximum
        }
        for (const field of fields) {
            if (!forms().TYPES[field.fieldTypeEnumId]?.choice) continue
            const value = answers[field.fieldName]
            if (blank(value)) continue
            const question = questions.get(field.fieldName) || {
                fieldName: field.fieldName,
                title: field.title,
                counts: new Map(),
                answered: 0
            }
            question.answered++
            for (const part of String(value).split(",").filter(Boolean)) {
                const option = field.options.find(item => item.key === part)
                const label = option?.text || part
                question.counts.set(label, (question.counts.get(label) || 0) + 1)
            }
            questions.set(field.fieldName, question)
        }
    }
    const share = (count, of) => (of ? Math.round((count * 1000) / of) / 10 + "%" : "")
    const average = value => Math.round(value * 10) / 10
    return {
        invited,
        delivered,
        answered: submissions.length,
        answeredInvitations,
        responseRateText: invited ? share(answeredInvitations, invited) : "",
        scoredResponses,
        averageText: scoredResponses ? String(average(scoreTotal / scoredResponses)) : "",
        averageMaximumText: scoredResponses ? String(average(maximumTotal / scoredResponses)) : "",
        averageAnsweredText: scoredResponses ? String(average(answeredTotal / scoredResponses)) : "",
        questions: Array.from(questions.values()).map(question => ({
            fieldName: question.fieldName,
            title: question.title,
            answered: question.answered,
            options: Array.from(question.counts.entries()).map(([text, count]) => ({
                text,
                count,
                shareText: share(count, question.answered)
            }))
        })),
        truncated
    }
}
function getResponseStats(p) {
    const userScope = readScope()
    const form = marketingForm(p.formId, true)
    if (!blank(p.publicationId)) {
        const {row} = marketingPublication(p.publicationId, true)
        if (row.formId !== form.formId) denied("RECORD_UNAVAILABLE", "Publication " + p.publicationId + " is not available")
    }
    return {
        stats: responseStats(userScope, {
            formId: form.formId,
            publicationId: text(p.publicationId),
            fromDate: p.fromDate,
            thruDate: p.thruDate
        })
    }
}

const operations = {
    formScope,
    storePublication,
    publishPublication,
    findPublications,
    getPublication,
    createInvitations,
    findResponses,
    getResponse,
    getResponseStats
}
;({
    PURPOSES,
    PUBLICATION_PURPOSES,
    invitationLink,
    scoreOfResponse,
    // each operation checks the caller's Marketing scope and permission, and reads and writes with artifact authorization off
    execute(op, parameters) {
        if (!Object.hasOwn(operations, op)) throw new Error("Unknown marketing form operation " + op)
        const wasDisabled = ec.artifactExecution.disableAuthz()
        try {
            return operations[op](parameters || {})
        } finally {
            if (!wasDisabled) ec.artifactExecution.enableAuthz()
        }
    }
})
