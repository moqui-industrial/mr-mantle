// Shop's checkout and payment (mr-pass impl-shop P5; mantle.order.ShopCheckoutServices over ShopCheckout.js; design-shop
// §6 Checkout, §7.2-§7.3, §8): a guest checks out a physical item through the hosted test gateway (contact, address, the
// delivery quote, payment, a submit that freezes and starts one attempt), the provider's return only looks it up, and the
// order is placed once; a second submit answers the first; a changed price is reviewRequired and the resubmit at the new
// revision goes on; an unknown outcome stays unknown and makes no new attempt or key; a placement that fails after the
// provider's success keeps the payment and its attempt, and the job places it later; a promotion past its limit at the
// freeze is reviewRequired; nothing due skips the gateway. Standalone: spec-local organization, store, site, gateways and
// products. Run: ./moq test mr-mantle --spec ShopCheckout
const CART = "mantle.order.ShopCartServices."
const CHECKOUT = "mantle.order.ShopCheckoutServices."
const S = "mantle.product.store."
const prefix = "SHCO"
const ids = {
    org: prefix + "_ORG",
    store: prefix + "_STORE",
    site: prefix + "_SITE",
    host: "checkout.shco.example.test",
    hosted: prefix + "_HOSTED",
    unknown: prefix + "_UNKNOWN",
    book: prefix + "_BOOK",
    mug: prefix + "_MUG",
    free: prefix + "_FREE",
    promotion: prefix + "_PROMO",
    code: prefix + "_ONCE"
}
const make = (entity, values) => call("create#" + entity, values)
const one = (entity, fields) => ec.entity.find(entity).condition(fields).disableAuthz().one()
const list = (entity, fields) => Array.from(ec.entity.find(entity).condition(fields).disableAuthz().list())
function system(action) {
    login("john.doe")
    const was = ec.artifactExecution.disableAuthz()
    try {
        return action()
    } finally {
        if (!was) ec.artifactExecution.enableAuthz()
    }
}
// an operation as a visitor (no one signed in): {result} or {error}
function op(service, input) {
    logout()
    ec.message.pushErrors()
    try {
        const out =
            ec.service
                .sync()
                .name(service)
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
const checkout = (name, input) => op(CHECKOUT + name, input)
// a guest's cart with a product and its checkout up to a ready payment: {token, view}
function readyCart(productId, quantity, {physical = false, code = null} = {}) {
    const added = op(CART + "add#CartItem", {productId, quantity: String(quantity || 1)})
    const token = added.result.token
    if (code) op(CART + "apply#PromoCode", {token, promoCode: code, expectedRevision: added.result.cart.revision})
    checkout("begin#Checkout", {token})
    checkout("set#CheckoutContact", {token, emailAddress: "guest@shco.example.test", name: "Gail Guest"})
    if (physical) {
        const begun = checkout("get#Checkout", {token}).result
        checkout("set#CheckoutAddresses", {
            token,
            expectedRevision: begun.checkout.revision,
            address1: "1 Checkout Way",
            city: "Springfield",
            postalCode: "62701",
            countryGeoId: "USA"
        })
        const options = checkout("get#DeliveryOptions", {token}).result
        checkout("select#Delivery", {
            token,
            expectedRevision: options.revision,
            carrierPartyId: "_NA_",
            shipmentMethodEnumId: "ShMthGround"
        })
    }
    checkout("select#Payment", {token, paymentOptionId: "PiCreditCard"})
    return {token, view: checkout("get#Checkout", {token}).result}
}
const submit = (token, revision, operationId) =>
    checkout("submit#Checkout", Object.assign({token, expectedRevision: revision}, operationId ? {operationId} : {}))
// the provider's return a while after the submit (the first look at the provider waits a moment after it)
function returned(reference, key) {
    system(() => {
        const row = one("mantle.order.StoreCheckout", {returnReference: reference})
        if (row?.paymentId)
            call("update#mantle.account.payment.PortalPaymentAttempt", {paymentId: row.paymentId, lastCheckDate: null})
    })
    return checkout("get#CheckoutPaymentResult", {reference, key})
}
const checkoutRow = token => {
    const digest = ec.resource.script("component://mr-mantle/service/mantle/party/ExternalAccess.js").tokenDigest(token)
    const access = one("mantle.order.StoreCartAccess", {capabilityDigest: digest})
    return access ? list("mantle.order.StoreCheckout", {cartAccessId: access.cartAccessId})[0] : null
}

spec({
    setupSpec() {
        system(() => {
            make("mantle.party.Party", {partyId: ids.org, partyTypeEnumId: "PtyOrganization"})
            make("mantle.party.Organization", {partyId: ids.org, organizationName: "Checkout organization"})
            make("mantle.party.PartyRole", {partyId: ids.org, roleTypeId: "OrgInternal"})
            make("mantle.facility.Facility", {
                facilityId: prefix + "_WH",
                facilityTypeEnumId: "FcTpWarehouse",
                ownerPartyId: ids.org,
                facilityName: "Checkout warehouse"
            })
            make(S + "ProductStore", {
                productStoreId: ids.store,
                inventoryFacilityId: prefix + "_WH",
                storeName: "Checkout store",
                organizationPartyId: ids.org,
                defaultCurrencyUomId: "USD",
                defaultLocale: "en_US",
                requireInventory: "N",
                defaultDisableShippingCalc: "Y"
            })
            // the spec store takes no terms (the terms page is SitePages'), and delivers by its local gateway at 5.00
            make(S + "ProductStoreSetting", {
                productStoreId: ids.store,
                settingTypeEnumId: "PsstCheckoutTerms",
                fromDate: 0,
                settingValue: "false"
            })
            make(S + "ProductStoreShippingGateway", {
                productStoreId: ids.store,
                carrierPartyId: "_NA_",
                shippingGatewayConfigId: "NA_LOCAL"
            })
            make(S + "ProductStoreShipOption", {
                productStoreId: ids.store,
                carrierPartyId: "_NA_",
                shipmentMethodEnumId: "ShMthGround",
                sequenceNum: 1
            })
            make(S + "ProductStoreShippingRate", {
                productStoreId: ids.store,
                geoId: "USA",
                carrierPartyId: "_NA_",
                shipmentMethodEnumId: "ShMthGround",
                shippingAmount: "5.00",
                currencyUomId: "USD",
                priority: 1,
                fromDate: 0
            })
            make("mantle.public.PublicSite", {
                siteId: ids.site,
                name: "Checkout site",
                state: "published",
                locale: "en",
                generation: 1
            })
            make("mantle.public.PublicSiteHost", {hostname: ids.host, siteId: ids.site, canonical: "Y"})
            make("mantle.public.PublicSiteApp", {
                siteId: ids.site,
                appMountId: "shop",
                app: "shop",
                pathPrefix: "/shop",
                enabled: "Y",
                targetId: ids.store
            })
            // the hosted test gateway (its page returns the payer; its lookup approves), and one whose answer is lost
            const T = "mantle.account.PaymentTestServices."
            make("mantle.account.method.PaymentGatewayConfig", {
                paymentGatewayConfigId: ids.hosted,
                paymentGatewayTypeEnumId: "PgtTest",
                description: "Checkout hosted test gateway",
                authorizeServiceName: T + "hostedPending#PaymentAuthorization",
                captureServiceName: T + "alwaysApprove#PaymentCapture",
                detailsServiceName: T + "alwaysApprove#PaymentDetails"
            })
            make("mantle.account.method.PaymentGatewayConfig", {
                paymentGatewayConfigId: ids.unknown,
                paymentGatewayTypeEnumId: "PgtTest",
                description: "Checkout lost-answer test gateway",
                authorizeServiceName: T + "alwaysUnknown#PaymentAuthorization",
                detailsServiceName: T + "alwaysPending#PaymentDetails"
            })
            for (const paymentGatewayConfigId of [ids.hosted, ids.unknown])
                make("mantle.account.method.PaymentGatewayOrganization", {
                    organizationPartyId: ids.org,
                    paymentGatewayConfigId,
                    fromDate: 0,
                    isEnabled: "Y"
                })
            make(S + "ProductStorePaymentGateway", {
                productStoreId: ids.store,
                paymentInstrumentEnumId: "PiCreditCard",
                paymentGatewayConfigId: ids.hosted
            })
            for (const [productId, amount, type] of [
                [ids.book, "12.00", "PtDigital"],
                [ids.mug, "8.50", "PtAsset"],
                [ids.free, "0.00", "PtDigital"]
            ]) {
                make("mantle.product.Product", {
                    productId,
                    productName: "Checkout " + productId,
                    productTypeEnumId: type,
                    ownerPartyId: ids.org
                })
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
            // 2.00 off a book with a code that one order may use
            make(S + "ProductStorePromotion", {
                storePromotionId: ids.promotion,
                productStoreId: ids.store,
                itemDescription: "Once off",
                serviceRegisterId: "FlatDiscount",
                requireCode: "Y"
            })
            make(S + "ProductStorePromoParameter", {
                storePromotionId: ids.promotion,
                parameterName: "discountAmount",
                parameterValue: "2"
            })
            make(S + "ProductStorePromoProduct", {storePromotionId: ids.promotion, productId: ids.book, excludeProduct: "N"})
            make(S + "ProductStorePromoCode", {
                promoCodeId: ids.code,
                storePromotionId: ids.promotion,
                promoCode: ids.code,
                requireParty: "N",
                useLimitPerCode: 1
            })
        })
    },
    cleanup() {
        login("john.doe")
    }
})

feature("a guest checks out a physical item through the hosted page; the return's lookup places the order once", {
    when() {
        const {token, view} = readyCart(ids.mug, 2, {physical: true})
        const submitted = submit(token, view.checkout.revision, "shco-submit-0001")
        const row = checkoutRow(token)
        const payments = list("mantle.account.payment.Payment", {orderId: row.orderId})
        const attempt = one("mantle.account.payment.PortalPaymentAttempt", {paymentId: row.paymentId})
        // the same submit sent again answers its first result; a second submit (another tab) answers the first attempt,
        // never a second payment
        const replayed = submit(token, view.checkout.revision, "shco-submit-0001")
        const again = submit(token, view.checkout.revision, "shco-submit-0002")
        const reference = submitted.result?.checkout.reference
        const key = submitted.result?.returnKey
        // the provider's return: only the reference and key, which look the payment up (the test gateway's lookup approves)
        const result = returned(reference, key)
        const replayedAfter = submit(token, view.checkout.revision, "shco-submit-0001")
        const badKey = checkout("get#CheckoutPaymentResult", {reference, key: "x".repeat(40)})
        const confirmation = checkout("get#OrderConfirmation", {reference, key})
        const confirmedAgain = checkout("get#OrderConfirmation", {reference, key})
        const byOrderToken = checkout("get#OrderConfirmation", {orderToken: confirmation.result?.orderToken})
        const order = one("mantle.order.OrderHeader", {orderId: row.orderId})
        return {
            view,
            submitted,
            row,
            payments,
            attempt,
            again,
            replayed,
            replayedAfter,
            result,
            badKey,
            confirmation,
            confirmedAgain,
            byOrderToken,
            order,
            after: one("mantle.order.StoreCheckout", {checkoutId: row.checkoutId}),
            access: one("mantle.order.StoreCartAccess", {cartAccessId: row.cartAccessId}),
            paymentsAfter: list("mantle.account.payment.Payment", {orderId: row.orderId}),
            authorizations: list("mantle.account.method.PaymentGatewayResponse", {paymentId: row.paymentId}).filter(r =>
                ["PgoAuthorize", "PgoAuthAndCapture"].includes(r.paymentOperationEnumId)
            ),
            cartAfter: op(CART + "add#CartItem", {token, productId: ids.mug, quantity: "1"})
        }
    },
    then(r) {
        // ready: contact, the delivery address, the 5.00 quote, the hosted option; the totals are the order's
        r.view.checkout.state == "ready"
        r.view.checkout.delivery.selected.amount.amount == "5.00"
        r.view.checkout.totals.shipping.amount == "5.00"
        r.view.checkout.totals.total.amount == "22.00"
        r.view.checkout.payment.options.length == 1
        !r.view.checkout.payment.options[0].paymentGatewayConfigId
        // submitted: frozen at its revision, one promised payment and its shopCheckout attempt, sent to the hosted page
        r.submitted.result.checkout.state == "paymentPending"
        r.submitted.result.returnKey.length == 40
        r.submitted.result.checkout.attempt.state == "pending"
        r.submitted.result.checkout.attempt.providerUrl.startsWith("https://" + ids.host + "/shop/Checkout/return?ref=")
        r.row.frozenRevision == Number(r.view.checkout.revision)
        r.row.snapshotHash.length > 10
        r.payments.length == 1
        r.payments[0].statusId == "PmntPromised"
        toDecimal(r.payments[0].amount).eq(22)
        r.attempt.purposeEnumId == "PapShopCheckout"
        r.attempt.checkoutId == r.row.checkoutId
        r.attempt.snapshotHash == r.row.snapshotHash
        // the second submit and the replay answer the first attempt; the key is never replayed
        r.replayed.result.alreadyApplied == true
        !r.replayed.result.returnKey
        r.again.result.alreadySubmitted == true
        r.again.result.checkout.state == "paymentPending"
        !r.again.result.returnKey
        r.replayedAfter.result.alreadyApplied == true
        // the return: looked up, approved and placed once; a wrong key reaches nothing
        r.result.result.checkout.state == "completed"
        r.badKey.error.includes("NOT_AVAILABLE")
        r.order.statusId != "OrderOpen"
        r.after.statusId == "ScoCompleted"
        r.after.placementIntentDate != null
        r.access.revokeReasonEnumId == "ScrPlaced"
        r.paymentsAfter.length == 1
        r.paymentsAfter[0].statusId == "PmntDelivered"
        r.authorizations.length == 1
        // the confirmation: the order, a guest's order link once (its SalesOrder OrderView capability reads it)
        r.confirmation.result.confirmation.orderId == r.row.orderId
        r.confirmation.result.confirmation.delivery.address.includes("1 Checkout Way")
        r.confirmation.result.orderToken.length == 48
        !r.confirmedAgain.result.orderToken
        r.byOrderToken.result.confirmation.orderId == r.row.orderId
        !r.confirmation.result.confirmation.orderUrl.includes(r.confirmation.result.orderToken)
        // the placed cart's capability changes nothing (a new add makes a new cart)
        r.cartAfter.result.token != null
    }
})

feature("a changed price gives reviewRequired with the change; the submit at the new revision goes on", {
    when() {
        const {token, view} = readyCart(ids.book, 1)
        const price = system(() => list("mantle.product.ProductPrice", {productId: ids.book})[0])
        system(() => call("update#mantle.product.ProductPrice", {productPriceId: price.productPriceId, price: "13.00"}))
        const changed = submit(token, view.checkout.revision)
        const reviewed = checkout("get#Checkout", {token})
        const resubmitted = submit(token, reviewed.result.checkout.revision)
        system(() => call("update#mantle.product.ProductPrice", {productPriceId: price.productPriceId, price: "12.00"}))
        const row = checkoutRow(token)
        return {view, changed, reviewed, resubmitted, payment: one("mantle.account.payment.Payment", {paymentId: row.paymentId})}
    },
    then({view, changed, reviewed, resubmitted, payment}) {
        view.checkout.totals.total.amount == "12.00"
        changed.error.includes("REVIEW_REQUIRED")
        changed.error.includes("13.00")
        reviewed.result.checkout.state == "reviewRequired"
        reviewed.result.checkout.review[0].kind == "price"
        reviewed.result.checkout.totals.total.amount == "13.00"
        reviewed.result.checkout.revision != view.checkout.revision
        resubmitted.result.checkout.state == "paymentPending"
        toDecimal(payment.amount).eq(13)
    }
})

feature("an unknown provider outcome stays unknown across lookups; a resubmit makes no new attempt or key", {
    when() {
        const {token, view} = readyCart(ids.book, 1)
        // the provider's answer is lost: the store's gateway for this checkout answers unknown, and its lookup cannot tell
        system(() =>
            call("update#mantle.order.StoreCheckout", {
                checkoutId: checkoutRow(token).checkoutId,
                paymentGatewayConfigId: ids.unknown
            })
        )
        const submitted = submit(token, view.checkout.revision)
        const reference = submitted.result.checkout.reference
        const key = submitted.result.returnKey
        const looked = checkout("get#CheckoutPaymentResult", {reference, key})
        system(() =>
            call("update#mantle.account.payment.PortalPaymentAttempt", {
                paymentId: checkoutRow(token).paymentId,
                lastCheckDate: null
            })
        )
        const lookedAgain = checkout("get#CheckoutPaymentResult", {reference, key})
        const resubmitted = submit(token, view.checkout.revision)
        const resumed = checkout("resume#Checkout", {reference, key})
        const row = checkoutRow(token)
        const responses = list("mantle.account.method.PaymentGatewayResponse", {paymentId: row.paymentId})
        return {
            submitted,
            looked,
            lookedAgain,
            resubmitted,
            resumed,
            row,
            responses,
            payments: list("mantle.account.payment.Payment", {orderId: row.orderId})
        }
    },
    then({submitted, looked, lookedAgain, resubmitted, resumed, row, responses, payments}) {
        submitted.result.checkout.attempt.state == "unknown"
        looked.result.checkout.state == "paymentPending"
        looked.result.checkout.attempt.state == "unknown"
        lookedAgain.result.checkout.attempt.state == "unknown"
        resubmitted.result.alreadySubmitted == true
        resumed.result.checkout.attempt.state == "unknown"
        !resumed.result.token
        payments.length == 1
        payments[0].statusId == "PmntPromised"
        responses.filter(r => r.paymentOperationEnumId == "PgoAuthorize").length == 1
        new Set(responses.filter(r => r.idempotencyKey).map(r => r.idempotencyKey)).size == 1
        responses.filter(r => r.paymentOperationEnumId == "PgoTxDetails").length >= 1
        row.statusId == "ScoPaymentPending"
    }
})

feature("a placement that fails after the provider's success keeps the payment and attempt; the job places it later", {
    when() {
        const {token, view} = readyCart(ids.mug, 1, {physical: true})
        const submitted = submit(token, view.checkout.revision)
        // stock is lost after the payment (the store now requires inventory it has none of): placement fails
        system(() => call("update#mantle.product.store.ProductStore", {productStoreId: ids.store, requireInventory: "Y"}))
        const result = returned(submitted.result.checkout.reference, submitted.result.returnKey)
        const row = checkoutRow(token)
        const failed = {
            checkout: one("mantle.order.StoreCheckout", {checkoutId: row.checkoutId}),
            order: one("mantle.order.OrderHeader", {orderId: row.orderId}),
            payment: one("mantle.account.payment.Payment", {paymentId: row.paymentId}),
            attempt: one("mantle.account.payment.PortalPaymentAttempt", {paymentId: row.paymentId})
        }
        system(() => call("update#mantle.product.store.ProductStore", {productStoreId: ids.store, requireInventory: "N"}))
        const job = system(() => call(CHECKOUT + "reconcile#Checkouts", {limit: 50}))
        return {
            result,
            failed,
            job,
            after: one("mantle.order.StoreCheckout", {checkoutId: row.checkoutId}),
            order: one("mantle.order.OrderHeader", {orderId: row.orderId})
        }
    },
    then({result, failed, job, after, order}) {
        result.result.checkout.state == "placementPending"
        failed.checkout.statusId == "ScoPlacementPending"
        failed.checkout.failureCode != null
        failed.checkout.placementTries == 1
        failed.order.statusId == "OrderOpen"
        failed.payment.statusId == "PmntDelivered"
        failed.attempt.outcome == "approved"
        job.failed == 0
        after.statusId == "ScoCompleted"
        order.statusId != "OrderOpen"
    }
})

feature("a promotion past its limit at the freeze is reviewRequired; nothing due skips the gateway", {
    when() {
        // two carts with the one-order code; the first is placed, the second's freeze finds the limit used
        const first = readyCart(ids.book, 1, {code: ids.code})
        const second = readyCart(ids.book, 1, {code: ids.code})
        const placed = submit(first.token, first.view.checkout.revision)
        returned(placed.result.checkout.reference, placed.result.returnKey)
        const limited = submit(second.token, second.view.checkout.revision)
        const reviewed = checkout("get#Checkout", {token: second.token})
        // a free item: no payment option to choose, no gateway, placed by the submit
        const added = op(CART + "add#CartItem", {productId: ids.free, quantity: "1"})
        const token = added.result.token
        checkout("begin#Checkout", {token})
        checkout("set#CheckoutContact", {token, emailAddress: "free@shco.example.test", name: "Fran Free"})
        const free = checkout("get#Checkout", {token}).result
        const freeSubmitted = submit(token, free.checkout.revision)
        const freeRow = checkoutRow(token)
        return {
            first: first.view,
            limited,
            reviewed,
            free,
            freeSubmitted,
            freePayments: list("mantle.account.payment.Payment", {orderId: freeRow.orderId}),
            freeOrder: one("mantle.order.OrderHeader", {orderId: freeRow.orderId})
        }
    },
    then({first, limited, reviewed, free, freeSubmitted, freePayments, freeOrder}) {
        first.checkout.totals.total.amount == "10.00"
        limited.error.includes("REVIEW_REQUIRED")
        reviewed.result.checkout.state == "reviewRequired"
        reviewed.result.checkout.review.some(change => change.kind == "promotionLimit")
        free.checkout.payment.needed == false
        free.checkout.state == "ready"
        freeSubmitted.result.checkout.state == "completed"
        !freeSubmitted.result.checkout.attempt
        freePayments.length == 0
        freeOrder.statusId != "OrderOpen"
    }
})
