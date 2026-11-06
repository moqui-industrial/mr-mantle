/* CC0 1.0 Universal plus Grant of Patent License. See LICENSE.md.
 * Shop's prepaid and recurring access (mr-pass impl-shop P7; design-shop §10 Subscriptions, SubscriptionDetail, §10.1,
 * §10.2; SHOP-SUBSCRIPTION, CX-RECURRING, review X5): a store's offers (StoreRecurringOffer), a verified customer's
 * contracts (StoreRecurringContract) and one renewal occurrence per contract and period (StoreRenewalOccurrence), over
 * Mantle's own orders, payments, invoices and Subscription rows.
 *
 * - Buying: begin#SubscriptionPurchase puts the offer's product in the verified account's cart and marks its checkout with
 *   the offer; the checkout (ShopCheckout.js) then needs the buyer's recorded off-session consent for an automatic offer and
 *   keeps the card. The first term is an ordinary order; at its settled fulfillment (ShopFulfillment.js) the contract is
 *   made, its first Subscription activated on the contract's own resource instance, and for an automatic offer the recurring
 *   base cloned from it (RecurringTemplate, copyPayment=false), which never reserves, invoices, emails or counts.
 * - Renewing: create_RecurringOrders hands each Shop base to dispatch#Renewal, and run#Renewals advances occurrences in
 *   flight. The coordinator claims the contract's due period under the contract's lock (unique by contract and period, so
 *   concurrent jobs and retries answer the same occurrence), clones the base with copyPayment=false, and charges only when
 *   the contract records the customer's off-session consent for its method: a renewal payment and its attempt (Accounting's
 *   coordinator, purpose shopRenewal), authorize#SinglePayment with the attempt's operation key and the stored-credential
 *   indicators, in a transaction holding only the payment; then place#Order once. Without consent there is no charge: the
 *   occurrence waits for the customer (ResolveRenewal). A decline is retried at the offer's days (1, 3 and 7 by default),
 *   one notice per attempt; an unknown outcome is looked up, never charged again under a new key. Access is extended only
 *   by the renewal's settled fulfillment, from the paid boundary when continuous, else from the payment.
 * - Cancelling stops future renewals and keeps the paid term; a renewal in flight must settle first. A refund revokes only
 *   the term it paid for (reconcile#RefundedItem). A merge carries the contract but never its consent.
 * Reads and writes are the authority's own (authorization disabled), after these checks.
 */
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const externalAccess = () => ec.resource.script("component://mr-mantle/service/mantle/party/ExternalAccess.js")
const catalog = () => ec.resource.script("component://mr-mantle/service/mantle/product/ShopCatalog.js")
const carts = () => ec.resource.script("component://mr-mantle/service/mantle/order/ShopCart.js")
const checkouts = () => ec.resource.script("component://mr-mantle/service/mantle/order/ShopCheckout.js")
const attempts = () => ec.resource.script("component://mr-mantle/service/mantle/account/PaymentAttempts.js")
const settings = () => ec.resource.script("component://mr-mantle/service/mantle/product/StoreCheckout.js")
const admin = () => ec.resource.script("component://mr-mantle/service/mantle/product/StoreAdmin.js")
const publicApps = () => ec.resource.script("component://mr-mantle/service/mantle/public/PublicApps.js")
const {find, one, rows, call, ms} = lib
const SUB = "mantle.product.subscription."
const OFFER = SUB + "StoreRecurringOffer"
const CONTRACT = SUB + "StoreRecurringContract"
const OCC = SUB + "StoreRenewalOccurrence"
const SUBSCRIPTION = SUB + "Subscription"
const C = "mantle.order.StoreCheckout"
const P = "mantle.account.payment.Payment"
const ORDER = "mantle.order.OrderHeader"
const SERVICES = "mantle.product.ShopSubscriptionServices."

// ===== tables =====
// Bounds: the default retry days after a failed renewal charge, contracts and history rows a page shows, occurrences a job
// run takes, how often a page may look a pending renewal payment up.
const limits = {retryDays: [1, 3, 7], contracts: 100, history: 36, batch: 100, lookupEveryMs: 60000, steps: 8}
const renewableStates = ["ScsActive", "ScsPastDue"]
const doneStates = ["SrsActivated", "SrsFailed", "SrsCancelled"]
const retryStates = ["SrsRetry", "SrsActionRequired"]
const unitNames = {
    TF_day: ["day", "days"],
    TF_wk: ["week", "weeks"],
    TF_mon: ["month", "months"],
    TF_yr: ["year", "years"],
    TF_hr: ["hour", "hours"]
}
const stateTexts = {
    ScsActive: "Renews automatically",
    ScsPastDue: "Renewal payment due",
    ScsCancelled: "Renewal cancelled",
    ScsEnded: "Ended",
    ScsPrepaid: "Prepaid"
}

// ===== values =====
const text = value => (value == null ? "" : String(value).trim())
const nowMs = () => ms(ec.user.nowTimestamp)
const dec = value => toDecimal(value == null || value === "" ? 0 : value)
const yes = value => value === true || value === "true" || value === "Y" || value === "on"
function refuse(kind, code, message, field) {
    const error = new Error(code + ": " + message)
    error.moquiErrorKind = kind
    if (field) error.moquiField = field
    throw error
}
const notAvailable = () => refuse("NotFound", "NOT_AVAILABLE", "This subscription is not available")
const invalid = (field, message) => refuse("Unprocessable", "VALUE_INVALID", message, field)
const money = (amount, currencyUomId) => catalog().money(amount, currencyUomId)
const firstLine = value =>
    String(value || "")
        .split("\n")[0]
        .replace(/^(?:Error: )+/, "")
        .slice(0, 255)
const enumText = enumId => (enumId ? one("moqui.basic.Enumeration", {enumId})?.description || enumId : "")
const productName = productId => one("mantle.product.Product", {productId})?.productName || productId
// A step in a transaction of its own: {result} or {error}.
function step(name, input) {
    ec.message.pushErrors()
    try {
        const out =
            ec.service
                .sync()
                .name(SERVICES + "run#RenewalStep")
                .parameters({input: Object.assign({step: name}, input)})
                .disableAuthz()
                .requireNewTransaction(true)
                .call() || {}
        if (ec.message.hasError()) return {error: ec.message.getErrorsString()}
        return {result: out.result || {}}
    } catch (error) {
        return {error: String(error.message || error)}
    } finally {
        ec.message.clearErrors()
        ec.message.popErrors()
    }
}

// ===== terms and offers =====
// The product's term (its ProductSubscriptionResource in effect): the resource, the length and unit a purchase grants.
function termOf(productId, subscriptionResourceId) {
    const found = rows(SUB + "ProductSubscriptionResource", {productId})
        .filter(row => lib.active(row) && (!subscriptionResourceId || row.subscriptionResourceId === subscriptionResourceId))
        .sort((a, b) => (ms(b.fromDate) ?? 0) - (ms(a.fromDate) ?? 0))
    return found[0] || null
}
function termText(term) {
    if (!term) return ""
    const count = Number(term.availableTime || 1)
    const names = unitNames[term.availableTimeUomId || "TF_mon"] || [term.availableTimeUomId, term.availableTimeUomId]
    return count === 1 ? names[0] : count + " " + names[1]
}
const currentOffers = productStoreId =>
    rows(OFFER, {productStoreId})
        .filter(row => lib.active(row))
        .sort((a, b) => String(a.offerId).localeCompare(String(b.offerId)))
function offerView(offer) {
    const term = termOf(offer.productId, offer.subscriptionResourceId)
    return {
        offerId: offer.offerId,
        name: offer.offerName || productName(offer.productId),
        productName: productName(offer.productId),
        price: money(offer.priceAmount, offer.currencyUomId),
        termText: termText(term),
        autoRenew: offer.autoRenew === "Y",
        termsVersion: offer.termsVersion || ""
    }
}
const retryDaysOf = offer => {
    const days = text(offer?.retryDays)
        .split(",")
        .map(value => Number(value.trim()))
        .filter(value => Number.isInteger(value) && value > 0)
    return days.length ? days : limits.retryDays
}
// What a store's gateways allow (StoreCheckout.js gatewayCapabilities): the configs whose capabilities include offSession.
function offSessionGateways(productStoreId) {
    const out = []
    for (const row of rows("mantle.product.store.ProductStorePaymentGateway", {productStoreId})) {
        const config = one("mantle.account.method.PaymentGatewayConfig", {paymentGatewayConfigId: row.paymentGatewayConfigId})
        const of = config ? settings().gatewayCapabilities[config.paymentGatewayTypeEnumId] : null
        if (of && of(config).offSession) out.push(config.paymentGatewayConfigId)
    }
    return out
}
function gatewayOffSession(paymentGatewayConfigId) {
    const config = paymentGatewayConfigId ? one("mantle.account.method.PaymentGatewayConfig", {paymentGatewayConfigId}) : null
    const of = config ? settings().gatewayCapabilities[config.paymentGatewayTypeEnumId] : null
    return !!(of && of(config).offSession)
}

