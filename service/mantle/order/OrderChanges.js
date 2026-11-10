// Order changes (CS-ORDER-CHANGE, CX-ORDER-CHANGE; design-customer-service §4 OrderChanges and OrderChangeDetail, D9, D7;
// impl-customer-service §4, P10; OrderChangeServices.xml, SupportOrderChangeEntities.xml). A proposal is the RqtOrderChange Request
// of a sales order: its organization the order's seller (an OrgInternal RequestParty), its customer a Customer RequestParty,
// its lines RequestItems linked to the order's lines by RequestItemOrder. Its revision is the time of the last change to its
// audit-logged key fields (the kind, the consent, the order revision it binds, the commercial fields, and each line's action,
// product, quantity, unit, ship date, proposed price and status), so a decision made before a change no longer counts. A
// decision is an OrderChangeDecision. Cancel and substitute are applied here under ORDER_CHANGE_APPROVE and ORDER_CHANGE_APPLY;
// the commercial kinds are filed and decided under SALES_APPROVE and applied by the order's owner (Sales), never here. Apply
// runs every check again under the order's lock, holds the order with the Change reason (hold#Order) and releases it
// (release#OrderHold), and either commits whole or leaves the order as it was. Quantities are in the order line's unit, which
// these orders share with the product's stock unit (a line in another unit is refused, UNIT_UNSUPPORTED).
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const facilityScope = ec.resource.script("component://mr-mantle/service/mantle/facility/FacilityScope.js")
const cases = () => ec.resource.script("component://mr-mantle/service/mantle/request/SupportCases.js")
const confirmations = () => ec.resource.script("component://mr-mantle/service/mantle/order/OrderConfirmations.js")
const {find, one, rows, call, denied, access, ms} = lib

const REQUEST = "mantle.request.Request",
    ITEM = "mantle.request.RequestItem",
    ITEM_ORDER = "mantle.request.RequestItemOrder",
    REQUEST_PARTY = "mantle.request.RequestParty",
    DECISION = "mantle.request.support.OrderChangeDecision",
    ORDER = "mantle.order.OrderHeader",
    PART = "mantle.order.OrderPart",
    ORDER_ITEM = "mantle.order.OrderItem",
    CONTENT = "mantle.order.OrderContent",
    EXCEPTION = "mantle.shipment.ShipmentPickException",
    SOURCE = "mantle.shipment.ShipmentItemSource",
    SHIPMENT = "mantle.shipment.Shipment"
const changeType = "RqtOrderChange"
const topic = "OrderChangeApproval"
const appliedContentType = "OctOrderChangeApplied"
const appliedKinds = ["OckCancel", "OckSubstitute"]
// the line actions each kind takes; the kinds with none change the order's part (address, method, carrier)
const kindActions = {
    OckCancel: ["OclCancel"],
    OckSubstitute: ["OclSubstitute"],
    OckPrice: ["OclPrice"],
    OckQuantity: ["OclQuantity"],
    OckShipDate: ["OclShipDate"],
    OckAddress: [],
    OckShipMethod: [],
    OckCarrier: []
}
const requestRevisionFields = [
    "orderChangeKindEnumId",
    "expectedOrderRevision",
    "customerConsentRef",
    "cancellationReason",
    "addressContactMechId",
    "shipmentMethodEnumId",
    "carrierPartyId"
]
const itemRevisionFields = [
    "statusId",
    "changeActionEnumId",
    "productId",
    "quantity",
    "quantityUomId",
    "requiredByDate",
    "proposedUnitAmount"
]
const readPermissions = [
    "ORDER_CHANGE_REQUEST",
    "ORDER_CHANGE_APPROVE",
    "ORDER_CHANGE_APPLY",
    "SALES_APPROVE",
    "SALES_ORDER_CHANGE"
]
const amountPermissions = ["PRICE_VIEW", "ACCOUNTING_VIEW", "RECEIVABLE_VIEW", "ORDER_APPROVE"]
const financePermissions = ["ACCOUNTING_VIEW", "RECEIVABLE_VIEW"]
// a completed order may still have a package not shipped (pack#Shipment completes the part); its shipped lines are refused
const changeableOrderStatuses = ["OrderOpen", "OrderPlaced", "OrderProcessing", "OrderApproved", "OrderHold", "OrderCompleted"]
const shippedStatuses = ["ShipShipped", "ShipDelivered"]
const deadShipmentStatuses = ["ShipCancelled", "ShipRejected"]
const substituteTypes = ["PatEquivalent", "PatReplacement"]
const defaultApprovalDays = 7

const blank = value => value == null || String(value).trim() === ""
const text = value => (blank(value) ? null : String(value).trim())
const number = value => (value == null || value === "" ? 0 : Number(String(value)))
const quantityText = value => ec.l10n.format(toDecimal(value ?? 0), "#,##0.###")
const truthy = value => value === true || value === "Y" || value === "true"
const has = permission => access.has(permission)
const hasAny = permissions => permissions.some(has)
const partyName = partyId => (partyId ? lib.partyNames([partyId])[partyId] || partyId : "")
const enumText = enumId => (enumId ? one("moqui.basic.Enumeration", {enumId})?.description || enumId : "")
const statusText = statusId => (statusId ? one("moqui.basic.StatusItem", {statusId})?.description || statusId : "")
const isInternal = partyId => !!partyId && !!one("mantle.party.PartyRole", {partyId, roleTypeId: "OrgInternal"})
const productText = productId => {
    const product = productId ? one("mantle.product.Product", {productId}) : null
    return product ? [product.pseudoId || product.productId, product.productName].filter(Boolean).join(" · ") : productId || ""
}
const money = (value, currencyUomId) =>
    value == null ? "" : currencyUomId ? ec.l10n.formatCurrency(lib.money(value, currencyUomId), currencyUomId) : String(value)
const revisionText = revision => (revision ? lib.dateText(revision) : "")
const amountRead = () => hasAny(amountPermissions)

// ===== the order =====
// Warehouse's one lock order (F294) is the shipment, then the order parts and header: a pick locks its shipment and never
// the order, and a pack or reopen locks the shipment before the order. So the order's lock is taken after its shipments,
// in id order, and its parts (as hold#Order and release#OrderHold take them): a pick, pack or reopen of the order then
// either commits before the checks (which see it: STOCK_CHANGED) or waits for the change, and apply's own reopen and hold
// never wait on a shipment or a part while holding the order.
function lockShipmentsOf(orderId) {
    const shipmentIds = [
        ...new Set(
            rows(SOURCE, {orderId})
                .map(row => row.shipmentId)
                .filter(Boolean)
        )
    ].sort()
    for (const shipmentId of shipmentIds) find(SHIPMENT, {shipmentId}).forUpdate(true).one()
    find(PART, {orderId}).orderBy("orderPartSeqId").forUpdate(true).list()
}
// A sales order: every part sold by an internal organization to an outside party. Scoped, one of the user's organizations
// sells it; a missing order, a purchase order and another organization's are refused alike (RECORD_UNAVAILABLE).
function orderOf(orderId, options = {}) {
    const unavailable = () => denied("RECORD_UNAVAILABLE", "Order " + (orderId || "") + " is not available")
    if (blank(orderId)) unavailable()
    if (options.lock) lockShipmentsOf(orderId)
    const order = options.lock ? find(ORDER, {orderId}).forUpdate(true).one() : one(ORDER, {orderId})
    const parts = order ? rows(PART, {orderId}) : []
    if (!parts.length || !parts.every(part => isInternal(part.vendorPartyId) && !isInternal(part.customerPartyId))) unavailable()
    if (options.scoped !== false) {
        const userScope = facilityScope.scope()
        if (!parts.every(part => facilityScope.owns(userScope, part.vendorPartyId))) unavailable()
    }
    return {
        order,
        parts,
        orderId: String(orderId),
        organizationPartyId: parts[0].vendorPartyId,
        customerPartyIds: Array.from(new Set(parts.map(part => part.customerPartyId).filter(Boolean))),
        currencyUomId: order.currencyUomId || null,
        revision: number(order.orderRevision || 1)
    }
}
// Customer Service P15: the Support app's claim (CustomerOrders.js asCustomer) that the signed-in account acts for a customer of
// the organization (an invited contact, or the customer's own account), checked there by ExternalAccess, never a request's input.
const SUPPORT_CLAIM = "SupportCustomerClaim"
const supportClaim = () => ec.context.sharedMap[SUPPORT_CLAIM] || null
// Whether the user is on the customer's side of the order: its customer, or a current contact or employee of it, or the
// Support app's claim for its customer.
function customerSide(so) {
    const claim = supportClaim()
    if (claim && claim.organizationPartyId === so.organizationPartyId && so.customerPartyIds.includes(claim.customerPartyId))
        return true
    const partyId = ec.user.userAccount?.partyId || null
    if (!partyId) return false
    const sides = cases().customerSidesOf(partyId)
    return so.customerPartyIds.some(customerPartyId => sides.includes(customerPartyId))
}

