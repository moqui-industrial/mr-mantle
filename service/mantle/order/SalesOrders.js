// Sales orders (mantle.order.SalesOrderServices, Q and S of IronStone Sales design §12.1; design §6 Orders and OrderDetail's
// sales-order context, §13.1, §16; impl-sales P11, §4 Nov 11 and Nov 13, F11, F12, F15, F52, F60, F61).
//
// - The seller's approval setting (SalesPolicy.orderApprovalRequired, SalesApprovals.js orderGateOn), respected globally: a sales
//   part (an internal vendor, a customer that is not internal) whose seller has it on is never approved automatically
//   (autoApprove#Order asks approvalWaits; every automatic approval goes through it, F52), and approve#Order's sales direction asks
//   SALES_ORDER_APPROVE in the user's sales scope and a current decision of each order rule the order meets (gateRefusal, from
//   PurchaseOrders.js approveRefusal). The callers that approve as built leave such an order placed: Customer Service's replacement
//   orders (ReturnServices.xml) and Projects' estimate approval (ProjectServices.xml, §4 Q12). With the setting off, its default,
//   every caller approves as before.
// - Sales' verbs over the native primitives (the guard before the primitive, never in place of it): create#SalesOrder (a direct
//   order, purpose OrpSalesOrder, through create#Order), its draft lines (SalesQuotes.js' line editor), place#SalesOrder (place#Order),
//   approve#SalesOrder (the order rules decided, then approve#Order and its credit check), hold#SalesOrder and release#SalesOrderHold
//   (a Manual or a Change hold only, through hold#Order and release#OrderHold, which check the permission of the type), cancel of the
//   remainder (cancel#OrderItem of each open line), clone#SalesOrder and apply#SalesOrderBatch (approve or close remainders, each
//   order on its own through the verbs above, so none skips the credit check, F12).
// - Access (SalesAccess.js orderOf): an order of the caller's sales scope, theirs, their team's or (SALES_TEAM_VIEW) the
//   organization's; an approver (SALES_ORDER_APPROVE) sees one awaiting approval or on hold, to decide it. Another's is missing.
// - find#SalesOrders (OrderList): the scoped orders by saved list (awaiting approval, held, to fulfill, part fulfilled, to invoice,
//   recent, drafts), with holds and shipped and billed progress by line unit and currency; carts, bases and templates excluded.
// - send#OrderConfirmation (X1, §4 Nov 11): a storeless sales order of Sales' (a direct order, an accepted quote) placed or approved
//   sends Customer Service's stored confirmation as placed (OrderConfirmations.js, F15) through the delivery ledger (MdsrcSalesOrder-
//   Confirmation), once for the order's revision and recipient; a store order keeps its store mail.
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const salesAccess = ec.resource.script("component://mr-mantle/service/mantle/sales/SalesAccess.js")
const {find, one, rows, denied, call, ms} = lib
const approvals = () => ec.resource.script("component://mr-mantle/service/mantle/order/SalesApprovals.js")
const quotes = () => ec.resource.script("component://mr-mantle/service/mantle/order/SalesQuotes.js")
const confirmations = () => ec.resource.script("component://mr-mantle/service/mantle/order/OrderConfirmations.js")

const ORDER = "mantle.order.OrderHeader"
const PART = "mantle.order.OrderPart"
const ITEM = "mantle.order.OrderItem"
const HOLD = "mantle.order.OrderHoldReason"
const PART_PARTY = "mantle.order.OrderPartParty"
const ORDER_LINK = "mantle.sales.opportunity.SalesOpportunityOrder"
const SOURCE = "mantle.shipment.ShipmentItemSource"
const BILLING = "mantle.order.OrderItemBilling"
const RESPONSE = "mantle.sales.quote.SalesQuoteResponse"
const SYSTEM_APPROVAL = "SalesSystemApproval"
const confirmationSource = "MdsrcSalesOrderConfirmation"
const confirmationTemplate = "MANTLE_SALES_ORDER_CONFIRMATION"
const confirmationEmailLocation = "component://mr-mantle/template/order/SalesOrderConfirmationEmail.html.fancy"
const taxTypes = ["ItemSalesTax", "ItemVatTax"]
const lineTypes = ["ItemProduct", "ItemShipping"]
const salesHolds = ["OhtManual", "OhtChange"]
const openStatuses = ["OrderPlaced", "OrderProcessing", "OrderApproved", "OrderHold"]
const fulfillStatuses = ["OrderApproved", "OrderProcessing"]
const lists = {
    recent: null,
    draft: ["OrderOpen"],
    awaiting: ["OrderPlaced"],
    held: ["OrderHold"],
    blocked: ["OrderPlaced", "OrderHold"],
    toFulfill: fulfillStatuses,
    partFulfilled: fulfillStatuses,
    toInvoice: ["OrderApproved", "OrderProcessing", "OrderSent", "OrderCompleted"],
    cancelled: ["OrderCancelled"]
}

const blank = value => value == null || String(value).trim() === ""
const text = value => (blank(value) ? null : String(value).trim())
const flag = value => value === true || value === "true" || value === "Y"
const L = value => ec.l10n.localize(value)
const revisionOf = order => Number(order?.orderRevision ?? 1)
const partyName = partyId => (partyId ? lib.partyNames([partyId])[partyId] || partyId : "")
const statusText = statusId => (statusId ? one("moqui.basic.StatusItem", {statusId})?.description || statusId : "")
const enumText = enumId => (enumId ? one("moqui.basic.Enumeration", {enumId})?.description || enumId : "")
const moneyText = (value, currencyUomId) =>
    value == null ? "" : ec.l10n.formatCurrency(ec.l10n.roundCurrency(toDecimal(value), currencyUomId), currencyUomId)
const quantityText = value => (value == null ? "" : String(Number(String(value))))
const dayText = value => (value == null || value === "" ? "" : ec.l10n.format(new Date(ms(value)), "d MMM yyyy"))
const likeText = value => "%" + String(value).replace(/[\\%_]/g, character => "\\" + character) + "%"

// ===== the seller's approval setting =====
const isSalesPart = part =>
    !!part?.vendorPartyId &&
    salesAccess.isInternal(part.vendorPartyId) &&
    !!part.customerPartyId &&
    !salesAccess.isInternal(part.customerPartyId)
