// Marketing's retention (impl-marketing P20; design-marketing §15.3 "Reporting and retention"; MarketingReportServices
// run#MarketingRetention): an unconfirmed public request past its expiry is removed once with its tokens and a confirmed one kept; a
// purged import's rows lose their names and addresses and keep their outcomes; tracking events past the organization's statistics
// retention are removed but one an attribution names, and an order's visitor-key digest past it cleared (follow-up 4 review: a recent
// order's and another organization's kept); expired link tokens are removed; an item that cannot be removed is named and the
// rest done.
// Standalone: spec-local organizations, people, a list, requests, an import, events, a decision and tokens.
// Run: ./moq test mr-mantle --spec MarketingRetention
const lib = ec.resource.script("component://mr-mantle/test/marketing/MarketingSpecLib.js")
const {make, row, rows, run, system, organization} = lib
const R = "mantle.marketing.MarketingReportServices."
const prefix = "MKRT"
const orgA = prefix + "_ORG_A"
const dayMs = 86400000
const ago = days => new Date(Date.now() - days * dayMs)
const ids = {}

spec({
    setupSpec() {
        system(() => {
            organization(orgA, "Retention A")
            for (const name of ["P1", "P2", "P3"]) {
                make("mantle.party.Party", {partyId: prefix + "_" + name, partyTypeEnumId: "PtyPerson"})
                make("mantle.party.Person", {partyId: prefix + "_" + name, firstName: name})
            }
            make("mantle.marketing.contact.ContactList", {
                contactListId: prefix + "_LIST",
                contactListName: "News",
                ownerPartyId: orgA,
                contactListTypeEnumId: "NEWSLETTER"
            })
            // P1's request expired ten days ago unconfirmed, with its token; P2's confirmed; P3's expired but an import row names it
            for (const [name, status, expiredDays, verified] of [
                ["P1", "SrsPending", 10, null],
                ["P2", "SrsAccepted", 10, ago(12)],
                ["P3", "SrsPending", 10, null]
            ])
                make("mantle.marketing.contact.SubscriptionRequest", {
                    subscriptionRequestId: prefix + "_SR_" + name,
                    requestGroupId: prefix + "_SR_" + name,
                    contactListId: prefix + "_LIST",
                    partyId: prefix + "_" + name,
                    requestKindEnumId: "SrkPublic",
                    statusEnumId: status,
                    requestedDate: ago(expiredDays + 2),
                    expireDate: ago(expiredDays),
                    verifiedDate: verified
                })
            make("mantle.marketing.contact.SubscriptionRequestToken", {
                tokenId: prefix + "_TOK1",
                tokenDigest: prefix + "digest1",
                requestGroupId: prefix + "_SR_P1",
                createdDate: ago(12)
            })
            // a purged import: its row names the person and the request P3 (so P3's request cannot be removed)
            make("mantle.marketing.contact.AudienceImport", {
                audienceImportId: prefix + "_IMP",
                contactListId: prefix + "_LIST",
                organizationPartyId: orgA,
                stateEnumId: "AisComplete",
                purgedDate: ago(1),
                expireDate: ago(1)
            })
            make("mantle.marketing.contact.AudienceImportItem", {
                audienceImportId: prefix + "_IMP",
                rowNumber: 1,
                contactName: "Pat Example",
                addressMasked: "p***@example.test",
                outcome: "pending",
                subscriptionRequestId: prefix + "_SR_P3"
            })
            // events: the policy keeps 30 days; an old one, an old one an order's decision names, a recent one
            make("mantle.marketing.campaign.MarketingPolicy", {
                organizationPartyId: orgA,
                fromDate: ago(100),
                statisticsRetentionDays: 30
            })
            for (const [name, days] of [
                ["OLD", 40],
                ["NAMED", 40],
                ["NEW", 5]
            ])
                make("mantle.marketing.tracking.MarketingTrackingEvent", {
                    trackingEventId: prefix + "_EV_" + name,
                    organizationPartyId: orgA,
                    eventKindEnumId: "MteClick",
                    eventDate: ago(days)
                })
            make("mantle.marketing.tracking.MarketingOutcomeLink", {
                outcomeKindEnumId: "MokOrder",
                orderId: prefix + "_ORD",
                organizationPartyId: orgA,
                basisEnumId: "MobTrackingEvent",
                trackingEventId: prefix + "_EV_NAMED",
                placedDate: ago(39)
            })
            // follow-up 4 review: orders keeping a checkout's visitor-key digest: A's placed 40 days ago, A's 5 days ago, and another
            // seller's 40 days ago (no policy of its own)
            organization(prefix + "_ORG_B", "Retention B")
            for (const [name, days, vendor] of [
                ["OLD", 40, orgA],
                ["NEW", 5, orgA],
                ["B", 40, prefix + "_ORG_B"]
            ]) {
                make("mantle.order.OrderHeader", {
                    orderId: prefix + "_VK_" + name,
                    statusId: "OrderPlaced",
                    placedDate: ago(days),
                    entryDate: ago(days),
                    marketingVisitorKeyHash: "digest-" + name
                })
                make("mantle.order.OrderPart", {orderId: prefix + "_VK_" + name, orderPartSeqId: "01", vendorPartyId: vendor})
            }
            // link tokens: one expired, one current
            make("mantle.marketing.tracking.MarketingTrackingToken", {
                tokenHash: prefix + "-expired",
                organizationPartyId: orgA,
                expireDate: ago(1)
            })
            make("mantle.marketing.tracking.MarketingTrackingToken", {
                tokenHash: prefix + "-current",
                organizationPartyId: orgA,
                expireDate: new Date(Date.now() + dayMs)
            })
        })
    },
    cleanupSpec() {
        login("john.doe")
    }
})

