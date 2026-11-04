// The buy conversion's other routes (impl-purchasing P14b; crosscut §4.2, R-PUR-06, R-PUR-20, R-PUR-37; design-purchasing §8
// SupplyPlanning), called by SupplyPlanning.js:
// - the request route: where the organization's buying policy sends plan buys to purchase requests (planBuyToRequest), a buy
//   suggestion becomes lines of a purchase request of the organization for the suggestion's facility (one request per
//   organization and facility in the call, through mantle.request.RequestServices' create#PurchaseRequest and
//   store#PurchaseRequestItem, so their checks apply), sent to its approval once the call's lines are in
//   (submit#PurchaseRequest). Each customer order line of the requirement is a line of its own with a RequestItemOrder to the
//   sales line (F-P10-7: the demand RequestSourcing's drop-ship route moves); the rest is one more line. Each line covers the
//   plan's requirement by a RequirementSupply RstPurchaseRequest, so a competing conversion is DEMAND_ALREADY_COVERED; the
//   request's approval then makes its own requirements, which RequestSourcing sources (P10);
// - the drop-ship route, a buyer's choice for customer-order demand: each approved customer order line of the requirement
//   moved to the supplier's drop-ship facility by mantle.order.DropShipServices.route#OrderItemToDropShip (P7), which buys it
//   on a drop-ship purchase order; the purchase order line covers the requirement (RequirementSupply RstPurchaseOrder). A line
//   of an order not yet approved is passed over by name (DROP_SHIP_PENDING when none is routed); what the customer lines do
//   not cover stays to convert;
// - supply: the lines of the organization's purchase requests at the facilities that are not yet ordered count as supply
//   to the plan, in the product's stock unit: an approved request's (In Progress), and a submitted one's that a conversion
//   made (it covers the plan's demand while it waits for approval), so an approved request's demand is not suggested again;
//   a draft's do not count. A submitted request refused at its revision is shown and not netted (review R1), so its demand
//   is suggested again rather than hidden while the request waits to be changed or cancelled; a line whose unit has no
//   conversion to the stock unit is shown and not netted, named (review R2).
// Nothing here checks a permission of its own: convert#PlanningSuggestions checked PURCHASE_ORDER_EDIT and the
// organization, and the services called check theirs again.
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const policyModule = ec.resource.script("component://mr-mantle/service/mantle/order/PurchasePolicy.js")
const purchaseRequests = () => ec.resource.script("component://mr-mantle/service/mantle/request/PurchaseRequests.js")
const methodPolicy = () => ec.resource.script("component://mr-mantle/service/mantle/product/MethodPolicy.js")
const {find, one, rows, call, probe, denied, ms} = lib

const SUGGESTION = "mantle.request.requirement.PlanningSuggestion",
    SUPPLY = "mantle.request.requirement.RequirementSupply",
    REQUIREMENT = "mantle.request.requirement.Requirement",
    REQUIREMENT_ORDER = "mantle.request.requirement.RequirementOrderItem",
    REQUEST = "mantle.request.Request",
    REQUEST_ITEM = "mantle.request.RequestItem",
    REQUEST_PARTY = "mantle.request.RequestParty",
    ITEM_ORDER = "mantle.request.RequestItemOrder",
    ORDER = "mantle.order.OrderHeader",
    PART = "mantle.order.OrderPart",
    ITEM = "mantle.order.OrderItem",
    DECISION = "mantle.order.purchase.PurchaseApprovalDecision"
const R = "mantle.request.RequestServices."
const routes = ["order", "request", "dropShip"]
const deadOrderStatuses = ["OrderCancelled", "OrderRejected"]
const openSalesStatuses = ["OrderPlaced", "OrderProcessing", "OrderApproved", "OrderSent", "OrderHold"]
const boughtSalesStatuses = ["OrderApproved", "OrderSent", "OrderProcessing"]

const blank = value => value == null || String(value).trim() === ""
const dec = value => toDecimal(value == null || value === "" ? 0 : value)
const zero = () => toDecimal(0)
const text = value => (value == null ? null : dec(value).compare(0) === 0 ? "0" : String(dec(value).toNumber()))
const min = (a, b) => (a.compare(b) < 0 ? a : b)
const isInternal = partyId => !!partyId && !!one("mantle.party.PartyRole", {partyId, roleTypeId: "OrgInternal"})

