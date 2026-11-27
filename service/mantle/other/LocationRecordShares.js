// Guest location shares for a record (mr-moqui plans/Location-Sharing.md §3.7; LocationShareServices.xml): the person on
// a service visit shares their own location with the record's customer by a guest link, for the visit only. The share
// is the framework's (org.moqui.maps.LocationServices create#Share with a link audience, made as the caller: only the
// person's act starts it, §1), the record named on it (store#ShareRecord) so that the record's end stops it
// (stop#RecordShares, by end#RecordGuestShares from the WorkEffort EECA), and the link mailed to the customer by the
// record's organization (MANTLE_LOCATION_GUEST_LINK). The link is the guest page's, /location/<selector>#<secret>:
// nothing here logs it or keeps it beyond the mail itself.
//
// Records: a Maintenance work order (recordType workOrder, a root WorkEffort with its MaintenanceWorkOrder) on which the
// caller is assigned with MAINTENANCE_EXECUTE (or MAINTENANCE_SUPERVISE), open, with a planned end
// (estimatedCompletionDate) the share does not pass, and a customer: a customer repair's claim customer. A delivery
// (recordType delivery) is refused (RECORD_KIND_NOT_READY) until the warehouse trips (mr-boss WH-TRIP) give a Delivery
// its driver and status: today it has neither, and no permission names it.
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const maintenanceAccess = ec.resource.script("component://mr-mantle/service/mantle/work/MaintenanceAccess.js")
const {one, denied, ms} = lib

const WORK = "mantle.work.effort.WorkEffort"
const ORDER = "mantle.work.maintenance.MaintenanceWorkOrder"
const ADAPTER_KEY = "maintenanceWorkOrder"
const TEMPLATE = "MANTLE_LOCATION_GUEST_LINK"
const SHARES = "org.moqui.maps.LocationServices."
const DONE = ["WeComplete", "WeClosed", "WeCancelled"]
const MINUTE = 60000

const blank = value => value == null || String(value).trim() === ""
const text = value => (blank(value) ? null : String(value).trim())
const L = words => ec.l10n.localize(words)
const encode = value =>
    String(value == null ? "" : value).replace(/[&<>"']/g, ch => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"})[ch])

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
    if (!((caps.execute || caps.supervise) && maintenanceAccess.assignment(userScope, rootId).root))
        denied("NOT_ASSIGNED", "Only a technician assigned to the work order shares their location with its customer")
    if (DONE.includes(root.statusId)) denied("WORK_CLOSED", "Work order " + rootId + " is no longer open")
    const plannedEnd = ms(root.estimatedCompletionDate)
    if (plannedEnd == null) denied("NO_PLANNED_END", "Work order " + rootId + " has no planned end: schedule it first")
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

/** The site root the link starts with: the caller's, else this server's web root. */
function siteRoot(baseUrl) {
    const given = text(baseUrl)
    if (given && /^https?:\/\/[^/\s]+$/.test(given.replace(/\/+$/, ""))) return given.replace(/\/+$/, "")
    const root = ec.web ? String(ec.web.getWebappRootUrl("webroot", null, true, false) || "") : ""
    return root.replace(/\/+$/, "") || null
}