// store#RecurringOffer (COMMERCE_STORE_EDIT, the store's scope; Commerce P12 builds its RecurringPolicy editor): a new
// offer, a changed one (the old row ended and a new one started, so contracts keep what they accepted), or one ended. An
// automatic offer needs a store gateway with off-session charges (OFF_SESSION_UNAVAILABLE). Then each Shop site of the store
// gets its subscription address (subscriptionAddresses). {offerId}.
function storeRecurringOffer(p) {
    const s = admin().scope("edit")
    const store = admin().storeOf(s, text(p.productStoreId))
    let current = null
    if (text(p.offerId)) {
        current = find(OFFER, {offerId: text(p.offerId)})
            .forUpdate(true)
            .one()
        if (!current || current.productStoreId !== store.productStoreId) notAvailable()
        if (p.expectedRevision != null && text(p.expectedRevision) !== String(current.revision || 1))
            refuse("Conflict", "STALE_REVISION", "The offer changed. Reload it and try again")
    }
    const end = () => {
        if (current && lib.active(current)) call("update#" + OFFER, {offerId: current.offerId, thruDate: ec.user.nowTimestamp})
    }
    if (yes(p.ended)) {
        if (!current) notAvailable()
        end()
        subscriptionAddresses(store.productStoreId)
        return {offerId: current.offerId}
    }
    const productId = text(p.productId) || current?.productId
    const term = productId ? termOf(productId, text(p.subscriptionResourceId) || current?.subscriptionResourceId) : null
    if (!term) invalid("productId", "Choose a product that grants paid access")
    const priceAmount = dec(p.priceAmount ?? current?.priceAmount)
    if (priceAmount.compare(0) <= 0) invalid("priceAmount", "Give the offer's price")
    const autoRenew = p.autoRenew == null ? current?.autoRenew || "Y" : yes(p.autoRenew) ? "Y" : "N"
    if (autoRenew === "Y" && !offSessionGateways(store.productStoreId).length)
        refuse(
            "Unprocessable",
            "OFF_SESSION_UNAVAILABLE",
            "The store's payment gateway cannot charge a kept card for renewals; offer a prepaid term instead"
        )
    const retryDays = text(p.retryDays ?? current?.retryDays) || limits.retryDays.join(",")
    const days = retryDays.split(",").map(value => Number(value.trim()))
    if (days.some(day => !Number.isInteger(day) || day < 1 || day > 60) || days.some((day, i) => i > 0 && day <= days[i - 1]))
        invalid("retryDays", "Retry days are whole days in order, such as 1,3,7")
    end()
    const created = call("create#" + OFFER, {
        productStoreId: store.productStoreId,
        productId,
        subscriptionResourceId: term.subscriptionResourceId,
        offerName: text(p.offerName ?? current?.offerName) || null,
        priceAmount,
        currencyUomId: text(p.currencyUomId) || current?.currencyUomId || store.defaultCurrencyUomId,
        autoRenew,
        termsVersion: text(p.termsVersion ?? current?.termsVersion) || "1",
        retryDays,
        fromDate: p.fromDate || ec.user.nowTimestamp,
        thruDate: p.thruDate || null,
        revision: current ? Number(current.revision || 1) + 1 : 1,
        changedByUserId: ec.user.userId,
        createdDate: ec.user.nowTimestamp
    })
    subscriptionAddresses(store.productStoreId)
    return {offerId: created.offerId}
}
// PublicSite.subscriptionUrl of each site with an enabled Shop mount of the store (design-shop §4.3): Shop's Subscriptions
// page while the store has a current offer, cleared when none remains; an outside address a site owner entered is never
// replaced or cleared.
function subscriptionAddresses(productStoreId) {
    const offered = currentOffers(productStoreId).length > 0
    for (const mount of admin().shopMounts([productStoreId])[productStoreId] || []) {
        if (mount.enabled !== "Y") continue
        try {
            const site = one("mantle.public.PublicSite", {siteId: mount.siteId})
            const ours = publicApps().pageUrl(mount.siteId, "shop", "/Subscriptions")
            if (!site || !ours) continue
            const kept = text(site.subscriptionUrl)
            if (kept && !shopAddress(mount, kept)) continue
            const wanted = offered ? ours : null
            if ((kept || null) !== wanted) call("update#mantle.public.PublicSite", {siteId: site.siteId, subscriptionUrl: wanted})
        } catch (error) {
            ec.message.clearErrors()
            ec.logger.error("Subscription address of site " + mount.siteId + " not kept: " + firstLine(error.message))
        }
    }
}
// Whether an address is the Shop mount's own Subscriptions page (absolute on a host of the site, or the mount's path).
function shopAddress(mount, address) {
    const base = mount.pathPrefix === "/" ? "" : mount.pathPrefix
    const path = base + "/Subscriptions"
    if (address === path) return true
    const match = /^https:\/\/([^/]+)(\/.*)$/.exec(address)
    return !!match && match[2] === path && !!one("mantle.public.PublicSiteHost", {hostname: match[1], siteId: mount.siteId})
}
// The readiness of a store that offers subscriptions (StoreAdmin.js's subscriptions check): an automatic offer needs a gateway
// with off-session charges, and each Shop site's subscription address should be Shop's page (an outside one is named). No
// offer: no finding.
function readiness(store) {
    const offers = currentOffers(store.productStoreId)
    if (!offers.length) return null
    const problems = []
    if (offers.some(offer => offer.autoRenew === "Y") && !offSessionGateways(store.productStoreId).length)
        problems.push("no payment gateway charges a kept card for renewals")
    for (const mount of admin().shopMounts([store.productStoreId])[store.productStoreId] || []) {
        if (mount.enabled !== "Y") continue
        const site = one("mantle.public.PublicSite", {siteId: mount.siteId})
        const kept = text(site?.subscriptionUrl)
        if (!kept) problems.push(mount.siteId + " has no subscription address")
        else if (!shopAddress(mount, kept)) problems.push(mount.siteId + "'s subscription address is outside Shop")
    }
    return problems.length
        ? {ready: false, message: "Subscriptions: " + problems.join("; ")}
        : {ready: true, message: "Subscriptions renew and are managed in Shop"}
}

// ===== who =====
// A signed-in verified account in the site's store (the self relationship): subscriptions need a stable owner.
function reach(p) {
    const shop = catalog().shopOf(p)
    const partyId = ec.user.userAccount?.partyId || null
    if (!partyId || !externalAccess().selfOf(partyId))
        refuse("AuthenticationRequired", "SIGN_IN_REQUIRED", "Sign in with a verified email address to manage subscriptions")
    return {shop, partyId}
}
function contractReached(reached, contractId, forUpdate = false) {
    const row = text(contractId)
        ? find(CONTRACT, {contractId: text(contractId)})
              .forUpdate(forUpdate)
              .one()
        : null
    if (!row || row.productStoreId !== reached.shop.productStoreId || row.customerPartyId !== reached.partyId) notAvailable()
    return row
}
function checkRevision(contract, expected) {
    if (expected == null || text(expected) === "")
        refuse("Unprocessable", "VALUE_INVALID", "Reload the subscription and try again", "expectedRevision")
    if (text(expected) !== String(contract.revision || 1))
        refuse("Conflict", "STALE_REVISION", "The subscription changed. Review it and try again")
}

// ===== the views =====
const subscriptionsOf = contractId =>
    rows(SUBSCRIPTION, {resourceInstanceId: contractId}).sort((a, b) => (ms(a.fromDate) ?? 0) - (ms(b.fromDate) ?? 0))
const accessActive = sub =>
    !sub.accessRevokedDate && (ms(sub.fromDate) ?? 0) <= nowMs() && (ms(sub.thruDate) ?? Infinity) > nowMs()
