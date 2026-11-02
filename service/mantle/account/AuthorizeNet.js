// This software is in the public domain under CC0 1.0 Universal plus a
// Grant of Patent License.
//
// To the extent possible under law, the author(s) have dedicated all
// copyright and related and neighboring rights to this software to the
// public domain worldwide. This software is distributed without any
// warranty.
//
// You should have received a copy of the CC0 Public Domain Dedication
// along with this software (see the LICENSE.md file). If not, see
// <http://creativecommons.org/publicdomain/zero/1.0/>.

// Authorize.Net payment gateway (plan/payments-shipping-edi.md P1): the operations behind AuthorizeNetServices.xml. Ported
// from the Java Moqui AuthorizeDotNet component (github.com/moqui/AuthorizeDotNet, 1.2.5, commit eaa351c: its CIM
// payment and profile services and its transaction status mapping), moved from AIM name/value and CIM XML requests to the
// current Authorize.Net JSON API (createTransactionRequest, customer profiles, transaction reporting), with browser
// tokens (Accept.js opaqueData) instead of card numbers sent from the server.
//
// The gateway contract is mantle.account.PaymentServices.authorize#Payment's: one PaymentGatewayResponse per call, no
// Payment change, a lost answer recorded as resultUnknown (never thrown), and get#PaymentGatewayDetails answering
// operationFound for a lost one. Authorize.Net has no idempotency key: the idempotency key's first 20 characters go in
// refId and order.invoiceNumber, and a lookup finds the transaction by them. Card data, tokens and credentials are never
// recorded or logged; the request bodies are not logged at all.
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const G = ec.resource.script("component://mr-mantle/service/mantle/account/GatewayLib.js")
const {one, rows, find, call} = lib
const {clip, record, refuse, describe, isRefund, authorizedTransaction} = G
const P = "mantle.account.payment.Payment",
    PM = "mantle.account.method.PaymentMethod",
    R = "mantle.account.method.PaymentGatewayResponse",
    CONFIG = "mantle.account.method.PaymentGatewayConfig",
    OPTIONS = "mantle.account.method.PaymentGatewayAuthorizeNet",
    REMOTE = "moqui.service.message.SystemMessageRemote"
const REF_LENGTH = 20
// Authorize.Net's default duplicate window is 120 seconds; a lost request is judged not done only after that and more
const GRACE_SECONDS = 300
const GRACE_MARGIN_SECONDS = 60
const PAGE_LIMIT = 1000
const MAX_PAGES = 5
const SETTLED_DAYS = 31

// ---- Mappings ----

// The Authorize.Net transaction status and the Payment status it means. A payment (or an authorization and capture)
// and a refund payment read the same status differently. From the source's get#PaymentGatewayDetails map, with
// failedReview a decline and a voided capture left alone (it was refunded by a void, see refund below).
const paymentStatus = {
    authorizedPendingCapture: "PmntAuthorized",
    capturedPendingSettlement: "PmntDelivered",
    pendingSettlement: "PmntDelivered",
    pendingFinalSettlement: "PmntDelivered",
    updatingSettlement: "PmntDelivered",
    settledSuccessfully: "PmntConfirmed",
    declined: "PmntDeclined",
    failedReview: "PmntDeclined",
    expired: "PmntPromised"
}
const refundStatus = {
    refundPendingSettlement: "PmntDelivered",
    refundSettledSuccessfully: "PmntConfirmed",
    declined: "PmntDeclined",
    voided: "PmntVoid"
}
const capturedStatuses = [
    "capturedPendingSettlement",
    "pendingSettlement",
    "pendingFinalSettlement",
    "updatingSettlement",
    "settledSuccessfully"
]
// Reason codes of a transaction response (transactionResponse.errors errorCode), as the source's AIM mapping.
const badCardNumber = ["6", "37", "315"]
const badExpire = ["7", "8", "316", "317"]
const DUPLICATE = "11"
const ALREADY_VOIDED = "310"
const ALREADY_CAPTURED = "311"
const cardTypes = {
    Visa: "CctVisa",
    MasterCard: "CctMastercard",
    AmericanExpress: "CctAmericanExpress",
    Discover: "CctDiscover",
    JCB: "CctJcb",
    DinersClub: "CctDinersClub"
}

// ---- Configuration and transport ----

// The gateway's config, options and connection; problem says why it cannot be used.
function gateway(paymentGatewayConfigId) {
    const config = paymentGatewayConfigId && one(CONFIG, {paymentGatewayConfigId})
    const options = config && one(OPTIONS, {paymentGatewayConfigId})
    const remote = config?.systemMessageRemoteId && one(REMOTE, {systemMessageRemoteId: config.systemMessageRemoteId})
    let problem = null
    if (!config || config.paymentGatewayTypeEnumId !== "PgtAuthorizeNet")
        problem = "Gateway " + paymentGatewayConfigId + " is not an Authorize.Net gateway"
    else if (!remote) problem = "Gateway " + paymentGatewayConfigId + " has no connection (SystemMessageRemote)"
    else if (!remote.sendUrl || !remote.username || !remote.password)
        problem = "The connection " + remote.systemMessageRemoteId + " needs its API endpoint, API login id and transaction key"
    return {id: paymentGatewayConfigId, label: "Authorize.Net", config, options: options || {}, remote, problem}
}

