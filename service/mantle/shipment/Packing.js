// The Warehouse pack entry points' rules (impl-warehouse P12, design-warehouse §10 Pack, §17 WH-POST):
// mantle.shipment.WarehouseTaskServices pack#ShipmentStock, pack#ShipmentAssembly, edit#ShipmentPackage, complete#Pack and
// reopen#ShipmentPackage take StockPosting.js's steps in their XML; this module holds what they share: the outgoing shipment
// (Picking.js shipmentOf: its first route segment's origin in the user's organizations), whether it can still be packed, its
// packages and their contents, what a line has picked, packed and left, the reconciliation Complete pack checks, and the plan
// of a reopen (each product's quantity in the package taken back off the shipment's issuances, newest first).
//
// A package's contents are per product (ShipmentPackageContent has no source line), and an issuance names no package, so a
// reopen unpacks the package's quantity of each product from the shipment's issuances of that product, newest first.
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const picking = ec.resource.script("component://mr-mantle/service/mantle/shipment/Picking.js")
const posting = ec.resource.script("component://mr-mantle/service/mantle/shipment/StockPosting.js")
const {find, one, rows, denied, call} = lib

const SOURCE = "mantle.shipment.ShipmentItemSource",
    PACKAGE = "mantle.shipment.ShipmentPackage",
    CONTENT = "mantle.shipment.ShipmentPackageContent",
    ISSUANCE = "mantle.product.issuance.AssetIssuance",
    RESERVATION = "mantle.product.issuance.AssetReservation",
    BOX = "mantle.shipment.ShipmentBoxType"
const packable = ["ShipInput", "ShipScheduled", "ShipPicked"]
const shipped = ["ShipShipped", "ShipDelivered"]

const blank = value => value == null || String(value).trim() === ""
const number = picking.number
const text = picking.text

// ===== the shipment and its packages =====
function requirePackable(sh) {
    if (shipped.includes(sh.shipment.statusId))
        denied("SHIPMENT_SHIPPED", "Shipment " + sh.shipmentId + " has shipped; change it with a return")
    if (!packable.includes(sh.shipment.statusId))
        denied("PACK_CLOSED", "Shipment " + sh.shipmentId + " is " + sh.shipment.statusId + "; reopen a package to change it")
}
const packagesOf = shipmentId =>
    rows(PACKAGE, {shipmentId}).sort((a, b) => String(a.shipmentPackageSeqId).localeCompare(String(b.shipmentPackageSeqId)))
const contentsOf = (shipmentId, shipmentPackageSeqId) =>
    rows(CONTENT, shipmentPackageSeqId ? {shipmentId, shipmentPackageSeqId} : {shipmentId})
// A package of the shipment; a missing one is refused (PACKAGE_UNAVAILABLE).
function packageOf(sh, shipmentPackageSeqId) {
    const row = blank(shipmentPackageSeqId) ? null : one(PACKAGE, {shipmentId: sh.shipmentId, shipmentPackageSeqId})
    if (!row) denied("PACKAGE_UNAVAILABLE", "Package " + (shipmentPackageSeqId || "") + " is not on shipment " + sh.shipmentId)
    return row
}
// The package to pack into: the one given, else the newest, else a new one (the first box of the shipment).
function activePackage(sh, shipmentPackageSeqId) {
    if (!blank(shipmentPackageSeqId)) return packageOf(sh, shipmentPackageSeqId).shipmentPackageSeqId
    const existing = packagesOf(sh.shipmentId)
    if (existing.length) return existing[existing.length - 1].shipmentPackageSeqId
    return call("mantle.shipment.ShipmentServices.create#ShipmentPackage", {shipmentId: sh.shipmentId}).shipmentPackageSeqId
}
// A box type a package may take: one that exists and is not retired, and when the facility names its box types
// (FacilityBoxType), one of them (BOX_TYPE_UNAVAILABLE).
function boxTypeOf(sh, shipmentBoxTypeId) {
    if (blank(shipmentBoxTypeId)) return null
    const box = one(BOX, {shipmentBoxTypeId})
    const retired = box?.thruDate != null && lib.ms(box.thruDate) <= lib.ms(ec.user.nowTimestamp)
    const allowed = rows("mantle.facility.FacilityBoxType", {facilityId: sh.facilityId})
    if (!box || retired || (allowed.length && !allowed.some(row => row.shipmentBoxTypeId === shipmentBoxTypeId)))
        denied("BOX_TYPE_UNAVAILABLE", "Box type " + shipmentBoxTypeId + " is not used at facility " + sh.facilityId)
    return box
}

