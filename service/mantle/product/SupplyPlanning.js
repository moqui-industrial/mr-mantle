// The shared supply plan (design-crosscut CX-PLANNING, §3.20 and §4.2; design-manufacturing §7 SupplyPlanning;
// impl-manufacturing P13): mantle.product.SupplyPlanningServices' run#SupplyPlan, get#SupplyPlan, store#PlanSchedule,
// convert#PlanningSuggestions and the scheduled run.
//
// A run plans an organization's facility set: each facility of the set (a warehouse or plant) is netted with the facilities
// under it (its lines), so a run on a line and a run on the warehouse itself both count (F16). Netting reads the sources
// get#InventoryProjectedInfo sums (available stock, open sales demand less its reservations, the WeptConsume and WeptProduce
// rows of every run not completed, drafts included) from the entities in the run's own transaction, adds open purchase
// order supply and the minimum stock, and tells kit assemblies apart: a pick-assembly kit's sales demand is its kit
// components' demand, and a kit assembly run's rows are shown and not netted (it was made for an order already counted).
// get#InventoryProjectedInfo itself is not called: it reads the search index, which lags the commit (a run just converted
// would be suggested again), its run documents carry no purpose (kits cannot be told apart), and it files a run under its
// facility's parent, so a run on the warehouse is missed (impl-manufacturing F-P13-1).
//
// Make demand is exploded level by level through get#BomExplosion's requirements, which stop at a non-phantom
// sub-assembly (whose own stock and supply net before its shortage is exploded) and blow phantoms through (§4, Q8; F24):
// every product's level is one more than its deepest parent, and a product is netted once, after all its parents. A make
// suggestion's release date is its required date less the BOM's lead and preparation days (or, with the production
// policy's routing basis, its routing's standard hours as days; R-MFG-31). Held quantity (quarantined stock, with its
// inspection's due date) is a pending-release line, left out of netting unless the organization's plan schedule nets what
// is due within the lead time (§4). check#ProductUsable is called for each suggestion, so an obsolete product is an
// exception, never a silent zero. Each suggestion stands on a Requirement of the organization (RequirementParty
// OrgInternal), in the stock unit (Requirement.quantityUomId); a new run supersedes the last run's unconverted suggestions
// and reuses their requirements.
//
// Conversion turns make suggestions into draft runs through mantle.work.ProductionServices.create#ProductionOrder (never a
// release), each suggestion on its own: the requirement locked, its covered quantity read, the run created with the method
// as of the plan date (or the date given), then RequirementSupply and WorkRequirementFulfillment WrfDelivers. A second
// conversion of a covered requirement answers its existing run. A stale run (superseded, or older than the policy's
// freshness limit) is refused. Buy and transfer suggestions are shown with their supplier or source; their conversions are
// Purchasing's and Warehouse's (impl-manufacturing §7), and the outside-processing buy is P14's.
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const facilityScope = ec.resource.script("component://mr-mantle/service/mantle/facility/FacilityScope.js")
const {find, one, rows, ms, denied, call, probe, dateText, access} = lib

const RUN = "mantle.request.requirement.PlanningRun",
    RUN_FACILITY = "mantle.request.requirement.PlanningRunFacility",
    SUGGESTION = "mantle.request.requirement.PlanningSuggestion",
    SUPPLY = "mantle.request.requirement.RequirementSupply",
    SCHEDULE = "mantle.request.requirement.PlanSchedule",
    REQUIREMENT = "mantle.request.requirement.Requirement",
    REQUIREMENT_PARTY = "mantle.request.requirement.RequirementParty",
    FACILITY = "mantle.facility.Facility",
    PRODUCT = "mantle.product.Product",
    ASSET = "mantle.product.asset.Asset",
    WORK = "mantle.work.effort.WorkEffort",
    WEP = "mantle.work.effort.WorkEffortProduct",
    BOM = "mantle.product.bom.ProductBom",
    DECISION = "mantle.work.method.MethodReleaseDecision"
const dayMs = 86400000
// the order part statuses of firm demand and supply (quotes, carts and wish lists are not)
const firmOrderStatuses = ["OrderPlaced", "OrderHold", "OrderProcessing", "OrderApproved", "OrderSent"]
const closedRunStatuses = ["WeComplete", "WeClosed", "WeCancelled"]
const openSuggestionStates = ["PssProposed", "PssPartial", "PssException"]
// who reads a plan (any planner mount: the production reader, a planner; Purchasing and Warehouse add their view
// permissions when they mount it) and who converts each method (Purchasing adds buy, Warehouse transfer; P14 the
// outside-processing buy)
const readPermissions = ["SUPPLY_PLAN_RUN", "PRODUCTION_PLAN", "PRODUCTION_VIEW"]
const convertPermissions = {PsmMake: "PRODUCTION_PLAN"}
const productLimit = 500
const facilityDepth = 4

const blank = value => value == null || String(value).trim() === ""
const str = value => (blank(value) ? null : String(value))
const dec = value => toDecimal(value == null || value === "" ? 0 : value)
const zero = () => toDecimal(0)
const text = value => (value == null ? null : dec(value).compare(0) === 0 ? "0" : String(dec(value).toNumber()))
const listOf = value =>
    value == null || value === ""
        ? []
        : Array.isArray(value) || typeof value !== "string"
          ? Array.from(value).map(String).filter(Boolean)
          : String(value)
                .split(",")
                .map(each => each.trim())
                .filter(Boolean)
const enumText = enumId => (enumId ? one("moqui.basic.Enumeration", {enumId})?.description || enumId : "")
const facilityName = facility => (facility ? facility.facilityName || facility.facilityId : "")
const productionPolicy = () => ec.resource.script("component://mr-mantle/service/mantle/work/ProductionPolicy.js")
const methodPolicy = () => ec.resource.script("component://mr-mantle/service/mantle/product/MethodPolicy.js")
const routings = () => ec.resource.script("component://mr-mantle/service/mantle/work/Routings.js")
const workCalendar = () => ec.resource.script("component://mr-mantle/service/mantle/work/ProductionCalendar.js")

// ===== scope =====
function requireAny(permissions) {
    if (!ec.user.userId) denied("PERMISSION_DENIED", "A signed-in user is required")
    if (!permissions.some(access.has)) denied("PERMISSION_DENIED", permissions.join(" or ") + " is required")
}
// The organization and facility set of a request, in the user's organizations: the organization given, else the first
// facility's owner, else the active organization, else the user's first; the facilities given (each the organization's),
// else the schedule's, else the organization's top facilities that are warehouses or plants.
function scopeOf(p) {
    const userScope = facilityScope.scope()
    const facilityIds = listOf(p.facilityIds)
        .concat(listOf(p.facilityId))
        .filter((id, index, all) => all.indexOf(id) === index)
    const first = facilityIds.length ? one(FACILITY, {facilityId: facilityIds[0]}) : null
    const organizationPartyId =
        str(p.organizationPartyId) ||
        first?.ownerPartyId ||
        userScope.activeOrganizationPartyId ||
        userScope.memberPartyIds[0] ||
        null
    if (
        !organizationPartyId ||
        !one("mantle.party.PartyRole", {partyId: organizationPartyId, roleTypeId: "OrgInternal"}) ||
        !facilityScope.owns(userScope, organizationPartyId)
    )
        denied("RECORD_UNAVAILABLE", "Organization " + (organizationPartyId || "") + " is not available")
    let ids = facilityIds
    if (!ids.length) ids = listOf(one(SCHEDULE, {organizationPartyId})?.facilityIds)
    if (!ids.length)
        ids = rows(FACILITY, {ownerPartyId: organizationPartyId})
            .filter(row => ["FcTpWarehouse", "FcTpPlant"].includes(row.facilityTypeEnumId))
            .filter(row => {
                const parent = row.parentFacilityId ? one(FACILITY, {facilityId: row.parentFacilityId}) : null
                return !parent || parent.ownerPartyId !== organizationPartyId
            })
            .map(row => row.facilityId)
    const facilities = ids.map(facilityId => {
        const facility = one(FACILITY, {facilityId})
        if (!facility || facility.ownerPartyId !== organizationPartyId || !facilityScope.owns(userScope, facility.ownerPartyId))
            denied("RECORD_UNAVAILABLE", "Facility " + facilityId + " is not available")
        return facility
    })
    if (!facilities.length) denied("FACILITY_REQUIRED", "Choose the facilities to plan")
    facilities.sort((a, b) => String(a.facilityId).localeCompare(String(b.facilityId)))
    return {userScope, organizationPartyId, facilities, setKey: facilities.map(row => row.facilityId).join(",")}
}
// A facility and those under it of the same owner (its lines), at most a few levels down.
function facilityTree(facility) {
    const ids = [facility.facilityId]
    let level = [facility.facilityId]
    for (let depth = 0; depth < facilityDepth && level.length; depth++) {
        const children = Array.from(
            find(FACILITY, {ownerPartyId: facility.ownerPartyId}).condition("parentFacilityId", "in", level).list()
        )
            .map(row => row.facilityId)
            .filter(id => !ids.includes(id))
        ids.push(...children)
        level = children
    }
    return ids
}

