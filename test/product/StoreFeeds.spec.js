// Store feeds and channel health (impl-commerce P14, COM-FEED; mantle.product.StoreChannelServices, StoreFeeds.js): only
// registered formats and destinations, the channel operator's permission and the store's scope; a build of Shop's public
// projection with a skipped product named and no private field; publication with its revision and operation key; the Shop
// site's feed path checked against the generation, so a withdrawn product is never served and a rebuild does not bring it
// back; a fatal build leaving the active build served; the feed job going on past a failing feed; channel health.
// Standalone: spec-local organizations, users, store, sites, products and remote; artifact authorization disabled (the rules
// are the services' own checks). Run: ./moq test mr-mantle --spec StoreFeeds
const C = "mantle.product.StoreChannelServices."
const S = "mantle.product.store."
const prefix = "STFEED"
const orgA = prefix + "_ORG_A",
    orgB = prefix + "_ORG_B"
const ids = {
    store: prefix + "_STORE",
    other: prefix + "_OTHER",
    site: prefix + "_SITE",
    hostless: prefix + "_SITE2",
    host: "feeds.stfeed.example.test",
    mug: prefix + "_MUG",
    cup: prefix + "_CUP",
    unpriced: prefix + "_UNPRICED",
    remote: prefix + "_REMOTE"
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
const row = (entity, conditions) =>
    system(() => ec.entity.find(entity).condition(conditions).useCache(false).disableAuthz().one())
function organization(partyId, name) {
    make("mantle.party.Party", {partyId, partyTypeEnumId: "PtyOrganization"})
    make("mantle.party.Organization", {partyId, organizationName: name})
    make("mantle.party.PartyRole", {partyId, roleTypeId: "OrgInternal"})
}
function user(kind, organizationPartyId, permissions) {
    const id = prefix + "_" + kind.toUpperCase()
    make("mantle.party.Party", {partyId: id, partyTypeEnumId: "PtyPerson"})
    make("mantle.party.Person", {partyId: id, firstName: "Feeds", lastName: kind})
    make("mantle.party.PartyRelationship", {
        partyRelationshipId: id,
        fromPartyId: id,
        toPartyId: organizationPartyId,
        relationshipTypeEnumId: "PrtAgent",
        fromDate: 0
    })
    make("moqui.security.UserGroup", {userGroupId: id, description: "Store feeds " + kind})
    for (const permission of permissions)
        make("moqui.security.UserGroupPermission", {userGroupId: id, userPermissionId: permission, fromDate: 0})
    make("moqui.security.UserAccount", {
        userId: id,
        username: id,
        partyId: id,
        currentPassword: "16ac58bbfa332c1c55bd98b53e60720bfa90d394",
        passwordHashType: "SHA",
        timeZone: "UTC",
        locale: "en_US"
    })
    make("moqui.security.UserGroupMember", {userId: id, userGroupId: id, fromDate: 0})
    return id
}
// a call as a user (null: no one signed in), in its own transaction: its result and its refusal ("" when it succeeds)
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
const code = out => (/([A-Z][A-Z0-9_]+)(\[[^\]]*\])?:/.exec(out.error || "") || [])[1] || (out.error ? "ERROR" : "")
const key = () => prefix + "-" + Math.random().toString(36).slice(2, 12)
const revision = feedId => run(users.operator, C + "get#StoreFeed", {productStoreFeedId: feedId}).feed.revision
const newFeed = (fields = {}) =>
    run(
        users.operator,
        C + "store#StoreFeed",
        Object.assign(
            {
                productStoreId: ids.store,
                siteId: ids.site,
                feedName: "Spec feed",
                feedKey: "spec-" + Math.random().toString(36).slice(2, 8),
                formatEnumId: "PsffGoogleXml",
                changeReason: "Spec"
            },
            fields
        )
    )
const build = feedId => run(users.operator, C + "build#StoreFeed", {productStoreFeedId: feedId})
const publish = (feedId, feedBuildId, extra = {}) =>
    run(
        users.operator,
        C + "publish#StoreFeed",
        Object.assign({productStoreFeedId: feedId, feedBuildId, expectedRevision: revision(feedId), operationKey: key()}, extra)
    )
// the Shop site's feed path, as the public reads it (no one signed in)
function served(feedKey, extension = "xml") {
    logout()
    ec.message.pushErrors()
    try {
        const out = ec.service
            .sync()
            .name(C + "get#ShopFeed")
            .parameters({input: {siteId: ids.site, feedKey, extension}})
            .call()
        return ec.message.hasError() ? {error: ec.message.getErrorsString()} : out.result
    } catch (error) {
        return {error: String(error.message || error), kind: error.moquiErrorKind || null}
    } finally {
        ec.message.clearErrors()
        ec.message.popErrors()
        login("john.doe")
    }
}
const withdraw = productId =>
    run("john.doe", "mantle.product.StoreMerchandisingServices.publish#StoreProducts", {
        productStoreId: ids.store,
        productIds: [productId],
        action: "withdraw",
        changeReason: "Spec withdrawal",
        operationKey: key()
    })

