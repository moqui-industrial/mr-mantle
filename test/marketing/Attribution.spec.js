// Marketing's attribution of placed orders (impl-marketing P20; design-marketing §11 Attribution, X10; mantle.marketing.TrackingServices
// record#, correct# and run#OrderAttribution(s) over MarketingAttribution.js): every placed sales order gets one decision, whatever
// placed it (a Shop checkout by its visit and the visitor key that visit carried, a Sales acceptance by its source opportunity, a direct
// order by its customer as a consenting recipient, a ticket); an expired link's event, an automated fetch, a recipient who does not
// allow tracking and an unknown identity attribute nothing; a purchase order is never attributed; an order the SECA's call missed is
// decided once by the job; a later link edit changes no decision, and a staff correction is a successor with its reason.
// Standalone: spec-local organizations, people, campaigns, links, events and orders.
// Run: ./moq test mr-mantle --spec Attribution
const lib = ec.resource.script("component://mr-mantle/test/marketing/MarketingSpecLib.js")
const {make, row, rows, run, system, organization, user, as, campaign} = lib
const K = "mantle.marketing.TrackingServices."
const prefix = "MKAT"
const orgA = prefix + "_ORG_A",
    orgB = prefix + "_ORG_B",
    supplier = prefix + "_SUPPLIER"
const users = {}
const ids = {}
const dayMs = 86400000
const ago = days => new Date(Date.now() - days * dayMs)
const code = out => (/([A-Z][A-Z0-9_]+):/.exec(out.refusal || "") || [])[1] || (out.refusal ? "ERROR" : "")
const current = orderId => rows("mantle.marketing.tracking.MarketingOutcomeLink", {orderId}).filter(link => !link.thruDate)
const all = orderId => rows("mantle.marketing.tracking.MarketingOutcomeLink", {orderId})
// an order placed now (its header and first part), with its customer, purpose, store and visit
function order(suffix, fields) {
    const orderId = prefix + "_" + suffix
    make("mantle.order.OrderHeader", {
        orderId,
        statusId: "OrderPlaced",
        placedDate: ago(0.01),
        entryDate: ago(0.02),
        currencyUomId: "USD",
        grandTotal: fields.grandTotal || 100,
        orderPurposeEnumId: fields.purpose || "OrpSalesOrder",
        productStoreId: fields.productStoreId || null,
        visitId: fields.visitId || null
    })
    make("mantle.order.OrderPart", {
        orderId,
        orderPartSeqId: "01",
        vendorPartyId: fields.vendor || orgA,
        customerPartyId: fields.customer
    })
    return orderId
}
function event(suffix, fields) {
    make(
        "mantle.marketing.tracking.MarketingTrackingEvent",
        Object.assign({trackingEventId: prefix + "_EV_" + suffix, organizationPartyId: orgA, siteId: prefix + "_SITE"}, fields)
    )
}
const placed = orderId => system(() => run(K + "handle#OrderPlaced", {orderId}))

