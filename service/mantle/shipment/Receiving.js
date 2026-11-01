// The receipt steps of the Warehouse posting guard (impl-warehouse P7, design-warehouse §4 Receive; WH-POST): what the
// receipt entry points of mantle.shipment.WarehouseTaskServices (ensure#PurchaseReceipt, adjust#ExpectedReceipt,
// receive#ShipmentStock, receive#ExpectedShipment, receive#AdHocStock, close#ReceiptRemainder,
// generate#TrackingIdentities) add to StockPosting.js's steps: the purchase part and its one open receipt, the receipt
// locked and scoped (its facility is its route segment's destination, F55), the line's product, unit and pack, the
// tracking policy's lot and serial rules, the over-receipt tolerance and the receipt steps of the operation policy read at
// posting (resolve#WarehousePolicy, F101), the Mantle primitives (receive#ShipmentProduct, receive#Asset), the entered
// quantity fields (F7), and the receipt exception notice. One lock order: the shipment, then its sources by id, then the
// order parts and the order header (in Mantle's own order: complete#OrderPart updates the part, then the header), then the
// destination location; ensure#PurchaseReceipt, which has no shipment yet, starts at the part (P7 review B1). Each refusal
// is denied(reason, message).
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const posting = ec.resource.script("component://mr-mantle/service/mantle/shipment/StockPosting.js")
const purchase = ec.resource.script("component://mr-mantle/service/mantle/order/PurchaseRemainders.js")
const facilityScope = ec.resource.script("component://mr-mantle/service/mantle/facility/FacilityScope.js")
const {find, one, rows, call, denied} = lib

const SHIPMENT = "mantle.shipment.Shipment",
    SOURCE = "mantle.shipment.ShipmentItemSource",
    RECEIPT = "mantle.product.receipt.AssetReceipt",
    PRODUCT = "mantle.product.Product"
// the shipments a purchase receipt is open in: one per part (ensure#PurchaseReceipt), still received into
const openReceiptStatuses = ["ShipInput", "ShipScheduled"]
const receivingStatuses = ["ShipInput", "ShipScheduled", "ShipShipped"]
const stockProductTypes = ["PtAsset", "PtPickAssembly"]
const zero = () => toDecimal(0)
const dec = value => toDecimal(value ?? 0)
const blank = value => value == null || String(value).trim() === ""
const text = value => (dec(value).compare(0) === 0 ? "0" : String(dec(value).toNumber()))

