// Store publication and categories (impl-commerce P3, COM-MERCH, SHOP-CATALOG's resolver core;
// mantle.product.StoreMerchandisingServices, StoreMerchandising.js): the resolver (no row, a published virtual product and
// its variants, an excluded variant, a future row, a withdrawal, an empty allow category, a row made the old way with no
// date or kind; what the public is told); the batch's permissions, reason, per-product results, retry, stale revision and
// past date, and the site generation it advances; the storefront details as a new dated row; the category moves' cycle,
// date and shared-store refusals, a reorder and the membership saves.
// Standalone: spec-local organizations, users, products, categories, stores and a site; artifact authorization disabled
// (the rules are the services' own checks). Run: ./moq test mr-mantle --spec StorePublication
const M = "mantle.product.StoreMerchandisingServices."
const S = "mantle.product.store."
const prefix = "STPUB"
const orgA = prefix + "_ORG_A",
    orgB = prefix + "_ORG_B"
const ids = {
    store: prefix + "_STORE",
    shared: prefix + "_SHARED",
    allow: prefix + "_ALLOW",
    other: prefix + "_OTHER",
    site: prefix + "_SITE",
    virtual: prefix + "_VAR",
    red: prefix + "_VAR_RED",
    blue: prefix + "_VAR_BLUE",
    plain: prefix + "_PLAIN",
    second: prefix + "_SECOND",
    legacy: prefix + "_LEGACY",
    root: prefix + "_ROOT",
    one: prefix + "_C1",
    two: prefix + "_C2",
    three: prefix + "_C3",
    empty: prefix + "_EMPTY"
}

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
    make("mantle.party.Person", {partyId: id, firstName: "Publication", lastName: kind})
    make("mantle.party.PartyRelationship", {
        partyRelationshipId: id,
        fromPartyId: id,
        toPartyId: organizationPartyId,
        relationshipTypeEnumId: "PrtAgent",
        fromDate: 0
    })
    make("moqui.security.UserGroup", {userGroupId: id, description: "Store publication " + kind})
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
const users = {}
// a call as a user, in its own transaction: its result and its refusal code ("" when it succeeds)
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
const publish = (username, productIds, action, extra = {}) =>
    run(
        username,
        M + "publish#StoreProducts",
        Object.assign({productStoreId: ids.store, productIds, action, changeReason: "Spec", operationKey: key()}, extra)
    )
const resolve = (productIds, extra = {}) =>
    run(users.reader, M + "get#StorePublication", Object.assign({productStoreId: ids.store, productIds}, extra)).products || []
const byId = (answers, productId) => answers.find(answer => answer.productId === productId) || {}
const generation = () => Number(list("mantle.public.PublicSite", {siteId: ids.site})[0].generation || 0)

