// Event registrations: the receipt, the ticket and the event communications (mantle.work.EventRegistrationServices, E of IronStone
// Marketing design §14.2; design §9 Registrations, §15.3 Event communications, §18 the receipt, ticket and notices; impl-marketing P17).
// CC0 1.0 Universal plus Grant of Patent License.
//
// - Every message is a delivery of Comms' ledger (mantle.party.MessageServices queue#Delivery, source MdsrcEventRegistration, built at
//   each attempt by build#RegistrationDelivery), queued after the registration's change commits and attempted on a service worker;
//   one delivery per event key and recipient, so a repeat queues nothing new.
// - The registration's own messages (the receipt of a reservation in each state, the ticket of a confirmed place, a waitlist offer,
//   a cancellation) are transactional, from the offer's transactional sending profile, under the registration's own authority:
//   they carry no promotion. The receipt's link opens MyRegistration with a capability made at each attempt (its token only in the
//   message); a confirmed place's ticket carries a new entry code (the earlier one revoked) and, for an online occurrence, the link
//   to join. A pending place (payment received, the order awaiting the organizer's approval) gets no ticket, code or link.
// - The offer's scheduled notices (EventCommunicationSchedule): one delivery per registration, schedule and trigger (before the start,
//   after the end, when the occurrence moves, when confirmed, when cancelled), with the schedule's Comms template; a promotional one
//   is handed off only with the recipient's marketing consent (the ledger's check at each attempt), a transactional one never with
//   a promotional template (P16). A notice of a place no longer confirmed, an event cancelled or an offer closed is suppressed when
//   it would be sent.
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const places = () => ec.resource.script("component://mr-mantle/service/mantle/work/EventRegistrationPlaces.js")
const setup = () => ec.resource.script("component://mr-mantle/service/mantle/work/EventRegistrations.js")
const templates = () => ec.resource.script("component://mr-mantle/service/mantle/party/MessageTemplates.js")
const externalAccess = () => ec.resource.script("component://mr-mantle/service/mantle/party/ExternalAccess.js")
const {find, one, rows, call, ms} = lib

const POLICY = "mantle.work.registration.EventRegistrationPolicy"
const REGISTRATION = "mantle.work.registration.EventRegistration"
const RESERVATION = "mantle.work.registration.EventReservation"
const SCHEDULE = "mantle.work.registration.EventCommunicationSchedule"
const WORK_EFFORT = "mantle.work.effort.WorkEffort"
const SOURCE = "MdsrcEventRegistration"
const TEMPLATE_KEY = "MANTLE_EVENT_REGISTRATION"
const DAY = 86400000

const blank = value => value == null || String(value).trim() === ""
const text = value => (blank(value) ? null : String(value).trim())
const nowMs = () => Number(ms(ec.user.nowTimestamp))
const L = words => ec.l10n.localize(words)
const esc = value =>
    String(value ?? "").replace(/[&<>"']/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"})[c])

// ===== addresses =====
const addressOfMech = contactMechId =>
    contactMechId ? one("mantle.party.contact.ContactMech", {contactMechId})?.infoString || null : null
// A party's current email address (its primary first).
function addressOfParty(partyId) {
    if (!partyId) return null
    const mechs = rows("mantle.party.contact.PartyContactMech", {partyId})
        .filter(row => lib.active(row))
        .sort(
            (a, b) => (a.contactMechPurposeId === "EmailPrimary" ? -1 : 0) - (b.contactMechPurposeId === "EmailPrimary" ? -1 : 0)
        )
    for (const row of mechs) {
        const mech = one("mantle.party.contact.ContactMech", {contactMechId: row.contactMechId})
        if (mech?.contactMechTypeEnumId === "CmtEmailAddress" && mech.infoString)
            return {address: mech.infoString, contactMechId: mech.contactMechId}
    }
    return null
}
function buyerAddress(reservation) {
    const address = addressOfMech(reservation.emailContactMechId)
    return address ? {address, contactMechId: reservation.emailContactMechId} : addressOfParty(reservation.buyerPartyId)
}

