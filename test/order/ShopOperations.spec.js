// Shop's operations (mr-pass impl-shop P8; mantle.order.ShopOperationsServices over ShopOperations.js; design-shop §7.1,
// §8.4, §17.1): an expired guest cart is cancelled through the order path and its guest party retired, while one whose
// checkout waits for its payment is left (F74); a stuck placement is retried and placed, or its payment refunded and its
// cart cancelled, only by a store's staff member with COMMERCE_PLACEMENT_RESOLVE and by its operation key (impl-commerce
// F108); with the Shop mount withdrawn the job still reconciles an open attempt and places its order, and the fulfillment
// job finds an approved Shop order whose approval never started its fulfillment (F96). Standalone: spec-local
// organizations, users, store, site, gateway and product; artifact authorization disabled (the rules are the services'
// own checks). Run: ./moq test mr-mantle --spec ShopOperations
const CART = "mantle.order.ShopCartServices."
const CHECKOUT = "mantle.order.ShopCheckoutServices."
const O = "mantle.order.ShopOperationsServices."
const S = "mantle.product.store."
const prefix = "SHOP8"
const ids = {
    org: prefix + "_ORG",
    other: prefix + "_OTHER_ORG",
    store: prefix + "_STORE",
    site: prefix + "_SITE",
    hosted: prefix + "_HOSTED",
    book: prefix + "_BOOK"
}
const users = {}
const make = (entity, values) => call("create#" + entity, values)
const one = (entity, fields) => ec.entity.find(entity).condition(fields).useCache(false).disableAuthz().one()
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
// an operation as a visitor: {result} or {error}
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
// a staff call in its own transaction: its result and its refusal ("" when it succeeds)
function run(username, service, parameters) {
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
function user(kind, organizationPartyId, permissions) {
    const id = prefix + "_" + kind.toUpperCase()
    make("mantle.party.Party", {partyId: id, partyTypeEnumId: "PtyPerson"})
    make("mantle.party.Person", {partyId: id, firstName: "Operations", lastName: kind})
    make("mantle.party.PartyRelationship", {
        partyRelationshipId: id,
        fromPartyId: id,
        toPartyId: organizationPartyId,
        relationshipTypeEnumId: "PrtAgent",
        fromDate: 0
    })
    make("moqui.security.UserGroup", {userGroupId: id, description: "Shop operations " + kind})
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
// a guest's cart of the book: {token, access}
function cart() {
    const added = op(CART + "add#CartItem", {productId: ids.book, quantity: "1"})
    const token = added.result.token
    const digest = ec.resource.script("component://mr-mantle/service/mantle/party/ExternalAccess.js").tokenDigest(token)
    return {token, access: one("mantle.order.StoreCartAccess", {capabilityDigest: digest})}
}
// a guest's cart submitted to the hosted page (its payment pending there): {token, access, submitted, checkout}
function submitted() {
    const c = cart()
    op(CHECKOUT + "begin#Checkout", {token: c.token})
    op(CHECKOUT + "set#CheckoutContact", {token: c.token, emailAddress: "ops@shop8.example.test", name: "Olive Ops"})
    op(CHECKOUT + "select#Payment", {token: c.token, paymentOptionId: "PiCreditCard"})
    const view = op(CHECKOUT + "get#Checkout", {token: c.token}).result
    const out = op(CHECKOUT + "submit#Checkout", {token: c.token, expectedRevision: view.checkout.revision})
    return Object.assign(c, {
        submitted: out.result,
        checkout: list("mantle.order.StoreCheckout", {cartAccessId: c.access.cartAccessId})[0]
    })
}
// the provider's return (the test page approves on the first lookup)
function returned(s) {
    system(() =>
        call("update#mantle.account.payment.PortalPaymentAttempt", {paymentId: s.checkout.paymentId, lastCheckDate: null})
    )
    return op(CHECKOUT + "get#CheckoutPaymentResult", {reference: s.submitted.checkout.reference, key: s.submitted.returnKey})
}
const checkoutOf = s => one("mantle.order.StoreCheckout", {checkoutId: s.checkout.checkoutId})
const key = () => prefix + "-" + Math.random().toString(36).slice(2, 12)

// The cart-making specs of one run share the requester's cart-creation throttle (30 in ten minutes, Shop P4): this window's
// bucket goes before and after this spec's carts (as mr-pass ShopCheckout does, Commerce F128); the throttle is unchanged.
function resetCartCreations() {
    const requester = ec.resource.script("component://framework/service/org/moqui/public/Account.js").requesterKey()
    const window = Math.floor(ec.user.timestampMillis(ec.user.nowTimestamp) / 600000)
    system(() =>
        ec.entity
            .find("moqui.security.public.AccountAttempt")
            .condition({bucketId: ec.user.singleUseCodeHash("cart-create:" + requester + ":" + window)})
            .deleteAll()
    )
}

spec({
    setupSpec() {
        resetCartCreations()
        system(() => {
            for (const [partyId, name] of [
                [ids.org, "Operations organization"],
                [ids.other, "Operations other organization"]
            ]) {
                make("mantle.party.Party", {partyId, partyTypeEnumId: "PtyOrganization"})
                make("mantle.party.Organization", {partyId, organizationName: name})
                make("mantle.party.PartyRole", {partyId, roleTypeId: "OrgInternal"})
            }
            users.operator = user("operator", ids.org, ["COMMERCE_VIEW", "COMMERCE_ORDER_VIEW"])
            users.resolver = user("resolver", ids.org, ["COMMERCE_VIEW", "COMMERCE_ORDER_VIEW", "COMMERCE_PLACEMENT_RESOLVE"])
            users.outsider = user("outsider", ids.other, ["COMMERCE_VIEW", "COMMERCE_ORDER_VIEW", "COMMERCE_PLACEMENT_RESOLVE"])
            make(S + "ProductStore", {
                productStoreId: ids.store,
                storeName: "Operations store",
                organizationPartyId: ids.org,
                defaultCurrencyUomId: "USD",
                defaultLocale: "en_US",
                requireInventory: "N"
            })
            make(S + "ProductStoreSetting", {
                productStoreId: ids.store,
                settingTypeEnumId: "PsstCheckoutTerms",
                fromDate: 0,
                settingValue: "false"
            })
            make("mantle.public.PublicSite", {
                siteId: ids.site,
                name: "Operations site",
                state: "published",
                locale: "en",
                generation: 1
            })
            make("mantle.public.PublicSiteHost", {hostname: "ops.shop8.example.test", siteId: ids.site, canonical: "Y"})
            make("mantle.public.PublicSiteApp", {
                siteId: ids.site,
                appMountId: "shop",
                app: "shop",
                pathPrefix: "/shop",
                enabled: "Y",
                targetId: ids.store
            })
            const T = "mantle.account.PaymentTestServices."
            make("mantle.account.method.PaymentGatewayConfig", {
                paymentGatewayConfigId: ids.hosted,
                paymentGatewayTypeEnumId: "PgtTest",
                description: "Operations hosted test gateway",
                authorizeServiceName: T + "hostedPending#PaymentAuthorization",
                captureServiceName: T + "alwaysApprove#PaymentCapture",
                releaseServiceName: T + "alwaysApprove#PaymentRelease",
                refundServiceName: T + "alwaysApprove#PaymentRefund",
                detailsServiceName: T + "alwaysApprove#PaymentDetails"
            })
            make("mantle.account.method.PaymentGatewayOrganization", {
                organizationPartyId: ids.org,
                paymentGatewayConfigId: ids.hosted,
                fromDate: 0,
                isEnabled: "Y"
            })
            make(S + "ProductStorePaymentGateway", {
                productStoreId: ids.store,
                paymentInstrumentEnumId: "PiCreditCard",
                paymentGatewayConfigId: ids.hosted
            })
            make("mantle.product.Product", {
                productId: ids.book,
                productName: "Operations book",
                productTypeEnumId: "PtDigital",
                ownerPartyId: ids.org
            })
            make("mantle.product.ProductPrice", {
                productId: ids.book,
                pricePurposeEnumId: "PppPurchase",
                priceTypeEnumId: "PptCurrent",
                fromDate: 0,
                minQuantity: 1,
                price: "12.00",
                priceUomId: "USD"
            })
            make(S + "ProductStoreProduct", {
                productStoreId: ids.store,
                productId: ids.book,
                fromDate: 0,
                publicationKindEnumId: "PspkPublished"
            })
        })
    },
    cleanup() {
        login("john.doe")
    },
    cleanupSpec() {
        resetCartCreations()
    }
})

feature("an expired cart is cancelled through the order path and its guest retired; one waiting for its payment is left", {
    when() {
        const plain = cart()
        const waiting = submitted()
        // review R2: a cart whose guestPartyId names a party staff keep (merge#Parties moves it there): never disabled
        const kept = cart()
        system(() => make("mantle.party.PartyRole", {partyId: kept.access.guestPartyId, roleTypeId: "Supplier"}))
        system(() => {
            for (const c of [plain, waiting, kept])
                call("update#mantle.order.StoreCartAccess", {
                    cartAccessId: c.access.cartAccessId,
                    expireDate: new Date(Date.now() - 60000)
                })
        })
        const job = system(() => call(O + "retire#ExpiredCarts", {limit: 500}))
        return {
            job,
            plainAccess: one("mantle.order.StoreCartAccess", {cartAccessId: plain.access.cartAccessId}),
            plainOrder: one("mantle.order.OrderHeader", {orderId: plain.access.orderId}),
            guest: one("mantle.party.Party", {partyId: plain.access.guestPartyId}),
            keptOrder: one("mantle.order.OrderHeader", {orderId: kept.access.orderId}),
            keptParty: one("mantle.party.Party", {partyId: kept.access.guestPartyId}),
            waitingAccess: one("mantle.order.StoreCartAccess", {cartAccessId: waiting.access.cartAccessId}),
            waitingOrder: one("mantle.order.OrderHeader", {orderId: waiting.access.orderId}),
            waitingCheckout: checkoutOf(waiting),
            // the job itself: nothing left to retire, and no hosted reference of this store to search
            again: system(() => call(O + "run#ShopOperations", {limit: 500}))
        }
    },
    then({job, plainAccess, plainOrder, guest, keptOrder, keptParty, waitingAccess, waitingOrder, waitingCheckout, again}) {
        job.failed == 0
        job.retired >= 1
        job.waiting >= 1
        plainAccess.revokeReasonEnumId == "ScrExpired"
        plainOrder.statusId == "OrderCancelled"
        guest.disabled == "Y"
        keptOrder.statusId == "OrderCancelled"
        keptParty.disabled != "Y"
        waitingAccess.revokedDate == null
        waitingOrder.statusId == "OrderOpen"
        waitingCheckout.statusId == "ScoPaymentPending"
        again.carts.retired == 0
        again.references.failed == 0
    }
})

feature("a stuck placement is retried and placed, or refunded and its cart cancelled, by a resolver of its store only", {
    when() {
        // one past its tries (its five failures stood in for), one whose order changed after its submit
        const tried = submitted()
        system(() => call("update#mantle.order.StoreCheckout", {checkoutId: tried.checkout.checkoutId, placementTries: 5}))
        returned(tried)
        const changed = submitted()
        const line = list("mantle.order.OrderItem", {orderId: changed.checkout.orderId, productId: ids.book})[0]
        system(() =>
            call("mantle.order.OrderServices.update#OrderItem", {
                orderId: changed.checkout.orderId,
                orderItemSeqId: line.orderItemSeqId,
                quantity: 2
            })
        )
        returned(changed)
        const stuck = {tried: checkoutOf(tried).statusId, changed: checkoutOf(changed).failureCode}
        const resolve = (username, s, action, operationKey) =>
            run(username, O + "resolve#StuckPlacement", {
                orderId: s.checkout.orderId,
                action,
                reason: "Spec resolution",
                operationKey
            })
        const refused = {
            operator: resolve(users.operator, tried, "retry", key()),
            outsider: resolve(users.outsider, tried, "retry", key()),
            noReason: run(users.resolver, O + "resolve#StuckPlacement", {
                orderId: tried.checkout.orderId,
                action: "retry",
                operationKey: key()
            })
        }
        // review R1: while a refund of it is in progress no placement lands (the job) and a retry is refused
        system(() =>
            call("update#mantle.order.StoreCheckout", {
                checkoutId: tried.checkout.checkoutId,
                placementTries: 0,
                failureCode: "REFUND_PENDING"
            })
        )
        const pendingRetry = resolve(users.resolver, tried, "retry", key())
        system(() => call(CHECKOUT + "reconcile#Checkouts", {limit: 500}))
        const pendingState = checkoutOf(tried).statusId
        system(() =>
            call("update#mantle.order.StoreCheckout", {
                checkoutId: tried.checkout.checkoutId,
                placementTries: 5,
                failureCode: null
            })
        )
        const retried = resolve(users.resolver, tried, "retry", key())
        const refundKey = key()
        const refunded = resolve(users.resolver, changed, "refund", refundKey)
        const replayed = resolve(users.resolver, changed, "refund", refundKey)
        return {
            stuck,
            refused,
            pendingRetry,
            pendingState,
            retried,
            refunded,
            replayed,
            triedOrder: one("mantle.order.OrderHeader", {orderId: tried.checkout.orderId}),
            triedCheckout: checkoutOf(tried),
            changedCheckout: checkoutOf(changed),
            changedOrder: one("mantle.order.OrderHeader", {orderId: changed.checkout.orderId}),
            changedAccess: one("mantle.order.StoreCartAccess", {cartAccessId: changed.access.cartAccessId}),
            changedPayment: one("mantle.account.payment.Payment", {paymentId: changed.checkout.paymentId}),
            refundPayments: list("mantle.account.method.PaymentGatewayResponse", {paymentId: changed.checkout.paymentId}).filter(
                row => ["PgoRelease", "PgoRefund"].includes(row.paymentOperationEnumId) && row.resultSuccess == "Y"
            ).length,
            again: resolve(users.resolver, changed, "retry", key())
        }
    },
    then({
        stuck,
        refused,
        pendingRetry,
        pendingState,
        retried,
        refunded,
        replayed,
        triedOrder,
        triedCheckout,
        changedCheckout,
        changedOrder,
        changedAccess,
        changedPayment,
        refundPayments,
        again
    }) {
        stuck.tried == "ScoPlacementPending"
        stuck.changed == "ORDER_CHANGED"
        refused.operator.error.includes("PERMISSION_DENIED")
        refused.outsider.error.includes("RECORD_UNAVAILABLE")
        refused.noReason.error.includes("REASON_REQUIRED")
        pendingRetry.error.includes("REFUND_PENDING")
        pendingState == "ScoPlacementPending"
        retried.error == ""
        retried.resolved == true
        triedCheckout.statusId == "ScoCompleted"
        triedOrder.statusId != "OrderOpen"
        refunded.error == ""
        refunded.resolved == true
        refunded.stateText.includes("by " + prefix + "_RESOLVER: Spec resolution")
        replayed.alreadyApplied == true
        changedCheckout.statusId == "ScoCancelled"
        changedCheckout.failureMessage.includes("Spec resolution")
        changedOrder.statusId == "OrderCancelled"
        changedAccess.revokeReasonEnumId == "ScrCancelled"
        // released when only authorized, else a refund payment made
        changedPayment.statusId != "PmntAuthorized" || refundPayments > 0
        again.error.includes("RECORD_UNAVAILABLE")
    }
})

feature(
    "with the Shop mount withdrawn the job places an open attempt's order; fulfillment finds an approved order it never started",
    {
        when() {
            const open = submitted()
            system(() => call("update#mantle.public.PublicSiteApp", {siteId: ids.site, appMountId: "shop", enabled: "N"}))
            system(() =>
                call("update#mantle.account.payment.PortalPaymentAttempt", {
                    paymentId: open.checkout.paymentId,
                    lastCheckDate: null,
                    nextCheckDate: null
                })
            )
            const reconciled = system(() => call(CHECKOUT + "reconcile#Checkouts", {limit: 500}))
            system(() => call("update#mantle.public.PublicSiteApp", {siteId: ids.site, appMountId: "shop", enabled: "Y"}))
            const placed = checkoutOf(open)
            // approved with no fulfillment row, as when the approval's commit is followed by a crash before its SECA
            system(() => {
                const header = ec.entity
                    .find("mantle.order.OrderHeader")
                    .condition("orderId", placed.orderId)
                    .useCache(false)
                    .one()
                header.set("statusId", "OrderApproved")
                header.update()
            })
            const before = list("mantle.product.store.StoreItemFulfillment", {orderId: placed.orderId}).length
            const job = system(() => call("mantle.product.ShopFulfillmentServices.fulfill#StoreItems", {limit: 500}))
            return {
                reconciled,
                placed,
                order: one("mantle.order.OrderHeader", {orderId: placed.orderId}),
                before,
                after: list("mantle.product.store.StoreItemFulfillment", {orderId: placed.orderId})
            }
        },
        then({reconciled, placed, order, before, after}) {
            reconciled.failed == 0
            placed.statusId == "ScoCompleted"
            order.statusId != "OrderOpen"
            before == 0
            after.length == 1
            after[0].productId == ids.book
        }
    }
)
