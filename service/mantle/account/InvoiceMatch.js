// Bill matching (InvoiceMatchServices): a supplier bill's lines matched to the organization's purchase order lines and
// their accepted receipts under the organization's match policy, written as Mantle's billing links (OrderItemBilling);
// the re-evaluation of matches a source change made stale; and the legacy backfill, which links existing bills only from
// unambiguous billing and receipt evidence. A variance outside tolerance holds the bill (IhrMatchException); no hold is
// released here.
const lib = ec.resource.script("component://mr-mantle/service/mantle/account/InvoiceWorkflowLib.js")
const {find, one, rows, call, denied, has} = lib
const I = lib.invoiceEntity
const M = "mantle.account.invoice.InvoiceMatch"
const L = "mantle.account.invoice.InvoiceMatchLine"
const P = "mantle.account.invoice.InvoiceMatchPolicy"
const OIB = "mantle.order.OrderItemBilling"
const sourceOrderStates = ["OrderApproved", "OrderSent", "OrderProcessing", "OrderCompleted"]
const closedBillStates = ["InvoiceCancelled", "InvoicePmtSent"]
// With no policy row in effect: three-way on accepted receipts, no tolerance, a variance holds the bill.
const defaultPolicy = {
    invoiceMatchPolicyId: null,
    billBasisEnumId: "ImbReceived",
    receiptRequired: "Y",
    quantityTolerancePercent: null,
    quantityToleranceQuantity: null,
    priceTolerancePercent: null,
    priceToleranceAmount: null,
    varianceActionEnumId: "ImaHold"
}
const dec = value => toDecimal(value ?? 0)
const zero = () => toDecimal(0)
const min = (a, b) => (a.compare(b) <= 0 ? a : b)
const max = (a, b) => (a.compare(b) >= 0 ? a : b)
const text = value => ec.l10n.format(dec(value), "#,##0.######")
const money = (value, currencyUomId) => ec.l10n.formatCurrency(dec(value), currencyUomId)

// ---- scope

// The bill, its organization and supplier. A reader needs the match, payables view or accounting view permission; a
// writer INVOICE_MATCH, with the organization and the bill locked.
function bill(p, write = false) {
    const scope = lib.invoice(p, write ? "INVOICE_MATCH" : null, write)
    if (!write && !["INVOICE_MATCH", "PAYABLE_VIEW", "ACCOUNTING_VIEW", "ACCOUNTING_ADMIN"].some(permission => has(permission)))
        denied("PERMISSION_DENIED", "Bill match authority is required")
    if (scope.receivable) denied("PAYABLE_ONLY", "Only a supplier bill is matched")
    return {
        record: scope.record,
        invoiceId: scope.record.invoiceId,
        organizationPartyId: scope.organizationPartyId,
        supplierPartyId: scope.partyId,
        currencyUomId: scope.record.currencyUomId,
        receivable: false
    }
}
// The same scope for the re-evaluation job, which has no user: the bill's own parties.
function jobBill(invoiceId, organizationPartyId) {
    const record = find(I, {invoiceId}).forUpdate(true).one()
    if (!record) denied("INVOICE_UNAVAILABLE", "Invoice is not available")
    if (record.toPartyId !== organizationPartyId)
        denied("MATCH_SCOPE_INVALID", "Bill " + invoiceId + " is not a bill of organization " + organizationPartyId)
    return {
        record,
        invoiceId,
        organizationPartyId,
        supplierPartyId: record.fromPartyId === organizationPartyId ? record.toPartyId : record.fromPartyId,
        currencyUomId: record.currencyUomId,
        receivable: false
    }
}

// ---- policy

function inEffect(query, asOf) {
    const cf = ec.entity.conditionFactory
    return query
        .condition("fromDate", "less-equals", asOf)
        .condition(
            cf.makeCondition([cf.makeCondition("thruDate", "is-null", null), cf.makeCondition("thruDate", "greater", asOf)], "or")
        )
}
// The policy row in effect for a product: its own row, else the row of a category it is in (of several, the one that
// started last), else the organization's row, else the default.
function policyFor(organizationPartyId, productId, asOf = ec.user.nowTimestamp) {
    const candidates = Array.from(inEffect(find(P, {organizationPartyId}), asOf).orderBy("-fromDate").list())
    if (productId) {
        const own = candidates.find(row => row.productId === productId)
        if (own) return own
        const categoryRows = candidates.filter(row => row.productCategoryId && !row.productId)
        if (categoryRows.length) {
            const members = new Set(
                Array.from(
                    inEffect(find("mantle.product.category.ProductCategoryMember", {productId}), asOf)
                        .condition(
                            "productCategoryId",
                            "in",
                            categoryRows.map(row => row.productCategoryId)
                        )
                        .list()
                ).map(row => row.productCategoryId)
            )
            const category = categoryRows.find(row => members.has(row.productCategoryId))
            if (category) return category
        }
    }
    return candidates.find(row => !row.productId && !row.productCategoryId) || defaultPolicy
}
function policyById(invoiceMatchPolicyId) {
    return (invoiceMatchPolicyId && one(P, {invoiceMatchPolicyId})) || defaultPolicy
}
function policyName(policy) {
    return policy.invoiceMatchPolicyId ? "match policy " + policy.invoiceMatchPolicyId : "the default match policy"
}
// A tolerance: the larger of a percent of the base and a fixed allowance.
function allowance(base, percent, fixed) {
    const byPercent = percent == null ? zero() : dec(base).abs().multiply(dec(percent)).divide(100)
    return max(byPercent, fixed == null ? zero() : dec(fixed))
}
function holds(policy) {
    return (policy.varianceActionEnumId || "ImaHold") === "ImaHold"
}

// ---- sources

