// A Sales order part's facility (impl-sales follow-up 5, §4 Nov 15; mantle.order.SalesApprovalServices store#SalesPolicy, SalesQuotes.js
// createQuote, mantle.order.SalesOrderServices place#SalesOrder, clone#SalesOrder and update#SalesOrderFacility): a seller's default
// facility is published in its Sales defaults (a warehouse of its own, never another organization's or an office); a quote and a
// direct order made, copied or placed with none ship from it, and an inventory product placed with no stock reserves there; a seller
// with no default leaves its parts as they were; the facility is changed on the order by its editor, to a warehouse of the seller
// only, at the order's revision, until the order is reserved, and only on Sales' own orders (a store's or another app's keeps its
// owner's); a facility set on the part is kept when it is placed; another organization's order answers as missing. Standalone:
// SalesQuoteIssueFixtures (A with a default, B without), spec-local users, facilities and an inventory product.
// Run: ./moq test mr-mantle --spec SalesOrderFacility
const fx = ec.resource.script("component://mr-mantle/test/order/SalesQuoteIssueFixtures.js")
const {call, system, as, make, one, revision, status} = fx
const orders = "mantle.order.SalesOrderServices."
const quotes = "mantle.order.SalesQuoteServices."
const policies = "mantle.order.SalesApprovalServices."
const capture = ec.factory.getTool("MailCapture")
let f
const users = {}
const facilities = {}

const partOf = orderId => one("mantle.order.OrderPart", {orderId, orderPartSeqId: "01"})
const facilityOf = orderId => partOf(orderId)?.facilityId || null
// a direct order of the seller for A's account with lines of the inventory kit: its id
function draftOrder(quantity = 2) {
    const orderId = as(users.seller, orders + "create#SalesOrder", {
        organizationPartyId: f.orgA,
        customerPartyId: f.accounts.a
    }).orderId
    as(users.seller, orders + "store#SalesOrderLine", {orderId, orderRevision: revision(orderId), productId: f.kit, quantity})
    return orderId
}
const place = orderId => as(users.seller, orders + "place#SalesOrder", {orderId, orderRevision: revision(orderId)})
const changeFacility = (username, orderId, facilityId, orderRevision = revision(orderId)) =>
    as(username, orders + "update#SalesOrderFacility", {orderId, orderRevision, facilityId})

spec({
    stepwise: true,
    setupSpec() {
        capture.enable()
        f = fx.setup("SOF")
        system(() => {
            users.admin = fx.addUser(f, "admin", [f.orgA, f.orgB], ["SALES_VIEW", "SALES_CONFIGURE"])
            users.seller = fx.addUser(
                f,
                "seller",
                [f.orgA],
                ["SALES_VIEW", "SALES_TEAM_VIEW", "SALES_ORDER_EDIT", "SALES_QUOTE_EDIT"]
            )
            users.reader = fx.addUser(f, "reader", [f.orgA], ["SALES_VIEW", "SALES_TEAM_VIEW"])
            const facility = (key, ownerPartyId, facilityTypeEnumId) => {
                facilities[key] = "SOF_" + key.toUpperCase()
                make("mantle.facility.Facility", {
                    facilityId: facilities[key],
                    facilityTypeEnumId,
                    ownerPartyId,
                    facilityName: "Facility " + key
                })
            }
            facility("a", f.orgA, "FcTpWarehouse")
            facility("a2", f.orgA, "FcTpWarehouse")
            facility("office", f.orgA, "FcTpOffice")
            facility("b", f.orgB, "FcTpWarehouse")
            // an inventory product A sells and holds no stock of
            f.kit = "SOF_KIT"
            make("mantle.product.Product", {
                productId: f.kit,
                productName: "Facility kit",
                productTypeEnumId: "PtAsset",
                assetTypeEnumId: "AstTpInventory",
                assetClassEnumId: "AsClsInventoryFin",
                amountUomId: "OTH_ea"
            })
            make("mantle.product.ProductPrice", {
                productId: f.kit,
                vendorPartyId: f.orgA,
                pricePurposeEnumId: "PppPurchase",
                priceTypeEnumId: "PptCurrent",
                fromDate: 0,
                minQuantity: 1,
                priceUomId: "USD",
                price: "40"
            })
        })
    },
    cleanupSpec() {
        capture.reset()
        login("john.doe")
    }
})

feature("a seller's default facility is published in its Sales defaults: a warehouse of its own, not another's or an office", {
    when() {
        const publish = facilityId => {
            const current = as(users.admin, policies + "get#SalesPolicy", {organizationPartyId: f.orgA})
            return as(users.admin, policies + "store#SalesPolicy", {
                organizationPartyId: f.orgA,
                revision: current.policy?.revision,
                defaultFacilityId: facilityId,
                changeReason: "Ships from " + facilityId
            })
        }
        const others = publish(facilities.b)
        const office = publish(facilities.office)
        const own = publish(facilities.a)
        const after = as(users.admin, policies + "get#SalesPolicy", {organizationPartyId: f.orgA})
        return {others, office, own, after}
    },
    then(r) {
        r.others.refused.includes("FACILITY_INVALID")
        r.office.refused.includes("FACILITY_INVALID")
        r.own.refused == "" && r.own.published == true
        r.own.changes.some(change => change.field == "defaultFacilityId" && change.afterText == facilities.a)
        r.after.policy.defaultFacilityId == facilities.a && r.after.policy.facilityName == "Facility a"
    }
})