spec({
    setupSpec() {
        system(() => {
            organization(orgA, "Feeds organization A")
            organization(orgB, "Feeds organization B")
            make(S + "ProductStore", {
                productStoreId: ids.store,
                storeName: "Feeds store",
                organizationPartyId: orgA,
                defaultCurrencyUomId: "USD",
                defaultLocale: "en_US"
            })
            make(S + "ProductStore", {productStoreId: ids.other, storeName: "Feeds other", organizationPartyId: orgB})
            for (const siteId of [ids.site, ids.hostless]) {
                make("mantle.public.PublicSite", {
                    siteId,
                    name: "Feeds " + siteId,
                    state: "published",
                    locale: "en",
                    generation: 4
                })
                make("mantle.public.PublicSiteApp", {
                    siteId,
                    appMountId: "shop",
                    app: "shop",
                    pathPrefix: "/shop",
                    enabled: "Y",
                    targetId: ids.store
                })
            }
            make("mantle.public.PublicSiteHost", {hostname: ids.host, siteId: ids.site, canonical: "Y"})
            for (const [productId, amount] of [
                [ids.mug, "10.00"],
                [ids.cup, "12.50"],
                [ids.unpriced, null]
            ]) {
                make("mantle.product.Product", {
                    productId,
                    productName: "Feeds " + productId + (productId === ids.mug ? ' & "stone"' : ""),
                    productTypeEnumId: "PtDigital",
                    ownerPartyId: orgA
                })
                if (amount)
                    make("mantle.product.ProductPrice", {
                        productId,
                        pricePurposeEnumId: "PppPurchase",
                        priceTypeEnumId: "PptCurrent",
                        fromDate: 0,
                        minQuantity: 1,
                        price: amount,
                        priceUomId: "USD"
                    })
                make(S + "ProductStoreProduct", {
                    productStoreId: ids.store,
                    productId,
                    fromDate: 0,
                    publicationKindEnumId: "PspkPublished"
                })
            }
            users.operator = user("operator", orgA, ["COMMERCE_VIEW", "COMMERCE_CHANNEL_OPERATE"])
            users.reader = user("reader", orgA, ["COMMERCE_VIEW"])
            users.outside = user("outside", orgB, ["COMMERCE_VIEW", "COMMERCE_CHANNEL_OPERATE"])
            make("moqui.service.message.SystemMessageRemote", {
                systemMessageRemoteId: ids.remote,
                description: "Feeds channel",
                productStoreId: ids.store,
                password: "never-shown"
            })
            const now = ec.user.nowTimestamp
            make("moqui.service.message.SystemMessage", {
                systemMessageRemoteId: ids.remote,
                statusId: "SmsgConsumed",
                isOutgoing: "N",
                initDate: now,
                processedDate: now,
                messageText: "raw payload"
            })
            make("moqui.service.message.SystemMessage", {
                systemMessageRemoteId: ids.remote,
                statusId: "SmsgError",
                isOutgoing: "N",
                initDate: now,
                failCount: 2,
                messageText: "raw payload"
            })
        })
    },
    cleanupSpec() {
        ec.message.clearErrors()
        login("john.doe")
        ec.artifactExecution.enableAuthz()
    }
})

feature("only registered formats and destinations, for a channel operator of the store", {
    when() {
        const made = newFeed({feedKey: "spec-main"})
        state.feedId = made.productStoreFeedId
        return {
            made,
            format: newFeed({formatEnumId: "PsffCustom"}),
            destination: newFeed({destinationEnumId: "PsfdAnyUrl"}),
            currency: newFeed({currencyUomId: "EUR"}),
            taken: newFeed({feedKey: "spec-main"}),
            reader: run(users.reader, C + "find#StoreFeeds", {productStoreId: ids.store}),
            outside: run(users.outside, C + "find#StoreFeeds", {productStoreId: ids.store}),
            outsideStore: run(users.outside, C + "store#StoreFeed", {
                productStoreId: ids.store,
                siteId: ids.site,
                feedName: "X",
                feedKey: "x",
                formatEnumId: "PsffCsv"
            }),
            listed: run(users.operator, C + "find#StoreFeeds", {productStoreId: ids.store}).feeds
        }
    },
    then(r) {
        r.made.error == ""
        code(r.format) == "FORMAT_UNREGISTERED"
        code(r.destination) == "DESTINATION_UNREGISTERED"
        code(r.currency) == "VALUE_INVALID"
        code(r.taken) == "FEED_KEY_TAKEN"
        code(r.reader) == "PERMISSION_DENIED"
        code(r.outside) == "RECORD_UNAVAILABLE"
        code(r.outsideStore) == "RECORD_UNAVAILABLE"
        r.listed.length == 1
        r.listed[0].publicPath == "/shop/feeds/spec-main.xml"
        r.listed[0].stateText == "Not published"
    }
})

