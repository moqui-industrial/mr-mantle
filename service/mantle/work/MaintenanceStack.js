// Maintenance's stack contributions in Mantle (IronStone Maintenance design §1.4 Comms hooks, Sync and Meetings, §12 outputs;
// MT-12, MT-16; impl-maintenance P19), over mantle.work.MaintenanceServices:
//
// - The message a problem is reported from (get#MaintenanceProblemSource; Commons' Report a problem, opened from a chat message,
//   a voicemail or a mail by the Comms actions, the user's call of Nov 12): the message read under its owner's own check (a chat
//   room the user reads, org.moqui.chat.ChatServices.get#RoomAccess; the user's own voicemail; a mail the user reads,
//   org.moqui.mail.EmailClientServices.get#Thread), as a summary (its first line or subject) and a description (its text or
//   transcript), for a holder of MAINTENANCE_REQUEST. A message of an end-to-end encrypted room is refused: the server has no
//   text. report#MaintenanceProblem reads it again before it writes anything, and files a chat message or a mail on the new
//   request as a communication event (a voicemail's transcript is the description; its audio stays in Comms).
// - The projected calendars (CX-SYNC; impl-people P12's kind, mantle.work.CalendarDavServices.define#ProjectionOwner): my work
//   orders (the open work orders assigned to the user, by their planned window) and due PM for my teams (the active plans' next
//   due of the user's maintenance scope, of the teams the user is on, else all of them, P13's find#MaintenanceDue), each read
//   only, as the user. No cost, no rate, no reporter: a work order's id, name and target; a plan's name and target.
// - Calendar files (get#MaintenanceCalendarFile): a work order's planned window (mantle.work.EventServices.get#EventIcsMaps) or a
//   plan's next calendar due as .ics text, for a user who reads it; a work order with no planned window and a meter plan are
//   refused by name (NOT_SCHEDULED, NO_DUE_DATE), never an empty file.
// - A video call (add#MaintenanceVideoCall): a Commons event for the work order (WeatRelatesTo from it), its join link a call
//   link (org.moqui.call.CallServices.create#CallLink, lobby, video) in the event's infoUrl, the attendee (a vendor's expert,
//   who needs no account) and the work order's technicians invited through send#EventInvitations (an iMIP invitation by mail
//   for a party with no account). For a planner or supervisor of the work order, or its assigned technician.
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const maintenanceAccess = ec.resource.script("component://mr-mantle/service/mantle/work/MaintenanceAccess.js")
const {find, one, denied, call, ms} = lib

const WORK = "mantle.work.effort.WorkEffort"
const WORK_PARTY = "mantle.work.effort.WorkEffortParty"
const ORDER = "mantle.work.maintenance.MaintenanceWorkOrder"
const SCHEDULE = "mantle.work.maintenance.MaintenanceSchedule"
const REQUEST = "mantle.request.Request"
const ASSET = "mantle.product.asset.Asset"
const FACILITY = "mantle.facility.Facility"

const hour = 60 * 60 * 1000
const day = 24 * hour
const summaryLimit = 100
const descriptionLimit = 4000
const projectionLimit = 200
const assigneeRole = "Assignee"

const blank = value => value == null || String(value).trim() === ""
const text = value => (blank(value) ? null : String(value).trim())
const truthy = value => value === true || value === "true" || value === "Y"
const nowMs = () => ms(ec.user.nowTimestamp)
const L = words => ec.l10n.localize(words)
function signedIn() {
    if (!ec.user.userId) denied("PERMISSION_DENIED", "Sign in first")
}
// A service's answer, or null when it refuses: its errors kept out of the caller's.
function quietly(name, parameters) {
    ec.message.pushErrors()
    try {
        const out = ec.service.sync().name(name).parameters(parameters).disableAuthz().call() || {}
        return ec.message.hasError() ? null : out
    } catch (error) {
        return null
    } finally {
        ec.message.clearErrors()
        ec.message.popErrors()
    }
}
// The plain text of HTML (a chat message's or a mail's body).
function htmlText(html) {
    return String(html || "")
        .replace(/<(style|script)[^>]*>[\s\S]*?<\/\1>/gi, " ")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/(p|div|li|h\d)>/gi, "\n")
        .replace(/<[^>]*>/g, " ")
        .replace(/&nbsp;/g, " ")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, "&")
        .replace(/[ \t]+/g, " ")
        .replace(/\n\s*\n\s*\n+/g, "\n\n")
        .trim()
}
const firstLine = words =>
    String(words || "")
        .split(/\r?\n/)
        .map(line => line.trim())
        .find(line => line) || ""
