// Resource booking decisions (IronStone Maintenance design §7.1 approval, BookingRequests; design-drawers-commons' ResourceBooking
// approval kind; MT-07, MT-01, MT-11; impl-maintenance P16, F15): the first path that moves a requested booking (a WorkEffortFacility
// WefRequested, a WorkEffortAssetAssign WeaaRequested) to assigned or denied, and the notices around it.
//
// - find (find#ResourceBookingRequests): the bookings waiting for a decision, of the resources a booking approver approves now
//   (RESOURCE_BOOKING_VIEW_ASSIGNED or _APPROVE), or of the scope's resources for a policy reader or supervisor, read only. Each
//   with its resource, the event's span now, the organizer, its purpose when the user may open the event (else "Not shared with
//   you"), the requester's notes, the policy in words, the assigned bookings it clashes with (an event the user may not see is
//   Busy), how long it has waited, and what a decision must name: the span and state it was decided on.
// - decide (decide#ResourceBooking, and the ResourceBooking topic's approve and refuse services): a current BookingApprover of the
//   resource holding RESOURCE_BOOKING_APPROVE, with the resource locked (the work centers above it first, as every booking write):
//   the booking still requested (STATE_CHANGED), its event's span the one decided on (SPAN_CHANGED: a moved meeting is decided
//   again), and for an approval the availability rechecked by the booking guard: an outage or block, a managed resource's rules,
//   and the assigned bookings it clashes with (CONFLICT; a request waiting holds nothing against the one decided, so two approvers
//   of overlapping requests cannot both assign: the second is answered the conflict). A denial needs its reason (REASON_REQUIRED),
//   kept in the booking's comments. The organizer is told the outcome (ResourceBookingNotice), and the approvers' notices of it
//   leave their inboxes.
// - decideMany (decide#ResourceBookings): each booking decided in its own transaction; a failure is named and the rest go on.
// - notifyRequested: a booking waiting for approval (book#Resource's request, check#ResourceBookings' move) tells the resource's
//   approvers on ResourceBooking, with the span it asks for; an older notice of the same booking leaves their inboxes.
// - tellAffected: an outage or a planned block recorded over bookings tells their organizers (ResourceBookingNotice), with the
//   resource's name and a safe reason only.
// Notices are failure tolerant: one that cannot be sent is logged and the decision stands.
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const maintenanceAccess = ec.resource.script("component://mr-mantle/service/mantle/work/MaintenanceAccess.js")
const policies = () => ec.resource.script("component://mr-mantle/service/mantle/work/ResourcePolicy.js")
const {find, one, call, denied, ms} = lib

const TOPIC = "ResourceBooking"
const NOTICE = "ResourceBookingNotice"
const WORK = "mantle.work.effort.WorkEffort"
const ROOM_BOOKING = "mantle.work.effort.WorkEffortFacility"
const ASSET_BOOKING = "mantle.work.effort.WorkEffortAssetAssign"
const MESSAGE = "moqui.security.user.NotificationMessage"
const MESSAGE_USER = "moqui.security.user.NotificationMessageUser"
const statuses = {
    facility: {requested: "WefRequested", assigned: "WefAssigned", denied: "WefRequestDenied"},
    asset: {requested: "WeaaRequested", assigned: "WeaaAssigned", denied: "WeaaRequestDenied"}
}
const hourMs = 3600000
const dayMs = 24 * hourMs
const scanLimit = 500

const blank = value => value == null || String(value).trim() === ""
const text = value => (blank(value) ? null : String(value).trim())
const yes = value => value === true || value === "true" || value === "Y"
const nowMs = () => ms(ec.user.nowTimestamp)
const dateText = value => (value == null || value === "" ? "" : lib.dateText(value))
const statusText = statusId => (statusId ? one("moqui.basic.StatusItem", {statusId})?.description || statusId : "")

