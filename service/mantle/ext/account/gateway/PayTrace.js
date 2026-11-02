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

// PayTrace payment gateway (plan/payments-shipping-edi.md P2): the operations behind PayTraceServices.xml. Ported from the
// Java Moqui mantle-paytrace component (github.com/moqui/mantle-paytrace, 1.0.3, commit 5dbe616; CC0, written by David E.
// Jones, Anderson Urrego Restrepo and Michael Jones: its vault payment services, its response code mapping and its level
// 3 data from the order lines), moved from PayTrace API v1 to the JSON API v3 (OpenAPI 3.5.1 as published at
// https://api.paytrace.com/v3/openapi.json on 2026-11-02): OAuth client credentials, the v3 card, vault, export and
// Enhanced Data paths, and Protect.js tokens (hpf_token, enc_key) instead of card numbers sent from the server.
//
// The gateway contract is mantle.account.PaymentServices.authorize#Payment's: one PaymentGatewayResponse per call, no
// Payment change, a lost answer recorded as resultUnknown (never thrown), and get#PaymentGatewayDetails answering
// operationFound for a lost one. PayTrace card transactions take no idempotency key: the idempotency key goes in
// invoice_number and at the start of description, and a lookup finds the transaction by it in the export by date.
// Enhanced (level 2/3) data is a separate outcome after a capture or sale: its own PgoLevel3Data response, never the
// charge's, sent again by send#EnhancedData. Card data, tokens and credentials are never recorded or logged; the request
// and answer bodies are not logged at all.
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const G = ec.resource.script("component://mr-mantle/service/mantle/ext/account/gateway/GatewayLib.js")
const {one, rows, find, call} = lib
const {clip, record, refuse, describe, isRefund, authorizedTransaction} = G
const P = "mantle.account.payment.Payment",
    PM = "mantle.account.method.PaymentMethod",
    R = "mantle.account.method.PaymentGatewayResponse",
    CONFIG = "mantle.account.method.PaymentGatewayConfig",
    OPTIONS = "mantle.account.method.PaymentGatewayPayTrace",
    REMOTE = "moqui.service.message.SystemMessageRemote"
const TOKEN_CACHE = "mantle.ext.account.gateway.PayTrace.accessToken"
// a cached access token is used until this long before it expires
const TOKEN_MARGIN_SECONDS = 60
// expires_in when an answer has none: the shortest lifetime the documentation shows (900 seconds)
const TOKEN_DEFAULT_SECONDS = 900
// credentials PayTrace refused are not sent again for this long
const REFUSED_SECONDS = 60
// PayTrace's export may lag behind its transactions: a lost request is judged not done only after this
const GRACE_SECONDS = 300
const DAY = 86400000
const LOOKUP_CANDIDATES = 5

// ---- Mappings ----

// Response codes (the API's Response Codes table): approved, captured, voided, refunded (108 a test refund), and the
// refusals; 103 is an approval PayTrace voided for an AVS or CSC mismatch, so a decline.
const SUCCESS_CODES = [101, 106, 108, 109, 112, 160, 161, 162, 165, 167]
const DECLINED_CODES = [102, 103]
// 1: "an internal exception that was not handled" — PayTrace cannot say what it did
const UNHANDLED_CODE = 1
// Error ids (the API's Error Codes table): card number, expiry (as the source), the duplicate block (an earlier request
// may have gone, so unknown and looked up), the velocity, fraud and API-limit blocks (declines), and the transaction
// state refusals of capture, refund and void (816, 817, 818), after which the transaction's status is read.
const BAD_CARD_NUMBER = ["35"]
const BAD_EXPIRE = ["43", "44"]
const DUPLICATE = "777"
const BLOCKED = ["778", "779", "790"]
const WRONG_STATE = ["816", "817", "818"]
const NOT_FOUND = ["58", "811"]
// the export found nothing for its criteria
const NO_TRANSACTIONS = "180"
// Enhanced Data accepted: 170 Visa, 171 Mastercard level 3 added
const ENHANCED_CODES = [170, 171]
const CUSTOMER_NOT_FOUND = "61"
// Moqui quantity units and the level 3 unit codes the source mapped them to (help.paytrace.com/level3-unit-of-measure);
// v3 takes 1 to 12 letters or digits, which these are.
const unitCodes = {
    AREA_A: "ACR",
    OTH_A: "AMP",
    PRES_bar: "BAR",
    VLIQ_bbl: "BLL",
    EN_BTU: "BTU",
    OTH_cd: "CDL",
    VDRY_cm3: "CMQ",
    VDRY_ft3: "FTQ",
    VDRY_in3: "INQ",
    VDRY_mm3: "MMQ",
    VDRY_yd3: "YDQ",
    TF_day: "DAY",
    TF_decade: "DEC",
    TEMP_C: "CEL",
    TEMP_F: "FAH",
    VLIQ_ozUK: "OZI",
    VLIQ_ozUS: "OZA",
    LEN_ft: "FOT",
    VLIQ_gi: "GII",
    WT_gr: "GRN",
    WT_g: "GRM",
    AREA_ha: "HAR",
    TF_hr: "HUR",
    LEN_in: "INH",
    EN_J: "JOU",
    TEMP_K: "KEL",
    DENS_kg_m3: "KMQ",
    WT_kg: "KGM",
    PRES_kPa: "KPA",
    PW_kw: "KWT",
    EN_kw_h: "KWH",
    VEL_kn: "KNT",
    VLIQ_galUS: "GLL",
    VLIQ_ptUS: "PTL",
    VLIQ_qt: "QTL",
    VLIQ_L: "LTR",
    WT_lt: "LTN",
    LEN_m: "MTR",
    WT_mt: "TNE",
    PRES_mbar: "MBR",
    WT_mg: "MGM",
    TF_min: "MIN",
    TF_mon: "MON",
    LEN_nmi: "NMI",
    WT_oz: "ONZ",
    PRES_Pa: "PAL",
    WT_dwt: "DWT",
    OTH_ea: "PCE",
    OTH_ct: "PCE",
    WT_lb: "LBR",
    OTH_RPM: "RPM",
    TF_score: "SCO",
    TF_s: "SEC",
    WT_sh_t: "STN",
    AREA_cm2: "CMK",
    AREA_ft2: "FTK",
    AREA_in2: "INK",
    AREA_km2: "KMK",
    AREA_m2: "MTK",
    AREA_mi2: "MIK",
    AREA_mm2: "MMK",
    AREA_yd2: "YDK",
    PRES_atm: "ATM",
    LEN_mi: "SMI",
    WT_st: "STI",
    PRES_at: "ATT",
    WT_oz_tr: "APZ",
    PW_w: "WTT",
    TF_wk: "WEE",
    LEN_yd: "YRD",
    TF_yr: "ANN"
}
// Order and invoice item types, as the source read them; VAT is not added to totals, so it is left out.
const TAX_TYPES = ["ItemSalesTax"]
const UNTOTALED_TAX_TYPES = ["ItemVatTax"]
const DISCOUNT_TYPES = ["ItemDiscount", "ItemDiscountAppease", "ItemSupplierDiscount"]
const FREIGHT_TYPES = ["ItemShipping", "ItemShippingOther"]

// ---- Configuration and transport ----

// The gateway's config, options and connection; problem says why it cannot be used.
function gateway(paymentGatewayConfigId) {
    const config = paymentGatewayConfigId && one(CONFIG, {paymentGatewayConfigId})
    const options = (config && one(OPTIONS, {paymentGatewayConfigId})) || {}
    const remote = config?.systemMessageRemoteId && one(REMOTE, {systemMessageRemoteId: config.systemMessageRemoteId})
    let problem = null
    if (!config || config.paymentGatewayTypeEnumId !== "PgtPayTrace")
        problem = "Gateway " + paymentGatewayConfigId + " is not a PayTrace gateway"
    else if (!remote) problem = "Gateway " + paymentGatewayConfigId + " has no connection (SystemMessageRemote)"
    else if (!remote.sendUrl || !remote.username || !remote.password)
        problem = "The connection " + remote.systemMessageRemoteId + " needs its API base address, API user and password"
    else if (!/^\d+$/.test(String(options.merchantId || "")) || !options.integratorId || !options.currencyUomId)
        problem = "Gateway " + paymentGatewayConfigId + " needs its PayTrace merchant id, integrator id and account currency"
    else if (String(options.integratorId).length > 12)
        problem = "Gateway " + paymentGatewayConfigId + " has an integrator id longer than PayTrace's 12 characters"
    const base = remote?.sendUrl ? String(remote.sendUrl).replace(/\/+$/, "") : null
    return {id: paymentGatewayConfigId, label: "PayTrace", config, options, remote, base, problem}
}
const merchantId = gw => Number(gw.options.merchantId)
const encode = value => encodeURIComponent(String(value))

