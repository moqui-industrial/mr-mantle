// Marketing's attribution of placed orders (mantle.marketing.TrackingServices record#, correct# and run#OrderAttribution(s); IronStone
// Marketing design §11 Attribution, §15.3 the attribution job, X10; impl-marketing P20, §4 Nov 11). CC0 1.0 Universal plus Grant of
// Patent License.
//
// - One decision an order: every placed sales order (Shop's checkout, a Sales acceptance, a direct order, a ticket: whatever placed it
//   through place#Order, which the SECA OrderPlacedRecordAttribution sees) gets one MarketingOutcomeLink in force, written after the
//   placement commits in a transaction of its own (handle#OrderPlaced), and by the retry job for an order the SECA's call missed.
//   A repeat answers the decision in force; the order's row is locked while deciding, so two calls make one.
// - The primary campaign: the most recent eligible tracking event of the order's identity, within its link's trackable lifetime
//   (the link's days, else 30), before the order was placed; a tie goes to the lower tracking code id. Eligible: a click or a page
//   visit of a link of the seller's organization, never a known automated fetch and never an open. The identity: the order's local
//   visit (OrderHeader.visitId, the browser's session on the authority) and the visitor keys that visit's events carried (the same
//   first-party key, set only where the organization's policy or the recipient's consent allows it), and the customer as a send
//   recipient who allows tracking (PcpTracking) now. Nothing is inferred across devices: an order with none of these is
//   unattributed, unless its source opportunity (SalesOpportunityOrder) names a campaign of the seller.
// - The decision keeps its evidence (the event, the link, the opportunity) and its evidence time: a later edit of a campaign or a link
//   changes no decision. The native TrackingCodeOrder row (one per order and code type, its key) is written beside a decision from
//   a tracking event, never billable: marketing credit implies no affiliate payment.
// - A staff correction (MARKETING_CONFIGURE in the seller's organization) names the decision it read, a campaign of the seller or
//   none, and a reason; it ends that decision and starts its successor (the audited chain), never editing it.
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const marketingAccess = ec.resource.script("component://mr-mantle/service/mantle/marketing/MarketingAccess.js")
const salesAccess = () => ec.resource.script("component://mr-mantle/service/mantle/sales/SalesAccess.js")
const tracking = () => ec.resource.script("component://mr-mantle/service/mantle/marketing/MarketingTracking.js")
const {find, one, rows, denied, call, ms} = lib

const LINK = "mantle.marketing.tracking.MarketingOutcomeLink"
const EVENT = "mantle.marketing.tracking.MarketingTrackingEvent"
const CODE = "mantle.marketing.tracking.TrackingCode"
const CODE_ORDER = "mantle.marketing.tracking.TrackingCodeOrder"
const RECIPIENT = "mantle.marketing.campaign.CampaignRecipient"
const CAMPAIGN = "mantle.marketing.campaign.MarketingCampaign"
const WATERMARK = "mantle.marketing.tracking.MarketingReportWatermark"
const DAY = 86400000
const limits = {
    // a link without its own trackable lifetime counts for this many days
    defaultLifetimeDays: 30,
    // the window the events are read from (the longest lifetime a link may name, 3650 days, is cut to this)
    windowDays: 365,
    recipients: 5000,
    events: 5000,
    // the retry job: orders placed in the last days, read at most, decided at most a run
    retryDays: 30,
    retryRead: 2000,
    retryDecide: 200
}
const placedStatuses = ["OrderPlaced", "OrderProcessing", "OrderApproved", "OrderSent", "OrderCompleted", "OrderHold"]
const text = value => (value == null ? "" : String(value).trim())
const blank = value => text(value) === ""

// ===== the order =====
// The order and its first part when it is a sales order of an internal seller to an outside customer, placed: {order, part}, or null.
function salesOrderOf(orderId, lock = false) {
    let query = blank(orderId) ? null : find("mantle.order.OrderHeader", {orderId: text(orderId)})
    if (query && lock) query = query.forUpdate(true)
    const order = query ? query.one() : null
    if (!order || !order.placedDate || !placedStatuses.includes(order.statusId)) return null
    const part = Array.from(find("mantle.order.OrderPart", {orderId: order.orderId}).orderBy("orderPartSeqId").limit(1).list())[0]
    if (!salesAccess().isSalesOrder(order, part)) return null
    return {order, part}
}
const currentOf = orderId => Array.from(find(LINK, {orderId}).condition("thruDate", "is-null", null).list())[0] || null

