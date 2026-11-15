// Event registrations: the ticket order, its payment and refunds (mantle.work.EventRegistrationServices, E of IronStone Marketing design
// §14.2; design §9 RegistrationSetup's order rules, §13 Register's RegistrationPayment; impl-marketing P17, F28-F30; X1, X9). CC0 1.0
// Universal plus Grant of Patent License.
//
// - The ticket order is a native sales order of the offer's organization to the buyer (purpose OrpEventRegistration): storeless by
//   default, taxed by X1 through the organization's own gateway (calculate#OrderSalesTax, at the event's place or else the
//   organization's own address), or a store order of the store the offer names (its tax and promotions). One line per paid place,
//   the ticket product at its own price (get#ProductPrice, never an amount of Marketing's).
// - start#RegistrationPayment: for a completed reservation whose places are held, the order made once and a promised card payment
//   of its total with Accounting's typed attempt (PaymentAttempts.js, purpose eventRegistration), committed before the provider is
//   asked; then authorize#SinglePayment with the attempt's operation key and the canonical return address, in a transaction
//   holding only the payment. A second start answers the same attempt (no second order, payment or seat); a declined or cancelled
//   one is replaced by a new payment of the same order while the hold lasts.
// - The verified result, never the browser's return: the attempt's state is looked up (bounded) and applied under the offer's lock.
//   Approved while every place of it is still held: its places pending (held with no end), then place#Order once in a transaction
//   of its own, whose placement SECA runs autoApprove#Order: with the seller's Sales approval setting off and no pre-approval
//   warning the order is approved at once, and the order's approval confirms the places (EventRegistrationPlaces.js
//   handleOrderStatus); otherwise the order waits in Sales' Awaiting approval with its places pending. Approved after a place's
//   hold ended: no seat is taken and the places are left for review (paid, unallocated), the order never placed. Declined or
//   cancelled: the payment cancelled, the places still held until their hold ends.
// - A refund is Accounting's: a cancelled paid place's refund is handed to the payment services after the commit (release of an
//   authorization once none of its places is left, else refund#SinglePayment of the place's line and its tax once captured), each
//   with an operation key of the registration, and shown pending until the provider's result; a failed one is Accounting's to
//   finish (ErfFailed), never retried blind.
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const places = () => ec.resource.script("component://mr-mantle/service/mantle/work/EventRegistrationPlaces.js")
const setup = () => ec.resource.script("component://mr-mantle/service/mantle/work/EventRegistrations.js")
const attempts = () => ec.resource.script("component://mr-mantle/service/mantle/account/PaymentAttempts.js")
const apps = () => ec.resource.script("component://mr-mantle/service/mantle/public/PublicApps.js")
const {find, one, rows, call, denied, ms} = lib

const POLICY = "mantle.work.registration.EventRegistrationPolicy"
const TICKET = "mantle.work.registration.EventTicketType"
const REGISTRATION = "mantle.work.registration.EventRegistration"
const RESERVATION = "mantle.work.registration.EventReservation"
const WORK_EFFORT = "mantle.work.effort.WorkEffort"
const P = "mantle.account.payment.Payment"
const R = "mantle.account.method.PaymentGatewayResponse"
const approvedStatuses = ["PmntAuthorized", "PmntDelivered", "PmntConfirmed"]
const placedStatuses = ["OrderPlaced", "OrderProcessing", "OrderApproved", "OrderSent", "OrderCompleted", "OrderHold"]
const addressPurposes = ["PostalShippingOrigin", "PostalPrimary", "PostalBilling", "PostalAddress"]
const limits = {lookupEveryMs: 2000, placementTries: 5, batch: 200}

const blank = value => value == null || String(value).trim() === ""
const text = value => (blank(value) ? null : String(value).trim())
const nowMs = () => Number(ms(ec.user.nowTimestamp))
const L = words => ec.l10n.localize(words)
const dec = value => toDecimal(value == null || value === "" ? 0 : value)
const moneyText = (amount, currencyUomId) => ec.l10n.formatCurrency(dec(amount), currencyUomId)

