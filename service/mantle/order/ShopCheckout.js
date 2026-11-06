/* CC0 1.0 Universal plus Grant of Patent License. See LICENSE.md.
 * Shop's checkout and payment (mr-pass impl-shop P5; design-shop §6 Checkout, PaymentResult, OrderConfirmation, §7.2-§7.3,
 * §8; SHOP-CHECKOUT, SHOP-PAYMENT): one StoreCheckout coordinates a cart (ShopCart.js) through contact, addresses,
 * delivery, payment and review to one placement, over Mantle's own services; Mantle's order, payment and gateway records
 * stay the only ledger.
 *
 * - Who: the cart's holder (the session's cart capability, or the signed-in account's own cart); after submission also
 *   the checkout's reference and its key (the narrow capability a provider's return and a refreshed frontend carry, read
 *   for a day after completion), and for the confirmation the guest's SalesOrder OrderView capability or the signed-in
 *   customer. An order id alone reaches nothing.
 * - What a shopper sends: contact fields, address fields (or an own saved address), the delivery option of the current
 *   quote, the payment option, the revision and terms version they saw, and an operation id; never a price, total,
 *   customer, store or status.
 * - Freeze (submit): the delivery re-quoted first (a carrier may be asked, outside any lock), then under the order's lock
 *   and in a committed transaction of its own the lines, prices, publication, quote, tax, terms and Commerce P7's promotion
 *   limits checked; a change gives reviewRequired with what changed, and the shopper submits again at the new revision.
 *   The snapshot (and its hash) is bound to the frozen orderRevision and committed with the payment and its attempt
 *   before any provider call.
 * - Payment: Accounting's typed attempt (PaymentAttempts.js, purpose shopCheckout) for a promised card payment of the due
 *   amount, authorized through authorize#SinglePayment with the attempt's operation key and the canonical return address,
 *   in a transaction holding only the payment. A hosted page (the test gateway's, Authorize.Net Accept Hosted's through
 *   PASS's relay) decides; its return, the provider's webhook and the reconciliation job only look the payment up by its
 *   reference (get#SinglePaymentGatewayDetails). An unknown outcome stays unknown: the same attempt is answered again and
 *   no new operation key is made to escape it. A zero total skips the gateway.
 * - Placement: once the payment is approved (or nothing is due), the intent is committed, then place#Order once in a
 *   transaction of its own; a crash after it is recovered from the order's own status, and a placement that fails after
 *   the provider's success keeps the payment and attempt (the checkout stays placementPending with its failure, retried
 *   a bounded number of times, for staff after that). An amount mismatch found then, or a capture that fails later, holds
 *   the order (OhtPayment), which Accounting's payment operator releases.
 * Reads and writes are the authority's own (authorization disabled), after these checks.
 */
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const carts = () => ec.resource.script("component://mr-mantle/service/mantle/order/ShopCart.js")
const catalog = () => ec.resource.script("component://mr-mantle/service/mantle/product/ShopCatalog.js")
const settings = () => ec.resource.script("component://mr-mantle/service/mantle/product/StoreCheckout.js")
const attempts = () => ec.resource.script("component://mr-mantle/service/mantle/account/PaymentAttempts.js")
const externalAccess = () => ec.resource.script("component://mr-mantle/service/mantle/party/ExternalAccess.js")
const publicApps = () => ec.resource.script("component://mr-mantle/service/mantle/public/PublicApps.js")
const {find, one, rows, ms} = lib
const C = "mantle.order.StoreCheckout"
const A = "mantle.order.StoreCartAccess"
const P = "mantle.account.payment.Payment"
const R = "mantle.account.method.PaymentGatewayResponse"
const OPERATION = "mantle.ledger.transaction.PostingOperation"
const SERVICES = "mantle.order.ShopCheckoutServices."

// ===== tables =====
// Bounds: days an unsubmitted checkout lives, minutes a delivery quote holds, how long a reference reads a completed
// checkout, how often a result read may ask the provider, placement tries before staff, the lines a snapshot holds.
const limits = {
    checkoutDays: 2,
    quoteMinutes: 30,
    returnReadMs: 86400000,
    lookupEveryMs: 1000,
    placementTries: 5,
    orderLinkDays: 366,
    reconcileBatch: 200
}
const openStatuses = ["ScoEditing", "ScoReady", "ScoReviewRequired", "ScoPaymentPending", "ScoPlacementPending"]
const editableStatuses = ["ScoEditing", "ScoReady", "ScoReviewRequired"]
const physicalTypes = ["PtAsset", "PtDigitalAsset", "PtAssetUse", "PtPickAssembly"]
const taxTypes = ["ItemSalesTax", "ItemVatTax"]
// The state each status shows a page (the result contract's names, design-shop §7.2).
const stateNames = {
    ScoEditing: "editing",
    ScoReady: "ready",
    ScoReviewRequired: "reviewRequired",
    ScoPaymentPending: "paymentPending",
    ScoPlacementPending: "placementPending",
    ScoCompleted: "completed",
    ScoExpired: "expired",
    ScoCancelled: "cancelled"
}
// What a shopper is told of each kind of change found at the freeze.
const changeTexts = {
    price: change => "The price of " + change.name + " changed from " + change.before + " to " + change.after + ".",
    unavailable: change => change.name + " cannot be bought now. Remove it to check out.",
    delivery: change => "The delivery charge changed from " + change.before + " to " + change.after + ".",
    quoteExpired: () => "Your delivery choice is no longer offered. Choose a delivery option again.",
    tax: change => "The tax changed from " + change.before + " to " + change.after + ".",
    promotionLimit: change => "The promotion " + change.name + " has reached its limit. Remove its code to check out.",
    terms: () => "The terms of sale changed. Review them and accept them again."
}

// ===== values =====
const text = value => (value == null ? "" : String(value).trim())
const nowMs = () => ms(ec.user.nowTimestamp)
const dec = value => toDecimal(value == null || value === "" ? 0 : value)
const yes = value => value === true || value === "true" || value === "Y" || value === "on"
const no = value => value === false || value === "false" || value === "N"
function refuse(kind, code, message, field) {
    const error = new Error(code + (field ? "[" + field + "]" : "") + ": " + message)
    error.moquiErrorKind = kind
    throw error
}
const notAvailable = () => refuse("NotFound", "NOT_AVAILABLE", "This checkout is not available")
const invalid = (field, message) => refuse("Unprocessable", "VALUE_INVALID", message, field)
const digest = token => externalAccess().tokenDigest(token)
const call = lib.call
const enumText = enumId => (enumId ? one("moqui.basic.Enumeration", {enumId})?.description || enumId : "")
const money = (amount, currencyUomId) => catalog().money(amount, currencyUomId)
const moneyText = (amount, currencyUomId) => ec.l10n.formatCurrency(dec(amount), currencyUomId)
// A step in a transaction of its own (committed or rolled back alone): {result} or {error} with its message.
function step(name, input) {
    ec.message.pushErrors()
    try {
        const out =
            ec.service
                .sync()
                .name(SERVICES + "run#Step")
                .parameters({input: Object.assign({step: name}, input)})
                .requireNewTransaction(true)
                .call() || {}
        if (ec.message.hasError()) return {error: ec.message.getErrorsString()}
        return {result: out.result || {}}
    } catch (error) {
        return {error: String(error.message || error), kind: error.moquiErrorKind || null}
    } finally {
        ec.message.clearErrors()
        ec.message.popErrors()
    }
}
// A refusal raised again after its step's transaction rolled back.
function raise(failed) {
    const error = new Error(
        String(failed.error)
            .split("\n")[0]
            .replace(/^(?:Error: )+/, "")
    )
    const code = /^([A-Z][A-Z0-9_]+)/.exec(error.message)?.[1]
    error.moquiErrorKind =
        failed.kind ||
        {
            NOT_AVAILABLE: "NotFound",
            STALE_REVISION: "Conflict",
            REVIEW_REQUIRED: "Conflict",
            OPERATION_CONFLICT: "Conflict",
            CHECKOUT_PENDING: "Conflict",
            SIGN_IN_REQUIRED: "AuthenticationRequired",
            RATE_LIMITED: "Tarpit",
            PROVIDER_UNAVAILABLE: "Unavailable"
        }[code] ||
        "Unprocessable"
    throw error
}

