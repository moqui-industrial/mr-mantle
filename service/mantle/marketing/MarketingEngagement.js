// A party's engagement with the caller's organizations (mantle.marketing.MarketingWorkspaceServices get#Engagement, W; IronStone
// Marketing design §10 Customer360 and ContactDetail, MKT-REPORT; impl-marketing P19): Customer360's Engagement tab in Marketing's
// context. Each source answers only with its own permission and is left out without it, never answered as zero (omitted names
// it); each reads only the records of the organizations the caller's Marketing scope covers (narrowed to one when asked), so no
// other organization's engagement shows; a source that fails is named in failedSources and the others still answer.
//
// The sources and what each asks:
// - campaigns: the campaigns the party was sent, registered for or answered a form of (MARKETING_VIEW);
// - memberships: the party's list memberships and explicit segment memberships (MARKETING_AUDIENCE_VIEW);
// - sends: the sends the party was a recipient of, with the ledger delivery's state (MARKETING_AUDIENCE_VIEW);
// - engagement: the opens and clicks observed on those sends, only while the party allows tracking (PcpTracking) in the send's
//   organization now (P15: a recipient is named only while they allow tracking); a refusal removes the observations, not the fact
//   that a send was attempted (MARKETING_AUDIENCE_VIEW);
// - submissions: the party's answers to Marketing's surveys, lead forms and registration questions, which publication and when,
//   no answer text (MARKETING_AUDIENCE_VIEW or MARKETING_REPORT_VIEW, the form purposes' view permissions);
// - registrations: the party's event places, as attendee or buyer, with whether they were checked in, and no order or payment
//   (MARKETING_EVENT_MANAGE);
// - promotionUse: the store promotions and codes used on the party's placed orders, with the discount and no order (Commerce's
//   COMMERCE_VIEW and its store scope, within the Marketing organizations);
// - consent: the party's current consent by purpose and address for one organization (get#PartyConsentState) and its list
//   statuses (MARKETING_AUDIENCE_VIEW).
// A list or segment membership alone never grants a finance or Sales record: no order, invoice, payment or opportunity is read.
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const marketingAccess = ec.resource.script("component://mr-mantle/service/mantle/marketing/MarketingAccess.js")
const tracking = () => ec.resource.script("component://mr-mantle/service/mantle/marketing/MarketingTracking.js")
const stores = () => ec.resource.script("component://mr-mantle/service/mantle/product/StoreAdmin.js")
const {find, one, rows, denied, dateText} = lib

const rowLimit = 50
const consentOrganizationLimit = 5
const marketingPurposes = ["FppSurvey", "FppLead", "FppRegistration"]
const placedStatuses = ["OrderPlaced", "OrderProcessing", "OrderApproved", "OrderSent", "OrderCompleted", "OrderHold"]
const withdrawnMemberships = ["CLPT_UNSUBSCRIBED", "CLPT_UNSUBS_PENDING", "CLPT_REJECTED", "CLPT_INVALID"]

// ===== values =====
const text = value => (value == null ? "" : String(value))
const statusText = statusId => (statusId ? one("moqui.basic.StatusItem", {statusId})?.description || statusId : "")
const enumText = enumId => (enumId ? one("moqui.basic.Enumeration", {enumId})?.description || enumId : "")
const organizationName = partyId => one("mantle.party.Organization", {partyId})?.organizationName || partyId || ""
const unique = list => Array.from(new Set(list.filter(Boolean)))
const rowsIn = (entity, field, values, conditions = {}) =>
    values.length ? Array.from(find(entity, conditions).condition(field, "in", values).list()) : []
const newest = field => (a, b) => (lib.ms(b[field]) ?? 0) - (lib.ms(a[field]) ?? 0)

