// Mantle behaviors the Warehouse phases build on (impl-warehouse P0, F10 and F13): what the ShipmentItemDetail view
// totals on a transfer that has several issuances and receipts of a product, what receive#EntireShipment does with
// them, and what quarantining reserved stock does to an order's reservation. These record Mantle as it is; the
// Warehouse guards (P5, P7, P8, P15) rely on it. New spec, no Groovy original.
const org = "WHC_ORG",
    from = "WHC_FROM",
    to = "WHC_TO",
    customer = "WHC_CUST"
const n = value => (value == null ? 0 : dec(value).toNumber())
const rows = (entity, condition) => Array.from(ec.entity.find(entity).condition(condition).disableAuthz().list())
const one = (entity, condition) => ec.entity.find(entity).condition(condition).disableAuthz().one()
const sum = (list, field) => list.reduce((total, row) => total + n(row[field]), 0)

function product(productId) {
    call("create#mantle.product.Product", {
        productId,
        productName: productId,
        productTypeEnumId: "PtAsset",
        assetTypeEnumId: "AstTpInventory",
        amountUomId: "OTH_ea"
    })
}
function receive(productId, quantity, locationSeqId) {
    return call("mantle.product.AssetServices.receive#Asset", {
        productId,
        quantity,
        facilityId: from,
        locationSeqId,
        ownerPartyId: org,
        assetTypeEnumId: "AstTpInventory",
        statusId: "AstAvailable"
    }).assetId
}
function order(productId, quantity) {
    const created = call("mantle.order.OrderServices.create#Order", {vendorPartyId: org, customerPartyId: customer, facilityId: from})
    call("mantle.order.OrderServices.add#OrderProductQuantity", {
        orderId: created.orderId,
        orderPartSeqId: created.orderPartSeqId,
        productId,
        quantity,
        unitAmount: 5
    })
    call("mantle.order.OrderServices.place#Order", {orderId: created.orderId})
    return created.orderId
}
const reservations = orderId => rows("mantle.product.issuance.AssetReservation", {orderId})
const asset = assetId => one("mantle.product.asset.Asset", {assetId})

spec({
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        // a spec-local clerk; the services read here check no permission, so the clerk is in no group
        call("create#mantle.party.Party", {partyId: "WHC_CLERK", partyTypeEnumId: "PtyPerson"})
        call("create#mantle.party.Person", {partyId: "WHC_CLERK", firstName: "Stock", lastName: "Clerk"})
        call("create#moqui.security.UserAccount", {
            userId: "WHC_CLERK",
            username: "whc.clerk",
            partyId: "WHC_CLERK",
            currentPassword: "16ac58bbfa332c1c55bd98b53e60720bfa90d394",
            passwordHashType: "SHA"
        })
        call("create#mantle.party.Party", {partyId: org, partyTypeEnumId: "PtyOrganization"})
        call("create#mantle.party.Organization", {partyId: org, organizationName: "Stock checks"})
        call("create#mantle.party.PartyRole", {partyId: org, roleTypeId: "OrgInternal"})
        call("create#mantle.party.Party", {partyId: customer, partyTypeEnumId: "PtyPerson"})
        call("create#mantle.party.Person", {partyId: customer, firstName: "Stock", lastName: "Customer"})
        call("create#mantle.party.PartyRole", {partyId: customer, roleTypeId: "Customer"})
        for (const facilityId of [from, to])
            call("create#mantle.facility.Facility", {facilityId, facilityTypeEnumId: "FcTpWarehouse", ownerPartyId: org})
        call("create#mantle.facility.FacilityLocation", {facilityId: from, locationSeqId: "PICK1", locationTypeEnumId: "FltPick"})
        call("create#mantle.facility.FacilityLocation", {facilityId: from, locationSeqId: "QUAR1", locationTypeEnumId: "FltQuarantine"})
        call("create#mantle.facility.FacilityLocationType", {
            facilityId: from,
            locationTypeEnumId: "FltQuarantine",
            autoStatusId: "AstQuarantine"
        })
        for (const productId of ["WHC_MOVED", "WHC_HELD", "WHC_HELD_ONLY", "WHC_PART"]) product(productId)
        ec.artifactExecution.enableAuthz()
        login("whc.clerk")
    },
    setup() {
        ec.artifactExecution.disableAuthz()
    },
    cleanup() {
        ec.artifactExecution.enableAuthz()
    }
})

let transferId