// ===== demand and supply =====
// The open sales demand of the organization at a facility set, by product: what is ordered less what was cancelled, issued
// and reserved (the reserved quantity is out of the available stock already, its unavailable part as a negative available
// to promise). A kit's line is its kit components' demand.
function salesDemand(ctx, node) {
    const parts = Array.from(
        find("mantle.order.OrderPart", {vendorPartyId: ctx.organizationPartyId})
            .condition("facilityId", "in", node.facilityIds)
            .condition("statusId", "in", firmOrderStatuses)
            .list()
    )
    const byProduct = new Map()
    const add = (productId, line) => {
        if (!byProduct.has(productId)) byProduct.set(productId, [])
        byProduct.get(productId).push(line)
    }
    for (const part of parts) {
        const items = rows("mantle.order.OrderItem", {orderId: part.orderId, orderPartSeqId: part.orderPartSeqId}).filter(
            item => item.productId
        )
        for (const item of items) {
            const ordered = dec(item.quantity).subtract(dec(item.quantityCancelled))
            const keyOf = {orderId: item.orderId, orderItemSeqId: item.orderItemSeqId}
            // issued and reserved by product: a kit's line is issued as the kit and reserved as its components
            const sums = (entity, quantityOf) => {
                const byId = new Map()
                for (const row of rows(entity, keyOf)) {
                    const quantity = quantityOf(row)
                    if (quantity.compare(0) > 0) byId.set(row.productId, (byId.get(row.productId) || zero()).add(quantity))
                }
                return byId
            }
            const issued = sums("mantle.product.issuance.AssetIssuance", row => dec(row.quantity))
            // the whole reservation not issued: its unavailable part is a negative available to promise already
            // (reserve#AssetForOrderItem), as get#InventoryProjectedInfo's orderNotReserved has it
            const reserved = sums("mantle.product.issuance.AssetReservation", row => dec(row.quantityNotIssued ?? row.quantity))
            const sumOf = map => Array.from(map.values()).reduce((total, quantity) => total.add(quantity), zero())
            const date = item.requiredByDate || part.shipBeforeDate || null
            const line = {
                kind: "sales",
                label: "Sales order " + item.orderId + " line " + item.orderItemSeqId,
                orderId: item.orderId,
                orderItemSeqId: item.orderItemSeqId,
                date
            }
            const product = one(PRODUCT, {productId: item.productId})
            if (product?.productTypeEnumId === "PtPickAssembly") {
                const notIssued = ordered.subtract(issued.get(item.productId) || zero())
                if (notIssued.compare(0) <= 0) continue
                for (const component of kitComponents(item.productId, notIssued, ctx.planDate)) {
                    // a component's reservation counts once, also when nested kits name it twice
                    const held = reserved.get(component.productId) || zero()
                    const taken = held.compare(component.quantity) < 0 ? held : component.quantity
                    reserved.set(component.productId, held.subtract(taken))
                    const open = component.quantity.subtract(taken)
                    if (open.compare(0) > 0)
                        add(
                            component.productId,
                            Object.assign({}, line, {
                                kind: "kitSales",
                                label: line.label + ", kit " + item.productId,
                                quantity: open
                            })
                        )
                }
                continue
            }
            const open = ordered.subtract(sumOf(issued)).subtract(sumOf(reserved))
            if (open.compare(0) > 0) add(item.productId, Object.assign(line, {quantity: open}))
        }
    }
    return byProduct
}
// The components of a pick-assembly kit for a quantity, nested kits through their components (Products' kit
// components: ProductAssoc PatMfgBom in effect at the date).
function kitComponents(productId, quantity, date, depth = 0) {
    if (depth > 16) return []
    const out = []
    for (const edge of rows("mantle.product.ProductAssoc", {productId, productAssocTypeEnumId: "PatMfgBom"}).filter(row =>
        lib.active(row, date)
    )) {
        const needed = quantity.multiply(dec(edge.quantity || 1))
        const child = one(PRODUCT, {productId: edge.toProductId})
        if (child?.productTypeEnumId === "PtPickAssembly") out.push(...kitComponents(edge.toProductId, needed, date, depth + 1))
        else out.push({productId: edge.toProductId, quantity: needed})
    }
    return out
}
// The WeptConsume and WeptProduce rows of the organization's runs not completed at a facility set, by product: a production
// run's remaining consumption is demand and its remaining output supply; a kit assembly's are shown, not netted.
function runRows(ctx, node) {
    const runs = Array.from(
        find(WORK, {ownerPartyId: ctx.organizationPartyId})
            .condition("facilityId", "in", node.facilityIds)
            .condition("statusId", "not-in", closedRunStatuses)
            .condition("purposeEnumId", "in", ["WepProductionRun", "WepPickAssembly"])
            .list()
    )
    const byProduct = new Map()
    if (!runs.length) return byProduct
    const runById = new Map(runs.map(run => [run.workEffortId, run]))
    const products = Array.from(
        find(WEP)
            .condition("workEffortId", "in", Array.from(runById.keys()))
            .condition("typeEnumId", "in", ["WeptConsume", "WeptProduce"])
            .list()
    ).filter(row => lib.active(row, ctx.planDate))
    for (const row of products) {
        const run = runById.get(row.workEffortId)
        const produce = row.typeEnumId === "WeptProduce"
        const done = produce
            ? rows("mantle.product.receipt.AssetReceipt", {workEffortId: row.workEffortId, productId: row.productId}).reduce(
                  (total, receipt) => total.add(dec(receipt.quantityAccepted)),
                  zero()
              )
            : rows("mantle.product.issuance.AssetIssuance", {workEffortId: row.workEffortId, productId: row.productId}).reduce(
                  (total, issuance) => total.add(dec(issuance.quantity)),
                  zero()
              )
        const remaining = dec(row.estimatedQuantity).subtract(done)
        if (remaining.compare(0) <= 0) continue
        const kit = run.purposeEnumId !== "WepProductionRun"
        const line = {
            kind: kit ? (produce ? "kitOutput" : "kitMaterial") : produce ? "runOutput" : "runMaterial",
            label:
                (kit ? "Kit assembly " : "Work order ") + run.workEffortId + (run.statusId === "WeInPlanning" ? " (draft)" : ""),
            workEffortId: run.workEffortId,
            date: produce ? run.estimatedCompletionDate || null : run.estimatedStartDate || null,
            quantity: remaining,
            supply: produce,
            netted: !kit
        }
        if (!byProduct.has(row.productId)) byProduct.set(row.productId, [])
        byProduct.get(row.productId).push(line)
    }
    return byProduct
}
// The minimum stock of products at the facilities of the set (ProductFacility), as demand.
function minimumStock(ctx, node) {
    const byProduct = new Map()
    for (const row of rows("mantle.facility.ProductFacility", {facilityId: node.facilityId}))
        if (row.minimumStock != null && dec(row.minimumStock).compare(0) > 0)
            byProduct.set(row.productId, [
                {kind: "minimum", label: "Minimum stock at " + node.facilityName, date: null, quantity: dec(row.minimumStock)}
            ])
    return byProduct
}
// The organization's transfers in transit to a node, by product: each transfer line's issuances less what its receipts
// accepted and rejected (Transfers.js sums the two apart, F37). The origin's stock is out of its available to promise once
// issued, so it is supply at the destination until received (get#InventoryProjectedInfo counts no transfer).
function transferRows(ctx, node) {
    const byProduct = new Map()
    const shipments = Array.from(
        find("mantle.shipment.Shipment", {shipmentTypeEnumId: "ShpTpTransfer", fromPartyId: ctx.organizationPartyId})
            .condition("statusId", "not-in", ["ShipDelivered", "ShipRejected", "ShipCancelled"])
            .list()
    )
    for (const shipment of shipments) {
        const segments = rows("mantle.shipment.ShipmentRouteSegment", {shipmentId: shipment.shipmentId}).sort((a, b) =>
            String(a.shipmentRouteSegmentSeqId).localeCompare(String(b.shipmentRouteSegmentSeqId))
        )
        const destinationId = [...segments].reverse().find(row => row.destinationFacilityId)?.destinationFacilityId || null
        if (!destinationId || !node.facilityIds.includes(destinationId)) continue
        for (const source of rows("mantle.shipment.ShipmentItemSource", {shipmentId: shipment.shipmentId})) {
            if (source.statusId === "SisCancelled" || !source.productId) continue
            const issued = rows("mantle.product.issuance.AssetIssuance", {
                shipmentItemSourceId: source.shipmentItemSourceId
            }).reduce((total, row) => total.add(dec(row.quantity).subtract(dec(row.quantityCancelled))), zero())
            const received = rows("mantle.product.receipt.AssetReceipt", {
                shipmentItemSourceId: source.shipmentItemSourceId
            }).reduce((total, row) => total.add(dec(row.quantityAccepted)).add(dec(row.quantityRejected)), zero())
            const inTransit = issued.subtract(received)
            if (inTransit.compare(0) <= 0) continue
            if (!byProduct.has(source.productId)) byProduct.set(source.productId, [])
            byProduct.get(source.productId).push({
                kind: "transfer",
                label: "Transfer " + shipment.shipmentId + " in transit",
                shipmentId: shipment.shipmentId,
                date: shipment.estimatedArrivalDate || null,
                quantity: inTransit,
                supply: true
            })
        }
    }
    return byProduct
}
// The stock and open supply of a product at a node: available stock, held stock with its inspection's due date (pending
// release), transfers in transit to it, and open purchase order lines less what they received.
function stockLines(ctx, node, productId) {
    const lines = (node.transfers?.get(productId) || []).map(line => Object.assign({}, line))
    const assets = Array.from(
        find(ASSET, {productId, ownerPartyId: ctx.organizationPartyId, assetTypeEnumId: "AstTpInventory"})
            .condition("facilityId", "in", node.facilityIds)
            .condition("statusId", "in", ["AstAvailable", "AstQuarantine"])
            .list()
    )
    const available = assets
        .filter(asset => asset.statusId === "AstAvailable")
        .reduce((total, asset) => total.add(dec(asset.availableToPromiseTotal)), zero())
    if (available.compare(0) !== 0)
        lines.push({kind: "stock", label: "Available at " + node.facilityName, date: null, quantity: available, supply: true})
    for (const asset of assets.filter(row => row.statusId === "AstQuarantine")) {
        const quantity = dec(asset.quantityOnHandTotal)
        if (quantity.compare(0) <= 0) continue
        const inspections = rows("mantle.product.quality.QualityInspection", {assetId: asset.assetId}).filter(
            row => !["QiDisposed", "QiCancelled"].includes(row.statusId) && dec(row.heldQuantity ?? row.quantity).compare(0) > 0
        )
        const due = inspections
            .map(row => row.dueDate)
            .filter(Boolean)
            .sort((a, b) => ms(a) - ms(b))[0]
        lines.push({
            kind: "held",
            label: "Held for inspection" + (inspections.length ? " " + inspections[0].qualityInspectionId : ""),
            assetId: asset.assetId,
            qualityInspectionId: inspections[0]?.qualityInspectionId || null,
            date: due || null,
            quantity,
            supply: true,
            netted: false
        })
    }
    const parts = Array.from(
        find("mantle.order.OrderPart", {customerPartyId: ctx.organizationPartyId})
            .condition("facilityId", "in", node.facilityIds)
            .condition("statusId", "in", firmOrderStatuses)
            .list()
    ).filter(part => part.vendorPartyId !== ctx.organizationPartyId)
    for (const part of parts)
        for (const item of rows("mantle.order.OrderItem", {
            orderId: part.orderId,
            orderPartSeqId: part.orderPartSeqId,
            productId
        })) {
            const received = rows("mantle.product.receipt.AssetReceipt", {
                orderId: item.orderId,
                orderItemSeqId: item.orderItemSeqId
            }).reduce((total, row) => total.add(dec(row.quantityAccepted)), zero())
            const open = dec(item.quantity).subtract(dec(item.quantityCancelled)).subtract(received)
            if (open.compare(0) > 0)
                lines.push({
                    kind: "purchase",
                    label: "Purchase order " + item.orderId + " line " + item.orderItemSeqId,
                    orderId: item.orderId,
                    orderItemSeqId: item.orderItemSeqId,
                    date: item.requiredByDate || part.estimatedDeliveryDate || null,
                    quantity: open,
                    supply: true
                })
        }
    return lines
}

