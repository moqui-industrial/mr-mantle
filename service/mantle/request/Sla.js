// Service levels of support cases (design-customer-service §3 CaseDetail, §7 CaseAnalytics, §9 ServiceLevelPolicies;
// impl-customer-service P4, CS-SLA, CS-JOBS, D23, F8, F32, F64, F83; SupportSlaEntities.xml; SlaServices.xml). A case gets
// its clocks at intake (start#CaseEpisode, from ensure#CaseProfile): the policy of its organization whose conditions hold,
// the most specific first (a service agreement, the customer, the queue, the type, the default; impl-customer-service §4), as
// in effect at the accepted intake time, and its target for the case's priority band. Each clock is an episode bound to that
// row, target and calendar (the policy's, else the queue team's working hours, BusinessTime.js) and storing its deadlines,
// so a later publish, holiday or hours edit re-selects and rewrites nothing. First response is met by the first outward
// response its channel accepted (a sent reply; never a note, an acknowledgement or a send that failed) and never restarts;
// resolution pauses while the case waits for the customer (and on an internal hold only when the policy says so), ends when
// the case is resolved, and a reopen starts a new resolution episode, the earlier one keeping its figures. The rules of
// entity/Request.eecas.xml record every path (a status change from any screen or service, a message, work); only these
// functions write Request.responseRequiredDate on a case (the current resolution due date, empty while paused), through the
// Request entity, so update#Request's guard (CASE_MANAGED) holds for every other path. The scan (scan#CaseSla) records
// warnings and breaches once per episode. Refusals carry reason codes (EntityLib.denied).
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const facilityScope = ec.resource.script("component://mr-mantle/service/mantle/facility/FacilityScope.js")
const time = ec.resource.script("component://mr-mantle/service/mantle/work/BusinessTime.js")
const {find, one, rows, call, denied, access, ms} = lib

const REQUEST = "mantle.request.Request",
    PARTY = "mantle.request.RequestParty",
    PROFILE = "mantle.request.support.CaseProfile",
    QUEUE = "mantle.request.support.ServiceQueue",
    MAPPING = "mantle.request.support.CaseStatusMapping",
    POLICY = "mantle.request.support.ServiceLevelPolicy",
    TARGET = "mantle.request.support.ServiceLevelTarget",
    EPISODE = "mantle.request.support.CaseSlaEpisode",
    EVENT = "mantle.request.support.CaseSlaEvent",
    COMM = "mantle.party.communication.CommunicationEvent"
const FIRST = "SlcFirstResponse",
    RESOLUTION = "SlcResolution"
const RUNNING = "SlsRunning",
    PAUSED = "SlsPaused",
    MET = "SlsMet",
    MISSED = "SlsMissed",
    UNMET = "SlsUnmet",
    CANCELLED = "SlsCancelled"
const openStates = [RUNNING, PAUSED]
const minuteMs = 60000
// message types that answer no one: a note, an automatic message, a status update, an internal message
const notResponses = ["Comment", "AutoEmail", "StatusUpdate", "Message"]

const blank = value => value == null || String(value).trim() === ""
const text = value => (blank(value) ? null : String(value).trim())
const yn = (value, fallback = "N") => (value === true || value === "Y" || value === "true" ? "Y" : blank(value) ? fallback : "N")
const nowMs = () => Number(ms(ec.user.nowTimestamp))
const stamp = millis => (millis == null ? null : new Date(Number(millis)))
const msOf = value => (value == null || value === "" ? null : Number(ms(value)))
const factory = () => ec.entity.conditionFactory
const enumText = enumId => (enumId ? one("moqui.basic.Enumeration", {enumId})?.description || enumId : "")
const partyName = partyId => (partyId ? lib.partyNames([partyId])[partyId] || partyId : "")
const textAt = (millis, zone) =>
    millis == null ? "" : ec.l10n.format(new Date(Number(millis)), "EEE d MMM yyyy HH:mm", null, zone || null)
const durationText = minutes => {
    if (minutes == null) return ""
    const total = Math.max(0, Math.round(Number(minutes)))
    const days = Math.floor(total / 1440),
        hours = Math.floor((total % 1440) / 60),
        mins = total % 60
    return [days ? days + " d" : "", hours ? hours + " h" : "", mins || (!days && !hours) ? mins + " min" : ""]
        .filter(Boolean)
        .join(" ")
}

// ===== effective-dated rows =====
function currentRows(entity, conditions, date = ec.user.nowTimestamp) {
    return Array.from(
        find(entity, conditions)
            .condition(factory().makeCondition("fromDate", "is-not-null", null))
            .conditionDate("fromDate", "thruDate", date)
            .orderBy("-fromDate")
            .list()
    )
}
const roleParty = (requestId, roleTypeId) => currentRows(PARTY, {requestId, roleTypeId})[0]?.partyId || null
function mappingCategory(caseWorkflowId, statusId) {
    const row =
        currentRows(MAPPING, {caseWorkflowId: caseWorkflowId || "CwfDefault", statusId})[0] ||
        currentRows(MAPPING, {caseWorkflowId: "CwfDefault", statusId})[0]
    return row?.statusCategoryEnumId || null
}
function bandOf(priority) {
    const value = priority == null || priority === "" ? 5 : Number(priority)
    return (
        rows("moqui.basic.Enumeration", {enumTypeId: "CasePriorityBand"}).find(
            band => value >= Number(band.enumCode) && value <= Number(band.optionValue)
        )?.enumId || "CpbNormal"
    )
}

// ===== access =====
function requirePermission(...permissions) {
    if (!permissions.some(permission => access.has(permission)))
        denied("PERMISSION_DENIED", permissions.join(" or ") + " is required")
}
function requireOrganization(organizationPartyId) {
    if (
        !organizationPartyId ||
        !one("mantle.party.PartyRole", {partyId: organizationPartyId, roleTypeId: "OrgInternal"}) ||
        !facilityScope.owns(facilityScope.scope(), organizationPartyId)
    )
        denied("RECORD_UNAVAILABLE", "Organization " + (organizationPartyId || "") + " is not available")
    return String(organizationPartyId)
}
// A case of one of the user's organizations; a missing request, one that is not a case and another organization's are
// refused alike (RECORD_UNAVAILABLE).
function caseOf(requestId) {
    const unavailable = () => denied("RECORD_UNAVAILABLE", "Case " + (requestId || "") + " is not available")
    const request = requestId ? one(REQUEST, {requestId}) : null
    const profile = request ? one(PROFILE, {requestId}) : null
    if (!profile) unavailable()
    const organizationPartyId = roleParty(requestId, "OrgInternal")
    if (!organizationPartyId || !facilityScope.owns(facilityScope.scope(), organizationPartyId)) unavailable()
    return {request, profile, requestId: String(requestId), organizationPartyId}
}

// ===== policies =====
const conditionFields = ["agreementId", "customerPartyId", "requestCategoryId", "requestTypeEnumId"]
// The rank of a policy: its most specific condition decides (agreement 8, customer 4, queue 2, type 1; the default 0).
const rankOf = policy =>
    (policy.agreementId ? 8 : 0) +
    (policy.customerPartyId ? 4 : 0) +
    (policy.requestCategoryId ? 2 : 0) +
    (policy.requestTypeEnumId ? 1 : 0)
