// Theme authoring and preview (impl-commerce P5; mantle.public.ThemeServices' authoring part, ThemeAuthoring.js): a save
// on a stale draft revision is refused and changes nothing; a section move and a setting save advance the revision, an
// unknown setting is refused; a <script> or an onclick in a template is refused with its file and line, and the
// designer cannot edit source (COMMERCE_THEME_CODE); a required checkout component cannot be removed or hidden, nor its
// section's file; a Liquid package and a script file are refused on import; an uploaded image must be the type its name
// says and is refused without a scanner; an export of a release with an image holds no secret; a page's template key must
// be a template of the site's themes (F77); a preview needs the site's preview host, and its page answers the draft with
// synthetic private state only for its token on that host. Publish and restore with the generation are ThemeReleases'.
// Standalone: spec-local organizations, users, store, site and a small package. Run: ./moq test mr-mantle --spec ThemeAuthoring
const T = "mantle.public.ThemeServices."
const prefix = "THMAUT"
const orgA = prefix + "_ORG_A",
    orgB = prefix + "_ORG_B",
    storeA = prefix + "_STORE_A",
    site = prefix + "_SITE",
    previewHost = "preview.thmaut.example.test"
const state = {}
const runKey = String(Date.now()).slice(-9)
let keys = 0
const key = () => prefix + "-" + runKey + "-" + ++keys
const themes = () => ec.resource.script("component://mr-mantle/service/mantle/public/Themes.js")

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
// a call as a user (null: anonymous), in its own transaction: its result and its refusal ("" when it succeeds)
function run(username, service, parameters = {}) {
    if (username) login(username)
    else ec.user.logoutUser()
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
const revision = themeId => Number(one("mantle.public.PublicTheme", {themeId}).draftRevision)
const draftText = (themeId, path) =>
    system(
        () =>
            themes()
                .draftFiles(one("mantle.public.PublicTheme", {themeId}))
                .find(file => file.path === path)?.text ?? null
    )
// A small package with a template for every page kind; the main section places each page kind's component, and the
// checkout template has a second section beside it.
function packageFiles() {
    const files = {
        "theme.json": JSON.stringify({
            schemaVersion: 1,
            name: "Authoring spec",
            engine: "js-fancy",
            viewApiVersion: 1,
            layout: "store",
            requiredComponents: Object.keys(themes().requiredComponents),
            styles: ["assets/store.css"]
        }),
        "layouts/store.html.fancy-locked":
            '<!doctype html><html lang="${locale}"><head>${styles}</head><body>${content}</body></html>',
        "sections/main.html.fancy-locked":
            '<section data-section-id="${section.id}"><h1>${section.settings.heading} ${shop.name}</h1>' +
            '<#if page.kind == "product">${components["shop.productPurchase"]}</#if>' +
            '<#if page.kind == "cart">${components["shop.cart"]}<p>${cart.itemCount}</p></#if>' +
            '<#if page.kind == "checkout">${components["shop.checkout"]}</#if>' +
            '<#if page.kind == "search">${components["shop.search"]}</#if></section>',
        "sections/main.schema.json": JSON.stringify({
            name: "Main",
            settings: [{id: "heading", type: "text", default: "Welcome"}]
        }),
        "sections/note.html.fancy-locked": "<aside>${section.settings.text}</aside>",
        "sections/note.schema.json": JSON.stringify({name: "Note", settings: [{id: "text", type: "text", default: "Note"}]}),
        "config/settings.schema.json": JSON.stringify([
            {name: "Colors", settings: [{id: "accent", type: "color", default: "#123456"}]}
        ]),
        "config/settings.json": JSON.stringify({accent: "#123456"}),
        "assets/store.css": "body { color: #222; }"
    }
    for (const kind of themes().pageKinds)
        files["templates/" + kind + ".json"] = JSON.stringify(
            kind === "home" || kind === "checkout"
                ? {sections: {main: {type: "main", settings: {heading: "Hello"}}, note: {type: "note"}}, order: ["main", "note"]}
                : {sections: {main: {type: "main", settings: {heading: "Hello"}}}}
        )
    return files
}
// A small PNG (1x1): its bytes as base64.
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
const jpegBytes =
    "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q=="
function draft() {
    return run(state.designer, T + "import#Theme", {productStoreId: storeA, name: "Authoring", files: packageFiles()})
}

spec({
    setupSpec() {
        system(() => {
            organization(orgA, "Authoring organization A")
            organization(orgB, "Authoring organization B")
            make("mantle.product.store.ProductStore", {
                productStoreId: storeA,
                storeName: "Authoring store",
                organizationPartyId: orgA,
                defaultCurrencyUomId: "USD"
            })
            make("mantle.public.PublicSite", {
                siteId: site,
                name: "Authoring site",
                state: "disabled",
                locale: "en",
                generation: 1
            })
            make("mantle.public.PublicSiteApp", {
                siteId: site,
                appMountId: "shop",
                app: "shop",
                pathPrefix: "/",
                enabled: "Y",
                targetId: storeA
            })
            state.designer = user("designer", orgA, ["COMMERCE_VIEW", "COMMERCE_THEME_EDIT"])
            state.developer = user("developer", orgA, ["COMMERCE_VIEW", "COMMERCE_THEME_EDIT", "COMMERCE_THEME_CODE"])
            state.publisher = user("publisher", orgA, ["COMMERCE_VIEW", "COMMERCE_THEME_PUBLISH"])
            state.outsider = user("outsider", orgB, ["COMMERCE_VIEW", "COMMERCE_THEME_EDIT", "COMMERCE_THEME_CODE"])
        })
        state.themeId = draft().themeId
    },
    cleanup() {
        login("john.doe")
    }
})

feature("a stale draft revision is refused and changes nothing; a section move and a setting save advance the revision", {
    when() {
        const at = revision(state.themeId)
        const home = {
            sections: {main: {type: "main", settings: {heading: "Hello"}}, note: {type: "note"}},
            order: ["note", "main"]
        }
        const stale = run(state.designer, T + "store#ThemeComposition", {
            themeId: state.themeId,
            expectedRevision: at - 1,
            template: "home",
            composition: home
        })
        const unchanged = draftText(state.themeId, "templates/home.json")
        const moved = run(state.designer, T + "store#ThemeComposition", {
            themeId: state.themeId,
            expectedRevision: at,
            template: "home",
            composition: home
        })
        const color = run(state.designer, T + "store#ThemeSettings", {
            themeId: state.themeId,
            expectedRevision: at + 1,
            settings: {accent: "#aa0000"}
        })
        const unknown = run(state.designer, T + "store#ThemeSettings", {
            themeId: state.themeId,
            expectedRevision: at + 2,
            template: "home",
            sectionId: "main",
            settings: {colour: "red"}
        })
        const heading = run(state.designer, T + "store#ThemeSettings", {
            themeId: state.themeId,
            expectedRevision: at + 2,
            template: "home",
            sectionId: "main",
            settings: {heading: "Spring sale"}
        })
        const outsiderRead = run(state.outsider, T + "get#ThemeComposition", {themeId: state.themeId})
        Object.assign(state, {at, stale, unchanged, moved, color, unknown, heading, outsiderRead})
        state.composition = run(state.designer, T + "get#ThemeComposition", {themeId: state.themeId})
    },
    then() {
        const {at, stale, unchanged, moved, color, unknown, heading, outsiderRead, composition} = state
        code(stale) === "REVISION_STALE"
        JSON.parse(unchanged).order.join(",") === "main,note"
        moved.error === ""
        moved.draftRevision === at + 1
        color.draftRevision === at + 2
        JSON.parse(draftText(state.themeId, "config/settings.json")).accent === "#aa0000"
        code(unknown) === "UNKNOWN_SETTING"
        heading.draftRevision === at + 3
        composition.templates
            .find(t => t.name === "home")
            .sections.map(section => section.id)
            .join(",") === "note,main"
        composition.templates.find(t => t.name === "home").sections[1].settings.heading === "Spring sale"
        code(outsiderRead) === "RECORD_UNAVAILABLE"
    }
})

feature("a script or an onclick in a template is refused with its file and line; the designer cannot edit source", {
    when() {
        const at = revision(state.themeId)
        const path = "sections/note.html.fancy-locked"
        const script = run(state.developer, T + "store#ThemeFile", {
            themeId: state.themeId,
            expectedRevision: at,
            path,
            text: "<aside>\n<script>alert(1)</script>\n</aside>"
        })
        const onclick = run(state.developer, T + "store#ThemeFile", {
            themeId: state.themeId,
            expectedRevision: at,
            path,
            text: '<aside>\n\n<a href="/" onclick="steal()">x</a></aside>'
        })
        const designerSave = run(state.designer, T + "store#ThemeFile", {
            themeId: state.themeId,
            expectedRevision: at,
            path,
            text: "<aside>Designer</aside>"
        })
        const designerRead = run(state.designer, T + "get#ThemeFile", {themeId: state.themeId, path})
        const unchanged = draftText(state.themeId, path)
        const edited = run(state.developer, T + "store#ThemeFile", {
            themeId: state.themeId,
            expectedRevision: at,
            path,
            text: '<aside class="note">${section.settings.text}</aside>'
        })
        const read = run(state.developer, T + "get#ThemeFile", {themeId: state.themeId, path})
        const history = run(state.developer, T + "get#ThemeHistory", {themeId: state.themeId, path})
        Object.assign(state, {at, script, onclick, designerSave, designerRead, unchanged, edited, read, history})
    },
    then() {
        const {at, script, onclick, designerSave, designerRead, unchanged, edited, read, history} = state
        code(script) === "THEME_SOURCE_INVALID"
        script.error.includes("sections/note.html.fancy-locked:2")
        code(onclick) === "THEME_SOURCE_INVALID"
        onclick.error.includes("sections/note.html.fancy-locked:3")
        code(designerSave) === "PERMISSION_DENIED"
        designerSave.error.includes("COMMERCE_THEME_CODE")
        code(designerRead) === "PERMISSION_DENIED"
        unchanged === "<aside>${section.settings.text}</aside>"
        edited.error === ""
        edited.draftRevision === at + 1
        read.text.includes('class="note"')
        history.versions.length >= 2
        history.diff.draftText.includes('class="note"')
    }
})

feature("a required checkout component cannot be removed or hidden; Liquid and script packages are refused on import", {
    when() {
        const at = revision(state.themeId)
        const removed = run(state.designer, T + "store#ThemeComposition", {
            themeId: state.themeId,
            expectedRevision: at,
            template: "checkout",
            composition: {sections: {note: {type: "note"}}, order: ["note"]}
        })
        const hidden = run(state.designer, T + "store#ThemeComposition", {
            themeId: state.themeId,
            expectedRevision: at,
            template: "checkout",
            composition: {sections: {main: {type: "main", disabled: true}, note: {type: "note"}}, order: ["main", "note"]}
        })
        const dropNote = run(state.designer, T + "store#ThemeComposition", {
            themeId: state.themeId,
            expectedRevision: at,
            template: "checkout",
            composition: {sections: {main: {type: "main"}}, order: ["main"]}
        })
        const fileRemoved = run(state.developer, T + "change#ThemeFile", {
            themeId: state.themeId,
            expectedRevision: at + 1,
            operation: "remove",
            path: "sections/main.html.fancy-locked",
            confirmDependents: true,
            changeReason: "Spec"
        })
        const liquid = run(state.designer, T + "import#Theme", {
            productStoreId: storeA,
            files: Object.assign(packageFiles(), {"templates/product.liquid": "{{ product.title }}"})
        })
        const scriptFile = run(state.designer, T + "import#Theme", {
            productStoreId: storeA,
            files: Object.assign(packageFiles(), {"assets/app.js": "alert(1)"})
        })
        // review: an import is checked as a save is, so a draft never holds an event handler
        const handler = run(state.designer, T + "import#Theme", {
            productStoreId: storeA,
            files: Object.assign(packageFiles(), {"sections/note.html.fancy-locked": '<aside onclick="steal()">x</aside>'})
        })
        Object.assign(state, {at, removed, hidden, dropNote, fileRemoved, liquid, scriptFile, handler})
    },
    then() {
        const {at, removed, hidden, dropNote, fileRemoved, liquid, scriptFile, handler} = state
        code(handler) === "THEME_SOURCE_INVALID"
        handler.error.includes("sections/note.html.fancy-locked:")
        code(removed) === "REQUIRED_COMPONENT"
        removed.error.includes("shop.checkout")
        code(hidden) === "REQUIRED_COMPONENT"
        dropNote.error === ""
        dropNote.draftRevision === at + 1
        code(fileRemoved) === "REQUIRED_COMPONENT"
        code(liquid) === "ENGINE_UNSUPPORTED"
        code(scriptFile) === "FILE_KIND_REFUSED"
        scriptFile.error.includes("assets/app.js")
    }
})

feature("an image must be its type and is scanned; an export of a release with an image holds no secret", {
    when() {
        const at = revision(state.themeId)
        const mismatch = run(state.designer, T + "store#ThemeAsset", {
            themeId: state.themeId,
            expectedRevision: at,
            path: "hero.png",
            contentBase64: jpegBytes
        })
        const noScanner = System.getProperty("pass_scanner_service")
            ? {error: "SCANNER_UNAVAILABLE: skipped (a scanner is configured)"}
            : run(state.designer, T + "store#ThemeAsset", {
                  themeId: state.themeId,
                  expectedRevision: at,
                  path: "hero.png",
                  contentBase64: png
              })
        const svg = run(state.designer, T + "store#ThemeAsset", {
            themeId: state.themeId,
            expectedRevision: at,
            path: "mark.svg",
            text: '<svg xmlns="http://www.w3.org/2000/svg" onload="x()"><script>alert(1)</script><rect width="4" height="4"/></svg>'
        })
        // the image as an operator's package would carry it (the release keeps its bytes)
        system(() =>
            themes().putDraftFiles(one("mantle.public.PublicTheme", {themeId: state.themeId}), {"assets/hero.png": png}, "spec")
        )
        const assets = run(state.designer, T + "get#ThemeAssets", {themeId: state.themeId})
        const validated = run(state.publisher, T + "validate#Theme", {themeId: state.themeId})
        const published = run(state.publisher, T + "publish#Theme", {
            operationKey: key(),
            themeId: state.themeId,
            siteId: site,
            validationDigest: validated.validationDigest,
            expectedActiveRevision: 0
        })
        const exported = run(state.publisher, T + "export#ThemeRelease", {releaseId: published.releaseId, includeFiles: true})
        // Shop F55: the release pins the image by its bytes; the export still carries the base64 an import takes
        const pinned = one("mantle.public.PublicThemeReleaseFile", {releaseId: published.releaseId, filePath: "assets/hero.png"})
        Object.assign(state, {mismatch, noScanner, svg, assets, validated, published, exported, pinned})
    },
    then() {
        const {mismatch, noScanner, svg, assets, validated, published, exported, pinned} = state
        code(mismatch) === "ASSET_TYPE_MISMATCH"
        code(noScanner) === "SCANNER_UNAVAILABLE"
        svg.error === ""
        !draftText(state.themeId, "assets/mark.svg").includes("script")
        !draftText(state.themeId, "assets/mark.svg").includes("onload")
        assets.assets.find(asset => asset.path === "assets/hero.png").binary === true
        validated.ok === true
        published.error === ""
        exported.files["assets/hero.png"] === png
        pinned.digest !== ec.resource.digestText(png, "sha256")
        Number(pinned.fileSize) === 70
        pinned.contentType === "image/png"
        !/password|secret|apiKey|credential|organizationPartyId|THMAUT_ORG|dbresource:/i.test(JSON.stringify(exported))
    }
})

feature("a page's template key must be a page template of the site's themes (F77)", {
    when() {
        const unknown = run(state.designer, T + "store#SitePage", {
            siteId: site,
            title: "FAQ",
            routePath: "faq",
            templateKey: "page.faq",
            pageText: "# FAQ\n"
        })
        const at = revision(state.themeId)
        const added = run(state.developer, T + "change#ThemeFile", {
            themeId: state.themeId,
            expectedRevision: at,
            operation: "add",
            path: "templates/page.faq.json",
            text: JSON.stringify({sections: {main: {type: "main"}}}),
            changeReason: "FAQ layout"
        })
        const known = run(state.designer, T + "store#SitePage", {
            siteId: site,
            title: "FAQ",
            routePath: "faq",
            templateKey: "page.faq",
            pageText: "# FAQ\n"
        })
        const notPage = run(state.designer, T + "assign#ThemeTemplate", {
            themeId: state.themeId,
            targetKind: "page",
            sitePageId: known.sitePageId,
            templateKey: "product"
        })
        const cleared = run(state.designer, T + "assign#ThemeTemplate", {
            themeId: state.themeId,
            targetKind: "page",
            sitePageId: known.sitePageId,
            templateKey: ""
        })
        Object.assign(state, {unknown, added, known, notPage, cleared})
    },
    then() {
        const {unknown, added, known, notPage, cleared} = state
        code(unknown) === "TEMPLATE_UNKNOWN"
        added.error === ""
        known.error === ""
        code(notPage) === "TEMPLATE_UNKNOWN"
        cleared.error === ""
        one("mantle.public.PublicSitePage", {sitePageId: known.sitePageId}).templateKey == null
    }
})

feature("a preview needs the site's preview host and answers only its token on that host, with synthetic private state", {
    when() {
        const noHost = run(state.designer, T + "create#ThemePreview", {themeId: state.themeId, siteId: site, pageKind: "cart"})
        system(() =>
            make("mantle.public.PublicSiteHost", {
                hostname: previewHost,
                siteId: site,
                canonical: "N",
                hostKindEnumId: "PshkPreview"
            })
        )
        const outsiderPreview = run(state.outsider, T + "create#ThemePreview", {
            themeId: state.themeId,
            siteId: site,
            pageKind: "cart"
        })
        const made = run(state.designer, T + "create#ThemePreview", {themeId: state.themeId, siteId: site, pageKind: "cart"})
        const token = String(made.previewPath || "")
            .split("/")
            .pop()
        const page = run(null, T + "get#ThemePreviewPage", {siteId: site, hostname: previewHost, token})
        const asset = run(null, T + "get#ThemePreviewPage", {siteId: site, hostname: previewHost, token, assetPath: "store.css"})
        const otherHost = run(null, T + "get#ThemePreviewPage", {siteId: site, hostname: "shop.thmaut.example.test", token})
        const forged = run(null, T + "get#ThemePreviewPage", {
            siteId: site,
            hostname: previewHost,
            token: token.slice(0, -1) + (token.endsWith("Q") ? "R" : "Q")
        })
        const hostKind = run(null, T + "get#PreviewHost", {siteId: site, hostname: previewHost})
        const row = one("mantle.public.PublicThemePreview", {previewId: made.previewId})
        const tokenShaped = /^[A-Za-z0-9]{20,80}$/.test(token)
        Object.assign(state, {noHost, outsiderPreview, made, token, tokenShaped, page, asset, otherHost, forged, hostKind, row})
    },
    then() {
        const {noHost, outsiderPreview, made, token, tokenShaped, page, asset, otherHost, forged, hostKind, row} = state
        code(noHost) === "NO_PREVIEW_HOST"
        code(outsiderPreview) === "RECORD_UNAVAILABLE"
        made.error === ""
        made.previewHost === previewHost
        tokenShaped
        row.tokenDigest === ec.resource.digestText(token, "sha256")
        !JSON.stringify(row.getMap()).includes(token)
        page.error === ""
        page.pageKind === "cart"
        page.sample === true
        page.view.cart.itemCount === 2
        page.view.shop.name === "Authoring store"
        page.files["templates/cart.json"] != null
        asset.asset.text === "body { color: #222; }"
        code(otherHost) === "NOT_AVAILABLE"
        code(forged) === "NOT_AVAILABLE"
        hostKind.preview === true
    }
})

feature("store#Mounts binds a preview host, never canonical, and a save that does not name preview keeps its kind", {
    when() {
        const live = "live.thmaut.example.test",
            bound = "bound-preview.thmaut.example.test"
        const policy = () => Number(one("mantle.public.PublicSite", {siteId: site}).policyRevision || 0)
        const mounts = hosts =>
            run("john.doe", "mantle.public.SiteServices.store#Mounts", {
                input: {siteId: site, expectedRevision: policy(), mounts: [], hosts}
            })
        const canonicalPreview = mounts([{hostname: bound, canonical: true, preview: true}])
        const refusedKind = one("mantle.public.PublicSiteHost", {hostname: bound})?.hostKindEnumId ?? null
        const bind = mounts([
            {hostname: live, canonical: true},
            {hostname: bound, preview: true}
        ])
        const resaved = mounts([{hostname: bound}])
        const kind = hostname => one("mantle.public.PublicSiteHost", {hostname})?.hostKindEnumId
        const apps = ec.resource.script("component://mr-mantle/service/mantle/public/PublicApps.js")
        Object.assign(state, {
            canonicalPreview,
            refusedKind,
            bind,
            resaved,
            liveKind: kind(live),
            boundKind: kind(bound),
            pageUrl: system(() => apps.pageUrl(site, "shop", "/")),
            shopMount: one("mantle.public.PublicSiteApp", {siteId: site, appMountId: "shop"})
        })
    },
    then() {
        const {canonicalPreview, refusedKind, bind, resaved, liveKind, boundKind, pageUrl, shopMount} = state
        // PREVIEW_NOT_CANONICAL[hosts], a field error
        canonicalPreview.error !== ""
        refusedKind === null
        bind.error === ""
        resaved.error === ""
        liveKind === "PshkLive"
        boundKind === "PshkPreview"
        pageUrl === "https://live.thmaut.example.test/"
        shopMount != null
    }
})