// A unit of work in a transaction of its own, so no provider is asked while the offer or order is locked: {result} or {error}.
function step(label, work) {
    ec.message.pushErrors()
    try {
        let result = null
        ec.transaction.runRequireNew(null, label, () => {
            result = work()
            if (ec.message.hasError()) throw new Error(ec.message.getErrorsString())
        })
        return {result: result || {}}
    } catch (error) {
        return {
            error: String(error?.message || error)
                .split("\n")[0]
                .replace(/^(?:Error: )+/, ""),
            reason: lib.reasonCode(error)
        }
    } finally {
        ec.message.clearErrors()
        ec.message.popErrors()
    }
}

// ===== what a place has paid =====
const paymentOf = row => (row?.paymentId ? one(P, {paymentId: row.paymentId}) : null)
// Whether a place's payment was received (authorized or taken).
const paidFor = row => approvedStatuses.includes(paymentOf(row)?.statusId)
// A place's share of its order: its line and that line's tax, or zero for a free place.
function shareOf(row) {
    if (!row.orderId || !row.orderItemSeqId) return dec(0)
    const lines = rows("mantle.order.OrderItem", {orderId: row.orderId})
    return lines
        .filter(line => line.orderItemSeqId === row.orderItemSeqId || line.parentItemSeqId === row.orderItemSeqId)
        .reduce((sum, line) => sum.add(dec(line.quantity ?? 1).multiply(dec(line.unitAmount))), dec(0))
}
function paymentText(row) {
    const payment = paymentOf(row)
    if (!payment)
        return row.orderItemSeqId || places().paidOf(row, one(POLICY, {registrationPolicyId: row.registrationPolicyId}))
            ? L("Not paid")
            : L("Free")
    const state = attempts().stateOf(payment)
    const words =
        {
            approved: L("Paid"),
            pending: L("Payment pending"),
            unknown: L("Payment outcome unknown"),
            declined: L("Declined"),
            cancelled: L("Cancelled"),
            failed: L("Failed")
        }[state] || state
    return words + " · " + moneyText(payment.amount, payment.amountUomId)
}

