// Store merchandising (impl-commerce P3, COM-MERCH's publication part and SHOP-CATALOG's resolver core; design-commerce §4
// Merchandising and StoreCategories, design-shop §5): a store's assortment and its dated publication rows
// (ProductStoreProduct), the publication preview and batch, the resolver that answers whether a product is public in a store,
// the adoption proposal for a store with no publication, and the store's categories: its dated category roles
// (ProductStoreCategory), the moves of its rollups and its category membership.
//
// Each operation checks its permission (COMMERCE_VIEW to read, COMMERCE_MERCHANDISE to change the assortment and categories,
// COMMERCE_PUBLISH to publish, withdraw, exclude or restore) and the store's scope through StoreAdmin.js (the user's own
// organizations; a user with a current StoreStaff row works only those stores); reads and writes below the checks run
// without artifact authorization. Refusals carry reason codes (EntityLib.denied). Every change of what a store shows advances
// the generation of the sites selling from it (PublicSite.generation of each `shop` mount naming the store) in the change's
// transaction, so Shop's caches, search, sitemap and feeds drop it (impl-commerce §2).
//
// The resolver (get#StorePublication): a product is public in a store only by a current publication row of it, or of its
// virtual product with no current exclusion row of the variant, intersected with sellability (check#ProductUsable, Sell),
// the store's effective view-allow category (a store with one shows only its members and their descendants' members; an
// empty one shows nothing) and, given a site, an enabled `shop` mount of the site naming the store. Purchasable adds the
// purchase-allow category. Rows with no kind are published (made before P3); a store with no rows publishes nothing.
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const stores = ec.resource.script("component://mr-mantle/service/mantle/product/StoreAdmin.js")
const {find, one, rows, denied, call, ms, active, dateText, access} = lib
const S = "mantle.product.store."
const PUBLICATION = S + "ProductStoreProduct"
const STORE_CATEGORY = S + "ProductStoreCategory"
const ROLLUP = "mantle.product.category.ProductCategoryRollup"
const MEMBER = "mantle.product.category.ProductCategoryMember"
const CATEGORY = "mantle.product.category.ProductCategory"
const PRODUCT = "mantle.product.Product"
const ASSOC = "mantle.product.ProductAssoc"
const SITE = "mantle.public.PublicSite"
const SITE_APP = "mantle.public.PublicSiteApp"
const PUBLISHED = "PspkPublished"
const EXCLUDED = "PspkExcluded"

// ===== tables =====
// The batch actions and what each needs of the product's rows.
const actions = {publish: "Publish", withdraw: "Withdraw", exclude: "Exclude variant", restore: "Restore variant"}
// The store category roles that hold one category at a time ("(One)" in the seed): a new one ends the others' rows.
const singleRoles = [
    "PsctHomePage",
    "PsctBrowseRoot",
    "PsctSearch",
    "PsctPromotions",
    "PsctNewProducts",
    "PsctFeatured",
    "PsctViewAllow",
    "PsctPurchaseAllow",
    "PsctAdminAllow"
]
// Product types whose stock a store with requireInventory reserves.
const stockedTypes = ["PtAsset", "PtPickAssembly", "PtAssetUse"]
const treeDepthLimit = 8
const treeNodeLimit = 500
const batchLimit = 200
const proposalLimit = 500

// ===== values =====
// A refusal's code, also from a probe's error text ("Error: CODE: message"), and its message without the code.
const codeOf = error => lib.reasonCode(error) || (/([A-Z][A-Z0-9_]+):/.exec(String(error?.message ?? error)) || [])[1] || "ERROR"
const messageOf = error => String(error?.message ?? error).replace(/^(Error: )?([A-Z][A-Z0-9_]+: )?/, "")
const text = value => (value == null ? "" : String(value).trim())
const unique = list => Array.from(new Set(list.filter(Boolean)))
const nowMs = () => ms(ec.user.nowTimestamp)
const enumText = enumId => (enumId ? one("moqui.basic.Enumeration", {enumId})?.description || enumId : "")
const likeText = term => "%" + String(term).replace(/[\\%_]/g, character => "\\" + character) + "%"
const isTrue = value => value === true || value === "true" || value === "Y"
const listOf = value =>
    value == null || value === ""
        ? []
        : Array.isArray(value)
          ? value
          : typeof value === "string"
            ? value.split(",").map(item => item.trim())
            : Array.from(value)
const activeAt = (row, at) => (ms(row.fromDate) ?? -Infinity) <= at && (ms(row.thruDate) ?? Infinity) > at
const rowsIn = (entity, field, values, conditions = {}) =>
    values.length ? Array.from(find(entity, conditions).condition(field, "in", values).list()) : []
const productNames = ids =>
    Object.fromEntries(rowsIn(PRODUCT, "productId", unique(ids)).map(row => [row.productId, row.productName || row.productId]))
const categoryNames = ids =>
    Object.fromEntries(
        rowsIn(CATEGORY, "productCategoryId", unique(ids)).map(row => [
            row.productCategoryId,
            row.categoryName || row.productCategoryId
        ])
    )

// ===== scope =====
// The user's scope for a need: view (COMMERCE_VIEW), merchandise (COMMERCE_MERCHANDISE) or publish (COMMERCE_PUBLISH).
function scope(need) {
    const s = stores.scope("view")
    if (need === "merchandise" && !access.has("COMMERCE_MERCHANDISE"))
        denied("PERMISSION_DENIED", "COMMERCE_MERCHANDISE is required")
    if (need === "publish" && !access.has("COMMERCE_PUBLISH")) denied("PERMISSION_DENIED", "COMMERCE_PUBLISH is required")
    return s
}
// A product the store may carry: its owner is the store's organization or the shared catalog (_NA_, or none).
function productOf(store, productId) {
    const product = productId ? one(PRODUCT, {productId}) : null
    if (
        !product ||
        (product.ownerPartyId && product.ownerPartyId !== "_NA_" && product.ownerPartyId !== store.organizationPartyId)
    )
        denied("PRODUCT_UNAVAILABLE", "Product " + (productId || "") + " is not available to this store")
    return product
}
function categoryOf(store, productCategoryId) {
    const category = productCategoryId ? one(CATEGORY, {productCategoryId}) : null
    if (
        !category ||
        (category.ownerPartyId && category.ownerPartyId !== "_NA_" && category.ownerPartyId !== store.organizationPartyId)
    )
        denied("CATEGORY_UNAVAILABLE", "Category " + (productCategoryId || "") + " is not available to this store")
    return category
}

// ===== generation =====
// The sites selling from a store: the sites of the `shop` mounts naming it (Shop P1), read by target and app.
const storeSiteIds = productStoreId => unique(rows(SITE_APP, {app: "shop", targetId: productStoreId}).map(row => row.siteId))
// Advance each site's generation, in the caller's transaction; the sites and their new generations.
function advanceGeneration(productStoreIds) {
    const advanced = []
    for (const siteId of unique(listOf(productStoreIds).flatMap(storeSiteIds))) {
        const site = find(SITE, {siteId}).forUpdate(true).one()
        if (!site) continue
        const generation = Number(site.generation || 0) + 1
        call("update#" + SITE, {siteId, generation})
        advanced.push({siteId, generation})
    }
    return advanced
}
function siteGenerations(productStoreId) {
    return rowsIn(SITE, "siteId", storeSiteIds(productStoreId)).map(site => ({
        siteId: site.siteId,
        siteName: site.name || site.siteId,
        generation: Number(site.generation || 0),
        nextGeneration: Number(site.generation || 0) + 1
    }))
}

