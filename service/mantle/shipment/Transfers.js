// The transfer steps of the Warehouse posting guard (impl-warehouse P15, design-warehouse §8 Transfers and
// SubcontractShipmentDetail, crosscut §3.8 transfer and subcontract rows; WH-POST, WH-REQUEST, WH-SUBCONTRACT): what the
// transfer entry points of mantle.shipment.WarehouseTaskServices (create#Transfer, issue#TransferStock, ship#Transfer,
// receive#TransferStock, dispatch#SubcontractStock, allocate#InventoryRequest) add to StockPosting.js's steps.
// A transfer is a ShpTpTransfer shipment between two facilities of one owner: its first route segment's origin and its last
// destination (F55). The origin issues named stock to a line (issue#Asset: the issue posts to the inventory type's
// transferGlAccountId) and ships; the destination receives in as many parts as it likes, each receipt carrying the cost,
// owner, lot and serial of the issuance it came from (AssetReceipt.sourceAssetIssuanceId), through the receipt steps, the
// putaway resolver and the inspection rule of a purchase receipt (Receiving.js, Quality.js). A line's remaining quantity is
// its issuances less its receipts, each summed on its own: ShipmentItemDetail multiplies the two, so neither it nor
// receive#EntireShipment is used for a transfer (F37). A subcontract dispatch is a transfer to (or a return from) an
// organization-owned vendor-custody facility, whose Custodian FacilityParty is the supplier of the service purchase order
// item it names; its components go as a transfer or, with no in-transit step, by move#Asset (dispatch#SubcontractStock),
// which keeps the owner and cost and posts nothing. One lock order: the shipment, its source lines by id, the order or
// request, then assets by id, then the destination location.
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const posting = ec.resource.script("component://mr-mantle/service/mantle/shipment/StockPosting.js")
const facilityScope = ec.resource.script("component://mr-mantle/service/mantle/facility/FacilityScope.js")
const {find, one, rows, call, denied} = lib

const SHIPMENT = "mantle.shipment.Shipment",
    SOURCE = "mantle.shipment.ShipmentItemSource",
    SEGMENT = "mantle.shipment.ShipmentRouteSegment",
    ISSUANCE = "mantle.product.issuance.AssetIssuance",
    RECEIPT = "mantle.product.receipt.AssetReceipt",
    ASSET = "mantle.product.asset.Asset",
    FACILITY = "mantle.facility.Facility",
    OPERATION = "mantle.ledger.transaction.PostingOperation",
    ALLOCATION = "mantle.request.InventoryRequestAllocation"
// a transfer is issued and dispatched until it ships, and received once it has
const openStatuses = ["ShipInput", "ShipScheduled", "ShipPicked"]
// the stock a transfer takes: available, or on a receiving hold (quarantine leaves only by an inspection's disposition)
const usableStatuses = ["AstAvailable", "AstOnHold"]
const stockProductTypes = ["PtAsset"]
const zero = () => toDecimal(0)
const dec = value => toDecimal(value ?? 0)
const blank = value => value == null || String(value).trim() === ""
const text = value => (dec(value).compare(0) === 0 ? "0" : String(dec(value).toNumber()))
const min = (a, b) => (a.compare(b) <= 0 ? a : b)
const positive = value => (value.compare(0) > 0 ? value : zero())

// ===== facilities and custody =====
// The supplier holding stock in a vendor-custody facility: its Custodian FacilityParty in effect, else null.
function custodianOf(facilityId) {
    if (!facilityId) return null
    const row = rows("mantle.facility.FacilityParty", {facilityId, roleTypeId: "Custodian"}).find(party => lib.active(party))
    return row?.partyId || null
}
// A facility of the user's organizations, open (not closed before now).
function openFacility(userScope, facilityId) {
    const facility = posting.facility(userScope, facilityId)
    if (facility.closedDate && lib.ms(facility.closedDate) <= lib.ms(ec.user.nowTimestamp))
        denied("FACILITY_CLOSED", "Facility " + facilityId + " is closed")
    return facility
}
function productOf(productId) {
    const product = blank(productId) ? null : one("mantle.product.Product", {productId})
    if (!product) denied("PRODUCT_REQUIRED", "Choose a product")
    if (!stockProductTypes.includes(product.productTypeEnumId))
        denied("NOT_STOCK", "Product " + productId + " is not a stocked product")
    return product
}

