// Purchasing's supplier pages, the PASS Supplier app's SupplierHome, QuoteResponse and OrderAcknowledgement (design-purchasing
// §13; impl-purchasing P16, §2, §4; CX-PORTALS): what a supplier may read and answer of its own quote orders and purchase
// orders. Every operation first finds the organization the page serves (the supplier mount's target on a published site) and
// checks the capability or the signed-in contact (ExternalAccess.check, check#AccessCapability's rule): a token's record
// within its scope, or a record of an outside party the contact was invited for. It answers allow-listed projections: never
// another supplier, the internal request, a maximum or budget price, a cost, an internal note or a private file. A refusal a
// page shows is a PASS error kind (NotFound, Unprocessable, Conflict, Tarpit, AuthenticationRequired).
// A supplier's answer is a claim for internal review, written through Mantle's own verbs with the supplier's claim on that one
// order (PurchaseOrders.js asSupplier): a quote response through store#SupplierQuoteItem and store#SupplierQuote, which move
// the quote to OrderProposed (its tiers become prices only when a buyer publishes them, P11); an acknowledgement through
// record#Acknowledgement (P9), which changes no quantity or price; a drop-ship delivery as a report for the buyer to confirm
// (P7's finalize stays the buyer's). Each is told to the organization's buyers (PurchaseSupplierResponse), and a repeat
// answers its receipt (SupplierPortalResponse). Files are staged and scanned as a bill is (Portal.js stage) and kept as the
// order's content in the supplier's role.
// The links: send#QuoteRequest and send#PurchaseOrder mail the quote's (QuoteResponse) and the revision's (OrderAcknowledgement
// with BillUpload) capability, the page on the organization's first published site with the Supplier app (quoteLink,
// orderLink). A purchase order's link names its revision: once the order is revised, its acknowledgement answers
// SupersededRevision; a cancel, a decline and a quote leaving the quote statuses (an award, close#QuoteRequest's Not awarded)
// revoke the links (revoke#OrderCapabilities, the SupplierPortalRevoke EECA; revoke#QuoteCapabilities for P12).
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const access = ec.resource.script("component://mr-mantle/service/mantle/party/ExternalAccess.js")
const apps = ec.resource.script("component://mr-mantle/service/mantle/public/PublicApps.js")
const orders = ec.resource.script("component://mr-mantle/service/mantle/order/PurchaseOrders.js")
const sourcing = () => ec.resource.script("component://mr-mantle/service/mantle/order/Sourcing.js")
const revisions = () => ec.resource.script("component://mr-mantle/service/mantle/order/PurchaseRevisions.js")
const documents = () => ec.resource.script("component://mr-mantle/service/mantle/order/PurchaseOrderDocuments.js")
const dropShip = () => ec.resource.script("component://mr-mantle/service/mantle/order/DropShip.js")
const receipts = () => ec.resource.script("component://mr-mantle/service/mantle/order/PurchaseReceipts.js")
const portal = () => ec.resource.script("component://mr-mantle/service/mantle/account/Portal.js")
const {find, one, rows, call, ms, dateText} = lib

const ORDER = "mantle.order.OrderHeader",
    PART = "mantle.order.OrderPart",
    ITEM = "mantle.order.OrderItem",
    RESPONSE = "mantle.order.SupplierPortalResponse",
    TOPIC = "PurchaseSupplierResponse"
const quoteStatuses = ["OrderRequested", "OrderProposed"]
const acknowledgeStatuses = ["OrderApproved", "OrderSent", "OrderProcessing", "OrderHold"]
const orderListStatuses = ["OrderApproved", "OrderSent", "OrderProcessing", "OrderHold", "OrderCompleted"]
const deliveryStatuses = ["OrderApproved", "OrderSent", "OrderProcessing"]
const outcomes = {accept: "PakAccepted", change: "PakChanged", reject: "PakRejected"}
const outcomeTexts = {PakAccepted: "Accepted", PakChanged: "Accepted with changes", PakRejected: "Rejected"}
// a link's life: a quote's to its response date and a month past it, a purchase order's a year (bills come late)
const QUOTE_LINK_DAYS = 60,
    ORDER_LINK_DAYS = 366
// the posts one requester may make in ten minutes (PASS's throttling of the Supplier app's writes)
const POST_LIMIT = 60

const fail = (kind, message) => {
    const error = new Error(message)
    error.moquiErrorKind = kind
    throw error
}
const unavailable = () => fail("NotFound", "This page is not available")
const blank = value => value == null || String(value).trim() === ""
// A service's parameters without the ones not given: Mantle's store verbs set a field that is passed, even as null.
const given = values => Object.fromEntries(Object.entries(values).filter(([, value]) => value != null))
const text = value => (blank(value) ? null : String(value).trim())
const dec = value => toDecimal(value == null || value === "" ? 0 : value)
const partyName = partyId => {
    const org = partyId && one("mantle.party.Organization", {partyId})
    if (org) return org.organizationName || partyId
    const person = partyId && one("mantle.party.Person", {partyId})
    return person ? [person.firstName, person.lastName].filter(Boolean).join(" ") : ""
}
const day = value => (value == null || value === "" ? null : dateText(value).slice(0, 10))
const dayValue = value => (value == null || value === "" ? null : ec.l10n.format(new Date(ms(value)), "yyyy-MM-dd"))
const quantityText = value => (value == null ? "" : ec.l10n.format(dec(value), "#,##0.###"))
const moneyText = (value, currencyUomId) =>
    value == null ? null : ec.l10n.formatCurrency(lib.money(value, currencyUomId), currencyUomId)