// ===== queueing =====
// A message queued after the current transaction commits (queue#RegistrationNotice on a service worker): the registration's own
// change never waits on the mail, and a rolled-back change sends nothing.
function afterCommit(kind, recordId, suffix = null) {
    ec.service
        .special()
        .name("mantle.work.EventRegistrationServices.queue#RegistrationNotice")
        .parameters({kind, recordId, suffix})
        .registerOnCommit()
}
function queue(eventKey, recipientPartyId, to, policy, values = {}) {
    if (!to?.address || !recipientPartyId) return null
    const profile = setup().profileOf(policy)
    if (!profile?.ready) {
        ec.logger.warn(
            "Registration notice " + eventKey + ": the offer " + policy.registrationPolicyId + " has no ready sending profile"
        )
        return null
    }
    const queued = call(
        "mantle.party.MessageServices.queue#Delivery",
        Object.assign(
            {
                eventKey,
                sourceEnumId: SOURCE,
                recipientPartyId,
                toAddress: to.address,
                channelEnumId: "MdcEmail",
                templateKey: TEMPLATE_KEY,
                siteId: policy.siteId || null,
                organizationPartyId: policy.organizationPartyId,
                sendingProfileId: profile.profile.sendingProfileId,
                transactional: true
            },
            values
        )
    )
    if (queued.deliveryId && queued.created) {
        ec.message.pushErrors()
        try {
            ec.service
                .sync()
                .name("mantle.party.MessageServices.attempt#Delivery")
                .parameters({deliveryId: queued.deliveryId})
                .disableAuthz()
                .requireNewTransaction(true)
                .call()
        } finally {
            ec.message.clearErrors()
            ec.message.popErrors()
        }
    }
    return queued.deliveryId || null
}
// queue#RegistrationNotice: the message of a kind for a reservation (receipt) or a place (ticket, offered, cancelled, status), and the
// offer's scheduled notices of that trigger.
function queueNotice(p) {
    const kind = text(p.kind)
    const suffix = text(p.suffix)
    if (kind === "receipt") {
        const reservation = one(RESERVATION, {reservationId: text(p.recordId)})
        if (!reservation) return {}
        const policy = one(POLICY, {registrationPolicyId: reservation.registrationPolicyId})
        const state = places().stateOfReservation(reservation, policy).state
        if (["expired", "held"].includes(state)) return {}
        queue(
            "evreg-receipt:" + reservation.reservationId + ":" + state + (suffix ? ":" + suffix : ""),
            reservation.buyerPartyId,
            buyerAddress(reservation),
            policy
        )
        return {}
    }
    const row = one(REGISTRATION, {registrationId: text(p.recordId)})
    if (!row) return {}
    const policy = one(POLICY, {registrationPolicyId: row.registrationPolicyId})
    const reservation = row.reservationId ? one(RESERVATION, {reservationId: row.reservationId}) : null
    const key = "evreg-" + kind + ":" + row.registrationId + (suffix ? ":" + suffix : "")
    if (kind === "ticket") {
        // the attendee's own address, else the buyer's
        const attendee = addressOfParty(row.attendeePartyId)
        const recipient = attendee ? row.attendeePartyId : reservation?.buyerPartyId
        queue(key, recipient, attendee || (reservation ? buyerAddress(reservation) : null), policy)
        scheduled(row, policy, "EctConfirmed")
    } else if (["offered", "cancelled", "status"].includes(kind)) {
        if (reservation) queue(key + ":" + row.statusId, reservation.buyerPartyId, buyerAddress(reservation), policy)
        if (kind === "cancelled") scheduled(row, policy, "EctCancelled")
    }
    return {}
}
// An offer's current schedules of a trigger queued for one place (each recipient its own delivery).
function scheduled(row, policy, triggerEnumId, keySuffix = "") {
    const schedules = rows(SCHEDULE, {registrationPolicyId: policy.registrationPolicyId, triggerEnumId}).filter(schedule =>
        lib.active(schedule)
    )
    for (const schedule of schedules) {
        const reservation = row.reservationId ? one(RESERVATION, {reservationId: row.reservationId}) : null
        const targets = []
        if (["EcrAttendee", "EcrBoth"].includes(schedule.recipientScopeEnumId) && row.attendeePartyId)
            targets.push({partyId: row.attendeePartyId, to: addressOfParty(row.attendeePartyId)})
        if (
            ["EcrBuyer", "EcrBoth"].includes(schedule.recipientScopeEnumId) &&
            reservation &&
            reservation.buyerPartyId !== row.attendeePartyId
        )
            targets.push({partyId: reservation.buyerPartyId, to: buyerAddress(reservation)})
        for (const target of targets) {
            const promotional = schedule.purposeEnumId === "MtpPromotional"
            try {
                queue(
                    "evreg-schedule:" + schedule.scheduleId + ":" + row.registrationId + keySuffix,
                    target.partyId,
                    target.to,
                    policy,
                    promotional
                        ? {
                              transactional: false,
                              marketingPurposeEnumId: "PcpMarketingEmail",
                              consentOrganizationPartyId: policy.organizationPartyId,
                              consentContactMechId: target.to?.contactMechId || null
                          }
                        : {}
                )
            } catch (error) {
                ec.logger.error(
                    "Registration " +
                        row.registrationId +
                        " notice " +
                        schedule.scheduleId +
                        ": " +
                        String(error?.message || error).split("\n")[0]
                )
                ec.message.clearErrors()
            }
        }
    }
}
// run#RegistrationNotices (the job): the time-driven schedules due now (before the start, after the end) and the moved occurrences'
// notices, for each confirmed place of a published or closed offer whose occurrence is near; each place apart.
function runNotices(p) {
    let queued = 0
    const offers = Array.from(
        find(POLICY)
            .condition("statusId", "in", ["ErpPublished", "ErpClosed"])
            .condition("occurrenceEnd", "greater-equals", new Date(nowMs() - 60 * DAY))
            .limit(Number(p.limit || 500))
            .list()
    )
    for (const policy of offers) {
        try {
            const schedules = rows(SCHEDULE, {registrationPolicyId: policy.registrationPolicyId}).filter(schedule =>
                lib.active(schedule)
            )
            if (!schedules.length) continue
            const workEffort = one(WORK_EFFORT, {workEffortId: policy.workEffortId})
            if (!workEffort || workEffort.statusId === "WeCancelled") continue
            const occurrence = setup().occurrenceOf(workEffort, ms(policy.occurrenceStart))
            const start = occurrence?.start ?? ms(policy.occurrenceStart)
            const end = occurrence?.end ?? ms(policy.occurrenceEnd)
            const at = nowMs()
            const confirmed = () =>
                rows(REGISTRATION, {registrationPolicyId: policy.registrationPolicyId, statusId: "EvrConfirmed"})
            for (const schedule of schedules) {
                const offset = Number(schedule.offsetMinutes || 0) * 60000
                let due = false,
                    suffix = ""
                if (schedule.triggerEnumId === "EctBeforeStart") due = at >= start - offset && at < start
                else if (schedule.triggerEnumId === "EctAfterEnd") due = at >= end + offset && at < end + offset + 7 * DAY
                else if (schedule.triggerEnumId === "EctChanged") {
                    // the occurrence moved from the start the offer was made for: once per new start
                    due = occurrence != null && occurrence.start !== ms(policy.occurrenceStart) && at < occurrence.end
                    suffix = ":" + (occurrence?.start ?? "")
                }
                if (!due) continue
                for (const row of confirmed())
                    try {
                        ec.transaction.runRequireNew(null, "Registration notice " + schedule.scheduleId, () => {
                            scheduledOne(row, policy, schedule, suffix)
                            queued++
                        })
                    } catch (error) {
                        ec.logger.error(
                            "Registration " +
                                row.registrationId +
                                " notice " +
                                schedule.scheduleId +
                                ": " +
                                String(error?.message || error).split("\n")[0]
                        )
                    }
            }
        } catch (error) {
            ec.logger.error(
                "Registration offer " +
                    policy.registrationPolicyId +
                    " notices: " +
                    String(error?.message || error).split("\n")[0]
            )
        }
    }
    return {queued}
}
function scheduledOne(row, policy, schedule, suffix) {
    const saved = rows(SCHEDULE, {registrationPolicyId: policy.registrationPolicyId, triggerEnumId: schedule.triggerEnumId})
    if (!saved.some(other => other.scheduleId === schedule.scheduleId)) return
    scheduled(row, policy, schedule.triggerEnumId, suffix)
}