const reference = idempotencyKey => (idempotencyKey ? String(idempotencyKey).slice(0, REF_LENGTH) : null)

// Send one API request. The body's fields are in the schema's order (the JSON API is checked as XML); the credentials go
// first. Answers {data} with the parsed answer, or {unknown} when the request may have gone and no readable answer came
// back, or {refused} when the provider refused it at the HTTP level before acting.
function send(gw, requestName, body) {
    const request = {
        [requestName]: Object.assign(
            {merchantAuthentication: {name: gw.remote.username, transactionKey: gw.remote.password}},
            body
        )
    }
    let response
    try {
        response = ec.service.rest().method("POST").uri(gw.remote.sendUrl).timeout(40).jsonObject(JSON.stringify(request)).call()
    } catch (error) {
        return {unknown: "No answer from Authorize.Net: " + clip(error?.message ?? error, 200)}
    }
    const status = response.getStatusCode()
    if (status >= 400 && status < 500) return {refused: "Authorize.Net refused the request (HTTP " + status + ")"}
    if (status !== 200) return {unknown: "Authorize.Net answered HTTP " + status}
    // the JSON answers start with a byte order mark
    const text = String(response.text() || "").replace(/^﻿/, "")
    try {
        return {data: JSON.parse(text)}
    } catch (_) {
        return {unknown: "Authorize.Net answered with unreadable JSON"}
    }
}

// The answer's overall result: ok, and its first message code and text.
function resultOf(data) {
    const messages = data?.messages || {}
    const first = [].concat(messages.message || [])[0] || {}
    return {ok: messages.resultCode === "Ok", code: first.code || null, text: first.text || null}
}

// An amount as the API's decimal text, rounded to its currency; refused (null) when finer than the currency or
// than the two places the API takes.
function amountText(value, currencyUomId) {
    const amount = G.providerAmount(value, currencyUomId, 2)
    return amount == null ? null : String(amount)
}

// ---- Responses ----

// A transaction answer (createTransactionResponse) as a response: approved (1), declined (2), error (3), held for review
// (4, pending), with the source's reason code mapping; a duplicate refusal (11) means an earlier request may have gone,
// so it is unknown and looked up by its reference.
function transactionFields(data, operationEnumId) {
    const result = resultOf(data)
    const response = data.transactionResponse
    if (!response?.responseCode)
        return {resultError: "Y", responseCode: result.ok ? "Ok" : "Error", reasonCode: result.code, reasonMessage: result.text}
    const code = String(response.responseCode)
    const error = [].concat(response.errors || [])[0]
    const message = [].concat(response.messages || [])[0]
    const reasonCode = error?.errorCode ?? message?.code ?? result.code
    const fields = {
        responseCode: code,
        reasonCode: reasonCode == null ? null : String(reasonCode),
        reasonMessage: error?.errorText ?? message?.description ?? result.text,
        referenceNum: response.transId && response.transId !== "0" ? String(response.transId) : null,
        approvalCode: response.authCode || null,
        avsResult: response.avsResultCode || null,
        cvResult: response.cvvResultCode || null
    }
    const already =
        (operationEnumId === "PgoCapture" && fields.reasonCode === ALREADY_CAPTURED) ||
        (operationEnumId === "PgoRelease" && fields.reasonCode === ALREADY_VOIDED)
    if (code === "1" || already) fields.resultSuccess = "Y"
    else if (badCardNumber.includes(fields.reasonCode)) fields.resultBadCardNumber = "Y"
    else if (badExpire.includes(fields.reasonCode)) fields.resultBadExpire = "Y"
    else if (code === "2") fields.resultDeclined = "Y"
    else if (code === "3" && fields.reasonCode === DUPLICATE) fields.resultUnknown = "Y"
    else if (code === "3") fields.resultError = "Y"
    else if (code === "4") fields.transactionStatus = "held"
    return {fields, accountNumber: response.accountNumber, accountType: response.accountType}
}
function transact(base, body) {
    const sent = send(base.gw, "createTransactionRequest", body)
    if (sent.unknown) {
        ec.logger.warn("Authorize.Net " + base.operationEnumId + " of payment " + base.payment.paymentId + ": outcome unknown")
        return {paymentGatewayResponseId: record(base, {resultUnknown: "Y", reasonMessage: sent.unknown})}
    }
    if (sent.refused) return {paymentGatewayResponseId: record(base, {resultError: "Y", reasonMessage: sent.refused})}
    const mapped = transactionFields(sent.data, base.operationEnumId)
    const fields = mapped.fields || mapped
    return {paymentGatewayResponseId: record(base, fields), accountNumber: mapped.accountNumber, accountType: mapped.accountType}
}

// ---- Payment operations ----

function start(p, operationEnumId, amount) {
    return G.start(p, gateway(p.paymentGatewayConfigId), operationEnumId, amount)
}

