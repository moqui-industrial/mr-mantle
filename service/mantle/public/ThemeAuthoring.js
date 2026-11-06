// Theme authoring and preview (impl-commerce P5, COM-THEME; design-commerce §5 Themes, ThemeDetail, ThemeEditor and
// TemplateEditor; design-shop §12.2-§12.6): the staff services Commerce's editors call on Shop P2's records and core
// (Themes.js): the store's themes, an imported package, a draft's identity, composition, settings, assets, translations
// and source files, a page's alternate template, the bindings and history of a theme, and the preview of its draft.
//
// Every save names the draft revision it was read at (expectedRevision; REVISION_STALE otherwise) and goes through
// checkedSave: the package is checked by the composition adapter with the change in it, and a change that makes its own
// file fail (a script, an event handler, an unknown setting, a bad JSON) is refused with that file and line, leaving the
// draft as it was. Validation of the whole draft (with the representative renders), publish and restore stay Shop P2's
// validate#Theme, publish#Theme and restore#ThemeRelease.
//
// Permissions (with COMMERCE_VIEW and the store's scope through StoreAdmin.js, as Themes.js): COMMERCE_VIEW reads;
// COMMERCE_THEME_EDIT edits a draft's identity, composition, settings, assets and translations and assigns a template;
// COMMERCE_THEME_CODE reads and changes source files (templates, sections, blocks, snippets, layouts, schemas), which no
// visual edit needs; a preview is made with either or COMMERCE_THEME_PUBLISH.
//
// A preview (design-shop §12.6, impl-commerce F54) is a PublicThemePreview row: one site's Shop mount, one theme's draft,
// one actor, one page kind and record, for a short time, its token carried in the preview URL on the site's preview host
// (PublicSiteHost PshkPreview) and kept here only as a digest. getThemePreviewPage answers the draft's files and a view of
// the page kind: the store's public data when the site is published (the live view, ThemeView.js), else the sample view;
// private state (cart, account) is always synthetic. Nothing here sends mail, records a visit or touches a cart.
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const themes = ec.resource.script("component://mr-mantle/service/mantle/public/Themes.js")
const stores = ec.resource.script("component://mr-mantle/service/mantle/product/StoreAdmin.js")
const {find, one, rows, call, access} = lib
const P = "mantle.public."
const THEME = P + "PublicTheme"
const RELEASE = P + "PublicThemeRelease"
const RELEASE_FILE = P + "PublicThemeReleaseFile"
const BINDING = P + "PublicThemeBinding"
const PREVIEW = P + "PublicThemePreview"
const SITE = P + "PublicSite"
const SITE_APP = P + "PublicSiteApp"
const SITE_HOST = P + "PublicSiteHost"
const PAGE = P + "PublicSitePage"

