// Shop themes and releases (mr-pass impl-shop P2; mantle.public.ThemeServices, Themes.js, ThemeView.js): a draft's
// validation digest follows its files and a template naming `ec` fails with its file and line; publish pins the files and
// advances the binding's revision and the site's generation together (a retry by its operation key answers the first
// result), restore switches back through the same gate with an audit record, and a stale active revision or validation digest is refused with nothing changed; a designer validates
// but cannot publish, another organization's publisher cannot see the theme; the live reads give only the active
// release, and the page view keeps to the view contract.
// Standalone: spec-local organizations, users, store, site and a small package written into the theme's draft (the
// starter theme is mr-pass's; its spec is ShopThemes). Run: ./moq test mr-mantle --spec ThemeReleases
const T = "mantle.public.ThemeServices."
const prefix = "THMREL"
const orgA = prefix + "_ORG_A",
    orgB = prefix + "_ORG_B",
    storeA = prefix + "_STORE_A",
    storeA2 = prefix + "_STORE_A2",
    site = prefix + "_SITE"
const state = {}
// operation keys unique to this run (PostingOperation rows outlive it)
const runKey = String(Date.now()).slice(-9)
let keys = 0
const key = () => prefix + "-" + runKey + "-" + ++keys
const themes = () => ec.resource.script("component://mr-mantle/service/mantle/public/Themes.js")
const view = () => ec.resource.script("component://mr-mantle/service/mantle/public/ThemeView.js")

function system(action) {
    login("john.doe")
    const was = ec.artifactExecution.disableAuthz()
    try {
        return action()
    } finally {
        if (!was) ec.artifactExecution.enableAuthz()
    }
}
const make = (entity, values) => call("create#" + entity, values)
const one = (entity, conditions) => system(() => ec.entity.find(entity).condition(conditions).disableAuthz().one())
const list = (entity, conditions) =>
    system(() => Array.from(ec.entity.find(entity).condition(conditions).disableAuthz().list()).map(row => row.getMap()))
