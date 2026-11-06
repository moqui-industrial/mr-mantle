/* CC0 1.0 Universal plus Grant of Patent License. See LICENSE.md.
 * Shop's catalog (mr-pass impl-shop P3; design-shop §5, §11; SHOP-CATALOG, SHOP-CONTENT): the public, read-only views of a
 * published site's Shop mount and the store it targets (ShopContext.js shopOf, from the site the facade resolved): the home,
 * the category tree, a category's products, the product list, search, a product with its variants, the price of a
 * selection, a published page and the sitemap.
 *
 * - A product is in a view only when Commerce P3's resolver (StoreMerchandising.js resolve) answers it public in the store
 *   for this site now: a current publication row (or its virtual's, without an exclusion), sellable, inside the store's
 *   view-allow tree, the site published with an enabled Shop mount naming the store. Candidates come cheaply (the store's
 *   current publication rows, a category's members, the MantleProduct search index, F32), are paged here and only a page's
 *   candidates are resolved, in chunks, until the page is full (F51); a candidate never authorizes anything.
 * - Prices are get#StoreProductPrice's, as the authority for the routed store and the signed-in customer (F18): a price
 *   that is unavailable is told apart from a zero one; never the trace, cost or margin.
 * - Availability is a band (in stock, low stock, backorder, out of stock) from get#AvailableInventoryMulti over the store's
 *   facilities, never a quantity.
 * - Sort keys are registered (sorts); cursors are opaque and pages bounded.
 * - Every answer carries the site's publication generation and the active theme release, which a frontend keys its
 *   caches by (F43).
 * Reads are the authority's own (authorization disabled); nothing here writes.
 */
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const shopContext = ec.resource.script("component://mr-mantle/service/mantle/product/ShopContext.js")
const merchandising = () => ec.resource.script("component://mr-mantle/service/mantle/product/StoreMerchandising.js")
const themes = () => ec.resource.script("component://mr-mantle/service/mantle/public/Themes.js")
const sitePages = () => ec.resource.script("component://mr-mantle/service/mantle/public/SitePages.js")
const {find, one, rows, ms} = lib
const S = "mantle.product.store."
const PRODUCT = "mantle.product.Product"
const CONTENT = "mantle.product.ProductContent"
const MEMBER = "mantle.product.category.ProductCategoryMember"
const CATEGORY = "mantle.product.category.ProductCategory"
const ROLLUP = "mantle.product.category.ProductCategoryRollup"
const ASSOC = "mantle.product.ProductAssoc"
const FEATURE_APPL = "mantle.product.feature.ProductFeatureAppl"
const FEATURE = "mantle.product.feature.ProductFeature"
const SITE_PAGE = "mantle.public.PublicSitePage"

// ===== tables =====
// The page sizes, candidate and tree bounds, and the query length.
const limits = {
    pageSize: 24,
    maxPageSize: 48,
    candidates: 2000,
    searchHits: 200,
    contentResults: 10,
    featured: 12,
    variants: 50,
    sitemapProducts: 5000,
    treeDepth: 4,
    treeNodes: 300,
    queryLength: 100,
    quantity: 999
}
// The stock band thresholds: at or below lowStock is "low stock".
const lowStock = 5
const stockedTypes = ["PtAsset", "PtPickAssembly", "PtAssetUse"]
// Registered sort keys (design-shop §5 CategoryDetail: never an entity field expression).
const sorts = {
    featured: {label: "Featured"},
    name: {label: "Name"},
    newest: {label: "Newest"}
}
// The store category roles a view reads.
const roles = {browse: "PsctBrowseRoot", featured: "PsctFeatured", newProducts: "PsctNewProducts", home: "PsctHomePage"}

// ===== values =====
const text = value => (value == null ? "" : String(value).trim())
const unique = list => Array.from(new Set(list.filter(Boolean)))
const nowMs = () => ms(ec.user.nowTimestamp)
const activeAt = (row, at) => (ms(row.fromDate) ?? -Infinity) <= at && (ms(row.thruDate) ?? Infinity) > at
const rowsIn = (entity, field, values, conditions = {}) =>
    values.length ? Array.from(find(entity, conditions).condition(field, "in", values).list()) : []
// The decorative slug of a name (the same as SitePages.js destinations, so menu links and canonical URLs agree).
const slug = name =>
    String(name || "item")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 60) || "item"
function notAvailable(what) {
    const error = new Error("NOT_AVAILABLE: " + (what || "This page") + " is not available")
    error.moquiErrorKind = "NotFound"
    throw error
}
function invalid(field, message) {
    const error = new Error("VALUE_INVALID[" + field + "]: " + message)
    error.moquiErrorKind = "Unprocessable"
    throw error
}
const idOf = (value, field) => {
    const id = text(value)
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(id)) notAvailable(field === "productCategoryId" ? "This category" : "This product")
    return id
}
// An opaque cursor: an offset into the candidate list.
const cursorText = offset => "c" + Number(offset).toString(36)
function cursorOf(value) {
    const cursor = text(value)
    if (!cursor) return 0
    if (!/^c[0-9a-z]{1,8}$/.test(cursor)) invalid("cursor", "This page of results is no longer available")
    return parseInt(cursor.slice(1), 36)
}
function pageSizeOf(value) {
    if (value == null || value === "") return limits.pageSize
    const size = Number(value)
    if (!Number.isInteger(size) || size < 1 || size > limits.maxPageSize)
        invalid("limit", "Choose up to " + limits.maxPageSize + " results a page")
    return size
}
function sortOf(value) {
    const sort = text(value) || "featured"
    if (!Object.hasOwn(sorts, sort)) invalid("sort", "Choose a listed sort order")
    return sort
}
function quantityOf(value) {
    if (value == null || value === "") return 1
    const quantity = Number(value)
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > limits.quantity)
        invalid("quantity", "Choose a quantity from 1 to " + limits.quantity)
    return quantity
}
// the decimal places of a currency (USD 2, JPY 0), from its formatted text
const digitsOf = currencyUomId => (String(ec.l10n.formatCurrencyNoSymbol(1, currencyUomId)).split(".")[1] || "").length
const money = (amount, currencyUomId) => ({
    amount: ec.l10n.roundCurrency(toDecimal(amount), currencyUomId).setScale(digitsOf(currencyUomId), "HALF_UP").toString(),
    currencyUomId,
    display: ec.l10n.formatCurrency(amount, currencyUomId),
    available: true
})
const unavailablePrice = currencyUomId => ({amount: null, currencyUomId, display: "Price unavailable", available: false})