const sameConditions = (a, b) => conditionFields.every(field => (a[field] || null) === (b[field] || null))
// The service agreements in effect of an organization with a customer (AgrService; active by its dates, and by its status
// when it has one).
function agreementsOf(organizationPartyId, customerPartyId, date) {
    if (!organizationPartyId || !customerPartyId) return []
    return Array.from(
        find("mantle.party.agreement.Agreement", {
            agreementTypeEnumId: "AgrService",
            organizationPartyId,
            otherPartyId: customerPartyId
        })
            .conditionDate("fromDate", "thruDate", date)
            .list()
    )
        .filter(row => !row.statusId || row.statusId === "AgmStActive")
        .map(row => row.agreementId)
}
// The policy of a case's facts at a date: the most specific current row whose conditions all hold.
function selectPolicy(facts, date) {
    const agreements = agreementsOf(facts.organizationPartyId, facts.customerPartyId, date)
    const holds = policy =>
        (!policy.agreementId || agreements.includes(policy.agreementId)) &&
        (!policy.customerPartyId || policy.customerPartyId === facts.customerPartyId) &&
        (!policy.requestCategoryId || policy.requestCategoryId === facts.requestCategoryId) &&
        (!policy.requestTypeEnumId || policy.requestTypeEnumId === facts.requestTypeEnumId)
    return (
        currentRows(POLICY, {organizationPartyId: facts.organizationPartyId}, date)
            .filter(holds)
            .sort((a, b) => rankOf(b) - rankOf(a) || Number(ms(b.fromDate)) - Number(ms(a.fromDate)))[0] || null
    )
}
// A policy row's target for a band (the targets are its row's, dated with it).
const targetOf = (serviceLevelPolicyId, priorityBandEnumId) => rows(TARGET, {serviceLevelPolicyId, priorityBandEnumId})[0] || null
// The schedule of a policy for a case: its calendar, else the working hours of the queue's responsible team; the case's
// organization's holidays.
function scheduleFor(policy, requestCategoryId, organizationPartyId, date) {
    let calendarId = policy.calendarId || null
    if (!calendarId && requestCategoryId) {
        const queue = currentRows(QUEUE, {requestCategoryId}, date)[0]
        calendarId = time.scheduleCalendarId(queue?.responsibleTeamPartyId)
    }
    return time.scheduleOf({calendarId, organizationPartyId, timeZone: policy.timeZone || null})
}
const scheduleOfEpisode = episode => ({
    key: episode.calendarId || "_NA_",
    calendarId: episode.calendarId || null,
    timeZone: episode.timeZone || null,
    organizationPartyId: episode.organizationPartyId || null
})
// The due and warning instants of a clock started at startMs.
function deadlines(ctx, schedule, startMs, targetMinutes, warningMinutes) {
    const dueMs = time.dueAfter(ctx, schedule, startMs, targetMinutes)
    const warn = Number(warningMinutes) > 0 && Number(warningMinutes) < Number(targetMinutes)
    return {dueMs, warningMs: warn ? time.dueAfter(ctx, schedule, startMs, Number(targetMinutes) - Number(warningMinutes)) : null}
}

// ===== events =====
// An event, once by its key (a rule or a scan run twice records once).
function addEvent(fields) {
    if (fields.eventKey && one(EVENT, {eventKey: fields.eventKey})) return null
    return call("create#" + EVENT, Object.assign({eventDate: ec.user.nowTimestamp, userId: ec.user.userId || null}, fields))
        .caseSlaEventId
}
const episodesOf = requestId => Array.from(find(EPISODE, {requestId}).orderBy("clockEnumId").orderBy("sequenceNum").list())
const openEpisode = (requestId, clockEnumId) =>
    Array.from(
        find(EPISODE, {requestId, clockEnumId}).condition("stateEnumId", "in", openStates).orderBy("-sequenceNum").list()
    )[0] || null
// The case's due date mirrors its current resolution clock (empty while it is paused), written through the entity.
function mirrorDue(requestId) {
    const episode = Array.from(find(EPISODE, {requestId, clockEnumId: RESOLUTION}).orderBy("-sequenceNum").limit(1).list())[0]
    if (!episode) return
    const due = episode.stateEnumId === PAUSED ? null : msOf(episode.dueDate)
    const request = one(REQUEST, {requestId})
    if (msOf(request?.responseRequiredDate) === due) return
    call("update#" + REQUEST, {requestId, responseRequiredDate: stamp(due)})
}
// A clock ends at atMs: met when on time, else missed (its breach recorded at its due time when the scan had not).
function complete(episode, atMs, eventFields = {}) {
    const due = msOf(episode.dueDate)
    const late = due != null && atMs > due
    episode.set("actualDate", stamp(atMs))
    episode.set("stateEnumId", late ? MISSED : MET)
    if (late && !episode.breachedDate) episode.set("breachedDate", stamp(due))
    episode.update()
    addEvent(
        Object.assign(
            {
                requestId: episode.requestId,
                caseSlaEpisodeId: episode.caseSlaEpisodeId,
                eventTypeEnumId: late ? "SetMissed" : "SetMet",
                dueDate: episode.dueDate
            },
            eventFields,
            {eventDate: stamp(atMs)}
        )
    )
}
// A paused clock resumes at atMs: the business minutes left when it paused count from then.
function resume(ctx, episode, atMs) {
    const schedule = scheduleOfEpisode(episode)
    const pausedMs = msOf(episode.pausedDate) ?? atMs
    const dueMs = msOf(episode.dueDate)
    const left = dueMs != null && dueMs > pausedMs ? time.elapsedMinutes(ctx, schedule, pausedMs, dueMs) : 0
    const paused = time.elapsedMinutes(ctx, schedule, pausedMs, atMs)
    const newDue = dueMs != null && dueMs > pausedMs ? time.dueAfter(ctx, schedule, atMs, left) : dueMs
    const warnLeft = left - Number(episode.warningMinutes || 0)
    episode.set("dueDate", stamp(newDue))
    if (!episode.warnedDate && Number(episode.warningMinutes) > 0)
        episode.set("warningDate", stamp(warnLeft > 0 ? time.dueAfter(ctx, schedule, atMs, warnLeft) : atMs))
    episode.set("pausedMinutes", Number(episode.pausedMinutes || 0) + paused)
    episode.set("pausedDate", null)
    episode.set("stateEnumId", RUNNING)
    episode.update()
    return {pausedMinutes: paused}
}

