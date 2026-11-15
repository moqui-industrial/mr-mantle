// Event registrations: places, their states and their staff screens (mantle.work.EventRegistrationServices, E of IronStone Marketing
// design §14.2; design §9 RegistrationSetup's order rules, Registrations, RegistrationDetail, §13 Register and Registration, §15.3;
// impl-marketing P17). CC0 1.0 Universal plus Grant of Patent License.
//
// - A reservation (EventReservation) is one request for places on a published offer, a visitor's on PASS Register or a staff entry:
//   its buyer, its request key (a repeat answers the first; the same key with other values is refused) and one EventRegistration
//   per attendee. Under the offer's row lock and then its ticket types' (the lock store#RegistrationPolicy and store#TicketType take,
//   P16 review), the occurrence's seats and each ticket's places are taken together: every place held (its hold ending after the
//   offer's hold minutes) or, when they do not all fit and the waitlist is on and under its limit, every place waitlisted, taking
//   no seat; else CAPACITY_UNAVAILABLE.
// - complete: each attendee named, the offer's questions answered per attendee or once for the buyer (Commons' accept#Submission on
//   the offer's own publication, the response kept on the registration), and the terms accepted: the revision accepted is kept on
//   each registration with the words of that revision (EventRegistrationTerms, written once a revision; P16 review). A free
//   reservation confirms then, still under the lock; a paid one goes to payment (EventRegistrationPayments.js).
// - States follow the order: payment received holds the place with no end (pending), the order's approval confirms it, the order's
//   cancellation cancels it (handle#OrderStatus, a SECA on the order's status); a payment that succeeds after the hold ended takes
//   no seat (review). A cancellation releases the place once (its state changes once under the lock), revokes its entry code and
//   hands a paid place's refund to Accounting (EventRegistrationPayments.js), shown pending until the provider's result; then the
//   first waiting reservation that fits is offered whole (FIFO by its waitlist time, then id; none split, none passed) with a hold
//   of its own, or confirmed at once when it is completed and free.
// - The entry code is never kept: its digest and revision are. It is one code per revision, derived again whenever it is shown (a
//   ticket notice, Send again, Show my entry code) from a keyed digest of the registration and its revision with the offer's secret
//   (EventRegistrationPolicy.entryCodeKey, encrypted by the server's key); a correction, a substitution, a cancellation or a staff
//   reissue raises the revision, so the earlier code stops matching (follow-up 1; §4 Nov 15, the user's call).
// - A cancellation follows the cancellation rule of the terms the registration accepted (follow-up 1): a confirmed place is cancelled
//   online until the rule's deadline for its refund percentage, after it with no refund where the rule allows it, else not online;
//   a place not yet confirmed is refunded in full; staff may set another percentage with a reason, recorded as its own action.
// - Staff services ask MARKETING_EVENT_MANAGE in the offer's organization (another organization's registration answers as a missing
//   one) and read and write with artifact authorization off below that check; the portal (MarketingPortal.js) reaches the same
//   functions only after its own checks of the site, the offer's publication and the visitor's capability.
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const marketingAccess = ec.resource.script("component://mr-mantle/service/mantle/marketing/MarketingAccess.js")
const setup = () => ec.resource.script("component://mr-mantle/service/mantle/work/EventRegistrations.js")
const payments = () => ec.resource.script("component://mr-mantle/service/mantle/work/EventRegistrationPayments.js")
const notices = () => ec.resource.script("component://mr-mantle/service/mantle/work/EventRegistrationNotices.js")
const publications = () => ec.resource.script("component://mr-mantle/service/mantle/party/FormPublication.js")
const {find, one, rows, call, denied, ms} = lib

const POLICY = "mantle.work.registration.EventRegistrationPolicy"
const TICKET = "mantle.work.registration.EventTicketType"
const REGISTRATION = "mantle.work.registration.EventRegistration"
const RESERVATION = "mantle.work.registration.EventReservation"
const ACTION = "mantle.work.registration.EventRegistrationAction"
const TERMS = "mantle.work.registration.EventRegistrationTerms"
const WORK_EFFORT = "mantle.work.effort.WorkEffort"
const PUBLICATION = "mantle.party.FormPublication"
// the places that count against capacity (P16's SEAT_STATES), the ones still alive, and the ones a cancellation ends
const LIVE_STATES = ["EvrHeld", "EvrPending", "EvrConfirmed", "EvrWaitlisted", "EvrReview"]
const stateTexts = {
    EvrHeld: "Held",
    EvrPending: "Payment received, awaiting the organizer's confirmation",
    EvrConfirmed: "Confirmed",
    EvrWaitlisted: "Waitlisted",
    EvrExpired: "Hold ended",
    EvrCancelled: "Cancelled",
    EvrReview: "Paid after the hold ended: under review"
}
const stateColors = {
    EvrHeld: "warning",
    EvrPending: "info",
    EvrConfirmed: "positive",
    EvrWaitlisted: "purple",
    EvrExpired: "grey-7",
    EvrCancelled: "grey-7",
    EvrReview: "negative"
}
const limits = {places: 10, name: 100, address: 254, reason: 255, find: 500, batch: 200}
const MINUTE = 60000