// ===== the shop =====
// The published site, its Shop mount and store, the visitor's party (a signed-in account's) and what every answer carries.
function shopOf(p) {
    const {site, mount, store} = shopContext.shopOf(p.siteId)
    const base = mount.pathPrefix === "/" ? "" : mount.pathPrefix
    const release = themes().activeRelease(site.siteId, mount.appMountId)
    return {
        site,
        mount,
        store,
        siteId: site.siteId,
        productStoreId: store.productStoreId,
        base,
        locale: String(store.defaultLocale || site.locale || "en").replace(/_/g, "-"),
        currencyUomId: store.defaultCurrencyUomId || "USD",
        customerPartyId: ec.user.userId ? ec.user.userAccount?.partyId || null : null,
        at: nowMs(),
        publication: {generation: Number(site.generation || 0), releaseId: release ? release.releaseId : null}
    }
}
const urls = {
    product: (shop, id, name) => shop.base + "/products/" + id + "/" + slug(name),
    category: (shop, id, name) => shop.base + "/categories/" + id + "/" + slug(name),
    page: (shop, routePath) => shop.base + "/pages/" + routePath,
    home: shop => shop.base + "/",
    categories: shop => shop.base + "/Categories",
    search: shop => shop.base + "/Search",
    // P4 (F61): a product image's public route, served after the resolver's check (get#ProductImage)
    image: (shop, productContentId) => shop.base + "/media?productContentId=" + encodeURIComponent(productContentId)
}
const answer = (shop, body) => Object.assign(body, shop.publication)

// ===== candidates =====
// The store's products with a current published row now, featured rank first then id: the cheap candidate list every
// list view starts from (variants are covered by their virtual product's row and are not listed apart).
function publishedIds(shop) {
    return unique(
        Array.from(
            find(S + "ProductStoreProduct", {productStoreId: shop.productStoreId})
                .orderBy("featuredRank,productId")
                .list()
        )
            .filter(row => activeAt(row, shop.at) && (row.publicationKindEnumId || "PspkPublished") === "PspkPublished")
            .map(row => row.productId)
    ).slice(0, limits.candidates)
}
// The current members of these categories, in their sequence order.
function memberIds(categoryIds, at) {
    return unique(
        rowsIn(MEMBER, "productCategoryId", unique(categoryIds))
            .filter(row => activeAt(row, at))
            .sort((a, b) => (a.sequenceNum ?? 0) - (b.sequenceNum ?? 0) || String(a.productId).localeCompare(b.productId))
            .map(row => row.productId)
    )
}
// The store's categories of a role now.
const roleCategoryIds = (shop, roleEnumId) =>
    rows(S + "ProductStoreCategory", {productStoreId: shop.productStoreId, storeCategoryTypeEnumId: roleEnumId})
        .filter(row => activeAt(row, shop.at))
        .map(row => row.productCategoryId)
// Candidates in a sort order: featured keeps the given order; name and newest read the products once.
function sorted(candidates, sort) {
    if (sort === "featured" || candidates.length < 2) return candidates
    const products = Object.fromEntries(rowsIn(PRODUCT, "productId", candidates).map(row => [row.productId, row]))
    const list = candidates.filter(id => products[id])
    if (sort === "name")
        return list.sort((a, b) =>
            String(products[a].productName || a).localeCompare(String(products[b].productName || b), undefined, {
                sensitivity: "base"
            })
        )
    return list.sort(
        (a, b) =>
            (ms(products[b].salesIntroductionDate) ?? 0) - (ms(products[a].salesIntroductionDate) ?? 0) || a.localeCompare(b)
    )
}
// A page of the public products among candidates (F51): only the candidates the page needs are resolved, in chunks, until
// the page is full. {answers, nextCursor}.
function publicPage(shop, candidates, offset, size) {
    const out = []
    let next = offset
    while (out.length < size && next < candidates.length) {
        const chunk = candidates.slice(next, next + Math.max(size * 2, 8))
        const answers = merchandising().resolve(shop.store, chunk, shop.at, shop.siteId)
        let used = 0
        for (const found of answers) {
            used++
            if (found.isPublic) out.push(found)
            if (out.length === size) break
        }
        next += used
    }
    return {answers: out, nextCursor: next < candidates.length ? cursorText(next) : null}
}
// The public products among these ids (each resolved), in the given order.
const publicOf = (shop, ids) =>
    ids.length
        ? merchandising()
              .resolve(shop.store, unique(ids), shop.at, shop.siteId)
              .filter(found => found.isPublic)
        : []