// ===== methods =====
// The product's released BOM of the organization at the date: its MAIN method, else its only one (as Production.js chooses
// for create#ProductionOrder); null with none; several is an exception.
function bomOf(productId, organizationPartyId, date) {
    const released = rows(BOM, {productId, organizationPartyId}).filter(bom =>
        rows(DECISION, {methodEntityName: BOM, methodId: bom.productBomId}).some(row => ms(row.fromDate) <= ms(date))
    )
    const main = released.filter(bom => bom.methodCode === "MAIN")
    if (main.length === 1) return main[0]
    if (released.length === 1) return released[0]
    if (released.length) return {ambiguous: true}
    return null
}
// A product's structure at the plan date, once per run: its released BOM, the lead and preparation days, its routing and the
// requirements of one stock unit (stopping at non-phantom sub-assemblies, phantoms blown through), or the error that
// stops its explosion.
function structureOf(ctx, productId) {
    if (ctx.structures.has(productId)) return ctx.structures.get(productId)
    const product = one(PRODUCT, {productId})
    const structure = {product, stockUomId: product?.amountUomId || null, bom: null, requirements: [], error: null}
    ctx.structures.set(productId, structure)
    if (!product || product.productTypeEnumId === "PtPickAssembly") return structure
    const bom = bomOf(productId, ctx.organizationPartyId, ctx.planDate)
    if (bom?.ambiguous) {
        structure.error = {code: "METHOD_AMBIGUOUS", message: "Several released BOMs make " + productId + "; one must be MAIN"}
        return structure
    }
    if (!bom) return structure
    structure.bom = bom
    try {
        const exploded = call("mantle.product.BomServices.get#BomExplosion", {
            productBomId: bom.productBomId,
            asOfDate: ctx.planDate,
            quantity: 1,
            quantityUomId: structure.stockUomId || null
        })
        const findings = Array.from(exploded.findings || [])
        if (findings.length) {
            const cycle = findings.some(row => String(row.message).includes("cycle"))
            structure.error = {
                code: cycle ? "BOM_CYCLE" : "METHOD_INVALID",
                message: findings.map(row => (row.recordId ? row.recordId + ": " : "") + row.message).join("; ")
            }
            return structure
        }
        const header = exploded.productBom || {}
        structure.header = header
        structure.routingWorkEffortId = header.routingWorkEffortId || null
        structure.leadTimeDays = header.leadTimeDays == null ? null : dec(header.leadTimeDays)
        structure.prepareDays = header.prepareDays == null ? null : dec(header.prepareDays)
        structure.requirements = Array.from(exploded.requirements || []).map(row => ({
            productId: row.productId,
            perUnit: dec(row.quantity),
            quantityUomId: row.quantityUomId || null
        }))
    } catch (error) {
        const message = String(error.message || error).replace(/^(Error: )+/, "")
        structure.error = {code: /cycle/i.test(message) ? "BOM_CYCLE" : "METHOD_INVALID", message}
    }
    return structure
}
// The lead days of a make suggestion: the BOM's lead and preparation days, or with the routing basis (PltRouting) its
// routing's standard hours for the quantity, each operation's in work days of its work center (the center's average work
// hours a day over the week from the plan date, by its calendar less holidays; days of 24 hours for a center without a
// calendar, impl-manufacturing P12 and F82), rounded up, and the BOM's preparation days.
function leadDaysOf(ctx, structure, quantity) {
    const prepare = structure.prepareDays || zero()
    if (ctx.policy.leadTimeBasisEnumId === "PltRouting" && structure.routingWorkEffortId) {
        try {
            const released = routings().released(structure.routingWorkEffortId, ctx.planDate)
            if (!ctx.calendar) ctx.calendar = {time: workCalendar(), context: workCalendar().forCall(), dayHours: new Map()}
            const dayHoursOf = facilityId => {
                if (!facilityId) return 24
                if (!ctx.calendar.dayHours.has(facilityId)) {
                    const center = ctx.calendar.time.centerOf(ctx.calendar.context, facilityId, ctx.planDate)
                    const perDay = center ? ctx.calendar.time.workHoursPerDay(ctx.calendar.context, center, ms(ctx.planDate)) : 24
                    ctx.calendar.dayHours.set(facilityId, perDay > 0 ? perDay : 24)
                }
                return ctx.calendar.dayHours.get(facilityId)
            }
            let days = 0
            for (const op of Array.from(released.operations || [])) {
                const batch = dec(op.batchQuantity).compare(0) > 0 ? quantity.divide(dec(op.batchQuantity)) : quantity
                const machine = dec(op.machineSetupTime).add(dec(op.machineRunTime).multiply(batch))
                const labor = dec(op.setupTime).add(dec(op.runTime).multiply(batch))
                const time = machine.compare(0) > 0 ? machine : labor
                const hours = methodPolicy()
                    .convert(time, op.timeUomId || "TF_min", "TF_hr", ctx.planDate)
                    .quantity.toNumber()
                days += hours / dayHoursOf(op.workCenterFacilityId)
            }
            return {lead: toDecimal(Math.max(0, Math.ceil(days - 1e-9))), prepare, basis: "routing"}
        } catch (error) {
            ec.logger.warn("Supply plan: routing lead time of " + structure.routingWorkEffortId + ": " + error.message)
        }
    }
    return {lead: structure.leadTimeDays || zero(), prepare, basis: "entered"}
}
// The organization's current purchase price of a product from another party: the supplier of a buy suggestion.
function supplierOf(ctx, productId) {
    const prices = rows("mantle.product.ProductPrice", {
        productId,
        pricePurposeEnumId: "PppPurchase",
        priceTypeEnumId: "PptCurrent"
    })
        .filter(row => row.vendorPartyId && row.vendorPartyId !== ctx.organizationPartyId && lib.active(row, ctx.planDate))
        .sort((a, b) => dec(a.minQuantity).compare(dec(b.minQuantity)))
    return prices[0]?.vendorPartyId || null
}
function usable(productId, usage, quantity, facilityId) {
    try {
        const check = call("mantle.product.ProductServices.check#ProductUsable", {productId, usage, quantity, facilityId})
        return check.usable ? null : check.reason || check.statusId || "not usable"
    } catch (error) {
        return String(error.message || error)
    }
}

