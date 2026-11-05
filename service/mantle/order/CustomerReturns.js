// The PASS Support app's return pages (design-customer-service §8 MyReturns, RequestReturn, CustomerReturn; impl-customer-service
// P15, P9, CS-PORTAL, CS-RETURN-POLICY, F61): a customer's own returns with the organization, as
// mantle.order.ReturnPolicyServices' customer services. The asker is checked first (ExternalAccess.check: the RMA's ReturnRma
// link, or a signed-in account acting for the return's customer, an invited contact or the customer's own account), then P9's
// rules run on the Support app's claim for that customer (ReturnPolicies.js asCustomer): a request is submit#CustomerReturn's
// (the policy evaluated and kept, the policy's destination facility, requested for an authorizer), with only the customer's
// eligible lines within a self-service policy, its customer-visible reasons and the policy's remedies; nothing else (a
// facility, a carrier, a payment method, an unreferenced line, an exception) is accepted from a page, and a requested remedy is
// not an approved refund. A withdrawal is cancel#CustomerReturn's, before any physical or financial effect; after it the page
// says to ask an agent. Evidence is a staged and scanned file (PortalMedia.js) kept as ReturnContent of the customer evidence
// type; the return label is the one Issue return label requested (request#ReturnLabel), kept once as ReturnContent and
// downloaded through the facade. The answers name no cost, amount, stock disposition or internal note. CC0 1.0 Universal plus
// Grant of Patent License.
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const policies = ec.resource.script("component://mr-mantle/service/mantle/order/ReturnPolicies.js")
const portal = () => ec.resource.script("component://mr-mantle/service/mantle/request/SupportPortal.js")
const orders = () => ec.resource.script("component://mr-mantle/service/mantle/order/CustomerOrders.js")
const access = () => ec.resource.script("component://mr-mantle/service/mantle/party/ExternalAccess.js")
const media = () => ec.resource.script("component://mr-mantle/service/mantle/party/PortalMedia.js")
const {find, one, rows, call, ms} = lib

const HEADER = "mantle.order.return.ReturnHeader",
    ITEM = "mantle.order.return.ReturnItem",
    CONTENT = "mantle.order.return.ReturnContent",
    REASON = "mantle.order.return.ReturnReasonPolicy",
    SOURCE = "mantle.shipment.ShipmentItemSource",
    ROUTE_SEG = "mantle.shipment.ShipmentPackageRouteSeg"
const EVIDENCE = "RtcntCustomerEvidence",
    LABEL = "RtcntReturnLabel"
// the customer's words for a return's status
const customerTexts = {
    ReturnRequested: "Requested",
    ReturnApproved: "Authorized: send the goods back",
    ReturnShipped: "On its way back",
    ReturnReceived: "Received",
    ReturnManResp: "Received: being settled",
    ReturnCompleted: "Completed",
    ReturnCancelled: "Withdrawn"
}
const defaultResponses = ["RrspCredit", "RrspRefund", "RrspReplace"]
const blank = value => value == null || String(value).trim() === ""
const text = value => (blank(value) ? null : String(value).trim())
const L = words => ec.l10n.localize(words)
const dec = value => toDecimal(value ?? 0)
const qty = value => (dec(value).compare(0) === 0 ? "0" : ec.l10n.format(dec(value), "#,##0.###"))
const enumText = enumId => (enumId ? one("moqui.basic.Enumeration", {enumId})?.description || enumId : "")
const productText = productId => {
    const product = productId ? one("mantle.product.Product", {productId}) : null
    return product ? [product.pseudoId || product.productId, product.productName].filter(Boolean).join(" · ") : ""
}
const listOf = value =>
    String(value || "")
        .split(",")
        .map(s => s.trim())
        .filter(Boolean)

