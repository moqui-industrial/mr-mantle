// Shop's carts (mr-pass impl-shop P4; mantle.order.ShopCartServices over ShopCart.js; design-shop §4.2, §6 Cart, §7.1): a
// cart is reached only by the session's capability or the signed-in account's own, never by an order id; a shopper's input
// sets no price, customer, store or status (the line has the store authority's price, the part a guest party); a change
// naming an older revision is refused and an operation id answers once; a code is the store's and every refusal reads the
// same; sign-in merges a proven guest cart into the account's cart once; another store's or currency's cart is apart;
// sign-out rotates the account's capabilities; merge#Parties moves a cart's access with its party (F23). Standalone:
// spec-local organizations, stores, sites, products and promotion. Run: ./moq test mr-mantle --spec ShopCart
const C = "mantle.order.ShopCartServices."
const S = "mantle.product.store."
const prefix = "SHCART"
const ids = {
    org: prefix + "_ORG",
    store: prefix + "_STORE",
    euroStore: prefix + "_STORE_EUR",
    site: prefix + "_SITE",
    euroSite: prefix + "_SITE_EUR",
    book: prefix + "_BOOK",
    mug: prefix + "_MUG",
    promotion: prefix + "_PROMO",
    code: prefix + "_CODE",
    otherPromotion: prefix + "_PROMO2",
    otherCode: prefix + "_CODE2"
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
const one = (entity, fields) => ec.entity.find(entity).condition(fields).disableAuthz().one()
const list = (entity, fields) => Array.from(ec.entity.find(entity).condition(fields).disableAuthz().list())
function store(productStoreId, currency) {
    make(S + "ProductStore", {
        productStoreId,
        storeName: "Cart store " + currency,
        organizationPartyId: ids.org,
        defaultCurrencyUomId: currency,
        defaultLocale: "en_US",
        requireInventory: "N",
        defaultDisableShippingCalc: "Y"
    })
}
function site(siteId, productStoreId) {
    make("mantle.public.PublicSite", {siteId, name: "Cart site", state: "published", locale: "en", generation: 1})
    make("mantle.public.PublicSiteApp", {
        siteId,
        appMountId: "shop",
        app: "shop",
        pathPrefix: "/shop",
        enabled: "Y",
        targetId: productStoreId
    })
}
// a cart operation as a visitor (no one signed in) or a signed-in user: {result} or {error, kind}
function cart(service, input, username) {
    if (username) login(username)
    else logout()
    ec.message.pushErrors()
    try {
        const out =
            ec.service
                .sync()
                .name(C + service)
                .parameters({input: Object.assign({siteId: ids.site}, input)})
                .call() || {}
        return ec.message.hasError() ? {error: ec.message.getErrorsString()} : {result: out.result}
    } catch (error) {
        return {error: String(error.message || error)}
    } finally {
        ec.message.clearErrors()
        ec.message.popErrors()
        login("john.doe")
    }
}

spec({
    setupSpec() {
        system(() => {
            make("mantle.party.Party", {partyId: ids.org, partyTypeEnumId: "PtyOrganization"})
            make("mantle.party.Organization", {partyId: ids.org, organizationName: "Cart organization"})
            make("mantle.party.PartyRole", {partyId: ids.org, roleTypeId: "OrgInternal"})
            store(ids.store, "USD")
            store(ids.euroStore, "EUR")
            site(ids.site, ids.store)
            site(ids.euroSite, ids.euroStore)
            for (const [productId, amount] of [
                [ids.book, "12.00"],
                [ids.mug, "8.50"]
            ]) {
                make("mantle.product.Product", {
                    productId,
                    productName: "Cart " + productId,
                    productTypeEnumId: "PtDigital",
                    ownerPartyId: ids.org
                })
                for (const currency of ["USD", "EUR"])
                    make("mantle.product.ProductPrice", {
                        productId,
                        pricePurposeEnumId: "PppPurchase",
                        priceTypeEnumId: "PptCurrent",
                        fromDate: 0,
                        minQuantity: 1,
                        price: amount,
                        priceUomId: currency
                    })
                for (const productStoreId of [ids.store, ids.euroStore])
                    make(S + "ProductStoreProduct", {
                        productStoreId,
                        productId,
                        fromDate: 0,
                        publicationKindEnumId: "PspkPublished"
                    })
            }
            // 2.00 off a book with a code of the store, and a code of the other store
            for (const [storePromotionId, productStoreId, promoCodeId] of [
                [ids.promotion, ids.store, ids.code],
                [ids.otherPromotion, ids.euroStore, ids.otherCode]
            ]) {
                make(S + "ProductStorePromotion", {
                    storePromotionId,
                    productStoreId,
                    itemDescription: "Book discount",
                    serviceRegisterId: "FlatDiscount",
                    requireCode: "Y",
                    useLimitPerOrder: 1
                })
                make(S + "ProductStorePromoParameter", {storePromotionId, parameterName: "discountAmount", parameterValue: "2"})
                make(S + "ProductStorePromoProduct", {storePromotionId, productId: ids.book, excludeProduct: "N"})
                make(S + "ProductStorePromoCode", {promoCodeId, storePromotionId, promoCode: promoCodeId, requireParty: "N"})
            }
            state.johnPartyId = ec.user.userAccount.partyId
        })
    },
    cleanup() {
        login("john.doe")
    }
})

feature("a guest's first add makes the cart with a capability; the input sets no price, customer, store or status", {
    when() {
        const added = cart("add#CartItem", {
            productId: ids.book,
            quantity: "2",
            unitAmount: "0.01",
            customerPartyId: state.johnPartyId,
            productStoreId: ids.euroStore,
            statusId: "OrderPlaced"
        })
        state.guestToken = added.result?.token
        const access = list("mantle.order.StoreCartAccess", {siteId: ids.site}).find(row => !row.customerPartyId)
        state.guestOrderId = access?.orderId
        const order = access ? one("mantle.order.OrderHeader", {orderId: access.orderId}) : null
        const part = access ? list("mantle.order.OrderPart", {orderId: access.orderId})[0] : null
        return {
            added,
            access,
            order,
            part,
            again: cart("get#Cart", {token: state.guestToken}),
            noToken: cart("get#Cart", {orderId: access?.orderId}),
            orderIdOnly: cart("update#CartItem", {
                orderId: access?.orderId,
                orderItemSeqId: "01",
                quantity: "5",
                expectedRevision: "1"
            })
        }
    },
    then({added, access, order, part, again, noToken, orderIdOnly}) {
        added.result.token.length == 48
        added.result.cart.items.length == 1
        added.result.cart.items[0].unitPrice.amount == "12.00"
        added.result.cart.items[0].quantity == "2"
        added.result.cart.totals.items.amount == "24.00"
        added.result.summary.itemCount == 2
        access.capabilityDigest != added.result.token
        !access.customerPartyId
        part.customerPartyId == access.guestPartyId
        part.customerPartyId != state.johnPartyId
        order.productStoreId == ids.store
        order.currencyUomId == "USD"
        order.statusId == "OrderOpen"
        order.salesChannelEnumId == "ScWeb"
        again.result.cart.items.length == 1
        again.result.token == null
        noToken.result.cart.empty == true
        orderIdOnly.error.includes("NOT_AVAILABLE")
        !JSON.stringify(again.result).includes(access.orderId)
        !JSON.stringify(again.result).includes(access.guestPartyId)
    }
})

feature("a change naming an older revision is refused; an operation id answers once; a code is the store's", {
    when() {
        const seen = cart("get#Cart", {token: state.guestToken}).result.cart
        const line = seen.items[0].orderItemSeqId
        const first = cart("update#CartItem", {
            token: state.guestToken,
            orderItemSeqId: line,
            quantity: "3",
            expectedRevision: seen.revision,
            operationId: "op-update-0001"
        })
        const replay = cart("update#CartItem", {
            token: state.guestToken,
            orderItemSeqId: line,
            quantity: "3",
            expectedRevision: seen.revision,
            operationId: "op-update-0001"
        })
        const stale = cart("update#CartItem", {
            token: state.guestToken,
            orderItemSeqId: line,
            quantity: "1",
            expectedRevision: seen.revision
        })
        const revision = first.result.cart.revision
        const otherStoreCode = cart("apply#PromoCode", {
            token: state.guestToken,
            promoCode: ids.otherCode,
            expectedRevision: revision
        })
        const unknownCode = cart("apply#PromoCode", {
            token: state.guestToken,
            promoCode: "NO-SUCH-CODE",
            expectedRevision: revision
        })
        const applied = cart("apply#PromoCode", {
            token: state.guestToken,
            promoCode: ids.code.toLowerCase(),
            expectedRevision: revision
        })
        const removed = cart("remove#PromoCode", {
            token: state.guestToken,
            promoCode: ids.code,
            expectedRevision: applied.result?.cart.revision
        })
        return {seen, first, replay, stale, otherStoreCode, unknownCode, applied, removed}
    },
    then({seen, first, replay, stale, otherStoreCode, unknownCode, applied, removed}) {
        first.result.cart.items[0].quantity == "3"
        Number(first.result.cart.revision) > Number(seen.revision)
        replay.result.alreadyApplied == true
        replay.result.cart.revision == first.result.cart.revision
        stale.error.includes("STALE_REVISION")
        otherStoreCode.error.includes("PROMO_CODE_INVALID[promoCode]: This code cannot be used with this cart")
        unknownCode.error.includes("PROMO_CODE_INVALID[promoCode]: This code cannot be used with this cart")
        applied.result.cart.promoCodes.map(code => code.code) == [ids.code]
        applied.result.cart.totals.discounts.amount == "-2.00"
        applied.result.cart.totals.total.amount == "34.00"
        removed.result.cart.promoCodes.length == 0
        removed.result.cart.totals.discounts.amount == "0.00"
    }
})

feature("another store's or currency's cart is apart: the capability reaches nothing on the other site", {
    when() {
        const euro = cart("add#CartItem", {siteId: ids.euroSite, productId: ids.mug, quantity: "1"})
        return {
            euro,
            usdTokenOnEuro: cart("get#Cart", {siteId: ids.euroSite, token: state.guestToken}),
            euroTokenOnUsd: cart("get#Cart", {token: euro.result?.token}),
            euroChange: cart("remove#CartItem", {
                token: euro.result?.token,
                orderItemSeqId: euro.result?.cart.items[0].orderItemSeqId,
                expectedRevision: euro.result?.cart.revision
            })
        }
    },
    then({euro, usdTokenOnEuro, euroTokenOnUsd, euroChange}) {
        euro.result.cart.items[0].unitPrice.currencyUomId == "EUR"
        usdTokenOnEuro.result.cart.empty == true
        euroTokenOnUsd.result.cart.empty == true
        euroChange.error.includes("NOT_AVAILABLE")
    }
})

feature("sign-in merges the proven guest cart into the account's cart once and rotates; sign-out rotates the account's", {
    when() {
        const own = cart("add#CartItem", {productId: ids.mug, quantity: "1"}, "john.doe")
        const ownToken = own.result?.token
        const merged = cart("attach#Cart", {token: state.guestToken}, "john.doe")
        const guest = list("mantle.order.StoreCartAccess", {orderId: state.guestOrderId})[0]
        const guestOrder = one("mantle.order.OrderHeader", {orderId: state.guestOrderId})
        const again = cart("attach#Cart", {token: state.guestToken}, "john.doe")
        const oldGuestToken = cart("get#Cart", {token: state.guestToken})
        // a visitor using the browser with the account's capability reaches nothing, before and after sign-out
        const beforeRelease = cart("get#Cart", {token: again.result?.token})
        const accountDigest = () =>
            list("mantle.order.StoreCartAccess", {siteId: ids.site, customerPartyId: state.johnPartyId}).find(
                row => !row.revokedDate
            )?.capabilityDigest
        const digestBefore = accountDigest()
        const signedInWithToken = cart("get#Cart", {token: again.result?.token}, "john.doe")
        const released = cart("release#Cart", {token: again.result?.token}, "john.doe")
        const digestAfter = accountDigest()
        return {
            own,
            ownToken,
            merged,
            guest,
            guestOrder,
            again,
            oldGuestToken,
            beforeRelease,
            released,
            digestBefore,
            digestAfter,
            signedInWithToken,
            afterRelease: cart("get#Cart", {token: again.result?.token}),
            ownOldToken: cart("get#Cart", {token: ownToken}),
            signedInAgain: cart("get#Cart", {}, "john.doe"),
            visitorAttach: cart("attach#Cart", {token: again.result?.token})
        }
    },
    then({
        own,
        ownToken,
        merged,
        guest,
        guestOrder,
        again,
        oldGuestToken,
        beforeRelease,
        released,
        digestBefore,
        digestAfter,
        signedInWithToken,
        afterRelease,
        ownOldToken,
        signedInAgain,
        visitorAttach
    }) {
        own.result.cart.items.length == 1
        merged.result.merged == true
        merged.result.attached == true
        merged.result.token != ownToken
        merged.result.cart.items.map(item => item.productId).sort() == [ids.book, ids.mug].sort()
        merged.result.cart.items.find(item => item.productId === ids.book).quantity == "3"
        guest.revokeReasonEnumId == "ScrMerged"
        guestOrder.statusId == "OrderCancelled"
        again.result.merged == false
        again.result.cart.items.length == 2
        oldGuestToken.result.cart.empty == true
        beforeRelease.result.cart.items.length == 0
        signedInWithToken.result.cart.items.length == 2
        released.result.released == true
        digestBefore != digestAfter
        afterRelease.result.cart.empty == true
        ownOldToken.result.cart.empty == true
        signedInAgain.result.cart.items.length == 2
        visitorAttach.error.includes("SIGN_IN_REQUIRED")
    }
})

feature("merge#Parties moves a cart's access with its party (F23)", {
    when() {
        return system(() => {
            const from = call("mantle.party.PartyServices.create#Person", {firstName: "Cart", lastName: "From"}).partyId
            const to = call("mantle.party.PartyServices.create#Person", {firstName: "Cart", lastName: "To"}).partyId
            const access = make("mantle.order.StoreCartAccess", {
                siteId: ids.site,
                productStoreId: ids.store,
                currencyUomId: "USD",
                customerPartyId: from,
                capabilityDigest: "merge-test-digest",
                expireDate: new Date(Date.now() + 86400000)
            })
            call("mantle.party.DuplicateServices.merge#Parties", {toPartyId: to, fromPartyId: from})
            return {to, access: one("mantle.order.StoreCartAccess", {cartAccessId: access.cartAccessId})}
        })
    },
    then({to, access}) {
        access.customerPartyId == to
        access.capabilityDigest == "merge-test-digest"
    }
})
