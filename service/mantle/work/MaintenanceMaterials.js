// Maintenance parts and stock (IronStone Maintenance design §3 PlannedParts and PartsUsed, §13.2's stock bullet, MT-08; impl-maintenance
// P9, F30, F71): mantle.work.MaintenanceExecutionServices.
//
// - Planned parts are WorkEffortProduct rows (WeptConsume) of the work order's root or a step, with a unit, a required date and
//   a source facility; the row's key (work effort, product, from date) is the line's identity, and a change ends the row and
//   starts the next one, so a node holds one open line a product. Planning is a planner's or supervisor's
//   (MAINTENANCE_PLAN or _SUPERVISE) on open work. Suggested parts are the equipment model's PatSparePart associations not yet
//   planned.
// - An issue is Production's issue (ProductionServices.issue#ProductionMaterial, F71) for a work order: Warehouse's posting guard
//   (StockPosting.js: STOCK_ISSUE, the operation key, the stock locked in a facility of the user's organizations, the period),
//   and the maintenance grant: the technician assigned to the work or the step (MAINTENANCE_EXECUTE) or a supervisor, on
//   approved or started work; then issue#AssetToWorkEffort with authorization disabled, a new AssetIssuance each time to the
//   root or step, carrying the cost centre, the project and the primary AssetMaintenance. Only available stock (inventory or
//   supplies) of the work's organization is issued: supplies post to the maintenance expense as inventory does (AC-24, the
//   user's call of Nov 12, in place of Mantle's fixed-asset posting, F71), and a customer's or another owner's asset is never
//   issued as a spare. An organization that posts needs a maintenance expense
//   mapping first (AC-24: MaintenanceCostRouting.js; COST_POLICY_MISSING), so no issue posts to WIP.
// - A return is a new AssetReceipt naming its issuance (sourceAssetIssuanceId), into the original asset where it is or a
//   location of the same facility at the original asset's acquireCost, never more than is left of the issuance; its credit goes
//   to the issuance's expense and dimensions (AC-24), not to WIP.
// - The read gives the planned lines with what was issued, returned and is left, the issues and returns once each (no root and
//   step double counting), the suggestions and what the caller may do; values only with MAINTENANCE_COST_VIEW. Every list is
//   read in one query each (F96).
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const maintenanceAccess = ec.resource.script("component://mr-mantle/service/mantle/work/MaintenanceAccess.js")
const posting = ec.resource.script("component://mr-mantle/service/mantle/shipment/StockPosting.js")
const routing = ec.resource.script("component://mr-mantle/service/mantle/ledger/MaintenanceCostRouting.js")
const facilityScope = ec.resource.script("component://mr-mantle/service/mantle/facility/FacilityScope.js")
const {find, one, denied, call, ms} = lib

const WORK = "mantle.work.effort.WorkEffort"
const ORDER = "mantle.work.maintenance.MaintenanceWorkOrder"
const LINE = "mantle.work.effort.WorkEffortProduct"
const ISSUANCE = "mantle.product.issuance.AssetIssuance"
const RECEIPT = "mantle.product.receipt.AssetReceipt"
const ASSET = "mantle.product.asset.Asset"
const PRODUCT = "mantle.product.Product"
const FACILITY = "mantle.facility.Facility"

const openStatuses = ["WeInPlanning", "WeApproved", "WeInProgress", "WeOnHold"]
const issueStatuses = ["WeApproved", "WeInProgress"]
const closedStatuses = ["WeClosed", "WeCancelled"]
// the stock a part is issued from: inventory, and supplies (routed to the maintenance expense too, the user's call of Nov 12)
const stockTypes = ["AstTpInventory", "AstTpSupplies"]
const stockOptionLimit = 20

const blank = value => value == null || String(value).trim() === ""
const text = value => (blank(value) ? null : String(value).trim())
const flag = value => value === true || value === "true" || value === "Y"
const dec = value => toDecimal(value ?? 0)
const zero = () => toDecimal(0)
const num = value => (value == null || value === "" ? 0 : Number(String(value)))
const qty = value => (value == null ? null : dec(value).compare(0) === 0 ? "0" : String(dec(value).toNumber()))
const dateText = value => (value == null || value === "" ? "" : lib.dateText(value))
const ids = list => Array.from(new Set(list.filter(Boolean)))
const openAt = (row, at) => (ms(row.fromDate) ?? -Infinity) <= at && (ms(row.thruDate) ?? Infinity) > at
const lineKey = (workEffortId, productId) => workEffortId + "__" + productId
const byId = (entity, field, list, fields = null) => {
    const wanted = ids(list)
    if (!wanted.length) return {}
    let query = find(entity).condition(field, "in", wanted)
    if (fields) query = query.selectFields(fields)
    return Object.fromEntries(Array.from(query.list()).map(row => [row[field], row]))
}