// ===== the sources =====
// Each: its permission check (from the Marketing capabilities, or Commerce's for promotion use) and its read, given the context
// {partyId, organizationPartyIds, covers}.
const sources = [
    {key: "campaigns", title: "Campaigns", allowed: caps => caps.view, read: campaigns},
    {key: "memberships", title: "Lists and segments", allowed: caps => caps.audienceView, read: memberships},
    {key: "sends", title: "Sends", allowed: caps => caps.audienceView, read: sends},
    {key: "engagement", title: "Opens and clicks", allowed: caps => caps.audienceView, read: engagement},
    {key: "submissions", title: "Form answers", allowed: caps => caps.audienceView || caps.reportView, read: submissions},
    {key: "registrations", title: "Event registrations", allowed: caps => caps.eventManage, read: registrations},
    {key: "promotionUse", title: "Promotion use", allowed: () => lib.access.has("COMMERCE_VIEW"), read: promotionUse},
    {key: "consent", title: "Consent", allowed: caps => caps.audienceView, read: consent}
]

// The party's recipients of the context's sends (not replaced by a later preparation), newest first, with their sends.
function recipientsOf(context) {
    if (context.recipients) return context.recipients
    const recipients = rows("mantle.marketing.campaign.CampaignRecipient", {partyId: context.partyId}).filter(
        row => row.statusId !== "CrsReplaced"
    )
    const sendsById = Object.fromEntries(
        rowsIn("mantle.marketing.campaign.CampaignSend", "campaignSendId", unique(recipients.map(row => row.campaignSendId))).map(
            row => [row.campaignSendId, row]
        )
    )
    context.recipients = recipients
        .filter(row => sendsById[row.campaignSendId] && context.covers(sendsById[row.campaignSendId].organizationPartyId))
        .map(row => ({recipient: row, send: sendsById[row.campaignSendId]}))
        .sort((a, b) => (lib.ms(b.recipient.selectedDate) ?? 0) - (lib.ms(a.recipient.selectedDate) ?? 0))
    return context.recipients
}
// The party's places on offers of the context's organizations, as attendee or buyer, newest first.
function registrationsOf(context) {
    if (context.places) return context.places
    const byId = new Map()
    for (const field of ["attendeePartyId", "buyerPartyId"])
        for (const row of rows("mantle.work.registration.EventRegistration", {[field]: context.partyId}))
            byId.set(row.registrationId, row)
    const places = Array.from(byId.values())
    const policies = Object.fromEntries(
        rowsIn(
            "mantle.work.registration.EventRegistrationPolicy",
            "registrationPolicyId",
            unique(places.map(row => row.registrationPolicyId))
        ).map(row => [row.registrationPolicyId, row])
    )
    context.places = places
        .filter(
            row => policies[row.registrationPolicyId] && context.covers(policies[row.registrationPolicyId].organizationPartyId)
        )
        .map(row => ({registration: row, policy: policies[row.registrationPolicyId]}))
        .sort((a, b) => (lib.ms(b.registration.createdDate) ?? 0) - (lib.ms(a.registration.createdDate) ?? 0))
    return context.places
}
// The party's submissions to Marketing's publications of the context's organizations, newest first.
function submissionsOf(context) {
    if (context.submissions) return context.submissions
    const found = rows("mantle.party.FormSubmission", {partyId: context.partyId})
    const publications = Object.fromEntries(
        rowsIn("mantle.party.FormPublication", "publicationId", unique(found.map(row => row.publicationId)), {}).map(row => [
            row.publicationId,
            row
        ])
    )
    context.submissions = found
        .filter(row => {
            const publication = publications[row.publicationId]
            return (
                publication &&
                marketingPurposes.includes(publication.purposeEnumId) &&
                context.covers(publication.organizationPartyId)
            )
        })
        .map(row => ({submission: row, publication: publications[row.publicationId]}))
        .sort((a, b) => (lib.ms(b.submission.submittedDate) ?? 0) - (lib.ms(a.submission.submittedDate) ?? 0))
    return context.submissions
}

