// The adoption preview of an existing store (mr-pass impl-shop P8; design-shop §17.1; mantle.product.StoreAdoptionServices
// over StoreAdoption.js): a legacy store's template roles mapped to the theme package's sections, with findings for the
// syntax the theme renderer does not run (the demo's ZZWR_TMP server footer: FreeMarker and server context) and a convertible
// client footer; a setting Shop does not use, a missing purchase category role, a gateway with no hosted page and a sign-in
// template that stays PASS Account's named; the publication rows proposed by Commerce P3's propose#StorePublication (its own
// rules are StorePublication's) and nothing written; the store's scope; artifact authorization disabled (the rules are the
// service's own checks). Standalone but for the demo's ZZWR_TMP wiki space:
// spec-local organizations, user, store, category and product. Run: ./moq test mr-mantle --spec StoreAdoption
const A = "mantle.product.StoreAdoptionServices."
const S = "mantle.product.store."
const prefix = "STADOPT"
const ids = {
    org: prefix + "_ORG",
    other: prefix + "_OTHER_ORG",
    store: prefix + "_STORE",
    otherStore: prefix + "_OTHER",
    category: prefix + "_CAT",
    mug: prefix + "_MUG",
    user: prefix + "_VIEWER"
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
const count = (entity, fields) => system(() => ec.entity.find(entity).condition(fields).disableAuthz().count())
function organization(partyId, name) {
    make("mantle.party.Party", {partyId, partyTypeEnumId: "PtyOrganization"})
    make("mantle.party.Organization", {partyId, organizationName: name})
    make("mantle.party.PartyRole", {partyId, roleTypeId: "OrgInternal"})
}
// a preview as the spec's Commerce viewer, in its own transaction: {preview} or {error}
function preview(productStoreId) {
    login(ids.user)
    const was = ec.artifactExecution.disableAuthz()
    ec.message.pushErrors()
    try {
        const out = ec.service
            .sync()
            .name(A + "preview#StoreAdoption")
            .parameters({productStoreId})
            .requireNewTransaction(true)
            .call()
        return ec.message.hasError() ? {error: ec.message.getErrorsString()} : {preview: out.preview}
    } catch (error) {
        return {error: String(error.message || error)}
    } finally {
        ec.message.clearErrors()
        ec.message.popErrors()
        if (!was) ec.artifactExecution.enableAuthz()
        login("john.doe")
    }
}
const codes = (found, code) => found.preview.findings.filter(row => row.code === code)

spec({
    setupSpec() {
        system(() => {
            organization(ids.org, "Adoption organization")
            organization(ids.other, "Adoption other organization")
            make("mantle.party.Party", {partyId: ids.user, partyTypeEnumId: "PtyPerson"})
            make("mantle.party.Person", {partyId: ids.user, firstName: "Adoption", lastName: "Viewer"})
            make("mantle.party.PartyRelationship", {
                partyRelationshipId: ids.user,
                fromPartyId: ids.user,
                toPartyId: ids.org,
                relationshipTypeEnumId: "PrtAgent",
                fromDate: 0
            })
            make("moqui.security.UserGroup", {userGroupId: ids.user, description: "Adoption viewer"})
            make("moqui.security.UserGroupPermission", {userGroupId: ids.user, userPermissionId: "COMMERCE_VIEW", fromDate: 0})
            make("moqui.security.UserAccount", {
                userId: ids.user,
                username: ids.user,
                partyId: ids.user,
                currentPassword: "16ac58bbfa332c1c55bd98b53e60720bfa90d394",
                passwordHashType: "SHA",
                timeZone: "UTC",
                locale: "en_US"
            })
            make("moqui.security.UserGroupMember", {userId: ids.user, userGroupId: ids.user, fromDate: 0})
            make(S + "ProductStore", {
                productStoreId: ids.store,
                storeName: "Adoption store",
                organizationPartyId: ids.org,
                defaultCurrencyUomId: "USD",
                defaultLocale: "en_US",
                requireInventory: "N",
                storeDomain: "legacy.stadopt.example.test"
            })
            make(S + "ProductStore", {
                productStoreId: ids.otherStore,
                storeName: "Adoption other",
                organizationPartyId: ids.other
            })
            // a category shown, never one to buy from (PsctPurchaseAllow missing), with a sellable product
            make("mantle.product.category.ProductCategory", {
                productCategoryId: ids.category,
                productCategoryTypeEnumId: "PctCatalog",
                categoryName: "Adoption mugs",
                ownerPartyId: ids.org
            })
            make(S + "ProductStoreCategory", {
                productStoreId: ids.store,
                productCategoryId: ids.category,
                storeCategoryTypeEnumId: "PsctViewAllow",
                fromDate: 0
            })
            make("mantle.product.Product", {
                productId: ids.mug,
                productName: "Adoption mug",
                productTypeEnumId: "PtDigital",
                ownerPartyId: ids.org
            })
            make("mantle.product.ProductPrice", {
                productId: ids.mug,
                pricePurposeEnumId: "PppPurchase",
                priceTypeEnumId: "PptCurrent",
                fromDate: 0,
                minQuantity: 1,
                price: "9.00",
                priceUomId: "USD"
            })
            make("mantle.product.category.ProductCategoryMember", {
                productCategoryId: ids.category,
                productId: ids.mug,
                fromDate: 0
            })
            // a legacy setting Shop does not use, and a card gateway with no hosted page (the demo's TEST_APPROVE)
            make(S + "ProductStoreSetting", {
                productStoreId: ids.store,
                settingTypeEnumId: "PsstRestApiLocation",
                fromDate: 0,
                settingValue: "component://legacy/rest.xml"
            })
            make(S + "ProductStorePaymentGateway", {
                productStoreId: ids.store,
                paymentInstrumentEnumId: "PiCreditCard",
                paymentGatewayConfigId: "TEST_APPROVE"
            })
            // the template roles of the demo's ZZWR_TMP space (POPC_DEFAULT's): the server footer uses FreeMarker and ec, the
            // client footer is plain HTML; the sign-in template stays PASS Account's
            for (const [suffix, spaceTypeEnumId] of [
                ["SRV", "PstTmpSrv"],
                ["CLT", "PstTmpClt"]
            ])
                make(S + "ProductStoreWikiSpace", {
                    storeWikiSpaceId: prefix + "_" + suffix,
                    productStoreId: ids.store,
                    spaceTypeEnumId,
                    fromDate: 0,
                    wikiSpaceId: "ZZWR_TMP"
                })
            for (const [suffix, contentTypeEnumId, spaceTypeEnumId, pagePath] of [
                ["SRV_FOOTER", "PsctFooterTemplateServer", "PstTmpSrv", "server/footer"],
                ["CLT_FOOTER", "PsctFooterTemplate", "PstTmpClt", "client/footer"],
                ["LOGIN", "PsctLoginTemplate", "PstTmpClt", "client/login"]
            ])
                make(S + "ProductStoreWikiContent", {
                    storeWikiContentId: prefix + "_" + suffix,
                    productStoreId: ids.store,
                    contentTypeEnumId,
                    fromDate: 0,
                    spaceTypeEnumId,
                    pagePath
                })
        })
    },
    cleanup() {
        login("john.doe")
    }
})

feature("the preview maps template roles with conversion findings, names unmapped settings, and proposes rows writing nothing", {
    when() {
        const before = {
            publication: count(S + "ProductStoreProduct", {productStoreId: ids.store}),
            mounts: count("mantle.public.PublicSiteApp", {targetId: ids.store}),
            operations: count("mantle.ledger.transaction.PostingOperation", {})
        }
        const found = preview(ids.store)
        const after = {
            publication: count(S + "ProductStoreProduct", {productStoreId: ids.store}),
            mounts: count("mantle.public.PublicSiteApp", {targetId: ids.store}),
            operations: count("mantle.ledger.transaction.PostingOperation", {})
        }
        return {found, before, after}
    },
    then({found, before, after}) {
        found.error == null
        found.preview.enabled == false
        // the server footer: FreeMarker directives and expressions and server context, each an error naming its line
        const server = found.preview.templates.roles.find(row => row.contentTypeEnumId == "PsctFooterTemplateServer")
        server.section == "layouts/store (footer)"
        server.unsupported.includes("FreeMarker directives")
        server.unsupported.includes("server context (ec)")
        server.convertible == false
        codes(found, "UNSUPPORTED_SYNTAX").filter(row => row.source.startsWith("PsctFooterTemplateServer")).length == 3
        codes(found, "UNSUPPORTED_SYNTAX").every(row => row.severity == "error" && row.text.startsWith("Line "))
        // the client footer converts as it is; the sign-in template is PASS Account's and its page is missing
        const client = found.preview.templates.roles.find(row => row.contentTypeEnumId == "PsctFooterTemplate")
        client.convertible == true
        client.unsupported.length == 0
        client.location.startsWith("dbresource://")
        codes(found, "TEMPLATE_NOT_THEMED").length == 1
        codes(found, "SOURCE_MISSING").some(row => row.source.startsWith("PsctLoginTemplate"))
        found.preview.templates.spaces.every(row => row.mapsTo == "theme package sources (converted by hand)")
        // settings, category roles, gateways, the legacy domain kept for emails, the mount to make
        codes(found, "SETTING_UNMAPPED").some(row => row.source == "PsstRestApiLocation")
        found.preview.settings.find(row => row.settingTypeEnumId == "PsstRestApiLocation").mapped == false
        codes(found, "CATEGORY_ROLE_MISSING").length == 1
        codes(found, "CATEGORY_ROLE_MISSING")[0].text.includes("Purchase")
        codes(found, "GATEWAY_NOT_HOSTED")[0].source == "TEST_APPROVE"
        codes(found, "STORE_DOMAIN_KEPT").length == 1
        codes(found, "MOUNT_REQUIRED").length == 1
        found.preview.slugs[0].path == "/categories/" + ids.category + "/adoption-mugs"
        // errors first; the proposal is Commerce P3's, and nothing was written
        found.preview.findings[0].severity == "error"
        found.preview.summary.errors >= 4
        found.preview.proposals.map(row => row.productId).includes(ids.mug)
        found.preview.publicationRows == 0
        after.publication == before.publication
        after.mounts == before.mounts
        after.operations == before.operations
    }
})

feature("another organization's store is refused, and a store that publishes already gets no proposal", {
    when() {
        const other = preview(ids.otherStore)
        system(() =>
            make(S + "ProductStoreProduct", {
                productStoreId: ids.store,
                productId: ids.mug,
                fromDate: 0,
                publicationKindEnumId: "PspkPublished"
            })
        )
        return {other, published: preview(ids.store)}
    },
    then({other, published}) {
        other.error.includes("RECORD_UNAVAILABLE")
        published.preview.proposals.length == 0
        published.preview.publicationRows == 1
        codes(published, "PUBLICATION_EXISTS").length == 1
    }
})