function organization(partyId, name) {
    make("mantle.party.Party", {partyId, partyTypeEnumId: "PtyOrganization"})
    make("mantle.party.Organization", {partyId, organizationName: name})
    make("mantle.party.PartyRole", {partyId, roleTypeId: "OrgInternal"})
}
function user(kind, organizationPartyId, permissions) {
    const id = prefix + "_" + kind.toUpperCase()
    make("mantle.party.Party", {partyId: id, partyTypeEnumId: "PtyPerson"})
    make("mantle.party.Person", {partyId: id, firstName: "Theme", lastName: kind})
    make("mantle.party.PartyRelationship", {
        partyRelationshipId: id,
        fromPartyId: id,
        toPartyId: organizationPartyId,
        relationshipTypeEnumId: "PrtAgent",
        fromDate: 0
    })
    make("moqui.security.UserGroup", {userGroupId: id, description: "Theme " + kind})
    for (const permission of permissions)
        make("moqui.security.UserGroupPermission", {userGroupId: id, userPermissionId: permission, fromDate: 0})
    make("moqui.security.UserAccount", {
        userId: id,
        username: id,
        partyId: id,
        currentPassword: "16ac58bbfa332c1c55bd98b53e60720bfa90d394",
        passwordHashType: "SHA",
        timeZone: "America/Chicago",
        locale: "en_US"
    })
    make("moqui.security.UserGroupMember", {userId: id, userGroupId: id, fromDate: 0})
    return id
}
// a call as a user, in its own transaction: its result and its refusal ("" when it succeeds)
function run(username, service, parameters = {}) {
    login(username)
    const was = ec.artifactExecution.disableAuthz()
    ec.message.pushErrors()
    try {
        const out = ec.service.sync().name(service).parameters(parameters).requireNewTransaction(true).call() || {}
        return Object.assign({}, out, {error: ec.message.hasError() ? ec.message.getErrorsString() : ""})
    } catch (error) {
        return {error: String(error.message || error)}
    } finally {
        ec.message.clearErrors()
        ec.message.popErrors()
        if (!was) ec.artifactExecution.enableAuthz()
        login("john.doe")
    }
}
const code = out => (/([A-Z][A-Z0-9_]+):/.exec(out.error || "") || [])[1] || (out.error ? "ERROR" : "")
const generation = () => Number(one("mantle.public.PublicSite", {siteId: site}).generation)
const binding = () => one("mantle.public.PublicThemeBinding", {siteId: site, appMountId: "shop"})
// A small package with a template for every page kind; one section places each page kind's required component.
function packageFiles(heading) {
    const kinds = themes().pageKinds
    const files = {
        "theme.json": JSON.stringify({
            schemaVersion: 1,
            name: "Spec theme",
            engine: "js-fancy",
            viewApiVersion: 1,
            layout: "store",
            requiredComponents: Object.keys(themes().requiredComponents),
            styles: ["assets/store.css"]
        }),
        "layouts/store.html.fancy-locked":
            '<!doctype html><html lang="${locale}"><head>${styles}</head><body>${content}</body></html>',
        "sections/main.html.fancy-locked":
            "<section><h1>${section.settings.heading} ${shop.name}</h1>" +
            '<#if page.kind == "product">${components["shop.productPurchase"]}</#if>' +
            '<#if page.kind == "cart">${components["shop.cart"]}</#if>' +
            '<#if page.kind == "checkout">${components["shop.checkout"]}</#if>' +
            // Shop P3: the search form
            '<#if page.kind == "search">${components["shop.search"]}</#if></section>',
        "sections/main.schema.json": JSON.stringify({
            name: "Main",
            settings: [{id: "heading", type: "text", default: "Welcome"}]
        }),
        "assets/store.css": "body { color: #222; }"
    }
    for (const kind of kinds)
        files["templates/" + kind + ".json"] = JSON.stringify({sections: {main: {type: "main", settings: {heading}}}})
    return files
}
// A new theme of a store with a draft of these files, as Commerce P5's editors write one (Themes.putDraftFiles).
function draft(productStoreId, files) {
    return system(() => {
        const themeId = call("create#mantle.public.PublicTheme", {productStoreId, name: "Spec", draftRevision: 0}).themeId
        call("update#mantle.public.PublicTheme", {themeId, packageRoot: "dbresource://mantle/public/theme/" + themeId})
        themes().putDraftFiles(one("mantle.public.PublicTheme", {themeId}), files, "spec")
        return themeId
    })
}
const change = (themeId, files) =>
    system(() => themes().putDraftFiles(one("mantle.public.PublicTheme", {themeId}), files, "spec"))

spec({
    setupSpec() {
        system(() => {
            organization(orgA, "Theme organization A")
            organization(orgB, "Theme organization B")
            for (const [productStoreId, organizationPartyId] of [
                [storeA, orgA],
                [storeA2, orgA]
            ])
                make("mantle.product.store.ProductStore", {
                    productStoreId,
                    storeName: "Theme store " + productStoreId,
                    organizationPartyId,
                    defaultCurrencyUomId: "USD"
                })
            make("mantle.public.PublicSite", {siteId: site, name: "Theme site", state: "published", locale: "en", generation: 5})
            make("mantle.public.PublicSiteApp", {
                siteId: site,
                appMountId: "shop",
                app: "shop",
                pathPrefix: "/shop",
                enabled: "Y",
                targetId: storeA
            })
            state.publisher = user("publisher", orgA, ["COMMERCE_VIEW", "COMMERCE_THEME_PUBLISH"])
            state.designer = user("designer", orgA, ["COMMERCE_VIEW", "COMMERCE_THEME_EDIT"])
            state.outsider = user("outsider", orgB, ["COMMERCE_VIEW", "COMMERCE_THEME_EDIT", "COMMERCE_THEME_PUBLISH"])
        })
        state.themeId = draft(storeA, packageFiles("Hello"))
    },
    cleanup() {
        login("john.doe")
    }
})