feature("a transfer's ShipmentItemDetail multiplies receipts by issuances and issuances by receipts (F10)", {
    when() {
        const first = receive("WHC_MOVED", 10, "PICK1"),
            second = receive("WHC_MOVED", 10, "PICK1")
        transferId = call("mantle.shipment.ShipmentServices.create#Shipment", {
            shipmentTypeEnumId: "ShpTpTransfer",
            fromPartyId: org,
            toPartyId: org,
            originFacilityId: from,
            destinationFacilityId: to
        }).shipmentId
        call("mantle.shipment.ShipmentServices.create#ShipmentItem", {shipmentId: transferId, productId: "WHC_MOVED", quantity: 6})
        // two issuances of 3, from two assets
        call("mantle.product.AssetServices.issue#Asset", {shipmentId: transferId, assetId: first, quantity: 3})
        call("mantle.product.AssetServices.issue#Asset", {shipmentId: transferId, assetId: second, quantity: 3})
        // two receipts at the destination, 2 then 1: 3 of the 6 sent
        for (const quantityAccepted of [2, 1])
            call("mantle.shipment.ShipmentServices.receive#ShipmentProduct", {
                shipmentId: transferId,
                productId: "WHC_MOVED",
                quantityAccepted,
                facilityId: to
            })
        const detail = rows("mantle.shipment.ShipmentItemDetail", {shipmentId: transferId})
        return {
            detail,
            issued: sum(rows("mantle.product.issuance.AssetIssuance", {shipmentId: transferId}), "quantity"),
            accepted: sum(rows("mantle.product.receipt.AssetReceipt", {shipmentId: transferId}), "quantityAccepted")
        }
    },
    then({detail, issued, accepted}) {
        issued == 6
        accepted == 3
        detail.length == 1
        // the view joins both on shipment and product: 2 receipts x 2 issuances
        n(detail[0].quantityAcceptedTotal) == 6
        n(detail[0].quantityTotal) == 12
    }
})

feature("receive#EntireShipment then receives nothing more and delivers the transfer 3 short (F10)", {
    when() {
        call("mantle.shipment.ShipmentServices.receive#EntireShipment", {shipmentId: transferId, facilityId: to})
        return {
            accepted: sum(rows("mantle.product.receipt.AssetReceipt", {shipmentId: transferId}), "quantityAccepted"),
            onHand: sum(rows("mantle.product.asset.Asset", {productId: "WHC_MOVED", facilityId: to}), "quantityOnHandTotal"),
            shipment: one("mantle.shipment.Shipment", {shipmentId: transferId})
        }
    },
    then({accepted, onHand, shipment}) {
        // quantity 6 less the multiplied 6 accepted leaves 0 to receive
        accepted == 3
        onHand == 3
        shipment.statusId == "ShipDelivered"
    }
})

feature("moving all of a reserved asset into quarantine re-reserves the order on other available stock (F13)", {
    when() {
        const reserved = receive("WHC_HELD", 10, "PICK1")
        const orderId = order("WHC_HELD", 4)
        const before = reservations(orderId)
        const other = receive("WHC_HELD", 10, "PICK1")
        call("mantle.product.AssetServices.move#Asset", {assetId: reserved, locationSeqId: "QUAR1"})
        return {reserved, other, before, after: reservations(orderId), held: asset(reserved)}
    },
    then({reserved, other, before, after, held}) {
        before.length == 1 && before[0].assetId == reserved
        held.statusId == "AstQuarantine"
        // a held asset keeps its available-to-promise total: readers of availability filter by status
        n(held.availableToPromiseTotal) == 10
        // AssetStatusNotAvailableReservations: the reservation on the held asset is removed and made again elsewhere
        after.every(r => r.assetId != reserved)
        sum(after, "quantity") == 4
        after.every(r => r.assetId == other) && sum(after, "quantityNotAvailable") == 0
    }
})

feature("with no other stock the order's reservation becomes not available (F13)", {
    when() {
        const reserved = receive("WHC_HELD_ONLY", 10, "PICK1")
        const orderId = order("WHC_HELD_ONLY", 4)
        call("mantle.product.AssetServices.move#Asset", {assetId: reserved, locationSeqId: "QUAR1"})
        return {reserved, after: reservations(orderId), held: asset(reserved)}
    },
    then({reserved, after, held}) {
        held.statusId == "AstQuarantine"
        sum(after, "quantity") == 4
        sum(after, "quantityNotAvailable") == 4
        after.every(r => r.assetId != reserved)
    }
})

feature("moving part of a reserved asset into quarantine carries the reservation beyond ATP onto the held asset (F13)", {
    when() {
        const source = receive("WHC_PART", 10, "PICK1")
        const orderId = order("WHC_PART", 4)
        // 8 of 10 with 6 available: the 2 beyond ATP take 2 of the reservation along to the new quarantined asset
        call("mantle.product.AssetServices.move#Asset", {assetId: source, locationSeqId: "QUAR1", quantity: 8})
        const held = rows("mantle.product.asset.Asset", {productId: "WHC_PART", locationSeqId: "QUAR1"})
        return {source, orderId, held, after: reservations(orderId)}
    },
    then({source, held, after}) {
        held.length == 1
        held[0].statusId == "AstQuarantine"
        n(held[0].quantityOnHandTotal) == 8
        n(held[0].availableToPromiseTotal) == 6
        // the same facility, so check#AssetReservations does not run: 2 stay reserved on the quarantined asset
        sum(after.filter(r => r.assetId == held[0].assetId), "quantity") == 2
        sum(after.filter(r => r.assetId == source), "quantity") == 2
        sum(after, "quantityNotAvailable") == 0
    }
})
