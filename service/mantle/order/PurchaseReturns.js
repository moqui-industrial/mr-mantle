// Purchasing's supplier returns (design-purchasing §9 Returns and ReturnDetail, PUR-RETURN; impl-purchasing P8): the buyer's
// authorization of a supplier return with the supplier's RMA, and a replacement purchase order for what the supplier sends
// again. Warehouse builds the return's eligibility and items (ReturnStock.js: find#ReturnableReceipts, add#ReceiptToReturn)
// and ships it (ship#SupplierReturn); Accounting settles the billed part (ReturnSettlement.js, settle#Return). A supplier
// return is an internal organization's (the customer) return to a party that is not one (the vendor).
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const facilityScope = ec.resource.script("component://mr-mantle/service/mantle/facility/FacilityScope.js")
const posting = ec.resource.script("component://mr-mantle/service/mantle/shipment/StockPosting.js")
const {find, one, rows, call, denied} = lib

const HEADER = "mantle.order.return.ReturnHeader",
    ITEM = "mantle.order.return.ReturnItem",
    BILLING = "mantle.order.return.ReturnItemBilling"
const openStatuses = ["ReturnCreated", "ReturnRequested"]
const authorizedStatuses = ["ReturnApproved", "ReturnShipped", "ReturnReceived", "ReturnManResp"]
const zero = () => toDecimal(0)
const dec = value => toDecimal(value ?? 0)
const blank = value => value == null || String(value).trim() === ""
const text = value => (dec(value).compare(0) === 0 ? "0" : String(dec(value).toNumber()))

// The supplier return, locked: of an internal organization of the user's (RECORD_UNAVAILABLE otherwise), not a customer return.
function supplierReturn(userScope, returnId) {
    const header = blank(returnId) ? null : find(HEADER, {returnId}).forUpdate(true).one()
    if (!header) denied("RECORD_UNAVAILABLE", "Return " + (returnId || "") + " is not available")
    const internal = partyId => !!partyId && !!one("mantle.party.PartyRole", {partyId, roleTypeId: "OrgInternal"})
    if (!internal(header.customerPartyId) || internal(header.vendorPartyId))
        denied("NOT_SUPPLIER_RETURN", "Return " + returnId + " is not a return to a supplier")
    if (!facilityScope.owns(userScope, header.customerPartyId))
        denied("RECORD_UNAVAILABLE", "Return " + returnId + " is not available")
    return header
}
// The return's items that count (not cancelled, not an adjustment).
const itemsOf = returnId =>
    rows(ITEM, {returnId})
        .filter(item => !item.parentItemSeqId && item.productId && item.statusId !== "ReturnCancelled")
        .sort((a, b) => String(a.returnItemSeqId).localeCompare(String(b.returnItemSeqId)))
// What an item's credits (the billing links of credits not cancelled) and replacements took.
function settledOf(returnId, item) {
    const billings = rows(BILLING, {returnId, returnItemSeqId: item.returnItemSeqId})
    const invoiceIds = [...new Set(billings.map(row => row.invoiceId))]
    const cancelled = new Set(
        invoiceIds.length
            ? Array.from(
                  find("mantle.account.invoice.Invoice")
                      .condition("invoiceId", "in", invoiceIds)
                      .condition("statusId", "InvoiceCancelled")
                      .list()
              ).map(row => row.invoiceId)
            : []
    )
    return billings
        .filter(row => !cancelled.has(row.invoiceId))
        .reduce((sum, row) => sum.add(dec(row.quantity)), zero())
        .add(dec(item.replacedQuantity))
}

