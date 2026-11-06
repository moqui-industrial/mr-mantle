// Shop themes and releases (mr-pass impl-shop P2, SHOP-THEME; design-shop §12.2-§12.5, §12.7): a store's theme drafts,
// their validation, the immutable releases publish makes, the binding of a site's Shop mount to its active release, and
// the reads a PASS frontend renders a release from. The renderer is the framework's composition adapter
// (ec.resource.theme, mr-moqui docs/ui/Themes.md); this module keeps the records and never renders a live page itself.
//
// A theme's draft is the current text of the files under its package root, dbresource://mantle/public/theme/{themeId}
// (never a location from a request). publish#Theme pins each file's dbresource version and SHA-256 in a
// PublicThemeRelease with its manifest, and switches the site's PublicThemeBinding to it in the same transaction as the
// site's generation, checked against the active revision the publisher saw. restore#ThemeRelease switches back to an
// earlier release of the same store through the same gate. A release is never changed.
//
// Staff services check their permission (COMMERCE_VIEW to read, COMMERCE_THEME_EDIT for drafts, COMMERCE_THEME_PUBLISH
// to publish or restore) and the store's scope through StoreAdmin.js (the user's organizations, a StoreStaff row's
// stores): the theme's store, and for a site the store its Shop mount targets. Reads and writes below the checks run
// without artifact authorization. Refusals start with their reason code.
//
// Commerce P5's editors build on the core section (drafts, files, validation, releases); its services call
// draftFiles/putDraftFiles and validateTheme, publishTheme and restoreThemeRelease rather than writing these rows.
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const stores = ec.resource.script("component://mr-mantle/service/mantle/product/StoreAdmin.js")
const {find, one, rows, call, access} = lib
const P = "mantle.public."
const THEME = P + "PublicTheme"
const RELEASE = P + "PublicThemeRelease"
const RELEASE_FILE = P + "PublicThemeReleaseFile"
const BINDING = P + "PublicThemeBinding"
const SITE = P + "PublicSite"
const SITE_APP = P + "PublicSiteApp"

// ===== tables =====
// The page kinds a Shop theme renders (design-shop §2, §12.2); validation requires a template for each. Later phases
// render them (P3 the catalog, P4 the cart, P5 checkout, P6 orders and account, P7 subscriptions).
const pageKinds = [
    "home",
    "category",
    "product",
    "search",
    "page",
    "cart",
    "checkout",
    "order",
    "account",
    "orders",
    "downloads",
    "subscriptions",
    "not-found"
]
// The trusted components a theme must declare, each with the page kinds whose template must place it (design-shop
// §12.4): a theme cannot remove purchase, cart or checkout mechanics.
const requiredComponents = {
    "shop.productPurchase": ["product"],
    "shop.cart": ["cart"],
    "shop.checkout": ["checkout"],
    // P3: the search form (a theme has no <form>)
    "shop.search": ["search"]
}
// The engines and versions this authority publishes for (design-shop §12.7: readiness blocks unsupported versions).
const renderers = {"js-fancy": {rendererVersion: 1, viewApiVersions: [1]}}
const viewApiVersion = 1
// A package's bounds: files, bytes of one file and of all, and the paths a package may hold.
const packageLimits = {maxFiles: 300, maxFileBytes: 512 * 1024, maxPackageBytes: 8 * 1024 * 1024}
const pathPattern = /^[A-Za-z0-9_-][A-Za-z0-9_.-]*(\/[A-Za-z0-9_-][A-Za-z0-9_.-]*)*$/
const textExtensions = [".json", ".html.fancy-locked", ".css", ".svg"]
// Commerce P5 (F55): images and fonts under assets/, kept as bytes; in a package (the adapter's, a release read, a remote
// frontend's file) a binary file's text is the base64 of its bytes, and its digest is of that text.
const binaryExtensions = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".woff2"]
// A starter is a component's theme/{name} directory, named "component/name".
const starterPattern = /^([a-z0-9][a-z0-9-]{0,60})\/([a-z0-9][a-z0-9-]{0,60})$/
// Files a remote frontend may read in one call.
const filesPerRead = 50

// ===== values =====
const text = value => (value == null ? "" : String(value).trim())
const digestOf = content => ec.resource.digestText(content, "sha256")
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
const parsed = (content, fallback = null) => {
    try {
        return JSON.parse(content)
    } catch (error) {
        return fallback
    }
}
const isTextPath = path => textExtensions.some(extension => path.endsWith(extension))
const isBinaryPath = path =>
    path.startsWith("assets/") && binaryExtensions.some(extension => path.toLowerCase().endsWith(extension))