// The sales parts of a list whose seller has the approval setting on.
function gatedParts(parts) {
    return Array.from(parts || []).filter(part => isSalesPart(part) && approvals().orderGateOn(part.vendorPartyId))
}
// Whether an order (or the part) waits for a Sales approver: a sales part whose seller has the setting on (autoApprove#Order, the
// replacement orders, Projects' estimate approval).
function approvalWaits(orderId, orderPartSeqId) {
    if (blank(orderId)) return false
    const parts = rows(PART, {orderId: String(orderId)}).filter(
        part => blank(orderPartSeqId) || part.orderPartSeqId === String(orderPartSeqId)
    )
    return gatedParts(parts).length > 0
}
// approve#Order's refusal for the gated parts (SalesApprovals.js orderApproveRefusal), or null.
function gateRefusal(orderId, parts) {
    const order = one(ORDER, {orderId: String(orderId)})
    if (!order) return null
    for (const part of parts) {
        const refusal = approvals().orderApproveRefusal(order, part)
        if (refusal) return refusal
    }
    return null
}
// Sales' own approval of an accepted net-terms order as the system (respond#Quote, the seller's approveNetTermsOrders while the
// approval setting is off): a claim for the one order that only this module sets, never a request parameter.
const systemApproval = orderId => !blank(orderId) && ec.context.sharedMap[SYSTEM_APPROVAL] === String(orderId)
function asSystemApproval(orderId, work) {
    const shared = ec.context.sharedMap,
        before = shared[SYSTEM_APPROVAL]
    shared[SYSTEM_APPROVAL] = String(orderId)
    try {
        return work()
    } finally {
        if (before == null) delete shared[SYSTEM_APPROVAL]
        else shared[SYSTEM_APPROVAL] = before
    }
}
// respond#Quote's option (SalesPolicy.approveNetTermsOrders, design §5, F60): an accepted order still placed, with the seller's
// approval setting off and no Sales rule open on it, approved as the system through approve#Order, whose credit check may hold it
// instead. Answers whether an approval was tried.
function approveAccepted(orderId) {
    const order = one(ORDER, {orderId: String(orderId)})
    if (!order || order.statusId !== "OrderPlaced") return false
    const parts = rows(PART, {orderId: order.orderId}).filter(isSalesPart)
    if (!parts.length || gatedParts(parts).length) return false
    if (!parts.every(part => approvals().policyOf(part.vendorPartyId)?.approveNetTermsOrders === "Y")) return false
    if (Array.from(approvals().preApproveWarnings({orderId: order.orderId}).approveWarnings || []).length) return false
    asSystemApproval(order.orderId, () => call("mantle.order.OrderServices.approve#Order", {orderId: order.orderId}))
    return true
}

// ===== the order the caller works on =====
function requireRevision(order, given) {
    if (blank(given)) denied("REVISION_REQUIRED", "Reload the order and try again (revision " + revisionOf(order) + ")")
    if (Number(given) !== revisionOf(order))
        denied("REVISION_CHANGED", "Order " + order.orderId + " changed; its current revision is " + revisionOf(order))
}
const isDirectDraft = so => so.order.orderPurposeEnumId === salesAccess.orderPurposes.direct && so.order.statusId === "OrderOpen"
function requireDirectDraft(so) {
    if (!isDirectDraft(so))
        denied("ORDER_NOT_DRAFT", "Order " + so.order.orderId + " is " + statusText(so.order.statusId) + ", not a draft")
}
// The order as the quote line editor reads a draft (SalesQuotes.js storeLineOf).
const asDraft = so => ({
    order: so.order,
    part: so.part,
    organizationPartyId: so.organizationPartyId,
    customerPartyId: so.customerPartyId,
    canEdit: so.canEdit
})
const linesOf = orderId => rows(ITEM, {orderId}).filter(item => lineTypes.includes(item.itemTypeEnumId) && !item.parentItemSeqId)

// ===== create#SalesOrder, its lines, place#SalesOrder =====
function createOrder(p) {
    return quotes().createDraft(p)
}
function storeLine(p) {
    const userScope = salesAccess.scope()
    const so = salesAccess.requireOrder(userScope, text(p.orderId), true)
    requireDirectDraft(so)
    return quotes().storeLineOf(userScope, asDraft(so), p)
}
function deleteLine(p) {
    const userScope = salesAccess.scope()
    const so = salesAccess.requireOrder(userScope, text(p.orderId), true)
    requireDirectDraft(so)
    return quotes().deleteLineOf(asDraft(so), p)
}
// The outcome of a placement or an approval: placed, approved or held (the order or a part on hold, or a hold open).
function outcomeOf(orderId) {
    const order = one(ORDER, {orderId})
    const held =
        order.statusId === "OrderHold" ||
        rows(PART, {orderId}).some(part => part.statusId === "OrderHold") ||
        rows(HOLD, {orderId}).some(row => !row.releasedDate)
    return {
        orderId,
        statusId: order.statusId,
        orderRevision: revisionOf(order),
        outcome: held
            ? "held"
            : ["OrderApproved", "OrderSent", "OrderCompleted", "OrderProcessing"].includes(order.statusId)
              ? "approved"
              : order.statusId === "OrderPlaced"
                ? "placed"
                : "other"
    }
}
function placeOrder(p) {
    const userScope = salesAccess.scope()
    const so = salesAccess.requireOrder(userScope, text(p.orderId), true)
    requireDirectDraft(so)
    requireRevision(so.order, p.orderRevision)
    if (!linesOf(so.order.orderId).some(item => item.itemTypeEnumId === "ItemProduct"))
        denied("LINES_REQUIRED", "Add a product line to order " + so.order.orderId + " first")
    // every placement goes through place#Order (impl-sales §2)
    call("mantle.order.OrderServices.place#Order", {orderId: so.order.orderId})
    return outcomeOf(so.order.orderId)
}