// ===== the proposal =====
// A proposal of an order of the user's organizations (or, unscoped, the customer's own): the request, its order, the kind
// and whether the user filed it. A missing request, another type and another organization's are refused alike.
function changeOf(requestId, options = {}) {
    const unavailable = () => denied("RECORD_UNAVAILABLE", "Order change " + (requestId || "") + " is not available")
    if (blank(requestId)) unavailable()
    const request = options.lock ? find(REQUEST, {requestId}).forUpdate(true).one() : one(REQUEST, {requestId})
    if (!request || request.requestTypeEnumId !== changeType || blank(request.orderId)) unavailable()
    let so
    try {
        so = orderOf(request.orderId, {lock: options.lockOrder, scoped: options.scoped})
    } catch (error) {
        if (lib.reasonCode(error) === "RECORD_UNAVAILABLE") unavailable()
        throw error
    }
    const partyId = ec.user.userAccount?.partyId || null
    return {
        request,
        requestId: String(requestId),
        so,
        kind: request.orderChangeKindEnumId,
        applied: appliedKinds.includes(request.orderChangeKindEnumId),
        own: !!partyId && request.filedByPartyId === partyId
    }
}
function requireRead(ch) {
    if (!ch.own && !hasAny(readPermissions))
        denied("PERMISSION_DENIED", readPermissions.join(" or ") + " is required to read order changes")
}
// The permission that decides a kind: ORDER_CHANGE_APPROVE for cancel and substitute, Sales' SALES_APPROVE for the rest.
const approvePermission = kind => (appliedKinds.includes(kind) ? "ORDER_CHANGE_APPROVE" : "SALES_APPROVE")
const linesOf = requestId =>
    rows(ITEM, {requestId})
        .filter(item => item.statusId !== "ReqCancelled")
        .sort((a, b) => String(a.requestItemSeqId).localeCompare(String(b.requestItemSeqId)))
        .map(item => {
            const link = rows(ITEM_ORDER, {requestId, requestItemSeqId: item.requestItemSeqId})[0] || null
            return {item, orderItemSeqId: link?.orderItemSeqId || null}
        })
// The proposal's revision: the time of the last change to its audit-logged key fields (0 before any).
function revisionOf(requestId) {
    let latest = 0
    for (const [entity, fields] of [
        [REQUEST, requestRevisionFields],
        [ITEM, itemRevisionFields]
    ]) {
        const row = Array.from(
            find("moqui.entity.EntityAuditLog", {changedEntityName: entity, pkPrimaryValue: requestId})
                .condition("changedFieldName", "in", fields)
                .orderBy("-changedDate")
                .limit(1)
                .list()
        )[0]
        if (row) latest = Math.max(latest, Number(ms(row.changedDate)))
    }
    return latest
}
// The decisions of a proposal, newest first; the current approval is one at the revision, not superseded or expired.
const decisionsOf = requestId =>
    rows(DECISION, {requestId}).sort(
        (a, b) =>
            ms(b.decisionDate) - ms(a.decisionDate) ||
            String(b.orderChangeDecisionId).localeCompare(String(a.orderChangeDecisionId))
    )
function approvalOf(requestId, revision) {
    const current = decisionsOf(requestId).find(row => !row.supersededDate && number(row.sourceRevision) === revision)
    if (!current || current.decisionEnumId !== "OcdApproved") return {approval: null, decision: current || null}
    const expired = current.expireDate && ms(current.expireDate) <= ms(ec.user.nowTimestamp)
    return {approval: current, decision: current, expired: !!expired}
}
// The proposal's state for lists and the detail: requested, needsInfo, approved, applied, rejected, cancelled or stale.
function stateOf(request, so, revision) {
    if (request.statusId === "ReqCompleted") return "applied"
    if (request.statusId === "ReqCancelled") return request.requestResolutionEnumId === "RrRejected" ? "rejected" : "cancelled"
    if (number(request.expectedOrderRevision) !== so.revision) return "stale"
    if (request.statusId === "ReqWaitingCustomer") return "needsInfo"
    const {approval, expired} = approvalOf(request.requestId, revision)
    return approval && !expired ? "approved" : "requested"
}
const stateTexts = {
    requested: "Requested",
    needsInfo: "Needs information",
    approved: "Approved",
    applied: "Applied",
    rejected: "Rejected",
    cancelled: "Cancelled",
    stale: "Stale"
}
const openStatuses = ["ReqSubmitted", "ReqWaitingCustomer"]

// ===== the facts of an order line =====
// What a line has: its quantity, cancelled, reserved, picked, issued (packed on a shipment not shipped yet), shipped and
// billed (on a finalized invoice, or one still in process from the pack), and the shipments it is on.
function lineFacts(orderId, orderItemSeqId) {
    const item = one(ORDER_ITEM, {orderId, orderItemSeqId})
    if (!item) return null
    const reserved = rows("mantle.product.issuance.AssetReservation", {orderId, orderItemSeqId}).reduce(
        (sum, row) => sum + number(row.quantity),
        0
    )
    const sources = rows(SOURCE, {orderId, orderItemSeqId}).filter(row => row.statusId !== "SisCancelled")
    const shipments = new Map()
    const shipmentOf = shipmentId => {
        if (!shipmentId) return null
        if (!shipments.has(shipmentId)) shipments.set(shipmentId, one(SHIPMENT, {shipmentId}))
        return shipments.get(shipmentId)
    }
    const liveSources = sources.filter(row => !deadShipmentStatuses.includes(shipmentOf(row.shipmentId)?.statusId))
    const picked = liveSources.reduce((sum, row) => sum + number(row.quantityPicked), 0)
    let issued = 0,
        shipped = 0
    const packed = new Map()
    for (const issuance of rows("mantle.product.issuance.AssetIssuance", {orderId, orderItemSeqId})) {
        const quantity = number(issuance.quantity)
        if (quantity <= 0) continue
        issued += quantity
        const shipment = shipmentOf(issuance.shipmentId)
        if (!shipment || shippedStatuses.includes(shipment.statusId)) shipped += quantity
        else packed.set(shipment.shipmentId, (packed.get(shipment.shipmentId) || 0) + quantity)
    }
    let billedFinal = 0,
        billedInProcess = 0
    for (const billing of rows("mantle.order.OrderItemBilling", {orderId, orderItemSeqId})) {
        const invoice = one("mantle.account.invoice.Invoice", {invoiceId: billing.invoiceId})
        if (!invoice || invoice.statusId === "InvoiceCancelled") continue
        if (invoice.statusId === "InvoiceInProcess") billedInProcess += number(billing.quantity)
        else billedFinal += number(billing.quantity)
    }
    const short = liveSources
        .flatMap(row => rows(EXCEPTION, {shipmentItemSourceId: row.shipmentItemSourceId}))
        .reduce((sum, row) => sum + number(row.quantityShort), 0)
    const quantity = number(item.quantity)
    return {
        item,
        orderItemSeqId: String(orderItemSeqId),
        productId: item.productId,
        quantity,
        cancelled: number(item.quantityCancelled),
        reserved,
        picked,
        issued,
        shipped,
        packed,
        billedFinal,
        billedInProcess,
        short,
        open: Math.max(0, quantity - issued),
        sources: liveSources,
        shipments
    }
}
// The fingerprint of the fulfillment facts a preview shows and apply compares (STOCK_CHANGED).
const factsVersion = facts =>
    lib.hash(facts.map(f => [f.orderItemSeqId, f.quantity, f.cancelled, f.reserved, f.picked, f.issued, f.shipped, f.short]))