// ===== publication rows =====
const kindOf = row => row.publicationKindEnumId || PUBLISHED
// The store's rows of these products, by product.
function publicationRows(productStoreId, productIds) {
    const byProduct = new Map()
    for (const row of rowsIn(PUBLICATION, "productId", unique(productIds), {productStoreId})) {
        if (!byProduct.has(row.productId)) byProduct.set(row.productId, [])
        byProduct.get(row.productId).push(row)
    }
    return byProduct
}
// The row of a product in effect at a time (the latest start when rows overlap), and the next one to start after it.
function rowAt(list, at) {
    const current = (list || []).filter(row => activeAt(row, at)).sort((a, b) => (ms(b.fromDate) ?? 0) - (ms(a.fromDate) ?? 0))
    return current[0] || null
}
const laterRow = (list, at) =>
    (list || []).filter(row => (ms(row.fromDate) ?? -Infinity) > at).sort((a, b) => ms(a.fromDate) - ms(b.fromDate))[0] || null
// A product's publication state at a time: Published, Starts later, Withdrawn (rows that ended), Excluded or Not published.
function stateOf(list, at) {
    const current = rowAt(list, at)
    if (current) return kindOf(current) === EXCLUDED ? "excluded" : "published"
    if (laterRow(list, at)) return "scheduled"
    return list && list.length ? "withdrawn" : "unpublished"
}
const stateLabels = {
    published: ["Published", "positive"],
    scheduled: ["Starts later", "info"],
    withdrawn: ["Withdrawn", "grey-7"],
    excluded: ["Variant excluded", "warning"],
    unpublished: ["Not published", "grey-7"]
}
// The virtual products of variants (current PatVariant associations), by variant.
function virtualsOf(productIds, at) {
    const byVariant = new Map()
    for (const row of rowsIn(ASSOC, "toProductId", unique(productIds), {productAssocTypeEnumId: "PatVariant"})) {
        if (!activeAt(row, at)) continue
        if (!byVariant.has(row.toProductId)) byVariant.set(row.toProductId, [])
        byVariant.get(row.toProductId).push(row.productId)
    }
    return byVariant
}
const variantIdsOf = (productId, at) =>
    unique(
        rows(ASSOC, {productId, productAssocTypeEnumId: "PatVariant"})
            .filter(row => activeAt(row, at))
            .map(row => row.toProductId)
    )
const sellable = (productId, productStoreId) => {
    try {
        return call("mantle.product.ProductServices.check#ProductUsable", {productId, usage: "Sell", productStoreId})
    } catch (error) {
        ec.logger.error("Store publication: sellability of " + productId + " not read: " + error.message)
        return {usable: false, reason: "Sellability could not be read"}
    }
}

// ===== categories =====
// The current rollups below these categories, down to the depth limit: each category's children in sequence order.
function childrenOf(parentIds, at) {
    const byParent = new Map()
    for (const row of rowsIn(ROLLUP, "parentProductCategoryId", unique(parentIds))) {
        if (!activeAt(row, at)) continue
        if (!byParent.has(row.parentProductCategoryId)) byParent.set(row.parentProductCategoryId, [])
        byParent.get(row.parentProductCategoryId).push(row)
    }
    for (const list of byParent.values()) list.sort((a, b) => (a.sequenceNum ?? 0) - (b.sequenceNum ?? 0))
    return byParent
}
// These categories and every category below them now (or at a time).
function descendantsOf(categoryIds, at) {
    const seen = new Set(unique(categoryIds))
    let level = Array.from(seen)
    for (let depth = 0; level.length && depth < treeDepthLimit && seen.size < treeNodeLimit; depth++) {
        const next = []
        for (const list of childrenOf(level, at).values())
            for (const row of list)
                if (!seen.has(row.productCategoryId)) {
                    seen.add(row.productCategoryId)
                    next.push(row.productCategoryId)
                }
        level = next
    }
    return seen
}
// These categories and every category above them, through rollups current at the time or starting after it.
function ancestorsOf(categoryIds, at, includeLater = false) {
    const seen = new Set(unique(categoryIds))
    let level = Array.from(seen)
    for (let depth = 0; level.length && depth < treeDepthLimit * 2; depth++) {
        const next = []
        for (const row of rowsIn(ROLLUP, "productCategoryId", level))
            if (
                (activeAt(row, at) || (includeLater && (ms(row.fromDate) ?? -Infinity) > at)) &&
                !seen.has(row.parentProductCategoryId)
            ) {
                seen.add(row.parentProductCategoryId)
                next.push(row.parentProductCategoryId)
            }
        level = next
    }
    return seen
}
// The store's current category roles.
const storeCategoryRows = (productStoreId, at) => rows(STORE_CATEGORY, {productStoreId}).filter(row => activeAt(row, at))
// The products allowed by a store's role (PsctViewAllow, PsctPurchaseAllow) among these, or null when the store has none.
function allowedBy(productStoreId, roleEnumId, productIds, virtuals, at) {
    const roots = storeCategoryRows(productStoreId, at).filter(row => row.storeCategoryTypeEnumId === roleEnumId)
    if (!roots.length) return null
    const categories = Array.from(
        descendantsOf(
            roots.map(row => row.productCategoryId),
            at
        )
    )
    const candidates = unique(productIds.concat(...productIds.map(id => virtuals.get(id) || [])))
    const members = new Set(
        rowsIn(MEMBER, "productCategoryId", categories)
            .filter(row => activeAt(row, at) && candidates.includes(row.productId))
            .map(row => row.productId)
    )
    return new Set(productIds.filter(id => members.has(id) || (virtuals.get(id) || []).some(virtualId => members.has(virtualId))))
}
// The stores whose category tree reaches any of these categories now, split into the user's and the others' count.
function storesReaching(s, categoryIds, at) {
    const reach = Array.from(ancestorsOf(categoryIds, at, true))
    const storeIds = unique(
        rowsIn(STORE_CATEGORY, "productCategoryId", reach)
            .filter(row => activeAt(row, at) || (ms(row.fromDate) ?? -Infinity) > at)
            .map(row => row.productStoreId)
    )
    const mine = Array.from(
        stores
            .storeQuery(s)
            .condition("productStoreId", "in", storeIds.length ? storeIds : ["_NA_"])
            .list()
    )
    return {
        affectedStores: mine.map(row => ({productStoreId: row.productStoreId, storeName: row.storeName || row.productStoreId})),
        otherStoreCount: storeIds.length - mine.length
    }
}
// The affected stores of a category change: refused when another organization's (or another staff member's) store shares
// the category (copy the taxonomy instead), and when more than this store shares it without confirmShared.
function sharedCheck(s, store, categoryIds, at, p) {
    const shared = storesReaching(s, categoryIds, at)
    if (!shared.affectedStores.some(row => row.productStoreId === store.productStoreId))
        shared.affectedStores.unshift({productStoreId: store.productStoreId, storeName: store.storeName || store.productStoreId})
    if (!isTrue(p.previewOnly)) {
        if (shared.otherStoreCount > 0)
            denied(
                "CATEGORY_SHARED_OUTSIDE",
                "Stores you do not work also show this category; copy the store's categories to change them on their own"
            )
        if (shared.affectedStores.length > 1 && !isTrue(p.confirmShared))
            denied(
                "CATEGORY_SHARED",
                "This changes " + shared.affectedStores.map(row => row.storeName).join(", ") + "; confirm the shared change"
            )
    }
    return shared
}
// The categories in a store's tree now: its roles' categories and everything below them.
const storeTree = (productStoreId, at) =>
    descendantsOf(
        storeCategoryRows(productStoreId, at).map(row => row.productCategoryId),
        at
    )

