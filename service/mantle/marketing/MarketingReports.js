// Marketing's reports (mantle.marketing.MarketingReportServices, R of IronStone Marketing design §14.2; design §11 Reports,
// CampaignPerformance, DeliveryAnalysis, AudienceGrowth, Attribution, §15.3 the reporting and retention jobs, §18; impl-marketing P20,
// F34). CC0 1.0 Universal plus Grant of Patent License.
//
// - Who: a Marketing report reader (MARKETING_REPORT_VIEW: the analysts, the readers, the administrator) of the organizations of their
//   scope (MarketingAccess.js); another organization ORGANIZATION_DENIED, a campaign, send or list outside it RECORD_UNAVAILABLE. The
//   reports are aggregates: no person, no address. An attributed order's own row (Attribution) is shown only to a reader who may also
//   see the order in Sales (SalesAccess orderOf) or in Commerce (the store's COMMERCE_ORDER_VIEW); the others are counted, never named.
// - Each measure says its basis and denominator: an accepted recipient is the transport's acceptance (the ledger's Sent), a delivered
//   one needs a receipt (unavailable without receipt coverage, never zero); open and click rates are over the accepted recipients
//   who allowed tracking, so an untracked recipient is in no rate's denominator; a recipient counts once for unique engagement
//   whatever its events or retries; an automated fetch is set apart and is never engagement or a conversion; SMS has no open rate.
// - Amounts are never added across currencies: each is a list by currency; ROI is shown only with an actual cost and net revenue in
//   the same one currency, else unavailable with its reason. Orders and order value are Sales' measures (Sales.Orders,
//   Sales.OrderValue), invoiced revenue Accounting's (Accounting.InvoicedRevenue), read here for the attributed orders only, never
//   redefined; returns reduce the invoiced net once.
// - Small cells (P20 review): an amount of fewer than minimumCell orders (one currency's orders of a campaign, a link or the
//   unattributed) is withheld, its order count kept, unless the reader may see each of those orders in Sales or Commerce; a report
//   reader who can name a campaign's few recipients (an audience reader, a small send) would otherwise read one person's purchase.
//   ROI over a withheld net is unavailable.
// - A parent campaign with its children counts each descendant's sources once (the union of their ids).
// - Nothing is cut silently: a report past its limit (campaigns, sends, recipients, lists, orders) is refused TOO_MANY_RECORDS, naming
//   the count, so the reader narrows it.
// - The jobs (run#MarketingAggregation, run#MarketingRetention) run as the system, each item on its own: one that fails is logged by
//   name and the rest go on; their watermark rows are the reports' freshness.
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const marketingAccess = ec.resource.script("component://mr-mantle/service/mantle/marketing/MarketingAccess.js")
const salesAccess = () => ec.resource.script("component://mr-mantle/service/mantle/sales/SalesAccess.js")
const {find, one, rows, denied, call, ms} = lib

const CAMPAIGN = "mantle.marketing.campaign.MarketingCampaign"
const SEND = "mantle.marketing.campaign.CampaignSend"
const RECIPIENT = "mantle.marketing.campaign.CampaignRecipient"
const VARIANT = "mantle.marketing.campaign.CampaignExperimentVariant"
const DELIVERY = "mantle.party.MessageDelivery"
const EVENT = "mantle.marketing.tracking.MarketingTrackingEvent"
const CODE = "mantle.marketing.tracking.TrackingCode"
const LINK = "mantle.marketing.tracking.MarketingOutcomeLink"
const WATERMARK = "mantle.marketing.tracking.MarketingReportWatermark"
const OPPORTUNITY = "mantle.sales.opportunity.SalesOpportunity"
const LIST = "mantle.marketing.contact.ContactList"
const LIST_PARTY = "mantle.marketing.contact.ContactListParty"
const CONSENT = "mantle.party.PartyConsent"
const REQUEST = "mantle.marketing.contact.SubscriptionRequest"
const SUPPRESSION = "mantle.party.MessageSuppression"
const DAY = 86400000
const limits = {
    campaigns: 200,
    descendants: 200,
    sends: 200,
    recipients: 50000,
    orders: 5000,
    lists: 200,
    consents: 50000,
    links: 200,
    distinct: 100000,
    organizations: 200,
    rangeDays: 3660,
    // the fewest orders an amount is shown for to a reader who may not see each of them
    minimumCell: 3
}
const releasedStatuses = [
    "CsScheduled",
    "CsSending",
    "CsPaused",
    "CsSampleSent",
    "CsCompleted",
    "CsCompletedFailures",
    "CsCancelled"
]
const engagementKinds = ["MteClick", "MteVisit"]
const text = value => (value == null ? "" : String(value).trim())
const blank = value => text(value) === ""
const slices = (list, size = 500) => {
    const parts = []
    for (let at = 0; at < list.length; at += size) parts.push(list.slice(at, at + size))
    return parts
}
const unique = list => Array.from(new Set(list.filter(value => value != null && value !== "")))
const statusText = statusId => (statusId ? one("moqui.basic.StatusItem", {statusId})?.description || statusId : "")
const enumText = enumId => (enumId ? one("moqui.basic.Enumeration", {enumId})?.description || enumId : "")
const organizationName = partyId => (partyId ? one("mantle.party.Organization", {partyId})?.organizationName || partyId : "")
const num = value => (value == null || value === "" ? 0 : Number(value.toNumber ? value.toNumber() : value))
const percentOf = (part, whole) => (whole ? Math.round((part / whole) * 1000) / 10 : null)
const percentText = value => (value == null ? ec.l10n.localize("Not available") : value + " %")
const moneyText = (value, currencyUomId) =>
    currencyUomId
        ? ec.l10n.formatCurrency(ec.l10n.roundCurrency(toDecimal(value ?? 0), currencyUomId), currencyUomId)
        : ec.l10n.format(toDecimal(value ?? 0), "#,##0.00")
// "USD 120.00; EUR 50.00", never one total; a withheld small cell says so
const withheldText = currencyUomId =>
    (currencyUomId ? currencyUomId + " " : "") +
    ec.l10n.localize("withheld (fewer than " + limits.minimumCell + " orders)")
const amountsText = amounts =>
    amounts.length
        ? amounts
              .map(row => (row.withheld ? withheldText(row.currencyUomId) : moneyText(row.amount, row.currencyUomId)))
              .join("; ")
        : ec.l10n.localize("None")
function tooMany(count, limit, what) {
    if (count > limit)
        denied("TOO_MANY_RECORDS", count + " " + what + ", more than the " + limit + " a report reads: narrow the report")
}

// ===== the reader =====
// A report reader of the organization named, or of every organization of their scope: {userScope, organizationPartyId,
// organizationPartyIds}.
function reportScope(p) {
    const userScope = marketingAccess.scope()
    marketingAccess.requireCapability(userScope, "reportRead")
    const organizationPartyId = text(p.organizationPartyId)
    if (organizationPartyId) marketingAccess.requireOrganization(userScope, organizationPartyId)
    const organizationPartyIds = organizationPartyId ? [organizationPartyId] : marketingAccess.organizationIds(userScope)
    tooMany(organizationPartyIds.length, limits.organizations, "organizations")
    return {userScope, organizationPartyId: organizationPartyId || null, organizationPartyIds}
}
// The period [fromDate, thruDate): the dates given, else the last 30 days to now.
function periodOf(p) {
    const dateOf = (value, label) => {
        if (blank(value)) return null
        const found = ms(value)
        if (found == null || !Number.isFinite(found)) denied("DATE_INVALID", label + " is not a date")
        return found
    }
    const thru = dateOf(p.thruDate, "Through") ?? ms(ec.user.nowTimestamp)
    const from = dateOf(p.fromDate, "From") ?? thru - 30 * DAY
    if (thru <= from) denied("DATE_INVALID", "The period must end after it starts")
    if (thru - from > limits.rangeDays * DAY) denied("DATE_INVALID", "A report reads at most ten years")
    return {
        from: new Date(from),
        thru: new Date(thru),
        fromText: lib.dateText(new Date(from)),
        thruText: lib.dateText(new Date(thru))
    }
}
const asOf = () => ({asOfDate: ec.user.nowTimestamp, asOfText: lib.dateText(ec.user.nowTimestamp)})
function watermarkOf(watermarkKey) {
    const row = one(WATERMARK, {watermarkKey})
    return row ? {lastRunText: lib.dateText(row.lastRunDate), failedCount: Number(row.failedCount || 0)} : null
}
// A campaign of the scope, else RECORD_UNAVAILABLE.
function campaignOf(context, marketingCampaignId) {
    const row = blank(marketingCampaignId) ? null : one(CAMPAIGN, {marketingCampaignId: text(marketingCampaignId)})
    if (!row || !context.organizationPartyIds.includes(row.organizationPartyId))
        denied("RECORD_UNAVAILABLE", "Campaign " + text(marketingCampaignId) + " is not available")
    return row
}
// A campaign and its descendants of its organization (each once), at most the limit.
function familyOf(campaign) {
    const ids = [campaign.marketingCampaignId]
    for (let at = 0; at < ids.length; at++) {
        for (const child of Array.from(
            find(CAMPAIGN, {parentCampaignId: ids[at], organizationPartyId: campaign.organizationPartyId})
                .selectField("marketingCampaignId")
                .list()
        ))
            if (!ids.includes(child.marketingCampaignId)) ids.push(child.marketingCampaignId)
        tooMany(ids.length, limits.descendants, "campaigns under " + (campaign.campaignName || campaign.marketingCampaignId))
    }
    return ids
}