// ===== start#CaseEpisode =====
// The case's clocks at intake, once: the policy and target, the calendar, and the first response and first resolution
// episodes from the accepted intake time; the case's due date becomes the resolution due date (replacing one a Projects
// request or a mail brought). With no policy it records that, and leaves the case's due date.
function startEpisode(p) {
    const requestId = p.requestId
    const profile = one(PROFILE, {requestId})
    if (!profile) return {started: false, reason: "NOT_A_CASE"}
    if (episodesOf(requestId).length || one(EVENT, {eventKey: "nopolicy:" + requestId}))
        return {started: false, reason: "STARTED"}
    const request = one(REQUEST, {requestId})
    const organizationPartyId = roleParty(requestId, "OrgInternal")
    const intakeMs = msOf(profile.intakeDate) ?? msOf(request.requestDate) ?? nowMs()
    const facts = {
        organizationPartyId,
        customerPartyId: roleParty(requestId, "Customer"),
        requestCategoryId: request.requestCategoryId,
        requestTypeEnumId: request.requestTypeEnumId
    }
    // the policy in effect at intake (a request made before its policy started is taken by the one in effect now)
    const policy = selectPolicy(facts, stamp(intakeMs)) || selectPolicy(facts, ec.user.nowTimestamp)
    if (!policy) {
        addEvent({requestId, eventTypeEnumId: "SetNoPolicy", eventKey: "nopolicy:" + requestId, eventDate: stamp(intakeMs)})
        return {started: false, reason: "NO_POLICY"}
    }
    const band = bandOf(request.priority)
    const target = targetOf(policy.serviceLevelPolicyId, band)
    const schedule = scheduleFor(policy, request.requestCategoryId, organizationPartyId, stamp(intakeMs))
    const ctx = time.forCall()
    const made = []
    for (const [clockEnumId, minutes] of [
        [FIRST, target?.firstResponseMinutes],
        [RESOLUTION, target?.resolutionMinutes]
    ]) {
        if (minutes == null) continue
        const {dueMs, warningMs} = deadlines(ctx, schedule, intakeMs, minutes, target.warningMinutes)
        made.push(
            call("create#" + EPISODE, {
                requestId,
                clockEnumId,
                sequenceNum: 1,
                serviceLevelPolicyId: policy.serviceLevelPolicyId,
                serviceLevelTargetId: target.serviceLevelTargetId,
                priorityBandEnumId: band,
                calendarId: schedule.calendarId,
                timeZone: schedule.timeZone,
                organizationPartyId,
                targetMinutes: Number(minutes),
                warningMinutes: target.warningMinutes == null ? null : Number(target.warningMinutes),
                startDate: stamp(intakeMs),
                dueDate: stamp(dueMs),
                warningDate: stamp(warningMs),
                pausedMinutes: 0,
                stateEnumId: RUNNING
            }).caseSlaEpisodeId
        )
    }
    addEvent({
        requestId,
        eventTypeEnumId: "SetIntake",
        eventKey: "intake:" + requestId,
        eventDate: stamp(intakeMs),
        statusId: request.statusId
    })
    if (made.length) mirrorDue(requestId)
    return {started: made.length > 0, serviceLevelPolicyId: policy.serviceLevelPolicyId, episodeIds: made}
}

// ===== record#CaseEvent =====
// A status change of a case from any path (the SupportCaseSlaRule rule): its event, and what it does to the clocks.
function recordStatus(p) {
    const requestId = p.requestId
    const profile = one(PROFILE, {requestId})
    if (!profile) return {}
    const ctx = time.forCall()
    const at = nowMs()
    const statusId = p.statusId
    const fromStatusId = p.fromStatusId
    if (statusId && statusId !== fromStatusId) {
        addEvent({requestId, eventTypeEnumId: "SetStatus", fromStatusId, statusId})
        const category = mappingCategory(profile.caseWorkflowId, statusId)
        const fromCategory = mappingCategory(profile.caseWorkflowId, fromStatusId)
        const resolution = openEpisode(requestId, RESOLUTION)
        const policy = resolution?.serviceLevelPolicyId
            ? one(POLICY, {serviceLevelPolicyId: resolution.serviceLevelPolicyId})
            : null
        const pauses = status =>
            status === "ReqOnHold" ? policy?.holdPauses === "Y" : mappingCategory(profile.caseWorkflowId, status) === "CscPaused"
        if (statusId === "ReqCancelled" || category === "CscCancelled") {
            for (const episode of episodesOf(requestId).filter(row => openStates.includes(row.stateEnumId))) {
                episode.set("stateEnumId", CANCELLED)
                episode.set("actualDate", stamp(at))
                episode.update()
                addEvent({requestId, caseSlaEpisodeId: episode.caseSlaEpisodeId, eventTypeEnumId: "SetCancelled", statusId})
            }
        } else if (statusId === "ReqCompleted" || category === "CscResolved" || category === "CscClosed") {
            if (resolution) {
                if (resolution.stateEnumId === PAUSED) resume(ctx, resolution, at)
                complete(resolution, at, {statusId})
            }
            const first = openEpisode(requestId, FIRST)
            if (first) {
                // resolved with no response: the first response clock closes unmet, never as met
                first.set("stateEnumId", UNMET)
                first.set("actualDate", null)
                if (!first.breachedDate && msOf(first.dueDate) != null && at > msOf(first.dueDate))
                    first.set("breachedDate", first.dueDate)
                first.update()
                addEvent({requestId, caseSlaEpisodeId: first.caseSlaEpisodeId, eventTypeEnumId: "SetUnmet", statusId})
            }
        } else if (fromStatusId === "ReqCompleted" || fromCategory === "CscResolved") {
            // a reopen: a new resolution episode, bound to the row of the case's earlier one; first response never restarts
            const last = Array.from(
                find(EPISODE, {requestId, clockEnumId: RESOLUTION}).orderBy("-sequenceNum").limit(1).list()
            )[0]
            const lastPolicy = last ? one(POLICY, {serviceLevelPolicyId: last.serviceLevelPolicyId}) : null
            if (last && (lastPolicy?.reopenEnumId || "SrpNewEpisode") === "SrpNewEpisode") {
                const schedule = scheduleOfEpisode(last)
                const {dueMs, warningMs} = deadlines(ctx, schedule, at, last.targetMinutes, last.warningMinutes)
                const episodeId = call("create#" + EPISODE, {
                    requestId,
                    clockEnumId: RESOLUTION,
                    sequenceNum: Number(last.sequenceNum || 1) + 1,
                    serviceLevelPolicyId: last.serviceLevelPolicyId,
                    serviceLevelTargetId: last.serviceLevelTargetId,
                    priorityBandEnumId: last.priorityBandEnumId,
                    calendarId: last.calendarId,
                    timeZone: last.timeZone,
                    organizationPartyId: last.organizationPartyId,
                    targetMinutes: last.targetMinutes,
                    warningMinutes: last.warningMinutes,
                    startDate: stamp(at),
                    dueDate: stamp(dueMs),
                    warningDate: stamp(warningMs),
                    pausedMinutes: 0,
                    stateEnumId: pauses(statusId) ? PAUSED : RUNNING,
                    pausedDate: pauses(statusId) ? stamp(at) : null
                }).caseSlaEpisodeId
                addEvent({
                    requestId,
                    caseSlaEpisodeId: episodeId,
                    eventTypeEnumId: "SetReopen",
                    fromStatusId,
                    statusId,
                    dueDate: stamp(dueMs)
                })
            } else addEvent({requestId, eventTypeEnumId: "SetReopen", fromStatusId, statusId})
        } else if (resolution) {
            if (pauses(statusId) && resolution.stateEnumId === RUNNING) {
                resolution.set("stateEnumId", PAUSED)
                resolution.set("pausedDate", stamp(at))
                resolution.update()
                addEvent({
                    requestId,
                    caseSlaEpisodeId: resolution.caseSlaEpisodeId,
                    eventTypeEnumId: "SetPause",
                    fromStatusId,
                    statusId
                })
            } else if (!pauses(statusId) && resolution.stateEnumId === PAUSED) {
                const out = resume(ctx, resolution, at)
                addEvent({
                    requestId,
                    caseSlaEpisodeId: resolution.caseSlaEpisodeId,
                    eventTypeEnumId: "SetResume",
                    fromStatusId,
                    statusId,
                    dueDate: resolution.dueDate,
                    reasonText: durationText(out.pausedMinutes) + " paused"
                })
            }
        }
        mirrorDue(requestId)
    }
    if (p.resolutionChanged && p.requestResolutionEnumId && statusId === fromStatusId)
        addEvent({requestId, eventTypeEnumId: "SetResolution", statusId, reasonText: enumText(p.requestResolutionEnumId)})
    if (p.dueChanged) {
        // a due date written by anything but these functions (a raw entity write; update#Request refuses one): recorded
        const current = Array.from(find(EPISODE, {requestId, clockEnumId: RESOLUTION}).orderBy("-sequenceNum").limit(1).list())[0]
        const expected = current ? (current.stateEnumId === PAUSED ? null : msOf(current.dueDate)) : undefined
        const written = msOf(p.responseRequiredDate)
        if (current && expected !== written)
            addEvent({
                requestId,
                caseSlaEpisodeId: current.caseSlaEpisodeId,
                eventTypeEnumId: "SetDueChanged",
                previousDueDate: stamp(expected),
                dueDate: stamp(written)
            })
    }
    return {}
}
// The reason of the status change just recorded (transition#Case's reason): on its status events of this moment.
function attachReason(requestId, statusId, reason) {
    const words = text(reason)
    if (!words) return
    for (const event of Array.from(
        find(EVENT, {requestId, statusId})
            .condition("eventDate", "greater-equals", stamp(nowMs() - 5000))
            .condition("reasonText", "is-null", null)
            .list()
    )) {
        event.set("reasonText", words.substring(0, 255))
        event.update()
    }
}
// Whether a party is the service side (internal, or works for an internal organization).
function staffSide(partyId) {
    if (!partyId) return false
    if (one("mantle.party.PartyRole", {partyId, roleTypeId: "OrgInternal"})) return true
    return currentRows("mantle.party.PartyRelationship", {fromPartyId: partyId})
        .filter(row => ["PrtEmployee", "PrtAgent", "PrtMember", "PrtRepresentative"].includes(row.relationshipTypeEnumId))
        .some(row => !!one("mantle.party.PartyRole", {partyId: row.toPartyId, roleTypeId: "OrgInternal"}))
}
// A message filed on a case (the SupportCaseSlaMessage rule): an outward response its channel accepted (from the service side,
// not a note, an automatic message or an acknowledgement, and for a mail, sent) meets first response; a message from the
// customer side is a customer reply. Anything else records nothing.
function recordMessage(p) {
    const requestId = p.requestId
    if (!one(PROFILE, {requestId})) return {}
    const event = one(COMM, {communicationEventId: p.communicationEventId})
    if (!event || ["CeCancelled", "CeBounced"].includes(event.statusId)) return {}
    if (notResponses.includes(event.communicationEventTypeId)) return {}
    if (
        one("mantle.party.communication.CommunicationEventPurpose", {
            communicationEventId: event.communicationEventId,
            purposeEnumId: "CpAcknowledgement"
        })
    )
        return {}
    const mail = event.emailMessageId ? one("moqui.basic.email.EmailMessage", {emailMessageId: event.emailMessageId}) : null
    if (staffSide(event.fromPartyId)) {
        // a mail counts once it is sent (filed from ES_SENT, file#SentEmail); one waiting or failed does not
        if (event.emailMessageId && mail?.statusId !== "ES_SENT") return {}
        const atMs =
            msOf(mail?.sentDate) ?? msOf(event.datetimeEnded) ?? msOf(event.datetimeStarted) ?? msOf(event.entryDate) ?? nowMs()
        const added = addEvent({
            requestId,
            eventTypeEnumId: "SetResponse",
            communicationEventId: event.communicationEventId,
            eventKey: "response:" + event.communicationEventId,
            eventDate: stamp(atMs)
        })
        const first = added ? openEpisode(requestId, FIRST) : null
        if (first)
            complete(first, Math.max(atMs, msOf(first.startDate) ?? atMs), {communicationEventId: event.communicationEventId})
        return {response: !!added}
    }
    if (event.fromPartyId)
        addEvent({
            requestId,
            eventTypeEnumId: "SetCustomerReply",
            communicationEventId: event.communicationEventId,
            eventKey: "reply:" + event.communicationEventId
        })
    return {}
}
// Work made or linked on a case (the SupportCaseSlaWork rule).
function recordWork(p) {
    if (!one(PROFILE, {requestId: p.requestId})) return {}
    addEvent({
        requestId: p.requestId,
        eventTypeEnumId: "SetWork",
        workEffortId: p.workEffortId,
        eventKey: "work:" + p.requestId + ":" + p.workEffortId
    })
    return {}
}