// ===== projections =====
// The store's text of a content type for these products: the store's own row first, then one for any store; the visitor's
// locale, its language, then none.
function contentTexts(shop, productIds, typeEnumId) {
    const out = {}
    const locale = shop.locale.replace(/-/g, "_")
    const rank = row =>
        (row.productStoreId === shop.productStoreId ? 0 : 10) +
        (row.locale === locale ? 0 : row.locale && locale.startsWith(row.locale) ? 1 : !row.locale ? 2 : 5)
    const byProduct = {}
    for (const row of rowsIn(CONTENT, "productId", productIds, {productContentTypeEnumId: typeEnumId})) {
        if (!activeAt(row, shop.at) || (row.productStoreId && row.productStoreId !== shop.productStoreId)) continue
        if (!byProduct[row.productId] || rank(row) < rank(byProduct[row.productId])) byProduct[row.productId] = row
    }
    for (const [productId, row] of Object.entries(byProduct)) {
        try {
            const value = row.contentLocation ? ec.resource.getLocationText(row.contentLocation, false) : row.description
            if (text(value)) out[productId] = String(value)
        } catch (error) {
            ec.logger.error("Shop content " + row.productContentId + " of " + productId + " not read: " + error.message)
        }
    }
    return out
}
// The price of a product for the shop's sale at a quantity: the authority's price (get#StoreProductPrice), or unavailable.
function priceOf(shop, productId, quantity) {
    try {
        const out = lib.call("mantle.product.PriceServices.get#StoreProductPrice", {
            productId,
            productStoreId: shop.productStoreId,
            customerPartyId: shop.customerPartyId,
            quantity: quantity || 1,
            priceUomId: shop.currencyUomId
        })
        if (!out.priceAvailable || out.price == null) return {price: unavailablePrice(shop.currencyUomId)}
        const price = money(out.price, shop.currencyUomId)
        const list =
            out.listPriceAvailable && out.listPrice != null && toDecimal(out.listPrice).compare(toDecimal(out.price)) > 0
                ? money(out.listPrice, shop.currencyUomId)
                : null
        return {price, compareAtPrice: list, unit: toDecimal(out.price)}
    } catch (error) {
        ec.message.clearErrors()
        ec.logger.error("Shop price of " + productId + " in " + shop.productStoreId + " not read: " + error.message)
        return {price: unavailablePrice(shop.currencyUomId)}
    }
}
// The available-to-promise totals of these products over the store's facilities, or null when they cannot be read.
function stockOf(shop, productIds) {
    if (!productIds.length) return {}
    try {
        return (
            lib.call("mantle.product.AssetServices.get#AvailableInventoryMulti", {
                productIds,
                productStoreId: shop.productStoreId
            }).availableByProductId || {}
        )
    } catch (error) {
        ec.message.clearErrors()
        ec.logger.error("Shop stock of " + shop.productStoreId + " not read: " + error.message)
        return null
    }
}
// The customer-facing band of a product (crosscut §3.7): never its quantity.
function bandOf(shop, product, stock) {
    if (!stockedTypes.includes(product.productTypeEnumId)) return {code: "available", label: "Available", purchasable: true}
    if (stock == null) return {code: "unknown", label: "Availability unknown", purchasable: false}
    const quantity = Number(String(stock[product.productId] ?? 0))
    if (quantity > lowStock) return {code: "inStock", label: "In stock", purchasable: true}
    if (quantity > 0) return {code: "lowStock", label: "Low stock", purchasable: true}
    if (shop.store.requireInventory === "N") return {code: "backorder", label: "Available on backorder", purchasable: true}
    return {code: "outOfStock", label: "Out of stock", purchasable: false}
}
// The current public variants of virtual products, by virtual.
function variantsOf(shop, virtualIds) {
    const byVirtual = {}
    const assocs = rowsIn(ASSOC, "productId", virtualIds, {productAssocTypeEnumId: "PatVariant"})
        .filter(row => activeAt(row, shop.at))
        .sort((a, b) => (a.sequenceNum ?? 0) - (b.sequenceNum ?? 0) || String(a.toProductId).localeCompare(b.toProductId))
    const ids = unique(assocs.map(row => row.toProductId)).slice(0, limits.variants * Math.max(1, virtualIds.length))
    const answers = Object.fromEntries(publicOf(shop, ids).map(found => [found.productId, found]))
    for (const row of assocs)
        if (answers[row.toProductId]) (byVirtual[row.productId] = byVirtual[row.productId] || []).push(answers[row.toProductId])
    return byVirtual
}
// ===== P4 (F61): product images =====
// The image content types a public page shows, the card's first (small, then medium...), and the file types served.
const imageTypes = ["PcntImageSmall", "PcntImageMedium", "PcntImageLarge", "PcntImageDetail", "PcntImageOriginal"]
const imageMimeTypes = {png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp"}
const imageExtension = location => (/\.([A-Za-z0-9]{1,5})$/.exec(String(location || "")) || [])[1]?.toLowerCase() || ""
// The images of these products in effect now for the store (the store's own rows or rows of no store), of a file type
// served, by product in type then sequence order: [{productContentId, alt}].
function imagesOf(shop, productIds) {
    const out = {}
    const rows = rowsIn(CONTENT, "productId", productIds)
        .filter(
            row =>
                imageTypes.includes(row.productContentTypeEnumId) &&
                row.contentLocation &&
                imageMimeTypes[imageExtension(row.contentLocation)] &&
                activeAt(row, shop.at) &&
                (!row.productStoreId || row.productStoreId === shop.productStoreId)
        )
        .sort(
            (a, b) =>
                imageTypes.indexOf(a.productContentTypeEnumId) - imageTypes.indexOf(b.productContentTypeEnumId) ||
                (a.sequenceNum ?? 0) - (b.sequenceNum ?? 0) ||
                String(a.productContentId).localeCompare(String(b.productContentId))
        )
    for (const row of rows) (out[row.productId] = out[row.productId] || []).push(row)
    return out
}
const imageView = (shop, row, name) => ({url: urls.image(shop, row.productContentId), alt: text(row.description) || name})
// Product cards of resolved public answers, in their order: id, name, url, sku, price (a virtual's lowest variant price as
// "From"), availability band and purchasable.
function cards(shop, answers) {
    const ids = answers.map(found => found.productId)
    if (!ids.length) return []
    const products = Object.fromEntries(rowsIn(PRODUCT, "productId", ids).map(row => [row.productId, row]))
    const names = contentTexts(shop, ids, "PcntProductName")
    const virtualIds = ids.filter(id => products[id]?.productTypeEnumId === "PtVirtual" || products[id]?.isVirtual === "Y")
    const variants = virtualIds.length ? variantsOf(shop, virtualIds) : {}
    const variantIds = Object.values(variants).flatMap(list => list.map(found => found.productId))
    const variantProducts = Object.fromEntries(rowsIn(PRODUCT, "productId", variantIds).map(row => [row.productId, row]))
    const stock = stockOf(
        shop,
        ids.concat(variantIds).filter(id => stockedTypes.includes((products[id] || variantProducts[id])?.productTypeEnumId))
    )
    const images = imagesOf(shop, ids)
    return answers
        .filter(found => products[found.productId])
        .map(found => {
            const product = products[found.productId]
            const name = text(names[product.productId]) || product.productName || product.productId
            let priced = priceOf(shop, product.productId, 1)
            let availability = bandOf(shop, product, stock)
            const options = variants[product.productId]
            if (options) {
                // a virtual: its lowest public variant price "From", available when a variant is
                const prices = options
                    .map(option => priceOf(shop, option.productId, 1))
                    .filter(option => option.price.available)
                    .sort((a, b) => a.unit.compare(b.unit))
                if (!priced.price.available && prices.length)
                    priced = {
                        price: Object.assign({}, prices[0].price, {display: "From " + prices[0].price.display}),
                        compareAtPrice: null
                    }
                const bands = options.map(option => bandOf(shop, variantProducts[option.productId] || {}, stock))
                availability = bands.find(band => band.purchasable) ||
                    bands[0] || {code: "outOfStock", label: "Out of stock", purchasable: false}
            }
            return {
                id: product.productId,
                name,
                url: urls.product(shop, product.productId, name),
                sku: product.pseudoId || product.productId,
                price: priced.price,
                compareAtPrice: priced.compareAtPrice || null,
                availability: {
                    code: availability.code,
                    label: availability.label,
                    purchasable: !!(found.purchasable && availability.purchasable && priced.price.available)
                },
                badge: found.badgeText || null,
                image: images[product.productId] ? imageView(shop, images[product.productId][0], name) : null
            }
        })
}
// A category's public projection.
const categoryCard = (shop, row) => ({
    id: row.productCategoryId,
    name: row.categoryName || row.productCategoryId,
    url: urls.category(shop, row.productCategoryId, row.categoryName || row.productCategoryId),
    description: text(row.description) || null
})

// ===== the category tree =====
// The store's browse tree below its browse roots (the roots themselves are not shown), each node {id, name, url,
// description, children}, to the depth and node bounds; a category with no published product in it or below it is left
// out (design-shop §5.1: categories organize an assortment, an empty or private one is not shown).
function browseTree(shop) {
    const roots = roleCategoryIds(shop, roles.browse)
    const published = new Set(publishedIds(shop))
    const childrenOf = new Map()
    const seen = new Set(roots)
    let level = roots
    for (let depth = 0; level.length && depth < limits.treeDepth && seen.size < limits.treeNodes; depth++) {
        const next = []
        for (const row of rowsIn(ROLLUP, "parentProductCategoryId", level)
            .filter(row => activeAt(row, shop.at))
            .sort((a, b) => (a.sequenceNum ?? 0) - (b.sequenceNum ?? 0))) {
            if (seen.has(row.productCategoryId)) continue
            seen.add(row.productCategoryId)
            if (!childrenOf.has(row.parentProductCategoryId)) childrenOf.set(row.parentProductCategoryId, [])
            childrenOf.get(row.parentProductCategoryId).push(row.productCategoryId)
            next.push(row.productCategoryId)
        }
        level = next
    }
    const ids = Array.from(seen).filter(id => !roots.includes(id))
    const categories = Object.fromEntries(rowsIn(CATEGORY, "productCategoryId", ids).map(row => [row.productCategoryId, row]))
    const stocked = new Set(
        rowsIn(MEMBER, "productCategoryId", ids)
            .filter(row => activeAt(row, shop.at) && published.has(row.productId))
            .map(row => row.productCategoryId)
    )
    const build = (parentId, depth) =>
        (childrenOf.get(parentId) || [])
            .filter(id => categories[id])
            .map(id => {
                const children = depth + 1 < limits.treeDepth ? build(id, depth + 1) : []
                return stocked.has(id) || children.length ? Object.assign(categoryCard(shop, categories[id]), {children}) : null
            })
            .filter(Boolean)
    return roots.flatMap(root => build(root, 0))
}
// The node of a category in a tree, or null.
function nodeOf(tree, productCategoryId) {
    for (const node of tree) {
        if (node.id === productCategoryId) return node
        const found = nodeOf(node.children || [], productCategoryId)
        if (found) return found
    }
    return null
}

// ===== operations =====
// get#Home: the store's featured products (its featured category's members, else the featured rank of its publication
// rows), its top categories and the store's name.
function getHome(p) {
    const shop = shopOf(p)
    return answer(shop, {
        store: {productStoreId: shop.productStoreId, name: shop.store.storeName || shop.productStoreId},
        featured: featuredCards(shop),
        categories: browseTree(shop).map(node => Object.assign({}, node, {children: []}))
    })
}
function featuredCards(shop, limit) {
    const featuredCategories = roleCategoryIds(shop, roles.featured)
    const published = publishedIds(shop)
    const inFeatured = new Set(memberIds(featuredCategories, shop.at))
    const candidates = featuredCategories.length
        ? published.filter(id => inFeatured.has(id)).concat(published.filter(id => !inFeatured.has(id)))
        : published
    return cards(shop, publicPage(shop, candidates, 0, limit || limits.featured).answers)
}
// get#Categories: the store's browse tree.
function getCategories(p) {
    const shop = shopOf(p)
    return answer(shop, {categories: browseTree(shop)})
}
// get#Category: a category of the store's tree (NOT_AVAILABLE otherwise), its subcategories with products, and a page of
// its public products in a registered sort.
function getCategory(p) {
    const shop = shopOf(p)
    const productCategoryId = idOf(p.productCategoryId, "productCategoryId")
    const sort = sortOf(p.sort)
    const size = pageSizeOf(p.limit)
    const offset = cursorOf(p.cursor)
    if (!merchandising().storeTree(shop.productStoreId, shop.at).has(productCategoryId)) notAvailable("This category")
    const row = one(CATEGORY, {productCategoryId})
    if (!row) notAvailable("This category")
    const published = new Set(publishedIds(shop))
    const candidates = sorted(
        memberIds([productCategoryId], shop.at).filter(id => published.has(id)),
        sort
    )
    const page = publicPage(shop, candidates, offset, size)
    const node = nodeOf(browseTree(shop), productCategoryId)
    return answer(shop, {
        category: Object.assign(categoryCard(shop, row), {children: node ? node.children : []}),
        products: cards(shop, page.answers),
        nextCursor: page.nextCursor,
        sort,
        sorts: Object.entries(sorts).map(([key, value]) => ({key, label: value.label}))
    })
}
// find#Products: a page of the store's public products, of a category of its tree when given, whose name has the query
// when given, in a registered sort.
function findProducts(p) {
    const shop = shopOf(p)
    const sort = sortOf(p.sort)
    const size = pageSizeOf(p.limit)
    const offset = cursorOf(p.cursor)
    let candidates = publishedIds(shop)
    if (text(p.productCategoryId)) {
        const productCategoryId = idOf(p.productCategoryId, "productCategoryId")
        if (!merchandising().storeTree(shop.productStoreId, shop.at).has(productCategoryId)) notAvailable("This category")
        const members = new Set(memberIds([productCategoryId], shop.at))
        candidates = candidates.filter(id => members.has(id))
    }
    const query = text(p.query)
    if (query) candidates = nameMatches(candidates, queryOf(query))
    const page = publicPage(shop, sorted(candidates, sort), offset, size)
    return answer(shop, {products: cards(shop, page.answers), nextCursor: page.nextCursor, sort})
}
function queryOf(value) {
    const query = text(value)
    if (!query || query.length > limits.queryLength)
        invalid("query", "Enter up to " + limits.queryLength + " characters to search")
    return query
}
// The candidates whose name (or the store's product name) contains every word of the query, ignoring case.
function nameMatches(candidates, query) {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean)
    const products = rowsIn(PRODUCT, "productId", candidates)
    const named = Object.fromEntries(
        products.map(row => [row.productId, [row.productName, row.pseudoId, row.productId].join(" ")])
    )
    return candidates.filter(id => named[id] && words.every(word => named[id].toLowerCase().includes(word)))
}
// search#Shop: products whose index document (MantleProduct, a candidate source only) or name matches the query, public in
// the store now, and the site's published Shop pages whose title matches. state: results, noMatch, or unavailable when
// neither the index nor the database could be searched.
function searchShop(p) {
    const shop = shopOf(p)
    const query = queryOf(p.query)
    const sort = sortOf(p.sort)
    const size = pageSizeOf(p.limit)
    const offset = cursorOf(p.cursor)
    const published = publishedIds(shop)
    const publishedSet = new Set(published)
    let indexed = []
    let indexOk = true
    try {
        const out = lib.call("org.moqui.search.SearchServices.search#DataDocuments", {
            indexName: "mantle",
            documentType: "MantleProduct",
            queryString: simpleQuery(query),
            pageSize: limits.searchHits
        })
        indexed = (out.documentList || []).map(doc => doc.productId || doc._id).filter(id => publishedSet.has(id))
    } catch (error) {
        ec.message.clearErrors()
        indexOk = false
        ec.logger.warn("Shop search of " + shop.siteId + " without the index: " + error.message)
    }
    let named = []
    let databaseOk = true
    try {
        named = nameMatches(published, query)
    } catch (error) {
        databaseOk = false
        ec.logger.error("Shop search of " + shop.siteId + " by name failed: " + error.message)
    }
    if (!indexOk && !databaseOk)
        return answer(shop, {query, state: "unavailable", products: [], pages: [], nextCursor: null, sort})
    const candidates = sort === "featured" ? unique(indexed.concat(named)) : sorted(unique(indexed.concat(named)), sort)
    const page = publicPage(shop, candidates, offset, size)
    const pages = offset ? [] : pageMatches(shop, query)
    const products = cards(shop, page.answers)
    return answer(shop, {
        query,
        state: products.length || pages.length ? "results" : "noMatch",
        products,
        pages,
        nextCursor: page.nextCursor,
        sort
    })
}
// The visitor's text as a plain query of its words (impl-shop P4, F67): the index's query syntax (fields, wildcards,
// ranges, fuzzy and boolean operators, grouping) escaped, so a visitor's text costs what a few words cost. "<" and ">"
// cannot be escaped in a query_string (a bare ">10" is a range), so they become spaces.
const simpleQuery = query =>
    query
        .replace(/[<>]/g, " ")
        .replace(/[+\-=&|!(){}\[\]^"~*?:\\/]/g, character => "\\" + character)
        .replace(/\b(AND|OR|NOT)\b/g, word => word.toLowerCase())
// The site's live Shop pages whose title has every word of the query.
function pageMatches(shop, query) {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean)
    return livePages(shop)
        .filter(row =>
            words.every(word =>
                String(row.title || row.routePath)
                    .toLowerCase()
                    .includes(word)
            )
        )
        .slice(0, limits.contentResults)
        .map(row => ({label: row.title || row.routePath, url: urls.page(shop, row.routePath)}))
}
// The site's pages of the Shop mount live now, one per route (its wiki version the binding's is checked when read).
function livePages(shop) {
    const routes = new Set()
    return rows(SITE_PAGE, {siteId: shop.siteId, appMountId: shop.mount.appMountId})
        .filter(row => row.routePath && row.versionName && activeAt(row, shop.at))
        .sort((a, b) => String(a.routePath).localeCompare(String(b.routePath)))
        .filter(row => (routes.has(row.routePath) ? false : routes.add(row.routePath)))
}
// get#Product: a product public in the store (NOT_AVAILABLE otherwise, the same for a draft, an excluded variant and another
// store's product): its card, store description, its public variants each with its options, price and band, the price of
// the selected variant and quantity (quote), and its canonical URL and slug.
function getProduct(p) {
    const shop = shopOf(p)
    const productId = idOf(p.productId, "productId")
    const found = merchandising().resolve(shop.store, [productId], shop.at, shop.siteId)[0]
    if (!found || !found.isPublic) notAvailable("This product")
    const card = cards(shop, [found])[0]
    if (!card) notAvailable("This product")
    const product = one(PRODUCT, {productId})
    const descriptions = contentTexts(shop, [productId], "PcntDescriptionLong")
    const shortDescriptions = descriptions[productId] ? {} : contentTexts(shop, [productId], "PcntDescription")
    const descriptionHtml = descriptions[productId] || shortDescriptions[productId] || text(product.description)
    const options = variantsOf(shop, [productId])[productId] || []
    const variantCards = options.length ? cards(shop, options) : []
    const features = featureLabels(
        shop,
        variantCards.map(variant => variant.id)
    )
    const variants = variantCards.map(variant => ({
        id: variant.id,
        name: variant.name,
        options: features[variant.id] || variant.name,
        sku: variant.sku,
        price: variant.price,
        availability: variant.availability
    }))
    const quote = quoteOf(shop, card, variants, p.variantId, p.quantity)
    const productImages = (imagesOf(shop, [productId])[productId] || []).slice(0, 12).map(row => imageView(shop, row, card.name))
    return answer(shop, {
        product: Object.assign({}, card, {
            images: productImages,
            slug: slug(card.name),
            description: descriptionHtml ? {$richText: ec.resource.theme.sanitizeRichText(String(descriptionHtml))} : null,
            variants,
            selectedVariantId: quote.variantId,
            quantity: quote.quantity,
            quote: quote.view
        })
    })
}
// The distinguishing feature text of each variant ("Color: Red, Size: L").
function featureLabels(shop, variantIds) {
    const appls = rowsIn(FEATURE_APPL, "productId", variantIds, {applTypeEnumId: "PfatDistinguishing"}).filter(row =>
        activeAt(row, shop.at)
    )
    const features = Object.fromEntries(
        rowsIn(FEATURE, "productFeatureId", unique(appls.map(row => row.productFeatureId))).map(row => [
            row.productFeatureId,
            row
        ])
    )
    const out = {}
    for (const row of appls) {
        const feature = features[row.productFeatureId]
        if (!feature) continue
        const typeText = feature.productFeatureTypeEnumId
            ? one("moqui.basic.Enumeration", {enumId: feature.productFeatureTypeEnumId})?.description || ""
            : ""
        const label = (typeText ? typeText + ": " : "") + (feature.description || feature.abbrev || feature.productFeatureId)
        out[row.productId] = out[row.productId] ? out[row.productId] + ", " + label : label
    }
    return out
}
// The quote of a selection: the variant (one of the product's public variants, or the product itself when it has none) at a
// quantity, its unit price and total, and whether the offer is purchasable.
function quoteOf(shop, card, variants, variantIdValue, quantityValue) {
    const quantity = quantityOf(quantityValue)
    const variantId = text(variantIdValue)
    let chosen = null
    if (variants.length) {
        chosen = variantId ? variants.find(variant => variant.id === variantId) : null
        if (variantId && !chosen) invalid("variantId", "Choose one of the listed options")
    } else if (variantId && variantId !== card.id) invalid("variantId", "Choose one of the listed options")
    const target = chosen || (variants.length ? null : card)
    if (!target)
        return {
            variantId: null,
            quantity,
            view: {quantity, unitPrice: null, total: null, purchasable: false, label: "Choose an option to see its price"}
        }
    const priced = priceOf(shop, target.id, quantity)
    const total = priced.price.available ? money(priced.unit.multiply(toDecimal(quantity)), shop.currencyUomId) : null
    const purchasable = !!(target.availability.purchasable && priced.price.available)
    return {
        variantId: chosen ? chosen.id : null,
        quantity,
        view: {
            quantity,
            unitPrice: priced.price,
            total,
            purchasable,
            label: priced.price.available
                ? quantity + " × " + priced.price.display + " = " + total.display
                : "This option has no price yet"
        }
    }
}
// quote#Selection: the price of a product's variant and quantity, with its availability; nothing is added (P4 adds the cart).
function quoteSelection(p) {
    const shop = shopOf(p)
    const productId = idOf(p.productId, "productId")
    const found = merchandising().resolve(shop.store, [productId], shop.at, shop.siteId)[0]
    if (!found || !found.isPublic) notAvailable("This product")
    const card = cards(shop, [found])[0]
    if (!card) notAvailable("This product")
    const options = variantsOf(shop, [productId])[productId] || []
    const variants = options.length ? cards(shop, options) : []
    const quote = quoteOf(shop, card, variants, p.variantId, p.quantity)
    return answer(shop, {
        productId,
        variantId: quote.variantId,
        quantity: quote.quantity,
        unitPrice: quote.view.unitPrice,
        total: quote.view.total,
        purchasable: quote.view.purchasable,
        label: quote.view.label
    })
}
// get#Page: the site's published page of the Shop mount at a route (Commerce P4's get#SitePage by mount, route and locale:
// the exact published wiki version), NOT_AVAILABLE when none is live.
function getPage(p) {
    const shop = shopOf(p)
    const routePath = text(p.routePath).replace(/^\/+|\/+$/g, "")
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)*$/.test(routePath)) notAvailable("This page")
    let found
    try {
        found = sitePages().execute("getSitePage", {
            siteId: shop.siteId,
            appMountId: shop.mount.appMountId,
            routePath,
            locale: shop.locale
        })
    } catch (error) {
        ec.message.clearErrors()
        notAvailable("This page")
    }
    const page = found.page
    const policyVersion = page.pageRole && sitePages().policyRoles[page.pageRole] ? page.version : null
    return answer(shop, {
        page: {
            sitePageId: page.sitePageId,
            title: page.title || page.routePath,
            description: page.seoDescription || null,
            seoTitle: page.seoTitle || null,
            socialImageUrl: page.socialImageUrl || null,
            locale: page.locale ? String(page.locale).replace(/_/g, "-") : shop.locale,
            routePath: page.routePath,
            url: urls.page(shop, page.routePath),
            templateKey: page.templateKey || null,
            policyRole: policyVersion ? page.pageRole : null,
            policyVersion,
            body: {$richText: page.body || ""}
        }
    })
}
// get#Sitemap: the site paths of the store's current public pages: home, the category tree, the public products and the
// live Shop pages (design-shop §11: only current public pages). Paths under the mount; the frontend makes them absolute.
function getSitemap(p) {
    const shop = shopOf(p)
    const entries = [{path: urls.home(shop), kind: "home"}]
    const walk = nodes => {
        for (const node of nodes) {
            entries.push({path: node.url, kind: "category"})
            walk(node.children || [])
        }
    }
    walk(browseTree(shop))
    const candidates = publishedIds(shop).slice(0, limits.sitemapProducts)
    const names = Object.fromEntries(rowsIn(PRODUCT, "productId", candidates).map(row => [row.productId, row.productName]))
    const storeNames = contentTexts(shop, candidates, "PcntProductName")
    for (let start = 0; start < candidates.length; start += 200)
        for (const found of publicOf(shop, candidates.slice(start, start + 200)))
            entries.push({
                path: urls.product(
                    shop,
                    found.productId,
                    text(storeNames[found.productId]) || names[found.productId] || found.productId
                ),
                kind: "product"
            })
    for (const row of livePages(shop)) entries.push({path: urls.page(shop, row.routePath), kind: "page"})
    return answer(shop, {entries})
}

