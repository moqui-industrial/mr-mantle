// Return receipt and settlement (design-accounting §14 ReturnDetail, D11; design-warehouse WH-RETURN): Warehouse's
// receive#ReturnItems records what arrived without responding, and settle#Return credits, refunds or replaces what was
// received, within cumulative caps, after a preview whose version it must be given. A customer return responds through
// Mantle's process#ReturnItemResponses; a supplier return makes supplier credit memos linked to the bills (F35).
const lib = ec.resource.script("component://mr-mantle/service/mantle/account/InvoiceWorkflowLib.js")
const guard = ec.resource.script("component://mr-mantle/service/mantle/ledger/PostingGuard.js")
const {find, one, rows, call, denied, has, hash} = lib
const entityLib = lib.entityLib
const RH = "mantle.order.return.ReturnHeader"
const RI = "mantle.order.return.ReturnItem"
const RIB = "mantle.order.return.ReturnItemBilling"
const OIB = "mantle.order.OrderItemBilling"
const AR = "mantle.product.receipt.AssetReceipt"
const INV = "mantle.account.invoice.Invoice"
const PAY = "mantle.account.payment.Payment"
const settledStatuses = ["ReturnCreated", "ReturnRequested", "ReturnCancelled"]
const supplierEligibleStatuses = ["ReturnShipped", "ReturnReceived", "ReturnManResp", "ReturnCompleted"]
const receivableStatuses = ["ReturnApproved", "ReturnShipped", "ReturnReceived"]
const customerResponseIds = ["RrspCredit", "RrspRefund", "RrspReplace"]
const responseNames = {RrspCredit: "Credit", RrspRefund: "Refund", RrspReplace: "Replace", RrspManual: "Manual response"}
const doneRefundStatuses = ["PmntDelivered", "PmntConfirmed", "PmntCancelled", "PmntVoid", "PmntDeclined"]
const dec = value => toDecimal(value ?? 0)
const zero = () => toDecimal(0)
const min = (a, b) => (a.compare(b) <= 0 ? a : b)
const positive = value => (value.compare(0) > 0 ? value : zero())
const sum = (list, field) => list.reduce((total, row) => total.add(row[field] ?? 0), zero())
const quantityText = value => ec.l10n.format(dec(value), "#,##0.###")

// A refusal under the design's result codes: missing authority or organization is FORBIDDEN.
function forbidden(test) {
    try {
        return test()
    } catch (error) {
        const code = entityLib.reasonCode(error)
        if (["PERMISSION_DENIED", "ORGANIZATION_DENIED", "ORGANIZATION_REQUIRED"].includes(code))
            denied("FORBIDDEN", String(error.message).replace(/^[A-Z_]+: /, ""))
        throw error
    }
}
// Billing links whose invoice still stands (a cancelled credit frees its quantity).
function standing(billings) {
    const invoiceIds = [...new Set(billings.map(row => row.invoiceId))]
    if (!invoiceIds.length) return []
    const cancelled = new Set(
        Array.from(find(INV).condition("invoiceId", "in", invoiceIds).condition("statusId", "InvoiceCancelled").list()).map(
            row => row.invoiceId
        )
    )
    return billings.filter(row => !cancelled.has(row.invoiceId))
}

// ---- receipt (WarehouseTaskServices.receive#ReturnItems, and Mantle's own receipt under the flag)

// An item's received quantity, and its status once all it authorizes arrived (ReturnManResp for a manual response); its
// non-product children (adjustments) follow it, prorated.
function recordReceived(item, received) {
    const full = received.compare(dec(item.returnQuantity)) >= 0
    const manual = item.returnResponseEnumId === "RrspManual" && !item.responseDate
    const statusId = full && receivableStatuses.includes(item.statusId) ? "ReturnReceived" : item.statusId
    call("update#" + RI, {
        returnId: item.returnId,
        returnItemSeqId: item.returnItemSeqId,
        receivedQuantity: received,
        statusId
    })
    if (full && manual && statusId === "ReturnReceived")
        call("update#" + RI, {returnId: item.returnId, returnItemSeqId: item.returnItemSeqId, statusId: "ReturnManResp"})
    const ratio = dec(item.returnQuantity).isZero()
        ? toDecimal(1)
        : min(toDecimal(1), received.divide(dec(item.returnQuantity)).setScale(6, "HALF_UP"))
    for (const child of rows(RI, {returnId: item.returnId, parentItemSeqId: item.returnItemSeqId})) {
        if (!receivableStatuses.includes(child.statusId)) continue
        call("update#" + RI, {
            returnId: child.returnId,
            returnItemSeqId: child.returnItemSeqId,
            receivedQuantity: dec(child.returnQuantity ?? 1).multiply(ratio),
            statusId: full ? "ReturnReceived" : child.statusId
        })
    }
    return {
        returnId: item.returnId,
        returnItemSeqId: item.returnItemSeqId,
        receivedQuantity: received,
        statusId: full && statusId === "ReturnReceived" ? (manual ? "ReturnManResp" : "ReturnReceived") : statusId
    }
}
function headerReceived(returnId) {
    call("mantle.order.ReturnServices.checkUpdate#ReturnHeaderStatus", {
        returnId,
        statusId: "ReturnReceived",
        itemStatusIds: ["ReturnReceived", "ReturnManResp", "ReturnCompleted", "ReturnCancelled"]
    })
    call("mantle.order.ReturnServices.checkUpdate#ReturnHeaderStatus", {
        returnId,
        statusId: "ReturnManResp",
        itemStatusIds: ["ReturnReceived", "ReturnManResp", "ReturnCancelled"]
    })
}
// Under returnSettlementRequired, a return shipment received through Mantle's own services (receive#ShipmentProduct and
// deliver#Shipment, as a SimpleScreens receipt does) sets each item's received quantity to what its receipts hold,
// accepted and rejected, and processes no response. What receive#ReturnItems already recorded is not counted again.
function syncReceived(p) {
    const keys = [
        ...new Set(
            rows("mantle.shipment.ShipmentItemSource", {shipmentId: p.shipmentId})
                .filter(row => row.returnId && row.returnItemSeqId)
                .map(row => row.returnId + ":" + row.returnItemSeqId)
        )
    ].sort()
    const touched = new Set()
    const syncedItems = []
    for (const key of keys) {
        const [returnId, returnItemSeqId] = key.split(":")
        const item = find(RI, {returnId, returnItemSeqId}).forUpdate(true).one()
        if (!item || !receivableStatuses.includes(item.statusId)) continue
        const receipts = rows(AR, {returnId, returnItemSeqId})
        const received = min(sum(receipts, "quantityAccepted").add(sum(receipts, "quantityRejected")), dec(item.returnQuantity))
        if (received.compare(dec(item.receivedQuantity)) <= 0) continue
        syncedItems.push(recordReceived(item, received))
        touched.add(returnId)
    }
    for (const returnId of touched) headerReceived(returnId)
    return {syncedItems}
}