// ===== the asker =====
// The return a page asks for: the RMA's link (its scope ReturnRma), or a signed-in account acting for its customer.
function returnFor(p, organizationPartyId) {
    const s = portal()
    if (blank(p.returnId) && blank(p.token)) s.unavailable()
    if (!p.token && !ec.user.userId) s.signInRequired()
    const checked = access().check({
        token: p.token || null,
        scope: "ReturnRma",
        recordType: "ReturnHeader",
        recordId: p.returnId || null,
        organizationPartyId
    })
    const header = one(HEADER, {returnId: checked.recordId})
    // an agent's draft is not the customer's yet
    if (!header || header.statusId === "ReturnCreated") s.unavailable()
    return {checked, header, returnId: header.returnId, customerPartyId: header.customerPartyId, organizationPartyId}
}
const asCustomer = (theReturn, work, withdraw = false) =>
    policies.asCustomer(
        {organizationPartyId: theReturn.organizationPartyId, customerPartyId: theReturn.customerPartyId, withdraw},
        work
    )

// ===== what the customer sees of a return =====
function reasonsOf(organizationPartyId) {
    return policies
        .currentRows(REASON, {organizationPartyId})
        .filter(row => row.customerVisible === "Y")
        .map(row => ({
            returnReasonEnumId: row.returnReasonEnumId,
            text: row.customerLabel || enumText(row.returnReasonEnumId),
            evidenceRequired: row.evidenceRequired === "Y",
            suggestedResponseEnumId: row.suggestedResponseEnumId || null
        }))
}
function shipmentsOf(returnId) {
    return Array.from(
        new Set(
            rows(SOURCE, {returnId})
                .map(row => row.shipmentId)
                .filter(Boolean)
        )
    ).sort()
}
// The return's label (Issue return label, request#ReturnLabel) and tracking: its return shipments' route segments.
function labelsOf(returnId) {
    const out = []
    for (const shipmentId of shipmentsOf(returnId)) {
        const shipment = one("mantle.shipment.Shipment", {shipmentId})
        if (!shipment || ["ShipCancelled", "ShipRejected"].includes(shipment.statusId)) continue
        for (const seg of rows(ROUTE_SEG, {shipmentId}))
            out.push({
                shipmentId,
                trackingCode: seg.trackingCode || seg.returnTrackingCode || null,
                trackingUrl: seg.trackingUrl || null,
                hasLabel: seg.labelImage != null || seg.returnLabelImage != null,
                seg
            })
    }
    return out
}
function returnRow(header) {
    const items = policies.topItems(header.returnId)
    const sum = field => items.reduce((total, item) => total.add(dec(item[field])), toDecimal(0))
    const authorized = ["ReturnApproved", "ReturnShipped", "ReturnReceived", "ReturnManResp", "ReturnCompleted"].includes(
        header.statusId
    )
    const tracking = labelsOf(header.returnId)
        .map(row => row.trackingCode)
        .filter(Boolean)
    return {
        returnId: header.returnId,
        reference: header.displayId || header.returnId,
        customerReference: header.customerReference || "",
        orderId: items.find(item => item.orderId)?.orderId || null,
        statusText: L(customerTexts[header.statusId] || "In progress"),
        requestedQuantity: qty(sum("returnQuantity")),
        approvedQuantity: authorized ? qty(sum("returnQuantity")) : "",
        receivedQuantity: qty(sum("receivedQuantity")),
        remedyText: Array.from(new Set(items.map(item => enumText(item.returnResponseEnumId)).filter(Boolean))).join(", "),
        expiryText: authorized && header.authorizationExpireDate ? lib.dateText(header.authorizationExpireDate).slice(0, 10) : "",
        trackingText: tracking.join(", "),
        enteredText: lib.dateText(header.entryDate).slice(0, 10),
        // a withdrawn return's page is closed (the RMA kind no longer resolves it)
        canOpen: header.statusId !== "ReturnCancelled"
    }
}
// What happened to each line, in the customer's words: requested, authorized, received, and the remedy issued (a credit, a
// refund or a replacement) once it is, never its amount or account.
function lineRows(header) {
    return policies.topItems(header.returnId).map(item => ({
        returnItemSeqId: item.returnItemSeqId,
        productText: productText(item.productId) || item.description || "",
        quantity: qty(item.returnQuantity),
        receivedQuantity: qty(item.receivedQuantity),
        reasonText: (() => {
            const row = policies
                .currentRows(REASON, {
                    organizationPartyId: header.vendorPartyId,
                    returnReasonEnumId: item.returnReasonEnumId || "_NA_"
                })
                .find(r => r.customerVisible === "Y")
            return row?.customerLabel || enumText(item.returnReasonEnumId)
        })(),
        remedyText: enumText(item.returnResponseEnumId),
        issuedText: item.replacementOrderId
            ? L("Replacement sent")
            : item.refundPaymentId || item.finAccountTransId
              ? L("Refund issued")
              : rows("mantle.order.return.ReturnItemBilling", {returnId: header.returnId, returnItemSeqId: item.returnItemSeqId})
                      .length
                ? L("Credit issued")
                : ""
    }))
}