spec({
    setupSpec() {
        system(() => {
            organization(orgA, "Attribution A")
            organization(orgB, "Attribution B")
            make("mantle.party.Party", {partyId: supplier, partyTypeEnumId: "PtyOrganization"})
            make("mantle.party.Organization", {partyId: supplier, organizationName: "A supplier"})
            for (const name of ["ANN", "BEN", "CY", "DEE"]) {
                make("mantle.party.Party", {partyId: prefix + "_" + name, partyTypeEnumId: "PtyPerson"})
                make("mantle.party.Person", {partyId: prefix + "_" + name, firstName: name})
            }
            // Ann allows tracking with A; Ben does not
            make("mantle.party.PartyConsent", {
                partyId: prefix + "_ANN",
                purposeEnumId: "PcpTracking",
                statusId: "PconGranted",
                organizationPartyId: orgA,
                consentDate: ago(30),
                sourceEnumId: "PcsForm"
            })
            users.author = user(prefix, "author", [orgA], ["MARKETING_VIEW", "MARKETING_CAMPAIGN_EDIT"])
            users.authorB = user(prefix, "authorB", [orgB], ["MARKETING_VIEW", "MARKETING_CAMPAIGN_EDIT"])
            users.admin = user(prefix, "admin", [orgA], ["MARKETING_VIEW", "MARKETING_CONFIGURE"])
            users.adminB = user(prefix, "adminB", [orgB], ["MARKETING_VIEW", "MARKETING_CONFIGURE"])
            users.analyst = user(prefix, "analyst", [orgA], ["MARKETING_REPORT_VIEW"])
            for (const visitId of [prefix + "_V1", prefix + "_V2"]) make("moqui.server.Visit", {visitId, fromDate: ago(3)})
        })
        ids.spring = campaign(users.author, orgA, {campaignName: "Spring"})
        ids.summer = campaign(users.author, orgA, {campaignName: "Summer"})
        ids.other = campaign(users.authorB, orgB, {campaignName: "Other"})
        system(() => {
            // L1 (spring, 30 days), L2 (summer, 30 days), L3 (spring, a one-day lifetime)
            for (const [suffix, marketingCampaignId, trackableLifetime] of [
                ["L1", ids.spring, 30],
                ["L2", ids.summer, 30],
                ["L3", ids.spring, 1]
            ])
                make("mantle.marketing.tracking.TrackingCode", {
                    trackingCodeId: prefix + "_" + suffix,
                    marketingCampaignId,
                    organizationPartyId: orgA,
                    trackingCodeTypeEnumId: "EXTERNAL",
                    publicCode: prefix + suffix + "CODE",
                    trackableLifetime
                })
            // a send's recipients: Ann tracked (allows tracking), Ben tracked at preparation (no consent now)
            make("mantle.marketing.campaign.CampaignSend", {
                campaignSendId: prefix + "_SEND",
                marketingCampaignId: ids.spring,
                organizationPartyId: orgA,
                sendName: "Spring news",
                channelEnumId: "MdcEmail"
            })
            for (const name of ["ANN", "BEN"])
                make("mantle.marketing.campaign.CampaignRecipient", {
                    campaignRecipientId: prefix + "_R_" + name,
                    campaignSendId: prefix + "_SEND",
                    partyId: prefix + "_" + name,
                    channelEnumId: "MdcEmail",
                    tracked: "Y",
                    executionKey: prefix + "_EXEC_" + name,
                    statusId: "CrsHandedOff"
                })
            // the Shop visitor: a click with key K1 (no visit: the redirect declines its session), then the landing page in visit V1
            // with the same key, then a scanner's fetch, more recent, set apart
            event("K1CLICK", {
                trackingCodeId: prefix + "_L1",
                marketingCampaignId: ids.spring,
                eventKindEnumId: "MteClick",
                visitorKeyHash: "K1",
                eventDate: ago(3)
            })
            event("K1VISIT", {
                trackingCodeId: prefix + "_L2",
                marketingCampaignId: ids.summer,
                eventKindEnumId: "MteVisit",
                visitorKeyHash: "K1",
                visitId: prefix + "_V1",
                eventDate: ago(1)
            })
            event("SCAN", {
                trackingCodeId: prefix + "_L1",
                marketingCampaignId: ids.spring,
                eventKindEnumId: "MteClick",
                automated: "Y",
                visitId: prefix + "_V1",
                eventDate: ago(0.5)
            })
            // Ann's and Ben's clicks as recipients
            event("ANN", {
                trackingCodeId: prefix + "_L1",
                marketingCampaignId: ids.spring,
                eventKindEnumId: "MteClick",
                campaignRecipientId: prefix + "_R_ANN",
                campaignSendId: prefix + "_SEND",
                eventDate: ago(2)
            })
            event("BEN", {
                trackingCodeId: prefix + "_L1",
                marketingCampaignId: ids.spring,
                eventKindEnumId: "MteClick",
                campaignRecipientId: prefix + "_R_BEN",
                campaignSendId: prefix + "_SEND",
                eventDate: ago(2)
            })
            // the ticket buyer's visit V2: a click of the one-day link five days ago, past its lifetime
            event("OLD", {
                trackingCodeId: prefix + "_L3",
                marketingCampaignId: ids.spring,
                eventKindEnumId: "MteVisit",
                visitId: prefix + "_V2",
                eventDate: ago(5)
            })
            // the Sales lead whose quote Cy accepted, captured from the summer campaign
            make("mantle.sales.opportunity.SalesOpportunity", {
                salesOpportunityId: prefix + "_OPP",
                organizationPartyId: orgA,
                opportunityName: "Cy's deal",
                marketingCampaignId: ids.summer,
                createdDate: ago(10)
            })
        })
    },
    cleanupSpec() {
        login("john.doe")
    }
})