function receive(p) {
    if (!has("STOCK_RECEIVE")) denied("PERMISSION_DENIED", "Stock receive authority is required")
    const shipment = find("mantle.shipment.Shipment", {shipmentId: p.shipmentId}).forUpdate(true).one()
    if (!shipment) denied("SHIPMENT_UNAVAILABLE", "Shipment is not available")
    if (shipment.shipmentTypeEnumId !== "ShpTpSalesReturn")
        denied("RETURN_SHIPMENT_REQUIRED", "Shipment " + p.shipmentId + " is not a customer return")
    if (shipment.statusId === "ShipCancelled") denied("SHIPMENT_CANCELLED", "Shipment " + p.shipmentId + " is cancelled")
    lib.organization(shipment.toPartyId, null)
    const lines = Array.from(p.itemList || [])
    if (!lines.length) denied("RETURN_LINES_REQUIRED", "Enter what was received")
    const sources = rows("mantle.shipment.ShipmentItemSource", {shipmentId: p.shipmentId})
    let facilityId = p.facilityId
    if (!facilityId) {
        const segment = find("mantle.shipment.ShipmentRouteSegment", {shipmentId: p.shipmentId})
            .orderBy("-shipmentRouteSegmentSeqId")
            .one()
        facilityId = segment?.destinationFacilityId
    }
    if (!facilityId) denied("FACILITY_REQUIRED", "Choose the receiving facility")
    const touched = new Set()
    const receivedItems = []
    // lock order: return, then item
    lines.sort((a, b) => (a.returnId + ":" + a.returnItemSeqId).localeCompare(b.returnId + ":" + b.returnItemSeqId))
    for (const line of lines) {
        const source = sources.find(row => row.returnId === line.returnId && row.returnItemSeqId === line.returnItemSeqId)
        if (!source)
            denied("RETURN_ITEM_NOT_ON_SHIPMENT", "Return item " + line.returnId + ":" + line.returnItemSeqId + " is not on it")
        if (!touched.size) {
            const mode = call("mantle.order.ReturnServices.get#ReturnSettlementMode", {returnId: line.returnId})
            if (!mode.settlementRequired)
                denied("RETURN_SETTLEMENT_OFF", "This organization receives returns when the return shipment is delivered")
        }
        find(RH, {returnId: line.returnId}).forUpdate(true).one()
        const item = find(RI, {returnId: line.returnId, returnItemSeqId: line.returnItemSeqId}).forUpdate(true).one()
        if (!receivableStatuses.includes(item.statusId))
            denied("RETURN_ITEM_CLOSED", "Return item " + line.returnItemSeqId + " is not open for receipt")
        const accepted = dec(line.quantityAccepted)
        const rejected = dec(line.quantityRejected)
        if (accepted.compare(0) < 0 || rejected.compare(0) < 0 || accepted.add(rejected).compare(0) <= 0)
            denied("QUANTITY_INVALID", "Enter the quantity accepted or rejected")
        const received = dec(item.receivedQuantity).add(accepted).add(rejected)
        if (received.compare(dec(item.returnQuantity)) > 0)
            denied(
                "RECEIPT_EXCEEDS_RETURN",
                "Return item " +
                    line.returnItemSeqId +
                    " authorizes " +
                    quantityText(item.returnQuantity) +
                    ", " +
                    quantityText(item.receivedQuantity) +
                    " already received"
            )
        const assetReceiptIds = []
        if (accepted.compare(0) > 0) {
            const out = call("mantle.product.AssetServices.receive#Asset", {
                productId: item.productId,
                facilityId,
                quantity: accepted,
                quantityRejected: rejected,
                rejectionReasonEnumId: line.rejectionReasonEnumId,
                statusId: line.statusId || item.inventoryStatusId || "AstOnHold",
                lotNumber: line.lotNumber,
                // the Warehouse return receipt's quarantine location and identity (impl-warehouse P14, ReturnStock.js)
                locationSeqId: line.locationSeqId || null,
                lotId: line.lotId || null,
                serialNumber: line.serialNumber || null,
                expirationDate: line.expirationDate || null,
                shipmentId: p.shipmentId,
                shipmentItemSourceId: source.shipmentItemSourceId,
                orderId: source.orderId,
                orderItemSeqId: source.orderItemSeqId,
                returnId: item.returnId,
                returnItemSeqId: item.returnItemSeqId
            })
            if (out.assetReceiptId) assetReceiptIds.push(out.assetReceiptId)
        } else {
            // units rejected at the dock are received without stock, so post#AssetReceipt posts nothing
            const out = call("create#" + AR, {
                productId: item.productId,
                shipmentId: p.shipmentId,
                shipmentItemSourceId: source.shipmentItemSourceId,
                returnId: item.returnId,
                returnItemSeqId: item.returnItemSeqId,
                receivedByUserId: ec.user.userId,
                receivedDate: ec.user.nowTimestamp,
                quantityAccepted: zero(),
                quantityRejected: rejected,
                rejectionReasonEnumId: line.rejectionReasonEnumId
            })
            assetReceiptIds.push(out.assetReceiptId)
        }
        // the source's quantity still to handle
        const handled = sum(rows(AR, {shipmentItemSourceId: source.shipmentItemSourceId}), "quantityAccepted").add(
            sum(rows(AR, {shipmentItemSourceId: source.shipmentItemSourceId}), "quantityRejected")
        )
        const notHandled = positive(dec(source.quantity).subtract(handled))
        call("update#mantle.shipment.ShipmentItemSource", {
            shipmentItemSourceId: source.shipmentItemSourceId,
            quantityNotHandled: notHandled,
            statusId: notHandled.isZero() ? "SisReceived" : source.statusId
        })

        touched.add(item.returnId)
        receivedItems.push(Object.assign(recordReceived(item, received), {assetReceiptIds}))
    }
    for (const returnId of touched) headerReceived(returnId)
    const open = rows("mantle.shipment.ShipmentItemSource", {shipmentId: p.shipmentId}).filter(
        row => row.statusId !== "SisReceived" && dec(row.quantityNotHandled ?? row.quantity).compare(0) > 0
    )
    const shipmentDelivered = !open.length && shipment.statusId !== "ShipDelivered"
    if (shipmentDelivered) call("mantle.shipment.ShipmentServices.deliver#Shipment", {shipmentId: p.shipmentId})
    return {receivedItems, shipmentDelivered}
}