// ===== the subcontract keys =====
// The production work (an operation of a run, or the run) and the service purchase order item, linked by
// OrderItemWorkEffort: the run the organization's (its owner, and its facility when it has one, in the user's scope), the
// order not cancelled, bought by the facilities' owner from the custodian of the vendor-custody facility, the item a service
// (P15 review B4).
function subcontractKeys(userScope, p, custodianPartyId, ownerPartyId) {
    const workEffortId = blank(p.subcontractWorkEffortId) ? null : String(p.subcontractWorkEffortId)
    const orderId = blank(p.subcontractOrderId) ? null : String(p.subcontractOrderId)
    const orderItemSeqId = blank(p.subcontractOrderItemSeqId) ? null : String(p.subcontractOrderItemSeqId)
    if (!workEffortId && !orderId) return null
    if (!custodianPartyId)
        denied("NOT_CUSTODY", "A subcontract dispatch goes to or from a vendor-custody facility (a Custodian facility party)")
    if (!workEffortId || !orderId || !orderItemSeqId)
        denied("SUBCONTRACT_KEYS", "A subcontract dispatch names the production work and the service order item")
    const work = one("mantle.work.effort.WorkEffort", {workEffortId})
    const run =
        work?.purposeEnumId === "WepProductionRun"
            ? work
            : work?.parentWorkEffortId
              ? one("mantle.work.effort.WorkEffort", {workEffortId: work.parentWorkEffortId})
              : null
    if (!work || run?.purposeEnumId !== "WepProductionRun")
        denied("RUN_REQUIRED", "Work " + workEffortId + " is not a production run or one of its operations")
    const runFacility = run.facilityId ? one("mantle.facility.Facility", {facilityId: run.facilityId}) : null
    if (run.ownerPartyId !== ownerPartyId || (run.facilityId && !facilityScope.owns(userScope, runFacility?.ownerPartyId)))
        denied("RECORD_UNAVAILABLE", "Production run " + run.workEffortId + " is not available")
    const item = one("mantle.order.OrderItem", {orderId, orderItemSeqId})
    if (!item) denied("RECORD_UNAVAILABLE", "Order item " + orderId + ":" + orderItemSeqId + " is not available")
    if (!one("mantle.order.OrderItemWorkEffort", {orderId, orderItemSeqId, workEffortId}))
        denied("SUBCONTRACT_LINK", "Order item " + orderId + ":" + orderItemSeqId + " is not for work " + workEffortId)
    const part = one("mantle.order.OrderPart", {orderId, orderPartSeqId: item.orderPartSeqId})
    if (part?.customerPartyId !== ownerPartyId)
        denied("RECORD_UNAVAILABLE", "Order " + orderId + " is not a purchase of " + ownerPartyId)
    if (part?.vendorPartyId !== custodianPartyId)
        denied("CUSTODIAN_MISMATCH", "Order " + orderId + " is not with the facility's custodian " + custodianPartyId)
    const header = one("mantle.order.OrderHeader", {orderId})
    const closed = ["OrderCancelled", "OrderRejected"]
    if (closed.includes(header?.statusId) || closed.includes(part.statusId) || closed.includes(item.statusId))
        denied("ORDER_CANCELLED", "Order " + orderId + " is cancelled")
    const service = item.productId ? one("mantle.product.Product", {productId: item.productId}) : null
    if (service?.productTypeEnumId !== "PtService")
        denied("NOT_SERVICE", "Order item " + orderId + ":" + orderItemSeqId + " is not a service")
    return {subcontractWorkEffortId: workEffortId, subcontractOrderId: orderId, subcontractOrderItemSeqId: orderItemSeqId,
        runWorkEffortId: run.workEffortId}
}

// ===== create#Transfer =====
// Both facilities the user's and open, one owner (an intercompany move is a sale), and a stocked product and quantity for
// each line: then create#Shipment (ShpTpTransfer from the owner to itself, its route from the origin to the destination)
// and a source line per row through create#ShipmentItem. Answers the shipment and its lines.
function create(userScope, p) {
    const origin = openFacility(userScope, p.originFacilityId)
    const destination = openFacility(userScope, p.destinationFacilityId)
    if (origin.facilityId === destination.facilityId) denied("SAME_FACILITY", "A transfer goes to another facility; use Move")
    if (origin.ownerPartyId !== destination.ownerPartyId)
        denied("OWNER_MISMATCH", "Facilities " + origin.facilityId + " and " + destination.facilityId + " have different owners")
    const lineRows = Array.from(p.lines || []).filter(row => row && !blank(row.productId))
    if (!lineRows.length) denied("LINES_REQUIRED", "Add a product and quantity to transfer")
    const lines = lineRows.map(row => {
        const product = productOf(row.productId)
        const quantity = dec(row.quantity)
        if (quantity.compare(0) <= 0) denied("QUANTITY_INVALID", "Give a quantity above zero for " + product.productId)
        return {product, quantity, row}
    })
    const custodian = custodianOf(destination.facilityId) || custodianOf(origin.facilityId)
    const keys = subcontractKeys(userScope, p, custodian, origin.ownerPartyId) || {}
    const created = call("mantle.shipment.ShipmentServices.create#Shipment", {
        shipmentTypeEnumId: "ShpTpTransfer",
        statusId: "ShipInput",
        fromPartyId: origin.ownerPartyId,
        toPartyId: destination.ownerPartyId,
        originFacilityId: origin.facilityId,
        destinationFacilityId: destination.facilityId,
        estimatedShipDate: p.estimatedShipDate || null,
        estimatedArrivalDate: p.estimatedArrivalDate || null,
        handlingInstructions: blank(p.reference) ? null : String(p.reference).trim(),
        subcontractWorkEffortId: keys.subcontractWorkEffortId || null,
        subcontractOrderId: keys.subcontractOrderId || null,
        subcontractOrderItemSeqId: keys.subcontractOrderItemSeqId || null
    })
    const answerLines = lines.map(({product, quantity, row}) => {
        const item = call("mantle.shipment.ShipmentServices.create#ShipmentItem", {
            shipmentId: created.shipmentId,
            productId: product.productId,
            quantity,
            statusId: "SisPending"
        })
        return {shipmentItemSourceId: item.shipmentItemSourceId, productId: product.productId, quantity: text(quantity),
            requestId: row.requestId || null, requestItemSeqId: row.requestItemSeqId || null}
    })
    return {
        shipmentId: created.shipmentId,
        originFacilityId: origin.facilityId,
        destinationFacilityId: destination.facilityId,
        ownerPartyId: origin.ownerPartyId,
        custodianPartyId: custodian,
        subcontract: !!keys.subcontractWorkEffortId,
        lines: answerLines
    }
}

