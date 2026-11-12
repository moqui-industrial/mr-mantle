// Maintenance purchasing and outside service (IronStone Maintenance design §3 PurchaseLinks, CompleteWork's outside-service
// line and the OrderDetail mount row; MT-10; impl-maintenance P10, F45). Purchasing owns sourcing, placing, approving,
// receiving and the money; Maintenance asks for a purchase from its work, links the order lines that fulfil it and accepts
// outside service at completion through Purchasing's own service and check.
//
// - Request (link#MaintenancePurchase without an order line): a planner or supervisor of the work's organization files a
//   purchase request (RqtPurchase) of that organization through Purchasing's create#PurchaseRequest and
//   store#PurchaseRequestItem (the planner is its requester: no Purchasing permission is needed to ask), linked to the work
//   order by RequestWorkEffort, and submits it to Purchasing's approvers unless told not to. It places and approves nothing:
//   approval, sourcing and the purchase order stay Purchasing's. An operation key answers a retry with the first request.
// - Link (link#MaintenancePurchase with an order line): an AssetMaintenanceOrderItem row between the work's primary
//   AssetMaintenance and a purchase order line of the work's organization, never an OrderItemWorkEffort, so
//   OrderItemWorkEffortCheckComplete never completes an order line from maintenance status. A line sourced from one of the
//   work's requests is the work's; another line is linked only by a buyer (PURCHASE_ORDER_EDIT). Purchasing's sourcing of a
//   request line (its RequestItemOrder) writes the same row (link#SourcedMaintenancePurchase, an entity ECA), so the order
//   lines that fulfil a request are linked without a step. Facility work has no AssetMaintenance: its lines are read through
//   its requests only.
// - Read (get#MaintenancePurchases): the work's purchase requests and the order lines that fulfil it (linked, or sourced from
//   its requests), with what was accepted; supplier prices only for a buyer or price reader (or a maintenance cost reader).
// - Accept (accept#MaintenanceService, and transition#MaintenanceWorkOrder's complete with an outside-service line): a
//   service line of the work, by its assigned technician or a supervisor, while the work is in progress, held or complete,
//   through Purchasing's mantle.order.OrderServices.accept#ServiceItem (its own PURCHASE_ORDER_EDIT or STOCK_RECEIVE check,
//   the buying organization, at most as ordered, once under its operation key) with the work order and its evidence: a
//   file of the work is attached to the order line as OrderContent (OctServiceEvidence) and named in the acceptance.
// - Other apps' reads: get#MaintenanceOrder (OrderDetail under Maintenance: an order with lines of work the user reads,
//   read only) and get#PurchaseRequestWork (Purchasing's RequestDetail: the originating work order of a purchase request
//   the user reads under Purchasing's rule, its identity and need date, and whether Maintenance opens it for them).
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const maintenanceAccess = ec.resource.script("component://mr-mantle/service/mantle/work/MaintenanceAccess.js")
const purchaseRequests = () => ec.resource.script("component://mr-mantle/service/mantle/request/PurchaseRequests.js")
const {find, one, rows, denied, call, ms} = lib
const access = lib.access

const WORK = "mantle.work.effort.WorkEffort"
const ORDER = "mantle.work.maintenance.MaintenanceWorkOrder"
const CONTENT = "mantle.work.effort.WorkEffortContent"
const REQUEST = "mantle.request.Request"
const REQUEST_ITEM = "mantle.request.RequestItem"
const REQUEST_WORK = "mantle.request.RequestWorkEffort"
const ITEM_ORDER = "mantle.request.RequestItemOrder"
const LINK = "mantle.product.maintenance.AssetMaintenanceOrderItem"
const HEADER = "mantle.order.OrderHeader"
const PART = "mantle.order.OrderPart"
const ITEM = "mantle.order.OrderItem"
const ORDER_CONTENT = "mantle.order.OrderContent"
const ACCEPTANCE = "mantle.order.purchase.ServiceAcceptance"
const PRODUCT = "mantle.product.Product"