// ===== correct#CaseSla =====
// A manager's reasoned correction of a clock's due date: the earlier figure stays on its event; a clock already ended is met or
// missed again by its actual time.
function correct(p) {
    requirePermission("SUPPORT_CASE_MANAGE")
    const theCase = caseOf(p.requestId)
    const episode = one(EPISODE, {caseSlaEpisodeId: p.caseSlaEpisodeId})
    if (!episode || episode.requestId !== theCase.requestId)
        denied("RECORD_UNAVAILABLE", "Clock " + (p.caseSlaEpisodeId || "") + " is not this case's")
    const reason = text(p.reason)
    if (!reason) denied("REASON_REQUIRED", "A correction needs its reason")
    const newDue = msOf(p.dueDate)
    if (newDue == null) denied("DUE_REQUIRED", "Give the corrected due time")
    if (episode.stateEnumId === CANCELLED) denied("CLOCK_CANCELLED", "A cancelled case's clock is not corrected")
    const previous = msOf(episode.dueDate)
    const warningOffset = previous != null && msOf(episode.warningDate) != null ? previous - msOf(episode.warningDate) : null
    episode.set("dueDate", stamp(newDue))
    if (warningOffset != null && !episode.warnedDate) episode.set("warningDate", stamp(newDue - warningOffset))
    if (episode.actualDate && [MET, MISSED].includes(episode.stateEnumId)) {
        const late = msOf(episode.actualDate) > newDue
        episode.set("stateEnumId", late ? MISSED : MET)
        episode.set("breachedDate", late ? stamp(newDue) : null)
    } else if (openStates.includes(episode.stateEnumId) && episode.breachedDate && newDue > nowMs())
        episode.set("breachedDate", null)
    episode.update()
    addEvent({
        requestId: theCase.requestId,
        caseSlaEpisodeId: episode.caseSlaEpisodeId,
        eventTypeEnumId: "SetCorrection",
        previousDueDate: stamp(previous),
        dueDate: stamp(newDue),
        reasonText: reason.substring(0, 255)
    })
    if (episode.clockEnumId === RESOLUTION) mirrorDue(theCase.requestId)
    return {caseSlaEpisodeId: episode.caseSlaEpisodeId}
}

