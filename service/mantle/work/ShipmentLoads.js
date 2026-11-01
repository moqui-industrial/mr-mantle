// Shipment loads (picklists) for Warehouse (impl-warehouse P11, design-warehouse §9 Picklists, PicklistDetail and
// CreatePicklists): the wave preview and its guarded create (mantle.work.ShipmentWorkServices preview# and
// create#ShipmentLoadsForOrders with an operation key, each group its own operation and transaction), and the load's
// edits PicklistDetail makes (its header, its shipments and their staging bins, its people and equipment). Every service
// here checks SHIPMENT_LOAD_EDIT and the facility's organization (FacilityScope.js), and re-checks each order part or
// shipment a screen posts back under its lock: its facility, status, hold and reservations, never a list computed earlier.
// Mantle's own create#ShipmentLoadsForOrders without an operation key is unchanged.
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const posting = ec.resource.script("component://mr-mantle/service/mantle/shipment/StockPosting.js")
const facilityScope = ec.resource.script("component://mr-mantle/service/mantle/facility/FacilityScope.js")
const {find, one, rows, denied, call} = lib

const LOAD = "mantle.work.effort.WorkEffort",
    SHIPMENT = "mantle.shipment.Shipment",
    SOURCE = "mantle.shipment.ShipmentItemSource"
const PERMISSION = "SHIPMENT_LOAD_EDIT"
const blank = value => value == null || String(value).trim() === ""
const number = value => (value == null || value === "" ? 0 : Number(String(value)))
const text = value => String(Math.round(number(value) * 1000000) / 1000000)
const truthy = value => value === true || value === "true" || value === "Y"
const closedLoad = ["WeComplete", "WeClosed", "WeCancelled"]
const shippable = ["PtAsset", "PtDigitalAsset", "PtAssetUse", "PtPickAssembly"]

function productItemTypes() {
    return rows("moqui.basic.EnumGroupMember", {enumGroupEnumId: "EngItemsProduct"}).map(row => row.enumId)
}
const partKey = part => part.orderId + ":" + part.orderPartSeqId
// Order parts given as maps ({orderId, orderPartSeqId}) or "orderId:orderPartSeqId" text, without repeats.
function partsOf(list) {
    const seen = new Set()
    const parts = []
    for (const entry of Array.from(list || [])) {
        const part =
            typeof entry === "string" || entry instanceof String
                ? {orderId: String(entry).split(":")[0], orderPartSeqId: String(entry).split(":")[1] || "01"}
                : {orderId: entry.orderId, orderPartSeqId: entry.orderPartSeqId || "01"}
        if (blank(part.orderId) || seen.has(partKey(part))) continue
        seen.add(partKey(part))
        parts.push(part)
    }
    return parts
}

// The groups of a preview a screen posts back (a List, or its JSON text), or null for none; each group's parts are
// checked again by create#ShipmentLoadGroup.
function groupsOf(groups) {
    if (groups == null || groups === "") return null
    const list = typeof groups === "string" || groups instanceof String ? lib.json(String(groups), []) : Array.from(groups)
    const kept = list
        .map((group, index) => ({
            groupKey: String(group.groupKey || index + 1),
            workEffortName: group.workEffortName || null,
            orderParts: partsOf(group.orderParts)
        }))
        .filter(group => group.orderParts.length)
    return kept.length ? kept : null
}

