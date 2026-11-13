// People's attendance (mantle.humanres.AttendanceServices record#Punch, get#MyClock, store#Clocking, find#Clocking, find#Attendance,
// get#Day, request#Correction, decide#Correction with the PeopleAttendanceApproval topic's approve#Correction and refuse#Correction,
// preview#Import, import#Records, get#Import and find#ImportRuns; IronStone People design §6 Attendance and TimeImport, §3
// SelfService's Clock, PE-05, PE-19; impl-people P13). Every service checks the caller's People scope first (People.js scopeOf) and
// reads and writes with authorization off after it.
//
// Attendance is evidence of presence, apart from work allocation and payable time (PeopleAttendanceEntities.xml):
// - a punch is a raw event of an employment, in or out at an instant, with its source and the source's own key; its unique
//   source key records it once, and it is never changed or deleted;
// - the day a punch counts on is the employment's day in the zone of its working schedule (the primary assignment's, else the
//   recorder's zone): an in-punch's own day, an out-punch the day of the in-punch it closes (the employment's punch before it, within
//   a day), so an overnight shift counts on the day it started; each punch refreshes its day: the first in, the last out, the
//   minutes between paired punches and what is missing (MISSING_OUT: an in-punch not closed, shown as clocked in while the shift is
//   young; MISSING_IN: an out-punch with no in; REPEATED: an in after an in or an out after an out, not paired);
// - a correction asks for a day's worked intervals with a reason and waits for a People approval of kind PakAttendance (the
//   person's manager unless a rule says otherwise; never the requester or the person); the last approval makes it the day's
//   attendance, the punches staying as they were;
// - an import reads a device file for an employer into rows, previews each (ready, known: recorded already, duplicate: repeated in
//   the file, refused: named with its reason), then records the ready ones in time order, each in its own transaction, a known
//   source key skipped and a failure named, the rest going on. An import approves nothing.
//
// Who: the person (PEOPLE_SELF_SERVICE) clocks in and out for their own employment when it has clocking on (the worker is the
// session's, never a parameter; the time is the server's), reads their days and asks to correct them; a manager (PEOPLE_TEAM_VIEW)
// reads their live reports' days at the line's employers and asks to correct them; an HR reader (PEOPLE_HR_VIEW) reads the
// employers' days and imports; an HR editor (PEOPLE_HR_EDIT) turns clocking on and off and asks corrections; an import needs
// PEOPLE_IMPORT beside PEOPLE_HR_VIEW and PEOPLE_HR_EDIT of the employer. The approvers of a correction decide it (Approvals.js).
// Missing and unauthorized records are refused alike (RECORD_UNAVAILABLE).
// P30: at a registered clocking device (a shared device's request, as its display account with PEOPLE_KIOSK_PUNCH) a worker clocks
// in and out by badge and PIN (record#KioskPunch); the proof and the badges are KioskIdentity.js's.
const people = ec.resource.script("component://mr-mantle/service/mantle/humanres/People.js")
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const {find, one, rows, denied, call, dateText} = lib

const PUNCH = "mantle.humanres.attendance.AttendancePunch"
const DAY = "mantle.humanres.attendance.AttendanceDay"
const CORRECTION = "mantle.humanres.attendance.AttendanceCorrection"
const INTERVAL = "mantle.humanres.attendance.AttendanceCorrectionInterval"
const IMPORT = "mantle.humanres.attendance.AttendanceImport"
const IMPORT_ROW = "mantle.humanres.attendance.AttendanceImportRow"
const RELATIONSHIP = "mantle.party.PartyRelationship"
const EMPLOYMENT = "mantle.humanres.employment.Employment"
const ASSIGNMENT = "mantle.humanres.employment.EmploymentAssignment"
const SCHEDULE = "mantle.humanres.schedule.WorkingSchedule"
const attendanceKind = "PakAttendance"
const approvals = () => ec.resource.script("component://mr-mantle/service/mantle/humanres/Approvals.js")
// the framework's bounded delimited reader (the transfer imports' own), so a device file is read as every import file is
const transferLib = () => ec.resource.script("component://framework/service/org/moqui/admin/DataTransferLib.js")

const minuteMs = 60 * 1000
const hourMs = 60 * minuteMs
const dayMs = 24 * hourMs
// an out-punch closes the employment's in-punch at most this long before it
const maxShiftMs = 24 * hourMs
// a day's last in-punch younger than this is a shift still open (clocked in); older, its out-punch is missing
const openShiftMs = 16 * hourMs
// a punch read from a file may be at most this far ahead of the server's clock
const futureSlackMs = 5 * minuteMs
// the most rows a list reads, an export gives, and a file holds
const listCap = 500
const exportCap = 5000
const importBounds = {maxRows: 5000, maxColumns: 30, maxCell: 200}
const importMaxBytes = 1048576
const runCap = 200

const ms = lib.ms
const nowMs = () => ms(ec.user.nowTimestamp)
const text = value => String(value ?? "").trim()
const truthy = value => value === true || value === "true" || value === "Y"
const stamp = millis => (millis == null ? null : new Date(Number(millis)))
const unique = people.unique
const stampOf = row => ms(row?.lastUpdatedStamp) ?? 0
const first = query => Array.from(query.limit(1).list())[0] || null

const directionTexts = {AtdIn: "In", AtdOut: "Out"}
const sourceTexts = {AtsSelf: "Self-service clock", AtsImport: "Imported file", AtsKiosk: "Clocking kiosk"}
const dayStatusTexts = {AdsRecorded: "Recorded", AdsCorrectionAsked: "Correction asked", AdsCorrected: "Corrected"}
const correctionStatusTexts = {
    AcsRequested: "Waiting for approval",
    AcsApproved: "Approved",
    AcsRefused: "Refused",
    AcsWithdrawn: "Withdrawn"
}
const flagTexts = {
    MISSING_OUT: "Missing out-punch",
    MISSING_IN: "Out-punch with no in",
    REPEATED: "Repeated punch",
    OPEN: "Clocked in"
}
const outcomeTexts = {
    ready: "Ready",
    known: "Already recorded",
    duplicate: "Repeated in the file",
    refused: "Refused",
    imported: "Imported",
    failed: "Failed"
}
const importStatusTexts = {AisPreviewed: "Previewed", AisImported: "Imported"}
const weekdayTexts = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]

// ===== days, times and zones =====
const zones = {}
function validZone(zone) {
    if (!zone) return false
    if (!zones.names) zones.names = new Set(Array.from(ec.l10n.getAvailableTimeZones() || []).map(String))
    return zones.names.has(String(zone))
}
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
const weekdayOf = day => weekdayTexts[new Date(String(day).slice(0, 10) + "T12:00:00Z").getUTCDay()]
const minutesText = minutes =>
    minutes == null ? "" : Math.floor(Number(minutes) / 60) + ":" + String(Math.round(Number(minutes)) % 60).padStart(2, "0")
