// A site's pages and navigation (impl-commerce P4, X14; design-commerce §5 Pages, PageDetail and Navigation; design-shop
// §11): Commerce's part of mantle.public.ThemeServices beside Shop P2's themes (Themes.js), and the live reads of
// SiteServices' get#SitePage (a page by its mount, route and locale, or a policy role), get#SiteNavigation and
// resolve#SiteRedirect.
//
// A page is a PublicSitePage binding an exact WikiPage version to a site's Shop mount, route and locale, public in its
// window. Its body is a page of the store's page space, a wiki space with restrictUpdate (F52) that only this module
// writes: store#SitePage saves a version after its own permission and store checks, giving the user the space's update
// right for that one write (withSpaceUpdate), so a Commons Knowledge user cannot change or wiki-publish the page. Publishing
// a version makes it the page's published wiki version and the binding's in one transaction, so the exact-version rule
// (the binding's version is the page's published one) holds at every read; a scheduled publication does both at its from
// date, when the publication job revalidates it as its author. The Forum's guidelines and about pages keep Forum.js's
// role binding, owner and operator checks (Shop F12); this module never edits them.
//
// A menu is a PublicSiteNavigation of a site's mount by key and locale: its draft items (typed destinations: a product, a
// category, a page, an app of the site, a path on the site, an https address elsewhere) and its published versions, dated
// snapshots. A redirect sends an old path of the site to a typed destination. Every destination is validated when saved
// and again when published: no private BOSS link, no other scheme, no reserved path, no loop, and nothing that is not
// public (a draft product or page). Live reads intersect current publication again.
//
// Staff services check COMMERCE_VIEW to read, COMMERCE_THEME_EDIT to edit a page, COMMERCE_MERCHANDISE to edit menus and
// redirects and COMMERCE_PUBLISH to publish either, and the store's scope through StoreAdmin.js: a site is worked through
// its Shop mount's store. Every publish, withdrawal and scheduled change advances the site's generation in its
// transaction. Refusals start with their reason code.
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const stores = ec.resource.script("component://mr-mantle/service/mantle/product/StoreAdmin.js")
const publicApps = ec.resource.script("component://mr-mantle/service/mantle/public/PublicApps.js")
const merchandising = () => ec.resource.script("component://mr-mantle/service/mantle/product/StoreMerchandising.js")
const {find, one, rows, call, access} = lib
const P = "mantle.public."
const PAGE = P + "PublicSitePage"
const SITE = P + "PublicSite"
const SITE_APP = P + "PublicSiteApp"
const NAV = P + "PublicSiteNavigation"
const NAV_VERSION = P + "PublicSiteNavigationVersion"
const REDIRECT = P + "PublicSiteRedirect"
const SPACE = "moqui.resource.wiki.WikiSpace"
const SPACE_USER = "moqui.resource.wiki.WikiSpaceUser"
const WIKI_PAGE = "moqui.resource.wiki.WikiPage"
const STORE_SPACE = "mantle.product.store.ProductStoreWikiSpace"
const WIKI = "org.moqui.impl.WikiServices."

// ===== tables =====
// The Forum's page roles, bound by Forum.js alone; Commerce's policy roles (design-commerce §5 PageDetail), version
// pinned, at most one page of each on a site.
const forumRoles = ["guidelines", "about"]
const policyRoles = {delivery: "Delivery", returns: "Returns", privacy: "Privacy", terms: "Terms"}
// The typed destinations of a menu item or redirect (SiteDestinationType).
const destinationTypes = {
    SdtProduct: "Product",
    SdtCategory: "Category",
    SdtPage: "Page",
    SdtMount: "App of the site",
    SdtPath: "Path on the site",
    SdtExternal: "Other website (https)"
}
// A menu's bounds, and the hops followed looking for a redirect loop.
const menuLimits = {items: 200, depth: 3, label: 80}
const loopHops = 20
// What a redirect or a path destination may not start with: the reserved first segments of PublicApps.js and the API.
const reservedRoots = publicApps.reservedPaths.concat(["api"]).map(segment => segment.toLowerCase())
// Paths of BOSS's private screens and services, refused in any destination on any host.
const privatePath = /^\/(?:apps|qapps|vapps|rest|rpc)(?:\/|$)/i
const routePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)*$/
const localePattern = /^[a-z]{2,3}(?:_[A-Za-z0-9]{2,8})*$/
const templatePattern = /^[a-z0-9][a-z0-9_.-]{0,59}$/
const menuKeyPattern = /^[a-z][a-z0-9_-]{0,39}$/
const sitePathPattern = /^\/(?:[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*)?\/?$/
// A from date this far in the past is "now" (a form posted a moment ago); further back is refused.
const pastSlackMs = 60 * 1000

// ===== values =====
const text = value => (value == null ? "" : String(value).trim())
const ms = lib.ms
const nowMs = () => ms(ec.user.nowTimestamp)
const given = (p, name) => p[name] !== undefined && p[name] !== null
function refuse(code, message, kind) {
    const error = new Error(code + ": " + message)
    error.reason = code
    if (kind) error.moquiErrorKind = kind
    throw error
}
function asSystem(action) {
    const was = ec.artifactExecution.disableAuthz()
    try {
        return action()
    } finally {
        if (!was) ec.artifactExecution.enableAuthz()
    }
}
const users = {}
function userText(userId) {
    if (!userId) return ""
    if (!(userId in users)) {
        const account = one("moqui.security.UserAccount", {userId})
        users[userId] = account ? account.userFullName || account.username || userId : userId
    }
    return users[userId]
}
const slug = name =>
    String(name || "item")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 60) || "item"