const purchaseType = "RqtPurchase"
const openStatuses = ["WeInPlanning", "WeApproved", "WeInProgress", "WeOnHold"]
const acceptStatuses = ["WeInProgress", "WeOnHold", "WeComplete"]
const deadOrderStatuses = ["OrderCancelled", "OrderRejected"]
// who accepts a service line in Purchasing (accept#ServiceItem checks them again)
const acceptPermissions = ["PURCHASE_ORDER_EDIT", "STOCK_RECEIVE"]
// who reads a supplier's price (as Manufacturing's subcontract read, ProductionSubcontracts.js), and the maintenance cost reader
const priceReaders = [
    "PURCHASE_ORDER_EDIT",
    "SUPPLIER_PRICE_VIEW",
    "SUPPLIER_PRICE_EDIT",
    "ACCOUNTING_VIEW",
    "MAINTENANCE_COST_VIEW"
]
// who reads a purchase request besides its people (PurchaseRequests.js readPermissions, Purchasing's rule)
const requestReaders = ["PURCHASE_ORDER_EDIT", "PURCHASE_APPROVE", "SUPPLY_PLAN_VIEW", "SUPPLY_PLAN_RUN"]
const requestFields = [
    "workEffortId",
    "requestName",
    "description",
    "productId",
    "quantity",
    "quantityUomId",
    "requiredByDate",
    "supplierPartyId",
    "maximumAmount",
    "submit"
]

const blank = value => value == null || String(value).trim() === ""
const text = value => (blank(value) ? null : String(value).trim())
const dec = value => toDecimal(value == null || value === "" ? 0 : value)
const qty = value => (value == null ? "" : dec(value).compare(0) === 0 ? "0" : String(dec(value).toNumber()))
const dateText = value => (value == null || value === "" ? "" : lib.dateText(value))
const statusText = statusId => (statusId ? one("moqui.basic.StatusItem", {statusId})?.description || statusId : "")
const uomText = uomId => (uomId ? one("moqui.basic.Uom", {uomId})?.abbreviation || uomId : "")
const partyName = partyId => (partyId ? lib.partyNames([partyId])[partyId] || partyId : "")
const productName = productId => (productId ? one(PRODUCT, {productId})?.productName || productId : "")
const priceRead = () => priceReaders.some(access.has)
const mayAccept = () => acceptPermissions.some(access.has)
const ids = list => Array.from(new Set(list.filter(Boolean)))
const isInternal = partyId => !!partyId && !!one("mantle.party.PartyRole", {partyId, roleTypeId: "OrgInternal"})
const money = (value, currencyUomId) =>
    value == null ? "" : currencyUomId ? ec.l10n.formatCurrency(lib.money(value, currencyUomId), currencyUomId) : qty(value)