// The cache entry of a connection's token: by remote, endpoint and user, never by secret.
const tokenKey = gw => gw.remote.systemMessageRemoteId + "|" + gw.base + "|" + gw.remote.username
// The token as the cache keeps it: XORed with a keystream of the conf's single-use hash (SHA-256 by default) of the
// remote's password, a random nonce and a block counter, so the Tools cache screen shows only hex no one can use
// without the password. null for a token that is not printable ASCII (it is then not kept).
function keystream(gw, nonce, length) {
    const bytes = []
    for (let block = 0; bytes.length < length; block++) {
        const hex = ec.user.singleUseCodeHash("paytrace-token|" + gw.remote.password + "|" + nonce + "|" + block)
        for (let i = 0; i + 1 < hex.length && bytes.length < length; i += 2) bytes.push(parseInt(hex.substr(i, 2), 16))
    }
    return bytes
}
function seal(gw, token) {
    if (!/^[\x21-\x7e]+$/.test(token)) return null
    const nonce = ec.user.randomString(16)
    const key = keystream(gw, nonce, token.length)
    let sealed = ""
    for (let i = 0; i < token.length; i++) sealed += (token.charCodeAt(i) ^ key[i]).toString(16).padStart(2, "0")
    return {nonce, sealed}
}
function unseal(gw, held) {
    if (!held?.sealed || !held.nonce) return null
    const length = held.sealed.length / 2
    const key = keystream(gw, held.nonce, length)
    let token = ""
    for (let i = 0; i < length; i++) token += String.fromCharCode(parseInt(held.sealed.substr(i * 2, 2), 16) ^ key[i])
    // another password (or hash type) since: not the token, so a new one is asked for
    return /^[\x21-\x7e]+$/.test(token) ? token : null
}
// Credentials PayTrace refused: not sent again for a minute, so a poll over many payments does not send them once per
// payment.
function refuseFor(gw, status) {
    ec.cache
        .getCache(TOKEN_CACHE)
        .put(tokenKey(gw), {refusedUntil: Number(ec.user.nowTimestamp) + REFUSED_SECONDS * 1000, status})
}

// The OAuth access token (client credentials: the API user and password), from the cache until shortly before it
// expires. It is kept only in this process's cache, sealed, and never recorded or logged. fresh drops the cached one first
// (it was refused). {token} or {problem}; nothing is charged either way.
function accessToken(gw, fresh) {
    const cache = ec.cache.getCache(TOKEN_CACHE)
    const key = tokenKey(gw)
    const now = Number(ec.user.nowTimestamp)
    const held = cache.get(key)
    if (held?.refusedUntil && Number(held.refusedUntil) > now)
        return {problem: "PayTrace refused the API credentials (HTTP " + held.status + "); not sent again for a minute"}
    if (fresh) cache.remove(key)
    else if (held?.sealed && Number(held.expiresAt) - TOKEN_MARGIN_SECONDS * 1000 > now) {
        const token = unseal(gw, held)
        if (token) return {token}
    }
    const form =
        "grant_type=client_credentials&client_id=" + encode(gw.remote.username) + "&client_secret=" + encode(gw.remote.password)
    let response
    try {
        response = ec.service
            .rest()
            .method("POST")
            .uri(gw.base + "/v3/token")
            .timeout(30)
            .addHeader("X-Integrator-Id", gw.options.integratorId)
            .addHeader("Accept", "application/json")
            .addHeader("Cache-Control", "no-cache")
            .contentType("application/x-www-form-urlencoded")
            .text(form)
            .call()
    } catch (_) {
        return {problem: "No answer from PayTrace's token endpoint"}
    }
    const status = response.getStatusCode()
    if (status !== 200 && status !== 201) {
        ec.logger.warn("PayTrace token request of remote " + gw.remote.systemMessageRemoteId + ": HTTP " + status)
        if (status >= 400 && status < 500) refuseFor(gw, status)
        return {problem: "PayTrace refused the API credentials (HTTP " + status + ")"}
    }
    const envelope = lib.json(response.text(), {}) || {}
    const data = envelope.data && typeof envelope.data === "object" ? envelope.data : envelope
    if (!data.access_token) return {problem: "PayTrace's token answer has no access token"}
    const token = String(data.access_token)
    const seconds = Number(data.expires_in) > 0 ? Number(data.expires_in) : TOKEN_DEFAULT_SECONDS
    const sealed = seal(gw, token)
    if (sealed) cache.put(key, Object.assign(sealed, {expiresAt: now + seconds * 1000}))
    return {token}
}

// Send one API request with the access token. A 401 (an expired or revoked token, refused before the request is
// processed) gets a new token and is sent once more; nothing else is sent twice. Answers {status, data} with the answer's
// data (the "data-wrapper" taken off), or {unknown} when the request may have gone and no readable answer came back, or
// {refused} when PayTrace refused it before acting (credentials, an HTTP refusal without an answer body).
function api(gw, method, path, body) {
    for (let attempt = 0; attempt < 2; attempt++) {
        const auth = accessToken(gw, attempt > 0)
        if (!auth.token) return {refused: auth.problem}
        let response
        try {
            const client = ec.service
                .rest()
                .method(method)
                .uri(gw.base + path)
                .timeout(40)
                .addHeader("Authorization", "Bearer " + auth.token)
                .addHeader("X-Integrator-Id", gw.options.integratorId)
                .addHeader("Accept", "application/json")
                .addHeader("Cache-Control", "no-cache")
            if (body != null) client.jsonObject(JSON.stringify(body))
            response = client.call()
        } catch (error) {
            return {unknown: "No answer from PayTrace: " + clip(error?.message ?? error, 200)}
        }
        const status = response.getStatusCode()
        if (status === 401 && attempt === 0) continue
        if (status === 401) {
            // a token PayTrace just gave is refused too: the account's access is, so not asked again for a minute
            refuseFor(gw, status)
            return {refused: "PayTrace refused the access token (HTTP 401)"}
        }
        // a timeout (408) or a server error: the request may have been acted on
        if (status === 408 || status >= 500) return {unknown: "PayTrace answered HTTP " + status}
        let envelope = null
        try {
            const text = String(response.text() || "")
            envelope = text ? JSON.parse(text) : null
        } catch (_) {
            envelope = null
        }
        if (envelope == null)
            return status >= 400
                ? {refused: "PayTrace refused the request (HTTP " + status + ")"}
                : {unknown: "PayTrace answered with unreadable JSON"}
        const data = envelope && typeof envelope === "object" && "data" in envelope ? envelope.data : envelope
        return {status, data}
    }
}

// An error row of PayTrace's ErrorSchema ({detail, type, code, field, error_id}).
const isError = row => !!row && typeof row === "object" && (row.detail != null || row.code != null || row.error_id != null)
// The answer of one operation: a batch answer (capture, void) is a list of items, each with its own data; an error
// answer is a list of {detail, type, code, field, error_id} (or one of them), or {detail: [{loc, msg, type}]} from the
// API's request validation. {code, data}, {errors}, or {errors: []} for an answer of neither shape.
function answerOf(sent) {
    let data = sent.data
    while (
        Array.isArray(data) &&
        data.length &&
        data[0] &&
        typeof data[0] === "object" &&
        "data" in data[0] &&
        !("detail" in data[0])
    )
        data = data[0].data
    if (data && !Array.isArray(data) && typeof data === "object" && data.response_code != null)
        return {code: Number(data.response_code), data}
    if (data && !Array.isArray(data) && typeof data === "object" && Array.isArray(data.detail))
        return {
            errors: data.detail.map(row => ({
                detail: [].concat(row?.loc || []).join(".") + " " + (row?.msg || ""),
                type: "VALIDATION",
                code: row?.type || "INVALID"
            }))
        }
    const errors = (Array.isArray(data) ? data : [data]).filter(isError)
    return {errors}
}
const errorId = row => (row?.error_id != null && row.error_id !== "" ? String(row.error_id) : row?.code ? String(row.code) : null)
const errorText = errors =>
    clip(
        errors.map(row => (typeof row.detail === "string" ? row.detail : row.code != null ? String(row.code) : "")).join("; "),
        255
    )