// ===== the transfer, locked and scoped =====
// The transfer shipment, locked, with its origin (first route segment) and destination (last segment with one); side
// "origin" needs the origin in the user's facilities, "destination" the destination, "both" both.
function transferOf(userScope, shipmentId, side, lock = true) {
    const shipment = blank(shipmentId) ? null : find(SHIPMENT, {shipmentId}).forUpdate(lock).one()
    if (!shipment) denied("RECORD_UNAVAILABLE", "Transfer " + (shipmentId || "") + " is not available")
    const segments = rows(SEGMENT, {shipmentId}).sort((a, b) =>
        String(a.shipmentRouteSegmentSeqId).localeCompare(String(b.shipmentRouteSegmentSeqId))
    )
    const originId = segments[0]?.originFacilityId || null
    const destinationId = [...segments].reverse().find(segment => segment.destinationFacilityId)?.destinationFacilityId || null
    const origin = originId ? one(FACILITY, {facilityId: originId}) : null
    const destination = destinationId ? one(FACILITY, {facilityId: destinationId}) : null
    const owned = facility => !!facility && facilityScope.owns(userScope, facility.ownerPartyId)
    const visible =
        side === "origin" ? owned(origin) : side === "destination" ? owned(destination) : owned(origin) && owned(destination)
    if (!visible) denied("RECORD_UNAVAILABLE", "Transfer " + shipmentId + " is not available")
    if (shipment.shipmentTypeEnumId !== "ShpTpTransfer") denied("NOT_TRANSFER", "Shipment " + shipmentId + " is not a transfer")
    return {
        shipment,
        shipmentId,
        origin,
        destination,
        originFacilityId: originId,
        destinationFacilityId: destinationId,
        custodianPartyId: custodianOf(destinationId) || custodianOf(originId)
    }
}
function requireOpen(tr) {
    if (!openStatuses.includes(tr.shipment.statusId))
        denied("TRANSFER_SHIPPED", "Transfer " + tr.shipmentId + " is " + tr.shipment.statusId + "; nothing more is sent on it")
}
// A source line of the transfer, locked; one of another shipment (a forged id) is refused as missing.
function sourceOf(tr, shipmentItemSourceId, lock = true) {
    const source = blank(shipmentItemSourceId) ? null : find(SOURCE, {shipmentItemSourceId}).forUpdate(lock).one()
    if (!source || source.shipmentId !== tr.shipmentId)
        denied("RECORD_UNAVAILABLE", "Line " + (shipmentItemSourceId || "") + " is not on transfer " + tr.shipmentId)
    if (source.statusId === "SisCancelled") denied("SOURCE_CANCELLED", "Line " + shipmentItemSourceId + " is cancelled")
    return source
}