spec({
    setupSpec() {
        system(() => {
            organization(orgA, "Publication organization A")
            organization(orgB, "Publication organization B")
            for (const [storeId, org] of [
                [ids.store, orgA],
                [ids.shared, orgA],
                [ids.allow, orgA],
                [ids.other, orgB]
            ])
                make(S + "ProductStore", {productStoreId: storeId, storeName: "Publication " + storeId, organizationPartyId: org})
            make("mantle.public.PublicSite", {siteId: ids.site, name: "Publication site", state: "published", generation: 0})
            make("mantle.public.PublicSiteApp", {
                siteId: ids.site,
                appMountId: "shop",
                app: "shop",
                pathPrefix: "/shop",
                enabled: "Y",
                targetId: ids.store
            })
            for (const productId of [ids.virtual, ids.red, ids.blue, ids.plain, ids.second, ids.legacy])
                make("mantle.product.Product", {
                    productId,
                    productName: "Publication " + productId,
                    productTypeEnumId: productId === ids.virtual ? "PtVirtual" : "PtDigital",
                    ownerPartyId: orgA
                })
            for (const variantId of [ids.red, ids.blue])
                make("mantle.product.ProductAssoc", {
                    productId: ids.virtual,
                    toProductId: variantId,
                    productAssocTypeEnumId: "PatVariant",
                    fromDate: 0
                })
            // the store's tree: root > one > three, root > two; the shared store shows one, the other organization's two
            for (const categoryId of [ids.root, ids.one, ids.two, ids.three, ids.empty])
                make("mantle.product.category.ProductCategory", {
                    productCategoryId: categoryId,
                    categoryName: "Publication " + categoryId,
                    ownerPartyId: orgA
                })
            const rollup = (child, parent, sequenceNum) =>
                make("mantle.product.category.ProductCategoryRollup", {
                    productCategoryId: child,
                    parentProductCategoryId: parent,
                    fromDate: 0,
                    sequenceNum
                })
            rollup(ids.one, ids.root, 1)
            rollup(ids.two, ids.root, 2)
            rollup(ids.three, ids.one, 1)
            const role = (storeId, categoryId, type) =>
                make(S + "ProductStoreCategory", {
                    productStoreId: storeId,
                    productCategoryId: categoryId,
                    storeCategoryTypeEnumId: type,
                    fromDate: 0
                })
            role(ids.store, ids.root, "PsctBrowseRoot")
            role(ids.shared, ids.one, "PsctBrowseRoot")
            role(ids.other, ids.two, "PsctBrowseRoot")
            role(ids.allow, ids.empty, "PsctViewAllow")
            make("mantle.product.category.ProductCategoryMember", {
                productCategoryId: ids.three,
                productId: ids.plain,
                fromDate: 0
            })
            // a row made as before P3: no date and no kind given
            make(S + "ProductStoreProduct", {productStoreId: ids.store, productId: ids.legacy})
            users.reader = user("reader", orgA, ["COMMERCE_VIEW"])
            users.merchandiser = user("merchandiser", orgA, ["COMMERCE_VIEW", "COMMERCE_MERCHANDISE"])
            users.publisher = user("publisher", orgA, ["COMMERCE_VIEW", "COMMERCE_MERCHANDISE", "COMMERCE_PUBLISH"])
            users.other = user("other", orgB, ["COMMERCE_VIEW", "COMMERCE_MERCHANDISE", "COMMERCE_PUBLISH"])
        })
    }
})

feature("a store publishes nothing without rows; a row made the old way, with no date or kind, is published", {
    when() {
        return {
            before: resolve([ids.plain, ids.virtual, ids.red]),
            legacy: resolve([ids.legacy]),
            listed: run(users.reader, M + "get#StorePublication", {productStoreId: ids.allow}),
            legacyRow: list(S + "ProductStoreProduct", {productStoreId: ids.store, productId: ids.legacy})
        }
    },
    then({before, legacy, listed, legacyRow}) {
        before.map(answer => answer.isPublic) == [false, false, false]
        before.map(answer => answer.reasonCode) == ["NOT_PUBLISHED", "NOT_PUBLISHED", "NOT_PUBLISHED"]
        legacy[0].isPublic == true
        legacy[0].via == "own"
        legacyRow.length == 1
        legacyRow[0].fromDate != null
        listed.products == []
    }
})