// ===== the shop, the cart and the checkout =====
const shopOf = p => carts().shopOf(p)
const policyOf = row => lib.json(row.policyJson, {})
function storePolicy(store) {
    const out = {}
    for (const [field, definition] of Object.entries(settings().checkoutPolicy))
        out[field] =
            settings().settingAt(store.productStoreId, definition.settingTypeEnumId)?.settingValue ?? definition.defaultValue
    return out
}
function checkoutRow(checkoutId, forUpdate) {
    return checkoutId ? find(C, {checkoutId}).forUpdate(!!forUpdate).one() : null
}
// The cart's current checkout (not expired or cancelled), else null.
function checkoutOfCart(cart) {
    return (
        Array.from(
            find(C, {cartAccessId: cart.row.cartAccessId})
                .condition("statusId", "in", openStatuses.concat(["ScoCompleted"]))
                .orderBy("-createdDate")
                .limit(1)
                .list()
        )[0] || null
    )
}
// The checkout the reference and its key name, on this site: open, or completed less than a day ago.
function checkoutOfReference(shop, reference, key) {
    const ref = text(reference)
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(ref) || text(key).length < 32 || text(key).length > 128) return null
    const row = one(C, {returnReference: ref})
    if (!row || row.siteId !== shop.siteId || !row.returnKeyDigest || row.returnKeyDigest !== digest(text(key))) return null
    if (row.statusId === "ScoCompleted" && nowMs() - (ms(row.completedDate) ?? 0) > limits.returnReadMs) return null
    if (!openStatuses.includes(row.statusId) && row.statusId !== "ScoCompleted") return null
    return row
}
// The session's cart capability of a cart placed less than a day ago (its row retired as placed): reads its checkout.
function placedCheckoutOfToken(shop, token) {
    const presented = text(token)
    if (presented.length < 32 || presented.length > 128) return null
    externalAccess().throttle("cart-token", carts().limits.lookups, "Wait a few minutes before opening your cart again")
    const row = one(A, {capabilityDigest: digest(presented)})
    if (!row || row.siteId !== shop.siteId || row.revokeReasonEnumId !== "ScrPlaced") return null
    if (nowMs() - (ms(row.revokedDate) ?? 0) > limits.returnReadMs) return null
    if (row.customerPartyId && row.customerPartyId !== shop.customerPartyId) return null
    return checkoutOfCart({row})
}
// What a call reaches: {shop, cart, checkout, via}. A cart's holder reaches its cart and checkout (writes); the reference
// and its key, or a placed cart's capability, reach the checkout only (reads, and a resolved attempt's resumption).
function reach(p, needCheckout = true) {
    const shop = shopOf(p)
    const cart = carts().cartOf(shop, p.token)
    // a reference with its key (a provider's return) names its checkout first; else the cart's
    let checkout = p.reference && p.key ? checkoutOfReference(shop, p.reference, p.key) : null
    let via = checkout ? "reference" : null
    if (checkout && cart && cart.row.cartAccessId === checkout.cartAccessId) via = "cart"
    if (!checkout && cart) {
        checkout = checkoutOfCart(cart)
        via = "cart"
    }
    if (!checkout && !cart && p.token) {
        checkout = placedCheckoutOfToken(shop, p.token)
        via = checkout ? "placedCart" : via
    }
    if (!checkout && shop.customerPartyId && p.reference) {
        const row = one(C, {returnReference: text(p.reference)})
        if (row && row.siteId === shop.siteId && row.customerPartyId === shop.customerPartyId && row.accountCheckout === "Y") {
            checkout = row
            via = "account"
        }
    }
    if (needCheckout && !checkout) notAvailable()
    return {shop, cart, checkout, via}
}
function requireCartWrite(reached) {
    if (reached.via !== "cart" || !reached.cart) notAvailable()
    if (!editableStatuses.includes(reached.checkout.statusId))
        refuse("Conflict", "CHECKOUT_PENDING", "This checkout was submitted. Wait for its payment to finish")
    return reached
}
function checkRevision(cart, expected, required) {
    if (expected == null || text(expected) === "") {
        if (required) invalid("expectedRevision", "Reload the checkout and try again")
        return
    }
    if (text(expected) !== String(carts().revisionOf(cart.order)))
        refuse("Conflict", "STALE_REVISION", "Your cart changed in another window. Review it and try again")
}
const freshCart = reached => carts().loaded(reached.cart.row)
const reload = reached =>
    Object.assign({}, reached, {cart: reached.cart && freshCart(reached), checkout: checkoutRow(reached.checkout.checkoutId)})

// ===== operation ids =====
// A checkout write with an operationId answers its first result again (PostingOperation, keyed by the checkout and the id);
// a changed request with the same id is OPERATION_CONFLICT. Secrets (a return key, a capability) are never kept in it.
function replayOf(checkoutId, operation, p, request) {
    const id = text(p.operationId)
    if (!id) return null
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(id)) invalid("operationId", "This request cannot be sent")
    const operationKey = "SK" + ec.resource.digestText(checkoutId + ":" + id, "sha256").slice(0, 38)
    const requestHash = lib.hash(Object.assign({operation}, request))
    const old = one(OPERATION, {operationKey})
    if (old && (old.operationType !== "ShopCheckout" || old.requestHash !== requestHash))
        refuse("Conflict", "OPERATION_CONFLICT", "This request was already sent with other details")
    return {operationKey, requestHash, answer: old ? Object.assign(lib.json(old.resultJson, {}), {alreadyApplied: true}) : null}
}
function remember(replay, checkout, result) {
    if (!replay || one(OPERATION, {operationKey: replay.operationKey})) return result
    const {returnKey, orderToken, token, ...kept} = result
    call("create#" + OPERATION, {
        operationKey: replay.operationKey,
        operationType: "ShopCheckout",
        organizationPartyId: null,
        userId: ec.user.userId || null,
        submittedDate: ec.user.nowTimestamp,
        completedDate: ec.user.nowTimestamp,
        requestHash: replay.requestHash,
        status: "complete",
        resultEntityName: C,
        resultId: checkout.checkoutId,
        resultJson: JSON.stringify(kept)
    })
    return result
}

// ===== the order =====
const orderOf = orderId => one("mantle.order.OrderHeader", {orderId})
const partOf = orderId => find("mantle.order.OrderPart", {orderId}).orderBy("orderPartSeqId").list()[0]
const itemsOf = orderId => rows("mantle.order.OrderItem", {orderId})
function physical(orderId) {
    const ids = carts()
        .productLines(orderId)
        .map(line => line.productId)
    if (!ids.length) return false
    return Array.from(find("mantle.product.Product").condition("productId", "in", ids).list()).some(product =>
        physicalTypes.includes(product.productTypeEnumId)
    )
}
const amountOf = item => dec(item.quantity ?? 1).multiply(dec(item.unitAmount))
const shippingTotal = orderId =>
    itemsOf(orderId)
        .filter(item => item.itemTypeEnumId === "ItemShipping")
        .reduce((total, item) => total.add(amountOf(item)), dec(0))
const taxTotal = orderId =>
    itemsOf(orderId)
        .filter(item => taxTypes.includes(item.itemTypeEnumId))
        .reduce((total, item) => total.add(amountOf(item)), dec(0))
// every item of the order: its lines, their discounts, the order's promotions, delivery and tax
const grandTotal = orderId => itemsOf(orderId).reduce((total, item) => total.add(amountOf(item)), dec(0))
// Tax for the order part's address through the store's tax gateway (calculate#OrderSalesTax; none without a gateway).
function retax(orderId) {
    try {
        call("mantle.other.TaxServices.calculate#OrderSalesTax", {orderId})
    } catch (error) {
        ec.message.clearErrors()
        refuse("Unavailable", "PROVIDER_UNAVAILABLE", "Tax cannot be calculated now. Try again in a moment")
    }
}

// ===== terms =====
// The site's live terms page (Commerce P4's policy page): {sitePageId, version, title, url}, or null.
function termsOf(shop) {
    const at = nowMs()
    const row = rows("mantle.public.PublicSitePage", {siteId: shop.siteId, pageRole: "terms"}).find(page =>
        settings().livePage(page, at)
    )
    if (!row) return null
    return {
        sitePageId: row.sitePageId,
        version: String(row.versionName),
        title: row.title || "Terms of sale",
        url: row.routePath ? shop.base + "/pages/" + row.routePath : null
    }
}

// ===== payment options =====
// The store's gateways that can take a hosted checkout (StoreCheckout.js gatewayCapabilities), enabled for its
// organization: one option per payment instrument. An unsupported flow offers nothing (never a card form of Shop's own).
function paymentOptions(shop, signedIn) {
    const enabled = Object.fromEntries(
        rows("mantle.account.method.PaymentGatewayOrganization", {organizationPartyId: shop.store.organizationPartyId})
            .filter(row => row.isEnabled !== "N" && lib.active(row))
            .map(row => [row.paymentGatewayConfigId, true])
    )
    return rows("mantle.product.store.ProductStorePaymentGateway", {productStoreId: shop.productStoreId})
        .filter(row => enabled[row.paymentGatewayConfigId])
        .map(row => {
            const config = one("mantle.account.method.PaymentGatewayConfig", {paymentGatewayConfigId: row.paymentGatewayConfigId})
            const of = config ? settings().gatewayCapabilities[config.paymentGatewayTypeEnumId] : null
            const capabilities = of ? of(config) : {}
            return {row, config, capabilities}
        })
        .filter(option => option.capabilities.hostedCheckout)
        .map(option => ({
            paymentOptionId: option.row.paymentInstrumentEnumId,
            label: enumText(option.row.paymentInstrumentEnumId),
            provider: option.config.description || "Payment provider",
            hosted: true,
            canSave: !!(signedIn && option.capabilities.savedMethods),
            paymentGatewayConfigId: option.row.paymentGatewayConfigId
        }))
}
const publicOption = option => {
    const {paymentGatewayConfigId, ...shown} = option
    return shown
}

