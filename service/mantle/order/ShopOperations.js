/* CC0 1.0 Universal plus Grant of Patent License. See LICENSE.md.
 * Shop's operations (mr-pass impl-shop P8; design-shop §7.1 retention, §8.4 reconciliation, §17.1 rollback): the work the
 * run_ShopOperations job does beside the checkout, fulfillment and delivery jobs, and the staff resolution of a stuck
 * placement (impl-commerce F108).
 *
 * - Expired carts (impl-shop F74): an open cart whose access expired is cancelled through the order path
 *   (cancel#Order, as a merged guest cart is) once nothing of its money is unresolved: no checkout waiting for a payment
 *   or a placement, no unsettled payment attempt, no payment that took money. Its access is retired (ScrExpired) and an
 *   unsubmitted checkout expired. The guest party of a cart that never became an order is retired (disabled, never
 *   deleted) once it has nothing else: no account, no order but cancelled ones, no completed checkout. Placed and paid
 *   records are never touched. Each cart in its own transaction; one that fails is named and the rest go on.
 * - Second approvals (impl-shop F95): each Shop checkout completed in the last days with a hosted payment is searched once,
 *   after its last form token can no longer be used, for another approval under its reference (the gateway's
 *   duplicateCheckService); one found holds the placed order (OhtPayment) as the lookup's flag does at placement.
 * - Stuck placements (impl-commerce F108, impl-shop F85): a placementPending checkout whose order was not placed (refused
 *   ORDER_CHANGED or past its tries) is resolved by a store's staff member with COMMERCE_PLACEMENT_RESOLVE: retried (the
 *   tries reset and the placement run again), or its payment released or refunded through Mantle's payment services
 *   (release#SinglePayment, refund#SinglePayment, with an operation key of the resolution) and the cart cancelled through
 *   the order path. Each resolution is keyed by its operation (PostingOperation ShopPlacementResolve: a retry answers the
 *   first result) and names who resolved it and why on the checkout.
 * Reads and writes below the checks are the authority's own (authorization disabled).
 */
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const checkouts = () => ec.resource.script("component://mr-mantle/service/mantle/order/ShopCheckout.js")
const operations = () => ec.resource.script("component://mr-mantle/service/mantle/order/StoreOperations.js")
const settings = () => ec.resource.script("component://mr-mantle/service/mantle/product/StoreCheckout.js")
const {find, one, rows, call, ms, denied, access} = lib

const A = "mantle.order.StoreCartAccess"
const C = "mantle.order.StoreCheckout"
const P = "mantle.account.payment.Payment"
const R = "mantle.account.method.PaymentGatewayResponse"
const ATTEMPT = "mantle.account.payment.PortalPaymentAttempt"
const SERVICES = "mantle.order.ShopOperationsServices."
// Review (R1): a stuck placement whose payment a resolution is giving back, and the key prefix of that release or refund
const REFUND_PENDING = "REFUND_PENDING"
const RESOLVE_KEY = "shop-resolve-"

// ===== tables =====
// Bounds: carts and checkouts a run takes, days a completed checkout is swept for a second approval, days a retired cart's
// guest party is looked at.
const limits = {batch: 200, sweepDays: 3, sweepCandidates: 2000, guestDays: 30}
const unresolvedCheckouts = ["ScoPaymentPending", "ScoPlacementPending"]
const editableCheckouts = ["ScoEditing", "ScoReady", "ScoReviewRequired"]
const moneyStatuses = ["PmntAuthorized", "PmntDelivered", "PmntConfirmed"]
const placedStatuses = ["OrderPlaced", "OrderProcessing", "OrderApproved", "OrderSent", "OrderCompleted", "OrderHold"]

// ===== values =====
const text = value => (value == null ? "" : String(value).trim())
const nowMs = () => ms(ec.user.nowTimestamp)
const firstLine = message =>
    String(message || "")
        .split("\n")[0]
        .replace(/^(?:Error: )+/, "")
// A step in a transaction of its own: {result} or {error}.
function step(name, input) {
    ec.message.pushErrors()
    try {
        const out =
            ec.service
                .sync()
                .name(SERVICES + "run#Step")
                .parameters({input: Object.assign({step: name}, input)})
                .disableAuthz()
                .requireNewTransaction(true)
                .call() || {}
        if (ec.message.hasError()) return {error: ec.message.getErrorsString()}
        return {result: out.result || {}}
    } catch (error) {
        return {error: String(error.message || error)}
    } finally {
        ec.message.clearErrors()
        ec.message.popErrors()
    }
}