// ===== tables =====
const EDIT = ["COMMERCE_THEME_EDIT"]
const CODE = ["COMMERCE_THEME_CODE"]
const PREVIEWERS = ["COMMERCE_THEME_EDIT", "COMMERCE_THEME_CODE", "COMMERCE_THEME_PUBLISH"]
const idPattern = /^[A-Za-z0-9_-]{1,64}$/
const templateNamePattern = /^[a-z0-9-]+(\.[a-z0-9_-]+)?$/
const localePattern = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/
const translationKeyPattern = /^[A-Za-z0-9_.-]{1,100}$/
const maxTranslation = 2000
const previewMinutes = 20
const listLimit = 200
// The source files a theme developer may add (change#ThemeFile): the package's kinds of text file, nothing executable.
const sourceKinds = [
    /^templates\/[a-z0-9-]+(\.[a-z0-9_-]+)?\.json$/,
    /^(sections|blocks)\/[A-Za-z0-9_-]+\.(html\.fancy-locked|schema\.json)$/,
    /^snippets\/[A-Za-z0-9_-]+\.html\.fancy-locked$/,
    /^layouts\/[A-Za-z0-9_-]+\.html\.fancy-locked$/,
    /^locales\/[a-z]{2,3}(-[A-Za-z0-9]{2,8})*\.json$/,
    /^assets\/[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)*\.(css|svg)$/
]
// A package file that may never be removed or renamed.
const fixedFiles = ["theme.json", "config/settings.json", "config/settings.schema.json"]
// The images and fonts an asset upload takes, by the leading bytes their type has (a media signature).
const signatures = {
    png: [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
    jpg: [[0xff, 0xd8, 0xff]],
    jpeg: [[0xff, 0xd8, 0xff]],
    gif: [
        [0x47, 0x49, 0x46, 0x38, 0x37, 0x61],
        [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]
    ],
    webp: [[0x52, 0x49, 0x46, 0x46]],
    woff2: [[0x77, 0x4f, 0x46, 0x32]]
}
// A binary asset's bytes at most (its base64 then fits a package file's bound).
const maxAssetBytes = Math.floor((themes.packageLimits.maxFileBytes * 3) / 4)
// The engines an import may name; another (a Liquid package) is refused as unsupported.
const unsupportedEngines = /liquid|shopify/i

// ===== values =====
const text = value => (value == null ? "" : String(value).trim())
function refuse(code, message, kind) {
    const error = new Error(code + ": " + message)
    error.reason = code
    if (kind) error.moquiErrorKind = kind
    throw error
}
const parsed = (content, fallback = null) => {
    try {
        return JSON.parse(content)
    } catch (error) {
        return fallback
    }
}
const pretty = value => JSON.stringify(value, null, 2) + "\n"
const isTrue = value => value === true || value === "true" || value === "Y"
const digestOf = content => ec.resource.digestText(content, "sha256")
const dateText = value => (value ? ec.l10n.format(value, "yyyy-MM-dd HH:mm") : "")
function userName(userId) {
    if (!userId) return ""
    const account = one("moqui.security.UserAccount", {userId})
    return account?.userFullName || account?.username || userId
}
const asMap = value => (typeof value === "string" ? parsed(value, null) : value)
const kindOfTemplate = name => String(name || "").split(".")[0]

// ===== the draft =====
// A theme in scope with one of the permissions, locked, at the revision the caller read (REVISION_STALE otherwise).
function draftOf(p, permissions) {
    const s = themes.scopeWith(permissions)
    const theme = themes.themeOf(s, p.themeId, true)
    const revision = Number(theme.draftRevision || 0)
    if (p.expectedRevision == null || p.expectedRevision === "" || Number(p.expectedRevision) !== revision)
        refuse("REVISION_STALE", "The draft changed since you opened it (now revision " + revision + "); reload it", "Conflict")
    return {s, theme}
}
// A theme in scope for a read.
function themeFor(p, permissions = []) {
    const s = themes.scopeWith(permissions)
    return {s, theme: themes.themeOf(s, p.themeId)}
}
const filesOf = theme => Object.fromEntries(themes.draftFiles(theme).map(entry => [entry.path, entry.text]))
// The adapter's findings for a package (no representative render: that is validate#Theme's).
function check(files) {
    const checked = ec.resource.theme.validate({files}, {requiredPageKinds: themes.pageKinds, apiVersion: themes.viewApiVersion})
    return Array.from(checked.diagnostics || [])
}
const located = diagnostic => diagnostic.file + ":" + (diagnostic.line || 0) + " " + diagnostic.message
// Write changes (path to text, null removes) into the draft after the adapter checked the package with them: an error
// in a changed file refuses the save (THEME_SOURCE_INVALID, its file and line), the draft unchanged. Answers the new
// revision and the changed files' findings.
function checkedSave(theme, files, changes, note) {
    const next = Object.assign({}, files)
    for (const [path, content] of Object.entries(changes)) {
        if (content == null) delete next[path]
        else next[path] = content
    }
    const changed = new Set(Object.keys(changes))
    const findings = check(next).filter(diagnostic => changed.has(diagnostic.file))
    const errors = findings.filter(diagnostic => diagnostic.severity === "error")
    if (errors.length) refuse("THEME_SOURCE_INVALID", errors.slice(0, 5).map(located).join("; "), "Unprocessable")
    const draftRevision = themes.putDraftFiles(theme, changes, note || null)
    return {draftRevision, diagnostics: findings}
}
const templatePath = name => "templates/" + name + ".json"
const sectionSource = type => "sections/" + type + ".html.fancy-locked"
const sectionSchema = type => "sections/" + type + ".schema.json"
// A theme's templates (names) of the files given.
const templatesIn = files =>
    Object.keys(files)
        .filter(path => path.startsWith("templates/") && path.endsWith(".json"))
        .map(path => path.slice("templates/".length, -".json".length))
        .sort()
// The settings definitions of a schema file's text: {settings: [...]} or groups [{name, settings}].
function definitionsOf(schemaText) {
    const schema = parsed(schemaText || "", null)
    if (!schema) return []
    const list = Array.isArray(schema) ? schema.flatMap(group => (group && group.settings) || []) : schema.settings || []
    return Array.isArray(list) ? list.filter(definition => definition && idPattern.test(String(definition.id || ""))) : []
}
// Whether a section type's source places a trusted component.
const places = (files, type, component) => {
    const source = files[sectionSource(type)] || ""
    return source.includes('components["' + component + '"]') || source.includes("components['" + component + "']")
}
// The required components a template's page kind places (Themes.js requiredComponents), each with its live sections.
function placements(files, template, composition) {
    const kind = kindOfTemplate(template)
    const out = {}
    for (const [component, kinds] of Object.entries(themes.requiredComponents)) {
        if (!kinds.includes(kind)) continue
        out[component] = Object.entries((composition && composition.sections) || {})
            .filter(([, section]) => section && !section.disabled && places(files, section.type, component))
            .map(([id]) => id)
    }
    return out
}

// ===== find, import, identity =====
// find#Themes: the themes of the user's stores (or one store), by name, with the draft's revision and validation state,
// the sites whose Shop mount shows a release of it and its latest release. COMMERCE_VIEW.
function findThemes(p) {
    const s = themes.scopeWith([])
    const storeIds = p.productStoreId
        ? [stores.storeOf(s, p.productStoreId).productStoreId]
        : Array.from(stores.storeQuery(s).selectField("productStoreId").list()).map(row => row.productStoreId)
    if (!storeIds.length) return {themes: []}
    let query = find(THEME).condition("productStoreId", "in", storeIds).orderBy("name").limit(listLimit)
    const term = text(p.term)
    if (term) {
        const factory = ec.entity.conditionFactory
        query = query.condition(
            factory.makeCondition(
                ["themeId", "name"].map(field => factory.makeCondition(field, "like", "%" + term + "%").ignoreCase()),
                "or"
            )
        )
    }
    const list = Array.from(query.list())
    const ids = list.map(theme => theme.themeId)
    const bindings = ids.length ? Array.from(find(BINDING).condition("themeId", "in", ids).list()) : []
    const storeNames = Object.fromEntries(
        Array.from(find("mantle.product.store.ProductStore").condition("productStoreId", "in", storeIds).list()).map(store => [
            store.productStoreId,
            store.storeName || store.productStoreId
        ])
    )
    const out = list.map(theme => {
        const live = bindings.filter(binding => binding.themeId === theme.themeId)
        const latest = find(RELEASE, {themeId: theme.themeId}).orderBy("-releaseSeq").limit(1).list()[0]
        const validated = theme.validatedRevision != null && Number(theme.validatedRevision) === Number(theme.draftRevision || 0)
        const validation = !theme.validationDigest
            ? "unvalidated"
            : !validated
              ? "changed"
              : theme.validationOk === "Y"
                ? "valid"
                : "invalid"
        return {
            themeId: theme.themeId,
            name: theme.name,
            productStoreId: theme.productStoreId,
            storeName: storeNames[theme.productStoreId] || theme.productStoreId,
            engine: theme.engine || "",
            draftRevision: Number(theme.draftRevision || 0),
            validation,
            validationText: {
                unvalidated: "Not validated",
                changed: "Changed since validation",
                valid: "Valid",
                invalid: "Invalid"
            }[validation],
            liveSiteIds: live.map(binding => binding.siteId),
            liveText: live.length
                ? "Live on " + live.map(binding => one(SITE, {siteId: binding.siteId})?.name || binding.siteId).join(", ")
                : "",
            latestReleaseSeq: latest ? Number(latest.releaseSeq) : null,
            latestReleaseDateText: latest ? dateText(latest.createdDate) : ""
        }
    })
    const state = text(p.state)
    return {
        themes:
            state === "live"
                ? out.filter(row => row.liveSiteIds.length)
                : state === "draft"
                  ? out.filter(row => !row.liveSiteIds.length)
                  : out
    }
}
// import#Theme: a new theme of a store whose draft is a package's files (files: path to text, a binary asset's base64;
// or packageFile, a .tar.gz the caller staged and scanned). Draft only: nothing is validated or published. Refused: a
// Liquid or other engine (ENGINE_UNSUPPORTED), a .liquid, script or other file that is not a theme file
// (FILE_KIND_REFUSED), a path outside the package (INVALID_PATH), a package over its bounds (PACKAGE_TOO_LARGE), no
// theme.json (MANIFEST_REQUIRED). COMMERCE_THEME_EDIT and the store's scope.
function importTheme(p) {
    const s = themes.scopeWith(EDIT)
    const store = stores.storeOf(s, p.productStoreId)
    const files = packageOf(p)
    const manifest = parsed(files["theme.json"] || "", null)
    if (!manifest) refuse("MANIFEST_REQUIRED", "A theme package has a theme.json", "Unprocessable")
    const engine = text(manifest.engine)
    if (unsupportedEngines.test(engine) || Object.keys(files).some(path => path.endsWith(".liquid")))
        refuse("ENGINE_UNSUPPORTED", "Liquid themes are not supported; this store renders js-fancy themes", "Unprocessable")
    if (!themes.renderers[engine])
        refuse("ENGINE_UNSUPPORTED", "Engine " + (engine || "(none)") + " is not installed; use js-fancy", "Unprocessable")
    // as every save (checkedSave): an SVG cleaned to the safe set, and a file the adapter finds an error in (a script, an
    // event handler) refuses the import with its file and line, so a draft never holds one
    for (const path of Object.keys(files)) if (path.endsWith(".svg")) files[path] = ec.resource.theme.sanitizeSvg(files[path])
    const errors = check(files).filter(diagnostic => diagnostic.severity === "error" && files[diagnostic.file] != null)
    if (errors.length) refuse("THEME_SOURCE_INVALID", errors.slice(0, 5).map(located).join("; "), "Unprocessable")
    const name = (text(p.name) || text(manifest.name) || "Imported theme").slice(0, 255)
    const created = call("create#" + THEME, {
        productStoreId: store.productStoreId,
        name,
        engine,
        draftRevision: 0,
        createdByUserId: ec.user.userId,
        createdDate: ec.user.nowTimestamp
    })
    const themeId = created.themeId
    call("update#" + THEME, {themeId, packageRoot: themes.rootOf(themeId)})
    const draftRevision = themes.putDraftFiles(one(THEME, {themeId}), files, "Imported")
    return {themeId, name, draftRevision, fileCount: Object.keys(files).length}
}
// The files of an import: the files map, or the archive's (extracted under the runtime's temporary files, then removed).
function packageOf(p) {
    let files = asMap(p.files)
    if (!files && p.packageFile) files = archiveFiles(p.packageFile)
    if (!files || typeof files !== "object" || Array.isArray(files))
        refuse("PACKAGE_REQUIRED", "Give the theme package's files", "Unprocessable")
    const limits = themes.packageLimits
    const paths = Object.keys(files)
    if (paths.length > limits.maxFiles) refuse("PACKAGE_TOO_LARGE", "A theme holds at most " + limits.maxFiles + " files")
    let bytes = 0
    const refused = []
    for (const path of paths) {
        if (!themes.pathPattern.test(path) || path.split("/").includes(".."))
            refuse("INVALID_PATH", path + " is not a path inside the package", "Unprocessable")
        if (!themes.isPackagePath(path)) refused.push(path)
        const content = String(files[path] ?? "")
        bytes += content.length
        if (content.length > limits.maxFileBytes) refuse("PACKAGE_TOO_LARGE", path + " is over " + limits.maxFileBytes + " bytes")
    }
    if (bytes > limits.maxPackageBytes) refuse("PACKAGE_TOO_LARGE", "A theme is at most " + limits.maxPackageBytes + " bytes")
    if (refused.some(path => path.endsWith(".liquid")))
        refuse("ENGINE_UNSUPPORTED", "Liquid themes are not supported; this store renders js-fancy themes", "Unprocessable")
    if (refused.length)
        refuse(
            "FILE_KIND_REFUSED",
            "Not a theme file (no scripts, install steps or other executable files): " + refused.slice(0, 5).join(", "),
            "Unprocessable"
        )
    // each image or font the package carries is checked as an upload is: its type's leading bytes, its size, the scanner
    for (const path of paths.filter(themes.isBinaryPath)) assetBytes({contentBase64: String(files[path] ?? "")}, path)
    return Object.fromEntries(paths.map(path => [path, String(files[path] ?? "")]))
}
// A staged .tar.gz's files: extracted with bounds into a temporary directory, read as the package, then removed.
function archiveFiles(location) {
    const target = "runtime://tmp/theme-import/" + ec.user.randomString(24)
    try {
        const extracted = ec.resource.extractArchive(String(location), target, {
            maxBytes: themes.packageLimits.maxPackageBytes,
            maxEntries: themes.packageLimits.maxFiles
        })
        const files = {}
        const refused = []
        for (const entry of extracted.entries || []) {
            const path = String(entry.path).replace(/^\.?\//, "")
            if (!themes.isPackagePath(path)) {
                refused.push(path)
                continue
            }
            const ref = ec.resource.getLocationReference(target + "/" + path)
            files[path] = themes.isBinaryPath(path)
                ? StringUtilities.base64Encode(ref.openStream().readAllBytes())
                : ref.getText()
        }
        for (const path of refused) files[path] = ""
        return files
    } finally {
        try {
            ec.resource.getLocationReference(target).delete()
        } catch (error) {
            ec.logger.warn("Theme import files at " + target + " were not removed")
        }
    }
}
// store#ThemeDraft: a draft's name and description (ThemeIdentity; its engine stays the package's).
function storeThemeDraft(p) {
    const {theme} = draftOf(p, EDIT)
    const name = text(p.name)
    if (!name) refuse("VALUE_INVALID", "A theme has a name")
    call("update#" + THEME, {
        themeId: theme.themeId,
        name: name.slice(0, 255),
        description: text(p.description).slice(0, 255) || null
    })
    return {themeId: theme.themeId, draftRevision: Number(theme.draftRevision || 0)}
}

// ===== composition and settings =====
// get#ThemeComposition: what ThemeEditor shows of a draft: its templates with their sections in order (type, name,
// settings, blocks, disabled, the required components each places), the section types and block types with their
// settings schemas, the global settings with their schema, the page kinds, and the draft's revision. COMMERCE_VIEW.
function getThemeComposition(p) {
    const {theme} = themeFor(p)
    const files = filesOf(theme)
    const schemaOf = path => parsed(files[path] || "", null) || {}
    const sectionTypes = Object.keys(files)
        .filter(path => path.startsWith("sections/") && path.endsWith(".html.fancy-locked"))
        .map(path => path.slice("sections/".length, -".html.fancy-locked".length))
        .sort()
        .map(type => {
            const schema = schemaOf(sectionSchema(type))
            return {
                type,
                name: schema.name || type,
                settings: definitionsOf(files[sectionSchema(type)]),
                blocks: Array.isArray(schema.blocks) ? schema.blocks : [],
                allowedPageKinds: Array.isArray(schema.allowedPageKinds) ? schema.allowedPageKinds : null,
                places: Object.keys(themes.requiredComponents).filter(component => places(files, type, component))
            }
        })
    const blockTypes = Object.keys(files)
        .filter(path => path.startsWith("blocks/") && path.endsWith(".html.fancy-locked"))
        .map(path => path.slice("blocks/".length, -".html.fancy-locked".length))
        .sort()
        .map(type => ({
            type,
            name: schemaOf("blocks/" + type + ".schema.json").name || type,
            settings: definitionsOf(files["blocks/" + type + ".schema.json"])
        }))
    const templates = templatesIn(files).map(name => {
        const template = parsed(files[templatePath(name)] || "", {}) || {}
        const sections = template.sections || {}
        const order = Array.isArray(template.order) ? template.order : Object.keys(sections)
        return {
            name,
            pageKind: kindOfTemplate(name),
            layout: template.layout ?? null,
            sections: order
                .filter(id => sections[id])
                .map(id => ({
                    id,
                    type: sections[id].type,
                    settings: sections[id].settings || {},
                    blocks: sections[id].blocks || {},
                    blockOrder: sections[id].blockOrder || Object.keys(sections[id].blocks || {}),
                    disabled: !!sections[id].disabled,
                    required: !!sections[id].required
                })),
            requiredComponents: placements(files, name, {sections})
        }
    })
    return {
        theme: {
            themeId: theme.themeId,
            name: theme.name,
            description: theme.description || "",
            productStoreId: theme.productStoreId,
            engine: theme.engine || ""
        },
        draftRevision: Number(theme.draftRevision || 0),
        pageKinds: themes.pageKinds,
        templates,
        sectionTypes,
        blockTypes,
        globalSettings: {
            definitions: definitionsOf(files["config/settings.schema.json"]),
            values: parsed(files["config/settings.json"] || "", {}) || {}
        }
    }
}
// store#ThemeComposition: a template's sections and their order (Composition): the composition given replaces the
// template's (layout kept). Each section id and block id is stable (letters, digits, - and _), each section's type a
// section of the draft (UNKNOWN_SECTION), an existing id keeps its type (SECTION_TYPE_CHANGED), order names each section
// once (ORDER_INVALID), and a required component the template placed stays placed (REQUIRED_COMPONENT: a theme cannot
// remove purchase, cart or checkout). COMMERCE_THEME_EDIT and the draft revision.
function storeThemeComposition(p) {
    const {theme} = draftOf(p, EDIT)
    const files = filesOf(theme)
    const name = text(p.template)
    if (!templateNamePattern.test(name) || files[templatePath(name)] == null)
        refuse("RECORD_UNAVAILABLE", "Template " + name + " is not in the draft")
    const old = parsed(files[templatePath(name)], {}) || {}
    const given = asMap(p.composition) || {}
    const sections = given.sections && typeof given.sections === "object" ? given.sections : {}
    const order = Array.isArray(given.order) ? given.order.map(String) : Object.keys(sections)
    const next = {sections: {}, order}
    for (const [id, section] of Object.entries(sections)) {
        if (!idPattern.test(id)) refuse("VALUE_INVALID", "A section id has letters, digits, - and _: " + id)
        const type = text(section && section.type)
        if (!idPattern.test(type) || files[sectionSource(type)] == null)
            refuse("UNKNOWN_SECTION", "The draft has no section " + (type || "(none)"), "Unprocessable")
        const before = (old.sections || {})[id]
        if (before && before.type !== type)
            refuse(
                "SECTION_TYPE_CHANGED",
                "Section " + id + " is a " + before.type + "; add a new section instead",
                "Unprocessable"
            )
        const kept = {type}
        if (section.settings && typeof section.settings === "object") kept.settings = section.settings
        if (section.blocks && typeof section.blocks === "object") {
            for (const blockId of Object.keys(section.blocks))
                if (!idPattern.test(blockId)) refuse("VALUE_INVALID", "A block id has letters, digits, - and _: " + blockId)
            kept.blocks = section.blocks
            kept.blockOrder = Array.isArray(section.blockOrder) ? section.blockOrder.map(String) : Object.keys(section.blocks)
        }
        if (isTrue(section.disabled)) kept.disabled = true
        if (before && before.required) kept.required = true
        next.sections[id] = kept
    }
    const ids = Object.keys(next.sections)
    if (order.length !== ids.length || new Set(order).size !== order.length || order.some(id => !next.sections[id]))
        refuse("ORDER_INVALID", "The order names each section of the template once", "Unprocessable")
    for (const [id, section] of Object.entries(old.sections || {}))
        if (section && section.required && (!next.sections[id] || next.sections[id].disabled))
            refuse(
                "REQUIRED_COMPONENT",
                "Section " + id + " is required on this page and cannot be removed or hidden",
                "Unprocessable"
            )
    const before = placements(files, name, old)
    const after = placements(files, name, next)
    for (const [component, ids] of Object.entries(before))
        if (ids.length && !(after[component] || []).length)
            refuse(
                "REQUIRED_COMPONENT",
                "The " +
                    component +
                    " component (in " +
                    ids.join(", ") +
                    ") cannot be removed from the " +
                    kindOfTemplate(name) +
                    " page",
                "Unprocessable"
            )
    if (old.layout !== undefined) next.layout = old.layout
    const saved = checkedSave(theme, files, {[templatePath(name)]: pretty(next)}, text(p.versionNote) || "Composition of " + name)
    return Object.assign({template: name}, saved)
}
// store#ThemeSettings: values of the global settings (no template: config/settings.json) or of one section of a template
// (SectionSettings; template and sectionId) or of one of its blocks (blockId): each setting named must be in the schema
// (UNKNOWN_SETTING); a null value removes it, so the schema's default applies; the adapter checks the values' types.
// COMMERCE_THEME_EDIT and the draft revision.
function storeThemeSettings(p) {
    const {theme} = draftOf(p, EDIT)
    const files = filesOf(theme)
    const values = asMap(p.settings)
    if (!values || typeof values !== "object" || Array.isArray(values)) refuse("VALUE_INVALID", "Give the settings to save")
    const merge = (current, definitions) => {
        const allowed = new Set(definitions.map(definition => definition.id))
        const out = Object.assign({}, current || {})
        for (const [id, value] of Object.entries(values)) {
            if (!allowed.has(id)) refuse("UNKNOWN_SETTING", "The schema has no setting " + id, "Unprocessable")
            if (value == null) delete out[id]
            else out[id] = value
        }
        return out
    }
    const name = text(p.template)
    if (!name) {
        const settings = merge(
            parsed(files["config/settings.json"] || "", {}),
            definitionsOf(files["config/settings.schema.json"])
        )
        return checkedSave(theme, files, {"config/settings.json": pretty(settings)}, "Theme settings")
    }
    if (!templateNamePattern.test(name) || files[templatePath(name)] == null)
        refuse("RECORD_UNAVAILABLE", "Template " + name + " is not in the draft")
    const template = parsed(files[templatePath(name)], {}) || {}
    const section = (template.sections || {})[text(p.sectionId)]
    if (!section) refuse("RECORD_UNAVAILABLE", "Template " + name + " has no section " + text(p.sectionId))
    const blockId = text(p.blockId)
    if (blockId) {
        const block = (section.blocks || {})[blockId]
        if (!block) refuse("RECORD_UNAVAILABLE", "Section " + p.sectionId + " has no block " + blockId)
        block.settings = merge(block.settings, definitionsOf(files["blocks/" + block.type + ".schema.json"]))
    } else section.settings = merge(section.settings, definitionsOf(files[sectionSchema(section.type)]))
    const saved = checkedSave(theme, files, {[templatePath(name)]: pretty(template)}, "Settings of " + name + " " + p.sectionId)
    return Object.assign({template: name}, saved)
}

// ===== assets =====
// get#ThemeAssets: the draft's assets/ files (ThemeAssets): path, media type, size, digest and the files that name it.
// COMMERCE_VIEW.
function getThemeAssets(p) {
    const {theme} = themeFor(p)
    const entries = themes.draftFiles(theme)
    const sources = entries.filter(entry => !entry.path.startsWith("assets/") || themes.isTextPath(entry.path))
    const assets = entries
        .filter(entry => entry.path.startsWith("assets/"))
        .map(entry => {
            const binary = themes.isBinaryPath(entry.path)
            const name = entry.path.slice("assets/".length)
            return {
                path: entry.path,
                contentType: ec.resource.contentTypeOf(entry.path.split("/").pop()) || "application/octet-stream",
                size: binary ? Math.floor((entry.text.length * 3) / 4) : entry.text.length,
                digest: entry.digest,
                binary,
                references: sources
                    .filter(
                        source => source.path !== entry.path && (source.text.includes(entry.path) || source.text.includes(name))
                    )
                    .map(source => source.path)
            }
        })
    return {assets, draftRevision: Number(theme.draftRevision || 0)}
}
// store#ThemeAsset: a draft asset added or replaced (UploadAsset) at a path under assets/: a stylesheet or SVG as text
// (an SVG cleaned to the safe set, a stylesheet checked by the adapter), or an image or font as bytes (assetFile, an
// uploaded file, or contentBase64) whose leading bytes are its type's (ASSET_TYPE_MISMATCH), at most maxAssetBytes,
// clean by pass_scanner_service (SCANNER_UNAVAILABLE without one; ASSET_REFUSED when it is not clean).
// COMMERCE_THEME_EDIT and the draft revision.
function storeThemeAsset(p) {
    const {theme} = draftOf(p, EDIT)
    const files = filesOf(theme)
    const relative = text(p.path).replace(/^assets\//, "")
    const path = "assets/" + relative
    if (!relative || !themes.pathPattern.test(path) || !themes.isPackagePath(path))
        refuse("INVALID_PATH", "An asset is a .css, .svg, .png, .jpg, .gif, .webp or .woff2 file under assets/", "Unprocessable")
    let content
    if (themes.isBinaryPath(path)) content = assetBytes(p, path)
    else {
        content =
            p.text != null ? String(p.text) : p.assetFile ? String(p.assetFile.getString ? p.assetFile.getString() : "") : null
        if (content == null || !content.length) refuse("VALUE_INVALID", "Give the asset's text or file", "Unprocessable")
        if (path.endsWith(".svg")) content = ec.resource.theme.sanitizeSvg(content)
    }
    const saved = checkedSave(theme, files, {[path]: content}, (files[path] == null ? "Added " : "Replaced ") + path)
    return Object.assign({path, replaced: files[path] != null}, saved)
}
// An image's or font's bytes as base64, checked: its size, its leading bytes and the scanner.
function assetBytes(p, path) {
    const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase()
    let base64 = text(p.contentBase64)
    if (!base64 && p.assetFile) base64 = StringUtilities.base64Encode(p.assetFile.getInputStream().readAllBytes())
    if (!base64) refuse("VALUE_INVALID", "Choose the file to upload", "Unprocessable")
    let bytes
    try {
        bytes = StringUtilities.base64Decode(base64)
    } catch (error) {
        refuse("VALUE_INVALID", "The file could not be read", "Unprocessable")
    }
    if (!bytes.length || bytes.length > maxAssetBytes)
        refuse("ASSET_TOO_LARGE", "An image or font is at most " + Math.floor(maxAssetBytes / 1024) + " KB", "Unprocessable")
    const head = Array.from(bytes.slice(0, 12)).map(b => b & 0xff)
    const matches = (signatures[extension] || []).some(signature => signature.every((b, i) => head[i] === b))
    const webp = extension !== "webp" || String.fromCharCode(...head.slice(8, 12)) === "WEBP"
    if (!matches || !webp)
        refuse("ASSET_TYPE_MISMATCH", "The file is not the ." + extension + " file its name says", "Unprocessable")
    const scanner = System.getProperty("pass_scanner_service")
    if (!scanner) refuse("SCANNER_UNAVAILABLE", "Images cannot be received now (no scanner is configured)", "Unavailable")
    const staged = "runtime://tmp/theme-assets/" + ec.user.randomString(32) + "." + extension
    try {
        ec.resource.getLocationReference(staged).putBytes(bytes)
        let clean = false
        try {
            clean =
                ec.service
                    .sync()
                    .throwOnError(true)
                    .name(scanner)
                    .parameters({location: staged, mimeType: ec.resource.contentTypeOf(path.split("/").pop())})
                    .call().clean === true
        } catch (error) {
            ec.message.clearErrors()
            ec.logger.error("Theme asset " + path + " could not be scanned; refused")
        }
        if (!clean) refuse("ASSET_REFUSED", "The file could not be accepted; upload another copy", "Unprocessable")
    } finally {
        try {
            ec.resource.getLocationReference(staged).delete()
        } catch (error) {
            ec.logger.warn("Staged theme asset " + staged + " was not removed")
        }
    }
    return base64
}

// ===== translations =====
// get#ThemeTranslations: the draft's texts by locale (locales/<locale>.json) and key (Translations): each key of any
// locale with the chosen locale's text and, when it has none, the default locale's as the fallback. COMMERCE_VIEW.
function getThemeTranslations(p) {
    const {theme} = themeFor(p)
    const files = filesOf(theme)
    const locales = Object.keys(files)
        .filter(path => /^locales\/[^/]+\.json$/.test(path))
        .map(path => path.slice("locales/".length, -".json".length))
        .sort()
    const texts = Object.fromEntries(locales.map(locale => [locale, parsed(files["locales/" + locale + ".json"], {}) || {}]))
    const fallbackLocale = locales.includes("en") ? "en" : locales[0] || null
    const locale = text(p.locale) || fallbackLocale
    const keys = Array.from(new Set(Object.values(texts).flatMap(map => Object.keys(map)))).sort()
    const fallback = fallbackLocale ? texts[fallbackLocale] : {}
    return {
        locales,
        locale,
        fallbackLocale,
        draftRevision: Number(theme.draftRevision || 0),
        entries: keys.map(key => {
            const own = locale && texts[locale] ? texts[locale][key] : undefined
            return {key, text: own ?? "", fallbackText: fallback[key] ?? "", usesFallback: own == null}
        })
    }
}
// store#ThemeTranslations: a locale's texts by key (a null or empty text removes the key, so the fallback shows); a new
// locale makes its file. Keys and locales are checked; no source permission is needed. COMMERCE_THEME_EDIT.
function storeThemeTranslations(p) {
    const {theme} = draftOf(p, EDIT)
    const files = filesOf(theme)
    const locale = text(p.locale)
    if (!localePattern.test(locale)) refuse("VALUE_INVALID", "A locale is a language tag such as en or fr-CA", "Unprocessable")
    const entries = asMap(p.entries)
    if (!entries || typeof entries !== "object" || Array.isArray(entries)) refuse("VALUE_INVALID", "Give the texts to save")
    const path = "locales/" + locale + ".json"
    const current = parsed(files[path] || "", {}) || {}
    for (const [key, value] of Object.entries(entries)) {
        if (!translationKeyPattern.test(key)) refuse("VALUE_INVALID", "A text key has letters, digits, . _ and -: " + key)
        if (value == null || String(value) === "") delete current[key]
        else if (String(value).length > maxTranslation)
            refuse("VALUE_INVALID", "A text is at most " + maxTranslation + " characters")
        else current[key] = String(value)
    }
    const sorted = Object.fromEntries(
        Object.keys(current)
            .sort()
            .map(key => [key, current[key]])
    )
    return Object.assign({locale}, checkedSave(theme, files, {[path]: pretty(sorted)}, "Translations " + locale))
}

// ===== templates and source files =====
// The template names of a site's Shop pages (impl-commerce F77): the active release's and every draft of the store's
// themes. A page's template key must name one of them (SitePages.js store#SitePage) or the page kind's default serves.
function knownTemplates(siteId, appMountId, productStoreId) {
    const names = new Set()
    const active = siteId && appMountId ? themes.activeRelease(siteId, appMountId) : null
    if (active) {
        const release = one(RELEASE, {releaseId: active.releaseId})
        for (const name of Object.keys((parsed(release?.manifestText || "", {}) || {}).composition || {})) names.add(name)
    }
    if (productStoreId)
        for (const theme of rows(THEME, {productStoreId})) {
            const ref = theme.packageRoot ? ec.resource.getLocationReference(theme.packageRoot + "/templates") : null
            if (!ref || !ref.getExists()) continue
            for (const entry of ref.getDirectoryEntries()) {
                const fileName = entry.getFileName()
                if (fileName.endsWith(".json")) names.add(fileName.slice(0, -".json".length))
            }
        }
    return names
}
// assign#ThemeTemplate: an alternate template for a page (targetKind page, sitePageId: through store#SitePage, so a
// published page's change needs COMMERCE_PUBLISH and its revision as P4 has it) or a published product (targetKind
// product, productId: through store#StoreProduct, COMMERCE_MERCHANDISE): the key must be a template of the target's kind
// in the theme's draft (TEMPLATE_UNKNOWN); an empty key goes back to the page kind's default. COMMERCE_THEME_EDIT.
function assignThemeTemplate(p) {
    const {s, theme} = themeFor(p, EDIT)
    const files = filesOf(theme)
    const kind = text(p.targetKind)
    if (!["page", "product"].includes(kind)) refuse("VALUE_INVALID", "Choose a page or a product")
    const key = text(p.templateKey)
    if (key && (kindOfTemplate(key) !== kind || files[templatePath(key)] == null))
        refuse("TEMPLATE_UNKNOWN", "The theme has no " + kind + " template " + key, "Unprocessable")
    if (kind === "page") {
        const page = one(PAGE, {sitePageId: text(p.sitePageId)})
        const mount = page ? one(SITE_APP, {siteId: page.siteId, appMountId: page.appMountId}) : null
        if (!page || !mount || mount.targetId !== theme.productStoreId)
            refuse("RECORD_UNAVAILABLE", "Page " + text(p.sitePageId) + " is not available")
        const out = call(P + "ThemeServices.store#SitePage", {
            sitePageId: page.sitePageId,
            templateKey: key,
            expectedRevision: p.expectedRevision,
            changeReason: text(p.changeReason) || "Template " + (key || "default")
        })
        return {
            targetKind: kind,
            targetId: page.sitePageId,
            templateKey: key || null,
            publicationRevision: out.publicationRevision ?? null
        }
    }
    stores.storeOf(s, theme.productStoreId)
    call("mantle.product.StoreMerchandisingServices.store#StoreProduct", {
        productStoreId: theme.productStoreId,
        productId: text(p.productId),
        templateKey: key,
        changeReason: text(p.changeReason) || "Template " + (key || "default")
    })
    return {targetKind: kind, targetId: text(p.productId), templateKey: key || null}
}
// get#ThemeFile: one source file of the draft (Source, FileSchema) with its version and digest, the adapter's findings of
// it, and its schema's path for a section or block. COMMERCE_THEME_CODE.
function getThemeFile(p) {
    const {theme} = themeFor(p, CODE)
    const entries = themes.draftFiles(theme)
    const path = text(p.path)
    const entry = entries.find(file => file.path === path)
    if (!entry) refuse("RECORD_UNAVAILABLE", "The draft has no " + path)
    const binary = themes.isBinaryPath(path)
    const files = Object.fromEntries(entries.map(file => [file.path, file.text]))
    const schemaPath = /^(sections|blocks)\/[^/]+\.html\.fancy-locked$/.test(path)
        ? path.replace(/\.html\.fancy-locked$/, ".schema.json")
        : null
    return {
        path,
        text: binary ? null : entry.text,
        binary,
        versionName: entry.versionName,
        digest: entry.digest,
        draftRevision: Number(theme.draftRevision || 0),
        schemaPath: schemaPath && files[schemaPath] != null ? schemaPath : null,
        diagnostics: binary ? [] : check(files).filter(diagnostic => diagnostic.file === path)
    }
}
// store#ThemeFile: a source file's new text (Source, FileSchema): the file must be in the draft (add one with
// change#ThemeFile), a text file, and pass the adapter's checks of its own markup, expressions and JSON
// (THEME_SOURCE_INVALID with file and line: a <script>, an onclick, an ec name are refused). COMMERCE_THEME_CODE and the
// draft revision; a baseDigest other than the file's current one is REVISION_STALE.
function storeThemeFile(p) {
    const {theme} = draftOf(p, CODE)
    const files = filesOf(theme)
    const path = text(p.path)
    if (files[path] == null) refuse("RECORD_UNAVAILABLE", "The draft has no " + path + "; add it first")
    if (themes.isBinaryPath(path))
        refuse("FILE_KIND_REFUSED", path + " is an image or font; upload it as an asset", "Unprocessable")
    if (text(p.baseDigest) && text(p.baseDigest) !== digestOf(files[path]))
        refuse("REVISION_STALE", path + " changed since you opened it; reload it", "Conflict")
    if (p.text == null) refuse("VALUE_INVALID", "Give the file's text", "Unprocessable")
    const saved = checkedSave(theme, files, {[path]: String(p.text)}, text(p.versionNote) || "Edited " + path)
    return Object.assign({path, digest: digestOf(String(p.text))}, saved)
}
// The files that name a file: the templates of a section type, the files including a snippet, a block type's sections and
// templates, an asset's or a layout's users.
function dependentsOf(files, path) {
    const others = Object.keys(files).filter(other => other !== path && !themes.isBinaryPath(other))
    const base = path
        .split("/")
        .pop()
        .replace(/\.(html\.fancy-locked|schema\.json|json|css|svg)$/, "")
    const json = other => parsed(files[other] || "", null)
    if (path.startsWith("sections/"))
        return others.filter(
            other =>
                other.startsWith("templates/") &&
                Object.values((json(other) || {}).sections || {}).some(section => section && section.type === base)
        )
    if (path.startsWith("snippets/"))
        return others.filter(other => new RegExp("<#include\\s+[\"']" + base + "[\"']").test(files[other] || ""))
    if (path.startsWith("blocks/"))
        return others.filter(
            other =>
                (files[other] || "").includes('"type": "' + base + '"') || (files[other] || "").includes('"type":"' + base + '"')
        )
    if (path.startsWith("layouts/"))
        return others.filter(other => {
            const value = json(other)
            return (other === "theme.json" || other.startsWith("templates/")) && value && value.layout === base
        })
    if (path.startsWith("assets/"))
        return others.filter(
            other => (files[other] || "").includes(path) || (files[other] || "").includes(path.slice("assets/".length))
        )
    return []
}
// change#ThemeFile: add, rename or remove a draft source file (FileOperation). A new file is one of the package's kinds of
// text file (FILE_KIND_REFUSED: no scripts, Liquid or other kinds) at a free path (FILE_EXISTS) and passes the adapter's
// checks; theme.json and the settings files stay (FILE_REQUIRED), as do the page kinds' templates (TEMPLATE_REQUIRED) and a
// section that places a required component on its page (REQUIRED_COMPONENT); a file other files name is renamed or removed
// only with confirmDependents (HAS_DEPENDENTS names them). The active release is never changed. COMMERCE_THEME_CODE, the
// draft revision and a reason.
function changeThemeFile(p) {
    const {theme} = draftOf(p, CODE)
    const files = filesOf(theme)
    const operation = text(p.operation)
    const path = text(p.path)
    const why = text(p.changeReason)
    if (!why) refuse("REASON_REQUIRED", "Give a reason for the change")
    const kindAllowed = target => sourceKinds.some(pattern => pattern.test(target))
    if (operation === "add") {
        if (!kindAllowed(path))
            refuse(
                "FILE_KIND_REFUSED",
                path + " is not a kind of theme file you can add (no scripts or other files)",
                "Unprocessable"
            )
        if (files[path] != null) refuse("FILE_EXISTS", "The draft has " + path + " already", "Conflict")
        const content = p.text != null && String(p.text).length ? String(p.text) : path.endsWith(".json") ? "{}\n" : "\n"
        return Object.assign({operation, path}, checkedSave(theme, files, {[path]: content}, why))
    }
    if (!["rename", "remove"].includes(operation)) refuse("VALUE_INVALID", "Choose add, rename or remove")
    if (files[path] == null) refuse("RECORD_UNAVAILABLE", "The draft has no " + path)
    if (fixedFiles.includes(path)) refuse("FILE_REQUIRED", path + " is part of every theme", "Unprocessable")
    if (path.startsWith("templates/") && themes.pageKinds.includes(path.slice("templates/".length, -".json".length)))
        refuse(
            "TEMPLATE_REQUIRED",
            "The " + path.slice("templates/".length, -".json".length) + " page needs its template",
            "Unprocessable"
        )
    if (path.startsWith("sections/") && path.endsWith(".html.fancy-locked")) {
        const type = path.slice("sections/".length, -".html.fancy-locked".length)
        for (const name of templatesIn(files)) {
            const template = parsed(files[templatePath(name)], {}) || {}
            const placed = placements(files, name, template)
            for (const [component, ids] of Object.entries(placed))
                if (ids.some(id => template.sections[id].type === type))
                    refuse(
                        "REQUIRED_COMPONENT",
                        path + " places " + component + " on the " + kindOfTemplate(name) + " page",
                        "Unprocessable"
                    )
        }
    }
    const dependents = dependentsOf(files, path)
    if (dependents.length && !isTrue(p.confirmDependents))
        refuse("HAS_DEPENDENTS", path + " is named by " + dependents.join(", ") + "; confirm to go on", "Conflict")
    const changes = {[path]: null}
    let toPath = null
    if (operation === "rename") {
        toPath = text(p.toPath)
        if (!kindAllowed(toPath)) refuse("FILE_KIND_REFUSED", toPath + " is not a kind of theme file", "Unprocessable")
        if (files[toPath] != null) refuse("FILE_EXISTS", "The draft has " + toPath + " already", "Conflict")
        changes[toPath] = files[path]
    }
    return Object.assign({operation, path, toPath, dependents}, checkedSave(theme, files, changes, why))
}

// ===== bindings and history =====
// get#ThemeBindings: where a theme is used (Bindings): each site whose Shop mount sells the theme's store, with its active
// release (whether it is this theme's), and the pages and products of the store with an alternate template, each said to
// be in the draft or not. COMMERCE_VIEW.
function getThemeBindings(p) {
    const {theme} = themeFor(p)
    const templates = new Set(templatesIn(filesOf(theme)))
    const mounts = stores.shopMounts([theme.productStoreId])[theme.productStoreId] || []
    const sites = mounts.map(mount => {
        const site = one(SITE, {siteId: mount.siteId})
        const active = themes.activeRelease(mount.siteId, mount.appMountId)
        const release = active ? one(RELEASE, {releaseId: active.releaseId}) : null
        return {
            siteId: mount.siteId,
            siteName: site?.name || mount.siteId,
            appMountId: mount.appMountId,
            pathPrefix: mount.pathPrefix,
            activeReleaseId: active?.releaseId || null,
            activeRevision: active ? active.revision : 0,
            activeThemeId: release?.themeId || null,
            thisTheme: release?.themeId === theme.themeId,
            activeText: !release
                ? "No published theme"
                : (release.themeId === theme.themeId
                      ? "This theme, release "
                      : (release.name || release.themeId) + ", release ") + release.releaseSeq,
            previewHost:
                rows(SITE_HOST, {siteId: mount.siteId}).find(host => host.hostKindEnumId === "PshkPreview")?.hostname || null
        }
    })
    const resources = []
    for (const site of sites) {
        for (const page of Array.from(
            find(PAGE, {siteId: site.siteId}).condition("templateKey", "is-not-null").limit(listLimit).list()
        ))
            resources.push({
                siteId: site.siteId,
                siteName: site.siteName,
                pageKind: "page",
                resourceId: page.sitePageId,
                resourceText: (page.title || page.routePath) + " (" + (page.routePath || "") + ")",
                templateKey: page.templateKey,
                inDraft: templates.has(page.templateKey)
            })
    }
    const now = ec.user.nowTimestamp
    const products = Array.from(
        find("mantle.product.store.ProductStoreProduct", {productStoreId: theme.productStoreId})
            .condition("templateKey", "is-not-null")
            .condition("fromDate", "less-equals", now)
            .limit(listLimit)
            .list()
    ).filter(row => lib.active(row, now))
    for (const row of products)
        resources.push({
            siteId: null,
            siteName: "",
            pageKind: "product",
            resourceId: row.productId,
            resourceText:
                (one("mantle.product.Product", {productId: row.productId})?.productName || row.productId) +
                " (" +
                row.productId +
                ")",
            templateKey: row.templateKey,
            inDraft: templates.has(row.templateKey)
        })
    return {sites, resources: resources.slice(0, listLimit)}
}
// get#ThemeHistory: a theme's releases (Releases: sequence, author, date, manifest and validation digests, the release
// before it, the sites it is active on) and the activations of its store's sites (the binding's audit log); with a path,
// the file's draft versions and, for RevisionDiff, the text of a release's pinned version (the latest release's when none
// is named) beside the draft's, with their line diff. COMMERCE_VIEW; a source file's text needs COMMERCE_THEME_CODE.
function getThemeHistory(p) {
    const {theme} = themeFor(p)
    const releases = Array.from(find(RELEASE, {themeId: theme.themeId}).orderBy("-releaseSeq").limit(50).list())
    const bindings = rows(BINDING, {themeId: theme.themeId})
    const out = {
        releases: releases.map((release, index) => ({
            releaseId: release.releaseId,
            releaseSeq: Number(release.releaseSeq),
            name: release.name,
            createdByName: userName(release.createdByUserId),
            createdDateText: dateText(release.createdDate),
            manifestDigest: release.manifestDigest,
            validationDigest: release.validationDigest,
            draftRevision: release.draftRevision == null ? null : Number(release.draftRevision),
            previousReleaseId: releases[index + 1]?.releaseId || null,
            activeSiteIds: bindings.filter(binding => binding.releaseId === release.releaseId).map(binding => binding.siteId),
            engineText: release.engine + " (view API " + release.viewApiVersion + ")"
        })),
        activations: activationsOf(theme)
    }
    const path = text(p.path)
    if (path) {
        if (!access.has("COMMERCE_THEME_CODE") && !path.startsWith("assets/") && !path.startsWith("locales/"))
            refuse("PERMISSION_DENIED", "COMMERCE_THEME_CODE is required")
        const entries = themes.draftFiles(theme)
        const entry = entries.find(file => file.path === path)
        const ref = ec.resource.getLocationReference(theme.packageRoot + "/" + path)
        out.versions = entry
            ? Array.from(ref.getVersionHistory() || [])
                  .slice(-30)
                  .reverse()
                  .map(version => ({
                      versionName: version.versionName,
                      versionDateText: dateText(version.versionDate),
                      userName: userName(version.userId),
                      note: version.note || ""
                  }))
            : []
        const base = p.releaseId ? releases.find(release => release.releaseId === p.releaseId) : releases[0]
        const pinned = base ? one(RELEASE_FILE, {releaseId: base.releaseId, filePath: path}) : null
        const baseText = pinned && !themes.isBinaryPath(path) ? themes.releaseFiles(base, [path])[path] : ""
        const draftText = entry && !themes.isBinaryPath(path) ? entry.text : ""
        out.diff = {
            path,
            baseReleaseId: base?.releaseId || null,
            baseReleaseSeq: base ? Number(base.releaseSeq) : null,
            baseText,
            draftText,
            unifiedDiff: ec.resource.textDiff(baseText, draftText, base ? "release " + base.releaseSeq : "none", "draft")
                .unifiedDiff
        }
    }
    return out
}
// The activations of the sites a theme's store sells on (the binding's audit log of releaseId), newest first.
function activationsOf(theme) {
    const mounts = stores.shopMounts([theme.productStoreId])[theme.productStoreId] || []
    const siteIds = mounts.map(mount => mount.siteId)
    if (!siteIds.length) return []
    const logs = Array.from(
        find("moqui.entity.EntityAuditLog", {changedEntityName: BINDING, changedFieldName: "releaseId"})
            .condition("pkPrimaryValue", "in", siteIds)
            .orderBy("-changedDate")
            .limit(50)
            .list()
    )
    return logs.map(log => {
        const release = one(RELEASE, {releaseId: log.newValueText})
        return {
            siteId: log.pkPrimaryValue,
            releaseId: log.newValueText,
            releaseText: release ? (release.name || release.themeId) + " release " + release.releaseSeq : log.newValueText,
            previousReleaseId: log.oldValueText || null,
            changedDateText: dateText(log.changedDate),
            changedByName: userName(log.changedByUserId)
        }
    })
}

// ===== preview =====
// The preview host of a site (PshkPreview), or null.
const previewHostOf = siteId => rows(SITE_HOST, {siteId}).find(host => host.hostKindEnumId === "PshkPreview") || null
// create#ThemePreview: a preview of a theme's draft on a site's Shop mount (PreviewContext): the page kind and the
// product, category or page (sitePageId) it shows, for the user and twenty minutes. The site must sell the theme's store
// (THEME_STORE_MISMATCH) and have a preview host (NO_PREVIEW_HOST). Answers the preview's host and path; the path carries
// the token, which is kept only as its digest. COMMERCE_THEME_EDIT, COMMERCE_THEME_CODE or COMMERCE_THEME_PUBLISH.
function createThemePreview(p) {
    const {s, theme} = themeFor(p, PREVIEWERS)
    const site = p.siteId ? one(SITE, {siteId: p.siteId}) : null
    const mount = site ? rows(SITE_APP, {siteId: site.siteId, app: "shop"})[0] : null
    if (!mount || !mount.targetId) refuse("NO_SHOP_MOUNT", "Site " + text(p.siteId) + " has no Shop mount", "NotFound")
    stores.storeOf(s, mount.targetId)
    if (mount.targetId !== theme.productStoreId)
        refuse(
            "THEME_STORE_MISMATCH",
            "Theme " + theme.themeId + " is not a theme of the store site " + site.siteId + " sells",
            "Unprocessable"
        )
    const host = previewHostOf(site.siteId)
    if (!host)
        refuse(
            "NO_PREVIEW_HOST",
            "Site " + (site.name || site.siteId) + " has no preview address; ask its operator for one",
            "Unprocessable"
        )
    const pageKind = text(p.pageKind) || "home"
    if (!themes.pageKinds.includes(pageKind)) refuse("VALUE_INVALID", "Choose a page kind", "Unprocessable")
    const targetId = text(p.targetId) || null
    if (targetId && !idPattern.test(targetId)) refuse("VALUE_INVALID", "Choose a product, category or page", "Unprocessable")
    const locale = text(p.locale) || null
    if (locale && !/^[a-z]{2,3}([-_][A-Za-z0-9]{2,8})*$/.test(locale)) refuse("VALUE_INVALID", "Choose a locale")
    const token = ec.user.randomString(40).replace(/[^A-Za-z0-9]/g, "x")
    const expireDate = new Date(lib.ms(ec.user.nowTimestamp) + previewMinutes * 60000)
    const created = call("create#" + PREVIEW, {
        themeId: theme.themeId,
        siteId: site.siteId,
        appMountId: mount.appMountId,
        userId: ec.user.userId,
        tokenDigest: digestOf(token),
        pageKind,
        targetId,
        locale,
        draftRevision: Number(theme.draftRevision || 0),
        expireDate,
        createdDate: ec.user.nowTimestamp
    })
    // the user's previews that ended a day ago go (each on its own; one that fails is logged)
    for (const old of Array.from(
        find(PREVIEW, {userId: ec.user.userId})
            .condition("expireDate", "less-than", new Date(lib.ms(ec.user.nowTimestamp) - 86400000))
            .limit(50)
            .list()
    )) {
        try {
            old.delete()
        } catch (error) {
            ec.logger.warn("Theme preview " + old.previewId + " was not removed: " + error.message)
        }
    }
    return {
        previewId: created.previewId,
        previewHost: host.hostname,
        previewPath: "/preview/" + token,
        pageKind,
        expireDateText: dateText(expireDate)
    }
}
// get#PreviewHost: whether a host of a site is its preview host (PASS's route and shell read it on each request; a
// remote frontend, which has no Mantle, never serves previews). Anonymous.
function getPreviewHost(p) {
    const host = p.hostname ? one(SITE_HOST, {hostname: String(p.hostname).toLowerCase()}) : null
    return {preview: !!host && host.siteId === p.siteId && host.hostKindEnumId === "PshkPreview"}
}
// get#ThemePreviewPage: the preview of a token on its site's preview host: the draft's files (a binary asset's as base64),
// the page kind, the template (a page's alternate when it names one in the draft), the view, sources and whether the view
// is the sample one. Not Found for a token that is unknown, expired, of another site or host, or whose actor can no longer
// sign in, and for a theme that is gone. Anonymous; nothing is written.
function getThemePreviewPage(p) {
    const notFound = () => refuse("NOT_AVAILABLE", "This preview is not available", "NotFound")
    const token = text(p.token)
    if (!/^[A-Za-z0-9]{20,80}$/.test(token)) notFound()
    const preview = one(PREVIEW, {tokenDigest: digestOf(token)})
    if (!preview || preview.siteId !== p.siteId || lib.ms(preview.expireDate) <= lib.ms(ec.user.nowTimestamp)) notFound()
    if (!getPreviewHost(p).preview) notFound()
    const account = one("moqui.security.UserAccount", {userId: preview.userId})
    if (!account || account.disabled === "Y") notFound()
    const theme = one(THEME, {themeId: preview.themeId})
    const site = one(SITE, {siteId: preview.siteId})
    const mount = one(SITE_APP, {siteId: preview.siteId, appMountId: preview.appMountId})
    if (!theme || !site || !mount || mount.targetId !== theme.productStoreId) notFound()
    const store = one("mantle.product.store.ProductStore", {productStoreId: theme.productStoreId})
    const files = filesOf(theme)
    // an asset of the draft (the preview page's stylesheet, images): its text, a binary one's base64
    if (p.assetPath) {
        const path = "assets/" + text(p.assetPath)
        if (!themes.pathPattern.test(path) || files[path] == null) notFound()
        return {
            previewId: preview.previewId,
            themeId: theme.themeId,
            asset: {path, text: files[path], binary: themes.isBinaryPath(path)}
        }
    }
    const built = previewView(preview, site, mount, store, files)
    const {composition} = themes.compositionOf(files)
    const manifest = {defaultTemplates: (parsed(files["theme.json"] || "", {}) || {}).defaultTemplates || {}, composition}
    const view = ec.resource.script("component://mr-mantle/service/mantle/public/ThemeView.js")
    let sources = {}
    try {
        sources = built.sample
            ? {}
            : view.loadSources
              ? view.loadSources(manifest, built.template || preview.pageKind, {siteId: site.siteId})
              : {}
    } catch (error) {
        ec.logger.error("Theme preview " + preview.previewId + " sources failed: " + error.message)
    }
    return {
        previewId: preview.previewId,
        themeId: theme.themeId,
        pageKind: preview.pageKind,
        template: built.template,
        sample: built.sample,
        files,
        view: built.view,
        references: {},
        media: {},
        sources
    }
}
// The view of a preview: the live view of its page kind when the site is published and the page reads (the store's
// public data, ThemeView.js and ShopCatalog.js), else the sample view with the site's and store's names; a cart, checkout
// or account page always gets synthetic private state, never a shopper's.
function previewView(preview, site, mount, store, files) {
    const view = ec.resource.script("component://mr-mantle/service/mantle/public/ThemeView.js")
    const kind = preview.pageKind
    const base = mount.pathPrefix === "/" ? "" : mount.pathPrefix
    const shop = {
        name: store.storeName || store.productStoreId,
        baseUrl: base || "/",
        currencyUomId: store.defaultCurrencyUomId || null,
        searchUrl: base + "/Search",
        categoriesUrl: base + "/Categories"
    }
    const locale = String(preview.locale || store.defaultLocale || site.locale || "en").replace(/_/g, "-")
    let raw = null
    let template = null
    if (site.state === "published" && view.pages[kind] && !["cart", "checkout"].includes(kind)) {
        const input = {siteId: site.siteId, pageKind: kind}
        if (kind === "product") input.productId = preview.targetId
        if (kind === "category") input.productCategoryId = preview.targetId
        if (kind === "page") {
            const page = preview.targetId ? one(PAGE, {sitePageId: preview.targetId}) : null
            if (page && page.siteId === site.siteId) {
                input.routePath = page.routePath
                if (page.templateKey && files[templatePath(page.templateKey)] != null) template = page.templateKey
            }
        }
        try {
            ec.message.pushErrors()
            raw = view.pages[kind].view({siteId: site.siteId, productStoreId: store.productStoreId}, input)
        } catch (error) {
            raw = null
        } finally {
            ec.message.clearErrors()
            ec.message.popErrors()
        }
    }
    const sample = !raw
    if (sample) raw = themes.sampleView(kind)
    const synthetic = {
        amount: "48.00",
        currencyUomId: shop.currencyUomId || "USD",
        display: "48.00 " + (shop.currencyUomId || "")
    }
    if (["cart", "checkout"].includes(kind)) raw.cart = {itemCount: 2, subtotal: synthetic}
    if (["account", "orders", "order", "downloads", "subscriptions"].includes(kind))
        raw.account = {displayName: "Preview shopper"}
    let navigation = []
    try {
        const pages = ec.resource.script("component://mr-mantle/service/mantle/public/SitePages.js")
        navigation = site.state === "published" ? pages.liveNavigation(pages.liveContext(site.siteId), "main", locale) : []
    } catch (error) {
        navigation = []
    }
    const full = Object.assign({}, raw, {
        site: {displayName: site.name || site.siteId, locale: String(site.locale || "en").replace(/_/g, "-")},
        shop,
        locale,
        page: Object.assign({kind, canonicalUrl: base + "/"}, raw.page || {}, {kind}),
        navigation: navigation.length ? navigation : raw.navigation || []
    })
    return {view: view.contract(full), sample, template}
}

const operations = {
    findThemes,
    importTheme,
    storeThemeDraft,
    getThemeComposition,
    storeThemeComposition,
    storeThemeSettings,
    getThemeAssets,
    storeThemeAsset,
    getThemeTranslations,
    storeThemeTranslations,
    assignThemeTemplate,
    getThemeFile,
    storeThemeFile,
    changeThemeFile,
    getThemeBindings,
    getThemeHistory,
    createThemePreview,
    getPreviewHost,
    getThemePreviewPage
}
;({
    knownTemplates,
    previewHostOf,
    execute: (op, parameters) => {
        if (!operations[op]) throw new Error("Unknown theme authoring operation " + op)
        return operations[op](parameters || {})
    }
})