// ===== build#RegistrationDelivery =====
const MESSAGES = {
    confirmed: ["Your registration is confirmed", "Your registration for {title} on {when} is confirmed."],
    pending: [
        "Payment received: awaiting the organizer's confirmation",
        "We have your payment for {title} on {when}. The organizer confirms the registration next; your ticket follows then."
    ],
    waitlisted: [
        "You are on the waitlist",
        "There were no places left for {title} on {when}, so you are on its waitlist. We write when a place is yours."
    ],
    review: [
        "Your payment arrived after the hold ended",
        "Your payment for {title} arrived after the places were released, so no place was taken. The organizer will refund it or offer a place."
    ],
    cancelled: ["Your registration is cancelled", "Your registration for {title} on {when} is cancelled."],
    offered: [
        "A place is yours",
        "A place for {title} on {when} came free from the waitlist. Complete your registration before {holdEnd} to keep it."
    ],
    ticket: ["Your ticket", "Your ticket for {title} on {when}."]
}
const fill = (words, values) => L(words).replace(/\{(\w+)\}/g, (all, name) => values[name] ?? "")
// The link to MyRegistration: a capability of the reservation (view and cancel) made for this attempt, its token only here.
function registrationLink(reservation) {
    try {
        const made = externalAccess().create({
            recordType: "EventRegistration",
            recordId: reservation.reservationId,
            scopes: ["RegistrationView", "RegistrationCancel"],
            validDays: 366
        })
        return made.url || null
    } catch (error) {
        ec.logger.warn("Registration " + reservation.reservationId + " link: " + String(error?.message || error).split("\n")[0])
        ec.message.clearErrors()
        return null
    }
}
function eventFacts(policy) {
    const workEffort = one(WORK_EFFORT, {workEffortId: policy.workEffortId})
    const view = setup().publicFacts(policy)
    return {workEffort, title: view.title, when: view.whenText, where: view.where, online: !!workEffort?.infoUrl}
}
function buildDelivery(p) {
    const delivery = one("mantle.party.MessageDelivery", {deliveryId: text(p.deliveryId)})
    if (!delivery || delivery.sourceEnumId !== SOURCE) return {suppress: "The delivery is gone"}
    const [prefix, recordId, third, ...rest] = String(delivery.eventKey || "").split(":")
    const kind = prefix.replace(/^evreg-/, "")
    let reservation = null,
        row = null,
        schedule = null
    if (kind === "receipt") reservation = one(RESERVATION, {reservationId: recordId})
    else if (kind === "schedule") {
        schedule = one(SCHEDULE, {scheduleId: recordId})
        row = one(REGISTRATION, {registrationId: third})
    } else row = one(REGISTRATION, {registrationId: recordId})
    if (row && !reservation && row.reservationId) reservation = one(RESERVATION, {reservationId: row.reservationId})
    const policy = one(POLICY, {registrationPolicyId: (row || reservation)?.registrationPolicyId})
    if (!policy || policy.organizationPartyId !== delivery.organizationPartyId)
        return {suppress: "The registration is not available"}
    const facts = eventFacts(policy)
    if (facts.workEffort?.statusId === "WeCancelled" && kind !== "cancelled") return {suppress: "The event is cancelled"}
    const values = {title: facts.title, when: facts.when}
    const lines = []
    let subject, intro
    if (kind === "receipt") {
        const state = places().stateOfReservation(reservation, policy).state
        if (state !== third) return {suppress: "The registration changed"}
        ;[subject, intro] = MESSAGES[state] || MESSAGES.confirmed
        const link = registrationLink(reservation)
        if (link) lines.push({label: L("Your registration"), url: link})
    } else if (kind === "ticket") {
        if (row.statusId !== "EvrConfirmed") return {suppress: "The place is not confirmed"}
        ;[subject, intro] = MESSAGES.ticket
        const issued = places().issueCode(row.registrationId)
        if (issued) lines.push({label: L("Entry code"), text: issued.code})
        if (facts.online && facts.workEffort.infoUrl) lines.push({label: L("Join online"), url: facts.workEffort.infoUrl})
        if (reservation) {
            const link = registrationLink(reservation)
            if (link) lines.push({label: L("Your registration"), url: link})
        }
    } else if (kind === "offered") {
        if (!places().holdLive(row)) return {suppress: "The offer ended"}
        ;[subject, intro] = MESSAGES.offered
        values.holdEnd = lib.dateText(row.holdExpireDate)
        const link = reservation ? registrationLink(reservation) : null
        if (link) lines.push({label: L("Complete your registration"), url: link})
    } else if (kind === "cancelled") {
        if (row.statusId !== "EvrCancelled") return {suppress: "The place is not cancelled"}
        ;[subject, intro] = MESSAGES.cancelled
        if (row.refundStatusEnumId === "ErfRequested" || row.refundStatusEnumId === "ErfPending")
            lines.push({
                label: L("Refund"),
                text: L("Your refund is being processed; it shows on your registration until it is done.")
            })
    } else if (kind === "status") {
        const state = {EvrPending: "pending", EvrWaitlisted: "waitlisted"}[row.statusId]
        if (!state) return {suppress: "Nothing to tell"}
        ;[subject, intro] = MESSAGES[state]
    } else if (kind === "schedule") {
        if (!schedule || !lib.active(schedule)) return {suppress: "The notice ended"}
        const cancelledNotice = schedule.triggerEnumId === "EctCancelled"
        if (!row || (cancelledNotice ? row.statusId !== "EvrCancelled" : row.statusId !== "EvrConfirmed"))
            return {suppress: "The place changed"}
        if (
            policy.statusId === "ErpClosed" &&
            !cancelledNotice &&
            schedule.triggerEnumId !== "EctAfterEnd" &&
            schedule.triggerEnumId !== "EctBeforeStart"
        )
            return {suppress: "The offer is closed"}
        const template = one("mantle.party.MessageTemplate", {messageTemplateId: schedule.messageTemplateId})
        const content = template ? templates().currentOf(templates().contentsOf(template.messageTemplateId)) : null
        if (!template || template.organizationPartyId !== policy.organizationPartyId || !content)
            return {suppress: "The notice's template is not published"}
        const rendered = templates().render(content, {
            eventTitle: facts.title,
            eventDate: facts.when,
            eventPlace: facts.where,
            attendeeName: places().partyName(row.attendeePartyId),
            ticketName: places().ticketName(row.ticketTypeId)
        })
        if (row.statusId === "EvrConfirmed" && facts.online && facts.workEffort.infoUrl)
            lines.push({label: L("Join online"), url: facts.workEffort.infoUrl})
        return compose(rendered.subject || facts.title, rendered.body || "", rendered.bodyText || "", lines)
    } else return {suppress: "Unknown notice"}
    const heading = fill(intro, values)
    return compose(
        L(subject) + ": " + facts.title,
        "<p>" + esc(heading) + "</p>" + (facts.where ? "<p>" + esc(facts.where) + "</p>" : ""),
        heading + (facts.where ? "\n" + facts.where : ""),
        lines
    )
}
function compose(subject, bodyHtml, bodyText, lines) {
    const html =
        bodyHtml +
        lines
            .map(line =>
                line.url
                    ? '<p><a href="' + esc(line.url) + '">' + esc(line.label) + "</a></p>"
                    : "<p><strong>" + esc(line.label) + ":</strong> " + esc(line.text) + "</p>"
            )
            .join("")
    const plain =
        String(bodyText || bodyHtml.replace(/<[^>]*>/g, "")).trim() +
        "\n\n" +
        lines.map(line => line.label + ": " + (line.url || line.text)).join("\n") +
        "\n"
    return {bodyParameters: {}, subject: String(subject).slice(0, 250), body: html, bodyText: plain}
}

;({
    afterCommit,
    execute(op, parameters) {
        const operations = {queueNotice, runNotices, buildDelivery}
        if (!Object.hasOwn(operations, op)) throw new Error("Unknown event registration notice operation " + op)
        const wasDisabled = ec.artifactExecution.disableAuthz()
        try {
            return operations[op](parameters || {})
        } finally {
            if (!wasDisabled) ec.artifactExecution.enableAuthz()
        }
    }
})
