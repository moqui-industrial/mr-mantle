/* CC0 1.0 Universal plus Grant of Patent License. See LICENSE.md.
 * Shop's carts and the shopper's identity (mr-pass impl-shop P4; design-shop §4.2, §6 Cart, §7.1; SHOP-CART): a cart is
 * an ordinary open OrderHeader of the store a published site's Shop mount targets (ShopContext.js shopOf, from the site
 * the facade resolved), changed only through Mantle's order and promotion services; its StoreCartAccess row says who may
 * reach it.
 *
 * - Who: the presentation session's capability (a random token the frontend keeps in its server session and sends as
 *   input.token; only its digest is stored, with ExternalAccess.js's digest and lookup throttle, F16), or a signed-in
 *   account's own cart. An order id alone grants nothing: no operation takes one. A token of another site, store or
 *   currency, an expired or retired one, or one of a cart a different account attached reaches nothing.
 * - What a shopper sends: a product and its option, a quantity, a code, a line, the revision they saw and an operation id;
 *   never a price, customer, store, status or adjustment. Prices are the authority's (get#StoreProductPrice through
 *   ShopCatalog.js), set on each line as it is added or changed; promotions are Mantle's (add#/remove#OrderPromoCode and
 *   the order's own re-apply).
 * - The part always carries a customer party: the signed-in account's, else an anonymous guest party made with the cart,
 *   so the selling organization's sales commercial revision applies (impl-commerce F40, impl-shop F36); the revision is
 *   the order's own orderRevision, and a change that names an older one is refused (STALE_REVISION).
 * - A write with an operationId answers its first result again (PostingOperation, keyed by the cart and the id).
 * - Activity and expiry move on shopper actions only; reads do not touch them.
 * - Sign-in (attach#Cart) attaches the session's guest cart to the account, or merges it into the account's open cart of
 *   the same site, store and currency when neither has a payment in progress (lines re-added at today's prices, codes tried
 *   again, unavailable lines named, the guest cart retired and cancelled); the capability is rotated. Sign-out
 *   (release#Cart) rotates the account's carts' capabilities so the browser's session reaches none of them.
 * - Rate limits: cart creation, code tries and capability lookups, by requester.
 * Reads and writes are the authority's own (authorization disabled), after these checks.
 */
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const catalog = () => ec.resource.script("component://mr-mantle/service/mantle/product/ShopCatalog.js")
const externalAccess = () => ec.resource.script("component://mr-mantle/service/mantle/party/ExternalAccess.js")
const {find, one, rows, ms} = lib
const A = "mantle.order.StoreCartAccess"
const ITEM = "mantle.order.OrderItem"
const OPERATION = "mantle.ledger.transaction.PostingOperation"

// ===== tables =====
// Bounds: a line's quantity, lines a cart, days a cart lives after its last activity (a guest's and an account's), and
// the requester's limits a ten-minute window (carts made, codes tried, capability lookups).
const limits = {lineQuantity: 999, lines: 50, guestDays: 30, accountDays: 90, creates: 30, codeTries: 20, lookups: 600}
// Payment statuses that no longer hold a cart's checkout.
const settledPaymentStatuses = ["PmntVoid", "PmntCancelled", "PmntDeclined"]
const taxTypes = ["ItemSalesTax", "ItemVatTax"]
const DAY_MS = 86400000

// ===== values =====
const text = value => (value == null ? "" : String(value).trim())
const nowMs = () => ms(ec.user.nowTimestamp)
const dec = value => toDecimal(value == null || value === "" ? 0 : value)
const quantityText = value => String(Number(String(value ?? 0)))
function refuse(kind, code, message, field) {
    const error = new Error(code + (field ? "[" + field + "]" : "") + ": " + message)
    error.moquiErrorKind = kind
    throw error
}
const notAvailable = () => refuse("NotFound", "NOT_AVAILABLE", "This cart is not available")
const digest = token => externalAccess().tokenDigest(token)
const newToken = () => ec.user.randomString(48)
const days = count => new Date(nowMs() + count * DAY_MS)

