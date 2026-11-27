// Guest location shares for a record (mr-moqui plans/Location-Sharing.md §3.7; LocationShareServices.xml): the person on
// a service visit shares their own location with the record's customer by a guest link, for the visit only. The share
// is the framework's (org.moqui.maps.LocationServices create#Share with a link audience, made as the caller: only the
// person's act starts it, §1), the record and its planned end named on it (store#ShareRecord), so that the share never
// runs past the record's end and the record's completion stops it (stop#RecordShares, by end#RecordGuestShares from the
// WorkEffort EECA). Two steps, so that the customer hears of nothing the technician has not confirmed: create#RecordGuestShare
// makes the share and answers its link once; send#RecordGuestLink mails that link to the customer by the record's
// organization (MANTLE_LOCATION_GUEST_LINK) once the technician's app has confirmed the share (or at once, in a browser,
// where the press is the confirmation), checking the link against the share's own. The mail's EmailMessage row stays for
// the mail queue, and blank#RecordGuestLinkMail (the LocationShare EECA) blanks the link's secret from its body when the
// share ends or is stopped. Nothing here logs the link.
//
// Records: a Maintenance work order (recordType workOrder, a root WorkEffort with its MaintenanceWorkOrder) to which the
// caller is assigned (a current WorkEffortParty of role Assignee) with MAINTENANCE_EXECUTE or MAINTENANCE_SUPERVISE,
// open, with a planned end (estimatedCompletionDate) not yet past that the share does not pass, and a customer: a
// customer repair's claim customer. A delivery (recordType delivery) is refused (RECORD_KIND_NOT_READY) until the
// warehouse trips (mr-boss WH-TRIP) give a Delivery its driver and status: today it has neither, and no permission names it.
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const maintenanceAccess = ec.resource.script("component://mr-mantle/service/mantle/work/MaintenanceAccess.js")
const {one, denied, ms} = lib

const WORK = "mantle.work.effort.WorkEffort"
const ORDER = "mantle.work.maintenance.MaintenanceWorkOrder"
const SHARE = "moqui.maps.LocationShare"
const AUDIENCE = "moqui.maps.LocationShareAudience"
const MESSAGE = "moqui.basic.email.EmailMessage"
const ADAPTER_KEY = "maintenanceWorkOrder"
const TEMPLATE = "MANTLE_LOCATION_GUEST_LINK"
const SHARES = "org.moqui.maps.LocationServices."
const DONE = ["WeComplete", "WeClosed", "WeCancelled"]
const MINUTE = 60000
// what a selector or secret is (the framework's randomString letters)
const LINK_PART = /^[A-Za-z0-9_-]{8,64}$/
const ENDED_SECRET = "ended"

const blank = value => value == null || String(value).trim() === ""
const text = value => (blank(value) ? null : String(value).trim())
const L = words => ec.l10n.localize(words)
const encode = value =>
    String(value == null ? "" : value).replace(/[&<>"']/g, ch => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"})[ch])
const find = entity => ec.entity.find(entity).disableAuthz()

/** A service called as the caller (withAuthz) or as the system; its errors thrown with its reason code. */
function call(name, parameters, withAuthz) {
    const builder = ec.service.sync().name(name).parameters(parameters || {})
    const out = (withAuthz ? builder : builder.disableAuthz()).call() || {}
    if (ec.message.hasError()) {
        const message = ec.message.getErrorsString()
        ec.message.clearErrors()
        denied(out.reasonCode || "SHARE_REFUSED", message)
    }
    return out
}

function partyName(partyId) {
    if (!partyId) return ""
    const person = one("mantle.party.Person", {partyId})
    if (person) return [person.firstName, person.lastName].filter(Boolean).join(" ")
    const organization = one("mantle.party.Organization", {partyId})
    return organization?.organizationName || partyId
}
const emailOf = partyId =>
    partyId ? call("mantle.party.ContactServices.get#PrimaryEmailAddress", {partyId}).emailAddress || null : null

/** The caller is assigned to the root as its Assignee, by a current row: no other role shares a location for the visit. */
function assignee(rootId) {
    const partyId = ec.user.userAccount?.partyId
    if (!partyId) return false
    return (
        find("mantle.work.effort.WorkEffortParty")
            .condition({workEffortId: rootId, partyId, roleTypeId: "Assignee"})
            .conditionDate("fromDate", "thruDate", null)
            .count() > 0
    )
}

