// Event registrations, tickets and payment (impl-marketing P17; design-marketing §9 RegistrationSetup's order rules, Registrations,
// RegistrationDetail, §13 Register and Registration; mantle.work.EventRegistrationServices over EventRegistrationPlaces.js,
// EventRegistrationPayments.js and EventRegistrationNotices.js, reached by a visitor through mantle.marketing.MarketingPortalServices):
// two requests for the last seat are one held and one waitlisted; a hold expires once and the first waiting place is offered; a
// payment that succeeds after the hold ended is left for review and takes no seat; a repeated payment result confirms once; a
// cancellation releases its seat once and hands its refund over; a calendar RSVP is no seat; a storeless ticket order is taxed
// through the organization's gateway and approved with no store; with the seller's Sales approval setting on, a paid order stays
// placed with its place pending and no ticket until it is approved, which confirms it once, and a cancelled one releases the place;
// the terms accepted keep their words; staff access is the events manager's of the organization. Standalone: spec-local
// organizations, users, sites, a sending profile, a hosted test gateway, ticket products, a tax authority and events.
// Run: ./moq test mr-mantle --spec EventRegistrations
const lib = ec.resource.script("component://mr-mantle/test/marketing/MarketingSpecLib.js")
const {make, row, rows, system, organization, user, as} = lib
const E = "mantle.work.EventRegistrationServices."
const PORTAL = "mantle.marketing.MarketingPortalServices."
const prefix = "MKRG"
const orgA = prefix + "_ORG_A",
    orgB = prefix + "_ORG_B"
const siteA = prefix + "_SITE_A",
    siteB = prefix + "_SITE_B"
const gateway = prefix + "_HOSTED"
const users = {}
const ids = {}
const dayMs = 86400000
const R = "mantle.work.registration.EventRegistration"
const code = out => (/([A-Z][A-Z0-9_]+)/.exec(out.refusal || out.message || "") || [])[1] || ""
const start = Date.now() + 5 * dayMs
let keys = 0
const key = () => prefix + "k" + ++keys + "x" + Math.floor(Math.random() * 1e9)
// a PASS operation as the anonymous visitor: its result, or {kind, message} of its refusal
function visitor(service, input) {
    logout()
    ec.message.pushErrors()
    try {
        return ec.service
            .sync()
            .throwOnError(true)
            .name(PORTAL + service)
            .parameters({input})
            .call().result
    } catch (error) {
        return {kind: error.moquiErrorKind || "error", message: String(error.message)}
    } finally {
        ec.message.clearErrors()
        ec.message.popErrors()
        login("john.doe")
    }
}
const places = reservationId => rows(R, {reservationId}).sort((a, b) => String(a.registrationId).localeCompare(b.registrationId))
const states = reservationId =>
    places(reservationId)
        .map(place => place.statusId)
        .join()
const reservationOf = reference => row("mantle.work.registration.EventReservation", {reservationId: reference})
// a visitor's reservation of places on an offer: {reference, token, view} or the refusal
function reserve(siteId, registrationPolicyId, ticketTypeId, quantity, email) {
    const out = visitor("reserve#Registration", {
        siteId,
        registrationPolicyId,
        lines: JSON.stringify([{ticketTypeId, quantity}]),
        buyerName: "Spec buyer",
        buyerEmail: email,
        operationId: key()
    })
    return out.kind ? out : {reference: out.registration.reference, token: out.token, view: out.registration}
}
const complete = (siteId, token, attendees) =>
    visitor("complete#Registration", {
        siteId,
        token,
        attendees: JSON.stringify(attendees.map((name, index) => ({name, email: index ? null : null}))),
        acceptTerms: "Y",
        termsRevision: 0,
        operationId: key()
    })
const pay = (siteId, token) => visitor("start#RegistrationPayment", {siteId, token, operationId: key()})
// the provider's return: the payment looked up at once and applied
const returned = (siteId, token) => visitor("get#Registration", {siteId, token, returned: "true"})
const hold = (reservationId, minutesFromNow) =>
    system(() => {
        for (const place of places(reservationId))
            if (place.statusId === "EvrHeld")
                ec.service
                    .sync()
                    .name("update#" + R)
                    .parameters({
                        registrationId: place.registrationId,
                        holdExpireDate: new Date(Date.now() + minutesFromNow * 60000)
                    })
                    .disableAuthz()
                    .call()
    })