// ===== the work =====
function scopeOf() {
    if (!ec.user.userId) denied("PERMISSION_DENIED", "Sign in to use maintenance work")
    return maintenanceAccess.scope()
}
const unavailable = workEffortId => denied("RECORD_UNAVAILABLE", "Work order " + (workEffortId || "") + " is not available")
// A work order the caller reads (a step reads as its root's): {root, order, organizationPartyId, assigned}.
function workOf(userScope, workEffortId) {
    const id = text(workEffortId)
    if (!id) unavailable(id)
    const found = maintenanceAccess.requireWork(userScope, id)
    const order = one(ORDER, {workEffortId: found.rootWorkEffortId})
    const root = one(WORK, {workEffortId: found.rootWorkEffortId})
    if (!order || !root || root.isTemplate === "Y") unavailable(id)
    return {
        root,
        order,
        organizationPartyId: found.organizationPartyId,
        assigned: maintenanceAccess.assignment(userScope, root.workEffortId).root
    }
}
function requirePlanning(userScope) {
    const caps = userScope.capabilities
    if (!caps.plan && !caps.supervise) denied("PERMISSION_DENIED", "A maintenance planner or supervisor asks for a purchase")
}
// The work's purchase requests (RequestWorkEffort to the root, of type RqtPurchase).
function requestsOf(rootId) {
    const requestIds = rows(REQUEST_WORK, {workEffortId: rootId}).map(row => row.requestId)
    if (!requestIds.length) return []
    return Array.from(
        find(REQUEST)
            .condition("requestId", "in", requestIds)
            .condition("requestTypeEnumId", purchaseType)
            .orderBy("requestId")
            .list()
    )
}
// The purchase order lines of the work: linked to its primary AssetMaintenance, or sourced from one of its requests; each
// {orderId, orderItemSeqId, requestId, linked}.
function lineKeysOf(order, requests) {
    const keys = new Map()
    const add = (orderId, orderItemSeqId, fields) => {
        const key = orderId + ":" + orderItemSeqId
        keys.set(key, Object.assign(keys.get(key) || {orderId, orderItemSeqId, requestId: null, linked: false}, fields))
    }
    if (order.assetMaintenanceId)
        for (const row of rows(LINK, {assetMaintenanceId: order.assetMaintenanceId}))
            add(row.orderId, row.orderItemSeqId, {linked: true})
    const requestIds = requests.map(request => request.requestId)
    if (requestIds.length)
        for (const row of find(ITEM_ORDER).condition("requestId", "in", requestIds).list()) {
            const part = partOf(row.orderId, row.orderItemSeqId)
            if (part && isPurchasePart(part)) add(row.orderId, row.orderItemSeqId, {requestId: row.requestId})
        }
    return Array.from(keys.values())
}
function partOf(orderId, orderItemSeqId) {
    const item = one(ITEM, {orderId, orderItemSeqId})
    return item ? one(PART, {orderId, orderPartSeqId: item.orderPartSeqId}) : null
}
const isPurchasePart = part => isInternal(part.customerPartyId) && !isInternal(part.vendorPartyId)
const acceptedOf = (orderId, orderItemSeqId) =>
    rows(ACCEPTANCE, {orderId, orderItemSeqId}).reduce((total, row) => total.add(dec(row.acceptedQuantity)), dec(0))
// A service line: a product of type PtService, or a line with no product (accept#ServiceItem's rule).
function isServiceLine(item) {
    if (!item.productId) return true
    return one(PRODUCT, {productId: item.productId})?.productTypeEnumId === "PtService"
}
// One order line as the work shows it.
function lineRow(key, prices, canAccept) {
    const item = one(ITEM, {orderId: key.orderId, orderItemSeqId: key.orderItemSeqId})
    const header = one(HEADER, {orderId: key.orderId})
    const part = partOf(key.orderId, key.orderItemSeqId)
    if (!item || !header || !part) return null
    const ordered = deadOrderStatuses.includes(header.statusId)
        ? dec(0)
        : dec(item.quantity).subtract(dec(item.quantityCancelled))
    const accepted = acceptedOf(item.orderId, item.orderItemSeqId)
    const service = isServiceLine(item)
    const open = !deadOrderStatuses.includes(header.statusId)
    const row = {
        orderId: item.orderId,
        orderItemSeqId: item.orderItemSeqId,
        key: item.orderId + ":" + item.orderItemSeqId,
        description: item.itemDescription || productName(item.productId),
        supplierName: partyName(part.vendorPartyId),
        orderStatusId: header.statusId,
        orderStatusText: statusText(header.statusId),
        quantityText: qty(ordered),
        uomText: uomText(item.quantityUomId),
        acceptedText: service ? qty(accepted) : "",
        remainingText: service ? qty(ordered.subtract(accepted)) : "",
        service,
        requiredByText: dateText(item.requiredByDate),
        requestId: key.requestId,
        linked: !!key.linked,
        canAccept: !!canAccept && service && open && ordered.subtract(accepted).compare(0) > 0
    }
    if (prices)
        Object.assign(row, {
            unitAmountText: money(item.unitAmount, header.currencyUomId),
            amountText: money(dec(item.unitAmount).multiply(ordered), header.currencyUomId)
        })
    return row
}
// The files of the work (its root's and steps'), the evidence an acceptance may name.
function filesOf(rootId) {
    const workIds = ids([rootId].concat(rows(WORK, {rootWorkEffortId: rootId}).map(row => row.workEffortId)))
    return Array.from(find(CONTENT).condition("workEffortId", "in", workIds).orderBy("-contentDate").limit(50).list())
        .filter(row => row.contentLocation && !row.thruDate)
        .map(row => ({
            workEffortContentId: row.workEffortContentId,
            text: (row.description || String(row.contentLocation).split("/").pop()) + " · " + dateText(row.contentDate)
        }))
}
// Whether the caller accepts outside service on the work now: its assigned technician or a supervisor, the work in progress,
// held or complete, with Purchasing's permission.
function acceptRefusal(userScope, work) {
    const caps = userScope.capabilities
    if (!((caps.execute && work.assigned) || caps.supervise))
        return {
            reason: "NOT_ASSIGNED",
            message: "A technician assigned to the work, or a supervisor, accepts its outside service"
        }
    if (!acceptStatuses.includes(work.root.statusId))
        return {reason: "STATUS_INVALID", message: "Outside service is accepted while the work is in progress or complete"}
    if (!mayAccept())
        return {
            reason: "PERMISSION_DENIED",
            message: "Accepting outside service is Purchasing's: PURCHASE_ORDER_EDIT or STOCK_RECEIVE is required"
        }
    return null
}