let productTypes = null
function isProductLine(line) {
    if (!productTypes)
        productTypes = new Set(rows("moqui.basic.EnumGroupMember", {enumGroupEnumId: "EngItemsProduct"}).map(row => row.enumId))
    return !!line.productId || productTypes.has(line.itemTypeEnumId)
}
// The service-acceptance rule of a policy (impl-manufacturing P14): a service line (a PtService product) has no receipt,
// so on the received basis it matches what its ServiceAcceptance rows accepted (Purchasing's accept#ServiceItem, a
// subcontract's receive#SubcontractOutput); with the rule off (N) it matches its ordered quantity. A service line that was
// received (an AssetReceipt on it) keeps the receipt rules it had before the rule (P14 review: Mantle's default unchanged).
function isServiceItem(item) {
    const product = item.productId ? one("mantle.product.Product", {productId: item.productId}) : null
    if (product?.productTypeEnumId !== "PtService") return false
    return !(
        find("mantle.product.receipt.AssetReceipt", {orderId: item.orderId, orderItemSeqId: item.orderItemSeqId}).count() > 0
    )
}
const acceptanceRule = policy => (policy.serviceAcceptanceRequired || "Y") !== "N"
function serviceAcceptedOf(orderId, orderItemSeqId) {
    return rows("mantle.order.purchase.ServiceAcceptance", {orderId, orderItemSeqId}).reduce(
        (sum, row) => sum.add(dec(row.acceptedQuantity)),
        zero()
    )
}
// The quantity a service line may be billed against under the policy: accepted on the received basis with the rule, else
// ordered.
function serviceBase(item, policy) {
    const basis = policy.billBasisEnumId || "ImbReceived"
    return basis === "ImbReceived" && acceptanceRule(policy)
        ? serviceAcceptedOf(item.orderId, item.orderItemSeqId)
        : dec(item.quantity ?? 1)
}
// An order line of the bill's organization from its supplier, on an approved order, else a refusal.
function orderLine(scope, orderId, orderItemSeqId) {
    const item = orderId && one("mantle.order.OrderItem", {orderId, orderItemSeqId})
    const part = item && one("mantle.order.OrderPart", {orderId, orderPartSeqId: item.orderPartSeqId})
    const header = item && one("mantle.order.OrderHeader", {orderId})
    if (!item || !part || !header) denied("SOURCE_INVALID", "Order line " + orderId + ":" + orderItemSeqId + " is not available")
    if (part.customerPartyId !== scope.organizationPartyId || part.vendorPartyId !== scope.supplierPartyId)
        denied("SOURCE_INVALID", "Order " + orderId + " is not this organization's order from the bill's supplier")
    if (!sourceOrderStates.includes(header.statusId)) denied("SOURCE_INVALID", "Order " + orderId + " is not approved")
    if (header.currencyUomId && scope.currencyUomId && header.currencyUomId !== scope.currencyUomId)
        denied("SOURCE_INVALID", "Order " + orderId + " is in " + header.currencyUomId + ", the bill in " + scope.currencyUomId)
    return item
}
// The receipts of an order line, with the part of each still held for inspection (D21): CX-QUALITY's
// get#SourceInspectionStatus (impl-warehouse P8, F31), which replaced the quarantine reading used before inspections existed.
function receiptsOf(orderId, orderItemSeqId) {
    const receipts = rows("mantle.product.receipt.AssetReceipt", {orderId, orderItemSeqId})
    const status = receipts.length
        ? call("mantle.product.QualityServices.get#SourceInspectionStatus", {orderId, orderItemSeqId})
        : {receiptRows: []}
    const byReceipt = Object.fromEntries(Array.from(status.receiptRows || []).map(row => [row.assetReceiptId, row]))
    const quantityOf = (row, field) =>
        byReceipt[row.assetReceiptId]?.[field] != null ? dec(byReceipt[row.assetReceiptId][field]) : zero()
    const returned = supplierReturnedOf(receipts, receiptId =>
        byReceipt[receiptId]?.returnedToSupplierQuantity != null ? dec(byReceipt[receiptId].returnedToSupplierQuantity) : zero()
    )
    return receipts.map(row => ({
        record: row,
        assetReceiptId: row.assetReceiptId,
        shipmentId: row.shipmentId,
        receivedDate: row.receivedDate,
        accepted: dec(row.quantityAccepted),
        held: quantityOf(row, "heldQuantity"),
        // scrapped or sent back to the supplier at inspection: no longer match-eligible (P8 review B2); Return to supplier
        // stock not yet sent back is in held, so it is not subtracted twice (P14 review B1)
        inspectionRejected: quantityOf(row, "inspectionRemovedQuantity"),
        // released stock a supplier return sent back that no bill accounts for (F-P8-4)
        supplierReturned: returned[row.assetReceiptId] || zero()
    }))
}
// What supplier returns sent back of each receipt that is no longer match-eligible (impl-purchasing F-P8-4, decided Nov 4 as
// a correction of the base): a supplier return item names its receipt (ReturnItem.assetReceiptId); what it issued to its
// return shipment, less what Return to supplier dispositions sent back (already out, in inspectionRemovedQuantity), less what
// the supplier replaced (replacedQuantity: the replacement is free on its own order, so the original bill stands for it), went
// back for good. settle#Return credits a return against the billed quantity first, so returned units up to what bills linked
// to the receipt are billed-then-credited and stay in the base (the original bill stays matched, credited or not); the rest
// went back unbilled and leaves the base, so a later bill cannot match it. One indexed read when no supplier return names
// the receipts.
function supplierReturnedOf(receipts, dispositionReturnedOf) {
    const out = {}
    const receiptIds = receipts.map(row => row.assetReceiptId)
    if (!receiptIds.length) return out
    const items = Array.from(
        find("mantle.order.return.ReturnItem")
            .condition("assetReceiptId", "in", receiptIds)
            .condition("statusId", "not-equals", "ReturnCancelled")
            .list()
    )
    if (!items.length) return out
    const returnIds = [...new Set(items.map(row => row.returnId))]
    const cancelled = new Set(
        Array.from(
            find("mantle.order.return.ReturnHeader")
                .condition("returnId", "in", returnIds)
                .condition("statusId", "ReturnCancelled")
                .list()
        ).map(row => row.returnId)
    )
    const live = items.filter(row => !cancelled.has(row.returnId))
    if (!live.length) return out
    const itemKey = row => row.returnId + ":" + row.returnItemSeqId
    const receiptOfItem = Object.fromEntries(live.map(row => [itemKey(row), row.assetReceiptId]))
    const sources = Array.from(find("mantle.shipment.ShipmentItemSource").condition("returnId", "in", returnIds).list()).filter(
        row => row.statusId !== "SisCancelled" && itemKey(row) in receiptOfItem
    )
    const receiptOfSource = Object.fromEntries(sources.map(row => [row.shipmentItemSourceId, receiptOfItem[itemKey(row)]]))
    const totals = {issued: {}, replaced: {}, billed: {}}
    const add = (kind, receiptId, value) => (totals[kind][receiptId] = (totals[kind][receiptId] || zero()).add(dec(value)))
    if (sources.length)
        for (const row of Array.from(
            find("mantle.product.issuance.AssetIssuance")
                .condition("shipmentItemSourceId", "in", Object.keys(receiptOfSource))
                .list()
        ))
            add("issued", receiptOfSource[row.shipmentItemSourceId], row.quantity)
    for (const row of live) add("replaced", row.assetReceiptId, row.replacedQuantity)
    const returnedReceiptIds = [...new Set(live.map(row => row.assetReceiptId))]
    for (const row of Array.from(find(OIB).condition("assetReceiptId", "in", returnedReceiptIds).list()))
        add("billed", row.assetReceiptId, row.quantity)
    for (const receiptId of returnedReceiptIds) {
        const unbilled = (totals.issued[receiptId] || zero())
            .subtract(dispositionReturnedOf(receiptId))
            .subtract(totals.replaced[receiptId] || zero())
            .subtract(totals.billed[receiptId] || zero())
        if (unbilled.compare(0) > 0) out[receiptId] = unbilled
    }
    return out
}
// What other bills have billed of an order line, or of one receipt (billing links of other invoices; a cancelled bill's
// links are zero).
function billedByOthers(invoiceId, key) {
    return Array.from(find(OIB, key).condition("invoiceId", "not-equals", invoiceId).list()).reduce(
        (sum, row) => sum.add(row.quantity ?? 0),
        zero()
    )
}

// What this bill's allocations checked so far take of each order line and receipt, so two lines of one bill cannot
// both bill the same source.
function newTaken() {
    return {order: {}, receipt: {}}
}
const orderKeyText = row => row.orderId + ":" + row.orderItemSeqId
function takenOf(taken, kind, key) {
    return taken[kind][key] || zero()
}
function takeSource(taken, row) {
    const key = orderKeyText(row)
    taken.order[key] = takenOf(taken, "order", key).add(row.quantity)
    if (row.assetReceiptId) taken.receipt[row.assetReceiptId] = takenOf(taken, "receipt", row.assetReceiptId).add(row.quantity)
}

// ---- checks

// One allocation of a bill line to an order line (and a receipt), checked against the sources as they are now under the
// line's policy: the snapshot, the quantity the source still allows, a refusal when the quantity is beyond it, and the
// exceptions (price, missing receipt, inspection hold).
function checkAllocation(scope, line, allocation, policy, taken = newTaken()) {
    const item = orderLine(scope, allocation.orderId, allocation.orderItemSeqId)
    if (line.productId && item.productId && line.productId !== item.productId)
        denied("SOURCE_INVALID", "Order line " + allocation.orderId + ":" + allocation.orderItemSeqId + " is another product")
    const receipts = receiptsOf(item.orderId, item.orderItemSeqId)
    const accepted = receipts.reduce((sum, row) => sum.add(row.accepted), zero())
    const held = receipts.reduce((sum, row) => sum.add(row.held), zero())
    const inspectionRejected = receipts.reduce((sum, row) => sum.add(row.inspectionRejected), zero())
    const supplierReturned = receipts.reduce((sum, row) => sum.add(row.supplierReturned), zero())
    const orderKey = {orderId: item.orderId, orderItemSeqId: item.orderItemSeqId}
    const priorBilled = billedByOthers(scope.invoiceId, orderKey)
    const thisBill = takenOf(taken, "order", orderKeyText(orderKey))
    const orderQuantity = dec(item.quantity ?? 1)
    const basis = policy.billBasisEnumId || "ImbReceived"
    // a service line: its accepted quantity under the service-acceptance rule, else ordered (P14)
    const service = isServiceItem(item)
    const serviceAccepted = service ? serviceAcceptedOf(item.orderId, item.orderItemSeqId) : zero()
    // the tolerance is a share of the source's base (accepted less held, or ordered), not of what is left of it
    const base = service
        ? serviceBase(item, policy)
        : basis === "ImbReceived"
          ? accepted.subtract(held).subtract(inspectionRejected).subtract(supplierReturned)
          : orderQuantity
    const used = priorBilled.add(thisBill)
    const quantity = dec(allocation.quantity)
    const baseAllowance = allowance(base, policy.quantityTolerancePercent, policy.quantityToleranceQuantity)
    let remaining = base.subtract(used)
    let over = used.add(quantity).compare(base.add(baseAllowance)) > 0
    let usedUp = used.compare(0) > 0 && used.compare(base) >= 0
    let receipt = null
    if (allocation.assetReceiptId) {
        receipt = receipts.find(row => row.assetReceiptId === allocation.assetReceiptId)
        if (!receipt) denied("SOURCE_INVALID", "Receipt " + allocation.assetReceiptId + " is not of this order line")
        const receiptBase = receipt.accepted
            .subtract(receipt.held)
            .subtract(receipt.inspectionRejected)
            .subtract(receipt.supplierReturned)
        const receiptUsed = billedByOthers(scope.invoiceId, {assetReceiptId: receipt.assetReceiptId}).add(
            takenOf(taken, "receipt", receipt.assetReceiptId)
        )
        const receiptAllowance = allowance(receiptBase, policy.quantityTolerancePercent, policy.quantityToleranceQuantity)
        remaining = min(remaining, receiptBase.subtract(receiptUsed))
        over = over || receiptUsed.add(quantity).compare(receiptBase.add(receiptAllowance)) > 0
        usedUp = usedUp || (receiptUsed.compare(0) > 0 && receiptUsed.compare(receiptBase) >= 0)
    }
    remaining = max(remaining, zero())
    let refusal = null
    if (over) {
        const where =
            "order line " + item.orderId + ":" + item.orderItemSeqId + (receipt ? " receipt " + receipt.assetReceiptId : "")
        if (usedUp && base.compare(0) > 0)
            refusal = [
                "ALREADY_BILLED",
                "The " +
                    where +
                    " is already billed (" +
                    text(priorBilled) +
                    " on other bills" +
                    (thisBill.isZero() ? "" : ", " + text(thisBill) + " on this bill") +
                    ")"
            ]
        else if (service && basis === "ImbReceived" && acceptanceRule(policy) && base.compare(0) <= 0)
            refusal = ["MISSING_RECEIPT", "The " + where + " has no accepted service to bill"]
        else if (basis === "ImbReceived" && base.compare(0) <= 0)
            refusal = ["MISSING_RECEIPT", "The " + where + " has no accepted receipt to bill"]
        else
            refusal = [
                "QUANTITY_EXCESS",
                text(quantity) +
                    " is more than the " +
                    text(remaining) +
                    " left to bill on the " +
                    where +
                    (baseAllowance.isZero() ? "" : " with the tolerance of " + text(baseAllowance))
            ]
    }
    const exceptions = []
    const invoiceUnit = dec(line.amount)
    const orderUnit = dec(item.unitAmount)
    const priceVariance = invoiceUnit.subtract(orderUnit)
    const priceAllowance = allowance(orderUnit, policy.priceTolerancePercent, policy.priceToleranceAmount)
    if (priceVariance.abs().compare(priceAllowance) > 0)
        exceptions.push({
            exceptionEnumId: "MePriceVariance",
            holds: holds(policy),
            text:
                "Price " +
                money(invoiceUnit, scope.currencyUomId) +
                " is " +
                money(priceVariance.abs(), scope.currencyUomId) +
                (priceVariance.compare(0) > 0 ? " over" : " under") +
                " order line " +
                item.orderId +
                ":" +
                item.orderItemSeqId +
                " at " +
                money(orderUnit, scope.currencyUomId) +
                ", outside the price tolerance of " +
                policyName(policy) +
                " (" +
                text(policy.priceTolerancePercent) +
                "% or " +
                money(policy.priceToleranceAmount, scope.currencyUomId) +
                ")"
        })
    if (basis === "ImbOrdered" && policy.receiptRequired === "Y" && (service ? serviceAccepted : accepted).compare(0) <= 0)
        exceptions.push({
            exceptionEnumId: "MeMissingReceipt",
            holds: holds(policy),
            text:
                "Order line " +
                item.orderId +
                ":" +
                item.orderItemSeqId +
                " has no accepted receipt, which " +
                policyName(policy) +
                " requires"
        })
    if (held.compare(0) > 0)
        exceptions.push({
            exceptionEnumId: "MeInspectionHold",
            holds: false,
            text:
                text(held) +
                " received on order line " +
                item.orderId +
                ":" +
                item.orderItemSeqId +
                " is in quarantine and left out until it is released"
        })
    return {
        orderId: item.orderId,
        orderItemSeqId: item.orderItemSeqId,
        assetReceiptId: receipt?.assetReceiptId || null,
        shipmentId: receipt?.shipmentId || null,
        receivedDateText: receipt ? lib.policy.dateText(receipt.receivedDate) : "",
        quantity,
        invoiceQuantity: dec(line.quantity ?? 1),
        invoiceUnitAmount: invoiceUnit,
        orderQuantity,
        orderUnitAmount: orderUnit,
        acceptedQuantity: receipt ? receipt.accepted : service ? serviceAccepted : accepted,
        heldQuantity: receipt ? receipt.held : held,
        supplierReturnedQuantity: receipt ? receipt.supplierReturned : supplierReturned,
        priorBilledQuantity: priorBilled,
        remainingQuantity: remaining,
        priceVariance,
        billBasisEnumId: basis,
        invoiceMatchPolicyId: policy.invoiceMatchPolicyId,
        refusal,
        exceptions
    }
}
// The line's own check: the part of a product line's quantity no source explains, beyond the quantity tolerance.
function lineExceptions(scope, line, allocated, policy) {
    if (!isProductLine(line)) return []
    const quantity = dec(line.quantity ?? 1)
    const unmatched = quantity.subtract(allocated)
    const tolerance = allowance(quantity, policy.quantityTolerancePercent, policy.quantityToleranceQuantity)
    if (allocated.isZero())
        return [
            {
                exceptionEnumId: "MeNoSource",
                holds: holds(policy),
                text: "Line " + line.invoiceItemSeqId + " (" + text(quantity) + ") has no order line or accepted receipt to match"
            }
        ]
    if (unmatched.compare(tolerance) > 0)
        return [
            {
                exceptionEnumId: "MeQuantityVariance",
                holds: holds(policy),
                text:
                    text(unmatched) +
                    " of line " +
                    line.invoiceItemSeqId +
                    " (" +
                    text(quantity) +
                    ") is not matched, outside the quantity tolerance of " +
                    policyName(policy)
            }
        ]
    return []
}

