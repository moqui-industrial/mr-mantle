const S = "mantle.product.PriceServices.",
    P = "mantle.product.",
    now = Date.now(),
    date = new Date(now - 10000).toISOString()
let priceListId
const refused = p => {
    try {
        call(S + "get#EffectivePriceList", p)
        return ec.message.hasError()
    } catch (e) {
        return true
    } finally {
        ec.message.clearErrors()
    }
}
spec({
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        for (const [id, owner] of [
            ["EPL_OK", "ORG_ZIZI_SERVICES"],
            ["EPL_ZERO", "ORG_ZIZI_SERVICES"],
            ["EPL_BAD", "ORG_ZIZI_SERVICES"],
            ["EPL_OTHER", "ORG_ZIZI_RETAIL"]
        ])
            call("create#" + P + "Product", {
                productId: id,
                productName: id === "EPL_OK" ? "<Effective & safe>" : id,
                ownerPartyId: owner,
                productTypeEnumId: "PtAsset",
                amountUomId: "OTH_ea"
            })
        priceListId = call(S + "store#ProductPriceList", {
            listName: "Effective prices test",
            organizationPartyId: "ORG_ZIZI_SERVICES",
            direction: "sales",
            priceUomId: "USD",
            fromDate: date,
            changeReason: "Test output"
        }).priceListId
        for (const [id, value] of [
            ["EPL_OK", 10],
            ["EPL_ZERO", 0]
        ])
            call(S + "store#ProductPriceRule", {
                priceListId,
                sequenceNum: value ? 10 : 20,
                selector: "product",
                productId: id,
                baseType: "fixed",
                fixedPrice: value,
                fromDate: date,
                changeReason: "Test fixed output"
            })
        call(S + "store#ProductPriceRule", {
            priceListId,
            sequenceNum: 30,
            selector: "product",
            productId: "EPL_BAD",
            baseType: "typed",
            basePriceTypeEnumId: "PptWholesale",
            fromDate: date,
            changeReason: "Independent missing base"
        })
        const pub = call(S + "get#ProductPriceListPublication", {priceListId})
        call(S + "publish#ProductPriceList", {
            priceListId,
            publicationToken: pub.publicationToken,
            changeReason: "Reviewed output"
        })
    },
    setup() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
    },
    cleanup() {
        ec.message.clearErrors()
        ec.artifactExecution.enableAuthz()
    }
})
feature("resolved output preserves zero prices, names independent failures and escapes the printable document", {
    when() {
        return call(S + "get#EffectivePriceList", {
            priceListId,
            productIds: ["EPL_OK", "EPL_ZERO", "EPL_BAD"],
            quantity: 5,
            asOfDate: new Date(now).toISOString()
        })
    },
    then(r) {
        r.effectivePriceRows.length == 3
        r.effectivePriceRows.find(x => x.productId === "EPL_OK").price == 10
        r.effectivePriceRows.find(x => x.productId === "EPL_ZERO").price == 0
        r.effectivePriceRows.find(x => x.productId === "EPL_ZERO").priceAvailable == true
        r.effectivePriceRows.find(x => x.productId === "EPL_BAD").price == null
        r.printHtml.includes("&lt;Effective &amp; safe&gt;")
        r.reportContext.quantity == "5"
        r.printHtml.includes("Effective price list")
    }
})
feature("inactive list dates and invalid quantities are refused before output", {
    when() {
        return {
            past: refused({priceListId, asOfDate: new Date(now - 100000).toISOString()}),
            qty: refused({priceListId, quantity: 0})
        }
    },
    then({past, qty}) {
        past == true
        qty == true
    }
})
feature("output needs real price authority even when artifact authorization is disabled", {
    when() {
        logout()
        return {denied: refused({priceListId, productIds: ["EPL_OK"]})}
    },
    then({denied}) {
        denied == true
    }
})
feature("a native price permission grants only the readers own and shared product rows", {
    when() {
        for (const [n, p] of [
            ["moqui.security.UserGroup", {userGroupId: "EPL_READER"}],
            [
                "moqui.security.UserGroupPermission",
                {userGroupId: "EPL_READER", userPermissionId: "PRICE_VIEW", fromDate: "2000-01-01T00:00:00Z"}
            ],
            ["mantle.party.Party", {partyId: "EPL_READER", partyTypeEnumId: "PtyPerson"}],
            ["mantle.party.Person", {partyId: "EPL_READER", firstName: "Effective reader"}],
            [
                "moqui.security.UserAccount",
                {
                    userId: "EPL_READER",
                    username: "epl_reader",
                    partyId: "EPL_READER",
                    currentPassword: "16ac58bbfa332c1c55bd98b53e60720bfa90d394",
                    passwordHashType: "SHA"
                }
            ],
            [
                "moqui.security.UserGroupMember",
                {userId: "EPL_READER", userGroupId: "EPL_READER", fromDate: "2000-01-01T00:00:00Z"}
            ],
            [
                "mantle.party.PartyRelationship",
                {
                    fromPartyId: "EPL_READER",
                    toPartyId: "ORG_ZIZI_SERVICES",
                    relationshipTypeEnumId: "PrtAgent",
                    toRoleTypeId: "OrgInternal",
                    fromDate: "2000-01-01T00:00:00Z"
                }
            ]
        ])
            call("create#" + n, p)
        login("epl_reader")
        return call(S + "get#EffectivePriceList", {priceListId, productIds: ["EPL_OK", "EPL_OTHER"]})
    },
    then(r) {
        r.effectivePriceRows.map(p => p.productId) == ["EPL_OK"]
        !r.printHtml.includes("EPL_OTHER")
    }
})
