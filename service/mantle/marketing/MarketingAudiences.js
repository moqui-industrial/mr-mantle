// Marketing's audiences (mantle.marketing.AudienceServices, L; IronStone Marketing design §4 Lists, ListDetail, MemberDetail, §10
// Leads' bulk action, §14.1, §14.2; impl-marketing P3): the lists of an organization with their subscription policy and template
// bindings, their members, the one evidenced path to membership (request#Subscriptions), a member's withdrawal and the single-use
// reservation. The data stays Mantle's native ContactList, ContactListParty, ContactListEmail and PartyConsent, with the dated
// ContactListPolicy and the SubscriptionRequest record beside them.
//
// - Scope: a list is a Marketing list when it is not a mailbox and its owner is an organization of the caller's scope
//   (MarketingAccess.js); any other, missing or unowned answers as missing (RECORD_UNAVAILABLE). Reading lists and members needs
//   MARKETING_AUDIENCE_VIEW; a list or policy write and a request MARKETING_AUDIENCE_EDIT; an acceptance by the evidence path and a
//   withdrawal MARKETING_CONSENT_EDIT too (PERMISSION_DENIED). An archived list takes no request (LIST_ARCHIVED).
// - Revisions: a list write names the list's lastUpdatedStamp, a policy write the current policy's (expectedRevision; none
//   REVISION_REQUIRED, another STALE_REVISION naming the current one).
// - Consent is never implied (impl-marketing §2): a request is pending until the recipient confirms (P7) or is accepted by the
//   audited evidence path; it never clears a withdrawal or a suppression. Evidence that predates the party's latest withdrawal of
//   the list (or of the purpose, for every organization or the list's) is refused (WITHDRAWN), so a retry of an old request never
//   regrants; a withdrawal of the purpose is never undone by staff (an acceptance is refused CONSENT_WITHDRAWN: only the person's
//   own confirmation renews it). A suppressed address may be requested and accepted, and stays suppressed: the request says so.
// - Each item of a batch is its own: a refusal is that item's result, recorded as a refused request, and the others go on.
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const marketingAccess = ec.resource.script("component://mr-mantle/service/mantle/marketing/MarketingAccess.js")
const suppressions = ec.resource.script("component://mr-mantle/service/mantle/party/MessageSuppressions.js")
const {find, one, rows, denied, call} = lib

const LIST = "mantle.marketing.contact.ContactList"
const CLP = "mantle.marketing.contact.ContactListParty"
const POLICY = "mantle.marketing.contact.ContactListPolicy"
const LIST_EMAIL = "mantle.marketing.contact.ContactListEmail"
const REQUEST = "mantle.marketing.contact.SubscriptionRequest"
const CONSENT = "mantle.party.PartyConsent"
const listTypes = ["MARKETING", "NEWSLETTER", "ANNOUNCEMENT"]
const subscribed = ["CLPT_ACCEPTED", "CLPT_IN_USE"]
const statusTexts = {
    CLPT_PENDING: "Pending",
    CLPT_ACCEPTED: "Subscribed",
    CLPT_REJECTED: "Rejected",
    CLPT_IN_USE: "In use",
    CLPT_INVALID: "Invalid",
    CLPT_UNSUBS_PENDING: "Unsubscribe pending",
    CLPT_UNSUBSCRIBED: "Unsubscribed"
}
const statusColors = {
    CLPT_PENDING: "warning",
    CLPT_ACCEPTED: "positive",
    CLPT_IN_USE: "positive",
    CLPT_UNSUBS_PENDING: "warning",
    CLPT_UNSUBSCRIBED: "grey-7",
    CLPT_REJECTED: "grey-7",
    CLPT_INVALID: "negative"
}
const channelTexts = {CmtEmailAddress: "Email", CmtTelecomNumber: "SMS"}
const requestKinds = {staff: "SrkStaff", lead: "SrkSalesLead", account: "SrkSalesAccount"}
const memberStatusFilters = {
    current: ["CLPT_PENDING", "CLPT_ACCEPTED", "CLPT_IN_USE", "CLPT_UNSUBS_PENDING"],
    subscribed,
    pending: ["CLPT_PENDING"],
    unsubscribed: ["CLPT_UNSUBSCRIBED", "CLPT_UNSUBS_PENDING"]
}
const batchCap = 500

const text = value => (value == null ? "" : String(value).trim())
const blank = value => value == null || value === ""
const nowMs = () => lib.ms(ec.user.nowTimestamp)
const enumText = enumId => (enumId ? one("moqui.basic.Enumeration", {enumId})?.description || enumId : "")
const organizationName = partyId => (partyId ? one("mantle.party.Organization", {partyId})?.organizationName || partyId : "")
const listOf = value =>
    value == null
        ? []
        : (typeof value === "string" ? value.split(",") : Array.from(value)).map(item => text(item)).filter(Boolean)
const purposeOf = (list, policy) =>
    policy?.purposeEnumId || (list.contactMechTypeEnumId === "CmtTelecomNumber" ? "PcpSms" : "PcpMarketingEmail")
const idOrder = (a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0)
const newestFirst = (a, b) =>
    (lib.ms(b.consentDate) ?? 0) - (lib.ms(a.consentDate) ?? 0) || idOrder(String(b.partyConsentId), String(a.partyConsentId))