// ===== the orders of an attribution (Sales' and Accounting's measures, read for the orders only) =====
// The orders' value, invoiced amount and completed returns, each by currency: Map orderId → {currencyUomId, grandTotal, invoiced,
// returned}.
function orderAmounts(orderIds) {
    const found = new Map()
    for (const part of slices(orderIds))
        for (const order of Array.from(
            find("mantle.order.OrderHeader")
                .condition("orderId", "in", part)
                .selectField("orderId")
                .selectField("currencyUomId")
                .selectField("grandTotal")
                .list()
        ))
            found.set(order.orderId, {
                currencyUomId: order.currencyUomId || null,
                grandTotal: num(order.grandTotal),
                invoiced: 0,
                returned: 0
            })
    for (const part of slices(orderIds)) {
        for (const billing of Array.from(find("mantle.order.OrderItemBilling").condition("orderId", "in", part).list())) {
            const entry = found.get(billing.orderId)
            if (entry) entry.invoiced += num(billing.quantity ?? 1) * num(billing.amount)
        }
        for (const item of Array.from(
            find("mantle.order.return.ReturnItem")
                .condition("orderId", "in", part)
                .condition("statusId", "ReturnCompleted")
                .list()
        )) {
            const entry = found.get(item.orderId)
            if (entry) entry.returned += num(item.returnQuantity ?? 1) * num(item.returnPrice)
        }
    }
    return found
}
// The amounts of some orders by currency: [{currencyUomId, orderCount, orderValue, invoiced, returned, net, withheld}]. With a
// reader (orderReader()), a currency's amounts of fewer than minimumCell orders are withheld (null) unless the reader may see each.
function byCurrency(orderIds, amounts, readable) {
    const groups = new Map()
    for (const orderId of orderIds) {
        const entry = amounts.get(orderId)
        if (!entry) continue
        const key = entry.currencyUomId || ""
        const group = groups.get(key) || {
            currencyUomId: entry.currencyUomId,
            orderCount: 0,
            orderValue: 0,
            invoiced: 0,
            returned: 0,
            orderIds: []
        }
        group.orderCount++
        group.orderIds.push(orderId)
        group.orderValue += entry.grandTotal
        group.invoiced += entry.invoiced
        group.returned += entry.returned
        groups.set(key, group)
    }
    return Array.from(groups.values())
        .map(group => {
            const ids = group.orderIds
            delete group.orderIds
            Object.assign(group, {net: group.invoiced - group.returned, withheld: false})
            if (readable && group.orderCount < limits.minimumCell && !ids.every(orderId => readable(orderId)))
                Object.assign(group, {orderValue: null, invoiced: null, returned: null, net: null, withheld: true})
            return group
        })
        .sort((a, b) => String(a.currencyUomId).localeCompare(String(b.currencyUomId)))
}
const amountsOf = (groups, field) =>
    groups.map(group => ({currencyUomId: group.currencyUomId, amount: group[field], withheld: !!group.withheld}))
// The current decisions of the organizations' orders placed in the period, optionally of some campaigns or unattributed alone.
function decisionsOf(organizationPartyIds, period, campaignIds) {
    let query = find(LINK)
        .condition("organizationPartyId", "in", organizationPartyIds)
        .condition("thruDate", "is-null", null)
        .condition("placedDate", "greater-equals", period.from)
        .condition("placedDate", "less", period.thru)
    if (campaignIds) query = query.condition("marketingCampaignId", "in", campaignIds)
    tooMany(query.count(), limits.orders, "attributed orders")
    return Array.from(query.orderBy("-placedDate").list())
}

