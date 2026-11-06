// Store operations (impl-commerce P8, COM-OPS; design-commerce §6, §10): a store's worklists and the reads behind
// Commerce's order, cart, return, customer and request screens, Order again, a case's internal note, and Home's work counts.
//
// Every operation checks COMMERCE_VIEW and the store scope of StoreAdmin.js (the user's own organizations; a user with a
// current StoreStaff row works only those stores, F51); the order, cart, return, customer and request reads also need
// COMMERCE_ORDER_VIEW. A store is never taken from the browser on trust: a record is in scope when its store is, and a
// missing record and one outside the scope are refused alike (RECORD_UNAVAILABLE). Reads below the checks run without
// artifact authorization. Commerce takes no action of the owners' (design §6): a payment hold is Accounting's to release,
// a return Customer Service's to authorize and Accounting's to settle, a case and an order change Customer Service's to
// work; the reads say so and link them.
//
// The lists:
// - orders: submitted store orders (never OrderOpen: a cart), with a payment state computed from the order's payments and
//   invoices (never a guessed status), the fulfillment state of its shipments and digital lines, its open holds (a
//   Payment hold, OhtPayment, read only), open cancellation proposals (Customer Service's order changes) and stuck Shop
//   placements (a placementPending checkout refused ORDER_CHANGED or past its tries: the order is still open, so it opens as
//   a cart; impl-shop F85); RecurringTemplate bases are left out once Shop P7 marks them;
// - carts: OrderOpen store orders with the shopper's activity (StoreCartAccess.lastActivityDate, never lastUpdatedStamp)
//   and their Shop checkout's phase; abandoned is inactive past the store's delay (its RecoveryPolicy's, Commerce P10, an
//   hour by default) with no live checkout; a cart staff made (Order again) has no shopper activity;
// - returns: ReturnHeaders by the store of their source order lines (StoreReturnItemView);
// - customers: the parties with an order or a signed-in cart in the user's stores, never a party directory;
// - requests: support cases by Request.productStoreId (Customer Service's contactCase sets it from the order's store, the
//   owner contract of Shop P6), linked to one of the store's orders (StoreRequestOrderView) or filed in its checkout
//   support queue;
// - deliveries: the delivery ledger's notices of the store (MessageDelivery.productStoreId), exceptions by default
//   (impl-shop F91); their resolution stays MESSAGE_DELIVERY_REVIEW's (resolve#Delivery), which no Commerce group holds.
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const stores = ec.resource.script("component://mr-mantle/service/mantle/product/StoreAdmin.js")
const {find, one, rows, denied, call, ms, dateText, access} = lib

const ORDER = "mantle.order.OrderHeader"
const PART = "mantle.order.OrderPart"
const ITEM = "mantle.order.OrderItem"
const HOLD = "mantle.order.OrderHoldReason"
const CART = "mantle.order.StoreCartAccess"
const CHECKOUT = "mantle.order.StoreCheckout"
const PAYMENT = "mantle.account.payment.Payment"
const REQUEST = "mantle.request.Request"
const DELIVERY = "mantle.party.MessageDelivery"
const STORE = "mantle.product.store.ProductStore"

// ===== tables =====
const limits = {
    // the ids a worklist filter gathers before paging (a larger set is cut and said to be)
    ids: 500,
    // a detail's rows of each kind
    detail: 50,
    // Home's recent orders
    recent: 8,
    // a cart is abandoned after this long without shopper activity unless the store's RecoveryPolicy (Commerce P10) sets it
    abandonMinutes: 60,
    // a Shop placement past this many tries waits for staff (ShopCheckout.js limits.placementTries)
    placementTries: 5,
    // the store orders vended by other organizations left out (F-P8-8; there should be few or none)
    foreign: 2000
}
const placedStatuses = ["OrderPlaced", "OrderProcessing", "OrderApproved", "OrderSent", "OrderCompleted", "OrderHold"]
const closedRequestStatuses = ["ReqCompleted", "ReqCancelled", "ReqDraft"]
// the checkout phases in which a payment or placement is live, so the cart is not abandoned
const liveCheckoutStatuses = ["ScoPaymentPending", "ScoPlacementPending"]
const openCheckoutStatuses = ["ScoEditing", "ScoReady", "ScoReviewRequired", "ScoPaymentPending", "ScoPlacementPending"]
const voidPaymentStatuses = ["PmntCancelled", "PmntVoid", "PmntDeclined"]
const deliveryExceptions = ["MdsFailed", "MdsUncertain", "MdsRetry"]
// each delivery-ledger source's event key to the order it is about (Shop P6's download notice; P9's review requests and
// P10's recovery add theirs)
const deliveryOrders = {
    MdsrcShopDownloads: key => /^shopDownloads:(.+)$/.exec(String(key || ""))?.[1] || null,
    // P10: a cart's recovery (cartRecovery:{orderId}:{window})
    MdsrcCartRecovery: key => /^cartRecovery:([^:]+):/.exec(String(key || ""))?.[1] || null
}
// the attention filters of the order worklist, each a set of order ids
const attentionFilters = {
    paymentHold: storeIds => heldOrderIds(storeIds, "OhtPayment"),
    hold: storeIds => heldOrderIds(storeIds, null),
    cancelRequest: storeIds => cancelRequestOrderIds(storeIds),
    stuck: storeIds => stuckCheckouts(storeIds).map(row => row.orderId),
    notice: storeIds => noticeOrderIds(storeIds)
}

// ===== values =====
const text = value => (value == null ? "" : String(value).trim())
const unique = list => Array.from(new Set(list.filter(Boolean)))
const num = value =>
    value == null || value === "" ? 0 : typeof value?.toNumber === "function" ? value.toNumber() : Number(value)
const moneyText = (value, currencyUomId) =>
    value == null ? "" : ec.l10n.formatCurrency(ec.l10n.roundCurrency(toDecimal(value), currencyUomId), currencyUomId)
const quantityText = value => (value == null ? "" : ec.l10n.format(toDecimal(value), "#,##0.###"))
const statusText = statusId => (statusId ? one("moqui.basic.StatusItem", {statusId})?.description || statusId : "")
const enumText = enumId => (enumId ? one("moqui.basic.Enumeration", {enumId})?.description || enumId : "")
const likeText = term => "%" + String(term).replace(/[\\%_]/g, character => "\\" + character) + "%"
const nowMs = () => ms(ec.user.nowTimestamp)
const rowsIn = (entity, field, values, conditions = {}) =>
    values.length ? Array.from(find(entity, conditions).condition(field, "in", values).list()) : []
const storeName = productStoreId => one(STORE, {productStoreId})?.storeName || productStoreId || ""
function termCondition(fields, term) {
    const factory = ec.entity.conditionFactory
    return factory.makeCondition(
        fields.map(field => factory.makeCondition(field, "like", likeText(term)).ignoreCase()),
        "or"
    )
}
// an email address shown to staff with its local part masked (a.....@example.com)
function maskedAddress(address) {
    const value = text(address)
    const at = value.indexOf("@")
    if (at < 1) return value ? "…" : ""
    return value[0] + "…" + value.slice(at)
}
const productName = productId => {
    const product = productId ? one("mantle.product.Product", {productId}) : null
    return product ? product.productName || product.pseudoId || productId : ""
}

