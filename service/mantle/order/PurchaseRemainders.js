// Purchasing's close of purchase order remainders (design-purchasing ClosePurchaseOrders, R-PUR-10; impl-warehouse P7):
// mantle.order.OrderServices.close#PurchaseRemainders checks PURCHASE_ORDER_EDIT and runs close(); Warehouse's
// WarehouseTaskServices.close#ReceiptRemainder runs remainders() inside its own operation, under its STOCK_RECEIVE check
// (impl-warehouse §2: a contract another entry point calls in its operation takes that entry point's check).
// Per item the remainder is the ordered quantity less what was received, accepted and rejected (OrderItem.quantity is
// already net of quantityCancelled, which cancel#OrderItem adds to as it lowers quantity). It is recorded through
// cancel#OrderItem with that explicit cancelQuantity (never its default, which measures outbound issuances and would cancel
// a received purchase line in full), the Requirement allocation (RequirementOrderItem) is lowered by it, the reason is kept
// as an internal OrderNote, a part with nothing open is completed, and a completed or cancelled order releases what is
// left of its budget commitments (release#ClosedSourceCommitments). Each refusal is denied(reason, message).
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const facilityScope = ec.resource.script("component://mr-mantle/service/mantle/facility/FacilityScope.js")
const {find, one, rows, call, denied, access} = lib

const ORDER = "mantle.order.OrderHeader",
    ITEM = "mantle.order.OrderItem",
    PART = "mantle.order.OrderPart"
const openStatuses = ["OrderApproved", "OrderSent"]
const zero = () => toDecimal(0)
const dec = value => toDecimal(value ?? 0)

