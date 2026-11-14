/* CC0 1.0 Universal plus Grant of Patent License. See LICENSE.md.
 * The bounce intake (mantle.party.MessageServices process#DeliveryReport, run#DeliveryReports, find#DeliveryReceipts; the email
 * ECA DeliveryReportIntake and the EmailMessage ECA DeliveryReportEdgeBounce; design-marketing §15.1, §15.2; impl-marketing P6,
 * F14, F18, F76; Comms' owner contract, because every source of the ledger can bounce).
 *
 * - Two paths: a report (a DSN, RFC 3464, or an abuse report, ARF RFC 5965) a bounce account received (another mailbox's message is
 *   never read or recorded), read with the framework's read#DeliveryReport (its report part and returned message, never its body
 *   text), whose VERP address bounces+(delivery).(key)@ (the address it came to, or an ARF's Original-Mail-From) finds the delivery
 *   only with the delivery's random key (anyone can mail the bounce address and delivery ids are a sequence, so a forged report
 *   must not suppress an address by a guessed id; P6 review), else the returned message's random Message-ID; a DSN counts only
 *   the recipients that are the delivery's own address (an ARF's Original-Rcpt-To is often redacted, so its key binds it); and a sent
 *   message an edge relay marked ES_BOUNCED (the edge replaces the envelope sender with its own, so the VERP key is lost there,
 *   F76), matched to its delivery by the attempt that sent it.
 * - What it records: a failed recipient with a permanent status (5.x.x) or the edge's bounce is a hard bounce; a failed one with a
 *   transient status, or a delayed one, a soft bounce; a delivered or relayed one a delivery; an abuse report (any feedback type but
 *   not-spam) a complaint. Each is a receipt fact of the delivery once per kind (MessageDeliveryReceipt), the delivery's strongest
 *   fact never moved back by a weaker one, its hand-off state untouched. A hard bounce adds one suppression of the address for every
 *   organization, a complaint one for the delivery's organization (store#Suppression's rule: an active block is answered, never
 *   doubled); a soft bounce or a delivery suppresses nothing.
 * - Each message is read once (MessageDeliveryReport, one row a message): read again it changes nothing. An unknown key or an
 *   unreadable report is recorded and logged and left in its mailbox; one that fails is retried by the poll (run#DeliveryReports,
 *   five tries), and the rest go on.
 * Internal: the intake runs as the system; nothing here is remote.
 */
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const suppressions = ec.resource.script("component://mr-mantle/service/mantle/party/MessageSuppressions.js")
const {find, one, call, ms} = lib
const D = "mantle.party.MessageDelivery"
const ATTEMPT = "mantle.party.MessageDeliveryAttempt"
const RECEIPT = "mantle.party.MessageDeliveryReceipt"
const REPORT = "mantle.party.MessageDeliveryReport"
const MESSAGE = "moqui.basic.email.EmailMessage"
const ranks = {MdrDelivered: 1, MdrSoftBounce: 2, MdrHardBounce: 3, MdrComplaint: 4}
const limits = {tries: 5, batch: 200, days: 30}
const text = value => (value == null ? "" : String(value).trim())
const nowMs = () => ms(ec.user.nowTimestamp)

// The delivery id and random key of a VERP address bounces+(id).(key)@ any domain, or null.
function verpKey(address) {
    const match = /^bounces\+([A-Za-z0-9_-]{1,40})\.([A-Za-z0-9]{8,40})@[^@\s]+$/i.exec(text(address).replace(/^.*<|>.*$/g, ""))
    return match ? {deliveryId: match[1], bounceKey: match[2]} : null
}
// The delivery a report names: by its VERP address with the delivery's own random key (anyone can mail the bounce address, so an
// id alone, which is a sequence, names nothing; P6 review), else by the returned message's Message-ID (random, known only to who
// saw the message).
function deliveryOf(addresses, originalMessageId) {
    for (const address of addresses) {
        const key = verpKey(address)
        if (!key) continue
        const delivery = one(D, {deliveryId: key.deliveryId})
        if (delivery && text(delivery.bounceKey) && delivery.bounceKey === key.bounceKey) return delivery
    }
    if (text(originalMessageId)) return find(D, {providerMessageId: text(originalMessageId)}).one() || null
    return null
}
// The address of a delivery or of a report's recipient field, as compared: lower case, without its type and angle brackets.
const addressKey = value =>
    text(value)
        .replace(/^[^;]*;/, "")
        .replace(/^.*<|>.*$/g, "")
        .trim()
        .toLowerCase()