feature(
    "a quote and a direct order made, copied or placed ship from it, an inventory product reserving there; no default, no facility",
    {
        when() {
            const quote = as(users.seller, quotes + "create#Quote", {organizationPartyId: f.orgA, customerPartyId: f.accounts.a})
            const quoteB = as(f.users.repB, quotes + "create#Quote", {organizationPartyId: f.orgB, customerPartyId: f.accounts.b})
            f.placed = draftOrder()
            const madeFacility = facilityOf(f.placed)
            const placed = place(f.placed)
            const reservations = system(() =>
                Array.from(ec.entity.find("mantle.product.issuance.AssetReservation").condition("orderId", f.placed).list()).map(
                    row => one("mantle.product.asset.Asset", {assetId: row.assetId})?.facilityId || null
                )
            )
            const copy = as(users.seller, orders + "clone#SalesOrder", {orderId: f.placed})
            // a draft made before its seller had a default (its part names none) gets it when it is placed
            const older = draftOrder(1)
            system(() => call("update#mantle.order.OrderPart", {orderId: older, orderPartSeqId: "01", facilityId: null}))
            const olderBefore = facilityOf(older)
            place(older)
            f.quoteB = quoteB.orderId
            return {
                quoteFacility: facilityOf(quote.orderId),
                quoteBFacility: facilityOf(quoteB.orderId),
                madeFacility,
                placed,
                reservations,
                copyFacility: facilityOf(copy.orderId),
                olderBefore,
                olderFacility: facilityOf(older),
                olderStatus: status(older)
            }
        },
        then(r) {
            r.quoteFacility == facilities.a && r.madeFacility == facilities.a
            r.quoteBFacility == null
            r.placed.refused == "" && r.placed.statusId != "OrderOpen"
            r.reservations.length > 0 && r.reservations.every(facilityId => facilityId == facilities.a)
            r.copyFacility == facilities.a
            r.olderBefore == null && r.olderFacility == facilities.a && r.olderStatus != "OrderOpen"
        }
    }
)

feature(
    "the facility is changed on the order by its editor, to the seller's own warehouse, at its revision, until it is reserved",
    {
        when() {
            const orderId = draftOrder(1)
            const byReader = changeFacility(users.reader, orderId, facilities.a2)
            const others = changeFacility(users.seller, orderId, facilities.b)
            const stale = changeFacility(users.seller, orderId, facilities.a2, revision(orderId) - 1)
            const changed = changeFacility(users.seller, orderId, facilities.a2)
            const shown = as(users.seller, orders + "get#SalesOrder", {orderId})
            const reserved = changeFacility(users.seller, f.placed, facilities.a2)
            const otherOrganization = changeFacility(users.seller, f.quoteB, facilities.a)
            // a facility set on the part is kept when it is placed (the default fills only an empty one)
            place(orderId)
            // a store's or another app's placed order of the seller (no Sales purpose): its facility stays its owner's
            const storeOrder = "SOF_STORE_ORDER"
            system(() => {
                make("mantle.order.OrderHeader", {
                    orderId: storeOrder,
                    statusId: "OrderPlaced",
                    placedDate: ec.user.nowTimestamp,
                    currencyUomId: "USD",
                    orderRevision: 1
                })
                make("mantle.order.OrderPart", {
                    orderId: storeOrder,
                    orderPartSeqId: "01",
                    statusId: "OrderPlaced",
                    vendorPartyId: f.orgA,
                    customerPartyId: f.accounts.a
                })
            })
            const notSales = changeFacility(users.seller, storeOrder, facilities.a)
            const storeShown = as(users.seller, orders + "get#SalesOrder", {orderId: storeOrder})
            return {
                byReader,
                others,
                stale,
                changed,
                after: facilityOf(orderId),
                shown,
                reserved,
                otherOrganization,
                placedFacility: facilityOf(orderId),
                placedStatus: status(orderId),
                notSales,
                storeShown,
                storeFacility: facilityOf(storeOrder)
            }
        },
        then(r) {
            r.byReader.refused.includes("PERMISSION_DENIED")
            r.others.refused.includes("FACILITY_INVALID")
            r.stale.refused.includes("REVISION_CHANGED")
            r.changed.refused == "" && r.after == facilities.a2
            r.shown.order.facilityName == "Facility a2" && r.shown.can.changeFacility == true
            r.reserved.refused.includes("FACILITY_LOCKED")
            r.otherOrganization.refused.includes("RECORD_UNAVAILABLE")
            r.placedStatus != "OrderOpen" && r.placedFacility == facilities.a2
            r.notSales.refused.includes("ORDER_NOT_SALES") && r.storeFacility == null
            r.storeShown.can.changeFacility == false
        }
    }
)