// ===== the shop and the cart =====
// The shop of the facade's site (ShopCatalog.js shopOf: the published site, its Shop mount, the store, the signed-in
// account's party as customerPartyId) and the store's organization.
function shopOf(p) {
    const shop = catalog().shopOf(p)
    shop.organizationPartyId = shop.store.organizationPartyId
    return shop
}
const revisionOf = order => Number(order.orderRevision || 1)
function orderOpen(orderId) {
    const order = orderId ? one("mantle.order.OrderHeader", {orderId}) : null
    return order && order.statusId === "OrderOpen" ? order : null
}
// Whether an access row reaches a cart of this shop now: not retired or expired, the same site, store and currency, the
// order still open.
const usable = (shop, row) =>
    !!row &&
    !row.revokedDate &&
    (ms(row.expireDate) ?? 0) > shop.at &&
    row.siteId === shop.siteId &&
    row.productStoreId === shop.productStoreId &&
    row.currencyUomId === shop.currencyUomId &&
    !!orderOpen(row.orderId)
// The signed-in account's cart in this shop: its most recently active usable one.
function accountRow(shop, partyId) {
    return rows(A, {
        siteId: shop.siteId,
        productStoreId: shop.productStoreId,
        currencyUomId: shop.currencyUomId,
        customerPartyId: partyId
    })
        .filter(row => usable(shop, row))
        .sort((a, b) => (ms(b.lastActivityDate) ?? 0) - (ms(a.lastActivityDate) ?? 0))[0]
}
// The row a presented capability names, when it reaches this shop's cart for this visitor (a cart an account attached
// only for that account), counted against the requester's lookups first.
function tokenRow(shop, token) {
    const presented = text(token)
    if (!presented) return null
    externalAccess().throttle("cart-token", limits.lookups, "Wait a few minutes before opening your cart again")
    if (presented.length < 32 || presented.length > 128) return null
    const row = one(A, {capabilityDigest: digest(presented)})
    if (!usable(shop, row)) return null
    if (row.customerPartyId && row.customerPartyId !== shop.customerPartyId) return null
    return row
}
// The cart a call reaches: the session's capability's, else the signed-in account's own. {row, order, part} or null.
function cartOf(shop, token) {
    const row = tokenRow(shop, token) || (shop.customerPartyId ? accountRow(shop, shop.customerPartyId) : null)
    return row ? loaded(row) : null
}
function loaded(row) {
    const fresh = one(A, {cartAccessId: row.cartAccessId})
    const order = one("mantle.order.OrderHeader", {orderId: fresh.orderId})
    const part = find("mantle.order.OrderPart", {orderId: fresh.orderId}).orderBy("orderPartSeqId").list()[0]
    return {row: fresh, order, part}
}
const requireCart = (shop, token) => cartOf(shop, token) || notAvailable()
// A cart whose payment is in progress (a payment of the order not voided, cancelled or declined) is not changed or merged
// until its checkout is resolved (design-shop §7.1); P5: nor one whose checkout is submitted (its payment pending, or its
// placement under way, also with nothing to pay).
const submittedCheckoutStatuses = ["ScoPaymentPending", "ScoPlacementPending"]
const pendingCheckout = cart =>
    find("mantle.account.payment.Payment", {orderId: cart.row.orderId})
        .condition("statusId", "not-in", settledPaymentStatuses)
        .count() > 0 ||
    find("mantle.order.StoreCheckout", {cartAccessId: cart.row.cartAccessId})
        .condition("statusId", "in", submittedCheckoutStatuses)
        .count() > 0
