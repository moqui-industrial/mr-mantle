// Shop's catalog (mr-pass impl-shop P3; mantle.product.ShopCatalogServices over ShopCatalog.js; design-shop §5, §11): every
// read of a published site's Shop store, as the public reads it, shows only what the publication resolver answers public: a
// product that is not published, a draft, an excluded variant and another store's product are absent from the list, a
// category, search, the sitemap and the product read (Not Found, as an unknown id); a page shows its exact published wiki
// version, not a later draft, and a page that is not live is absent. Prices are the authority's for the store (a store
// organization's row, which get#ProductPrice does not give the public), an unavailable price is told apart from a zero one,
// and no answer holds a trace or cost. Standalone: spec-local organizations, store, site, products, categories and pages.
// Run: ./moq test mr-mantle --spec ShopCatalog
const K = "mantle.product.ShopCatalogServices."
const S = "mantle.product.store."
const prefix = "SHCAT"
const ids = {
    org: prefix + "_ORG",
    otherOrg: prefix + "_ORG2",
    store: prefix + "_STORE",
    otherStore: prefix + "_STORE2",
    site: prefix + "_SITE",
    root: prefix + "_ROOT",
    category: prefix + "_CAT",
    plain: prefix + "_PLAIN",
    draft: prefix + "_DRAFT",
    virtual: prefix + "_VAR",
    red: prefix + "_VAR_RED",
    blue: prefix + "_VAR_BLUE",
    other: prefix + "_OTHER",
    unpublished: prefix + "_UNPUB",
    free: prefix + "_FREE",
    noPrice: prefix + "_NOPRICE",
    storePriced: prefix + "_STOREPRICE",
    space: "SHCATPG"
}
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
function organization(partyId, name) {
    make("mantle.party.Party", {partyId, partyTypeEnumId: "PtyOrganization"})
    make("mantle.party.Organization", {partyId, organizationName: name})
    make("mantle.party.PartyRole", {partyId, roleTypeId: "OrgInternal"})
}
function product(productId, fields = {}) {
    make(
        "mantle.product.Product",
        Object.assign(
            {productId, productName: "Catalog " + productId, productTypeEnumId: "PtDigital", ownerPartyId: ids.org},
            fields
        )
    )
}
const price = (productId, amount, fields = {}) =>
    make(
        "mantle.product.ProductPrice",
        Object.assign(
            {
                productId,
                pricePurposeEnumId: "PppPurchase",
                priceTypeEnumId: "PptCurrent",
                fromDate: 0,
                minQuantity: 1,
                price: amount,
                priceUomId: "USD"
            },
            fields
        )
    )
const published = (productStoreId, productId, kind) =>
    make(S + "ProductStoreProduct", {productStoreId, productId, fromDate: 0, publicationKindEnumId: kind || "PspkPublished"})
const wiki = (verb, parameters) => call("org.moqui.impl.WikiServices." + verb, parameters)
// a Shop read as the public reads it (no one signed in): {result} or {error}
function read(service, input) {
    logout()
    ec.message.pushErrors()
    try {
        const out =
            ec.service
                .sync()
                .name(K + service)
                .parameters({input: Object.assign({siteId: ids.site}, input)})
                .call() || {}
        return ec.message.hasError() ? {error: ec.message.getErrorsString()} : {result: out.result}
    } catch (error) {
        return {error: String(error.message || error), kind: error.moquiErrorKind || null}
    } finally {
        ec.message.clearErrors()
        ec.message.popErrors()
        login("john.doe")
    }
}
const productIdsOf = list => (list || []).map(card => card.id)