// ===== resolver =====
// get#StorePublication: for each product (or, without products, the store's currently published rows a page at a time),
// whether it is public and purchasable in the store at the time (now unless asOfDate, which needs COMMERCE_VIEW and the
// store's scope), how (its own row or its virtual product's), why not, and its row's template, badge and rank.
function getStorePublication(p) {
    const now = nowMs()
    const at = p.asOfDate ? ms(p.asOfDate) : now
    if (!Number.isFinite(at)) denied("VALUE_INVALID", "Choose a valid date")
    const store = one(S + "ProductStore", {productStoreId: p.productStoreId || ""})
    if (Math.abs(at - now) > 1000) stores.storeOf(scope("view"), p.productStoreId)
    else if (!store) denied("RECORD_UNAVAILABLE", "Store " + (p.productStoreId || "") + " is not available")
    let productIds = unique(listOf(p.productIds).concat(p.productId ? [p.productId] : []))
    let paging = null
    if (!productIds.length) {
        const current = Array.from(
            find(PUBLICATION, {productStoreId: store.productStoreId}).orderBy("featuredRank,productId").list()
        ).filter(row => activeAt(row, at) && kindOf(row) === PUBLISHED)
        const listed = unique(current.map(row => row.productId))
        paging = lib.pageList(listed, p, "products")
        productIds = paging.products
    }
    const result = resolve(store, productIds, at, p.siteId || null)
    return Object.assign({productsCount: result.length}, paging || {}, {products: result})
}
function resolve(store, productIds, at, siteId) {
    const productStoreId = store.productStoreId
    const virtuals = virtualsOf(productIds, at)
    const allIds = unique(productIds.concat(...productIds.map(id => virtuals.get(id) || [])))
    const byProduct = publicationRows(productStoreId, allIds)
    const viewAllowed = allowedBy(productStoreId, "PsctViewAllow", productIds, virtuals, at)
    const purchaseAllowed = allowedBy(productStoreId, "PsctPurchaseAllow", productIds, virtuals, at)
    const siteOk =
        siteId == null || rows(SITE_APP, {siteId, app: "shop", targetId: productStoreId}).some(mount => mount.enabled !== "N")
    const names = productNames(productIds)
    return productIds.map(productId => {
        const own = rowAt(byProduct.get(productId), at)
        const virtualRow = (virtuals.get(productId) || [])
            .map(virtualId => ({virtualId, row: rowAt(byProduct.get(virtualId), at)}))
            .find(found => found.row && kindOf(found.row) === PUBLISHED)
        const excluded = !!own && kindOf(own) === EXCLUDED
        const via = own && !excluded ? "own" : !own && virtualRow ? "virtual" : null
        const row = via === "own" ? own : via === "virtual" ? virtualRow.row : null
        const sale = via ? sellable(productId, productStoreId) : {usable: false, reason: null}
        const viewOk = !viewAllowed || viewAllowed.has(productId)
        const purchaseOk = !purchaseAllowed || purchaseAllowed.has(productId)
        const isPublic = !!via && !!sale.usable && viewOk && siteOk
        const reasonCode = !via
            ? excluded
                ? "VARIANT_EXCLUDED"
                : "NOT_PUBLISHED"
            : !sale.usable
              ? "NOT_SELLABLE"
              : !viewOk
                ? "NOT_IN_VIEW_CATEGORY"
                : !siteOk
                  ? "SITE_NOT_SELLING"
                  : !purchaseOk
                    ? "NOT_IN_PURCHASE_CATEGORY"
                    : null
        return {
            productId,
            productName: names[productId] || productId,
            isPublic,
            purchasable: isPublic && purchaseOk,
            via,
            virtualProductId: via === "virtual" ? virtualRow.virtualId : null,
            reasonCode,
            sellReason: sale.usable ? null : sale.reason || null,
            fromDate: row?.fromDate ?? null,
            thruDate: row?.thruDate ?? null,
            templateKey: row?.templateKey || null,
            badgeText: row?.badgeText || null,
            featuredRank: row?.featuredRank ?? null
        }
    })
}