// ===== the theme view (ThemeView.js pages and sources) =====
// The view of each catalog page kind for the composition adapter (design-shop §12.3's v1 fields; ThemeView.js projects it
// through its shapes). A product, category or page that is not public is NotFound, which the frontend shows as the theme's
// not-found page.
const views = {
    home(p) {
        const home = getHome(p)
        return {productList: home.featured, page: {kind: "home", canonicalUrl: urls.home(shopOf(p))}}
    },
    // the category tree (no productCategoryId: the Categories page, a category named "Categories" whose children are the
    // tree) or a category's page of products
    category(p) {
        const shop = shopOf(p)
        if (!text(p.productCategoryId)) {
            const tree = browseTree(shop)
            return {
                category: {id: "", name: "Categories", url: urls.categories(shop), description: null, children: tree},
                productList: [],
                page: {kind: "category", title: "Categories", canonicalUrl: urls.categories(shop)}
            }
        }
        const found = getCategory(p)
        return {
            category: found.category,
            productList: found.products,
            page: {
                kind: "category",
                title: found.category.name,
                description: found.category.description,
                canonicalUrl: found.category.url,
                nextUrl: found.nextCursor ? withQuery(found.category.url, {sort: p.sort, cursor: found.nextCursor}) : null,
                sort: found.sort
            }
        }
    },
    product(p) {
        const found = getProduct(p).product
        // Commerce P9: the approved reviews under the product (StoreReviews.js; a theme's product.reviews)
        found.reviews = productReviews(shopOf(p), found.id)
        return {
            product: found,
            page: {
                kind: "product",
                title: found.name,
                description: found.description ? plainText(found.description.$richText).slice(0, 160) : null,
                canonicalUrl: found.url
            }
        }
    },
    search(p) {
        const shop = shopOf(p)
        if (!text(p.query))
            return {
                productList: [],
                page: {kind: "search", title: "Search", query: "", resultState: "empty", canonicalUrl: urls.search(shop)}
            }
        let found
        try {
            found = searchShop(p)
        } catch (error) {
            if (error.moquiErrorKind !== "Unprocessable") throw error
            ec.message.clearErrors()
            return {
                productList: [],
                page: {
                    kind: "search",
                    title: "Search",
                    query: text(p.query).slice(0, limits.queryLength),
                    resultState: "invalid",
                    canonicalUrl: urls.search(shop)
                }
            }
        }
        return {
            productList: found.products,
            page: {
                kind: "search",
                title: "Search results for " + found.query,
                query: found.query,
                resultState: found.state,
                contentResults: found.pages,
                canonicalUrl: urls.search(shop),
                nextUrl: found.nextCursor
                    ? withQuery(urls.search(shop), {q: found.query, sort: p.sort, cursor: found.nextCursor})
                    : null
            }
        }
    },
    page(p) {
        const found = getPage(p).page
        return {
            page: {
                kind: "page",
                title: found.seoTitle || found.title,
                description: found.description,
                canonicalUrl: found.url,
                body: found.body,
                socialImageUrl: found.socialImageUrl,
                policyRole: found.policyRole,
                policyVersion: found.policyVersion,
                locale: found.locale,
                // Commerce P5 (F77): the page's alternate template, which ThemeView renders with (never in the theme's view)
                templateKey: found.templateKey
            }
        }
    }
}
// Commerce P9: the first page of a product's approved reviews, their summary and the visitor's own review's state; a failure
// leaves the product page without its reviews.
function productReviews(shop, productId) {
    try {
        const view = ec.resource
            .script("component://mr-mantle/service/mantle/product/StoreReviews.js")
            .reviewsView(shop, productId, {limit: 5})
        return {
            summary: view.summary,
            reviews: view.reviews,
            moreUrl: view.nextCursor ? view.writeUrl : null,
            writeUrl: view.canReview || view.own ? view.writeUrl : null,
            own: view.own ? {statusText: view.own.statusText, approved: view.own.approved} : null
        }
    } catch (error) {
        ec.message.clearErrors()
        ec.logger.error("Reviews of " + productId + " in " + shop.productStoreId + " not read: " + error.message)
        return null
    }
}
const plainText = html =>
    String(html || "")
        .replace(/<[^>]*>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
function withQuery(path, params) {
    const query = Object.entries(params)
        .filter(([, value]) => value != null && value !== "")
        .map(([key, value]) => encodeURIComponent(key) + "=" + encodeURIComponent(String(value)))
        .join("&")
    return query ? path + "?" + query : path
}
// The approved catalog sources a theme section may name (design-shop §12.3), each bounded: the featured products and the
// store's new products.
const sources = {
    featuredProducts: {limit: limits.featured, load: (shop, limit) => featuredCards(shopOf({siteId: shop.siteId}), limit)},
    newProducts: {
        limit: limits.featured,
        load(shop, limit) {
            const full = shopOf({siteId: shop.siteId})
            const members = new Set(memberIds(roleCategoryIds(full, roles.newProducts), full.at))
            return cards(
                full,
                publicPage(
                    full,
                    publishedIds(full).filter(id => members.has(id)),
                    0,
                    limit
                ).answers
            )
        }
    }
}

// ===== Shop P4: the cart's offers (ShopCart.js) =====
// The purchasable product of a selection on a product's page: the product itself, or one of its public variants (an
// option not listed, or none chosen for a product that has options, is VALUE_INVALID). {productId, parentId, card}.
function selectionOf(shop, productIdValue, variantIdValue) {
    const productId = idOf(productIdValue, "productId")
    const found = merchandising().resolve(shop.store, [productId], shop.at, shop.siteId)[0]
    if (!found || !found.isPublic) notAvailable("This product")
    const card = cards(shop, [found])[0]
    if (!card) notAvailable("This product")
    const options = variantsOf(shop, [productId])[productId] || []
    const variantId = text(variantIdValue)
    if (options.length) {
        if (!variantId) invalid("variantId", "Choose an option")
        const option = options.find(found => found.productId === variantId)
        if (!option) invalid("variantId", "Choose one of the listed options")
        const variantCard = cards(shop, [option])[0]
        if (!variantCard) notAvailable("This product")
        return {productId: variantId, parentId: productId, card: variantCard, parentCard: card}
    }
    if (variantId && variantId !== productId) invalid("variantId", "Choose one of the listed options")
    return {productId, parentId: null, card, parentCard: card}
}
// What a cart line's product is offered at now: whether it is still public and purchasable in the store, its card (with
// the parent product's link and the variant's options), and its unit price at a quantity (the authority's price).
// {available, card, unitPrice, unit, compareAtPrice, options, url}.
function offersOf(shop, lines) {
    const ids = unique(lines.map(line => line.productId))
    const answers = Object.fromEntries(
        (ids.length ? merchandising().resolve(shop.store, ids, shop.at, shop.siteId) : []).map(found => [found.productId, found])
    )
    const publicAnswers = ids.map(id => answers[id]).filter(found => found && found.isPublic)
    const byId = Object.fromEntries(cards(shop, publicAnswers).map(card => [card.id, card]))
    const parents = Object.fromEntries(
        rowsIn(ASSOC, "toProductId", ids, {productAssocTypeEnumId: "PatVariant"})
            .filter(row => activeAt(row, shop.at))
            .map(row => [row.toProductId, row.productId])
    )
    const parentIds = unique(Object.values(parents))
    const parentProducts = Object.fromEntries(rowsIn(PRODUCT, "productId", parentIds).map(row => [row.productId, row]))
    const parentNames = contentTexts(shop, parentIds, "PcntProductName")
    const options = featureLabels(
        shop,
        ids.filter(id => parents[id])
    )
    return lines.map(line => {
        const card = byId[line.productId] || null
        const parentId = parents[line.productId]
        const parentName = parentId ? text(parentNames[parentId]) || parentProducts[parentId]?.productName || parentId : null
        const url = card ? (parentId ? urls.product(shop, parentId, parentName) : card.url) : null
        if (!card)
            return {productId: line.productId, available: false, card: null, url: null, options: options[line.productId] || null}
        const priced = priceOf(shop, line.productId, line.quantity || 1)
        return {
            productId: line.productId,
            available: !!(card.availability.purchasable && priced.price.available),
            card,
            url,
            options: options[line.productId] || null,
            unitPrice: priced.price,
            unit: priced.unit || null,
            compareAtPrice: priced.compareAtPrice || null
        }
    })
}

// get#ProductImage (F61): an image of a product public in the store now, by its content id ({file, location}; the
// frontend streams it): only an image type of a served file type, in effect for the store; anything else NOT_AVAILABLE.
function getProductImage(p) {
    const shop = shopOf(p)
    const productContentId = text(p.productContentId)
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(productContentId)) notAvailable("This image")
    const row = one(CONTENT, {productContentId})
    const found = row ? merchandising().resolve(shop.store, [row.productId], shop.at, shop.siteId)[0] : null
    const image =
        found && found.isPublic
            ? (imagesOf(shop, [row.productId])[row.productId] || []).find(item => item.productContentId === productContentId)
            : null
    if (!image) notAvailable("This image")
    const extension = imageExtension(image.contentLocation)
    return {
        file: {mimeType: imageMimeTypes[extension], filename: productContentId + "." + extension},
        location: image.contentLocation
    }
}

const operations = {
    getProductImage,
    getHome,
    getCategories,
    getCategory,
    findProducts,
    searchShop,
    getProduct,
    quoteSelection,
    getPage,
    getSitemap
}
;({
    limits,
    sorts,
    slug,
    views,
    sources,
    // Shop P4: the cart's view of the catalog (ShopCart.js)
    shopOf,
    selectionOf,
    offersOf,
    quantityOf,
    money,
    unavailablePrice,
    // P4 (F67): the index query of a visitor's text
    simpleQuery,
    // Commerce P14 (StoreFeeds.js): a feed build's rows are this projection: the published candidates, the public ones among
    // them, their cards and store descriptions as plain text
    publishedIds,
    publicOf,
    cards,
    contentTexts,
    plainText,
    execute:(op, parameters) => {
        if (!operations[op]) throw new Error("Unknown Shop catalog operation " + op)
        return operations[op](parameters || {})
    }
})