// ===== the order =====
// The address a ticket is taxed at: the event's place (its facility's postal address), else the organization's own.
function taxAddressOf(policy) {
    const workEffort = one(WORK_EFFORT, {workEffortId: policy.workEffortId})
    if (workEffort?.facilityId) {
        const facilityAddress = rows("mantle.facility.FacilityContactMech", {facilityId: workEffort.facilityId})
            .filter(row => lib.active(row) && addressPurposes.includes(row.contactMechPurposeId))
            .sort((a, b) => addressPurposes.indexOf(a.contactMechPurposeId) - addressPurposes.indexOf(b.contactMechPurposeId))[0]
        if (facilityAddress) return facilityAddress.contactMechId
    }
    const own = rows("mantle.party.contact.PartyContactMech", {partyId: policy.organizationPartyId})
        .filter(row => lib.active(row) && addressPurposes.includes(row.contactMechPurposeId))
        .sort((a, b) => addressPurposes.indexOf(a.contactMechPurposeId) - addressPurposes.indexOf(b.contactMechPurposeId))[0]
    return own ? own.contactMechId : null
}
// The order of a reservation's held places, made once (its lines at the tickets' prices now, its tax by its gateway): {orderId,
// orderPartSeqId, total, currencyUomId}.
function orderOf(reservation, policy, held) {
    let orderId = reservation.orderId
    let order = orderId ? one("mantle.order.OrderHeader", {orderId}) : null
    if (order && order.statusId !== "OrderOpen") denied("ORDER_PLACED", "This registration's order is placed already")
    const prices = held.map(row => ({row, price: setup().priceOf(one(TICKET, {ticketTypeId: row.ticketTypeId}), policy)}))
    if (prices.some(item => !item.price.priced)) denied("OFFER_UNAVAILABLE", "This registration cannot be paid now")
    const currencyUomId = prices.find(item => !item.price.free)?.price.priceUomId
    if (!currencyUomId) denied("NOT_DUE", "Nothing is due")
    let orderPartSeqId
    if (!order) {
        const made = call("mantle.order.OrderServices.create#Order", {
            vendorPartyId: policy.organizationPartyId,
            customerPartyId: reservation.buyerPartyId,
            currencyUomId,
            productStoreId: policy.productStoreId || null,
            orderPurposeEnumId: "OrpEventRegistration",
            orderName: (L("Registration") + ": " + (policy.publicTitle || policy.registrationPolicyId)).slice(0, 255),
            postalContactMechId: taxAddressOf(policy)
        })
        orderId = made.orderId
        orderPartSeqId = made.orderPartSeqId
    } else orderPartSeqId = find("mantle.order.OrderPart", {orderId}).orderBy("orderPartSeqId").list()[0].orderPartSeqId
    for (const {row, price} of prices) {
        if (price.free) {
            if (row.orderId !== orderId) call("update#" + REGISTRATION, {registrationId: row.registrationId, orderId})
            continue
        }
        const ticket = one(TICKET, {ticketTypeId: row.ticketTypeId})
        const line = row.orderItemSeqId ? one("mantle.order.OrderItem", {orderId, orderItemSeqId: row.orderItemSeqId}) : null
        if (line) {
            // the price now, as the ticket product's own price says
            if (!dec(line.unitAmount).eq(dec(price.price)))
                call("mantle.order.OrderServices.update#OrderItem", {
                    orderId,
                    orderItemSeqId: line.orderItemSeqId,
                    unitAmount: price.price,
                    quantity: 1
                })
            continue
        }
        const orderItemSeqId = call("mantle.order.OrderServices.create#OrderItem", {
            orderId,
            orderPartSeqId,
            productId: ticket.productId,
            quantity: 1,
            unitAmount: price.price,
            itemDescription: ((ticket.ticketName || "Ticket") + ": " + (policy.publicTitle || "")).slice(0, 255),
            requireInventory: false
        }).orderItemSeqId
        call("update#" + REGISTRATION, {registrationId: row.registrationId, orderId, orderItemSeqId})
    }
    // the tax for what is in the order now: X1 through the seller's gateway for a storeless order, the store's for a store order
    try {
        call("mantle.other.TaxServices.calculate#OrderSalesTax", {orderId})
    } catch (error) {
        ec.logger.error("Registration order " + orderId + " tax: " + String(error?.message || error).split("\n")[0])
        denied("TAX_UNAVAILABLE", "The tax for this registration cannot be worked out now; try again later")
    }
    const header = one("mantle.order.OrderHeader", {orderId})
    const total = rows("mantle.order.OrderItem", {orderId}).reduce(
        (sum, line) => sum.add(dec(line.quantity ?? 1).multiply(dec(line.unitAmount))),
        dec(0)
    )
    return {orderId, orderPartSeqId, total, currencyUomId: header.currencyUomId || currencyUomId}
}
// The return address a provider sends the payer back to: the site's canonical host and Marketing mount, never a caller's origin.
const returnUrl = (reservation, returnKey) =>
    apps().pageUrl(
        reservation.siteId,
        "marketing",
        "/Register?ref=" + encodeURIComponent(reservation.reservationId) + "&key=" + encodeURIComponent(returnKey) + "&returned=1"
    )

