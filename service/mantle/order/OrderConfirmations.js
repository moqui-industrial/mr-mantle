// A sales order's confirmation as placed (design-customer-service §4 OrderDetail; impl-customer-service §2, §4, P3, F29,
// F55; OrderConfirmationServices.xml). Sales orders have no commercial revision (F55), so the version a customer was sent is
// the order as placed: its lines read back from the audit log as of the placed time (product, quantity and unit price are
// audit-logged on create and update), rendered to a PDF and stored once as the order's OrderContent of type
// OctOrderConfirmation: at placement for an organization with orderConfirmationOnPlace (off by default), else by the first
// store or resend, rendered as of the order's placed time; and
// every later resend attaches the stored PDF, never a new render. A resend goes to a checked recipient (an email of the
// order's customer or of a current contact or employee of it) as a mail client draft of an account the user may send from,
// through send#EmailDraft, filed on the order, and is recorded as an OrderEmailMessage naming the recipient's party and the
// stored content it sent; the message keeps the address and its result. The same operation key answers the first result.
// Each service checks SUPPORT_CASE_EDIT or ORDER_APPROVE and the order's selling organization (get#PartyOrganizationInfo).
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const facilityScope = ec.resource.script("component://mr-mantle/service/mantle/facility/FacilityScope.js")
const {find, one, rows, call, denied, access, ms} = lib

const ORDER = "mantle.order.OrderHeader",
    PART = "mantle.order.OrderPart",
    ITEM = "mantle.order.OrderItem",
    CONTENT = "mantle.order.OrderContent",
    EMAIL = "mantle.order.OrderEmailMessage"
const contentType = "OctOrderConfirmation"
const permissions = ["SUPPORT_CASE_EDIT", "ORDER_APPROVE"]
// who reads the print's prices and total (§2: an amount the user may not read is not in the answer)
const amountPermissions = ["PRICE_VIEW", "ACCOUNTING_VIEW", "ORDER_APPROVE"]
const contactRelationships = ["PrtContact", "PrtEmployee", "PrtRepresentative"]
const emailPattern = /^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/