feature("the validation digest follows the draft, and a template naming ec fails with its file and line", {
    when() {
        const first = run(state.designer, T + "validate#Theme", {themeId: state.themeId})
        const again = run(state.designer, T + "validate#Theme", {themeId: state.themeId})
        change(state.themeId, {
            "templates/home.json": JSON.stringify({sections: {main: {type: "main", settings: {heading: "Changed"}}}})
        })
        const stale = run(state.designer, T + "get#ThemeDraft", {themeId: state.themeId})
        const changed = run(state.designer, T + "validate#Theme", {themeId: state.themeId})
        const bad = draft(
            storeA,
            Object.assign(packageFiles("Bad"), {
                "sections/main.html.fancy-locked": "<section>\n<p>${ec.user.userId}</p></section>"
            })
        )
        const naming = run(state.designer, T + "validate#Theme", {themeId: bad})
        const noCart = draft(
            storeA,
            Object.assign(packageFiles("No cart"), {
                "theme.json": JSON.stringify({
                    schemaVersion: 1,
                    name: "x",
                    engine: "js-fancy",
                    viewApiVersion: 1,
                    layout: "store",
                    requiredComponents: ["shop.productPurchase", "shop.checkout"],
                    styles: []
                })
            })
        )
        const missing = run(state.designer, T + "validate#Theme", {themeId: noCart})
        Object.assign(state, {first, again, stale, changed, naming, missing})
    },
    then() {
        const {first, again, stale, changed, naming, missing} = state
        const forbidden = naming.diagnostics.find(d => d.code === "forbidden-name")
        return (
            first.error === "" &&
            first.ok === true &&
            /^[0-9a-f]{64}$/.test(first.validationDigest) &&
            again.validationDigest === first.validationDigest &&
            stale.validation.current === false &&
            stale.files.length === Object.keys(packageFiles("x")).length &&
            changed.ok === true &&
            changed.validationDigest !== first.validationDigest &&
            changed.draftRevision === first.draftRevision + 1 &&
            naming.ok === false &&
            forbidden.file === "sections/main.html.fancy-locked" &&
            forbidden.line === 2 &&
            missing.ok === false &&
            missing.diagnostics.some(d => d.code === "required-failed" && d.message.includes("shop.cart"))
        )
    }
})