// Billing and access apart (design-shop §10): a cancelled renewal still has access until the paid term ends.
function summary(contract) {
    const subs = subscriptionsOf(contract.contractId)
    const accessUntil = subs
        .filter(sub => !sub.accessRevokedDate)
        .reduce((latest, sub) => Math.max(latest, ms(sub.thruDate) ?? 0), 0)
    const hasAccess = subs.some(accessActive)
    const waiting = rows(OCC, {contractId: contract.contractId}).find(row => reopenable(contract, row))
    const offer = contract.offerId ? one(OFFER, {offerId: contract.offerId}) : null
    const term = termOf(contract.productId, contract.subscriptionResourceId)
    const renews = contract.autoRenew === "Y" && renewableStates.includes(contract.stateEnumId)
    return {
        contractId: contract.contractId,
        revision: String(contract.revision || 1),
        name: offer?.offerName || productName(contract.productId),
        productName: productName(contract.productId),
        price: money(contract.priceAmount ?? 0, contract.currencyUomId),
        termText: termText(term),
        autoRenew: contract.autoRenew === "Y",
        billingState: contract.stateEnumId,
        billingText: stateTexts[contract.stateEnumId] || enumText(contract.stateEnumId),
        accessText: hasAccess
            ? "Access until " + lib.dateText(accessUntil)
            : accessUntil > nowMs()
              ? "Access from " + lib.dateText(subs.find(sub => !sub.accessRevokedDate && ms(sub.fromDate) > nowMs())?.fromDate)
              : "No access now",
        hasAccess,
        paidThroughText: lib.dateText(contract.paidThroughDate),
        nextRenewalText: renews ? lib.dateText(contract.nextRenewalDate) : "",
        nextAmount: renews ? money(contract.priceAmount ?? 0, contract.currencyUomId) : null,
        cancelAtText: contract.cancelAtDate ? lib.dateText(contract.cancelAtDate) : "",
        actionNeeded: !!waiting || (renews && !consentHolds(contract)),
        canCancel: renews,
        canRenewPrepaid: contract.autoRenew !== "Y" && !!renewOffer(contract)
    }
}
// get#Subscriptions (SubscriptionList): the account's contracts in this store, newest first, and the offers it can buy.
function getSubscriptions(p) {
    const reached = reach(p)
    const contracts = Array.from(
        find(CONTRACT, {customerPartyId: reached.partyId, productStoreId: reached.shop.productStoreId})
            .orderBy("-createdDate")
            .limit(limits.contracts)
            .list()
    )
    return {
        subscriptions: contracts.map(summary),
        offers: currentOffers(reached.shop.productStoreId).map(offerView)
    }
}
// The masked cards an account may renew with in this store: its own, kept at one of the store's off-session gateways.
function renewalMethods(partyId, productStoreId) {
    const gateways = offSessionGateways(productStoreId)
    if (!gateways.length) return []
    return Array.from(
        find("mantle.account.method.PaymentMethod", {ownerPartyId: partyId})
            .condition("thruDate", "is-null", null)
            .condition("paymentGatewayConfigId", "in", gateways)
            .condition("gatewayCimId", "is-not-null", null)
            .orderBy("-fromDate")
            .limit(20)
            .list()
    ).map(method => {
        const card = one("mantle.account.method.CreditCard", {paymentMethodId: method.paymentMethodId})
        return {
            paymentMethodId: method.paymentMethodId,
            brand: card?.creditCardTypeEnumId ? enumText(card.creditCardTypeEnumId) : "",
            last4: card?.cardNumber ? String(card.cardNumber).replace(/\D/g, "").slice(-4) : ""
        }
    })
}
// get#Subscription (Subscription, RenewalHistory, ChangeMethod, CancelRenewal, ResolveRenewal): the contract with its
// terms, method and history (its first order and each renewal: period, order, amount, state, next retry).
function getSubscription(p) {
    const reached = reach(p)
    const contract = contractReached(reached, p.contractId)
    const method = contract.paymentMethodId ? renewalMethods(reached.partyId, contract.productStoreId) : []
    const current = method.find(row => row.paymentMethodId === contract.paymentMethodId) || null
    const history = [
        {
            kind: "purchase",
            periodText: lib.dateText(subscriptionsOf(contract.contractId)[0]?.fromDate),
            orderId: contract.originOrderId,
            stateText: "Bought",
            amount: money(contract.priceAmount ?? 0, contract.currencyUomId)
        }
    ].concat(
        Array.from(find(OCC, {contractId: contract.contractId}).orderBy("-periodStartDate").limit(limits.history).list()).map(
            row => ({
                kind: "renewal",
                occurrenceId: row.occurrenceId,
                periodText: lib.dateText(row.periodStartDate),
                orderId: row.stateEnumId === "SrsActivated" || row.stateEnumId === "SrsPlaced" ? row.orderId : null,
                stateText: enumText(row.stateEnumId),
                amount: money(contract.priceAmount ?? 0, contract.currencyUomId),
                nextRetryText: row.stateEnumId === "SrsRetry" ? lib.dateText(row.nextRetryDate) : "",
                actionNeeded: reopenable(contract, row)
            })
        )
    )
    return {
        subscription: Object.assign(summary(contract), {
            termsVersion: contract.termsVersion || "",
            method: current,
            consentText: consentHolds(contract)
                ? "You agreed on " + lib.dateText(contract.consentDate) + " to renewal charges of this card"
                : "Choose a card and agree to renewal charges to keep renewing",
            methods: renewalMethods(reached.partyId, contract.productStoreId),
            history,
            renewOffer: contract.autoRenew !== "Y" && renewOffer(contract) ? offerView(renewOffer(contract)) : null
        })
    }
}

// ===== buying =====
// The current offer a prepaid contract renews by: its own offer while in effect, else the store's current prepaid offer of
// the same product.
function renewOffer(contract) {
    const own = contract.offerId ? one(OFFER, {offerId: contract.offerId}) : null
    if (own && lib.active(own) && own.autoRenew !== "Y") return own
    return (
        currentOffers(contract.productStoreId).find(row => row.productId === contract.productId && row.autoRenew !== "Y") || null
    )
}
// begin#SubscriptionPurchase (RenewPrepaid; ProductDetail's subscribe): the offer (or a prepaid contract's next term) in the
// verified account's cart, its checkout begun and marked with the offer; the page goes on to the checkout. Refused when the
// offer's price is no longer the catalog's (OFFER_CHANGED: never a silent substitution) or the product cannot be bought.
function beginSubscriptionPurchase(p) {
    const reached = reach(p)
    let offer
    let contract = null
    if (text(p.contractId)) {
        contract = contractReached(reached, p.contractId)
        offer = renewOffer(contract)
        if (!offer) refuse("Unprocessable", "OFFER_UNAVAILABLE", "This subscription cannot be renewed now")
    } else {
        offer = text(p.offerId) ? one(OFFER, {offerId: text(p.offerId)}) : null
        if (!offer || offer.productStoreId !== reached.shop.productStoreId || !lib.active(offer))
            refuse("NotFound", "OFFER_UNAVAILABLE", "This offer is not available")
    }
    const shop = Object.assign({}, reached.shop, {customerPartyId: reached.partyId})
    const priced = catalog().offersOf(shop, [{productId: offer.productId, quantity: 1}])[0]
    if (!priced?.available) refuse("Unprocessable", "ITEM_UNAVAILABLE", productName(offer.productId) + " cannot be bought now")
    if (!priced.unit.eq(dec(offer.priceAmount)))
        refuse("Conflict", "OFFER_CHANGED", "This offer's price changed. Reload the page to see the current offer")
    const cart = carts().cartOf(shop, null)
    const inCart = cart
        ? carts()
              .productLines(cart.row.orderId)
              .find(line => line.productId === offer.productId)
        : null
    if (!inCart) carts().execute("addCartItem", {siteId: shop.siteId, productId: offer.productId, quantity: "1"})
    checkouts().execute("beginCheckout", {siteId: shop.siteId})
    const row = checkoutOfAccount(shop)
    if (!row) notAvailable()
    call("update#" + C, {
        checkoutId: row.checkoutId,
        recurringOfferId: offer.offerId,
        renewContractId: contract ? contract.contractId : null,
        recurringConsentDate: null
    })
    return {offer: offerView(offer), checkoutReference: row.returnReference, next: "checkout"}
}
function checkoutOfAccount(shop) {
    const cart = carts().cartOf(shop, null)
    if (!cart) return null
    return Array.from(find(C, {cartAccessId: cart.row.cartAccessId}).orderBy("-createdDate").limit(1).list())[0] || null
}
// The checkout's subscription (CheckoutView's recurring; ShopCheckout.js view): the offer, its price and term, whether it
// renews and the consent it needs. Null for any other checkout.
function checkoutView(checkout) {
    if (!checkout?.recurringOfferId) return null
    const offer = one(OFFER, {offerId: checkout.recurringOfferId})
    if (!offer) return null
    const view = offerView(offer)
    return Object.assign(view, {
        consentRequired: view.autoRenew,
        consented: !!checkout.recurringConsentDate,
        statement: view.autoRenew
            ? "I agree that " +
              (one("mantle.product.store.ProductStore", {productStoreId: offer.productStoreId})?.storeName || "the store") +
              " charges the card I pay with now " +
              view.price.display +
              " every " +
              view.termText +
              " until I cancel. I can cancel any time in my account; access lasts to the end of the paid term."
            : "A prepaid term of " + view.termText + ". It does not renew on its own."
    })
}
// What a subscription checkout needs at submit (ShopCheckout.js submitCheckout): a signed-in verified account, and for an
// automatic offer the buyer's consent to the renewal charges.
function submitCheck(checkout, p) {
    if (!checkout?.recurringOfferId) return
    if (checkout.accountCheckout !== "Y" || !externalAccess().selfOf(checkout.customerPartyId))
        refuse("AuthenticationRequired", "SIGN_IN_REQUIRED", "Sign in with a verified email address to subscribe")
    const offer = one(OFFER, {offerId: checkout.recurringOfferId})
    if (offer?.autoRenew === "Y" && !yes(p.recurringConsent))
        invalid("recurringConsent", "Agree to the renewal charges to subscribe")
}
// At the freeze (ShopCheckout.js freeze, under the order's lock): the offer still in effect at the line's price, one of it,
// and a way to pay that keeps the card for off-session renewals; the consent recorded with what was shown. {changes,
// values} (a change asks for review; values go on the checkout).
function freezeValues(checkout, orderId) {
    if (!checkout?.recurringOfferId) return {changes: [], values: {}}
    const offer = one(OFFER, {offerId: checkout.recurringOfferId})
    const line = carts()
        .productLines(orderId)
        .find(row => row.productId === offer?.productId)
    const changes = []
    if (!offer || !lib.active(offer) || !line || !dec(line.unitAmount).eq(dec(offer.priceAmount)))
        changes.push({kind: "unavailable", name: offer ? offer.offerName || productName(offer.productId) : "Your subscription"})
    if (line && !dec(line.quantity ?? 1).eq(toDecimal(1))) invalid("quantity", "A subscription is bought one at a time")
    const values = {}
    if (offer?.autoRenew === "Y") {
        if (!gatewayOffSession(checkout.paymentGatewayConfigId))
            invalid("paymentOptionId", "This way to pay cannot renew a subscription; choose a card")
        const term = termOf(offer.productId, offer.subscriptionResourceId)
        Object.assign(values, {
            savePaymentMethod: "Y",
            recurringConsentDate: ec.user.nowTimestamp,
            recurringConsentTerms: offer.termsVersion || "1",
            recurringConsentEvidence: lib.hash({
                offerId: offer.offerId,
                price: dec(offer.priceAmount).toString(),
                currencyUomId: offer.currencyUomId,
                term: termText(term),
                termsVersion: offer.termsVersion || "1",
                visitId: ec.user.visitId || null,
                at: nowMs()
            })
        })
    }
    return {changes, values}
}

