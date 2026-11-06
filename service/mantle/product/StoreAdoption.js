/* CC0 1.0 Universal plus Grant of Patent License. See LICENSE.md.
 * The adoption preview of an existing (PopRestStore) store (mr-pass impl-shop P8; design-shop §17.1): what moving the store
 * to Shop would take, read only. Nothing here writes, enables or publishes anything: publication rows are proposed by
 * Commerce P3's propose#StorePublication for a publisher to approve through publish#StoreProducts; mounts, themes and
 * purchases are turned on by their owners' own services afterwards.
 *
 * The preview reads the store's categories (its roles and their members), settings (the store's legacy fields and setting
 * rows, each mapped to Commerce's store settings or named as not used by Shop), content and template sources (the
 * ProductStoreWikiContent template roles and the store's wiki spaces, POPC_DEFAULT's ZZWR_TMP among them, each mapped to a
 * package section of the theme with conversion findings for what the locked renderer will not run: FreeMarker, Groovy and
 * server context, Vue 2 and scripts), slugs (Shop's product and category paths), gateways (whether each has a hosted page),
 * facilities and email templates, and the sites that mount the store. Each finding names its code, severity (error: must be
 * done before Shop can serve it; warning: should be looked at; info: kept as it is) and source. A conversion is a migration
 * aid, never an execution: no template is rendered or evaluated.
 */
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const stores = ec.resource.script("component://mr-mantle/service/mantle/product/StoreAdmin.js")
const settings = () => ec.resource.script("component://mr-mantle/service/mantle/product/StoreCheckout.js")
const catalog = () => ec.resource.script("component://mr-mantle/service/mantle/product/ShopCatalog.js")
const {find, one, rows, active} = lib
const S = "mantle.product.store."

