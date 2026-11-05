// Accounting's customer and supplier pages, the PASS Billing and Supplier apps (impl-accounting P18): what a public page
// may read and do with an invoice or a purchase order. Every operation first finds the organization the page serves (the
// app mount's target on a published site) and checks the capability or the signed-in contact (ExternalAccess.check);
// it answers allow-listed projections, never Party, internal notes, costs or other parties' records. A refusal a page
// shows is a PASS error kind (NotFound, Unprocessable, Conflict, Unavailable, AuthenticationRequired).
const lib = ec.resource.script("component://mr-mantle/service/mantle/account/InvoiceWorkflowLib.js")
const access = ec.resource.script("component://mr-mantle/service/mantle/party/ExternalAccess.js")
const apps = ec.resource.script("component://mr-mantle/service/mantle/public/PublicApps.js")
const {find, one, rows, call} = lib
const I = lib.invoiceEntity,
    P = "mantle.account.payment.Payment",
    R = "mantle.account.method.PaymentGatewayResponse",
    SUB = "mantle.account.invoice.SupplierBillSubmission"
const issued = ["InvoiceFinalized", "InvoiceSent", "InvoiceAcked", "InvoicePmtRecvd"]
const fail = (kind, message) => {
    const error = new Error(message)
    error.moquiErrorKind = kind
    throw error
}
const unavailable = () => fail("NotFound", "This page is not available")
const text = value => (value == null ? null : String(value))
const day = value => (value == null ? null : lib.entityLib.dateText(value).slice(0, 10))
const money = (value, currencyUomId) => lib.entityLib.money(value, currencyUomId)
const moneyText = (value, currencyUomId) => ec.l10n.formatCurrency(money(value, currencyUomId), currencyUomId)
const name = partyId => {
    const org = partyId && one("mantle.party.Organization", {partyId})
    if (org) return org.organizationName || partyId
    const person = partyId && one("mantle.party.Person", {partyId})
    return person ? [person.firstName, person.lastName].filter(Boolean).join(" ") : ""
}
// The organization an app of a published site serves.
function served(siteId, app) {
    const site = siteId && one("mantle.public.PublicSite", {siteId})
    if (!site || site.state !== "published") unavailable()
    const mount = apps.mount(siteId, app)
    if (!mount?.targetId) unavailable()
    return mount.targetId
}
function operationId(p) {
    const value = String(p.operationId || "")
    if (!/^[A-Za-z0-9_-]{8,40}$/.test(value)) fail("Unprocessable", "Reload the page and try again")
    return value
}

// ---- Billing: an invoice and its payment ----

