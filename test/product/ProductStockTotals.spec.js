// mantle.product.AssetServices.get#ProductStockTotals: one product's stock at one facility for one owner, from its own
// assets and reservations. New spec, no Groovy original.
const facilityId = "ZIRET_WH",
    ownerPartyId = "ORG_ZIZI_RETAIL",
    productId = "PST_PRODUCT"

spec({
    setupSpec() {
        login("john.doe")
    },
    setup() {
        ec.artifactExecution.disableAuthz()
    },
    cleanup() {
        ec.artifactExecution.enableAuthz()
    }
})

feature("totals separate held and available-status stock, net out reservations and count open purchase quantities", {
    when() {
        call("create#mantle.product.Product", {productId, productName: "Stock totals sample", productTypeEnumId: "PtAsset"})
        const asset = (assetId, statusId, quantity) =>
            call("create#mantle.product.asset.Asset", {
                assetId,
                productId,
                facilityId,
                ownerPartyId,
                statusId,
                assetTypeEnumId: "AstTpInventory",
                quantityOnHandTotal: quantity,
                availableToPromiseTotal: statusId === "AstAvailable" ? quantity : 0
            })
        asset("PST_AVAILABLE", "AstAvailable", 10)
        asset("PST_HELD", "AstQuarantine", 3)
        call("create#mantle.product.issuance.AssetReservation", {
            assetReservationId: "PST_RESERVED",
            assetId: "PST_AVAILABLE",
            productId,
            quantity: 4,
            quantityNotIssued: 4,
            quantityNotAvailable: 1
        })
        // an open purchase order of the owner for this facility: 5 ordered, 2 accepted, so 3 incoming
        call("create#mantle.order.OrderHeader", {orderId: "PST_PO", statusId: "OrderPlaced", entryDate: ec.user.nowTimestamp})
        call("create#mantle.order.OrderPart", {
            orderId: "PST_PO",
            orderPartSeqId: "01",
            statusId: "OrderApproved",
            customerPartyId: ownerPartyId,
            vendorPartyId: "ZiddlemanInc",
            facilityId
        })
        call("create#mantle.order.OrderItem", {
            orderId: "PST_PO",
            orderItemSeqId: "01",
            orderPartSeqId: "01",
            productId,
            quantity: 5
        })
        call("create#mantle.product.receipt.AssetReceipt", {
            assetReceiptId: "PST_RECEIPT",
            assetId: "PST_AVAILABLE",
            productId,
            orderId: "PST_PO",
            orderItemSeqId: "01",
            quantityAccepted: 2
        })
        // a closed order brings nothing
        call("create#mantle.order.OrderHeader", {
            orderId: "PST_PO_DONE",
            statusId: "OrderCompleted",
            entryDate: ec.user.nowTimestamp
        })
        call("create#mantle.order.OrderPart", {
            orderId: "PST_PO_DONE",
            orderPartSeqId: "01",
            statusId: "OrderCompleted",
            customerPartyId: ownerPartyId,
            facilityId
        })
        call("create#mantle.order.OrderItem", {
            orderId: "PST_PO_DONE",
            orderItemSeqId: "01",
            orderPartSeqId: "01",
            productId,
            quantity: 7
        })
        return call("mantle.product.AssetServices.get#ProductStockTotals", {productId, facilityId, ownerPartyId})
    },
    then(totals) {
        toDecimal(totals.quantityOnHandTotal).compare(13) == 0
        toDecimal(totals.heldQuantity).compare(3) == 0
        toDecimal(totals.availableStatusQuantity).compare(10) == 0
        toDecimal(totals.reservedQuantity).compare(3) == 0
        totals.availableToPromiseTotal != null
        toDecimal(totals.incomingQuantity).compare(3) == 0
    }
})
