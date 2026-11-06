/* CC0 1.0 Universal plus Grant of Patent License. See LICENSE.md.
 * Shop's customer account (mr-pass impl-shop P6; design-shop §9 AccountOverview, Addresses, PaymentMethods, Orders,
 * OrderDetail; §13.2's A; SHOP-ACCOUNT): the projections a buyer reads of their own purchases in the store a site's Shop
 * mount targets, and their own addresses and payment methods, over Mantle's order, contact and payment method services.
 *
 * - Who: a signed-in account through ExternalAccess's self relationship (its own party, its email verified), or a guest's
 *   order link (the SalesOrder OrderView capability: its one order, read only). Never a party id from the browser; an
 *   order id alone reaches nothing; another's order is NOT_AVAILABLE either way.
 * - One account (design-shop §4.2, §18.1): a verified account claims the guest purchases made with its verified email in
 *   this store (merge#Parties of each anonymous guest party into the account's party), so its orders, invoices in Billing,
 *   cases and returns in Support are its own; an unverified account claims nothing and sees none of them.
 * - Reorder rebuilds the order's still-offered lines in the session's cart at today's prices (Shop's cart path), never
 *   the historic price, discount or delivery.
 * - Payment methods are added through the store's gateway's hosted setup (the provider's page; the card never reaches this
 *   site) and listed masked; ending one names the recurring orders that use it, and needs confirming when there are any.
 * Reads and writes are the authority's own (authorization disabled), after these checks.
 */
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const externalAccess = () => ec.resource.script("component://mr-mantle/service/mantle/party/ExternalAccess.js")
const catalog = () => ec.resource.script("component://mr-mantle/service/mantle/product/ShopCatalog.js")
const carts = () => ec.resource.script("component://mr-mantle/service/mantle/order/ShopCart.js")
const settings = () => ec.resource.script("component://mr-mantle/service/mantle/product/StoreCheckout.js")
const publicApps = () => ec.resource.script("component://mr-mantle/service/mantle/public/PublicApps.js")
const {find, one, rows, call, ms} = lib
const C = "mantle.order.StoreCheckout"
const ORDER = "mantle.order.OrderHeader"
const PART = "mantle.order.OrderPart"
const ITEM = "mantle.order.OrderItem"
const PCM = "mantle.party.contact.PartyContactMech"
const OPERATION = "mantle.ledger.transaction.PostingOperation"

// ===== tables =====
const limits = {pageSize: 20, maxPageSize: 50, recent: 5, addresses: 50, methods: 50}
const hiddenOrderStatuses = ["OrderOpen", "OrderRequested", "OrderProposed"]
const cancellableStatuses = ["OrderPlaced", "OrderProcessing", "OrderApproved", "OrderHold"]
const physicalTypes = ["PtAsset", "PtDigitalAsset", "PtAssetUse", "PtPickAssembly"]
const taxTypes = ["ItemSalesTax", "ItemVatTax"]
const statusTexts = {
    OrderPlaced: "Received",
    OrderProcessing: "Received",
    OrderApproved: "Being prepared",
    OrderSent: "On its way",
    OrderCompleted: "Completed",
    OrderHold: "Received, being reviewed",
    OrderCancelled: "Cancelled",
    OrderRejected: "Not accepted"
}

// ===== values =====
const text = value => (value == null ? "" : String(value).trim())
const dec = value => toDecimal(value == null || value === "" ? 0 : value)
const yes = value => value === true || value === "true" || value === "Y"
function refuse(kind, code, message, field) {
    const error = new Error(code + (field ? "[" + field + "]" : "") + ": " + message)
    error.moquiErrorKind = kind
    throw error
}
const notAvailable = () => refuse("NotFound", "NOT_AVAILABLE", "This is not available")
const invalid = (field, message) => refuse("Unprocessable", "VALUE_INVALID", message, field)
const money = (amount, currencyUomId) => catalog().money(amount, currencyUomId)
const enumText = enumId => (enumId ? one("moqui.basic.Enumeration", {enumId})?.description || enumId : "")
const amountOf = item => dec(item.quantity ?? 1).multiply(dec(item.unitAmount))