const uomText = uomId => (uomId ? one("moqui.basic.Uom", {uomId})?.abbreviation || uomId : "")
const enumText = enumId => (enumId ? one("moqui.basic.Enumeration", {enumId})?.description || enumId : null)
function productText(item) {
    if (!item.productId) return item.itemDescription || ""
    const product = one("mantle.product.Product", {productId: item.productId})
    return product ? [product.pseudoId || product.productId, product.productName].filter(Boolean).join(" · ") : item.productId
}
// The order's lines of the supplier's part (a purchase order or quote has one part; another part's lines are never shown).
function linesOf(orderId, orderPartSeqId) {
    return rows(ITEM, {orderId})
        .filter(
            item =>
                (!orderPartSeqId || !item.orderPartSeqId || item.orderPartSeqId === orderPartSeqId) &&
                !item.parentItemSeqId &&
                item.itemTypeEnumId !== "ItemShipping" &&
                !String(item.itemTypeEnumId).includes("Tax")
        )
        .sort((a, b) => String(a.orderItemSeqId).localeCompare(String(b.orderItemSeqId)))
}
// What a page sends as a list (a JSON text over a form or a remote multipart request, or the list itself).
function listOf(value) {
    if (value == null || value === "") return []
    if (Array.isArray(value)) return value
    if (typeof value === "string") {
        const parsed = lib.json(value, null)
        if (!Array.isArray(parsed)) fail("Unprocessable", "Reload the page and try again")
        return parsed
    }
    return Array.from(value)
}
function dateOf(value, label) {
    if (blank(value)) return null
    const millis = ms(value)
    if (millis == null || !Number.isFinite(Number(millis))) fail("Unprocessable", "Enter " + label + " as a date")
    return new Date(Number(millis))
}
function operationId(p) {
    const value = String(p.operationId || "")
    if (!/^[A-Za-z0-9_-]{8,40}$/.test(value)) fail("Unprocessable", "Reload the page and try again")
    return value
}
// The reason a Mantle verb refused, as a page shows it: a stale or superseded revision is a Conflict, anything else of the
// supplier's own making Unprocessable with Mantle's message; an unexpected failure stays as it is.
function refused(error) {
    if (error?.moquiErrorKind) throw error
    // a refusal through a service call reaches here as its message, "Error: " before the code
    const first = String(error?.message || "")
        .split("\n")[0]
        .replace(/^(Error: )+/, "")
    const code = error?.reason || /^([A-Z][A-Z0-9_]+): /.exec(first)?.[1]
    if (!code) throw error
    ec.message.clearErrors()
    const message = first.replace(/^[A-Z][A-Z0-9_]+: /, "")
    if (["SUPERSEDED_REVISION", "STALE_REVISION", "QUOTE_CLOSED", "ORDER_NOT_SENT"].includes(code)) fail("Conflict", message)
    if (["RECORD_UNAVAILABLE", "NOT_PURCHASE", "PERMISSION_DENIED"].includes(code)) unavailable()
    fail("Unprocessable", message)
}

// ===== the organization, the capability and the throttle =====
// The organization the Supplier app of a published site serves.
function served(siteId) {
    const site = siteId && one("mantle.public.PublicSite", {siteId})
    if (!site || site.state !== "published") unavailable()
    const mount = apps.mount(siteId, "supplier")
    if (!mount?.targetId) unavailable()
    return mount.targetId
}
// A requested quote is the supplier's once the buyer published it to the supplier: its RFQ mailed to it, or a link made
// for it (the send makes one; a buyer may share one); before that it is the buyer's draft, which a signed-in contact does
// not see.
const quoteSent = order =>
    order.statusId !== "OrderRequested" ||
    sourcing().sentAtOf(order.orderId) != null ||
    rows("mantle.party.ExternalAccessCapability", {recordType: "Quote", recordId: order.orderId}).length > 0
function checkQuote(p) {
    const organizationPartyId = served(p.siteId)
    const checked = access.check({
        token: p.token,
        scope: "QuoteResponse",
        recordType: "Quote",
        recordId: p.orderId,
        organizationPartyId
    })
    if (checked.via === "contact" && !quoteSent(one(ORDER, {orderId: checked.recordId}))) unavailable()
    return checked
}
function checkOrder(p) {
    const organizationPartyId = served(p.siteId)
    return access.check({
        token: p.token,
        scope: "OrderAcknowledgement",
        recordType: "Order",
        recordId: p.orderId,
        organizationPartyId
    })
}
// A post counts against its requester's limit first (the framework's sign-in limits, as a token lookup does).
function throttle() {
    const key = ec.resource.script("component://framework/service/org/moqui/public/Account.js").requesterKey()
    const allowed = ec.service
        .sync()
        .throwOnError(true)
        .name("org.moqui.public.AccountServices.record#Attempt")
        .parameters({input: {key: "supplier-post:" + key, limit: POST_LIMIT, windowMillis: 600000}})
        .requireNewTransaction(true)
        .call().result.allowed
    if (!allowed) fail("Tarpit", "Too many attempts. Wait a few minutes and try again.")
}
// A purchase order's link of an earlier revision: its page says the order was revised and shows nothing of the new one.
function requireCurrent(checked, order) {
    const revision = Number(order.orderRevision ?? 1)
    if (checked.recordRevision != null && Number(checked.recordRevision) < revision)
        fail(
            "Conflict",
            "SupersededRevision: this link is for revision " +
                checked.recordRevision +
                " of order " +
                order.orderId +
                ", which has since been revised. Open the link in the buyer's latest email."
        )
    return revision
}
const claimOf = checked => ({
    orderId: checked.recordId,
    organizationPartyId: checked.organizationPartyId,
    supplierPartyId: checked.partyId
})
const responder = checked => ({
    capabilityId: checked.capabilityId || null,
    contactPartyId: checked.via === "contact" ? ec.user.userAccount?.partyId || null : null
})