// ===== activation (from Shop's fulfillment) =====
// check#ShopAccessOrder (fulfill#OrderSubscriptions): whether an order's paid access is Shop's (a completed Shop checkout or
// a renewal occurrence's order), so Mantle's own subscription fulfillment leaves it to Shop's settled fulfillment.
function shopManaged(orderId) {
    if (!orderId) return false
    // a checkout being placed counts: the approval runs inside its placement, before the checkout is completed
    return (
        !!one(OCC, {orderId}) ||
        find(C, {orderId}).condition("statusId", "in", ["ScoPlacementPending", "ScoCompleted"]).count() > 0
    )
}
// The fulfillment source of a renewal order (ShopFulfillment.js sourceOf): the contract's store, site, customer and the
// occurrence's payment.
function renewalSourceOf(orderId) {
    const occurrence = orderId ? one(OCC, {orderId}) : null
    if (!occurrence) return null
    const contract = one(CONTRACT, {contractId: occurrence.contractId})
    return {
        productStoreId: contract.productStoreId,
        siteId: contract.siteId,
        customerPartyId: contract.customerPartyId,
        paymentId: occurrence.paymentId,
        contactEmail: emailOf(contract.customerPartyId),
        accountCheckout: "Y",
        occurrenceId: occurrence.occurrenceId
    }
}
// activate (ShopFulfillment.js complete step, the line settled): the line's term on its contract's resource instance, once.
// A renewal's line extends its contract from the paid boundary when continuous (fulfill#ProductSubscriptionResource starts
// at the instance's latest end, or now); a first purchase makes the contract (a prepaid one for a paid-access line bought
// without an offer) and, for an automatic offer, its recurring base. {subscriptionIds, contractId}.
function activate(p) {
    const item = one("mantle.order.OrderItem", {orderId: p.orderId, orderItemSeqId: p.orderItemSeqId})
    if (!item) throw new Error("Order line " + p.orderId + ":" + p.orderItemSeqId + " not found")
    const occurrence = one(OCC, {orderId: p.orderId})
    let contract = null
    if (occurrence) contract = find(CONTRACT, {contractId: occurrence.contractId}).forUpdate(true).one()
    else {
        const checkout = one(C, {orderId: p.orderId, statusId: "ScoCompleted"})
        if (!checkout) throw new Error("Order " + p.orderId + " is not a Shop order")
        // another prepaid term extends its contract for that contract's product only; any other paid-access line of the
        // checkout is a contract of its own (review R3)
        const renewing = checkout.renewContractId
            ? find(CONTRACT, {contractId: checkout.renewContractId}).forUpdate(true).one()
            : null
        contract =
            renewing && renewing.productId === item.productId && renewing.customerPartyId === checkout.customerPartyId
                ? renewing
                : contractOfLine(checkout, item)
    }
    const terms = rows(SUB + "ProductSubscriptionResource", {productId: item.productId}).filter(row => lib.active(row))
    if (!terms.length) throw new Error("Product " + item.productId + " grants no paid access")
    const subscriptionIds = []
    for (const term of terms) {
        const existing = rows(SUBSCRIPTION, {
            orderId: item.orderId,
            orderItemSeqId: item.orderItemSeqId,
            subscriptionResourceId: term.subscriptionResourceId
        })[0]
        subscriptionIds.push(
            existing
                ? existing.subscriptionId
                : call("mantle.product.SubscriptionServices.fulfill#ProductSubscriptionResource", {
                      orderId: item.orderId,
                      orderItemSeqId: item.orderItemSeqId,
                      productId: item.productId,
                      subscriptionResourceId: term.subscriptionResourceId,
                      psrFromDate: term.fromDate,
                      resourceInstanceId: contract.contractId
                  }).subscriptionId
        )
    }
    const paidThrough = subscriptionIds
        .map(subscriptionId => one(SUBSCRIPTION, {subscriptionId}))
        .reduce((latest, sub) => Math.max(latest, ms(sub?.thruDate) ?? 0), ms(contract.paidThroughDate) ?? 0)
    const cancelled = contract.stateEnumId === "ScsCancelled"
    const renews = contract.autoRenew === "Y" && !cancelled
    call("update#" + CONTRACT, {
        contractId: contract.contractId,
        paidThroughDate: new Date(paidThrough),
        nextRenewalDate: renews ? new Date(paidThrough) : null,
        cancelAtDate: cancelled ? new Date(paidThrough) : contract.cancelAtDate || null,
        stateEnumId: cancelled ? "ScsCancelled" : contract.autoRenew === "Y" ? "ScsActive" : "ScsPrepaid",
        revision: Number(contract.revision || 1) + 1
    })
    if (renews && !contract.baseOrderId) makeBase(one(CONTRACT, {contractId: contract.contractId}))
    if (occurrence)
        call("update#" + OCC, {
            occurrenceId: occurrence.occurrenceId,
            stateEnumId: "SrsActivated",
            subscriptionId: subscriptionIds[0] || null,
            activatedDate: ec.user.nowTimestamp,
            failureCode: null,
            failureMessage: null
        })
    return {subscriptionIds, contractId: contract.contractId, occurrenceId: occurrence?.occurrenceId || null}
}
// The contract a first purchase's line makes (once, by its origin line): the checkout's offer as accepted, with the
// consent and the card kept at the checkout; a paid-access line bought without an offer is a prepaid contract of its own.
function contractOfLine(checkout, item) {
    const existing = one(CONTRACT, {originOrderId: item.orderId, originOrderItemSeqId: item.orderItemSeqId})
    if (existing) return find(CONTRACT, {contractId: existing.contractId}).forUpdate(true).one()
    const offer = checkout.recurringOfferId ? one(OFFER, {offerId: checkout.recurringOfferId}) : null
    const forOffer = offer && offer.productId === item.productId ? offer : null
    const payment = checkout.paymentId ? one(P, {paymentId: checkout.paymentId}) : null
    const autoRenew = forOffer?.autoRenew === "Y" ? "Y" : "N"
    const consented = autoRenew === "Y" && !!checkout.recurringConsentDate && !!payment?.paymentMethodId
    const term = termOf(item.productId, forOffer?.subscriptionResourceId)
    const created = call("create#" + CONTRACT, {
        productStoreId: checkout.productStoreId,
        siteId: checkout.siteId,
        customerPartyId: checkout.customerPartyId,
        offerId: forOffer?.offerId || null,
        productId: item.productId,
        subscriptionResourceId: term?.subscriptionResourceId || null,
        priceAmount: forOffer ? forOffer.priceAmount : item.unitAmount,
        currencyUomId: forOffer?.currencyUomId || checkout.currencyUomId,
        autoRenew,
        termsVersion: forOffer?.termsVersion || null,
        stateEnumId: autoRenew === "Y" ? "ScsActive" : "ScsPrepaid",
        originOrderId: item.orderId,
        originOrderItemSeqId: item.orderItemSeqId,
        paymentMethodId: payment?.paymentMethodId || null,
        consentDate: consented ? checkout.recurringConsentDate : null,
        consentMethodId: consented ? payment.paymentMethodId : null,
        consentTermsVersion: consented ? checkout.recurringConsentTerms : null,
        consentEvidence: consented ? checkout.recurringConsentEvidence : null,
        consentPaymentId: consented ? payment.paymentId : null,
        consentEndedReason: autoRenew === "Y" && !consented ? "NO_KEPT_METHOD" : null,
        revision: 1,
        createdDate: ec.user.nowTimestamp
    })
    return find(CONTRACT, {contractId: created.contractId}).forUpdate(true).one()
}
// The recurring base of an automatic contract (X5): the first order cloned with copyPayment=false into OrderApproved, marked
// RecurringTemplate, holding only the contract's line at its accepted price with promotions off, scheduled nightly so
// create_RecurringOrders hands it to dispatch#Renewal (the contract's own date decides when a period is due). It never
// reserves, invoices, emails or counts (each of those rules reads the marker).
function makeBase(contract) {
    const baseOrderId = call("mantle.order.OrderServices.clone#Order", {
        baseOrderId: contract.originOrderId,
        copyPayment: false,
        statusId: "OrderApproved",
        orderName: productName(contract.productId) + " renewal template"
    }).orderId
    const header = find(ORDER, {orderId: baseOrderId}).forUpdate(true).one()
    header.set("orderPurposeEnumId", "OrpRecurringTemplate")
    header.set("recurCronExpression", "0 0 2 * * ?")
    header.set("recurAutoInvoice", "N")
    header.update()
    // the renewals keep the accepted price (no promotion) and are a known customer's
    for (const part of find("mantle.order.OrderPart", {orderId: baseOrderId}).list()) {
        part.set("disablePromotions", "Y")
        part.set("isNewCustomer", "N")
        part.update()
    }
    let kept = false
    for (const item of find("mantle.order.OrderItem", {orderId: baseOrderId}).list()) {
        if (!kept && item.productId === contract.productId) {
            kept = true
            item.set("quantity", toDecimal(1))
            item.set("unitAmount", contract.priceAmount)
            item.update()
        } else item.delete()
    }
    call("update#" + CONTRACT, {contractId: contract.contractId, baseOrderId})
    return baseOrderId
}