function editable(cart) {
    // under the order's lock, so a checkout's freeze (which takes it) and this change come one after the other (Shop P5)
    find("mantle.order.OrderHeader", {orderId: cart.row.orderId}).forUpdate(true).one()
    if (pendingCheckout(cart))
        refuse("Conflict", "CHECKOUT_PENDING", "This cart has a payment in progress. Finish or cancel it first")
}
// The revision a change names must be the cart's (required for a change of what is in the cart, optional for an add).
function checkRevision(cart, expected, required) {
    if (expected == null || text(expected) === "") {
        if (required) refuse("Unprocessable", "VALUE_INVALID", "Reload your cart and try again", "expectedRevision")
        return
    }
    if (text(expected) !== String(revisionOf(cart.order)))
        refuse("Conflict", "STALE_REVISION", "Your cart changed in another window. Review it and try again")
}
// A shopper action: the cart's activity, and its expiry moved on.
function touch(cart) {
    lib.call("update#" + A, {
        cartAccessId: cart.row.cartAccessId,
        lastActivityDate: ec.user.nowTimestamp,
        // a new visit: cart recovery's mark of the last one cleared (Commerce F133)
        recoveryHandledDate: null,
        expireDate: days(cart.row.customerPartyId ? limits.accountDays : limits.guestDays)
    })
}
// A new cart of the shop: the signed-in account's party as its customer, else an anonymous guest party made for it; the
// order through create#Order (open, the store's web channel); the access row with a new capability. {cart, token}.
function createCart(shop) {
    externalAccess().throttle("cart-create", limits.creates, "Wait a few minutes before starting another cart")
    let guestPartyId = null
    if (!shop.customerPartyId) {
        guestPartyId = lib.call("create#mantle.party.Party", {partyTypeEnumId: "PtyPerson", disabled: "N"}).partyId
        lib.call("create#mantle.party.Person", {partyId: guestPartyId, firstName: "Guest"})
        lib.call("create#mantle.party.PartyRole", {partyId: guestPartyId, roleTypeId: "Customer"})
    }
    const order = lib.call("mantle.order.OrderServices.create#Order", {
        productStoreId: shop.productStoreId,
        currencyUomId: shop.currencyUomId,
        salesChannelEnumId: "ScWeb",
        vendorPartyId: shop.organizationPartyId,
        customerPartyId: shop.customerPartyId || guestPartyId
    })
    const token = newToken()
    const access = lib.call("create#" + A, {
        orderId: order.orderId,
        siteId: shop.siteId,
        appMountId: shop.mount.appMountId,
        productStoreId: shop.productStoreId,
        currencyUomId: shop.currencyUomId,
        customerPartyId: shop.customerPartyId || null,
        guestPartyId,
        capabilityDigest: digest(token),
        lastActivityDate: ec.user.nowTimestamp,
        expireDate: days(shop.customerPartyId ? limits.accountDays : limits.guestDays),
        createdDate: ec.user.nowTimestamp
    })
    return {cart: loaded({cartAccessId: access.cartAccessId}), token}
}
// A new capability for the cart (sign-in, sign-out): the old one reaches nothing. The new token, which the caller hands to
// the session or drops.
function rotate(row, extra) {
    const token = newToken()
    lib.call(
        "update#" + A,
        Object.assign({cartAccessId: row.cartAccessId, capabilityDigest: digest(token), rotatedDate: ec.user.nowTimestamp}, extra)
    )
    return token
}

// ===== lines =====
const productLines = orderId =>
    rows(ITEM, {orderId})
        .filter(item => item.productId && !item.parentItemSeqId && item.isPromo !== "Y" && item.itemTypeEnumId === "ItemProduct")
        .sort((a, b) => String(a.orderItemSeqId).localeCompare(String(b.orderItemSeqId)))
function lineOf(cart, orderItemSeqId) {
    const id = text(orderItemSeqId)
    const line = /^[A-Za-z0-9_-]{1,20}$/.test(id) ? productLines(cart.row.orderId).find(item => item.orderItemSeqId === id) : null
    if (!line) refuse("Unprocessable", "VALUE_INVALID", "This item is no longer in your cart", "orderItemSeqId")
    return line
}
function lineQuantityOf(value, allowZero) {
    const quantity = value == null || value === "" ? NaN : Number(value)
    if (!Number.isInteger(quantity) || quantity < (allowZero ? 0 : 1) || quantity > limits.lineQuantity)
        refuse("Unprocessable", "VALUE_INVALID", "Choose a quantity from 1 to " + limits.lineQuantity, "quantity")
    return quantity
}
const unavailable = (field, name) =>
    refuse("Unprocessable", "ITEM_UNAVAILABLE", (name || "This item") + " cannot be bought now", field)
// Reprice the cart's lines at the authority's price for this shopper (sign-in, a merge): a changed price is set on its
// line; an unavailable line keeps its price and is named. Answers the names of the unavailable lines.
function reprice(shop, cart) {
    const lines = productLines(cart.row.orderId)
    const offers = catalog().offersOf(
        shop,
        lines.map(line => ({productId: line.productId, quantity: Number(String(line.quantity))}))
    )
    const missing = []
    lines.forEach((line, index) => {
        const offer = offers[index]
        if (!offer.available) {
            missing.push(offer.card?.name || line.itemDescription || line.productId)
            return
        }
        if (!offer.unit.eq(dec(line.unitAmount)))
            lib.call("mantle.order.OrderServices.update#OrderItem", {
                orderId: line.orderId,
                orderItemSeqId: line.orderItemSeqId,
                unitAmount: offer.unit
            })
    })
    return missing
}