// authorize#SupplierReturn: the buyer's authorization (RETURN_AUTHORIZE) of a created or requested supplier return with items,
// with the supplier's RMA number; Mantle's approve#Return then makes the outbound shipment (ReturnApprovedProcess). On an
// authorized return it records the supplier's RMA only.
function authorize(p) {
    posting.requirePermission("RETURN_AUTHORIZE")
    const userScope = posting.scope()
    const header = supplierReturn(userScope, p.returnId)
    const rma = blank(p.supplierRmaId) ? null : String(p.supplierRmaId).trim()
    const answer = status => {
        const sources = rows("mantle.shipment.ShipmentItemSource", {returnId: header.returnId})
        return {
            resultCode: status,
            returnId: header.returnId,
            statusId: one(HEADER, {returnId: header.returnId}).statusId,
            supplierRmaId: rma || header.supplierRmaId || null,
            shipmentId: sources[0]?.shipmentId || null,
            organizationPartyId: header.customerPartyId
        }
    }
    if (authorizedStatuses.includes(header.statusId)) {
        if (!rma || rma === header.supplierRmaId) return answer("ALREADY_AUTHORIZED")
        call("update#" + HEADER, {returnId: header.returnId, supplierRmaId: rma})
        return answer("RMA_RECORDED")
    }
    if (!openStatuses.includes(header.statusId))
        denied("RETURN_CLOSED", "Return " + header.returnId + " is " + header.statusId + " and is not authorized again")
    if (!itemsOf(header.returnId).length)
        denied("RETURN_EMPTY", "Return " + header.returnId + " has no items; add what goes back first")
    if (rma) call("update#" + HEADER, {returnId: header.returnId, supplierRmaId: rma})
    call("mantle.order.ReturnServices.approve#Return", {returnId: header.returnId})
    return answer("AUTHORIZED")
}

