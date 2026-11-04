// A purchase order's documents (design-purchasing §6 OrderDetail Send, §15; impl-purchasing P3, §2, F36, F42): its print as
// of its revision or of a date and time, read back from the audit log (the header's status and revision; each line's
// product, quantity, unit, price, cancelled quantity, description and required date), and its send to the supplier on
// Mantle's send#Invoice path: the print rendered to a PDF stored once per print as the order's OrderContent (type
// OctPurchaseOrderIssued, named by its revision), one send#EmailTemplate per recipient with the bytes attached, each recorded
// as an OrderEmailMessage with the revision sent; a recipient the revision was already sent to is not sent again, and the
// same operation key answers the first result. The recipients are the supplier's EmailOrder addresses, else EmailPrimary.
// A send to anyone, or a revision already sent to them (an order back from a hold), moves an approved order to Sent.
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const orders = ec.resource.script("component://mr-mantle/service/mantle/order/PurchaseOrders.js")
const {find, one, rows, call, denied, ms} = lib

const ORDER = "mantle.order.OrderHeader",
    PART = "mantle.order.OrderPart",
    ITEM = "mantle.order.OrderItem"
// P9: a revision's changes on its print (PurchaseRevisions.js)
const revisions = () => ec.resource.script("component://mr-mantle/service/mantle/order/PurchaseRevisions.js")
// P9: the part's fields a print reads back as of a time (the supplier, delivery, terms and the supplier's reference, F36)
const partFields = [
    "vendorPartyId",
    "facilityId",
    "postalContactMechId",
    "otherPartyOrderId",
    "otherPartyOrderDate",
    "estimatedDeliveryDate",
    "settlementTermId",
    "tradeTermEnumId"
]
const readPermissions = ["PURCHASE_ORDER_EDIT", "PURCHASE_APPROVE", "PURCHASE_ORDER_APPROVE"]
const sendStatuses = ["OrderApproved", "OrderSent"]
const blank = value => value == null || String(value).trim() === ""
const partyName = partyId => lib.partyNames([partyId])[partyId] || partyId || ""
const statusText = statusId => (statusId ? one("moqui.basic.StatusItem", {statusId})?.description || statusId : "")
const uomText = uomId => (uomId ? one("moqui.basic.Uom", {uomId})?.abbreviation || uomId : "")
const quantityText = value => (value == null ? "" : ec.l10n.format(toDecimal(value), "#,##0.###"))

// ===== as of a time =====
// A field's value at a time: the old value of its first change after the time, else the value now. Each log row is
// {changedFieldName, pkSecondaryValue, oldValueText, newValueText, changedDate}.
function valueAt(logs, field, secondary, at, current) {
    const change = logs.find(
        row =>
            row.changedFieldName === field &&
            (secondary == null || row.pkSecondaryValue === secondary) &&
            ms(row.changedDate) > at
    )
    return change ? change.oldValueText : current
}
// When a line was created: the logged creation of its quantity (audit-logged on create), else unknown (null, a line
// loaded as data, taken as always there).
function createdAt(logs, orderItemSeqId) {
    const created = logs.find(
        row => row.changedFieldName === "quantity" && row.pkSecondaryValue === orderItemSeqId && row.oldValueText == null
    )
    return created ? ms(created.changedDate) : null
}
const decimalOf = value => (value == null || value === "" ? null : toDecimal(value))

