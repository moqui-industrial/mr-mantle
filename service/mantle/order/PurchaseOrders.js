// Purchase orders and their approval (design-purchasing §6 PurchaseOrders and OrderDetail; impl-purchasing P3, §2, §4, F7,
// F33): the buyer's verbs over Mantle's order services (create, lines, header, place, cancel, clone) under
// PURCHASE_ORDER_EDIT in the buying organization, one purchase part per order, each line's product usable for buying and its
// cost centre one of the organization's; the supplier check of the buying policy (Warn or Stop) on create, place and
// approval; the approval decision of design ApprovalPolicies' no-policy rule (one step by a purchase approver, self-approval
// refused unless the policy allows it) and the approval gate behind the buying policy's flag (approvalGateEnabled): a
// purchase part reaches Approved only with a current decision for the order's revision, on approve#Order and on
// autoApprove#Order (check#PurchaseApprovalRequired, the SECA on check#OrderPreApprove). approve#Order's and hold#Order's
// direction checks read approveRefusal and holdAllowed here. A purchase part is an internal organization's (the customer)
// order from a party that is not an internal organization (the vendor).
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const facilityScope = ec.resource.script("component://mr-mantle/service/mantle/facility/FacilityScope.js")
const policy = ec.resource.script("component://mr-mantle/service/mantle/order/PurchasePolicy.js")
// P4: the approval policies' steps, notices and budget (PurchaseApprovals.js)
const approvals = () => ec.resource.script("component://mr-mantle/service/mantle/order/PurchaseApprovals.js")
// P9: a revised order's approval releases the revision's Change hold (PurchaseRevisions.js)
const revisions = () => ec.resource.script("component://mr-mantle/service/mantle/order/PurchaseRevisions.js")
// P10: a request-sourced line's approval converts the request's commitment (PurchaseRequests.js)
const requests = () => ec.resource.script("component://mr-mantle/service/mantle/request/PurchaseRequests.js")
// P13: a purchase agreement's approval is decided here too (PurchaseAgreements.js)
const agreements = () => ec.resource.script("component://mr-mantle/service/mantle/party/PurchaseAgreements.js")
const {find, one, rows, call, denied, access, ms} = lib

const ORDER = "mantle.order.OrderHeader",
    PART = "mantle.order.OrderPart",
    ITEM = "mantle.order.OrderItem",
    DECISION = "mantle.order.purchase.PurchaseApprovalDecision"
// the statuses a buyer edits a purchase order's lines and header in; a placed order changes through a revision (P9)
const draftStatuses = ["OrderOpen"]
const cancellableStatuses = ["OrderOpen", "OrderPlaced", "OrderProcessing", "OrderApproved", "OrderSent", "OrderHold"]
const blank = value => value == null || String(value).trim() === ""
const text = value => (blank(value) ? null : String(value).trim())
const hasRole = (partyId, roleTypeId) => !!partyId && !!one("mantle.party.PartyRole", {partyId, roleTypeId})
const isInternal = partyId => hasRole(partyId, "OrgInternal")
// A purchase part: an internal organization buys from a party that is not one.
const isPurchasePart = part => isInternal(part.customerPartyId) && !!part.vendorPartyId && !isInternal(part.vendorPartyId)
const revisionOf = order => Number(order.orderRevision ?? 1)
const partyName = partyId => lib.partyNames([partyId])[partyId] || partyId || ""