// ===== levels =====
// Each product's level: 0 with no parent, else one more than its deepest parent's, through the products' structures. A
// product met again on its own path is a cycle (an exception of that product; its components are not walked again).
function assignLevels(ctx, productIds) {
    const visit = (productId, level, path) => {
        if (path.includes(productId)) {
            ctx.cycles.add(productId)
            return
        }
        if ((ctx.levels.get(productId) ?? -1) >= level && path.length) return
        ctx.levels.set(productId, Math.max(ctx.levels.get(productId) ?? 0, level))
        if (ctx.levels.size > productLimit) throw new Error("PRODUCT_LIMIT")
        const structure = structureOf(ctx, productId)
        if (structure.error) return
        for (const requirement of structure.requirements)
            visit(requirement.productId, ctx.levels.get(productId) + 1, path.concat(productId))
    }
    for (const productId of productIds) if (!ctx.levels.has(productId)) visit(productId, 0, [])
}

// ===== run#SupplyPlan =====
function runPlan(p) {
    requireAny(["SUPPLY_PLAN_RUN"])
    const scope = scopeOf(p)
    const organizationPartyId = scope.organizationPartyId
    // one run at a time per organization (the current run per facility set is decided under it)
    find("mantle.party.Party", {partyId: organizationPartyId}).forUpdate(true).one()
    const now = ec.user.nowTimestamp
    const planDate = p.planDate || now
    const schedule = one(SCHEDULE, {organizationPartyId})
    const policy = productionPolicy().effective(
        organizationPartyId,
        scope.facilities.length === 1 ? scope.facilities[0].facilityId : null,
        planDate
    ).policy
    const horizonDays = Number(p.horizonDays ?? schedule?.horizonDays ?? policy.planningHorizonDays ?? 90)
    if (!Number.isFinite(horizonDays) || horizonDays < 1 || horizonDays > 730)
        denied("PLAN_INVALID", "The horizon is from 1 to 730 days")
    const ctx = {
        organizationPartyId,
        planDate,
        horizonMs: ms(planDate) + horizonDays * dayMs,
        timeFenceDays: Number(policy.timeFenceDays || 0),
        policy,
        netHeld: schedule?.netHeldQuantity === "Y",
        structures: new Map(),
        levels: new Map(),
        cycles: new Set(),
        findings: []
    }
    const productScope = listOf(p.productIds).concat(listOf(p.productId))
    const nodes = scope.facilities.map(facility => ({
        facilityId: facility.facilityId,
        facilityName: facilityName(facility),
        facilityIds: facilityTree(facility)
    }))
    for (const node of nodes) {
        node.sales = salesDemand(ctx, node)
        node.runs = runRows(ctx, node)
        node.minimum = minimumStock(ctx, node)
        node.transfers = transferRows(ctx, node)
    }
    // the products with demand (or the scope given), and every component below them
    let productIds = productScope.length
        ? productScope
        : Array.from(
              new Set(
                  nodes.flatMap(node => [
                      ...node.sales.keys(),
                      ...Array.from(node.runs.entries())
                          .filter(([, lines]) => lines.some(line => line.netted && !line.supply))
                          .map(([productId]) => productId),
                      ...node.minimum.keys()
                  ])
              )
          )
    productIds = productIds.filter(productId => !!one(PRODUCT, {productId})).sort()
    try {
        assignLevels(ctx, productIds)
    } catch (error) {
        if (String(error.message) !== "PRODUCT_LIMIT") throw error
        ctx.findings.push({code: "PRODUCT_LIMIT", message: "The plan reads at most " + productLimit + " products; narrow it"})
    }
    // the previous current run of the set: superseded, its open suggestions ended and their requirements kept for reuse
    const previous = Array.from(
        find(RUN, {organizationPartyId, facilitySetKey: scope.setKey, isCurrent: "Y"}).forUpdate(true).list()
    )
    const revision = find(RUN, {organizationPartyId, facilitySetKey: scope.setKey}).count() + 1
    const planningRunId = call("create#" + RUN, {
        organizationPartyId,
        facilitySetKey: scope.setKey,
        productScope: productScope.length ? productScope.join(",") : null,
        planDate,
        horizonDate: new Date(ctx.horizonMs),
        horizonDays,
        timeFenceDays: ctx.timeFenceDays,
        freshnessLimitHours: Number(policy.freshnessLimitHours ?? 24),
        netHeldQuantity: ctx.netHeld ? "Y" : "N",
        isCurrent: "Y",
        revision,
        scheduled: p.scheduled ? "Y" : "N",
        startedByUserId: ec.user.userId,
        startedDate: now
    }).planningRunId
    for (const node of nodes) call("create#" + RUN_FACILITY, {planningRunId, facilityId: node.facilityId})
    const reusable = new Map()
    for (const old of previous) {
        call("update#" + RUN, {
            planningRunId: old.planningRunId,
            isCurrent: "N",
            supersededByRunId: planningRunId,
            supersededDate: now
        })
        for (const suggestion of Array.from(
            find(SUGGESTION, {planningRunId: old.planningRunId}).condition("stateEnumId", "in", openSuggestionStates).list()
        )) {
            call("update#" + SUGGESTION, {planningSuggestionId: suggestion.planningSuggestionId, stateEnumId: "PssSuperseded"})
            const requirement = suggestion.requirementId ? one(REQUIREMENT, {requirementId: suggestion.requirementId}) : null
            if (requirement?.statusId === "RqmtStProposed" && coveredOf(requirement.requirementId).compare(0) === 0)
                reusable.set(suggestion.facilityId + "|" + suggestion.productId, requirement)
        }
    }
    // net each product once, after all its parents, at each facility of the set
    const suggestions = plan(ctx, nodes)
    let exceptionCount = 0
    for (const suggestion of suggestions) {
        try {
            writeSuggestion(ctx, planningRunId, suggestion, reusable)
            if (suggestion.exceptionCode) exceptionCount++
        } catch (error) {
            ec.logger.error("Supply plan " + planningRunId + ": suggestion for " + suggestion.productId + " failed: " + error)
            ctx.findings.push({
                code: "SUGGESTION_FAILED",
                productId: suggestion.productId,
                message: String(error.message || error)
            })
        }
    }
    // requirements of the last run no new suggestion took: no longer required
    for (const requirement of reusable.values())
        call("update#" + REQUIREMENT, {
            requirementId: requirement.requirementId,
            statusId: "RqmtStRejected",
            reason: "No longer required by supply plan " + planningRunId
        })
    call("update#" + RUN, {
        planningRunId,
        completedDate: ec.user.nowTimestamp,
        suggestionCount: suggestions.length,
        exceptionCount,
        findingsJson: ctx.findings.length ? JSON.stringify(ctx.findings) : null
    })
    if (schedule)
        call("update#" + SCHEDULE, {
            organizationPartyId,
            lastRunDate: now,
            lastPlanningRunId: planningRunId,
            lastRunMessage: null
        })
    return {planningRunId, suggestionCount: suggestions.length, exceptionCount, findings: ctx.findings}
}
// The netting, level by level: for each product and facility its demand over the horizon (sales, a run's material, the
// minimum stock, and the planned makes of its parents) less its stock and open supply; a shortage is first met by a
// transfer from another facility of the set with a surplus, then made or bought.
function plan(ctx, nodes) {
    const out = []
    const dependent = new Map()
    const maxLevel = Math.max(-1, ...ctx.levels.values())
    for (let level = 0; level <= maxLevel; level++) {
        const products = Array.from(ctx.levels.entries())
            .filter(([, productLevel]) => productLevel === level)
            .map(([productId]) => productId)
            .sort()
        for (const productId of products) {
            const structure = structureOf(ctx, productId)
            const lead = structure.bom && !structure.error ? leadDaysOf(ctx, structure, toDecimal(1)) : null
            const nets = nodes.map(node => {
                const lines = []
                for (const line of node.sales.get(productId) || []) lines.push(Object.assign({netted: true}, line))
                for (const line of node.runs.get(productId) || []) lines.push(line)
                for (const line of node.minimum.get(productId) || []) lines.push(Object.assign({netted: true}, line))
                for (const line of dependent.get(node.facilityId + "|" + productId) || []) lines.push(line)
                const heldWithin = ctx.planDate && lead ? ms(ctx.planDate) + dec(lead.lead).toNumber() * dayMs : ms(ctx.planDate)
                for (const line of stockLines(ctx, node, productId)) {
                    if (line.kind === "held") line.netted = ctx.netHeld && line.date != null && ms(line.date) <= heldWithin
                    else line.netted = true
                    lines.push(line)
                }
                // demand beyond the horizon waits for a later run
                for (const line of lines)
                    if (!line.supply && line.date != null && ms(line.date) > ctx.horizonMs) {
                        line.netted = false
                        line.beyondHorizon = true
                    }
                const gross = lines
                    .filter(line => line.netted && !line.supply)
                    .reduce((total, line) => total.add(line.quantity), zero())
                const available = lines
                    .filter(line => line.netted && line.supply)
                    .reduce((total, line) => total.add(line.quantity), zero())
                const held = lines.filter(line => line.kind === "held" && !line.netted)
                const dates = lines
                    .filter(line => line.netted && !line.supply && line.date != null)
                    .map(line => ms(line.date))
                    .sort((a, b) => a - b)
                return {
                    node,
                    lines,
                    gross,
                    available,
                    net: gross.subtract(available),
                    requiredMs: dates.length ? dates[0] : ms(ctx.planDate),
                    pending: held.reduce((total, line) => total.add(line.quantity), zero()),
                    pendingDate:
                        held
                            .map(line => line.date)
                            .filter(Boolean)
                            .sort((a, b) => ms(a) - ms(b))[0] || null
                }
            })
            // transfers: a shortage met from the surplus of another facility of the set
            const surplus = nets.filter(row => row.net.compare(0) < 0).map(row => ({row, left: row.net.negate()}))
            for (const row of nets.filter(each => each.net.compare(0) > 0)) {
                for (const source of surplus) {
                    if (row.net.compare(0) <= 0) break
                    if (source.left.compare(0) <= 0) continue
                    const moved = row.net.compare(source.left) < 0 ? row.net : source.left
                    source.left = source.left.subtract(moved)
                    row.net = row.net.subtract(moved)
                    out.push(
                        suggestionOf(ctx, row, productId, level, structure, {
                            methodEnumId: "PsmTransfer",
                            quantity: moved,
                            sourceFacilityId: source.row.node.facilityId
                        })
                    )
                }
            }
            for (const row of nets.filter(each => each.net.compare(0) > 0)) {
                const suggestion = suggestionOf(ctx, row, productId, level, structure, {quantity: row.net})
                out.push(suggestion)
                // a make suggestion's components are demand of their level, due at its release
                if (suggestion.methodEnumId === "PsmMake" && !suggestion.exceptionCode)
                    for (const requirement of structure.requirements) {
                        const key = row.node.facilityId + "|" + requirement.productId
                        if (!dependent.has(key)) dependent.set(key, [])
                        dependent.get(key).push({
                            kind: "planned",
                            label: "Planned make of " + productId,
                            parent: suggestion,
                            date: suggestion.releaseMs,
                            quantity: requirement.perUnit.multiply(suggestion.quantity),
                            netted: true
                        })
                    }
            }
        }
    }
    return out
}
// A suggestion of a product at a facility: a transfer as given; otherwise make with a released BOM, else buy from a
// supplier with a purchase price, else no source; each checked usable, with its dates and warnings.
function suggestionOf(ctx, row, productId, level, structure, given) {
    const quantity = given.quantity
    const requiredMs = row.requiredMs
    const suggestion = {
        productId,
        facilityId: row.node.facilityId,
        planningLevel: level,
        quantity,
        quantityUomId: structure.stockUomId,
        grossQuantity: row.gross,
        availableQuantity: row.available,
        pendingReleaseQuantity: row.pending,
        pendingReleaseDate: row.pendingDate,
        requiredMs,
        releaseMs: requiredMs,
        lines: row.lines,
        warnings: [],
        parent: row.lines.find(line => line.parent)?.parent || null
    }
    const exception = (code, message) => Object.assign(suggestion, {exceptionCode: code, exceptionMessage: message})
    if (given.methodEnumId === "PsmTransfer") {
        Object.assign(suggestion, {methodEnumId: "PsmTransfer", sourceFacilityId: given.sourceFacilityId})
        const reason = usable(productId, "Replenish", quantity, row.node.facilityId)
        if (reason) exception("PRODUCT_NOT_USABLE", productId + ": " + reason)
        return suggestion
    }
    if (ctx.cycles.has(productId)) {
        suggestion.methodEnumId = structure.bom ? "PsmMake" : null
        return exception("BOM_CYCLE", "The methods of " + productId + " lead back to it")
    }
    if (structure.error) {
        suggestion.methodEnumId = "PsmMake"
        return exception(structure.error.code, structure.error.message)
    }
    if (structure.bom) {
        const lead = leadDaysOf(ctx, structure, quantity)
        const releaseMs = requiredMs - lead.lead.add(lead.prepare).toNumber() * dayMs
        Object.assign(suggestion, {
            methodEnumId: "PsmMake",
            productBomId: structure.bom.productBomId,
            routingWorkEffortId: structure.routingWorkEffortId,
            leadTimeDays: lead.lead,
            prepareDays: lead.prepare,
            releaseMs
        })
        const reason = usable(productId, "Produce", quantity, row.node.facilityId)
        if (reason) return exception("PRODUCT_NOT_USABLE", productId + " cannot be produced: " + reason)
    } else {
        const supplierPartyId = supplierOf(ctx, productId)
        if (!supplierPartyId) {
            suggestion.methodEnumId = null
            return exception("NO_SOURCE", productId + " has no released BOM and no supplier price")
        }
        Object.assign(suggestion, {methodEnumId: "PsmBuy", supplierPartyId})
        const reason = usable(productId, "Purchase", quantity, row.node.facilityId)
        if (reason) return exception("PRODUCT_NOT_USABLE", productId + " cannot be bought: " + reason)
    }
    const releaseMs = suggestion.releaseMs
    if (releaseMs < ms(ctx.planDate)) suggestion.warnings.push("LATE_RELEASE")
    else if (releaseMs < ms(ctx.planDate) + ctx.timeFenceDays * dayMs) suggestion.warnings.push("INSIDE_TIME_FENCE")
    return suggestion
}
// The suggestion's records: its requirement (the last run's for the same facility and product when it is still only
// proposed, else a new one of the organization in the stock unit, with the sales order lines it covers), and the
// suggestion with its provenance.
function writeSuggestion(ctx, planningRunId, suggestion, reusable) {
    const key = suggestion.facilityId + "|" + suggestion.productId
    const fields = {
        requirementTypeEnumId: "RqTpInventory",
        facilityId: suggestion.facilityId,
        productId: suggestion.productId,
        quantity: suggestion.quantity,
        quantityUomId: suggestion.quantityUomId,
        requiredByDate: new Date(suggestion.requiredMs),
        requirementStartDate: new Date(suggestion.releaseMs),
        description:
            enumText(suggestion.methodEnumId || "PsmMake") + " " + text(suggestion.quantity) + " of " + suggestion.productId
    }
    let requirementId
    const kept = suggestion.methodEnumId !== "PsmTransfer" ? reusable.get(key) : null
    if (kept) {
        reusable.delete(key)
        requirementId = kept.requirementId
        call("update#" + REQUIREMENT, Object.assign({requirementId}, fields))
    } else {
        requirementId = call("create#" + REQUIREMENT, Object.assign({statusId: "RqmtStProposed"}, fields)).requirementId
        call("create#" + REQUIREMENT_PARTY, {
            requirementId,
            partyId: ctx.organizationPartyId,
            roleTypeId: "OrgInternal",
            fromDate: ec.user.nowTimestamp
        })
    }
    for (const line of suggestion.lines.filter(each => each.netted && each.orderId && !each.supply))
        if (
            !one("mantle.request.requirement.RequirementOrderItem", {
                requirementId,
                orderId: line.orderId,
                orderItemSeqId: line.orderItemSeqId
            })
        )
            call("create#mantle.request.requirement.RequirementOrderItem", {
                requirementId,
                orderId: line.orderId,
                orderItemSeqId: line.orderItemSeqId,
                quantity: line.quantity
            })
    const provenance = suggestion.lines.map(line => ({
        kind: line.kind,
        label: line.label,
        supply: !!line.supply,
        netted: !!line.netted,
        beyondHorizon: !!line.beyondHorizon,
        date: line.date == null ? null : ms(line.date),
        quantity: text(line.quantity),
        orderId: line.orderId || null,
        orderItemSeqId: line.orderItemSeqId || null,
        workEffortId: line.workEffortId || null,
        assetId: line.assetId || null,
        qualityInspectionId: line.qualityInspectionId || null,
        parentProductId: line.parent?.productId || null
    }))
    suggestion.planningSuggestionId = call("create#" + SUGGESTION, {
        planningRunId,
        requirementId,
        productId: suggestion.productId,
        facilityId: suggestion.facilityId,
        methodEnumId: suggestion.methodEnumId || null,
        stateEnumId: suggestion.exceptionCode ? "PssException" : "PssProposed",
        quantity: suggestion.quantity,
        quantityUomId: suggestion.quantityUomId,
        grossQuantity: suggestion.grossQuantity,
        availableQuantity: suggestion.availableQuantity,
        pendingReleaseQuantity: suggestion.pendingReleaseQuantity,
        pendingReleaseDate: suggestion.pendingReleaseDate,
        requiredByDate: new Date(suggestion.requiredMs),
        releaseDate: new Date(suggestion.releaseMs),
        leadTimeDays: suggestion.leadTimeDays ?? null,
        prepareDays: suggestion.prepareDays ?? null,
        planningLevel: suggestion.planningLevel,
        parentSuggestionId: suggestion.parent?.planningSuggestionId || null,
        productBomId: suggestion.productBomId || null,
        routingWorkEffortId: suggestion.routingWorkEffortId || null,
        supplierPartyId: suggestion.supplierPartyId || null,
        sourceFacilityId: suggestion.sourceFacilityId || null,
        exceptionCode: suggestion.exceptionCode || null,
        exceptionMessage: suggestion.exceptionMessage || null,
        warningCodes: suggestion.warnings.length ? suggestion.warnings.join(",") : null,
        provenanceJson: JSON.stringify(provenance)
    }).planningSuggestionId
    suggestion.requirementId = requirementId
}