// authorize#Payment and authorizeAndCapture#Payment (sale): a single-use browser token, else the payment method's
// customer payment profile. A card number the server holds is never sent.
function authorize(p, sale) {
    const {payment, gw, base, problem} = start(p, sale ? "PgoAuthAndCapture" : "PgoAuthorize")
    if (problem) return refuse(base, "GATEWAY_NOT_AVAILABLE", problem)
    const amount = amountText(payment.amount, payment.amountUomId)
    if (!amount) return refuse(base, "AMOUNT_INVALID", "The amount does not suit the currency or Authorize.Net")
    const token = p.paymentToken || {}
    const method = payment.paymentMethodId && one(PM, {paymentMethodId: payment.paymentMethodId})
    const request = {
        transactionType: sale ? "authCaptureTransaction" : "authOnlyTransaction",
        amount,
        currencyCode: payment.amountUomId
    }
    if (token.dataDescriptor && token.dataValue) {
        request.payment = {opaqueData: {dataDescriptor: String(token.dataDescriptor), dataValue: String(token.dataValue)}}
    } else if (method?.gatewayCimId && method.gatewayCustomerId && method.paymentGatewayConfigId === gw.id) {
        const paymentProfile = {paymentProfileId: method.gatewayCimId}
        if (p.cardSecurityCode) paymentProfile.cardCode = String(p.cardSecurityCode)
        request.profile = {customerProfileId: method.gatewayCustomerId, paymentProfile}
    } else {
        return refuse(
            base,
            "NO_PAYMENT_PROFILE",
            "No Authorize.Net payment profile or browser token for this payment; card numbers are not sent from the server"
        )
    }
    const refId = reference(p.idempotencyKey)
    request.order = {invoiceNumber: refId, description: describe(payment)}
    if (request.payment && payment.fromPartyId && String(payment.fromPartyId).length <= REF_LENGTH)
        request.customer = {id: payment.fromPartyId}
    const visit = payment.visitId && one("moqui.server.Visit", {visitId: payment.visitId})
    if (visit?.clientIpAddress) request.customerIP = visit.clientIpAddress
    if (gw.options.duplicateWindow != null)
        request.transactionSettings = {
            setting: [{settingName: "duplicateWindow", settingValue: String(gw.options.duplicateWindow)}]
        }
    return transact(base, {refId, transactionRequest: request})
}

function capture(p) {
    const {payment, base, problem} = start(p, "PgoCapture", p.amount)
    if (problem) return refuse(base, "GATEWAY_NOT_AVAILABLE", problem)
    const refTransId = authorizedTransaction(payment)
    if (!refTransId)
        return refuse(base, "NO_REFERENCE", "No authorization transaction to capture for payment " + payment.paymentId)
    const amount = amountText(p.amount ?? payment.amount, payment.amountUomId)
    if (!amount) return refuse(base, "AMOUNT_INVALID", "The amount does not suit the currency or Authorize.Net")
    return transact(base, {
        refId: reference(p.idempotencyKey),
        transactionRequest: {transactionType: "priorAuthCaptureTransaction", amount, refTransId}
    })
}

function release(p) {
    const {payment, base, problem} = start(p, "PgoRelease")
    if (problem) return refuse(base, "GATEWAY_NOT_AVAILABLE", problem)
    const refTransId = authorizedTransaction(payment)
    if (!refTransId) return refuse(base, "NO_REFERENCE", "No authorization transaction to void for payment " + payment.paymentId)
    return transact(base, {
        refId: reference(p.idempotencyKey),
        transactionRequest: {transactionType: "voidTransaction", refTransId}
    })
}

