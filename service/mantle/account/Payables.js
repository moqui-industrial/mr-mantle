// Payables over Mantle's invoice services: the bills queue of an organization, a supplier bill's intake (import#Bill)
// and a bill or invoice from its order (create#InvoiceFromSource). The checks are the side's permission and the
// organization the user works in (InvoiceWorkflowLib), as for receivables.
const lib = ec.resource.script("component://mr-mantle/service/mantle/account/InvoiceWorkflowLib.js")
const {find, one, rows, call, denied, has} = lib
const I = lib.invoiceEntity
const dayMs = 86400000
const queues = ["incoming", "review", "held", "approved", "due", "overdue", "credits", "expenses", "all"]

// The bills of an organization the user may read: its supplier bills, the linked credits of its bills and supplier
// credits, private counterparties of other users left out, filtered in the query. The condition is built once; a find
// runs once, so the page and the count each make one from it.
function payableQuery(p) {
    if (!has("ACCOUNTING_VIEW") && !has("ACCOUNTING_ADMIN")) lib.requirePermission("PAYABLE_VIEW")
    const organizationPartyId = lib.organization(p.organizationPartyId || lib.policy.access().activeOrganizationPartyId)
    const cf = ec.entity.conditionFactory
    const all = conditions => cf.makeCondition(conditions, "and")
    const any = conditions => cf.makeCondition(conditions, "or")
    const conditions = [
        any([
            all([
                cf.makeCondition("toPartyId", "equals", organizationPartyId),
                cf.makeCondition("creditForInvoiceId", "is-null", null),
                cf.makeCondition("financeDirection", "is-null", null)
            ]),
            all([
                cf.makeCondition("sourceToPartyId", "equals", organizationPartyId),
                cf.makeCondition("financeDirection", "is-null", null)
            ]),
            all([
                cf.makeCondition("financeOrganizationPartyId", "equals", organizationPartyId),
                cf.makeCondition("financeDirection", "equals", "payable")
            ])
        ])
    ]
    const add = (field, op, value) => conditions.push(cf.makeCondition(field, op, value))
    if (!lib.access.systemAdmin())
        for (const field of ["fromPrivateOwnerUserId", "toPrivateOwnerUserId"])
            conditions.push(any([cf.makeCondition(field, "is-null", null), cf.makeCondition(field, "equals", ec.user.userId)]))
    if (p.supplierPartyId)
        conditions.push(
            any([
                cf.makeCondition("fromPartyId", "equals", p.supplierPartyId),
                cf.makeCondition("toPartyId", "equals", p.supplierPartyId)
            ])
        )
    if (p.recordId || p.invoiceId) add("invoiceId", "equals", p.recordId || p.invoiceId)
    if (p.text)
        conditions.push(
            any(
                ["invoiceId", "description", "referenceNumber"].map(field =>
                    cf.makeCondition(field, "like", "%" + p.text + "%").ignoreCase()
                )
            )
        )
    if (p.statusId) add("statusId", "equals", p.statusId)
    if (p.invoiceTypeEnumId) add("invoiceTypeEnumId", "equals", p.invoiceTypeEnumId)
    if (p.currencyUomId) add("currencyUomId", "equals", p.currencyUomId)
    for (const [input, field, op] of [
        ["fromDate", "invoiceDate", "greater-equals"],
        ["thruDate", "invoiceDate", "less"],
        ["dueFromDate", "dueDate", "greater-equals"],
        ["dueThruDate", "dueDate", "less"]
    ])
        if (p[input]) add(field, op, p[input])
    const queue = p.queue || "all"
    if (!queues.includes(queue)) denied("QUEUE_INVALID", "Unknown bills queue")
    const now = Number(ec.user.nowTimestamp)
    if (queue === "incoming") add("statusId", "equals", "InvoiceIncoming")
    else if (queue === "review") add("statusId", "equals", "InvoiceReceived")
    else if (queue === "held") add("heldInvoiceId", "is-not-null", null)
    else if (queue === "credits") add("invoiceTypeEnumId", "equals", "InvoiceCreditMemo")
    else if (queue === "expenses") {
        add("fromPartyTypeEnumId", "equals", "PtyPerson")
        if (!p.statusId) add("statusId", "in", ["InvoiceIncoming", "InvoiceReceived"])
        // People P15 (design-accounting §5 ExpensePosting, R-PPL-19): an employee's expense claim reaches finance once its
        // business approval is done, on the accounts payable route (a claim reserved for payroll is settled by its pay run);
        // a person's other bills (a contractor's, a worker's time) as before
        conditions.push(
            any([
                cf.makeCondition("claimStatusEnumId", "is-null", null),
                all([
                    cf.makeCondition("claimStatusEnumId", "equals", "EcsApproved"),
                    any([
                        cf.makeCondition("claimReservedRouteEnumId", "is-null", null),
                        cf.makeCondition("claimReservedRouteEnumId", "equals", "EcrPayable")
                    ]),
                    any([
                        cf.makeCondition("claimRouteEnumId", "is-null", null),
                        cf.makeCondition("claimRouteEnumId", "equals", "EcrPayable")
                    ])
                ])
            ])
        )
    } else if (["approved", "due", "overdue"].includes(queue)) {
        add("statusId", "equals", "InvoiceApproved")
        add("unpaidTotal", "greater", 0)
        if (queue === "due") add("dueDate", "less", new Date(now + 7 * dayMs))
        if (queue === "overdue") add("dueDate", "less", new Date(now))
    }
    // People P27 (AC-23): a payroll-origin bill (a pay run's net pay or payee invoice) is a reader of payroll's
    const origin = ec.resource.script("component://mr-mantle/service/mantle/account/PayrollOrigin.js").invoiceCondition()
    if (origin) conditions.push(origin)
    const condition = all(conditions)
    return {find: () => find("mantle.account.invoice.InvoiceFinance").condition(condition), organizationPartyId}
}
function statusNames(ids) {
    const wanted = [...new Set(ids.filter(Boolean))]
    if (!wanted.length) return {}
    return Object.fromEntries(
        Array.from(find("moqui.basic.StatusItem").condition("statusId", "in", wanted).list()).map(row => [
            row.statusId,
            row.description || row.statusId
        ])
    )
}
// Rows for a screen: display values, stored totals, party and status names and the open holds' reasons.
function payableRows(records) {
    const names = lib.partyNames(records.flatMap(row => [row.toPartyId, row.fromPartyId]))
    const statuses = statusNames(records.map(row => row.statusId))
    const holds = lib.openHolds(records.map(row => row.invoiceId))
    const reasonIds = [...new Set(Object.values(holds).flatMap(list => list.map(row => row.holdReasonEnumId)))]
    const reasons = reasonIds.length
        ? Object.fromEntries(
              Array.from(find("moqui.basic.Enumeration").condition("enumId", "in", reasonIds).list()).map(row => [
                  row.enumId,
                  row.description
              ])
          )
        : {}
    return records.map(row =>
        Object.assign(lib.invoiceDisplay(row), lib.storedTotals(row), {
            toName: names[row.toPartyId],
            fromName: names[row.fromPartyId],
            statusDescription: statuses[row.statusId] || row.statusId,
            isHeld: !!holds[row.invoiceId],
            holdText: (holds[row.invoiceId] || []).map(hold => reasons[hold.holdReasonEnumId] || hold.holdReasonEnumId).join(", ")
        })
    )
}
function payables(p) {
    const query = payableQuery(p)
    const result = lib.page(query.find().orderBy("-invoiceDate,invoiceId"), p, "records", query.find().count())
    result.rows = payableRows(result.rows)
    result.records = result.rows
    return result
}