spec({
    setupSpec() {
        system(() => {
            organization(ids.org, "Catalog organization")
            organization(ids.otherOrg, "Catalog other organization")
            make(S + "ProductStore", {
                productStoreId: ids.store,
                storeName: "Catalog store",
                organizationPartyId: ids.org,
                defaultCurrencyUomId: "USD",
                defaultLocale: "en_US"
            })
            make(S + "ProductStore", {
                productStoreId: ids.otherStore,
                storeName: "Other store",
                organizationPartyId: ids.otherOrg,
                defaultCurrencyUomId: "USD"
            })
            make("mantle.public.PublicSite", {
                siteId: ids.site,
                name: "Catalog site",
                state: "published",
                locale: "en",
                generation: 3
            })
            make("mantle.public.PublicSiteApp", {
                siteId: ids.site,
                appMountId: "shop",
                app: "shop",
                pathPrefix: "/shop",
                enabled: "Y",
                targetId: ids.store
            })
            make("mantle.product.category.ProductCategory", {productCategoryId: ids.root, categoryName: "Catalog root"})
            make("mantle.product.category.ProductCategory", {productCategoryId: ids.category, categoryName: "Catalog things"})
            make("mantle.product.category.ProductCategoryRollup", {
                productCategoryId: ids.category,
                parentProductCategoryId: ids.root,
                fromDate: 0
            })
            make(S + "ProductStoreCategory", {
                productStoreId: ids.store,
                productCategoryId: ids.root,
                storeCategoryTypeEnumId: "PsctBrowseRoot",
                fromDate: 0
            })
            for (const productId of [ids.plain, ids.other, ids.unpublished, ids.free, ids.noPrice, ids.storePriced])
                product(productId)
            product(ids.draft, {statusId: "PrdDraft"})
            product(ids.virtual, {productTypeEnumId: "PtVirtual"})
            for (const variantId of [ids.red, ids.blue]) {
                product(variantId)
                make("mantle.product.ProductAssoc", {
                    productId: ids.virtual,
                    toProductId: variantId,
                    productAssocTypeEnumId: "PatVariant",
                    fromDate: 0
                })
                price(variantId, "12.50")
            }
            price(ids.plain, "10.00")
            price(ids.draft, "5.00")
            price(ids.other, "9.00")
            price(ids.unpublished, "4.00")
            price(ids.free, "0")
            // a row of the store's organization: the authority's price for the store; get#ProductPrice gives the public none
            price(ids.storePriced, "7.00", {vendorPartyId: ids.org})
            for (const productId of [ids.plain, ids.draft, ids.virtual, ids.free, ids.noPrice, ids.storePriced])
                published(ids.store, productId)
            published(ids.store, ids.blue, "PspkExcluded")
            published(ids.otherStore, ids.other)
            for (const productId of [ids.plain, ids.draft, ids.virtual, ids.other, ids.unpublished])
                make("mantle.product.category.ProductCategoryMember", {productCategoryId: ids.category, productId, fromDate: 0})
            // a published page (its version 1) whose wiki has a later draft, and a page bound with no published version
            wiki("create#WikiSpace", {wikiSpaceId: ids.space, description: "Catalog pages"})
            const pageId = wiki("update#WikiPage", {
                wikiSpaceId: ids.space,
                pageName: "Shipping",
                pageText: "Published shipping text\n"
            }).wikiPageId
            const version = wiki("get#WikiPageHistory", {wikiPageId: pageId}).versionList[0].versionName
            wiki("set#PublishedVersion", {wikiPageId: pageId, publishedVersionName: version})
            wiki("update#WikiPage", {
                wikiSpaceId: ids.space,
                wikiPageId: pageId,
                pageName: "Shipping",
                pageText: "Draft shipping text\n"
            })
            const draftId = wiki("update#WikiPage", {
                wikiSpaceId: ids.space,
                pageName: "Secret",
                pageText: "Unpublished text\n"
            }).wikiPageId
            make("mantle.public.PublicSitePage", {
                siteId: ids.site,
                appMountId: "shop",
                routePath: "shipping",
                title: "Shipping info",
                wikiPageId: pageId,
                versionName: version,
                fromDate: 0
            })
            make("mantle.public.PublicSitePage", {
                siteId: ids.site,
                appMountId: "shop",
                routePath: "secret",
                title: "Shipping secret",
                wikiPageId: draftId,
                fromDate: 0
            })
        })
    },
    cleanup() {
        login("john.doe")
    }
})

