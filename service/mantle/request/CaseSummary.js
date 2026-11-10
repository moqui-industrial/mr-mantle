// The case summary (design-customer-service §11 "Case summary PDF/text"; impl-customer-service §2 prints, P16): a case as of
// the print time, in one of two labeled variants. The customer-visible one holds what the Support app shows the customer
// (SupportPortal.js' projections): the customer label of the status, the resolution, the customer's template values, the
// outward messages, the files shared with the customer and the customer's own order and return links; never an internal
// note, internal message or file, staff detail, other customer, cost or amount. The internal one adds the queue, priority,
// assignee and internal status, every message and note with its kind, every file and every linked record. send mails the
// customer-visible summary to a checked address of the customer or its contacts, as a mail client draft of an account the
// user sends from, and stores its PDF as the case's RequestContent (RqCntCaseSummary) before it goes; the same operation key
// answers the first. Each service checks SUPPORT_CASE_EDIT or SUPPORT_CASE_MANAGE and the case's organization
// (SupportCases.caseOf) and reads with artifact authorization off. Refusals carry reason codes (EntityLib.denied).
// CC0 1.0 Universal plus Grant of Patent License.
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const cases = ec.resource.script("component://mr-mantle/service/mantle/request/SupportCases.js")
const portal = () => ec.resource.script("component://mr-mantle/service/mantle/request/SupportPortal.js")
const confirmations = () => ec.resource.script("component://mr-mantle/service/mantle/order/OrderConfirmations.js")
const {one, rows, call, denied, access, ms} = lib

const REQUEST = "mantle.request.Request",
    CONTENT = "mantle.request.RequestContent",
    COMM = "mantle.party.communication.CommunicationEvent"
const SUMMARY = "RqCntCaseSummary"
const TEMPLATE = "component://mr-mantle/template/request/CaseSummary.print.html.fancy"
const readPermissions = ["SUPPORT_CASE_EDIT", "SUPPORT_CASE_MANAGE"]
const audiences = ["customer", "internal"]

const blank = value => value == null || String(value).trim() === ""
const L = words => ec.l10n.localize(words)
const dateText = value => (value == null || value === "" ? "" : ec.l10n.format(new Date(Number(ms(value))), "d MMM yyyy HH:mm"))
const enumText = enumId => (enumId ? one("moqui.basic.Enumeration", {enumId})?.description || enumId : "")
const statusText = statusId => (statusId ? one("moqui.basic.StatusItem", {statusId})?.description || statusId : "")
const plain = value =>
    String(value || "")
        .replace(/<(br|\/p|\/div|\/li)[^>]*>/gi, "\n")
        .replace(/<[^>]*>/g, "")
        .replace(/&nbsp;/g, " ")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, "&")
        .replace(/\n{3,}/g, "\n\n")
        .trim()
const escapeHtml = value =>
    String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")

function requireRead() {
    if (!readPermissions.some(permission => access.has(permission)))
        denied("PERMISSION_DENIED", readPermissions.join(" or ") + " is required to print a case summary")
}
function audienceOf(value) {
    const audience = blank(value) ? "customer" : String(value).trim()
    if (!audiences.includes(audience)) denied("AUDIENCE_INVALID", "A case summary is for the customer or internal")
    return audience
}
// A case of one of the user's organizations (another organization's and a missing one refused alike, RECORD_UNAVAILABLE).
const caseFor = requestId => cases.caseOf(requestId)

