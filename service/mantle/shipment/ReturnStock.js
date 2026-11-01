// Returns in the warehouse (impl-warehouse P14; design-warehouse §11 and WH-RETURN, crosscut §3.18, design-purchasing
// PUR-RETURN): the guarded customer return receipt (receive#ReturnItems with an operation key: Accounting's receipt in
// ReturnSettlement.js, into quarantine with an inspection of each accepted receipt), Purchasing's receipt-based supplier
// return eligibility (mantle.order.ReturnServices.find#ReturnableReceipts, add#ReceiptToReturn), the supplier return's
// issue of the stock it names and its ship (WarehouseTaskServices.issue#SupplierReturnStock, ship#SupplierReturn), and the
// return label request (request#ReturnLabel). The entry points take StockPosting.js's steps in its order; one lock order:
// the shipment, the return header, its items, the receipt, the lot, the asset, the location. Each refusal is
// denied(reason, message).
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const posting = ec.resource.script("component://mr-mantle/service/mantle/shipment/StockPosting.js")
const facilityScope = ec.resource.script("component://mr-mantle/service/mantle/facility/FacilityScope.js")
const {find, one, rows, call, denied, access, dateText} = lib

const SHIPMENT = "mantle.shipment.Shipment",
    SOURCE = "mantle.shipment.ShipmentItemSource",
    HEADER = "mantle.order.return.ReturnHeader",
    ITEM = "mantle.order.return.ReturnItem",
    RECEIPT = "mantle.product.receipt.AssetReceipt",
    ASSET = "mantle.product.asset.Asset",
    ISSUANCE = "mantle.product.issuance.AssetIssuance",
    INSPECTION = "mantle.product.quality.QualityInspection",
    DISPOSITION = "mantle.product.quality.QualityInspectionDisposition"
// a return item still counting against its receipt: not cancelled
const closedItemStatuses = ["ReturnCancelled"]
// the statuses a supplier return's stock is issued from (held stock only with QUALITY_DISPOSE)
const issuableStatuses = ["AstAvailable", "AstOnHold", "AstQuarantine"]
const shippedStatuses = ["ShipPacked", "ShipShipped", "ShipDelivered", "ShipRejected", "ShipCancelled"]
const zero = () => toDecimal(0)
const dec = value => toDecimal(value ?? 0)
const blank = value => value == null || String(value).trim() === ""
const text = value => (dec(value).compare(0) === 0 ? "0" : String(dec(value).toNumber()))
const sum = (list, field) => list.reduce((total, row) => total.add(dec(row[field])), zero())
const min = (a, b) => (a.compare(b) <= 0 ? a : b)
const unique = values => [...new Set(values.filter(value => value != null && value !== ""))]