function invoiceView(invoiceId) {
    const invoice = one(I, {invoiceId})
    const totals = lib.totals(invoice),
        currency = invoice.currencyUomId
    const lines = rows("mantle.account.invoice.InvoiceItem", {invoiceId})
        .sort((a, b) => String(a.invoiceItemSeqId).localeCompare(String(b.invoiceItemSeqId)))
        .map(line => ({
            description: line.description || "",
            quantity: text(line.quantity ?? 1),
            amountText: moneyText(line.amount ?? 0, currency),
            totalText: moneyText(lib.lineTotal(line, currency), currency)
        }))
    const paid = totals.invoiceTotal.subtract(totals.unpaidTotal)
    return {
        invoiceId,
        fromName: name(invoice.fromPartyId),
        toName: name(invoice.toPartyId),
        invoiceDateText: day(invoice.invoiceDate),
        dueDateText: day(invoice.dueDate),
        currencyUomId: currency,
        statusText: totals.unpaidTotal.compare(0) <= 0 ? "Paid" : "Open",
        lines,
        totalText: moneyText(totals.invoiceTotal, currency),
        paidText: moneyText(paid, currency),
        dueText: moneyText(totals.unpaidTotal, currency),
        due: text(money(totals.unpaidTotal, currency))
    }
}
// The organization's invoice payment gateway, when it has one bound and enabled.
function payGateway(organizationPartyId) {
    const gatewayId = lib.policy.preference(organizationPartyId).invoicePayGatewayConfigId
    if (!gatewayId) return null
    const binding = rows("mantle.account.method.PaymentGatewayOrganization", {
        organizationPartyId,
        paymentGatewayConfigId: gatewayId
    }).find(row => row.isEnabled !== "N" && lib.entityLib.active(row))
    return binding ? gatewayId : null
}
// The payments started from these pages (PortalPaymentAttempt), newest first: never one made in Accounting for the
// same invoice, which a pay link's holder must not see, refresh or capture.
const ATT = "mantle.account.payment.PortalPaymentAttempt"
function attempts(invoiceId) {
    return rows(ATT, {invoiceId})
        .sort((a, b) => lib.ms(b.createdDate) - lib.ms(a.createdDate))
        .map(row => one(P, {paymentId: row.paymentId}))
        .filter(Boolean)
}
const pending = row => ["PmntPromised", "PmntAuthorized"].includes(row.statusId)
// A gateway answer of the payment that was lost and not looked up yet: the gateway may have charged it, so it is pending
// and looked up, never cancelled or tried again.
const unknownOpen = paymentId =>
    find(R)
        .condition("paymentId", paymentId)
        .condition("resultUnknown", "Y")
        .condition("outcomeResolvedDate", "is-null", null)
        .count() > 0
const redirectOf = paymentId =>
    Array.from(find(R, {paymentId}).orderBy("-transactionDate").limit(10).list()).find(row => row.redirectUrl)?.redirectUrl || null
function attemptView(payment) {
    const state = ["PmntDelivered", "PmntConfirmed"].includes(payment.statusId)
        ? "paid"
        : payment.statusId === "PmntDeclined"
          ? "declined"
          : pending(payment)
            ? "pending"
            : "failed"
    const redirectUrl = state === "pending" ? redirectOf(payment.paymentId) : null
    return {
        attemptId: payment.paymentId,
        state,
        amountText: moneyText(payment.amount, payment.amountUomId),
        dateText: day(payment.effectiveDate),
        reference: state === "paid" ? payment.paymentRefNum || payment.paymentId : null,
        redirectUrl: redirectUrl && /^(https:\/\/|\/(?!\/))/.test(redirectUrl) ? redirectUrl : null,
        nextAction: state === "pending" ? (redirectUrl ? "continue" : "wait") : state === "paid" ? "none" : "retry"
    }
}
function checkInvoice(p, recordId = p.invoiceId) {
    const organizationPartyId = served(p.siteId, "billing")
    return access.check({token: p.token, scope: "InvoicePay", recordType: "Invoice", recordId, organizationPartyId})
}
// The gateway calls for one checked portal payment run with it named to the posting guard (PostingGuard.PORTAL_PAYMENT),
// which lets that payment's own posting through the user's organization check, as no user of the organization makes it.
const PORTAL_PAYMENT = ec.resource.script("component://mr-mantle/service/mantle/ledger/PostingGuard.js").PORTAL_PAYMENT
function asPortalPayment(paymentId, work) {
    const shared = ec.context.sharedMap,
        before = shared[PORTAL_PAYMENT]
    shared[PORTAL_PAYMENT] = paymentId
    try {
        return work()
    } finally {
        if (before == null) delete shared[PORTAL_PAYMENT]
        else shared[PORTAL_PAYMENT] = before
    }
}
// How long an attempt with no reference yet may wait (the gateway may still be answering), and how long a hosted attempt
// may stay pending before it is taken as abandoned.
const STARTING_MS = 5 * 60000,
    ABANDONED_MS = 7 * 86400000
