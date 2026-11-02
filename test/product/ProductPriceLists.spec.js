const P = "mantle.product.",
    S = P + "PriceServices.",
    time = Date.now(),
    start = new Date(time - 60000).toISOString(),
    future = new Date(time + 60000).toISOString()
function invoke(name, p) {
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
const create = (entity, p) => call("create#" + entity, p)
function product(id) {
    create(P + "Product", {
        productId: id,
        productName: id,
        productTypeEnumId: "PtDigital",
        ownerPartyId: "ORG_ZIZI_SERVICES",
        amountUomId: "OTH_ea"
    })
}
function price(id, p = {}) {
    return create(
        P + "ProductPrice",
        Object.assign(
            {
                productId: id,
                vendorPartyId: "ORG_ZIZI_SERVICES",
                priceTypeEnumId: "PptCurrent",
                priceUomId: "USD",
                price: 20,
                fromDate: start
            },
            p
        )
    )
}
function list(name, p = {}) {
    return call(
        S + "store#ProductPriceList",
        Object.assign(
            {
                listName: name,
                organizationPartyId: "ORG_ZIZI_SERVICES",
                direction: "sales",
                priceUomId: "USD",
                priority: 100,
                fromDate: start,
                changeReason: "Test dated policy"
            },
            p
        )
    ).priceListId
}
function rule(id, p = {}) {
    return call(
        S + "store#ProductPriceRule",
        Object.assign(
            {
                priceListId: id,
                sequenceNum: 10,
                selector: "product",
                productId: "P5B_RULE",
                fromDate: start,
                baseType: "typed",
                basePriceTypeEnumId: "PptCurrent",
                percentChange: -10,
                amountChange: 1,
                roundingIncrement: "0.25",
                changeReason: "Test rule"
            },
            p
        )
    ).priceRuleId
}
function publish(id) {
    const preview = call(S + "get#ProductPriceListPublication", {priceListId: id})
    return call(S + "publish#ProductPriceList", {
        priceListId: id,
        publicationToken: preview.publicationToken,
        changeReason: "Reviewed scope and rules"
    })
}
function resolve(id, p = {}) {
    return call(
        S + "get#ProductPrice",
        Object.assign({productId: id, vendorPartyId: "ORG_ZIZI_SERVICES", priceUomId: "USD", explain: true}, p)
    )
}
spec({
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        ec.user.setEffectiveTime(time)
        for (const id of ["P5B_RULE", "P5B_ZERO", "P5B_DIRECTION", "P5B_DATES", "P5B_ORDER", "P5B_BASE"]) product(id)
        create("mantle.party.Party", {partyId: "P5B_SUPPLIER", partyTypeEnumId: "PtyOrganization"})
        create("mantle.party.PartyRole", {partyId: "P5B_SUPPLIER", roleTypeId: "Supplier"})
    },
    setup() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
    },
    cleanup() {
        ec.message.clearErrors()
        ec.artifactExecution.enableAuthz()
    }
})
feature("a purchase lookup cannot select the public sales row and an explicit zero remains available", {
    when() {
        price("P5B_DIRECTION", {vendorPartyId: null, price: 99})
        price("P5B_DIRECTION", {vendorPartyId: "P5B_SUPPLIER", customerPartyId: "ORG_ZIZI_SERVICES", price: 8})
        price("P5B_ZERO", {price: 0})
        price("P5B_ZERO", {priceTypeEnumId: "PptList", price: 40})
        return {
            purchase: resolve("P5B_DIRECTION", {vendorPartyId: "P5B_SUPPLIER", customerPartyId: "ORG_ZIZI_SERVICES"}),
            zero: resolve("P5B_ZERO"),
            none: resolve("P5B_BASE")
        }
    },
    then({purchase, zero, none}) {
        purchase.price == 8
        zero.price == 0
        zero.priceAvailable == true
        zero.priceSource == "product-price"
        none.price == 0
        none.priceAvailable == false
    }
})
feature("the single list modifier applies ordered declarative steps and returns the selected row and rule", {
    when() {
        const source = price("P5B_RULE"),
            id = list("Dated rules"),
            ruleId = rule(id)
        publish(id)
        const got = resolve("P5B_RULE", {priceListId: id})
        return {source, id, ruleId, got}
    },
    then({source, id, ruleId, got}) {
        got.price == 19
        got.productPriceId == source.productPriceId
        got.priceListId == id
        got.priceRuleId == ruleId
        got.priceSource == "price-list"
        got.priceTrace.some(r => r.kind === "percentage" && toDecimal(r.afterAmount).eq(18))
        got.priceTrace.filter(r => r.kind === "list-selected").length == 1
        !Object.keys(got).includes("priceRuleVersion")
    }
})
feature("rules change by dated identities and duplicate effective sequence or base cycles are rejected", {
    when() {
        const id = list("Date policies"),
            first = rule(id, {productId: "P5B_DATES", baseType: "fixed", fixedPrice: 10, percentChange: 0, amountChange: 0}),
            duplicate = invoke(S + "store#ProductPriceRule", {
                priceListId: id,
                sequenceNum: 10,
                selector: "all",
                fromDate: start,
                baseType: "fixed",
                fixedPrice: 99,
                changeReason: "Duplicate refused"
            }),
            second = call(S + "store#ProductPriceRule", {
                priceRuleId: first,
                fromDate: future,
                fixedPrice: 12,
                changeReason: "New effective amount"
            }),
            cycle = invoke(S + "store#ProductPriceRule", {
                priceListId: id,
                sequenceNum: 20,
                selector: "all",
                baseType: "list",
                basePriceListId: id,
                fromDate: start,
                changeReason: "Cycle refused"
            })
        publish(id)
        return {
            first,
            second,
            duplicate,
            cycle,
            before: resolve("P5B_DATES", {priceListId: id}),
            after: resolve("P5B_DATES", {priceListId: id, validDate: future})
        }
    },
    then({first, second, duplicate, cycle, before, after}) {
        first != second.priceRuleId
        duplicate.error.includes("effective sequence")
        cycle.error.includes("cycle")
        before.price == 10
        before.priceRuleId == first
        after.price == 12
        after.priceRuleId == second.priceRuleId
    }
})
feature("publication pins reviewed scope and a missing typed base is a named failure", {
    when() {
        const id = list("Missing base"),
            ruleId = rule(id, {productId: "P5B_BASE", basePriceTypeEnumId: "PptWholesale"}),
            bad = invoke(S + "publish#ProductPriceList", {
                priceListId: id,
                publicationToken: "stale",
                changeReason: "Not reviewed"
            })
        publish(id)
        return {
            bad,
            missing: invoke(S + "get#ProductPrice", {productId: "P5B_BASE", vendorPartyId: "ORG_ZIZI_SERVICES", priceListId: id})
        }
    },
    then({bad, missing}) {
        bad.error.includes("Review the exact")
        missing.error.includes("Missing PptWholesale base")
    }
})
feature("anonymous callers receive the public price without internal lists, supplier values or trace", {
    when() {
        price("P5B_RULE", {vendorPartyId: null, price: 7})
        logout()
        ec.artifactExecution.disableAuthz()
        const got = invoke(S + "get#ProductPrice", {productId: "P5B_RULE", vendorPartyId: "ORG_ZIZI_SERVICES", explain: true})
        login("john.doe")
        return {got}
    },
    then({got}) {
        got.error == ""
        got.price == 7
        got.priceTrace.length == 0
        got.priceListId == null
        !JSON.stringify(got).includes("P5B_SUPPLIER")
    }
})
feature("agreement and term matches outrank generic rows and dimensional quantities convert without using pack counts", {
    when() {
        product("P5B_AGREEMENT")
        call("create#mantle.party.agreement.Agreement", {agreementId: "P5B_AGR", organizationPartyId: "ORG_ZIZI_SERVICES"})
        price("P5B_AGREEMENT")
        const agreement = price("P5B_AGREEMENT", {agreementId: "P5B_AGR", termUomId: "TF_mon", price: 11})
        product("P5B_WEIGHT")
        call("update#" + P + "Product", {productId: "P5B_WEIGHT", amountUomId: "WT_kg"})
        price("P5B_WEIGHT", {quantityUomId: "WT_kg", price: 10})
        call("create#moqui.basic.UomConversion", {
            uomConversionId: "P5B_GRAMS",
            uomId: "WT_g",
            toUomId: "WT_kg",
            conversionFactor: "0.001",
            fromDate: start
        })
        return {
            agreement,
            matching: resolve("P5B_AGREEMENT", {agreementId: "P5B_AGR", termUomId: "TF_mon"}),
            generic: resolve("P5B_AGREEMENT"),
            weight: resolve("P5B_WEIGHT", {quantity: 1000, quantityUomId: "WT_g"})
        }
    },
    then({agreement, matching, generic, weight}) {
        matching.price == 11
        matching.productPriceId == agreement.productPriceId
        generic.price == 20
        weight.price == 0.01
        weight.priceAvailable == true
    }
})
feature("direct create add and re-price retain the exact dated rule including a zero-price successor", {
    when() {
        const id = list("Order provenance"),
            first = rule(id, {productId: "P5B_ORDER", baseType: "fixed", fixedPrice: 10, percentChange: 0, amountChange: 0})
        publish(id)
        const order = call("mantle.order.OrderServices.create#Order", {
            vendorPartyId: "ORG_ZIZI_SERVICES",
            customerPartyId: "P5B_SUPPLIER",
            currencyUomId: "USD"
        })
        const direct = call("mantle.order.OrderServices.create#OrderItem", {
            orderId: order.orderId,
            orderPartSeqId: order.orderPartSeqId,
            productId: "P5B_ORDER",
            quantity: 1,
            priceListId: id,
            requireInventory: false
        })
        const added = call("mantle.order.OrderServices.add#OrderProductQuantity", {
            orderId: order.orderId,
            orderPartSeqId: order.orderPartSeqId,
            productId: "P5B_ORDER",
            quantity: 2,
            priceListId: id,
            updateExisting: false,
            requireInventory: false
        })
        const before = ec.entity
            .find("mantle.order.OrderItem")
            .condition({orderId: order.orderId, orderItemSeqId: direct.orderItemSeqId})
            .one()
            .getMap()
        const next = call(S + "store#ProductPriceRule", {
            priceRuleId: first,
            fromDate: future,
            fixedPrice: 0,
            changeReason: "Zero-price campaign"
        })
        ec.user.setEffectiveTime(time + 60000)
        call("mantle.order.OrderServices.recalc#OrderItemAmount", {orderId: order.orderId, orderItemSeqId: direct.orderItemSeqId})
        const after = ec.entity
                .find("mantle.order.OrderItem")
                .condition({orderId: order.orderId, orderItemSeqId: direct.orderItemSeqId})
                .one()
                .getMap(),
            other = ec.entity
                .find("mantle.order.OrderItem")
                .condition({orderId: order.orderId, orderItemSeqId: added.orderItemSeqId})
                .one()
                .getMap()
        ec.user.setEffectiveTime(time)
        return {id, first, next, before, after, other}
    },
    then({id, first, next, before, after, other}) {
        before.priceListId == id
        before.priceRuleId == first
        before.unitAmount == 10
        other.priceRuleId == first
        after.priceRuleId == next.priceRuleId
        after.unitAmount == 0
        after.priceListId == id
    }
})
feature("list scope combines dated counterparty roles classifications and a geography group", {
    when() {
        product("P5B_SCOPE")
        create("mantle.party.Party", {
            partyId: "P5B_CUSTOMER",
            partyTypeEnumId: "PtyOrganization",
            ownerPartyId: "ORG_ZIZI_SERVICES"
        })
        create("mantle.party.PartyRole", {partyId: "P5B_CUSTOMER", roleTypeId: "Customer"})
        create("mantle.party.PartyClassification", {partyClassificationId: "P5B_CLASS", description: "Pricing class"})
        create("mantle.party.PartyClassificationAppl", {
            partyId: "P5B_CUSTOMER",
            partyClassificationId: "P5B_CLASS",
            fromDate: start
        })
        create("moqui.basic.Geo", {geoId: "P5B_GROUP", geoName: "Pricing region"})
        create("moqui.basic.GeoAssoc", {geoId: "P5B_GROUP", toGeoId: "USA", geoAssocTypeEnumId: "GAT_GROUP_MEMBER"})
        const id = list("Scoped list", {customerPartyId: "P5B_CUSTOMER", partyClassificationId: "P5B_CLASS", geoId: "P5B_GROUP"})
        rule(id, {productId: "P5B_SCOPE", baseType: "fixed", fixedPrice: 5, percentChange: 0, amountChange: 0})
        publish(id)
        return {
            match: resolve("P5B_SCOPE", {customerPartyId: "P5B_CUSTOMER", shipToCountryGeoId: "USA", priceListId: id}),
            wrong: invoke(S + "get#ProductPrice", {
                productId: "P5B_SCOPE",
                vendorPartyId: "ORG_ZIZI_SERVICES",
                customerPartyId: "P5B_CUSTOMER",
                shipToCountryGeoId: "CAN",
                priceListId: id
            }),
            roles: call(S + "find#ProductPriceRules", {priceListId: id}).priceList.parties
        }
    },
    then({match, wrong, roles}) {
        match.price == 5
        wrong.error.includes("not effective")
        roles.length == 1
        roles[0].roleTypeId == "Customer"
        roles[0].partyId == "P5B_CUSTOMER"
        roles[0].fromDate != null
    }
})
feature("pricing defaults are audited dated rows with optimistic checks and do not change an existing price", {
    when() {
        const first = call(S + "store#PricingSettings", {
            organizationPartyId: "ORG_ZIZI_SERVICES",
            defaultCurrencyUomId: "USD",
            defaultPurposeEnumId: "PppPurchase",
            allowedPurposeIds: "PppPurchase,PppRecurring",
            roundingIncrement: "0.05",
            changeReason: "First pricing defaults"
        })
        ec.user.setEffectiveTime(time + 1000)
        const next = call(S + "store#PricingSettings", {
                organizationPartyId: "ORG_ZIZI_SERVICES",
                expectedFromDate: first.fromDate,
                defaultCurrencyUomId: "EUR",
                changeReason: "Future pricing currency"
            }),
            stale = invoke(S + "store#PricingSettings", {
                organizationPartyId: "ORG_ZIZI_SERVICES",
                expectedFromDate: first.fromDate,
                defaultCurrencyUomId: "USD",
                changeReason: "Stale edit"
            })
        ec.user.setEffectiveTime(time)
        const before = call(S + "get#PricingSettings", {
                organizationPartyId: "ORG_ZIZI_SERVICES",
                asOfDate: new Date(time).toISOString()
            }),
            after = call(S + "get#PricingSettings", {
                organizationPartyId: "ORG_ZIZI_SERVICES",
                asOfDate: new Date(time + 1000).toISOString()
            }),
            audit = ec.entity
                .find("moqui.entity.EntityAuditLog")
                .condition({
                    changedEntityName: P + "ProductPricingSetting",
                    changedFieldName: "thruDate",
                    changeReason: "Future pricing currency"
                })
                .count()
        return {first, next, stale, before, after, audit, price: resolve("P5B_ZERO")}
    },
    then({first, next, stale, before, after, audit, price}) {
        first.fromDate != next.fromDate
        before.settings.defaultCurrencyUomId == "USD"
        after.settings.defaultCurrencyUomId == "EUR"
        stale.error.includes("changed")
        audit > 0
        price.price == 0
        price.priceUomId == "USD"
    }
})
feature("nested list currency is converted once and selected virtual extras apply once in a typed rule", {
    when() {
        product("P5B_NESTED")
        create("moqui.basic.UomConversion", {
            uomConversionId: "P5B_EUR_RATE",
            uomId: "EUR",
            toUomId: "USD",
            conversionFactor: 2,
            fromDate: start
        })
        const base = list("Euro base", {priceUomId: "EUR"})
        rule(base, {productId: "P5B_NESTED", baseType: "fixed", fixedPrice: 5, percentChange: 0, amountChange: 0})
        publish(base)
        const outer = list("Dollar outer")
        rule(outer, {productId: "P5B_NESTED", baseType: "list", basePriceListId: base, percentChange: 0, amountChange: 0})
        publish(outer)
        product("P5B_VIRTUAL")
        call("update#" + P + "Product", {productId: "P5B_VIRTUAL", productTypeEnumId: "PtVirtual"})
        product("P5B_VARIANT")
        price("P5B_VIRTUAL", {price: 10})
        create(P + "ProductAssoc", {
            productId: "P5B_VIRTUAL",
            toProductId: "P5B_VARIANT",
            productAssocTypeEnumId: "PatVariant",
            fromDate: start
        })
        create(P + "feature.ProductFeature", {
            productFeatureId: "P5B_EXTRA",
            description: "Paid option",
            ownerPartyId: "ORG_ZIZI_SERVICES"
        })
        create(P + "feature.ProductFeatureAppl", {
            productId: "P5B_VIRTUAL",
            productFeatureId: "P5B_EXTRA",
            applTypeEnumId: "PfatSelectable",
            fromDate: start,
            amount: 3
        })
        create(P + "feature.ProductFeatureAppl", {
            productId: "P5B_VARIANT",
            productFeatureId: "P5B_EXTRA",
            applTypeEnumId: "PfatDistinguishing",
            fromDate: start
        })
        const id = list("Variant policy")
        rule(id, {productId: "P5B_VARIANT", percentChange: 0, amountChange: 0})
        publish(id)
        return {nested: resolve("P5B_NESTED", {priceListId: outer}), variant: resolve("P5B_VARIANT", {priceListId: id})}
    },
    then({nested, variant}) {
        nested.price == 10
        nested.priceTrace.some(r => r.kind === "currency-conversion" && r.sourceId === "P5B_EUR_RATE" && r.validDate != null)
        variant.price == 13
        variant.priceTrace.filter(r => r.kind === "feature-extra").length == 2
        variant.priceTrace.filter(r => r.kind === "rule-base").length == 1
    }
})