// ---- proposal

function billLines(invoiceId) {
    return Array.from(find("mantle.account.invoice.InvoiceItem", {invoiceId}).orderBy("invoiceItemSeqId").list())
}
// Allocations for a bill line with no applied match: its existing billing links (Mantle's, from the order or receipt it
// was billed from), else the organization's approved order lines of the product from the supplier, oldest first, on the
// policy's basis, up to the line's quantity.
function propose(scope, line, policy, orderId, taken = newTaken()) {
    const existing = Array.from(
        find(OIB, {invoiceId: scope.invoiceId, invoiceItemSeqId: line.invoiceItemSeqId})
            .condition("quantity", "greater", 0)
            .list()
    )
    if (existing.length)
        return existing.map(row => {
            const allocation = {
                orderId: row.orderId,
                orderItemSeqId: row.orderItemSeqId,
                assetReceiptId: row.assetReceiptId,
                quantity: dec(row.quantity)
            }
            takeSource(taken, allocation)
            return allocation
        })
    if (!line.productId) return []
    let parts = find("mantle.order.OrderPart", {
        customerPartyId: scope.organizationPartyId,
        vendorPartyId: scope.supplierPartyId
    })
    if (orderId) parts = parts.condition("orderId", orderId)
    const orderIds = [...new Set(Array.from(parts.orderBy("orderId").limit(200).list()).map(row => row.orderId))]
    if (!orderIds.length) return []
    const approved = new Set(
        Array.from(
            find("mantle.order.OrderHeader")
                .condition("orderId", "in", orderIds)
                .condition("statusId", "in", sourceOrderStates)
                .condition("currencyUomId", scope.currencyUomId)
                .list()
        ).map(row => row.orderId)
    )
    if (!approved.size) return []
    const items = Array.from(
        find("mantle.order.OrderItem")
            .condition("orderId", "in", [...approved])
            .condition("productId", line.productId)
            .orderBy("orderId,orderItemSeqId")
            .limit(50)
            .list()
    )
    let remaining = dec(line.quantity ?? 1)
    const proposals = []
    const add = (available, allocation) => {
        const quantity = min(remaining, available)
        if (quantity.compare(0) <= 0) return zero()
        const proposal = Object.assign(allocation, {quantity})
        proposals.push(proposal)
        takeSource(taken, proposal)
        remaining = remaining.subtract(quantity)
        return quantity
    }
    for (const item of items) {
        if (remaining.compare(0) <= 0) break
        const orderKey = {orderId: item.orderId, orderItemSeqId: item.orderItemSeqId}
        const used = billedByOthers(scope.invoiceId, orderKey).add(takenOf(taken, "order", orderKeyText(orderKey)))
        if (isServiceItem(item)) add(serviceBase(item, policy).subtract(used), Object.assign({assetReceiptId: null}, orderKey))
        else if ((policy.billBasisEnumId || "ImbReceived") === "ImbReceived") {
            const receipts = receiptsOf(item.orderId, item.orderItemSeqId).sort(
                (a, b) => Number(a.receivedDate || 0) - Number(b.receivedDate || 0)
            )
            let orderLeft = receipts
                .reduce(
                    (sum, receipt) => sum.add(receipt.accepted).subtract(receipt.held).subtract(receipt.supplierReturned),
                    zero()
                )
                .subtract(used)
            for (const receipt of receipts) {
                if (remaining.compare(0) <= 0 || orderLeft.compare(0) <= 0) break
                const receiptLeft = receipt.accepted
                    .subtract(receipt.held)
                    .subtract(receipt.supplierReturned)
                    .subtract(billedByOthers(scope.invoiceId, {assetReceiptId: receipt.assetReceiptId}))
                    .subtract(takenOf(taken, "receipt", receipt.assetReceiptId))
                const allocation = Object.assign({assetReceiptId: receipt.assetReceiptId}, orderKey)
                orderLeft = orderLeft.subtract(add(min(orderLeft, receiptLeft), allocation))
            }
        } else add(dec(item.quantity ?? 1).subtract(used), Object.assign({assetReceiptId: null}, orderKey))
    }
    return proposals
}

// ---- evaluation

