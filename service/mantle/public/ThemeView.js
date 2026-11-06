// The Shop page view (mr-pass impl-shop P2; design-shop §12.3 view API v1, §12.4's request flow): for a page of a
// published site's Shop mount, the active release and the approved data a theme may see. PASS renders the release with
// it (the composition adapter, docs/ui/Themes.md); nothing here renders.
//
// The view contract v1 holds only site, shop, locale, page, navigation and the page's own projection (product,
// category, productList, cart, checkout, account); stable public ids and links, display text and decimal strings. It
// never holds ec, an entity value, a service caller, a session or user object, a secret, token or staff field:
// contract() keeps the contract's keys of plain JSON values and drops every name in forbiddenNames at any depth.
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
    home: {status: 200, view: () => ({productList: []})},
    "not-found": {status: 404, view: () => ({})}
}
// Approved dynamic sources (design-shop §12.3): name -> {limit, load(shop, limit)} answering plain rows. Each page loads
// each source its template names once (one batch, never one call per card); P3 adds the catalog's.
const sources = {}

// ===== the contract =====
const forbidden = name => {
    const lower = String(name).toLowerCase()
    return forbiddenNames.includes(lower) || forbiddenSuffixes.some(suffix => lower.endsWith(suffix))
}
// A plain JSON copy of a value: strings, finite numbers, booleans, null, arrays and objects of them, bounded in depth
// and length; anything else (a function, an entity value, a date) is left out, as is a forbidden name.
function plain(value, depth) {
    if (value == null) return null
    if (typeof value === "string" || typeof value === "boolean") return value
    if (typeof value === "number") return Number.isFinite(value) ? value : null
    if (depth >= maxDepth || typeof value !== "object") return undefined
    if (Array.isArray(value))
        return value
            .slice(0, maxItems)
            .map(item => plain(item, depth + 1))
            .filter(item => item !== undefined)
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return undefined
    const out = {}
    for (const [key, item] of Object.entries(value)) {
        if (forbidden(key)) continue
        const kept = plain(item, depth + 1)
        if (kept !== undefined) out[key] = kept
    }
    return out
}
// The view contract v1 of a view: only its keys, as plain JSON without forbidden names.
function contract(view) {
    const out = {}
    for (const key of contractKeys) {
        if (view[key] === undefined) continue
        const kept = plain(view[key], 0)
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
            out[source] = plain(descriptor.load(shop, descriptor.limit), 0) || []
        } catch (error) {
            ec.logger.error("Shop source " + source + " of site " + shop.siteId + " failed: " + error.message)
            out[source] = []
        }
    }
    return out
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
        currencyUomId: store.defaultCurrencyUomId || null
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
                shop: {name: shop.name, baseUrl: shop.baseUrl, currencyUomId: shop.currencyUomId},
                locale,
                page: {kind, canonicalUrl: base + "/"},
                navigation: []
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
    pages,
    sources,
    contract,
    execute: (op, parameters) => {
        if (!operations[op]) throw new Error("Unknown Shop page operation " + op)
        return operations[op](parameters || {})
    }
})