const blank = value => value == null || String(value).trim() === ""
const text = value => (blank(value) ? null : String(value).trim())
const nowMs = () => Number(ms(ec.user.nowTimestamp))
const L = words => ec.l10n.localize(words)
const emailPattern =
    /^[^\s@<>()[\],;:"\\]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/
const partyName = partyId => {
    if (!partyId) return ""
    const person = one("mantle.party.Person", {partyId})
    if (person) return [person.firstName, person.lastName].filter(Boolean).join(" ") || partyId
    return one("mantle.party.Organization", {partyId})?.organizationName || partyId
}
const userText = userId => (userId ? one("moqui.security.UserAccount", {userId})?.userFullName || userId : "")
const enumText = enumId => (enumId ? one("moqui.basic.Enumeration", {enumId})?.description || enumId : "")
const holdLive = row => row.statusId === "EvrHeld" && (row.holdExpireDate == null || ms(row.holdExpireDate) > nowMs())
const occupies = row => holdLive(row) || row.statusId === "EvrPending" || row.statusId === "EvrConfirmed"

// ===== scope =====
function manageScope() {
    const userScope = marketingAccess.scope()
    marketingAccess.requireCapability(userScope, "eventManage")
    return userScope
}
const unavailable = id => denied("RECORD_UNAVAILABLE", "Registration " + (id || "") + " is not available")
// A registration of the scope (by its offer's organization); a missing one and another organization's alike.
function registrationOf(userScope, registrationId) {
    const row = blank(registrationId) ? null : one(REGISTRATION, {registrationId: text(registrationId)})
    const policy = row ? one(POLICY, {registrationPolicyId: row.registrationPolicyId}) : null
    if (!row || !policy || !marketingAccess.covers(userScope, policy.organizationPartyId)) unavailable(registrationId)
    return {row, policy}
}
function offerOf(userScope, registrationPolicyId) {
    const policy = blank(registrationPolicyId) ? null : one(POLICY, {registrationPolicyId: text(registrationPolicyId)})
    if (!policy || !marketingAccess.covers(userScope, policy.organizationPartyId))
        denied("RECORD_UNAVAILABLE", "Registration offer " + (registrationPolicyId || "") + " is not available")
    return policy
}
// The offer's row lock, then its ticket types' in id order: the order store#RegistrationPolicy and store#TicketType lock in, so a
// capacity change and a reservation serialize (P16 review).
function lockOffer(registrationPolicyId) {
    const policy = find(POLICY, {registrationPolicyId}).forUpdate(true).one()
    const tickets = Array.from(find(TICKET, {registrationPolicyId}).orderBy("ticketTypeId").forUpdate(true).list())
    return {policy, tickets}
}

// ===== actions and the entry code =====
const HOUR = 3600000
function record(row, actionEnumId, values = {}) {
    call("create#" + ACTION, {
        registrationId: row.registrationId,
        actionEnumId,
        fromStatusId: values.fromStatusId ?? row.statusId,
        toStatusId: values.toStatusId ?? row.statusId,
        credentialRevision: values.credentialRevision ?? row.credentialRevision ?? null,
        reason: values.reason ? String(values.reason).slice(0, limits.reason) : null,
        operationKey: values.operationKey || null,
        actorUserId: ec.user.userId || null,
        actionDate: ec.user.nowTimestamp
    })
}
// A registration moved to a state with its action; values beside the state (a hold's end, a date).
function move(row, statusId, actionEnumId, values = {}, reason = null) {
    call(
        "update#" + REGISTRATION,
        Object.assign(
            {registrationId: row.registrationId, statusId, statusId_changeReason: reason || enumText(actionEnumId)},
            values
        )
    )
    record(row, actionEnumId, {fromStatusId: row.statusId, toStatusId: statusId, reason})
}
// The offer's secret its entry codes are derived from: made at publication (EventRegistrations.js), else here once under the offer's
// row lock (an offer published before follow-up 1). Read before a registration's row is locked, so the lock order stays the offer's
// first.
function entryKeyOf(registrationPolicyId) {
    const policy = one(POLICY, {registrationPolicyId})
    if (!policy) return null
    if (policy.entryCodeKey) return String(policy.entryCodeKey)
    const locked = find(POLICY, {registrationPolicyId}).forUpdate(true).one()
    if (locked.entryCodeKey) return String(locked.entryCodeKey)
    const entryCodeKey = ec.user.randomString(64)
    call("update#" + POLICY, {registrationPolicyId, entryCodeKey})
    return entryCodeKey
}
// The code of a registration's revision: HMAC-SHA256 with the offer's secret over the registration and the revision, cut to 24 hex
// characters. The same revision gives the same code; only the secret's holder (the server) can make it. Follow-up 2 replaced
// follow-up 1's nested digest with the host's hmac: a code issued before still checks in (its digest is what is stored), and the
// registration's next issue writes the next revision's code (issueCode below), as a random code from before follow-up 1 is replaced.
function codeOf(entryCodeKey, registrationId, revision) {
    return (
        "EV" +
        ec.resource
            .hmac(entryCodeKey, registrationId + "\n" + revision)
            .slice(0, 24)
            .toUpperCase()
    )
}
const codeDigest = code => ec.user.singleUseCodeHash("event-entry:" + code)
// The entry code of a confirmed place at its current revision ({code, revision}), shown again as often as it is asked: its digest
// is written at the first issue of a revision (a revoked code's next revision, or the first), and a code made another way (random
// before follow-up 1, the nested digest of follow-up 1) is replaced by the next revision's. With an action (EraTicketShown) the showing is recorded.
function issueCode(registrationId, actionEnumId = null, operationKey = null) {
    const found = one(REGISTRATION, {registrationId})
    if (!found || found.statusId !== "EvrConfirmed") return null
    const entryCodeKey = entryKeyOf(found.registrationPolicyId)
    const row = find(REGISTRATION, {registrationId}).forUpdate(true).one()
    if (!row || row.statusId !== "EvrConfirmed" || !entryCodeKey) return null
    let revision = Math.max(Number(row.credentialRevision || 0), 1)
    let code = codeOf(entryCodeKey, registrationId, revision)
    if (row.credentialDigest !== codeDigest(code)) {
        if (row.credentialDigest) {
            revision += 1
            code = codeOf(entryCodeKey, registrationId, revision)
        }
        call("update#" + REGISTRATION, {
            registrationId,
            credentialDigest: codeDigest(code),
            credentialRevision: revision,
            credentialDate: ec.user.nowTimestamp
        })
    }
    if (actionEnumId) record({registrationId, statusId: row.statusId, credentialRevision: revision}, actionEnumId, {operationKey})
    return {code, revision}
}
// A new code for a confirmed place (staff's reissue): the revision raised and its digest written, the earlier code revoked.
function reissueCode(registrationId, reason, operationKey = null) {
    const found = one(REGISTRATION, {registrationId})
    if (!found) return null
    const entryCodeKey = entryKeyOf(found.registrationPolicyId)
    const row = find(REGISTRATION, {registrationId}).forUpdate(true).one()
    if (!row || row.statusId !== "EvrConfirmed" || !entryCodeKey) return null
    const revision = Number(row.credentialRevision || 0) + 1
    const code = codeOf(entryCodeKey, registrationId, revision)
    call("update#" + REGISTRATION, {
        registrationId,
        credentialDigest: codeDigest(code),
        credentialRevision: revision,
        credentialDate: ec.user.nowTimestamp
    })
    record({registrationId, statusId: row.statusId, credentialRevision: revision}, "EraCodeReissued", {reason, operationKey})
    return {code, revision}
}
// The registration an entry code names (its digest, the current revision), for check-in (P18); null for anything else.
function registrationOfCode(code) {
    const value = text(code)
    if (!value || value.length > 64) return null
    // a derived code is "EV" and upper-case hex: one typed in lower case is the same code (a code made before follow-up 1, random
    // and mixed case, still matches exactly)
    return (
        one(REGISTRATION, {credentialDigest: codeDigest(value)}) ||
        (value !== value.toUpperCase() ? one(REGISTRATION, {credentialDigest: codeDigest(value.toUpperCase())}) : null) ||
        null
    )
}
// The words of the offer's current terms revision, kept once (EventRegistrationTerms).
function keepTerms(policy) {
    const termsRevision = Number(policy.termsRevision || 0)
    if (!one(TERMS, {registrationPolicyId: policy.registrationPolicyId, termsRevision}))
        call("create#" + TERMS, {
            registrationPolicyId: policy.registrationPolicyId,
            termsRevision,
            termsText: policy.termsText || null,
            cancellationTerms: policy.cancellationTerms || null,
            consentText: policy.consentText || null,
            cancelDeadlineHours: policy.cancelDeadlineHours ?? null,
            refundPercent: policy.refundPercent ?? null,
            lateCancelAllowed: policy.lateCancelAllowed || null,
            createdDate: ec.user.nowTimestamp
        })
    return termsRevision
}
const hasTerms = policy =>
    !blank(policy.termsText) || !blank(policy.cancellationTerms) || !blank(policy.consentText) || setup().hasCancelRule(policy)

// ===== the cancellation rule (follow-up 1) =====
// The rule a registration (or a reservation) accepted: its terms revision's words and rule, else the offer's now (a place that
// accepted no terms).
function ruleSourceOf(policy, termsRevision) {
    const terms =
        termsRevision != null
            ? one(TERMS, {registrationPolicyId: policy.registrationPolicyId, termsRevision: Number(termsRevision)})
            : null
    return terms || policy
}
// When the place's occurrence starts (the event's rule may have moved it), in millis.
function startOf(policy) {
    const workEffort = one(WORK_EFFORT, {workEffortId: policy.workEffortId})
    const occurrence = workEffort ? setup().occurrenceOf(workEffort, ms(policy.occurrenceStart)) : null
    return occurrence?.start ?? ms(policy.occurrenceStart)
}
// What the rule says of cancelling a place now: {allowed, refundPercent, late}. Only a confirmed place is bound by it (one held,
// pending the organizer's approval, waitlisted or under review was never sold, so it is refunded in full); after the start nothing is
// cancelled online.
function cancelTermsOf(row, policy, at = nowMs()) {
    const startMs = startOf(policy)
    if (startMs != null && startMs <= at) return {allowed: false, refundPercent: 0, started: true}
    if (row.statusId !== "EvrConfirmed") return {allowed: true, refundPercent: 100}
    const rule = setup().cancelRuleOf(ruleSourceOf(policy, row.termsRevision))
    const deadline = rule.deadlineHours == null || startMs == null ? startMs : startMs - rule.deadlineHours * HOUR
    if (deadline == null || at < deadline) return {allowed: true, refundPercent: rule.refundPercent}
    return rule.lateAllowed ? {allowed: true, refundPercent: 0, late: true} : {allowed: false, refundPercent: 0, late: true}
}

// ===== the people =====
// The party for a typed person: by address, the address's directory party or a new person (MarketingPortal.js subscriberOf, never
// said which); with no address, a new person with the name. {partyId, contactMechId}.
function personOf(name, address) {
    if (address)
        return ec.resource.script("component://mr-mantle/service/mantle/marketing/MarketingPortal.js").subscriberOf(address, name)
    const partyId = call("create#mantle.party.Party", {partyTypeEnumId: "PtyPerson"}).partyId
    call("create#mantle.party.Person", {partyId, firstName: name || null})
    return {partyId, contactMechId: null}
}
function personInput(value, label, addressRequired) {
    const name = text(value?.name)
    const address = text(value?.email)?.toLowerCase() || null
    if (!name) denied("VALUE_INVALID[" + label + "]", "Name the " + label)
    if (name.length > limits.name) denied("VALUE_INVALID[" + label + "]", "A name has at most " + limits.name + " characters")
    if (addressRequired && !address) denied("VALUE_INVALID[" + label + "]", "Give the " + label + "'s email address")
    if (address && (address.length > limits.address || !emailPattern.test(address)))
        denied("VALUE_INVALID[" + label + "]", "Give a valid email address")
    return {name, address}
}

// ===== reserve =====
const linesOf = value =>
    (Array.isArray(value) ? value : value != null && typeof value === "object" && value.length != null ? Array.from(value) : [])
        .map(line => ({ticketTypeId: text(line?.ticketTypeId), quantity: Number(String(line?.quantity ?? "0").trim())}))
        .filter(line => line.ticketTypeId && line.quantity !== 0)
// The places a request asks for, checked against the offer under its lock, then all held or all waitlisted (or refused):
// {reservationId, replay, waitlisted}. Who asks is the caller's check; the buyer is {name, address}.
function reserve(p) {
    const lines = linesOf(p.lines)
    const requestKey = text(p.requestKey)
    if (!requestKey || !/^[A-Za-z0-9_-]{8,64}$/.test(requestKey)) denied("REQUEST_KEY_INVALID", "Reload the page and try again")
    const requestHash = lib.hash({lines, buyer: p.buyer, source: p.sourceEnumId})
    const repeat = () => {
        const earlier = one(RESERVATION, {registrationPolicyId: p.registrationPolicyId, requestKey})
        if (!earlier) return null
        if (earlier.requestHash !== requestHash)
            denied("OPERATION_CONFLICT", "This page was already sent with other choices; reload it")
        return {reservationId: earlier.reservationId, replay: true}
    }
    const first = repeat()
    if (first) return first
    const {policy, tickets} = lockOffer(p.registrationPolicyId)
    const again = repeat()
    if (again) return again
    if (!policy || policy.statusId !== "ErpPublished") denied("OFFER_UNAVAILABLE", "This registration is not open")
    const workEffort = one(WORK_EFFORT, {workEffortId: policy.workEffortId})
    const occurrence = workEffort ? setup().occurrenceOf(workEffort, ms(policy.occurrenceStart)) : null
    if (!occurrence || occurrence.end <= nowMs()) denied("OFFER_UNAVAILABLE", "This registration is not open")
    const at = nowMs()
    if (p.sourceEnumId !== "ErsStaff") {
        const opens = ms(policy.opensDate)
        const closes = ms(policy.closesDate) ?? occurrence.start
        if ((opens != null && opens > at) || closes <= at) denied("OFFER_UNAVAILABLE", "Registration is not open now")
    }
    if (!lines.length) denied("VALUE_INVALID[lines]", "Choose at least one place")
    const total = lines.reduce((sum, line) => sum + line.quantity, 0)
    if (lines.some(line => !Number.isInteger(line.quantity) || line.quantity < 0) || total < 1 || total > limits.places)
        denied("VALUE_INVALID[lines]", "Choose from 1 to " + limits.places + " places")
    const byId = new Map(tickets.filter(row => lib.active(row)).map(row => [row.ticketTypeId, row]))
    const seen = new Set()
    for (const line of lines) {
        const ticket = byId.get(line.ticketTypeId)
        if (!ticket || seen.has(line.ticketTypeId)) denied("VALUE_INVALID[lines]", "Choose a ticket this registration offers")
        seen.add(line.ticketTypeId)
        if (p.sourceEnumId !== "ErsStaff") {
            const from = ms(ticket.salesFromDate),
                thru = ms(ticket.salesThruDate)
            if ((from != null && from > at) || (thru != null && thru <= at))
                denied("VALUE_INVALID[lines]", (ticket.ticketName || "That ticket") + " is not on sale now")
        }
        if (ticket.perOrderLimit != null && line.quantity > Number(ticket.perOrderLimit))
            denied(
                "VALUE_INVALID[lines]",
                "At most " + ticket.perOrderLimit + " " + (ticket.ticketName || "places") + " a registration"
            )
        // a paid ticket needs its price now: an unpriced product is never free
        if (!setup().priceOf(ticket, policy).priced) denied("OFFER_UNAVAILABLE", "This registration is not open")
    }
    // the seats and each ticket's places together
    const seatsLeft = Number(policy.totalSeats || 0) - setup().seatsTaken(policy.registrationPolicyId)
    const fits =
        seatsLeft >= total &&
        lines.every(line => {
            const ticket = byId.get(line.ticketTypeId)
            if (ticket.capacity == null) return true
            return Number(ticket.capacity) - setup().seatsTaken(policy.registrationPolicyId, ticket.ticketTypeId) >= line.quantity
        })
    let waitlisted = false
    if (!fits) {
        const waiting = find(REGISTRATION, {registrationPolicyId: policy.registrationPolicyId, statusId: "EvrWaitlisted"}).count()
        // the waitlist's limit counts places, never past it (P16 review)
        if (
            policy.waitlistEnabled !== "Y" ||
            (policy.waitlistLimit != null && Number(waiting) + total > Number(policy.waitlistLimit))
        )
            denied("CAPACITY_UNAVAILABLE", "There are not enough places left")
        waitlisted = true
    }
    const reservationId = call("create#" + RESERVATION, {
        registrationPolicyId: policy.registrationPolicyId,
        buyerPartyId: p.buyer.partyId,
        emailContactMechId: p.buyer.contactMechId || null,
        sourceEnumId: p.sourceEnumId || "ErsPublic",
        siteId: p.siteId || null,
        requestKey,
        requestHash,
        marketingCampaignId: p.marketingCampaignId || null,
        createdByUserId: ec.user.userId || null,
        createdDate: ec.user.nowTimestamp
    }).reservationId
    const holdEnd = new Date(at + Number(policy.holdMinutes || 15) * MINUTE)
    let firstPlace = true
    for (const line of lines)
        for (let index = 0; index < line.quantity; index++) {
            const values = {
                registrationPolicyId: policy.registrationPolicyId,
                ticketTypeId: line.ticketTypeId,
                reservationId,
                buyerPartyId: p.buyer.partyId,
                // the buyer is the first attendee until the attendees are named
                attendeePartyId: firstPlace ? p.buyer.partyId : null,
                statusId: waitlisted ? "EvrWaitlisted" : "EvrHeld",
                holdExpireDate: waitlisted ? null : holdEnd,
                waitlistDate: waitlisted ? ec.user.nowTimestamp : null,
                marketingCampaignId: p.marketingCampaignId || null,
                createdDate: ec.user.nowTimestamp
            }
            const registrationId = call("create#" + REGISTRATION, values).registrationId
            record(Object.assign({registrationId}, values), waitlisted ? "EraWaitlisted" : "EraReserved", {fromStatusId: null})
            firstPlace = false
        }
    return {reservationId, replay: false, waitlisted}
}

// ===== complete =====
const placesOf = reservationId =>
    rows(REGISTRATION, {reservationId}).sort((a, b) => String(a.registrationId).localeCompare(String(b.registrationId)))
const paidOf = (row, policy) => {
    const ticket = one(TICKET, {ticketTypeId: row.ticketTypeId})
    return ticket ? !setup().priceOf(ticket, policy).free : false
}
// The questions of an offer now: its own publication while it is open, or null.
function questionsOf(policy) {
    const publication = policy.formPublicationId ? one(PUBLICATION, {publicationId: policy.formPublicationId}) : null
    return publication && publications().stateOf(publication) === "open" ? publication : null
}
// complete: the attendees named, the questions answered and the terms accepted for a reservation's live places, under the offer's
// lock; a free reservation (or one whose places are all free) confirmed. {reservationId, confirmed, paymentDue, replay}.
function complete(reservation, p) {
    const {policy} = lockOffer(reservation.registrationPolicyId)
    const current = one(RESERVATION, {reservationId: reservation.reservationId})
    const places = placesOf(reservation.reservationId).filter(row => ["EvrHeld", "EvrWaitlisted"].includes(row.statusId))
    if (current.completedDate) return Object.assign({replay: true}, stateOfReservation(current, policy))
    if (!places.length) denied("HOLD_EXPIRED", "These places are no longer held; start again")
    if (places.some(row => row.statusId === "EvrHeld" && !holdLive(row)))
        denied("HOLD_EXPIRED", "The hold on these places ended; start again")
    // the terms the visitor read: a change since is shown first
    if (hasTerms(policy)) {
        if (!p.acceptTerms) denied("VALUE_INVALID[acceptTerms]", "Accept the terms to register")
        if (!blank(p.termsRevision) && Number(p.termsRevision) !== Number(policy.termsRevision || 0))
            denied("TERMS_CHANGED", "The terms changed while you were registering; read them again")
    }
    const termsRevision = hasTerms(policy) ? keepTerms(policy) : null
    const attendees = Array.from(p.attendees || [])
    const people = places.map((row, index) =>
        personInput(attendees[index] || (index === 0 ? p.buyerAttendee : null), "attendee " + (index + 1), false)
    )
    const publication = questionsOf(policy)
    const scope = policy.questionScopeEnumId || "ErqAttendee"
    const answers = Array.from(p.answers || [])
    const requestKey = text(p.requestKey)
    if (publication && (!requestKey || !/^[A-Za-z0-9_-]{8,56}$/.test(requestKey)))
        denied("REQUEST_KEY_INVALID", "Reload the page and try again")
    places.forEach((row, index) => {
        const person = people[index]
        // the buyer stays the first attendee when the name typed is theirs and no other address is given; else the typed person
        const buyerName = partyName(reservation.buyerPartyId)
        const party =
            index === 0 && row.attendeePartyId && !person.address && person.name.toLowerCase() === String(buyerName).toLowerCase()
                ? {partyId: row.attendeePartyId}
                : personOf(person.name, person.address)
        let formResponseId = null
        if (publication && (scope === "ErqAttendee" || index === 0)) {
            const values = (scope === "ErqAttendee" ? answers[index] : answers[0]) || {}
            const accepted = publications().acceptSubmission({
                publicationId: publication.publicationId,
                values,
                requestKey: requestKey + "-" + index,
                partyId: party.partyId,
                siteId: policy.siteId
            })
            formResponseId = accepted.formResponseId || null
        }
        call("update#" + REGISTRATION, {
            registrationId: row.registrationId,
            attendeePartyId: party.partyId,
            termsRevision,
            formResponseId
        })
        record(row, "EraCompleted", {})
    })
    call("update#" + RESERVATION, {
        reservationId: reservation.reservationId,
        completedDate: ec.user.nowTimestamp,
        termsRevision
    })
    // a reservation with nothing to pay confirms at once, its places still held under the lock
    const held = places.filter(row => row.statusId === "EvrHeld")
    const due = held.some(row => paidOf(row, policy))
    if (held.length && !due)
        confirmPlaces(
            held.map(row => row.registrationId),
            "Free registration"
        )
    notices().afterCommit("receipt", reservation.reservationId)
    return Object.assign(
        {replay: false},
        stateOfReservation(one(RESERVATION, {reservationId: reservation.reservationId}), policy)
    )
}
// Places confirmed (from held, pending or review), each once; its ticket notice queued. The capacity is the caller's: a held or
// pending place has its seat, and a place given from review is checked by confirm#Registration.
function confirmPlaces(registrationIds, reason) {
    const confirmed = []
    for (const registrationId of registrationIds) {
        const row = find(REGISTRATION, {registrationId}).forUpdate(true).one()
        if (!row || !["EvrHeld", "EvrPending", "EvrReview"].includes(row.statusId)) continue
        move(row, "EvrConfirmed", "EraConfirmed", {confirmedDate: ec.user.nowTimestamp, holdExpireDate: null}, reason)
        confirmed.push(registrationId)
    }
    for (const registrationId of confirmed) notices().afterCommit("ticket", registrationId)
    return confirmed
}
// The reservation's state for its pages: {reservationId, state, confirmed, paymentDue, holdEndsMs}.
function stateOfReservation(reservation, policy) {
    const places = placesOf(reservation.reservationId)
    const live = places.filter(row => LIVE_STATES.includes(row.statusId))
    const held = places.filter(holdLive)
    const state = live.some(row => row.statusId === "EvrReview")
        ? "review"
        : live.length && live.every(row => row.statusId === "EvrConfirmed")
          ? "confirmed"
          : live.some(row => row.statusId === "EvrPending")
            ? "pending"
            : held.length
              ? "held"
              : live.some(row => row.statusId === "EvrWaitlisted")
                ? "waitlisted"
                : places.some(row => row.statusId === "EvrCancelled")
                  ? "cancelled"
                  : "expired"
    return {
        reservationId: reservation.reservationId,
        state,
        completed: !!reservation.completedDate,
        paymentDue: state === "held" && !!reservation.completedDate && held.some(row => paidOf(row, policy)),
        holdEndsMs: held.length ? Math.min(...held.map(row => ms(row.holdExpireDate) ?? Infinity)) : null
    }
}

// ===== cancel and the waitlist =====
// Places cancelled once under the offer's lock: each live place's seat released, its entry code revoked, a paid place's refund
// handed to Accounting after the commit; then the waitlist offered and the order cancelled when none of its places is left.
// percentOf(row, policy) gives each paid place's refund percentage (the caller's decision: the rule, 100, or staff's); none: 100.
function cancelPlaces(registrationIds, reason, operationKey = null, percentOf = null) {
    const byPolicy = new Map()
    for (const registrationId of registrationIds) {
        const row = one(REGISTRATION, {registrationId})
        if (row) byPolicy.set(row.registrationPolicyId, [...(byPolicy.get(row.registrationPolicyId) || []), registrationId])
    }
    const cancelled = []
    const refunds = []
    const orders = new Set()
    for (const [registrationPolicyId, ids] of byPolicy) {
        const {policy} = lockOffer(registrationPolicyId)
        for (const registrationId of ids) {
            const row = find(REGISTRATION, {registrationId}).forUpdate(true).one()
            if (!row || !LIVE_STATES.includes(row.statusId)) continue
            const paid = payments().paidFor(row)
            const refundPercent = paid ? (percentOf ? percentOf(row, policy) : 100) : null
            move(
                row,
                "EvrCancelled",
                "EraCancelled",
                {
                    cancelledDate: ec.user.nowTimestamp,
                    cancelReason: reason ? String(reason).slice(0, limits.reason) : null,
                    holdExpireDate: null,
                    credentialDigest: null,
                    credentialRevision: row.credentialDigest ? Number(row.credentialRevision || 0) + 1 : row.credentialRevision,
                    refundStatusEnumId: paid ? "ErfRequested" : row.refundStatusEnumId || null,
                    refundPercent
                },
                reason
            )
            if (operationKey) record(row, "EraCancelled", {operationKey, toStatusId: "EvrCancelled"})
            if (paid) {
                record(row, "EraRefundRequested", {fromStatusId: "EvrCancelled", toStatusId: "EvrCancelled"})
                refunds.push(registrationId)
            }
            if (row.orderId) orders.add(row.orderId)
            cancelled.push(registrationId)
        }
    }
    if (cancelled.length) {
        for (const registrationPolicyId of byPolicy.keys())
            ec.service
                .special()
                .name("mantle.work.EventRegistrationServices.offer#WaitlistPlaces")
                .parameters({registrationPolicyId})
                .registerOnCommit()
        for (const registrationId of refunds) payments().refundAfterCommit(registrationId)
        for (const orderId of orders) payments().cancelOrderIfEmpty(orderId)
        for (const registrationId of cancelled) notices().afterCommit("cancelled", registrationId)
    }
    return cancelled
}
// The first waiting reservations that fit, offered in waitlist order with a hold of their own (the offer's hold minutes), each its
// notice. A reservation's waiting places are offered together, as they were reserved together and one payment pays for them (P17
// review: a reservation split by the waitlist could pay for its first places only and never for the rest); one too large for what is
// free waits and no later one passes it. A completed reservation with nothing to pay is confirmed at once (no one is left to confirm
// a free place it already answered for).
function offerWaitlist(registrationPolicyId) {
    const {policy, tickets} = lockOffer(registrationPolicyId)
    if (!policy || policy.statusId !== "ErpPublished") return {offered: 0}
    const workEffort = one(WORK_EFFORT, {workEffortId: policy.workEffortId})
    const occurrence = workEffort ? setup().occurrenceOf(workEffort, ms(policy.occurrenceStart)) : null
    if (!occurrence || occurrence.start <= nowMs()) return {offered: 0}
    const byId = new Map(tickets.map(row => [row.ticketTypeId, row]))
    const waiting = Array.from(
        find(REGISTRATION, {registrationPolicyId, statusId: "EvrWaitlisted"})
            .orderBy("waitlistDate")
            .orderBy("registrationId")
            .limit(200)
            .list()
    )
    const groups = new Map()
    for (const row of waiting) {
        const groupKey = row.reservationId || row.registrationId
        groups.set(groupKey, [...(groups.get(groupKey) || []), row])
    }
    const offered = []
    let confirmed = 0
    for (const group of groups.values()) {
        if (group.some(row => !byId.get(row.ticketTypeId) || !lib.active(byId.get(row.ticketTypeId)))) continue
        const seatsLeft = Number(policy.totalSeats || 0) - setup().seatsTaken(registrationPolicyId)
        if (seatsLeft < group.length) break
        const perTicket = {}
        for (const row of group) perTicket[row.ticketTypeId] = (perTicket[row.ticketTypeId] || 0) + 1
        const ticketsFit = Object.entries(perTicket).every(([ticketTypeId, count]) => {
            const ticket = byId.get(ticketTypeId)
            return (
                ticket.capacity == null ||
                Number(ticket.capacity) - setup().seatsTaken(registrationPolicyId, ticketTypeId) >= count
            )
        })
        if (!ticketsFit) break
        const holdExpireDate = new Date(nowMs() + Number(policy.holdMinutes || 15) * MINUTE)
        for (const row of group) move(row, "EvrHeld", "EraOffered", {holdExpireDate})
        const reservation = group[0].reservationId ? one(RESERVATION, {reservationId: group[0].reservationId}) : null
        const ids = group.map(row => row.registrationId)
        if (reservation?.completedDate && !group.some(row => paidOf(row, policy)))
            confirmed += confirmPlaces(ids, "A place from the waitlist").length
        else offered.push(...ids)
    }
    for (const registrationId of offered) notices().afterCommit("offered", registrationId)
    return {offered: offered.length + confirmed}
}
// The holds that ended, expired once each (their seat is already free to the count), then each offer's waitlist offered.
function expireHolds(p) {
    const ended = Array.from(
        find(REGISTRATION, {statusId: "EvrHeld"})
            .condition("holdExpireDate", "less-equals", ec.user.nowTimestamp)
            .orderBy("holdExpireDate")
            .limit(Number(p.limit || 500))
            .list()
    )
    const policies = new Set()
    let expired = 0
    for (const candidate of ended) {
        try {
            ec.transaction.runRequireNew(null, "Expire registration hold " + candidate.registrationId, () => {
                lockOffer(candidate.registrationPolicyId)
                const row = find(REGISTRATION, {registrationId: candidate.registrationId}).forUpdate(true).one()
                if (!row || row.statusId !== "EvrHeld" || holdLive(row)) return
                move(row, "EvrExpired", "EraExpired", {})
                expired++
                policies.add(row.registrationPolicyId)
            })
        } catch (error) {
            ec.logger.error(
                "Registration " +
                    candidate.registrationId +
                    " hold not expired: " +
                    String(error?.message || error).split("\n")[0]
            )
        }
    }
    // the waiting places of an occurrence that has started end; each offer with free seats offers its waitlist
    const offers = Array.from(find(POLICY, {statusId: "ErpPublished"}).limit(500).list())
    let offered = 0
    for (const policy of offers) {
        try {
            if ((ms(policy.occurrenceStart) ?? Infinity) <= nowMs()) {
                ec.transaction.runRequireNew(null, "End the waitlist of " + policy.registrationPolicyId, () => {
                    for (const row of rows(REGISTRATION, {
                        registrationPolicyId: policy.registrationPolicyId,
                        statusId: "EvrWaitlisted"
                    }))
                        move(row, "EvrExpired", "EraExpired", {}, "The event started")
                })
                continue
            }
            if (!find(REGISTRATION, {registrationPolicyId: policy.registrationPolicyId, statusId: "EvrWaitlisted"}).count())
                continue
            ec.transaction.runRequireNew(null, "Offer the waitlist of " + policy.registrationPolicyId, () => {
                offered += offerWaitlist(policy.registrationPolicyId).offered
            })
        } catch (error) {
            ec.logger.error(
                "Registration offer " +
                    policy.registrationPolicyId +
                    " waitlist: " +
                    String(error?.message || error).split("\n")[0]
            )
        }
    }
    return {expired, offered, policies: policies.size}
}

// ===== the order's status (the SECA on OrderHeader) =====
// An order of registrations approved: its pending places confirmed once; cancelled or rejected: its live places cancelled once,
// each paid place's refund handed to Accounting.
function handleOrderStatus(p) {
    const orderId = text(p.orderId)
    if (!orderId) return {}
    const places = rows(REGISTRATION, {orderId})
    if (!places.length) return {}
    if (p.statusId === "OrderApproved") {
        lockOffer(places[0].registrationPolicyId)
        // a place whose payment was applied (pending); a held one only while its hold lasts and its payment is received (P17
        // review: an approval never seats an unpaid place or one whose hold ended)
        const ids = places
            .filter(
                row => row.statusId === "EvrPending" || (row.statusId === "EvrHeld" && holdLive(row) && payments().paidFor(row))
            )
            .map(row => row.registrationId)
        return {confirmed: confirmPlaces(ids, "The order was approved").length}
    }
    if (["OrderCancelled", "OrderRejected"].includes(p.statusId)) {
        const ids = places.filter(row => LIVE_STATES.includes(row.statusId)).map(row => row.registrationId)
        return {cancelled: cancelPlaces(ids, "The order was cancelled").length}
    }
    return {}
}

// ===== views =====
function ticketName(ticketTypeId) {
    return ticketTypeId ? one(TICKET, {ticketTypeId})?.ticketName || ticketTypeId : ""
}
function placeView(row, policy, options = {}) {
    const attendee = row.attendeePartyId
    return {
        registrationId: row.registrationId,
        reservationId: row.reservationId || "",
        attendeePartyId: options.internal ? attendee || "" : undefined,
        attendeeName: attendee ? partyName(attendee) : L("Not named yet"),
        ticketTypeId: row.ticketTypeId || "",
        ticketName: ticketName(row.ticketTypeId),
        statusId: row.statusId,
        stateText: L(stateTexts[row.statusId] || row.statusId),
        stateColor: stateColors[row.statusId] || "grey-7",
        holdEndsText: holdLive(row) && row.holdExpireDate ? lib.dateText(row.holdExpireDate) : "",
        paid: options.internal ? payments().paidFor(row) : undefined,
        refundText: row.refundStatusEnumId ? enumText(row.refundStatusEnumId) : "",
        hasCode: row.statusId === "EvrConfirmed",
        answered: !!row.formResponseId
    }
}
// find#Registrations: an offer's (or an event's offers') registrations of the caller's organizations, by state, ticket and a name
// or address of the attendee or buyer, a page at a time.
function findRegistrations(p) {
    const userScope = manageScope()
    let policyIds = []
    if (!blank(p.registrationPolicyId)) policyIds = [offerOf(userScope, p.registrationPolicyId).registrationPolicyId]
    else if (!blank(p.workEffortId)) {
        policyIds = rows(POLICY, {workEffortId: text(p.workEffortId)})
            .filter(policy => marketingAccess.covers(userScope, policy.organizationPartyId))
            .map(policy => policy.registrationPolicyId)
        if (!policyIds.length) denied("RECORD_UNAVAILABLE", "Event " + p.workEffortId + " is not available")
    } else {
        const organizationIds = marketingAccess.organizationIds(userScope)
        policyIds = Array.from(
            find(POLICY)
                .condition("organizationPartyId", "in", organizationIds.length ? organizationIds : ["_NONE_"])
                .selectField("registrationPolicyId")
                .limit(limits.find)
                .list()
        ).map(row => row.registrationPolicyId)
    }
    if (!policyIds.length) return Object.assign({canEnter: true}, lib.pageList([], p, "registrationList"))
    let query = find(REGISTRATION).condition("registrationPolicyId", "in", policyIds)
    if (!blank(p.statusId)) query = query.condition("statusId", text(p.statusId))
    if (!blank(p.ticketTypeId)) query = query.condition("ticketTypeId", text(p.ticketTypeId))
    const term = text(p.term)
    if (term) {
        const cf = ec.entity.conditionFactory
        const matched = Array.from(
            find("mantle.party.Person")
                .condition(
                    cf.makeCondition(
                        [
                            cf.makeCondition("firstName", "like", "%" + term + "%").ignoreCase(),
                            cf.makeCondition("lastName", "like", "%" + term + "%").ignoreCase()
                        ],
                        "or"
                    )
                )
                .selectField("partyId")
                .limit(500)
                .list()
        ).map(row => row.partyId)
        const byAddress = Array.from(
            find("mantle.party.contact.PartyContactMechInfo")
                .condition("contactMechTypeEnumId", "CmtEmailAddress")
                .condition(cf.makeCondition("infoString", "like", "%" + term + "%").ignoreCase())
                .selectField("partyId")
                .limit(500)
                .list()
        ).map(row => row.partyId)
        const ids = [...new Set([...matched, ...byAddress, term])]
        query = query.condition(
            cf.makeCondition(
                [
                    cf.makeCondition("attendeePartyId", "in", ids),
                    cf.makeCondition("buyerPartyId", "in", ids),
                    cf.makeCondition("registrationId", "equals", term)
                ],
                "or"
            )
        )
    }
    const policies = new Map()
    const policyOfRow = id => {
        if (!policies.has(id)) policies.set(id, one(POLICY, {registrationPolicyId: id}))
        return policies.get(id)
    }
    const found = Array.from(query.orderBy("-createdDate").limit(limits.find).list())
    const list = found.map(row => {
        const policy = policyOfRow(row.registrationPolicyId)
        return Object.assign(placeView(row, policy, {internal: true}), {
            buyerName: partyName(row.buyerPartyId),
            offerTitle: policy?.publicTitle || "",
            occurrenceText: policy ? lib.dateText(policy.occurrenceStart) : "",
            createdText: lib.dateText(row.createdDate),
            paymentText: payments().paymentText(row),
            revision: ms(row.lastUpdatedStamp)
        })
    })
    return Object.assign({canEnter: true}, lib.pageList(list, p, "registrationList"))
}
// get#Registration: one registration for an events manager of its organization: its attendee and buyer, the offer and occurrence, the
// ticket, its state and hold, the terms it accepted (their words at that revision), its order and payment, the refund, its answers'
// response, its actions (attendance, corrections), and what may be done.
function getRegistration(p) {
    const userScope = manageScope()
    const {row, policy} = registrationOf(userScope, p.registrationId)
    const reservation = row.reservationId ? one(RESERVATION, {reservationId: row.reservationId}) : null
    const terms =
        row.termsRevision != null
            ? one(TERMS, {registrationPolicyId: policy.registrationPolicyId, termsRevision: Number(row.termsRevision)})
            : null
    const workEffort = one(WORK_EFFORT, {workEffortId: policy.workEffortId})
    const actions = Array.from(
        find(ACTION, {registrationId: row.registrationId}).orderBy("-actionDate").orderBy("-actionId").limit(100).list()
    ).map(action => ({
        actionId: action.actionId,
        actionText: enumText(action.actionEnumId),
        actionEnumId: action.actionEnumId,
        fromText: action.fromStatusId ? L(stateTexts[action.fromStatusId] || action.fromStatusId) : "",
        toText: action.toStatusId ? L(stateTexts[action.toStatusId] || action.toStatusId) : "",
        credentialRevision: action.credentialRevision,
        reason: action.reason || "",
        actorText: action.actorUserId ? userText(action.actorUserId) : L("System or visitor"),
        whenText: lib.dateText(action.actionDate)
    }))
    const live = LIVE_STATES.includes(row.statusId)
    return {
        registration: Object.assign(placeView(row, policy, {internal: true}), {
            buyerPartyId: row.buyerPartyId || "",
            buyerName: partyName(row.buyerPartyId),
            workEffortId: policy.workEffortId,
            eventName: workEffort?.workEffortName || policy.workEffortId,
            registrationPolicyId: policy.registrationPolicyId,
            offerTitle: policy.publicTitle || "",
            occurrenceText: lib.dateText(policy.occurrenceStart),
            organizationPartyId: policy.organizationPartyId,
            sourceText: reservation ? enumText(reservation.sourceEnumId) : "",
            createdText: lib.dateText(row.createdDate),
            confirmedText: lib.dateText(row.confirmedDate),
            cancelledText: lib.dateText(row.cancelledDate),
            cancelReason: row.cancelReason || "",
            termsRevision: row.termsRevision,
            termsText: terms?.termsText || "",
            cancellationTerms: terms?.cancellationTerms || "",
            cancelRuleText: setup().cancelRuleText(terms || policy),
            consentText: terms?.consentText || "",
            refundPercent: row.refundPercent == null ? null : Number(toDecimal(row.refundPercent).toString()),
            orderId: row.orderId || "",
            paymentText: payments().paymentText(row),
            formResponseId: row.formResponseId || "",
            credentialRevision: row.credentialRevision,
            credentialText: row.credentialDigest
                ? L("Entry code") + " " + row.credentialRevision + " " + L("issued") + " " + lib.dateText(row.credentialDate)
                : row.statusId === "EvrConfirmed"
                  ? L("No entry code issued yet")
                  : "",
            marketingCampaignId: row.marketingCampaignId || "",
            revision: ms(row.lastUpdatedStamp)
        }),
        actions,
        canCancel: live,
        canCorrect: live && row.statusId !== "EvrReview",
        canReissue: row.statusId === "EvrConfirmed",
        // what the accepted terms give a cancellation now (staff may set another percentage with a reason)
        termsRefundPercent: live ? (cancelTermsOf(row, policy).started ? 0 : cancelTermsOf(row, policy).refundPercent) : null,
        canConfirm:
            (row.statusId === "EvrHeld" && !payments().paidFor(row) && !paidOf(row, policy)) || row.statusId === "EvrReview",
        canNotify: ["EvrConfirmed", "EvrPending", "EvrWaitlisted"].includes(row.statusId)
    }
}
function requireRevision(row, expectedRevision) {
    if (blank(expectedRevision)) denied("REVISION_REQUIRED", "Name the revision of the registration you read")
    if (ms(expectedRevision) !== ms(row.lastUpdatedStamp))
        denied(
            "STALE_REVISION",
            "The registration changed since it was read; review it again (revision " + ms(row.lastUpdatedStamp) + ")"
        )
}

// ===== staff services =====
// reserve#Registration (StaffRegistration): places on a published offer of the caller's organizations for a buyer typed by name and
// address (the same holds as a visitor's, the window aside), held or waitlisted; the request key's repeat answers the first.
function reserveRegistration(p) {
    const userScope = manageScope()
    const policy = offerOf(userScope, p.registrationPolicyId)
    const buyer = personInput({name: p.buyerName, email: p.buyerEmail}, "buyer", true)
    const reservedBefore = text(p.requestKey)
        ? one(RESERVATION, {registrationPolicyId: policy.registrationPolicyId, requestKey: text(p.requestKey)})
        : null
    const party = reservedBefore
        ? {partyId: reservedBefore.buyerPartyId, contactMechId: reservedBefore.emailContactMechId}
        : personOf(buyer.name, buyer.address)
    let marketingCampaignId = null
    if (!blank(p.marketingCampaignId)) {
        const campaign = one("mantle.marketing.campaign.MarketingCampaign", {marketingCampaignId: text(p.marketingCampaignId)})
        if (!campaign || campaign.organizationPartyId !== policy.organizationPartyId)
            denied("VALUE_INVALID[marketingCampaignId]", "Choose a campaign of the offer's organization")
        marketingCampaignId = campaign.marketingCampaignId
    }
    const lines = linesOf(p.lines).length ? p.lines : [{ticketTypeId: p.ticketTypeId, quantity: p.quantity || 1}]
    const out = reserve({
        registrationPolicyId: policy.registrationPolicyId,
        lines,
        buyer: Object.assign({}, party, {name: buyer.name}),
        requestKey: p.requestKey,
        sourceEnumId: "ErsStaff",
        siteId: policy.siteId,
        marketingCampaignId
    })
    const reservation = one(RESERVATION, {reservationId: out.reservationId})
    return Object.assign(
        {registrationIds: placesOf(out.reservationId).map(row => row.registrationId)},
        stateOfReservation(reservation, policy),
        {
            replay: out.replay
        }
    )
}
// confirm#Registration (StaffRegistration): a held free place confirmed by staff, or a place paid after its hold ended given a seat
// where one is free now; a place with something to pay is never confirmed without its payment (no payment is invented).
function confirmRegistration(p) {
    const userScope = manageScope()
    const {row: found, policy} = registrationOf(userScope, p.registrationId)
    lockOffer(policy.registrationPolicyId)
    const row = one(REGISTRATION, {registrationId: found.registrationId})
    requireRevision(row, p.expectedRevision)
    if (row.statusId === "EvrConfirmed") return {registrationId: row.registrationId, statusId: row.statusId}
    if (row.statusId === "EvrHeld") {
        if (!holdLive(row)) denied("HOLD_EXPIRED", "The hold ended; reserve again")
        if (paidOf(row, policy) && !payments().paidFor(row))
            denied("PAYMENT_REQUIRED", "A paid place is confirmed by its payment")
    } else if (row.statusId === "EvrReview") {
        // the places its payment paid for are seated together, where seats are free for all of them now; then its order is placed
        // and the order's approval confirms them, as any paid place's
        const reviewed = row.paymentId ? rows(REGISTRATION, {paymentId: row.paymentId, statusId: "EvrReview"}) : [row]
        const seatsLeft = Number(policy.totalSeats || 0) - setup().seatsTaken(policy.registrationPolicyId)
        const perTicket = {}
        for (const place of reviewed) perTicket[place.ticketTypeId] = (perTicket[place.ticketTypeId] || 0) + 1
        const ticketsFit = Object.entries(perTicket).every(([ticketTypeId, count]) => {
            const ticket = one(TICKET, {ticketTypeId})
            return (
                ticket?.capacity == null ||
                Number(ticket.capacity) - setup().seatsTaken(policy.registrationPolicyId, ticketTypeId) >= count
            )
        })
        if (seatsLeft < reviewed.length || !ticketsFit)
            denied("CAPACITY_UNAVAILABLE", "No seats are free for its places; refund it instead")
        payments().seatReviewed(reviewed.map(place => place.registrationId))
        return {registrationId: row.registrationId, statusId: "EvrPending"}
    } else denied("STATUS_INVALID", "Only a held or a paid-after-its-hold place is confirmed here")
    const reason = text(p.reason) || (row.statusId === "EvrReview" ? "A seat given after review" : "Confirmed by staff")
    confirmPlaces([row.registrationId], reason)
    return {registrationId: row.registrationId, statusId: "EvrConfirmed"}
}
// A refund percentage a staff member names (0 to 100, at most two decimals), or null when none is named.
function percentInput(value) {
    if (blank(value)) return null
    const percent = Number(String(value).trim())
    if (!Number.isFinite(percent) || percent < 0 || percent > 100 || Math.round(percent * 100) !== percent * 100)
        denied("VALUE_INVALID[refundPercent]", "The refund is a percentage from 0 to 100, at most two decimals")
    return percent
}
// Staff's refund for a paid place: the accepted terms' rule as a buyer cancelling now would have it (after the deadline nothing,
// whether or not a buyer could still cancel online), or the percentage staff name; one that differs from the rule's is an override,
// recorded with the reason (EraRefundOverride; follow-up 1).
function staffPercentOf(named, reason) {
    return (row, policy) => {
        const terms = cancelTermsOf(row, policy)
        const byTerms = terms.started ? 0 : terms.refundPercent
        if (named == null || named === byTerms) return byTerms
        record(row, "EraRefundOverride", {
            reason: (L("Refund") + " " + named + "% " + L("instead of the terms'") + " " + byTerms + "%: " + reason).slice(
                0,
                limits.reason
            )
        })
        return named
    }
}
// cancel#Registration (RegistrationChange): a live place cancelled at the revision read, with its reason; its seat released once, its
// code revoked and a paid place's refund handed to Accounting (pending until the provider's result), by the accepted terms' rule or
// the percentage staff name (an override, recorded with the reason). Staff may cancel after the rule's deadline and after the start.
function cancelRegistration(p) {
    const userScope = manageScope()
    const {row} = registrationOf(userScope, p.registrationId)
    if (!LIVE_STATES.includes(row.statusId))
        denied("STATUS_INVALID", "This registration is already " + L(stateTexts[row.statusId] || row.statusId).toLowerCase())
    requireRevision(row, p.expectedRevision)
    const reason = text(p.reason)
    if (!reason) denied("VALUE_INVALID[reason]", "Give the reason for the cancellation")
    const named = percentInput(p.refundPercent)
    cancelPlaces(
        [row.registrationId],
        reason + " (" + (ec.user.username || ec.user.userId) + ")",
        null,
        staffPercentOf(named, reason)
    )
    const after = one(REGISTRATION, {registrationId: row.registrationId})
    return {
        registrationId: row.registrationId,
        statusId: after.statusId,
        refundStatusEnumId: after.refundStatusEnumId || null,
        refundPercent: after.refundPercent == null ? null : Number(toDecimal(after.refundPercent).toString())
    }
}
// reissue#RegistrationCode (RegistrationDetail): a new entry code for a confirmed place at the revision read, with its reason (a lost
// or shared ticket): the code's revision raised, the earlier code revoked, the new one sent in a ticket notice (follow-up 1).
function reissueRegistrationCode(p) {
    const userScope = manageScope()
    const {row} = registrationOf(userScope, p.registrationId)
    requireRevision(row, p.expectedRevision)
    if (row.statusId !== "EvrConfirmed") denied("STATUS_INVALID", "Only a confirmed place has an entry code")
    const reason = text(p.reason)
    if (!reason) denied("VALUE_INVALID[reason]", "Give the reason for the new code")
    const issued = reissueCode(row.registrationId, reason + " (" + (ec.user.username || ec.user.userId) + ")")
    if (!issued) denied("STATUS_INVALID", "Only a confirmed place has an entry code")
    notices().afterCommit("ticket", row.registrationId, "reissue-" + issued.revision)
    return {registrationId: row.registrationId, credentialRevision: issued.revision}
}
// correct#Registration (RegistrationChange): a correction of the attendee's name or address, or a substitution by another person, with
// its reason; the old attendee's entry code is revoked and a confirmed place's new code goes to the new attendee. Check-in history
// stays as it was.
function correctRegistration(p) {
    const userScope = manageScope()
    const {row: found, policy} = registrationOf(userScope, p.registrationId)
    lockOffer(policy.registrationPolicyId)
    const row = find(REGISTRATION, {registrationId: found.registrationId}).forUpdate(true).one()
    requireRevision(row, p.expectedRevision)
    if (!LIVE_STATES.includes(row.statusId) || row.statusId === "EvrReview")
        denied("STATUS_INVALID", "Only a live place is corrected")
    const reason = text(p.reason)
    if (!reason) denied("VALUE_INVALID[reason]", "Give the reason for the correction")
    const person = personInput({name: p.attendeeName, email: p.attendeeEmail}, "attendee", false)
    const party = personOf(person.name, person.address)
    const substituted = party.partyId !== row.attendeePartyId
    call("update#" + REGISTRATION, {
        registrationId: row.registrationId,
        attendeePartyId: party.partyId,
        credentialDigest: null,
        credentialRevision: row.credentialDigest ? Number(row.credentialRevision || 0) + 1 : row.credentialRevision
    })
    record(row, substituted ? "EraSubstituted" : "EraCorrected", {
        reason: reason + (substituted ? " (was " + partyName(row.attendeePartyId) + ")" : ""),
        credentialRevision: row.credentialDigest ? Number(row.credentialRevision || 0) + 1 : row.credentialRevision
    })
    // the new revision's code in a ticket of its own (a key apart from the first ticket's, which the ledger keeps once)
    if (row.statusId === "EvrConfirmed") notices().afterCommit("ticket", row.registrationId, "corrected-" + nowMs())
    return {registrationId: row.registrationId, substituted}
}
// change#Registrations (RegistrationBatch): cancel or notify again each of the selected registrations of the caller's organizations,
// each in a transaction of its own with its result; one that fails is named and the rest go on.
function changeRegistrations(p) {
    const userScope = manageScope()
    const action = text(p.action)
    if (!["cancel", "notify"].includes(action)) denied("ACTION_INVALID", "Cancel or notify")
    const reason = text(p.reason)
    if (action === "cancel" && !reason) denied("VALUE_INVALID[reason]", "Give the reason for the cancellation")
    const named = action === "cancel" ? percentInput(p.refundPercent) : null
    const ids = [
        ...new Set(
            Array.from(p.registrationIds || [])
                .map(text)
                .filter(Boolean)
        )
    ].slice(0, limits.batch)
    if (!ids.length) denied("VALUE_INVALID[registrationIds]", "Select the registrations")
    const results = []
    for (const registrationId of ids) {
        try {
            ec.transaction.runRequireNew(null, "Registration " + registrationId + " " + action, () => {
                const {row} = registrationOf(userScope, registrationId)
                if (action === "cancel") {
                    if (!LIVE_STATES.includes(row.statusId)) {
                        results.push({registrationId, outcome: "skipped", message: L("Not live")})
                        return
                    }
                    cancelPlaces(
                        [registrationId],
                        reason + " (" + (ec.user.username || ec.user.userId) + ")",
                        null,
                        staffPercentOf(named, reason)
                    )
                    results.push({registrationId, outcome: "cancelled", message: ""})
                } else {
                    const kind =
                        row.statusId === "EvrConfirmed"
                            ? "ticket"
                            : ["EvrPending", "EvrWaitlisted"].includes(row.statusId)
                              ? "status"
                              : null
                    if (!kind) {
                        results.push({registrationId, outcome: "skipped", message: L("Nothing to send")})
                        return
                    }
                    notices().afterCommit(kind, registrationId, "again-" + nowMs())
                    record(row, "EraNotified", {reason})
                    results.push({registrationId, outcome: "notified", message: ""})
                }
            })
        } catch (error) {
            const message = String(error?.message || error).split("\n")[0]
            ec.logger.warn("Registration " + registrationId + " " + action + ": " + message)
            results.push({registrationId, outcome: "failed", message})
        }
    }
    return {
        results,
        changed: results.filter(result => ["cancelled", "notified"].includes(result.outcome)).length,
        failed: results.filter(result => result.outcome === "failed").length
    }
}
// check#RegistrationAccess (Chatter and RecordFiles): an events manager of the offer's organization; nobody else, whatever the
// entity filters and authorization.
function checkRegistrationAccess(p) {
    try {
        const userScope = marketingAccess.scope()
        if (!userScope.capabilities.eventManage) return {recordVisible: false}
        const row = blank(p.registrationId) ? null : one(REGISTRATION, {registrationId: text(p.registrationId)})
        const policy = row ? one(POLICY, {registrationPolicyId: row.registrationPolicyId}) : null
        return {recordVisible: !!policy && marketingAccess.covers(userScope, policy.organizationPartyId)}
    } catch (error) {
        ec.message.clearErrors()
        return {recordVisible: false}
    }
}
// create#EventRegistrationContent (RecordFiles): a file kept on a registration the caller manages.
function createRegistrationContent(p) {
    const userScope = manageScope()
    const {row} = registrationOf(userScope, p.registrationId)
    const out = call("create#mantle.work.registration.EventRegistrationContent", {
        registrationId: row.registrationId,
        contentTypeEnumId: text(p.contentTypeEnumId) || "RctDocument",
        contentLocation: p.contentLocation,
        description: text(p.description),
        contentDate: ec.user.nowTimestamp,
        userId: ec.user.userId
    })
    return {registrationContentId: out.registrationContentId}
}

// The reservation of the scope (by its offer's organization).
function reservationOf(userScope, reservationId) {
    const row = blank(reservationId) ? null : one(RESERVATION, {reservationId: text(reservationId)})
    const policy = row ? one(POLICY, {registrationPolicyId: row.registrationPolicyId}) : null
    if (!row || !policy || !marketingAccess.covers(userScope, policy.organizationPartyId))
        denied("RECORD_UNAVAILABLE", "Reservation " + (reservationId || "") + " is not available")
    return {row, policy}
}
const listParam = value =>
    typeof value === "string"
        ? lib.json(value, [])
        : Array.isArray(value) || (value != null && value.length != null)
          ? Array.from(value)
          : []
// complete#Registration (StaffRegistration): a staff entry's attendees, answers and the terms accepted on the buyer's behalf, as a
// visitor's; a free reservation confirms.
function completeRegistrationStaff(p) {
    const userScope = manageScope()
    const {row, policy} = reservationOf(userScope, p.reservationId)
    const out = complete(row, {
        attendees: listParam(p.attendees),
        answers: listParam(p.answers),
        acceptTerms: p.acceptTerms === true || ["Y", "true", "on"].includes(String(p.acceptTerms ?? "")),
        termsRevision: p.termsRevision,
        requestKey: p.requestKey
    })
    return Object.assign({registrationIds: placesOf(row.reservationId).map(place => place.registrationId)}, out, {
        statePolicy: policy.registrationPolicyId
    })
}
// start#RegistrationPayment (E's thin wrapper over Accounting's coordinator, X9): the hosted payment of a staff entry's held places,
// whose provider page the buyer is sent to; the same attempt answered again on a repeat.
function startPaymentStaff(p) {
    const userScope = manageScope()
    const {row} = reservationOf(userScope, p.reservationId)
    const out = payments().startPayment(row.reservationId)
    delete out.returnKey
    return out
}

const operations = {
    completeRegistrationStaff,
    startPaymentStaff,
    findRegistrations,
    getRegistration,
    reserveRegistration,
    confirmRegistration,
    cancelRegistration,
    reissueRegistrationCode,
    correctRegistration,
    changeRegistrations,
    checkRegistrationAccess,
    createRegistrationContent,
    expireHolds,
    offerWaitlist: p => offerWaitlist(text(p.registrationPolicyId)),
    handleOrderStatus
}
;({
    LIVE_STATES,
    stateTexts,
    stateColors,
    limits,
    holdLive,
    occupies,
    lockOffer,
    record,
    move,
    reserve,
    complete,
    confirmPlaces,
    cancelPlaces,
    placesOf,
    paidOf,
    questionsOf,
    stateOfReservation,
    issueCode,
    reissueCode,
    registrationOfCode,
    cancelTermsOf,
    ruleSourceOf,
    personOf,
    personInput,
    partyName,
    ticketName,
    hasTerms,
    execute(op, parameters) {
        if (!Object.hasOwn(operations, op)) throw new Error("Unknown event registration operation " + op)
        const wasDisabled = ec.artifactExecution.disableAuthz()
        try {
            return operations[op](parameters || {})
        } finally {
            if (!wasDisabled) ec.artifactExecution.enableAuthz()
        }
    }
})