// ===== a line's movements, each summed on its own (F37) =====
// What the line's direct dispatches moved (dispatch#SubcontractStock's stored answers for the line).
function movedOn(shipmentItemSourceId) {
    return Array.from(
        find(OPERATION, {resultId: shipmentItemSourceId, operationType: "SubcontractDispatch", resultEntityName: SOURCE}).list()
    ).reduce((sum, row) => sum.add(dec(lib.json(row.resultJson, {}).quantity)), zero())
}
// Each issuance of the line (the stock it came from) with what its receipts accepted and rejected.
function issuancesOf(shipmentItemSourceId) {
    const issuances = rows(ISSUANCE, {shipmentItemSourceId}).sort((a, b) =>
        String(a.assetIssuanceId).localeCompare(String(b.assetIssuanceId))
    )
    const receipts = rows(RECEIPT, {shipmentItemSourceId})
    return issuances.map(issuance => {
        const issued = positive(dec(issuance.quantity).subtract(dec(issuance.quantityCancelled)))
        const received = receipts
            .filter(row => row.sourceAssetIssuanceId === issuance.assetIssuanceId)
            .reduce((sum, row) => sum.add(dec(row.quantityAccepted)).add(dec(row.quantityRejected)), zero())
        return {issuance, issued, received, inTransit: positive(issued.subtract(received))}
    })
}
// A line's quantity, issued, moved, received (accepted and rejected) and in transit; each total from its own rows.
// pending: a quantity moved in this operation, whose answer is not stored yet.
function lineOf(source, pending = null) {
    const issuances = issuancesOf(source.shipmentItemSourceId)
    const receipts = rows(RECEIPT, {shipmentItemSourceId: source.shipmentItemSourceId})
    const issued = issuances.reduce((sum, row) => sum.add(row.issued), zero())
    const moved = movedOn(source.shipmentItemSourceId).add(dec(pending))
    const accepted = receipts.reduce((sum, row) => sum.add(dec(row.quantityAccepted)), zero())
    const rejected = receipts.reduce((sum, row) => sum.add(dec(row.quantityRejected)), zero())
    const quantity = dec(source.quantity)
    return {
        source,
        issuances,
        quantity,
        issued,
        moved,
        accepted,
        rejected,
        inTransit: issuances.reduce((sum, row) => sum.add(row.inTransit), zero()),
        toSend: positive(quantity.subtract(issued).subtract(moved))
    }
}
const linesOf = (shipmentId, pending = {}) =>
    rows(SOURCE, {shipmentId})
        .filter(source => source.statusId !== "SisCancelled")
        .sort((a, b) => String(a.shipmentItemSourceId).localeCompare(String(b.shipmentItemSourceId)))
        .map(source => lineOf(source, pending[source.shipmentItemSourceId]))