// Whether a pending attempt has failed without asking the gateway: nothing to ask and no page after its start-up grace,
// or pending past the abandonment cutoff.
function failedWithoutAnswer(payment, attempt) {
    const age = Date.now() - (lib.ms(attempt?.createdDate) ?? 0)
    if (unknownOpen(payment.paymentId)) return false
    if (age > ABANDONED_MS) return true
    return !payment.paymentRefNum && !redirectOf(payment.paymentId) && age > STARTING_MS
}
// Record when an attempt stopped being pending, which bounds how long its return reference reads it.
function settle(paymentId) {
    const payment = one(P, {paymentId}),
        attempt = one(ATT, {paymentId})
    if (attempt && !attempt.settledDate && !pending(payment))
        call("update#" + ATT, {paymentId, settledDate: ec.user.nowTimestamp})
    return payment
}
// Look the gateway up for a pending portal payment, under its lock, and capture an authorization: the outcome is the
// gateway's, never what the payer's browser carries back. An attempt that failed without an answer is cancelled.
function refresh(paymentId) {
    const payment = find(P, {paymentId}).forUpdate(true).one()
    if (!pending(payment)) return settle(paymentId)
    if (failedWithoutAnswer(payment, one(ATT, {paymentId}))) {
        call("update#" + P, {paymentId, statusId: "PmntCancelled"})
        return settle(paymentId)
    }
    if (!payment.paymentRefNum && !unknownOpen(paymentId)) return payment
    asPortalPayment(paymentId, () => {
        try {
            call("mantle.account.PaymentServices.get#SinglePaymentGatewayDetails", {paymentId})
        } catch (error) {
            ec.message.clearErrors()
            ec.logger.warn("Invoice payment " + paymentId + " lookup failed: " + String(error.message).split("\n")[0])
        }
        if (one(P, {paymentId}).statusId === "PmntAuthorized")
            call("mantle.account.PaymentServices.capture#SinglePayment", {paymentId, operationKey: "pay-capture-" + paymentId})
    })
    return settle(paymentId)
}
// The invoice's attempt still pending after asking the gateway, or null.
function openAttempt(invoiceId) {
    for (const payment of attempts(invoiceId).filter(pending)) {
        const after = refresh(payment.paymentId)
        if (pending(after)) return after
    }
    return null
}
function getInvoice(p) {
    const checked = checkInvoice(p)
    const invoice = one(I, {invoiceId: checked.recordId})
    const gatewayId = payGateway(checked.organizationPartyId)
    const open = openAttempt(invoice.invoiceId)
    const view = invoiceView(invoice.invoiceId)
    return {
        invoice: view,
        attempt: open ? attemptView(open) : null,
        capabilities: {canPay: !!gatewayId && toDecimal(view.due).compare(0) > 0, canShare: checked.via === "contact"}
    }
}
// The invoices of the customers the signed-in user is a Billing contact of, from the organization the site serves.
function findInvoices(p) {
    const organizationPartyId = served(p.siteId, "billing")
    if (!ec.user.userId) fail("AuthenticationRequired", "Sign in to see your invoices")
    const parties = access.contactParties(organizationPartyId, "billing")
    if (!parties.length) return {invoiceList: []}
    const list = Array.from(
        find(I)
            .condition("fromPartyId", organizationPartyId)
            .condition("toPartyId", "in", parties)
            .condition("statusId", "in", issued)
            .orderBy("-invoiceDate")
            .orderBy("invoiceId")
            .limit(50)
            .list()
    )
    return {
        invoiceList: list.map(row => {
            const view = invoiceView(row.invoiceId)
            return {
                invoiceId: row.invoiceId,
                toName: view.toName,
                invoiceDateText: view.invoiceDateText,
                dueDateText: view.dueDateText,
                totalText: view.totalText,
                dueText: view.dueText,
                statusText: view.statusText
            }
        })
    }
}
// A pay link to share: a Billing contact gets a new capability for an invoice of a customer it is a contact of. An
// internal user (send#Invoice) gets one with RECEIVABLE_EDIT in the invoice's organization, on its first published
// Billing site. A new link replaces the invoice's earlier ones.
function issueInvoiceAccess(p) {
    let siteId
    if (p.siteId) {
        if (checkInvoice(p).via !== "contact") unavailable()
        siteId = p.siteId
    } else {
        siteId = apps.sitesFor("billing", access.requireIssuer("Invoice", p.invoiceId).organizationPartyId)[0]
        if (!siteId) return {issued: false}
    }
    // a contact's link ends its own earlier links, the organization's its own: a contact never ends the emailed link
    const issuerKind = p.siteId ? "contact" : "organization"
    access.revokeActive("Invoice", p.invoiceId, "InvoicePay", issuerKind)
    const created = access.create({recordType: "Invoice", recordId: p.invoiceId, scopes: "InvoicePay", validDays: 120, issuerKind})
    const url = apps.pageUrl(siteId, "billing", "/InvoicePay?token=" + encodeURIComponent(created.token))
    return {issued: !!url, capabilityId: created.capabilityId, token: created.token, url, expiresAt: created.thruDate}
}
// The attempt to pay, in a transaction of its own under the invoice's lock, so the gateway is not called holding it: a
// retried request answers its attempt, an attempt still pending is resumed, else a promised card payment for what is
// due and its PortalPaymentAttempt, with the reference the gateway's return will carry (returnKey, shown once).
function beginPayment(p) {
    const invoice = find(I, {invoiceId: p.invoiceId}).forUpdate(true).one()
    const operation = lib.entityLib.operation({operationKey: p.operationId}, "InvoicePayStart", p.organizationPartyId, {
        invoiceId: invoice.invoiceId
    })
    if (operation.old) return Object.assign(lib.previous(operation), {alreadyApplied: true})
    // an attempt still pending is resumed; start#InvoicePayment asks its gateway after this transaction, not under the
    // invoice's lock. One that failed without an answer is cancelled here, which needs no gateway.
    for (const payment of attempts(invoice.invoiceId).filter(pending)) {
        if (!failedWithoutAnswer(payment, one(ATT, {paymentId: payment.paymentId})))
            return {attemptId: payment.paymentId, resumed: true}
        call("update#" + P, {paymentId: payment.paymentId, statusId: "PmntCancelled"})
        settle(payment.paymentId)
    }
    const due = lib.totals(invoice).unpaidTotal
    if (due.compare(0) <= 0) fail("Conflict", "Nothing is due on this invoice")
    const paymentId = call("mantle.account.PaymentServices.create#Payment", {
        fromPartyId: invoice.toPartyId,
        toPartyId: invoice.fromPartyId,
        paymentTypeEnumId: "PtInvoicePayment",
        paymentInstrumentEnumId: "PiCreditCard",
        paymentGatewayConfigId: p.gatewayId,
        forInvoiceId: invoice.invoiceId,
        amount: money(due, invoice.currencyUomId),
        amountUomId: invoice.currencyUomId,
        statusId: "PmntPromised",
        effectiveDate: ec.user.nowTimestamp,
        comments: "Paid from the invoice's Billing page"
    }).paymentId
    const returnKey = ec.user.randomString(40)
    call("create#" + ATT, {
        paymentId,
        invoiceId: invoice.invoiceId,
        siteId: p.siteId,
        capabilityId: p.capabilityId,
        contactPartyId: p.capabilityId ? null : ec.user.userAccount?.partyId,
        returnKeyDigest: ec.user.singleUseCodeHash(returnKey),
        createdDate: ec.user.nowTimestamp
    })
    lib.complete(operation, P, paymentId, {attemptId: paymentId, resumed: false})
    return {attemptId: paymentId, resumed: false, returnKey}
}
function startInvoicePayment(p) {
    const checked = checkInvoice(p)
    const key = operationId(p)
    if (!(p.confirm === true || p.confirm === "true")) fail("Unprocessable", "Confirm the payment")
    const gatewayId = payGateway(checked.organizationPartyId)
    if (!gatewayId) fail("Unavailable", "Payment is not available for this invoice")
    const begun = ec.service
        .sync()
        .throwOnError(true)
        .name("mantle.account.PortalServices.begin#InvoicePayment")
        .parameters({
            input: {
                invoiceId: checked.recordId,
                organizationPartyId: checked.organizationPartyId,
                siteId: p.siteId,
                capabilityId: checked.capabilityId,
                gatewayId,
                operationId: key
            }
        })
        .requireNewTransaction(true)
        .call().result
    const paymentId = begun.attemptId
    if (!begun.returnKey)
        return {attempt: attemptView(refresh(paymentId)), resumed: !!begun.resumed, alreadyApplied: !!begun.alreadyApplied}
    // a new attempt: the gateway, under the payment's lock only
    find(P, {paymentId}).forUpdate(true).one()
    const returnUrl = apps.pageUrl(
        p.siteId,
        "billing",
        "/InvoicePay/return?attemptId=" + encodeURIComponent(paymentId) + "&key=" + encodeURIComponent(begun.returnKey)
    )
    asPortalPayment(paymentId, () => {
        const auth = call("mantle.account.PaymentServices.authorize#SinglePayment", {
            paymentId,
            operationKey: "pay-auth-" + paymentId,
            returnUrl
        })
        const payment = one(P, {paymentId})
        const response = auth.paymentGatewayResponseId && one(R, {paymentGatewayResponseId: auth.paymentGatewayResponseId})
        // a pending answer keeps its reference, which the gateway's details service looks up
        if (pending(payment) && response?.referenceNum && !payment.paymentRefNum)
            call("update#" + P, {paymentId, paymentRefNum: response.referenceNum})
        if (payment.statusId === "PmntAuthorized")
            call("mantle.account.PaymentServices.capture#SinglePayment", {paymentId, operationKey: "pay-capture-" + paymentId})
    })
    // pending with nothing to look up and no page to go to: failed, not left to be resumed
    const after = one(P, {paymentId})
    if (pending(after) && !after.paymentRefNum && !redirectOf(paymentId) && !unknownOpen(paymentId))
        call("update#" + P, {paymentId, statusId: "PmntCancelled"})
    return {attempt: attemptView(settle(paymentId)), resumed: false}
}
// An attempt's outcome, for its invoice's link or contact, or for the reference its gateway return carries (returnKey),
// which reads this attempt and its invoice only, on the site it was started from.
const RETURN_READ_MS = 86400000
function getPaymentResult(p) {
    const row = p.attemptId && one(ATT, {paymentId: p.attemptId})
    if (!row) unavailable()
    if (p.returnKey) {
        // the reference reads while the attempt is pending or for a day after it settled, and only while the invoice can
        // still be reached (issued, not cancelled), on the organization's site it came from
        const organizationPartyId = served(p.siteId, "billing")
        const record = access.recordOf("Invoice", row.invoiceId)
        const settledLongAgo = row.settledDate && Date.now() - lib.ms(row.settledDate) > RETURN_READ_MS
        if (
            row.siteId !== p.siteId ||
            row.returnKeyDigest !== ec.user.singleUseCodeHash(String(p.returnKey)) ||
            record?.organizationPartyId !== organizationPartyId ||
            settledLongAgo
        )
            unavailable()
    } else checkInvoice(p, row.invoiceId)
    return {attempt: attemptView(refresh(row.paymentId)), invoice: invoiceView(row.invoiceId)}
}
// The job (resolve_PortalPayments): the portal payments still pending, oldest first, each asked of its gateway in its own
// transaction; one that fails is named and the rest go on.
function resolvePending(p) {
    // the portal attempts not yet settled, oldest first (no other payment is read)
    const ids = Array.from(
        find(ATT)
            .condition("settledDate", "is-null", null)
            .orderBy("createdDate")
            .limit(Number(p.limit || 200))
            .list()
    ).map(row => row.paymentId)
    let resolved = 0,
        failed = 0
    for (const paymentId of ids) {
        try {
            ec.service
                .sync()
                .throwOnError(true)
                .name("mantle.account.PortalServices.refresh#PortalPayment")
                .parameters({input: {paymentId}})
                .requireNewTransaction(true)
                .call()
            if (!pending(one(P, {paymentId}))) resolved++
        } catch (error) {
            ec.message.clearErrors()
            failed++
            ec.logger.error("Portal payment " + paymentId + " was not resolved: " + String(error.message).split("\n")[0])
        }
    }
    return {checked: ids.length, resolved, failed}
}