// ===== operation ids =====
// A write with an operationId: its key (the cart and the id), the normalized request's hash, and the first answer when
// it was already applied (a changed request with the same id is OPERATION_CONFLICT).
function replayOf(cart, operation, p, request) {
    const id = text(p.operationId)
    if (!id) return null
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(id)) refuse("Unprocessable", "VALUE_INVALID", "This request cannot be sent", "operationId")
    const operationKey = "SC" + ec.resource.digestText(cart.row.cartAccessId + ":" + id, "sha256").slice(0, 38)
    const requestHash = lib.hash(Object.assign({operation}, request))
    const old = one(OPERATION, {operationKey})
    if (old && (old.operationType !== "ShopCart" || old.requestHash !== requestHash))
        refuse("Conflict", "OPERATION_CONFLICT", "This request was already sent with other details")
    return {operationKey, requestHash, answer: old ? Object.assign(lib.json(old.resultJson, {}), {alreadyApplied: true}) : null}
}
function remember(replay, cart, result) {
    if (!replay) return result
    lib.call("create#" + OPERATION, {
        operationKey: replay.operationKey,
        operationType: "ShopCart",
        organizationPartyId: cart.order.vendorPartyId || null,
        userId: ec.user.userId || null,
        submittedDate: ec.user.nowTimestamp,
        completedDate: ec.user.nowTimestamp,
        requestHash: replay.requestHash,
        status: "complete",
        resultEntityName: "mantle.order.OrderHeader",
        resultId: cart.row.orderId,
        resultJson: JSON.stringify(result)
    })
    return result
}