// ===== the substitute =====
// A product that may stand in for a line's product: a current PatEquivalent or PatReplacement association of it.
function substituteAssoc(productId, substituteProductId) {
    return (
        rows("mantle.product.ProductAssoc", {productId, toProductId: substituteProductId}).find(
            row => substituteTypes.includes(row.productAssocTypeEnumId) && lib.active(row)
        ) || null
    )
}
// Whether a product may be sold to the order's customer now (check#ProductUsable, Products P2): {usable, reason}.
function usableForSale(productId, quantity, so) {
    ec.message.pushErrors()
    try {
        const out =
            ec.service
                .sync()
                .name("mantle.product.ProductServices.check#ProductUsable")
                .parameters({
                    productId,
                    usage: "Sell",
                    quantity,
                    vendorPartyId: so.organizationPartyId,
                    customerPartyId: so.customerPartyIds[0] || null,
                    productStoreId: so.order.productStoreId || null
                })
                .disableAuthz()
                .call() || {}
        if (ec.message.hasError()) return {usable: false, reason: ec.message.getErrorsString()}
        return {usable: out.usable !== false, reason: out.reason || null}
    } finally {
        ec.message.clearErrors()
        ec.message.popErrors()
    }
}
// The price the order's resolver gives a product (Products P5, get#OrderProductPrice), or null when none.
function resolverPrice(productId, quantity, so, orderPartSeqId) {
    ec.message.pushErrors()
    try {
        const out =
            ec.service
                .sync()
                .name("mantle.product.PriceServices.get#OrderProductPrice")
                .parameters({productId, quantity, orderId: so.orderId, orderPartSeqId})
                .disableAuthz()
                .call() || {}
        return ec.message.hasError() || out.price == null ? null : out.price
    } finally {
        ec.message.clearErrors()
        ec.message.popErrors()
    }
}
// What is available to promise of a product at the order part's facility (its assets' ATP).
function availableAt(productId, facilityId) {
    if (!facilityId) return null
    return rows("mantle.product.asset.Asset", {productId, facilityId}).reduce(
        (sum, row) => sum + number(row.availableToPromiseTotal),
        0
    )
}

// ===== checking a proposal's lines =====
// Each line against the order as it is now: {lines: [{line, facts, cancelQuantity, reopen, substitute}], conflicts}. With
// strict, the first conflict is refused by its code (apply); otherwise each is listed (preview, save).
function checkLines(ch, lineRows, strict) {
    const so = ch.so
    const conflicts = []
    const conflict = (code, message) => {
        if (strict) denied(code, message)
        conflicts.push({code, message})
    }
    const checked = []
    for (const {item, orderItemSeqId} of lineRows) {
        const facts = orderItemSeqId ? lineFacts(so.orderId, orderItemSeqId) : null
        if (!facts) {
            conflict("LINE_UNAVAILABLE", "Line " + (orderItemSeqId || "") + " is not on order " + so.orderId)
            continue
        }
        const quantity = number(item.quantity)
        const entry = {item, orderItemSeqId, facts, quantity, cancelQuantity: 0, reopen: [], substitute: null}
        if (item.changeActionEnumId === "OclCancel") {
            if (quantity > facts.quantity - facts.shipped)
                conflict(
                    "ALREADY_SHIPPED",
                    "Line " +
                        orderItemSeqId +
                        " has " +
                        quantityText(facts.shipped) +
                        " shipped; only " +
                        quantityText(Math.max(0, facts.quantity - facts.shipped)) +
                        " can be cancelled, and a return handles the rest"
                )
            if (facts.billedFinal > facts.quantity - quantity)
                conflict(
                    "BILLING_CONFLICT",
                    "Line " + orderItemSeqId + " has " + quantityText(facts.billedFinal) + " on a finalized invoice"
                )
            entry.cancelQuantity = Math.min(quantity, Math.max(0, facts.quantity - facts.shipped))
            // between pack and ship: the packed quantity comes off its package first
            let need = Math.max(0, entry.cancelQuantity - facts.open)
            for (const [shipmentId, packedQuantity] of facts.packed) {
                if (need <= 0) break
                const invoices = packing()
                    .invoicesOf(shipmentId)
                    .filter(row => row.statusId !== "InvoiceCancelled")
                const finalized = invoices.find(row => row.statusId !== "InvoiceInProcess")
                if (finalized)
                    conflict(
                        "BILLING_CONFLICT",
                        "Invoice " +
                            finalized.invoiceId +
                            " of shipment " +
                            shipmentId +
                            " is final, so its package stays closed; a credit memo corrects it"
                    )
                let left = Math.min(need, packedQuantity)
                for (const content of rows("mantle.shipment.ShipmentPackageContent", {shipmentId, productId: facts.productId})) {
                    if (left <= 0) break
                    const take = Math.min(left, number(content.quantity))
                    if (take <= 0) continue
                    entry.reopen.push({
                        shipmentId,
                        shipmentPackageSeqId: content.shipmentPackageSeqId,
                        productId: facts.productId,
                        quantity: take
                    })
                    left -= take
                    need -= take
                }
            }
            if (need > 0)
                conflict("STOCK_CHANGED", "Line " + orderItemSeqId + " has " + quantityText(need) + " issued outside a package")
        } else if (item.changeActionEnumId === "OclSubstitute") {
            const exception = item.pickExceptionId ? one(EXCEPTION, {exceptionId: item.pickExceptionId}) : null
            const source = exception ? one(SOURCE, {shipmentItemSourceId: exception.shipmentItemSourceId}) : null
            if (!exception || !source || source.orderId !== so.orderId || source.orderItemSeqId !== orderItemSeqId) {
                conflict("SUBSTITUTE_INVALID", "Line " + orderItemSeqId + " has no short pick " + (item.pickExceptionId || ""))
                checked.push(entry)
                continue
            }
            const shipment = one(SHIPMENT, {shipmentId: exception.shipmentId})
            if (shippedStatuses.includes(shipment?.statusId))
                conflict("ALREADY_SHIPPED", "Shipment " + exception.shipmentId + " has shipped; a return handles it")
            if (!substituteAssoc(facts.productId, item.productId))
                conflict(
                    "SUBSTITUTE_INVALID",
                    productText(item.productId) + " is not an equivalent or replacement of " + productText(facts.productId)
                )
            const usable = usableForSale(item.productId, quantity, so)
            if (!usable.usable)
                conflict("PRODUCT_NOT_USABLE", productText(item.productId) + " cannot be sold now: " + (usable.reason || ""))
            if (exception.resolutionEnumId === "SpresSubstitute" && ch.request.statusId === "ReqCompleted")
                conflict("CHANGE_CLOSED", "Short pick " + exception.exceptionId + " is already substituted")
            entry.cancelQuantity = Math.min(number(exception.quantityShort), facts.open)
            entry.substitute = {exception, shipment, productId: item.productId, quantity}
        }
        checked.push(entry)
    }
    return {lines: checked, conflicts}
}
const packing = () => ec.resource.script("component://mr-mantle/service/mantle/shipment/Packing.js")

// ===== notices =====
// The users who may decide a kind in an organization: active members of a group holding its permission whose party works for
// the organization (agent, employee or member), not disabled.
function deciders(organizationPartyId, permission) {
    const groupIds = rows("moqui.security.UserGroupPermission", {userPermissionId: permission})
        .filter(row => lib.active(row))
        .map(row => row.userGroupId)
    if (!groupIds.length) return []
    const userIds = [
        ...new Set(
            Array.from(find("moqui.security.UserGroupMember").condition("userGroupId", "in", groupIds).list())
                .filter(row => lib.active(row))
                .map(row => row.userId)
        )
    ]
    if (!userIds.length) return []
    const accounts = Array.from(find("moqui.security.UserAccount").condition("userId", "in", userIds).list()).filter(
        row => row.partyId && row.disabled !== "Y"
    )
    if (!accounts.length) return []
    const members = new Set(
        Array.from(
            find("mantle.party.PartyRelationship", {toPartyId: organizationPartyId})
                .condition("relationshipTypeEnumId", "in", ["PrtAgent", "PrtEmployee", "PrtMember"])
                .condition(
                    "fromPartyId",
                    "in",
                    accounts.map(row => row.partyId)
                )
                .list()
        )
            .filter(row => lib.active(row))
            .map(row => row.fromPartyId)
    )
    return accounts.filter(row => members.has(row.partyId))
}
// The proposal's approvers' unread notices, read once it is decided, withdrawn or changed.
function clearNotices(requestId) {
    const messageIds = rows("moqui.security.user.NotificationMessage", {
        topic,
        recordEntityName: REQUEST,
        recordId: requestId
    }).map(row => row.notificationMessageId)
    if (!messageIds.length) return
    for (const user of Array.from(
        find("moqui.security.user.NotificationMessageUser")
            .condition("notificationMessageId", "in", messageIds)
            .condition("viewedDate", "is-null", null)
            .list()
    ))
        call("update#moqui.security.user.NotificationMessageUser", {
            notificationMessageId: user.notificationMessageId,
            userId: user.userId,
            viewedDate: ec.user.nowTimestamp
        })
}
// The proposal at its revision to the approvers of its kind (OrderChangeApproval); the person who filed it is left out unless
// the policy allows self-approval. A failure is logged and the proposal stays.
function notify(ch, revision) {
    try {
        clearNotices(ch.requestId)
        const policy = cases().policyOf(ch.so.organizationPartyId)
        const filerPartyId = ch.request.filedByPartyId
        const userIds = deciders(ch.so.organizationPartyId, approvePermission(ch.kind))
            .filter(row => policy?.orderChangeSelfApproval === "Y" || row.partyId !== filerPartyId)
            .map(row => row.userId)
        if (!userIds.length) return 0
        ec.makeNotificationMessage()
            .topic(topic)
            .message({
                requestId: ch.requestId,
                orderId: ch.so.orderId,
                sourceRevision: revision,
                kindText: enumText(ch.kind),
                customerName: ch.so.customerPartyIds.map(partyName).join(", "),
                organizationName: partyName(ch.so.organizationPartyId),
                requestedByName: partyName(filerPartyId)
            })
            .record(REQUEST, ch.requestId)
            .actorUserId(ec.user.userId)
            .userIds(userIds)
            .send()
        return userIds.length
    } catch (error) {
        ec.logger.error("Approval notice of order change " + ch.requestId + " was not sent: " + error.message)
        return 0
    }
}