// ===== expired carts (F74) =====
// Why a cart's money is not resolved yet (null when it is): a checkout waiting, an attempt unsettled, a payment that took
// money.
function unresolved(access) {
    if (find(C, {cartAccessId: access.cartAccessId}).condition("statusId", "in", unresolvedCheckouts).count() > 0)
        return "a checkout is waiting for its payment or placement"
    if (find(ATTEMPT, {orderId: access.orderId}).condition("settledDate", "is-null", null).count() > 0)
        return "a payment attempt is not settled"
    if (find(P, {orderId: access.orderId}).condition("statusId", "in", moneyStatuses).count() > 0) return "a payment took money"
    return null
}
// retire: one expired cart, under its access's lock.
function retireStep(p) {
    const access = find(A, {cartAccessId: p.cartAccessId}).forUpdate(true).one()
    if (!access || access.revokedDate || (ms(access.expireDate) ?? Infinity) > nowMs()) return {retired: false}
    // Review (R4): the cart's checkouts, then its order, locked in the order a checkout's freeze takes them, so a submit that
    // raced the expiry is seen committed (and waited for) before the money is judged
    find(C, {cartAccessId: access.cartAccessId}).orderBy("checkoutId").forUpdate(true).list()
    const order = find("mantle.order.OrderHeader", {orderId: access.orderId}).forUpdate(true).one()
    if (order && order.statusId === "OrderOpen") {
        const why = unresolved(access)
        if (why) return {retired: false, waiting: why}
        for (const checkout of rows(C, {cartAccessId: access.cartAccessId}))
            if (editableCheckouts.includes(checkout.statusId))
                call("update#" + C, {checkoutId: checkout.checkoutId, statusId: "ScoExpired"})
        // the order path, as a merged guest cart's (ShopCart.js): never a delete
        call("mantle.order.OrderServices.cancel#Order", {orderId: order.orderId})
    }
    call("update#" + A, {cartAccessId: access.cartAccessId, revokedDate: ec.user.nowTimestamp, revokeReasonEnumId: "ScrExpired"})
    return {retired: true, guestRetired: retireGuest(access.guestPartyId)}
}
// What makes a party more than a cart's anonymous guest (review R2: merge#Parties moves StoreCartAccess.guestPartyId to the
// party merged into, so a cart's guestPartyId may name a customer staff keep): an account, a relationship, a cart of its
// own as a customer, a case, a consent, an agreement, a download grant, a recurring contract, a subscription, a financial
// account, an invoice.
const guestHolds = [
    ["moqui.security.UserAccount", "partyId"],
    ["mantle.party.PartyRelationship", "fromPartyId"],
    ["mantle.party.PartyRelationship", "toPartyId"],
    [A, "customerPartyId"],
    ["mantle.request.RequestParty", "partyId"],
    ["mantle.request.Request", "filedByPartyId"],
    ["mantle.party.PartyConsent", "partyId"],
    ["mantle.party.agreement.AgreementParty", "partyId"],
    ["mantle.product.store.StoreDownloadGrant", "recipientPartyId"],
    ["mantle.product.subscription.StoreRecurringContract", "customerPartyId"],
    ["mantle.product.subscription.Subscription", "subscriberPartyId"],
    ["mantle.account.financial.FinancialAccount", "ownerPartyId"],
    ["mantle.account.invoice.Invoice", "toPartyId"],
    ["mantle.account.invoice.Invoice", "fromPartyId"]
]
// A cart's guest party retired (disabled, never deleted) once it is only that: the guest of carts that are all retired, no
// role but Customer, nothing of guestHolds, no completed checkout, no order but cancelled ones, not merged into another.
function retireGuest(partyId) {
    if (!partyId) return false
    const party = one("mantle.party.Party", {partyId})
    if (!party || party.disabled === "Y" || party.mergedToPartyId) return false
    for (const [entity, field] of guestHolds) if (find(entity, {[field]: partyId}).count() > 0) return false
    if (rows("mantle.party.PartyRole", {partyId}).some(row => row.roleTypeId !== "Customer")) return false
    if (find(A, {guestPartyId: partyId}).condition("revokedDate", "is-null", null).count() > 0) return false
    if (find(C, {customerPartyId: partyId, statusId: "ScoCompleted"}).count() > 0) return false
    const orderIds = Array.from(
        find("mantle.order.OrderPart", {customerPartyId: partyId}).selectField("orderId").distinct(true).limit(50).list()
    ).map(row => row.orderId)
    if (orderIds.length >= 50) return false
    for (const orderId of orderIds) if (one("mantle.order.OrderHeader", {orderId})?.statusId !== "OrderCancelled") return false
    call("update#mantle.party.Party", {partyId, disabled: "Y"})
    return true
}
function guestStep(p) {
    return {guestRetired: retireGuest(p.partyId)}
}
// retire#ExpiredCarts: the expired open carts (oldest first) and the guest parties of carts retired lately (a merged guest
// cart's too). {retired, waiting, guests, failed}.
function retireExpiredCarts(p) {
    const limit = Number(p.limit || limits.batch)
    const due = Array.from(
        find(A)
            .condition("revokedDate", "is-null", null)
            .condition("expireDate", "less", ec.user.nowTimestamp)
            .orderBy("expireDate")
            .limit(limit)
            .list()
    )
    let retired = 0,
        waiting = 0,
        guests = 0,
        failed = 0
    for (const row of due) {
        const out = step("retire", {cartAccessId: row.cartAccessId})
        if (out.error) {
            failed++
            ec.logger.error(
                "Shop cart " + row.cartAccessId + " (order " + row.orderId + ") was not retired: " + firstLine(out.error)
            )
        } else if (out.result.retired) {
            retired++
            if (out.result.guestRetired) guests++
        } else if (out.result.waiting) waiting++
    }
    // the guest parties of carts retired or merged lately whose party is still enabled
    const lately = Array.from(
        find(A)
            .condition("revokeReasonEnumId", "in", ["ScrExpired", "ScrMerged", "ScrCancelled"])
            .condition("revokedDate", "greater-equals", new Date(nowMs() - limits.guestDays * 86400000))
            .condition("guestPartyId", "is-not-null", null)
            .selectField("guestPartyId")
            .distinct(true)
            .limit(limit)
            .list()
    )
    for (const row of lately) {
        const party = one("mantle.party.Party", {partyId: row.guestPartyId})
        if (!party || party.disabled === "Y") continue
        const out = step("guest", {partyId: row.guestPartyId})
        if (out.error) {
            failed++
            ec.logger.error("Shop guest party " + row.guestPartyId + " was not retired: " + firstLine(out.error))
        } else if (out.result.guestRetired) guests++
    }
    return {retired, waiting, guests, failed}
}

