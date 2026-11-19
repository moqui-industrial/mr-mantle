// Event registrations, tickets and payment (impl-marketing P17; design-marketing §9 RegistrationSetup's order rules, Registrations,
// RegistrationDetail, §13 Register and Registration; mantle.work.EventRegistrationServices over EventRegistrationPlaces.js,
// EventRegistrationPayments.js and EventRegistrationNotices.js, reached by a visitor through mantle.marketing.MarketingPortalServices):
// two requests for the last seat are one held and one waitlisted; a hold expires once and the first waiting place is offered; a
// payment that succeeds after the hold ended is left for review and takes no seat; a repeated payment result confirms once; a
// cancellation releases its seat once and hands its refund over; a calendar RSVP is no seat; a storeless ticket order is taxed
// through the organization's gateway and approved with no store; with the seller's Sales approval setting on, a paid order stays
// placed with its place pending and no ticket until it is approved, which confirms it once, and a cancelled one releases the place;
// the terms accepted keep their words; staff access is the events manager's of the organization. Follow-up 1: a ticket order's
// approval invoices it once and so captures its payment, a cancellation before it refunded from the capture; the cancellation rule of
// the accepted terms (a deadline, a refund percentage, a late cancellation without refund) and staff's override with a reason; one
// entry code per revision, shown again alike, a staff reissue revoking it. Follow-up 5: a ticket payment's visitor key kept as its
// digest on the order only where allowed, read again before the placement, and the order attributed by it. Standalone: spec-local
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
// the user's call (Nov 15): an organization whose gateway's page takes a posted form token (Accept Hosted's shape)
const orgC = prefix + "_ORG_C",
    siteC = prefix + "_SITE_C",
    formGateway = prefix + "_FORM"
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
// the receipt's link of a free registration held for its buyer's address (its RegistrationConfirm capability, made as the
// receipt makes it, its token only in the mail), opened: it confirms the places (SEC-PSS-88)
function receiptLink(siteId, reference) {
    const made = system(() =>
        ec.resource.script("component://mr-mantle/service/mantle/party/ExternalAccess.js").create({
            recordType: "EventRegistration",
            recordId: reference,
            scopes: ["RegistrationView", "RegistrationCancel", "RegistrationConfirm"],
            validDays: 1
        })
    )
    return visitor("get#Registration", {siteId, token: made.token})
}
const completeOnly = (siteId, token, attendees) =>
    visitor("complete#Registration", {
        siteId,
        token,
        attendees: JSON.stringify(attendees.map((name, index) => ({name, email: index ? null : null}))),
        acceptTerms: "Y",
        termsRevision: 0,
        operationId: key()
    })