// ===== receipts and the buyers' notice =====
function receiptOf(row) {
    return Object.assign(lib.json(row.resultJson, {}), {responseId: row.responseId})
}
// The receipt of an operation already made, or of the revision already answered (a repeat answers it).
function earlierReceipt(orderId, kind, key, revision) {
    const byKey = rows(RESPONSE, {orderId, responseKind: kind, operationId: key}).find(row => row.state === "submitted")
    if (byKey) return byKey
    if (revision == null) return null
    return (
        rows(RESPONSE, {orderId, responseKind: kind, state: "submitted"}).find(
            row => Number(row.recordRevision) === Number(revision)
        ) || null
    )
}
function keepReceipt(checked, kind, key, revision, data, receipt, late = false) {
    const created = call("create#" + RESPONSE, {
        orderId: checked.recordId,
        responseKind: kind,
        recordRevision: revision,
        state: "submitted",
        operationId: key,
        ...responder(checked),
        supplierPartyId: checked.partyId,
        organizationPartyId: checked.organizationPartyId,
        late: late ? "Y" : "N",
        dataJson: JSON.stringify(data),
        resultJson: JSON.stringify(receipt),
        savedDate: ec.user.nowTimestamp,
        submittedDate: ec.user.nowTimestamp
    })
    return Object.assign({}, receipt, {responseId: created.responseId})
}
// The organization's buyers told of the response, a claim to review; a failure is logged and the response stands.
function tellBuyers(checked, kind, kindText, detailText) {
    try {
        const userIds = receipts().buyersOf(checked.organizationPartyId)
        if (!userIds.length) return 0
        ec.makeNotificationMessage()
            .topic(TOPIC)
            .message({
                orderId: checked.recordId,
                responseKind: kind,
                kindText,
                supplierName: partyName(checked.partyId),
                organizationPartyId: checked.organizationPartyId,
                detailText: detailText ? " (" + detailText + ")" : ""
            })
            .record(ORDER, checked.recordId)
            .userIds(userIds)
            .send()
        return userIds.length
    } catch (error) {
        ec.message.clearErrors()
        ec.logger.error("Supplier response on order " + checked.recordId + " was not told to the buyers: " + error.message)
        return 0
    }
}
// A staged file kept as the order's content in the supplier's role, its write uncounted in the order's revision (a
// supplier's file is no change of the order).
function keepFile(orderId, staged, contentTypeEnumId, supplierPartyId, description, orderContentId = null) {
    if (!staged) return orderContentId
    return revisions().uncounted(orderId, () => {
        const id =
            orderContentId ||
            call("create#mantle.order.OrderContent", {
                orderId,
                orderContentTypeEnumId: contentTypeEnumId,
                partyId: supplierPartyId,
                roleTypeId: "Supplier",
                contentDate: ec.user.nowTimestamp,
                description
            }).orderContentId
        const root = ec.user.getPreference("mantle.content.large.root") || "dbresource://mantle/content"
        const location = root + "/order/" + orderId + "/content_" + id + "/" + staged.filename
        const stream = ec.resource.getLocationReference(staged.location).openStream()
        try {
            ec.resource.getLocationReference(location).putStream(stream)
        } finally {
            stream.close()
        }
        call("update#mantle.order.OrderContent", {orderContentId: id, contentLocation: location})
        return id
    })
}
function unstage(staged) {
    if (!staged) return
    try {
        ec.resource.getLocationReference(staged.location).delete()
    } catch (error) {
        ec.logger.warn("Staged supplier file " + staged.location + " was not removed")
    }
}
const stageFile = (file, noun) => (file && Number(file.size) > 0 ? portal().stage(file, noun) : null)

// ===== the links =====
// A supplier's link to its quote's QuoteResponse page, for send#QuoteRequest: a new capability of the quote order on the
// organization's first published site with the Supplier app, or null without one. A failure is logged and the RFQ goes
// without the link.
function quoteLink(orderId) {
    try {
        const record = access.recordOf("Quote", orderId)
        if (!record || !apps.sitesFor("supplier", record.organizationPartyId)[0]) return null
        return access.create({recordType: "Quote", recordId: orderId, scopes: "QuoteResponse", validDays: QUOTE_LINK_DAYS}).url
    } catch (error) {
        ec.message.clearErrors()
        ec.logger.error("Quote " + orderId + " link was not made: " + error.message)
        return null
    }
}
// A purchase order's link for a revision, for send#PurchaseOrder: OrderAcknowledgement with BillUpload beside it, or null
// without a Supplier site.
function orderLink(orderId, revision) {
    try {
        const record = access.recordOf("Order", orderId)
        if (!record || !apps.sitesFor("supplier", record.organizationPartyId)[0]) return null
        return access.create({
            recordType: "Order",
            recordId: orderId,
            scopes: "OrderAcknowledgement,BillUpload",
            recordRevision: revision,
            validDays: ORDER_LINK_DAYS
        }).url
    } catch (error) {
        ec.message.clearErrors()
        ec.logger.error("Purchase order " + orderId + " link was not made: " + error.message)
        return null
    }
}
// revoke#QuoteCapabilities: the links of an RFQ's quotes (requestId) or of the given quote orders, for close#QuoteRequest
// (P12). Internal: it only ends access.
function revokeQuotes(p) {
    const orderIds = new Set(listOf(p.orderIds).map(String))
    if (!blank(p.orderId)) orderIds.add(String(p.orderId))
    if (!blank(p.requestId))
        for (const row of rows("mantle.request.RequestItemOrder", {requestId: p.requestId}))
            if (row.orderId) orderIds.add(row.orderId)
    let revoked = 0
    for (const orderId of orderIds) revoked += revokeRecord("Quote", orderId)
    return {revokedCount: revoked}
}
function revokeRecord(recordType, recordId) {
    const live = rows("mantle.party.ExternalAccessCapability", {recordType, recordId}).filter(
        row => !row.revokedDate && lib.active(row)
    )
    for (const row of live)
        call("update#mantle.party.ExternalAccessCapability", {
            capabilityId: row.capabilityId,
            revokedDate: ec.user.nowTimestamp,
            revokedByUserId: ec.user.userId
        })
    return live.length
}
// revoke#OrderCapabilities (the SupplierPortalRevoke EECA): an order cancelled or rejected ends its links; a quote leaving
// the quote statuses (an award places it, a decline rejects it, Not awarded cancels it) ends its quote links.
function revokeOrder(p) {
    let revoked = 0
    // the order's own status, not the caller's word for it
    const statusId = one(ORDER, {orderId: p.orderId})?.statusId
    if (!statusId || statusId !== p.statusId) return {revokedCount: 0}
    if (quoteStatuses.includes(p.oldStatusId) && !quoteStatuses.includes(statusId)) revoked += revokeRecord("Quote", p.orderId)
    if (["OrderCancelled", "OrderRejected"].includes(statusId)) revoked += revokeRecord("Order", p.orderId)
    return {revokedCount: revoked}
}

// ===== SupplierHome =====
const docPath = (kind, orderId, token) =>
    (kind === "quote" ? "/QuoteResponse" : "/OrderAcknowledgement") +
    "?" +
    (token ? "token=" + encodeURIComponent(token) : "orderId=" + encodeURIComponent(orderId))