// ===== the purchase part and its open receipt =====
// The order part, locked: a purchase (its customer an internal organization of the user's scope), approved or sent.
function purchasePart(userScope, orderId, orderPartSeqId) {
    const part = find("mantle.order.OrderPart", {orderId, orderPartSeqId}).forUpdate(true).one()
    if (!part) denied("RECORD_UNAVAILABLE", "Order part " + orderId + ":" + orderPartSeqId + " is not available")
    if (!one("mantle.party.PartyRole", {partyId: part.customerPartyId, roleTypeId: "OrgInternal"}))
        denied("NOT_PURCHASE", "Order " + orderId + " is not a purchase order")
    if (!facilityScope.owns(userScope, part.customerPartyId))
        denied("RECORD_UNAVAILABLE", "Order part " + orderId + ":" + orderPartSeqId + " is not available")
    const header = one("mantle.order.OrderHeader", {orderId})
    if (!["OrderApproved", "OrderSent"].includes(part.statusId) && !["OrderApproved", "OrderSent"].includes(header?.statusId))
        denied("ORDER_NOT_OPEN", "Order " + orderId + " is not approved, or is already complete")
    return part
}
// The open purchase receipt of a part (a ShpTpPurchase shipment in Input or Scheduled holding a source of one of its
// lines), other than excludeShipmentId; the oldest when there are several.
function openReceipt(orderId, orderPartSeqId, excludeShipmentId) {
    const itemIds = rows("mantle.order.OrderItem", {orderId, orderPartSeqId}).map(item => item.orderItemSeqId)
    if (!itemIds.length) return null
    const shipmentIds = [
        ...new Set(
            Array.from(find(SOURCE, {orderId}).condition("orderItemSeqId", "in", itemIds).list())
                .filter(source => source.statusId !== "SisCancelled")
                .map(source => source.shipmentId)
        )
    ].filter(id => id !== excludeShipmentId)
    if (!shipmentIds.length) return null
    const open = Array.from(
        find(SHIPMENT)
            .condition("shipmentId", "in", shipmentIds)
            .condition("shipmentTypeEnumId", "ShpTpPurchase")
            .condition("statusId", "in", openReceiptStatuses)
            .orderBy("shipmentId")
            .list()
    )
    return open.length ? open[0].shipmentId : null
}
// ===== the receipt, locked and scoped =====
// The purchase receipt, locked, still being received, at its route segment's destination facility (F55), a facility of
// the user's organizations.
function receipt(userScope, shipmentId, statuses = receivingStatuses) {
    const shipment = blank(shipmentId) ? null : find(SHIPMENT, {shipmentId}).forUpdate(true).one()
    if (!shipment) denied("RECORD_UNAVAILABLE", "Receipt " + (shipmentId || "") + " is not available")
    const segments = rows("mantle.shipment.ShipmentRouteSegment", {shipmentId}).sort((a, b) =>
        String(b.shipmentRouteSegmentSeqId).localeCompare(String(a.shipmentRouteSegmentSeqId))
    )
    const facilityId = segments.find(segment => segment.destinationFacilityId)?.destinationFacilityId
    const home = facilityId ? one("mantle.facility.Facility", {facilityId}) : null
    if (!home || !facilityScope.owns(userScope, home.ownerPartyId))
        denied("RECORD_UNAVAILABLE", "Receipt " + shipmentId + " is not available")
    if (shipment.shipmentTypeEnumId !== "ShpTpPurchase")
        denied(
            "RECEIPT_TYPE",
            "Shipment " + shipmentId + " is not a purchase receipt: a return is received on its return, a transfer on Transfers"
        )
    if (!statuses.includes(shipment.statusId))
        denied("RECEIPT_CLOSED", "Receipt " + shipmentId + " is " + shipment.statusId + " and takes no more receipts")
    return {shipment, facility: home, shipmentId, facilityId: home.facilityId}
}
// What was received on each source, accepted and rejected, in stock units.
function receivedOn(shipmentItemSourceId) {
    let accepted = zero(),
        rejected = zero()
    for (const row of rows(RECEIPT, {shipmentItemSourceId})) {
        accepted = accepted.add(dec(row.quantityAccepted))
        rejected = rejected.add(dec(row.quantityRejected))
    }
    return {accepted, rejected, total: accepted.add(rejected)}
}
// A product's sources on the receipt, locked by id, each with what it expects and what was received.
function sourcesOf(shipmentId, productId, lock = true) {
    return Array.from(find(SOURCE, {shipmentId, productId}).orderBy("shipmentItemSourceId").forUpdate(lock).list())
        .filter(source => source.statusId !== "SisCancelled")
        .map(source => {
            const received = receivedOn(source.shipmentItemSourceId)
            const expected = dec(source.quantity)
            const remaining = expected.subtract(received.total)
            return {source, expected, received, remaining: remaining.compare(0) > 0 ? remaining : zero()}
        })
}
// The line received: the product on the receipt, or a pack of it (resolve#ScannedProduct's packaging converts the packs
// to the product's stock unit), its sources locked.
function line(recv, productId) {
    const product = blank(productId) ? null : one(PRODUCT, {productId})
    if (!product) denied("PRODUCT_REQUIRED", "Choose a product of the receipt")
    let sources = sourcesOf(recv.shipmentId, productId)
    if (sources.length) return {product, sources, packProductId: null, packFactor: toDecimal(1)}
    let scanned = null
    try {
        scanned = lib.probe("mantle.product.ProductServices.resolve#ScannedProduct", {scanId: productId})
    } catch (error) {
        ec.logger.warn("Receipt " + recv.shipmentId + ": product " + productId + " did not resolve: " + error.message)
    }
    if (scanned?.found && scanned.packProductId && scanned.productId && scanned.productId !== productId) {
        sources = sourcesOf(recv.shipmentId, scanned.productId)
        if (sources.length)
            return {
                product: one(PRODUCT, {productId: scanned.productId}),
                sources,
                packProductId: productId,
                packFactor: dec(scanned.appliedConversionFactor || scanned.containedQuantity || 1)
            }
    }
    denied("PRODUCT_NOT_ON_RECEIPT", "Product " + productId + " is not on receipt " + recv.shipmentId)
}