// ===== save =====
function linesFrom(p, kind) {
    const actions = kindActions[kind]
    const lines = Array.from(p.lines || [])
    if (actions.length && !lines.length) denied("LINES_REQUIRED", "Choose the order lines the change is for")
    return lines.map(line => {
        const action = text(line.changeActionEnumId) || actions[0]
        if (!actions.includes(action))
            denied("ACTION_INVALID", enumText(action) + " is not a line of a " + enumText(kind) + " change")
        const quantity = blank(line.quantity) ? null : number(line.quantity)
        if (["OclCancel", "OclSubstitute", "OclQuantity"].includes(action) && !(quantity > 0))
            denied("QUANTITY_INVALID", "Give a quantity above zero for line " + (line.orderItemSeqId || ""))
        return {
            orderItemSeqId: text(line.orderItemSeqId),
            changeActionEnumId: action,
            productId: text(line.productId),
            quantity,
            quantityUomId: text(line.quantityUomId),
            requiredByDate: blank(line.requiredByDate) ? null : line.requiredByDate,
            proposedUnitAmount: blank(line.proposedUnitAmount) ? null : line.proposedUnitAmount,
            pickExceptionId: text(line.pickExceptionId)
        }
    })
}
function save(p) {
    const existing = blank(p.requestId) ? null : changeOf(p.requestId, {lock: true, scoped: hasAny(readPermissions)})
    const orderId = existing ? existing.so.orderId : text(p.orderId)
    const staff = has("ORDER_CHANGE_REQUEST")
    let so
    if (staff) so = orderOf(orderId, {lock: true})
    else {
        // a customer contact's own order: unscoped, then checked as theirs
        so = orderOf(orderId, {lock: true, scoped: false})
        if (!customerSide(so)) denied("PERMISSION_DENIED", "ORDER_CHANGE_REQUEST is required")
    }
    if (existing && !existing.own && !staff) denied("PERMISSION_DENIED", "ORDER_CHANGE_REQUEST is required")
    const kind = text(p.orderChangeKindEnumId) || existing?.kind
    if (!Object.hasOwn(kindActions, kind || "")) denied("KIND_INVALID", "Choose what the change is")
    if (!staff && kind !== "OckCancel") denied("PERMISSION_DENIED", "A customer may ask only to cancel")
    const operation = !blank(p.operationKey)
        ? lib.operation(p, "OrderChangeSave", so.organizationPartyId, {
              requestId: p.requestId || null,
              orderId,
              kind,
              lines: p.lines || [],
              reason: p.reason || null
          })
        : null
    if (operation?.old) return lib.previous(operation)
    if (existing && !openStatuses.includes(existing.request.statusId))
        denied("CHANGE_CLOSED", "Order change " + existing.requestId + " is " + statusText(existing.request.statusId))
    if (!changeableOrderStatuses.includes(so.order.statusId))
        denied("ORDER_STATE", "Order " + so.orderId + " is " + statusText(so.order.statusId) + " and cannot be changed")
    if (p.expectedOrderRevision != null && number(p.expectedOrderRevision) !== so.revision)
        denied("STALE_ORDER", "Order " + so.orderId + " is at revision " + so.revision + " now; review it again")
    const lines = linesFrom(p, kind)
    if (kind === "OckSubstitute" && blank(p.customerConsentRef) && blank(existing?.request?.customerConsentRef))
        denied("CONSENT_REQUIRED", "Record the customer's consent to the substitute")
    const values = {
        orderChangeKindEnumId: kind,
        expectedOrderRevision: so.revision,
        description: text(p.reason) ?? existing?.request?.description ?? null,
        cancellationReason: text(p.cancellationReason),
        customerConsentRef: text(p.customerConsentRef) ?? existing?.request?.customerConsentRef ?? null,
        addressContactMechId: text(p.addressContactMechId),
        shipmentMethodEnumId: text(p.shipmentMethodEnumId),
        carrierPartyId: text(p.carrierPartyId)
    }
    const filer = ec.user.userAccount?.partyId || null
    let requestId
    if (existing) {
        requestId = existing.requestId
        call("update#" + REQUEST, Object.assign({requestId}, values))
        for (const old of rows(ITEM, {requestId}).filter(row => row.statusId !== "ReqCancelled"))
            call("update#" + ITEM, {requestId, requestItemSeqId: old.requestItemSeqId, statusId: "ReqCancelled"})
    } else {
        if (!blank(p.caseRequestId) && !one(REQUEST, {requestId: p.caseRequestId}))
            denied("RECORD_UNAVAILABLE", "Case " + p.caseRequestId + " is not available")
        requestId = call(
            "create#" + REQUEST,
            Object.assign(values, {
                requestTypeEnumId: changeType,
                statusId: "ReqSubmitted",
                requestName: enumText(kind) + " · order " + so.orderId,
                requestDate: ec.user.nowTimestamp,
                orderId: so.orderId,
                currencyUomId: so.currencyUomId,
                productStoreId: so.order.productStoreId || null,
                filedByPartyId: filer,
                caseRequestId: text(p.caseRequestId)
            })
        ).requestId
        const since = ec.user.nowTimestamp
        call("create#" + REQUEST_PARTY, {requestId, partyId: so.organizationPartyId, roleTypeId: "OrgInternal", fromDate: since})
        for (const customerPartyId of so.customerPartyIds)
            call("create#" + REQUEST_PARTY, {requestId, partyId: customerPartyId, roleTypeId: "Customer", fromDate: since})
    }
    // the lines: each a RequestItem with its order line
    const seqStart = rows(ITEM, {requestId}).length
    lines.forEach((line, index) => {
        const orderItem = line.orderItemSeqId ? one(ORDER_ITEM, {orderId: so.orderId, orderItemSeqId: line.orderItemSeqId}) : null
        if (!orderItem) denied("LINE_UNAVAILABLE", "Line " + (line.orderItemSeqId || "") + " is not on order " + so.orderId)
        const product = line.changeActionEnumId === "OclSubstitute" ? line.productId : line.productId || orderItem.productId
        if (line.changeActionEnumId === "OclSubstitute" && !product)
            denied("SUBSTITUTE_INVALID", "Choose the substitute product for line " + line.orderItemSeqId)
        const requestItemSeqId = String(seqStart + index + 1).padStart(2, "0")
        call("create#" + ITEM, {
            requestId,
            requestItemSeqId,
            statusId: "ReqSubmitted",
            changeActionEnumId: line.changeActionEnumId,
            productId: product,
            quantity: line.quantity ?? orderItem.quantity,
            quantityUomId: line.quantityUomId || orderItem.quantityUomId || null,
            requiredByDate: line.requiredByDate || orderItem.requiredByDate || null,
            proposedUnitAmount: line.proposedUnitAmount,
            pickExceptionId: line.pickExceptionId,
            description: orderItem.itemDescription || null
        })
        call("create#" + ITEM_ORDER, {
            requestId,
            requestItemSeqId,
            orderId: so.orderId,
            orderItemSeqId: line.orderItemSeqId,
            quantity: line.quantity ?? orderItem.quantity
        })
    })
    const ch = changeOf(requestId, {scoped: false})
    // the lines as the order is now: an applied kind's conflicts are refused when filed
    if (ch.applied) checkLines(ch, linesOf(requestId), true)
    const revision = revisionOf(requestId)
    // an earlier decision is for an earlier revision; it no longer counts
    for (const row of rows(DECISION, {requestId}).filter(row => !row.supersededDate))
        call("update#" + DECISION, {orderChangeDecisionId: row.orderChangeDecisionId, supersededDate: ec.user.nowTimestamp})
    let result = {requestId, sourceRevision: revision, statusId: "ReqSubmitted", immediate: false, notifiedCount: 0}
    // a customer's own cancel, applied at once under customerImmediateCancel when nothing on it has moved
    if (!staff && !existing && immediateCancelAllowed(ch)) {
        const policy = cases().policyOf(so.organizationPartyId)
        call("create#" + DECISION, {
            requestId,
            sourceRevision: revision,
            orderId: so.orderId,
            orderRevision: so.revision,
            organizationPartyId: so.organizationPartyId,
            decisionEnumId: "OcdApproved",
            decisionDate: ec.user.nowTimestamp,
            reason: "Applied at once under the service policy (customerImmediateCancel)",
            servicePolicyId: policy.servicePolicyId,
            expireDate: ec.user.nowTimestamp
        })
        applyChange(changeOf(requestId, {lock: true, lockOrder: true, scoped: false}), {sourceRevision: revision}, {policy: true})
        result = Object.assign(result, {statusId: "ReqCompleted", immediate: true, stateText: "Cancelled"})
    } else {
        result.notifiedCount = notify(ch, revision)
        result.stateText = staff ? stateTexts.requested : "Cancellation requested"
    }
    if (operation) lib.complete(operation, REQUEST, requestId, result)
    return Object.assign(result, {alreadyApplied: false})
}
// customerImmediateCancel (P2's ServicePolicy flag, off by default): on, and the order not approved, nothing on its lines
// reserved, picked, shipped or invoiced.
function immediateCancelAllowed(ch) {
    const policy = cases().policyOf(ch.so.organizationPartyId)
    if (policy?.customerImmediateCancel !== "Y") return false
    if (ch.kind !== "OckCancel" || !["OrderOpen", "OrderPlaced"].includes(ch.so.order.statusId)) return false
    return linesOf(ch.requestId).every(({orderItemSeqId}) => {
        const facts = orderItemSeqId ? lineFacts(ch.so.orderId, orderItemSeqId) : null
        return (
            !!facts &&
            facts.reserved === 0 &&
            facts.picked === 0 &&
            facts.issued === 0 &&
            facts.billedFinal + facts.billedInProcess === 0 &&
            facts.sources.length === 0
        )
    })
}

