// Marketing's tracking links and capture (mantle.marketing.TrackingServices, K of IronStone Marketing design §14.2; design §8
// TrackingLinks, TrackingLinkDetail, "Capture on the authority", §18 the tracking URL and QR; impl-marketing P15, F31, F55, F79,
// F87). CC0 1.0 Universal plus Grant of Patent License.
//
// - A tracking link is a campaign's TrackingCode, with its organization (the campaign's), the site its public URL is on
//   (https://{canonical host}/trk/{siteId}/{publicCode}, the code random), typed UTM values from the organization's vocabulary and a
//   registered destination: a landing page of the organization's Marketing mount, or an https URL on a host of a site that serves
//   the organization or on the privileged external allowlist (MarketingPolicy trackingDomains, MARKETING_CONFIGURE). A Marketing
//   reader of the organization reads links; MARKETING_CAMPAIGN_EDIT writes them at the revision read. Nothing of a public request
//   ever names a destination: a disabled or ended link answers its safe destination (checked as a destination) or a neutral page.
// - Capture (record#TrackingEvent): an observation of a link (a click), a send's pixel (an open), a page carrying a code (a visit)
//   or a known automated fetch (a link scanner, a prefetch; never a conversion). It keeps the link, the site, the kind, the digest
//   of the visitor's opaque first-party key (only where the organization's policy sets visitor keys, or the visitor is a recipient
//   who allows tracking) and the recipient only for a send's personalized link or pixel of a recipient who allows tracking
//   (PcpTracking), checked again when the event comes. The public operations (resolveTrackingLink, recordTrackingEvent: PASS's
//   web scripts, local or through a remote frontend) are limited per client and code and per site; over a limit nothing is kept
//   and the answer is the same. TrackingCodeVisit is written beside an event when the request has a local visit.
// - A send's message (MarketingDispatch.js build#CampaignDelivery): for a recipient who allows tracking, under a sending profile
//   that tracks consenting recipients, each tracking link of the organization in the body carries the attempt's personalized token
//   (its digest kept, ninety days) and a pixel is added; every other recipient gets each link's direct destination and no pixel.
// Refusals carry reason codes (EntityLib.js denied); the public operations answer NotFound for what they do not serve.
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const marketingAccess = ec.resource.script("component://mr-mantle/service/mantle/marketing/MarketingAccess.js")
const publicApps = () => ec.resource.script("component://mr-mantle/service/mantle/public/PublicApps.js")
const eligibility = () => ec.resource.script("component://mr-mantle/service/mantle/marketing/MarketingEligibility.js")
const {find, one, rows, denied, call, ms} = lib

const TRACKING = "mantle.marketing.tracking.TrackingCode"
const EVENT = "mantle.marketing.tracking.MarketingTrackingEvent"
const TOKEN = "mantle.marketing.tracking.MarketingTrackingToken"
const VISIT = "mantle.marketing.tracking.TrackingCodeVisit"
const CAMPAIGN = "mantle.marketing.campaign.MarketingCampaign"
const VOCABULARY = "mantle.marketing.campaign.MarketingVocabulary"
const RECIPIENT = "mantle.marketing.campaign.CampaignRecipient"
const SEND = "mantle.marketing.campaign.CampaignSend"
const SITE = "mantle.public.PublicSite"
const SITE_APP = "mantle.public.PublicSiteApp"
const SITE_HOST = "mantle.public.PublicSiteHost"
const SITE_PAGE = "mantle.public.PublicSitePage"
const openCampaignStatuses = ["MKTG_CAMP_PLANNED", "MKTG_CAMP_APPROVED", "MKTG_CAMP_INPROGRESS"]
const kinds = {click: "MteClick", open: "MteOpen", visit: "MteVisit"}
const kindTexts = {MteClick: "Click", MteOpen: "Open", MteVisit: "Page visit"}
const destinationTexts = {TdkSitePage: "Landing page", TdkUrl: "Web address"}
const limits = {
    rows: 200,
    url: 2000,
    description: 255,
    domains: 20,
    tokenDays: 90,
    // the public capture: per client and code (or a pixel's site) in ten minutes, per site in an hour
    clientCode: 30,
    site: 20000,
    lookups: 100,
    distinct: 100000
}
const MINUTES_10 = 600000
const HOUR = 3600000
const DAY = 86400000

const text = value => (value == null ? "" : String(value).trim())
const blank = value => text(value) === ""
const yes = value => value === true || value === "Y" || value === "true"
const nowMs = () => ms(ec.user.nowTimestamp)
const fail = (kind, message) => {
    const error = new Error(message)
    error.moquiErrorKind = kind
    throw error
}
const unavailable = () => fail("NotFound", "This link is not available")
const digest = value => String(ec.resource.digestText(String(value), "sha256"))
const userText = userId => (userId ? one("moqui.security.UserAccount", {userId})?.userFullName || userId : "")

// ===== scope =====
function readScope() {
    const userScope = marketingAccess.scope()
    marketingAccess.requireCapability(userScope, "anyRead")
    return userScope
}
function editScope() {
    const userScope = readScope()
    marketingAccess.requireCapability(userScope, "campaignEdit")
    return userScope
}
function campaignOf(userScope, marketingCampaignId) {
    const row = marketingCampaignId ? one(CAMPAIGN, {marketingCampaignId}) : null
    if (!row || !marketingAccess.covers(userScope, row.organizationPartyId))
        denied("RECORD_UNAVAILABLE", "Campaign " + (marketingCampaignId || "") + " is not available")
    return row
}
// A link of the scope (a legacy code of no organization is its campaign's), locked for a write.
function linkOf(userScope, trackingCodeId, lock = false) {
    let query = blank(trackingCodeId) ? null : find(TRACKING, {trackingCodeId: text(trackingCodeId)})
    if (query && lock) query = query.forUpdate(true)
    const row = query ? query.one() : null
    const organizationPartyId = row ? organizationOfLink(row) : null
    if (!row || !marketingAccess.covers(userScope, organizationPartyId))
        denied("RECORD_UNAVAILABLE", "Tracking link " + text(trackingCodeId) + " is not available")
    return row
}
function organizationOfLink(row) {
    if (row.organizationPartyId) return row.organizationPartyId
    return row.marketingCampaignId
        ? one(CAMPAIGN, {marketingCampaignId: row.marketingCampaignId})?.organizationPartyId || null
        : null
}

