// Make-to-order pegging on a purchase receipt (impl-purchasing P14b, R-PUR-37; design-purchasing §8 SupplyPlanning and §9
// ShipmentDetail): a purchase order line bought for customer-order demand keeps the sales line in its provenance, and its
// receipt offers to reserve the received stock for that sales line.
// A purchase order line's pegged sales lines are the customer order lines of the requirement it covers (its RequirementSupply
// to a requirement with RequirementOrderItem rows to a sales part's line: the supply plan's buy conversion), and those of the
// purchase request line it was sourced from (the RequirementSupply's request line, with a RequestItemOrder to a sales line:
// the plan's request route, F-P10-7). Mantle's receive#Asset gives received stock to waiting reservations by priority and
// date (reserve#IncreasedAsset), which may be another order's; the reservation offered here takes off what is not available
// of the pegged line's reservations, up to the stock received, and reserves the line on the received stock first
// (reserve#AssetForOrderItem with the asset, displacing other reservations of it), as Quality.js reservePeg does for a
// released inspection. Received stock waiting for its putaway (AstOnHold at the dock, where Warehouse's receive leaves it)
// may be reserved, so the pegged line is first to it when putaway makes it available; stock held for inspection
// (AstQuarantine) is reserved once released (the inspection's own pegged demand, Quality.js).
// get#ReceiptPegs reads them for a purchase receipt of the user's organizations (PURCHASE_ORDER_EDIT or STOCK_RECEIVE);
// reserve#ReceiptPeg reserves one (STOCK_RECEIVE).
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const facilityScope = ec.resource.script("component://mr-mantle/service/mantle/facility/FacilityScope.js")
const {one, rows, call, denied, access} = lib

const SHIPMENT = "mantle.shipment.Shipment",
    RECEIPT = "mantle.product.receipt.AssetReceipt",
    ASSET = "mantle.product.asset.Asset",
    RESERVATION = "mantle.product.issuance.AssetReservation",
    ISSUANCE = "mantle.product.issuance.AssetIssuance",
    SUPPLY = "mantle.request.requirement.RequirementSupply",
    REQUIREMENT_ORDER = "mantle.request.requirement.RequirementOrderItem",
    ITEM_ORDER = "mantle.request.RequestItemOrder",
    ORDER = "mantle.order.OrderHeader",
    PART = "mantle.order.OrderPart",
    ITEM = "mantle.order.OrderItem"
const readPermissions = ["PURCHASE_ORDER_EDIT", "STOCK_RECEIVE"]
// received stock a pegged line may be reserved on: available, or on hold at the dock waiting for its putaway
const reservable = ["AstAvailable", "AstOnHold"]
const openSalesStatuses = ["OrderPlaced", "OrderProcessing", "OrderApproved", "OrderSent", "OrderHold"]

const blank = value => value == null || String(value).trim() === ""
const dec = value => toDecimal(value == null || value === "" ? 0 : value)
const zero = () => toDecimal(0)
const text = value => (dec(value).compare(0) === 0 ? "0" : String(dec(value).toNumber()))
const isInternal = partyId => !!partyId && !!one("mantle.party.PartyRole", {partyId, roleTypeId: "OrgInternal"})
const partyName = partyId => (partyId ? lib.partyNames([partyId])[partyId] || partyId : "")
const ended = row => !!row.thruDate && lib.ms(row.thruDate) <= lib.ms(ec.user.nowTimestamp)