// A transaction answer as response fields, with the source's mapping on the v3 codes; wrongState when PayTrace refused
// the operation for the transaction's state (816-818), so the caller reads the transaction.
function transactionFields(sent) {
    if (sent.unknown) return {fields: {resultUnknown: "Y", reasonMessage: sent.unknown}}
    if (sent.refused) return {fields: {resultError: "Y", reasonMessage: sent.refused}}
    const answer = answerOf(sent)
    if (answer.code != null) {
        const data = answer.data
        const fields = {
            responseCode: String(answer.code),
            reasonCode: String(answer.code),
            reasonMessage: [data.response_message, data.approval_message].filter(Boolean).join(" "),
            referenceNum: data.transaction_id ? String(data.transaction_id) : null,
            approvalCode: data.approval_code || null,
            avsResult: data.avs_response || null,
            cvResult: data.csc_response || null
        }
        if (SUCCESS_CODES.includes(answer.code)) fields.resultSuccess = "Y"
        // surcharging: PayTrace answers what it took from the card, which may differ from the amount asked for
        if (fields.resultSuccess === "Y" && data.total_amount != null && data.requested_amount != null) {
            const total = toDecimal(data.total_amount)
            if (total.compare(toDecimal(data.requested_amount)) !== 0) {
                fields.transactionStatus = "AMOUNT_MISMATCH"
                fields.reasonMessage = clip(
                    "Charged " +
                        data.total_amount +
                        " for " +
                        data.requested_amount +
                        " (surcharge " +
                        (data.surcharge_amount ?? "?") +
                        "). " +
                        fields.reasonMessage
                )
            }
        } else if (DECLINED_CODES.includes(answer.code)) fields.resultDeclined = "Y"
        else if (answer.code === UNHANDLED_CODE) fields.resultUnknown = "Y"
        else fields.resultError = "Y"
        return {fields, masked: data.masked_card_number}
    }
    // an answer with neither a response code nor an error: what PayTrace did is not known, so it is not sent again
    if (!answer.errors.length)
        return {
            fields:
                sent.status < 300
                    ? {resultUnknown: "Y", reasonMessage: "PayTrace answered HTTP " + sent.status + " without a response code"}
                    : {resultError: "Y", reasonMessage: "PayTrace refused the request (HTTP " + sent.status + ")"}
        }
    const first = answer.errors[0]
    const id = errorId(first)
    const fields = {responseCode: first?.type || "Error", reasonCode: id, reasonMessage: errorText(answer.errors)}
    if (BAD_CARD_NUMBER.includes(id)) fields.resultBadCardNumber = "Y"
    else if (BAD_EXPIRE.includes(id)) fields.resultBadExpire = "Y"
    else if (id === DUPLICATE) fields.resultUnknown = "Y"
    else if (BLOCKED.includes(id) || DECLINED_CODES.includes(Number(id))) fields.resultDeclined = "Y"
    else fields.resultError = "Y"
    return {fields, wrongState: WRONG_STATE.includes(id)}
}
function transact(base, method, path, body) {
    const mapped = transactionFields(api(base.gw, method, path, body))
    if (mapped.fields.resultUnknown === "Y")
        ec.logger.warn("PayTrace " + base.operationEnumId + " of payment " + base.payment.paymentId + ": outcome unknown")
    if (mapped.fields.transactionStatus === "AMOUNT_MISMATCH")
        ec.logger.warn("PayTrace " + base.operationEnumId + " of payment " + base.payment.paymentId + " charged another amount")
    return Object.assign({paymentGatewayResponseId: record(base, mapped.fields)}, mapped)
}

// ---- Payment operations ----

function start(p, operationEnumId, amount) {
    const begun = G.start(p, gateway(p.paymentGatewayConfigId), operationEnumId, amount)
    if (!begun.problem && begun.payment.amountUomId !== begun.gw.options.currencyUomId)
        begun.currencyProblem = "PayTrace account " + begun.gw.id + " takes " + begun.gw.options.currencyUomId
    return begun
}
// The amount in the API's form (a number of up to two places, in the account's currency), or null.
const apiAmount = (value, payment) => G.providerAmount(value, payment.amountUomId, 2)
// The text PayTrace's export can search for: the reference first, then what the payment is.
const searchable = (reference, text) => clip(reference + " " + text, 255)
// Printable ASCII, as PayTrace's reference fields take (^[ !-~]+$), within a length; null when nothing is left.
function ascii(text, length) {
    const value = clip(
        String(text ?? "")
            .replace(/[^ -~]/g, "")
            .trim(),
        length
    )
    return value ? value : null
}
// The customer's purchase order of a payment's order or invoice, the level 2 customer reference.
function customerReference(payment) {
    const invoice = payment.forInvoiceId && one("mantle.account.invoice.Invoice", {invoiceId: payment.forInvoiceId})
    if (invoice?.otherPartyOrderId) return ascii(invoice.otherPartyOrderId, 50)
    if (!payment.orderId) return null
    const parts = rows("mantle.order.OrderPart", {orderId: payment.orderId})
    const part = parts.find(row => row.orderPartSeqId === payment.orderPartSeqId) || parts.find(row => row.otherPartyOrderId)
    return ascii(part?.otherPartyOrderId, 50)
}

// authorize#Payment and authorizeAndCapture#Payment (sale): a single-use Protect.js token, else the payment method's
// vault customer. A card number the server holds is never sent; nor is a security code, which v3 takes only encrypted
// by PayTrace's browser e2ee library.
function authorize(p, sale) {
    const {payment, gw, base, problem, currencyProblem} = start(p, sale ? "PgoAuthAndCapture" : "PgoAuthorize")
    if (problem) return refuse(base, "GATEWAY_NOT_AVAILABLE", problem)
    if (currencyProblem) return refuse(base, "CURRENCY_NOT_SUPPORTED", currencyProblem)
    const amount = apiAmount(payment.amount, payment)
    if (!amount) return refuse(base, "AMOUNT_INVALID", "The amount does not suit the currency or PayTrace")
    const token = p.paymentToken || {}
    const method = payment.paymentMethodId && one(PM, {paymentMethodId: payment.paymentMethodId})
    const request = {}
    let path
    if (token.hpf_token && token.enc_key) {
        path = sale ? "/v3/card/sale/pt-protect" : "/v3/card/authorize/pt-protect"
        request.hpf_token = String(token.hpf_token)
        request.enc_key = String(token.enc_key)
    } else if (method?.gatewayCimId && method.paymentGatewayConfigId === gw.id) {
        path = (sale ? "/v3/card/sale/customer/" : "/v3/card/authorize/customer/") + encode(method.gatewayCimId)
    } else {
        return refuse(
            base,
            "NO_PAYMENT_PROFILE",
            "No PayTrace vault customer or Protect.js token for this payment; card numbers are not sent from the server"
        )
    }
    Object.assign(request, {
        amount,
        merchant_id: merchantId(gw),
        invoice_number: p.idempotencyKey,
        description: searchable(p.idempotencyKey, describe(payment))
    })
    const reference = customerReference(payment)
    if (reference) request.customer_reference_id = reference
    const out = transact(base, "POST", path, request)
    if (sale && out.fields.resultSuccess === "Y") afterCapture(gw, payment, amount, out.fields.referenceNum)
    return {paymentGatewayResponseId: out.paymentGatewayResponseId}
}