// ---- settlement plan

// The return, its organization and side, with the reader's or writer's authority checked.
function returnScope(p, lock) {
    const header = lock ? find(RH, {returnId: p.returnId}).forUpdate(true).one() : one(RH, {returnId: p.returnId})
    if (!header) denied("RETURN_UNAVAILABLE", "Return is not available")
    const mode = call("mantle.order.ReturnServices.get#ReturnSettlementMode", {returnId: p.returnId})
    const supplierReturn = !!mode.supplierReturn
    const organizationPartyId = mode.organizationPartyId
    forbidden(() => lib.organization(organizationPartyId, null, lock))
    const reads = supplierReturn
        ? ["PAYABLE_VIEW", "PAYABLE_EDIT", "ACCOUNTING_VIEW", "ACCOUNTING_ADMIN"]
        : ["RECEIVABLE_VIEW", "RECEIVABLE_EDIT", "ACCOUNTING_VIEW", "ACCOUNTING_ADMIN"]
    if (!reads.some(permission => has(permission)) && !lib.access.systemAdmin())
        denied("FORBIDDEN", "Return settlement authority is required")
    const counterpartyId = supplierReturn ? header.vendorPartyId : header.customerPartyId
    return {header, supplierReturn, organizationPartyId, counterpartyId, settlementRequired: !!mode.settlementRequired}
}
// The order line's billing on the side's invoices (sales invoices from the organization, bills to it), not cancelled.
function billingsOf(orderId, orderItemSeqId, scope) {
    if (!orderId) return []
    const billings = rows(OIB, {orderId, orderItemSeqId})
    const invoiceIds = [...new Set(billings.map(row => row.invoiceId))]
    if (!invoiceIds.length) return []
    const invoices = Object.fromEntries(
        Array.from(find(INV).condition("invoiceId", "in", invoiceIds).list()).map(row => [row.invoiceId, row])
    )
    const side = scope.supplierReturn ? "toPartyId" : "fromPartyId"
    return billings.filter(row => {
        const invoice = invoices[row.invoiceId]
        return (
            invoice &&
            invoice.statusId !== "InvoiceCancelled" &&
            invoice[side] === scope.organizationPartyId &&
            !invoice.creditForInvoiceId &&
            !["InvoiceReturn", "InvoiceCreditMemo"].includes(invoice.invoiceTypeEnumId)
        )
    })
}
// What every return of the side credited of an order line: its items' standing billing links.
function creditedOf(orderId, orderItemSeqId, scope) {
    if (!orderId) return zero()
    const items = rows(RI, {orderId, orderItemSeqId})
    if (!items.length) return zero()
    const headers = Object.fromEntries(
        Array.from(
            find(RH)
                .condition("returnId", "in", [...new Set(items.map(row => row.returnId))])
                .list()
        ).map(row => [row.returnId, row])
    )
    const keys = new Set(
        items
            .filter(row => {
                const header = headers[row.returnId]
                return (
                    header &&
                    header.statusId !== "ReturnCancelled" &&
                    (scope.supplierReturn ? header.customerPartyId : header.vendorPartyId) === scope.organizationPartyId
                )
            })
            .map(row => row.returnId + ":" + row.returnItemSeqId)
    )
    const billings = Array.from(
        find(RIB)
            .condition("returnId", "in", [...new Set(items.map(row => row.returnId))])
            .list()
    ).filter(row => keys.has(row.returnId + ":" + row.returnItemSeqId))
    return sum(standing(billings), "quantity")
}
// The receipt a settled line links: the customer's latest receipt of the item, or the supplier receipt of the order line.
function receiptOf(item, scope) {
    const query = scope.supplierReturn
        ? item.orderId
            ? find(AR, {orderId: item.orderId, orderItemSeqId: item.orderItemSeqId})
            : null
        : find(AR, {returnId: item.returnId, returnItemSeqId: item.returnItemSeqId})
    return query ? query.orderBy("-receivedDate").orderBy("-assetReceiptId").one() : null
}
// The original payments a customer refund can go back to: the orders' captured payments from the customer, with what is
// left to refund of each (its amount less its refunds, pending ones included).
function refundSources(orderIds, scope) {
    if (!orderIds.length) return []
    const payments = Array.from(
        find(PAY)
            .condition("orderId", "in", orderIds)
            .condition("fromPartyId", scope.counterpartyId)
            .condition("toPartyId", scope.organizationPartyId)
            .condition("statusId", "in", ["PmntDelivered", "PmntConfirmed"])
            .orderBy("paymentId")
            .list()
    ).filter(row => !row.refundForPaymentId && row.paymentTypeEnumId !== "PtRefund")
    return payments.map(payment => {
        const refunds = Array.from(
            find(PAY, {refundForPaymentId: payment.paymentId})
                .condition("statusId", "not-in", ["PmntCancelled", "PmntVoid", "PmntDeclined"])
                .list()
        )
        return {
            paymentId: payment.paymentId,
            gateway: !!payment.paymentGatewayConfigId,
            refundable: positive(dec(payment.amount).subtract(sum(refunds, "amount")))
        }
    })
}
// Whether today's book day is open for the side's documents (the period and the accounting locks).
function periodFinding(scope) {
    const day = ec.l10n.format(ec.user.nowTimestamp, "yyyy-MM-dd")
    const fiscal = guard.fiscal(scope.organizationPartyId, ec.user.nowTimestamp, false, [], day)
    const closed = fiscal.findings.filter(row => row.code !== "PERIOD_MISSING")
    if (closed.length) return closed[0].message || "The period is closed"
    const transaction = {
        organizationPartyId: scope.organizationPartyId,
        transactionDate: ec.user.nowTimestamp,
        acctgTransId: null
    }
    const locks = guard.postingLocks(transaction, ["all", scope.supplierReturn ? "purchases" : "sales"], false, day)
    return locks.findings.length ? "Today is protected by an accounting lock" : null
}