// ===== scope =====
// COMMERCE_VIEW and the store scope; need "orders" adds COMMERCE_ORDER_VIEW. The user's stores by id (storeIds).
function scope(need = "orders") {
    const s = stores.scope("view")
    s.canOrders = access.has("COMMERCE_ORDER_VIEW")
    if (need === "orders" && !s.canOrders) denied("PERMISSION_DENIED", "COMMERCE_ORDER_VIEW is required")
    s.storeIds = Array.from(stores.storeQuery(s).selectField("productStoreId").orderBy("productStoreId").list()).map(
        row => row.productStoreId
    )
    // an order of the user's stores vended by an organization not theirs is not theirs either (F-P8-8, as Commerce's record
    // check and Customer Service's order scope): such orders are left out of every list and refused as records
    s.foreign = foreignOrderIds(s)
    s.own = (query, field = "orderId") => (s.foreign.length ? query.condition(field, "not-in", s.foreign) : query)
    s.owned = orderId => !!orderId && !s.foreign.includes(orderId)
    return s
}
// the orders of the user's stores with a part vended by another organization (none for a user of every organization)
function foreignOrderIds(s) {
    if (!s.organizationPartyIds || !s.storeIds.length) return []
    const found = Array.from(
        find("mantle.order.OrderHeaderAndPart")
            .condition("productStoreId", "in", s.storeIds)
            .condition("vendorPartyId", "is-not-null", null)
            .condition("vendorPartyId", "not-in", s.organizationPartyIds)
            .selectField("orderId")
            .distinct(true)
            .limit(limits.foreign)
            .list()
    ).map(row => row.orderId)
    if (found.length >= limits.foreign)
        ec.logger.warn("Store operations: more than " + limits.foreign + " store orders vended by other organizations")
    return unique(found)
}
// the stores a list is of: one the user works (refused otherwise) or all of theirs
function storesFor(s, productStoreId) {
    if (productStoreId) return [stores.storeOf(s, productStoreId).productStoreId]
    return s.storeIds
}
const unavailable = (kind, id) => denied("RECORD_UNAVAILABLE", kind + " " + (id || "") + " is not available")
// a store order (or, with cart, an open one) of the user's stores
function storeOrder(s, orderId, cart) {
    const order = orderId ? one(ORDER, {orderId}) : null
    if (!order || !order.productStoreId || !s.storeIds.includes(order.productStoreId) || !s.owned(order.orderId))
        unavailable(cart ? "Cart" : "Order", orderId)
    if ((order.statusId === "OrderOpen") !== !!cart) unavailable(cart ? "Cart" : "Order", orderId)
    return order
}

// ===== order facts =====
const customersOf = orderId => unique(rows(PART, {orderId}).map(part => part.customerPartyId))
function openHolds(orderIds) {
    return rowsIn(HOLD, "orderId", orderIds).filter(row => !row.releasedDate)
}
function heldOrderIds(storeIds, holdTypeEnumId) {
    if (!storeIds.length) return []
    // the store is in the query (F114): the first 500 of every store's holds would miss some of these stores'
    let query = find("mantle.order.StoreOrderHoldView")
        .condition("releasedDate", "is-null", null)
        .condition("productStoreId", "in", storeIds)
        .selectField("orderId")
        .distinct(true)
        .limit(limits.ids)
    if (holdTypeEnumId) query = query.condition("holdTypeEnumId", holdTypeEnumId)
    return Array.from(query.list()).map(row => row.orderId)
}
// open order changes that cancel (Customer Service's proposals, F37), by order
function cancelRequests(orderIds) {
    return rowsIn(REQUEST, "orderId", orderIds, {requestTypeEnumId: "RqtOrderChange", orderChangeKindEnumId: "OckCancel"}).filter(
        row => !closedRequestStatuses.includes(row.statusId) && !row.changeAppliedDate
    )
}
function cancelRequestOrderIds(storeIds) {
    if (!storeIds.length) return []
    // the store is in the query (F114), as heldOrderIds
    return unique(
        Array.from(
            find("mantle.request.StoreOrderChangeView", {requestTypeEnumId: "RqtOrderChange", orderChangeKindEnumId: "OckCancel"})
                .condition("statusId", "not-in", closedRequestStatuses)
                .condition("changeAppliedDate", "is-null", null)
                .condition("productStoreId", "in", storeIds)
                .selectField("orderId")
                .distinct(true)
                .limit(limits.ids)
                .list()
        ).map(row => row.orderId)
    )
}
// a Shop placement waiting for staff: placementPending with an approved payment, refused ORDER_CHANGED or past its tries
// (impl-shop F85); the job no longer retries it
const stuck = checkout =>
    checkout.statusId === "ScoPlacementPending" &&
    (checkout.failureCode === "ORDER_CHANGED" || num(checkout.placementTries) >= limits.placementTries)
function stuckCheckouts(storeIds) {
    if (!storeIds.length) return []
    return Array.from(
        find(CHECKOUT, {statusId: "ScoPlacementPending"})
            .condition("productStoreId", "in", storeIds)
            .orderBy("frozenDate")
            .limit(limits.ids)
            .list()
    ).filter(stuck)
}
function noticeOrderIds(storeIds) {
    if (!storeIds.length) return []
    return unique(
        Array.from(
            find(DELIVERY)
                .condition("productStoreId", "in", storeIds)
                .condition("stateEnumId", "in", deliveryExceptions)
                .limit(limits.ids)
                .list()
        ).map(row => deliveryOrders[row.sourceEnumId]?.(row.eventKey))
    )
}
const invoiceIdsOf = orderId => unique(rows("mantle.order.OrderItemBilling", {orderId}).map(row => row.invoiceId))
// the order's payment state, computed (design §6: never a guessed order status): held when a Payment hold is open; paid
// when its invoices are all paid or its captured payments cover the total; authorized when captured and authorized
// payments cover it; promised; no charge; else unpaid
function paymentState(order, holds) {
    if (holds.some(hold => hold.holdTypeEnumId === "OhtPayment")) return {key: "held", text: "Payment hold"}
    const invoices = rowsIn("mantle.account.invoice.Invoice", "invoiceId", invoiceIdsOf(order.orderId)).filter(
        row => row.statusId !== "InvoiceCancelled"
    )
    if (invoices.length && invoices.every(row => row.statusId === "InvoicePmtRecvd")) return {key: "paid", text: "Paid"}
    const payments = rows(PAYMENT, {orderId: order.orderId}).filter(row => !voidPaymentStatuses.includes(row.statusId))
    const sum = statuses =>
        payments.filter(row => statuses.includes(row.statusId)).reduce((total, row) => total + num(row.amount), 0)
    const total = num(order.grandTotal)
    const captured = sum(["PmntDelivered", "PmntConfirmed"])
    if (total <= 0) return {key: "none", text: "No charge"}
    if (captured >= total) return {key: "paid", text: "Paid"}
    if (captured + sum(["PmntAuthorized"]) >= total) return {key: "authorized", text: "Authorized"}
    if (payments.some(row => ["PmntPromised", "PmntProposed"].includes(row.statusId))) return {key: "promised", text: "Promised"}
    return {key: "unpaid", text: "Unpaid"}
}
// the fulfillment state: the physical shipments and the digital lines (StoreItemFulfillment), joined
function fulfillmentState(order) {
    const shipmentIds = unique(rows("mantle.shipment.ShipmentItemSource", {orderId: order.orderId}).map(row => row.shipmentId))
    const shipments = rowsIn("mantle.shipment.Shipment", "shipmentId", shipmentIds)
    const digital = rows("mantle.product.store.StoreItemFulfillment", {orderId: order.orderId})
    const parts = []
    if (shipments.length) {
        const statuses = shipments.map(row => row.statusId)
        parts.push(
            statuses.every(statusId => statusId === "ShipDelivered")
                ? "Delivered"
                : statuses.some(statusId => ["ShipShipped", "ShipDelivered"].includes(statusId))
                  ? "Shipped"
                  : statuses.some(statusId => statusId === "ShipPacked")
                    ? "Packed"
                    : "Preparing"
        )
    }
    if (digital.length) {
        const steps = digital.map(row => row.stepEnumId)
        parts.push(
            steps.every(step => step === "SifCompleted")
                ? "Downloads ready"
                : steps.some(step => step === "SifHeld")
                  ? "Downloads held"
                  : steps.every(step => step === "SifRevoked")
                    ? "Downloads revoked"
                    : "Downloads pending"
        )
    }
    if (!parts.length) return order.statusId === "OrderCompleted" ? "Completed" : "Not shipped"
    return parts.join(" · ")
}
function orderRow(order, facts) {
    const holds = facts.holds.filter(hold => hold.orderId === order.orderId)
    const customerIds = customersOf(order.orderId)
    const names = lib.partyNames(customerIds)
    const payment = paymentState(order, holds)
    return {
        orderId: order.orderId,
        orderName: order.orderName || "",
        productStoreId: order.productStoreId,
        storeName: storeName(order.productStoreId),
        salesChannelText: enumText(order.salesChannelEnumId),
        externalId: order.externalId || "",
        customerPartyId: customerIds[0] || null,
        customerName: customerIds.map(id => names[id] || "Customer").join(", "),
        placedDate: order.placedDate,
        placedText: dateText(order.placedDate || order.entryDate),
        statusId: order.statusId,
        statusText: statusText(order.statusId),
        totalText: moneyText(order.grandTotal ?? 0, order.currencyUomId),
        paymentKey: payment.key,
        paymentText: payment.text,
        fulfillmentText: fulfillmentState(order),
        held: holds.length > 0 || order.statusId === "OrderHold",
        paymentHold: holds.some(hold => hold.holdTypeEnumId === "OhtPayment"),
        holdText: unique(holds.map(hold => enumText(hold.holdTypeEnumId))).join(", "),
        cancelRequested: facts.cancels.some(row => row.orderId === order.orderId),
        stuck: false
    }
}