// ===== the cart view =====
// CartView (design-shop §6 Cart; Contracts.d.ts): the lines with their options, link, quantity, unit price, adjustments,
// total and whether they can still be bought (a changed price named), the codes on the cart, the estimated totals (items,
// discounts, shipping and tax when the order has them, total), the item count, notices and the revision; and the
// mini-cart's summary. Decimal strings with display text; no party, price row, cost or internal id but the line's.
function view(shop, cart) {
    const currency = shop.currencyUomId
    const money = amount => catalog().money(amount, currency)
    if (!cart)
        return {
            cart: {
                revision: null,
                currencyUomId: currency,
                items: [],
                promoCodes: [],
                totals: {items: money(0), discounts: money(0), shipping: null, tax: null, total: money(0)},
                itemCount: 0,
                notices: [],
                empty: true
            },
            summary: {itemCount: 0, subtotal: money(0)}
        }
    const items = rows(ITEM, {orderId: cart.row.orderId})
    const lines = productLines(cart.row.orderId)
    const offers = catalog().offersOf(
        shop,
        lines.map(line => ({productId: line.productId, quantity: Number(String(line.quantity))}))
    )
    const childrenOf = parentId => items.filter(item => item.parentItemSeqId === parentId)
    const amountOf = item => dec(item.quantity ?? 1).multiply(dec(item.unitAmount))
    let itemsTotal = dec(0)
    let discounts = dec(0)
    let itemCount = 0
    const notices = []
    const views = lines.map((line, index) => {
        const offer = offers[index]
        const base = amountOf(line)
        const adjustments = childrenOf(line.orderItemSeqId).map(child => ({
            label: child.itemDescription || "Discount",
            amount: money(amountOf(child))
        }))
        const adjusted = childrenOf(line.orderItemSeqId).reduce((total, child) => total.add(amountOf(child)), dec(0))
        itemsTotal = itemsTotal.add(base)
        discounts = discounts.add(adjusted)
        itemCount += Number(String(line.quantity))
        const name = offer.card?.name || line.itemDescription || "Item"
        const priceChanged = !!(offer.available && offer.unit && !offer.unit.eq(dec(line.unitAmount)))
        if (!offer.available)
            notices.push({code: "itemUnavailable", text: name + " cannot be bought now. Remove it to check out."})
        else if (priceChanged)
            notices.push({code: "priceChanged", text: "The price of " + name + " is now " + offer.unitPrice.display + "."})
        return {
            orderItemSeqId: line.orderItemSeqId,
            productId: line.productId,
            name,
            options: offer.options || null,
            url: offer.url || null,
            sku: offer.card?.sku || null,
            quantity: quantityText(line.quantity),
            unitPrice: money(line.unitAmount),
            adjustments,
            total: money(base.add(adjusted)),
            available: !!offer.available,
            availability: offer.card ? {code: offer.card.availability.code, label: offer.card.availability.label} : null,
            priceChanged,
            currentPrice: priceChanged ? offer.unitPrice : null
        }
    })
    // adjustments of the whole order (a promotion with no line, shipping, tax)
    let shipping = null
    let tax = null
    for (const item of items.filter(item => !item.parentItemSeqId && item.itemTypeEnumId !== "ItemProduct")) {
        if (item.itemTypeEnumId === "ItemShipping") shipping = (shipping || dec(0)).add(amountOf(item))
        else if (taxTypes.includes(item.itemTypeEnumId)) tax = (tax || dec(0)).add(amountOf(item))
        else if (item.isPromo === "Y") discounts = discounts.add(amountOf(item))
    }
    const codes = rows("mantle.order.OrderPromoCode", {orderId: cart.row.orderId})
    const codeRows = codes.length
        ? Array.from(
              find("mantle.product.store.ProductStorePromoCode")
                  .condition(
                      "promoCodeId",
                      "in",
                      codes.map(code => code.promoCodeId)
                  )
                  .list()
          )
        : []
    const promotions = Object.fromEntries(
        (codeRows.length
            ? Array.from(
                  find("mantle.product.store.ProductStorePromotion")
                      .condition(
                          "storePromotionId",
                          "in",
                          codeRows.map(code => code.storePromotionId)
                      )
                      .list()
              )
            : []
        ).map(row => [row.storePromotionId, row])
    )
    // a code past a limit is refused at placement (impl-commerce P7): a preview without locks, named here
    try {
        const limited = lib.call("mantle.product.StorePromotionServices.check#OrderPromotionLimits", {
            orderId: cart.row.orderId,
            lock: false
        })
        if (!limited.withinLimits)
            notices.push({
                code: "promotionLimit",
                text: "A promotion in your cart has reached its limit and will not apply at checkout."
            })
    } catch (error) {
        ec.message.clearErrors()
        ec.logger.warn("Shop cart " + cart.row.cartAccessId + " promotion limits not read: " + error.message)
    }
    const total = itemsTotal
        .add(discounts)
        .add(shipping || dec(0))
        .add(tax || dec(0))
    return {
        cart: {
            revision: String(revisionOf(cart.order)),
            currencyUomId: currency,
            items: views,
            promoCodes: codeRows.map(code => ({
                code: code.promoCode || code.promoCodeId,
                label: promotions[code.storePromotionId]?.itemDescription || null
            })),
            totals: {
                items: money(itemsTotal),
                discounts: money(discounts),
                shipping: shipping ? money(shipping) : null,
                tax: tax ? money(tax) : null,
                total: money(total)
            },
            itemCount,
            notices,
            empty: !views.length,
            checkoutPending: pendingCheckout(cart)
        },
        summary: {itemCount, subtotal: money(itemsTotal.add(discounts))}
    }
}
const answer = (shop, cart, extra) => Object.assign(view(shop, cart && loaded(cart.row)), extra || {})