// ===== withdraw =====
function withdraw(p) {
    // P15 (F162): the filer may withdraw their own, unscoped as save is
    const ch = changeOf(p.requestId, {
        lock: true,
        scoped: hasAny(readPermissions) || hasAny(["ORDER_CHANGE_APPROVE", "SALES_APPROVE"])
    })
    if (!ch.own && !has(approvePermission(ch.kind)))
        denied("PERMISSION_DENIED", "Only who filed it or " + approvePermission(ch.kind) + " may withdraw it")
    if (!openStatuses.includes(ch.request.statusId))
        denied("CHANGE_CLOSED", "Order change " + ch.requestId + " is " + statusText(ch.request.statusId))
    if (blank(p.reason)) denied("REASON_REQUIRED", "Say why the change is withdrawn")
    call("update#" + REQUEST, {requestId: ch.requestId, statusId: "ReqCancelled", requestResolutionEnumId: "RrWontFix"})
    call("create#mantle.request.RequestNote", {requestId: ch.requestId, noteText: "Withdrawn: " + String(p.reason).trim()})
    clearNotices(ch.requestId)
    return {statusId: "ReqCancelled"}
}

// ===== decide =====
function decide(p) {
    const ch = changeOf(p.requestId, {lock: true})
    const permission = approvePermission(ch.kind)
    if (!has(permission)) denied("PERMISSION_DENIED", permission + " is required to decide a " + enumText(ch.kind) + " change")
    const decision = String(p.decision || "approve")
    if (!["approve", "refuse"].includes(decision)) denied("DECISION_INVALID", "Approve or refuse")
    const operation = !blank(p.operationKey)
        ? lib.operation(p, "OrderChangeDecide", ch.so.organizationPartyId, {
              requestId: ch.requestId,
              sourceRevision: p.sourceRevision ?? null,
              decision
          })
        : null
    if (operation?.old) return lib.previous(operation)
    if (!openStatuses.includes(ch.request.statusId))
        denied("CHANGE_CLOSED", "Order change " + ch.requestId + " is " + statusText(ch.request.statusId))
    const revision = revisionOf(ch.requestId)
    if (blank(p.sourceRevision)) denied("REVISION_REQUIRED", "Name the revision of the proposal you decide")
    if (number(p.sourceRevision) !== revision)
        denied(
            "STALE_REVISION",
            "Order change " + ch.requestId + " changed since (revision of " + revisionText(revision) + "); review it again"
        )
    if (decision === "approve" && number(ch.request.expectedOrderRevision) !== ch.so.revision)
        denied(
            "STALE_ORDER",
            "Order " +
                ch.so.orderId +
                " is at revision " +
                ch.so.revision +
                ", the proposal was made at revision " +
                number(ch.request.expectedOrderRevision)
        )
    const policy = cases().policyOf(ch.so.organizationPartyId)
    const partyId = ec.user.userAccount?.partyId || null
    if (policy?.orderChangeSelfApproval !== "Y" && partyId && partyId === ch.request.filedByPartyId)
        denied("SELF_APPROVAL", "Another approver decides a change you proposed")
    if (decision === "refuse" && blank(p.reason)) denied("REASON_REQUIRED", "Give the reason for the refusal")
    const days = number(policy?.orderChangeApprovalDays) || defaultApprovalDays
    const now = ec.user.nowTimestamp
    const expireDate = decision === "approve" ? new Date(Number(ms(now)) + days * 86400000) : null
    for (const row of rows(DECISION, {requestId: ch.requestId}).filter(row => !row.supersededDate))
        call("update#" + DECISION, {orderChangeDecisionId: row.orderChangeDecisionId, supersededDate: now})
    const decisionEnumId = decision === "approve" ? "OcdApproved" : "OcdRefused"
    const orderChangeDecisionId = call("create#" + DECISION, {
        requestId: ch.requestId,
        sourceRevision: revision,
        orderId: ch.so.orderId,
        orderRevision: ch.so.revision,
        organizationPartyId: ch.so.organizationPartyId,
        decisionEnumId,
        decisionDate: now,
        decidedByUserId: ec.user.userId,
        decidedByPartyId: partyId,
        reason: text(p.reason),
        expireDate,
        servicePolicyId: policy?.servicePolicyId || null,
        operationKey: text(p.operationKey)
    }).orderChangeDecisionId
    let statusId = ch.request.statusId
    if (decision === "refuse") {
        call("update#" + REQUEST, {requestId: ch.requestId, statusId: "ReqCancelled", requestResolutionEnumId: "RrRejected"})
        statusId = "ReqCancelled"
    }
    clearNotices(ch.requestId)
    const result = {orderChangeDecisionId, decisionEnumId, expireDate, statusId}
    if (operation) lib.complete(operation, DECISION, orderChangeDecisionId, result)
    return Object.assign(result, {alreadyApplied: false})
}
// The OrderChangeApproval topic's handlers: the decision at the revision the message names, never the current one.
function decideMessage(p, decision) {
    if (p.recordEntityName && p.recordEntityName !== REQUEST) denied("SOURCE_INVALID", "Not an order change")
    const message = p.message || {}
    if (message.sourceRevision == null || message.sourceRevision === "")
        denied("REVISION_REQUIRED", "The approval names no revision of the proposal; open it to decide")
    return decide({requestId: p.recordId, sourceRevision: message.sourceRevision, decision, reason: p.reason})
}

