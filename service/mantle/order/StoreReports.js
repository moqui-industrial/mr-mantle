// Store reports (impl-commerce P11, COM-REPORTS; design-commerce §3 CartRecovery and PromotionUse): the cart recovery funnel
// (StoreOperationsServices.get#CartRecoverySummary) and promotion use (StorePromotionServices.get#PromotionUseSummary) of the
// user's stores over a period, the registered report definitions' query that Commerce's Reports screens read.
//
// Each checks COMMERCE_VIEW and the store scope of StoreAdmin.js (the user's organizations; a store-limited staff member's
// own stores, F51; a store asked for outside it RECORD_UNAVAILABLE); an order of the user's stores vended by another
// organization is left out (F113, StoreOperations.js' scope). Amounts are per currency, never summed across currencies: a
// row is a store (or promotion and code) and a currency, and the totals are one row per currency. No customer is named.
//
// - Cart recovery: the cohort is the store's Shop carts opened in the period (StoreCartAccess.createdDate), each counted
//   once: opened; placed (its order placed or later); abandoned (sent a reminder, or still open, idle past the store's delay
//   and in no live checkout, or recovered); of those, signed in (a customer's cart, the only kind a reminder may go to;
//   consent is checked at each send); sends (the ledger's recovery deliveries of the cart, a suppressed one left out) and
//   delivered (sent); recovered (F130: the ledger keeps no "redeemed" fact, so the access row's recoveryUsedDate at or after
//   the cart's latest send, and the order then placed) and the recovered value (those orders' totals). An open cart is never
//   an order; a RecurringTemplate base is left out once Shop P7 marks it (F112, StoreOperations.js withoutRecurringBases).
// - Promotion use: the placed uses (the order's promotion lines in parts placed or later, placedDate in the period) of the
//   stores' promotions, by promotion, code and currency: orders, uses, the discount, the net sales of those orders (their
//   product lines less their discounts, as get#SalesOrderSummary's netSales) and, for a promotion or code with a total limit,
//   the uses left of it (every placed use, whatever the period).
// A read capped at its limit says so (truncated), never cut silently.
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const stores = ec.resource.script("component://mr-mantle/service/mantle/product/StoreAdmin.js")
const operations = () => ec.resource.script("component://mr-mantle/service/mantle/order/StoreOperations.js")
const recovery = () => ec.resource.script("component://mr-mantle/service/mantle/order/CartRecovery.js")
const {find, one, denied, ms, dateText} = lib

const CART = "mantle.order.StoreCartAccess"
const ORDER = "mantle.order.OrderHeader"
const CHECKOUT = "mantle.order.StoreCheckout"
const DELIVERY = "mantle.party.MessageDelivery"
const PROMOTION = "mantle.product.store.ProductStorePromotion"
const CODE = "mantle.product.store.ProductStorePromoCode"
const USES = "mantle.order.OrderItemAndPartSummary"
const limits = {carts: 5000, uses: 5000, period: 731}
const dayMs = 86400000
const liveCheckoutStatuses = ["ScoPaymentPending", "ScoPlacementPending"]
const discountTypes = [
    "ItemDiscount",
    "ItemPromptDiscount",
    "ItemCouponCredit",
    "ItemPromoDiscount",
    "ItemFreeFills",
    "ItemSlottingFees",
    "ItemAdjAdvertising",
    "ItemAdjJointAdv"
]

const unique = list => Array.from(new Set(list.filter(Boolean)))
const dec = value => toDecimal(value ?? 0)
// a number from a decimal or number (a decimal refuses valueOf, so never Number() of one)
const num = value =>
    value == null || value === "" ? 0 : typeof value?.toNumber === "function" ? value.toNumber() : Number(value)
function chunked(ids, read) {
    const out = []
    for (let index = 0; index < ids.length; index += 500) out.push(...read(ids.slice(index, index + 500)))
    return out
}
const rowsIn = (entity, field, ids, extra = query => query) =>
    chunked(ids, part => Array.from(extra(find(entity).condition(field, "in", part)).list()))