// ===== approve#SalesOrder =====
// The approval of a placed sales order the caller sees, at the revision they read: SALES_ORDER_APPROVE where the seller's setting is
// on, ORDER_APPROVE elsewhere (PERMISSION_DENIED); each order rule it meets decided by the caller (an OrderDecision of purpose
// SapOrder; SELF_APPROVAL for its owner, who entered or placed it, unless the rule allows it; APPROVER_INVALID outside its group);
// then approve#Order, whose credit check may hold it (outcome held). Pre-approval warnings refuse nothing. The same operation key
// answers the first result.
function approveOrder(p) {
    const userScope = salesAccess.scope()
    // a retry answers the first result even once the approval took the order out of the approver's sight (the key is the caller's)
    const seller = blank(p.orderId) ? null : rows(PART, {orderId: String(p.orderId)})[0]?.vendorPartyId || null
    const operation = !blank(p.operationKey)
        ? lib.operation(p, "SalesOrderApprove", seller, {orderId: text(p.orderId), orderRevision: p.orderRevision ?? null})
        : null
    if (operation?.old) return lib.previous(operation)
    const so = salesAccess.orderOf(userScope, text(p.orderId))
    if (!so) denied("RECORD_UNAVAILABLE", "Order " + (p.orderId || "") + " is not available")
    const gated = gatedParts(so.parts).length > 0
    if (gated ? !userScope.capabilities.orderApprove : !ec.user.hasPermission("ORDER_APPROVE"))
        denied(
            "PERMISSION_DENIED",
            (gated ? "SALES_ORDER_APPROVE" : "ORDER_APPROVE") + " is required to approve order " + so.order.orderId
        )
    const order = find(ORDER, {orderId: so.order.orderId}).forUpdate(true).one()
    if (order.statusId !== "OrderPlaced")
        denied("ORDER_NOT_PLACED", "Order " + order.orderId + " is " + statusText(order.statusId) + ", not waiting for approval")
    requireRevision(order, p.orderRevision)
    const decidedCount = approvals().decideOrderRules(userScope, order, so.part)
    const approved = call("mantle.order.OrderServices.approve#Order", {orderId: order.orderId})
    const result = Object.assign(outcomeOf(order.orderId), {
        decidedCount,
        creditHeld: !!approved.creditHeld,
        creditWarning: approved.creditWarning || null
    })
    if (operation) lib.complete(operation, ORDER, order.orderId, result)
    return Object.assign(result, {alreadyApplied: false})
}

// ===== holds =====
// hold#SalesOrder: a Manual or a Change hold of an order the caller sees (hold#Order checks the type's permission: ORDER_APPROVE for
// Manual, ORDER_CHANGE_HOLD_RELEASE or SALES_ORDER_CHANGE for Change); Sales never places a Credit, Purchase or Payment hold.
function holdOrder(p) {
    const userScope = salesAccess.scope()
    const so = salesAccess.requireOrder(userScope, text(p.orderId))
    const holdTypeEnumId = text(p.holdTypeEnumId) || "OhtManual"
    if (!salesHolds.includes(holdTypeEnumId)) denied("HOLD_TYPE_INVALID", "Sales places a Manual or a Change hold")
    const holdComment = text(p.holdComment)
    if (!holdComment) denied("COMMENT_REQUIRED", "Give the reason for the hold")
    const out = call("mantle.order.OrderServices.hold#Order", {orderId: so.order.orderId, holdTypeEnumId, holdComment})
    return Object.assign(outcomeOf(so.order.orderId), {orderHoldReasonId: out.orderHoldReasonId, alreadyHeld: !!out.alreadyHeld})
}
// release#SalesOrderHold: a Manual or a Change hold of an order the caller sees, released with its comment (release#OrderHold checks
// the type's permission and returns the order where it was once no other hold is open).
function releaseHold(p) {
    const userScope = salesAccess.scope()
    const reason = blank(p.orderHoldReasonId) ? null : one(HOLD, {orderHoldReasonId: String(p.orderHoldReasonId)})
    const so = reason ? salesAccess.orderOf(userScope, reason.orderId) : null
    if (!reason || !so) denied("HOLD_UNAVAILABLE", "The hold is not available")
    if (!salesHolds.includes(reason.holdTypeEnumId))
        denied("HOLD_TYPE_DENIED", enumText(reason.holdTypeEnumId) + " holds are released by their owner, not in Sales")
    const releaseComment = text(p.releaseComment)
    if (!releaseComment) denied("COMMENT_REQUIRED", "Give the reason for the release")
    call("mantle.order.OrderServices.release#OrderHold", {orderHoldReasonId: reason.orderHoldReasonId, releaseComment})
    return outcomeOf(so.order.orderId)
}

// ===== cancel the remainder, clone =====
// cancel#SalesOrderRemainder: each line's quantity not yet issued cancelled (cancel#OrderItem; the shipped and billed history kept),
// for an order the caller may change, at its revision, while it is open.
function cancelRemainder(p) {
    const userScope = salesAccess.scope()
    const so = salesAccess.requireOrder(userScope, text(p.orderId), true)
    if (!openStatuses.includes(so.order.statusId))
        denied("ORDER_NOT_OPEN", "Order " + so.order.orderId + " is " + statusText(so.order.statusId))
    requireRevision(so.order, p.orderRevision)
    let cancelledCount = 0
    for (const item of linesOf(so.order.orderId)) {
        const left = toDecimal(item.quantity ?? 0).subtract(toDecimal(item.quantityCancelled ?? 0))
        if (left.compare(0) <= 0) continue
        const out = call("mantle.order.OrderServices.cancel#OrderItem", {
            orderId: so.order.orderId,
            orderItemSeqId: item.orderItemSeqId
        })
        if (out.quantityCancelled != null && toDecimal(out.quantityCancelled).compare(0) > 0) cancelledCount++
    }
    if (!cancelledCount) denied("NOTHING_TO_CANCEL", "Order " + so.order.orderId + " has no quantity left to cancel")
    return Object.assign(outcomeOf(so.order.orderId), {cancelledCount})
}
// clone#SalesOrder: a copy as a new direct order draft of the caller (clone#Order without files, notes or payments; retaxed).
function cloneOrder(p) {
    const userScope = salesAccess.scope()
    const so = salesAccess.requireOrder(userScope, text(p.orderId), true)
    const cloned = call("mantle.order.OrderServices.clone#Order", {
        baseOrderId: so.order.orderId,
        statusId: "OrderOpen",
        orderPurposeEnumId: salesAccess.orderPurposes.direct,
        orderName: so.order.orderName ? L("Copy of") + " " + so.order.orderName : null,
        productItemsOnly: false,
        copyContent: false,
        copyNote: false,
        copyPayment: false,
        copyItemWorkEffort: false
    })
    const orderId = cloned.orderId
    const part = rows(PART, {orderId})[0]
    for (const row of rows(PART_PARTY, {orderId, roleTypeId: salesAccess.quoteRoles.owner}))
        call("delete#" + PART_PARTY, {
            orderId,
            orderPartSeqId: row.orderPartSeqId,
            partyId: row.partyId,
            roleTypeId: row.roleTypeId
        })
    if (userScope.partyId)
        call("create#" + PART_PARTY, {
            orderId,
            orderPartSeqId: part.orderPartSeqId,
            partyId: userScope.partyId,
            roleTypeId: salesAccess.quoteRoles.owner
        })
    call("update#" + PART, {
        orderId,
        orderPartSeqId: part.orderPartSeqId,
        validFromDate: null,
        validThruDate: null,
        otherPartyOrderId: null
    })
    call("mantle.order.OrderServices.handle#OrderMajorChange", {orderId, orderPartSeqId: part.orderPartSeqId})
    return {orderId, orderRevision: revisionOf(one(ORDER, {orderId}))}
}