const isPackagePath = path => isTextPath(path) || isBinaryPath(path)
// The base64 of a stream's bytes (null for none), closing it.
function streamBase64(stream) {
    if (stream == null) return null
    try {
        return StringUtilities.base64Encode(stream.readAllBytes())
    } finally {
        stream.close()
    }
}
// A package file's text at a location (a binary file's base64), its version when named.
function fileText(location, path, versionName) {
    if (!isBinaryPath(path))
        return versionName
            ? ec.resource.getLocationReference(location).getText(versionName)
            : ec.resource.getLocationReference(location).getText()
    return streamBase64(ec.resource.getLocationReference(versionName ? location + "#" + versionName : location).openStream())
}
const rootOf = themeId => "dbresource://mantle/public/theme/" + themeId

// ===== scope =====
// The user's scope with a theme permission: COMMERCE_VIEW (StoreAdmin's scope) and the permission asked, any of a list.
function scopeWith(permissions) {
    const s = stores.scope()
    if (permissions.length && !permissions.some(permission => access.has(permission)))
        refuse("PERMISSION_DENIED", permissions.join(" or ") + " is required")
    return s
}
// A theme of a store in the user's scope; a missing one and one outside are refused alike.
function themeOf(s, themeId, forUpdate = false) {
    const theme = themeId ? find(THEME, {themeId}).forUpdate(forUpdate).one() : null
    if (!theme) refuse("RECORD_UNAVAILABLE", "Theme " + (themeId || "") + " is not available")
    try {
        stores.storeOf(s, theme.productStoreId)
    } catch (error) {
        refuse("RECORD_UNAVAILABLE", "Theme " + themeId + " is not available")
    }
    return theme
}
// A site's Shop mount and its store, in the user's scope: what publish and restore bind.
function shopMountOf(s, siteId) {
    const site = siteId ? one(SITE, {siteId}) : null
    const mount = site ? rows(SITE_APP, {siteId, app: "shop"})[0] : null
    if (!mount || !mount.targetId) refuse("NO_SHOP_MOUNT", "Site " + (siteId || "") + " has no Shop mount", "NotFound")
    const store = stores.storeOf(s, mount.targetId)
    return {site, mount, store}
}