// ===== get#CaseSlaHistory =====
// A case's clocks and events for CaseDetail and CaseAnalytics, with display text in the clock's zone: each clock's state,
// start, due, warning and actual times, elapsed and remaining business minutes now, paused minutes, breach, its policy row and
// calendar; each event in order.
function history(p) {
    const theCase = caseOf(p.requestId)
    const ctx = time.forCall()
    const now = nowMs()
    const policies = new Map()
    const policyOf = id => {
        if (!id) return null
        if (!policies.has(id)) policies.set(id, one(POLICY, {serviceLevelPolicyId: id}))
        return policies.get(id)
    }
    const clocks = episodesOf(theCase.requestId)
        .sort((a, b) =>
            a.clockEnumId === b.clockEnumId ? Number(a.sequenceNum) - Number(b.sequenceNum) : a.clockEnumId === FIRST ? -1 : 1
        )
        .map(episode => {
            const schedule = scheduleOfEpisode(episode)
            const zone = episode.timeZone || null
            const start = msOf(episode.startDate),
                due = msOf(episode.dueDate),
                actual = msOf(episode.actualDate)
            const open = openStates.includes(episode.stateEnumId)
            // the business time it ran: to its end, its pause, or now, less the pauses before
            const until = actual ?? (episode.stateEnumId === PAUSED ? msOf(episode.pausedDate) : open ? now : null)
            const elapsed =
                start != null && until != null
                    ? time.elapsedMinutes(ctx, schedule, start, until) - Number(episode.pausedMinutes || 0)
                    : null
            const remaining =
                open && due != null
                    ? episode.stateEnumId === PAUSED
                        ? time.elapsedMinutes(ctx, schedule, msOf(episode.pausedDate), due)
                        : due > now
                          ? time.elapsedMinutes(ctx, schedule, now, due)
                          : 0
                    : null
            const breached = !!episode.breachedDate || (open && episode.stateEnumId === RUNNING && due != null && due < now)
            const policy = policyOf(episode.serviceLevelPolicyId)
            const label =
                enumText(episode.clockEnumId) +
                (episode.clockEnumId === RESOLUTION && Number(episode.sequenceNum) > 1 ? " " + episode.sequenceNum : "")
            const color = breached
                ? "negative"
                : episode.stateEnumId === PAUSED
                  ? "grey-7"
                  : open && episode.warningDate && msOf(episode.warningDate) <= now
                    ? "warning"
                    : [MET].includes(episode.stateEnumId)
                      ? "positive"
                      : open
                        ? "primary"
                        : "grey-7"
            return {
                caseSlaEpisodeId: episode.caseSlaEpisodeId,
                clockEnumId: episode.clockEnumId,
                sequenceNum: Number(episode.sequenceNum || 1),
                label,
                stateEnumId: episode.stateEnumId,
                stateText: breached && open ? "Breached" : enumText(episode.stateEnumId),
                color,
                open,
                breached,
                startText: textAt(start, zone),
                dueText: episode.stateEnumId === PAUSED ? "Paused" : textAt(due, zone),
                warningText: textAt(msOf(episode.warningDate), zone),
                actualText: textAt(actual, zone),
                breachedText: textAt(msOf(episode.breachedDate), zone),
                targetText: durationText(episode.targetMinutes) + " business time",
                elapsedText: elapsed == null ? "" : durationText(Math.max(0, elapsed)),
                remainingText: remaining == null ? "" : durationText(remaining),
                pausedText: durationText(Number(episode.pausedMinutes || 0)),
                bandText: enumText(episode.priorityBandEnumId),
                policyName: policy?.policyName || episode.serviceLevelPolicyId || "",
                serviceLevelPolicyId: episode.serviceLevelPolicyId,
                calendarText: episode.calendarId
                    ? one("mantle.work.calendar.Calendar", {calendarId: episode.calendarId})?.calendarName || episode.calendarId
                    : "Around the clock",
                timeZone: zone || ""
            }
        })
    // the events in the zone of the case's clocks (the first one's), so they read with them
    const caseZone = clocks[0]?.timeZone || null
    const events = Array.from(
        find(EVENT, {requestId: theCase.requestId}).orderBy("eventDate").orderBy("caseSlaEventId").list()
    ).map(event => {
        const episode = event.caseSlaEpisodeId ? clocks.find(clock => clock.caseSlaEpisodeId === event.caseSlaEpisodeId) : null
        const status = id => (id ? one("moqui.basic.StatusItem", {statusId: id})?.description || id : "")
        const detail = [
            event.fromStatusId || event.statusId
                ? [status(event.fromStatusId), status(event.statusId)].filter(Boolean).join(" → ")
                : "",
            event.previousDueDate || event.eventTypeEnumId === "SetCorrection"
                ? "due " + textAt(msOf(event.previousDueDate), caseZone) + " → " + textAt(msOf(event.dueDate), caseZone)
                : event.dueDate
                  ? "due " + textAt(msOf(event.dueDate), caseZone)
                  : "",
            event.communicationEventId ? "message " + event.communicationEventId : "",
            event.workEffortId ? "work " + event.workEffortId : ""
        ]
            .filter(Boolean)
            .join(" · ")
        const user = event.userId ? one("moqui.security.UserAccount", {userId: event.userId}) : null
        return {
            caseSlaEventId: event.caseSlaEventId,
            eventTypeEnumId: event.eventTypeEnumId,
            typeText: enumText(event.eventTypeEnumId),
            clockLabel: episode?.label || "",
            dateText: textAt(msOf(event.eventDate), caseZone),
            detail,
            reasonText: event.reasonText || "",
            userName: user ? partyName(user.partyId) || user.username || "" : "",
            communicationEventId: event.communicationEventId || null
        }
    })
    const noPolicy = !clocks.length && events.some(event => event.eventTypeEnumId === "SetNoPolicy")
    return {requestId: theCase.requestId, clocks, events, configured: clocks.length > 0, noPolicy}
}

// ===== find#Policies, save#Policy, simulate#Policy =====
const policyState = (row, now = nowMs()) =>
    !row.fromDate
        ? "Draft"
        : msOf(row.fromDate) > now
          ? "Scheduled"
          : row.thruDate && msOf(row.thruDate) <= now
            ? "Ended"
            : "In effect"
function conditionText(row) {
    const parts = []
    if (row.agreementId)
        parts.push(
            "agreement " +
                (one("mantle.party.agreement.Agreement", {agreementId: row.agreementId})?.description || row.agreementId)
        )
    if (row.customerPartyId) parts.push("customer " + partyName(row.customerPartyId))
    if (row.requestCategoryId)
        parts.push(
            "queue " +
                (one("mantle.request.RequestCategory", {requestCategoryId: row.requestCategoryId})?.description ||
                    row.requestCategoryId)
        )
    if (row.requestTypeEnumId) parts.push("type " + enumText(row.requestTypeEnumId))
    return parts.length ? parts.join(", ") : "Every case (the organization's default)"
}
// The rank's name: the policy's most specific condition.
const rankText = row =>
    row.agreementId
        ? "Agreement"
        : row.customerPartyId
          ? "Customer"
          : row.requestCategoryId
            ? "Queue"
            : row.requestTypeEnumId
              ? "Type"
              : "Default"