// ===== assortment =====
// find#StoreProducts: the products a store may carry (its organization's and the shared catalog's; variants under their
// virtual product unless asked), by id or name ignoring case, category, type and publication state, a page at a time, each
// with its state, its row in effect or next, price readiness and stock policy.
function findStoreProducts(p) {
    const s = scope("view")
    const store = stores.storeOf(s, p.productStoreId)
    const now = nowMs()
    const factory = ec.entity.conditionFactory
    const storeRows = rows(PUBLICATION, {productStoreId: store.productStoreId})
    const byProduct = new Map()
    for (const row of storeRows) {
        if (!byProduct.has(row.productId)) byProduct.set(row.productId, [])
        byProduct.get(row.productId).push(row)
    }
    const variantIds = unique(
        Array.from(find(ASSOC, {productAssocTypeEnumId: "PatVariant"}).selectField("toProductId").distinct(true).list()).map(
            row => row.toProductId
        )
    )
    let stateIds = null
    if (p.publicationState) {
        stateIds = Array.from(byProduct.keys()).filter(id => stateOf(byProduct.get(id), now) === p.publicationState)
        if (p.publicationState === "unpublished") stateIds = null
    }
    const memberIds = p.productCategoryId
        ? unique(
              rows(MEMBER, {productCategoryId: p.productCategoryId})
                  .filter(row => active(row))
                  .map(row => row.productId)
          )
        : null
    const build = () => {
        let query = find(PRODUCT).condition(
            factory.makeCondition(
                [
                    factory.makeCondition("ownerPartyId", "equals", store.organizationPartyId),
                    factory.makeCondition("ownerPartyId", "equals", "_NA_"),
                    factory.makeCondition("ownerPartyId", "is-null", null)
                ],
                "or"
            )
        )
        const term = text(p.term)
        if (term)
            query = query.condition(
                factory.makeCondition(
                    ["productId", "productName"].map(field => factory.makeCondition(field, "like", likeText(term)).ignoreCase()),
                    "or"
                )
            )
        if (p.productTypeEnumId) query = query.condition("productTypeEnumId", p.productTypeEnumId)
        if (!isTrue(p.includeVariants) && variantIds.length) query = query.condition("productId", "not-in", variantIds)
        if (memberIds) query = query.condition("productId", "in", memberIds.length ? memberIds : ["_NA_"])
        if (stateIds) query = query.condition("productId", "in", stateIds.length ? stateIds : ["_NA_"])
        if (p.publicationState === "unpublished" && byProduct.size)
            query = query.condition("productId", "not-in", Array.from(byProduct.keys()))
        return query
    }
    const count = build().count()
    const found = lib.page(build().orderBy("productName,productId"), p, "products", count)
    const facilityReady =
        !!store.inventoryFacilityId ||
        rows(S + "ProductStoreFacility", {productStoreId: store.productStoreId}).some(row => active(row))
    const products = found.rows.map(product => {
        const list = byProduct.get(product.productId) || []
        const state = stateOf(list, now)
        const row = rowAt(list, now) || laterRow(list, now)
        const variants = product.productTypeEnumId === "PtVirtual" ? variantIdsOf(product.productId, now) : []
        const stocked = stockedTypes.includes(product.productTypeEnumId)
        return {
            productId: product.productId,
            productName: product.productName || product.productId,
            productTypeEnumId: product.productTypeEnumId,
            productTypeText: enumText(product.productTypeEnumId),
            virtual: product.productTypeEnumId === "PtVirtual",
            variantCount: variants.length,
            publicationState: state,
            stateText: stateLabels[state][0],
            stateColor: stateLabels[state][1],
            fromDate: row?.fromDate ?? null,
            fromDateText: dateText(row?.fromDate),
            thruDate: row?.thruDate ?? null,
            thruDateText: dateText(row?.thruDate),
            templateKey: row?.templateKey || "",
            badgeText: row?.badgeText || "",
            featuredRank: row?.featuredRank ?? null,
            signatureRequiredEnumId: row?.signatureRequiredEnumId || null,
            lastUpdatedStamp: row?.lastUpdatedStamp ?? null,
            priceReady: priceReady(store, [product.productId]),
            stockText:
                store.requireInventory === "Y" && stocked
                    ? facilityReady
                        ? "Inventory required"
                        : "Inventory required, no facility"
                    : stocked
                      ? "Sold without stock"
                      : "Not stocked"
        }
    })
    const result = {products, productsCount: count}
    for (const key of ["PageIndex", "PageSize", "PageMaxIndex", "PageRangeLow", "PageRangeHigh"])
        result["products" + key] = found["products" + key]
    return result
}
// Whether one of these products (a variant and its virtual) has a current sales price in the store's currency, of the store or
// of no store.
function priceReady(store, productIds) {
    const currency = store.defaultCurrencyUomId
    if (!currency) return false
    return rowsIn("mantle.product.ProductPrice", "productId", productIds, {
        pricePurposeEnumId: "PppPurchase",
        priceUomId: currency
    }).some(
        row =>
            ["PptList", "PptCurrent"].includes(row.priceTypeEnumId) &&
            !row.customerPartyId &&
            (!row.productStoreId || row.productStoreId === store.productStoreId) &&
            active(row)
    )
}

// store#StoreProduct: a published product's storefront overrides (template key, badge text, featured rank, signature
// requirement) as a new row from a date (now when empty), ending the row in effect there; a row starting on that instant is
// changed in place, and one starting later is refused. A product the store does not publish is refused (publish it first).
function storeStoreProduct(p) {
    const s = scope("merchandise")
    const store = stores.storeOf(s, p.productStoreId, true)
    productOf(store, p.productId)
    const now = nowMs()
    const list = rows(PUBLICATION, {productStoreId: store.productStoreId, productId: p.productId})
    const from = stores.dateOf(p.fromDate, now, "start date")
    const base = rowAt(list, from) || laterRow(list, from - 1)
    if (!base || kindOf(base) !== PUBLISHED) denied("NOT_PUBLISHED", "Publish the product before changing its storefront details")
    staleCheck(p.expectedLastUpdatedStamp, base)
    const why = stores.reason(p, false)
    const values = {
        publicationKindEnumId: PUBLISHED,
        templateKey: text(p.templateKey) || null,
        badgeText: text(p.badgeText) || null,
        featuredRank: p.featuredRank == null || p.featuredRank === "" ? null : Number(p.featuredRank),
        signatureRequiredEnumId: p.signatureRequiredEnumId || null,
        thruDate: base.thruDate ?? null
    }
    if (values.featuredRank != null && !Number.isInteger(values.featuredRank)) denied("VALUE_INVALID", "Enter a whole rank")
    if (
        values.signatureRequiredEnumId &&
        one("moqui.basic.Enumeration", {enumId: values.signatureRequiredEnumId})?.enumTypeId !== "SignatureRequired"
    )
        denied("VALUE_INVALID", "Choose a valid signature requirement")
    const written = startRow(store.productStoreId, p.productId, values, Math.max(from, ms(base.fromDate) ?? from), why)
    return {fromDate: written.fromDate, sites: advanceGeneration([store.productStoreId])}
}
function staleCheck(expected, row) {
    if (expected && row && ms(expected) !== ms(row.lastUpdatedStamp))
        denied("STALE_REVISION", "Changed by someone else since it was read (now " + dateText(row.lastUpdatedStamp) + "); reload")
}
// A new row of a product from a time: the open row ends there, a row starting on that instant is changed in place, a row
// starting later is refused. Each field change carries the reason to the audit log.
function startRow(productStoreId, productId, values, from, why) {
    const key = {productStoreId, productId}
    const existing = rows(PUBLICATION, key)
    if (existing.some(row => (ms(row.fromDate) ?? -Infinity) > from))
        denied("DATED_OVERLAP", "A row of it starts later; withdraw or change that one first")
    const reasons = why
        ? Object.assign({changeReason: why}, Object.fromEntries(Object.keys(values).map(field => [field + "_changeReason", why])))
        : {}
    const same = existing.find(row => ms(row.fromDate) === from)
    for (const row of existing)
        if (row !== same && (ms(row.fromDate) ?? -Infinity) < from && (ms(row.thruDate) ?? Infinity) > from)
            call(
                "update#" + PUBLICATION,
                Object.assign(
                    {},
                    key,
                    {fromDate: row.fromDate, thruDate: from},
                    why ? {changeReason: why, thruDate_changeReason: why} : {}
                )
            )
    if (same) call("update#" + PUBLICATION, Object.assign({}, key, values, reasons, {fromDate: same.fromDate}))
    else call("create#" + PUBLICATION, Object.assign({}, key, values, reasons, {fromDate: from}))
    return {fromDate: from}
}
// End a row at a time; a row that has not started is withdrawn (deleted): it was never in effect.
function endRow(row, at, why) {
    const key = {productStoreId: row.productStoreId, productId: row.productId, fromDate: row.fromDate}
    if ((ms(row.fromDate) ?? -Infinity) >= at && (ms(row.fromDate) ?? -Infinity) > nowMs()) {
        call("delete#" + PUBLICATION, key)
        return {withdrawn: true}
    }
    call("update#" + PUBLICATION, Object.assign(key, {thruDate: at}, why ? {changeReason: why, thruDate_changeReason: why} : {}))
    return {withdrawn: false}
}

