// Read-only catalog readiness. Each check is isolated, and evidence never widens the caller's record scope.
const policy = () => ec.resource.script("component://mr-mantle/service/mantle/product/CatalogPolicy.js"),
    access = () => ec.resource.script("component://mr-mantle/service/mantle/product/ProductAccess.js")
const rows = (n, p = {}) => policy().rows(n, p),
    one = (n, p) => policy().one(n, p),
    call = (n, p = {}) => {
        const result = ec.service.sync().name(n).parameters(p).disableAuthz().requireNewTransaction(true).call() || {}
        if (ec.message.hasError()) throw new Error(ec.message.getErrorsString())
        return result
    },
    map = r => policy().map(r),
    active = (r, d) => policy().active(r, d),
    ms = v => policy().ms(v)
const definitions = [
    ["requiredFields", "Required fields"],
    ["identifiers", "Duplicate or invalid identifiers"],
    ["prices", "Missing or overlapping prices"],
    ["variants", "Variant uniqueness"],
    ["conversions", "Invalid quantity conversions"],
    ["categoryCycles", "Category cycles"],
    ["estimates", "Incomplete estimates"],
    ["legacyPacks", "Legacy pack content"],
    ["kitCycles", "Kit component cycles"],
    ["caseUnits", "Case units on prices"]
]
const hasAny = names => names.some(n => access().has(n)),
    costRead = () => hasAny(["PRODUCT_COST_VIEW", "PRODUCT_COST_ESTIMATE", "PRODUCT_COST_APPROVE"]),
    priceRead = () => hasAny(["PRICE_VIEW", "PRICE_EDIT", "SUPPLIER_PRICE_VIEW", "SUPPLIER_PRICE_EDIT"])