// ===== link#MaintenancePurchase =====
function link(p) {
    return blank(p.orderId) ? requestPurchase(p) : linkLine(p)
}
// A purchase request of the work's organization for what the work needs, linked to the work and submitted.
function requestPurchase(p) {
    const userScope = scopeOf()
    requirePlanning(userScope)
    const work = workOf(userScope, p.workEffortId)
    const {root, organizationPartyId} = work
    if (!openStatuses.includes(root.statusId))
        denied("WORK_CLOSED", "Work order " + root.workEffortId + " is " + statusText(root.statusId))
    const requestName = text(p.requestName) || text(p.description)
    if (!requestName) denied("NAME_REQUIRED", "Say what is to be bought")
    let op = null
    if (!blank(p.operationKey)) {
        op = lib.operation(
            p,
            "MaintenancePurchase",
            organizationPartyId,
            requestFields.map(field =>
                p[field] == null ? "" : field === "requiredByDate" ? String(ms(p[field])) : String(p[field])
            )
        )
        const earlier = lib.previous(op)
        if (earlier) return Object.assign({}, earlier, {repeated: true})
    }
    // the work's facility when the organization owns it (create#PurchaseRequest refuses another)
    const facility = root.facilityId ? one("mantle.facility.Facility", {facilityId: root.facilityId}) : null
    const created = call("mantle.request.RequestServices.create#PurchaseRequest", {
        organizationPartyId,
        requestName: requestName.substring(0, 255),
        description: ["For work order " + root.workEffortId + ": " + (root.workEffortName || ""), text(p.description)]
            .filter(Boolean)
            .join("\n\n"),
        facilityId: facility?.ownerPartyId === organizationPartyId ? facility.facilityId : null,
        responseRequiredDate: p.requiredByDate || root.estimatedCompletionDate || null
    })
    const requestId = created.requestId
    const line = call("mantle.request.RequestServices.store#PurchaseRequestItem", {
        requestId,
        productId: text(p.productId),
        description: text(p.description) || (text(p.productId) ? null : requestName),
        quantity: blank(p.quantity) ? 1 : p.quantity,
        quantityUomId: text(p.quantityUomId),
        requiredByDate: p.requiredByDate || root.estimatedCompletionDate || null,
        supplierPartyId: text(p.supplierPartyId),
        maximumAmount: blank(p.maximumAmount) ? null : p.maximumAmount
    })
    call("create#" + REQUEST_WORK, {requestId, workEffortId: root.workEffortId})
    let statusId = "ReqDraft"
    if (!(p.submit === false || p.submit === "false" || p.submit === "N"))
        statusId = call("mantle.request.RequestServices.submit#PurchaseRequest", {requestId}).statusId
    const result = {
        requestId,
        requestItemSeqId: line.requestItemSeqId,
        statusId,
        workEffortId: root.workEffortId,
        resultCode: "REQUESTED"
    }
    if (op) lib.complete(op, REQUEST, requestId, result)
    return result
}
// An order line of the work's organization linked to the work's primary AssetMaintenance.
function linkLine(p) {
    const userScope = scopeOf()
    requirePlanning(userScope)
    const work = workOf(userScope, p.workEffortId)
    const {root, order, organizationPartyId} = work
    if (!openStatuses.concat(["WeComplete"]).includes(root.statusId))
        denied("WORK_CLOSED", "Work order " + root.workEffortId + " is " + statusText(root.statusId))
    if (!order.assetMaintenanceId)
        denied(
            "LINK_UNAVAILABLE",
            "Work order " + root.workEffortId + " has no equipment record; its purchases are linked through its requests"
        )
    const item = blank(p.orderItemSeqId) ? null : one(ITEM, {orderId: p.orderId, orderItemSeqId: p.orderItemSeqId})
    const part = item ? one(PART, {orderId: item.orderId, orderPartSeqId: item.orderPartSeqId}) : null
    if (!item || !part || !isPurchasePart(part) || part.customerPartyId !== organizationPartyId)
        denied("RECORD_UNAVAILABLE", "Order item " + p.orderId + ":" + (p.orderItemSeqId || "") + " is not available")
    if (deadOrderStatuses.includes(one(HEADER, {orderId: item.orderId})?.statusId))
        denied("ORDER_CANCELLED", "Order " + item.orderId + " is cancelled")
    const requestIds = requestsOf(root.workEffortId).map(request => request.requestId)
    const sourced =
        requestIds.length > 0 &&
        find(ITEM_ORDER, {orderId: item.orderId, orderItemSeqId: item.orderItemSeqId})
            .condition("requestId", "in", requestIds)
            .count() > 0
    if (!sourced && !access.has("PURCHASE_ORDER_EDIT"))
        denied("PERMISSION_DENIED", "A buyer links a purchase order line the work did not request (PURCHASE_ORDER_EDIT)")
    const created = writeLink(order.assetMaintenanceId, item.orderId, item.orderItemSeqId)
    return {
        workEffortId: root.workEffortId,
        orderId: item.orderId,
        orderItemSeqId: item.orderItemSeqId,
        resultCode: created ? "LINKED" : "ALREADY_LINKED"
    }
}
function writeLink(assetMaintenanceId, orderId, orderItemSeqId) {
    if (one(LINK, {assetMaintenanceId, orderId, orderItemSeqId})) return false
    call("create#" + LINK, {assetMaintenanceId, orderId, orderItemSeqId})
    return true
}
// link#SourcedMaintenancePurchase (the RequestItemOrder ECA): Purchasing sourced a request line to an order line; when the
// request is linked to managed equipment work, its primary AssetMaintenance is linked to the line too. Nothing else changes.
function linkSourced(p) {
    if (blank(p.requestId) || blank(p.orderId) || blank(p.orderItemSeqId)) return {linkedCount: 0}
    if (!find(ITEM_ORDER, {requestId: p.requestId, orderId: p.orderId, orderItemSeqId: p.orderItemSeqId}).count())
        return {linkedCount: 0}
    if (one(REQUEST, {requestId: p.requestId})?.requestTypeEnumId !== purchaseType) return {linkedCount: 0}
    let linkedCount = 0
    for (const row of rows(REQUEST_WORK, {requestId: p.requestId})) {
        const order = one(ORDER, {workEffortId: row.workEffortId})
        if (order?.assetMaintenanceId && writeLink(order.assetMaintenanceId, p.orderId, p.orderItemSeqId)) linkedCount++
    }
    return {linkedCount}
}