const clip = (words, limit) => (words.length > limit ? words.substring(0, limit - 3) + "..." : words)

// ===== the message a problem is reported from =====
// Which message the parameters name: a chat message (chatRoomId and eventSeq), a voicemail or a mail; null for none, ONE_SOURCE
// for more than one.
function sourceKind(p) {
    const kinds = []
    if (text(p.chatRoomId) || text(p.eventSeq)) kinds.push("chat")
    if (text(p.voicemailId)) kinds.push("voicemail")
    if (text(p.emailMessageId)) kinds.push("email")
    if (kinds.length > 1) denied("ONE_SOURCE", "A problem is reported from one message")
    return kinds[0] || null
}
const sourceUnavailable = () => denied("SOURCE_UNAVAILABLE", "The message is not available")
function chatSource(p) {
    if (!text(p.chatRoomId) || !text(p.eventSeq)) sourceUnavailable()
    const access = quietly("org.moqui.chat.ChatServices.get#RoomAccess", {chatRoomId: text(p.chatRoomId)})
    if (!access?.canRead) sourceUnavailable()
    const room = one("moqui.chat.ChatRoom", {chatRoomId: text(p.chatRoomId)})
    if (room?.encrypted === "Y")
        denied(
            "SOURCE_ENCRYPTED",
            "A message of an end-to-end encrypted room cannot be reported from: the server does not have its text"
        )
    const row = one("moqui.chat.ChatEvent", {chatRoomId: text(p.chatRoomId), eventSeq: Number(p.eventSeq)})
    if (!row || row.eventTypeEnumId !== "CetMessage" || row.redactedDate) sourceUnavailable()
    const parse = json => {
        try {
            const value = JSON.parse(json || "{}")
            return value && typeof value === "object" ? value : {}
        } catch (error) {
            return {}
        }
    }
    const content = parse(row.contentJson)
    let html = content.body ?? null
    if (row.lastEditEventSeq != null) {
        const edited = parse(
            one("moqui.chat.ChatEvent", {chatRoomId: row.chatRoomId, eventSeq: row.lastEditEventSeq})?.contentJson
        )
        if (edited.body != null) html = edited.body
    }
    const words = html != null ? htmlText(html) : String(row.bodyText || "").trim()
    const sender = row.senderUserId ? one("moqui.security.UserAccount", {userId: row.senderUserId}) : null
    return {
        sourceKind: "chat",
        summary: clip(firstLine(words) || L("Chat message"), summaryLimit),
        description: clip(words, descriptionLimit),
        sourceText: [L("Chat message"), sender ? sender.userFullName || sender.username : null, room?.roomName || null]
            .filter(Boolean)
            .join(" · "),
        attachmentNames: Array.from(content.attachments ?? [])
            .map(file => file.fileName)
            .filter(Boolean)
    }
}
function voicemailSource(p) {
    const voicemail = quietly("org.moqui.call.VoicemailServices.get#Voicemail", {voicemailId: text(p.voicemailId)})?.voicemail
    if (!voicemail) sourceUnavailable()
    const caller = voicemail.fromName || voicemail.fromNumber || ""
    return {
        sourceKind: "voicemail",
        summary: clip((L("Voicemail from") + " " + caller).trim(), summaryLimit),
        description: clip(String(voicemail.transcriptText || "").trim(), descriptionLimit),
        sourceText: [L("Voicemail"), caller].filter(Boolean).join(" · "),
        attachmentNames: []
    }
}
function emailSource(p) {
    const id = text(p.emailMessageId)
    const thread = quietly("org.moqui.mail.EmailClientServices.get#Thread", {emailMessageId: id})
    const message = Array.from(thread?.messageList || []).find(item => item.emailMessageId === id)
    if (!message) sourceUnavailable()
    const words = String(message.bodyText || "").trim() || htmlText(message.body)
    const subject = String(message.subject || "")
        .replace(/^((re|fwd?|aw|wg)\s*:\s*)+/i, "")
        .trim()
    return {
        sourceKind: "email",
        summary: clip(subject || firstLine(words) || L("Mail"), summaryLimit),
        description: clip(words, descriptionLimit),
        sourceText: [L("Mail"), message.fromAddress || null].filter(Boolean).join(" · "),
        attachmentNames: Array.from(message.attachmentList || [])
            .map(file => file.fileName || file.contentName || null)
            .filter(Boolean)
    }
}
// The message's text as the reporter may read it; {sourceKind: null} when none is named.
function readSource(p) {
    const kind = sourceKind(p)
    if (!kind) return {sourceKind: null}
    if (kind === "chat") return chatSource(p)
    if (kind === "voicemail") return voicemailSource(p)
    return emailSource(p)
}
// get#MaintenanceProblemSource: the prefill of Report a problem, for a holder of MAINTENANCE_REQUEST.
function problemSource(p) {
    signedIn()
    if (!maintenanceAccess.capabilities().request)
        denied("PERMISSION_DENIED", "Maintenance request is required to report a problem")
    return readSource(p)
}
// File the message a problem was reported from on its request: a chat message or a mail as a communication event linked to it
// (Mantle's own checks: the room, the mailbox and the request). A voicemail's transcript is the description; nothing is filed.
function fileSource(requestId, p) {
    const kind = sourceKind(p)
    if (kind === "chat") {
        const found = call("mantle.party.CommunicationServices.findOrCreate#ChatCommunicationEvent", {
            chatRoomId: text(p.chatRoomId),
            eventSeq: Number(p.eventSeq)
        })
        call("mantle.party.CommunicationServices.link#CommunicationEventRecord", {
            communicationEventId: found.communicationEventId,
            recordEntityName: REQUEST,
            recordId: requestId
        })
    } else if (kind === "email") {
        call("mantle.party.CommunicationServices.link#CommunicationEventRecord", {
            emailMessageId: text(p.emailMessageId),
            recordEntityName: REQUEST,
            recordId: requestId
        })
    }
}