// A purchase receipt of one of the user's organizations: the shipment and its purchase order part's organization; any other
// shipment is refused alike (RECORD_UNAVAILABLE).
function receiptOf(shipmentId) {
    const unavailable = () => denied("RECORD_UNAVAILABLE", "Receipt " + (shipmentId || "") + " is not available")
    const shipment = blank(shipmentId) ? null : one(SHIPMENT, {shipmentId})
    if (!shipment || shipment.shipmentTypeEnumId !== "ShpTpPurchase") unavailable()
    const source = rows("mantle.shipment.ShipmentItemSource", {shipmentId}).find(row => row.orderId)
    const item = source ? one(ITEM, {orderId: source.orderId, orderItemSeqId: source.orderItemSeqId}) : null
    const part = item ? one(PART, {orderId: item.orderId, orderPartSeqId: item.orderPartSeqId}) : null
    const organizationPartyId = part?.customerPartyId || null
    if (!isInternal(organizationPartyId) || !facilityScope.owns(facilityScope.scope(), organizationPartyId)) unavailable()
    return {shipment, organizationPartyId}
}
// The open sales lines a purchase order line was bought for: through its RequirementSupply rows, the requirement's customer
// order lines and the request line's; only the buying organization's own sales lines (review R4: its received stock is never
// offered to another organization's order).
function pegsOf(orderId, orderItemSeqId, organizationPartyId) {
    const seen = new Set(),
        out = []
    const add = (salesOrderId, salesOrderItemSeqId) => {
        const key = salesOrderId + ":" + salesOrderItemSeqId
        if (seen.has(key)) return
        const item = one(ITEM, {orderId: salesOrderId, orderItemSeqId: salesOrderItemSeqId})
        const part = item ? one(PART, {orderId: item.orderId, orderPartSeqId: item.orderPartSeqId}) : null
        const header = item ? one(ORDER, {orderId: item.orderId}) : null
        if (!part || !isInternal(part.vendorPartyId) || isInternal(part.customerPartyId)) return
        if (organizationPartyId && part.vendorPartyId !== organizationPartyId) return
        if (!openSalesStatuses.includes(header.statusId)) return
        seen.add(key)
        out.push({item, part, header})
    }
    for (const supply of rows(SUPPLY, {orderId, orderItemSeqId}).filter(row => !ended(row))) {
        for (const link of rows(REQUIREMENT_ORDER, {requirementId: supply.requirementId})) add(link.orderId, link.orderItemSeqId)
        if (supply.requestId)
            for (const link of rows(ITEM_ORDER, {requestId: supply.requestId, requestItemSeqId: supply.requestItemSeqId}))
                add(link.orderId, link.orderItemSeqId)
    }
    return out
}
// A sales line's state for a received asset: what is still to ship, what of it is reserved on available stock, what waits
// (reserved but not available, or not reserved at all) and what is reserved on the asset.
function lineState(item, assetId) {
    const ordered = dec(item.quantity).subtract(dec(item.quantityCancelled))
    const issued = rows(ISSUANCE, {orderId: item.orderId, orderItemSeqId: item.orderItemSeqId}).reduce(
        (total, row) => total.add(dec(row.quantity)),
        zero()
    )
    const reservations = rows(RESERVATION, {orderId: item.orderId, orderItemSeqId: item.orderItemSeqId})
    const reserved = reservations.reduce((total, row) => total.add(dec(row.quantityNotIssued ?? row.quantity)), zero())
    const notAvailable = reservations.reduce((total, row) => total.add(dec(row.quantityNotAvailable)), zero())
    const onAsset = reservations
        .filter(row => row.assetId === assetId)
        .reduce(
            (total, row) => total.add(dec(row.quantityNotIssued ?? row.quantity).subtract(dec(row.quantityNotAvailable))),
            zero()
        )
    const toShip = ordered.subtract(issued)
    const unreserved = toShip.subtract(reserved)
    const waiting = notAvailable.add(unreserved.compare(0) > 0 ? unreserved : zero())
    return {toShip, waiting, onAsset}
}

// get#ReceiptPegs: each received purchase line of the receipt bought for customer-order demand, with each pegged sales line
// and whether its stock may be reserved for it now.
function pegs(p) {
    if (!readPermissions.some(access.has)) denied("PERMISSION_DENIED", readPermissions.join(" or ") + " is required")
    const receipt = receiptOf(p.shipmentId)
    const canReserve = access.has("STOCK_RECEIVE")
    const pegRows = []
    for (const received of rows(RECEIPT, {shipmentId: receipt.shipment.shipmentId}).filter(
        row => row.orderId && row.assetId && dec(row.quantityAccepted).compare(0) > 0
    )) {
        const asset = one(ASSET, {assetId: received.assetId})
        for (const peg of pegsOf(received.orderId, received.orderItemSeqId, receipt.organizationPartyId)) {
            const state = lineState(peg.item, received.assetId)
            const available = reservable.includes(asset?.statusId) && dec(asset.quantityOnHandTotal).compare(0) > 0
            pegRows.push({
                assetReceiptId: received.assetReceiptId,
                assetId: received.assetId,
                productId: received.productId,
                purchaseOrderId: received.orderId,
                purchaseOrderItemSeqId: received.orderItemSeqId,
                receivedText: text(received.quantityAccepted),
                orderId: peg.item.orderId,
                orderItemSeqId: peg.item.orderItemSeqId,
                customerPartyId: peg.part.customerPartyId,
                customerName: partyName(peg.part.customerPartyId),
                toShipText: text(state.toShip),
                waitingText: text(state.waiting),
                reservedHereText: text(state.onAsset),
                stateText:
                    state.waiting.compare(0) <= 0
                        ? state.onAsset.compare(0) > 0
                            ? "Reserved on this receipt"
                            : "Reserved"
                        : asset?.statusId === "AstQuarantine"
                          ? "Held for inspection: reserve once released"
                          : available
                            ? "Waiting for stock"
                            : "Received stock is no longer on hand",
                canReserve: canReserve && available && state.waiting.compare(0) > 0
            })
        }
    }
    return {shipmentId: receipt.shipment.shipmentId, organizationPartyId: receipt.organizationPartyId, pegRows}
}