const resultNames = {ImrMatched: "Matched", ImrPartial: "Partly matched", ImrException: "Exception"}
function sourceKey(row) {
    return [row.invoiceItemSeqId, row.orderId, row.orderItemSeqId, row.assetReceiptId || ""].join("|")
}
// Check allocations against a bill: per line its policy (the applied row when given), each allocation's check and the
// line's own; the result is an exception when any exception is named, partly matched when a product line is matched
// within tolerance but not in full, else matched.
function evaluateAllocations(scope, allocations, policyOf) {
    const lines = billLines(scope.invoiceId)
    const byLine = {}
    for (const allocation of allocations)
        (byLine[allocation.invoiceItemSeqId] = byLine[allocation.invoiceItemSeqId] || []).push(allocation)
    const sources = []
    const exceptions = []
    const lineRows = []
    const taken = newTaken()
    let partial = false
    for (const line of lines) {
        const policy = policyOf(line)
        let allocated = zero()
        for (const allocation of byLine[line.invoiceItemSeqId] || []) {
            let checked
            try {
                checked = checkAllocation(scope, line, allocation, policy, taken)
                if (!checked.refusal) takeSource(taken, checked)
            } catch (error) {
                checked = {
                    orderId: allocation.orderId,
                    orderItemSeqId: allocation.orderItemSeqId,
                    assetReceiptId: allocation.assetReceiptId || null,
                    quantity: dec(allocation.quantity),
                    refusal: [
                        lib.entityLib.reasonCode(error) || "SOURCE_INVALID",
                        String(error.message).replace(/^[A-Z_]+: /, "")
                    ],
                    exceptions: [],
                    invoiceMatchPolicyId: policy.invoiceMatchPolicyId
                }
            }
            checked.invoiceItemSeqId = line.invoiceItemSeqId
            checked.key = sourceKey(checked)
            checked.exceptionText = [checked.refusal?.[1], ...checked.exceptions.map(row => row.text)].filter(Boolean).join("; ")
            allocated = allocated.add(checked.quantity)
            sources.push(checked)
            for (const exception of checked.exceptions)
                exceptions.push(Object.assign({invoiceItemSeqId: line.invoiceItemSeqId}, exception))
        }
        const own = lineExceptions(scope, line, allocated, policy)
        for (const exception of own) exceptions.push(Object.assign({invoiceItemSeqId: line.invoiceItemSeqId}, exception))
        if (isProductLine(line) && !own.length && allocated.compare(dec(line.quantity ?? 1)) < 0) partial = true
        lineRows.push({
            invoiceItemSeqId: line.invoiceItemSeqId,
            productId: line.productId,
            description: line.description,
            itemTypeEnumId: line.itemTypeEnumId,
            quantity: dec(line.quantity ?? 1),
            amount: dec(line.amount),
            matchedQuantity: allocated,
            isProduct: isProductLine(line),
            invoiceMatchPolicyId: policy.invoiceMatchPolicyId,
            billBasisEnumId: policy.billBasisEnumId,
            statusText:
                !isProductLine(line) && allocated.isZero()
                    ? "Not matched (no order line)"
                    : own.length
                      ? own.map(row => row.text).join("; ")
                      : allocated.compare(dec(line.quantity ?? 1)) >= 0
                        ? "Matched"
                        : "Matched within tolerance"
        })
    }
    const refused = sources.filter(row => row.refusal)
    const resultEnumId = exceptions.length || refused.length ? "ImrException" : partial ? "ImrPartial" : "ImrMatched"
    const resultText = [
        resultNames[resultEnumId],
        ...refused.map(row => row.refusal[1]),
        ...exceptions.filter(row => row.holds).map(row => row.text)
    ].join(". ")
    return {lines: lineRows, sources, exceptions, refused, resultEnumId, resultText}
}
function productNames(ids) {
    const wanted = [...new Set(ids.filter(Boolean))]
    if (!wanted.length) return {}
    return Object.fromEntries(
        Array.from(find("mantle.product.Product").condition("productId", "in", wanted).list()).map(row => [
            row.productId,
            row.productName || row.productId
        ])
    )
}
function enumNames(ids) {
    const wanted = [...new Set(ids.filter(Boolean))]
    if (!wanted.length) return {}
    return Object.fromEntries(
        Array.from(find("moqui.basic.Enumeration").condition("enumId", "in", wanted).list()).map(row => [
            row.enumId,
            row.description
        ])
    )
}
function appliedMatch(invoiceId, lock = false) {
    return find(M, {invoiceId, statusId: "ImApplied"}).forUpdate(lock).one()
}
function matchLines(invoiceMatchId) {
    return Array.from(find(L, {invoiceMatchId}).orderBy("invoiceMatchLineSeqId").list())
}
function userName(userId) {
    if (!userId) return ""
    const account = one("moqui.security.UserAccount", {userId})
    return account?.userFullName || account?.username || userId
}

// evaluate#InvoiceMatch: read only. With an applied match its allocations checked against the sources now; else the
// allocations given, or the proposal.
function evaluate(p) {
    const scope = bill(p)
    const current = appliedMatch(scope.invoiceId)
    let allocations
    let policyOf
    if (current) {
        const kept = matchLines(current.invoiceMatchId).filter(row => row.orderId && dec(row.quantity).compare(0) > 0)
        allocations = kept.map(row => ({
            invoiceItemSeqId: row.invoiceItemSeqId,
            orderId: row.orderId,
            orderItemSeqId: row.orderItemSeqId,
            assetReceiptId: row.assetReceiptId,
            quantity: row.quantity
        }))
        const policyIds = {}
        for (const row of matchLines(current.invoiceMatchId)) policyIds[row.invoiceItemSeqId] = row.invoiceMatchPolicyId
        policyOf = line =>
            line.invoiceItemSeqId in policyIds
                ? policyById(policyIds[line.invoiceItemSeqId])
                : policyFor(scope.organizationPartyId, line.productId)
    } else {
        policyOf = line => policyFor(scope.organizationPartyId, line.productId)
        const proposalTaken = newTaken()
        allocations =
            Array.isArray(p.allocationList) && p.allocationList.length
                ? Array.from(p.allocationList).map(row => Object.assign({}, row))
                : billLines(scope.invoiceId).flatMap(line =>
                      propose(scope, line, policyOf(line), p.orderId, proposalTaken).map(row =>
                          Object.assign({invoiceItemSeqId: line.invoiceItemSeqId}, row)
                      )
                  )
    }
    const evaluated = evaluateAllocations(scope, allocations, policyOf)
    const names = productNames(evaluated.lines.map(row => row.productId))
    const exceptionNames = enumNames(evaluated.exceptions.map(row => row.exceptionEnumId))
    const open = lib.openHolds([scope.invoiceId])[scope.invoiceId] || []
    const closed = closedBillStates.includes(scope.record.statusId)
    let currentMatch = null
    if (current)
        currentMatch = Object.assign(lib.display(current), {
            appliedByName: userName(current.appliedByUserId),
            resultName: resultNames[current.resultEnumId] || current.resultEnumId,
            isStale: !!current.staleDate,
            lineCount: matchLines(current.invoiceMatchId).length
        })
    return {
        invoiceId: scope.invoiceId,
        organizationPartyId: scope.organizationPartyId,
        supplierPartyId: scope.supplierPartyId,
        currencyUomId: scope.currencyUomId,
        lineRows: evaluated.lines.map(row =>
            Object.assign(row, {productName: names[row.productId] || "", lineText: row.description || names[row.productId] || ""})
        ),
        sourceRows: evaluated.sources.map(row => {
            const out = Object.assign({}, row)
            delete out.refusal
            delete out.exceptions
            out.refusedReason = row.refusal?.[0] || null
            return out
        }),
        exceptionRows: evaluated.exceptions.map(row =>
            Object.assign(row, {exceptionName: exceptionNames[row.exceptionEnumId] || row.exceptionEnumId})
        ),
        resultEnumId: evaluated.resultEnumId,
        resultName: resultNames[evaluated.resultEnumId],
        resultText: evaluated.resultText,
        inspectionCheck: "available",
        currentMatch,
        openHoldCount: open.length,
        matchCapabilities: {
            canApply: has("INVOICE_MATCH") && !current && !closed && evaluated.sources.length > 0,
            canUnapply: has("INVOICE_MATCH") && !!current
        }
    }
}

// ---- apply and unapply

