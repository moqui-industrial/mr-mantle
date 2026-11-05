// The PASS Support app's order cancel request (design-customer-service §8 NewCustomerCase OrderCancelRequest, §4 Customer
// cancellation; impl-customer-service P15, P10, X7, F162): a customer asks to cancel the open remainder of its own order's lines,
// filed as P10's cancel-kind proposal through save#OrderChange (OrderChanges.js) on the Support app's claim that the asker acts
// for the order's customer (an invited contact or the customer's own account, ExternalAccess). It applies at once only under
// customerImmediateCancel; otherwise the page says "Cancellation requested" and the proposal waits in OrderChanges. The
// customer's read of its request shows its state and lines in the customer's words, never the decisions' reasons or approvers,
// and the filer may withdraw it while it is open. CC0 1.0 Universal plus Grant of Patent License.
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const portal = () => ec.resource.script("component://mr-mantle/service/mantle/request/SupportPortal.js")
const changes = () => ec.resource.script("component://mr-mantle/service/mantle/order/OrderChanges.js")
const cases = () => ec.resource.script("component://mr-mantle/service/mantle/request/SupportCases.js")
const {one, rows, call} = lib

const ORDER = "mantle.order.OrderHeader",
    PART = "mantle.order.OrderPart",
    ITEM = "mantle.order.OrderItem",
    REQUEST = "mantle.request.Request"