// ===== delivery =====
// The current quotes for the order part's address: get#StoreShippingOptions with rates (get#OrderShippingRatesBulk and
// Commerce P6's local rates); a method with no quote is not offered (impl-commerce F79). [{carrierPartyId,
// shipmentMethodEnumId, label, amount}].
function deliveryQuotes(shop, order, part) {
    if (!part?.postalContactMechId) return []
    let out
    try {
        out = call("mantle.product.StoreServices.get#StoreShippingOptions", {
            productStoreId: shop.productStoreId,
            orderId: order.orderId,
            orderPartSeqId: part.orderPartSeqId,
            getRates: true
        })
    } catch (error) {
        ec.message.clearErrors()
        ec.logger.warn("Shop checkout delivery quotes of order " + order.orderId + " failed: " + error.message)
        refuse("Unavailable", "PROVIDER_UNAVAILABLE", "Delivery options cannot be read now. Try again in a moment")
    }
    return Array.from(out.shippingOptions || [])
        .filter(option => option.shippingTotal != null && option.shippingTotal !== "")
        .map(option => ({
            carrierPartyId: option.carrierPartyId,
            shipmentMethodEnumId: option.shipmentMethodEnumId,
            label:
                (option.carrierPartyId && option.carrierPartyId !== "_NA_"
                    ? (option.carrierName || option.carrierPartyId) + " "
                    : "") + (option.description || option.shipmentMethodDescription || option.shipmentMethodEnumId),
            amount: dec(option.shippingTotal)
        }))
}
const quoteCurrent = (checkout, order) =>
    !!checkout.carrierPartyId &&
    Number(checkout.quoteRevision || 0) === carts().revisionOf(order) &&
    (ms(checkout.quoteExpireDate) ?? 0) > nowMs()

// ===== the checkout's state =====
// What is still to do before the checkout is ready: contact, address and delivery (a physical cart), payment (anything
// due). The status moves between editing and ready with it.
function missingOf(shop, checkout, order, part) {
    const missing = []
    if (!checkout.contactEmail || !checkout.contactName) missing.push("contact")
    const needsDelivery = physical(order.orderId)
    if (needsDelivery && !checkout.shippingContactMechId) missing.push("addresses")
    if (needsDelivery && !quoteCurrent(checkout, order)) missing.push("delivery")
    const due = grandTotal(order.orderId)
    if (due.compare(0) > 0 && !checkout.paymentInstrumentEnumId) missing.push("payment")
    if (!carts().productLines(order.orderId).length) missing.push("cart")
    return missing
}
function restate(reached) {
    const fresh = reload(reached)
    const checkout = fresh.checkout
    if (!editableStatuses.includes(checkout.statusId)) return fresh
    const missing = missingOf(fresh.shop, checkout, fresh.cart.order, fresh.cart.part)
    const statusId = checkout.statusId === "ScoReviewRequired" ? "ScoReviewRequired" : missing.length ? "ScoEditing" : "ScoReady"
    if (statusId !== checkout.statusId) call("update#" + C, {checkoutId: checkout.checkoutId, statusId})
    return reload(fresh)
}
const addressText = contactMechId => {
    const address = contactMechId ? one("mantle.party.contact.PostalAddress", {contactMechId}) : null
    if (!address) return null
    const geo = geoId =>
        geoId ? one("moqui.basic.Geo", {geoId})?.geoCodeAlpha2 || one("moqui.basic.Geo", {geoId})?.geoName || geoId : ""
    return {
        toName: address.toName || "",
        address1: address.address1 || "",
        address2: address.address2 || "",
        city: address.city || "",
        stateProvinceGeoId: address.stateProvinceGeoId || "",
        postalCode: address.postalCode || "",
        countryGeoId: address.countryGeoId || "",
        text: [
            address.toName,
            address.address1,
            address.address2,
            address.city,
            geo(address.stateProvinceGeoId),
            address.postalCode,
            geo(address.countryGeoId)
        ]
            .filter(Boolean)
            .join(", ")
    }
}

// ===== the checkout view =====
// CheckoutView (design-shop §6 Checkout; Contracts.d.ts): the state and revision, each step's values and whether it is
// done, the cart's lines and the order's totals (items, discounts, delivery, tax, total and what is due now), the terms
// to accept, what changed at the last freeze, and the payment's progress once submitted. Decimal strings with display
// text; no party, gateway or internal id but the line's and the checkout's reference.
function view(reached, extra) {
    const {shop, checkout} = reached
    const currency = checkout.currencyUomId
    const order = orderOf(checkout.orderId)
    const part = partOf(checkout.orderId)
    const cartView = carts().view(shop, {row: one(A, {cartAccessId: checkout.cartAccessId}), order, part}).cart
    const missing = editableStatuses.includes(checkout.statusId) ? missingOf(shop, checkout, order, part) : []
    const needsDelivery = physical(order.orderId)
    const terms = policyOf(checkout).termsRequired === "false" ? null : termsOf(shop)
    const due = grandTotal(order.orderId)
    const options = due.compare(0) > 0 ? paymentOptions(shop, checkout.accountCheckout === "Y") : []
    const chosen = options.find(option => option.paymentOptionId === checkout.paymentInstrumentEnumId)
    const payment = checkout.paymentId ? one(P, {paymentId: checkout.paymentId}) : null
    const items = dec(cartView.totals.items.amount)
    const discounts = dec(cartView.totals.discounts.amount)
    const shipping = shippingTotal(order.orderId)
    const tax = taxTotal(order.orderId)
    return Object.assign(
        {
            checkout: {
                reference: checkout.returnReference,
                state: stateNames[checkout.statusId],
                revision: String(carts().revisionOf(order)),
                accountCheckout: checkout.accountCheckout === "Y",
                missing,
                contact: {
                    done: !missing.includes("contact"),
                    emailAddress: checkout.contactEmail || "",
                    name: checkout.contactName || "",
                    phone: checkout.contactPhone || "",
                    phoneMode: policyOf(checkout).contactPhone || "optional",
                    fromAccount: checkout.accountCheckout === "Y"
                },
                addresses: {
                    needed: needsDelivery,
                    done: !needsDelivery || !!checkout.shippingContactMechId,
                    shipping: addressText(checkout.shippingContactMechId),
                    billingSame:
                        !checkout.billingContactMechId || checkout.billingContactMechId === checkout.shippingContactMechId,
                    billing:
                        checkout.billingContactMechId && checkout.billingContactMechId !== checkout.shippingContactMechId
                            ? addressText(checkout.billingContactMechId)
                            : null,
                    suggestion: addressText(checkout.addressSuggestionId)
                },
                delivery: {
                    needed: needsDelivery,
                    done: !needsDelivery || quoteCurrent(checkout, order),
                    selected: checkout.carrierPartyId
                        ? {
                              carrierPartyId: checkout.carrierPartyId,
                              shipmentMethodEnumId: checkout.shipmentMethodEnumId,
                              label: enumText(checkout.shipmentMethodEnumId),
                              amount: money(checkout.quoteAmount ?? 0, currency),
                              current: quoteCurrent(checkout, order)
                          }
                        : null
                },
                payment: {
                    needed: due.compare(0) > 0,
                    done: due.compare(0) <= 0 || !!chosen,
                    options: options.map(publicOption),
                    selected: chosen ? publicOption(chosen) : null,
                    savePaymentMethod: checkout.savePaymentMethod === "Y"
                },
                terms: terms ? {required: true, version: terms.version, title: terms.title, url: terms.url} : {required: false},
                lines: cartView.items,
                promoCodes: cartView.promoCodes,
                totals: {
                    items: money(items, currency),
                    discounts: money(discounts, currency),
                    shipping: needsDelivery ? money(shipping, currency) : null,
                    tax: money(tax, currency),
                    total: money(due, currency),
                    dueNow: money(due, currency)
                },
                notices: cartView.notices,
                review: checkout.statusId === "ScoReviewRequired" ? lib.json(checkout.reviewJson, []) : [],
                attempt: payment ? attemptView(checkout, payment) : null,
                failure: checkout.failureCode ? {code: checkout.failureCode} : null
            }
        },
        extra || {}
    )
}
// The payment's progress for a page: its state (pending at the provider, unknown, approved, declined, cancelled or failed)
// with a safe message, and where the payer completes a pending hosted payment (a provider page, or the relay's form).
function attemptView(checkout, payment) {
    const state = attempts().stateOf(payment)
    const action = state === "pending" ? attempts().providerAction(payment.paymentId) : null
    return {
        state,
        amount: money(payment.amount, payment.amountUomId),
        providerUrl: action?.redirectUrl || null,
        providerForm: !!action?.form,
        message:
            {
                pending: "Your payment is not confirmed yet.",
                unknown: "We are confirming your payment with the provider. This can take a few minutes.",
                approved: "Your payment is approved.",
                declined: "Your payment was declined. Choose another way to pay or try again.",
                cancelled: "Your payment did not complete. You can try again.",
                failed: "Your payment could not be started. You can try again."
            }[state] || ""
    }
}