// ===== reads =====
// The quantity of a requirement its active supply links cover.
function coveredOf(requirementId) {
    return rows(SUPPLY, {requirementId})
        .filter(row => !row.thruDate || ms(row.thruDate) > ms(ec.user.nowTimestamp))
        .reduce((total, row) => total.add(dec(row.quantity)), zero())
}
// Whether a run is stale: superseded by a later run of its set, or older than its freshness limit.
function staleOf(run) {
    if (run.isCurrent !== "Y") return {stale: true, reason: "A later plan replaced this one"}
    const limit = Number(run.freshnessLimitHours ?? 24)
    if (ms(ec.user.nowTimestamp) - ms(run.completedDate || run.startedDate) > limit * 3600000)
        return {stale: true, reason: "The plan is older than " + limit + (limit === 1 ? " hour" : " hours")}
    return {stale: false, reason: null}
}
function ageText(run) {
    const minutes = Math.max(0, Math.round((ms(ec.user.nowTimestamp) - ms(run.completedDate || run.startedDate)) / 60000))
    if (minutes < 60) return minutes + (minutes === 1 ? " minute" : " minutes") + " ago"
    const hours = Math.round(minutes / 60)
    if (hours < 48) return hours + (hours === 1 ? " hour" : " hours") + " ago"
    return Math.round(hours / 24) + " days ago"
}
const kindLabels = {
    stock: "On hand",
    held: "Held for inspection",
    purchase: "Purchase order",
    sales: "Sales order",
    kitSales: "Kit on sales order",
    runMaterial: "Work order material",
    runOutput: "Work order output",
    kitMaterial: "Kit assembly material",
    kitOutput: "Kit assembly output",
    transfer: "Transfer in transit",
    minimum: "Minimum stock",
    planned: "Planned make"
}
const warningLabels = {LATE_RELEASE: "Release date has passed", INSIDE_TIME_FENCE: "Inside the time fence"}
// A suggestion for a screen: names, texts, its covered quantity and links, and whether the user may convert it now.
function suggestionRow(row, run, stale, names) {
    const covered = row.requirementId ? coveredOf(row.requirementId) : zero()
    const remaining = dec(row.quantity).subtract(covered)
    const product = names.product(row.productId)
    const permission = convertPermissions[row.methodEnumId]
    const supplies = row.requirementId
        ? rows(SUPPLY, {requirementId: row.requirementId}).map(supply => ({
              requirementSupplyId: supply.requirementSupplyId,
              supplyTypeText: enumText(supply.supplyTypeEnumId),
              workEffortId: supply.workEffortId || null,
              orderId: supply.orderId || null,
              quantity: text(supply.quantity),
              ended: !!supply.thruDate
          }))
        : []
    const warnings = listOf(row.warningCodes)
    return {
        planningSuggestionId: row.planningSuggestionId,
        planningRunId: row.planningRunId,
        requirementId: row.requirementId,
        productId: row.productId,
        pseudoId: product?.pseudoId || row.productId,
        productName: product?.productName || row.productId,
        facilityId: row.facilityId,
        facilityName: names.facility(row.facilityId),
        methodEnumId: row.methodEnumId || null,
        methodText: row.methodEnumId ? enumText(row.methodEnumId) : "No source",
        stateEnumId: row.stateEnumId,
        stateText: enumText(row.stateEnumId),
        quantity: text(row.quantity),
        quantityUomId: row.quantityUomId || null,
        uomText: row.quantityUomId ? one("moqui.basic.Uom", {uomId: row.quantityUomId})?.abbreviation || row.quantityUomId : "",
        coveredQuantity: text(covered),
        remainingQuantity: text(remaining.compare(0) > 0 ? remaining : zero()),
        grossQuantity: text(row.grossQuantity),
        availableQuantity: text(row.availableQuantity),
        pendingReleaseQuantity: dec(row.pendingReleaseQuantity).compare(0) > 0 ? text(row.pendingReleaseQuantity) : null,
        pendingReleaseDateText: dateText(row.pendingReleaseDate),
        requiredByDate: row.requiredByDate,
        requiredByText: dateText(row.requiredByDate),
        releaseDate: row.releaseDate,
        releaseText: dateText(row.releaseDate),
        leadTimeDays: text(row.leadTimeDays),
        prepareDays: text(row.prepareDays),
        planningLevel: row.planningLevel,
        productBomId: row.productBomId || null,
        supplierPartyId: row.supplierPartyId || null,
        supplierName: row.supplierPartyId ? names.party(row.supplierPartyId) : null,
        sourceFacilityId: row.sourceFacilityId || null,
        sourceFacilityName: row.sourceFacilityId ? names.facility(row.sourceFacilityId) : null,
        sourceText: row.supplierPartyId
            ? names.party(row.supplierPartyId)
            : row.sourceFacilityId
              ? "From " + names.facility(row.sourceFacilityId)
              : row.productBomId
                ? "BOM " + row.productBomId
                : "",
        exceptionCode: row.exceptionCode || null,
        exceptionMessage: row.exceptionMessage || null,
        warningText: warnings.map(code => warningLabels[code] || code).join(", "),
        stateColor: row.exceptionCode
            ? "negative"
            : row.stateEnumId === "PssConverted"
              ? "positive"
              : row.stateEnumId === "PssSuperseded"
                ? "grey"
                : warnings.length
                  ? "warning"
                  : "primary",
        supplies,
        canConvert:
            !stale &&
            !!permission &&
            access.has(permission) &&
            !row.exceptionCode &&
            row.stateEnumId !== "PssSuperseded" &&
            remaining.compare(0) > 0
    }
}
// Display names read once per call.
function nameCache() {
    const products = new Map(),
        facilities = new Map(),
        parties = new Map()
    return {
        product: productId => {
            if (!products.has(productId)) products.set(productId, one(PRODUCT, {productId}))
            return products.get(productId)
        },
        facility: facilityId => {
            if (!facilities.has(facilityId)) facilities.set(facilityId, facilityName(one(FACILITY, {facilityId})))
            return facilities.get(facilityId)
        },
        party: partyId => {
            if (!parties.has(partyId)) parties.set(partyId, lib.partyNames([partyId])[partyId] || partyId)
            return parties.get(partyId)
        }
    }
}
// The run of a request: the one given (of the user's organizations), else the current run of the scope's facility set.
function runOf(p) {
    if (!blank(p.planningRunId)) {
        const run = one(RUN, {planningRunId: p.planningRunId})
        const userScope = facilityScope.scope()
        if (!run || !facilityScope.owns(userScope, run.organizationPartyId))
            denied("RECORD_UNAVAILABLE", "Supply plan " + p.planningRunId + " is not available")
        return run
    }
    const scope = scopeOf(p)
    return (
        Array.from(
            find(RUN, {organizationPartyId: scope.organizationPartyId, facilitySetKey: scope.setKey, isCurrent: "Y"})
                .orderBy("-startedDate")
                .limit(1)
                .list()
        )[0] || null
    )
}
function scheduleRow(organizationPartyId) {
    const row = one(SCHEDULE, {organizationPartyId})
    if (!row) return {organizationPartyId, exists: false, active: "N", netHeldQuantity: "N", facilityIds: [], intervalHours: 24}
    return {
        organizationPartyId,
        exists: true,
        facilityIds: listOf(row.facilityIds),
        intervalHours: row.intervalHours,
        nextRunDate: row.nextRunDate,
        nextRunText: dateText(row.nextRunDate),
        horizonDays: row.horizonDays,
        active: row.active || "N",
        netHeldQuantity: row.netHeldQuantity || "N",
        lastRunText: dateText(row.lastRunDate),
        lastPlanningRunId: row.lastPlanningRunId || null,
        lastRunMessage: row.lastRunMessage || null,
        changeReason: row.changeReason || null
    }
}
// get#SupplyPlan: the run (the given or current one) with its freshness, its suggestions filtered by method, product or
// state, the held lines pending release, a product's demand and supply, and the schedule.
function getPlan(p) {
    requireAny(readPermissions)
    const run = runOf(p)
    const scope = run ? null : scopeOf(p)
    const organizationPartyId = run?.organizationPartyId || scope.organizationPartyId
    const names = nameCache()
    const facilityIds = run
        ? rows(RUN_FACILITY, {planningRunId: run.planningRunId}).map(row => row.facilityId)
        : scope.facilities.map(row => row.facilityId)
    const answer = {
        organizationPartyId,
        organizationName: names.party(organizationPartyId),
        facilityIds,
        facilityNames: facilityIds.map(names.facility).join(", "),
        run: null,
        suggestions: [],
        pendingRelease: [],
        demandSupply: [],
        schedule: scheduleRow(organizationPartyId),
        canRun: access.has("SUPPLY_PLAN_RUN"),
        canSchedule: access.has("SUPPLY_PLAN_RUN"),
        canConvertMake: access.has(convertPermissions.PsmMake)
    }
    if (!run) return answer
    const stale = staleOf(run)
    answer.run = {
        planningRunId: run.planningRunId,
        revision: run.revision,
        planDateText: dateText(run.planDate),
        horizonText: dateText(run.horizonDate),
        horizonDays: run.horizonDays,
        timeFenceDays: run.timeFenceDays,
        netHeldQuantity: run.netHeldQuantity,
        completedText: dateText(run.completedDate),
        ageText: ageText(run),
        startedByName: run.startedByUserId
            ? one("moqui.security.UserAccount", {userId: run.startedByUserId})?.userFullName || run.startedByUserId
            : "",
        scheduled: run.scheduled === "Y",
        isCurrent: run.isCurrent === "Y",
        stale: stale.stale,
        staleReason: stale.reason,
        suggestionCount: run.suggestionCount,
        exceptionCount: run.exceptionCount,
        findings: lib.json(run.findingsJson, [])
    }
    let query = find(SUGGESTION, {planningRunId: run.planningRunId})
    if (!blank(p.methodEnumId)) query = query.condition("methodEnumId", p.methodEnumId)
    if (!blank(p.productId)) query = query.condition("productId", p.productId)
    if (p.exceptionsOnly === true || p.exceptionsOnly === "true" || p.exceptionsOnly === "Y")
        query = query.condition("exceptionCode", "is-not-null", null)
    const suggestionRows = Array.from(
        query.orderBy("planningLevel").orderBy("releaseDate").orderBy("productId").limit(1000).list()
    )
    answer.suggestions = suggestionRows.map(row => suggestionRow(row, run, stale.stale, names))
    for (const row of suggestionRows)
        for (const line of lib.json(row.provenanceJson, []).filter(each => each.kind === "held"))
            answer.pendingRelease.push({
                productId: row.productId,
                productName: names.product(row.productId)?.productName || row.productId,
                facilityName: names.facility(row.facilityId),
                quantity: line.quantity,
                dueText: line.date == null ? "No inspection due date" : dateText(line.date),
                qualityInspectionId: line.qualityInspectionId,
                assetId: line.assetId,
                nettedText: line.netted ? "Netted" : "Not netted"
            })
    const selected = blank(p.planningSuggestionId)
        ? null
        : suggestionRows.find(row => row.planningSuggestionId === p.planningSuggestionId) ||
          one(SUGGESTION, {planningSuggestionId: p.planningSuggestionId, planningRunId: run.planningRunId})
    if (selected) {
        answer.selected = suggestionRow(selected, run, stale.stale, names)
        answer.demandSupply = lib.json(selected.provenanceJson, []).map(line => ({
            kindText: kindLabels[line.kind] || line.kind,
            label: line.label,
            directionText: line.supply ? "Supply" : "Demand",
            dateText: line.date == null ? "" : dateText(line.date),
            quantity: line.quantity,
            nettedText: line.netted ? "Netted" : line.beyondHorizon ? "Beyond the horizon" : "Not netted",
            orderId: line.orderId,
            workEffortId: line.workEffortId,
            qualityInspectionId: line.qualityInspectionId
        }))
    }
    return answer
}