// ===== checks =====
// P16: a supplier's response from its PASS page (SupplierPortal.js, after check#AccessCapability) runs Mantle's own verbs on
// that one order as a claim for internal review: while its claim is set, the order's PURCHASE_ORDER_EDIT and organization
// checks are the capability's, for that order only, and every other order is unavailable. Only SupplierPortal.js sets it
// (asSupplier), never a request's input.
const PORTAL_CLAIM = "SupplierPortalClaim"
const portalClaim = () => ec.context.sharedMap[PORTAL_CLAIM] || null
function asSupplier(claim, work) {
    const shared = ec.context.sharedMap,
        before = shared[PORTAL_CLAIM]
    shared[PORTAL_CLAIM] = {
        orderId: String(claim.orderId),
        organizationPartyId: claim.organizationPartyId,
        supplierPartyId: claim.supplierPartyId
    }
    try {
        return work()
    } finally {
        if (before == null) delete shared[PORTAL_CLAIM]
        else shared[PORTAL_CLAIM] = before
    }
}
// The claim stands in for PURCHASE_ORDER_EDIT alone: a check that also takes another permission (an approval's, a read's
// list) is never the supplier's.
const claimed = permissions => !!portalClaim() && permissions.length === 1 && permissions[0] === "PURCHASE_ORDER_EDIT"
function requirePermission(...permissions) {
    if (claimed(permissions)) return
    if (!permissions.some(permission => access.has(permission)))
        denied("PERMISSION_DENIED", permissions.join(" or ") + " is required")
}
function requireOrganization(organizationPartyId) {
    if (
        !organizationPartyId ||
        !isInternal(organizationPartyId) ||
        !facilityScope.owns(facilityScope.scope(), organizationPartyId)
    )
        denied("RECORD_UNAVAILABLE", "Organization " + (organizationPartyId || "") + " is not available")
}
// The purchase order of a verb: one purchase part (F7), its buyer one of the user's organizations. A missing order and one
// outside the user's organizations are refused alike (RECORD_UNAVAILABLE).
function purchaseOrder(orderId, lock = false) {
    const unavailable = () => denied("RECORD_UNAVAILABLE", "Purchase order " + (orderId || "") + " is not available")
    if (blank(orderId)) unavailable()
    const order = lock ? find(ORDER, {orderId}).forUpdate(true).one() : one(ORDER, {orderId})
    if (!order) unavailable()
    const parts = rows(PART, {orderId})
    if (!parts.length || !parts.every(isPurchasePart)) denied("NOT_PURCHASE", "Order " + orderId + " is not a purchase order")
    if (parts.length > 1) denied("PURCHASE_PARTS", "Purchase order " + orderId + " has more than one part")
    const part = parts[0]
    const claim = portalClaim()
    if (claim) {
        if (
            claim.orderId !== String(orderId) ||
            claim.organizationPartyId !== part.customerPartyId ||
            claim.supplierPartyId !== part.vendorPartyId
        )
            unavailable()
    } else if (!facilityScope.owns(facilityScope.scope(), part.customerPartyId)) unavailable()
    return {
        order,
        part,
        orderId: String(orderId),
        orderPartSeqId: part.orderPartSeqId,
        organizationPartyId: part.customerPartyId,
        supplierPartyId: part.vendorPartyId
    }
}
// A supplier the organization may buy from: a Supplier-role party, not an internal organization, owned by the organization or
// shared (_NA_) or unowned (Mantle's own suppliers); another organization's supplier is refused (SUPPLIER_UNAVAILABLE).
function supplierOf(organizationPartyId, supplierPartyId) {
    const party = blank(supplierPartyId) ? null : one("mantle.party.Party", {partyId: supplierPartyId})
    const owner = party?.ownerPartyId
    if (
        !party ||
        party.disabled === "Y" ||
        !hasRole(supplierPartyId, "Supplier") ||
        isInternal(supplierPartyId) ||
        (owner && owner !== "_NA_" && owner !== organizationPartyId)
    )
        denied("SUPPLIER_UNAVAILABLE", "Choose an available supplier")
    return party
}
// The buying policy's supplier check (check#SupplierUsable's rule): a Stop refuses with its reason code, a Warn adds a
// warning message.
function supplierCheck(organizationPartyId, supplierPartyId) {
    const checked = policy.supplierUsable(organizationPartyId, supplierPartyId)
    if (checked.result === "STOP") denied(checked.reasonCode, checked.message)
    if (checked.result === "WARN") ec.message.addMessage(checked.message, "warning")
    return checked
}
// A cost centre of the organization: one of the organizations that roll up to it (PrtOrgRollup), as Accounting's choices.
function costCenterOf(organizationPartyId, costCenterId) {
    if (blank(costCenterId)) return null
    const rollup = rows("mantle.party.PartyRelationship", {
        fromPartyId: costCenterId,
        toPartyId: organizationPartyId,
        relationshipTypeEnumId: "PrtOrgRollup"
    }).some(row => lib.active(row))
    if (costCenterId !== organizationPartyId && !rollup)
        denied("COST_CENTER_INVALID", "Choose a cost centre of " + partyName(organizationPartyId))
    return String(costCenterId)
}
function decimal(value, label, allowZero) {
    let number
    try {
        number = toDecimal(value)
    } catch (_) {
        number = null
    }
    if (number == null || number.compare(0) < 0 || (!allowZero && number.isZero()))
        denied("QUANTITY_INVALID", "Enter a " + (allowZero ? "" : "positive ") + label)
    return number
}
function requireDraft(po) {
    if (!draftStatuses.includes(po.order.statusId))
        denied("ORDER_NOT_DRAFT", "Purchase order " + po.orderId + " is no longer a draft; change it through a revision")
}