// ===== get#CampaignPerformance (design §11 CampaignPerformance) =====
// The deliveries of sends handed to the ledger: accepted (Sent) in the period by send, the people reached once.
function sendMeasures(sendIds, period) {
    let accepted = 0
    const reach = new Set()
    for (const campaignSendId of sendIds) {
        const base = () =>
            find(DELIVERY, {sourceEnumId: "MdsrcCampaignSend", stateEnumId: "MdsSent"})
                .condition("eventKey", "like", "CampaignSend:" + campaignSendId + ":%")
                .condition("sentDate", "greater-equals", period.from)
                .condition("sentDate", "less", period.thru)
        accepted += base().count()
        for (const row of Array.from(base().selectField("recipientPartyId").distinct(true).limit(limits.distinct).list()))
            if (row.recipientPartyId) reach.add(row.recipientPartyId)
    }
    return {accepted, reach}
}
// Visits: the non-automated clicks and page visits of the links in the period, a visitor key once and each event without one.
function visitCount(baseQuery) {
    const keyed = Array.from(
        baseQuery()
            .condition("visitorKeyHash", "is-not-null", null)
            .selectField("visitorKeyHash")
            .distinct(true)
            .limit(limits.distinct)
            .list()
    ).length
    return keyed + baseQuery().condition("visitorKeyHash", "is-null", null).count()
}
function campaignMeasures(campaignIds, period) {
    const sendIds = Array.from(
        find(SEND).condition("marketingCampaignId", "in", campaignIds).selectField("campaignSendId").limit(5000).list()
    ).map(row => row.campaignSendId)
    const sends = sendMeasures(sendIds, period)
    const codeIds = Array.from(
        find(CODE).condition("marketingCampaignId", "in", campaignIds).selectField("trackingCodeId").limit(5000).list()
    ).map(row => row.trackingCodeId)
    const visits = codeIds.length
        ? visitCount(() =>
              find(EVENT)
                  .condition("trackingCodeId", "in", codeIds)
                  .condition("eventKindEnumId", "in", engagementKinds)
                  .condition("automated", "is-null", null)
                  .condition("eventDate", "greater-equals", period.from)
                  .condition("eventDate", "less", period.thru)
          )
        : 0
    const leads = find(OPPORTUNITY)
        .condition("marketingCampaignId", "in", campaignIds)
        .condition("createdDate", "greater-equals", period.from)
        .condition("createdDate", "less", period.thru)
        .count()
    const qualifiedLeads = find(OPPORTUNITY)
        .condition("marketingCampaignId", "in", campaignIds)
        .condition("convertedDate", "greater-equals", period.from)
        .condition("convertedDate", "less", period.thru)
        .count()
    const registrations = find("mantle.work.registration.EventRegistration", {statusId: "EvrConfirmed"})
        .condition("marketingCampaignId", "in", campaignIds)
        .condition("createdDate", "greater-equals", period.from)
        .condition("createdDate", "less", period.thru)
        .count()
    return {sendCount: sendIds.length, accepted: sends.accepted, reach: sends.reach, visits, leads, qualifiedLeads, registrations}
}
// ROI over one currency: the net invoiced of the campaign's cost currency against its actual cost, else unavailable with why.
function roiOf(cost, costUomId, groups) {
    if (cost == null || !costUomId) return {roiPercent: null, roiNote: ec.l10n.localize("No actual cost")}
    if (cost <= 0) return {roiPercent: null, roiNote: ec.l10n.localize("No actual cost")}
    if (!groups.length) return {roiPercent: null, roiNote: ec.l10n.localize("No invoiced revenue")}
    if (groups.some(group => group.withheld))
        return {roiPercent: null, roiNote: ec.l10n.localize("Too few orders to show")}
    if (groups.length > 1 || groups[0].currencyUomId !== costUomId)
        return {roiPercent: null, roiNote: ec.l10n.localize("Revenue in another currency than the cost")}
    return {roiPercent: Math.round(((groups[0].net - cost) / cost) * 1000) / 10, roiNote: null}
}
function campaignPerformance(p) {
    const context = reportScope(p)
    const period = periodOf(p)
    const includeChildren = p.includeChildren === true || p.includeChildren === "true" || p.includeChildren === "Y"
    let campaigns
    if (!blank(p.marketingCampaignId)) campaigns = [campaignOf(context, p.marketingCampaignId)]
    else {
        const cf = ec.entity.conditionFactory
        const query = find(CAMPAIGN)
            .condition("organizationPartyId", "in", context.organizationPartyIds)
            .condition("statusId", "not-equals", "MKTG_CAMP_CANCELLED")
            .condition(
                cf.makeCondition(
                    [cf.makeCondition("fromDate", "is-null", null), cf.makeCondition("fromDate", "less", period.thru)],
                    "or"
                )
            )
            .condition(
                cf.makeCondition(
                    [cf.makeCondition("thruDate", "is-null", null), cf.makeCondition("thruDate", "greater-equals", period.from)],
                    "or"
                )
            )
        tooMany(query.count(), limits.campaigns, "campaigns")
        campaigns = Array.from(query.orderBy("campaignName").list())
    }
    const readable = orderReader()
    const rowsOut = []
    for (const campaign of campaigns) {
        const ids = includeChildren ? familyOf(campaign) : [campaign.marketingCampaignId]
        const measures = campaignMeasures(ids, period)
        const decisions = decisionsOf([campaign.organizationPartyId], period, ids)
        const orderIds = decisions.map(row => row.orderId)
        const groups = byCurrency(orderIds, orderAmounts(orderIds), readable)
        // the cost: the campaign's own, or with its children only when they share its currency
        let cost = campaign.actualCost == null ? null : num(campaign.actualCost)
        let costNote = null
        if (includeChildren && ids.length > 1) {
            for (const child of Array.from(find(CAMPAIGN).condition("marketingCampaignId", "in", ids.slice(1)).list())) {
                if (child.actualCost == null) continue
                if (child.costUomId !== campaign.costUomId) {
                    cost = null
                    costNote = ec.l10n.localize("Costs in several currencies are not added")
                    break
                }
                cost = (cost ?? 0) + num(child.actualCost)
            }
        }
        const roi = costNote ? {roiPercent: null, roiNote: costNote} : roiOf(cost, campaign.costUomId, groups)
        rowsOut.push({
            marketingCampaignId: campaign.marketingCampaignId,
            campaignName: campaign.campaignName || campaign.marketingCampaignId,
            organizationPartyId: campaign.organizationPartyId,
            organizationName: organizationName(campaign.organizationPartyId),
            statusText: statusText(campaign.statusId),
            includedCount: ids.length,
            costUomId: campaign.costUomId || null,
            budgetedText: campaign.budgetedCost == null ? "" : moneyText(campaign.budgetedCost, campaign.costUomId),
            estimatedText: campaign.estimatedCost == null ? "" : moneyText(campaign.estimatedCost, campaign.costUomId),
            actualCost: cost,
            actualText: cost == null ? costNote || "" : moneyText(cost, campaign.costUomId),
            sendCount: measures.sendCount,
            acceptedCount: measures.accepted,
            reachCount: measures.reach.size,
            visitCount: measures.visits,
            leadCount: measures.leads,
            qualifiedLeadCount: measures.qualifiedLeads,
            registrationCount: measures.registrations,
            orderCount: orderIds.length,
            amounts: groups,
            orderValueText: amountsText(amountsOf(groups, "orderValue")),
            invoicedText: amountsText(amountsOf(groups, "invoiced")),
            returnedText: amountsText(amountsOf(groups, "returned")),
            netText: amountsText(amountsOf(groups, "net")),
            roiPercent: roi.roiPercent,
            roiText: roi.roiPercent == null ? roi.roiNote : roi.roiPercent + " %",
            numSent: campaign.numSent == null ? null : Number(campaign.numSent),
            numSentText: campaign.numSent == null ? ec.l10n.localize("Not computed yet") : String(campaign.numSent),
            summaryText: lib.dateText(campaign.summaryDate)
        })
    }
    return Object.assign(
        {
            campaignRows: rowsOut,
            fromText: period.fromText,
            thruText: period.thruText,
            basis: "Accepted: promotional deliveries the transport accepted in the period (no test, no transactional notice); reach: the people of those deliveries, each once; visits: link clicks and page visits, a visitor key once; leads by created date, qualified by qualified date; orders by placed date, their primary campaign; value, invoiced, returns and net by currency, never added across currencies.",
            aggregation: watermarkOf("aggregation")
        },
        asOf()
    )
}