function targetsOf(serviceLevelPolicyId) {
    const bands = rows("moqui.basic.Enumeration", {enumTypeId: "CasePriorityBand"}).sort(
        (a, b) => Number(a.sequenceNum) - Number(b.sequenceNum)
    )
    const targets = rows(TARGET, {serviceLevelPolicyId})
    return bands.map(band => {
        const row = targets.find(target => target.priorityBandEnumId === band.enumId)
        return {
            priorityBandEnumId: band.enumId,
            bandText: band.description,
            serviceLevelTargetId: row?.serviceLevelTargetId || null,
            firstResponseMinutes: row?.firstResponseMinutes != null ? String(row.firstResponseMinutes) : "",
            resolutionMinutes: row?.resolutionMinutes != null ? String(row.resolutionMinutes) : "",
            warningMinutes: row?.warningMinutes != null ? String(row.warningMinutes) : "",
            firstResponseText: row?.firstResponseMinutes != null ? durationText(row.firstResponseMinutes) : "—",
            resolutionText: row?.resolutionMinutes != null ? durationText(row.resolutionMinutes) : "—",
            warningText: row?.warningMinutes != null ? durationText(row.warningMinutes) + " before" : "—"
        }
    })
}
function findPolicies(p) {
    requirePermission("SUPPORT_POLICY_EDIT", "SUPPORT_CASE_MANAGE", "SUPPORT_CASE_EDIT")
    const organizationPartyId = requireOrganization(p.organizationPartyId)
    const now = nowMs()
    let list = Array.from(find(POLICY, {organizationPartyId}).orderBy("-fromDate").list())
    if (p.serviceLevelPolicyId) list = list.filter(row => row.serviceLevelPolicyId === p.serviceLevelPolicyId)
    else if (!(p.includeEnded === true || p.includeEnded === "Y" || p.includeEnded === "true"))
        list = list.filter(row => policyState(row, now) !== "Ended")
    const policies = list
        .map(row =>
            Object.assign(lib.map(row), {
                state: policyState(row, now),
                rank: rankOf(row),
                rankText: rankText(row),
                conditionText: conditionText(row),
                calendarText: row.calendarId
                    ? one("mantle.work.calendar.Calendar", {calendarId: row.calendarId})?.calendarName || row.calendarId
                    : "The queue team's working hours",
                periodText: row.fromDate
                    ? textAt(msOf(row.fromDate)) + (row.thruDate ? " – " + textAt(msOf(row.thruDate)) : " on")
                    : "Not published",
                holdText:
                    row.holdPauses === "Y"
                        ? "Waiting for the customer and an internal hold pause"
                        : "Waiting for the customer pauses",
                reopenText: enumText(row.reopenEnumId || "SrpNewEpisode"),
                targets: targetsOf(row.serviceLevelPolicyId)
            })
        )
        .sort((a, b) => b.rank - a.rank || String(a.policyName).localeCompare(String(b.policyName)))
    return {organizationPartyId, policies}
}
function checkCondition(p, organizationPartyId) {
    if (p.requestCategoryId) {
        const category = one("mantle.request.RequestCategory", {requestCategoryId: p.requestCategoryId})
        if (
            category?.ownerPartyId !== organizationPartyId ||
            !currentRows(QUEUE, {requestCategoryId: p.requestCategoryId}).length
        )
            denied("QUEUE_UNAVAILABLE", "The queue must be a service queue of the organization")
    }
    if (p.requestTypeEnumId && one("moqui.basic.Enumeration", {enumId: p.requestTypeEnumId})?.enumTypeId !== "RequestType")
        denied("TYPE_UNKNOWN", p.requestTypeEnumId + " is not a request type")
    if (p.customerPartyId) {
        const customer = one("mantle.party.Party", {partyId: p.customerPartyId})
        if (
            !customer ||
            !one("mantle.party.PartyRole", {partyId: p.customerPartyId, roleTypeId: "Customer"}) ||
            !["_NA_", organizationPartyId, null, undefined].includes(customer.ownerPartyId)
        )
            denied("CUSTOMER_UNAVAILABLE", "Customer " + p.customerPartyId + " is not available")
    }
    if (p.agreementId) {
        const agreement = one("mantle.party.agreement.Agreement", {agreementId: p.agreementId})
        if (agreement?.agreementTypeEnumId !== "AgrService" || agreement.organizationPartyId !== organizationPartyId)
            denied("AGREEMENT_UNAVAILABLE", "Agreement " + p.agreementId + " is not a service agreement of the organization")
    }
    if (p.calendarId) {
        const calendar = one("mantle.work.calendar.Calendar", {calendarId: p.calendarId})
        const owner = calendar?.ownerPartyId ? one("mantle.party.Party", {partyId: calendar.ownerPartyId}) : null
        if (!calendar || (owner?.partyId !== organizationPartyId && owner?.ownerPartyId !== organizationPartyId))
            denied("CALENDAR_UNAVAILABLE", "Calendar " + p.calendarId + " is not one of the organization's")
    }
}
function checkTargets(list) {
    const bands = rows("moqui.basic.Enumeration", {enumTypeId: "CasePriorityBand"}).map(row => row.enumId)
    const out = []
    for (const row of Array.from(list || [])) {
        if (!row) continue
        const values = ["firstResponseMinutes", "resolutionMinutes", "warningMinutes"].map(field =>
            blank(row[field]) ? null : Number(row[field])
        )
        if (values[0] == null && values[1] == null) continue
        if (!bands.includes(row.priorityBandEnumId))
            denied("TARGET_INVALID", (row.priorityBandEnumId || "") + " is not a priority band")
        if (values.some(value => value != null && !(Number.isInteger(value) && value > 0)))
            denied("TARGET_INVALID", "Targets are whole minutes above zero")
        if (values[2] != null && !(values[2] < Math.max(values[0] ?? 0, values[1] ?? 0)))
            denied("TARGET_INVALID", "A warning comes before its target")
        if (out.some(other => other.priorityBandEnumId === row.priorityBandEnumId))
            denied("TARGET_INVALID", "One target row per priority band")
        out.push({
            priorityBandEnumId: row.priorityBandEnumId,
            firstResponseMinutes: values[0],
            resolutionMinutes: values[1],
            warningMinutes: values[2]
        })
    }
    return out
}
function endPolicy(row, atMs) {
    row.set("thruDate", stamp(atMs))
    row.update()
    for (const target of rows(TARGET, {serviceLevelPolicyId: row.serviceLevelPolicyId}))
        if (!target.thruDate || msOf(target.thruDate) > atMs) {
            target.set("thruDate", stamp(atMs))
            target.update()
        }
}
// save#Policy: a new row (from a date, or a draft), a draft changed or published, a row replaced from a date (the new row names
// it and it ends there), or a row ended; refuses two published rows with the same conditions over the same dates.
function savePolicy(p) {
    requirePermission("SUPPORT_POLICY_EDIT")
    const existing = p.serviceLevelPolicyId ? one(POLICY, {serviceLevelPolicyId: p.serviceLevelPolicyId}) : null
    if (p.serviceLevelPolicyId && !existing)
        denied("RECORD_UNAVAILABLE", "Policy " + p.serviceLevelPolicyId + " is not available")
    const organizationPartyId = requireOrganization(existing?.organizationPartyId || p.organizationPartyId)
    if (existing && p.organizationPartyId && p.organizationPartyId !== existing.organizationPartyId)
        denied("RECORD_UNAVAILABLE", "A policy stays its organization's")
    const draft = p.draft === true || p.draft === "Y" || p.draft === "true"
    const fromMs = draft ? null : (msOf(p.fromDate) ?? nowMs())
    if (p.end === true || p.end === "Y" || p.end === "true") {
        if (!existing || !existing.fromDate) denied("RECORD_UNAVAILABLE", "Only a published policy is ended")
        endPolicy(existing, msOf(p.fromDate) ?? nowMs())
        return {serviceLevelPolicyId: existing.serviceLevelPolicyId}
    }
    const fields = {}
    for (const field of conditionFields.concat(["calendarId", "timeZone"]))
        fields[field] = p[field] != null ? text(p[field]) : existing ? existing[field] || null : null
    checkCondition(fields, organizationPartyId)
    const name = p.policyName != null ? text(p.policyName) : existing?.policyName
    if (!name) denied("NAME_REQUIRED", "A policy needs a name")
    const maxPause =
        p.maxPauseMinutes != null
            ? blank(p.maxPauseMinutes)
                ? null
                : Number(p.maxPauseMinutes)
            : (existing?.maxPauseMinutes ?? null)
    if (maxPause != null && !(Number.isInteger(maxPause) && maxPause > 0))
        denied("TARGET_INVALID", "The longest pause is whole minutes above zero")
    const reopenEnumId = p.reopenEnumId || existing?.reopenEnumId || "SrpNewEpisode"
    if (one("moqui.basic.Enumeration", {enumId: reopenEnumId})?.enumTypeId !== "SlaReopen")
        denied("REOPEN_UNKNOWN", reopenEnumId + " is not a reopen policy")
    const targets =
        p.targets !== undefined && p.targets !== null
            ? checkTargets(p.targets)
            : existing
              ? rows(TARGET, {serviceLevelPolicyId: existing.serviceLevelPolicyId}).map(row => lib.map(row))
              : []
    if (!targets.length) denied("TARGETS_REQUIRED", "A policy needs a target for at least one priority band")
    Object.assign(fields, {
        policyName: name.substring(0, 255),
        holdPauses: p.holdPauses != null ? yn(p.holdPauses) : existing?.holdPauses || "N",
        maxPauseMinutes: maxPause,
        reopenEnumId,
        changeReason: text(p.changeReason)
    })
    // a draft changes in place; a published row is replaced by a new one that names it
    const editDraft = existing && !existing.fromDate
    const replaces = editDraft ? existing.previousPolicyId || null : existing ? existing.serviceLevelPolicyId : null
    if (!draft) {
        const overlapping = currentRows(POLICY, {organizationPartyId}, stamp(fromMs))
            .concat(Array.from(find(POLICY, {organizationPartyId}).condition("fromDate", "greater", stamp(fromMs)).list()))
            .filter(row => row.serviceLevelPolicyId !== replaces && row.serviceLevelPolicyId !== existing?.serviceLevelPolicyId)
            .filter(row => sameConditions(row, fields))
        if (overlapping.length)
            denied(
                "EQUAL_RANK_OVERLAP",
                "Policy " +
                    (overlapping[0].policyName || overlapping[0].serviceLevelPolicyId) +
                    " has the same conditions over these dates; change or end it first"
            )
    }
    let serviceLevelPolicyId
    if (editDraft) {
        serviceLevelPolicyId = existing.serviceLevelPolicyId
        call("update#" + POLICY, Object.assign({serviceLevelPolicyId, fromDate: stamp(fromMs)}, fields))
        for (const row of rows(TARGET, {serviceLevelPolicyId})) row.delete()
    } else
        serviceLevelPolicyId = call(
            "create#" + POLICY,
            Object.assign({organizationPartyId, previousPolicyId: replaces, fromDate: stamp(fromMs), thruDate: null}, fields)
        ).serviceLevelPolicyId
    for (const target of targets)
        call("create#" + TARGET, {
            serviceLevelPolicyId,
            priorityBandEnumId: target.priorityBandEnumId,
            firstResponseMinutes: target.firstResponseMinutes,
            resolutionMinutes: target.resolutionMinutes,
            warningMinutes: target.warningMinutes,
            fromDate: stamp(fromMs)
        })
    if (!draft && replaces) {
        const replaced = one(POLICY, {serviceLevelPolicyId: replaces})
        if (replaced?.fromDate && (!replaced.thruDate || msOf(replaced.thruDate) > fromMs)) endPolicy(replaced, fromMs)
    }
    return {serviceLevelPolicyId}
}
// simulate#Policy: the due times of a case received at a time with a priority on a policy (given, or the one a case of the
// given organization, queue, type and customer would get), with the pauses given (resolution only), the calendar's hours and
// holidays over the span, and the warnings.
function simulate(p) {
    requirePermission("SUPPORT_POLICY_EDIT", "SUPPORT_CASE_MANAGE", "SUPPORT_CASE_EDIT")
    const receivedMs = msOf(p.receivedDate) ?? nowMs()
    let policy = p.serviceLevelPolicyId ? one(POLICY, {serviceLevelPolicyId: p.serviceLevelPolicyId}) : null
    const organizationPartyId = requireOrganization(policy?.organizationPartyId || p.organizationPartyId)
    if (p.serviceLevelPolicyId && !policy) denied("RECORD_UNAVAILABLE", "Policy " + p.serviceLevelPolicyId + " is not available")
    if (!policy)
        policy = selectPolicy(
            {
                organizationPartyId,
                customerPartyId: p.customerPartyId,
                requestCategoryId: p.requestCategoryId,
                requestTypeEnumId: p.requestTypeEnumId
            },
            stamp(receivedMs)
        )
    if (!policy)
        return {
            configured: false,
            policyName: "",
            clocks: [],
            holidays: [],
            hoursText: "",
            explanation: "No policy applies to such a case"
        }
    const band = p.priorityBandEnumId || bandOf(p.priority)
    const target = targetOf(policy.serviceLevelPolicyId, band)
    // the queue whose team's hours count: the one given, the policy's, else the organization's default queue
    const queueId =
        p.requestCategoryId ||
        policy.requestCategoryId ||
        currentRows("mantle.request.support.ServicePolicy", {organizationPartyId}, stamp(receivedMs))[0]?.defaultCategoryId ||
        null
    const schedule = scheduleFor(policy, queueId, organizationPartyId, stamp(receivedMs))
    const zone = schedule.timeZone
    const ctx = time.forCall()
    const pauses = Array.from(p.pauses || [])
        .map(row => [msOf(row.fromDate), msOf(row.thruDate)])
        .filter(([from, thru]) => from != null && thru != null && thru > from)
        .sort((a, b) => a[0] - b[0])
    const clocks = []
    let lastMs = receivedMs
    for (const [clockEnumId, minutes] of [
        [FIRST, target?.firstResponseMinutes],
        [RESOLUTION, target?.resolutionMinutes]
    ]) {
        if (minutes == null) continue
        let {dueMs, warningMs} = deadlines(ctx, schedule, receivedMs, minutes, target.warningMinutes)
        let pausedMinutes = 0
        if (clockEnumId === RESOLUTION)
            for (const [from, thru] of pauses) {
                if (dueMs == null || from >= dueMs || thru <= receivedMs) continue
                const start = Math.max(from, receivedMs)
                const left = time.elapsedMinutes(ctx, schedule, start, dueMs)
                pausedMinutes += time.elapsedMinutes(ctx, schedule, start, thru)
                dueMs = time.dueAfter(ctx, schedule, thru, left)
                if (Number(target.warningMinutes) > 0)
                    warningMs =
                        left > Number(target.warningMinutes)
                            ? time.dueAfter(ctx, schedule, thru, left - Number(target.warningMinutes))
                            : thru
            }
        lastMs = Math.max(lastMs, dueMs ?? receivedMs)
        clocks.push({
            clockEnumId,
            label: enumText(clockEnumId),
            targetText: durationText(minutes) + " business time",
            dueText: textAt(dueMs, zone),
            dueDate: stamp(dueMs),
            warningText: textAt(warningMs, zone),
            pausedText: pausedMinutes ? durationText(pausedMinutes) : ""
        })
    }
    const span = time.calendarOf(ctx, schedule, receivedMs, lastMs + time.dayMs)
    const holidays = span.holidays
        .filter(row => row.thruMs > receivedMs && row.fromMs < lastMs + time.dayMs)
        .map(row => ({name: row.name, fromText: textAt(row.fromMs, zone), thruText: textAt(row.thruMs, zone)}))
    const hours = schedule.calendarId ? time.workingHours({calendarId: schedule.calendarId}) : null
    return {
        configured: true,
        serviceLevelPolicyId: policy.serviceLevelPolicyId,
        policyName: policy.policyName || policy.serviceLevelPolicyId,
        bandText: enumText(band),
        receivedText: textAt(receivedMs, zone),
        timeZone: zone || "",
        calendarText: schedule.calendarId
            ? one("mantle.work.calendar.Calendar", {calendarId: schedule.calendarId})?.calendarName || schedule.calendarId
            : "Around the clock",
        hoursText: hours?.configured ? hours.text : "Around the clock",
        clocks,
        holidays,
        explanation: target ? "" : "The policy has no target for the " + enumText(band) + " band"
    }
}