// ===== the route =====
// The route the organization's buying policy gives a buy conversion now: request where it sends plan buys to purchase
// requests, else order.
function policyRoute(organizationPartyId) {
    return policyModule.effective(organizationPartyId).policy.planBuyToRequest === "Y" ? "request" : "order"
}
// A buy conversion's route: the one asked for (dropShip, request, or order), else the policy's; an order where the policy
// sends plan buys to purchase requests is refused (ROUTE_NOT_ALLOWED), the request's approval being the policy's gate.
function routeOf(organizationPartyId, given) {
    const policy = policyRoute(organizationPartyId)
    if (blank(given)) return policy
    if (!routes.includes(String(given))) denied("ROUTE_INVALID", "Choose the order, request or drop-ship route")
    if (given === "order" && policy === "request")
        denied("ROUTE_NOT_ALLOWED", "The buying policy sends plan buys to purchase requests for approval")
    return String(given)
}

// ===== customer demand =====
// The open customer order lines a requirement covers (its RequirementOrderItem rows to a sales part's line), each with its
// quantity in the requirement, oldest line first.
function customerLines(requirementId) {
    return rows(REQUIREMENT_ORDER, {requirementId})
        .map(link => {
            const item = one(ITEM, {orderId: link.orderId, orderItemSeqId: link.orderItemSeqId})
            const part = item ? one(PART, {orderId: item.orderId, orderPartSeqId: item.orderPartSeqId}) : null
            const header = item ? one(ORDER, {orderId: item.orderId}) : null
            if (!part || !header || !isInternal(part.vendorPartyId) || isInternal(part.customerPartyId)) return null
            if (!openSalesStatuses.includes(header.statusId)) return null
            return {
                orderId: link.orderId,
                orderItemSeqId: link.orderItemSeqId,
                statusId: header.statusId,
                quantity: dec(link.quantity ?? item.quantity),
                requiredByDate: item.requiredByDate || part.shipBeforeDate || null
            }
        })
        .filter(Boolean)
        .sort((a, b) => (a.orderId + a.orderItemSeqId).localeCompare(b.orderId + b.orderItemSeqId))
}