// ===== start#RegistrationPayment =====
// The payment of a completed reservation's held places (the caller checked who asks): its order and promised payment made once and
// committed with the attempt, then the provider asked. {paymentState, provider (redirectUrl or form), returnKey once}.
function startPayment(reservationId) {
    let reservation = one(RESERVATION, {reservationId})
    const existing = reservation.paymentId ? one(P, {paymentId: reservation.paymentId}) : null
    if (existing) {
        const state = attempts().stateOf(existing)
        if (["approved", "pending", "unknown"].includes(state)) {
            refresh(reservationId, "page")
            return paymentView(reservationId, {alreadyStarted: true})
        }
    }
    const returnKey = ec.user.randomString(40).replace(/[^A-Za-z0-9_-]/g, "")
    const frozen = step("Registration payment " + reservationId, () => {
        const {policy} = places().lockOffer(reservation.registrationPolicyId)
        const current = find(RESERVATION, {reservationId}).forUpdate(true).one()
        if (!current.completedDate) denied("NOT_COMPLETED", "Answer the questions and accept the terms first")
        // a start that raced this one made the payment: answer it
        if (current.paymentId && current.paymentId !== reservation.paymentId) return {paymentId: current.paymentId, already: true}
        const held = places()
            .placesOf(reservationId)
            .filter(row => row.statusId === "EvrHeld")
        if (!held.length || held.some(row => !places().holdLive(row)))
            denied("HOLD_EXPIRED", "The hold on these places ended; start again")
        if (!held.some(row => places().paidOf(row, policy))) denied("NOT_DUE", "Nothing is due")
        const gateway = setup().gatewayOf(policy)
        if (!gateway) denied("PROVIDER_UNAVAILABLE", "Payment is not available for this event now")
        // an earlier payment declined or cancelled is ended; the new one replaces it
        if (current.paymentId) {
            const before = one(P, {paymentId: current.paymentId})
            if (before?.statusId === "PmntPromised") call("update#" + P, {paymentId: before.paymentId, statusId: "PmntCancelled"})
        }
        const order = orderOf(current, policy, held)
        if (order.total.compare(dec(0)) <= 0) denied("NOT_DUE", "Nothing is due")
        const paymentId = call("mantle.order.OrderServices.add#OrderPartPayment", {
            orderId: order.orderId,
            orderPartSeqId: order.orderPartSeqId,
            paymentInstrumentEnumId: "PiCreditCard",
            paymentGatewayConfigId: gateway,
            amount: order.total,
            statusId: "PmntPromised",
            effectiveDate: ec.user.nowTimestamp,
            comments: "Event registration " + reservationId
        }).paymentId
        attempts().create({
            purpose: "eventRegistration",
            paymentId,
            orderId: order.orderId,
            productStoreId: policy.productStoreId || null,
            siteId: current.siteId || policy.siteId || null,
            contactPartyId: current.buyerPartyId,
            returnKeyDigest: ec.user.singleUseCodeHash(returnKey),
            snapshotHash: lib.hash({
                orderId: order.orderId,
                total: order.total.toString(),
                places: held.map(row => row.registrationId)
            })
        })
        call("update#" + RESERVATION, {
            reservationId,
            orderId: order.orderId,
            paymentId,
            returnKeyDigest: ec.user.singleUseCodeHash(returnKey),
            placementTries: 0,
            failureMessage: null
        })
        for (const row of held) {
            call("update#" + REGISTRATION, {registrationId: row.registrationId, paymentId})
            places().record(row, "EraPaymentStarted", {})
        }
        return {paymentId}
    })
    if (frozen.error) {
        const error = new Error(frozen.error)
        error.reason = frozen.reason
        throw error
    }
    if (frozen.result.already) {
        refresh(reservationId, "page")
        return paymentView(reservationId, {alreadyStarted: true})
    }
    reservation = one(RESERVATION, {reservationId})
    const paymentId = frozen.result.paymentId
    const authorized = step("Registration payment authorization " + paymentId, () => {
        find(P, {paymentId}).forUpdate(true).one()
        const auth = attempts().asAttempt(paymentId, () =>
            call("mantle.account.PaymentServices.authorize#SinglePayment", {
                paymentId,
                operationKey: "evreg-auth-" + paymentId,
                returnUrl: returnUrl(reservation, returnKey)
            })
        )
        attempts().record(paymentId, "pending")
        call("update#mantle.account.payment.PortalPaymentAttempt", {paymentId, lastCheckDate: ec.user.nowTimestamp})
        return {paymentGatewayResponseId: auth.paymentGatewayResponseId || null}
    })
    if (authorized.error) ec.logger.warn("Registration payment " + paymentId + " authorization: " + authorized.error)
    refresh(reservationId, "none")
    return paymentView(reservationId, {returnKey})
}
// The payment's state for a page: {paymentState, provider, amountText, orderId}.
function paymentView(reservationId, extra = {}) {
    const reservation = one(RESERVATION, {reservationId})
    const payment = reservation.paymentId ? one(P, {paymentId: reservation.paymentId}) : null
    const state = payment ? attempts().stateOf(payment) : null
    return Object.assign(
        {
            paymentState: state,
            provider: state === "pending" ? attempts().providerAction(payment.paymentId) : null,
            amountText: payment ? moneyText(payment.amount, payment.amountUomId) : ""
        },
        extra
    )
}

