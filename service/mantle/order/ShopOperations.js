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
    const order = one("mantle.order.OrderHeader", {orderId: access.orderId})
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
// A cart's guest party retired (disabled, never deleted) once nothing else is its: no account, no order but cancelled
// ones, no completed checkout, not merged into another party.
function retireGuest(partyId) {
    if (!partyId) return false
    const party = one("mantle.party.Party", {partyId})
    if (!party || party.disabled === "Y" || party.mergedToPartyId) return false
    if (find("moqui.security.UserAccount", {partyId}).count() > 0) return false
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
        if (marks.length && paymentHeld(checkout.orderId)) continue
        searches++
        try {
            const out = lib.probe(service, {paymentId: payment.paymentId})
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
    call("update#" + C, {checkoutId: checkout.checkoutId, placementTries: 0})
    return {}
}
// cancelled: the checkout cancelled with who resolved it and why, its cart's access retired and the open order cancelled
// through the order path, after its payment was released or refunded.
function cancelledStep(p) {
    const checkout = find(C, {checkoutId: p.checkoutId}).forUpdate(true).one()
    if (!checkout || checkout.statusId !== "ScoPlacementPending") return {}
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
        const out = checkouts().refreshAttempt(checkout.siteId, checkout.checkoutId)
        const after = one(C, {checkoutId: checkout.checkoutId})
        result =
            out.statusId === "ScoCompleted"
                ? {resolved: true, stateText: "Placed as order " + checkout.orderId}
                : {resolved: false, stateText: "Still not placed: " + text(after?.failureMessage || after?.failureCode)}
    } else {
        const payment = one(P, {paymentId: checkout.paymentId})
        if (!payment || !moneyStatuses.includes(payment.statusId))
            denied("PAYMENT_NOT_SETTLED", "The payment of cart " + order.orderId + " is not approved; it cannot be refunded here")
        const operationKey = "shop-resolve-" + text(op.operationKey).slice(0, 26)
        const released = payment.statusId === "PmntAuthorized"
        const sent = released
            ? lib.probe("mantle.account.PaymentServices.release#SinglePayment", {paymentId: payment.paymentId, operationKey})
            : lib.probe("mantle.account.PaymentServices.refund#SinglePayment", {
                  paymentId: payment.paymentId,
                  operationKey,
                  amount: payment.amount
              })
        const response = sent.paymentGatewayResponseId ? one(R, {paymentGatewayResponseId: sent.paymentGatewayResponseId}) : null
        if (!response || response.resultSuccess !== "Y")
            denied(
                "REFUND_NOT_DONE",
                "The provider did not " +
                    (released ? "release" : "refund") +
                    " the payment: " +
                    text(response?.reasonMessage || sent.reasonCode || "no answer") +
                    ". Nothing else changed; try again or ask Accounting"
            )
        const note = (released ? "Released" : "Refunded") + " by " + who + ": " + reason
        const cancelled = step("cancelled", {checkoutId: checkout.checkoutId, note})
        if (cancelled.error) throw new Error(firstLine(cancelled.error))
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