// ===== store#PlanSchedule =====
function storeSchedule(p) {
    requireAny(["SUPPLY_PLAN_RUN"])
    const scope = scopeOf(p)
    const organizationPartyId = scope.organizationPartyId
    find("mantle.party.Party", {partyId: organizationPartyId}).forUpdate(true).one()
    const intervalHours = Number(p.intervalHours ?? 24)
    if (!Number.isInteger(intervalHours) || intervalHours < 1 || intervalHours > 24 * 31)
        denied("SCHEDULE_INVALID", "Run the plan every 1 to 744 hours")
    const horizonDays = blank(p.horizonDays) ? null : Number(p.horizonDays)
    if (horizonDays != null && (!Number.isInteger(horizonDays) || horizonDays < 1 || horizonDays > 730))
        denied("SCHEDULE_INVALID", "The horizon is from 1 to 730 days")
    const indicator = (value, fallback) =>
        value == null || value === "" ? fallback : value === true || value === "Y" ? "Y" : "N"
    const existing = one(SCHEDULE, {organizationPartyId})
    const fields = {
        organizationPartyId,
        facilityIds: scope.setKey,
        intervalHours,
        nextRunDate: p.nextRunDate || existing?.nextRunDate || ec.user.nowTimestamp,
        horizonDays,
        active: indicator(p.active, existing?.active || "N"),
        netHeldQuantity: indicator(p.netHeldQuantity, existing?.netHeldQuantity || "N"),
        changedByUserId: ec.user.userId,
        changeReason: str(p.changeReason)
    }
    call((existing ? "update#" : "create#") + SCHEDULE, fields)
    return {schedule: scheduleRow(organizationPartyId)}
}
// The scheduled run (the run_ScheduledSupplyPlans job): each active schedule that is due runs as the user who last kept it, with
// that user's permissions and organizations; one that fails is logged and named on its schedule and the others go on.
function runScheduled() {
    const now = ec.user.nowTimestamp
    const due = Array.from(find(SCHEDULE, {active: "Y"}).condition("nextRunDate", "less-equals", now).list())
    const results = []
    const previousUsername = ec.user.username
    for (const schedule of due) {
        let message = null
        try {
            const account = schedule.changedByUserId
                ? one("moqui.security.UserAccount", {userId: schedule.changedByUserId})
                : null
            // the login gate refuses a disabled or terminated account; its error is kept off this job's messages, so the
            // schedule is named and the others go on
            ec.message.pushErrors()
            let loggedIn = false
            try {
                loggedIn = !!account && ec.user.internalLoginUser(account.username) === true
            } finally {
                ec.message.clearErrors()
                ec.message.popErrors()
            }
            if (!loggedIn) throw new Error("SCHEDULE_USER_UNAVAILABLE: the user who kept the schedule cannot sign in")
            const out = probe("mantle.product.SupplyPlanningServices.run#SupplyPlan", {
                organizationPartyId: schedule.organizationPartyId,
                facilityIds: listOf(schedule.facilityIds),
                scheduled: true
            })
            results.push({organizationPartyId: schedule.organizationPartyId, planningRunId: out.planningRunId})
        } catch (error) {
            message = String(error.message || error).replace(/^(Error: )+/, "")
            ec.logger.error("Scheduled supply plan of " + schedule.organizationPartyId + " failed: " + message)
            results.push({organizationPartyId: schedule.organizationPartyId, error: message})
        }
        const disabled = ec.artifactExecution.disableAuthz()
        try {
            call("update#" + SCHEDULE, {
                organizationPartyId: schedule.organizationPartyId,
                nextRunDate: new Date(ms(now) + Number(schedule.intervalHours || 24) * 3600000),
                lastRunMessage: message
            })
        } finally {
            if (!disabled) ec.artifactExecution.enableAuthz()
        }
    }
    // back to the job's own user, or none: a schedule's user never outlives its run
    ec.message.pushErrors()
    try {
        if (previousUsername) ec.user.internalLoginUser(previousUsername)
        else if (ec.user.userId) ec.user.logoutUser()
    } finally {
        ec.message.clearErrors()
        ec.message.popErrors()
    }
    return {results}
}