// ===== the booking =====
// The resource key of a call or a notice: exactly one of facilityId and assetId.
function keyOf(p) {
    const facilityId = text(p.facilityId)
    const assetId = text(p.assetId)
    if (!!facilityId === !!assetId) denied("RESOURCE_REQUIRED", "Name the room (facilityId) or the equipment (assetId), one of them")
    return facilityId ? {facilityId, assetId: null, kind: "facility"} : {facilityId: null, assetId, kind: "asset"}
}
// The booking of the resource for the event: a room's one row; equipment's current row (not denied, not ended), else its latest.
function bookingOf(key, workEffortId, lock = false) {
    if (key.kind === "facility") return find(ROOM_BOOKING, {workEffortId, facilityId: key.facilityId}).forUpdate(lock).one()
    const now = nowMs()
    const rows = Array.from(
        find(ASSET_BOOKING, {workEffortId, assetId: key.assetId}).orderBy("-fromDate").forUpdate(lock).list()
    )
    return (
        rows.find(row => row.statusId !== statuses.asset.denied && (row.thruDate == null || ms(row.thruDate) > now)) ||
        rows[0] ||
        null
    )
}
// The event's span now: [startMs, endMs] (an hour when it has no end), or null without a time.
function spanOf(workEffortId) {
    const out =
        ec.service
            .sync()
            .name("mantle.work.WorkEffortServices.get#WorkEffortStartEnd")
            .parameters({workEffortId})
            .disableAuthz()
            .call() || {}
    const start = ms(out.startDate)
    if (start == null) return null
    const end = ms(out.endDate)
    return [start, end != null && end > start ? end : start + hourMs]
}
const spanText = span => (span ? dateText(new Date(span[0])) + " – " + dateText(new Date(span[1])).replace(/^.* /, "") : "")
// The user ids of parties (their accounts that are not disabled).
function userIdsOf(partyIds) {
    if (!partyIds.length) return []
    return Array.from(
        find("moqui.security.UserAccount").condition("partyId", "in", partyIds).selectField("userId,partyId,disabled").list()
    )
        .filter(row => row.disabled !== "Y")
        .map(row => row.userId)
}
const isRecurring = workEffortId =>
    !!one(WORK, {workEffortId})?.recurStartCron || !!one("mantle.work.effort.WorkEffortRecurrence", {workEffortId})

