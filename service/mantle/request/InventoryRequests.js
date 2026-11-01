// Internal stock requests (impl-warehouse P15 WH-REQUEST; design-warehouse §8 StockRequests and RequestDetail, crosscut §3.11
// InventoryRequestProgress): a Request of type RqtInventory names the facility the stock is for (Request.facilityId, one of
// the user's organizations'); its items are stocked products and quantities in the stock unit. Approval under stock
// authority (STOCK_POLICY_PLAN) makes each item an approved RqTpInventory Requirement linked through RequirementRequestItem
// (RequirementSupply waits for CX-PLANNING, impl-warehouse §7) and puts the request in progress; Warehouse then allocates it
// by transfers or moves (mantle.shipment.WarehouseTaskServices.allocate#InventoryRequest), and its progress is read from
// those movements, never from linked work (complete#RequestFromWork does nothing for this type).
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const facilityScope = ec.resource.script("component://mr-mantle/service/mantle/facility/FacilityScope.js")
const transfers = ec.resource.script("component://mr-mantle/service/mantle/shipment/Transfers.js")
const {find, one, rows, call, denied} = lib

const REQUEST = "mantle.request.Request",
    ITEM = "mantle.request.RequestItem",
    ALLOCATION = "mantle.request.InventoryRequestAllocation",
    FACILITY = "mantle.facility.Facility"
const editableStatuses = ["ReqDraft", "ReqSubmitted"]
const approvableStatuses = ["ReqSubmitted", "ReqReviewed"]
const dec = value => toDecimal(value ?? 0)
const blank = value => value == null || String(value).trim() === ""
const text = value => (dec(value).compare(0) === 0 ? "0" : String(dec(value).toNumber()))
const positive = value => (value.compare(0) > 0 ? value : toDecimal(0))

// Whether the operation policy (resolve#WarehousePolicy) asks for the stock request check: for a facility of the user's
// scope that facility's policy, else (no facility, or one outside the scope) any of the user's organizations'. Off by
// default (impl-warehouse §2: a new refusal behind its own WarehousePolicy flag; F344).
function checkOn(userScope, facility) {
    const flagged = parameters => {
        try {
            const out = call("mantle.facility.WarehousePolicyServices.resolve#WarehousePolicy", parameters)
            return out.operationPolicy?.inventoryRequestCheck === "Y"
        } catch (error) {
            ec.logger.warn("Stock request check of " + JSON.stringify(parameters) + " not read: " + error.message)
            return false
        }
    }
    if (facility && facilityScope.owns(userScope, facility.ownerPartyId)) return flagged({facilityId: facility.facilityId})
    return (userScope.memberPartyIds || []).some(organizationPartyId => flagged({organizationPartyId}))
}
// create#Request (and update#Request switching to RqtInventory or another facility) of a stock request: with the policy's
// inventoryRequestCheck, the facility the stock is for, one of the user's organizations' (FACILITY_REQUIRED,
// RECORD_UNAVAILABLE), whose owner becomes the OrgInternal party; with the check off, Mantle's default (nothing refused).
function validate(p) {
    const userScope = facilityScope.scope()
    const facility = blank(p.facilityId) ? null : one(FACILITY, {facilityId: p.facilityId})
    if (!checkOn(userScope, facility)) return {organizationPartyId: null, checked: false}
    if (blank(p.facilityId)) denied("FACILITY_REQUIRED", "A stock request names the facility the stock is for")
    if (!facility || !facilityScope.owns(userScope, facility.ownerPartyId))
        denied("RECORD_UNAVAILABLE", "Facility " + p.facilityId + " is not available")
    return {organizationPartyId: facility.ownerPartyId, checked: true}
}
// The request, locked when asked: a stock request of a facility of the user's organizations.
function requestOf(requestId, lock = false) {
    const request = blank(requestId) ? null : find(REQUEST, {requestId}).forUpdate(lock).one()
    const facility = request?.facilityId ? one(FACILITY, {facilityId: request.facilityId}) : null
    if (!request || request.requestTypeEnumId !== "RqtInventory" || !facility)
        denied("RECORD_UNAVAILABLE", "Stock request " + (requestId || "") + " is not available")
    if (!facilityScope.owns(facilityScope.scope(), facility.ownerPartyId))
        denied("RECORD_UNAVAILABLE", "Stock request " + requestId + " is not available")
    return {request, facility}
}
function stockedProduct(productId) {
    const product = blank(productId) ? null : one("mantle.product.Product", {productId})
    if (!product) denied("PRODUCT_REQUIRED", "Choose a product")
    if (product.productTypeEnumId !== "PtAsset") denied("NOT_STOCK", "Product " + productId + " is not a stocked product")
    return product
}

// add#InventoryRequestItem: a stocked product and a quantity above zero on a draft or submitted stock request.
function addItem(p) {
    const {request} = requestOf(p.requestId, true)
    if (!editableStatuses.includes(request.statusId))
        denied("REQUEST_CLOSED", "Request " + request.requestId + " is " + request.statusId + "; its items are fixed")
    const product = stockedProduct(p.productId)
    const quantity = dec(p.quantity)
    if (quantity.compare(0) <= 0) denied("QUANTITY_INVALID", "Give a quantity above zero")
    const created = call("create#" + ITEM, {
        requestId: request.requestId,
        productId: product.productId,
        quantity,
        requiredByDate: p.requiredByDate || request.responseRequiredDate || null,
        description: blank(p.description) ? product.productName || null : String(p.description).trim(),
        statusId: request.statusId
    })
    return {requestId: request.requestId, requestItemSeqId: created.requestItemSeqId}
}