// ===== the verified result =====
// The attempt asked of its provider (page: at most every few seconds; job: when it is due; none: not at all), its outcome applied,
// and the order placed once its places are pending; each step its own transaction.
function refresh(reservationId, mode) {
    const reservation = one(RESERVATION, {reservationId})
    if (!reservation?.paymentId) return {}
    const row = attempts().attemptOf(reservation.paymentId)
    const payment = one(P, {paymentId: reservation.paymentId})
    const state = attempts().stateOf(payment)
    if (row && !row.settledDate && mode !== "none" && ["pending", "unknown"].includes(state)) {
        const recently = mode === "page" && row.lastCheckDate && nowMs() - ms(row.lastCheckDate) < limits.lookupEveryMs
        if (!recently) {
            attempts().lookup(reservation.paymentId)
            step("Registration payment lookup " + reservation.paymentId, () => attempts().checked(reservation.paymentId))
        }
    }
    const applied = step("Registration payment result " + reservationId, () => apply(reservationId))
    if (applied.error) ec.logger.warn("Registration " + reservationId + " payment result: " + applied.error)
    return place(reservationId)
}
// The payment's state applied to the places it pays for, under the offer's lock.
function apply(reservationId) {
    const reservation = one(RESERVATION, {reservationId})
    const {policy} = places().lockOffer(reservation.registrationPolicyId)
    const payment = one(P, {paymentId: reservation.paymentId})
    const state = attempts().stateOf(payment)
    const paid = rows(REGISTRATION, {paymentId: reservation.paymentId})
    if (state === "approved") {
        const attempt = attempts().attemptOf(payment.paymentId)
        if (attempt && !attempt.settledDate) attempts().record(payment.paymentId, "authorized", "approved")
        const live = paid.filter(row => ["EvrHeld", "EvrExpired"].includes(row.statusId))
        if (live.length) {
            // every place still held: its seat kept with no end until the order's approval; any hold ended: no seat, review
            const allHeld = live.every(row => places().holdLive(row))
            for (const row of live) {
                if (allHeld) places().move(row, "EvrPending", "EraPaid", {holdExpireDate: null})
                else
                    places().move(
                        row,
                        "EvrReview",
                        "EraReview",
                        {holdExpireDate: null},
                        "The payment succeeded after the hold ended"
                    )
            }
            if (!allHeld)
                ec.logger.warn("Registration " + reservationId + ": paid after its hold ended; left for review, no seat taken")
        }
        // a place cancelled while its payment was out: the refund handed over now
        for (const row of paid.filter(row => row.statusId === "EvrCancelled" && !row.refundStatusEnumId)) {
            call("update#" + REGISTRATION, {registrationId: row.registrationId, refundStatusEnumId: "ErfRequested"})
            places().record(row, "EraRefundRequested", {})
            refundAfterCommit(row.registrationId)
        }
        return {state}
    }
    if (["declined", "cancelled", "failed"].includes(state)) {
        if (payment.statusId === "PmntPromised") call("update#" + P, {paymentId: payment.paymentId, statusId: "PmntCancelled"})
        const attempt = attempts().attemptOf(payment.paymentId)
        if (attempt && !attempt.settledDate) attempts().record(payment.paymentId, "failed", state)
    }
    return {state}
}
// place#Order once for a reservation whose paid places are pending (its placement SECA's autoApprove#Order approves it unless the
// seller's approval setting is on or a warning stops it); a failure is kept on the reservation and tried again a bounded number of
// times by the job.
function place(reservationId) {
    const reservation = one(RESERVATION, {reservationId})
    if (!reservation?.orderId || !reservation.paymentId) return {}
    const order = one("mantle.order.OrderHeader", {orderId: reservation.orderId})
    if (!order || placedStatuses.includes(order.statusId) || order.statusId !== "OrderOpen") return {statusId: order?.statusId}
    if (!rows(REGISTRATION, {paymentId: reservation.paymentId}).some(row => row.statusId === "EvrPending")) return {}
    if (Number(reservation.placementTries || 0) >= limits.placementTries) return {}
    const placed = step("Registration order placement " + reservation.orderId, () => {
        attempts().asAttempt(reservation.paymentId, () =>
            call("mantle.order.OrderServices.place#Order", {orderId: reservation.orderId})
        )
        attempts().record(reservation.paymentId, "placed")
        return {}
    })
    if (placed.error) {
        ec.logger.warn("Registration order " + reservation.orderId + " placement failed: " + placed.error)
        step("Registration placement failure " + reservationId, () =>
            call("update#" + RESERVATION, {
                reservationId,
                placementTries: Number(reservation.placementTries || 0) + 1,
                failureMessage: placed.error.slice(0, 255)
            })
        )
    }
    return {statusId: one("mantle.order.OrderHeader", {orderId: reservation.orderId})?.statusId}
}
// A place given a seat after review (confirm#Registration): the review places of its payment pending again and the order placed,
// so its approval confirms them as any order's does.
function seatReviewed(registrationIds) {
    const reservations = new Set()
    for (const registrationId of registrationIds) {
        const row = one(REGISTRATION, {registrationId})
        if (!row || row.statusId !== "EvrReview") continue
        places().move(row, "EvrPending", "EraConfirmed", {}, "A seat given after review")
        if (row.reservationId) reservations.add(row.reservationId)
    }
    for (const reservationId of reservations)
        ec.service
            .special()
            .name("mantle.work.EventRegistrationServices.refresh#RegistrationPayment")
            .parameters({reservationId})
            .registerOnCommit()
}