function rfqOfQuote(orderId) {
    const link = rows("mantle.request.RequestItemOrder", {orderId})[0]
    return link ? one("mantle.request.Request", {requestId: link.requestId}) : null
}
function quoteDoc(order, token) {
    const rfq = rfqOfQuote(order.orderId)
    const due = rfq?.responseRequiredDate || null
    return {
        kind: "quote",
        orderId: order.orderId,
        reference: rfq ? "Request for quotation " + rfq.requestId : "Quote " + order.orderId,
        title: rfq?.requestName || order.orderName || null,
        stateText:
            order.statusId === "OrderRequested"
                ? due && ms(due) < Date.now()
                    ? "Response late"
                    : "Quote requested"
                : "Quote sent",
        dueText: day(due),
        actionText: order.statusId === "OrderRequested" ? "Answer" : "View",
        path: docPath("quote", order.orderId, token)
    }
}
function orderDoc(order, part, token, linkRevision = null) {
    const revision = Number(order.orderRevision ?? 1)
    // a link of an earlier revision: only that the order was revised (SupersededRevision), nothing of the new revision
    if (linkRevision != null && Number(linkRevision) < revision)
        return {
            kind: "order",
            orderId: order.orderId,
            reference: "Purchase order " + order.orderId + " · revision " + Number(linkRevision),
            title: order.orderName || null,
            stateText: "Revised",
            dueText: null,
            actionText: "View",
            path: docPath("order", order.orderId, token)
        }
    const acknowledged = Number(part.acknowledgedRevision ?? 0) === revision
    return {
        kind: "order",
        orderId: order.orderId,
        reference: "Purchase order " + order.orderId + " · revision " + revision,
        title: order.orderName || null,
        stateText:
            order.statusId === "OrderCompleted"
                ? "Completed"
                : acknowledged
                  ? outcomeTexts[part.acknowledgementEnumId] || "Acknowledged"
                  : acknowledgeStatuses.includes(order.statusId)
                    ? "To acknowledge"
                    : "Placed",
        dueText: day(part.estimatedDeliveryDate),
        actionText: acknowledged || !acknowledgeStatuses.includes(order.statusId) ? "View" : "Acknowledge",
        path: docPath("order", order.orderId, token)
    }
}
function contactOf(organizationPartyId) {
    return {
        organizationName: partyName(organizationPartyId),
        emailAddress: documents().recipientsOf(organizationPartyId)[0] || null
    }
}
// get#SupplierHome: a link's one record, or the documents of the suppliers the signed-in contact was invited for: requested
// and proposed quotes, purchase orders from approval on, and the bills sent; with the organization's public contact and the
// link's expiry.
function getSupplierHome(p) {
    const organizationPartyId = served(p.siteId)
    const contact = contactOf(organizationPartyId)
    if (p.token) {
        const row = access.tokenCapability(p.token)
        if (!row || row.organizationPartyId !== organizationPartyId || !["Quote", "Order"].includes(row.recordType)) unavailable()
        const record = access.recordOf(row.recordType, row.recordId)
        if (!record || record.organizationPartyId !== organizationPartyId || record.partyId !== row.partyId) unavailable()
        const order = one(ORDER, {orderId: row.recordId})
        const part = rows(PART, {orderId: row.recordId, orderPartSeqId: record.orderPartSeqId})[0]
        const scopes = String(row.scopes || "").split(",")
        const doc =
            row.recordType === "Quote"
                ? quoteDoc(order, p.token)
                : scopes.includes("OrderAcknowledgement")
                  ? orderDoc(order, part, p.token, row.recordRevision)
                  : Object.assign(orderDoc(order, part, p.token, row.recordRevision), {
                        actionText: "Send a bill",
                        path: "/BillUpload?token=" + encodeURIComponent(p.token)
                    })
        return {
            via: "token",
            supplierName: partyName(record.partyId),
            contact: Object.assign(contact, {expiresText: day(row.thruDate)}),
            documentList: [doc],
            billList: []
        }
    }
    if (!ec.user.userId) fail("AuthenticationRequired", "Sign in to see your documents")
    const suppliers = access.contactParties(organizationPartyId, "supplier")
    const documentList = [],
        billList = []
    if (suppliers.length) {
        const parts = Array.from(
            find(PART)
                .condition("customerPartyId", organizationPartyId)
                .condition("vendorPartyId", "in", suppliers)
                .condition("statusId", "in", quoteStatuses.concat(orderListStatuses))
                .orderBy("-orderId")
                .limit(100)
                .list()
        )
        for (const part of parts) {
            const order = one(ORDER, {orderId: part.orderId})
            if (!order) continue
            if (quoteStatuses.includes(order.statusId)) {
                if (quoteSent(order)) documentList.push(quoteDoc(order, null))
            } else if (orderListStatuses.includes(order.statusId)) documentList.push(orderDoc(order, part, null))
        }
        for (const row of Array.from(
            find("mantle.account.invoice.SupplierBillSubmission")
                .condition("organizationPartyId", organizationPartyId)
                .condition("supplierPartyId", "in", suppliers)
                .orderBy("-receivedDate")
                .limit(20)
                .list()
        ))
            billList.push({
                orderId: row.orderId,
                referenceNumber: row.referenceNumber,
                receivedDateText: dateText(row.receivedDate),
                path:
                    "/BillUpload?orderId=" +
                    encodeURIComponent(row.orderId) +
                    "&submissionId=" +
                    encodeURIComponent(row.submissionId)
            })
    }
    return {
        via: "contact",
        supplierName: suppliers.map(partyName).join(", "),
        contact: Object.assign(contact, {expiresText: null}),
        documentList,
        billList
    }
}