// A supplier party for a bill: it exists and no other user keeps it private.
function supplier(partyId) {
    const party = partyId && one("mantle.party.Party", {partyId})
    if (!party || (party.privateOwnerUserId && party.privateOwnerUserId !== ec.user.userId && !lib.access.systemAdmin()))
        denied("SUPPLIER_UNAVAILABLE", "Choose an available supplier")
    return party
}
// The bill of a receipt (a self-billed draft, or a bill made from it later): the first bill, not cancelled, that its
// receipts or shipment lines were billed on.
function receiptBill(organizationPartyId, supplierPartyId, shipmentId) {
    const shipment = one("mantle.shipment.Shipment", {shipmentId})
    if (!shipment || shipment.toPartyId !== organizationPartyId || shipment.fromPartyId !== supplierPartyId)
        denied("SHIPMENT_INVALID", "Choose a receipt from this supplier to this organization")
    const billed = source =>
        Array.from(find(source, {shipmentId}).condition("invoiceId", "is-not-null", null).list()).map(row => row.invoiceId)
    const ids = [...new Set([...billed("mantle.shipment.ShipmentItemSource"), ...billed("mantle.product.receipt.AssetReceipt")])]
    if (!ids.length) return null
    return Array.from(
        find(I)
            .condition("invoiceId", "in", ids)
            .condition("toPartyId", organizationPartyId)
            .condition("statusId", "not-equals", "InvoiceCancelled")
            .orderBy("invoiceId")
            .list()
    )[0]
}
// A supplier's reference already on another bill of the organization refuses, naming that bill.
function requireNewReference(organizationPartyId, supplierPartyId, reference, exceptInvoiceId = null) {
    let query = find(I, {toPartyId: organizationPartyId, fromPartyId: supplierPartyId, referenceNumber: reference}).condition(
        "statusId",
        "not-equals",
        "InvoiceCancelled"
    )
    if (exceptInvoiceId) query = query.condition("invoiceId", "not-equals", exceptInvoiceId)
    const earlier = Array.from(query.orderBy("invoiceId").list())[0]
    if (earlier) denied("BILL_DUPLICATE", "Bill " + reference + " from this supplier is already recorded as " + earlier.invoiceId)
}
function attach(invoiceId, p) {
    if (p.stagedLocation) return attachStaged(invoiceId, p)
    if (!p.contentFile) return null
    return call("mantle.account.InvoiceServices.create#InvoiceContent", {
        invoiceId,
        contentFile: p.contentFile,
        description: p.fileDescription || "Supplier bill",
        contentDate: ec.user.nowTimestamp,
        userId: ec.user.userId
    }).invoiceContentId
}
// A scanned file staged by a public page (submit#SupplierBill), copied to the invoice's content as save#InvoiceContentFile
// places an upload.
function attachStaged(invoiceId, p) {
    const out = call("create#mantle.account.invoice.InvoiceContent", {
        invoiceId,
        description: p.fileDescription || "Supplier bill",
        contentDate: ec.user.nowTimestamp,
        userId: ec.user.userId
    })
    const filename = String(p.stagedFilename || "bill")
        .replace(/[^a-zA-Z0-9._ -]/g, "_")
        .slice(0, 100)
    const root = ec.user.getPreference("mantle.content.large.root") || "dbresource://mantle/content"
    const contentLocation = root + "/invoice/" + invoiceId + "/content_" + out.invoiceContentId + "/" + filename
    const stream = ec.resource.getLocationReference(p.stagedLocation).openStream()
    try {
        ec.resource.getLocationReference(contentLocation).putStream(stream)
    } finally {
        stream.close()
    }
    call("update#mantle.account.invoice.InvoiceContent", {invoiceContentId: out.invoiceContentId, contentLocation})
    return out.invoiceContentId
}
// import#Bill: a supplier's bill, keyed by organization, supplier and the supplier's reference, or for a receipt
// (shipmentId) by the receipt's bill; a repeat is refused and the earlier bill named. The supplier's bill for a receipt
// already billed as a draft (self-billed) is attached to that draft, which takes the supplier's reference; once the draft
// has a reference, or is no longer a draft, another upload for the receipt is refused.
function importBill(p) {
    lib.requirePermission("PAYABLE_IMPORT")
    const organizationPartyId = lib.organization(p.organizationPartyId, null, true)
    supplier(p.supplierPartyId)
    return billCore(p, organizationPartyId)
}
// A supplier's own bill from a public page (submit#SupplierBill): the caller checked the supplier's capability over the
// order (check#AccessCapability) in place of PAYABLE_IMPORT, and the organization and supplier come from it.
function portalBill(p) {
    find("mantle.party.Party", {partyId: p.organizationPartyId}).forNoKeyUpdate(true).one()
    return billCore(p, p.organizationPartyId)
}
// The intake both share: the key, the receipt's self-billed draft, the order check and the incoming draft bill.
function billCore(p, organizationPartyId) {
    const reference = String(p.referenceNumber || "").trim()
    const request = {
        organizationPartyId,
        supplierPartyId: p.supplierPartyId,
        referenceNumber: reference,
        shipmentId: p.shipmentId || null,
        amount: p.amount == null ? null : String(p.amount)
    }
    const operation = p.operationKey ? lib.operation(p, "BillImport", organizationPartyId, request, false) : null
    if (operation?.old) return lib.previous(operation)
    if (!reference) denied("REFERENCE_REQUIRED", "Enter the supplier's bill reference")
    let result = null
    if (p.shipmentId) {
        const bill = receiptBill(organizationPartyId, p.supplierPartyId, p.shipmentId)
        if (bill) {
            if (!["InvoiceIncoming", "InvoiceReceived"].includes(bill.statusId) || bill.referenceNumber)
                denied("BILL_DUPLICATE", "The bill of this receipt is already recorded as " + bill.invoiceId)
            requireNewReference(organizationPartyId, p.supplierPartyId, reference, bill.invoiceId)
            call("update#" + I, {invoiceId: bill.invoiceId, referenceNumber: reference})
            result = {invoiceId: bill.invoiceId, attached: true, invoiceContentId: attach(bill.invoiceId, p)}
        }
    }
    if (!result) {
        requireNewReference(organizationPartyId, p.supplierPartyId, reference)
        if (p.orderId) {
            const part = one("mantle.order.OrderPart", {orderId: p.orderId, orderPartSeqId: p.orderPartSeqId || "01"})
            if (!part || part.customerPartyId !== organizationPartyId || part.vendorPartyId !== p.supplierPartyId)
                denied("ORDER_INVALID", "Choose an order of this organization from this supplier")
        }
        const created = call("mantle.account.InvoiceServices.create#Invoice", {
            fromPartyId: p.supplierPartyId,
            toPartyId: organizationPartyId,
            invoiceTypeEnumId: p.invoiceTypeEnumId || "InvoiceSales",
            currencyUomId: p.currencyUomId || lib.policy.preference(organizationPartyId).baseCurrencyUomId,
            invoiceDate: p.invoiceDate || ec.user.nowTimestamp,
            referenceNumber: reference,
            description: p.description || (p.orderId ? "Bill for order " + p.orderId : "Supplier bill " + reference)
        })
        if (p.amount != null && toDecimal(p.amount).compare(0) > 0)
            call("mantle.account.InvoiceServices.create#InvoiceItem", {
                invoiceId: created.invoiceId,
                itemTypeEnumId: p.itemTypeEnumId || "ItemExpense",
                quantity: "1",
                amount: ec.l10n.roundCurrency(toDecimal(p.amount), one(I, {invoiceId: created.invoiceId}).currencyUomId),
                description: p.description || "Supplier bill " + reference
            })
        result = {invoiceId: created.invoiceId, attached: false, invoiceContentId: attach(created.invoiceId, p)}
    }
    if (operation) lib.complete(operation, I, result.invoiceId, result)
    return result
}