// ===== quantities, units and tracking =====
// The stock quantity of an entered quantity: a pack's contents, or the entered unit converted to the product's stock unit
// (the order line's unit by default).
function stockQuantity(entered, enteredUomId, product, packFactor) {
    const value = dec(entered)
    if (value.compare(0) < 0) denied("QUANTITY_INVALID", "A quantity is not negative")
    if (packFactor && packFactor.compare(1) !== 0) return {quantity: value.multiply(packFactor), factor: packFactor}
    if (!enteredUomId || !product.amountUomId || enteredUomId === product.amountUomId)
        return {quantity: value, factor: toDecimal(1)}
    const factor = call("org.moqui.impl.BasicServices.convert#Uom", {
        uomId: enteredUomId,
        toUomId: product.amountUomId,
        amount: 1
    }).convertedAmount
    if (factor == null || dec(factor).compare(0) <= 0)
        denied("UNIT_CONVERSION", "No conversion from " + enteredUomId + " to " + product.amountUomId)
    return {quantity: value.multiply(dec(factor)), factor: dec(factor)}
}
// The entered unit by default: the line's order unit when its sources name an order line, else the stock unit.
function defaultUnit(sources, product) {
    for (const {source} of sources || []) {
        if (!source.orderId) continue
        const item = one("mantle.order.OrderItem", {orderId: source.orderId, orderItemSeqId: source.orderItemSeqId})
        if (item?.quantityUomId) return item.quantityUomId
    }
    return product.amountUomId || null
}
// The policy at posting: tracking and operation (receipt steps, locations, over-receipt) of the facility and product.
function policyOf(facilityId, productId) {
    const resolved = call("mantle.facility.WarehousePolicyServices.resolve#WarehousePolicy", {facilityId, productId})
    return {tracking: resolved.trackingPolicy || {}, operation: resolved.operationPolicy || {}}
}
// The serial numbers given: trimmed, one per unit, unique among themselves and among the product's stock.
function serialsOf(value) {
    const list = Array.isArray(value)
        ? value
        : value == null
          ? []
          : typeof value === "string"
            ? value.split(/[\r\n,]+/)
            : Array.from(value)
    return list.map(serial => String(serial).trim()).filter(Boolean)
}
// The serials of the product's stock on hand (a unit shipped out and come back is not a duplicate).
function serialsInStock(productId, serials) {
    return Array.from(
        find("mantle.product.asset.Asset", {productId})
            .condition("serialNumber", "in", serials)
            .condition("quantityOnHandTotal", "greater", 0)
            .selectField("serialNumber")
            .list()
    ).map(row => row.serialNumber)
}
// The tracking checks before anything posts: a serial-tracked product (or any given serials) needs one unique serial per
// accepted unit (SERIAL_COUNT_MISMATCH, SERIAL_DUPLICATE); a lot-tracked one a lot for what is accepted (LOT_REQUIRED). A
// lot with no expiry takes the shelf life from the receipt date. Answers the serials and the expiry.
function tracking(policy, product, accepted, p) {
    const serials = serialsOf(p.serialNumbers)
    const serialized = policy.serialRequired === "Y" || serials.length > 0
    if (serialized) {
        if (!accepted.isZero() && accepted.compare(Math.floor(accepted.toNumber())) !== 0)
            denied("SERIAL_COUNT_MISMATCH", "Serial-tracked stock is received in whole units")
        if (serials.length !== accepted.toNumber())
            denied(
                "SERIAL_COUNT_MISMATCH",
                serials.length + " serial numbers for " + text(accepted) + " accepted units of " + product.productId
            )
        const repeated = serials.filter((serial, index) => serials.indexOf(serial) !== index)
        if (repeated.length) denied("SERIAL_DUPLICATE", "Serial numbers given twice: " + [...new Set(repeated)].join(", "))
        const existing = serials.length ? serialsInStock(product.productId, serials) : []
        if (existing.length) denied("SERIAL_DUPLICATE", "Serial numbers already in stock: " + existing.join(", "))
    }
    if (policy.lotRequired === "Y" && !accepted.isZero() && blank(p.lotNumber) && blank(p.lotId))
        denied("LOT_REQUIRED", "Product " + product.productId + " is lot-tracked; give the lot")
    let expirationDate = p.expirationDate || null
    if (!expirationDate && !blank(p.lotNumber) && Number(policy.shelfLifeDays) > 0) {
        const lot = one("mantle.product.asset.Lot", {lotNumber: p.lotNumber, mfgPartyId: p.mfgPartyId || null})
        if (!lot?.expirationDate)
            expirationDate = new Date(Number(ec.user.nowTimestamp) + Number(policy.shelfLifeDays) * 86400000)
    }
    const warnings = []
    if (expirationDate && Number(new Date(expirationDate)) < Number(ec.user.nowTimestamp))
        warnings.push({code: "EXPIRED", message: "The lot expired on " + lib.calendarDateText(expirationDate)})
    return {serials, serialized, expirationDate, warnings}
}
// The over-receipt tolerance of the operation policy (default zero): what the product's sources expect, plus the
// percentage, is the most received on them, accepted and rejected (OVER_RECEIPT).
function checkOverReceipt(shipmentId, sources, quantity, operation, productId) {
    const expected = sources.reduce((sum, row) => sum.add(row.expected), zero())
    // every receipt of the product on the shipment, those beyond its sources (receive#ShipmentProduct's excess) too
    const handled = rows(RECEIPT, {shipmentId, productId}).reduce(
        (sum, row) => sum.add(dec(row.quantityAccepted)).add(dec(row.quantityRejected)),
        zero()
    )
    const percent = dec(operation.overReceiptPercent)
    const limit = expected.add(expected.multiply(percent).divide(100, 6, "HALF_UP"))
    if (handled.add(quantity).compare(limit) > 0)
        denied(
            "OVER_RECEIPT",
            `${text(handled.add(quantity))} of ${productId} would be received against ${text(expected)} expected` +
                (percent.isZero() ? "" : ` (${text(percent)}% over allowed)`)
        )
    return {expected, handled}
}

