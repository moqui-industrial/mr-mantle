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
const facilityScope = ec.resource.script("component://mr-mantle/service/mantle/facility/FacilityScope.js")
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
// The stock a pack issues by the order item's reservations: available stock of the shipment's facility. Held stock is
// refused (HELD_STOCK: only an inspection's disposition releases quarantine, F8), and so is a reservation on another
// facility's stock (OTHER_FACILITY), which Mantle's pack would otherwise issue (F285).
function requireNotHeld(source, sh) {
    if (!source?.orderId) return
    for (const reservation of rows(RESERVATION, {orderId: source.orderId, orderItemSeqId: source.orderItemSeqId}))
        if (number(reservation.quantityNotIssued) > 0) {
            const asset = one("mantle.product.asset.Asset", {assetId: reservation.assetId})
            if (posting.heldStatuses.includes(asset?.statusId) || (asset?.statusId && asset.statusId !== "AstAvailable"))
                denied("HELD_STOCK", "Asset " + asset.assetId + " is " + asset.statusId + "; only available stock is packed")
            if (sh && asset?.facilityId !== sh.facilityId)
                denied(
                    "OTHER_FACILITY",
                    "Asset " + reservation.assetId + " is in another facility than shipment " + sh.shipmentId
                )
        }
}
// A named asset (the form's or the scan's): locked and scoped by the posting guard (posting.stock: the user's
// organizations, stock, on hand, the quantity), in the shipment's facility (OTHER_FACILITY), available (HELD_STOCK) and of the
// line's product (PRODUCT_MISMATCH). Mantle's pack is given only this asset (F285).
function packAsset(userScope, sh, assetId, quantity, productIds) {
    if (blank(assetId)) return null
    const asset = posting.stock(userScope, assetId, quantity)
    if (asset.facilityId !== sh.facilityId)
        denied("OTHER_FACILITY", "Asset " + assetId + " is not in facility " + sh.facilityId + " of shipment " + sh.shipmentId)
    if (asset.statusId !== "AstAvailable")
        denied("HELD_STOCK", "Asset " + assetId + " is " + asset.statusId + "; only available stock is packed")
    if (productIds && !productIds.includes(asset.productId))
        denied("PRODUCT_MISMATCH", "Asset " + assetId + " is " + asset.productId + ", not " + productIds.join(" or "))
    return asset
}
// A scan: a product (or its asset or serial) on the shipment (Mantle's get#ShipmentProductByScan), else a component of a pick
// assembly on the shipment by its id, pseudo id, identification, or asset id or serial in the shipment's facility. Answers
// {productId, assetId, component} or null; the asset is checked by packAsset.
function resolveScan(sh, scanInput) {
    const direct = call("mantle.shipment.ShipmentServices.get#ShipmentProductByScan", {shipmentId: sh.shipmentId, scanInput})
    if (direct?.productId) return {productId: direct.productId, assetId: direct.assetId || null, component: false}
    const items = rows("mantle.shipment.ShipmentItem", {shipmentId: sh.shipmentId})
    const assemblies = items
        .map(row => row.productId)
        .filter(productId => one("mantle.product.Product", {productId})?.productTypeEnumId === "PtPickAssembly")
    if (!assemblies.length) return null
    const components = [
        ...new Set(
            Array.from(
                find("mantle.product.ProductAssoc", {productAssocTypeEnumId: "PatMfgBom"})
                    .condition("productId", "in", assemblies)
                    .conditionDate("fromDate", "thruDate", ec.user.nowTimestamp)
                    .list()
            ).map(row => row.toProductId)
        )
    ]
    const scan = String(scanInput).trim()
    if (components.includes(scan)) return {productId: scan, assetId: null, component: true}
    const byPseudo = Array.from(find("mantle.product.Product", {pseudoId: scan}).condition("productId", "in", components).list())
    if (byPseudo.length) return {productId: byPseudo[0].productId, assetId: null, component: true}
    const asset =
        one("mantle.product.asset.Asset", {assetId: scan}) ||
        Array.from(find("mantle.product.asset.Asset", {serialNumber: scan, facilityId: sh.facilityId}).list())[0]
    if (asset && components.includes(asset.productId))
        return {productId: asset.productId, assetId: asset.assetId, component: true}
    const ident = Array.from(
        find("mantle.product.ProductIdentification", {idValue: scan}).condition("productId", "in", components).list()
    )
    if (ident.length) return {productId: ident[0].productId, assetId: null, component: true}
    return null
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
    const named = blank(p.assetId) ? null : one("mantle.product.asset.Asset", {assetId: p.assetId})
    if (!blank(p.assetId) && !named) denied("RECORD_UNAVAILABLE", "Asset " + p.assetId + " is not available")
    if (named) contents = contents.filter(row => row.productId === named.productId)
    if (!blank(p.productId)) contents = contents.filter(row => row.productId === p.productId)
    if (!contents.length) denied("NOTHING_TO_REOPEN", "Package " + pkg.shipmentPackageSeqId + " has nothing to take out")
    const takes = contents.map(content => {
        const held = number(content.quantity)
        const issued = Array.from(
            find(ISSUANCE, {shipmentId: sh.shipmentId, productId: content.productId})
                .condition("quantity", "greater", 0)
                .orderBy("-assetIssuanceId")
                .list()
        )
        // the books must take back the units that leave the box: with the product issued from more than one asset (lots,
        // serials, several locations) the packer names the asset (F287); from one asset the newest issuance is that asset's
        if (!named && new Set(issued.map(row => row.assetId)).size > 1)
            denied(
                "ASSET_REQUIRED",
                content.productId +
                    " was packed from " +
                    [...new Set(issued.map(row => row.assetId))].join(", ") +
                    "; name the asset that comes out of package " +
                    pkg.shipmentPackageSeqId
            )
        const issuances = named ? issued.filter(row => row.assetId === named.assetId) : issued
        // by default all the package holds, or with a named asset what the package holds of it
        const namedIssued = issuances.reduce((sum, row) => sum + number(row.quantity), 0)
        const quantity =
            !blank(p.quantity) && (!blank(p.productId) || named) ? number(p.quantity) : named ? Math.min(held, namedIssued) : held
        if (!(quantity > 0)) denied("QUANTITY_INVALID", "Give a quantity above zero")
        if (quantity > held)
            denied(
                "QUANTITY_EXCEEDS_PACKED",
                "Package " + pkg.shipmentPackageSeqId + " holds only " + text(held) + " of " + content.productId
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
function lockOrders(plan) {
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
    const ordered = [...parts.values()].sort((a, b) => (a.orderId + a.orderPartSeqId).localeCompare(b.orderId + b.orderPartSeqId))
    // the one lock order after the shipment: order parts, then order headers (then the invoices the release locks, then the
    // lines and assets the unpack locks)
    for (const {orderId, orderPartSeqId} of ordered)
        find("mantle.order.OrderPart", {orderId, orderPartSeqId}).forUpdate(true).one()
    for (const orderId of [...new Set(ordered.map(row => row.orderId))])
        find("mantle.order.OrderHeader", {orderId}).forUpdate(true).one()
    return ordered
}
// Back to Approved by the status flows (F281). Re-approving runs Mantle's OrderApproved rules again: the part's
// OrderApprovedNotify, and on the header OrderApprovedReserveAssets (nothing left to reserve while the stock is issued),
// OrderApprovedSendEmail (the store's approval email is sent again) and OrderApprovedFulfillSubscriptions (F290).
function reopenOrders(ordered) {
    const reopened = []
    for (const {orderId, orderPartSeqId} of ordered) {
        if (one("mantle.order.OrderPart", {orderId, orderPartSeqId})?.statusId === "OrderCompleted") {
            call("update#mantle.order.OrderPart", {orderId, orderPartSeqId, statusId: "OrderApproved"})
            reopened.push(orderId + ":" + orderPartSeqId)
        }
    }
    for (const orderId of [...new Set(ordered.map(row => row.orderId))])
        if (one("mantle.order.OrderHeader", {orderId})?.statusId === "OrderCompleted")
            call("update#mantle.order.OrderHeader", {orderId, statusId: "OrderApproved"})
    return reopened
}
// The unpack: each part through unpack#ShipmentItemIssuance (which cancels that much of the issuance, its reservation
// restored on the same asset, and gives the line its quantity back), then the package's content lowered.
function unpack(sh, pkg, plan, ordered) {
    reopenOrders(ordered)
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

// A box type used outside the user's organizations (a facility's box type, or a package of a shipment from a facility of
// another organization) is shared: only a user with every organization's scope changes it (BOX_TYPE_SHARED, F289).
function requireBoxTypeOwned(shipmentBoxTypeId) {
    const userScope = posting.scope()
    if (userScope.allOrganizations || blank(shipmentBoxTypeId)) return
    const foreign = facilityId => {
        const facility = facilityId ? one("mantle.facility.Facility", {facilityId}) : null
        return !facility || !facilityScope.owns(userScope, facility.ownerPartyId)
    }
    if (rows("mantle.facility.FacilityBoxType", {shipmentBoxTypeId}).some(row => foreign(row.facilityId)))
        denied("BOX_TYPE_SHARED", "Box type " + shipmentBoxTypeId + " is used by another organization's facility")
    const shipmentIds = [
        ...new Set(
            Array.from(find(PACKAGE, {shipmentBoxTypeId}).selectField("shipmentId").limit(2000).list()).map(row => row.shipmentId)
        )
    ]
    for (const shipmentId of shipmentIds) {
        const segment = Array.from(
            find("mantle.shipment.ShipmentRouteSegment", {shipmentId}).orderBy("shipmentRouteSegmentSeqId").limit(1).list()
        )[0]
        if (foreign(segment?.originFacilityId))
            denied("BOX_TYPE_SHARED", "Box type " + shipmentBoxTypeId + " is on another organization's packages")
    }
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
    packAsset,
    resolveScan,
    lockOrders,
    requireBoxTypeOwned,
    issuedTotal,
    completePlan,
    invoicesOf,
    reopenPlan,
    unpack
})