/** The work order the caller is on, checked: {root, organizationPartyId, plannedEnd, customerPartyId}. */
function workOrderFor(workEffortId) {
    if (!ec.user.userId) denied("PERMISSION_DENIED", "Sign in first")
    const userScope = maintenanceAccess.scope()
    const work = maintenanceAccess.requireWork(userScope, text(workEffortId))
    const rootId = work.rootWorkEffortId
    const root = one(WORK, {workEffortId: rootId})
    const order = root ? one(ORDER, {workEffortId: rootId}) : null
    if (!root || !order) denied("RECORD_UNAVAILABLE", "Work order " + rootId + " is not available")
    // the person on the visit: only they share where they are (§1, "Only by the person's act")
    const caps = userScope.capabilities
    if (!((caps.execute || caps.supervise) && assignee(rootId)))
        denied("NOT_ASSIGNED", "Only the technician assigned to the work order shares their location with its customer")
    if (DONE.includes(root.statusId)) denied("WORK_CLOSED", "Work order " + rootId + " is no longer open")
    const plannedEnd = ms(root.estimatedCompletionDate)
    if (plannedEnd == null) denied("NO_PLANNED_END", "Work order " + rootId + " has no planned end: schedule it first")
    if (plannedEnd <= ms(ec.user.nowTimestamp))
        denied("OVERDUE", "Work order " + rootId + " is past its planned end: schedule it again to share your location")
    // a customer repair's customer (its warranty claim's); other work orders have no customer to tell
    let customerPartyId = null
    if (order.sourceEnumId === "MsrcWarranty" && order.assetMaintenanceId) {
        const warranty = ec.resource.script("component://mr-mantle/service/mantle/request/Warranty.js")
        const wasDisabled = ec.artifactExecution.disableAuthz()
        try {
            customerPartyId = warranty.repairSummary(order.assetMaintenanceId)?.customerPartyId || null
        } finally {
            if (!wasDisabled) ec.artifactExecution.enableAuthz()
        }
    }
    if (!customerPartyId) denied("NO_CUSTOMER", "Work order " + rootId + " has no customer to share your location with")
    return {root, organizationPartyId: work.organizationPartyId, plannedEnd, customerPartyId}
}

/** This server's https web root, the start of the link: the conf's host, or the request's only where a root-screen
 * pattern names it as one of the configured sites; never a parameter. */
function siteRoot() {
    const root = ec.web ? String(ec.web.getWebappRootUrl("webroot", null, true, true) || "") : ""
    return root.replace(/\/+$/, "") || null
}

/** The zone the customer reads the mail in: the customer's account's, else the organization's working time. */
function zoneFor(customerPartyId, organizationPartyId) {
    const account = find("moqui.security.UserAccount").condition("partyId", customerPartyId).selectField("timeZone").list()
    const own = Array.from(account).map(row => text(row.timeZone)).find(Boolean)
    if (own) return own
    const time = ec.resource.script("component://mr-mantle/service/mantle/work/BusinessTime.js")
    return (organizationPartyId ? time.scheduleOf({partyId: organizationPartyId}).timeZone : null) || null
}

/** Whether the mail server the template sends by has a host to send to: else the mail waits in the queue. */
function mailServerReady() {
    const template = one("moqui.basic.email.EmailTemplate", {emailTemplateId: TEMPLATE})
    const server = template?.emailServerId ? one("moqui.basic.email.EmailServer", {emailServerId: template.emailServerId}) : null
    return !!(server && text(server.smtpHost))
}

/**
 * create#RecordGuestShare: the caller's own location shared by a guest link for the record's customer, until thruDate
 * (after now, no later than the record's planned end), the record and its end named on the share. The link is answered
 * this once and mailed by send#RecordGuestLink only.
 */