// ===== the receipt steps (P3's operation policy, F101) =====
// The step-1 destination (P9): the putaway resolver's for the incoming quantity (the product's default location, then the
// putaway rules, each checked for capacity, storage type, owner and status), with its explanation or why none fits.
// The owner is the receipt's (the facility owner when none). Once the location is locked, fits() checks it again: a receipt
// at the same time may have filled it, and the stock then goes to the receiving location with that reason (P9 review C1).
function putawayLocation(userScope, facilityId, productId, quantity, ownerPartyId) {
    const putaway = ec.resource.script("component://mr-mantle/service/mantle/facility/Putaway.js")
    const resolved = putaway.forReceipt(userScope, facilityId, productId, quantity, ownerPartyId)
    const fits = () =>
        resolved.locationSeqId ? putaway.fits({stock: resolved.stock, resolved, locationSeqId: resolved.locationSeqId}) : null
    return {
        locationSeqId: resolved.locationSeqId || null,
        explanation: resolved.explanation || resolved.reasonText || null,
        fits
    }
}
// Where the receipt posts: step 1 to the putaway destination (or the receiver's choice; with none that fits, the receiving
// location, the reason named), step 2 to the receiving location, step 3 to quarantine (the receiver may choose another
// quarantine location; the inspection comes with quality, P8). The location is open and locked (check#FacilityLocationOpen
// through posting.destination).
function destination(userScope, facilityId, productId, operation, requested, quantity, ownerPartyId) {
    const steps = [1, 2, 3].includes(Number(operation.receiptSteps)) ? Number(operation.receiptSteps) : 1
    let locationSeqId = null,
        putaway = null
    if (steps === 3) {
        const chosen = blank(requested) ? null : one("mantle.facility.FacilityLocation", {facilityId, locationSeqId: requested})
        locationSeqId = chosen?.locationTypeEnumId === "FltQuarantine" ? chosen.locationSeqId : operation.quarantineLocationSeqId
        if (!locationSeqId) denied("LOCATION_REQUIRED", "Receipt into quarantine needs a quarantine location at the facility")
    } else if (steps === 2) {
        // a receiving location: the receiver's, if it is one, else the policy's (P7 review C4)
        const chosen = blank(requested) ? null : one("mantle.facility.FacilityLocation", {facilityId, locationSeqId: requested})
        locationSeqId = chosen?.locationTypeEnumId === "FltReceiving" ? chosen.locationSeqId : operation.receivingLocationSeqId
        if (!locationSeqId) denied("LOCATION_REQUIRED", "Two-step receipt needs a receiving location at the facility")
    } else if (blank(requested)) {
        putaway = putawayLocation(userScope, facilityId, productId, quantity, ownerPartyId)
        locationSeqId = putaway.locationSeqId || operation.receivingLocationSeqId || null
    } else locationSeqId = requested
    const fits = putaway?.fits
    if (putaway) delete putaway.fits
    if (!locationSeqId) return {receiptSteps: steps, locationSeqId: null, statusId: null, putaway}
    let target = posting.destination(userScope, facilityId, {toLocationSeqId: locationSeqId})
    // the bin locked (location last in the lock order; the receiving location after it): still fits, else receiving
    const again = putaway?.locationSeqId ? fits() : null
    if (again && !again.ok && operation.receivingLocationSeqId) {
        putaway.explanation = again.explanation + "; received at " + operation.receivingLocationSeqId + " instead"
        target = posting.destination(userScope, facilityId, {toLocationSeqId: operation.receivingLocationSeqId})
    }
    return {
        receiptSteps: steps,
        locationSeqId: target.locationSeqId,
        statusId: steps === 3 ? "AstQuarantine" : target.autoStatusId || null,
        putaway
    }
}