// ===== QuoteResponse =====
function draftOf(orderId, revision) {
    return (
        rows(RESPONSE, {orderId, responseKind: "QuoteResponse", state: "draft"}).find(
            row => Number(row.recordRevision) === Number(revision)
        ) || null
    )
}
// The quote as its supplier reads it: the published request (its revision, response date, specification text and currency),
// the quote's lines (product, the supplier's item code, quantity, unit, required date) with the supplier's offer, the
// supplier's own draft, and its receipt once submitted. No other supplier, internal request, maximum price or private file.
function quoteView(checked) {
    const orderId = checked.recordId
    const order = one(ORDER, {orderId})
    const part = rows(PART, {orderId, orderPartSeqId: checked.orderPartSeqId})[0]
    const rfq = rfqOfQuote(orderId)
    const revision = rfq ? Number(sourcing().revisionOf(rfq.requestId)) : 0
    const closed = rfq && ["ReqCompleted", "ReqCancelled"].includes(rfq.statusId)
    const due = rfq?.responseRequiredDate || null
    const late = !!due && ms(due) < Date.now()
    const receiptRow = earlierReceipt(orderId, "QuoteResponse", null, revision)
    const draft = receiptRow ? null : draftOf(orderId, revision)
    const draftData = draft ? lib.json(draft.dataJson, {}) : {}
    const draftLines = Object.fromEntries(listOf(draftData.lines || []).map(line => [String(line.orderItemSeqId), line]))
    const currency = order.currencyUomId
    const proposed = order.statusId === "OrderProposed"
    const lines = linesOf(orderId, checked.orderPartSeqId).map(item => {
        const drafted = draftLines[item.orderItemSeqId] || {}
        const offered = proposed && item.unitAmount != null && dec(item.unitAmount).compare(0) > 0 ? item.unitAmount : null
        return {
            orderItemSeqId: item.orderItemSeqId,
            productText: productText(item),
            description: item.productId && item.itemDescription !== productText(item) ? item.itemDescription || "" : "",
            quantityText: quantityText(item.quantity),
            unitText: uomText(item.quantityUomId),
            requiredText: day(item.requiredByDate),
            unitAmount: drafted.unitAmount ?? (offered == null ? null : String(lib.money(offered, currency))),
            unitAmountText: offered == null ? null : moneyText(offered, currency),
            promisedDate: drafted.promisedDate ?? dayValue(item.promisedDate),
            otherPartyProductId: drafted.otherPartyProductId ?? item.otherPartyProductId ?? null
        }
    })
    return {
        quote: {
            orderId,
            requestId: rfq?.requestId || null,
            title: rfq?.requestName || order.orderName || null,
            buyerName: partyName(checked.organizationPartyId),
            supplierName: partyName(checked.partyId),
            revision,
            revisionText: revision ? "Revision of " + dateText(revision) : null,
            dueText: day(due),
            late,
            specification: rfq?.description || null,
            currencyUomId: currency,
            statusText: proposed ? "Quote sent" : "Quote requested",
            otherPartyOrderId: draftData.otherPartyOrderId ?? part?.otherPartyOrderId ?? null,
            validThruDate: draftData.validThruDate ?? dayValue(part?.validThruDate),
            estimatedDeliveryDate: draftData.estimatedDeliveryDate ?? dayValue(part?.estimatedDeliveryDate),
            note: draftData.note ?? null
        },
        lines,
        draft: draft ? {savedText: dateText(draft.savedDate)} : null,
        receipt: receiptRow ? receiptOf(receiptRow) : null,
        capabilities: {
            canSubmit: !receiptRow && !closed,
            expiresText: day(checked.thruDate)
        }
    }
}
// get#QuoteInvitation
function getQuoteInvitation(p) {
    return quoteView(checkQuote(p))
}
// The response the page sent, checked against the quote's lines: the supplier's reference, validity, delivery, note and each
// line's price, promised date and item code. Only these: the supplier sets no approval, award, other supplier, maximum
// price or source demand.
function responseOf(p, orderId, orderPartSeqId, requirePrices) {
    const items = Object.fromEntries(linesOf(orderId, orderPartSeqId).map(item => [item.orderItemSeqId, item]))
    const lines = []
    for (const line of listOf(p.lines)) {
        const seq = text(line?.orderItemSeqId)
        if (!seq || !items[seq]) fail("Unprocessable", "Reload the page and try again")
        let unitAmount = null
        if (!blank(line.unitAmount)) {
            try {
                unitAmount = toDecimal(String(line.unitAmount).trim())
            } catch (_) {
                unitAmount = null
            }
            if (unitAmount == null || unitAmount.compare(0) < 0)
                fail("Unprocessable", "Enter each price as a number of zero or more")
        }
        const promised = dateOf(line.promisedDate, "the promised date")
        lines.push({
            orderItemSeqId: seq,
            unitAmount: unitAmount == null ? null : String(unitAmount),
            promisedDate: promised ? dayValue(promised) : null,
            otherPartyProductId: text(line.otherPartyProductId)?.slice(0, 60) || null
        })
    }
    if (requirePrices && !lines.some(line => line.unitAmount != null && dec(line.unitAmount).compare(0) > 0))
        fail("Unprocessable", "Enter a price for at least one line")
    const validThru = dateOf(p.validThruDate, "the date the quote is valid through")
    if (requirePrices && validThru && ms(validThru) <= Date.now()) fail("Unprocessable", "A quote is valid through a later date")
    const delivery = dateOf(p.estimatedDeliveryDate, "the delivery date")
    return {
        otherPartyOrderId: text(p.otherPartyOrderId)?.slice(0, 60) || null,
        validThruDate: validThru ? dayValue(validThru) : null,
        estimatedDeliveryDate: delivery ? dayValue(delivery) : null,
        note: text(p.note)?.slice(0, 1000) || null,
        lines
    }
}
// save#QuoteResponse: the supplier's private draft of the current revision (no write to the quote; the buyer sees nothing
// until it is submitted).
function saveQuoteResponse(p) {
    const checked = checkQuote(p)
    throttle()
    find(ORDER, {orderId: checked.recordId}).forUpdate(true).one()
    const view = quoteView(checked)
    if (!view.capabilities.canSubmit) fail("Conflict", "This quote was already sent; it can no longer be changed here")
    if (!blank(p.rfqRevision) && Number(p.rfqRevision) !== view.quote.revision)
        fail("Conflict", "The request changed since you opened it. Review it and save again.")
    const data = responseOf(p, checked.recordId, checked.orderPartSeqId, false)
    const draft = draftOf(checked.recordId, view.quote.revision)
    const values = {
        dataJson: JSON.stringify(data),
        savedDate: ec.user.nowTimestamp,
        ...responder(checked)
    }
    if (draft) call("update#" + RESPONSE, Object.assign({responseId: draft.responseId}, values))
    else
        call(
            "create#" + RESPONSE,
            Object.assign(values, {
                orderId: checked.recordId,
                responseKind: "QuoteResponse",
                recordRevision: view.quote.revision,
                state: "draft",
                supplierPartyId: checked.partyId,
                organizationPartyId: checked.organizationPartyId
            })
        )
    return {saved: true, savedText: dateText(ec.user.nowTimestamp)}
}
// submit#QuoteResponse: the supplier's quote for the request's current revision, through store#SupplierQuoteItem per line
// and store#SupplierQuote (channel web, its evidence the file or the page), which moves it to OrderProposed. A repeat of the
// operation, or a second submit of the same revision, answers the first receipt; a late response is accepted and marked
// late for the buyer.
function submitQuoteResponse(p) {
    const checked = checkQuote(p)
    throttle()
    const key = operationId(p)
    find(ORDER, {orderId: checked.recordId}).forUpdate(true).one()
    const view = quoteView(checked)
    const earlier = earlierReceipt(checked.recordId, "QuoteResponse", key, view.quote.revision)
    if (earlier) return {receipt: receiptOf(earlier), alreadyApplied: true}
    if (!view.capabilities.canSubmit) fail("Conflict", "This request for quotation is closed")
    if (!(p.confirm === true || p.confirm === "true" || p.confirm === "Y"))
        fail("Unprocessable", "Confirm that this is your quote and its terms")
    if (!blank(p.rfqRevision) && Number(p.rfqRevision) !== view.quote.revision)
        fail("Conflict", "The request changed since you opened it. Review it and send your quote again.")
    const data = responseOf(p, checked.recordId, checked.orderPartSeqId, true)
    const staged = stageFile(p.file, "quote")
    let orderContentId = null
    try {
        orders.asSupplier(claimOf(checked), () => {
            const reason = "Supplier's response from the Supplier app"
            for (const line of data.lines)
                call(
                    "mantle.order.SourcingServices.store#SupplierQuoteItem",
                    given({
                        orderId: checked.recordId,
                        orderItemSeqId: line.orderItemSeqId,
                        unitAmount: line.unitAmount,
                        promisedDate: line.promisedDate ? dateOf(line.promisedDate, "the promised date") : null,
                        otherPartyProductId: line.otherPartyProductId,
                        changeReason: reason
                    })
                )
            const stored = call(
                "mantle.order.SourcingServices.store#SupplierQuote",
                given({
                    orderId: checked.recordId,
                    otherPartyOrderId: data.otherPartyOrderId,
                    validThruDate: data.validThruDate ? dateOf(data.validThruDate, "the date") : null,
                    estimatedDeliveryDate: data.estimatedDeliveryDate ? dateOf(data.estimatedDeliveryDate, "the date") : null,
                    salesChannelEnumId: "ScWeb",
                    evidenceText: ("Sent from the Supplier app" + (data.note ? ": " + data.note : "")).slice(0, 255),
                    changeReason: reason
                })
            )
            orderContentId = stored.orderContentId
        })
    } catch (error) {
        unstage(staged)
        refused(error)
    }
    try {
        orderContentId = keepFile(checked.recordId, staged, "OctSupplierQuote", checked.partyId, "Supplier quote", orderContentId)
    } finally {
        unstage(staged)
    }
    for (const draft of rows(RESPONSE, {orderId: checked.recordId, responseKind: "QuoteResponse", state: "draft"}))
        call("delete#" + RESPONSE, {responseId: draft.responseId})
    const order = one(ORDER, {orderId: checked.recordId})
    const receipt = {
        kind: "QuoteResponse",
        orderId: checked.recordId,
        requestId: view.quote.requestId,
        revisionText: view.quote.revisionText,
        submittedText: dateText(ec.user.nowTimestamp),
        late: view.quote.late,
        reference: data.otherPartyOrderId,
        totalText: moneyText(order.grandTotal, order.currencyUomId),
        stateText: "Received for the buyer's review",
        fileAttached: !!staged
    }
    const kept = keepReceipt(checked, "QuoteResponse", key, view.quote.revision, data, receipt, view.quote.late)
    tellBuyers(
        checked,
        "QuoteResponse",
        "quote received",
        [view.quote.revisionText, view.quote.late ? "late" : null].filter(Boolean).join(", ")
    )
    return {receipt: kept, alreadyApplied: false}
}