const SUPPORT_CLAIM = "SupportCustomerClaim"
const cancellableStatuses = ["OrderOpen", "OrderPlaced", "OrderProcessing", "OrderApproved", "OrderHold"]
const customerStates = {
    requested: "Cancellation requested",
    needsInfo: "We need more information",
    approved: "Cancellation approved",
    applied: "Cancelled",
    rejected: "Not cancelled",
    cancelled: "Withdrawn",
    stale: "Cancellation requested"
}
const blank = value => value == null || String(value).trim() === ""
const text = value => (blank(value) ? null : String(value).trim())
const L = words => ec.l10n.localize(words)
const qty = value => ec.l10n.format(toDecimal(value ?? 0), "#,##0.###")
const productText = productId => {
    const product = productId ? one("mantle.product.Product", {productId}) : null
    return product ? [product.pseudoId || product.productId, product.productName].filter(Boolean).join(" · ") : ""
}
// The Support app's claim for a customer of the organization while work runs (OrderChanges.js and ReturnPolicies.js read it).
function asCustomer(claim, work) {
    const shared = ec.context.sharedMap,
        before = shared[SUPPORT_CLAIM]
    shared[SUPPORT_CLAIM] = {organizationPartyId: claim.organizationPartyId, customerPartyId: claim.customerPartyId}
    try {
        return work()
    } finally {
        if (before == null) delete shared[SUPPORT_CLAIM]
        else shared[SUPPORT_CLAIM] = before
    }
}
// The asker's own sales order with the organization: every part sold by it to one customer the account acts for.
function orderFor(orderId, organizationPartyId, customers) {
    const order = blank(orderId) ? null : one(ORDER, {orderId})
    const parts = order ? rows(PART, {orderId}) : []
    const customer = parts.length ? customers.find(row => row.partyId === parts[0].customerPartyId) : null
    if (
        !customer ||
        !parts.every(part => part.vendorPartyId === organizationPartyId && part.customerPartyId === customer.partyId)
    )
        portal().unavailable()
    return {order, parts, customer}
}
// The lines a customer may ask to cancel: each product line's open remainder (what has not shipped or been packed), in the
// customer's words, with no price or stock detail.
function openLines(orderId) {
    return rows(ITEM, {orderId})
        .filter(item => item.productId && !item.parentItemSeqId)
        .sort((a, b) => String(a.orderItemSeqId).localeCompare(String(b.orderItemSeqId)))
        .map(item => {
            const facts = changes().lineFacts(orderId, item.orderItemSeqId)
            const open = Math.max(0, facts?.open ?? 0)
            return {
                orderItemSeqId: item.orderItemSeqId,
                productText: productText(item.productId) || item.itemDescription || "",
                openQuantity: qty(open),
                open
            }
        })
        .filter(line => line.open > 0)
}
// The customer's cancel requests of an order, newest first.
function requestsOf(orderId) {
    return rows(REQUEST, {orderId, requestTypeEnumId: "RqtOrderChange", orderChangeKindEnumId: "OckCancel"}).sort(
        (a, b) => Number(lib.ms(b.requestDate) || 0) - Number(lib.ms(a.requestDate) || 0)
    )
}
function requestView(request) {
    const ch = changes().changeOf(request.requestId, {scoped: false})
    const state = changes().stateOf(request, ch.so, changes().revisionOf(request.requestId))
    const own = request.filedByPartyId && request.filedByPartyId === ec.user.userAccount?.partyId
    return {
        requestId: request.requestId,
        stateText: L(customerStates[state] || "Cancellation requested"),
        requestedText: lib.dateText(request.requestDate),
        revision: changes().revisionOf(request.requestId),
        lines: changes()
            .linesOf(request.requestId)
            .map(({item, orderItemSeqId}) => ({
                orderItemSeqId,
                productText: productText(item.productId),
                quantity: qty(item.quantity)
            })),
        capabilities: {canWithdraw: !!own && ["ReqSubmitted", "ReqWaitingCustomer"].includes(request.statusId)}
    }
}
// NewCustomerCase's OrderCancelRequest for a selected order (SupportPortal.js getCaseIntake): the order, its open lines and the
// customer's earlier requests.
function cancelView(p, organizationPartyId, customers) {
    const {order} = orderFor(p.orderId, organizationPartyId, customers)
    const lines = cancellableStatuses.includes(order.statusId) ? openLines(order.orderId) : []
    return {
        orderId: order.orderId,
        orderName: order.orderName || "",
        placedText: lib.dateText(order.placedDate || order.entryDate),
        lines: lines.map(line => ({
            orderItemSeqId: line.orderItemSeqId,
            productText: line.productText,
            openQuantity: line.openQuantity
        })),
        requestList: requestsOf(order.orderId).slice(0, 5).map(requestView),
        capabilities: {canRequestCancel: lines.length > 0}
    }
}
// requestOrderCancel (request#CustomerCancel): the lines chosen (each at most its open remainder), the reason and the customer's
// consent, filed through save#OrderChange on the claim with the operation as its key; the answer is P10's state in the
// customer's words.
function requestCustomerCancel(p) {
    const s = portal()
    s.throttle("support-cancel")
    const organizationPartyId = s.served(p.siteId)
    if (!ec.user.userId) s.signInRequired()
    const customers = s.actingFor(organizationPartyId)
    const {order, customer} = orderFor(p.orderId, organizationPartyId, customers)
    const key = s.operationKey(p)
    const consent = p.consent === true || p.consent === "Y" || p.consent === "true"
    if (!consent) s.fail("Unprocessable", "Confirm that you ask us to cancel these lines")
    const open = new Map(openLines(order.orderId).map(line => [line.orderItemSeqId, line]))
    const chosen = (typeof p.lines === "string" ? lib.json(p.lines, []) : Array.from(p.lines || [])).filter(
        line => line && line.orderItemSeqId
    )
    if (!chosen.length) s.fail("Unprocessable", "Choose the lines to cancel")
    const lines = chosen.map(line => {
        const row = open.get(String(line.orderItemSeqId))
        const quantity = blank(line.quantity) ? row?.open : Number(line.quantity)
        if (!row || !(quantity > 0) || quantity > row.open)
            s.fail("Unprocessable", "Choose a quantity up to what is still open on each line")
        return {orderItemSeqId: row.orderItemSeqId, changeActionEnumId: "OclCancel", quantity}
    })
    const reason = text(p.reason)
    const saved = asCustomer({organizationPartyId, customerPartyId: customer.partyId}, () =>
        changes().execute("save", {
            orderId: order.orderId,
            orderChangeKindEnumId: "OckCancel",
            reason: reason ? reason.substring(0, 2000) : L("Asked by the customer in the Support app"),
            cancellationReason: reason ? reason.substring(0, 255) : null,
            customerConsentRef: "support:" + key,
            caseRequestId: null,
            lines,
            operationKey: key
        })
    )
    return {
        requestId: saved.requestId,
        stateText: L(saved.immediate ? "Cancelled" : "Cancellation requested"),
        immediate: !!saved.immediate,
        alreadyApplied: !!saved.alreadyApplied
    }
}
// getOrderCancelRequest: the customer's read of one of its cancel requests (F162), without the decisions' reasons or approvers.
function getCustomerCancel(p) {
    const s = portal()
    const organizationPartyId = s.served(p.siteId)
    if (!ec.user.userId) s.signInRequired()
    const request = blank(p.requestId) ? null : one(REQUEST, {requestId: p.requestId})
    if (!request || request.requestTypeEnumId !== "RqtOrderChange" || request.orderChangeKindEnumId !== "OckCancel")
        s.unavailable()
    orderFor(request.orderId, organizationPartyId, s.actingFor(organizationPartyId))
    return {request: requestView(request), orderId: request.orderId}
}
// withdrawOrderCancel: the filer withdraws an open request of their own (withdraw#OrderChange's own path) at the revision the
// page showed (a later change is a Conflict naming the current one).
function withdrawCustomerCancel(p) {
    const s = portal()
    const organizationPartyId = s.served(p.siteId)
    if (!ec.user.userId) s.signInRequired()
    const request = blank(p.requestId) ? null : one(REQUEST, {requestId: p.requestId})
    if (!request || request.requestTypeEnumId !== "RqtOrderChange" || request.orderChangeKindEnumId !== "OckCancel")
        s.unavailable()
    orderFor(request.orderId, organizationPartyId, s.actingFor(organizationPartyId))
    if (request.statusId === "ReqCancelled") return {stateText: L("Withdrawn"), alreadyApplied: true}
    s.requireRevision(p, changes().revisionOf(request.requestId), "cancel request")
    changes().execute("withdraw", {requestId: request.requestId, reason: text(p.reason) || L("Withdrawn by the customer")})
    return {stateText: L("Withdrawn"), alreadyApplied: false}
}
// The customer's sales orders with the organization the account acts for, newest first (RequestReturn and NewCustomerCase
// pick one), with what each may do.
function customerOrders(organizationPartyId, customers, limit = 50) {
    const out = []
    for (const customer of customers)
        for (const part of rows(PART, {customerPartyId: customer.partyId, vendorPartyId: organizationPartyId})) {
            if (out.some(row => row.orderId === part.orderId)) continue
            const order = one(ORDER, {orderId: part.orderId})
            if (!order || ["OrderOpen", "OrderCancelled", "OrderRejected"].includes(order.statusId)) continue
            out.push({
                orderId: order.orderId,
                orderName: order.orderName || "",
                placedText: lib.dateText(order.placedDate || order.entryDate),
                placedMs: Number(lib.ms(order.placedDate || order.entryDate) || 0),
                statusText: one("moqui.basic.StatusItem", {statusId: order.statusId})?.description || order.statusId,
                customerName: customer.name,
                cancellable: cancellableStatuses.includes(order.statusId)
            })
        }
    return out
        .sort((a, b) => b.placedMs - a.placedMs)
        .slice(0, limit)
        .map(row => (delete row.placedMs, row))
}

const operations = {requestCustomerCancel, getCustomerCancel, withdrawCustomerCancel}
;({
    asCustomer,
    orderFor,
    cancelView,
    customerOrders,
    execute(op, input) {
        if (!operations[op]) portal().fail("NotFound", "Unknown support operation")
        const wasDisabled = ec.artifactExecution.disableAuthz()
        try {
            return operations[op](input || {})
        } catch (error) {
            portal().refused(error)
        } finally {
            if (!wasDisabled) ec.artifactExecution.enableAuthz()
        }
    }
})