// The product item types (EngItemsProduct), whose lines are received.
function productItemTypes() {
    return Array.from(find("moqui.basic.EnumGroupMember", {enumGroupEnumId: "EngItemsProduct"}).useCache(true).list()).map(
        row => row.enumId
    )
}
// Stock units in one unit of the order line's quantity: the line's quantityUomId converted to the product's stock unit
// (amountUomId); 1 when either is unset or they are the same.
function lineFactor(orderItem, product) {
    const stockUomId = product?.amountUomId
    if (!orderItem?.quantityUomId || !stockUomId || orderItem.quantityUomId === stockUomId) return toDecimal(1)
    const converted = call("org.moqui.impl.BasicServices.convert#Uom", {
        uomId: orderItem.quantityUomId,
        toUomId: stockUomId,
        amount: 1
    }).convertedAmount
    if (converted == null || dec(converted).compare(0) <= 0)
        denied("UNIT_CONVERSION", `No conversion from ${orderItem.quantityUomId} to ${stockUomId} for ${orderItem.productId}`)
    return dec(converted)
}
// Received on an order item, in stock units: accepted and rejected.
function receivedOf(orderId, orderItemSeqId) {
    let accepted = zero(),
        rejected = zero()
    for (const receipt of rows("mantle.product.receipt.AssetReceipt", {orderId, orderItemSeqId})) {
        accepted = accepted.add(dec(receipt.quantityAccepted))
        rejected = rejected.add(dec(receipt.quantityRejected))
    }
    return {accepted, rejected, total: accepted.add(rejected)}
}
// A purchase order of one of the user's organizations (its customer is an internal organization in scope), locked.
function purchaseOrder(orderId, userScope) {
    const order = orderId ? find(ORDER, {orderId}).forUpdate(true).one() : null
    const parts = order ? rows(PART, {orderId}) : []
    const buying = parts.filter(part => one("mantle.party.PartyRole", {partyId: part.customerPartyId, roleTypeId: "OrgInternal"}))
    if (!order || !parts.length || buying.length !== parts.length)
        denied("NOT_PURCHASE", "Order " + (orderId || "") + " is not a purchase order")
    if (userScope && !parts.every(part => facilityScope.owns(userScope, part.customerPartyId)))
        denied("RECORD_UNAVAILABLE", "Order " + orderId + " is not available")
    return {order, parts}
}
// The remainders of a purchase order's product lines (all, or orderItemSeqIds), each with its stock-unit factor.
function openLines(orderId, orderItemSeqIds) {
    const types = productItemTypes()
    const wanted = orderItemSeqIds && orderItemSeqIds.length ? new Set(orderItemSeqIds.map(String)) : null
    return rows(ITEM, {orderId})
        .filter(item => item.productId && types.includes(item.itemTypeEnumId))
        .filter(item => !wanted || wanted.has(item.orderItemSeqId))
        .map(item => {
            const product = one("mantle.product.Product", {productId: item.productId})
            const factor = lineFactor(item, product)
            const received = receivedOf(orderId, item.orderItemSeqId)
            const receivedLine = received.total.divide(factor, 6, "HALF_UP")
            const quantity = dec(item.quantity)
            const remainder = quantity.subtract(receivedLine)
            return {item, product, factor, received, receivedLine, quantity, remainder}
        })
}
// Lowers the order item's Requirement allocations by the cancelled quantity, the latest first.
function releaseAllocations(orderId, orderItemSeqId, cancelled) {
    let left = dec(cancelled)
    const allocations = rows("mantle.request.requirement.RequirementOrderItem", {orderId, orderItemSeqId}).sort((a, b) =>
        String(b.requirementId).localeCompare(String(a.requirementId))
    )
    const released = []
    for (const row of allocations) {
        if (left.compare(0) <= 0) break
        const held = dec(row.quantity)
        if (held.compare(0) <= 0) continue
        const take = held.compare(left) > 0 ? left : held
        call("update#mantle.request.requirement.RequirementOrderItem", {
            requirementId: row.requirementId,
            orderId,
            orderItemSeqId,
            quantity: held.subtract(take)
        })
        released.push({requirementId: row.requirementId, quantity: String(take.toNumber())})
        left = left.subtract(take)
    }
    return released
}
// The close itself, without a permission check of its own: the caller's operation checked it.
function remainders(p) {
    const reason = String(p.reason || "").trim()
    if (!reason) denied("REASON_REQUIRED", "Give the reason the remainder is closed")
    const {order, parts} = purchaseOrder(p.orderId, p.userScope || null)
    if (!parts.some(part => openStatuses.includes(part.statusId)))
        denied("ORDER_NOT_OPEN", "Order " + p.orderId + " has no open part")
    const closedItems = []
    for (const line of openLines(p.orderId, Array.from(p.orderItemSeqIds || []))) {
        if (line.remainder.compare(0) <= 0) continue
        const cancelled = call("mantle.order.OrderServices.cancel#OrderItem", {
            orderId: p.orderId,
            orderItemSeqId: line.item.orderItemSeqId,
            cancelQuantity: line.remainder
        }).quantityCancelled
        const quantityCancelled = dec(cancelled ?? line.remainder)
        closedItems.push({
            orderItemSeqId: line.item.orderItemSeqId,
            productId: line.item.productId,
            orderedQuantity: String(line.quantity.toNumber()),
            receivedQuantity: String(line.receivedLine.toNumber()),
            cancelledQuantity: String(quantityCancelled.toNumber()),
            requirements: releaseAllocations(p.orderId, line.item.orderItemSeqId, quantityCancelled)
        })
    }
    if (closedItems.length)
        call("create#mantle.order.OrderNote", {
            orderId: p.orderId,
            noteDate: ec.user.nowTimestamp,
            internalNote: "Y",
            noteText: (
                "Remainder closed" +
                (p.shipmentId ? " at receipt " + p.shipmentId : "") +
                ": " +
                reason +
                " (" +
                closedItems.map(row => "item " + row.orderItemSeqId + " " + row.cancelledQuantity).join(", ") +
                ")"
            ).slice(0, 4000)
        })
    // a part with nothing open (every product line received, accepted or rejected) is completed
    const remaining = openLines(p.orderId, null)
    for (const part of rows(PART, {orderId: p.orderId})) {
        if (!openStatuses.includes(part.statusId)) continue
        const partOpen = remaining.some(line => line.item.orderPartSeqId === part.orderPartSeqId && line.remainder.compare(0) > 0)
        if (!partOpen)
            call("mantle.order.OrderServices.complete#OrderPart", {orderId: p.orderId, orderPartSeqId: part.orderPartSeqId})
    }
    call("mantle.order.OrderServices.checkCancelComplete#Order", {orderId: p.orderId})
    const after = one(ORDER, {orderId: p.orderId})
    let releasedCommitments = 0
    if (["OrderCompleted", "OrderCancelled"].includes(after.statusId)) {
        const open = find("mantle.other.budget.BudgetCommitment", {
            sourceEntityName: ORDER,
            sourceId: p.orderId,
            statusId: "BcReserved"
        }).count()
        if (open)
            releasedCommitments = call("mantle.other.BudgetServices.release#ClosedSourceCommitments", {
                sourceEntityName: ORDER,
                sourceId: p.orderId
            }).releasedCount
    }
    return {
        orderId: p.orderId,
        closedItems,
        orderStatusId: after.statusId,
        releasedCommitments: Number(releasedCommitments || 0),
        currencyUomId: order.currencyUomId || null
    }
}
// close#PurchaseRemainders: PURCHASE_ORDER_EDIT, in the order's buying organization.
function close(p) {
    if (!access.has("PURCHASE_ORDER_EDIT")) denied("PERMISSION_DENIED", "PURCHASE_ORDER_EDIT is required")
    if (!ec.user.userId) denied("PERMISSION_DENIED", "A signed-in user is required")
    return remainders(Object.assign({}, p, {userScope: facilityScope.scope()}))
}

;({
    lineFactor,
    receivedOf,
    remainders,
    execute: (op, p) => {
        const operations = {close}
        if (!operations[op]) denied("OPERATION_UNKNOWN", "Unknown purchase remainder operation " + op)
        return operations[op](p)
    }
})