// reserve#ReceiptPeg: a pegged sales line reserved on the stock its purchase line received: what is not available of its
// reservations, up to the asset's quantity on hand, taken off, and the line reserved with the asset first.
function reserve(p) {
    if (!access.has("STOCK_RECEIVE")) denied("PERMISSION_DENIED", "STOCK_RECEIVE is required")
    const receipt = receiptOf(p.shipmentId)
    const received = rows(RECEIPT, {shipmentId: receipt.shipment.shipmentId}).find(
        row => row.assetId === p.assetId && row.orderId
    )
    if (!received) denied("ASSET_UNAVAILABLE", "Stock " + (p.assetId || "") + " was not received on this receipt")
    const peg = pegsOf(received.orderId, received.orderItemSeqId, receipt.organizationPartyId).find(
        row => row.item.orderId === p.orderId && row.item.orderItemSeqId === p.orderItemSeqId
    )
    if (!peg)
        denied(
            "NOT_PEGGED",
            "Order " + (p.orderId || "") + " line " + (p.orderItemSeqId || "") + " is not what this purchase line was bought for"
        )
    const asset = lib.find(ASSET, {assetId: received.assetId}).forUpdate(true).one()
    if (asset?.statusId === "AstQuarantine")
        denied("STOCK_HELD", "Stock " + received.assetId + " is held for inspection; reserve it once released")
    if (!asset || !reservable.includes(asset.statusId) || dec(asset.quantityOnHandTotal).compare(0) <= 0)
        denied("STOCK_UNAVAILABLE", "Stock " + received.assetId + " is no longer on hand")
    const before = lineState(peg.item, asset.assetId)
    if (before.waiting.compare(0) <= 0)
        return {
            reservedQuantity: "0",
            alreadyReserved: true,
            assetId: asset.assetId,
            orderId: p.orderId,
            orderItemSeqId: p.orderItemSeqId
        }
    let left = dec(asset.quantityOnHandTotal)
    const waiting = rows(RESERVATION, {orderId: peg.item.orderId, orderItemSeqId: peg.item.orderItemSeqId})
        .filter(row => dec(row.quantityNotAvailable).compare(0) > 0)
        .sort((a, b) => (lib.ms(a.reservedDate) ?? 0) - (lib.ms(b.reservedDate) ?? 0))
    for (const row of waiting) {
        if (left.compare(0) <= 0) break
        const take = dec(row.quantityNotAvailable).compare(left) > 0 ? left : dec(row.quantityNotAvailable)
        call("mantle.product.AssetServices.reduce#AssetReservation", {
            assetReservationId: row.assetReservationId,
            quantityToDeduct: take,
            reserveIncreasedAsset: false
        })
        left = left.subtract(take)
    }
    call("mantle.product.AssetServices.reserve#AssetForOrderItem", {
        orderId: peg.item.orderId,
        orderItemSeqId: peg.item.orderItemSeqId,
        assetId: asset.assetId,
        resetReservations: false
    })
    const after = lineState(peg.item, asset.assetId)
    return {
        reservedQuantity: text(after.onAsset.subtract(before.onAsset)),
        alreadyReserved: false,
        assetId: asset.assetId,
        orderId: peg.item.orderId,
        orderItemSeqId: peg.item.orderItemSeqId
    }
}

const operations = {pegs, reserve}
;({
    pegsOf,
    execute: (op, parameters) => {
        if (!operations[op]) throw new Error("Unknown pegging operation " + op)
        return operations[op](parameters || {})
    }
})