// ===== find#StoreOrders =====
// Submitted orders of the user's stores (or one), newest first: by number, name or external reference, customer, status,
// placed dates and an attention filter (paymentHold, hold, cancelRequest, notice; stuck lists the stuck placements, which
// are carts); a payment filter (paid, authorized, unpaid, held, none) is applied to the computed state of the newest
// matching orders (at most limits.ids, truncated says so).
function findStoreOrders(p) {
    const s = scope()
    const storeIds = storesFor(s, p.productStoreId)
    if (p.attention && !Object.hasOwn(attentionFilters, p.attention)) denied("VALUE_INVALID", "Unknown filter " + p.attention)
    if (p.attention === "stuck") return stuckOrders(s, storeIds, p)
    const shape = list => {
        const ids = list.map(order => order.orderId)
        const facts = {holds: openHolds(ids), cancels: cancelRequests(ids)}
        return list.map(order => orderRow(order, facts))
    }
    if (p.payment) {
        const candidates = Array.from(orderQuery(s, p, storeIds).limit(limits.ids).list())
        const shaped = shape(candidates).filter(row => row.paymentKey === p.payment)
        return Object.assign(lib.pageList(shaped, p, "orders"), {truncated: candidates.length >= limits.ids})
    }
    // a find is used up by count(), so the page is a second find (F69)
    const page = lib.page(orderQuery(s, p, storeIds), p, "orders", orderQuery(s, p, storeIds).count())
    return Object.assign({}, page, {orders: shape(page.rows), rows: undefined, truncated: false})
}
// RecurringTemplate bases (F112) are never a store's orders: Shop P7 marks them (Sales' RecurringTemplate marker, X5), and
// the condition goes here, in the one function the order worklist and the store reports (StoreReports.js) call. Until a
// base is marked nothing is left out.
function withoutRecurringBases(query) {
    return query
}
function orderQuery(s, p, storeIds) {
    let query = withoutRecurringBases(
        s.own(find(ORDER).condition("productStoreId", "in", storeIds).condition("statusId", "!=", "OrderOpen"))
    )
    if (text(p.term)) query = query.condition(termCondition(["orderId", "orderName", "externalId", "displayId"], text(p.term)))
    if (p.statusId) query = query.condition("statusId", p.statusId)
    if (p.fromDate) query = query.condition("placedDate", ">=", p.fromDate)
    if (p.thruDate) query = query.condition("placedDate", "<", p.thruDate)
    if (p.customerPartyId)
        query = query.condition(
            "orderId",
            "in",
            unique(
                Array.from(find(PART, {customerPartyId: p.customerPartyId}).selectField("orderId").limit(limits.ids).list()).map(
                    row => row.orderId
                )
            )
        )
    if (p.attention) query = query.condition("orderId", "in", attentionFilters[p.attention](storeIds))
    return query.orderBy("-placedDate").orderBy("-entryDate").orderBy("orderId")
}
// the stuck placements as order rows (each still an open order with its payment kept; it opens as a cart)
function stuckOrders(s, storeIds, p) {
    const checkouts = stuckCheckouts(storeIds).filter(row => s.owned(row.orderId))
    const ids = checkouts.map(row => row.orderId)
    const orders = rowsIn(ORDER, "orderId", ids)
    const facts = {holds: openHolds(ids), cancels: []}
    const shaped = orders.map(order => {
        const checkout = checkouts.find(row => row.orderId === order.orderId)
        return Object.assign(orderRow(order, facts), {
            stuck: true,
            paymentText: statusText(one(PAYMENT, {paymentId: checkout.paymentId})?.statusId) || "Payment kept",
            statusText: "Placement waiting",
            failureText:
                checkout.failureCode === "ORDER_CHANGED"
                    ? "The order changed after it was paid"
                    : "Placement failed " + num(checkout.placementTries) + " times",
            placedText: dateText(checkout.frozenDate)
        })
    })
    return Object.assign(lib.pageList(shaped, p, "orders"), {truncated: checkouts.length >= limits.ids})
}

// ===== get#StoreOrder (OrderDetail's Commerce branch) =====
function getStoreOrder(p) {
    const s = scope()
    const order = storeOrder(s, p.orderId, false)
    const orderId = order.orderId
    const currencyUomId = order.currencyUomId
    const holds = openHolds([orderId])
    const facts = {holds, cancels: cancelRequests([orderId])}
    const header = orderRow(order, facts)
    const issued = rows("mantle.product.issuance.AssetIssuance", {orderId})
    const digital = rows("mantle.product.store.StoreItemFulfillment", {orderId})
    const items = rows(ITEM, {orderId})
        .sort((a, b) => String(a.orderItemSeqId).localeCompare(String(b.orderItemSeqId)))
        .slice(0, limits.detail)
        .map(item => {
            const shipped = issued
                .filter(row => row.orderItemSeqId === item.orderItemSeqId)
                .reduce((total, row) => total + num(row.quantity), 0)
            const line = digital.find(row => row.orderItemSeqId === item.orderItemSeqId)
            const quantity = num(item.quantity) - num(item.quantityCancelled)
            return {
                orderItemSeqId: item.orderItemSeqId,
                productId: item.productId || null,
                description: item.itemDescription || productName(item.productId),
                itemTypeText: enumText(item.itemTypeEnumId),
                quantityText: quantityText(item.quantity),
                cancelledText: num(item.quantityCancelled) ? quantityText(item.quantityCancelled) : "",
                deliveredText: line ? enumText(line.stepEnumId) : item.productId ? quantityText(shipped) : "",
                unitText: moneyText(item.unitAmount ?? 0, currencyUomId),
                amountText: moneyText(toDecimal(quantity).multiply(toDecimal(item.unitAmount ?? 0)), currencyUomId)
            }
        })
    const payments = rows(PAYMENT, {orderId})
        .slice(0, limits.detail)
        .map(payment => ({
            paymentId: payment.paymentId,
            instrumentText: enumText(payment.paymentInstrumentEnumId) || "Payment",
            statusText: statusText(payment.statusId),
            amountText: moneyText(payment.amount ?? 0, payment.amountUomId || currencyUomId),
            dateText: dateText(payment.effectiveDate)
        }))
    const shipmentIds = unique(rows("mantle.shipment.ShipmentItemSource", {orderId}).map(row => row.shipmentId))
    const shipments = rowsIn("mantle.shipment.Shipment", "shipmentId", shipmentIds).map(shipment => {
        const route = rows("mantle.shipment.ShipmentRouteSegment", {shipmentId: shipment.shipmentId})[0]
        const box = rows("mantle.shipment.ShipmentPackageRouteSeg", {shipmentId: shipment.shipmentId}).find(
            row => row.trackingCode
        )
        return {
            shipmentId: shipment.shipmentId,
            statusText: statusText(shipment.statusId),
            trackingText: box?.trackingCode || route?.trackingIdNumber || "",
            dateText: dateText(shipment.shipAfterDate || shipment.entryDate)
        }
    })
    const invoices = rowsIn("mantle.account.invoice.Invoice", "invoiceId", invoiceIdsOf(orderId)).map(invoice => ({
        invoiceId: invoice.invoiceId,
        statusText: statusText(invoice.statusId),
        totalText: moneyText(invoice.invoiceTotal ?? 0, invoice.currencyUomId || currencyUomId),
        dateText: dateText(invoice.invoiceDate)
    }))
    const changes = rows(REQUEST, {requestTypeEnumId: "RqtOrderChange", orderId})
        .filter(row => !closedRequestStatuses.includes(row.statusId) && !row.changeAppliedDate)
        .map(row => ({
            requestId: row.requestId,
            kindText: enumText(row.orderChangeKindEnumId),
            statusText: statusText(row.statusId),
            dateText: dateText(row.requestDate),
            cancel: row.orderChangeKindEnumId === "OckCancel"
        }))
    const caseIds = unique(
        rows("mantle.request.RequestRecord", {recordEntityName: ORDER, recordId: orderId}).map(row => row.requestId)
    )
    const cases = rowsIn(REQUEST, "requestId", caseIds)
        .filter(row => one("mantle.request.support.CaseProfile", {requestId: row.requestId}))
        .map(row => ({
            requestId: row.requestId,
            requestName: row.requestName || "",
            statusText: statusText(row.statusId)
        }))
    const returnIds = unique(rows("mantle.order.return.ReturnItem", {orderId}).map(row => row.returnId))
    const returns = rowsIn("mantle.order.return.ReturnHeader", "returnId", returnIds).map(row => ({
        returnId: row.returnId,
        statusText: statusText(row.statusId),
        dateText: dateText(row.entryDate)
    }))
    const checkout = rows(CHECKOUT, {orderId}).sort((a, b) => (ms(b.createdDate) ?? 0) - (ms(a.createdDate) ?? 0))[0]
    return {
        order: Object.assign(header, {
            entryText: dateText(order.entryDate),
            customerReference: unique(rows(PART, {orderId}).map(part => part.otherPartyOrderId)).join(", "),
            organizationName: Object.values(lib.partyNames(unique(rows(PART, {orderId}).map(part => part.vendorPartyId)))).join(
                ", "
            ),
            currencyUomId,
            orderRevision: order.orderRevision ?? 1,
            // Order again: a submitted order of a customer, not cancelled or rejected
            canReorder: placedStatuses.includes(order.statusId) && !!header.customerPartyId && items.some(item => item.productId)
        }),
        holds: holds.map(hold => ({
            typeText: enumText(hold.holdTypeEnumId),
            payment: hold.holdTypeEnumId === "OhtPayment",
            reasonText: hold.holdComment || "",
            placedText: dateText(hold.placedDate)
        })),
        items,
        payments,
        shipments,
        invoices,
        changes,
        cases,
        returns,
        notices: noticesOf(order.productStoreId, orderId),
        checkout: checkout
            ? {
                  checkoutId: checkout.checkoutId,
                  statusText: statusText(checkout.statusId),
                  siteId: checkout.siteId,
                  placedText: dateText(checkout.placedDate)
              }
            : null
    }
}
// an order's notices on the delivery ledger (each source's event key naming the order), the address masked
function noticesOf(productStoreId, orderId) {
    const keys = Object.entries(deliveryOrders).map(([sourceEnumId]) => sourceEnumId)
    return Array.from(
        find(DELIVERY, {productStoreId}).condition("sourceEnumId", "in", keys).orderBy("-createdDate").limit(limits.ids).list()
    )
        .filter(row => deliveryOrders[row.sourceEnumId](row.eventKey) === orderId)
        .slice(0, limits.detail)
        .map(deliveryRow)
}
const deliveryRow = row => ({
    deliveryId: row.deliveryId,
    sourceText: enumText(row.sourceEnumId),
    toText: maskedAddress(row.toAddress),
    stateEnumId: row.stateEnumId,
    stateText: enumText(row.stateEnumId),
    exception: deliveryExceptions.includes(row.stateEnumId),
    attempts: num(row.attempts),
    lastError: row.lastError ? String(row.lastError).slice(0, 200) : "",
    createdText: dateText(row.createdDate),
    sentText: dateText(row.sentDate),
    orderId: deliveryOrders[row.sourceEnumId]?.(row.eventKey) || null
})