// ===== preview and publish =====
// What an action would do to a product, without writing: allowed or refused with its code, the variants a virtual
// product's row covers (each sellable or not, excluded or not), and the readiness findings (price, content, stock policy,
// sellability), each a warning that does not block.
function planItem(store, productId, action, from, expected) {
    const product = productOf(store, productId)
    const now = nowMs()
    const list = rows(PUBLICATION, {productStoreId: store.productStoreId, productId})
    const current = rowAt(list, Math.max(from, now))
    const later = laterRow(list, now)
    const virtual = product.productTypeEnumId === "PtVirtual"
    const virtualIds = virtualsOf([productId], now).get(productId) || []
    const variantIds = virtual ? variantIdsOf(productId, now) : []
    const refuse = (code, message) => ({allowed: false, code, message})
    let check = {allowed: true, code: null, message: null}
    if (expected && (current || later) && ms(expected) !== ms((current || later).lastUpdatedStamp))
        check = refuse(
            "STALE_REVISION",
            "Changed since it was read (now " + dateText((current || later).lastUpdatedStamp) + "); reload"
        )
    else if (action === "publish") {
        if (current && kindOf(current) === PUBLISHED) check = refuse("ALREADY_PUBLISHED", "Already published")
        else if (later) check = refuse("DATED_OVERLAP", "A publication starts later; withdraw it first")
    } else if (action === "withdraw") {
        if (!(current && kindOf(current) === PUBLISHED) && !(later && kindOf(later) === PUBLISHED))
            check = refuse("NOT_PUBLISHED", "Not published in this store")
    } else if (action === "exclude") {
        const coveredBy = virtualIds.filter(virtualId => {
            const rowsOfVirtual = rows(PUBLICATION, {productStoreId: store.productStoreId, productId: virtualId})
            const row = rowAt(rowsOfVirtual, Math.max(from, now)) || laterRow(rowsOfVirtual, now)
            return row && kindOf(row) === PUBLISHED
        })
        if (!coveredBy.length) check = refuse("NOT_COVERED", "Not a variant of a product this store publishes")
        else if (current && kindOf(current) === EXCLUDED) check = refuse("ALREADY_EXCLUDED", "Already excluded")
        else if (later) check = refuse("DATED_OVERLAP", "A row of it starts later; withdraw it first")
    } else if (action === "restore") {
        if (!(current && kindOf(current) === EXCLUDED) && !(later && kindOf(later) === EXCLUDED))
            check = refuse("NOT_EXCLUDED", "Not excluded in this store")
    } else denied("VALUE_INVALID", "Choose publish, withdraw, exclude or restore")
    const findings = []
    if (["publish", "restore"].includes(action)) {
        const sale = sellable(productId, store.productStoreId)
        findings.push({key: "sellable", label: "Sellable", ready: !!sale.usable, message: sale.usable ? "" : sale.reason || ""})
        const price = priceReady(store, [productId].concat(virtualIds))
        findings.push({
            key: "price",
            label: "Price",
            ready: price,
            message: price ? "" : "No current price in " + (store.defaultCurrencyUomId || "the store's currency")
        })
        const named = !!text(product.productName)
        findings.push({key: "content", label: "Content", ready: named, message: named ? "" : "No product name"})
        const stocked = stockedTypes.includes(product.productTypeEnumId) || virtual
        const facility =
            !!store.inventoryFacilityId ||
            rows(S + "ProductStoreFacility", {productStoreId: store.productStoreId}).some(row => active(row))
        const stockReady = !(store.requireInventory === "Y" && stocked) || facility
        findings.push({
            key: "stock",
            label: "Stock policy",
            ready: stockReady,
            message: stockReady ? "" : "The store requires inventory and has no facility"
        })
    }
    const variants = []
    if (virtual && variantIds.length) {
        const byVariant = publicationRows(store.productStoreId, variantIds)
        const names = productNames(variantIds)
        for (const variantId of variantIds) {
            const own = rowAt(byVariant.get(variantId), Math.max(from, now))
            const sale = sellable(variantId, store.productStoreId)
            const excluded = !!own && kindOf(own) === EXCLUDED
            variants.push({
                productId: variantId,
                productName: names[variantId] || variantId,
                sellable: !!sale.usable,
                excluded,
                covered: !excluded && !!sale.usable,
                stateText: excluded ? "Excluded" : sale.usable ? "Covered" : "Not sellable: " + (sale.reason || "")
            })
        }
    }
    return Object.assign(check, {
        productId,
        productName: product.productName || productId,
        action,
        actionText: actions[action],
        stateText: stateLabels[stateOf(list, now)][0],
        lastUpdatedStamp: (current || later)?.lastUpdatedStamp ?? null,
        findings,
        findingsText: findings
            .filter(finding => !finding.ready)
            .map(finding => finding.label + ": " + finding.message)
            .join("; "),
        variants,
        variantCount: variants.length,
        coveredCount: variants.filter(variant => variant.covered).length
    })
}
// preview#Publication: each product's plan for the action, and the sites whose generation the change advances.
function previewPublication(p) {
    const s = scope("view")
    const store = stores.storeOf(s, p.productStoreId)
    const productIds = unique(listOf(p.productIds))
    if (!productIds.length) denied("VALUE_INVALID", "Choose the products")
    if (productIds.length > batchLimit) denied("VALUE_INVALID", "Choose at most " + batchLimit + " products")
    const from = stores.dateOf(p.fromDate, nowMs(), "effective time")
    const items = productIds.map(productId => {
        try {
            return planItem(store, productId, p.action, from, null)
        } catch (error) {
            return {
                productId,
                productName: productId,
                allowed: false,
                code: codeOf(error),
                message: messageOf(error),
                findings: [],
                variants: []
            }
        }
    })
    return {items, sites: siteGenerations(store.productStoreId)}
}
// publish#StoreProduct: one product's action from a time (now when empty), with its reason, in the caller's transaction,
// advancing the store's sites' generation. Publish starts a published row; withdraw ends the published row (a scheduled one
// is withdrawn); exclude starts a variant's exclusion row under its published virtual product; restore ends the exclusion.
function publishStoreProduct(p) {
    const s = scope("publish")
    const store = stores.storeOf(s, p.productStoreId, true)
    const why = stores.reason(p, true)
    const now = nowMs()
    const from = stores.dateOf(p.fromDate, now, "effective time")
    const plan = planItem(store, p.productId, p.action, from, p.expectedLastUpdatedStamp || null)
    if (!plan.allowed) denied(plan.code, plan.message)
    const list = rows(PUBLICATION, {productStoreId: store.productStoreId, productId: p.productId})
    const at = Math.max(from, now)
    let fromDate = from
    if (p.action === "publish" || p.action === "exclude")
        startRow(
            store.productStoreId,
            p.productId,
            {publicationKindEnumId: p.action === "publish" ? PUBLISHED : EXCLUDED, thruDate: null},
            from,
            why
        )
    else {
        const kind = p.action === "withdraw" ? PUBLISHED : EXCLUDED
        const row = [rowAt(list, at), laterRow(list, now)].find(found => found && kindOf(found) === kind)
        fromDate = ms(row.fromDate)
        endRow(row, from, why)
    }
    return {fromDate, sites: advanceGeneration([store.productStoreId])}
}
// publish#StoreProducts: an action on each product, each in its own transaction with its generation advance, the batch
// keyed by its operation key (a retry answers the first result); a result per product, a failure named and the rest done.
function publishStoreProducts(p) {
    const s = scope("publish")
    const store = stores.storeOf(s, p.productStoreId)
    stores.reason(p, true)
    if (!Object.hasOwn(actions, p.action || "")) denied("VALUE_INVALID", "Choose publish, withdraw, exclude or restore")
    const productIds = unique(listOf(p.productIds))
    if (!productIds.length) denied("VALUE_INVALID", "Choose the products")
    if (productIds.length > batchLimit) denied("VALUE_INVALID", "Choose at most " + batchLimit + " products")
    const expected = p.expectedLastUpdatedStamps || {}
    const request = {
        productStoreId: store.productStoreId,
        action: p.action,
        productIds,
        fromDate: p.fromDate || null,
        changeReason: p.changeReason
    }
    const op = lib.operation(p, "StorePublication", store.organizationPartyId, request)
    const again = lib.previous(op)
    if (again) return again
    const results = []
    for (const productId of productIds) {
        try {
            const out = lib.probe("mantle.product.StoreMerchandisingServices.publish#StoreProduct", {
                productStoreId: store.productStoreId,
                productId,
                action: p.action,
                fromDate: p.fromDate || null,
                changeReason: p.changeReason,
                expectedLastUpdatedStamp: expected[productId] || null
            })
            results.push({productId, ok: true, code: null, message: actions[p.action] + " done", fromDate: out.fromDate ?? null})
        } catch (error) {
            ec.logger.warn("Store publication of " + productId + " in " + store.productStoreId + " refused: " + error.message)
            results.push({productId, ok: false, code: codeOf(error), message: messageOf(error)})
        }
    }
    const names = productNames(productIds)
    for (const result of results) result.productName = names[result.productId] || result.productId
    const answer = {
        results,
        doneCount: results.filter(result => result.ok).length,
        failedCount: results.filter(result => !result.ok).length,
        sites: siteGenerations(store.productStoreId).map(site => ({siteId: site.siteId, generation: site.generation}))
    }
    lib.complete(op, PUBLICATION, store.productStoreId, answer)
    return answer
}

