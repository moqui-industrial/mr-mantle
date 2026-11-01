// The Warehouse pick entry points' rules (impl-warehouse P11, design-warehouse §9 Pick and PickLocationMoves, §17 WH-PICK):
// mantle.shipment.WarehouseTaskServices pick#ShipmentStock, record#ShortPick, reverse#Pick, finish#Pick and
// find#PickFaceReplenishment take StockPosting.js's steps in their XML; this module holds what they share: the outgoing
// shipment of a facility of the user's organizations (its facility is its first route segment's origin, F55), a source line
// of it, the reservations a pick takes at a location, the short pick record with its recount, the put back of picked stock
// to where it was picked from, what a finish leaves outstanding, and the pick faces below their minimum (F19). A pick moves
// no value (stock is issued at pack), so no entry point here checks the fiscal period. One lock order: the shipment, then
// its source line, then a container, then assets by id, then the destination location.
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const posting = ec.resource.script("component://mr-mantle/service/mantle/shipment/StockPosting.js")
const facilityScope = ec.resource.script("component://mr-mantle/service/mantle/facility/FacilityScope.js")
const {find, one, rows, denied, call} = lib

const SHIPMENT = "mantle.shipment.Shipment",
    SOURCE = "mantle.shipment.ShipmentItemSource",
    SEGMENT = "mantle.shipment.ShipmentRouteSegment",
    RESERVATION = "mantle.product.issuance.AssetReservation",
    ASSET = "mantle.product.asset.Asset",
    EXCEPTION = "mantle.shipment.ShipmentPickException",
    LOCATION = "mantle.facility.FacilityLocation",
    OPERATION = "mantle.ledger.transaction.PostingOperation"
// shipments a facility receives, and drop shipments, which Purchasing and Sales own, are never picked here
const notPicked = ["ShpTpPurchase", "ShpTpSalesReturn", "ShpTpDrop"]
const pickable = ["ShipInput", "ShipScheduled"]
const unpackedStatuses = ["ShipInput", "ShipScheduled", "ShipPicked"]

const blank = value => value == null || String(value).trim() === ""
const number = value => (value == null || value === "" ? 0 : Number(String(value)))
const text = value => String(Math.round(number(value) * 1000000) / 1000000)
const truthy = value => value === true || value === "true" || value === "Y"

// The outgoing shipment, locked: its origin facility (the first route segment, F55) is one of the user's organizations';
// a missing shipment, one with no origin, an incoming or drop shipment and one outside the scope are refused alike.
function shipmentOf(userScope, shipmentId, lock = true) {
    const shipment = blank(shipmentId) ? null : find(SHIPMENT, {shipmentId}).forUpdate(lock).one()
    const segment = shipment
        ? Array.from(find(SEGMENT, {shipmentId}).orderBy("shipmentRouteSegmentSeqId").limit(1).list())[0]
        : null
    const facility = segment?.originFacilityId ? one("mantle.facility.Facility", {facilityId: segment.originFacilityId}) : null
    if (!shipment || !facility || notPicked.includes(shipment.shipmentTypeEnumId) || !facilityScope.owns(userScope, facility.ownerPartyId))
        denied("RECORD_UNAVAILABLE", "Shipment " + (shipmentId || "") + " is not available")
    return {shipment, shipmentId: shipment.shipmentId, facility, facilityId: facility.facilityId}
}
function requirePickable(sh) {
    if (!pickable.includes(sh.shipment.statusId))
        denied("SHIPMENT_NOT_PICKABLE", "Shipment " + sh.shipmentId + " is " + sh.shipment.statusId + "; only an unpicked shipment is picked")
}
// A source line of the shipment, locked; a line of another shipment (a forged id) is refused as missing.
function sourceOf(sh, shipmentItemSourceId, lock = true) {
    const source = blank(shipmentItemSourceId) ? null : find(SOURCE, {shipmentItemSourceId}).forUpdate(lock).one()
    if (!source || source.shipmentId !== sh.shipmentId)
        denied("RECORD_UNAVAILABLE", "Line " + (shipmentItemSourceId || "") + " is not on shipment " + sh.shipmentId)
    if (source.statusId === "SisCancelled") denied("SOURCE_CANCELLED", "Line " + shipmentItemSourceId + " is cancelled")
    return source
}
const toPickOf = source => Math.max(0, number(source.quantity) - number(source.quantityPicked))
const shortOf = shipmentItemSourceId => rows(EXCEPTION, {shipmentItemSourceId}).reduce((sum, row) => sum + number(row.quantityShort), 0)