// ===== the postings and their dependent writes =====
// A rejection with nothing accepted: receive#Asset receives nothing for a zero quantity, so the dock rejection is written
// as the receipt itself (no stock), on the product's sources in order, each source's not-handled quantity lowered.
function rejectOnly(recv, sources, quantity, rejectionReasonEnumId) {
    let left = dec(quantity)
    const ids = []
    for (const row of sources) {
        if (left.compare(0) <= 0) break
        const take = row.remaining.compare(left) > 0 ? left : row.remaining
        if (take.compare(0) <= 0) continue
        ids.push(writeRejection(recv, row.source, take, rejectionReasonEnumId))
        const notHandled = dec(row.source.quantityNotHandled).subtract(take)
        call("update#" + SOURCE, {
            shipmentItemSourceId: row.source.shipmentItemSourceId,
            quantityNotHandled: notHandled.compare(0) > 0 ? notHandled : zero(),
            statusId: notHandled.compare(0) > 0 ? row.source.statusId : "SisReceived"
        })
        left = left.subtract(take)
    }
    if (left.compare(0) > 0)
        ids.push(writeRejection(recv, {productId: sources[0]?.source.productId}, left, rejectionReasonEnumId))
    return ids
}
function writeRejection(recv, source, quantity, rejectionReasonEnumId) {
    return call("create#" + RECEIPT, {
        productId: source.productId,
        shipmentId: recv.shipmentId,
        shipmentItemSourceId: source.shipmentItemSourceId || null,
        orderId: source.orderId || null,
        orderItemSeqId: source.orderItemSeqId || null,
        receivedByUserId: ec.user.userId,
        receivedDate: ec.user.nowTimestamp,
        quantityAccepted: zero(),
        quantityRejected: quantity,
        rejectionReasonEnumId: rejectionReasonEnumId || null
    }).assetReceiptId
}
// receive#ShipmentProduct for the line: one call for untracked or lot stock (accepted with the rejected), one per serial
// for serialized stock; a rejection with nothing accepted, or beside serials, through rejectOnly. Answers the assets and
// receipts written.
function postLine(recv, ln, plan, p) {
    const before = new Set(
        rows(RECEIPT, {shipmentId: recv.shipmentId, productId: ln.product.productId}).map(r => r.assetReceiptId)
    )
    const common = {
        shipmentId: recv.shipmentId,
        productId: ln.product.productId,
        facilityId: recv.facilityId,
        locationSeqId: plan.target.locationSeqId,
        statusId: plan.target.statusId,
        lotId: p.lotId || null,
        lotNumber: blank(p.lotNumber) ? null : String(p.lotNumber).trim(),
        expirationDate: plan.track.expirationDate,
        mfgPartyId: p.mfgPartyId || null
    }
    const assetIds = []
    let rejectedLeft = plan.rejected
    if (plan.track.serialized) {
        for (const serialNumber of plan.track.serials) {
            const out = call(
                "mantle.shipment.ShipmentServices.receive#ShipmentProduct",
                Object.assign({}, common, {serialNumber, quantityAccepted: 1, quantityRejected: 0})
            )
            assetIds.push(...Array.from(out.assetIdList || []))
        }
    } else if (!plan.accepted.isZero()) {
        const out = call(
            "mantle.shipment.ShipmentServices.receive#ShipmentProduct",
            Object.assign({}, common, {
                quantityAccepted: plan.accepted,
                quantityRejected: plan.rejected,
                rejectionReasonEnumId: p.rejectionReasonEnumId || null
            })
        )
        assetIds.push(...Array.from(out.assetIdList || []))
        rejectedLeft = zero()
    }
    if (rejectedLeft.compare(0) > 0)
        rejectOnly(recv, sourcesOf(recv.shipmentId, ln.product.productId), rejectedLeft, p.rejectionReasonEnumId)
    const written = rows(RECEIPT, {shipmentId: recv.shipmentId, productId: ln.product.productId}).filter(
        row => !before.has(row.assetReceiptId)
    )
    stamp(written, plan.unit)
    return {assetIds: assetIds.filter(Boolean), assetReceiptIds: written.map(row => row.assetReceiptId)}
}
// The entered quantity fields (F7) on each receipt written: its quantity in the entered unit, the unit and the factor
// applied (a pack has no unit of its own: its factor is the pack's contents).
function stamp(receipts, unit) {
    for (const row of receipts) {
        const stockQuantity = dec(row.quantityAccepted).add(dec(row.quantityRejected))
        call("update#" + RECEIPT, {
            assetReceiptId: row.assetReceiptId,
            enteredQuantity: stockQuantity.divide(unit.factor, 6, "HALF_UP"),
            enteredQuantityUomId: unit.enteredUomId || null,
            appliedConversionFactor: unit.factor,
            itemDescription: unit.itemDescription || row.itemDescription || null
        })
    }
}
// The receipt exception notice (design-warehouse §1 notifications): rejected units, or a remainder closed or backordered,
// to the facility owner's warehouse managers (STOCK_POLICY_MANAGE). A notice that fails is logged; the receipt stands.
function notifyException(recv, kind, detail) {
    try {
        ec.resource.script("component://mr-mantle/service/mantle/account/Payables.js").execute("notify", {
            topic: "WarehouseReceiptException",
            permission: "STOCK_POLICY_MANAGE",
            organizationPartyId: recv.facility.ownerPartyId,
            recordEntityName: SHIPMENT,
            recordId: recv.shipmentId,
            message: Object.assign({shipmentId: recv.shipmentId, facilityId: recv.facilityId, kind}, detail)
        })
        return true
    } catch (error) {
        ec.logger.error("Receipt exception notice for " + recv.shipmentId + " failed: " + error.message)
        return false
    }
}

