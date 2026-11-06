// The Shop page view (mr-pass impl-shop P2; design-shop §12.3 view API v1, §12.4's request flow): for a page of a
// published site's Shop mount, the active release and the approved data a theme may see. PASS renders the release with
// it (the composition adapter, docs/ui/Themes.md); nothing here renders.
//
// The view contract v1 holds only site, shop, locale, page, navigation and the page's own projection (product,
// category, productList, cart, checkout, account); stable public ids and links, display text and decimal strings. It
// never holds ec, an entity value, a service caller, a session or user object, a secret, token or staff field:
// contract() is an allow-list projection, keeping only the fields the `shapes` table names (plain JSON values), and
// drops every name in forbiddenNames at any depth as well, so a projection that hands it a whole record (costs,
// internal names, party or user IDs, draft text) still gives a theme only the contract's fields.
//
// Later phases append to the tables: pages (P3 the catalog kinds, P4 cart, P5 checkout, P6 account) and sources (P3's
// product lists). A page kind not in pages is Not Found.
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const themes = ec.resource.script("component://mr-mantle/service/mantle/public/Themes.js")
const shopContext = ec.resource.script("component://mr-mantle/service/mantle/product/ShopContext.js")

// ===== tables =====
const contractKeys = [
    "site",
    "shop",
    "locale",
    "page",
    "navigation",
    "product",
    "category",
    "productList",
    "cart",
    "checkout",
    "account"
]
// The view contract v1's fields (design-shop §12.3), the allow-list contract() projects through: "value" is a string,
// finite number, boolean or null; "rich" a sanitized rich text ({$richText}) or a string; an object names its fields; a
// one-element array is a list of that shape. Later phases append fields here for their page kinds (P3 the catalog's,
// P4 the cart's, P5 checkout's, P6 the account's); a field not named never reaches a theme.
// P3: available is false for a price that is not set (told apart from a zero one)
const price = {amount: "value", currencyUomId: "value", display: "value", available: "value"}
const link = {label: "value", url: "value"}
const image = {url: "value", alt: "value", width: "value", height: "value"}
const productCard = {
    id: "value",
    name: "value",
    url: "value",
    sku: "value",
    description: "rich",
    price,
    compareAtPrice: price,
    availability: {label: "value", purchasable: "value", code: "value"},
    image,
    // P3: the publication row's badge text
    badge: "value"
}
const shapes = {
    site: {displayName: "value", locale: "value"},
    // P4: the cart page's link
    shop: {name: "value", baseUrl: "value", currencyUomId: "value", searchUrl: "value", categoriesUrl: "value", cartUrl: "value"},
    locale: "value",
    page: {
        kind: "value",
        title: "value",
        description: "value",
        canonicalUrl: "value",
        query: "value",
        body: "rich",
        // Commerce P4: a site page's social image, policy role and the exact published version (checkout records the
        // accepted terms version)
        socialImageUrl: "value",
        policyRole: "value",
        policyVersion: "value",
        // P3: the catalog pages' paging, sort and search state, a search's matching Shop pages and a page's locale
        nextUrl: "value",
        sort: "value",
        resultState: "value",
        contentResults: [link],
        locale: "value"
    },
    // a menu has at most three levels (SitePages.js menuLimits)
    navigation: [Object.assign({children: [Object.assign({children: [link]}, link)]}, link)],
    // P3: a product's public variants with their options, the selection and its quote (unit price and total)
    product: Object.assign(
        {
            images: [image],
            slug: "value",
            variants: [
                {
                    id: "value",
                    name: "value",
                    options: "value",
                    sku: "value",
                    price,
                    availability: {label: "value", purchasable: "value", code: "value"}
                }
            ],
            selectedVariantId: "value",
            quantity: "value",
            quote: {quantity: "value", unitPrice: price, total: price, purchasable: "value", label: "value"}
        },
        productCard
    ),
    // P3: a category's subcategories (two levels), the Categories page's tree
    category: {
        id: "value",
        name: "value",
        url: "value",
        description: "rich",
        image,
        children: [
            {
                id: "value",
                name: "value",
                url: "value",
                description: "value",
                children: [{id: "value", name: "value", url: "value", description: "value"}]
            }
        ]
    },
    productList: [productCard],
    cart: {itemCount: "value", subtotal: price},
    checkout: {},
    account: {displayName: "value"}
}
// Names never in a view at any depth (lower case; also any name ending in one of the suffixes).
const forbiddenNames = [
    "ec",
    "sri",
    "context",
    "entity",
    "session",
    "user",
    "useraccount",
    "password",
    "secret",
    "token",
    "apikey",
    "credential"
]
const forbiddenSuffixes = ["secret", "token", "password", "partyid", "userid"]
const maxDepth = 8
const maxItems = 200
// The pages the live path renders in P2, each with its projection: the store's home (no catalog until P3, so an empty
// product list) and the not-found page.
const pages = {
    // P3: the store's featured products (ShopCatalog.js views)
    home: {status: 200, view: (shop, p) => catalog().views.home(p)},
    "not-found": {status: 404, view: () => ({})}
}
// Approved dynamic sources (design-shop §12.3): name -> {limit, load(shop, limit), shape} answering rows, projected
// through the descriptor's shape (a list of shapes.productList's cards when it names none). Each page loads
// each source its template names once (one batch, never one call per card); P3 adds the catalog's.
const sources = {}