// The transaction record (GET /v3/card/transaction/{id}): {transaction}, {notFound}, or {problem} when it cannot tell.
function readTransaction(gw, transactionId) {
    const sent = api(gw, "GET", "/v3/card/transaction/" + encode(transactionId) + "?merchant_id=" + merchantId(gw))
    if (sent.unknown || sent.refused) return {problem: sent.unknown || sent.refused}
    const answer = answerOf(sent)
    const data = sent.data
    if (data && !Array.isArray(data) && typeof data === "object" && data.transaction_id != null && sent.status < 300)
        return {transaction: data}
    const id = errorId(answer.errors?.[0])
    if (NOT_FOUND.includes(id)) return {notFound: true}
    return {problem: "Transaction " + transactionId + " could not be read: " + (errorText(answer.errors || []) || sent.status)}
}
// What a transaction record's status letter (A authorized, S settled, V voided, D or F declined, L settlement lock, R
// card reversed; P, I, Z and N not decided) and its action mean: authorized, captured, settled, voided, declined, or
// null. An A whose action is not exactly auth_only is a sale, a capture or a refund waiting for settlement.
function stateOf(tx) {
    const status = String(tx.status || "").toUpperCase()
    const action = String(tx.action || "").toLowerCase()
    if (status === "S") return "settled"
    if (status === "V" || status === "R") return "voided"
    if (status === "D" || status === "F") return "declined"
    if (status === "L") return "captured"
    if (status === "A") return action === "auth_only" ? "authorized" : "captured"
    return null
}
const paymentStatus = {
    authorized: "PmntAuthorized",
    captured: "PmntDelivered",
    settled: "PmntConfirmed",
    declined: "PmntDeclined"
}
const refundStatus = {captured: "PmntDelivered", settled: "PmntConfirmed", declined: "PmntDeclined", voided: "PmntVoid"}
// The latest approved capture or sale of a payment, its gateway response.
function captureResponse(payment) {
    return Array.from(
        find(R, {paymentId: payment.paymentId, resultSuccess: "Y"})
            .condition("paymentOperationEnumId", "in", ["PgoCapture", "PgoAuthAndCapture"])
            .orderBy("-transactionDate")
            .orderBy("-paymentGatewayResponseId")
            .limit(1)
            .list()
    )[0]
}
const statusRank = {PmntAuthorized: 1, PmntDelivered: 2, PmntConfirmed: 3}
// The Payment status a transaction means for this payment, or null to leave it as it is. PayTrace may keep an
// authorization's A/auth_only after its capture (the status after a capture is not documented): a payment Mantle
// captured is never taken back to authorized, nor a settled one back to captured.
function statusFor(payment, tx) {
    let state = stateOf(tx)
    if (isRefund(payment)) return refundStatus[state] || null
    // a voided authorization; a voided capture was a refund before settlement and stays Delivered with its refund
    if (state === "voided") return payment.statusId === "PmntAuthorized" ? "PmntVoid" : null
    if (state === "authorized" && (statusRank[payment.statusId] > 1 || captureResponse(payment))) state = "captured"
    const status = paymentStatus[state] || null
    if (status && statusRank[status] && statusRank[payment.statusId] > statusRank[status]) return null
    return status
}
// Whether PayTrace still lists the transaction among those that can be captured (GET
// /v3/card/transactions/capturable/{merchant_id}, searched by its id): an authorization it no longer lists, and that is
// not voided or declined, was captured. {capturable} or {problem}.
function capturable(gw, transactionId) {
    const sent = api(
        gw,
        "GET",
        "/v3/card/transactions/capturable/" + merchantId(gw) + "?search_term=" + encode(transactionId) + "&limit=50"
    )
    if (sent.unknown || sent.refused) return {problem: sent.unknown || sent.refused}
    if (sent.status >= 300 || !Array.isArray(sent.data))
        return {problem: errorText(answerOf(sent).errors || []) || "HTTP " + sent.status}
    return {capturable: sent.data.some(row => row && String(row.transaction_id) === String(transactionId))}
}
// The settlement time of a settled transaction, when the record gives it with its zone (the schema's example has none,
// and a time without a zone is not guessed at).
function settlementDate(tx) {
    if (stateOf(tx) !== "settled") return null
    const text = String(tx.status_changed_at || "")
    if (!/(Z|[+-]\d\d:?\d\d)$/.test(text)) return null
    const millis = Date.parse(text)
    return Number.isNaN(millis) ? null : new Date(millis)
}

// A capture or void the provider refused for the transaction's state (816, 818) is a success when the transaction is
// already in the state asked for (a retry of one that was done).
function alreadyDone(base, out, transactionId, done, reasonCode) {
    if (!out.wrongState) return out
    const got = readTransaction(base.gw, transactionId)
    let isDone = !!got.transaction && done.includes(stateOf(got.transaction))
    // a capture refused while the record still reads A/auth_only: captured if PayTrace no longer lists it as capturable,
    // and unknown (looked up) when that cannot be asked
    if (!isDone && got.transaction && reasonCode === "ALREADY_CAPTURED" && stateOf(got.transaction) === "authorized") {
        const check = capturable(base.gw, transactionId)
        if (check.problem) {
            call("update#" + R, {
                paymentGatewayResponseId: out.paymentGatewayResponseId,
                resultError: "N",
                resultUnknown: "Y",
                reasonMessage: clip("Refused for its state, and whether it is captured could not be read: " + check.problem)
            })
            out.fields = Object.assign({}, out.fields, {resultError: "N", resultUnknown: "Y"})
            return out
        }
        isDone = !check.capturable
    }
    if (!isDone) return out
    call("update#" + R, {
        paymentGatewayResponseId: out.paymentGatewayResponseId,
        resultSuccess: "Y",
        resultError: "N",
        reasonCode,
        referenceNum: transactionId
    })
    out.fields = Object.assign({}, out.fields, {resultSuccess: "Y", resultError: "N"})
    return out
}

function capture(p) {
    const {payment, gw, base, problem, currencyProblem} = start(p, "PgoCapture", p.amount)
    if (problem) return refuse(base, "GATEWAY_NOT_AVAILABLE", problem)
    if (currencyProblem) return refuse(base, "CURRENCY_NOT_SUPPORTED", currencyProblem)
    const transactionId = authorizedTransaction(payment)
    if (!transactionId)
        return refuse(base, "NO_REFERENCE", "No authorization transaction to capture for payment " + payment.paymentId)
    const amount = apiAmount(p.amount ?? payment.amount, payment)
    if (!amount) return refuse(base, "AMOUNT_INVALID", "The amount does not suit the currency or PayTrace")
    let out = transact(base, "POST", "/v3/card/batch/capture", {
        merchant_id: merchantId(gw),
        batch_items: [{transaction_id: transactionId, amount}]
    })
    out = alreadyDone(base, out, transactionId, ["captured", "settled"], "ALREADY_CAPTURED")
    if (out.fields.resultSuccess === "Y") afterCapture(gw, payment, amount, transactionId)
    return {paymentGatewayResponseId: out.paymentGatewayResponseId}
}

function release(p) {
    const {payment, gw, base, problem} = start(p, "PgoRelease")
    if (problem) return refuse(base, "GATEWAY_NOT_AVAILABLE", problem)
    const transactionId = authorizedTransaction(payment)
    if (!transactionId)
        return refuse(base, "NO_REFERENCE", "No authorization transaction to void for payment " + payment.paymentId)
    const out = transact(base, "POST", "/v3/card/batch/void", {
        merchant_id: merchantId(gw),
        batch_items: [{transaction_id: transactionId}]
    })
    return {
        paymentGatewayResponseId: alreadyDone(base, out, transactionId, ["voided"], "ALREADY_VOIDED").paymentGatewayResponseId
    }
}

// refund#Payment, linked to the original transaction; never an unlinked credit. PayTrace refunds a settled transaction
// (the refund authorization by transaction id, which takes the reference and has its own transaction id); a captured one
// not settled yet is voided whole (recorded as the refund, reasonCode VOID_BEFORE_SETTLEMENT, the original's id in
// altReference: the money never moves and the original stays Delivered with its refund applied); a partial refund before
// settlement is refused (REFUND_BEFORE_SETTLEMENT) and can be sent again after settlement.
function refund(p) {
    const {payment, gw, base, problem, currencyProblem} = start(p, "PgoRefund", p.amount)
    if (problem) return refuse(base, "GATEWAY_NOT_AVAILABLE", problem)
    if (currencyProblem) return refuse(base, "CURRENCY_NOT_SUPPORTED", currencyProblem)
    const transactionId = authorizedTransaction(payment)
    if (!transactionId) return refuse(base, "NO_REFERENCE", "No transaction to refund for payment " + payment.paymentId)
    const amount = apiAmount(p.amount ?? payment.amount, payment)
    if (!amount) return refuse(base, "AMOUNT_INVALID", "The amount does not suit the currency or PayTrace")
    const original = readTransaction(gw, transactionId)
    if (!original.transaction)
        return refuse(
            base,
            "DETAILS_UNAVAILABLE",
            "Could not read transaction " + transactionId + " before the refund: " + (original.problem || "not found")
        )
    const tx = original.transaction
    const state = stateOf(tx)
    if (state === "settled") {
        const out = transact(base, "POST", "/v3/card/refund-auth/by-transaction/" + encode(transactionId), {
            amount,
            merchant_id: merchantId(gw),
            invoice_number: p.idempotencyKey,
            description: searchable(p.idempotencyKey, "Refund of " + describe(payment))
        })
        return {paymentGatewayResponseId: out.paymentGatewayResponseId}
    }
    if (state === "captured") {
        const captured = toDecimal(captureResponse(payment)?.amount ?? payment.amount)
        if (amount.compare(captured) !== 0 || G.otherRefundCount(payment, p.refundPaymentId) > 0)
            return refuse(
                base,
                "REFUND_BEFORE_SETTLEMENT",
                "PayTrace refunds a transaction after it settles; before that only the whole amount can be voided"
            )
        const voided = transact(base, "POST", "/v3/card/batch/void", {
            merchant_id: merchantId(gw),
            batch_items: [{transaction_id: transactionId}]
        })
        // the void's transaction id is the original's: kept as altReference, so the refund payment does not take it
        if (voided.fields.resultSuccess === "Y")
            call("update#" + R, {
                paymentGatewayResponseId: voided.paymentGatewayResponseId,
                reasonCode: "VOID_BEFORE_SETTLEMENT",
                reasonMessage: clip("Voided before settlement: " + (voided.fields.reasonMessage || "")),
                altReference: transactionId,
                referenceNum: null
            })
        return {paymentGatewayResponseId: voided.paymentGatewayResponseId}
    }
    return refuse(
        base,
        "TRANSACTION_NOT_REFUNDABLE",
        "Transaction " + transactionId + " is " + (tx.status || "unknown") + ", not refundable"
    )
}