// ===== receive#AdHocStock's cost (P7 review C6) =====
// The unit cost of stock received with no order: the one given needs financial read (ACCOUNTING_VIEW; COST_NOT_PERMITTED),
// else the product's approved standard cost for the organization and facility, else its latest acquire cost there, else
// none (the receipt posts no value, as Mantle's receive#Asset without a cost).
function adHocCost(product, facility, ownerPartyId, given, givenUomId) {
    if (given != null && given !== "") {
        if (!lib.access.has("ACCOUNTING_VIEW")) denied("COST_NOT_PERMITTED", "Setting a cost needs financial read")
        return {acquireCost: dec(given), acquireCostUomId: givenUomId || null, costSource: "given"}
    }
    const costs = ec.resource.script("component://mr-mantle/service/mantle/product/Costs.js")
    const standard = costs.effective(product.productId, ownerPartyId, ec.user.nowTimestamp, facility.facilityId)
    if (standard?.unitCost != null)
        return {acquireCost: dec(standard.unitCost), acquireCostUomId: standard.priceUomId || null, costSource: "standard"}
    const last = Array.from(
        find("mantle.product.asset.Asset", {productId: product.productId, ownerPartyId})
            .condition("acquireCost", "is-not-null", null)
            .orderBy("-acquiredDate")
            .limit(1)
            .list()
    )[0]
    if (last) return {acquireCost: dec(last.acquireCost), acquireCostUomId: last.acquireCostUomId || null, costSource: "last"}
    return {acquireCost: null, acquireCostUomId: null, costSource: null}
}

// ===== receive#ShipmentStock's plan: everything checked before anything posts =====
function plan(userScope, recv, ln, p) {
    const unitId = blank(p.quantityUomId) ? (ln.packProductId ? null : defaultUnit(ln.sources, ln.product)) : p.quantityUomId
    const accepted = stockQuantity(p.quantityAccepted, unitId, ln.product, ln.packFactor)
    const rejected = stockQuantity(p.quantityRejected, unitId, ln.product, ln.packFactor)
    const total = accepted.quantity.add(rejected.quantity)
    if (total.compare(0) <= 0) denied("QUANTITY_INVALID", "Give the quantity accepted or rejected")
    if (rejected.quantity.compare(0) > 0 && blank(p.rejectionReasonEnumId))
        denied("REASON_REQUIRED", "Give the reason units are rejected")
    const policy = policyOf(recv.facilityId, ln.product.productId)
    const track = tracking(policy.tracking, ln.product, accepted.quantity, p)
    const over = checkOverReceipt(recv.shipmentId, ln.sources, total, policy.operation, ln.product.productId)
    // P8: when the operation policy's step 3, the tracking policy or a published receipt template asks for inspection, the
    // accepted stock goes to quarantine (step 3's destination) and the receipt creates its inspection (receive#ShipmentStock)
    const inspect = ec.resource
        .script("component://mr-mantle/service/mantle/product/Quality.js")
        .receiptNeedsInspection(recv.facility, ln.product.productId, policy)
    const operation = inspect ? Object.assign({}, policy.operation, {receiptSteps: 3}) : policy.operation
    const productId = ln.product.productId
    const target = destination(userScope, recv.facilityId, productId, operation, p.locationSeqId, accepted.quantity)
    return {
        inspect,
        accepted: accepted.quantity,
        rejected: rejected.quantity,
        total,
        unit: {enteredUomId: ln.packProductId ? null : unitId, factor: accepted.factor},
        track,
        target,
        expected: over.expected,
        remainingAfter: over.expected.subtract(over.handled).subtract(total)
    }
}
// The answer of a line receipt.
function lineAnswer(recv, ln, pl, posted, p) {
    const remaining = pl.remainingAfter.compare(0) > 0 ? pl.remainingAfter : zero()
    return {
        resultCode: "RECEIVED",
        shipmentId: recv.shipmentId,
        facilityId: recv.facilityId,
        productId: ln.product.productId,
        packProductId: ln.packProductId,
        quantityAccepted: text(pl.accepted),
        quantityRejected: text(pl.rejected),
        enteredQuantityAccepted: blank(p.quantityAccepted) ? "0" : text(p.quantityAccepted),
        enteredQuantityRejected: blank(p.quantityRejected) ? "0" : text(p.quantityRejected),
        enteredQuantityUomId: pl.unit.enteredUomId,
        appliedConversionFactor: text(pl.unit.factor),
        rejectionReasonEnumId: pl.rejected.isZero() ? null : p.rejectionReasonEnumId,
        receiptSteps: pl.target.receiptSteps,
        locationSeqId: pl.target.locationSeqId,
        statusId: pl.target.statusId,
        putawayExplanation: pl.target.putaway?.explanation || null,
        lotNumber: blank(p.lotNumber) ? null : String(p.lotNumber).trim(),
        serialNumbers: pl.track.serials,
        assetIds: posted.assetIds,
        assetReceiptIds: posted.assetReceiptIds,
        remainingQuantity: text(remaining),
        warnings: pl.track.warnings
    }
}