// The match exception hold, through the shared hold creation (InvoiceWorkflowLib.placeHold) after the match's own
// INVOICE_MATCH check, or by the re-evaluation job with no user; an open one is answered. An approver who did not place
// it releases it with release#InvoiceHold.
function placeMatchHold(scope, comment) {
    return lib.placeHold(scope, "IhrMatchException", comment, {existingOk: true})
}
// A billing link for an allocation: the existing link of this bill line to the source is updated (its quantity before
// kept), else one is created.
function writeLink(scope, line, source) {
    const key = {
        invoiceId: scope.invoiceId,
        invoiceItemSeqId: line.invoiceItemSeqId,
        orderId: source.orderId,
        orderItemSeqId: source.orderItemSeqId
    }
    let link = Array.from(find(OIB, key).forUpdate(true).list()).find(
        row => (row.assetReceiptId || null) === (source.assetReceiptId || null)
    )
    let previousQuantity = null
    if (link) {
        previousQuantity = link.quantity ?? 0
        call("update#" + OIB, {orderItemBillingId: link.orderItemBillingId, quantity: source.quantity})
    } else
        link = call(
            "create#" + OIB,
            Object.assign({}, key, {
                assetReceiptId: source.assetReceiptId,
                shipmentId: source.shipmentId,
                quantity: source.quantity,
                amount: line.amount
            })
        )
    return {orderItemBillingId: link.orderItemBillingId, previousQuantity}
}
// The billing links with a quantity of a receipt.
function receiptLinks(assetReceiptId) {
    return Array.from(find(OIB, {assetReceiptId}).condition("quantity", "greater", 0).orderBy("orderItemBillingId").list())
}
// A receipt with no invoice gets the bill line once the billing links with a quantity cover its accepted quantity, as
// Mantle's apply#InvoiceItemToOrder sets it; Mantle's receipt billing then does not bill it again. Y when set here.
function coverReceipt(assetReceiptId, invoiceId, invoiceItemSeqId) {
    const receipt = find("mantle.product.receipt.AssetReceipt", {assetReceiptId}).forUpdate(true).one()
    if (!receipt || receipt.invoiceId) return "N"
    const linked = receiptLinks(assetReceiptId).reduce((sum, row) => sum.add(row.quantity ?? 0), zero())
    if (linked.isZero() || linked.compare(dec(receipt.quantityAccepted)) < 0) return "N"
    call("update#mantle.product.receipt.AssetReceipt", {assetReceiptId, invoiceId, invoiceItemSeqId})
    return "Y"
}
// A receipt that names this bill, which no longer links it with a quantity, names another bill still linked to it, or
// none once no link remains. Unlike coverReceipt this does not ask for full coverage: a receipt partly billed by another
// bill keeps naming it, so Mantle's receipt billing (create#InvoiceFromSource, which bills a receipt whole by its invoice)
// does not bill it again; its unbilled rest is billed by a match.
function releaseReceipt(assetReceiptId, invoiceId) {
    const receipt = find("mantle.product.receipt.AssetReceipt", {assetReceiptId}).forUpdate(true).one()
    if (!receipt || receipt.invoiceId !== invoiceId) return
    const links = receiptLinks(assetReceiptId)
    if (links.some(row => row.invoiceId === invoiceId)) return
    const other = links[0]
    call("update#mantle.product.receipt.AssetReceipt", {
        assetReceiptId,
        invoiceId: other ? other.invoiceId : null,
        invoiceItemSeqId: other ? other.invoiceItemSeqId : null
    })
}
function lineValues(source) {
    const out = {}
    for (const field of [
        "invoiceItemSeqId",
        "orderId",
        "orderItemSeqId",
        "assetReceiptId",
        "shipmentId",
        "quantity",
        "invoiceQuantity",
        "invoiceUnitAmount",
        "orderQuantity",
        "orderUnitAmount",
        "acceptedQuantity",
        "heldQuantity",
        "priorBilledQuantity",
        "priceVariance",
        "billBasisEnumId",
        "invoiceMatchPolicyId"
    ])
        if (source[field] != null) out[field] = source[field]
    return out
}
// The exceptions of a source row as stored on its match line: the one that holds first, and every code.
function exceptionValues(exceptions, text) {
    const first = exceptions.find(row => row.holds) || exceptions[0]
    return {
        exceptionEnumId: first?.exceptionEnumId || null,
        exceptionCodes: exceptions.length ? exceptions.map(row => row.exceptionEnumId).join(",") : null,
        exceptionText: text || null
    }
}
// apply#InvoiceMatch: the allocations re-checked under lock (the bill, then each order line in order), the billing
// links written, the match and its lines recorded, and a hold placed for an exception that holds by its policy.
function apply(p) {
    const scope = bill(p, true)
    const request = {
        invoiceId: scope.invoiceId,
        allocations: Array.from(p.allocationList || []).map(row => [
            row.invoiceItemSeqId,
            row.orderId,
            row.orderItemSeqId,
            row.assetReceiptId || null,
            String(row.quantity)
        ])
    }
    const operation = p.operationKey ? lib.operation(p, "InvoiceMatch", scope.organizationPartyId, request, false) : null
    if (operation?.old) return lib.previous(operation)
    if (closedBillStates.includes(scope.record.statusId)) denied("MATCH_STATE_INVALID", "A cancelled or paid bill is not matched")
    const earlier = appliedMatch(scope.invoiceId, true)
    if (earlier)
        denied(
            "MATCH_EXISTS",
            "Bill " + scope.invoiceId + " is already matched (" + earlier.invoiceMatchId + "); unapply it first"
        )
    const lines = Object.fromEntries(billLines(scope.invoiceId).map(line => [line.invoiceItemSeqId, line]))
    const allocations = []
    const seen = new Set()
    for (const row of Array.from(p.allocationList || [])) {
        const line = lines[row.invoiceItemSeqId]
        if (!line) denied("LINE_INVALID", "Line " + row.invoiceItemSeqId + " is not on bill " + scope.invoiceId)
        let quantity
        try {
            quantity = toDecimal(String(row.quantity ?? "").trim())
        } catch (error) {
            denied("QUANTITY_INVALID", "Enter the quantity to match for line " + row.invoiceItemSeqId)
        }
        if (quantity.compare(0) < 0) denied("QUANTITY_INVALID", "A quantity to match is not negative")
        if (quantity.isZero()) continue
        const key = sourceKey(row)
        if (seen.has(key)) denied("ALLOCATION_DUPLICATE", "The same source is given twice for line " + row.invoiceItemSeqId)
        seen.add(key)
        allocations.push({
            invoiceItemSeqId: row.invoiceItemSeqId,
            orderId: row.orderId,
            orderItemSeqId: row.orderItemSeqId,
            assetReceiptId: row.assetReceiptId || null,
            quantity
        })
    }
    if (!allocations.length) denied("NOTHING_TO_MATCH", "Give a quantity to match for at least one line")
    // lock the order lines in a fixed order, so two bills cannot both take the same remaining quantity
    const orderKeys = [...new Set(allocations.map(row => row.orderId + "\u0000" + row.orderItemSeqId))].sort()
    for (const key of orderKeys) {
        const [orderId, orderItemSeqId] = key.split("\u0000")
        find("mantle.order.OrderItem", {orderId, orderItemSeqId}).forUpdate(true).one()
    }
    const policies = {}
    const policyOf = line =>
        policies[line.invoiceItemSeqId] ||
        (policies[line.invoiceItemSeqId] = policyFor(scope.organizationPartyId, line.productId))
    const evaluated = evaluateAllocations(scope, allocations, policyOf)
    if (evaluated.refused.length) {
        const first = evaluated.refused[0]
        denied(first.refusal[0], first.refusal[1])
    }
    for (const line of Object.values(lines)) {
        const allocated = evaluated.sources
            .filter(row => row.invoiceItemSeqId === line.invoiceItemSeqId)
            .reduce((sum, row) => sum.add(row.quantity), zero())
        const policy = policyOf(line)
        const lineQuantity = dec(line.quantity ?? 1)
        const lineAllowance = allowance(lineQuantity, policy.quantityTolerancePercent, policy.quantityToleranceQuantity)
        if (allocated.compare(lineQuantity.add(lineAllowance)) > 0)
            denied(
                "QUANTITY_EXCESS",
                text(allocated) + " is more than the " + text(lineQuantity) + " of line " + line.invoiceItemSeqId
            )
    }
    const match = call("create#" + M, {
        invoiceId: scope.invoiceId,
        organizationPartyId: scope.organizationPartyId,
        statusId: "ImApplied",
        resultEnumId: evaluated.resultEnumId,
        resultText: evaluated.resultText,
        isLegacy: "N",
        appliedDate: ec.user.nowTimestamp,
        appliedByUserId: ec.user.userId,
        evaluatedDate: ec.user.nowTimestamp
    })
    const invoiceMatchId = match.invoiceMatchId
    let seq = 0
    const nextSeq = () => String(++seq).padStart(5, "0")
    // the links first, then the receipts they cover, then the lines
    const written = evaluated.sources.map(source => writeLink(scope, lines[source.invoiceItemSeqId], source))
    // a link of a matched line that the match leaves out is set to zero, kept on a line so unapply restores it
    const matchedKeys = new Set(evaluated.sources.map(row => row.key))
    const zeroed = []
    for (const link of Array.from(find(OIB, {invoiceId: scope.invoiceId}).condition("quantity", "greater", 0).list())) {
        if (!evaluated.sources.some(row => row.invoiceItemSeqId === link.invoiceItemSeqId)) continue
        if (matchedKeys.has(sourceKey(link))) continue
        call("update#" + OIB, {orderItemBillingId: link.orderItemBillingId, quantity: 0})
        zeroed.push(link)
    }
    const covered = {}
    for (const link of zeroed) if (link.assetReceiptId) releaseReceipt(link.assetReceiptId, scope.invoiceId)
    for (const source of evaluated.sources)
        if (source.assetReceiptId && !(source.assetReceiptId in covered))
            covered[source.assetReceiptId] = coverReceipt(source.assetReceiptId, scope.invoiceId, source.invoiceItemSeqId)
    evaluated.sources.forEach((source, index) => {
        const linkedHere = covered[source.assetReceiptId] === "Y"
        if (linkedHere) covered[source.assetReceiptId] = "done"
        call(
            "create#" + L,
            Object.assign(lineValues(source), written[index], exceptionValues(source.exceptions, source.exceptionText), {
                invoiceMatchId,
                invoiceMatchLineSeqId: nextSeq(),
                invoiceId: scope.invoiceId,
                currencyUomId: scope.currencyUomId,
                receiptLinked: linkedHere ? "Y" : "N"
            })
        )
    })
    for (const link of zeroed)
        call("create#" + L, {
            invoiceMatchId,
            invoiceMatchLineSeqId: nextSeq(),
            invoiceId: scope.invoiceId,
            invoiceItemSeqId: link.invoiceItemSeqId,
            orderId: link.orderId,
            orderItemSeqId: link.orderItemSeqId,
            assetReceiptId: link.assetReceiptId,
            quantity: 0,
            orderItemBillingId: link.orderItemBillingId,
            previousQuantity: link.quantity,
            receiptLinked: "N"
        })
    // the bill lines' own exceptions (no source, unmatched quantity)
    for (const exception of evaluated.exceptions.filter(row => lineExceptionCodes.includes(row.exceptionEnumId)))
        call("create#" + L, {
            invoiceMatchId,
            invoiceMatchLineSeqId: nextSeq(),
            invoiceId: scope.invoiceId,
            invoiceItemSeqId: exception.invoiceItemSeqId,
            invoiceMatchPolicyId: policyOf(lines[exception.invoiceItemSeqId]).invoiceMatchPolicyId,
            invoiceQuantity: lines[exception.invoiceItemSeqId].quantity,
            exceptionEnumId: exception.exceptionEnumId,
            exceptionCodes: exception.exceptionEnumId,
            exceptionText: exception.text
        })
    // a subcontract's service line billed at another price than ordered: the price variance is a cost event of its run
    // (impl-manufacturing P14), written in this transaction
    const outsideVaried = evaluated.sources.some(
        source =>
            !dec(source.priceVariance).isZero() &&
            rows("mantle.order.OrderItemWorkEffort", {orderId: source.orderId, orderItemSeqId: source.orderItemSeqId}).length
    )
    if (outsideVaried)
        ec.resource
            .script("component://mr-mantle/service/mantle/work/ProductionSubcontracts.js")
            .recordBillVariances(invoiceMatchId)
    let invoiceHoldId = null
    const holding = evaluated.exceptions.filter(row => row.holds)
    if (holding.length) invoiceHoldId = placeMatchHold(scope, holding.map(row => row.text).join("; ")).invoiceHoldId
    // the receipt links written above queued this match; it is evaluated now
    call("update#" + M, {invoiceMatchId, invoiceHoldId, staleDate: null, staleReason: null})
    const result = {
        invoiceMatchId,
        resultEnumId: evaluated.resultEnumId,
        resultText: evaluated.resultText,
        invoiceHoldId,
        exceptionTexts: evaluated.exceptions.map(row => row.text)
    }
    if (operation) lib.complete(operation, M, invoiceMatchId, result)
    return result
}
const lineExceptionCodes = ["MeNoSource", "MeQuantityVariance"]
// Reverse a match's billing links: a link it created goes to zero (as Mantle's unapply#InvoiceItemFromOrder does), one it
// updated or zeroed gets its quantity back; then each receipt it touched names a bill still linked to it, or none, and
// one that is covered again by a restored link names this bill.
function reverseLinks(invoiceId, lines) {
    const receipts = {}
    for (const line of lines) {
        if (line.orderItemBillingId)
            call("update#" + OIB, {orderItemBillingId: line.orderItemBillingId, quantity: line.previousQuantity ?? 0})
        if (line.assetReceiptId && line.orderItemBillingId) {
            const restored = dec(line.previousQuantity).compare(0) > 0
            if (!receipts[line.assetReceiptId] || restored) receipts[line.assetReceiptId] = restored ? line : null
        }
    }
    for (const [assetReceiptId, restored] of Object.entries(receipts)) {
        releaseReceipt(assetReceiptId, invoiceId)
        if (restored) coverReceipt(assetReceiptId, invoiceId, restored.invoiceItemSeqId)
    }
}
// unapply#InvoiceMatch: ends the bill's applied match and reverses its links. Its hold stays until an approver releases it.
function unapply(p) {
    const scope = bill(p, true)
    const current = appliedMatch(scope.invoiceId, true)
    if (!current) denied("MATCH_UNAVAILABLE", "Bill " + scope.invoiceId + " has no applied match")
    if (p.invoiceMatchId && p.invoiceMatchId !== current.invoiceMatchId)
        denied("MATCH_UNAVAILABLE", "Match " + p.invoiceMatchId + " is not the bill's applied match")
    reverseLinks(scope.invoiceId, matchLines(current.invoiceMatchId))
    call("update#" + M, {
        invoiceMatchId: current.invoiceMatchId,
        statusId: "ImUnapplied",
        unappliedDate: ec.user.nowTimestamp,
        unappliedByUserId: ec.user.userId,
        staleDate: null,
        staleReason: null
    })
    return {invoiceMatchId: current.invoiceMatchId}
}