// ---- Transaction details and lookups ----

// get#PaymentGatewayDetails. With an idempotency key, the lost operation's outcome (operationFound); without, the
// status of the payment's transaction. A status change is recorded as a PgoTxDetails response.
function details(p) {
    const payment = one(P, {paymentId: p.paymentId})
    const gw = gateway(p.paymentGatewayConfigId)
    if (!payment || gw.problem) {
        ec.message.addMessage(
            "Not getting PayTrace details for payment " + p.paymentId + ": " + (gw.problem || "not found"),
            "warning"
        )
        return {}
    }
    if (p.idempotencyKey) return resolve(gw, payment, p)
    if (!payment.paymentRefNum) return {}
    const got = readTransaction(gw, payment.paymentRefNum)
    if (!got.transaction) {
        ec.message.addMessage(
            "Could not read PayTrace transaction " + payment.paymentRefNum + ": " + (got.problem || "not found"),
            "warning"
        )
        return {}
    }
    return detailsOut(gw, payment, got.transaction, statusFor(payment, got.transaction))
}
// The lookup's answer; a PgoTxDetails response records a change only: a status that differs from the payment's, or a
// transaction status other than the last one recorded (so a poll does not add a row each time).
function detailsOut(gw, payment, tx, gatewayStatusId, extra = {}) {
    const transactionStatus = clip(String(tx.status || "") + (tx.action ? "/" + tx.action : ""), 60)
    const out = Object.assign(
        {gatewayStatusId, referenceNum: String(tx.transaction_id), approvalCode: null, settlementDate: settlementDate(tx)},
        extra
    )
    const statusChange = gatewayStatusId != null && gatewayStatusId !== payment.statusId
    if (statusChange || G.lastDetailsStatus(payment.paymentId) !== transactionStatus)
        out.paymentGatewayResponseId = record(
            {gw, payment, operationEnumId: "PgoTxDetails", amount: payment.amount},
            {
                referenceNum: String(tx.transaction_id),
                transactionStatus,
                reasonMessage: tx.approval_message || tx.authorization_result_message || null,
                resultDeclined: stateOf(tx) === "declined" ? "Y" : "N"
            }
        )
    return out
}
// The transaction Mantle sent with this reference: the export by date (from a day before the lost request to a day
// after now, in the user's zone, as PayTrace takes MM/DD/YYYY) searched for the reference text, and the candidates whose
// description starts with it read by id (not by invoice_number, which enhanced data overwrites). Error 180 is none
// found. {transaction, exported}, {notFound}, or {problem}.
function findByReference(gw, reference, sinceMillis) {
    const now = Number(ec.user.nowTimestamp)
    const day = millis => ec.l10n.format(new Date(millis), "MM/dd/yyyy")
    const sent = api(gw, "POST", "/v3/transactions/export/by-date", {
        start_date: day(Number(sinceMillis || now) - DAY),
        end_date: day(now + DAY),
        including_text: reference
    })
    if (sent.unknown || sent.refused) return {problem: sent.unknown || sent.refused}
    const data = sent.data
    if (!data || Array.isArray(data) || sent.status >= 300) {
        const errors = answerOf(sent).errors || []
        if (errors.some(row => errorId(row) === NO_TRANSACTIONS)) return {notFound: true}
        return {problem: errorText(errors) || "HTTP " + sent.status}
    }
    const list = [].concat(data.transactions || [])
    const candidates = list.filter(row => String(row.description || "").startsWith(reference)).slice(0, LOOKUP_CANDIDATES)
    for (const exported of candidates) {
        const got = readTransaction(gw, exported.transaction_id)
        if (got.problem) return got
        if (got.transaction) return {transaction: got.transaction, exported}
    }
    return {notFound: true}
}
// A lost operation: a capture or a void is looked up on the authorization's transaction, an authorization, sale or
// refund by its reference. Not found answers false only once the lost request is older than the grace period.
function resolve(gw, payment, p) {
    const op = p.paymentOperationEnumId
    if (op === "PgoCapture" || op === "PgoRelease") {
        const transactionId = authorizedTransaction(payment)
        const got = transactionId ? readTransaction(gw, transactionId) : {problem: "no transaction"}
        if (!got.transaction) return {}
        const state = stateOf(got.transaction)
        const done = op === "PgoCapture" ? ["captured", "settled"].includes(state) : state === "voided"
        // a found void: get#SinglePaymentGatewayDetails makes the payment promised again, without its references
        if (done && op === "PgoRelease") return {operationFound: true, gatewayStatusId: "PmntPromised"}
        // a found capture's enhanced data, which its lost answer did not send
        if (done && state === "captured")
            afterCapture(gw, payment, G.lostResponse(p.idempotencyKey)?.amount ?? payment.amount, transactionId)
        if (done) return detailsOut(gw, payment, got.transaction, paymentStatus[state], {operationFound: true})
        if (state === "authorized" && op === "PgoCapture") {
            // the record may keep A/auth_only after a capture: still capturable is not captured, else it was
            const check = capturable(gw, transactionId)
            if (check.problem) return {}
            if (check.capturable) return {operationFound: false, gatewayStatusId: payment.statusId}
            afterCapture(gw, payment, G.lostResponse(p.idempotencyKey)?.amount ?? payment.amount, transactionId)
            return detailsOut(gw, payment, got.transaction, "PmntDelivered", {operationFound: true})
        }
        if (state === "authorized") return {operationFound: false, gatewayStatusId: payment.statusId}
        return {}
    }
    const lost = G.lostResponse(p.idempotencyKey)
    const found = findByReference(gw, p.idempotencyKey, lost?.transactionDate)
    if (found.transaction) {
        if (op === "PgoAuthAndCapture" && stateOf(found.transaction) === "captured")
            afterCapture(gw, payment, lost?.amount ?? payment.amount, String(found.transaction.transaction_id))
        return detailsOut(gw, payment, found.transaction, statusFor(payment, found.transaction), {
            operationFound: true,
            approvalCode: found.exported?.approval_code || null
        })
    }
    if (found.problem) return {}
    // a refund before settlement is a void of the original, which has no transaction of its own
    if (op === "PgoRefund" && payment.refundForPaymentId) {
        const original = one(P, {paymentId: payment.refundForPaymentId})
        const transactionId = original && authorizedTransaction(original)
        const got = transactionId ? readTransaction(gw, transactionId) : {}
        if (got.problem) return {}
        if (got.transaction && stateOf(got.transaction) === "voided")
            return {operationFound: true, gatewayStatusId: "PmntDelivered"}
    }
    if (!G.pastGrace(lost, gw.options.lookupGraceSeconds ?? GRACE_SECONDS)) return {}
    return {operationFound: false, gatewayStatusId: isRefund(payment) ? "PmntCancelled" : payment.statusId}
}

// ---- Enhanced (level 2/3) data ----