// ===== find#StoreDeliveries =====
// The store's notices on the delivery ledger, exceptions (failed, uncertain, waiting to retry) unless all is asked, newest
// first; read only here (impl-shop F91).
function findStoreDeliveries(p) {
    const s = scope()
    const storeIds = storesFor(s, p.productStoreId)
    let query = find(DELIVERY).condition("productStoreId", "in", storeIds)
    if (p.state !== "all") query = query.condition("stateEnumId", "in", deliveryExceptions)
    const count = query.count()
    let again = find(DELIVERY).condition("productStoreId", "in", storeIds)
    if (p.state !== "all") again = again.condition("stateEnumId", "in", deliveryExceptions)
    const page = lib.page(again.orderBy("-createdDate"), p, "deliveries", count)
    return Object.assign({}, page, {deliveries: page.rows.map(deliveryRow), rows: undefined})
}

// ===== reorder#StoreOrder (Order again, R-COM-W04) =====
// A new open order of the same store and customer with the order's product lines (clone#Order with copyPayment false, its
// product items only, no promotion lines), each repriced at today's price (recalc#OrderPartItemAmounts, since the clone
// keeps each item's unitAmount, F43), then its promotions, shipping and tax (handle#OrderMajorChange). The new order is a
// cart until someone places it; nothing is charged. COMMERCE_ORDER_VIEW and the store's scope.
function reorderStoreOrder(p) {
    const s = scope()
    const order = storeOrder(s, p.orderId, false)
    // keyed by its operation (a double submit or retry answers the first new order) and named by the order's revision
    const op = lib.operation(p, "StoreReorder", one(STORE, {productStoreId: order.productStoreId})?.organizationPartyId || null, {
        orderId: order.orderId
    })
    const again = lib.previous(op)
    if (again) return again
    const revision = order.orderRevision ?? 1
    if (p.orderRevision != null && p.orderRevision !== "" && Number(p.orderRevision) !== Number(revision))
        denied("STALE_REVISION", "Order " + order.orderId + " changed since; its current revision is " + revision)
    if (!placedStatuses.includes(order.statusId)) denied("ORDER_NOT_PLACED", "Order " + order.orderId + " was not placed")
    if (!customersOf(order.orderId).length) denied("CUSTOMER_REQUIRED", "Order " + order.orderId + " has no customer")
    const cloned = call("mantle.order.OrderServices.clone#Order", {
        baseOrderId: order.orderId,
        copyPayment: false,
        productItemsOnly: true,
        copyItemWorkEffort: false,
        salesChannelEnumId: order.salesChannelEnumId || null,
        externalId: null,
        displayId: null
    })
    const orderId = cloned.orderId
    for (const part of rows(PART, {orderId})) {
        if (part.statusId !== "OrderOpen")
            call("update#" + PART, {orderId, orderPartSeqId: part.orderPartSeqId, statusId: "OrderOpen"})
        // the clone's promotion lines are recomputed, never copied
        for (const item of rows(ITEM, {orderId, orderPartSeqId: part.orderPartSeqId, isPromo: "Y"}))
            call("mantle.order.OrderServices.delete#OrderItem", {orderId, orderItemSeqId: item.orderItemSeqId})
        // what was cancelled is not ordered again: a line cancelled in full is dropped, the rest carry what was kept
        for (const item of rows(ITEM, {orderId, orderPartSeqId: part.orderPartSeqId})) {
            if (!num(item.quantityCancelled)) continue
            const kept = num(item.quantity) - num(item.quantityCancelled)
            if (kept <= 0) call("mantle.order.OrderServices.delete#OrderItem", {orderId, orderItemSeqId: item.orderItemSeqId})
            else call("update#" + ITEM, {orderId, orderItemSeqId: item.orderItemSeqId, quantity: kept, quantityCancelled: null})
        }
        call("mantle.order.OrderServices.recalc#OrderPartItemAmounts", {orderId, orderPartSeqId: part.orderPartSeqId})
        call("mantle.order.OrderServices.handle#OrderMajorChange", {orderId, orderPartSeqId: part.orderPartSeqId})
    }
    const made = one(ORDER, {orderId})
    const answer = {
        orderId,
        baseOrderId: order.orderId,
        totalText: moneyText(made.grandTotal ?? 0, made.currencyUomId),
        message: "Order " + orderId + " is a new open order of order " + order.orderId + "'s lines at today's prices"
    }
    lib.complete(op, ORDER, orderId, answer)
    return answer
}