// ===== the work order =====
function signedIn() {
    if (!ec.user.userId) denied("PERMISSION_DENIED", "Sign in to use maintenance work")
}
// A work order or step the caller may read: {node, root, order, organizationPartyId, treeIds}.
function readWork(userScope, workEffortId) {
    const id = text(workEffortId)
    const found = maintenanceAccess.requireWork(userScope, id)
    const order = one(ORDER, {workEffortId: found.rootWorkEffortId})
    const root = one(WORK, {workEffortId: found.rootWorkEffortId})
    if (!order || !root || root.isTemplate === "Y") denied("RECORD_UNAVAILABLE", "Work order " + (id || "") + " is not available")
    const node = id === root.workEffortId ? root : one(WORK, {workEffortId: id})
    return {node, root, order, organizationPartyId: found.organizationPartyId, treeIds: treeIds(root.workEffortId)}
}
function treeIds(rootId) {
    return [rootId].concat(
        Array.from(find(WORK, {rootWorkEffortId: rootId}).selectField("workEffortId").list())
            .map(row => row.workEffortId)
            .filter(id => id !== rootId)
    )
}
// Whether the caller issues and returns for this work: STOCK_ISSUE, and assigned to the root or the node (execute) or a
// supervisor.
function mayExecute(userScope, workEffortId) {
    const caps = userScope.capabilities
    if (caps.supervise) return true
    return !!caps.execute && maintenanceAccess.assignment(userScope, workEffortId).step
}
function requireExecute(userScope, workEffortId) {
    if (!mayExecute(userScope, workEffortId))
        denied("NOT_ASSIGNED", "Parts are issued and returned by the technician assigned to the work or a supervisor")
}

// ===== the charge of a work order (store#MaintenanceWorkOrder's cost centre and project, design §3 "Charging a project") =====
// The fields to write: a cost centre (the organization or an internal organization rolling up to it) and a project (a project of
// the organization); empty clears one; VALUE_INVALID otherwise.
function chargeFields(p, organizationPartyId) {
    const fields = {}
    if (p.costCenterId != null) {
        const costCenterId = text(p.costCenterId)
        if (costCenterId) {
            const chain = ec.resource
                .script("component://mr-mantle/service/mantle/ledger/AccountingPolicy.js")
                .organizationChain(costCenterId)
            if (
                !one("mantle.party.PartyRole", {partyId: costCenterId, roleTypeId: "OrgInternal"}) ||
                !chain.includes(organizationPartyId)
            )
                denied("VALUE_INVALID", "Cost centre " + costCenterId + " is not one of the organization's")
        }
        fields.costCenterId = costCenterId
    }
    if (p.projectWorkEffortId != null) {
        const projectWorkEffortId = text(p.projectWorkEffortId)
        if (projectWorkEffortId) {
            const project = one(WORK, {workEffortId: projectWorkEffortId})
            if (!project || project.workEffortTypeEnumId !== "WetProject" || project.ownerPartyId !== organizationPartyId)
                denied("VALUE_INVALID", "Project " + projectWorkEffortId + " is not one of the organization's")
        }
        fields.projectWorkEffortId = projectWorkEffortId
    }
    return fields
}
// The charge as get#MaintenanceWorkOrder shows it.
function chargeOf(order) {
    const names = lib.partyNames([order.costCenterId])
    const project = order.projectWorkEffortId ? one(WORK, {workEffortId: order.projectWorkEffortId}) : null
    return {
        costCenterId: order.costCenterId || null,
        costCenterName: order.costCenterId ? names[order.costCenterId] || order.costCenterId : "",
        projectWorkEffortId: order.projectWorkEffortId || null,
        projectName: project ? project.workEffortName || project.workEffortId : ""
    }
}

