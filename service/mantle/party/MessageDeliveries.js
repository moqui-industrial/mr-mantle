/* CC0 1.0 Universal plus Grant of Patent License. See LICENSE.md.
 * The one outbound delivery ledger (design-crosscut CX-DELIVERY, X8; Comms' contract built with mr-pass impl-shop P6, F24),
 * generalized from the Forum's ForumDelivery and DeliveryWorker: a source queues one delivery per event, recipient, channel
 * and template key; each attempt runs in a transaction of its own through send#EmailTemplate and records its outcome.
 *
 * - Sources: a MessageDeliverySource enumeration whose enumCode names the source's build service, called before each
 *   attempt with {deliveryId, eventKey, recipientPartyId}; it answers the template's bodyParameters (fresh: a link's token is
 *   made for the send and never stored here), or suppress with a reason when the event no longer holds (a refunded item). A
 *   source with no build service sends the parameters it queued (no secret among them).
 * - Consent: a transactional notice (the recipient's own purchase) needs no marketing consent and its snapshot says so; any
 *   other needs its purpose granted (get#PartyConsentState) at the hand-off, else it is suppressed. The snapshot is kept.
 * - Outcomes: a Message-ID is sent; retryable is tried again with backoff (five tries, then failed); permanent is failed;
 *   anything else is uncertain and waits for review: never a blind resend.
 * Reads and writes are the authority's own (authorization disabled); only Mantle services call these.
 */
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const {find, one, rows, call, ms} = lib
const D = "mantle.party.MessageDelivery"
const ATTEMPT = "mantle.party.MessageDeliveryAttempt"
const limits = {tries: 5, batch: 200, maxBackoffMinutes: 60}
const text = value => (value == null ? "" : String(value).trim())
const nowMs = () => ms(ec.user.nowTimestamp)