feature(
    "publishing needs COMMERCE_PUBLISH and a reason; a virtual product's row covers its variants, an exclusion leaves one out, each result per product",
    {
        when() {
            const merchandiser = publish(users.merchandiser, [ids.virtual], "publish")
            const other = publish(users.other, [ids.virtual], "publish")
            const noReason = publish(users.publisher, [ids.virtual], "publish", {changeReason: ""})
            const preview = run(users.reader, M + "preview#Publication", {
                productStoreId: ids.store,
                productIds: [ids.virtual],
                action: "publish"
            })
            const before = generation()
            const operationKey = key()
            const batch = publish(users.publisher, [ids.virtual, ids.plain], "publish", {operationKey})
            const retry = publish(users.publisher, [ids.virtual, ids.plain], "publish", {operationKey})
            const after = generation()
            const covered = resolve([ids.virtual, ids.red, ids.blue, ids.plain], {siteId: ids.site})
            const again = publish(users.publisher, [ids.virtual, ids.second], "publish")
            const excluded = publish(users.publisher, [ids.blue], "exclude")
            const notCovered = publish(users.publisher, [ids.second], "exclude")
            const afterExclusion = resolve([ids.red, ids.blue])
            const otherStore = run(users.reader, M + "get#StorePublication", {productStoreId: ids.shared, productIds: [ids.red]})
            // the public (no one signed in): the public answer in full, the excluded variant as its id only, and the list of
            // the public products only
            const anonymous = run(null, M + "get#StorePublication", {
                productStoreId: ids.store,
                productIds: [ids.red, ids.blue],
                siteId: ids.site
            })
            const anonymousList = run(null, M + "get#StorePublication", {productStoreId: ids.store, siteId: ids.site})
            // Shop P3 (impl-shop F50): the public names the site
            const anonymousNoSite = run(null, M + "get#StorePublication", {productStoreId: ids.store, productIds: [ids.red]})
            return {
                anonymous,
                anonymousList,
                anonymousNoSite,
                merchandiser,
                other,
                noReason,
                preview,
                before,
                batch,
                retry,
                after,
                covered,
                again,
                excluded,
                notCovered,
                afterExclusion,
                otherStore
            }
        },
        then({
            anonymous,
            anonymousList,
            anonymousNoSite,
            merchandiser,
            other,
            noReason,
            preview,
            before,
            batch,
            retry,
            after,
            covered,
            again,
            excluded,
            notCovered,
            afterExclusion,
            otherStore
        }) {
            code(merchandiser) == "PERMISSION_DENIED"
            code(other) == "RECORD_UNAVAILABLE"
            code(noReason) == "REASON_REQUIRED"
            preview.items[0].allowed == true
            preview.items[0].variants.map(variant => variant.productId).sort() == [ids.blue, ids.red]
            preview.items[0].coveredCount == 2
            preview.sites.map(site => site.siteId) == [ids.site]
            batch.error == ""
            batch.doneCount == 2
            retry.alreadyApplied == true
            retry.doneCount == 2
            after == before + 2
            covered.map(answer => answer.isPublic) == [true, true, true, true]
            byId(covered, ids.red).via == "virtual"
            byId(covered, ids.red).virtualProductId == ids.virtual
            again.doneCount == 1
            again.results.find(result => result.productId === ids.virtual).code == "ALREADY_PUBLISHED"
            again.results.find(result => result.productId === ids.second).ok == true
            excluded.doneCount == 1
            notCovered.results[0].code == "NOT_COVERED"
            byId(afterExclusion, ids.red).isPublic == true
            byId(afterExclusion, ids.blue).isPublic == false
            byId(afterExclusion, ids.blue).reasonCode == "VARIANT_EXCLUDED"
            otherStore.products[0].isPublic == false
            anonymous.error == ""
            byId(anonymous.products, ids.red).productName == "Publication " + ids.red
            Object.keys(byId(anonymous.products, ids.blue)).sort() == ["isPublic", "productId", "purchasable"]
            anonymousList.products.every(answer => answer.isPublic) == true
            !anonymousList.products.some(answer => answer.productId === ids.blue)
            code(anonymousNoSite) == "SITE_REQUIRED"
        }
    }
)