// A DSN's recipients that are the delivery's own address (Final- or Original-Recipient): a report about another address says
// nothing of this delivery, so it never suppresses the delivery's address (P6 review).
const recipientsOf = (recipients, delivery) =>
    recipients.filter(recipient =>
        [recipient.finalRecipient, recipient.originalRecipient].some(
            value => addressKey(value) && addressKey(value) === addressKey(delivery.toAddress)
        )
    )
// What a DSN says of the delivery: the worst of its recipients' facts, with the detail.
function dsnFact(recipients) {
    let fact = null
    let detail = ""
    for (const recipient of recipients) {
        const status = text(recipient.status)
        const action = text(recipient.action).toLowerCase()
        const kind =
            action === "failed"
                ? status.startsWith("5")
                    ? "MdrHardBounce"
                    : "MdrSoftBounce"
                : action === "delayed"
                  ? "MdrSoftBounce"
                  : action === "delivered" || action === "relayed"
                    ? "MdrDelivered"
                    : null
        if (!kind) continue
        if (!fact || ranks[kind] > ranks[fact]) {
            fact = kind
            detail = [status, text(recipient.diagnosticCode)].filter(Boolean).join(" ")
        }
    }
    return {fact, detail: detail.slice(0, 255)}
}
// The organization a delivery is from: its own, else its store's.
function organizationOf(delivery) {
    if (delivery.organizationPartyId) return delivery.organizationPartyId
    if (delivery.productStoreId)
        return one("mantle.product.store.ProductStore", {productStoreId: delivery.productStoreId})?.organizationPartyId || null
    return null
}
// A receipt fact of a delivery, once per kind; the delivery's strongest fact moves only forward. {recorded}.
function recordReceipt(delivery, receiptEnumId, reportId, detail) {
    if (one(RECEIPT, {deliveryId: delivery.deliveryId, receiptEnumId})) return {recorded: false}
    call("create#" + RECEIPT, {
        deliveryId: delivery.deliveryId,
        receiptEnumId,
        receiptDate: ec.user.nowTimestamp,
        reportId,
        detail: detail || null
    })
    const locked = find(D, {deliveryId: delivery.deliveryId}).forUpdate(true).one()
    if (!locked.receiptEnumId || ranks[receiptEnumId] > (ranks[locked.receiptEnumId] || 0))
        call("update#" + D, {deliveryId: delivery.deliveryId, receiptEnumId, receiptDate: ec.user.nowTimestamp})
    return {recorded: true}
}
// The suppression a hard bounce or a complaint makes: one block of the delivery's address (store#Suppression's rule, as the
// intake: an active block of the same address, organization and reason is answered).
function suppress(delivery, receiptEnumId, reportId, detail) {
    const destination = text(delivery.toAddress)
    if (!suppressions.normalize(delivery.channelEnumId || "MdcEmail", destination)) return null
    const hard = receiptEnumId === "MdrHardBounce"
    return suppressions.addFromIntake({
        channelEnumId: delivery.channelEnumId || "MdcEmail",
        destination,
        organizationPartyId: hard ? null : organizationOf(delivery),
        reasonEnumId: hard ? "MsrHardBounce" : "MsrComplaint",
        sourceRef: "delivery " + delivery.deliveryId + " report " + reportId,
        evidenceText: (hard ? "Hard bounce" : "Complaint") + " of delivery " + delivery.deliveryId + (detail ? ": " + detail : "")
    })
}
// The report row of a message, made or taken for this read.
function reportRow(emailMessageId, kind, received) {
    const existing = find(REPORT, {emailMessageId}).forUpdate(true).one()
    if (existing) return existing
    const made = call("create#" + REPORT, {
        emailMessageId,
        reportKindEnumId: kind,
        statusEnumId: "MrsFailed",
        attempts: 0,
        receivedDate: received || ec.user.nowTimestamp
    })
    return one(REPORT, {reportId: made.reportId})
}
function finish(row, values) {
    call(
        "update#" + REPORT,
        Object.assign(
            {reportId: row.reportId, attempts: Number(row.attempts || 0) + 1, processedDate: ec.user.nowTimestamp},
            values,
            {reasonText: values.reasonText ? String(values.reasonText).slice(0, 255) : null}
        )
    )
    return {
        reportId: row.reportId,
        statusEnumId: values.statusEnumId,
        deliveryId: values.deliveryId || null,
        receiptEnumId: values.receiptEnumId || null
    }
}
// process#DeliveryReport: one message read as a report and applied once.
function process(p) {
    const emailMessageId = text(p.emailMessageId)
    const message = emailMessageId ? one(MESSAGE, {emailMessageId}) : null
    if (!message) {
        ec.logger.warn("Delivery report intake: email message " + emailMessageId + " is not there")
        return {statusEnumId: "MrsUnreadable"}
    }
    const known = one(REPORT, {emailMessageId})
    if (known && known.statusEnumId !== "MrsFailed")
        return {
            reportId: known.reportId,
            statusEnumId: known.statusEnumId,
            deliveryId: known.deliveryId,
            receiptEnumId: known.receiptEnumId,
            duplicate: true
        }
    // the edge's path: a sent message of a template the edge relay marked bounced, matched by the attempt that sent it (F76)
    const edge = message.statusId === "ES_BOUNCED" && !message.emailAccountId
    // a received report is read only from a bounce account: another mailbox's message is left alone and nothing is recorded of it
    if (!edge && !(message.emailAccountId && bounceAccountIds().includes(message.emailAccountId))) {
        ec.logger.info("Delivery report intake: email message " + emailMessageId + " is no bounce account's; left")
        return {statusEnumId: "MrsIgnored", notBounceAccount: true}
    }
    const row = reportRow(emailMessageId, edge ? "MrkEdge" : "MrkDsn", message.receivedDate || message.sentDate)
    if (edge) {
        const attempt = find(ATTEMPT, {emailMessageId}).orderBy("-attemptSeqId").one()
        const delivery =
            (attempt && one(D, {deliveryId: attempt.deliveryId})) ||
            (text(message.messageId) ? find(D, {providerMessageId: text(message.messageId)}).one() : null)
        if (!delivery) {
            ec.logger.info("Delivery report intake: bounced message " + emailMessageId + " is no delivery's; left")
            return finish(row, {statusEnumId: "MrsUnknownKey", reasonText: "No delivery sent this message"})
        }
        return apply(row, delivery, "MrkEdge", "MdrHardBounce", ("The edge relay: " + text(message.sendError)).slice(0, 255))
    }
    const read = call("org.moqui.mail.EmailServices.read#DeliveryReport", {emailMessageId})
    const reportType = text(read.reportType)
    if (!reportType) {
        ec.logger.warn(
            "Delivery report intake: email message " + emailMessageId + " is not a delivery or abuse report; left in its mailbox"
        )
        return finish(row, {statusEnumId: "MrsUnreadable", reasonText: "Not a delivery status or abuse report"})
    }
    const addresses =
        reportType === "arf"
            ? [text(read.originalMailFrom)].concat(Array.from(read.deliveredToList || []))
            : Array.from(read.deliveredToList || [])
    const delivery = deliveryOf(addresses, read.originalMessageId)
    const kindEnumId = reportType === "arf" ? "MrkArf" : "MrkDsn"
    if (!delivery) {
        ec.logger.warn("Delivery report intake: report " + emailMessageId + " names no known delivery; left in its mailbox")
        return finish(row, {
            reportKindEnumId: kindEnumId,
            statusEnumId: "MrsUnknownKey",
            reasonText: "No delivery has this report's key"
        })
    }
    if (reportType === "arf") {
        const feedbackType = text(read.feedbackType).toLowerCase()
        if (feedbackType === "not-spam")
            return finish(row, {
                reportKindEnumId: kindEnumId,
                deliveryId: delivery.deliveryId,
                statusEnumId: "MrsIgnored",
                reasonText: "A not-spam report"
            })
        return apply(row, delivery, kindEnumId, "MdrComplaint", ("Abuse report: " + (feedbackType || "abuse")).slice(0, 255))
    }
    const recipients = Array.from(read.recipientList || [])
    const own = recipientsOf(recipients, delivery)
    if (recipients.length && !own.length)
        return finish(row, {
            reportKindEnumId: kindEnumId,
            deliveryId: delivery.deliveryId,
            statusEnumId: "MrsIgnored",
            reasonText: "The report is about another recipient"
        })
    const {fact, detail} = dsnFact(own)
    if (!fact)
        return finish(row, {
            reportKindEnumId: kindEnumId,
            deliveryId: delivery.deliveryId,
            statusEnumId: "MrsIgnored",
            reasonText: "The report names no outcome"
        })
    return apply(row, delivery, kindEnumId, fact, detail)
}
function apply(row, delivery, kindEnumId, receiptEnumId, detail) {
    const {recorded} = recordReceipt(delivery, receiptEnumId, row.reportId, detail)
    let suppressed = null
    if (receiptEnumId === "MdrHardBounce" || receiptEnumId === "MdrComplaint")
        suppressed = suppress(delivery, receiptEnumId, row.reportId, detail)
    const changed = recorded || !!suppressed?.created
    return finish(row, {
        reportKindEnumId: kindEnumId,
        deliveryId: delivery.deliveryId,
        receiptEnumId,
        statusEnumId: changed ? "MrsApplied" : "MrsNoChange",
        reasonText: detail
    })
}
// One message in a transaction of its own; a failure is logged and kept failed for the poll to try again, and the rest go on.
function processApart(emailMessageId) {
    ec.message.pushErrors()
    try {
        const out =
            ec.service
                .sync()
                .name("mantle.party.MessageServices.process#DeliveryReport")
                .parameters({emailMessageId})
                .disableAuthz()
                .requireNewTransaction(true)
                .call() || {}
        if (ec.message.hasError()) throw new Error(ec.message.getErrorsString())
        return out
    } catch (error) {
        ec.logger.error("Delivery report " + emailMessageId + " was not processed: " + String(error.message).split("\n")[0])
        try {
            const row = find(REPORT, {emailMessageId}).one()
            ec.message.clearErrors()
            if (row)
                call("update#" + REPORT, {
                    reportId: row.reportId,
                    attempts: Number(row.attempts || 0) + 1,
                    reasonText: String(error.message).slice(0, 255)
                })
        } catch (inner) {
            ec.message.clearErrors()
        }
        return {statusEnumId: "MrsFailed"}
    } finally {
        ec.message.clearErrors()
        ec.message.popErrors()
    }
}
// The bounce accounts: the hosted and shared mail accounts bounces@ a sending profile's bounce domain. Only their messages are
// read as reports: a report in anyone else's mailbox is their own mail, never read or recorded here (P6 review).
function bounceAccountIds() {
    const profiles = ec.resource.script("component://mr-mantle/service/mantle/party/MessageSendingProfiles.js")
    const domains = new Set(
        Array.from(find("mantle.party.MessageSendingProfile").selectField("bounceDomain").list())
            .map(row => text(row.bounceDomain).toLowerCase())
            .filter(Boolean)
    )
    const ids = []
    for (const domain of domains) {
        const account = profiles.bounceAccount(domain)
        if (account && !ids.includes(account.emailAccountId)) ids.push(account.emailAccountId)
    }
    return ids
}
// run#DeliveryReports (the poll job run_DeliveryReports): the messages of the bounce accounts and the messages the edge marked
// bounced in the last 30 days that were not read, or failed with tries left, each in its own transaction.
function run(p) {
    const since = new Date(nowMs() - limits.days * 24 * 3600 * 1000)
    const limit = Math.max(1, Math.min(1000, Number(p.limit || limits.batch)))
    const candidates = []
    const accounts = bounceAccountIds()
    if (accounts.length)
        for (const row of Array.from(
            find(MESSAGE)
                .condition("emailAccountId", "in", accounts)
                .condition("receivedDate", "greater-equals", since)
                .selectField("emailMessageId")
                .orderBy("receivedDate")
                .limit(limit * 2)
                .list()
        ))
            candidates.push(row.emailMessageId)
    for (const row of Array.from(
        find(MESSAGE, {statusId: "ES_BOUNCED"})
            .condition("emailAccountId", "equals", null)
            .condition("lastUpdatedStamp", "greater-equals", since)
            .selectField("emailMessageId")
            .limit(limit * 2)
            .list()
    ))
        if (find(ATTEMPT, {emailMessageId: row.emailMessageId}).count() > 0) candidates.push(row.emailMessageId)
    let read = 0,
        applied = 0,
        failed = 0
    for (const emailMessageId of candidates) {
        if (read >= limit) break
        const known = one(REPORT, {emailMessageId})
        if (known && (known.statusEnumId !== "MrsFailed" || Number(known.attempts || 0) >= limits.tries)) continue
        read++
        const out = processApart(emailMessageId)
        if (out.statusEnumId === "MrsApplied") applied++
        else if (out.statusEnumId === "MrsFailed") failed++
    }
    return {read, applied, failed}
}
// handle#BouncedMessage (the EmailMessage ECA DeliveryReportEdgeBounce): a template's sent message turning ES_BOUNCED is read after
// the write commits, in a transaction of its own; never fails the write.
function handleBounced(p) {
    const emailMessageId = text(p.emailMessageId)
    if (!emailMessageId) return {}
    try {
        ec.service
            .special()
            .name("mantle.party.MessageServices.process#DeliveryReport")
            .parameters({emailMessageId})
            .registerOnCommit()
        return {afterCommit: true}
    } catch (error) {
        // no transaction in place: the write is committed already
        processApart(emailMessageId)
        return {afterCommit: false}
    }
}
// find#DeliveryReceipts: a delivery's receipt facts and the reports read for it, for a reader of the ledger's deliveries
// (MESSAGE_DELIVERY_REVIEW, MESSAGE_SUPPRESSION_REVIEW or a contact administrator); no address.
function receipts(p) {
    const access = lib.access
    if (
        !["MESSAGE_DELIVERY_REVIEW", "MESSAGE_SUPPRESSION_REVIEW", "CONTACT_ADMIN"].some(permission => access.has(permission)) &&
        !access.systemAdmin()
    )
        lib.denied("PERMISSION_DENIED", "Reading delivery receipts needs MESSAGE_DELIVERY_REVIEW")
    const delivery = one(D, {deliveryId: text(p.deliveryId)})
    // a reader reads the deliveries of the organizations they work for (every internal one with MARKETING_ALL_ORGANIZATIONS); another's
    // answers as missing (P6 review). Marketing P9: MESSAGE_DELIVERY_REVIEW, now a dispatcher's too, reads every organization's for a
    // system administrator only
    const everyOrganization = access.systemAdmin() || access.has("MARKETING_ALL_ORGANIZATIONS")
    const reachable =
        !!delivery &&
        (everyOrganization ||
            (!!organizationOf(delivery) &&
                ec.resource
                    .script("component://mr-mantle/service/mantle/marketing/MarketingAccess.js")
                    .memberOrganizations()
                    .memberPartyIds.includes(organizationOf(delivery))))
    if (!reachable) lib.denied("RECORD_UNAVAILABLE", "Delivery " + text(p.deliveryId) + " is not available")
    // a remote server's diagnostic often names the address: never in this answer
    const noAddress = value => String(value || "").replace(/[^\s<>()\[\];:,"']+@[^\s<>()\[\];:,"']+/g, "[address]")
    const enumText = enumId => (enumId ? one("moqui.basic.Enumeration", {enumId})?.description || enumId : "")
    return {
        deliveryId: delivery.deliveryId,
        stateEnumId: delivery.stateEnumId,
        receiptEnumId: delivery.receiptEnumId || null,
        receiptText: enumText(delivery.receiptEnumId),
        receiptList: Array.from(find(RECEIPT, {deliveryId: delivery.deliveryId}).orderBy("receiptDate").list()).map(row => ({
            receiptEnumId: row.receiptEnumId,
            receiptText: enumText(row.receiptEnumId),
            receiptDate: row.receiptDate,
            detail: noAddress(row.detail)
        })),
        reportList: Array.from(find(REPORT, {deliveryId: delivery.deliveryId}).orderBy("receivedDate").list()).map(row => ({
            reportId: row.reportId,
            kindText: enumText(row.reportKindEnumId),
            statusText: enumText(row.statusEnumId),
            receivedDate: row.receivedDate
        }))
    }
}

const operations = {process, run, handleBounced, receipts}
;({
    verpKey,
    dsnFact,
    execute: (op, parameters) => {
        if (!Object.hasOwn(operations, op)) throw new Error("Unknown delivery report operation " + op)
        return operations[op](parameters || {})
    }
})