// ===== renewals =====
// The renewal's off-session consent holds: given for the contract's own card, still in effect with its provider profile
// (kept at a gateway that charges off-session: the checkout and change#SubscriptionMethod check that).
function consentHolds(contract) {
    if (!contract.consentDate || !contract.paymentMethodId || contract.consentMethodId !== contract.paymentMethodId) return false
    const method = one("mantle.account.method.PaymentMethod", {paymentMethodId: contract.paymentMethodId})
    return !!method && !method.thruDate && method.ownerPartyId === contract.customerPartyId && !!method.gatewayCimId
}
const renewable = contract =>
    !!contract &&
    contract.autoRenew === "Y" &&
    renewableStates.includes(contract.stateEnumId) &&
    !contract.cancelDate &&
    !!contract.baseOrderId &&
    !!contract.paidThroughDate
const dueNow = contract => (ms(contract.nextRenewalDate || contract.paidThroughDate) ?? Infinity) <= nowMs()
// A step's contract and occurrence, locked in that order (as claim and cancel#Subscription take them), so a cancellation
// and a renewal step never interleave (review R2).
function lockedOccurrence(occurrenceId) {
    const plain = occurrenceId ? one(OCC, {occurrenceId}) : null
    if (!plain) return {contract: null, occurrence: null}
    const contract = find(CONTRACT, {contractId: plain.contractId}).forUpdate(true).one()
    return {contract, occurrence: find(OCC, {occurrenceId}).forUpdate(true).one()}
}
// A contract no longer renewing (cancelled): its unstarted occurrence is closed and its open order cancelled, never charged.
function closedIfStopped(contract, occurrence) {
    if (contract && contract.stateEnumId !== "ScsCancelled" && !contract.cancelDate) return false
    if (occurrence.orderId && one(ORDER, {orderId: occurrence.orderId})?.statusId === "OrderOpen")
        call("mantle.order.OrderServices.cancel#Order", {orderId: occurrence.orderId})
    if (!doneStates.includes(occurrence.stateEnumId))
        call("update#" + OCC, {occurrenceId: occurrence.occurrenceId, stateEnumId: "SrsCancelled", nextRetryDate: null})
    return true
}
// Whether the customer can have a renewal tried again (resume#Renewal, change#SubscriptionMethod): one waiting for a retry
// or for the customer, or the current period's renewal whose retries ran out, the customer's recovery action after retry
// exhaustion (design-shop §10.2; review R1).
const reopenable = (contract, occurrence) =>
    retryStates.includes(occurrence.stateEnumId) ||
    (occurrence.stateEnumId === "SrsFailed" &&
        !!contract &&
        contract.stateEnumId === "ScsPastDue" &&
        !contract.cancelDate &&
        ms(occurrence.periodStartDate) === ms(contract.paidThroughDate))
// dispatch#Renewal (create_RecurringOrders, for a Shop-linked base): the contract's due period claimed and advanced; a base
// of no contract is not Shop's ({handled: false}, the native path's).
function dispatch(p) {
    const contract = one(CONTRACT, {baseOrderId: p.baseOrderId})
    if (!contract) return {handled: false}
    return Object.assign({handled: true}, claimDue(contract, "dispatch"))
}
// A due contract's period claimed (once: unique by contract and period, under the contract's lock, so the nightly hand-off
// and the hourly job together make one occurrence) and advanced. {occurrenceId}, empty when nothing is due.
function claimDue(contract, mode) {
    if (!renewable(contract) || !dueNow(contract)) return {}
    const claimed = step("claim", {contractId: contract.contractId})
    if (claimed.error) {
        ec.logger.error("Shop renewal of contract " + contract.contractId + " not claimed: " + firstLine(claimed.error))
        return {}
    }
    if (claimed.result.occurrenceId) advance(claimed.result.occurrenceId, mode)
    return {occurrenceId: claimed.result.occurrenceId || null}
}
// claim: under the contract's lock, its due period's occurrence (unique by contract and period start), made once.
function claimStep(p) {
    const contract = find(CONTRACT, {contractId: p.contractId}).forUpdate(true).one()
    if (!renewable(contract) || !dueNow(contract)) return {}
    const periodStartDate = contract.paidThroughDate
    const existing = one(OCC, {contractId: contract.contractId, periodStartDate})
    if (existing) return {occurrenceId: existing.occurrenceId}
    const created = call("create#" + OCC, {
        contractId: contract.contractId,
        periodStartDate,
        stateEnumId: "SrsClaimed",
        attemptCount: 0,
        createdDate: ec.user.nowTimestamp
    })
    return {occurrenceId: created.occurrenceId, created: true}
}
// prepare: the renewal order, once: the base cloned with copyPayment=false (OrderOpen; its tax figured by the order's own
// change handling), not a template.
function prepareStep(p) {
    const {contract, occurrence} = lockedOccurrence(p.occurrenceId)
    if (!occurrence || occurrence.orderId || doneStates.includes(occurrence.stateEnumId)) return {}
    if (closedIfStopped(contract, occurrence)) return {}
    const orderId = call("mantle.order.OrderServices.clone#Order", {
        baseOrderId: contract.baseOrderId,
        copyPayment: false,
        orderName: productName(contract.productId) + " renewal " + lib.dateText(occurrence.periodStartDate)
    }).orderId
    const header = find(ORDER, {orderId}).forUpdate(true).one()
    header.set("orderPurposeEnumId", null)
    header.update()
    call("update#" + OCC, {occurrenceId: occurrence.occurrenceId, orderId})
    return {orderId}
}
const orderTotal = orderId =>
    rows("mantle.order.OrderItem", {orderId}).reduce(
        (total, item) => total.add(dec(item.quantity ?? 1).multiply(dec(item.unitAmount))),
        toDecimal(0)
    )