// ===== scope and records =====
function audienceScope(capability) {
    const userScope = marketingAccess.scope()
    if (!userScope.capabilities.audienceRead) denied("PERMISSION_DENIED", "Marketing audiences are not open to you")
    if (capability) marketingAccess.requireCapability(userScope, capability)
    return userScope
}
// A Marketing list of the scope, else RECORD_UNAVAILABLE (missing, a mailbox, another organization's or unowned alike).
function listOfScope(userScope, contactListId, lock = false) {
    const id = text(contactListId)
    let query = id ? find(LIST, {contactListId: id}) : null
    if (query && lock) query = query.forUpdate(true)
    const row = query ? query.one() : null
    if (!row || row.contactListTypeEnumId === "MAILBOX" || !marketingAccess.covers(userScope, row.ownerPartyId))
        denied("RECORD_UNAVAILABLE", "List " + id + " is not available")
    return row
}
const archived = list => list.archivedDate != null && lib.ms(list.archivedDate) <= nowMs()
function requireOpen(list) {
    if (archived(list)) denied("LIST_ARCHIVED", "List " + (list.contactListName || list.contactListId) + " is archived")
}
function requireRevision(row, expectedRevision, label) {
    if (blank(expectedRevision)) denied("REVISION_REQUIRED", "Name the revision of " + label + " you read")
    if (lib.ms(expectedRevision) !== lib.ms(row.lastUpdatedStamp))
        denied("STALE_REVISION", label + " changed since it was read; its revision is now " + lib.ms(row.lastUpdatedStamp))
}
// The list's policy in effect, or null.
function currentPolicy(contactListId) {
    return Array.from(find(POLICY, {contactListId}).orderBy("-fromDate").list()).find(row => lib.active(row)) || null
}
// A campaign a list may name: of the list's organization, else RECORD_UNAVAILABLE.
function campaignFor(userScope, marketingCampaignId, organizationPartyId) {
    const id = text(marketingCampaignId)
    if (!id) return null
    const campaign = one("mantle.marketing.campaign.MarketingCampaign", {marketingCampaignId: id})
    if (
        !campaign ||
        campaign.organizationPartyId !== organizationPartyId ||
        !marketingAccess.covers(userScope, organizationPartyId)
    )
        denied("RECORD_UNAVAILABLE", "Campaign " + id + " is not available")
    return id
}
function listTypeOf(value) {
    const type = text(value) || "MARKETING"
    if (!listTypes.includes(type)) denied("LIST_TYPE_INVALID", "A Marketing list is a marketing, newsletter or announcement list")
    return type
}
function channelOf(value) {
    const channel = text(value) || "CmtEmailAddress"
    if (!channelTexts[channel]) denied("CHANNEL_INVALID", "A list is of email addresses or phone numbers")
    return channel
}
const memberCount = (contactListId, statuses) =>
    find(CLP)
        .condition("contactListId", contactListId)
        .condition("statusId", "in", statuses)
        .conditionDate("fromDate", "thruDate", ec.user.nowTimestamp)
        .count()
function listRow(list, policy) {
    return {
        contactListId: list.contactListId,
        contactListName: list.contactListName || list.contactListId,
        description: list.description || "",
        comments: list.comments || "",
        contactListTypeEnumId: list.contactListTypeEnumId,
        typeText: enumText(list.contactListTypeEnumId),
        contactMechTypeEnumId: list.contactMechTypeEnumId || "CmtEmailAddress",
        channelText: channelTexts[list.contactMechTypeEnumId || "CmtEmailAddress"] || "",
        ownerPartyId: list.ownerPartyId,
        organizationName: organizationName(list.ownerPartyId),
        marketingCampaignId: list.marketingCampaignId || null,
        campaignName: list.marketingCampaignId
            ? one("mantle.marketing.campaign.MarketingCampaign", {marketingCampaignId: list.marketingCampaignId})?.campaignName ||
              list.marketingCampaignId
            : "",
        singleUse: list.singleUse === "Y" ? "Y" : "N",
        archived: archived(list),
        archivedText: list.archivedDate ? lib.dateText(list.archivedDate) : "",
        stateText: archived(list) ? "Archived" : "Active",
        stateColor: archived(list) ? "grey-7" : "positive",
        publicOffer: policy?.publicOffer === "Y" ? "Y" : "N",
        confirmationRequired: policy?.confirmationRequired === "N" ? "N" : "Y",
        purposeEnumId: purposeOf(list, policy),
        purposeText: enumText(purposeOf(list, policy)),
        reservedBySendId: list.reservedBySendId || null,
        reservationText: list.consumedDate
            ? "Used by send " + list.reservedBySendId
            : list.reservedBySendId
              ? "Held by send " + list.reservedBySendId
              : "",
        revision: lib.ms(list.lastUpdatedStamp)
    }
}

// ===== find#Lists =====
function findLists(p) {
    const userScope = audienceScope()
    const factory = ec.entity.conditionFactory
    let ids = marketingAccess.organizationIds(userScope)
    if (text(p.organizationPartyId)) {
        marketingAccess.requireOrganization(userScope, p.organizationPartyId)
        ids = [text(p.organizationPartyId)]
    }
    if (!ids.length) return lib.pageList([], p, "contactListList")
    let query = find(LIST)
        .condition("ownerPartyId", "in", ids)
        .condition("contactListTypeEnumId", "in", listTypes)
        .orderBy("^contactListName")
    if (text(p.text))
        query = query.condition(
            factory.makeCondition(
                ["contactListId", "contactListName", "description"].map(field =>
                    factory.makeCondition(field, "like", "%" + text(p.text) + "%").ignoreCase()
                ),
                "or"
            )
        )
    if (text(p.contactListTypeEnumId)) query = query.condition("contactListTypeEnumId", text(p.contactListTypeEnumId))
    if (text(p.contactMechTypeEnumId)) query = query.condition("contactMechTypeEnumId", text(p.contactMechTypeEnumId))
    if (text(p.marketingCampaignId)) query = query.condition("marketingCampaignId", text(p.marketingCampaignId))
    const state = text(p.archived) || "N"
    if (state === "N") query = query.condition(factory.makeCondition("archivedDate", "greater", ec.user.nowTimestamp, true))
    else if (state === "Y") query = query.condition("archivedDate", "less-equals", ec.user.nowTimestamp)
    const count = query.count()
    const paged = lib.page(query, p, "contactListList", count, {noLimitCap: 1000})
    paged.contactListList = paged.rows.map(list =>
        Object.assign(listRow(list, currentPolicy(list.contactListId)), {
            subscribedCount: memberCount(list.contactListId, subscribed),
            pendingCount: memberCount(list.contactListId, ["CLPT_PENDING"])
        })
    )
    return paged
}