const runHolds = () =>
    system(() =>
        ec.service
            .sync()
            .name(E + "run#RegistrationHolds")
            .disableAuthz()
            .call()
    )

// an organization's site with its Marketing mount, a ready transactional profile, the gateway and an event with a published offer
function offerFor(org, site, key, seats, tickets, extra = {}) {
    const workEffortId = prefix + "_EV_" + key
    make("mantle.work.effort.WorkEffort", {
        workEffortId,
        workEffortTypeEnumId: "WetEvent",
        workEffortName: "Spec event " + key,
        statusId: "WeInPlanning",
        estimatedStartDate: new Date(start),
        estimatedCompletionDate: new Date(start + 2 * 3600000),
        location: "Spec hall"
    })
    make("mantle.work.registration.RegistrationEvent", {workEffortId, organizationPartyId: org, createdDate: new Date()})
    const registrationPolicyId = prefix + "_OFFER_" + key
    make(
        "mantle.work.registration.EventRegistrationPolicy",
        Object.assign(
            {
                registrationPolicyId,
                workEffortId,
                occurrenceStart: new Date(start),
                occurrenceEnd: new Date(start + 2 * 3600000),
                organizationPartyId: org,
                statusId: "ErpPublished",
                publicTitle: "Spec offer " + key,
                timeZone: "UTC",
                siteId: site,
                totalSeats: seats,
                holdMinutes: 15,
                waitlistEnabled: "Y",
                termsText: "Spec terms " + key,
                cancellationTerms: "Cancel any time.",
                questionScopeEnumId: "ErqAttendee",
                policyRevision: 1,
                termsRevision: 0,
                publishedDate: new Date()
            },
            extra
        )
    )
    tickets.forEach((ticket, index) =>
        make(
            "mantle.work.registration.EventTicketType",
            Object.assign(
                {
                    ticketTypeId: registrationPolicyId + "_T" + index,
                    registrationPolicyId,
                    ticketName: "Ticket " + index,
                    perOrderLimit: 4,
                    sequenceNum: index,
                    fromDate: new Date(Date.now() - dayMs)
                },
                ticket
            )
        )
    )
    return {workEffortId, registrationPolicyId, ticketTypeId: registrationPolicyId + "_T0"}
}
function siteFor(siteId, host, org) {
    make("mantle.public.PublicSite", {
        siteId,
        name: "Registration site",
        state: "published",
        registrationMode: "closed",
        locale: "en",
        timeZone: "UTC",
        policyRevision: 1,
        generation: 1
    })
    make("mantle.public.PublicSiteHost", {hostname: host, siteId, canonical: "Y"})
    make("mantle.public.PublicSiteApp", {
        siteId,
        appMountId: "marketing",
        app: "marketing",
        pathPrefix: "/marketing",
        enabled: "Y",
        targetId: org
    })
    make("moqui.basic.email.EmailAccount", {
        emailAccountId: siteId + "_BOUNCES",
        accountKindEnumId: "EakHosted",
        emailAddress: "bounces@bounce." + host,
        statusId: "EasActive"
    })
    make("mantle.party.MessageSendingProfile", {
        sendingProfileId: siteId + "_PROFILE",
        organizationPartyId: org,
        profileName: "Notices",
        channelEnumId: "MdcEmail",
        emailServerId: prefix + "_RELAY",
        fromAddress: "events@" + host,
        purposeEnumId: "MtpTransactional",
        trackingPolicyEnumId: "MtrNone",
        bounceDomain: "bounce." + host,
        fromDate: new Date(Date.now() - dayMs)
    })
    make("mantle.account.method.PaymentGatewayOrganization", {
        organizationPartyId: org,
        paymentGatewayConfigId: gateway,
        fromDate: 0,
        isEnabled: "Y"
    })
}

