const P = "mantle.product.",
    S = P + "PriceServices.",
    time = Date.now()
const invoke = (n, p) => {
    try {
        const out = call(n, p) || {},
            error = ec.message.getErrorsString()
        ec.message.clearErrors()
        return Object.assign({}, out, {error})
    } catch (e) {
        ec.message.clearErrors()
        return {error: String(e.message || e)}
    }
}
const price = (id, extra = {}) =>
    invoke(
        S + "store#ProductPrice",
        Object.assign(
            {
                productId: id,
                vendorPartyId: "ORG_ZIZI_SERVICES",
                priceTypeEnumId: "PptCurrent",
                pricePurposeEnumId: "PppPurchase",
                priceUomId: "USD",
                price: 10,
                quantityUomId: "OTH_ea",
                fromDate: new Date(time - 60000).toISOString()
            },
            extra
        )
    )
function product(id) {
    call("create#" + P + "Product", {
        productId: id,
        productName: id,
        productTypeEnumId: "PtAsset",
        ownerPartyId: "ORG_ZIZI_SERVICES",
        amountUomId: "OTH_ea"
    })
}
spec({
    setupSpec() {
        login("john.doe")
        ec.user.setEffectiveTime(time)
        ec.artifactExecution.disableAuthz()
        call("create#mantle.party.Party", {partyId: "P5_SUPPLIER", partyTypeEnumId: "PtyOrganization"})
        call("create#mantle.party.PartyRole", {partyId: "P5_SUPPLIER", roleTypeId: "Supplier"})
    },
    setup() {
        ec.artifactExecution.disableAuthz()
    },
    cleanup() {
        ec.message.clearErrors()
        ec.artifactExecution.enableAuthz()
    }
})
feature("sales and supplier directions are explicit and pack units cannot masquerade as quantities", {
    when() {
        product("P5_DIR")
        call("create#moqui.basic.Uom", {
            uomId: "P5_CASE",
            uomTypeEnumId: "UT_OTHER_MEASURE",
            description: "Product-specific case"
        })
        const sales = price("P5_DIR"),
            supplier = price("P5_DIR", {vendorPartyId: "P5_SUPPLIER", customerPartyId: "ORG_ZIZI_SERVICES", price: 8}),
            ambiguous = price("P5_DIR", {vendorPartyId: "P5_SUPPLIER", customerPartyId: null}),
            pack = price("P5_DIR", {quantityUomId: "P5_CASE", minQuantity: 10})
        return {sales, supplier, ambiguous, pack}
    },
    then({sales, supplier, ambiguous, pack}) {
        sales.error == ""
        supplier.error == ""
        ambiguous.error.includes("internal")
        pack.error.includes("pack product")
    }
})
feature("equal-precedence overlaps are refused while distinct quantity tiers and disjoint dates remain usable", {
    when() {
        product("P5_SCOPE")
        const first = price("P5_SCOPE"),
            same = price("P5_SCOPE", {price: 12}),
            tier = price("P5_SCOPE", {minQuantity: 10, price: 9}),
            future = price("P5_SCOPE", {
                minQuantity: 20,
                price: 7,
                fromDate: new Date(time + 10000).toISOString(),
                thruDate: new Date(time + 20000).toISOString()
            }),
            later = price("P5_SCOPE", {minQuantity: 20, price: 6, fromDate: new Date(time + 20000).toISOString()})
        return {first, same, tier, future, later}
    },
    then({first, same, tier, future, later}) {
        first.error == ""
        same.error.includes("equal precedence")
        tier.error == ""
        future.error == ""
        later.error == ""
    }
})
feature("a successor closes only its source tier and records the reason and interval in the audit log", {
    when() {
        product("P5_NEXT")
        const first = price("P5_NEXT"),
            tier = price("P5_NEXT", {minQuantity: 10, price: 9}),
            next = invoke(S + "replace#ProductPrice", {
                productPriceId: first.productPriceId,
                price: 11,
                effectiveDate: new Date(time + 60000).toISOString(),
                changeReason: "Reviewed annual adjustment"
            }),
            source = ec.entity
                .find(P + "ProductPrice")
                .condition({productPriceId: first.productPriceId})
                .one(),
            other = ec.entity
                .find(P + "ProductPrice")
                .condition({productPriceId: tier.productPriceId})
                .one(),
            audit = ec.entity
                .find("moqui.entity.EntityAuditLog")
                .condition({changedEntityName: P + "ProductPrice", changedFieldName: "thruDate"})
                .count()
        return {first, next, source, other, audit}
    },
    then({first, next, source, other, audit}) {
        next.error == ""
        next.productPriceId != first.productPriceId
        Number(source.thruDate) == time + 60000
        source.price == 10
        other.thruDate == null
        audit > 0
    }
})
feature("a referenced row requires a successor and stale corrections cannot replace a newer edit", {
    when() {
        product("P5_REF")
        const created = price("P5_REF")
        call("create#mantle.order.OrderHeader", {orderId: "P5_ORDER", currencyUomId: "USD"})
        call("create#mantle.order.OrderPart", {
            orderId: "P5_ORDER",
            orderPartSeqId: "01",
            vendorPartyId: "ORG_ZIZI_SERVICES",
            customerPartyId: "P5_SUPPLIER"
        })
        call("create#mantle.order.OrderItem", {
            orderId: "P5_ORDER",
            orderPartSeqId: "01",
            orderItemSeqId: "01",
            productId: "P5_REF",
            productPriceId: created.productPriceId,
            quantity: 1,
            unitAmount: 10
        })
        const correction = invoke(S + "store#ProductPrice", {
                productPriceId: created.productPriceId,
                price: 12,
                changeReason: "Refused correction"
            }),
            next = invoke(S + "replace#ProductPrice", {
                productPriceId: created.productPriceId,
                price: 12,
                effectiveDate: new Date(time + 1000).toISOString(),
                changeReason: "New offer"
            })
        return {
            correction,
            next,
            item: ec.entity.find("mantle.order.OrderItem").condition({orderId: "P5_ORDER", orderItemSeqId: "01"}).one()
        }
    },
    then({correction, next, item}) {
        correction.error.includes("referenced")
        next.error == ""
        item.unitAmount == 10
    }
})
feature("a reviewed bulk change rounds to the currency, replaces each pinned row once and refuses a changed preview", {
    when() {
        product("P5_BULK")
        const source = price("P5_BULK", {price: 9.99})
        const preview = invoke(S + "preview#PriceChanges", {
                productIds: ["P5_BULK"],
                organizationPartyId: "ORG_ZIZI_SERVICES",
                direction: "sales",
                percentChange: 3,
                effectiveDate: new Date(time + 120000).toISOString(),
                changeReason: "Native bulk review"
            }),
            wrong = invoke(S + "apply#PriceChanges", {operationKey: preview.operationKey, previewToken: "changed"}),
            applied = invoke(S + "apply#PriceChanges", {operationKey: preview.operationKey, previewToken: preview.previewToken}),
            retry = invoke(S + "apply#PriceChanges", {operationKey: preview.operationKey, previewToken: preview.previewToken})
        return {source, preview, wrong, applied, retry}
    },
    then({source, preview, wrong, applied, retry}) {
        source.error == ""
        preview.readyCount == 1
        toDecimal(preview.previewRows[0].afterPrice).compare(toDecimal("10.29")) == 0
        wrong.error.includes("exact reviewed")
        applied.successCount == 1
        retry.successCount == 1
        applied.results[0].successorProductPriceId == retry.results[0].successorProductPriceId
    }
})