// ===== get#DeliveryAnalysis (design §11 DeliveryAnalysis) =====
const emptyTally = () => ({
    preparedCount: 0,
    attemptedCount: 0,
    skippedCount: 0,
    heldCount: 0,
    cancelledCount: 0,
    acceptedCount: 0,
    pendingCount: 0,
    failedCount: 0,
    uncertainCount: 0,
    suppressedCount: 0,
    deliveredCount: 0,
    hardBounceCount: 0,
    softBounceCount: 0,
    complaintCount: 0,
    receiptCount: 0,
    trackedAcceptedCount: 0,
    openCount: 0,
    clickCount: 0,
    automatedCount: 0,
    conversionCount: 0
})
// The recipients' outcomes, each recipient once: its dispatch state, its ledger delivery's state and receipt, and for an accepted
// recipient who allowed tracking its unique open and click (non-automated), the automated fetches apart, and the orders attributed
// to its tracked events.
function tallyRecipients(recipients) {
    const tally = emptyTally()
    const deliveryIds = []
    const byDelivery = new Map()
    for (const recipient of recipients) {
        tally.preparedCount++
        if (recipient.statusId === "CrsHandedOff") tally.attemptedCount++
        else if (recipient.statusId === "CrsSkipped") tally.skippedCount++
        else if (recipient.statusId === "CrsHeld") tally.heldCount++
        else if (recipient.statusId === "CrsCancelled") tally.cancelledCount++
        if (recipient.statusId === "CrsHandedOff" && recipient.messageDeliveryId) {
            deliveryIds.push(recipient.messageDeliveryId)
            byDelivery.set(recipient.messageDeliveryId, recipient)
        }
    }
    const trackedAccepted = []
    for (const part of slices(deliveryIds))
        for (const delivery of Array.from(
            find(DELIVERY)
                .condition("deliveryId", "in", part)
                .selectField("deliveryId")
                .selectField("stateEnumId")
                .selectField("receiptEnumId")
                .list()
        )) {
            const state = delivery.stateEnumId
            if (state === "MdsSent") tally.acceptedCount++
            else if (state === "MdsFailed") tally.failedCount++
            else if (state === "MdsUncertain") tally.uncertainCount++
            else if (state === "MdsSuppressed") tally.suppressedCount++
            else tally.pendingCount++
            const receipt = delivery.receiptEnumId
            if (state === "MdsSent" && receipt) tally.receiptCount++
            if (receipt === "MdrDelivered") tally.deliveredCount++
            else if (receipt === "MdrHardBounce") tally.hardBounceCount++
            else if (receipt === "MdrSoftBounce") tally.softBounceCount++
            else if (receipt === "MdrComplaint") tally.complaintCount++
            const recipient = byDelivery.get(delivery.deliveryId)
            if (state === "MdsSent" && recipient?.tracked === "Y") trackedAccepted.push(recipient.campaignRecipientId)
        }
    tally.trackedAcceptedCount = trackedAccepted.length
    const opened = new Set(),
        clicked = new Set()
    const engagementEventIds = []
    for (const part of slices(trackedAccepted))
        for (const event of Array.from(
            find(EVENT)
                .condition("campaignRecipientId", "in", part)
                .selectField("trackingEventId")
                .selectField("campaignRecipientId")
                .selectField("eventKindEnumId")
                .selectField("automated")
                .list()
        )) {
            if (event.automated === "Y") {
                tally.automatedCount++
                continue
            }
            if (event.eventKindEnumId === "MteOpen") opened.add(event.campaignRecipientId)
            else if (event.eventKindEnumId === "MteClick") clicked.add(event.campaignRecipientId)
            if (engagementKinds.includes(event.eventKindEnumId)) engagementEventIds.push(event.trackingEventId)
        }
    tally.openCount = opened.size
    tally.clickCount = clicked.size
    const converted = new Set()
    for (const part of slices(engagementEventIds))
        for (const link of Array.from(
            find(LINK)
                .condition("trackingEventId", "in", part)
                .condition("thruDate", "is-null", null)
                .selectField("orderId")
                .list()
        ))
            converted.add(link.orderId)
    tally.conversionCount = converted.size
    return tally
}
// The rates of a tally, each over its own denominator; null (not available) when it is empty.
function ratesOf(tally, channelEnumId) {
    const receiptCoverage = percentOf(tally.receiptCount, tally.acceptedCount)
    const deliveryRate = tally.receiptCount ? percentOf(tally.deliveredCount, tally.acceptedCount) : null
    const openRate = channelEnumId === "MdcSms" ? null : percentOf(tally.openCount, tally.trackedAcceptedCount)
    const clickRate = percentOf(tally.clickCount, tally.trackedAcceptedCount)
    return {
        receiptCoverage,
        receiptCoverageText: percentText(receiptCoverage),
        deliveryRate,
        deliveryRateText: percentText(deliveryRate),
        openRate,
        openRateText: channelEnumId === "MdcSms" ? ec.l10n.localize("No open rate for text messages") : percentText(openRate),
        clickRate,
        clickRateText: percentText(clickRate),
        bounceRate: percentOf(tally.hardBounceCount + tally.softBounceCount, tally.attemptedCount),
        complaintRate: percentOf(tally.complaintCount, tally.acceptedCount)
    }
}
const recipientFields = ["campaignRecipientId", "statusId", "tracked", "messageDeliveryId", "campaignExperimentVariantId"]
function recipientsOf(send, period) {
    let query = find(RECIPIENT, {campaignSendId: send.campaignSendId}).condition("statusId", "not-equals", "CrsReplaced")
    // a send of an automation has no release: its recipients handed off in the period
    if (send.statusId === "CsAutomation")
        query = query.condition("handedOffDate", "greater-equals", period.from).condition("handedOffDate", "less", period.thru)
    else if (send.preparedRevision != null) query = query.condition("preparedRevision", Number(send.preparedRevision))
    for (const field of recipientFields) query = query.selectField(field)
    return query
}
function deliveryAnalysis(p) {
    const context = reportScope(p)
    const period = periodOf(p)
    let sends
    if (!blank(p.campaignSendId)) {
        const send = one(SEND, {campaignSendId: text(p.campaignSendId)})
        if (!send || !context.organizationPartyIds.includes(send.organizationPartyId))
            denied("RECORD_UNAVAILABLE", "Send " + text(p.campaignSendId) + " is not available")
        sends = [send]
    } else {
        const cf = ec.entity.conditionFactory
        let query = find(SEND)
            .condition("organizationPartyId", "in", context.organizationPartyIds)
            .condition(
                cf.makeCondition(
                    [
                        cf.makeCondition(
                            [
                                cf.makeCondition("statusId", "in", releasedStatuses),
                                cf.makeCondition("releasedDate", "greater-equals", period.from),
                                cf.makeCondition("releasedDate", "less", period.thru)
                            ],
                            "and"
                        ),
                        cf.makeCondition("statusId", "equals", "CsAutomation")
                    ],
                    "or"
                )
            )
        if (!blank(p.marketingCampaignId))
            query = query.condition("marketingCampaignId", campaignOf(context, p.marketingCampaignId).marketingCampaignId)
        if (!blank(p.sendingProfileId)) query = query.condition("sendingProfileId", text(p.sendingProfileId))
        if (!blank(p.channelEnumId)) query = query.condition("channelEnumId", text(p.channelEnumId))
        tooMany(query.count(), limits.sends, "sends")
        sends = Array.from(query.orderBy("-releasedDate").list())
    }
    let recipientTotal = 0
    for (const send of sends) recipientTotal += recipientsOf(send, period).count()
    tooMany(recipientTotal, limits.recipients, "recipients")
    const total = emptyTally()
    const sendRows = []
    const variantRows = []
    for (const send of sends) {
        const recipients = Array.from(recipientsOf(send, period).list())
        const tally = tallyRecipients(recipients)
        // an automation's send with nothing handed off in the period is not shown
        if (send.statusId === "CsAutomation" && !tally.preparedCount) continue
        for (const key of Object.keys(total)) total[key] += tally[key]
        sendRows.push(
            Object.assign(
                {
                    campaignSendId: send.campaignSendId,
                    sendName: send.sendName || send.subject || send.campaignSendId,
                    marketingCampaignId: send.marketingCampaignId || null,
                    statusText: statusText(send.statusId),
                    channelText: enumText(send.channelEnumId || "MdcEmail"),
                    releasedText: lib.dateText(send.releasedDate)
                },
                tally,
                ratesOf(tally, send.channelEnumId)
            )
        )
        // an experiment's variants: the same counts, which add up to the send's for its sampled and released recipients
        const variantIds = unique(recipients.map(row => row.campaignExperimentVariantId))
        for (const campaignExperimentVariantId of variantIds) {
            const variant = one(VARIANT, {campaignExperimentVariantId})
            const variantTally = tallyRecipients(
                recipients.filter(row => row.campaignExperimentVariantId === campaignExperimentVariantId)
            )
            variantRows.push(
                Object.assign(
                    {
                        campaignSendId: send.campaignSendId,
                        campaignExperimentVariantId,
                        variantLabel: variant?.variantLabel || variant?.variantName || campaignExperimentVariantId
                    },
                    variantTally,
                    ratesOf(variantTally, send.channelEnumId)
                )
            )
        }
    }
    return Object.assign(
        {
            sendRows,
            variantRows,
            totals: Object.assign({}, total, ratesOf(total, null)),
            fromText: period.fromText,
            thruText: period.thruText,
            basis: "Sends released in the period (an automation's: its recipients handed off in the period), each recipient once. Accepted: the transport accepted the message; delivered: a receipt says so (not available without receipts); delivery rate over accepted, with the receipt coverage; open and click rates over the accepted recipients who allowed tracking; automated fetches apart, never engagement; conversions: the orders attributed to a recipient's own tracked click or visit."
        },
        asOf()
    )
}

