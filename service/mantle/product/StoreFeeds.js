/* CC0 1.0 Universal plus Grant of Patent License. See LICENSE.md.
 * A store's product feeds and channel health (impl-commerce P14, COM-FEED, COM-REPORTS; design-commerce §9 Feeds,
 * FeedDetail, §3 ChannelHealth; StoreChannelServices.xml):
 *
 * - A feed (ProductStoreFeed) binds a store's Shop site to a registered format and destination (formats, destinations
 *   below; anything else is refused), with its product scope, image and availability policy and schedule. Locale and
 *   currency are the store's: Shop's projection sells in those only.
 * - A build (ProductStoreFeedBuild) is an immutable artifact made only from Shop's public catalog projection
 *   (ShopCatalog.js: the store's published candidates, the resolver's public products among them, their cards and store
 *   descriptions), with the site's publication generation it read, its rows, its skips (each product and why) and its
 *   errors (a product that could not be projected; the others go on). A fatal build (the site not published, no canonical
 *   host, the projection unreadable) is recorded as failed and leaves the feed's active build as it was.
 * - Publishing activates a complete build of the feed only, at the feed's revision and with an operation key (a retry
 *   answers the first result), and only while every product in it is still public.
 * - Serving (get#ShopFeed, the Shop site's reserved feed path): the active build of a current feed, checked against the
 *   site's current generation: once it has moved on, the build's products are resolved again, and one withdrawn since the
 *   build blocks it (NotFound) until a rebuild without it is active. A rebuild reads current publication, so it never
 *   brings back a withdrawn product.
 * - The feed job (run#StoreFeeds) builds each due scheduled feed in its own transaction and publishes a complete build with
 *   no errors; one failing feed is recorded and the others go on.
 * - Channel health (get#ChannelHealth): the stores' channel messages by remote and message type (SystemMessage over
 *   SystemMessageRemote.productStoreId, never a payload or credential) and their feeds' builds for a period.
 *
 * Staff services need COMMERCE_CHANNEL_OPERATE with COMMERCE_VIEW, in the store's scope (StoreAdmin.js scope: the user's
 * organizations, a store-limited staff member's stores). Reads and writes below the checks run without artifact
 * authorization. Prices are decimals: their text is the projection's, never arithmetic here.
 */
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const stores = () => ec.resource.script("component://mr-mantle/service/mantle/product/StoreAdmin.js")
const catalog = () => ec.resource.script("component://mr-mantle/service/mantle/product/ShopCatalog.js")
const merchandising = () => ec.resource.script("component://mr-mantle/service/mantle/product/StoreMerchandising.js")
const publicApps = () => ec.resource.script("component://mr-mantle/service/mantle/public/PublicApps.js")
const {find, one, rows, denied, call, ms, access} = lib
const S = "mantle.product.store."
const FEED = S + "ProductStoreFeed"
const BUILD = S + "ProductStoreFeedBuild"
const ROLLUP = "mantle.product.category.ProductCategoryRollup"
const MEMBER = "mantle.product.category.ProductCategoryMember"

// ===== tables =====
// The registered formats: the public path's extension, the content type and the renderer of the rows.
const formats = {
    PsffGoogleXml: {extension: "xml", contentType: "application/xml; charset=utf-8", render: renderXml},
    PsffCsv: {extension: "csv", contentType: "text/csv; charset=utf-8", render: renderCsv},
    PsffJson: {extension: "json", contentType: "application/json; charset=utf-8", render: renderJson}
}
// The registered destinations: the store's own Shop site, which serves the active build at its reserved feed path. A pushed
// destination registers here with its connector (Integrations, P13), never as a request URL.
const destinations = {PsfdShopSite: {served: true}}
// The schedules the feed job runs, by interval.
const schedules = {PsfsManual: null, PsfsHourly: 3600000, PsfsDaily: 86400000}
// Bounds: rows a build writes, products projected at a time, sample rows kept, skips and errors kept, the category depth,
// the publication rows read at a time and the candidates a build considers.
const limits = {
    rows: 5000,
    chunk: 100,
    sample: 10,
    skips: 500,
    errors: 100,
    depth: 4,
    description: 5000,
    feeds: 200,
    page: 1000,
    candidates: 50000
}
const keyPattern = /^[a-z0-9][a-z0-9-]{0,39}$/
// The feed's availability values of the projection's bands.
const availabilityCodes = {inStock: "in_stock", lowStock: "in_stock", available: "in_stock", backorder: "backorder"}
// SystemMessage states counted as processed (received and consumed, or sent) and as failed.
const processedStatuses = ["SmsgConsumed", "SmsgConfirmed", "SmsgSent"]
const failedStatuses = ["SmsgError", "SmsgRejected"]
const periodLimitMs = 2 * 366 * 86400000
const messageLimit = 10000

// ===== values =====
const text = value => (value == null ? "" : String(value).trim())
const nowMs = () => ms(ec.user.nowTimestamp)
const unique = list => Array.from(new Set(list.filter(Boolean)))
const enumText = enumId => (enumId ? one("moqui.basic.Enumeration", {enumId})?.description || enumId : "")
const revisionOf = row => ms(row.lastUpdatedStamp)
const dateText = value => lib.dateText(value)
function refuse(code, message, kind) {
    const error = new Error(code + ": " + message)
    error.reason = code
    if (kind) error.moquiErrorKind = kind
    throw error
}
const notAvailable = () => refuse("FEED_UNAVAILABLE", "This feed is not available", "NotFound")
const indicator = (value, fallback) => (value == null || value === "" ? fallback : value === "Y" || value === true ? "Y" : "N")
const current = (row, at = nowMs()) => (ms(row.fromDate) ?? -Infinity) <= at && (ms(row.thruDate) ?? Infinity) > at
// The query reading only these fields.
const selecting = (query, fields) => fields.reduce((found, field) => found.selectField(field), query)
const idsOf = build => (build.productIds ? String(build.productIds).split(",").filter(Boolean) : [])