function plan(p, lock) {
    const scope = returnScope(p, lock)
    const header = scope.header
    const currencyUomId = header.currencyUomId
    if (settledStatuses.includes(header.statusId))
        denied("RETURN_NOT_APPROVED", "Return " + header.returnId + " is not approved for settlement")
    const receiptless = p.receiptless === true || p.receiptless === "true" || p.receiptless === "Y"
    if (receiptless && scope.supplierReturn)
        denied("RECEIPTLESS_CUSTOMER_ONLY", "Only a customer return is credited without receipt")
    const itemQuery = find(RI, {returnId: header.returnId}).orderBy("returnItemSeqId")
    const allItems = Array.from((lock ? itemQuery.forUpdate(true) : itemQuery).list())
    const items = allItems.filter(row => !row.parentItemSeqId)
    // an item's adjustments (discount, tax) follow it, prorated by the quantity settled
    const children = allItems.filter(row => row.parentItemSeqId && row.statusId !== "ReturnCancelled")
    const ownBillings = standing(rows(RIB, {returnId: header.returnId}))
    const productIds = [...new Set(items.map(row => row.productId).filter(Boolean))]
    const productNames = productIds.length
        ? Object.fromEntries(
              Array.from(find("mantle.product.Product").condition("productId", "in", productIds).list()).map(row => [
                  row.productId,
                  row.productName || row.productId
              ])
          )
        : {}
    const itemRows = items.map(item => {
        const orderItem = item.orderId
            ? one("mantle.order.OrderItem", {orderId: item.orderId, orderItemSeqId: item.orderItemSeqId})
            : null
        const askedUnit = dec([item.returnPrice, orderItem?.unitAmount].find(value => value != null && !dec(value).isZero()) ?? 0)
        // settled: what billing links credited or refunded, and what was replaced, which credits nothing
        const credited = sum(
            ownBillings.filter(row => row.returnItemSeqId === item.returnItemSeqId),
            "quantity"
        )
        const settled = credited.add(dec(item.replacedQuantity))
        const billings = billingsOf(item.orderId, item.orderItemSeqId, scope)
        const billed = sum(billings, "quantity")
        // a credit is never above the unit price the original billed, whatever the return item says
        const billedUnit = billed.isZero()
            ? null
            : billings
                  .reduce((total, row) => total.add(dec(row.quantity).multiply(dec(row.amount))), zero())
                  .divide(billed)
                  .setScale(6, "HALF_UP")
        const unitAmount = billedUnit && billedUnit.compare(askedUnit) < 0 ? billedUnit : askedUnit
        const orderCap = positive(billed.subtract(creditedOf(item.orderId, item.orderItemSeqId, scope)))
        let basis
        if (item.statusId === "ReturnCancelled") basis = zero()
        else if (scope.supplierReturn)
            basis = supplierEligibleStatuses.includes(item.statusId) ? dec(item.returnQuantity) : zero()
        else basis = receiptless ? dec(item.returnQuantity) : dec(item.receivedQuantity)
        const open = positive(basis.subtract(settled))
        const eligible = min(open, orderCap)
        const original = billings[0] || null
        const receipt = receiptOf(item, scope)
        return {
            returnItemSeqId: item.returnItemSeqId,
            productId: item.productId,
            productName: productNames[item.productId] || item.description || item.productId,
            orderId: item.orderId,
            orderItemSeqId: item.orderItemSeqId,
            statusId: item.statusId,
            returnResponseEnumId: item.returnResponseEnumId,
            responseName: responseNames[item.returnResponseEnumId] || item.returnResponseEnumId || "",
            returnQuantity: dec(item.returnQuantity),
            receivedQuantity: dec(item.receivedQuantity),
            settledQuantity: settled,
            creditedQuantity: credited,
            replacedQuantity: dec(item.replacedQuantity),
            billedQuantity: billed,
            unbilledQuantity: scope.supplierReturn ? positive(open.subtract(eligible)) : zero(),
            eligibleQuantity: eligible,
            unitAmount,
            eligibleAmount: ec.l10n.roundCurrency(eligible.multiply(unitAmount), currencyUomId),
            originalInvoiceId: original?.invoiceId || null,
            originalInvoiceItemSeqId: original?.invoiceItemSeqId || null,
            assetReceiptId: receipt?.assetReceiptId || null,
            itemStatusId: item.statusId,
            lastUpdatedStamp: entityLib.ms(item.lastUpdatedStamp)
        }
    })
    const requested = Array.from(p.lineList || []).filter(line => line && line.returnItemSeqId)
    const seen = new Set()
    for (const line of requested) {
        if (seen.has(line.returnItemSeqId))
            denied("DUPLICATE_LINE", "Return item " + line.returnItemSeqId + " is asked for more than once; give it once")
        seen.add(line.returnItemSeqId)
    }
    const asked = requested.length
        ? requested
        : itemRows.filter(row => row.eligibleQuantity.compare(0) > 0).map(row => ({returnItemSeqId: row.returnItemSeqId}))
    const lineRows = []
    for (const line of asked) {
        const row = itemRows.find(item => item.returnItemSeqId === line.returnItemSeqId)
        if (!row)
            denied("RETURN_ITEM_UNAVAILABLE", "Return item " + line.returnItemSeqId + " is not on return " + header.returnId)
        const quantity = line.quantity == null || line.quantity === "" ? row.eligibleQuantity : dec(line.quantity)
        if (quantity.compare(0) <= 0) continue
        if (quantity.compare(row.eligibleQuantity) > 0)
            denied(
                "CREDIT_CAP_EXCEEDED",
                "Return item " + row.returnItemSeqId + " may be settled for " + quantityText(row.eligibleQuantity) + " more"
            )
        const response = scope.supplierReturn ? "RrspCredit" : line.returnResponseEnumId || row.returnResponseEnumId
        if (!scope.supplierReturn && !customerResponseIds.includes(response))
            denied("RESPONSE_REQUIRED", "Choose credit, refund or replacement for return item " + row.returnItemSeqId)
        if (receiptless && response === "RrspReplace")
            denied("RECEIPTLESS_REPLACE", "A replacement waits for the return; credit or refund without receipt")
        if (scope.supplierReturn && !row.originalInvoiceId)
            denied("CREDIT_CAP_EXCEEDED", "Return item " + row.returnItemSeqId + " was not billed; it needs no credit")
        lineRows.push({
            returnItemSeqId: row.returnItemSeqId,
            productName: row.productName,
            quantity,
            returnResponseEnumId: response,
            responseName: responseNames[response],
            unitAmount: row.unitAmount,
            amount: ec.l10n.roundCurrency(quantity.multiply(row.unitAmount), currencyUomId),
            originalInvoiceId: row.originalInvoiceId,
            originalInvoiceItemSeqId: row.originalInvoiceItemSeqId,
            assetReceiptId: row.assetReceiptId
        })
    }
    // An item's adjustments (discount, tax) follow its credit or refund: each settlement credits the adjustment's total
    // times the share of the item credited so far, rounded, less what it credited before, so settling one unit at a
    // time never credits more than the whole. A supplier credit nets them into the line's credit, which is linked to
    // the bill line; a replacement carries none, as it credits nothing.
    if (scope.supplierReturn) {
        for (const line of lineRows) {
            const parent = items.find(item => item.returnItemSeqId === line.returnItemSeqId)
            const parentRow = itemRows.find(row => row.returnItemSeqId === line.returnItemSeqId)
            if (dec(parent.returnQuantity).isZero()) continue
            const shareOf = quantity => min(toDecimal(1), quantity.divide(dec(parent.returnQuantity)).setScale(9, "HALF_UP"))
            for (const child of children.filter(row => row.parentItemSeqId === line.returnItemSeqId)) {
                const childTotal = dec(child.returnQuantity ?? 1).multiply(dec(child.returnPrice))
                const now = ec.l10n
                    .roundCurrency(childTotal.multiply(shareOf(parentRow.creditedQuantity.add(line.quantity))), currencyUomId)
                    .subtract(ec.l10n.roundCurrency(childTotal.multiply(shareOf(parentRow.creditedQuantity)), currencyUomId))
                line.amount = line.amount.add(now)
            }
            if (line.amount.compare(0) <= 0)
                denied("CREDIT_CAP_EXCEEDED", "Return item " + line.returnItemSeqId + " has no billed amount left to credit")
        }
    } else {
        for (const line of [...lineRows]) {
            if (line.returnResponseEnumId === "RrspReplace") continue
            const parent = items.find(item => item.returnItemSeqId === line.returnItemSeqId)
            const parentRow = itemRows.find(row => row.returnItemSeqId === line.returnItemSeqId)
            if (dec(parent.returnQuantity).isZero()) continue
            const share = min(
                toDecimal(1),
                parentRow.creditedQuantity.add(line.quantity).divide(dec(parent.returnQuantity)).setScale(9, "HALF_UP")
            )
            for (const child of children.filter(row => row.parentItemSeqId === line.returnItemSeqId)) {
                const childTotal = dec(child.returnQuantity ?? 1).multiply(dec(child.returnPrice))
                const before = ownBillings
                    .filter(row => row.returnItemSeqId === child.returnItemSeqId)
                    .reduce((total, row) => total.add(dec(row.quantity).multiply(dec(row.amount))), zero())
                const amount = ec.l10n.roundCurrency(childTotal.multiply(share), currencyUomId).subtract(before)
                if (amount.isZero()) continue
                lineRows.push({
                    returnItemSeqId: child.returnItemSeqId,
                    parentItemSeqId: line.returnItemSeqId,
                    productName: child.description || line.productName,
                    quantity: toDecimal(1),
                    returnResponseEnumId: line.returnResponseEnumId,
                    responseName: line.responseName,
                    unitAmount: amount,
                    amount,
                    originalInvoiceId: null,
                    originalInvoiceItemSeqId: null,
                    assetReceiptId: line.assetReceiptId
                })
            }
        }
    }
    const total = response =>
        lineRows.filter(row => row.returnResponseEnumId === response).reduce((t, row) => t.add(row.amount), zero())
    const creditTotal = total("RrspCredit")
    const refundTotal = total("RrspRefund")
    const replaceQuantity = sum(
        lineRows.filter(row => row.returnResponseEnumId === "RrspReplace"),
        "quantity"
    )
    const reason = String(p.reason || "").trim()

    // what would refuse the settlement, first finding first
    let reasonCode = null
    let reasonText = null
    const refuse = (code, text) => {
        if (!reasonCode) {
            reasonCode = code
            reasonText = text
        }
    }
    const refundSourceRows = []
    if (refundTotal.compare(0) > 0) {
        // the refunds of the return's credit memos the gateway has not decided
        const memoIds = [...new Set(ownBillings.map(row => row.invoiceId))]
        const pending = memoIds.length
            ? Array.from(
                  find(PAY)
                      .condition("forInvoiceId", "in", memoIds)
                      .condition("paymentTypeEnumId", "PtRefund")
                      .condition("statusId", "not-in", doneRefundStatuses)
                      .list()
              )
            : []
        if (pending.length) refuse("REFUND_PENDING", "A refund of this return is waiting for its gateway result")
        // within what the orders' payments hold: the largest first (the latest of equal ones), each to what is left of it
        const orderIds = [...new Set(items.map(row => row.orderId).filter(Boolean))]
        const sources = refundSources(orderIds, scope).sort(
            (a, b) => b.refundable.compare(a.refundable) || String(b.paymentId).localeCompare(String(a.paymentId))
        )
        let remaining = refundTotal
        for (const source of sources) {
            if (remaining.compare(0) <= 0) break
            const amount = min(source.refundable, remaining)
            if (amount.compare(0) <= 0) continue
            refundSourceRows.push({paymentId: source.paymentId, amount, gateway: source.gateway})
            remaining = remaining.subtract(amount)
        }
        if (remaining.compare(0) > 0)
            refuse("CREDIT_CAP_EXCEEDED", "A refund stays within what the customer paid on the order and was not refunded")
    }
    if (!lineRows.length) refuse("NOTHING_TO_SETTLE", "Nothing on this return may be settled now")
    if (receiptless && !reason) refuse("REASON_REQUIRED", "A credit without receipt needs a reason")
    if (!scope.settlementRequired && !scope.supplierReturn)
        refuse("RETURN_SETTLEMENT_OFF", "This organization responds to returns when they are received")
    const missing = []
    if (scope.supplierReturn) {
        if (!has("PAYABLE_EDIT")) missing.push("PAYABLE_EDIT")
    } else {
        if (!has("RECEIVABLE_EDIT")) missing.push("RECEIVABLE_EDIT")
        if (refundTotal.compare(0) > 0 && !has("PAYMENT_EDIT")) missing.push("PAYMENT_EDIT")
        if (receiptless && !has("RETURN_CREDIT_APPROVE")) missing.push("RETURN_CREDIT_APPROVE")
        if (receiptless && !has("INVOICE_APPROVE")) missing.push("INVOICE_APPROVE")
    }
    if (missing.length) refuse("FORBIDDEN", missing.join(" and ") + " authority is required")
    // a customer credit memo is issued as the organization issues its invoices: with approval required, by an approver
    // allowed to approve what they drafted; a credit without receipt carries its approver's approval
    const creditMemo = !scope.supplierReturn && creditTotal.add(refundTotal).compare(0) !== 0
    const preference = lib.policy.preference(scope.organizationPartyId)
    // the settler approves a credit without receipt, which they drafted: only where self-approval is allowed
    if (creditMemo && receiptless && preference.allowAccountingSelfApproval !== "Y")
        refuse("SELF_APPROVAL_DENIED", "A credit without receipt is approved by its settler, who drafted it")
    if (
        creditMemo &&
        !receiptless &&
        preference.invoiceApprovalRequired === "Y" &&
        (!has("INVOICE_APPROVE") || preference.allowAccountingSelfApproval !== "Y")
    )
        refuse("APPROVAL_REQUIRED", "This organization approves credits; settling needs an approver allowed to self-approve")
    const closed = periodFinding(scope)
    if (closed) refuse("CLOSED_PERIOD", closed)

    const previewVersion = hash({
        returnId: header.returnId,
        statusId: header.statusId,
        items: itemRows.map(row => [
            row.returnItemSeqId,
            row.itemStatusId,
            String(row.returnQuantity),
            String(row.receivedQuantity),
            String(row.settledQuantity),
            String(row.eligibleQuantity),
            String(row.unitAmount)
        ]),
        lines: lineRows.map(row => [row.returnItemSeqId, String(row.quantity), row.returnResponseEnumId]),
        receiptless,
        refunds: refundSourceRows.map(row => [row.paymentId, String(row.amount)])
    })
    return {
        scope,
        header,
        receiptless,
        reason,
        approvalRequired: preference.invoiceApprovalRequired === "Y",
        result: {
            returnId: header.returnId,
            organizationPartyId: scope.organizationPartyId,
            supplierReturn: scope.supplierReturn,
            currencyUomId,
            itemRows: itemRows.map(row => Object.assign({}, row, {lastUpdatedStamp: undefined})),
            lineRows,
            creditTotal,
            refundTotal,
            replaceQuantity,
            refundSourceRows,
            refundForPaymentId: refundSourceRows[0]?.paymentId || null,
            previewVersion,
            canSettle: !reasonCode,
            reasonCode,
            reasonText
        }
    }
}