// ===== the customer return receipt =====
// The return shipment, locked: a customer return still being received, at a facility of the user's organizations (its last
// route segment's destination unless given).
function returnShipment(userScope, shipmentId, facilityId) {
    const shipment = blank(shipmentId) ? null : find(SHIPMENT, {shipmentId}).forUpdate(true).one()
    if (!shipment) denied("RECORD_UNAVAILABLE", "Shipment " + (shipmentId || "") + " is not available")
    if (shipment.shipmentTypeEnumId !== "ShpTpSalesReturn")
        denied("RETURN_SHIPMENT_REQUIRED", "Shipment " + shipmentId + " is not a customer return")
    if (["ShipDelivered", "ShipCancelled"].includes(shipment.statusId))
        denied("RECEIPT_CLOSED", "Return shipment " + shipmentId + " is " + shipment.statusId + " and takes no more receipts")
    let homeId = facilityId
    if (blank(homeId))
        homeId = rows("mantle.shipment.ShipmentRouteSegment", {shipmentId})
            .sort((a, b) => String(b.shipmentRouteSegmentSeqId).localeCompare(String(a.shipmentRouteSegmentSeqId)))
            .find(segment => segment.destinationFacilityId)?.destinationFacilityId
    if (blank(homeId)) denied("FACILITY_REQUIRED", "Choose the receiving facility")
    const facility = posting.facility(userScope, homeId)
    return {shipment, facility}
}
// The quarantine location a return is received into: the receiver's, if it is a quarantine location; else the operation
// policy's; else the facility's first open quarantine location in pick sequence (LOCATION_REQUIRED when it has none).
function quarantineLocation(facility, requested, operation) {
    if (!blank(requested)) {
        const chosen = one("mantle.facility.FacilityLocation", {facilityId: facility.facilityId, locationSeqId: requested})
        if (chosen?.locationTypeEnumId !== "FltQuarantine")
            denied("LOCATION_NOT_QUARANTINE", "Location " + requested + " is not a quarantine location")
        return requested
    }
    if (!blank(operation.quarantineLocationSeqId)) return operation.quarantineLocationSeqId
    const found = Array.from(
        find("mantle.facility.FacilityLocation", {facilityId: facility.facilityId, locationTypeEnumId: "FltQuarantine"})
            .orderBy("sequenceNum,locationSeqId")
            .list()
    ).find(row => !row.thruDate || lib.ms(row.thruDate) > lib.ms(ec.user.nowTimestamp))
    if (!found) denied("LOCATION_REQUIRED", "A return is received into quarantine: facility " + facility.facilityId + " has none")
    return found.locationSeqId
}
// The guarded receipt (receive#ReturnItems with an operation key): the shipment, then each item locked, the tracking rules of
// the product's policy, the quarantine location locked last, the open period of today (not locking the periods, as every
// receipt); Accounting's receipt (ReturnSettlement.js receive) of the accepted stock as AstQuarantine there, one call per
// serial; then an inspection of each accepted receipt (Quality.js receiptInspections, source QisReturn), in this operation.
// What the return's hold is released by: that inspection's disposition (impl-warehouse §4, the P9 open question).
function receive(p) {
    const receiving = ec.resource.script("component://mr-mantle/service/mantle/shipment/Receiving.js")
    const quality = ec.resource.script("component://mr-mantle/service/mantle/product/Quality.js")
    const settlement = ec.resource.script("component://mr-mantle/service/mantle/order/ReturnSettlement.js")
    const begun = posting.begin(p, "ReturnReceive", "STOCK_RECEIVE", ["shipmentId", "facilityId", "locationSeqId", "itemList"])
    if (begun.previous) return {result: begun.previous}
    const userScope = posting.scope()
    const {shipment, facility} = returnShipment(userScope, p.shipmentId, p.facilityId)
    const lines = Array.from(p.itemList || []).map(line => Object.assign({}, line))
    if (!lines.length) denied("RETURN_LINES_REQUIRED", "Enter what was received")
    lines.sort((a, b) => (a.returnId + ":" + a.returnItemSeqId).localeCompare(b.returnId + ":" + b.returnItemSeqId))
    const sources = rows(SOURCE, {shipmentId: shipment.shipmentId})
    for (const line of lines) {
        const source = sources.find(row => row.returnId === line.returnId && row.returnItemSeqId === line.returnItemSeqId)
        if (!source)
            denied("RETURN_ITEM_NOT_ON_SHIPMENT", "Return item " + line.returnId + ":" + line.returnItemSeqId + " is not on it")
        find(HEADER, {returnId: line.returnId}).forUpdate(true).one()
        line.item = find(ITEM, {returnId: line.returnId, returnItemSeqId: line.returnItemSeqId}).forUpdate(true).one()
    }
    const settledAnswer = posting.settled(begun.op)
    if (settledAnswer) return {result: settledAnswer}
    // the tracking rules, then the destination: everything checked before anything posts
    const received = []
    let target = null
    for (const line of lines) {
        const product = one("mantle.product.Product", {productId: line.item.productId})
        const accepted = dec(line.quantityAccepted)
        const rejected = dec(line.quantityRejected)
        if (rejected.compare(0) > 0 && blank(line.rejectionReasonEnumId))
            denied("REASON_REQUIRED", "Give the reason units are rejected")
        const policy = receiving.policyOf(facility.facilityId, product.productId)
        const track = receiving.tracking(policy.tracking, product, accepted, line)
        if (accepted.compare(0) > 0 && !target)
            target = posting.destination(userScope, facility.facilityId, {
                toLocationSeqId: quarantineLocation(facility, line.locationSeqId || p.locationSeqId, policy.operation)
            })
        received.push({line, accepted, rejected, track})
    }
    posting.period([facility.ownerPartyId], ec.user.nowTimestamp, {lock: false})
    // Accounting's receipt of each line: a serialized line one unit at a time, the dock rejection with the first
    const calls = []
    for (const {line, accepted, rejected, track} of received) {
        const base = {
            returnId: line.returnId,
            returnItemSeqId: line.returnItemSeqId,
            rejectionReasonEnumId: line.rejectionReasonEnumId || null,
            statusId: "AstQuarantine",
            locationSeqId: target?.locationSeqId || null,
            lotNumber: blank(line.lotNumber) ? null : String(line.lotNumber).trim(),
            expirationDate: track.expirationDate || null
        }
        if (track.serials.length)
            track.serials.forEach((serialNumber, index) =>
                calls.push(
                    Object.assign({}, base, {
                        quantityAccepted: toDecimal(1),
                        quantityRejected: index === 0 ? rejected : zero(),
                        serialNumber
                    })
                )
            )
        else calls.push(Object.assign({}, base, {quantityAccepted: accepted, quantityRejected: rejected}))
    }
    const out = settlement.execute("receive", {shipmentId: shipment.shipmentId, facilityId: facility.facilityId, itemList: calls})
    const assetReceiptIds = unique(Array.from(out.receivedItems || []).flatMap(row => Array.from(row.assetReceiptIds || [])))
    const qualityInspectionIds = quality.receiptInspections(userScope, assetReceiptIds)
    const itemRows = new Map()
    for (const row of Array.from(out.receivedItems || [])) {
        const key = row.returnId + ":" + row.returnItemSeqId
        itemRows.set(key, {
            returnId: row.returnId,
            returnItemSeqId: row.returnItemSeqId,
            receivedQuantity: text(row.receivedQuantity),
            statusId: row.statusId
        })
    }
    const answer = {
        resultCode: "RECEIVED",
        shipmentId: shipment.shipmentId,
        facilityId: facility.facilityId,
        locationSeqId: target?.locationSeqId || null,
        statusId: target ? "AstQuarantine" : null,
        quantityAccepted: text(received.reduce((total, row) => total.add(row.accepted), zero())),
        quantityRejected: text(received.reduce((total, row) => total.add(row.rejected), zero())),
        receivedItems: [...itemRows.values()],
        assetReceiptIds,
        qualityInspectionIds,
        shipmentDelivered: !!out.shipmentDelivered,
        warnings: received.flatMap(row => row.track.warnings)
    }
    return {
        result: posting.complete(begun.op, facility.ownerPartyId, SHIPMENT, shipment.shipmentId, answer),
        receivedItems: out.receivedItems,
        shipmentDelivered: !!out.shipmentDelivered
    }
}