// ---- Supplier: a purchase order's bill ----

function checkOrder(p) {
    const organizationPartyId = served(p.siteId, "supplier")
    return access.check({token: p.token, scope: "BillUpload", recordType: "Order", recordId: p.orderId, organizationPartyId})
}
function orderView(orderId) {
    const order = one("mantle.order.OrderHeader", {orderId})
    return {
        orderId,
        orderName: order.orderName || null,
        placedDateText: day(order.placedDate || order.entryDate),
        totalText: order.grandTotal == null ? null : moneyText(order.grandTotal, order.currencyUomId),
        currencyUomId: order.currencyUomId
    }
}
function submissionView(row) {
    const invoice = row.invoiceId && one(I, {invoiceId: row.invoiceId})
    const state = !invoice
        ? "Received"
        : invoice.statusId === "InvoiceCancelled"
          ? "Not accepted"
          : ["InvoiceIncoming", "InvoiceReceived"].includes(invoice.statusId)
            ? "Received for review"
            : "Accepted for payment"
    return {
        submissionId: row.submissionId,
        orderId: row.orderId,
        referenceNumber: row.referenceNumber,
        billReference: row.invoiceId,
        receivedDateText: lib.entityLib.dateText(row.receivedDate),
        filename: row.filename,
        stateText: state
    }
}
function submissions(checked) {
    return Array.from(
        find(SUB, {organizationPartyId: checked.organizationPartyId, supplierPartyId: checked.partyId, orderId: checked.recordId})
            .orderBy("-receivedDate")
            .limit(20)
            .list()
    ).map(submissionView)
}
function getSubmission(p) {
    const checked = checkOrder(p)
    const list = submissions(checked)
    let submission = null
    if (p.submissionId) {
        submission = list.find(row => row.submissionId === p.submissionId) || null
        if (!submission) unavailable()
    }
    return {order: orderView(checked.recordId), submissionList: list, submission}
}
// Stage the file under PASS's media root and scan it, as Forum stages an attachment; refuse it unless it is clean. The rules
// are the shared PortalMedia.js (F58, Customer Service P15); noun names the file in the refusals (Purchasing's quote and
// acknowledgement files use it too, P16), a bill kept under bills/, the supplier's other files under supplier/.
function stage(file, noun = "bill") {
    return ec.resource
        .script("component://mr-mantle/service/mantle/party/PortalMedia.js")
        .stage(file, noun, noun === "bill" ? "bills" : "supplier")
}
function submitSupplierBill(p) {
    const checked = checkOrder(p)
    const key = operationId(p)
    // the organization first, as import#Bill locks it, so two submissions of one reference are serialized
    find("mantle.party.Party", {partyId: checked.organizationPartyId}).forUpdate(true).one()
    const scope = {organizationPartyId: checked.organizationPartyId, supplierPartyId: checked.partyId}
    const repeat = rows(SUB, {...scope, operationId: key})[0]
    if (repeat) return {submission: submissionView(repeat), alreadyApplied: true}
    const reference = String(p.referenceNumber || "").trim()
    if (!reference || reference.length > 60) fail("Unprocessable", "Enter your bill number")
    const earlier = rows(SUB, {...scope, referenceNumber: reference})[0]
    if (earlier) return {submission: submissionView(earlier), alreadyApplied: true}
    const order = one("mantle.order.OrderHeader", {orderId: checked.recordId})
    let amount = null
    if (p.amount != null && String(p.amount).trim() !== "")
        try {
            amount = lib.amount(p.amount, order.currencyUomId)
        } catch (error) {
            fail("Unprocessable", "Enter the bill's amount in " + order.currencyUomId)
        }
    let invoiceDate = null
    if (p.invoiceDate != null && String(p.invoiceDate).trim() !== "") {
        const millis = lib.ms(p.invoiceDate)
        if (millis == null || !Number.isFinite(millis)) fail("Unprocessable", "Enter the bill date as a date")
        invoiceDate = new Date(millis)
    }
    const staged = stage(p.file)
    let imported
    try {
        imported = ec.resource
            .script("component://mr-mantle/service/mantle/account/Payables.js")
            .execute("portalBill", {
                ...scope,
                referenceNumber: reference,
                invoiceDate,
                amount,
                currencyUomId: order.currencyUomId,
                orderId: checked.recordId,
                orderPartSeqId: checked.orderPartSeqId,
                description: "Bill " + reference + " for order " + checked.recordId,
                stagedLocation: staged.location,
                stagedFilename: staged.filename,
                fileDescription: "Supplier bill " + reference
            })
    } catch (error) {
        if (lib.entityLib.reasonCode(error) === "BILL_DUPLICATE")
            fail("Conflict", "Bill " + reference + " was already received; contact the buyer if it needs a change")
        throw error
    } finally {
        try {
            ec.resource.getLocationReference(staged.location).delete()
        } catch (error) {
            ec.logger.warn("Staged supplier bill file " + staged.location + " was not removed")
        }
    }
    const row = call("create#" + SUB, {
        ...scope,
        orderId: checked.recordId,
        capabilityId: checked.capabilityId,
        operationId: key,
        referenceNumber: reference,
        invoiceId: imported.invoiceId,
        attached: imported.attached ? "Y" : "N",
        filename: staged.filename,
        byteSize: staged.byteSize,
        receivedDate: ec.user.nowTimestamp,
        submittedByUserId: ec.user.userId
    })
    return {submission: submissionView(one(SUB, {submissionId: row.submissionId})), alreadyApplied: false}
}