// refund#Payment, linked to the original transaction (refTransId); never an unlinked credit. Authorize.Net refunds only
// a settled transaction, so the settlement state decides: settled, a refund of any amount up to what is left; captured
// and not settled yet, a void of the whole amount (recorded as the refund, reasonCode VOID_BEFORE_SETTLEMENT: the money
// never moves, and the original stays Delivered with its refund applied); a partial refund before settlement is refused
// (REFUND_BEFORE_SETTLEMENT) and can be sent again after settlement.
function refund(p) {
    const {payment, gw, base, problem} = start(p, "PgoRefund", p.amount)
    if (problem) return refuse(base, "GATEWAY_NOT_AVAILABLE", problem)
    const transId = authorizedTransaction(payment)
    if (!transId) return refuse(base, "NO_REFERENCE", "No transaction to refund for payment " + payment.paymentId)
    const amount = amountText(p.amount ?? payment.amount, payment.amountUomId)
    if (!amount) return refuse(base, "AMOUNT_INVALID", "The amount does not suit the currency or Authorize.Net")
    const original = transactionDetails(gw, {transId})
    if (!original.transaction)
        return refuse(
            base,
            "DETAILS_UNAVAILABLE",
            "Could not read transaction " + transId + " before the refund: " + (original.problem || "not found")
        )
    const tx = original.transaction
    const refId = reference(p.idempotencyKey)
    if (tx.transactionStatus === "settledSuccessfully") {
        const request = {transactionType: "refundTransaction", amount, currencyCode: payment.amountUomId}
        if (tx.profile?.customerProfileId && tx.profile?.customerPaymentProfileId) {
            request.profile = {
                customerProfileId: tx.profile.customerProfileId,
                paymentProfile: {paymentProfileId: tx.profile.customerPaymentProfileId}
            }
        } else {
            const masked = String(tx.payment?.creditCard?.cardNumber || "")
            const last4 = masked.replace(/\D/g, "").slice(-4)
            if (last4.length !== 4)
                return refuse(base, "NO_CARD_REFERENCE", "Transaction " + transId + " has no card to refund to")
            request.payment = {creditCard: {cardNumber: last4, expirationDate: "XXXX"}}
        }
        request.refTransId = transId
        request.order = {invoiceNumber: refId, description: clip("Refund of " + describe(payment))}
        return transact(base, {refId, transactionRequest: request})
    }
    if (capturedStatuses.includes(tx.transactionStatus)) {
        const captured = toDecimal(tx.settleAmount ?? tx.authAmount ?? payment.amount)
        if (toDecimal(amount).compare(captured) !== 0 || G.otherRefundCount(payment, p.refundPaymentId) > 0)
            return refuse(
                base,
                "REFUND_BEFORE_SETTLEMENT",
                "Authorize.Net refunds a transaction after it settles; before that only the whole amount can be voided"
            )
        const voided = transact(base, {refId, transactionRequest: {transactionType: "voidTransaction", refTransId: transId}})
        const response = one(R, {paymentGatewayResponseId: voided.paymentGatewayResponseId})
        // the void's transaction id is the original's: kept as altReference, so the refund payment does not take it
        if (response.resultSuccess === "Y")
            call("update#" + R, {
                paymentGatewayResponseId: response.paymentGatewayResponseId,
                reasonCode: "VOID_BEFORE_SETTLEMENT",
                reasonMessage: "Voided before settlement: " + (response.reasonMessage || ""),
                altReference: response.referenceNum,
                referenceNum: null
            })
        return voided
    }
    return refuse(
        base,
        "TRANSACTION_NOT_REFUNDABLE",
        "Transaction " + transId + " is " + tx.transactionStatus + ", not refundable"
    )
}

// ---- Transaction details and lookups ----

// getTransactionDetails by transaction id or by the merchant reference (transrefId): {transaction}, {notFound}, or
// {problem} when it cannot tell.
function transactionDetails(gw, by) {
    const sent = send(gw, "getTransactionDetailsRequest", by.transId ? {transId: by.transId} : {transrefId: by.transrefId})
    if (sent.unknown || sent.refused) return {problem: sent.unknown || sent.refused}
    const result = resultOf(sent.data)
    if (result.ok && sent.data.transaction) return {transaction: sent.data.transaction}
    // E00040: the record was not found; E00011 and the others: it could not be read
    if (result.code === "E00040") return {notFound: true}
    return {problem: (result.code || "") + " " + (result.text || "")}
}
// Walks a transaction list's pages for one with the reference as its invoice number.
function findInList(gw, requestName, fields) {
    for (let page = 1; page <= MAX_PAGES; page++) {
        const body = Object.assign({}, fields.before || {}, {
            sorting: {orderBy: "submitTimeUTC", orderDescending: true},
            paging: {limit: PAGE_LIMIT, offset: page}
        })
        const sent = send(gw, requestName, body)
        if (sent.unknown || sent.refused) return {problem: sent.unknown || sent.refused}
        const result = resultOf(sent.data)
        if (!result.ok) return {problem: (result.code || "") + " " + (result.text || "")}
        const list = [].concat(sent.data.transactions || [])
        const match = list.find(row => row.invoiceNumber === fields.reference)
        if (match) return {transId: String(match.transId)}
        if (list.length < PAGE_LIMIT) return {}
    }
    return {problem: "More than " + MAX_PAGES * PAGE_LIMIT + " transactions to search"}
}
const utc = millis => {
    const date = new Date(millis)
    const two = n => String(n).padStart(2, "0")
    return (
        date.getUTCFullYear() +
        "-" +
        two(date.getUTCMonth() + 1) +
        "-" +
        two(date.getUTCDate()) +
        "T" +
        two(date.getUTCHours()) +
        ":" +
        two(date.getUTCMinutes()) +
        ":" +
        two(date.getUTCSeconds()) +
        "Z"
    )
}
// The transaction Mantle sent with this reference: by transrefId, then the unsettled transactions' invoice numbers,
// then those of the batches settled since the request. {transaction}, {notFound} when none has it, {problem} when a
// search could not be done.
function findByReference(gw, refId, sinceMillis) {
    const direct = transactionDetails(gw, {transrefId: refId})
    if (direct.transaction && (!direct.transaction.order?.invoiceNumber || direct.transaction.order.invoiceNumber === refId))
        return direct
    // the unsettled list leaves out transactions held for review, which pendingApproval lists
    for (const before of [{status: "pendingApproval"}, {}]) {
        const unsettled = findInList(gw, "getUnsettledTransactionListRequest", {before, reference: refId})
        if (unsettled.problem) return unsettled
        if (unsettled.transId) return transactionDetails(gw, {transId: unsettled.transId})
    }
    const now = Number(ec.user.nowTimestamp)
    const first = Math.max(Number(sinceMillis || now) - 86400000, now - SETTLED_DAYS * 86400000)
    const batches = send(gw, "getSettledBatchListRequest", {
        includeStatistics: false,
        firstSettlementDate: utc(first),
        lastSettlementDate: utc(now)
    })
    if (batches.unknown || batches.refused) return {problem: batches.unknown || batches.refused}
    const batchResult = resultOf(batches.data)
    // E00004 here: no batches in the range
    if (!batchResult.ok && batchResult.code !== "E00004") return {problem: batchResult.code + " " + batchResult.text}
    for (const batch of [].concat(batches.data.batchList || [])) {
        const found = findInList(gw, "getTransactionListRequest", {before: {batchId: String(batch.batchId)}, reference: refId})
        if (found.problem) return found
        if (found.transId) return transactionDetails(gw, {transId: found.transId})
    }
    return {notFound: true}
}