function createShare(p) {
    const kind = text(p.recordType)
    if (kind === "delivery")
        denied("RECORD_KIND_NOT_READY", "A delivery has no driver or status yet: share your location from Maps until it has")
    if (kind !== "workOrder") denied("RECORD_KIND_UNKNOWN", "Share your location for a work order")
    const record = workOrderFor(p.recordId)
    const now = ms(ec.user.nowTimestamp)
    // an end not given: the planned end, within location@max-share-hours of now
    const maxHours = Number(ec.factory.getConfValue("location@max-share-hours")) || 24
    const until = ms(p.thruDate) ?? Math.min(record.plannedEnd, now + maxHours * 3600000)
    if (until <= now) denied("BAD_UNTIL", "The share ends after now")
    if (until > record.plannedEnd)
        denied("END_AFTER_PLANNED", "The share ends no later than the work order's planned end")
    const root = siteRoot()
    if (!root) denied("NO_SITE_ROOT", "This server's web address is not known: the link cannot be made")
    // the framework's share, as the caller: only their act starts it (plans/Location-Sharing.md §1); its link is made with
    // it, so the app's own confirmation names "anyone with the guest link" among whom it reaches
    const made = call(
        SHARES + "create#Share",
        {
            audienceList: [{audienceTypeEnumId: "LsaLink"}],
            thruDate: new Date(Math.floor(until / MINUTE) * MINUTE),
            precisionEnumId: text(p.precisionEnumId) || "LspExact",
            label: text(p.label) || null,
            purposeText: text(p.purposeText)
        },
        true
    )
    call(SHARES + "store#ShareRecord", {
        shareId: made.shareId,
        recordAdapterKey: ADAPTER_KEY,
        recordKey: JSON.stringify({workEffortId: record.root.workEffortId}),
        recordThruDate: new Date(record.plannedEnd)
    })
    return {shareId: made.shareId, thruDate: made.thruDate, linkUrl: root + made.linkPath}
}

/** The mails that carry a link, by its selector: the template's rows whose body holds the guest page's path. */
// The whole selector in the LIKE: it holds no "%" or "\" (randomString's letters), and a "_" in it, LIKE's one-character
// wildcard, matches at most a mail of another selector differing there, which the exact match here leaves out.
const mailsOf = selector =>
    Array.from(
        find(MESSAGE)
            .condition("emailTemplateId", TEMPLATE)
            .condition("body", "like", "%/location/" + selector + "#%")
            .list()
    ).filter(row => String(row.body || "").includes("/location/" + selector + "#"))

/**
 * send#RecordGuestLink: the link of a guest share of the caller's own, for a record, mailed to the record's customer: the
 * share active, its record checked again, the secret the share's own link's, and not mailed before.
 */
function sendLink(p) {
    if (!ec.user.userId) denied("PERMISSION_DENIED", "Sign in first")
    // locked, so two sends at once cannot both mail the link: the second waits, then finds the first's mail
    const share = find(SHARE).condition("shareId", text(p.shareId) || "").forUpdate(true).one()
    if (!share || share.ownerUserId !== ec.user.userId || share.recordAdapterKey !== ADAPTER_KEY)
        denied("SHARE_NOT_FOUND", "Location share not found")
    const now = ms(ec.user.nowTimestamp)
    if (share.revokedDate != null || share.endedDate != null || ms(share.thruDate) <= now) denied("SHARE_ENDED", "This share has ended")
    let recordKey = null
    try {
        recordKey = JSON.parse(share.recordKey)
    } catch (err) {
        recordKey = null
    }
    const record = workOrderFor(recordKey?.workEffortId)
    const link = find(AUDIENCE).condition({shareId: share.shareId, audienceTypeEnumId: "LsaLink"}).condition("revokedDate", null).one()
    const secret = text(p.linkSecret) || ""
    if (!link || !LINK_PART.test(secret) || ec.user.singleUseCodeHash(link.tokenSelector + "." + secret) !== link.tokenDigest)
        denied("LINK_MISMATCH", "That is not this share's link")
    if (mailsOf(link.tokenSelector).length) denied("ALREADY_SENT", "The link went to the customer already")
    const root = siteRoot()
    if (!root) denied("NO_SITE_ROOT", "This server's web address is not known: the link cannot be made")
    const linkUrl = root + "/location/" + link.tokenSelector + "#" + secret
    const to = emailOf(record.customerPartyId)
    if (!to) return {mailSent: false, mailReason: "NO_CUSTOMER_EMAIL"}
    const organizationName = partyName(record.organizationPartyId)
    // the organization's address, else no-reply at this server's own host (the web root's: the conf's, or a configured
    // site's; never a parameter)
    const host = /^https?:\/\/([^/:]+)/.exec(root)?.[1]
    const fromAddress = emailOf(record.organizationPartyId) || (host ? "no-reply@" + host : null)
    if (!fromAddress) return {mailSent: false, mailReason: "NO_SENDER"}
    const sharer = partyName(ec.user.userAccount?.partyId) || ec.user.username
    const zone = zoneFor(record.customerPartyId, record.organizationPartyId)
    const untilText = ec.l10n.format(new Date(ms(share.thruDate)), "EEE HH:mm z", null, zone)
    const recordText = L("work order") + " " + (record.root.workEffortName || record.root.workEffortId)
    const subject = L("Where your technician is now") + " · " + organizationName
    const body =
        "<p>" + encode(L("Hello") + " " + partyName(record.customerPartyId) + ",") + "</p>" +
        "<p>" + encode(sharer + " " + L("of") + " " + organizationName + " " + L("is on the way for") + " " + recordText + ". " +
            L("This link shows where they are until") + " " + untilText + ".") + "</p>" +
        (share.purposeText ? "<p>" + encode(share.purposeText) + "</p>" : "") +
        '<p><a href="' + encode(linkUrl) + '">' + encode(L("See where they are")) + "</a></p>" +
        "<p>" + encode(L("Do not forward this mail: anyone with the link sees the location until the visit ends.")) + "</p>"
    ec.message.pushErrors()
    try {
        ec.service
            .sync()
            .name("org.moqui.mail.EmailServices.send#EmailTemplate")
            .parameters({emailTemplateId: TEMPLATE, toAddresses: to, bodyParameters: {subject, fromAddress, fromName: organizationName}, body})
            .requireNewTransaction(true)
            .disableAuthz()
            .call()
        if (ec.message.hasError()) {
            ec.logger.warn("Location guest link of work order " + record.root.workEffortId + " was not mailed: " + ec.message.getErrorsString())
            return {mailSent: false, mailReason: "MAIL_FAILED"}
        }
        // a server with no host to send to keeps the mail in its queue: not sent now
        return mailServerReady() ? {mailSent: true, mailReason: null} : {mailSent: false, mailReason: "NO_MAIL_SERVER"}
    } catch (err) {
        ec.logger.warn("Location guest link of work order " + record.root.workEffortId + " was not mailed: " + (err && err.message ? err.message : err))
        return {mailSent: false, mailReason: "MAIL_FAILED"}
    } finally {
        ec.message.clearErrors()
        ec.message.popErrors()
    }
}