// ===== operations =====
// get#Cart: the session's cart (or the signed-in account's), or an empty one; nothing is changed.
function getCart(p) {
    const shop = shopOf(p)
    return answer(shop, cartOf(shop, p.token))
}
// add#CartItem: a product (or its listed option) and a quantity, added to the session's cart, made when there is none
// (its new capability in the answer's token). An item that cannot be bought now is ITEM_UNAVAILABLE.
function addCartItem(p) {
    const shop = shopOf(p)
    const quantity = lineQuantityOf(p.quantity == null || p.quantity === "" ? 1 : p.quantity)
    const selection = catalog().selectionOf(shop, p.productId, p.variantId)
    if (!selection.card.availability.purchasable) unavailable("productId", selection.card.name)
    let cart = cartOf(shop, p.token)
    let token = null
    let replay = null
    if (cart) {
        replay = replayOf(cart, "addCartItem", p, {productId: selection.productId, quantity})
        if (replay?.answer) return replay.answer
        checkRevision(cart, p.expectedRevision, false)
        editable(cart)
    }
    const existing = cart ? productLines(cart.row.orderId).find(line => line.productId === selection.productId) : null
    const total = quantity + (existing ? Number(String(existing.quantity)) : 0)
    if (total > limits.lineQuantity)
        refuse("Unprocessable", "VALUE_INVALID", "A cart holds up to " + limits.lineQuantity + " of an item", "quantity")
    if (cart && !existing && productLines(cart.row.orderId).length >= limits.lines)
        refuse("Unprocessable", "VALUE_INVALID", "A cart holds up to " + limits.lines + " items", "productId")
    const offer = catalog().offersOf(shop, [{productId: selection.productId, quantity: total}])[0]
    if (!offer.available) unavailable("productId", selection.card.name)
    if (!cart) ({cart, token} = createCart(shop))
    lib.call("mantle.order.OrderServices.add#OrderProductQuantity", {
        orderId: cart.row.orderId,
        orderPartSeqId: cart.part.orderPartSeqId,
        productId: selection.productId,
        quantity,
        unitAmount: offer.unit
    })
    touch(cart)
    const result = remember(replay, cart, answer(shop, cart))
    return token ? Object.assign({}, result, {token}) : result
}
// update#CartItem: a line's new quantity (0 removes it) at the authority's price for that quantity; a line that cannot be
// bought now may only be lowered or removed.
function updateCartItem(p) {
    const shop = shopOf(p)
    const cart = requireCart(shop, p.token)
    const quantity = lineQuantityOf(p.quantity, true)
    const replay = replayOf(cart, "updateCartItem", p, {orderItemSeqId: text(p.orderItemSeqId), quantity})
    if (replay?.answer) return replay.answer
    checkRevision(cart, p.expectedRevision, true)
    editable(cart)
    const line = lineOf(cart, p.orderItemSeqId)
    if (quantity === 0)
        lib.call("mantle.order.OrderServices.delete#OrderItem", {orderId: line.orderId, orderItemSeqId: line.orderItemSeqId})
    else {
        const offer = catalog().offersOf(shop, [{productId: line.productId, quantity}])[0]
        if (!offer.available && quantity > Number(String(line.quantity)))
            unavailable("quantity", offer.card?.name || line.itemDescription)
        lib.call("mantle.order.OrderServices.update#OrderItem", {
            orderId: line.orderId,
            orderItemSeqId: line.orderItemSeqId,
            quantity,
            unitAmount: offer.available ? offer.unit : line.unitAmount
        })
    }
    touch(cart)
    return remember(replay, cart, answer(shop, cart))
}
// remove#CartItem: a line out of the cart (reversible by adding it again while the cart is open).
function removeCartItem(p) {
    const shop = shopOf(p)
    const cart = requireCart(shop, p.token)
    const replay = replayOf(cart, "removeCartItem", p, {orderItemSeqId: text(p.orderItemSeqId)})
    if (replay?.answer) return replay.answer
    checkRevision(cart, p.expectedRevision, true)
    editable(cart)
    const line = lineOf(cart, p.orderItemSeqId)
    lib.call("mantle.order.OrderServices.delete#OrderItem", {orderId: line.orderId, orderItemSeqId: line.orderItemSeqId})
    touch(cart)
    return remember(replay, cart, answer(shop, cart))
}
const codeOf = value => {
    const code = text(value)
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(code))
        refuse("Unprocessable", "PROMO_CODE_INVALID", "This code cannot be used with this cart", "promoCode")
    return code
}
// The store's code of a shopper's text (ignoring case), or null: a code of another store is none.
function storeCodeOf(shop, code) {
    const found = Array.from(
        find("mantle.product.store.ProductStorePromoCode")
            .condition(ec.entity.conditionFactory.makeCondition("promoCode", "equals", code).ignoreCase())
            .list()
    ).concat(Array.from(find("mantle.product.store.ProductStorePromoCode", {promoCodeId: code}).list()))
    return (
        found.find(row => {
            const promotion = one("mantle.product.store.ProductStorePromotion", {storePromotionId: row.storePromotionId})
            return promotion && promotion.productStoreId === shop.productStoreId
        }) || null
    )
}
// apply#PromoCode: a code on the cart through add#OrderPromoCode, which checks its dates, customer and use limits and
// re-applies the promotions. Every refusal reads the same (PROMO_CODE_INVALID), with no hint of a customer or a limit.
function applyPromoCode(p) {
    const shop = shopOf(p)
    const cart = requireCart(shop, p.token)
    const code = codeOf(p.promoCode)
    const replay = replayOf(cart, "applyPromoCode", p, {promoCode: code.toUpperCase()})
    if (replay?.answer) return replay.answer
    checkRevision(cart, p.expectedRevision, true)
    editable(cart)
    externalAccess().throttle("cart-code", limits.codeTries, "Wait a few minutes before trying another code")
    const refused = () => refuse("Unprocessable", "PROMO_CODE_INVALID", "This code cannot be used with this cart", "promoCode")
    const storeCode = storeCodeOf(shop, code)
    if (!storeCode) refused()
    const on = () => !!one("mantle.order.OrderPromoCode", {orderId: cart.row.orderId, promoCodeId: storeCode.promoCodeId})
    if (!on()) {
        lib.call("mantle.product.PromotionServices.add#OrderPromoCode", {
            orderId: cart.row.orderId,
            promoCode: storeCode.promoCode
        })
        if (!on()) refused()
    }
    touch(cart)
    return remember(replay, cart, answer(shop, cart))
}
// remove#PromoCode: a code off the cart (remove#OrderPromoCode re-applies the promotions).
function removePromoCode(p) {
    const shop = shopOf(p)
    const cart = requireCart(shop, p.token)
    const code = codeOf(p.promoCode).toUpperCase()
    const replay = replayOf(cart, "removePromoCode", p, {promoCode: code})
    if (replay?.answer) return replay.answer
    checkRevision(cart, p.expectedRevision, true)
    editable(cart)
    const ids = rows("mantle.order.OrderPromoCode", {orderId: cart.row.orderId}).map(row => row.promoCodeId)
    const storeCode = ids.length
        ? Array.from(find("mantle.product.store.ProductStorePromoCode").condition("promoCodeId", "in", ids).list()).find(
              row => String(row.promoCode || row.promoCodeId).toUpperCase() === code
          )
        : null
    if (!storeCode) refuse("Unprocessable", "VALUE_INVALID", "This code is not on your cart", "promoCode")
    lib.call("mantle.product.PromotionServices.remove#OrderPromoCode", {
        orderId: cart.row.orderId,
        promoCodeId: storeCode.promoCodeId
    })
    touch(cart)
    return remember(replay, cart, answer(shop, cart))
}
// The guest cart's lines and codes re-added to the account's cart at the account's prices (lines that cannot be bought
// now are named and left out), then the guest cart retired (merged into the account's) and cancelled. Answers the names
// of the lines left out.
function merge(shop, from, into) {
    const missing = []
    const intoLines = productLines(into.row.orderId)
    for (const line of productLines(from.row.orderId)) {
        const existing = intoLines.find(item => item.productId === line.productId)
        const quantity = Math.min(
            Number(String(line.quantity)),
            limits.lineQuantity - (existing ? Number(String(existing.quantity)) : 0)
        )
        const total = quantity + (existing ? Number(String(existing.quantity)) : 0)
        const offer = quantity > 0 ? catalog().offersOf(shop, [{productId: line.productId, quantity: total}])[0] : null
        if (!offer || !offer.available) {
            missing.push(offer?.card?.name || line.itemDescription || line.productId)
            continue
        }
        lib.call("mantle.order.OrderServices.add#OrderProductQuantity", {
            orderId: into.row.orderId,
            orderPartSeqId: into.part.orderPartSeqId,
            productId: line.productId,
            quantity,
            unitAmount: offer.unit
        })
    }
    for (const code of rows("mantle.order.OrderPromoCode", {orderId: from.row.orderId})) {
        const storeCode = one("mantle.product.store.ProductStorePromoCode", {promoCodeId: code.promoCodeId})
        if (!storeCode || one("mantle.order.OrderPromoCode", {orderId: into.row.orderId, promoCodeId: code.promoCodeId})) continue
        try {
            lib.call("mantle.product.PromotionServices.add#OrderPromoCode", {
                orderId: into.row.orderId,
                promoCode: storeCode.promoCode
            })
        } catch (error) {
            ec.message.clearErrors()
            ec.logger.warn("Shop cart merge code " + code.promoCodeId + " not applied: " + error.message)
        }
    }
    lib.call("update#" + A, {
        cartAccessId: from.row.cartAccessId,
        revokedDate: ec.user.nowTimestamp,
        revokeReasonEnumId: "ScrMerged",
        mergedToCartAccessId: into.row.cartAccessId,
        capabilityDigest: digest(newToken())
    })
    lib.call("mantle.order.OrderServices.cancel#Order", {orderId: from.row.orderId})
    return missing
}
// attach#Cart (sign-in): the session's guest cart attached to the signed-in account (its part's customer the account's
// party), or merged into the account's open cart of this shop once (both proven: the session's capability and the
// sign-in), unless either has a payment in progress, when the session keeps its cart; the cart repriced for the account
// and its capability rotated (the new token in the answer). {cart, summary, token, attached, merged, unavailableItems}.
function attachCart(p) {
    const shop = shopOf(p)
    if (!shop.customerPartyId) refuse("AuthenticationRequired", "SIGN_IN_REQUIRED", "Sign in to continue")
    const sessionRow = tokenRow(shop, p.token)
    const session = sessionRow ? loaded(sessionRow) : null
    const ownRow = accountRow(shop, shop.customerPartyId)
    const own = ownRow ? loaded(ownRow) : null
    let target = null
    let merged = false
    let missing = []
    if (session && !session.row.customerPartyId && own && own.row.cartAccessId !== session.row.cartAccessId) {
        if (pendingCheckout(session) || pendingCheckout(own))
            return answer(shop, session, {
                token: null,
                attached: false,
                merged: false,
                checkoutPending: true,
                unavailableItems: []
            })
        missing = merge(shop, session, own)
        target = own
        merged = true
    } else if (session && !session.row.customerPartyId) {
        lib.call("update#mantle.order.OrderPart", {
            orderId: session.part.orderId,
            orderPartSeqId: session.part.orderPartSeqId,
            customerPartyId: shop.customerPartyId
        })
        lib.call("update#" + A, {cartAccessId: session.row.cartAccessId, customerPartyId: shop.customerPartyId})
        // the account's promotions (and the guest's that no longer apply) as the customer changed
        lib.call("mantle.order.OrderServices.handle#OrderMajorChange", {
            orderId: session.part.orderId,
            orderPartSeqId: session.part.orderPartSeqId
        })
        target = loaded(session.row)
    } else target = session || own
    if (!target) return answer(shop, null, {token: null, attached: false, merged: false, unavailableItems: []})
    missing = missing.concat(reprice(shop, target).filter(name => !missing.includes(name)))
    const token = rotate(target.row, {
        lastActivityDate: ec.user.nowTimestamp,
        recoveryHandledDate: null,
        expireDate: days(limits.accountDays)
    })
    return answer(shop, target, {token, attached: true, merged, unavailableItems: missing})
}
// release#Cart (sign-out): every open cart of the signed-in account in this shop gets a new capability that no one holds,
// so the browser's session, and anyone using the browser after, reaches none; the account reaches them again by signing in.
function releaseCart(p) {
    const shop = shopOf(p)
    if (!shop.customerPartyId) return {released: false}
    const own = rows(A, {siteId: shop.siteId, customerPartyId: shop.customerPartyId}).filter(row => usable(shop, row))
    for (const row of own) rotate(row)
    return {released: own.length > 0}
}

const operations = {
    getCart,
    addCartItem,
    updateCartItem,
    removeCartItem,
    applyPromoCode,
    removePromoCode,
    attachCart,
    releaseCart
}
;({
    limits,
    // P5: what Shop's checkout (ShopCheckout.js) reaches a cart by, and shows of it
    shopOf,
    cartOf,
    loaded,
    view,
    revisionOf,
    productLines,
    pendingCheckout,
    rotate,
    digest,
    // Commerce P10 (CartRecovery.js): the recovery link's cart repriced, its access rule, the shop's limits and throttle
    reprice,
    usable,
    answer,
    execute: (op, parameters) => {
        if (!operations[op]) throw new Error("Unknown Shop cart operation " + op)
        return operations[op](parameters || {})
    }
})