// ===== package files =====
// Every file under a location, as relative paths, depth first; a directory deeper than 8 is left out.
function listFiles(location, prefix = "", depth = 0) {
    const ref = ec.resource.getLocationReference(location)
    if (!ref || !ref.getExists() || depth > 8) return []
    const found = []
    for (const entry of ref.getDirectoryEntries()) {
        const name = entry.getFileName()
        const path = prefix + name
        if (entry.isDirectory()) found.push(...listFiles(entry.getLocation(), path + "/", depth + 1))
        else found.push(path)
    }
    return found
}
// A package's files read from a location: {files: {path: text}, skipped: [{path, reason}]}, bounded by packageLimits.
// A file that is not a package text file is skipped and named (failure tolerance); the bounds refuse the package.
function readPackage(location) {
    const files = {}
    const skipped = []
    let bytes = 0
    const paths = listFiles(location).sort()
    if (paths.length > packageLimits.maxFiles)
        refuse("PACKAGE_TOO_LARGE", "A theme holds at most " + packageLimits.maxFiles + " files")
    for (const path of paths) {
        if (!pathPattern.test(path) || !isPackagePath(path)) {
            skipped.push({path, reason: "not a theme text file"})
            ec.logger.error("Theme package " + location + ": skipped " + path + " (not a theme text file)")
            continue
        }
        const content = fileText(location + "/" + path, path) ?? ""
        bytes += content.length
        if (content.length > packageLimits.maxFileBytes)
            refuse("PACKAGE_TOO_LARGE", path + " is over " + packageLimits.maxFileBytes + " bytes")
        if (bytes > packageLimits.maxPackageBytes)
            refuse("PACKAGE_TOO_LARGE", "A theme is at most " + packageLimits.maxPackageBytes + " bytes")
        files[path] = content
    }
    return {files, skipped}
}
// The draft of a theme: each file's text, dbresource version and digest, in path order.
function draftFiles(theme) {
    return asSystem(() => {
        const root = theme.packageRoot
        const {files} = readPackage(root)
        return Object.keys(files)
            .sort()
            .map(path => {
                const change = ec.resource.getLastChange(root + "/" + path)
                return {path, text: files[path], versionName: change?.versionName || null, digest: digestOf(files[path])}
            })
    })
}
// Write files into a theme's draft (path to text; null deletes) and advance its revision. The caller checked the
// permission, the scope and the expected revision. Answers the new revision.
function putDraftFiles(theme, changes, note) {
    asSystem(() => {
        for (const [path, content] of Object.entries(changes)) {
            if (!pathPattern.test(path) || path.split("/").includes("..") || !isPackagePath(path))
                refuse("INVALID_PATH", path + " is not a theme file path")
            const ref = ec.resource.getLocationReference(theme.packageRoot + "/" + path)
            if (content == null) {
                if (ref.getExists()) ref.delete()
            } else {
                if (String(content).length > packageLimits.maxFileBytes)
                    refuse("PACKAGE_TOO_LARGE", path + " is over " + packageLimits.maxFileBytes + " bytes")
                if (isBinaryPath(path)) ref.putBytes(StringUtilities.base64Decode(String(content)), note || null)
                else ref.putText(String(content), note || null)
            }
        }
    })
    const draftRevision = Number(theme.draftRevision || 0) + 1
    call("update#" + THEME, {themeId: theme.themeId, draftRevision})
    return draftRevision
}
// A release's pinned files, each read at its version and checked against its digest: {path: text}. A file whose text no
// longer matches is RELEASE_DAMAGED.
function releaseFiles(release, paths) {
    const theme = one(THEME, {themeId: release.themeId})
    const pinned = rows(RELEASE_FILE, {releaseId: release.releaseId})
    const wanted = paths ? new Set(paths) : null
    const out = {}
    asSystem(() => {
        for (const file of pinned) {
            if (wanted && !wanted.has(file.filePath)) continue
            const content = fileText(theme.packageRoot + "/" + file.filePath, file.filePath, file.versionName)
            if (content == null || digestOf(content) !== file.digest)
                refuse(
                    "RELEASE_DAMAGED",
                    "Release " + release.releaseId + " file " + file.filePath + " does not match its digest"
                )
            out[file.filePath] = content
        }
    })
    return out
}

// ===== validation =====
// The digest of a package for an engine: the files' digests in path order with the engine, renderer and view API.
function packageDigest(entries, engine) {
    const renderer = renderers[engine] || {}
    return digestOf(
        JSON.stringify({
            engine,
            rendererVersion: renderer.rendererVersion || null,
            viewApiVersion,
            files: entries.map(entry => [entry.path, entry.digest])
        })
    )
}
// A synthetic view of each page kind for the representative renders (design-shop §12.5): no store's records.
function sampleView(kind) {
    const price = {amount: "24.00", currencyUomId: "USD", display: "$24.00"}
    const product = id => ({
        id,
        name: "Sample product " + id,
        url: "/shop/products/" + id + "/sample",
        sku: "SKU-" + id,
        description: "A sample product.",
        price,
        availability: {label: "Available", purchasable: true},
        image: null
    })
    const productList = [product("S1"), product("S2")]
    const view = {
        site: {displayName: "Sample store", locale: "en"},
        shop: {name: "Sample store", baseUrl: "/shop", currencyUomId: "USD"},
        locale: "en",
        page: {kind, title: "Sample " + kind, canonicalUrl: "/shop", query: "mug", body: {$richText: "<p>Sample page.</p>"}},
        navigation: [{label: "Home", url: "/shop"}],
        productList
    }
    if (kind === "product") view.product = product("S1")
    if (kind === "category") view.category = {id: "C1", name: "Sample category", url: "/shop/categories/C1/sample"}
    if (["cart", "checkout"].includes(kind)) view.cart = {itemCount: 1, subtotal: price}
    if (["account", "orders", "order", "downloads", "subscriptions"].includes(kind)) view.account = {displayName: "Sample"}
    return view
}
// The trusted components a page kind places: each required component whose kinds include it (the adapter refuses one
// given and not placed, and a required one that fails).
const componentsOf = (kind, make) =>
    Object.fromEntries(
        Object.entries(requiredComponents)
            .filter(([, kinds]) => kinds.includes(kind))
            .map(([name]) => [name, make(name)])
    )