spec({
    setupSpec() {
        system(() => {
            organization(orgA, "Registrations A")
            organization(orgB, "Registrations B")
            make("mantle.ledger.config.PartyAcctgPreference", {
                organizationPartyId: orgA,
                baseCurrencyUomId: "USD",
                taxGatewayConfigId: "LOCAL"
            })
            make("mantle.ledger.config.PartyAcctgPreference", {organizationPartyId: orgB, baseCurrencyUomId: "USD"})
            // A's own address and its nexus, where a ticket is taxed (an event with no facility)
            ec.service
                .sync()
                .name("mantle.party.ContactServices.store#PartyContactInfo")
                .parameters({
                    partyId: orgA,
                    postalContactMechPurposeId: "PostalShippingOrigin",
                    address1: "1 Event St",
                    city: "Orem",
                    stateProvinceGeoId: "USA_UT",
                    postalCode: "84057",
                    countryGeoId: "USA"
                })
                .disableAuthz()
                .call()
            make("mantle.other.tax.TaxAuthority", {
                taxAuthorityId: prefix + "_UT",
                taxAuthorityTypeEnumId: "TatState",
                taxAuthGeoId: "USA_UT",
                description: "Spec Utah"
            })
            make("mantle.other.tax.TaxAuthorityParty", {taxAuthorityId: prefix + "_UT", partyId: orgA, fromDate: 0, isNexus: "Y"})
            make("mantle.other.tax.TaxAuthorityRate", {
                taxAuthorityRateId: prefix + "_RATE",
                taxAuthorityId: prefix + "_UT",
                rateTypeEnumId: "TarSalesTax",
                taxPercentage: "6",
                fromDate: 0
            })
            // B's sales orders wait for a Sales approver (the approval setting, impl-sales P11)
            make("mantle.sales.policy.SalesPolicy", {
                salesPolicyId: prefix + "_SALES_B",
                organizationPartyId: orgB,
                fromDate: new Date(Date.now() - dayMs),
                orderApprovalRequired: "Y"
            })
            make("moqui.basic.email.EmailServer", {
                emailServerId: prefix + "_RELAY",
                smtpHost: "relay.mkrg.example.test",
                smtpPort: "9"
            })
            const T = "mantle.account.PaymentTestServices."
            make("mantle.account.method.PaymentGatewayConfig", {
                paymentGatewayConfigId: gateway,
                paymentGatewayTypeEnumId: "PgtTest",
                description: "Registration hosted test gateway",
                authorizeServiceName: T + "hostedPending#PaymentAuthorization",
                captureServiceName: T + "alwaysApprove#PaymentCapture",
                releaseServiceName: T + "alwaysApprove#PaymentRelease",
                refundServiceName: T + "alwaysApprove#PaymentRefund",
                detailsServiceName: T + "alwaysApprove#PaymentDetails"
            })
            siteFor(siteA, "mkrg-a.example.test", orgA)
            siteFor(siteB, "mkrg-b.example.test", orgB)
            for (const [productId, owner] of [
                [prefix + "_SEAT_A", orgA],
                [prefix + "_SEAT_B", orgB]
            ]) {
                make("mantle.product.Product", {
                    productId,
                    productName: "Spec seat",
                    productTypeEnumId: "PtService",
                    ownerPartyId: owner
                })
                make("mantle.product.ProductPrice", {
                    productId,
                    pricePurposeEnumId: "PppPurchase",
                    priceTypeEnumId: "PptCurrent",
                    fromDate: 0,
                    minQuantity: 1,
                    price: "40.00",
                    priceUomId: "USD"
                })
            }
            ids.last = offerFor(orgA, siteA, "LAST", 1, [{priceSourceEnumId: "EtpFree"}])
            ids.paid = offerFor(orgA, siteA, "PAID", 10, [{priceSourceEnumId: "EtpProduct", productId: prefix + "_SEAT_A"}])
            ids.late = offerFor(orgA, siteA, "LATE", 1, [{priceSourceEnumId: "EtpProduct", productId: prefix + "_SEAT_A"}])
            ids.approval = offerFor(orgB, siteB, "APPROVAL", 1, [
                {priceSourceEnumId: "EtpProduct", productId: prefix + "_SEAT_B"}
            ])
            users.manager = user(prefix, "manager", [orgA], ["MARKETING_VIEW", "MARKETING_EVENT_MANAGE"])
            users.reader = user(prefix, "reader", [orgA], ["MARKETING_VIEW"])
            users.managerB = user(prefix, "managerB", [orgB], ["MARKETING_VIEW", "MARKETING_EVENT_MANAGE"])
        })
    },
    cleanupSpec() {
        login("john.doe")
    }
})