// ===== notices =====
// The unviewed ResourceBooking notices of a booking (of its event and resource) leave every inbox.
function clearNotices(workEffortId, key) {
    try {
        const messageIds = Array.from(
            find(MESSAGE)
                .condition({topic: TOPIC, recordEntityName: WORK, recordId: workEffortId})
                .selectField("notificationMessageId,messageJson")
                .list()
        )
            .filter(row => {
                const message = lib.json(row.messageJson, {}) || {}
                return (message.facilityId || null) === key.facilityId && (message.assetId || null) === key.assetId
            })
            .map(row => row.notificationMessageId)
        if (!messageIds.length) return
        for (const user of Array.from(
            find(MESSAGE_USER).condition("notificationMessageId", "in", messageIds).condition("viewedDate", "is-null", null).list()
        ))
            call("update#" + MESSAGE_USER, {
                notificationMessageId: user.notificationMessageId,
                userId: user.userId,
                viewedDate: ec.user.nowTimestamp
            })
    } catch (error) {
        ec.logger.error("Booking " + workEffortId + ": its approval notices were not cleared: " + error.message)
    }
}
// notifyRequested: the approvers of the resource are told of a booking waiting for them (key: facilityId or assetId).
function notifyRequested(p) {
    try {
        const key = keyOf(p)
        const workEffortId = text(p.workEffortId)
        const resource = policies().resourceOf(key, false, true)
        const userIds = userIdsOf(policies().approversOf(resource)).filter(userId => userId !== ec.user.userId)
        clearNotices(workEffortId, key)
        if (!userIds.length) return 0
        const event = one(WORK, {workEffortId})
        const span = spanOf(workEffortId)
        const requestedByName = policies().partyName(event?.ownerPartyId || ec.user.userAccount?.partyId) || ec.user.username
        const whenText = spanText(span) + (isRecurring(workEffortId) ? " (repeats)" : "")
        ec.makeNotificationMessage()
            .topic(TOPIC)
            .reason("approval")
            .message({
                workEffortId,
                facilityId: key.facilityId,
                assetId: key.assetId,
                resourceName: resource.name,
                fromMs: span ? span[0] : null,
                thruMs: span ? span[1] : null,
                whenText,
                bookingStatusId: statuses[key.kind].requested,
                requestedByName,
                summary: whenText + " · " + requestedByName
            })
            .record(WORK, workEffortId)
            .actorUserId(ec.user.userId)
            .userIds(userIds)
            .send()
        return userIds.length
    } catch (error) {
        ec.logger.error("Booking " + p.workEffortId + ": the approvers' notice was not sent: " + error.message)
        return 0
    }
}
// The organizer of an event is told what became of its booking: outcome approved, denied, moved or conflict, with a safe detail.
function tellOrganizer(workEffortId, resourceName, outcome, outcomeText, detail) {
    try {
        const event = one(WORK, {workEffortId})
        if (!event?.ownerPartyId) return 0
        const userIds = userIdsOf([event.ownerPartyId]).filter(userId => userId !== ec.user.userId)
        if (!userIds.length) return 0
        ec.makeNotificationMessage()
            .topic(NOTICE)
            .message({
                workEffortId,
                workEffortName: event.workEffortName || workEffortId,
                resourceName,
                outcome,
                outcomeText,
                detail: detail || "",
                whenText: spanText(spanOf(workEffortId))
            })
            .record(WORK, workEffortId)
            .actorUserId(ec.user.userId)
            .userIds(userIds)
            .send()
        return userIds.length
    } catch (error) {
        ec.logger.error("Booking " + workEffortId + ": the organizer's notice was not sent: " + error.message)
        return 0
    }
}
// tellAffected: an outage or planned block over bookings (their event ids) tells each organizer, safely: "out of service" or the
// block's reason.
function tellAffected(workEffortIds, resourceName, reasonText) {
    let told = 0
    for (const workEffortId of Array.from(new Set(Array.from(workEffortIds || []))).slice(0, 200))
        told += tellOrganizer(workEffortId, resourceName, "conflict", reasonText, "Your booking is kept; move it or cancel it")
    return told
}

// ===== who decides =====
// Whether the user is a current approver of the resource.
function approves(resource) {
    const partyId = ec.user.userAccount?.partyId
    return !!partyId && policies().approversOf(resource).includes(partyId)
}