// ===== scan#CaseSla =====
// One episode of the scan, in its transaction: its warning or breach, once each, told to the case's assignee (else the
// managers of the queue's team), and a pause past the policy's longest.
function mark(p) {
    const episode = find(EPISODE, {caseSlaEpisodeId: p.caseSlaEpisodeId}).forUpdate(true).one()
    if (!episode || !openStates.includes(episode.stateEnumId)) return {}
    const request = one(REQUEST, {requestId: episode.requestId})
    if (!request || !one(PROFILE, {requestId: episode.requestId}))
        throw new Error("its case " + episode.requestId + " is not a support case")
    const now = nowMs()
    const told = []
    const due = msOf(episode.dueDate)
    const zone = episode.timeZone || null
    if (episode.stateEnumId === RUNNING && due != null && due <= now && !episode.breachedDate) {
        episode.set("breachedDate", stamp(due))
        episode.update()
        if (
            addEvent({
                requestId: episode.requestId,
                caseSlaEpisodeId: episode.caseSlaEpisodeId,
                eventTypeEnumId: "SetBreach",
                eventKey: "breach:" + episode.caseSlaEpisodeId,
                eventDate: stamp(due),
                dueDate: episode.dueDate
            })
        )
            told.push(notify("SupportCaseSlaBreach", episode, request, textAt(due, zone)))
    } else if (
        episode.stateEnumId === RUNNING &&
        episode.warningDate &&
        msOf(episode.warningDate) <= now &&
        !episode.warnedDate
    ) {
        episode.set("warnedDate", stamp(now))
        episode.update()
        if (
            addEvent({
                requestId: episode.requestId,
                caseSlaEpisodeId: episode.caseSlaEpisodeId,
                eventTypeEnumId: "SetWarning",
                eventKey: "warn:" + episode.caseSlaEpisodeId,
                dueDate: episode.dueDate
            })
        )
            told.push(notify("SupportCaseSlaWarning", episode, request, textAt(due, zone)))
    } else if (episode.stateEnumId === PAUSED && episode.pausedDate) {
        const policy = one(POLICY, {serviceLevelPolicyId: episode.serviceLevelPolicyId})
        if (
            policy?.maxPauseMinutes &&
            time.elapsedMinutes(time.forCall(), scheduleOfEpisode(episode), msOf(episode.pausedDate), now) >=
                Number(policy.maxPauseMinutes)
        )
            addEvent({
                requestId: episode.requestId,
                caseSlaEpisodeId: episode.caseSlaEpisodeId,
                eventTypeEnumId: "SetPauseLimit",
                eventKey: "pauselimit:" + episode.caseSlaEpisodeId + ":" + msOf(episode.pausedDate)
            })
    }
    return {notified: told.flat().length}
}
function notify(topic, episode, request, dueText) {
    try {
        let partyIds = currentRows(PARTY, {requestId: episode.requestId, roleTypeId: "Assignee"}).map(row => row.partyId)
        if (!partyIds.length && request.requestCategoryId) {
            const team = currentRows(QUEUE, {requestCategoryId: request.requestCategoryId})[0]?.responsibleTeamPartyId
            partyIds = team
                ? currentRows("mantle.party.PartyRelationship", {
                      toPartyId: team,
                      relationshipTypeEnumId: "PrtServiceTeam",
                      fromRoleTypeId: "Manager"
                  }).map(row => row.fromPartyId)
                : []
        }
        const userIds = partyIds.length
            ? Array.from(find("moqui.security.UserAccount").condition("partyId", "in", partyIds).list()).map(row => row.userId)
            : []
        if (!userIds.length) return []
        const nm = ec
            .makeNotificationMessage()
            .topic(topic)
            .userIds(userIds)
            .message({
                requestId: episode.requestId,
                requestName: request.requestName || episode.requestId,
                customerName: partyName(roleParty(episode.requestId, "Customer")),
                clockLabel: enumText(episode.clockEnumId),
                dueText,
                recordEntityName: REQUEST,
                recordId: episode.requestId
            })
        if (typeof nm.record === "function") nm.record(REQUEST, episode.requestId)
        nm.send()
        return userIds
    } catch (error) {
        ec.logger.error("Case " + episode.requestId + ": the " + topic + " notice was not sent: " + error.message)
        return []
    }
}
// The scan: the open episodes due, warned of or paused, a bounded batch oldest first; each in its own transaction, a failing
// one logged with its case and named, the rest going on.
function scan(p) {
    const limit = Math.max(1, Math.min(2000, Number(p.limit) || 200))
    const now = ec.user.nowTimestamp
    const cf = factory()
    const due = cf.makeCondition(
        [
            cf.makeCondition("stateEnumId", "equals", RUNNING),
            cf.makeCondition("breachedDate", "is-null", null),
            cf.makeCondition("dueDate", "less-equals", now)
        ],
        "and"
    )
    const warn = cf.makeCondition(
        [
            cf.makeCondition("stateEnumId", "equals", RUNNING),
            cf.makeCondition("warnedDate", "is-null", null),
            cf.makeCondition("warningDate", "less-equals", now)
        ],
        "and"
    )
    const paused = cf.makeCondition("stateEnumId", "equals", PAUSED)
    const list = Array.from(
        find(EPISODE)
            .condition(cf.makeCondition([due, warn, paused], "or"))
            .orderBy("dueDate")
            .limit(limit)
            .list()
    )
    const failed = []
    let marked = 0
    for (const episode of list) {
        ec.message.pushErrors()
        try {
            ec.service
                .sync()
                .name("mantle.request.SlaServices.mark#CaseSlaEpisode")
                .parameters({caseSlaEpisodeId: episode.caseSlaEpisodeId})
                .requireNewTransaction(true)
                .disableAuthz()
                .call()
            if (ec.message.hasError()) throw new Error(ec.message.getErrorsString())
            marked++
        } catch (error) {
            const message = error && error.message ? error.message : String(error)
            ec.logger.error("Case " + episode.requestId + " clock " + episode.caseSlaEpisodeId + " was not scanned: " + message)
            failed.push({requestId: episode.requestId, caseSlaEpisodeId: episode.caseSlaEpisodeId, message})
        } finally {
            ec.message.clearErrors()
            ec.message.popErrors()
        }
    }
    return {scannedCount: list.length, markedCount: marked, failedList: failed}
}

