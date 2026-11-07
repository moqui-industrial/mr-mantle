// Site pages and navigation (impl-commerce P4, X14; mantle.public.ThemeServices' page and navigation part, SitePages.js,
// and SiteServices' get#SitePage, get#SiteNavigation and resolve#SiteRedirect): the Forum's role lookup unchanged and
// out of Commerce's reach; a page bound by mount, route and locale, its text in a store page space with restrictUpdate that
// the designer writes only through store#SitePage; the exact-version rule (a saved version is not live until published) and
// the window (scheduled, withdrawn); the publication job's revalidation as the author (a lost grant leaves the old version
// live, with a readiness finding); navigation validation (a draft product, another scheme, a private BOSS link, a reserved
// path, a loop, a redirect off the site) and the live menu and redirect; the generation each publication advances.
// Standalone: spec-local organizations, users, store, products and a published site with a Shop mount; artifact
// authorization disabled (the rules are the services' own checks). Run: ./moq test mr-mantle --spec SitePages
const T = "mantle.public.ThemeServices."
const SS = "mantle.public.SiteServices."
const prefix = "STPG"
const orgA = prefix + "_ORG_A",
    orgB = prefix + "_ORG_B"
const ids = {
    store: prefix + "_STORE",
    other: prefix + "_OTHER",
    site: prefix + "_SITE",
    otherSite: prefix + "_OSITE",
    product: prefix + "_PUBLIC",
    draft: prefix + "_DRAFT",
    category: prefix + "_CAT"
}
const users = {}
const state = {}

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
const one = (entity, conditions) =>
    system(() => ec.entity.find(entity).condition(conditions).disableAuthz().one()?.getMap() || null)