// ===== apply =====
function apply(p) {
    if (!has("ORDER_CHANGE_APPLY")) denied("PERMISSION_DENIED", "ORDER_CHANGE_APPLY is required to apply an order change")
    const first = changeOf(p.requestId)
    if (!first.applied)
        denied(
            "FORBIDDEN",
            "A " +
                enumText(first.kind) +
                " change is the order owner's to apply (Sales); Customer Service applies cancel and substitute only"
        )
    const operation = lib.operation(p, "OrderChangeApply", first.so.organizationPartyId, {
        requestId: first.requestId,
        sourceRevision: p.sourceRevision ?? null,
        expectedOrderRevision: p.expectedOrderRevision ?? null,
        previewVersion: p.previewVersion ?? null
    })
    if (operation.old) return lib.previous(operation)
    if (!truthy(p.confirmed)) denied("CONFIRMATION_REQUIRED", "Confirm the change; nothing changes until you do")
    if (blank(p.previewVersion)) denied("PREVIEW_REQUIRED", "Preview the change before applying it")
    // the one lock order: the proposal, the order's shipments, then the order (orderOf)
    const ch = changeOf(p.requestId, {lock: true, lockOrder: true})
    const result = applyChange(ch, p, {policy: false})
    lib.complete(operation, REQUEST, ch.requestId, result)
    return Object.assign(result, {alreadyApplied: false})
}
// The checks under the lock and the writes; a policy decision (a customer's immediate cancel) skips the user's preview.
function applyChange(ch, p, options) {
    const so = ch.so
    if (ch.request.statusId === "ReqCompleted") denied("CHANGE_CLOSED", "Order change " + ch.requestId + " is already applied")
    if (!openStatuses.includes(ch.request.statusId))
        denied("CHANGE_CLOSED", "Order change " + ch.requestId + " is " + statusText(ch.request.statusId))
    const revision = revisionOf(ch.requestId)
    if (!blank(p.sourceRevision) && number(p.sourceRevision) !== revision)
        denied(
            "STALE_REVISION",
            "Order change " + ch.requestId + " changed since (revision of " + revisionText(revision) + "); review it again"
        )
    const expected = number(ch.request.expectedOrderRevision)
    if (expected !== so.revision || (!blank(p.expectedOrderRevision) && number(p.expectedOrderRevision) !== expected))
        denied(
            "STALE_ORDER",
            "Order " + so.orderId + " is at revision " + so.revision + ", the proposal was made at revision " + expected
        )
    const {approval, expired} = approvalOf(ch.requestId, revision)
    if (!approval) denied("NOT_APPROVED", "Order change " + ch.requestId + " is not approved at its revision")
    if (expired && !options.policy) denied("APPROVAL_EXPIRED", "The approval of order change " + ch.requestId + " has expired")
    const closed = ec.resource
        .script("component://mr-mantle/service/mantle/ledger/PostingGuard.js")
        .fiscal(so.organizationPartyId, ec.user.nowTimestamp, false)
        .findings.find(row => row.code === "PERIOD_CLOSED")
    if (closed) denied("CLOSED_PERIOD", "The fiscal period of today is closed for " + partyName(so.organizationPartyId))
    const lineRows = linesOf(ch.requestId)
    const checked = checkLines(ch, lineRows, true)
    if (!options.policy && String(p.previewVersion) !== factsVersion(checked.lines.map(line => line.facts)))
        denied(
            "STOCK_CHANGED",
            "What is reserved, picked or packed on order " + so.orderId + " changed since the preview; preview it again"
        )
    // 1. a packed quantity off its package (the order goes back to Approved by the reopen)
    const reopened = []
    for (const line of checked.lines)
        for (const take of line.reopen) {
            call("mantle.shipment.WarehouseTaskServices.reopen#ShipmentPackageForChange", {
                organizationPartyId: so.organizationPartyId,
                shipmentId: take.shipmentId,
                shipmentPackageSeqId: take.shipmentPackageSeqId,
                productId: take.productId,
                quantity: take.quantity,
                reason: "Order change " + ch.requestId,
                confirmed: "Y"
            })
            reopened.push(take)
        }
    // 2. the Change hold (a customer's immediate cancel of an order not approved, with nothing on it, needs none)
    let hold = null
    if (!options.policy)
        hold = call("mantle.order.OrderServices.hold#Order", {
            orderId: so.orderId,
            holdTypeEnumId: "OhtChange",
            sourceId: ch.requestId,
            holdComment: "Applying order change " + ch.requestId
        })
    // 3. the lines
    const cancelled = [],
        added = []
    for (const line of checked.lines) {
        if (line.substitute) {
            const part = line.facts.item.orderPartSeqId
            const created = call("mantle.order.OrderServices.create#OrderItem", {
                orderId: so.orderId,
                orderPartSeqId: part,
                productId: line.substitute.productId,
                quantity: line.substitute.quantity,
                itemTypeEnumId: "ItemProduct",
                requireInventory: false
            })
            added.push({
                orderItemSeqId: created.orderItemSeqId,
                productId: line.substitute.productId,
                quantity: line.substitute.quantity
            })
            call("update#" + EXCEPTION, {exceptionId: line.substitute.exception.exceptionId, resolutionEnumId: "SpresSubstitute"})
        }
        if (line.cancelQuantity > 0) {
            call("mantle.order.OrderServices.cancel#OrderItem", {
                orderId: so.orderId,
                orderItemSeqId: line.orderItemSeqId,
                cancelQuantity: line.cancelQuantity
            })
            cancelled.push({orderItemSeqId: line.orderItemSeqId, quantity: line.cancelQuantity})
        }
    }
    // 4. the hold released; another open hold (a Credit hold) keeps the order held
    let stillHeld = false
    if (hold && !hold.alreadyHeld) {
        const released = call("mantle.order.OrderServices.release#OrderHold", {
            orderHoldReasonId: hold.orderHoldReasonId,
            releaseComment: "Order change " + ch.requestId + " applied"
        })
        stillHeld = !!released.stillHeld
    }
    // 5. a substitute joins its short pick's shipment, for Warehouse to pick, once the order is released
    for (const line of checked.lines.filter(row => row.substitute)) {
        const part = one(PART, {orderId: so.orderId, orderPartSeqId: line.facts.item.orderPartSeqId})
        const shipment = one(SHIPMENT, {shipmentId: line.substitute.exception.shipmentId})
        if (
            ["OrderApproved", "OrderSent"].includes(part.statusId) &&
            ["ShipInput", "ShipScheduled", "ShipPicked"].includes(shipment?.statusId)
        )
            call("mantle.shipment.ShipmentServices.add#OrderPartToShipment", {
                orderId: so.orderId,
                orderPartSeqId: part.orderPartSeqId,
                shipmentId: shipment.shipmentId
            })
    }
    // 6. the proposal applied, its PDF stored
    call("update#" + REQUEST, {
        requestId: ch.requestId,
        statusId: "ReqCompleted",
        requestResolutionEnumId: "RrCompleted",
        changeAppliedDate: ec.user.nowTimestamp
    })
    const orderContentId = storeApplied(ch, checked.lines, revision)
    clearNotices(ch.requestId)
    const after = one(ORDER, {orderId: so.orderId})
    return {
        requestId: ch.requestId,
        orderId: so.orderId,
        statusId: after.statusId,
        orderRevision: number(after.orderRevision || 1),
        cancelled,
        added,
        reopened,
        stillHeld,
        orderContentId
    }
}
// The applied change's PDF as the order's OrderContent; a render that fails is logged and the change stays.
function storeApplied(ch, lines, revision) {
    ec.message.pushErrors()
    try {
        const printLines = lines.map((line, index) => {
            const before = quantityText(line.facts.quantity) + " × " + productText(line.facts.productId)
            const left = line.facts.quantity - line.cancelQuantity
            const after = line.substitute
                ? quantityText(left) +
                  " × " +
                  productText(line.facts.productId) +
                  " + " +
                  quantityText(line.substitute.quantity) +
                  " × " +
                  productText(line.substitute.productId)
                : quantityText(left) + " × " + productText(line.facts.productId)
            return {seq: index + 1, actionText: enumText(line.item.changeActionEnumId), beforeText: before, afterText: after}
        })
        const html = ec.resource.template("component://mr-mantle/template/order/OrderChangeApplied.print.html.fancy", {
            orderId: ch.so.orderId,
            requestId: ch.requestId,
            organizationName: partyName(ch.so.organizationPartyId),
            customerName: ch.so.customerPartyIds.map(partyName).join(", "),
            kindText: enumText(ch.kind),
            reasonText: ch.request.description || "",
            appliedText: lib.dateText(ec.user.nowTimestamp),
            revisionText: revisionText(revision),
            lines: printLines
        })
        const pdf = ec.resource.xslFoTransform(html, null, null, "application/pdf")
        const location =
            "dbresource://mantle/content/order-change/" +
            ch.so.orderId +
            "/" +
            ch.requestId +
            "/OrderChange-" +
            ch.requestId +
            ".pdf"
        ec.resource.getLocationReference(location).putBytes(pdf)
        return call("create#" + CONTENT, {
            orderId: ch.so.orderId,
            orderContentTypeEnumId: appliedContentType,
            partyId: ch.so.customerPartyIds[0] || null,
            roleTypeId: ch.so.customerPartyIds.length ? "Customer" : null,
            contentLocation: location,
            contentDate: ec.user.nowTimestamp,
            userId: ec.user.userId,
            description: "Order change " + ch.requestId + " applied " + lib.dateText(ec.user.nowTimestamp)
        }).orderContentId
    } catch (error) {
        ec.logger.error("The PDF of order change " + ch.requestId + " was not stored: " + error.message)
        return null
    } finally {
        ec.message.clearErrors()
        ec.message.popErrors()
    }
}
const appliedContentOf = ch =>
    rows(CONTENT, {orderId: ch.so.orderId, orderContentTypeEnumId: appliedContentType}).find(row =>
        String(row.contentLocation || "").includes("/" + ch.requestId + "/")
    ) || null