// ===== the wave =====
// Whether an order part can go on a new load at the facility, and why not: held (ORDER_HELD), not approved
// (NOT_APPROVED), another facility's (OTHER_FACILITY), already on a picklist or past picking (ON_PICKLIST), nothing left to
// ship (NOTHING_TO_SHIP), not partly shipped when only those are wanted (NOT_PARTLY_SHIPPED), and, unless excludeNotPickLoc
// is false, less reserved at pick locations than it needs (NOT_RESERVED_AT_PICK, with the shortfall). Quantities are in
// the stock unit (the line's factor, F186). lock reads the part and its header for update (the create).
function evaluate(part, facilityId, options, lock = false) {
    const row = {orderId: part.orderId, orderPartSeqId: part.orderPartSeqId}
    const orderPart = find("mantle.order.OrderPart", {orderId: part.orderId, orderPartSeqId: part.orderPartSeqId})
        .forUpdate(lock)
        .one()
    const header = orderPart ? find("mantle.order.OrderHeader", {orderId: part.orderId}).forUpdate(lock).one() : null
    const exclude = (reasonCode, message, extra = {}) => Object.assign(row, {eligible: false, reasonCode, message}, extra)
    if (!orderPart || !header) return exclude("RECORD_UNAVAILABLE", "Order " + partKey(part) + " is not available")
    Object.assign(row, {customerPartyId: orderPart.customerPartyId || null, facilityId: orderPart.facilityId || null})
    // a part ships from its facility; one with none, from a facility of its vendor
    const facility = one("mantle.facility.Facility", {facilityId})
    if (orderPart.facilityId ? orderPart.facilityId !== facilityId : orderPart.vendorPartyId !== facility?.ownerPartyId)
        return exclude("OTHER_FACILITY", "Order " + partKey(part) + " ships from " + (orderPart.facilityId || "another facility"))
    if (header.statusId === "OrderHold" || orderPart.statusId === "OrderHold")
        return exclude("ORDER_HELD", "Order " + part.orderId + " is on hold: it gets no new shipment")
    if (orderPart.statusId !== "OrderApproved")
        return exclude("NOT_APPROVED", "Order " + partKey(part) + " is not approved")
    const types = productItemTypes()
    const items = rows("mantle.order.OrderItem", {orderId: part.orderId, orderPartSeqId: part.orderPartSeqId}).filter(
        item => item.productId && types.includes(item.itemTypeEnumId) &&
            shippable.includes(one("mantle.product.Product", {productId: item.productId})?.productTypeEnumId)
    )
    let needed = 0, reservedAtPick = 0, issuedTotal = 0
    const pickLocations = new Set(
        rows("mantle.facility.FacilityLocation", {facilityId, locationTypeEnumId: "FltPick"}).map(row => row.locationSeqId)
    )
    for (const item of items) {
        const sources = rows(SOURCE, {orderId: item.orderId, orderItemSeqId: item.orderItemSeqId}).filter(
            row => number(row.quantity) > 0
        )
        for (const source of sources) {
            const shipment = one(SHIPMENT, {shipmentId: source.shipmentId})
            if (
                shipment &&
                (shipment.shipWorkEffortId && options.excludeOnPicklist !== false ||
                    !["ShipInput", "ShipScheduled", "ShipRejected", "ShipCancelled"].includes(shipment.statusId))
            )
                return exclude("ON_PICKLIST", "Order " + partKey(part) + " is already on picklist or shipment " + shipment.shipmentId)
        }
        const factor = number(call("mantle.order.OrderServices.get#OrderItemStockFactor", {orderItem: item}).stockFactor) || 1
        const issued = rows("mantle.product.issuance.AssetIssuance", {orderId: item.orderId, orderItemSeqId: item.orderItemSeqId})
            .reduce((sum, row) => sum + number(row.quantity), 0)
        issuedTotal += issued
        needed += Math.max(0, number(item.quantity) * factor - issued)
        for (const reservation of rows("mantle.product.issuance.AssetReservation", {
            orderId: item.orderId,
            orderItemSeqId: item.orderItemSeqId
        })) {
            const asset = one("mantle.product.asset.Asset", {assetId: reservation.assetId})
            if (asset?.facilityId === facilityId && pickLocations.has(asset.locationSeqId))
                reservedAtPick += Math.max(0, number(reservation.quantityNotIssued) - number(reservation.quantityNotAvailable))
        }
    }
    Object.assign(row, {itemCount: items.length, quantity: text(needed), reservedAtPick: text(reservedAtPick)})
    if (!(needed > 0)) return exclude("NOTHING_TO_SHIP", "Order " + partKey(part) + " has nothing left to ship")
    if (options.onlyPartlyShipped && !(issuedTotal > 0))
        return exclude("NOT_PARTLY_SHIPPED", "Order " + partKey(part) + " has shipped nothing yet")
    if (options.excludeNotPickLoc !== false && reservedAtPick < needed)
        return exclude(
            "NOT_RESERVED_AT_PICK",
            "Order " + partKey(part) + " has " + text(reservedAtPick) + " of " + text(needed) + " reserved at pick locations",
            {shortfall: text(needed - reservedAtPick)}
        )
    return Object.assign(row, {eligible: true, reasonCode: null, message: null})
}
function optionsOf(p) {
    return {
        excludeOnPicklist: p.excludeOnPicklist == null || p.excludeOnPicklist === "" ? true : truthy(p.excludeOnPicklist),
        excludeNotPickLoc: p.excludeNotPickLoc == null || p.excludeNotPickLoc === "" ? true : truthy(p.excludeNotPickLoc),
        onlyPartlyShipped: truthy(p.onlyPartlyShipped)
    }
}
// The preview: each candidate evaluated, the eligible in order put in groups of ordersPerPicklist (bins 1..n), the
// excluded named with their reason and shortfall; previewFingerprint covers the groups.
function preview(p, candidates) {
    posting.requirePermission(PERMISSION)
    const userScope = posting.scope()
    const facility = posting.facility(userScope, p.facilityId)
    const perLoad = Math.max(1, Math.floor(number(p.ordersPerPicklist) || 1))
    const options = optionsOf(p)
    const names = lib.partyNames(candidates.map(part => one("mantle.order.OrderPart", part)?.customerPartyId).filter(Boolean))
    const evaluated = candidates.map(part => evaluate(part, facility.facilityId, options))
    for (const row of evaluated) row.customerName = row.customerPartyId ? names[row.customerPartyId] || row.customerPartyId : ""
    const eligible = evaluated.filter(row => row.eligible)
    const groups = []
    eligible.forEach((row, index) => {
        if (index % perLoad === 0)
            groups.push({
                groupKey: String(groups.length + 1),
                workEffortName: (p.workEffortName || "Picklist") + " " + (groups.length + 1),
                orderParts: []
            })
        const group = groups[groups.length - 1]
        row.groupKey = group.groupKey
        row.binLocationNumber = group.orderParts.length + 1
        group.orderParts.push({orderId: row.orderId, orderPartSeqId: row.orderPartSeqId, binLocationNumber: row.binLocationNumber})
    })
    return {
        facilityId: facility.facilityId,
        groups,
        partRows: eligible,
        excludedRows: evaluated.filter(row => !row.eligible),
        previewFingerprint: lib.hash(groups.map(group => group.orderParts.map(partKey)))
    }
}