feature("two requests for the last seat: one held, one waitlisted; the hold expires once and the waiting place is offered", {
    when() {
        const first = reserve(siteA, ids.last.registrationPolicyId, ids.last.ticketTypeId, 1, "first@mkrg.example.test")
        const second = reserve(siteA, ids.last.registrationPolicyId, ids.last.ticketTypeId, 1, "second@mkrg.example.test")
        const firstStates = states(first.reference)
        const secondStates = states(second.reference)
        // the first hold ends unanswered: the job expires it once and offers the seat to the waiting place
        hold(first.reference, -1)
        const run = runHolds()
        const again = runHolds()
        const expiredActions = rows("mantle.work.registration.EventRegistrationAction", {
            registrationId: places(first.reference)[0].registrationId,
            actionEnumId: "EraExpired"
        }).length
        // the offered place is completed (free): it confirms; the terms it accepted are kept in their words
        const completed = complete(siteA, second.token, ["Second attendee"])
        const terms = row("mantle.work.registration.EventRegistrationTerms", {
            registrationPolicyId: ids.last.registrationPolicyId,
            termsRevision: 0
        })
        return {first, second, firstStates, secondStates, run, again, expiredActions, completed, terms}
    },
    then(r) {
        !r.first.kind && !!r.first.token && r.firstStates == "EvrHeld"
        !r.second.kind && r.secondStates == "EvrWaitlisted"
        r.second.view.state == "waitlisted"
        r.run.expired >= 1 && r.run.offered >= 1
        r.expiredActions == 1
        states(r.first.reference) == "EvrExpired"
        r.completed.registration.state == "confirmed"
        states(r.second.reference) == "EvrConfirmed"
        r.terms.termsText == "Spec terms LAST"
        places(r.second.reference)[0].termsRevision == 0
    }
})

feature(
    "a storeless ticket order is taxed through the organization's gateway, approved with no store, and its result confirms once",
    {
        when() {
            const reserved = reserve(siteA, ids.paid.registrationPolicyId, ids.paid.ticketTypeId, 2, "payer@mkrg.example.test")
            const completed = complete(siteA, reserved.token, ["Payer", "Guest"])
            const started = pay(siteA, reserved.token)
            const again = pay(siteA, reserved.token)
            const result = returned(siteA, reserved.token)
            const repeat = returned(siteA, reserved.token)
            const reservation = reservationOf(reserved.reference)
            const order = row("mantle.order.OrderHeader", {orderId: reservation.orderId})
            const taxLines = rows("mantle.order.OrderItem", {orderId: reservation.orderId, itemTypeEnumId: "ItemSalesTax"})
            const payments = rows("mantle.account.payment.Payment", {orderId: reservation.orderId})
            const confirmedActions = places(reserved.reference).map(
                place =>
                    rows("mantle.work.registration.EventRegistrationAction", {
                        registrationId: place.registrationId,
                        actionEnumId: "EraConfirmed"
                    }).length
            )
            return {reserved, completed, started, again, result, repeat, order, taxLines, payments, confirmedActions}
        },
        then(r) {
            r.completed.registration.state == "held" && r.completed.registration.paymentDue
            r.started.payment.paymentState == "pending" && !!r.started.payment.provider?.redirectUrl
            r.again.payment.paymentState == "pending"
            r.payments.length == 1
            r.result.registration.state == "confirmed"
            r.repeat.registration.state == "confirmed"
            !r.order.productStoreId && r.order.orderPurposeEnumId == "OrpEventRegistration"
            r.order.statusId == "OrderApproved"
            r.taxLines.length == 2
            toDecimal(r.order.grandTotal).eq(toDecimal("84.80"))
            r.confirmedActions.join() == "1,1"
            states(r.reserved.reference) == "EvrConfirmed,EvrConfirmed"
        }
    }
)