// ===== create#List, store#List, archive#List =====
function createList(p) {
    const userScope = audienceScope("audienceEdit")
    const organizationPartyId = marketingAccess.requireOrganization(userScope, text(p.organizationPartyId))
    const name = text(p.contactListName)
    if (!name) denied("NAME_REQUIRED", "Give the list a name")
    const made = call("mantle.marketing.ContactListServices.create#ContactList", {
        contactListTypeEnumId: listTypeOf(p.contactListTypeEnumId),
        contactListName: name,
        description: text(p.description) || null,
        ownerPartyId: organizationPartyId,
        contactMechTypeEnumId: channelOf(p.contactMechTypeEnumId),
        marketingCampaignId: campaignFor(userScope, p.marketingCampaignId, organizationPartyId)
    })
    if (p.singleUse === "Y" || p.singleUse === true) call("update#" + LIST, {contactListId: made.contactListId, singleUse: "Y"})
    return {contactListId: made.contactListId}
}
function storeList(p) {
    const userScope = audienceScope("audienceEdit")
    const list = listOfScope(userScope, p.contactListId, true)
    requireOpen(list)
    requireRevision(list, p.expectedRevision, "list " + list.contactListId)
    const fields = {contactListId: list.contactListId}
    if (Object.hasOwn(p, "contactListName")) {
        const name = text(p.contactListName)
        if (!name) denied("NAME_REQUIRED", "Give the list a name")
        fields.contactListName = name
    }
    if (Object.hasOwn(p, "description")) fields.description = text(p.description) || null
    if (Object.hasOwn(p, "comments")) fields.comments = text(p.comments) || null
    if (!blank(p.contactListTypeEnumId)) fields.contactListTypeEnumId = listTypeOf(p.contactListTypeEnumId)
    if (Object.hasOwn(p, "marketingCampaignId"))
        fields.marketingCampaignId = campaignFor(userScope, p.marketingCampaignId, list.ownerPartyId)
    if (!blank(p.singleUse)) {
        const singleUse = p.singleUse === "Y" || p.singleUse === true ? "Y" : "N"
        if (singleUse !== (list.singleUse === "Y" ? "Y" : "N") && list.reservedBySendId)
            denied("LIST_RESERVED", "A list held by a send keeps its single use")
        fields.singleUse = singleUse
    }
    call("update#" + LIST, fields)
    return {contactListId: list.contactListId}
}
function archiveList(p) {
    const userScope = audienceScope("audienceEdit")
    const list = listOfScope(userScope, p.contactListId, true)
    requireRevision(list, p.expectedRevision, "list " + list.contactListId)
    if (archived(list)) return {contactListId: list.contactListId, archived: false}
    if (list.reservedBySendId && !list.consumedDate)
        denied("LIST_RESERVED", "A list held by a send is archived once the send ends")
    call("update#" + LIST, {
        contactListId: list.contactListId,
        archivedDate: ec.user.nowTimestamp,
        comments: text(p.reason)
            ? [list.comments, "Archived: " + text(p.reason)].filter(Boolean).join("\n")
            : list.comments || null
    })
    return {contactListId: list.contactListId, archived: true}
}