// pay: a new renewal payment and its attempt (purpose shopRenewal) when none is in flight and the consent holds; without it,
// no charge: the occurrence waits for the customer (CONSENT_REQUIRED). An attempt whose outcome is pending or unknown is
// kept, never replaced.
function payStep(p) {
    const {contract, occurrence} = lockedOccurrence(p.occurrenceId)
    if (
        !occurrence ||
        !occurrence.orderId ||
        doneStates.includes(occurrence.stateEnumId) ||
        occurrence.stateEnumId === "SrsPlaced"
    )
        return {}
    if (occurrence.paymentId) {
        const state = attempts().stateOf(one(P, {paymentId: occurrence.paymentId}))
        if (["approved", "pending", "unknown"].includes(state)) {
            if (occurrence.stateEnumId !== "SrsCharging")
                call("update#" + OCC, {occurrenceId: occurrence.occurrenceId, stateEnumId: "SrsCharging"})
            return {paymentId: occurrence.paymentId}
        }
    }
    // a cancellation that came first: nothing is charged
    if (closedIfStopped(contract, occurrence)) return {}
    if (!consentHolds(contract)) {
        call("update#" + OCC, {
            occurrenceId: occurrence.occurrenceId,
            stateEnumId: "SrsActionRequired",
            failureCode: "CONSENT_REQUIRED",
            failureMessage: "No off-session consent is recorded for the subscription's card"
        })
        if (contract.stateEnumId !== "ScsPastDue")
            call("update#" + CONTRACT, {contractId: contract.contractId, stateEnumId: "ScsPastDue"})
        return {action: true}
    }
    const method = one("mantle.account.method.PaymentMethod", {paymentMethodId: contract.paymentMethodId})
    const part = Array.from(find("mantle.order.OrderPart", {orderId: occurrence.orderId}).orderBy("orderPartSeqId").list())[0]
    const paymentId = call("mantle.order.OrderServices.add#OrderPartPayment", {
        orderId: occurrence.orderId,
        orderPartSeqId: part.orderPartSeqId,
        paymentMethodId: method.paymentMethodId,
        paymentInstrumentEnumId: "PiCreditCard",
        paymentGatewayConfigId: method.paymentGatewayConfigId,
        amount: orderTotal(occurrence.orderId),
        statusId: "PmntPromised",
        effectiveDate: ec.user.nowTimestamp,
        comments: "Shop renewal " + occurrence.occurrenceId
    }).paymentId
    attempts().create({
        purpose: "shopRenewal",
        paymentId,
        orderId: occurrence.orderId,
        occurrenceId: occurrence.occurrenceId,
        productStoreId: contract.productStoreId,
        siteId: contract.siteId,
        contactPartyId: contract.customerPartyId,
        snapshotHash: lib.hash({orderId: occurrence.orderId, total: orderTotal(occurrence.orderId).toString()})
    })
    call("update#" + OCC, {
        occurrenceId: occurrence.occurrenceId,
        paymentId,
        stateEnumId: "SrsCharging",
        attemptCount: Number(occurrence.attemptCount || 0) + 1,
        nextRetryDate: null
    })
    return {paymentId, created: true}
}
// The merchant-initiated charge's stored credential: the original customer-initiated transaction that kept the card.
function storedCredential(contract) {
    const credential = {kind: "recurring"}
    if (contract.consentPaymentId) {
        const original = Array.from(
            find("mantle.account.method.PaymentGatewayResponse", {paymentId: contract.consentPaymentId})
                .condition("networkTransId", "is-not-null", null)
                .orderBy("-transactionDate")
                .limit(1)
                .list()
        )[0]
        if (original) {
            credential.originalNetworkTransId = original.networkTransId
            credential.originalAuthAmount = original.amount != null ? String(original.amount) : null
        }
    }
    return credential
}
// authorize: the attempt's payment authorized once, with its operation key (a retry answers the first gateway response)
// and the stored credential; the transaction holds the payment only.
function authorizeStep(p) {
    const occurrence = one(OCC, {occurrenceId: p.occurrenceId})
    if (!occurrence?.paymentId || occurrence.stateEnumId !== "SrsCharging") return {}
    const paymentId = occurrence.paymentId
    find(P, {paymentId}).forUpdate(true).one()
    if (attempts().latestAuthorization(paymentId)) return {}
    const contract = one(CONTRACT, {contractId: occurrence.contractId})
    attempts().asAttempt(paymentId, () =>
        call("mantle.account.PaymentServices.authorize#SinglePayment", {
            paymentId,
            operationKey: "shop-renew-" + paymentId,
            storedCredential: storedCredential(contract)
        })
    )
    attempts().record(paymentId, "pending")
    call("update#mantle.account.payment.PortalPaymentAttempt", {paymentId, lastCheckDate: ec.user.nowTimestamp})
    return {}
}
// apply: what the payment's state means, under the occurrence's lock: approved, place#Order once (the renewal order; its
// approval starts the settled fulfillment that extends access); declined, cancelled or failed, the next retry at the
// offer's days from the first failure, or failed once they are used up (the contract past due, access ending with the paid
// term: no grace); pending or unknown, nothing.
function applyStep(p) {
    const {contract, occurrence} = lockedOccurrence(p.occurrenceId)
    if (!occurrence?.paymentId || occurrence.stateEnumId !== "SrsCharging") return {state: occurrence?.stateEnumId}
    const payment = one(P, {paymentId: occurrence.paymentId})
    const state = attempts().stateOf(payment)
    if (state === "approved") {
        attempts().record(payment.paymentId, "authorized", "approved")
        const order = one(ORDER, {orderId: occurrence.orderId})
        if (order.statusId === "OrderOpen")
            attempts().asAttempt(payment.paymentId, () =>
                call("mantle.order.OrderServices.place#Order", {orderId: occurrence.orderId, requireInventory: false})
            )
        attempts().record(payment.paymentId, "placed")
        call("update#" + OCC, {occurrenceId: occurrence.occurrenceId, stateEnumId: "SrsPlaced", failureCode: null})
        return {state: "SrsPlaced"}
    }
    if (["declined", "cancelled", "failed"].includes(state)) {
        if (payment.statusId === "PmntPromised") call("update#" + P, {paymentId: payment.paymentId, statusId: "PmntCancelled"})
        attempts().record(payment.paymentId, "failed", state)
        const days = retryDaysOf(contract.offerId ? one(OFFER, {offerId: contract.offerId}) : null)
        const first = ms(occurrence.firstFailureDate) ?? nowMs()
        const failures = Number(occurrence.attemptCount || 1)
        const exhausted = failures > days.length
        call("update#" + OCC, {
            occurrenceId: occurrence.occurrenceId,
            stateEnumId: exhausted ? "SrsFailed" : "SrsRetry",
            firstFailureDate: new Date(first),
            nextRetryDate: exhausted ? null : new Date(first + days[failures - 1] * 86400000),
            failureCode: "PAYMENT_" + state.toUpperCase(),
            failureMessage: state === "declined" ? "The renewal payment was declined" : "The renewal payment did not go through"
        })
        call("update#" + CONTRACT, {contractId: contract.contractId, stateEnumId: "ScsPastDue"})
        return {state: exhausted ? "SrsFailed" : "SrsRetry", notice: {kind: "retry", paymentId: payment.paymentId}}
    }
    return {state: "SrsCharging"}
}
// failed: a step that could not run is recorded on the occurrence (its safe failure); the job tries it again.
function failedStep(p) {
    call("update#" + OCC, {
        occurrenceId: p.occurrenceId,
        failureCode: /^([A-Z][A-Z0-9_]+):/.exec(text(p.message))?.[1] || "RENEWAL_FAILED",
        failureMessage: text(p.message).slice(0, 255)
    })
    return {}
}
// The occurrence's next steps, each in a transaction of its own, until it waits (for the provider, a retry day, the
// customer or its fulfillment) or is done. mode job looks a pending payment up when it is due; page at most every
// limits.lookupEveryMs; resume also charges an occurrence waiting for the customer; only the job resumes a placed renewal's
// fulfillment (dispatch leaves it to the approval's own).
function advance(occurrenceId, mode = "job") {
    const run = (name, input = {}) => {
        const done = step(name, Object.assign({occurrenceId}, input))
        if (done.error) {
            ec.logger.warn("Shop renewal " + occurrenceId + " step " + name + ": " + firstLine(done.error))
            step("failed", {occurrenceId, message: firstLine(done.error)})
            return null
        }
        return done.result
    }
    for (let count = 0; count < limits.steps; count++) {
        const occurrence = one(OCC, {occurrenceId})
        const state = occurrence?.stateEnumId
        if (!occurrence || doneStates.includes(state)) break
        if (!occurrence.orderId) {
            if (!run("prepare")) break
            continue
        }
        const retryDue = state === "SrsRetry" && (ms(occurrence.nextRetryDate) ?? Infinity) <= nowMs()
        if (state === "SrsClaimed" || retryDue || (state === "SrsActionRequired" && mode === "resume")) {
            const paid = run("pay")
            if (!paid) break
            if (paid.action) {
                notify("action", occurrenceId, null)
                break
            }
            continue
        }
        if (state === "SrsCharging") {
            if (!attempts().latestAuthorization(occurrence.paymentId)) {
                if (!run("authorize")) break
            } else if (["pending", "unknown"].includes(attempts().stateOf(one(P, {paymentId: occurrence.paymentId})))) {
                const row = attempts().attemptOf(occurrence.paymentId)
                const recently = mode === "page" && row?.lastCheckDate && nowMs() - ms(row.lastCheckDate) < limits.lookupEveryMs
                const due = mode !== "page" || !recently
                if (!due) break
                attempts().lookup(occurrence.paymentId)
                attempts().checked(occurrence.paymentId)
            }
            const applied = run("apply")
            if (!applied || applied.state === "SrsCharging") break
            if (applied.notice) notify(applied.notice.kind, occurrenceId, applied.notice.paymentId)
            continue
        }
        // a placed renewal's fulfillment runs from its approval; the job resumes one that stopped
        if (state === "SrsPlaced" && mode === "job") ensureFulfilled(occurrence)
        break
    }
    return one(OCC, {occurrenceId})
}
// The renewal's notice once its term is activated (ShopFulfillment.js, after the activation commits).
function renewedNotice(orderId) {
    const occurrence = orderId ? one(OCC, {orderId}) : null
    if (occurrence?.stateEnumId === "SrsActivated") notify("renewed", occurrence.occurrenceId, null)
}
// A placed renewal whose approval came later (a hold released) or whose fulfillment stopped: Shop's fulfillment resumed.
function ensureFulfilled(occurrence) {
    const order = one(ORDER, {orderId: occurrence.orderId})
    if (!["OrderApproved", "OrderSent", "OrderProcessing", "OrderCompleted"].includes(order?.statusId)) return
    try {
        call("mantle.product.ShopFulfillmentServices.fulfill#ShopOrder", {orderId: occurrence.orderId})
    } catch (error) {
        ec.message.clearErrors()
        ec.logger.error("Shop renewal " + occurrence.occurrenceId + " fulfillment: " + firstLine(error.message))
    }
}
// run#Renewals (the run_StoreRenewals job, hourly): occurrences in flight (claimed, charging, placed) and retries that are
// due, each on its own, then the contracts whose renewal is due and whose period has no occurrence yet, claimed as the
// nightly create_RecurringOrders hand-off claims them (claimDue), so access does not lapse until the night (Shop F113); one
// that fails is named and the rest go on.
function runRenewals(p) {
    const cf = ec.entity.conditionFactory
    const due = Array.from(
        find(OCC)
            .condition(
                cf.makeCondition(
                    [
                        cf.makeCondition("stateEnumId", "in", ["SrsClaimed", "SrsCharging", "SrsPlaced"]),
                        cf.makeCondition(
                            [
                                cf.makeCondition("stateEnumId", "equals", "SrsRetry"),
                                cf.makeCondition("nextRetryDate", "less-equals", ec.user.nowTimestamp)
                            ],
                            "and"
                        )
                    ],
                    "or"
                )
            )
            .orderBy("createdDate")
            .limit(Number(p.limit || limits.batch))
            .list()
    )
    let advanced = 0,
        failed = 0
    for (const row of due) {
        try {
            advance(row.occurrenceId, "job")
            advanced++
        } catch (error) {
            ec.message.clearErrors()
            failed++
            ec.logger.error("Shop renewal " + row.occurrenceId + " failed: " + firstLine(error.message))
        }
    }
    // the due contracts (active: a past-due one already has its period's occurrence), each claimed on its own
    const contracts = Array.from(
        find(CONTRACT, {autoRenew: "Y", stateEnumId: "ScsActive"})
            .condition("cancelDate", "is-null", null)
            .condition("baseOrderId", "is-not-null", null)
            .condition("nextRenewalDate", "less-equals", ec.user.nowTimestamp)
            .orderBy("nextRenewalDate")
            .limit(Number(p.limit || limits.batch))
            .list()
    ).filter(row => !one(OCC, {contractId: row.contractId, periodStartDate: row.paidThroughDate}))
    let claimed = 0
    for (const contract of contracts) {
        try {
            if (claimDue(contract, "job").occurrenceId) claimed++
        } catch (error) {
            ec.message.clearErrors()
            failed++
            ec.logger.error("Shop renewal of contract " + contract.contractId + " failed: " + firstLine(error.message))
        }
    }
    return {occurrences: due.length + claimed, advanced: advanced + claimed, failed}
}