feature("one decision per placed order, whatever placed it; no inferred identity, no expired link, no purchase order", {
    when() {
        const r = {}
        system(() => {
            ids.shop = order("SHOP", {customer: prefix + "_DEE", visitId: prefix + "_V1", productStoreId: null})
            ids.quote = order("QUOTE", {customer: prefix + "_CY", purpose: "OrpSalesQuote"})
            make("mantle.sales.opportunity.SalesOpportunityOrder", {salesOpportunityId: prefix + "_OPP", orderId: ids.quote})
            ids.direct = order("DIRECT", {customer: prefix + "_ANN"})
            ids.refused = order("REFUSED", {customer: prefix + "_BEN"})
            ids.ticket = order("TICKET", {customer: prefix + "_CY", purpose: "OrpEventRegistration", visitId: prefix + "_V2"})
            ids.purchase = order("PURCHASE", {customer: orgA, vendor: supplier})
        })
        r.shopFirst = placed(ids.shop)
        r.shopAgain = placed(ids.shop)
        for (const key of ["quote", "direct", "refused", "ticket", "purchase"]) r[key] = placed(ids[key])
        r.decisions = {}
        for (const key of ["shop", "quote", "direct", "refused", "ticket", "purchase"]) r.decisions[key] = current(ids[key])
        r.shopCount = all(ids.shop).length
        r.native = rows("mantle.marketing.tracking.TrackingCodeOrder", {orderId: ids.shop})
        r.nativeQuote = rows("mantle.marketing.tracking.TrackingCodeOrder", {orderId: ids.quote}).length
        r.status = row("mantle.order.OrderHeader", {orderId: ids.shop}).statusId
        return r
    },
    then(r) {
        // the Shop order: its visit's page view (summer) is the most recent eligible event; the scanner's later fetch is no evidence;
        // the second call answers the first decision
        r.shopFirst.outcomeLinkId == r.shopAgain.outcomeLinkId
        r.shopCount == 1
        r.decisions.shop[0].marketingCampaignId == ids.summer
        r.decisions.shop[0].basisEnumId == "MobTrackingEvent"
        r.decisions.shop[0].trackingEventId == prefix + "_EV_K1VISIT"
        r.decisions.shop[0].evidenceDate != null
        r.native.length == 1 && r.native[0].trackingCodeId == prefix + "_L2" && r.native[0].isBillable == "N"
        r.status == "OrderPlaced"
        // a Sales acceptance with no tracking: its source opportunity's campaign
        r.decisions.quote[0].marketingCampaignId == ids.summer
        r.decisions.quote[0].basisEnumId == "MobOpportunity"
        r.nativeQuote == 0
        // a direct order by a consenting recipient's own click; a recipient who does not allow tracking now is unattributed
        r.decisions.direct[0].marketingCampaignId == ids.spring
        r.decisions.direct[0].trackingEventId == prefix + "_EV_ANN"
        r.decisions.refused[0].marketingCampaignId == null
        r.decisions.refused[0].basisEnumId == "MobNone"
        // a ticket: its visit's only event is past its link's one-day lifetime
        r.decisions.ticket.length == 1
        r.decisions.ticket[0].basisEnumId == "MobNone"
        // a purchase order is not a sales order: no decision
        r.decisions.purchase.length == 0
    }
})

