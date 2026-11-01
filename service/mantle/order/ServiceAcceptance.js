// Purchasing's service acceptance (design-purchasing PUR-RECEIPT, R-PUR-09; built by impl-warehouse P16b): the accepted
// quantity of a service or non-stock purchase line, with its acceptor, date and evidence, as
// mantle.order.purchase.ServiceAcceptance, which InvoiceMatch reads under the match policy's service-acceptance rule. A
// subcontract line's acceptance is written by Manufacturing's receive#SubcontractOutput with the output receipt and its
// inspection (D14, R-SA-13); nobody enters it by hand.
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const facilityScope = ec.resource.script("component://mr-mantle/service/mantle/facility/FacilityScope.js")
const {find, one, rows, call, denied} = lib

const PRODUCT = "mantle.product.Product",
    ACCEPTANCE = "mantle.order.purchase.ServiceAcceptance"
const zero = () => toDecimal(0)
const dec = value => toDecimal(value ?? 0)
const blank = value => value == null || String(value).trim() === ""
const str = value => (blank(value) ? null : String(value))
const text = value => (value == null ? null : dec(value).compare(0) === 0 ? "0" : String(dec(value).toNumber()))

// A service purchase line of the user's organizations (the buyer), not cancelled, accepted at most as ordered; the
// acceptance written with its evidence. Called by accept#ServiceItem after its check, and by receive#SubcontractOutput in
// its operation (that entry point's check, §2).
function accept(userScope, p) {
    const item =
        blank(p.orderId) || blank(p.orderItemSeqId)
            ? null
            : find("mantle.order.OrderItem", {orderId: p.orderId, orderItemSeqId: p.orderItemSeqId}).forUpdate(true).one()
    const part = item ? one("mantle.order.OrderPart", {orderId: item.orderId, orderPartSeqId: item.orderPartSeqId}) : null
    if (!item || !part || !facilityScope.owns(userScope, part.customerPartyId))
        denied("RECORD_UNAVAILABLE", "Order item " + (p.orderId || "") + ":" + (p.orderItemSeqId || "") + " is not available")
    const header = one("mantle.order.OrderHeader", {orderId: item.orderId})
    const closed = ["OrderCancelled", "OrderRejected"]
    if (closed.includes(header?.statusId) || closed.includes(part.statusId) || closed.includes(item.statusId))
        denied("ORDER_CANCELLED", "Order " + item.orderId + " is cancelled")
    const product = item.productId ? one(PRODUCT, {productId: item.productId}) : null
    if (product && product.productTypeEnumId !== "PtService")
        denied(
            "NOT_SERVICE",
            "Order item " + item.orderId + ":" + item.orderItemSeqId + " is not a service line; receive it as stock"
        )
    const quantity = blank(p.acceptedQuantity) ? zero() : dec(p.acceptedQuantity)
    if (quantity.compare(0) <= 0) denied("QUANTITY_INVALID", "Give the quantity accepted")
    const ordered = dec(item.quantity).subtract(dec(item.quantityCancelled))
    const accepted = rows(ACCEPTANCE, {orderId: item.orderId, orderItemSeqId: item.orderItemSeqId}).reduce(
        (sum, row) => sum.add(dec(row.acceptedQuantity)),
        zero()
    )
    if (accepted.add(quantity).compare(ordered) > 0)
        denied(
            "QUANTITY_EXCEEDS_ORDERED",
            text(accepted) +
                " of " +
                text(ordered) +
                " ordered on " +
                item.orderId +
                ":" +
                item.orderItemSeqId +
                " is accepted already"
        )
    const created = call("create#" + ACCEPTANCE, {
        orderId: item.orderId,
        orderItemSeqId: item.orderItemSeqId,
        acceptedQuantity: quantity,
        quantityUomId: str(p.quantityUomId) || item.quantityUomId || null,
        acceptedDate: p.acceptedDate || ec.user.nowTimestamp,
        acceptedByUserId: ec.user.userId,
        acceptorPartyId: str(p.acceptorPartyId) || ec.user.userAccount?.partyId || null,
        workEffortId: str(p.workEffortId),
        assetReceiptId: str(p.assetReceiptId),
        qualityInspectionId: str(p.qualityInspectionId),
        orderContentId: str(p.orderContentId),
        comments: str(p.comments)
    })
    return {
        serviceAcceptanceId: created.serviceAcceptanceId,
        orderId: item.orderId,
        orderItemSeqId: item.orderItemSeqId,
        acceptedQuantity: text(quantity),
        totalAccepted: text(accepted.add(quantity)),
        orderedQuantity: text(ordered),
        organizationPartyId: part.customerPartyId
    }
}

;({accept})