// Validate a package: the adapter's checks (files, schemas, settings, templates, a template for every page kind), the
// required components declared, and a bounded render of each page kind with a sample view, which fails when a page does
// not place its required components.
// {ok, engine, diagnostics}.
function validatePackage(files) {
    const pkg = {files}
    const checked = ec.resource.theme.validate(pkg, {requiredPageKinds: pageKinds, apiVersion: viewApiVersion})
    const diagnostics = Array.from(checked.diagnostics || [])
    const manifest = parsed(files["theme.json"] || "", {}) || {}
    const engine = manifest.engine || checked.engine || ""
    if (!renderers[engine])
        diagnostics.push({
            severity: "error",
            code: "unknown-engine",
            file: "theme.json",
            line: 0,
            message: "engine " + engine + " is not supported"
        })
    const declared = Array.isArray(manifest.requiredComponents) ? manifest.requiredComponents : []
    for (const name of Object.keys(requiredComponents))
        if (!declared.includes(name))
            diagnostics.push({
                severity: "error",
                code: "required-failed",
                file: "theme.json",
                line: 0,
                message: "requiredComponents must name " + name
            })
    if (!diagnostics.some(diagnostic => diagnostic.severity === "error")) {
        for (const kind of pageKinds) {
            let rendered
            try {
                rendered = ec.resource.theme.render(pkg, {
                    pageKind: kind,
                    view: sampleView(kind),
                    components: componentsOf(kind, () => ({html: '<div class="component"></div>'})),
                    assetBase: "/shop/theme/sample",
                    releaseId: "validation",
                    limits: {pageTimeMs: 2000}
                })
            } catch (error) {
                rendered = {ok: false, html: "", diagnostics: [], omitted: [], failedRequired: [String(error.message || error)]}
            }
            for (const diagnostic of rendered.diagnostics || [])
                if (diagnostic.severity === "error") diagnostics.push(Object.assign({}, diagnostic, {pageKind: kind}))
            if (!rendered.ok || !rendered.html)
                diagnostics.push({
                    severity: "error",
                    code: "render-failed",
                    file: "templates/" + kind + ".json",
                    line: 0,
                    pageKind: kind,
                    message:
                        "the " +
                        kind +
                        " page did not render" +
                        ((rendered.failedRequired || []).length ? ": " + rendered.failedRequired.join(", ") : "")
                })
            for (const omitted of rendered.omitted || [])
                diagnostics.push({
                    severity: "warning",
                    code: "render-failed",
                    file: "templates/" + kind + ".json",
                    line: 0,
                    pageKind: kind,
                    section: omitted.section,
                    message: "section " + omitted.section + " was left out: " + omitted.reason
                })
        }
    }
    return {ok: !diagnostics.some(diagnostic => diagnostic.severity === "error"), engine, diagnostics}
}
// The manifest's composition and schemas (design-shop §12.5): per template its layout, section order, and each section's
// type and the approved sources its `source` settings name, so a page assembles its sources in one batch.
function compositionOf(files) {
    const schemas = {}
    for (const path of Object.keys(files))
        if (path.endsWith(".schema.json")) schemas[path.slice(0, -".schema.json".length)] = parsed(files[path], null)
    const composition = {}
    for (const path of Object.keys(files)) {
        if (!path.startsWith("templates/") || !path.endsWith(".json")) continue
        const template = parsed(files[path], null)
        if (!template) continue
        const sections = {}
        for (const [id, section] of Object.entries(template.sections || {})) {
            const schema = schemas["sections/" + (section && section.type)] || {}
            const definitions = Array.isArray(schema.settings) ? schema.settings : []
            const sources = definitions
                .filter(definition => definition && definition.type === "source")
                .map(definition => ((section.settings || {})[definition.id] ?? definition.default) || null)
                .filter(name => typeof name === "string" && name)
            sections[id] = {type: section && section.type, sources}
        }
        composition[path.slice("templates/".length, -".json".length)] = {
            layout: template.layout ?? null,
            order: template.order || Object.keys(sections),
            sections
        }
    }
    return {schemas, composition}
}