// ===== carts =====
// The store's abandonment delay: its RecoveryPolicy's (Commerce P10), an hour by default; read once a store per call (facts).
function delayMinutes(facts, productStoreId) {
    if (Object.hasOwn(facts.delays, productStoreId)) return facts.delays[productStoreId]
    let minutes = limits.abandonMinutes
    try {
        minutes = ec.resource.script("component://mr-mantle/service/mantle/order/CartRecovery.js").delayOf(productStoreId)
    } catch (error) {
        ec.logger.warn("Cart recovery delay of store " + productStoreId + " not read: " + error.message)
    }
    facts.delays[productStoreId] = minutes
    return minutes
}
function cartFacts(orderIds) {
    return {
        access: rowsIn(CART, "orderId", orderIds),
        checkouts: rowsIn(CHECKOUT, "orderId", orderIds),
        delays: {}
    }
}
function cartRow(order, facts) {
    const access = facts.access
        .filter(row => row.orderId === order.orderId)
        .sort((a, b) => (ms(b.lastActivityDate) ?? 0) - (ms(a.lastActivityDate) ?? 0))[0]
    const checkout = facts.checkouts
        .filter(row => row.orderId === order.orderId)
        .sort((a, b) => (ms(b.createdDate) ?? 0) - (ms(a.createdDate) ?? 0))[0]
    const activityMs = ms(access?.lastActivityDate)
    const live = !!checkout && liveCheckoutStatuses.includes(checkout.statusId)
    const abandoned = activityMs != null && !live && nowMs() - activityMs > delayMinutes(facts, order.productStoreId) * 60000
    const customerIds = customersOf(order.orderId)
    // a guest's cart (no signed-in account) shows no invented identity
    const signedIn = !!access?.customerPartyId
    const names = lib.partyNames(signedIn ? [access.customerPartyId] : customerIds)
    const lines = rows(ITEM, {orderId: order.orderId}).filter(item => item.productId && item.isPromo !== "Y")
    return {
        orderId: order.orderId,
        productStoreId: order.productStoreId,
        storeName: storeName(order.productStoreId),
        customerPartyId: signedIn ? access.customerPartyId : access ? null : customerIds[0] || null,
        customerText: signedIn
            ? names[access.customerPartyId] || "Customer"
            : access
              ? "Guest"
              : customerIds.map(id => names[id] || "Customer").join(", ") || "No customer",
        lineCount: lines.length,
        quantityText: quantityText(lines.reduce((total, item) => total + num(item.quantity), 0)),
        totalText: moneyText(order.grandTotal ?? 0, order.currencyUomId),
        activityText: activityMs != null ? dateText(access.lastActivityDate) : "",
        madeByStaff: !access,
        sourceText: access ? "Shop" : "Staff",
        checkoutText: checkout ? statusText(checkout.statusId) : "",
        stuck: !!checkout && stuck(checkout),
        abandoned,
        stateText:
            checkout && stuck(checkout)
                ? "Placement waiting"
                : live
                  ? "Checking out"
                  : abandoned
                    ? "Abandoned"
                    : access?.revokedDate
                      ? "Closed"
                      : "Active"
    }
}
// find#StoreCarts: the open orders of the user's stores (or one), latest activity first, by state (active, abandoned,
// checkout, stuck, staff), customer and id or name.
function findStoreCarts(p) {
    const s = scope()
    const storeIds = storesFor(s, p.productStoreId)
    let query = s.own(find(ORDER, {statusId: "OrderOpen"}).condition("productStoreId", "in", storeIds))
    if (text(p.term)) query = query.condition(termCondition(["orderId", "orderName"], text(p.term)))
    if (p.customerPartyId)
        query = query.condition(
            "orderId",
            "in",
            unique(
                Array.from(find(PART, {customerPartyId: p.customerPartyId}).selectField("orderId").limit(limits.ids).list()).map(
                    row => row.orderId
                )
            )
        )
    const candidates = Array.from(query.orderBy("-entryDate").limit(limits.ids).list())
    const facts = cartFacts(candidates.map(order => order.orderId))
    const lastActivity = row => ms(facts.access.find(a => a.orderId === row.orderId)?.lastActivityDate) ?? ms(row.entryDate) ?? 0
    const states = {
        active: row => row.stateText === "Active",
        abandoned: row => row.abandoned,
        checkout: row => row.stateText === "Checking out",
        stuck: row => row.stuck,
        staff: row => row.madeByStaff
    }
    if (p.state && !Object.hasOwn(states, p.state)) denied("VALUE_INVALID", "Unknown cart state " + p.state)
    const shaped = candidates
        .sort((a, b) => lastActivity(b) - lastActivity(a))
        .map(order => cartRow(order, facts))
        .filter(row => !p.state || states[p.state](row))
    return Object.assign(lib.pageList(shaped, p, "carts"), {truncated: candidates.length >= limits.ids})
}
// get#StoreCart (CartDetail's CartSummary): the cart's lines and totals, its activity, store and checkout phase; read only
// (an active checkout is never a staff-editable draft). Recovery history is Commerce P10's.
function getStoreCart(p) {
    const s = scope()
    const order = storeOrder(s, p.orderId, true)
    const facts = cartFacts([order.orderId])
    const row = cartRow(order, facts)
    const lines = rows(ITEM, {orderId: order.orderId})
        .sort((a, b) => String(a.orderItemSeqId).localeCompare(String(b.orderItemSeqId)))
        .slice(0, limits.detail)
        .map(item => ({
            orderItemSeqId: item.orderItemSeqId,
            description: item.itemDescription || productName(item.productId),
            itemTypeText: enumText(item.itemTypeEnumId),
            quantityText: item.productId ? quantityText(item.quantity) : "",
            unitText: moneyText(item.unitAmount ?? 0, order.currencyUomId),
            amountText: moneyText(
                toDecimal(num(item.quantity) || 1).multiply(toDecimal(item.unitAmount ?? 0)),
                order.currencyUomId
            )
        }))
    const checkout = facts.checkouts.sort((a, b) => (ms(b.createdDate) ?? 0) - (ms(a.createdDate) ?? 0))[0]
    const access = facts.access[0]
    return {
        cart: Object.assign(row, {entryText: dateText(order.entryDate), currencyUomId: order.currencyUomId}),
        lines,
        checkout: checkout
            ? {
                  checkoutId: checkout.checkoutId,
                  statusText: statusText(checkout.statusId),
                  open: openCheckoutStatuses.includes(checkout.statusId),
                  stuck: stuck(checkout),
                  failureText: checkout.failureMessage || "",
                  tries: num(checkout.placementTries),
                  dueText: checkout.dueAmount != null ? moneyText(checkout.dueAmount, checkout.currencyUomId) : "",
                  paymentText: checkout.paymentId ? statusText(one(PAYMENT, {paymentId: checkout.paymentId})?.statusId) : "",
                  frozenText: dateText(checkout.frozenDate),
                  siteId: checkout.siteId
              }
            : null,
        access: access
            ? {
                  siteId: access.siteId,
                  createdText: dateText(access.createdDate),
                  activityText: dateText(access.lastActivityDate),
                  closedText: access.revokedDate ? dateText(access.revokedDate) + " · " + enumText(access.revokeReasonEnumId) : ""
              }
            : null,
        recovery: []
    }
}