feature("an order the placement's call missed is decided once by the job", {
    when() {
        system(() => {
            ids.missed = order("MISSED", {customer: prefix + "_ANN"})
        })
        const before = current(ids.missed).length
        const first = system(() => run(K + "run#OrderAttributions", {}))
        const second = system(() => run(K + "run#OrderAttributions", {}))
        const watermark = row("mantle.marketing.tracking.MarketingReportWatermark", {watermarkKey: "attribution"})
        return {
            before,
            first,
            second,
            after: all(ids.missed),
            watermark,
            status: row("mantle.order.OrderHeader", {orderId: ids.missed}).statusId
        }
    },
    then(r) {
        r.before == 0
        r.first.recordedCount >= 1
        r.after.length == 1
        r.after[0].marketingCampaignId == ids.spring
        // a run again finds nothing left of it
        r.second.failedCount == 0
        all(ids.missed).length == 1
        r.watermark.lastRunDate != null
        r.status == "OrderPlaced"
    }
})

feature("a later link edit changes no decision; a staff correction is a successor with its reason", {
    when() {
        const r = {}
        // the link the Shop order's decision names moves to another campaign: the decision stays
        system(() =>
            run("update#mantle.marketing.tracking.TrackingCode", {
                trackingCodeId: prefix + "_L2",
                marketingCampaignId: ids.spring
            })
        )
        r.again = placed(ids.shop)
        r.kept = current(ids.shop)[0]
        const decided = r.kept.outcomeLinkId
        const fields = {orderId: ids.shop, expectedOutcomeLinkId: decided, marketingCampaignId: ids.spring}
        r.analyst = as(users.analyst, K + "correct#OrderAttribution", Object.assign({reason: "The poster drove it"}, fields))
        r.otherAdmin = as(users.adminB, K + "correct#OrderAttribution", Object.assign({reason: "The poster drove it"}, fields))
        r.noReason = as(users.admin, K + "correct#OrderAttribution", fields)
        r.otherCampaign = as(
            users.admin,
            K + "correct#OrderAttribution",
            Object.assign({}, fields, {marketingCampaignId: ids.other, reason: "x"})
        )
        r.corrected = as(users.admin, K + "correct#OrderAttribution", Object.assign({reason: "The poster drove it"}, fields))
        r.stale = as(users.admin, K + "correct#OrderAttribution", Object.assign({reason: "Back"}, fields))
        r.chain = all(ids.shop)
        r.decided = decided
        return r
    },
    then(r) {
        r.again.outcomeLinkId == r.decided
        r.kept.marketingCampaignId == ids.summer
        code(r.analyst) == "PERMISSION_DENIED"
        code(r.otherAdmin) == "RECORD_UNAVAILABLE"
        code(r.noReason) == "REASON_REQUIRED"
        code(r.otherCampaign) == "CAMPAIGN_INVALID"
        r.corrected.refusal == "" && r.corrected.changed == true
        code(r.stale) == "STALE_REVISION"
        // the old decision ended and named its successor; the successor keeps the user and the reason
        const old = r.chain.find(link => link.outcomeLinkId == r.decided)
        old.thruDate != null && old.supersededByLinkId == r.corrected.outcomeLinkId
        const next = r.chain.find(link => link.outcomeLinkId == r.corrected.outcomeLinkId)
        next.basisEnumId == "MobStaff" && next.reason == "The poster drove it" && next.decidedByUserId == users.admin
        next.marketingCampaignId == ids.spring && next.thruDate == null
    }
})