// create#ReplacementOrder: a purchase order of the return's organization from its supplier for what it sends again, at no
// price (the goods were bought on the original order), placed and approved, linked from each return item
// (replacementOrderId, replacedQuantity, which settle#Return then leaves out of the credit), with its expected receipt
// through ensure#PurchaseReceipt. An item is replaced at most for what was neither credited nor replaced. Mantle's own
// response processing (respond#ReturnItems) answers nothing for a supplier return, so nothing else orders a replacement.
function replacement(p) {
    const lines = Array.from(p.lineList || [])
        .filter(line => line && !blank(line.returnItemSeqId))
        .map(line => ({
            returnItemSeqId: String(line.returnItemSeqId),
            quantity: blank(line.quantity) ? null : dec(line.quantity)
        }))
    const request = Object.assign({}, p, {
        linesText: lines.map(line => line.returnItemSeqId + "=" + (line.quantity == null ? "" : text(line.quantity))).join(",")
    })
    const begun = posting.begin(request, "ReplacementOrder", "PURCHASE_ORDER_EDIT", [
        "returnId",
        "linesText",
        "facilityId",
        "estimatedArrivalDate"
    ])
    if (begun.previous) return begun.previous
    const userScope = posting.scope()
    const header = supplierReturn(userScope, p.returnId)
    const result = posting.settled(begun.op)
    if (result) return result
    if (!authorizedStatuses.includes(header.statusId))
        denied("RETURN_NOT_APPROVED", "Return " + header.returnId + " is " + header.statusId + "; authorize it first")
    const items = itemsOf(header.returnId)
    const openOf = item => {
        const open = dec(item.returnQuantity).subtract(settledOf(header.returnId, item))
        return open.compare(0) > 0 ? open : zero()
    }
    const asked = lines.length
        ? lines.map(line => {
              const item = items.find(row => row.returnItemSeqId === line.returnItemSeqId)
              if (!item)
                  denied(
                      "RETURN_ITEM_UNAVAILABLE",
                      "Return item " + line.returnItemSeqId + " is not on return " + header.returnId
                  )
              return {item, quantity: line.quantity == null ? openOf(item) : line.quantity}
          })
        : items
              .filter(item => item.returnResponseEnumId === "RrspReplace")
              .map(item => ({item, quantity: openOf(item)}))
              .filter(line => line.quantity.compare(0) > 0)
    if (new Set(asked.map(line => line.item.returnItemSeqId)).size < asked.length)
        denied("DUPLICATE_LINE", "Give each return item once")
    if (!asked.length)
        denied("NOTHING_TO_REPLACE", "Return " + header.returnId + " has no item asking for a replacement that is still open")
    for (const line of asked) {
        if (line.quantity.compare(0) <= 0) denied("QUANTITY_INVALID", "Give a quantity above zero")
        const open = openOf(line.item)
        if (line.quantity.compare(open) > 0)
            denied(
                "QUANTITY_EXCEEDS_ELIGIBLE",
                "Return item " + line.item.returnItemSeqId + " may be replaced for " + text(open) + " more"
            )
    }
    const facilityId = blank(p.facilityId) ? header.facilityId : String(p.facilityId)
    if (!facilityId) denied("FACILITY_REQUIRED", "Choose the facility that receives the replacement")
    posting.facility(userScope, facilityId)
    const order = call("mantle.order.OrderServices.create#Order", {
        customerPartyId: header.customerPartyId,
        vendorPartyId: header.vendorPartyId,
        currencyUomId: header.currencyUomId,
        facilityId,
        orderName: "Replacement for return " + header.returnId
    })
    for (const line of asked)
        call("mantle.order.OrderServices.add#OrderProductQuantity", {
            orderId: order.orderId,
            orderPartSeqId: order.orderPartSeqId,
            productId: line.item.replacementProductId || line.item.productId,
            quantity: line.quantity,
            unitAmount: 0,
            itemTypeEnumId: line.item.itemTypeEnumId || "ItemInventory",
            itemDescription: "Replacement for return " + header.returnId + " item " + line.item.returnItemSeqId
        })
    call("mantle.order.OrderServices.place#Order", {orderId: order.orderId})
    // a replacement at no price commits no new spend, so it is approved with the return's authorization (not the purchase
    // approval, which a buyer cannot give), as Mantle's customer replacement is
    const part = one("mantle.order.OrderPart", {orderId: order.orderId, orderPartSeqId: order.orderPartSeqId})
    if (part.statusId !== "OrderApproved")
        call("mantle.order.OrderServices.update#OrderStatus", {orderId: order.orderId, statusId: "OrderApproved"})
    for (const line of asked) {
        const item = line.item
        call("update#" + ITEM, {
            returnId: header.returnId,
            returnItemSeqId: item.returnItemSeqId,
            replacementOrderId: order.orderId,
            replacedQuantity: dec(item.replacedQuantity).add(line.quantity),
            responseDate: ec.user.nowTimestamp
        })
        // a replaced unit's original bill stands, so the receipt's bill match base takes it back (impl-purchasing F-P8-4)
        if (item.assetReceiptId) {
            const receipt = one("mantle.product.receipt.AssetReceipt", {assetReceiptId: item.assetReceiptId})
            try {
                call("mantle.account.InvoiceMatchServices.queue#MatchReevaluation", {
                    assetReceiptId: item.assetReceiptId,
                    orderId: receipt?.orderId || null,
                    orderItemSeqId: receipt?.orderItemSeqId || null,
                    staleReason: "Supplier return " + header.returnId + " replaced on order " + order.orderId
                })
            } catch (error) {
                ec.message.clearErrors()
                ec.logger.error("Bill matches of receipt " + item.assetReceiptId + " were not queued: " + error.message)
            }
        }
        const fresh = one(ITEM, {returnId: header.returnId, returnItemSeqId: item.returnItemSeqId})
        if (
            ["ReturnShipped", "ReturnReceived", "ReturnManResp"].includes(fresh.statusId) &&
            settledOf(header.returnId, fresh).compare(dec(fresh.returnQuantity)) >= 0
        )
            call("mantle.order.ReturnServices.complete#ReturnItem", {
                returnId: header.returnId,
                returnItemSeqId: item.returnItemSeqId
            })
    }
    const receipt = call("mantle.shipment.WarehouseTaskServices.ensure#PurchaseReceipt", {
        operationKey: "replace-" + header.returnId + "-" + order.orderId,
        orderId: order.orderId,
        orderPartSeqId: order.orderPartSeqId,
        facilityId,
        estimatedArrivalDate: p.estimatedArrivalDate || null
    }).result
    return posting.complete(begun.op, header.customerPartyId, "mantle.order.OrderHeader", order.orderId, {
        resultCode: "CREATED",
        returnId: header.returnId,
        orderId: order.orderId,
        orderPartSeqId: order.orderPartSeqId,
        shipmentId: receipt?.shipmentId || null,
        facilityId,
        lines: asked.map(line => ({returnItemSeqId: line.item.returnItemSeqId, quantity: text(line.quantity)}))
    })
}

;({authorize, replacement})