function preview(p) {
    return plan(p, false).result
}

// ---- settlement

// The settlement, then each gateway refund: the credit, the promised refunds and the operation record commit first
// (record#ReturnSettlement); each gateway call then runs in its own transaction, its attempt recorded before it, so a
// retry with the same key answers from the record and calls no gateway twice. A decline marks that refund declined, its
// amount refundable again on the original, and leaves the credit and the other refunds; a call that fails or times out
// leaves its refund promised for the gateway's lookup (REFUND_PENDING).
function settle(p) {
    const result = entityLib.probe("mantle.order.ReturnServices.record#ReturnSettlement", p).result
    for (const gateway of Array.from(result.gatewayRefunds || [])) gatewayRefund(gateway)
    result.refundStatusIds = Array.from(result.refundPaymentIds || []).map(paymentId => one(PAY, {paymentId}).statusId)
    result.refundStatusId = result.refundStatusIds[0] || null
    result.resultCode = result.refundStatusIds.includes("PmntDeclined")
        ? "REFUND_DECLINED"
        : result.refundStatusIds.some(statusId => !["PmntDelivered", "PmntConfirmed"].includes(statusId))
          ? "REFUND_PENDING"
          : "SETTLED"
    return result
}
function gatewayRefund(gateway) {
    const E = "mantle.account.payment.PaymentLifecycleEvent"
    if (find(E, {paymentId: gateway.refundPaymentId, operationKey: gateway.operationKey}).count() > 0) return
    entityLib.probe("create#" + E, {
        paymentId: gateway.refundPaymentId,
        organizationPartyId: gateway.organizationPartyId,
        userId: ec.user.userId,
        action: "Gateway refund",
        operationKey: gateway.operationKey,
        createdDate: ec.user.nowTimestamp
    })
    try {
        entityLib.probe("mantle.account.PaymentServices.refund#SinglePayment", {
            paymentId: gateway.paymentId,
            refundPaymentId: gateway.refundPaymentId,
            operationKey: gateway.operationKey
        })
    } catch (error) {
        ec.logger.error("Gateway refund " + gateway.refundPaymentId + " did not finish: " + error.message)
        return
    }
    // a gateway that gave no answer to look up (no refund service, no response) refunded nothing
    const refund = one(PAY, {paymentId: gateway.refundPaymentId})
    const answered = rows("mantle.account.method.PaymentGatewayResponse", {refundPaymentId: gateway.refundPaymentId}).some(
        row => row.referenceNum
    )
    if (["PmntPromised", "PmntAuthorized"].includes(refund.statusId) && !answered)
        entityLib.probe("update#" + PAY, {paymentId: gateway.refundPaymentId, statusId: "PmntDeclined"})
}