// ===== the stock sent =====
// A named asset a line sends, locked: at the origin, the origin owner's (OWNER_MISMATCH: a transfer keeps one owner's stock),
// of the line's product, available or on a receiving hold, the quantity within its available to promise (stock reserved for
// orders stays theirs).
function stockToSend(userScope, tr, source, assetId, quantity) {
    const chosen = String(assetId)
    const asset = posting.stock(userScope, chosen, quantity)
    if (asset.facilityId !== tr.originFacilityId)
        denied("OTHER_FACILITY", "Asset " + chosen + " is not at " + tr.originFacilityId + ", the transfer's origin")
    if (asset.productId !== source.productId)
        denied("PRODUCT_MISMATCH", "Asset " + chosen + " is not " + source.productId)
    if (asset.ownerPartyId !== tr.origin.ownerPartyId)
        denied("OWNER_MISMATCH", "Asset " + chosen + " is " + asset.ownerPartyId + "'s, not the facility owner's")
    if (posting.heldStatuses.includes(asset.statusId))
        denied("HELD_STOCK", "Asset " + chosen + " is " + asset.statusId + "; only an inspection's disposition releases it")
    if (!usableStatuses.includes(asset.statusId))
        denied("STATUS_NOT_USABLE", "Asset " + chosen + " is " + asset.statusId + " and is not sent")
    if (dec(quantity).compare(dec(asset.availableToPromiseTotal)) > 0)
        denied(
            "QUANTITY_EXCEEDS_AVAILABLE",
            "Asset " + chosen + " has only " + text(asset.availableToPromiseTotal) + " not reserved for orders"
        )
    return asset
}
// The stock a line sends, as [{asset, quantity}]: the named asset, else the stock the line's guarded picks took (P11's
// pick#ShipmentStock answers), across as many of those assets as the quantity needs, each locked in id order and checked
// as a named one (P15 review C).
function piecesToSend(userScope, tr, source, assetId, quantity) {
    if (!blank(assetId)) return [{asset: stockToSend(userScope, tr, source, assetId, quantity), quantity: dec(quantity)}]
    // what the line's picks took onto each asset, less what the line already issued from it
    const picked = new Map()
    for (const row of Array.from(
        find(OPERATION, {resultId: source.shipmentItemSourceId, operationType: "ShipmentPick", resultEntityName: SOURCE}).list()
    ))
        for (const move of lib.json(row.resultJson, {}).moves || [])
            if (move.toAssetId) picked.set(move.toAssetId, (picked.get(move.toAssetId) || zero()).add(dec(move.quantity)))
    for (const issuance of rows(ISSUANCE, {shipmentItemSourceId: source.shipmentItemSourceId}))
        if (picked.has(issuance.assetId))
            picked.set(issuance.assetId, picked.get(issuance.assetId).subtract(dec(issuance.quantity)))
    const candidates = [...picked.keys()]
        .sort()
        .filter(id => picked.get(id).compare(0) > 0)
        .map(id => one(ASSET, {assetId: id}))
        .filter(row => row && row.facilityId === tr.originFacilityId && dec(row.availableToPromiseTotal).compare(0) > 0)
    if (!candidates.length) denied("ASSET_REQUIRED", "Choose the stock to send on line " + source.shipmentItemSourceId)
    const pieces = []
    let left = dec(quantity)
    for (const row of candidates) {
        if (left.compare(0) <= 0) break
        const take = min(min(left, picked.get(row.assetId)), dec(row.availableToPromiseTotal))
        pieces.push({asset: stockToSend(userScope, tr, source, row.assetId, take), quantity: take})
        left = left.subtract(take)
    }
    if (left.compare(0) > 0)
        denied(
            "QUANTITY_EXCEEDS_AVAILABLE",
            "The stock picked for line " + source.shipmentItemSourceId + " has only " + text(dec(quantity).subtract(left)) +
                " available; name the stock for the rest"
        )
    return pieces
}
// The quantity to send on a line: above zero, at most what is left to send.
function quantityToSend(line, quantity) {
    const wanted = blank(quantity) ? line.toSend : dec(quantity)
    if (wanted.compare(0) <= 0) denied("QUANTITY_INVALID", "Give a quantity above zero")
    if (wanted.compare(line.toSend) > 0)
        denied(
            "QUANTITY_EXCEEDS_REMAINING",
            "Only " + text(line.toSend) + " is left to send on line " + line.source.shipmentItemSourceId
        )
    return wanted
}
// The line's not-handled quantity lowered by what was sent (issued or moved), as Mantle's pack does.
function handled(source, quantity) {
    const fresh = one(SOURCE, {shipmentItemSourceId: source.shipmentItemSourceId})
    const left = positive(dec(fresh.quantityNotHandled ?? fresh.quantity).subtract(quantity))
    call("update#" + SOURCE, {
        shipmentItemSourceId: source.shipmentItemSourceId,
        quantityNotHandled: left,
        statusId: left.compare(0) > 0 ? fresh.statusId : "SisPacked"
    })
}
// issue#TransferStock's posting: issue#Asset of the asset to the line, then the issuance's entered quantity (F7).
function postIssue(tr, source, asset, quantity) {
    call("mantle.product.AssetServices.issue#Asset", {
        shipmentId: tr.shipmentId,
        shipmentItemSourceId: source.shipmentItemSourceId,
        assetId: asset.assetId,
        quantity
    })
    const issuance = Array.from(
        find(ISSUANCE, {shipmentId: tr.shipmentId, shipmentItemSourceId: source.shipmentItemSourceId, assetId: asset.assetId})
            .orderBy("-assetIssuanceId")
            .limit(1)
            .list()
    )[0]
    const product = one("mantle.product.Product", {productId: source.productId})
    if (issuance)
        call("update#" + ISSUANCE, {
            assetIssuanceId: issuance.assetIssuanceId,
            enteredQuantity: issuance.quantity,
            enteredQuantityUomId: product?.amountUomId || null,
            appliedConversionFactor: 1
        })
    handled(source, quantity)
    return issuance?.assetIssuanceId || null
}