// ===== MyReturns =====
function findCustomerReturns(p) {
    const s = portal()
    const organizationPartyId = s.served(p.siteId)
    if (!ec.user.userId) s.signInRequired()
    const customers = s.actingFor(organizationPartyId)
    const chosen = blank(p.customerPartyId) ? customers : customers.filter(row => row.partyId === p.customerPartyId)
    const query = text(p.query)?.toLowerCase() || null
    const out = []
    for (const customer of chosen)
        for (const header of find(HEADER, {customerPartyId: customer.partyId, vendorPartyId: organizationPartyId})
            .orderBy("-entryDate")
            .limit(200)
            .list()) {
            if (header.statusId === "ReturnCreated") continue
            const row = Object.assign(returnRow(header), {customerName: customer.name})
            if (
                query &&
                ![row.reference, row.customerReference, row.orderId || ""].some(value =>
                    String(value).toLowerCase().includes(query)
                )
            )
                continue
            out.push(row)
        }
    return {
        returnList: out.slice(0, 100),
        customers: customers.map(row => ({partyId: row.partyId, name: row.name})),
        capabilities: {canRequestReturn: customers.length > 0}
    }
}

// ===== RequestReturn =====
// The customer's orders, and for a chosen one its lines that may be returned now: each with what is left, the window's end, the
// policy's remedies, whether proof is asked; a line outside a self-service policy says to ask an agent.
function getReturnableOrder(p) {
    const s = portal()
    const organizationPartyId = s.served(p.siteId)
    if (!ec.user.userId) s.signInRequired()
    const customers = s.actingFor(organizationPartyId)
    if (!customers.length) s.unavailable()
    const orderList = orders().customerOrders(organizationPartyId, customers)
    if (blank(p.orderId)) return {orderList, order: null, reasons: reasonsOf(organizationPartyId)}
    const {order, customer} = orders().orderFor(p.orderId, organizationPartyId, customers)
    const evaluated = policies.asCustomer({organizationPartyId, customerPartyId: customer.partyId}, () =>
        policies.evaluateCore({orderId: order.orderId})
    )
    const lines = evaluated.evaluated.map(line => {
        const selfService = line.policy?.selfServiceEnabled === "Y"
        const remedies =
            line.policy && listOf(line.policy.allowedResponseEnumIds).length
                ? listOf(line.policy.allowedResponseEnumIds)
                : defaultResponses
        const returnable =
            !!line.orderItemSeqId &&
            selfService &&
            line.eligible &&
            line.eligible.compare(0) > 0 &&
            !line.exceptions.includes("OUTSIDE_WINDOW")
        return {
            orderItemSeqId: line.orderItemSeqId,
            productText: line.productText,
            eligibleQuantity: line.eligibleQuantity,
            eligible: line.eligible ? line.eligible.toNumber() : 0,
            windowEndText: line.windowEndText,
            evidenceRequired: !!line.policy && line.policy.proofRequired === "Y",
            remedies: remedies.filter(id => id !== "RrspManual").map(id => ({returnResponseEnumId: id, text: enumText(id)})),
            returnable,
            note: returnable
                ? ""
                : line.eligible && line.eligible.compare(0) > 0
                  ? L("Ask us about returning this item")
                  : L("Nothing left to return")
        }
    })
    return {
        orderList,
        order: {orderId: order.orderId, orderName: order.orderName || "", customerName: customer.name, lines},
        reasons: reasonsOf(organizationPartyId),
        instructions: evaluated.policy?.instructions || "",
        feeText: evaluated.policy ? policies.evaluationResult(evaluated).feeText : ""
    }
}
// requestCustomerReturn (request#CustomerReturn): the customer's lines of one order, each returnable now (a self-service
// policy's, within its window and what is left), a customer-visible reason and one of the policy's remedies; submitted through
// submit#CustomerReturn on the claim (the server picks the facility and keeps the policy and window); evidence a file kept with
// the return. The same operation answers the first result.
function requestCustomerReturn(p) {
    const s = portal()
    s.throttle("support-return")
    const organizationPartyId = s.served(p.siteId)
    if (!ec.user.userId) s.signInRequired()
    const customers = s.actingFor(organizationPartyId)
    const {order, customer} = orders().orderFor(p.orderId, organizationPartyId, customers)
    const key = s.operationKey(p)
    const reasons = new Map(reasonsOf(organizationPartyId).map(row => [row.returnReasonEnumId, row]))
    const offered = getReturnableOrder({siteId: p.siteId, orderId: order.orderId}).order.lines
    const chosen = (typeof p.lines === "string" ? lib.json(p.lines, []) : Array.from(p.lines || [])).filter(
        line => line && line.orderItemSeqId
    )
    if (!chosen.length) s.fail("Unprocessable", "Choose what you want to return")
    let evidence = false
    const lineList = chosen.map(line => {
        const row = offered.find(o => o.orderItemSeqId === String(line.orderItemSeqId))
        if (!row || !row.returnable) s.fail("Unprocessable", "Choose items you may return now")
        const quantity = Number(line.quantity)
        if (!(quantity > 0)) s.fail("Unprocessable", "Give how many you return")
        if (quantity > row.eligible)
            s.fail("Unprocessable", "You may return up to " + row.eligibleQuantity + " of " + row.productText)
        const reason = reasons.get(String(line.returnReasonEnumId || ""))
        if (!reason) s.fail("Unprocessable", "Choose why you return " + row.productText)
        const remedy = String(line.returnResponseEnumId || reason.suggestedResponseEnumId || "")
        if (!row.remedies.some(r => r.returnResponseEnumId === remedy))
            s.fail("Unprocessable", "Choose what you would like instead")
        if (reason.evidenceRequired || row.evidenceRequired) evidence = true
        return {
            orderItemSeqId: row.orderItemSeqId,
            quantity,
            returnReasonEnumId: reason.returnReasonEnumId,
            returnResponseEnumId: remedy,
            description: text(line.condition)?.substring(0, 255) || null
        }
    })
    if (evidence && !(p.file && Number(p.file.size) > 0)) s.fail("Unprocessable", "Add a photo or document of the goods")
    const staged = media().stageGiven(p.file, "evidence", "support")
    try {
        const submitted = policies.asCustomer({organizationPartyId, customerPartyId: customer.partyId}, () =>
            policies.execute("submit", {
                operationKey: key,
                orderId: order.orderId,
                lineList,
                customerReference: text(p.customerReference)?.substring(0, 60) || null
            })
        )
        if (!submitted.alreadyApplied) keepEvidence(submitted.returnId, staged, text(p.note))
        else media().unstage(staged)
        return {
            returnId: submitted.returnId,
            receipt: {message: L("Thank you. We have your return request and will tell you what to do next.")},
            alreadyApplied: !!submitted.alreadyApplied
        }
    } catch (error) {
        media().unstage(staged)
        throw error
    }
}
function keepEvidence(returnId, staged, note) {
    if (!staged && !note) return null
    const content = call("create#" + CONTENT, {
        returnId,
        contentTypeEnumId: EVIDENCE,
        description: (note || staged?.filename || "").substring(0, 4000),
        contentDate: ec.user.nowTimestamp
    })
    if (staged) {
        const location =
            media().contentRoot() + "/return/" + returnId + "/content_" + content.returnContentId + "/" + staged.filename
        media().keep(staged, location)
        call("update#" + CONTENT, {returnContentId: content.returnContentId, contentLocation: location})
        media().unstage(staged)
    }
    return content.returnContentId
}