// ===== find#StoreReturns =====
// The returns whose lines come from the user's stores' orders (or one store's), Requested first then newest, by status,
// customer and id or source order.
function findStoreReturns(p) {
    const s = scope()
    const storeIds = storesFor(s, p.productStoreId)
    let query = s.own(find("mantle.order.return.StoreReturnItemView").condition("productStoreId", "in", storeIds))
    if (p.statusId) query = query.condition("statusId", p.statusId)
    if (p.customerPartyId) query = query.condition("customerPartyId", p.customerPartyId)
    if (text(p.term)) query = query.condition(termCondition(["returnId", "orderId"], text(p.term)))
    const found = Array.from(query.selectField("returnId").selectField("productStoreId").distinct(true).limit(limits.ids).list())
    const returnIds = unique(found.map(row => row.returnId))
    const headers = rowsIn("mantle.order.return.ReturnHeader", "returnId", returnIds).sort(
        (a, b) =>
            (a.statusId === "ReturnRequested" ? 0 : 1) - (b.statusId === "ReturnRequested" ? 0 : 1) ||
            (ms(b.entryDate) ?? 0) - (ms(a.entryDate) ?? 0)
    )
    const names = lib.partyNames(headers.map(row => row.customerPartyId))
    const shaped = headers.map(header => {
        const items = rows("mantle.order.return.ReturnItem", {returnId: header.returnId})
        const sum = field => items.reduce((total, item) => total + num(item[field]), 0)
        const orderIds = unique(items.map(item => item.orderId))
        const store = found.find(row => row.returnId === header.returnId)?.productStoreId
        return {
            returnId: header.returnId,
            displayId: header.displayId || header.returnId,
            customerPartyId: header.customerPartyId,
            customerName: names[header.customerPartyId] || "Customer",
            orderId: orderIds[0] || null,
            orderText: orderIds.join(", "),
            storeName: storeName(store),
            statusId: header.statusId,
            statusText: statusText(header.statusId),
            entryText: dateText(header.entryDate),
            requestedText: quantityText(sum("returnQuantity")),
            receivedText: quantityText(sum("receivedQuantity")),
            settledText: items.some(item => item.refundPaymentId || item.finAccountTransId || item.replacementOrderId)
                ? "Settled"
                : header.statusId === "ReturnCompleted"
                  ? "Completed"
                  : "Not settled"
        }
    })
    return Object.assign(lib.pageList(shaped, p, "returns"), {truncated: found.length >= limits.ids})
}
// get#StoreReturn (ReturnDetail's Commerce branch): a return of the user's stores' orders, read only: its lines with what was
// asked, received and how each is settled; Customer Service authorizes it, Accounting settles it.
function getStoreReturn(p) {
    const s = scope()
    const header = p.returnId ? one("mantle.order.return.ReturnHeader", {returnId: p.returnId}) : null
    const items = header ? rows("mantle.order.return.ReturnItem", {returnId: header.returnId}) : []
    const orders = rowsIn(ORDER, "orderId", unique(items.map(item => item.orderId)))
    if (!header || !orders.length || !orders.every(order => s.storeIds.includes(order.productStoreId) && s.owned(order.orderId)))
        unavailable("Return", p.returnId)
    const names = lib.partyNames([header.customerPartyId])
    return {
        returnHeader: {
            returnId: header.returnId,
            displayId: header.displayId || header.returnId,
            customerPartyId: header.customerPartyId,
            customerName: names[header.customerPartyId] || "Customer",
            statusId: header.statusId,
            statusText: statusText(header.statusId),
            entryText: dateText(header.entryDate),
            storeName: storeName(orders[0].productStoreId),
            orderIds: orders.map(order => order.orderId)
        },
        items: items.slice(0, limits.detail).map(item => ({
            returnItemSeqId: item.returnItemSeqId,
            description: item.description || productName(item.productId),
            orderId: item.orderId,
            reasonText: enumText(item.returnReasonEnumId),
            responseText: enumText(item.returnResponseEnumId),
            statusText: statusText(item.statusId),
            requestedText: quantityText(item.returnQuantity),
            receivedText: quantityText(item.receivedQuantity ?? 0),
            settlementText: item.refundPaymentId
                ? "Refunded"
                : item.finAccountTransId
                  ? "Credited"
                  : item.replacementOrderId
                    ? "Replaced by order " + item.replacementOrderId
                    : "Not settled"
        }))
    }
}

// ===== customers =====
// A customer is the store's when it is the customer of an order or the account of a signed-in cart in the user's stores
// (one of them, when given); an internal organization never is.
function customerStoreIds(s, partyId, storeIds) {
    if (!partyId || !storeIds.length) return []
    const ordered = Array.from(
        s
            .own(find("mantle.order.OrderHeaderAndPart", {customerPartyId: partyId}))
            .condition("productStoreId", "in", storeIds)
            .selectField("productStoreId")
            .distinct(true)
            .list()
    ).map(row => row.productStoreId)
    const carts = Array.from(
        find(CART, {customerPartyId: partyId})
            .condition("productStoreId", "in", storeIds)
            .selectField("productStoreId")
            .distinct(true)
            .list()
    ).map(row => row.productStoreId)
    return unique(ordered.concat(carts))
}
const isInternal = partyId => !!one("mantle.party.PartyRole", {partyId, roleTypeId: "OrgInternal"})
// the customer's PASS account: none, a guest, an account and whether its current email is verified and gives the
// customer self access (an enabled account that is no one's staff, its current email verified; ExternalAccess.selfOf's rule)
function accountState(partyId) {
    const account = rows("moqui.security.UserAccount", {partyId})[0]
    if (!account) return {key: "guest", text: "Guest", verified: false, selfAccess: false}
    const email = text(account.emailAddress).toLowerCase()
    const verified =
        !!email &&
        rows("moqui.security.public.VerifiedAddress", {userId: account.userId}).some(
            row => !!row.verifiedAt && text(row.emailAddress).toLowerCase() === email
        )
    const staff = rows("mantle.party.PartyRelationship", {fromPartyId: partyId}).some(
        row =>
            ["PrtEmployee", "PrtAgent", "PrtMember", "PrtRepresentative"].includes(row.relationshipTypeEnumId) &&
            lib.active(row) &&
            isInternal(row.toPartyId)
    )
    const disabled = account.disabled === "Y"
    return {
        key: disabled ? "disabled" : verified ? "verified" : "unverified",
        text: disabled ? "Account disabled" : verified ? "Verified account" : "Account, email not verified",
        verified,
        selfAccess: !disabled && verified && !staff
    }
}
// find#StoreCustomers: the customers of the user's stores (or one), by name or id; most recent order first.
function findStoreCustomers(p) {
    const s = scope()
    const storeIds = storesFor(s, p.productStoreId)
    if (!storeIds.length) return lib.pageList([], p, "customers")
    const fromOrders = Array.from(
        s
            .own(find("mantle.order.OrderHeaderAndPart"))
            .condition("productStoreId", "in", storeIds)
            .condition("customerPartyId", "is-not-null", null)
            .selectField("customerPartyId")
            .distinct(true)
            .limit(limits.ids)
            .list()
    ).map(row => row.customerPartyId)
    const fromCarts = Array.from(
        find(CART)
            .condition("productStoreId", "in", storeIds)
            .condition("customerPartyId", "is-not-null", null)
            .selectField("customerPartyId")
            .distinct(true)
            .limit(limits.ids)
            .list()
    ).map(row => row.customerPartyId)
    let ids = unique(fromOrders.concat(fromCarts)).filter(partyId => !isInternal(partyId))
    if (text(p.term) && ids.length)
        ids = Array.from(
            find("mantle.party.PartyDetail")
                .condition("partyId", "in", ids)
                .condition(termCondition(["partyId", "pseudoId", "organizationName", "firstName", "lastName"], text(p.term)))
                .selectField("partyId")
                .list()
        ).map(row => row.partyId)
    const names = lib.partyNames(ids)
    const shaped = ids
        .filter(partyId => names[partyId])
        .map(partyId => {
            const orders = Array.from(
                s
                    .own(find("mantle.order.OrderHeaderAndPart", {customerPartyId: partyId}))
                    .condition("productStoreId", "in", storeIds)
                    .orderBy("-entryDate")
                    .limit(limits.detail)
                    .list()
            )
            const placed = orders.filter(order => order.statusId !== "OrderOpen")
            const state = accountState(partyId)
            const last = placed.sort((a, b) => (ms(b.placedDate) ?? 0) - (ms(a.placedDate) ?? 0))[0]
            return {
                partyId,
                customerName: names[partyId],
                storeText: unique(orders.map(order => order.productStoreId))
                    .map(storeName)
                    .join(", "),
                orderCount: unique(placed.map(order => order.orderId)).length,
                openCartCount: unique(orders.filter(order => order.statusId === "OrderOpen").map(order => order.orderId)).length,
                lastOrderId: last?.orderId || null,
                lastOrderText: last ? dateText(last.placedDate || last.entryDate) : "",
                lastOrderMs: ms(last?.placedDate) ?? 0,
                accountText: state.text
            }
        })
        .sort((a, b) => b.lastOrderMs - a.lastOrderMs || a.customerName.localeCompare(b.customerName))
    return Object.assign(lib.pageList(shaped, p, "customers"), {truncated: fromOrders.length >= limits.ids})
}
// get#StoreCustomer (Customer360's Commerce branch): a customer of the user's stores, its store relationships, PASS account
// state, current addresses and masked payment methods, and its carts, orders, cases and returns in those stores. No
// password, no impersonation, no card number beyond its last four.
function getStoreCustomer(p) {
    const s = scope()
    const partyId = text(p.customerPartyId)
    const party = partyId ? one("mantle.party.Party", {partyId}) : null
    const storeIds = party && !isInternal(partyId) ? customerStoreIds(s, partyId, s.storeIds) : []
    if (!party || party.disabled === "Y" || !storeIds.length) unavailable("Customer", partyId)
    const names = lib.partyNames([partyId])
    const orders = Array.from(
        s
            .own(find(ORDER))
            .condition("productStoreId", "in", storeIds)
            .condition(
                "orderId",
                "in",
                unique(
                    Array.from(find(PART, {customerPartyId: partyId}).selectField("orderId").limit(limits.ids).list()).map(
                        r => r.orderId
                    )
                )
            )
            .orderBy("-entryDate")
            .limit(limits.detail)
            .list()
    )
    const ids = orders.map(order => order.orderId)
    const facts = {holds: openHolds(ids), cancels: cancelRequests(ids)}
    const placed = orders.filter(order => order.statusId !== "OrderOpen").map(order => orderRow(order, facts))
    const cartOrders = orders.filter(order => order.statusId === "OrderOpen")
    const carts = cartOrders.map(order => cartRow(order, cartFacts(cartOrders.map(o => o.orderId))))
    const addresses = Array.from(
        find("mantle.party.contact.PartyContactMechPostalAddress", {partyId})
            .conditionDate("fromDate", "thruDate", ec.user.nowTimestamp)
            .limit(limits.detail)
            .list()
    ).map(row => ({
        contactMechId: row.contactMechId,
        purposeText: enumText(row.contactMechPurposeId) || row.contactMechPurposeId || "",
        addressText: [row.address1, row.address2, row.city, row.stateProvinceGeoId, row.postalCode, row.countryGeoId]
            .filter(Boolean)
            .join(", ")
    }))
    const methods = Array.from(
        find("mantle.account.method.PaymentMethod", {ownerPartyId: partyId})
            .condition("thruDate", "is-null", null)
            .limit(limits.detail)
            .list()
    ).map(method => {
        const card = one("mantle.account.method.CreditCard", {paymentMethodId: method.paymentMethodId})
        const last4 = card?.cardNumber ? String(card.cardNumber).replace(/\D/g, "").slice(-4) : ""
        return {
            paymentMethodId: method.paymentMethodId,
            label:
                [
                    card?.creditCardTypeEnumId ? enumText(card.creditCardTypeEnumId) : enumText(method.paymentMethodTypeEnumId),
                    last4 ? "ending " + last4 : ""
                ]
                    .filter(Boolean)
                    .join(" ") || "Payment method"
        }
    })
    const emails = Array.from(
        find("mantle.party.contact.PartyContactMechInfo", {partyId, contactMechTypeEnumId: "CmtEmailAddress"})
            .conditionDate("fromDate", "thruDate", ec.user.nowTimestamp)
            .limit(5)
            .list()
    ).map(row => row.infoString)
    const requests = requestRows(requestIdsOf(s, storeIds, partyId).slice(0, limits.detail))
    const returnIds = unique(
        Array.from(
            s
                .own(find("mantle.order.return.StoreReturnItemView", {customerPartyId: partyId}))
                .condition("productStoreId", "in", storeIds)
                .selectField("returnId")
                .distinct(true)
                .limit(limits.detail)
                .list()
        ).map(row => row.returnId)
    )
    const returns = rowsIn("mantle.order.return.ReturnHeader", "returnId", returnIds).map(row => ({
        returnId: row.returnId,
        statusText: statusText(row.statusId),
        entryText: dateText(row.entryDate)
    }))
    const state = accountState(partyId)
    return {
        customer: {
            partyId,
            pseudoId: party.pseudoId || partyId,
            customerName: names[partyId] || "Customer",
            storeIds,
            storeText: storeIds.map(storeName).join(", "),
            accountText: state.text,
            emailVerified: state.verified,
            selfAccess: state.selfAccess,
            emailText: emails.join(", ")
        },
        addresses,
        methods,
        orders: placed,
        carts,
        requests,
        returns,
        // P12 (Subscriptions)
        subscriptions: []
    }
}