// The quantity to pick: above zero and at most what is left to pick on the line.
function quantityToPick(source, quantity) {
    const wanted = blank(quantity) ? toPickOf(source) : number(quantity)
    if (!(wanted > 0)) denied("QUANTITY_INVALID", "Give a quantity above zero")
    if (wanted > toPickOf(source))
        denied("QUANTITY_EXCEEDS_REMAINING", "Only " + text(toPickOf(source)) + " is left to pick on line " + source.shipmentItemSourceId)
    return wanted
}
// The line's reservations whose stock is at the location (and is the asset, when one was scanned), each asset locked in id
// order and checked as stock of the user's facilities, never held stock (HELD_STOCK: quarantine is released only by a
// disposition, with or without a container); refuses less reserved there than the quantity (NOT_RESERVED_HERE: a short pick
// records what is missing). Stock already in the pick container (containerId) is not picked again. The caller locks the
// destination location after these assets (the one lock order) and then checks keepHeld against it.
function reservedAt(userScope, sh, source, p, quantity, containerId) {
    const reservations = Array.from(
        find(RESERVATION, {orderId: source.orderId, orderItemSeqId: source.orderItemSeqId, productId: source.productId})
            .condition("quantityNotIssued", "not-equals", 0)
            .orderBy("assetId")
            .list()
    )
    const byAsset = new Map()
    for (const reservation of reservations) {
        if (!byAsset.has(reservation.assetId)) byAsset.set(reservation.assetId, [])
        byAsset.get(reservation.assetId).push(reservation)
    }
    let available = 0
    const assets = []
    for (const assetId of [...byAsset.keys()].sort()) {
        const asset = find(ASSET, {assetId}).forUpdate(true).one()
        if (!asset || asset.facilityId !== sh.facilityId) continue
        if (!blank(p.locationSeqId) && asset.locationSeqId !== p.locationSeqId) continue
        if (!blank(p.assetId) && asset.assetId !== p.assetId) continue
        if (containerId && asset.containerId === containerId) continue
        posting.stock(userScope, assetId, null)
        if (posting.heldStatuses.includes(asset.statusId))
            denied("HELD_STOCK", "Asset " + assetId + " is " + asset.statusId + "; held stock is not picked")
        for (const reservation of byAsset.get(assetId))
            available += Math.max(0, number(reservation.quantityNotIssued) - number(reservation.quantityNotAvailable))
        assets.push(asset)
    }
    if (available < quantity)
        denied(
            "NOT_RESERVED_HERE",
            "Only " + text(available) + " of line " + source.shipmentItemSourceId + " is reserved" +
                (blank(p.locationSeqId) ? "" : " at " + p.locationSeqId) + "; record a short pick for what is missing"
        )
    return assets
}
// A transfer line's stock at the location (and the asset, when one was scanned): a transfer has no order and so no
// reservation (impl-warehouse P15), so the pick takes the line's product available at the origin (available or on a
// receiving hold, never held stock, with available to promise: stock reserved for orders stays theirs), each asset locked in
// id order; refuses less there than the quantity (NOT_AVAILABLE_HERE).
function transferStockAt(userScope, sh, source, p, quantity, containerId) {
    if (blank(p.assetId) && blank(p.locationSeqId))
        denied("ASSET_REQUIRED", "Scan the stock or the location to pick line " + source.shipmentItemSourceId + " from")
    let query = find(ASSET, {facilityId: sh.facilityId, productId: source.productId})
        .condition("availableToPromiseTotal", "greater", 0)
        .orderBy("assetId")
    if (!blank(p.assetId)) query = query.condition("assetId", p.assetId)
    if (!blank(p.locationSeqId)) query = query.condition("locationSeqId", p.locationSeqId)
    let available = 0
    const assets = []
    for (const candidate of Array.from(query.list())) {
        if (containerId && candidate.containerId === containerId) continue
        const asset = posting.stock(userScope, candidate.assetId, null)
        if (posting.heldStatuses.includes(asset.statusId))
            denied("HELD_STOCK", "Asset " + asset.assetId + " is " + asset.statusId + "; held stock is not picked")
        if (!["AstAvailable", "AstOnHold"].includes(asset.statusId)) continue
        // a transfer keeps the facility owner's stock: a scanned asset of another owner is refused, another left alone
        if (asset.ownerPartyId !== sh.facility.ownerPartyId) {
            if (!blank(p.assetId))
                denied("OWNER_MISMATCH", "Asset " + asset.assetId + " is " + asset.ownerPartyId + "'s, not the facility owner's")
            continue
        }
        available += number(asset.availableToPromiseTotal)
        assets.push(asset)
    }
    if (available < quantity)
        denied(
            "NOT_AVAILABLE_HERE",
            "Only " + text(available) + " of " + source.productId + " is available" +
                (blank(p.locationSeqId) ? "" : " at " + p.locationSeqId) + " for line " + source.shipmentItemSourceId
        )
    return assets
}
// A transfer line's pick: each asset's available quantity in id order, moved into the pick container (move#Asset, no
// reservation) when there is one; the line's quantityPicked raised. Answers what pickMove#ShipmentProduct answers.
function pickTransfer(sh, source, assets, quantity, containerId) {
    const container = containerId ? one("mantle.product.asset.Container", {containerId}) : null
    const pickedMoveList = []
    let left = quantity
    for (const asset of assets) {
        if (left <= 0) break
        const take = Math.min(left, number(asset.availableToPromiseTotal))
        if (!(take > 0)) continue
        const moved = container
            ? call("mantle.product.AssetServices.move#Asset", {
                  assetId: asset.assetId,
                  quantity: take,
                  facilityId: container.facilityId,
                  locationSeqId: container.locationSeqId,
                  containerId: container.containerId
              })
            : {}
        pickedMoveList.push({
            shipmentItemSourceId: source.shipmentItemSourceId,
            assetReservationId: null,
            assetId: asset.assetId,
            fromLocationSeqId: asset.locationSeqId || null,
            fromContainerId: asset.containerId || null,
            toAssetId: moved.newAssetId || asset.assetId,
            toContainerId: container?.containerId || null,
            quantity: text(take)
        })
        left -= take
    }
    const quantityPicked = quantity - left
    const fresh = one(SOURCE, {shipmentItemSourceId: source.shipmentItemSourceId})
    call("update#" + SOURCE, {
        shipmentItemSourceId: fresh.shipmentItemSourceId,
        quantityPicked: number(fresh.quantityPicked) + quantityPicked
    })
    return {quantityPicked, pickedMoveList}
}
// The entered quantity fields of a guarded pick (F7): what the picker entered, in the stock unit, factor 1.
function recordEntered(source) {
    const fresh = one(SOURCE, {shipmentItemSourceId: source.shipmentItemSourceId})
    const product = one("mantle.product.Product", {productId: fresh.productId})
    call("update#" + SOURCE, {
        shipmentItemSourceId: fresh.shipmentItemSourceId,
        enteredQuantity: fresh.quantityPicked,
        enteredQuantityUomId: product?.amountUomId || null,
        appliedConversionFactor: 1
    })
    return fresh
}
function expiryWarnings(assets) {
    return assets.flatMap(asset => posting.expiryWarnings(asset.assetId).map(row => Object.assign({assetId: asset.assetId}, row)))
}

