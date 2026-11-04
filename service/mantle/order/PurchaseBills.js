// Purchasing's part of the bill flow (impl-purchasing P6; design-purchasing §6 Bills and money, §10): a supplier
// prepayment asked for from a purchase order (request#SupplierPrepayment, R-PUR-36), a promised payment linked to the
// order's part through add#OrderPartPayment, which the bill's settlement applies when it arrives; and the notice to the
// buying organization's buyers when a bill's match holds it (notify#MatchException, the PurchaseMatchException topic, sent
// by service/PurchaseMatch.secas.xml after apply#InvoiceMatch and reevaluate#InvoiceMatch).
const lib = ec.resource.script("component://mr-mantle/service/mantle/account/InvoiceWorkflowLib.js")
const {one, rows, call, denied} = lib

const internal = partyId => !!partyId && !!one("mantle.party.PartyRole", {partyId, roleTypeId: "OrgInternal"})
// the order statuses a prepayment may be asked for in: placed and not closed
const prepaymentStatuses = ["OrderPlaced", "OrderApproved", "OrderSent", "OrderProcessing", "OrderHold"]
// the payments that no longer count against the order part
const endedPayments = ["PmntCancelled", "PmntVoid", "PmntDeclined", "PmntRefunded"]

// request#SupplierPrepayment: a promised payment from the buying organization to the supplier for the order's purchase
// part, at most what its total leaves after the payments already linked to it (the rest of it when no amount is given).
function prepayment(p) {
    const order = one("mantle.order.OrderHeader", {orderId: p.orderId})
    const parts = order ? rows("mantle.order.OrderPart", {orderId: p.orderId}) : []
    if (!order || parts.length !== 1 || !internal(parts[0].customerPartyId) || internal(parts[0].vendorPartyId))
        denied("NOT_PURCHASE", "Purchase order " + p.orderId + " is not available")
    const part = parts[0]
    const organizationPartyId = lib.organization(part.customerPartyId, "PAYABLE_EDIT", true)
    const given = p.amount == null || String(p.amount).trim() === "" ? null : toDecimal(p.amount)
    const request = {orderId: p.orderId, amount: given == null ? null : String(given)}
    const operation = p.operationKey ? lib.operation(p, "SupplierPrepayment", organizationPartyId, request) : null
    if (operation?.old) return lib.previous(operation)
    if (!prepaymentStatuses.includes(order.statusId))
        denied("ORDER_STATE_INVALID", "A prepayment is asked for on a placed purchase order that is not closed")
    const linked = rows("mantle.account.payment.Payment", {orderId: p.orderId, orderPartSeqId: part.orderPartSeqId})
        .filter(row => !endedPayments.includes(row.statusId))
        .reduce((sum, row) => sum.add(toDecimal(row.amount ?? 0)), toDecimal(0))
    const left = toDecimal(part.partTotal ?? order.grandTotal ?? 0).subtract(linked)
    const amount = given == null ? left : given
    if (amount.compare(0) <= 0 || amount.compare(left) > 0)
        denied(
            "AMOUNT_INVALID",
            "A prepayment is more than zero and at most " +
                ec.l10n.formatCurrency(left.compare(0) > 0 ? left : toDecimal(0), order.currencyUomId) +
                ", what the order leaves after its payments"
        )
    const created = call("mantle.order.OrderServices.add#OrderPartPayment", {
        orderId: p.orderId,
        orderPartSeqId: part.orderPartSeqId,
        statusId: "PmntPromised",
        amount: ec.l10n.roundCurrency(amount, order.currencyUomId),
        effectiveDate: p.effectiveDate || null,
        comments: p.comments || "Supplier prepayment"
    })
    const result = {paymentId: created.paymentId}
    if (operation) lib.complete(operation, "mantle.account.payment.Payment", created.paymentId, result)
    return result
}

// notify#MatchException: a notice of a held bill to the buyers of its organization (PURCHASE_ORDER_EDIT), other than the
// user whose match held it. A notice that cannot be sent is logged; the match stands.
function matchException(p) {
    const bill = one(lib.invoiceEntity, {invoiceId: p.invoiceId})
    if (!bill || !internal(bill.toPartyId) || internal(bill.fromPartyId)) return {sent: false}
    ec.message.pushErrors()
    try {
        ec.resource.script("component://mr-mantle/service/mantle/account/Payables.js").execute("notify", {
            topic: "PurchaseMatchException",
            permission: "PURCHASE_ORDER_EDIT",
            organizationPartyId: bill.toPartyId,
            invoiceId: bill.invoiceId,
            message: {
                invoiceId: bill.invoiceId,
                organizationPartyId: bill.toPartyId,
                supplierPartyId: bill.fromPartyId,
                referenceNumber: bill.referenceNumber || "",
                resultText: p.resultText || ""
            }
        })
        if (ec.message.hasError()) throw new Error(ec.message.getErrorsString())
        return {sent: true}
    } catch (error) {
        ec.logger.error("Match exception notice of bill " + bill.invoiceId + " was not sent: " + error.message)
        return {sent: false}
    } finally {
        ec.message.clearErrors()
        ec.message.popErrors()
    }
}

const operations = {prepayment, matchException}
;({
    execute: (op, parameters) => {
        if (!operations[op]) denied("OPERATION_UNKNOWN", "Unknown purchase bill operation " + op)
        return operations[op](parameters)
    }
})