feature("publish pins the files and advances the revision and generation; restore switches back with an audit record", {
    when() {
        const digest = run(state.publisher, T + "validate#Theme", {themeId: state.themeId}).validationDigest
        const before = generation()
        state.firstKey = key()
        const first = run(state.publisher, T + "publish#Theme", {
            operationKey: state.firstKey,
            themeId: state.themeId,
            siteId: site,
            validationDigest: digest,
            expectedActiveRevision: 0
        })
        const retried = run(state.publisher, T + "publish#Theme", {
            operationKey: state.firstKey,
            themeId: state.themeId,
            siteId: site,
            validationDigest: digest,
            expectedActiveRevision: 0
        })
        const afterFirst = generation()
        const release = one("mantle.public.PublicThemeRelease", {releaseId: first.releaseId})
        const pinned = list("mantle.public.PublicThemeReleaseFile", {releaseId: first.releaseId})
        change(state.themeId, {
            "templates/home.json": JSON.stringify({sections: {main: {type: "main", settings: {heading: "Second"}}}})
        })
        const digest2 = run(state.publisher, T + "validate#Theme", {themeId: state.themeId}).validationDigest
        const second = run(state.publisher, T + "publish#Theme", {
            operationKey: key(),
            themeId: state.themeId,
            siteId: site,
            validationDigest: digest2,
            expectedActiveRevision: 1
        })
        const restored = run(state.publisher, T + "restore#ThemeRelease", {
            operationKey: key(),
            siteId: site,
            releaseId: first.releaseId,
            expectedActiveRevision: 2
        })
        const exported = run(state.designer, T + "export#ThemeRelease", {releaseId: first.releaseId, includeFiles: true})
        const audit = list("moqui.entity.EntityAuditLog", {
            changedEntityName: "mantle.public.PublicThemeBinding",
            changedFieldName: "releaseId"
        }).filter(row => String(row.pkPrimaryValue) === site)
        Object.assign(state, {
            before,
            first,
            retried,
            afterFirst,
            release,
            pinned,
            second,
            restored,
            exported,
            audit,
            after: generation(),
            bound: binding()
        })
    },
    then() {
        const {before, first, retried, afterFirst, release, pinned, second, restored, exported, audit, after, bound} = state
        const manifest = JSON.parse(release.manifestText)
        return (
            first.error === "" &&
            first.revision === 1 &&
            first.alreadyApplied === false &&
            retried.error === "" &&
            retried.alreadyApplied === true &&
            retried.releaseId === first.releaseId &&
            afterFirst === before + 1 &&
            first.generation === afterFirst &&
            release.manifestDigest === ec.resource.digestText(release.manifestText, "sha256") &&
            manifest.engine === "js-fancy" &&
            manifest.viewApiVersion === 1 &&
            manifest.composition.home.sections.main.type === "main" &&
            pinned.length === Object.keys(packageFiles("x")).length &&
            pinned.every(row => /^[0-9a-f]{64}$/.test(row.digest) && row.versionName) &&
            second.error === "" &&
            second.revision === 2 &&
            restored.error === "" &&
            restored.revision === 3 &&
            restored.releaseId === first.releaseId &&
            after === before + 3 &&
            bound.releaseId === first.releaseId &&
            bound.activation === "restore" &&
            exported.files["templates/home.json"].includes("Hello") &&
            !JSON.stringify(exported).includes("dbresource://") &&
            audit.length >= 3
        )
    }
})

feature("a stale active revision or validation digest is refused and nothing changes", {
    when() {
        const digest = run(state.publisher, T + "validate#Theme", {themeId: state.themeId}).validationDigest
        const before = generation()
        const held = binding()
        const staleRevision = run(state.publisher, T + "publish#Theme", {
            operationKey: key(),
            themeId: state.themeId,
            siteId: site,
            validationDigest: digest,
            expectedActiveRevision: 1
        })
        change(state.themeId, {"assets/store.css": "body { color: #333; }"})
        const staleDigest = run(state.publisher, T + "publish#Theme", {
            operationKey: key(),
            themeId: state.themeId,
            siteId: site,
            validationDigest: digest,
            expectedActiveRevision: 3
        })
        const staleRestore = run(state.publisher, T + "restore#ThemeRelease", {
            operationKey: key(),
            siteId: site,
            releaseId: state.second.releaseId,
            expectedActiveRevision: 2
        })
        Object.assign(state, {staleRevision, staleDigest, staleRestore, unchanged: generation() === before, held, now: binding()})
    },
    then() {
        const {staleRevision, staleDigest, staleRestore, unchanged, held, now} = state
        return (
            code(staleRevision) === "REVISION_STALE" &&
            code(staleDigest) === "VALIDATION_STALE" &&
            code(staleRestore) === "REVISION_STALE" &&
            unchanged &&
            Number(now.revision) === Number(held.revision) &&
            now.releaseId === held.releaseId
        )
    }
})