const money = (value, currencyUomId) => ec.l10n.roundCurrency(toDecimal(value ?? 0), currencyUomId)
const ZERO = () => toDecimal(0)

// The order or invoice lines of a payment, as {items, invoiceNumber, shipping}: the invoice it pays (forInvoiceId), else
// its order part (or the whole order). Items: {seqId, parentSeqId, itemTypeEnumId, productId, description, quantity,
// unitAmount, quantityUomId}.
function linesOf(payment) {
    if (payment.forInvoiceId) {
        const items = rows("mantle.account.invoice.InvoiceItem", {invoiceId: payment.forInvoiceId}).map(row => ({
            seqId: row.invoiceItemSeqId,
            parentSeqId: row.parentItemSeqId || null,
            itemTypeEnumId: row.itemTypeEnumId,
            productId: row.productId,
            description: row.description,
            quantity: toDecimal(row.quantity ?? 1),
            unitAmount: toDecimal(row.amount ?? 0),
            quantityUomId: row.quantityUomId
        }))
        return {items, invoiceNumber: payment.forInvoiceId, shipping: null}
    }
    if (!payment.orderId) return null
    const conditions = {orderId: payment.orderId}
    if (payment.orderPartSeqId) conditions.orderPartSeqId = payment.orderPartSeqId
    const items = rows("mantle.order.OrderItem", conditions).map(row => ({
        seqId: row.orderItemSeqId,
        parentSeqId: row.parentItemSeqId || null,
        itemTypeEnumId: row.itemTypeEnumId,
        productId: row.productId,
        description: row.itemDescription,
        quantity: toDecimal(row.quantity ?? 1).subtract(toDecimal(row.quantityCancelled ?? 0)),
        unitAmount: toDecimal(row.unitAmount ?? 0).multiply(toDecimal(row.selectedAmount ?? 1)),
        quantityUomId: row.quantityUomId
    }))
    const parts = rows("mantle.order.OrderPart", {orderId: payment.orderId})
    const part = parts.find(row => row.orderPartSeqId === payment.orderPartSeqId) || parts.find(row => row.postalContactMechId)
    const address =
        part?.postalContactMechId && one("mantle.party.contact.PostalAddress", {contactMechId: part.postalContactMechId})
    const country = address?.countryGeoId && one("moqui.basic.Geo", {geoId: address.countryGeoId})
    return {
        items,
        invoiceNumber: payment.orderId,
        shipping: address ? {postalCode: address.postalCode, country: country?.geoCodeAlpha2} : null
    }
}

// The level 3 summary and line items of the lines, in the payment's currency: each line's amount is its quantity times
// its unit amount rounded to the currency; a line's tax and discount children are its item tax and discount, a
// shipping line (and its own discounts) is freight, tax lines are tax, order discounts are the summary discount; other
// children are lines of their own. VAT, not added to totals, is left out.
function levelThree(gw, source, currencyUomId) {
    const children = new Map()
    for (const item of source.items)
        if (item.parentSeqId) children.set(item.parentSeqId, (children.get(item.parentSeqId) || []).concat([item]))
    const total = item => money(item.quantity.multiply(item.unitAmount), currencyUomId)
    const is = (item, types) => types.includes(item.itemTypeEnumId)
    let tax = ZERO(),
        freight = ZERO(),
        discount = ZERO()
    const lines = []
    const addLine = (item, lineTax, lineDiscount) => {
        if (item.quantity.compare(0) <= 0) return
        const amount = total(item)
        if (amount.compare(0) < 0) {
            discount = discount.add(amount.abs())
            return
        }
        // a line discount is at most the line's amount; the rest is the summary's
        const own = lineDiscount.compare(amount) > 0 ? amount : lineDiscount
        discount = discount.add(lineDiscount.subtract(own))
        lines.push({item, amount, tax: lineTax, discount: own})
    }
    for (const item of source.items) {
        if (item.parentSeqId || is(item, UNTOTALED_TAX_TYPES)) continue
        const own = children.get(item.seqId) || []
        if (is(item, TAX_TYPES)) {
            tax = tax.add(total(item))
        } else if (is(item, DISCOUNT_TYPES)) {
            discount = discount.add(total(item).abs())
        } else if (is(item, FREIGHT_TYPES)) {
            freight = freight.add(total(item))
            for (const child of own) {
                if (is(child, UNTOTALED_TAX_TYPES)) continue
                if (is(child, TAX_TYPES)) tax = tax.add(total(child))
                else freight = freight.add(total(child))
            }
        } else {
            let lineTax = ZERO(),
                lineDiscount = ZERO()
            for (const child of own) {
                if (is(child, UNTOTALED_TAX_TYPES)) continue
                const amount = total(child)
                if (is(child, TAX_TYPES)) {
                    lineTax = lineTax.add(amount)
                    tax = tax.add(amount)
                } else if (is(child, DISCOUNT_TYPES) || amount.compare(0) < 0) lineDiscount = lineDiscount.add(amount.abs())
                else if (is(child, FREIGHT_TYPES)) freight = freight.add(amount)
                else addLine(child, ZERO(), ZERO())
            }
            addLine(item, lineTax, lineDiscount)
        }
    }
    const productOf = productId => productId && one("mantle.product.Product", {productId})
    const commodityOf = productId =>
        (productId &&
            Array.from(
                find("mantle.product.ProductIdentification", {productId, productIdTypeEnumId: "PidtCommodityCode"})
                    .limit(1)
                    .list()
            )[0]?.idValue) ||
        gw.options.commodityCode
    const lineItems = lines.map(({item, amount, tax: lineTax, discount: lineDiscount}) => {
        const product = productOf(item.productId)
        const label = ascii(item.description || product?.productName || item.productId || item.itemTypeEnumId, 35)
        // quantity times unit cost is the line's amount: the unit amount, else rounded to the currency, else the line
        // as one unit of its amount (a unit amount finer than the currency)
        let quantity = item.quantity,
            unitCost = item.unitAmount
        if (quantity.multiply(unitCost).compare(amount) !== 0) {
            const rounded = money(unitCost, currencyUomId)
            if (quantity.multiply(rounded).compare(amount) === 0) unitCost = rounded
            else {
                quantity = toDecimal(1)
                unitCost = amount
            }
        }
        const line = {
            product_label: label && label.length >= 2 ? label : ascii("Item " + item.seqId, 35),
            quantity,
            unit_cost: unitCost,
            item_total_amount: amount.subtract(lineDiscount),
            item_tax_amount: lineTax,
            discount_amount: lineDiscount
        }
        const unit = ascii(unitCodes[item.quantityUomId] || gw.options.defaultUnitOfMeasure, 12)
        if (unit && /^[A-Za-z0-9]+$/.test(unit)) line.unit_of_measure = unit
        const commodity = ascii(commodityOf(item.productId), 20)
        if (commodity && /^[A-Za-z0-9-]{3,20}$/.test(commodity)) line.commodity_code = commodity
        line.product_code = ascii(product?.pseudoId || item.productId || item.seqId, 12)
        return line
    })
    const itemsTotal = lineItems.reduce((sum, line) => sum.add(line.item_total_amount), ZERO())
    return {tax, freight, discount, lineItems, itemsTotal}
}

// The Enhanced Data request of a payment's capture or sale of amount: level 3 (the summary and the line items) when
// the lines balance with the amount (the line items' totals, less the summary discount, plus freight and tax, as the
// PayTrace Enhanced Data guide states), else level 2 only (the customer reference and invoice number: a partial
// payment's lines do not describe it). null when the payment has no order or invoice.
function enhancedRequest(gw, payment, amount) {
    const source = linesOf(payment)
    if (!source || !source.items.length) return null
    const currencyUomId = payment.amountUomId
    const request = {}
    // required for level 2 and 3: the customer's PO, else Mantle's invoice or order id
    request.customer_reference_id = customerReference(payment) || ascii(source.invoiceNumber, 50)
    request.invoice_number = ascii(source.invoiceNumber, 50)
    const l3 = levelThree(gw, source, currencyUomId)
    const balance = l3.itemsTotal.subtract(l3.discount).add(l3.freight).add(l3.tax)
    const balanced = l3.lineItems.length > 0 && l3.freight.compare(0) >= 0 && balance.compare(toDecimal(amount)) === 0
    if (!balanced) return {request, level: "level2", balance}
    // as the source: no tax is sent as -1, the API's tax exempt
    request.tax_amount = l3.tax.compare(0) > 0 ? l3.tax : toDecimal(-1)
    request.freight_amount = l3.freight
    request.discount_amount = l3.discount
    const postalCode = source.shipping?.postalCode && String(source.shipping.postalCode).trim()
    if (postalCode && /^[a-zA-Z0-9 -]{5,10}$/.test(postalCode)) {
        request.shipping_address = {postal_code: postalCode}
        if (source.shipping.country) request.shipping_address.country = source.shipping.country
    }
    request.line_items = l3.lineItems
    return {request, level: "level3", balance}
}