// ===== convert =====
function convert(route, p, c) {
    return route === "request" ? convertRequest(p, c) : convertDropShip(p, c)
}
// The request route: the suggestion's remaining quantity as lines of a draft purchase request of the organization for its
// facility (the call's earlier one when given), each covering the requirement; the request is sent to its approval by
// submitRequests once the call's lines are in.
function convertRequest(p, c) {
    const {suggestion, run, requirement, remaining} = c
    c.buyChecks(suggestion, run, remaining)
    const organizationPartyId = run.organizationPartyId
    let requestId = null
    if (!blank(p.requestId)) {
        const earlier = one(REQUEST, {requestId: p.requestId})
        const organization = rows(REQUEST_PARTY, {requestId: p.requestId, roleTypeId: "OrgInternal"})[0]?.partyId
        if (
            earlier?.statusId === "ReqDraft" &&
            earlier.facilityId === suggestion.facilityId &&
            organization === organizationPartyId
        )
            requestId = earlier.requestId
    }
    if (!requestId)
        requestId = call(R + "create#PurchaseRequest", {
            organizationPartyId,
            requestName: "Replenishment from supply plan " + run.planningRunId,
            facilityId: suggestion.facilityId,
            description: "Buy suggestions of supply plan " + run.planningRunId + ", sent for approval by the buying policy"
        }).requestId
    const product = one("mantle.product.Product", {productId: suggestion.productId})
    const quantityUomId = suggestion.quantityUomId || requirement.quantityUomId || product?.amountUomId || null
    const price = priceOf(suggestion, organizationPartyId, remaining, quantityUomId, requestId)
    // a line per customer order line (its RequestItemOrder), then the rest
    const parts = []
    let left = remaining
    for (const line of customerLines(requirement.requirementId)) {
        if (left.compare(0) <= 0) break
        const quantity = min(line.quantity, left)
        parts.push({quantity, customerLine: line, requiredByDate: line.requiredByDate})
        left = left.subtract(quantity)
    }
    if (left.compare(0) > 0) parts.push({quantity: left, customerLine: null, requiredByDate: null})
    const requestItemSeqIds = []
    for (const part of parts) {
        const stored = call(R + "store#PurchaseRequestItem", {
            requestId,
            productId: suggestion.productId,
            quantity: part.quantity,
            quantityUomId,
            requiredByDate: part.requiredByDate || suggestion.requiredByDate || requirement.requiredByDate || null,
            supplierPartyId: suggestion.supplierPartyId,
            maximumAmount: price == null ? null : price.multiply(part.quantity),
            description:
                (product?.productName || suggestion.productId) +
                (part.customerLine
                    ? " for customer order " + part.customerLine.orderId + " line " + part.customerLine.orderItemSeqId
                    : "")
        })
        const requestItemSeqId = stored.requestItemSeqId
        if (part.customerLine)
            call("create#" + ITEM_ORDER, {
                requestId,
                requestItemSeqId,
                orderId: part.customerLine.orderId,
                orderItemSeqId: part.customerLine.orderItemSeqId,
                quantity: part.quantity
            })
        call("create#" + SUPPLY, {
            requirementId: requirement.requirementId,
            supplyTypeEnumId: "RstPurchaseRequest",
            requestId,
            requestItemSeqId,
            quantity: part.quantity,
            quantityUomId,
            planningSuggestionId: suggestion.planningSuggestionId,
            operationKey: p.operationKey,
            fromDate: ec.user.nowTimestamp,
            createdByUserId: ec.user.userId
        })
        requestItemSeqIds.push(requestItemSeqId)
    }
    covered(requirement, suggestion, c)
    return {
        resultCode: "CREATED",
        route: "request",
        requirementId: requirement.requirementId,
        requestId,
        requestItemSeqId: requestItemSeqIds[0],
        requestItemSeqIds,
        supplierPartyId: suggestion.supplierPartyId,
        facilityId: suggestion.facilityId,
        quantity: text(remaining)
    }
}
// The supplier's price of a line for the request's most to pay, as the buyer may read it, in the request's currency; null
// when none (the approvers are told the line has no amount, F-P10-2).
function priceOf(suggestion, organizationPartyId, quantity, quantityUomId, requestId) {
    try {
        const price = call("mantle.product.PriceServices.get#ProductPrice", {
            productId: suggestion.productId,
            quantity,
            quantityUomId,
            vendorPartyId: suggestion.supplierPartyId,
            customerPartyId: organizationPartyId,
            organizationPartyId,
            pricePurposeEnumId: "PppPurchase",
            priceUomId: one(REQUEST, {requestId})?.currencyUomId || null,
            direction: "purchase",
            validDate: ec.user.nowTimestamp
        })
        return price.priceAvailable ? dec(price.price) : null
    } catch (error) {
        ec.logger.warn("Supply plan: no price for " + suggestion.productId + ": " + error.message)
        return null
    }
}
// The drop-ship route: each approved customer order line of the requirement moved to the supplier's drop-ship facility
// (route#OrderItemToDropShip, which buys it), its purchase order line covering the requirement up to what remains.
function convertDropShip(p, c) {
    const {suggestion, run, requirement, remaining} = c
    c.buyChecks(suggestion, run, remaining)
    const lines = customerLines(requirement.requirementId)
    if (!lines.length)
        denied(
            "NO_CUSTOMER_LINE",
            "The suggestion of " + suggestion.productId + " covers no customer order line to drop-ship; convert it to an order"
        )
    const supplierPartyId = blank(p.supplierPartyId) ? suggestion.supplierPartyId : String(p.supplierPartyId)
    const routed = [],
        pending = []
    let left = remaining
    for (const line of lines) {
        if (left.compare(0) <= 0) break
        if (!boughtSalesStatuses.includes(line.statusId)) {
            pending.push(line.orderId + " line " + line.orderItemSeqId)
            continue
        }
        call("mantle.order.DropShipServices.route#OrderItemToDropShip", {
            orderId: line.orderId,
            orderItemSeqId: line.orderItemSeqId,
            supplierPartyId
        })
        const poLine = Array.from(
            find(ITEM).condition("salesOrderId", line.orderId).condition("salesOrderItemSeqId", line.orderItemSeqId).list()
        ).find(row => !deadOrderStatuses.includes(one(ORDER, {orderId: row.orderId})?.statusId))
        if (!poLine)
            denied(
                "DROP_SHIP_PENDING",
                "Customer order " + line.orderId + " line " + line.orderItemSeqId + " has no drop-ship purchase order yet"
            )
        const quantity = min(line.quantity, left)
        call("create#" + SUPPLY, {
            requirementId: requirement.requirementId,
            supplyTypeEnumId: "RstPurchaseOrder",
            orderId: poLine.orderId,
            orderItemSeqId: poLine.orderItemSeqId,
            quantity,
            quantityUomId: suggestion.quantityUomId || requirement.quantityUomId || null,
            planningSuggestionId: suggestion.planningSuggestionId,
            operationKey: p.operationKey,
            fromDate: ec.user.nowTimestamp,
            createdByUserId: ec.user.userId
        })
        left = left.subtract(quantity)
        routed.push({
            orderId: line.orderId,
            orderItemSeqId: line.orderItemSeqId,
            purchaseOrderId: poLine.orderId,
            purchaseOrderItemSeqId: poLine.orderItemSeqId,
            quantity: text(quantity)
        })
    }
    if (!routed.length)
        denied("DROP_SHIP_PENDING", "Customer order " + pending.join(", ") + " is not approved, so it cannot be drop-shipped yet")
    covered(requirement, suggestion, c)
    return {
        resultCode: "CREATED",
        route: "dropShip",
        requirementId: requirement.requirementId,
        orderId: routed[0].purchaseOrderId,
        orderItemSeqId: routed[0].purchaseOrderItemSeqId,
        routedLines: routed,
        pendingLines: pending,
        supplierPartyId,
        facilityId: suggestion.facilityId,
        quantity: text(remaining.subtract(left)),
        remainingQuantity: text(left)
    }
}
// The requirement accepted, and Ordered and the suggestion converted once it is covered; partly covered, the suggestion is
// partly converted and the rest stays to convert.
function covered(requirement, suggestion, c) {
    const full = c.coveredOf(requirement.requirementId).compare(dec(requirement.quantity)) >= 0
    if (["RqmtStProposed", "RqmtStCreated"].includes(requirement.statusId))
        call("update#" + REQUIREMENT, {requirementId: requirement.requirementId, statusId: "RqmtStApproved"})
    if (full) call("update#" + REQUIREMENT, {requirementId: requirement.requirementId, statusId: "RqmtStOrdered"})
    call("update#" + SUGGESTION, {
        planningSuggestionId: suggestion.planningSuggestionId,
        stateEnumId: full ? "PssConverted" : "PssPartial"
    })
}
// The purchase requests a call made, each sent to its approval in its own transaction; a failure is named on the
// suggestions it holds and the request stays a draft (its lines still cover the plan's demand, for the buyer to submit).
function submitRequests(requestIds, results) {
    return requestIds.map(requestId => {
        try {
            const submitted = probe(R + "submit#PurchaseRequest", {requestId})
            return {requestId, submitted: true, statusId: submitted.statusId, notifiedCount: submitted.notifiedCount || 0}
        } catch (error) {
            const message = String(error.message || error).replace(/^(Error: )+/, "")
            ec.logger.warn("Supply plan: purchase request " + requestId + " was not submitted: " + message)
            for (const row of results.filter(each => each.requestId === requestId))
                row.message = "Purchase request " + requestId + " is a draft: " + message
            return {requestId, submitted: false, statusId: "ReqDraft", message}
        }
    })
}