// ===== short pick =====
function shortPlan(userScope, sh, source, p) {
    const quantity = number(p.quantityShort)
    if (!(quantity > 0)) denied("QUANTITY_INVALID", "Give the quantity not found, above zero")
    const open = Math.max(0, toPickOf(source) - shortOf(source.shipmentItemSourceId))
    if (quantity > open)
        denied("QUANTITY_EXCEEDS_REMAINING", "Only " + text(open) + " of line " + source.shipmentItemSourceId + " is left unpicked and not short")
    if (blank(p.reasonEnumId)) denied("REASON_REQUIRED", "Choose why the stock was not picked")
    if (one("moqui.basic.Enumeration", {enumId: p.reasonEnumId})?.enumTypeId !== "ShortPickReason")
        denied("REASON_INVALID", "Choose a short pick reason")
    const resolutionEnumId = blank(p.resolutionEnumId) ? "SpresRecount" : p.resolutionEnumId
    if (one("moqui.basic.Enumeration", {enumId: resolutionEnumId})?.enumTypeId !== "ShortPickResolution")
        denied("RESOLUTION_INVALID", "Choose a short pick resolution")
    let asset = null
    if (!blank(p.assetId)) {
        asset = one(ASSET, {assetId: p.assetId})
        if (!asset || asset.facilityId !== sh.facilityId || asset.productId !== source.productId)
            denied("RECORD_UNAVAILABLE", "Asset " + p.assetId + " is not stock of this line here")
    }
    const locationSeqId = blank(p.locationSeqId) ? asset?.locationSeqId || null : String(p.locationSeqId)
    if (locationSeqId && !one(LOCATION, {facilityId: sh.facilityId, locationSeqId}))
        denied("LOCATION_UNAVAILABLE", "Location " + locationSeqId + " is not in facility " + sh.facilityId)
    if (!locationSeqId && !asset) denied("LOCATION_REQUIRED", "Name the location or the stock that was short")
    const product = one("mantle.product.Product", {productId: source.productId})
    return {quantity, resolutionEnumId, asset, locationSeqId, quantityUomId: product?.amountUomId || null}
}
// The exception, the recount it asks for (Counts' request#Count with CntSrcShortPick: the stock, else its location; an open
// recount of the same stock answers it) and the notice to the facility owner's pick supervisors. On-hand is not changed.
function writeShort(sh, source, plan, p, op) {
    const created = call("create#" + EXCEPTION, {
        shipmentItemSourceId: source.shipmentItemSourceId,
        shipmentId: sh.shipmentId,
        productId: source.productId,
        assetId: plan.asset?.assetId || null,
        facilityId: sh.facilityId,
        locationSeqId: plan.locationSeqId,
        quantityShort: plan.quantity,
        quantityUomId: plan.quantityUomId,
        reasonEnumId: p.reasonEnumId,
        resolutionEnumId: plan.resolutionEnumId,
        operationKey: op.operationKey,
        comments: blank(p.comments) ? null : String(p.comments).trim(),
        reportedByUserId: ec.user.userId,
        reportedDate: ec.user.nowTimestamp
    })
    let recount = {physicalInventoryId: null, existing: false}
    if (p.requestRecount == null || p.requestRecount === "" || truthy(p.requestRecount)) {
        recount = call("mantle.product.InventoryCountServices.request#Count", {
            facilityId: sh.facilityId,
            countSourceEnumId: "CntSrcShortPick",
            sourceReference: "Short pick " + created.exceptionId + " on " + sh.shipmentId,
            assetIds: plan.asset ? [plan.asset.assetId] : null,
            scopeLocationSeqId: plan.asset ? null : plan.locationSeqId
        })
        call("update#" + EXCEPTION, {exceptionId: created.exceptionId, physicalInventoryId: recount.physicalInventoryId})
    }
    try {
        ec.resource.script("component://mr-mantle/service/mantle/account/Payables.js").execute("notify", {
            topic: "WarehouseShortPick",
            permission: "SHIPMENT_LOAD_EDIT",
            organizationPartyId: sh.facility.ownerPartyId,
            recordEntityName: SHIPMENT,
            recordId: sh.shipmentId,
            message: {
                shipmentId: sh.shipmentId,
                shipmentItemSourceId: source.shipmentItemSourceId,
                productId: source.productId,
                quantityShort: text(plan.quantity),
                locationSeqId: plan.locationSeqId,
                exceptionId: created.exceptionId,
                facilityId: sh.facilityId
            }
        })
    } catch (error) {
        ec.logger.error("Short pick notice for " + sh.shipmentId + " failed: " + error.message)
    }
    return {exceptionId: created.exceptionId, physicalInventoryId: recount.physicalInventoryId || null, recountExisting: !!recount.existing}
}