// ---- re-evaluation

// One stale match evaluated again against its sources with the policy rows its lines applied, the bill locked before the
// match as apply and unapply lock them. A source that no longer allows its matched quantity is a source change, which
// holds the bill; another exception holds it only when its lines did not record it already, so a hold an approver
// released for an exception the match recorded is not placed again. A legacy match holds only for a source change. New
// exceptions are recorded on the lines; the staleness is cleared. A hold is never released here.
function reevaluate(p) {
    const found = one(M, {invoiceMatchId: p.invoiceMatchId})
    if (!found || found.statusId !== "ImApplied" || !found.staleDate) return {skipped: true}
    const scope = jobBill(found.invoiceId, found.organizationPartyId)
    const match = find(M, {invoiceMatchId: p.invoiceMatchId}).forUpdate(true).one()
    if (!match || match.statusId !== "ImApplied" || !match.staleDate) return {skipped: true}
    const kept = matchLines(match.invoiceMatchId)
    const policyIds = {}
    for (const row of kept) policyIds[row.invoiceItemSeqId] = row.invoiceMatchPolicyId
    const policyOf = line =>
        line.invoiceItemSeqId in policyIds
            ? policyById(policyIds[line.invoiceItemSeqId])
            : policyFor(scope.organizationPartyId, line.productId)
    if (closedBillStates.includes(scope.record.statusId)) {
        call("update#" + M, {invoiceMatchId: match.invoiceMatchId, staleDate: null, evaluatedDate: ec.user.nowTimestamp})
        return {invoiceId: match.invoiceId, resultEnumId: match.resultEnumId, resultText: "The bill is closed; not evaluated"}
    }
    const sourceLines = kept.filter(row => row.orderId && dec(row.quantity).compare(0) > 0)
    const allocations = sourceLines.map(row => ({
        invoiceItemSeqId: row.invoiceItemSeqId,
        orderId: row.orderId,
        orderItemSeqId: row.orderItemSeqId,
        assetReceiptId: row.assetReceiptId,
        quantity: row.quantity
    }))
    const evaluated = evaluateAllocations(scope, allocations, policyOf)
    const changed = evaluated.refused.map(row => ({
        exceptionEnumId: "MeSourceChanged",
        holds: true,
        text: "Source changed: " + row.refusal[1]
    }))
    const recorded = new Set()
    for (const row of kept)
        for (const code of [row.exceptionEnumId, ...String(row.exceptionCodes || "").split(",")].filter(Boolean))
            recorded.add(row.invoiceItemSeqId + "|" + code)
    const same = (a, b) => a != null && b != null && dec(a).compare(dec(b)) == 0
    // An exception the lines recorded holds again when it got worse than their snapshot: a price variance whose bill or
    // order price changed or whose size grew, or a line quantity variance whose bill line grew. The snapshot is updated.
    const fresh = []
    for (const source of evaluated.sources) {
        const line = sourceLines.find(row => sourceKey(row) === source.key)
        // a source that could not be read has no snapshot to compare; it is a source change
        if (!line || source.invoiceUnitAmount == null) continue
        const updates = {}
        const codes = []
        for (const exception of source.exceptions) {
            const known = recorded.has(source.invoiceItemSeqId + "|" + exception.exceptionEnumId)
            const priceChanged =
                exception.exceptionEnumId === "MePriceVariance" &&
                (!same(source.invoiceUnitAmount, line.invoiceUnitAmount) ||
                    !same(source.orderUnitAmount, line.orderUnitAmount) ||
                    dec(source.priceVariance).abs().compare(dec(line.priceVariance).abs()) > 0)
            if (!known || priceChanged) fresh.push(Object.assign({invoiceItemSeqId: source.invoiceItemSeqId}, exception))
            if (!known) codes.push(exception.exceptionEnumId)
        }
        if (codes.length)
            updates.exceptionCodes = [
                ...String(line.exceptionCodes || "")
                    .split(",")
                    .filter(Boolean),
                ...codes
            ].join(",")
        if (!same(source.invoiceUnitAmount, line.invoiceUnitAmount) || !same(source.orderUnitAmount, line.orderUnitAmount))
            Object.assign(updates, {
                invoiceUnitAmount: source.invoiceUnitAmount,
                orderUnitAmount: source.orderUnitAmount,
                priceVariance: source.priceVariance
            })
        if (Object.keys(updates).length)
            call(
                "update#" + L,
                Object.assign({invoiceMatchId: line.invoiceMatchId, invoiceMatchLineSeqId: line.invoiceMatchLineSeqId}, updates)
            )
    }
    let seq = kept.reduce((top, row) => Math.max(top, Number(row.invoiceMatchLineSeqId) || 0), 0)
    for (const exception of evaluated.exceptions.filter(row => lineExceptionCodes.includes(row.exceptionEnumId))) {
        const lineQuantity = evaluated.lines.find(row => row.invoiceItemSeqId === exception.invoiceItemSeqId)?.quantity
        const recordedLine = kept.find(
            row => row.invoiceItemSeqId === exception.invoiceItemSeqId && row.exceptionEnumId === exception.exceptionEnumId
        )
        if (recordedLine) {
            // recorded: holds again only when the bill line grew past the quantity it recorded
            if (recordedLine.invoiceQuantity == null || dec(lineQuantity).compare(dec(recordedLine.invoiceQuantity)) > 0) {
                fresh.push(exception)
                call("update#" + L, {
                    invoiceMatchId: recordedLine.invoiceMatchId,
                    invoiceMatchLineSeqId: recordedLine.invoiceMatchLineSeqId,
                    invoiceQuantity: lineQuantity,
                    exceptionText: exception.text
                })
            }
            continue
        }
        fresh.push(exception)
        call("create#" + L, {
            invoiceMatchId: match.invoiceMatchId,
            invoiceMatchLineSeqId: String(++seq).padStart(5, "0"),
            invoiceId: scope.invoiceId,
            invoiceItemSeqId: exception.invoiceItemSeqId,
            invoiceQuantity: lineQuantity,
            exceptionEnumId: exception.exceptionEnumId,
            exceptionCodes: exception.exceptionEnumId,
            exceptionText: exception.text
        })
    }
    const legacy = match.isLegacy === "Y"
    const holding = [...changed, ...(legacy ? [] : fresh.filter(row => row.holds))]
    const resultEnumId = changed.length ? "ImrException" : evaluated.resultEnumId
    const resultText = [resultNames[resultEnumId], ...changed.map(row => row.text), ...evaluated.exceptions.map(row => row.text)]
        .filter(Boolean)
        .join(". ")
    let invoiceHoldId = match.invoiceHoldId
    let placed = false
    if (holding.length) {
        const hold = placeMatchHold(scope, holding.map(row => row.text).join("; "))
        invoiceHoldId = hold.invoiceHoldId
        placed = hold.placed
    }
    call("update#" + M, {
        invoiceMatchId: match.invoiceMatchId,
        resultEnumId,
        resultText,
        invoiceHoldId,
        evaluatedDate: ec.user.nowTimestamp,
        staleDate: null,
        staleReason: null
    })
    return {invoiceId: match.invoiceId, resultEnumId, resultText, held: placed}
}
// The job: the stale matches, oldest first, each evaluated in its own transaction. A failure is logged naming the bill,
// recorded on the match and its staleness moved to now, so the next run takes the others first and nothing starves.
function run(p) {
    const limit = Math.max(1, Math.min(500, Number(p.limit) || 200))
    const stale = Array.from(
        find(M, {statusId: "ImApplied"}).condition("staleDate", "is-not-null", null).orderBy("staleDate").limit(limit).list()
    )
    const resultList = []
    let failedCount = 0
    for (const match of stale) {
        try {
            const out = lib.probe("mantle.account.InvoiceMatchServices.reevaluate#InvoiceMatch", {
                invoiceMatchId: match.invoiceMatchId
            })
            if (!out.skipped)
                resultList.push({
                    invoiceId: match.invoiceId,
                    invoiceMatchId: match.invoiceMatchId,
                    resultEnumId: out.resultEnumId,
                    resultText: out.resultText,
                    held: !!out.held
                })
        } catch (error) {
            failedCount++
            const message = String(error.message)
            ec.logger.error(
                "Match re-evaluation of bill " + match.invoiceId + " (" + match.invoiceMatchId + ") failed: " + message
            )
            try {
                lib.probe("update#" + M, {
                    invoiceMatchId: match.invoiceMatchId,
                    staleDate: ec.user.nowTimestamp,
                    staleReason: ("Re-evaluation failed: " + message).slice(0, 255)
                })
            } catch (recordError) {
                ec.logger.error("Could not record the failure of match " + match.invoiceMatchId + ": " + recordError.message)
            }
            resultList.push({invoiceId: match.invoiceId, invoiceMatchId: match.invoiceMatchId, resultText: "Failed: " + message})
        }
    }
    return {evaluatedCount: resultList.length - failedCount, failedCount, resultList}
}