// ===== Purchasing's receipt-based eligibility (PUR-RETURN, F32) =====
// The assets that hold a receipt's stock now: its own asset, and those its inspections' dispositions left it in (a part
// split off or moved within quarantine), with what is on hand and what a Return to supplier disposition still holds.
function holdingAssets(receipt) {
    const inspections = receipt.assetReceiptId ? rows(INSPECTION, {assetReceiptId: receipt.assetReceiptId}) : []
    const dispositions = inspections.length
        ? Array.from(
              find(DISPOSITION)
                  .condition(
                      "qualityInspectionId",
                      "in",
                      inspections.map(row => row.qualityInspectionId)
                  )
                  .list()
          )
        : []
    const assetIds = unique(
        [receipt.assetId].concat(
            inspections.map(row => row.assetId),
            dispositions.map(r => r.resultAssetId)
        )
    )
    if (!assetIds.length) return []
    return Array.from(find(ASSET).condition("assetId", "in", assetIds).orderBy("assetId").list()).map(asset => {
        const forSupplier = dispositions
            .filter(row => row.dispositionEnumId === "QdReturnSupplier" && (row.resultAssetId || row.assetId) === asset.assetId)
            .reduce((total, row) => total.add(dec(row.quantity).subtract(dec(row.returnedQuantity))), zero())
        return {
            assetId: asset.assetId,
            statusId: asset.statusId,
            locationSeqId: asset.locationSeqId || null,
            lotId: asset.lotId || null,
            serialNumber: asset.serialNumber || null,
            quantityOnHand: dec(asset.quantityOnHandTotal),
            returnSupplierQuantity: forSupplier.compare(0) > 0 ? forSupplier : zero()
        }
    })
}
// What earlier supplier returns took of a receipt: their items linked to it, not cancelled, on a return not cancelled.
function returnedOf(assetReceiptId, exceptReturnId) {
    const items = rows(ITEM, {assetReceiptId}).filter(row => !closedItemStatuses.includes(row.statusId))
    const headerIds = unique(items.map(row => row.returnId))
    const cancelled = new Set(
        headerIds.length
            ? Array.from(find(HEADER).condition("returnId", "in", headerIds).condition("statusId", "ReturnCancelled").list()).map(
                  row => row.returnId
              )
            : []
    )
    return items
        .filter(row => !cancelled.has(row.returnId) && row.returnId !== exceptReturnId)
        .reduce((total, row) => total.add(dec(row.returnQuantity)), zero())
}
// The purchase line a receipt is of, with its order part (the buying organization and the supplier).
function receiptOrder(receipt) {
    const item = receipt.orderId
        ? one("mantle.order.OrderItem", {orderId: receipt.orderId, orderItemSeqId: receipt.orderItemSeqId})
        : null
    const part = item ? one("mantle.order.OrderPart", {orderId: item.orderId, orderPartSeqId: item.orderPartSeqId}) : null
    return {item, part}
}
// One receipt as an eligibility row: accepted (available and quarantined stock alike; a dock rejection is no stock) less
// earlier supplier returns, and the assets that hold it.
function receiptRow(receipt, order, assets) {
    const accepted = dec(receipt.quantityAccepted)
    const returned = returnedOf(receipt.assetReceiptId)
    const eligible = accepted.subtract(returned)
    const quarantined = assets
        .filter(row => row.statusId === "AstQuarantine")
        .reduce((t, row) => t.add(row.quantityOnHand), zero())
    const onHand = assets.reduce((total, row) => total.add(row.quantityOnHand), zero())
    const lotIds = unique(assets.map(row => row.lotId))
    return {
        assetReceiptId: receipt.assetReceiptId,
        shipmentId: receipt.shipmentId,
        orderId: receipt.orderId,
        orderItemSeqId: receipt.orderItemSeqId,
        productId: receipt.productId,
        vendorPartyId: order.part?.vendorPartyId || null,
        organizationPartyId: order.part?.customerPartyId || null,
        receivedDate: receipt.receivedDate,
        receivedText: dateText(receipt.receivedDate),
        lotId: lotIds[0] || null,
        acceptedQuantity: accepted,
        quarantinedQuantity: quarantined,
        onHandQuantity: onHand,
        returnedQuantity: returned,
        eligibleQuantity: eligible.compare(0) > 0 ? eligible : zero(),
        issuableQuantity: min(eligible.compare(0) > 0 ? eligible : zero(), onHand),
        assets: assets.map(row => Object.assign({}, row, {quantityOnHand: row.quantityOnHand}))
    }
}
// find#ReturnableReceipts: the purchase receipts of the user's organizations (the buying organization of the order part)
// by supplier, order, product, receipt, lot or facility, with what each may still be returned; eligible rows only unless
// includeIneligible. At most 200 receipts, newest first.
function returnableReceipts(p) {
    posting.requirePermission(["PURCHASE_ORDER_EDIT", "QUALITY_DISPOSE", "STOCK_ISSUE"])
    const userScope = posting.scope()
    let orderIds = null
    if (!blank(p.orderId)) orderIds = [p.orderId]
    else if (!blank(p.vendorPartyId)) {
        let parts = find("mantle.order.OrderPart", {vendorPartyId: p.vendorPartyId})
        if (userScope.organizationPartyIds) parts = parts.condition("customerPartyId", "in", userScope.organizationPartyIds)
        orderIds = unique(Array.from(parts.selectField("orderId").orderBy("-orderId").limit(500).list()).map(row => row.orderId))
    }
    let query = find(RECEIPT).condition("orderId", "is-not-null", null).condition("quantityAccepted", "greater", 0)
    if (!blank(p.assetReceiptId)) query = query.condition("assetReceiptId", p.assetReceiptId)
    if (orderIds) query = query.condition("orderId", "in", orderIds.length ? orderIds : ["_none_"])
    if (!blank(p.productId)) query = query.condition("productId", p.productId)
    if (blank(p.assetReceiptId) && !orderIds && blank(p.productId))
        denied("FILTER_REQUIRED", "Give a supplier, an order, a product or a receipt")
    const receipts = Array.from(query.orderBy("-receivedDate,-assetReceiptId").limit(200).list())
    const receiptRows = []
    for (const receipt of receipts) {
        const shipment = receipt.shipmentId ? one(SHIPMENT, {shipmentId: receipt.shipmentId}) : null
        if (shipment && shipment.shipmentTypeEnumId !== "ShpTpPurchase") continue
        const order = receiptOrder(receipt)
        if (!order.part || !facilityScope.owns(userScope, order.part.customerPartyId)) continue
        if (!blank(p.vendorPartyId) && order.part.vendorPartyId !== p.vendorPartyId) continue
        const assets = holdingAssets(receipt)
        if (!blank(p.facilityId) && !assets.some(row => one(ASSET, {assetId: row.assetId})?.facilityId === p.facilityId)) continue
        if (!blank(p.lotId) && !assets.some(row => row.lotId === p.lotId)) continue
        const row = receiptRow(receipt, order, assets)
        if (row.eligibleQuantity.compare(0) <= 0 && p.includeIneligible !== true && p.includeIneligible !== "true") continue
        receiptRows.push(row)
    }
    return {receiptRows}
}
// The supplier return, locked: its customer an internal organization of the user's scope (a purchase return), still open
// for items (created or requested).
function supplierReturn(userScope, returnId, statuses) {
    const header = blank(returnId) ? null : find(HEADER, {returnId}).forUpdate(true).one()
    if (!header) denied("RECORD_UNAVAILABLE", "Return " + (returnId || "") + " is not available")
    if (!one("mantle.party.PartyRole", {partyId: header.customerPartyId, roleTypeId: "OrgInternal"}))
        denied("NOT_SUPPLIER_RETURN", "Return " + returnId + " is a customer return")
    if (!facilityScope.owns(userScope, header.customerPartyId))
        denied("RECORD_UNAVAILABLE", "Return " + returnId + " is not available")
    if (statuses && !statuses.includes(header.statusId))
        denied("RETURN_NOT_OPEN", "Return " + returnId + " is " + header.statusId)
    return header
}
// add#ReceiptToReturn: a supplier return's item for part of a receipt's accepted stock: the return, then the receipt, then its
// lot locked, the eligibility counted again (QUANTITY_EXCEEDS_ELIGIBLE), the supplier and organization the receipt's
// (SUPPLIER_MISMATCH), the asset one that holds the receipt's stock (the receipt's own, or a Return to supplier
// disposition's, by default).
function addReceiptToReturn(p) {
    posting.requirePermission(["PURCHASE_ORDER_EDIT", "QUALITY_DISPOSE"])
    const userScope = posting.scope()
    const header = supplierReturn(userScope, p.returnId, ["ReturnCreated", "ReturnRequested"])
    const receipt = blank(p.assetReceiptId) ? null : find(RECEIPT, {assetReceiptId: p.assetReceiptId}).forUpdate(true).one()
    if (!receipt) denied("RECORD_UNAVAILABLE", "Receipt " + (p.assetReceiptId || "") + " is not available")
    const order = receiptOrder(receipt)
    if (!order.part || !facilityScope.owns(userScope, order.part.customerPartyId))
        denied("RECORD_UNAVAILABLE", "Receipt " + p.assetReceiptId + " is not available")
    if (order.part.vendorPartyId !== header.vendorPartyId || order.part.customerPartyId !== header.customerPartyId)
        denied("SUPPLIER_MISMATCH", "Receipt " + p.assetReceiptId + " is not from this return's supplier to its organization")
    const assets = holdingAssets(receipt)
    const lotId = unique(assets.map(row => row.lotId))[0]
    if (lotId) find("mantle.product.asset.Lot", {lotId}).forUpdate(true).one()
    const quantity = dec(p.returnQuantity)
    if (quantity.compare(0) <= 0) denied("QUANTITY_INVALID", "Give a quantity above zero")
    const row = receiptRow(receipt, order, assets)
    if (quantity.compare(row.eligibleQuantity) > 0)
        denied(
            "QUANTITY_EXCEEDS_ELIGIBLE",
            "Receipt " +
                receipt.assetReceiptId +
                " accepted " +
                text(row.acceptedQuantity) +
                ", " +
                text(row.returnedQuantity) +
                " already returned"
        )
    const preferred =
        assets.find(asset => asset.returnSupplierQuantity.compare(0) > 0 && asset.quantityOnHand.compare(0) > 0) ||
        assets.find(asset => asset.assetId === receipt.assetId && asset.quantityOnHand.compare(0) > 0) ||
        assets.find(asset => asset.quantityOnHand.compare(0) > 0)
    const assetId = blank(p.assetId) ? preferred?.assetId || receipt.assetId : p.assetId
    if (!assets.some(asset => asset.assetId === assetId))
        denied("VALUE_INVALID", "Asset " + assetId + " does not hold the stock of receipt " + receipt.assetReceiptId)
    const reason = blank(p.returnReasonEnumId) ? "RrsnDefective" : p.returnReasonEnumId
    const created = call("create#" + ITEM, {
        returnId: header.returnId,
        statusId: header.statusId,
        returnReasonEnumId: reason,
        returnResponseEnumId: blank(p.returnResponseEnumId) ? "RrspCredit" : p.returnResponseEnumId,
        responseImmediate: "N",
        itemTypeEnumId: order.item?.itemTypeEnumId || "ItemInventory",
        productId: receipt.productId,
        description: blank(p.description) ? order.item?.itemDescription || null : p.description,
        orderId: receipt.orderId,
        orderItemSeqId: receipt.orderItemSeqId,
        returnQuantity: quantity,
        returnPrice: dec(order.item?.unitAmount),
        assetReceiptId: receipt.assetReceiptId,
        assetId
    })
    return {returnItemSeqId: created.returnItemSeqId, assetId, eligibleQuantity: row.eligibleQuantity.subtract(quantity)}
}