// ===== who =====
const shopOf = p => catalog().shopOf(p)
// The signed-in account's party when the self relationship holds (its email verified, not working for an internal
// organization), else null.
function selfParty() {
    const partyId = ec.user.userId ? ec.user.userAccount?.partyId : null
    return partyId && externalAccess().selfOf(partyId) ? partyId : null
}
function requireSelf() {
    if (!ec.user.userId) refuse("AuthenticationRequired", "SIGN_IN_REQUIRED", "Sign in to see your account")
    const partyId = selfParty()
    if (!partyId) refuse("Unauthorized", "ACCESS_DENIED", "Verify your email address to see your purchases")
    return partyId
}
// The order a call reaches: the guest's order link's (its one order, on this site's store), else the verified account's own
// order of this store. {order, via, partyId}.
function orderReached(shop, p) {
    if (text(p.orderToken)) {
        const checked = externalAccess().check({
            token: text(p.orderToken),
            scope: "OrderView",
            recordType: "SalesOrder",
            organizationPartyId: shop.store.organizationPartyId
        })
        if (text(p.orderId) && text(p.orderId) !== checked.recordId) notAvailable()
        const order = one(ORDER, {orderId: checked.recordId})
        if (!order || order.productStoreId !== shop.productStoreId) notAvailable()
        return {order, via: "orderLink", partyId: checked.partyId, capabilityId: checked.capabilityId}
    }
    const partyId = requireSelf()
    const order = text(p.orderId) ? one(ORDER, {orderId: text(p.orderId)}) : null
    if (!order || !ownOrder(shop, order, partyId)) notAvailable()
    return {order, via: "self", partyId}
}
// An order of the store whose parts are all the party's, sold by the store's organization, placed (not a cart or a
// recurring base).
function ownOrder(shop, order, partyId) {
    if (!order || order.productStoreId !== shop.productStoreId || hiddenOrderStatuses.includes(order.statusId)) return false
    if (order.recurCronExpression) return false
    const parts = rows(PART, {orderId: order.orderId})
    return (
        parts.length > 0 &&
        parts.every(part => part.customerPartyId === partyId && part.vendorPartyId === shop.store.organizationPartyId)
    )
}

// ===== one account: the guest purchases of a verified email =====
// The completed guest checkouts of this store made with the account's verified email, whose guest party has no account of
// its own, merged into the account's party (merge#Parties, in a transaction of its own each). {claimed}.
function claimGuestPurchases(shop, partyId) {
    const account = ec.user.userAccount
    const email = text(account?.emailAddress).toLowerCase()
    if (!email || !partyId) return {claimed: 0}
    let claimed = 0
    // a guest's email is kept lower case (set#CheckoutContact)
    const guestCheckouts = rows(C, {
        productStoreId: shop.productStoreId,
        statusId: "ScoCompleted",
        accountCheckout: "N",
        contactEmail: email
    })
    for (const checkout of guestCheckouts) {
        if (checkout.customerPartyId === partyId) continue
        const guest = one("mantle.party.Party", {partyId: checkout.customerPartyId})
        if (!guest || guest.disabled === "Y" || guest.mergedToPartyId) continue
        if (!anonymousGuest(guest.partyId, checkout)) continue
        ec.message.pushErrors()
        try {
            ec.service
                .sync()
                .name("mantle.party.DuplicateServices.merge#Parties")
                .parameters({toPartyId: partyId, fromPartyId: guest.partyId})
                .disableAuthz()
                .requireNewTransaction(true)
                .call()
            if (ec.message.hasError()) throw new Error(ec.message.getErrorsString())
            claimed++
        } catch (error) {
            ec.logger.error(
                "Shop guest purchases of party " + guest.partyId + " not claimed: " + String(error.message).split("\n")[0]
            )
        } finally {
            ec.message.clearErrors()
            ec.message.popErrors()
        }
    }
    return {claimed}
}
// Whether a party is still only the anonymous guest of one Shop cart (Shop P6 review): the party its cart was made with, the
// only cart it has, with no account, no relationship, no role but Customer, and no order but that cart's. A party staff
// merged with a guest (a customer of the organization's own, another account's, a colleague's) is never claimed by email.
function anonymousGuest(guestPartyId, checkout) {
    const cart = one("mantle.order.StoreCartAccess", {cartAccessId: checkout.cartAccessId})
    if (!cart || cart.guestPartyId !== guestPartyId || cart.orderId !== checkout.orderId) return false
    if (find("mantle.order.StoreCartAccess", {guestPartyId}).count() !== 1) return false
    if (find("mantle.order.StoreCartAccess", {customerPartyId: guestPartyId}).count() > 0) return false
    if (find("moqui.security.UserAccount", {partyId: guestPartyId}).count() > 0) return false
    if (rows("mantle.party.PartyRole", {partyId: guestPartyId}).some(row => row.roleTypeId !== "Customer")) return false
    if (find("mantle.party.PartyRelationship", {fromPartyId: guestPartyId}).count() > 0) return false
    if (find("mantle.party.PartyRelationship", {toPartyId: guestPartyId}).count() > 0) return false
    return rows(PART, {customerPartyId: guestPartyId}).every(part => part.orderId === checkout.orderId)
}

// ===== order projections =====
function ordersOf(shop, partyId) {
    const ids = [
        ...new Set(rows(PART, {customerPartyId: partyId, vendorPartyId: shop.store.organizationPartyId}).map(row => row.orderId))
    ]
    if (!ids.length) return []
    return Array.from(
        find(ORDER)
            .condition("orderId", "in", ids)
            .condition("productStoreId", shop.productStoreId)
            .condition("statusId", "not-in", hiddenOrderStatuses)
            .condition("recurCronExpression", "is-null", null)
            .orderBy("-placedDate")
            .orderBy("-orderId")
            .limit(500)
            .list()
    ).filter(order => ownOrder(shop, order, partyId))
}
const statusText = order =>
    rows("mantle.order.OrderHoldReason", {orderId: order.orderId}).some(row => !row.releasedDate)
        ? statusTexts.OrderHold
        : statusTexts[order.statusId] || enumText(order.statusId)