// ===== the evidence =====
// The events a set of conditions finds: clicks and page visits of a link of the organization, not automated, in [from, placed].
function eventsWhere(organizationPartyId, fromDate, placedDate, field, values) {
    const found = []
    const list = Array.from(new Set(values.filter(Boolean)))
    for (let at = 0; at < list.length && found.length < limits.events; at += 500)
        for (const event of Array.from(
            find(EVENT, {organizationPartyId})
                .condition(field, "in", list.slice(at, at + 500))
                .condition("eventKindEnumId", "in", ["MteClick", "MteVisit"])
                .condition("automated", "is-null", null)
                .condition("trackingCodeId", "is-not-null", null)
                .condition("eventDate", "greater-equals", fromDate)
                .condition("eventDate", "less-equals", placedDate)
                .limit(limits.events)
                .list()
        ))
            found.push(event)
    return found
}
// The order's eligible tracking events: by its local visit and the keys that visit carried, and by its customer as a recipient who
// allows tracking now. Each with its identity (visit, visitorKey, recipient).
function identityEvents(order, part) {
    const organizationPartyId = part.vendorPartyId
    const placedDate = order.placedDate
    const fromDate = new Date(ms(placedDate) - limits.windowDays * DAY)
    const byId = new Map()
    const add = (events, identity) => {
        for (const event of events) if (!byId.has(event.trackingEventId)) byId.set(event.trackingEventId, {event, identity})
    }
    if (order.visitId) {
        const visited = eventsWhere(organizationPartyId, fromDate, placedDate, "visitId", [order.visitId])
        add(visited, "visit")
        const keys = visited.map(event => event.visitorKeyHash).filter(Boolean)
        if (keys.length) add(eventsWhere(organizationPartyId, fromDate, placedDate, "visitorKeyHash", keys), "visitorKey")
    }
    if (part.customerPartyId && tracking().trackingAllowed(part.customerPartyId, null, organizationPartyId)) {
        const recipientIds = Array.from(
            find(RECIPIENT, {partyId: part.customerPartyId, tracked: "Y"})
                .selectField("campaignRecipientId")
                .limit(limits.recipients)
                .list()
        ).map(row => row.campaignRecipientId)
        if (recipientIds.length)
            add(eventsWhere(organizationPartyId, fromDate, placedDate, "campaignRecipientId", recipientIds), "recipient")
    }
    return Array.from(byId.values())
}
// The link's lifetime in millis (its own days, else the default).
function lifetimeOf(link) {
    const days = link?.trackableLifetime != null ? Number(link.trackableLifetime) : limits.defaultLifetimeDays
    return Math.max(0, Math.min(days, 3650)) * DAY
}
// The most recent eligible event within its link's lifetime of a campaign of the organization, ties by the lower code id, or null.
function chosenEvent(order, part) {
    const candidates = identityEvents(order, part)
    if (!candidates.length) return null
    const codes = new Map()
    const codeIds = Array.from(new Set(candidates.map(found => found.event.trackingCodeId)))
    for (let at = 0; at < codeIds.length; at += 500)
        for (const link of Array.from(
            find(CODE)
                .condition("trackingCodeId", "in", codeIds.slice(at, at + 500))
                .list()
        ))
            codes.set(link.trackingCodeId, link)
    const placed = ms(order.placedDate)
    const eligible = candidates.filter(({event}) => {
        const link = codes.get(event.trackingCodeId)
        if (!link || !link.marketingCampaignId) return false
        if ((link.organizationPartyId || event.organizationPartyId) !== part.vendorPartyId) return false
        return placed - ms(event.eventDate) <= lifetimeOf(link)
    })
    eligible.sort(
        (a, b) =>
            ms(b.event.eventDate) - ms(a.event.eventDate) ||
            String(a.event.trackingCodeId).localeCompare(String(b.event.trackingCodeId))
    )
    const found = eligible[0]
    return found ? {event: found.event, identity: found.identity, link: codes.get(found.event.trackingCodeId)} : null
}
// The source opportunity's campaign of the seller (SalesOpportunityOrder of the order, else of the quote it came from), or null.
function opportunityCampaign(order, part) {
    const orderIds = [order.orderId, order.parentOrderId].filter(Boolean)
    for (const orderId of orderIds) {
        for (const join of rows("mantle.sales.opportunity.SalesOpportunityOrder", {orderId})) {
            const opportunity = one("mantle.sales.opportunity.SalesOpportunity", {salesOpportunityId: join.salesOpportunityId})
            if (!opportunity?.marketingCampaignId || opportunity.organizationPartyId !== part.vendorPartyId) continue
            const campaign = one(CAMPAIGN, {marketingCampaignId: opportunity.marketingCampaignId})
            if (campaign?.organizationPartyId !== part.vendorPartyId) continue
            return {opportunity, campaign}
        }
    }
    return null
}