// ===== CustomerReturn =====
function getCustomerReturn(p) {
    const s = portal()
    const organizationPartyId = s.served(p.siteId)
    const theReturn = returnFor(p, organizationPartyId)
    const header = theReturn.header
    const effects = policies.effectsOf(header.returnId)
    const labels = labelsOf(header.returnId)
    const open = ["ReturnRequested", "ReturnApproved"].includes(header.statusId)
    const policy = header.returnPolicyId ? one("mantle.order.return.ReturnPolicy", {returnPolicyId: header.returnPolicyId}) : null
    return {
        return: Object.assign(returnRow(header), {
            organizationName: ec.resource
                .script("component://mr-mantle/service/mantle/request/SupportCases.js")
                .partyName(organizationPartyId),
            authorized: header.statusId === "ReturnApproved" || effects.length > 0,
            instructions: ["ReturnApproved", "ReturnShipped"].includes(header.statusId) ? policy?.instructions || "" : "",
            revision: policies.revisionOf(header.returnId)
        }),
        lineList: lineRows(header),
        evidenceList: rows(CONTENT, {returnId: header.returnId})
            .filter(row => row.contentTypeEnumId === EVIDENCE)
            .map(row => ({
                fileId: row.returnContentId,
                description: row.description || "",
                dateText: lib.dateText(row.contentDate),
                hasFile: !!row.contentLocation
            })),
        trackingList: labels
            .filter(row => row.trackingCode)
            .map(row => ({trackingCode: row.trackingCode, trackingUrl: row.trackingUrl})),
        capabilities: {
            canAddEvidence: open || header.statusId === "ReturnShipped",
            canDownloadLabel: labels.some(row => row.hasLabel) && ["ReturnApproved", "ReturnShipped"].includes(header.statusId),
            canWithdraw: open && !effects.length,
            askAgent: !open || effects.length > 0
        },
        via: theReturn.checked.via
    }
}
function addReturnEvidence(p) {
    const s = portal()
    s.throttle("support-return")
    const organizationPartyId = s.served(p.siteId)
    const theReturn = returnFor(p, organizationPartyId)
    const key = s.operationKey(p)
    const note = text(p.note)?.substring(0, 2000) || null
    if (!note && !(p.file && Number(p.file.size) > 0)) s.fail("Unprocessable", "Add a file or a message")
    const operation = lib.operation({operationKey: key}, "SupportReturnEvidence", organizationPartyId, {
        returnId: theReturn.returnId,
        note
    })
    if (operation.old) return lib.previous(operation)
    if (["ReturnCancelled", "ReturnCompleted"].includes(theReturn.header.statusId))
        s.fail("Unprocessable", "This return is closed; ask us about it")
    const staged = media().stageGiven(p.file, "evidence", "support")
    try {
        const fileId = keepEvidence(theReturn.returnId, staged, note)
        const result = {fileId, receipt: {message: L("Thank you. We have added it to your return.")}, alreadyApplied: false}
        lib.complete(operation, HEADER, theReturn.returnId, result)
        return result
    } catch (error) {
        media().unstage(staged)
        throw error
    }
}
// withdrawCustomerReturn (withdraw#CustomerReturn): before any physical or financial effect, at the revision the page showed;
// after it, the customer is told to ask an agent.
function withdrawCustomerReturn(p) {
    const s = portal()
    s.throttle("support-return")
    const organizationPartyId = s.served(p.siteId)
    const theReturn = returnFor(p, organizationPartyId)
    s.operationKey(p)
    const header = theReturn.header
    if (header.statusId === "ReturnCancelled") return {statusText: L(customerTexts.ReturnCancelled), alreadyApplied: true}
    if (!blank(p.expectedRevision) && String(p.expectedRevision) !== String(policies.revisionOf(header.returnId)))
        s.fail("Conflict", "This return changed since you opened it; look at it again")
    if (!["ReturnRequested", "ReturnApproved"].includes(header.statusId) || policies.effectsOf(header.returnId).length)
        s.fail("Unprocessable", "This return can no longer be withdrawn here; reply to us and an agent will help")
    asCustomer(
        theReturn,
        () =>
            policies.execute("cancelReturn", {
                returnId: header.returnId,
                reason: text(p.reason) || L("Withdrawn by the customer")
            }),
        true
    )
    return {
        statusText: L(customerTexts.ReturnCancelled),
        receipt: {message: L("Your return request is withdrawn.")},
        alreadyApplied: false
    }
}
// getReturnLabel: the label of an authorized return, kept once as ReturnContent (Return label) from its route segment's image,
// for the page's download (the transport streams it).
function getReturnLabel(p) {
    const s = portal()
    const organizationPartyId = s.served(p.siteId)
    const theReturn = returnFor(p, organizationPartyId)
    if (!["ReturnApproved", "ReturnShipped"].includes(theReturn.header.statusId)) s.unavailable()
    const label = labelsOf(theReturn.returnId).find(row => row.hasLabel)
    if (!label) s.unavailable()
    const key = label.shipmentId + "-" + label.seg.shipmentPackageSeqId + "-" + label.seg.shipmentRouteSegmentSeqId
    let kept = rows(CONTENT, {returnId: theReturn.returnId}).find(
        row => row.contentTypeEnumId === LABEL && String(row.description || "") === key && row.contentLocation
    )
    if (!kept) {
        const image = label.seg.labelImage != null ? label.seg.labelImage : label.seg.returnLabelImage
        const content = call("create#" + CONTENT, {
            returnId: theReturn.returnId,
            contentTypeEnumId: LABEL,
            description: key,
            contentDate: ec.user.nowTimestamp
        })
        const location =
            media().contentRoot() +
            "/return/" +
            theReturn.returnId +
            "/content_" +
            content.returnContentId +
            "/return-label-" +
            theReturn.returnId +
            ".pdf"
        ec.resource.getLocationReference(location).putBytes(image)
        call("update#" + CONTENT, {returnContentId: content.returnContentId, contentLocation: location})
        kept = one(CONTENT, {returnContentId: content.returnContentId})
    }
    return {
        file: {mimeType: "application/pdf", filename: "return-label-" + theReturn.returnId + ".pdf"},
        location: kept.contentLocation
    }
}

const operations = {
    findCustomerReturns,
    getReturnableOrder,
    requestCustomerReturn,
    getCustomerReturn,
    addReturnEvidence,
    withdrawCustomerReturn,
    getReturnLabel
}
;({
    execute(op, input) {
        if (!operations[op]) portal().fail("NotFound", "Unknown support operation")
        const wasDisabled = ec.artifactExecution.disableAuthz()
        try {
            return operations[op](input || {})
        } catch (error) {
            portal().refused(error)
        } finally {
            if (!wasDisabled) ec.artifactExecution.enableAuthz()
        }
    }
})