// queue: one delivery per event, recipient, channel and template key (an existing one is answered, never a second);
// sendNow tries it at once in its own transaction. {deliveryId, created, stateEnumId}.
function queue(p) {
    const key = {
        eventKey: text(p.eventKey),
        recipientPartyId: text(p.recipientPartyId),
        channelEnumId: p.channelEnumId || "MdcEmail",
        templateKey: text(p.templateKey)
    }
    if (!key.eventKey || !key.recipientPartyId || !key.templateKey)
        throw new Error("A delivery needs its event, recipient and template")
    const source = one("moqui.basic.Enumeration", {enumId: p.sourceEnumId})
    if (!source || source.enumTypeId !== "MessageDeliverySource") throw new Error("Unknown delivery source " + p.sourceEnumId)
    const existing = one(D, key)
    if (existing) return {deliveryId: existing.deliveryId, created: false, stateEnumId: existing.stateEnumId}
    // the delivery is kept in a transaction of its own, so its attempts (each their own) see it; a source whose event does
    // not hold by then answers suppress from its build
    const made = createApart(
        "create#" + D,
        Object.assign({}, key, {
            sourceEnumId: p.sourceEnumId,
            toAddress: text(p.toAddress) || null,
            siteId: p.siteId || null,
            productStoreId: p.productStoreId || null,
            transactional: p.transactional === false || p.transactional === "N" ? "N" : "Y",
            consentJson: p.marketingPurposeEnumId ? JSON.stringify({purposeEnumId: p.marketingPurposeEnumId}) : null,
            parametersJson: p.bodyParameters ? JSON.stringify(p.bodyParameters) : null,
            stateEnumId: "MdsQueued",
            attempts: 0,
            nextAttemptDate: ec.user.nowTimestamp,
            createdDate: ec.user.nowTimestamp
        })
    )

    let stateEnumId = "MdsQueued"
    if (p.sendNow === true || p.sendNow === "true") stateEnumId = attemptNow(made.deliveryId).stateEnumId
    return {deliveryId: made.deliveryId, created: true, stateEnumId}
}
function createApart(name, parameters) {
    const out = ec.service.sync().name(name).parameters(parameters).disableAuthz().requireNewTransaction(true).call() || {}
    if (ec.message.hasError()) throw new Error(ec.message.getErrorsString())
    return out
}
// One attempt in a transaction of its own; a failure of the step itself is logged and the delivery stays due.
function attemptNow(deliveryId) {
    ec.message.pushErrors()
    try {
        const out =
            ec.service
                .sync()
                .name("mantle.party.MessageServices.attempt#Delivery")
                .parameters({deliveryId})
                .disableAuthz()
                .requireNewTransaction(true)
                .call() || {}
        if (ec.message.hasError()) throw new Error(ec.message.getErrorsString())
        return {stateEnumId: out.stateEnumId || null}
    } catch (error) {
        ec.logger.error("Message delivery " + deliveryId + " attempt failed: " + String(error.message).split("\n")[0])
        return {stateEnumId: null}
    } finally {
        ec.message.clearErrors()
        ec.message.popErrors()
    }
}
// The consent snapshot at the hand-off: transactional, or the marketing purpose's state for the recipient.
function consentOf(delivery) {
    const at = ec.l10n.format(ec.user.nowTimestamp, "yyyy-MM-dd'T'HH:mm:ssZ")
    if (delivery.transactional !== "N") return {transactional: true, at}
    const purposeEnumId = lib.json(delivery.consentJson, {})?.purposeEnumId || "PcpMarketingEmail"
    let granted = false
    try {
        const state = call("mantle.party.ConsentServices.get#PartyConsentState", {partyId: delivery.recipientPartyId})
        granted = Array.from(state.grantedPurposeEnumIds || []).includes(purposeEnumId)
    } catch (error) {
        ec.message.clearErrors()
        granted = false
    }
    return {transactional: false, purposeEnumId, granted, at}
}
// attempt#Delivery: the delivery locked; a queued or retrying one is built by its source, its consent snapshotted, and
// handed to send#EmailTemplate; the outcome recorded with the attempt. A sent, failed, suppressed or uncertain one is left.
function attemptStep(p) {
    const delivery = find(D, {deliveryId: p.deliveryId}).forUpdate(true).one()
    if (!delivery || !["MdsQueued", "MdsRetry"].includes(delivery.stateEnumId)) return {stateEnumId: delivery?.stateEnumId}
    const attempts = Number(delivery.attempts || 0) + 1
    const consent = consentOf(delivery)
    const record = (stateEnumId, outcome, values = {}) => {
        call(
            "update#" + D,
            Object.assign({deliveryId: delivery.deliveryId, stateEnumId, attempts, consentJson: JSON.stringify(consent)}, values)
        )
        call("create#" + ATTEMPT, {
            deliveryId: delivery.deliveryId,
            attemptSeqId: String(attempts).padStart(3, "0"),
            attemptDate: ec.user.nowTimestamp,
            outcome,
            providerMessageId: values.providerMessageId || null,
            emailMessageId: values.emailMessageId || null,
            error: values.lastError || null
        })
        return {stateEnumId}
    }
    if (!consent.transactional && !consent.granted)
        return record("MdsSuppressed", "suppressed", {lastError: "No consent for this message"})
    const source = one("moqui.basic.Enumeration", {enumId: delivery.sourceEnumId})
    let built
    try {
        built = source?.enumCode
            ? call(source.enumCode, {
                  deliveryId: delivery.deliveryId,
                  eventKey: delivery.eventKey,
                  recipientPartyId: delivery.recipientPartyId
              })
            : {bodyParameters: lib.json(delivery.parametersJson, {})}
    } catch (error) {
        ec.message.clearErrors()
        return record("MdsFailed", "permanent", {
            lastError: ("The message could not be made: " + String(error.message).split("\n")[0]).slice(0, 255)
        })
    }
    if (built.suppress) return record("MdsSuppressed", "suppressed", {lastError: text(built.suppress).slice(0, 255) || null})
    const toAddress = text(built.toAddress) || text(delivery.toAddress)
    if (!toAddress) return record("MdsFailed", "permanent", {lastError: "The recipient has no address"})
    let out
    try {
        out =
            ec.service
                .sync()
                .name("org.moqui.impl.EmailServices.send#EmailTemplate")
                .parameters({
                    emailTemplateId: delivery.templateKey,
                    toAddresses: toAddress,
                    bodyParameters: built.bodyParameters || {},
                    ...(built.extraHeaders ? {extraHeaders: built.extraHeaders} : {})
                })
                .call() || {}
        if (ec.message.hasError()) {
            const message = ec.message.getErrorsString()
            ec.message.clearErrors()
            if (!out.deliveryOutcome) out = Object.assign({}, out, {deliveryOutcome: "permanent", sendError: message})
        }
    } catch (error) {
        ec.message.clearErrors()
        return record("MdsFailed", "permanent", {lastError: ("Not sent: " + String(error.message).split("\n")[0]).slice(0, 255)})
    }
    return recordOutcome(delivery, attempts, out, record)
}
// The outcome of a hand-off: a Message-ID sent; retryable again later (until the tries are used); permanent failed;
// anything else uncertain, for review (design-crosscut CX-DELIVERY: an ambiguous send is never repeated on its own).
function recordOutcome(delivery, attempts, out, record) {
    const error = text(out.sendError).slice(0, 255) || null
    if (out.messageId)
        return record("MdsSent", "sent", {
            providerMessageId: String(out.messageId).slice(0, 255),
            emailMessageId: out.emailMessageId || null,
            sentDate: ec.user.nowTimestamp,
            lastError: null
        })
    if (out.deliveryOutcome === "retryable") {
        if (attempts >= limits.tries)
            return record("MdsFailed", "retryable", {lastError: error || "Not accepted after several tries"})
        const minutes = Math.min(limits.maxBackoffMinutes, Math.pow(2, attempts))
        return record("MdsRetry", "retryable", {
            nextAttemptDate: new Date(nowMs() + minutes * 60000),
            lastError: error || "The mail server could not be reached; tried again later"
        })
    }
    if (out.deliveryOutcome === "permanent")
        return record("MdsFailed", "permanent", {lastError: error || "The provider refused it"})
    return record("MdsUncertain", "uncertain", {
        emailMessageId: out.emailMessageId || null,
        lastError: error || "The provider's acceptance is unknown"
    })
}
// receipt: a provider's later report of a delivery's last hand-off (a delivery report, a bounce): its outcome recorded as an
// attempt's would be, so an accepted one is sent, a refused one failed and an unknown one kept for review.
function receipt(p) {
    const delivery = find(D, {deliveryId: p.deliveryId}).forUpdate(true).one()
    if (!delivery) throw new Error("Unknown delivery " + p.deliveryId)
    const attempts = Number(delivery.attempts || 0) + 1
    const record = (stateEnumId, outcome, values = {}) => {
        call("update#" + D, Object.assign({deliveryId: delivery.deliveryId, stateEnumId, attempts}, values))
        call("create#" + ATTEMPT, {
            deliveryId: delivery.deliveryId,
            attemptSeqId: String(attempts).padStart(3, "0"),
            attemptDate: ec.user.nowTimestamp,
            outcome: "receipt:" + outcome,
            providerMessageId: values.providerMessageId || null,
            error: values.lastError || null
        })
        return {stateEnumId}
    }
    return recordOutcome(delivery, attempts, p.out || {}, record)
}
// run#Deliveries (the run_MessageDeliveries job): queued and retrying deliveries that are due, oldest first, each in its
// own transaction; an uncertain one is never picked. {attempted, sent, failed}.
function runDeliveries(p) {
    const due = Array.from(
        find(D)
            .condition("stateEnumId", "in", ["MdsQueued", "MdsRetry"])
            .condition("nextAttemptDate", "less-equals", ec.user.nowTimestamp)
            .orderBy("nextAttemptDate")
            .limit(Number(p.limit || limits.batch))
            .list()
    )
    let sent = 0,
        failed = 0
    for (const row of due) {
        const out = attemptNow(row.deliveryId)
        if (out.stateEnumId === "MdsSent") sent++
        else if (!out.stateEnumId || out.stateEnumId === "MdsFailed") failed++
    }
    return {attempted: due.length, sent, failed}
}
// resolve#Delivery (a reviewer's decision on an uncertain delivery): sent (the provider shows it), failed, or tried again.
function resolveDelivery(p) {
    const delivery = find(D, {deliveryId: p.deliveryId}).forUpdate(true).one()
    if (!delivery || delivery.stateEnumId !== "MdsUncertain") throw new Error("Only an uncertain delivery is resolved")
    const states = {sent: "MdsSent", failed: "MdsFailed", retry: "MdsRetry"}
    const stateEnumId = states[p.outcome]
    if (!stateEnumId) throw new Error("Choose sent, failed or retry")
    call("update#" + D, {
        deliveryId: delivery.deliveryId,
        stateEnumId,
        nextAttemptDate: stateEnumId === "MdsRetry" ? ec.user.nowTimestamp : delivery.nextAttemptDate,
        lastError: text(p.note).slice(0, 255) || delivery.lastError
    })
    return {stateEnumId}
}
// The deliveries of an event (a source's own view of what went out), newest first.
const ofEvent = eventKey => rows(D, {eventKey}).sort((a, b) => (ms(b.createdDate) ?? 0) - (ms(a.createdDate) ?? 0))

const operations = {queue, attempt: attemptStep, receipt, runDeliveries, resolveDelivery}
;({
    limits,
    ofEvent,
    execute: (op, parameters) => {
        if (!operations[op]) throw new Error("Unknown message delivery operation " + op)
        return operations[op](parameters || {})
    }
})