function organization(partyId, name) {
    make("mantle.party.Party", {partyId, partyTypeEnumId: "PtyOrganization"})
    make("mantle.party.Organization", {partyId, organizationName: name})
    make("mantle.party.PartyRole", {partyId, roleTypeId: "OrgInternal"})
}
function user(kind, organizationPartyId, permissions) {
    const id = prefix + "_" + kind.toUpperCase()
    make("mantle.party.Party", {partyId: id, partyTypeEnumId: "PtyPerson"})
    make("mantle.party.Person", {partyId: id, firstName: "Pages", lastName: kind})
    make("mantle.party.PartyRelationship", {
        partyRelationshipId: id,
        fromPartyId: id,
        toPartyId: organizationPartyId,
        relationshipTypeEnumId: "PrtAgent",
        fromDate: 0
    })
    make("moqui.security.UserGroup", {userGroupId: id, description: "Site pages " + kind})
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
// a call as a user (none: anonymous), in its own transaction: its result and its refusal ("" when it succeeds)
function run(username, service, parameters = {}) {
    if (username) login(username)
    else logout()
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
const key = () => prefix + "-" + Math.random().toString(36).slice(2, 12)
const generation = () => Number(one("mantle.public.PublicSite", {siteId: ids.site}).generation || 0)
// the live page as a visitor reads it (SiteServices' input map)
const live = input => run(null, SS + "get#SitePage", {input: Object.assign({siteId: ids.site}, input)})
const page = sitePageId => one("mantle.public.PublicSitePage", {sitePageId})
const publish = (username, sitePageId, extra = {}) =>
    run(username, SS + "publish#SitePage", {
        input: Object.assign(
            {sitePageId, expectedRevision: page(sitePageId).publicationRevision || 0, operationKey: key()},
            extra
        )
    })
const nav = (username, parameters) => run(username, T + "store#SiteNavigation", Object.assign({siteId: ids.site}, parameters))

spec({
    setupSpec() {
        system(() => {
            organization(orgA, "Pages organization A")
            organization(orgB, "Pages organization B")
            make("mantle.product.store.ProductStore", {
                productStoreId: ids.store,
                storeName: "Pages store",
                organizationPartyId: orgA
            })
            make("mantle.product.store.ProductStore", {
                productStoreId: ids.other,
                storeName: "Other store",
                organizationPartyId: orgB
            })
            for (const [siteId, storeId] of [
                [ids.site, ids.store],
                [ids.otherSite, ids.other]
            ]) {
                make("mantle.public.PublicSite", {siteId, name: "Pages site " + siteId, state: "published", generation: 0})
                make("mantle.public.PublicSiteApp", {
                    siteId,
                    appMountId: "shop",
                    app: "shop",
                    pathPrefix: "/",
                    enabled: "Y",
                    targetId: storeId
                })
            }
            make("mantle.public.PublicSiteApp", {
                siteId: ids.site,
                appMountId: "account",
                app: "account",
                pathPrefix: "/account",
                enabled: "Y"
            })
            for (const productId of [ids.product, ids.draft])
                make("mantle.product.Product", {
                    productId,
                    productName: "Pages " + productId,
                    productTypeEnumId: "PtDigital",
                    ownerPartyId: orgA
                })
            // the one product the store publishes; the draft has no publication
            make("mantle.product.store.ProductStoreProduct", {productStoreId: ids.store, productId: ids.product})
            // a browse root of the store, for a menu's category item
            make("mantle.product.category.ProductCategory", {
                productCategoryId: ids.category,
                categoryName: "Pages shelf",
                ownerPartyId: orgA
            })
            make("mantle.product.store.ProductStoreCategory", {
                productStoreId: ids.store,
                productCategoryId: ids.category,
                storeCategoryTypeEnumId: "PsctBrowseRoot",
                fromDate: 0
            })
            users.designer = user("designer", orgA, ["COMMERCE_VIEW", "COMMERCE_THEME_EDIT"])
            users.publisher = user("publisher", orgA, ["COMMERCE_VIEW", "COMMERCE_PUBLISH"])
            users.merchandiser = user("merchandiser", orgA, ["COMMERCE_VIEW", "COMMERCE_MERCHANDISE"])
            users.lead = user("lead", orgA, ["COMMERCE_VIEW", "COMMERCE_THEME_EDIT", "COMMERCE_PUBLISH"])
            users.outsider = user("outsider", orgB, ["COMMERCE_VIEW", "COMMERCE_THEME_EDIT", "COMMERCE_PUBLISH"])
        })
    },
    cleanup() {
        login("john.doe")
    }
})

feature("the Forum's guidelines page binds and reads by its role as before, and Commerce does not reach it", {
    when() {
        const wiki = (verb, input) => call("org.moqui.impl.WikiServices." + verb, input)
        let wikiPageId, versionName
        system(() => {
            wiki("create#WikiSpace", {wikiSpaceId: "STPGFRM", description: "Forum page fixture"})
            wikiPageId = wiki("update#WikiPage", {
                wikiSpaceId: "STPGFRM",
                pageName: "Guidelines",
                pageText: "Be kind\n"
            }).wikiPageId
            versionName = wiki("get#WikiPageHistory", {wikiPageId}).versionList[0].versionName
            wiki("set#PublishedVersion", {wikiPageId, publishedVersionName: versionName})
        })
        const bound = run("john.doe", SS + "publish#SitePage", {
            input: {siteId: ids.site, pageRole: "guidelines", wikiPageId, versionName, expectedRevision: 0}
        })
        const read = live({pageRole: "guidelines"})
        const row = system(() =>
            ec.entity
                .find("mantle.public.PublicSitePage")
                .condition({siteId: ids.site, pageRole: "guidelines"})
                .disableAuthz()
                .one()
        )
        const listed = run(users.designer, T + "find#SitePages", {siteId: ids.site})
        const edit = run(users.designer, T + "store#SitePage", {sitePageId: row.sitePageId, title: "Changed"})
        const role = run(users.designer, T + "store#SitePage", {
            siteId: ids.site,
            title: "About",
            routePath: "about-us",
            pageRole: "about"
        })
        return {bound, read, row, listed, edit, role}
    },
    then({bound, read, row, listed, edit, role}) {
        bound.error == ""
        bound.result.revision == 1
        read.result.page.body.includes("Be kind")
        read.result.page.pageRole == "guidelines"
        !!row.sitePageId
        row.appMountId == null
        !listed.pages.some(p => p.sitePageId == row.sitePageId)
        code(edit) == "RECORD_UNAVAILABLE"
        code(role) == "ROLE_RESERVED"
    }
})

feature(
    "a designer drafts a returns page on the Shop's route; a publisher publishes it and visitors read it by route, locale and role",
    {
        when() {
            const before = generation()
            const created = run(users.designer, T + "store#SitePage", {
                siteId: ids.site,
                title: "Returns policy",
                routePath: "returns",
                locale: "en",
                pageRole: "returns",
                seoTitle: "Returns",
                pageText: "# Returns\n\nThirty days.\n"
            })
            state.pageId = created.sitePageId
            const draft = live({appMountId: "shop", routePath: "returns", locale: "en"})
            const binding = page(state.pageId)
            const wikiPage = one("moqui.resource.wiki.WikiPage", {wikiPageId: binding.wikiPageId})
            const space = one("moqui.resource.wiki.WikiSpace", {wikiSpaceId: wikiPage.wikiSpaceId})
            const grantLeft = one("moqui.resource.wiki.WikiSpaceUser", {
                wikiSpaceId: wikiPage.wikiSpaceId,
                userId: users.designer
            })
            // written as the system, the save is still the designer's in the wiki's history
            const saved = one("moqui.resource.wiki.WikiPageHistory", {wikiPageId: binding.wikiPageId})
            const taken = run(users.designer, T + "store#SitePage", {
                siteId: ids.site,
                title: "Other",
                routePath: "returns",
                locale: "en"
            })
            const roleTaken = run(users.designer, T + "store#SitePage", {
                siteId: ids.site,
                title: "Other",
                routePath: "returns-two",
                pageRole: "returns"
            })
            const designerPublishes = publish(users.designer, state.pageId, {versionName: created.versionName})
            const outsider = publish(users.outsider, state.pageId, {versionName: created.versionName})
            const outsiderNew = run(users.outsider, T + "store#SitePage", {siteId: ids.site, title: "Mine", routePath: "mine"})
            const published = publish(users.publisher, state.pageId, {versionName: created.versionName, changeReason: "Spec"})
            state.versionOne = created.versionName
            const byRoute = live({appMountId: "shop", routePath: "returns", locale: "en_US"})
            const byRole = live({pageRole: "returns"})
            return {
                before,
                after: generation(),
                created,
                draft,
                space,
                grantLeft,
                wikiPage,
                saved,
                taken,
                roleTaken,
                designerPublishes,
                outsider,
                outsiderNew,
                published,
                byRoute,
                byRole
            }
        },
        then(r) {
            r.created.error == ""
            !!r.created.versionName
            code(r.draft) == "NOT_FOUND"
            r.space.restrictUpdate == "Y"
            r.grantLeft == null
            r.wikiPage.createdByUserId == users.designer
            r.saved.userId == users.designer
            code(r.taken) == "ROUTE_TAKEN"
            code(r.roleTaken) == "ROLE_TAKEN"
            code(r.designerPublishes) == "PERMISSION_DENIED"
            code(r.outsider) == "RECORD_UNAVAILABLE"
            code(r.outsiderNew) == "RECORD_UNAVAILABLE"
            r.published.result.state == "published"
            r.after == r.before + 1
            r.byRoute.result.page.body.includes("Thirty days")
            r.byRoute.result.page.url == "/pages/returns"
            r.byRole.result.page.sitePageId == state.pageId
            r.byRole.result.page.version == state.versionOne
        }
    }
)

feature("a published page's binding changes only with COMMERCE_PUBLISH and its revision, which advance; a draft's as before", {
    when() {
        const before = page(state.pageId)
        const generationBefore = generation()
        const change = (username, extra) =>
            run(username, T + "store#SitePage", Object.assign({sitePageId: state.pageId, seoTitle: "Returns and refunds"}, extra))
        const designer = change(users.designer, {expectedRevision: before.publicationRevision})
        const noRevision = change(users.lead, {})
        const changed = change(users.lead, {expectedRevision: before.publicationRevision})
        const after = page(state.pageId)
        const draft = run(users.designer, T + "store#SitePage", {siteId: ids.site, title: "Help", routePath: "help"})
        const draftChanged = run(users.designer, T + "store#SitePage", {sitePageId: draft.sitePageId, title: "Help centre"})
        return {before, generationBefore, designer, noRevision, changed, after, draftChanged, generation: generation()}
    },
    then(r) {
        code(r.designer) == "PERMISSION_DENIED"
        code(r.noRevision) == "REVISION_STALE"
        r.changed.error == ""
        r.after.seoTitle == "Returns and refunds"
        r.after.publicationRevision == r.before.publicationRevision + 1
        r.generation == r.generationBefore + 1
        r.draftChanged.error == ""
        r.draftChanged.generation == null
    }
})

feature("a saved version is not live until published, a stale or unknown version is refused, and a withdrawal ends the page", {
    when() {
        const binding = page(state.pageId)
        const saved = run(users.designer, T + "store#SitePage", {
            sitePageId: state.pageId,
            pageText: "# Returns\n\nSixty days.\n",
            versionNote: "Longer"
        })
        const stillOld = live({pageRole: "returns"})
        const unknown = publish(users.publisher, state.pageId, {versionName: "nope"})
        const stale = run(users.publisher, SS + "publish#SitePage", {
            input: {sitePageId: state.pageId, versionName: saved.versionName, expectedRevision: 0, operationKey: key()}
        })
        const retryKey = key()
        const second = publish(users.publisher, state.pageId, {versionName: saved.versionName, operationKey: retryKey})
        const retried = run(users.publisher, SS + "publish#SitePage", {
            input: {sitePageId: state.pageId, versionName: saved.versionName, expectedRevision: 1, operationKey: retryKey}
        })
        const newer = live({pageRole: "returns"})
        const withdrawn = publish(users.publisher, state.pageId, {publishAction: "withdraw"})
        const gone = live({pageRole: "returns"})
        state.versionTwo = saved.versionName
        return {binding, saved, stillOld, unknown, stale, second, retried, newer, withdrawn, gone}
    },
    then(r) {
        r.saved.error == ""
        r.saved.versionName != state.versionOne
        r.stillOld.result.page.body.includes("Thirty days")
        code(r.unknown) == "VERSION_UNKNOWN"
        code(r.stale) == "REVISION_STALE"
        r.second.result.state == "published"
        r.retried.result.alreadyApplied == true
        r.newer.result.page.body.includes("Sixty days")
        r.withdrawn.result.state == "withdrawn"
        code(r.gone) == "NOT_FOUND"
    }
})

feature(
    "a scheduled publication waits; the job publishes it as its author, and one whose author lost the grant stays unpublished with a readiness finding",
    {
        when() {
            const later = ec.user.nowTimestamp.getTime ? ec.user.nowTimestamp.getTime() + 3600000 : Date.now() + 3600000
            const scheduled = publish(users.publisher, state.pageId, {versionName: state.versionOne, fromDate: later})
            const waiting = live({pageRole: "returns"})
            const due = () =>
                system(() =>
                    call("update#mantle.public.PublicSitePage", {sitePageId: state.pageId, scheduledFromDate: Date.now() - 1000})
                )
            due()
            const before = generation()
            const job = run("john.doe", T + "run#ScheduledSitePublications", {})
            const activated = live({pageRole: "returns"})
            // a second schedule by a publisher who then loses COMMERCE_PUBLISH
            const lost = publish(users.publisher, state.pageId, {versionName: state.versionTwo, fromDate: later})
            system(() =>
                call("update#moqui.security.UserGroupPermission", {
                    userGroupId: users.publisher,
                    userPermissionId: "COMMERCE_PUBLISH",
                    fromDate: 0,
                    thruDate: Date.now() - 1000
                })
            )
            due()
            const refused = run("john.doe", T + "run#ScheduledSitePublications", {})
            const after = page(state.pageId)
            const stillLive = live({pageRole: "returns"})
            const readiness = run(users.designer, "mantle.product.StoreAdminServices.check#StoreReadiness", {
                productStoreId: ids.store
            })
            system(() =>
                call("update#moqui.security.UserGroupPermission", {
                    userGroupId: users.publisher,
                    userPermissionId: "COMMERCE_PUBLISH",
                    fromDate: 0,
                    thruDate: null
                })
            )
            return {
                scheduled,
                waiting,
                before,
                job,
                activated,
                lost,
                refused,
                after,
                stillLive,
                readiness,
                generation: generation()
            }
        },
        then(r) {
            r.scheduled.result.state == "scheduled"
            code(r.waiting) == "NOT_FOUND"
            r.job.error == ""
            r.activated.result.page.version == state.versionOne
            r.lost.result.state == "scheduled"
            r.after.failureCode == "PERMISSION_DENIED"
            r.after.versionName == state.versionOne
            r.stillLive.result.page.version == state.versionOne
            r.readiness.findings.find(f => f.key == "sitePublication").ready == false
            r.readiness.findings.find(f => f.key == "sitePublication").message.includes("Returns policy")
            r.generation == r.before + 1
        }
    }
)

feature(
    "navigation refuses a draft product, another scheme, a private link, a reserved path, a loop and a redirect off the site",
    {
        when() {
            const menu = nav(users.merchandiser, {menuKey: "main", name: "Main menu"})
            const navigationId = menu.navigationId
            const item = (label, destinationTypeEnumId, destinationValue, revision) =>
                nav(users.merchandiser, {
                    navigationId,
                    expectedRevision: revision,
                    item: {label, destinationTypeEnumId, destinationValue}
                })
            const draft = item("Draft", "SdtProduct", ids.draft, 0)
            const http = item("Plain", "SdtExternal", "http://example.com/", 0)
            const script = item("Script", "SdtExternal", "javascript:alert(1)", 0)
            const boss = item("Boss", "SdtExternal", "https://example.com/qapps/Commerce", 0)
            const reserved = item("Assets", "SdtPath", "/static/app.js", 0)
            const rest = item("Api", "SdtPath", "/rest/s1/mantle", 0)
            const product = item("Public product", "SdtProduct", ids.product, 0)
            const page = item("Returns", "SdtPage", state.pageId, 1)
            const external = item("Partner", "SdtExternal", "https://partner.example.com/x", 2)
            const category = item("Shelf", "SdtCategory", ids.category, 3)
            const redirect = (oldPath, destinationTypeEnumId, destinationValue) =>
                nav(users.merchandiser, {redirect: {oldPath, destinationTypeEnumId, destinationValue}})
            const toApi = redirect("/old-api", "SdtPath", "/api/v1")
            const fromReserved = redirect("/static/x", "SdtPath", "/pages/returns")
            const offSite = redirect("/partner", "SdtExternal", "https://partner.example.com/")
            const intoAccount = redirect("/account/old", "SdtPath", "/pages/returns")
            const first = redirect("/old-a", "SdtPath", "/old-b")
            const loop = redirect("/old-b", "SdtPath", "/old-a")
            const self = redirect("/old-c", "SdtPath", "/old-c")
            state.navigationId = navigationId
            state.redirectId = first.redirectId
            return {
                menu,
                draft,
                http,
                script,
                boss,
                reserved,
                rest,
                product,
                page,
                external,
                category,
                toApi,
                fromReserved,
                offSite,
                intoAccount,
                first,
                loop,
                self
            }
        },
        then(r) {
            r.menu.error == ""
            code(r.draft) == "DESTINATION_NOT_PUBLIC"
            code(r.http) == "SCHEME_REFUSED"
            code(r.script) == "SCHEME_REFUSED"
            code(r.boss) == "PRIVATE_LINK"
            code(r.reserved) == "PATH_RESERVED"
            code(r.rest) == "PRIVATE_LINK"
            r.product.draftRevision == 1
            r.page.draftRevision == 2
            r.external.draftRevision == 3
            r.category.draftRevision == 4
            code(r.toApi) == "PATH_RESERVED"
            code(r.fromReserved) == "PATH_RESERVED"
            code(r.offSite) == "REDIRECT_OFF_SITE"
            code(r.intoAccount) == "PATH_RESERVED"
            r.first.error == ""
            code(r.loop) == "REDIRECT_LOOP"
            code(r.self) == "REDIRECT_LOOP"
        }
    }
)

feature(
    "a published menu and redirect are live, a page a menu links to needs confirming to withdraw, and each publication advances the generation",
    {
        when() {
            const before = generation()
            const merchandiserPublishes = run(users.merchandiser, T + "publish#SiteNavigation", {
                siteId: ids.site,
                navigationId: state.navigationId,
                expectedRevision: 4,
                operationKey: key()
            })
            const notLive = run(null, SS + "get#SiteNavigation", {input: {siteId: ids.site}})
            // the page the menu links to is published again (it was withdrawn above)
            const republished = publish(users.publisher, state.pageId, {versionName: state.versionTwo})
            const menu = run(users.publisher, T + "publish#SiteNavigation", {
                siteId: ids.site,
                navigationId: state.navigationId,
                expectedRevision: 4,
                operationKey: key()
            })
            const navigation = run(null, SS + "get#SiteNavigation", {input: {siteId: ids.site, locale: "en-US"}})
            const redirect = run(users.publisher, T + "publish#SiteNavigation", {
                siteId: ids.site,
                redirectId: state.redirectId,
                expectedRevision: 1,
                operationKey: key()
            })
            const resolved = run(null, SS + "resolve#SiteRedirect", {input: {siteId: ids.site, path: "/old-a/"}})
            const unconfirmed = publish(users.publisher, state.pageId, {publishAction: "withdraw"})
            const confirmed = publish(users.publisher, state.pageId, {publishAction: "withdraw", confirmReferences: true})
            const without = run(null, SS + "get#SiteNavigation", {input: {siteId: ids.site}})
            return {
                before,
                merchandiserPublishes,
                notLive,
                republished,
                menu,
                navigation,
                redirect,
                resolved,
                unconfirmed,
                confirmed,
                without,
                after: generation()
            }
        },
        then(r) {
            code(r.merchandiserPublishes) == "PERMISSION_DENIED"
            r.notLive.result.navigation == []
            r.menu.state == "published"
            r.navigation.result.navigation.map(i => i.label) == ["Public product", "Returns", "Partner", "Shelf"]
            r.navigation.result.navigation[0].url.startsWith("/products/" + ids.product + "/")
            r.navigation.result.navigation[1].url == "/pages/returns"
            r.navigation.result.navigation[3].url == "/categories/" + ids.category + "/pages-shelf"
            r.redirect.state == "published"
            r.resolved.result.url == "/old-b"
            r.resolved.result.status == 301
            code(r.unconfirmed) == "PAGE_REFERENCED"
            r.confirmed.result.state == "withdrawn"
            r.without.result.navigation.map(i => i.label) == ["Public product", "Partner", "Shelf"]
            r.after == r.before + 4
        }
    }
)

feature("a scheduled redirect whose author can no longer sign in fails at its date with a finding, and is published again", {
    when() {
        const later = Date.now() + 3600000
        const saved = nav(users.merchandiser, {
            redirect: {oldPath: "/old-d", destinationTypeEnumId: "SdtPath", destinationValue: "/old-b"}
        })
        const scheduled = run(users.publisher, T + "publish#SiteNavigation", {
            siteId: ids.site,
            redirectId: saved.redirectId,
            fromDate: later,
            expectedRevision: saved.revision,
            operationKey: key()
        })
        const account = disabled => system(() => call("update#moqui.security.UserAccount", {userId: users.publisher, disabled}))
        system(() => call("update#mantle.public.PublicSiteRedirect", {redirectId: saved.redirectId, fromDate: Date.now() - 1000}))
        account("Y")
        const job = run("john.doe", T + "run#ScheduledSitePublications", {})
        account("N")
        const failed = one("mantle.public.PublicSiteRedirect", {redirectId: saved.redirectId})
        // its from date has passed: published again it is live from now
        const again = run(users.publisher, T + "publish#SiteNavigation", {
            siteId: ids.site,
            redirectId: saved.redirectId,
            expectedRevision: failed.revision,
            operationKey: key()
        })
        const resolved = run(null, SS + "resolve#SiteRedirect", {input: {siteId: ids.site, path: "/old-d"}})
        return {scheduled, job, failed, again, resolved}
    },
    then(r) {
        r.scheduled.state == "scheduled"
        r.job.error == ""
        r.failed.publicationStateEnumId == "SpsFailed"
        r.failed.failureCode == "AUTHOR_UNAVAILABLE"
        r.again.state == "published"
        r.resolved.result.url == "/old-b"
    }
})

feature(
    "a scheduled menu version or redirect whose window ended before the job reached it fails, WINDOW_PASSED; one due is live",
    {
        when() {
            const past = Date.now() - 60000
            const version = (fromDate, thruDate) =>
                system(() =>
                    make("mantle.public.PublicSiteNavigationVersion", {
                        navigationId: state.navigationId,
                        fromDate,
                        thruDate,
                        draftRevision: 4,
                        snapshotText: "[]",
                        publicationStateEnumId: "SpsScheduled",
                        publishedByUserId: users.publisher,
                        publishedDate: past
                    })
                )
            version(past, past + 1000)
            version(past + 2000, null)
            const saved = nav(users.merchandiser, {
                redirect: {oldPath: "/old-e", destinationTypeEnumId: "SdtPath", destinationValue: "/old-b"}
            })
            run(users.publisher, T + "publish#SiteNavigation", {
                siteId: ids.site,
                redirectId: saved.redirectId,
                fromDate: Date.now() + 3600000,
                expectedRevision: saved.revision,
                operationKey: key()
            })
            system(() =>
                call("update#mantle.public.PublicSiteRedirect", {
                    redirectId: saved.redirectId,
                    fromDate: past,
                    thruDate: past + 1000
                })
            )
            const job = run("john.doe", T + "run#ScheduledSitePublications", {})
            const versionAt = at =>
                one("mantle.public.PublicSiteNavigationVersion", {
                    navigationId: state.navigationId,
                    fromDate: new Date(at).toISOString()
                })
            const redirect = one("mantle.public.PublicSiteRedirect", {redirectId: saved.redirectId})
            return {job, passed: versionAt(past), due: versionAt(past + 2000), redirect}
        },
        then(r) {
            r.job.error == ""
            r.passed.publicationStateEnumId == "SpsFailed"
            r.passed.failureCode == "WINDOW_PASSED"
            r.due.publicationStateEnumId == "SpsActive"
            r.redirect.publicationStateEnumId == "SpsFailed"
            r.redirect.failureCode == "WINDOW_PASSED"
        }
    }
)
