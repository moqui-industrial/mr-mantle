// Event check-in (mantle.work.EventRegistrationServices preview#CheckIn, checkIn#Registration, resolve#EntryCode, get#Attendance; E of
// IronStone Marketing design §14.2; design §9 CheckIn and RegistrationDetail's Attendance; impl-marketing P18, F83, §4 Nov 13). CC0 1.0
// Universal plus Grant of Patent License.
//
// - One offer (an occurrence's EventRegistrationPolicy) is checked in at a time. Its door is kept by an events manager of its
//   organization (MARKETING_EVENT_MANAGE, under their own sign-in) or by a shared door tablet: a registered device (the framework's
//   DeviceCredential) whose route group fixes the request parameter registrationPolicyId to this offer, whose display account is the
//   request's user, holds MARKETING_CHECKIN and belongs to the offer's organization. A MARKETING_CHECKIN holder anywhere else, or at a
//   device fixed to another offer, is refused as for a missing offer.
// - An entry code names its registration by its digest and revision (EventRegistrationPlaces.js registrationOfCode, the only call made
//   into the registration modules): an unknown, replaced (a reissue or a substitution) or revoked (a cancellation) code names none.
//   A place enters when it is confirmed, of this offer, its event not cancelled, within the check-in window (from a day before the
//   occurrence's start to twelve hours after its end); wrong-event, cancelled, expired, waitlisted, pending and unconfirmed places are
//   refused with the reason in words.
// - One attendance fact per registration (EventAttendance), written under the registration's row lock: a second scan, a retry or a
//   staff check-in of a place already in answers the first result (when, how, by whom) and writes nothing.
// - Staff may also find an attendee by name, address or registration (never the door tablet, which looks up nothing but a code) and
//   check them in with a reason; an events manager may override a held or pending place (a seat it occupies, not confirmed) with a
//   reason, which records the attendance and changes neither the place's state nor its payment. Nothing overrides a wrong event, a
//   cancelled, expired, waitlisted or review place, a cancelled event or a closed window.
// - What the door tablet is answered is what check-in needs: the decision, the ticket's name and the attendee as a first name and
//   initial; no address, buyer, payment, answers or other attendee. Staff see the attendee's name.
// - Every lookup and check-in counts against a limit of the device (or the staff user): 60 a minute, past which it is refused for a
//   moment (RATE_LIMITED), looking nothing up.
// Refusals carry reason codes (EntityLib.js denied).
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const marketingAccess = ec.resource.script("component://mr-mantle/service/mantle/marketing/MarketingAccess.js")
const places = () => ec.resource.script("component://mr-mantle/service/mantle/work/EventRegistrationPlaces.js")
const {find, one, rows, call, denied, ms} = lib

const POLICY = "mantle.work.registration.EventRegistrationPolicy"
const TICKET = "mantle.work.registration.EventTicketType"
const REGISTRATION = "mantle.work.registration.EventRegistration"
const ATTENDANCE = "mantle.work.registration.EventAttendance"
const ACTION = "mantle.work.registration.EventRegistrationAction"
const WORK_EFFORT = "mantle.work.effort.WorkEffort"
const DEVICE = "moqui.security.DeviceCredential"
const ROUTE_GROUP = "moqui.security.DeviceRouteGroup"
// the request parameter a door tablet's route group fixes to its offer (moqui.security.DeviceRouteGroup parameterName)
const DEVICE_PARAMETER = "registrationPolicyId"
const HOUR = 3600000
const checkInWindow = {opensBeforeMs: 24 * HOUR, closesAfterMs: 12 * HOUR}
const limits = {perMinute: 60, candidates: 20, term: 100, code: 64, reason: 255}
// the reasons a place does not enter, in words; the ones an events manager may override (a seat it occupies, not confirmed)
const reasonTexts = {
    ELIGIBLE: "Confirmed: may enter",
    ALREADY_CHECKED_IN: "Already checked in",
    CODE_UNKNOWN: "Not a current ticket: the code is unknown, replaced or cancelled",
    WRONG_EVENT: "This ticket is for another event or occurrence",
    CANCELLED: "Cancelled",
    EXPIRED: "Its hold ended: never confirmed",
    WAITLISTED: "Waitlisted: no seat was offered",
    PENDING: "Payment received, awaiting the organizer's confirmation",
    UNCONFIRMED: "Held, not confirmed",
    REVIEW: "Paid after its hold ended: under review, no seat",
    EVENT_CANCELLED: "The event is cancelled",
    CHECK_IN_CLOSED: "Check-in is not open for this occurrence now"
}
const OVERRIDABLE = ["PENDING", "UNCONFIRMED"]