function record(p) {
    const peek = returnScope(p, false)
    const writer = peek.supplierReturn ? "PAYABLE_EDIT" : "RECEIVABLE_EDIT"
    if (!has(writer)) denied("FORBIDDEN", writer + " authority is required")
    const request = {
        returnId: p.returnId,
        lineList: Array.from(p.lineList || []).map(line => ({
            returnItemSeqId: line.returnItemSeqId,
            quantity: line.quantity == null || line.quantity === "" ? null : String(line.quantity),
            returnResponseEnumId: line.returnResponseEnumId || null
        })),
        receiptless: !!p.receiptless && p.receiptless !== "false" && p.receiptless !== "N",
        reason: p.reason || null,
        previewVersion: p.previewVersion
    }
    const op = entityLib.operation(p, "ReturnSettlement", peek.organizationPartyId, request)
    const earlier = lib.previous(op)
    if (earlier) return earlier

    const planned = plan(p, true)
    const out = planned.result
    if (out.previewVersion !== p.previewVersion)
        denied("RECEIPT_CHANGED", "The return changed since it was previewed; preview it again")
    if (out.reasonCode) denied(out.reasonCode, out.reasonText)
    const scope = planned.scope
    const billingFields = {
        receiptless: planned.receiptless ? "Y" : "N",
        settlementReason: planned.reason || null,
        approvedByUserId: planned.receiptless ? ec.user.userId : null,
        settledByUserId: ec.user.userId,
        settledDate: ec.user.nowTimestamp,
        operationKey: op.operationKey
    }
    const result = {
        returnId: out.returnId,
        resultCode: "SETTLED",
        creditInvoiceIds: [],
        creditPaymentId: null,
        refundPaymentId: null,
        refundPaymentIds: [],
        refundStatusId: null,
        replacementOrderIds: [],
        settledLines: out.lineRows.map(row => ({
            returnItemSeqId: row.returnItemSeqId,
            quantity: String(row.quantity),
            amount: String(row.amount),
            returnResponseEnumId: row.returnResponseEnumId
        })),
        alreadyApplied: false
    }
    if (scope.supplierReturn) supplierCredits(out, scope, billingFields, result)
    else customerResponses(out, planned, billingFields, result)
    completeSettled(out, planned)
    // refunds without a gateway are paid now; a gateway refund stays promised for its own transaction (settle)
    deliverRefunds(out, op, result)
    entityLib.complete(op, RH, out.returnId, result)
    return result
}