// ===== the projected calendars =====
// The OrgTeam teams the party is a current member of.
function teamIdsOf(partyId) {
    if (!partyId) return []
    return Array.from(
        find("mantle.party.PartyRelationship", {
            fromPartyId: partyId,
            relationshipTypeEnumId: "PrtMember",
            toRoleTypeId: "OrgTeam"
        })
            .conditionDate("fromDate", "thruDate", ec.user.nowTimestamp)
            .list()
    ).map(row => row.toPartyId)
}
// The window a projection answers: start and end (epoch millis), else 30 days back to 90 ahead.
function windowOf(p) {
    const now = nowMs()
    const start = blank(p.start) ? now - 30 * day : Number(p.start)
    const end = blank(p.end) ? now + 90 * day : Number(p.end)
    return {start, end}
}
// get#MaintenanceWorkProjection (my work orders): the open work orders assigned to the user with a planned window in the range,
// for a holder of a work read (MAINTENANCE_VIEW or MAINTENANCE_ASSIGNED_VIEW).
function workProjection(p) {
    if (!ec.user.userId) return {admitted: false, eventList: []}
    const userScope = maintenanceAccess.scope()
    const admitted = !!userScope.capabilities.workRead && !!userScope.partyId
    if (!admitted || truthy(p.checkOnly)) return {admitted, eventList: []}
    const {start, end} = windowOf(p)
    const found = call("mantle.work.MaintenanceServices.find#MaintenanceWorkOrders", {
        mine: "Y",
        fromDate: start,
        thruDate: end,
        pageSize: projectionLimit
    })
    const eventList = []
    for (const row of Array.from(found.workOrderList || [])) {
        const startMs = ms(row.estimatedStartDate)
        if (startMs == null) continue
        const dueMs = ms(row.estimatedCompletionDate)
        eventList.push({
            uid: "maintenance-work-" + row.workEffortId,
            sequence: Number(row.revision || 0),
            summary: [L("Work order") + " " + row.workEffortId + ": " + row.workEffortName, row.targetName]
                .filter(Boolean)
                .join(" · "),
            status: row.statusId === "WeOnHold" ? "TENTATIVE" : "CONFIRMED",
            allDay: false,
            start: startMs,
            end: dueMs != null && dueMs > startMs ? dueMs : startMs + hour,
            timeZone: ec.user.timeZone || null,
            lastModified: null
        })
    }
    return {admitted, eventList}
}
// get#MaintenanceDueProjection (due PM for my teams): the next calendar due of the active plans of the user's maintenance scope
// (MAINTENANCE_VIEW, as Plans), of the teams the user is on, else of every team, planned in the range. A meter plan has no
// date and is left out.
function dueProjection(p) {
    if (!ec.user.userId) return {admitted: false, eventList: []}
    const userScope = maintenanceAccess.scope()
    const admitted = !!userScope.capabilities.view
    if (!admitted || truthy(p.checkOnly)) return {admitted, eventList: []}
    const {start, end} = windowOf(p)
    const teams = teamIdsOf(userScope.partyId)
    const found = call("mantle.work.MaintenancePlanServices.find#MaintenanceDue", {thruDate: end, pageSize: projectionLimit})
    const eventList = []
    for (const row of Array.from(found.dueList || [])) {
        if (teams.length && !teams.includes(row.teamPartyId)) continue
        const due = row.due || {}
        const plannedMs = ms(due.plannedDate)
        if (due.trigger !== "calendar" || plannedMs == null || plannedMs < start || plannedMs >= end) continue
        eventList.push(dueEvent(row.maintenanceScheduleId, row.scheduleName, row.targetName, plannedMs, due.state))
    }
    return {admitted, eventList}
}
function dueEvent(maintenanceScheduleId, scheduleName, targetName, plannedMs, state) {
    return {
        uid: "maintenance-due-" + maintenanceScheduleId + "-" + plannedMs,
        sequence: 0,
        summary: [L("Due") + ": " + (scheduleName || maintenanceScheduleId), targetName].filter(Boolean).join(" · "),
        status: state === "overdue" ? "TENTATIVE" : "CONFIRMED",
        allDay: false,
        start: plannedMs,
        end: plannedMs + hour,
        timeZone: ec.user.timeZone || null,
        lastModified: null
    }
}

