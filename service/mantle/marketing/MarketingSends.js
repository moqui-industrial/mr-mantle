// Marketing's sends and their composer (mantle.marketing.CampaignSendServices, D; IronStone Marketing design §5 Sends, SendDetail,
// Compose, §14.1 CampaignSend, CampaignRecipient, CampaignSendContent, §18; impl-marketing P8, §4 Nov 14). A send is one prepared
// promotional delivery intent of a campaign: its topic (a Marketing list of the campaign's organization), its audience (lists and
// segments, and those that exclude), its sending profile, its own content and its schedule.
//
// - Who: a Marketing reader of the send's organization reads it (design §2: Sends is the app's); MARKETING_SEND_EDIT writes it, the
//   approver decides it through the approvals (MarketingApprovals.js, its send kind below), the dispatcher releases it (P9). Another
//   organization's send, or a missing one, answers as missing (RECORD_UNAVAILABLE).
// - Content: a send's own subject, preheader, body, text alternative and declared variables, copied from a template of its
//   organization (P6 review R5) when it is made from one, then edited; a later change of the template never reaches it. The content
//   is checked and kept as a template's is (MessageTemplates.js: no expression, tag, script, unsafe HTML or variable in a link; a file
//   of its own per change, rendered by location with the declared variables alone), and a link to a staff page or a stored file is
//   refused (PRIVATE_LINK). A variable's value is the recipient's own (recipientFields: first name, last name, name), else its
//   fallback; a required variable that names no recipient field is unknown and blocks preparation (VARIABLE_UNKNOWN).
// - Assets: a file of the send or of its campaign (each a file the caller sees), attached to the message; a publicly retrievable
//   inline file is not offered for staff files (USAGE_INVALID), so no private file becomes public.
// - Revisions: every write names the send's lastUpdatedStamp (expectedRevision; STALE_REVISION naming the current one). A change of
//   the subject, body, sender, audience or schedule raises sendRevision, ends the approval (its requests and decisions superseded)
//   and returns the send to draft; once released (scheduled, sending and after) the content never changes: a new send is made.
// - Preparation (prepare#Send, a draft, as the user who prepares: classify#Recipients decides "not available" from the calling user,
//   P5 review): the audience evaluated in pages (MarketingEligibility.js evaluateSend, the user's call of Nov 14), its eligible
//   people recorded as CampaignRecipient rows (the earlier preparation's replaced), the content kept as a rendered resource of its
//   own, the content and policy time recorded; a preview identity given (resultDigest) that no longer matches is refused with the
//   new count (PREVIEW_STALE).
// - Approval: requested and decided through the approvals at the send's revision; what approval needs (problems): a preparation at
//   the current revision, an eligible recipient, an approved campaign and a ready promotional sending profile.
// - Test (test#Send): to an address of the organization's policy test allowlist only (TEST_ADDRESS_NOT_ALLOWED), at most
//   testDailyLimit a day a send, as a ledger delivery of its own source (MdsrcCampaignSendTest) naming the send's profile, marked
//   TEST, never a recipient, an approval or a count.
// Refusals carry reason codes (EntityLib.js denied).
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const marketingAccess = ec.resource.script("component://mr-mantle/service/mantle/marketing/MarketingAccess.js")
const approvals = ec.resource.script("component://mr-mantle/service/mantle/marketing/MarketingApprovals.js")
const eligibility = ec.resource.script("component://mr-mantle/service/mantle/marketing/MarketingEligibility.js")
const segments = ec.resource.script("component://mr-mantle/service/mantle/marketing/MarketingSegments.js")
const templates = ec.resource.script("component://mr-mantle/service/mantle/party/MessageTemplates.js")
const profiles = ec.resource.script("component://mr-mantle/service/mantle/party/MessageSendingProfiles.js")
const suppressions = ec.resource.script("component://mr-mantle/service/mantle/party/MessageSuppressions.js")
const {find, one, rows, denied, call, ms} = lib
// P9: the release and dispatch (loaded when a send is read, so it may load this module)
const dispatch = () => ec.resource.script("component://mr-mantle/service/mantle/marketing/MarketingDispatch.js")