// ===== apply#SalesOrderBatch =====
// Approve or close the remainders of the orders chosen ("orderId@revision"), each on its own through approve#SalesOrder (so its
// credit check runs, F12) or cancel#SalesOrderRemainder, in its own transaction with its own operation key; a refused one is named
// with its reason and the rest go on.
function applyBatch(p) {
    salesAccess.requireCapability(salesAccess.scope(), "anyRead")
    const operation = text(p.operation)
    if (!["approve", "close"].includes(operation)) denied("OPERATION_INVALID", "Choose approve or close")
    if (blank(p.operationKey)) denied("OPERATION_KEY_REQUIRED", "A batch carries an operation key")
    const value = p.orderKeys
    const keys = Array.from(
        new Set(
            (value == null ? [] : typeof value === "string" ? value.split(",") : Array.from(value))
                .map(key => text(key))
                .filter(Boolean)
        )
    )
    if (!keys.length) denied("SELECTION_REQUIRED", "Choose the orders")
    const results = []
    for (const key of keys) {
        const [orderId, orderRevision] = key.split("@")
        const itemKey = (String(p.operationKey) + "-" + orderId).slice(-40)
        try {
            if (operation === "approve") {
                const out = lib.probe("mantle.order.SalesOrderServices.approve#SalesOrder", {
                    orderId,
                    orderRevision: orderRevision || "",
                    operationKey: itemKey
                })
                results.push({orderId, ok: true, reasonCode: null, outcome: out.outcome, message: L(out.outcome || "")})
            } else {
                const out = lib.probe("mantle.order.SalesOrderServices.cancel#SalesOrderRemainder", {
                    orderId,
                    orderRevision: orderRevision || ""
                })
                results.push({orderId, ok: true, reasonCode: null, outcome: out.outcome, message: ""})
            }
        } catch (error) {
            results.push({orderId, ok: false, reasonCode: lib.reasonCode(error), message: String(error.message || error)})
        }
    }
    return {results, successCount: results.filter(row => row.ok).length}
}

// ===== find#SalesOrders =====
// The scoped sales orders (design §6 OrderList) of a saved list, filtered by organization, customer, opportunity, owner (mine),
// store and text, paged in the query; each row with its customer (unnamed when the account is not the caller's to see), seller,
// state, total, holds and progress (shipped by line unit, billed by currency), and for the awaiting list its pre-approval warnings.
function internalPartyIds() {
    return Array.from(new Set(rows("mantle.party.PartyRole", {roleTypeId: "OrgInternal"}).map(row => row.partyId)))
}
const distinctOrderIds = entity =>
    Array.from(
        new Set(
            Array.from(find(entity).condition("orderId", "is-not-null", null).selectField("orderId").distinct(true).list()).map(
                row => row.orderId
            )
        )
    )