// ===== get#MaintenancePurchases =====
function getPurchases(p) {
    const userScope = scopeOf()
    const work = workOf(userScope, p.workEffortId)
    const {root, order} = work
    const caps = userScope.capabilities
    const prices = priceRead()
    const requests = requestsOf(root.workEffortId)
    const canAccept = !acceptRefusal(userScope, work)
    const requestList = requests.map(request => ({
        requestId: request.requestId,
        requestName: request.requestName || request.requestId,
        statusId: request.statusId,
        statusText: statusText(request.statusId),
        lines: rows(REQUEST_ITEM, {requestId: request.requestId})
            .filter(item => item.statusId !== "ReqCancelled")
            .sort((a, b) => String(a.requestItemSeqId).localeCompare(String(b.requestItemSeqId)))
            .map(item =>
                Object.assign(
                    {
                        requestItemSeqId: item.requestItemSeqId,
                        description: item.description || productName(item.productId),
                        quantityText: qty(item.quantity),
                        uomText: uomText(item.quantityUomId),
                        requiredByText: dateText(item.requiredByDate),
                        supplierName: partyName(item.supplierPartyId)
                    },
                    prices ? {maximumText: money(item.maximumAmount, request.currencyUomId)} : {}
                )
            )
    }))
    const orderLines = lineKeysOf(order, requests)
        .map(key => lineRow(key, prices, canAccept))
        .filter(Boolean)
        .sort((a, b) => a.key.localeCompare(b.key))
    const open = openStatuses.includes(root.statusId)
    return {
        requestList,
        orderLines,
        canRequest: (caps.plan || caps.supervise) && open,
        canLink: (caps.plan || caps.supervise) && !!order.assetMaintenanceId && access.has("PURCHASE_ORDER_EDIT"),
        canAccept,
        acceptMessage: acceptRefusal(userScope, work)?.message || "",
        priceRead: prices,
        evidenceFiles: canAccept ? filesOf(root.workEffortId) : []
    }
}