// create#InvoiceFromSource: the bill of a purchase order part (or the invoice of a sales order part) on the ordered basis
// (create#EntireOrderPartInvoice) or, for a purchase, the received basis (create#PurchaseShipmentInvoices with
// acceptedOnly), each delivered receipt once. The order's payments are marked for the invoice, so they apply when it is
// approved. A second invoice of the same source is refused and the first named; a retry with the same operationKey
// answers the first result.
function sourceOf(p) {
    const part = one("mantle.order.OrderPart", {orderId: p.orderId, orderPartSeqId: p.orderPartSeqId || "01"})
    const header = part && one("mantle.order.OrderHeader", {orderId: p.orderId})
    if (!part || !header) denied("ORDER_UNAVAILABLE", "Order is not available")
    const internal = partyId => !!one("mantle.party.PartyRole", {partyId, roleTypeId: "OrgInternal"})
    const payable = internal(part.customerPartyId) && !internal(part.vendorPartyId)
    const organizationPartyId = payable ? part.customerPartyId : part.vendorPartyId
    if (p.organizationPartyId && p.organizationPartyId !== organizationPartyId)
        denied("ORGANIZATION_DENIED", "The order belongs to another organization")
    return {part, header, payable, organizationPartyId}
}
function invoiceFromSource(p) {
    const source = sourceOf(p)
    lib.organization(source.organizationPartyId, source.payable ? "PAYABLE_EDIT" : "RECEIVABLE_EDIT", true)
    supplier(source.payable ? source.part.vendorPartyId : source.part.customerPartyId)
    return invoiceSource(p, source)
}
// create#FulfillmentInvoice (mr-pass impl-shop P6, F22): the sales invoice of an approved order part's lines on the ordered
// basis, split from create#InvoiceFromSource for fulfillment's own entry point (StoreItemFulfillment), which checks what it
// fulfills; no user permission is asked. orderItemSeqIds limits it to those lines and their adjustments, each set of lines
// once (its own source key). Never a purchase.
function fulfillmentInvoice(p) {
    const source = sourceOf(p)
    if (source.payable) denied("SOURCE_BASIS_INVALID", "Only a sale is invoiced for fulfillment")
    return invoiceSource(Object.assign({}, p, {basis: "ordered"}), source)
}
function invoiceSource(p, {part, header, payable, organizationPartyId}) {
    if (!["OrderApproved", "OrderSent", "OrderProcessing", "OrderCompleted"].includes(header.statusId))
        denied("ORDER_STATE_INVALID", "Only an approved order is invoiced")
    // a recurring base (RecurringTemplate, X5) is the next period's template, never invoiced (mr-pass impl-shop P7)
    if (header.orderPurposeEnumId === "OrpRecurringTemplate")
        denied("RECURRING_TEMPLATE", "A recurring template is not invoiced; its renewal orders are")
    const basis = p.basis || "ordered"
    if (!["ordered", "received"].includes(basis)) denied("SOURCE_BASIS_INVALID", "Choose the ordered or the received basis")
    if (basis === "received" && !payable) denied("SOURCE_BASIS_INVALID", "Only a purchase is billed on its receipts")
    const operation = p.operationKey
        ? lib.operation(
              p,
              "InvoiceFromSource",
              organizationPartyId,
              {
                  orderId: p.orderId,
                  orderPartSeqId: part.orderPartSeqId,
                  basis,
                  shipmentId: p.shipmentId || null,
                  ...(p.orderItemSeqIds?.length ? {orderItemSeqIds: Array.from(p.orderItemSeqIds).map(String).sort()} : {})
              },
              false
          )
        : null
    if (operation?.old) return lib.previous(operation)
    const invoiceDate = p.invoiceDate || ec.user.nowTimestamp
    // some lines of the part (fulfillment's): the lines named and their adjustments, keyed by the sorted line ids
    const itemSeqIds = Array.from(p.orderItemSeqIds || [])
        .map(String)
        .sort()
    const partial = itemSeqIds.length
        ? rows("mantle.order.OrderItem", {orderId: p.orderId, orderPartSeqId: part.orderPartSeqId})
              .filter(item => itemSeqIds.includes(item.orderItemSeqId) || itemSeqIds.includes(item.parentItemSeqId))
              .sort((a, b) => String(a.orderItemSeqId).localeCompare(String(b.orderItemSeqId)))
        : null
    const sourceKey = shipmentId =>
        ["source", p.orderId, part.orderPartSeqId, basis, shipmentId || ""].join(":") +
        (partial ? ":" + itemSeqIds.join(",") : "")
    let invoiceIdList = []
    if (basis === "ordered") {
        const earlier = Array.from(
            find(I, {workflowSourceKey: sourceKey(null)})
                .condition("statusId", "not-equals", "InvoiceCancelled")
                .list()
        )[0]
        if (earlier) denied("SOURCE_ALREADY_INVOICED", "This source is already invoiced as " + earlier.invoiceId)
        if (!unbilledItems(p.orderId, part.orderPartSeqId, partial))
            denied("NOTHING_TO_BILL", "Every line of this order is already invoiced")
        const invoiceId = call(
            "mantle.account.InvoiceServices.create#EntireOrderPartInvoice",
            Object.assign(
                {orderId: p.orderId, orderPartSeqId: part.orderPartSeqId, invoiceDate},
                partial ? {partialOrderItemList: partial} : {}
            )
        ).invoiceId
        call("update#" + I, {invoiceId, workflowSourceKey: sourceKey(null)})
        invoiceIdList = [invoiceId]
    } else {
        // each delivered receipt of the order is billed once, on its accepted quantity: a receipt already billed is
        // skipped (named when it is the one given), so each new delivery can be billed
        const shipmentIds = p.shipmentId ? [p.shipmentId] : deliveredShipments(p.orderId)
        let billedAs = null
        for (const shipmentId of shipmentIds) {
            const shipment = one("mantle.shipment.Shipment", {shipmentId})
            if (!shipment || shipment.toPartyId !== organizationPartyId || shipment.statusId !== "ShipDelivered")
                denied("SHIPMENT_INVALID", "Choose a delivered receipt of this order")
            const receipts = rows("mantle.product.receipt.AssetReceipt", {shipmentId, orderId: p.orderId})
            const unbilled = receipts.filter(row => !row.invoiceId && toDecimal(row.quantityAccepted ?? 0).compare(0) > 0)
            if (!unbilled.length) {
                billedAs = billedAs || receipts.find(row => row.invoiceId)?.invoiceId || null
                continue
            }
            const made = call("mantle.account.InvoiceServices.create#PurchaseShipmentInvoices", {
                shipmentId,
                invoiceDate,
                acceptedOnly: true
            })
            for (const invoiceId of Array.from(made.invoiceIdList || [])) {
                call("update#" + I, {invoiceId, workflowSourceKey: sourceKey(shipmentId)})
                invoiceIdList.push(invoiceId)
            }
        }
        if (!invoiceIdList.length && billedAs)
            denied("SOURCE_ALREADY_INVOICED", "The accepted receipts of this order are already billed, as " + billedAs)
        if (!invoiceIdList.length) denied("NOTHING_TO_BILL", "No accepted receipt of this order is left to bill")
    }
    const result = {invoiceId: invoiceIdList[0], invoiceIdList}
    if (operation) lib.complete(operation, I, result.invoiceId, result)
    return result
}
function unbilledItems(orderId, orderPartSeqId, items = null) {
    let count = 0
    for (const item of items || rows("mantle.order.OrderItem", {orderId, orderPartSeqId})) {
        const billed = rows("mantle.order.OrderItemBilling", {orderId, orderItemSeqId: item.orderItemSeqId}).reduce(
            (sum, row) => sum.add(row.quantity ?? 0),
            toDecimal(0)
        )
        if (toDecimal(item.quantity ?? 1).compare(billed) > 0) count++
    }
    return count
}
function deliveredShipments(orderId) {
    const ids = [
        ...new Set(Array.from(find("mantle.shipment.ShipmentItemSource", {orderId}).list()).map(row => row.shipmentId))
    ].filter(Boolean)
    if (!ids.length) return []
    return Array.from(
        find("mantle.shipment.Shipment").condition("shipmentId", "in", ids).condition("statusId", "ShipDelivered").list()
    ).map(row => row.shipmentId)
}