function findOrders(p) {
    const userScope = salesAccess.scope()
    salesAccess.requireCapability(userScope, "anyRead")
    const organizationPartyId = text(p.organizationPartyId)
    if (organizationPartyId) salesAccess.requireOrganization(userScope, organizationPartyId)
    const list = text(p.list) || "recent"
    if (!Object.hasOwn(lists, list)) denied("LIST_INVALID", "Choose an order list")
    const factory = ec.entity.conditionFactory
    const conditions = []
    const add = (field, operator, value) => conditions.push(factory.makeCondition(field, operator, value))
    const or = (...parts) => conditions.push(factory.makeCondition(parts, "or"))
    let none = false
    if (organizationPartyId) add("vendorPartyId", "equals", organizationPartyId)
    else if (userScope.organizationPartyIds != null) {
        if (!userScope.organizationPartyIds.length) none = true
        else add("vendorPartyId", "in", Array.from(userScope.organizationPartyIds))
    }
    const internal = internalPartyIds()
    add("vendorPartyId", "in", internal)
    add("customerPartyId", "is-not-null", null)
    add("customerPartyId", "not-in", internal)
    // Sales' kind (SalesAccess.js isSalesOrder): no template or base, a quote once placed, an open order only when it is a direct draft
    or(
        factory.makeCondition("orderPurposeEnumId", "is-null", null),
        factory.makeCondition("orderPurposeEnumId", "not-in", salesAccess.orderExcludedPurposes)
    )
    or(
        factory.makeCondition("orderPurposeEnumId", "is-null", null),
        factory.makeCondition("orderPurposeEnumId", "not-equals", salesAccess.quotePurpose),
        factory.makeCondition("placedDate", "is-not-null", null)
    )
    or(
        factory.makeCondition("statusId", "not-equals", "OrderOpen"),
        factory.makeCondition("orderPurposeEnumId", "equals", salesAccess.orderPurposes.direct)
    )
    // the caller's and their teams' (null: the organization's every one); an approver also the orders awaiting approval or held
    let ids = salesAccess.assignedOrderIds(userScope)
    const narrow = found => {
        ids = ids == null ? found : ids.filter(id => found.includes(id))
    }
    const ownerPartyId = flag(p.mine) ? userScope.partyId : text(p.ownerPartyId)
    const withRole = (roleTypeId, partyId) =>
        Array.from(find(PART_PARTY, {roleTypeId, partyId}).selectField("orderId").list()).map(row => row.orderId)
    const approverReach = ids != null && salesAccess.orderApprover(userScope) && !ownerPartyId
    // P14: a change operator also the organization's placed, approved and held orders, read only (SalesAccess.js orderOf)
    const changeReach = ids != null && !!userScope.capabilities.orderChange && !ownerPartyId
    if (ownerPartyId) narrow(withRole(salesAccess.quoteRoles.owner, ownerPartyId))
    if (text(p.salesOpportunityId)) {
        const linked = rows(ORDER_LINK, {salesOpportunityId: text(p.salesOpportunityId)}).map(row => row.orderId)
        if (ids == null || !(approverReach || changeReach)) narrow(linked)
        else {
            ids = ids.filter(id => linked.includes(id))
            add("orderId", "in", linked.length ? linked : ["_NONE_"])
        }
    }
    if (ids != null) {
        if (approverReach || changeReach) {
            // P12 (the user's call of Nov 14): and the orders the approver decided, read only, once approved (SalesAccess.js orderOf)
            const decided = approverReach ? salesAccess.decidedOrderIds() : []
            const reach = [factory.makeCondition("orderId", "in", ids.length ? ids : ["_NONE_"])]
            if (approverReach)
                reach.push(
                    factory.makeCondition("statusId", "in", ["OrderPlaced", "OrderHold"]),
                    factory.makeCondition("orderId", "in", decided.length ? decided : ["_NONE_"])
                )
            if (changeReach) reach.push(factory.makeCondition("statusId", "in", salesAccess.changeStatuses))
            or(...reach)
        } else if (!ids.length) none = true
        else add("orderId", "in", ids)
    }
    if (text(p.customerPartyId)) add("customerPartyId", "equals", text(p.customerPartyId))
    if (text(p.productStoreId)) add("productStoreId", "equals", text(p.productStoreId))
    if (lists[list]) add("statusId", "in", lists[list])
    if (["partFulfilled", "toInvoice", "toFulfill"].includes(list)) {
        const shipped = distinctOrderIds(SOURCE)
        if (list === "toFulfill") {
            if (shipped.length) add("orderId", "not-in", shipped)
        } else if (!shipped.length) none = true
        else add("orderId", "in", shipped)
        if (list === "toInvoice") {
            const billed = distinctOrderIds(BILLING)
            if (billed.length) add("orderId", "not-in", billed)
        }
    }
    const term = text(p.text)
    if (term)
        conditions.push(
            factory.makeCondition(
                ["orderId", "orderName", "otherPartyOrderId"].map(field =>
                    factory.makeCondition(field, "like", likeText(term)).ignoreCase()
                ),
                "or"
            )
        )
    const query = () => {
        let found = find("mantle.order.OrderHeaderAndPart")
        for (const condition of conditions) found = found.condition(condition)
        return found
            .selectField("orderId")
            .selectField("orderName")
            .selectField("statusId")
            .selectField("entryDate")
            .selectField("placedDate")
            .selectField("grandTotal")
            .selectField("currencyUomId")
            .selectField("orderRevision")
            .selectField("vendorPartyId")
            .selectField("customerPartyId")
            .selectField("productStoreId")
            .selectField("orderPurposeEnumId")
            .selectField("otherPartyOrderId")
            .distinct(true)
    }
    const orderBy = text(p.orderByField)
    const sort =
        orderBy && /^[-+^]?(orderName|entryDate|placedDate|grandTotal)$/.test(orderBy)
            ? [orderBy, "orderId"]
            : ["-entryDate", "orderId"]
    const count = none ? 0 : query().count()
    const paged = lib.page(none ? query().condition("orderId", "_NONE_") : query().orderBy(sort), p, "orderList", count, {
        noLimitCap: 1000
    })
    const pageRows = paged.rows
    const orderIds = pageRows.map(row => row.orderId)
    const names = lib.partyNames(pageRows.flatMap(row => [row.vendorPartyId, row.customerPartyId]))
    const owners = {}
    if (orderIds.length)
        for (const row of find(PART_PARTY)
            .condition("orderId", "in", orderIds)
            .condition("roleTypeId", salesAccess.quoteRoles.owner)
            .list())
            owners[row.orderId] = row.partyId
    const ownerNames = lib.partyNames(Object.values(owners))
    const holds = {}
    if (orderIds.length)
        for (const row of find(HOLD).condition("orderId", "in", orderIds).condition("releasedDate", "is-null", null).list())
            (holds[row.orderId] = holds[row.orderId] || []).push(enumText(row.holdTypeEnumId))
    const progress = progressOf(orderIds)
    const statusNames = {}
    const orderList = pageRows.map(row => {
        statusNames[row.statusId] = statusNames[row.statusId] || statusText(row.statusId)
        const account = salesAccess.accountOf(userScope, row.customerPartyId)
        const out = {
            orderId: row.orderId,
            orderName: row.orderName || row.orderId,
            statusId: row.statusId,
            statusText: statusNames[row.statusId],
            orderRevision: revisionOf(row),
            customerPartyId: account ? row.customerPartyId : null,
            customerName: account ? names[row.customerPartyId] || row.customerPartyId : "",
            organizationName: names[row.vendorPartyId] || row.vendorPartyId,
            otherPartyOrderId: row.otherPartyOrderId || "",
            kindText: kindText(row),
            grandTotal: row.grandTotal,
            currencyUomId: row.currencyUomId,
            totalText: moneyText(row.grandTotal ?? 0, row.currencyUomId),
            placedText: dayText(row.placedDate),
            entryText: dayText(row.entryDate),
            ownerName: owners[row.orderId] ? ownerNames[owners[row.orderId]] || owners[row.orderId] : "",
            holdsText: Array.from(new Set(holds[row.orderId] || [])).join(", "),
            shippedText: progress[row.orderId]?.shippedText || "",
            billedText: progress[row.orderId]?.billedText || "",
            warningsText: ""
        }
        if (list === "awaiting") out.warningsText = warningsOf(row.orderId).join("; ")
        return out
    })
    const result = Object.assign({}, paged)
    delete result.rows
    result.orderList = orderList
    return result
}
// The kind of an order for its row: direct, an accepted quote, a store's, or another app's.
function kindText(row) {
    if (row.orderPurposeEnumId === salesAccess.orderPurposes.direct) return L("Direct")
    if (row.orderPurposeEnumId === salesAccess.quotePurpose) return L("From quote")
    if (row.productStoreId) return L("Store")
    return L("Other")
}
// Shipped quantities per line unit and billed amounts per currency, never summed across units (design §6).
function progressOf(orderIds) {
    const found = {}
    if (!orderIds.length) return found
    const items = Array.from(find(ITEM).condition("orderId", "in", orderIds).condition("itemTypeEnumId", "ItemProduct").list())
    const shipped = {}
    for (const row of Array.from(find(SOURCE).condition("orderId", "in", orderIds).list())) {
        const key = row.orderId + "/" + row.orderItemSeqId
        shipped[key] = toDecimal(shipped[key] ?? 0).add(toDecimal(row.quantity ?? 0))
    }
    const billed = {}
    for (const row of Array.from(find(BILLING).condition("orderId", "in", orderIds).list()))
        billed[row.orderId] = toDecimal(billed[row.orderId] ?? 0).add(
            toDecimal(row.amount ?? 0).multiply(toDecimal(row.quantity ?? 1))
        )
    const orders = Object.fromEntries(
        Array.from(find(ORDER).condition("orderId", "in", orderIds).list()).map(row => [row.orderId, row])
    )
    for (const orderId of orderIds) {
        const units = {}
        for (const item of items.filter(row => row.orderId === orderId)) {
            const unit = item.quantityUomId || "OTH_ea"
            const entry = (units[unit] = units[unit] || {ordered: toDecimal(0), shipped: toDecimal(0)})
            entry.ordered = entry.ordered.add(toDecimal(item.quantity ?? 0).subtract(toDecimal(item.quantityCancelled ?? 0)))
            entry.shipped = entry.shipped.add(toDecimal(shipped[orderId + "/" + item.orderItemSeqId] ?? 0))
        }
        const order = orders[orderId]
        found[orderId] = {
            shippedText: Object.entries(units)
                .map(
                    ([unit, entry]) =>
                        quantityText(entry.shipped) + " / " + quantityText(entry.ordered) + (unit === "OTH_ea" ? "" : " " + unit)
                )
                .join(", "),
            billedText: billed[orderId]
                ? moneyText(billed[orderId], order?.currencyUomId) +
                  " / " +
                  moneyText(order?.grandTotal ?? 0, order?.currencyUomId)
                : ""
        }
    }
    return found
}
// The pre-approval warnings of an order (check#OrderPreApprove: credit, purchase, store and Sales), shown to the person approving;
// none when the check fails.
function warningsOf(orderId) {
    ec.message.pushErrors()
    try {
        const out = ec.service
            .sync()
            .name("mantle.order.OrderInfoServices.check#OrderPreApprove")
            .parameters({orderId})
            .disableAuthz()
            .call()
        if (ec.message.hasError()) throw new Error(ec.message.getErrorsString())
        return Array.from(out?.approveWarnings || []).map(String)
    } catch (error) {
        ec.logger.error("Pre-approval warnings of order " + orderId + " were not read: " + String(error.message).split("\n")[0])
        return []
    } finally {
        ec.message.clearErrors()
        ec.message.popErrors()
    }
}