// ===== get#List, store#SubscriptionPolicy, store#ContactListEmail =====
function getList(p) {
    const userScope = audienceScope()
    const list = listOfScope(userScope, p.contactListId)
    const policy = currentPolicy(list.contactListId)
    const caps = userScope.capabilities
    const counts = {}
    for (const [key, statuses] of Object.entries({
        subscribed,
        pending: ["CLPT_PENDING"],
        unsubscribePending: ["CLPT_UNSUBS_PENDING"],
        unsubscribed: ["CLPT_UNSUBSCRIBED"]
    }))
        counts[key] = memberCount(list.contactListId, statuses)
    const policyHistory = Array.from(find(POLICY, {contactListId: list.contactListId}).orderBy("-fromDate").limit(50).list()).map(
        row => ({
            fromDate: row.fromDate,
            fromText: lib.dateText(row.fromDate),
            thruText: lib.dateText(row.thruDate),
            current: lib.active(row),
            publicOfferText: row.publicOffer === "Y" ? "Offered" : "Not offered",
            confirmationText: row.confirmationRequired === "N" ? "Accepted with evidence" : "Confirmation required",
            purposeText: enumText(purposeOf(list, row)),
            evidenceText: row.evidenceText || "",
            changedBy: row.changedByUserId
                ? one("moqui.security.UserAccount", {userId: row.changedByUserId})?.userFullName || row.changedByUserId
                : ""
        })
    )
    const templates = Array.from(
        find(LIST_EMAIL, {contactListId: list.contactListId}).orderBy("-fromDate").limit(100).list()
    ).map(row => ({
        emailTypeEnumId: row.emailTypeEnumId,
        emailTypeText: enumText(row.emailTypeEnumId),
        emailTemplateId: row.emailTemplateId || null,
        templateText: row.emailTemplateId
            ? one("moqui.basic.email.EmailTemplate", {emailTemplateId: row.emailTemplateId})?.description || row.emailTemplateId
            : "",
        wikiPageCategoryId: row.wikiPageCategoryId || null,
        fromDate: row.fromDate,
        fromDateMs: lib.ms(row.fromDate),
        fromText: lib.dateText(row.fromDate),
        thruText: lib.dateText(row.thruDate),
        current: lib.active(row)
    }))
    const editable = !!caps.audienceEdit && !archived(list)
    return {
        list: listRow(list, policy),
        policy: policy
            ? {
                  publicOffer: policy.publicOffer === "Y" ? "Y" : "N",
                  confirmationRequired: policy.confirmationRequired === "N" ? "N" : "Y",
                  purposeEnumId: purposeOf(list, policy),
                  evidenceText: policy.evidenceText || "",
                  confirmEmailTemplateId: policy.confirmEmailTemplateId || null,
                  noticeEmailTemplateId: policy.noticeEmailTemplateId || null,
                  revision: lib.ms(policy.lastUpdatedStamp)
              }
            : null,
        policyHistory,
        templates,
        counts,
        capabilities: {
            canEdit: editable,
            canArchive: !!caps.audienceEdit && !archived(list),
            canRequest: editable,
            canAccept: editable && !!caps.consentEdit,
            canWithdraw: !!caps.consentEdit
        }
    }
}
function storeSubscriptionPolicy(p) {
    const userScope = audienceScope("audienceEdit")
    const list = listOfScope(userScope, p.contactListId, true)
    requireOpen(list)
    const policy = currentPolicy(list.contactListId)
    if (policy) requireRevision(policy, p.expectedRevision, "the policy of list " + list.contactListId)
    const purposeEnumId = text(p.purposeEnumId) || null
    if (purposeEnumId && !one("moqui.basic.Enumeration", {enumId: purposeEnumId, enumTypeId: "PartyConsentPurpose"}))
        denied("PURPOSE_INVALID", "Unknown consent purpose " + purposeEnumId)
    for (const templateId of [p.confirmEmailTemplateId, p.noticeEmailTemplateId])
        if (text(templateId) && !one("moqui.basic.email.EmailTemplate", {emailTemplateId: text(templateId)}))
            denied("TEMPLATE_INVALID", "Unknown email template " + text(templateId))
    const now = ec.user.nowTimestamp
    if (policy) call("update#" + POLICY, {contactListId: list.contactListId, fromDate: policy.fromDate, thruDate: now})
    call("create#" + POLICY, {
        contactListId: list.contactListId,
        fromDate: now,
        publicOffer: p.publicOffer === "Y" || p.publicOffer === true ? "Y" : "N",
        confirmationRequired: p.confirmationRequired === "N" || p.confirmationRequired === false ? "N" : "Y",
        purposeEnumId,
        evidenceText: text(p.evidenceText) || null,
        confirmEmailTemplateId: text(p.confirmEmailTemplateId) || null,
        noticeEmailTemplateId: text(p.noticeEmailTemplateId) || null,
        changedByUserId: ec.user.userId || null
    })
    return {contactListId: list.contactListId, fromDate: now}
}
// A template binding (ContactListEmail): add ends the current one of its type and starts the new; end ends one (fromDate).
function storeContactListEmail(p) {
    const userScope = audienceScope("audienceEdit")
    const list = listOfScope(userScope, p.contactListId, true)
    requireOpen(list)
    const emailTypeEnumId = text(p.emailTypeEnumId)
    if (!one("moqui.basic.Enumeration", {enumId: emailTypeEnumId, enumTypeId: "ContactListEmailType"}))
        denied("TYPE_INVALID", "Choose the kind of message")
    const now = ec.user.nowTimestamp
    const current = rows(LIST_EMAIL, {contactListId: list.contactListId, emailTypeEnumId}).filter(row => lib.active(row))
    if ((text(p.action) || "add") === "end") {
        const ended = current.find(row => lib.ms(row.fromDate) === lib.ms(p.fromDate))
        if (!ended) denied("RECORD_UNAVAILABLE", "That template binding is not in effect")
        call("update#" + LIST_EMAIL, {
            contactListId: list.contactListId,
            emailTypeEnumId,
            fromDate: ended.fromDate,
            thruDate: now
        })
        return {ended: true}
    }
    const emailTemplateId = text(p.emailTemplateId) || null
    if (!emailTemplateId && !text(p.wikiPageCategoryId)) denied("TEMPLATE_REQUIRED", "Choose the template")
    if (emailTemplateId && !one("moqui.basic.email.EmailTemplate", {emailTemplateId}))
        denied("TEMPLATE_INVALID", "Unknown email template " + emailTemplateId)
    for (const row of current)
        call("update#" + LIST_EMAIL, {contactListId: list.contactListId, emailTypeEnumId, fromDate: row.fromDate, thruDate: now})
    call("create#" + LIST_EMAIL, {
        contactListId: list.contactListId,
        emailTypeEnumId,
        fromDate: now,
        emailTemplateId,
        wikiPageCategoryId: text(p.wikiPageCategoryId) || null
    })
    return {ended: false}
}