// ---- legacy backfill

// The organization's bills with no applied match, in invoice order after afterInvoiceId, from a supplier and a bill date
// range when given. Bills are read a batch at a time and the matched ones left out, so a run goes on past them; at most
// limit bills (100 by default) and 5000 read.
function legacyBills(organizationPartyId, p) {
    const wanted = Math.max(1, Math.min(200, Number(p.limit) || 100))
    const out = []
    let after = p.afterInvoiceId || null
    for (let read = 0; out.length < wanted && read < 5000; ) {
        let query = find(I, {toPartyId: organizationPartyId})
            .condition("fromPartyId", "not-equals", organizationPartyId)
            .condition("statusId", "not-equals", "InvoiceCancelled")
            .condition("invoiceTypeEnumId", "not-equals", "InvoiceCreditMemo")
        if (p.supplierPartyId) query = query.condition("fromPartyId", p.supplierPartyId)
        if (p.fromDate) query = query.condition("invoiceDate", "greater-equals", p.fromDate)
        if (p.thruDate) query = query.condition("invoiceDate", "less", p.thruDate)
        if (p.invoiceIdList && Array.from(p.invoiceIdList).length)
            query = query.condition("invoiceId", "in", Array.from(p.invoiceIdList))
        if (after) query = query.condition("invoiceId", "greater", after)
        const batch = Array.from(query.orderBy("invoiceId").limit(500).list())
        if (!batch.length) break
        read += batch.length
        after = batch[batch.length - 1].invoiceId
        const matched = new Set(
            Array.from(
                find(M, {statusId: "ImApplied"})
                    .condition(
                        "invoiceId",
                        "in",
                        batch.map(row => row.invoiceId)
                    )
                    .list()
            ).map(row => row.invoiceId)
        )
        for (const row of batch) if (!matched.has(row.invoiceId) && out.length < wanted) out.push(row)
    }
    return out
}
// The evidence of one bill line: its billing links, else its receipts. A link or receipt of another party, product or
// line, receipts of more than one order line, or links over the line's quantity are ambiguous; a line with neither has no
// evidence. What the evidence does not explain stays unmatched.
function lineEvidence(scope, line) {
    const quantity = dec(line.quantity ?? 1)
    const sourceOk = (orderId, orderItemSeqId) => {
        try {
            const item = orderLine(scope, orderId, orderItemSeqId)
            return !(line.productId && item.productId && item.productId !== line.productId)
        } catch (error) {
            return false
        }
    }
    const links = Array.from(
        find(OIB, {invoiceId: scope.invoiceId, invoiceItemSeqId: line.invoiceItemSeqId})
            .condition("quantity", "greater", 0)
            .list()
    )
    const receipts = rows("mantle.product.receipt.AssetReceipt", {
        invoiceId: scope.invoiceId,
        invoiceItemSeqId: line.invoiceItemSeqId
    })
    if (links.length) {
        const linked = links.reduce((sum, row) => sum.add(row.quantity ?? 0), zero())
        if (linked.compare(quantity) > 0)
            return {result: "ambiguous", text: "Billing links of " + text(linked) + " exceed the line's " + text(quantity)}
        const bad = links.find(row => !sourceOk(row.orderId, row.orderItemSeqId))
        if (bad)
            return {
                result: "ambiguous",
                text:
                    "Order line " +
                    bad.orderId +
                    ":" +
                    bad.orderItemSeqId +
                    " is not this supplier's, organization's or product's"
            }
        return {
            result: "link",
            links: links.map(row => ({
                orderId: row.orderId,
                orderItemSeqId: row.orderItemSeqId,
                assetReceiptId:
                    row.assetReceiptId ||
                    (receipts.filter(receipt => receipt.orderId === row.orderId && receipt.orderItemSeqId === row.orderItemSeqId)
                        .length === 1
                        ? receipts.find(
                              receipt => receipt.orderId === row.orderId && receipt.orderItemSeqId === row.orderItemSeqId
                          ).assetReceiptId
                        : null),
                quantity: dec(row.quantity),
                orderItemBillingId: row.orderItemBillingId
            })),
            unexplained: quantity.subtract(linked)
        }
    }
    if (receipts.length) {
        const orderLines = [...new Set(receipts.map(row => row.orderId + ":" + row.orderItemSeqId))]
        if (orderLines.length > 1)
            return {
                result: "ambiguous",
                text: "Its receipts are of " + orderLines.length + " order lines: " + orderLines.join(", ")
            }
        const first = receipts[0]
        if (!first.orderId || !sourceOk(first.orderId, first.orderItemSeqId))
            return {result: "ambiguous", text: "Its receipts are not of an order line of this supplier and product"}
        let remaining = quantity
        const proposed = []
        for (const receipt of receipts) {
            const take = min(remaining, dec(receipt.quantityAccepted))
            if (take.compare(0) <= 0) continue
            proposed.push({
                orderId: receipt.orderId,
                orderItemSeqId: receipt.orderItemSeqId,
                assetReceiptId: receipt.assetReceiptId,
                shipmentId: receipt.shipmentId,
                quantity: take
            })
            remaining = remaining.subtract(take)
        }
        return {result: "link", links: proposed, unexplained: remaining}
    }
    return {result: "none", text: "No billing link or receipt names this line"}
}
function legacyRows(scope, line, evidence, names) {
    const base = {
        invoiceId: scope.invoiceId,
        invoiceItemSeqId: line.invoiceItemSeqId,
        lineText: line.description || names[line.productId] || line.productId || "",
        quantity: dec(line.quantity ?? 1),
        result: evidence.result
    }
    if (evidence.result !== "link") return [Object.assign(base, {resultText: evidence.text})]
    const out = evidence.links.map(link =>
        Object.assign({}, base, {
            orderId: link.orderId,
            orderItemSeqId: link.orderItemSeqId,
            assetReceiptId: link.assetReceiptId,
            linkQuantity: link.quantity,
            resultText:
                "Link " +
                text(link.quantity) +
                " to order line " +
                link.orderId +
                ":" +
                link.orderItemSeqId +
                (link.assetReceiptId ? " receipt " + link.assetReceiptId : "")
        })
    )
    if (evidence.unexplained.compare(0) > 0)
        out.push(
            Object.assign({}, base, {
                result: "unexplained",
                resultText: text(evidence.unexplained) + " not explained; left unmatched"
            })
        )
    return out
}
function legacyScope(p) {
    lib.requirePermission("INVOICE_MATCH")
    return lib.organization(p.organizationPartyId || lib.policy.access().activeOrganizationPartyId)
}
// preview#LegacyMatches: per bill line, the link the evidence supports, or why it is ambiguous or has none.
function previewLegacy(p) {
    const organizationPartyId = legacyScope(p)
    const previewRows = []
    const bills = legacyBills(organizationPartyId, p)
    for (const record of bills) {
        const scope = {
            record,
            invoiceId: record.invoiceId,
            organizationPartyId,
            supplierPartyId: record.fromPartyId,
            currencyUomId: record.currencyUomId
        }
        const lines = billLines(record.invoiceId).filter(isProductLine)
        const names = productNames(lines.map(row => row.productId))
        for (const line of lines) previewRows.push(...legacyRows(scope, line, lineEvidence(scope, line), names))
    }
    const count = result => previewRows.filter(row => row.result === result).length
    return {
        previewRows,
        lastInvoiceId: bills.length ? bills[bills.length - 1].invoiceId : null,
        linkCount: count("link"),
        ambiguousCount: count("ambiguous"),
        noEvidenceCount: count("none"),
        unexplainedCount: count("unexplained")
    }
}
// One bill of the backfill, in its own transaction: its lines' evidence read again under lock and recorded as a legacy
// match (links, and each ambiguous line as an exception line). No hold is placed and no unexplained balance is matched.
function applyLegacyBill(p) {
    const scope = bill({invoiceId: p.invoiceId, organizationPartyId: p.organizationPartyId}, true)
    if (appliedMatch(scope.invoiceId, true)) return {invoiceId: scope.invoiceId, resultText: "Already matched", skipped: true}
    const lines = billLines(scope.invoiceId).filter(isProductLine)
    const evidence = lines.map(line => [line, lineEvidence(scope, line)])
    const linkCount = evidence.reduce((sum, [, row]) => sum + (row.result === "link" ? row.links.length : 0), 0)
    const ambiguous = evidence.filter(([, row]) => row.result === "ambiguous")
    if (!linkCount && !ambiguous.length) return {invoiceId: scope.invoiceId, resultText: "No evidence; not linked", skipped: true}
    // matched only when every product line is linked in full; a line without evidence or a quantity the evidence does not
    // explain leaves it partly matched, an ambiguous line makes it an exception
    const open = evidence.filter(([, row]) => row.result === "none" || (row.result === "link" && row.unexplained.compare(0) > 0))
    const resultEnumId = ambiguous.length ? "ImrException" : open.length ? "ImrPartial" : "ImrMatched"
    const resultText = [
        resultNames[resultEnumId],
        ...ambiguous.map(([line, row]) => "Line " + line.invoiceItemSeqId + ": " + row.text),
        ...open.map(
            ([line, row]) =>
                "Line " +
                line.invoiceItemSeqId +
                ": " +
                (row.result === "none" ? row.text : text(row.unexplained) + " not explained")
        )
    ].join(". ")
    const match = call("create#" + M, {
        invoiceId: scope.invoiceId,
        organizationPartyId: scope.organizationPartyId,
        statusId: "ImApplied",
        resultEnumId,
        resultText,
        isLegacy: "Y",
        appliedDate: ec.user.nowTimestamp,
        appliedByUserId: ec.user.userId,
        evaluatedDate: ec.user.nowTimestamp
    })
    let seq = 0
    const nextSeq = () => String(++seq).padStart(5, "0")
    for (const [line, row] of evidence) {
        const invoiceMatchPolicyId = policyFor(scope.organizationPartyId, line.productId).invoiceMatchPolicyId
        if (row.result === "ambiguous")
            call("create#" + L, {
                invoiceMatchId: match.invoiceMatchId,
                invoiceMatchLineSeqId: nextSeq(),
                invoiceId: scope.invoiceId,
                invoiceItemSeqId: line.invoiceItemSeqId,
                invoiceMatchPolicyId,
                exceptionEnumId: "MeAmbiguous",
                exceptionCodes: "MeAmbiguous",
                exceptionText: row.text
            })
        if (row.result !== "link") continue
        for (const link of row.links) {
            const written = link.orderItemBillingId
                ? {orderItemBillingId: link.orderItemBillingId, previousQuantity: link.quantity}
                : writeLink(scope, line, link)
            const receiptLinked = link.assetReceiptId
                ? coverReceipt(link.assetReceiptId, scope.invoiceId, line.invoiceItemSeqId)
                : "N"
            call("create#" + L, {
                invoiceMatchId: match.invoiceMatchId,
                invoiceMatchLineSeqId: nextSeq(),
                invoiceId: scope.invoiceId,
                invoiceItemSeqId: line.invoiceItemSeqId,
                orderId: link.orderId,
                orderItemSeqId: link.orderItemSeqId,
                assetReceiptId: link.assetReceiptId,
                shipmentId: link.shipmentId,
                quantity: link.quantity,
                invoiceQuantity: line.quantity,
                invoiceUnitAmount: line.amount,
                currencyUomId: scope.currencyUomId,
                invoiceMatchPolicyId,
                orderItemBillingId: written.orderItemBillingId,
                previousQuantity: written.previousQuantity,
                receiptLinked
            })
        }
    }
    call("update#" + M, {invoiceMatchId: match.invoiceMatchId, staleDate: null, staleReason: null})
    return {invoiceId: scope.invoiceId, invoiceMatchId: match.invoiceMatchId, resultEnumId, resultText, linkCount}
}
// apply#LegacyMatches: each bill on its own; a bill that fails is named and the others go on. Bills without evidence do
// not count: it keeps reading, in invoice order, until it has linked or tried limit bills with evidence or has read 5000,
// and answers the last bill it read, where the next run goes on.
function applyLegacy(p) {
    const organizationPartyId = legacyScope(p)
    const wanted = Math.max(1, Math.min(200, Number(p.limit) || 100))
    const resultRows = []
    let failedCount = 0
    let tried = 0
    let read = 0
    let lastInvoiceId = p.afterInvoiceId || null
    while (tried < wanted && read < 5000) {
        const bills = legacyBills(organizationPartyId, Object.assign({}, p, {limit: 200, afterInvoiceId: lastInvoiceId}))
        if (!bills.length) break
        for (const record of bills) {
            if (tried >= wanted) break
            read++
            lastInvoiceId = record.invoiceId
            try {
                const out = lib.probe("mantle.account.InvoiceMatchServices.apply#LegacyMatch", {
                    invoiceId: record.invoiceId,
                    organizationPartyId
                })
                if (!out.skipped) {
                    resultRows.push(out)
                    tried++
                }
            } catch (error) {
                failedCount++
                tried++
                ec.logger.error("Legacy match of bill " + record.invoiceId + " failed: " + error.message)
                resultRows.push({
                    invoiceId: record.invoiceId,
                    resultText: "Failed: " + String(error.message).replace(/^[A-Z_]+: /, "")
                })
            }
        }
    }
    return {resultRows, matchedCount: resultRows.filter(row => row.invoiceMatchId).length, failedCount, lastInvoiceId}
}