// ===== get#AudienceGrowth (design §11 AudienceGrowth) =====
// The Marketing lists of the organizations (never a mailbox), or the one named.
function listsOf(context, p) {
    if (!blank(p.contactListId)) {
        const list = one(LIST, {contactListId: text(p.contactListId)})
        if (!list || list.contactListTypeEnumId === "MAILBOX" || !context.organizationPartyIds.includes(list.ownerPartyId))
            denied("RECORD_UNAVAILABLE", "List " + text(p.contactListId) + " is not available")
        return [list]
    }
    const query = find(LIST)
        .condition("ownerPartyId", "in", context.organizationPartyIds)
        .condition("contactListTypeEnumId", "not-equals", "MAILBOX")
    tooMany(query.count(), limits.lists, "lists")
    return Array.from(query.orderBy("contactListName").list())
}
function audienceGrowth(p) {
    const context = reportScope(p)
    const period = periodOf(p)
    const lists = listsOf(context, p)
    const listRows = []
    const reasons = new Map()
    const closingParties = new Set()
    let withdrawalTotal = 0
    for (const list of lists) {
        const consentQuery = () =>
            find(CONSENT, {contactListId: list.contactListId}).condition("consentDate", "less", period.thru)
        tooMany(
            consentQuery().count(),
            limits.consents,
            "consent records of list " + (list.contactListName || list.contactListId)
        )
        const consents = Array.from(
            consentQuery()
                .selectField("partyConsentId")
                .selectField("partyId")
                .selectField("statusId")
                .selectField("consentDate")
                .selectField("comments")
                .orderBy("consentDate")
                .list()
        )
        // the grants a list merge carried are a movement, not an acquisition
        const merged = new Set(
            Array.from(
                find(REQUEST, {contactListId: list.contactListId, requestKindEnumId: "SrkMerge", statusEnumId: "SrsAccepted"})
                    .selectField("partyConsentId")
                    .list()
            )
                .map(row => row.partyConsentId)
                .filter(Boolean)
        )
        const opening = new Map()
        const closing = new Map()
        let grants = 0,
            mergedIn = 0,
            withdrawals = 0
        for (const consent of consents) {
            const at = ms(consent.consentDate)
            if (at < ms(period.from)) opening.set(consent.partyId, consent.statusId)
            closing.set(consent.partyId, consent.statusId)
            if (at >= ms(period.from)) {
                if (consent.statusId === "PconGranted") {
                    if (merged.has(consent.partyConsentId)) mergedIn++
                    else grants++
                } else if (consent.statusId === "PconWithdrawn") {
                    withdrawals++
                    const reason = text(consent.comments) || ec.l10n.localize("No reason given")
                    const key = list.contactListId + "|" + reason
                    const entry = reasons.get(key) || {
                        contactListId: list.contactListId,
                        listName: list.contactListName || list.contactListId,
                        reason,
                        count: 0
                    }
                    entry.count++
                    reasons.set(key, entry)
                }
            }
        }
        const countGranted = map => Array.from(map.values()).filter(statusId => statusId === "PconGranted").length
        for (const [partyId, statusId] of closing) if (statusId === "PconGranted") closingParties.add(partyId)
        withdrawalTotal += withdrawals
        const pending = find(REQUEST, {contactListId: list.contactListId, statusEnumId: "SrsPending"})
            .condition("requestedDate", "less", period.thru)
            .count()
        const expired = find(REQUEST, {contactListId: list.contactListId, statusEnumId: "SrsPending"})
            .condition("expireDate", "greater-equals", period.from)
            .condition("expireDate", "less", period.thru)
            .count()
        const membersNow = find(LIST_PARTY, {contactListId: list.contactListId, statusId: "CLPT_ACCEPTED"})
            .condition("thruDate", "is-null", null)
            .count()
        listRows.push({
            contactListId: list.contactListId,
            listName: list.contactListName || list.contactListId,
            openingCount: countGranted(opening),
            grantCount: grants,
            mergedCount: mergedIn,
            withdrawalCount: withdrawals,
            expiredCount: expired,
            closingCount: countGranted(closing),
            pendingCount: pending,
            membersNowCount: membersNow
        })
    }
    const reasonRows = Array.from(reasons.values())
        .map(entry => Object.assign(entry, {sharePercent: percentOf(entry.count, withdrawalTotal)}))
        .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason))
    // suppression is a measure apart: the organization's and every organization's blocks in force at the end
    const cf = ec.entity.conditionFactory
    const suppressedCount = find(SUPPRESSION)
        .condition(
            cf.makeCondition(
                [
                    cf.makeCondition("organizationPartyId", "in", context.organizationPartyIds),
                    cf.makeCondition("organizationPartyId", "is-null", null)
                ],
                "or"
            )
        )
        .condition("fromDate", "less", period.thru)
        .condition(
            cf.makeCondition(
                [cf.makeCondition("thruDate", "is-null", null), cf.makeCondition("thruDate", "greater-equals", period.thru)],
                "or"
            )
        )
        .count()
    return Object.assign(
        {
            listRows,
            reasonRows,
            reachCount: closingParties.size,
            suppressedCount,
            fromText: period.fromText,
            thruText: period.thruText,
            basis: "Each list's evidenced consent records: opening and closing are the people whose latest record before the boundary is a grant; grants and withdrawals in the period, a list merge's carried grants apart (a movement); pending requests are not subscribers; members now are the accepted memberships today. Reach counts a person once across the lists; suppressions are a measure apart."
        },
        asOf()
    )
}

// ===== get#Attribution (design §11 Attribution) =====
// Whether the caller may see one order: in Sales (SalesAccess orderOf) or as the store's order reader in Commerce.
function orderReader() {
    const cache = new Map()
    let salesScope = null
    let storeAdmin = null,
        storeScope = null
    const commerce = lib.access.has("COMMERCE_VIEW") && lib.access.has("COMMERCE_ORDER_VIEW")
    return orderId => {
        if (cache.has(orderId)) return cache.get(orderId)
        let readable = false
        try {
            salesScope = salesScope || salesAccess().scope()
            readable = !!salesAccess().orderOf(salesScope, orderId)
        } catch (error) {
            ec.message.clearErrors()
        }
        if (!readable && commerce) {
            const order = one("mantle.order.OrderHeader", {orderId})
            if (order?.productStoreId)
                try {
                    storeAdmin = storeAdmin || ec.resource.script("component://mr-mantle/service/mantle/product/StoreAdmin.js")
                    storeScope = storeScope || storeAdmin.scope()
                    storeAdmin.storeOf(storeScope, order.productStoreId)
                    readable = true
                } catch (error) {
                    ec.message.clearErrors()
                }
        }
        cache.set(orderId, readable)
        return readable
    }
}
const basisTexts = {
    MobTrackingEvent: "Tracking event",
    MobOpportunity: "Source opportunity",
    MobStaff: "Staff correction",
    MobNone: "Unattributed"
}
function attribution(p) {
    const context = reportScope(p)
    const period = periodOf(p)
    let campaignIds = null
    if (!blank(p.marketingCampaignId)) {
        const campaign = campaignOf(context, p.marketingCampaignId)
        campaignIds =
            p.includeChildren === true || p.includeChildren === "true" ? familyOf(campaign) : [campaign.marketingCampaignId]
    }
    const decisions = decisionsOf(context.organizationPartyIds, period, campaignIds)
    const amounts = orderAmounts(decisions.map(row => row.orderId))
    const campaigns = new Map()
    for (const part of slices(unique(decisions.map(row => row.marketingCampaignId))))
        for (const campaign of Array.from(find(CAMPAIGN).condition("marketingCampaignId", "in", part).list()))
            campaigns.set(campaign.marketingCampaignId, campaign)
    // the summary by campaign (unattributed as its own row), each order once, by currency
    const groups = new Map()
    for (const decision of decisions) {
        const key = decision.marketingCampaignId || ""
        const group = groups.get(key) || []
        group.push(decision.orderId)
        groups.set(key, group)
    }
    const readable = orderReader()
    const summaryRows = Array.from(groups.entries()).map(([marketingCampaignId, orderIds]) => {
        const currencies = byCurrency(orderIds, amounts, readable)
        const campaign = campaigns.get(marketingCampaignId)
        return {
            marketingCampaignId: marketingCampaignId || null,
            campaignName: marketingCampaignId ? campaign?.campaignName || marketingCampaignId : ec.l10n.localize("Unattributed"),
            orderCount: orderIds.length,
            amounts: currencies,
            orderValueText: amountsText(amountsOf(currencies, "orderValue")),
            invoicedText: amountsText(amountsOf(currencies, "invoiced")),
            returnedText: amountsText(amountsOf(currencies, "returned")),
            netText: amountsText(amountsOf(currencies, "net"))
        }
    })
    summaryRows.sort(
        (a, b) =>
            (a.marketingCampaignId ? 0 : 1) - (b.marketingCampaignId ? 0 : 1) || a.campaignName.localeCompare(b.campaignName)
    )
    // the leads of the period by their primary campaign (Sales' capture), counts only
    const leadCounts = new Map()
    const leadQuery = find(OPPORTUNITY)
        .condition("organizationPartyId", "in", context.organizationPartyIds)
        .condition("marketingCampaignId", "is-not-null", null)
        .condition("createdDate", "greater-equals", period.from)
        .condition("createdDate", "less", period.thru)
    for (const lead of Array.from(
        leadQuery.selectField("marketingCampaignId").selectField("convertedDate").limit(limits.distinct).list()
    )) {
        if (campaignIds && !campaignIds.includes(lead.marketingCampaignId)) continue
        const entry = leadCounts.get(lead.marketingCampaignId) || {leadCount: 0, qualifiedCount: 0}
        entry.leadCount++
        if (lead.convertedDate) entry.qualifiedCount++
        leadCounts.set(lead.marketingCampaignId, entry)
    }
    for (const row of summaryRows)
        Object.assign(row, leadCounts.get(row.marketingCampaignId) || {leadCount: 0, qualifiedCount: 0})
    // each order's own row only for a reader who may see the order (and, being here, its campaign); the rest counted
    const outcomeRows = []
    let hiddenCount = 0
    for (const decision of decisions) {
        if (outcomeRows.length >= 200 || !readable(decision.orderId)) {
            hiddenCount++
            continue
        }
        const amount = amounts.get(decision.orderId) || {}
        const campaign = campaigns.get(decision.marketingCampaignId)
        outcomeRows.push({
            outcomeLinkId: decision.outcomeLinkId,
            orderId: decision.orderId,
            placedText: lib.dateText(decision.placedDate),
            marketingCampaignId: decision.marketingCampaignId || null,
            campaignName: decision.marketingCampaignId
                ? campaign?.campaignName || decision.marketingCampaignId
                : ec.l10n.localize("Unattributed"),
            basisText: ec.l10n.localize(basisTexts[decision.basisEnumId] || decision.basisEnumId),
            evidenceText: lib.dateText(decision.evidenceDate),
            reason: decision.reason || "",
            currencyUomId: amount.currencyUomId || null,
            orderValueText: amount.currencyUomId ? moneyText(amount.grandTotal, amount.currencyUomId) : "",
            netText: amount.currencyUomId ? moneyText(amount.invoiced - amount.returned, amount.currencyUomId) : ""
        })
    }
    return Object.assign(
        {
            summaryRows,
            outcomeRows,
            hiddenCount,
            orderCount: decisions.length,
            unattributedCount: decisions.filter(row => !row.marketingCampaignId).length,
            fromText: period.fromText,
            thruText: period.thruText,
            basis: "Placed sales orders of the period, each once by its primary campaign (the most recent eligible consented tracking event within the link's lifetime, else the source opportunity's campaign, or a staff correction); value, invoiced, returns and net by currency, never summed across currencies; leads by their primary campaign at capture. An order is listed only for a reader who may see it.",
            attribution: watermarkOf("attribution")
        },
        asOf()
    )
}