// Every message and note of the case, oldest first, with its kind (the internal variant).
function allMessages(theCase) {
    const out = []
    for (const link of rows("mantle.request.RequestCommEvent", {requestId: theCase.requestId})) {
        const event = one(COMM, {communicationEventId: link.communicationEventId})
        if (!event) continue
        const internal =
            ["Comment", "Message", "StatusUpdate"].includes(event.communicationEventTypeId) ||
            !!one("mantle.party.communication.CommunicationEventPurpose", {
                communicationEventId: event.communicationEventId,
                purposeEnumId: "CpServiceInternal"
            })
        const html = String(event.contentType || "").includes("html")
        out.push({
            fromText: event.fromPartyId ? cases.partyName(event.fromPartyId) : "",
            toText: event.toPartyId ? cases.partyName(event.toPartyId) : "",
            kindText:
                (internal ? L("Internal") + " · " : "") +
                (one("mantle.party.communication.CommunicationEventType", {
                    communicationEventTypeId: event.communicationEventTypeId
                })?.description ||
                    event.communicationEventTypeId ||
                    "") +
                (event.statusId ? " · " + statusText(event.statusId) : ""),
            dateText: dateText(event.entryDate || event.datetimeStarted),
            atMs: Number(ms(event.entryDate || event.datetimeStarted) || 0),
            subject: event.subject || "",
            body: html ? plain(event.body) : String(event.body || "")
        })
    }
    return out.sort((a, b) => a.atMs - b.atMs).map(row => (delete row.atMs, row))
}
// Every file of the case with its kind (the internal variant); the stored summaries are listed apart.
const allFiles = requestId =>
    rows(CONTENT, {requestId})
        .filter(row => row.contentLocation && row.contentTypeEnumId !== SUMMARY)
        .sort((a, b) => Number(ms(a.contentDate) || 0) - Number(ms(b.contentDate) || 0))
        .map(row => ({
            filename: String(row.contentLocation).split("/").pop(),
            description: [enumText(row.contentTypeEnumId), row.description].filter(Boolean).join(" · "),
            dateText: dateText(row.contentDate)
        }))
// Every record the case links (the internal variant), by its entity's short name.
const allLinks = requestId =>
    rows("mantle.request.RequestRecord", {requestId}).map(row => ({
        text: String(row.recordEntityName).split(".").pop() + " " + row.recordId
    }))

// The summary of a case for an audience, as of now: {printHtml, fileName, audience}.
function summaryOf(theCase, audience) {
    const request = theCase.request
    const customer = audience === "customer"
    const p = portal()
    const facts = []
    const fact = (label, value) => !blank(value) && facts.push({label: L(label), value: String(value)})
    fact("Customer", cases.partyName(theCase.customerPartyId))
    fact("Status", customer ? p.statusLabel(theCase.profile, request.statusId) : statusText(request.statusId))
    fact("Opened", dateText(request.requestDate))
    fact("Resolution", enumText(request.requestResolutionEnumId))
    if (!customer) {
        const queue = request.requestCategoryId
            ? one("mantle.request.RequestCategory", {requestCategoryId: request.requestCategoryId})
            : null
        fact("Queue", queue?.description || request.requestCategoryId)
        fact("Type", enumText(request.requestTypeEnumId))
        fact("Priority", request.priority)
        fact("Assignee", theCase.assigneePartyId ? cases.partyName(theCase.assigneePartyId) : "")
        fact("Due", dateText(request.responseRequiredDate))
    }
    // the template's customer-visible answers in both (an internal field's answer stays on CaseDetail)
    const values = p.customerValues(theCase.profile)
    const printHtml = ec.resource.template(TEMPLATE, {
        customer,
        audienceText: customer ? L("Customer copy") : L("Internal: not for the customer"),
        requestId: theCase.requestId,
        title: request.requestName || theCase.requestId,
        description: plain(request.description),
        organizationName: cases.partyName(theCase.organizationPartyId),
        printedText: dateText(ec.user.nowTimestamp),
        facts,
        values,
        messages: customer ? p.outwardMessages(theCase) : allMessages(theCase),
        files: customer ? p.sharedFiles(theCase.requestId) : allFiles(theCase.requestId),
        links: customer ? p.customerLinks(theCase) : allLinks(theCase.requestId)
    })
    return {
        audience,
        printHtml,
        fileName: "Case-" + theCase.requestId + (customer ? "" : "-internal") + ".pdf"
    }
}