// ===== scope =====
// The user's store scope with the channel operator's permission.
function scopeOf() {
    const s = stores().scope()
    if (!access.has("COMMERCE_CHANNEL_OPERATE")) denied("PERMISSION_DENIED", "COMMERCE_CHANNEL_OPERATE is required")
    return s
}
// A feed of a store the user works; a missing one and one outside the scope are refused alike.
function feedOf(s, productStoreFeedId, forUpdate = false) {
    const feed = productStoreFeedId ? find(FEED, {productStoreFeedId}).forUpdate(forUpdate).one() : null
    if (!feed) denied("RECORD_UNAVAILABLE", "Feed " + (productStoreFeedId || "") + " is not available")
    const store = s ? stores().storeOf(s, feed.productStoreId) : one(S + "ProductStore", {productStoreId: feed.productStoreId})
    return {feed, store}
}
function storeIdsOf(s) {
    return Array.from(stores().storeQuery(s).selectField("productStoreId").orderBy("productStoreId").limit(500).list()).map(
        row => row.productStoreId
    )
}
// The site of a store's Shop: its shop mount must target the store.
function siteOf(store, siteId) {
    const mount = siteId ? rows("mantle.public.PublicSiteApp", {siteId, app: "shop", targetId: store.productStoreId})[0] : null
    const site = mount ? one("mantle.public.PublicSite", {siteId}) : null
    if (!site) refuse("SITE_INVALID[siteId]", "Choose a site whose Shop sells from this store")
    return {site, mount}
}
// The site's canonical public host (never a preview host).
function hostOf(siteId) {
    const host = rows("mantle.public.PublicSiteHost", {siteId, canonical: "Y"}).find(row => !publicApps().isPreviewHost(row))
    return host ? host.hostname : null
}
// The public path of a feed under its site's Shop mount.
function pathOf(feed) {
    const format = formats[feed.formatEnumId]
    const mount = publicApps().mount(feed.siteId, "shop")
    return format && mount ? mount.base + "/feeds/" + feed.feedKey + "." + format.extension : null
}

// ===== the projection =====
// The categories at and below a category (to the depth bound), now.
function categoryTree(productCategoryId) {
    const at = nowMs()
    let level = [productCategoryId]
    const all = new Set(level)
    for (let depth = 0; depth < limits.depth && level.length; depth++) {
        const children = Array.from(find(ROLLUP).condition("parentProductCategoryId", "in", level).list())
            .filter(row => current(row, at))
            .map(row => row.productCategoryId)
            .filter(id => !all.has(id))
        children.forEach(id => all.add(id))
        level = children
    }
    return Array.from(all)
}
// The current members of a category and those below it.
function membersOf(productCategoryId) {
    const at = nowMs()
    return new Set(
        Array.from(find(MEMBER).condition("productCategoryId", "in", categoryTree(productCategoryId)).list())
            .filter(row => current(row, at))
            .map(row => row.productId)
    )
}
// The feed's candidates: the store's products with a current published row now (ShopCatalog.js publishedIds' rule, featured
// rank first then id), in the category tree when the feed is scoped. The publication rows are read a page at a time with no
// bound but limits.candidates, so a store larger than the Shop list's candidate bound (2,000) is covered (F-P14-1).
function candidatesOf(shop, feed) {
    const members = feed.productCategoryId ? membersOf(feed.productCategoryId) : null
    const seen = new Set()
    const out = []
    for (let offset = 0; out.length < limits.candidates; offset += limits.page) {
        const page = Array.from(
            selecting(find(S + "ProductStoreProduct", {productStoreId: shop.productStoreId}), [
                "productId",
                "fromDate",
                "thruDate",
                "publicationKindEnumId",
                "featuredRank"
            ])
                .orderBy("featuredRank")
                .orderBy("productId")
                .orderBy("fromDate")
                .offset(offset)
                .limit(limits.page)
                .list()
        )
        for (const row of page)
            if (
                !seen.has(row.productId) &&
                current(row, shop.at) &&
                (row.publicationKindEnumId || "PspkPublished") === "PspkPublished" &&
                (!members || members.has(row.productId))
            ) {
                seen.add(row.productId)
                out.push(row.productId)
            }
        if (page.length < limits.page) break
    }
    return out.slice(0, limits.candidates)
}
// The feed row of a card: only the public projection's fields, absolute links on the site's canonical host.
function rowOf(card, description, host, includeImages) {
    const sale = card.compareAtPrice ? card.price : null
    const price = card.compareAtPrice || card.price
    return {
        id: card.id,
        sku: card.sku,
        title: card.name,
        description: description ? String(description).slice(0, limits.description) : "",
        link: "https://" + host + card.url,
        imageLink: includeImages && card.image ? "https://" + host + card.image.url : null,
        price: String(price.amount) + " " + price.currencyUomId,
        salePrice: sale ? String(sale.amount) + " " + sale.currencyUomId : null,
        availability: availabilityCodes[card.availability.code] || "out_of_stock",
        badge: card.badge || null
    }
}
// The rows of a feed now: {shop, host, rows, skips, errors}; a fatal problem throws.
function project(feed) {
    const shopCatalog = catalog()
    let shop
    try {
        shop = shopCatalog.shopOf({siteId: feed.siteId})
    } catch (error) {
        refuse("SITE_UNAVAILABLE", "The feed's site is not published with its Shop")
    }
    // a visitor's projection: never the signed-in operator's own prices (a customer's rows, get#StoreProductPrice)
    shop.customerPartyId = null
    if (shop.productStoreId !== feed.productStoreId) refuse("SITE_UNAVAILABLE", "The feed's site no longer sells from its store")
    const host = hostOf(feed.siteId)
    if (!host) refuse("HOST_REQUIRED", "The feed's site has no canonical host for its links")
    if (!formats[feed.formatEnumId]) refuse("FORMAT_UNREGISTERED", "The feed's format is not registered")
    const candidates = candidatesOf(shop, feed)
    const out = {shop, host, rows: [], skips: [], errors: []}
    const skip = (productId, reasonCode) => out.skips.push({productId, reasonCode})
    for (let start = 0; start < candidates.length; start += limits.chunk) {
        const chunk = candidates.slice(start, start + limits.chunk)
        // past the row bound the rest are not projected
        if (out.rows.length >= limits.rows) {
            for (const productId of chunk) skip(productId, "ROW_LIMIT")
            continue
        }
        const answers = merchandising().resolve(shop.store, chunk, shop.at, shop.siteId)
        const visible = []
        for (const found of answers) {
            if (found.isPublic) visible.push(found)
            else skip(found.productId, found.reasonCode || "NOT_PUBLIC")
        }
        let cards
        try {
            cards = shopCatalog.cards(shop, visible)
        } catch (error) {
            // one product the projection cannot read: each apart, so the others go on
            ec.message.clearErrors()
            cards = []
            for (const found of visible) {
                try {
                    cards.push(...shopCatalog.cards(shop, [found]))
                } catch (productError) {
                    ec.message.clearErrors()
                    ec.logger.error("Feed " + feed.productStoreFeedId + " product " + found.productId + ": " + productError)
                    out.errors.push({productId: found.productId, message: "The product could not be read for the feed"})
                }
            }
        }
        const descriptions = shopCatalog.contentTexts(
            shop,
            cards.map(card => card.id),
            "PcntDescription"
        )
        for (const card of cards) {
            if (!card.price.available) skip(card.id, "PRICE_UNAVAILABLE")
            else if (!card.availability.purchasable && feed.includeUnavailable !== "Y") skip(card.id, "NOT_PURCHASABLE")
            else if (out.rows.length >= limits.rows) skip(card.id, "ROW_LIMIT")
            else out.rows.push(rowOf(card, shopCatalog.plainText(descriptions[card.id]), host, feed.includeImages !== "N"))
        }
    }
    return out
}