// a time of day within a day's text: the time, with the day after it when it is not the attendance day
function timeOnDay(millis, day, zone) {
    if (millis == null) return ""
    const own = dayIn(millis, zone)
    return timeIn(millis, zone) + (own === day ? "" : own > day ? " (+1)" : " (-1)")
}
// a day given as a date, a timestamp or yyyy-MM-dd text, as yyyy-MM-dd in the user's zone
function dayParam(value) {
    if (value == null || value === "") return null
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(value))) return String(value)
    return ec.l10n.format(new Date(ec.user.timestampMillis(value)), "yyyy-MM-dd")
}
// HH:mm, or HH:mm:ss as a time input may post it, as minutes of the day
function minutesOfTime(value) {
    const match = /^(\d{1,2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/.exec(text(value))
    if (!match) return null
    const hours = Number(match[1])
    const minutes = Number(match[2])
    return hours > 23 || minutes > 59 ? null : hours * 60 + minutes
}

// The zone of an employment's days: its working schedule's at the instant (the primary assignment in effect then), else none.
function scheduleZone(partyRelationshipId, atMs) {
    const assignment = first(
        people
            .current(find(ASSIGNMENT).condition({partyRelationshipId, isPrimary: "Y"}), atMs)
            .condition("workingScheduleId", "is-not-null", null)
            .orderBy("-fromDate")
    )
    if (!assignment) return null
    const schedule = one(SCHEDULE, {workingScheduleId: assignment.workingScheduleId})
    return validZone(schedule?.timeZone) ? schedule.timeZone : null
}
// The work location of an employment's primary assignment at the instant, when it has one.
function facilityAt(partyRelationshipId, atMs) {
    const assignment = first(
        people.current(find(ASSIGNMENT).condition({partyRelationshipId, isPrimary: "Y"}), atMs).orderBy("-fromDate")
    )
    return assignment?.facilityId || null
}
function departmentAt(partyRelationshipId, atMs) {
    const assignment = first(
        people.current(find(ASSIGNMENT).condition({partyRelationshipId, isPrimary: "Y"}), atMs).orderBy("-fromDate")
    )
    return assignment?.departmentPartyId || null
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
    const partyId = employment.fromPartyId || employment.partyId
    const organizationPartyId = employment.toPartyId || employment.organizationPartyId
    if (caps.self && partyId === userScope.partyId) kinds.push("self")
    if (caps.team && ((userScope.reportLines || {})[partyId] || []).includes(organizationPartyId)) kinds.push("team")
    if (hrEmployers(userScope).includes(organizationPartyId)) kinds.push("hr")
    if (canEditAt(userScope, organizationPartyId)) kinds.push("hrEdit")
    return kinds
}
// who asks a correction: the person, their manager or an HR editor of the employer
const correctsKinds = ["self", "team", "hrEdit"]
// lock an employment's attendance: every punch and correction of it takes its relationship row first, so they serialize
const lockEmployment = partyRelationshipId => find(RELATIONSHIP, {partyRelationshipId}).forUpdate(true).one()

// ===== clocking =====
// Whether an employment clocks (impl-people §4, Nov 12): its own setting when it has one (Employment.clockingEnabled Y or N, the
// exception HR sets), else its employer's default (the employer's PartySetting PeopleClocking: Y on; N or none off). The one rule
// every caller reads: record#Punch, get#MyClock, find#Clocking and get#ClockOffer here, and any later reader (the kiosk, hours for
// pay) through isClockingOn. employerDefaults caches the employers' defaults for a caller that asks of many employments.
const SETTING = "mantle.party.PartySetting"
function employerClocking(organizationPartyId, employerDefaults) {
    if (!organizationPartyId) return false
    if (employerDefaults?.has(organizationPartyId)) return employerDefaults.get(organizationPartyId)
    const on = one(SETTING, {partyId: organizationPartyId, partySettingTypeId: "PeopleClocking"})?.settingValue === "Y"
    employerDefaults?.set(organizationPartyId, on)
    return on
}
// The clocking of an employment: on, its own setting (Y, N or null) and its employer's default.
function clockingOf(partyRelationshipId, employerDefaults = new Map()) {
    const relationship = employmentRow(partyRelationshipId)
    if (!relationship) return {on: false, setting: null, employerOn: false}
    const own = one(EMPLOYMENT, {partyRelationshipId})?.clockingEnabled
    const setting = own === "Y" || own === "N" ? own : null
    const employerOn = employerClocking(relationship.toPartyId, employerDefaults)
    return {on: setting ? setting === "Y" : employerOn, setting, employerOn}
}
const isClockingOn = (partyRelationshipId, employerDefaults) => clockingOf(partyRelationshipId, employerDefaults).on

// ===== punches and days =====
// The day a punch counts on: an in-punch's own day in the zone; an out-punch the day of the employment's in-punch it closes (the
// punch just before it, within a day, when that is an in-punch), so an overnight shift counts on its start day.
function dayOfPunch(partyRelationshipId, directionEnumId, punchMs, zone) {
    if (directionEnumId === "AtdOut") {
        const before = first(
            find(PUNCH)
                .condition("partyRelationshipId", partyRelationshipId)
                .condition("punchDate", "less", stamp(punchMs))
                .condition("punchDate", "greater-equals", stamp(punchMs - maxShiftMs))
                .orderBy("-punchDate")
        )
        if (before?.directionEnumId === "AtdIn" && before.attendanceDayId) {
            const day = one(DAY, {attendanceDayId: before.attendanceDayId})
            if (day) return day
        }
    }
    return {attendanceDate: dayIn(punchMs, zone), timeZone: zone}
}
// An employment's day row, made when it has none.
function dayRow(employment, attendanceDate, zone) {
    const found = first(find(DAY, {partyRelationshipId: employment.partyRelationshipId, attendanceDate}))
    if (found) return found
    const created = call("create#" + DAY, {
        partyRelationshipId: employment.partyRelationshipId,
        partyId: employment.fromPartyId,
        organizationPartyId: employment.toPartyId,
        attendanceDate,
        timeZone: zone || null,
        punchCount: 0,
        punchedMinutes: 0,
        workedMinutes: 0,
        statusEnumId: "AdsRecorded"
    })
    return one(DAY, {attendanceDayId: created.attendanceDayId})
}
// What a day's punches say, in time order: pairs of in and out, their minutes, and what is missing or repeated.
function readPunches(punches) {
    let open = null
    let closedLast = false
    let minutes = 0
    let firstIn = null
    let lastOut = null
    const flags = new Set()
    for (const punch of punches) {
        const at = ms(punch.punchDate)
        if (punch.directionEnumId === "AtdIn") {
            if (open) flags.add("REPEATED")
            else open = at
            if (firstIn == null) firstIn = at
            closedLast = false
        } else {
            if (open != null) {
                minutes += (at - open) / minuteMs
                open = null
                closedLast = true
            } else flags.add(closedLast ? "REPEATED" : "MISSING_IN")
            lastOut = at
        }
    }
    if (open != null) flags.add("MISSING_OUT")
    return {minutes: Math.round(minutes), firstIn, lastOut, openSince: open, flags: Array.from(flags)}
}
const punchesOf = attendanceDayId => Array.from(find(PUNCH, {attendanceDayId}).orderBy("punchDate").list())
// The day's summary from its punches, and its minutes: its approved correction's, else the punches'.
function refreshDay(attendanceDayId) {
    const day = one(DAY, {attendanceDayId})
    const punches = punchesOf(attendanceDayId)
    const read = readPunches(punches)
    const correction = day.attendanceCorrectionId ? one(CORRECTION, {attendanceCorrectionId: day.attendanceCorrectionId}) : null
    call("update#" + DAY, {
        attendanceDayId,
        punchCount: punches.length,
        firstInDate: stamp(read.firstIn),
        lastOutDate: stamp(read.lastOut),
        punchedMinutes: read.minutes,
        workedMinutes: correction ? correction.workedMinutes : read.minutes,
        flagsText: read.flags.join(",") || null
    })
}
// One punch of an employment, after the caller's own checks: the day it counts on, the punch and the day's summary. A known source
// key answers the punch recorded first (repeated). The employment is locked first, so its punches serialize.
function recordPunch(values) {
    const employment = values.employment
    lockEmployment(employment.partyRelationshipId)
    const known = values.sourceKey ? first(find(PUNCH, {sourceKey: values.sourceKey})) : null
    if (known) return {punch: known, repeated: true}
    const counted = dayOfPunch(employment.partyRelationshipId, values.directionEnumId, values.punchMs, values.zone)
    const day = counted.attendanceDayId ? counted : dayRow(employment, counted.attendanceDate, counted.timeZone)
    const created = call("create#" + PUNCH, {
        partyRelationshipId: employment.partyRelationshipId,
        partyId: employment.fromPartyId,
        organizationPartyId: employment.toPartyId,
        attendanceDayId: day.attendanceDayId,
        directionEnumId: values.directionEnumId,
        punchDate: stamp(values.punchMs),
        timeZone: values.zone || null,
        localTimeText: values.localTimeText || dayTimeIn(values.punchMs, values.zone),
        sourceEnumId: values.sourceEnumId,
        sourceSystem: values.sourceSystem || null,
        externalKey: values.externalKey || null,
        sourceKey: values.sourceKey,
        attendanceImportId: values.attendanceImportId || null,
        // P30: a kiosk punch is at its device's site, when the registration names one
        facilityId: values.facilityId || facilityAt(employment.partyRelationshipId, values.punchMs),
        deviceId: values.deviceId || null,
        kioskBadgeId: values.kioskBadgeId || null,
        recordedByUserId: ec.user.userId || null,
        recordedDate: ec.user.nowTimestamp
    })
    refreshDay(day.attendanceDayId)
    return {punch: one(PUNCH, {attendancePunchId: created.attendancePunchId}), repeated: false}
}
// Whether the employment is clocked in now: its last punch within a day is an in-punch, and since when.
function clockState(partyRelationshipId, atMs) {
    const last = first(
        find(PUNCH)
            .condition("partyRelationshipId", partyRelationshipId)
            .condition("punchDate", "greater-equals", stamp(atMs - maxShiftMs))
            .orderBy("-punchDate")
    )
    return {
        clockedIn: last?.directionEnumId === "AtdIn",
        sinceMs: last?.directionEnumId === "AtdIn" ? ms(last.punchDate) : null,
        last
    }
}

// ===== record#Punch, get#MyClock (self-service) =====
// The caller's own current employments with clocking on; the one named (their own, else refused as missing), or their only one.
function ownClockingEmployment(userScope, partyRelationshipId) {
    const now = nowMs()
    const own = (userScope.employments || []).filter(
        row => (ms(row.fromDate) ?? -Infinity) <= now && (ms(row.thruDate) ?? Infinity) > now
    )
    if (text(partyRelationshipId)) {
        const row = own.find(employment => employment.partyRelationshipId === text(partyRelationshipId))
        if (!row) denied("RECORD_UNAVAILABLE", "Employment " + text(partyRelationshipId) + " is not available")
        if (!isClockingOn(row.partyRelationshipId)) denied("CLOCKING_OFF", "Clocking is not on for this employment")
        return employmentRow(row.partyRelationshipId)
    }
    const clocking = own.filter(row => isClockingOn(row.partyRelationshipId))
    if (!clocking.length) denied("CLOCKING_OFF", "Clocking is not on for your employment")
    if (clocking.length > 1) denied("EMPLOYMENT_REQUIRED", "You clock for more than one employer: choose the employment")
    return employmentRow(clocking[0].partyRelationshipId)
}
const punchAnswer = (punch, repeated) => ({
    attendancePunchId: punch.attendancePunchId,
    attendanceDayId: punch.attendanceDayId,
    directionEnumId: punch.directionEnumId,
    directionText: directionTexts[punch.directionEnumId] || punch.directionEnumId,
    punchDateText: dayTimeIn(ms(punch.punchDate), punch.timeZone),
    repeated
})
// record#Punch: the caller clocks in or out for their own employment, now. The worker is the session's (never a parameter); the
// employment is their own with clocking on (the one named among their own, else their only one); the direction is the one asked,
// else the other of their state; clocking in while in, or out while out, is refused. A retry with the same operation key answers the
// first punch.
function recordSelfPunch(p) {
    const userScope = people.scopeOf()
    if (!userScope.capabilities.self || !userScope.partyId)
        denied("PERMISSION_DENIED", "Clocking in and out needs PEOPLE_SELF_SERVICE and a person")
    const operationKey = text(p.operationKey) || null
    const sourceKey = operationKey ? "self:" + ec.user.userId + ":" + operationKey : null
    if (sourceKey) {
        const known = first(find(PUNCH, {sourceKey}))
        if (known) return punchAnswer(known, true)
    }
    const employment = ownClockingEmployment(userScope, p.partyRelationshipId)
    lockEmployment(employment.partyRelationshipId)
    if (sourceKey) {
        const known = first(find(PUNCH, {sourceKey}))
        if (known) return punchAnswer(known, true)
    }
    const now = nowMs()
    const state = clockState(employment.partyRelationshipId, now)
    const directionEnumId = text(p.directionEnumId) || (state.clockedIn ? "AtdOut" : "AtdIn")
    if (!directionTexts[directionEnumId]) denied("DIRECTION_INVALID", "Clock in or out")
    const zone = scheduleZone(employment.partyRelationshipId, now) || userZone()
    if (directionEnumId === "AtdIn" && state.clockedIn)
        denied("ALREADY_IN", "You are clocked in since " + dayTimeIn(state.sinceMs, zone))
    if (directionEnumId === "AtdOut" && !state.clockedIn) denied("NOT_IN", "You are not clocked in")
    const recorded = recordPunch({
        employment,
        directionEnumId,
        punchMs: now,
        zone,
        sourceEnumId: "AtsSelf",
        sourceSystem: "Self-service",
        sourceKey: sourceKey || "self:" + ec.user.userId + ":" + now
    })
    return punchAnswer(recorded.punch, recorded.repeated)
}
// ===== record#KioskPunch (P30, the clocking kiosk) =====
const kioskIdentity = () => ec.resource.script("component://mr-mantle/service/mantle/humanres/KioskIdentity.js")
// record#KioskPunch: a worker clocks in or out at a registered clocking device, now. Only in the device's request, as its display
// account with PEOPLE_KIOSK_PUNCH; the worker is the one the badge and PIN prove (KioskIdentity.js: every refusal of a proof counted,
// a wrong PIN limited), whose current employment is with an organization of the display account's and clocks (CLOCKING_OFF). The
// direction is the one asked, else the other of the worker's state; in while in, or out while out, is refused. A retry with the same
// operationKey (the event key the kiosk made for the attempt) at the same device answers the first punch, the worker proving
// themselves again. The punch is at the device's site and names the device and the badge.
function recordKioskPunch(p) {
    const kiosk = kioskIdentity()
    const device = kiosk.deviceOfRequest()
    const proved = kiosk.identify(device, p.badgeText, p.pin)
    const employment = proved.employment
    const answer = (punch, repeated) =>
        Object.assign(punchAnswer(punch, repeated), {
            personName: proved.personName,
            punchTimeText: timeIn(ms(punch.punchDate), punch.timeZone)
        })
    const operationKey = text(p.operationKey) || null
    const sourceKey = operationKey ? "kiosk:" + device.deviceId + ":" + operationKey : null
    const knownOf = () => {
        const known = sourceKey ? first(find(PUNCH, {sourceKey})) : null
        // an event key of the device is the worker's who recorded it: another worker's retry with it records nothing
        if (known && known.partyRelationshipId !== employment.partyRelationshipId)
            denied("OPERATION_KEY_USED", "This attempt was recorded for someone else: try again")
        return known
    }
    const known = knownOf()
    if (known) return answer(known, true)
    if (!isClockingOn(employment.partyRelationshipId)) denied("CLOCKING_OFF", "Clocking is not on for you: ask HR")
    lockEmployment(employment.partyRelationshipId)
    const again = knownOf()
    if (again) return answer(again, true)
    const now = nowMs()
    const state = clockState(employment.partyRelationshipId, now)
    const directionEnumId = text(p.directionEnumId) || (state.clockedIn ? "AtdOut" : "AtdIn")
    if (!directionTexts[directionEnumId]) denied("DIRECTION_INVALID", "Clock in or out")
    const zone = scheduleZone(employment.partyRelationshipId, now) || userZone()
    if (directionEnumId === "AtdIn" && state.clockedIn)
        denied("ALREADY_IN", "You are clocked in since " + timeIn(state.sinceMs, zone))
    if (directionEnumId === "AtdOut" && !state.clockedIn) denied("NOT_IN", "You are not clocked in")
    const recorded = recordPunch({
        employment,
        directionEnumId,
        punchMs: now,
        zone,
        sourceEnumId: "AtsKiosk",
        sourceSystem: device.deviceName || "Clocking kiosk",
        sourceKey: sourceKey || "kiosk:" + device.deviceId + ":" + now + ":" + employment.partyRelationshipId,
        facilityId: device.facilityId || null,
        deviceId: device.deviceId,
        kioskBadgeId: proved.badge.kioskBadgeId
    })
    return answer(recorded.punch, recorded.repeated)
}

// get#MyClock: the caller's own current employments, each with whether clocking is on, whether they are clocked in and since when,
// their last punch and today's minutes; clocking: any has it on. Nothing for a caller without self-service.
function myClock() {
    const userScope = people.scopeOf()
    if (!userScope.capabilities.self || !userScope.partyId) return {clocking: false, employments: []}
    const now = nowMs()
    const own = (userScope.employments || []).filter(
        row => (ms(row.fromDate) ?? -Infinity) <= now && (ms(row.thruDate) ?? Infinity) > now
    )
    const names = people.organizationNames(unique(own.map(row => row.organizationPartyId)))
    const employments = own.map(row => {
        const on = isClockingOn(row.partyRelationshipId)
        const zone = scheduleZone(row.partyRelationshipId, now) || userZone()
        const state = on ? clockState(row.partyRelationshipId, now) : {clockedIn: false, last: null}
        const today = on
            ? first(find(DAY, {partyRelationshipId: row.partyRelationshipId, attendanceDate: dayIn(now, zone)}))
            : null
        const todayMinutes =
            (Number(today?.punchedMinutes) || 0) + (state.clockedIn ? Math.round((now - state.sinceMs) / minuteMs) : 0)
        return {
            partyRelationshipId: row.partyRelationshipId,
            organizationPartyId: row.organizationPartyId,
            organizationName: names[row.organizationPartyId] || row.organizationPartyId,
            clockingEnabled: on,
            clockedIn: state.clockedIn,
            sinceText: state.clockedIn ? timeIn(state.sinceMs, zone) : "",
            stateText: !on
                ? "Clocking is off"
                : state.clockedIn
                  ? "Clocked in since " + timeIn(state.sinceMs, zone)
                  : "Clocked out",
            lastPunchText: state.last
                ? (directionTexts[state.last.directionEnumId] || "") + " " + dayTimeIn(ms(state.last.punchDate), zone)
                : "",
            todayMinutes,
            todayText: minutesText(todayMinutes),
            actionText: state.clockedIn ? "Clock out" : "Clock in",
            directionEnumId: state.clockedIn ? "AtdOut" : "AtdIn"
        }
    })
    return {clocking: employments.some(row => row.clockingEnabled), employments}
}

// get#ClockOffer: whether the caller clocks for any current employment of their own (PEOPLE_SELF_SERVICE and a person), the
// condition of the quick create Clock in (org.moqui.ui.ShellServices.offer#QuickCreate). It answers the session's user alone and
// reads only their employments, so the shell can ask it on every page load.
function offerClock() {
    const partyId = ec.user.userAccount?.partyId || null
    if (!partyId || !ec.user.hasPermission("PEOPLE_SELF_SERVICE")) return {offer: false}
    const now = nowMs()
    const own = Array.from(
        people.current(people.employmentFind().condition("fromPartyId", partyId), null).limit(20).list()
    ).filter(row => (ms(row.fromDate) ?? -Infinity) <= now && (ms(row.thruDate) ?? Infinity) > now)
    const defaults = new Map()
    return {offer: own.some(row => isClockingOn(row.partyRelationshipId, defaults))}
}

// ===== store#Clocking, find#Clocking (HR) =====
// store#Clocking: an HR editor of the employer sets an employment's clocking, with a reason (the audit row's): Y on, N off (each an
// exception to the employer's default), or empty to follow the employer's default.
function storeClocking(p) {
    const userScope = people.scopeOf()
    const employment = employmentRow(text(p.partyRelationshipId))
    if (!employment || !canEditAt(userScope, employment.toPartyId))
        denied("RECORD_UNAVAILABLE", "Employment " + text(p.partyRelationshipId) + " is not available")
    const given = text(p.clockingEnabled)
    const setting = given === "" ? null : truthy(given) ? "Y" : given === "N" || given === "false" ? "N" : undefined
    if (setting === undefined) denied("CLOCKING_INVALID", "Clocking is Y, N or empty to follow the employer")
    const existing = one(EMPLOYMENT, {partyRelationshipId: employment.partyRelationshipId})
    const before = existing?.clockingEnabled === "Y" || existing?.clockingEnabled === "N" ? existing.clockingEnabled : null
    if (before !== setting) {
        const values = {
            partyRelationshipId: employment.partyRelationshipId,
            clockingEnabled: setting,
            clockingEnabled_changeReason: text(p.reason) || null
        }
        call((existing ? "update#" : "create#") + EMPLOYMENT, values)
    }
    const now = clockingOf(employment.partyRelationshipId)
    return {clockingEnabled: now.on, clockingSetting: now.setting, employerDefault: now.employerOn, changed: before !== setting}
}
// find#Clocking: the current employments of an HR reader's employers (or the one asked) that clock, by their own setting or their
// employer's default, and those set apart from the default (an exception off), each with how and whether the person is clocked in now.
function findClocking(p) {
    const userScope = people.scopeOf()
    const organizationPartyIds = hrEmployers(userScope)
    if (!organizationPartyIds.length) denied("PERMISSION_DENIED", "Who clocks needs PEOPLE_HR_VIEW")
    people.requireOrganization(userScope, text(p.organizationPartyId) || null)
    const employers = text(p.organizationPartyId) ? [text(p.organizationPartyId)] : organizationPartyIds
    const now = nowMs()
    const employments = Array.from(
        people
            .current(people.employmentFind().condition("toPartyId", "in", employers), now)
            .limit(exportCap)
            .list()
    )
    // each employment's own setting (an exception), else its employer's default
    const settings = new Map()
    for (let index = 0; index < employments.length; index += 500)
        for (const row of Array.from(
            find(EMPLOYMENT)
                .condition(
                    "partyRelationshipId",
                    "in",
                    employments.slice(index, index + 500).map(row => row.partyRelationshipId)
                )
                .condition("clockingEnabled", "in", ["Y", "N"])
                .selectField("partyRelationshipId,clockingEnabled")
                .list()
        ))
            settings.set(row.partyRelationshipId, row.clockingEnabled)
    const defaults = new Map()
    const clockingRow = row => {
        const setting = settings.get(row.partyRelationshipId) || null
        const employerOn = employerClocking(row.toPartyId, defaults)
        return {on: setting ? setting === "Y" : employerOn, setting, employerOn}
    }
    const found = employments.filter(row => {
        const clocking = clockingRow(row)
        return clocking.on || clocking.setting
    })
    const persons = people.personNames(unique(found.map(row => row.fromPartyId)))
    const organizations = people.organizationNames(unique(found.map(row => row.toPartyId)))
    const list = found
        .map(row => {
            const clocking = clockingRow(row)
            const state = clocking.on ? clockState(row.partyRelationshipId, now) : {clockedIn: false}
            const zone = scheduleZone(row.partyRelationshipId, now) || userZone()
            return {
                partyRelationshipId: row.partyRelationshipId,
                partyId: row.fromPartyId,
                personName: persons[row.fromPartyId] || row.fromPartyId,
                organizationPartyId: row.toPartyId,
                organizationName: organizations[row.toPartyId] || row.toPartyId,
                clockingEnabled: clocking.on,
                clockingSetting: clocking.setting,
                employerDefault: clocking.employerOn,
                settingText: !clocking.setting
                    ? "Employer's default"
                    : clocking.setting === "Y"
                      ? "On for this employee"
                      : "Off for this employee",
                clockedIn: state.clockedIn,
                stateText: !clocking.on
                    ? "Does not clock"
                    : state.clockedIn
                      ? "Clocked in since " + timeIn(state.sinceMs, zone)
                      : "Clocked out",
                canChange: canEditAt(userScope, row.toPartyId)
            }
        })
        .sort((a, b) => a.personName.localeCompare(b.personName))
    return lib.pageList(list, p, "clocking")
}

// ===== find#Attendance and get#Day =====
// The flags a day shows now: its punches' (an in-punch not closed is "clocked in" while the shift is young), none once corrected.
function flagsNow(day, now) {
    if (day.statusEnumId === "AdsCorrected") return []
    const flags = text(day.flagsText) ? text(day.flagsText).split(",") : []
    if (flags.includes("MISSING_OUT") && day.firstInDate != null) {
        const lastIn = Array.from(
            find(PUNCH, {attendanceDayId: day.attendanceDayId, directionEnumId: "AtdIn"}).orderBy("-punchDate").limit(1).list()
        )[0]
        if (lastIn && now - ms(lastIn.punchDate) < openShiftMs) return flags.map(flag => (flag === "MISSING_OUT" ? "OPEN" : flag))
    }
    return flags
}
const waitingCorrection = attendanceDayId =>
    first(find(CORRECTION, {attendanceDayId, statusEnumId: "AcsRequested"}).orderBy("-requestedDate"))
function dayLine(day, names, organizations, now, kinds, toDecide) {
    const date = lib.calendarDateText(day.attendanceDate)
    const zone = day.timeZone || null
    const flags = flagsNow(day, now)
    const exceptionFlags = flags.filter(flag => flag !== "OPEN")
    return {
        attendanceDayId: day.attendanceDayId,
        partyRelationshipId: day.partyRelationshipId,
        partyId: day.partyId,
        personName: names[day.partyId] || day.partyId,
        organizationPartyId: day.organizationPartyId,
        organizationName: organizations[day.organizationPartyId] || day.organizationPartyId,
        attendanceDate: date,
        weekdayText: weekdayOf(date),
        firstInText: timeOnDay(ms(day.firstInDate), date, zone),
        lastOutText: timeOnDay(ms(day.lastOutDate), date, zone),
        punchCount: Number(day.punchCount || 0),
        workedMinutes: Number(day.workedMinutes || 0),
        workedText: minutesText(day.workedMinutes || 0),
        workedHours: Math.round((Number(day.workedMinutes || 0) / 60) * 100) / 100,
        flags,
        flagsText: flags.map(flag => flagTexts[flag] || flag).join(", "),
        exception: exceptionFlags.length > 0 || day.statusEnumId === "AdsCorrectionAsked",
        statusEnumId: day.statusEnumId,
        statusText: dayStatusTexts[day.statusEnumId] || day.statusEnumId,
        timeZone: zone,
        toDecide: !!toDecide,
        canCorrect: kinds.some(kind => correctsKinds.includes(kind)) && day.statusEnumId !== "AdsCorrectionAsked"
    }
}
// The days the caller reads, as a query condition: their own employments' (self), their reports' employments at the line's employers
// (team) and an HR reader's employers'; with mine their own alone.
function reachCondition(userScope, mine) {
    const caps = userScope.capabilities
    const factory = ec.entity.conditionFactory
    const parts = []
    if (caps.self && userScope.partyId) parts.push(factory.makeCondition("partyId", "equals", userScope.partyId))
    if (!mine) {
        const reportIds = []
        const lines = userScope.reportLines || {}
        if (caps.team && Object.keys(lines).length)
            for (const row of Array.from(
                people.employmentFind().condition("fromPartyId", "in", Object.keys(lines)).limit(listCap).list()
            ))
                if ((lines[row.fromPartyId] || []).includes(row.toPartyId)) reportIds.push(row.partyRelationshipId)
        if (reportIds.length) parts.push(factory.makeCondition("partyRelationshipId", "in", reportIds))
        const hr = hrEmployers(userScope)
        if (hr.length) parts.push(factory.makeCondition("organizationPartyId", "in", hr))
    }
    if (!parts.length) return null
    return parts.reduce((all, part) => factory.makeCondition(all, "or", part))
}
// The days whose waiting correction the caller decides now (Approvals.js waitingFor): {attendanceDayId: attendanceCorrectionId}.
function daysToDecide() {
    const found = {}
    for (const row of approvals().waitingFor(listCap)) {
        if (row.approvalKindEnumId !== attendanceKind) continue
        const correction = one(CORRECTION, {attendanceCorrectionId: row.sourceId})
        if (correction) found[correction.attendanceDayId] = correction.attendanceCorrectionId
    }
    return found
}
// find#Attendance: the days the caller reads (their own, a manager's reports' at the line's employers, an HR reader's employers'), or
// with toDecide those whose correction they decide now; narrowed by a person, an employer, days from fromDate through thruDate and
// exceptionsOnly (what is missing or repeated, or a correction asked). Newest first, paged (an export every row up to 5000).
function findAttendance(p) {
    const userScope = people.scopeOf()
    const caps = userScope.capabilities
    if (!(caps.self || caps.team || caps.hrView || caps.requestApprove))
        denied(
            "PERMISSION_DENIED",
            "Attendance needs PEOPLE_SELF_SERVICE, PEOPLE_TEAM_VIEW, PEOPLE_HR_VIEW or PEOPLE_REQUEST_APPROVE"
        )
    const toDecide = truthy(p.toDecide)
    const deciding = toDecide || caps.requestApprove ? daysToDecide() : {}
    let query = find(DAY)
    if (toDecide) {
        const dayIds = Object.keys(deciding)
        query = query.condition("attendanceDayId", "in", dayIds.length ? dayIds : ["_NA_"])
    } else {
        const reach = reachCondition(userScope, truthy(p.mine))
        if (!reach) denied("PERMISSION_DENIED", "No attendance is yours to read")
        query = query.condition(reach)
    }
    if (text(p.partyId)) query = query.condition("partyId", text(p.partyId))
    if (text(p.organizationPartyId)) query = query.condition("organizationPartyId", text(p.organizationPartyId))
    if (text(p.partyRelationshipId)) query = query.condition("partyRelationshipId", text(p.partyRelationshipId))
    const fromDay = dayParam(p.fromDate)
    const thruDay = dayParam(p.thruDate)
    if (fromDay) query = query.condition("attendanceDate", "greater-equals", fromDay)
    if (thruDay) query = query.condition("attendanceDate", "less-equals", thruDay)
    if (truthy(p.exceptionsOnly)) {
        const factory = ec.entity.conditionFactory
        query = query.condition(
            factory.makeCondition(
                factory.makeCondition(
                    factory.makeCondition("flagsText", "is-not-null", null),
                    "and",
                    factory.makeCondition("statusEnumId", "not-equals", "AdsCorrected")
                ),
                "or",
                factory.makeCondition("statusEnumId", "equals", "AdsCorrectionAsked")
            )
        )
    }
    query = query.orderBy(["-attendanceDate", "partyId"])
    const paged = lib.page(query, p, "days", query.count(), {noLimitCap: exportCap})
    const names = people.personNames(unique(paged.rows.map(row => row.partyId)))
    const organizations = people.organizationNames(unique(paged.rows.map(row => row.organizationPartyId)))
    const now = nowMs()
    const days = paged.rows.map(day => {
        const kinds = accessKinds(userScope, {partyId: day.partyId, organizationPartyId: day.organizationPartyId})
        return dayLine(day, names, organizations, now, kinds, deciding[day.attendanceDayId])
    })
    return Object.assign({}, paged, {days, rows: undefined})
}
// A correction as its day shows it: the intervals, the minutes, the reason, who asked, its state and its approval.
function correctionLine(correction, zone, date, names) {
    const intervals = Array.from(
        find(INTERVAL, {attendanceCorrectionId: correction.attendanceCorrectionId}).orderBy("fromDate").list()
    )
    const summary = approvals().sourceSummary(attendanceKind, correction.attendanceCorrectionId)
    const requester = correction.requestedByUserId
        ? one("moqui.security.UserAccount", {userId: correction.requestedByUserId})
        : null
    return {
        attendanceCorrectionId: correction.attendanceCorrectionId,
        statusEnumId: correction.statusEnumId,
        statusText: correctionStatusTexts[correction.statusEnumId] || correction.statusEnumId,
        intervalsText: intervals
            .map(row => timeOnDay(ms(row.fromDate), date, zone) + " to " + timeOnDay(ms(row.thruDate), date, zone))
            .join(", "),
        workedText: minutesText(correction.workedMinutes || 0),
        reason: correction.reason || "",
        requestedByName: (requester?.partyId && names[requester.partyId]) || requester?.userFullName || "",
        requestedDateText: dateText(correction.requestedDate),
        decidedDateText: dateText(correction.decidedDate),
        approval: summary
    }
}
// How the scope admits a day: the access kinds of its employment, and approver when the caller may decide or decided a correction.
function dayAccess(userScope, day) {
    const kinds = accessKinds(userScope, {partyId: day.partyId, organizationPartyId: day.organizationPartyId})
    const partyId = userScope.partyId
    for (const correction of rows(CORRECTION, {attendanceDayId: day.attendanceDayId})) {
        const summary = approvals().sourceSummary(attendanceKind, correction.attendanceCorrectionId)
        if (summary?.canDecide || (partyId && approvalDecidedBy(correction.attendanceCorrectionId, partyId))) {
            kinds.push("approver")
            break
        }
    }
    return kinds
}
function approvalDecidedBy(attendanceCorrectionId, partyId) {
    return rows("mantle.humanres.approval.PeopleApproval", {sourceEntityName: CORRECTION, sourceId: attendanceCorrectionId}).some(
        approval =>
            rows("mantle.humanres.approval.PeopleApprovalDecision", {peopleApprovalId: approval.peopleApprovalId}).some(
                row => row.decidedByPartyId === partyId
            )
    )
}
function readableDay(userScope, attendanceDayId) {
    const day = text(attendanceDayId) ? one(DAY, {attendanceDayId: text(attendanceDayId)}) : null
    const kinds = day ? dayAccess(userScope, day) : []
    if (!day || !kinds.length) denied("RECORD_UNAVAILABLE", "Attendance day " + text(attendanceDayId) + " is not available")
    return {day, kinds}
}
// get#Day: a day the caller reads, with its punches (direction, time, source, the source system and its key), its corrections (the
// intervals, minutes, reason, who asked, state and approval) and what the caller may do: correct it (the person, their manager or an
// HR editor, while no correction waits), decide or withdraw the correction waiting.
function getDay(p) {
    const userScope = people.scopeOf()
    const {day, kinds} = readableDay(userScope, p.attendanceDayId)
    const date = lib.calendarDateText(day.attendanceDate)
    const zone = day.timeZone || null
    const names = people.personNames([day.partyId])
    const organizations = people.organizationNames([day.organizationPartyId])
    const deciding = daysToDecide()
    const line = dayLine(day, names, organizations, nowMs(), kinds, deciding[day.attendanceDayId])
    const punches = punchesOf(day.attendanceDayId).map(punch => ({
        attendancePunchId: punch.attendancePunchId,
        directionEnumId: punch.directionEnumId,
        directionText: directionTexts[punch.directionEnumId] || punch.directionEnumId,
        timeText: timeOnDay(ms(punch.punchDate), date, zone),
        punchDateText: dayTimeIn(ms(punch.punchDate), zone),
        localTimeText: punch.localTimeText || "",
        sourceText: sourceTexts[punch.sourceEnumId] || punch.sourceEnumId,
        sourceSystem: punch.sourceSystem || "",
        externalKey: punch.externalKey || ""
    }))
    const correctionRows = Array.from(find(CORRECTION, {attendanceDayId: day.attendanceDayId}).orderBy("-requestedDate").list())
    const requesters = correctionRows
        .map(row => (row.requestedByUserId ? one("moqui.security.UserAccount", {userId: row.requestedByUserId})?.partyId : null))
        .filter(Boolean)
    const requesterNames = people.personNames(unique(requesters))
    const corrections = correctionRows.map(row => correctionLine(row, zone, date, requesterNames))
    const waiting = correctionRows.find(row => row.statusEnumId === "AcsRequested") || null
    const waitingLine = waiting ? corrections.find(row => row.attendanceCorrectionId === waiting.attendanceCorrectionId) : null
    return {
        day: line,
        punches,
        corrections,
        waitingCorrectionId: waiting?.attendanceCorrectionId || null,
        access: kinds,
        canCorrect: line.canCorrect,
        canDecide: !!waitingLine?.approval?.canDecide,
        canWithdraw: !!waiting && (kinds.includes("self") || waiting.requestedByUserId === ec.user.userId)
    }
}

// ===== request#Correction =====
// The intervals a correction names: a list of {fromTime, thruTime} (HH:mm on the day, a thru at or before the from the next day),
// or fromTime and thruTime (and fromTime2 and thruTime2); in order, each within a day, none overlapping, together at most a day.
function intervalsParam(p, date, zone) {
    const listed = Array.isArray(p.intervals) || (p.intervals && typeof p.intervals === "object" && p.intervals.length != null)
    const given = listed ? Array.from(p.intervals) : []
    const list = given.length
        ? given
        : [
              {fromTime: p.fromTime, thruTime: p.thruTime},
              {fromTime: p.fromTime2, thruTime: p.thruTime2}
          ].filter(item => text(item.fromTime) || text(item.thruTime))
    if (!list.length) denied("INTERVALS_REQUIRED", "Enter the time worked: when it began and when it ended")
    const dayStart = instantIn(date, "00:00", zone)
    const intervals = list.map(item => {
        const from = minutesOfTime(item?.fromTime)
        const thru = minutesOfTime(item?.thruTime)
        if (from == null || thru == null) denied("TIME_INVALID", "Enter each time as hours and minutes, such as 08:30")
        const fromMs = instantIn(
            date,
            String(Math.floor(from / 60)).padStart(2, "0") + ":" + String(from % 60).padStart(2, "0"),
            zone
        )
        const thruDay = thru <= from ? addDay(date, 1) : date
        const thruMs = instantIn(
            thruDay,
            String(Math.floor(thru / 60)).padStart(2, "0") + ":" + String(thru % 60).padStart(2, "0"),
            zone
        )
        if (!(thruMs > fromMs) || thruMs - fromMs > dayMs) denied("TIME_INVALID", "An interval is shorter than a day")
        return {fromMs, thruMs}
    })
    intervals.sort((a, b) => a.fromMs - b.fromMs)
    for (let index = 1; index < intervals.length; index++)
        if (intervals[index].fromMs < intervals[index - 1].thruMs) denied("INTERVALS_OVERLAP", "The intervals overlap")
    if (
        intervals[intervals.length - 1].thruMs - dayStart > 2 * dayMs ||
        intervals.reduce((sum, row) => sum + row.thruMs - row.fromMs, 0) > dayMs
    )
        denied("TIME_INVALID", "A day's intervals are at most a day")
    return intervals
}
// request#Correction: a correction of an employment's day (attendanceDayId, or partyRelationshipId and attendanceDate for a day with
// no punch), asked by the person, their manager or an HR editor of the employer: the intervals worked and the reason; sent for a
// People approval of kind PakAttendance. The day is today or earlier, inside the employment; one correction waits at a time. A
// retry with the same operation key answers the first.
function requestCorrection(p) {
    const userScope = people.scopeOf()
    const operationKey = text(p.operationKey) || null
    const firstOf = () =>
        operationKey ? first(find(CORRECTION).condition({operationKey, requestedByUserId: ec.user.userId})) : null
    let earlier = firstOf()
    if (earlier) return Object.assign(correctionAnswer(earlier), {repeated: true})
    let day = text(p.attendanceDayId) ? one(DAY, {attendanceDayId: text(p.attendanceDayId)}) : null
    const employment = employmentRow(day ? day.partyRelationshipId : text(p.partyRelationshipId))
    const kinds = accessKinds(userScope, employment)
    if (!employment || (text(p.attendanceDayId) && !day) || !kinds.length)
        denied("RECORD_UNAVAILABLE", "This attendance is not available")
    if (!kinds.some(kind => correctsKinds.includes(kind)))
        denied("PERMISSION_DENIED", "The person, their manager or HR asks for a correction")
    lockEmployment(employment.partyRelationshipId)
    earlier = firstOf()
    if (earlier) return Object.assign(correctionAnswer(earlier), {repeated: true})
    const date = day ? lib.calendarDateText(day.attendanceDate) : dayParam(p.attendanceDate)
    if (!date) denied("DATE_REQUIRED", "Choose the day")
    const zone = day?.timeZone || scheduleZone(employment.partyRelationshipId, instantIn(date, "12:00", null)) || userZone()
    if (date > dayIn(nowMs(), zone)) denied("DATE_FUTURE", "A correction is of today or an earlier day")
    const noonMs = instantIn(date, "12:00", zone)
    if (
        (ms(employment.fromDate) ?? -Infinity) > instantIn(addDay(date, 1), "00:00", zone) ||
        (ms(employment.thruDate) ?? Infinity) <= instantIn(date, "00:00", zone)
    )
        denied("DATE_OUTSIDE", "The day is outside the employment")
    const reason = text(p.reason)
    if (!reason) denied("REASON_REQUIRED", "Say why the attendance is corrected")
    const intervals = intervalsParam(p, date, zone)
    if (!day) day = dayRow(employment, date, zone)
    if (waitingCorrection(day.attendanceDayId))
        denied("CORRECTION_PENDING", "A correction of this day already waits for approval")
    const workedMinutes = Math.round(intervals.reduce((sum, row) => sum + row.thruMs - row.fromMs, 0) / minuteMs)
    const created = call("create#" + CORRECTION, {
        attendanceDayId: day.attendanceDayId,
        partyRelationshipId: employment.partyRelationshipId,
        partyId: employment.fromPartyId,
        organizationPartyId: employment.toPartyId,
        departmentPartyId: departmentAt(employment.partyRelationshipId, noonMs),
        attendanceDate: date,
        statusEnumId: "AcsRequested",
        workedMinutes,
        reason,
        requestedByUserId: ec.user.userId || null,
        requestedDate: ec.user.nowTimestamp,
        operationKey
    })
    intervals.forEach((row, index) =>
        call("create#" + INTERVAL, {
            attendanceCorrectionId: created.attendanceCorrectionId,
            intervalSeqId: String(index + 1).padStart(2, "0"),
            fromDate: stamp(row.fromMs),
            thruDate: stamp(row.thruMs)
        })
    )
    call("update#" + DAY, {attendanceDayId: day.attendanceDayId, statusEnumId: "AdsCorrectionAsked"})
    const correction = one(CORRECTION, {attendanceCorrectionId: created.attendanceCorrectionId})
    approvals().request({
        approvalKindEnumId: attendanceKind,
        sourceId: correction.attendanceCorrectionId,
        organizationPartyId: correction.organizationPartyId,
        departmentPartyId: correction.departmentPartyId || null,
        subjectPartyId: correction.partyId,
        effectiveDate: instantIn(date, "00:00", zone)
    })
    return Object.assign(correctionAnswer(correction), {repeated: false})
}
const correctionAnswer = correction => ({
    attendanceCorrectionId: correction.attendanceCorrectionId,
    attendanceDayId: correction.attendanceDayId,
    statusEnumId: correction.statusEnumId,
    statusText: correctionStatusTexts[correction.statusEnumId] || correction.statusEnumId
})

// ===== decide#Correction and the topic's services =====
// approve or refuse the step waiting (through record#Decision at the correction's revision): the last approval makes the correction
// the day's attendance; a refusal needs a reason. withdraw: the person or who asked, while it waits. Under the employment's lock;
// one who reads nothing of it is answered as for a missing one. A decision retried answers the first.
function decideCorrection(p) {
    const userScope = people.scopeOf()
    const action = text(p.decision) || "approve"
    if (!["approve", "refuse", "withdraw"].includes(action)) denied("DECISION_INVALID", "Approve, refuse or withdraw")
    let correction = text(p.attendanceCorrectionId)
        ? one(CORRECTION, {attendanceCorrectionId: text(p.attendanceCorrectionId)})
        : null
    if (!correction) denied("RECORD_UNAVAILABLE", "Attendance correction " + text(p.attendanceCorrectionId) + " is not available")
    lockEmployment(correction.partyRelationshipId)
    correction = one(CORRECTION, {attendanceCorrectionId: correction.attendanceCorrectionId})
    const day = one(DAY, {attendanceDayId: correction.attendanceDayId})
    const kinds = day ? dayAccess(userScope, day) : []
    if (!kinds.length)
        denied("RECORD_UNAVAILABLE", "Attendance correction " + correction.attendanceCorrectionId + " is not available")
    if (action === "withdraw") {
        if (!kinds.includes("self") && correction.requestedByUserId !== ec.user.userId)
            denied("NOT_YOURS", "Only the person or who asked for it withdraws a correction")
        if (correction.statusEnumId !== "AcsRequested")
            denied("NOT_PENDING", "Only a correction waiting for approval is withdrawn")
        call("update#" + CORRECTION, {
            attendanceCorrectionId: correction.attendanceCorrectionId,
            statusEnumId: "AcsWithdrawn",
            decidedDate: ec.user.nowTimestamp
        })
        approvals().sourceChanged(attendanceKind, correction.attendanceCorrectionId)
        settleDay(day.attendanceDayId)
        return Object.assign(correctionAnswer(one(CORRECTION, {attendanceCorrectionId: correction.attendanceCorrectionId})), {
            repeated: false
        })
    }
    const asked = correction.statusEnumId
    const decided = call("mantle.humanres.PeopleApprovalServices.record#Decision", {
        approvalKindEnumId: attendanceKind,
        peopleApprovalId: text(p.peopleApprovalId) || null,
        sourceId: correction.attendanceCorrectionId,
        decision: action,
        reason: text(p.reason) || null,
        sourceRevision: text(p.sourceRevision) || null,
        operationKey: text(p.operationKey) || null
    })
    if (decided.repeated)
        return Object.assign(correctionAnswer(one(CORRECTION, {attendanceCorrectionId: correction.attendanceCorrectionId})), {
            repeated: true
        })
    if (asked !== "AcsRequested")
        denied("NOT_PENDING", "This correction is " + (correctionStatusTexts[asked] || asked).toLowerCase())
    if (decided.complete) {
        call("update#" + CORRECTION, {
            attendanceCorrectionId: correction.attendanceCorrectionId,
            statusEnumId: "AcsApproved",
            decidedDate: ec.user.nowTimestamp
        })
        call("update#" + DAY, {attendanceDayId: day.attendanceDayId, attendanceCorrectionId: correction.attendanceCorrectionId})
        settleDay(day.attendanceDayId)
    } else if (decided.statusId === "PapRefused") {
        call("update#" + CORRECTION, {
            attendanceCorrectionId: correction.attendanceCorrectionId,
            statusEnumId: "AcsRefused",
            decidedDate: ec.user.nowTimestamp
        })
        settleDay(day.attendanceDayId)
    }
    return Object.assign(correctionAnswer(one(CORRECTION, {attendanceCorrectionId: correction.attendanceCorrectionId})), {
        repeated: false
    })
}
// A day's state after a correction is decided or withdrawn: a correction asked while one waits, else corrected when an approved
// correction is in effect, else recorded; its minutes again.
function settleDay(attendanceDayId) {
    const day = one(DAY, {attendanceDayId})
    const statusEnumId = waitingCorrection(attendanceDayId)
        ? "AdsCorrectionAsked"
        : day.attendanceCorrectionId
          ? "AdsCorrected"
          : "AdsRecorded"
    call("update#" + DAY, {attendanceDayId, statusEnumId})
    refreshDay(attendanceDayId)
}
function decideNotice(p, decision) {
    const message = p.message || {}
    if (p.recordEntityName && p.recordEntityName !== CORRECTION) denied("SOURCE_INVALID", "Not an attendance approval")
    return decideCorrection({
        attendanceCorrectionId: p.recordId,
        peopleApprovalId: message.peopleApprovalId,
        sourceRevision: message.sourceRevision,
        decision,
        reason: p.reason
    })
}

// ===== preview#Import, import#Records, get#Import and find#ImportRuns =====
// The importer's scope: PEOPLE_IMPORT beside PEOPLE_HR_VIEW and PEOPLE_HR_EDIT; an employer is one they edit.
function importScope() {
    const userScope = people.scopeOf()
    const caps = userScope.capabilities
    if (!caps.import || !caps.hrView || !caps.hrEdit)
        denied("PERMISSION_DENIED", "Importing time and attendance needs PEOPLE_IMPORT, PEOPLE_HR_VIEW and PEOPLE_HR_EDIT")
    return userScope
}
const directionWords = {
    in: "AtdIn",
    i: "AtdIn",
    "clock in": "AtdIn",
    "check in": "AtdIn",
    "check-in": "AtdIn",
    entry: "AtdIn",
    1: "AtdIn",
    out: "AtdOut",
    o: "AtdOut",
    "clock out": "AtdOut",
    "check out": "AtdOut",
    "check-out": "AtdOut",
    exit: "AtdOut",
    0: "AtdOut"
}
const timeFormats = ["yyyy-MM-dd HH:mm:ss", "yyyy-MM-dd HH:mm", "yyyy-MM-dd'T'HH:mm:ss", "yyyy-MM-dd'T'HH:mm"]
function parseTime(value, zone) {
    const given = text(value)
    if (!given) return null
    // a time with an offset or Z names its instant itself
    if (/(Z|[+-]\d{2}:?\d{2})$/.test(given)) {
        const parsed = Date.parse(given)
        return Number.isFinite(parsed) ? parsed : null
    }
    for (const format of timeFormats) {
        if (given.length !== format.replace(/'/g, "").length) continue
        try {
            const parsed = ec.l10n.parseTimestamp(given, format, null, zone)
            if (parsed != null) return ms(parsed)
        } catch (error) {
            // the next format
        }
    }
    return null
}
// The person a file's worker cell names among those the employer employs or employed: People's person id, or a work email
// (EmailWork), each read once. Anyone else is unknown, as one who does not exist (the file tells the importer nothing of another
// employer's people).
function workerResolver(kind, organizationPartyId) {
    const employedThere = partyIds =>
        partyIds.length
            ? unique(
                  Array.from(
                      people
                          .employmentFind()
                          .condition("fromPartyId", "in", partyIds)
                          .condition("toPartyId", organizationPartyId)
                          .selectField("fromPartyId")
                          .list()
                  ).map(row => row.fromPartyId)
              )
            : []
    const cache = new Map()
    return value => {
        const key = text(value)
        if (!key) return null
        if (cache.has(key.toLowerCase())) return cache.get(key.toLowerCase())
        let partyId = null
        if (kind === "workEmail") {
            const mechs = Array.from(
                find("mantle.party.contact.ContactMech")
                    .condition(ec.entity.conditionFactory.makeCondition("infoString", "equals", key, false, true))
                    .condition("contactMechTypeEnumId", "CmtEmailAddress")
                    .selectField("contactMechId")
                    .limit(20)
                    .list()
            ).map(row => row.contactMechId)
            if (mechs.length) {
                const owners = employedThere(
                    unique(
                        Array.from(
                            people
                                .current(
                                    find("mantle.party.contact.PartyContactMech")
                                        .condition("contactMechId", "in", mechs)
                                        .condition("contactMechPurposeId", "EmailWork"),
                                    null
                                )
                                .list()
                        ).map(row => row.partyId)
                    )
                )
                partyId = owners.length === 1 ? owners[0] : owners.length > 1 ? "_AMBIGUOUS_" : null
            }
        } else partyId = one("mantle.party.Person", {partyId: key}) && employedThere([key]).length ? key : null
        cache.set(key.toLowerCase(), partyId)
        return partyId
    }
}
// The employments of the people at the employer, each read once: the one in effect at an instant, or why there is not one.
function employmentResolver(organizationPartyId) {
    const cache = new Map()
    return (partyId, atMs) => {
        if (!cache.has(partyId))
            cache.set(
                partyId,
                Array.from(people.employmentFind().condition({fromPartyId: partyId, toPartyId: organizationPartyId}).list())
            )
        const open = cache
            .get(partyId)
            .filter(row => (ms(row.fromDate) ?? -Infinity) <= atMs && (ms(row.thruDate) ?? Infinity) > atMs)
        if (!open.length) return {problem: ["NOT_EMPLOYED", "The worker is not employed by the employer at that time"]}
        if (open.length > 1)
            return {problem: ["EMPLOYMENT_AMBIGUOUS", "The worker has more than one employment there at that time"]}
        return {employment: open[0]}
    }
}
const importAnswer = batch => ({
    attendanceImportId: batch.attendanceImportId,
    statusEnumId: batch.statusEnumId,
    statusText: importStatusTexts[batch.statusEnumId] || batch.statusEnumId,
    rowCount: Number(batch.rowCount || 0),
    readyCount: Number(batch.readyCount || 0),
    importedCount: Number(batch.importedCount || 0),
    skippedCount: Number(batch.skippedCount || 0),
    errorCount: Number(batch.errorCount || 0)
})
// preview#Import: a device file for an employer read into an import and its rows, each resolved and named: ready, known (its source
// key is recorded already), duplicate (repeated in the file) or refused with its reason (WORKER_UNKNOWN, WORKER_AMBIGUOUS,
// NOT_EMPLOYED, EMPLOYMENT_AMBIGUOUS, TIME_INVALID, TIME_FUTURE, DIRECTION_INVALID, ROW_INVALID). Nothing is recorded. Refuses the
// file (ORGANIZATION_REQUIRED, ORGANIZATION_DENIED, SOURCE_REQUIRED, ZONE_INVALID, WORKER_KIND_INVALID, FILE_REQUIRED,
// FILE_TOO_LARGE, FILE_UNREADABLE, COLUMN_MISSING).
function previewImport(p) {
    const userScope = importScope()
    const organizationPartyId = text(p.organizationPartyId)
    if (!organizationPartyId) denied("ORGANIZATION_REQUIRED", "Choose the employer")
    if (!canEditAt(userScope, organizationPartyId))
        denied("ORGANIZATION_DENIED", "Organization " + organizationPartyId + " is not available")
    const sourceSystem = text(p.sourceSystem)
    if (!sourceSystem) denied("SOURCE_REQUIRED", "Name the device or system the file comes from")
    const zone = text(p.timeZone) || userZone()
    if (!validZone(zone)) denied("ZONE_INVALID", "Choose the time zone of the file's times")
    const workerIdKind = text(p.workerIdKind) || "partyId"
    if (!["partyId", "workEmail"].includes(workerIdKind)) denied("WORKER_KIND_INVALID", "Name workers by People id or work email")
    let source = ""
    let fileName = text(p.fileName)
    const file = p.importFile
    if (file && Number(file.size) > 0) {
        if (Number(file.size) > importMaxBytes)
            denied("FILE_TOO_LARGE", "The file is larger than " + importMaxBytes / 1024 + " KiB")
        source = String(file.getString("UTF-8") || "")
        fileName = fileName || text(file.getName())
    } else source = String(p.importText || "")
    if (!source.trim()) denied("FILE_REQUIRED", "Choose the file")
    if (source.length > importMaxBytes) denied("FILE_TOO_LARGE", "The file is larger than " + importMaxBytes / 1024 + " KiB")
    let parsed
    try {
        parsed = transferLib().parseDelimited(source, text(p.delimiter) === "tab" ? "\t" : text(p.delimiter) || ",", importBounds)
    } catch (error) {
        denied("FILE_UNREADABLE", String(error?.message ?? error))
    }
    const mapping = {
        worker: text(p.workerColumn) || "worker",
        time: text(p.timeColumn) || "time",
        direction: text(p.directionColumn) || "direction",
        key: text(p.keyColumn) || "id",
        device: text(p.deviceColumn) || "device"
    }
    const headerOf = name => parsed.headers.find(header => header.toLowerCase() === name.toLowerCase()) || null
    for (const field of ["worker", "time", "direction"])
        if (!headerOf(mapping[field])) denied("COLUMN_MISSING", "The file has no column " + mapping[field])
    const columns = Object.fromEntries(Object.entries(mapping).map(([field, name]) => [field, headerOf(name)]))
    const batchId = call("create#" + IMPORT, {
        organizationPartyId,
        fileName: fileName || "attendance.csv",
        sourceSystem,
        timeZone: zone,
        workerIdKind,
        mappingJson: JSON.stringify(columns),
        statusEnumId: "AisPreviewed",
        rowCount: parsed.rows.length,
        createdByUserId: ec.user.userId || null,
        createdDate: ec.user.nowTimestamp
    }).attendanceImportId
    const workerOf = workerResolver(workerIdKind, organizationPartyId)
    const employmentOf = employmentResolver(organizationPartyId)
    const now = nowMs()
    const seen = new Set()
    const counts = {ready: 0, known: 0, duplicate: 0, refused: 0}
    parsed.rows.forEach((row, index) => {
        const cell = field => (columns[field] ? text(row.sourceValues[columns[field]]) : "")
        const out = {
            attendanceImportId: batchId,
            rowSeqId: String(index + 1).padStart(5, "0"),
            lineNumber: row.rowNumber,
            workerText: cell("worker").slice(0, 200),
            timeText: cell("time").slice(0, 60),
            directionText: cell("direction").slice(0, 60),
            externalKey: cell("key").slice(0, 200) || null,
            deviceText: cell("device").slice(0, 200) || null
        }
        // one row that cannot be read is named and the others go on
        try {
            const refuse = (code, message) => Object.assign(out, {outcome: "refused", reasonCode: code, message})
            if (row.sourceError) refuse("ROW_INVALID", row.sourceError)
            else {
                const partyId = workerOf(out.workerText)
                const punchMs = parseTime(out.timeText, zone)
                const directionEnumId = directionWords[out.directionText.toLowerCase()] || null
                // a person the employer never employed is unknown here, as one who does not exist
                if (!partyId) refuse("WORKER_UNKNOWN", "No person is " + (out.workerText || "named"))
                else if (partyId === "_AMBIGUOUS_") refuse("WORKER_AMBIGUOUS", "More than one person has that work email")
                else if (punchMs == null) refuse("TIME_INVALID", "The time is not read as yyyy-MM-dd HH:mm")
                else if (punchMs > now + futureSlackMs) refuse("TIME_FUTURE", "The time is later than now")
                else if (!directionEnumId) refuse("DIRECTION_INVALID", "The direction is in or out")
                else {
                    const found = employmentOf(partyId, punchMs)
                    if (found.problem) refuse(found.problem[0], found.problem[1])
                    else {
                        const eventKey =
                            out.externalKey || partyId + "@" + punchMs + ":" + (directionEnumId === "AtdIn" ? "in" : "out")
                        const sourceKey = ["import", organizationPartyId, sourceSystem.toLowerCase(), eventKey]
                            .join(":")
                            .slice(0, 255)
                        Object.assign(out, {
                            partyId,
                            partyRelationshipId: found.employment.partyRelationshipId,
                            directionEnumId,
                            punchDate: stamp(punchMs),
                            sourceKey
                        })
                        if (seen.has(sourceKey)) out.outcome = "duplicate"
                        else if (first(find(PUNCH, {sourceKey}))) out.outcome = "known"
                        else out.outcome = "ready"
                        seen.add(sourceKey)
                    }
                }
            }
        } catch (error) {
            ec.logger.error("Attendance import " + batchId + " line " + row.rowNumber + " could not be read: " + error.message)
            Object.assign(out, {outcome: "refused", reasonCode: "ROW_INVALID", message: "This row could not be read"})
        }
        counts[out.outcome] = (counts[out.outcome] || 0) + 1
        call("create#" + IMPORT_ROW, out)
    })
    call("update#" + IMPORT, {
        attendanceImportId: batchId,
        readyCount: counts.ready,
        skippedCount: counts.known + counts.duplicate,
        errorCount: counts.refused,
        importedCount: 0
    })
    return importAnswer(one(IMPORT, {attendanceImportId: batchId}))
}
// import#Records: a previewed import's ready rows recorded in time order, each in its own transaction: a source key known by then
// is skipped, a failure named on its row, and the rest go on. An import imported already answers as it ended (repeated).
function importRecords(p) {
    const userScope = importScope()
    let batch = text(p.attendanceImportId) ? one(IMPORT, {attendanceImportId: text(p.attendanceImportId)}) : null
    if (!batch || !canEditAt(userScope, batch.organizationPartyId))
        denied("RECORD_UNAVAILABLE", "Attendance import " + text(p.attendanceImportId) + " is not available")
    batch = find(IMPORT, {attendanceImportId: batch.attendanceImportId}).forUpdate(true).one()
    if (batch.statusEnumId === "AisImported") return Object.assign(importAnswer(batch), {repeated: true})
    const ready = Array.from(
        find(IMPORT_ROW, {attendanceImportId: batch.attendanceImportId, outcome: "ready"})
            .orderBy(["partyRelationshipId", "punchDate", "rowSeqId"])
            .list()
    )
    let imported = 0
    let skipped = Number(batch.skippedCount || 0)
    let failed = 0
    for (const row of ready) {
        const result = {outcome: "imported", reasonCode: null, message: null, attendancePunchId: null}
        ec.message.pushErrors()
        try {
            ec.transaction.runRequireNew(null, "Attendance import row " + row.rowSeqId + " failed", () => {
                const employment = employmentRow(row.partyRelationshipId)
                if (!employment) denied("NOT_EMPLOYED", "The employment is not available")
                const recorded = recordPunch({
                    employment,
                    directionEnumId: row.directionEnumId,
                    punchMs: ms(row.punchDate),
                    zone: scheduleZone(row.partyRelationshipId, ms(row.punchDate)) || batch.timeZone,
                    localTimeText: row.timeText + " " + batch.timeZone,
                    sourceEnumId: "AtsImport",
                    sourceSystem: batch.sourceSystem,
                    externalKey: row.externalKey,
                    sourceKey: row.sourceKey,
                    attendanceImportId: batch.attendanceImportId
                })
                if (ec.message.hasError()) throw new Error(ec.message.getErrorsString())
                if (recorded.repeated)
                    Object.assign(result, {outcome: "known", attendancePunchId: recorded.punch.attendancePunchId})
                else result.attendancePunchId = recorded.punch.attendancePunchId
            })
        } catch (error) {
            if (!lib.reasonCode(error))
                ec.logger.error(
                    "Attendance import " + batch.attendanceImportId + " row " + row.rowSeqId + " failed: " + error.message
                )
            Object.assign(result, {
                outcome: "failed",
                reasonCode: lib.reasonCode(error) || "FAILED",
                message: String(error?.message || error)
                    .replace(/^[A-Z][A-Z0-9_]+: /, "")
                    .slice(0, 250)
            })
        } finally {
            ec.message.clearErrors()
            ec.message.popErrors()
        }
        if (result.outcome === "imported") imported++
        else if (result.outcome === "known") skipped++
        else failed++
        call("update#" + IMPORT_ROW, Object.assign({attendanceImportId: row.attendanceImportId, rowSeqId: row.rowSeqId}, result))
    }
    call("update#" + IMPORT, {
        attendanceImportId: batch.attendanceImportId,
        statusEnumId: "AisImported",
        importedCount: imported,
        skippedCount: skipped,
        errorCount: Number(batch.errorCount || 0) + failed,
        importedByUserId: ec.user.userId || null,
        importedDate: ec.user.nowTimestamp
    })
    return Object.assign(importAnswer(one(IMPORT, {attendanceImportId: batch.attendanceImportId})), {repeated: false})
}
// get#Import: an import an HR reader of its employer reads, with its rows (all, or of an outcome; problems: refused and failed),
// each with what it named and its outcome.
function getImport(p) {
    const userScope = people.scopeOf()
    const batch = text(p.attendanceImportId) ? one(IMPORT, {attendanceImportId: text(p.attendanceImportId)}) : null
    if (!batch || !hrEmployers(userScope).includes(batch.organizationPartyId))
        denied("RECORD_UNAVAILABLE", "Attendance import " + text(p.attendanceImportId) + " is not available")
    let query = find(IMPORT_ROW, {attendanceImportId: batch.attendanceImportId})
    const outcome = text(p.outcome)
    if (outcome === "problems") query = query.condition("outcome", "in", ["refused", "failed"])
    else if (outcome) query = query.condition("outcome", outcome)
    const rowList = Array.from(query.orderBy("rowSeqId").limit(exportCap).list())
    const names = people.personNames(unique(rowList.map(row => row.partyId).filter(Boolean)))
    const creator = batch.createdByUserId ? one("moqui.security.UserAccount", {userId: batch.createdByUserId}) : null
    return {
        attendanceImport: Object.assign(importAnswer(batch), {
            organizationPartyId: batch.organizationPartyId,
            organizationName:
                people.organizationNames([batch.organizationPartyId])[batch.organizationPartyId] || batch.organizationPartyId,
            fileName: batch.fileName,
            sourceSystem: batch.sourceSystem,
            timeZone: batch.timeZone,
            workerIdKind: batch.workerIdKind,
            createdByName: creator?.userFullName || creator?.username || "",
            createdDateText: dateText(batch.createdDate),
            importedDateText: dateText(batch.importedDate),
            canImport: batch.statusEnumId === "AisPreviewed" && Number(batch.readyCount || 0) > 0 && canImport(userScope, batch)
        }),
        rows: rowList.map(row => ({
            rowSeqId: row.rowSeqId,
            lineNumber: Number(row.lineNumber || 0),
            workerText: row.workerText || "",
            personName: row.partyId ? names[row.partyId] || "" : "",
            timeText: row.timeText || "",
            directionText: row.directionEnumId ? directionTexts[row.directionEnumId] : row.directionText || "",
            externalKey: row.externalKey || "",
            deviceText: row.deviceText || "",
            outcome: row.outcome,
            outcomeText: outcomeTexts[row.outcome] || row.outcome,
            reasonCode: row.reasonCode || "",
            message: row.message || ""
        }))
    }
}
function canImport(userScope, batch) {
    const caps = userScope.capabilities
    return !!(caps.import && canEditAt(userScope, batch.organizationPartyId))
}
// find#ImportRuns: the time-and-attendance transfer target's runs for the framework's org.moqui.admin.DataTransferServices (Admin's
// Imports): the imports of the employers an HR reader reads (PEOPLE_HR_VIEW and People's scope; a scope key narrows), newest first,
// as summaries with the parameters that open each in TimeImport. None otherwise.
function findImportRuns(p) {
    let organizationPartyIds
    try {
        organizationPartyIds = hrEmployers(people.scopeOf())
    } catch (error) {
        return {runList: []}
    }
    if (text(p.scopeKey)) organizationPartyIds = organizationPartyIds.filter(id => id === text(p.scopeKey))
    if (!organizationPartyIds.length) return {runList: []}
    let query = find(IMPORT).condition("organizationPartyId", "in", organizationPartyIds)
    if (p.fromDate != null && p.fromDate !== "")
        query = query.condition("createdDate", "greater-equals", stamp(Number(p.fromDate)))
    if (p.thruDate != null && p.thruDate !== "") query = query.condition("createdDate", "less", stamp(Number(p.thruDate)))
    const found = Array.from(
        query
            .orderBy("-createdDate")
            .limit(Math.min(Number(p.maxRows) || 100, runCap))
            .list()
    )
    const organizations = people.organizationNames(unique(found.map(row => row.organizationPartyId)))
    const users = new Map()
    const userName = userId => {
        if (!userId) return null
        if (!users.has(userId)) {
            const account = one("moqui.security.UserAccount", {userId})
            users.set(userId, account?.userFullName || account?.username || userId)
        }
        return users.get(userId)
    }
    return {
        runList: found.map(row => ({
            runId: row.attendanceImportId,
            fileLabel: row.fileName || "Attendance file",
            scopeKey: row.organizationPartyId,
            scopeTitle: organizations[row.organizationPartyId] || row.organizationPartyId,
            state: row.statusEnumId === "AisImported" ? "complete" : "open",
            stateText: importStatusTexts[row.statusEnumId] || null,
            startedDate: ms(row.createdDate),
            userName: userName(row.importedByUserId || row.createdByUserId),
            rowCount: Number(row.rowCount || 0),
            appliedCount: Number(row.importedCount || 0),
            errorCount: Number(row.errorCount || 0),
            skippedCount: Number(row.skippedCount || 0),
            ownerParameters: {attendanceImportId: row.attendanceImportId}
        }))
    }
}

const operations = {
    recordSelfPunch,
    recordKioskPunch,
    myClock,
    offerClock,
    storeClocking,
    findClocking,
    findAttendance,
    getDay,
    requestCorrection,
    decideCorrection,
    approveNotice: p => decideNotice(p, "approve"),
    refuseNotice: p => decideNotice(p, "refuse"),
    previewImport,
    importRecords,
    getImport,
    findImportRuns
}
function run(op, p) {
    if (!Object.hasOwn(operations, op)) throw new Error("Unknown attendance operation " + op)
    return operations[op](p || {})
}
;({
    execute: run,
    isClockingOn,
    // P28 (PayrollExchange.js): a file's worker named by People's person id or work email among the employer's people
    workerResolver
})