// ===== get#TrackingLinkResults =====
function trackingLinkResults(p) {
    const context = reportScope(p)
    const period = periodOf(p)
    let links
    if (!blank(p.trackingCodeId)) {
        const link = one(CODE, {trackingCodeId: text(p.trackingCodeId)})
        if (!link || !context.organizationPartyIds.includes(link.organizationPartyId))
            denied("RECORD_UNAVAILABLE", "Tracking link " + text(p.trackingCodeId) + " is not available")
        links = [link]
    } else {
        let query = find(CODE).condition("organizationPartyId", "in", context.organizationPartyIds)
        if (!blank(p.marketingCampaignId))
            query = query.condition("marketingCampaignId", campaignOf(context, p.marketingCampaignId).marketingCampaignId)
        tooMany(query.count(), limits.links, "tracking links")
        links = Array.from(query.orderBy("description").list())
    }
    const readable = orderReader()
    const linkRows = links.map(link => {
        const base = () =>
            find(EVENT, {trackingCodeId: link.trackingCodeId})
                .condition("eventDate", "greater-equals", period.from)
                .condition("eventDate", "less", period.thru)
        const human = () => base().condition("automated", "is-null", null)
        const decisions = Array.from(
            find(LINK, {trackingCodeId: link.trackingCodeId})
                .condition("thruDate", "is-null", null)
                .condition("placedDate", "greater-equals", period.from)
                .condition("placedDate", "less", period.thru)
                .selectField("orderId")
                .limit(limits.orders)
                .list()
        ).map(row => row.orderId)
        const currencies = byCurrency(decisions, orderAmounts(decisions), readable)
        return {
            trackingCodeId: link.trackingCodeId,
            description: link.description || link.publicCode || link.trackingCodeId,
            marketingCampaignId: link.marketingCampaignId || null,
            clickCount: human().condition("eventKindEnumId", "MteClick").count(),
            pageVisitCount: human().condition("eventKindEnumId", "MteVisit").count(),
            visitorCount: visitCount(() => human().condition("eventKindEnumId", "in", engagementKinds)),
            recipientCount: Array.from(
                human()
                    .condition("campaignRecipientId", "is-not-null", null)
                    .selectField("campaignRecipientId")
                    .distinct(true)
                    .limit(limits.distinct)
                    .list()
            ).length,
            automatedCount: base().condition("automated", "Y").count(),
            orderCount: decisions.length,
            orderValueText: amountsText(amountsOf(currencies, "orderValue"))
        }
    })
    return Object.assign({linkRows, fromText: period.fromText, thruText: period.thruText}, asOf())
}

// ===== count#Visits and count#SalesVisits (Marketing.Visits; Sales' PipelineAnalysis funnel, impl-sales P19) =====
// The organization's visits in [fromDate, thruDate): the distinct visitor keys of its non-automated link clicks and page visits plus
// each such event with no key; of one campaign, or of the links whose UTM source (and medium) Sales maps to the lead source now. A
// Marketing reader or a Sales report reader of the organization (counts only).
function countVisits(p) {
    const organizationPartyId = text(p.organizationPartyId)
    if (!organizationPartyId) denied("ORGANIZATION_REQUIRED", "Name the organization whose visits to count")
    const marketing = marketingAccess.scope()
    let allowed = marketing.capabilities.anyRead && marketingAccess.covers(marketing, organizationPartyId)
    if (!allowed) {
        const sales = salesAccess().scope()
        allowed = !!sales.capabilities.reportRead && salesAccess().covers(sales, organizationPartyId)
    }
    if (!allowed) denied("ORGANIZATION_DENIED", "Organization " + organizationPartyId + " is not available")
    let codeIds = null
    if (!blank(p.dataSourceId)) {
        const maps = Array.from(
            find("mantle.sales.opportunity.SalesLeadSourceMap", {organizationPartyId, dataSourceId: text(p.dataSourceId)})
                .conditionDate("fromDate", "thruDate", ec.user.nowTimestamp)
                .list()
        )
        if (!maps.length) return {visitCount: 0}
        const links = Array.from(
            find(CODE, {organizationPartyId})
                .condition("utmSource", "in", unique(maps.map(row => row.utmSource)))
                .list()
        )
        codeIds = links
            .filter(link =>
                maps.some(map => map.utmSource === link.utmSource && (blank(map.utmMedium) || map.utmMedium === link.utmMedium))
            )
            .map(link => link.trackingCodeId)
        if (!codeIds.length) return {visitCount: 0}
    }
    const base = () => {
        let query = find(EVENT, {organizationPartyId})
            .condition("eventKindEnumId", "in", engagementKinds)
            .condition("automated", "is-null", null)
            .condition("trackingCodeId", "is-not-null", null)
        if (p.fromDate) query = query.condition("eventDate", "greater-equals", p.fromDate)
        if (p.thruDate) query = query.condition("eventDate", "less", p.thruDate)
        if (!blank(p.marketingCampaignId)) query = query.condition("marketingCampaignId", text(p.marketingCampaignId))
        if (codeIds) query = query.condition("trackingCodeId", "in", codeIds.slice(0, 1000))
        return query
    }
    return {visitCount: visitCount(base)}
}

