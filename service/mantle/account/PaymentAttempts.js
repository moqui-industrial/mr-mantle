// Accounting's typed payment-attempt coordinator (design-accounting AC-02, review X9; mr-pass impl-shop P5, F13): the
// PortalPaymentAttempt rows by purpose. Billing's invoice attempts (PapInvoice, or empty for those made before) stay
// Portal.js's, with its own refresh and capture; the other purposes (Shop's checkout, later its renewal and Marketing's
// event registration) start, look up and settle their attempts here, and each worker selects its own purpose only, so
// Billing never refreshes or captures a Shop attempt and the reverse.
//
// - The attempt's key is the gateway's own: the caller passes its operationKey to authorize#SinglePayment, whose retry
//   answers the first response; a lost or pending answer is looked up (get#SinglePaymentGatewayDetails), never sent again
//   under a new key.
// - Each lookup runs in its own short transaction holding only the payment (as poll#PaymentGatewayDetails does), so no
//   caller's cart, order or checkout transaction is open while a provider is asked.
// - Lookups back off: the next check of an attempt is later each time it is still pending (bounded), so a job of many
//   attempts asks each provider a bounded number of times.
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const {find, one, call, ms} = lib
const ATT = "mantle.account.payment.PortalPaymentAttempt"
const P = "mantle.account.payment.Payment"
const R = "mantle.account.method.PaymentGatewayResponse"

// ===== tables =====
const purposes = {
    invoice: "PapInvoice",
    shopCheckout: "PapShopCheckout",
    shopRenewal: "PapShopRenewal",
    eventRegistration: "PapEventRegistration"
}
// Minutes until the next lookup of an attempt still pending after its nth lookup; the last repeats.
const backoffMinutes = [1, 2, 5, 10, 30, 60, 180, 360]
const approvedStatuses = ["PmntAuthorized", "PmntDelivered", "PmntConfirmed"]

// ===== the attempt =====
const purposeOf = row => row?.purposeEnumId || purposes.invoice
const ofPurpose = (row, purpose) => !!row && purposeOf(row) === purposes[purpose]
function attemptOf(paymentId) {
    return paymentId ? one(ATT, {paymentId}) : null
}
// A new attempt for a promised payment: its purpose, the record it pays (order, checkout or occurrence), store and site,
// the snapshot hash, and the digest of the reference the provider's return carries.
function create(p) {
    if (!purposes[p.purpose] || p.purpose === "invoice") throw new Error("Unknown payment attempt purpose " + p.purpose)
    call("create#" + ATT, {
        paymentId: p.paymentId,
        purposeEnumId: purposes[p.purpose],
        orderId: p.orderId || null,
        checkoutId: p.checkoutId || null,
        occurrenceId: p.occurrenceId || null,
        productStoreId: p.productStoreId || null,
        siteId: p.siteId || null,
        contactPartyId: p.contactPartyId || null,
        returnKeyDigest: p.returnKeyDigest || null,
        snapshotHash: p.snapshotHash || null,
        phase: "authorizing",
        checkCount: 0,
        createdDate: ec.user.nowTimestamp
    })
    return one(ATT, {paymentId: p.paymentId})
}
// The unsettled attempts of a purpose due for a lookup, oldest first.
function due(purpose, limit = 200) {
    return Array.from(
        find(ATT, {purposeEnumId: purposes[purpose]})
            .condition("settledDate", "is-null", null)
            .condition(
                ec.entity.conditionFactory.makeCondition(
                    ec.entity.conditionFactory.makeCondition("nextCheckDate", "is-null", null),
                    "or",
                    ec.entity.conditionFactory.makeCondition("nextCheckDate", "less-equals", ec.user.nowTimestamp)
                )
            )
            .orderBy("createdDate")
            .limit(Number(limit))
            .list()
    )
}
// An answer of the payment lost and not looked up yet: the provider may have charged it.
const unknownOpen = paymentId =>
    find(R)
        .condition("paymentId", paymentId)
        .condition("resultUnknown", "Y")
        .condition("outcomeResolvedDate", "is-null", null)
        .count() > 0