// The holds of a bill, newest first, with their reason and user names, and what the user may do with the bill's holds
// and approval.
function holds(p) {
    const scope = lib.readInvoice(p)
    const record = scope.record
    const list = Array.from(
        find("mantle.account.invoice.InvoiceHold", {invoiceId: record.invoiceId}).orderBy("-placedDate").list()
    )
    const userIds = [
        ...new Set(list.flatMap(row => [row.placedByUserId, row.releasedByUserId, row.releaseRequestedByUserId]).filter(Boolean))
    ]
    const users = userIds.length
        ? Object.fromEntries(
              Array.from(find("moqui.security.UserAccount").condition("userId", "in", userIds).list()).map(row => [
                  row.userId,
                  row.userFullName || row.username
              ])
          )
        : {}
    const reasons = Object.fromEntries(
        rows("moqui.basic.Enumeration", {enumTypeId: "InvoiceHoldReason"}).map(row => [row.enumId, row.description])
    )
    const me = ec.user.userId
    const open = list.filter(row => !row.releasedDate)
    const draft = ["InvoiceIncoming", "InvoiceReceived", "InvoiceInProcess"].includes(record.statusId)
    const payable = !scope.receivable
    const holdRows = list.map(row => ({
        invoiceHoldId: row.invoiceHoldId,
        holdReasonEnumId: row.holdReasonEnumId,
        reasonText: reasons[row.holdReasonEnumId] || row.holdReasonEnumId,
        holdComment: row.holdComment,
        reviewDateText: lib.policy.dateText(row.reviewDate),
        placedByName: users[row.placedByUserId] || row.placedByUserId,
        placedDateText: lib.policy.dateText(row.placedDate),
        releaseRequestedByName: users[row.releaseRequestedByUserId] || "",
        releaseRequestedDateText: lib.policy.dateText(row.releaseRequestedDate),
        releaseRequestNote: row.releaseRequestNote,
        releasedByName: users[row.releasedByUserId] || "",
        releasedDateText: lib.policy.dateText(row.releasedDate),
        releaseComment: row.releaseComment,
        isOpen: !row.releasedDate,
        placedByMe: row.placedByUserId === me,
        canRelease: !row.releasedDate && row.placedByUserId !== me && has("INVOICE_HOLD_RELEASE"),
        canRequestRelease: !row.releasedDate && !row.releaseRequestedDate && has("PAYABLE_EDIT")
    }))
    return {
        holdRows,
        openHoldCount: open.length,
        payableCapabilities: {
            payable,
            canHold: payable && has("INVOICE_HOLD") && !["InvoiceCancelled", "InvoicePmtSent"].includes(record.statusId),
            canApprove: payable && draft && !open.length && has("INVOICE_APPROVE"),
            canRequestApproval: payable && record.statusId === "InvoiceIncoming" && has("PAYABLE_EDIT")
        }
    }
}