// ===== record#OrderAttribution =====
// The order's decision: the one in force, else a new one from its evidence. {outcomeLinkId, marketingCampaignId, basisEnumId,
// created, attributable}. An order that is not a placed sales order gets none.
function recordOrderAttribution(p) {
    const found = salesOrderOf(p.orderId, true)
    if (!found) return {attributable: false, created: false}
    const {order, part} = found
    const existing = currentOf(order.orderId)
    if (existing)
        return {
            attributable: true,
            created: false,
            outcomeLinkId: existing.outcomeLinkId,
            marketingCampaignId: existing.marketingCampaignId || null,
            basisEnumId: existing.basisEnumId
        }
    const values = {
        outcomeKindEnumId: "MokOrder",
        orderId: order.orderId,
        organizationPartyId: part.vendorPartyId,
        placedDate: order.placedDate,
        decidedDate: ec.user.nowTimestamp
    }
    const chosen = chosenEvent(order, part)
    if (chosen) {
        Object.assign(values, {
            marketingCampaignId: chosen.link.marketingCampaignId,
            basisEnumId: "MobTrackingEvent",
            trackingCodeId: chosen.link.trackingCodeId,
            trackingEventId: chosen.event.trackingEventId,
            evidenceDate: chosen.event.eventDate
        })
    } else {
        const source = opportunityCampaign(order, part)
        if (source)
            Object.assign(values, {
                marketingCampaignId: source.campaign.marketingCampaignId,
                basisEnumId: "MobOpportunity",
                salesOpportunityId: source.opportunity.salesOpportunityId,
                evidenceDate: source.opportunity.createdDate || null
            })
        else values.basisEnumId = "MobNone"
    }
    const outcomeLinkId = call("create#" + LINK, values).outcomeLinkId
    if (chosen) nativeOrderRow(order, chosen)
    return {
        attributable: true,
        created: true,
        outcomeLinkId,
        marketingCampaignId: values.marketingCampaignId || null,
        basisEnumId: values.basisEnumId
    }
}
// TrackingCodeOrder: one row per order and code type (its key), the first decision's; never billable.
function nativeOrderRow(order, chosen) {
    const trackingCodeTypeEnumId = chosen.link.trackingCodeTypeEnumId || "INTERNAL"
    if (one(CODE_ORDER, {orderId: order.orderId, trackingCodeTypeEnumId})) return
    call("create#" + CODE_ORDER, {
        orderId: order.orderId,
        trackingCodeTypeEnumId,
        trackingCodeId: chosen.link.trackingCodeId,
        isBillable: "N",
        siteId: chosen.event.siteId || null
    })
}