// propose#StorePublication: for a store with no publication rows, the products its categories hold (its roles' categories
// and below), sellable, a virtual product for its variants, for a publisher to approve through publish#StoreProducts; never
// writes. A store with rows is refused (PUBLICATION_EXISTS).
function proposeStorePublication(p) {
    const s = scope("view")
    const store = stores.storeOf(s, p.productStoreId)
    if (find(PUBLICATION, {productStoreId: store.productStoreId}).count() > 0)
        denied("PUBLICATION_EXISTS", "The store already has publication rows; publish from Merchandising")
    const now = nowMs()
    const categories = Array.from(storeTree(store.productStoreId, now))
    const memberRows = rowsIn(MEMBER, "productCategoryId", categories).filter(row => active(row))
    const virtuals = virtualsOf(unique(memberRows.map(row => row.productId)), now)
    const ids = unique(memberRows.map(row => (virtuals.get(row.productId) || [])[0] || row.productId))
    const products = rowsIn(PRODUCT, "productId", ids).filter(
        product => !product.ownerPartyId || product.ownerPartyId === "_NA_" || product.ownerPartyId === store.organizationPartyId
    )
    const proposals = []
    for (const product of products.sort((a, b) => String(a.productName || "").localeCompare(String(b.productName || "")))) {
        if (proposals.length >= proposalLimit) break
        if (!sellable(product.productId, store.productStoreId).usable) continue
        proposals.push({
            productId: product.productId,
            productName: product.productName || product.productId,
            virtual: product.productTypeEnumId === "PtVirtual",
            variantCount: product.productTypeEnumId === "PtVirtual" ? variantIdsOf(product.productId, now).length : 0
        })
    }
    return {proposals, proposalsCount: proposals.length}
}