// ===== operations: begin, get, resume =====
// begin#Checkout: the cart's checkout, made when there is none (the store's checkout policy as it is now, the terms in
// effect, the signed-in account's contact), else the current one. An empty cart, a line that cannot be bought, or a store
// whose policy needs an account (accountMode account) for a guest is refused.
function beginCheckout(p) {
    const shop = shopOf(p)
    const cart = carts().cartOf(shop, p.token)
    if (!cart) notAvailable()
    const existing = checkoutOfCart(cart)
    if (existing && existing.statusId !== "ScoCompleted") return view(restate({shop, cart, checkout: existing, via: "cart"}))
    const lines = carts().productLines(cart.row.orderId)
    if (!lines.length) invalid("cart", "Your cart is empty")
    const offers = catalog().offersOf(
        shop,
        lines.map(line => ({productId: line.productId, quantity: Number(String(line.quantity))}))
    )
    const missing = offers.find(offer => !offer.available)
    if (missing)
        refuse(
            "Unprocessable",
            "ITEM_UNAVAILABLE",
            (missing.card?.name || "An item") + " cannot be bought now. Remove it to check out"
        )
    const policy = storePolicy(shop.store)
    if (policy.accountMode === "account" && !shop.customerPartyId)
        refuse("AuthenticationRequired", "SIGN_IN_REQUIRED", "Sign in to check out in this store")
    const account = shop.customerPartyId ? ec.user.userAccount : null
    const person = account?.partyId ? one("mantle.party.Person", {partyId: account.partyId}) : null
    const created = call("create#" + C, {
        cartAccessId: cart.row.cartAccessId,
        orderId: cart.row.orderId,
        siteId: shop.siteId,
        appMountId: shop.mount.appMountId,
        productStoreId: shop.productStoreId,
        currencyUomId: shop.currencyUomId,
        statusId: "ScoEditing",
        customerPartyId: cart.part.customerPartyId,
        accountCheckout: account ? "Y" : "N",
        policyJson: JSON.stringify(policy),
        contactEmail: account?.emailAddress || null,
        contactName: person ? [person.firstName, person.lastName].filter(Boolean).join(" ") || null : null,
        expireDate: new Date(nowMs() + limits.checkoutDays * 86400000),
        createdDate: ec.user.nowTimestamp
    })
    call("update#" + C, {checkoutId: created.checkoutId, returnReference: created.checkoutId})
    // a cart with nothing to deliver has its tax now (its address is the provider's)
    if (!physical(cart.row.orderId)) retax(cart.row.orderId)
    return view(restate({shop, cart, checkout: checkoutRow(created.checkoutId), via: "cart"}))
}
// get#Checkout: the checkout the cart (or the reference and key) reaches; nothing is changed but its editing state.
function getCheckout(p) {
    const reached = reach(p)
    return view(reached.via === "cart" ? restate(reached) : reached)
}
// resume#Checkout: a submitted checkout whose attempt resolved without a payment (declined, cancelled, failed) is open to
// change again; reached by its reference and key from a refreshed frontend, the session gets a new cart capability (its
// token in the answer), so the shopper goes on in this session. A pending or unknown attempt is answered as it is.
function resumeCheckout(p) {
    const reached = reach(p)
    const result = refreshAttempt(reached.shop, reached.checkout.checkoutId, "page")
    const checkout = checkoutRow(reached.checkout.checkoutId)
    let token = null
    if (reached.via === "reference" && editableStatuses.includes(checkout.statusId)) {
        const cartRow = one(A, {cartAccessId: checkout.cartAccessId})
        if (cartRow && !cartRow.revokedDate) token = carts().rotate(cartRow)
    }
    return view(Object.assign({}, reached, {checkout}), Object.assign({resumed: true}, result, token ? {token} : {}))
}

// ===== operations: contact and addresses =====
const emailPattern = /^[^@\s<>"]{1,64}@[^@\s<>"]{1,190}\.[A-Za-z]{2,63}$/
// set#CheckoutContact: the buyer's email, name and phone (the store's phone policy). A guest's go on the cart's guest
// party (its name and a primary email address, kept on the order part); an account's email is the account's. Nothing
// says whether an account uses the email.
function setCheckoutContact(p) {
    const reached = requireCartWrite(reach(p))
    const {checkout, cart} = reached
    const replay = replayOf(checkout.checkoutId, "setCheckoutContact", p, {
        emailAddress: text(p.emailAddress).toLowerCase(),
        name: text(p.name),
        phone: text(p.phone)
    })
    if (replay?.answer) return replay.answer
    checkRevision(cart, p.expectedRevision, false)
    const account = checkout.accountCheckout === "Y"
    const email = account ? checkout.contactEmail || text(ec.user.userAccount?.emailAddress) : text(p.emailAddress).toLowerCase()
    if (!emailPattern.test(email)) invalid("emailAddress", "Enter the email address for your order")
    const name = text(p.name) || (account ? checkout.contactName : "")
    if (!name || name.length > 100) invalid("name", "Enter your name")
    const phone = text(p.phone)
    const phoneMode = policyOf(checkout).contactPhone || "optional"
    if (phoneMode === "required" && !phone) invalid("phone", "Enter a phone number")
    if (phone && !/^[0-9+()\-. ]{5,30}$/.test(phone)) invalid("phone", "Enter a phone number")
    const values = {
        checkoutId: checkout.checkoutId,
        contactEmail: email,
        contactName: name,
        contactPhone: phoneMode === "hidden" ? null : phone || null
    }
    if (!account) {
        const partyId = checkout.customerPartyId
        const [firstName, ...rest] = name.split(/\s+/)
        call("update#mantle.party.Person", {
            partyId,
            firstName: firstName.slice(0, 60),
            lastName: rest.join(" ").slice(0, 60) || null
        })
        if (email !== checkout.contactEmail) {
            const created = call("mantle.party.ContactServices.create#EmailAddress", {
                emailAddress: email,
                partyId,
                contactMechPurposeId: "EmailPrimary"
            })
            values.emailContactMechId = created.contactMechId
            if (
                !one("mantle.order.OrderPartContactMech", {
                    orderId: cart.part.orderId,
                    orderPartSeqId: cart.part.orderPartSeqId,
                    contactMechPurposeId: "EmailPrimary",
                    contactMechId: created.contactMechId
                })
            )
                call("create#mantle.order.OrderPartContactMech", {
                    orderId: cart.part.orderId,
                    orderPartSeqId: cart.part.orderPartSeqId,
                    contactMechPurposeId: "EmailPrimary",
                    contactMechId: created.contactMechId
                })
        }
    }
    call("update#" + C, values)
    return remember(replay, checkout, view(restate(reached)))
}
// An address's fields from the input (prefix "" for delivery, "billing" for billing), checked: the street, city and
// postal code, a country (one of the store's destinations when it limits them) and its state or province when given.
function addressFields(p, prefix, policy) {
    const key = name => (prefix ? prefix + name.charAt(0).toUpperCase() + name.slice(1) : name)
    const field = name => text(p[key(name)])
    const values = {
        toName: field("toName"),
        address1: field("address1"),
        address2: field("address2"),
        city: field("city"),
        postalCode: field("postalCode"),
        countryGeoId: field("countryGeoId") || "USA",
        stateProvinceGeoId: field("stateProvinceGeoId")
    }
    for (const [name, label, max] of [
        ["address1", "street address", 255],
        ["city", "city", 100],
        ["postalCode", "postal code", 60]
    ])
        if (!values[name] || values[name].length > max) invalid(key(name), "Enter the " + label)
    if (values.toName.length > 100) invalid(key("toName"), "Enter a shorter name")
    if (values.address2.length > 255) invalid(key("address2"), "Enter a shorter address")
    const country = one("moqui.basic.Geo", {geoId: values.countryGeoId})
    if (!country || country.geoTypeEnumId !== "GEOT_COUNTRY") invalid(key("countryGeoId"), "Choose a country")
    const destinations = text(policy.destinations)
        .split(/[,\s]+/)
        .filter(Boolean)
    if (!prefix && destinations.length && !destinations.includes(values.countryGeoId))
        invalid(key("countryGeoId"), "This store does not deliver there")
    if (values.stateProvinceGeoId && !one("moqui.basic.Geo", {geoId: values.stateProvinceGeoId}))
        invalid(key("stateProvinceGeoId"), "Choose a state or province")
    return values
}
// An address of the signed-in account's own (a postal address of its party), else refused.
function ownAddress(checkout, contactMechId) {
    const id = text(contactMechId)
    const owned =
        checkout.accountCheckout === "Y" &&
        /^[A-Za-z0-9_-]{1,40}$/.test(id) &&
        rows("mantle.party.contact.PartyContactMech", {partyId: checkout.customerPartyId, contactMechId: id}).some(row =>
            lib.active(row)
        ) &&
        !!one("mantle.party.contact.PostalAddress", {contactMechId: id})
    if (!owned) invalid("contactMechId", "Choose one of your addresses")
    return id
}
// A carrier's corrected address for the delivery address, through the store's shipping gateway that validates addresses
// (validate#PostalAddress), offered and never applied; a failed validation offers none.
function suggestionOf(shop, checkout, contactMechId) {
    const gateway = rows("mantle.product.store.ProductStoreShippingGateway", {productStoreId: shop.productStoreId})
        .map(row => one("mantle.shipment.carrier.ShippingGatewayConfig", {shippingGatewayConfigId: row.shippingGatewayConfigId}))
        .find(config => config?.validateAddressServiceName)
    if (!gateway) return null
    try {
        const out = call("mantle.shipment.CarrierServices.validate#PostalAddress", {
            contactMechId,
            partyId: checkout.customerPartyId,
            shippingGatewayConfigId: gateway.shippingGatewayConfigId
        })
        return out.contactMechId && out.contactMechId !== contactMechId ? out.contactMechId : null
    } catch (error) {
        ec.message.clearErrors()
        ec.logger.warn("Shop checkout " + checkout.checkoutId + " address validation failed: " + error.message)
        return null
    }
}
// set#CheckoutAddresses: the delivery address (new fields, an own saved address, or the offered correction) on the order
// part, and the billing address (the same, or its own fields); the delivery quote then needs choosing again for it.
function setCheckoutAddresses(p) {
    const reached = requireCartWrite(reach(p))
    const {checkout, cart, shop} = reached
    const request = Object.fromEntries(
        Object.entries(p)
            .filter(([key]) => !["siteId", "token", "operationId", "expectedRevision"].includes(key))
            .map(([key, value]) => [key, text(value)])
    )
    const replay = replayOf(checkout.checkoutId, "setCheckoutAddresses", p, request)
    if (replay?.answer) return replay.answer
    checkRevision(cart, p.expectedRevision, true)
    const policy = policyOf(checkout)
    const partyId = checkout.customerPartyId
    let shippingId
    let suggestion = null
    if (yes(p.useSuggestion)) {
        if (!checkout.addressSuggestionId) invalid("useSuggestion", "There is no suggested address")
        shippingId = checkout.addressSuggestionId
    } else if (text(p.contactMechId)) {
        shippingId = ownAddress(checkout, p.contactMechId)
    } else {
        const fields = addressFields(p, "", policy)
        shippingId = call(
            "mantle.party.ContactServices.create#PostalAddress",
            Object.assign({}, fields, {
                toName: fields.toName || checkout.contactName || null,
                address2: fields.address2 || null,
                stateProvinceGeoId: fields.stateProvinceGeoId || null,
                partyId,
                contactMechPurposeId: "PostalShippingDest"
            })
        ).contactMechId
        suggestion = suggestionOf(shop, checkout, shippingId)
    }
    call("mantle.order.OrderServices.set#OrderBillingShippingInfo", {
        orderId: cart.part.orderId,
        orderPartSeqId: cart.part.orderPartSeqId,
        shippingPostalContactMechId: shippingId
    })
    let billingId = shippingId
    if (no(p.billingSame)) {
        const fields = addressFields(p, "billing", policy)
        billingId = call(
            "mantle.party.ContactServices.create#PostalAddress",
            Object.assign({}, fields, {
                toName: fields.toName || checkout.contactName || null,
                address2: fields.address2 || null,
                stateProvinceGeoId: fields.stateProvinceGeoId || null,
                partyId,
                contactMechPurposeId: "PostalBilling"
            })
        ).contactMechId
    }
    call("update#" + C, {
        checkoutId: checkout.checkoutId,
        shippingContactMechId: shippingId,
        billingContactMechId: billingId,
        addressSuggestionId: suggestion
    })
    retax(cart.part.orderId)
    return remember(replay, checkout, view(restate(reached)))
}