const blank = value => value == null || String(value).trim() === ""
const text = value => (blank(value) ? null : String(value).trim())
const nowMs = () => Number(ms(ec.user.nowTimestamp))
const L = words => ec.l10n.localize(words)
const yes = value => value === true || value === "true" || value === "Y"
const revisionOf = row => String(ms(row.lastUpdatedStamp) ?? "")
const zoneText = (value, zone) =>
    value == null ? "" : ec.l10n.format(new Date(ms(value)), "EEE d MMM yyyy HH:mm", null, zone || ec.user.timeZone || null)
const timeText = (value, zone) =>
    value == null ? "" : ec.l10n.format(new Date(ms(value)), "HH:mm", null, zone || ec.user.timeZone || null)

// ===== who keeps the door =====
// The request's door tablet: its credential row and route group, or null outside a device's request.
function currentDevice() {
    const current = UserSecurityChecks.currentDevice()
    const device = current?.deviceId ? one(DEVICE, {deviceId: current.deviceId}) : null
    if (!device) return null
    return {device, routeGroup: one(ROUTE_GROUP, {routeGroupId: device.routeGroupId})}
}
// The organizations a display account serves: those of its party.
function displayOrganizations() {
    const partyId = ec.user.userAccount?.partyId
    return partyId ? Array.from(call("mantle.party.PartyServices.get#PartyInternalOrgIds", {partyId}).userOrgIds || []) : []
}
const unavailable = id => denied("RECORD_UNAVAILABLE", "Registration offer " + (id || "") + " is not available")
// The caller at an offer's door: {policy, staff: true, userScope} for an events manager of its organization, {policy, device} for its
// door tablet; anyone else refused (the offer missing, another organization's or another tablet's alike).
function doorOf(registrationPolicyId) {
    const policy = blank(registrationPolicyId) ? null : one(POLICY, {registrationPolicyId: text(registrationPolicyId)})
    const userScope = marketingAccess.scope()
    if (userScope.capabilities.eventManage) {
        if (!policy || !marketingAccess.covers(userScope, policy.organizationPartyId)) unavailable(registrationPolicyId)
        return {policy, staff: true, userScope}
    }
    if (!ec.user.hasPermission("MARKETING_CHECKIN"))
        denied("PERMISSION_DENIED", "Check-in is for events managers and the event's door tablet")
    const at = currentDevice()
    if (!at || !ec.user.userId || at.device.displayUserId !== ec.user.userId)
        denied("DEVICE_REQUIRED", "Check-in without an events manager's sign-in is only at a registered door tablet")
    if (
        !policy ||
        at.routeGroup?.parameterName !== DEVICE_PARAMETER ||
        at.device.parameterValue !== policy.registrationPolicyId ||
        !displayOrganizations().includes(policy.organizationPartyId)
    )
        unavailable(registrationPolicyId)
    return {policy, staff: false, device: at.device}
}
// A lookup or check-in counted against the door's limit (the device's, or the staff user's); past it refused, looking nothing up.
function throttle(door) {
    const key = "mkt-checkin:" + (door.device ? "d:" + door.device.deviceId : "u:" + ec.user.userId)
    const allowed = !!ec.service
        .sync()
        .throwOnError(true)
        .name("org.moqui.public.AccountServices.record#Attempt")
        .parameters({input: {key, limit: limits.perMinute, windowMillis: 60000}})
        .requireNewTransaction(true)
        .call().result.allowed
    if (!allowed) denied("RATE_LIMITED", "Too many check-ins at once: wait a moment and scan again")
}