// How old a lost request must be before none found means not done: the configured grace, and always longer than the
// duplicate window, within which a resend would have been refused rather than recorded.
function graceSeconds(gw) {
    const configured = gw.options.lookupGraceSeconds ?? GRACE_SECONDS
    const window = gw.options.duplicateWindow
    const floor = window != null ? Number(window) + GRACE_MARGIN_SECONDS : 0
    return Math.max(Number(configured), floor)
}
// The Payment status a transaction's status means for this payment, or null to leave it as it is.
function statusFor(payment, tx) {
    const status = tx.transactionStatus
    if (isRefund(payment)) return refundStatus[status] || null
    // a voided authorization; a voided capture was a refund before settlement and stays Delivered with its refund
    if (status === "voided") return payment.statusId === "PmntAuthorized" ? "PmntVoid" : null
    return paymentStatus[status] || null
}
function settlementDate(tx) {
    const text = tx.batch?.settlementTimeUTC
    const millis = text ? Date.parse(text) : NaN
    return Number.isNaN(millis) ? null : new Date(millis)
}

// get#PaymentGatewayDetails. With an idempotency key, the lost operation's outcome (operationFound); without, the
// status of the payment's transaction. A status change is recorded as a PgoTxDetails response.
function details(p) {
    const payment = one(P, {paymentId: p.paymentId})
    const gw = gateway(p.paymentGatewayConfigId)
    if (!payment || gw.problem) {
        ec.message.addMessage(
            "Not getting Authorize.Net details for payment " + p.paymentId + ": " + (gw.problem || "not found"),
            "warning"
        )
        return {}
    }
    if (p.idempotencyKey) return resolve(gw, payment, p)
    if (!payment.paymentRefNum) return {}
    const got = transactionDetails(gw, {transId: payment.paymentRefNum})
    if (!got.transaction) {
        ec.message.addMessage(
            "Could not read Authorize.Net transaction " + payment.paymentRefNum + ": " + (got.problem || "not found"),
            "warning"
        )
        return {}
    }
    return detailsOut(gw, payment, got.transaction, statusFor(payment, got.transaction))
}
// The lookup's answer; a PgoTxDetails response records a change only: a status that differs from the payment's, or a
// transaction status other than the last one recorded (so a poll does not add a row each time).
function detailsOut(gw, payment, tx, gatewayStatusId, extra = {}) {
    const out = Object.assign(
        {
            gatewayStatusId,
            referenceNum: String(tx.transId),
            approvalCode: tx.authCode || null,
            settlementDate: settlementDate(tx)
        },
        extra
    )
    const statusChange = gatewayStatusId != null && gatewayStatusId !== payment.statusId
    if (statusChange || G.lastDetailsStatus(payment.paymentId) !== clip(tx.transactionStatus, 60))
        out.paymentGatewayResponseId = record(
            {gw, payment, operationEnumId: "PgoTxDetails", amount: payment.amount},
            {
                referenceNum: String(tx.transId),
                transactionStatus: clip(tx.transactionStatus, 60),
                responseCode: tx.responseCode == null ? null : String(tx.responseCode),
                reasonCode: tx.responseReasonCode == null ? null : String(tx.responseReasonCode),
                reasonMessage: tx.responseReasonDescription,
                resultDeclined: tx.transactionStatus === "declined" ? "Y" : "N"
            }
        )
    return out
}
// A lost operation: a capture or a void is looked up on the authorization's transaction, an authorization, sale or
// refund by its reference. Not found answers false only once the lost request is older than the grace period.
function resolve(gw, payment, p) {
    const op = p.paymentOperationEnumId
    if (op === "PgoCapture" || op === "PgoRelease") {
        const transId = authorizedTransaction(payment)
        const got = transId ? transactionDetails(gw, {transId}) : {problem: "no transaction"}
        if (!got.transaction) return {}
        const status = got.transaction.transactionStatus
        const done = op === "PgoCapture" ? capturedStatuses.includes(status) : status === "voided"
        // a found void: get#SinglePaymentGatewayDetails makes the payment promised again, without its references
        if (done && op === "PgoRelease") return {operationFound: true, gatewayStatusId: "PmntPromised"}
        if (done) return detailsOut(gw, payment, got.transaction, paymentStatus[status], {operationFound: true})
        if (status === "authorizedPendingCapture") return {operationFound: false, gatewayStatusId: payment.statusId}
        return {}
    }
    const lost = G.lostResponse(p.idempotencyKey)
    const found = findByReference(gw, reference(p.idempotencyKey), lost?.transactionDate)
    if (found.transaction) {
        const tx = found.transaction
        return detailsOut(gw, payment, tx, statusFor(payment, tx), {operationFound: true})
    }
    if (found.problem) return {}
    // a refund before settlement is a void of the original, which has no transaction of its own
    if (op === "PgoRefund" && payment.refundForPaymentId) {
        const original = one(P, {paymentId: payment.refundForPaymentId})
        const transId = original && authorizedTransaction(original)
        const got = transId ? transactionDetails(gw, {transId}) : {}
        if (got.problem) return {}
        if (got.transaction?.transactionStatus === "voided") return {operationFound: true, gatewayStatusId: "PmntDelivered"}
    }
    if (!G.pastGrace(lost, graceSeconds(gw))) return {}
    return {operationFound: false, gatewayStatusId: isRefund(payment) ? "PmntCancelled" : payment.statusId}
}