// ===== refunds =====
const refundAfterCommit = registrationId =>
    ec.service
        .special()
        .name("mantle.work.EventRegistrationServices.refund#RegistrationPayment")
        .parameters({registrationId})
        .registerOnCommit()
// A cancelled paid place's refund handed to the payment services: an authorization released once none of its places is left (all
// of them refunded together), a taken payment refunded by the place's share; each with its registration's operation key, so a
// repeat asks the provider nothing new. Its result kept on the place.
function refundPayment(p) {
    const registrationId = text(p.registrationId)
    const row = registrationId ? one(REGISTRATION, {registrationId}) : null
    if (!row || row.refundStatusEnumId !== "ErfRequested") return {}
    const payment = paymentOf(row)
    const setRefund = (ids, refundStatusEnumId, values = {}, note = "") => {
        for (const id of ids) {
            const target = one(REGISTRATION, {registrationId: id})
            if (!target || target.refundStatusEnumId !== "ErfRequested") continue
            call("update#" + REGISTRATION, Object.assign({registrationId: id, refundStatusEnumId}, values))
            places().record(target, "EraRefunded", {reason: note})
        }
    }
    if (!payment || !approvedStatuses.includes(payment.statusId)) {
        setRefund([registrationId], "ErfNone", {}, "Nothing was taken")
        return {refundStatusEnumId: "ErfNone"}
    }
    const ofPayment = rows(REGISTRATION, {paymentId: payment.paymentId})
    const success = responseId => {
        const response = responseId ? one(R, {paymentGatewayResponseId: responseId}) : null
        return response?.resultSuccess === "Y"
    }
    if (payment.statusId === "PmntAuthorized") {
        if (ofPayment.some(other => other.statusId !== "EvrCancelled")) return {refundStatusEnumId: "ErfRequested", waiting: true}
        const requested = ofPayment
            .filter(other => other.refundStatusEnumId === "ErfRequested")
            .map(other => other.registrationId)
        let out
        try {
            out = attempts().asAttempt(payment.paymentId, () =>
                lib.probe("mantle.account.PaymentServices.release#SinglePayment", {
                    paymentId: payment.paymentId,
                    operationKey: "evreg-release-" + payment.paymentId
                })
            )
        } catch (error) {
            ec.logger.warn(
                "Registration payment " + payment.paymentId + " release failed: " + String(error?.message || error).split("\n")[0]
            )
        }
        if (success(out?.paymentGatewayResponseId))
            setRefund(requested, "ErfRefunded", {}, "The payment's authorization was released")
        else setRefund(requested, "ErfFailed", {}, "The release was not confirmed; Accounting finishes it")
        return {refundStatusEnumId: one(REGISTRATION, {registrationId}).refundStatusEnumId}
    }
    const amount = shareOf(row)
    if (amount.compare(dec(0)) <= 0) {
        setRefund([registrationId], "ErfNone", {}, "A free place")
        return {refundStatusEnumId: "ErfNone"}
    }
    let out
    try {
        out = attempts().asAttempt(payment.paymentId, () =>
            lib.probe("mantle.account.PaymentServices.refund#SinglePayment", {
                paymentId: payment.paymentId,
                amount,
                operationKey: "evreg-refund-" + registrationId
            })
        )
    } catch (error) {
        ec.logger.warn("Registration " + registrationId + " refund failed: " + String(error?.message || error).split("\n")[0])
    }
    if (success(out?.paymentGatewayResponseId))
        setRefund(
            [registrationId],
            "ErfRefunded",
            {refundPaymentId: out.refundPaymentId || null},
            "Refunded " + moneyText(amount, payment.amountUomId)
        )
    else setRefund([registrationId], "ErfFailed", {}, "The refund was not confirmed; Accounting finishes it")
    return {refundStatusEnumId: one(REGISTRATION, {registrationId}).refundStatusEnumId}
}
// The order of cancelled places cancelled through the order's own service once none of them is left (an unplaced order too).
function cancelOrderIfEmpty(orderId) {
    const order = one("mantle.order.OrderHeader", {orderId})
    if (!order || ["OrderCancelled", "OrderRejected", "OrderCompleted"].includes(order.statusId)) return
    if (rows(REGISTRATION, {orderId}).some(row => places().LIVE_STATES.includes(row.statusId))) return
    call("mantle.order.OrderServices.cancel#Order", {orderId})
}