// ===== close#ReceiptRemainder =====
// Each product line's remainder on the receipt: what its sources expect less what was received.
function remainders(shipmentId) {
    const lines = new Map()
    for (const source of rows(SOURCE, {shipmentId})) {
        if (source.statusId === "SisCancelled") continue
        const received = receivedOn(source.shipmentItemSourceId)
        const left = dec(source.quantity).subtract(received.total)
        const key = source.productId
        const lineRow = lines.get(key) || {productId: key, expected: zero(), received: zero(), remaining: zero(), sources: []}
        lineRow.expected = lineRow.expected.add(dec(source.quantity))
        lineRow.received = lineRow.received.add(received.total)
        lineRow.remaining = lineRow.remaining.add(left.compare(0) > 0 ? left : zero())
        lineRow.sources.push(source)
        lines.set(key, lineRow)
    }
    return [...lines.values()]
}
// Close: Purchasing's close of the remainders of each order on the receipt (PurchaseRemainders.js), in this operation.
function closeRemainders(userScope, recv, open, reason) {
    const byOrder = new Map()
    for (const lineRow of open)
        for (const source of lineRow.sources)
            if (source.orderId) byOrder.set(source.orderId, (byOrder.get(source.orderId) || new Set()).add(source.orderItemSeqId))
    return [...byOrder.entries()].map(([orderId, itemIds]) =>
        purchase.remainders({
            orderId,
            orderItemSeqIds: [...itemIds],
            reason,
            shipmentId: recv.shipmentId,
            onShipment: true,
            userScope
        })
    )
}
// Backorder: this receipt keeps what was received (update#ShipmentItem), and each order part's remainder goes to its
// open receipt (ensure#PurchaseReceipt, a new one since this one is being delivered).
function backorderRemainders(recv, open, operationKey) {
    // a receipt that received nothing is cancelled rather than delivered empty (P7 review C2)
    const receivedAny = find(RECEIPT, {shipmentId: recv.shipmentId}).count() > 0
    for (const lineRow of open)
        call("mantle.shipment.ShipmentServices.update#ShipmentItem", {
            shipmentId: recv.shipmentId,
            productId: lineRow.productId,
            quantity: lineRow.received
        })
    if (!receivedAny) call("mantle.shipment.ShipmentServices.cancel#Shipment", {shipmentId: recv.shipmentId})
    const parts = new Map()
    for (const lineRow of open)
        for (const source of lineRow.sources) {
            if (!source.orderId) continue
            const item = one("mantle.order.OrderItem", {orderId: source.orderId, orderItemSeqId: source.orderItemSeqId})
            if (item) parts.set(item.orderId + ":" + item.orderPartSeqId, item)
        }
    return [...parts.values()].map(item => {
        const ensured = call("mantle.shipment.WarehouseTaskServices.ensure#PurchaseReceipt", {
            operationKey: operationKey + "/backorder/" + item.orderId + "/" + item.orderPartSeqId,
            orderId: item.orderId,
            orderPartSeqId: item.orderPartSeqId,
            facilityId: recv.facilityId,
            excludeShipmentId: recv.shipmentId
        }).result
        return {orderId: item.orderId, orderPartSeqId: item.orderPartSeqId, shipmentId: ensured.shipmentId}
    })
}