// ---- Customer and payment profiles ----

// The billing name and address of a payment method, in the schema's order (the source's billTo mapping).
function billTo(method, partyId) {
    const contact = G.billingContact(method, partyId)
    const values = {
        firstName: contact.firstName,
        lastName: contact.lastName,
        company: contact.company,
        address: contact.address1,
        city: contact.city,
        state: contact.stateCode,
        zip: contact.postalCode ? contact.postalCode + (contact.postalCodeExt ? "-" + contact.postalCodeExt : "") : null,
        country: contact.countryGeoId
    }
    const out = {}
    for (const [key, value] of Object.entries(values)) if (value) out[key] = clip(value, 50)
    return {customerType: contact.person ? "individual" : "business", billTo: Object.keys(out).length ? out : null}
}
// The customer profile of a party at this gateway: kept on its payment methods (gatewayCustomerId).
function customerProfileOf(partyId, gatewayId) {
    const methods = Array.from(
        find(PM, {ownerPartyId: partyId, paymentGatewayConfigId: gatewayId})
            .condition("gatewayCustomerId", "is-not-null", null)
            .list()
    )
    return methods.length ? methods[0].gatewayCustomerId : null
}
const duplicateId = text => (/ID (\d+)/.exec(String(text || "")) || [])[1] || null