feature("a future row is public only from its date; a withdrawal ends the row; an empty allow category shows nothing", {
    when() {
        const tomorrow = Date.now() + 86400000
        const withdrawn = publish(users.publisher, [ids.second], "withdraw")
        const scheduled = publish(users.publisher, [ids.second], "publish", {fromDate: tomorrow})
        const now = resolve([ids.second])
        const later = resolve([ids.second], {asOfDate: tomorrow + 60000})
        const outsiderLater = run(users.other, M + "get#StorePublication", {
            productStoreId: ids.store,
            productIds: [ids.second],
            asOfDate: tomorrow + 60000
        })
        // the batch names each product's revision as the preview read it (through JSON, as PublishProducts posts it): a stale
        // one is refused naming the current; a past effective time is refused
        const seen = run(users.reader, M + "preview#Publication", {
            productStoreId: ids.store,
            productIds: [ids.second],
            action: "withdraw"
        }).items[0].lastUpdatedStamp
        const stale = publish(users.publisher, [ids.second], "withdraw", {expectedLastUpdatedStamps: {[ids.second]: 1000}})
        const past = publish(users.publisher, [ids.plain], "withdraw", {fromDate: Date.now() - 86400000})
        const unscheduled = publish(users.publisher, [ids.second], "withdraw", {
            expectedLastUpdatedStamps: JSON.parse(JSON.stringify({[ids.second]: seen}))
        })
        const rowsLeft = list(S + "ProductStoreProduct", {productStoreId: ids.store, productId: ids.second})
        // the allow store: the plain product published there, but its view-allow category has no members
        const allowStore = run(users.publisher, M + "publish#StoreProducts", {
            productStoreId: ids.allow,
            productIds: [ids.plain],
            action: "publish",
            changeReason: "Spec",
            operationKey: key()
        })
        const allowed = run(users.reader, M + "get#StorePublication", {productStoreId: ids.allow, productIds: [ids.plain]})
        return {withdrawn, now, later, outsiderLater, stale, past, unscheduled, rowsLeft, allowStore, allowed, scheduled}
    },
    then({withdrawn, now, later, outsiderLater, stale, past, unscheduled, rowsLeft, allowStore, allowed, scheduled}) {
        withdrawn.doneCount == 1
        scheduled.doneCount == 1
        now[0].isPublic == false
        later[0].isPublic == true
        code(outsiderLater) == "RECORD_UNAVAILABLE"
        stale.results[0].code == "STALE_REVISION"
        stale.results[0].message.includes("now ")
        past.results[0].code == "VALUE_INVALID"
        unscheduled.doneCount == 1
        rowsLeft.length == 1
        rowsLeft[0].thruDate != null
        allowStore.doneCount == 1
        allowed.products[0].isPublic == false
        allowed.products[0].reasonCode == "NOT_IN_VIEW_CATEGORY"
    }
})

feature("storefront details start a new dated row of a published product; an unpublished one and a stale row are refused", {
    when() {
        const before = list(S + "ProductStoreProduct", {productStoreId: ids.store, productId: ids.plain})
        const stale = run(users.merchandiser, M + "store#StoreProduct", {
            productStoreId: ids.store,
            productId: ids.plain,
            badgeText: "New",
            expectedLastUpdatedStamp: 1000
        })
        const saved = run(users.merchandiser, M + "store#StoreProduct", {
            productStoreId: ids.store,
            productId: ids.plain,
            badgeText: "New",
            featuredRank: 2,
            fromDate: Date.now() + 1000,
            changeReason: "Launch"
        })
        const reader = run(users.reader, M + "store#StoreProduct", {
            productStoreId: ids.store,
            productId: ids.plain,
            badgeText: "X"
        })
        const unpublished = run(users.merchandiser, M + "store#StoreProduct", {
            productStoreId: ids.store,
            productId: ids.second,
            badgeText: "X"
        })
        const after = list(S + "ProductStoreProduct", {productStoreId: ids.store, productId: ids.plain})
        const audit = list("moqui.entity.EntityAuditLog", {
            changedEntityName: S + "ProductStoreProduct",
            changedFieldName: "badgeText"
        })
        return {before, stale, saved, reader, unpublished, after, audit}
    },
    then({before, stale, saved, reader, unpublished, after, audit}) {
        before.length == 1
        code(stale) == "STALE_REVISION"
        saved.error == ""
        code(reader) == "PERMISSION_DENIED"
        code(unpublished) == "NOT_PUBLISHED"
        after.length == 2
        after.filter(row => row.thruDate == null).map(row => row.badgeText) == ["New"]
        after.filter(row => row.thruDate == null).map(row => row.changeReason) == ["Launch"]
        audit.some(row => row.newValueText === "New")
    }
})