// ===== operations: delivery =====
// get#DeliveryOptions: the current quotes for the delivery address (none needed for a cart with nothing to deliver).
function getDeliveryOptions(p) {
    const reached = reach(p)
    if (reached.via !== "cart") notAvailable()
    const {checkout, cart, shop} = reached
    if (!physical(cart.row.orderId)) return {needed: false, options: [], revision: String(carts().revisionOf(cart.order))}
    if (!checkout.shippingContactMechId) invalid("shippingAddress", "Enter the delivery address first")
    const quotes = deliveryQuotes(shop, cart.order, cart.part)
    return {
        needed: true,
        revision: String(carts().revisionOf(cart.order)),
        options: quotes.map(quote => ({
            carrierPartyId: quote.carrierPartyId,
            shipmentMethodEnumId: quote.shipmentMethodEnumId,
            label: quote.label,
            amount: money(quote.amount, checkout.currencyUomId),
            selected:
                quote.carrierPartyId === checkout.carrierPartyId && quote.shipmentMethodEnumId === checkout.shipmentMethodEnumId
        }))
    }
}
// The chosen quote put on the order (the part's carrier and method, its shipping charge, then the tax) and kept on the
// checkout with the revision it holds for and its expiry.
function applyQuote(checkout, cart, quote) {
    call("mantle.order.OrderServices.set#OrderBillingShippingInfo", {
        orderId: cart.part.orderId,
        orderPartSeqId: cart.part.orderPartSeqId,
        carrierPartyId: quote.carrierPartyId,
        shipmentMethodEnumId: quote.shipmentMethodEnumId
    })
    call("mantle.shipment.CarrierServices.calculate#OrderShipping", {orderId: cart.part.orderId})
    retax(cart.part.orderId)
    call("update#" + C, {
        checkoutId: checkout.checkoutId,
        carrierPartyId: quote.carrierPartyId,
        shipmentMethodEnumId: quote.shipmentMethodEnumId,
        quoteAmount: shippingTotal(cart.part.orderId),
        quoteRevision: carts().revisionOf(orderOf(cart.part.orderId)),
        quoteExpireDate: new Date(nowMs() + limits.quoteMinutes * 60000)
    })
}
// select#Delivery: one of the current quotes for the address (a method with none is not offered).
function selectDelivery(p) {
    const reached = requireCartWrite(reach(p))
    const {checkout, cart, shop} = reached
    const request = {carrierPartyId: text(p.carrierPartyId), shipmentMethodEnumId: text(p.shipmentMethodEnumId)}
    const replay = replayOf(checkout.checkoutId, "selectDelivery", p, request)
    if (replay?.answer) return replay.answer
    checkRevision(cart, p.expectedRevision, true)
    if (!physical(cart.row.orderId)) invalid("shipmentMethodEnumId", "Nothing in your cart is delivered")
    if (!checkout.shippingContactMechId) invalid("shippingAddress", "Enter the delivery address first")
    const quote = deliveryQuotes(shop, cart.order, cart.part).find(
        option => option.carrierPartyId === request.carrierPartyId && option.shipmentMethodEnumId === request.shipmentMethodEnumId
    )
    if (!quote)
        refuse("Conflict", "QUOTE_EXPIRED", "This delivery option is no longer offered. Choose another", "shipmentMethodEnumId")
    applyQuote(checkout, cart, quote)
    return remember(replay, checkout, view(restate(reached)))
}

// ===== operations: payment =====
// get#PaymentOptions: the store's hosted payment options for what is due (none when nothing is due).
function getPaymentOptions(p) {
    const reached = reach(p)
    if (reached.via !== "cart") notAvailable()
    const due = grandTotal(reached.cart.row.orderId)
    return {
        needed: due.compare(0) > 0,
        dueNow: money(due, reached.checkout.currencyUomId),
        options:
            due.compare(0) > 0 ? paymentOptions(reached.shop, reached.checkout.accountCheckout === "Y").map(publicOption) : []
    }
}
// select#Payment: one of the options; a signed-in buyer may ask to keep the card (saved after an approved payment).
function selectPayment(p) {
    const reached = requireCartWrite(reach(p))
    const {checkout, shop} = reached
    const request = {paymentOptionId: text(p.paymentOptionId), savePaymentMethod: yes(p.savePaymentMethod)}
    const replay = replayOf(checkout.checkoutId, "selectPayment", p, request)
    if (replay?.answer) return replay.answer
    const option = paymentOptions(shop, checkout.accountCheckout === "Y").find(
        candidate => candidate.paymentOptionId === request.paymentOptionId
    )
    if (!option) invalid("paymentOptionId", "Choose a way to pay")
    call("update#" + C, {
        checkoutId: checkout.checkoutId,
        paymentInstrumentEnumId: option.paymentOptionId,
        paymentGatewayConfigId: option.paymentGatewayConfigId,
        savePaymentMethod: request.savePaymentMethod && option.canSave ? "Y" : "N"
    })
    return remember(replay, checkout, view(restate(reached)))
}

// ===== operations: submit =====
// submit#Checkout (design-shop §7.2 steps 5-6, §8.2): a ready checkout at the revision and terms version the shopper saw
// is frozen and paid. A submitted checkout answers its attempt again (a second submit makes no second order or payment); a
// change found at the freeze is reviewRequired (Conflict), committed so the shopper sees it. Answers the checkout with
// the attempt and, once, the return key the result page reads with.
function submitCheckout(p) {
    const reached = reach(p)
    const {checkout, cart, shop} = reached
    const request = {revision: text(p.expectedRevision), termsVersion: text(p.termsVersion), acceptTerms: yes(p.acceptTerms)}
    // a retry of a submit answers its first result, also once the order is placed (the cart's capability then reads it)
    const replay = replayOf(checkout.checkoutId, "submitCheckout", p, request)
    if (replay?.answer) return replay.answer
    if (reached.via !== "cart" || !cart) notAvailable()
    // a submitted checkout: its attempt again, never a second one
    if (["ScoPaymentPending", "ScoPlacementPending"].includes(checkout.statusId)) {
        const result = refreshAttempt(shop, checkout.checkoutId, "page")
        return view(reload(reached), Object.assign({alreadySubmitted: true}, result))
    }
    if (!editableStatuses.includes(checkout.statusId)) notAvailable()
    checkRevision(cart, p.expectedRevision, true)
    const terms = policyOf(checkout).termsRequired === "false" ? null : termsOf(shop)
    if (policyOf(checkout).termsRequired !== "false" && !terms)
        refuse("Unavailable", "PROVIDER_UNAVAILABLE", "This store cannot take orders now")
    if (terms && !request.acceptTerms) invalid("acceptTerms", "Accept the terms of sale to place your order")
    const missing = missingOf(shop, checkout, cart.order, cart.part)
    if (missing.length) invalid(missing[0], "Complete your " + missing[0] + " first")
    // the delivery re-quoted outside the freeze's lock (a carrier may be asked)
    const quote = physical(cart.row.orderId)
        ? deliveryQuotes(shop, cart.order, cart.part).find(
              option =>
                  option.carrierPartyId === checkout.carrierPartyId &&
                  option.shipmentMethodEnumId === checkout.shipmentMethodEnumId
          ) || null
        : null
    const returnKey = ec.user.randomString(40)
    const frozen = step("freeze", {
        siteId: shop.siteId,
        checkoutId: checkout.checkoutId,
        termsVersion: request.termsVersion,
        quote: quote
            ? {
                  carrierPartyId: quote.carrierPartyId,
                  shipmentMethodEnumId: quote.shipmentMethodEnumId,
                  amount: quote.amount.toString()
              }
            : null,
        quoteNeeded: physical(cart.row.orderId),
        returnKeyDigest: digest(returnKey)
    })
    if (frozen.error) raise(frozen)
    if (frozen.result.reviewRequired) {
        const after = view(reload(reached))
        const first = after.checkout.review[0]
        refuse("Conflict", "REVIEW_REQUIRED", first ? first.text : "Your order changed. Review it and submit again")
    }
    // the payment's provider call, in a transaction holding only the payment
    if (frozen.result.paymentId) {
        const authorized = step("authorize", {checkoutId: checkout.checkoutId, siteId: shop.siteId, returnKey})
        if (authorized.error) ec.logger.warn("Shop checkout " + checkout.checkoutId + " authorization: " + authorized.error)
    }
    const result = refreshAttempt(shop, checkout.checkoutId, "none")
    return remember(replay, checkout, view(reload(reached), Object.assign({returnKey}, result)))
}