// store#CustomerPaymentProfile: a reusable payment profile from a single-use browser token, on the party's customer
// profile at the gateway (made when it has none). The method keeps the profile references and the masked card only.
function storeProfile(p) {
    const gw = gateway(p.paymentGatewayConfigId)
    const method = p.paymentMethodId && one(PM, {paymentMethodId: p.paymentMethodId})
    const partyId = p.partyId || method?.ownerPartyId
    const base = {gw, operationEnumId: "PgoStoreCim", paymentMethodId: method?.paymentMethodId}
    const token = p.paymentToken || {}
    if (gw.problem) throw new Error("GATEWAY_NOT_AVAILABLE: " + gw.problem)
    if (!partyId) throw new Error("PARTY_REQUIRED: A payment profile needs the party it is for")
    if (method && method.ownerPartyId !== partyId) throw new Error("METHOD_NOT_OWNED: The payment method is another party's")
    if (method?.gatewayCimId && method.paymentGatewayConfigId === gw.id)
        return {
            paymentMethodId: method.paymentMethodId,
            gatewayCimId: method.gatewayCimId,
            gatewayCustomerId: method.gatewayCustomerId
        }
    if (!token.dataDescriptor || !token.dataValue)
        throw new Error("TOKEN_REQUIRED: A payment profile is made from a browser token")
    const payment = {opaqueData: {dataDescriptor: String(token.dataDescriptor), dataValue: String(token.dataValue)}}
    const bill = billTo(method, partyId)
    const paymentProfile = {customerType: bill.customerType}
    if (bill.billTo) paymentProfile.billTo = bill.billTo
    paymentProfile.payment = payment
    const validationMode = gw.options.validationMode || "none"
    let customerProfileId = customerProfileOf(partyId, gw.id)
    let paymentProfileId = null
    let sent
    if (!customerProfileId) {
        const email = p.emailAddress ? {email: clip(p.emailAddress)} : {}
        const profile = Object.assign(
            {merchantCustomerId: clip(partyId, REF_LENGTH), description: clip("Party " + partyId, 255)},
            email,
            {paymentProfiles: paymentProfile}
        )
        sent = send(gw, "createCustomerProfileRequest", {profile, validationMode})
        const result = sent.data && resultOf(sent.data)
        if (result?.ok) {
            customerProfileId = String(sent.data.customerProfileId)
            paymentProfileId = String([].concat(sent.data.customerPaymentProfileIdList || [])[0] || "") || null
        } else if (result?.code === "E00039") {
            // the party already has a customer profile there (made before its methods kept it)
            customerProfileId = duplicateId(result.text)
        }
    }
    if (customerProfileId && !paymentProfileId) {
        sent = send(gw, "createCustomerPaymentProfileRequest", {customerProfileId, paymentProfile, validationMode})
        const result = sent.data && resultOf(sent.data)
        if (result?.ok || result?.code === "E00039")
            paymentProfileId = sent.data.customerPaymentProfileId ? String(sent.data.customerPaymentProfileId) : null
    }
    const result = sent?.data ? resultOf(sent.data) : {}
    if (!customerProfileId || !paymentProfileId) {
        const message = sent?.unknown || sent?.refused || result.text || "The payment profile was not made"
        record(base, {
            resultError: "Y",
            responseCode: result.ok ? "Ok" : "Error",
            reasonCode: result.code,
            reasonMessage: message
        })
        throw new Error("PROFILE_NOT_STORED: " + clip(message, 200))
    }
    // the masked card for display (failure tolerant: the profile is kept either way)
    const shown = send(gw, "getCustomerPaymentProfileRequest", {customerProfileId, customerPaymentProfileId: paymentProfileId})
    const card = shown.data && resultOf(shown.data).ok ? shown.data.paymentProfile?.payment?.creditCard || {} : {}
    let paymentMethodId = method?.paymentMethodId
    const references = {paymentGatewayConfigId: gw.id, gatewayCimId: paymentProfileId, gatewayCustomerId: customerProfileId}
    if (method) {
        call("update#" + PM, Object.assign({paymentMethodId}, references))
    } else {
        paymentMethodId = G.createCardMethod(partyId, references, G.last4Of(card.cardNumber), cardTypes[card.cardType])
    }
    const paymentGatewayResponseId = record(Object.assign(base, {paymentMethodId}), {
        resultSuccess: "Y",
        responseCode: "Ok",
        reasonCode: result.code,
        reasonMessage: result.text,
        referenceNum: paymentProfileId
    })
    return {paymentMethodId, gatewayCimId: paymentProfileId, gatewayCustomerId: customerProfileId, paymentGatewayResponseId}
}

// delete#CustomerPaymentProfile: remove the method's payment profile at the gateway and its reference here. A failure
// is a warning and keeps the reference, so the delete can be done again; it never stops the method's own delete.
function deleteProfile(p) {
    const method = one(PM, {paymentMethodId: p.paymentMethodId})
    if (!method?.gatewayCimId || !method.gatewayCustomerId) return {}
    const gw = gateway(method.paymentGatewayConfigId)
    if (gw.problem) return {}
    const base = {gw, operationEnumId: "PgoStoreCim", paymentMethodId: method.paymentMethodId}
    const sent = send(gw, "deleteCustomerPaymentProfileRequest", {
        customerProfileId: method.gatewayCustomerId,
        customerPaymentProfileId: method.gatewayCimId
    })
    const result = sent.data ? resultOf(sent.data) : {}
    // E00040: already gone at the gateway
    if (result.ok || result.code === "E00040") {
        call("update#" + PM, {paymentMethodId: method.paymentMethodId, gatewayCimId: null})
        return {
            deleted: true,
            paymentGatewayResponseId: record(base, {
                resultSuccess: "Y",
                responseCode: "Ok",
                reasonCode: result.code,
                reasonMessage: result.text,
                referenceNum: method.gatewayCimId
            })
        }
    }
    const message = sent.unknown || sent.refused || result.text || "not deleted"
    ec.logger.warn("Authorize.Net payment profile of method " + method.paymentMethodId + " not deleted: " + clip(message, 200))
    ec.message.addMessage("The card's Authorize.Net profile was not deleted; try again later", "warning")
    return {
        deleted: false,
        paymentGatewayResponseId: record(base, {
            resultError: "Y",
            responseCode: "Error",
            reasonCode: result.code,
            reasonMessage: message
        })
    }
}

// ---- Webhooks ----

// receive#Webhook: the endpoint (/rest/sm/AuthorizeNetWebhook/{remote}) checked the signature over this body; keep the
// event once per remote and notification id.
function receiveWebhook(p) {
    let event
    try {
        event = JSON.parse(String(p.messageText))
    } catch (_) {
        throw new Error("The Authorize.Net notification is not JSON")
    }
    if (!event?.notificationId) throw new Error("The Authorize.Net notification has no notificationId")
    if (!p.systemMessageRemoteId) throw new Error("An Authorize.Net notification needs the remote of its endpoint")
    const eventDate = event.eventDate ? Date.parse(event.eventDate) : NaN
    return call("org.moqui.impl.SystemMessageServices.store#ReceivedSystemMessage", {
        systemMessageTypeId: p.systemMessageTypeId,
        systemMessageRemoteId: p.systemMessageRemoteId,
        messageId: clip(event.notificationId, 60),
        messageText: p.messageText,
        remoteMessageId: p.remoteMessageId,
        messageDate: Number.isNaN(eventDate) ? null : new Date(eventDate),
        docType: clip(event.eventType, 60)
    })
}