// ===== P3: the catalog's page kinds and sources (ShopCatalog.js) =====
const catalog = () => ec.resource.script("component://mr-mantle/service/mantle/product/ShopCatalog.js")
// the Categories page (no productCategoryId) and a category's products
pages.category = {status: 200, view: (shop, p) => catalog().views.category(p)}
pages.product = {status: 200, view: (shop, p) => catalog().views.product(p)}
pages.search = {status: 200, view: (shop, p) => catalog().views.search(p)}
pages.page = {status: 200, view: (shop, p) => catalog().views.page(p)}
// the featured and new products, for a section that names them
sources.featuredProducts = {limit: 12, load: (shop, limit) => catalog().sources.featuredProducts.load(shop, limit)}
sources.newProducts = {limit: 12, load: (shop, limit) => catalog().sources.newProducts.load(shop, limit)}

// ===== P4: the cart page =====
// The cart page's view is the store's alone (the same for every shopper, so a frontend may keep it): its lines, totals and
// forms are the trusted shop.cart component, which PASS makes from the shopper's getCart; view.cart is the mini-cart's
// count and subtotal, which PASS sets from the same answer.
pages.cart = {
    status: 200,
    view: shop => ({
        page: {kind: "cart", title: "Cart", canonicalUrl: shop.cartUrl},
        cart: {itemCount: 0, subtotal: null}
    })
}

// ===== the contract =====
const forbidden = name => {
    const lower = String(name).toLowerCase()
    return forbiddenNames.includes(lower) || forbiddenSuffixes.some(suffix => lower.endsWith(suffix))
}
const isPlainObject = value =>
    value != null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
// A value projected through its shape (the shapes table): only the fields the shape names, each as plain JSON; a value
// that is not of its shape is left out (undefined).
function project(value, shape, depth) {
    if (value === undefined) return undefined
    if (value === null) return null
    if (shape === "value") {
        if (typeof value === "string" || typeof value === "boolean") return value
        if (typeof value === "number") return Number.isFinite(value) ? value : null
        return undefined
    }
    if (shape === "rich") {
        if (typeof value === "string") return value
        return isPlainObject(value) && typeof value.$richText === "string" ? {$richText: value.$richText} : undefined
    }
    if (depth >= maxDepth) return undefined
    if (Array.isArray(shape)) {
        if (!Array.isArray(value)) return undefined
        return value
            .slice(0, maxItems)
            .map(item => project(item, shape[0], depth + 1))
            .filter(item => item !== undefined)
    }
    if (!isPlainObject(value)) return undefined
    const out = {}
    for (const [key, fieldShape] of Object.entries(shape)) {
        if (forbidden(key) || !Object.prototype.hasOwnProperty.call(value, key)) continue
        const kept = project(value[key], fieldShape, depth + 1)
        if (kept !== undefined) out[key] = kept
    }
    return out
}
// The view contract v1 of a view: only its keys and, in each, only the fields its shape names.
function contract(view) {
    const out = {}
    for (const key of contractKeys) {
        if (view[key] === undefined) continue
        const kept = project(view[key], shapes[key], 0)
        if (kept !== undefined) out[key] = kept
    }
    return out
}