// ===== put back =====
// What the line's guarded picks moved into a pick container and has not been put back yet, newest first: each pick's stored
// answer (PostingOperation of type ShipmentPick for the line) less what earlier put backs moved.
function pickedMoves(source) {
    const answers = type =>
        Array.from(
            find(OPERATION, {resultId: source.shipmentItemSourceId, operationType: type, resultEntityName: SOURCE})
                .orderBy("completedDate")
                .list()
        ).map(row => lib.json(row.resultJson, {}))
    const remaining = new Map()
    const order = []
    for (const answer of answers("ShipmentPick"))
        for (const move of answer.moves || []) {
            if (!move.toContainerId) continue
            const keyOf = move.toAssetId + "|" + (move.fromLocationSeqId || "")
            if (!remaining.has(keyOf)) {
                remaining.set(keyOf, Object.assign({}, move, {quantity: 0}))
                order.push(keyOf)
            }
            remaining.get(keyOf).quantity += number(move.quantity)
        }
    // each put back names the pick it consumed (pickKey), whatever location it went to
    for (const answer of answers("ShipmentPickReverse"))
        for (const move of answer.moves || [])
            if (move.pickKey && remaining.has(move.pickKey)) remaining.get(move.pickKey).quantity -= number(move.quantity)
    return order.reverse().map(keyOf => Object.assign(remaining.get(keyOf), {pickKey: keyOf})).filter(move => move.quantity > 0)
}
// The quantity to put back (by default the flagged quantity, else everything picked and not packed), and each move back:
// the picked stock still in its pick container to the location it came from, or to toLocationSeqId. Locks the containers,
// then the assets by id, then each destination location; quantity picked without a container moves nothing.
function reversePlan(userScope, sh, source, p) {
    if (!unpackedStatuses.includes(sh.shipment.statusId))
        denied("ALREADY_PACKED", "Shipment " + sh.shipmentId + " is " + sh.shipment.statusId + "; put back packed stock from Pack")
    const issued = rows("mantle.product.issuance.AssetIssuance", {
        shipmentId: sh.shipmentId,
        orderId: source.orderId,
        orderItemSeqId: source.orderItemSeqId,
        productId: source.productId
    }).reduce((sum, row) => sum + number(row.quantity), 0)
    const unpacked = Math.max(0, number(source.quantityPicked) - issued)
    const flagged = number(source.putBackQuantity)
    const quantity = blank(p.quantity) ? (flagged > 0 ? Math.min(flagged, unpacked) : unpacked) : number(p.quantity)
    if (!(quantity > 0)) denied("NOTHING_TO_PUT_BACK", "Nothing picked on line " + source.shipmentItemSourceId + " is left to put back")
    if (quantity > unpacked)
        denied("QUANTITY_EXCEEDS_PICKED", "Only " + text(unpacked) + " picked and not packed on line " + source.shipmentItemSourceId)
    const moves = []
    let left = quantity
    const candidates = pickedMoves(source)
    const containers = [...new Set(candidates.map(move => move.toContainerId))].sort()
    for (const containerId of containers) posting.container(userScope, containerId)
    const assets = new Map()
    for (const assetId of [...new Set(candidates.map(move => move.toAssetId))].sort())
        assets.set(assetId, find(ASSET, {assetId}).forUpdate(true).one())
    for (const move of candidates) {
        if (left <= 0) break
        const asset = assets.get(move.toAssetId)
        if (!asset || asset.containerId !== move.toContainerId || number(asset.quantityOnHandTotal) <= 0) continue
        const take = Math.min(left, move.quantity, number(asset.quantityOnHandTotal))
        const toLocationSeqId = blank(p.toLocationSeqId) ? move.fromLocationSeqId : String(p.toLocationSeqId)
        if (!toLocationSeqId) denied("LOCATION_REQUIRED", "Choose where to put back asset " + asset.assetId)
        moves.push({asset, quantity: take, toLocationSeqId, pickKey: move.pickKey})
        left -= take
    }
    // stock picked into the shipment's container by another path has no recorded pick: it is put back by a move, not here
    if (left > 0 && sh.shipment.pickContainerId)
        denied(
            "UNTRACKED_PICK",
            text(left) + " picked on line " + source.shipmentItemSourceId + " has no recorded pick to put back; " +
                "move it out of container " + sh.shipment.pickContainerId + " instead"
        )
    for (const move of moves) {
        move.target = posting.destination(userScope, sh.facilityId, {toLocationSeqId: move.toLocationSeqId})
        move.statusId = posting.keepHeld(move.asset, move.target)
    }
    return {quantity, moves, untracked: left}
}
// The moves (an unpick takes the line's reservation on the stock with it, so the allocation is restored; a cancelled balance
// moves no reservation: the line's remaining reservation stays on the picked stock in the container, F262), the line's picked
// and put back quantities, and the shipment back to Scheduled when a picked shipment is short again.
function putBack(sh, source, plan) {
    const done = []
    const cancelledBalance = number(source.putBackQuantity) > 0
    for (const move of plan.moves) {
        const reservation = cancelledBalance ? null : Array.from(
            find(RESERVATION, {assetId: move.asset.assetId, orderId: source.orderId, orderItemSeqId: source.orderItemSeqId})
                .condition("quantityNotIssued", "greater", 0)
                .list()
        )[0]
        const moved = call("mantle.product.AssetServices.move#Asset", {
            assetId: move.asset.assetId,
            facilityId: sh.facilityId,
            locationSeqId: move.target.locationSeqId,
            containerId: null,
            assetPoolId: move.asset.assetPoolId,
            quantity: move.quantity,
            moveAssetReservationId: reservation?.assetReservationId || null
        })
        done.push({
            assetId: move.asset.assetId,
            toAssetId: moved.newAssetId || move.asset.assetId,
            quantity: text(move.quantity),
            fromContainerId: move.asset.containerId,
            toLocationSeqId: move.target.locationSeqId,
            pickKey: move.pickKey,
            reservationKept: !!reservation
        })
    }
    // move#Asset carries reservations along when stock enters a pick location from elsewhere, so after a cancelled balance's
    // put back the line's remaining reservation is put back on the picked stock still in the container (F262)
    if (cancelledBalance && sh.shipment.pickContainerId && source.orderId) {
        const picked = Array.from(
            find(ASSET, {containerId: sh.shipment.pickContainerId, productId: source.productId})
                .condition("quantityOnHandTotal", "greater", 0)
                .orderBy("assetId")
                .list()
        ).map(row => row.assetId)
        if (picked.length)
            call("mantle.product.AssetServices.reserve#AssetForOrderItem", {
                orderId: source.orderId,
                orderItemSeqId: source.orderItemSeqId,
                resetReservations: true,
                assetIdList: picked
            })
    }
    const fresh = one(SOURCE, {shipmentItemSourceId: source.shipmentItemSourceId})
    const putBackLeft = Math.max(0, number(fresh.putBackQuantity) - plan.quantity)
    call("update#" + SOURCE, {
        shipmentItemSourceId: fresh.shipmentItemSourceId,
        quantityPicked: Math.max(0, number(fresh.quantityPicked) - plan.quantity),
        putBackQuantity: putBackLeft > 0 ? putBackLeft : null,
        putBackDate: putBackLeft > 0 ? fresh.putBackDate : null
    })
    let statusId = sh.shipment.statusId
    if (statusId === "ShipPicked" && outstandingOf(sh).some(row => row.outstanding > 0)) {
        call("update#" + SHIPMENT, {shipmentId: sh.shipmentId, statusId: "ShipScheduled"})
        statusId = "ShipScheduled"
    }
    return {moves: done, statusId}
}