// ===== the supplier return's shipment =====
// The supplier return shipment, locked: a purchase return from a facility of the user's organizations (its first route
// segment's origin, as issue#Asset reads it) that has not been packed or shipped.
function supplierShipment(userScope, shipmentId, statuses = null) {
    const shipment = blank(shipmentId) ? null : find(SHIPMENT, {shipmentId}).forUpdate(true).one()
    if (!shipment) denied("RECORD_UNAVAILABLE", "Shipment " + (shipmentId || "") + " is not available")
    if (shipment.shipmentTypeEnumId !== "ShpTpPurchaseReturn")
        denied("RETURN_SHIPMENT_REQUIRED", "Shipment " + shipmentId + " is not a supplier return")
    const origin = rows("mantle.shipment.ShipmentRouteSegment", {shipmentId})
        .sort((a, b) => String(a.shipmentRouteSegmentSeqId).localeCompare(String(b.shipmentRouteSegmentSeqId)))
        .find(segment => segment.originFacilityId)?.originFacilityId
    if (!origin) denied("FACILITY_REQUIRED", "Supplier return " + shipmentId + " has no origin facility")
    const facility = posting.facility(userScope, origin)
    if ((statuses || []).length ? !statuses.includes(shipment.statusId) : shippedStatuses.includes(shipment.statusId))
        denied("SHIPMENT_CLOSED", "Supplier return " + shipmentId + " is " + shipment.statusId)
    return {shipment, facility}
}
const issuedOn = shipmentItemSourceId => sum(rows(ISSUANCE, {shipmentItemSourceId}), "quantity")
// The Return to supplier dispositions that hold an asset and have not shipped all they hold, oldest first.
function returnDispositions(assetId) {
    return Array.from(
        find(DISPOSITION, {dispositionEnumId: "QdReturnSupplier"})
            .condition(
                ec.entity.conditionFactory.makeCondition(
                    [
                        ec.entity.conditionFactory.makeCondition("resultAssetId", "equals", assetId),
                        ec.entity.conditionFactory.makeCondition("assetId", "equals", assetId)
                    ],
                    "or"
                )
            )
            .orderBy("qualityInspectionId,dispositionSeqId")
            .list()
    ).filter(row => (row.resultAssetId || row.assetId) === assetId && dec(row.quantity).compare(dec(row.returnedQuantity)) > 0)
}
// issue#SupplierReturnStock: a quantity of the stock a supplier return item names (its asset, or another that holds its
// receipt's stock) issued to the item's source on the shipment through issue#AnyAssetForShipmentItemSource with that asset,
// packed into the shipment's package. Held (quarantined) stock needs QUALITY_DISPOSE and, when an inspection holds it, a
// Return to supplier disposition that covers the quantity (RETURN_NOT_DISPOSED); the disposition's returnedQuantity rises and
// its inspection's heldQuantity falls by it. The expiry gate is off on a purchase return (F424).
function issueSupplierReturn(p) {
    const begun = posting.begin(
        p,
        "SupplierReturnIssue",
        ["QUALITY_DISPOSE", "STOCK_ISSUE"],
        ["shipmentId", "returnId", "returnItemSeqId", "assetId", "quantity"]
    )
    if (begun.previous) return begun.previous
    const userScope = posting.scope()
    const {shipment, facility} = supplierShipment(userScope, p.shipmentId)
    const source = Array.from(
        find(SOURCE, {shipmentId: shipment.shipmentId, returnId: p.returnId, returnItemSeqId: p.returnItemSeqId})
            .forUpdate(true)
            .list()
    ).find(row => row.statusId !== "SisCancelled")
    if (!source) denied("RETURN_ITEM_NOT_ON_SHIPMENT", "Return item " + p.returnId + ":" + p.returnItemSeqId + " is not on it")
    find(HEADER, {returnId: p.returnId}).forUpdate(true).one()
    const item = find(ITEM, {returnId: p.returnId, returnItemSeqId: p.returnItemSeqId}).forUpdate(true).one()
    if (item.statusId !== "ReturnApproved")
        denied("RETURN_NOT_APPROVED", "Return item " + p.returnItemSeqId + " is " + item.statusId + ", not approved")
    const receipt = item.assetReceiptId ? one(RECEIPT, {assetReceiptId: item.assetReceiptId}) : null
    const assetId = blank(p.assetId) ? item.assetId : p.assetId
    if (blank(assetId)) denied("ASSET_REQUIRED", "Choose the stock to send back")
    if (receipt && assetId !== item.assetId && !holdingAssets(receipt).some(row => row.assetId === assetId))
        denied("VALUE_INVALID", "Asset " + assetId + " does not hold the stock of receipt " + receipt.assetReceiptId)
    const asset = posting.stock(userScope, assetId, p.quantity)
    const settledAnswer = posting.settled(begun.op)
    if (settledAnswer) return settledAnswer
    if (asset.productId !== item.productId)
        denied("PRODUCT_MISMATCH", "Asset " + assetId + " is not the product of return item " + p.returnItemSeqId)
    if (asset.facilityId !== facility.facilityId)
        denied("OTHER_FACILITY", "Asset " + assetId + " is not at " + facility.facilityId + ", where the return ships from")
    if (!issuableStatuses.includes(asset.statusId))
        denied("NOT_ISSUABLE", "Asset " + assetId + " is " + asset.statusId + " and is not sent back from here")
    const held = asset.statusId === "AstQuarantine"
    if (held && !access.has("QUALITY_DISPOSE")) denied("PERMISSION_DENIED", "QUALITY_DISPOSE is required to send held stock back")
    const quantity = dec(p.quantity)
    const remaining = dec(source.quantity).subtract(issuedOn(source.shipmentItemSourceId))
    if (quantity.compare(remaining) > 0)
        denied("QUANTITY_EXCEEDS_REMAINING", "Return item " + p.returnItemSeqId + " has " + text(remaining) + " left to send")
    // held stock an inspection holds goes back only as far as its Return to supplier dispositions cover it
    const dispositions = held ? returnDispositions(assetId) : []
    const inspected =
        held &&
        (find(INSPECTION, {assetId}).condition("statusId", "not-equals", "QiCancelled").count() > 0 ||
            find(DISPOSITION, {resultAssetId: assetId}).count() > 0)
    const covered = dispositions.reduce((total, row) => total.add(dec(row.quantity).subtract(dec(row.returnedQuantity))), zero())
    if (inspected && quantity.compare(covered) > 0)
        denied(
            "RETURN_NOT_DISPOSED",
            "Asset " + assetId + " is held by an inspection; " + text(covered) + " is disposed of as Return to supplier"
        )
    const issued = call("mantle.product.AssetServices.issue#AnyAssetForShipmentItemSource", {
        shipmentItemSourceId: source.shipmentItemSourceId,
        quantity,
        assetId
    })
    if (dec(issued.quantityRemaining).compare(0) > 0)
        denied("ISSUE_FAILED", "Asset " + assetId + " could issue only " + text(quantity.subtract(dec(issued.quantityRemaining))))
    call("mantle.shipment.ShipmentServices.add#ItemToPackage", {
        shipmentId: shipment.shipmentId,
        productId: item.productId,
        quantity
    })
    const notHandled = remaining.subtract(quantity)
    call("update#" + SOURCE, {
        shipmentItemSourceId: source.shipmentItemSourceId,
        quantityNotHandled: notHandled.compare(0) > 0 ? notHandled : zero(),
        statusId: notHandled.compare(0) > 0 ? source.statusId : "SisPacked"
    })
    if (["ShipInput", "ShipScheduled"].includes(shipment.statusId))
        call("update#" + SHIPMENT, {shipmentId: shipment.shipmentId, statusId: "ShipPicked"})
    // the dispositions it consumed: returned quantity up, the inspection's held quantity down
    let left = quantity
    const consumed = []
    for (const row of dispositions) {
        if (left.compare(0) <= 0) break
        const take = min(dec(row.quantity).subtract(dec(row.returnedQuantity)), left)
        call("update#" + DISPOSITION, {
            qualityInspectionId: row.qualityInspectionId,
            dispositionSeqId: row.dispositionSeqId,
            returnedQuantity: dec(row.returnedQuantity).add(take)
        })
        const inspection = find(INSPECTION, {qualityInspectionId: row.qualityInspectionId}).forUpdate(true).one()
        const heldAfter = dec(inspection.heldQuantity).subtract(take)
        call("update#" + INSPECTION, {
            qualityInspectionId: row.qualityInspectionId,
            heldQuantity: heldAfter.compare(0) > 0 ? heldAfter : zero()
        })
        if (inspection.assetReceiptId)
            call("mantle.account.InvoiceMatchServices.queue#MatchReevaluation", {
                assetReceiptId: inspection.assetReceiptId,
                orderId: inspection.orderId || null,
                orderItemSeqId: inspection.orderItemSeqId || null,
                staleReason: "Supplier return " + p.returnId + " shipped stock of inspection " + row.qualityInspectionId
            })
        consumed.push({
            qualityInspectionId: row.qualityInspectionId,
            dispositionSeqId: row.dispositionSeqId,
            quantity: text(take)
        })
        left = left.subtract(take)
    }
    return posting.complete(begun.op, facility.ownerPartyId, SOURCE, source.shipmentItemSourceId, {
        resultCode: "ISSUED",
        shipmentId: shipment.shipmentId,
        returnId: item.returnId,
        returnItemSeqId: item.returnItemSeqId,
        assetId,
        statusId: asset.statusId,
        locationSeqId: asset.locationSeqId || null,
        quantity: text(quantity),
        remainingQuantity: text(notHandled.compare(0) > 0 ? notHandled : zero()),
        dispositions: consumed
    })
}
// ship#SupplierReturn: the supplier return shipment, every source issued (OUTSTANDING names what is not), packed and shipped
// through Mantle's pack#Shipment and ship#Shipment, a tracking code kept on its route segment's packages; each return item
// whose authorized quantity was issued goes to ReturnShipped, and the return when every item has
// (checkUpdate#ReturnHeaderStatus). Settlement stays Accounting's settle#Return.
function shipSupplierReturn(p) {
    const begun = posting.begin(p, "SupplierReturnShip", "SHIPMENT_SHIP", ["shipmentId", "trackingCode"])
    if (begun.previous) return begun.previous
    const userScope = posting.scope()
    const {shipment, facility} = supplierShipment(userScope, p.shipmentId, [
        "ShipInput",
        "ShipScheduled",
        "ShipPicked",
        "ShipPacked"
    ])
    const sources = Array.from(
        find(SOURCE, {shipmentId: shipment.shipmentId}).orderBy("shipmentItemSourceId").forUpdate(true).list()
    ).filter(row => row.statusId !== "SisCancelled")
    const settledAnswer = posting.settled(begun.op)
    if (settledAnswer) return settledAnswer
    const outstanding = sources
        .map(row => ({row, left: dec(row.quantity).subtract(issuedOn(row.shipmentItemSourceId))}))
        .filter(entry => entry.left.compare(0) > 0)
    if (!sources.length) denied("NOTHING_TO_SHIP", "Supplier return " + shipment.shipmentId + " has no items")
    if (outstanding.length)
        denied(
            "OUTSTANDING",
            "Not yet sent: " +
                outstanding.map(entry => entry.row.returnId + ":" + entry.row.returnItemSeqId + " " + text(entry.left)).join(", ")
        )
    if (shipment.statusId !== "ShipPacked")
        call("mantle.shipment.ShipmentServices.pack#Shipment", {shipmentId: shipment.shipmentId})
    call("mantle.shipment.ShipmentServices.ship#Shipment", {shipmentId: shipment.shipmentId})
    if (!blank(p.trackingCode))
        for (const row of rows("mantle.shipment.ShipmentPackageRouteSeg", {shipmentId: shipment.shipmentId}))
            call("update#mantle.shipment.ShipmentPackageRouteSeg", {
                shipmentId: row.shipmentId,
                shipmentPackageSeqId: row.shipmentPackageSeqId,
                shipmentRouteSegmentSeqId: row.shipmentRouteSegmentSeqId,
                trackingCode: String(p.trackingCode).trim()
            })
    const shippedItems = []
    const returnIds = unique(sources.map(row => row.returnId)).sort()
    for (const returnId of returnIds) {
        find(HEADER, {returnId}).forUpdate(true).one()
        const keys = unique(sources.filter(row => row.returnId === returnId).map(row => row.returnItemSeqId)).sort()
        for (const returnItemSeqId of keys) {
            const item = find(ITEM, {returnId, returnItemSeqId}).forUpdate(true).one()
            if (item.statusId !== "ReturnApproved") continue
            const issued = Array.from(find(SOURCE, {returnId, returnItemSeqId}).list())
                .filter(row => row.statusId !== "SisCancelled")
                .reduce((total, row) => total.add(issuedOn(row.shipmentItemSourceId)), zero())
            if (issued.compare(dec(item.returnQuantity)) < 0) continue
            call("update#" + ITEM, {returnId, returnItemSeqId, statusId: "ReturnShipped"})
            shippedItems.push({returnId, returnItemSeqId, quantity: text(issued)})
        }
        call("mantle.order.ReturnServices.checkUpdate#ReturnHeaderStatus", {
            returnId,
            statusId: "ReturnShipped",
            itemStatusIds: ["ReturnShipped", "ReturnCancelled"]
        })
    }
    return posting.complete(begun.op, facility.ownerPartyId, SHIPMENT, shipment.shipmentId, {
        resultCode: "SHIPPED",
        shipmentId: shipment.shipmentId,
        facilityId: facility.facilityId,
        returnIds,
        shippedItems,
        trackingCode: blank(p.trackingCode) ? null : String(p.trackingCode).trim()
    })
}