// ===== get#MaintenanceMaterials =====
function suggestionsOf(order, plannedProductIds) {
    const asset = order.assetId ? one(ASSET, {assetId: order.assetId}) : null
    if (!asset?.productId) return []
    const at = ms(ec.user.nowTimestamp)
    const rows = Array.from(
        find("mantle.product.ProductAssoc", {productId: asset.productId, productAssocTypeEnumId: "PatSparePart"}).list()
    ).filter(row => openAt(row, at) && !plannedProductIds.includes(row.toProductId))
    const products = byId(
        PRODUCT,
        "productId",
        rows.map(row => row.toProductId)
    )
    return rows.map(row => ({
        productId: row.toProductId,
        productName: products[row.toProductId]?.productName || row.toProductId,
        quantity: qty(row.quantity ?? 1)
    }))
}
// The stock a line may be issued from: available inventory of the product owned by the work's organization, in a facility of
// the caller's (the posting guard's scope), the line's source facility first.
function stockOptionsFor(products, organizationPartyId, sourceFacilities) {
    if (!products.length) return {}
    const stockScope = facilityScope.scope()
    const assets = Array.from(
        find(ASSET)
            .condition("productId", "in", products)
            .condition("ownerPartyId", organizationPartyId)
            .condition("assetTypeEnumId", "in", stockTypes)
            .condition("statusId", "AstAvailable")
            .condition("availableToPromiseTotal", "greater", 0)
            .orderBy("facilityId,locationSeqId,assetId")
            .list()
    )
    const facilities = byId(
        FACILITY,
        "facilityId",
        assets.map(row => row.facilityId)
    )
    const out = {}
    for (const asset of assets) {
        const facility = facilities[asset.facilityId]
        if (!facility || !facilityScope.owns(stockScope, facility.ownerPartyId)) continue
        ;(out[asset.productId] ||= []).push({
            value: asset.assetId,
            facilityId: asset.facilityId,
            label:
                (facility.facilityName || facility.facilityId) +
                (asset.locationSeqId ? " " + asset.locationSeqId : "") +
                (asset.lotId ? " · lot " + asset.lotId : "") +
                " · " +
                qty(asset.availableToPromiseTotal) +
                " free"
        })
    }
    for (const [productId, options] of Object.entries(out)) {
        const preferred = sourceFacilities[productId]
        options.sort((a, b) => (a.facilityId === preferred ? 0 : 1) - (b.facilityId === preferred ? 0 : 1))
        out[productId] = options.slice(0, stockOptionLimit)
    }
    return out
}
function read(p) {
    signedIn()
    const userScope = maintenanceAccess.scope()
    const work = readWork(userScope, p.workEffortId)
    const {root, order, organizationPartyId} = work
    const caps = userScope.capabilities
    const costRead = !!caps.costView
    const at = ms(ec.user.nowTimestamp)
    const nodes = byId(WORK, "workEffortId", work.treeIds)
    const lines = Array.from(
        find(LINE).condition("workEffortId", "in", work.treeIds).condition("typeEnumId", "WeptConsume").list()
    ).filter(row => openAt(row, at))
    const issuances = Array.from(find(ISSUANCE).condition("workEffortId", "in", work.treeIds).orderBy("issuedDate").list())
    const receipts = issuances.length
        ? Array.from(
              find(RECEIPT)
                  .condition(
                      "sourceAssetIssuanceId",
                      "in",
                      issuances.map(row => row.assetIssuanceId)
                  )
                  .orderBy("receivedDate")
                  .list()
          )
        : []
    const products = byId(PRODUCT, "productId", lines.map(row => row.productId).concat(issuances.map(row => row.productId)))
    const facilities = byId(
        FACILITY,
        "facilityId",
        lines.map(row => row.sourceFacilityId)
    )
    const assets = byId(ASSET, "assetId", issuances.map(row => row.assetId).concat(receipts.map(row => row.assetId)))
    const returnedBy = {}
    for (const row of receipts)
        returnedBy[row.sourceAssetIssuanceId] = (returnedBy[row.sourceAssetIssuanceId] || zero()).add(dec(row.quantityAccepted))
    const totals = {}
    for (const row of issuances) {
        const key = lineKey(row.workEffortId, row.productId)
        const total = (totals[key] ||= {issued: zero(), returned: zero()})
        total.issued = total.issued.add(dec(row.quantity))
        total.returned = total.returned.add(returnedBy[row.assetIssuanceId] || zero())
    }
    const nodeName = id => (id === root.workEffortId ? "Work order" : nodes[id]?.workEffortName || id)
    const productName = id => products[id]?.productName || id
    const issueOpen = issueStatuses.includes(root.statusId)
    const canStock = lib.access.has("STOCK_ISSUE")
    const stock =
        p.withStock && canStock && issueOpen
            ? stockOptionsFor(
                  ids(lines.map(row => row.productId)),
                  organizationPartyId,
                  Object.fromEntries(lines.map(row => [row.productId, row.sourceFacilityId]))
              )
            : {}
    const value = (quantity, assetId) => {
        const cost = assets[assetId]?.acquireCost
        return costRead && cost != null ? ec.l10n.format(dec(quantity).multiply(dec(cost)), "#,##0.00") : null
    }
    const plannedList = lines.map(row => {
        const total = totals[lineKey(row.workEffortId, row.productId)] || {issued: zero(), returned: zero()}
        const net = total.issued.subtract(total.returned)
        const left = dec(row.estimatedQuantity).subtract(net)
        return {
            lineKey: lineKey(row.workEffortId, row.productId),
            workEffortId: row.workEffortId,
            stepName: nodeName(row.workEffortId),
            productId: row.productId,
            productName: productName(row.productId),
            fromDate: row.fromDate,
            fromDateText: dateText(row.fromDate),
            quantity: qty(row.estimatedQuantity),
            quantityUomId: row.quantityUomId || null,
            requiredDate: row.requiredDate || null,
            requiredDateText: dateText(row.requiredDate),
            sourceFacilityId: row.sourceFacilityId || null,
            sourceFacilityName: row.sourceFacilityId
                ? facilities[row.sourceFacilityId]?.facilityName || row.sourceFacilityId
                : "",
            issued: qty(total.issued),
            returned: qty(total.returned),
            used: qty(net),
            left: qty(left.compare(0) > 0 ? left : zero()),
            stockOptions: stock[row.productId] || []
        }
    })
    const executes = mayExecute(userScope, root.workEffortId)
    const issuanceList = issuances.map(row => {
        const returned = returnedBy[row.assetIssuanceId] || zero()
        const returnable = dec(row.quantity).subtract(returned)
        return {
            assetIssuanceId: row.assetIssuanceId,
            workEffortId: row.workEffortId,
            stepName: nodeName(row.workEffortId),
            productId: row.productId,
            productName: productName(row.productId),
            assetId: row.assetId,
            lotId: assets[row.assetId]?.lotId || null,
            quantity: qty(row.quantity),
            returned: qty(returned),
            returnable: qty(returnable.compare(0) > 0 ? returnable : zero()),
            issuedDate: row.issuedDate,
            issuedDateText: dateText(row.issuedDate),
            valueText: value(row.quantity, row.assetId),
            canReturn:
                canStock &&
                !closedStatuses.includes(root.statusId) &&
                returnable.compare(0) > 0 &&
                mayExecute(userScope, row.workEffortId)
        }
    })
    const receiptList = receipts.map(row => {
        const source = issuances.find(issue => issue.assetIssuanceId === row.sourceAssetIssuanceId)
        return {
            assetReceiptId: row.assetReceiptId,
            assetIssuanceId: row.sourceAssetIssuanceId,
            workEffortId: source?.workEffortId || null,
            stepName: nodeName(source?.workEffortId),
            productId: row.productId,
            productName: productName(row.productId),
            assetId: row.assetId,
            lotId: assets[row.assetId]?.lotId || null,
            quantity: qty(row.quantityAccepted),
            receivedDate: row.receivedDate,
            receivedDateText: dateText(row.receivedDate),
            valueText: value(row.quantityAccepted, row.assetId),
            reason: row.itemDescription || ""
        }
    })
    // the parts used, net of returns, a product once
    const used = {}
    for (const row of issuances) {
        const entry = (used[row.productId] ||= {productId: row.productId, productName: productName(row.productId), net: zero()})
        entry.net = entry.net.add(dec(row.quantity)).subtract(returnedBy[row.assetIssuanceId] || zero())
    }
    const open = openStatuses.includes(root.statusId)
    const canPlan = (caps.plan || caps.supervise) && open
    // the nodes a part may be planned on: the work order, then its steps in order
    const stepList = [{value: root.workEffortId, label: "Work order"}].concat(
        work.treeIds
            .filter(id => id !== root.workEffortId)
            .map(id => nodes[id])
            .filter(Boolean)
            .sort((a, b) => num(a.sequenceNum) - num(b.sequenceNum))
            .map(row => ({value: row.workEffortId, label: row.workEffortName || row.workEffortId}))
    )
    return {
        stepList,
        workEffortId: root.workEffortId,
        statusId: root.statusId,
        organizationPartyId,
        plannedList,
        issuanceList,
        receiptList,
        usedList: Object.values(used).map(row => ({productId: row.productId, productName: row.productName, used: qty(row.net)})),
        suggestedList: canPlan ? suggestionsOf(order, ids(lines.map(row => row.productId))) : [],
        canPlan,
        canIssue: canStock && executes && issueOpen,
        stockIssue: canStock,
        costRead
    }
}