// The order as of a time (null for now): its header and lines then, with the revision and its time.
function orderAt(po, at) {
    const order = po.order
    const now = at == null
    const auditFind = (entity, fields) =>
        Array.from(
            find("moqui.entity.EntityAuditLog")
                .condition("changedEntityName", entity)
                .condition("pkPrimaryValue", order.orderId)
                .condition("changedFieldName", "in", fields)
                .orderBy("changedDate")
                .list()
        )
    const headerLogs = now ? [] : auditFind(ORDER, ["statusId", "orderRevision", "currencyUomId"])
    const partLogs = now ? [] : auditFind(PART, partFields)
    const itemFields = [
        "productId",
        "quantity",
        "unitAmount",
        "quantityUomId",
        "quantityCancelled",
        "itemDescription",
        "requiredByDate"
    ]
    const itemLogs = now ? [] : auditFind(ITEM, itemFields)
    const when = now ? Number(ec.user.nowTimestamp) : at
    const statusId = now ? order.statusId : valueAt(headerLogs, "statusId", null, when, order.statusId)
    if (!now) {
        const createdLog = headerLogs.find(row => row.changedFieldName === "statusId" && row.oldValueText == null)
        if ((createdLog && ms(createdLog.changedDate) > when) || ms(order.entryDate) > when)
            denied("ORDER_NOT_YET", "Purchase order " + order.orderId + " was not entered yet at that time")
    }
    const revision = Number(
        now ? (order.orderRevision ?? 1) : valueAt(headerLogs, "orderRevision", null, when, order.orderRevision ?? 1)
    )
    const lines = []
    for (const item of rows(ITEM, {orderId: order.orderId}).sort((a, b) =>
        String(a.orderItemSeqId).localeCompare(String(b.orderItemSeqId))
    )) {
        if (item.parentItemSeqId) continue
        const created = now ? null : createdAt(itemLogs, item.orderItemSeqId)
        if (created != null && created > when) continue
        const at = field => (now ? item[field] : valueAt(itemLogs, field, item.orderItemSeqId, when, item[field]))
        lines.push({
            orderItemSeqId: item.orderItemSeqId,
            productId: at("productId"),
            itemDescription: at("itemDescription"),
            quantity: decimalOf(at("quantity")) ?? toDecimal(0),
            unitAmount: decimalOf(at("unitAmount")) ?? toDecimal(0),
            quantityUomId: at("quantityUomId"),
            quantityCancelled: decimalOf(at("quantityCancelled")),
            requiredByDate: at("requiredByDate")
        })
    }
    // the revision's time: when the counter last moved to it before the time, else the order's entry
    const revisionLog = auditFind(ORDER, ["orderRevision"])
        .filter(row => ms(row.changedDate) <= when && Number(row.newValueText) === revision)
        .at(-1)
    // P9: the part as of the time (its key fields read back), and the order's currency
    const part = Object.fromEntries(
        partFields.map(field => [
            field,
            now ? po.part[field] : valueAt(partLogs, field, po.part.orderPartSeqId, when, po.part[field])
        ])
    )
    const currencyUomId = now ? order.currencyUomId : valueAt(headerLogs, "currencyUomId", null, when, order.currencyUomId)
    return {statusId, revision, revisionDate: revisionLog ? revisionLog.changedDate : order.entryDate, lines, part, currencyUomId}
}