feature("a designer cannot publish, another organization cannot see the theme, another store's theme is refused", {
    when() {
        const digest = run(state.publisher, T + "validate#Theme", {themeId: state.themeId}).validationDigest
        const revision = Number(binding().revision)
        const designer = run(state.designer, T + "publish#Theme", {
            operationKey: key(),
            themeId: state.themeId,
            siteId: site,
            validationDigest: digest,
            expectedActiveRevision: revision
        })
        const outsider = run(state.outsider, T + "validate#Theme", {themeId: state.themeId})
        const outsiderPublish = run(state.outsider, T + "publish#Theme", {
            operationKey: key(),
            themeId: state.themeId,
            siteId: site,
            validationDigest: digest,
            expectedActiveRevision: revision
        })
        const other = draft(storeA2, packageFiles("Other store"))
        const otherDigest = run(state.publisher, T + "validate#Theme", {themeId: other}).validationDigest
        const mismatch = run(state.publisher, T + "publish#Theme", {
            operationKey: key(),
            themeId: other,
            siteId: site,
            validationDigest: otherDigest,
            expectedActiveRevision: revision
        })
        Object.assign(state, {designer, outsider, outsiderPublish, mismatch})
    },
    then() {
        const {designer, outsider, outsiderPublish, mismatch} = state
        return (
            code(designer) === "PERMISSION_DENIED" &&
            code(outsider) === "RECORD_UNAVAILABLE" &&
            code(outsiderPublish) === "RECORD_UNAVAILABLE" &&
            code(mismatch) === "THEME_STORE_MISMATCH"
        )
    }
})

feature("the live reads give only the active release, and the page view keeps to the view contract", {
    when() {
        const live = name => input => {
            login("john.doe")
            ec.message.pushErrors()
            try {
                const out =
                    ec.service
                        .sync()
                        .name(T + name)
                        .parameters({input})
                        .requireNewTransaction(true)
                        .call() || {}
                return ec.message.hasError() ? {error: ec.message.getErrorsString()} : out.result
            } catch (error) {
                return {error: String(error.message || error)}
            } finally {
                ec.message.clearErrors()
                ec.message.popErrors()
            }
        }
        const active = binding().releaseId
        const release = live("get#ShopThemeRelease")({siteId: site, releaseId: active})
        const files = live("get#ShopThemeFiles")({siteId: site, releaseId: active, paths: "theme.json,templates/home.json"})
        const inactive = live("get#ShopThemeFiles")({siteId: site, releaseId: state.second.releaseId, paths: "theme.json"})
        const page = live("get#ShopPage")({siteId: site, pageKind: "home"})
        const unknownKind = live("get#ShopPage")({siteId: site, pageKind: "checkout"})
        const contract = view().contract({
            site: {displayName: "S", sessionToken: "x", ec: {}},
            shop: {name: "N", apiSecret: "s", ownerPartyId: "P"},
            page: {kind: "home", fn: () => 1, user: {userId: "u"}},
            ec: {},
            entity: "x",
            productList: [{id: "1", price: {amount: "1.00", cost: "0.40"}, token: "t", internalName: "M-1", ownerPartyId: "P"}],
            product: {id: "2", name: "Mug", standardCost: "3.00", draftDescription: "x", availability: {label: "In", stock: 7}}
        })
        Object.assign(state, {active, release, files, inactive, page, unknownKind, contract})
    },
    then() {
        const {active, release, files, inactive, page, unknownKind, contract} = state
        const text = JSON.stringify(page.view)
        return (
            release.manifestDigest === ec.resource.digestText(release.manifestText, "sha256") &&
            files.files.length === 2 &&
            files.files.every(file => file.digest === ec.resource.digestText(file.text, "sha256")) &&
            /RELEASE_NOT_ACTIVE/.test(inactive.error) &&
            page.release.releaseId === active &&
            page.view.shop.name === "Theme store " + storeA &&
            page.generation === generation() &&
            !/"(ec|sri|session|user|entity)"|[Tt]oken|[Ss]ecret|PartyId/.test(text) &&
            /NOT_AVAILABLE/.test(unknownKind.error) &&
            JSON.stringify(contract) ===
                JSON.stringify({
                    site: {displayName: "S"},
                    shop: {name: "N"},
                    page: {kind: "home"},
                    product: {id: "2", name: "Mug", availability: {label: "In"}},
                    productList: [{id: "1", price: {amount: "1.00"}}]
                })
        )
    }
})