feature(
    "each kind removed once; a confirmed request, a named event and a current token kept; a failure named and the rest done",
    {
        when() {
            const first = system(() => run(R + "run#MarketingRetention", {}))
            const second = system(() => run(R + "run#MarketingRetention", {}))
            const request = name =>
                row("mantle.marketing.contact.SubscriptionRequest", {subscriptionRequestId: prefix + "_SR_" + name})
            const event = name =>
                row("mantle.marketing.tracking.MarketingTrackingEvent", {trackingEventId: prefix + "_EV_" + name})
            return {
                first,
                second,
                p1: request("P1"),
                p2: request("P2"),
                p3: request("P3"),
                token: row("mantle.marketing.contact.SubscriptionRequestToken", {tokenId: prefix + "_TOK1"}),
                item: row("mantle.marketing.contact.AudienceImportItem", {audienceImportId: prefix + "_IMP", rowNumber: 1}),
                old: event("OLD"),
                named: event("NAMED"),
                recent: event("NEW"),
                expired: row("mantle.marketing.tracking.MarketingTrackingToken", {tokenHash: prefix + "-expired"}),
                current: row("mantle.marketing.tracking.MarketingTrackingToken", {tokenHash: prefix + "-current"}),
                keyed: ["OLD", "NEW", "B"].map(
                    name => row("mantle.order.OrderHeader", {orderId: prefix + "_VK_" + name}).marketingVisitorKeyHash
                ),
                watermark: row("mantle.marketing.tracking.MarketingReportWatermark", {watermarkKey: "retention"})
            }
        },
        then(r) {
            // P1's request and its token removed; P2's confirmed request kept
            r.p1 == null && r.token == null
            r.p2 != null
            // P3's request is named by an import row: it is named as not removed, and the rest of the run is done
            r.p3 != null
            r.first.failedItems.includes("subscription request " + prefix + "_SR_P3")
            // the import row keeps its outcome and loses the person
            r.item.contactName == null && r.item.addressMasked == null && r.item.outcome == "pending"
            // the old event removed, the one a decision names and the recent one kept
            r.old == null && r.named != null && r.recent != null
            r.expired == null && r.current != null
            // A's old order loses its visitor-key digest; A's recent one and the other seller's keep theirs
            r.keyed[0] == null && r.keyed[1] == "digest-NEW" && r.keyed[2] == "digest-B"
            // a run again removes nothing it removed: only the one that still fails
            r.second.removedCount == 0
            r.second.failedCount == r.first.failedCount
            r.watermark.failedCount == r.second.failedCount
        }
    }
)