function orderRow(order) {
    return {
        orderId: order.orderId,
        placedText: lib.dateText(order.placedDate || order.entryDate),
        statusText: statusText(order),
        total: money(order.grandTotal ?? 0, order.currencyUomId),
        itemCount: rows(ITEM, {orderId: order.orderId}).filter(
            item => item.itemTypeEnumId === "ItemProduct" && !item.parentItemSeqId
        ).length
    }
}
const productLines = orderId =>
    rows(ITEM, {orderId})
        .filter(item => item.productId && !item.parentItemSeqId && item.isPromo !== "Y" && item.itemTypeEnumId === "ItemProduct")
        .sort((a, b) => String(a.orderItemSeqId).localeCompare(String(b.orderItemSeqId)))
const productOf = productId => (productId ? one("mantle.product.Product", {productId}) : null)
function addressText(contactMechId) {
    const address = contactMechId ? one("mantle.party.contact.PostalAddress", {contactMechId}) : null
    if (!address) return null
    const geo = geoId => (geoId ? one("moqui.basic.Geo", {geoId})?.geoCodeAlpha2 || geoId : "")
    return [
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
// The order's invoices the buyer may read (issued, not cancelled), with the Billing page when the site mounts Billing.
function invoicesOf(shop, order, via) {
    const ids = [...new Set(rows("mantle.order.OrderItemBilling", {orderId: order.orderId}).map(row => row.invoiceId))]
    if (!ids.length) return []
    const billing = via === "self" && publicApps().mount(shop.siteId, "billing")
    return Array.from(
        find("mantle.account.invoice.Invoice")
            .condition("invoiceId", "in", ids)
            .condition("statusId", "in", ["InvoiceFinalized", "InvoiceSent", "InvoiceAcked", "InvoicePmtRecvd"])
            .orderBy("invoiceDate")
            .list()
    ).map(invoice => {
        const totals = call("mantle.account.InvoiceServices.get#InvoiceTotal", {invoiceId: invoice.invoiceId})
        return {
            invoiceId: invoice.invoiceId,
            dateText: lib.dateText(invoice.invoiceDate),
            total: money(totals.invoiceTotal, invoice.currencyUomId),
            statusText: dec(totals.unpaidTotal).compare(0) <= 0 ? "Paid" : "Open",
            billingUrl: billing
                ? publicApps().pageUrl(shop.siteId, "billing", "/InvoicePay?invoiceId=" + encodeURIComponent(invoice.invoiceId))
                : null
        }
    })
}
// The order's shipments: what went, by which carrier, with tracking where the carrier gave a code.
function shipmentsOf(order) {
    const ids = [...new Set(rows("mantle.shipment.ShipmentItemSource", {orderId: order.orderId}).map(row => row.shipmentId))]
    return ids
        .map(shipmentId => one("mantle.shipment.Shipment", {shipmentId}))
        .filter(shipment => shipment && ["ShipShipped", "ShipDelivered", "ShipPacked"].includes(shipment.statusId))
        .map(shipment => {
            const route = rows("mantle.shipment.ShipmentRouteSegment", {shipmentId: shipment.shipmentId})[0]
            const packages = rows("mantle.shipment.ShipmentPackageRouteSeg", {shipmentId: shipment.shipmentId})
            return {
                shipmentId: shipment.shipmentId,
                statusText:
                    enumText(shipment.statusId) ||
                    one("moqui.basic.StatusItem", {statusId: shipment.statusId})?.description ||
                    "",
                shippedText: lib.dateText(shipment.shipDate || shipment.estimatedShipDate),
                carrierText: route ? enumText(route.shipmentMethodEnumId) : "",
                tracking: packages.map(row => row.trackingCode).filter(Boolean),
                items: rows("mantle.shipment.ShipmentItem", {shipmentId: shipment.shipmentId}).map(item => ({
                    name: productOf(item.productId)?.productName || item.productId,
                    quantity: String(dec(item.quantity).toNumber())
                }))
            }
        })
}
// What the buyer may ask for this order, as the site's Support pages take it (RequestReturn, NewCustomerCase with its
// cancelOrder), and whether a cancellation request is open.
function actionsOf(shop, order, via) {
    const support = publicApps().mount(shop.siteId, "support")
    const supportUrl = path => (support ? publicApps().pageUrl(shop.siteId, "support", path) : null)
    const openCancel = rows("mantle.request.Request", {
        orderId: order.orderId,
        requestTypeEnumId: "RqtOrderChange",
        orderChangeKindEnumId: "OckCancel"
    }).some(row => ["ReqSubmitted", "ReqReviewed", "ReqWaitingCustomer", "ReqInProgress"].includes(row.statusId))
    const q = "?orderId=" + encodeURIComponent(order.orderId)
    return {
        requestReturnUrl: supportUrl("/RequestReturn" + q),
        askQuestionUrl: supportUrl("/NewCustomerCase" + q),
        requestCancelUrl:
            cancellableStatuses.includes(order.statusId) && !openCancel
                ? supportUrl("/NewCustomerCase" + q + "#OrderCancelRequest")
                : null,
        cancellationRequested: openCancel,
        canReorder: via === "self",
        downloadsUrl: rows("mantle.product.store.StoreDownloadGrant", {orderId: order.orderId}).some(row => !row.revokedDate)
            ? shop.base + "/Downloads"
            : null
    }
}
function orderView(shop, reached) {
    const order = reached.order
    const currency = order.currencyUomId
    const part = find(PART, {orderId: order.orderId}).orderBy("orderPartSeqId").list()[0]
    const items = rows(ITEM, {orderId: order.orderId})
    const lines = productLines(order.orderId).map(line => {
        const children = items.filter(item => item.parentItemSeqId === line.orderItemSeqId)
        const discounts = children
            .filter(item => !taxTypes.includes(item.itemTypeEnumId))
            .reduce((sum, item) => sum.add(amountOf(item)), dec(0))
        return {
            orderItemSeqId: line.orderItemSeqId,
            name: line.itemDescription || productOf(line.productId)?.productName || line.productId,
            quantity: String(dec(line.quantity).toNumber()),
            unitPrice: money(line.unitAmount, currency),
            discount: discounts.isZero() ? null : money(discounts, currency),
            total: money(amountOf(line).add(discounts), currency),
            digital: productOf(line.productId)?.productTypeEnumId === "PtDigital"
        }
    })
    const sum = filter => items.filter(filter).reduce((total, item) => total.add(amountOf(item)), dec(0))
    const checkout = one(C, {orderId: order.orderId})
    const physical = productLines(order.orderId).some(line =>
        physicalTypes.includes(productOf(line.productId)?.productTypeEnumId)
    )
    return {
        order: {
            orderId: order.orderId,
            placedText: lib.dateText(order.placedDate || order.entryDate),
            statusText: statusText(order),
            lines,
            totals: {
                items: money(
                    lines.reduce((total, line) => total.add(dec(line.total.amount)), dec(0)),
                    currency
                ),
                discounts: money(
                    sum(item => item.isPromo === "Y" && !item.parentItemSeqId),
                    currency
                ),
                shipping: physical
                    ? money(
                          sum(item => item.itemTypeEnumId === "ItemShipping"),
                          currency
                      )
                    : null,
                tax: money(
                    sum(item => taxTypes.includes(item.itemTypeEnumId)),
                    currency
                ),
                total: money(order.grandTotal ?? 0, currency)
            },
            delivery:
                physical && part
                    ? {address: addressText(part.postalContactMechId) || "", method: enumText(part.shipmentMethodEnumId)}
                    : null,
            billingAddress: checkout?.billingContactMechId ? addressText(checkout.billingContactMechId) : null,
            contactEmail:
                reached.via === "self"
                    ? checkout?.contactEmail || ec.user.userAccount?.emailAddress || ""
                    : checkout?.contactEmail || "",
            shipments: shipmentsOf(order),
            documents: invoicesOf(shop, order, reached.via),
            actions: actionsOf(shop, order, reached.via)
        },
        via: reached.via
    }
}

// ===== operations: account and orders =====
// get#Account (AccountOverview, the hub's Shop card): the verified account's purchases in this store: recent orders, what
// waits on them, downloads, the invoices of these orders, and the store's account links. An unverified account sees only
// that it must verify; claiming the guest purchases of its email happens here first.
function getAccount(p) {
    const shop = shopOf(p)
    if (!ec.user.userId) refuse("AuthenticationRequired", "SIGN_IN_REQUIRED", "Sign in to see your account")
    const partyId = selfParty()
    const links = {
        orders: shop.base + "/Orders",
        addresses: shop.base + "/Addresses",
        paymentMethods: shop.base + "/PaymentMethods",
        downloads: shop.base + "/Downloads",
        hub: publicApps().mount(shop.siteId, "account") ? publicApps().pageUrl(shop.siteId, "account", "/Home") : null
    }
    if (!partyId) return {account: {verified: false, storeName: shop.store.storeName || ""}, links}
    const claimed = claimGuestPurchases(shop, partyId).claimed
    const orders = ordersOf(shop, partyId)
    const grants = rows("mantle.product.store.StoreDownloadGrant", {
        recipientPartyId: partyId,
        productStoreId: shop.productStoreId
    }).filter(row => !row.revokedDate)
    const invoices = orders.slice(0, limits.recent).flatMap(order => invoicesOf(shop, order, "self"))
    return {
        account: {
            verified: true,
            storeName: shop.store.storeName || "",
            orderCount: orders.length,
            recentOrders: orders.slice(0, limits.recent).map(orderRow),
            pending: orders.filter(order =>
                ["OrderPlaced", "OrderProcessing", "OrderApproved", "OrderHold"].includes(order.statusId)
            ).length,
            downloadCount: grants.length,
            invoices: invoices.slice(0, 10),
            claimed
        },
        links
    }
}
// find#Orders (Orders): the verified account's placed orders of this store, newest first, a page at a time (an opaque
// cursor); a guest's order link reaches its one order only.
function findOrders(p) {
    const shop = shopOf(p)
    if (text(p.orderToken)) return {orders: [orderRow(orderReached(shop, p).order)], cursor: null}
    const partyId = requireSelf()
    claimGuestPurchases(shop, partyId)
    const size = Math.min(limits.maxPageSize, Math.max(1, Number(p.limit || limits.pageSize)))
    const offset = /^\d{1,6}$/.test(text(p.cursor)) ? Number(text(p.cursor)) : 0
    const query = text(p.query).toLowerCase()
    const all = ordersOf(shop, partyId).filter(order => !query || String(order.orderId).toLowerCase().includes(query))
    const page = all.slice(offset, offset + size)
    return {orders: page.map(orderRow), cursor: offset + size < all.length ? String(offset + size) : null, total: all.length}
}
// get#Order (OrderDetail): the order's lines, totals, placed addresses, shipments, documents and what the buyer may ask.
function getOrder(p) {
    const shop = shopOf(p)
    return orderView(shop, orderReached(shop, p))
}
// get#OrderDocument (PurchaseDocuments): one invoice of the reached order, as the buyer reads it (its lines and totals).
function getOrderDocument(p) {
    const shop = shopOf(p)
    const reached = orderReached(shop, p)
    const invoice = invoicesOf(shop, reached.order, reached.via).find(row => row.invoiceId === text(p.invoiceId))
    if (!invoice) notAvailable()
    const record = one("mantle.account.invoice.Invoice", {invoiceId: invoice.invoiceId})
    const lines = rows("mantle.account.invoice.InvoiceItem", {invoiceId: invoice.invoiceId})
        .sort((a, b) => String(a.invoiceItemSeqId).localeCompare(String(b.invoiceItemSeqId)))
        .map(item => ({
            description: item.description || productOf(item.productId)?.productName || "",
            quantity: String(dec(item.quantity ?? 1).toNumber()),
            total: money(dec(item.quantity ?? 1).multiply(dec(item.amount)), record.currencyUomId)
        }))
    return {document: Object.assign({}, invoice, {orderId: reached.order.orderId, storeName: shop.store.storeName || "", lines})}
}

// ===== operations: reorder =====
// The order's lines as they would be bought now: each still offered (public and purchasable at today's price) or not.
function reorderLines(shop, order) {
    const lines = productLines(order.orderId).filter(line => {
        const product = productOf(line.productId)
        return (
            product &&
            !rows("mantle.product.subscription.ProductSubscriptionResource", {productId: line.productId}).some(row =>
                lib.active(row)
            )
        )
    })
    if (!lines.length) return []
    const offers = catalog().offersOf(
        Object.assign({}, shop, {customerPartyId: shop.customerPartyId}),
        lines.map(line => ({productId: line.productId, quantity: Number(String(line.quantity))}))
    )
    return lines.map((line, index) => {
        const offer = offers[index]
        return {
            orderItemSeqId: line.orderItemSeqId,
            productId: line.productId,
            name: offer.card?.name || line.itemDescription || line.productId,
            quantity: String(dec(line.quantity).toNumber()),
            available: !!offer.available,
            unitPrice: offer.available ? money(offer.unit, shop.currencyUomId) : null,
            changed: !!offer.available && !offer.unit.eq(dec(line.unitAmount))
        }
    })
}
// preview#Reorder: what reorder would add, at today's prices; lines no longer offered are named.
function previewReorder(p) {
    const shop = shopOf(p)
    const reached = orderReached(shop, Object.assign({}, p, {orderToken: null}))
    return {lines: reorderLines(shop, reached.order)}
}
// reorder#Order: the chosen still-offered lines (all by default) added to the session's cart through the cart's own path
// (repriced as any add); the same operation id answers the first result (without the cart's capability).
function reorderOrder(p) {
    const shop = shopOf(p)
    const reached = orderReached(shop, Object.assign({}, p, {orderToken: null}))
    const id = text(p.operationId)
    let operationKey = null
    if (id) {
        if (!/^[A-Za-z0-9_-]{8,64}$/.test(id)) invalid("operationId", "This request cannot be sent")
        operationKey =
            "SR" + ec.resource.digestText(reached.order.orderId + ":" + reached.partyId + ":" + id, "sha256").slice(0, 38)
        const old = one(OPERATION, {operationKey})
        if (old) return Object.assign(lib.json(old.resultJson, {}), {alreadyApplied: true})
    }
    const chosen = new Set(
        String(p.orderItemSeqIds || "")
            .split(",")
            .map(text)
            .filter(Boolean)
    )
    const lines = reorderLines(shop, reached.order).filter(line => !chosen.size || chosen.has(line.orderItemSeqId))
    let token = text(p.token) || null
    let cart = null
    const added = []
    const missing = []
    for (const line of lines) {
        if (!line.available) {
            missing.push(line.name)
            continue
        }
        const out = carts().execute("addCartItem", {siteId: p.siteId, token, productId: line.productId, quantity: line.quantity})
        token = out.token || token
        cart = out.cart || cart
        added.push(line.name)
    }
    if (!added.length) refuse("Unprocessable", "ITEM_UNAVAILABLE", "None of these items can be bought now")
    const result = {added, unavailableItems: missing, cart}
    if (operationKey)
        call("create#" + OPERATION, {
            operationKey,
            operationType: "ShopReorder",
            userId: ec.user.userId || null,
            submittedDate: ec.user.nowTimestamp,
            completedDate: ec.user.nowTimestamp,
            requestHash: lib.hash({orderId: reached.order.orderId, lines: lines.map(line => line.orderItemSeqId)}),
            status: "complete",
            resultEntityName: ORDER,
            resultId: reached.order.orderId,
            resultJson: JSON.stringify({added, unavailableItems: missing})
        })
    return Object.assign(result, token ? {token} : {})
}

// ===== operations: addresses =====
// The verified account's current postal addresses with their purposes.
function addressList(partyId) {
    const current = rows(PCM, {partyId}).filter(row => lib.active(row))
    const byMech = new Map()
    for (const row of current) {
        const address = one("mantle.party.contact.PostalAddress", {contactMechId: row.contactMechId})
        if (!address) continue
        const was = byMech.get(row.contactMechId) || {row, address, purposes: []}
        if (row.contactMechPurposeId) was.purposes.push(row.contactMechPurposeId)
        byMech.set(row.contactMechId, was)
    }
    return Array.from(byMech.values())
        .slice(0, limits.addresses)
        .map(({row, address, purposes}) => ({
            contactMechId: address.contactMechId,
            text: addressText(address.contactMechId),
            toName: address.toName || "",
            address1: address.address1 || "",
            address2: address.address2 || "",
            city: address.city || "",
            stateProvinceGeoId: address.stateProvinceGeoId || "",
            postalCode: address.postalCode || "",
            countryGeoId: address.countryGeoId || "",
            purposes: purposes.map(id => ({
                contactMechPurposeId: id,
                text:
                    enumText(id) || one("mantle.party.contact.ContactMechPurpose", {contactMechPurposeId: id})?.description || id
            })),
            shipping: purposes.includes("PostalShippingDest"),
            billing: purposes.includes("PostalBilling"),
            revision: String(ms(address.lastUpdatedStamp) ?? 0)
        }))
}
function getAddresses(p) {
    shopOf(p)
    return {addresses: addressList(requireSelf())}
}
const ownAddress = (partyId, contactMechId) =>
    rows(PCM, {partyId, contactMechId: text(contactMechId)}).some(row => lib.active(row)) &&
    !!one("mantle.party.contact.PostalAddress", {contactMechId: text(contactMechId)})
// store#Address (AddressEdit): a new address, or a change of an own one at the revision shown (Mantle's
// update#PartyPostalAddress, which keeps a placed order's address as it was); the store's carrier may offer a correction,
// never applied unasked.
function storeAddress(p) {
    const shop = shopOf(p)
    const partyId = requireSelf()
    const field = name => text(p[name])
    const values = {
        toName: field("toName") || null,
        address1: field("address1"),
        address2: field("address2") || null,
        city: field("city"),
        postalCode: field("postalCode"),
        countryGeoId: field("countryGeoId") || "USA",
        stateProvinceGeoId: field("stateProvinceGeoId") || null
    }
    for (const [name, label, max] of [
        ["address1", "street address", 255],
        ["city", "city", 100],
        ["postalCode", "postal code", 60]
    ])
        if (!values[name] || values[name].length > max) invalid(name, "Enter the " + label)
    const country = one("moqui.basic.Geo", {geoId: values.countryGeoId})
    if (!country || country.geoTypeEnumId !== "GEOT_COUNTRY") invalid("countryGeoId", "Choose a country")
    if (values.stateProvinceGeoId && !one("moqui.basic.Geo", {geoId: values.stateProvinceGeoId}))
        invalid("stateProvinceGeoId", "Choose a state or province")
    const purpose = field("purpose") === "billing" ? "PostalBilling" : "PostalShippingDest"
    let contactMechId
    if (field("contactMechId")) {
        if (!ownAddress(partyId, p.contactMechId)) notAvailable()
        const current = one("mantle.party.contact.PostalAddress", {contactMechId: field("contactMechId")})
        if (field("expectedRevision") !== String(ms(current.lastUpdatedStamp) ?? 0))
            refuse("Conflict", "STALE_REVISION", "This address changed since you opened it. Reload the page and try again")
        // each current purpose of the address moves to the changed one (Mantle keeps the old one for placed orders)
        const purposes = rows(PCM, {partyId, contactMechId: field("contactMechId")})
            .filter(row => lib.active(row))
            .map(row => row.contactMechPurposeId)
        let changedId = field("contactMechId")
        for (const contactMechPurposeId of purposes.length ? purposes : [purpose])
            changedId =
                call(
                    "mantle.party.ContactServices.update#PartyPostalAddress",
                    Object.assign({partyId, contactMechId: changedId, contactMechPurposeId}, values)
                ).contactMechId || changedId
        contactMechId = changedId
    } else {
        if (addressList(partyId).length >= limits.addresses) invalid("address1", "You have the most addresses an account keeps")
        contactMechId = call(
            "mantle.party.ContactServices.create#PostalAddress",
            Object.assign({}, values, {partyId, contactMechPurposeId: purpose})
        ).contactMechId
    }
    let suggestion = null
    const gateway = rows("mantle.product.store.ProductStoreShippingGateway", {productStoreId: shop.productStoreId})
        .map(row => one("mantle.shipment.carrier.ShippingGatewayConfig", {shippingGatewayConfigId: row.shippingGatewayConfigId}))
        .find(config => config?.validateAddressServiceName)
    if (gateway)
        try {
            const out = call("mantle.shipment.CarrierServices.validate#PostalAddress", {
                contactMechId,
                partyId,
                shippingGatewayConfigId: gateway.shippingGatewayConfigId
            })
            if (out.contactMechId && out.contactMechId !== contactMechId) suggestion = addressText(out.contactMechId)
        } catch (error) {
            ec.message.clearErrors()
        }
    return {contactMechId, addresses: addressList(partyId), suggestion}
}
// end#Address (EndAddress): an own address stops being used (its purposes ended now); placed orders keep it.
function endAddress(p) {
    shopOf(p)
    const partyId = requireSelf()
    if (!ownAddress(partyId, p.contactMechId)) notAvailable()
    for (const row of rows(PCM, {partyId, contactMechId: text(p.contactMechId)}).filter(row => lib.active(row)))
        call("update#" + PCM, {
            partyId,
            contactMechId: row.contactMechId,
            contactMechPurposeId: row.contactMechPurposeId,
            fromDate: row.fromDate,
            thruDate: ec.user.nowTimestamp
        })
    return {addresses: addressList(partyId)}
}

// ===== operations: payment methods =====
// The store's card gateway with a hosted setup (StoreCheckout.js gatewayCapabilities), enabled for its organization.
function setupGateway(shop) {
    const enabled = new Set(
        rows("mantle.account.method.PaymentGatewayOrganization", {organizationPartyId: shop.store.organizationPartyId})
            .filter(row => row.isEnabled !== "N" && lib.active(row))
            .map(row => row.paymentGatewayConfigId)
    )
    for (const row of rows("mantle.product.store.ProductStorePaymentGateway", {productStoreId: shop.productStoreId})) {
        if (!enabled.has(row.paymentGatewayConfigId)) continue
        const config = one("mantle.account.method.PaymentGatewayConfig", {paymentGatewayConfigId: row.paymentGatewayConfigId})
        const of = config ? settings().gatewayCapabilities[config.paymentGatewayTypeEnumId] : null
        const capabilities = of ? of(config) : {}
        if (capabilities.hostedSetupService && capabilities.setupSyncService) return {config, capabilities}
    }
    return null
}
// The recurring orders (a base with a schedule, not cancelled) that charge a method: what ending it affects (P7 adds the
// store's recurring contracts).
function contractsOf(paymentMethodId) {
    const orderIds = [
        ...new Set(
            rows("mantle.account.payment.Payment", {paymentMethodId})
                .map(row => row.orderId)
                .filter(Boolean)
        )
    ]
    return orderIds
        .map(orderId => one(ORDER, {orderId}))
        .filter(
            order =>
                order &&
                order.recurCronExpression &&
                !["OrderCancelled", "OrderRejected", "OrderCompleted"].includes(order.statusId)
        )
        .map(order => ({orderId: order.orderId, name: order.orderName || "Recurring order " + order.orderId}))
}
function methodList(partyId) {
    return Array.from(
        find("mantle.account.method.PaymentMethod", {ownerPartyId: partyId})
            .condition("thruDate", "is-null", null)
            .condition("paymentMethodTypeEnumId", "PmtCreditCard")
            .orderBy("-fromDate")
            .limit(limits.methods)
            .list()
    ).map(method => {
        const card = one("mantle.account.method.CreditCard", {paymentMethodId: method.paymentMethodId})
        const gateway = method.paymentGatewayConfigId
            ? one("mantle.account.method.PaymentGatewayConfig", {paymentGatewayConfigId: method.paymentGatewayConfigId})
            : null
        return {
            paymentMethodId: method.paymentMethodId,
            description: method.description || "Card",
            brand: card?.creditCardTypeEnumId ? enumText(card.creditCardTypeEnumId) : "",
            last4: card?.cardNumber ? String(card.cardNumber).replace(/\D/g, "").slice(-4) : "",
            expiry: card?.expireDate || "",
            provider: gateway?.description || "",
            // ended while a payment of it is still open: Mantle ends it once those complete (delete#PaymentMethod)
            ending: method.thruDateSetAuto === "Y",
            contracts: contractsOf(method.paymentMethodId)
        }
    })
}
function getPaymentMethods(p) {
    const shop = shopOf(p)
    const partyId = requireSelf()
    return {methods: methodList(partyId), canAdd: !!setupGateway(shop)}
}
// begin#PaymentMethodSetup (AddMethod): the store's gateway's hosted setup for the verified account: the provider's page
// (a redirect, or a form the frontend's relay posts) returning to the Shop mount's PaymentMethods/return; the setup's
// reference comes back with it.
function beginPaymentMethodSetup(p) {
    const shop = shopOf(p)
    const partyId = requireSelf()
    const gateway = setupGateway(shop)
    if (!gateway) refuse("Unavailable", "PROVIDER_UNAVAILABLE", "This store cannot keep cards now")
    const reference = ec.user.randomString(20).replace(/[^A-Za-z0-9]/g, "x")
    const returnUrl = publicApps().pageUrl(shop.siteId, "shop", "/PaymentMethods/return?setup=" + encodeURIComponent(reference))
    let out
    try {
        out = lib.probe(gateway.capabilities.hostedSetupService, {
            partyId,
            paymentGatewayConfigId: gateway.config.paymentGatewayConfigId,
            setupReference: reference,
            returnUrl,
            merchantName: shop.store.storeName || null
        })
    } catch (error) {
        ec.logger.warn("Shop payment method setup for party " + partyId + ": " + String(error.message).split("\n")[0])
        refuse("Unavailable", "PROVIDER_UNAVAILABLE", "The card page cannot be opened now. Try again in a moment")
    }
    return {
        setupReference: reference,
        redirectUrl: out.redirectUrl || null,
        form: out.formUrl ? {formUrl: out.formUrl, fields: out.fields || {}} : null
    }
}
// finish#PaymentMethodSetup: the provider asked for the account's methods after its setup page (its profile read, the
// new cards kept masked); what the browser brings back is never trusted. The methods as they are now.
function finishPaymentMethodSetup(p) {
    const shop = shopOf(p)
    const partyId = requireSelf()
    const gateway = setupGateway(shop)
    if (!gateway) refuse("Unavailable", "PROVIDER_UNAVAILABLE", "This store cannot keep cards now")
    const before = methodList(partyId).length
    try {
        lib.probe(gateway.capabilities.setupSyncService, {
            partyId,
            paymentGatewayConfigId: gateway.config.paymentGatewayConfigId,
            setupReference: text(p.setupReference) || null
        })
    } catch (error) {
        ec.logger.warn("Shop payment method sync for party " + partyId + ": " + String(error.message).split("\n")[0])
        refuse("Unavailable", "PROVIDER_UNAVAILABLE", "Your card could not be confirmed now. Try again in a moment")
    }
    const methods = methodList(partyId)
    return {methods, added: Math.max(0, methods.length - before)}
}
// end#PaymentMethod (EndMethod): an own method ended (Mantle's delete#PaymentMethod); the recurring orders it charges are
// named, and with any the end needs confirming (confirm), so none silently loses its method.
function endPaymentMethod(p) {
    shopOf(p)
    const partyId = requireSelf()
    const method = text(p.paymentMethodId)
        ? one("mantle.account.method.PaymentMethod", {paymentMethodId: text(p.paymentMethodId)})
        : null
    if (!method || method.ownerPartyId !== partyId || method.thruDate) notAvailable()
    const contracts = contractsOf(method.paymentMethodId)
    if (contracts.length && !yes(p.confirm))
        return {ended: false, needsConfirmation: true, contracts, methods: methodList(partyId)}
    call("mantle.account.PaymentMethodServices.delete#PaymentMethod", {paymentMethodId: method.paymentMethodId})
    return {ended: true, contracts, methods: methodList(partyId)}
}

// ===== the hub's card and the cart reminders topic =====
// The Shop card of the PASS Account hub (PublicApps' accountCard): the account's purchases in the site's store.
function accountCard(p) {
    const out = getAccount(p)
    return {
        app: "shop",
        title: out.account.storeName || "Shop",
        verified: out.account.verified,
        lines: out.account.verified
            ? [
                  out.account.orderCount + (out.account.orderCount === 1 ? " order" : " orders"),
                  out.account.pending ? out.account.pending + " in progress" : null,
                  out.account.downloadCount ? out.account.downloadCount + " downloads" : null
              ].filter(Boolean)
            : ["Verify your email address to see your purchases"],
        url: shopOf(p).base + "/Account"
    }
}

const operations = {
    getAccount,
    findOrders,
    getOrder,
    getOrderDocument,
    previewReorder,
    reorderOrder,
    getAddresses,
    storeAddress,
    endAddress,
    getPaymentMethods,
    beginPaymentMethodSetup,
    finishPaymentMethodSetup,
    endPaymentMethod,
    accountCard
}
;({
    selfParty,
    claimGuestPurchases,
    ownOrder,
    execute: (op, parameters) => {
        if (!operations[op]) throw new Error("Unknown Shop customer operation " + op)
        return operations[op](parameters || {})
    }
})