// ===== calendar files =====
function icalendar() {
    if (ec.factory.getToolFactory("ICalendar") == null)
        denied("ICALENDAR_UNAVAILABLE", "Calendar files are not available: the iCalendar tool is turned off")
    return ec.factory.getTool("ICalendar")
}
const fileNameOf = words =>
    String(words)
        .replace(/[^A-Za-z0-9 _.-]/g, "_")
        .trim()
        .replace(/\s+/g, "-")
        .substring(0, 80) + ".ics"
// get#MaintenanceCalendarFile: a work order's planned window, or a plan's next calendar due, as .ics text.
function calendarFile(p) {
    signedIn()
    const userScope = maintenanceAccess.scope()
    const tool = icalendar()
    if (text(p.workEffortId)) {
        const work = maintenanceAccess.requireWork(userScope, text(p.workEffortId))
        const rootId = work.rootWorkEffortId
        const root = one(WORK, {workEffortId: rootId})
        if (!root || !one(ORDER, {workEffortId: rootId}))
            denied("RECORD_UNAVAILABLE", "Work order " + rootId + " is not available")
        if (ms(root.estimatedStartDate) == null)
            denied("NOT_SCHEDULED", "Work order " + rootId + " has no planned window to put in a calendar")
        const maps = Array.from(
            call("mantle.work.EventServices.get#EventIcsMaps", {workEffortIdList: [rootId]}).eventMapList || []
        )
        const title = L("Work order") + " " + rootId + ": " + (root.workEffortName || "")
        for (const map of maps) {
            map.summary = title
            if (map.end == null || map.end <= map.start) map.end = map.start + hour
        }
        return {
            fileName: fileNameOf("work-order-" + rootId),
            text: tool.write({method: "PUBLISH", calendarName: title, timeZone: ec.user.timeZone, events: maps})
        }
    }
    const id = text(p.maintenanceScheduleId)
    if (!id) denied("RECORD_REQUIRED", "Name a work order or a plan")
    const due = call("mantle.work.MaintenancePlanServices.get#MaintenanceDue", {maintenanceScheduleId: id}).due || {}
    const plannedMs = ms(due.plannedDate)
    if (due.trigger !== "calendar" || plannedMs == null)
        denied("NO_DUE_DATE", "Plan " + id + " has no calendar due date to put in a calendar")
    const schedule = one(SCHEDULE, {maintenanceScheduleId: id})
    const targetName = schedule.assetId
        ? one(ASSET, {assetId: schedule.assetId})?.assetName || schedule.assetId
        : one(FACILITY, {facilityId: schedule.facilityId})?.facilityName || schedule.facilityId
    const event = dueEvent(id, schedule.scheduleName, targetName, plannedMs, due.state)
    return {
        fileName: fileNameOf("maintenance-due-" + id),
        text: tool.write({method: "PUBLISH", calendarName: event.summary, timeZone: ec.user.timeZone, events: [event]})
    }
}