const latestAuthorization = paymentId =>
    Array.from(
        find(R, {paymentId})
            .condition("paymentOperationEnumId", "in", ["PgoAuthorize", "PgoAuthAndCapture"])
            .orderBy("-transactionDate")
            .orderBy("-paymentGatewayResponseId")
            .limit(1)
            .list()
    )[0] || null
// The attempt's state from its payment: approved, declined, cancelled, unknown (a lost answer not looked up yet) or
// pending (at the provider: a hosted page or a review).
function stateOf(payment) {
    if (!payment) return "cancelled"
    if (approvedStatuses.includes(payment.statusId)) return "approved"
    if (payment.statusId === "PmntDeclined") return "declined"
    if (["PmntCancelled", "PmntVoid"].includes(payment.statusId)) return "cancelled"
    if (unknownOpen(payment.paymentId)) return "unknown"
    const auth = latestAuthorization(payment.paymentId)
    if (auth && auth.resultError === "Y") return "failed"
    return "pending"
}
// Where the payer completes a pending hosted payment: a provider page to go to (redirectUrl) or a form the frontend posts
// through its relay (form: the gateway's page takes a fresh token each visit, Accept Hosted). Null when there is none.
function providerAction(paymentId) {
    const auth = latestAuthorization(paymentId)
    if (!auth) return null
    if (auth.transactionStatus === "HostedPending") return {form: true}
    return auth.redirectUrl && /^(https:\/\/|\/(?!\/))/.test(auth.redirectUrl) ? {redirectUrl: auth.redirectUrl} : null
}
// The gateway calls for one attempt's payment run with it named to the posting guard (PostingGuard.PORTAL_PAYMENT, as
// Billing's do): the customer's card payment to the organization, which no user of the organization makes, posts.
const PORTAL_PAYMENT = ec.resource.script("component://mr-mantle/service/mantle/ledger/PostingGuard.js").PORTAL_PAYMENT
function asAttempt(paymentId, work) {
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
// The gateway asked about a pending payment, in a transaction of its own (the provider is never asked while a caller's
// transaction is open); a failure is logged and the payment stays as it was. Answers the payment after.
function lookup(paymentId) {
    asAttempt(paymentId, () => {
        try {
            lib.probe("mantle.account.PaymentServices.get#SinglePaymentGatewayDetails", {paymentId})
        } catch (error) {
            ec.logger.warn("Payment attempt " + paymentId + " lookup failed: " + String(error.message).split("\n")[0])
        }
    })
    return one(P, {paymentId})
}
// A lookup counted, and the next one set later (bounded backoff).
function checked(paymentId) {
    const row = attemptOf(paymentId)
    if (!row) return
    const count = Number(row.checkCount || 0) + 1
    const minutes = backoffMinutes[Math.min(count - 1, backoffMinutes.length - 1)]
    call("update#" + ATT, {
        paymentId,
        checkCount: count,
        lastCheckDate: ec.user.nowTimestamp,
        nextCheckDate: new Date(ms(ec.user.nowTimestamp) + minutes * 60000)
    })
}
// The attempt's phase and safe outcome; a resolved attempt (anything but pending) is settled.
function record(paymentId, phase, outcome) {
    const row = attemptOf(paymentId)
    if (!row) return
    const values = {paymentId, phase}
    if (outcome !== undefined) values.outcome = outcome
    if (outcome && outcome !== "unknown" && !row.settledDate) values.settledDate = ec.user.nowTimestamp
    call("update#" + ATT, values)
}

;({
    purposes,
    purposeOf,
    ofPurpose,
    attemptOf,
    create,
    due,
    stateOf,
    providerAction,
    latestAuthorization,
    asAttempt,
    lookup,
    checked,
    record
})