function customerResponses(out, planned, billingFields, result) {
    const quantities = {}
    const unitAmounts = {}
    const receipts = {}
    const originals = {}
    for (const line of out.lineRows) {
        const item = one(RI, {returnId: out.returnId, returnItemSeqId: line.returnItemSeqId})
        if (item.returnResponseEnumId !== line.returnResponseEnumId)
            call("update#" + RI, {
                returnId: out.returnId,
                returnItemSeqId: line.returnItemSeqId,
                returnResponseEnumId: line.returnResponseEnumId
            })
        quantities[line.returnItemSeqId] = line.quantity
        unitAmounts[line.returnItemSeqId] = line.unitAmount
        if (!planned.receiptless && line.assetReceiptId) receipts[line.returnItemSeqId] = line.assetReceiptId
        if (line.originalInvoiceId)
            originals[line.returnItemSeqId] = {invoiceId: line.originalInvoiceId, invoiceItemSeqId: line.originalInvoiceItemSeqId}
    }
    const responded = call("mantle.order.ReturnServices.respond#ReturnItems", {
        returnId: out.returnId,
        settlement: {
            quantities,
            unitAmounts,
            receipts,
            originals,
            refundSources: out.refundSourceRows.map(row => ({paymentId: row.paymentId, amount: row.amount})),
            billingFields
        }
    })
    if (responded.returnInvoiceId) {
        result.creditInvoiceIds.push(responded.returnInvoiceId)
        issueCredit(responded.returnInvoiceId, out, planned)
    }
    result.creditPaymentId = responded.creditPaymentId || null
    result.replacementOrderIds = Array.from(responded.replacementOrderIds || [])
    result.refundPaymentIds = Array.from(responded.refundPaymentIds || [])
    result.refundPaymentId = result.refundPaymentIds[0] || null
}

// The credit memo is issued through the invoice workflow (change#InvoiceState): its period, posting and the credit cap of
// its original sales invoice when it has one; with approval required, approved by the settler (who may self-approve); a
// credit without receipt carries the approval of its approver, the settler, stamped self-approved.
function issueCredit(invoiceId, out, planned) {
    const originals = [...new Set(out.lineRows.map(row => row.originalInvoiceId).filter(Boolean))]
    const fields = {invoiceId}
    if (originals.length === 1) fields.creditForInvoiceId = originals[0]
    call("update#" + INV, fields)
    const memo = one(INV, {invoiceId})
    call("mantle.account.InvoiceServices.change#InvoiceState", {
        invoiceId,
        organizationPartyId: out.organizationPartyId,
        action: planned.approvalRequired || planned.receiptless ? "approve" : "finalize",
        lastUpdatedStamp: memo.lastUpdatedStamp,
        changeReason: "Return " + out.returnId + " settled"
    })
}