// ===== ship#Transfer =====
// What a ship leaves outstanding (lines not fully sent), and with shipShort each such line lowered to what was sent (a line
// with nothing sent cancelled) and its ShipmentItem quantity kept equal to its lines'.
function shipPlan(tr, p) {
    const lines = linesOf(tr.shipmentId)
    const sent = lines.reduce((sum, line) => sum.add(line.issued).add(line.moved), zero())
    if (sent.compare(0) <= 0) denied("NOTHING_SENT", "Nothing has been sent on transfer " + tr.shipmentId)
    const outstanding = lines.filter(line => line.toSend.compare(0) > 0)
    const shipShort = p.shipShort === true || p.shipShort === "true" || p.shipShort === "Y"
    if (outstanding.length && !shipShort)
        denied(
            "OUTSTANDING",
            "Not all sent: " +
                outstanding
                    .map(line => line.source.productId + " " + text(line.toSend) + " of " + text(line.quantity))
                    .join(", ") +
                "; ship short to send what was issued"
        )
    return {lines, outstanding, shipShort}
}
function shipShortLines(tr, outstanding) {
    for (const line of outstanding) {
        const sent = line.issued.add(line.moved)
        call("update#" + SOURCE, {
            shipmentItemSourceId: line.source.shipmentItemSourceId,
            quantity: sent,
            quantityNotHandled: zero(),
            statusId: sent.compare(0) > 0 ? "SisPacked" : "SisCancelled"
        })
    }
    for (const productId of [...new Set(outstanding.map(line => line.source.productId))]) {
        const total = rows(SOURCE, {shipmentId: tr.shipmentId, productId})
            .filter(source => source.statusId !== "SisCancelled")
            .reduce((sum, source) => sum.add(dec(source.quantity)), zero())
        call("update#mantle.shipment.ShipmentItem", {shipmentId: tr.shipmentId, productId, quantity: total})
    }
}
// The shipment shipped: a picked one through packed (Mantle's flow has no Picked to Shipped), then ship#Shipment.
// A subcontract dispatch whose lines all went by moves (none issued) has nothing in transit, so it is delivered at once
// (P15 review B6, settleDispatched's rule). Answers whether it was delivered.
function shipShipment(tr) {
    if (tr.shipment.statusId === "ShipPicked") call("mantle.shipment.ShipmentServices.pack#Shipment", {shipmentId: tr.shipmentId})
    call("mantle.shipment.ShipmentServices.ship#Shipment", {shipmentId: tr.shipmentId})
    const movesOnly = !!tr.shipment.subcontractWorkEffortId && linesOf(tr.shipmentId).every(line => line.issued.compare(0) === 0)
    if (movesOnly) call("mantle.shipment.ShipmentServices.deliver#Shipment", {shipmentId: tr.shipmentId})
    return movesOnly
}