/** The link mailed to the customer by the record's organization; false when it could not be (its reason logged, never the link). */
function mailLink(record, linkUrl, until, recordText) {
    const to = emailOf(record.customerPartyId)
    if (!to) return {mailSent: false, mailReason: "NO_CUSTOMER_EMAIL"}
    const organizationName = partyName(record.organizationPartyId)
    const host = /^https?:\/\/([^/:]+)/.exec(linkUrl)?.[1]
    const fromAddress = emailOf(record.organizationPartyId) || (host ? "no-reply@" + host : null)
    if (!fromAddress) return {mailSent: false, mailReason: "NO_SENDER"}
    const sharer = partyName(ec.user.userAccount?.partyId) || ec.user.username
    const untilText = ec.l10n.format(new Date(until), "EEE HH:mm", null, ec.user.timeZone)
    const subject = L("Where your technician is now") + " · " + organizationName
    const body =
        "<p>" + encode(L("Hello") + " " + partyName(record.customerPartyId) + ",") + "</p>" +
        "<p>" + encode(sharer + " " + L("of") + " " + organizationName + " " + L("is on the way for") + " " + recordText + ". " +
            L("This link shows where they are until") + " " + untilText + ".") + "</p>" +
        (record.purposeText ? "<p>" + encode(record.purposeText) + "</p>" : "") +
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
        return {mailSent: true, mailReason: null}
    } catch (err) {
        ec.logger.warn("Location guest link of work order " + record.root.workEffortId + " was not mailed: " + (err && err.message ? err.message : err))
        return {mailSent: false, mailReason: "MAIL_FAILED"}
    } finally {
        ec.message.clearErrors()
        ec.message.popErrors()
    }
}

/**
 * create#RecordGuestShare: the caller's own location shared by a guest link with the record's customer, until thruDate
 * (after now, no later than the record's planned end), the record named on the share, the link mailed to the customer.
 */
function createShare(p) {
    const kind = text(p.recordType)
    if (kind === "delivery")
        denied("RECORD_KIND_NOT_READY", "A delivery has no driver or status yet: share your location from Maps until it has")
    if (kind !== "workOrder") denied("RECORD_KIND_UNKNOWN", "Share your location for a work order")
    const record = workOrderFor(p.recordId)
    const now = ms(ec.user.nowTimestamp)
    const until = ms(p.thruDate) ?? record.plannedEnd
    if (until <= now) denied("BAD_UNTIL", "The share ends after now")
    if (until > record.plannedEnd)
        denied("END_AFTER_PLANNED", "The share ends no later than the work order's planned end")
    const root = siteRoot(p.baseUrl)
    if (!root) denied("NO_SITE_ROOT", "This server's web address is not known: the link cannot be made")
    record.purposeText = text(p.purposeText)
    const recordText = L("work order") + " " + (record.root.workEffortName || record.root.workEffortId)
    // the framework's share, as the caller: only their act starts it (plans/Location-Sharing.md §1)
    const made = call(
        SHARES + "create#Share",
        {
            audienceList: [{audienceTypeEnumId: "LsaLink"}],
            thruDate: new Date(Math.floor(until / MINUTE) * MINUTE),
            precisionEnumId: text(p.precisionEnumId) || "LspExact",
            label: text(p.label) || null,
            purposeText: record.purposeText
        },
        true
    )
    call(SHARES + "store#ShareRecord", {
        shareId: made.shareId,
        recordAdapterKey: ADAPTER_KEY,
        recordKey: JSON.stringify({workEffortId: record.root.workEffortId})
    })
    const linkUrl = root + made.linkPath
    const mailed = mailLink(record, linkUrl, ms(made.thruDate) ?? until, recordText)
    return Object.assign({shareId: made.shareId, thruDate: made.thruDate, linkUrl}, mailed)
}

/** end#RecordGuestShares: a work order completed, closed or cancelled ends its guest shares (the EECA). */
function endShares(p) {
    const workEffortId = text(p.workEffortId)
    if (!workEffortId) return {stoppedCount: 0}
    const out = ec.service
        .sync()
        .name(SHARES + "stop#RecordShares")
        .parameters({recordAdapterKey: ADAPTER_KEY, recordKey: JSON.stringify({workEffortId})})
        .disableAuthz()
        .call() || {}
    return {stoppedCount: Number(out.stoppedCount) || 0}
}

const operations = {createShare, endShares}
;({
    execute(op, parameters) {
        if (!operations[op]) throw new Error("Unknown location record share operation " + op)
        return operations[op](parameters || {})
    },
    ADAPTER_KEY
})