// ===== supply =====
// The lines of the organization's purchase requests for a product at the facilities still to order, as supply lines of the
// plan: an approved request's, and a submitted one's that a conversion made (its RequirementSupply RstPurchaseRequest).
// What is ordered is the line's RequestItemOrder rows to a live purchase order line (whose order line is supply of its own).
function requestSupply(organizationPartyId, facilityIds, productId) {
    const items = Array.from(
        find(REQUEST_ITEM, {productId}).condition("statusId", "in", ["ReqSubmitted", "ReqInProgress"]).list()
    )
    if (!items.length) return []
    const lines = []
    const requests = new Map()
    let stockUnit = null
    for (const item of items) {
        if (!requests.has(item.requestId)) {
            const request = one(REQUEST, {requestId: item.requestId})
            const organization = rows(REQUEST_PARTY, {requestId: item.requestId, roleTypeId: "OrgInternal"}).find(row =>
                lib.active(row)
            )?.partyId
            requests.set(
                item.requestId,
                request?.requestTypeEnumId === "RqtPurchase" &&
                    organization === organizationPartyId &&
                    facilityIds.includes(request.facilityId)
                    ? request
                    : null
            )
        }
        const request = requests.get(item.requestId)
        if (!request || !["ReqSubmitted", "ReqInProgress"].includes(request.statusId)) continue
        if (
            request.statusId === "ReqSubmitted" &&
            !rows(SUPPLY, {requestId: item.requestId, requestItemSeqId: item.requestItemSeqId}).some(
                row => row.supplyTypeEnumId === "RstPurchaseRequest" && !ended(row)
            )
        )
            continue
        const ordered = rows(ITEM_ORDER, {requestId: item.requestId, requestItemSeqId: item.requestItemSeqId}).reduce(
            (total, link) => {
                const line = one(ITEM, {orderId: link.orderId, orderItemSeqId: link.orderItemSeqId})
                const part = line ? one(PART, {orderId: line.orderId, orderPartSeqId: line.orderPartSeqId}) : null
                if (!part || part.customerPartyId !== organizationPartyId) return total
                if (deadOrderStatuses.includes(one(ORDER, {orderId: link.orderId})?.statusId)) return total
                return total.add(dec(link.quantity ?? line.quantity))
            },
            zero()
        )
        let open = dec(item.quantity).subtract(ordered)
        if (open.compare(0) <= 0) continue
        const name = item.requestId + " line " + item.requestItemSeqId
        let label = (request.statusId === "ReqSubmitted" ? "Submitted purchase request " : "Purchase request ") + name
        let notNetted = false
        // a refused request covers nothing until it is changed and sent again (or cancelled): shown, not netted (review R1)
        if (request.statusId === "ReqSubmitted" && refusedNow(item.requestId)) {
            label = "Refused purchase request " + name + ", not netted until it is changed or cancelled"
            notNetted = true
        }
        // the line in the product's stock unit (F-P14b-4, review R2)
        if (stockUnit == null) stockUnit = one("mantle.product.Product", {productId})?.amountUomId || ""
        if (item.quantityUomId && stockUnit && item.quantityUomId !== stockUnit)
            try {
                open = methodPolicy().convert(open, item.quantityUomId, stockUnit, ec.user.nowTimestamp).quantity
            } catch (error) {
                label += ", not netted: " + String(error.message || error)
                notNetted = true
            }
        lines.push({
            kind: notNetted ? "requestNotNetted" : "request",
            label,
            requestId: item.requestId,
            requestItemSeqId: item.requestItemSeqId,
            date: item.requiredByDate || request.responseRequiredDate || null,
            quantity: open,
            supply: true,
            notNetted
        })
    }
    return lines
}
// Whether a submitted purchase request was refused at its revision (a decision PadRefused not superseded; PurchaseApprovals'
// progress): it waits for its requester to change it, so it is no supply.
function refusedNow(requestId) {
    const revision = purchaseRequests().revisionOf(requestId)
    return rows(DECISION, {sourceEntityName: REQUEST, sourceId: requestId}).some(
        row => row.decisionEnumId === "PadRefused" && !row.supersededDate && Number(row.sourceRevision) === revision
    )
}
const ended = row => !!row.thruDate && ms(row.thruDate) <= ms(ec.user.nowTimestamp)
// A cancelled purchase request's coverage of the plan's demand ended (its RequirementSupply RstPurchaseRequest rows), so
// the demand is the plan's to convert again (cancel#PurchaseRequest).
function releaseRequestSupply(requestId) {
    let released = 0
    for (const row of rows(SUPPLY, {requestId}).filter(each => each.supplyTypeEnumId === "RstPurchaseRequest" && !ended(each))) {
        call("update#" + SUPPLY, {requirementSupplyId: row.requirementSupplyId, thruDate: ec.user.nowTimestamp})
        released++
    }
    return released
}

;({
    policyRoute,
    routeOf,
    customerLines,
    convert,
    submitRequests,
    requestSupply,
    releaseRequestSupply
})