// ===== the decision =====
function personName(partyId) {
    const person = partyId ? one("mantle.party.Person", {partyId}) : null
    return person ? {first: text(person.firstName) || "", last: text(person.lastName) || ""} : {first: "", last: ""}
}
// The attendee as the door shows them: staff the name, the tablet a first name and initial.
function attendeeText(door, partyId) {
    const name = personName(partyId)
    if (door.staff) return [name.first, name.last].filter(Boolean).join(" ") || L("Attendee")
    return [name.first, name.last ? name.last.slice(0, 1) + "." : ""].filter(Boolean).join(" ") || L("Attendee")
}
const ticketText = ticketTypeId => (ticketTypeId ? one(TICKET, {ticketTypeId})?.ticketName || "" : "")
const userText = userId => (userId ? one("moqui.security.UserAccount", {userId})?.userFullName || L("Staff") : "")
const methodTexts = {EamCode: "by entry code", EamLookup: "found by name", EamOverride: "by a manager's override"}
// An attendance as the door shows it: when and how; by whom and why to staff only.
function attendanceView(door, attendance, zone) {
    if (!attendance) return null
    const view = {
        checkInText: zoneText(attendance.checkInDate, zone),
        checkInTime: timeText(attendance.checkInDate, zone),
        methodText: L(methodTexts[attendance.methodEnumId] || "")
    }
    if (door.staff)
        Object.assign(view, {
            byText: attendance.deviceId ? L("the door tablet") : userText(attendance.checkInByUserId),
            reason: attendance.reason || ""
        })
    return view
}
// Whether the occurrence's door is open now: the event not cancelled, within the window. A reason code or null.
function doorReason(policy) {
    const workEffort = one(WORK_EFFORT, {workEffortId: policy.workEffortId})
    if (!workEffort || workEffort.statusId === "WeCancelled") return "EVENT_CANCELLED"
    const start = Number(ms(policy.occurrenceStart) ?? 0)
    const end = Number(ms(policy.occurrenceEnd) ?? start)
    const now = nowMs()
    if (now < start - checkInWindow.opensBeforeMs || now > end + checkInWindow.closesAfterMs) return "CHECK_IN_CLOSED"
    return null
}
const live = row => row.statusId !== "EvrHeld" || row.holdExpireDate == null || Number(ms(row.holdExpireDate)) > nowMs()
function placeReason(row) {
    if (row.statusId === "EvrConfirmed") return "ELIGIBLE"
    if (row.statusId === "EvrHeld") return live(row) ? "UNCONFIRMED" : "EXPIRED"
    return (
        {
            EvrCancelled: "CANCELLED",
            EvrExpired: "EXPIRED",
            EvrWaitlisted: "WAITLISTED",
            EvrPending: "PENDING",
            EvrReview: "REVIEW"
        }[row.statusId] || "CANCELLED"
    )
}
// A registration's decision at the door: whether it may enter, the reason in words, whether a manager may override, its attendance.
function decisionOf(door, row) {
    const policy = door.policy
    const zone = policy.timeZone || null
    if (!row) return {eligible: false, overridable: false, reasonCode: "CODE_UNKNOWN", decisionText: L(reasonTexts.CODE_UNKNOWN)}
    if (row.registrationPolicyId !== policy.registrationPolicyId)
        return {eligible: false, overridable: false, reasonCode: "WRONG_EVENT", decisionText: L(reasonTexts.WRONG_EVENT)}
    const attendance = one(ATTENDANCE, {registrationId: row.registrationId})
    const facts = {
        registrationId: row.registrationId,
        attendeeText: attendeeText(door, row.attendeePartyId),
        ticketText: ticketText(row.ticketTypeId),
        attendance: attendanceView(door, attendance, zone),
        expectedRevision: revisionOf(row)
    }
    if (door.staff) facts.stateText = one("moqui.basic.StatusItem", {statusId: row.statusId})?.description || row.statusId
    let reasonCode = attendance ? "ALREADY_CHECKED_IN" : placeReason(row)
    if (!attendance && (reasonCode === "ELIGIBLE" || OVERRIDABLE.includes(reasonCode)))
        reasonCode = doorReason(policy) || reasonCode
    const decisionText =
        reasonCode === "ALREADY_CHECKED_IN"
            ? L(reasonTexts.ALREADY_CHECKED_IN) + " " + L("at") + " " + facts.attendance.checkInText
            : L(reasonTexts[reasonCode])
    return Object.assign(facts, {
        eligible: reasonCode === "ELIGIBLE",
        overridable: door.staff && OVERRIDABLE.includes(reasonCode),
        reasonCode,
        decisionText
    })
}
const codeOf = value => {
    const code = text(value)
    if (code && code.length > limits.code) return null
    return code
}
// The registration a door is asked about: by its entry code, or (staff) by its id; null when a code names none.
function registrationAsked(door, p) {
    if (!blank(p.entryCode)) return {row: places().registrationOfCode(codeOf(p.entryCode)), byCode: true}
    if (!blank(p.registrationId)) {
        if (!door.staff) denied("PERMISSION_DENIED", "The door tablet checks in by entry code only")
        const row = one(REGISTRATION, {registrationId: text(p.registrationId)})
        if (!row || row.registrationPolicyId !== door.policy.registrationPolicyId)
            denied("RECORD_UNAVAILABLE", "Registration " + p.registrationId + " is not available")
        return {row, byCode: false}
    }
    return null
}
// The door's header: the offer, its occurrence, how many are in of the confirmed places, and whether it is open now.
function deskOf(door) {
    const policy = door.policy
    const workEffort = one(WORK_EFFORT, {workEffortId: policy.workEffortId})
    const checkedIn = find(ATTENDANCE, {registrationPolicyId: policy.registrationPolicyId}).count()
    const desk = {
        registrationPolicyId: policy.registrationPolicyId,
        title: policy.publicTitle || workEffort?.workEffortName || "",
        whenText: zoneText(policy.occurrenceStart, policy.timeZone) + (policy.timeZone ? " (" + policy.timeZone + ")" : ""),
        checkedInCount: Number(checkedIn || 0),
        openNow: !doorReason(policy),
        closedText: doorReason(policy) ? L(reasonTexts[doorReason(policy)]) : "",
        staff: door.staff
    }
    if (door.staff)
        desk.expectedCount = Number(
            find(REGISTRATION, {registrationPolicyId: policy.registrationPolicyId, statusId: "EvrConfirmed"}).count() || 0
        )
    return desk
}
// Staff's lookup: the offer's places whose attendee's name or address, or whose id, matches the term, at most twenty.
function candidatesOf(door, term) {
    const words = String(term).slice(0, limits.term)
    const like = "%" + words.replace(/[\\%_]/g, character => "\\" + character) + "%"
    const factory = ec.entity.conditionFactory
    const people = Array.from(
        find("mantle.party.Person")
            .condition(
                factory.makeCondition(
                    ["firstName", "lastName"].map(field => factory.makeCondition(field, "like", like).ignoreCase()),
                    "or"
                )
            )
            .selectField("partyId")
            .limit(500)
            .list()
    ).map(row => row.partyId)
    const byAddress = Array.from(
        find("mantle.party.contact.PartyContactMechInfo")
            .condition(factory.makeCondition("infoString", "like", like).ignoreCase())
            .condition("contactMechTypeEnumId", "CmtEmailAddress")
            .selectField("partyId")
            .limit(200)
            .list()
    ).map(row => row.partyId)
    const partyIds = [...new Set([...people, ...byAddress])]
    const conditions = [factory.makeCondition("registrationId", "equals", words)]
    if (partyIds.length) conditions.push(factory.makeCondition("attendeePartyId", "in", partyIds))
    return Array.from(
        find(REGISTRATION, {registrationPolicyId: door.policy.registrationPolicyId})
            .condition(factory.makeCondition(conditions, "or"))
            .orderBy("registrationId")
            .limit(limits.candidates)
            .list()
    ).map(row => decisionOf(door, row))
}