// ===== drafts =====
// create#ThemeDraft: a new theme of a store, its draft copied from a starter package (a component's theme/{name}) or
// from a release of the store's. COMMERCE_THEME_EDIT and the store's scope.
function createThemeDraft(p) {
    const s = scopeWith(["COMMERCE_THEME_EDIT"])
    const store = stores.storeOf(s, p.productStoreId)
    let files,
        starterKey = null,
        sourceReleaseId = null
    if (p.releaseId) {
        const release = one(RELEASE, {releaseId: p.releaseId})
        const source = release ? one(THEME, {themeId: release.themeId}) : null
        if (!source || source.productStoreId !== store.productStoreId)
            refuse("RECORD_UNAVAILABLE", "Release " + p.releaseId + " is not available")
        files = releaseFiles(release)
        sourceReleaseId = release.releaseId
    } else {
        const match = starterPattern.exec(text(p.starter))
        if (!match) refuse("STARTER_REQUIRED", "Choose a starter theme (component/name) or a release")
        const location = "component://" + match[1] + "/theme/" + match[2]
        const found = asSystem(() => readPackage(location))
        if (!found.files["theme.json"]) refuse("STARTER_UNAVAILABLE", "Starter " + p.starter + " is not available")
        files = found.files
        starterKey = p.starter
    }
    const manifest = parsed(files["theme.json"] || "", {}) || {}
    const name = text(p.name) || text(manifest.name) || "Theme"
    const created = call("create#" + THEME, {
        productStoreId: store.productStoreId,
        name: name.slice(0, 255),
        engine: manifest.engine || null,
        starterKey,
        sourceReleaseId,
        draftRevision: 0,
        createdByUserId: ec.user.userId,
        createdDate: ec.user.nowTimestamp
    })
    const themeId = created.themeId
    call("update#" + THEME, {themeId, packageRoot: rootOf(themeId)})
    const theme = one(THEME, {themeId})
    const draftRevision = putDraftFiles(theme, files, "Copied from " + (starterKey || "release " + sourceReleaseId))
    return {themeId, name, draftRevision, fileCount: Object.keys(files).length}
}
// get#ThemeDraft: a theme's record and its draft's files (path, version, digest, size; with text when asked), its
// validation and the releases made from it. COMMERCE_VIEW and the store's scope.
function getThemeDraft(p) {
    const s = scopeWith([])
    const theme = themeOf(s, p.themeId)
    const files = draftFiles(theme)
    return {
        theme: {
            themeId: theme.themeId,
            productStoreId: theme.productStoreId,
            name: theme.name,
            engine: theme.engine,
            starterKey: theme.starterKey,
            sourceReleaseId: theme.sourceReleaseId,
            draftRevision: Number(theme.draftRevision || 0)
        },
        files: files.map(file =>
            Object.assign(
                {path: file.path, versionName: file.versionName, digest: file.digest, size: file.text.length},
                p.includeText === true || p.includeText === "true" ? {text: file.text} : {}
            )
        ),
        validation: {
            validationDigest: theme.validationDigest || null,
            validatedRevision: theme.validatedRevision == null ? null : Number(theme.validatedRevision),
            ok: theme.validationOk === "Y",
            current: theme.validationDigest === packageDigest(files, theme.engine)
        },
        releases: Array.from(find(RELEASE, {themeId: theme.themeId}).orderBy("-releaseSeq").limit(50).list()).map(release => ({
            releaseId: release.releaseId,
            releaseSeq: Number(release.releaseSeq),
            createdDate: release.createdDate
        }))
    }
}