feature("a cancellation releases its seat once and hands its refund to Accounting; staff access is the events manager's", {
    when() {
        const reservation = rows("mantle.work.registration.EventReservation", {
            registrationPolicyId: ids.paid.registrationPolicyId
        })[0]
        const place = places(reservation.reservationId)[0]
        const takenBefore = ec.resource
            .script("component://mr-mantle/service/mantle/work/EventRegistrations.js")
            .seatsTaken(ids.paid.registrationPolicyId)
        const reader = as(users.reader, E + "get#Registration", {registrationId: place.registrationId})
        const otherOrg = as(users.managerB, E + "get#Registration", {registrationId: place.registrationId})
        const read = as(users.manager, E + "get#Registration", {registrationId: place.registrationId})
        const stale = as(users.manager, E + "cancel#Registration", {
            registrationId: place.registrationId,
            expectedRevision: 1,
            reason: "Spec"
        })
        const cancelled = as(users.manager, E + "cancel#Registration", {
            registrationId: place.registrationId,
            expectedRevision: read.registration.revision,
            reason: "Cannot come"
        })
        const twice = as(users.manager, E + "cancel#Registration", {
            registrationId: place.registrationId,
            expectedRevision: entityRevision(place.registrationId),
            reason: "Again"
        })
        const takenAfter = ec.resource
            .script("component://mr-mantle/service/mantle/work/EventRegistrations.js")
            .seatsTaken(ids.paid.registrationPolicyId)
        runHolds()
        const after = row(R, {registrationId: place.registrationId})
        const refunds = rows("mantle.account.payment.Payment", {refundForPaymentId: place.paymentId})
        const found = as(users.manager, E + "find#Registrations", {registrationPolicyId: ids.paid.registrationPolicyId})
        return {reader, otherOrg, read, stale, cancelled, twice, takenBefore, takenAfter, after, refunds, found}
    },
    then(r) {
        code(r.reader) == "PERMISSION_DENIED"
        code(r.otherOrg) == "RECORD_UNAVAILABLE"
        r.read.refusal == "" && r.read.registration.termsText == "Spec terms PAID" && r.read.canCancel
        code(r.stale) == "STALE_REVISION"
        r.cancelled.refusal == "" && r.cancelled.statusId == "EvrCancelled" && r.cancelled.refundStatusEnumId == "ErfRequested"
        code(r.twice) == "STATUS_INVALID"
        r.takenBefore - r.takenAfter == 1
        r.after.refundStatusEnumId == "ErfRefunded" && !r.after.credentialDigest
        r.refunds.length == 1 && toDecimal(r.refunds[0].amount).eq(toDecimal("42.40"))
        r.found.registrationList.length == 2
    }
})

feature("a payment that succeeds after its hold ended is left for review and takes no seat; a calendar RSVP is no seat", {
    when() {
        const reserved = reserve(siteA, ids.late.registrationPolicyId, ids.late.ticketTypeId, 1, "late@mkrg.example.test")
        complete(siteA, reserved.token, ["Late payer"])
        const started = pay(siteA, reserved.token)
        // the hold ends while the payer is at the provider; another visitor takes the freed seat
        hold(reserved.reference, -1)
        runHolds()
        const other = reserve(siteA, ids.late.registrationPolicyId, ids.late.ticketTypeId, 1, "other@mkrg.example.test")
        const result = returned(siteA, reserved.token)
        const reservation = reservationOf(reserved.reference)
        const order = row("mantle.order.OrderHeader", {orderId: reservation.orderId})
        // a calendar invitation's acceptance is not a registration
        const seats = () =>
            ec.resource
                .script("component://mr-mantle/service/mantle/work/EventRegistrations.js")
                .seatsTaken(ids.late.registrationPolicyId)
        const before = seats()
        system(() =>
            make("mantle.work.effort.WorkEffortParty", {
                workEffortId: ids.late.workEffortId,
                partyId: users.reader,
                roleTypeId: "Attendee",
                fromDate: new Date(),
                statusId: "WeptAssigned"
            })
        )
        return {
            started,
            other,
            result,
            order,
            before,
            after: seats(),
            states: states(reserved.reference),
            otherStates: states(other.reference)
        }
    },
    then(r) {
        r.started.payment.paymentState == "pending"
        !r.other.kind && r.otherStates == "EvrHeld"
        r.states == "EvrReview"
        r.result.registration.state == "review"
        r.order.statusId == "OrderOpen"
        r.before == 1 && r.after == 1
    }
})