// ===== categories =====
// get#StoreCategories: the store's category roles (current and starting later) and its tree now: each category under the
// roles with its parent, depth, sequence, member count and the number of the user's other stores that share it; with
// productCategoryId, that category's members (current and starting later).
function getStoreCategories(p) {
    const s = scope("view")
    const store = stores.storeOf(s, p.productStoreId)
    const now = nowMs()
    const roleRows = rows(STORE_CATEGORY, {productStoreId: store.productStoreId}).filter(
        row => (ms(row.thruDate) ?? Infinity) > now
    )
    const names = categoryNames(roleRows.map(row => row.productCategoryId))
    const roles = roleRows
        .sort(
            (a, b) =>
                (a.sequenceNum ?? 0) - (b.sequenceNum ?? 0) ||
                String(a.storeCategoryTypeEnumId).localeCompare(b.storeCategoryTypeEnumId)
        )
        .map(row => {
            const dates = stores.rowDates(row)
            return {
                productCategoryId: row.productCategoryId,
                categoryName: names[row.productCategoryId] || row.productCategoryId,
                storeCategoryTypeEnumId: row.storeCategoryTypeEnumId,
                typeText: enumText(row.storeCategoryTypeEnumId),
                fromDate: row.fromDate,
                fromDateText: dates.fromDateText,
                thruDate: row.thruDate,
                thruDateText: dates.thruDateText,
                sequenceNum: row.sequenceNum ?? null,
                stateText: stores.stateOf(dates)
            }
        })
    // the tree: each current role's category once, then its children depth first in sequence order
    const nodes = []
    const seen = new Set()
    const rootIds = unique(roles.filter(role => role.stateText === "Current").map(role => role.productCategoryId))
    const walk = (categoryId, parentId, rollup, depth) => {
        if (seen.has(categoryId) || nodes.length >= treeNodeLimit) return
        seen.add(categoryId)
        nodes.push({categoryId, parentId, rollup, depth})
        if (depth >= treeDepthLimit) return
        for (const child of childrenOf([categoryId], now).get(categoryId) || [])
            walk(child.productCategoryId, categoryId, child, depth + 1)
    }
    for (const rootId of rootIds) walk(rootId, null, null, 0)
    const ids = nodes.map(node => node.categoryId)
    const nodeNames = categoryNames(ids)
    const counts = new Map()
    for (const row of rowsIn(MEMBER, "productCategoryId", ids))
        if (active(row)) counts.set(row.productCategoryId, (counts.get(row.productCategoryId) || 0) + 1)
    const sharing = new Map()
    for (const row of rowsIn(STORE_CATEGORY, "productCategoryId", Array.from(ancestorsOf(ids, now))))
        if (active(row) && row.productStoreId !== store.productStoreId) sharing.set(row.productCategoryId, true)
    const tree = nodes.map(node => {
        const shared = Array.from(ancestorsOf([node.categoryId], now)).some(id => sharing.has(id))
        return {
            productCategoryId: node.categoryId,
            categoryName: nodeNames[node.categoryId] || node.categoryId,
            parentProductCategoryId: node.parentId,
            rollupFromDate: node.rollup?.fromDate ?? null,
            sequenceNum: node.rollup?.sequenceNum ?? null,
            depth: node.depth,
            label: "  ".repeat(node.depth) + (nodeNames[node.categoryId] || node.categoryId),
            memberCount: counts.get(node.categoryId) || 0,
            shared,
            root: node.parentId == null
        }
    })
    let members = []
    if (p.productCategoryId) {
        if (!seen.has(p.productCategoryId))
            denied("CATEGORY_UNAVAILABLE", "Category " + p.productCategoryId + " is not in this store's tree")
        const memberRows = rows(MEMBER, {productCategoryId: p.productCategoryId}).filter(
            row => (ms(row.thruDate) ?? Infinity) > now
        )
        const memberNames = productNames(memberRows.map(row => row.productId))
        members = memberRows
            .sort((a, b) => (a.sequenceNum ?? 0) - (b.sequenceNum ?? 0))
            .map(row => {
                const dates = stores.rowDates(row)
                return {
                    productCategoryId: row.productCategoryId,
                    productId: row.productId,
                    productName: memberNames[row.productId] || row.productId,
                    fromDate: row.fromDate,
                    fromDateText: dates.fromDateText,
                    thruDateText: dates.thruDateText,
                    sequenceNum: row.sequenceNum ?? null,
                    stateText: stores.stateOf(dates)
                }
            })
    }
    return {roles, tree, members}
}
// store#StoreCategory: a store's dated category role (StoreRoots): from a date (now when empty), ending the open row of the
// same role and category there, or end the row in effect. A one-category role (home page, browse root, view allow...) ends
// another category's open row of the role at the same time.
function storeStoreCategory(p) {
    const s = scope("merchandise")
    const store = stores.storeOf(s, p.productStoreId, true)
    categoryOf(store, p.productCategoryId)
    if (one("moqui.basic.Enumeration", {enumId: p.storeCategoryTypeEnumId || ""})?.enumTypeId !== "ProductStoreCategoryType")
        denied("VALUE_INVALID", "Choose a category role")
    const key = {
        productStoreId: store.productStoreId,
        productCategoryId: p.productCategoryId,
        storeCategoryTypeEnumId: p.storeCategoryTypeEnumId
    }
    const saved = stores.saveDated(
        STORE_CATEGORY,
        key,
        {sequenceNum: p.sequenceNum == null || p.sequenceNum === "" ? null : Number(p.sequenceNum)},
        p
    )
    if (!saved.ended && singleRoles.includes(p.storeCategoryTypeEnumId)) {
        const from = ms(saved.fromDate)
        for (const row of rows(STORE_CATEGORY, {
            productStoreId: store.productStoreId,
            storeCategoryTypeEnumId: p.storeCategoryTypeEnumId
        }))
            if (
                row.productCategoryId !== p.productCategoryId &&
                (ms(row.fromDate) ?? -Infinity) < from &&
                (ms(row.thruDate) ?? Infinity) > from
            )
                call("update#" + STORE_CATEGORY, {
                    productStoreId: row.productStoreId,
                    productCategoryId: row.productCategoryId,
                    storeCategoryTypeEnumId: row.storeCategoryTypeEnumId,
                    fromDate: row.fromDate,
                    thruDate: from
                })
    }
    return {fromDate: saved.fromDate, sites: advanceGeneration([store.productStoreId])}
}
// move#StoreCategory: move a category of the store's tree under another of its categories from a date (now when empty), the
// current rollup to its old parent ending there; or, under the same parent, set its sequence in place. Refused: a parent
// that is the category or below it now or by a rollup starting later (CATEGORY_CYCLE), a category or parent outside the
// store's tree, a date before the current rollup's start or a rollup of it starting later (DATED_OVERLAP), and a category
// another store shares, as sharedCheck says. previewOnly answers the affected stores without writing.
function moveStoreCategory(p) {
    const s = scope("merchandise")
    const store = stores.storeOf(s, p.productStoreId, true)
    const now = nowMs()
    const childId = p.productCategoryId
    const currentParents = rows(ROLLUP, {productCategoryId: childId}).filter(row => activeAt(row, now))
    // Move up or down keeps the parent: the one named, else the only current one
    const toParentId =
        p.toParentCategoryId ||
        (p.direction
            ? p.fromParentCategoryId || (currentParents.length === 1 ? currentParents[0].parentProductCategoryId : null)
            : null)
    if (!toParentId) denied("VALUE_INVALID", "Choose the parent category")
    if (p.direction && !["up", "down"].includes(p.direction)) denied("VALUE_INVALID", "Move up or down")
    categoryOf(store, childId)
    categoryOf(store, toParentId)
    const tree = storeTree(store.productStoreId, now)
    if (!tree.has(childId) || !tree.has(toParentId))
        denied("CATEGORY_UNAVAILABLE", "Both categories must be in this store's tree")
    if (childId === toParentId || ancestorsOf([toParentId], now, true).has(childId))
        denied("CATEGORY_CYCLE", "A category cannot move under itself or a category below it")
    const from = stores.dateOf(p.fromDate, now, "start date")
    if (from < now - 60000) denied("VALUE_INVALID", "Choose a start date from now on")
    const parentRows = rows(ROLLUP, {productCategoryId: childId})
    if (parentRows.some(row => (ms(row.fromDate) ?? -Infinity) > now))
        denied("DATED_OVERLAP", "A move of this category starts later; end it first")
    const current = parentRows.filter(row => activeAt(row, now))
    const fromParent = p.fromParentCategoryId
        ? current.find(row => row.parentProductCategoryId === p.fromParentCategoryId)
        : current.length === 1
          ? current[0]
          : null
    if (!fromParent && current.length > 1) denied("VALUE_INVALID", "The category has several parents; name the one it leaves")
    const shared = sharedCheck(s, store, [childId, toParentId], now, p)
    if (isTrue(p.previewOnly)) return Object.assign({moved: false}, shared)
    const sequenceNum = p.sequenceNum == null || p.sequenceNum === "" ? null : Number(p.sequenceNum)
    const reorder = fromParent && fromParent.parentProductCategoryId === toParentId
    if (p.direction && !reorder) denied("VALUE_INVALID", "Move up or down within the category's parent")
    if (reorder && !p.direction && !p.beforeCategoryId) {
        call("update#" + ROLLUP, {
            productCategoryId: childId,
            parentProductCategoryId: toParentId,
            fromDate: fromParent.fromDate,
            sequenceNum
        })
    } else if (!reorder) {
        if (current.some(row => row.parentProductCategoryId === toParentId))
            denied("VALUE_INVALID", "The category is already under that parent")
        if (fromParent) {
            if (from < (ms(fromParent.fromDate) ?? -Infinity))
                denied("DATED_OVERLAP", "The move starts before the category's current place")
            call("update#" + ROLLUP, {
                productCategoryId: childId,
                parentProductCategoryId: fromParent.parentProductCategoryId,
                fromDate: fromParent.fromDate,
                thruDate: from
            })
        }
        call("create#" + ROLLUP, {productCategoryId: childId, parentProductCategoryId: toParentId, fromDate: from, sequenceNum})
    }
    if (p.direction || p.beforeCategoryId) placeAmongSiblings(toParentId, childId, p.direction, p.beforeCategoryId, now)
    return Object.assign({moved: true, sites: advanceGeneration(shared.affectedStores.map(row => row.productStoreId))}, shared)
}
// Place a category among its current siblings (one up, one down, or before a sibling, as a drag drops it), then number the
// siblings 10, 20, 30... in that order, changing each current rollup's sequence in place.
function placeAmongSiblings(parentId, childId, direction, beforeId, now) {
    const siblings = rows(ROLLUP, {parentProductCategoryId: parentId})
        .filter(row => activeAt(row, now))
        .sort(
            (a, b) =>
                (a.sequenceNum ?? 0) - (b.sequenceNum ?? 0) || String(a.productCategoryId).localeCompare(b.productCategoryId)
        )
    const order = siblings.map(row => row.productCategoryId)
    const at = order.indexOf(childId)
    if (at < 0) return
    order.splice(at, 1)
    let to =
        direction === "up" ? Math.max(0, at - 1) : direction === "down" ? Math.min(order.length, at + 1) : order.indexOf(beforeId)
    if (to < 0) to = order.length
    order.splice(to, 0, childId)
    order.forEach((categoryId, index) => {
        const row = siblings.find(sibling => sibling.productCategoryId === categoryId)
        const sequenceNum = (index + 1) * 10
        if (row.sequenceNum !== sequenceNum)
            call("update#" + ROLLUP, {
                productCategoryId: categoryId,
                parentProductCategoryId: parentId,
                fromDate: row.fromDate,
                sequenceNum
            })
    })
}
// store#CategoryMembership: a category's dated members (CategoryProducts), for one product or several (bulk assign or remove
// with end): each from a date (now when empty) or ended, with a result per product. The category must be in the store's tree
// and each product one the store may carry; a category another store shares is checked as sharedCheck says. previewOnly
// answers the affected stores without writing.
function storeCategoryMembership(p) {
    const s = scope("merchandise")
    const store = stores.storeOf(s, p.productStoreId, true)
    const now = nowMs()
    categoryOf(store, p.productCategoryId)
    if (!storeTree(store.productStoreId, now).has(p.productCategoryId))
        denied("CATEGORY_UNAVAILABLE", "Category " + p.productCategoryId + " is not in this store's tree")
    const productIds = unique(listOf(p.productIds).concat(p.productId ? [p.productId] : []))
    if (!productIds.length) denied("VALUE_INVALID", "Choose the products")
    if (productIds.length > batchLimit) denied("VALUE_INVALID", "Choose at most " + batchLimit + " products")
    const shared = sharedCheck(s, store, [p.productCategoryId], now, p)
    if (isTrue(p.previewOnly)) return Object.assign({results: []}, shared)
    const results = []
    for (const productId of productIds) {
        try {
            productOf(store, productId)
            const saved = stores.saveDated(
                MEMBER,
                {productCategoryId: p.productCategoryId, productId},
                {sequenceNum: p.sequenceNum == null || p.sequenceNum === "" ? null : Number(p.sequenceNum)},
                p
            )
            results.push({productId, ok: true, code: null, ended: saved.ended})
        } catch (error) {
            results.push({productId, ok: false, code: codeOf(error), message: messageOf(error)})
        }
    }
    if (results.some(result => !result.ok) && results.every(result => !result.ok)) {
        const first = results[0]
        denied(first.code, first.message)
    }
    return Object.assign({results, sites: advanceGeneration(shared.affectedStores.map(row => row.productStoreId))}, shared)
}