const blank = value => value == null || String(value).trim() === ""
const partyName = partyId => (partyId ? lib.partyNames([partyId])[partyId] || partyId : "")
const isInternal = partyId => !!partyId && !!one("mantle.party.PartyRole", {partyId, roleTypeId: "OrgInternal"})
const quantityText = value => (value == null ? "" : ec.l10n.format(toDecimal(value), "#,##0.###"))
const escapeHtml = text =>
    String(text ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")

function requirePermission() {
    if (!permissions.some(permission => access.has(permission)))
        denied("PERMISSION_DENIED", permissions.join(" or ") + " is required")
}
// A sales order of one of the user's organizations: every part sold by an internal organization to an outside party. A
// missing order, a purchase order and another organization's are refused alike (RECORD_UNAVAILABLE).
function salesOrder(orderId, lock = false, scoped = true) {
    const unavailable = () => denied("RECORD_UNAVAILABLE", "Order " + (orderId || "") + " is not available")
    if (blank(orderId)) unavailable()
    const order = lock ? find(ORDER, {orderId}).forUpdate(true).one() : one(ORDER, {orderId})
    const parts = order ? rows(PART, {orderId}) : []
    if (!parts.length || !parts.every(part => isInternal(part.vendorPartyId) && !isInternal(part.customerPartyId))) unavailable()
    const organizationPartyId = parts[0].vendorPartyId
    if (scoped) {
        const userScope = facilityScope.scope()
        if (!parts.every(part => facilityScope.owns(userScope, part.vendorPartyId))) unavailable()
    }
    const customerPartyIds = Array.from(new Set(parts.map(part => part.customerPartyId).filter(Boolean)))
    return {order, parts, orderId: String(orderId), organizationPartyId, customerPartyIds, scoped}
}

// ===== the order as placed =====
// A field's value at a time: the new value of its last logged change at or before the time (a field logged on create has
// one from the line's create), else the old value of its first change after the time, else the value now.
function valueAt(logs, field, secondary, at, current) {
    const ofField = logs.filter(row => row.changedFieldName === field && row.pkSecondaryValue === secondary)
    const before = ofField.filter(row => ms(row.changedDate) <= at).pop()
    if (before) return before.newValueText
    const change = ofField.find(row => ms(row.changedDate) > at)
    return change ? change.oldValueText : current
}
// The order's lines as they were when it was placed: a line logged as created after the placed time is left out, and each
// logged field takes its value then. A deleted line is not in the audit log, so an order whose lines may have been deleted
// since it was placed is refused (ORDER_CHANGED_SINCE_PLACED) rather than printed without them: a store order with a line
// created after placement (Mantle's handle#OrderMajorChange deletes and recreates a placed store order's promotion,
// shipping and tax lines on any change), or a line number created again after placement.
function linesAsPlaced(so) {
    const placedAt = ms(so.order.placedDate)
    const fields = ["productId", "quantity", "unitAmount", "requiredByDate"]
    const logs = Array.from(
        find("moqui.entity.EntityAuditLog")
            .condition("changedEntityName", ITEM)
            .condition("pkPrimaryValue", so.orderId)
            .condition("changedFieldName", "in", fields)
            .orderBy("changedDate")
            .list()
    )
    const creates = logs.filter(row => row.changedFieldName === "quantity" && row.oldValueText == null)
    const createdAfter = creates.filter(row => ms(row.changedDate) > placedAt)
    if (
        createdAfter.length &&
        (so.order.productStoreId ||
            createdAfter.some(late => creates.some(row => row.pkSecondaryValue === late.pkSecondaryValue && row !== late)))
    )
        denied(
            "ORDER_CHANGED_SINCE_PLACED",
            "Order " + so.orderId + "'s lines were changed after it was placed, so its confirmation as placed cannot be rebuilt"
        )
    const lines = []
    for (const item of rows(ITEM, {orderId: so.orderId}).sort((a, b) =>
        String(a.orderItemSeqId).localeCompare(String(b.orderItemSeqId))
    )) {
        if (createdAfter.some(row => row.pkSecondaryValue === item.orderItemSeqId)) continue
        const at = field => valueAt(logs, field, item.orderItemSeqId, placedAt, item[field])
        const decimal = value => (value == null || value === "" ? toDecimal(0) : toDecimal(value))
        lines.push({
            orderItemSeqId: item.orderItemSeqId,
            productId: at("productId"),
            itemDescription: item.itemDescription || "",
            quantity: decimal(at("quantity")),
            unitAmount: decimal(at("unitAmount")),
            quantityUomId: item.quantityUomId,
            requiredByDate: at("requiredByDate")
        })
    }
    return lines
}
// The confirmation's print: the order as placed, its HTML, a hash of it and the file name.
function printOf(so) {
    if (!so.order.placedDate) denied("ORDER_NOT_PLACED", "Order " + so.orderId + " has not been placed")
    const currencyUomId = so.order.currencyUomId
    let total = toDecimal(0)
    const lines = linesAsPlaced(so).map(line => {
        const product = line.productId ? one("mantle.product.Product", {productId: line.productId}) : null
        const productText = product
            ? [product.pseudoId || product.productId, product.productName].filter(Boolean).join(" · ")
            : line.itemDescription
        const amount = ec.l10n.roundCurrency(line.quantity.multiply(line.unitAmount), currencyUomId)
        total = total.add(amount)
        const uom = line.quantityUomId ? one("moqui.basic.Uom", {uomId: line.quantityUomId}) : null
        return {
            seq: line.orderItemSeqId,
            productText,
            description: product && line.itemDescription !== product.productName ? line.itemDescription : "",
            quantityText: quantityText(line.quantity),
            unitText: uom?.abbreviation || line.quantityUomId || "",
            priceText: ec.l10n.formatCurrency(line.unitAmount, currencyUomId),
            amountText: ec.l10n.formatCurrency(amount, currencyUomId),
            requiredText: line.requiredByDate ? lib.dateText(line.requiredByDate) : ""
        }
    })
    const part = so.parts[0]
    const shipTo = part.postalContactMechId
        ? one("mantle.party.contact.PostalAddress", {contactMechId: part.postalContactMechId})
        : null
    const printHtml = ec.resource.template("component://mr-mantle/template/order/OrderConfirmation.print.html.fancy", {
        orderId: so.orderId,
        orderName: so.order.orderName || "",
        organizationName: partyName(so.organizationPartyId),
        customerName: so.customerPartyIds.map(partyName).join(", "),
        customerReference: part.otherPartyOrderId || "",
        placedText: lib.dateText(so.order.placedDate),
        shipToText: shipTo
            ? [shipTo.toName, shipTo.address1, shipTo.address2, [shipTo.city, shipTo.postalCode].filter(Boolean).join(" ")]
                  .filter(Boolean)
                  .join(", ")
            : "",
        currencyText: currencyUomId || "",
        totalText: ec.l10n.formatCurrency(ec.l10n.roundCurrency(total, currencyUomId), currencyUomId),
        lines
    })
    return {
        printHtml,
        placedDate: so.order.placedDate,
        contentHash: ec.user.singleUseCodeHash(printHtml),
        fileName: "OrderConfirmation-" + so.orderId + ".pdf"
    }
}

// ===== the stored confirmation =====
const storedOf = orderId =>
    rows(CONTENT, {orderId, orderContentTypeEnumId: contentType}).sort((a, b) => ms(a.contentDate) - ms(b.contentDate))[0] || null
// The order's stored confirmation, made once: an order with none is rendered as of its placed time and stored. The render
// (a PDF) runs before the order's lock, which is taken only to check again and store, so a slow render never holds up the
// order's next change (an approval right after placement); a render that loses the race is dropped.
function storeOf(so) {
    const existing = storedOf(so.orderId)
    if (existing) return {content: existing, stored: false}
    const printed = printOf(so)
    const pdf = ec.resource.xslFoTransform(printed.printHtml, null, null, "application/pdf")
    salesOrder(so.orderId, true, so.scoped)
    const again = storedOf(so.orderId)
    if (again) return {content: again, stored: false}
    const key = printed.contentHash.replace(/[^A-Za-z0-9]/g, "").slice(0, 24)
    const location = "dbresource://mantle/content/order-confirmation/" + so.orderId + "/" + key + "/" + printed.fileName
    ec.resource.getLocationReference(location).putBytes(pdf)
    const orderContentId = call("create#" + CONTENT, {
        orderId: so.orderId,
        orderContentTypeEnumId: contentType,
        partyId: so.customerPartyIds[0] || null,
        roleTypeId: so.customerPartyIds.length ? "Customer" : null,
        contentLocation: location,
        contentDate: ec.user.nowTimestamp,
        userId: ec.user.userId,
        description: "Confirmation of order " + so.orderId + " as placed " + lib.dateText(so.order.placedDate)
    }).orderContentId
    return {content: one(CONTENT, {orderContentId}), stored: true}
}
function contentResult(so, stored) {
    return {
        orderId: so.orderId,
        orderContentId: stored.content.orderContentId,
        contentLocation: stored.content.contentLocation,
        stored: stored.stored,
        placedDate: so.order.placedDate
    }
}

// ===== recipients =====
// The addresses a confirmation may go to: the current emails of the order's customers and of their current contacts and
// employees, lower case, each with its party.
function allowedRecipients(customerPartyIds) {
    const partyIds = new Set(customerPartyIds)
    for (const customerPartyId of customerPartyIds)
        for (const row of rows("mantle.party.PartyRelationship", {toPartyId: customerPartyId}))
            if (contactRelationships.includes(row.relationshipTypeEnumId) && lib.active(row)) partyIds.add(row.fromPartyId)
    const allowed = new Map()
    for (const partyId of partyIds) {
        const mechIds = rows("mantle.party.contact.PartyContactMech", {partyId})
            .filter(row => lib.active(row))
            .map(row => row.contactMechId)
        if (!mechIds.length) continue
        for (const mech of find("mantle.party.contact.ContactMech")
            .condition("contactMechId", "in", mechIds)
            .condition("contactMechTypeEnumId", "CmtEmailAddress")
            .list()) {
            const address = String(mech.infoString || "")
                .trim()
                .toLowerCase()
            if (address && !allowed.has(address)) allowed.set(address, partyId)
        }
    }
    return allowed
}
// The account the user sends from: the one named (which they may send from), else their first account of the selling
// organization they may send from, else their first one; none is refused.
function senderAccount(emailAccountId, organizationPartyId) {
    const access = lib.call("org.moqui.impl.EmailClientServices.get#EmailAccountAccess")
    const sendable = Array.from(access.accountList || []).filter(account => account.canSend)
    const account = !blank(emailAccountId)
        ? sendable.find(row => row.emailAccountId === emailAccountId)
        : sendable.find(row => row.ownerPartyId === organizationPartyId) || sendable[0]
    if (!account)
        denied(
            "SEND_ACCOUNT_REQUIRED",
            blank(emailAccountId) ? "You have no mail account to send from" : "You may not send from " + emailAccountId
        )
    return account
}

// ===== services =====
// get#OrderConfirmationPrint: the confirmation as placed, rendered (not stored).
function print(p) {
    requirePermission()
    if (!amountPermissions.some(permission => access.has(permission)))
        denied("PERMISSION_DENIED", amountPermissions.join(" or ") + " is required to read the confirmation's amounts")
    const so = salesOrder(p.orderId)
    return Object.assign({orderId: so.orderId}, printOf(so))
}
// store#OrderConfirmation: the stored confirmation, made once.
function store(p) {
    requirePermission()
    const so = salesOrder(p.orderId)
    return contentResult(so, storeOf(so))
}
// resend#OrderConfirmation: the stored confirmation to a checked recipient.
function resend(p) {
    requirePermission()
    const so = salesOrder(p.orderId)
    const recipient = String(p.toAddress || "")
        .trim()
        .toLowerCase()
    if (!recipient) denied("RECIPIENT_REQUIRED", "Give the address to send the confirmation to")
    const request = {orderId: so.orderId, recipient, emailAccountId: p.emailAccountId || null, note: p.note || null}
    const operation = lib.operation(p, "OrderConfirmationResend", so.organizationPartyId, request)
    if (operation.old) return lib.previous(operation)
    if (!emailPattern.test(recipient)) denied("RECIPIENT_INVALID", recipient + " is not an email address")
    const allowed = allowedRecipients(so.customerPartyIds)
    if (!allowed.has(recipient))
        denied(
            "RECIPIENT_UNCHECKED",
            recipient + " is not an address of " + so.customerPartyIds.map(partyName).join(", ") + " or of its contacts"
        )
    if (!so.order.placedDate) denied("ORDER_NOT_PLACED", "Order " + so.orderId + " has not been placed")
    const account = senderAccount(p.emailAccountId, so.organizationPartyId)
    const stored = storeOf(so)
    const content = stored.content
    const fileName = String(content.contentLocation).substring(String(content.contentLocation).lastIndexOf("/") + 1)
    const organizationName = partyName(so.organizationPartyId)
    const body =
        (p.note ? "<p>" + escapeHtml(p.note).replace(/\n/g, "<br>") + "</p>" : "") +
        "<p>" +
        escapeHtml(
            ec.l10n.localize("Attached is the confirmation of your order") +
                " " +
                so.orderId +
                " " +
                ec.l10n.localize("as placed on") +
                " " +
                lib.dateText(so.order.placedDate) +
                "."
        ) +
        "</p>"
    // the draft in the user's account with the stored PDF (a file of the order, not of the account: authorization off), then
    // the mail client's send, filed on the order once it is sent
    const draft = lib.call("org.moqui.impl.EmailClientServices.save#Draft", {
        emailAccountId: account.emailAccountId,
        toAddresses: recipient,
        subject: p.subject || ec.l10n.localize("Your order") + " " + so.orderId + " · " + organizationName,
        body,
        attachmentList: [{attachmentLocation: content.contentLocation, fileName, contentType: "application/pdf"}]
    })
    const sent = lib.call("mantle.party.CommunicationServices.send#EmailDraft", {
        emailMessageId: draft.emailMessageId,
        recordEntityName: ORDER,
        recordId: so.orderId
    })
    call("create#" + EMAIL, {
        orderId: so.orderId,
        emailMessageId: draft.emailMessageId,
        partyId: allowed.get(recipient),
        roleTypeId: allowed.get(recipient) && so.customerPartyIds.includes(allowed.get(recipient)) ? "Customer" : null,
        orderContentId: content.orderContentId
    })
    const result = Object.assign(contentResult(so, stored), {
        emailMessageId: draft.emailMessageId,
        recipient,
        recipientPartyId: allowed.get(recipient),
        emailAccountId: account.emailAccountId,
        statusId: sent.statusId || null,
        status: sent.sent ? "sent" : sent.sendError ? "failed" : "queued"
    })
    lib.complete(operation, EMAIL, draft.emailMessageId, result)
    return Object.assign(result, {alreadyApplied: false})
}

// store#PlacedOrderConfirmation: at placement (the OrderPlacedStoreConfirmation rule), for an organization that turned
// orderConfirmationOnPlace on; no user checks, never failing.
function storeOnPlace(p) {
    try {
        const order = one(ORDER, {orderId: p.orderId})
        const part = order?.placedDate ? rows(PART, {orderId: p.orderId})[0] : null
        if (!part || !isInternal(part.vendorPartyId) || isInternal(part.customerPartyId)) return {stored: false}
        const preference = one("mantle.ledger.config.PartyAcctgPreference", {organizationPartyId: part.vendorPartyId})
        if (preference?.orderConfirmationOnPlace !== "Y") return {stored: false}
        const out = storeOf(salesOrder(p.orderId, false, false))
        return {orderContentId: out.content.orderContentId, stored: out.stored}
    } catch (error) {
        ec.logger.error("Order " + p.orderId + "'s confirmation was not stored at placement: " + error.message)
        ec.message.clearErrors()
        return {stored: false}
    }
}

// cancel#FailedConfirmationSend: a resend whose send failed is cancelled, not left editable in the shared mailbox's Outbox.
function cancelFailed(p) {
    const sends = find(EMAIL, {emailMessageId: p.emailMessageId}).condition("orderContentId", "is-not-null", null).count()
    if (!sends) return {cancelled: false}
    const message = find("moqui.basic.email.EmailMessage", {emailMessageId: p.emailMessageId}).forUpdate(true).one()
    if (!message || message.statusId !== "ES_READY" || !message.sendError) return {cancelled: false}
    message.set("statusId", "ES_CANCELLED")
    message.update()
    ec.logger.warn("Order confirmation message " + p.emailMessageId + " was not sent and is cancelled: " + message.sendError)
    return {cancelled: true}
}

const operations = {print, store, resend, storeOnPlace, cancelFailed}
;({
    allowedRecipients,
    execute: (op, parameters) => {
        if (!operations[op]) throw new Error("Unknown order confirmation operation " + op)
        return operations[op](parameters)
    }
})