// ===== the buyer's verbs =====
// create#PurchaseOrder: a draft order of the organization from the supplier, with one purchase part.
function create(p) {
    requirePermission("PURCHASE_ORDER_EDIT")
    const organizationPartyId = text(p.organizationPartyId)
    requireOrganization(organizationPartyId)
    const supplierPartyId = text(p.vendorPartyId)
    supplierOf(organizationPartyId, supplierPartyId)
    const checked = supplierCheck(organizationPartyId, supplierPartyId)
    const buying = policy.effective(organizationPartyId).policy
    const profile = rows("mantle.party.supplier.SupplierProfile", {organizationPartyId, supplierPartyId})
        .filter(row => lib.active(row))
        .sort((a, b) => ms(b.fromDate) - ms(a.fromDate))[0]
    const facilityId = text(p.facilityId) || buying.facilityId || null
    if (facilityId && one("mantle.facility.Facility", {facilityId})?.ownerPartyId !== organizationPartyId)
        denied("FACILITY_INVALID", "Choose a facility of " + partyName(organizationPartyId))
    const currencyUomId = text(p.currencyUomId) || profile?.currencyUomId || buying.currencyUomId || null
    if (currencyUomId && one("moqui.basic.Uom", {uomId: currencyUomId})?.uomTypeEnumId !== "UT_CURRENCY_MEASURE")
        denied("CURRENCY_INVALID", "Choose a currency")
    const created = call("mantle.order.OrderServices.create#Order", {
        customerPartyId: organizationPartyId,
        vendorPartyId: supplierPartyId,
        currencyUomId,
        facilityId,
        orderName: text(p.orderName),
        settlementTermId: text(p.settlementTermId) || profile?.settlementTermId || null,
        tradeTermEnumId: text(p.tradeTermEnumId) || profile?.tradeTermEnumId || null,
        statusId: "OrderOpen"
    })
    return {
        orderId: created.orderId,
        orderPartSeqId: created.orderPartSeqId,
        supplierResult: checked.result,
        supplierMessage: checked.message
    }
}
// update#PurchaseOrder: a draft's name and receiving facility.
function update(p) {
    requirePermission("PURCHASE_ORDER_EDIT")
    const po = purchaseOrder(p.orderId, true)
    requireDraft(po)
    if (Object.keys(p).includes("orderName") && p.orderName !== undefined)
        call("update#" + ORDER, {orderId: po.orderId, orderName: text(p.orderName)})
    if (!blank(p.facilityId)) {
        if (one("mantle.facility.Facility", {facilityId: p.facilityId})?.ownerPartyId !== po.organizationPartyId)
            denied("FACILITY_INVALID", "Choose a facility of " + partyName(po.organizationPartyId))
        call("update#" + PART, {orderId: po.orderId, orderPartSeqId: po.orderPartSeqId, facilityId: String(p.facilityId)})
    }
    // P9: the draft's delivery date and terms (a placed order's change through a revision)
    const terms = {}
    if (p.estimatedDeliveryDate !== undefined)
        terms.estimatedDeliveryDate = blank(p.estimatedDeliveryDate) ? null : p.estimatedDeliveryDate
    if (p.settlementTermId !== undefined) {
        if (!blank(p.settlementTermId) && !one("mantle.account.invoice.SettlementTerm", {settlementTermId: p.settlementTermId}))
            denied("TERM_INVALID", "Choose a payment term")
        terms.settlementTermId = text(p.settlementTermId)
    }
    if (p.tradeTermEnumId !== undefined) {
        if (!blank(p.tradeTermEnumId) && one("moqui.basic.Enumeration", {enumId: p.tradeTermEnumId})?.parentEnumId !== "TtInco")
            denied("TERM_INVALID", "Choose an incoterm")
        terms.tradeTermEnumId = text(p.tradeTermEnumId)
    }
    if (Object.keys(terms).length)
        call("update#" + PART, Object.assign({orderId: po.orderId, orderPartSeqId: po.orderPartSeqId}, terms))
    return {orderId: po.orderId}
}
// store#PurchaseOrderItem: a draft's line, new (a product usable for buying, at the supplier's price unless one is given) or
// changed (quantity, unit, price, description, required date, cost centre).
function storeItem(p) {
    requirePermission("PURCHASE_ORDER_EDIT")
    const po = purchaseOrder(p.orderId, true)
    requireDraft(po)
    const costCenterId = costCenterOf(po.organizationPartyId, p.costCenterId)
    const unitAmount = blank(p.unitAmount) ? null : decimal(p.unitAmount, "price", true)
    if (!blank(p.orderItemSeqId)) {
        const item = one(ITEM, {orderId: po.orderId, orderItemSeqId: p.orderItemSeqId})
        if (!item) denied("ITEM_UNAVAILABLE", "Line " + p.orderItemSeqId + " is not on purchase order " + po.orderId)
        const changes = {orderId: po.orderId, orderItemSeqId: item.orderItemSeqId}
        if (!blank(p.quantity)) changes.quantity = decimal(p.quantity, "quantity", false)
        if (unitAmount != null) Object.assign(changes, {unitAmount, isModifiedPrice: "Y"})
        if (!blank(p.quantityUomId)) changes.quantityUomId = String(p.quantityUomId)
        if (p.itemDescription !== undefined) changes.itemDescription = text(p.itemDescription)
        if (p.requiredByDate !== undefined) changes.requiredByDate = blank(p.requiredByDate) ? null : p.requiredByDate
        if (p.costCenterId !== undefined) changes.costCenterId = costCenterId
        // P13 review: a line released from an agreement takes no more than its releases (another release checks the caps)
        const overRelease = agreements().releasedLineRefusal(
            po.orderId,
            item.orderItemSeqId,
            changes.quantity,
            changes.unitAmount
        )
        if (overRelease) denied(overRelease[0], overRelease[1])
        call("update#" + ITEM, changes)
        return {orderId: po.orderId, orderItemSeqId: item.orderItemSeqId}
    }
    const productId = text(p.productId)
    if (!productId || !one("mantle.product.Product", {productId})) denied("PRODUCT_REQUIRED", "Choose a product")
    const quantity = decimal(blank(p.quantity) ? 1 : p.quantity, "quantity", false)
    const usable = call("mantle.product.ProductServices.check#ProductUsable", {
        productId,
        usage: "Purchase",
        quantity,
        facilityId: po.part.facilityId || null,
        vendorPartyId: po.supplierPartyId,
        customerPartyId: po.organizationPartyId
    })
    if (!usable.usable) denied("PRODUCT_NOT_USABLE", usable.reason || productId + " is not usable for buying")
    const line = {
        orderId: po.orderId,
        orderPartSeqId: po.orderPartSeqId,
        productId,
        quantity,
        quantityUomId: text(p.quantityUomId),
        itemTypeEnumId: text(p.itemTypeEnumId) || "ItemProduct",
        itemDescription: text(p.itemDescription),
        requiredByDate: blank(p.requiredByDate) ? null : p.requiredByDate,
        costCenterId
    }
    if (unitAmount != null) Object.assign(line, {unitAmount, isModifiedPrice: "Y"})
    else {
        const price = call("mantle.product.PriceServices.get#ProductPrice", {
            productId,
            quantity,
            quantityUomId: line.quantityUomId,
            vendorPartyId: po.supplierPartyId,
            customerPartyId: po.organizationPartyId,
            organizationPartyId: po.organizationPartyId,
            pricePurposeEnumId: "PppPurchase",
            priceUomId: po.order.currencyUomId,
            direction: "purchase",
            validDate: ec.user.nowTimestamp
        })
        if (!price.priceAvailable)
            denied(
                "PRICE_UNAVAILABLE",
                productId + " has no purchase price from " + partyName(po.supplierPartyId) + " you may read; enter the price"
            )
        Object.assign(line, {unitAmount: price.price, productPriceId: price.productPriceId || null, isModifiedPrice: "N"})
    }
    const created = call("mantle.order.OrderServices.create#OrderItem", line)
    return {orderId: po.orderId, orderItemSeqId: created.orderItemSeqId}
}
// delete#PurchaseOrderItem: a draft's line removed.
function removeItem(p) {
    requirePermission("PURCHASE_ORDER_EDIT")
    const po = purchaseOrder(p.orderId, true)
    requireDraft(po)
    if (blank(p.orderItemSeqId) || !one(ITEM, {orderId: po.orderId, orderItemSeqId: p.orderItemSeqId}))
        denied("ITEM_UNAVAILABLE", "Line " + (p.orderItemSeqId || "") + " is not on purchase order " + po.orderId)
    call("mantle.order.OrderServices.delete#OrderItem", {orderId: po.orderId, orderItemSeqId: String(p.orderItemSeqId)})
    return {orderId: po.orderId}
}
// place#PurchaseOrder: a draft with lines, to a supplier the policy does not stop, placed. Mantle's OrderPlaced rules then
// run: with the approval gate on, check#PurchaseApprovalRequired keeps autoApprove#Order from approving it.
function place(p) {
    requirePermission("PURCHASE_ORDER_EDIT")
    const po = purchaseOrder(p.orderId, true)
    requireDraft(po)
    if (!rows(ITEM, {orderId: po.orderId}).length) denied("ORDER_EMPTY", "Add a line before placing purchase order " + po.orderId)
    const checked = supplierCheck(po.organizationPartyId, po.supplierPartyId)
    call("mantle.order.OrderServices.place#Order", {orderId: po.orderId})
    const statusId = one(ORDER, {orderId: po.orderId}).statusId
    // P4: a placed order waiting for approval goes to its first step's approvers (PurchaseOrderApproval)
    if (statusId === "OrderPlaced") approvals().notify(approvals().orderSource(po))
    return {
        orderId: po.orderId,
        statusId,
        supplierResult: checked.result,
        supplierMessage: checked.message
    }
}
// cancel#PurchaseOrder: an order nothing was received or billed on, cancelled with its reason (an internal note). A partly
// received order closes its remainder instead (close#PurchaseRemainders).
function cancel(p) {
    requirePermission("PURCHASE_ORDER_EDIT")
    const po = purchaseOrder(p.orderId, true)
    const reason = text(p.reason)
    if (!reason) denied("REASON_REQUIRED", "Give a reason for cancelling the purchase order")
    if (!cancellableStatuses.includes(po.order.statusId))
        denied("ORDER_NOT_OPEN", "Purchase order " + po.orderId + " cannot be cancelled in its status")
    const received = find("mantle.product.receipt.AssetReceipt").condition("orderId", po.orderId).count()
    if (received > 0)
        denied("ORDER_RECEIVED", "Purchase order " + po.orderId + " has receipts; close its remainder instead of cancelling it")
    if (find("mantle.order.OrderItemBilling").condition("orderId", po.orderId).count() > 0)
        denied("ORDER_BILLED", "Purchase order " + po.orderId + " has been billed")
    call("mantle.order.OrderServices.cancel#Order", {orderId: po.orderId})
    // P4 (D10): what is left of the order's budget commitments is released, and its approval notices read
    if (one(ORDER, {orderId: po.orderId}).statusId === "OrderCancelled")
        call("mantle.other.BudgetServices.release#ClosedSourceCommitments", {sourceEntityName: ORDER, sourceId: po.orderId})
    approvals().clearNotices(approvals().orderSource(po))
    call("create#mantle.order.OrderNote", {
        orderId: po.orderId,
        noteDate: ec.user.nowTimestamp,
        noteText: "Cancelled: " + reason,
        internalNote: "Y",
        userId: ec.user.userId
    })
    return {orderId: po.orderId, statusId: one(ORDER, {orderId: po.orderId}).statusId}
}
// clone#PurchaseOrder: a new draft with the order's lines and parties (no payments, files or notes); lines whose product is
// no longer usable for buying are named in a warning to fix before placing.
function clone(p) {
    requirePermission("PURCHASE_ORDER_EDIT")
    const po = purchaseOrder(p.orderId)
    supplierOf(po.organizationPartyId, po.supplierPartyId)
    supplierCheck(po.organizationPartyId, po.supplierPartyId)
    const cloned = call("mantle.order.OrderServices.clone#Order", {
        orderId: po.orderId,
        statusId: "OrderOpen",
        copyPayment: false,
        copyContent: false,
        copyNote: false,
        copyItemWorkEffort: false
    })
    const unusable = []
    for (const item of rows(ITEM, {orderId: cloned.orderId}).filter(row => row.productId)) {
        const usable = call("mantle.product.ProductServices.check#ProductUsable", {
            productId: item.productId,
            usage: "Purchase",
            quantity: item.quantity || 1,
            vendorPartyId: po.supplierPartyId,
            customerPartyId: po.organizationPartyId
        })
        if (!usable.usable) unusable.push(item.orderItemSeqId)
    }
    if (unusable.length)
        ec.message.addMessage(
            "Lines " + unusable.join(", ") + " of the new order are for products no longer usable for buying",
            "warning"
        )
    return {orderId: cloned.orderId, unusableItemSeqIds: unusable}
}