// ===== accept#MaintenanceService =====
function acceptService(p) {
    const userScope = scopeOf()
    const work = workOf(userScope, p.workEffortId)
    return acceptWith(userScope, work, p)
}
// Accept a service line of the work under Purchasing's check, with the work order and its evidence file.
function acceptWith(userScope, work, p) {
    const {root, order} = work
    const refused = acceptRefusal(userScope, work)
    if (refused) denied(refused.reason, refused.message)
    const orderId = text(p.orderId)
    const orderItemSeqId = text(p.orderItemSeqId)
    const key = lineKeysOf(order, requestsOf(root.workEffortId)).find(
        row => row.orderId === orderId && row.orderItemSeqId === orderItemSeqId
    )
    if (!key) denied("LINE_UNLINKED", "Order item " + orderId + ":" + (orderItemSeqId || "") + " is not a purchase of this work")
    if (blank(p.operationKey)) denied("OPERATION_KEY_REQUIRED", "An operation key is required")
    // the evidence: a file of the work, attached to the order line once
    let orderContentId = null
    const contentId = text(p.workEffortContentId)
    if (contentId) {
        const content = one(CONTENT, {workEffortContentId: contentId})
        const workIds = [root.workEffortId].concat(rows(WORK, {rootWorkEffortId: root.workEffortId}).map(row => row.workEffortId))
        if (!content || !content.contentLocation || !workIds.includes(content.workEffortId))
            denied("EVIDENCE_INVALID", "File " + contentId + " is not one of work order " + root.workEffortId + "'s")
        const existing = rows(ORDER_CONTENT, {orderId, orderItemSeqId, contentLocation: content.contentLocation})[0]
        orderContentId = existing
            ? existing.orderContentId
            : call("create#" + ORDER_CONTENT, {
                  orderId,
                  orderItemSeqId,
                  orderContentTypeEnumId: "OctServiceEvidence",
                  contentLocation: content.contentLocation,
                  description: ("Work order " + root.workEffortId + ": " + (content.description || "evidence")).substring(0, 255),
                  contentDate: ec.user.nowTimestamp
              }).orderContentId
    }
    const accepted = call("mantle.order.OrderServices.accept#ServiceItem", {
        operationKey: String(p.operationKey),
        orderId,
        orderItemSeqId,
        acceptedQuantity: p.acceptedQuantity,
        acceptedDate: p.acceptedDate || null,
        workEffortId: root.workEffortId,
        orderContentId,
        comments: text(p.comments) || "Outside service of work order " + root.workEffortId
    }).result
    // the line is the work's from now on, for equipment work (sourced lines are already)
    if (order.assetMaintenanceId) writeLink(order.assetMaintenanceId, orderId, orderItemSeqId)
    return {
        workEffortId: root.workEffortId,
        serviceAcceptanceId: accepted?.serviceAcceptanceId || null,
        acceptedQuantity: accepted?.acceptedQuantity || null,
        totalAccepted: accepted?.totalAccepted || null,
        alreadyApplied: !!accepted?.alreadyApplied,
        orderContentId
    }
}
// CompleteWork's outside-service line (transition#MaintenanceWorkOrder, complete): the line given is accepted in the
// completion's transaction, after its own gate; none given, nothing.
function acceptAtCompletion(userScope, ctx, p) {
    if (blank(p.serviceOrderId) && blank(p.serviceOrderItemSeqId)) return null
    const work = {
        root: one(WORK, {workEffortId: ctx.root.workEffortId}),
        order: ctx.order,
        organizationPartyId: ctx.organizationPartyId,
        assigned: maintenanceAccess.assignment(userScope, ctx.root.workEffortId).root
    }
    return acceptWith(userScope, work, {
        orderId: p.serviceOrderId,
        orderItemSeqId: p.serviceOrderItemSeqId,
        acceptedQuantity: p.serviceAcceptedQuantity,
        workEffortContentId: p.serviceEvidenceContentId,
        comments: p.serviceComments,
        operationKey: p.serviceOperationKey
    })
}
// The service lines CompleteWork offers to accept (the caller may accept; a line with something left), or none.
function completionLines(userScope, ctx) {
    const work = {root: ctx.root, order: ctx.order, assigned: maintenanceAccess.assignment(userScope, ctx.root.workEffortId).root}
    if (acceptRefusal(userScope, work)) return {serviceLines: [], evidenceFiles: []}
    const lines = lineKeysOf(ctx.order, requestsOf(ctx.root.workEffortId))
        .map(key => lineRow(key, false, true))
        .filter(row => row && row.canAccept)
        .map(row => ({
            key: row.key,
            text: row.description + " · " + row.orderId + ":" + row.orderItemSeqId + " · " + row.remainingText + " to accept"
        }))
    return {serviceLines: lines, evidenceFiles: lines.length ? filesOf(ctx.root.workEffortId) : []}
}