function campaigns(context) {
    const how = new Map()
    const add = (marketingCampaignId, what) => {
        if (!marketingCampaignId) return
        if (!how.has(marketingCampaignId)) how.set(marketingCampaignId, new Set())
        how.get(marketingCampaignId).add(what)
    }
    for (const {send} of recipientsOf(context)) add(send.marketingCampaignId, "sent")
    for (const {registration} of registrationsOf(context)) add(registration.marketingCampaignId, "registered")
    for (const {publication} of submissionsOf(context))
        if (publication.contextEntityName === "mantle.marketing.campaign.MarketingCampaign")
            add(publication.contextId, "answered a form")
    const found = rowsIn("mantle.marketing.campaign.MarketingCampaign", "marketingCampaignId", Array.from(how.keys())).filter(
        row => context.covers(row.organizationPartyId)
    )
    return found
        .map(row => ({
            marketingCampaignId: row.marketingCampaignId,
            campaignName: row.campaignName || row.marketingCampaignId,
            organizationName: organizationName(row.organizationPartyId),
            statusText: statusText(row.statusId),
            howText: Array.from(how.get(row.marketingCampaignId)).join(", ")
        }))
        .sort((a, b) => a.campaignName.localeCompare(b.campaignName))
        .slice(0, rowLimit)
}
function memberships(context) {
    const lists = Object.fromEntries(
        rowsIn(
            "mantle.marketing.contact.ContactList",
            "contactListId",
            unique(rows("mantle.marketing.contact.ContactListParty", {partyId: context.partyId}).map(row => row.contactListId))
        )
            .filter(list => list.contactListTypeEnumId !== "MAILBOX" && context.covers(list.ownerPartyId))
            .map(list => [list.contactListId, list])
    )
    // each list's current row, else its latest
    const latest = new Map()
    for (const row of rows("mantle.marketing.contact.ContactListParty", {partyId: context.partyId}).sort(newest("fromDate"))) {
        if (!lists[row.contactListId] || row.roleTypeId) continue
        const seen = latest.get(row.contactListId)
        if (!seen || (!lib.active(seen) && lib.active(row))) latest.set(row.contactListId, row)
    }
    const listRows = Array.from(latest.values()).map(row => ({
        kind: "list",
        kindText: "List",
        recordId: row.contactListId,
        name: lists[row.contactListId].contactListName || row.contactListId,
        organizationName: organizationName(lists[row.contactListId].ownerPartyId),
        statusText: statusText(row.statusId),
        withdrawn: withdrawnMemberships.includes(row.statusId),
        current: lib.active(row),
        sinceText: dateText(row.fromDate)
    }))
    const segmentRows = rows("mantle.marketing.segment.MarketSegmentParty", {partyId: context.partyId}).filter(row =>
        lib.active(row)
    )
    const segments = Object.fromEntries(
        rowsIn("mantle.marketing.segment.MarketSegment", "marketSegmentId", unique(segmentRows.map(row => row.marketSegmentId)))
            .filter(segment => context.covers(segment.ownerPartyId))
            .map(segment => [segment.marketSegmentId, segment])
    )
    const memberRows = segmentRows
        .filter(row => segments[row.marketSegmentId])
        .map(row => ({
            kind: "segment",
            kindText: "Segment",
            recordId: row.marketSegmentId,
            name: segments[row.marketSegmentId].segmentName || segments[row.marketSegmentId].description || row.marketSegmentId,
            organizationName: organizationName(segments[row.marketSegmentId].ownerPartyId),
            statusText: row.memberKindEnumId === "MspExclude" ? "Excluded" : "Included",
            withdrawn: row.memberKindEnumId === "MspExclude",
            current: true,
            sinceText: dateText(row.fromDate)
        }))
    return listRows.concat(memberRows).slice(0, rowLimit)
}
function sends(context) {
    const found = recipientsOf(context).slice(0, rowLimit)
    const deliveries = Object.fromEntries(
        rowsIn("mantle.party.MessageDelivery", "deliveryId", unique(found.map(({recipient}) => recipient.messageDeliveryId))).map(
            row => [row.deliveryId, row]
        )
    )
    return found.map(({recipient, send}) => {
        const delivery = deliveries[recipient.messageDeliveryId]
        return {
            campaignRecipientId: recipient.campaignRecipientId,
            campaignSendId: send.campaignSendId,
            sendName: send.sendName || send.subject || send.campaignSendId,
            organizationName: organizationName(send.organizationPartyId),
            selectedDateText: dateText(recipient.selectedDate),
            recipientStatusText: statusText(recipient.statusId),
            deliveryText: delivery ? enumText(delivery.receiptEnumId) || enumText(delivery.stateEnumId) : ""
        }
    })
}
function engagement(context) {
    const out = []
    const allowed = new Map()
    for (const {recipient, send} of recipientsOf(context)) {
        if (recipient.tracked !== "Y") continue
        const key = send.organizationPartyId + "|" + (recipient.contactMechId || "")
        if (!allowed.has(key))
            allowed.set(key, tracking().trackingAllowed(context.partyId, recipient.contactMechId, send.organizationPartyId))
        if (!allowed.get(key)) continue
        const events = rows("mantle.marketing.tracking.MarketingTrackingEvent", {
            campaignRecipientId: recipient.campaignRecipientId
        }).filter(row => row.automated !== "Y")
        if (!events.length) continue
        const count = kind => events.filter(row => row.eventKindEnumId === kind).length
        const last = events.sort(newest("eventDate"))[0]
        out.push({
            campaignSendId: send.campaignSendId,
            sendName: send.sendName || send.subject || send.campaignSendId,
            openCount: count("MteOpen"),
            clickCount: count("MteClick"),
            lastDateText: dateText(last.eventDate)
        })
        if (out.length >= rowLimit) break
    }
    return out
}
function submissions(context) {
    return submissionsOf(context)
        .slice(0, rowLimit)
        .map(({submission, publication}) => ({
            formSubmissionId: submission.formSubmissionId,
            publicationId: publication.publicationId,
            title: publication.titleText || publication.description || publication.publicationId,
            purposeText: enumText(publication.purposeEnumId),
            organizationName: organizationName(publication.organizationPartyId),
            submittedDateText: dateText(submission.submittedDate)
        }))
}
function registrations(context) {
    const found = registrationsOf(context).slice(0, rowLimit)
    const attended = new Set(
        rowsIn(
            "mantle.work.registration.EventAttendance",
            "registrationId",
            found.map(({registration}) => registration.registrationId)
        ).map(row => row.registrationId)
    )
    return found.map(({registration, policy}) => ({
        registrationId: registration.registrationId,
        title: policy.publicTitle || policy.registrationPolicyId,
        whenText: dateText(policy.occurrenceStart),
        organizationName: organizationName(policy.organizationPartyId),
        roleText: registration.attendeePartyId === context.partyId ? "Attendee" : "Buyer",
        statusText: statusText(registration.statusId),
        attended: attended.has(registration.registrationId),
        attendedText: attended.has(registration.registrationId) ? "Checked in" : ""
    }))
}
function promotionUse(context) {
    const storeAdmin = stores()
    const storeScope = storeAdmin.scope("view")
    const storeIds = Array.from(storeAdmin.storeQuery(storeScope).list())
        .filter(store => context.covers(store.organizationPartyId))
        .map(store => store.productStoreId)
    const promotions = Object.fromEntries(
        rowsIn("mantle.product.store.ProductStorePromotion", "productStoreId", storeIds).map(row => [row.storePromotionId, row])
    )
    const promotionIds = Object.keys(promotions)
    if (!promotionIds.length) return []
    const used = Array.from(
        find("mantle.order.OrderItemAndPartSummary", {customerPartyId: context.partyId})
            .condition("storePromotionId", "in", promotionIds)
            .condition("statusId", "in", placedStatuses)
            .selectField("orderId")
            .selectField("storePromotionId")
            .selectField("promoCodeText")
            .selectField("placedDate")
            .selectField("promoTimesUsed")
            .selectField("itemTotal")
            .list()
    )
    const totals = new Map()
    for (const row of used) {
        const key = row.orderId + "|" + row.storePromotionId + "|" + text(row.promoCodeText)
        const total = totals.get(key) || {
            storePromotionId: row.storePromotionId,
            promotionName: promotions[row.storePromotionId].itemDescription || row.storePromotionId,
            promoCode: text(row.promoCodeText),
            placedDate: row.placedDate,
            useCount: 0,
            discount: toDecimal(0),
            currencyUomId: one("mantle.order.OrderHeader", {orderId: row.orderId})?.currencyUomId || null
        }
        total.useCount += Number(row.promoTimesUsed || 0)
        total.discount = total.discount.add(toDecimal(row.itemTotal ?? 0))
        totals.set(key, total)
    }
    return Array.from(totals.values())
        .sort(newest("placedDate"))
        .slice(0, rowLimit)
        .map(total => ({
            storePromotionId: total.storePromotionId,
            promotionName: total.promotionName,
            promoCode: total.promoCode,
            usedDateText: dateText(total.placedDate),
            useCount: total.useCount,
            discount: total.discount.negate(),
            currencyUomId: total.currencyUomId
        }))
}
function consent(context) {
    const organizationPartyIds = context.organizationPartyIds.slice(0, consentOrganizationLimit)
    const out = []
    for (const organizationPartyId of organizationPartyIds) {
        const state =
            ec.service
                .sync()
                .name("mantle.party.ConsentServices.get#PartyConsentState")
                .parameters({partyId: context.partyId, organizationPartyId})
                .disableAuthz()
                .call() || {}
        const addresses = Object.fromEntries(
            Array.from(state.addressList || []).map(address => [address.contactMechId, address.addressText || ""])
        )
        for (const row of Array.from(state.consentList || []))
            out.push({
                organizationName: organizationName(organizationPartyId),
                purposeText: enumText(row.purposeEnumId),
                addressText: row.contactMechId ? addresses[row.contactMechId] || "" : "Every address",
                granted: !!row.granted,
                statusText: row.granted ? "Granted" : "Withdrawn",
                scopeText: row.scoped ? "This organization" : "Every organization",
                consentDateText: dateText(row.consentDate)
            })
    }
    return out.slice(0, rowLimit)
}