// The scope of a report: the user's stores (or those asked for, each refused outside the scope), the period [from, thru)
// (the last 30 days by default, at most two years) and its as-of time (now).
function scopeOf(p) {
    const s = operations().scope("view")
    const asked = unique(Array.from(p.productStoreIds || []).concat(p.productStoreId ? [p.productStoreId] : []))
    const storeIds = asked.length ? asked.map(id => stores.storeOf(s, id).productStoreId) : s.storeIds
    const now = Number(ms(ec.user.nowTimestamp))
    const thru = p.thruDate ? Number(ms(p.thruDate)) : now
    const from = p.fromDate ? Number(ms(p.fromDate)) : thru - 30 * dayMs
    if (!Number.isFinite(from) || !Number.isFinite(thru) || thru <= from)
        denied("PERIOD_INVALID", "Choose a period that ends after it starts")
    if (thru - from > limits.period * dayMs) denied("PERIOD_INVALID", "A report period is at most two years")
    return {s, storeIds, from, thru, asOf: Math.min(now, thru)}
}
const frame = scope => ({
    productStoreIds: scope.storeIds,
    fromDate: new Date(scope.from),
    thruDate: new Date(scope.thru),
    asOf: new Date(scope.asOf),
    periodText: dateText(new Date(scope.from)) + " – " + dateText(new Date(scope.thru))
})
// a store's or currency's row, made once and added to
function rowOf(map, key, make) {
    if (!map[key]) map[key] = make()
    return map[key]
}
function currencyTotals(rows, fields, amountFields) {
    const totals = {}
    for (const row of rows) {
        const total = rowOf(totals, row.currencyUomId || "", () => {
            const made = {currencyUomId: row.currencyUomId || null}
            for (const field of fields) made[field] = 0
            for (const field of amountFields) made[field] = dec(0)
            return made
        })
        for (const field of fields) total[field] += row[field] || 0
        for (const field of amountFields) total[field] = total[field].add(dec(row[field]))
    }
    return Object.values(totals).sort((a, b) => String(a.currencyUomId).localeCompare(String(b.currencyUomId)))
}