// ---- Readiness of a site's Billing or Supplier app ----

function appReadiness(p) {
    const checks = [{name: "organization", ready: !!p.targetId && apps.targets.organization(p.targetId)}]
    if (p.app === "billing")
        checks.push({name: "payment gateway", ready: !!p.targetId && checks[0].ready && !!payGateway(p.targetId)})
    if (p.app === "supplier")
        checks.push({
            name: "bill scanning",
            ready: !!System.getProperty("pass_scanner_service") && !!System.getProperty("pass_media_root")
        })
    checks.push({name: "canonical host", ready: !!apps.pageUrl(p.siteId, p.app, "/")})
    return {checks}
}

const operations = {
    beginPayment,
    resolvePending,
    refreshPayment: p => ({statusId: refresh(p.paymentId).statusId}),
    getInvoice,
    findInvoices,
    issueInvoiceAccess,
    startInvoicePayment,
    getPaymentResult,
    getSubmission,
    submitSupplierBill,
    appReadiness
}
;({
    execute(op, input) {
        if (!operations[op]) fail("NotFound", "Unknown portal operation")
        // the checks above are this module's; Mantle's reads and writes below them run without artifact authorization
        const was = ec.artifactExecution.disableAuthz()
        try {
            return operations[op](input || {})
        } finally {
            if (!was) ec.artifactExecution.enableAuthz()
        }
    },
    // P16: Purchasing's supplier pages stage their files the same way (SupplierPortal.js)
    stage
})