feature("a build of the public projection names its skip, carries no private field, and publishes by revision and key", {
    when() {
        const built = build(state.feedId)
        state.buildId = built.feedBuildId
        const before = served("spec-main")
        const detail = run(users.operator, C + "get#FeedBuild", {feedBuildId: built.feedBuildId})
        const stale = publish(state.feedId, built.feedBuildId, {expectedRevision: 1})
        const operationKey = key()
        const published = publish(state.feedId, built.feedBuildId, {operationKey})
        const retried = publish(state.feedId, built.feedBuildId, {operationKey, expectedRevision: 1})
        return {built, before, detail, stale, published, retried, after: served("spec-main"), csv: served("spec-main", "csv")}
    },
    then(r) {
        r.built.error == ""
        r.built.build.complete == true
        r.built.build.rowCount == 2
        r.built.build.skipCount == 1
        r.built.build.generation == 4
        r.detail.skips == [{productId: ids.unpriced, productName: "Feeds " + ids.unpriced, reasonCode: "PRICE_UNAVAILABLE"}]
        r.detail.sample.length == 2
        Object.keys(r.detail.sample[0]).sort() ==
            ["availability", "badge", "description", "id", "imageLink", "link", "price", "salePrice", "sku", "title"]
        r.detail.build.canPublish == true
        code(r.before) == "FEED_UNAVAILABLE"
        code(r.stale) == "STALE_REVISION"
        r.published.error == ""
        r.retried.alreadyApplied == true
        r.after.contentType == "application/xml; charset=utf-8"
        r.after.content.includes("<g:id>" + ids.mug + "</g:id>")
        r.after.content.includes("Feeds " + ids.mug + " &amp; &quot;stone&quot;")
        r.after.content.includes("<g:price>12.50 USD</g:price>")
        r.after.content.includes("<link>https://" + ids.host + "/shop/products/" + ids.cup + "/")
        !r.after.content.includes(ids.unpriced)
        code(r.csv) == "FEED_UNAVAILABLE"
    }
})

feature("a withdrawn product is never served, and a rebuild leaves it out", {
    when() {
        const withdrawn = withdraw(ids.cup)
        const blocked = served("spec-main")
        const republished = publish(state.feedId, state.buildId, {operationKey: key()})
        const rebuilt = build(state.feedId)
        const published = publish(state.feedId, rebuilt.feedBuildId)
        return {withdrawn, blocked, republished, rebuilt, published, served: served("spec-main")}
    },
    then(r) {
        r.withdrawn.error == ""
        code(r.blocked) == "FEED_UNAVAILABLE"
        code(r.republished) == "BUILD_STALE"
        r.rebuilt.build.rowCount == 1
        r.rebuilt.build.generation == 5
        r.published.error == ""
        r.served.content.includes(ids.mug)
        !r.served.content.includes(ids.cup)
    }
})

feature("a fatal build leaves the active build served; the job goes on past a failing feed; channel health counts both", {
    when() {
        const failing = newFeed({siteId: ids.hostless, feedKey: "spec-hostless", scheduleEnumId: "PsfsHourly"})
        const scheduled = newFeed({feedKey: "spec-hourly", formatEnumId: "PsffJson", scheduleEnumId: "PsfsHourly"})
        system(() => ec.entity.find("mantle.public.PublicSiteHost").condition({hostname: ids.host}).disableAuthz().deleteAll())
        const fatal = build(state.feedId)
        const stillServed = served("spec-main")
        system(() => make("mantle.public.PublicSiteHost", {hostname: ids.host, siteId: ids.site, canonical: "Y"}))
        const job = run(null, C + "run#StoreFeeds", {})
        const mine = (job.results || []).filter(result =>
            [failing.productStoreFeedId, scheduled.productStoreFeedId].includes(result.productStoreFeedId)
        )
        const health = run(users.operator, C + "get#ChannelHealth", {productStoreId: ids.store})
        return {fatal, stillServed, mine, failingId: failing.productStoreFeedId, json: served("spec-hourly", "json"), health}
    },
    then(r) {
        r.fatal.failed == true
        r.fatal.build.failureCode == "HOST_REQUIRED"
        r.stillServed.content.includes(ids.mug)
        r.mine.length == 2
        r.mine.find(result => result.productStoreFeedId == r.failingId).reasonCode == "HOST_REQUIRED"
        r.mine.find(result => result.productStoreFeedId != r.failingId).published == true
        JSON.parse(r.json.content).items.length == 1
        r.health.error == ""
        r.health.messages.length == 1
        r.health.messages[0].received == 2
        r.health.messages[0].processed == 1
        r.health.messages[0].errors == 1
        r.health.messages[0].retried == 1
        !JSON.stringify(r.health).includes("never-shown")
        !JSON.stringify(r.health).includes("raw payload")
        r.health.feeds.find(feed => feed.productStoreFeedId == r.failingId).latestFailed == true
        r.health.totals.messageErrors == 1
        r.health.totals.failingFeeds == 2
    }
})