// ===== store#MaintenanceMaterial =====
function requirePart(productId) {
    const product = productId ? one(PRODUCT, {productId}) : null
    if (!product) denied("VALUE_INVALID", "Choose the part")
    return product
}
function store(p) {
    signedIn()
    const userScope = maintenanceAccess.scope()
    if (!userScope.capabilities.plan && !userScope.capabilities.supervise)
        denied("PERMISSION_DENIED", "Maintenance plan or supervise is required")
    const work = readWork(userScope, p.workEffortId)
    const {node, root, order, organizationPartyId} = work
    if (!openStatuses.includes(root.statusId))
        denied("WORK_CLOSED", "Work order " + root.workEffortId + " is " + root.statusId + "; its parts are fixed")
    const now = ec.user.nowTimestamp
    const at = ms(now)
    const openLine = productId =>
        Array.from(find(LINE, {workEffortId: node.workEffortId, productId, typeEnumId: "WeptConsume"}).list()).filter(row =>
            openAt(row, at)
        )
    if (flag(p.addSuggested)) {
        const planned = Array.from(
            find(LINE).condition("workEffortId", "in", work.treeIds).condition("typeEnumId", "WeptConsume").list()
        )
            .filter(row => openAt(row, at))
            .map(row => row.productId)
        const added = []
        for (const suggestion of suggestionsOf(order, ids(planned))) {
            call("create#" + LINE, {
                workEffortId: node.workEffortId,
                productId: suggestion.productId,
                fromDate: now,
                typeEnumId: "WeptConsume",
                estimatedQuantity: suggestion.quantity ?? 1
            })
            added.push(suggestion.productId)
        }
        return {workEffortId: node.workEffortId, addedProductIds: added}
    }
    const productId = text(p.productId)
    requirePart(productId)
    const remove = flag(p.remove)
    const quantity = blank(p.estimatedQuantity) ? null : dec(p.estimatedQuantity)
    if (!remove && (quantity == null || quantity.compare(0) <= 0)) denied("QUANTITY_INVALID", "Give a quantity above zero")
    if (!blank(p.quantityUomId) && !one("moqui.basic.Uom", {uomId: text(p.quantityUomId)}))
        denied("VALUE_INVALID", "Unit " + p.quantityUomId + " is not known")
    if (!blank(p.sourceFacilityId)) {
        const facilityOrganization = facilityScope.facilityOrganization(text(p.sourceFacilityId))
        if (facilityOrganization !== organizationPartyId)
            denied("VALUE_INVALID", "Facility " + p.sourceFacilityId + " is not the work organization's")
    }
    const current = openLine(productId)
    // a change names the line it read (its from date): another change since is refused
    const second = value => Math.floor(ms(value) / 1000)
    if (!blank(p.fromDate) && current.length && !current.some(row => second(row.fromDate) === second(p.fromDate)))
        denied("RECORD_CHANGED", "The part line was changed; reload it")
    for (const row of current)
        call("update#" + LINE, {workEffortId: row.workEffortId, productId, fromDate: row.fromDate, thruDate: now})
    if (remove) return {workEffortId: node.workEffortId, productId, fromDate: null}
    call("create#" + LINE, {
        workEffortId: node.workEffortId,
        productId,
        fromDate: now,
        typeEnumId: "WeptConsume",
        estimatedQuantity: quantity,
        quantityUomId: text(p.quantityUomId),
        requiredDate: blank(p.requiredDate) ? null : p.requiredDate,
        sourceFacilityId: text(p.sourceFacilityId)
    })
    return {workEffortId: node.workEffortId, productId, fromDate: now}
}

