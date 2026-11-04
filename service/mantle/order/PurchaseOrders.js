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
function requirePermission(...permissions) {
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
    if (!facilityScope.owns(facilityScope.scope(), part.customerPartyId)) unavailable()
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
    return {
        orderId: po.orderId,
        statusId: one(ORDER, {orderId: po.orderId}).statusId,
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
    if (![...organizations].some(gateOn) || currentDecision(order.orderId, revisionOf(order))) return []
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
// decide#PurchaseApproval with the no-policy rule (design ApprovalPolicies, R-PUR-14): one step by a holder of
// PURCHASE_APPROVE on a placed order at its current revision; the user who entered or placed it is refused unless the policy
// allows self-approval; a supplier the policy stops is refused. The decision is recorded, then approve#Order approves (which
// checks PURCHASE_ORDER_APPROVE for a purchase part). A retry with the same operation key answers the first result.
function decide(p) {
    requirePermission("PURCHASE_APPROVE")
    const po = purchaseOrder(p.orderId, true)
    const decision = String(p.decision || "approve")
    if (decision !== "approve") denied("DECISION_INVALID", "Approve is the only decision of a purchase order without a policy")
    const request = {orderId: po.orderId, orderRevision: p.orderRevision == null ? null : Number(p.orderRevision), decision}
    const operation = blank(p.operationKey) ? null : lib.operation(p, "PurchaseApproval", po.organizationPartyId, request)
    if (operation?.old) return lib.previous(operation)
    if (po.order.statusId !== "OrderPlaced")
        denied("ORDER_NOT_PLACED", "Purchase order " + po.orderId + " is not waiting for approval")
    const revision = revisionOf(po.order)
    if (p.orderRevision != null && !blank(p.orderRevision) && Number(p.orderRevision) !== revision)
        denied("STALE_REVISION", "Purchase order " + po.orderId + " is at revision " + revision + "; review it again")
    const {policy: buying, row: policyRow} = policy.effective(po.organizationPartyId)
    const partyId = ec.user.userAccount?.partyId || null
    if (buying.selfApprovalAllowed !== "Y" && placedBy(po.order, ec.user.userId, partyId))
        denied("SELF_APPROVAL", "You entered or placed purchase order " + po.orderId + "; another approver decides it")
    supplierCheck(po.organizationPartyId, po.supplierPartyId)
    const created = call("create#" + DECISION, {
        sourceEntityName: ORDER,
        sourceId: po.orderId,
        sourceRevision: revision,
        organizationPartyId: po.organizationPartyId,
        decisionEnumId: "PadApproved",
        decisionDate: ec.user.nowTimestamp,
        decidedByUserId: ec.user.userId,
        decidedByPartyId: partyId,
        reason: text(p.reason),
        policyFromDate: policyRow ? policyRow.fromDate : null,
        operationKey: operation?.operationKey || null
    })
    // approve#Order checks the approver's PURCHASE_ORDER_APPROVE and the decision itself
    const out = ec.service.sync().name("mantle.order.OrderServices.approve#Order").parameters({orderId: po.orderId}).call() || {}
    if (ec.message.hasError()) throw new Error(ec.message.getErrorsString())
    const result = {
        orderId: po.orderId,
        orderRevision: revision,
        purchaseApprovalDecisionId: created.purchaseApprovalDecisionId,
        statusId: one(ORDER, {orderId: po.orderId}).statusId,
        creditHeld: !!out.creditHeld
    }
    if (operation) lib.complete(operation, DECISION, created.purchaseApprovalDecisionId, result)
    return Object.assign(result, {alreadyApplied: false})
}

const operations = {create, update, storeItem, removeItem, place, cancel, clone, decide}
;({
    isPurchasePart,
    purchaseOrder,
    requirePermission,
    approvalWarnings,
    approveRefusal,
    holdAllowed,
    allPurchase,
    execute: (op, parameters) => {
        if (!operations[op]) throw new Error("Unknown purchase order operation " + op)
        return operations[op](parameters)
    }
})