// Send a payment's enhanced data for its captured transaction and record the outcome as its own PgoLevel3Data
// response: success (170, 171), or resultError with ENHANCED_DATA_REJECTED (PayTrace's error ids in responseCode),
// ENHANCED_DATA_UNCONFIRMED (another answer), ENHANCED_DATA_NO_ANSWER, ENHANCED_DATA_NOT_SENT or ENHANCED_DATA_FAILED (the
// data could not be built). Never resultUnknown: the PUT is a full overwrite (PayTrace calls it idempotent), so sending it
// again is safe, and an unknown response would block the payment's charge operations. The charge is never sent or
// changed here. null when there is nothing to send.
function sendEnhancedData(gw, payment, amount, transactionId) {
    if (gw.options.sendEnhancedData === "N" || !transactionId) return null
    const base = {gw, payment, operationEnumId: "PgoLevel3Data", amount: toDecimal(amount)}
    let built
    try {
        built = enhancedRequest(gw, payment, amount)
    } catch (error) {
        ec.logger.error(
            "PayTrace enhanced data of payment " + payment.paymentId + " could not be built: " + clip(error.message, 200)
        )
        const failed = {
            referenceNum: transactionId,
            resultError: "Y",
            reasonCode: "ENHANCED_DATA_FAILED",
            reasonMessage: error.message
        }
        return {paymentGatewayResponseId: record(base, failed), accepted: false, level: null}
    }
    if (!built) return null
    const sent = api(gw, "PUT", "/v3/invoice/by-transaction-id/" + encode(transactionId), built.request)
    const fields = {referenceNum: transactionId, transactionStatus: built.level}
    if (sent.unknown || sent.refused) {
        Object.assign(fields, {
            resultError: "Y",
            reasonCode: sent.unknown ? "ENHANCED_DATA_NO_ANSWER" : "ENHANCED_DATA_NOT_SENT",
            reasonMessage: sent.unknown || sent.refused
        })
    } else {
        const answer = answerOf(sent)
        if (ENHANCED_CODES.includes(answer.code) && sent.status < 300) {
            Object.assign(fields, {
                resultSuccess: "Y",
                responseCode: String(answer.code),
                reasonCode: String(answer.code),
                reasonMessage: answer.data.response_message
            })
        } else {
            const errors = answer.errors || []
            Object.assign(fields, {
                resultError: "Y",
                responseCode: clip(errors.map(errorId).filter(Boolean).join(","), 60) || String(answer.code ?? sent.status),
                reasonCode: errors.length ? "ENHANCED_DATA_REJECTED" : "ENHANCED_DATA_UNCONFIRMED",
                reasonMessage: errorText(errors) || answer.data?.response_message || null
            })
        }
    }
    if (fields.resultError === "Y")
        ec.logger.warn("PayTrace enhanced data of payment " + payment.paymentId + " not accepted: " + fields.reasonCode)
    return {paymentGatewayResponseId: record(base, fields), accepted: fields.resultSuccess === "Y", level: built.level}
}
// After an approved capture or sale of transactionId: its enhanced data, sent by send#EnhancedData once the charge's
// transaction commits (on a service thread, in a transaction of its own, so it never fails, rolls back or holds the
// charge). Not queued (no transaction), it is sent by the retry job, which also finds captures with no enhanced data.
function afterCapture(gw, payment, amount, transactionId) {
    if (gw.options.sendEnhancedData === "N" || (!payment.orderId && !payment.forInvoiceId)) return
    try {
        ec.service
            .special()
            .name("mantle.ext.account.gateway.PayTraceServices.send#EnhancedData")
            .parameters({paymentId: payment.paymentId, transactionId, amount: String(amount)})
            .registerOnCommit()
    } catch (error) {
        ec.logger.warn(
            "PayTrace enhanced data of payment " +
                payment.paymentId +
                " not queued; the retry job sends it: " +
                clip(error.message, 200)
        )
    }
}
// Whether the payment's capture was voided before settlement as its refund: its transaction takes no enhanced data.
function voidedBeforeSettlement(payment) {
    return (
        find(R, {
            paymentId: payment.paymentId,
            paymentOperationEnumId: "PgoRefund",
            reasonCode: "VOID_BEFORE_SETTLEMENT",
            resultSuccess: "Y"
        }).count() > 0
    )
}
// send#EnhancedData: send a captured payment's enhanced data again (the whole payload, never the charge).
function enhancedData(p) {
    const payment = one(P, {paymentId: p.paymentId})
    if (!payment) throw new Error("PAYMENT_NOT_FOUND: Payment " + p.paymentId + " not found")
    const gw = gateway(payment.paymentGatewayConfigId)
    if (gw.problem) throw new Error("GATEWAY_NOT_AVAILABLE: " + gw.problem)
    if (!["PmntDelivered"].includes(payment.statusId))
        throw new Error("PAYMENT_NOT_CAPTURED: Enhanced data goes with a captured payment that has not settled")
    if (voidedBeforeSettlement(payment))
        throw new Error("TRANSACTION_VOIDED: The payment's transaction was voided before settlement")
    // the capture or sale the data describes: the one given (after its commit), else the latest
    const amount = p.amount ?? captureResponse(payment)?.amount ?? payment.amount
    const sent = sendEnhancedData(gw, payment, amount, p.transactionId || authorizedTransaction(payment))
    if (!sent) return {sent: false}
    return {sent: true, accepted: sent.accepted, level: sent.level, paymentGatewayResponseId: sent.paymentGatewayResponseId}
}
// retry#EnhancedData: the captured, unsettled payments of PayTrace gateways whose latest enhanced data was not accepted,
// or that have none (a capture whose after-commit send did not run), newest first up to the limit, each sent again on
// its own: one that fails is logged and the others go on. A payment is tried at most maxAttempts times, and one whose
// transaction was voided before settlement is left.
function retryEnhancedData(p) {
    const gatewayIds = rows(CONFIG, {paymentGatewayTypeEnumId: "PgtPayTrace"}).map(row => row.paymentGatewayConfigId)
    const outcome = {retried: 0, accepted: 0, failed: 0}
    if (!gatewayIds.length) return outcome
    const limit = Number(p.checkLimit ?? 200)
    const maxAttempts = Number(p.maxAttempts ?? 5)
    const since = new Date(Number(ec.user.nowTimestamp) - Number(p.lookBackDays ?? 30) * DAY)
    const recent = operations =>
        Array.from(
            find(R, {resultSuccess: operations.success})
                .condition("paymentOperationEnumId", "in", operations.ids)
                .condition("paymentGatewayConfigId", "in", gatewayIds)
                .condition("transactionDate", "greater-equals", since)
                .orderBy("-transactionDate")
                .limit(limit * 4)
                .list()
        )
    const paymentIds = []
    for (const row of recent({ids: ["PgoLevel3Data"], success: "N"}).concat(
        recent({ids: ["PgoCapture", "PgoAuthAndCapture"], success: "Y"})
    ))
        if (!paymentIds.includes(row.paymentId)) paymentIds.push(row.paymentId)
    for (const paymentId of paymentIds) {
        if (outcome.retried + outcome.failed >= limit) break
        const payment = one(P, {paymentId})
        if (payment?.statusId !== "PmntDelivered" || (!payment.orderId && !payment.forInvoiceId)) continue
        const sends = Array.from(
            find(R, {paymentId, paymentOperationEnumId: "PgoLevel3Data"})
                .orderBy("-transactionDate")
                .orderBy("-paymentGatewayResponseId")
                .list()
        )
        if (sends[0]?.resultSuccess === "Y" || sends.length >= maxAttempts || voidedBeforeSettlement(payment)) continue
        try {
            const out = lib.probe("mantle.ext.account.gateway.PayTraceServices.send#EnhancedData", {paymentId})
            if (!out.sent) continue
            outcome.retried++
            if (out.accepted) outcome.accepted++
        } catch (error) {
            outcome.failed++
            ec.logger.error("PayTrace enhanced data retry of payment " + paymentId + " failed: " + clip(error.message, 200))
        }
    }
    return outcome
}

