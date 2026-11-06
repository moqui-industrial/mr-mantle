// Shop's customer account (mr-pass impl-shop P6; mantle.party.ShopCustomerServices over ShopCustomer.js; design-shop §9):
// a guest's order link reads its one order, a verified account its own (claiming the guest purchases of its verified email),
// and another order is refused alike either way, an unverified account seeing none; the order's invoice is the account's in
// Billing; reorder rebuilds the lines in a cart at today's price; addresses are owned; a card is added through the gateway's
// hosted setup once, and ending one names the recurring order it pays. Standalone: spec-local organization, store, site,
// gateway, products and accounts. Run: ./moq test mr-mantle --spec ShopCustomer
const CART = "mantle.order.ShopCartServices."
const CHECKOUT = "mantle.order.ShopCheckoutServices."
const A = "mantle.party.ShopCustomerServices."
const S = "mantle.product.store."
const prefix = "SHCU"
const ids = {
    org: prefix + "_ORG",
    store: prefix + "_STORE",
    site: prefix + "_SITE",
    host: "shop.shcu.example.test",
    hosted: prefix + "_HOSTED",
    book: prefix + "_BOOK",
    ebook: prefix + "_EBOOK",
    buyer: prefix + "_BUYER",
    unverified: prefix + "_UNVERIFIED",
    staffParty: prefix + "_SUPPLIER"
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
// an operation as an account (null: a visitor): {result} or {error}
function op(username, service, input) {
    if (username) login(username)
    else logout()
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
// a guest buys a product as email; {orderId, orderToken}
function buy(productId, email, optIns) {
    const token = op(null, CART + "add#CartItem", {productId, quantity: "1"}).result.token
    op(null, CHECKOUT + "begin#Checkout", {token})
    op(null, CHECKOUT + "set#CheckoutContact", {token, emailAddress: email, name: "Gail Guest"})
    op(null, CHECKOUT + "select#Payment", {token, paymentOptionId: "PiCreditCard"})
    const view = op(null, CHECKOUT + "get#Checkout", {token}).result
    const submitted = op(
        null,
        CHECKOUT + "submit#Checkout",
        Object.assign({token, expectedRevision: view.checkout.revision}, optIns ? {optIns} : {})
    ).result
    const row = one("mantle.order.StoreCheckout", {returnReference: submitted.checkout.reference})
    system(() => call("update#mantle.account.payment.PortalPaymentAttempt", {paymentId: row.paymentId, lastCheckDate: null}))
    op(null, CHECKOUT + "get#CheckoutPaymentResult", {reference: submitted.checkout.reference, key: submitted.returnKey})
    const confirmation = op(null, CHECKOUT + "get#OrderConfirmation", {token}).result
    assert(ec.factory.waitWorkerPoolEmpty(50), "Worker pool did not drain")
    return {orderId: row.orderId, orderToken: confirmation.orderToken, partyId: row.customerPartyId}
}
function account(partyId, email, verified) {
    make("mantle.party.Party", {partyId, partyTypeEnumId: "PtyPerson"})
    make("mantle.party.Person", {partyId, firstName: "Account", lastName: partyId})
    make("mantle.party.PartyRole", {partyId, roleTypeId: "Customer"})
    make("moqui.security.UserAccount", {
        userId: partyId,
        username: partyId,
        partyId,
        emailAddress: email,
        currentPassword: "16ac58bbfa332c1c55bd98b53e60720bfa90d394",
        passwordHashType: "SHA",
        timeZone: "UTC"
    })
    if (verified)
        make("moqui.security.public.VerifiedAddress", {userId: partyId, emailAddress: email, verifiedAt: ec.user.nowTimestamp})
}
const state = {}

spec({
    setupSpec() {
        system(() => {
            make("mantle.party.Party", {partyId: ids.org, partyTypeEnumId: "PtyOrganization"})
            make("mantle.party.Organization", {partyId: ids.org, organizationName: "Customer account organization"})
            make("mantle.party.PartyRole", {partyId: ids.org, roleTypeId: "OrgInternal"})
            make(S + "ProductStore", {
                productStoreId: ids.store,
                storeName: "Customer account store",
                organizationPartyId: ids.org,
                defaultCurrencyUomId: "USD",
                defaultLocale: "en_US",
                requireInventory: "N",
                defaultDisableShippingCalc: "Y"
            })
            for (const [settingTypeEnumId, settingValue] of [
                ["PsstCheckoutTerms", "false"],
                ["PsstOrdApproveNewCust", "false"],
                ["PsstOrdApproveAddrMissing", "false"]
            ])
                make(S + "ProductStoreSetting", {productStoreId: ids.store, settingTypeEnumId, fromDate: 0, settingValue})
            make("mantle.public.PublicSite", {
                siteId: ids.site,
                name: "Customer account site",
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
            make("mantle.public.PublicSiteApp", {
                siteId: ids.site,
                appMountId: "billing",
                app: "billing",
                pathPrefix: "/billing",
                enabled: "Y",
                targetId: ids.org
            })
            const T = "mantle.account.PaymentTestServices."
            make("mantle.account.method.PaymentGatewayConfig", {
                paymentGatewayConfigId: ids.hosted,
                paymentGatewayTypeEnumId: "PgtTest",
                description: "Customer account hosted test gateway",
                authorizeServiceName: T + "hostedPending#PaymentAuthorization",
                captureServiceName: T + "alwaysApprove#PaymentCapture",
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
            for (const [productId, type] of [
                [ids.book, "PtAsset"],
                [ids.ebook, "PtDigital"]
            ]) {
                make("mantle.product.Product", {
                    productId,
                    productName: "Account " + productId,
                    productTypeEnumId: type,
                    ownerPartyId: ids.org
                })
                make("mantle.product.ProductPrice", {
                    productId,
                    pricePurposeEnumId: "PppPurchase",
                    priceTypeEnumId: "PptCurrent",
                    fromDate: 0,
                    minQuantity: 1,
                    price: "10.00",
                    priceUomId: "USD"
                })
                make(S + "ProductStoreProduct", {
                    productStoreId: ids.store,
                    productId,
                    fromDate: 0,
                    publicationKindEnumId: "PspkPublished"
                })
            }
            account(ids.buyer, "buyer@shcu.example.test", true)
            account(ids.unverified, "other@shcu.example.test", false)
        })
        // the buyer's guest purchase of a digital item (invoiced at once), with review requests checked (pending for a guest),
        // and someone else's
        state.mine = buy(ids.ebook, "buyer@shcu.example.test", "reviewRequests")
        state.other = buy(ids.ebook, "other@shcu.example.test")
        // a guest purchase of the buyer's email that staff merged into another of the organization's parties (a supplier
        // contact sharing the address): never claimed by the email
        state.staffMerged = buy(ids.ebook, "buyer@shcu.example.test")
        system(() => {
            make("mantle.party.Party", {partyId: ids.staffParty, partyTypeEnumId: "PtyPerson"})
            make("mantle.party.Person", {partyId: ids.staffParty, firstName: "Sam", lastName: "Supplier"})
            make("mantle.party.PartyRole", {partyId: ids.staffParty, roleTypeId: "Supplier"})
            call("mantle.party.DuplicateServices.merge#Parties", {
                toPartyId: ids.staffParty,
                fromPartyId: state.staffMerged.partyId
            })
        })
    },
    cleanupSpec() {
        login("john.doe")
    }
})

feature("a guest's link and a verified account read their own orders; another order is refused alike; unverified sees none", {
    when() {
        const byLink = op(null, A + "get#Order", {orderToken: state.mine.orderToken, orderId: state.mine.orderId})
        const linkOther = op(null, A + "get#Order", {orderToken: state.mine.orderToken, orderId: state.other.orderId})
        const linkList = op(null, A + "find#Orders", {orderToken: state.mine.orderToken})
        const unverified = op(ids.unverified, A + "get#Account", {})
        const unverifiedOrder = op(ids.unverified, A + "get#Order", {orderId: state.other.orderId})
        const reviewRequests = () =>
            system(
                () =>
                    call("mantle.public.AccountHubServices.check#ReviewRequestConsent", {
                        partyId: ids.buyer,
                        productStoreId: ids.store
                    }).consented
            )
        const optInBefore = one("mantle.order.StoreCheckout", {orderId: state.mine.orderId}).optInPending
        // the verified account claims the guest purchase of its email, and only that
        const overview = op(ids.buyer, A + "get#Account", {})
        const own = op(ids.buyer, A + "get#Order", {orderId: state.mine.orderId})
        const others = op(ids.buyer, A + "get#Order", {orderId: state.other.orderId})
        const invoices = op(ids.buyer, "mantle.account.PortalServices.find#Invoices", {})
        const optInAfter = one("mantle.order.StoreCheckout", {orderId: state.mine.orderId})
        const claimedConsent = reviewRequests()
        const claimedPending = list("mantle.marketing.contact.ContactListParty", {partyId: ids.buyer, statusId: "CLPT_PENDING"})
        // a choice the account checked itself while signed in (the same checkout marked so) is confirmed by its verified
        // sign-in
        system(() => call("update#mantle.order.StoreCheckout", {checkoutId: optInAfter.checkoutId, accountCheckout: "Y"}))
        op(ids.buyer, A + "get#Account", {})
        const ownConfirmed = one("mantle.order.StoreCheckout", {orderId: state.mine.orderId})
        const ownConsent = reviewRequests()
        system(() => call("update#mantle.order.StoreCheckout", {checkoutId: optInAfter.checkoutId, accountCheckout: "N"}))
        return {
            byLink,
            linkOther,
            linkList,
            unverified,
            unverifiedOrder,
            overview,
            own,
            others,
            invoices,
            optInBefore,
            optInAfter,
            claimedConsent,
            claimedPending,
            ownConfirmed,
            ownConsent
        }
    },
    then(r) {
        r.byLink.result.order.orderId == state.mine.orderId
        r.byLink.result.order.lines.length == 1
        r.linkOther.error.includes("NOT_AVAILABLE")
        r.linkList.result.orders.length == 1
        r.unverified.result.account.verified == false
        r.unverifiedOrder.error.includes("ACCESS_DENIED")
        r.overview.result.account.claimed == 1
        r.overview.result.account.orderCount == 1
        r.overview.result.account.recentOrders[0].orderId == state.mine.orderId
        r.own.result.order.documents.length == 1
        r.others.error.includes("NOT_AVAILABLE")
        // the order's invoice is the account's own in Billing (the self relationship)
        r.invoices.result.invoiceList.length == 1
        one("mantle.party.Party", {partyId: state.mine.partyId}).mergedToPartyId == ids.buyer
        !one("mantle.party.Party", {partyId: ids.staffParty}).mergedToPartyId
        // the guest's review requests opt-in, pending, moves to the account with the claim and still waits: whoever checked
        // it was not signed in, so the sign-in does not confirm it (P9 follow-up review R1)
        r.optInBefore == "Y"
        r.optInAfter.optInPending == "Y"
        r.claimedConsent == false
        r.claimedPending.length == 1
        // the account's own choice is confirmed by its verified sign-in
        r.ownConfirmed.optInPending == "N"
        JSON.parse(r.ownConfirmed.optInsJson).outcome.reviewRequests == "granted"
        r.ownConsent == true
    }
})

feature("reorder rebuilds the lines in a cart at today's price; addresses are the account's own", {
    when() {
        const price = list("mantle.product.ProductPrice", {productId: ids.ebook})[0]
        system(() => call("update#mantle.product.ProductPrice", {productPriceId: price.productPriceId, price: "12.00"}))
        const preview = op(ids.buyer, A + "preview#Reorder", {orderId: state.mine.orderId})
        const reordered = op(ids.buyer, A + "reorder#Order", {orderId: state.mine.orderId, operationId: "shcu-reorder-0001"})
        const again = op(ids.buyer, A + "reorder#Order", {orderId: state.mine.orderId, operationId: "shcu-reorder-0001"})
        const notOwn = op(ids.unverified, A + "preview#Reorder", {orderId: state.mine.orderId})
        system(() => call("update#mantle.product.ProductPrice", {productPriceId: price.productPriceId, price: "10.00"}))
        const stored = op(ids.buyer, A + "store#Address", {
            address1: "2 Account Lane",
            city: "Springfield",
            postalCode: "62701",
            countryGeoId: "USA"
        })
        const contactMechId = stored.result?.contactMechId
        const otherEdit = op(ids.unverified, A + "end#Address", {contactMechId})
        const changed = op(ids.buyer, A + "store#Address", {
            contactMechId,
            expectedRevision: stored.result?.addresses.find(row => row.contactMechId === contactMechId)?.revision,
            address1: "3 Account Lane",
            city: "Springfield",
            postalCode: "62701",
            countryGeoId: "USA"
        })
        const stale = op(ids.buyer, A + "store#Address", {
            contactMechId: changed.result?.contactMechId,
            expectedRevision: "1",
            address1: "4 Lane",
            city: "X",
            postalCode: "1"
        })
        const ended = op(ids.buyer, A + "end#Address", {contactMechId: changed.result?.contactMechId})
        return {preview, reordered, again, notOwn, stored, otherEdit, changed, stale, ended}
    },
    then(r) {
        r.preview.result.lines[0].available == true
        r.preview.result.lines[0].changed == true
        r.preview.result.lines[0].unitPrice.amount == "12.00"
        r.reordered.result.cart.items[0].unitPrice.amount == "12.00"
        r.reordered.result.token != null
        r.again.result.alreadyApplied == true
        !r.again.result.token
        r.notOwn.error != null
        r.stored.result.addresses.length == 1
        r.otherEdit.error != null
        r.changed.result.addresses.some(row => row.address1 == "3 Account Lane")
        r.stale.error.includes("STALE_REVISION")
        r.ended.result.addresses.length == 0
    }
})

feature("a card is added through the gateway's hosted setup once; ending one names the recurring order it pays", {
    when() {
        const begun = op(ids.buyer, A + "begin#PaymentMethodSetup", {})
        const finished = op(ids.buyer, A + "finish#PaymentMethodSetup", {setupReference: begun.result?.setupReference})
        const again = op(ids.buyer, A + "finish#PaymentMethodSetup", {setupReference: begun.result?.setupReference})
        const method = finished.result?.methods[0]
        // a recurring order charges the card
        system(() => {
            const order = call("mantle.order.OrderServices.create#Order", {
                vendorPartyId: ids.org,
                customerPartyId: ids.buyer,
                productStoreId: ids.store
            })
            call("update#mantle.order.OrderHeader", {
                orderId: order.orderId,
                recurCronExpression: "0 0 0 1 * ?",
                orderName: "Monthly guide"
            })
            call("mantle.order.OrderServices.add#OrderPartPayment", {
                orderId: order.orderId,
                orderPartSeqId: order.orderPartSeqId,
                paymentMethodId: method.paymentMethodId,
                paymentInstrumentEnumId: "PiCreditCard",
                amount: "10.00"
            })
        })
        const asked = op(ids.buyer, A + "end#PaymentMethod", {paymentMethodId: method?.paymentMethodId})
        const otherEnd = op(ids.unverified, A + "end#PaymentMethod", {paymentMethodId: method?.paymentMethodId, confirm: "true"})
        const ended = op(ids.buyer, A + "end#PaymentMethod", {paymentMethodId: method?.paymentMethodId, confirm: "true"})
        return {begun, finished, again, method, asked, otherEnd, ended}
    },
    then(r) {
        r.begun.result.redirectUrl.startsWith("https://" + ids.host + "/shop/PaymentMethods/return?setup=")
        r.finished.result.added == 1
        r.again.result.added == 0
        r.method.last4 == "1111"
        r.asked.result.ended == false
        r.asked.result.needsConfirmation == true
        r.asked.result.contracts[0].name == "Monthly guide"
        r.otherEnd.error != null
        r.ended.result.ended == true
        r.ended.result.methods.every(row => row.ending)
    }
})

// The PASS Account foundation's email preferences (F6, X15): a store's cart reminders, which cart recovery requires
feature("a signed-in customer turns a store's cart reminders on and off; a guest never has them; a list link goes to the site", {
    when() {
        const H = "mantle.public.AccountHubServices."
        const before = op(ids.buyer, H + "get#EmailPreferences", {})
        const topicId = before.result?.topics[0]?.topicId
        const turnedOn = op(ids.buyer, H + "store#EmailPreferences", {choices: JSON.stringify({topics: {[topicId]: true}})})
        // an account whose email is not verified cannot turn them on
        const unverifiedOn = op(ids.unverified, H + "store#EmailPreferences", {choices: {topics: {[topicId]: true}}})
        const consented = system(
            () => call(H + "check#CartReminderConsent", {partyId: ids.buyer, productStoreId: ids.store}).consented
        )
        const turnedOff = op(ids.buyer, H + "store#EmailPreferences", {choices: {topics: {[topicId]: false}}})
        const guest = system(
            () => call(H + "check#CartReminderConsent", {partyId: state.other.partyId, productStoreId: ids.store}).consented
        )
        const visitor = op(null, H + "get#EmailPreferences", {})
        // checkout offers cart reminders to a signed-in buyer whose email is verified only (P9 follow-up review R2)
        const offered = username => {
            const token = op(username, CART + "add#CartItem", {productId: ids.ebook, quantity: "1"}).result?.token
            op(username, CHECKOUT + "begin#Checkout", {token})
            const view = op(username, CHECKOUT + "get#Checkout", {token})
            return view.error || (view.result.checkout.optIns || []).map(optIn => optIn.optInId).join(",")
        }
        const verifiedOffer = offered(ids.buyer)
        const unverifiedOffer = offered(ids.unverified)
        // a list link of a party who belongs to a site with Account mounted goes to that site's page
        const link = system(() => {
            make("mantle.public.PublicSiteApp", {
                siteId: ids.site,
                appMountId: "account",
                app: "account",
                pathPrefix: "/account",
                enabled: "Y"
            })
            make("mantle.public.PublicSiteParty", {siteId: ids.site, partyId: ids.buyer, state: "active"})
            const contactListId = call("create#mantle.marketing.contact.ContactList", {
                contactListName: "Account news",
                ownerPartyId: ids.org
            }).contactListId
            call("create#mantle.marketing.contact.ContactListParty", {
                contactListId,
                partyId: ids.buyer,
                fromDate: ec.user.nowTimestamp,
                statusId: "CLPT_ACCEPTED"
            })
            return call("mantle.party.ConsentServices.create#UnsubscribeToken", {contactListId, partyId: ids.buyer})
        })
        return {before, turnedOn, unverifiedOn, consented, turnedOff, guest, visitor, verifiedOffer, unverifiedOffer, link}
    },
    then({before, turnedOn, unverifiedOn, consented, turnedOff, guest, visitor, verifiedOffer, unverifiedOffer, link}) {
        // cart reminders, then the store's review requests (Commerce P9 follow-up), on from the first feature's confirmed
        // checkout opt-in
        before.result.topics.length == 2
        before.result.topics[1].topicId == "reviewRequests:" + ids.store
        before.result.topics[1].name == "Review requests from Customer account store"
        before.result.topics[1].on == true
        unverifiedOn.error.includes("VERIFY_REQUIRED")
        before.result.topics[0].on == false
        turnedOn.result.topics[0].on == true
        consented == true
        turnedOff.result.topics[0].on == false
        guest == false
        visitor.error.includes("SIGN_IN_REQUIRED")
        verifiedOffer == "reviewRequests,cartReminders"
        unverifiedOffer == "reviewRequests"
        link.unsubscribeUrl.startsWith("https://" + ids.host + "/account/EmailPreferences?token=")
        link.oneClickUrl.includes("/account/EmailPreferences/oneClick?token=")
    }
})