// ===== get#MaintenanceOrder (OrderDetail under Maintenance) =====
// A purchase order with lines of work orders the user reads, read only: its header and each line with its work orders and
// what was accepted; prices for a price reader. An order linked to none of the user's work is not Maintenance's to show.
function getOrder(p) {
    const userScope = scopeOf()
    if (!userScope.capabilities.workRead) denied("PERMISSION_DENIED", "Maintenance work view is required")
    const header = blank(p.orderId) ? null : one(HEADER, {orderId: p.orderId})
    if (!header) denied("RECORD_UNAVAILABLE", "Order " + (p.orderId || "") + " is not available")
    const prices = priceRead()
    const readable = new Map()
    const readWork = workEffortId => {
        if (!readable.has(workEffortId)) {
            let found = null
            try {
                found = workOf(userScope, workEffortId)
            } catch (error) {
                found = null
            }
            readable.set(workEffortId, found)
        }
        return readable.get(workEffortId)
    }
    const items = rows(ITEM, {orderId: header.orderId}).sort((a, b) =>
        String(a.orderItemSeqId).localeCompare(String(b.orderItemSeqId))
    )
    let linkedCount = 0
    const itemRows = items.map(item => {
        const workIds = []
        for (const link of rows(LINK, {orderId: item.orderId, orderItemSeqId: item.orderItemSeqId}))
            for (const order of rows(ORDER, {assetMaintenanceId: link.assetMaintenanceId})) workIds.push(order.workEffortId)
        for (const source of rows(ITEM_ORDER, {orderId: item.orderId, orderItemSeqId: item.orderItemSeqId}))
            for (const row of rows(REQUEST_WORK, {requestId: source.requestId})) workIds.push(row.workEffortId)
        const works = ids(workIds)
            .filter(workEffortId => one(ORDER, {workEffortId}))
            .map(readWork)
            .filter(Boolean)
            .map(work => ({
                workEffortId: work.root.workEffortId,
                workEffortName: work.root.workEffortName || work.root.workEffortId,
                statusText: statusText(work.root.statusId)
            }))
        linkedCount += works.length
        const ordered = dec(item.quantity).subtract(dec(item.quantityCancelled))
        const row = {
            orderItemSeqId: item.orderItemSeqId,
            description: item.itemDescription || productName(item.productId),
            quantityText: qty(ordered),
            uomText: uomText(item.quantityUomId),
            acceptedText: isServiceLine(item) ? qty(acceptedOf(item.orderId, item.orderItemSeqId)) : "",
            requiredByText: dateText(item.requiredByDate),
            works,
            workEffortId: works[0]?.workEffortId || null,
            workText: works.map(work => work.workEffortId + " · " + work.workEffortName).join(", ")
        }
        if (prices) row.unitAmountText = money(item.unitAmount, header.currencyUomId)
        return row
    })
    if (!linkedCount) denied("RECORD_UNAVAILABLE", "Order " + header.orderId + " is not available")
    const part = rows(PART, {orderId: header.orderId})[0] || {}
    return {
        maintenanceOrder: {
            orderId: header.orderId,
            orderName: header.orderName || "",
            statusId: header.statusId,
            statusText: statusText(header.statusId),
            vendorName: partyName(part.vendorPartyId),
            customerName: partyName(part.customerPartyId),
            entryDateText: dateText(header.entryDate),
            grandTotalText: prices ? money(header.grandTotal, header.currencyUomId) : "",
            priceRead: prices,
            items: itemRows.filter(row => row.works.length)
        }
    }
}