// A supplier's bills and payments with an organization, by currency: the open payable (approved and unpaid), the part
// of it on hold, and what is overdue. Bills beyond the first 500 make the summary incomplete.
function supplierSummary(p) {
    const bills = Array.from(
        find(I, {toPartyId: p.organizationPartyId, fromPartyId: p.supplierPartyId})
            .condition("statusId", "not-in", ["InvoiceCancelled"])
            .condition("unpaidTotal", "greater", 0)
            .limit(501)
            .list()
    )
    const holds = lib.openHolds(bills.map(row => row.invoiceId))
    const now = Number(ec.user.nowTimestamp)
    const byCurrency = {}
    for (const bill of bills.slice(0, 500)) {
        const row =
            byCurrency[bill.currencyUomId] ||
            (byCurrency[bill.currencyUomId] = {
                currencyUomId: bill.currencyUomId,
                openPayable: toDecimal(0),
                inReview: toDecimal(0),
                heldTotal: toDecimal(0),
                overdue: toDecimal(0)
            })
        const unpaid = toDecimal(bill.unpaidTotal ?? 0)
        if (["InvoiceIncoming", "InvoiceReceived"].includes(bill.statusId)) row.inReview = row.inReview.add(unpaid)
        else row.openPayable = row.openPayable.add(unpaid)
        if (holds[bill.invoiceId]) row.heldTotal = row.heldTotal.add(unpaid)
        if (bill.statusId === "InvoiceApproved" && bill.dueDate && Number(bill.dueDate) < now)
            row.overdue = row.overdue.add(unpaid)
    }
    return {summaryRows: Object.values(byCurrency), incomplete: bills.length > 500}
}