// a completion's answer; a free one held for its buyer's address then confirmed through the receipt's link, as its buyer does
function throughReceipt(siteId, out) {
    const view = out.registration
    if (!view || view.state !== "held" || view.stateText !== "Held: confirm it with the link we emailed you") return out
    return receiptLink(siteId, view.reference)
}
const complete = (siteId, token, attendees) => throughReceipt(siteId, completeOnly(siteId, token, attendees))
// Pay as the page does: with the key of the amount the payment step showed (getRegistration's priceKey)
const pay = (siteId, token) =>
    visitor("start#RegistrationPayment", {
        siteId,
        token,
        priceKey: visitor("get#Registration", {siteId, token}).registration?.priceKey,
        operationId: key()
    })
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
function siteFor(siteId, host, org, gatewayId = gateway) {
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
        paymentGatewayConfigId: gatewayId,
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
                // follow-up 1: the hosted page only authorizes; the order's approval invoices it and so captures
                authorizeServiceName: T + "hostedAuthorize#PaymentAuthorization",
                captureServiceName: T + "alwaysApprove#PaymentCapture",
                releaseServiceName: T + "alwaysApprove#PaymentRelease",
                refundServiceName: T + "alwaysApprove#PaymentRefund",
                detailsServiceName: T + "alwaysApprove#PaymentDetails"
            })
            make("mantle.account.method.PaymentGatewayConfig", {
                paymentGatewayConfigId: formGateway,
                paymentGatewayTypeEnumId: "PgtTest",
                description: "Registration posted-form test gateway",
                authorizeServiceName: T + "hostedForm#PaymentAuthorization",
                captureServiceName: T + "alwaysApprove#PaymentCapture",
                releaseServiceName: T + "alwaysApprove#PaymentRelease",
                refundServiceName: T + "alwaysApprove#PaymentRefund",
                detailsServiceName: T + "alwaysApprove#PaymentDetails"
            })
            organization(orgC, "Registrations C")
            make("mantle.ledger.config.PartyAcctgPreference", {organizationPartyId: orgC, baseCurrencyUomId: "USD"})
            siteFor(siteC, "mkrg-c.example.test", orgC, formGateway)
            siteFor(siteA, "mkrg-a.example.test", orgA)
            siteFor(siteB, "mkrg-b.example.test", orgB)
            for (const [productId, owner] of [
                [prefix + "_SEAT_A", orgA],
                [prefix + "_SEAT_B", orgB],
                [prefix + "_SEAT_P", orgA],
                [prefix + "_SEAT_C", orgC]
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
            // P17 review: the race for the last seats, the waitlist offered by reservation, a price changed before the payment
            ids.race = offerFor(orgA, siteA, "RACE", 2, [{priceSourceEnumId: "EtpFree"}])
            ids.group = offerFor(orgA, siteA, "GROUP", 2, [{priceSourceEnumId: "EtpFree"}])
            ids.price = offerFor(orgA, siteA, "PRICE", 5, [{priceSourceEnumId: "EtpProduct", productId: prefix + "_SEAT_P"}])
            ids.form = offerFor(orgC, siteC, "FORM", 5, [{priceSourceEnumId: "EtpProduct", productId: prefix + "_SEAT_C"}])
            // follow-up 1: a split order of a seller whose orders wait for approval, the cancellation rule, the entry code
            ids.split = offerFor(orgB, siteB, "SPLIT", 5, [{priceSourceEnumId: "EtpProduct", productId: prefix + "_SEAT_B"}])
            ids.terms = offerFor(orgA, siteA, "TERMS", 10, [{priceSourceEnumId: "EtpProduct", productId: prefix + "_SEAT_A"}], {
                cancelDeadlineHours: 48,
                refundPercent: 50,
                lateCancelAllowed: "N"
            })
            ids.code = offerFor(orgA, siteA, "CODE", 5, [{priceSourceEnumId: "EtpFree"}])
            // follow-up 5: the ticket payments that carry a remote frontend's visitor key
            ids.visitor = offerFor(orgA, siteA, "VISITOR", 10, [{priceSourceEnumId: "EtpProduct", productId: prefix + "_SEAT_A"}])
            // SEC-PSS-61: reservations for addresses the directory knows
            ids.match = offerFor(orgA, siteA, "MATCH", 5, [{priceSourceEnumId: "EtpFree"}])
            ids.claim = offerFor(orgA, siteA, "CLAIM", 5, [{priceSourceEnumId: "EtpFree"}])
            make("mantle.party.Party", {partyId: prefix + "_RACER", partyTypeEnumId: "PtyPerson"})
            make("mantle.party.Person", {partyId: prefix + "_RACER", firstName: "Racer"})
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

feature("six requests at once for the last two seats: two held, the rest waitlisted, never more seats than the offer has", {
    when() {
        const results = parallel(
            6,
            (thread, args) => {
                login("john.doe")
                ec.artifactExecution.disableAuthz()
                let out = null
                try {
                    ec.transaction.runRequireNew(null, "Race " + thread, () => {
                        out = ec.resource.script("component://mr-mantle/service/mantle/work/EventRegistrationPlaces.js").reserve({
                            registrationPolicyId: args.offer,
                            lines: [{ticketTypeId: args.ticket, quantity: 1}],
                            buyer: {partyId: args.buyer, contactMechId: null, name: "Racer"},
                            requestKey: args.prefix + "race" + thread + "x" + args.stamp,
                            sourceEnumId: "ErsPublic",
                            siteId: args.site
                        })
                    })
                } catch (error) {
                    out = {refused: String(error?.message || error).split("\n")[0]}
                }
                ec.message.clearErrors()
                return {waitlisted: !!out?.waitlisted, refused: out?.refused || ""}
            },
            {
                offer: ids.race.registrationPolicyId,
                ticket: ids.race.ticketTypeId,
                buyer: prefix + "_RACER",
                prefix,
                site: siteA,
                stamp: Date.now()
            },
            {transaction: false}
        )
        const all = rows(R, {registrationPolicyId: ids.race.registrationPolicyId})
        return {
            results,
            held: all.filter(place => place.statusId === "EvrHeld").length,
            waitlisted: all.filter(place => place.statusId === "EvrWaitlisted").length
        }
    },
    then(r) {
        r.results.every(result => result.refused == "")
        r.held == 2
        r.waitlisted == 4
        r.results.filter(result => !result.waitlisted).length == 2
    }
})

feature("the waitlist is offered a reservation at a time: none split, none passed; a completed free one confirms at once", {
    when() {
        const enter = (name, quantity) =>
            as(users.manager, E + "reserve#Registration", {
                registrationPolicyId: ids.group.registrationPolicyId,
                lines: [{ticketTypeId: ids.group.ticketTypeId, quantity}],
                buyerName: name,
                buyerEmail: name.toLowerCase().replace(/ /g, ".") + "@mkrg.example.test",
                requestKey: key()
            })
        const first = enter("Group first", 2)
        const pair = enter("Group pair", 2)
        const single = enter("Group single", 1)
        // the waiting pair answers for both its attendees while waiting (a staff entry may), the second with an address of their own
        const completedPair = as(users.manager, E + "complete#Registration", {
            reservationId: pair.reservationId,
            attendees: [{name: "Pair buyer"}, {name: "Pair guest", email: "pair.guest@mkrg.example.test"}],
            acceptTerms: true,
            requestKey: key()
        })
        const cancelOne = id => {
            const read = as(users.manager, E + "get#Registration", {registrationId: id})
            return as(users.manager, E + "cancel#Registration", {
                registrationId: id,
                expectedRevision: read.registration.revision,
                reason: "Spec"
            })
        }
        // one seat comes free: the pair does not fit and the single one behind it does not pass it
        cancelOne(first.registrationIds[0])
        runHolds()
        const afterOne = {pair: states(pair.reservationId), single: states(single.reservationId)}
        // the second seat: the pair is offered together and, completed and free, confirmed
        cancelOne(first.registrationIds[1])
        runHolds()
        const afterTwo = {pair: states(pair.reservationId), single: states(single.reservationId)}
        return {first, pair, single, completedPair, afterOne, afterTwo}
    },
    then(r) {
        r.first.refusal == "" && r.first.state == "held"
        r.pair.refusal == "" && r.pair.state == "waitlisted"
        r.single.refusal == "" && r.single.state == "waitlisted"
        r.completedPair.refusal == ""
        r.afterOne.pair == "EvrWaitlisted,EvrWaitlisted" && r.afterOne.single == "EvrWaitlisted"
        r.afterTwo.pair == "EvrConfirmed,EvrConfirmed" && r.afterTwo.single == "EvrWaitlisted"
    }
})

feature("a ticket's link to the reservation goes to its buyer only, never to another attendee", {
    when() {
        const pair = rows("mantle.work.registration.EventReservation", {
            registrationPolicyId: ids.group.registrationPolicyId
        }).find(
            reservation => places(reservation.reservationId).length == 2 && places(reservation.reservationId)[1].attendeePartyId
        )
        const [own, guest] = places(pair.reservationId)
        const body = place =>
            system(() => {
                const delivery = rows("mantle.party.MessageDelivery", {eventKey: "evreg-ticket:" + place.registrationId})[0]
                if (!delivery) return {missing: true}
                return ec.service
                    .sync()
                    .name(E + "build#RegistrationDelivery")
                    .parameters({deliveryId: delivery.deliveryId})
                    .disableAuthz()
                    .call()
            })
        return {own: body(own), guest: body(guest), buyer: pair.buyerPartyId, guestParty: guest.attendeePartyId}
    },
    then(r) {
        r.guestParty != r.buyer
        !r.own.missing && !r.guest.missing
        String(r.own.bodyText).includes("Entry code") && String(r.guest.bodyText).includes("Entry code")
        String(r.own.bodyText).includes("Registration?token=")
        !String(r.guest.bodyText).includes("token=")
    }
})

feature("a price changed after the reservation is refused at the payment's start with the new amount, never charged unseen", {
    when() {
        const reserved = reserve(siteA, ids.price.registrationPolicyId, ids.price.ticketTypeId, 1, "price@mkrg.example.test")
        complete(siteA, reserved.token, ["Price payer"])
        const shown = visitor("get#Registration", {siteId: siteA, token: reserved.token}).registration
        // the ticket product's price changes while the place is held
        system(() => {
            const price = rows("mantle.product.ProductPrice", {productId: prefix + "_SEAT_P"})[0]
            ec.service
                .sync()
                .name("update#mantle.product.ProductPrice")
                .parameters({productPriceId: price.productPriceId, price: "50.00"})
                .disableAuthz()
                .call()
        })
        const stale = visitor("start#RegistrationPayment", {
            siteId: siteA,
            token: reserved.token,
            priceKey: shown.priceKey,
            operationId: key()
        })
        const paymentsAfterStale = rows("mantle.account.payment.Payment", {
            orderId: reservationOf(reserved.reference).orderId || "_NONE_"
        }).length
        const missingKey = visitor("start#RegistrationPayment", {siteId: siteA, token: reserved.token, operationId: key()})
        const reshown = visitor("get#Registration", {siteId: siteA, token: reserved.token}).registration
        const started = visitor("start#RegistrationPayment", {
            siteId: siteA,
            token: reserved.token,
            priceKey: reshown.priceKey,
            operationId: key()
        })
        const payment = row("mantle.account.payment.Payment", {paymentId: reservationOf(reserved.reference).paymentId})
        return {shown, stale, paymentsAfterStale, missingKey, reshown, started, payment}
    },
    then(r) {
        !!r.shown.priceKey && r.shown.amountDueText.includes("40")
        r.stale.kind == "Conflict" && r.stale.message.includes("PRICE_CHANGED") && r.stale.message.includes("50")
        r.paymentsAfterStale == 0
        r.missingKey.kind == "Unprocessable"
        r.reshown.priceKey != r.shown.priceKey && r.reshown.amountDueText.includes("50")
        r.started.payment.paymentState == "pending"
        toDecimal(r.payment.amount).eq(toDecimal("53.00"))
    }
})

feature(
    "a provider page that takes a posted form: a fresh token by the capability only, the return key reading the state alone",
    {
        when() {
            const reserved = reserve(siteC, ids.form.registrationPolicyId, ids.form.ticketTypeId, 1, "form@mkrg.example.test")
            complete(siteC, reserved.token, ["Form payer"])
            const started = pay(siteC, reserved.token)
            const form = visitor("get#RegistrationPaymentForm", {siteId: siteC, token: reserved.token, operationId: key()})
            const again = visitor("get#RegistrationPaymentForm", {siteId: siteC, token: reserved.token, operationId: key()})
            // where the page sends the payer back: Register's canonical address with the reservation and a fresh return key
            const paymentId = reservationOf(reserved.reference).paymentId
            const back = rows("mantle.account.method.PaymentGatewayResponse", {paymentId, transactionStatus: "HostedPending"})[0]
                .reasonMessage
            const returnKey = decodeURIComponent((/[?&]returnToken=([^&]+)/.exec(back) || [])[1] || "")
            const byKey = visitor("get#Registration", {siteId: siteC, reference: reserved.reference, key: returnKey})
            const formByKey = visitor("get#RegistrationPaymentForm", {
                siteId: siteC,
                reference: reserved.reference,
                key: returnKey
            })
            const otherSite = visitor("get#RegistrationPaymentForm", {siteId: siteA, token: reserved.token})
            // the verified result confirms; the page is no longer offered
            const result = returned(siteC, reserved.token)
            const after = visitor("get#RegistrationPaymentForm", {siteId: siteC, token: reserved.token})
            return {started, form, again, back, byKey, formByKey, otherSite, result, after}
        },
        then(r) {
            r.started.payment.paymentState == "pending" && r.started.payment.provider.form == true
            r.form.form.formUrl == "https://test.authorize.net/payment/payment"
            String(r.form.form.fields.token).startsWith("TEST-TOKEN-")
            String(r.again.form.fields.token) != String(r.form.form.fields.token)
            String(r.back).startsWith("https://mkrg-c.example.test/marketing/Register?ref=")
            r.byKey.registration.limited == true && r.byKey.registration.state == "held"
            r.formByKey.kind == "NotFound" && r.otherSite.kind == "NotFound"
            r.result.registration.state == "confirmed"
            r.after.kind == "NotFound"
        }
    }
)

feature(
    "a ticket order skips only the new-customer and address warnings: a Sales rule's warning still keeps it placed, its place pending",
    {
        when() {
            // the user's call (Nov 15): the exemption is those two checks alone; a Sales order rule in effect still stops auto-approval
            system(() =>
                make("mantle.sales.policy.SalesApprovalPolicy", {
                    salesApprovalPolicyId: prefix + "_RULE_A",
                    organizationPartyId: orgA,
                    purposeEnumId: "SapOrder",
                    ruleTypeEnumId: "SarAmount",
                    thresholdAmount: "10",
                    currencyUomId: "USD",
                    fromDate: new Date(Date.now() - 60000)
                })
            )
            const reserved = as(users.manager, E + "reserve#Registration", {
                registrationPolicyId: ids.paid.registrationPolicyId,
                ticketTypeId: ids.paid.ticketTypeId,
                quantity: 1,
                buyerName: "Ruled buyer",
                buyerEmail: "ruled@mkrg.example.test",
                requestKey: key()
            })
            const completed = as(users.manager, E + "complete#Registration", {
                reservationId: reserved.reservationId,
                attendees: [{name: "Ruled buyer"}],
                acceptTerms: true,
                requestKey: key()
            })
            const started = as(users.manager, E + "start#RegistrationPayment", {reservationId: reserved.reservationId})
            // the provider's result arrives (the job's lookup)
            system(() =>
                ec.service
                    .sync()
                    .name(E + "refresh#RegistrationPayment")
                    .parameters({reservationId: reserved.reservationId})
                    .disableAuthz()
                    .call()
            )
            const orderId = reservationOf(reserved.reservationId).orderId
            const warnings = system(() =>
                Array.from(
                    ec.service
                        .sync()
                        .name("mantle.order.OrderInfoServices.check#OrderPreApprove")
                        .parameters({orderId})
                        .disableAuthz()
                        .call().approveWarnings || []
                )
            )
            const order = row("mantle.order.OrderHeader", {orderId})
            // the rule ended again, so later features' orders are not stopped by it
            system(() =>
                ec.service
                    .sync()
                    .name("update#mantle.sales.policy.SalesApprovalPolicy")
                    .parameters({salesApprovalPolicyId: prefix + "_RULE_A", thruDate: new Date()})
                    .disableAuthz()
                    .call()
            )
            return {reserved, completed, started, warnings, order, states: states(reserved.reservationId)}
        },
        then(r) {
            r.reserved.refusal == "" && r.completed.refusal == "" && r.started.refusal == ""
            !r.order.productStoreId && r.order.orderPurposeEnumId == "OrpEventRegistration"
            r.order.statusId == "OrderPlaced"
            r.states == "EvrPending"
            r.warnings.length == 1 && r.warnings[0].includes("Sales order approval needed")
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

// ===== follow-up 1 (§4 Nov 15, the user's calls) =====
// the request limits are spent by the features above (the last one on purpose): these start from none
const freshLimits = () => system(() => ec.entity.find("moqui.security.public.AccountAttempt").deleteAll())
const P = "mantle.account.payment.Payment"
const billedInvoices = orderId => [...new Set(rows("mantle.order.OrderItemBilling", {orderId}).map(billing => billing.invoiceId))]
const invoiceTotal = invoiceId =>
    system(
        () =>
            ec.service
                .sync()
                .name("mantle.account.InvoiceServices.get#InvoiceTotal")
                .parameters({invoiceId})
                .disableAuthz()
                .call().invoiceTotal
    )
const buyerCancel = (siteId, token, registrationIds) =>
    visitor("cancel#Registration", {
        siteId,
        token,
        registrationIds: registrationIds.join(","),
        confirm: "Y",
        operationId: key()
    })
// a value read again until it is truthy, for up to five seconds: the invoice and capture run once the approval commits, on a
// service worker (SalesRecurrence's waitFor)
function waitFor(read, millis = 5000) {
    const end = Date.now() + millis
    let value = read()
    while (!value && Date.now() < end) value = read()
    return value
}
const captured = paymentId => waitFor(() => row(P, {paymentId}).statusId === "PmntDelivered")
const approve = orderId =>
    system(() =>
        ec.service
            .sync()
            .name("mantle.order.OrderServices.update#OrderStatus")
            .parameters({orderId, statusId: "OrderApproved"})
            .disableAuthz()
            .call()
    )

feature(
    "a ticket order's approval invoices it once and captures its payment; a place cancelled before it is refunded from the capture",
    {
        when() {
            freshLimits()
            // the storeless order approved at its payment's result above: invoiced once, its authorization captured
            const paidOrder = rows("mantle.work.registration.EventReservation", {
                registrationPolicyId: ids.paid.registrationPolicyId
            }).find(found => !!found.orderId)
            const paidInvoices = billedInvoices(paidOrder.orderId)
            const paidPayment = row(P, {paymentId: paidOrder.paymentId})
            const again = system(
                () =>
                    ec.service
                        .sync()
                        .name(E + "invoice#RegistrationOrder")
                        .parameters({orderId: paidOrder.orderId})
                        .disableAuthz()
                        .call().invoiceIds
            )
            // a seller whose orders wait for approval: two places paid (authorized only), one cancelled by the buyer while it waits
            const reserved = reserve(siteB, ids.split.registrationPolicyId, ids.split.ticketTypeId, 2, "split@mkrg.example.test")
            complete(siteB, reserved.token, ["Splitter", "Guest"])
            pay(siteB, reserved.token)
            returned(siteB, reserved.token)
            const reservation = reservationOf(reserved.reference)
            const [first, second] = places(reserved.reference)
            const authorized = row(P, {paymentId: reservation.paymentId}).statusId
            const cancelled = buyerCancel(siteB, reserved.token, [second.registrationId])
            const waiting = row(R, {registrationId: second.registrationId}).refundStatusEnumId
            approve(reservation.orderId)
            waitFor(() => row(R, {registrationId: second.registrationId}).refundStatusEnumId === "ErfRefunded")
            const splitInvoices = billedInvoices(reservation.orderId)
            return {
                paidInvoices,
                paidTotal: paidInvoices.length ? invoiceTotal(paidInvoices[0]) : null,
                paidStatus: paidPayment.statusId,
                paidInvoice: paidInvoices.length ? row("mantle.account.invoice.Invoice", {invoiceId: paidInvoices[0]}) : null,
                again,
                authorized,
                cancelled,
                waiting,
                splitInvoices,
                splitTotal: splitInvoices.length ? invoiceTotal(splitInvoices[0]) : null,
                captured: row(P, {paymentId: reservation.paymentId}).statusId,
                refunds: rows(P, {refundForPaymentId: reservation.paymentId}),
                secondAfter: row(R, {registrationId: second.registrationId}),
                states: states(reserved.reference),
                invoicedActions: rows("mantle.work.registration.EventRegistrationAction", {
                    registrationId: first.registrationId,
                    actionEnumId: "EraInvoiced"
                }).length
            }
        },
        then(r) {
            r.paidInvoices.length == 1 && toDecimal(r.paidTotal).eq(toDecimal("84.80"))
            r.paidStatus == "PmntDelivered"
            // the spec's organizations have no posting set up, so Accounting refuses the invoice's finalization: the invoice and the
            // capture are kept (the finalization in a transaction of its own), the payment left for Accounting to apply
            r.paidInvoice.statusId == "InvoiceInProcess"
            r.again.length == 0
            r.authorized == "PmntAuthorized"
            r.cancelled.registration.places.some(place => place.statusId == "EvrCancelled")
            r.waiting == "ErfRequested"
            r.splitInvoices.length == 1 && toDecimal(r.splitTotal).eq(toDecimal("40.00"))
            r.captured == "PmntDelivered"
            r.refunds.length == 1 && toDecimal(r.refunds[0].amount).eq(toDecimal("40.00"))
            r.secondAfter.refundStatusEnumId == "ErfRefunded" && toDecimal(r.secondAfter.refundPercent).eq(toDecimal("100"))
            r.states == "EvrConfirmed,EvrCancelled"
            r.invoicedActions == 1
        }
    }
)

// follow-up 1 review: an approval whose invoice did not run (here approved without the order's services, so no SECA ran; as a
// capture that failed at the approval) is invoiced by the job while the payment is only authorized, once
feature("the job invoices an approved ticket order its approval did not invoice, and captures its payment", {
    when() {
        freshLimits()
        const reserved = reserve(siteB, ids.split.registrationPolicyId, ids.split.ticketTypeId, 1, "retry@mkrg.example.test")
        complete(siteB, reserved.token, ["Retry"])
        pay(siteB, reserved.token)
        returned(siteB, reserved.token)
        const reservation = reservationOf(reserved.reference)
        system(() => {
            for (const entityName of ["mantle.order.OrderPart", "mantle.order.OrderHeader"])
                for (const value of Array.from(ec.entity.find(entityName).condition({orderId: reservation.orderId}).list())) {
                    value.statusId = "OrderApproved"
                    value.update()
                }
        })
        const before = billedInvoices(reservation.orderId)
        const authorized = row(P, {paymentId: reservation.paymentId}).statusId
        const first = runHolds()
        const second = runHolds()
        const invoices = billedInvoices(reservation.orderId)
        return {
            before,
            authorized,
            first,
            second,
            invoices,
            captured: row(P, {paymentId: reservation.paymentId}).statusId
        }
    },
    then(r) {
        r.before.length == 0
        r.authorized == "PmntAuthorized"
        r.first.invoiced == 1
        r.second.invoiced == 0
        r.invoices.length == 1
        r.captured == "PmntDelivered"
    }
})

feature(
    "a buyer's cancellation follows the accepted terms' rule: its refund before the deadline, none or refused after; staff override with a reason",
    {
        when() {
            freshLimits()
            const reserved = reserve(siteA, ids.terms.registrationPolicyId, ids.terms.ticketTypeId, 3, "terms@mkrg.example.test")
            complete(siteA, reserved.token, ["Rule one", "Rule two", "Rule three"])
            pay(siteA, reserved.token)
            const confirmed = returned(siteA, reserved.token)
            const [one, two, three] = places(reserved.reference)
            const reservation = reservationOf(reserved.reference)
            captured(reservation.paymentId)
            // five days before the start, two days' deadline: half of 42.40 back
            const early = buyerCancel(siteA, reserved.token, [one.registrationId])
            const oneAfter = waitFor(() => {
                const found = row(R, {registrationId: one.registrationId})
                return found.refundStatusEnumId === "ErfRequested" ? null : found
            })
            // the deadline passes (the accepted revision's rule moved past now): refused online, nothing changed
            const terms = {registrationPolicyId: ids.terms.registrationPolicyId, termsRevision: 0}
            const setTerms = values =>
                system(() =>
                    ec.service
                        .sync()
                        .name("update#mantle.work.registration.EventRegistrationTerms")
                        .parameters(Object.assign({}, terms, values))
                        .disableAuthz()
                        .call()
                )
            setTerms({cancelDeadlineHours: 200})
            const lateView = visitor("get#Registration", {siteId: siteA, token: reserved.token})
            const late = buyerCancel(siteA, reserved.token, [two.registrationId])
            const twoState = row(R, {registrationId: two.registrationId}).statusId
            // a rule that allows a late cancellation: cancelled with no refund
            setTerms({lateCancelAllowed: "Y"})
            const lateAllowed = buyerCancel(siteA, reserved.token, [three.registrationId])
            const threeAfter = row(R, {registrationId: three.registrationId})
            // staff refund the second place in full against the rule, with a reason; a stale read refused
            const read = as(users.manager, E + "get#Registration", {registrationId: two.registrationId})
            const staff = as(users.manager, E + "cancel#Registration", {
                registrationId: two.registrationId,
                expectedRevision: read.registration.revision,
                reason: "Organizer moved the date",
                refundPercent: "100"
            })
            const override = rows("mantle.work.registration.EventRegistrationAction", {
                registrationId: two.registrationId,
                actionEnumId: "EraRefundOverride"
            })
            // a change of the rule after publication is a new terms revision; the accepted one stays the registrations'
            const offerKeys = {registrationPolicyId: ids.terms.registrationPolicyId}
            const changed = as(users.manager, E + "store#RegistrationPolicy", {
                registrationPolicyId: ids.terms.registrationPolicyId,
                expectedRevision: entityRevisionOf("mantle.work.registration.EventRegistrationPolicy", offerKeys),
                refundPercent: "25"
            })
            const badPercent = as(users.manager, E + "store#RegistrationPolicy", {
                registrationPolicyId: ids.terms.registrationPolicyId,
                expectedRevision: entityRevisionOf("mantle.work.registration.EventRegistrationPolicy", {
                    registrationPolicyId: ids.terms.registrationPolicyId
                }),
                refundPercent: "120"
            })
            // the staff cancellation's refund is handed over by the job here, as the cancellation feature above has it
            runHolds()
            return {
                confirmed,
                early,
                oneAfter,
                lateView,
                late,
                twoState,
                lateAllowed,
                threeAfter,
                read,
                staff,
                override,
                changed,
                badPercent,
                termsRevision: row("mantle.work.registration.EventRegistrationPolicy", {
                    registrationPolicyId: ids.terms.registrationPolicyId
                }).termsRevision,
                refunds: rows(P, {refundForPaymentId: reservation.paymentId})
                    .map(refund => toDecimal(refund.amount).toString())
                    .sort()
                    .join()
            }
        },
        then(r) {
            r.confirmed.registration.state == "confirmed"
            r.confirmed.registration.cancelRule.includes("up to 2 days before the event starts") &&
                r.confirmed.registration.cancelRule.includes("50%") &&
                r.confirmed.registration.cancelRule.includes("not available online")
            r.early.registration && toDecimal(r.oneAfter.refundPercent).eq(toDecimal("50"))
            r.oneAfter.refundStatusEnumId == "ErfRefunded"
            r.lateView.registration.canCancel == false && r.lateView.registration.places.every(place => !place.canCancel)
            r.late.kind == "Conflict" && r.late.message.includes("CANCELLATION_CLOSED")
            r.twoState == "EvrConfirmed"
            r.lateAllowed.registration && r.threeAfter.statusId == "EvrCancelled"
            r.threeAfter.refundStatusEnumId == "ErfNone" && toDecimal(r.threeAfter.refundPercent).eq(toDecimal("0"))
            r.read.termsRefundPercent != null && toDecimal(r.read.termsRefundPercent).eq(toDecimal("0"))
            r.staff.refusal == "" &&
                toDecimal(r.staff.refundPercent).eq(toDecimal("100")) &&
                r.staff.refundStatusEnumId == "ErfRequested"
            r.override.length == 1 && r.override[0].reason.includes("Organizer moved the date")
            r.refunds == "21.2,42.4"
            r.changed.refusal == "" && r.termsRevision == 1
            code(r.badPercent) == "REFUND_INVALID"
        }
    }
)

feature(
    "one entry code per revision, shown again alike from its keyed derivation, never stored; a staff reissue or a correction changes it",
    {
        when() {
            freshLimits()
            const placesJs = ec.resource.script("component://mr-mantle/service/mantle/work/EventRegistrationPlaces.js")
            const reserved = reserve(siteA, ids.code.registrationPolicyId, ids.code.ticketTypeId, 1, "code@mkrg.example.test")
            complete(siteA, reserved.token, ["Code holder"])
            const place = places(reserved.reference)[0]
            const show = () =>
                visitor("get#Registration", {
                    siteId: siteA,
                    token: reserved.token,
                    showTicket: place.registrationId,
                    operationId: key()
                }).registration?.ticket
            const first = show()
            const second = show()
            const stored = row(R, {registrationId: place.registrationId})
            const actions = rows("mantle.work.registration.EventRegistrationAction", {registrationId: place.registrationId})
            const found = system(() => placesJs.registrationOfCode(first.code))
            const foundTyped = system(() => placesJs.registrationOfCode(first.code.toLowerCase()))
            // a reader may not reissue; a stale read refused; the manager's reissue raises the revision
            const reader = as(users.reader, E + "reissue#RegistrationCode", {
                registrationId: place.registrationId,
                expectedRevision: entityRevision(place.registrationId),
                reason: "Lost"
            })
            const stale = as(users.manager, E + "reissue#RegistrationCode", {
                registrationId: place.registrationId,
                expectedRevision: 1,
                reason: "Lost"
            })
            const reissued = as(users.manager, E + "reissue#RegistrationCode", {
                registrationId: place.registrationId,
                expectedRevision: entityRevision(place.registrationId),
                reason: "Ticket shared by mistake"
            })
            const third = show()
            const oldFound = system(() => placesJs.registrationOfCode(first.code))
            const newFound = system(() => placesJs.registrationOfCode(third.code))
            // a correction of the attendee: the next code is another revision's
            const corrected = as(users.manager, E + "correct#Registration", {
                registrationId: place.registrationId,
                expectedRevision: entityRevision(place.registrationId),
                attendeeName: "Code Holder",
                reason: "Spelling"
            })
            const fourth = show()
            const thirdAfter = system(() => placesJs.registrationOfCode(third.code))
            const staffView = as(users.manager, E + "get#Registration", {registrationId: place.registrationId})
            const offer = row("mantle.work.registration.EventRegistrationPolicy", {
                registrationPolicyId: ids.code.registrationPolicyId
            })
            return {
                first,
                second,
                stored,
                actions,
                found,
                foundTyped,
                thirdAfter,
                reader,
                stale,
                reissued,
                third,
                oldFound,
                newFound,
                corrected,
                fourth,
                staffView,
                offer
            }
        },
        then(r) {
            !!r.first?.code && r.first.code == r.second.code && r.first.code.startsWith("EV") && r.first.code.length == 26
            r.stored.credentialRevision == 1 && r.stored.credentialDigest != r.first.code
            !JSON.stringify(r.stored).includes(r.first.code) && !JSON.stringify(r.actions).includes(r.first.code)
            r.actions.filter(action => action.actionEnumId == "EraTicketShown").length == 2
            r.found?.registrationId == r.stored.registrationId && r.foundTyped?.registrationId == r.stored.registrationId
            code(r.reader) == "PERMISSION_DENIED"
            code(r.stale) == "STALE_REVISION"
            r.reissued.refusal == "" && r.reissued.credentialRevision == 2
            r.third.code != r.first.code && r.oldFound == null && r.newFound?.registrationId == r.stored.registrationId
            r.corrected.refusal == "" && r.fourth.code != r.third.code && r.thirdAfter == null
            !!r.offer.entryCodeKey && !JSON.stringify(r.staffView).includes(String(r.offer.entryCodeKey))
            r.staffView.canReissue == true
        }
    }
)

// Marketing follow-up 5: Register's payment start forwards a remote frontend's visitor key as Shop's submit does. Its digest is
// kept with the ticket order only where Marketing keeps the key (the seller's policy, never a buyer who withdrew tracking), a
// malformed key dropped and never refused, a repeat start the same attempt with nothing changed; read again before place#Order
// (the policy ended before the provider's return clears it); and the placed order is attributed by it.
feature("a ticket payment's visitor key: its digest kept only where allowed, read again before placement, attributed by it", {
    when() {
        freshLimits()
        const policyId = prefix + "_MKT_POLICY"
        const keyOf = n => "MkrgVisitorKey" + n + "_0123456789ab"
        const offer = ids.visitor
        const reservationDone = (email, before) => {
            const reserved = reserve(siteA, offer.registrationPolicyId, offer.ticketTypeId, 1, email)
            if (before) before(reservationOf(reserved.reference))
            complete(siteA, reserved.token, ["Visitor " + email.split("@")[0]])
            return reserved
        }
        const payWith = (token, visitorKey) =>
            visitor("start#RegistrationPayment", {
                siteId: siteA,
                token,
                priceKey: visitor("get#Registration", {siteId: siteA, token}).registration?.priceKey,
                operationId: key(),
                visitorKey
            })
        const kept = reference =>
            row("mantle.order.OrderHeader", {orderId: reservationOf(reference).orderId}).marketingVisitorKeyHash
        const r = {digest: String(ec.resource.digestText("mkt-visitor:" + keyOf(2), "sha256")), key: keyOf(2)}
        // A keeps no visitor keys by policy and the buyer has not allowed tracking: nothing kept
        const none = reservationDone("vk-none@mkrg.example.test")
        r.noneStart = payWith(none.token, keyOf(1))
        r.none = kept(none.reference)
        // A's policy keeps visitor keys; a remote visitor's click of a campaign's link by the key, an hour ago
        system(() => {
            make("mantle.marketing.campaign.MarketingPolicy", {
                marketingPolicyId: policyId,
                organizationPartyId: orgA,
                fromDate: new Date(Date.now() - 60000),
                visitorKeys: "Y"
            })
            make("mantle.marketing.campaign.MarketingCampaign", {
                marketingCampaignId: prefix + "_CAMPAIGN",
                organizationPartyId: orgA,
                campaignName: "Visitor key campaign"
            })
            make("mantle.marketing.tracking.TrackingCode", {
                trackingCodeId: prefix + "_LINK",
                marketingCampaignId: prefix + "_CAMPAIGN",
                organizationPartyId: orgA,
                trackingCodeTypeEnumId: "EXTERNAL",
                publicCode: prefix + "VKCODE",
                trackableLifetime: 30
            })
            make("mantle.marketing.tracking.MarketingTrackingEvent", {
                trackingEventId: prefix + "_EV_VK",
                organizationPartyId: orgA,
                siteId: siteA,
                trackingCodeId: prefix + "_LINK",
                marketingCampaignId: prefix + "_CAMPAIGN",
                eventKindEnumId: "MteClick",
                visitorKeyHash: r.digest,
                eventDate: new Date(Date.now() - 3600000)
            })
        })
        try {
            // kept as its digest; a repeat start with another key answers the same attempt and changes nothing; placed and attributed
            const paid = reservationDone("vk-kept@mkrg.example.test")
            r.started = payWith(paid.token, keyOf(2))
            r.kept = kept(paid.reference)
            r.again = payWith(paid.token, keyOf(3))
            r.afterAgain = kept(paid.reference)
            r.result = returned(siteA, paid.token)
            r.placed = row("mantle.order.OrderHeader", {orderId: reservationOf(paid.reference).orderId})
            // the decision is the placement SECA's (tx-commit), run on a service worker once the placement commits: read until
            // it is there (follow-up 8: read at once, a loaded run found none yet)
            const decided = () =>
                rows("mantle.marketing.tracking.MarketingOutcomeLink", {orderId: r.placed.orderId}).filter(link => !link.thruDate)
            r.attribution = waitFor(() => decided().length > 0) ? decided() : []
            // a key not of the cookie's form: dropped, the payment started
            const bad = reservationDone("vk-bad@mkrg.example.test")
            r.badStart = payWith(bad.token, "not a key; drop table")
            r.bad = kept(bad.reference)
            // a buyer who withdrew tracking with A: never kept, even under A's policy
            const withdrawn = reservationDone("vk-withdrawn@mkrg.example.test", reservation =>
                system(() =>
                    make("mantle.party.PartyConsent", {
                        partyId: reservation.buyerPartyId,
                        purposeEnumId: "PcpTracking",
                        statusId: "PconWithdrawn",
                        organizationPartyId: orgA,
                        consentDate: new Date(Date.now() - 60000),
                        sourceEnumId: "PcsForm"
                    })
                )
            )
            r.withdrawnStart = payWith(withdrawn.token, keyOf(4))
            r.withdrawn = kept(withdrawn.reference)
            // kept at the start, then A's policy ends before the provider's return: the placement keeps no digest
            const late = reservationDone("vk-late@mkrg.example.test")
            payWith(late.token, keyOf(5))
            r.lateKept = kept(late.reference)
            system(() =>
                ec.service
                    .sync()
                    .name("update#mantle.marketing.campaign.MarketingPolicy")
                    .parameters({marketingPolicyId: policyId, thruDate: new Date()})
                    .disableAuthz()
                    .call()
            )
            r.lateResult = returned(siteA, late.token)
            r.latePlaced = row("mantle.order.OrderHeader", {orderId: reservationOf(late.reference).orderId})
        } finally {
            system(() =>
                ec.entity.find("mantle.marketing.campaign.MarketingPolicy").condition({marketingPolicyId: policyId}).deleteAll()
            )
        }
        return r
    },
    then(r) {
        r.noneStart.payment.paymentState == "pending" && r.none == null
        // the digest is the events' digest, never the raw key
        r.started.payment.paymentState == "pending" && r.kept == r.digest && r.kept != r.key
        r.again.payment.alreadyStarted == true && r.afterAgain == r.digest
        r.result.registration.state == "confirmed" && r.placed.placedDate != null && r.placed.marketingVisitorKeyHash == r.digest
        // the ticket order, with no local visit, attributed by the key's digest
        r.attribution.length == 1 && r.attribution[0].basisEnumId == "MobTrackingEvent"
        r.attribution[0].trackingEventId == prefix + "_EV_VK" && r.attribution[0].marketingCampaignId == prefix + "_CAMPAIGN"
        r.badStart.payment.paymentState == "pending" && r.bad == null
        r.withdrawnStart.payment.paymentState == "pending" && r.withdrawn == null
        r.lateKept == String(ec.resource.digestText("mkt-visitor:MkrgVisitorKey5_0123456789ab", "sha256"))
        r.lateResult.registration.state == "confirmed" && r.latePlaced.placedDate != null
        r.latePlaced.marketingVisitorKeyHash == null
    }
})

// SEC-PSS-61 (the owner's decision of Nov 16, 2026): an address typed on the public page names nobody until it is confirmed. A visitor's
// reservation for a directory party's address, and an attendee typed with another's, are new people with the names and addresses
// typed, never those parties; a signed-in account whose own verified address is typed reserves as its own party.
const personWithAddress = (partyId, firstName, address) => {
    make("mantle.party.Party", {partyId, partyTypeEnumId: "PtyPerson"})
    make("mantle.party.Person", {partyId, firstName, lastName: "Stored"})
    const contactMechId = make("mantle.party.contact.ContactMech", {contactMechTypeEnumId: "CmtEmailAddress", infoString: address})
        .contactMechId
    make("mantle.party.contact.PartyContactMech", {partyId, contactMechId, contactMechPurposeId: "EmailPrimary", fromDate: new Date(0)})
}
const emailOf = partyId =>
    rows("mantle.party.contact.PartyContactMech", {partyId})
        .map(mech => row("mantle.party.contact.ContactMech", {contactMechId: mech.contactMechId})?.infoString)
        .join()
feature("a typed address attaches no reservation or attendee to the directory party that has it; a verified account's own does", {
    when() {
        const known = prefix + "_KNOWN",
            guest = prefix + "_KNOWN_GUEST",
            own = prefix + "_OWN"
        system(() => {
            personWithAddress(known, "Known", "known@mkrg.example.test")
            personWithAddress(guest, "Guest", "guest.known@mkrg.example.test")
            personWithAddress(own, "Own", "own@mkrg.example.test")
            make("moqui.security.UserAccount", {userId: own, username: own, partyId: own, emailAddress: "own@mkrg.example.test",
                currentPassword: "16ac58bbfa332c1c55bd98b53e60720bfa90d394", passwordHashType: "SHA"})
            make("moqui.security.public.VerifiedAddress", {userId: own, emailAddress: "own@mkrg.example.test", verifiedAt: new Date()})
        })
        const typed = reserve(siteA, ids.match.registrationPolicyId, ids.match.ticketTypeId, 2, "Known@mkrg.example.test")
        const completed = throughReceipt(siteA, visitor("complete#Registration", {siteId: siteA, token: typed.token, acceptTerms: "Y",
            termsRevision: 0, operationId: key(), attendees: JSON.stringify([{name: "Spec buyer", email: "known@mkrg.example.test"},
                {name: "Typed guest", email: "guest.known@mkrg.example.test"}])}))
        const typedPlaces = places(typed.reference)
        // signed in: the account's own verified address
        login(own)
        let mine
        try {
            ec.message.pushErrors()
            mine = ec.service.sync().throwOnError(true).name(PORTAL + "reserve#Registration").parameters({input: {siteId: siteA,
                registrationPolicyId: ids.match.registrationPolicyId, lines: JSON.stringify([{ticketTypeId: ids.match.ticketTypeId,
                quantity: 1}]), buyerName: "Own buyer", buyerEmail: "own@mkrg.example.test", operationId: key()}}).call().result
        } finally {
            ec.message.clearErrors()
            ec.message.popErrors()
            login("john.doe")
        }
        return {known, guest, own, typed: reservationOf(typed.reference), completed, typedPlaces, mine: reservationOf(mine.registration.reference)}
    },
    then(r) {
        r.completed.registration.state == "confirmed"
        r.typed.buyerPartyId != r.known
        row("mantle.party.Person", {partyId: r.typed.buyerPartyId}).firstName == "Spec buyer"
        emailOf(r.typed.buyerPartyId) == "known@mkrg.example.test"
        r.typedPlaces[0].attendeePartyId == r.typed.buyerPartyId
        r.typedPlaces[1].attendeePartyId != r.guest && r.typedPlaces[1].attendeePartyId != r.typed.buyerPartyId
        emailOf(r.typedPlaces[1].attendeePartyId) == "guest.known@mkrg.example.test"
        rows("mantle.party.ExternalAccessCapability", {recordId: r.typed.reservationId}).every(cap => cap.partyId == r.typed.buyerPartyId)
        r.mine.buyerPartyId == r.own
    }
})

// SEC-PSS-61 (the owner's call of Nov 16, 2026): a signed-in account whose verified address is the reservation's typed buyer (or an
// attendee's typed) address claims that person while the event is still to come: the reservation and its places move to the
// account's party, the person is marked merged, and the links already mailed keep working. An unverified account and one of
// another address claim nothing.
const accountWith = (partyId, address, verified) =>
    system(() => {
        personWithAddress(partyId, "Account", address)
        make("moqui.security.UserAccount", {userId: partyId, username: partyId, partyId, emailAddress: address,
            currentPassword: "16ac58bbfa332c1c55bd98b53e60720bfa90d394", passwordHashType: "SHA"})
        if (verified) make("moqui.security.public.VerifiedAddress", {userId: partyId, emailAddress: address, verifiedAt: new Date()})
        return partyId
    })
// a PASS operation as a signed-in account: its result, or {kind, message} of its refusal
function asAccount(username, service, input) {
    login(username)
    ec.message.pushErrors()
    try {
        return ec.service.sync().throwOnError(true).name(PORTAL + service).parameters({input}).call().result
    } catch (error) {
        return {kind: error.moquiErrorKind || "error", message: String(error.message)}
    } finally {
        ec.message.clearErrors()
        ec.message.popErrors()
        login("john.doe")
    }
}
feature("a verified account claims a live reservation typed with its address, and the mailed links still work; others claim nothing", {
    when() {
        const buyerAddress = "claim@mkrg.example.test", guestAddress = "claim.guest@mkrg.example.test"
        const reserved = reserve(siteA, ids.claim.registrationPolicyId, ids.claim.ticketTypeId, 2, buyerAddress)
        const completed = throughReceipt(siteA, visitor("complete#Registration", {siteId: siteA, token: reserved.token,
            acceptTerms: "Y", termsRevision: 0, operationId: key(),
            attendees: JSON.stringify([{name: "Spec buyer"}, {name: "Claim guest", email: guestAddress}])}))
        const before = reservationOf(reserved.reference)
        const [first, second] = places(reserved.reference)
        // the buyer's mailed ticket: its link's token, as sent
        const delivery = rows("mantle.party.MessageDelivery", {eventKey: "evreg-ticket:" + first.registrationId})[0]
        const mailed = system(() => ec.service.sync().name(E + "build#RegistrationDelivery").parameters({deliveryId: delivery.deliveryId})
            .disableAuthz().call())
        const mailedToken = (/Registration\?token=([A-Za-z0-9_-]+)/.exec(String(mailed.bodyText)) || [])[1]
        // the owner's account before its address is verified, and a verified account of another address
        const owner = accountWith(prefix + "_CLAIM_OWNER", buyerAddress, false)
        const otherAddress = accountWith(prefix + "_CLAIM_OTHER", "other.claim@mkrg.example.test", true)
        const guestOwner = accountWith(prefix + "_CLAIM_GUEST", guestAddress, true)
        asAccount(owner, "get#Registration", {siteId: siteA, token: reserved.token})
        asAccount(otherAddress, "get#Registration", {siteId: siteA, token: reserved.token})
        const refused = reservationOf(reserved.reference).buyerPartyId
        system(() => make("moqui.security.public.VerifiedAddress", {userId: owner, emailAddress: buyerAddress, verifiedAt: new Date()}))
        // the owner by the page's token; the guest's account by the reservation's reference alone claims its place, though the
        // reservation stays the buyer's to read
        const claimedView = asAccount(owner, "get#Registration", {siteId: siteA, token: reserved.token})
        const guestView = asAccount(guestOwner, "get#Registration", {siteId: siteA, reservationId: reserved.reference})
        const after = reservationOf(reserved.reference)
        const placesAfter = places(reserved.reference)
        // the links as sent, opened by anyone after the claim; the owner's own account reaches it by its reference
        const byMail = visitor("get#Registration", {siteId: siteA, token: mailedToken})
        const byPage = visitor("get#Registration", {siteId: siteA, token: reserved.token})
        const byAccount = asAccount(owner, "get#Registration", {siteId: siteA, reservationId: reserved.reference})
        const again = asAccount(otherAddress, "get#Registration", {siteId: siteA, reservationId: reserved.reference})
        return {completed, before, first, second, mailedToken, refused, owner, guestOwner, claimedView, guestView, after, placesAfter,
            byMail, byPage, byAccount, again, buyerParty: row("mantle.party.Party", {partyId: before.buyerPartyId}),
            guestParty: row("mantle.party.Party", {partyId: second.attendeePartyId}),
            capabilities: rows("mantle.party.ExternalAccessCapability", {recordType: "EventRegistration", recordId: reserved.reference})}
    },
    then(r) {
        r.completed.registration.state == "confirmed"
        !!r.mailedToken && r.mailedToken != null
        r.refused == r.before.buyerPartyId
        !r.claimedView.kind && r.claimedView.registration.reference == r.before.reservationId
        r.guestView.kind == "NotFound"
        r.after.buyerPartyId == r.owner
        r.placesAfter[0].buyerPartyId == r.owner && r.placesAfter[0].attendeePartyId == r.owner
        r.placesAfter[1].attendeePartyId == r.guestOwner
        r.buyerParty.mergedToPartyId == r.owner && r.buyerParty.disabled == "Y"
        r.guestParty.mergedToPartyId == r.guestOwner
        r.capabilities.length >= 2 && r.capabilities.every(cap => cap.partyId == r.owner)
        !r.byMail.kind && r.byMail.registration.reference == r.before.reservationId && r.byMail.registration.state == "confirmed"
        !r.byPage.kind && r.byPage.registration.reference == r.before.reservationId
        !r.byAccount.kind && r.byAccount.registration.reference == r.before.reservationId
        r.again.kind == "NotFound"
    }
})

function entityRevisionOf(entityName, keys) {
    return ec.resource
        .script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
        .ms(row(entityName, keys).lastUpdatedStamp)
}

function entityRevision(registrationId) {
    return ec.resource
        .script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
        .ms(row(R, {registrationId}).lastUpdatedStamp)
}

feature("SEC-PSS-88: an offer's places are counted for a requester and a buyer address, tickets a place for an attendee address", {
    when() {
        freshLimits()
        const offer = system(() => offerFor(orgA, siteA, "BOUNDED", 40, [{priceSourceEnumId: "EtpFree"}]))
        const office = accountWith(prefix + "_OFFICE", "office@mkrg.example.test", true)
        const reserveAs = (username, quantity, email) => {
            const out = asAccount(username, "reserve#Registration", {
                siteId: siteA,
                registrationPolicyId: offer.registrationPolicyId,
                lines: JSON.stringify([{ticketTypeId: offer.ticketTypeId, quantity}]),
                buyerName: "Spec buyer",
                buyerEmail: email,
                operationId: key()
            })
            return out.kind ? out : {reference: out.registration.reference, token: out.token}
        }
        const attend = (token, people, acceptTerms = "Y") =>
            visitor("complete#Registration", {
                siteId: siteA,
                token,
                attendees: JSON.stringify(people),
                acceptTerms,
                termsRevision: 0,
                operationId: key()
            })
        return withConf("mantle@marketing-reservations-per-offer", "3", () =>
            withConf("mantle@marketing-tickets-per-address", "2", () => {
                // the places, not the reservations, are counted: two, then two more past the requester's three
                const first = reserve(siteA, offer.registrationPolicyId, offer.ticketTypeId, 2, "bounded.a@mkrg.example.test")
                const second = reserve(siteA, offer.registrationPolicyId, offer.ticketTypeId, 2, "bounded.b@mkrg.example.test")
                // a verified account behind the same network address is counted as itself; the buyer address's places
                // still are: two more for bounded.a pass its three
                const sameAddress = reserveAs(office, 2, "bounded.a@mkrg.example.test")
                const own = reserveAs(office, 1, "office@mkrg.example.test")
                // a completion that fails spends no ticket of its addresses; each place is one ticket of its address
                const failed = attend(first.token, [
                    {name: "Tess Target", email: "target@mkrg.example.test"},
                    {name: "", email: "target@mkrg.example.test"}
                ])
                const tickets = attend(first.token, [
                    {name: "Tess Target", email: "target@mkrg.example.test"},
                    {name: "Tom Target", email: "target@mkrg.example.test"}
                ])
                const third = attend(own.token, [{name: "Tess Target", email: "target@mkrg.example.test"}])
                return {first, second, sameAddress, own, failed, tickets, third, ownState: states(own.reference)}
            })
        )
    },
    then(r) {
        !!r.first.token == true
        r.second.kind == "Tarpit"
        r.sameAddress.kind == "Tarpit"
        !!r.own.token == true
        !!r.failed.kind == true
        r.tickets.registration.state != null
        r.third.kind == "Tarpit"
        r.ownState == "EvrHeld"
    }
})

feature("SEC-PSS-88: a free place is confirmed only for a verified buyer or by the receipt's link mailed to the buyer's address", {
    when() {
        freshLimits()
        const offer = system(() => offerFor(orgA, siteA, "ADDRESS", 10, [{priceSourceEnumId: "EtpFree"}]))
        // a visitor's: held, the page's own token confirms nothing, the receipt's link mailed to the buyer does
        const reserved = reserve(siteA, offer.registrationPolicyId, offer.ticketTypeId, 1, "confirm.me@mkrg.example.test")
        const completed = completeOnly(siteA, reserved.token, ["Confirm Me"])
        const byPage = visitor("get#Registration", {siteId: siteA, token: reserved.token})
        const delivery = rows("mantle.party.MessageDelivery", {eventKey: "evreg-receipt:" + reserved.reference + ":held"})[0]
        const mailed = system(() =>
            ec.service.sync().name(E + "build#RegistrationDelivery").parameters({deliveryId: delivery.deliveryId}).disableAuthz().call()
        )
        const mailedToken = (/Registration\?token=([A-Za-z0-9_-]+)/.exec(String(mailed.bodyText)) || [])[1]
        const byMail = visitor("get#Registration", {siteId: siteA, token: mailedToken})
        // a verified signed-in account buying for its own address: confirmed at once
        const buyer = accountWith(prefix + "_FREE_BUYER", "free.buyer@mkrg.example.test", true)
        const mine = asAccount(buyer, "reserve#Registration", {
            siteId: siteA,
            registrationPolicyId: offer.registrationPolicyId,
            lines: JSON.stringify([{ticketTypeId: offer.ticketTypeId, quantity: 1}]),
            buyerName: "Free buyer",
            buyerEmail: "free.buyer@mkrg.example.test",
            operationId: key()
        })
        const mineCompleted = asAccount(buyer, "complete#Registration", {
            siteId: siteA,
            token: mine.token,
            attendees: JSON.stringify([{name: "Free buyer"}]),
            acceptTerms: "Y",
            termsRevision: 0,
            operationId: key()
        })
        return {completed, byPage, mailedToken, byMail, held: states(reserved.reference), mineCompleted}
    },
    then(r) {
        r.completed.registration.state == "held"
        r.completed.registration.stateText == "Held: confirm it with the link we emailed you"
        r.byPage.registration.state == "held"
        !!r.mailedToken == true
        r.byMail.registration.state == "confirmed"
        r.held == "EvrConfirmed"
        r.mineCompleted.registration.state == "confirmed"
    }
})

feature("SEC-PSS-89: the provider's return looks a payment up at once the first time, then paced; the buyer's account calls count", {
    when() {
        // a payment whose lookup stays pending at the provider
        system(() =>
            make("mantle.account.method.PaymentGatewayConfig", {
                paymentGatewayConfigId: prefix + "_PENDING",
                paymentGatewayTypeEnumId: "PgtTest",
                description: "Registration spec, still pending",
                authorizeServiceName: "mantle.account.PaymentTestServices.hostedAuthorize#PaymentAuthorization",
                detailsServiceName: "mantle.account.PaymentTestServices.alwaysPending#PaymentDetails"
            })
        )
        freshLimits()
        const offer = system(() =>
            offerFor(orgA, siteA, "PACED", 5, [{priceSourceEnumId: "EtpProduct", productId: prefix + "_SEAT_A"}])
        )
        const reserved = reserve(siteA, offer.registrationPolicyId, offer.ticketTypeId, 1, "paced@mkrg.example.test")
        complete(siteA, reserved.token, ["Paced payer"])
        pay(siteA, reserved.token)
        const paymentId = reservationOf(reserved.reference).paymentId
        system(() => {
            call("update#mantle.account.payment.Payment", {paymentId, paymentGatewayConfigId: prefix + "_PENDING"})
            call("update#mantle.account.payment.PortalPaymentAttempt", {paymentId, checkCount: 0, lastCheckDate: null})
        })
        const checks = () => Number(row("mantle.account.payment.PortalPaymentAttempt", {paymentId}).checkCount || 0)
        returned(siteA, reserved.token)
        const first = checks()
        returned(siteA, reserved.token)
        returned(siteA, reserved.token)
        // the signed-in buyer reaching its own reservation by its id: each call counts against the requester as a capability's
        const buyer = accountWith(prefix + "_PACED_BUYER", "paced.buyer@mkrg.example.test", true)
        const mine = asAccount(buyer, "reserve#Registration", {
            siteId: siteA,
            registrationPolicyId: offer.registrationPolicyId,
            lines: JSON.stringify([{ticketTypeId: offer.ticketTypeId, quantity: 1}]),
            buyerName: "Paced buyer",
            buyerEmail: "paced.buyer@mkrg.example.test",
            operationId: key()
        })
        const lookups = () => {
            const requesterKey = ec.resource.script("component://framework/service/org/moqui/public/Account.js").requesterKey()
            const bucketId = ec.user.singleUseCodeHash("mkt-token:" + requesterKey + ":" + Math.floor(Date.now() / 600000))
            return Number(row("moqui.security.public.AccountAttempt", {bucketId})?.attemptCount || 0)
        }
        const before = lookups()
        const read = asAccount(buyer, "get#Registration", {siteId: siteA, reservationId: mine.registration.reference})
        return {first, after: checks(), read, counted: lookups() - before}
    },
    then(r) {
        r.first == 1
        r.after == 1
        r.read.registration.reference != null
        r.counted == 1
    }
})
