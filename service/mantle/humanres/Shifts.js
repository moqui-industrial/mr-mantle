// People's shift roster (mantle.humanres.ScheduleServices get#Roster, store#Shift, publish#Shifts, get#MyShifts, get#TeamShifts and
// get#ShiftProjection; IronStone People design §6 ShiftRoster, §13 TeamCalendar, PE-06, PE-20, PE-24; impl-people P14). Every
// service checks the caller's People scope first (People.js scopeOf) and reads and writes with authorization off after it.
//
// The record (PeopleScheduleEntities.xml ShiftAssignment): a dated shift of an employment, its start and end instants, the zone
// its day is attributed in (the employment's working schedule's at the start, else the rostering user's) and the day it counts
// on (shiftDate, the local day of its start there), its unpaid break and work location. A draft is the roster's until it is
// published; a published shift is the worker's: they are told (PeopleShiftChange), capacity reads it in place of the schedule's
// hours that day (Schedules.js scheduledDays, through shiftDays here), and the My shifts projected calendar and the team
// calendar show it. Removing a shift cancels it (never deleted); a published shift changed or removed is told to the worker.
//
// The rules (assess): a shift ends after it starts, lasts at most a day, starts after now, has a break shorter than itself, lies
// within its employment (EMPLOYMENT_ENDED, DATE_OUTSIDE), overlaps no other shift of the person in any employment (OVERLAP) and
// no approved leave of theirs (LEAVE_CONFLICT: a whole day, or the morning or afternoon half the shift touches). Leave still
// waiting and a holiday on the shift's day are warnings. A preview answers the refusals and warnings and writes nothing; apply
// and publish assess again under the person's lock (their Party row), so two rosterers cannot overlap one person.
//
// Who: a manager (PEOPLE_TEAM_VIEW) rosters their live reports at the employers of their lines, an HR editor (PEOPLE_HR_VIEW and
// PEOPLE_HR_EDIT) the employees of their employers; an HR reader reads their employers' roster. A worker reads their own
// published shifts (PEOPLE_SELF_SERVICE); the team calendar shows the published shifts of the people its absences show (the user's
// own, their colleagues', reports' and HR's employers'). Missing and unauthorized records are refused alike (RECORD_UNAVAILABLE).
const people = ec.resource.script("component://mr-mantle/service/mantle/humanres/People.js")
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const {find, one, denied, call} = lib
const schedules = () => ec.resource.script("component://mr-mantle/service/mantle/humanres/Schedules.js")
const leave = () => ec.resource.script("component://mr-mantle/service/mantle/humanres/Leave.js")

const SHIFT = "mantle.humanres.schedule.ShiftAssignment"
const SCHEDULE = "mantle.humanres.schedule.WorkingSchedule"
const ASSIGNMENT = "mantle.humanres.employment.EmploymentAssignment"
const RELATIONSHIP = "mantle.party.PartyRelationship"
const REQUEST = "mantle.humanres.leave.LeaveRequest"
const SEGMENT = "mantle.humanres.leave.LeaveRequestSegment"
const FACILITY = "mantle.facility.Facility"
const liveStates = ["ShsDraft", "ShsPublished"]
const statusTexts = {ShsDraft: "Draft", ShsPublished: "Published", ShsCancelled: "Removed"}
const approvedLeave = ["LrsApproved", "LrsCancelRequested"]
const minuteMs = 60 * 1000
const hourMs = 60 * minuteMs
const maxShiftMs = 24 * hourMs
// the roster's spans of days and its people
const rosterSpans = [7, 14, 28]
const laneCap = 200
const facilityCap = 100
// the worker's own shifts, the projection's window and the team calendar's
const myDaysDefault = 14
const myDaysMax = 62
const listCap = 2000

const ms = lib.ms
const nowMs = () => ms(ec.user.nowTimestamp)
const text = value => String(value ?? "").trim()
const truthy = value => value === true || value === "true" || value === "Y"
const stamp = millis => (millis == null ? null : new Date(Number(millis)))
const unique = people.unique
const round = value => Math.round(value * 100) / 100
const stampOf = row => ms(row?.lastUpdatedStamp) ?? 0
const revisionOf = row => String(stampOf(row))

// ===== days and times =====
const validZone = zone => schedules().validZone(zone)
const userZone = () => (validZone(text(ec.user.timeZone)) ? text(ec.user.timeZone) : null)
const dayIn = (millis, zone) => ec.l10n.format(new Date(Number(millis)), "yyyy-MM-dd", null, zone || null)
const timeIn = (millis, zone) => ec.l10n.format(new Date(Number(millis)), "HH:mm", null, zone || null)
const dayTimeIn = (millis, zone) => ec.l10n.format(new Date(Number(millis)), "yyyy-MM-dd HH:mm", null, zone || null)
const instantIn = (day, time, zone) =>
    ms(ec.l10n.parseTimestamp(String(day).slice(0, 10) + " " + time + ":00.000", "yyyy-MM-dd HH:mm:ss.SSS", null, zone || null))