// ---- policies

// get#MatchPolicies: an organization's policy rows, in effect first, with names; history when asked.
function policies(p) {
    if (!["ACCOUNTING_ADMIN", "INVOICE_MATCH", "ACCOUNTING_VIEW", "PAYABLE_VIEW"].some(permission => has(permission)))
        denied("PERMISSION_DENIED", "Match policy view authority is required")
    const organizationPartyId = lib.organization(p.organizationPartyId || lib.policy.access().activeOrganizationPartyId)
    const now = ec.user.nowTimestamp
    let query = find(P, {organizationPartyId})
    if (p.includeHistory !== "Y" && p.includeHistory !== true) {
        const cf = ec.entity.conditionFactory
        query = query.condition(
            cf.makeCondition([cf.makeCondition("thruDate", "is-null", null), cf.makeCondition("thruDate", "greater", now)], "or")
        )
    }
    const list = Array.from(query.orderBy("productId,productCategoryId,-fromDate").limit(500).list())
    const products = productNames(list.map(row => row.productId))
    const categoryIds = [...new Set(list.map(row => row.productCategoryId).filter(Boolean))]
    const categories = categoryIds.length
        ? Object.fromEntries(
              Array.from(
                  find("mantle.product.category.ProductCategory").condition("productCategoryId", "in", categoryIds).list()
              ).map(row => [row.productCategoryId, row.categoryName || row.productCategoryId])
          )
        : {}
    const names = enumNames(list.flatMap(row => [row.billBasisEnumId, row.varianceActionEnumId]))
    const policyRows = list.map(row =>
        Object.assign(lib.display(row), {
            scopeText: row.productId
                ? "Product " + (products[row.productId] || row.productId)
                : row.productCategoryId
                  ? "Category " + (categories[row.productCategoryId] || row.productCategoryId)
                  : "Organization",
            billBasisName: names[row.billBasisEnumId] || row.billBasisEnumId,
            varianceActionName: names[row.varianceActionEnumId] || row.varianceActionEnumId,
            inEffect: Number(row.fromDate) <= Number(now) && (!row.thruDate || Number(row.thruDate) > Number(now)),
            quantityToleranceText: text(row.quantityTolerancePercent) + "% or " + text(row.quantityToleranceQuantity),
            priceToleranceText: text(row.priceTolerancePercent) + "% or " + text(row.priceToleranceAmount)
        })
    )
    return {policyRows, canEdit: has("ACCOUNTING_ADMIN"), canBackfill: has("INVOICE_MATCH")}
}

const operations = {evaluate, apply, unapply, reevaluate, run, previewLegacy, applyLegacy, applyLegacyBill, policies}
;({
    execute: (op, parameters) => {
        if (!operations[op]) denied("OPERATION_UNKNOWN", "Unknown invoice match operation " + op)
        return operations[op](parameters)
    }
})