// ===== get#PurchaseRequestWork (Purchasing's RequestDetail) =====
// The work orders a purchase request was raised from, for a user who reads the request under Purchasing's rule (its people,
// or a buyer, approver or planner of its organization): each work order's id, name, target and need date, and whether
// Maintenance opens it for them; never its notes, time or people.
function requestWork(p) {
    if (!ec.user.userId) denied("PERMISSION_DENIED", "Sign in to read a purchase request")
    const pr = purchaseRequests().purchaseRequest(text(p.requestId))
    if (!pr.own && !requestReaders.some(access.has))
        denied("PERMISSION_DENIED", "Purchase request " + pr.requestId + " is its people's, or " + requestReaders.join(" or "))
    const partyId = ec.user.userAccount?.partyId || null
    const workList = rows(REQUEST_WORK, {requestId: pr.requestId})
        .map(row => one(ORDER, {workEffortId: row.workEffortId}))
        .filter(Boolean)
        .map(order => {
            const root = one(WORK, {workEffortId: order.workEffortId})
            const asset = order.assetId ? one("mantle.product.asset.Asset", {assetId: order.assetId}) : null
            const facility = root.facilityId ? one("mantle.facility.Facility", {facilityId: root.facilityId}) : null
            return {
                workEffortId: root.workEffortId,
                workEffortName: root.workEffortName || root.workEffortId,
                targetName: asset
                    ? asset.assetName || asset.assetId
                    : facility
                      ? facility.facilityName || facility.facilityId
                      : "",
                statusText: statusText(root.statusId),
                neededByText: dateText(root.estimatedCompletionDate),
                canOpen: !maintenanceAccess.workHidden(root.workEffortId, partyId)
            }
        })
    return {workList}
}

const operations = {link, linkSourced, getPurchases, acceptService, getOrder, requestWork}
;({
    execute: (op, parameters) => {
        if (!Object.hasOwn(operations, op)) throw new Error("Unknown maintenance purchase operation " + op)
        return operations[op](parameters || {})
    },
    // for MaintenanceWork.js's CompleteWork only, never a service's parameters
    acceptAtCompletion,
    completionLines
})