// ===== find#Members, get#Member =====
function partyName(partyId) {
    return lib.partyNames([partyId])[partyId] || partyId
}
function addressText(contactMechId) {
    if (!contactMechId) return ""
    const mech = one("mantle.party.contact.ContactMech", {contactMechId})
    if (!mech) return ""
    if (mech.contactMechTypeEnumId === "CmtTelecomNumber") {
        const number = one("mantle.party.contact.TelecomNumber", {contactMechId})
        return number
            ? [number.countryCode ? "+" + number.countryCode : null, number.areaCode, number.contactNumber]
                  .filter(Boolean)
                  .join(" ")
            : ""
    }
    return mech.infoString || ""
}
function memberRow(row, list, names) {
    const address = addressText(row.preferredContactMechId)
    return {
        contactListId: row.contactListId,
        partyId: row.partyId,
        partyName: names[row.partyId] || row.partyId,
        fromDate: row.fromDate,
        fromText: lib.dateText(row.fromDate),
        thruText: lib.dateText(row.thruDate),
        statusId: row.statusId,
        statusText: statusTexts[row.statusId] || row.statusId,
        statusColor: statusColors[row.statusId] || "grey-7",
        // the list shows addresses masked; MemberDetail shows an audience reader the whole address
        addressText: address ? suppressions.mask(address) : "",
        revision: Number(row.revision || 0)
    }
}
function findMembers(p) {
    const userScope = audienceScope()
    const list = listOfScope(userScope, p.contactListId)
    const filter = text(p.memberStatus) || "current"
    let query = find(CLP, {contactListId: list.contactListId}).orderBy("-fromDate")
    if (filter !== "history") query = query.conditionDate("fromDate", "thruDate", ec.user.nowTimestamp)
    const statuses = memberStatusFilters[filter] || (statusTexts[filter] ? [filter] : null)
    if (statuses) query = query.condition("statusId", "in", statuses)
    if (text(p.text)) {
        const factory = ec.entity.conditionFactory
        const matches = Array.from(
            find("mantle.party.PartyDetail")
                .condition(
                    factory.makeCondition(
                        ["partyId", "firstName", "lastName", "organizationName"].map(field =>
                            factory.makeCondition(field, "like", "%" + text(p.text) + "%").ignoreCase()
                        ),
                        "or"
                    )
                )
                .selectField("partyId")
                .limit(500)
                .list()
        ).map(row => row.partyId)
        if (!matches.length) return lib.pageList([], p, "memberList")
        query = query.condition("partyId", "in", matches)
    }
    const count = query.count()
    const paged = lib.page(query, p, "memberList", count)
    const names = lib.partyNames(paged.rows.map(row => row.partyId))
    paged.memberList = paged.rows.map(row => memberRow(row, list, names))
    return paged
}
function requestRow(row) {
    return {
        subscriptionRequestId: row.subscriptionRequestId,
        requestedText: lib.dateText(row.requestedDate),
        kindText: enumText(row.requestKindEnumId),
        statusText: enumText(row.statusEnumId),
        statusColor: row.statusEnumId === "SrsAccepted" ? "positive" : row.statusEnumId === "SrsPending" ? "warning" : "grey-7",
        reasonCode: row.reasonCode || "",
        sourceText: enumText(row.sourceEnumId),
        evidenceDateText: lib.dateText(row.evidenceDate),
        evidenceText: row.evidenceText || "",
        requestedBy: row.requestedByUserId
            ? one("moqui.security.UserAccount", {userId: row.requestedByUserId})?.userFullName || row.requestedByUserId
            : ""
    }
}
function getMember(p) {
    const userScope = audienceScope()
    const list = listOfScope(userScope, p.contactListId)
    const partyId = text(p.partyId)
    const memberRows = Array.from(find(CLP, {contactListId: list.contactListId, partyId}).orderBy("-fromDate").list())
    if (!memberRows.length)
        denied("RECORD_UNAVAILABLE", "Member " + partyId + " of list " + list.contactListId + " is not available")
    const names = lib.partyNames([partyId])
    const current = memberRows.find(row => lib.active(row)) || memberRows[0]
    const address = addressText(current.preferredContactMechId)
    const blocked = address ? suppressions.suppressedOf("MdcEmail", [address], list.ownerPartyId) : {suppressed: [], reasons: {}}
    const history = call("mantle.party.ConsentServices.get#PartyConsentHistory", {
        partyId,
        organizationPartyIds: [list.ownerPartyId],
        pageNoLimit: true
    })
    const caps = userScope.capabilities
    const isCurrent = lib.active(current)
    return {
        member: Object.assign(memberRow(current, list, names), {
            addressText: address,
            current: isCurrent,
            suppressed: blocked.suppressed.length > 0,
            suppressionText: blocked.suppressed.length ? enumText(Object.values(blocked.reasons)[0]) : ""
        }),
        list: listRow(list, currentPolicy(list.contactListId)),
        rows: memberRows.map(row => memberRow(row, list, names)),
        requests: Array.from(
            find(REQUEST, {contactListId: list.contactListId, partyId}).orderBy("-requestedDate").limit(50).list()
        ).map(requestRow),
        consentHistory: Array.from(history.historyList || []).filter(
            row => !row.contactListId || row.contactListId === list.contactListId
        ),
        capabilities: {
            canConfirm:
                !!(caps.audienceEdit && caps.consentEdit) && isCurrent && current.statusId === "CLPT_PENDING" && !archived(list),
            canWithdraw: !!caps.consentEdit && isCurrent && current.statusId !== "CLPT_UNSUBSCRIBED",
            canRequest: !!caps.audienceEdit && !archived(list)
        }
    }
}