// ===== formats =====
const xmlText = value =>
    String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        // characters XML 1.0 does not allow
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
function renderXml(feed, projection) {
    const tag = (name, value) => (value == null || value === "" ? "" : "<" + name + ">" + xmlText(value) + "</" + name + ">")
    const items = projection.rows.map(
        row =>
            "<item>" +
            tag("g:id", row.id) +
            tag("title", row.title) +
            tag("description", row.description) +
            tag("link", row.link) +
            tag("g:image_link", row.imageLink) +
            tag("g:price", row.price) +
            tag("g:sale_price", row.salePrice) +
            tag("g:availability", row.availability) +
            tag("g:condition", "new") +
            tag("g:mpn", row.sku) +
            "</item>\n"
    )
    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">\n<channel>' +
        tag("title", feed.feedName) +
        tag("link", "https://" + projection.host + projection.shop.base + "/") +
        tag("description", projection.shop.store.storeName || feed.productStoreId) +
        "\n" +
        items.join("") +
        "</channel>\n</rss>\n"
    )
}
// A CSV cell: text a spreadsheet would read as a formula behind an apostrophe; quoted when it holds a comma, quote or line.
function csvCell(value) {
    let cell = value == null ? "" : String(value)
    if (/^[=+\-@\t\r]/.test(cell)) cell = "'" + cell
    return /[",\n\r]/.test(cell) ? '"' + cell.replace(/"/g, '""') + '"' : cell
}
const csvColumns = [
    ["id", "id"],
    ["title", "title"],
    ["description", "description"],
    ["link", "link"],
    ["image_link", "imageLink"],
    ["price", "price"],
    ["sale_price", "salePrice"],
    ["availability", "availability"],
    ["mpn", "sku"]
]
function renderCsv(feed, projection) {
    const lines = [csvColumns.map(column => column[0]).join(",")]
    for (const row of projection.rows) lines.push(csvColumns.map(column => csvCell(row[column[1]])).join(","))
    return lines.join("\r\n") + "\r\n"
}
function renderJson(feed, projection) {
    return JSON.stringify({
        title: feed.feedName,
        link: "https://" + projection.host + projection.shop.base + "/",
        items: projection.rows.map(row => ({
            id: row.id,
            title: row.title,
            description: row.description,
            link: row.link,
            image_link: row.imageLink,
            price: row.price,
            sale_price: row.salePrice,
            availability: row.availability,
            mpn: row.sku
        }))
    })
}

// ===== builds =====
// Make a build of a feed now: a complete build with its artifact, or the fatal problem thrown (the caller records it).
function makeBuild(feed, scheduled) {
    const startedDate = ec.user.nowTimestamp
    const projection = project(feed)
    const format = formats[feed.formatEnumId]
    const artifact = format.render(feed, projection)
    const skips = projection.skips.slice(0, limits.skips)
    return call("create#" + BUILD, {
        productStoreFeedId: feed.productStoreFeedId,
        productStoreId: feed.productStoreId,
        siteId: feed.siteId,
        buildStatusEnumId: "PsfbComplete",
        formatEnumId: feed.formatEnumId,
        locale: feed.locale,
        currencyUomId: feed.currencyUomId,
        generation: projection.shop.publication.generation,
        startedDate,
        completedDate: ec.user.nowTimestamp,
        builtByUserId: ec.user.userId || null,
        scheduled: scheduled ? "Y" : "N",
        rowCount: projection.rows.length,
        skipCount: projection.skips.length,
        errorCount: projection.errors.length,
        productIds: projection.rows.map(row => row.id).join(","),
        skipsJson: JSON.stringify(skips),
        errorsJson: JSON.stringify(projection.errors.slice(0, limits.errors)),
        sampleJson: JSON.stringify(projection.rows.slice(0, limits.sample)),
        contentType: format.contentType,
        artifactDigest: ec.resource.digestText(artifact, "sha256"),
        artifactSize: artifact.length,
        artifactText: artifact
    }).feedBuildId
}
// A failed build: its reason, no artifact; the feed's active build is left as it was.
function recordFailure(feed, error, scheduled) {
    const message = String(error?.message || error).replace(/^(Error: )+/, "")
    const code = lib.reasonCode({message}) || "BUILD_FAILED"
    return call("create#" + BUILD, {
        productStoreFeedId: feed.productStoreFeedId,
        productStoreId: feed.productStoreId,
        siteId: feed.siteId,
        buildStatusEnumId: "PsfbFailed",
        formatEnumId: feed.formatEnumId,
        startedDate: ec.user.nowTimestamp,
        completedDate: ec.user.nowTimestamp,
        builtByUserId: ec.user.userId || null,
        scheduled: scheduled ? "Y" : "N",
        rowCount: 0,
        skipCount: 0,
        errorCount: 0,
        failureCode: code.replace(/\[.*$/, ""),
        failureText: message.replace(/^[A-Z][A-Z0-9_]*(\[[^\]]*\])?: /, "").slice(0, 250)
    }).feedBuildId
}
// The latest instant after since and at or before now at which a publication row of the store (ProductStoreProduct: published
// or excluded) or one of its category roles (ProductStoreCategory: the view and purchase allow lists) started or ended, or
// null. A change scheduled ahead advanced the generation when it was scheduled, not when it takes effect.
function takenEffectSince(productStoreId, since, now) {
    let latest = null
    for (const entity of [S + "ProductStoreProduct", S + "ProductStoreCategory"])
        for (const field of ["fromDate", "thruDate"]) {
            const found = Array.from(
                selecting(find(entity, {productStoreId}), [field])
                    .condition(field, ">", new Date(since))
                    .condition(field, "<=", new Date(now))
                    .orderBy("-" + field)
                    .limit(1)
                    .list()
            )[0]
            const at = found ? ms(found[field]) : null
            if (at != null && (latest == null || at > latest)) latest = at
        }
    return latest
}
// Whether a build may be served or published now: at its own generation, with no scheduled publication change taking effect
// since it was built, it is; otherwise every product in it must still be public. {ok, withdrawn, generation}. Remembered by
// build, generation and the latest change taken effect (a withdrawal advances the generation, or takes effect on its date).
function servable(build) {
    const site = one("mantle.public.PublicSite", {siteId: build.siteId})
    const generation = Number(site?.generation || 0)
    if (!site) return {ok: false, withdrawn: [], generation}
    const effective = takenEffectSince(build.productStoreId, ms(build.startedDate) ?? 0, nowMs())
    if (generation === Number(build.generation || 0) && effective == null) return {ok: true, withdrawn: [], generation}
    const key = build.feedBuildId + "@" + generation + (effective == null ? "" : "@" + effective)
    let cache = null
    try {
        cache = ec.cache.getCache("mantle.product.feedServing")
        const known = cache.get(key)
        if (known) return JSON.parse(known)
    } catch (error) {
        cache = null
    }
    const store = one(S + "ProductStore", {productStoreId: build.productStoreId})
    const ids = idsOf(build)
    const withdrawn = []
    for (let start = 0; start < ids.length; start += 200)
        for (const found of merchandising().resolve(store, ids.slice(start, start + 200), nowMs(), build.siteId))
            if (!found.isPublic) withdrawn.push(found.productId)
    const answer = {ok: withdrawn.length === 0, withdrawn: withdrawn.slice(0, 50), generation}
    if (cache)
        try {
            cache.put(key, JSON.stringify(answer))
        } catch (error) {
            ec.logger.warn("Feed serving check not kept: " + error)
        }
    return answer
}
// Make a build the feed's active one: a complete build of this feed in its current format, every product still public.
function activate(feed, build) {
    if (!build || build.productStoreFeedId !== feed.productStoreFeedId)
        denied("RECORD_UNAVAILABLE", "This build is not of the feed")
    if (build.buildStatusEnumId !== "PsfbComplete") refuse("BUILD_INCOMPLETE", "Only a complete build can be published")
    if (build.formatEnumId !== feed.formatEnumId)
        refuse("BUILD_OUTDATED", "The feed's format changed after this build; build it again")
    if (!current(feed)) refuse("FEED_ENDED", "The feed has ended")
    const check = servable(build)
    if (!check.ok)
        refuse(
            "BUILD_STALE",
            "A product in this build was withdrawn after it was built (" + check.withdrawn.join(", ") + "); build it again"
        )
    call("update#" + FEED, {
        productStoreFeedId: feed.productStoreFeedId,
        activeBuildId: build.feedBuildId,
        activatedDate: ec.user.nowTimestamp,
        activatedByUserId: ec.user.userId || null
    })
    return {productStoreFeedId: feed.productStoreFeedId, feedBuildId: build.feedBuildId, generation: check.generation}
}
// run#StoreFeedBuild: one build in the caller's (its own) transaction, published when asked and clean.
function runStoreFeedBuild(p) {
    if (ec.user.userId) feedOf(scopeOf(), p.productStoreFeedId)
    const feed = find(FEED, {productStoreFeedId: p.productStoreFeedId}).forUpdate(true).one()
    if (!feed) denied("RECORD_UNAVAILABLE", "Feed " + p.productStoreFeedId + " is not available")
    if (!current(feed)) refuse("FEED_ENDED", "The feed has ended")
    const feedBuildId = makeBuild(feed, p.scheduled === "Y" || p.scheduled === true)
    const build = one(BUILD, {feedBuildId})
    let published = false
    if ((p.publish === "Y" || p.publish === true) && Number(build.errorCount || 0) === 0) {
        activate(feed, build)
        published = true
    }
    return {feedBuildId, published}
}

// ===== staff services =====
function buildSummary(build) {
    if (!build) return null
    return {
        feedBuildId: build.feedBuildId,
        statusText: enumText(build.buildStatusEnumId),
        complete: build.buildStatusEnumId === "PsfbComplete",
        startedDateText: dateText(build.startedDate),
        completedDateText: dateText(build.completedDate),
        completedDate: build.completedDate,
        generation: Number(build.generation || 0),
        rowCount: Number(build.rowCount || 0),
        skipCount: Number(build.skipCount || 0),
        errorCount: Number(build.errorCount || 0),
        failureCode: build.failureCode || null,
        failureText: build.failureText || null,
        artifactDigest: build.artifactDigest || null,
        artifactSize: build.artifactSize == null ? null : Number(build.artifactSize),
        scheduled: build.scheduled === "Y"
    }
}
// The metadata of builds (never their artifacts).
const buildFields = [
    "feedBuildId",
    "productStoreFeedId",
    "productStoreId",
    "siteId",
    "buildStatusEnumId",
    "formatEnumId",
    "generation",
    "startedDate",
    "completedDate",
    "scheduled",
    "rowCount",
    "skipCount",
    "errorCount",
    "failureCode",
    "failureText",
    "artifactDigest",
    "artifactSize"
]
const buildsOf = (productStoreFeedId, limit, conditions = {}) =>
    Array.from(
        selecting(find(BUILD, Object.assign({productStoreFeedId}, conditions)), buildFields)
            .orderBy("-startedDate")
            .orderBy("-feedBuildId")
            .limit(limit)
            .list()
    )
function feedView(feed, store) {
    const active = feed.activeBuildId ? selecting(find(BUILD, {feedBuildId: feed.activeBuildId}), buildFields).one() : null
    const latest = buildsOf(feed.productStoreFeedId, 1)[0] || null
    const complete =
        latest?.buildStatusEnumId === "PsfbComplete"
            ? latest
            : buildsOf(feed.productStoreFeedId, 1, {buildStatusEnumId: "PsfbComplete"})[0] || null
    const site = one("mantle.public.PublicSite", {siteId: feed.siteId})
    const isCurrent = current(feed)
    return {
        productStoreFeedId: feed.productStoreFeedId,
        productStoreId: feed.productStoreId,
        storeName: store?.storeName || feed.productStoreId,
        siteId: feed.siteId,
        siteName: site?.name || feed.siteId,
        feedName: feed.feedName,
        feedKey: feed.feedKey,
        formatEnumId: feed.formatEnumId,
        formatText: enumText(feed.formatEnumId),
        destinationEnumId: feed.destinationEnumId,
        destinationText: enumText(feed.destinationEnumId),
        locale: feed.locale,
        currencyUomId: feed.currencyUomId,
        productCategoryId: feed.productCategoryId || null,
        categoryName: feed.productCategoryId
            ? one("mantle.product.category.ProductCategory", {productCategoryId: feed.productCategoryId})?.categoryName ||
              feed.productCategoryId
            : null,
        includeImages: feed.includeImages || "Y",
        includeUnavailable: feed.includeUnavailable || "N",
        scheduleEnumId: feed.scheduleEnumId || "PsfsManual",
        scheduleText: enumText(feed.scheduleEnumId || "PsfsManual"),
        current: isCurrent,
        stateText: isCurrent ? (active ? "Serving" : "Not published") : "Ended",
        publicPath: pathOf(feed),
        activeBuild: buildSummary(active),
        latestBuild: buildSummary(latest),
        lastCompleteBuild: buildSummary(complete),
        activatedDateText: dateText(feed.activatedDate),
        changeReason: feed.changeReason || null,
        revision: revisionOf(feed)
    }
}
// find#StoreFeeds: the feeds of the user's stores, newest first.
function findStoreFeeds(p) {
    const s = scopeOf()
    let storeIds
    if (text(p.productStoreId)) storeIds = [stores().storeOf(s, text(p.productStoreId)).productStoreId]
    else storeIds = storeIdsOf(s)
    if (!storeIds.length) return lib.pageList([], p, "feeds")
    let query = find(FEED).condition("productStoreId", "in", storeIds)
    if (text(p.siteId)) query = query.condition("siteId", text(p.siteId))
    if (text(p.formatEnumId)) query = query.condition("formatEnumId", text(p.formatEnumId))
    const state = text(p.state) || "current"
    const list = Array.from(query.orderBy("-fromDate").orderBy("productStoreFeedId").limit(limits.feeds).list()).filter(feed =>
        state === "all" ? true : state === "ended" ? !current(feed) : current(feed)
    )
    const storeRows = Object.fromEntries(
        Array.from(
            find(S + "ProductStore")
                .condition("productStoreId", "in", storeIds)
                .list()
        ).map(row => [row.productStoreId, row])
    )
    const paged = lib.pageList(list, p, "feeds")
    paged.feeds = paged.feeds.map(feed => feedView(feed, storeRows[feed.productStoreId]))
    return paged
}
// get#StoreFeed: one feed with its recent builds.
function getStoreFeed(p) {
    const s = scopeOf()
    const {feed, store} = feedOf(s, text(p.productStoreFeedId))
    return {
        feed: feedView(feed, store),
        builds: buildsOf(feed.productStoreFeedId, Math.min(50, Math.max(1, Number(p.limit) || 20))).map(buildSummary)
    }
}
function checkValues(store, p, existing) {
    const value = name => (p[name] !== undefined ? p[name] : existing ? existing[name] : undefined)
    const feedName = text(value("feedName"))
    if (!feedName || feedName.length > 80) refuse("VALUE_INVALID[feedName]", "Name the feed, in at most 80 characters")
    const feedKey = text(value("feedKey")).toLowerCase()
    if (!keyPattern.test(feedKey))
        refuse("VALUE_INVALID[feedKey]", "The feed's address name is lower case letters, digits and hyphens (at most 40)")
    const formatEnumId = text(value("formatEnumId"))
    if (!Object.hasOwn(formats, formatEnumId)) refuse("FORMAT_UNREGISTERED[formatEnumId]", "Choose a registered feed format")
    const destinationEnumId = text(value("destinationEnumId")) || "PsfdShopSite"
    if (!Object.hasOwn(destinations, destinationEnumId))
        refuse("DESTINATION_UNREGISTERED[destinationEnumId]", "Choose a registered feed destination")
    const siteId = text(value("siteId"))
    siteOf(store, siteId)
    const locale = text(value("locale")) || store.defaultLocale || "en_US"
    if (store.defaultLocale && locale !== store.defaultLocale)
        refuse("VALUE_INVALID[locale]", "Shop's catalog of this store is in " + store.defaultLocale + " only")
    const currencyUomId = text(value("currencyUomId")) || store.defaultCurrencyUomId || "USD"
    if (currencyUomId !== (store.defaultCurrencyUomId || "USD"))
        refuse("VALUE_INVALID[currencyUomId]", "Shop's catalog of this store sells in " + (store.defaultCurrencyUomId || "USD"))
    const productCategoryId = text(value("productCategoryId")) || null
    if (productCategoryId && !one("mantle.product.category.ProductCategory", {productCategoryId}))
        refuse("VALUE_INVALID[productCategoryId]", "Choose a category of the store")
    const scheduleEnumId = text(value("scheduleEnumId")) || "PsfsManual"
    if (!Object.hasOwn(schedules, scheduleEnumId)) refuse("VALUE_INVALID[scheduleEnumId]", "Choose a listed schedule")
    const taken = rows(FEED, {siteId, feedKey}).find(
        row => current(row) && (!existing || row.productStoreFeedId !== existing.productStoreFeedId)
    )
    if (taken) refuse("FEED_KEY_TAKEN[feedKey]", "Another feed of the site has the address name " + feedKey)
    return {
        feedName,
        feedKey,
        formatEnumId,
        destinationEnumId,
        siteId,
        locale,
        currencyUomId,
        productCategoryId,
        includeImages: indicator(value("includeImages"), "Y"),
        includeUnavailable: indicator(value("includeUnavailable"), "N"),
        scheduleEnumId
    }
}
// store#StoreFeed: a new feed, a change to one at its revision, or one ended.
function storeStoreFeed(p) {
    const s = scopeOf()
    const changeReason = text(p.changeReason).slice(0, 250) || null
    if (text(p.productStoreFeedId)) {
        const {feed, store} = feedOf(s, text(p.productStoreFeedId), true)
        if (p.expectedRevision == null || String(p.expectedRevision) !== String(revisionOf(feed)))
            refuse("STALE_REVISION", "The feed changed since it was shown (revision " + revisionOf(feed) + "); review it again")
        if (!current(feed)) refuse("FEED_ENDED", "The feed has ended")
        if (p.ended === "Y" || p.ended === true) {
            call("update#" + FEED, {productStoreFeedId: feed.productStoreFeedId, thruDate: ec.user.nowTimestamp, changeReason})
            return {productStoreFeedId: feed.productStoreFeedId, ended: true}
        }
        const values = checkValues(store, p, feed)
        const rebind = ["siteId", "feedKey", "formatEnumId", "productCategoryId"].some(
            name => (values[name] || null) !== (feed[name] || null)
        )
        call(
            "update#" + FEED,
            Object.assign(
                {productStoreFeedId: feed.productStoreFeedId, changeReason},
                values,
                rebind ? {activeBuildId: null} : {}
            )
        )
        return {productStoreFeedId: feed.productStoreFeedId, activeCleared: rebind && !!feed.activeBuildId}
    }
    const store = stores().storeOf(s, text(p.productStoreId))
    const values = checkValues(store, p, null)
    const out = call(
        "create#" + FEED,
        Object.assign({productStoreId: store.productStoreId, fromDate: ec.user.nowTimestamp, changeReason}, values)
    )
    return {productStoreFeedId: out.productStoreFeedId}
}
// build#StoreFeed: build a feed now in its own transaction; a fatal problem is recorded as a failed build.
function buildStoreFeed(p) {
    const s = scopeOf()
    const {feed} = feedOf(s, text(p.productStoreFeedId))
    if (!current(feed)) refuse("FEED_ENDED", "The feed has ended")
    let feedBuildId
    let failed = false
    try {
        feedBuildId = lib.probe("mantle.product.StoreChannelServices.run#StoreFeedBuild", {
            productStoreFeedId: feed.productStoreFeedId
        }).feedBuildId
    } catch (error) {
        ec.logger.warn("Feed " + feed.productStoreFeedId + " build failed: " + error.message)
        feedBuildId = recordFailure(feed, error, false)
        failed = true
    }
    return {feedBuildId, failed, build: buildSummary(one(BUILD, {feedBuildId}))}
}
// get#FeedBuild: a build's metadata, skips (with product names), errors, sample rows and whether it can be published now;
// its artifact only when asked (withArtifact, the operator's download).
function getFeedBuild(p) {
    const s = scopeOf()
    const build = one(BUILD, {feedBuildId: text(p.feedBuildId)})
    if (!build) denied("RECORD_UNAVAILABLE", "Build " + text(p.feedBuildId) + " is not available")
    const {feed, store} = feedOf(s, build.productStoreFeedId)
    const skips = lib.json(build.skipsJson, [])
    const names = Object.fromEntries(
        skips.length
            ? Array.from(
                  find("mantle.product.Product")
                      .condition(
                          "productId",
                          "in",
                          skips.map(skip => skip.productId)
                      )
                      .selectField("productId")
                      .selectField("productName")
                      .list()
              ).map(row => [row.productId, row.productName || row.productId])
            : []
    )
    const complete = build.buildStatusEnumId === "PsfbComplete"
    const check = complete ? servable(build) : {ok: false, withdrawn: []}
    const isActive = feed.activeBuildId === build.feedBuildId
    const out = {
        build: Object.assign(buildSummary(build), {
            productStoreFeedId: feed.productStoreFeedId,
            feedName: feed.feedName,
            storeName: store?.storeName || feed.productStoreId,
            formatText: enumText(build.formatEnumId),
            contentType: build.contentType || null,
            isActive,
            servable: check.ok,
            withdrawn: check.withdrawn,
            currentGeneration: check.generation ?? null,
            canPublish: complete && check.ok && !isActive && current(feed) && build.formatEnumId === feed.formatEnumId,
            feedRevision: revisionOf(feed)
        }),
        skips: skips.map(skip => ({
            productId: skip.productId,
            productName: names[skip.productId] || skip.productId,
            reasonCode: skip.reasonCode
        })),
        errors: lib.json(build.errorsJson, []),
        sample: lib.json(build.sampleJson, [])
    }
    if (p.withArtifact === "Y" || p.withArtifact === true) {
        if (!complete) refuse("BUILD_INCOMPLETE", "A failed build has no artifact")
        out.artifactText = build.artifactText
    }
    return out
}
// publish#StoreFeed: make a complete build the feed's active one, at the feed's revision, with an operation key.
function publishStoreFeed(p) {
    const s = scopeOf()
    const {feed, store} = feedOf(s, text(p.productStoreFeedId), true)
    const op = lib.operation(p, "StoreFeedPublish", store.organizationPartyId, {
        productStoreFeedId: feed.productStoreFeedId,
        feedBuildId: text(p.feedBuildId)
    })
    const previous = lib.previous(op)
    if (previous) return previous
    if (p.expectedRevision == null || String(p.expectedRevision) !== String(revisionOf(feed)))
        refuse("STALE_REVISION", "The feed changed since it was shown (revision " + revisionOf(feed) + "); review it again")
    const build = one(BUILD, {feedBuildId: text(p.feedBuildId)})
    const result = activate(feed, build)
    lib.complete(op, FEED, feed.productStoreFeedId, result)
    return result
}

// ===== the feed job =====
// run#StoreFeeds: each current scheduled feed whose interval has passed, built in its own transaction and published when
// complete with no errors; a failure is recorded as a failed build and the others go on.
function runStoreFeeds(p) {
    const now = nowMs()
    const limit = Math.min(200, Math.max(1, Number(p.limit) || 50))
    const due = Array.from(
        find(FEED).condition("scheduleEnumId", "in", ["PsfsHourly", "PsfsDaily"]).orderBy("productStoreFeedId").list()
    )
        .filter(feed => current(feed, now))
        .filter(
            feed => feed.lastScheduledDate == null || ms(feed.lastScheduledDate) + schedules[feed.scheduleEnumId] <= now + 60000
        )
        .slice(0, limit)
    const results = []
    for (const feed of due) {
        let result
        try {
            const out = lib.probe("mantle.product.StoreChannelServices.run#StoreFeedBuild", {
                productStoreFeedId: feed.productStoreFeedId,
                publish: "Y",
                scheduled: "Y"
            })
            result = {productStoreFeedId: feed.productStoreFeedId, feedBuildId: out.feedBuildId, published: !!out.published}
        } catch (error) {
            ec.logger.error("Feed job: feed " + feed.productStoreFeedId + " failed: " + error.message)
            result = {
                productStoreFeedId: feed.productStoreFeedId,
                failed: true,
                reasonCode: lib.reasonCode({message: String(error.message).replace(/^(Error: )+/, "")}) || "BUILD_FAILED"
            }
            try {
                result.feedBuildId = recordFailure(feed, error, true)
            } catch (recordError) {
                ec.logger.error("Feed job: failure of feed " + feed.productStoreFeedId + " not recorded: " + recordError)
            }
        }
        try {
            call("update#" + FEED, {productStoreFeedId: feed.productStoreFeedId, lastScheduledDate: ec.user.nowTimestamp})
        } catch (error) {
            ec.logger.error("Feed job: feed " + feed.productStoreFeedId + " schedule not recorded: " + error)
        }
        results.push(result)
    }
    return {
        dueCount: due.length,
        builtCount: results.filter(result => !result.failed).length,
        failedCount: results.filter(result => result.failed).length,
        results
    }
}

// ===== serving (the Shop site's feed path) =====
// get#ShopFeed (getShopFeed): the active build of a current feed of the site's Shop by its key and extension, if it may be
// served at the site's current generation; anything else is NotFound (FEED_UNAVAILABLE).
function getShopFeed(p) {
    const shop = catalog().shopOf(p)
    const feedKey = text(p.feedKey).toLowerCase()
    const extension = text(p.extension).toLowerCase()
    if (!keyPattern.test(feedKey)) notAvailable()
    const feed = rows(FEED, {siteId: shop.siteId, feedKey}).find(
        row =>
            current(row) &&
            row.productStoreId === shop.productStoreId &&
            destinations[row.destinationEnumId]?.served &&
            row.activeBuildId
    )
    if (!feed || formats[feed.formatEnumId]?.extension !== extension) notAvailable()
    const build = one(BUILD, {feedBuildId: feed.activeBuildId})
    if (!build || build.buildStatusEnumId !== "PsfbComplete" || build.formatEnumId !== feed.formatEnumId) notAvailable()
    if (!servable(build).ok) notAvailable()
    return {
        content: build.artifactText,
        contentType: build.contentType,
        digest: build.artifactDigest,
        generation: shop.publication.generation,
        builtGeneration: Number(build.generation || 0),
        builtDate: ms(build.completedDate)
    }
}

// ===== channel health =====
function periodOf(p) {
    const thru = p.thruDate ? ms(p.thruDate) : nowMs()
    const from = p.fromDate ? ms(p.fromDate) : thru - 30 * 86400000
    if (!Number.isFinite(from) || !Number.isFinite(thru) || from >= thru || thru - from > periodLimitMs)
        refuse("PERIOD_INVALID", "Choose a period of at most two years")
    return {from, thru}
}
// get#ChannelHealth: by store, remote and message type the messages received in the period (received, processed, failed,
// retried, the last success), and each current feed's builds (the active and last complete build, its skips, failures in
// the period, whether serving is blocked by a withdrawal); totals for Home's card.
function getChannelHealth(p) {
    const s = scopeOf()
    const storeIds = text(p.productStoreId)
        ? [stores().storeOf(s, text(p.productStoreId)).productStoreId]
        : p.productStoreIds?.length
          ? Array.from(p.productStoreIds).map(id => stores().storeOf(s, String(id)).productStoreId)
          : storeIdsOf(s)
    const {from, thru} = periodOf(p)
    const storeNames = Object.fromEntries(
        storeIds.length
            ? Array.from(
                  find(S + "ProductStore")
                      .condition("productStoreId", "in", storeIds)
                      .selectField("productStoreId")
                      .selectField("storeName")
                      .list()
              ).map(row => [row.productStoreId, row.storeName || row.productStoreId])
            : []
    )
    // the stores' remotes: their id, description, store and message type only (never a URL, user or secret)
    const remotes = storeIds.length
        ? Array.from(
              selecting(find("moqui.service.message.SystemMessageRemote").condition("productStoreId", "in", storeIds), [
                  "systemMessageRemoteId",
                  "description",
                  "productStoreId",
                  "systemMessageTypeId"
              ])
                  .limit(500)
                  .list()
          )
        : []
    const remoteById = Object.fromEntries(remotes.map(remote => [remote.systemMessageRemoteId, remote]))
    const messages = remotes.length
        ? Array.from(
              selecting(
                  find("moqui.service.message.SystemMessage")
                      .condition("systemMessageRemoteId", "in", Object.keys(remoteById))
                      .condition("initDate", ">=", new Date(from))
                      .condition("initDate", "<", new Date(thru)),
                  ["systemMessageRemoteId", "systemMessageTypeId", "statusId", "failCount", "processedDate", "isOutgoing"]
              )
                  .limit(messageLimit + 1)
                  .list()
          )
        : []
    const truncated = messages.length > messageLimit
    const groups = new Map()
    const groupOf = (remote, typeId) => {
        const key = remote.systemMessageRemoteId + "|" + (typeId || "")
        if (!groups.has(key))
            groups.set(key, {
                productStoreId: remote.productStoreId,
                storeName: storeNames[remote.productStoreId] || remote.productStoreId,
                systemMessageRemoteId: remote.systemMessageRemoteId,
                remoteText: remote.description || remote.systemMessageRemoteId,
                systemMessageTypeId: typeId || null,
                received: 0,
                processed: 0,
                errors: 0,
                retried: 0,
                lastSuccess: null
            })
        return groups.get(key)
    }
    for (const remote of remotes) if (remote.systemMessageTypeId) groupOf(remote, remote.systemMessageTypeId)
    for (const message of messages.slice(0, messageLimit)) {
        const group = groupOf(remoteById[message.systemMessageRemoteId], message.systemMessageTypeId)
        group.received++
        if (processedStatuses.includes(message.statusId)) {
            group.processed++
            const at = ms(message.processedDate)
            if (at != null && (group.lastSuccess == null || at > group.lastSuccess)) group.lastSuccess = at
        }
        if (failedStatuses.includes(message.statusId)) group.errors++
        if (Number(message.failCount || 0) > 0) group.retried++
    }
    const messageRows = Array.from(groups.values())
        .map(group =>
            Object.assign(group, {
                messageTypeText: group.systemMessageTypeId
                    ? one("moqui.service.message.SystemMessageType", {systemMessageTypeId: group.systemMessageTypeId})
                          ?.description || group.systemMessageTypeId
                    : "",
                lastSuccessText: group.lastSuccess == null ? "" : dateText(new Date(group.lastSuccess))
            })
        )
        .sort((a, b) => a.storeName.localeCompare(b.storeName) || a.remoteText.localeCompare(b.remoteText))
    const feeds = storeIds.length
        ? Array.from(
              find(FEED).condition("productStoreId", "in", storeIds).orderBy("feedName").limit(limits.feeds).list()
          ).filter(feed => current(feed))
        : []
    const feedRows = feeds.map(feed => {
        const view = feedView(feed, {storeName: storeNames[feed.productStoreId]})
        const failures = find(BUILD, {productStoreFeedId: feed.productStoreFeedId, buildStatusEnumId: "PsfbFailed"})
            .condition("startedDate", ">=", new Date(from))
            .condition("startedDate", "<", new Date(thru))
            .count()
        const active = feed.activeBuildId ? one(BUILD, {feedBuildId: feed.activeBuildId}) : null
        const blocked = active ? !servable(active).ok : false
        return {
            productStoreFeedId: feed.productStoreFeedId,
            feedName: feed.feedName,
            productStoreId: feed.productStoreId,
            storeName: view.storeName,
            formatText: view.formatText,
            stateText: blocked ? "Blocked: a product was withdrawn after the active build" : view.stateText,
            blocked,
            lastCompleteText: view.lastCompleteBuild?.completedDateText || "",
            skipped: view.lastCompleteBuild ? view.lastCompleteBuild.skipCount : null,
            rows: view.lastCompleteBuild ? view.lastCompleteBuild.rowCount : null,
            latestFailed: !!view.latestBuild && !view.latestBuild.complete,
            latestFailureText: view.latestBuild && !view.latestBuild.complete ? view.latestBuild.failureText : null,
            failures: Number(failures)
        }
    })
    const messageErrors = messageRows.reduce((sum, row) => sum + row.errors, 0)
    const failingFeeds = feedRows.filter(row => row.latestFailed || row.blocked).length
    return {
        fromDate: new Date(from),
        thruDate: new Date(thru),
        messages: messageRows,
        feeds: feedRows,
        truncated,
        totals: {
            received: messageRows.reduce((sum, row) => sum + row.received, 0),
            messageErrors,
            feedFailures: feedRows.reduce((sum, row) => sum + row.failures, 0),
            failingFeeds,
            attention: messageErrors + failingFeeds
        }
    }
}

const operations = {
    findStoreFeeds,
    getStoreFeed,
    storeStoreFeed,
    buildStoreFeed,
    runStoreFeedBuild,
    getFeedBuild,
    publishStoreFeed,
    runStoreFeeds,
    getShopFeed,
    getChannelHealth
}
;({
    formats,
    destinations,
    servable,
    execute: (op, parameters) => {
        if (!operations[op]) throw new Error("Unknown store feed operation " + op)
        return operations[op](parameters || {})
    }
})
