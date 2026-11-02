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

// What the external card gateway adapters share (plan/payments-shipping-edi.md P1 Authorize.Net, P2 PayTrace), on the
// contract of mantle.account.PaymentServices.authorize#Payment: the response record with every result flag, the refusal
// of an operation that is not sent, amounts in the provider's decimal form, the original transaction of a payment, the
// lost response and its grace period, the address of a payment method, and the browser token endpoints (the payer or
// treasury check, the lock and recheck, begin#PaymentGatewayOperation before any profile is made, the payer's consent to
// keep the card, and the state a page shows). Nothing here logs a request, an answer, a token or a credential.
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const {one, find, call} = lib
const P = "mantle.account.payment.Payment",
    PM = "mantle.account.method.PaymentMethod",
    R = "mantle.account.method.PaymentGatewayResponse"
const FLAGS = [
    "resultSuccess",
    "resultDeclined",
    "resultError",
    "resultUnknown",
    "resultNsf",
    "resultBadExpire",
    "resultBadCardNumber"
]
const REFUSED_FLAGS = ["resultDeclined", "resultNsf", "resultBadExpire", "resultBadCardNumber"]

const clip = (text, length = 255) => (text == null ? null : String(text).slice(0, length))

// ---- Responses ----

// One PaymentGatewayResponse for this call, with every result flag set (N unless given). base: {gw, payment,
// operationEnumId, idempotencyKey, amount, refundPaymentId, paymentMethodId}.
function record(base, fields) {
    const values = {
        paymentGatewayConfigId: base.gw.id,
        paymentOperationEnumId: base.operationEnumId,
        paymentId: base.payment?.paymentId,
        paymentMethodId: base.paymentMethodId || base.payment?.paymentMethodId,
        amount: base.amount,
        amountUomId: base.payment?.amountUomId,
        transactionDate: ec.user.nowTimestamp,
        idempotencyKey: base.idempotencyKey,
        refundPaymentId: base.refundPaymentId
    }
    for (const flag of FLAGS) values[flag] = "N"
    Object.assign(values, fields)
    values.reasonMessage = clip(values.reasonMessage)
    return call("create#" + R, values).paymentGatewayResponseId
}
// Not sent: the gateway or the payment cannot be used for this operation (resultError, safe to send again once fixed).
function refuse(base, reasonCode, message) {
    ec.logger.warn(
        base.gw.label + " " + base.operationEnumId + " of payment " + base.payment?.paymentId + " not sent: " + reasonCode
    )
    return {paymentGatewayResponseId: record(base, {resultError: "Y", reasonCode, reasonMessage: message})}
}
const response = paymentGatewayResponseId => paymentGatewayResponseId && one(R, {paymentGatewayResponseId})

// The common start of a payment operation: the payment, the gateway and the base of its response; problem says why it
// cannot be sent.
function start(p, gw, operationEnumId, amount) {
    const payment = one(P, {paymentId: p.paymentId})
    const base = {
        gw,
        payment,
        operationEnumId,
        idempotencyKey: p.idempotencyKey,
        amount: amount ?? payment?.amount,
        refundPaymentId: p.refundPaymentId
    }
    const problem = !payment ? "Payment " + p.paymentId + " not found" : gw.problem
    return {payment, gw, base, problem}
}

// ---- Amounts and payments ----

// An amount in the provider's decimal form, rounded to its currency: null (refused) when it is not positive, finer than
// the currency or than the places the provider takes.
function providerAmount(value, currencyUomId, maxScale = 2) {
    if (value == null || !currencyUomId) return null
    const amount = toDecimal(value)
    const rounded = ec.l10n.roundCurrency(amount, currencyUomId)
    if (!rounded.eq(amount) || rounded.scale() > maxScale || rounded.compare(0) <= 0) return null
    return rounded
}
function describe(payment) {
    return clip("Payment " + payment.paymentId + (payment.orderId ? " order " + payment.orderId : ""), 255)
}
const isRefund = payment => payment.paymentTypeEnumId === "PtRefund" || !!payment.refundForPaymentId
// The original authorization's transaction id: the payment's reference, else its approved authorization response's.
function authorizedTransaction(payment) {
    if (payment.paymentRefNum) return payment.paymentRefNum
    const approved = Array.from(
        find(R, {paymentId: payment.paymentId, resultSuccess: "Y"})
            .condition("paymentOperationEnumId", "in", ["PgoAuthorize", "PgoAuthAndCapture"])
            .orderBy("-transactionDate")
            .limit(1)
            .list()
    )
    return approved.length ? approved[0].referenceNum : null
}
// Other refund payments of an original that still count (all but a cancelled, void or declined one, and this one).
function otherRefundCount(payment, refundPaymentId) {
    let others = find(P, {refundForPaymentId: payment.paymentId}).condition("statusId", "not-in", [
        "PmntCancelled",
        "PmntVoid",
        "PmntDeclined"
    ])
    if (refundPaymentId) others = others.condition("paymentId", "not-equals", refundPaymentId)
    return others.count()
}
// The transaction status of the payment's last PgoTxDetails response: a details lookup records a change only.
function lastDetailsStatus(paymentId) {
    const last = Array.from(
        find(R, {paymentId, paymentOperationEnumId: "PgoTxDetails"})
            .orderBy("-transactionDate")
            .orderBy("-paymentGatewayResponseId")
            .limit(1)
            .list()
    )[0]
    return last?.transactionStatus || null
}