// ===== request#Subscriptions =====
// The party a request may name: a party that exists, is not merged or disabled and is not another user's personal contact.
function requestableParty(partyId) {
    const party = partyId ? one("mantle.party.Party", {partyId}) : null
    if (!party || party.disabled === "Y" || party.mergedToPartyId) return null
    if (party.privateOwnerUserId && party.privateOwnerUserId !== ec.user.userId) return null
    return party
}
// The address of the list's channel a membership sends to: the one named when it is the party's, else the primary, else the first.
function destinationOf(partyId, channel, contactMechId) {
    const infos = Array.from(
        find("mantle.party.contact.PartyContactMechInfo")
            .condition("partyId", partyId)
            .condition("contactMechTypeEnumId", channel)
            .conditionDate("fromDate", "thruDate", ec.user.nowTimestamp)
            .orderBy("fromDate")
            .list()
    ).filter(info => info.infoString || channel === "CmtTelecomNumber")
    if (contactMechId) return infos.find(info => info.contactMechId === contactMechId) || null
    return (
        infos.find(info => ["EmailPrimary", "PhoneMobile", "PhonePrimary"].includes(info.contactMechPurposeId)) ||
        infos[0] ||
        null
    )
}
// The contacts a Sales record names, under the caller's Sales read (Mantle's SalesAccess.js): a lead's current contacts; an
// account's contacts, or the person an individual account is; each contact one the caller sees in Sales (visibleParty). A record the caller does not see is RECORD_UNAVAILABLE.
function salesContacts(kind, recordId) {
    const salesAccess = ec.resource.script("component://mr-mantle/service/mantle/sales/SalesAccess.js")
    const salesScope = salesAccess.scope()
    if (kind === "lead") {
        // a lead list's row key is the id with its revision (id@revision)
        const salesOpportunityId = recordId.split("@")[0]
        salesAccess.requireOpportunity(salesScope, salesOpportunityId)
        return Array.from(
            find("mantle.sales.opportunity.SalesOpportunityParty")
                .condition("salesOpportunityId", salesOpportunityId)
                .condition("roleTypeId", "Contact")
                .conditionDate("fromDate", "thruDate", ec.user.nowTimestamp)
                .list()
        )
            .map(row => row.partyId)
            .filter((partyId, index, all) => all.indexOf(partyId) === index && !!salesAccess.visibleParty(salesScope, partyId))
    }
    const account = salesAccess.requireAccount(salesScope, recordId)
    if (account.party.partyTypeEnumId === "PtyPerson") return [recordId]
    return Array.from(
        find("mantle.party.PartyRelationship")
            .condition("toPartyId", recordId)
            .condition("relationshipTypeEnumId", "PrtContact")
            .conditionDate("fromDate", "thruDate", ec.user.nowTimestamp)
            .list()
    )
        .map(row => row.fromPartyId)
        .filter((partyId, index, all) => all.indexOf(partyId) === index && !!salesAccess.visibleParty(salesScope, partyId))
}
// One request, decided and recorded: {partyId, outcome (pending, accepted, existing, refused), reasonCode, suppressed}.
function fileOne(list, policy, request, partyId) {
    const party = requestableParty(partyId)
    if (!party) return {partyId, outcome: "refused", reasonCode: "RECORD_UNAVAILABLE"}
    const channel = list.contactMechTypeEnumId || "CmtEmailAddress"
    const purposeEnumId = purposeOf(list, policy)
    const base = {
        contactListId: list.contactListId,
        partyId,
        organizationPartyId: list.ownerPartyId,
        purposeEnumId,
        requestKindEnumId: request.requestKindEnumId,
        sourceEnumId: request.sourceEnumId,
        evidenceDate: request.evidenceDate,
        evidenceText: request.evidenceText,
        sourceRecordId: request.sourceRecordId || null,
        requestedDate: ec.user.nowTimestamp,
        requestedByUserId: ec.user.userId || null
    }
    const record = (statusEnumId, reasonCode, extra = {}) =>
        call(
            "create#" + REQUEST,
            Object.assign({}, base, {statusEnumId, reasonCode: reasonCode || null, decidedDate: ec.user.nowTimestamp}, extra)
        ).subscriptionRequestId
    const destination = destinationOf(partyId, channel, request.contactMechId)
    if (!destination) {
        record("SrsRefused", "MISSING_DESTINATION")
        return {partyId, outcome: "refused", reasonCode: "MISSING_DESTINATION"}
    }
    base.contactMechId = destination.contactMechId
    // the party's membership rows and consent, read locked through the membership
    const memberRows = Array.from(
        find(CLP, {contactListId: list.contactListId, partyId})
            .conditionDate("fromDate", "thruDate", ec.user.nowTimestamp)
            .orderBy("-fromDate")
            .forUpdate(true)
            .list()
    )
    const latest = memberRows[0] || null
    const consents = rows(CONSENT, {partyId}).sort(newestFirst)
    const listConsent = consents.find(row => row.contactListId === list.contactListId) || null
    const purposeRows = consents.filter(
        row =>
            !row.contactListId &&
            row.purposeEnumId === purposeEnumId &&
            (!row.contactMechId || row.contactMechId === destination.contactMechId)
    )
    const globalState = purposeRows.find(row => !row.organizationPartyId) || null
    const scopedState = purposeRows.find(row => row.organizationPartyId === list.ownerPartyId) || null
    const evidenceMs = lib.ms(request.evidenceDate)
    const blocked = suppressions.suppressedOf(
        channel === "CmtEmailAddress" ? "MdcEmail" : "MdcSms",
        [destination.infoString],
        list.ownerPartyId
    )
    const suppressed = blocked.suppressed.length > 0
    if (latest && subscribed.includes(latest.statusId)) {
        record("SrsAccepted", "ALREADY_MEMBER")
        return {partyId, outcome: "existing", reasonCode: "ALREADY_MEMBER", suppressed}
    }
    // a withdrawal of the list later than the evidence: a retry of an old request never regrants
    const listWithdrawnMs =
        listConsent?.statusId === "PconWithdrawn"
            ? lib.ms(listConsent.consentDate)
            : latest && ["CLPT_UNSUBSCRIBED", "CLPT_UNSUBS_PENDING"].includes(latest.statusId)
              ? lib.ms(latest.lastUpdatedStamp)
              : null
    const purposeWithdrawn = [globalState, scopedState].filter(row => row?.statusId === "PconWithdrawn")
    const purposeWithdrawnMs = purposeWithdrawn.length ? Math.max(...purposeWithdrawn.map(row => lib.ms(row.consentDate))) : null
    if (
        (listWithdrawnMs != null && evidenceMs <= listWithdrawnMs) ||
        (purposeWithdrawnMs != null && evidenceMs <= purposeWithdrawnMs)
    ) {
        record("SrsRefused", "WITHDRAWN")
        return {partyId, outcome: "refused", reasonCode: "WITHDRAWN", suppressed}
    }
    // the purpose withdrawn (for every organization or the list's) is renewed by the person alone
    if (request.accept && purposeWithdrawnMs != null) {
        record("SrsRefused", "CONSENT_WITHDRAWN")
        return {partyId, outcome: "refused", reasonCode: "CONSENT_WITHDRAWN", suppressed}
    }
    if (latest && latest.statusId === "CLPT_PENDING" && !request.accept) {
        record("SrsPending", "ALREADY_PENDING")
        return {partyId, outcome: "existing", reasonCode: "ALREADY_PENDING", suppressed}
    }
    const target = request.accept ? "CLPT_ACCEPTED" : "CLPT_PENDING"
    // the membership: the latest current row moved to the target, else a new row (one that cannot move is ended first)
    const movable = {
        CLPT_PENDING: ["CLPT_ACCEPTED"],
        CLPT_UNSUBSCRIBED: ["CLPT_PENDING", "CLPT_ACCEPTED"],
        CLPT_REJECTED: ["CLPT_PENDING", "CLPT_ACCEPTED"]
    }
    if (latest && (movable[latest.statusId] || []).includes(target)) {
        call("update#" + CLP, {
            contactListId: list.contactListId,
            partyId,
            fromDate: latest.fromDate,
            statusId: target,
            statusId_changeReason:
                "Subscription request: " + (request.accept ? "accepted with evidence" : "pending confirmation"),
            preferredContactMechId: destination.contactMechId,
            revision: Number(latest.revision || 0) + 1
        })
    } else {
        for (const row of memberRows)
            call("update#" + CLP, {
                contactListId: list.contactListId,
                partyId,
                fromDate: row.fromDate,
                thruDate: ec.user.nowTimestamp
            })
        call("create#" + CLP, {
            contactListId: list.contactListId,
            partyId,
            fromDate: ec.user.nowTimestamp,
            statusId: target,
            preferredContactMechId: destination.contactMechId,
            revision: 1
        })
    }
    let partyConsentId = null
    if (request.accept) {
        partyConsentId = call("mantle.party.ConsentServices.store#PartyConsent", {
            partyId,
            contactMechId: destination.contactMechId,
            contactListId: list.contactListId,
            purposeEnumId,
            statusId: "PconGranted",
            sourceEnumId: request.sourceEnumId,
            evidenceText: request.evidenceText + " (evidence of " + lib.dateText(request.evidenceDate) + ")",
            updateSolicitation: false
        }).partyConsentId
    }
    record(request.accept ? "SrsAccepted" : "SrsPending", null, {partyConsentId})
    return {partyId, outcome: request.accept ? "accepted" : "pending", reasonCode: null, suppressed}
}
// One item in a transaction of its own: its result, or its failure named (RECORD_UNAVAILABLE and the like), the others going on.
function fileApart(list, policy, request, partyId) {
    ec.message.pushErrors()
    try {
        const out =
            ec.service
                .sync()
                .name("mantle.marketing.AudienceServices.file#SubscriptionRequest")
                .parameters({contactListId: list.contactListId, partyId, request})
                .disableAuthz()
                .requireNewTransaction(true)
                .call() || {}
        if (ec.message.hasError()) throw new Error(ec.message.getErrorsString())
        return out.result || {partyId, outcome: "refused", reasonCode: "FAILED"}
    } catch (error) {
        const reasonCode = lib.reasonCode(error) || "FAILED"
        if (reasonCode === "FAILED")
            ec.logger.error(
                "Subscription request of party " + partyId + " to list " + list.contactListId + " failed: " + error.message
            )
        return {partyId, outcome: "refused", reasonCode}
    } finally {
        ec.message.clearErrors()
        ec.message.popErrors()
    }
}
function fileRequest(p) {
    // internal (file#SubscriptionRequest): the caller has checked the list and the request
    const list = one(LIST, {contactListId: p.contactListId})
    return {result: fileOne(list, currentPolicy(list.contactListId), p.request, p.partyId)}
}
// The evidence of a request, as request#Subscriptions and the import (MarketingAudienceTransfers.js) check it: its text, its source
// (a PartyConsentSource) and its date, now when empty and never in the future.
function evidenceTextOf(value) {
    const evidenceText = text(value)
    if (!evidenceText) denied("EVIDENCE_REQUIRED", "Give the evidence of the request: what the person did or said")
    return evidenceText
}
function sourceOf(value, fallback) {
    const sourceEnumId = text(value) || fallback
    if (!one("moqui.basic.Enumeration", {enumId: sourceEnumId, enumTypeId: "PartyConsentSource"}))
        denied("SOURCE_INVALID", "Unknown evidence source " + sourceEnumId)
    return sourceEnumId
}
function evidenceDateOf(value) {
    const evidenceMs = blank(value) ? nowMs() : lib.ms(value)
    if (evidenceMs == null || !Number.isFinite(evidenceMs) || evidenceMs > nowMs() + 60000)
        denied("EVIDENCE_DATE_INVALID", "The evidence's date is a date not in the future")
    return new Date(evidenceMs)
}
function requestSubscriptions(p) {
    const userScope = audienceScope("audienceEdit")
    const accept = p.accept === true || p.accept === "true" || p.accept === "Y"
    if (accept) marketingAccess.requireCapability(userScope, "consentEdit")
    const list = listOfScope(userScope, p.contactListId)
    requireOpen(list)
    const evidenceText = evidenceTextOf(p.evidenceText)
    const sourceEnumId = sourceOf(p.sourceEnumId, "PcsStaff")
    const evidenceDate = evidenceDateOf(p.evidenceDate)
    // the items: parties named, and the contacts of the Sales leads and accounts named (each record's failure its own)
    const items = []
    for (const partyId of listOf(p.partyIdList)) items.push({kind: "staff", recordId: partyId, partyIds: [partyId]})
    for (const [kind, ids] of [
        ["lead", listOf(p.salesOpportunityIdList)],
        ["account", listOf(p.salesAccountPartyIdList)]
    ])
        for (const recordId of ids) {
            try {
                const partyIds = salesContacts(kind, recordId)
                items.push({kind, recordId, partyIds, reasonCode: partyIds.length ? null : "MISSING_CONTACT"})
            } catch (error) {
                items.push({
                    kind,
                    recordId,
                    partyIds: [],
                    reasonCode: lib.reasonCode(error) === "RECORD_UNAVAILABLE" ? "RECORD_UNAVAILABLE" : "FAILED"
                })
                if (lib.reasonCode(error) !== "RECORD_UNAVAILABLE")
                    ec.logger.error("Sales " + kind + " " + recordId + ": " + error.message)
            }
        }
    if (items.reduce((total, item) => total + Math.max(1, item.partyIds.length), 0) > batchCap)
        denied("BATCH_TOO_LARGE", "File at most " + batchCap + " requests at a time")
    const policy = currentPolicy(list.contactListId)
    const results = []
    const seen = new Set()
    for (const item of items) {
        const recordId = item.kind === "lead" ? item.recordId.split("@")[0] : item.recordId
        if (item.reasonCode) {
            results.push({recordId, kind: item.kind, partyId: null, outcome: "refused", reasonCode: item.reasonCode})
            continue
        }
        for (const partyId of item.partyIds) {
            if (seen.has(partyId)) continue
            seen.add(partyId)
            const request = {
                requestKindEnumId: requestKinds[item.kind],
                sourceEnumId,
                evidenceDate,
                evidenceText,
                sourceRecordId: item.kind === "staff" ? null : recordId,
                contactMechId: item.kind === "staff" ? text(p.contactMechId) || null : null,
                accept
            }
            results.push(Object.assign({recordId, kind: item.kind}, fileApart(list, policy, request, partyId)))
        }
    }
    const names = lib.partyNames(results.map(result => result.partyId).filter(Boolean))
    for (const result of results) result.partyName = result.partyId ? names[result.partyId] || result.partyId : ""
    const count = outcome => results.filter(result => result.outcome === outcome).length
    return {
        results,
        pendingCount: count("pending"),
        acceptedCount: count("accepted"),
        existingCount: count("existing"),
        refusedCount: count("refused"),
        suppressedCount: results.filter(result => result.suppressed).length
    }
}
// withdraw#Subscription: a member's withdrawal by a consent editor, at once (the request's evidence on the withdrawal).
function withdrawSubscription(p) {
    const userScope = audienceScope("consentEdit")
    const list = listOfScope(userScope, p.contactListId)
    const partyId = text(p.partyId)
    if (!requestableParty(partyId)) denied("RECORD_UNAVAILABLE", "Party " + partyId + " is not available")
    if (!text(p.evidenceText)) denied("EVIDENCE_REQUIRED", "Give where the withdrawal came from")
    const out = call("mantle.party.ConsentServices.set#ContactListPartySubscription", {
        contactListId: list.contactListId,
        partyId,
        subscribe: false,
        sourceEnumId: text(p.sourceEnumId) || "PcsStaff",
        evidenceText: text(p.evidenceText),
        comments: text(p.reasonText) || null,
        confirmed: true
    })
    return {statusId: out.statusId, changed: !!out.changed}
}