// ===== the video call =====
const videoFields = ["workEffortId", "attendeePartyId", "startDate", "durationMinutes", "note"]
function addVideoCall(p) {
    signedIn()
    const userScope = maintenanceAccess.scope()
    const work = maintenanceAccess.requireWork(userScope, text(p.workEffortId))
    const rootId = work.rootWorkEffortId
    const root = one(WORK, {workEffortId: rootId})
    if (!root || !one(ORDER, {workEffortId: rootId})) denied("RECORD_UNAVAILABLE", "Work order " + rootId + " is not available")
    const caps = userScope.capabilities
    if (!caps.plan && !caps.supervise && !(caps.execute && maintenanceAccess.assignment(userScope, rootId).root))
        denied("PERMISSION_DENIED", "A planner, a supervisor or the assigned technician adds a video call")
    if (["WeClosed", "WeCancelled"].includes(root.statusId))
        denied("WORK_CLOSED", "Work order " + rootId + " is " + (root.statusId === "WeClosed" ? "closed" : "cancelled"))
    const attendeePartyId = text(p.attendeePartyId)
    if (!attendeePartyId) denied("ATTENDEE_REQUIRED", "Choose who joins the call")
    if (!one("mantle.party.Party", {partyId: attendeePartyId})) denied("ATTENDEE_UNAVAILABLE", "That person is not available")
    const hasUser = find("moqui.security.UserAccount", {partyId: attendeePartyId}).count() > 0
    const email = call("mantle.party.ContactServices.get#PrimaryEmailAddress", {partyId: attendeePartyId}).emailAddress || null
    if (!hasUser && !email) denied("ATTENDEE_UNREACHABLE", "The person has no account and no email address to invite")
    const startMs = ms(p.startDate)
    if (startMs == null) denied("START_REQUIRED", "Say when the call starts")
    if (startMs < nowMs() - 5 * 60 * 1000) denied("DATE_PAST", "A call is planned from now on")
    const minutes = blank(p.durationMinutes) ? 30 : Number(p.durationMinutes)
    if (!Number.isFinite(minutes) || minutes < 5 || minutes > 480) denied("DURATION_INVALID", "A call lasts 5 minutes to 8 hours")
    const endMs = startMs + minutes * 60 * 1000
    let op = null
    if (!blank(p.operationKey)) {
        op = lib.operation(
            p,
            "MaintenanceVideoCall",
            work.organizationPartyId,
            videoFields.map(field => (p[field] == null ? "" : String(ms(p[field]) ?? p[field])))
        )
        const earlier = lib.previous(op)
        if (earlier) return Object.assign(earlier, {repeated: true})
    }
    const title = L("Video call") + ": " + L("work order") + " " + rootId + " · " + (root.workEffortName || "")
    const link = call("org.moqui.call.CallServices.create#CallLink", {
        name: title.substring(0, 255),
        policy: "lobby",
        video: true,
        expiryHours: Math.min(2160, Math.max(24, Math.ceil((endMs - nowMs()) / hour) + 24))
    })
    if (link.reasonCode || !link.path) denied("CALL_UNAVAILABLE", "A call link cannot be made: " + (link.reasonCode || "no link"))
    let base = ""
    try {
        base = ec.web?.getWebappRootUrl(true, null) || ""
    } catch (error) {
        base = ""
    }
    const joinUrl = base + link.path
    const description = [text(p.note), L("Join the call") + ": " + joinUrl].filter(Boolean).join("\n\n")
    const eventId = call("mantle.work.EventServices.create#Event", {
        workEffortName: title.substring(0, 255),
        description,
        estimatedStartDate: startMs,
        estimatedCompletionDate: endMs,
        infoUrl: joinUrl,
        ownerPartyId: userScope.partyId
    }).workEffortId
    const now = ec.user.nowTimestamp
    call("create#mantle.work.effort.WorkEffortAssoc", {
        workEffortId: rootId,
        toWorkEffortId: eventId,
        workEffortAssocTypeEnumId: "WeatRelatesTo",
        fromDate: now
    })
    // the organizer, then the attendee and the work order's technicians, each asked to answer
    const invited = new Set()
    if (userScope.partyId) {
        call("create#" + WORK_PARTY, {
            workEffortId: eventId,
            partyId: userScope.partyId,
            roleTypeId: assigneeRole,
            fromDate: now,
            statusId: "WeptAssigned"
        })
        invited.add(userScope.partyId)
    }
    const technicians = Array.from(
        find(WORK_PARTY, {workEffortId: rootId, roleTypeId: assigneeRole}).conditionDate("fromDate", "thruDate", now).list()
    ).map(row => row.partyId)
    for (const partyId of [attendeePartyId].concat(technicians)) {
        if (invited.has(partyId)) continue
        invited.add(partyId)
        call("create#" + WORK_PARTY, {
            workEffortId: eventId,
            partyId,
            roleTypeId: assigneeRole,
            fromDate: now,
            statusId: "WeptOffered",
            mustRsvp: "Y"
        })
    }
    const sent = call("mantle.work.EventServices.send#EventInvitations", {
        workEffortId: eventId,
        message: text(p.note),
        eventUrl: text(p.eventUrl)
    })
    const result = {
        eventWorkEffortId: eventId,
        callLinkId: link.callLinkId,
        joinUrl,
        skippedCount: Array.from(sent.skippedList || []).length
    }
    if (op) lib.complete(op, WORK, eventId, result)
    return Object.assign(result, {repeated: false})
}

const operations = {problemSource, workProjection, dueProjection, calendarFile, addVideoCall}
;({
    execute: (op, parameters) => {
        if (!Object.hasOwn(operations, op)) throw new Error("Unknown maintenance stack operation " + op)
        return operations[op](parameters || {})
    },
    readSource,
    fileSource
})