// ===== issue#MaintenanceMaterial =====
// The checks before anything posts: the work order and the caller's grant, the stock (locked; the user's facilities, on hand),
// inventory of the work's organization, available, free, and the expense mapping.
function issuePlan(p) {
    const userScope = maintenanceAccess.scope()
    const work = readWork(userScope, p.workEffortId)
    const {node, root, order, organizationPartyId} = work
    requireExecute(userScope, node.workEffortId)
    if (!issueStatuses.includes(root.statusId))
        denied(
            "WORK_NOT_STARTED",
            "Parts are issued to approved or started work; work order " + root.workEffortId + " is " + root.statusId
        )
    const quantity = blank(p.quantity) ? zero() : dec(p.quantity)
    if (quantity.compare(0) <= 0) denied("QUANTITY_INVALID", "Give a quantity above zero")
    if (order.assetId && order.assetId === text(p.assetId)) denied("NOT_STOCK", "The equipment under repair is not a spare part")
    // inventory or supplies (posting.stock refuses equipment, NOT_STOCK)
    const asset = posting.stock(posting.scope(), p.assetId, quantity)
    if (!stockTypes.includes(asset.assetTypeEnumId))
        denied(
            "NOT_STOCK",
            "Asset " + asset.assetId + " is not stock; only inventory and supplies are issued to maintenance work"
        )
    if (!blank(p.productId) && asset.productId !== text(p.productId))
        denied("PRODUCT_MISMATCH", "Asset " + asset.assetId + " is " + asset.productId + ", not " + p.productId)
    if (asset.statusId !== "AstAvailable")
        denied("HELD_STOCK", "Asset " + asset.assetId + " is " + asset.statusId + "; only available stock is issued")
    // a customer's asset under repair, or another owner's stock, is never issued as a spare
    if (asset.ownerPartyId !== organizationPartyId)
        denied(
            "OWNER_MISMATCH",
            "Asset " +
                asset.assetId +
                " is owned by " +
                (asset.ownerPartyId || "nobody") +
                ", not the work's " +
                organizationPartyId
        )
    if (quantity.compare(dec(asset.availableToPromiseTotal)) > 0)
        denied(
            "QUANTITY_EXCEEDS_AVAILABLE",
            "Only " + qty(asset.availableToPromiseTotal) + " of asset " + asset.assetId + " is free to issue"
        )
    // AC-24: an organization that posts maps its maintenance expense first, so no issue goes to WIP or the error journal
    const preference = call("mantle.ledger.LedgerServices.find#PartyAcctgPreference", {organizationPartyId}).partyAcctgPreference
    if (preference && asset.acquireCost != null && dec(asset.acquireCost).compare(0) !== 0) {
        const route = routing.routeFor({root, order}, organizationPartyId, ec.user.nowTimestamp)
        if (!route.glAccountId) denied("COST_POLICY_MISSING", route.message)
    }
    return {work, asset, quantity}
}
function issue(p) {
    signedIn()
    const begun = posting.begin(p, "MaintenanceIssue", "STOCK_ISSUE", ["workEffortId", "productId", "assetId", "quantity"])
    if (begun.previous) return begun.previous
    const plan = issuePlan(p)
    const settled = posting.settled(begun.op)
    if (settled) return settled
    const {work, asset, quantity} = plan
    posting.period([work.organizationPartyId], ec.user.nowTimestamp, {lock: false})
    const issued = call("mantle.product.AssetServices.issue#AssetToWorkEffort", {
        assetId: asset.assetId,
        workEffortId: work.node.workEffortId,
        quantity,
        noConsumeProduct: "ignore",
        noOriginFacility: "ignore",
        issuanceFields: {
            costCenterId: work.order.costCenterId || null,
            projectWorkEffortId: work.order.projectWorkEffortId || null,
            assetMaintenanceId: work.order.assetMaintenanceId || null,
            enteredQuantity: quantity,
            appliedConversionFactor: 1
        }
    })
    const left = Number(String(one(ASSET, {assetId: asset.assetId})?.quantityOnHandTotal ?? 0))
    return posting.complete(begun.op, work.organizationPartyId, ISSUANCE, issued.assetIssuanceId, {
        resultCode: "ISSUED",
        workEffortId: work.node.workEffortId,
        rootWorkEffortId: work.root.workEffortId,
        assetId: asset.assetId,
        productId: asset.productId,
        lotId: asset.lotId || null,
        quantity: qty(quantity),
        assetIssuanceId: issued.assetIssuanceId,
        onHandAfter: String(left)
    })
}