// ===== the single-use reservation (internal; the send's release is P9) =====
function reserveSingleUse(p) {
    const list = find(LIST, {contactListId: text(p.contactListId)})
        .forUpdate(true)
        .one()
    if (!list) denied("RECORD_UNAVAILABLE", "List " + text(p.contactListId) + " is not available")
    const sendId = text(p.sendId)
    if (!sendId) throw new Error("A reservation names its send")
    if (list.singleUse !== "Y") return {reserved: false, reasonCode: "NOT_SINGLE_USE"}
    if (list.consumedDate) return {reserved: false, reasonCode: "LIST_USED"}
    if (list.reservedBySendId && list.reservedBySendId !== sendId) return {reserved: false, reasonCode: "LIST_RESERVED"}
    if (list.reservedBySendId === sendId) return {reserved: true, reasonCode: null}
    call("update#" + LIST, {
        contactListId: list.contactListId,
        reservedBySendId: sendId,
        reservedBySendId_changeReason: "Reserved by send " + sendId,
        reservedDate: ec.user.nowTimestamp
    })
    return {reserved: true, reasonCode: null}
}
// release: a send that ends before any hand-off frees the list; one that completes (consume) uses it.
function releaseSingleUse(p) {
    const list = find(LIST, {contactListId: text(p.contactListId)})
        .forUpdate(true)
        .one()
    if (!list) denied("RECORD_UNAVAILABLE", "List " + text(p.contactListId) + " is not available")
    if (!list.reservedBySendId || list.reservedBySendId !== text(p.sendId) || list.consumedDate)
        return {released: false, reasonCode: "NOT_RESERVED"}
    if (p.consume === true || p.consume === "true") {
        call("update#" + LIST, {contactListId: list.contactListId, consumedDate: ec.user.nowTimestamp})
        return {released: true, consumed: true, reasonCode: null}
    }
    call("update#" + LIST, {
        contactListId: list.contactListId,
        reservedBySendId: null,
        reservedBySendId_changeReason: "Released by send " + text(p.sendId) + " before any hand-off",
        reservedDate: null
    })
    return {released: true, consumed: false, reasonCode: null}
}