// ===== the customer's changes =====
// change#SubscriptionMethod (ChangeMethod): another of the account's own cards, kept at one of the store's off-session
// gateways (its hosted setup validated it with the provider), with the customer's consent to renewal charges of it; a
// renewal waiting for the customer is tried again at once.
function changeSubscriptionMethod(p) {
    const reached = reach(p)
    const contract = contractReached(reached, p.contractId)
    checkRevision(contract, p.expectedRevision)
    if (contract.autoRenew !== "Y" || !renewableStates.includes(contract.stateEnumId))
        refuse("Unprocessable", "NOT_RENEWING", "This subscription does not renew")
    const method = renewalMethods(reached.partyId, contract.productStoreId).find(
        row => row.paymentMethodId === text(p.paymentMethodId)
    )
    if (!method) invalid("paymentMethodId", "Choose one of your cards")
    if (!yes(p.consent)) invalid("consent", "Agree to renewal charges of this card")
    // committed in a transaction of its own (at the revision, under the contract's lock) before a waiting renewal's steps,
    // each in its own transaction, read it (review R1)
    const recorded = step("consent", {
        contractId: contract.contractId,
        expectedRevision: text(p.expectedRevision),
        paymentMethodId: method.paymentMethodId,
        visitId: ec.user.visitId || null
    })
    if (recorded.error) stepRefusal(recorded.error)
    resumeWaiting(contract.contractId)
    return getSubscription(Object.assign({}, p, {contractId: contract.contractId}))
}
// consent: the contract's card and the customer's consent to renewal charges of it, at its revision.
function consentStep(p) {
    const contract = find(CONTRACT, {contractId: p.contractId}).forUpdate(true).one()
    checkRevision(contract, p.expectedRevision)
    call("update#" + CONTRACT, {
        contractId: contract.contractId,
        paymentMethodId: p.paymentMethodId,
        consentDate: ec.user.nowTimestamp,
        consentMethodId: p.paymentMethodId,
        consentTermsVersion: contract.termsVersion || null,
        consentEvidence: lib.hash({
            contractId: contract.contractId,
            paymentMethodId: p.paymentMethodId,
            price: dec(contract.priceAmount).toString(),
            visitId: p.visitId || null,
            at: nowMs()
        }),
        // a card kept outside a purchase has no customer-initiated original of its own
        consentPaymentId: p.paymentMethodId === contract.consentMethodId ? contract.consentPaymentId : null,
        consentEndedReason: null,
        revision: Number(contract.revision || 1) + 1
    })
    return {}
}
// A step's refusal answered as the operation's own (its code and kind).
function stepRefusal(message) {
    if (/STALE_REVISION:/.test(message)) refuse("Conflict", "STALE_REVISION", "The subscription changed. Review it and try again")
    throw new Error(firstLine(message))
}
// The contract's renewals the customer can have tried again, each reopened in a transaction of its own (so the steps that
// follow, each in their own, see it) and advanced at once.
function resumeWaiting(contractId, occurrenceId = null) {
    const contract = one(CONTRACT, {contractId})
    for (const row of rows(OCC, {contractId}).filter(
        row => reopenable(contract, row) && (!occurrenceId || row.occurrenceId === occurrenceId)
    )) {
        const reopened = step("reopen", {occurrenceId: row.occurrenceId})
        if (reopened.error) {
            ec.logger.error("Shop renewal " + row.occurrenceId + " not reopened: " + firstLine(reopened.error))
            continue
        }
        if (!reopened.result.reopened) continue
        try {
            advance(row.occurrenceId, "resume")
        } catch (error) {
            ec.message.clearErrors()
            ec.logger.error("Shop renewal " + row.occurrenceId + " not resumed: " + firstLine(error.message))
        }
    }
}
// reopen: under the contract's and occurrence's locks, a renewal the customer can have tried again due now (one whose
// retries ran out back to a retry, its next attempt counted as after the last).
function reopenStep(p) {
    const {contract, occurrence} = lockedOccurrence(p.occurrenceId)
    if (!occurrence || !reopenable(contract, occurrence)) return {}
    call("update#" + OCC, {
        occurrenceId: occurrence.occurrenceId,
        stateEnumId: occurrence.stateEnumId === "SrsFailed" ? "SrsRetry" : occurrence.stateEnumId,
        nextRetryDate: ec.user.nowTimestamp
    })
    return {reopened: true}
}
// resume#Renewal (ResolveRenewal): a renewal waiting for the customer or a retry, charged again now with the contract's
// card (a renewal in flight is answered as it is); without consent it stays waiting (CONSENT_REQUIRED).
function resumeRenewal(p) {
    const reached = reach(p)
    const contract = contractReached(reached, p.contractId)
    if (!consentHolds(contract))
        refuse("Unprocessable", "CONSENT_REQUIRED", "Choose a card and agree to renewal charges first", "paymentMethodId")
    resumeWaiting(contract.contractId)
    for (const row of rows(OCC, {contractId: contract.contractId}).filter(row => row.stateEnumId === "SrsCharging"))
        advance(row.occurrenceId, "page")
    return getSubscription(Object.assign({}, p, {contractId: contract.contractId}))
}
// cancel#Subscription (CancelRenewal): future renewals stopped, access kept to the end of the paid term (no refund or
// immediate end: those are a separate financial action). A renewal whose payment is in flight must settle first
// (RENEWAL_IN_PROGRESS); one waiting for a retry or the customer is closed with no charge.
function cancelSubscription(p) {
    const reached = reach(p)
    const contract = contractReached(reached, p.contractId, true)
    checkRevision(contract, p.expectedRevision)
    if (contract.stateEnumId === "ScsCancelled") return getSubscription(p)
    if (contract.autoRenew !== "Y" || !renewableStates.includes(contract.stateEnumId))
        refuse("Unprocessable", "NOT_RENEWING", "This subscription does not renew")
    stopRenewal(contract, text(p.reason), true)
    return getSubscription(p)
}
// Future renewals of a contract stopped (cancel#Subscription, Commerce's cancel#RecurringContract, a refund of its latest
// term), the contract locked by the caller: its occurrences locked after it, as the renewal steps take them (review R2); one
// whose payment is in flight refused (RENEWAL_IN_PROGRESS: it must settle first) when refuseInFlight, else left to its next
// step, which closes it unless its payment was already asked; one waiting for a retry or the customer closed with no charge
// and its open order cancelled; cancel-at the paid-through date; the base no longer scheduled. Access is kept.
function stopRenewal(contract, reason, refuseInFlight = true) {
    const inFlight = row => row.stateEnumId === "SrsPlaced" || (row.stateEnumId === "SrsCharging" && !!row.paymentId)
    const occurrences = Array.from(find(OCC, {contractId: contract.contractId}).forUpdate(true).list()).filter(
        row => !doneStates.includes(row.stateEnumId)
    )
    if (refuseInFlight && occurrences.some(inFlight))
        refuse("Conflict", "RENEWAL_IN_PROGRESS", "A renewal payment is being processed. Try again in a few minutes")
    for (const row of occurrences.filter(row => !inFlight(row))) {
        const payment = row.paymentId ? one(P, {paymentId: row.paymentId}) : null
        if (payment?.statusId === "PmntPromised") call("update#" + P, {paymentId: payment.paymentId, statusId: "PmntCancelled"})
        if (row.orderId) {
            const order = one(ORDER, {orderId: row.orderId})
            if (order?.statusId === "OrderOpen") call("mantle.order.OrderServices.cancel#Order", {orderId: row.orderId})
        }
        call("update#" + OCC, {occurrenceId: row.occurrenceId, stateEnumId: "SrsCancelled", nextRetryDate: null})
    }
    call("update#" + CONTRACT, {
        contractId: contract.contractId,
        stateEnumId: "ScsCancelled",
        cancelDate: ec.user.nowTimestamp,
        cancelAtDate: contract.paidThroughDate,
        cancelReason: text(reason).slice(0, 255) || null,
        nextRenewalDate: null,
        revision: Number(contract.revision || 1) + 1
    })
    // the base is no longer scheduled: the native job never selects it again
    if (contract.baseOrderId) {
        const base = find(ORDER, {orderId: contract.baseOrderId}).forUpdate(true).one()
        if (base) {
            base.set("recurCronExpression", null)
            base.update()
        }
    }
}