// ===== return#MaintenanceMaterial =====
function returnPlan(p) {
    const userScope = maintenanceAccess.scope()
    const issuance = blank(p.assetIssuanceId)
        ? null
        : find(ISSUANCE, {assetIssuanceId: text(p.assetIssuanceId)})
              .forUpdate(true)
              .one()
    if (!issuance?.workEffortId || !routing.workOrderOf(issuance.workEffortId))
        denied("RECORD_UNAVAILABLE", "Issuance " + (p.assetIssuanceId || "") + " is not available")
    const work = readWork(userScope, issuance.workEffortId)
    requireExecute(userScope, issuance.workEffortId)
    if (closedStatuses.includes(work.root.statusId))
        denied("WORK_CLOSED", "Work order " + work.root.workEffortId + " is " + work.root.statusId)
    const quantity = blank(p.quantity) ? zero() : dec(p.quantity)
    if (quantity.compare(0) <= 0) denied("QUANTITY_INVALID", "Give a quantity above zero")
    const returned = Array.from(find(RECEIPT, {sourceAssetIssuanceId: issuance.assetIssuanceId}).list()).reduce(
        (sum, row) => sum.add(dec(row.quantityAccepted)),
        zero()
    )
    const returnable = dec(issuance.quantity).subtract(returned)
    if (quantity.compare(returnable) > 0)
        denied(
            "QUANTITY_EXCEEDS_ISSUED",
            "Only " + qty(returnable) + " of issuance " + issuance.assetIssuanceId + " is left to return"
        )
    const stockScope = posting.scope()
    const source = find(ASSET, {assetId: issuance.assetId}).forUpdate(true).one()
    if (!source) denied("RECORD_UNAVAILABLE", "Asset " + issuance.assetId + " is not available")
    let target, intoOriginal
    if (blank(p.toLocationSeqId)) {
        const home = posting.facility(stockScope, source.facilityId)
        if (!source.locationSeqId && home.assetInventoryLocRequire === "Y")
            denied("LOCATION_REQUIRED", "Choose a location to return to")
        target = source.locationSeqId
            ? posting.destination(stockScope, source.facilityId, {toLocationSeqId: source.locationSeqId})
            : {facilityId: source.facilityId, locationSeqId: null, autoStatusId: null}
        intoOriginal = true
    } else {
        const facilityId = text(p.toFacilityId) || source.facilityId
        const facility = posting.facility(stockScope, facilityId)
        if (facility.ownerPartyId !== source.ownerPartyId)
            denied("OWNER_MISMATCH", "Facility " + facilityId + " is not the stock owner's")
        target = posting.destination(stockScope, facilityId, {toLocationSeqId: p.toLocationSeqId})
        intoOriginal = false
    }
    return {work, issuance, source, quantity, target, intoOriginal}
}
function returnUnused(p) {
    signedIn()
    const begun = posting.begin(p, "MaintenanceReturn", "STOCK_ISSUE", [
        "assetIssuanceId",
        "quantity",
        "toFacilityId",
        "toLocationSeqId",
        "reason"
    ])
    if (begun.previous) return begun.previous
    const plan = returnPlan(p)
    const settled = posting.settled(begun.op)
    if (settled) return settled
    const {work, issuance, source, quantity, target, intoOriginal} = plan
    posting.period([source.ownerPartyId], ec.user.nowTimestamp, {lock: false})
    let received
    if (intoOriginal) {
        received = call("mantle.product.AssetServices.receive#Asset", {
            assetId: source.assetId,
            productId: source.productId,
            quantity,
            facilityId: source.facilityId,
            locationSeqId: source.locationSeqId,
            ownerPartyId: source.ownerPartyId,
            workEffortId: issuance.workEffortId,
            noProduceProduct: "ignore"
        })
        // receive#Asset makes the work the asset's acquiring work effort when it had none: a return is not an acquisition
        if (!source.acquireWorkEffortId) call("update#" + ASSET, {assetId: source.assetId, acquireWorkEffortId: null})
    } else {
        received = call("mantle.product.AssetServices.receive#Asset", {
            productId: source.productId,
            quantity,
            facilityId: target.facilityId,
            locationSeqId: target.locationSeqId,
            statusId: target.autoStatusId || "AstAvailable",
            ownerPartyId: source.ownerPartyId,
            acquireCost: source.acquireCost,
            acquireCostUomId: source.acquireCostUomId,
            assetTypeEnumId: source.assetTypeEnumId,
            classEnumId: source.classEnumId,
            lotId: source.lotId,
            serialNumber: source.serialNumber,
            expectedEndOfLife: source.expectedEndOfLife,
            manufacturedDate: source.manufacturedDate,
            workEffortId: issuance.workEffortId,
            noProduceProduct: "ignore"
        })
        if (source.acquireCostUomId)
            call("update#" + ASSET, {assetId: received.assetId, acquireCostUomId: source.acquireCostUomId})
    }
    call("update#" + RECEIPT, {
        assetReceiptId: received.assetReceiptId,
        sourceAssetIssuanceId: issuance.assetIssuanceId,
        enteredQuantity: quantity,
        appliedConversionFactor: 1,
        itemDescription: text(p.reason)
    })
    settleReturnPosting(received.assetReceiptId)
    return posting.complete(begun.op, work.organizationPartyId, RECEIPT, received.assetReceiptId, {
        resultCode: "RETURNED",
        workEffortId: issuance.workEffortId,
        rootWorkEffortId: work.root.workEffortId,
        assetIssuanceId: issuance.assetIssuanceId,
        assetId: received.assetId || source.assetId,
        intoOriginal,
        productId: source.productId,
        quantity: qty(quantity),
        facilityId: target.facilityId,
        locationSeqId: target.locationSeqId || null,
        assetReceiptId: received.assetReceiptId
    })
}
// The receipt posted when receive#Asset made it, before it named its issuance: by the cost policy then (MaintenanceCostRouting.js).
// When the issuance's own debit differs (the policy or the work's charge changed since the issue), the receipt is posted again
// the issuance's way, as repost#AssetReceipt does, so one transaction remains and it reverses the original charge.
function settleReturnPosting(assetReceiptId) {
    const receiptRow = one(RECEIPT, {assetReceiptId})
    const asset = one(ASSET, {assetId: receiptRow.assetId})
    const expected = routing.receipt(receiptRow, asset)
    if (!expected) return
    const trans = Array.from(
        find("mantle.ledger.transaction.AcctgTrans", {assetReceiptId})
            .condition("acctgTransTypeEnumId", "in", ["AttInventoryReceipt", "AttAssetReceipt"])
            .condition("reversedByAcctgTransId", null)
            .condition("reverseOfAcctgTransId", null)
            .list()
    )
    if (!trans.length) return
    const credit = Array.from(
        find("mantle.ledger.transaction.AcctgTransEntry", {acctgTransId: trans[0].acctgTransId, debitCreditFlag: "C"}).list()
    )[0]
    const same =
        trans.length === 1 &&
        (credit?.glAccountId || null) === (expected.glAccountId || null) &&
        (credit?.facilityId || null) === (expected.facilityId || null) &&
        (credit?.costCenterId || null) === (expected.costCenterId || null) &&
        (trans[0].workEffortId || null) === (expected.projectWorkEffortId || null)
    if (same) return
    for (const row of trans) {
        if (row.isPosted === "Y") call("mantle.ledger.LedgerServices.unpost#AcctgTrans", {acctgTransId: row.acctgTransId})
        call("mantle.ledger.LedgerServices.delete#AcctgTrans", {acctgTransId: row.acctgTransId})
    }
    call("mantle.ledger.AssetAutoPostServices.post#AssetReceipt", {assetReceiptId})
}

const operations = {read, store, issue, returnUnused}
;({
    execute: (op, parameters) => {
        if (!Object.hasOwn(operations, op)) throw new Error("Unknown maintenance material operation " + op)
        return operations[op](parameters || {})
    },
    // for MaintenanceWork.js (store# and get#MaintenanceWorkOrder), never a service's parameters
    chargeFields,
    chargeOf
})