// get#CategoryStores: the user's stores whose category tree shows a category now (or by a role or rollup starting later), and
// how many other stores do (Commerce's CategoryDetail names them before a taxonomy change).
function getCategoryStores(p) {
    const s = scope("view")
    if (!p.productCategoryId || !one(CATEGORY, {productCategoryId: p.productCategoryId}))
        denied("CATEGORY_UNAVAILABLE", "Category " + (p.productCategoryId || "") + " is not available")
    return storesReaching(s, [p.productCategoryId], nowMs())
}

// find#ProductPublications: a product's publication in each store the user works (the first 50 by name): its state, whether
// it is public now (the resolver) and why not, and its row's dates and badge (Commerce's Product360).
function findProductPublications(p) {
    const s = scope("view")
    if (!p.productId || !one(PRODUCT, {productId: p.productId}))
        denied("PRODUCT_UNAVAILABLE", "Product " + (p.productId || "") + " is not available")
    const now = nowMs()
    const storeRows = Array.from(stores.storeQuery(s).orderBy("storeName,productStoreId").limit(50).list())
    const reasons = {
        NOT_PUBLISHED: "Not published",
        VARIANT_EXCLUDED: "Variant excluded",
        NOT_SELLABLE: "Not sellable",
        NOT_IN_VIEW_CATEGORY: "Outside the store's view category",
        NOT_IN_PURCHASE_CATEGORY: "Shown, outside the purchase category"
    }
    const publications = []
    for (const store of storeRows) {
        try {
            const list = rows(PUBLICATION, {productStoreId: store.productStoreId, productId: p.productId})
            const answer = resolve(store, [p.productId], now, null)[0]
            const state = stateOf(list, now)
            const row = rowAt(list, now) || laterRow(list, now)
            if (state === "unpublished" && !answer.isPublic) continue
            publications.push({
                productStoreId: store.productStoreId,
                storeName: store.storeName || store.productStoreId,
                stateText: answer.via === "virtual" ? "Published by its virtual product" : stateLabels[state][0],
                stateColor: answer.isPublic ? "positive" : stateLabels[state][1],
                publicText: answer.isPublic
                    ? answer.purchasable
                        ? "Public"
                        : "Public, not purchasable"
                    : reasons[answer.reasonCode] || "Not public",
                fromDateText: dateText(row?.fromDate),
                thruDateText: dateText(row?.thruDate),
                badgeText: row?.badgeText || ""
            })
        } catch (error) {
            ec.logger.error("Publication of " + p.productId + " in " + store.productStoreId + " not read: " + error.message)
        }
    }
    return {publications, storeCount: storeRows.length}
}

const operations = {
    findProductPublications,
    getCategoryStores,
    getStorePublication,
    findStoreProducts,
    storeStoreProduct,
    previewPublication,
    publishStoreProduct,
    publishStoreProducts,
    proposeStorePublication,
    getStoreCategories,
    storeStoreCategory,
    moveStoreCategory,
    storeCategoryMembership
}
;({
    // the resolver for Shop's catalog (impl-shop P3) and the generation advance for the store's other publication changes
    // (pages, menus and themes, P4 and P5)
    resolve,
    advanceGeneration,
    execute: (op, parameters) => {
        if (!operations[op]) throw new Error("Unknown store merchandising operation " + op)
        return operations[op](parameters || {})
    }
})