function options() {
    return definitions
        .filter(([id]) => !["prices", "caseUnits"].includes(id) || priceRead())
        .filter(([id]) => id !== "estimates" || costRead())
        .map(([value, label]) => ({value, label}))
}
function settings(org, date) {
    const r = rows("mantle.product.ProductCatalogSetting", {organizationPartyId: org})
        .filter(r => active(r, date))
        .sort((a, b) => ms(b.fromDate) - ms(a.fromDate))[0]
    return {
        defaultCurrencyUomId: r?.defaultCurrencyUomId || "USD",
        requiredFields: r
            ? String(r.requiredFields || "")
                  .split(",")
                  .map(s => s.trim())
                  .filter(Boolean)
            : ["productName", "productTypeEnumId", "amountUomId"]
    }
}
function validate(p) {
    const s = policy().scope(p),
        date = p.asOfDate || ec.user.nowTimestamp
    if (!Number.isFinite(ms(date))) throw new Error("Choose a valid check date")
    const allowed = options(),
        requested =
            p.checkIds == null
                ? allowed.map(r => r.value)
                : Array.isArray(p.checkIds)
                  ? p.checkIds
                  : String(p.checkIds)
                        .split(/[\s,]+/)
                        .filter(Boolean)
    if (requested.some(id => !allowed.some(r => r.value === id)))
        throw new Error("A selected check is unknown or needs additional read authority")
    const selected = new Set(requested),
        issues = [],
        productRows = [],
        examined = new Set(),
        checkedCategories = new Set(),
        add = (product, checkId, severity, evidence, action = "Review the product") =>
            issues.push({
                productId: product?.productId || null,
                productName: product?.productName || null,
                checkId,
                severity,
                evidence,
                suggestedAction: action
            })
    const category = id => {
        const r = one("mantle.product.category.ProductCategory", {productCategoryId: id})
        if (!r || (!s.systemAdmin && !s.ownerPartyIds.includes(r.ownerPartyId || "_NA_")))
            throw new Error("Catalog category is not available")
        return r
    }
    let categoryIds = null
    if (p.productCategoryId) {
        category(p.productCategoryId)
        categoryIds = new Set([p.productCategoryId])
        if (p.includeDescendants) {
            let frontier = [p.productCategoryId]
            for (let depth = 0; frontier.length && depth < 100; depth++) {
                const next = []
                for (const id of frontier)
                    for (const edge of rows("mantle.product.category.ProductCategoryRollup", {
                        parentProductCategoryId: id
                    }).filter(r => active(r, date)))
                        try {
                            category(edge.productCategoryId)
                            if (!categoryIds.has(edge.productCategoryId)) {
                                categoryIds.add(edge.productCategoryId)
                                next.push(edge.productCategoryId)
                            }
                        } catch (e) {
                            ec.logger.error("Catalog category " + edge.productCategoryId + ": " + e)
                        }
                frontier = next
            }
        }
    }
    const ids =
            p.productIds == null
                ? null
                : Array.isArray(p.productIds)
                  ? p.productIds
                  : String(p.productIds)
                        .split(/[\s,]+/)
                        .filter(Boolean),
        candidates = Array.isArray(p.candidateProducts) ? p.candidateProducts : []
    if (candidates.length && !s.edit) throw new Error("Catalog edit authority is required to check proposed rows")
    if ((ids?.length || 0) + candidates.length > 5000) throw new Error("Check at most 5000 selected products")
    const addProduct = r => {
        if (examined.has(r.productId)) return
        if (p.organizationPartyId && (r.ownerPartyId || "_NA_") !== "_NA_" && r.ownerPartyId !== s.organizationPartyId) return
        if (!p.includeInactive && ["PrdObsolete", "PrdDiscontinued"].includes(r.statusId)) return
        if (
            categoryIds &&
            !rows("mantle.product.category.ProductCategoryMember", {productId: r.productId}).some(
                m => categoryIds.has(m.productCategoryId) && active(m, date)
            )
        )
            return
        examined.add(r.productId)
        productRows.push(map(r))
    }
    if (ids)
        for (const id of ids)
            try {
                addProduct(policy().product(id, s))
            } catch (e) {
                ec.logger.error("Catalog product " + id + ": " + e)
                add({productId: id}, "record", "error", "Product is not available")
            }
    else
        for (const r of rows("mantle.product.Product"))
            if (s.systemAdmin || s.ownerPartyIds.includes(r.ownerPartyId || "_NA_")) addProduct(r)
    for (const proposed of candidates)
        try {
            const old = one("mantle.product.Product", {productId: proposed.productId})
            if (old) policy().product(proposed.productId, s)
            if (!s.systemAdmin && !s.organizationPartyIds.includes(proposed.ownerPartyId || old?.ownerPartyId))
                throw new Error("Proposed product owner is not available")
            const data = Object.assign({}, old ? map(old) : {}, proposed)
            const i = productRows.findIndex(r => r.productId === data.productId)
            if (i >= 0) productRows[i] = data
            else addProduct(data)
        } catch (e) {
            ec.logger.error("Catalog proposed product " + proposed.productId + ": " + e)
            add({productId: proposed.productId}, "record", "error", "Product or owner is not available")
        }
    const run = (product, id, fn) => {
        if (!selected.has(id)) return
        try {
            fn()
        } catch (e) {
            ec.logger.error("Catalog check " + id + " product " + product.productId + ": " + e)
            ec.message.clearErrors()
            add(product, id, "error", String(e.message || e), "Correct this record and retry this check")
        }
    }
    const graph = (start, edges, key, read) => {
        const walk = (id, path = []) => {
            if (path.includes(id)) throw new Error("Cycle: " + [...path, id].join(" → "))
            if (path.length >= 100) throw new Error("Graph exceeds 100 levels")
            for (const edge of edges(id).filter(r => active(r, date))) {
                read(edge[key])
                walk(edge[key], [...path, id])
            }
        }
        walk(start)
    }
    for (const product of productRows) {
        run(product, "requiredFields", () => {
            for (const field of settings(product.ownerPartyId, date).requiredFields)
                if (product[field] == null || product[field] === "")
                    add(product, "requiredFields", "error", "Required field is empty: " + field, "Fill " + field)
        })
        run(product, "identifiers", () => {
            for (const n of ["mantle.product.ProductIdentification", "mantle.product.ProductOtherIdentification"])
                for (const r of rows(n, {productId: product.productId})) {
                    const result = call("mantle.product.ProductServices.validate#ProductIdentifier", {
                        productId: product.productId,
                        productIdTypeEnumId: r.productIdTypeEnumId,
                        idValue: r.idValue,
                        asOfDate: date
                    })
                    for (const issue of result.issues)
                        add(product, "identifiers", "error", r.productIdTypeEnumId + ": " + issue, "Review the typed identifier")
                }
        })
        let readablePrices = null
        const prices = () => {
            if (!readablePrices)
                readablePrices =
                    call("mantle.product.PriceServices.find#ProductPrices", {productId: product.productId, includeHistory: true})
                        .productPriceList || []
            return readablePrices
        }
        run(product, "prices", () => {
            const all = prices().filter(r => r.priceTypeEnumId !== "PptAverage"),
                now = all.filter(r => active(r, date))
            if (
                product.salesAllowed !== "N" &&
                product.productTypeEnumId !== "PtVirtual" &&
                hasAny(["PRICE_VIEW", "PRICE_EDIT"]) &&
                !now.some(
                    r => !r.vendorPartyId || one("mantle.party.PartyRole", {partyId: r.vendorPartyId, roleTypeId: "OrgInternal"})
                ) &&
                !call("mantle.product.PriceServices.get#ProductPrice", {
                    productId: product.productId,
                    vendorPartyId: one("mantle.party.PartyRole", {partyId: product.ownerPartyId, roleTypeId: "OrgInternal"})
                        ? product.ownerPartyId
                        : s.organizationPartyId,
                    organizationPartyId: one("mantle.party.PartyRole", {partyId: product.ownerPartyId, roleTypeId: "OrgInternal"})
                        ? product.ownerPartyId
                        : s.organizationPartyId,
                    direction: "sales",
                    quantity: 1,
                    quantityUomId: product.amountUomId,
                    validDate: date,
                    priceUomId: settings(product.ownerPartyId, date).defaultCurrencyUomId
                }).priceAvailable
            )
                add(
                    product,
                    "prices",
                    "warning",
                    "No effective readable selling price",
                    "Add a selling price or a price-list rule"
                )
            const keys = [
                "priceTypeEnumId",
                "priceUomId",
                "productStoreId",
                "vendorPartyId",
                "customerPartyId",
                "pricePurposeEnumId",
                "quantityUomId",
                "termUomId",
                "agreementId",
                "agreementItemSeqId"
            ]
            for (let i = 0; i < all.length; i++)
                for (let j = i + 1; j < all.length; j++) {
                    const a = all[i],
                        b = all[j]
                    if (
                        keys.every(k => String(a[k] ?? "") === String(b[k] ?? "")) &&
                        toDecimal(a.minQuantity || 0).compare(b.minQuantity || 0) === 0 &&
                        Math.max(ms(a.fromDate) ?? -Infinity, ms(b.fromDate) ?? -Infinity) <
                            Math.min(ms(a.thruDate) ?? Infinity, ms(b.thruDate) ?? Infinity)
                    )
                        add(
                            product,
                            "prices",
                            "error",
                            "Price intervals overlap: " + a.productPriceId + " and " + b.productPriceId,
                            "End-date the overlapping tier"
                        )
                }
        })
        run(product, "variants", () => {
            for (const association of rows("mantle.product.ProductAssoc", {
                toProductId: product.productId,
                productAssocTypeEnumId: "PatVariant"
            }).filter(r => active(r, date))) {
                policy().product(association.productId, s)
                const features = id =>
                        rows("mantle.product.feature.ProductFeatureAppl", {productId: id, applTypeEnumId: "PfatDistinguishing"})
                            .filter(r => active(r, date))
                            .map(r => r.productFeatureId)
                            .sort()
                            .join("|"),
                    identity = features(product.productId)
                for (const sibling of rows("mantle.product.ProductAssoc", {
                    productId: association.productId,
                    productAssocTypeEnumId: "PatVariant"
                }).filter(r => r.toProductId !== product.productId && active(r, date)))
                    try {
                        policy().product(sibling.toProductId, s)
                        if (identity && features(sibling.toProductId) === identity)
                            add(
                                product,
                                "variants",
                                "error",
                                "Distinguishing features also identify " + sibling.toProductId,
                                "Review the virtual product matrix"
                            )
                    } catch (e) {
                        ec.logger.error("Catalog variant " + sibling.toProductId + ": " + e)
                    }
            }
        })
        run(product, "conversions", () => {
            if (product.amountUomId) policy().unit(product.amountUomId)
            for (const r of rows("mantle.product.ProductUomDimension", {productId: product.productId})) {
                const u = one("moqui.basic.Uom", {uomId: r.uomId})
                if (!u || u.uomTypeEnumId === "UT_CURRENCY_MEASURE")
                    add(product, "conversions", "error", "Invalid dimension unit: " + (r.uomId || "empty"))
            }
            for (const r of rows("mantle.product.ProductAssoc", {
                productId: product.productId,
                productAssocTypeEnumId: "PatPackagingFor"
            }).filter(r => active(r, date)))
                ec.resource.script("component://mr-mantle/service/mantle/product/Packaging.js").content(r, s, date)
            for (const r of rows("moqui.basic.UomConversion", {uomId: product.amountUomId}).filter(r => active(r, date)))
                if (
                    !Number.isFinite(Number(r.conversionFactor)) ||
                    Number(r.conversionFactor) <= 0 ||
                    (toDecimal(r.conversionOffset || 0).compare(0) !== 0 &&
                        one("moqui.basic.Uom", {uomId: r.uomId})?.uomTypeEnumId !== "UT_TEMP_MEASURE")
                )
                    add(product, "conversions", "error", "Invalid conversion: " + r.uomConversionId)
        })
        run(product, "categoryCycles", () => {
            for (const membership of rows("mantle.product.category.ProductCategoryMember", {productId: product.productId}).filter(
                r => active(r, date)
            )) {
                category(membership.productCategoryId)
                checkedCategories.add(membership.productCategoryId)
                graph(
                    membership.productCategoryId,
                    id => rows("mantle.product.category.ProductCategoryRollup", {productCategoryId: id}),
                    "parentProductCategoryId",
                    category
                )
            }
        })
        run(product, "estimates", () => {
            const estimates = rows("mantle.product.cost.ProductStandardCost", {productId: product.productId}).filter(
                r => (s.systemAdmin || s.organizationPartyIds.includes(r.organizationPartyId)) && active(r, date)
            )
            if (product.productTypeEnumId !== "PtVirtual" && !estimates.some(r => r.state === "approved" && r.unitCost != null))
                add(product, "estimates", "warning", "No effective approved standard estimate", "Review standard costs")
            for (const r of estimates)
                if (r.state === "draft" || r.unitCost == null)
                    add(product, "estimates", "warning", "An estimate needs completion or approval", "Review standard costs")
        })
        run(product, "legacyPacks", () => {
            for (const r of rows("mantle.product.ProductDimension", {productId: product.productId}))
                if (["QuantityIncluded", "PiecesIncluded"].includes(r.dimensionTypeId))
                    add(
                        product,
                        "legacyPacks",
                        "warning",
                        "Legacy " + r.dimensionTypeId + " = " + String(r.value),
                        "Review a dated pack product; this value is not a conversion"
                    )
            if (priceRead())
                for (const r of prices())
                    if (r.quantityIncluded != null && toDecimal(r.quantityIncluded).compare(1) > 0)
                        add(
                            product,
                            "legacyPacks",
                            "warning",
                            "Legacy price quantityIncluded on " + r.productPriceId,
                            "Review a dated pack definition"
                        )
        })
        run(product, "kitCycles", () => {
            if (product.productTypeEnumId === "PtPickAssembly")
                graph(
                    product.productId,
                    id =>
                        one("mantle.product.Product", {productId: id})?.productTypeEnumId === "PtPickAssembly"
                            ? rows("mantle.product.ProductAssoc", {productId: id, productAssocTypeEnumId: "PatMfgBom"})
                            : [],
                    "toProductId",
                    id => policy().product(id, s)
                )
        })
        run(product, "caseUnits", () => {
            for (const r of prices()) {
                if (!r.quantityUomId) continue
                const u = one("moqui.basic.Uom", {uomId: r.quantityUomId})
                if (
                    !u ||
                    u.uomTypeEnumId === "UT_CURRENCY_MEASURE" ||
                    /PACK|CASE|BOX/.test(u.uomTypeEnumId || "") ||
                    (u.uomTypeEnumId === "UT_OTHER_MEASURE" && !["OTH_ea", "OTH_ct", "OTH_pp"].includes(r.quantityUomId))
                )
                    add(
                        product,
                        "caseUnits",
                        "error",
                        "Price " + r.productPriceId + " uses " + r.quantityUomId,
                        "Price the pack product in a compatible stock unit"
                    )
            }
        })
    }
    if (selected.has("categoryCycles") && (!ids || p.productCategoryId))
        for (const r of rows("mantle.product.category.ProductCategory")) {
            if (
                checkedCategories.has(r.productCategoryId) ||
                (categoryIds && !categoryIds.has(r.productCategoryId)) ||
                (!s.systemAdmin && !s.ownerPartyIds.includes(r.ownerPartyId || "_NA_")) ||
                (p.organizationPartyId && (r.ownerPartyId || "_NA_") !== "_NA_" && r.ownerPartyId !== s.organizationPartyId)
            )
                continue
            try {
                graph(
                    r.productCategoryId,
                    id => rows("mantle.product.category.ProductCategoryRollup", {productCategoryId: id}),
                    "parentProductCategoryId",
                    category
                )
            } catch (e) {
                ec.logger.error("Catalog category " + r.productCategoryId + ": " + e)
                issues.push({
                    productId: null,
                    productCategoryId: r.productCategoryId,
                    checkId: "categoryCycles",
                    severity: "error",
                    evidence: String(e.message || e),
                    suggestedAction: "Review the category parents"
                })
            }
        }
    const shown = p.severity ? issues.filter(r => r.severity === p.severity) : issues
    return {
        issueRows: shown,
        checkedCount: productRows.length,
        issueCount: shown.length,
        incompleteCount: new Set(shown.filter(r => r.severity === "error" && r.productId).map(r => r.productId)).size,
        missingPriceCount: new Set(shown.filter(r => r.checkId === "prices" && r.severity === "warning").map(r => r.productId))
            .size,
        valid: !issues.some(r => r.severity === "error"),
        checkOptions: allowed,
        asOfDate: date
    }
}
;({validate, settings, options})