// ---- Vault customers (payment profiles) ----

// store#CustomerPaymentProfile: a vault customer from a single-use Protect.js token. PayTrace keeps one card per vault
// customer: its customer_id is the method's gatewayCimId (what an authorization names) and the customer_label Mantle gave
// it (the gateway's customerLabelPrefix, "mantle-" and the payment method id) its gatewayCustomerId. The method keeps those and the masked card only.
function storeProfile(p) {
    const gw = gateway(p.paymentGatewayConfigId)
    let method = p.paymentMethodId && one(PM, {paymentMethodId: p.paymentMethodId})
    const partyId = p.partyId || method?.ownerPartyId
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
    if (!token.hpf_token || !token.enc_key) throw new Error("TOKEN_REQUIRED: A payment profile is made from a Protect.js token")
    const contact = G.billingContact(method, partyId)
    // a new method first, so its id names the vault customer (a failure below rolls it back)
    const paymentMethodId = method?.paymentMethodId || G.createCardMethod(partyId, {}, null, null)
    const label = clip((gw.options.customerLabelPrefix || "") + "mantle-" + paymentMethodId, 50)
    const request = {hpf_token: String(token.hpf_token), enc_key: String(token.enc_key), customer_label: clip(label, 50)}
    const name = [contact.firstName, contact.lastName].filter(Boolean).join(" ") || contact.company
    const address = {
        name: clip(name, 50),
        street_address: clip(contact.address1, 75),
        street_address2: clip(contact.address2, 50),
        city: clip(contact.city, 30),
        state: contact.stateCode && contact.stateCode.length <= 2 ? contact.stateCode : null,
        postal_code: contact.postalCode && contact.postalCode.length >= 5 ? clip(contact.postalCode, 9) : null,
        country: contact.countryAlpha2
    }
    const billing = Object.fromEntries(Object.entries(address).filter(([, value]) => value))
    if (Object.keys(billing).length) request.billing_address = billing
    if (p.emailAddress) request.email = clip(p.emailAddress, 50)
    const base = {gw, operationEnumId: "PgoStoreCim", paymentMethodId}
    const sent = api(gw, "POST", "/v3/customer/create/pt-protect", request)
    const answer = sent.data !== undefined ? answerOf(sent) : {}
    const customerId = answer.code === 160 && answer.data.customer_id != null ? String(answer.data.customer_id) : null
    if (!customerId) {
        const message = sent.unknown || sent.refused || errorText(answer.errors || []) || "The vault customer was not made"
        record(base, {
            resultError: "Y",
            responseCode: answer.code != null ? String(answer.code) : "Error",
            reasonCode: errorId(answer.errors?.[0]),
            reasonMessage: message
        })
        throw new Error("PROFILE_NOT_STORED: " + clip(message, 200))
    }
    // the masked card for display (failure tolerant: the vault customer is kept either way)
    const shown = api(gw, "GET", "/v3/customer/" + encode(customerId))
    const card = shown.data && !Array.isArray(shown.data) && typeof shown.data === "object" ? shown.data : {}
    const last4 = G.last4Of(card.card_masked)
    const references = {paymentGatewayConfigId: gw.id, gatewayCimId: customerId, gatewayCustomerId: label}
    call(
        "update#" + PM,
        Object.assign({paymentMethodId}, references, method ? {} : {description: last4 ? "Card ending " + last4 : "Card"})
    )
    const creditCard = one("mantle.account.method.CreditCard", {paymentMethodId})
    const year = String(card.exp_year || "")
    const expireDate =
        card.exp_month && year ? String(card.exp_month).padStart(2, "0") + "/" + (year.length === 2 ? "20" + year : year) : null
    const cardFields = {
        paymentMethodId,
        cardNumber: last4 ? "XXXX" + last4 : creditCard?.cardNumber || null,
        cardSecurityCode: null
    }
    if (expireDate) cardFields.expireDate = expireDate
    call((creditCard ? "update#" : "create#") + "mantle.account.method.CreditCard", cardFields)
    const paymentGatewayResponseId = record(base, {
        resultSuccess: "Y",
        responseCode: String(answer.code),
        reasonCode: String(answer.code),
        reasonMessage: answer.data.status_message,
        referenceNum: customerId
    })
    return {paymentMethodId, gatewayCimId: customerId, gatewayCustomerId: label, paymentGatewayResponseId}
}

// delete#CustomerPaymentProfile: remove the method's vault customer at PayTrace and its reference here. A failure is a
// warning and keeps the reference, so the delete can be done again; it never stops the method's own delete.
function deleteProfile(p) {
    const method = one(PM, {paymentMethodId: p.paymentMethodId})
    if (!method?.gatewayCimId) return {}
    const gw = gateway(method.paymentGatewayConfigId)
    if (gw.problem) return {}
    const base = {gw, operationEnumId: "PgoStoreCim", paymentMethodId: method.paymentMethodId}
    const sent = api(gw, "DELETE", "/v3/customer/" + encode(method.gatewayCimId))
    const answer = sent.data !== undefined ? answerOf(sent) : {}
    // 61: already gone at PayTrace
    if (answer.code === 162 || errorId(answer.errors?.[0]) === CUSTOMER_NOT_FOUND) {
        call("update#" + PM, {paymentMethodId: method.paymentMethodId, gatewayCimId: null})
        return {
            deleted: true,
            paymentGatewayResponseId: record(base, {
                resultSuccess: "Y",
                responseCode: answer.code != null ? String(answer.code) : CUSTOMER_NOT_FOUND,
                reasonMessage: answer.data?.status_message || errorText(answer.errors || []),
                referenceNum: method.gatewayCimId
            })
        }
    }
    const message = sent.unknown || sent.refused || errorText(answer.errors || []) || "not deleted"
    ec.logger.warn("PayTrace vault customer of method " + method.paymentMethodId + " not deleted: " + clip(message, 200))
    ec.message.addMessage("The card's PayTrace vault record was not deleted; try again later", "warning")
    return {
        deleted: false,
        paymentGatewayResponseId: record(base, {
            resultError: "Y",
            responseCode: "Error",
            reasonCode: errorId(answer.errors?.[0]),
            reasonMessage: message
        })
    }
}

// ---- Browser tokenization (Protect.js) ----

// get#BrowserPaymentConfig: the Protect.js script of the connection's environment, a client key for it (POST
// /v3/payment-fields/token, valid 20 minutes: a short-lived browser key, given to the page and never recorded or logged),
// and what the page shows.
function browserConfig(p) {
    const {payment, gw} = G.browserPayment(p.paymentId, false, gateway)
    const sandbox = gw.remote.usageCode !== "P"
    const sent = api(gw, "POST", "/v3/payment-fields/token", {})
    const data = sent.data && !Array.isArray(sent.data) && typeof sent.data === "object" ? sent.data : {}
    if (!data.clientKey) ec.logger.warn("PayTrace Protect.js client key for payment " + payment.paymentId + " not given")
    return {
        paymentId: payment.paymentId,
        clientKey: data.clientKey ? String(data.clientKey) : null,
        protectJsUrl: sandbox
            ? "https://protect.sandbox.paytrace.com/js/protect.min.js"
            : "https://protect.paytrace.com/js/protect.min.js",
        amount: payment.amount,
        currencyUomId: payment.amountUomId,
        amountText: ec.l10n.formatCurrency(payment.amount, payment.amountUomId)
    }
}
// submit#BrowserPaymentToken: authorize the payment with the browser's single-use Protect.js token (GatewayLib's
// submitBrowserToken: the lock and recheck, begin# before a profile, the payer's consent to keep the card).
function submitToken(p) {
    if (!p.hpfToken || !p.encKey) throw new Error("TOKEN_REQUIRED: No card details were tokenized")
    return G.submitBrowserToken({
        paymentId: p.paymentId,
        gatewayOf: gateway,
        operationPrefix: "ptrace",
        operationId: p.operationId,
        paymentToken: {hpf_token: p.hpfToken, enc_key: p.encKey},
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
    enhancedData,
    retryEnhancedData,
    storeProfile,
    deleteProfile,
    browserConfig,
    submitToken
}
;({
    execute(op, input) {
        return G.dispatch("PayTrace", operations, op, input)
    }
})