// ===== validate, publish, restore =====
// validate#Theme: the draft's validation (validatePackage) and its digest, kept on the theme for publish.
// COMMERCE_THEME_EDIT or COMMERCE_THEME_PUBLISH and the store's scope.
function validateTheme(p) {
    const s = scopeWith(["COMMERCE_THEME_EDIT", "COMMERCE_THEME_PUBLISH"])
    const theme = themeOf(s, p.themeId)
    const entries = draftFiles(theme)
    const files = Object.fromEntries(entries.map(entry => [entry.path, entry.text]))
    const result = validatePackage(files)
    const validationDigest = packageDigest(entries, result.engine)
    call("update#" + THEME, {
        themeId: theme.themeId,
        engine: result.engine || null,
        validationDigest,
        validatedRevision: Number(theme.draftRevision || 0),
        validationOk: result.ok ? "Y" : "N",
        validatedDate: ec.user.nowTimestamp
    })
    return {
        ok: result.ok,
        engine: result.engine,
        validationDigest,
        draftRevision: Number(theme.draftRevision || 0),
        diagnostics: result.diagnostics
    }
}
// The binding of a site's mount, locked, and its revision; a stale expected revision is a Conflict. The site's row is
// locked first, so two first publishes (no binding row to lock yet) are serialized and the later one is REVISION_STALE.
function lockedBinding(siteId, appMountId, expectedActiveRevision) {
    find(SITE, {siteId}).forUpdate(true).one()
    const binding = find(BINDING, {siteId, appMountId}).forUpdate(true).one()
    const revision = binding ? Number(binding.revision || 0) : 0
    if (expectedActiveRevision == null || expectedActiveRevision === "" || Number(expectedActiveRevision) !== revision)
        refuse("REVISION_STALE", "The site's theme changed since you looked; reload and try again", "Conflict")
    return {binding, revision}
}
// Switch a site's mount to a release, advancing the site's generation in the same transaction.
function activate(site, mount, held, release, activation) {
    const locked = find(SITE, {siteId: site.siteId}).forUpdate(true).one()
    const generation = Number(locked.generation || 0) + 1
    call("update#" + SITE, {siteId: site.siteId, generation})
    const values = {
        siteId: site.siteId,
        appMountId: mount.appMountId,
        themeId: release.themeId,
        releaseId: release.releaseId,
        activation,
        revision: held.revision + 1,
        siteGeneration: generation,
        activatedDate: ec.user.nowTimestamp,
        activatedByUserId: ec.user.userId
    }
    call((held.binding ? "update#" : "create#") + BINDING, values)
    return {
        siteId: site.siteId,
        appMountId: mount.appMountId,
        releaseId: release.releaseId,
        revision: values.revision,
        generation
    }
}
// The operation identity of a publish or restore (impl-commerce §2: PostingOperation): a retry with the same key and
// request answers the first result before any gate, and a key used for another request is refused.
const operationOf = (p, type, store, request) => lib.operation(p, type, store.organizationPartyId, request)
function completed(op, activated) {
    lib.complete(op, RELEASE, activated.releaseId, activated)
    return activated
}
// publish#Theme: a release of the theme's current draft on a site's Shop mount. The draft is validated again and must
// match the validation digest the publisher saw (VALIDATION_STALE) and pass (THEME_INVALID); the site's active revision
// must be the one given (REVISION_STALE); then the release is written with its pinned files and manifest, and the
// binding and the site's generation advance together. COMMERCE_THEME_PUBLISH and the store of the theme and the site.
function publishTheme(p) {
    const s = scopeWith(["COMMERCE_THEME_PUBLISH"])
    const theme = themeOf(s, p.themeId, true)
    const {site, mount, store} = shopMountOf(s, p.siteId)
    if (theme.productStoreId !== store.productStoreId)
        refuse(
            "THEME_STORE_MISMATCH",
            "Theme " + theme.themeId + " is not a theme of the store site " + site.siteId + " sells",
            "Unprocessable"
        )
    const op = operationOf(p, "ThemePublish", store, {
        themeId: theme.themeId,
        siteId: site.siteId,
        validationDigest: text(p.validationDigest),
        expectedActiveRevision: Number(p.expectedActiveRevision)
    })
    const again = lib.previous(op)
    if (again) return again
    const entries = draftFiles(theme)
    const files = Object.fromEntries(entries.map(entry => [entry.path, entry.text]))
    const result = validatePackage(files)
    const validationDigest = packageDigest(entries, result.engine)
    if (text(p.validationDigest) !== validationDigest)
        refuse("VALIDATION_STALE", "The theme changed since it was validated; validate it again", "Conflict")
    if (!result.ok)
        refuse(
            "THEME_INVALID",
            "The theme does not validate: " +
                result.diagnostics
                    .filter(diagnostic => diagnostic.severity === "error")
                    .slice(0, 3)
                    .map(diagnostic => diagnostic.file + ":" + diagnostic.line + " " + diagnostic.message)
                    .join("; "),
            "Unprocessable"
        )
    const held = lockedBinding(site.siteId, mount.appMountId, p.expectedActiveRevision)
    const release = makeRelease(theme, entries, files, result.engine, validationDigest)
    const activated = activate(site, mount, held, release, "publish")
    return completed(op, Object.assign(activated, {themeId: theme.themeId, manifestDigest: release.manifestDigest}))
}
// The immutable release of a draft: its pinned files and its manifest with digest.
function makeRelease(theme, entries, files, engine, validationDigest) {
    const last = find(RELEASE, {themeId: theme.themeId}).orderBy("-releaseSeq").limit(1).list()[0]
    const releaseSeq = last ? Number(last.releaseSeq || 0) + 1 : 1
    const renderer = renderers[engine]
    const settings = parsed(files["config/settings.json"] || "", {}) || {}
    const {schemas, composition} = compositionOf(files)
    const created = call("create#" + RELEASE, {
        themeId: theme.themeId,
        releaseSeq,
        name: theme.name,
        engine,
        rendererVersion: renderer.rendererVersion,
        viewApiVersion,
        validationDigest,
        draftRevision: Number(theme.draftRevision || 0),
        createdByUserId: ec.user.userId,
        createdDate: ec.user.nowTimestamp
    })
    const releaseId = created.releaseId
    const fileRows = entries.map(entry => ({
        path: entry.path,
        versionName: entry.versionName,
        digest: entry.digest,
        size: entry.text.length,
        contentType: ec.resource.contentTypeOf(entry.path.split("/").pop()) || "text/plain"
    }))
    for (const file of fileRows)
        call("create#" + RELEASE_FILE, {
            releaseId,
            filePath: file.path,
            versionName: file.versionName,
            digest: file.digest,
            fileSize: file.size,
            contentType: file.contentType
        })
    const manifest = {
        schemaVersion: 1,
        releaseId,
        themeId: theme.themeId,
        releaseSeq,
        name: theme.name,
        engine,
        rendererVersion: renderer.rendererVersion,
        viewApiVersion,
        validationDigest,
        files: fileRows,
        schemas,
        settings,
        defaultTemplates: (parsed(files["theme.json"] || "", {}) || {}).defaultTemplates || {},
        composition
    }
    const manifestText = JSON.stringify(manifest)
    const manifestDigest = digestOf(manifestText)
    call("update#" + RELEASE, {releaseId, manifestText, manifestDigest})
    return {releaseId, themeId: theme.themeId, manifestDigest}
}
// restore#ThemeRelease: make an earlier release of the store's the active one of a site's Shop mount. Its pinned files
// must still match their digests (RELEASE_DAMAGED) and validate on this authority's engine (RELEASE_INVALID); the site's
// active revision must be the one given. Leaves the binding's audit record; the live pages still intersect the current
// publication, so withdrawn products stay withdrawn. COMMERCE_THEME_PUBLISH and the store's scope.
function restoreThemeRelease(p) {
    const s = scopeWith(["COMMERCE_THEME_PUBLISH"])
    const {site, mount, store} = shopMountOf(s, p.siteId)
    const release = p.releaseId ? one(RELEASE, {releaseId: p.releaseId}) : null
    const theme = release ? one(THEME, {themeId: release.themeId}) : null
    if (!theme || theme.productStoreId !== store.productStoreId)
        refuse("RECORD_UNAVAILABLE", "Release " + (p.releaseId || "") + " is not available")
    const op = operationOf(p, "ThemeRestore", store, {
        siteId: site.siteId,
        releaseId: release.releaseId,
        expectedActiveRevision: Number(p.expectedActiveRevision)
    })
    const again = lib.previous(op)
    if (again) return again
    const files = releaseFiles(release)
    const result = validatePackage(files)
    const renderer = renderers[release.engine]
    if (!result.ok || !renderer || !renderer.viewApiVersions.includes(Number(release.viewApiVersion)))
        refuse("RELEASE_INVALID", "Release " + release.releaseId + " does not validate on this renderer", "Unprocessable")
    const held = lockedBinding(site.siteId, mount.appMountId, p.expectedActiveRevision)
    const activated = activate(site, mount, held, release, "restore")
    return completed(op, Object.assign(activated, {themeId: theme.themeId, manifestDigest: release.manifestDigest}))
}
// export#ThemeRelease: a release's manifest (files with versions and digests, schemas, settings, composition, engine,
// renderer and view API versions, validation digest) and, when asked, its files' text. A package holds no secret: it is
// what the storefront renders. COMMERCE_THEME_EDIT or COMMERCE_THEME_PUBLISH and the store's scope.
function exportThemeRelease(p) {
    const s = scopeWith(["COMMERCE_THEME_EDIT", "COMMERCE_THEME_PUBLISH"])
    const release = p.releaseId ? one(RELEASE, {releaseId: p.releaseId}) : null
    if (!release) refuse("RECORD_UNAVAILABLE", "Release " + (p.releaseId || "") + " is not available")
    themeOf(s, release.themeId)
    const out = {releaseId: release.releaseId, manifestDigest: release.manifestDigest, manifest: parsed(release.manifestText, {})}
    if (p.includeFiles === true || p.includeFiles === "true") out.files = releaseFiles(release)
    return out
}