// ===== the confirmation email =====
function confirm(p) {
    if (!hasAny(["ORDER_CHANGE_APPLY", "SUPPORT_CASE_EDIT"]))
        denied("PERMISSION_DENIED", "ORDER_CHANGE_APPLY or SUPPORT_CASE_EDIT is required")
    const ch = changeOf(p.requestId)
    const recipient = String(p.toAddress || "")
        .trim()
        .toLowerCase()
    const operation = lib.operation(p, "OrderChangeConfirm", ch.so.organizationPartyId, {
        requestId: ch.requestId,
        recipient,
        emailAccountId: p.emailAccountId || null
    })
    if (operation.old) return lib.previous(operation)
    if (ch.request.statusId !== "ReqCompleted") denied("NOT_APPLIED", "Order change " + ch.requestId + " is not applied")
    const content = appliedContentOf(ch)
    if (!content) denied("NOT_STORED", "Order change " + ch.requestId + " has no stored PDF to send")
    if (!recipient) denied("RECIPIENT_REQUIRED", "Give the address to send the confirmation to")
    if (!/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(recipient))
        denied("RECIPIENT_INVALID", recipient + " is not an email address")
    const allowed = confirmations().allowedRecipients(ch.so.customerPartyIds)
    if (!allowed.has(recipient))
        denied("RECIPIENT_UNCHECKED", recipient + " is not an address of the customer or of its contacts")
    const account = confirmations().senderAccount(p.emailAccountId, ch.so.organizationPartyId)
    const fileName = String(content.contentLocation).substring(String(content.contentLocation).lastIndexOf("/") + 1)
    const body =
        (p.note ? "<p>" + escapeHtml(p.note).replace(/\n/g, "<br>") + "</p>" : "") +
        "<p>" +
        escapeHtml(ec.l10n.localize("Attached is the change made to your order") + " " + ch.so.orderId + ".") +
        "</p>"
    const draft = lib.call("org.moqui.mail.EmailClientServices.save#Draft", {
        emailAccountId: account.emailAccountId,
        toAddresses: recipient,
        subject: ec.l10n.localize("Change to your order") + " " + ch.so.orderId + " · " + partyName(ch.so.organizationPartyId),
        body,
        attachmentList: [{attachmentLocation: content.contentLocation, fileName, contentType: "application/pdf"}]
    })
    const sent = lib.call("mantle.party.CommunicationServices.send#EmailDraft", {
        emailMessageId: draft.emailMessageId,
        recordEntityName: ORDER,
        recordId: ch.so.orderId
    })
    call("create#mantle.order.OrderEmailMessage", {
        orderId: ch.so.orderId,
        emailMessageId: draft.emailMessageId,
        partyId: allowed.get(recipient),
        roleTypeId: ch.so.customerPartyIds.includes(allowed.get(recipient)) ? "Customer" : null,
        orderContentId: content.orderContentId
    })
    const result = {
        requestId: ch.requestId,
        orderId: ch.so.orderId,
        orderContentId: content.orderContentId,
        emailMessageId: draft.emailMessageId,
        recipient,
        status: sent.sent ? "sent" : sent.sendError ? "failed" : "queued"
    }
    lib.complete(operation, "mantle.order.OrderEmailMessage", draft.emailMessageId, result)
    return Object.assign(result, {alreadyApplied: false})
}
const escapeHtml = value =>
    String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")