// ===== correct#OrderAttribution =====
function correctOrderAttribution(p) {
    const userScope = marketingAccess.scope()
    marketingAccess.requireCapability(userScope, "configure")
    const found = salesOrderOf(p.orderId, true)
    if (!found || !marketingAccess.covers(userScope, found.part.vendorPartyId))
        denied("RECORD_UNAVAILABLE", "Order " + text(p.orderId) + " is not available")
    const {order, part} = found
    const reason = text(p.reason)
    if (!reason) denied("REASON_REQUIRED", "Say why the attribution changes")
    // the decision in force (made now when the SECA's call and the job have not yet decided), and the one the caller read
    const existing =
        currentOf(order.orderId) || one(LINK, {outcomeLinkId: recordOrderAttribution({orderId: order.orderId}).outcomeLinkId})
    if (!blank(p.expectedOutcomeLinkId) && text(p.expectedOutcomeLinkId) !== existing.outcomeLinkId)
        denied("STALE_REVISION", "The attribution changed since you read it: decision " + existing.outcomeLinkId + " is in force")
    const marketingCampaignId = text(p.marketingCampaignId) || null
    if (marketingCampaignId) {
        const campaign = one(CAMPAIGN, {marketingCampaignId})
        if (!campaign || campaign.organizationPartyId !== part.vendorPartyId)
            denied("CAMPAIGN_INVALID", "Campaign " + marketingCampaignId + " is not a campaign of the order's seller")
    }
    if ((existing.marketingCampaignId || null) === marketingCampaignId)
        return {outcomeLinkId: existing.outcomeLinkId, changed: false}
    const now = ec.user.nowTimestamp
    const outcomeLinkId = call("create#" + LINK, {
        outcomeKindEnumId: "MokOrder",
        orderId: order.orderId,
        organizationPartyId: part.vendorPartyId,
        marketingCampaignId,
        basisEnumId: "MobStaff",
        evidenceDate: now,
        placedDate: order.placedDate,
        decidedDate: now,
        decidedByUserId: ec.user.userId,
        reason: reason.slice(0, 255),
        supersedesLinkId: existing.outcomeLinkId
    }).outcomeLinkId
    call("update#" + LINK, {outcomeLinkId: existing.outcomeLinkId, thruDate: now, supersededByLinkId: outcomeLinkId})
    return {outcomeLinkId, changed: true}
}

// ===== run#OrderAttributions (the retry job) =====
// The placed sales orders of the last days with no decision, each decided in a transaction of its own; one that fails is logged by
// name and the rest go on. Its watermark row keeps the run's time and counts.
function runOrderAttributions(p) {
    const days = Math.min(Math.max(Number(p.days) || limits.retryDays, 1), 365)
    const since = new Date(ms(ec.user.nowTimestamp) - days * DAY)
    const orderIds = Array.from(
        find("mantle.order.OrderHeader")
            .condition("placedDate", "greater-equals", since)
            .condition("statusId", "in", placedStatuses)
            .selectField("orderId")
            .orderBy("-placedDate")
            .limit(limits.retryRead)
            .list()
    ).map(row => row.orderId)
    const decided = new Set()
    for (let at = 0; at < orderIds.length; at += 500)
        for (const link of Array.from(
            find(LINK)
                .condition("orderId", "in", orderIds.slice(at, at + 500))
                .selectField("orderId")
                .list()
        ))
            decided.add(link.orderId)
    const due = orderIds.filter(orderId => !decided.has(orderId)).slice(0, limits.retryDecide)
    let recordedCount = 0
    const failed = []
    for (const orderId of due) {
        ec.message.pushErrors()
        try {
            const out = lib.probe("mantle.marketing.TrackingServices.record#OrderAttribution", {orderId})
            if (out.created) recordedCount++
        } catch (error) {
            failed.push(orderId)
            ec.logger.error("Order " + orderId + ": its attribution was not recorded: " + String(error.message).split("\n")[0])
        } finally {
            ec.message.clearErrors()
            ec.message.popErrors()
        }
    }
    try {
        lib.probe("store#" + WATERMARK, {
            watermarkKey: "attribution",
            watermarkDate: since,
            lastRunDate: ec.user.nowTimestamp,
            itemCount: recordedCount,
            failedCount: failed.length,
            lastError: failed.length ? ("Orders not attributed: " + failed.join(", ")).slice(0, 255) : null
        })
    } catch (error) {
        ec.logger.error("The attribution job's watermark was not kept: " + error.message)
    }
    return {recordedCount, failedCount: failed.length}
}

const operations = {recordOrderAttribution, correctOrderAttribution, runOrderAttributions}
;({
    limits,
    currentOf,
    salesOrderOf,
    // each operation checks its caller (record# and run# are internal: the system's, after the placement or on the job) and reads and
    // writes with artifact authorization off
    execute(op, parameters) {
        if (!Object.hasOwn(operations, op)) throw new Error("Unknown marketing attribution operation " + op)
        const wasDisabled = ec.artifactExecution.disableAuthz()
        try {
            return operations[op](parameters || {})
        } finally {
            if (!wasDisabled) ec.artifactExecution.enableAuthz()
        }
    }
})