// ===== finish =====
// Each live source line's quantity, picked, short and outstanding (not picked).
function outstandingOf(sh) {
    return rows(SOURCE, {shipmentId: sh.shipmentId})
        .filter(row => row.statusId !== "SisCancelled" && number(row.quantity) > 0)
        .map(row => ({
            shipmentItemSourceId: row.shipmentItemSourceId,
            productId: row.productId,
            orderId: row.orderId,
            orderItemSeqId: row.orderItemSeqId,
            quantity: number(row.quantity),
            picked: number(row.quantityPicked),
            short: shortOf(row.shipmentItemSourceId),
            outstanding: toPickOf(row)
        }))
}
const outstandingText = lines =>
    lines
        .filter(row => row.outstanding > 0)
        .map(row => row.productId + " " + text(row.outstanding) + (row.short > 0 ? " (short " + text(row.short) + ")" : ""))
        .join(", ")
// Lowers each outstanding line to what was picked (update#ShipmentItem), so the order's remainder ships later, and marks
// its open short picks backordered.
function backorder(sh, lines) {
    const done = []
    for (const line of lines.filter(row => row.outstanding > 0)) {
        const item = one("mantle.shipment.ShipmentItem", {shipmentId: sh.shipmentId, productId: line.productId})
        call("mantle.shipment.ShipmentServices.update#ShipmentItem", {
            shipmentId: sh.shipmentId,
            productId: line.productId,
            shipmentItemSourceId: line.shipmentItemSourceId,
            quantity: Math.max(0, number(item?.quantity) - line.outstanding)
        })
        for (const exception of rows(EXCEPTION, {shipmentItemSourceId: line.shipmentItemSourceId}))
            call("update#" + EXCEPTION, {exceptionId: exception.exceptionId, resolutionEnumId: "SpresBackorder"})
        done.push({shipmentItemSourceId: line.shipmentItemSourceId, productId: line.productId, quantity: text(line.outstanding)})
    }
    return done
}
// A shipment load (picklist) of a facility of the user's organizations, locked.
function loadOf(userScope, workEffortId, lock = true) {
    const load = blank(workEffortId) ? null : find("mantle.work.effort.WorkEffort", {workEffortId}).forUpdate(lock).one()
    const facility = load?.facilityId ? one("mantle.facility.Facility", {facilityId: load.facilityId}) : null
    if (!load || load.purposeEnumId !== "WepShipmentShip" || !facility || !facilityScope.owns(userScope, facility.ownerPartyId))
        denied("RECORD_UNAVAILABLE", "Picklist " + (workEffortId || "") + " is not available")
    return {load, facility}
}
// The load's shipments not picked yet (Input or Scheduled), which completing the load takes off it.
function loadOutstanding(workEffortId) {
    return rows(SHIPMENT, {shipWorkEffortId: workEffortId})
        .filter(row => pickable.includes(row.statusId))
        .map(row => row.shipmentId)
        .sort()
}