// ===== get#SalesOrder =====
// OrderDetail's sales-order context (design §6): an order the caller sees (else orderFound false), its facts with names, its lines
// with shipped and billed quantities, holds, the approval (the setting, the order rules and their states, the warnings), shipments
// and, for a holder of RECEIVABLE_VIEW or ACCOUNTING_VIEW, invoices and payments; what the caller may do now. No cost or margin.
function getOrder(p) {
    const userScope = salesAccess.scope()
    const so = salesAccess.orderOf(userScope, text(p.orderId))
    if (!so) return {orderFound: false}
    const order = so.order
    const orderId = order.orderId
    const part = so.part
    const roleParty = roleTypeId => rows(PART_PARTY, {orderId, roleTypeId})[0]?.partyId || null
    const ownerPartyId = roleParty(salesAccess.quoteRoles.owner)
    const teamPartyId = roleParty(salesAccess.quoteRoles.team)
    const contactPartyId = roleParty(salesAccess.quoteRoles.contact)
    const account = salesAccess.accountOf(userScope, so.customerPartyId)
    const store = order.productStoreId ? one("mantle.product.store.ProductStore", {productStoreId: order.productStoreId}) : null
    const shippedBy = {}
    const shipmentIds = []
    for (const row of rows(SOURCE, {orderId})) {
        shippedBy[row.orderItemSeqId] = toDecimal(shippedBy[row.orderItemSeqId] ?? 0).add(toDecimal(row.quantity ?? 0))
        if (!shipmentIds.includes(row.shipmentId)) shipmentIds.push(row.shipmentId)
    }
    const billedBy = {}
    const invoiceIds = []
    for (const row of rows(BILLING, {orderId})) {
        billedBy[row.orderItemSeqId] = toDecimal(billedBy[row.orderItemSeqId] ?? 0).add(toDecimal(row.quantity ?? 0))
        if (row.invoiceId && !invoiceIds.includes(row.invoiceId)) invoiceIds.push(row.invoiceId)
    }
    const items = rows(ITEM, {orderId})
    const taxTotal = items
        .filter(item => taxTypes.includes(item.itemTypeEnumId))
        .reduce((sum, item) => sum.add(toDecimal(item.unitAmount ?? 0).multiply(toDecimal(item.quantity ?? 1))), toDecimal(0))
    const lines = items
        .filter(item => lineTypes.includes(item.itemTypeEnumId) && !item.parentItemSeqId)
        .sort((a, b) => String(a.orderItemSeqId).localeCompare(String(b.orderItemSeqId)))
        .map(item => {
            const quantity = toDecimal(item.quantity ?? 0)
            const product = item.productId ? one("mantle.product.Product", {productId: item.productId}) : null
            return {
                orderItemSeqId: item.orderItemSeqId,
                itemTypeEnumId: item.itemTypeEnumId,
                productId: item.productId || null,
                productName: product?.productName || "",
                description: item.itemDescription || product?.productName || enumText(item.itemTypeEnumId),
                quantityText: quantityText(quantity),
                cancelledText: item.quantityCancelled ? quantityText(item.quantityCancelled) : "",
                unitText: moneyText(item.unitAmount ?? 0, order.currencyUomId),
                totalText: moneyText(toDecimal(item.unitAmount ?? 0).multiply(quantity), order.currencyUomId),
                shippedText: shippedBy[item.orderItemSeqId] ? quantityText(shippedBy[item.orderItemSeqId]) : "",
                billedText: billedBy[item.orderItemSeqId] ? quantityText(billedBy[item.orderItemSeqId]) : "",
                priceSourceText: item.priceSource === "manual" ? L("Entered") : item.priceSource === "free" ? L("Free") : ""
            }
        })
    const holds = rows(HOLD, {orderId})
        .filter(row => !row.releasedDate)
        .map(row => {
            const holdType = one("moqui.basic.Enumeration", {enumId: row.holdTypeEnumId})
            return {
                orderHoldReasonId: row.orderHoldReasonId,
                holdTypeEnumId: row.holdTypeEnumId,
                typeText: holdType?.description || row.holdTypeEnumId,
                comment: row.holdComment || "",
                placedText: lib.dateText(row.placedDate),
                canRelease:
                    salesHolds.includes(row.holdTypeEnumId) && !!holdType?.enumCode && ec.user.hasPermission(holdType.enumCode)
            }
        })
    const waiting = ["OrderPlaced", "OrderHold"].includes(order.statusId)
    const approval = waiting ? approvals().orderApprovalOf(userScope, order, part) : null
    const warnings = waiting ? warningsOf(orderId) : []
    const gated = gatedParts(so.parts).length > 0
    const canApprove =
        order.statusId === "OrderPlaced" &&
        (gated ? !!userScope.capabilities.orderApprove : ec.user.hasPermission("ORDER_APPROVE")) &&
        Array.from(approval?.requirements || []).every(row => row.state === "approved" || row.canDecide)
    const shipments = shipmentIds.map(shipmentId => {
        const shipment = one("mantle.shipment.Shipment", {shipmentId})
        return {
            shipmentId,
            statusText: statusText(shipment?.statusId),
            shippedText: lib.dateText(shipment?.shipAfterDate || shipment?.estimatedShipDate || shipment?.lastUpdatedStamp)
        }
    })
    const money = ec.user.hasPermission("RECEIVABLE_VIEW") || ec.user.hasPermission("ACCOUNTING_VIEW")
    const invoices = money
        ? invoiceIds.map(invoiceId => {
              const invoice = one("mantle.account.invoice.Invoice", {invoiceId})
              return {
                  invoiceId,
                  statusText: statusText(invoice?.statusId),
                  dateText: dayText(invoice?.invoiceDate),
                  totalText: moneyText(invoice?.invoiceTotal ?? 0, invoice?.currencyUomId || order.currencyUomId)
              }
          })
        : []
    const payments = money
        ? rows("mantle.account.payment.Payment", {orderId}).map(payment => ({
              paymentId: payment.paymentId,
              statusText: statusText(payment.statusId),
              amountText: moneyText(payment.amount ?? 0, payment.amountUomId || order.currencyUomId)
          }))
        : []
    const accepted = rows(RESPONSE, {orderId}).find(row => row.responseTypeEnumId === "SqrAccept") || null
    const editable = so.canEdit
    const canChangeHold = ec.user.hasPermission("ORDER_CHANGE_HOLD_RELEASE") || ec.user.hasPermission("SALES_ORDER_CHANGE")
    const holdTypes = ["OrderPlaced", "OrderProcessing", "OrderApproved", "OrderHold"].includes(order.statusId)
        ? [
              ec.user.hasPermission("ORDER_APPROVE") ? {value: "OhtManual", label: L("Manual")} : null,
              canChangeHold ? {value: "OhtChange", label: L("Change")} : null
          ].filter(Boolean)
        : []
    const link = rows(ORDER_LINK, {orderId})[0]
    const opportunity = link ? salesAccess.opportunityOf(userScope, link.salesOpportunityId) : null
    return {
        orderFound: true,
        order: {
            orderId,
            orderName: order.orderName || "",
            orderRevision: revisionOf(order),
            statusId: order.statusId,
            statusText: statusText(order.statusId),
            kindText: kindText(order),
            direct: order.orderPurposeEnumId === salesAccess.orderPurposes.direct,
            fromQuote: order.orderPurposeEnumId === salesAccess.quotePurpose,
            organizationPartyId: so.organizationPartyId,
            organizationName: partyName(so.organizationPartyId),
            customerPartyId: account ? so.customerPartyId : null,
            customerName: partyName(so.customerPartyId),
            contactName: partyName(contactPartyId),
            ownerName: partyName(ownerPartyId),
            teamName: partyName(teamPartyId),
            storeName: store?.storeName || "",
            storeless: !order.productStoreId,
            currencyUomId: order.currencyUomId,
            otherPartyOrderId: part.otherPartyOrderId || "",
            entryText: lib.dateText(order.entryDate),
            placedText: lib.dateText(order.placedDate),
            approvedText: lib.dateText(order.approvedDate),
            requiredText: dayText(part.shipBeforeDate),
            salesOpportunityId: opportunity ? link.salesOpportunityId : null,
            opportunityName: opportunity ? opportunity.opportunity.opportunityName : "",
            acceptedText: accepted
                ? [
                      L("Accepted"),
                      lib.dateText(accepted.respondedDate),
                      accepted.otherPartyOrderId ? "PO " + accepted.otherPartyOrderId : ""
                  ]
                      .filter(Boolean)
                      .join(" · ")
                : "",
            totalText: moneyText(order.grandTotal ?? 0, order.currencyUomId),
            taxText: moneyText(taxTotal, order.currencyUomId),
            approverOnly: so.approverOnly
        },
        lines,
        holds,
        approval,
        warnings,
        shipments,
        invoices,
        payments,
        showMoney: money,
        history: quotes().history(orderId),
        can: {
            editDraft: editable && isDirectDraft(so),
            place: editable && isDirectDraft(so) && lines.some(line => line.itemTypeEnumId === "ItemProduct"),
            approve: canApprove,
            hold: holdTypes.length > 0,
            holdTypes,
            cancelRemainder:
                editable && openStatuses.includes(order.statusId) && lines.some(line => line.quantityText !== line.cancelledText),
            clone: editable
        }
    }
}