// ===== lines =====
// Each live line's quantity, picked, packed (its quantity less what is not handled) and left to pack.
function linesOf(sh) {
    return rows(SOURCE, {shipmentId: sh.shipmentId})
        .filter(row => row.statusId !== "SisCancelled" && number(row.quantity) > 0)
        .map(row => ({
            shipmentItemSourceId: row.shipmentItemSourceId,
            productId: row.productId,
            orderId: row.orderId || null,
            orderItemSeqId: row.orderItemSeqId || null,
            quantity: number(row.quantity),
            picked: number(row.quantityPicked),
            packed: Math.max(0, number(row.quantity) - number(row.quantityNotHandled)),
            left: number(row.quantityNotHandled)
        }))
}
// The quantity a pack takes from a line or a product: above zero, at most what is left to pack.
function quantityToPack(left, quantity, label) {
    const wanted = number(quantity)
    if (!(wanted > 0)) denied("QUANTITY_INVALID", "Give a quantity above zero")
    if (wanted > left) denied("QUANTITY_EXCEEDS_REMAINING", "Only " + text(left) + " of " + label + " is left to pack")
    return wanted
}
// Quarantined stock is not packed: the order item's reservations on held stock are refused (HELD_STOCK), since only an
// inspection's disposition releases it (F8).
function requireNotHeld(source) {
    if (!source?.orderId) return
    for (const reservation of rows(RESERVATION, {orderId: source.orderId, orderItemSeqId: source.orderItemSeqId}))
        if (number(reservation.quantityNotIssued) > 0) {
            const asset = one("mantle.product.asset.Asset", {assetId: reservation.assetId})
            if (posting.heldStatuses.includes(asset?.statusId))
                denied("HELD_STOCK", "Asset " + asset.assetId + " is " + asset.statusId + "; held stock is not packed")
        }
}
// What the shipment has issued so far, directly and into its assembly work effort: a scan that packed nothing changed neither.
function issuedTotal(sh) {
    const fresh = one("mantle.shipment.Shipment", {shipmentId: sh.shipmentId})
    const direct = rows(ISSUANCE, {shipmentId: sh.shipmentId}).reduce((sum, row) => sum + number(row.quantity), 0)
    const assembly = fresh?.assemblyWorkEffortId
        ? rows(ISSUANCE, {workEffortId: fresh.assemblyWorkEffortId}).reduce((sum, row) => sum + number(row.quantity), 0)
        : 0
    return direct + assembly
}

// ===== complete =====
// What Complete pack checks before complete#ShipmentPack: something packed (NOTHING_PACKED); every packed product in a
// package (UNPACKAGED, F17: the package contents are what the carrier ships); no empty package (EMPTY_PACKAGE) and a weight on
// each (WEIGHT_REQUIRED); stock picked and not packed put back first (PUT_BACK_FIRST); what is left unpacked acknowledged, since
// pack#Shipment lowers each line to what was packed (OUTSTANDING).
function completePlan(sh, p) {
    const lines = linesOf(sh)
    if (!lines.some(row => row.packed > 0)) denied("NOTHING_PACKED", "Nothing is packed on shipment " + sh.shipmentId)
    const packages = packagesOf(sh.shipmentId)
    const contents = contentsOf(sh.shipmentId)
    const empty = packages.filter(row => !contents.some(content => content.shipmentPackageSeqId === row.shipmentPackageSeqId))
    if (empty.length)
        denied(
            "EMPTY_PACKAGE",
            "Package " + empty.map(row => row.shipmentPackageSeqId).join(", ") + " is empty; remove it or pack it"
        )
    const unweighed = packages.filter(row => !(number(row.weight) > 0))
    if (unweighed.length)
        denied("WEIGHT_REQUIRED", "Weigh package " + unweighed.map(row => row.shipmentPackageSeqId).join(", ") + " first")
    const issuedByProduct = new Map()
    for (const row of rows(ISSUANCE, {shipmentId: sh.shipmentId}))
        issuedByProduct.set(row.productId, (issuedByProduct.get(row.productId) || 0) + number(row.quantity))
    const unpackaged = [...issuedByProduct.entries()]
        .map(([productId, issued]) => {
            const inBoxes = contents
                .filter(row => row.productId === productId)
                .reduce((sum, row) => sum + number(row.quantity), 0)
            return {productId, missing: issued - inBoxes}
        })
        .filter(row => row.missing > 0)
    if (unpackaged.length)
        denied("UNPACKAGED", "Not in a package: " + unpackaged.map(row => row.productId + " " + text(row.missing)).join(", "))
    const pickedLeft = lines.filter(row => row.picked > row.packed)
    if (pickedLeft.length)
        denied(
            "PUT_BACK_FIRST",
            "Picked and not packed: " +
                pickedLeft.map(row => row.productId + " " + text(row.picked - row.packed)).join(", ") +
                "; pack it or put it back"
        )
    const outstanding = lines.filter(row => row.left > 0)
    if (outstanding.length && !picking.truthy(p.acknowledged))
        denied(
            "OUTSTANDING",
            "Not packed: " +
                outstanding.map(row => row.productId + " " + text(row.left)).join(", ") +
                ". Completing the pack ships only what is packed"
        )
    return {lines, packages, outstanding}
}
// The shipment's sales invoices (OrderItemBilling) with their status only; amounts stay with Accounting.
function invoicesOf(shipmentId) {
    const ids = [...new Set(rows("mantle.order.OrderItemBilling", {shipmentId}).map(row => row.invoiceId))].sort()
    return ids.map(invoiceId => {
        const invoice = one("mantle.account.invoice.Invoice", {invoiceId})
        return {invoiceId, statusId: invoice?.statusId || null}
    })
}

