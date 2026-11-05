// Canonical SKU identities. All creators serialize on the virtual product; each combination is its own transaction.
const P = "mantle.product.",
    F = P + "feature.",
    PS = P + "ProductServices."
const find = (n, p) => ec.entity.find(n).condition(p || {})
const one = (n, p) => find(n, p).one()
const rows = (n, p) => Array.from(find(n, p).list())
const map = r => (r.getMap ? r.getMap() : Object.assign({}, r))
const ms = x => (x == null ? null : Number.isFinite(Number(String(x))) ? Number(String(x)) : Date.parse(String(x)))
const effective = (r, at = ms(ec.user.nowTimestamp)) =>
    (ms(r.fromDate) == null || ms(r.fromDate) <= at) && (ms(r.thruDate) == null || ms(r.thruDate) > at)
const call = (n, p) => {
    const out =
        ec.service
            .sync()
            .name(n)
            .parameters(p || {})
            .call() || {}
    if (ec.message.hasError()) throw new Error(ec.message.getErrorsString())
    return out
}
const safeCopy = [
    "description",
    "comments",
    "productClassEnumId",
    "amountUomId",
    "amountFixed",
    "amountRequire",
    "salesAllowed",
    "purchaseAllowed",
    "requireInventory",
    "chargeShipping",
    "taxable",
    "returnable",
    "originGeoId",
    "storageTypeEnumId"
]
const ids = v => [
    ...new Set(
        Array.isArray(v)
            ? v.map(String)
            : String(v || "")
                  .split(",")
                  .map(s => s.trim())
                  .filter(Boolean)
    )
]
const key = v => JSON.stringify(ids(v).sort())
// The identity's key: a feature key of 32 ids is too long for a key column on MySQL.
const featureHash = featureKey => ec.resource.digestText(featureKey)
function base(p) {
    const row = one(P + "Product", {productId: p.productId})
    if (!row) throw new Error("Virtual product is not available")
    return row
}
function features(p) {
    const allow = p.allowedFeatureIds == null ? null : new Set(ids(p.allowedFeatureIds)),
        groups = p.productFeatureGroupIdSet == null ? null : new Set(ids(p.productFeatureGroupIdSet)),
        result = new Map()
    const put = (id, source) => {
        if (allow && !allow.has(id)) return
        const f = one(F + "ProductFeature", {productFeatureId: id})
        if (f && !result.has(id))
            result.set(
                id,
                Object.assign({}, map(f), {
                    amount: source.amount || 0,
                    sourceStamp: source.lastUpdatedStamp,
                    sourceFromDate: source.fromDate
                })
            )
    }
    for (const a of rows(F + "ProductFeatureAppl", {productId: p.productId, applTypeEnumId: "PfatSelectable"}).filter(
        effectiveNow
    ))
        put(a.productFeatureId, a)
    for (const m of rows(P + "category.ProductCategoryMember", {productId: p.productId}).filter(effectiveNow))
        for (const g of rows(F + "ProductCategoryFeatGrpAppl", {
            productCategoryId: m.productCategoryId,
            applTypeEnumId: "PfatSelectable"
        }).filter(effectiveNow)) {
            if (groups && !groups.has(g.productFeatureGroupId)) continue
            for (const a of rows(F + "ProductFeatureGroupAppl", {productFeatureGroupId: g.productFeatureGroupId}).filter(
                effectiveNow
            ))
                put(a.productFeatureId, a)
        }
    return [...result.values()].sort(
        (a, b) =>
            String(a.productFeatureTypeEnumId).localeCompare(String(b.productFeatureTypeEnumId)) ||
            Number(a.defaultSequenceNum || 0) - Number(b.defaultSequenceNum || 0) ||
            String(a.productFeatureId).localeCompare(String(b.productFeatureId))
    )
}
// Array.filter supplies an index as its second argument; never use effective directly as the callback.
const effectiveNow = r => effective(r)
function schema(p) {
    const b = base(p),
        all = features(p),
        filterIds = p.filterFeatureIds == null ? null : new Set(ids(p.filterFeatureIds)),
        types = {}
    if (filterIds && [...filterIds].some(id => !all.some(f => f.productFeatureId === id)))
        throw new Error("Filter feature is no longer selectable")
    for (const f of all) (types[f.productFeatureTypeEnumId] ||= []).push(f)
    const axes = Object.keys(types)
        .sort()
        .map(id => ({
            enumId: id,
            description: one("moqui.basic.Enumeration", {enumId: id})?.description || id,
            featureInfoList: types[id].filter(
                f =>
                    !filterIds ||
                    !all.some(v => v.productFeatureTypeEnumId === id && filterIds.has(v.productFeatureId)) ||
                    filterIds.has(f.productFeatureId)
            )
        }))
    let total = axes.length ? 1 : 0
    for (const a of axes) total *= a.featureInfoList.length
    if (!Number.isSafeInteger(total) || total > 100000000)
        throw new Error("Narrow the feature selection to at most 100 million combinations")
    const copy = p.copyFields == null ? safeCopy : ids(p.copyFields)
    if (copy.some(f => !safeCopy.includes(f))) throw new Error("A requested field is outside the safe copy allowlist")
    const rules = rows(F + "ProductFeatureIactn")
        .filter(r => !r.productId || r.productId === p.productId)
        .map(map)
        .sort((a, b) =>
            key([a.productFeatureId, a.toProductFeatureId]).localeCompare(key([b.productFeatureId, b.toProductFeatureId]))
        )
    const categories = p.copyCategoryMembers
        ? rows(P + "category.ProductCategoryMember", {productId: p.productId})
              .filter(effectiveNow)
              .filter(r => p.allowedCategoryIds == null || ids(p.allowedCategoryIds).includes(r.productCategoryId))
              .map(map)
        : []
    const standards = rows(F + "ProductFeatureAppl", {productId: p.productId, applTypeEnumId: "PfatStandard"})
        .filter(effectiveNow)
        .filter(r => p.allowedFeatureIds == null || ids(p.allowedFeatureIds).includes(r.productFeatureId))
        .map(map)
    // A revision is a point-in-time fingerprint, not a persisted copy of the business record.
    const revision = ec.user.singleUseCodeHash(
        JSON.stringify({
            base: {
                productId: b.productId,
                pseudoId: b.pseudoId,
                productName: b.productName,
                ownerPartyId: b.ownerPartyId,
                statusId: b.statusId,
                fields: Object.fromEntries(copy.map(f => [f, b[f]]))
            },
            features: all,
            rules,
            categories,
            standards,
            copy,
            copyCategories: !!p.copyCategoryMembers,
            productType: p.productTypeEnumId || "PtAsset",
            assetType: p.assetTypeEnumId || b.assetTypeEnumId,
            assetClass: p.assetClassEnumId || b.assetClassEnumId,
            policyStamp: p.policyStamp || null
        })
    )
    return {b, all, axes, total, copy, rules, categories, standards, revision}
}
function combination(s, index) {
    const selected = []
    for (let i = s.axes.length - 1; i >= 0; i--) {
        const f = s.axes[i].featureInfoList
        selected.unshift(f[index % f.length].productFeatureId)
        index = Math.floor(index / f.length)
    }
    return selected
}
function existing(s, selected) {
    const featureKey = key(selected),
        identity = one(P + "ProductVariantIdentity", {baseProductId: s.b.productId, featureHash: featureHash(featureKey)})
    if (identity) return identity.productId
    // Adopt compatible legacy variants, using exact effective distinguishing features, never a historical or standard superset.
    for (const assoc of rows(P + "ProductAssocAndToFeatureAppl", {
        productId: s.b.productId,
        productAssocTypeEnumId: "PatVariant",
        applTypeEnumId: "PfatDistinguishing",
        productFeatureId: ids(selected)[0] || ""
    }).filter(effectiveNow)) {
        if (
            key(
                rows(F + "ProductFeatureAppl", {productId: assoc.toProductId, applTypeEnumId: "PfatDistinguishing"})
                    .filter(effectiveNow)
                    .map(f => f.productFeatureId)
            ) === featureKey
        )
            return assoc.toProductId
    }
    return null
}
function inspect(s, selected, p) {
    selected = ids(selected)
    const featureKey = key(selected),
        problems = [],
        chosen = selected.map(id => s.all.find(f => f.productFeatureId === id))
    if (!selected.length || selected.length > 32) problems.push("Choose between 1 and 32 distinguishing features")
    if (chosen.some(f => !f)) problems.push("A feature is no longer selectable")
    if (
        s.axes.some(a => chosen.filter(f => f?.productFeatureTypeEnumId === a.enumId).length !== 1) ||
        chosen.length !== s.axes.length
    )
        problems.push("Choose exactly one feature of every selectable type")
    for (const rule of s.rules) {
        const a = selected.includes(rule.productFeatureId),
            b = selected.includes(rule.toProductFeatureId)
        if (rule.iactnTypeEnumId === "PfitDependency" && a && !b) problems.push("A required feature is missing")
        if (rule.iactnTypeEnumId === "PfitIncompatible" && a && b) problems.push("Features are incompatible")
    }
    const ordered = chosen
        .filter(Boolean)
        .sort((a, b) => String(a.productFeatureTypeEnumId).localeCompare(String(b.productFeatureTypeEnumId)))
    const sku = (s.b.pseudoId || s.b.productId) + ordered.map(f => "_" + (f.abbrev || f.productFeatureId)).join("")
    const existingProductId = existing(s, selected)
    if (!existingProductId && !/^[A-Za-z0-9_.-]{1,40}$/.test(sku))
        problems.push("Proposed SKU must contain 1–40 letters, numbers, dots, dashes or underscores")
    if (!existingProductId && one(P + "Product", {productId: sku}))
        problems.push("Proposed SKU is already used by another product")
    const extra = ordered.reduce((sum, f) => sum.add(f.amount || 0), toDecimal(0))
    return {
        featureKey,
        productFeatureIds: selected.sort(),
        combination: ordered.map(f => f.description || f.productFeatureId).join(" / "),
        proposedProductId: sku,
        existingProductId,
        allowed: problems.length === 0,
        reason: problems.join("; "),
        featureExtra: extra,
        chosen: ordered
    }
}
function preview(p) {
    const s = schema(p),
        pageSize = Math.max(1, Math.min(100, Number(p.pageSize || 50))),
        pageIndex = Math.max(0, Math.min(Math.max(0, Math.ceil(s.total / pageSize) - 1), Number(p.pageIndex || 0))),
        result = []
    for (let i = pageIndex * pageSize; i < Math.min(s.total, (pageIndex + 1) * pageSize); i++) {
        const r = inspect(s, combination(s, i), p)
        delete r.chosen
        result.push(r)
    }
    return {
        rows: result,
        totalCount: s.total,
        pageIndex,
        pageSize,
        previewRevision: s.revision,
        featureTypeInfoList: s.axes.map(a =>
            Object.assign({}, a, {
                featureInfoList: s.all
                    .filter(f => f.productFeatureTypeEnumId === a.enumId)
                    .map(f => {
                        return Object.fromEntries(
                            [
                                "productFeatureId",
                                "productFeatureTypeEnumId",
                                "description",
                                "abbrev",
                                "idCode",
                                "defaultSequenceNum",
                                "numberSpecified",
                                "numberUomId",
                                "amount"
                            ].map(k => [k, f[k]])
                        )
                    })
            })
        ),
        copyFields: s.copy
    }
}
function createOne(p) {
    const b = p.product || base(p),
        productId = b.productId
    // Feature identity edits and activation take the same type lock; do not hold this lock in the batch coordinator.
    find("moqui.basic.EnumerationType", {enumTypeId: "ProductFeatureIactnType"}).forUpdate(true).one()
    find("moqui.basic.EnumerationType", {enumTypeId: "ProductFeatureType"}).forUpdate(true).one()
    find(P + "Product", {productId})
        .forUpdate(true)
        .one()
    const args = Object.assign({}, p, {productId}),
        s = schema(args),
        selected = p.productFeatureIds || Array.from(p.featureList || [], f => f.productFeatureId),
        r = inspect(s, selected, args)
    if (p.previewRevision && p.previewRevision !== s.revision)
        throw new Error("Variant preview changed; preview again before generating")
    if (!r.allowed) throw new Error(r.reason)
    if (r.existingProductId) {
        if (
            p.requiredOwnerPartyId &&
            one(P + "Product", {productId: r.existingProductId})?.ownerPartyId !== p.requiredOwnerPartyId
        )
            throw new Error("Existing combination is not available")
        if (!one(P + "ProductVariantIdentity", {baseProductId: productId, featureHash: featureHash(r.featureKey)}))
            call("create#" + P + "ProductVariantIdentity", {
                baseProductId: productId,
                featureHash: featureHash(r.featureKey),
                featureKey: r.featureKey,
                productId: r.existingProductId
            })
        return {productId: r.existingProductId, featureKey: r.featureKey, result: "existing"}
    }
    const type = p.productTypeEnumId || "PtAsset"
    if (one("moqui.basic.Enumeration", {enumId: type})?.enumTypeId !== "ProductType" || type === "PtVirtual")
        throw new Error("Choose a non-virtual variant product type")
    const data = Object.assign(Object.fromEntries(s.copy.map(f => [f, s.b[f]])), {
        productId: r.proposedProductId,
        pseudoId: r.proposedProductId,
        productName: s.b.productName + " " + r.chosen.map(f => f.description).join(" "),
        productTypeEnumId: type,
        assetTypeEnumId: p.assetTypeEnumId || s.b.assetTypeEnumId,
        assetClassEnumId: p.assetClassEnumId || s.b.assetClassEnumId,
        ownerPartyId: s.b.ownerPartyId,
        statusId: "PrdDraft"
    })
    call("create#" + P + "Product", data)
    call("create#" + P + "ProductAssoc", {
        productId,
        toProductId: data.productId,
        productAssocTypeEnumId: "PatVariant",
        fromDate: ec.user.nowTimestamp
    })
    for (const f of r.chosen)
        call("create#" + F + "ProductFeatureAppl", {
            productId: data.productId,
            productFeatureId: f.productFeatureId,
            applTypeEnumId: "PfatDistinguishing",
            fromDate: ec.user.nowTimestamp
        })
    if (p.copyStandardFeatures !== false)
        for (const f of s.standards.filter(f => !r.productFeatureIds.includes(f.productFeatureId)))
            call("create#" + F + "ProductFeatureAppl", {
                productId: data.productId,
                productFeatureId: f.productFeatureId,
                applTypeEnumId: "PfatStandard",
                fromDate: ec.user.nowTimestamp,
                amount: f.amount,
                recurringAmount: f.recurringAmount,
                sequenceNum: f.sequenceNum
            })
    for (const c of s.categories)
        call("create#" + P + "category.ProductCategoryMember", {
            productId: data.productId,
            productCategoryId: c.productCategoryId,
            fromDate: ec.user.nowTimestamp,
            sequenceNum: c.sequenceNum
        })
    call("create#" + P + "ProductVariantIdentity", {
        baseProductId: productId,
        featureHash: featureHash(r.featureKey),
        featureKey: r.featureKey,
        productId: data.productId
    })
    if (ec.message.hasError()) throw new Error(ec.message.getErrorsString())
    return {productId: data.productId, featureKey: r.featureKey, result: "created"}
}
function create(p) {
    const s = schema(p),
        selected = p.selectedFeatureSets == null ? null : Array.from(p.selectedFeatureSets),
        count = selected ? selected.length : s.total
    if (p.previewRevision && p.previewRevision !== s.revision)
        throw new Error("Variant preview changed; preview again before generating")
    if (selected && count > Number(p.interactiveLimit || 1000))
        throw new Error("Selection exceeds the interactive limit; submit a durable batch")
    const result = [],
        seen = new Set()
    for (let i = 0; i < count; i++) {
        const set = selected ? (Array.isArray(selected[i]) ? selected[i] : selected[i].productFeatureIds) : combination(s, i),
            featureKey = key(set)
        if (seen.has(featureKey)) continue
        seen.add(featureKey)
        ec.message.pushErrors()
        try {
            let creator = ec.service
                .sync()
                .name(PS + "create#VariantProduct")
                .parameters(Object.assign({}, p, {product: s.b, productFeatureIds: ids(set)}))
            if (selected) creator = creator.requireNewTransaction(true)
            const out = creator.call() || {}
            if (ec.message.hasError()) throw new Error(ec.message.getErrorsString())
            result.push(out)
        } catch (e) {
            ec.logger.error("Variant combination " + featureKey + " failed: " + e)
            result.push({featureKey, result: "failed", error: String(e.message || e)})
        } finally {
            ec.message.clearErrors()
            ec.message.popErrors()
        }
    }
    return {
        results: result,
        createdCount: result.filter(r => r.result === "created").length,
        existingCount: result.filter(r => r.result === "existing").length,
        failedCount: result.filter(r => r.result === "failed").length
    }
}
function info(p) {
    const s = schema(p),
        out = {featureTypeInfoList: s.axes, productInfoList: [], isDiscounted: false},
        prices = []
    for (const a of rows(P + "ProductAssoc", {productId: p.productId, productAssocTypeEnumId: "PatVariant"}).filter(
        effectiveNow
    )) {
        const b = one(P + "Product", {productId: a.toProductId})
        if (!b) continue
        const fs = rows(F + "ProductFeatureAppl", {productId: b.productId, applTypeEnumId: "PfatDistinguishing"})
            .filter(effectiveNow)
            .map(f => one(F + "ProductFeature", {productFeatureId: f.productFeatureId}))
            .filter(Boolean)
            .sort((a, b) => String(a.productFeatureTypeEnumId).localeCompare(String(b.productFeatureTypeEnumId)))
        const r = {
            productId: b.productId,
            pseudoId: b.pseudoId,
            productName: b.productName,
            productFeatureIdByTypeId: Object.fromEntries(fs.map(f => [f.productFeatureTypeEnumId, f.productFeatureId]))
        }
        fs.slice(0, 3).forEach((f, i) => (r["productFeatureId" + (i + 1)] = f.productFeatureId))
        // Callers such as BOSS may expressly suppress restricted prices before any resolver is invoked.
        if (p.includePrices !== false) {
            ec.message.pushErrors()
            try {
                const price = call(
                    "mantle.product.PriceServices.get#ProductPrice",
                    Object.assign({}, p, {productId: b.productId})
                )
                Object.assign(r, {price: price.price, listPrice: price.listPrice, priceUomId: price.priceUomId})
                if (price.price != null) prices.push(toDecimal(price.price))
                if (price.listPrice != null && price.price != null && toDecimal(price.price).compare(price.listPrice) < 0)
                    out.isDiscounted = true
            } catch (e) {
                ec.logger.error("Variant price " + b.productId + " failed: " + e)
            } finally {
                ec.message.clearErrors()
                ec.message.popErrors()
            }
        }
        if (p.productStoreId && p.getAvailableInventory) {
            ec.message.pushErrors()
            try {
                r.availableToPromiseTotal = call("mantle.product.AssetServices.get#AvailableInventory", {
                    productId: b.productId,
                    productStoreId: p.productStoreId
                }).availableToPromiseTotal
            } catch (e) {
                ec.logger.error("Variant inventory " + b.productId + " failed: " + e)
            } finally {
                ec.message.clearErrors()
                ec.message.popErrors()
            }
        }
        r.smallImageProductContentId = rows(P + "ProductContent", {
            productId: b.productId,
            productContentTypeEnumId: "PcntImageSmall"
        }).filter(effectiveNow)[0]?.productContentId
        out.productInfoList.push(r)
    }
    if (prices.length) {
        prices.sort((a, b) => a.compare(b))
        out.minPrice = prices[0]
        out.maxPrice = prices[prices.length - 1]
    }
    return out
}
function groups(p) {
    const groupIds = new Set()
    for (const m of rows(P + "category.ProductCategoryMember", {productId: p.productId}).filter(effectiveNow))
        for (const g of rows(F + "ProductCategoryFeatGrpAppl", {productCategoryId: m.productCategoryId})
            .filter(effectiveNow)
            .filter(g => !p.applTypeEnumId || g.applTypeEnumId === p.applTypeEnumId))
            if (p.productFeatureGroupIdSet == null || ids(p.productFeatureGroupIdSet).includes(g.productFeatureGroupId))
                groupIds.add(g.productFeatureGroupId)
    return {
        productFeatureGroupList: [...groupIds]
            .map(id => one(F + "ProductFeatureGroup", {productFeatureGroupId: id}))
            .filter(Boolean)
    }
}
function execute(op, p) {
    // Ordinary Mantle readers retain their entity filters. BOSS supplies its checked owner scope before invoking these.
    if (["preview", "info", "groups"].includes(op)) return {preview, info, groups}[op](p)
    base({productId: p.productId || p.product?.productId})
    const was = ec.artifactExecution.disableAuthz()
    try {
        return {create, createOne}[op](p)
    } finally {
        if (!was) ec.artifactExecution.enableAuthz()
    }
}
;({execute, safeCopy})