// ===== the job's part =====
// The attempts of registrations due for a lookup, placements to try again and refunds waiting on a capture; each apart.
function reconcile(p) {
    let looked = 0,
        refunded = 0
    const due = attempts().due("eventRegistration", Number(p.limit || limits.batch))
    for (const row of due) {
        const reservation = one(RESERVATION, {paymentId: row.paymentId})
        if (!reservation) continue
        try {
            refresh(reservation.reservationId, "job")
            looked++
        } catch (error) {
            ec.logger.error(
                "Registration payment " + row.paymentId + " reconcile: " + String(error?.message || error).split("\n")[0]
            )
        }
    }
    // placements that failed, tried again a bounded number of times
    for (const reservation of Array.from(
        find(RESERVATION)
            .condition("failureMessage", "is-not-null", null)
            .condition("placementTries", "less", limits.placementTries)
            .limit(limits.batch)
            .list()
    ))
        try {
            place(reservation.reservationId)
        } catch (error) {
            ec.logger.error(
                "Registration " + reservation.reservationId + " placement: " + String(error?.message || error).split("\n")[0]
            )
        }
    for (const row of Array.from(find(REGISTRATION, {refundStatusEnumId: "ErfRequested"}).limit(limits.batch).list()))
        try {
            const out = step("Registration refund " + row.registrationId, () =>
                refundPayment({registrationId: row.registrationId})
            )
            if (out.result?.refundStatusEnumId === "ErfRefunded") refunded++
        } catch (error) {
            ec.logger.error("Registration " + row.registrationId + " refund: " + String(error?.message || error).split("\n")[0])
        }
    return {looked, refunded}
}

;({
    paidFor,
    paymentOf,
    paymentText,
    shareOf,
    startPayment,
    paymentView,
    refresh,
    seatReviewed,
    refundAfterCommit,
    refundPayment,
    cancelOrderIfEmpty,
    reconcile,
    execute(op, parameters) {
        const operations = {
            refundPayment,
            refresh: p => refresh(text(p.reservationId), "job")
        }
        if (!Object.hasOwn(operations, op)) throw new Error("Unknown event registration payment operation " + op)
        const wasDisabled = ec.artifactExecution.disableAuthz()
        try {
            return operations[op](parameters || {})
        } finally {
            if (!wasDisabled) ec.artifactExecution.enableAuthz()
        }
    }
})