// The print of a purchase order (as of a time, or now): its HTML, the revision and a hash of the print.
function printOf(po, at) {
    const order = po.order
    const state = orderAt(po, at)
    const currencyUomId = state.currencyUomId || order.currencyUomId
    const productNames = {}
    for (const line of state.lines)
        if (line.productId && !productNames[line.productId]) {
            const product = one("mantle.product.Product", {productId: line.productId})
            productNames[line.productId] = product
                ? [product.pseudoId || product.productId, product.productName].filter(Boolean).join(" · ")
                : line.productId
        }
    let total = toDecimal(0)
    const lines = state.lines.map(line => {
        const amount = ec.l10n.roundCurrency(line.quantity.multiply(line.unitAmount), currencyUomId)
        total = total.add(amount)
        return {
            seq: line.orderItemSeqId,
            productText: line.productId ? productNames[line.productId] : line.itemDescription || "",
            description:
                line.productId && line.itemDescription !== productNames[line.productId] ? line.itemDescription || "" : "",
            quantityText: quantityText(line.quantity),
            unitText: uomText(line.quantityUomId),
            priceText: ec.l10n.formatCurrency(line.unitAmount, currencyUomId),
            amountText: ec.l10n.formatCurrency(amount, currencyUomId),
            requiredText: line.requiredByDate ? lib.dateText(line.requiredByDate) : "",
            cancelledText: line.quantityCancelled && !line.quantityCancelled.isZero() ? quantityText(line.quantityCancelled) : ""
        }
    })
    const facility = state.part.facilityId ? one("mantle.facility.Facility", {facilityId: state.part.facilityId}) : null
    // P7: a drop-ship order shows the customer's ship-to in place of a receiving facility (P9: its address as of the time)
    const dropShipTo = ec.resource.script("component://mr-mantle/service/mantle/order/DropShip.js").shipToOf({
        order,
        orderId: po.orderId,
        part: {orderPartSeqId: po.part.orderPartSeqId, postalContactMechId: state.part.postalContactMechId}
    })
    // P9: any other order's ship-to address as of the time
    const shipTo =
        !dropShipTo && state.part.postalContactMechId
            ? one("mantle.party.contact.PostalAddress", {contactMechId: state.part.postalContactMechId})
            : null
    const term = state.part.settlementTermId
        ? one("mantle.account.invoice.SettlementTerm", {settlementTermId: state.part.settlementTermId})
        : null
    const incoterm = state.part.tradeTermEnumId ? one("moqui.basic.Enumeration", {enumId: state.part.tradeTermEnumId}) : null
    // P9: what this revision changed, from the audit log (none for the first)
    const changeRows = state.revision > 1 ? revisions().revisionChanges(order.orderId, state.revision, true) : []
    const revisionText = "Revision " + state.revision + (state.revisionDate ? " of " + lib.dateText(state.revisionDate) : "")
    const printHtml = ec.resource.template("component://mr-mantle/template/order/PurchaseOrder.print.html.fancy", {
        orderId: order.orderId,
        orderName: order.orderName || "",
        organizationName: partyName(po.organizationPartyId),
        supplierName: partyName(state.part.vendorPartyId || po.supplierPartyId),
        supplierReference: state.part.otherPartyOrderId || "",
        deliveryText: state.part.estimatedDeliveryDate ? lib.dateText(state.part.estimatedDeliveryDate) : "",
        shipToText: shipTo
            ? [shipTo.toName, shipTo.address1, shipTo.address2, [shipTo.city, shipTo.postalCode].filter(Boolean).join(" ")]
                  .filter(Boolean)
                  .join(", ")
            : "",
        termText: term ? term.description || term.settlementTermId : "",
        incotermText: incoterm ? incoterm.description || incoterm.enumId : "",
        changeRows,
        revisionText,
        asOfText: at == null ? "" : lib.dateText(at),
        statusText: statusText(state.statusId),
        placedText: order.placedDate && (at == null || ms(order.placedDate) <= at) ? lib.dateText(order.placedDate) : "",
        facilityName: facility && !dropShipTo ? facility.facilityName || facility.facilityId : "",
        dropShipText: dropShipTo ? [dropShipTo.shipToName, dropShipTo.shipToAddress].filter(Boolean).join(", ") : "",
        currencyText: currencyUomId || "",
        totalText: ec.l10n.formatCurrency(ec.l10n.roundCurrency(total, currencyUomId), currencyUomId),
        lines
    })
    return {
        printHtml,
        orderRevision: state.revision,
        revisionDate: state.revisionDate,
        statusId: state.statusId,
        contentHash: ec.user.singleUseCodeHash(printHtml),
        fileName: "PurchaseOrder-" + order.orderId + "-r" + state.revision + ".pdf"
    }
}
// get#PurchaseOrderPrint: the print as of a time (now when empty) for a purchasing reader of the organization.
function print(p) {
    orders.requirePermission(...readPermissions)
    const po = orders.purchaseOrder(p.orderId)
    const at = blank(p.asOfDate) ? null : ms(p.asOfDate)
    if (at != null && !Number.isFinite(at)) denied("DATE_INVALID", "Choose a valid date and time")
    if (at != null && at > Number(ec.user.nowTimestamp)) denied("DATE_INVALID", "Choose a time that has passed")
    const printed = printOf(po, at)
    return Object.assign({orderId: po.orderId, asOfText: at == null ? "" : lib.dateText(at)}, printed)
}

