const PS = "mantle.product.ProductServices."
const OS = "mantle.order.OrderServices."
const time = Date.now()
function safe(name, p) {
    try {
        const out = call(name, p) || {},
            error = ec.message.getErrorsString()
        ec.message.clearErrors()
        return Object.assign({}, out, {error})
    } catch (e) {
        ec.message.clearErrors()
        return {error: String(e.message || e)}
    }
}
spec({
    setupSpec() {
        login("john.doe")
        ec.user.setEffectiveTime(time)
    },
    setup() {
        ec.artifactExecution.disableAuthz()
    },
    cleanup() {
        ec.message.clearErrors()
        ec.artifactExecution.enableAuthz()
    }
})
feature("legacy null status, explicit lifecycle, dates and nullable sale/purchase flags govern new usage", {
    when() {
        const id = call("create#mantle.product.Product", {
            productId: "LIFE_POLICY",
            productName: "Lifecycle policy",
            productTypeEnumId: "PtAsset",
            amountUomId: "OTH_ea"
        }).productId
        const use = usage => call(PS + "check#ProductUsable", {productId: id, usage})
        const legacy = use("Sell")
        call("update#mantle.product.Product", {productId: id, salesAllowed: "N"})
        const noSale = use("Sell"),
            purchase = use("Purchase")
        call("update#mantle.product.Product", {productId: id, salesAllowed: null, purchaseAllowed: "N"})
        const noPurchase = use("Purchase")
        call("update#mantle.product.Product", {productId: id, purchaseAllowed: null, statusId: "PrdDraft"})
        const draft = use("Sell")
        call("update#mantle.product.Product", {productId: id, statusId: "PrdActive", salesIntroductionDate: time + 86400000})
        const future = use("Sell")
        call("update#mantle.product.Product", {
            productId: id,
            statusId: null,
            salesIntroductionDate: null,
            salesDiscontinuationDate: time - 1
        })
        const legacyDiscontinued = use("Purchase"),
            emptyStock = use("Sell")
        call("update#mantle.product.Product", {productId: id, statusId: "PrdObsolete"})
        return {
            legacy,
            noSale,
            purchase,
            noPurchase,
            draft,
            future,
            legacyDiscontinued,
            emptyStock,
            receive: use("Receive"),
            returned: use("Return")
        }
    },
    then({legacy, noSale, purchase, noPurchase, draft, future, legacyDiscontinued, emptyStock, receive, returned}) {
        legacy.usable == true
        legacy.statusId == "PrdActive"
        noSale.usable == false
        purchase.usable == true
        noPurchase.usable == false
        draft.usable == false
        future.usable == false
        legacyDiscontinued.statusId == "PrdDiscontinued"
        legacyDiscontinued.usable == false
        emptyStock.usable == false
        receive.usable == true
        returned.usable == true
    }
})
feature("obsolete products refuse both new order entry paths for sales and purchases while an existing line is preserved", {
    when() {
        const id = call("create#mantle.product.Product", {
            productId: "LIFE_ORDERS",
            productName: "Lifecycle orders",
            productTypeEnumId: "PtAsset",
            statusId: "PrdActive"
        }).productId
        const orders = [
            {vendorPartyId: "ORG_ZIZI_RETAIL", customerPartyId: "ZiddlemanInc"},
            {vendorPartyId: "ZiddlemanInc", customerPartyId: "ORG_ZIZI_RETAIL"}
        ].map(part => call(OS + "create#Order", Object.assign({currencyUomId: "USD"}, part)))
        const existing = call(OS + "create#OrderItem", {
            orderId: orders[0].orderId,
            orderPartSeqId: orders[0].orderPartSeqId,
            productId: id,
            itemTypeEnumId: "ItemProduct",
            quantity: 1,
            unitAmount: 5
        })
        call("update#mantle.product.Product", {productId: id, statusId: "PrdDiscontinued"})
        call("update#mantle.product.Product", {productId: id, statusId: "PrdObsolete"})
        const refused = orders.flatMap(order => [
            safe(OS + "create#OrderItem", {
                orderId: order.orderId,
                orderPartSeqId: order.orderPartSeqId,
                productId: id,
                itemTypeEnumId: "ItemProduct",
                quantity: 1,
                unitAmount: 5
            }),
            safe(OS + "add#OrderProductQuantity", {
                orderId: order.orderId,
                orderPartSeqId: order.orderPartSeqId,
                productId: id,
                quantity: 1,
                unitAmount: 5
            })
        ])
        const row = ec.entity
            .find("mantle.order.OrderItem")
            .condition({orderId: orders[0].orderId, orderItemSeqId: existing.orderItemSeqId})
            .one()
        const update = safe(OS + "update#OrderItem", {
            orderId: orders[0].orderId,
            orderItemSeqId: existing.orderItemSeqId,
            unitAmount: 6
        })
        return {refused, row, update}
    },
    then({refused, row, update}) {
        update.error == ""
        refused.length == 4
        refused.every(out => out.error.includes("PrdObsolete"))
        row.productId == "LIFE_ORDERS"
        row.quantity == 1
        row.unitAmount == 5
    }
})
feature("a zero component remains the kit availability minimum even when later components have inventory", {
    when() {
        call("create#mantle.product.Product", {
            productId: "LIFE_KIT",
            productName: "Zero component kit",
            productTypeEnumId: "PtPickAssembly"
        })
        call("create#mantle.product.Product", {
            productId: "LIFE_EMPTY",
            productName: "Empty component",
            productTypeEnumId: "PtAsset"
        })
        call(PS + "store#KitComponent", {productId: "LIFE_KIT", toProductId: "LIFE_EMPTY", quantity: 1, sequenceNum: 1})
        call(PS + "store#KitComponent", {productId: "LIFE_KIT", toProductId: "DEMO_1_1", quantity: 1, sequenceNum: 2})
        return {
            kit: call("mantle.product.AssetServices.get#AvailableInventory", {productId: "LIFE_KIT", facilityId: "ZIRET_WH"}),
            stock: call("mantle.product.AssetServices.get#AvailableInventory", {productId: "DEMO_1_1", facilityId: "ZIRET_WH"})
        }
    },
    then({kit, stock}) {
        stock.availableToPromiseTotal > 0
        kit.availableToPromiseTotal == 0
    }
})