// ===== requests =====
// The support cases of the stores: Request.productStoreId, linked to one of their orders, or filed in a store's checkout
// support queue (PsstCheckoutSupportQueue), optionally of one customer; ids only, at most limits.ids.
function requestIdsOf(s, storeIds, customerPartyId) {
    if (!storeIds.length) return []
    const byStore = Array.from(
        find(REQUEST).condition("productStoreId", "in", storeIds).selectField("requestId").limit(limits.ids).list()
    ).map(row => row.requestId)
    const byOrder = Array.from(
        s
            .own(find("mantle.request.StoreRequestOrderView", {recordEntityName: ORDER}))
            .condition("productStoreId", "in", storeIds)
            .selectField("requestId")
            .distinct(true)
            .limit(limits.ids)
            .list()
    ).map(row => row.requestId)
    const queues = unique(
        rowsIn("mantle.product.store.ProductStoreSetting", "productStoreId", storeIds, {
            settingTypeEnumId: "PsstCheckoutSupportQueue"
        })
            .filter(row => lib.active(row))
            .map(row => row.settingValue)
    )
    const byQueue = queues.length
        ? Array.from(
              find(REQUEST).condition("requestCategoryId", "in", queues).selectField("requestId").limit(limits.ids).list()
          ).map(row => row.requestId)
        : []
    let ids = unique(byStore.concat(byOrder, byQueue))
    // cases only (a CaseProfile): order changes, purchase and project requests are not the store's cases
    ids = ids.length
        ? Array.from(
              find("mantle.request.support.CaseProfile").condition("requestId", "in", ids).selectField("requestId").list()
          ).map(row => row.requestId)
        : []
    if (customerPartyId && ids.length)
        ids = unique(
            Array.from(
                find("mantle.request.RequestParty", {partyId: customerPartyId, roleTypeId: "Customer"})
                    .condition("requestId", "in", ids)
                    .selectField("requestId")
                    .list()
            ).map(row => row.requestId)
        )
    return ids
}
function requestRows(requestIds) {
    const requests = rowsIn(REQUEST, "requestId", requestIds).sort((a, b) => (ms(b.requestDate) ?? 0) - (ms(a.requestDate) ?? 0))
    const parties = rowsIn("mantle.request.RequestParty", "requestId", requestIds).filter(row => lib.active(row))
    const names = lib.partyNames(parties.map(row => row.partyId))
    const links = rowsIn("mantle.request.RequestRecord", "requestId", requestIds, {recordEntityName: ORDER})
    return requests.map(request => {
        const of = role => parties.filter(row => row.requestId === request.requestId && row.roleTypeId === role)
        const customer = of("Customer")[0]
        const category = request.requestCategoryId
            ? one("mantle.request.RequestCategory", {requestCategoryId: request.requestCategoryId})
            : null
        const orderIds = unique(links.filter(row => row.requestId === request.requestId).map(row => row.recordId))
        return {
            requestId: request.requestId,
            requestName: request.requestName || "",
            customerPartyId: customer?.partyId || null,
            customerName: customer ? names[customer.partyId] || "Customer" : "",
            orderId: orderIds[0] || null,
            statusId: request.statusId,
            statusText: statusText(request.statusId),
            open: !closedRequestStatuses.includes(request.statusId),
            queueText: category?.description || "",
            assigneeText: of("Assignee")
                .map(row => names[row.partyId] || "")
                .filter(Boolean)
                .join(", "),
            dueText: dateText(request.responseRequiredDate),
            dateText: dateText(request.requestDate),
            storeName: storeName(request.productStoreId)
        }
    })
}
// find#StoreRequests: the cases of the user's stores (or one), newest first, by status (open by default; all), customer and
// id or subject.
function findStoreRequests(p) {
    const s = scope()
    const storeIds = storesFor(s, p.productStoreId)
    let ids = requestIdsOf(s, storeIds, p.customerPartyId || null)
    if (ids.length && (text(p.term) || p.state !== "all" || p.statusId)) {
        let query = find(REQUEST).condition("requestId", "in", ids)
        if (text(p.term)) query = query.condition(termCondition(["requestId", "requestName"], text(p.term)))
        if (p.statusId) query = query.condition("statusId", p.statusId)
        else if (p.state !== "all") query = query.condition("statusId", "not-in", closedRequestStatuses)
        ids = Array.from(query.selectField("requestId").list()).map(row => row.requestId)
    }
    return Object.assign(lib.pageList(requestRows(ids), p, "requests"), {truncated: ids.length >= limits.ids})
}
// a case of the user's stores
// a case of the user's stores, checked on the case itself (the lists' rule: its store, a link to a store order, or a store's
// support queue)
function storeRequest(s, requestId) {
    const request = requestId ? one(REQUEST, {requestId}) : null
    const isCase = !!request && !!one("mantle.request.support.CaseProfile", {requestId})
    const ofStore = () =>
        s.storeIds.includes(request.productStoreId) ||
        rows("mantle.request.RequestRecord", {requestId, recordEntityName: ORDER}).some(
            link => s.owned(link.recordId) && s.storeIds.includes(one(ORDER, {orderId: link.recordId})?.productStoreId)
        ) ||
        (!!request.requestCategoryId &&
            rowsIn("mantle.product.store.ProductStoreSetting", "productStoreId", s.storeIds, {
                settingTypeEnumId: "PsstCheckoutSupportQueue",
                settingValue: request.requestCategoryId
            }).some(row => lib.active(row)))
    if (!isCase || !ofStore()) unavailable("Case", requestId)
    return request
}
// get#StoreRequest (RequestDetail's Commerce branch): a case of the user's stores, read only, with its conversation (its
// messages and internal notes, newest first); Customer Service works it.
function getStoreRequest(p) {
    const s = scope()
    const request = storeRequest(s, p.requestId)
    const row = requestRows([request.requestId])[0]
    const eventIds = rows("mantle.request.RequestCommEvent", {requestId: request.requestId}).map(r => r.communicationEventId)
    const events = rowsIn("mantle.party.communication.CommunicationEvent", "communicationEventId", eventIds)
        .sort((a, b) => (ms(b.entryDate) ?? 0) - (ms(a.entryDate) ?? 0))
        .slice(0, limits.detail)
    const names = lib.partyNames(events.map(event => event.fromPartyId))
    return {
        request: Object.assign(row, {description: request.description || ""}),
        conversation: events.map(event => ({
            communicationEventId: event.communicationEventId,
            kindText:
                event.communicationEventTypeId === "Comment"
                    ? "Internal note"
                    : enumText(event.contactMechTypeEnumId) || "Message",
            note: event.communicationEventTypeId === "Comment",
            fromText: names[event.fromPartyId] || "",
            dateText: dateText(event.entryDate),
            subject: event.subject || "",
            body: event.body || ""
        }))
    }
}
// add#StoreRequestNote: an internal note on a case of the user's stores (a Comment, never sent to the customer); the
// case's other actions stay Customer Service's.
function addStoreRequestNote(p) {
    const s = scope()
    const request = storeRequest(s, p.requestId)
    const body = text(p.body)
    if (!body) denied("VALUE_REQUIRED", "The note is empty")
    if (body.length > 4000) denied("VALUE_INVALID", "A note is at most 4000 characters")
    const out = call("mantle.request.RequestServices.add#RequestComment", {
        requestId: request.requestId,
        subject: "Note from Commerce",
        body
    })
    return {communicationEventId: out.communicationEventId}
}