// ===== second approvals (F95) =====
function duplicateService(paymentGatewayConfigId) {
    const config = paymentGatewayConfigId ? one("mantle.account.method.PaymentGatewayConfig", {paymentGatewayConfigId}) : null
    const of = config ? settings().gatewayCapabilities[config.paymentGatewayTypeEnumId] : null
    return of ? of(config).duplicateCheckService || null : null
}
const paymentHeld = orderId =>
    rows("mantle.order.OrderHoldReason", {orderId, holdTypeEnumId: "OhtPayment"}).some(row => !row.releasedDate)
// whether the order was ever held for this payment (open or released)
const everHeld = (orderId, paymentId) =>
    find("mantle.order.OrderHoldReason", {orderId, holdTypeEnumId: "OhtPayment", sourceId: paymentId}).count() > 0
function holdStep(p) {
    const order = one("mantle.order.OrderHeader", {orderId: p.orderId})
    if (!order || !placedStatuses.includes(order.statusId) || paymentHeld(order.orderId)) return {held: false}
    checkouts().holdPayment(order.orderId, p.paymentId, "The provider approved more than one payment for this checkout")
    call("update#" + ATTEMPT, {paymentId: p.paymentId, outcome: "exception"})
    return {held: true}
}
// sweep#HostedReferences: the Shop checkouts completed in the last days whose payment's gateway can search its reference
// again and has not been searched; a second approval found holds the placed order. {checked, flagged, failed}.
function sweepHostedReferences(p) {
    const since = new Date(nowMs() - limits.sweepDays * 86400000)
    const due = Array.from(
        find(C, {statusId: "ScoCompleted"})
            .condition("completedDate", "greater-equals", since)
            .condition("paymentId", "is-not-null", null)
            .orderBy("-completedDate")
            .limit(limits.sweepCandidates)
            .list()
    )
    let checked = 0,
        flagged = 0,
        failed = 0,
        searches = 0
    for (const checkout of due) {
        if (searches >= Number(p.limit || limits.batch)) break
        const payment = one(P, {paymentId: checkout.paymentId})
        const service = payment ? duplicateService(payment.paymentGatewayConfigId) : null
        if (!service) continue
        // searched already: nothing found, or a second approval whose order is held
        const marks = Array.from(
            find(R, {paymentId: payment.paymentId})
                .condition("reasonCode", "in", ["DUPLICATES_CHECKED", "DUPLICATE_APPROVAL"])
                .list()
        )
        if (marks.some(row => row.reasonCode === "DUPLICATES_CHECKED")) continue
        // Review (R3): a second approval already flagged is held once; a hold Accounting released (PAYMENT_HOLD_RELEASE) is
        // their decision and is never put back, so it is not searched again
        const flaggedBefore = marks.length > 0
        if (flaggedBefore && everHeld(checkout.orderId, payment.paymentId)) continue
        if (!flaggedBefore) searches++
        try {
            const out = flaggedBefore ? {flagged: true} : lib.probe(service, {paymentId: payment.paymentId})
            if (out.checked) checked++
            if (out.flagged && !paymentHeld(checkout.orderId)) {
                const held = step("hold", {orderId: checkout.orderId, paymentId: payment.paymentId})
                if (held.error) throw new Error(held.error)
                if (held.result.held) flagged++
            }
        } catch (error) {
            ec.message.clearErrors()
            failed++
            ec.logger.error("Shop checkout " + checkout.checkoutId + " reference not searched: " + firstLine(error.message))
        }
    }
    return {checked, flagged, failed}
}