// ===== the approval =====
const gateOn = organizationPartyId => policy.effective(organizationPartyId).policy.approvalGateEnabled === "Y"
// The approval decision current for an order: an approval at its revision.
function currentDecision(orderId, revision) {
    return (
        rows(DECISION, {
            sourceEntityName: ORDER,
            sourceId: orderId,
            sourceRevision: revision,
            decisionEnumId: "PadApproved"
        }).sort((a, b) => ms(b.decisionDate) - ms(a.decisionDate))[0] || null
    )
}
// Whether the order's approval is complete at its revision (P4): every step its approval policy selects decided, or under
// the no-policy rule an approval decision at the revision.
function approvalComplete(order) {
    if (!currentDecision(order.orderId, revisionOf(order))) return false
    const part = rows(PART, {orderId: order.orderId}).find(isPurchasePart)
    if (!part) return true
    const source = approvals().orderSource({
        orderId: order.orderId,
        part,
        organizationPartyId: part.customerPartyId,
        supplierPartyId: part.vendorPartyId
    })
    return approvals().progress(source).complete
}
// The warnings of an order's purchase parts that need a decision: a part whose buying organization's policy has the
// approval gate on and no approval decision for the order's revision. No permission check: the SECA runs as any user.
function approvalWarnings(orderId) {
    const order = blank(orderId) ? null : one(ORDER, {orderId})
    if (!order) return []
    const organizations = new Set(
        rows(PART, {orderId})
            .filter(isPurchasePart)
            .map(part => part.customerPartyId)
    )
    if (![...organizations].some(gateOn) || approvalComplete(order)) return []
    return [
        "PURCHASE_APPROVAL_REQUIRED: Purchase order " +
            order.orderId +
            " revision " +
            revisionOf(order) +
            " needs a purchase approval decision"
    ]
}
// approve#Order's direction check (X4, F33): null when the user may approve the order (or the part), else the refusal. A
// sales or internal part needs ORDER_APPROVE as before. A purchase part of an organization with the approval gate on needs
// PURCHASE_ORDER_APPROVE and a current decision; with the gate off (Mantle's default) PURCHASE_ORDER_APPROVE or
// ORDER_APPROVE, so no ORDER_APPROVE holder is refused a purchase order they approve today.
function approveRefusal(orderId, orderPartSeqId) {
    const parts = rows(PART, {orderId}).filter(part => blank(orderPartSeqId) || part.orderPartSeqId === orderPartSeqId)
    const purchase = parts.filter(isPurchasePart)
    if ((purchase.length < parts.length || !parts.length) && !ec.user.hasPermission("ORDER_APPROVE"))
        return "Order Approve permission required"
    if (!purchase.length) return null
    if (purchase.some(part => gateOn(part.customerPartyId))) {
        if (!ec.user.hasPermission("PURCHASE_ORDER_APPROVE"))
            return "PERMISSION_DENIED: PURCHASE_ORDER_APPROVE is required to approve purchase order " + orderId
        const warnings = approvalWarnings(orderId)
        if (warnings.length) return warnings[0] + "; decide it through the purchase approval"
    } else if (!ec.user.hasPermission("PURCHASE_ORDER_APPROVE") && !ec.user.hasPermission("ORDER_APPROVE")) {
        return "Order Approve permission required"
    }
    return null
}
// hold#Order's placing check (crosscut §1.4, X4): the permission the hold type names, or for a Change or Purchase reason the
// order's change permission for its direction (PURCHASE_ORDER_EDIT on a purchase part; ORDER_CHANGE_APPLY or
// SALES_ORDER_CHANGE on another).
function holdAllowed(orderId, orderPartSeqId, holdTypeEnumId, enumCode) {
    if (enumCode && ec.user.hasPermission(enumCode)) return true
    if (!["OhtChange", "OhtPurchase"].includes(holdTypeEnumId)) return false
    const parts = rows(PART, {orderId}).filter(part => blank(orderPartSeqId) || part.orderPartSeqId === orderPartSeqId)
    return (
        parts.length > 0 &&
        parts.every(part =>
            isPurchasePart(part)
                ? ec.user.hasPermission("PURCHASE_ORDER_EDIT")
                : ec.user.hasPermission("ORDER_CHANGE_APPLY") || ec.user.hasPermission("SALES_ORDER_CHANGE")
        )
    )
}
// Whether every part of an order (or the part) is a purchase part, for hold#Order's un-send of a sent purchase order.
function allPurchase(orderId, orderPartSeqId) {
    const parts = rows(PART, {orderId}).filter(part => blank(orderPartSeqId) || part.orderPartSeqId === orderPartSeqId)
    return parts.length > 0 && parts.every(isPurchasePart)
}
// Whether the user placed or entered the order (self-approval).
function placedBy(order, userId, partyId) {
    if (partyId && order.enteredByPartyId === partyId) return true
    return rows("moqui.entity.EntityAuditLog", {
        changedEntityName: ORDER,
        changedFieldName: "statusId",
        pkPrimaryValue: order.orderId,
        newValueText: "OrderPlaced"
    }).some(row => row.changedByUserId === userId)
}
// decide#PurchaseApproval (design ApprovalPolicies, R-PUR-14; P3's no-policy rule, P4's steps): a holder of
// PURCHASE_APPROVE decides the step waiting of a placed order at its current revision. The steps are the order's approval
// policy's for its amount (PurchaseApprovals.js), else one step by any purchase approver; the step's approver, group,
// self-approval (the user who entered or placed it, refused unless the step or the buying policy allows it), separation from
// an earlier step and quorum are checked. A refusal (with its reason) rejects the order (OrderPlaced to OrderRejected). An
// approval that completes the last step reserves the budget of the lines with no request (reserve#Commitment, at the order's
// revision) and approves the order through approve#Order (PURCHASE_ORDER_APPROVE for a purchase part); one that leaves a step
// waiting sends it to its approvers. A retry with the same operation key answers the first result.
function decide(p) {
    if (blank(p.orderId) && !blank(p.agreementId)) return agreements().execute("decide", p)
    requirePermission("PURCHASE_APPROVE")
    const po = purchaseOrder(p.orderId, true)
    const decision = String(p.decision || "approve")
    if (!["approve", "refuse"].includes(decision)) denied("DECISION_INVALID", "Approve or refuse the purchase order")
    const request = {orderId: po.orderId, orderRevision: p.orderRevision == null ? null : Number(p.orderRevision), decision}
    const operation = blank(p.operationKey) ? null : lib.operation(p, "PurchaseApproval", po.organizationPartyId, request)
    if (operation?.old) return lib.previous(operation)
    // P9: an order held for a change whose new revision was applied waits for the approval of that revision
    const revisionHold = revisions().awaitingApproval(po)
    if (po.order.statusId !== "OrderPlaced" && !revisionHold)
        denied("ORDER_NOT_PLACED", "Purchase order " + po.orderId + " is not waiting for approval")
    const revision = revisionOf(po.order)
    if (p.orderRevision != null && !blank(p.orderRevision) && Number(p.orderRevision) !== revision)
        denied("STALE_REVISION", "Purchase order " + po.orderId + " is at revision " + revision + "; review it again")
    const reason = text(p.reason)
    if (decision === "refuse" && !reason) denied("REASON_REQUIRED", "Give the reason for refusing purchase order " + po.orderId)
    const source = approvals().orderSource(po)
    const state = approvals().progress(source)
    if (state.missing)
        denied(
            "POLICY_MISSING",
            "No approval policy of " + partyName(po.organizationPartyId) + " covers purchase order " + po.orderId + "'s amount"
        )
    const partyId = ec.user.userAccount?.partyId || null
    const refusal = approvals().refusalFor(source, state, ec.user.userId, partyId)
    if (refusal) denied(refusal[0], refusal[1])
    if (decision === "approve") supplierCheck(po.organizationPartyId, po.supplierPartyId)
    const {row: policyRow} = policy.effective(po.organizationPartyId)
    const step = state.current
    const created = call("create#" + DECISION, {
        sourceEntityName: ORDER,
        sourceId: po.orderId,
        sourceRevision: revision,
        organizationPartyId: po.organizationPartyId,
        decisionEnumId: decision === "approve" ? "PadApproved" : "PadRefused",
        decisionDate: ec.user.nowTimestamp,
        decidedByUserId: ec.user.userId,
        decidedByPartyId: partyId,
        reason,
        policyFromDate: policyRow ? policyRow.fromDate : null,
        approvalPolicyId: step?.purchaseApprovalPolicyId || null,
        stepSeqId: step ? String(step.sequenceNum) : null,
        operationKey: operation?.operationKey || null
    })
    const result = {
        orderId: po.orderId,
        orderRevision: revision,
        purchaseApprovalDecisionId: created.purchaseApprovalDecisionId,
        creditHeld: false,
        pendingStepText: null
    }
    if (decision === "refuse") {
        // a refused revision leaves the order held for the buyer to change again; a placed order is rejected
        if (!revisionHold) call("mantle.order.OrderServices.reject#Order", {orderId: po.orderId})
        approvals().clearNotices(source)
    } else {
        const after = approvals().progress(source)
        if (!after.complete) {
            result.pendingStepText = approvals().stepText(after, after.current)
            approvals().notify(source, after)
        } else {
            // the budget of the lines with no request, at the order's revision (D10): Stop refuses, Warn warns
            approvals().reserveBudget(po, revision, p.budgetOverrideReason)
            // P10: a line sourced from a purchase request passes on the request's commitment (convert#Commitment)
            requests().convertOrderCommitments(po, revision, p.budgetOverrideReason)
            // P9: a revised order's Change hold is released, back to Approved (or to Placed, approved below)
            const released = revisionHold
                ? revisions().releaseRevisionHold(revisionHold, "Revision " + revision + " approved")
                : null
            // approve#Order checks the approver's PURCHASE_ORDER_APPROVE and, with the gate on, the complete approval
            if (!released || released.statusId === "OrderPlaced") {
                const out =
                    ec.service.sync().name("mantle.order.OrderServices.approve#Order").parameters({orderId: po.orderId}).call() ||
                    {}
                if (ec.message.hasError()) throw new Error(ec.message.getErrorsString())
                result.creditHeld = !!out.creditHeld
            }
            approvals().clearNotices(source)
        }
    }
    result.statusId = one(ORDER, {orderId: po.orderId}).statusId
    if (operation) lib.complete(operation, DECISION, created.purchaseApprovalDecisionId, result)
    return Object.assign(result, {alreadyApplied: false})
}

const operations = {create, update, storeItem, removeItem, place, cancel, clone, decide}
;({
    isPurchasePart,
    purchaseOrder,
    supplierOf,
    costCenterOf,
    placedBy,
    requirePermission,
    // P16: a supplier's claim from its PASS page (SupplierPortal.js)
    asSupplier,
    portalClaim,
    claimed,
    approvalWarnings,
    approveRefusal,
    holdAllowed,
    allPurchase,
    execute: (op, parameters) => {
        if (!operations[op]) throw new Error("Unknown purchase order operation " + op)
        return operations[op](parameters)
    }
})