// ===== Home's audience card (MarketingWorkspace.js) =====
// The requests filed in the last seven days for lists of the organizations: a count, no person.
function recentRequestCount(organizationPartyIds) {
    if (!organizationPartyIds.length) return 0
    return find(REQUEST)
        .condition("organizationPartyId", "in", organizationPartyIds)
        .condition("requestedDate", "greater-equals", new Date(nowMs() - 7 * 24 * 60 * 60 * 1000))
        .count()
}

const operations = {
    findLists,
    createList,
    storeList,
    archiveList,
    getList,
    storeSubscriptionPolicy,
    storeContactListEmail,
    findMembers,
    getMember,
    requestSubscriptions,
    fileRequest,
    withdrawSubscription,
    reserveSingleUse,
    releaseSingleUse
}
;({
    statusTexts,
    recentRequestCount,
    // P4: what the audience import and the list merge (MarketingAudienceTransfers.js, MarketingListMerge.js) share with
    // request#Subscriptions: the scope, the list, its policy and purpose, the evidence checks, the request's filing and the masks
    audience: {
        audienceScope,
        listOfScope,
        requireOpen,
        currentPolicy,
        purposeOf,
        evidenceTextOf,
        sourceOf,
        evidenceDateOf,
        requestableParty,
        fileApart,
        addressText,
        statusColors,
        archived
    },
    execute: (op, parameters) => {
        if (!Object.hasOwn(operations, op)) throw new Error("Unknown audience operation " + op)
        return operations[op](parameters || {})
    }
})