// One group of the guarded create, as its own operation (create#ShipmentLoadGroup, run by posting.batch): each order part
// locked and evaluated again (the excluded named, the others added with their bins), then the load; a group none of whose
// parts is still eligible is refused (NOTHING_ELIGIBLE), so no empty load is made.
function createGroup(p) {
    const userScope = posting.scope()
    const facility = posting.facility(userScope, p.facilityId)
    const options = optionsOf(p)
    const parts = partsOf(p.orderParts)
    if (!parts.length) denied("NOTHING_ELIGIBLE", "The group has no orders")
    const checked = parts.map(part => evaluate(part, facility.facilityId, options, true))
    const eligible = checked.filter(row => row.eligible)
    const excluded = checked.filter(row => !row.eligible).map(row => lib.pick(row, ["orderId", "orderPartSeqId", "reasonCode", "message"]))
    if (!eligible.length)
        denied("NOTHING_ELIGIBLE", "No order of the group can go on a picklist now: " + excluded.map(row => row.message).join("; "))
    const created = call("mantle.work.ShipmentWorkServices.create#ShipmentLoadShip", {
        facilityId: facility.facilityId,
        workEffortName: p.workEffortName,
        estimatedStartDate: p.estimatedStartDate || ec.user.nowTimestamp,
        ownerPartyId: facility.ownerPartyId
    })
    const added = []
    let bin = 1
    for (const row of eligible) {
        const out = call("mantle.work.ShipmentWorkServices.add#OrderPartToShipmentLoad", {
            orderId: row.orderId,
            orderPartSeqId: row.orderPartSeqId,
            workEffortId: created.workEffortId,
            binLocationNumber: bin,
            allowBulkLocations: true
        })
        const shipmentIds = Array.from(out.shipmentIdList || [])
        if (!shipmentIds.length) {
            excluded.push({orderId: row.orderId, orderPartSeqId: row.orderPartSeqId, reasonCode: "NO_SHIPMENT",
                message: "No shipment could be made for order " + partKey(row)})
            continue
        }
        added.push({orderId: row.orderId, orderPartSeqId: row.orderPartSeqId, binLocationNumber: bin, shipmentIds})
        bin++
    }
    if (!added.length) denied("NOTHING_ELIGIBLE", "No order of the group could be put on a picklist")
    if (!blank(p.assigneePartyId)) assignParty(created.workEffortId, p.assigneePartyId, "Worker", facility)
    return {facility, workEffortId: created.workEffortId, workEffortName: p.workEffortName, added, excluded}
}