// run#ShopOperations (run_ShopOperations): each part on its own, a part that fails named and the next one run.
function runShopOperations(p) {
    const out = {}
    for (const [name, part] of [
        ["carts", retireExpiredCarts],
        ["references", sweepHostedReferences]
    ]) {
        try {
            out[name] = part(p)
        } catch (error) {
            ec.message.clearErrors()
            ec.logger.error("Shop operations " + name + " failed: " + firstLine(error.message))
            out[name] = {error: firstLine(error.message)}
        }
    }
    return out
}

// ===== stuck placements (impl-commerce F108) =====
const reasonOf = p => {
    const reason = text(p.reason)
    if (reason.length < 3 || reason.length > 255) denied("REASON_REQUIRED", "Say why, in 3 to 255 characters")
    return reason
}
// The cart's checkout waiting for placement with its payment kept (StoreOperations' stuck: refused or past its tries).
function stuckCheckout(orderId) {
    return Array.from(find(C, {orderId, statusId: "ScoPlacementPending"}).orderBy("-createdDate").limit(1).list())[0] || null
}
function retryStep(p) {
    const checkout = find(C, {checkoutId: p.checkoutId}).forUpdate(true).one()
    if (!checkout || checkout.statusId !== "ScoPlacementPending") return {}
    // a refund of this placement in progress (or interrupted) is never raced by a placement
    if (checkout.failureCode === REFUND_PENDING) return {refundPending: true}
    call("update#" + C, {checkoutId: checkout.checkoutId, placementTries: 0})
    return {}
}
// Review (R1): before its payment is released or refunded, the checkout is marked REFUND_PENDING under its lock, which the
// placement step (ShopCheckout.js placeStep) and a retry honour, so a placement never lands while the provider is asked; the
// failure it had is kept to put back when the provider refuses. {blocked, prior?, statusId}.
function blockStep(p) {
    const checkout = find(C, {checkoutId: p.checkoutId}).forUpdate(true).one()
    if (!checkout || checkout.statusId !== "ScoPlacementPending") return {blocked: false, statusId: checkout?.statusId}
    if (checkout.failureCode === REFUND_PENDING) return {blocked: true}
    call("update#" + C, {checkoutId: checkout.checkoutId, failureCode: REFUND_PENDING})
    return {blocked: true, prior: {failureCode: checkout.failureCode || null}}
}
// The failure put back after the provider refused the release or refund (nothing else changed).
function unblockStep(p) {
    const checkout = find(C, {checkoutId: p.checkoutId}).forUpdate(true).one()
    if (!checkout || checkout.statusId !== "ScoPlacementPending" || checkout.failureCode !== REFUND_PENDING) return {}
    call("update#" + C, {checkoutId: checkout.checkoutId, failureCode: p.failureCode || null})
    return {}
}
// A release or refund of the payment an earlier resolution sent and the provider confirmed (its key is a resolution's), so
// an interrupted resolution is finished without asking the provider again.
function confirmedRefund(paymentId) {
    return (
        Array.from(
            find(R, {paymentId, resultSuccess: "Y"})
                .condition("paymentOperationEnumId", "in", ["PgoRelease", "PgoRefund"])
                .condition("operationKey", "like", RESOLVE_KEY + "%")
                .orderBy("-paymentGatewayResponseId")
                .limit(1)
                .list()
        )[0] || null
    )
}
// cancelled: the checkout cancelled with who resolved it and why, its cart's access retired and the open order cancelled
// through the order path, after its payment was released or refunded.
function cancelledStep(p) {
    const checkout = find(C, {checkoutId: p.checkoutId}).forUpdate(true).one()
    if (checkout?.statusId === "ScoCancelled") return {}
    // never both: a payment given back for a placement that landed anyway is named for Accounting, not reported resolved
    if (!checkout || checkout.statusId !== "ScoPlacementPending")
        throw new Error(
            "PLACED_AND_REFUNDED: Checkout " + p.checkoutId + " is " + checkout?.statusId + " after its payment was given back"
        )
    call("update#" + C, {
        checkoutId: checkout.checkoutId,
        statusId: "ScoCancelled",
        failureCode: "RESOLVED_REFUNDED",
        failureMessage: text(p.note).slice(0, 255)
    })
    const accessRow = one(A, {cartAccessId: checkout.cartAccessId})
    if (accessRow && !accessRow.revokedDate)
        call("update#" + A, {
            cartAccessId: accessRow.cartAccessId,
            revokedDate: ec.user.nowTimestamp,
            revokeReasonEnumId: "ScrCancelled"
        })
    const order = one("mantle.order.OrderHeader", {orderId: checkout.orderId})
    if (order && order.statusId === "OrderOpen") call("mantle.order.OrderServices.cancel#Order", {orderId: order.orderId})
    return {}
}
// resolve#StuckPlacement: action retry (the placement run again with its tries reset) or refund (the kept payment released
// when only authorized, else refunded, then the cart cancelled). COMMERCE_ORDER_VIEW, COMMERCE_PLACEMENT_RESOLVE and the
// store's scope; an operation key and a reason. {resolved, stateText, alreadyApplied?}.
function resolveStuckPlacement(p) {
    const s = operations().scope()
    if (!access.has("COMMERCE_PLACEMENT_RESOLVE")) denied("PERMISSION_DENIED", "COMMERCE_PLACEMENT_RESOLVE is required")
    const action = text(p.action)
    if (!["retry", "refund"].includes(action)) denied("ACTION_INVALID", "Choose retry or refund")
    // a retry of a resolution answers its first result, also once the cart it resolved is placed or cancelled
    const named = p.orderId ? one("mantle.order.OrderHeader", {orderId: p.orderId}) : null
    if (named && s.storeIds.includes(named.productStoreId) && s.owned(named.orderId)) {
        const store = one("mantle.product.store.ProductStore", {productStoreId: named.productStoreId})
        const first = lib.previous(
            lib.operation(p, "ShopPlacementResolve", store?.organizationPartyId || null, {orderId: named.orderId, action})
        )
        if (first) return first
    }
    const order = operations().storeOrder(s, p.orderId, true)
    const store = one("mantle.product.store.ProductStore", {productStoreId: order.productStoreId})
    const op = lib.operation(p, "ShopPlacementResolve", store?.organizationPartyId || null, {orderId: order.orderId, action})
    const reason = reasonOf(p)
    const checkout = stuckCheckout(order.orderId)
    if (!checkout || !checkout.paymentId) denied("NOT_STUCK", "No placement of cart " + order.orderId + " is waiting")
    const who = ec.user.username || ec.user.userId
    let result
    if (action === "retry") {
        const reset = step("retry", {checkoutId: checkout.checkoutId})
        if (reset.error) throw new Error(firstLine(reset.error))
        if (reset.result.refundPending)
            denied(
                "REFUND_PENDING",
                "A refund of cart " + order.orderId + " was started; finish it with Refund (the provider is not asked twice)"
            )
        const out = checkouts().refreshAttempt(checkout.siteId, checkout.checkoutId)
        const after = one(C, {checkoutId: checkout.checkoutId})
        result =
            out.statusId === "ScoCompleted"
                ? {resolved: true, stateText: "Placed as order " + checkout.orderId}
                : {resolved: false, stateText: "Still not placed: " + text(after?.failureMessage || after?.failureCode)}
    } else {
        // no placement from here until the provider answers (R1)
        const block = step("block", {checkoutId: checkout.checkoutId})
        if (block.error) throw new Error(firstLine(block.error))
        if (!block.result.blocked) denied("NOT_STUCK", "No placement of cart " + order.orderId + " is waiting")
        const unblock = () =>
            block.result.prior ? step("unblock", Object.assign({checkoutId: checkout.checkoutId}, block.result.prior)) : null
        const payment = one(P, {paymentId: checkout.paymentId})
        let response = confirmedRefund(checkout.paymentId)
        let released = response ? response.paymentOperationEnumId === "PgoRelease" : payment?.statusId === "PmntAuthorized"
        if (!response) {
            if (!payment || !moneyStatuses.includes(payment.statusId)) {
                unblock()
                denied(
                    "PAYMENT_NOT_SETTLED",
                    "The payment of cart " + order.orderId + " is not approved; it cannot be refunded here"
                )
            }
            const operationKey = RESOLVE_KEY + text(op.operationKey).slice(0, 26)
            // an exception (an outcome not known) leaves the placement blocked for staff
            const sent = released
                ? lib.probe("mantle.account.PaymentServices.release#SinglePayment", {paymentId: payment.paymentId, operationKey})
                : lib.probe("mantle.account.PaymentServices.refund#SinglePayment", {
                      paymentId: payment.paymentId,
                      operationKey,
                      amount: payment.amount
                  })
            response = sent.paymentGatewayResponseId ? one(R, {paymentGatewayResponseId: sent.paymentGatewayResponseId}) : null
            if (!response || response.resultSuccess !== "Y") {
                // a clear refusal, or nothing sent, puts the placement back; an outcome not known keeps it blocked
                const unknown =
                    response?.resultUnknown === "Y" ||
                    ["GATEWAY_OUTCOME_UNKNOWN", "GATEWAY_OUTCOME_PENDING"].includes(sent.reasonCode)
                if (!unknown) unblock()
                denied(
                    "REFUND_NOT_DONE",
                    "The provider did not " +
                        (released ? "release" : "refund") +
                        " the payment: " +
                        text(response?.reasonMessage || sent.reasonCode || "no answer") +
                        (unknown
                            ? ". Its outcome is not known; look it up in Accounting"
                            : ". Nothing else changed; try again or ask Accounting")
                )
            }
        }
        const note = (released ? "Released" : "Refunded") + " by " + who + ": " + reason
        const cancelled = step("cancelled", {checkoutId: checkout.checkoutId, note})
        if (cancelled.error) {
            ec.logger.error(
                "Shop placement of cart " + order.orderId + " given back but not cancelled: " + firstLine(cancelled.error)
            )
            throw new Error(firstLine(cancelled.error))
        }
        result = {resolved: true, stateText: note}
    }
    if (action === "retry") ec.logger.info("Shop placement of cart " + order.orderId + " retried by " + who + ": " + reason)
    lib.complete(op, C, checkout.checkoutId, result)
    return result
}

const steps = {
    retire: retireStep,
    guest: guestStep,
    hold: holdStep,
    retry: retryStep,
    block: blockStep,
    unblock: unblockStep,
    cancelled: cancelledStep
}
const ops = {
    retireExpiredCarts,
    sweepHostedReferences,
    runShopOperations,
    resolveStuckPlacement,
    runStep: p => {
        if (!steps[p.step]) throw new Error("Unknown Shop operations step " + p.step)
        return steps[p.step](p) || {}
    }
}
;({
    limits,
    execute: (op, parameters) => {
        if (!ops[op]) throw new Error("Unknown Shop operation " + op)
        return ops[op](parameters || {})
    }
})