// ===== get#CaseSummaryPrint =====
function print(p) {
    requireRead()
    const audience = audienceOf(p.audience)
    return Object.assign({requestId: String(p.requestId)}, summaryOf(caseFor(p.requestId), audience))
}

// ===== send#CaseSummary =====
// The customer-visible summary stored as the case's RequestContent and mailed, with a note when given, to a checked address.
function send(p) {
    cases.requirePermission("SUPPORT_CASE_EDIT")
    const theCase = caseFor(p.requestId)
    const recipient = String(p.toAddress || "")
        .trim()
        .toLowerCase()
    if (!recipient) denied("RECIPIENT_REQUIRED", "Give the address to send the summary to")
    const operation = lib.operation(p, "CaseSummarySend", theCase.organizationPartyId, {
        requestId: theCase.requestId,
        recipient,
        emailAccountId: p.emailAccountId || null,
        note: p.note || null
    })
    if (operation.old) return lib.previous(operation)
    const allowed = confirmations().allowedRecipients([theCase.customerPartyId])
    if (!allowed.has(recipient))
        denied(
            "RECIPIENT_UNCHECKED",
            recipient + " is not an address of " + cases.partyName(theCase.customerPartyId) + " or of its contacts"
        )
    const account = confirmations().senderAccount(p.emailAccountId, theCase.organizationPartyId)
    // the summary as sent, stored before the mail goes (design §11: a sent summary is stored as RequestContent)
    const printed = summaryOf(theCase, "customer")
    const pdf = ec.resource.xslFoTransform(printed.printHtml, null, null, "application/pdf")
    const key = ec.user
        .singleUseCodeHash(printed.printHtml + ec.user.nowTimestamp)
        .replace(/[^A-Za-z0-9]/g, "")
        .slice(0, 24)
    const location = "dbresource://mantle/content/request/" + theCase.requestId + "/summary_" + key + "/" + printed.fileName
    ec.resource.getLocationReference(location).putBytes(pdf)
    const requestContentId = call("create#" + CONTENT, {
        requestId: theCase.requestId,
        contentTypeEnumId: SUMMARY,
        contentLocation: location,
        description: L("Case summary sent to") + " " + recipient,
        contentDate: ec.user.nowTimestamp,
        userId: ec.user.userId
    }).requestContentId
    const body =
        (p.note ? "<p>" + escapeHtml(p.note).replace(/\n/g, "<br>") + "</p>" : "") +
        "<p>" +
        escapeHtml(L("The summary of your case") + " " + theCase.requestId + " " + L("is attached.")) +
        "</p>"
    const draft = lib.call("org.moqui.mail.EmailClientServices.save#Draft", {
        emailAccountId: account.emailAccountId,
        toAddresses: recipient,
        subject: p.subject || L("Case summary") + " " + theCase.requestId,
        body,
        attachmentList: [{attachmentLocation: location, fileName: printed.fileName, contentType: "application/pdf"}]
    })
    const sent = lib.call("mantle.party.CommunicationServices.send#EmailDraft", {
        emailMessageId: draft.emailMessageId,
        recordEntityName: REQUEST,
        recordId: theCase.requestId
    })
    const result = {
        requestId: theCase.requestId,
        requestContentId,
        emailMessageId: draft.emailMessageId,
        recipient,
        status: sent.sent ? "sent" : sent.sendError ? "failed" : "queued"
    }
    lib.complete(operation, "moqui.basic.email.EmailMessage", draft.emailMessageId, result)
    return Object.assign(result, {alreadyApplied: false})
}

const operations = {print, send}
;({
    // each operation checks its own permission and the case's organization, and reads and writes with artifact authorization off
    execute: (op, parameters) => {
        if (!operations[op]) throw new Error("Unknown case summary operation " + op)
        const wasDisabled = ec.artifactExecution.disableAuthz()
        try {
            return operations[op](parameters || {})
        } finally {
            if (!wasDisabled) ec.artifactExecution.enableAuthz()
        }
    }
})