// ===== the steps (run#Step, each in its own transaction) =====
// freeze: under the order's and the checkout's locks, every price, line, quote, tax, promotion limit and the terms checked
// again; a change is recorded (the cart repriced, the quote applied, the checkout reviewRequired) and answered, else the
// snapshot is bound to the frozen revision and committed with the payment and its attempt (nothing due: no payment).
function freeze(p) {
    const checkout = checkoutRow(p.checkoutId, true)
    const order = find("mantle.order.OrderHeader", {orderId: checkout.orderId}).forUpdate(true).one()
    if (!editableStatuses.includes(checkout.statusId)) return {paymentId: checkout.paymentId || null, already: true}
    const shop = Object.assign(shopOf({siteId: p.siteId}), {
        customerPartyId: checkout.accountCheckout === "Y" ? checkout.customerPartyId : null
    })
    const currency = checkout.currencyUomId
    const part = partOf(order.orderId)
    const changes = []
    const shown = amount => moneyText(amount, currency)
    // lines: still public and purchasable, at the authority's price now (a changed one repriced on its line)
    const lines = carts().productLines(order.orderId)
    const offers = catalog().offersOf(
        shop,
        lines.map(line => ({productId: line.productId, quantity: Number(String(line.quantity))}))
    )
    lines.forEach((line, index) => {
        const offer = offers[index]
        const name = offer.card?.name || line.itemDescription || line.productId
        if (!offer.available) changes.push({kind: "unavailable", name})
        else if (!offer.unit.eq(dec(line.unitAmount))) {
            changes.push({kind: "price", name, before: shown(line.unitAmount), after: shown(offer.unit)})
            call("mantle.order.OrderServices.update#OrderItem", {
                orderId: line.orderId,
                orderItemSeqId: line.orderItemSeqId,
                unitAmount: offer.unit
            })
        }
    })
    // promotion limits, counted under a lock (impl-commerce P7)
    const limited = call("mantle.product.StorePromotionServices.check#OrderPromotionLimits", {orderId: order.orderId, lock: true})
    if (!limited.withinLimits)
        for (const limit of Array.from(limited.exceeded || []))
            changes.push({kind: "promotionLimit", name: limit.label || "in your cart"})
    // delivery: the fresh quote of the chosen method, applied when it differs; gone, the choice is cleared
    if (p.quoteNeeded) {
        const before = shippingTotal(order.orderId)
        if (!p.quote) {
            changes.push({kind: "quoteExpired"})
            call("update#" + C, {
                checkoutId: checkout.checkoutId,
                carrierPartyId: null,
                shipmentMethodEnumId: null,
                quoteRevision: null
            })
        } else if (!dec(p.quote.amount).eq(before) || changes.some(change => change.kind === "price")) {
            applyQuote(
                checkout,
                {part, row: {orderId: order.orderId}},
                {
                    carrierPartyId: p.quote.carrierPartyId,
                    shipmentMethodEnumId: p.quote.shipmentMethodEnumId
                }
            )
            const after = shippingTotal(order.orderId)
            if (!after.eq(before)) changes.push({kind: "delivery", before: shown(before), after: shown(after)})
        }
    }
    // tax for what is in the order now
    const taxBefore = taxTotal(order.orderId)
    retax(order.orderId)
    const taxAfter = taxTotal(order.orderId)
    if (!taxAfter.eq(taxBefore)) changes.push({kind: "tax", before: shown(taxBefore), after: shown(taxAfter)})
    // the terms the shopper accepted are the ones in effect
    const terms = policyOf(checkout).termsRequired === "false" ? null : termsOf(shop)
    if (terms && terms.version !== text(p.termsVersion)) changes.push({kind: "terms"})
    if (changes.length) {
        call("update#" + C, {
            checkoutId: checkout.checkoutId,
            statusId: "ScoReviewRequired",
            reviewJson: JSON.stringify(changes.map(change => Object.assign({}, change, {text: changeTexts[change.kind](change)})))
        })
        return {reviewRequired: true, changes: changes.length}
    }
    const fresh = orderOf(order.orderId)
    const due = grandTotal(order.orderId)
    const snapshot = {
        orderId: order.orderId,
        revision: carts().revisionOf(fresh),
        currencyUomId: currency,
        lines: itemsOf(order.orderId)
            .sort((a, b) => String(a.orderItemSeqId).localeCompare(String(b.orderItemSeqId)))
            .map(item => ({
                orderItemSeqId: item.orderItemSeqId,
                parentItemSeqId: item.parentItemSeqId || null,
                itemTypeEnumId: item.itemTypeEnumId,
                productId: item.productId || null,
                quantity: String(dec(item.quantity ?? 1).toNumber()),
                unitAmount: dec(item.unitAmount).toString()
            })),
        carrierPartyId: checkout.carrierPartyId || null,
        shipmentMethodEnumId: checkout.shipmentMethodEnumId || null,
        shippingContactMechId: checkout.shippingContactMechId || null,
        total: due.toString(),
        termsVersion: terms ? terms.version : null
    }
    const snapshotHash = lib.hash(snapshot)
    const values = {
        checkoutId: checkout.checkoutId,
        frozenRevision: snapshot.revision,
        snapshotJson: JSON.stringify(snapshot),
        snapshotHash,
        frozenDate: ec.user.nowTimestamp,
        dueAmount: due,
        termsSitePageId: terms ? terms.sitePageId : null,
        termsVersion: terms ? terms.version : null,
        termsAcceptedDate: terms ? ec.user.nowTimestamp : null,
        reviewJson: null,
        failureCode: null,
        failureMessage: null,
        returnKeyDigest: p.returnKeyDigest
    }
    if (due.compare(0) <= 0) {
        // nothing due: no gateway, placement next
        call("update#" + C, Object.assign(values, {statusId: "ScoPlacementPending", paymentId: null}))
        return {paymentId: null}
    }
    const paymentId = call("mantle.order.OrderServices.add#OrderPartPayment", {
        orderId: order.orderId,
        orderPartSeqId: part.orderPartSeqId,
        paymentInstrumentEnumId: checkout.paymentInstrumentEnumId,
        paymentGatewayConfigId: checkout.paymentGatewayConfigId,
        amount: due,
        statusId: "PmntPromised",
        effectiveDate: ec.user.nowTimestamp,
        comments: "Shop checkout " + checkout.checkoutId
    }).paymentId
    attempts().create({
        purpose: "shopCheckout",
        paymentId,
        orderId: order.orderId,
        checkoutId: checkout.checkoutId,
        productStoreId: checkout.productStoreId,
        siteId: checkout.siteId,
        contactPartyId: checkout.customerPartyId,
        returnKeyDigest: p.returnKeyDigest,
        snapshotHash
    })
    call("update#" + C, Object.assign(values, {statusId: "ScoPaymentPending", paymentId}))
    return {paymentId}
}
// The canonical return address of a checkout: the site's canonical host and Shop mount (never a caller's origin), with
// its reference and key.
const returnUrl = (checkout, returnKey) =>
    publicApps().pageUrl(
        checkout.siteId,
        "shop",
        "/Checkout/return?ref=" + encodeURIComponent(checkout.returnReference) + "&key=" + encodeURIComponent(returnKey)
    )