// ===== generate#TrackingIdentities =====
// The next value after a first one: its trailing number counted up with its width kept ("SN-0099" → "SN-0100").
function nextValues(first, count) {
    const match = /^(.*?)(\d+)(\D*)$/.exec(first)
    if (!match) denied("FIRST_VALUE_INVALID", "A first value ends in a number to count up from")
    const [, head, digits, tail] = match
    const start = BigInt(digits)
    return Array.from({length: count}, (_, index) => head + String(start + BigInt(index)).padStart(digits.length, "0") + tail)
}
// A pattern's values: {seq:N} is the sequence in N digits from start, {yyyy}, {yy}, {MM}, {dd} the day in the user's zone,
// {product} the product id.
// A pattern with its day and product tokens filled, the {seq} left: the text before the sequence, and a regular
// expression whose group is the sequence of a value made from it.
function patternParts(pattern, productId) {
    if (!/\{seq(?::\d+)?\}/.test(pattern)) denied("PATTERN_INVALID", "A tracking pattern needs {seq} or {seq:N}")
    const now = ec.user.nowTimestamp
    const day = {
        yyyy: ec.l10n.format(now, "yyyy"),
        yy: ec.l10n.format(now, "yy"),
        MM: ec.l10n.format(now, "MM"),
        dd: ec.l10n.format(now, "dd")
    }
    const filled = pattern.replace(/\{(yyyy|yy|MM|dd)\}/g, (_, token) => day[token]).replace(/\{product\}/g, productId)
    const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    const pieces = filled.split(/\{seq(?::\d+)?\}/)
    return {
        filled,
        prefix: pieces[0],
        matcher: new RegExp("^" + pieces.map(escape).join("(\\d+)") + "$")
    }
}
function patternValues(parts, start, count) {
    return Array.from({length: count}, (_, index) =>
        parts.filled.replace(/\{seq(?::(\d+))?\}/g, (_, width) => String(start + index).padStart(Number(width || 0), "0"))
    )
}
// The sequence after the highest value already made from the pattern: of the product's serials, or of the lots (the
// manufacturer's when given), so generating again goes on rather than starting at 1 (P7 review B3).
function nextSequence(parts, kind, productId, mfgPartyId) {
    const like = parts.prefix.replace(/[\\%_]/g, c => "\\" + c) + "%"
    const field = kind === "serial" ? "serialNumber" : "lotNumber"
    let query =
        kind === "serial"
            ? find("mantle.product.asset.Asset", {productId})
            : mfgPartyId
              ? find("mantle.product.asset.Lot", {mfgPartyId})
              : find("mantle.product.asset.Lot")
    query = query
        .condition(field, "like", parts.prefix ? like : "%")
        .selectField(field)
        .orderBy("-" + field)
        .limit(5000)
    let highest = 0
    for (const row of Array.from(query.list())) {
        const match = parts.matcher.exec(String(row[field] || ""))
        if (match) highest = Math.max(highest, Number(match[1]))
    }
    return highest + 1
}
// Values from the policy's pattern: from startNumber when given, else after the highest made from it already.
function patternFrom(pattern, kind, productId, p, count) {
    const parts = patternParts(pattern, productId)
    const start = Number(p.startNumber) > 0 ? Number(p.startNumber) : nextSequence(parts, kind, productId, p.mfgPartyId)
    return patternValues(parts, start, count)
}
// Serial or lot values for many units, with each one's uniqueness: a serial on the product's stock on hand, a lot number
// already used (by the manufacturer, when given), or a value given twice is a duplicate. Writes nothing.
function generate(p) {
    posting.requirePermission(["STOCK_RECEIVE", "STOCK_ISSUE"])
    const userScope = posting.scope()
    const kind = p.trackingKind === "lot" ? "lot" : "serial"
    const count = Number(p.count)
    if (!Number.isInteger(count) || count < 1 || count > 1000) denied("COUNT_INVALID", "Generate from 1 to 1000 values")
    const product = blank(p.productId) ? null : one(PRODUCT, {productId: p.productId})
    if (!product) denied("PRODUCT_REQUIRED", "Choose the product")
    let pattern = null
    if (!blank(p.facilityId)) {
        posting.facility(userScope, p.facilityId)
        const policy = policyOf(p.facilityId, product.productId).tracking
        pattern = kind === "lot" ? policy.lotPattern : policy.serialPattern
    }
    if (!blank(p.pattern)) pattern = String(p.pattern)
    const values = !blank(p.firstValue)
        ? nextValues(String(p.firstValue).trim(), count)
        : pattern
          ? patternFrom(pattern, kind, product.productId, p, count)
          : denied("FIRST_VALUE_REQUIRED", "Give a first value, or set a tracking pattern for the product")
    const taken = new Set(
        kind === "serial"
            ? serialsInStock(product.productId, values)
            : Array.from(
                  (p.mfgPartyId ? find("mantle.product.asset.Lot", {mfgPartyId: p.mfgPartyId}) : find("mantle.product.asset.Lot"))
                      .condition("lotNumber", "in", values)
                      .selectField("lotNumber")
                      .list()
              ).map(row => row.lotNumber)
    )
    const seen = new Set()
    const identityRows = values.map(value => {
        const reason = taken.has(value) ? (kind === "serial" ? "IN_STOCK" : "LOT_EXISTS") : seen.has(value) ? "REPEATED" : null
        seen.add(value)
        return {value, duplicate: !!reason, reason}
    })
    return {
        trackingKind: kind,
        pattern: blank(p.firstValue) ? pattern : null,
        identityRows,
        duplicateCount: identityRows.filter(row => row.duplicate).length
    }
}

;({
    purchasePart,
    openReceipt,
    receipt,
    sourcesOf,
    line,
    plan,
    postLine,
    lineAnswer,
    stockQuantity,
    adHocCost,
    policyOf,
    tracking,
    destination,
    stamp,
    notifyException,
    remainders,
    closeRemainders,
    backorderRemainders,
    generate,
    stockProductTypes,
    text
})