// ===== the send =====
// The supplier's order addresses (EmailOrder) in effect, else its primary ones, lower case.
function recipientsOf(partyId) {
    for (const purpose of ["EmailOrder", "EmailPrimary"]) {
        const ids = rows("mantle.party.contact.PartyContactMech", {partyId, contactMechPurposeId: purpose})
            .filter(row => lib.active(row))
            .map(row => row.contactMechId)
        if (!ids.length) continue
        const addresses = Array.from(
            find("mantle.party.contact.ContactMech")
                .condition("contactMechId", "in", ids)
                .condition("contactMechTypeEnumId", "CmtEmailAddress")
                .list()
        )
            .map(row => String(row.infoString || "").toLowerCase())
            .filter(Boolean)
        if (addresses.length) return Array.from(new Set(addresses))
    }
    return []
}
// The addresses a revision was already sent to: the order's email messages of that revision that went or are queued.
function sentTo(orderId, revision) {
    const ids = rows("mantle.order.OrderEmailMessage", {orderId})
        .filter(row => Number(row.orderRevision) === revision)
        .map(row => row.emailMessageId)
    if (!ids.length) return new Set()
    return new Set(
        Array.from(
            find("moqui.basic.email.EmailMessage")
                .condition("emailMessageId", "in", ids)
                .condition("statusId", "in", ["ES_SENT", "ES_READY", "ES_SCHEDULED"])
                .list()
        ).flatMap(row =>
            String(row.toAddresses || "")
                .split(/[,;\s]+/)
                .map(address => address.trim().toLowerCase())
                .filter(Boolean)
        )
    )
}
// send#PurchaseOrder: an approved (or sent) order's current revision to its supplier.
function send(p) {
    orders.requirePermission("PURCHASE_ORDER_EDIT")
    return sendOf(orders.purchaseOrder(p.orderId, true), p)
}
// P7: an approved drop-ship purchase order sent once its approval commits (DropShip.js send), as the approver or the sales
// order's approver, neither of whom need be a buyer of the organization: the send without the user's checks.
function issue(orderId, p) {
    const order = find(ORDER, {orderId}).forUpdate(true).one()
    const part = order ? rows("mantle.order.OrderPart", {orderId}).find(orders.isPurchasePart) : null
    if (!part) denied("NOT_PURCHASE", "Order " + orderId + " is not a purchase order")
    const po = {
        order,
        part,
        orderId: String(orderId),
        orderPartSeqId: part.orderPartSeqId,
        organizationPartyId: part.customerPartyId,
        supplierPartyId: part.vendorPartyId
    }
    return sendOf(po, p)
}
function sendOf(po, p) {
    const order = po.order
    const revision = Number(order.orderRevision ?? 1)
    const recipientList = blank(p.toAddresses)
        ? recipientsOf(po.supplierPartyId)
        : Array.from(
              new Set(
                  String(p.toAddresses)
                      .split(/[,;\n]+/)
                      .map(address => address.trim().toLowerCase())
                      .filter(Boolean)
              )
          )
    if (!recipientList.length)
        denied("RECIPIENT_REQUIRED", partyName(po.supplierPartyId) + " has no order or primary email address; give one")
    if (recipientList.length > 20) denied("RECIPIENT_LIMIT", "Send to at most 20 recipients at once")
    // the request as asked (the revision reviewed, not the current one), and its replay before the state checks: a retry
    // of a send that went through answers its result though the send moved the order to Sent (or, without the commercial
    // revision, its revision on)
    const request = {
        orderId: po.orderId,
        orderRevision: blank(p.orderRevision) ? null : Number(p.orderRevision),
        recipients: recipientList,
        note: p.note || null
    }
    const operation = lib.operation(p, "PurchaseOrderSend", po.organizationPartyId, request)
    if (operation.old) return lib.previous(operation)
    if (!sendStatuses.includes(order.statusId))
        denied("ORDER_SEND_STATE", "Purchase order " + po.orderId + " is sent once it is approved")
    if (!blank(p.orderRevision) && Number(p.orderRevision) !== revision)
        denied("STALE_REVISION", "Purchase order " + po.orderId + " is at revision " + revision + "; review it again")

    // the issued PDF: one for each print of the order, kept as its content
    const printed = printOf(po, null)
    const issueKey = printed.contentHash.replace(/[^A-Za-z0-9]/g, "").slice(0, 24)
    const pdfLocation = "dbresource://mantle/content/order-issued/" + po.orderId + "/" + issueKey + "/" + printed.fileName
    const pdfBytes = ec.resource.xslFoTransform(printed.printHtml, null, null, "application/pdf")
    const issued = rows("mantle.order.OrderContent", {orderId: po.orderId}).find(row => row.contentLocation === pdfLocation)
    let orderContentId = issued?.orderContentId
    if (!orderContentId) {
        ec.resource.getLocationReference(pdfLocation).putBytes(pdfBytes)
        orderContentId = call("create#mantle.order.OrderContent", {
            orderId: po.orderId,
            orderContentTypeEnumId: "OctPurchaseOrderIssued",
            contentLocation: pdfLocation,
            contentDate: ec.user.nowTimestamp,
            userId: ec.user.userId,
            description: "Purchase order " + po.orderId + " revision " + revision + " as sent"
        }).orderContentId
    }

    const fromName = partyName(po.organizationPartyId)
    const from = recipientsOfOrganization(po.organizationPartyId)
    const emailParameters = {
        orderId: po.orderId,
        subject: p.subject || "Purchase order " + po.orderId + " from " + fromName,
        fromAddress: from,
        fromName
    }
    // P16: the order's link for this revision (OrderAcknowledgement, with BillUpload beside it), when the organization has a
    // Supplier site (SupplierPortal.js)
    const linkUrl = ec.resource
        .script("component://mr-mantle/service/mantle/order/SupplierPortal.js")
        .orderLink(po.orderId, revision)
    const body = ec.resource.template("component://mr-mantle/template/order/PurchaseOrderEmail.html.fancy", {
        note: p.note || null,
        printHtml: printed.printHtml,
        linkUrl
    })
    const already = sentTo(po.orderId, revision)
    const recipientResults = []
    for (const recipient of recipientList) {
        if (!/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(recipient)) {
            recipientResults.push({recipient, status: "failed", reasonCode: "RECIPIENT_INVALID"})
            continue
        }
        if (already.has(recipient)) {
            recipientResults.push({recipient, status: "skipped", reasonCode: "ALREADY_SENT"})
            continue
        }
        // each address its own message, in its own transaction: one that fails is named and the others go out
        let emailMessageId = null
        ec.message.pushErrors()
        try {
            const out =
                ec.service
                    .sync()
                    .name("org.moqui.impl.EmailServices.send#EmailTemplate")
                    .parameters({
                        emailTemplateId: p.emailTemplateId || "MANTLE_PURCHASE_ORDER_EMAIL",
                        toAddresses: recipient,
                        bodyParameters: emailParameters,
                        body,
                        attachments: [{fileName: printed.fileName, contentType: "application/pdf", contentBytes: pdfBytes}]
                    })
                    .requireNewTransaction(true)
                    .disableAuthz()
                    .call() || {}
            if (!ec.message.hasError()) emailMessageId = out.emailMessageId || null
        } catch (error) {
            ec.logger.error("Purchase order " + po.orderId + " to " + recipient + " was not sent: " + error.message)
        } finally {
            ec.message.clearErrors()
            ec.message.popErrors()
        }
        const message = emailMessageId ? one("moqui.basic.email.EmailMessage", {emailMessageId}) : null
        if (message)
            call("create#mantle.order.OrderEmailMessage", {
                orderId: po.orderId,
                emailMessageId,
                orderRevision: revision,
                partyId: po.supplierPartyId,
                roleTypeId: "Supplier"
            })
        const status =
            message?.statusId === "ES_SENT"
                ? "sent"
                : ["ES_READY", "ES_SCHEDULED"].includes(message?.statusId)
                  ? "queued"
                  : "failed"
        recipientResults.push({
            recipient,
            emailMessageId: message ? emailMessageId : null,
            status,
            reasonCode: status === "failed" ? "DELIVERY_FAILED" : status.toUpperCase()
        })
    }
    const successCount = recipientResults.filter(row => row.status === "sent" || row.status === "queued").length
    const failureCount = recipientResults.filter(row => row.status === "failed").length
    // an approved order whose revision went out (now, or before a hold it came back from) is Sent
    const alreadySent = recipientResults.some(row => row.reasonCode === "ALREADY_SENT")
    if ((successCount || alreadySent) && order.statusId === "OrderApproved")
        call("mantle.order.OrderServices.update#OrderStatus", {
            orderId: po.orderId,
            orderPartSeqId: po.orderPartSeqId,
            statusId: "OrderSent"
        })
    const result = {
        orderId: po.orderId,
        orderRevision: revision,
        orderContentId,
        contentHash: printed.contentHash,
        recipientResults,
        successCount,
        failureCount,
        statusId: one(ORDER, {orderId: po.orderId}).statusId
    }
    lib.complete(operation, "mantle.order.OrderContent", orderContentId, result)
    return Object.assign(result, {alreadyApplied: false})
}
// The buying organization's order address, else its primary one (the sender), or null.
function recipientsOfOrganization(organizationPartyId) {
    return recipientsOf(organizationPartyId)[0] || null
}

const operations = {print, send}
;({
    issue,
    // P9: the reminders' recipients (PurchaseRevisions.js), as the send's
    recipientsOf,
    execute: (op, parameters) => {
        if (!operations[op]) throw new Error("Unknown purchase order document operation " + op)
        return operations[op](parameters)
    }
})