// ===== count#StoreConversions (Commerce's Online sales, impl-commerce §7) =====
// The store orders placed in [fromDate, thruDate) with a campaign as their primary attribution, by currency, for stores of the caller
// (Commerce's store scope: RECORD_UNAVAILABLE otherwise).
function countStoreConversions(p) {
    const storeAdmin = ec.resource.script("component://mr-mantle/service/mantle/product/StoreAdmin.js")
    const storeScope = storeAdmin.scope()
    const storeIds = unique(Array.from(p.productStoreIds || []).map(text)).slice(0, 200)
    for (const productStoreId of storeIds) {
        try {
            storeAdmin.storeOf(storeScope, productStoreId)
        } catch (error) {
            ec.message.clearErrors()
            denied("RECORD_UNAVAILABLE", "Store " + productStoreId + " is not available")
        }
    }
    if (!storeIds.length) return {orderCount: 0, attributedCount: 0, amounts: []}
    let query = find("mantle.order.OrderHeader")
        .condition("productStoreId", "in", storeIds)
        .condition("placedDate", "is-not-null", null)
    if (p.fromDate) query = query.condition("placedDate", "greater-equals", p.fromDate)
    if (p.thruDate) query = query.condition("placedDate", "less", p.thruDate)
    tooMany(query.count(), limits.recipients, "orders")
    const orderIds = Array.from(query.selectField("orderId").list()).map(row => row.orderId)
    const attributed = []
    for (const part of slices(orderIds))
        for (const link of Array.from(
            find(LINK)
                .condition("orderId", "in", part)
                .condition("thruDate", "is-null", null)
                .condition("marketingCampaignId", "is-not-null", null)
                .selectField("orderId")
                .list()
        ))
            attributed.push(link.orderId)
    const currencies = byCurrency(attributed, orderAmounts(attributed))
    return {
        orderCount: orderIds.length,
        attributedCount: attributed.length,
        amounts: amountsOf(currencies, "orderValue"),
        amountsText: amountsText(amountsOf(currencies, "orderValue"))
    }
}

// ===== get#ReportCatalog (design §11 Reports; Insights' catalogue service, impl-insights §7) =====
const reportEntries = [
    {
        entryId: "Marketing.CampaignPerformance",
        title: "Campaign performance",
        description:
            "Each campaign's budget and cost, reach, accepted sends, visits, leads, orders and invoiced net by currency.",
        path: "Reports/CampaignPerformance",
        parameters: "organization, period, campaign, include children"
    },
    {
        entryId: "Marketing.DeliveryAnalysis",
        title: "Delivery analysis",
        description:
            "The sends of a period: accepted, delivered, failed, uncertain, bounces and complaints, opens and clicks with their denominators.",
        path: "Reports/DeliveryAnalysis",
        parameters: "organization, period, campaign, send, channel, sending profile"
    },
    {
        entryId: "Marketing.AudienceGrowth",
        title: "Audience growth",
        description: "Each list's opening and closing subscribers, grants, withdrawals and expiries, and why people leave.",
        path: "Reports/AudienceGrowth",
        parameters: "organization, period, list"
    },
    {
        entryId: "Marketing.Attribution",
        title: "Attribution",
        description: "Placed orders and leads by their primary campaign, value and invoiced net by currency, unattributed apart.",
        path: "Reports/Attribution",
        parameters: "organization, period, campaign"
    }
]
function reportCatalog(p) {
    const appRoot = text(p.appRoot) || "Marketing"
    if (appRoot !== "Marketing") denied("REPORTS_UNAVAILABLE", "Marketing's reports are not available under " + appRoot)
    const userScope = marketingAccess.scope()
    marketingAccess.requireCapability(userScope, "reportRead")
    return {
        reports: reportEntries.map(entry =>
            Object.assign({reportId: entry.path.split("/").pop(), ownerApp: "Marketing", exports: true}, entry)
        )
    }
}

// ===== get#ReportRowFilter (the report engine's row filter of Marketing's datasets; ReportScopePolicy MantleMarketingScope) =====
const nothing = () => ({bool: {none: [{match_all: {}}]}})
function reportRowFilter(p) {
    if (!ec.user.userId) return {filter: nothing()}
    if (text(p.userId) && text(p.userId) !== ec.user.userId)
        denied("PERMISSION_DENIED", "The marketing row filter is computed for the signed-in user only")
    const field = text(p.rowFilterParameters?.organizationField) || "organizationPartyId"
    if (!/^[A-Za-z][A-Za-z0-9_.]{0,63}$/.test(field)) denied("PARAMETER_INVALID", "The organization field is not a field name")
    const userScope = marketingAccess.scope()
    if (!userScope.capabilities.reportRead) return {filter: nothing()}
    const organizationPartyIds = marketingAccess.organizationIds(userScope)
    if (!organizationPartyIds.length) return {filter: nothing()}
    return {filter: {bool: {all: [{field: {name: field, op: "in", values: organizationPartyIds}}]}}}
}

// ===== get#AttentionCounts (Insights' attention providers) =====
// The caller's organizations' sends awaiting approval, failed and uncertain campaign deliveries of the last 30 days and registrations
// held for payment or review, counts only; a Marketing reader.
function attentionCounts(p) {
    const userScope = marketingAccess.scope()
    marketingAccess.requireCapability(userScope, "anyRead")
    const organizationPartyId = text(p.organizationPartyId)
    if (organizationPartyId) marketingAccess.requireOrganization(userScope, organizationPartyId)
    const organizationPartyIds = organizationPartyId ? [organizationPartyId] : marketingAccess.organizationIds(userScope)
    if (!organizationPartyIds.length)
        return {counts: {sendsAwaitingApproval: 0, failedDeliveries: 0, uncertainDeliveries: 0, heldRegistrations: 0}}
    const since = new Date(ms(ec.user.nowTimestamp) - 30 * DAY)
    const deliveries = state =>
        find(DELIVERY, {sourceEnumId: "MdsrcCampaignSend", stateEnumId: state})
            .condition("organizationPartyId", "in", organizationPartyIds)
            .condition("createdDate", "greater-equals", since)
            .count()
    const offerIds = Array.from(
        find("mantle.work.registration.EventRegistrationPolicy")
            .condition("organizationPartyId", "in", organizationPartyIds)
            .selectField("registrationPolicyId")
            .limit(5000)
            .list()
    ).map(row => row.registrationPolicyId)
    let heldRegistrations = 0
    for (const part of slices(offerIds))
        heldRegistrations += find("mantle.work.registration.EventRegistration")
            .condition("registrationPolicyId", "in", part)
            .condition("statusId", "in", ["EvrPending", "EvrReview"])
            .count()
    return {
        counts: {
            sendsAwaitingApproval: find(SEND, {statusId: "CsAwaitingApproval"})
                .condition("organizationPartyId", "in", organizationPartyIds)
                .count(),
            failedDeliveries: deliveries("MdsFailed"),
            uncertainDeliveries: deliveries("MdsUncertain"),
            heldRegistrations
        }
    }
}