// ===== reads =====
function lineRowsOf(ch, checked) {
    const amounts = amountRead()
    const currency = ch.so.currencyUomId
    return checked.lines.map(line => {
        const f = line.facts
        const sub = line.substitute
        const subPrice = sub && amounts ? resolverPrice(sub.productId, sub.quantity, ch.so, f.item.orderPartSeqId) : null
        const facilityId = ch.so.parts.find(part => part.orderPartSeqId === f.item.orderPartSeqId)?.facilityId || null
        return {
            requestItemSeqId: line.item.requestItemSeqId,
            orderItemSeqId: line.orderItemSeqId,
            changeActionEnumId: line.item.changeActionEnumId,
            actionText: enumText(line.item.changeActionEnumId),
            productId: f.productId,
            productText: productText(f.productId),
            quantityText: quantityText(f.quantity),
            cancelledText: quantityText(f.cancelled),
            reservedText: quantityText(f.reserved),
            pickedText: quantityText(f.picked),
            packedText: quantityText([...f.packed.values()].reduce((sum, value) => sum + value, 0)),
            shippedText: quantityText(f.shipped),
            billedText: quantityText(f.billedFinal + f.billedInProcess),
            shortText: quantityText(f.short),
            proposedQuantityText: quantityText(line.quantity),
            cancelQuantityText: quantityText(line.cancelQuantity),
            afterText:
                quantityText(f.quantity - line.cancelQuantity) +
                (sub ? " + " + quantityText(sub.quantity) + " × " + productText(sub.productId) : ""),
            priceText: amounts ? money(f.item.unitAmount, currency) : null,
            proposedPriceText:
                amounts && line.item.proposedUnitAmount != null ? money(line.item.proposedUnitAmount, currency) : null,
            substituteProductId: sub?.productId || null,
            substituteText: sub ? productText(sub.productId) : null,
            substitutePriceText: sub ? (amounts ? (subPrice == null ? "No price" : money(subPrice, currency)) : null) : null,
            substituteAvailableText: sub ? quantityText(availableAt(sub.productId, facilityId) ?? 0) : null,
            substituteAssocText: sub ? enumText(substituteAssoc(f.productId, sub.productId)?.productAssocTypeEnumId) : null,
            pickExceptionId: line.item.pickExceptionId || null,
            reopenText: line.reopen
                .map(
                    take => quantityText(take.quantity) + " from package " + take.shipmentPackageSeqId + " of " + take.shipmentId
                )
                .join(", "),
            requiredByText: line.item.requiredByDate ? lib.dateText(line.item.requiredByDate) : ""
        }
    })
}
// What the user may do with a proposal, each with why not.
function actionsOf(ch, state, revision) {
    const kindPermission = approvePermission(ch.kind)
    const open = openStatuses.includes(ch.request.statusId)
    const partyId = ec.user.userAccount?.partyId || null
    const policy = cases().policyOf(ch.so.organizationPartyId)
    const selfBlocked = policy?.orderChangeSelfApproval !== "Y" && partyId && partyId === ch.request.filedByPartyId
    const why = (ok, reason) => ({allowed: !!ok, reason: ok ? null : reason})
    return {
        save: why(open && has("ORDER_CHANGE_REQUEST"), open ? "ORDER_CHANGE_REQUEST is required" : "The change is closed"),
        decide: why(
            open && has(kindPermission) && !selfBlocked && state !== "stale",
            !open
                ? "The change is closed"
                : !has(kindPermission)
                  ? kindPermission + " is required"
                  : selfBlocked
                    ? "Another approver decides a change you proposed"
                    : "The order changed since the proposal"
        ),
        apply: why(
            ch.applied && state === "approved" && has("ORDER_CHANGE_APPLY"),
            !ch.applied
                ? "The order's owner (Sales) applies this kind"
                : state !== "approved"
                  ? "It is not approved"
                  : "ORDER_CHANGE_APPLY is required"
        ),
        withdraw: why(
            open && (ch.own || has(kindPermission)),
            open ? "Only who filed it or an approver" : "The change is closed"
        ),
        confirm: why(
            ch.request.statusId === "ReqCompleted" && hasAny(["ORDER_CHANGE_APPLY", "SUPPORT_CASE_EDIT"]),
            "Only an applied change is confirmed"
        )
    }
}
function get(p) {
    const ch = changeOf(p.requestId)
    requireRead(ch)
    const revision = revisionOf(ch.requestId)
    const state = stateOf(ch.request, ch.so, revision)
    const checked = checkLines(ch, linesOf(ch.requestId), false)
    const decisions = decisionsOf(ch.requestId).map(row => ({
        orderChangeDecisionId: row.orderChangeDecisionId,
        decisionText: enumText(row.decisionEnumId),
        decisionEnumId: row.decisionEnumId,
        decidedByName: row.decidedByPartyId ? partyName(row.decidedByPartyId) : row.servicePolicyId ? "The service policy" : "",
        reason: row.reason || "",
        decidedText: lib.dateText(row.decisionDate),
        expireText: row.expireDate ? lib.dateText(row.expireDate) : "",
        revisionText: revisionText(number(row.sourceRevision)),
        current: !row.supersededDate && number(row.sourceRevision) === revision
    }))
    const content = appliedContentOf(ch)
    const r = ch.request
    return {
        change: {
            requestId: ch.requestId,
            orderId: ch.so.orderId,
            orderName: ch.so.order.orderName || "",
            orderStatusText: statusText(ch.so.order.statusId),
            organizationPartyId: ch.so.organizationPartyId,
            organizationName: partyName(ch.so.organizationPartyId),
            customerPartyIds: ch.so.customerPartyIds,
            customerName: ch.so.customerPartyIds.map(partyName).join(", "),
            kindEnumId: ch.kind,
            kindText: enumText(ch.kind),
            appliedHere: ch.applied,
            statusId: r.statusId,
            state,
            stateText: stateTexts[state],
            reason: r.description || "",
            cancellationReason: r.cancellationReason || "",
            customerConsentRef: r.customerConsentRef || "",
            caseRequestId: r.caseRequestId || null,
            requestedByName: partyName(r.filedByPartyId),
            requestedText: lib.dateText(r.requestDate),
            appliedText: r.changeAppliedDate ? lib.dateText(r.changeAppliedDate) : "",
            sourceRevision: revision,
            revisionText: revisionText(revision),
            expectedOrderRevision: number(r.expectedOrderRevision),
            orderRevision: ch.so.revision,
            addressContactMechId: r.addressContactMechId || null,
            shipmentMethodText: enumText(r.shipmentMethodEnumId),
            carrierName: r.carrierPartyId ? partyName(r.carrierPartyId) : "",
            lines: lineRowsOf(ch, checked),
            conflicts: checked.conflicts,
            decisions,
            orderContentId: content?.orderContentId || null,
            amountsWithheld: !amountRead(),
            actions: actionsOf(ch, state, revision)
        }
    }
}
function preview(p) {
    const ch = changeOf(p.requestId)
    requireRead(ch)
    const revision = revisionOf(ch.requestId)
    const checked = checkLines(ch, linesOf(ch.requestId), false)
    const conflicts = checked.conflicts.slice()
    if (number(ch.request.expectedOrderRevision) !== ch.so.revision)
        conflicts.unshift({
            code: "STALE_ORDER",
            message:
                "Order " +
                ch.so.orderId +
                " is at revision " +
                ch.so.revision +
                ", the proposal was made at revision " +
                number(ch.request.expectedOrderRevision)
        })
    if (!ch.applied) conflicts.push({code: "FORBIDDEN", message: "The order's owner (Sales) decides and applies this kind"})
    let paidText = null
    if (hasAny(financePermissions)) {
        const paid = rows("mantle.account.payment.Payment", {orderId: ch.so.orderId})
            .filter(row => ["PmntDelivered", "PmntConfirmed"].includes(row.statusId))
            .reduce((sum, row) => sum.add(toDecimal(row.amount ?? 0)), toDecimal(0))
        paidText = money(paid, ch.so.currencyUomId)
    }
    const holds = rows("mantle.order.OrderHoldReason", {orderId: ch.so.orderId})
        .filter(row => !row.releasedDate)
        .map(row => enumText(row.holdTypeEnumId))
    return {
        preview: {
            requestId: ch.requestId,
            orderId: ch.so.orderId,
            sourceRevision: revision,
            expectedOrderRevision: number(ch.request.expectedOrderRevision),
            orderRevision: ch.so.revision,
            lines: lineRowsOf(ch, checked),
            conflicts,
            blocked: conflicts.length > 0,
            heldText: holds.join(", "),
            paidText,
            amountsWithheld: !amountRead(),
            previewVersion: factsVersion(checked.lines.map(line => line.facts))
        }
    }
}
function findChanges(p) {
    if (!hasAny(readPermissions)) denied("PERMISSION_DENIED", readPermissions.join(" or ") + " is required to read order changes")
    const userScope = facilityScope.scope()
    let query = ec.entity
        .find(REQUEST)
        .condition("requestTypeEnumId", changeType)
        .condition("orderId", "is-not-null", null)
        .disableAuthz()
    if (!blank(p.orderId)) query = query.condition("orderId", p.orderId)
    if (!blank(p.caseRequestId)) query = query.condition("caseRequestId", p.caseRequestId)
    if (!blank(p.requestedByPartyId)) query = query.condition("filedByPartyId", p.requestedByPartyId)
    if (p.fromDate) query = query.condition("requestDate", "greater-equals", p.fromDate)
    if (p.thruDate) query = query.condition("requestDate", "less", p.thruDate)
    // the user's organizations' orders: their OrgInternal party, read in the query
    const orgIds = userScope.organizationPartyIds
    const partyFilter = (roleTypeId, partyIds) =>
        Array.from(
            find(REQUEST_PARTY, {roleTypeId}).condition("partyId", "in", partyIds).selectField("requestId").distinct(true).list()
        ).map(row => row.requestId)
    let ids = null
    const narrow = list => (ids = ids == null ? list : ids.filter(id => list.includes(id)))
    if (orgIds) narrow(partyFilter("OrgInternal", orgIds))
    if (!blank(p.organizationPartyId)) narrow(partyFilter("OrgInternal", [p.organizationPartyId]))
    if (!blank(p.customerPartyId)) narrow(partyFilter("Customer", [p.customerPartyId]))
    if (!blank(p.approverUserId))
        narrow(
            Array.from(find(DECISION, {decidedByUserId: p.approverUserId}).selectField("requestId").distinct(true).list()).map(
                row => row.requestId
            )
        )
    if (ids != null) {
        if (!ids.length) return lib.pageList([], p, "changeList")
        query = query.condition("requestId", "in", ids.slice(0, 2000))
    }
    const all = Array.from(query.orderBy("-requestDate").limit(500).list())
    const rowsOut = []
    for (const request of all) {
        let so
        try {
            so = orderOf(request.orderId, {scoped: true})
        } catch (error) {
            continue
        }
        const revision = revisionOf(request.requestId)
        const state = stateOf(request, so, revision)
        if (!blank(p.state) && p.state !== state) continue
        const decision = decisionsOf(request.requestId).find(row => !row.supersededDate) || null
        const lines = linesOf(request.requestId)
        const held = rows("mantle.order.OrderHoldReason", {orderId: so.orderId}).some(row => !row.releasedDate)
        rowsOut.push({
            requestId: request.requestId,
            orderId: so.orderId,
            orderRevision: so.revision,
            caseRequestId: request.caseRequestId || null,
            customerName: so.customerPartyIds.map(partyName).join(", "),
            kindText: enumText(request.orderChangeKindEnumId),
            linesText: lines
                .map(
                    ({item, orderItemSeqId}) =>
                        enumText(item.changeActionEnumId) +
                        " " +
                        quantityText(item.quantity) +
                        " × " +
                        productText(item.productId) +
                        (orderItemSeqId ? " (line " + orderItemSeqId + ")" : "")
                )
                .join("; "),
            reason: request.description || "",
            requestedByName: partyName(request.filedByPartyId),
            requestedText: lib.dateText(request.requestDate),
            decidedText: decision ? enumText(decision.decisionEnumId) + " " + lib.dateText(decision.decisionDate) : "",
            approverName: decision?.decidedByPartyId ? partyName(decision.decidedByPartyId) : "",
            conflictText: state === "stale" ? "The order changed since" : held ? "The order is held" : "",
            state,
            stateText: stateTexts[state]
        })
    }
    return lib.pageList(rowsOut, p, "changeList")
}

const operations = {
    save,
    withdraw,
    get,
    preview,
    decide,
    approveMessage: p => decideMessage(p, "approve"),
    refuseMessage: p => decideMessage(p, "refuse"),
    apply,
    confirm,
    find: findChanges
}
;({
    revisionOf,
    stateTexts,
    // P15: the Support app's customer read of its cancel request (CustomerOrders.js)
    lineFacts,
    linesOf,
    stateOf,
    changeOf,
    // each operation checks its own permission and organization, and reads and writes with artifact authorization off
    execute: (op, parameters) => {
        if (!operations[op]) throw new Error("Unknown order change operation " + op)
        const wasDisabled = ec.artifactExecution.disableAuthz()
        try {
            return operations[op](parameters)
        } finally {
            if (!wasDisabled) ec.artifactExecution.enableAuthz()
        }
    }
})