/** end#RecordGuestShares: a work order completed, closed or cancelled ends its guest shares (the WorkEffort EECA). */
function endShares(p) {
    const workEffortId = text(p.workEffortId)
    if (!workEffortId) return {stoppedCount: 0}
    // never fails the status change it follows (an import's, a job's): an error is logged and left there
    try {
        const out =
            ec.service
                .sync()
                .name(SHARES + "stop#RecordShares")
                .parameters({recordAdapterKey: ADAPTER_KEY, recordKey: JSON.stringify({workEffortId})})
                .disableAuthz()
                .call() || {}
        return {stoppedCount: Number(out.stoppedCount) || 0}
    } catch (err) {
        ec.logger.error("Guest location shares of work order " + workEffortId + " were not stopped: " + (err && err.message ? err.message : err))
        return {stoppedCount: 0}
    } finally {
        ec.message.clearErrors()
    }
}

/**
 * blank#RecordGuestLinkMail: a guest share for a record has ended or was stopped, or its link alone was taken out (the
 * LocationShare and LocationShareAudience EECAs): the link's secret is blanked from the body of every mail that carried
 * it, which stays for the mail queue. Never fails the end.
 */
function blankMail(p) {
    let blanked = 0
    try {
        // the share's links, or the one link revoked (audienceSeqId)
        let links = find(AUDIENCE).condition({shareId: text(p.shareId) || "", audienceTypeEnumId: "LsaLink"})
        if (text(p.audienceSeqId)) links = links.condition("audienceSeqId", text(p.audienceSeqId))
        links = Array.from(links.list())
        for (const link of links) {
            if (!link.tokenSelector) continue
            const pattern = new RegExp("/location/" + link.tokenSelector + "#[A-Za-z0-9_-]+", "g")
            for (const mail of mailsOf(link.tokenSelector)) {
                const replace = value => (value == null ? value : String(value).replace(pattern, "/location/" + link.tokenSelector + "#" + ENDED_SECRET))
                mail.body = replace(mail.body)
                mail.bodyText = replace(mail.bodyText)
                mail.update()
                blanked++
            }
        }
    } catch (err) {
        ec.logger.error("The mail of guest location share " + p.shareId + " was not blanked: " + (err && err.message ? err.message : err))
    } finally {
        ec.message.clearErrors()
    }
    return {blankedCount: blanked}
}

const operations = {createShare, sendLink, endShares, blankMail}
;({
    execute(op, parameters) {
        if (!operations[op]) throw new Error("Unknown location record share operation " + op)
        return operations[op](parameters || {})
    },
    ADAPTER_KEY
})