// ===== tables =====
const limits = {categories: 200, members: 2000, sources: 100, sourceBytes: 200000, slugs: 20}
// PopRestStore's template roles (ProductStoreContentType) and the theme package's place for each (theme/starter): a layout,
// a page kind's template with its main section, or a snippet; the sign-in pages stay PASS Account's (not themed).
const sections = {
    PsctRootTemplateServer: "layouts/store (the page shell)",
    PsctHeaderTemplate: "layouts/store (header)",
    PsctHeaderTemplateServer: "layouts/store (header)",
    PsctFooterTemplate: "layouts/store (footer)",
    PsctFooterTemplateServer: "layouts/store (footer)",
    PsctHomeTemplate: "templates/home (hero, product-grid)",
    PsctHomeTemplateServer: "templates/home (hero, product-grid)",
    PsctCategoryTemplate: "templates/category (category-main)",
    PsctCategoryTemplateServer: "templates/category (category-main)",
    PsctCategoryProductTemplate: "snippets/product-card",
    PsctProductTemplate: "templates/product (product-main)",
    PsctProductTemplateServer: "templates/product (product-main)",
    PsctProductImageTemplate: "templates/product (product-main)",
    PsctProductReviewTemplate: "templates/product (product-main, the reviews block)",
    PsctSearchTemplate: "templates/search (search-results)",
    PsctCheckoutTemplate: "templates/checkout (checkout-main; its purchase components are required)",
    PsctCheckoutHeaderTemplate: "templates/checkout (checkout-main)",
    PsctCheckoutSuccessTemplate: "templates/checkout (the confirmation)",
    PsctAccountTemplate: "templates/account (account-main)",
    PsctOrderHistoryTemplate: "templates/orders",
    PsctOrderDetailTemplate: "templates/order"
}
const notThemed = ["PsctLoginTemplate", "PsctResetPasswordTemplate", "PsctAccountCreateTemplate"]
// The store's wiki spaces by type: templates are converted into the theme package by hand; content becomes version-pinned
// site pages (Commerce P4's PublicSitePage).
const spaceKinds = {
    PstTmpSrv: "theme package sources (converted by hand)",
    PstTmpClt: "theme package sources (converted by hand)",
    PstFull: "site pages (version-pinned PublicSitePage)",
    PstBlog: "site pages (version-pinned PublicSitePage)",
    PstSnip: "theme blocks (rich text)"
}
// What the locked renderer does not run (design-shop §12.4): each pattern, its finding text.
const unsupported = [
    [/<#|<\/#|<@|<\/@/, "FreeMarker directives"],
    [/\$\{/, "FreeMarker or Groovy expressions"],
    [/\bec\.(?:user|entity|service|resource|web|l10n|context)\b/, "server context (ec)"],
    [/\bv-(?:if|else|for|model|bind|on|show|html)\b|\{\{|@click|:class=/, "Vue 2 template syntax"],
    [/<script\b/i, "scripts"]
]
// The setting types Shop and Commerce use beside StoreAdmin's settingTypes (StoreTopics' lists).
const shopSettingTypes = ["PsstCartReminderList", "PsstReviewRequestList"]
const extensions = ["", ".ftl", ".html", ".md", ".cwiki", ".txt"]

// ===== values =====
const text = value => (value == null ? "" : String(value).trim())
const enumText = enumId => (enumId ? one("moqui.basic.Enumeration", {enumId})?.description || enumId : "")
const finding = (code, severity, source, message) => ({code, severity, source, text: message})

// ===== sections of the preview =====
function categoriesOf(store, findings) {
    const roles = rows(S + "ProductStoreCategory", {productStoreId: store.productStoreId}).filter(row => active(row))
    const out = roles.slice(0, limits.categories).map(row => {
        const category = one("mantle.product.category.ProductCategory", {productCategoryId: row.productCategoryId})
        return {
            productCategoryId: row.productCategoryId,
            categoryName: category?.categoryName || row.productCategoryId,
            roleEnumId: row.storeCategoryTypeEnumId,
            roleText: enumText(row.storeCategoryTypeEnumId),
            memberCount: find("mantle.product.category.ProductCategoryMember", {productCategoryId: row.productCategoryId})
                .limit(limits.members)
                .count()
        }
    })
    for (const role of ["PsctViewAllow", "PsctPurchaseAllow"])
        if (!roles.some(row => row.storeCategoryTypeEnumId === role))
            findings.push(
                finding(
                    "CATEGORY_ROLE_MISSING",
                    "warning",
                    "categories",
                    "The store has no " + enumText(role) + " category: Shop shows and sells only products in it"
                )
            )
    return out
}
function settingsOf(store, findings) {
    const known = Object.keys(stores.settingTypes).concat(shopSettingTypes)
    const out = rows(S + "ProductStoreSetting", {productStoreId: store.productStoreId})
        .filter(row => active(row))
        .map(row => {
            const mapped = known.includes(row.settingTypeEnumId)
            if (!mapped)
                findings.push(
                    finding(
                        "SETTING_UNMAPPED",
                        "warning",
                        row.settingTypeEnumId,
                        enumText(row.settingTypeEnumId) + " is kept on the store; Shop and Commerce do not use it"
                    )
                )
            return {settingTypeEnumId: row.settingTypeEnumId, typeText: enumText(row.settingTypeEnumId), mapped}
        })
    if (store.storeDomain)
        findings.push(
            finding(
                "STORE_DOMAIN_KEPT",
                "info",
                "storeDomain",
                "The store's domain " +
                    store.storeDomain +
                    " stays for its existing emails' links; Shop answers only on its site's registered hosts"
            )
        )
    if (store.profileUrlPath)
        findings.push(
            finding("SETTING_UNMAPPED", "warning", "profileUrlPath", "The profile path is not used: accounts are PASS Account's")
        )
    return out
}
// The text of a wiki page (its published version when it has one), or null when its source cannot be found.
function pageSource(wikiSpaceId, pagePath) {
    const space = wikiSpaceId ? one("moqui.resource.wiki.WikiSpace", {wikiSpaceId}) : null
    if (!space?.rootPageLocation) return null
    const page = one("moqui.resource.wiki.WikiPage", {wikiSpaceId, pagePath: pagePath || ""})
    const base = String(space.rootPageLocation).replace(/\.[A-Za-z0-9]+$/, "")
    for (const extension of extensions) {
        const location = base + (pagePath ? "/" + pagePath : "") + extension
        try {
            const reference = ec.resource.getLocationReference(location)
            if (!reference.exists || reference.isDirectory?.()) continue
            const source = page?.publishedVersionName ? reference.getText(page.publishedVersionName) : reference.getText()
            return {location, text: String(source || "").slice(0, limits.sourceBytes)}
        } catch (error) {
            ec.message.clearErrors()
        }
    }
    return null
}
// The unsupported syntax of a source, each with the first line it is on.
function syntaxOf(source) {
    const lines = String(source || "").split("\n")
    const out = []
    for (const [pattern, name] of unsupported) {
        const index = lines.findIndex(line => pattern.test(line))
        if (index >= 0) out.push({name, line: index + 1})
    }
    return out
}
function templatesOf(store, findings) {
    const spaces = rows(S + "ProductStoreWikiSpace", {productStoreId: store.productStoreId}).filter(row => active(row))
    const spaceOf = spaceTypeEnumId => spaces.find(row => row.spaceTypeEnumId === spaceTypeEnumId)?.wikiSpaceId || null
    const contents = rows(S + "ProductStoreWikiContent", {productStoreId: store.productStoreId})
        .filter(row => active(row))
        .slice(0, limits.sources)
    const roles = contents.map(row => {
        const source = `${row.contentTypeEnumId} (${row.pagePath || "root"})`
        const section = sections[row.contentTypeEnumId] || null
        const wikiSpaceId = spaceOf(row.spaceTypeEnumId)
        const found = pageSource(wikiSpaceId, row.pagePath)
        const syntax = found ? syntaxOf(found.text) : []
        if (notThemed.includes(row.contentTypeEnumId))
            findings.push(
                finding(
                    "TEMPLATE_NOT_THEMED",
                    "info",
                    source,
                    enumText(row.contentTypeEnumId) + " is a PASS Account page, which is not themed"
                )
            )
        else if (!section)
            findings.push(
                finding(
                    "TEMPLATE_UNMAPPED",
                    "warning",
                    source,
                    enumText(row.contentTypeEnumId) + " has no place in the theme package"
                )
            )
        if (!found)
            findings.push(
                finding("SOURCE_MISSING", "warning", source, "Its source page " + (row.pagePath || "") + " was not found")
            )
        for (const item of syntax)
            findings.push(
                finding(
                    "UNSUPPORTED_SYNTAX",
                    "error",
                    source,
                    "Line " +
                        item.line +
                        " uses " +
                        item.name +
                        ", which the theme renderer does not run; rewrite it as a locked template"
                )
            )
        return {
            storeWikiContentId: row.storeWikiContentId,
            contentTypeEnumId: row.contentTypeEnumId,
            typeText: enumText(row.contentTypeEnumId),
            pagePath: row.pagePath || "",
            wikiSpaceId,
            section: notThemed.includes(row.contentTypeEnumId) ? "PASS Account (not themed)" : section,
            location: found?.location || null,
            unsupported: syntax.map(item => item.name),
            convertible: !!found && !syntax.length && !!section
        }
    })
    const spaceRows = spaces.map(row => ({
        wikiSpaceId: row.wikiSpaceId,
        spaceTypeEnumId: row.spaceTypeEnumId,
        typeText: enumText(row.spaceTypeEnumId),
        mapsTo: spaceKinds[row.spaceTypeEnumId] || null
    }))
    for (const row of spaceRows)
        if (!row.mapsTo)
            findings.push(finding("SPACE_UNMAPPED", "warning", row.wikiSpaceId, row.typeText + " has no place in Shop"))
    return {roles, spaces: spaceRows}
}
function gatewaysOf(store, findings) {
    return rows(S + "ProductStorePaymentGateway", {productStoreId: store.productStoreId}).map(row => {
        const config = one("mantle.account.method.PaymentGatewayConfig", {paymentGatewayConfigId: row.paymentGatewayConfigId})
        const of = config ? settings().gatewayCapabilities[config.paymentGatewayTypeEnumId] : null
        const hosted = !!(of && of(config).hostedCheckout)
        if (!hosted)
            findings.push(
                finding(
                    "GATEWAY_NOT_HOSTED",
                    "error",
                    row.paymentGatewayConfigId,
                    enumText(row.paymentInstrumentEnumId) +
                        " is paid through " +
                        (config?.description || row.paymentGatewayConfigId) +
                        ", which has no hosted page; Shop takes payment only on a provider's hosted page"
                )
            )
        return {
            paymentInstrumentEnumId: row.paymentInstrumentEnumId,
            paymentGatewayConfigId: row.paymentGatewayConfigId,
            description: config?.description || row.paymentGatewayConfigId,
            hostedCheckout: hosted
        }
    })
}
function facilitiesOf(store, findings) {
    const ids = rows(S + "ProductStoreFacility", {productStoreId: store.productStoreId})
        .filter(row => active(row))
        .map(row => row.facilityId)
    if (store.inventoryFacilityId && !ids.includes(store.inventoryFacilityId)) ids.unshift(store.inventoryFacilityId)
    if (!ids.length)
        findings.push(
            finding(
                "FACILITY_MISSING",
                store.requireInventory === "Y" ? "error" : "warning",
                "facilities",
                "The store names no facility to sell stock from"
            )
        )
    return ids.map(facilityId => ({
        facilityId,
        facilityName: one("mantle.facility.Facility", {facilityId})?.facilityName || facilityId
    }))
}
function emailsOf(store, findings) {
    const out = rows(S + "ProductStoreEmail", {productStoreId: store.productStoreId})
        .filter(row => active(row))
        .map(row => ({
            emailTypeEnumId: row.emailTypeEnumId,
            typeText: enumText(row.emailTypeEnumId),
            emailTemplateId: row.emailTemplateId
        }))
    if (out.length)
        findings.push(
            finding(
                "EMAIL_TEMPLATES_KEPT",
                "info",
                "emails",
                "The store's " + out.length + " email templates stay as they are and keep sending the store's emails"
            )
        )
    if (!out.some(row => row.emailTypeEnumId === "PsetDownloadReady"))
        findings.push(
            finding(
                "EMAIL_MISSING",
                "warning",
                "PsetDownloadReady",
                "No download-ready email: buyers of files get the receipt only"
            )
        )
    return out
}
function sitesOf(store, findings) {
    const mounts = rows("mantle.public.PublicSiteApp", {app: "shop", targetId: store.productStoreId})
    if (!mounts.length)
        findings.push(
            finding(
                "MOUNT_REQUIRED",
                "info",
                "sites",
                "No site mounts the store: start with a disabled Shop mount on a site with its registered hosts"
            )
        )
    return mounts.map(row => {
        const site = one("mantle.public.PublicSite", {siteId: row.siteId})
        return {
            siteId: row.siteId,
            siteName: site?.name || row.siteId,
            pathPrefix: row.pathPrefix,
            enabled: row.enabled === "Y",
            state: site?.state || null
        }
    })
}
function slugsOf(categories, findings) {
    const slug = catalog().slug
    const out = categories.slice(0, limits.slugs).map(row => ({
        productCategoryId: row.productCategoryId,
        path: "/categories/" + row.productCategoryId + "/" + slug(row.categoryName)
    }))
    for (const row of categories)
        if (!slug(row.categoryName))
            findings.push(
                finding(
                    "SLUG_EMPTY",
                    "warning",
                    row.productCategoryId,
                    "The category's name gives no path words; its path is its id alone"
                )
            )
    findings.push(
        finding(
            "ROUTES_CHANGE",
            "info",
            "slugs",
            "Shop's paths are /products/{id}/{name} and /categories/{id}/{name}; give the old storefront's paths site redirects before switching hosts"
        )
    )
    return out
}
// Commerce P3's proposal (a store with no publication rows), read as the caller; a store with rows has none.
function proposalsOf(store, findings) {
    const existing = find(S + "ProductStoreProduct", {productStoreId: store.productStoreId}).count()
    if (existing > 0) {
        findings.push(
            finding(
                "PUBLICATION_EXISTS",
                "info",
                "publication",
                "The store already publishes " + existing + " rows; publish further products from Merchandising"
            )
        )
        return {publicationRows: existing, proposals: [], proposalsCount: 0}
    }
    const proposed = ec.service
        .sync()
        .name("mantle.product.StoreMerchandisingServices.propose#StorePublication")
        .parameters({productStoreId: store.productStoreId})
        .call()
    if (ec.message.hasError()) throw new Error(ec.message.getErrorsString())
    return {publicationRows: 0, proposals: proposed?.proposals || [], proposalsCount: proposed?.proposalsCount || 0}
}

// preview#StoreAdoption: COMMERCE_VIEW and the store's scope; read only.
function previewStoreAdoption(p) {
    const s = stores.scope("view")
    const store = stores.storeOf(s, p.productStoreId)
    const findings = []
    const categories = categoriesOf(store, findings)
    const out = {
        store: {productStoreId: store.productStoreId, storeName: store.storeName, organizationPartyId: store.organizationPartyId},
        categories,
        settings: settingsOf(store, findings),
        templates: templatesOf(store, findings),
        gateways: gatewaysOf(store, findings),
        facilities: facilitiesOf(store, findings),
        emails: emailsOf(store, findings),
        sites: sitesOf(store, findings),
        slugs: slugsOf(categories, findings)
    }
    Object.assign(out, proposalsOf(store, findings))
    const order = {error: 0, warning: 1, info: 2}
    out.findings = findings.sort((a, b) => order[a.severity] - order[b.severity])
    out.summary = {
        errors: findings.filter(row => row.severity === "error").length,
        warnings: findings.filter(row => row.severity === "warning").length,
        infos: findings.filter(row => row.severity === "info").length
    }
    // the preview never enables, publishes or writes anything
    out.enabled = false
    return out
}

const operations = {previewStoreAdoption}
;({
    sections,
    syntaxOf,
    execute: (op, parameters) => {
        if (!operations[op]) throw new Error("Unknown store adoption operation " + op)
        return operations[op](parameters || {})
    }
})