// ===== sites, hosts and destinations =====
const policyOf = organizationPartyId =>
    ec.resource.script("component://mr-mantle/service/mantle/marketing/MarketingApprovals.js").policyOf(organizationPartyId)
// The organization's privileged external hosts (MarketingPolicy trackingDomains), lower case.
const allowedDomainsOf = organizationPartyId =>
    String(policyOf(organizationPartyId)?.trackingDomains || "")
        .split(/[\s,;]+/)
        .map(domain => domain.trim().toLowerCase())
        .filter(Boolean)
// The sites that serve the organization: an enabled mount targeting it or one of its stores.
function servingSiteIds(organizationPartyId) {
    const storeIds = Array.from(
        find("mantle.product.store.ProductStore", {organizationPartyId}).selectField("productStoreId").limit(500).list()
    ).map(row => row.productStoreId)
    const targets = [organizationPartyId].concat(storeIds)
    return Array.from(
        new Set(
            Array.from(find(SITE_APP, {enabled: "Y"}).condition("targetId", "in", targets).selectField("siteId").list()).map(
                row => row.siteId
            )
        )
    )
}
// The live host names of the sites that serve the organization (a theme preview host is never one).
function siteHostsOf(organizationPartyId) {
    const siteIds = servingSiteIds(organizationPartyId)
    if (!siteIds.length) return []
    return Array.from(find(SITE_HOST).condition("siteId", "in", siteIds).list())
        .filter(row => row.hostKindEnumId !== "PshkPreview")
        .map(row => String(row.hostname).toLowerCase())
}
// The sites whose enabled Marketing mount serves the organization: where a link's public URL may be.
const linkSiteIds = organizationPartyId =>
    Array.from(find(SITE_APP, {app: "marketing", enabled: "Y", targetId: organizationPartyId}).list()).map(row => row.siteId)