// authorize: the attempt's payment authorized through authorize#SinglePayment with its operation key (a retry answers the
// first gateway response) and the return address; the transaction holds the payment only.
function authorizeStep(p) {
    const checkout = checkoutRow(p.checkoutId)
    if (!checkout?.paymentId || checkout.statusId !== "ScoPaymentPending") return {}
    const paymentId = checkout.paymentId
    find(P, {paymentId}).forUpdate(true).one()
    const auth = attempts().asAttempt(paymentId, () =>
        call("mantle.account.PaymentServices.authorize#SinglePayment", {
            paymentId,
            operationKey: "shop-auth-" + paymentId,
            returnUrl: returnUrl(checkout, p.returnKey)
        })
    )
    attempts().record(paymentId, "pending")
    // the authorization counts as the attempt's first look at the provider: a page right after the submit shows it pending
    // with the provider's page, and looks it up only after a pause (limits.lookupEveryMs)
    lib.call("update#mantle.account.payment.PortalPaymentAttempt", {paymentId, lastCheckDate: ec.user.nowTimestamp})
    return {paymentGatewayResponseId: auth.paymentGatewayResponseId || null}
}
// apply: what the payment's state means for the checkout, under its lock: approved, the placement intent (committed
// before place#Order); declined, cancelled or failed, the checkout open to change again (a new attempt is a new payment,
// as the outcome is known); pending or unknown, nothing.
function applyStep(p) {
    const checkout = checkoutRow(p.checkoutId, true)
    if (!checkout || checkout.statusId !== "ScoPaymentPending" || !checkout.paymentId) return {statusId: checkout?.statusId}
    const payment = one(P, {paymentId: checkout.paymentId})
    const state = attempts().stateOf(payment)
    if (state === "approved") {
        attempts().record(payment.paymentId, "authorized", "approved")
        call("update#" + C, {
            checkoutId: checkout.checkoutId,
            statusId: "ScoPlacementPending",
            placementIntentDate: ec.user.nowTimestamp
        })
        return {statusId: "ScoPlacementPending"}
    }
    if (["declined", "cancelled", "failed"].includes(state)) {
        if (payment.statusId === "PmntPromised") call("update#" + P, {paymentId: payment.paymentId, statusId: "PmntCancelled"})
        attempts().record(payment.paymentId, "failed", state)
        call("update#" + C, {checkoutId: checkout.checkoutId, statusId: "ScoReady", failureCode: state.toUpperCase()})
        return {statusId: "ScoReady"}
    }
    return {statusId: checkout.statusId}
}
// place: once (the intent is committed): an order already placed (a crash after place#Order) is taken as placed;
// else place#Order. Its success completes the checkout, retires the cart's access and records the attempt placed;
// an amount that differs from what the provider took holds the order (OhtPayment).
const placedStatuses = ["OrderPlaced", "OrderProcessing", "OrderApproved", "OrderSent", "OrderCompleted", "OrderHold"]
function placeStep(p) {
    const checkout = checkoutRow(p.checkoutId, true)
    if (!checkout || checkout.statusId !== "ScoPlacementPending") return {statusId: checkout?.statusId}
    const order = orderOf(checkout.orderId)
    if (!placedStatuses.includes(order.statusId)) {
        if (!checkout.placementIntentDate)
            call("update#" + C, {checkoutId: checkout.checkoutId, placementIntentDate: ec.user.nowTimestamp})
        attempts().asAttempt(checkout.paymentId, () => call("mantle.order.OrderServices.place#Order", {orderId: order.orderId}))
    }
    call("update#" + C, {
        checkoutId: checkout.checkoutId,
        statusId: "ScoCompleted",
        placedDate: orderOf(order.orderId).placedDate || ec.user.nowTimestamp,
        completedDate: ec.user.nowTimestamp,
        failureCode: null,
        failureMessage: null
    })
    const cartRow = one(A, {cartAccessId: checkout.cartAccessId})
    if (cartRow && !cartRow.revokedDate)
        call("update#" + A, {
            cartAccessId: cartRow.cartAccessId,
            revokedDate: ec.user.nowTimestamp,
            revokeReasonEnumId: "ScrPlaced"
        })
    if (checkout.paymentId) {
        attempts().record(checkout.paymentId, "placed")
        const mismatch = amountMismatch(checkout)
        if (mismatch) holdPayment(checkout.orderId, checkout.paymentId, mismatch)
    }
    return {statusId: "ScoCompleted"}
}
// A placement that failed (its transaction rolled back): the reason kept on the checkout, the payment and attempt untouched.
function placementFailedStep(p) {
    const checkout = checkoutRow(p.checkoutId, true)
    if (!checkout || checkout.statusId !== "ScoPlacementPending") return {}
    call("update#" + C, {
        checkoutId: checkout.checkoutId,
        placementTries: Number(checkout.placementTries || 0) + 1,
        failureCode: /^([A-Z][A-Z0-9_]+):/.exec(text(p.message))?.[1] || "PLACEMENT_FAILED",
        failureMessage: text(p.message).slice(0, 255)
    })
    return {}
}
// The provider's amount of an approved payment, when its lookup reported one that differs from the payment's.
function amountMismatch(checkout) {
    const payment = one(P, {paymentId: checkout.paymentId})
    const reported = Array.from(
        find(R, {paymentId: checkout.paymentId})
            .condition("paymentOperationEnumId", "in", ["PgoTxDetails", "PgoAuthorize", "PgoAuthAndCapture"])
            .condition("resultSuccess", "Y")
            .orderBy("-transactionDate")
            .orderBy("-paymentGatewayResponseId")
            .limit(1)
            .list()
    )[0]
    if (!reported || reported.amount == null || dec(reported.amount).eq(dec(payment.amount))) return null
    return (
        "The provider took " +
        moneyText(reported.amount, payment.amountUomId) +
        " for a payment of " +
        moneyText(payment.amount, payment.amountUomId)
    )
}
// The order held for a payment exception after placement (OhtPayment, released by PAYMENT_HOLD_RELEASE).
function holdPayment(orderId, paymentId, comment) {
    call("mantle.order.OrderServices.hold#Order", {
        orderId,
        holdTypeEnumId: "OhtPayment",
        sourceId: paymentId,
        holdComment: comment
    })
}

// ===== the attempt's refresh =====
// The attempt asked of its provider (mode page: at most every few seconds for a page's polling; job: when it is due; none:
// not at all, right after the submit sent the payer to the provider), its outcome applied, and placement once it is
// approved; each step its own transaction. {statusId}.
function refreshAttempt(shop, checkoutId, mode) {
    let checkout = checkoutRow(checkoutId)
    if (checkout.statusId === "ScoPaymentPending" && checkout.paymentId) {
        const row = attempts().attemptOf(checkout.paymentId)
        const payment = one(P, {paymentId: checkout.paymentId})
        // a page's reads are at most every lookupEveryMs (the authorization counts as the first); the provider's return
        // (the reference and key) looks up at once the first time
        const throttled = mode === "page" || (mode === "return" && Number(row?.checkCount || 0) > 0)
        const recently = throttled && row?.lastCheckDate && nowMs() - ms(row.lastCheckDate) < limits.lookupEveryMs
        const state = attempts().stateOf(payment)
        if (mode !== "none" && ["pending", "unknown"].includes(state) && !recently) {
            attempts().lookup(checkout.paymentId)
            step("checked", {paymentId: checkout.paymentId})
        }
        step("apply", {checkoutId})
        checkout = checkoutRow(checkoutId)
        if (checkout.statusId === "ScoPlacementPending" && checkout.savePaymentMethod === "Y") saveMethod(checkout)
    }
    if (checkout.statusId === "ScoPlacementPending" && Number(checkout.placementTries || 0) < limits.placementTries) {
        const placed = step("place", {checkoutId})
        if (placed.error) {
            ec.logger.warn("Shop checkout " + checkoutId + " placement failed: " + String(placed.error).split("\n")[0])
            step("placementFailed", {
                checkoutId,
                message: String(placed.error)
                    .split("\n")[0]
                    .replace(/^(?:Error: )+/, "")
            })
        }
        checkout = checkoutRow(checkoutId)
    }
    return {statusId: checkout.statusId}
}

// The card a signed-in buyer asked to keep, saved after its approved payment through the gateway's hosted profile service
// (F40); a failure is logged and never stops the order.
function saveMethod(checkout) {
    const payment = one(P, {paymentId: checkout.paymentId})
    const config =
        payment && one("mantle.account.method.PaymentGatewayConfig", {paymentGatewayConfigId: payment.paymentGatewayConfigId})
    const of = config ? settings().gatewayCapabilities[config.paymentGatewayTypeEnumId] : null
    const service = of ? of(config).hostedProfileService : null
    if (!service || payment.paymentMethodId) return
    try {
        lib.probe(service, {paymentId: payment.paymentId})
    } catch (error) {
        ec.logger.warn("Shop checkout " + checkout.checkoutId + " card not kept: " + String(error.message).split("\n")[0])
    }
}