// ===== convert#PlanningSuggestions =====
// Each suggestion is a group on its own, in its own transaction (convert#PlanningSuggestion), so one that fails is named
// and the others go on; a retry with the same operation key answers each group's first result.
function convert(p) {
    requireAny(Object.values(convertPermissions))
    const ids = listOf(p.planningSuggestionIds).concat(listOf(p.planningSuggestionId))
    if (!ids.length) denied("SUGGESTION_REQUIRED", "Choose the suggestions to convert")
    const operationKey = str(p.operationKey)
    if (!operationKey) denied("OPERATION_KEY_REQUIRED", "An operation key is required")
    const results = []
    for (const planningSuggestionId of ids) {
        try {
            const out = probe("mantle.product.SupplyPlanningServices.convert#PlanningSuggestion", {
                planningSuggestionId,
                operationKey: operationKey + "/" + planningSuggestionId,
                methodDate: p.methodDate || null,
                facilityId: str(p.facilityId)
            })
            results.push(Object.assign({planningSuggestionId, ok: true}, out.result))
        } catch (error) {
            const message = String(error.message || error).replace(/^(Error: )+/, "")
            ec.logger.warn("Supply plan conversion of " + planningSuggestionId + " failed: " + message)
            results.push({planningSuggestionId, ok: false, reasonCode: lib.reasonCode({message}) || reasonIn(message), message})
        }
    }
    return {
        results,
        createdCount: results.filter(row => row.ok && row.resultCode === "CREATED").length,
        existingCount: results.filter(row => row.ok && row.resultCode === "EXISTING").length,
        failedCount: results.filter(row => !row.ok).length
    }
}
function reasonIn(message) {
    const match = /(?:^|[\s:])([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+):/.exec(message)
    return match ? match[1] : "FAILED"
}
// One make suggestion: the run current and fresh, the suggestion convertible, its requirement locked; covered already, the
// existing run is the answer; otherwise a draft run for the remaining quantity, with its supply links.
function convertOne(p) {
    const suggestion = one(SUGGESTION, {planningSuggestionId: p.planningSuggestionId})
    const run = suggestion ? one(RUN, {planningRunId: suggestion.planningRunId}) : null
    const userScope = facilityScope.scope()
    if (!suggestion || !run || !facilityScope.owns(userScope, run.organizationPartyId))
        denied("RECORD_UNAVAILABLE", "Suggestion " + (p.planningSuggestionId || "") + " is not available")
    const permission = convertPermissions[suggestion.methodEnumId]
    if (!permission)
        denied(
            "METHOD_NOT_CONVERTED",
            enumText(suggestion.methodEnumId || "PsmBuy") + " suggestions are converted where their supply is kept"
        )
    if (!access.has(permission)) denied("PERMISSION_DENIED", permission + " is required")
    const requirement = find(REQUIREMENT, {requirementId: suggestion.requirementId}).forUpdate(true).one()
    if (!requirement) denied("RECORD_UNAVAILABLE", "The suggestion's requirement is not available")
    // a covered requirement answers its supply, whichever plan or user covered it
    const covered = coveredOf(requirement.requirementId)
    const remaining = dec(requirement.quantity).subtract(covered)
    const links = rows(SUPPLY, {requirementId: requirement.requirementId}).filter(row => !row.thruDate)
    if (remaining.compare(0) <= 0 && links.length)
        return {
            resultCode: "EXISTING",
            requirementId: requirement.requirementId,
            workEffortId: links[0].workEffortId || null,
            workEffortIds: links.map(row => row.workEffortId).filter(Boolean)
        }
    const stale = staleOf(run)
    if (stale.stale) denied("PLAN_STALE", stale.reason + "; recalculate the plan")
    if (suggestion.exceptionCode) denied("SUGGESTION_EXCEPTION", suggestion.exceptionMessage || "The suggestion has an exception")
    if (!["PssProposed", "PssPartial"].includes(suggestion.stateEnumId))
        denied("SUGGESTION_CLOSED", "The suggestion is " + enumText(suggestion.stateEnumId))
    const reason = usable(suggestion.productId, "Produce", remaining, suggestion.facilityId)
    if (reason) denied("PRODUCT_NOT_USABLE", suggestion.productId + " cannot be produced: " + reason)
    const facilityId = str(p.facilityId) || runFacilityOf(suggestion, run)
    const created = call("mantle.work.ProductionServices.create#ProductionOrder", {
        operationKey: p.operationKey,
        organizationPartyId: run.organizationPartyId,
        productId: suggestion.productId,
        quantity: remaining,
        quantityUomId: suggestion.quantityUomId || null,
        facilityId,
        productBomId: suggestion.productBomId || null,
        methodDate: p.methodDate || run.planDate,
        estimatedStartDate: suggestion.releaseDate,
        estimatedCompletionDate: suggestion.requiredByDate,
        planningSuggestionId: suggestion.planningSuggestionId,
        requirementId: requirement.requirementId,
        ...singleOrderOf(requirement.requirementId)
    })
    const workEffortId = created.workEffortId
    if (!rows(SUPPLY, {requirementId: requirement.requirementId, workEffortId}).length)
        call("create#" + SUPPLY, {
            requirementId: requirement.requirementId,
            supplyTypeEnumId: "RstProductionRun",
            workEffortId,
            quantity: remaining,
            quantityUomId: suggestion.quantityUomId || null,
            planningSuggestionId: suggestion.planningSuggestionId,
            operationKey: p.operationKey,
            fromDate: ec.user.nowTimestamp,
            createdByUserId: ec.user.userId
        })
    if (!one("mantle.request.requirement.WorkRequirementFulfillment", {requirementId: requirement.requirementId, workEffortId}))
        call("create#mantle.request.requirement.WorkRequirementFulfillment", {
            requirementId: requirement.requirementId,
            workEffortId,
            fulfillmentTypeEnumId: "WrfDelivers"
        })
    // the requirement accepted, and ordered once it is covered
    if (["RqmtStProposed", "RqmtStCreated"].includes(requirement.statusId))
        call("update#" + REQUIREMENT, {requirementId: requirement.requirementId, statusId: "RqmtStApproved"})
    call("update#" + REQUIREMENT, {requirementId: requirement.requirementId, statusId: "RqmtStOrdered"})
    call("update#" + SUGGESTION, {planningSuggestionId: suggestion.planningSuggestionId, stateEnumId: "PssConverted"})
    return {
        resultCode: created.existing ? "EXISTING" : "CREATED",
        requirementId: requirement.requirementId,
        workEffortId,
        workEffortIds: [workEffortId],
        quantity: text(remaining),
        facilityId
    }
}
// The facility a make suggestion's run goes on: its routing's last work center when it is under the suggestion's facility,
// else the only work center under it, else the facility itself (a run on a line nets against its warehouse, F16).
function runFacilityOf(suggestion, run) {
    const facility = one(FACILITY, {facilityId: suggestion.facilityId})
    const tree = facility ? facilityTree(facility) : [suggestion.facilityId]
    if (suggestion.routingWorkEffortId)
        try {
            const operations = Array.from(routings().released(suggestion.routingWorkEffortId, run.planDate).operations || [])
                .sort((a, b) => Number(a.sequenceNum || 0) - Number(b.sequenceNum || 0))
                .map(op => op.workCenterFacilityId)
                .filter(Boolean)
            const last = operations[operations.length - 1]
            if (last && tree.includes(last)) return last
        } catch (error) {
            ec.logger.warn("Supply plan: routing of " + suggestion.planningSuggestionId + ": " + error.message)
        }
    const centers = Array.from(
        find("mantle.work.production.WorkCenter").condition("facilityId", "in", tree).selectField("facilityId").list()
    ).map(row => row.facilityId)
    if (centers.length === 1) return centers[0]
    return suggestion.facilityId
}
// The sales order line a requirement covers, when it covers just one (the run's demand link).
function singleOrderOf(requirementId) {
    const items = rows("mantle.request.requirement.RequirementOrderItem", {requirementId})
    return items.length === 1 ? {sourceOrderId: items[0].orderId, orderItemSeqId: items[0].orderItemSeqId} : {}
}

const operations = {runPlan, getPlan, storeSchedule, runScheduled, convert, convertOne}
;({
    readPermissions,
    convertPermissions,
    coveredOf,
    staleOf,
    execute: (op, parameters) => {
        if (!operations[op]) throw new Error("Unknown supply planning operation " + op)
        return operations[op](parameters || {})
    }
})