// ===== refunds (from ShopFulfillment.js reconcileRefunded) =====
// The paid-access half of reconcile#RefundedItem: the terms a refunded, returned or charged-back line paid for are revoked
// through their resource's revoke service (the Forum's source-bound grant of that term only), never an independent grant or
// another contract's; the contract's paid-through date drops to what is still paid. {revoked}.
function revokeLine(orderId, orderItemSeqId) {
    let revoked = 0
    const contractIds = new Set()
    for (const sub of rows(SUBSCRIPTION, {orderId, orderItemSeqId})) {
        if (sub.accessRevokedDate) continue
        const resource = one(SUB + "SubscriptionResource", {subscriptionResourceId: sub.subscriptionResourceId})
        if (resource?.revokeAccessServiceName) call(resource.revokeAccessServiceName, {subscriptionId: sub.subscriptionId})
        const ends = ms(sub.thruDate) ?? Infinity
        call("update#" + SUBSCRIPTION, {
            subscriptionId: sub.subscriptionId,
            accessRevokedDate: ec.user.nowTimestamp,
            thruDate: ends > nowMs() ? ec.user.nowTimestamp : sub.thruDate
        })
        if (sub.resourceInstanceId) contractIds.add(sub.resourceInstanceId)
        revoked++
    }
    for (const contractId of contractIds) {
        const contract = find(CONTRACT, {contractId}).forUpdate(true).one()
        if (!contract) continue
        const paid = subscriptionsOf(contractId)
            .filter(sub => !sub.accessRevokedDate)
            .reduce((latest, sub) => Math.max(latest, ms(sub.thruDate) ?? 0), 0)
        call("update#" + CONTRACT, {
            contractId,
            paidThroughDate: paid ? new Date(paid) : ec.user.nowTimestamp,
            revision: Number(contract.revision || 1) + 1
        })
        // a refund of an automatic contract's latest term (its paid-through dropped) ends its renewal at the new paid-through
        // date, so a refunded buyer is never charged again; the buyer subscribes again to start over (Shop F112, the lead's
        // decision). A renewal whose payment is already in flight is left to settle.
        const dropped = (paid || nowMs()) < (ms(contract.paidThroughDate) ?? 0)
        if (dropped && renewable(contract))
            stopRenewal(one(CONTRACT, {contractId}), "Renewal ended: the latest paid term was refunded", false)
    }
    return {revoked}
}

// ===== notices =====
const emailOf = partyId =>
    partyId
        ? rows("moqui.security.UserAccount", {partyId})
              .map(row => row.emailAddress)
              .find(Boolean) || null
        : null
// A renewal notice through the delivery ledger (CX-DELIVERY), once per event: a failed attempt's (PsetPaymentRetry, keyed by
// its payment), a renewal waiting for the customer's (keyed by the occurrence) and a renewal's (PsetSubscriptionRenewal).
// A store with no such email sends none; a failure is logged and never stops the renewal.
function notify(kind, occurrenceId, paymentId) {
    try {
        const occurrence = one(OCC, {occurrenceId})
        const contract = one(CONTRACT, {contractId: occurrence.contractId})
        const emailTypeEnumId = kind === "renewed" ? "PsetSubscriptionRenewal" : "PsetPaymentRetry"
        const email = rows("mantle.product.store.ProductStoreEmail", {
            productStoreId: contract.productStoreId,
            emailTypeEnumId
        }).find(row => lib.active(row) && row.emailTemplateId)
        const toAddress = emailOf(contract.customerPartyId)
        if (!email || !toAddress) return
        const store = one("mantle.product.store.ProductStore", {productStoreId: contract.productStoreId})
        // in a transaction of its own: a notice that cannot be queued never touches the renewal's
        lib.probe("mantle.party.MessageServices.queue#Delivery", {
            eventKey: "shopRenewal:" + kind + ":" + (paymentId || occurrenceId),
            sourceEnumId: "MdsrcShopRenewals",
            recipientPartyId: contract.customerPartyId,
            toAddress,
            templateKey: email.emailTemplateId,
            siteId: contract.siteId,
            productStoreId: contract.productStoreId,
            transactional: true,
            sendNow: true,
            bodyParameters: {
                title:
                    kind === "renewed"
                        ? "Your subscription renewed"
                        : kind === "action"
                          ? "Your subscription needs a card"
                          : "Your renewal payment did not go through",
                storeName: store?.storeName || "",
                subscriptionName: productName(contract.productId),
                amount: ec.l10n.formatCurrency(dec(contract.priceAmount), contract.currencyUomId),
                paidThrough: lib.dateText(contract.paidThroughDate),
                nextRetry: occurrence.stateEnumId === "SrsRetry" ? lib.dateText(occurrence.nextRetryDate) : "",
                subscriptionUrl: publicApps().pageUrl(contract.siteId, "shop", "/Subscriptions/" + contract.contractId)
            }
        })
    } catch (error) {
        ec.message.clearErrors()
        ec.logger.error("Shop renewal " + occurrenceId + " notice " + kind + " not queued: " + firstLine(error.message))
    }
}

const steps = {
    claim: claimStep,
    prepare: prepareStep,
    pay: payStep,
    authorize: authorizeStep,
    apply: applyStep,
    failed: failedStep,
    consent: consentStep,
    reopen: reopenStep
}
const operations = {
    getSubscriptions,
    getSubscription,
    beginSubscriptionPurchase,
    changeSubscriptionMethod,
    cancelSubscription,
    resumeRenewal,
    storeRecurringOffer,
    dispatch,
    runRenewals,
    shopManaged: p => ({shopManaged: shopManaged(p.orderId)}),
    runStep: p => {
        if (!steps[p.step]) throw new Error("Unknown Shop renewal step " + p.step)
        return steps[p.step](p) || {}
    }
}
;({
    // ShopCheckout.js: the checkout's subscription, its submit check and its freeze
    checkoutView,
    submitCheck,
    freezeValues,
    // ShopFulfillment.js: Shop's paid-access orders, a renewal's source, activation and the refund's half
    shopManaged,
    renewalSourceOf,
    activate,
    renewedNotice,
    revokeLine,
    // StoreAdmin.js: the subscriptions readiness
    readiness,
    advance,
    // StoreSubscriptions.js (Commerce P12, the staff part): the contract's terms and states, its consent, the renewals that
    // can be tried again, stopping its renewal and the coordinator's resumption
    limits,
    stateTexts,
    renewableStates,
    doneStates,
    termOf,
    termText,
    currentOffers,
    offSessionGateways,
    subscriptionsOf,
    accessActive,
    consentHolds,
    reopenable,
    stopRenewal,
    resumeWaiting,
    execute: (op, parameters) => {
        if (!operations[op]) throw new Error("Unknown Shop subscription operation " + op)
        return operations[op](parameters || {})
    }
})