// ===== operations: the payment's result, its form, the confirmation =====
// get#CheckoutPaymentResult: the attempt's outcome, looked up at the provider while pending (bounded: at most every few
// seconds), and the placement once approved. Reached by the cart, the reference and key, or a placed cart's capability;
// what the browser brings back from the provider is never read.
function getCheckoutPaymentResult(p) {
    const reached = reach(p)
    // the provider's return (returned: the payer came back from its page) looks the payment up at once the first time
    refreshAttempt(reached.shop, reached.checkout.checkoutId, p.returned === true || p.returned === "true" ? "return" : "page")
    return view(reload(reached))
}
// get#CheckoutPaymentForm: a fresh hosted payment form for a pending attempt whose provider page takes a posted token
// (Authorize.Net Accept Hosted, F37): the provider's form address and token, asked of the gateway on each call; the token
// is never stored. The relay posts it at once.
function getCheckoutPaymentForm(p) {
    const reached = reach(p)
    const checkout = reached.checkout
    if (checkout.statusId !== "ScoPaymentPending" || !checkout.paymentId) notAvailable()
    const payment = one(P, {paymentId: checkout.paymentId})
    if (attempts().stateOf(payment) !== "pending" || !attempts().providerAction(payment.paymentId)?.form) notAvailable()
    const config = one("mantle.account.method.PaymentGatewayConfig", {paymentGatewayConfigId: payment.paymentGatewayConfigId})
    const of = config ? settings().gatewayCapabilities[config.paymentGatewayTypeEnumId] : null
    const service = of ? of(config).hostedFormService : null
    if (!service) notAvailable()
    const key = text(p.key)
    if (!key) notAvailable()
    let out
    try {
        out = lib.probe(service, {
            paymentId: payment.paymentId,
            returnUrl: returnUrl(checkout, key),
            cancelUrl: returnUrl(checkout, key) + "&cancelled=true",
            merchantName: reached.shop.store.storeName || null
        })
    } catch (error) {
        ec.logger.warn("Shop checkout " + checkout.checkoutId + " payment form: " + String(error.message).split("\n")[0])
        refuse("Unavailable", "PROVIDER_UNAVAILABLE", "The payment page cannot be opened now. Try again in a moment")
    }
    if (!out.formUrl || !out.token) refuse("Unavailable", "PROVIDER_UNAVAILABLE", "The payment page cannot be opened now")
    return {formUrl: out.formUrl, fields: {token: out.token}}
}
// get#OrderConfirmation: a completed checkout's order (after authoritative placement only; a pending payment is the
// result page's), reached by the reference and key, a placed cart's capability, the signed-in customer, or the guest's
// SalesOrder OrderView capability (orderToken). A guest reaching it the first time by the checkout gets that capability
// once (orderToken), the base of the guest's order link. The QR is of the signed-in order page, never a bearer token.
function getOrderConfirmation(p) {
    const shop = shopOf(p)
    let checkout = null
    let via = null
    if (text(p.orderToken)) {
        const checked = externalAccess().check({
            token: text(p.orderToken),
            scope: "OrderView",
            recordType: "SalesOrder",
            organizationPartyId: shop.store.organizationPartyId
        })
        checkout = one(C, {orderId: checked.recordId})
        via = "orderToken"
        if (!checkout || checkout.siteId !== shop.siteId) notAvailable()
    } else {
        const reached = reach(p)
        checkout = reached.checkout
        via = reached.via
        if (reached.via === "cart" && checkout.statusId !== "ScoCompleted") notAvailable()
    }
    if (checkout.statusId !== "ScoCompleted") notAvailable()
    const order = orderOf(checkout.orderId)
    const part = partOf(checkout.orderId)
    let orderToken = null
    if (checkout.accountCheckout !== "Y" && !checkout.orderCapabilityId && via !== "orderToken") {
        const created = externalAccess().create({
            recordType: "SalesOrder",
            recordId: order.orderId,
            scopes: "OrderView",
            validDays: limits.orderLinkDays,
            issuerKind: "organization"
        })
        call("update#" + C, {checkoutId: checkout.checkoutId, orderCapabilityId: created.capabilityId})
        orderToken = created.token
    }
    const payment = checkout.paymentId ? one(P, {paymentId: checkout.paymentId}) : null
    const currency = checkout.currencyUomId
    const lines = carts()
        .productLines(order.orderId)
        .map(line => ({
            name: line.itemDescription || line.productId,
            quantity: String(dec(line.quantity).toNumber()),
            total: money(amountOf(line), currency)
        }))
    const orderUrl = publicApps().pageUrl(checkout.siteId, "shop", "/Orders/" + encodeURIComponent(order.orderId))
    const held = rows("mantle.order.OrderHoldReason", {orderId: order.orderId}).some(row => !row.releasedDate)
    return Object.assign(
        {
            confirmation: {
                orderId: order.orderId,
                reference: checkout.returnReference,
                placedDate: lib.dateText(order.placedDate),
                statusText: held ? "Received, being reviewed" : "Received",
                lines,
                totals: {
                    items: money(
                        lines.reduce((total, line) => total.add(dec(line.total.amount)), dec(0)),
                        currency
                    ),
                    shipping: physical(order.orderId) ? money(shippingTotal(order.orderId), currency) : null,
                    tax: money(taxTotal(order.orderId), currency),
                    total: money(order.grandTotal ?? checkout.dueAmount ?? 0, currency)
                },
                payment: payment
                    ? {
                          state: ["PmntDelivered", "PmntConfirmed"].includes(payment.statusId) ? "paid" : "authorized",
                          text: ["PmntDelivered", "PmntConfirmed"].includes(payment.statusId)
                              ? "Paid " + moneyText(payment.amount, payment.amountUomId)
                              : "Payment of " + moneyText(payment.amount, payment.amountUomId) + " approved",
                          reference: payment.paymentRefNum ? String(payment.paymentRefNum).slice(-8) : null
                      }
                    : {state: "none", text: "Nothing to pay", reference: null},
                delivery: physical(order.orderId)
                    ? {method: enumText(part.shipmentMethodEnumId), address: addressText(part.postalContactMechId)?.text || ""}
                    : null,
                contactEmail: checkout.contactEmail,
                // the signed-in order page (P6), for the QR; never a bearer token
                orderUrl,
                guest: checkout.accountCheckout !== "Y",
                nextActions: checkout.accountCheckout === "Y" ? ["orders"] : ["createAccount"]
            }
        },
        orderToken ? {orderToken} : {}
    )
}

// ===== jobs =====
// reconcile#Checkouts (reconcile_StoreCheckouts): the Shop checkout attempts due for a lookup, oldest first, and the
// checkouts waiting for placement, each in its own transactions; one that fails is named and the rest go on.
function reconcileCheckouts(p) {
    const limit = Number(p.limit || limits.reconcileBatch)
    let checked = 0,
        resolved = 0,
        failed = 0
    const ids = attempts()
        .due("shopCheckout", limit)
        .map(row => row.checkoutId)
        .filter(Boolean)
    const placing = Array.from(
        find(C, {statusId: "ScoPlacementPending"})
            .condition("placementTries", "less", limits.placementTries)
            .orderBy("frozenDate")
            .limit(limit)
            .list()
    )
        .concat(
            Array.from(
                find(C, {statusId: "ScoPlacementPending"}).condition("placementTries", "is-null", null).limit(limit).list()
            )
        )
        .map(row => row.checkoutId)
    for (const checkoutId of Array.from(new Set(ids.concat(placing)))) {
        checked++
        try {
            const checkout = checkoutRow(checkoutId)
            const shop = {siteId: checkout.siteId}
            const before = checkout.statusId
            const out = refreshAttempt(shop, checkoutId, "job")
            if (out.statusId !== before) resolved++
        } catch (error) {
            ec.message.clearErrors()
            failed++
            ec.logger.error("Shop checkout " + checkoutId + " was not reconciled: " + String(error.message).split("\n")[0])
        }
    }
    return {checked, resolved, failed}
}
// expire#Checkouts (expire_StoreCheckouts): checkouts never submitted past their expiry; a submitted one never expires
// here (its attempt is the reconciliation's).
function expireCheckouts(p) {
    const due = Array.from(
        find(C)
            .condition("statusId", "in", editableStatuses)
            .condition("expireDate", "less", ec.user.nowTimestamp)
            .limit(Number(p.limit || 500))
            .list()
    )
    let expired = 0
    for (const row of due) {
        const out = step("expire", {checkoutId: row.checkoutId})
        if (out.error)
            ec.logger.error("Shop checkout " + row.checkoutId + " was not expired: " + String(out.error).split("\n")[0])
        else expired++
    }
    return {expired}
}
function expireStep(p) {
    const checkout = checkoutRow(p.checkoutId, true)
    if (checkout && editableStatuses.includes(checkout.statusId))
        call("update#" + C, {checkoutId: checkout.checkoutId, statusId: "ScoExpired"})
    return {}
}
// check#CaptureOutcome (a SECA on capture#SinglePayment): a capture of a Shop checkout's payment that did not succeed,
// after the order was placed, holds the order (OhtPayment). A capture still pending or unknown is the reconciliation's.
function checkCaptureOutcome(p) {
    const row = p.paymentId ? attempts().attemptOf(p.paymentId) : null
    if (!row || !attempts().ofPurpose(row, "shopCheckout") || !row.orderId) return {}
    const response = p.paymentGatewayResponseId ? one(R, {paymentGatewayResponseId: p.paymentGatewayResponseId}) : null
    if (!response || response.paymentOperationEnumId !== "PgoCapture" || response.resultSuccess === "Y") return {}
    if (response.resultUnknown === "Y" || ![response.resultDeclined, response.resultError, response.resultNsf].includes("Y"))
        return {}
    const order = orderOf(row.orderId)
    if (!placedStatuses.includes(order?.statusId)) return {}
    holdPayment(
        row.orderId,
        p.paymentId,
        "The capture of payment " + p.paymentId + " failed: " + text(response.reasonMessage || response.reasonCode).slice(0, 200)
    )
    return {held: true}
}

const steps = {
    freeze,
    authorize: authorizeStep,
    apply: applyStep,
    place: placeStep,
    placementFailed: placementFailedStep,
    checked: p => attempts().checked(p.paymentId) || {},
    expire: expireStep
}
const operations = {
    beginCheckout,
    getCheckout,
    resumeCheckout,
    setCheckoutContact,
    setCheckoutAddresses,
    getDeliveryOptions,
    selectDelivery,
    getPaymentOptions,
    selectPayment,
    submitCheckout,
    getCheckoutPaymentResult,
    getCheckoutPaymentForm,
    getOrderConfirmation,
    reconcileCheckouts,
    expireCheckouts,
    checkCaptureOutcome,
    runStep: p => {
        if (!steps[p.step]) throw new Error("Unknown Shop checkout step " + p.step)
        return steps[p.step](p) || {}
    }
}
;({
    limits,
    execute: (op, parameters) => {
        if (!operations[op]) throw new Error("Unknown Shop checkout operation " + op)
        return operations[op](parameters || {})
    }
})
