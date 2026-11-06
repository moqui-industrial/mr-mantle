// One resolver for public/base prices, dated list policies and the authorized explanation.
const P = "mantle.product.",
    E = P + "ProductPrice"
const find = (name, where = {}) => ec.entity.find(name).condition(where).disableAuthz()
const one = (name, where) => find(name, where).one()
const rows = (name, where) => Array.from(find(name, where).list())
const ms = v => (v == null || v === "" ? null : Number.isFinite(Number(String(v))) ? Number(String(v)) : Date.parse(String(v)))
const active = (r, date) => (ms(r.fromDate) ?? -Infinity) <= ms(date) && (ms(r.thruDate) ?? Infinity) > ms(date)
const policy = () => ec.resource.script("component://mr-mantle/service/mantle/product/PriceLists.js")
const call = (name, p) => {
    const out =
        ec.service
            .sync()
            .name(name)
            .parameters(p || {})
            .disableAuthz()
            .call() || {}
    if (ec.message.hasError()) throw new Error(ec.message.getErrorsString())
    return out
}
const internal = id => !!id && !!one("mantle.party.PartyRole", {partyId: id, roleTypeId: "OrgInternal"})
const has = permission => ec.resource.script("component://mr-mantle/service/mantle/product/ProductAccess.js").has(permission)
const read = (direction, cost = false) =>
    has("ADMIN") ||
    (cost
        ? ["PRODUCT_COST_VIEW", "PRODUCT_COST_ESTIMATE", "PRODUCT_COST_APPROVE", "ACCOUNTING_VIEW", "ACCOUNTING_GL_POST"]
        : direction === "purchase"
          ? ["SUPPLIER_PRICE_VIEW", "SUPPLIER_PRICE_EDIT"]
          : ["PRICE_VIEW", "PRICE_EDIT"]
    ).some(has)