// ===== services =====
// preview#CheckIn: the door's header and, for an entry code (or, staff, a registration), its decision; for a term (staff), the
// matching places with theirs. Changes nothing.
function previewCheckIn(p) {
    const door = doorOf(p.registrationPolicyId)
    const out = {desk: deskOf(door), decision: null, candidates: []}
    if (!blank(p.term)) {
        if (!door.staff) denied("PERMISSION_DENIED", "The door tablet checks in by entry code only")
        throttle(door)
        out.candidates = candidatesOf(door, p.term)
        return out
    }
    if (blank(p.entryCode) && blank(p.registrationId)) return out
    throttle(door)
    out.decision = decisionOf(door, registrationAsked(door, p).row)
    return out
}
// resolve#EntryCode: the scan-input resolver of CheckIn's entry code. The code is the match (the form posts it to checkIn#Registration);
// its decision is the match's label and detail, so the scan shows who it is and whether they may enter before Confirm; a code that
// names no place of this offer, or one that may not enter, is answered as the refusal it is.
function resolveEntryCode(p) {
    const door = doorOf(p.registrationPolicyId)
    throttle(door)
    const code = codeOf(p.scanText)
    const decision = decisionOf(door, code ? places().registrationOfCode(code) : null)
    if (!decision.eligible && decision.reasonCode !== "ALREADY_CHECKED_IN") denied(decision.reasonCode, decision.decisionText)
    return {
        matches: [
            {
                identityType: "ticket",
                id: code,
                label: [decision.attendeeText, decision.ticketText].filter(Boolean).join(" · "),
                detail: decision.decisionText
            }
        ]
    }
}
// checkIn#Registration: the registration of an entry code (or, staff, one found by name, with a reason; or an override of a held or
// pending place by an events manager, with a reason) checked in once; a repeat answers the first result and writes nothing.
function checkInRegistration(p) {
    const door = doorOf(p.registrationPolicyId)
    throttle(door)
    const asked = registrationAsked(door, p)
    if (!asked) denied("RECORD_REQUIRED", "Scan or type an entry code, or choose the attendee")
    if (!asked.row) denied("CODE_UNKNOWN", L(reasonTexts.CODE_UNKNOWN))
    // the place under its row lock, so two scans at once check it in once
    const row = find(REGISTRATION, {registrationId: asked.row.registrationId}).forUpdate(true).one()
    const reason = text(p.reason) ? String(p.reason).trim().slice(0, limits.reason) : null
    if (!asked.byCode && !reason) denied("REASON_REQUIRED", "Say why the attendee is checked in without their entry code")
    if (!blank(p.expectedRevision) && String(p.expectedRevision) !== revisionOf(row))
        denied("REVISION_CHANGED", "The registration changed since you looked it up: look it up again")
    const decision = decisionOf(door, row)
    if (decision.reasonCode === "ALREADY_CHECKED_IN")
        return {registrationId: row.registrationId, checkedIn: true, repeated: true, decision}
    const override = yes(p.override)
    let methodEnumId = asked.byCode ? "EamCode" : "EamLookup"
    if (!decision.eligible) {
        if (!(override && decision.overridable)) denied(decision.reasonCode, decision.decisionText)
        if (!reason) denied("REASON_REQUIRED", "Say why the attendee is admitted though their place is not confirmed")
        methodEnumId = "EamOverride"
    }
    const operationKey = text(p.operationKey) ? String(p.operationKey).trim().slice(0, 60) : null
    call("create#" + ATTENDANCE, {
        registrationId: row.registrationId,
        registrationPolicyId: row.registrationPolicyId,
        workEffortId: door.policy.workEffortId,
        organizationPartyId: door.policy.organizationPartyId,
        attendeePartyId: row.attendeePartyId,
        ticketTypeId: row.ticketTypeId,
        methodEnumId,
        statusIdAtCheckIn: row.statusId,
        credentialRevision: asked.byCode ? (row.credentialRevision ?? null) : null,
        reason,
        deviceId: door.device?.deviceId || null,
        checkInByUserId: ec.user.userId || null,
        checkInDate: ec.user.nowTimestamp,
        operationKey
    })
    call("create#" + ACTION, {
        registrationId: row.registrationId,
        actionEnumId: "EraCheckedIn",
        fromStatusId: row.statusId,
        toStatusId: row.statusId,
        credentialRevision: asked.byCode ? (row.credentialRevision ?? null) : null,
        reason: methodEnumId === "EamCode" ? null : L(methodTexts[methodEnumId]) + ": " + reason,
        operationKey: operationKey ? "checkin:" + operationKey : null,
        actorUserId: ec.user.userId || null,
        actionDate: ec.user.nowTimestamp
    })
    return {registrationId: row.registrationId, checkedIn: true, repeated: false, decision: decisionOf(door, row)}
}
// get#Attendance: one registration's attendance for an events manager of its organization (RegistrationDetail's Attendance).
function getAttendance(p) {
    const userScope = marketingAccess.scope()
    marketingAccess.requireCapability(userScope, "eventManage")
    const row = blank(p.registrationId) ? null : one(REGISTRATION, {registrationId: text(p.registrationId)})
    const policy = row ? one(POLICY, {registrationPolicyId: row.registrationPolicyId}) : null
    if (!row || !policy || !marketingAccess.covers(userScope, policy.organizationPartyId))
        denied("RECORD_UNAVAILABLE", "Registration " + (p.registrationId || "") + " is not available")
    const door = {policy, staff: true}
    const attendance = one(ATTENDANCE, {registrationId: row.registrationId})
    return {
        attended: !!attendance,
        attendance: attendance
            ? Object.assign(attendanceView(door, attendance, policy.timeZone), {
                  methodEnumId: attendance.methodEnumId,
                  credentialRevision: attendance.credentialRevision ?? null
              })
            : null,
        decision: decisionOf(door, row)
    }
}

const operations = {previewCheckIn, resolveEntryCode, checkInRegistration, getAttendance}
;({
    reasonTexts,
    // each operation checks the caller itself (an events manager of the offer's organization, or the offer's door tablet) and reads
    // and writes with artifact authorization off
    execute(op, parameters) {
        if (!Object.hasOwn(operations, op)) throw new Error("Unknown event check-in operation " + op)
        const wasDisabled = ec.artifactExecution.disableAuthz()
        try {
            return operations[op](parameters || {})
        } finally {
            if (!wasDisabled) ec.artifactExecution.enableAuthz()
        }
    }
})