// approve#InventoryRequest: a submitted (or reviewed) stock request whose items are all stocked products with a quantity;
// each item an approved RqTpInventory Requirement of the request's facility (an item already linked keeps its own), the
// request in progress.
function approve(userScope, p) {
    const {request, facility} = requestOf(p.requestId, true)
    if (!approvableStatuses.includes(request.statusId))
        denied(
            "NOT_SUBMITTED",
            "Request " + request.requestId + " is " + request.statusId + "; only a submitted request is approved"
        )
    const items = rows(ITEM, {requestId: request.requestId}).filter(item => item.statusId !== "ReqCancelled")
    if (!items.length) denied("NO_ITEMS", "Request " + request.requestId + " has no items to approve")
    for (const item of items) {
        stockedProduct(item.productId)
        if (dec(item.quantity).compare(0) <= 0)
            denied("ITEM_INVALID", "Item " + item.requestItemSeqId + " has no quantity")
    }
    const requirementIds = []
    for (const item of items) {
        const linked = rows("mantle.request.requirement.RequirementRequestItem", {
            requestId: item.requestId,
            requestItemSeqId: item.requestItemSeqId
        })
        if (linked.length) {
            requirementIds.push(...linked.map(link => link.requirementId))
            continue
        }
        const created = call("create#mantle.request.requirement.Requirement", {
            requirementTypeEnumId: "RqTpInventory",
            statusId: "RqmtStApproved",
            facilityId: facility.facilityId,
            productId: item.productId,
            quantity: item.quantity,
            requiredByDate: item.requiredByDate || request.responseRequiredDate || null,
            description: "Stock request " + request.requestId + " item " + item.requestItemSeqId,
            reason: blank(p.comments) ? null : String(p.comments).trim()
        })
        call("create#mantle.request.requirement.RequirementRequestItem", {
            requirementId: created.requirementId,
            requestId: item.requestId,
            requestItemSeqId: item.requestItemSeqId
        })
        requirementIds.push(created.requirementId)
    }
    call("mantle.request.RequestServices.update#Request", {requestId: request.requestId, statusId: "ReqInProgress"})
    return {requestId: request.requestId, organizationPartyId: facility.ownerPartyId, requirementIds, statusId: "ReqInProgress"}
}

// get#InventoryRequestProgress: each item's requested, approved, allocated, transferred (sent on a transfer, or moved) and
// received quantity, what is in transit and what remains, with the requirements and the movements behind them.
function progress(p) {
    const {request, facility} = requestOf(p.requestId)
    const items = rows(ITEM, {requestId: request.requestId}).sort((a, b) =>
        String(a.requestItemSeqId).localeCompare(String(b.requestItemSeqId))
    )
    const products = new Map(
        items.length
            ? Array.from(find("mantle.product.Product").condition("productId", "in", items.map(item => item.productId)).list())
                  .map(row => [row.productId, row])
            : []
    )
    const itemRows = items.map(item => {
        const requirementIds = rows("mantle.request.requirement.RequirementRequestItem", {
            requestId: item.requestId,
            requestItemSeqId: item.requestItemSeqId
        }).map(link => link.requirementId)
        let transferred = toDecimal(0),
            received = toDecimal(0),
            inTransit = toDecimal(0)
        const links = rows(ALLOCATION, {requestId: item.requestId, requestItemSeqId: item.requestItemSeqId})
            .sort((a, b) => String(a.allocationId).localeCompare(String(b.allocationId)))
            .map(allocation => {
                if (allocation.allocationTypeEnumId === "IratMove") {
                    transferred = transferred.add(dec(allocation.quantity))
                    received = received.add(dec(allocation.quantity))
                    return {allocationId: allocation.allocationId, kind: "move", assetId: allocation.assetId,
                        quantity: text(allocation.quantity), sent: text(allocation.quantity), received: text(allocation.quantity),
                        statusId: "moved"}
                }
                const source = one("mantle.shipment.ShipmentItemSource", {shipmentItemSourceId: allocation.shipmentItemSourceId})
                const shipment = source ? one("mantle.shipment.Shipment", {shipmentId: source.shipmentId}) : null
                const line = source ? transfers.lineOf(source) : null
                const sent = line ? line.issued.add(line.moved) : toDecimal(0)
                const got = line ? line.accepted : toDecimal(0)
                transferred = transferred.add(sent)
                received = received.add(got)
                inTransit = inTransit.add(line ? line.inTransit : toDecimal(0))
                return {allocationId: allocation.allocationId, kind: "transfer", shipmentId: allocation.shipmentId,
                    shipmentItemSourceId: allocation.shipmentItemSourceId, quantity: text(allocation.quantity),
                    sent: text(sent), received: text(got), statusId: shipment?.statusId || null,
                    cancelled: source?.statusId === "SisCancelled" || shipment?.statusId === "ShipCancelled"}
            })
        const quantity = dec(item.quantity)
        return {
            requestItemSeqId: item.requestItemSeqId,
            productId: item.productId,
            productName: products.get(item.productId)?.productName || item.productId,
            quantityUomId: products.get(item.productId)?.amountUomId || null,
            requiredByDate: item.requiredByDate || null,
            facilityId: facility.facilityId,
            requested: text(quantity),
            approved: text(transfers.approvedOf(item.requestId, item.requestItemSeqId)),
            allocated: text(transfers.allocatedOf(item.requestId, item.requestItemSeqId)),
            transferred: text(transferred),
            received: text(received),
            inTransit: text(inTransit),
            remaining: text(positive(quantity.subtract(received))),
            requirementIds,
            links
        }
    })
    return {
        requestId: request.requestId,
        statusId: request.statusId,
        facilityId: facility.facilityId,
        organizationPartyId: facility.ownerPartyId,
        itemRows
    }
}

;({validate, requestOf, addItem, approve, progress})