// A refund without a gateway is paid now, which applies it to the credit memo; one through a gateway is left for settle.
function deliverRefunds(out, op, result) {
    result.gatewayRefunds = []
    result.refundPaymentIds.forEach((refundPaymentId, index) => {
        const source = out.refundSourceRows[index]
        if (source.gateway)
            result.gatewayRefunds.push({
                refundPaymentId,
                paymentId: source.paymentId,
                organizationPartyId: out.organizationPartyId,
                operationKey: op.operationKey + "-" + (index + 1)
            })
        else call("update#" + PAY, {paymentId: refundPaymentId, statusId: "PmntDelivered", effectiveDate: ec.user.nowTimestamp})
    })
}

function supplierCredits(out, scope, billingFields, result) {
    for (const line of out.lineRows) {
        if (!line.originalInvoiceId || line.amount.compare(0) <= 0)
            denied("CREDIT_CAP_EXCEEDED", "Return item " + line.returnItemSeqId + " has no billed amount to credit")
        const credit = call("mantle.account.InvoiceServices.create#InvoiceCreditMemo", {
            originalInvoiceId: line.originalInvoiceId,
            linkToOriginal: true,
            organizationPartyId: scope.organizationPartyId,
            amount: line.amount,
            description:
                "Return " +
                out.returnId +
                " item " +
                line.returnItemSeqId +
                ": " +
                quantityText(line.quantity) +
                " " +
                line.productName
        })
        const creditItem = find("mantle.account.invoice.InvoiceItem", {invoiceId: credit.invoiceId})
            .orderBy("invoiceItemSeqId")
            .one()
        call(
            "create#" + RIB,
            Object.assign(
                {
                    returnId: out.returnId,
                    returnItemSeqId: line.returnItemSeqId,
                    invoiceId: credit.invoiceId,
                    invoiceItemSeqId: creditItem.invoiceItemSeqId,
                    assetReceiptId: line.assetReceiptId,
                    quantity: line.quantity,
                    amount: line.unitAmount,
                    originalInvoiceId: line.originalInvoiceId,
                    originalInvoiceItemSeqId: line.originalInvoiceItemSeqId
                },
                billingFields
            )
        )
        const item = one(RI, {returnId: out.returnId, returnItemSeqId: line.returnItemSeqId})
        call("update#" + RI, {
            returnId: out.returnId,
            returnItemSeqId: line.returnItemSeqId,
            responseAmount: dec(item.responseAmount).add(line.amount),
            responseDate: ec.user.nowTimestamp
        })
        result.creditInvoiceIds.push(credit.invoiceId)
        // the bill's match reads the credited quantity
        const orderItem = item.orderId ? {orderId: item.orderId, orderItemSeqId: item.orderItemSeqId} : {}
        call(
            "mantle.account.InvoiceMatchServices.queue#MatchReevaluation",
            Object.assign({invoiceId: line.originalInvoiceId, staleReason: "Supplier return " + out.returnId}, orderItem)
        )
    }
}

// An item settled for all it authorizes (credited, refunded or replaced) is complete, with its adjustments; one credited
// without receipt has its remainder closed first (Received), as a return authorizer closes it, and when that completes the
// return its open shipment is closed: cancelled with nothing received on it, else delivered.
function completeSettled(out, planned) {
    const settledNow = standing(rows(RIB, {returnId: out.returnId}))
    const closing = []
    for (const line of out.lineRows.filter(row => !row.parentItemSeqId)) {
        const item = one(RI, {returnId: out.returnId, returnItemSeqId: line.returnItemSeqId})
        const settled = sum(
            settledNow.filter(row => row.returnItemSeqId === line.returnItemSeqId),
            "quantity"
        ).add(dec(item.replacedQuantity))
        if (settled.compare(dec(item.returnQuantity)) < 0) continue
        if (item.statusId === "ReturnApproved" && !planned.receiptless) continue
        closing.push(...rows(RI, {returnId: out.returnId, parentItemSeqId: item.returnItemSeqId}), item)
    }
    const open = closing.filter(item =>
        ["ReturnApproved", "ReturnShipped", "ReturnReceived", "ReturnManResp"].includes(item.statusId)
    )
    if (planned.receiptless) {
        for (const item of open.filter(row => row.statusId === "ReturnApproved"))
            call("update#" + RI, {returnId: item.returnId, returnItemSeqId: item.returnItemSeqId, statusId: "ReturnReceived"})
        call("mantle.order.ReturnServices.checkUpdate#ReturnHeaderStatus", {
            returnId: out.returnId,
            statusId: "ReturnReceived",
            itemStatusIds: ["ReturnReceived", "ReturnManResp", "ReturnCompleted", "ReturnCancelled"]
        })
    }
    for (const item of open)
        call("mantle.order.ReturnServices.complete#ReturnItem", {returnId: item.returnId, returnItemSeqId: item.returnItemSeqId})
    if (!planned.receiptless || one(RH, {returnId: out.returnId}).statusId !== "ReturnCompleted") return
    const shipmentIds = [
        ...new Set(rows("mantle.shipment.ShipmentItemSource", {returnId: out.returnId}).map(row => row.shipmentId))
    ]
    for (const shipmentId of shipmentIds) {
        const shipment = one("mantle.shipment.Shipment", {shipmentId})
        if (!shipment || ["ShipDelivered", "ShipCancelled"].includes(shipment.statusId)) continue
        if (rows(AR, {shipmentId}).length) call("mantle.shipment.ShipmentServices.deliver#Shipment", {shipmentId})
        else call("mantle.shipment.ShipmentServices.cancel#Shipment", {shipmentId, undoIssueReceive: false})
    }
}

const operations = {receive, syncReceived, preview, settle, record}
;({
    execute: (operation, parameters) => {
        if (!operations[operation]) throw new Error("Unknown return operation " + operation)
        return operations[operation](parameters)
    }
})