// ===== receive#TransferStock =====
// The transfer at its destination, locked, shipped (TRANSFER_NOT_SHIPPED before; RECEIPT_CLOSED once delivered or
// cancelled).
function receivingTransfer(userScope, shipmentId) {
    const tr = transferOf(userScope, shipmentId, "destination")
    if (openStatuses.includes(tr.shipment.statusId) || tr.shipment.statusId === "ShipPacked")
        denied("TRANSFER_NOT_SHIPPED", "Transfer " + shipmentId + " has not shipped; nothing is in transit yet")
    if (tr.shipment.statusId !== "ShipShipped")
        denied("RECEIPT_CLOSED", "Transfer " + shipmentId + " is " + tr.shipment.statusId + " and takes no more receipts")
    return tr
}
// The lines received: the named one, or every line of the product, locked by id, each with its issuances in transit.
function receiveLines(tr, p) {
    let sources
    if (!blank(p.shipmentItemSourceId)) sources = [sourceOf(tr, p.shipmentItemSourceId)]
    else {
        if (blank(p.productId)) denied("PRODUCT_REQUIRED", "Choose a product of the transfer")
        sources = Array.from(
            find(SOURCE, {shipmentId: tr.shipmentId, productId: p.productId})
                .orderBy("shipmentItemSourceId")
                .forUpdate(true)
                .list()
        ).filter(source => source.statusId !== "SisCancelled")
        if (!sources.length) denied("PRODUCT_NOT_ON_RECEIPT", "Product " + p.productId + " is not on transfer " + tr.shipmentId)
    }
    return sources.map(lineOf)
}
// Accepted and rejected (stock units) checked against what is in transit (OVER_RECEIPT), a rejection with its reason.
function receiveQuantities(lines, p) {
    const accepted = dec(p.quantityAccepted),
        rejected = dec(p.quantityRejected)
    if (accepted.compare(0) < 0 || rejected.compare(0) < 0) denied("QUANTITY_INVALID", "A quantity is not negative")
    const total = accepted.add(rejected)
    if (total.compare(0) <= 0) denied("QUANTITY_INVALID", "Give the quantity accepted or rejected")
    if (rejected.compare(0) > 0 && blank(p.rejectionReasonEnumId)) denied("REASON_REQUIRED", "Give the reason units are rejected")
    const inTransit = lines.reduce((sum, line) => sum.add(line.inTransit), zero())
    if (total.compare(inTransit) > 0)
        denied(
            "OVER_RECEIPT",
            text(total) + " received against " + text(inTransit) + " in transit on transfer " + lines[0].source.shipmentId
        )
    return {accepted, rejected, total, inTransit}
}
// The pieces of a receipt: the accepted, then the rejected, quantity taken from the lines' issuances in transit in order,
// each piece carrying its issuance's stock (cost, owner, lot, serial, expiry).
function pieces(lines, quantities) {
    let accepted = quantities.accepted,
        rejected = quantities.rejected
    const out = []
    for (const line of lines)
        for (const row of line.issuances) {
            let room = row.inTransit
            if (room.compare(0) <= 0) continue
            const take = min(room, accepted)
            accepted = accepted.subtract(take)
            room = room.subtract(take)
            const reject = min(room, rejected)
            rejected = rejected.subtract(reject)
            if (take.compare(0) > 0 || reject.compare(0) > 0)
                out.push({source: line.source, issuance: row.issuance, accepted: take, rejected: reject,
                    asset: one(ASSET, {assetId: row.issuance.assetId})})
        }
    return out
}
// receive#Asset of each piece at the destination with its issuance's stock, the receipt linked to the issuance
// (sourceAssetIssuanceId); a rejection with nothing accepted is written as the receipt alone (receive#Asset writes nothing
// for zero, F177). Answers the assets and receipts written.
function postPieces(tr, plan, p) {
    const assetIds = [],
        receiptIds = []
    for (const piece of plan.pieces) {
        const from = piece.asset || {}
        let receiptId
        if (piece.accepted.compare(0) > 0) {
            const out = call("mantle.product.AssetServices.receive#Asset", {
                productId: piece.source.productId,
                quantity: piece.accepted,
                quantityRejected: piece.rejected.compare(0) > 0 ? piece.rejected : null,
                rejectionReasonEnumId: piece.rejected.compare(0) > 0 ? p.rejectionReasonEnumId : null,
                facilityId: tr.destinationFacilityId,
                locationSeqId: plan.target.locationSeqId,
                statusId: plan.target.statusId || null,
                ownerPartyId: from.ownerPartyId || tr.destination.ownerPartyId,
                acquireCost: from.acquireCost ?? null,
                assetTypeEnumId: from.assetTypeEnumId || null,
                classEnumId: from.classEnumId || null,
                lotId: from.lotId || null,
                serialNumber: from.serialNumber || null,
                expectedEndOfLife: from.expectedEndOfLife || null,
                manufacturedDate: from.manufacturedDate || null,
                assetPoolId: from.assetPoolId || null,
                shipmentId: tr.shipmentId,
                shipmentItemSourceId: piece.source.shipmentItemSourceId
            })
            receiptId = out.assetReceiptId
            if (out.assetId) {
                assetIds.push(out.assetId)
                // receive#Asset takes the currency from an order only: the source stock's
                if (from.acquireCostUomId)
                    call("update#" + ASSET, {assetId: out.assetId, acquireCostUomId: from.acquireCostUomId})
            }
        } else
            receiptId = call("create#" + RECEIPT, {
                productId: piece.source.productId,
                shipmentId: tr.shipmentId,
                shipmentItemSourceId: piece.source.shipmentItemSourceId,
                receivedByUserId: ec.user.userId,
                receivedDate: ec.user.nowTimestamp,
                quantityAccepted: zero(),
                quantityRejected: piece.rejected,
                rejectionReasonEnumId: p.rejectionReasonEnumId || null
            }).assetReceiptId
        if (receiptId) {
            call("update#" + RECEIPT, {assetReceiptId: receiptId, sourceAssetIssuanceId: piece.issuance.assetIssuanceId})
            receiptIds.push(receiptId)
        }
    }
    return {assetIds, assetReceiptIds: receiptIds}
}
// Each line received in full marked received; the transfer delivered when every line is (nothing left in transit and
// nothing left to send).
function settleReceived(tr) {
    const lines = linesOf(tr.shipmentId)
    for (const line of lines)
        if (line.inTransit.compare(0) === 0 && line.toSend.compare(0) === 0 && line.source.statusId !== "SisReceived")
            call("update#" + SOURCE, {shipmentItemSourceId: line.source.shipmentItemSourceId, statusId: "SisReceived"})
    const done = lines.every(line => line.inTransit.compare(0) === 0 && line.toSend.compare(0) === 0)
    if (done) call("mantle.shipment.ShipmentServices.deliver#Shipment", {shipmentId: tr.shipmentId})
    return done
}

// ===== dispatch#SubcontractStock =====
// A subcontract dispatch (or return) still open, both ends the user's.
function dispatchTransfer(userScope, shipmentId) {
    const tr = transferOf(userScope, shipmentId, "both")
    if (!tr.shipment.subcontractWorkEffortId)
        denied("NOT_SUBCONTRACT", "Transfer " + shipmentId + " is not a subcontract dispatch; ship it and receive it")
    requireOpen(tr)
    return tr
}
// When every line went by direct moves (nothing issued), the dispatch is done: shipped and delivered at once. pending: the
// quantity this operation moved, by line.
function settleDispatched(tr, pending) {
    const lines = linesOf(tr.shipmentId, pending)
    const done = lines.every(line => line.toSend.compare(0) === 0) && lines.every(line => line.issued.compare(0) === 0)
    if (done) {
        call("mantle.shipment.ShipmentServices.ship#Shipment", {shipmentId: tr.shipmentId})
        call("mantle.shipment.ShipmentServices.deliver#Shipment", {shipmentId: tr.shipmentId})
    }
    return done
}