// ---- Lost answers ----

// The latest unknown response of an idempotency key, the one a lookup resolves.
function lostResponse(idempotencyKey) {
    return Array.from(find(R, {idempotencyKey, resultUnknown: "Y"}).orderBy("-transactionDate").limit(1).list())[0] || null
}
// Whether a lost request is old enough that a provider with no transaction for it has none: younger, it may still be
// processing it, and the outcome stays unknown.
function pastGrace(lost, graceSeconds) {
    const age = lost ? Number(ec.user.nowTimestamp) - Number(lost.transactionDate) : Infinity
    return age >= Number(graceSeconds) * 1000
}

// ---- Payment methods ----

// The billing name and address of a payment method, as Mantle has them (the provider maps them to its fields).
function billingContact(method, partyId) {
    const person = partyId && one("mantle.party.Person", {partyId})
    const address =
        method?.postalContactMechId && one("mantle.party.contact.PostalAddress", {contactMechId: method.postalContactMechId})
    const state = address?.stateProvinceGeoId && one("moqui.basic.Geo", {geoId: address.stateProvinceGeoId})
    const country = address?.countryGeoId && one("moqui.basic.Geo", {geoId: address.countryGeoId})
    return {
        person: !!person,
        firstName: method?.firstNameOnAccount || person?.firstName || null,
        lastName: method?.lastNameOnAccount || person?.lastName || null,
        company: method?.companyNameOnAccount || null,
        address1: address?.address1 || null,
        address2: address?.address2 || null,
        city: address?.city || null,
        stateCode: state?.geoCodeAlpha2 || state?.geoCodeAlpha3 || address?.stateProvinceGeoId || null,
        postalCode: address?.postalCode || null,
        postalCodeExt: address?.postalCodeExt || null,
        countryGeoId: address?.countryGeoId || null,
        countryAlpha2: country?.geoCodeAlpha2 || null
    }
}
// The new credit card method of a stored profile: the provider references and the masked card only.
function createCardMethod(partyId, references, last4, creditCardTypeEnumId) {
    const paymentMethodId = call(
        "create#" + PM,
        Object.assign(
            {
                paymentMethodTypeEnumId: "PmtCreditCard",
                ownerPartyId: partyId,
                description: last4 ? "Card ending " + last4 : "Card",
                fromDate: ec.user.nowTimestamp
            },
            references
        )
    ).paymentMethodId
    call("create#mantle.account.method.CreditCard", {
        paymentMethodId,
        cardNumber: last4 ? "XXXX" + last4 : null,
        creditCardTypeEnumId: creditCardTypeEnumId || null
    })
    return paymentMethodId
}
const last4Of = masked =>
    String(masked || "")
        .replace(/\D/g, "")
        .slice(-4)

// ---- Browser tokenization ----