// ===== get#Engagement =====
function getEngagement(p) {
    const userScope = marketingAccess.scope()
    marketingAccess.requireCapability(userScope, "anyRead")
    const partyId = text(p.partyId)
    const party = partyId ? one("mantle.party.Party", {partyId}) : null
    if (!party || (party.privateOwnerUserId && party.privateOwnerUserId !== ec.user.userId))
        denied("RECORD_UNAVAILABLE", "Party " + partyId + " is not available")
    let organizationPartyIds = marketingAccess.organizationIds(userScope).filter(id => marketingAccess.covers(userScope, id))
    if (p.organizationPartyId)
        organizationPartyIds = [marketingAccess.requireOrganization(userScope, text(p.organizationPartyId))]
    else if (userScope.activeOrganizationPartyId && organizationPartyIds.includes(userScope.activeOrganizationPartyId))
        organizationPartyIds = [userScope.activeOrganizationPartyId].concat(
            organizationPartyIds.filter(id => id !== userScope.activeOrganizationPartyId)
        )
    const context = {partyId, organizationPartyIds, covers: id => !!id && organizationPartyIds.includes(id)}
    const caps = userScope.capabilities
    const answered = []
    const omitted = []
    const failedSources = []
    for (const source of sources) {
        if (!source.allowed(caps)) {
            omitted.push(source.key)
            continue
        }
        try {
            const found = source.read(context)
            answered.push({sourceKey: source.key, title: source.title, count: found.length, rows: found})
        } catch (error) {
            // Commerce's own refusal (no store scope) leaves its source out like a missing permission
            if (lib.reasonCode(error) === "PERMISSION_DENIED") {
                omitted.push(source.key)
                continue
            }
            ec.logger.error("Engagement source " + source.key + " of party " + partyId + ": " + error.message)
            failedSources.push(source.key)
        }
    }
    const names = lib.partyNames([partyId])
    return {
        partyId,
        partyName: names[partyId] || partyId,
        merged: party.mergedToPartyId ? {mergedToPartyId: party.mergedToPartyId} : null,
        organizationNames: organizationPartyIds.slice(0, consentOrganizationLimit).map(organizationName),
        sources: answered,
        omittedSources: omitted,
        failedSources
    }
}

const operations = {getEngagement}
function run(op, p) {
    if (!operations[op]) throw new Error("Unknown engagement operation " + op)
    return operations[op](p)
}
;({execute: run})