feature("every read shows only the store's public products and live pages, and a page's exact published version", {
    when() {
        return {
            listed: read("find#Products", {}),
            category: read("get#Category", {productCategoryId: ids.category}),
            tree: read("get#Categories", {}),
            search: read("search#Shop", {query: "Catalog"}),
            pageSearch: read("search#Shop", {query: "shipping"}),
            paths: (read("get#Sitemap", {}).result?.entries || []).map(entry => entry.path),
            virtual: read("get#Product", {productId: ids.virtual}),
            draft: read("get#Product", {productId: ids.draft}),
            excluded: read("get#Product", {productId: ids.blue}),
            other: read("get#Product", {productId: ids.other}),
            otherCategory: read("get#Category", {productCategoryId: "PopcAllProducts"}),
            page: read("get#Page", {routePath: "shipping"}),
            secret: read("get#Page", {routePath: "secret"}),
            badSort: read("find#Products", {sort: "productName desc"})
        }
    },
    then({
        listed,
        category,
        tree,
        search,
        pageSearch,
        paths,
        virtual,
        draft,
        excluded,
        other,
        otherCategory,
        page,
        secret,
        badSort
    }) {
        listed.result.generation == 3
        listed.result.releaseId == null
        productIdsOf(listed.result.products).sort() == [ids.free, ids.noPrice, ids.plain, ids.storePriced, ids.virtual].sort()
        productIdsOf(category.result.products).sort() == [ids.plain, ids.virtual].sort()
        category.result.category.url == "/shop/categories/" + ids.category + "/catalog-things"
        tree.result.categories.map(node => node.id) == [ids.category]
        !productIdsOf(search.result.products).some(id => [ids.draft, ids.blue, ids.other, ids.unpublished].includes(id))
        productIdsOf(search.result.products).includes(ids.plain)
        pageSearch.result.pages.map(link => link.url) == ["/shop/pages/shipping"]
        paths.includes("/shop/products/" + ids.plain + "/catalog-" + ids.plain.toLowerCase().replace(/_/g, "-"))
        paths.includes("/shop/pages/shipping")
        !paths.some(path => [ids.draft, ids.blue, ids.red, ids.other, ids.unpublished].some(id => path.includes("/" + id + "/")))
        !paths.includes("/shop/pages/secret")
        virtual.result.product.variants.map(variant => variant.id) == [ids.red]
        virtual.result.product.price.display.includes("12.50")
        draft.error.includes("NOT_AVAILABLE")
        excluded.error.includes("NOT_AVAILABLE")
        other.error.includes("NOT_AVAILABLE")
        otherCategory.error.includes("NOT_AVAILABLE")
        page.result.page.body.$richText.includes("Published shipping text")
        !page.result.page.body.$richText.includes("Draft")
        secret.error.includes("NOT_AVAILABLE")
        badSort.error.includes("VALUE_INVALID")
    }
})

feature("prices are the store authority's: a zero price, an unavailable one, a store row the public price omits; no trace", {
    when() {
        const publicPrice = (() => {
            logout()
            try {
                return ec.service
                    .sync()
                    .name("mantle.product.PriceServices.get#ProductPrice")
                    .parameters({productId: ids.storePriced, productStoreId: ids.store, priceUomId: "USD", explain: true})
                    .call()
            } finally {
                login("john.doe")
            }
        })()
        return {
            free: read("get#Product", {productId: ids.free}),
            none: read("get#Product", {productId: ids.noPrice}),
            store: read("get#Product", {productId: ids.storePriced}),
            quote: read("quote#Selection", {productId: ids.plain, quantity: "3"}),
            variantQuote: read("quote#Selection", {productId: ids.virtual, variantId: ids.blue}),
            publicPrice
        }
    },
    then({free, none, store, quote, variantQuote, publicPrice}) {
        free.result.product.price.available == true
        free.result.product.price.amount == "0.00"
        none.result.product.price.available == false
        none.result.product.price.amount == null
        none.result.product.price.display == "Price unavailable"
        none.result.product.availability.purchasable == false
        store.result.product.price.amount == "7.00"
        publicPrice.priceAvailable == false
        quote.result.total.amount == "30.00"
        quote.result.quantity == 3
        variantQuote.error.includes("VALUE_INVALID")
        !JSON.stringify([free, none, store, quote]).includes("priceTrace")
        !JSON.stringify([free, none, store, quote]).includes("productPriceId")
        !JSON.stringify([free, none, store, quote]).toLowerCase().includes("cost")
    }
})