// ===== send#OrderConfirmation (X1) =====
// Whether an order is a storeless sales order of Sales' kinds (a direct order, an accepted quote), placed or later.
function confirmable(order, part) {
    if (!order || !part || order.productStoreId || !order.placedDate) return false
    if (![salesAccess.orderPurposes.direct, salesAccess.quotePurpose].includes(order.orderPurposeEnumId)) return false
    return isSalesPart(part)
}
// The recipient of a confirmation: the order's contact, else its customer.
function recipientOf(orderId, part) {
    return rows(PART_PARTY, {orderId, roleTypeId: salesAccess.quoteRoles.contact})[0]?.partyId || part.customerPartyId
}
// send#OrderConfirmation (OrderPlacedSalesConfirmation, after the placement or approval commits): queue the confirmation once for the
// order's revision and recipient (the ledger's key) and try it now; the build stores and attaches the confirmation as placed. A
// store order, a purchase order and another app's order send nothing. Never fails its caller: a failure is logged with the order.
function sendConfirmation(p) {
    try {
        const order = blank(p.orderId) ? null : one(ORDER, {orderId: String(p.orderId)})
        const part = order ? rows(PART, {orderId: order.orderId})[0] : null
        if (!confirmable(order, part)) return {queued: false}
        const recipientPartyId = recipientOf(order.orderId, part)
        const templateKey = approvals().policyOf(part.vendorPartyId)?.confirmationEmailTemplateId || confirmationTemplate
        const out = call("mantle.party.MessageServices.queue#Delivery", {
            eventKey: "SalesOrderConfirmation:" + order.orderId + "@" + revisionOf(order),
            sourceEnumId: confirmationSource,
            recipientPartyId,
            templateKey,
            // the seller (Marketing P3): the delivery meets its suppressions (a hard bounce) beside every organization's
            organizationPartyId: part.vendorPartyId,
            transactional: true,
            sendNow: true
        })
        return {queued: !!out.created, deliveryId: out.deliveryId, stateEnumId: out.stateEnumId}
    } catch (error) {
        ec.logger.error("Order " + p.orderId + "'s confirmation was not sent: " + String(error.message).split("\n")[0])
        ec.message.clearErrors()
        return {queued: false}
    }
}
// A party's current email, its primary one first.
function emailOf(partyId) {
    const mechRows = rows("mantle.party.contact.PartyContactMech", {partyId}).filter(row => lib.active(row))
    if (!mechRows.length) return null
    const mechs = Object.fromEntries(
        Array.from(
            find("mantle.party.contact.ContactMech")
                .condition(
                    "contactMechId",
                    "in",
                    mechRows.map(row => row.contactMechId)
                )
                .condition("contactMechTypeEnumId", "CmtEmailAddress")
                .list()
        ).map(mech => [mech.contactMechId, mech])
    )
    const ordered = mechRows
        .filter(row => mechs[row.contactMechId])
        .sort((a, b) => (b.contactMechPurposeId === "EmailPrimary" ? 1 : 0) - (a.contactMechPurposeId === "EmailPrimary" ? 1 : 0))
    return text(mechs[ordered[0]?.contactMechId]?.infoString)
}
// Sales P17 (impl-sales §4, F42, F48; design-sales §10 CustomerOrder): the recipient's bearer link to the order's PASS Sales page,
// the SalesOrder kind's OrderView capability (as Shop's checkout issues its own; a storeless order's opens the organization's Sales
// mount, ExternalAccess.js recordPage), made for each attempt as a quote's is (the ledger keeps no token) and lasting as Shop's
// order link does; null with no published Sales site, and the mail then carries none.
const orderLinkDays = 366
function orderLink(order, part) {
    const apps = ec.resource.script("component://mr-mantle/service/mantle/public/PublicApps.js")
    if (!apps.sitesFor("sales", part.vendorPartyId).length) return null
    try {
        return (
            ec.resource.script("component://mr-mantle/service/mantle/party/ExternalAccess.js").create({
                recordType: "SalesOrder",
                recordId: order.orderId,
                scopes: "OrderView",
                validDays: orderLinkDays,
                issuerKind: "organization"
            }).url || null
        )
    } catch (error) {
        ec.message.clearErrors()
        ec.logger.error("No PASS link for order " + order.orderId + ": " + String(error.message).split("\n")[0])
        return null
    }
}
// build#OrderConfirmationMessage (each attempt): the stored confirmation as placed (store#PlacedOrderConfirmation's document, made
// once), from the selling organization's own email (never a person's; none fails the delivery, sent again once it has one), to the
// recipient's current email; suppressed once the order is cancelled or no longer confirmable.
function buildConfirmation(p) {
    const orderId = String(p.eventKey || "")
        .replace(/^SalesOrderConfirmation:/, "")
        .replace(/@\d+$/, "")
    const order = one(ORDER, {orderId})
    const part = order ? rows(PART, {orderId})[0] : null
    if (!confirmable(order, part)) return {suppress: "The order is not a storeless sales order"}
    if (order.statusId === "OrderCancelled") return {suppress: "The order is cancelled"}
    const fromAddress = emailOf(part.vendorPartyId)
    if (!fromAddress) throw new Error(partyName(part.vendorPartyId) + " has no email address to send the confirmation from")
    const stored = confirmations().storeAsSystem(orderId)
    const location = String(stored.contentLocation)
    const stream = ec.resource.getLocationStream(location)
    if (!stream) throw new Error("The confirmation of order " + orderId + " is not there")
    let contentBytes
    try {
        contentBytes = stream.readAllBytes()
    } finally {
        stream.close()
    }
    const toAddress = emailOf(String(p.recipientPartyId || ""))
    const subject = L("Order confirmation") + " " + orderId + " · " + partyName(part.vendorPartyId)
    const body = ec.resource.template(confirmationEmailLocation, {
        orderId,
        customerName: partyName(part.customerPartyId),
        sellerName: partyName(part.vendorPartyId),
        placedText: lib.dateText(order.placedDate),
        reference: part.otherPartyOrderId || "",
        totalText: moneyText(order.grandTotal ?? 0, order.currencyUomId),
        // P17: this recipient's own link to the order's page
        orderUrl: orderLink(order, part) || ""
    })
    return Object.assign(toAddress ? {toAddress} : {}, {
        bodyParameters: {subject, fromAddress, fromName: partyName(part.vendorPartyId)},
        body,
        attachments: [{fileName: location.substring(location.lastIndexOf("/") + 1), contentType: "application/pdf", contentBytes}]
    })
}