const shortVersion = name => (name == null ? "" : String(name).length > 12 ? String(name).slice(0, 10) : String(name))
// A from date for a publication: now when empty, refused when more than a minute past.
function fromDateOf(value) {
    const now = nowMs()
    const at = stores.dateOf(value, now, "start date")
    if (at < now - pastSlackMs) refuse("VALUE_INVALID", "A publication starts now or later, not in the past")
    return Math.max(at, now)
}
function thruDateOf(value, fromDate) {
    const at = stores.dateOf(value, null, "end date")
    if (at != null && at <= fromDate) refuse("VALUE_INVALID", "The end comes after the start")
    return at
}
function textOf(value, max, label) {
    const out = text(value)
    if (out.length > max) refuse("VALUE_INVALID", label + " has at most " + max + " characters")
    return out || null
}
function routeOf(value) {
    const route = text(value).replace(/^\/+|\/+$/g, "")
    if (!route || route.length > 120 || !routePattern.test(route))
        refuse(
            "VALUE_INVALID",
            "A route is lower-case words of letters and digits joined by hyphens, in parts joined by / (returns, help/shipping)"
        )
    return route
}
function localeOf(value) {
    const locale = text(value)
    if (!locale) return null
    if (!localePattern.test(locale)) refuse("VALUE_INVALID", "Choose a locale such as en or en_US")
    return locale
}
function templateOf(value) {
    const key = text(value)
    if (!key) return null
    if (!templatePattern.test(key)) refuse("VALUE_INVALID", "A template key has lower-case letters, digits, . _ and -")
    return key
}
function roleOf(value) {
    const role = text(value)
    if (!role) return null
    if (forumRoles.includes(role)) refuse("ROLE_RESERVED", "The " + role + " page is the Forum's")
    if (!Object.hasOwn(policyRoles, role)) refuse("VALUE_INVALID", "Choose a policy role: delivery, returns, privacy or terms")
    return role
}
// A social image: an https address or a path of the site, nothing that leaves its attribute.
function imageUrlOf(value) {
    const url = text(value)
    if (!url) return null
    if (url.length > 255 || /[\s"'<>\\]/.test(url)) refuse("VALUE_INVALID", "Choose an https address or a path of the site")
    if (url.startsWith("/") && !url.startsWith("//")) return url
    if (/^https:\/\/[A-Za-z0-9.-]+(?::\d+)?(?:\/|$)/.test(url)) return url
    refuse("SCHEME_REFUSED", "A social image is an https address or a path of the site")
}

// ===== scope =====
// The user's scope with one of the permissions (and COMMERCE_VIEW, StoreAdmin's scope).
function scopeWith(permissions) {
    const s = stores.scope()
    if (permissions.length && !permissions.some(permission => access.has(permission)))
        refuse("PERMISSION_DENIED", permissions.join(" or ") + " is required")
    return s
}
// A site worked through its Shop mount's store in the user's scope: {site, mount, store}. A site with no Shop mount, or one
// whose store the user does not work, is not available.
function siteOf(s, siteId, forUpdate = false) {
    const site = siteId ? find(SITE, {siteId}).forUpdate(forUpdate).one() : null
    const mount = site ? rows(SITE_APP, {siteId, app: "shop"})[0] : null
    if (!mount || !mount.targetId) refuse("RECORD_UNAVAILABLE", "Site " + (siteId || "") + " is not available")
    try {
        return {site, mount, store: stores.storeOf(s, mount.targetId)}
    } catch (error) {
        refuse("RECORD_UNAVAILABLE", "Site " + siteId + " is not available")
    }
}
// The sites of the user's stores: the sites whose Shop mount targets a store in scope.
function scopeSiteIds(s) {
    const storeIds = Array.from(stores.storeQuery(s).selectField("productStoreId").list()).map(row => row.productStoreId)
    if (!storeIds.length) return []
    return Array.from(
        new Set(
            Array.from(find(SITE_APP).condition("app", "shop").condition("targetId", "in", storeIds).list()).map(
                row => row.siteId
            )
        )
    )
}
// A page of Commerce's (one with a mount; the Forum's role pages are Forum.js's), in the user's scope.
function pageOf(s, sitePageId, forUpdate = false) {
    const page = sitePageId ? find(PAGE, {sitePageId}).forUpdate(forUpdate).one() : null
    if (!page || !page.appMountId) refuse("RECORD_UNAVAILABLE", "Page " + (sitePageId || "") + " is not available")
    try {
        return Object.assign({page}, siteOf(s, page.siteId))
    } catch (error) {
        refuse("RECORD_UNAVAILABLE", "Page " + sitePageId + " is not available")
    }
}
// Advance a site's generation in the caller's transaction; the new generation.
function advance(siteId) {
    const site = find(SITE, {siteId}).forUpdate(true).one()
    const generation = Number(site?.generation || 0) + 1
    call("update#" + SITE, {siteId, generation})
    return generation
}
const mountBase = mount => (mount.pathPrefix === "/" ? "" : mount.pathPrefix || "")

// ===== the store's page space (F52) =====
// The store's page space: its current full-page content space (ProductStoreWikiSpace PstFull, no locale), made with
// restrictUpdate when it has none and create is set. A space without restrictUpdate is refused: anyone could change or
// wiki-publish its pages outside Commerce.
function pageSpaceOf(store, create) {
    const binding = rows(STORE_SPACE, {productStoreId: store.productStoreId, spaceTypeEnumId: "PstFull"})
        .filter(row => !row.locale && lib.active(row))
        .sort((a, b) => (ms(b.fromDate) || 0) - (ms(a.fromDate) || 0))[0]
    if (binding) {
        const space = one(SPACE, {wikiSpaceId: binding.wikiSpaceId})
        if (!space) refuse("SPACE_UNAVAILABLE", "The store's page space " + binding.wikiSpaceId + " is missing")
        if (space.restrictUpdate !== "Y")
            refuse(
                "SPACE_NOT_RESTRICTED",
                "The store's page space " + space.wikiSpaceId + " lets anyone change its pages; restrict its updates first"
            )
        return space
    }
    if (!create) return null
    const wikiSpaceId = "SP" + ec.entity.sequencedIdPrimary(SPACE, null, null)
    asSystem(() =>
        call(WIKI + "create#WikiSpace", {
            wikiSpaceId,
            description: "Pages of " + (store.storeName || store.productStoreId),
            restrictView: "N",
            restrictUpdate: "Y",
            allowAnyHtml: "N",
            wikiType: "md",
            addCreator: false
        })
    )
    call("create#" + STORE_SPACE, {
        productStoreId: store.productStoreId,
        spaceTypeEnumId: "PstFull",
        wikiSpaceId,
        fromDate: nowMs()
    })
    return one(SPACE, {wikiSpaceId})
}
// The user's update right on a page space for one wiki write: a WikiSpaceUser allowUpdate row for the call, put back as
// it was after it, all in the caller's transaction. The row is never committed (the transaction ends with it removed, or
// rolls back), so no other request of the user, as in Commons Knowledge, sees the right; WikiPageAccess reads the row
// without the entity cache.
function withSpaceUpdate(wikiSpaceId, action) {
    const userId = ec.user.userId
    if (!userId) refuse("PERMISSION_DENIED", "A signed-in user writes a page")
    const row = one(SPACE_USER, {wikiSpaceId, userId})
    const had = row?.allowUpdate === "Y"
    if (!had) {
        if (row) call("update#" + SPACE_USER, {wikiSpaceId, userId, allowUpdate: "Y"})
        else
            call("create#" + SPACE_USER, {
                wikiSpaceId,
                userId,
                allowView: "Y",
                allowUpdate: "Y",
                allowAdmin: "N",
                receiveNotifications: "N"
            })
    }
    try {
        return action()
    } finally {
        if (!had) {
            if (row) call("update#" + SPACE_USER, {wikiSpaceId, userId, allowUpdate: row.allowUpdate ?? null})
            else call("delete#" + SPACE_USER, {wikiSpaceId, userId})
        }
    }
}
// The wiki page of a binding, with its current version name.
function wikiOf(page) {
    const wiki = page.wikiPageId ? one(WIKI_PAGE, {wikiPageId: page.wikiPageId}) : null
    if (!wiki) refuse("PAGE_TEXT_MISSING", "The page's text is missing")
    return wiki
}
function pageReference(wiki) {
    return asSystem(() => call(WIKI + "get#WikiPageReference", {wikiPageId: wiki.wikiPageId}).pageReference)
}
// The full name of a version of the page, or VERSION_UNKNOWN.
function versionOf(wiki, versionName) {
    const name = text(versionName)
    if (!name) refuse("VERSION_REQUIRED", "Choose the version to publish")
    const ref = pageReference(wiki)
    let version = null
    try {
        version = ref && ref.exists && ref.supportsVersion() ? ref.getVersion(name) : null
    } catch (error) {
        version = null
    }
    if (!version) refuse("VERSION_UNKNOWN", "The page has no version " + name)
    return String(version.versionName)
}
function currentVersionOf(wiki) {
    const ref = pageReference(wiki)
    try {
        return ref && ref.exists && ref.supportsVersion() ? (ref.getCurrentVersion()?.versionName ?? null) : null
    } catch (error) {
        return null
    }
}

// ===== page states =====
const liveAt = (page, at) => !!page.versionName && (ms(page.fromDate) ?? -Infinity) <= at && (ms(page.thruDate) ?? Infinity) > at
function stateOf(page, at = nowMs()) {
    if (liveAt(page, at)) return "published"
    if (page.versionName && ms(page.thruDate) != null && ms(page.thruDate) <= at) return "withdrawn"
    return "draft"
}
const stateText = {published: "Published", withdrawn: "Withdrawn", draft: "Draft"}
const stateColor = {published: "positive", withdrawn: "grey", draft: "info"}
function routeTaken(page, siteId, appMountId, routePath, locale) {
    const now = nowMs()
    return rows(PAGE, {siteId, appMountId, routePath}).some(
        other =>
            other.sitePageId !== page?.sitePageId &&
            (other.locale || null) === (locale || null) &&
            !(other.versionName && ms(other.thruDate) != null && ms(other.thruDate) <= now)
    )
}
// The menus whose active version links to a page.
function menuReferences(siteId, sitePageId) {
    const out = []
    for (const menu of rows(NAV, {siteId})) {
        const version = activeVersion(menu.navigationId, nowMs())
        if (!version) continue
        const items = lib.json(version.snapshotText, [])
        if (items.some(item => item.destinationTypeEnumId === "SdtPage" && item.destinationValue === sitePageId))
            out.push({navigationId: menu.navigationId, menuKey: menu.menuKey, name: menu.name || menu.menuKey})
    }
    return out
}
function pageRow(page, site, mount, can) {
    const at = nowMs()
    const state = stateOf(page, at)
    const url = page.routePath ? publicApps.pageUrl(page.siteId, "shop", "/pages/" + page.routePath) : null
    return {
        sitePageId: page.sitePageId,
        siteId: page.siteId,
        siteName: site?.name || page.siteId,
        appMountId: page.appMountId,
        routePath: page.routePath,
        routeText: mountBase(mount || {}) + "/pages/" + (page.routePath || ""),
        locale: page.locale,
        title: page.title || page.routePath || page.sitePageId,
        pageRole: page.pageRole,
        roleText: page.pageRole ? policyRoles[page.pageRole] || page.pageRole : "",
        templateKey: page.templateKey,
        seoTitle: page.seoTitle,
        seoDescription: page.seoDescription,
        socialImageUrl: page.socialImageUrl,
        wikiPageId: page.wikiPageId,
        versionName: page.versionName,
        versionShort: shortVersion(page.versionName),
        publicationRevision: Number(page.publicationRevision || 0),
        fromDateText: lib.dateText(page.fromDate),
        thruDateText: lib.dateText(page.thruDate),
        state,
        stateText: stateText[state],
        stateColor: page.failureCode ? "negative" : stateColor[state],
        scheduled: page.scheduledFromDate
            ? {
                  versionName: page.scheduledVersionName,
                  versionShort: shortVersion(page.scheduledVersionName),
                  fromDateText: lib.dateText(page.scheduledFromDate),
                  thruDateText: lib.dateText(page.scheduledThruDate),
                  userText: userText(page.scheduledByUserId)
              }
            : null,
        scheduledText: page.scheduledFromDate
            ? "Version " + shortVersion(page.scheduledVersionName) + " from " + lib.dateText(page.scheduledFromDate)
            : "",
        failure: page.failureCode
            ? {code: page.failureCode, message: page.failureMessage, dateText: lib.dateText(page.failureDate)}
            : null,
        failureText: page.failureCode ? page.failureMessage || page.failureCode : "",
        publishedText: page.publishedByUserId ? userText(page.publishedByUserId) + ", " + lib.dateText(page.publishedDate) : "",
        publicUrl: url,
        lastUpdatedStamp: page.lastUpdatedStamp,
        canEdit: !!can?.edit,
        canPublish: !!can?.publish
    }
}

// ===== find#SitePages, get#SitePageHistory =====
// find#SitePages: Commerce's pages of the sites of the user's stores (one site, or every one), by title or route ignoring
// case, locale, role and state, a page at a time; with sitePageId, that page alone. COMMERCE_VIEW.
function findSitePages(p) {
    const s = scopeWith([])
    const can = {edit: access.has("COMMERCE_THEME_EDIT"), publish: access.has("COMMERCE_PUBLISH")}
    if (p.sitePageId) {
        const {page, site, mount} = pageOf(s, p.sitePageId)
        const row = pageRow(page, site, mount, can)
        row.menuReferences = menuReferences(page.siteId, page.sitePageId)
        row.wikiSpaceId = one(WIKI_PAGE, {wikiPageId: page.wikiPageId})?.wikiSpaceId || null
        return {pages: [row], pagesCount: 1}
    }
    const siteIds = p.siteId ? [siteOf(s, p.siteId).site.siteId] : scopeSiteIds(s)
    if (!siteIds.length) return lib.pageList([], p, "pages")
    const factory = ec.entity.conditionFactory
    const now = ec.user.nowTimestamp
    const build = () => {
        let query = find(PAGE).condition("siteId", "in", siteIds).condition("appMountId", "is-not-null", null)
        const term = text(p.term)
        if (term) {
            const like = "%" + term.replace(/[\\%_]/g, c => "\\" + c) + "%"
            query = query.condition(
                factory.makeCondition(
                    [
                        factory.makeCondition("title", "like", like).ignoreCase(),
                        factory.makeCondition("routePath", "like", like).ignoreCase()
                    ],
                    "or"
                )
            )
        }
        if (p.locale) query = query.condition("locale", p.locale)
        if (p.pageRole) query = query.condition("pageRole", p.pageRole)
        const state = text(p.state)
        if (state === "draft") query = query.condition("versionName", "is-null", null)
        else if (state === "published")
            query = query
                .condition("versionName", "is-not-null", null)
                .condition(
                    factory.makeCondition(
                        [
                            factory.makeCondition("fromDate", "is-null", null),
                            factory.makeCondition("fromDate", "less-equals", now)
                        ],
                        "or"
                    )
                )
                .condition(
                    factory.makeCondition(
                        [factory.makeCondition("thruDate", "is-null", null), factory.makeCondition("thruDate", "greater", now)],
                        "or"
                    )
                )
        else if (state === "withdrawn")
            query = query.condition("versionName", "is-not-null", null).condition("thruDate", "less-equals", now)
        else if (state === "scheduled") query = query.condition("scheduledFromDate", "is-not-null", null)
        else if (state === "failed") query = query.condition("failureCode", "is-not-null", null)
        return query
    }
    const count = build().count()
    const found = lib.page(build().orderBy("siteId").orderBy("routePath").orderBy("locale"), p, "pageRows", count)
    const sites = {}
    const mounts = {}
    const pages = found.rows.map(page => {
        if (!(page.siteId in sites)) {
            sites[page.siteId] = one(SITE, {siteId: page.siteId})
            mounts[page.siteId] = rows(SITE_APP, {siteId: page.siteId, app: "shop"})[0] || {}
        }
        return pageRow(page, sites[page.siteId], mounts[page.siteId], can)
    })
    return Object.assign(lib.pageList(pages, {pageSize: found.pageSize}, "pages"), {
        pagesCount: count,
        pagesPageIndex: found.pageIndex,
        pagesPageSize: found.pageSize,
        pagesPageMaxIndex: found.pageMaxIndex,
        pagesPageRangeLow: found.pageRangeLow,
        pagesPageRangeHigh: found.pageRangeHigh
    })
}
// get#SitePageHistory: the page's saved versions (newest first, which one is published and which scheduled) and its
// binding's publication activity from the audit log (who changed the route, version or window, when, and why).
function getSitePageHistory(p) {
    const s = scopeWith([])
    const {page} = pageOf(s, p.sitePageId)
    const wiki = wikiOf(page)
    const history = asSystem(() => call(WIKI + "get#WikiPageHistory", {wikiPageId: wiki.wikiPageId}))
    const versions = Array.from(history.versionList || [])
        .slice(0, 100)
        .map(version => ({
            versionName: version.versionName,
            versionShort: shortVersion(version.versionName),
            note: version.versionNote || version.note || version.message || "",
            userText: userText(version.userId) || version.userName || version.author || "",
            dateText: lib.dateText(version.versionDate || version.changeDateTime || version.date),
            isPublished: !!page.versionName && version.versionName === page.versionName,
            isScheduled: !!page.scheduledVersionName && version.versionName === page.scheduledVersionName
        }))
    const activity = Array.from(
        find("moqui.entity.EntityAuditLog")
            .condition("changedEntityName", PAGE)
            .condition("pkPrimaryValue", page.sitePageId)
            .orderBy("-changedDate")
            .limit(100)
            .list()
    ).map(row => ({
        auditHistorySeqId: row.auditHistorySeqId,
        changedDateText: lib.dateText(row.changedDate),
        fieldText: row.changedFieldName,
        oldValueText: row.oldValueText || "",
        newValueText: row.newValueText || "",
        userText: userText(row.changedByUserId),
        changeReason: row.changeReason || ""
    }))
    return {versions, activity, currentVersionName: currentVersionOf(wiki), publishedVersionName: page.versionName || null}
}

// ===== store#SitePage =====
// store#SitePage: a new page (siteId, title, route, locale, template, policy role, SEO; its text a new page of the store's
// page space), a page's binding fields (on a published or scheduled page a publication: COMMERCE_PUBLISH and
// expectedRevision, the publicationRevision advanced, and on a published one the site's generation), or a
// new version of its text (pageText, versionNote; with baseVersionName a page saved since by someone else is answered
// conflict, not overwritten). Saving text never changes the live page: publish#SitePage does. COMMERCE_THEME_EDIT.
function storeSitePage(p) {
    const s = scopeWith(["COMMERCE_THEME_EDIT"])
    if (!p.sitePageId) return createSitePage(s, p)
    const {page, site, mount, store} = pageOf(s, p.sitePageId, true)
    stale(p, page)
    const values = {}
    if (given(p, "title")) {
        values.title = textOf(p.title, 255, "A title")
        if (!values.title) refuse("VALUE_INVALID", "A page has a title")
    }
    if (given(p, "routePath")) values.routePath = routeOf(p.routePath)
    if (given(p, "locale")) values.locale = localeOf(p.locale)
    if (given(p, "templateKey")) values.templateKey = templateOf(p.templateKey)
    if (given(p, "pageRole")) values.pageRole = roleOf(p.pageRole)
    if (given(p, "seoTitle")) values.seoTitle = textOf(p.seoTitle, 255, "An SEO title")
    if (given(p, "seoDescription")) values.seoDescription = textOf(p.seoDescription, 500, "An SEO description")
    if (given(p, "socialImageUrl")) values.socialImageUrl = imageUrlOf(p.socialImageUrl)
    const changed = Object.keys(values).filter(key => (values[key] ?? null) !== (page[key] ?? null))
    let generation = null
    if (changed.length) {
        const next = Object.assign({}, page.getMap ? page.getMap() : page, values)
        if (routeTaken(page, page.siteId, page.appMountId, next.routePath, next.locale))
            refuse(
                "ROUTE_TAKEN",
                "Another page of the site has the route " + next.routePath + (next.locale ? " in " + next.locale : "")
            )
        if (next.pageRole && next.pageRole !== page.pageRole && rows(PAGE, {siteId: page.siteId, pageRole: next.pageRole}).length)
            refuse("ROLE_TAKEN", "The site has a " + policyRoles[next.pageRole] + " page already")
        // A live or scheduled page's binding is what the site shows (or will at its date): changing it is a publication
        // (design §1.1), so it takes COMMERCE_PUBLISH and the page's publicationRevision as read, and advances it.
        const live = stateOf(page) === "published"
        const update = {sitePageId: page.sitePageId, changeReason: stores.reason(p, false)}
        if (live || page.scheduledFromDate) {
            if (!access.has("COMMERCE_PUBLISH"))
                refuse(
                    "PERMISSION_DENIED",
                    "The page is " +
                        (live ? "published" : "scheduled") +
                        ": changing its " +
                        changed.join(", ") +
                        " needs COMMERCE_PUBLISH"
                )
            if (
                p.expectedRevision == null ||
                p.expectedRevision === "" ||
                Number(p.expectedRevision) !== Number(page.publicationRevision || 0)
            )
                refuse(
                    "REVISION_STALE",
                    "The page's publication changed; its revision is now " + Number(page.publicationRevision || 0)
                )
            update.publicationRevision = Number(page.publicationRevision || 0) + 1
        }
        call("update#" + PAGE, Object.assign(update, values))
        if (live) generation = advance(page.siteId)
    }
    let saved = null
    if (given(p, "pageText")) saved = savePageText(page, store, p)
    const after = one(PAGE, {sitePageId: page.sitePageId})
    return Object.assign(
        {sitePageId: page.sitePageId, changed, generation, page: pageRow(after, site, mount, {edit: true})},
        saved || {}
    )
}
function stale(p, row) {
    if (p.expectedLastUpdatedStamp && ms(p.expectedLastUpdatedStamp) !== ms(row.lastUpdatedStamp))
        refuse("REVISION_STALE", "Changed by someone else since it was read; reload")
}
function createSitePage(s, p) {
    const {site, mount, store} = siteOf(s, p.siteId)
    if (p.appMountId && p.appMountId !== mount.appMountId) refuse("VALUE_INVALID", "A store page is on the site's Shop")
    const title = textOf(p.title, 255, "A title")
    if (!title) refuse("VALUE_INVALID", "A page has a title")
    const routePath = routeOf(p.routePath)
    const locale = localeOf(p.locale)
    const pageRole = roleOf(p.pageRole)
    const values = {
        siteId: site.siteId,
        appMountId: mount.appMountId,
        routePath,
        locale,
        title,
        pageRole,
        templateKey: templateOf(p.templateKey),
        seoTitle: textOf(p.seoTitle, 255, "An SEO title"),
        seoDescription: textOf(p.seoDescription, 500, "An SEO description"),
        socialImageUrl: imageUrlOf(p.socialImageUrl)
    }
    if (routeTaken(null, site.siteId, mount.appMountId, routePath, locale))
        refuse("ROUTE_TAKEN", "Another page of the site has the route " + routePath + (locale ? " in " + locale : ""))
    if (pageRole && rows(PAGE, {siteId: site.siteId, pageRole}).length)
        refuse("ROLE_TAKEN", "The site has a " + policyRoles[pageRole] + " page already")
    const space = pageSpaceOf(store, true)
    const sitePageId = ec.entity.sequencedIdPrimary(PAGE, null, null)
    const pageText = p.pageText != null && String(p.pageText) !== "" ? String(p.pageText) : "# " + title + "\n"
    const written = withSpaceUpdate(space.wikiSpaceId, () =>
        call(WIKI + "update#WikiPage", {
            wikiSpaceId: space.wikiSpaceId,
            pageName: "page-" + sitePageId,
            wikiType: "md",
            pageText,
            versionNote: textOf(p.versionNote, 255, "A version note") || "New page"
        })
    )
    call(
        "create#" + PAGE,
        Object.assign(values, {
            sitePageId,
            wikiPageId: written.wikiPageId,
            publicationRevision: 0,
            createdByUserId: ec.user.userId,
            createdDate: nowMs(),
            changeReason: stores.reason(p, false)
        })
    )
    return {
        sitePageId,
        changed: Object.keys(values),
        versionName: written.versionName || null,
        page: pageRow(one(PAGE, {sitePageId}), site, mount, {edit: true})
    }
}
// A new version of a page's text, as the editing user.
function savePageText(page, store, p) {
    const wiki = wikiOf(page)
    const space = pageSpaceOf(store, false)
    if (!space || space.wikiSpaceId !== wiki.wikiSpaceId) refuse("SPACE_UNAVAILABLE", "The page is not in the store's page space")
    const current = currentVersionOf(wiki)
    if (p.baseVersionName && !(p.force === true || p.force === "true") && current && current !== p.baseVersionName) {
        const change = ec.resource.getLastChange(pageReference(wiki).location)
        return {
            conflict: true,
            currentVersionName: current,
            conflictText: (userText(change?.userId) || "Someone") + " saved this page since you opened it"
        }
    }
    const written = withSpaceUpdate(space.wikiSpaceId, () =>
        call(WIKI + "update#WikiPage", {
            wikiSpaceId: wiki.wikiSpaceId,
            wikiPageId: wiki.wikiPageId,
            pagePath: wiki.pagePath,
            pageName: wiki.pagePath.slice(wiki.pagePath.lastIndexOf("/") + 1),
            pageText: String(p.pageText ?? ""),
            versionNote: textOf(p.versionNote, 255, "A version note")
        })
    )
    return {conflict: false, versionName: written.versionName || null, currentVersionName: written.versionName || current}
}

// ===== publish#SitePage (Commerce's pages) =====
// publish#SitePage with a sitePageId: publish an exact version of the page from a date (now: the version becomes the
// page's published wiki version and the binding's in one transaction and the site's generation advances; later: it waits,
// scheduled, for the publication job), withdraw the live page (its menus named; with menus, confirmReferences), or cancel a
// scheduled publication. expectedRevision is the binding's publicationRevision; operationKey answers a retry with the
// first result. With previewOnly, what it would do and nothing written. COMMERCE_PUBLISH.
function publishSitePage(p) {
    const s = scopeWith(["COMMERCE_PUBLISH"])
    const {page, site, mount, store} = pageOf(s, p.sitePageId, true)
    const action = text(p.publishAction) || "publish"
    if (!["publish", "withdraw", "cancel"].includes(action)) refuse("VALUE_INVALID", "Choose publish, withdraw or cancel")
    const wiki = wikiOf(page)
    const references = menuReferences(page.siteId, page.sitePageId)
    const versionName = action === "publish" ? versionOf(wiki, p.versionName) : null
    const fromDate = action === "publish" ? fromDateOf(p.fromDate) : null
    const thruDate = action === "publish" ? thruDateOf(p.thruDate, fromDate) : null
    if (p.previewOnly === true || p.previewOnly === "true")
        return {
            sitePageId: page.sitePageId,
            publishAction: action,
            versionName,
            scheduled: fromDate != null && fromDate > nowMs(),
            menuReferences: references,
            publicUrl: page.routePath ? publicApps.pageUrl(page.siteId, "shop", "/pages/" + page.routePath) : null,
            generation: Number(site.generation || 0),
            nextGeneration: Number(site.generation || 0) + 1
        }
    const op = lib.operation(p, "SitePagePublish", store.organizationPartyId, {
        sitePageId: page.sitePageId,
        action,
        versionName,
        fromDate: text(p.fromDate),
        thruDate: text(p.thruDate)
    })
    const earlier = lib.previous(op)
    if (earlier) return earlier
    if (
        p.expectedRevision == null ||
        p.expectedRevision === "" ||
        Number(p.expectedRevision) !== Number(page.publicationRevision || 0)
    )
        refuse("REVISION_STALE", "The page's publication changed; its revision is now " + Number(page.publicationRevision || 0))
    const reason = stores.reason(p, false)
    const revision = Number(page.publicationRevision || 0) + 1
    let result
    if (action === "publish") {
        if (routeTaken(page, page.siteId, page.appMountId, page.routePath, page.locale))
            refuse("ROUTE_TAKEN", "Another page of the site has the route " + page.routePath)
        if (fromDate <= nowMs()) {
            const generation = activatePage(page, store, versionName, fromDate, thruDate, ec.user.userId, reason, revision)
            result = {state: "published", generation}
        } else {
            call("update#" + PAGE, {
                sitePageId: page.sitePageId,
                scheduledVersionName: versionName,
                scheduledFromDate: fromDate,
                scheduledThruDate: thruDate,
                scheduledByUserId: ec.user.userId,
                failureCode: null,
                failureMessage: null,
                failureDate: null,
                publicationRevision: revision,
                changeReason: reason
            })
            result = {state: "scheduled", generation: null}
        }
    } else if (action === "withdraw") {
        if (stateOf(page) !== "published") refuse("NOT_PUBLISHED", "The page is not published")
        if (references.length && !(p.confirmReferences === true || p.confirmReferences === "true"))
            refuse(
                "PAGE_REFERENCED",
                "Menus link to this page: " + references.map(ref => ref.name).join(", ") + "; confirm to withdraw it anyway"
            )
        call("update#" + PAGE, {
            sitePageId: page.sitePageId,
            thruDate: nowMs(),
            scheduledVersionName: null,
            scheduledFromDate: null,
            scheduledThruDate: null,
            scheduledByUserId: null,
            publicationRevision: revision,
            changeReason: reason
        })
        result = {state: "withdrawn", generation: advance(page.siteId)}
    } else {
        if (!page.scheduledFromDate) refuse("NOTHING_SCHEDULED", "No publication of the page is scheduled")
        call("update#" + PAGE, {
            sitePageId: page.sitePageId,
            scheduledVersionName: null,
            scheduledFromDate: null,
            scheduledThruDate: null,
            scheduledByUserId: null,
            failureCode: null,
            failureMessage: null,
            failureDate: null,
            publicationRevision: revision,
            changeReason: reason
        })
        result = {state: stateOf(page), generation: null}
    }
    const out = Object.assign(
        {sitePageId: page.sitePageId, publishAction: action, versionName, revision, menuReferences: references},
        result
    )
    lib.complete(op, PAGE, page.sitePageId, out)
    return out
}
// Make a version live: the page's published wiki version and the binding's, with the window; the site's generation.
function activatePage(page, store, versionName, fromDate, thruDate, userId, reason, revision) {
    const wiki = wikiOf(page)
    withSpaceUpdate(wiki.wikiSpaceId, () =>
        call(WIKI + "set#PublishedVersion", {wikiPageId: wiki.wikiPageId, publishedVersionName: versionName})
    )
    call("update#" + PAGE, {
        sitePageId: page.sitePageId,
        versionName,
        fromDate,
        thruDate,
        publishedByUserId: userId,
        publishedDate: nowMs(),
        scheduledVersionName: null,
        scheduledFromDate: null,
        scheduledThruDate: null,
        scheduledByUserId: null,
        failureCode: null,
        failureMessage: null,
        failureDate: null,
        publicationRevision: revision,
        changeReason: reason
    })
    return advance(page.siteId)
}

// ===== get#SitePage (the live read of Commerce's pages) =====
// A page of a published site as a visitor reads it: by sitePageId, by policy role, or by its mount, route and locale (the
// locale's page, else its language's, else the page with no locale); only in its window, and only when the page's published
// wiki version is the binding's exact version. Its body is the version's markdown as clean HTML. NotFound otherwise.
function getSitePage(p) {
    const missing = () => refuse("NOT_FOUND", "Page not found", "NotFound")
    const site = p.siteId ? one(SITE, {siteId: p.siteId}) : null
    if (!site || site.state !== "published") missing()
    const at = nowMs()
    let candidates
    if (p.sitePageId) candidates = rows(PAGE, {sitePageId: p.sitePageId}).filter(row => row.siteId === site.siteId)
    else if (p.pageRole)
        candidates = Object.hasOwn(policyRoles, p.pageRole) ? rows(PAGE, {siteId: site.siteId, pageRole: p.pageRole}) : []
    else if (p.appMountId && p.routePath) {
        const all = rows(PAGE, {
            siteId: site.siteId,
            appMountId: p.appMountId,
            routePath: text(p.routePath).replace(/^\/+|\/+$/g, "")
        })
        const locale = text(p.locale).replace(/-/g, "_")
        const language = locale.split("_")[0]
        candidates =
            [locale, language, null]
                .map(want => all.filter(row => (row.locale || null) === (want || null)))
                .find(list => list.some(row => liveAt(row, at))) || []
    } else candidates = []
    const page = candidates.find(row => row.appMountId && liveAt(row, at))
    if (!page) missing()
    const mount = one(SITE_APP, {siteId: site.siteId, appMountId: page.appMountId})
    if (!mount || mount.enabled !== "Y") missing()
    const wiki = one(WIKI_PAGE, {wikiPageId: page.wikiPageId})
    if (!wiki || wiki.publishedVersionName !== page.versionName) missing()
    const out = asSystem(() =>
        ec.service
            .sync()
            .name(WIKI + "get#PublishedWikiPageText")
            .parameters({wikiSpaceId: wiki.wikiSpaceId, pagePath: wiki.pagePath, versionName: null})
            .call()
    )
    if (ec.message.hasError()) {
        ec.message.clearErrors()
        missing()
    }
    if (!out || (out.versionName && out.versionName !== page.versionName)) missing()
    const body = StringUtilities.cleanHtml(ec.resource.markdownHtml(out.pageText || ""))
    return {
        page: {
            sitePageId: page.sitePageId,
            pageRole: page.pageRole || null,
            title: page.title || null,
            seoTitle: page.seoTitle || null,
            seoDescription: page.seoDescription || null,
            socialImageUrl: page.socialImageUrl || null,
            templateKey: page.templateKey || null,
            locale: page.locale || null,
            appMountId: page.appMountId,
            routePath: page.routePath,
            url: mountBase(mount) + "/pages/" + page.routePath,
            version: page.versionName,
            publicationRevision: Number(page.publicationRevision || 0),
            body
        },
        generation: Number(site.generation || 0)
    }
}

// ===== destinations =====
// The context destinations are checked in: the site, its Shop mount and store, and its enabled mounts.
function contextOf(site, mount, store) {
    return {site, mount, store, mounts: rows(SITE_APP, {siteId: site.siteId}).filter(row => row.enabled === "Y")}
}
// The mount a site path belongs to (the longest prefix of the site's enabled mounts), or null.
function mountOfPath(ctx, path) {
    let best = null
    for (const mount of ctx.mounts) {
        const prefix = mount.pathPrefix === "/" ? "" : mount.pathPrefix
        if (path === prefix || path.startsWith(prefix + "/") || prefix === "")
            if (!best || prefix.length > (best.pathPrefix === "/" ? 0 : best.pathPrefix.length)) best = mount
    }
    return best
}
// A site path: absolute, plain characters, no reserved first segment or private BOSS path.
function sitePathOf(value, label) {
    const path = text(value)
    if (!path.startsWith("/")) refuse("DESTINATION_INVALID", label + " is a path of the site starting with /")
    if (path.length > 255 || !sitePathPattern.test(path) || path.split("/").some(part => part === "." || part === ".."))
        refuse("DESTINATION_INVALID", label + " " + path + " is not a plain path")
    if (privatePath.test(path)) refuse("PRIVATE_LINK", label + " " + path + " is a private BOSS address")
    const first = (path.split("/")[1] || "").toLowerCase()
    if (first && reservedRoots.includes(first)) refuse("PATH_RESERVED", label + " " + path + " is a reserved path of the site")
    return path.length > 1 ? path.replace(/\/$/, "") : path
}
// Check a typed destination; answers {url, label} or refuses it. A product must be public in the store, a page published,
// a category in the store's categories, an app enabled on the site, an address https and not a private BOSS one.
function checkDestination(ctx, typeEnumId, rawValue, forRedirect = false) {
    const value = text(rawValue)
    if (!Object.hasOwn(destinationTypes, typeEnumId || "")) refuse("DESTINATION_INVALID", "Choose a kind of destination")
    if (!value && typeEnumId !== "SdtMount") refuse("DESTINATION_INVALID", "Choose the destination")
    const base = mountBase(ctx.mount)
    if (typeEnumId === "SdtProduct") {
        const answer = merchandising().resolve(ctx.store, [value], nowMs(), ctx.site.siteId)[0]
        if (!answer || !answer.isPublic)
            refuse(
                "DESTINATION_NOT_PUBLIC",
                "Product " + value + " is not public in " + (ctx.store.storeName || ctx.store.productStoreId)
            )
        return {url: base + "/products/" + value + "/" + slug(answer.productName), label: answer.productName}
    }
    if (typeEnumId === "SdtCategory") {
        // the store's tree now, read directly: live reads are anonymous, where get#StoreCategories (COMMERCE_VIEW) refuses
        const category = merchandising().storeTree(ctx.store.productStoreId, nowMs()).has(value)
            ? one("mantle.product.category.ProductCategory", {productCategoryId: value})
            : null
        if (!category) refuse("DESTINATION_NOT_PUBLIC", "Category " + value + " is not one of the store's categories")
        const name = category.categoryName || value
        return {url: base + "/categories/" + value + "/" + slug(name), label: name}
    }
    if (typeEnumId === "SdtPage") {
        const page = one(PAGE, {sitePageId: value})
        if (!page || page.siteId !== ctx.site.siteId || !page.appMountId)
            refuse("DESTINATION_INVALID", "Page " + value + " is not a page of the site")
        if (!liveAt(page, nowMs())) refuse("DESTINATION_NOT_PUBLIC", "Page " + (page.title || value) + " is not published")
        const pageMount = ctx.mounts.find(row => row.appMountId === page.appMountId)
        if (!pageMount) refuse("DESTINATION_NOT_PUBLIC", "Page " + (page.title || value) + " is on an app that is off")
        return {url: mountBase(pageMount) + "/pages/" + page.routePath, label: page.title || page.routePath}
    }
    if (typeEnumId === "SdtMount") {
        const mount = ctx.mounts.find(row => row.appMountId === (value || ctx.mount.appMountId))
        if (!mount) refuse("DESTINATION_INVALID", "App " + value + " is not on the site")
        return {url: mount.pathPrefix || "/", label: mount.app}
    }
    if (typeEnumId === "SdtPath") {
        const path = sitePathOf(value, "The path")
        if (!mountOfPath(ctx, path)) refuse("DESTINATION_INVALID", "The path " + path + " is not under an app of the site")
        return {url: path, label: path}
    }
    // SdtExternal: an https address of another website
    if (forRedirect) refuse("REDIRECT_OFF_SITE", "A redirect stays on the site; link other websites from a menu")
    if (!/^https:\/\//i.test(value)) refuse("SCHEME_REFUSED", "Only https addresses are linked")
    const match = /^https:\/\/([A-Za-z0-9.-]+)(?::(\d+))?(\/[^\s"'<>\\]*)?$/i.exec(value)
    if (!match || value.length > 500) refuse("DESTINATION_INVALID", "The address " + value + " is not a plain https address")
    const path = match[3] || "/"
    if (privatePath.test(path)) refuse("PRIVATE_LINK", "The address " + value + " is a private BOSS address")
    return {url: value, label: match[1]}
}
// The live url of a destination, or null when it is no longer public (live reads intersect current publication). A
// refusal's error messages stay in their own frame, so one item that is not public never fails the visitor's read.
function liveUrl(ctx, typeEnumId, value) {
    ec.message.pushErrors()
    try {
        return checkDestination(ctx, typeEnumId, value).url
    } catch (error) {
        return null
    } finally {
        ec.message.clearErrors()
        ec.message.popErrors()
    }
}

// ===== menus =====
const itemsOf = menu => lib.json(menu.draftText, []) || []
function depthOf(items, item) {
    let depth = 1
    let parent = item.parentItemId
    const seen = new Set()
    while (parent && !seen.has(parent)) {
        seen.add(parent)
        depth++
        parent = items.find(row => row.itemId === parent)?.parentItemId || null
    }
    return depth
}
const descendantsOf = (items, itemId) => {
    const out = new Set([itemId])
    let grew = true
    while (grew) {
        grew = false
        for (const item of items)
            if (item.parentItemId && out.has(item.parentItemId) && !out.has(item.itemId)) {
                out.add(item.itemId)
                grew = true
            }
    }
    return out
}
// Items in tree order (parents before their children, siblings in their order).
function treeOrder(items) {
    const out = []
    const walk = parentId => {
        for (const item of items.filter(row => (row.parentItemId || null) === parentId)) {
            out.push(item)
            walk(item.itemId)
        }
    }
    walk(null)
    return out
}
function menuOf(ctx, navigationId, forUpdate) {
    const menu = navigationId ? find(NAV, {navigationId}).forUpdate(forUpdate).one() : null
    if (!menu || menu.siteId !== ctx.site.siteId)
        refuse("RECORD_UNAVAILABLE", "Menu " + (navigationId || "") + " is not available")
    return menu
}
function activeVersion(navigationId, at) {
    return rows(NAV_VERSION, {navigationId, publicationStateEnumId: "SpsActive"})
        .filter(row => (ms(row.fromDate) ?? -Infinity) <= at && (ms(row.thruDate) ?? Infinity) > at)
        .sort((a, b) => ms(b.fromDate) - ms(a.fromDate))[0]
}
// One item from its input: label, destination (checked), parent and visibility.
function itemOf(ctx, items, input, existing) {
    const label = textOf(input.label, menuLimits.label, "A label")
    if (!label) refuse("VALUE_INVALID", "A menu item has a label")
    const typeEnumId = text(input.destinationTypeEnumId)
    const checked = checkDestination(ctx, typeEnumId, input.destinationValue)
    const parentItemId = text(input.parentItemId) || null
    if (parentItemId) {
        if (!items.some(row => row.itemId === parentItemId)) refuse("VALUE_INVALID", "Choose a parent item of this menu")
        if (existing && descendantsOf(items, existing.itemId).has(parentItemId))
            refuse("VALUE_INVALID", "An item cannot go under itself")
    }
    return {
        itemId: existing?.itemId,
        parentItemId,
        label,
        destinationTypeEnumId: typeEnumId,
        destinationValue: text(input.destinationValue) || null,
        visible: input.visible === false || input.visible === "N" ? "N" : "Y",
        checkedUrl: checked.url
    }
}
// Move an item: up or down among its siblings, in (under the sibling before it) or out (after its parent).
function moveItem(items, itemId, direction) {
    const item = items.find(row => row.itemId === itemId)
    if (!item) refuse("RECORD_UNAVAILABLE", "Item " + itemId + " is not in the menu")
    const siblings = items.filter(row => (row.parentItemId || null) === (item.parentItemId || null))
    const at = siblings.indexOf(item)
    const swap = (a, b) => {
        const i = items.indexOf(a),
            j = items.indexOf(b)
        items[i] = b
        items[j] = a
    }
    if (direction === "up") {
        if (at <= 0) refuse("VALUE_INVALID", "The item is first already")
        swap(item, siblings[at - 1])
    } else if (direction === "down") {
        if (at >= siblings.length - 1) refuse("VALUE_INVALID", "The item is last already")
        swap(item, siblings[at + 1])
    } else if (direction === "in") {
        if (at <= 0) refuse("VALUE_INVALID", "An item goes in under the item before it; there is none")
        const parent = siblings[at - 1]
        const moved = descendantsOf(items, item.itemId)
        const deepest = Math.max(...items.filter(row => moved.has(row.itemId)).map(row => depthOf(items, row)))
        if (deepest + 1 > menuLimits.depth) refuse("VALUE_INVALID", "A menu has at most " + menuLimits.depth + " levels")
        item.parentItemId = parent.itemId
        // last among its new siblings
        items.splice(items.indexOf(item), 1)
        items.push(item)
    } else if (direction === "out") {
        if (!item.parentItemId) refuse("VALUE_INVALID", "The item is at the top already")
        const parent = items.find(row => row.itemId === item.parentItemId)
        item.parentItemId = parent?.parentItemId || null
        items.splice(items.indexOf(item), 1)
        items.splice(items.indexOf(parent) + 1, 0, item)
    } else refuse("VALUE_INVALID", "Move up, down, in or out")
}
function itemRows(ctx, items, check) {
    return treeOrder(items).map(item => {
        let problem = null
        let url = null
        if (check)
            try {
                url = checkDestination(ctx, item.destinationTypeEnumId, item.destinationValue).url
            } catch (error) {
                problem = error.message
            }
        return {
            itemId: item.itemId,
            parentItemId: item.parentItemId,
            label: item.label,
            depth: depthOf(items, item),
            indentedLabel: " ".repeat(depthOf(items, item) - 1) + item.label,
            destinationTypeEnumId: item.destinationTypeEnumId,
            destinationTypeText: destinationTypes[item.destinationTypeEnumId] || "",
            destinationValue: item.destinationValue,
            visible: item.visible,
            url,
            problem
        }
    })
}
function versionRow(version) {
    if (!version) return null
    return {
        fromDate: ms(version.fromDate),
        fromDateText: lib.dateText(version.fromDate),
        thruDateText: lib.dateText(version.thruDate),
        draftRevision: Number(version.draftRevision || 0),
        state: version.publicationStateEnumId,
        userText: userText(version.publishedByUserId),
        changeReason: version.changeReason || "",
        failureText: version.failureCode ? version.failureMessage || version.failureCode : ""
    }
}
function menuRow(ctx, menu, check) {
    const at = nowMs()
    const items = itemsOf(menu)
    const versions = rows(NAV_VERSION, {navigationId: menu.navigationId}).sort((a, b) => ms(b.fromDate) - ms(a.fromDate))
    const active = activeVersion(menu.navigationId, at)
    const scheduled = versions.find(row => row.publicationStateEnumId === "SpsScheduled")
    const failed = versions.find(row => row.publicationStateEnumId === "SpsFailed")
    return {
        navigationId: menu.navigationId,
        siteId: menu.siteId,
        appMountId: menu.appMountId,
        menuKey: menu.menuKey,
        locale: menu.locale,
        name: menu.name || menu.menuKey,
        draftRevision: Number(menu.draftRevision || 0),
        items: itemRows(ctx, items, check),
        active: versionRow(active),
        scheduled: versionRow(scheduled),
        failed: versionRow(failed),
        unpublishedChanges: !active || Number(active.draftRevision || 0) !== Number(menu.draftRevision || 0),
        versions: versions.slice(0, 20).map(versionRow)
    }
}

// ===== redirects =====
function redirectOf(ctx, redirectId, forUpdate) {
    const redirect = redirectId ? find(REDIRECT, {redirectId}).forUpdate(forUpdate).one() : null
    if (!redirect || redirect.siteId !== ctx.site.siteId)
        refuse("RECORD_UNAVAILABLE", "Redirect " + (redirectId || "") + " is not available")
    return redirect
}
const liveRedirect = (row, at) =>
    row.publicationStateEnumId === "SpsActive" && (ms(row.fromDate) ?? -Infinity) <= at && (ms(row.thruDate) ?? Infinity) > at
// The path a destination leads to on the site, for following redirects (null off the site).
function targetPath(ctx, typeEnumId, value) {
    try {
        const url = checkDestination(ctx, typeEnumId, value, true).url
        return url.startsWith("/") ? url.replace(/\/$/, "") || "/" : null
    } catch (error) {
        return null
    }
}
// Check a redirect: its old path (under the site's Shop, not reserved, not another redirect's) and its destination (on the
// site, public), and no loop through the site's other redirects. Answers its target url.
function checkRedirect(ctx, redirect) {
    const oldPath = sitePathOf(redirect.oldPath, "The old path")
    if (oldPath === "/") refuse("PATH_RESERVED", "The site's home is not redirected")
    const owner = mountOfPath(ctx, oldPath)
    if (!owner || owner.appMountId !== ctx.mount.appMountId)
        refuse("PATH_RESERVED", "The old path " + oldPath + " belongs to another app of the site")
    const others = rows(REDIRECT, {siteId: ctx.site.siteId}).filter(
        row =>
            row.redirectId !== redirect.redirectId &&
            !["SpsWithdrawn", "SpsSuperseded"].includes(row.publicationStateEnumId) &&
            !(ms(row.thruDate) != null && ms(row.thruDate) <= nowMs())
    )
    if (others.some(row => row.oldPath === oldPath))
        refuse("REDIRECT_TAKEN", "The old path " + oldPath + " is redirected already")
    const checked = checkDestination(ctx, redirect.destinationTypeEnumId, redirect.destinationValue, true)
    const target = checked.url.replace(/\/$/, "") || "/"
    if (target === oldPath) refuse("REDIRECT_LOOP", "The redirect leads back to " + oldPath)
    const next = new Map(others.map(row => [row.oldPath, row]))
    let path = target
    for (let hop = 0; hop < loopHops && next.has(path); hop++) {
        const row = next.get(path)
        path = targetPath(ctx, row.destinationTypeEnumId, row.destinationValue)
        if (path === oldPath) refuse("REDIRECT_LOOP", "The redirect leads back to " + oldPath + " through " + row.oldPath)
        if (path == null) break
    }
    return {oldPath, url: checked.url}
}
function redirectRow(row) {
    const at = nowMs()
    return {
        redirectId: row.redirectId,
        oldPath: row.oldPath,
        destinationTypeEnumId: row.destinationTypeEnumId,
        destinationTypeText: destinationTypes[row.destinationTypeEnumId] || "",
        destinationValue: row.destinationValue,
        permanent: row.permanent,
        kindText: row.permanent === "N" ? "Temporary (302)" : "Permanent (301)",
        fromDateText: lib.dateText(row.fromDate),
        thruDateText: lib.dateText(row.thruDate),
        state: row.publicationStateEnumId,
        stateText: liveRedirect(row, at)
            ? "Active"
            : one("moqui.basic.Enumeration", {enumId: row.publicationStateEnumId})?.description || "Draft",
        revision: Number(row.revision || 0),
        failureText: row.failureCode ? row.failureMessage || row.failureCode : "",
        changeReason: row.changeReason || ""
    }
}

// ===== find#SiteNavigation, store#SiteNavigation =====
// find#SiteNavigation: a site's menus (their draft items, each destination checked now, and their active, scheduled and
// failed versions) and its redirects. COMMERCE_VIEW and the site's store.
function findSiteNavigation(p) {
    const s = scopeWith([])
    const siteId = p.siteId || scopeSiteIds(s).sort()[0] || null
    if (!siteId) return {siteId: null, menus: [], redirects: []}
    const {site, mount, store} = siteOf(s, siteId)
    const ctx = contextOf(site, mount, store)
    const menus = rows(NAV, {siteId})
        .sort(
            (a, b) =>
                String(a.menuKey).localeCompare(String(b.menuKey)) || String(a.locale || "").localeCompare(String(b.locale || ""))
        )
        .map(menu => menuRow(ctx, menu, true))
    const redirects = rows(REDIRECT, {siteId})
        .sort((a, b) => String(a.oldPath).localeCompare(String(b.oldPath)))
        .slice(0, 200)
        .map(redirectRow)
    return {
        siteId,
        siteName: site.name || siteId,
        appMountId: mount.appMountId,
        mountPath: mount.pathPrefix,
        menus,
        redirects,
        canEdit: access.has("COMMERCE_MERCHANDISE"),
        canPublish: access.has("COMMERCE_PUBLISH")
    }
}
// store#SiteNavigation: a menu's draft (a new menu by key and locale; its name; an item added or changed, removed or moved)
// or a redirect's draft (new or changed; a draft or failed one removed). Each destination is checked as it is saved (a draft
// product or page, another scheme, a private or reserved path, a loop refused); expectedRevision is the menu's
// draftRevision or the redirect's revision. Nothing is live until publish#SiteNavigation. COMMERCE_MERCHANDISE.
function storeSiteNavigation(p) {
    const s = scopeWith(["COMMERCE_MERCHANDISE"])
    const {site, mount, store} = siteOf(s, p.siteId)
    const ctx = contextOf(site, mount, store)
    if (p.redirect || p.removeRedirectId) return storeRedirect(ctx, p)
    let menu
    if (!p.navigationId) {
        const menuKey = text(p.menuKey)
        if (!menuKeyPattern.test(menuKey))
            refuse("VALUE_INVALID", "A menu key is lower-case letters, digits, - and _ (main, footer)")
        const locale = localeOf(p.locale)
        if (rows(NAV, {siteId: site.siteId, appMountId: mount.appMountId, menuKey}).some(row => (row.locale || null) === locale))
            refuse("MENU_TAKEN", "The site has a " + menuKey + " menu" + (locale ? " in " + locale : "") + " already")
        const navigationId = ec.entity.sequencedIdPrimary(NAV, null, null)
        call("create#" + NAV, {
            navigationId,
            siteId: site.siteId,
            appMountId: mount.appMountId,
            menuKey,
            locale,
            name: textOf(p.name, 255, "A name") || menuKey,
            draftText: "[]",
            draftRevision: 0,
            lastChangedByUserId: ec.user.userId
        })
        menu = one(NAV, {navigationId})
    } else {
        menu = menuOf(ctx, p.navigationId, true)
        if (
            p.expectedRevision == null ||
            p.expectedRevision === "" ||
            Number(p.expectedRevision) !== Number(menu.draftRevision || 0)
        )
            refuse("REVISION_STALE", "The menu changed; its revision is now " + Number(menu.draftRevision || 0))
        const items = itemsOf(menu)
        const values = {}
        if (given(p, "name")) values.name = textOf(p.name, 255, "A name") || menu.menuKey
        if (p.item) {
            const input = p.item
            const existing = input.itemId ? items.find(row => row.itemId === input.itemId) : null
            if (input.itemId && !existing) refuse("RECORD_UNAVAILABLE", "Item " + input.itemId + " is not in the menu")
            if (!existing && items.length >= menuLimits.items)
                refuse("VALUE_INVALID", "A menu has at most " + menuLimits.items + " items")
            const item = itemOf(ctx, items, input, existing)
            delete item.checkedUrl
            if (existing) {
                const parentChanged = (existing.parentItemId || null) !== item.parentItemId
                Object.assign(existing, item, {itemId: existing.itemId})
                if (parentChanged) {
                    items.splice(items.indexOf(existing), 1)
                    items.push(existing)
                }
            } else {
                item.itemId = "i" + (Math.max(0, ...items.map(row => Number(String(row.itemId).slice(1)) || 0)) + 1)
                items.push(item)
            }
            const placed = items.find(row => row.itemId === (existing?.itemId || item.itemId))
            const moved = descendantsOf(items, placed.itemId)
            if (items.filter(row => moved.has(row.itemId)).some(row => depthOf(items, row) > menuLimits.depth))
                refuse("VALUE_INVALID", "A menu has at most " + menuLimits.depth + " levels")
        }
        if (p.removeItemId) {
            const gone = descendantsOf(items, p.removeItemId)
            if (!items.some(row => row.itemId === p.removeItemId))
                refuse("RECORD_UNAVAILABLE", "Item " + p.removeItemId + " is not in the menu")
            for (let i = items.length - 1; i >= 0; i--) if (gone.has(items[i].itemId)) items.splice(i, 1)
        }
        if (p.moveItemId) moveItem(items, p.moveItemId, text(p.direction))
        values.draftText = JSON.stringify(treeOrder(items))
        values.draftRevision = Number(menu.draftRevision || 0) + 1
        values.lastChangedByUserId = ec.user.userId
        call("update#" + NAV, Object.assign({navigationId: menu.navigationId}, values))
        menu = one(NAV, {navigationId: menu.navigationId})
    }
    return {navigationId: menu.navigationId, draftRevision: Number(menu.draftRevision || 0), menu: menuRow(ctx, menu, false)}
}
function storeRedirect(ctx, p) {
    if (p.removeRedirectId) {
        const redirect = redirectOf(ctx, p.removeRedirectId, true)
        if (!["SpsDraft", "SpsFailed"].includes(redirect.publicationStateEnumId))
            refuse("REDIRECT_PUBLISHED", "A published redirect is withdrawn, not removed")
        call("delete#" + REDIRECT, {redirectId: redirect.redirectId})
        return {redirectId: redirect.redirectId, removed: true}
    }
    const input = p.redirect
    const existing = input.redirectId ? redirectOf(ctx, input.redirectId, true) : null
    if (existing) {
        if (!["SpsDraft", "SpsFailed"].includes(existing.publicationStateEnumId))
            refuse("REDIRECT_PUBLISHED", "A published redirect is withdrawn and saved again as a new one")
        if (input.expectedRevision == null || Number(input.expectedRevision) !== Number(existing.revision || 0))
            refuse("REVISION_STALE", "The redirect changed; its revision is now " + Number(existing.revision || 0))
    }
    const fromDate = input.fromDate != null && input.fromDate !== "" ? fromDateOf(input.fromDate) : null
    const values = {
        redirectId: existing?.redirectId,
        siteId: ctx.site.siteId,
        appMountId: ctx.mount.appMountId,
        oldPath: text(input.oldPath),
        destinationTypeEnumId: text(input.destinationTypeEnumId),
        destinationValue: text(input.destinationValue) || null,
        permanent: input.permanent === false || input.permanent === "N" ? "N" : "Y",
        fromDate,
        thruDate: thruDateOf(input.thruDate, fromDate ?? nowMs())
    }
    const checked = checkRedirect(ctx, values)
    values.oldPath = checked.oldPath
    Object.assign(values, {
        publicationStateEnumId: "SpsDraft",
        revision: Number(existing?.revision || 0) + 1,
        changeReason: stores.reason(input, false),
        failureCode: null,
        failureMessage: null
    })
    if (existing) call("update#" + REDIRECT, values)
    else {
        values.redirectId = ec.entity.sequencedIdPrimary(REDIRECT, null, null)
        call("create#" + REDIRECT, values)
    }
    return {
        redirectId: values.redirectId,
        revision: values.revision,
        url: checked.url,
        redirect: redirectRow(one(REDIRECT, {redirectId: values.redirectId}))
    }
}

// ===== publish#SiteNavigation =====
// publish#SiteNavigation: a menu's draft as a new version (every destination checked again; from now: it ends the active
// version and advances the generation; from a later date: scheduled, revalidated by the publication job), or the active
// version withdrawn; or a redirect's draft published (now or scheduled) or a live redirect withdrawn. expectedRevision is
// the menu's draftRevision or the redirect's revision; operationKey answers a retry. previewOnly answers the destinations'
// checks and the generation without writing. COMMERCE_PUBLISH.
function publishSiteNavigation(p) {
    const s = scopeWith(["COMMERCE_PUBLISH"])
    const {site, mount, store} = siteOf(s, p.siteId)
    const ctx = contextOf(site, mount, store)
    const action = text(p.publishAction) || "publish"
    if (!["publish", "withdraw"].includes(action)) refuse("VALUE_INVALID", "Choose publish or withdraw")
    const target = p.redirectId
        ? {kind: "redirect", row: redirectOf(ctx, p.redirectId, true)}
        : {kind: "menu", row: menuOf(ctx, p.navigationId, true)}
    const revisionNow = Number((target.kind === "menu" ? target.row.draftRevision : target.row.revision) || 0)
    // a redirect keeps the from date of its draft while it is still to come; one that has passed (a draft published late, a
    // failed scheduled one published again) is now
    const draftFrom = target.kind === "redirect" && ms(target.row.fromDate) > nowMs() ? target.row.fromDate : null
    const fromDate = action === "publish" ? fromDateOf(p.fromDate ?? draftFrom) : null
    const thruDate =
        action === "publish"
            ? thruDateOf(p.thruDate ?? (target.kind === "redirect" ? target.row.thruDate : null), fromDate)
            : null
    if (p.previewOnly === true || p.previewOnly === "true") {
        const preview = {
            kind: target.kind,
            publishAction: action,
            scheduled: fromDate != null && fromDate > nowMs(),
            generation: Number(site.generation || 0),
            nextGeneration: Number(site.generation || 0) + 1,
            siteId: site.siteId,
            mountPath: mount.pathPrefix
        }
        if (target.kind === "menu") preview.items = itemRows(ctx, itemsOf(target.row), true)
        else
            try {
                preview.url = checkRedirect(ctx, target.row).url
            } catch (error) {
                preview.problem = error.message
            }
        return preview
    }
    const op = lib.operation(p, "SiteNavigationPublish", store.organizationPartyId, {
        navigationId: p.navigationId || null,
        redirectId: p.redirectId || null,
        action,
        fromDate: text(p.fromDate),
        thruDate: text(p.thruDate)
    })
    const earlier = lib.previous(op)
    if (earlier) return earlier
    if (p.expectedRevision == null || p.expectedRevision === "" || Number(p.expectedRevision) !== revisionNow)
        refuse("REVISION_STALE", "The " + target.kind + " changed; its revision is now " + revisionNow)
    const reason = stores.reason(p, false)
    const out =
        target.kind === "menu"
            ? publishMenu(ctx, target.row, action, fromDate, thruDate, reason)
            : publishRedirect(ctx, target.row, action, fromDate, thruDate, reason)
    lib.complete(
        op,
        target.kind === "menu" ? NAV : REDIRECT,
        target.kind === "menu" ? target.row.navigationId : target.row.redirectId,
        out
    )
    return out
}
// Every item of a menu checked; the refusal names each that fails.
function checkMenu(ctx, items) {
    const problems = []
    for (const item of items)
        try {
            checkDestination(ctx, item.destinationTypeEnumId, item.destinationValue)
        } catch (error) {
            problems.push({item, code: lib.reasonCode(error), message: error.message})
        }
    if (problems.length)
        refuse(
            problems[0].code || "DESTINATION_INVALID",
            "The menu links to what cannot be shown: " +
                problems.map(problem => problem.item.label + " (" + problem.message.replace(/^[A-Z_]+: /, "") + ")").join("; ")
        )
}
function publishMenu(ctx, menu, action, fromDate, thruDate, reason) {
    const now = nowMs()
    if (action === "withdraw") {
        const active = activeVersion(menu.navigationId, now)
        if (!active) refuse("NOT_PUBLISHED", "The menu is not published")
        call("update#" + NAV_VERSION, {
            navigationId: menu.navigationId,
            fromDate: active.fromDate,
            thruDate: now,
            publicationStateEnumId: "SpsWithdrawn"
        })
        return {navigationId: menu.navigationId, state: "withdrawn", generation: advance(ctx.site.siteId)}
    }
    const items = itemsOf(menu)
    checkMenu(ctx, items)
    // a later schedule replaces one still waiting, and one that failed at its date (which the store's readiness lists)
    for (const waiting of rows(NAV_VERSION, {navigationId: menu.navigationId}).filter(row =>
        ["SpsScheduled", "SpsFailed"].includes(row.publicationStateEnumId)
    ))
        call("update#" + NAV_VERSION, {
            navigationId: menu.navigationId,
            fromDate: waiting.fromDate,
            publicationStateEnumId: "SpsWithdrawn"
        })
    const scheduled = fromDate > now
    call("create#" + NAV_VERSION, {
        navigationId: menu.navigationId,
        fromDate,
        thruDate,
        draftRevision: Number(menu.draftRevision || 0),
        snapshotText: JSON.stringify(items),
        publicationStateEnumId: scheduled ? "SpsScheduled" : "SpsActive",
        publishedByUserId: ec.user.userId,
        publishedDate: now,
        changeReason: reason
    })
    if (scheduled) return {navigationId: menu.navigationId, state: "scheduled", fromDate, generation: null}
    return {
        navigationId: menu.navigationId,
        state: "published",
        fromDate,
        generation: activateMenuVersion(ctx, menu.navigationId, fromDate)
    }
}
// The version from fromDate is the live one: the active versions before it end there.
function activateMenuVersion(ctx, navigationId, fromDate) {
    for (const row of rows(NAV_VERSION, {navigationId, publicationStateEnumId: "SpsActive"}))
        if (ms(row.fromDate) < fromDate && (ms(row.thruDate) ?? Infinity) > fromDate)
            call("update#" + NAV_VERSION, {
                navigationId,
                fromDate: row.fromDate,
                thruDate: fromDate,
                publicationStateEnumId: "SpsSuperseded"
            })
    call("update#" + NAV_VERSION, {
        navigationId,
        fromDate,
        publicationStateEnumId: "SpsActive",
        failureCode: null,
        failureMessage: null
    })
    return advance(ctx.site.siteId)
}
function publishRedirect(ctx, redirect, action, fromDate, thruDate, reason) {
    const now = nowMs()
    const revision = Number(redirect.revision || 0) + 1
    if (action === "withdraw") {
        if (!["SpsActive", "SpsScheduled"].includes(redirect.publicationStateEnumId))
            refuse("NOT_PUBLISHED", "The redirect is not published")
        call("update#" + REDIRECT, {
            redirectId: redirect.redirectId,
            thruDate: now,
            publicationStateEnumId: "SpsWithdrawn",
            revision,
            changeReason: reason
        })
        return {redirectId: redirect.redirectId, state: "withdrawn", revision, generation: advance(ctx.site.siteId)}
    }
    if (!["SpsDraft", "SpsFailed"].includes(redirect.publicationStateEnumId))
        refuse("ALREADY_PUBLISHED", "The redirect is published already")
    const checked = checkRedirect(ctx, redirect)
    const scheduled = fromDate > now
    call("update#" + REDIRECT, {
        redirectId: redirect.redirectId,
        fromDate,
        thruDate,
        publicationStateEnumId: scheduled ? "SpsScheduled" : "SpsActive",
        publishedByUserId: ec.user.userId,
        revision,
        changeReason: reason,
        failureCode: null,
        failureMessage: null
    })
    return {
        redirectId: redirect.redirectId,
        state: scheduled ? "scheduled" : "published",
        revision,
        url: checked.url,
        generation: scheduled ? null : advance(ctx.site.siteId)
    }
}

// ===== live navigation and redirects =====
// A published site's live context: its Shop mount and store when it has them.
function liveContext(siteId) {
    const site = siteId ? one(SITE, {siteId}) : null
    if (!site || site.state !== "published") refuse("NOT_FOUND", "Not found", "NotFound")
    const mount = rows(SITE_APP, {siteId, app: "shop", enabled: "Y"})[0]
    const store = mount?.targetId ? one("mantle.product.store.ProductStore", {productStoreId: mount.targetId}) : null
    if (!mount || !store) refuse("NOT_FOUND", "Not found", "NotFound")
    return contextOf(site, mount, store)
}
// A menu's live items as a tree of {label, url, children}: the active version's visible items whose destinations are public
// now (an item whose product or page was withdrawn since is left out, with its children).
function liveNavigation(ctx, menuKey, locale) {
    const at = nowMs()
    const menus = rows(NAV, {siteId: ctx.site.siteId, appMountId: ctx.mount.appMountId, menuKey})
    const wanted = text(locale).replace(/-/g, "_")
    const language = wanted.split("_")[0]
    const menu = [wanted, language, null].map(want => menus.find(row => (row.locale || null) === (want || null))).find(Boolean)
    const version = menu ? activeVersion(menu.navigationId, at) : null
    if (!version) return []
    const items = (lib.json(version.snapshotText, []) || []).filter(item => item.visible !== "N")
    const build = parentId =>
        items
            .filter(item => (item.parentItemId || null) === parentId)
            .map(item => {
                const url = liveUrl(ctx, item.destinationTypeEnumId, item.destinationValue)
                return url ? {label: item.label, url, children: build(item.itemId)} : null
            })
            .filter(Boolean)
    return build(null)
}
// get#SiteNavigation: a published site's live menu by key (main by default) and locale.
function getSiteNavigation(p) {
    const ctx = liveContext(p.siteId)
    return {navigation: liveNavigation(ctx, text(p.menuKey) || "main", p.locale), generation: Number(ctx.site.generation || 0)}
}
// resolve#SiteRedirect: a published site's live redirect of a path: its destination's url now and whether it is permanent;
// NotFound when there is none or its destination is not public now.
function resolveSiteRedirect(p) {
    const ctx = liveContext(p.siteId)
    const path = text(p.path).replace(/(.)\/$/, "$1")
    const at = nowMs()
    const row = rows(REDIRECT, {siteId: ctx.site.siteId, oldPath: path}).find(candidate => liveRedirect(candidate, at))
    const url = row ? liveUrl(ctx, row.destinationTypeEnumId, row.destinationValue) : null
    if (!url) refuse("NOT_FOUND", "Not found", "NotFound")
    return {url, permanent: row.permanent !== "N", status: row.permanent === "N" ? 302 : 301}
}

// ===== the publication job =====
// run#ScheduledSitePublications: each page, menu version and redirect whose scheduled from date has come, revalidated and
// activated in its own transaction (run#ScheduledSitePublication); one that fails is named in the log and the rest go on.
function runScheduledSitePublications(p) {
    const now = ec.user.nowTimestamp
    const limit = Math.min(500, Math.max(1, Number(p.limit) || 100))
    const due = []
    for (const row of Array.from(
        find(PAGE)
            .condition("scheduledFromDate", "less-equals", now)
            .condition("failureCode", "is-null", null)
            .limit(limit)
            .list()
    ))
        due.push({kind: "page", id: row.sitePageId})
    for (const row of Array.from(
        find(NAV_VERSION)
            .condition("publicationStateEnumId", "SpsScheduled")
            .condition("fromDate", "less-equals", now)
            .limit(limit)
            .list()
    ))
        due.push({kind: "menu", id: row.navigationId, fromDate: ms(row.fromDate)})
    for (const row of Array.from(
        find(REDIRECT)
            .condition("publicationStateEnumId", "SpsScheduled")
            .condition("fromDate", "less-equals", now)
            .limit(limit)
            .list()
    ))
        due.push({kind: "redirect", id: row.redirectId})
    const results = []
    for (const item of due) {
        try {
            const out = lib.probe("mantle.public.ThemeServices.run#ScheduledSitePublication", item)
            results.push(Object.assign({}, item, out.result || {}))
        } catch (error) {
            // its transaction could not commit (a refusal that marked it for rollback): the refusal is recorded here, so
            // the item is not tried again every minute and the store's readiness names it
            ec.logger.error("Scheduled publication of " + item.kind + " " + item.id + " was not run: " + error.message)
            const code = lib.reasonCode(error) || "PUBLICATION_FAILED"
            try {
                recordFailure(item, code, error.message)
            } catch (recordError) {
                ec.message.clearErrors()
                ec.logger.error("The failure of " + item.kind + " " + item.id + " was not recorded: " + recordError.message)
            }
            results.push(Object.assign({}, item, {ok: false, code, message: error.message}))
        }
    }
    return {
        dueCount: due.length,
        activatedCount: results.filter(row => row.ok).length,
        failedCount: results.filter(row => !row.ok).length,
        results
    }
}
// Run as a user for one scheduled item, then sign back in as the user before (or none).
function asAuthor(userId, action) {
    const account = userId ? one("moqui.security.UserAccount", {userId}) : null
    const previous = ec.user.username
    const signedIn = !!account && ec.user.internalLoginUser(account.username) === true && ec.user.userId === userId
    try {
        if (!signedIn) refuse("AUTHOR_UNAVAILABLE", "The user who scheduled it can no longer sign in")
        return action()
    } finally {
        if (signedIn || ec.user.userId) {
            if (previous) {
                if (previous !== ec.user.username) ec.user.internalLoginUser(previous)
            } else ec.user.logoutUser()
        }
    }
}
// run#ScheduledSitePublication: one scheduled page, menu version or redirect, revalidated as the user who scheduled it
// (COMMERCE_PUBLISH and the store still theirs, the version or destinations still valid) and then activated; a refusal is
// recorded on it (the store's readiness lists it) and leaves what is live as it was.
function runScheduledSitePublication(p) {
    if (p.kind === "page") {
        const page = find(PAGE, {sitePageId: p.id}).forUpdate(true).one()
        if (!page || !page.scheduledFromDate || page.failureCode || ms(page.scheduledFromDate) > nowMs())
            return {result: {ok: true, skipped: true}}
        try {
            const generation = asAuthor(page.scheduledByUserId, () => {
                const s = scopeWith(["COMMERCE_PUBLISH"])
                const {store} = pageOf(s, page.sitePageId)
                const versionName = versionOf(wikiOf(page), page.scheduledVersionName)
                if (routeTaken(page, page.siteId, page.appMountId, page.routePath, page.locale))
                    refuse("ROUTE_TAKEN", "Another page of the site has the route " + page.routePath)
                const thru = ms(page.scheduledThruDate)
                windowOpen(thru)
                return activatePage(
                    page,
                    store,
                    versionName,
                    ms(page.scheduledFromDate),
                    thru,
                    page.scheduledByUserId,
                    page.changeReason,
                    Number(page.publicationRevision || 0) + 1
                )
            })
            return {result: {ok: true, generation}}
        } catch (error) {
            return {result: refused(p, error)}
        }
    }
    if (p.kind === "menu") {
        // the key's from date as a date-time: a bare number is not one to the database
        const version = find(NAV_VERSION, {navigationId: p.id, fromDate: new Date(Number(p.fromDate)).toISOString()})
            .forUpdate(true)
            .one()
        if (!version || version.publicationStateEnumId !== "SpsScheduled") return {result: {ok: true, skipped: true}}
        const menu = one(NAV, {navigationId: p.id})
        try {
            const generation = asAuthor(version.publishedByUserId, () => {
                const s = scopeWith(["COMMERCE_PUBLISH"])
                const {site, mount, store} = siteOf(s, menu.siteId)
                const ctx = contextOf(site, mount, store)
                windowOpen(version.thruDate)
                checkMenu(ctx, lib.json(version.snapshotText, []) || [])
                return activateMenuVersion(ctx, menu.navigationId, ms(version.fromDate))
            })
            return {result: {ok: true, generation}}
        } catch (error) {
            return {result: refused(Object.assign({}, p, {fromDate: version.fromDate}), error)}
        }
    }
    const redirect = find(REDIRECT, {redirectId: p.id}).forUpdate(true).one()
    if (!redirect || redirect.publicationStateEnumId !== "SpsScheduled") return {result: {ok: true, skipped: true}}
    try {
        const generation = asAuthor(redirect.publishedByUserId, () => {
            const s = scopeWith(["COMMERCE_PUBLISH"])
            const {site, mount, store} = siteOf(s, redirect.siteId)
            const ctx = contextOf(site, mount, store)
            windowOpen(redirect.thruDate)
            checkRedirect(ctx, redirect)
            call("update#" + REDIRECT, {redirectId: redirect.redirectId, publicationStateEnumId: "SpsActive"})
            return advance(site.siteId)
        })
        return {result: {ok: true, generation}}
    } catch (error) {
        return {result: refused(p, error)}
    }
}
// A scheduled page, menu version or redirect whose window ended before the job reached it is refused, not made live.
function windowOpen(thruDate) {
    const thru = ms(thruDate)
    if (thru != null && thru <= nowMs()) refuse("WINDOW_PASSED", "Its window ended before it started")
}
// A scheduled item's refusal recorded on it (the store's readiness lists it; what is live stays): {ok: false, code, message}.
// A refusal can come with error messages (an author who can no longer sign in), which would stop the record's write, so
// they are cleared first; the job records it again in its own transaction when this one cannot commit.
function refused(item, error) {
    const code = lib.reasonCode(error) || "PUBLICATION_FAILED"
    ec.message.clearErrors()
    recordFailure(item, code, error.message)
    ec.logger.warn("Scheduled publication of " + item.kind + " " + item.id + " refused: " + error.message)
    return {ok: false, code, message: error.message}
}
function recordFailure(item, code, message) {
    const failureMessage = String(message || code)
        .replace(/^[A-Z_]+: /, "")
        .slice(0, 255)
    if (item.kind === "page")
        call("update#" + PAGE, {sitePageId: item.id, failureCode: code, failureMessage, failureDate: nowMs()})
    else if (item.kind === "menu")
        call("update#" + NAV_VERSION, {
            navigationId: item.id,
            fromDate: item.fromDate,
            publicationStateEnumId: "SpsFailed",
            failureCode: code,
            failureMessage
        })
    else
        call("update#" + REDIRECT, {
            redirectId: item.id,
            publicationStateEnumId: "SpsFailed",
            failureCode: code,
            failureMessage
        })
}
// The failed scheduled publications of a store's sites, for its readiness (read only).
function failedPublications(siteIds) {
    if (!siteIds.length) return []
    const out = []
    for (const page of Array.from(
        find(PAGE).condition("siteId", "in", siteIds).condition("failureCode", "is-not-null", null).limit(20).list()
    ))
        out.push({
            kind: "page",
            id: page.sitePageId,
            label: page.title || page.routePath,
            message: page.failureMessage || page.failureCode
        })
    for (const menu of Array.from(find(NAV).condition("siteId", "in", siteIds).list()))
        for (const version of rows(NAV_VERSION, {navigationId: menu.navigationId, publicationStateEnumId: "SpsFailed"}))
            out.push({
                kind: "menu",
                id: menu.navigationId,
                label: menu.name || menu.menuKey,
                message: version.failureMessage || version.failureCode
            })
    for (const redirect of Array.from(
        find(REDIRECT).condition("siteId", "in", siteIds).condition("publicationStateEnumId", "SpsFailed").limit(20).list()
    ))
        out.push({
            kind: "redirect",
            id: redirect.redirectId,
            label: redirect.oldPath,
            message: redirect.failureMessage || redirect.failureCode
        })
    return out
}

const operations = {
    findSitePages,
    getSitePageHistory,
    storeSitePage,
    publishSitePage,
    getSitePage,
    findSiteNavigation,
    storeSiteNavigation,
    publishSiteNavigation,
    getSiteNavigation,
    resolveSiteRedirect,
    runScheduledSitePublications,
    runScheduledSitePublication
}
;({
    // tables and reads for the Shop page view (ThemeView.js) and the store's readiness (StoreAdmin.js)
    forumRoles,
    policyRoles,
    destinationTypes,
    liveContext,
    liveNavigation,
    failedPublications,
    execute: (op, parameters) => {
        if (!operations[op]) throw new Error("Unknown site page operation " + op)
        return operations[op](parameters || {})
    }
})