// ===== pick faces =====
// The pick faces (ProductFacilityLocation rows of open pick locations with a minimumStock) whose on-hand stock there (of
// available status) is below the minimum, each with the bulk stock that can refill it (available-to-promise stock at open
// bulk locations, earliest expiry first) and the suggested quantity (moveQuantity, else up to the minimum), at most the bulk
// stock, split over the sources in that order: each source's moveQuantity is at most its own available stock, so each is one
// move#Stock (F261). Faces with no bulk stock are left out unless includeWithoutSource. The first reader of these levels
// (F19). A location closing in the future is still open. Reads only.
const faceLimit = 500
function pickFaceReplenishment(p) {
    posting.requirePermission(["STOCK_MOVE", "SHIPMENT_PICK", "SHIPMENT_LOAD_EDIT"])
    const userScope = posting.scope()
    const facility = posting.facility(userScope, p.facilityId)
    const facilityId = facility.facilityId
    const now = lib.ms(ec.user.nowTimestamp)
    const locations = new Map(
        rows(LOCATION, {facilityId})
            .filter(row => !row.thruDate || lib.ms(row.thruDate) > now)
            .map(row => [row.locationSeqId, row])
    )
    let faceQuery = find("mantle.facility.ProductFacilityLocation", {facilityId}).condition("minimumStock", "is-not-null", null)
    if (!blank(p.productId)) faceQuery = faceQuery.condition("productId", p.productId)
    const faces = Array.from(faceQuery.orderBy("locationSeqId,productId").limit(faceLimit + 1).list())
    const truncated = faces.length > faceLimit
    const faceRows = []
    for (const face of faces.slice(0, faceLimit)) {
        if (locations.get(face.locationSeqId)?.locationTypeEnumId !== "FltPick") continue
        const stock = rows(ASSET, {productId: face.productId, facilityId})
        const current = stock
            .filter(asset => asset.locationSeqId === face.locationSeqId && asset.statusId === "AstAvailable")
            .reduce((sum, asset) => sum + number(asset.quantityOnHandTotal), 0)
        const minimum = number(face.minimumStock)
        if (current >= minimum) continue
        const sources = stock
            .filter(
                asset =>
                    asset.statusId === "AstAvailable" &&
                    number(asset.availableToPromiseTotal) > 0 &&
                    locations.get(asset.locationSeqId)?.locationTypeEnumId === "FltBulk"
            )
            .sort((a, b) => (lib.ms(a.expectedEndOfLife) ?? Infinity) - (lib.ms(b.expectedEndOfLife) ?? Infinity) ||
                (lib.ms(a.receivedDate) ?? 0) - (lib.ms(b.receivedDate) ?? 0) || String(a.assetId).localeCompare(String(b.assetId)))
            .map(asset => ({
                assetId: asset.assetId,
                locationSeqId: asset.locationSeqId,
                lotId: asset.lotId || null,
                available: text(asset.availableToPromiseTotal),
                expiryDate: asset.expectedEndOfLife ? lib.dateText(asset.expectedEndOfLife) : null
            }))
        if (!sources.length && !truthy(p.includeWithoutSource)) continue
        const bulk = sources.reduce((sum, row) => sum + number(row.available), 0)
        const wanted = number(face.moveQuantity) > 0 ? number(face.moveQuantity) : minimum - current
        const suggested = Math.min(wanted, bulk)
        let left = suggested
        for (const source of sources) {
            const take = Math.min(left, number(source.available))
            source.moveQuantity = text(take)
            left -= take
        }
        const product = one("mantle.product.Product", {productId: face.productId})
        faceRows.push({
            productId: face.productId,
            productName: product?.productName || face.productId,
            locationSeqId: face.locationSeqId,
            minimumStock: text(minimum),
            moveQuantity: face.moveQuantity == null ? null : text(face.moveQuantity),
            currentQuantity: text(current),
            bulkQuantity: text(bulk),
            suggestedQuantity: text(suggested),
            sources
        })
    }
    return {facilityId, faceRows, truncated}
}

;({
    number,
    text,
    truthy,
    shipmentOf,
    requirePickable,
    sourceOf,
    toPickOf,
    shortOf,
    quantityToPick,
    reservedAt,
    transferStockAt,
    pickTransfer,
    recordEntered,
    expiryWarnings,
    shortPlan,
    writeShort,
    pickedMoves,
    reversePlan,
    putBack,
    outstandingOf,
    outstandingText,
    backorder,
    loadOf,
    loadOutstanding,
    pickFaceReplenishment
})