// ===== a load's edits (PicklistDetail) =====
function loadOf(userScope, workEffortId, lock = true) {
    const load = blank(workEffortId) ? null : find(LOAD, {workEffortId}).forUpdate(lock).one()
    const facility = load?.facilityId ? one("mantle.facility.Facility", {facilityId: load.facilityId}) : null
    if (!load || load.purposeEnumId !== "WepShipmentShip" || !facility || !facilityScope.owns(userScope, facility.ownerPartyId))
        denied("RECORD_UNAVAILABLE", "Picklist " + (workEffortId || "") + " is not available")
    return {load, facility}
}
function requireOpen(load) {
    if (closedLoad.includes(load.statusId))
        denied("LOAD_CLOSED", "Picklist " + load.workEffortId + " is " + load.statusId + " and can no longer change")
}
// store#ShipmentLoad: a new manual load of a facility of the user's organizations, or an open load's name, dates and
// description.
function storeLoad(p) {
    posting.requirePermission(PERMISSION)
    const userScope = posting.scope()
    if (blank(p.workEffortId)) {
        const facility = posting.facility(userScope, p.facilityId)
        if (blank(p.workEffortName)) denied("NAME_REQUIRED", "Name the picklist")
        const created = call("mantle.work.ShipmentWorkServices.create#ShipmentLoadShip", {
            facilityId: facility.facilityId,
            workEffortName: String(p.workEffortName).trim(),
            estimatedStartDate: p.estimatedStartDate || ec.user.nowTimestamp,
            estimatedCompletionDate: p.estimatedCompletionDate || null,
            description: blank(p.description) ? null : String(p.description).trim(),
            ownerPartyId: facility.ownerPartyId
        })
        if (!blank(p.assigneePartyId)) assignParty(created.workEffortId, p.assigneePartyId, "Worker", facility)
        return {workEffortId: created.workEffortId, created: true}
    }
    const {load} = loadOf(userScope, p.workEffortId)
    requireOpen(load)
    const changes = {workEffortId: load.workEffortId}
    if (!blank(p.workEffortName)) changes.workEffortName = String(p.workEffortName).trim()
    if (p.estimatedStartDate) changes.estimatedStartDate = p.estimatedStartDate
    if (p.estimatedCompletionDate) changes.estimatedCompletionDate = p.estimatedCompletionDate
    if (p.description != null) changes.description = blank(p.description) ? null : String(p.description).trim()
    call("update#" + LOAD, changes)
    return {workEffortId: load.workEffortId, created: false}
}
// edit#ShipmentLoadMember: add a shipment or an order part (re-checked: the load's facility, not held, approved, not on
// another load), take off a shipment nothing of which is picked (PICK_STARTED), or set a shipment's staging bin. The bin
// is on the shipment and on its source lines, and a line's own bin wins (F18), so a bin change sets the shipment's and
// every line's that has one.
function editMember(p) {
    posting.requirePermission(PERMISSION)
    const userScope = posting.scope()
    const {load, facility} = loadOf(userScope, p.workEffortId)
    requireOpen(load)
    const action = String(p.memberAction || "")
    const bin = blank(p.binLocationNumber) ? null : Math.floor(number(p.binLocationNumber))
    if (bin != null && !(bin > 0)) denied("BIN_INVALID", "A bin is a number above zero")
    if (action === "addOrder") {
        const row = evaluate({orderId: p.orderId, orderPartSeqId: p.orderPartSeqId || "01"}, facility.facilityId,
            {excludeOnPicklist: true, excludeNotPickLoc: false}, true)
        if (!row.eligible) denied(row.reasonCode, row.message)
        const out = call("mantle.work.ShipmentWorkServices.add#OrderPartToShipmentLoad", {
            orderId: row.orderId,
            orderPartSeqId: row.orderPartSeqId,
            workEffortId: load.workEffortId,
            binLocationNumber: bin
        })
        return {workEffortId: load.workEffortId, shipmentIds: Array.from(out.shipmentIdList || [])}
    }
    const shipment = blank(p.shipmentId) ? null : find(SHIPMENT, {shipmentId: p.shipmentId}).forUpdate(true).one()
    const origin = shipment
        ? Array.from(find("mantle.shipment.ShipmentRouteSegment", {shipmentId: shipment.shipmentId})
            .orderBy("shipmentRouteSegmentSeqId").limit(1).list())[0]
        : null
    if (!shipment || origin?.originFacilityId !== facility.facilityId)
        denied("RECORD_UNAVAILABLE", "Shipment " + (p.shipmentId || "") + " does not leave from this picklist's facility")
    if (action === "addShipment") {
        if (shipment.shipWorkEffortId && shipment.shipWorkEffortId !== load.workEffortId)
            denied("ON_PICKLIST", "Shipment " + shipment.shipmentId + " is on picklist " + shipment.shipWorkEffortId)
        if (!["ShipInput", "ShipScheduled", "ShipPicked", "ShipPacked"].includes(shipment.statusId))
            denied("SHIPMENT_NOT_OPEN", "Shipment " + shipment.shipmentId + " is " + shipment.statusId)
        call("mantle.work.ShipmentWorkServices.add#ShipmentToShipmentLoad", {
            shipmentId: shipment.shipmentId,
            workEffortId: load.workEffortId,
            binLocationNumber: bin
        })
        return {workEffortId: load.workEffortId, shipmentIds: [shipment.shipmentId]}
    }
    if (shipment.shipWorkEffortId !== load.workEffortId)
        denied("RECORD_UNAVAILABLE", "Shipment " + shipment.shipmentId + " is not on picklist " + load.workEffortId)
    const sources = rows(SOURCE, {shipmentId: shipment.shipmentId})
    if (action === "remove") {
        if (!["ShipInput", "ShipScheduled"].includes(shipment.statusId) || sources.some(row => number(row.quantityPicked) > 0))
            denied("PICK_STARTED", "Shipment " + shipment.shipmentId + " is being picked; finish or put back its picks first")
        call("update#" + SHIPMENT, {shipmentId: shipment.shipmentId, shipWorkEffortId: null, binLocationNumber: null})
        return {workEffortId: load.workEffortId, shipmentIds: [shipment.shipmentId]}
    }
    if (action === "bin") {
        if (bin == null) denied("BIN_INVALID", "Give the bin number")
        call("update#" + SHIPMENT, {shipmentId: shipment.shipmentId, binLocationNumber: bin})
        for (const source of sources.filter(row => row.binLocationNumber != null))
            call("update#" + SOURCE, {shipmentItemSourceId: source.shipmentItemSourceId, binLocationNumber: bin})
        return {workEffortId: load.workEffortId, shipmentIds: [shipment.shipmentId], binLocationNumber: bin}
    }
    denied("ACTION_INVALID", "Choose to add an order or a shipment, remove a shipment or set its bin")
}
// A person of the facility owner (an agent, employee or other relationship to it) on the load, in a role (Worker picks,
// Manager supervises).
function assignParty(workEffortId, partyId, roleTypeId, facility, fromDate = null, thruDate = null) {
    const person = one("mantle.party.Person", {partyId})
    const related = rows("mantle.party.PartyRelationship", {fromPartyId: partyId, toPartyId: facility.ownerPartyId}).some(row =>
        lib.active(row)
    )
    if (!person || !related) denied("PARTY_UNAVAILABLE", "Party " + partyId + " is not a person of " + facility.ownerPartyId)
    if (!["Worker", "Manager"].includes(roleTypeId)) denied("ROLE_INVALID", "Choose picker (Worker) or supervisor (Manager)")
    if (!one("mantle.party.PartyRole", {partyId, roleTypeId})) call("create#mantle.party.PartyRole", {partyId, roleTypeId})
    const start = fromDate || ec.user.nowTimestamp
    call("create#mantle.work.effort.WorkEffortParty", {
        workEffortId,
        partyId,
        roleTypeId,
        fromDate: start,
        thruDate: thruDate || null,
        statusId: "WeptAssigned"
    })
    return {partyId, roleTypeId, fromDate: start}
}
// store#ShipmentLoadAssignment: a person or a piece of equipment assigned to the load, or an assignment ended now
// (endAssignment Y with its fromDate). Equipment is a non-stock asset of the load's facility that has not left, not on
// another open load for the same time (EQUIPMENT_BUSY).
function storeAssignment(p) {
    posting.requirePermission(PERMISSION)
    const userScope = posting.scope()
    const {load, facility} = loadOf(userScope, p.workEffortId)
    requireOpen(load)
    const kind = String(p.assignmentKind || "")
    if (truthy(p.endAssignment)) {
        if (blank(p.fromDate)) denied("ASSIGNMENT_REQUIRED", "Name the assignment to end")
        const entity = kind === "equipment" ? "mantle.work.effort.WorkEffortAssetAssign" : "mantle.work.effort.WorkEffortParty"
        const keyField = kind === "equipment" ? "assetId" : "partyId"
        const found = rows(entity, {workEffortId: load.workEffortId, [keyField]: p[keyField]}).find(
            row => lib.ms(row.fromDate) === lib.ms(p.fromDate) && (kind === "equipment" || row.roleTypeId === p.roleTypeId)
        )
        if (!found) denied("ASSIGNMENT_REQUIRED", "That assignment is not on picklist " + load.workEffortId)
        call("update#" + entity, Object.assign(lib.pick(found, ["workEffortId", keyField, "roleTypeId", "fromDate"]),
            {thruDate: ec.user.nowTimestamp}))
        return {workEffortId: load.workEffortId, ended: true}
    }
    if (kind === "party") {
        const done = assignParty(load.workEffortId, p.partyId, p.roleTypeId || "Worker", facility, p.fromDate, p.thruDate)
        return Object.assign({workEffortId: load.workEffortId, ended: false}, done)
    }
    if (kind !== "equipment") denied("ACTION_INVALID", "Assign a person or equipment")
    const asset = blank(p.assetId) ? null : one("mantle.product.asset.Asset", {assetId: p.assetId})
    if (!asset || asset.facilityId !== facility.facilityId || posting.stockTypes.includes(asset.assetTypeEnumId || "AstTpInventory") ||
        ["AstDeactivated", "AstDelivered"].includes(asset.statusId) || asset.actualEndOfLife)
        denied("EQUIPMENT_UNAVAILABLE", "Asset " + (p.assetId || "") + " is not equipment at " + facility.facilityId)
    const busy = rows("mantle.work.effort.WorkEffortAssetAssign", {assetId: asset.assetId})
        .filter(row => row.workEffortId !== load.workEffortId && lib.active(row))
        .find(row => {
            const other = one(LOAD, {workEffortId: row.workEffortId})
            return other?.purposeEnumId === "WepShipmentShip" && !closedLoad.includes(other.statusId)
        })
    if (busy) denied("EQUIPMENT_BUSY", "Asset " + asset.assetId + " is on picklist " + busy.workEffortId)
    const start = p.fromDate || ec.user.nowTimestamp
    call("create#mantle.work.effort.WorkEffortAssetAssign", {
        workEffortId: load.workEffortId,
        assetId: asset.assetId,
        fromDate: start,
        thruDate: p.thruDate || null,
        statusId: "WeaaAssigned"
    })
    return {workEffortId: load.workEffortId, assetId: asset.assetId, fromDate: start, ended: false}
}

;({
    number,
    text,
    truthy,
    partsOf,
    groupsOf,
    optionsOf,
    evaluate,
    preview,
    createGroup,
    storeLoad,
    editMember,
    storeAssignment
})
