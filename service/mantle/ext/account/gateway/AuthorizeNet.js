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
const G = ec.resource.script("component://mr-mantle/service/mantle/ext/account/gateway/GatewayLib.js")
const {one, rows, find, call, ms} = lib
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
    // a connection an administrator disabled, or whose address or sign-in changed and has not passed a test since (Admin
    // Connections; the framework's ConfigurationServices.store#Connection), takes no request
    else if (remote.disabled === "Y")
        problem = "The connection " + remote.systemMessageRemoteId + " is disabled until a test of it passes"
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
        const client = ec.service.rest().method("POST").uri(gw.remote.sendUrl).timeout(40).jsonObject(JSON.stringify(request))
        // a connection that may not use the private network (a delegated administrator's on a production instance)
        if (gw.remote.allowPrivateNetwork === "N") client.denyInternal()
        response = client.call()
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
    if (p.storedCredential && request.profile) storedCredentialFields(request, p.storedCredential, sale)
    return transact(base, {refId, transactionRequest: request})
}
// Shop P7 (F14, F41): a merchant-initiated charge of a kept profile under the customer's recorded off-session consent
// (a renewal): the stored-credential indicators, in the schema's order after transactionSettings (processingOptions,
// subsequentAuthInformation, then authorizationIndicatorType): a subsequent authorization of stored credentials, the
// original customer-initiated transaction's network id and amount, and a final authorization (pre for an authorization
// captured later). The reason field is for resubmissions and delayed charges, not a scheduled recurring charge, so it
// is not sent.
function storedCredentialFields(request, credential, sale) {
    request.processingOptions = {isSubsequentAuth: "true", isStoredCredentials: "true"}
    const original = credential.originalNetworkTransId ? clip(String(credential.originalNetworkTransId), 255) : null
    if (original) {
        request.subsequentAuthInformation = {originalNetworkTransId: original}
        const amount =
            credential.originalAuthAmount != null ? amountText(credential.originalAuthAmount, request.currencyCode) : null
        if (amount) request.subsequentAuthInformation.originalAuthAmount = amount
    }
    request.authorizationIndicatorType = {authorizationIndicator: sale ? "final" : "pre"}
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
        if (fields.all) fields.all.push(...list.filter(row => row.invoiceNumber === fields.reference))
        const match = fields.all ? null : list.find(row => row.invoiceNumber === fields.reference)
        if (match) return {transId: String(match.transId)}
        if (list.length < PAGE_LIMIT) return {}
    }
    return {problem: "More than " + MAX_PAGES * PAGE_LIMIT + " transactions to search"}
}
// Every transaction of a reference in the lists (unsettled, held for review, and the batches settled since the request):
// {transactions: [{transId, transactionStatus}]}, or {problem} when a search could not be done (Accept Hosted: two pages
// open at once can each take a payment under one reference; Shop P6, F85).
function referenceTransactions(gw, refId, sinceMillis, anyOne = false) {
    const all = []
    for (const before of [{status: "pendingApproval"}, {}]) {
        const found = findInList(gw, "getUnsettledTransactionListRequest", {before, reference: refId, all})
        if (found.problem) return found
    }
    // anyOne: whether there is a transaction at all, so an unsettled one ends the search
    if (anyOne && all.length)
        return {transactions: all.map(row => ({transId: String(row.transId), transactionStatus: row.transactionStatus}))}
    const now = Number(ec.user.nowTimestamp)
    const first = Math.max(Number(sinceMillis || now) - 86400000, now - SETTLED_DAYS * 86400000)
    const batches = send(gw, "getSettledBatchListRequest", {
        includeStatistics: false,
        firstSettlementDate: utc(first),
        lastSettlementDate: utc(now)
    })
    if (batches.unknown || batches.refused) return {problem: batches.unknown || batches.refused}
    const batchResult = resultOf(batches.data)
    if (!batchResult.ok && batchResult.code !== "E00004") return {problem: batchResult.code + " " + batchResult.text}
    for (const batch of [].concat(batches.data.batchList || [])) {
        const found = findInList(gw, "getTransactionListRequest", {
            before: {batchId: String(batch.batchId)},
            reference: refId,
            all
        })
        if (found.problem) return found
    }
    const seen = new Set()
    return {
        transactions: all
            .filter(row => !seen.has(String(row.transId)) && seen.add(String(row.transId)))
            .map(row => ({transId: String(row.transId), transactionStatus: row.transactionStatus}))
    }
}
const approvedStatuses = ["authorizedPendingCapture", "capturedPendingSettlement", "pendingSettlement", "settledSuccessfully"]
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
function findByReference(gw, refId, sinceMillis, newest = false) {
    // newest: the lists only, whose newest transaction with the reference comes first (Accept Hosted, where a payer may
    // try again on the page after a decline, so one reference can have several transactions)
    const direct = newest ? {} : transactionDetails(gw, {transrefId: refId})
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
    if (!payment.paymentRefNum) {
        // Accept Hosted: the payer's transaction, once made on the page, is found by the attempt's reference (F38)
        const pending = hostedResponse(payment)
        return pending ? hostedDetails(gw, payment, pending) : {}
    }
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
// The customer profile of a party at this gateway: kept on its payment methods (gatewayCustomerId), else the one this
// instance made for it (Shop P8, F97: recorded when made, so a profile is never found by merchantCustomerId alone).
function customerProfileOf(partyId, gatewayId) {
    const methods = Array.from(
        find(PM, {ownerPartyId: partyId, paymentGatewayConfigId: gatewayId})
            .condition("gatewayCustomerId", "is-not-null", null)
            .list()
    )
    if (methods.length) return methods[0].gatewayCustomerId
    const made = Array.from(
        find(R, {paymentGatewayConfigId: gatewayId, subReference: partyId, reasonCode: PROFILE_MADE})
            .orderBy("-transactionDate")
            .limit(1)
            .list()
    )[0]
    return made ? made.referenceNum : null
}
const duplicateId = text => (/ID (\d+)/.exec(String(text || "")) || [])[1] || null
// Shop P8 (impl-shop F97): a customer profile this instance made, recorded once with the party (subReference) and its
// merchantCustomerId (altReference). A profile is the party's here only when this instance made it or a method of the
// party keeps it, so a gateway account shared with another system, or a reloaded database reusing party ids, never hands
// over another person's profile and cards.
const PROFILE_MADE = "CUSTOMER_PROFILE_MADE"
function ownProfile(gw, partyId, customerProfileId) {
    if (!customerProfileId) return false
    return (
        find(PM, {ownerPartyId: partyId, paymentGatewayConfigId: gw.id, gatewayCustomerId: customerProfileId}).count() > 0 ||
        find(R, {paymentGatewayConfigId: gw.id, subReference: partyId, reasonCode: PROFILE_MADE, referenceNum: customerProfileId})
            .count() > 0
    )
}
// A new customer profile of the party (with a first payment profile when given): the party id as merchantCustomerId; when
// the gateway already has a profile of that id (E00039) that is not the party's here, a new one under a merchantCustomerId
// of its own (the party id and a random suffix), never the existing one. Recorded as this instance's.
// {customerProfileId, paymentProfileId, sent}.
function makeCustomerProfile(gw, partyId, extra, validationMode) {
    const attempt = merchantCustomerId => {
        const profile = Object.assign(
            {merchantCustomerId, description: clip("Party " + partyId + (merchantCustomerId === clip(partyId, REF_LENGTH) ? "" : " " + merchantCustomerId), 255)},
            extra || {}
        )
        return send(gw, "createCustomerProfileRequest", Object.assign({profile}, validationMode ? {validationMode} : {}))
    }
    let merchantCustomerId = clip(partyId, REF_LENGTH)
    let sent = attempt(merchantCustomerId)
    let result = sent.data ? resultOf(sent.data) : {}
    if (result.code === "E00039") {
        const existing = duplicateId(result.text)
        if (ownProfile(gw, partyId, existing)) return {customerProfileId: existing, paymentProfileId: null, sent}
        merchantCustomerId = clip(partyId, REF_LENGTH - 7) + "-" + ec.user.randomString(6).replace(/[^A-Za-z0-9]/g, "x")
        sent = attempt(merchantCustomerId)
        result = sent.data ? resultOf(sent.data) : {}
    }
    if (!result.ok) return {customerProfileId: null, paymentProfileId: null, sent}
    const customerProfileId = String(sent.data.customerProfileId)
    record(
        {gw, operationEnumId: "PgoStoreCim"},
        {
            resultSuccess: "Y",
            responseCode: "Ok",
            reasonCode: PROFILE_MADE,
            reasonMessage: "Customer profile made",
            referenceNum: customerProfileId,
            altReference: merchantCustomerId,
            subReference: clip(partyId, 60)
        }
    )
    return {
        customerProfileId,
        paymentProfileId: String([].concat(sent.data.customerPaymentProfileIdList || [])[0] || "") || null,
        sent
    }
}

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
        // Shop P8 (F97): a profile the gateway already has under the party's id is adopted only when it is the party's here
        const made = makeCustomerProfile(gw, partyId, Object.assign(email, {paymentProfiles: paymentProfile}), validationMode)
        sent = made.sent
        customerProfileId = made.customerProfileId
        paymentProfileId = made.paymentProfileId
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
    // Accept Hosted (F39): a payment still waiting at its hosted page has no transaction id yet; it is matched by its
    // reference, the payload's merchantReferenceId or else the transaction's invoice number (getTransactionDetails)
    if (!paymentIds.size) {
        const hosted = hostedPendingOf(gatewayIds)
        if (hosted.length) {
            let hostedRef = refId && /^mq[0-9a-f]{18}$/.test(refId) ? refId : null
            if (!hostedRef) {
                const got = transactionDetails(gateway(gatewayIds[0]), {transId: String(payload.id)})
                hostedRef = got.transaction?.order?.invoiceNumber ? String(got.transaction.order.invoiceNumber) : null
            }
            for (const response of hosted)
                if (hostedRef && reference(response.idempotencyKey) === hostedRef) paymentIds.add(response.paymentId)
        }
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

// ---- Accept Hosted (mr-pass impl-shop P5, F37-F41) ----

// A form token lives 15 minutes at Authorize.Net; after it (and the lookup's grace) no payment can be made with one.
const HOSTED_TOKEN_SECONDS = 15 * 60
// The transaction statuses of a payer's refused try on the hosted page (paymentStatus's PmntDeclined).
const hostedDeclined = ["declined", "failedReview"]
const HOSTED_PAGE = {
    sandbox: "https://test.authorize.net/payment/payment",
    production: "https://accept.authorize.net/payment/payment"
}
// The payment's latest authorization answer when it waits at the hosted page (no transaction yet), else null.
function hostedResponse(payment) {
    if (!payment || payment.paymentRefNum || payment.statusId !== "PmntPromised") return null
    const latest = Array.from(
        find(R, {paymentId: payment.paymentId})
            .condition("paymentOperationEnumId", "in", ["PgoAuthorize", "PgoAuthAndCapture"])
            .orderBy("-transactionDate")
            .orderBy("-paymentGatewayResponseId")
            .limit(1)
            .list()
    )[0]
    return latest && latest.transactionStatus === "HostedPending" ? latest : null
}
// The hosted answers still waiting on these gateways (their payments promised with no transaction).
function hostedPendingOf(gatewayIds) {
    return Array.from(
        find(R, {transactionStatus: "HostedPending"})
            .condition("paymentGatewayConfigId", "in", gatewayIds)
            .orderBy("-transactionDate")
            .limit(200)
            .list()
    ).filter(
        response =>
            hostedResponse(one(P, {paymentId: response.paymentId}))?.paymentGatewayResponseId ===
            response.paymentGatewayResponseId
    )
}
// authorizeHosted#Payment and authorizeAndCaptureHosted#Payment: nothing is sent; the payment waits at the hosted page
// (transactionStatus HostedPending, no result), which the frontend's relay opens with a fresh token (get#HostedPaymentForm)
// and whose transaction the details lookup finds by the attempt's reference.
function authorizeHosted(p, sale) {
    // Shop P7: a merchant-initiated renewal of a kept profile is a profile charge with its indicators, whatever page the
    // gateway shows a payer
    if (p.storedCredential) return authorize(p, sale)
    const {payment, base, problem} = start(p, sale ? "PgoAuthAndCapture" : "PgoAuthorize")
    if (problem) return refuse(base, "GATEWAY_NOT_AVAILABLE", problem)
    if (!amountText(payment.amount, payment.amountUomId))
        return refuse(base, "AMOUNT_INVALID", "The amount does not suit the currency or Authorize.Net")
    if (!p.returnUrl || !/^https:\/\//.test(String(p.returnUrl)))
        return refuse(base, "RETURN_URL_REQUIRED", "A hosted payment needs the https address its page returns to")
    return {
        paymentGatewayResponseId: record(base, {
            transactionStatus: "HostedPending",
            reasonMessage: "Waiting for the payer on the hosted payment page"
        })
    }
}
// get#HostedPaymentForm: a fresh form token for the pending hosted payment (getHostedPaymentPageRequest), asked on each
// visit and never stored: the transaction type and amount of the pending answer, the attempt's reference as refId and
// order.invoiceNumber (F38), the canonical return and cancel addresses, the receipt shown and the merchant's name. The
// token's time is recorded on the pending answer. {formUrl, token}.
function hostedForm(p) {
    const payment = one(P, {paymentId: p.paymentId})
    const pending = hostedResponse(payment)
    if (!pending) throw new Error("HOSTED_NOT_PENDING: The payment is not waiting at a hosted page")
    const gw = gateway(payment.paymentGatewayConfigId)
    if (gw.problem) throw new Error("GATEWAY_NOT_AVAILABLE: " + gw.problem)
    if (!/^https:\/\//.test(String(p.returnUrl || ""))) throw new Error("RETURN_URL_REQUIRED: The return address is https")
    const refId = reference(pending.idempotencyKey)
    // one page per reference (Shop P6, F85): once the reference has a transaction (paid, declined or held on an earlier
    // page), no new token is issued, so two pages cannot each take a payment; a search that cannot tell issues none either
    const existing = referenceTransactions(gw, refId, ms(pending.transactionDate), true)
    if (existing.problem) throw new Error("HOSTED_FORM_UNAVAILABLE: " + clip(String(existing.problem), 200))
    if (existing.transactions.length)
        throw new Error("HOSTED_ALREADY_USED: The payment page was already used for this payment; its result is being confirmed")
    const transactionRequest = {
        transactionType:
            pending.paymentOperationEnumId === "PgoAuthAndCapture" ? "authCaptureTransaction" : "authOnlyTransaction",
        amount: amountText(payment.amount, payment.amountUomId),
        currencyCode: payment.amountUomId,
        order: {invoiceNumber: refId, description: describe(payment)}
    }
    if (payment.fromPartyId && String(payment.fromPartyId).length <= REF_LENGTH)
        transactionRequest.customer = {id: payment.fromPartyId}
    const setting = [
        {
            settingName: "hostedPaymentReturnOptions",
            settingValue: JSON.stringify({
                showReceipt: true,
                url: String(p.returnUrl),
                urlText: "Continue",
                cancelUrl: String(p.cancelUrl || p.returnUrl),
                cancelUrlText: "Cancel"
            })
        },
        {settingName: "hostedPaymentButtonOptions", settingValue: JSON.stringify({text: "Pay"})},
        {
            settingName: "hostedPaymentOrderOptions",
            settingValue: JSON.stringify({show: true, merchantName: clip(p.merchantName || "", 50)})
        },
        {
            settingName: "hostedPaymentPaymentOptions",
            settingValue: JSON.stringify({cardCodeRequired: true, showCreditCard: true, showBankAccount: false})
        }
    ]
    const sent = send(gw, "getHostedPaymentPageRequest", {refId, transactionRequest, hostedPaymentSettings: {setting}})
    const result = sent.data ? resultOf(sent.data) : {}
    if (!result.ok || !sent.data.token)
        throw new Error("HOSTED_FORM_UNAVAILABLE: " + clip(sent.unknown || sent.refused || result.text || "No form token", 200))
    call("update#" + R, {paymentGatewayResponseId: pending.paymentGatewayResponseId, hostedFormDate: ec.user.nowTimestamp})
    return {formUrl: gw.remote.usageCode === "P" ? HOSTED_PAGE.production : HOSTED_PAGE.sandbox, token: String(sent.data.token)}
}
// The details of a payment waiting at its hosted page: its transaction found by the attempt's reference, recorded with
// the provider's amount and network transaction id (F41; stored-credential evidence); none found and no form token still
// usable, the payment is cancelled (nothing can be paid on that page any more); a search that cannot tell leaves it.
// A declined transaction is final only once no form token can still be used: until then the payer may try again on the
// page (or open it again), so the payment stays waiting; after it, the reference's newest transaction decides, so a later
// approval is never lost behind an earlier decline (Shop P5 review).
function hostedDetails(gw, payment, pending) {
    const refId = reference(pending.idempotencyKey)
    const last = ms(pending.hostedFormDate) ?? ms(pending.transactionDate) ?? 0
    const tokenUsable = ms(ec.user.nowTimestamp) - last <= (HOSTED_TOKEN_SECONDS + graceSeconds(gw)) * 1000
    let found = findByReference(gw, refId, ms(pending.transactionDate))
    if (found.transaction && hostedDeclined.includes(found.transaction.transactionStatus)) {
        if (tokenUsable) return {}
        const newest = findByReference(gw, refId, ms(pending.transactionDate), true)
        if (newest.problem) return {}
        if (newest.transaction) found = newest
    }
    if (found.transaction) {
        const tx = found.transaction
        const out = detailsOut(gw, payment, tx, statusFor(payment, tx))
        if (out.paymentGatewayResponseId)
            call("update#" + R, {
                paymentGatewayResponseId: out.paymentGatewayResponseId,
                amount: tx.authAmount != null ? toDecimal(String(tx.authAmount)) : payment.amount,
                networkTransId: tx.networkTransId ? clip(String(tx.networkTransId), 60) : null,
                resultSuccess: ["authorizedPendingCapture"].concat(capturedStatuses).includes(tx.transactionStatus) ? "Y" : "N"
            })
        // more than one approval under the reference (two pages paid at once; Shop P6, F85) is an exception, flagged once on
        // the payment with the other transactions for Accounting (the checkout holds its order), never a plain success
        if (approvedStatuses.includes(tx.transactionStatus)) flagDuplicates(gw, payment, pending, refId, String(tx.transId))
        return out
    }
    if (found.problem) return {}
    if (!tokenUsable) return {gatewayStatusId: "PmntCancelled"}
    return {}
}
// "flagged" (now or before), "none" (searched, no other approval) or "problem" (the search could not tell)
function flagDuplicates(gw, payment, pending, refId, transId) {
    if (find(R, {paymentId: payment.paymentId, reasonCode: "DUPLICATE_APPROVAL"}).count() > 0) return "flagged"
    const listed = referenceTransactions(gw, refId, ms(pending.transactionDate))
    if (listed.problem) return "problem"
    const others = listed.transactions.filter(row => approvedStatuses.includes(row.transactionStatus) && row.transId !== transId)
    if (!others.length) return "none"
    record(
        {gw, payment, operationEnumId: "PgoTxDetails", amount: payment.amount},
        {
            referenceNum: transId,
            transactionStatus: "DuplicateApproval",
            reasonCode: "DUPLICATE_APPROVAL",
            reasonMessage: clip("Also approved under reference " + refId + ": " + others.map(row => row.transId).join(", "), 255),
            resultSuccess: "N",
            resultDeclined: "N"
        }
    )
    return "flagged"
}
// check#HostedDuplicates (Shop P8, impl-shop F95): an approved hosted payment's reference searched again for another
// approval that landed after the first was confirmed (a second page paid after the lookup); flagged once as the lookup
// flags it (DUPLICATE_APPROVAL with the other transactions). A payment never sent to a hosted page, one not approved or
// already flagged, and a search that cannot tell flag nothing. {flagged, checked}.
function checkHostedDuplicates(p) {
    const payment = one(P, {paymentId: p.paymentId})
    if (!payment || !payment.paymentRefNum || !["PmntAuthorized", "PmntDelivered", "PmntConfirmed"].includes(payment.statusId))
        return {flagged: false, checked: false}
    if (find(R, {paymentId: payment.paymentId, reasonCode: "DUPLICATE_APPROVAL"}).count() > 0) return {flagged: true, checked: false}
    const pending = Array.from(
        find(R, {paymentId: payment.paymentId, transactionStatus: "HostedPending"})
            .condition("paymentOperationEnumId", "in", ["PgoAuthorize", "PgoAuthAndCapture"])
            .orderBy("-transactionDate")
            .limit(1)
            .list()
    )[0]
    const gw = gateway(payment.paymentGatewayConfigId)
    if (!pending || gw.problem) return {flagged: false, checked: false}
    if (find(R, {paymentId: payment.paymentId, reasonCode: DUPLICATES_CHECKED}).count() > 0) return {flagged: false, checked: false}
    // a second page can be paid only while a form token of the reference can still be used: searched once after that
    const last = ms(pending.hostedFormDate) ?? ms(pending.transactionDate) ?? 0
    if (ms(ec.user.nowTimestamp) - last <= (HOSTED_TOKEN_SECONDS + graceSeconds(gw)) * 1000) return {flagged: false, checked: false, wait: true}
    const found = flagDuplicates(gw, payment, pending, reference(pending.idempotencyKey), String(payment.paymentRefNum))
    if (found === "none")
        record(
            {gw, payment, operationEnumId: "PgoTxDetails"},
            {reasonCode: DUPLICATES_CHECKED, reasonMessage: "No other approval under the reference", resultSuccess: "N"}
        )
    return {flagged: found === "flagged", checked: found !== "problem"}
}
const DUPLICATES_CHECKED = "DUPLICATES_CHECKED"
// store#HostedPaymentProfile (F40): after an approved hosted payment a signed-in buyer asked to keep, the transaction's
// customer payment profile (when the page made one), else one made from the transaction
// (createCustomerProfileFromTransactionRequest, onto the party's customer profile when it has one); the method keeps the
// references and the masked card, and the payment names it.
function hostedProfile(p) {
    const payment = one(P, {paymentId: p.paymentId})
    if (!payment || !["PmntAuthorized", "PmntDelivered", "PmntConfirmed"].includes(payment.statusId) || !payment.paymentRefNum)
        throw new Error("PAYMENT_NOT_APPROVED: Only an approved hosted payment's card is kept")
    if (payment.paymentMethodId) return {paymentMethodId: payment.paymentMethodId}
    const gw = gateway(payment.paymentGatewayConfigId)
    if (gw.problem) throw new Error("GATEWAY_NOT_AVAILABLE: " + gw.problem)
    const got = transactionDetails(gw, {transId: payment.paymentRefNum})
    if (!got.transaction) throw new Error("DETAILS_UNAVAILABLE: " + (got.problem || "not found"))
    const tx = got.transaction
    let customerProfileId = tx.profile?.customerProfileId ? String(tx.profile.customerProfileId) : null
    let paymentProfileId = tx.profile?.customerPaymentProfileId ? String(tx.profile.customerPaymentProfileId) : null
    if (!customerProfileId || !paymentProfileId) {
        const existing = customerProfileOf(payment.fromPartyId, gw.id)
        const body = Object.assign({transId: payment.paymentRefNum}, existing ? {customerProfileId: existing} : {})
        const sent = send(gw, "createCustomerProfileFromTransactionRequest", body)
        const result = sent.data ? resultOf(sent.data) : {}
        if (!result.ok)
            throw new Error("PROFILE_NOT_STORED: " + clip(sent.unknown || sent.refused || result.text || "not stored", 200))
        customerProfileId = String(sent.data.customerProfileId || existing || "") || null
        paymentProfileId = String([].concat(sent.data.customerPaymentProfileIdList || [])[0] || "") || null
    }
    if (!customerProfileId || !paymentProfileId) throw new Error("PROFILE_NOT_STORED: No payment profile was made")
    const card = tx.payment?.creditCard || {}
    const paymentMethodId = G.createCardMethod(
        payment.fromPartyId,
        {paymentGatewayConfigId: gw.id, gatewayCimId: paymentProfileId, gatewayCustomerId: customerProfileId},
        G.last4Of(card.cardNumber),
        cardTypes[card.cardType]
    )
    call("update#" + P, {paymentId: payment.paymentId, paymentMethodId})
    return {paymentMethodId}
}

// ---- The hosted profile page (Shop P6, F40) ----
const PROFILE_PAGE = {
    sandbox: "https://test.authorize.net/customer/addPayment",
    production: "https://accept.authorize.net/customer/addPayment"
}
// The party's customer profile at the gateway: its methods' reference or the one this instance made, else one made now (F97)
// with the party as its merchantCustomerId.
function ensureCustomerProfile(gw, partyId) {
    const kept = customerProfileOf(partyId, gw.id)
    if (kept) return kept
    // Shop P8 (F97): an existing profile under the party's id is the party's only when this instance made it
    const made = makeCustomerProfile(gw, partyId, null, null)
    if (made.customerProfileId) return made.customerProfileId
    const result = made.sent.data ? resultOf(made.sent.data) : {}
    throw new Error(
        "PROFILE_NOT_STORED: " + clip(made.sent.unknown || made.sent.refused || result.text || "No customer profile", 200)
    )
}
// get#HostedProfileForm: a form token of the hosted profile page (getHostedProfilePageRequest) where the payer adds a card
// to their customer profile, returning to returnUrl; never stored. {formUrl, fields: {token}}.
function hostedProfileForm(p) {
    const gw = gateway(p.paymentGatewayConfigId)
    if (gw.problem) throw new Error("GATEWAY_NOT_AVAILABLE: " + gw.problem)
    if (!/^https:\/\//.test(String(p.returnUrl || ""))) throw new Error("RETURN_URL_REQUIRED: The return address is https")
    const customerProfileId = ensureCustomerProfile(gw, p.partyId)
    const sent = send(gw, "getHostedProfilePageRequest", {
        customerProfileId,
        hostedProfileSettings: {
            setting: [
                {settingName: "hostedProfileReturnUrl", settingValue: String(p.returnUrl)},
                {settingName: "hostedProfileReturnUrlText", settingValue: "Continue"},
                {settingName: "hostedProfileCardCodeRequired", settingValue: "true"}
            ]
        }
    })
    const result = sent.data ? resultOf(sent.data) : {}
    if (!result.ok || !sent.data.token)
        throw new Error("HOSTED_FORM_UNAVAILABLE: " + clip(sent.unknown || sent.refused || result.text || "No form token", 200))
    return {
        formUrl: gw.remote.usageCode === "P" ? PROFILE_PAGE.production : PROFILE_PAGE.sandbox,
        fields: {token: String(sent.data.token)}
    }
}
// sync#CustomerProfile: the party's customer profile read (getCustomerProfileRequest, by its kept reference or the party
// as merchantCustomerId), each payment profile not kept yet kept as a masked card method. {added}.
function syncCustomerProfile(p) {
    const gw = gateway(p.paymentGatewayConfigId)
    if (gw.problem) throw new Error("GATEWAY_NOT_AVAILABLE: " + gw.problem)
    // Shop P8 (F97): only the party's own profile here (kept on its methods or made by this instance), never one found by
    // merchantCustomerId, which another system or a reloaded database may share
    const kept = customerProfileOf(p.partyId, gw.id)
    if (!kept) return {added: 0}
    const sent = send(gw, "getCustomerProfileRequest", {customerProfileId: kept})
    const result = sent.data ? resultOf(sent.data) : {}
    if (!result.ok) {
        if (result.code === "E00040") return {added: 0}
        throw new Error("DETAILS_UNAVAILABLE: " + clip(sent.unknown || sent.refused || result.text || "not read", 200))
    }
    const profile = sent.data.profile || {}
    const customerProfileId = String(profile.customerProfileId || kept || "")
    let added = 0
    for (const paymentProfile of [].concat(profile.paymentProfiles || [])) {
        const paymentProfileId = String(paymentProfile.customerPaymentProfileId || "")
        if (!paymentProfileId || one(PM, {paymentGatewayConfigId: gw.id, gatewayCimId: paymentProfileId})) continue
        const card = paymentProfile.payment?.creditCard
        if (!card) continue
        G.createCardMethod(
            p.partyId,
            {paymentGatewayConfigId: gw.id, gatewayCimId: paymentProfileId, gatewayCustomerId: customerProfileId},
            G.last4Of(card.cardNumber),
            cardTypes[card.cardType]
        )
        added++
    }
    return {added}
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
    authorizeHosted: p => authorizeHosted(p, false),
    saleHosted: p => authorizeHosted(p, true),
    hostedForm,
    hostedProfile,
    hostedProfileForm,
    syncCustomerProfile,
    checkHostedDuplicates,
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