// ===== live reads (the Shop frontend; anonymous, the site from the facade) =====
const shopContext = () => ec.resource.script("component://mr-mantle/service/mantle/product/ShopContext.js")
// The active release of a site's mount: {releaseId, manifestDigest, engine, viewApiVersion, revision}, or null.
function activeRelease(siteId, appMountId) {
    const binding = one(BINDING, {siteId, appMountId})
    const release = binding ? one(RELEASE, {releaseId: binding.releaseId}) : null
    if (!release) return null
    return {
        releaseId: release.releaseId,
        manifestDigest: release.manifestDigest,
        engine: release.engine,
        rendererVersion: Number(release.rendererVersion || 0),
        viewApiVersion: Number(release.viewApiVersion || 0),
        revision: Number(binding.revision || 0)
    }
}
// The active release of a published site's Shop mount, which must be the one asked for (a frontend never reads another).
function liveRelease(p) {
    const {site, mount} = shopContext().shopOf(p.siteId)
    const active = activeRelease(site.siteId, mount.appMountId)
    if (!active || active.releaseId !== text(p.releaseId))
        refuse("RELEASE_NOT_ACTIVE", "This release is not the site's active theme", "NotFound")
    return one(RELEASE, {releaseId: active.releaseId})
}
// getShopThemeRelease: the active release's manifest text and digest, for a frontend to verify and fetch its files.
function getShopThemeRelease(p) {
    const release = liveRelease(p)
    return {releaseId: release.releaseId, manifestDigest: release.manifestDigest, manifestText: release.manifestText}
}
// getShopThemeFiles: files of the active release (at most filesPerRead a call), each with its digest.
function getShopThemeFiles(p) {
    const release = liveRelease(p)
    const paths = (Array.isArray(p.paths) ? p.paths : text(p.paths).split(",")).map(path => text(path)).filter(Boolean)
    if (!paths.length || paths.length > filesPerRead)
        refuse("INVALID_PATHS", "Ask for 1 to " + filesPerRead + " files", "Unprocessable")
    const files = releaseFiles(release, paths)
    const missing = paths.filter(path => files[path] == null)
    if (missing.length) refuse("UNKNOWN_FILE", "The release has no " + missing[0], "NotFound")
    return {releaseId: release.releaseId, files: paths.map(path => ({path, text: files[path], digest: digestOf(files[path])}))}
}
// getSiteGeneration (F43): a published site's generation and its Shop mount's active release, for a frontend to key
// its caches by; nothing personal, so it may be cached.
function getSiteGeneration(p) {
    const site = p.siteId ? one(SITE, {siteId: p.siteId}) : null
    if (!site || site.state !== "published") refuse("NOT_AVAILABLE", "This site is not available", "NotFound")
    const mount = rows(SITE_APP, {siteId: site.siteId, app: "shop", enabled: "Y"})[0]
    const release = mount ? activeRelease(site.siteId, mount.appMountId) : null
    return {
        siteId: site.siteId,
        generation: Number(site.generation || 0),
        release: release ? {releaseId: release.releaseId, manifestDigest: release.manifestDigest} : null
    }
}

const operations = {
    createThemeDraft,
    getThemeDraft,
    validateTheme,
    publishTheme,
    restoreThemeRelease,
    exportThemeRelease,
    getShopThemeRelease,
    getShopThemeFiles,
    getSiteGeneration
}
;({
    // tables and the core for Commerce P5's editors and the Shop page view (ThemeView.js)
    pageKinds,
    // Commerce P5: the package's bounds and paths, the manifest's composition and the representative views
    packageLimits,
    pathPattern,
    isTextPath,
    isBinaryPath,
    isPackagePath,
    compositionOf,
    sampleView,
    rootOf,
    requiredComponents,
    componentsOf,
    renderers,
    viewApiVersion,
    scopeWith,
    themeOf,
    draftFiles,
    putDraftFiles,
    releaseFiles,
    validatePackage,
    packageDigest,
    activeRelease,
    execute: (op, parameters) => {
        if (!operations[op]) throw new Error("Unknown theme operation " + op)
        return operations[op](parameters || {})
    }
})