// ===== reopen =====
// What a reopen takes off the shipment: the package's contents (or, given productId and quantity, that much of one
// product in it), each from the shipment's issuances of the product, newest first. Refuses a package with nothing in it
// (NOTHING_TO_REOPEN) and more than it holds (QUANTITY_EXCEEDS_PACKED).
function reopenPlan(sh, pkg, p) {
    let contents = contentsOf(sh.shipmentId, pkg.shipmentPackageSeqId).filter(row => number(row.quantity) > 0)
    if (!blank(p.productId)) contents = contents.filter(row => row.productId === p.productId)
    if (!contents.length) denied("NOTHING_TO_REOPEN", "Package " + pkg.shipmentPackageSeqId + " has nothing to take out")
    const takes = contents.map(content => {
        const held = number(content.quantity)
        const quantity = blank(p.quantity) || blank(p.productId) ? held : number(p.quantity)
        if (!(quantity > 0)) denied("QUANTITY_INVALID", "Give a quantity above zero")
        if (quantity > held)
            denied(
                "QUANTITY_EXCEEDS_PACKED",
                "Package " + pkg.shipmentPackageSeqId + " holds only " + text(held) + " of " + content.productId
            )
        const issuances = Array.from(
            find(ISSUANCE, {shipmentId: sh.shipmentId, productId: content.productId})
                .condition("quantity", "greater", 0)
                .orderBy("-assetIssuanceId")
                .list()
        )
        let left = quantity
        const parts = []
        for (const issuance of issuances) {
            if (left <= 0) break
            const take = Math.min(left, number(issuance.quantity))
            parts.push({assetIssuanceId: issuance.assetIssuanceId, assetId: issuance.assetId, quantity: take})
            left -= take
        }
        if (left > 0)
            denied(
                "QUANTITY_EXCEEDS_PACKED",
                "Only " + text(quantity - left) + " of " + content.productId + " is issued to the shipment"
            )
        return {productId: content.productId, held, quantity, parts}
    })
    return {takes}
}
// The orders of the stock a reopen takes back: pack#Shipment completed each order part it filled (checkComplete#OrderPart),
// and Mantle reserves nothing for a completed order, so a part (then its header) goes back to Approved by its status flow
// before the unpack, which then restores the reservation on the same asset (F281). Order part, then header (the one lock
// order); a later Complete pack completes them again.
function reopenOrders(plan) {
    const parts = new Map()
    for (const take of plan.takes)
        for (const part of take.parts) {
            const issuance = one(ISSUANCE, {assetIssuanceId: part.assetIssuanceId})
            const item = issuance?.orderId
                ? one("mantle.order.OrderItem", {orderId: issuance.orderId, orderItemSeqId: issuance.orderItemSeqId})
                : null
            if (item)
                parts.set(item.orderId + "|" + item.orderPartSeqId, {orderId: item.orderId, orderPartSeqId: item.orderPartSeqId})
        }
    const reopened = []
    for (const {orderId, orderPartSeqId} of [...parts.values()].sort((a, b) =>
        (a.orderId + a.orderPartSeqId).localeCompare(b.orderId + b.orderPartSeqId)
    )) {
        const part = find("mantle.order.OrderPart", {orderId, orderPartSeqId}).forUpdate(true).one()
        const header = find("mantle.order.OrderHeader", {orderId}).forUpdate(true).one()
        if (part?.statusId === "OrderCompleted") {
            call("update#mantle.order.OrderPart", {orderId, orderPartSeqId, statusId: "OrderApproved"})
            reopened.push(orderId + ":" + orderPartSeqId)
        }
        if (header?.statusId === "OrderCompleted") call("update#mantle.order.OrderHeader", {orderId, statusId: "OrderApproved"})
    }
    return reopened
}
// The unpack: each part through unpack#ShipmentItemIssuance (which cancels that much of the issuance, its reservation
// restored on the same asset, and gives the line its quantity back), then the package's content lowered.
function unpack(sh, pkg, plan) {
    reopenOrders(plan)
    const done = []
    for (const take of plan.takes) {
        for (const part of take.parts)
            call("mantle.shipment.ShipmentServices.unpack#ShipmentItemIssuance", {
                assetIssuanceId: part.assetIssuanceId,
                quantity: part.quantity
            })
        call("mantle.shipment.ShipmentServices.update#ShipmentPackageContent", {
            shipmentId: sh.shipmentId,
            shipmentPackageSeqId: pkg.shipmentPackageSeqId,
            productId: take.productId,
            quantity: take.held - take.quantity
        })
        done.push({
            productId: take.productId,
            quantity: text(take.quantity),
            assetIssuanceIds: take.parts.map(row => row.assetIssuanceId)
        })
    }
    return done
}

;({
    packable,
    number,
    text,
    requirePackable,
    packagesOf,
    contentsOf,
    packageOf,
    activePackage,
    boxTypeOf,
    linesOf,
    quantityToPack,
    requireNotHeld,
    issuedTotal,
    completePlan,
    invoicesOf,
    reopenPlan,
    unpack
})