// ===== get#CartRecoverySummary =====
const recoveryCounts = ["opened", "placed", "abandoned", "signedIn", "sends", "delivered", "recovered"]
function cartRecoverySummary(p) {
    const scope = scopeOf(p)
    const {s, storeIds} = scope
    if (!storeIds.length) return Object.assign(frame(scope), {rows: [], totals: [], truncated: false})
    const carts = Array.from(
        find(CART)
            .condition("productStoreId", "in", storeIds)
            .condition("createdDate", ">=", new Date(scope.from))
            .condition("createdDate", "<", new Date(scope.thru))
            .orderBy("-createdDate")
            .limit(limits.carts + 1)
            .list()
    )
    const truncated = carts.length > limits.carts
    if (truncated) carts.length = limits.carts
    const orderIds = unique(carts.map(cart => cart.orderId)).filter(s.owned)
    const orders = Object.fromEntries(
        rowsIn(ORDER, "orderId", orderIds, query => operations().withoutRecurringBases(query)).map(order => [
            order.orderId,
            order
        ])
    )
    const live = new Set(
        rowsIn(CHECKOUT, "orderId", orderIds, query => query.condition("statusId", "in", liveCheckoutStatuses)).map(
            row => row.orderId
        )
    )
    // the recovery deliveries of the cohort's carts (made after the earliest cart; the event key names the cart)
    const sendsByOrder = {}
    const deliveries = Array.from(
        find(DELIVERY, {sourceEnumId: "MdsrcCartRecovery"})
            .condition("productStoreId", "in", storeIds)
            .condition("createdDate", ">=", new Date(scope.from))
            .list()
    )
    for (const row of deliveries) {
        const orderId = /^cartRecovery:([^:]+):/.exec(String(row.eventKey || ""))?.[1]
        if (orderId && orders[orderId]) (sendsByOrder[orderId] = sendsByOrder[orderId] || []).push(row)
    }
    const placed = operations().placedStatuses
    const delays = {}
    const delayOf = productStoreId =>
        (delays[productStoreId] = delays[productStoreId] ?? recovery().delayOf(productStoreId)) * 60000
    const byRow = {}
    for (const cart of carts) {
        const order = orders[cart.orderId]
        if (!order) continue
        const currencyUomId = cart.currencyUomId || order.currencyUomId || null
        const row = rowOf(byRow, cart.productStoreId + "|" + (currencyUomId || ""), () => {
            const made = {productStoreId: cart.productStoreId, currencyUomId, recoveredValue: dec(0)}
            for (const field of recoveryCounts) made[field] = 0
            return made
        })
        const sends = (sendsByOrder[order.orderId] || []).filter(send => send.stateEnumId !== "MdsSuppressed")
        const latestSend = Math.max(-Infinity, ...sends.map(send => Number(ms(send.sentDate ?? send.createdDate))))
        const isPlaced = placed.includes(order.statusId)
        const used = cart.recoveryUsedDate ? Number(ms(cart.recoveryUsedDate)) : null
        const recovered = isPlaced && used != null && sends.length > 0 && used >= latestSend
        const idle =
            order.statusId === "OrderOpen" &&
            !live.has(order.orderId) &&
            cart.lastActivityDate != null &&
            Number(ms(cart.lastActivityDate)) + delayOf(cart.productStoreId) <= scope.asOf
        const abandoned = sends.length > 0 || idle || recovered
        row.opened += 1
        if (isPlaced) row.placed += 1
        if (abandoned) row.abandoned += 1
        if (abandoned && cart.customerPartyId) row.signedIn += 1
        row.sends += sends.length
        row.delivered += sends.filter(send => send.stateEnumId === "MdsSent").length
        if (recovered) {
            row.recovered += 1
            row.recoveredValue = row.recoveredValue.add(dec(order.grandTotal))
        }
    }
    const rows = Object.values(byRow)
        .map(row =>
            Object.assign(row, {
                storeName:
                    one("mantle.product.store.ProductStore", {productStoreId: row.productStoreId})?.storeName ||
                    row.productStoreId
            })
        )
        .sort((a, b) => a.storeName.localeCompare(b.storeName) || String(a.currencyUomId).localeCompare(String(b.currencyUomId)))
    return Object.assign(frame(scope), {
        rows,
        totals: currencyTotals(rows, recoveryCounts, ["recoveredValue"]),
        truncated
    })
}