// ===== decide#ResourceBooking =====
// decide: approve or deny a requested booking. p: workEffortId, facilityId or assetId, decision (approve, deny), reason (deny),
// expectedStatusId, expectedFromDate and expectedThruDate (the span decided on), allowConflicts with overrideReason (an approval
// over a soft conflict, where the policy allows an override and the user holds it).
function decide(p) {
    if (!ec.user.userId) denied("PERMISSION_DENIED", "Sign in to decide a booking")
    const decision = text(p.decision)
    if (!["approve", "deny"].includes(decision)) denied("DECISION_INVALID", "A booking is approved or denied")
    if (!lib.access.has("RESOURCE_BOOKING_APPROVE")) denied("PERMISSION_DENIED", "RESOURCE_BOOKING_APPROVE is required")
    const workEffortId = text(p.workEffortId)
    if (!workEffortId) denied("RECORD_UNAVAILABLE", "Name the booking's event")
    const key = keyOf(p)
    // the resource locked: the work centers above it, then its row (one decision after the other, and after any booking of it)
    const resource = policies().lockResource(key)
    if (!approves(resource)) denied("NOT_APPROVER", "You do not approve the bookings of " + resource.name)
    const row = bookingOf(key, workEffortId, true)
    const event = one(WORK, {workEffortId})
    if (!row || !event) denied("RECORD_UNAVAILABLE", "There is no booking of " + resource.name + " for that event")
    const wanted = statuses[key.kind]
    const expectedStatusId = text(p.expectedStatusId)
    if (row.statusId !== wanted.requested || event.statusId === "WeCancelled" || (expectedStatusId && expectedStatusId !== row.statusId))
        denied(
            "STATE_CHANGED",
            "The booking of " +
                resource.name +
                " is " +
                (event.statusId === "WeCancelled" ? "cancelled" : statusText(row.statusId).toLowerCase() || "not waiting") +
                " now"
        )
    const span = spanOf(workEffortId)
    if (!span) denied("SPAN_CHANGED", "The meeting has no time now")
    const expectedFrom = ms(p.expectedFromDate)
    const expectedThru = ms(p.expectedThruDate)
    if ((expectedFrom != null && expectedFrom !== span[0]) || (expectedThru != null && expectedThru !== span[1]))
        denied("SPAN_CHANGED", "The meeting moved to " + spanText(span) + ": decide it again")
    let comments = row.comments || null
    let overridden = false
    if (decision === "deny") {
        const reason = text(p.reason)
        if (!reason) denied("REASON_REQUIRED", "Say why the booking is denied")
        comments = "Denied: " + reason + (comments ? "; " + comments : "")
    } else {
        // the availability again, under the lock: blocks, the managed rules and the assigned bookings over the span (a request
        // waiting holds nothing against this one); the series' meetings for a recurring event
        const link = Array.from(
            find("mantle.work.effort.WorkEffortAssoc", {toWorkEffortId: workEffortId, workEffortAssocTypeEnumId: "WeatRecurrenceInstance"})
                .list()
        )[0]
        const own = new Set([workEffortId, link?.workEffortId].filter(Boolean))
        const conflicts = policies()
            .bookingsOver(resource, span[0], span[1])
            .filter(other => !own.has(other.workEffortId) && !own.has(other.recurringEventId))
            .filter(other => other.fromMs < span[1] && other.thruMs > span[0])
            .map(other => ({
                workEffortId: other.workEffortId,
                workEffortName: other.title,
                fromDate: new Date(other.fromMs),
                thruDate: new Date(other.thruMs),
                bookingStatusId: other.bookingStatusId ?? null
            }))
        const guarded = policies().guard(
            Object.assign({}, key, {
                workEffortId,
                startMs: span[0],
                endMs: span[1],
                conflicts,
                allowConflicts: yes(p.allowConflicts),
                overrideReason: text(p.overrideReason),
                own: Array.from(own),
                assignedOnly: true
            })
        )
        if (guarded.refusal) denied(guarded.refusal.code, guarded.refusal.message)
        if (guarded.conflicts.length && !guarded.overridden)
            denied(
                "CONFLICT",
                resource.name +
                    " is booked then: " +
                    guarded.conflicts.map(conflict => conflict.workEffortName).join(", ") +
                    "; deny this request or ask its organizer to move it"
            )
        overridden = guarded.overridden
        if (overridden) comments = "Override: " + text(p.overrideReason) + (comments ? "; " + comments : "")
    }
    const statusId = decision === "approve" ? wanted.assigned : wanted.denied
    row.set("statusId", statusId)
    row.set("comments", comments)
    row.update()
    clearNotices(workEffortId, key)
    const reason = text(p.reason)
    tellOrganizer(
        workEffortId,
        resource.name,
        decision === "approve" ? "approved" : "denied",
        decision === "approve" ? "booking approved" : "booking denied",
        decision === "approve" ? "" : reason
    )
    return {
        workEffortId,
        facilityId: key.facilityId,
        assetId: key.assetId,
        resourceName: resource.name,
        statusId,
        overridden
    }
}
// The ResourceBooking topic's services: the notice's booking decided, on the span and state it was sent with.
function decideNotice(p, decision) {
    const message = p.message && typeof p.message === "object" ? p.message : lib.json(p.message, {}) || {}
    const workEffortId =
        text(p.workEffortId) || (p.recordEntityName && p.recordEntityName !== WORK ? null : text(p.recordId))
    if (!workEffortId) denied("SOURCE_INVALID", "The notice is not a booking's")
    return decide({
        workEffortId,
        facilityId: p.facilityId || message.facilityId || null,
        assetId: p.assetId || message.assetId || null,
        decision,
        reason: p.reason,
        expectedStatusId: message.bookingStatusId || null,
        expectedFromDate: p.expectedFromDate ?? message.fromMs ?? null,
        expectedThruDate: p.expectedThruDate ?? message.thruMs ?? null
    })
}
// decide#ResourceBookings: each booking ({workEffortId, facilityId or assetId, expectedStatusId, expectedFromDate,
// expectedThruDate}, or its key text "facility|id|workEffortId") decided in its own transaction; the outcome of each, the
// failures named and logged.
function decideMany(p) {
    const items = (Array.isArray(p.bookingList) ? p.bookingList : String(p.bookingList || "").split(","))
        .map(item => {
            if (item && typeof item === "object") return item
            const [kind, id, workEffortId, from, thru] = String(item).trim().split("|")
            if (!kind || !id || !workEffortId) return null
            return {
                workEffortId,
                facilityId: kind === "facility" ? id : null,
                assetId: kind === "asset" ? id : null,
                expectedFromDate: from || null,
                expectedThruDate: thru || null
            }
        })
        .filter(Boolean)
        .slice(0, 100)
    if (!items.length) denied("SELECTION_REQUIRED", "Select the bookings to decide")
    const resultList = []
    for (const item of items) {
        const name = item.workEffortId + " (" + (item.facilityId || item.assetId || "") + ")"
        try {
            const out = lib.probe(
                "mantle.work.ResourceBookingServices.decide#ResourceBooking",
                Object.assign({}, item, {decision: p.decision, reason: p.reason})
            )
            resultList.push({
                workEffortId: item.workEffortId,
                facilityId: item.facilityId || null,
                assetId: item.assetId || null,
                ok: true,
                statusId: out.statusId,
                message: (out.resourceName || "") + ": " + statusText(out.statusId)
            })
        } catch (error) {
            const message = String(error?.message || error).replace(/(^|\n)(Error: )+/g, "$1")
            ec.logger.warn("Booking decision " + name + " failed: " + message)
            resultList.push({
                workEffortId: item.workEffortId,
                facilityId: item.facilityId || null,
                assetId: item.assetId || null,
                ok: false,
                reasonCode: lib.reasonCode(error) || lib.reasonCode(message) || "FAILED",
                message
            })
        }
    }
    return {
        resultList,
        decidedCount: resultList.filter(row => row.ok).length,
        failedCount: resultList.filter(row => !row.ok).length
    }
}