feature(
    "with the seller's approval setting on, a paid order stays placed with its place pending and no ticket until it is approved",
    {
        when() {
            const reserved = reserve(
                siteB,
                ids.approval.registrationPolicyId,
                ids.approval.ticketTypeId,
                1,
                "waiting@mkrg.example.test"
            )
            complete(siteB, reserved.token, ["Waiting payer"])
            pay(siteB, reserved.token)
            const paid = returned(siteB, reserved.token)
            const reservation = reservationOf(reserved.reference)
            const placed = row("mantle.order.OrderHeader", {orderId: reservation.orderId}).statusId
            const pending = row(R, {registrationId: places(reserved.reference)[0].registrationId})
            // the hold no longer ends: the job leaves it
            runHolds()
            const stillPending = states(reserved.reference)
            // a holder approves the order: the place confirms, once
            system(() =>
                ec.service
                    .sync()
                    .name("mantle.order.OrderServices.update#OrderStatus")
                    .parameters({orderId: reservation.orderId, statusId: "OrderApproved"})
                    .disableAuthz()
                    .call()
            )
            const approved = states(reserved.reference)
            const view = visitor("get#Registration", {siteId: siteB, token: reserved.token})
            // a second order of the same offer, cancelled instead: its place is released once
            const next = reserve(siteB, ids.approval.registrationPolicyId, ids.approval.ticketTypeId, 1, "next@mkrg.example.test")
            const full = next.kind ? null : states(next.reference)
            return {paid, placed, pending, stillPending, approved, view, next, full}
        },
        then(r) {
            r.placed == "OrderPlaced"
            r.paid.registration.state == "pending" && !r.paid.registration.joinUrl
            r.paid.registration.places[0].canShowCode == false
            r.pending.statusId == "EvrPending" && r.pending.holdExpireDate == null
            r.stillPending == "EvrPending"
            r.approved == "EvrConfirmed"
            r.view.registration.state == "confirmed" && r.view.registration.places[0].canShowCode
            r.full == "EvrWaitlisted"
        }
    }
)

feature("a cancelled order releases its places; a client's reservations past its limit are refused and hold no seat", {
    when() {
        const reservation = rows("mantle.work.registration.EventReservation", {
            registrationPolicyId: ids.approval.registrationPolicyId
        }).find(found => !!found.orderId)
        system(() =>
            ec.service
                .sync()
                .name("mantle.order.OrderServices.cancel#Order")
                .parameters({orderId: reservation.orderId})
                .disableAuthz()
                .call()
        )
        const cancelled = states(reservation.reservationId)
        // the freed seat goes to the waiting place
        runHolds()
        const waiting = rows("mantle.work.registration.EventReservation", {
            registrationPolicyId: ids.approval.registrationPolicyId
        }).find(found => !found.orderId)
        const offered = states(waiting.reservationId)
        // the client's limit (10 in ten minutes) was spent above and here: the next is refused and holds nothing
        const taken = rows(R, {registrationPolicyId: ids.last.registrationPolicyId}).length
        let refused = null
        for (let index = 0; index < 12 && !refused; index++) {
            const out = reserve(
                siteA,
                ids.last.registrationPolicyId,
                ids.last.ticketTypeId,
                1,
                "many" + index + "@mkrg.example.test"
            )
            if (out.kind === "Tarpit") refused = out
        }
        const after = rows(R, {registrationPolicyId: ids.last.registrationPolicyId}).length
        return {cancelled, offered, refused, taken, after}
    },
    then(r) {
        r.cancelled == "EvrCancelled"
        r.offered == "EvrHeld"
        !!r.refused && r.refused.message.includes("RATE_LIMITED")
        r.after - r.taken <= 10
    }
})

function entityRevision(registrationId) {
    return ec.resource
        .script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
        .ms(row(R, {registrationId}).lastUpdatedStamp)
}