feature(
    "category moves refuse a cycle, a past date and a category another organization's store shows; a shared one is named and confirmed",
    {
        when() {
            const move = (username, p) => run(username, M + "move#StoreCategory", Object.assign({productStoreId: ids.store}, p))
            const cycle = move(users.merchandiser, {productCategoryId: ids.one, toParentCategoryId: ids.three})
            const past = move(users.merchandiser, {
                productCategoryId: ids.three,
                toParentCategoryId: ids.root,
                fromDate: Date.now() - 86400000
            })
            const reader = move(users.reader, {productCategoryId: ids.three, toParentCategoryId: ids.root})
            const outside = move(users.merchandiser, {productCategoryId: ids.three, toParentCategoryId: ids.two})
            const preview = move(users.merchandiser, {
                productCategoryId: ids.three,
                toParentCategoryId: ids.root,
                previewOnly: true
            })
            const unconfirmed = move(users.merchandiser, {productCategoryId: ids.three, toParentCategoryId: ids.root})
            const before = generation()
            const moved = move(users.merchandiser, {
                productCategoryId: ids.three,
                toParentCategoryId: ids.root,
                sequenceNum: 3,
                confirmShared: true
            })
            const reordered = move(users.merchandiser, {
                productCategoryId: ids.one,
                toParentCategoryId: ids.root,
                sequenceNum: 9,
                confirmShared: true
            })
            const up = move(users.merchandiser, {productCategoryId: ids.three, direction: "up"})
            const tree = run(users.reader, M + "get#StoreCategories", {productStoreId: ids.store, productCategoryId: ids.three})
            const otherCategory = run(users.other, M + "get#CategoryStores", {productCategoryId: ids.one})
            return {
                otherCategory,
                cycle,
                past,
                reader,
                outside,
                preview,
                unconfirmed,
                moved,
                reordered,
                up,
                tree,
                before,
                after: generation()
            }
        },
        then({otherCategory, cycle, past, reader, outside, preview, unconfirmed, moved, reordered, up, tree, before, after}) {
            code(cycle) == "CATEGORY_CYCLE"
            code(past) == "VALUE_INVALID"
            code(reader) == "PERMISSION_DENIED"
            code(outside) == "CATEGORY_SHARED_OUTSIDE"
            preview.affectedStores.map(row => row.productStoreId).sort() == [ids.shared, ids.store]
            preview.otherStoreCount == 0
            code(unconfirmed) == "CATEGORY_SHARED"
            moved.moved == true
            reordered.moved == true
            up.moved == true
            after == before + 3
            tree.tree.find(node => node.productCategoryId === ids.three).parentProductCategoryId == ids.root
            tree.tree.filter(node => node.parentProductCategoryId === ids.root).map(node => node.productCategoryId) ==
                [ids.three, ids.two, ids.one]
            tree.tree.find(node => node.productCategoryId === ids.one).sequenceNum == 30
            tree.members.map(row => row.productId) == [ids.plain]
            code(otherCategory) == "CATEGORY_UNAVAILABLE"
        }
    }
)

feature(
    "category membership and roles: dated rows per product, another organization's product refused, a one-category role ends the other",
    {
        when() {
            const members = run(users.merchandiser, M + "store#CategoryMembership", {
                productStoreId: ids.store,
                productCategoryId: ids.three,
                productIds: [ids.second, ids.legacy]
            })
            const outsider = run(users.other, M + "store#CategoryMembership", {
                productStoreId: ids.store,
                productCategoryId: ids.three,
                productIds: [ids.second]
            })
            const ended = run(users.merchandiser, M + "store#CategoryMembership", {
                productStoreId: ids.store,
                productCategoryId: ids.three,
                productId: ids.legacy,
                end: true
            })
            const role = run(users.merchandiser, M + "store#StoreCategory", {
                productStoreId: ids.store,
                productCategoryId: ids.two,
                storeCategoryTypeEnumId: "PsctBrowseRoot"
            })
            const roles = run(users.reader, M + "get#StoreCategories", {productStoreId: ids.store}).roles
            return {members, outsider, ended, role, roles}
        },
        then({members, outsider, ended, role, roles}) {
            members.results.map(result => result.ok) == [true, true]
            code(outsider) == "RECORD_UNAVAILABLE"
            ended.results[0].ended == true
            role.error == ""
            roles
                .filter(row => row.storeCategoryTypeEnumId === "PsctBrowseRoot" && row.stateText === "Current")
                .map(row => row.productCategoryId) == [ids.two]
        }
    }
)