// The payer, or a user with treasury authority over the organization paid, may pay this payment in a browser; the
// payment chooses the organization, gateway, amount and currency. Only a promised or declined payment of a gateway that
// gatewayOf accepts, whose payment method (if any) is of the same gateway, so the token cannot go to another one.
function browserPayment(paymentId, lock, gatewayOf) {
    const payment = paymentId && find(P, {paymentId}).forUpdate(!!lock).one()
    if (!payment) throw new Error("PAYMENT_NOT_FOUND: The payment is not available")
    const partyId = ec.user.userAccount?.partyId
    const payer = !!partyId && partyId === payment.fromPartyId
    if (!payer) call("mantle.account.PaymentServices.check#PaymentGatewayAccess", {organizationPartyId: payment.toPartyId})
    const gw = gatewayOf(payment.paymentGatewayConfigId)
    if (gw.problem) throw new Error("GATEWAY_NOT_AVAILABLE: The payment is not taken by " + gw.label)
    const method = payment.paymentMethodId && one(PM, {paymentMethodId: payment.paymentMethodId})
    if (method?.paymentGatewayConfigId && method.paymentGatewayConfigId !== gw.id)
        throw new Error("METHOD_OTHER_GATEWAY: The payment's payment method belongs to another gateway")
    if (!["PmntPromised", "PmntDeclined"].includes(payment.statusId))
        throw new Error("PAYMENT_NOT_OPEN: The payment is not waiting for a card")
    return {payment, gw, payer}
}
// The state a page shows for an authorization's answer.
function stateOf(out) {
    const row = response(out.paymentGatewayResponseId)
    if (!row)
        return out.reasonCode === "GATEWAY_OUTCOME_UNKNOWN"
            ? "unknown"
            : out.reasonCode === "GATEWAY_OUTCOME_PENDING"
              ? "pending"
              : "error"
    if (row.resultSuccess === "Y") return "approved"
    if (row.resultUnknown === "Y") return "unknown"
    if (REFUSED_FLAGS.some(flag => row[flag] === "Y")) return "declined"
    return row.resultError === "Y" ? "error" : "pending"
}
// The browser's operation id, checked: 8 to 40 letters, digits, - or _.
function operationIdOf(value) {
    const operationId = value ? String(value) : null
    if (operationId && !/^[A-Za-z0-9_-]{8,40}$/.test(operationId))
        throw new Error("OPERATION_INVALID: Reload the page and try again")
    return operationId
}
// submit#BrowserPaymentToken of a gateway: authorize the payment with the browser's single-use token. With the payer's
// consent to keep the card (savePaymentMethod; only the payer's own), first make a reusable profile from it and authorize
// with the profile; a profile whose card is then declined is deleted again and its method expired. The payment is locked
// and checked again, and a replay, a pending or an unknown earlier authorization sends nothing and makes no profile. The
// state is the gateway response's; a page shows it but does not decide it.
//   s: {paymentId, gatewayOf, operationPrefix, operationId, paymentToken, savePaymentMethod, storeProfile(token, payment,
//       gw) -> {paymentMethodId}, deleteProfile(paymentMethodId)}
function submitBrowserToken(s) {
    const {payment, gw, payer} = browserPayment(s.paymentId, true, s.gatewayOf)
    const operationId = operationIdOf(s.operationId)
    const operationKey = operationId ? s.operationPrefix + "-" + payment.paymentId + "-" + operationId : null
    const authorize = token =>
        call("mantle.account.PaymentServices.authorize#SinglePayment", {
            paymentId: payment.paymentId,
            paymentGatewayConfigId: gw.id,
            operationKey,
            paymentToken: token
        })
    const answer = out => {
        const after = one(P, {paymentId: payment.paymentId})
        return {
            paymentId: payment.paymentId,
            state: stateOf(out),
            statusId: after.statusId,
            paymentMethodId: after.paymentMethodId || null
        }
    }
    const begun = call("mantle.account.PaymentServices.begin#PaymentGatewayOperation", {
        paymentId: payment.paymentId,
        operation: "authorize",
        operationKey,
        amount: payment.amount
    })
    // a replay answers the first response; a pending or unknown one sends nothing; neither makes a profile
    if (begun.replay || begun.blocked) return answer(authorize(null))
    const save = payer && (s.savePaymentMethod === true || s.savePaymentMethod === "true")
    if (!save) return answer(authorize(s.paymentToken))
    const stored = s.storeProfile(s.paymentToken, payment, gw)
    call("update#" + P, {paymentId: payment.paymentId, paymentMethodId: stored.paymentMethodId})
    const result = answer(authorize(null))
    if (["declined", "error"].includes(result.state) && stored.paymentMethodId !== payment.paymentMethodId) {
        // a card that was not accepted is not kept: its new profile goes, and the payment has its method of before
        s.deleteProfile(stored.paymentMethodId)
        call("update#" + PM, {paymentMethodId: stored.paymentMethodId, thruDate: ec.user.nowTimestamp})
        call("update#" + P, {paymentId: payment.paymentId, paymentMethodId: payment.paymentMethodId || null})
        result.paymentMethodId = payment.paymentMethodId || null
    }
    return result
}

// ---- The adapter's entry point ----

// Run one of an adapter's operations. The browser operations check the payer or treasury authority themselves; the rest
// are internal to the gateway, which its service definitions restrict.
function dispatch(label, operations, op, input) {
    if (!operations[op]) throw new Error("Unknown " + label + " operation " + op)
    const was = ec.artifactExecution.disableAuthz()
    try {
        return operations[op](input || {})
    } finally {
        if (!was) ec.artifactExecution.enableAuthz()
    }
}

;({
    clip,
    record,
    refuse,
    response,
    start,
    providerAmount,
    describe,
    isRefund,
    authorizedTransaction,
    otherRefundCount,
    lastDetailsStatus,
    lostResponse,
    pastGrace,
    billingContact,
    createCardMethod,
    last4Of,
    browserPayment,
    stateOf,
    operationIdOf,
    submitBrowserToken,
    dispatch
})