function context(p) {
    const out = Object.assign({}, p)
    out.validDate = p.validDate || ec.user.nowTimestamp
    out.quantity = p.quantity == null ? toDecimal(1) : toDecimal(p.quantity)
    out.priceUomId = p.priceUomId || ec.user.getPreference("CurrencyDefault") || "USD"
    out.pricePurposeEnumId = p.pricePurposeEnumId || "PppPurchase"
    if (!Number.isFinite(ms(out.validDate)) || out.quantity.compare(0) < 0)
        throw new Error("Choose a valid price date and nonnegative quantity")
    if (out.productStoreId) {
        const store = one(P + "store.ProductStore", {productStoreId: out.productStoreId})
        if (store && !out.vendorPartyId) out.vendorPartyId = store.organizationPartyId
    }
    const inferred = out.vendorPartyId && !internal(out.vendorPartyId) ? "purchase" : "sales"
    out.direction = out.direction || inferred
    if (!["sales", "purchase"].includes(out.direction) || out.direction !== inferred)
        throw new Error("Price direction does not match the transaction parties")
    out.organizationPartyId = out.organizationPartyId || (out.direction === "purchase" ? out.customerPartyId : out.vendorPartyId)
    if (out.organizationPartyId) {
        if (!internal(out.organizationPartyId)) throw new Error("Choose an internal price organization")
        if (out.direction === "sales") {
            if (out.vendorPartyId && out.vendorPartyId !== out.organizationPartyId)
                throw new Error("Selling organization does not match")
            out.vendorPartyId = out.organizationPartyId
        } else if (!out.customerPartyId) out.customerPartyId = out.organizationPartyId
    }
    if (out.direction === "purchase" && (!out.vendorPartyId || !internal(out.customerPartyId)))
        throw new Error("Purchase prices need an external supplier and an internal buyer")
    // Shop's catalog prices as the authority for its routed store and signed-in customer (impl-shop P3, F18): only
    // get#StoreProductPrice sets this, in its own script (no service declares it, so no caller's input can)
    out.storeAuthority = p.storeAuthority === true && !!out.productStoreId && out.direction === "sales"
    out.traceAllowed = !!p.explain && !out.storeAuthority && read(out.direction)
    out.priceTrace = []
    out.priceWarnings = []
    return out
}
function step(c, data) {
    if (c.traceAllowed) c.priceTrace.push(Object.assign({sequence: c.priceTrace.length + 1}, data))
}
function readable(row, c) {
    if (row.priceTypeEnumId === "PptAverage" && !read(c.direction, true)) return false
    const d = internal(row.vendorPartyId) ? "sales" : row.vendorPartyId ? "purchase" : "sales"
    if (d !== c.direction) return false
    // The store's authority (get#StoreProductPrice): the public rows, the store organization's and the customer's own;
    // never an agreement's, an average cost or another party's.
    if (c.storeAuthority)
        return (
            row.priceTypeEnumId !== "PptAverage" &&
            !row.agreementId &&
            (!row.vendorPartyId || row.vendorPartyId === c.vendorPartyId) &&
            (!row.customerPartyId || (!!c.customerPartyId && row.customerPartyId === c.customerPartyId))
        )
    // A purchase context never falls back to a public sales row. Anonymous users see only public, unscoped sale prices.
    if (!ec.user.userId)
        return !row.vendorPartyId && !row.customerPartyId && !row.agreementId && row.priceTypeEnumId !== "PptAverage"
    if (row.priceTypeEnumId === "PptAverage") {
        try {
            ec.resource.script("component://mr-mantle/service/mantle/product/PricePolicy.js").execute("access", row)
        } catch (e) {
            return false
        }
    }
    if (row.vendorPartyId || row.customerPartyId) {
        if (row.priceTypeEnumId !== "PptAverage" && !read(d)) return false
        try {
            ec.resource
                .script("component://mr-mantle/service/mantle/product/PricePolicy.js")
                .execute(
                    "access",
                    row.vendorPartyId && !internal(row.vendorPartyId) && !row.customerPartyId
                        ? Object.assign({}, row.getMap ? row.getMap() : row, {customerPartyId: c.customerPartyId})
                        : row
                )
        } catch (e) {
            return false
        }
    }
    return true
}
function conversion(amount, from, to, date, c, kind = "currency-conversion") {
    if (!from || !to || from === to) return toDecimal(amount)
    const source = one("moqui.basic.Uom", {uomId: from}),
        target = one("moqui.basic.Uom", {uomId: to})
    if (!source || !target || source.uomTypeEnumId !== target.uomTypeEnumId)
        throw new Error("Missing compatible conversion from " + from + " to " + to)
    let reverse = false,
        rate = rows("moqui.basic.UomConversion", {uomId: from, toUomId: to})
            .filter(r => active(r, date))
            .sort(
                (a, b) => ms(b.fromDate) - ms(a.fromDate) || String(b.uomConversionId).localeCompare(String(a.uomConversionId))
            )[0]
    if (!rate) {
        reverse = true
        rate = rows("moqui.basic.UomConversion", {uomId: to, toUomId: from})
            .filter(r => active(r, date))
            .sort(
                (a, b) => ms(b.fromDate) - ms(a.fromDate) || String(b.uomConversionId).localeCompare(String(a.uomConversionId))
            )[0]
    }
    if (
        !rate ||
        rate.conversionFactor == null ||
        toDecimal(rate.conversionFactor).compare(0) <= 0 ||
        (rate.conversionOffset != null && !toDecimal(rate.conversionOffset).isZero())
    )
        throw new Error("Missing linear conversion from " + from + " to " + to)
    const result = reverse ? toDecimal(amount).divide(rate.conversionFactor) : toDecimal(amount).multiply(rate.conversionFactor)
    if (c)
        step(c, {
            kind,
            sourceEntity: "moqui.basic.UomConversion",
            sourceId: rate.uomConversionId,
            eligible: true,
            validDate: date,
            beforeAmount: amount,
            operand: rate.conversionFactor,
            operation: reverse ? "divide" : "multiply",
            afterAmount: result,
            reason: from + " to " + to + " at " + new Date(ms(date)).toISOString()
        })
    return result
}
function typed(c, type, productId = c.productId) {
    const product = one(P + "Product", {productId}),
        matches = []
    for (const row of rows(E, {productId, priceTypeEnumId: type, priceUomId: c.priceUomId})) {
        if (!readable(row, c)) continue
        let why = "Eligible",
            eligible = true,
            specificity = 0,
            quantity = c.quantity,
            unit = row.quantityUomId || product?.amountUomId
        for (const key of [
            "pricePurposeEnumId",
            "productStoreId",
            "vendorPartyId",
            "customerPartyId",
            "agreementId",
            "agreementItemSeqId",
            "termUomId"
        ])
            if (row[key] != null) {
                if (row[key] !== c[key]) {
                    eligible = false
                    why = "Different " + key
                    break
                }
                specificity++
            }
        if (eligible && !active(row, c.validDate)) {
            eligible = false
            why = "Outside effective interval"
        }
        if (eligible && c.quantityUomId && unit && c.quantityUomId !== unit) {
            try {
                quantity = conversion(c.quantity, c.quantityUomId, unit, c.validDate, c, "quantity-conversion")
            } catch (e) {
                eligible = false
                why = String(e.message || e)
            }
        }
        if (eligible && toDecimal(row.minQuantity || 0).compare(quantity) > 0) {
            eligible = false
            why = "Below minimum quantity"
        }
        if (eligible && row.price == null) {
            eligible = false
            why = "No configured amount"
        }
        step(c, {
            kind: "base-candidate",
            sourceEntity: E,
            sourceId: row.productPriceId,
            productId,
            eligible,
            reason: why,
            quantity: String(quantity),
            quantityUomId: unit,
            priceUomId: c.priceUomId,
            afterAmount: row.price
        })
        if (eligible) {
            const factor = conversion(1, c.quantityUomId || unit, unit, c.validDate, c, "quantity-unit-factor"),
                price = toDecimal(row.price).multiply(factor)
            matches.push({
                price,
                productPriceId: row.productPriceId,
                productId,
                quantity,
                quantityUomId: c.quantityUomId || unit,
                fromDate: ms(row.fromDate) || 0,
                minQuantity: toDecimal(row.minQuantity || 0),
                specificity,
                agreement: row.agreementId ? 1 : 0,
                taxInPrice: row.taxInPrice
            })
        }
    }
    matches.sort(
        (a, b) =>
            b.agreement - a.agreement ||
            b.specificity - a.specificity ||
            b.minQuantity.compare(a.minQuantity) ||
            b.fromDate - a.fromDate ||
            String(a.productPriceId).localeCompare(String(b.productPriceId))
    )
    return matches[0] || null
}
function fallback(c, type) {
    let found = typed(c, type)
    if (found) return found
    const virtuals = rows(P + "ProductAssoc", {productAssocTypeEnumId: "PatVariant", toProductId: c.productId})
        .filter(r => active(r, c.validDate))
        .sort((a, b) => String(a.productId).localeCompare(String(b.productId)))
    for (const association of virtuals) {
        found = typed(c, type, association.productId)
        if (found) {
            step(c, {
                kind: "virtual-fallback",
                eligible: true,
                sourceEntity: P + "Product",
                sourceId: association.productId,
                reason: "No price for the actual variant",
                afterAmount: found.price
            })
            return Object.assign(found, {virtualFallback: true})
        }
    }
    return null
}
function extras(c, selected) {
    if (!selected?.virtualFallback || !read("sales") || c.direction !== "sales") return selected
    let price = toDecimal(selected.price)
    const unit = one(P + "Product", {productId: selected.productId})?.amountUomId,
        factor = conversion(1, c.quantityUomId || unit, unit, c.validDate, c, "quantity-unit-factor"),
        s = policy().scope()
    for (const appl of rows(P + "feature.ProductFeatureAppl", {productId: c.productId}).filter(
        r => active(r, c.validDate) && ["PfatStandard", "PfatDistinguishing"].includes(r.applTypeEnumId)
    )) {
        const feature = one(P + "feature.ProductFeature", {productFeatureId: appl.productFeatureId})
        if (!feature || (!s.systemAdmin && !s.ownerPartyIds.includes(feature.ownerPartyId))) continue
        const key = c.pricePurposeEnumId === "PppRecurring" ? "recurringAmount" : "amount"
        let amount = appl[key],
            source = appl
        if (amount == null) {
            source = rows(P + "feature.ProductFeatureAppl", {
                productId: selected.productId,
                productFeatureId: appl.productFeatureId,
                applTypeEnumId: "PfatSelectable"
            })
                .filter(r => active(r, c.validDate))
                .sort((a, b) => ms(b.fromDate) - ms(a.fromDate))[0]
            amount = source?.[key]
        }
        if (amount == null && key === "amount")
            for (const membership of rows(P + "category.ProductCategoryMember", {productId: selected.productId}).filter(r =>
                active(r, c.validDate)
            )) {
                for (const group of rows(P + "feature.ProductCategoryFeatGrpAppl", {
                    productCategoryId: membership.productCategoryId,
                    applTypeEnumId: "PfatSelectable"
                }).filter(r => active(r, c.validDate))) {
                    const value = rows(P + "feature.ProductFeatureGroupAppl", {
                        productFeatureGroupId: group.productFeatureGroupId,
                        productFeatureId: appl.productFeatureId
                    })
                        .filter(r => active(r, c.validDate))
                        .sort((a, b) => ms(b.fromDate) - ms(a.fromDate))[0]
                    if (value?.amount != null) {
                        amount = value.amount
                        source = value
                        break
                    }
                }
                if (amount != null) break
            }
        if (amount != null) {
            const before = price,
                change = toDecimal(amount).multiply(factor)
            price = price.add(change)
            step(c, {
                kind: "feature-extra",
                sourceEntity: P + "feature.ProductFeatureAppl",
                sourceId: appl.productFeatureId,
                eligible: true,
                beforeAmount: before,
                operand: change,
                afterAmount: price,
                quantityUomId: c.quantityUomId || unit,
                reason: "Selected feature extra on the virtual fallback"
            })
        }
    }
    return Object.assign({}, selected, {price})
}
function byType(p) {
    const c = context(p),
        r = typed(c, p.priceTypeEnumId)
    return {
        price: r?.price,
        productPriceId: r?.productPriceId,
        priceUomId: c.priceUomId,
        priceAvailable: !!r,
        priceTrace: c.priceTrace
    }
}
function resolve(p) {
    const c = context(p),
        current = fallback(c, "PptCurrent"),
        list = fallback(c, "PptList"),
        selected = current || (p.defaultToListPrice !== false && p.defaultToListPrice !== "false" ? list : null)
    const price = extras(c, selected)?.price
    step(c, {
        kind: "base-selected",
        eligible: !!selected,
        sourceId: selected?.productPriceId,
        reason: selected ? "Selected dated base price" : "No eligible configured price",
        afterAmount: price
    })
    return {
        price: price ?? toDecimal(0),
        productPriceId: selected?.productPriceId,
        listPrice: list?.price,
        listProductPriceId: list?.productPriceId,
        priceUomId: c.priceUomId,
        priceAvailable: !!selected,
        listPriceAvailable: !!list,
        priceSource: current ? "product-price" : selected ? "list-price-fallback" : "unavailable",
        priceTrace: c.priceTrace,
        priceWarnings: c.priceWarnings,
        pricingContext: c,
        taxInPrice: selected?.taxInPrice,
        virtualPriceFallback: !!selected?.virtualFallback,
        priceListId: null,
        priceRuleId: null
    }
}
function geoMatches(scopeId, country) {
    if (!scopeId) return true
    if (!country) return false
    const visited = new Set(),
        pending = [scopeId]
    while (pending.length) {
        const id = pending.shift()
        if (id === country) return true
        if (visited.has(id)) continue
        visited.add(id)
        for (const edge of rows("moqui.basic.GeoAssoc", {geoId: id}).filter(r =>
            ["GAT_GROUP_MEMBER", "GAT_REGIONS"].includes(r.geoAssocTypeEnumId)
        ))
            pending.push(edge.toGeoId)
    }
    return false
}
function classified(id, c) {
    if (!id) return true
    const counterparty = c.direction === "purchase" ? c.vendorPartyId : c.customerPartyId
    return (
        !!counterparty &&
        rows("mantle.party.PartyClassificationAppl", {partyId: counterparty, partyClassificationId: id}).some(r =>
            active(r, c.validDate)
        )
    )
}
function listEligible(list, c) {
    if (
        list.state !== "published" ||
        !active(list, c.validDate) ||
        list.direction !== c.direction ||
        list.organizationPartyId !== c.organizationPartyId
    )
        return false
    if (
        (list.pricePurposeEnumId && list.pricePurposeEnumId !== c.pricePurposeEnumId) ||
        (list.productStoreId && list.productStoreId !== c.productStoreId) ||
        (list.agreementId && list.agreementId !== c.agreementId) ||
        (list.agreementItemSeqId && list.agreementItemSeqId !== c.agreementItemSeqId) ||
        !classified(list.partyClassificationId, c) ||
        !geoMatches(list.geoId, c.shipToCountryGeoId || c.billToCountryGeoId || c.countryGeoId)
    )
        return false
    return policy()
        .parties(list.priceListId, c.validDate)
        .every(
            r =>
                r.partyId ===
                (r.roleTypeId === "Vendor" ? c.vendorPartyId : r.roleTypeId === "Customer" ? c.customerPartyId : null)
        )
}
function eligibleRule(rule, c) {
    if (
        !active(rule, c.validDate) ||
        !classified(rule.partyClassificationId, c) ||
        !geoMatches(rule.geoId, c.shipToCountryGeoId || c.billToCountryGeoId || c.countryGeoId)
    )
        return false
    if (rule.selector === "product" && rule.productId !== c.productId) return false
    if (
        rule.selector === "category" &&
        !rows(P + "category.ProductCategoryMember", {productId: c.productId, productCategoryId: rule.productCategoryId}).some(r =>
            active(r, c.validDate)
        )
    )
        return false
    if (
        rule.selector === "feature" &&
        !rows(P + "feature.ProductFeatureAppl", {productId: c.productId, productFeatureId: rule.productFeatureId}).some(
            r => active(r, c.validDate) && r.applTypeEnumId !== "PfatSelectable"
        )
    )
        return false
    const product = one(P + "Product", {productId: c.productId}),
        quantity = conversion(
            c.quantity,
            c.quantityUomId || product?.amountUomId,
            rule.quantityUomId || c.quantityUomId || product?.amountUomId,
            c.validDate
        )
    return (
        toDecimal(rule.minQuantity || 0).compare(quantity) <= 0 &&
        (rule.maxQuantity == null || toDecimal(rule.maxQuantity).compare(quantity) > 0)
    )
}
function evaluate(list, c, path = []) {
    if (path.includes(list.priceListId)) throw new Error("Price-list cycle at " + list.priceListId)
    const rules = rows(P + "ProductPriceRule", {priceListId: list.priceListId}).sort(
        (a, b) => Number(a.sequenceNum) - Number(b.sequenceNum) || String(a.priceRuleId).localeCompare(String(b.priceRuleId))
    )
    for (const rule of rules) {
        const eligible = eligibleRule(rule, c)
        step(c, {
            kind: "rule-candidate",
            sourceEntity: P + "ProductPriceRule",
            sourceId: rule.priceRuleId,
            eligible,
            reason: eligible ? "First eligible rule in sequence" : "Selector, tier, geography or effective date differs"
        })
        if (!eligible) continue
        let base, source
        if (rule.baseType === "fixed") base = toDecimal(rule.fixedPrice)
        else if (rule.baseType === "typed") {
            source = extras(
                Object.assign({}, c, {priceUomId: list.priceUomId}),
                fallback(Object.assign({}, c, {priceUomId: list.priceUomId}), rule.basePriceTypeEnumId)
            )
            if (!source) throw new Error("Missing " + rule.basePriceTypeEnumId + " base for rule " + rule.priceRuleId)
            base = source.price
        } else if (rule.baseType === "list") {
            const nested = policy().getList(rule.basePriceListId)
            if (!listEligible(nested, c))
                throw new Error("Base list " + rule.basePriceListId + " is not effective for this context")
            source = evaluate(nested, Object.assign({}, c, {priceUomId: nested.priceUomId}), path.concat(list.priceListId))
            if (!source) throw new Error("No eligible rule in base list " + rule.basePriceListId)
            base = conversion(source.price, nested.priceUomId, list.priceUomId, c.validDate, c)
        } else if (rule.baseType === "standard") {
            source = ec.resource
                .script("component://mr-mantle/service/mantle/product/Costs.js")
                .pricingBase(Object.assign({}, c, {priceUomId: list.priceUomId}))
            base = toDecimal(source.unitCost)
        } else throw new Error("Choose a supported price-rule base")
        const sensitive = rule.baseType === "standard" || source?.containsCostBase,
            hideCost = sensitive && !read("sales", true)
        const input = base,
            percentage = base.multiply(toDecimal(1).add(toDecimal(rule.percentChange || 0).divide(100))),
            adjusted = percentage.add(rule.amountChange || 0)
        let rounded = adjusted
        if (rule.roundingIncrement != null)
            rounded = adjusted.divide(rule.roundingIncrement).setScale(0, "HALF_UP").multiply(rule.roundingIncrement)
        let bounded = rounded
        if (rule.minimumPrice != null && bounded.compare(rule.minimumPrice) < 0) bounded = toDecimal(rule.minimumPrice)
        if (rule.maximumPrice != null && bounded.compare(rule.maximumPrice) > 0) bounded = toDecimal(rule.maximumPrice)
        if (bounded.compare(0) < 0) throw new Error("Rule " + rule.priceRuleId + " produces a negative price")
        if (!hideCost) {
            step(c, {
                kind: "rule-base",
                sourceEntity: P + "ProductPriceRule",
                sourceId: rule.priceRuleId,
                eligible: true,
                priceUomId: list.priceUomId,
                afterAmount: input,
                operation: rule.baseType
            })
            step(c, {kind: "percentage", beforeAmount: input, operand: rule.percentChange || 0, afterAmount: percentage})
            step(c, {kind: "adjustment", beforeAmount: percentage, operand: rule.amountChange || 0, afterAmount: adjusted})
            step(c, {kind: "rounding", beforeAmount: adjusted, operand: rule.roundingIncrement, afterAmount: rounded})
            step(c, {kind: "bounds", beforeAmount: rounded, afterAmount: bounded})
        } else
            step(c, {
                kind: "restricted-standard-base",
                eligible: true,
                reason: "Cost-read authority is required for the base and intermediate amounts"
            })
        const stockUnit = one(P + "Product", {productId: c.productId})?.amountUomId,
            unitFactor =
                rule.baseType === "fixed"
                    ? conversion(1, c.quantityUomId || stockUnit, rule.quantityUomId || c.quantityUomId || stockUnit, c.validDate)
                    : toDecimal(1)
        return {
            price: conversion(bounded.multiply(unitFactor), list.priceUomId, c.priceUomId, c.validDate, c),
            productPriceId: source?.productPriceId,
            priceListId: list.priceListId,
            priceRuleId: rule.priceRuleId,
            taxInPrice: source?.taxInPrice,
            containsCostBase: !!sensitive
        }
    }
    return null
}
function applyList(p) {
    const c = p.pricingContext || context(p)
    if (p.listModifierApplied) return {}
    if (!ec.user.userId || !read(c.direction)) return {listModifierApplied: true}
    let selected
    if (c.priceListId) {
        selected = policy().getList(c.priceListId)
        if (!listEligible(selected, c)) throw new Error("Selected price list is not effective for the transaction context")
    } else {
        const defaults = c.organizationPartyId
            ? rows(P + "ProductPricingSetting", {organizationPartyId: c.organizationPartyId})
                  .filter(r => active(r, c.validDate))
                  .sort((a, b) => ms(b.fromDate) - ms(a.fromDate))[0]
            : null
        if (defaults?.defaultPriceListId && c.direction === "sales") {
            const candidate = policy().getList(defaults.defaultPriceListId)
            if (
                listEligible(candidate, c) &&
                rows(P + "ProductPriceRule", {priceListId: candidate.priceListId}).some(r => eligibleRule(r, c))
            )
                selected = candidate
        }
        if (!selected)
            for (const list of rows(P + "ProductPriceList").sort(
                (a, b) =>
                    Number(a.priority || 0) - Number(b.priority || 0) ||
                    String(a.priceListId).localeCompare(String(b.priceListId))
            )) {
                try {
                    policy().getList(list.priceListId)
                } catch (e) {
                    continue
                }
                if (
                    listEligible(list, c) &&
                    rows(P + "ProductPriceRule", {priceListId: list.priceListId}).some(r => eligibleRule(r, c))
                ) {
                    selected = list
                    break
                }
            }
    }
    if (!selected) return {listModifierApplied: true}
    const result = evaluate(selected, c)
    if (!result) throw new Error("No eligible rule in price list " + selected.priceListId)
    step(c, {
        kind: "list-selected",
        sourceEntity: P + "ProductPriceList",
        sourceId: selected.priceListId,
        eligible: true,
        afterAmount: result.price,
        priceUomId: c.priceUomId
    })
    return Object.assign(result, {
        priceAvailable: true,
        priceSource: "price-list",
        priceTrace: c.priceTrace,
        listModifierApplied: true
    })
}
function finalize(p) {
    return {priceTrace: p.pricingContext?.traceAllowed ? p.priceTrace || [] : [], pricingContext: null, listModifierApplied: null}
}
function execute(op, p) {
    return {resolve, byType, applyList, finalize}[op](p)
}
;({execute})