// ===== get#SalesWorkSummary =====
// Insights' attention counts and Home's (impl-sales P11; owner contract with Insights): each the count of the scoped list it opens.
function workSummary(p) {
    const userScope = salesAccess.scope()
    salesAccess.requireCapability(userScope, "anyRead")
    const organization = text(p.organizationPartyId) ? {organizationPartyId: text(p.organizationPartyId)} : {}
    const count = (work, field) => {
        ec.message.pushErrors()
        try {
            const out = work()
            if (ec.message.hasError()) throw new Error(ec.message.getErrorsString())
            return Number(out[field] || 0)
        } catch (error) {
            ec.logger.error("Sales work count " + field + " is unavailable: " + String(error.message).split("\n")[0])
            return null
        } finally {
            ec.message.clearErrors()
            ec.message.popErrors()
        }
    }
    const quoteCount = filters =>
        count(() => quotes().execute("findQuotes", Object.assign({pageSize: 1}, organization, filters)), "quoteListCount")
    const orderCount = list => count(() => findOrders(Object.assign({pageSize: 1, list}, organization)), "orderListCount")
    return {
        counts: {
            quotesToSend: quoteCount({state: "proposed", issue: "unsent"}),
            quotesExpiring: quoteCount({state: "open", validity: "expiring"}),
            ordersAwaitingApproval: orderCount("awaiting"),
            ordersBlocked: orderCount("blocked")
        }
    }
}

const operations = {
    createOrder,
    storeLine,
    deleteLine,
    placeOrder,
    approveOrder,
    holdOrder,
    releaseHold,
    cancelRemainder,
    cloneOrder,
    applyBatch,
    findOrders,
    getOrder,
    sendConfirmation,
    buildConfirmation,
    workSummary
}
;({
    // for approve#Order, autoApprove#Order and the callers that approve as built, never a service's parameters
    isSalesPart,
    gatedParts,
    approvalWaits,
    gateRefusal,
    systemApproval,
    // P11: respond#Quote's net-terms option (SalesQuoteIssues.js)
    approveAccepted,
    execute: (op, parameters) => {
        if (!operations[op]) throw new Error("Unknown sales order operation " + op)
        return operations[op](parameters || {})
    }
})