// ===== sources =====
// The sources a page's template names (the release's composition), each loaded once; a source that fails is empty
// and logged, and the rest still load.
function loadSources(manifest, template, shop) {
    const names = new Set()
    const name = (manifest && manifest.defaultTemplates && manifest.defaultTemplates[template]) || template
    const composed = manifest && manifest.composition ? manifest.composition[name] : null
    for (const section of Object.values((composed && composed.sections) || {}))
        for (const name of section.sources || []) names.add(name)
    const out = {}
    for (const source of names) {
        const descriptor = sources[source]
        if (!descriptor) continue
        try {
            out[source] = project(descriptor.load(shop, descriptor.limit), descriptor.shape || shapes.productList, 0) || []
        } catch (error) {
            ec.logger.error("Shop source " + source + " of site " + shop.siteId + " failed: " + error.message)
            out[source] = []
        }
    }
    return out
}

// The site's live main menu (Commerce P4, SitePages.js): the active version's items whose destinations are public now; a
// menu that cannot be read is left out and logged.
function mainNavigation(siteId, locale) {
    try {
        const pages = ec.resource.script("component://mr-mantle/service/mantle/public/SitePages.js")
        return pages.liveNavigation(pages.liveContext(siteId), "main", locale)
    } catch (error) {
        ec.logger.error("Shop navigation of site " + siteId + " not read: " + error.message)
        return []
    }
}

// ===== getShopPage =====
// getShopPage: a page of a published site's Shop mount (NOT_AVAILABLE otherwise, as getShopContext): its kind's status,
// the active release (null when none is published: PASS shows its own shell), the site's generation, and the view, the
// references, media and sources the theme renders with. An unknown page kind is Not Found.
function getShopPage(p) {
    const {site, mount, store} = shopContext.shopOf(p.siteId)
    const kind = String(p.pageKind || "")
    const page = pages[kind]
    if (!page) {
        const error = new Error("NOT_AVAILABLE: This page is not available")
        error.moquiErrorKind = "NotFound"
        throw error
    }
    const base = mount.pathPrefix === "/" ? "" : mount.pathPrefix
    const shop = {
        siteId: site.siteId,
        productStoreId: store.productStoreId,
        name: store.storeName || store.productStoreId,
        baseUrl: base || "/",
        currencyUomId: store.defaultCurrencyUomId || null,
        searchUrl: base + "/Search",
        categoriesUrl: base + "/Categories",
        cartUrl: base + "/Cart"
    }
    // a BCP 47 tag for the page (en_US is en-US)
    const locale = String(store.defaultLocale || site.locale || "en").replace(/_/g, "-")
    const release = themes.activeRelease(site.siteId, mount.appMountId)
    let manifest = null
    if (release) {
        const row = lib.one("mantle.public.PublicThemeRelease", {releaseId: release.releaseId})
        manifest = lib.json(row && row.manifestText, null)
    }
    const view = contract(
        Object.assign(
            {
                site: {displayName: site.name || site.siteId, locale: String(site.locale || "en").replace(/_/g, "-")},
                shop: {
                    name: shop.name,
                    baseUrl: shop.baseUrl,
                    currencyUomId: shop.currencyUomId,
                    searchUrl: shop.searchUrl,
                    categoriesUrl: shop.categoriesUrl,
                    cartUrl: shop.cartUrl
                },
                locale,
                page: {kind, canonicalUrl: base + "/"},
                navigation: mainNavigation(site.siteId, locale)
            },
            page.view(shop, p)
        )
    )
    return {
        status: page.status,
        generation: Number(site.generation || 0),
        release: release
            ? {
                  releaseId: release.releaseId,
                  manifestDigest: release.manifestDigest,
                  engine: release.engine,
                  viewApiVersion: release.viewApiVersion
              }
            : null,
        view,
        references: {},
        media: {},
        sources: release ? loadSources(manifest, kind, shop) : {}
    }
}

const operations = {getShopPage}
;({
    contractKeys,
    shapes,
    pages,
    sources,
    contract,
    execute: (op, parameters) => {
        if (!operations[op]) throw new Error("Unknown Shop page operation " + op)
        return operations[op](parameters || {})
    }
})