// ===== find#ResourceBookingRequests =====
// The bookings of the resources the user approves (or, for a policy reader or supervisor, of the scope's resources, read only),
// waiting by default (status requested, assigned or denied), not over yet; filters: one resource, the organizer
// (requesterPartyId), a period overlapping (fromDate, thruDate) and the resource's name (text). Soonest first, paged.
function findRequests(p) {
    if (!ec.user.userId) denied("PERMISSION_DENIED", "Sign in to read booking requests")
    const userScope = maintenanceAccess.scope()
    const caps = userScope.capabilities
    const broad = !!(caps.policyView || caps.policyEdit || caps.supervise)
    const approver = !!(caps.bookingViewAssigned || caps.bookingApprove)
    if (!broad && !approver)
        denied("PERMISSION_DENIED", "A booking approver, resource policy reader or supervisor reads booking requests")
    const f = ec.entity.conditionFactory
    const partyId = userScope.partyId || "_NA_"
    const approvedFacilities = new Set(
        Array.from(
            find("mantle.facility.FacilityParty", {partyId, roleTypeId: "BookingApprover"})
                .conditionDate("fromDate", "thruDate", ec.user.nowTimestamp)
                .list()
        ).map(row => row.facilityId)
    )
    const approvedAssets = new Set(
        Array.from(
            find("mantle.product.asset.AssetPartyAssignment", {partyId, roleTypeId: "BookingApprover"})
                .conditionDate("fromDate", "thruDate", ec.user.nowTimestamp)
                .list()
        ).map(row => row.assetId)
    )
    const status = ["requested", "assigned", "denied"].includes(p.status) ? p.status : "requested"
    const wantFacility = text(p.facilityId)
    const wantAsset = text(p.assetId)
    const now = nowMs()
    const fromMs = ms(p.fromDate) ?? now
    const thruMs = ms(p.thruDate)
    const notOver = f.makeCondition(
        [
            f.makeCondition("estimatedCompletionDate", "is-null", null),
            f.makeCondition("estimatedCompletionDate", "greater", new Date(fromMs))
        ],
        "or"
    )
    const base = query => {
        let found = query
            .condition(f.makeCondition("statusId", "not-equals", "WeCancelled", true))
            .condition(notOver)
            .orderBy("estimatedStartDate")
            .limit(scanLimit)
        if (thruMs != null)
            found = found.condition(
                f.makeCondition(
                    [
                        f.makeCondition("estimatedStartDate", "is-null", null),
                        f.makeCondition("estimatedStartDate", "less", new Date(thruMs))
                    ],
                    "or"
                )
            )
        if (text(p.requesterPartyId)) found = found.condition("ownerPartyId", text(p.requesterPartyId))
        return found
    }
    const organizations = new Map()
    const covered = (kind, id) => {
        const cacheKey = kind + "|" + id
        if (!organizations.has(cacheKey))
            organizations.set(
                cacheKey,
                maintenanceAccess.covers(
                    userScope,
                    kind === "facility" ? maintenanceAccess.facilityOrganization(id) : maintenanceAccess.assetOrganization(id)
                )
            )
        return organizations.get(cacheKey)
    }
    const allowed = (kind, id) =>
        (kind === "facility" ? approvedFacilities.has(id) : approvedAssets.has(id)) || (broad && covered(kind, id))
    const found = []
    if (!wantAsset) {
        let query = base(find("mantle.work.effort.WorkEffortAndFacilityBooking", {bookingStatusId: statuses.facility[status]}))
        if (wantFacility) query = query.condition("facilityId", wantFacility)
        else if (!broad) query = query.condition("facilityId", "in", approvedFacilities.size ? Array.from(approvedFacilities) : ["_NA_"])
        for (const row of Array.from(query.list()))
            if (allowed("facility", row.facilityId))
                found.push({kind: "facility", facilityId: row.facilityId, assetId: null, row})
    }
    if (!wantFacility) {
        let query = base(find("mantle.work.effort.WorkEffortAndAssetBooking", {bookingStatusId: statuses.asset[status]})).condition(
            f.makeCondition(
                [
                    f.makeCondition("bookingThruDate", "is-null", null),
                    f.makeCondition("bookingThruDate", "greater", ec.user.nowTimestamp)
                ],
                "or"
            )
        )
        if (wantAsset) query = query.condition("assetId", wantAsset)
        else if (!broad) query = query.condition("assetId", "in", approvedAssets.size ? Array.from(approvedAssets) : ["_NA_"])
        for (const row of Array.from(query.list()))
            if (allowed("asset", row.assetId)) found.push({kind: "asset", facilityId: null, assetId: row.assetId, row})
    }
    // the resources by name, for the text filter and the rows
    const resources = new Map()
    const resourceFor = item => {
        const cacheKey = item.kind + "|" + (item.facilityId || item.assetId)
        if (!resources.has(cacheKey)) {
            const resource = policies().resourceOf({facilityId: item.facilityId, assetId: item.assetId}, false, true)
            resources.set(cacheKey, resource)
        }
        return resources.get(cacheKey)
    }
    const term = text(p.text)?.toLowerCase()
    const listed = found.filter(item => !term || String(resourceFor(item).name).toLowerCase().includes(term))
    const paged = lib.pageList(listed, p, "requestList")
    const visible = policies().eventVisibility()
    const policyTexts = new Map()
    paged.requestList = paged.requestList.map(item => {
        const resource = resourceFor(item)
        const row = item.row
        const span = spanOf(row.workEffortId)
        const seen = visible(row.workEffortId)
        const policyKey = item.kind + "|" + (item.facilityId || item.assetId)
        if (!policyTexts.has(policyKey))
            policyTexts.set(
                policyKey,
                policies().policyText(policies().policyAt(resource), policies().approversOf(resource))
            )
        const conflicts =
            span && status === "requested"
                ? policies()
                      .bookingsOver(resource, span[0], span[1])
                      .filter(other => other.workEffortId !== row.workEffortId && other.recurringEventId !== row.workEffortId)
                      .filter(other => other.fromMs < span[1] && other.thruMs > span[0])
                : []
        const conflictNames = conflicts.map(other =>
            visible(other.recurringEventId || other.workEffortId) ? other.title : "Busy"
        )
        const booking = item.kind === "facility" ? one(ROOM_BOOKING, {workEffortId: row.workEffortId, facilityId: item.facilityId}) : null
        const stampMs = ms(booking?.lastUpdatedStamp) ?? ms(row.bookingFromDate) ?? null
        const waitedHours = stampMs == null ? null : Math.max(0, Math.floor((now - stampMs) / hourMs))
        const canDecide =
            status === "requested" &&
            !!caps.bookingApprove &&
            (item.kind === "facility" ? approvedFacilities.has(item.facilityId) : approvedAssets.has(item.assetId))
        return {
            key: [item.kind, item.facilityId || item.assetId, row.workEffortId, span ? span[0] : "", span ? span[1] : ""].join("|"),
            resourceType: item.kind,
            facilityId: item.facilityId,
            assetId: item.assetId,
            resourceName: resource.name,
            workEffortId: row.workEffortId,
            eventVisible: seen,
            purpose: seen ? row.workEffortName || row.workEffortId : "Not shared with you",
            notes: row.bookingComments || "",
            requesterName: policies().partyName(row.ownerPartyId),
            fromDate: span ? new Date(span[0]) : null,
            thruDate: span ? new Date(span[1]) : null,
            whenText: spanText(span),
            recurring: isRecurring(row.workEffortId),
            policyText: policyTexts.get(policyKey),
            statusId: row.bookingStatusId,
            statusText: statusText(row.bookingStatusId),
            conflictCount: conflicts.length,
            conflictText: conflictNames.join(", "),
            waitedText:
                waitedHours == null ? "" : waitedHours < 24 ? waitedHours + " h" : Math.floor(waitedHours / 24) + " d",
            expectedStatusId: row.bookingStatusId,
            expectedFromDate: span ? span[0] : null,
            expectedThruDate: span ? span[1] : null,
            canDecide
        }
    })
    return Object.assign({}, paged, {canDecide: !!caps.bookingApprove && (approvedFacilities.size + approvedAssets.size) > 0})
}

;({
    notifyRequested,
    tellAffected,
    tellOrganizer,
    execute: (op, p) => {
        const operations = {
            find: findRequests,
            decide,
            decideMany,
            approveNotice: q => decideNotice(q, "approve"),
            refuseNotice: q => decideNotice(q, "deny")
        }
        if (!Object.hasOwn(operations, op)) throw new Error("Unknown booking decision operation " + op)
        return operations[op](p || {})
    }
})