// ===== get#StoreWorkSummary (Home's WorkCards) =====
// The work counts of the user's stores (or one): to approve (placed, not yet approved), payment holds, to fulfill
// (approved, not completed), unpaid (of the recent submitted orders, computed), open carts, stuck placements and notice
// exceptions; each card opens the scoped list. COMMERCE_VIEW; the recent orders only for COMMERCE_ORDER_VIEW.
function getStoreWorkSummary(p) {
    const s = scope("view")
    const storeIds = storesFor(s, p.productStoreId)
    const count = (conditions, extra) => {
        if (!storeIds.length) return 0
        let query = s.own(find(ORDER, conditions).condition("productStoreId", "in", storeIds))
        if (extra) query = extra(query)
        return Number(query.count())
    }
    const counts = {}
    const each = (key, compute) => {
        try {
            counts[key] = compute()
        } catch (error) {
            // one source that fails is named, the others still count
            ec.logger.error("Store work count " + key + " failed: " + error.message)
            counts[key] = null
        }
    }
    each("toApprove", () => count({statusId: "OrderPlaced"}))
    each("paymentHolds", () => heldOrderIds(storeIds, "OhtPayment").filter(s.owned).length)
    each("toFulfill", () => count({statusId: "OrderApproved"}))
    each("openCarts", () => count({statusId: "OrderOpen"}))
    each("stuckPlacements", () => stuckCheckouts(storeIds).filter(row => s.owned(row.orderId)).length)
    each("noticeExceptions", () =>
        storeIds.length
            ? Number(
                  find(DELIVERY)
                      .condition("productStoreId", "in", storeIds)
                      .condition("stateEnumId", "in", deliveryExceptions)
                      .count()
              )
            : 0
    )
    each("unpaid", () => {
        if (!storeIds.length) return 0
        const recent = Array.from(
            s
                .own(find(ORDER))
                .condition("productStoreId", "in", storeIds)
                .condition("statusId", "in", ["OrderPlaced", "OrderApproved", "OrderSent", "OrderHold", "OrderProcessing"])
                .orderBy("-placedDate")
                .limit(limits.ids)
                .list()
        )
        const holds = openHolds(recent.map(order => order.orderId))
        return recent.filter(order =>
            ["unpaid", "promised"].includes(
                paymentState(
                    order,
                    holds.filter(h => h.orderId === order.orderId)
                ).key
            )
        ).length
    })
    let recentOrders = []
    if (s.canOrders && storeIds.length) {
        const list = Array.from(
            s
                .own(find(ORDER))
                .condition("productStoreId", "in", storeIds)
                .condition("statusId", "!=", "OrderOpen")
                .orderBy("-placedDate")
                .orderBy("-entryDate")
                .limit(limits.recent)
                .list()
        )
        const ids = list.map(order => order.orderId)
        const facts = {holds: openHolds(ids), cancels: cancelRequests(ids)}
        recentOrders = list.map(order => orderRow(order, facts))
    }
    return {counts, recentOrders, canOrders: s.canOrders}
}

// ===== call context (the Comms hooks, design §1.4) =====
// The open store orders and carts of the parties a caller's number names, in the user's stores, newest first.
function storeCallRecords(p) {
    const s = scope()
    const partyIds = unique(Array.from(p.partyIds || []))
    if (!partyIds.length || !s.storeIds.length) return {records: []}
    const orders = Array.from(
        s
            .own(find("mantle.order.OrderHeaderAndPart"))
            .condition("customerPartyId", "in", partyIds)
            .condition("productStoreId", "in", s.storeIds)
            .condition("statusId", "in", [
                "OrderOpen",
                "OrderPlaced",
                "OrderProcessing",
                "OrderApproved",
                "OrderSent",
                "OrderHold"
            ])
            .orderBy("-entryDate")
            .limit(10)
            .list()
    )
    const seen = new Set()
    return {
        records: orders
            .filter(order => !seen.has(order.orderId) && seen.add(order.orderId))
            .map(order => ({
                orderId: order.orderId,
                cart: order.statusId === "OrderOpen",
                statusText: statusText(order.statusId),
                storeName: storeName(order.productStoreId),
                totalText: moneyText(order.grandTotal ?? 0, order.currencyUomId)
            }))
    }
}

const operations = {
    findStoreOrders,
    getStoreOrder,
    reorderStoreOrder,
    findStoreCarts,
    getStoreCart,
    findStoreReturns,
    getStoreReturn,
    findStoreCustomers,
    getStoreCustomer,
    findStoreRequests,
    getStoreRequest,
    addStoreRequestNote,
    findStoreDeliveries,
    getStoreWorkSummary,
    storeCallRecords
}
;({
    // Commerce P10 (CartRecovery.js): the store scope and a cart of it, and a delivery's row as Commerce shows it
    scope,
    storeOrder,
    deliveryRow,
    // P11 (StoreReports.js): the placed statuses and the RecurringTemplate bases' condition (F112)
    placedStatuses,
    withoutRecurringBases,
    execute: (op, parameters) => {
        if (!operations[op]) throw new Error("Unknown store operation " + op)
        return operations[op](parameters || {})
    }
})