// ===== OrderAcknowledgement =====
function addressText(contactMechId) {
    const address = contactMechId && one("mantle.party.contact.PostalAddress", {contactMechId})
    if (!address) return null
    return [address.toName, address.address1, address.address2, address.city, address.stateProvinceGeoId, address.postalCode]
        .filter(Boolean)
        .join(", ")
}
function receiveAtOf(part) {
    const facility = part.facilityId && one("mantle.facility.Facility", {facilityId: part.facilityId})
    const contactMechId =
        part.postalContactMechId ||
        (facility &&
            rows("mantle.facility.FacilityContactMech", {facilityId: facility.facilityId}).find(
                row => row.contactMechPurposeId === "PostalShippingDest" && lib.active(row)
            )?.contactMechId) ||
        null
    return {name: facility ? facility.facilityName || facility.facilityId : null, address: addressText(contactMechId)}
}
// A subcontract order's service lines: the operation, the custody facility the organization's components are at (owned by
// the organization, the supplier its custodian), what is there, and the date it is due.
function subcontractOf(orderId, organizationPartyId) {
    return rows("mantle.work.production.ProductionSubcontract", {orderId}).map(row => {
        const operation =
            row.operationWorkEffortId && one("mantle.work.effort.WorkEffort", {workEffortId: row.operationWorkEffortId})
        const facility = row.vendorFacilityId && one("mantle.facility.Facility", {facilityId: row.vendorFacilityId})
        const held = new Map()
        if (facility)
            for (const asset of rows("mantle.product.asset.Asset", {
                facilityId: facility.facilityId,
                ownerPartyId: organizationPartyId
            })) {
                if (dec(asset.quantityOnHandTotal).compare(0) <= 0) continue
                held.set(asset.productId, dec(held.get(asset.productId)).add(dec(asset.quantityOnHandTotal)))
            }
        return {
            orderItemSeqId: row.orderItemSeqId,
            operationText: operation?.workEffortName || row.operationWorkEffortId || "",
            custodyText: facility ? facility.facilityName || facility.facilityId : null,
            dueText: day(row.requiredByDate),
            componentList: Array.from(held.entries()).map(([productId, quantity]) => ({
                productText: productText({productId}),
                quantityText: quantityText(quantity)
            }))
        }
    })
}
function orderView(checked) {
    const orderId = checked.recordId
    const order = one(ORDER, {orderId})
    const revision = requireCurrent(checked, order)
    const part = rows(PART, {orderId, orderPartSeqId: checked.orderPartSeqId})[0]
    const currency = order.currencyUomId
    const shipTo = dropShip().shipToOf({order, part, orderId})
    const lines = linesOf(orderId, checked.orderPartSeqId).map(item => {
        const delivered = shipTo ? dropShip().deliveredQuantity(item) : null
        return {
            orderItemSeqId: item.orderItemSeqId,
            productText: productText(item),
            otherPartyProductId: item.otherPartyProductId || null,
            description: item.productId && item.itemDescription !== productText(item) ? item.itemDescription || "" : "",
            quantity: String(dec(item.quantity).subtract(dec(item.quantityCancelled))),
            quantityText: quantityText(dec(item.quantity).subtract(dec(item.quantityCancelled))),
            unitText: uomText(item.quantityUomId),
            priceText: moneyText(item.unitAmount, currency),
            totalText: moneyText(
                dec(item.quantity).subtract(dec(item.quantityCancelled)).multiply(dec(item.unitAmount)),
                currency
            ),
            requiredText: day(item.requiredByDate),
            promisedDate: dayValue(item.promisedDate),
            promisedQuantity: item.promisedQuantity == null ? null : String(item.promisedQuantity),
            deliveredText: delivered == null ? null : quantityText(delivered)
        }
    })
    const acknowledged = Number(part.acknowledgedRevision ?? 0) === revision
    const receipt = earlierReceipt(orderId, "OrderAcknowledgement", null, revision)
    const receiveAt = shipTo ? {name: shipTo.shipToName, address: shipTo.shipToAddress} : receiveAtOf(part)
    return {
        order: {
            orderId,
            orderName: order.orderName || null,
            revision,
            revisionText: "Revision " + revision,
            buyerName: partyName(checked.organizationPartyId),
            supplierName: partyName(checked.partyId),
            placedText: day(order.placedDate || order.entryDate),
            currencyUomId: currency,
            totalText: moneyText(order.grandTotal, currency),
            deliveryText: day(part.estimatedDeliveryDate),
            paymentTermText: part.settlementTermId
                ? one("mantle.account.invoice.SettlementTerm", {settlementTermId: part.settlementTermId})?.description || null
                : null,
            incotermText: enumText(part.tradeTermEnumId),
            shipToName: receiveAt.name,
            shipToAddress: receiveAt.address,
            dropShip: !!shipTo,
            statusText: order.statusId === "OrderCompleted" ? "Completed" : order.statusId === "OrderHold" ? "On hold" : "Open"
        },
        lines,
        subcontractList: subcontractOf(orderId, checked.organizationPartyId),
        acknowledgement: acknowledged
            ? {
                  outcomeText: outcomeTexts[part.acknowledgementEnumId] || "Acknowledged",
                  dateText: dateText(part.acknowledgedDate),
                  reference: part.otherPartyOrderId || null,
                  note: part.acknowledgementNote || null
              }
            : null,
        receipt: receipt ? receiptOf(receipt) : null,
        deliveryReports: rows(RESPONSE, {orderId, responseKind: "DeliveryReport", state: "submitted"})
            .sort((a, b) => ms(b.submittedDate) - ms(a.submittedDate))
            .slice(0, 10)
            .map(receiptOf),
        capabilities: {
            canAcknowledge: acknowledgeStatuses.includes(order.statusId) && !receipt,
            canReportDelivery: !!shipTo && deliveryStatuses.includes(order.statusId),
            canSendBill: true,
            expiresText: day(checked.thruDate)
        }
    }
}
// get#PublishedPurchaseOrder: the order, or for a link of an earlier revision only that it was revised (SupersededRevision),
// nothing of the new revision.
function getPublishedPurchaseOrder(p) {
    const checked = checkOrder(p)
    const order = one(ORDER, {orderId: checked.recordId})
    if (checked.recordRevision != null && Number(checked.recordRevision) < Number(order.orderRevision ?? 1))
        return {
            superseded: {
                code: "SupersededRevision",
                orderId: checked.recordId,
                linkRevision: Number(checked.recordRevision),
                message:
                    "This link is for revision " +
                    checked.recordRevision +
                    " of order " +
                    checked.recordId +
                    ", which has since been revised. Open the link in the buyer's latest email."
            }
        }
    return orderView(checked)
}
// acknowledge#PurchaseOrder: the supplier's response to the order's current revision through record#Acknowledgement:
// accepted, accepted with changes or rejected, its reference, note and each line's promised date and quantity, which change
// no ordered quantity, price, stock or payment. A link of an earlier revision, or a page opened before a revision, answers
// SupersededRevision; a repeat answers the first receipt.
function acknowledgePurchaseOrder(p) {
    const checked = checkOrder(p)
    throttle()
    const key = operationId(p)
    const order = find(ORDER, {orderId: checked.recordId}).forUpdate(true).one()
    const revision = requireCurrent(checked, order)
    const earlier = earlierReceipt(checked.recordId, "OrderAcknowledgement", key, revision)
    if (earlier) return {receipt: receiptOf(earlier), alreadyApplied: true}
    if (!blank(p.orderRevision) && Number(p.orderRevision) !== revision)
        fail(
            "Conflict",
            "SupersededRevision: you opened revision " +
                p.orderRevision +
                "; the order is now at revision " +
                revision +
                ". Review it again."
        )
    const outcome = outcomes[String(p.outcome || "accept")]
    if (!outcome) fail("Unprocessable", "Choose accept, accept with changes or reject")
    const lineAcknowledgements = listOf(p.lines).map(line => {
        const promised = dateOf(line?.promisedDate, "the promised date")
        return {
            orderItemSeqId: text(line?.orderItemSeqId),
            promisedDate: promised || null,
            promisedQuantity: blank(line?.promisedQuantity) ? null : String(line.promisedQuantity).trim()
        }
    })
    const note = text(p.note)?.slice(0, 1000) || null
    const reference = text(p.otherPartyOrderId)?.slice(0, 60) || null
    const staged = stageFile(p.file, "acknowledgement")
    let recorded
    try {
        recorded = orders.asSupplier(claimOf(checked), () =>
            call(
                "mantle.order.OrderServices.record#Acknowledgement",
                given({
                    orderId: checked.recordId,
                    orderRevision: revision,
                    otherPartyOrderId: reference,
                    acknowledgementEnumId: outcome,
                    acknowledgementNote: note,
                    lineAcknowledgements,
                    evidenceText: staged ? "Acknowledged from the Supplier app" : null
                })
            )
        )
    } catch (error) {
        unstage(staged)
        refused(error)
    }
    let orderContentId = recorded.orderContentId || null
    try {
        orderContentId = keepFile(
            checked.recordId,
            staged,
            "OctSupplierAcknowledgement",
            checked.partyId,
            "Acknowledgement of revision " + revision,
            orderContentId
        )
    } finally {
        unstage(staged)
    }
    const receipt = {
        kind: "OrderAcknowledgement",
        orderId: checked.recordId,
        revisionText: "Revision " + revision,
        outcomeText: outcomeTexts[outcome],
        submittedText: dateText(ec.user.nowTimestamp),
        reference,
        changedLineCount: (recorded.changedLines || []).length,
        stateText: outcome === "PakAccepted" ? "Received" : "Received for the buyer's review",
        fileAttached: !!staged
    }
    const kept = keepReceipt(
        checked,
        "OrderAcknowledgement",
        key,
        revision,
        {outcome, reference, note, lineAcknowledgements},
        receipt
    )
    tellBuyers(checked, "OrderAcknowledgement", "acknowledgement " + outcomeTexts[outcome].toLowerCase(), "revision " + revision)
    return {receipt: kept, alreadyApplied: false}
}
// report#DropShipDelivery: a drop-ship supplier's report of what it shipped to the customer (each line's quantity, the
// tracking code and the date), kept as the order's content for the buyer to confirm with finalize#DropShipPurchaseOrder
// (P7); it ships nothing and posts nothing.
function reportDropShipDelivery(p) {
    const checked = checkOrder(p)
    throttle()
    const key = operationId(p)
    const order = find(ORDER, {orderId: checked.recordId}).forUpdate(true).one()
    const revision = requireCurrent(checked, order)
    const earlier = earlierReceipt(checked.recordId, "DeliveryReport", key, null)
    if (earlier) return {receipt: receiptOf(earlier), alreadyApplied: true}
    const part = rows(PART, {orderId: checked.recordId, orderPartSeqId: checked.orderPartSeqId})[0]
    const shipTo = dropShip().shipToOf({order, part, orderId: checked.recordId})
    if (!shipTo) fail("Unprocessable", "This order is not shipped to the buyer's customer")
    if (!deliveryStatuses.includes(order.statusId)) fail("Conflict", "This order is not open for delivery")
    const items = Object.fromEntries(linesOf(checked.recordId, checked.orderPartSeqId).map(item => [item.orderItemSeqId, item]))
    const lines = []
    for (const line of listOf(p.lines)) {
        const item = items[text(line?.orderItemSeqId)]
        if (!item) fail("Unprocessable", "Reload the page and try again")
        if (blank(line.quantity)) continue
        let quantity = null
        try {
            quantity = toDecimal(String(line.quantity).trim())
        } catch (_) {}
        if (quantity == null || quantity.compare(0) < 0) fail("Unprocessable", "Enter each quantity shipped as a number")
        if (quantity.compare(0) === 0) continue
        const open = dec(item.quantity)
            .subtract(dec(item.quantityCancelled))
            .subtract(dec(dropShip().deliveredQuantity(item)))
        if (quantity.compare(open) > 0)
            fail("Unprocessable", "Line " + item.orderItemSeqId + " has " + quantityText(open) + " left to ship")
        lines.push({orderItemSeqId: item.orderItemSeqId, productText: productText(item), quantity: String(quantity)})
    }
    if (!lines.length) fail("Unprocessable", "Enter the quantity shipped of at least one line")
    const trackingCode = text(p.trackingCode)?.slice(0, 60) || null
    const shipped = dateOf(p.shippedDate, "the date shipped") || new Date(Number(ec.user.nowTimestamp))
    const note = text(p.note)?.slice(0, 500) || null
    const description = (
        "Delivery reported by the supplier: " +
        lines.map(line => quantityText(line.quantity) + " of line " + line.orderItemSeqId).join(", ") +
        (trackingCode ? "; tracking " + trackingCode : "") +
        "; shipped " +
        day(shipped)
    ).slice(0, 255)
    const orderContentId = revisions().uncounted(
        checked.recordId,
        () =>
            call("create#mantle.order.OrderContent", {
                orderId: checked.recordId,
                orderContentTypeEnumId: "OctSupplierDeliveryReport",
                partyId: checked.partyId,
                roleTypeId: "Supplier",
                contentDate: ec.user.nowTimestamp,
                description
            }).orderContentId
    )
    const receipt = {
        kind: "DeliveryReport",
        orderId: checked.recordId,
        submittedText: dateText(ec.user.nowTimestamp),
        shippedText: day(shipped),
        trackingCode,
        lineList: lines.map(line => ({
            orderItemSeqId: line.orderItemSeqId,
            productText: line.productText,
            quantityText: quantityText(line.quantity)
        })),
        stateText: "Reported for the buyer to confirm",
        orderContentId
    }
    const kept = keepReceipt(
        checked,
        "DeliveryReport",
        key,
        revision,
        {lines, trackingCode, shippedDate: day(shipped), note},
        receipt
    )
    tellBuyers(checked, "DeliveryReport", "drop-ship delivery reported", trackingCode ? "tracking " + trackingCode : null)
    return {receipt: kept, alreadyApplied: false}
}

const operations = {
    getSupplierHome,
    getQuoteInvitation,
    saveQuoteResponse,
    submitQuoteResponse,
    getPublishedPurchaseOrder,
    acknowledgePurchaseOrder,
    reportDropShipDelivery,
    revokeQuotes,
    revokeOrder
}
;({
    quoteLink,
    orderLink,
    execute(op, input) {
        if (!operations[op]) fail("NotFound", "Unknown supplier portal operation")
        // the checks above are this module's; Mantle's reads and writes below them run without artifact authorization, and
        // the writes on the supplier's claim of its one order (PurchaseOrders.js asSupplier)
        const was = ec.artifactExecution.disableAuthz()
        try {
            return operations[op](input || {})
        } finally {
            if (!was) ec.artifactExecution.enableAuthz()
        }
    }
})