const SEND = "mantle.marketing.campaign.CampaignSend"
const RECIPIENT = "mantle.marketing.campaign.CampaignRecipient"
const SEND_CONTENT = "mantle.marketing.campaign.CampaignSendContent"
const CAMPAIGN = "mantle.marketing.campaign.MarketingCampaign"
const LIST = "mantle.marketing.contact.ContactList"
const TEMPLATE = "mantle.party.MessageTemplate"
const PROFILE = "mantle.party.MessageSendingProfile"
const testTemplateId = "MANTLE_CAMPAIGN_SEND_TEST"
const testDailyLimit = 20
const sourceCap = 20
const nameLimit = 120
// the values a recipient gives a send's variables (design §5 Compose: a plain snapshot of allowlisted values), and the synthetic
// sample an author without audience rights previews with
const recipientFields = {firstName: "First name", lastName: "Last name", fullName: "Name"}
const syntheticValues = {firstName: "Alex", lastName: "Sample", fullName: "Alex Sample"}
const editableStatuses = ["CsDraft", "CsAwaitingApproval", "CsApproved"]
const openCampaignStatuses = ["MKTG_CAMP_PLANNED", "MKTG_CAMP_APPROVED", "MKTG_CAMP_INPROGRESS"]
const approvedCampaignStatuses = ["MKTG_CAMP_APPROVED", "MKTG_CAMP_INPROGRESS"]
const statusColors = {
    CsDraft: "warning",
    CsAwaitingApproval: "info",
    CsApproved: "positive",
    CsScheduled: "primary",
    CsSending: "primary",
    CsPaused: "warning",
    CsCompleted: "positive",
    CsCompletedFailures: "negative",
    CsCancelled: "grey-7"
}
const openStatuses = ["CsDraft", "CsAwaitingApproval", "CsApproved", "CsScheduled", "CsSending", "CsPaused"]
// a link or source that reaches a staff page or a stored file, never a message's (a private staff URL is never made public)
const privateLink =
    /(href|src|background)\s*=\s*["']?\s*(\/(qapps|apps|vapps|rest|tools|system|m)\/|[a-z]+:\/\/[^"'\s>]*\/(qapps|apps|vapps|rest)\/|(dbresource|component|file|content):)/i

const text = value => (value == null ? "" : String(value).trim())
const blank = value => text(value) === ""
const nowMs = () => ms(ec.user.nowTimestamp)
const listOf = value =>
    value == null || value === ""
        ? []
        : Array.from(
              new Set((typeof value === "string" ? value.split(",") : Array.from(value)).map(item => text(item)).filter(Boolean))
          )
const enumText = enumId => (enumId ? one("moqui.basic.Enumeration", {enumId})?.description || enumId : "")
const statusText = statusId => (statusId ? one("moqui.basic.StatusItem", {statusId})?.description || statusId : "")
const organizationName = partyId => (partyId ? one("mantle.party.Organization", {partyId})?.organizationName || partyId : "")
const userParty = userId => (userId ? one("moqui.security.UserAccount", {userId})?.partyId || null : null)

// ===== scope and records =====
function readScope() {
    const userScope = marketingAccess.scope()
    if (!userScope.capabilities.anyRead) denied("PERMISSION_DENIED", "Marketing sends are not open to you")
    return userScope
}
function editScope() {
    const userScope = readScope()
    marketingAccess.requireCapability(userScope, "sendEdit")
    return userScope
}
// A send of the scope, else RECORD_UNAVAILABLE (missing, another organization's or unowned alike).
function sendOf(userScope, campaignSendId, lock = false) {
    const id = text(campaignSendId)
    let query = id ? find(SEND, {campaignSendId: id}) : null
    if (query && lock) query = query.forUpdate(true)
    const row = query ? query.one() : null
    if (!row || !marketingAccess.covers(userScope, row.organizationPartyId))
        denied("RECORD_UNAVAILABLE", "Send " + id + " is not available")
    return row
}
function requireRevision(row, expectedRevision) {
    if (blank(expectedRevision)) denied("REVISION_REQUIRED", "Name the revision of send " + row.campaignSendId + " you read")
    if (ms(expectedRevision) !== ms(row.lastUpdatedStamp))
        denied(
            "STALE_REVISION",
            "Send " + row.campaignSendId + " changed since it was read; its revision is now " + ms(row.lastUpdatedStamp)
        )
}
function requireEditable(row) {
    if (!editableStatuses.includes(row.statusId))
        denied(
            "SEND_RELEASED",
            "Send " +
                row.campaignSendId +
                " is " +
                statusText(row.statusId).toLowerCase() +
                ": its content no longer changes; duplicate it"
        )
}
const label = row => row.sendName || row.campaignSendId
const audienceOf = row => {
    const found = lib.json(row.audienceJson, {}) || {}
    return {
        listIds: listOf(found.listIds),
        segmentIds: listOf(found.segmentIds),
        excludeListIds: listOf(found.excludeListIds),
        excludeSegmentIds: listOf(found.excludeSegmentIds)
    }
}
const variablesOf = row => lib.json(row.variablesJson, []) || []
const preparedCurrent = row => row.preparedRevision != null && Number(row.preparedRevision) === Number(row.sendRevision || 1)

// The campaign a send may belong to: one of the scope, open (CAMPAIGN_CLOSED).
function campaignFor(userScope, marketingCampaignId) {
    const campaign = blank(marketingCampaignId) ? null : one(CAMPAIGN, {marketingCampaignId: text(marketingCampaignId)})
    if (!campaign || !marketingAccess.covers(userScope, campaign.organizationPartyId))
        denied("RECORD_UNAVAILABLE", "Campaign " + text(marketingCampaignId) + " is not available")
    if (!openCampaignStatuses.includes(campaign.statusId))
        denied("CAMPAIGN_CLOSED", "Campaign " + (campaign.campaignName || campaign.marketingCampaignId) + " is closed")
    return campaign
}
// A Marketing list of the organization that is not archived (a topic or a source), else RECORD_UNAVAILABLE.
function listFor(contactListId, organizationPartyId, what = "List") {
    const row = blank(contactListId) ? null : one(LIST, {contactListId: text(contactListId)})
    if (!row || !eligibility.listTypes.includes(row.contactListTypeEnumId) || row.ownerPartyId !== organizationPartyId)
        denied("RECORD_UNAVAILABLE", what + " " + text(contactListId) + " is not available")
    if (row.archivedDate != null && ms(row.archivedDate) <= nowMs())
        denied("LIST_ARCHIVED", "List " + (row.contactListName || row.contactListId) + " is archived")
    return row
}
// A topic: a list of email (the email channel of this phase; SMS is P22).
function topicFor(contactListId, organizationPartyId) {
    const row = listFor(contactListId, organizationPartyId, "Topic")
    if (eligibility.channelOfList(row) !== "MdcEmail")
        denied("CHANNEL_UNAVAILABLE", "Topic " + (row.contactListName || row.contactListId) + " is a list of text messages")
    return row
}
function segmentFor(userScope, marketSegmentId, organizationPartyId) {
    const row = segments.segmentOfScope(userScope, marketSegmentId)
    if (row.ownerPartyId !== organizationPartyId) denied("RECORD_UNAVAILABLE", "Segment " + marketSegmentId + " is not available")
    if (segments.archived(row)) denied("SEGMENT_ARCHIVED", "Segment " + segments.segmentLabel(row) + " is archived")
    return row
}
// The audience checked: every list and segment of the organization (at most sourceCap), as JSON.
function audienceFor(userScope, p, organizationPartyId) {
    const audience = {
        listIds: listOf(p.listIds),
        segmentIds: listOf(p.segmentIds),
        excludeListIds: listOf(p.excludeListIds),
        excludeSegmentIds: listOf(p.excludeSegmentIds)
    }
    const count = Object.values(audience).reduce((sum, ids) => sum + ids.length, 0)
    if (count > sourceCap) denied("TOO_MANY_SOURCES", "A send takes at most " + sourceCap + " lists and segments")
    for (const id of audience.listIds.concat(audience.excludeListIds)) listFor(id, organizationPartyId)
    for (const id of audience.segmentIds.concat(audience.excludeSegmentIds)) segmentFor(userScope, id, organizationPartyId)
    return audience
}
// A sending profile a promotional send may name: one of the organization, in effect, promotional or for both (PROFILE_PURPOSE; the
// P6 review: a profile's purpose is checked against the delivery's).
function profileFor(sendingProfileId, organizationPartyId) {
    if (blank(sendingProfileId)) return null
    const row = one(PROFILE, {sendingProfileId: text(sendingProfileId)})
    if (!row || row.organizationPartyId !== organizationPartyId)
        denied("RECORD_UNAVAILABLE", "Sending profile " + text(sendingProfileId) + " is not available")
    if (row.thruDate != null && ms(row.thruDate) <= nowMs()) denied("PROFILE_ENDED", "That sending profile has ended")
    if (row.purposeEnumId === "MtpTransactional")
        denied(
            "PROFILE_PURPOSE",
            "Sending profile " + (row.profileName || row.sendingProfileId) + " is for transactional messages"
        )
    return row
}
// A template a send may start from: one of the organization (P6 review R5), in use, promotional, with content in effect, read by a
// holder of a template permission (TEMPLATE_UNAVAILABLE otherwise).
function templateFor(userScope, messageTemplateId, organizationPartyId) {
    if (blank(messageTemplateId)) return null
    const caps = userScope.capabilities
    const row = one(TEMPLATE, {messageTemplateId: text(messageTemplateId)})
    if (!row || row.organizationPartyId !== organizationPartyId || !(caps.templateView || caps.templateEdit))
        denied("TEMPLATE_UNAVAILABLE", "Template " + text(messageTemplateId) + " is not available")
    if (row.thruDate != null && ms(row.thruDate) <= nowMs()) denied("TEMPLATE_ENDED", "That template has ended")
    if (row.purposeEnumId === "MtpTransactional")
        denied("TEMPLATE_PURPOSE", "Template " + (row.templateName || row.messageTemplateId) + " is for transactional messages")
    const content = templates.currentOf(templates.contentsOf(row.messageTemplateId))
    if (!content) denied("NO_CONTENT", "Template " + (row.templateName || row.messageTemplateId) + " has no published content")
    return {row, content}
}

// ===== content =====
// A body's links and sources checked: none reaches a staff page or a stored file.
function checkLinks(body) {
    if (privateLink.test(String(body || "")))
        denied(
            "PRIVATE_LINK",
            "The body links a staff page or a stored file, which a recipient cannot open: attach a file instead"
        )
}
// The files of a send's content, each written apart (the renderer's cache is by location).
function writeFiles(campaignSendId, folder, body, bodyText) {
    const key = ec.user.randomString(12).replace(/[^A-Za-z0-9]/g, "x")
    const base = "dbresource://mantle/campaign-send/" + campaignSendId + "/" + folder + "-" + key + "/"
    const bodyLocation = base + "body.html.fancy-locked"
    ec.resource.getLocationReference(bodyLocation).putText(body || "")
    let bodyTextLocation = null
    if (bodyText) {
        bodyTextLocation = base + "text.fancy-locked"
        ec.resource.getLocationReference(bodyTextLocation).putText(bodyText)
    }
    return {bodyLocation, bodyTextLocation}
}
const contentOf = row => ({
    subject: row.subject || "",
    preheader: row.preheader || "",
    body: templates.readText(row.bodyLocation),
    bodyText: templates.readText(row.bodyTextLocation),
    variables: variablesOf(row)
})
// The required variables that name no recipient field: unknown, they block preparation.
const unknownRequired = variables =>
    variables
        .filter(variable => variable.required && !Object.hasOwn(recipientFields, variable.name))
        .map(variable => variable.name)
// A recipient's values: the allowlisted fields of the person, nothing else.
function recipientValues(partyId) {
    const person = partyId ? one("mantle.party.Person", {partyId}) : null
    if (!person) return {}
    const fullName = [person.firstName, person.lastName].filter(Boolean).join(" ")
    return {firstName: person.firstName || null, lastName: person.lastName || null, fullName: fullName || null}
}
// A content rendered with values: {subject, preheader, body, bodyText, missing}.
function render(content, values) {
    const {map, missing} = templates.renderMap(content.variables, values)
    return {
        subject: templates.fill(content.subject, map),
        preheader: templates.fill(content.preheader, map),
        body: templates.renderLocation(content.bodyLocation, map),
        bodyText: templates.renderLocation(content.bodyTextLocation, map),
        missing
    }
}
const draftContent = row => ({
    subject: row.subject || "",
    preheader: row.preheader || "",
    bodyLocation: row.bodyLocation,
    bodyTextLocation: row.bodyTextLocation,
    variables: variablesOf(row)
})
const preparedContent = row => ({
    subject: row.preparedSubject || "",
    preheader: row.preparedPreheader || "",
    bodyLocation: row.preparedBodyLocation,
    bodyTextLocation: row.preparedTextLocation,
    variables: lib.json(row.preparedVariablesJson, []) || []
})

// ===== revisions =====
// A material change (subject, body, sender, audience, schedule): the revision raised, the approval ended and the send back to draft.
function revise(row, values, reason) {
    const newRevision = Number(row.sendRevision || 1) + 1
    const update = Object.assign(
        {campaignSendId: row.campaignSendId, sendRevision: newRevision, revisedByUserId: ec.user.userId},
        values
    )
    if (row.statusId !== "CsDraft") {
        update.statusId = "CsDraft"
        update.statusId_changeReason = reason
    }
    call("update#" + SEND, update)
    approvals.supersede("send", row.campaignSendId, newRevision)
    return newRevision
}

// ===== the approvals' send kind (MarketingApprovals.js targetKinds) =====
// What approval needs of a send: a preparation at its current revision with an eligible recipient, an approved campaign, and a
// sending profile that is ready and promotional.
function sendProblems(row) {
    const problems = []
    if (!preparedCurrent(row)) problems.push("it needs to be prepared at its current revision")
    else if (!Number(row.eligibleCount || 0)) problems.push("it has no eligible recipient")
    const campaign = one(CAMPAIGN, {marketingCampaignId: row.marketingCampaignId})
    if (!campaign || !approvedCampaignStatuses.includes(campaign.statusId)) problems.push("its campaign is not approved")
    const profile = row.sendingProfileId ? one(PROFILE, {sendingProfileId: row.sendingProfileId}) : null
    if (!profile) problems.push("it needs a sending profile")
    else if (profile.purposeEnumId === "MtpTransactional") problems.push("its sending profile is for transactional messages")
    else if (!profiles.readinessOf(profile).ready) problems.push("its sending profile is not ready")
    if (blank(row.subject)) problems.push("it needs a subject")
    return problems
}
// MarketingApprovals.js targetKinds.send delegates to this (loaded when a send is decided)
const sendKind = {
    read: (targetId, lock) => {
        const query = find(SEND, {campaignSendId: targetId})
        return (lock ? query.forUpdate(true) : query).one()
    },
    revision: row => Number(row.sendRevision || 1),
    organization: row => row.organizationPartyId,
    // its creator and whoever made the current revision's change
    authors: row => Array.from(new Set([row.createdByUserId, row.revisedByUserId].filter(Boolean))),
    label: row => label(row),
    // the recipients counted at the preparation of the current revision (a send of no preparation has no count: never self-approved)
    recipientCount: row => (preparedCurrent(row) ? Number(row.eligibleCount || 0) : null),
    requestable: row => {
        if (row.statusId !== "CsDraft")
            denied("STATUS_INVALID", "Send " + row.campaignSendId + " is " + statusText(row.statusId).toLowerCase())
    },
    problems: row => sendProblems(row),
    requested: row =>
        call("update#" + SEND, {
            campaignSendId: row.campaignSendId,
            statusId: "CsAwaitingApproval",
            statusId_changeReason: "Approval asked by " + (ec.user.username || ec.user.userId)
        }),
    approved: row =>
        call("update#" + SEND, {
            campaignSendId: row.campaignSendId,
            statusId: "CsApproved",
            statusId_changeReason: "Approved by " + (ec.user.username || ec.user.userId)
        }),
    refused: row =>
        call("update#" + SEND, {
            campaignSendId: row.campaignSendId,
            statusId: "CsDraft",
            statusId_changeReason: "Refused by " + (ec.user.username || ec.user.userId)
        })
}

// ===== projections =====
function sendRow(row, extra = {}) {
    const campaign = one(CAMPAIGN, {marketingCampaignId: row.marketingCampaignId})
    const topic = row.contactListId ? one(LIST, {contactListId: row.contactListId}) : null
    const profile = row.sendingProfileId ? one(PROFILE, {sendingProfileId: row.sendingProfileId}) : null
    return Object.assign(
        {
            campaignSendId: row.campaignSendId,
            sendName: label(row),
            marketingCampaignId: row.marketingCampaignId,
            campaignName: campaign?.campaignName || row.marketingCampaignId,
            organizationPartyId: row.organizationPartyId,
            organizationName: organizationName(row.organizationPartyId),
            channelEnumId: row.channelEnumId,
            channelText: enumText(row.channelEnumId) || "Email",
            contactListId: row.contactListId,
            topicName: topic ? topic.contactListName || topic.contactListId : "",
            sendingProfileId: row.sendingProfileId || null,
            profileName: profile ? profile.profileName || profile.sendingProfileId : "",
            subject: row.subject || "",
            statusId: row.statusId,
            statusText: statusText(row.statusId),
            statusColor: statusColors[row.statusId] || "grey-7",
            scheduledDate: row.scheduledDate || null,
            scheduledText: row.scheduledDate ? lib.dateText(row.scheduledDate) : "At release",
            sendRevision: Number(row.sendRevision || 1),
            prepared: preparedCurrent(row),
            eligibleCount: preparedCurrent(row) ? Number(row.eligibleCount || 0) : null,
            eligibleText: preparedCurrent(row) ? String(Number(row.eligibleCount || 0)) : "Not prepared",
            createdDateText: lib.dateText(row.createdDate),
            revision: ms(row.lastUpdatedStamp)
        },
        extra
    )
}

// ===== find#Sends =====
function findSends(p) {
    const userScope = readScope()
    const ids = marketingAccess.organizationIds(userScope)
    const organizationPartyId = text(p.organizationPartyId)
    if (organizationPartyId && !marketingAccess.covers(userScope, organizationPartyId))
        denied("ORGANIZATION_DENIED", "Organization " + organizationPartyId + " is not available")
    const scoped = organizationPartyId ? [organizationPartyId] : ids
    if (!scoped.length) return lib.pageList([], p, "sendList")
    let query = find(SEND).condition("organizationPartyId", "in", scoped)
    const statusId = text(p.statusId)
    if (!statusId || statusId === "open") query = query.condition("statusId", "in", openStatuses)
    else if (statusId !== "all") query = query.condition("statusId", statusId)
    if (!blank(p.marketingCampaignId)) query = query.condition("marketingCampaignId", text(p.marketingCampaignId))
    if (!blank(p.channelEnumId)) query = query.condition("channelEnumId", text(p.channelEnumId))
    if (p.mine === "Y" || p.mine === true) query = query.condition("createdByUserId", ec.user.userId)
    if (!blank(p.rangeFrom)) query = query.condition("scheduledDate", "greater-equals", p.rangeFrom)
    if (!blank(p.rangeThru)) query = query.condition("scheduledDate", "less", p.rangeThru)
    if (!blank(p.text)) {
        const factory = ec.entity.conditionFactory
        const like = "%" + text(p.text).replace(/[\\%_]/g, c => "\\" + c) + "%"
        query = query.condition(
            factory.makeCondition(
                ["campaignSendId", "sendName", "subject"].map(field => factory.makeCondition(field, "like", like).ignoreCase()),
                "or"
            )
        )
    }
    const orderByField = text(p.orderByField)
    const allowedOrder = ["sendName", "-sendName", "scheduledDate", "-scheduledDate", "createdDate", "-createdDate"]
    query = query.orderBy(allowedOrder.includes(orderByField) ? orderByField : "-createdDate")
    const count = query.count()
    const paged = lib.page(query, p, "sendList", count, {noLimitCap: 1000})
    const sendList = paged.rows.map(row => sendRow(row))
    delete paged.rows
    paged.sendList = sendList
    return Object.assign(paged, {canCreate: !!userScope.capabilities.sendEdit})
}

// ===== create#Send, duplicate#Send =====
function nameOf(value) {
    const name = text(value)
    if (!name) denied("NAME_REQUIRED", "Give the send a name")
    if (name.length > nameLimit) denied("VALUE_INVALID", "A send's name is at most " + nameLimit + " characters")
    return name
}
function createSend(p) {
    const userScope = editScope()
    const campaign = campaignFor(userScope, p.marketingCampaignId)
    const org = campaign.organizationPartyId
    const sendName = nameOf(p.sendName)
    const channelEnumId = text(p.channelEnumId) || "MdcEmail"
    if (channelEnumId !== "MdcEmail") denied("CHANNEL_UNAVAILABLE", "Sends go by email")
    const topic = topicFor(p.contactListId, org)
    const audience = audienceFor(userScope, p, org)
    const profile = profileFor(p.sendingProfileId, org)
    const template = templateFor(userScope, p.messageTemplateId, org)
    const made = call("create#" + SEND, {
        marketingCampaignId: campaign.marketingCampaignId,
        organizationPartyId: org,
        sendName,
        channelEnumId,
        contactListId: topic.contactListId,
        purposeEnumId: eligibility.purposeOf(topic),
        audienceJson: JSON.stringify(audience),
        messageTemplateId: template?.row.messageTemplateId || null,
        sendingProfileId: profile?.sendingProfileId || null,
        localeId: template?.row.localeId || null,
        statusId: "CsDraft",
        sendRevision: 1,
        createdByUserId: ec.user.userId,
        revisedByUserId: ec.user.userId,
        createdDate: ec.user.nowTimestamp
    })
    const campaignSendId = made.campaignSendId
    // the template's content in effect, copied: the send's own from now on
    if (template) {
        const content = template.content
        const files = writeFiles(
            campaignSendId,
            "draft",
            templates.readText(content.bodyLocation),
            templates.readText(content.bodyTextLocation)
        )
        call("update#" + SEND, {
            campaignSendId,
            subject: content.subject || null,
            preheader: content.preheader || null,
            bodyLocation: files.bodyLocation,
            bodyTextLocation: files.bodyTextLocation,
            variablesJson: content.variablesJson || "[]"
        })
    }
    return {campaignSendId}
}
// duplicate#Send: a new draft with the send's topic, audience, profile and content; never its recipients, approval or preparation.
function duplicateSend(p) {
    const userScope = editScope()
    const source = sendOf(userScope, p.campaignSendId)
    const campaign = campaignFor(userScope, source.marketingCampaignId)
    const sendName = blank(p.sendName) ? ("Copy of " + label(source)).slice(0, nameLimit) : nameOf(p.sendName)
    const made = call("create#" + SEND, {
        marketingCampaignId: campaign.marketingCampaignId,
        organizationPartyId: source.organizationPartyId,
        sendName,
        channelEnumId: source.channelEnumId,
        contactListId: source.contactListId,
        purposeEnumId: source.purposeEnumId,
        audienceJson: source.audienceJson,
        messageTemplateId: source.messageTemplateId,
        sendingProfileId: source.sendingProfileId,
        replyToAddress: source.replyToAddress,
        localeId: source.localeId,
        subject: source.subject,
        preheader: source.preheader,
        variablesJson: source.variablesJson,
        statusId: "CsDraft",
        sendRevision: 1,
        createdByUserId: ec.user.userId,
        revisedByUserId: ec.user.userId,
        createdDate: ec.user.nowTimestamp,
        duplicatedFromSendId: source.campaignSendId
    })
    const files = writeFiles(
        made.campaignSendId,
        "draft",
        templates.readText(source.bodyLocation),
        templates.readText(source.bodyTextLocation)
    )
    call("update#" + SEND, {
        campaignSendId: made.campaignSendId,
        bodyLocation: files.bodyLocation,
        bodyTextLocation: files.bodyTextLocation
    })
    return {campaignSendId: made.campaignSendId}
}

// ===== store#Send: the header, topic, audience and sender =====
function storeSend(p) {
    const userScope = editScope()
    const row = sendOf(userScope, p.campaignSendId, true)
    requireEditable(row)
    requireRevision(row, p.expectedRevision)
    const org = row.organizationPartyId
    const values = {}
    const changed = []
    if (p.sendName != null && text(p.sendName) !== (row.sendName || "")) values.sendName = nameOf(p.sendName)
    if (p.contactListId != null && text(p.contactListId) !== (row.contactListId || "")) {
        const topic = topicFor(p.contactListId, org)
        values.contactListId = topic.contactListId
        values.purposeEnumId = eligibility.purposeOf(topic)
        changed.push("topic")
    }
    if (p.listIds != null || p.segmentIds != null || p.excludeListIds != null || p.excludeSegmentIds != null) {
        const current = audienceOf(row)
        const audience = audienceFor(
            userScope,
            {
                listIds: p.listIds != null ? p.listIds : current.listIds,
                segmentIds: p.segmentIds != null ? p.segmentIds : current.segmentIds,
                excludeListIds: p.excludeListIds != null ? p.excludeListIds : current.excludeListIds,
                excludeSegmentIds: p.excludeSegmentIds != null ? p.excludeSegmentIds : current.excludeSegmentIds
            },
            org
        )
        if (JSON.stringify(audience) !== JSON.stringify(current)) {
            values.audienceJson = JSON.stringify(audience)
            changed.push("audience")
        }
    }
    if (p.sendingProfileId != null && text(p.sendingProfileId) !== (row.sendingProfileId || "")) {
        values.sendingProfileId = profileFor(p.sendingProfileId, org)?.sendingProfileId || null
        changed.push("sender")
    }
    if (p.replyToAddress != null && text(p.replyToAddress) !== (row.replyToAddress || "")) {
        const replyTo = text(p.replyToAddress)
        if (replyTo && !/^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(replyTo))
            denied("VALUE_INVALID", "The reply-to is one address")
        values.replyToAddress = replyTo || null
        changed.push("sender")
    }
    if (p.localeId != null) values.localeId = text(p.localeId).slice(0, 10) || null
    if (changed.length) revise(row, values, "Changed: " + Array.from(new Set(changed)).join(", "))
    else if (Object.keys(values).length) call("update#" + SEND, Object.assign({campaignSendId: row.campaignSendId}, values))
    return {campaignSendId: row.campaignSendId, approvalEnded: changed.length > 0 && row.statusId !== "CsDraft"}
}

// ===== store#SendContent =====
function storeContent(p) {
    const userScope = editScope()
    const row = sendOf(userScope, p.campaignSendId, true)
    requireEditable(row)
    requireRevision(row, p.expectedRevision)
    const base = contentOf(row)
    const content = {
        subject: p.subject != null ? text(p.subject) : base.subject,
        preheader: p.preheader != null ? text(p.preheader) : base.preheader,
        body: p.body != null ? String(p.body) : base.body,
        bodyText: p.bodyText != null ? String(p.bodyText) : base.bodyText,
        variables: p.variables != null ? templates.declaredVariables(p.variables) : base.variables
    }
    templates.checkContent(content)
    checkLinks(content.body)
    const same =
        content.subject === base.subject &&
        content.preheader === base.preheader &&
        content.body === base.body &&
        content.bodyText === base.bodyText &&
        JSON.stringify(content.variables) === JSON.stringify(base.variables)
    if (same) return {campaignSendId: row.campaignSendId, approvalEnded: false}
    const files = writeFiles(row.campaignSendId, "draft", content.body, content.bodyText)
    revise(
        row,
        {
            subject: content.subject || null,
            preheader: content.preheader || null,
            bodyLocation: files.bodyLocation,
            bodyTextLocation: files.bodyTextLocation,
            variablesJson: JSON.stringify(content.variables)
        },
        "Content changed"
    )
    return {campaignSendId: row.campaignSendId, approvalEnded: row.statusId !== "CsDraft"}
}

// ===== store#SendAssets =====
// A file the message attaches: one of the send's files (its RecordFiles) or of its campaign's (each one the caller sees through the
// send or the campaign), by location; anything else ASSET_UNAVAILABLE. Usage attachment only: a publicly retrievable inline file is
// not offered for staff files (USAGE_INVALID). action add (or change a file's label) or end (campaignSendContentId).
function storeAssets(p) {
    const userScope = editScope()
    const row = sendOf(userScope, p.campaignSendId, true)
    requireEditable(row)
    requireRevision(row, p.expectedRevision)
    const action = text(p.action) || "add"
    if (action === "end") {
        const asset = one(SEND_CONTENT, {campaignSendContentId: text(p.campaignSendContentId)})
        if (!asset || asset.campaignSendId !== row.campaignSendId || !asset.assetUsageEnumId || asset.thruDate != null)
            denied("RECORD_UNAVAILABLE", "That file is not in the message")
        call("update#" + SEND_CONTENT, {campaignSendContentId: asset.campaignSendContentId, thruDate: ec.user.nowTimestamp})
        revise(row, {}, "Attachment removed")
        return {campaignSendContentId: asset.campaignSendContentId}
    }
    if (action !== "add") denied("ACTION_INVALID", "Add or end an attachment")
    const usage = text(p.assetUsageEnumId) || "CsaAttachment"
    if (usage !== "CsaAttachment")
        denied("USAGE_INVALID", "A file goes with the message as an attachment: a staff file is never made publicly retrievable")
    const location = text(p.contentLocation)
    const ownFile = location
        ? Array.from(find(SEND_CONTENT, {campaignSendId: row.campaignSendId, contentLocation: location}).list())[0] || null
        : null
    const campaignFile = location
        ? Array.from(
              find("mantle.marketing.campaign.CampaignAsset", {
                  marketingCampaignId: row.marketingCampaignId,
                  contentLocation: location
              }).list()
          )[0] || null
        : null
    if (!ownFile && !campaignFile)
        denied("ASSET_UNAVAILABLE", "Choose a file of this send or of its campaign: another file is not yours to send")
    const assetLabel = text(p.assetLabel).slice(0, 255) || location.split("/").pop()
    let campaignSendContentId
    if (ownFile && ownFile.assetUsageEnumId == null) {
        campaignSendContentId = ownFile.campaignSendContentId
        call("update#" + SEND_CONTENT, {
            campaignSendContentId,
            assetUsageEnumId: usage,
            assetLabel,
            fromDate: ec.user.nowTimestamp,
            thruDate: null
        })
    } else
        campaignSendContentId = call("create#" + SEND_CONTENT, {
            campaignSendId: row.campaignSendId,
            contentTypeEnumId: ownFile?.contentTypeEnumId || "CscCreative",
            contentLocation: location,
            description: campaignFile?.description || ownFile?.description || null,
            assetUsageEnumId: usage,
            assetLabel,
            fromDate: ec.user.nowTimestamp
        }).campaignSendContentId
    revise(row, {}, "Attachment added")
    return {campaignSendContentId}
}
const assetRows = campaignSendId =>
    rows(SEND_CONTENT, {campaignSendId})
        .filter(asset => asset.assetUsageEnumId && asset.thruDate == null)
        .map(asset => ({
            campaignSendContentId: asset.campaignSendContentId,
            assetLabel:
                asset.assetLabel ||
                String(asset.contentLocation || "")
                    .split("/")
                    .pop(),
            usageText: enumText(asset.assetUsageEnumId),
            fromDateText: lib.dateText(asset.fromDate)
        }))

// ===== schedule#Send =====
function scheduleSend(p) {
    const userScope = editScope()
    const row = sendOf(userScope, p.campaignSendId, true)
    requireEditable(row)
    requireRevision(row, p.expectedRevision)
    const at = blank(p.scheduledDate) ? null : ms(p.scheduledDate)
    if (at != null && (!Number.isFinite(at) || at < nowMs())) denied("DATE_INVALID", "A send is scheduled for now or later")
    const timeZone = text(p.scheduleTimeZone) || null
    if (timeZone && timeZone.length > 60) denied("VALUE_INVALID", "Name a time zone")
    if ((ms(row.scheduledDate) ?? null) === at && (row.scheduleTimeZone || null) === timeZone)
        return {campaignSendId: row.campaignSendId, approvalEnded: false}
    revise(row, {scheduledDate: at == null ? null : new Date(at), scheduleTimeZone: timeZone}, "Schedule changed")
    return {campaignSendId: row.campaignSendId, approvalEnded: row.statusId !== "CsDraft"}
}

// ===== preview#Send =====
// The content (the draft, or the prepared one) rendered for a sample: a person of the topic for an audience reader (their own
// first and last name, nothing else), synthetic values otherwise; the findings (missing or unknown variables, an empty subject or
// body, no text alternative).
function previewSend(p) {
    const userScope = readScope()
    const row = sendOf(userScope, p.campaignSendId)
    const usePrepared = (p.prepared === true || p.prepared === "true" || p.prepared === "Y") && row.preparedBodyLocation
    const content = usePrepared ? preparedContent(row) : draftContent(row)
    let values = syntheticValues
    let sampleText = "Sample values"
    if (!blank(p.samplePartyId)) {
        if (!userScope.capabilities.audienceRead)
            denied(
                "PERMISSION_DENIED",
                "A real recipient's preview needs Marketing's audience permission; synthetic values are shown otherwise"
            )
        const member = Array.from(
            find("mantle.marketing.contact.ContactListParty", {contactListId: row.contactListId, partyId: text(p.samplePartyId)})
                .conditionDate("fromDate", "thruDate", ec.user.nowTimestamp)
                .list()
        )[0]
        if (!member || !segments.inScopeParties([text(p.samplePartyId)]).size)
            denied("RECORD_UNAVAILABLE", "That person is not on the send's topic")
        values = recipientValues(text(p.samplePartyId))
        sampleText = lib.partyNames([text(p.samplePartyId)])[text(p.samplePartyId)] || text(p.samplePartyId)
    }
    const rendered = render(content, values)
    const findings = []
    if (!rendered.subject) findings.push("The subject is empty")
    if (rendered.subject.length > 78) findings.push("The subject is longer than 78 characters: many mail apps cut it")
    if (!rendered.body.trim() && !rendered.bodyText.trim()) findings.push("The message has no body")
    if (!rendered.bodyText.trim()) findings.push("No text alternative: mail apps that show text only get none")
    for (const name of unknownRequired(content.variables))
        findings.push("${" + name + "} is required and is no recipient's value: give it a fallback or make it optional")
    for (const name of rendered.missing) findings.push("${" + name + "} is required and has no value or fallback here")
    return {
        renderedSubject: rendered.subject,
        renderedPreheader: rendered.preheader,
        safeBody: StringUtilities.cleanHtml(rendered.body),
        renderedText: rendered.bodyText,
        missingVariables: rendered.missing,
        findings,
        sampleText,
        prepared: !!usePrepared,
        recipientFields: Object.entries(recipientFields).map(([name, title]) => ({name, title}))
    }
}

// ===== test#Send and its ledger source =====
// The organization's test allowlist (MarketingPolicy.testAddresses), normalized.
function testAddressesOf(organizationPartyId) {
    const policy = approvals.policyOf(organizationPartyId)
    return String(policy?.testAddresses || "")
        .split(/[\s,;]+/)
        .map(address => suppressions.normalize("MdcEmail", address))
        .filter(Boolean)
}
function testSend(p) {
    const userScope = editScope()
    // the send read locked (P9, P8 review F203): two tests at once count the day's limit one after the other
    const row = sendOf(userScope, p.campaignSendId, true)
    if (["CsCancelled", "CsCompleted", "CsCompletedFailures"].includes(row.statusId))
        denied("STATUS_INVALID", "Send " + row.campaignSendId + " is " + statusText(row.statusId).toLowerCase())
    const toAddress = suppressions.normalize("MdcEmail", text(p.toAddress))
    if (!toAddress || !testAddressesOf(row.organizationPartyId).includes(toAddress))
        denied("TEST_ADDRESS_NOT_ALLOWED", "A test goes only to an address of the organization's test list (Campaign defaults)")
    if (!row.sendingProfileId) denied("PROFILE_REQUIRED", "Choose the send's sending profile first")
    profileFor(row.sendingProfileId, row.organizationPartyId)
    const content = contentOf(row)
    if (!content.subject || (!content.body.trim() && !content.bodyText.trim()))
        denied("CONTENT_REQUIRED", "Write the subject and the body first")
    const recipientPartyId = ec.user.userAccount?.partyId
    if (!recipientPartyId) denied("PARTY_REQUIRED", "A test is sent by a person")
    const dayAgo = new Date(nowMs() - 24 * 60 * 60 * 1000)
    const sentToday = find("mantle.party.MessageDelivery", {sourceEnumId: "MdsrcCampaignSendTest"})
        .condition("eventKey", "like", "CampaignSendTest:" + row.campaignSendId + ":%")
        .condition("createdDate", "greater-equals", dayAgo)
        .count()
    if (sentToday >= testDailyLimit) denied("TEST_LIMIT", "A send takes at most " + testDailyLimit + " tests a day")
    const note = text(p.note).slice(0, 255)
    const queued = call("mantle.party.MessageServices.queue#Delivery", {
        sourceEnumId: "MdsrcCampaignSendTest",
        eventKey:
            "CampaignSendTest:" +
            row.campaignSendId +
            ":" +
            nowMs() +
            ":" +
            ec.user.randomString(6).replace(/[^A-Za-z0-9]/g, "x"),
        recipientPartyId,
        channelEnumId: "MdcEmail",
        templateKey: testTemplateId,
        toAddress,
        organizationPartyId: row.organizationPartyId,
        sendingProfileId: row.sendingProfileId,
        transactional: false,
        bodyParameters: {campaignSendId: row.campaignSendId, sendRevision: Number(row.sendRevision || 1), note},
        sendNow: true
    })
    return {deliveryId: queued.deliveryId, stateEnumId: queued.stateEnumId, stateText: statusOfDelivery(queued.stateEnumId)}
}
const deliveryStateTexts = {
    MdsQueued: "Queued",
    MdsRetry: "Waiting to be tried again",
    MdsSent: "Sent",
    MdsFailed: "Failed",
    MdsUncertain: "Uncertain",
    MdsSuppressed: "Refused: the address is suppressed or the message could not be made"
}
const statusOfDelivery = stateEnumId => deliveryStateTexts[stateEnumId] || stateEnumId || "Queued"
// build#TestDelivery (the ledger's MdsrcCampaignSendTest): the send's content as it is now with synthetic values, the subject
// marked TEST and a TEST line on the body; suppressed when the send is gone or another organization's.
function buildTest(p) {
    const delivery = one("mantle.party.MessageDelivery", {deliveryId: text(p.deliveryId)})
    if (!delivery) return {suppress: "The delivery is gone"}
    const parameters = lib.json(delivery.parametersJson, {}) || {}
    const row = parameters.campaignSendId ? one(SEND, {campaignSendId: parameters.campaignSendId}) : null
    if (!row || row.organizationPartyId !== delivery.organizationPartyId) return {suppress: "The send is not available"}
    // the address still on the organization's test list at each attempt (P8 review): a test source never reaches anyone else
    if (!testAddressesOf(row.organizationPartyId).includes(suppressions.normalize("MdcEmail", delivery.toAddress)))
        return {suppress: "The address is no longer on the organization's test list"}
    const rendered = render(draftContent(row), syntheticValues)
    const note = text(parameters.note)
    const banner =
        '<p style="padding:8px;border:2px solid #b00;color:#b00;font-weight:bold">TEST: not sent to the audience' +
        (note ? ". " + WebUtilities.encodeHtml(note) : "") +
        "</p>"
    return {
        bodyParameters: {},
        subject: ("[TEST] " + rendered.subject).slice(0, 250),
        body: banner + (rendered.body || ""),
        bodyText: "TEST: not sent to the audience" + (note ? ". " + note : "") + "\n\n" + (rendered.bodyText || "")
    }
}
// The send's tests, newest first, with each one's state (the ledger's), for the composer.
function testRows(campaignSendId) {
    return Array.from(
        find("mantle.party.MessageDelivery", {sourceEnumId: "MdsrcCampaignSendTest"})
            .condition("eventKey", "like", "CampaignSendTest:" + campaignSendId + ":%")
            .orderBy("-createdDate")
            .limit(10)
            .list()
    ).map(delivery => ({
        deliveryId: delivery.deliveryId,
        toAddress: delivery.toAddress,
        createdDateText: lib.dateText(delivery.createdDate),
        stateText: statusOfDelivery(delivery.stateEnumId)
    }))
}

// ===== prepare#Send =====
function prepareSend(p) {
    const userScope = editScope()
    const row = sendOf(userScope, p.campaignSendId, true)
    if (row.statusId !== "CsDraft")
        denied(
            "STATUS_INVALID",
            "Send " + row.campaignSendId + " is " + statusText(row.statusId).toLowerCase() + ": prepare a draft"
        )
    requireRevision(row, p.expectedRevision)
    const org = row.organizationPartyId
    const content = contentOf(row)
    if (!content.subject) denied("SUBJECT_REQUIRED", "Give the subject before preparing")
    if (!content.body.trim() && !content.bodyText.trim()) denied("BODY_REQUIRED", "Write the body before preparing")
    templates.checkContent(content)
    checkLinks(content.body)
    const unknown = unknownRequired(content.variables)
    if (unknown.length)
        denied(
            "VARIABLE_UNKNOWN",
            "${" + unknown.join("}, ${") + "} is required and no recipient gives it: give it a fallback or make it optional"
        )
    const topic = topicFor(row.contactListId, org)
    const audience = audienceOf(row)
    const lists = audience.listIds.map(id => listFor(id, org))
    const segmentRows = audience.segmentIds.map(id => segmentFor(userScope, id, org))
    const excludeLists = audience.excludeListIds.map(id => listFor(id, org))
    const excludeSegments = audience.excludeSegmentIds.map(id => segmentFor(userScope, id, org))
    const asOf = ec.user.nowTimestamp
    const evaluated = eligibility.evaluateSend({
        userScope,
        topic,
        purposeEnumId: row.purposeEnumId,
        lists,
        segments: segmentRows,
        excludeLists,
        excludeSegments,
        asOf,
        pageSize: p.pageSize
    })
    if (!blank(p.resultDigest) && text(p.resultDigest) !== evaluated.resultDigest)
        denied(
            "PREVIEW_STALE",
            "The audience changed since the preview: it now has " +
                evaluated.rows.length +
                " eligible recipients; review it again"
        )
    const policy = approvals.policyOf(org)
    if (policy?.audienceLimit != null && evaluated.rows.length > Number(policy.audienceLimit))
        denied(
            "AUDIENCE_LIMIT",
            "The send has " +
                evaluated.rows.length +
                " eligible recipients, over the organization's limit of " +
                policy.audienceLimit
        )
    // the earlier preparation's recipients replaced (none was handed off: a send is released only once approved, P9)
    find(RECIPIENT, {campaignSendId: row.campaignSendId, statusId: "CrsSelected"}).updateAll({statusId: "CrsReplaced"})
    const revision = Number(row.sendRevision || 1)
    // P9 (P8 review F205): the recipients made in one bulk create, not a service call each
    ec.entity.createBulk(
        evaluated.rows.map(recipient =>
            ec.entity
                .makeValue(RECIPIENT)
                .setAll({
                    campaignSendId: row.campaignSendId,
                    preparedRevision: revision,
                    partyId: recipient.partyId,
                    contactMechId: recipient.contactMechId,
                    destinationKey: recipient.destinationKey,
                    channelEnumId: row.channelEnumId,
                    selectedDate: asOf,
                    tracked: recipient.tracked ? "Y" : "N",
                    executionKey: ec.user.randomString(20).replace(/[^A-Za-z0-9]/g, "x"),
                    statusId: "CrsSelected"
                })
                .setSequencedIdPrimary()
        )
    )
    // the content kept as a resource of its own: what a later read returns, whatever changes after
    const files = writeFiles(row.campaignSendId, "prepared-r" + revision, content.body, content.bodyText)
    // P9 (P8 review F200): the attachments copied with it, so a campaign's file its editor changes after approval never reaches a
    // message
    const preparedAttachments = copyAttachments(row.campaignSendId, files.bodyLocation)
    const request = {
        organizationPartyId: org,
        topicListId: topic.contactListId,
        listIds: audience.listIds.slice().sort(),
        segmentIds: audience.segmentIds.slice().sort(),
        excludeListIds: audience.excludeListIds.slice().sort(),
        excludeSegmentIds: audience.excludeSegmentIds.slice().sort(),
        channelEnumId: row.channelEnumId,
        purposeEnumId: evaluated.purposeEnumId,
        asOf: ms(asOf)
    }
    call("update#" + SEND, {
        campaignSendId: row.campaignSendId,
        preparedRevision: revision,
        preparedDate: asOf,
        preparedByUserId: ec.user.userId,
        contentDate: asOf,
        marketingPolicyId: policy?.marketingPolicyId || null,
        policyFromDate: policy?.fromDate || null,
        preparedSubject: content.subject,
        preparedPreheader: content.preheader || null,
        preparedBodyLocation: files.bodyLocation,
        preparedTextLocation: files.bodyTextLocation,
        preparedVariablesJson: JSON.stringify(content.variables),
        preparedAttachmentsJson: JSON.stringify(preparedAttachments),
        previewKey: lib.hash(request),
        resultDigest: evaluated.resultDigest,
        eligibleCount: evaluated.rows.length,
        untrackedCount: evaluated.untrackedEligible,
        bucketCountsJson: JSON.stringify(evaluated.counts)
    })
    return {
        campaignSendId: row.campaignSendId,
        preparedRevision: revision,
        eligibleCount: evaluated.rows.length,
        untrackedCount: evaluated.untrackedEligible,
        matchedCount: evaluated.matchedCount,
        bucketCounts: evaluated.counts,
        resultDigest: evaluated.resultDigest,
        pages: evaluated.pages
    }
}

// ===== Marketing P9: the attachments as prepared (P8 review F200) =====
// Each attached file of the send (or its campaign) copied beside the prepared body: [{location, fileName, contentType}]. A file that is
// gone refuses the preparation (ATTACHMENT_UNAVAILABLE), as does a total over attachmentLimitBytes (ATTACHMENT_TOO_LARGE).
const attachmentLimitBytes = 10 * 1024 * 1024
function copyAttachments(campaignSendId, preparedBodyLocation) {
    const folder = preparedBodyLocation.slice(0, preparedBodyLocation.lastIndexOf("/") + 1) + "files/"
    const copies = []
    let total = 0
    for (const asset of rows(SEND_CONTENT, {campaignSendId}).filter(asset => asset.assetUsageEnumId && asset.thruDate == null)) {
        const source = ec.resource.getLocationReference(asset.contentLocation)
        if (!asset.contentLocation || !source || !source.getExists())
            denied("ATTACHMENT_UNAVAILABLE", "The attached file " + (asset.assetLabel || asset.contentLocation) + " is gone")
        total += Number(source.getSize() || 0)
        if (total > attachmentLimitBytes)
            denied("ATTACHMENT_TOO_LARGE", "The attachments are over " + attachmentLimitBytes / (1024 * 1024) + " MB together")
        const fileName =
            String(asset.assetLabel || source.getFileName() || "attachment")
                .replace(/[\\/\r\n]+/g, "-")
                .slice(0, 120) || "attachment"
        const location =
            folder + asset.campaignSendContentId + "-" + String(source.getFileName() || "file").replace(/[\\/]+/g, "-")
        ec.resource.getLocationReference(location).copyFrom(source)
        copies.push({
            location,
            fileName,
            contentType: ec.resource.getContentType(String(source.getFileName() || "")) || "application/octet-stream"
        })
    }
    return copies
}

// ===== get#Send =====
function getSend(p) {
    const userScope = readScope()
    const row = sendOf(userScope, p.campaignSendId)
    const caps = userScope.capabilities
    const audience = audienceOf(row)
    const listName = id => one(LIST, {contactListId: id})?.contactListName || id
    const segmentName = id => {
        const segment = one("mantle.marketing.segment.MarketSegment", {marketSegmentId: id})
        return segment ? segments.segmentLabel(segment) : id
    }
    const kind = approvals.targetKinds.send
    const revision = kind.revision(row)
    const pending = approvals.pendingRequest(kind, row.campaignSendId, revision)
    const authors = kind.authors(row).concat(pending?.decidedByUserId ? [pending.decidedByUserId] : [])
    const policy = approvals.policyOf(row.organizationPartyId)
    const own = authors.includes(ec.user.userId)
    const problems = sendProblems(row)
    const editable = editableStatuses.includes(row.statusId) && !!caps.sendEdit
    const profile = row.sendingProfileId ? one(PROFILE, {sendingProfileId: row.sendingProfileId}) : null
    const readiness = profile ? profiles.readinessOf(profile) : null
    const content = contentOf(row)
    const prepared = preparedCurrent(row)
    const counts = prepared ? lib.json(row.bucketCountsJson, {}) || {} : {}
    // P9: the dispatch's counts and the control's actions for the caller (MarketingDispatch.js)
    const control = dispatch().controlOf(userScope, row)
    return {
        delivery: control.delivery,
        control: control.capabilities,
        send: sendRow(row, {
            replyToAddress: row.replyToAddress || "",
            purposeText: enumText(row.purposeEnumId),
            messageTemplateId: row.messageTemplateId || null,
            templateName: row.messageTemplateId
                ? one(TEMPLATE, {messageTemplateId: row.messageTemplateId})?.templateName || row.messageTemplateId
                : "",
            scheduleTimeZone: row.scheduleTimeZone || "",
            profileReady: readiness ? readiness.ready : false,
            profileReasons: readiness ? readiness.reasons : [],
            preparedRevision: row.preparedRevision == null ? null : Number(row.preparedRevision),
            preparedDateText: row.preparedDate ? lib.dateText(row.preparedDate) : "",
            preparedByName: row.preparedByUserId
                ? lib.partyNames([userParty(row.preparedByUserId)])[userParty(row.preparedByUserId)] || ""
                : "",
            contentDateText: row.contentDate ? lib.dateText(row.contentDate) : "",
            policyFromDateText: row.policyFromDate ? lib.dateText(row.policyFromDate) : "",
            untrackedCount: prepared ? Number(row.untrackedCount || 0) : null,
            previewKey: prepared ? row.previewKey : null,
            resultDigest: prepared ? row.resultDigest : null,
            preparedStale: row.preparedRevision != null && !prepared
        }),
        content: {
            subject: content.subject,
            preheader: content.preheader,
            body: content.body,
            bodyText: content.bodyText,
            variables: content.variables,
            variablesText: content.variables
                .map(v => [v.name, v.label, v.fallback, v.required ? "required" : ""].join(" | ").replace(/[ |]+$/, ""))
                .join("\n")
        },
        prepared: row.preparedBodyLocation
            ? {
                  subject: row.preparedSubject || "",
                  preheader: row.preparedPreheader || "",
                  body: templates.readText(row.preparedBodyLocation),
                  bodyText: templates.readText(row.preparedTextLocation),
                  revision: row.preparedRevision == null ? null : Number(row.preparedRevision),
                  current: prepared
              }
            : null,
        audience: {
            topicName: listName(row.contactListId),
            lists: audience.listIds.map(id => ({id, name: listName(id)})),
            segments: audience.segmentIds.map(id => ({id, name: segmentName(id)})),
            excludeLists: audience.excludeListIds.map(id => ({id, name: listName(id)})),
            excludeSegments: audience.excludeSegmentIds.map(id => ({id, name: segmentName(id)})),
            listIds: audience.listIds,
            segmentIds: audience.segmentIds,
            excludeListIds: audience.excludeListIds,
            excludeSegmentIds: audience.excludeSegmentIds,
            bucketList: prepared
                ? eligibility.buckets.map(entry => Object.assign({count: Number(counts[entry.bucket] || 0)}, entry))
                : []
        },
        assets: assetRows(row.campaignSendId),
        tests: caps.sendEdit ? testRows(row.campaignSendId) : [],
        testAddresses: caps.sendEdit ? testAddressesOf(row.organizationPartyId) : [],
        decisions: approvals.decisionRows(kind, row.campaignSendId),
        approvalProblems: problems,
        awaitingApproval: !!pending,
        capabilities: {
            canEdit: editable,
            canPrepare: editable && row.statusId === "CsDraft",
            canTest: !!caps.sendEdit && !!row.sendingProfileId,
            canRequestApproval: editable && row.statusId === "CsDraft" && !pending && !problems.length,
            canDecide:
                !!caps.approve && !!pending && (!own || approvals.selfApprovalAdmits(policy, "send", kind.recipientCount(row))),
            canDuplicate: !!caps.sendEdit,
            canPreviewRecipient: !!caps.audienceRead
        }
    }
}

// ===== check#SendAccess (Chatter and RecordFiles) =====
function access(p) {
    if (!ec.user.userId) return {recordVisible: false, canEdit: false}
    const row = one(SEND, {campaignSendId: text(p.campaignSendId)})
    if (!row) return {recordVisible: false, canEdit: false}
    const userScope = marketingAccess.scope()
    const visible = !!userScope.capabilities.anyRead && marketingAccess.covers(userScope, row.organizationPartyId)
    return {
        recordVisible: visible,
        // a draft's files only (P8 review): a file attached to a send awaiting approval or approved is never removed or replaced
        // through its files (RecordFiles), which would change the message without ending its approval; the composer's attachments
        // (store#SendAssets) end it
        canEdit: visible && !!userScope.capabilities.sendEdit && row.statusId === "CsDraft",
        organizationPartyId: visible ? row.organizationPartyId : null
    }
}
// create#CampaignSendContent's check: the send's editor while its content may change.
function assetAccess(p) {
    const userScope = editScope()
    const row = sendOf(userScope, p.campaignSendId)
    requireEditable(row)
    return {campaignSendId: row.campaignSendId}
}

const operations = {
    find: findSends,
    create: createSend,
    duplicate: duplicateSend,
    store: storeSend,
    storeContent,
    storeAssets,
    schedule: scheduleSend,
    preview: previewSend,
    test: testSend,
    buildTest,
    prepare: prepareSend,
    get: getSend,
    access,
    assetAccess
}
;({
    sendKind,
    recipientFields,
    testDailyLimit,
    // P9: what the dispatch (MarketingDispatch.js) shares
    forDispatch: {
        readScope,
        sendOf,
        requireRevision,
        sendProblems,
        preparedContent,
        render,
        recipientValues,
        label,
        statusText,
        statusColors,
        preparedCurrent,
        approvedCampaignStatuses
    },
    execute: (op, parameters) => {
        if (!Object.hasOwn(operations, op)) throw new Error("Unknown campaign send operation " + op)
        return operations[op](parameters || {})
    }
})