function addDay(day, count = 1) {
    const [y, m, d] = String(day).slice(0, 10).split("-").map(Number)
    const date = new Date(Date.UTC(y, m - 1, d + count))
    return [
        date.getUTCFullYear(),
        String(date.getUTCMonth() + 1).padStart(2, "0"),
        String(date.getUTCDate()).padStart(2, "0")
    ].join("-")
}
const isoDayOf = day => {
    const js = new Date(String(day).slice(0, 10) + "T12:00:00Z").getUTCDay()
    return js === 0 ? 7 : js
}
const weekdayTexts = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
const dayLabel = day => weekdayTexts[isoDayOf(day)] + " " + day
function daysFrom(fromDay, count) {
    const out = []
    for (let i = 0; i < count; i++) out.push(addDay(fromDay, i))
    return out
}
// a day given as yyyy-MM-dd text, a date or a timestamp, as yyyy-MM-dd in the user's zone
function dayParam(value) {
    if (value == null || value === "") return null
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(value))) return String(value)
    return dayIn(ec.user.timestampMillis(value), null)
}
// a local wall time "yyyy-MM-dd HH:mm" (or with a T, or seconds) in a zone, as an instant; null when it does not read
function wallParam(value, zone) {
    const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{1,2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/.exec(text(value))
    if (!match || Number(match[2]) > 23 || Number(match[3]) > 59) return null
    return instantIn(match[1], String(match[2]).padStart(2, "0") + ":" + match[3], zone)
}
const hoursText = hours => String(round(hours)) + " h"
const lengthHours = (startMs, endMs, breakMinutes) => Math.max(0, endMs - startMs - Number(breakMinutes || 0) * minuteMs) / hourMs
// "Mon 2027-03-01 08:00–16:00" in a zone, the end's day said when it is another
function whenText(startMs, endMs, zone) {
    const startDay = dayIn(startMs, zone)
    const endDay = dayIn(endMs, zone)
    return (
        dayLabel(startDay) +
        " " +
        timeIn(startMs, zone) +
        "–" +
        (endDay === startDay ? "" : dayLabel(endDay) + " ") +
        timeIn(endMs, zone)
    )
}

// ===== scope =====
const employmentRow = partyRelationshipId =>
    partyRelationshipId ? one(RELATIONSHIP, {partyRelationshipId, relationshipTypeEnumId: "PrtEmployee"}) : null
const hrEmployers = userScope => (userScope.capabilities.hrView ? userScope.organizationPartyIds : [])
const canEditAt = (userScope, organizationPartyId) =>
    !!(
        userScope.capabilities.hrView &&
        userScope.capabilities.hrEdit &&
        userScope.organizationPartyIds.includes(organizationPartyId)
    )
// How the scope admits an employment: self (the person's own), team (a live report at the line's employer), hr (an HR reader of
// the employer), hrEdit (an HR editor of it).
function accessKinds(userScope, employment) {
    const caps = userScope.capabilities
    const kinds = []
    if (!employment) return kinds
    const partyId = employment.fromPartyId
    const organizationPartyId = employment.toPartyId
    if (caps.self && partyId === userScope.partyId) kinds.push("self")
    if (caps.team && ((userScope.reportLines || {})[partyId] || []).includes(organizationPartyId)) kinds.push("team")
    if (hrEmployers(userScope).includes(organizationPartyId)) kinds.push("hr")
    if (canEditAt(userScope, organizationPartyId)) kinds.push("hrEdit")
    return kinds
}
// who rosters an employment: the person's manager at the line's employer, an HR editor of the employer; who reads its roster: those
// and an HR reader of the employer
const rosterKinds = ["team", "hrEdit"]
const readKinds = ["team", "hr", "hrEdit"]
const rosters = kinds => kinds.some(kind => rosterKinds.includes(kind))
function rosterScope(what) {
    const userScope = people.scopeOf()
    const caps = userScope.capabilities
    if (!caps.team && !caps.hrView) denied("PERMISSION_DENIED", what + " needs PEOPLE_TEAM_VIEW or PEOPLE_HR_VIEW")
    return userScope
}
// A rostered employment the caller may change, else refused as missing.
function rosterEmployment(userScope, partyRelationshipId) {
    const employment = employmentRow(text(partyRelationshipId))
    if (!employment || !rosters(accessKinds(userScope, employment)))
        denied("RECORD_UNAVAILABLE", "Employment " + text(partyRelationshipId) + " is not available to roster")
    return employment
}
// lock a person's shifts: every write of a person's shift takes their Party row first, so two writes of one person serialize
const lockPerson = partyId => find("mantle.party.Party", {partyId}).forUpdate(true).one()

// ===== the employment's zone, place and schedule =====
function primaryAssignment(partyRelationshipId, atMs) {
    return (
        Array.from(
            people
                .current(find(ASSIGNMENT).condition({partyRelationshipId, isPrimary: "Y"}), atMs)
                .orderBy("-fromDate")
                .limit(1)
                .list()
        )[0] || null
    )
}
// The zone of an employment's shifts at an instant: its working schedule's, else the user's.
function zoneOf(partyRelationshipId, atMs) {
    const assignment = primaryAssignment(partyRelationshipId, atMs)
    if (assignment?.workingScheduleId) {
        const schedule = one(SCHEDULE, {workingScheduleId: assignment.workingScheduleId})
        if (validZone(schedule?.timeZone)) return schedule.timeZone
    }
    return userZone()
}
function facilityNames(facilityIds) {
    const ids = unique((facilityIds || []).filter(Boolean))
    if (!ids.length) return {}
    return Object.fromEntries(
        Array.from(find(FACILITY).condition("facilityId", "in", ids).list()).map(row => [
            row.facilityId,
            row.facilityName || row.facilityId
        ])
    )
}

// ===== conflicts =====
// The other live shifts of a person overlapping an interval.
function overlappingShifts(partyId, startMs, endMs, exceptId) {
    return Array.from(
        find(SHIFT)
            .condition("partyId", partyId)
            .condition("statusEnumId", "in", liveStates)
            .condition("startDate", "less", stamp(endMs))
            .condition("endDate", "greater", stamp(startMs))
            .list()
    ).filter(row => row.shiftAssignmentId !== exceptId)
}
// The halves of days (yyyy-MM-dd plus AM or PM) an interval touches, in a zone.
function slotsOf(startMs, endMs, zone) {
    const out = []
    for (let day = dayIn(startMs, zone), guard = 0; guard < 3; day = addDay(day), guard++) {
        const dayStart = instantIn(day, "00:00", zone)
        if (dayStart >= endMs) break
        const noon = instantIn(day, "12:00", zone)
        const dayEnd = instantIn(addDay(day), "00:00", zone)
        if (startMs < noon && endMs > dayStart) out.push(day + "AM")
        if (endMs > noon && startMs < dayEnd) out.push(day + "PM")
    }
    return out
}
const segmentSlots = segment =>
    segment.dayPartEnumId === "LdpMorning" ? ["AM"] : segment.dayPartEnumId === "LdpAfternoon" ? ["PM"] : ["AM", "PM"]
// The leave of a person (requests in the states given) touching the slots: [{leaveRequestId, statusEnumId}].
function leaveOn(partyId, slots, states) {
    if (!slots.length) return []
    const days = unique(slots.map(slot => slot.slice(0, 10))).sort()
    const requests = Array.from(
        find(REQUEST)
            .condition("partyId", partyId)
            .condition("statusEnumId", "in", states)
            .condition("fromDay", "less-equals", days[days.length - 1])
            .condition("thruDay", "greater-equals", days[0])
            .list()
    )
    const wanted = new Set(slots)
    return requests.filter(request =>
        Array.from(find(SEGMENT).condition("leaveRequestId", request.leaveRequestId).list()).some(segment => {
            const from = lib.calendarDateText(segment.fromDay)
            const thru = lib.calendarDateText(segment.thruDay)
            return days.some(day => day >= from && day <= thru && segmentSlots(segment).some(half => wanted.has(day + half)))
        })
    )
}
// The holiday on a day of an employment: its schedule's (or assignment's) calendar's, else its employer's own WepHoliday.
function holidayOn(employment, day, zone) {
    const assignment = primaryAssignment(employment.partyRelationshipId, instantIn(day, "12:00", zone))
    const schedule = assignment?.workingScheduleId ? one(SCHEDULE, {workingScheduleId: assignment.workingScheduleId}) : null
    const calendarId = assignment?.holidayCategoryId || schedule?.holidayCategoryId || null
    if (calendarId) {
        const name = schedules().holidaysOf([calendarId], [day])[calendarId]?.[day]
        if (name) return name
    }
    const own = Array.from(
        find("mantle.work.effort.WorkEffort")
            .condition({purposeEnumId: "WepHoliday", ownerPartyId: employment.toPartyId, allDayStart: day})
            .limit(1)
            .list()
    )[0]
    return own ? own.workEffortName || "Holiday" : null
}

// ===== the rules =====
// A shift as asked (p) of an employment, assessed: its instants, zone and day, break and place, and its refusals and warnings
// ({code, message}). Nothing is written.
function assess(userScope, p, existing) {
    const refusals = []
    const warnings = []
    const refuse = (code, message) => refusals.push({code, message})
    const employment = rosterEmployment(userScope, text(p.partyRelationshipId) || existing?.partyRelationshipId)
    const entryZone = validZone(text(p.timeZone)) ? text(p.timeZone) : userZone()
    const startMs = p.startText != null && p.startText !== "" ? wallParam(p.startText, entryZone) : ms(existing?.startDate)
    const endMs = p.endText != null && p.endText !== "" ? wallParam(p.endText, entryZone) : ms(existing?.endDate)
    const breakMinutes =
        p.breakMinutes != null && p.breakMinutes !== "" ? Number(p.breakMinutes) : Number(existing?.breakMinutes || 0)
    const facilityId =
        p.facilityId !== undefined && p.facilityId !== null
            ? text(p.facilityId) || null
            : existing
              ? existing.facilityId || null
              : null
    const comments = p.reason != null && p.reason !== "" ? text(p.reason) : existing?.comments || null
    const out = {employment, startMs, endMs, breakMinutes, facilityId, comments, refusals, warnings}
    if (startMs == null || endMs == null || Number.isNaN(startMs) || Number.isNaN(endMs)) {
        refuse("TIME_INVALID", "Give the start and the end as a day and a time")
        return out
    }
    const zone = zoneOf(employment.partyRelationshipId, startMs)
    Object.assign(out, {zone, shiftDate: dayIn(startMs, zone), hours: round(lengthHours(startMs, endMs, breakMinutes))})
    if (endMs <= startMs) refuse("TIME_INVALID", "A shift ends after it starts")
    else if (endMs - startMs > maxShiftMs) refuse("TOO_LONG", "A shift lasts at most a day")
    if (startMs < nowMs()) refuse("DATE_PAST", "A shift starts after now")
    if (!Number.isInteger(breakMinutes) || breakMinutes < 0 || (endMs > startMs && breakMinutes * minuteMs >= endMs - startMs))
        refuse("BREAK_INVALID", "The break is shorter than the shift")
    if ((ms(employment.fromDate) ?? -Infinity) > startMs) refuse("DATE_OUTSIDE", "The shift starts before the employment does")
    if ((ms(employment.thruDate) ?? Infinity) < endMs) refuse("EMPLOYMENT_ENDED", "The employment ends before the shift does")
    if (endMs > startMs) {
        const other = overlappingShifts(employment.fromPartyId, startMs, endMs, existing?.shiftAssignmentId)[0]
        if (other)
            refuse(
                "OVERLAP",
                "It overlaps the shift " + whenText(ms(other.startDate), ms(other.endDate), zone) + " of the same person"
            )
        const slots = slotsOf(startMs, endMs, zone)
        if (leaveOn(employment.fromPartyId, slots, approvedLeave).length)
            refuse("LEAVE_CONFLICT", "The person is on approved leave then")
        else if (leaveOn(employment.fromPartyId, slots, ["LrsRequested"]).length)
            warnings.push({code: "LEAVE_REQUESTED", message: "The person has asked for leave then; it waits for approval"})
        const holiday = holidayOn(employment, out.shiftDate, zone)
        if (holiday)
            warnings.push({code: "HOLIDAY", message: "It is on a holiday (" + holiday + "); the shift is worked as rostered"})
    }
    return out
}
// A shift's row as the roster, the preview and the worker read it (texts in the user's zone, the shift's own local times beside
// them when its zone is another).
function shiftRow(row, names, canRoster) {
    const startMs = ms(row.startDate)
    const endMs = ms(row.endDate)
    const zone = row.timeZone || null
    const viewer = userZone()
    const hours = round(lengthHours(startMs, endMs, row.breakMinutes))
    return {
        shiftAssignmentId: row.shiftAssignmentId,
        partyRelationshipId: row.partyRelationshipId,
        partyId: row.partyId,
        personName: names.persons?.[row.partyId] || row.partyId,
        organizationPartyId: row.organizationPartyId,
        organizationName: names.organizations?.[row.organizationPartyId] || row.organizationPartyId,
        statusEnumId: row.statusEnumId,
        statusText: statusTexts[row.statusEnumId] || row.statusEnumId,
        shiftDate: lib.calendarDateText(row.shiftDate),
        startText: dayTimeIn(startMs, null),
        endText: dayTimeIn(endMs, null),
        whenText: whenText(startMs, endMs, null),
        localText: zone && zone !== viewer ? whenText(startMs, endMs, zone) + " (" + zone + ")" : "",
        timeZone: zone,
        breakMinutes: Number(row.breakMinutes || 0),
        hours,
        hoursText: hoursText(hours),
        facilityId: row.facilityId || null,
        facilityName: row.facilityId ? names.facilities?.[row.facilityId] || row.facilityId : "",
        comments: row.comments || "",
        started: startMs <= nowMs(),
        canChange: !!canRoster && row.statusEnumId !== "ShsCancelled" && startMs > nowMs(),
        revision: revisionOf(row)
    }
}
function namesOf(rowList) {
    return {
        persons: people.personNames(unique(rowList.map(row => row.partyId))),
        organizations: people.organizationNames(unique(rowList.map(row => row.organizationPartyId))),
        facilities: facilityNames(rowList.map(row => row.facilityId))
    }
}

// ===== get#Roster =====
// The employments the caller reads the roster of, overlapping the days: a manager's live reports at their lines' employers, an
// HR reader's employers' employees; organizationPartyId (an employer of the caller's) narrows. Each with whether the caller rosters
// it, by person name.
function rosterEmployments(userScope, organizationPartyId, fromMs, thruMs) {
    const factory = ec.entity.conditionFactory
    const reach = []
    for (const [partyId, organizationPartyIds] of Object.entries(userScope.reportLines || {})) {
        const at = organizationPartyId ? organizationPartyIds.filter(id => id === organizationPartyId) : organizationPartyIds
        if (at.length)
            reach.push(
                factory.makeCondition(
                    factory.makeCondition("fromPartyId", "equals", partyId),
                    "and",
                    factory.makeCondition("toPartyId", "in", at)
                )
            )
    }
    const employers = hrEmployers(userScope).filter(id => !organizationPartyId || id === organizationPartyId)
    if (employers.length) reach.push(factory.makeCondition("toPartyId", "in", employers))
    if (!reach.length) return []
    const found = Array.from(
        find(RELATIONSHIP)
            .condition("relationshipTypeEnumId", "PrtEmployee")
            .condition(reach.length === 1 ? reach[0] : factory.makeCondition(reach, "or"))
            .condition(
                factory.makeCondition(
                    factory.makeCondition("fromDate", "is-null", null),
                    "or",
                    factory.makeCondition("fromDate", "less", stamp(thruMs))
                )
            )
            .condition(
                factory.makeCondition(
                    factory.makeCondition("thruDate", "is-null", null),
                    "or",
                    factory.makeCondition("thruDate", "greater", stamp(fromMs))
                )
            )
            .limit(laneCap * 3)
            .list()
    )
    const names = people.personNames(unique(found.map(row => row.fromPartyId)))
    return found
        .map(row => ({row, kinds: accessKinds(userScope, row), personName: names[row.fromPartyId] || row.fromPartyId}))
        .filter(entry => entry.kinds.some(kind => readKinds.includes(kind)))
        .sort((a, b) => a.personName.localeCompare(b.personName) || a.row.toPartyId.localeCompare(b.row.toPartyId))
}
// The approved leave of people on days, as halves of days: {partyId: [{day, part}]}.
function leaveDays(partyIds, fromDay, thruDay) {
    const out = {}
    if (!partyIds.length) return out
    const requests = Array.from(
        find(REQUEST)
            .condition("partyId", "in", partyIds)
            .condition("statusEnumId", "in", approvedLeave)
            .condition("fromDay", "less-equals", thruDay)
            .condition("thruDay", "greater-equals", fromDay)
            .list()
    )
    for (const request of requests)
        for (const segment of Array.from(find(SEGMENT).condition("leaveRequestId", request.leaveRequestId).list())) {
            const from = lib.calendarDateText(segment.fromDay)
            const thru = lib.calendarDateText(segment.thruDay)
            for (let day = from < fromDay ? fromDay : from; day <= thru && day <= thruDay; day = addDay(day))
                (out[request.partyId] || (out[request.partyId] = [])).push({day, part: segment.dayPartEnumId})
        }
    return out
}
// get#Roster: the people the caller rosters or reads from fromDay for days (7, 14 or 28), each employment a lane with its
// working schedule's hours, holidays and approved leave, and the shifts of those days.
function getRoster(p) {
    const userScope = rosterScope("The shift roster")
    const organizationPartyId = text(p.organizationPartyId) || null
    if (organizationPartyId) {
        const lineEmployers = unique(Object.values(userScope.reportLines || {}).flat())
        if (!hrEmployers(userScope).includes(organizationPartyId) && !lineEmployers.includes(organizationPartyId))
            denied("ORGANIZATION_DENIED", "Organization " + organizationPartyId + " is not available")
    }
    const days = rosterSpans.includes(Number(p.days)) ? Number(p.days) : 7
    const today = dayIn(nowMs(), null)
    // the Monday of this week when no day is given
    const fromDay = dayParam(p.fromDay) || addDay(today, 1 - isoDayOf(today))
    const thruDay = addDay(fromDay, days - 1)
    const fromMs = instantIn(fromDay, "00:00", null)
    const thruMs = instantIn(addDay(thruDay), "00:00", null)
    const dayList = daysFrom(fromDay, days)
    const allEmployments = rosterEmployments(userScope, organizationPartyId, fromMs, thruMs)
    const truncated = allEmployments.length > laneCap
    const employments = allEmployments.slice(0, laneCap)
    const partyIds = unique(employments.map(entry => entry.row.fromPartyId))
    // the schedules' working intervals (the days around the range too, for a night shift), holidays and leave
    let planned = {}
    try {
        planned = schedules().plannedIntervals(partyIds, daysFrom(addDay(fromDay, -1), days + 2))
    } catch (error) {
        ec.logger.error("Shift roster: the working schedules were not read, none drawn: " + error.message)
    }
    const leaveOf = leaveDays(partyIds, fromDay, thruDay)
    const shiftRows = partyIds.length
        ? Array.from(
              find(SHIFT)
                  .condition(
                      "partyRelationshipId",
                      "in",
                      employments.map(entry => entry.row.partyRelationshipId)
                  )
                  .condition("statusEnumId", "in", liveStates)
                  .condition("startDate", "less", stamp(thruMs))
                  .condition("endDate", "greater", stamp(fromMs))
                  .orderBy("startDate")
                  .limit(listCap)
                  .list()
          )
        : []
    const names = namesOf(shiftRows)
    const assignments = {}
    for (const entry of employments)
        assignments[entry.row.partyRelationshipId] = primaryAssignment(entry.row.partyRelationshipId, Math.max(fromMs, nowMs()))
    const organizations = people.organizationNames(unique(employments.map(entry => entry.row.toPartyId)))
    const scheduleNames = schedules().scheduleNames(
        Object.values(assignments)
            .map(row => row?.workingScheduleId)
            .filter(Boolean)
    )
    const employers = unique(employments.map(entry => entry.row.toPartyId))
    const lanes = employments.map(entry => {
        const employment = entry.row
        const assignment = assignments[employment.partyRelationshipId]
        const zone = zoneOf(employment.partyRelationshipId, Math.max(fromMs, nowMs()))
        const own = planned[employment.fromPartyId]
        const plannedList = (own?.intervals || [])
            .filter(interval => interval.endMs > fromMs && interval.startMs < thruMs)
            .map(interval => ({fromText: dayTimeIn(interval.startMs, null), thruText: dayTimeIn(interval.endMs, null)}))
        const holidayList = []
        for (const day of dayList) {
            const name = holidayOn(employment, day, zone)
            if (name)
                holidayList.push({
                    day,
                    name,
                    fromText: dayTimeIn(instantIn(day, "00:00", zone), null),
                    thruText: dayTimeIn(instantIn(addDay(day), "00:00", zone), null)
                })
        }
        const leaveList = (leaveOf[employment.fromPartyId] || []).map(({day, part}) => ({
            day,
            partText: part === "LdpMorning" ? "Morning" : part === "LdpAfternoon" ? "Afternoon" : "Whole day",
            fromText: dayTimeIn(instantIn(day, part === "LdpAfternoon" ? "12:00" : "00:00", zone), null),
            thruText: dayTimeIn(
                part === "LdpMorning" ? instantIn(day, "12:00", zone) : instantIn(addDay(day), "00:00", zone),
                null
            )
        }))
        const ownShifts = shiftRows.filter(row => row.partyRelationshipId === employment.partyRelationshipId)
        return {
            partyRelationshipId: employment.partyRelationshipId,
            partyId: employment.fromPartyId,
            personName: entry.personName,
            organizationPartyId: employment.toPartyId,
            organizationName: organizations[employment.toPartyId] || employment.toPartyId,
            canRoster: rosters(entry.kinds),
            timeZone: zone || "",
            scheduleName: assignment?.workingScheduleId ? scheduleNames[assignment.workingScheduleId] || "" : "",
            facilityId: assignment?.facilityId || null,
            fromText: lib.dateText(employment.fromDate),
            thruText: lib.dateText(employment.thruDate),
            hours: round(
                ownShifts.reduce((sum, row) => sum + lengthHours(ms(row.startDate), ms(row.endDate), row.breakMinutes), 0)
            ),
            plannedList,
            holidayList,
            leaveList
        }
    })
    const laneOf = Object.fromEntries(lanes.map(lane => [lane.partyRelationshipId, lane]))
    const shifts = shiftRows.map(row => {
        const lane = laneOf[row.partyRelationshipId]
        const out = shiftRow(row, names, lane?.canRoster)
        // a draft's conflicts now (leave approved since it was set), and a holiday on its day
        const conflicts = []
        if (row.statusEnumId !== "ShsCancelled") {
            const slots = slotsOf(ms(row.startDate), ms(row.endDate), row.timeZone || null)
            if (leaveOn(row.partyId, slots, approvedLeave).length)
                conflicts.push({code: "LEAVE_CONFLICT", message: "The person is on approved leave then"})
            const holiday = lane?.holidayList.find(item => item.day === out.shiftDate)
            if (holiday) conflicts.push({code: "HOLIDAY", message: "On a holiday (" + holiday.name + ")"})
        }
        return Object.assign(out, {conflicts})
    })
    const draftCount = shifts.filter(row => row.statusEnumId === "ShsDraft" && laneOf[row.partyRelationshipId]?.canRoster).length
    // the work locations to choose: the lanes' and the employers' own facilities
    const facilityIds = unique(lanes.map(lane => lane.facilityId).filter(Boolean))
    const facilityOptions = employers.length
        ? Array.from(
              find(FACILITY)
                  .condition(
                      ec.entity.conditionFactory.makeCondition(
                          ec.entity.conditionFactory.makeCondition("ownerPartyId", "in", employers),
                          "or",
                          ec.entity.conditionFactory.makeCondition(
                              "facilityId",
                              "in",
                              facilityIds.length ? facilityIds : ["_NA_"]
                          )
                      )
                  )
                  .orderBy("facilityName")
                  .limit(facilityCap)
                  .list()
          ).map(row => ({value: row.facilityId, label: row.facilityName || row.facilityId}))
        : []
    const lineEmployers = unique(Object.values(userScope.reportLines || {}).flat())
    const organizationOptions = unique(hrEmployers(userScope).concat(lineEmployers))
    const organizationLabels = people.organizationNames(organizationOptions)
    return {
        fromDay,
        thruDay,
        days,
        todayText: today,
        nowText: dayTimeIn(nowMs(), null),
        fromText: dayTimeIn(fromMs, null),
        thruText: dayTimeIn(thruMs, null),
        timeZone: userZone() || "",
        organizationPartyId,
        organizationOptions: organizationOptions
            .map(id => ({value: id, label: organizationLabels[id] || id}))
            .sort((a, b) => a.label.localeCompare(b.label)),
        lanes,
        shifts,
        draftCount,
        canRoster: lanes.some(lane => lane.canRoster),
        truncated,
        facilityOptions
    }
}

// ===== store#Shift =====
const assessmentAnswer = (found, personName) => ({
    partyRelationshipId: found.employment.partyRelationshipId,
    personName,
    startText: found.startMs != null ? dayTimeIn(found.startMs, null) : "",
    endText: found.endMs != null ? dayTimeIn(found.endMs, null) : "",
    whenText: found.startMs != null && found.endMs != null ? whenText(found.startMs, found.endMs, null) : "",
    localText:
        found.zone && found.zone !== userZone() && found.startMs != null
            ? whenText(found.startMs, found.endMs, found.zone) + " (" + found.zone + ")"
            : "",
    shiftDate: found.shiftDate || "",
    hours: found.hours ?? 0,
    breakMinutes: found.breakMinutes,
    facilityId: found.facilityId,
    refusals: found.refusals,
    warnings: found.warnings,
    canApply: !found.refusals.length
})
// The workers' users (the person's accounts, never the caller) told of their shifts.
function tellWorker(partyId, values) {
    try {
        const userIds = Array.from(find("moqui.security.UserAccount").condition("partyId", partyId).list())
            .map(row => row.userId)
            .filter(userId => userId && userId !== ec.user.userId)
        if (!userIds.length) return 0
        ec.makeNotificationMessage().topic("PeopleShiftChange").message(values).userIds(userIds).send()
        return userIds.length
    } catch (error) {
        ec.logger.error("The shift notice to " + partyId + " was not sent: " + error.message)
        return 0
    }
}
const tellOne = (row, outcomeText) =>
    tellWorker(row.partyId, {
        datesText: lib.calendarDateText(row.shiftDate),
        firstDay: lib.calendarDateText(row.shiftDate),
        outcomeText,
        shiftCount: 1
    })
// store#Shift: preview (nothing written), apply (a new draft, or a change of one; a published shift stays published and its
// worker is told) or remove (cancelled; a published one told).
function storeShift(p) {
    const userScope = rosterScope("A shift")
    const action = ["preview", "apply", "remove"].includes(text(p.action)) ? text(p.action) : "preview"
    const operationKey = text(p.operationKey) || null
    const shiftAssignmentId = text(p.shiftAssignmentId) || null
    const earlierOf = () =>
        operationKey && !shiftAssignmentId
            ? Array.from(find(SHIFT).condition({operationKey, createdByUserId: ec.user.userId}).limit(1).list())[0] || null
            : null
    const existingOf = () => {
        if (!shiftAssignmentId) return null
        const row = one(SHIFT, {shiftAssignmentId})
        if (!row || !accessKinds(userScope, employmentRow(row.partyRelationshipId)).some(kind => readKinds.includes(kind)))
            denied("RECORD_UNAVAILABLE", "Shift " + shiftAssignmentId + " is not available")
        if (!rosters(accessKinds(userScope, employmentRow(row.partyRelationshipId))))
            denied("PERMISSION_DENIED", "Their manager or HR rosters this shift")
        return row
    }
    if (action !== "preview") {
        const earlier = earlierOf()
        if (earlier) return {shiftAssignmentId: earlier.shiftAssignmentId, statusEnumId: earlier.statusEnumId, repeated: true}
    }
    let existing = existingOf()
    if (existing && action !== "preview") {
        lockPerson(existing.partyId)
        existing = one(SHIFT, {shiftAssignmentId})
        if (p.expectedRevision != null && p.expectedRevision !== "" && text(p.expectedRevision) !== revisionOf(existing))
            denied("REVISION_CHANGED", "This shift changed since you read it (revision " + revisionOf(existing) + ")")
        if (existing.statusEnumId === "ShsCancelled") denied("SHIFT_REMOVED", "This shift was removed")
        if (ms(existing.startDate) <= nowMs()) denied("SHIFT_STARTED", "This shift has started; it stays as it was")
    }
    if (action === "remove") {
        if (!existing) denied("SHIFT_REQUIRED", "Choose the shift to remove")
        call("update#" + SHIFT, {
            shiftAssignmentId,
            statusEnumId: "ShsCancelled",
            statusEnumId_changeReason: text(p.reason) || null
        })
        if (existing.statusEnumId === "ShsPublished") tellOne(existing, "a shift removed")
        return {shiftAssignmentId, statusEnumId: "ShsCancelled"}
    }
    if (
        existing?.statusEnumId === "ShsPublished" &&
        text(p.partyRelationshipId) &&
        text(p.partyRelationshipId) !== existing.partyRelationshipId
    )
        denied("PERSON_CHANGE", "A published shift stays its worker's: remove it and add one for the other person")
    const employment = rosterEmployment(userScope, text(p.partyRelationshipId) || existing?.partyRelationshipId)
    if (action === "preview") {
        const found = assess(userScope, p, existing)
        const personName = people.personNames([employment.fromPartyId])[employment.fromPartyId] || employment.fromPartyId
        return {preview: Object.assign(assessmentAnswer(found, personName), {revision: existing ? revisionOf(existing) : null})}
    }
    lockPerson(employment.fromPartyId)
    const earlier = earlierOf()
    if (earlier) return {shiftAssignmentId: earlier.shiftAssignmentId, statusEnumId: earlier.statusEnumId, repeated: true}
    const found = assess(userScope, p, existing)
    if (found.refusals.length) denied(found.refusals[0].code, found.refusals[0].message)
    const values = {
        partyRelationshipId: employment.partyRelationshipId,
        partyId: employment.fromPartyId,
        organizationPartyId: employment.toPartyId,
        shiftDate: found.shiftDate,
        startDate: stamp(found.startMs),
        endDate: stamp(found.endMs),
        timeZone: found.zone || null,
        breakMinutes: found.breakMinutes,
        facilityId: found.facilityId,
        comments: found.comments
    }
    if (existing) {
        call("update#" + SHIFT, Object.assign({shiftAssignmentId, startDate_changeReason: text(p.reason) || null}, values))
        if (existing.statusEnumId === "ShsPublished") tellOne(Object.assign({}, existing, values), "a shift changed")
        return {shiftAssignmentId, statusEnumId: existing.statusEnumId}
    }
    const created = call(
        "create#" + SHIFT,
        Object.assign(values, {statusEnumId: "ShsDraft", createdByUserId: ec.user.userId, operationKey})
    )
    return {shiftAssignmentId: created.shiftAssignmentId, statusEnumId: "ShsDraft"}
}

// ===== publish#Shifts =====
// The drafts the caller rosters from fromDay for days (or those named), each published in its own transaction after it is
// assessed again (leave approved since, an overlap, an ended employment, a start passed: skipped and named); each worker told
// once of theirs.
function publishShifts(p) {
    const userScope = rosterScope("Publishing shifts")
    const named = Array.from(p.shiftAssignmentIds || [])
        .map(text)
        .filter(Boolean)
    let query = find(SHIFT).condition("statusEnumId", "ShsDraft")
    if (named.length) query = query.condition("shiftAssignmentId", "in", named)
    else {
        const fromDay = dayParam(p.fromDay)
        if (!fromDay) denied("DATE_REQUIRED", "Choose the days to publish")
        const days = Math.max(1, Math.min(31, Number(p.days) || 7))
        query = query
            .condition("startDate", "greater-equals", stamp(instantIn(fromDay, "00:00", null)))
            .condition("startDate", "less", stamp(instantIn(addDay(fromDay, days), "00:00", null)))
    }
    if (text(p.organizationPartyId)) query = query.condition("organizationPartyId", text(p.organizationPartyId))
    const drafts = Array.from(query.orderBy("startDate").limit(listCap).list()).filter(row =>
        rosters(accessKinds(userScope, employmentRow(row.partyRelationshipId)))
    )
    const names = people.personNames(unique(drafts.map(row => row.partyId)))
    const published = []
    const skipped = []
    for (const draft of drafts) {
        ec.message.pushErrors()
        try {
            ec.transaction.runRequireNew(null, "Publishing shift " + draft.shiftAssignmentId + " failed", () => {
                lockPerson(draft.partyId)
                const row = one(SHIFT, {shiftAssignmentId: draft.shiftAssignmentId})
                if (row.statusEnumId !== "ShsDraft") return
                const found = assess(userScope, {}, row)
                if (found.refusals.length) denied(found.refusals[0].code, found.refusals[0].message)
                call("update#" + SHIFT, {
                    shiftAssignmentId: row.shiftAssignmentId,
                    statusEnumId: "ShsPublished",
                    publishedDate: ec.user.nowTimestamp,
                    publishedByUserId: ec.user.userId
                })
                published.push(row)
                if (ec.message.hasError()) throw new Error(ec.message.getErrorsString())
            })
        } catch (error) {
            const reasonCode = lib.reasonCode(error)
            if (!reasonCode) ec.logger.error("Publishing shift " + draft.shiftAssignmentId + " failed: " + error.message)
            skipped.push({
                shiftAssignmentId: draft.shiftAssignmentId,
                personName: names[draft.partyId] || draft.partyId,
                whenText: whenText(ms(draft.startDate), ms(draft.endDate), null),
                code: reasonCode || "FAILED",
                message: String(error.message || error).replace(/^Error: /, "")
            })
        } finally {
            ec.message.clearErrors()
            ec.message.popErrors()
        }
    }
    // each worker told once: their days and how many
    const byParty = {}
    for (const row of published) (byParty[row.partyId] || (byParty[row.partyId] = [])).push(row)
    let notifiedCount = 0
    for (const [partyId, rowList] of Object.entries(byParty)) {
        const dayTexts = rowList.map(row => lib.calendarDateText(row.shiftDate)).sort()
        const first = dayTexts[0]
        const last = dayTexts[dayTexts.length - 1]
        notifiedCount += tellWorker(partyId, {
            datesText: first === last ? first : first + " to " + last,
            firstDay: first,
            outcomeText: rowList.length === 1 ? "a shift published" : rowList.length + " shifts published",
            shiftCount: rowList.length
        })
    }
    return {publishedCount: published.length, skipped, notifiedCount}
}

// ===== published shifts: the worker's, the team calendar's and the projected calendar =====
// The published shifts of people, from fromMs to thruMs: reach is a list of conditions (a person, a person at employers, employers).
function publishedShifts(reach, fromMs, thruMs) {
    if (!reach.length) return []
    const factory = ec.entity.conditionFactory
    return Array.from(
        find(SHIFT)
            .condition(reach.length === 1 ? reach[0] : factory.makeCondition(reach, "or"))
            .condition("statusEnumId", "ShsPublished")
            .condition("startDate", "less", stamp(thruMs))
            .condition("endDate", "greater", stamp(fromMs))
            .orderBy("startDate")
            .limit(listCap)
            .list()
    )
}
// get#MyShifts: the caller's own published shifts from fromDay (today) for days (14, at most 62); no party is taken.
function getMyShifts(p) {
    const userScope = people.scopeOf()
    if (!userScope.capabilities.self || !userScope.partyId)
        denied("PERMISSION_DENIED", "Your shifts need PEOPLE_SELF_SERVICE and a person of your own")
    const fromDay = dayParam(p.fromDay) || dayIn(nowMs(), null)
    const days = Math.max(1, Math.min(myDaysMax, Number(p.days) || myDaysDefault))
    const factory = ec.entity.conditionFactory
    const rowList = publishedShifts(
        [factory.makeCondition("partyId", "equals", userScope.partyId)],
        instantIn(fromDay, "00:00", null),
        instantIn(addDay(fromDay, days), "00:00", null)
    )
    const names = namesOf(rowList)
    const shifts = rowList.map(row => shiftRow(row, names, false))
    const next = shifts.find(row => !row.started)
    return {shifts, nextShiftText: next ? next.whenText : "", fromDay, days}
}
// The reach of the team calendar's shifts: the caller's own, their colleagues' (as its absences, Leave.js colleaguesOf), a
// manager's live reports' at the lines' employers and an HR reader's employers'.
function teamReach(userScope) {
    const caps = userScope.capabilities
    const factory = ec.entity.conditionFactory
    const reach = []
    if (caps.self && userScope.partyId) reach.push(factory.makeCondition("partyId", "equals", userScope.partyId))
    const lines = Object.entries(userScope.reportLines || {})
    if (caps.self) lines.push(...Object.entries(leave().colleaguesOf(userScope)))
    for (const [partyId, organizationPartyIds] of lines)
        if (organizationPartyIds.length)
            reach.push(
                factory.makeCondition(
                    factory.makeCondition("partyId", "equals", partyId),
                    "and",
                    factory.makeCondition("organizationPartyId", "in", organizationPartyIds)
                )
            )
    const employers = hrEmployers(userScope)
    if (employers.length) reach.push(factory.makeCondition("organizationPartyId", "in", employers))
    return reach
}
// get#TeamShifts: the team calendar's shifts from start through end (yyyy-MM-dd), as Commons' Calendar.qvue takes them (kind
// workHours, read only): "{person} · Shift" with its place, never a draft or a removed one.
function getTeamShifts(p) {
    const userScope = people.scopeOf()
    const caps = userScope.capabilities
    if (!caps.self && !caps.team && !caps.hrView)
        denied("PERMISSION_DENIED", "The team calendar needs PEOPLE_SELF_SERVICE, PEOPLE_TEAM_VIEW or PEOPLE_HR_VIEW")
    const startDay = dayParam(p.start) || dayIn(nowMs(), null)
    const endDay = dayParam(p.end) || addDay(startDay, 31)
    if (endDay < startDay) denied("DATES_INVALID", "The end is on or after the start")
    const rowList = publishedShifts(
        teamReach(userScope),
        instantIn(startDay, "00:00", null),
        instantIn(addDay(endDay), "00:00", null)
    )
    const names = namesOf(rowList)
    const eventList = rowList.map(row => {
        const shift = shiftRow(row, names, false)
        return {
            kind: "workHours",
            key: "shift|" + row.shiftAssignmentId,
            shiftAssignmentId: row.shiftAssignmentId,
            partyId: row.partyId,
            own: row.partyId === userScope.partyId,
            title: shift.personName + " · Shift" + (shift.facilityName ? " · " + shift.facilityName : ""),
            start: shift.startText,
            end: shift.endText,
            allDay: false,
            canEdit: false
        }
    })
    return {eventList, startDay, endDay}
}
// get#ShiftProjection: the My shifts projected CalDAV collection (mantle.work.CalendarDavServices, CX-SYNC): whether the caller is
// admitted (a self-service employee with a person of their own), and with checkOnly false their own published shifts from start
// to end (epoch millis; 30 days back to 90 days ahead when none) as the ICalendar tool writes them.
function getShiftProjection(p) {
    const userScope = people.scopeOf()
    const admitted = !!(userScope.capabilities.self && userScope.partyId)
    if (!admitted || truthy(p.checkOnly)) return {admitted, eventList: []}
    const startMs = p.start != null && p.start !== "" ? Number(p.start) : nowMs() - 30 * 24 * hourMs
    const endMs = p.end != null && p.end !== "" ? Number(p.end) : nowMs() + 90 * 24 * hourMs
    const factory = ec.entity.conditionFactory
    const rowList = publishedShifts([factory.makeCondition("partyId", "equals", userScope.partyId)], startMs, endMs)
    const places = facilityNames(rowList.map(row => row.facilityId))
    const organizations = people.organizationNames(unique(rowList.map(row => row.organizationPartyId)))
    const eventList = rowList.map(row => ({
        uid: "people-shift-" + row.shiftAssignmentId,
        sequence: 0,
        summary:
            "Shift · " +
            (organizations[row.organizationPartyId] || row.organizationPartyId) +
            (row.facilityId ? " · " + (places[row.facilityId] || row.facilityId) : ""),
        status: "CONFIRMED",
        allDay: false,
        start: ms(row.startDate),
        end: ms(row.endDate),
        timeZone: row.timeZone || ec.user.timeZone || null,
        lastModified: stampOf(row) || null
    }))
    return {admitted, eventList}
}

// ===== capacity (Schedules.js scheduledDays) =====
// The hours of people's published shifts on the days they count on: {partyId: {day: hours}} (each shift's instants less its
// break; one person's shifts never overlap).
function shiftDays(partyIds, days) {
    const out = {}
    const parties = unique((partyIds || []).filter(Boolean))
    if (!parties.length || !days.length) return out
    const rowList = Array.from(
        find(SHIFT)
            .condition("partyId", "in", parties)
            .condition("statusEnumId", "ShsPublished")
            .condition("shiftDate", "in", days)
            .list()
    )
    for (const row of rowList) {
        const day = lib.calendarDateText(row.shiftDate)
        const byDay = out[row.partyId] || (out[row.partyId] = {})
        byDay[day] = round((byDay[day] || 0) + lengthHours(ms(row.startDate), ms(row.endDate), row.breakMinutes))
    }
    return out
}

const operations = {getRoster, storeShift, publishShifts, getMyShifts, getTeamShifts, getShiftProjection}
function run(op, p) {
    if (!Object.hasOwn(operations, op)) throw new Error("Unknown shift operation " + op)
    return operations[op](p || {})
}
;({
    execute: run,
    // for Schedules.js scheduledDays (capacity)
    shiftDays
})