// ===== the return label =====
// request#ReturnLabel: Customer Service's "Issue return label": the approved customer return's shipment, a package and its
// route segment ensured, then the label through the carrier interface (CarrierServices.request#ShipmentLabels) when a
// shipping gateway applies to the shipment, else LABEL_NOT_CONFIGURED with the package ready for the carrier; a label already
// bought answers LABEL_EXISTS and buys no second one. P13's provider-request records take over the carrier call.
function requestReturnLabel(p) {
    const begun = posting.begin(p, "ReturnLabelRequest", ["SHIPMENT_SHIP", "RETURN_AUTHORIZE"], ["returnId"])
    if (begun.previous) return begun.previous
    const userScope = posting.scope()
    const header = blank(p.returnId) ? null : one(HEADER, {returnId: p.returnId})
    if (!header || !facilityScope.owns(userScope, header.vendorPartyId))
        denied("RECORD_UNAVAILABLE", "Return " + (p.returnId || "") + " is not available")
    if (!["ReturnApproved", "ReturnShipped"].includes(header.statusId))
        denied(
            "RETURN_NOT_APPROVED",
            "Return " + p.returnId + " is " + header.statusId + ": a label is issued once it is approved"
        )
    const shipmentIds = unique(rows(SOURCE, {returnId: header.returnId}).map(row => row.shipmentId)).sort()
    const shipmentId = shipmentIds.find(id => {
        const row = one(SHIPMENT, {shipmentId: id})
        return row?.shipmentTypeEnumId === "ShpTpSalesReturn" && !["ShipCancelled", "ShipDelivered"].includes(row.statusId)
    })
    if (!shipmentId) denied("RETURN_NO_SHIPMENT", "Return " + p.returnId + " has no open return shipment")
    const shipment = find(SHIPMENT, {shipmentId}).forUpdate(true).one()
    find(HEADER, {returnId: header.returnId}).forUpdate(true).one()
    const settledAnswer = posting.settled(begun.op)
    if (settledAnswer) return settledAnswer
    let segment = rows("mantle.shipment.ShipmentRouteSegment", {shipmentId}).sort((a, b) =>
        String(a.shipmentRouteSegmentSeqId).localeCompare(String(b.shipmentRouteSegmentSeqId))
    )[0]
    if (!segment) {
        const made = call("create#mantle.shipment.ShipmentRouteSegment", {shipmentId, destinationFacilityId: header.facilityId})
        segment = one("mantle.shipment.ShipmentRouteSegment", {
            shipmentId,
            shipmentRouteSegmentSeqId: made.shipmentRouteSegmentSeqId
        })
    }
    let packageSeqId = rows("mantle.shipment.ShipmentPackage", {shipmentId})[0]?.shipmentPackageSeqId
    if (!packageSeqId) packageSeqId = call("create#mantle.shipment.ShipmentPackage", {shipmentId}).shipmentPackageSeqId
    const routeKey = {
        shipmentId,
        shipmentPackageSeqId: packageSeqId,
        shipmentRouteSegmentSeqId: segment.shipmentRouteSegmentSeqId
    }
    let routeSeg = one("mantle.shipment.ShipmentPackageRouteSeg", routeKey)
    if (!routeSeg) {
        call("create#mantle.shipment.ShipmentPackageRouteSeg", routeKey)
        routeSeg = one("mantle.shipment.ShipmentPackageRouteSeg", routeKey)
    }
    const answer = {
        shipmentId,
        returnId: header.returnId,
        shipmentPackageSeqId: packageSeqId,
        shipmentRouteSegmentSeqId: segment.shipmentRouteSegmentSeqId
    }
    const labelOf = row => ({trackingCode: row?.trackingCode || null, labelUrl: row?.labelUrl || null})
    if (routeSeg.trackingCode || routeSeg.labelUrl || routeSeg.gatewayLabelId) {
        Object.assign(answer, {resultCode: "LABEL_EXISTS"}, labelOf(routeSeg))
    } else {
        let gateway = null
        try {
            gateway = lib.probe("mantle.shipment.CarrierServices.get#ShipmentGatewayDetails", {shipmentId})
        } catch (error) {
            ec.logger.info("Return label for " + shipmentId + ": no shipping gateway (" + error.message + ")")
        }
        if (gateway?.shippingGatewayConfig?.requestLabelsServiceName) {
            call("mantle.shipment.CarrierServices.request#ShipmentLabels", {
                shipmentId,
                shipmentPackageSeqId: packageSeqId,
                shipmentRouteSegmentSeqId: segment.shipmentRouteSegmentSeqId
            })
            Object.assign(
                answer,
                {resultCode: "LABEL_REQUESTED"},
                labelOf(one("mantle.shipment.ShipmentPackageRouteSeg", routeKey))
            )
        } else
            Object.assign(answer, {
                resultCode: "LABEL_NOT_CONFIGURED",
                trackingCode: null,
                labelUrl: null,
                message: "No shipping gateway applies to return shipment " + shipmentId + "; its package is ready for the carrier"
            })
    }
    return posting.complete(begun.op, header.vendorPartyId, SHIPMENT, shipmentId, answer)
}

const operations = {receive, returnableReceipts, addReceiptToReturn, issueSupplierReturn, shipSupplierReturn, requestReturnLabel}
;({
    holdingAssets,
    returnedOf,
    execute(op, parameters) {
        if (!operations[op]) throw new Error("Unknown return stock operation " + op)
        return operations[op](parameters)
    }
})