// consume#Webhook: a transaction event leads to a details lookup of the payment it is about, among the payments of the
// gateways on this remote: by its transaction id (the payment's reference), else by the reference of a lost operation
// (merchantReferenceId is the refId Mantle sent). The payload's status is not applied; the lookup reads the provider's.
// Other events (profiles, subscriptions) and transactions Mantle did not send are consumed with nothing to do.
function consumeWebhook(p) {
    const message = one("moqui.service.message.SystemMessage", {systemMessageId: p.systemMessageId})
    const event = lib.json(message?.messageText, {})
    const payload = event.payload || {}
    if (payload.entityName !== "transaction" || !payload.id) return {}
    const gatewayIds = rows(CONFIG, {
        systemMessageRemoteId: message.systemMessageRemoteId,
        paymentGatewayTypeEnumId: "PgtAuthorizeNet"
    }).map(row => row.paymentGatewayConfigId)
    if (!gatewayIds.length) return {}
    const paymentIds = new Set()
    for (const payment of Array.from(
        find(P, {paymentRefNum: String(payload.id)})
            .condition("paymentGatewayConfigId", "in", gatewayIds)
            .list()
    ))
        paymentIds.add(payment.paymentId)
    const refId = payload.merchantReferenceId ? String(payload.merchantReferenceId) : null
    if (!paymentIds.size && refId && /^mq[0-9a-f]{18}$/.test(refId)) {
        const lost = Array.from(
            find(R, {resultUnknown: "Y"})
                .condition("idempotencyKey", "like", refId + "%")
                .condition("paymentGatewayConfigId", "in", gatewayIds)
                .condition("outcomeResolvedDate", "is-null", null)
                .list()
        )
        for (const response of lost) paymentIds.add(response.refundPaymentId || response.paymentId)
    }
    if (!paymentIds.size)
        ec.logger.info("Authorize.Net " + event.eventType + " of transaction " + payload.id + ": no Mantle payment")
    // each payment on its own: one that fails is logged, the others go on, and the message is retried after
    const failed = []
    for (const paymentId of paymentIds) {
        try {
            lib.probe("mantle.account.PaymentServices.get#SinglePaymentGatewayDetails", {paymentId})
        } catch (error) {
            ec.logger.error(
                "Authorize.Net " + event.eventType + ": lookup of payment " + paymentId + " failed: " + clip(error.message, 200)
            )
            failed.push(paymentId)
        }
    }
    if (failed.length)
        throw new Error("The lookup of payments " + failed.join(", ") + " failed; the notification is kept to retry")
    return {}
}

// ---- Browser tokenization ----

// get#BrowserPaymentConfig: the public values Accept.js needs, and what the page shows.
function browserConfig(p) {
    const {payment, gw} = G.browserPayment(p.paymentId, false, gateway)
    const sandbox = gw.remote.usageCode !== "P"
    const host = sandbox ? "https://jstest.authorize.net" : "https://js.authorize.net"
    return {
        paymentId: payment.paymentId,
        apiLoginId: gw.remote.username,
        clientKey: gw.options.publicClientKey || null,
        acceptUiUrl: host + "/v3/AcceptUI.js",
        acceptJsUrl: host + "/v1/Accept.js",
        amount: payment.amount,
        currencyUomId: payment.amountUomId,
        amountText: ec.l10n.formatCurrency(payment.amount, payment.amountUomId)
    }
}
// submit#BrowserPaymentToken: authorize the payment with the browser's single-use opaque data (GatewayLib's
// submitBrowserToken: the lock and recheck, begin# before a profile, the payer's consent to keep the card).
function submitToken(p) {
    if (!p.dataDescriptor || !p.dataValue) throw new Error("TOKEN_REQUIRED: No card details were tokenized")
    return G.submitBrowserToken({
        paymentId: p.paymentId,
        gatewayOf: gateway,
        operationPrefix: "anet",
        operationId: p.operationId,
        paymentToken: {dataDescriptor: p.dataDescriptor, dataValue: p.dataValue},
        savePaymentMethod: p.savePaymentMethod,
        storeProfile: (paymentToken, payment, gw) =>
            storeProfile({partyId: payment.fromPartyId, paymentGatewayConfigId: gw.id, paymentToken}),
        deleteProfile: paymentMethodId => deleteProfile({paymentMethodId})
    })
}

const operations = {
    authorize: p => authorize(p, false),
    sale: p => authorize(p, true),
    capture,
    release,
    refund,
    details,
    storeProfile,
    deleteProfile,
    receiveWebhook,
    consumeWebhook,
    browserConfig,
    submitToken
}
;({
    execute(op, input) {
        return G.dispatch("Authorize.Net", operations, op, input)
    }
})