// ===== run#MarketingAggregation (the reporting job, design §15.3) =====
// Each campaign's derived summaries, recomputed whole (rebuildable): numSent, its sends' accepted promotional deliveries of all time,
// and qualifiedLeadCount, its leads Sales qualified. The campaigns not closed, and those closed in the last 30 days, the stalest
// first, at most 500 a run; each on its own.
function runMarketingAggregation(p) {
    const since = new Date(ms(ec.user.nowTimestamp) - 30 * DAY)
    const cf = ec.entity.conditionFactory
    const campaigns = Array.from(
        find(CAMPAIGN)
            .condition("organizationPartyId", "is-not-null", null)
            .condition(
                cf.makeCondition(
                    [
                        cf.makeCondition("statusId", "not-in", ["MKTG_CAMP_COMPLETED", "MKTG_CAMP_CANCELLED"]),
                        cf.makeCondition("lastUpdatedStamp", "greater-equals", since)
                    ],
                    "or"
                )
            )
            .orderBy("summaryDate")
            .limit(Math.min(Number(p.maxCampaigns) || 500, 2000))
            .list()
    )
    let itemCount = 0
    const failed = []
    for (const campaign of campaigns) {
        try {
            ec.transaction.runRequireNew(null, "Error summarizing a campaign", () => {
                const sendIds = Array.from(
                    find(SEND, {marketingCampaignId: campaign.marketingCampaignId}).selectField("campaignSendId").list()
                ).map(row => row.campaignSendId)
                let numSent = 0
                for (const campaignSendId of sendIds)
                    numSent += find(DELIVERY, {sourceEnumId: "MdsrcCampaignSend", stateEnumId: "MdsSent"})
                        .condition("eventKey", "like", "CampaignSend:" + campaignSendId + ":%")
                        .count()
                const qualifiedLeadCount = find(OPPORTUNITY, {marketingCampaignId: campaign.marketingCampaignId})
                    .condition("convertedDate", "is-not-null", null)
                    .count()
                find(CAMPAIGN, {marketingCampaignId: campaign.marketingCampaignId}).updateAll({
                    numSent,
                    qualifiedLeadCount,
                    summaryDate: ec.user.nowTimestamp
                })
            })
            itemCount++
        } catch (error) {
            failed.push(campaign.marketingCampaignId)
            ec.logger.error(
                "Campaign " + campaign.marketingCampaignId + " was not summarized: " + String(error.message).split("\n")[0]
            )
        }
    }
    keepWatermark("aggregation", itemCount, failed, "Campaigns not summarized: ")
    return {summarizedCount: itemCount, failedCount: failed.length}
}
function keepWatermark(watermarkKey, itemCount, failed, prefix) {
    try {
        lib.probe("store#" + WATERMARK, {
            watermarkKey,
            watermarkDate: ec.user.nowTimestamp,
            lastRunDate: ec.user.nowTimestamp,
            itemCount,
            failedCount: failed.length,
            lastError: failed.length ? (prefix + failed.join(", ")).slice(0, 255) : null
        })
    } catch (error) {
        ec.logger.error("The " + watermarkKey + " watermark was not kept: " + error.message)
    }
}

// ===== run#MarketingRetention (design §15.3 "Reporting and retention") =====
// Each item on its own transaction; nothing a financial record needs (an event an order's attribution names is kept):
// - an audience import's staged rows past its expiry (its file purged by purge#AudienceImports): the name and masked address of each
//   row cleared, its outcome kept;
// - an unconfirmed public subscription request past its expiry by the grace days: removed with its tokens; a confirmed or decided one
//   is kept;
// - tracking events older than the organization's statisticsRetentionDays (none without the setting);
// - personalized link tokens past their expiry.
const retention = {graceDays: 7, perKind: 500}
function eachOnItsOwn(items, label, action, outcome) {
    for (const item of items) {
        try {
            ec.transaction.runRequireNew(null, "Error in Marketing retention", () => action(item))
            outcome.removedCount++
        } catch (error) {
            outcome.failed.push(label(item))
            ec.logger.error("Marketing retention: " + label(item) + " was not removed: " + String(error.message).split("\n")[0])
        }
    }
}
function runMarketingRetention(p) {
    const now = ms(ec.user.nowTimestamp)
    const outcome = {removedCount: 0, failed: []}
    const max = Math.min(Number(p.maxPerKind) || retention.perKind, 5000)
    // the import rows of purged imports
    const purged = Array.from(
        find("mantle.marketing.contact.AudienceImport")
            .condition("purgedDate", "is-not-null", null)
            .selectField("audienceImportId")
            .limit(max)
            .list()
    ).map(row => row.audienceImportId)
    const items = []
    for (const part of slices(purged))
        for (const item of Array.from(
            find("mantle.marketing.contact.AudienceImportItem")
                .condition("audienceImportId", "in", part)
                .condition(
                    ec.entity.conditionFactory.makeCondition(
                        [
                            ec.entity.conditionFactory.makeCondition("contactName", "is-not-null", null),
                            ec.entity.conditionFactory.makeCondition("addressMasked", "is-not-null", null)
                        ],
                        "or"
                    )
                )
                .limit(max)
                .list()
        ))
            if (items.length < max) items.push(item)
    eachOnItsOwn(
        items,
        item => "import " + item.audienceImportId + " row " + item.rowNumber,
        item =>
            find("mantle.marketing.contact.AudienceImportItem", {
                audienceImportId: item.audienceImportId,
                rowNumber: item.rowNumber
            }).updateAll({
                contactName: null,
                addressMasked: null,
                problemText: null
            }),
        outcome
    )
    // unconfirmed public requests past their expiry and the grace
    const requests = Array.from(
        find(REQUEST, {statusEnumId: "SrsPending"})
            .condition("expireDate", "less", new Date(now - retention.graceDays * DAY))
            .condition("verifiedDate", "is-null", null)
            .limit(max)
            .list()
    )
    eachOnItsOwn(
        requests,
        request => "subscription request " + request.subscriptionRequestId,
        request => {
            if (request.requestGroupId === request.subscriptionRequestId)
                find("mantle.marketing.contact.SubscriptionRequestToken", {requestGroupId: request.requestGroupId}).deleteAll()
            find(REQUEST, {subscriptionRequestId: request.subscriptionRequestId}).deleteAll()
        },
        outcome
    )
    // tracking events past each organization's statistics retention, unless an attribution names them
    const policies = Array.from(
        find("mantle.marketing.campaign.MarketingPolicy").condition("statisticsRetentionDays", "is-not-null", null).list()
    ).filter(policy => lib.active(policy))
    for (const policy of policies) {
        const days = Number(policy.statisticsRetentionDays)
        if (!Number.isFinite(days) || days < 1) continue
        const events = Array.from(
            find(EVENT, {organizationPartyId: policy.organizationPartyId})
                .condition("eventDate", "less", new Date(now - days * DAY))
                .selectField("trackingEventId")
                .limit(max)
                .list()
        ).map(row => row.trackingEventId)
        const named = new Set()
        for (const part of slices(events))
            for (const link of Array.from(
                find(LINK).condition("trackingEventId", "in", part).selectField("trackingEventId").list()
            ))
                named.add(link.trackingEventId)
        eachOnItsOwn(
            events.filter(id => !named.has(id)),
            id => "tracking event " + id,
            id => find(EVENT, {trackingEventId: id}).deleteAll(),
            outcome
        )
    }
    // expired link tokens
    const tokens = Array.from(
        find("mantle.marketing.tracking.MarketingTrackingToken")
            .condition("expireDate", "less", ec.user.nowTimestamp)
            .selectField("tokenHash")
            .limit(max)
            .list()
    ).map(row => row.tokenHash)
    eachOnItsOwn(
        tokens,
        () => "an expired link token",
        tokenHash => find("mantle.marketing.tracking.MarketingTrackingToken", {tokenHash}).deleteAll(),
        outcome
    )
    keepWatermark("retention", outcome.removedCount, outcome.failed, "Not removed: ")
    return {removedCount: outcome.removedCount, failedCount: outcome.failed.length, failedItems: outcome.failed.slice(0, 50)}
}

const operations = {
    reportCatalog,
    campaignPerformance,
    deliveryAnalysis,
    audienceGrowth,
    attribution,
    trackingLinkResults,
    countVisits,
    countStoreConversions,
    reportRowFilter,
    attentionCounts,
    runMarketingAggregation,
    runMarketingRetention
}
;({
    limits,
    // each operation checks its caller (the jobs are the system's) and reads with artifact authorization off
    execute(op, parameters) {
        if (!Object.hasOwn(operations, op)) throw new Error("Unknown marketing report operation " + op)
        const wasDisabled = ec.artifactExecution.disableAuthz()
        try {
            return operations[op](parameters || {})
        } finally {
            if (!wasDisabled) ec.artifactExecution.enableAuthz()
        }
    }
})