// ===== allocate#InventoryRequest =====
// The approved quantity of each request item (its approved Requirements, RequirementRequestItem) and what is allocated
// (allocations not on a cancelled transfer or a cancelled line).
function approvedOf(requestId, requestItemSeqId) {
    return rows("mantle.request.requirement.RequirementRequestItem", {requestId, requestItemSeqId})
        .map(link => one("mantle.request.requirement.Requirement", {requirementId: link.requirementId}))
        .filter(row => row && ["RqmtStApproved", "RqmtStOrdered"].includes(row.statusId))
        .reduce((sum, row) => sum.add(dec(row.quantity)), zero())
}
function allocatedOf(requestId, requestItemSeqId) {
    return rows(ALLOCATION, {requestId, requestItemSeqId})
        .filter(row => {
            if (!row.shipmentItemSourceId) return true
            const source = one(SOURCE, {shipmentItemSourceId: row.shipmentItemSourceId})
            const shipment = source ? one(SHIPMENT, {shipmentId: source.shipmentId}) : null
            return source?.statusId !== "SisCancelled" && shipment?.statusId !== "ShipCancelled"
        })
        .reduce((sum, row) => {
            // a transfer line shipped short allocates what it sent
            if (!row.shipmentItemSourceId) return sum.add(dec(row.quantity))
            const source = one(SOURCE, {shipmentItemSourceId: row.shipmentItemSourceId})
            return sum.add(min(dec(row.quantity), dec(source.quantity)))
        }, zero())
}
// The request, locked: an internal stock request of a facility of the user's organizations, approved (in progress).
function inventoryRequest(userScope, requestId) {
    const request = blank(requestId) ? null : find("mantle.request.Request", {requestId}).forUpdate(true).one()
    const facility = request?.facilityId ? one(FACILITY, {facilityId: request.facilityId}) : null
    if (!request || !facility || !facilityScope.owns(userScope, facility.ownerPartyId))
        denied("RECORD_UNAVAILABLE", "Request " + (requestId || "") + " is not available")
    if (request.requestTypeEnumId !== "RqtInventory")
        denied("NOT_INVENTORY_REQUEST", "Request " + requestId + " is not a stock request")
    if (request.statusId !== "ReqInProgress") denied("NOT_APPROVED", "Request " + requestId + " is not approved")
    return {request, facility}
}
// Each row: an item of the request, a quantity above zero and within what is approved and not yet allocated.
function allocationRows(req, p) {
    const list = Array.from(p.allocationRows || []).filter(row => row && dec(row.quantity).compare(0) > 0)
    if (!list.length) denied("QUANTITY_INVALID", "Give a quantity above zero to allocate")
    // one row per item, so the approved quantity is checked against all of it (P15 review B2)
    const itemIds = list.map(row => String(row.requestItemSeqId))
    const repeated = itemIds.filter((id, index) => itemIds.indexOf(id) !== index)
    if (repeated.length) denied("DUPLICATE_ITEM", "Item " + repeated[0] + " is on more than one row; give it one quantity")
    return list.map((row, index) => {
        const item = one("mantle.request.RequestItem", {requestId: req.request.requestId, requestItemSeqId: row.requestItemSeqId})
        if (!item) denied("RECORD_UNAVAILABLE", "Item " + row.requestItemSeqId + " is not on request " + req.request.requestId)
        const approved = approvedOf(item.requestId, item.requestItemSeqId)
        const open = positive(approved.subtract(allocatedOf(item.requestId, item.requestItemSeqId)))
        const quantity = dec(row.quantity)
        if (quantity.compare(open) > 0)
            denied(
                "QUANTITY_EXCEEDS_APPROVED",
                "Only " + text(open) + " of item " + item.requestItemSeqId + " is approved and not allocated"
            )
        return {item, quantity, index, assetId: row.assetId || null, toLocationSeqId: row.toLocationSeqId || null}
    })
}
function writeAllocation(req, row, fields, operationKey) {
    return call("create#" + ALLOCATION, Object.assign({
        requestId: req.request.requestId,
        requestItemSeqId: row.item.requestItemSeqId,
        quantity: row.quantity,
        operationKey,
        allocatedByUserId: ec.user.userId,
        allocatedDate: ec.user.nowTimestamp
    }, fields)).allocationId
}

;({
    openStatuses,
    usableStatuses,
    custodianOf,
    create,
    transferOf,
    requireOpen,
    sourceOf,
    lineOf,
    linesOf,
    stockToSend,
    piecesToSend,
    quantityToSend,
    handled,
    postIssue,
    shipPlan,
    shipShortLines,
    shipShipment,
    receivingTransfer,
    receiveLines,
    receiveQuantities,
    pieces,
    postPieces,
    settleReceived,
    dispatchTransfer,
    settleDispatched,
    approvedOf,
    allocatedOf,
    inventoryRequest,
    allocationRows,
    writeAllocation,
    text
})