// The users of an organization who hold a permission: members of a group that is granted it, in effect, whose party is
// an agent, employee or member of the organization. The approval notifications go to them, not to every subscriber.
function organizationUsers(permission, organizationPartyId) {
    const groupIds = rows("moqui.security.UserGroupPermission", {userPermissionId: permission})
        .filter(row => lib.policy.lib.active(row))
        .map(row => row.userGroupId)
    if (!groupIds.length) return []
    const userIds = [
        ...new Set(
            Array.from(find("moqui.security.UserGroupMember").condition("userGroupId", "in", groupIds).list())
                .filter(row => lib.policy.lib.active(row))
                .map(row => row.userId)
        )
    ]
    if (!userIds.length) return []
    const accounts = Array.from(find("moqui.security.UserAccount").condition("userId", "in", userIds).list()).filter(
        row => row.partyId && row.userId !== ec.user.userId
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
            .filter(row => lib.policy.lib.active(row))
            .map(row => row.fromPartyId)
    )
    return accounts.filter(row => members.has(row.partyId)).map(row => row.userId)
}
// Send an approval notification about a bill (or another record: recordEntityName, recordId) to the organization's users
// who may decide it.
function notify(p) {
    const notification = ec
        .makeNotificationMessage()
        .topic(p.topic)
        .message(p.message)
        .record(p.recordEntityName || I, p.recordId || p.invoiceId)
        .actorUserId(ec.user.userId)
        .userIds(organizationUsers(p.permission, p.organizationPartyId))
    notification.send()
    return {notificationMessageId: notification.getNotificationMessageId()}
}
// A decision clears its notifications: each recipient's copy of the topic's messages about the bill (about the hold, when
// one is named; or about another record: recordEntityName, recordId) is marked read, so the Approvals lists empty.
function clearNotices(p) {
    const messages = rows("moqui.security.user.NotificationMessage", {
        topic: p.topic,
        recordEntityName: p.recordEntityName || I,
        recordId: p.recordId || p.invoiceId
    }).filter(row => {
        if (!p.invoiceHoldId) return true
        try {
            return JSON.parse(row.messageJson || "{}").invoiceHoldId === p.invoiceHoldId
        } catch (error) {
            ec.logger.warn("Notification " + row.notificationMessageId + " message is not JSON: " + error.message)
            return false
        }
    })
    let cleared = 0
    for (const message of messages)
        for (const user of rows("moqui.security.user.NotificationMessageUser", {
            notificationMessageId: message.notificationMessageId
        }).filter(row => !row.viewedDate)) {
            call("update#moqui.security.user.NotificationMessageUser", {
                notificationMessageId: user.notificationMessageId,
                userId: user.userId,
                viewedDate: ec.user.nowTimestamp
            })
            cleared++
        }
    return {cleared}
}

const operations = {
    payables,
    importBill,
    portalBill,
    invoiceFromSource,
    fulfillmentInvoice,
    holds,
    supplierSummary,
    notify,
    clearNotices
}
;({
    execute: (op, parameters) => {
        if (!operations[op]) denied("OPERATION_UNKNOWN", "Unknown payables operation " + op)
        return operations[op](parameters)
    }
})