const canonicalHostOf = siteId => {
    const host = siteId ? one(SITE_HOST, {siteId, canonical: "Y"}) : null
    return host && host.hostKindEnumId !== "PshkPreview" ? String(host.hostname) : null
}
// A destination URL checked: https, a host of the organization's sites or of the allowlist, no credentials, bounded. The URL as
// stored, or DESTINATION_INVALID / DESTINATION_NOT_REGISTERED.
function checkedUrl(value, organizationPartyId, label = "The destination") {
    const url = text(value)
    if (!url) return null
    if (url.length > limits.url || /[\s\\<>"'`]/.test(url) || /[\u0000-\u001f\u007f]/.test(url))
        denied("DESTINATION_INVALID", label + " is not a web address")
    const match =
        /^https:\/\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*)(?::(\d{1,5}))?(?:[/?#].*)?$/.exec(
            url
        )
    if (!match) denied("DESTINATION_INVALID", label + " must be an https address with no user name")
    const host = match[1].toLowerCase()
    const allowed =
        siteHostsOf(organizationPartyId).includes(host) ||
        allowedDomainsOf(organizationPartyId).some(domain => host === domain || host.endsWith("." + domain))
    if (!allowed)
        denied(
            "DESTINATION_NOT_REGISTERED",
            label + "'s host " + host + " is neither a site of the organization nor on its allowed list"
        )
    return url
}
// A landing page of the organization's Marketing mount, or DESTINATION_INVALID.
function landingPageOf(sitePageId, organizationPartyId) {
    const page = blank(sitePageId) ? null : one(SITE_PAGE, {sitePageId: text(sitePageId)})
    const mount = page?.appMountId ? one(SITE_APP, {siteId: page.siteId, appMountId: page.appMountId}) : null
    if (!page || !mount || mount.app !== "marketing" || mount.targetId !== organizationPartyId)
        denied("DESTINATION_INVALID", "Choose a landing page of the organization's Marketing mount")
    return page
}
const pageLive = (page, at = nowMs()) =>
    !!page?.versionName && (ms(page.fromDate) ?? -Infinity) <= at && (ms(page.thruDate) ?? Infinity) > at
// A link's own destination now (no UTM): a published landing page's address or the registered URL; null when it has none.
function baseDestination(link) {
    if (link.destinationKindEnumId === "TdkSitePage") {
        const page = link.sitePageId ? one(SITE_PAGE, {sitePageId: link.sitePageId}) : null
        if (!pageLive(page) || !page.routePath) return null
        return publicApps().pageUrl(page.siteId, "marketing", "/pages/" + page.routePath)
    }
    return text(link.redirectUrl) || null
}
// The URL with the link's UTM values added (before any fragment).
function withUtm(url, link) {
    if (!url) return null
    const pairs = [
        ["utm_source", link.utmSource],
        ["utm_medium", link.utmMedium],
        ["utm_campaign", link.marketingCampaignId],
        ["utm_content", link.utmContent]
    ].filter(([, value]) => !blank(value))
    if (!pairs.length) return url
    const hash = url.indexOf("#")
    const base = hash >= 0 ? url.slice(0, hash) : url
    const fragment = hash >= 0 ? url.slice(hash) : ""
    const query = pairs.map(([name, value]) => name + "=" + encodeURIComponent(text(value))).join("&")
    return base + (base.includes("?") ? "&" : "?") + query + fragment
}
const linkCurrent = (link, at = nowMs()) =>
    link.disabled !== "Y" && (ms(link.fromDate) ?? -Infinity) <= at && (ms(link.thruDate) ?? Infinity) > at
// Where a link sends a visitor now: its destination with the UTM values while it is current and has one, else its safe destination,
// else null (the neutral page).
function destinationOf(link) {
    const live = linkCurrent(link) ? withUtm(baseDestination(link), link) : null
    return live || text(link.safeUrl) || null
}
const publicUrlOf = link => {
    const host = canonicalHostOf(link.siteId)
    return host && link.publicCode ? "https://" + host + "/trk/" + link.siteId + "/" + link.publicCode : null
}

// ===== the vocabulary =====
// The organization's current value of a kind (a UTM code, a tracking code type), or VALUE_INVALID.
function offered(organizationPartyId, vocabularyKindEnumId, value, field) {
    const given = text(value)
    if (!given) return null
    const current = Array.from(find(VOCABULARY, {organizationPartyId, vocabularyKindEnumId}).list()).filter(row =>
        lib.active(row)
    )
    const match = current.find(
        row => (vocabularyKindEnumId === "MvkTrackingCodeType" ? row.enumId : row.vocabularyCode) === given
    )
    if (!match) denied("VALUE_INVALID", field + " " + given + " is not one the organization offers")
    return given
}

// ===== find#TrackingLinks =====
// The links of the scope's organizations (a campaign's when named), current ones unless includeEnded, a page at a time; each with
// its label and whether it is current (Sales' lead forms read the two), its destination's words, its public URL and its counts.
function findTrackingLinks(p) {
    const userScope = readScope()
    const factory = ec.entity.conditionFactory
    let organizationIds = marketingAccess.organizationIds(userScope)
    let campaign = null
    if (!blank(p.marketingCampaignId)) {
        campaign = campaignOf(userScope, text(p.marketingCampaignId))
        organizationIds = [campaign.organizationPartyId]
    }
    const build = () => {
        let query = find(TRACKING)
        if (campaign) query = query.condition("marketingCampaignId", campaign.marketingCampaignId)
        else query = query.condition("organizationPartyId", "in", organizationIds.length ? organizationIds : ["-"])
        if (!yes(p.includeEnded))
            query = query.condition(
                factory.makeCondition(
                    [
                        factory.makeCondition("thruDate", "is-null", null),
                        factory.makeCondition("thruDate", "greater", ec.user.nowTimestamp)
                    ],
                    "or"
                )
            )
        if (!blank(p.utmSource)) query = query.condition("utmSource", text(p.utmSource))
        if (!blank(p.utmMedium)) query = query.condition("utmMedium", text(p.utmMedium))
        if (!blank(p.trackingCodeTypeEnumId)) query = query.condition("trackingCodeTypeEnumId", text(p.trackingCodeTypeEnumId))
        if (!blank(p.term)) {
            const term = "%" + text(p.term).replace(/[\\%_]/g, c => "\\" + c) + "%"
            query = query.condition(
                factory.makeCondition(
                    [
                        factory.makeCondition("description", "like", term).ignoreCase(),
                        factory.makeCondition("publicCode", "like", term).ignoreCase(),
                        factory.makeCondition("trackingCodeId", "like", term).ignoreCase()
                    ],
                    "or"
                )
            )
        }
        return query
    }
    // a campaign's legacy codes of no organization are its own
    const count = build().count()
    const found = lib.page(build().orderBy("-fromDate").orderBy("trackingCodeId"), p, "trackingLinkRows", count)
    const campaigns = {}
    const clicks = clickTotals(found.rows.map(row => row.trackingCodeId))
    const trackingLinkList = found.rows.map(row => {
        if (!Object.hasOwn(campaigns, row.marketingCampaignId || ""))
            campaigns[row.marketingCampaignId || ""] = row.marketingCampaignId
                ? one(CAMPAIGN, {marketingCampaignId: row.marketingCampaignId})
                : null
        const owner = campaigns[row.marketingCampaignId || ""]
        return Object.assign(linkSummary(row, owner), {clickCount: clicks.get(row.trackingCodeId) || 0})
    })
    return {
        trackingLinkList,
        trackingLinkListCount: count,
        trackingLinkListPageIndex: found.pageIndex,
        trackingLinkListPageSize: found.pageSize,
        trackingLinkListPageMaxIndex: found.pageMaxIndex,
        trackingLinkListPageRangeLow: found.pageRangeLow,
        trackingLinkListPageRangeHigh: found.pageRangeHigh
    }
}
function linkSummary(row, campaign) {
    const current = linkCurrent(row)
    const page =
        row.destinationKindEnumId === "TdkSitePage" && row.sitePageId ? one(SITE_PAGE, {sitePageId: row.sitePageId}) : null
    return {
        trackingCodeId: row.trackingCodeId,
        label: row.description || row.trackingCodeId,
        current,
        stateText:
            row.disabled === "Y" ? "Disabled" : current ? "Active" : (ms(row.fromDate) ?? 0) > nowMs() ? "Not yet" : "Ended",
        stateColor: current ? "positive" : "grey-8",
        marketingCampaignId: row.marketingCampaignId || null,
        campaignName: campaign?.campaignName || row.marketingCampaignId || "",
        organizationPartyId: row.organizationPartyId || campaign?.organizationPartyId || null,
        destinationKindEnumId: row.destinationKindEnumId || (row.redirectUrl ? "TdkUrl" : null),
        destinationText: page
            ? destinationTexts.TdkSitePage + ": " + (page.routePath ? "pages/" + page.routePath : page.sitePageId)
            : text(row.redirectUrl),
        publicUrl: publicUrlOf(row) || "",
        utmText: [row.utmSource, row.utmMedium, row.utmContent].filter(Boolean).join(" / "),
        fromDateText: lib.dateText(row.fromDate),
        thruDateText: lib.dateText(row.thruDate)
    }
}
// Non-automated clicks by link.
function clickTotals(trackingCodeIds) {
    const totals = new Map()
    if (!trackingCodeIds.length) return totals
    for (const trackingCodeId of trackingCodeIds)
        totals.set(
            trackingCodeId,
            find(EVENT, {trackingCodeId, eventKindEnumId: "MteClick"}).condition("automated", "is-null", null).count()
        )
    return totals
}

// ===== get#TrackingLink =====
// A link of the scope with its public URL, its QR code's text (the built barcode helper), its campaign, destination and UTM values,
// what the caller may do, and its observations for a reader of reports or an author (aggregates only).
function getTrackingLink(p) {
    const userScope = readScope()
    const row = linkOf(userScope, p.trackingCodeId)
    const campaign = row.marketingCampaignId ? one(CAMPAIGN, {marketingCampaignId: row.marketingCampaignId}) : null
    const summary = linkSummary(row, campaign)
    const caps = userScope.capabilities
    let qrSvg = null
    if (summary.publicUrl)
        try {
            qrSvg = String(ec.resource.barcodeSvg("QR", summary.publicUrl, {}))
        } catch (error) {
            ec.logger.warn("The QR code of tracking link " + row.trackingCodeId + " was not made: " + error.message)
        }
    const page = row.sitePageId ? one(SITE_PAGE, {sitePageId: row.sitePageId}) : null
    return {
        trackingLink: Object.assign(summary, {
            description: row.description || "",
            comments: row.comments || "",
            siteId: row.siteId || null,
            siteName: row.siteId ? one(SITE, {siteId: row.siteId})?.name || row.siteId : "",
            sitePageId: row.sitePageId || null,
            pageText: page ? page.title || page.routePath || page.sitePageId : "",
            redirectUrl: row.redirectUrl || "",
            safeUrl: row.safeUrl || "",
            destinationNow: destinationOf(row) || "",
            trackingCodeTypeEnumId: row.trackingCodeTypeEnumId || null,
            utmSource: row.utmSource || "",
            utmMedium: row.utmMedium || "",
            utmContent: row.utmContent || "",
            disabled: row.disabled === "Y" ? "Y" : "N",
            trackableLifetime: row.trackableLifetime,
            fromDate: row.fromDate,
            thruDate: row.thruDate,
            createdByText: userText(row.createdByUserId),
            revision: ms(row.lastUpdatedStamp)
        }),
        qrSvg,
        observations: caps.reportRead || caps.campaignEdit ? observationsOf(row, p) : null,
        capabilities: {
            canEdit:
                !!caps.campaignEdit &&
                (!campaign || openCampaignStatuses.includes(campaign.statusId)) &&
                !!row.organizationPartyId,
            canSeeObservations: !!(caps.reportRead || caps.campaignEdit)
        }
    }
}
// A link's aggregates over all its events and the last days (30 by default): clicks, page visits, distinct visitors by key, the
// events with no key (not counted as distinct), the recipients who clicked, and the automated fetches set apart.
function observationsOf(link, p) {
    const days = Math.min(366, Math.max(1, Number(p.periodDays) || 30))
    const since = new Date(nowMs() - days * DAY)
    const measure = from => {
        const base = () => {
            let query = find(EVENT, {trackingCodeId: link.trackingCodeId})
            if (from) query = query.condition("eventDate", "greater-equals", from)
            return query
        }
        const human = () => base().condition("automated", "is-null", null)
        const keyed = Array.from(
            human()
                .condition("visitorKeyHash", "is-not-null", null)
                .selectField("visitorKeyHash")
                .distinct(true)
                .limit(limits.distinct)
                .list()
        ).length
        const events = human().count()
        const keyless = human().condition("visitorKeyHash", "is-null", null).count()
        return {
            clicks: human().condition("eventKindEnumId", "MteClick").count(),
            visits: human().condition("eventKindEnumId", "MteVisit").count(),
            visitors: keyed + keyless,
            keyedVisitors: keyed,
            keylessEvents: keyless,
            recipients: Array.from(
                human()
                    .condition("campaignRecipientId", "is-not-null", null)
                    .selectField("campaignRecipientId")
                    .distinct(true)
                    .limit(limits.distinct)
                    .list()
            ).length,
            automated: base().condition("automated", "Y").count(),
            coverageText: events ? events - keyless + " of " + events + " with a visitor key" : "None yet"
        }
    }
    return {periodDays: days, period: measure(since), total: measure(null)}
}

// ===== store#TrackingLink =====
// A new link of an open campaign (marketingCampaignId) or a change of one at the revision read (expectedRevision, its
// lastUpdatedStamp), MARKETING_CAMPAIGN_EDIT in the campaign's organization: its description, site, destination (a landing page of
// the organization's Marketing mount, or an https URL of its sites or allowlist), safe destination, type and UTM values (the
// organization's vocabulary), dates and disabled flag. The public code is made once and never changes.
function storeTrackingLink(p) {
    const userScope = editScope()
    const existing = blank(p.trackingCodeId) ? null : linkOf(userScope, p.trackingCodeId, true)
    const campaign = campaignOf(userScope, existing ? existing.marketingCampaignId : text(p.marketingCampaignId))
    if (!openCampaignStatuses.includes(campaign.statusId))
        denied("STATUS_INVALID", "Campaign " + campaign.marketingCampaignId + " is closed")
    const organizationPartyId = campaign.organizationPartyId
    if (existing) {
        if (!existing.organizationPartyId)
            denied("RECORD_UNAVAILABLE", "Tracking link " + existing.trackingCodeId + " is a legacy code and is read only")
        if (
            p.expectedRevision == null ||
            p.expectedRevision === "" ||
            Number(p.expectedRevision) !== ms(existing.lastUpdatedStamp)
        )
            denied("STALE_REVISION", "Tracking link " + existing.trackingCodeId + " changed since you read it; review it again")
    }
    const given = name => p[name] !== undefined && p[name] !== null
    const value = name => (given(name) ? p[name] : existing ? existing[name] : null)
    const description = text(value("description"))
    if (!description) denied("VALUE_REQUIRED", "Describe the link")
    if (description.length > limits.description) denied("VALUE_INVALID", "The description is too long")
    const siteId = text(value("siteId")) || linkSiteIds(organizationPartyId)[0] || ""
    if (!siteId || !linkSiteIds(organizationPartyId).includes(siteId))
        denied("SITE_INVALID", "Choose a site whose Marketing mount serves the organization")
    if (!canonicalHostOf(siteId)) denied("SITE_INVALID", "Site " + siteId + " has no canonical host for the link's address")
    const kind = text(value("destinationKindEnumId")) || (!blank(value("sitePageId")) ? "TdkSitePage" : "TdkUrl")
    if (!Object.hasOwn(destinationTexts, kind)) denied("VALUE_INVALID", "A destination is a landing page or a web address")
    let sitePageId = null,
        redirectUrl = null
    if (kind === "TdkSitePage") sitePageId = landingPageOf(value("sitePageId"), organizationPartyId).sitePageId
    else {
        redirectUrl = checkedUrl(value("redirectUrl"), organizationPartyId)
        if (!redirectUrl) denied("VALUE_REQUIRED", "Give the destination's address")
    }
    const safeUrl = checkedUrl(value("safeUrl"), organizationPartyId, "The safe destination")
    const fromDate = value("fromDate") || ec.user.nowTimestamp
    const thruDate = value("thruDate") || null
    if (thruDate && ms(thruDate) <= ms(fromDate)) denied("DATE_INVALID", "The link must end after it starts")
    const lifetime =
        given("trackableLifetime") && p.trackableLifetime !== ""
            ? Number(p.trackableLifetime)
            : (existing?.trackableLifetime ?? null)
    if (lifetime != null && (!Number.isInteger(lifetime) || lifetime < 0 || lifetime > 3650))
        denied("NUMBER_INVALID", "The trackable lifetime is a number of days")
    const values = {
        description,
        comments: text(value("comments")).slice(0, 255) || null,
        siteId,
        destinationKindEnumId: kind,
        sitePageId,
        redirectUrl,
        safeUrl,
        trackingCodeTypeEnumId: offered(organizationPartyId, "MvkTrackingCodeType", value("trackingCodeTypeEnumId"), "Type"),
        utmSource: offered(organizationPartyId, "MvkUtmSource", value("utmSource"), "Source"),
        utmMedium: offered(organizationPartyId, "MvkUtmMedium", value("utmMedium"), "Medium"),
        utmContent: offered(organizationPartyId, "MvkUtmContent", value("utmContent"), "Content"),
        disabled: yes(value("disabled")) ? "Y" : "N",
        trackableLifetime: lifetime,
        fromDate,
        thruDate
    }
    if (existing) {
        call("update#" + TRACKING, Object.assign({trackingCodeId: existing.trackingCodeId}, values))
        return {trackingCodeId: existing.trackingCodeId, publicCode: existing.publicCode}
    }
    let publicCode = null
    for (let attempt = 0; attempt < 5 && !publicCode; attempt++) {
        const candidate = ec.user
            .randomString(16)
            .replace(/[^A-Za-z0-9]/g, "")
            .slice(0, 10)
        if (candidate.length === 10 && !one(TRACKING, {publicCode: candidate})) publicCode = candidate
    }
    if (!publicCode) throw new Error("No public code could be made for the link")
    const trackingCodeId = call(
        "create#" + TRACKING,
        Object.assign(values, {
            marketingCampaignId: campaign.marketingCampaignId,
            organizationPartyId,
            publicCode,
            createdByUserId: ec.user.userId
        })
    ).trackingCodeId
    return {trackingCodeId, publicCode}
}

// ===== tracking consent =====
// Whether a party allows tracking (PcpTracking) now within the organization, at the address when one is named.
function trackingAllowed(partyId, contactMechId, organizationPartyId) {
    if (!partyId) return false
    const consents = rows("mantle.party.PartyConsent", {partyId}).sort(
        (a, b) =>
            (ms(b.consentDate) ?? 0) - (ms(a.consentDate) ?? 0) ||
            String(b.partyConsentId).localeCompare(String(a.partyConsentId))
    )
    return eligibility().purposeState(consents, "PcpTracking", contactMechId || null, organizationPartyId).granted
}
// Whether a party has withdrawn tracking (PcpTracking) with the organization: their latest records first, as trackingAllowed reads
// them.
function trackingWithdrawn(partyId, organizationPartyId) {
    if (!partyId) return false
    const consents = rows("mantle.party.PartyConsent", {partyId}).sort(
        (a, b) =>
            (ms(b.consentDate) ?? 0) - (ms(a.consentDate) ?? 0) ||
            String(b.partyConsentId).localeCompare(String(a.partyConsentId))
    )
    return eligibility().purposeState(consents, "PcpTracking", null, organizationPartyId).withdrawn
}
// The digest kept for a visitor key (events' and orders' visitorKeyHash); the raw key is never stored.
const visitorKeyHash = visitorKey => digest("mkt-visitor:" + visitorKey)
// Follow-up 4: whether a visitor key may be kept for an order of the seller: where an event would have kept it (the seller's
// MarketingPolicy visitorKeys Y, or the customer allowing tracking with the seller), never for a customer who has withdrawn tracking
// with the seller.
function visitorKeyAllowed(customerPartyId, organizationPartyId) {
    if (!organizationPartyId) return false
    if (customerPartyId && trackingWithdrawn(customerPartyId, organizationPartyId)) return false
    return (
        policyOf(organizationPartyId)?.visitorKeys === "Y" ||
        (!!customerPartyId && trackingAllowed(customerPartyId, null, organizationPartyId))
    )
}
// The digest a checkout keeps with its order for a frontend's visitor key where it may (visitorKeyAllowed); a key not of the cookie's
// form is dropped. The digest, or null.
function orderVisitorKeyHash(visitorKey, customerPartyId, organizationPartyId) {
    const key = text(visitorKey)
    if (!visitorKeyPattern.test(key) || !visitorKeyAllowed(customerPartyId, organizationPartyId)) return null
    return visitorKeyHash(key)
}
// The digest a checkout's submit keeps with its order (orderVisitorKeyHash) that never fails the submit: a failure of the consent or
// policy read keeps nothing and is logged under the label (never the key). Shop's submit#Checkout and a ticket's
// start#RegistrationPayment (follow-up 5).
function checkoutVisitorKeyHash(visitorKey, customerPartyId, organizationPartyId, label) {
    if (blank(visitorKey) || !organizationPartyId) return null
    try {
        return orderVisitorKeyHash(visitorKey, customerPartyId || null, organizationPartyId)
    } catch (error) {
        ec.message.clearErrors()
        ec.logger.warn(label + " visitor key not kept: " + String(error?.message || error).split("\n")[0])
        return null
    }
}
// The visitor key's digest an order kept stays only while it may (visitorKeyAllowed for its first part's customer and vendor: the
// customer may have withdrawn tracking or the seller's policy changed since the submit), cleared otherwise and when it cannot be
// read (fail closed); called in the placement's transaction before place#Order (Shop's placeStep, a ticket order's placement).
function keepOrderVisitorKey(orderId) {
    const order = orderId ? one("mantle.order.OrderHeader", {orderId}) : null
    if (!order?.marketingVisitorKeyHash) return
    let keep = false
    try {
        const part = Array.from(find("mantle.order.OrderPart", {orderId}).orderBy("orderPartSeqId").limit(1).list())[0]
        keep = !!part && visitorKeyAllowed(part.customerPartyId || null, part.vendorPartyId)
    } catch (error) {
        ec.message.clearErrors()
        ec.logger.warn("Order " + orderId + " visitor key not checked: " + String(error?.message || error).split("\n")[0])
    }
    if (!keep) call("update#mantle.order.OrderHeader", {orderId, marketingVisitorKeyHash: null})
}

// ===== the public operations (PASS's web scripts) =====
const accountScript = () => ec.resource.script("component://framework/service/org/moqui/public/Account.js")
function allowed(key, limit, windowMillis) {
    return !!ec.service
        .sync()
        .throwOnError(true)
        .name("org.moqui.public.AccountServices.record#Attempt")
        .parameters({input: {key, limit, windowMillis}})
        .requireNewTransaction(true)
        .call().result.allowed
}
// A published site, or NotFound.
function publishedSite(siteId) {
    const site = blank(siteId) ? null : one(SITE, {siteId: text(siteId)})
    if (!site || site.state !== "published") unavailable()
    return site
}
const codePattern = /^[A-Za-z0-9]{8,24}$/
const tokenPattern = /^[A-Za-z0-9_-]{24,64}$/
const visitorKeyPattern = /^[A-Za-z0-9_-]{16,64}$/
// A link of the site by its public code, or null.
function linkOfSite(siteId, code) {
    if (!codePattern.test(text(code))) return null
    const link = one(TRACKING, {publicCode: text(code)})
    return link && link.siteId === siteId && link.organizationPartyId ? link : null
}
// A personalized token's recipient of the organization, not expired: {token, recipient, send}, or null.
function tokenOf(value, organizationPartyId) {
    if (!tokenPattern.test(text(value))) return null
    if (!allowed("mkt-trk-token:" + accountScript().requesterKey(), limits.lookups, MINUTES_10)) return null
    const token = one(TOKEN, {tokenHash: digest("mkt-trk:" + text(value))})
    if (!token || (ms(token.expireDate) ?? 0) <= nowMs()) return null
    if (organizationPartyId && token.organizationPartyId !== organizationPartyId) return null
    const recipient = one(RECIPIENT, {campaignRecipientId: token.campaignRecipientId})
    if (!recipient || recipient.tracked !== "Y") return null
    return {token, recipient}
}
// resolveTrackingLink: where a link of the site sends its visitor now (its destination with its UTM values, its safe destination
// when disabled or ended, else none: the neutral page) and whether the visitor key may be set (the organization's policy, or a
// recipient who allows tracking). An unknown code or another site's is NotFound. Reads only.
function resolvePublic(p) {
    publishedSite(p.siteId)
    const link = linkOfSite(text(p.siteId), p.code)
    if (!link) unavailable()
    const personal = blank(p.token) ? null : tokenOf(p.token, link.organizationPartyId)
    const consenting =
        !!personal && trackingAllowed(personal.recipient.partyId, personal.recipient.contactMechId, link.organizationPartyId)
    const destination = destinationOf(link)
    return {
        destination,
        available: linkCurrent(link) && !!baseDestination(link),
        visitorKeys: consenting || policyOf(link.organizationPartyId)?.visitorKeys === "Y"
    }
}
// recordTrackingEvent: one observation of the site (kind click, visit, fetch or visitFetch with the link's code, the last two a known
// automated fetch of the link or of a page carrying it; open or fetch with a personalized token and no code: a send's pixel), with
// the visitor's key where it may be kept and the recipient where they allow tracking. Over the client's limit for the code or the
// site's, an unknown code or token, a link that is not current, or anything else unserved: nothing kept, the same answer.
function recordPublic(p) {
    const kind = text(p.kind)
    if (!["click", "open", "visit", "fetch", "visitFetch"].includes(kind)) unavailable()
    const site = publishedSite(p.siteId)
    const nothing = {recorded: false}
    const subject = blank(p.code) ? "pixel" : text(p.code).slice(0, 24)
    if (
        !allowed("mkt-trk:" + accountScript().requesterKey() + ":" + subject, limits.clientCode, MINUTES_10) ||
        !allowed("mkt-trk-site:" + site.siteId, limits.site, HOUR)
    )
        return nothing
    let link = null,
        organizationPartyId = null
    if (!blank(p.code)) {
        link = linkOfSite(site.siteId, p.code)
        // a disabled, ended or not yet started link counts nothing (its visitor gets the safe destination or the neutral page)
        if (!link || !linkCurrent(link)) return nothing
        organizationPartyId = link.organizationPartyId
    } else {
        // a pixel: the site's Marketing mount names the organization, and a token is required
        const mount = publicApps().mount(site.siteId, "marketing")
        if (!mount?.targetId || blank(p.token) || !["open", "fetch"].includes(kind)) return nothing
        organizationPartyId = mount.targetId
    }
    if (kind === "open" && link) return nothing
    const personal = blank(p.token) ? null : tokenOf(p.token, organizationPartyId)
    if (!link && !personal) return nothing
    const consenting =
        !!personal && trackingAllowed(personal.recipient.partyId, personal.recipient.contactMechId, organizationPartyId)
    const keys = consenting || policyOf(organizationPartyId)?.visitorKeys === "Y"
    const visitorKey = keys && visitorKeyPattern.test(text(p.visitorKey)) ? text(p.visitorKey) : null
    const eventKindEnumId = kind === "visitFetch" ? "MteVisit" : kind === "fetch" ? (link ? "MteClick" : "MteOpen") : kinds[kind]
    recordEvent({
        link,
        organizationPartyId,
        siteId: site.siteId,
        eventKindEnumId,
        automated: kind === "fetch" || kind === "visitFetch",
        visitorKey,
        recipient: consenting ? personal.recipient : null
    })
    return {recorded: true}
}
// One event, and its TrackingCodeVisit when the request has a local visit (a page on the authority itself).
function recordEvent({link, organizationPartyId, siteId, eventKindEnumId, automated, visitorKey, recipient}) {
    const visitId = link && !automated ? localVisitId() : null
    call("create#" + EVENT, {
        trackingCodeId: link?.trackingCodeId || null,
        organizationPartyId,
        marketingCampaignId:
            link?.marketingCampaignId ||
            (recipient ? one(SEND, {campaignSendId: recipient.campaignSendId})?.marketingCampaignId : null) ||
            null,
        siteId,
        eventKindEnumId,
        automated: automated ? "Y" : null,
        visitorKeyHash: visitorKey ? visitorKeyHash(visitorKey) : null,
        campaignRecipientId: recipient?.campaignRecipientId || null,
        campaignSendId: recipient?.campaignSendId || null,
        visitId,
        eventDate: ec.user.nowTimestamp
    })
    if (visitId)
        try {
            call("create#" + VISIT, {
                trackingCodeId: link.trackingCodeId,
                visitId,
                fromDate: ec.user.nowTimestamp,
                sourceEnumId: "TKCDSRC_URL_PARAM"
            })
        } catch (error) {
            ec.message.clearErrors()
            ec.logger.warn("The visit of tracking link " + link.trackingCodeId + " was not recorded: " + error.message)
        }
}
function localVisitId() {
    const visitId = ec.user.visitId ? String(ec.user.visitId) : null
    return visitId && one("moqui.server.Visit", {visitId}) ? visitId : null
}

// ===== a send's message (MarketingDispatch.js build#CampaignDelivery) =====
const linkPattern = /https:\/\/([A-Za-z0-9.-]+)(?::\d{1,5})?\/trk\/([A-Za-z0-9_-]{1,40})\/([A-Za-z0-9]{8,24})(?![A-Za-z0-9?])/g
const encodeHtml = value =>
    String(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
// The body and text of one attempt's message with its tracking: a recipient who allows tracking, under a profile that tracks
// consenting recipients, gets each of the organization's tracking links with the attempt's personalized token and a pixel; anyone
// else each link's direct destination (a link with none keeps its address) and no pixel. {body, bodyText, tracked}.
function messageTracking(row, recipient, profile, body, bodyText) {
    const organizationPartyId = row.organizationPartyId
    const codes = new Set()
    for (const source of [body || "", bodyText || ""]) {
        linkPattern.lastIndex = 0
        let match
        while ((match = linkPattern.exec(source)) !== null) codes.add(match[3])
    }
    const links = new Map()
    if (codes.size)
        for (const link of Array.from(
            find(TRACKING, {organizationPartyId}).condition("publicCode", "in", Array.from(codes)).list()
        ))
            links.set(link.publicCode, link)
    const pixelSite = linkSiteIds(organizationPartyId).find(siteId => canonicalHostOf(siteId)) || null
    const tracked =
        profile?.trackingPolicyEnumId === "MtrConsented" &&
        recipient.tracked === "Y" &&
        trackingAllowed(recipient.partyId, recipient.contactMechId, organizationPartyId)
    let token = null
    if (tracked && (links.size || pixelSite)) {
        token = ec.user
            .randomString(48)
            .replace(/[^A-Za-z0-9_-]/g, "")
            .slice(0, 40)
        call("create#" + TOKEN, {
            tokenHash: digest("mkt-trk:" + token),
            campaignRecipientId: recipient.campaignRecipientId,
            campaignSendId: recipient.campaignSendId,
            organizationPartyId,
            createdDate: ec.user.nowTimestamp,
            expireDate: new Date(nowMs() + limits.tokenDays * DAY)
        })
    }
    // a link's address only on a live host of its own site: a token never rides to a host the author typed
    const hostsOfSite = new Map()
    const siteHost = (siteId, host) => {
        if (!hostsOfSite.has(siteId))
            hostsOfSite.set(
                siteId,
                Array.from(find(SITE_HOST, {siteId}).list())
                    .filter(row => row.hostKindEnumId !== "PshkPreview")
                    .map(row => String(row.hostname).toLowerCase())
            )
        return hostsOfSite.get(siteId).includes(String(host).toLowerCase())
    }
    const rewrite = (source, html) => {
        if (!source || !links.size) return source
        linkPattern.lastIndex = 0
        return source.replace(linkPattern, (url, host, siteId, code) => {
            const link = links.get(code)
            if (!link || link.siteId !== siteId || !siteHost(siteId, host)) return url
            if (token) return url + (html ? "?token=" : "?token=") + token
            const direct = linkCurrent(link) ? withUtm(baseDestination(link), link) : null
            if (!direct) return url
            return html ? encodeHtml(direct) : direct
        })
    }
    let trackedBody = rewrite(body, true)
    if (token && pixelSite && trackedBody)
        trackedBody +=
            '<img src="https://' +
            canonicalHostOf(pixelSite) +
            "/trk-o/" +
            pixelSite +
            "?token=" +
            token +
            '" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0">'
    return {body: trackedBody, bodyText: rewrite(bodyText, false), tracked: !!token}
}
// The recipients' non-automated clicks: Map campaignRecipientId → {clicks, firstDate}.
function recipientClicks(campaignRecipientIds) {
    const found = new Map()
    const ids = Array.from(new Set(campaignRecipientIds.filter(Boolean)))
    for (let at = 0; at < ids.length; at += 500) {
        for (const event of Array.from(
            find(EVENT, {eventKindEnumId: "MteClick"})
                .condition("campaignRecipientId", "in", ids.slice(at, at + 500))
                .condition("automated", "is-null", null)
                .selectField("campaignRecipientId")
                .selectField("eventDate")
                .list()
        )) {
            const entry = found.get(event.campaignRecipientId) || {clicks: 0, firstDate: null}
            entry.clicks += 1
            if (!entry.firstDate || ms(event.eventDate) < ms(entry.firstDate)) entry.firstDate = event.eventDate
            found.set(event.campaignRecipientId, entry)
        }
    }
    return found
}
// How many of the recipients clicked (unique clickers).
const uniqueClickers = campaignRecipientIds => recipientClicks(campaignRecipientIds).size

// ===== count#StoreVisits (Commerce's Home) =====
// The visits of the sites that sell for the stores (an enabled Shop mount of the store) in [fromDate, thruDate): distinct visitor
// keys of the non-automated events, plus each event with no key. Each store must be one of the caller's (Commerce's store scope:
// RECORD_UNAVAILABLE otherwise).
function countStoreVisits(p) {
    const storeAdmin = ec.resource.script("component://mr-mantle/service/mantle/product/StoreAdmin.js")
    const s = storeAdmin.scope()
    const storeIds = Array.from(
        new Set(
            Array.from(p.productStoreIds || [])
                .map(text)
                .filter(Boolean)
        )
    ).slice(0, 200)
    for (const productStoreId of storeIds) {
        try {
            storeAdmin.storeOf(s, productStoreId)
        } catch (error) {
            ec.message.clearErrors()
            denied("RECORD_UNAVAILABLE", "Store " + productStoreId + " is not available")
        }
    }
    const siteIds = storeIds.length
        ? Array.from(
              new Set(
                  Array.from(find(SITE_APP, {app: "shop", enabled: "Y"}).condition("targetId", "in", storeIds).list()).map(
                      row => row.siteId
                  )
              )
          )
        : []
    if (!siteIds.length) return {visitCount: 0, siteCount: 0}
    const base = () => {
        let query = find(EVENT).condition("siteId", "in", siteIds).condition("automated", "is-null", null)
        if (p.fromDate) query = query.condition("eventDate", "greater-equals", p.fromDate)
        if (p.thruDate) query = query.condition("eventDate", "less", p.thruDate)
        return query
    }
    const keyed = Array.from(
        base()
            .condition("visitorKeyHash", "is-not-null", null)
            .selectField("visitorKeyHash")
            .distinct(true)
            .limit(limits.distinct)
            .list()
    ).length
    const keyless = base().condition("visitorKeyHash", "is-null", null).count()
    return {visitCount: keyed + keyless, siteCount: siteIds.length}
}

const operations = {findTrackingLinks, getTrackingLink, storeTrackingLink, resolvePublic, recordPublic, countStoreVisits}
const publicOperations = new Set(["resolvePublic", "recordPublic"])
;({
    limits,
    kindTexts,
    messageTracking,
    recipientClicks,
    uniqueClickers,
    trackingAllowed,
    trackingWithdrawn,
    visitorKeyHash,
    visitorKeyAllowed,
    orderVisitorKeyHash,
    checkoutVisitorKeyHash,
    keepOrderVisitorKey,
    publicUrlOf,
    destinationOf,
    // each operation checks the caller's scope and permission (the public ones the site, the link and their limits) and reads and
    // writes with artifact authorization off; a public operation's unexpected failure is Unavailable, never its own words
    execute(op, parameters) {
        if (!Object.hasOwn(operations, op)) throw new Error("Unknown marketing tracking operation " + op)
        const wasDisabled = ec.artifactExecution.disableAuthz()
        try {
            return operations[op](parameters || {})
        } catch (error) {
            if (!publicOperations.has(op) || error?.moquiErrorKind) throw error
            ec.logger.error("Marketing tracking " + op + " failed: " + String(error?.message || error).split("\n")[0])
            ec.message.clearErrors()
            fail("Unavailable", "This is not available right now")
        } finally {
            if (!wasDisabled) ec.artifactExecution.enableAuthz()
        }
    }
})