// ===== reads for the case lists =====
// The cases at risk (a running clock warned, due or breached) among requestIds, or of the whole table when none are given.
function riskRequestIds(limit = 2000) {
    const cf = factory()
    const now = ec.user.nowTimestamp
    return Array.from(
        find(EPISODE)
            .condition("stateEnumId", "equals", RUNNING)
            .condition(
                cf.makeCondition(
                    [
                        cf.makeCondition("warningDate", "less-equals", now),
                        cf.makeCondition("dueDate", "less-equals", now),
                        cf.makeCondition("breachedDate", "is-not-null", null)
                    ],
                    "or"
                )
            )
            .selectField("requestId")
            .distinct(true)
            .limit(limit)
            .list()
    ).map(row => row.requestId)
}
// The cases whose first response is still running.
function awaitingResponseIds(limit = 2000) {
    return Array.from(
        find(EPISODE, {clockEnumId: FIRST})
            .condition("stateEnumId", "in", openStates)
            .selectField("requestId")
            .distinct(true)
            .limit(limit)
            .list()
    ).map(row => row.requestId)
}

const operations = {
    startEpisode,
    recordStatus,
    recordMessage,
    recordWork,
    correct,
    history,
    findPolicies,
    savePolicy,
    simulate,
    mark,
    scan
}
;({
    attachReason,
    riskRequestIds,
    awaitingResponseIds,
    durationText,
    rankOf,
    // each operation checks its own permission and organization, and reads and writes with artifact authorization off
    execute: (op, parameters) => {
        if (!operations[op]) throw new Error("Unknown service level operation " + op)
        const wasDisabled = ec.artifactExecution.disableAuthz()
        try {
            return operations[op](parameters || {})
        } finally {
            if (!wasDisabled) ec.artifactExecution.enableAuthz()
        }
    }
})