// ===== get#PromotionUseSummary =====
function promotionUseSummary(p) {
    const scope = scopeOf(p)
    const {s, storeIds} = scope
    if (!storeIds.length) return Object.assign(frame(scope), {rows: [], totals: [], truncated: false})
    let promotionQuery = find(PROMOTION).condition("productStoreId", "in", storeIds).useCache(false)
    if (p.storePromotionId) promotionQuery = promotionQuery.condition("storePromotionId", p.storePromotionId)
    const promotions = Object.fromEntries(Array.from(promotionQuery.list()).map(row => [row.storePromotionId, row]))
    if (p.storePromotionId && !promotions[p.storePromotionId])
        denied("RECORD_UNAVAILABLE", "Promotion " + p.storePromotionId + " is not available")
    const promotionIds = Object.keys(promotions)
    const placed = operations().placedStatuses
    const uses = rowsIn(USES, "storePromotionId", promotionIds, query =>
        s
            .own(query)
            .condition("statusId", "in", placed)
            .condition("placedDate", ">=", new Date(scope.from))
            .condition("placedDate", "<", new Date(scope.thru))
            .selectField("orderId")
            .selectField("storePromotionId")
            .selectField("promoCodeId")
            .selectField("promoCodeText")
            .selectField("promoTimesUsed")
            .selectField("itemTotal")
            .limit(limits.uses + 1)
    )
    const truncated = uses.length > limits.uses
    if (truncated) uses.length = limits.uses
    const orderIds = unique(uses.map(row => row.orderId))
    const orders = Object.fromEntries(rowsIn(ORDER, "orderId", orderIds).map(order => [order.orderId, order]))
    // each order's net sales: its product lines less its discounts, in the parts placed or later
    const net = {}
    for (const line of rowsIn(USES, "orderId", orderIds, query =>
        query.condition("statusId", "in", placed).selectField("orderId").selectField("itemTypeEnumId").selectField("itemTotal")
    ))
        if (line.itemTypeEnumId === "ItemProduct" || discountTypes.includes(line.itemTypeEnumId))
            net[line.orderId] = dec(net[line.orderId]).add(dec(line.itemTotal))
    const byRow = {}
    for (const use of uses) {
        const order = orders[use.orderId]
        if (!order) continue
        const row = rowOf(byRow, [use.storePromotionId, use.promoCodeId || "", order.currencyUomId || ""].join("|"), () => ({
            storePromotionId: use.storePromotionId,
            promoCodeId: use.promoCodeId || null,
            promoCode: use.promoCodeText || use.promoCodeId || "",
            currencyUomId: order.currencyUomId || null,
            orderIdSet: new Set(),
            useCount: 0,
            discount: dec(0),
            netSales: dec(0)
        }))
        if (!row.orderIdSet.has(use.orderId)) {
            row.orderIdSet.add(use.orderId)
            row.netSales = row.netSales.add(dec(net[use.orderId]))
        }
        row.useCount += num(use.promoTimesUsed)
        row.discount = row.discount.subtract(dec(use.itemTotal))
    }
    // the uses left of a total limit (every placed use, whatever the period)
    const allUses = (field, id) =>
        Array.from(
            s.own(find(USES).condition(field, id)).condition("statusId", "in", placed).selectField("promoTimesUsed").list()
        ).reduce((sum, row) => sum + num(row.promoTimesUsed), 0)
    const left = {}
    const leftOf = (key, limit, field, id) => {
        if (limit == null || limit === "") return null
        if (!(key in left)) left[key] = Math.max(0, num(limit) - allUses(field, id))
        return left[key]
    }
    const rows = Object.values(byRow).map(row => {
        const promotion = promotions[row.storePromotionId]
        const code = row.promoCodeId ? one(CODE, {promoCodeId: row.promoCodeId}) : null
        const out = Object.assign({}, row, {
            productStoreId: promotion.productStoreId,
            promotionName: promotion.itemDescription || row.storePromotionId,
            orderCount: row.orderIdSet.size,
            promotionUsesLeft: leftOf(
                "P" + row.storePromotionId,
                promotion.useLimitPerPromotion,
                "storePromotionId",
                row.storePromotionId
            ),
            codeUsesLeft: code ? leftOf("C" + code.promoCodeId, code.useLimitPerCode, "promoCodeId", code.promoCodeId) : null
        })
        delete out.orderIdSet
        return out
    })
    rows.sort(
        (a, b) =>
            a.promotionName.localeCompare(b.promotionName) ||
            String(a.promoCode).localeCompare(String(b.promoCode)) ||
            String(a.currencyUomId).localeCompare(String(b.currencyUomId))
    )
    // an order using two promotions is one order of its currency in the totals, its net sales once
    const totals = currencyTotals(rows, ["useCount"], ["discount"])
    for (const total of totals) {
        const ids = orderIds.filter(orderId => (orders[orderId]?.currencyUomId || null) === total.currencyUomId)
        total.orderCount = ids.length
        total.netSales = ids.reduce((sum, orderId) => sum.add(dec(net[orderId])), dec(0))
    }
    return Object.assign(frame(scope), {rows, totals, truncated})
}

const ops = {cartRecoverySummary, promotionUseSummary}
;({
    execute: (op, parameters) => {
        if (!ops[op]) throw new Error("Unknown store report " + op)
        return ops[op](parameters || {})
    }
})
