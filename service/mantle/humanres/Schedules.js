// People's working schedules and holiday calendars (mantle.humanres.ScheduleServices find#Schedules, get#Schedule, store#Schedule,
// store#ScheduleLine, get#Holidays, store#HolidayCalendar, store#Holiday and get#CapacityPreview; assign#Schedule is
// Employment.js's; IronStone People design §6 WorkingSchedules and WorkingScheduleDetail, §7 HolidayCalendars, PE-06; impl-people
// P9). Every service checks the caller's People scope first (People.js scopeOf) and reads and writes with authorization off after
// it. And the planned hours of people with a schedule, which mantle.work.ResourceServices.get#PartyCapacity reads before their own
// working hours and the timesheet policy (scheduledDays, F23).
//
// The records (PeopleScheduleEntities.xml):
// - a schedule (WorkingSchedule) is an employer's dated working week in a time zone, with a holiday calendar; its lines
//   (WorkingScheduleLine) are dated weekly intervals: a day of the week, a local start and end (an end at or before the start ends
//   the next day) and an unpaid break. A schedule's lines in effect at the same time never overlap. A change of a line from a date
//   ends it and starts another; ended rows are kept. The zone does not change once the schedule has been assigned: a copy is a new
//   schedule;
// - an employment follows a schedule from a date through its assignment (EmploymentAssignment.workingScheduleId, with
//   holidayCategoryId in place of the schedule's calendar), so the history of what a person was planned to work stays readable;
// - a holiday calendar is a WorkEffortCategory of type WcatHoliday, an employer's (ownerPartyId) or shared by every employer (no
//   owner, as the US calendars of HolidayUsaData; none is assigned to anyone by default, F31); a holiday is an all-day WepHoliday
//   WorkEffort on its day (allDayStart) in the calendar (WorkEffortCategoryAppl), with no owner, so the employer-owned holiday
//   convention (a WepHoliday owned by the organization, which Projects' capacity and BusinessTime read for everyone of it) does
//   not read it: a calendar's holidays take the days of the schedules that name it.
//
// Planned hours (scheduledDays): each day of a person followed by a schedule is planned by the schedule in effect at noon of that
// day in the schedule's zone (the days by the schedule's zone); each line in effect then gives an interval from its local start to
// its end, whose hours are the actual instants between them less the break (a shift across midnight or a daylight saving change
// has its true length) and count on the day it starts. Two employments' intervals that overlap count once.
//
// Who: a staff reader of an employer reads its schedules and the holiday calendars (its own and the shared ones); a manager
// (PEOPLE_TEAM_VIEW) reads the schedules their live reports follow. An HR editor (PEOPLE_HR_VIEW and PEOPLE_HR_EDIT) of the
// employer changes its schedules, assigns them and changes its calendars; a shared calendar needs PEOPLE_ALL_ORGANIZATIONS too.
// Who follows a schedule is shown to an HR reader of its employer and, of their reports, to a manager. Missing and unauthorized
// records are refused alike (RECORD_UNAVAILABLE).
const people = ec.resource.script("component://mr-mantle/service/mantle/humanres/People.js")
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const {find, one, rows, denied, call, dateText} = lib

const SCHEDULE = "mantle.humanres.schedule.WorkingSchedule"
const LINE = "mantle.humanres.schedule.WorkingScheduleLine"
const ASSIGNMENT = "mantle.humanres.employment.EmploymentAssignment"
const CATEGORY = "mantle.work.effort.WorkEffortCategory"
const CATEGORY_APPL = "mantle.work.effort.WorkEffortCategoryAppl"
const WORK_EFFORT = "mantle.work.effort.WorkEffort"
const minuteMs = 60000
const hourMs = 3600000
const weekMinutes = 7 * 24 * 60
const dayTexts = ["", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
const stateTexts = {current: "In effect", future: "Coming", ended: "Ended"}
// the longest capacity preview, in days
const previewDays = 62

const ms = lib.ms
const nowMs = () => ms(ec.user.nowTimestamp)
const text = value => String(value ?? "").trim()
const unique = people.unique
const round = value => Math.round(value * 100) / 100
const stamp = millis => (millis == null ? null : new Date(millis))
const given = value => value != null
const truthy = value => value === true || value === "true" || value === "Y"
const likeText = value => "%" + String(value).replace(/[\\%_]/g, character => "\\" + character) + "%"
const stampOf = row => ms(row?.lastUpdatedStamp) ?? 0
const voided = row => row.thruDate != null && ms(row.thruDate) <= (ms(row.fromDate) ?? -Infinity)
const openAt = (row, at) => (ms(row.fromDate) ?? -Infinity) <= at && (ms(row.thruDate) ?? Infinity) > at
const stateOf = (row, at) =>
    (ms(row.fromDate) ?? -Infinity) > at ? "future" : (ms(row.thruDate) ?? Infinity) <= at ? "ended" : "current"

// ===== days and times =====
// a day (yyyy-MM-dd) and a day count from it, on the calendar
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
// the instant of a local wall time (HH:mm) on a day in a zone (an IANA name; none is the user's)
const instantIn = (day, time, zone) =>
    ms(ec.l10n.parseTimestamp(String(day).slice(0, 10) + " " + time + ":00.000", "yyyy-MM-dd HH:mm:ss.SSS", null, zone || null))
const dayIn = (millis, zone) => ec.l10n.format(new Date(Number(millis)), "yyyy-MM-dd", null, zone || null)
const todayStart = () => instantIn(dayIn(nowMs(), null), "00:00", null)
// an effective date: the start of today when empty, else the date given (a date alone is its start in the user's zone)
const effective = value => (value == null || value === "" ? todayStart() : ec.user.timestampMillis(value))
const minutesOf = time => {
    // HH:mm, or HH:mm:ss as a time input may post it (the seconds are dropped)
    const match = /^(\d{1,2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/.exec(text(time))
    if (!match) return null
    const hours = Number(match[1])
    const minutes = Number(match[2])
    return hours > 23 || minutes > 59 ? null : hours * 60 + minutes
}
const timeText = minutes => String(Math.floor(minutes / 60)).padStart(2, "0") + ":" + String(minutes % 60).padStart(2, "0")
// a line's length in minutes by the clock (an end at or before the start is the next day's)
function lineMinutes(line) {
    const start = minutesOf(line.startTime)
    const end = minutesOf(line.endTime)
    if (start == null || end == null) return 0
    return end > start ? end - start : end + 24 * 60 - start
}
const lineHours = line => Math.max(0, lineMinutes(line) - Number(line.breakMinutes || 0)) / 60
// the zone names, read once in the run
const zones = {names: null}
function validZone(zone) {
    if (!zone) return false
    if (!zones.names) zones.names = new Set(Array.from(ec.l10n.getAvailableTimeZones() || []).map(String))
    return zones.names.has(String(zone))
}
// a list in a map by key, made when missing
function listIn(map, key) {
    if (!map[key]) map[key] = []
    return map[key]
}

// ===== scope =====
function scopeFor(what) {
    const userScope = people.scopeOf()
    const caps = userScope.capabilities
    if (!caps.staff && !caps.team) denied("PERMISSION_DENIED", what + " needs a People read of an employer or a team")
    return userScope
}
function editorScope(what) {
    const userScope = people.scopeOf()
    const caps = userScope.capabilities
    if (!caps.hrView || !caps.hrEdit) denied("PERMISSION_DENIED", what + " needs PEOPLE_HR_VIEW and PEOPLE_HR_EDIT")
    return userScope
}
const staffEmployers = userScope => (userScope.capabilities.staff ? userScope.organizationPartyIds : [])
const hrEmployers = userScope => (userScope.capabilities.hrView ? userScope.organizationPartyIds : [])
const canEditAt = (userScope, organizationPartyId) =>
    !!(
        userScope.capabilities.hrView &&
        userScope.capabilities.hrEdit &&
        userScope.organizationPartyIds.includes(organizationPartyId)
    )
// the employments of a manager's live reports at the employers of their lines (P3's team scope)
function teamEmploymentIds(userScope) {
    const ids = []
    for (const [partyId, organizationPartyIds] of Object.entries(userScope.reportLines || {})) {
        if (!organizationPartyIds.length) continue
        for (const row of people
            .current(
                people.employmentFind().condition("fromPartyId", partyId).condition("toPartyId", "in", organizationPartyIds),
                null
            )
            .list())
            ids.push(row.partyRelationshipId)
    }
    return ids
}
// the assignments now and to come of employments (or of a schedule), not voided
function liveAssignments(conditions) {
    let query = find(ASSIGNMENT).condition("isPrimary", "Y").condition("workingScheduleId", "is-not-null", null)
    for (const [field, value] of Object.entries(conditions))
        query = Array.isArray(value)
            ? query.condition(field, "in", value.length ? value : ["_NA_"])
            : query.condition(field, value)
    const factory = ec.entity.conditionFactory
    query = query.condition(
        factory.makeCondition(
            factory.makeCondition("thruDate", "is-null", null),
            "or",
            factory.makeCondition("thruDate", "greater", stamp(nowMs()))
        )
    )
    return Array.from(query.list()).filter(row => !voided(row))
}
// the schedules a manager reads: those their reports follow now or later
function teamScheduleIds(userScope) {
    if (!userScope.capabilities.team || !userScope.reportPartyIds.length) return []
    return unique(liveAssignments({partyRelationshipId: teamEmploymentIds(userScope)}).map(row => row.workingScheduleId))
}
// A schedule the caller reads, else refused as missing (RECORD_UNAVAILABLE).
function readableSchedule(userScope, workingScheduleId) {
    const id = text(workingScheduleId)
    const row = id ? one(SCHEDULE, {workingScheduleId: id}) : null
    if (!row || !(staffEmployers(userScope).includes(row.organizationPartyId) || teamScheduleIds(userScope).includes(id)))
        denied("RECORD_UNAVAILABLE", "Working schedule " + id + " is not available")
    return row
}
// A calendar the caller reads: a shared one, or one of an employer they read as staff.
function calendarReadable(userScope, row) {
    return (
        !!row &&
        row.categoryTypeEnumId === "WcatHoliday" &&
        (!row.ownerPartyId || staffEmployers(userScope).includes(row.ownerPartyId))
    )
}
function canEditCalendar(userScope, row) {
    if (!userScope.capabilities.hrView || !userScope.capabilities.hrEdit) return false
    return row.ownerPartyId
        ? userScope.organizationPartyIds.includes(row.ownerPartyId)
        : !!userScope.capabilities.allOrganizations
}

// ===== names and revisions =====
function scheduleNames(scheduleIds) {
    const ids = unique((scheduleIds || []).filter(Boolean))
    if (!ids.length) return {}
    return Object.fromEntries(
        Array.from(find(SCHEDULE).condition("workingScheduleId", "in", ids).list()).map(row => [
            row.workingScheduleId,
            row.scheduleName || row.workingScheduleId
        ])
    )
}
function calendarNames(categoryIds) {
    const ids = unique((categoryIds || []).filter(Boolean))
    if (!ids.length) return {}
    return Object.fromEntries(
        Array.from(find(CATEGORY).condition("workEffortCategoryId", "in", ids).list()).map(row => [
            row.workEffortCategoryId,
            row.description || row.workEffortCategoryId
        ])
    )
}
const linesOf = workingScheduleId => rows(LINE, {workingScheduleId}).filter(row => !voided(row))
// a schedule's revision: the later change of it and its lines, what a change of either names
const scheduleRevision = workingScheduleId =>
    String(Math.max(stampOf(one(SCHEDULE, {workingScheduleId})), ...rows(LINE, {workingScheduleId}).map(stampOf)))
function checkRevision(workingScheduleId, expected) {
    const revision = scheduleRevision(workingScheduleId)
    if (text(expected) !== revision)
        denied("REVISION_CHANGED", "This schedule changed since you read it; open it again (revision " + revision + ")")
}
// the hours of a week of the lines in effect at a time, by the clock
const weeklyHours = (lines, at) => round(lines.filter(line => openAt(line, at)).reduce((sum, line) => sum + lineHours(line), 0))
const assignedEver = workingScheduleId => find(ASSIGNMENT).condition("workingScheduleId", workingScheduleId).count() > 0

// ===== checks for assign#Schedule (Employment.js) =====
// A schedule of the employer in effect on the date (an employment follows only its employer's schedules).
function checkAssignable(workingScheduleId, organizationPartyId, at) {
    const row = one(SCHEDULE, {workingScheduleId})
    if (!row || row.organizationPartyId !== organizationPartyId)
        denied(
            "SCHEDULE_OUTSIDE",
            "The schedule is not one of " +
                (people.organizationNames([organizationPartyId])[organizationPartyId] || organizationPartyId)
        )
    if (!openAt(row, at))
        denied("SCHEDULE_NOT_IN_EFFECT", (row.scheduleName || workingScheduleId) + " is not in effect on that date")
    return row
}
// A holiday calendar of the employer or shared by every employer.
function checkCalendar(holidayCategoryId, organizationPartyId) {
    const row = one(CATEGORY, {workEffortCategoryId: holidayCategoryId})
    if (!row || row.categoryTypeEnumId !== "WcatHoliday" || (row.ownerPartyId && row.ownerPartyId !== organizationPartyId))
        denied("CALENDAR_UNAVAILABLE", "Holiday calendar " + holidayCategoryId + " is not available")
    return row
}

// ===== find#Schedules and get#Schedule =====
function scheduleRow(userScope, row, lines, at, assignedCounts) {
    const names = people.organizationNames([row.organizationPartyId])
    const state = stateOf(row, at)
    return {
        workingScheduleId: row.workingScheduleId,
        scheduleName: row.scheduleName || row.workingScheduleId,
        organizationPartyId: row.organizationPartyId,
        organizationName: names[row.organizationPartyId] || row.organizationPartyId || "",
        timeZone: row.timeZone || "",
        holidayCategoryId: row.holidayCategoryId || null,
        holidayCalendarName: row.holidayCategoryId ? calendarNames([row.holidayCategoryId])[row.holidayCategoryId] || "" : "",
        description: row.description || "",
        weeklyHours: weeklyHours(lines, Math.max(at, ms(row.fromDate) ?? -Infinity)),
        fromDateText: dateText(row.fromDate),
        thruDateText: dateText(row.thruDate),
        state,
        stateText: stateTexts[state],
        assignedCount: assignedCounts ? assignedCounts[row.workingScheduleId] || 0 : null,
        canEdit: canEditAt(userScope, row.organizationPartyId),
        revision: scheduleRevision(row.workingScheduleId)
    }
}
// find#Schedules: the schedules the caller reads, by name, of an employer (organizationPartyId, ORGANIZATION_DENIED outside the
// scope), in effect on asOfDate unless includeEnded; each with its weekly hours and, for an HR reader, how many follow it now or
// later. Paged.
function findSchedules(p) {
    const userScope = scopeFor("Working schedules")
    if (p.organizationPartyId) people.requireOrganization(userScope, p.organizationPartyId)
    const at = p.asOfDate ? people.asOfMillis(p.asOfDate) : nowMs()
    const factory = ec.entity.conditionFactory
    const reach = []
    const employers = staffEmployers(userScope).filter(id => !p.organizationPartyId || id === p.organizationPartyId)
    if (employers.length) reach.push(factory.makeCondition("organizationPartyId", "in", employers))
    const teamIds = teamScheduleIds(userScope)
    if (teamIds.length) reach.push(factory.makeCondition("workingScheduleId", "in", teamIds))
    if (!reach.length) return Object.assign(lib.pageList([], p, "schedules"), {schedules: []})
    let query = find(SCHEDULE).condition(factory.makeCondition(reach, "or"))
    if (p.organizationPartyId) query = query.condition("organizationPartyId", p.organizationPartyId)
    if (!truthy(p.includeEnded))
        query = query.condition(
            factory.makeCondition(
                factory.makeCondition("thruDate", "is-null", null),
                "or",
                factory.makeCondition("thruDate", "greater", stamp(at))
            )
        )
    const term = text(p.term)
    if (term)
        query = query.condition(
            factory.makeCondition(
                ["workingScheduleId", "scheduleName"].map(field =>
                    factory.makeCondition(field, "like", likeText(term)).ignoreCase()
                ),
                "or"
            )
        )
    const count = query.count()
    const paged = lib.page(query.orderBy(["scheduleName", "workingScheduleId"]), p, "schedules", count)
    const ids = paged.rows.map(row => row.workingScheduleId)
    const linesById = {}
    if (ids.length)
        for (const line of Array.from(find(LINE).condition("workingScheduleId", "in", ids).list()))
            if (!voided(line)) listIn(linesById, line.workingScheduleId).push(line)
    let counts = null
    if (hrEmployers(userScope).length && ids.length) {
        counts = {}
        for (const row of liveAssignments({workingScheduleId: ids}))
            if (hrEmployers(userScope).includes(row.organizationPartyId))
                counts[row.workingScheduleId] = (counts[row.workingScheduleId] || 0) + 1
    }
    const out = Object.assign({}, paged)
    delete out.rows
    out.schedules = paged.rows.map(row => scheduleRow(userScope, row, linesById[row.workingScheduleId] || [], at, counts))
    return out
}
function lineRow(line, at) {
    const state = stateOf(line, at)
    const start = minutesOf(line.startTime)
    const end = minutesOf(line.endTime)
    return {
        workingScheduleLineId: line.workingScheduleLineId,
        isoDay: Number(line.isoDay),
        dayText: dayTexts[Number(line.isoDay)] || "",
        startTime: start == null ? "" : timeText(start),
        endTime: end == null ? "" : timeText(end),
        nextDay: start != null && end != null && end <= start,
        breakMinutes: Number(line.breakMinutes || 0),
        hours: round(lineHours(line)),
        fromDateText: dateText(line.fromDate),
        thruDateText: dateText(line.thruDate),
        state,
        stateText: stateTexts[state]
    }
}
// The assignments of a schedule the caller may see: every one for an HR reader of its employer, else their reports'.
function assignmentRows(userScope, schedule) {
    const all = liveAssignments({workingScheduleId: schedule.workingScheduleId})
    const teamIds = userScope.capabilities.team ? teamEmploymentIds(userScope) : []
    const shown = hrEmployers(userScope).includes(schedule.organizationPartyId)
        ? all
        : all.filter(row => teamIds.includes(row.partyRelationshipId))
    const persons = people.personNames(unique(shown.map(row => row.partyId)))
    const calendars = calendarNames(shown.map(row => row.holidayCategoryId))
    const now = nowMs()
    return shown
        .map(row => ({
            employmentAssignmentId: row.employmentAssignmentId,
            partyRelationshipId: row.partyRelationshipId,
            partyId: row.partyId,
            personName: persons[row.partyId] || row.partyId,
            fromDateText: dateText(row.fromDate),
            thruDateText: dateText(row.thruDate),
            holidayCategoryId: row.holidayCategoryId || null,
            holidayCalendarName: row.holidayCategoryId ? calendars[row.holidayCategoryId] || "" : "",
            state: stateOf(row, now),
            stateText: stateTexts[stateOf(row, now)],
            revision: people.employmentRevision(row.partyRelationshipId)
        }))
        .sort((a, b) => a.personName.localeCompare(b.personName))
}
// get#Schedule: one schedule the caller reads, its lines (every dated line, those in effect on asOfDate, now or the schedule's start
// when later, first), its weekly hours then, and who follows it now or later (an HR reader of its employer; a manager their
// reports). RECORD_UNAVAILABLE outside the scope.
function getSchedule(p) {
    const userScope = scopeFor("A working schedule")
    const row = readableSchedule(userScope, p.workingScheduleId)
    const at = p.asOfDate ? people.asOfMillis(p.asOfDate) : Math.max(nowMs(), ms(row.fromDate) ?? -Infinity)
    const lines = linesOf(row.workingScheduleId)
    const lineRows = lines
        .map(line => lineRow(line, at))
        .sort(
            (a, b) =>
                (a.state === "current" ? 0 : a.state === "future" ? 1 : 2) -
                    (b.state === "current" ? 0 : b.state === "future" ? 1 : 2) ||
                a.isoDay - b.isoDay ||
                a.startTime.localeCompare(b.startTime)
        )
    const canSeeAssignments = hrEmployers(userScope).includes(row.organizationPartyId) || userScope.capabilities.team
    return {
        schedule: Object.assign(scheduleRow(userScope, row, lines, at, null), {
            assignedEver: assignedEver(row.workingScheduleId),
            canAssign: canEditAt(userScope, row.organizationPartyId)
        }),
        lines: lineRows,
        assignments: canSeeAssignments ? assignmentRows(userScope, row) : [],
        assignmentsShown: !!canSeeAssignments
    }
}

// ===== store#Schedule =====
// A new schedule of an employer, or a change of one: its name, description and holiday calendar (the employer's or a shared one),
// its zone while no one has followed it, its end. A copy (copyFromScheduleId, a schedule the caller reads) is a new schedule with
// the lines the copied one has in effect on its start. HR editors of the employer only.
function storeSchedule(p) {
    const userScope = editorScope("Changing a working schedule")
    const id = text(p.workingScheduleId)
    const calendarId = text(p.holidayCategoryId) || null
    const zone = text(p.timeZone) || null
    if (!id) {
        const source = text(p.copyFromScheduleId) ? readableSchedule(userScope, p.copyFromScheduleId) : null
        const organizationPartyId = text(p.organizationPartyId) || source?.organizationPartyId || null
        if (!organizationPartyId) denied("ORGANIZATION_REQUIRED", "Choose the employer")
        if (!canEditAt(userScope, organizationPartyId))
            denied("ORGANIZATION_DENIED", "Organization " + organizationPartyId + " is not available")
        const name = text(p.scheduleName)
        if (!name) denied("NAME_REQUIRED", "Name the schedule")
        const timeZone = zone || source?.timeZone || null
        if (!validZone(timeZone)) denied("ZONE_INVALID", "Choose a time zone")
        const holidayCategoryId = given(p.holidayCategoryId) ? calendarId : source?.holidayCategoryId || null
        if (holidayCategoryId) checkCalendar(holidayCategoryId, organizationPartyId)
        const fromMs = effective(p.fromDate)
        const created = call("create#" + SCHEDULE, {
            scheduleName: name,
            organizationPartyId,
            timeZone,
            holidayCategoryId,
            description: text(p.description) || null,
            fromDate: stamp(fromMs),
            copiedFromScheduleId: source?.workingScheduleId || null
        })
        if (source)
            for (const line of linesOf(source.workingScheduleId).filter(
                line => openAt(line, fromMs) || (ms(line.fromDate) ?? -Infinity) > fromMs
            ))
                call("create#" + LINE, {
                    workingScheduleId: created.workingScheduleId,
                    isoDay: line.isoDay,
                    startTime: line.startTime,
                    endTime: line.endTime,
                    breakMinutes: line.breakMinutes,
                    fromDate: stamp(Math.max(fromMs, ms(line.fromDate) ?? -Infinity)),
                    thruDate: line.thruDate
                })
        return {workingScheduleId: created.workingScheduleId, revision: scheduleRevision(created.workingScheduleId)}
    }
    const row = one(SCHEDULE, {workingScheduleId: id})
    if (!row || !canEditAt(userScope, row.organizationPartyId))
        denied("RECORD_UNAVAILABLE", "Working schedule " + id + " is not available")
    checkRevision(id, p.expectedRevision)
    if (text(p.organizationPartyId) && text(p.organizationPartyId) !== row.organizationPartyId)
        denied("OWNER_CHANGE", "A schedule stays its employer's; copy it to another")
    const changes = {workingScheduleId: id}
    const reason = text(p.changeReason) || null
    if (given(p.scheduleName)) {
        if (!text(p.scheduleName)) denied("NAME_REQUIRED", "Name the schedule")
        changes.scheduleName = text(p.scheduleName)
    }
    if (given(p.description)) changes.description = text(p.description) || null
    if (given(p.holidayCategoryId) && calendarId !== (row.holidayCategoryId || null)) {
        if (calendarId) checkCalendar(calendarId, row.organizationPartyId)
        changes.holidayCategoryId = calendarId
        changes.holidayCategoryId_changeReason = reason
    }
    if (zone && zone !== row.timeZone) {
        if (!validZone(zone)) denied("ZONE_INVALID", "Choose a time zone")
        if (assignedEver(id))
            denied("ZONE_IN_USE", "The zone of a schedule people have followed does not change; copy it instead")
        changes.timeZone = zone
    }
    if (truthy(p.end)) {
        const thruMs = effective(p.thruDate)
        if (thruMs < todayStart()) denied("DATE_PAST", "A schedule ends today or later")
        const after = liveAssignments({workingScheduleId: id}).filter(
            assignment => (ms(assignment.thruDate) ?? Infinity) > thruMs
        )
        if (after.length)
            denied(
                "SCHEDULE_ASSIGNED",
                after.length +
                    " employment" +
                    (after.length === 1 ? " follows" : "s follow") +
                    " this schedule after that date; assign another first"
            )
        changes.thruDate = stamp(Math.max(thruMs, ms(row.fromDate) ?? -Infinity))
        changes.thruDate_changeReason = reason
    }
    if (Object.keys(changes).length > 1) call("update#" + SCHEDULE, changes)
    return {workingScheduleId: id, revision: scheduleRevision(id)}
}

// ===== store#ScheduleLine =====
// a line as an interval of the week in minutes from Monday 00:00
function weekInterval(line) {
    const start = (Number(line.isoDay) - 1) * 24 * 60 + (minutesOf(line.startTime) ?? 0)
    return [start, start + lineMinutes(line)]
}
function intervalsOverlap(a, b) {
    const [as, ae] = weekInterval(a)
    const [bs, be] = weekInterval(b)
    // the week wraps: a Sunday night shift runs into Monday
    return [0, weekMinutes, -weekMinutes].some(shift => as < be + shift && bs + shift < ae)
}
const datesOverlap = (fromMs, thruMs, line) =>
    (ms(line.fromDate) ?? -Infinity) < (thruMs ?? Infinity) && (ms(line.thruDate) ?? Infinity) > fromMs
function checkLine(line, fromMs, thruMs, others) {
    const day = Number(line.isoDay)
    if (!Number.isInteger(day) || day < 1 || day > 7) denied("DAY_INVALID", "Choose a day of the week")
    const start = minutesOf(line.startTime)
    const end = minutesOf(line.endTime)
    if (start == null || end == null) denied("TIME_INVALID", "Times are HH:mm, from 00:00 to 23:59")
    const breakMinutes = Number(line.breakMinutes || 0)
    if (!Number.isInteger(breakMinutes) || breakMinutes < 0 || breakMinutes >= lineMinutes(line))
        denied("BREAK_INVALID", "The break is shorter than the interval")
    const clash = others.find(other => datesOverlap(fromMs, thruMs, other) && intervalsOverlap(line, other))
    if (clash)
        denied(
            "OVERLAP",
            "It overlaps " + dayTexts[Number(clash.isoDay)] + " " + clash.startTime + "–" + clash.endTime + " in effect then"
        )
}
// A line added to a schedule, changed or ended from a date (fromDate: the start of that day; empty, today, or the schedule's start
// when it starts later). A change before the line's start changes it in place; a later one ends it then and starts another with
// the new values, so a past week keeps its hours. An end on or before its start voids it (it never took effect). The schedule's
// revision is named; lines in effect at the same time never overlap (OVERLAP). HR editors of the employer only.
function storeScheduleLine(p) {
    const userScope = editorScope("Changing a working schedule")
    const id = text(p.workingScheduleId)
    const schedule = id ? one(SCHEDULE, {workingScheduleId: id}) : null
    if (!schedule || !canEditAt(userScope, schedule.organizationPartyId))
        denied("RECORD_UNAVAILABLE", "Working schedule " + id + " is not available")
    checkRevision(id, p.expectedRevision)
    const scheduleFrom = ms(schedule.fromDate) ?? -Infinity
    const fromMs = p.fromDate ? ec.user.timestampMillis(p.fromDate) : Math.max(todayStart(), scheduleFrom)
    if ((ms(schedule.thruDate) ?? Infinity) <= fromMs) denied("DATE_OUTSIDE", "The schedule has ended by that date")
    const lines = linesOf(id)
    const lineId = text(p.workingScheduleLineId)
    const values = {
        isoDay: given(p.isoDay) && text(p.isoDay) !== "" ? Number(p.isoDay) : null,
        startTime: given(p.startTime) ? text(p.startTime) : null,
        endTime: given(p.endTime) ? text(p.endTime) : null,
        breakMinutes: given(p.breakMinutes) && text(p.breakMinutes) !== "" ? Number(p.breakMinutes) : null
    }
    const normalize = line => {
        const start = minutesOf(line.startTime)
        const end = minutesOf(line.endTime)
        return Object.assign({}, line, {
            startTime: start == null ? line.startTime : timeText(start),
            endTime: end == null ? line.endTime : timeText(end)
        })
    }
    if (!lineId) {
        const line = normalize({
            isoDay: values.isoDay,
            startTime: values.startTime,
            endTime: values.endTime,
            breakMinutes: values.breakMinutes ?? 0
        })
        const start = Math.max(fromMs, scheduleFrom)
        checkLine(line, start, ms(schedule.thruDate), lines)
        const created = call("create#" + LINE, Object.assign({workingScheduleId: id, fromDate: stamp(start)}, line))
        return {workingScheduleLineId: created.workingScheduleLineId, revision: scheduleRevision(id)}
    }
    const old = lines.find(line => line.workingScheduleLineId === lineId)
    if (!old) denied("RECORD_UNAVAILABLE", "Schedule line " + lineId + " is not available")
    const oldFrom = ms(old.fromDate) ?? -Infinity
    if ((ms(old.thruDate) ?? Infinity) <= fromMs) denied("LINE_ENDED", "The line has ended by that date")
    const reason = text(p.changeReason) || null
    if (truthy(p.end)) {
        call("update#" + LINE, {
            workingScheduleLineId: lineId,
            thruDate: stamp(Math.max(fromMs, oldFrom)),
            thruDate_changeReason: reason
        })
        return {workingScheduleLineId: lineId, revision: scheduleRevision(id)}
    }
    const line = normalize({
        isoDay: values.isoDay ?? old.isoDay,
        startTime: values.startTime ?? old.startTime,
        endTime: values.endTime ?? old.endTime,
        breakMinutes: values.breakMinutes ?? old.breakMinutes ?? 0
    })
    const others = lines.filter(other => other.workingScheduleLineId !== lineId)
    if (fromMs <= oldFrom) {
        checkLine(line, oldFrom, ms(old.thruDate), others)
        call("update#" + LINE, Object.assign({workingScheduleLineId: lineId}, line))
        return {workingScheduleLineId: lineId, revision: scheduleRevision(id)}
    }
    checkLine(line, fromMs, ms(old.thruDate), others)
    call("update#" + LINE, {workingScheduleLineId: lineId, thruDate: stamp(fromMs), thruDate_changeReason: reason || "Changed"})
    const created = call(
        "create#" + LINE,
        Object.assign({workingScheduleId: id, fromDate: stamp(fromMs), thruDate: old.thruDate}, line)
    )
    return {workingScheduleLineId: created.workingScheduleLineId, revision: scheduleRevision(id)}
}

// ===== holiday calendars =====
function calendarRow(userScope, row, counts) {
    const names = row.ownerPartyId ? people.organizationNames([row.ownerPartyId]) : {}
    return {
        holidayCategoryId: row.workEffortCategoryId,
        calendarName: row.description || row.workEffortCategoryId,
        organizationPartyId: row.ownerPartyId || null,
        organizationName: row.ownerPartyId ? names[row.ownerPartyId] || row.ownerPartyId : "Shared",
        holidayCount: counts[row.workEffortCategoryId] || 0,
        canEdit: canEditCalendar(userScope, row),
        revision: String(stampOf(row))
    }
}
// get#Holidays: the holiday calendars a staff reader reads (shared, and their employers' own; organizationPartyId narrows to an
// employer's and the shared ones) with how many holidays each has from fromDate through thruDate (this year when empty), and the
// holidays of those days of one calendar (holidayCategoryId) or of all of them, by day.
function getHolidays(p) {
    const userScope = people.scopeOf()
    if (!userScope.capabilities.staff) denied("PERMISSION_DENIED", "Holiday calendars need a People read of an employer")
    if (p.organizationPartyId) people.requireOrganization(userScope, p.organizationPartyId)
    const year = dayIn(nowMs(), null).slice(0, 4)
    const fromDay = p.fromDate ? dayIn(ec.user.timestampMillis(p.fromDate), null) : year + "-01-01"
    const thruDay = p.thruDate ? dayIn(ec.user.timestampMillis(p.thruDate), null) : year + "-12-31"
    const factory = ec.entity.conditionFactory
    const owners = staffEmployers(userScope).filter(id => !p.organizationPartyId || id === p.organizationPartyId)
    const calendars = Array.from(
        find(CATEGORY)
            .condition("categoryTypeEnumId", "WcatHoliday")
            .condition(
                factory.makeCondition(
                    [factory.makeCondition("ownerPartyId", "is-null", null)].concat(
                        owners.length ? [factory.makeCondition("ownerPartyId", "in", owners)] : []
                    ),
                    "or"
                )
            )
            .orderBy("description")
            .list()
    )
    const calendarIds = calendars.map(row => row.workEffortCategoryId)
    const wanted = text(p.holidayCategoryId)
    if (wanted && !calendarIds.includes(wanted)) denied("RECORD_UNAVAILABLE", "Holiday calendar " + wanted + " is not available")
    const holidays = calendarIds.length
        ? Array.from(
              find("mantle.work.effort.WorkEffortAndCategoryAppl")
                  .condition("purposeEnumId", "WepHoliday")
                  .condition("workEffortCategoryId", "in", calendarIds)
                  .condition("allDayStart", "greater-equals", fromDay)
                  .condition("allDayStart", "less-equals", thruDay)
                  .orderBy(["allDayStart", "workEffortName"])
                  .list()
          )
        : []
    const counts = {}
    for (const row of holidays) counts[row.workEffortCategoryId] = (counts[row.workEffortCategoryId] || 0) + 1
    const byId = Object.fromEntries(calendars.map(row => [row.workEffortCategoryId, row]))
    const today = dayIn(nowMs(), null)
    return {
        calendars: calendars.map(row => calendarRow(userScope, row, counts)),
        holidays: holidays
            .filter(row => !wanted || row.workEffortCategoryId === wanted)
            .map(row => {
                const day = lib.calendarDateText(row.allDayStart)
                const calendar = byId[row.workEffortCategoryId]
                return {
                    workEffortId: row.workEffortId,
                    holidayCategoryId: row.workEffortCategoryId,
                    calendarName: calendar?.description || row.workEffortCategoryId,
                    workEffortName: row.workEffortName || "",
                    day,
                    dayText: day,
                    weekdayText: dayTexts[isoDayOf(day)],
                    past: day < today,
                    canEdit: canEditCalendar(userScope, calendar) && day >= today,
                    revision: String(stampOf(one(WORK_EFFORT, {workEffortId: row.workEffortId})))
                }
            }),
        fromDay,
        thruDay
    }
}
// store#HolidayCalendar: a new calendar of an employer (organizationPartyId, an HR editor's) or shared by every employer (none:
// PEOPLE_ALL_ORGANIZATIONS too), or a calendar's new name at its revision.
function storeHolidayCalendar(p) {
    const userScope = editorScope("Changing a holiday calendar")
    const name = text(p.calendarName)
    if (!name) denied("NAME_REQUIRED", "Name the calendar")
    const id = text(p.holidayCategoryId)
    if (!id) {
        const owner = text(p.organizationPartyId) || null
        if (owner ? !userScope.organizationPartyIds.includes(owner) : !userScope.capabilities.allOrganizations)
            denied(
                owner ? "ORGANIZATION_DENIED" : "PERMISSION_DENIED",
                owner ? "Organization " + owner + " is not available" : "A shared calendar needs PEOPLE_ALL_ORGANIZATIONS"
            )
        const created = call("create#" + CATEGORY, {categoryTypeEnumId: "WcatHoliday", description: name, ownerPartyId: owner})
        return {holidayCategoryId: created.workEffortCategoryId}
    }
    const row = one(CATEGORY, {workEffortCategoryId: id})
    if (!calendarReadable(userScope, row) || !canEditCalendar(userScope, row))
        denied("RECORD_UNAVAILABLE", "Holiday calendar " + id + " is not available")
    if (text(p.expectedRevision) !== String(stampOf(row)))
        denied("REVISION_CHANGED", "This calendar changed since you read it; open it again (revision " + stampOf(row) + ")")
    call("update#" + CATEGORY, {workEffortCategoryId: id, description: name})
    return {holidayCategoryId: id}
}
// store#Holiday: a holiday added to a calendar the caller changes (its name and day), a holiday's new name or day at its revision,
// or a holiday removed (remove). A holiday whose day has passed is kept as it is (HOLIDAY_PAST), and a day is a calendar's
// holiday once (DAY_TAKEN).
function storeHoliday(p) {
    const userScope = editorScope("Changing a holiday")
    const id = text(p.workEffortId)
    const dayOf = value => (value == null || value === "" ? "" : dayIn(ec.user.timestampMillis(value), null))
    const today = dayIn(nowMs(), null)
    if (!id) {
        const calendarId = text(p.holidayCategoryId)
        const calendar = calendarId ? one(CATEGORY, {workEffortCategoryId: calendarId}) : null
        if (!calendarReadable(userScope, calendar) || !canEditCalendar(userScope, calendar))
            denied("RECORD_UNAVAILABLE", "Holiday calendar " + calendarId + " is not available")
        const name = text(p.workEffortName)
        if (!name) denied("NAME_REQUIRED", "Name the holiday")
        const day = dayOf(p.holidayDate)
        if (!day) denied("DATE_REQUIRED", "Choose the day")
        checkDayFree(calendarId, day, null)
        const created = call("create#" + WORK_EFFORT, {
            workEffortTypeEnumId: "WetEvent",
            purposeEnumId: "WepHoliday",
            workEffortName: name,
            allDayStart: day
        })
        call("create#" + CATEGORY_APPL, {workEffortId: created.workEffortId, workEffortCategoryId: calendarId})
        return {workEffortId: created.workEffortId}
    }
    const appl = rows(CATEGORY_APPL, {workEffortId: id})
        .map(row => one(CATEGORY, {workEffortCategoryId: row.workEffortCategoryId}))
        .find(row => row && row.categoryTypeEnumId === "WcatHoliday")
    const holiday = one(WORK_EFFORT, {workEffortId: id})
    if (
        !holiday ||
        holiday.purposeEnumId !== "WepHoliday" ||
        !appl ||
        !calendarReadable(userScope, appl) ||
        !canEditCalendar(userScope, appl)
    )
        denied("RECORD_UNAVAILABLE", "Holiday " + id + " is not available")
    if (text(p.expectedRevision) !== String(stampOf(holiday)))
        denied("REVISION_CHANGED", "This holiday changed since you read it; open it again (revision " + stampOf(holiday) + ")")
    const currentDay = lib.calendarDateText(holiday.allDayStart)
    if (currentDay < today) denied("HOLIDAY_PAST", "A holiday that has passed stays as it was")
    if (truthy(p.remove)) {
        find(CATEGORY_APPL, {workEffortId: id}).deleteAll()
        call("delete#" + WORK_EFFORT, {workEffortId: id})
        return {workEffortId: id}
    }
    const changes = {workEffortId: id}
    if (given(p.workEffortName)) {
        if (!text(p.workEffortName)) denied("NAME_REQUIRED", "Name the holiday")
        changes.workEffortName = text(p.workEffortName)
    }
    const day = dayOf(p.holidayDate)
    if (day && day !== currentDay) {
        if (day < today) denied("HOLIDAY_PAST", "A holiday moves to today or later")
        checkDayFree(appl.workEffortCategoryId, day, id)
        changes.allDayStart = day
    }
    call("update#" + WORK_EFFORT, changes)
    return {workEffortId: id}
}
function checkDayFree(holidayCategoryId, day, exceptId) {
    const taken = Array.from(
        find("mantle.work.effort.WorkEffortAndCategoryAppl")
            .condition("purposeEnumId", "WepHoliday")
            .condition("workEffortCategoryId", holidayCategoryId)
            .condition("allDayStart", day)
            .list()
    ).find(row => row.workEffortId !== exceptId)
    if (taken) denied("DAY_TAKEN", (taken.workEffortName || "A holiday") + " is on that day already")
}
// The holidays of calendars on days: {holidayCategoryId: {day: name}}.
function holidaysOf(holidayCategoryIds, days) {
    const ids = unique((holidayCategoryIds || []).filter(Boolean))
    const out = {}
    if (!ids.length || !days.length) return out
    for (const row of Array.from(
        find("mantle.work.effort.WorkEffortAndCategoryAppl")
            .condition("purposeEnumId", "WepHoliday")
            .condition("workEffortCategoryId", "in", ids)
            .condition("allDayStart", "in", days)
            .list()
    )) {
        if (!out[row.workEffortCategoryId]) out[row.workEffortCategoryId] = {}
        out[row.workEffortCategoryId][lib.calendarDateText(row.allDayStart)] = row.workEffortName || "Holiday"
    }
    return out
}

// ===== planned hours (get#PartyCapacity) =====
// The days of people followed by a schedule: {partyId: {day: {hours, workingScheduleId, holidayCategoryIds}}}, each day planned
// by the schedule in effect at its noon in the schedule's zone, its hours the actual length of the intervals starting that day
// less their breaks (one employment's intervals overlapping another's count once). People with no schedule then are left out.
function scheduledDays(partyIds, days) {
    const out = {}
    const parties = unique((partyIds || []).filter(Boolean))
    if (!parties.length || !days.length) return out
    const lowMs = instantIn(addDay(days[0], -2), "00:00", null)
    const highMs = instantIn(addDay(days[days.length - 1], 3), "00:00", null)
    const factory = ec.entity.conditionFactory
    const assignments = Array.from(
        find(ASSIGNMENT)
            .condition("partyId", "in", parties)
            .condition("isPrimary", "Y")
            .condition("workingScheduleId", "is-not-null", null)
            .condition("fromDate", "less", stamp(highMs))
            .condition(
                factory.makeCondition(
                    factory.makeCondition("thruDate", "is-null", null),
                    "or",
                    factory.makeCondition("thruDate", "greater", stamp(lowMs))
                )
            )
            .list()
    ).filter(row => !voided(row))
    if (!assignments.length) return out
    const scheduleIds = unique(assignments.map(row => row.workingScheduleId))
    const schedulesById = Object.fromEntries(
        Array.from(find(SCHEDULE).condition("workingScheduleId", "in", scheduleIds).list()).map(row => [
            row.workingScheduleId,
            row
        ])
    )
    const linesById = {}
    for (const line of Array.from(find(LINE).condition("workingScheduleId", "in", scheduleIds).list()))
        if (!voided(line)) listIn(linesById, line.workingScheduleId).push(line)
    const byParty = {}
    for (const row of assignments) listIn(byParty, row.partyId).push(row)
    for (const [partyId, own] of Object.entries(byParty)) {
        const planned = {}
        const intervals = []
        for (const assignment of own) {
            const schedule = schedulesById[assignment.workingScheduleId]
            if (!schedule) continue
            const zone = validZone(schedule.timeZone) ? schedule.timeZone : null
            const calendarId = assignment.holidayCategoryId || schedule.holidayCategoryId || null
            const lines = linesById[schedule.workingScheduleId] || []
            for (const day of days) {
                const noonMs = instantIn(day, "12:00", zone)
                if (!openAt(assignment, noonMs) || !openAt(schedule, noonMs)) continue
                if (!planned[day])
                    planned[day] = {hours: 0, workingScheduleId: schedule.workingScheduleId, holidayCategoryIds: []}
                const entry = planned[day]
                if (calendarId && !entry.holidayCategoryIds.includes(calendarId)) entry.holidayCategoryIds.push(calendarId)
                const isoDay = isoDayOf(day)
                for (const line of lines) {
                    if (Number(line.isoDay) !== isoDay || !openAt(line, noonMs)) continue
                    const start = minutesOf(line.startTime)
                    const end = minutesOf(line.endTime)
                    if (start == null || end == null) continue
                    const startMs = instantIn(day, timeText(start), zone)
                    const endMs = instantIn(end > start ? day : addDay(day), timeText(end), zone)
                    if (startMs == null || endMs == null || endMs <= startMs) continue
                    intervals.push({day, startMs, endMs, breakMs: Number(line.breakMinutes || 0) * minuteMs})
                }
            }
        }
        // the union of the intervals: an overlap counts once, on the day of the first
        intervals.sort((a, b) => a.startMs - b.startMs)
        const merged = []
        for (const interval of intervals) {
            const last = merged[merged.length - 1]
            if (last && interval.startMs < last.endMs) {
                last.endMs = Math.max(last.endMs, interval.endMs)
                last.breakMs += interval.breakMs
            } else merged.push(Object.assign({}, interval))
        }
        for (const interval of merged)
            planned[interval.day].hours += Math.max(0, interval.endMs - interval.startMs - interval.breakMs) / hourMs
        for (const entry of Object.values(planned)) entry.hours = round(entry.hours)
        if (Object.keys(planned).length) out[partyId] = planned
    }
    return out
}

// ===== get#CapacityPreview =====
// A person's capacity from fromDate through thruDate (at most 62 days) as Projects and timesheets read it
// (ResourceServices.get#PartyCapacity), each day with the schedule that planned it: for an HR reader of an employer of theirs or
// their manager. RECORD_UNAVAILABLE for anyone else.
function capacityPreview(p) {
    const userScope = scopeFor("A capacity preview")
    const partyId = text(p.partyId)
    const admitted = partyId ? people.checkedAccess(userScope, partyId, nowMs(), true) : {kinds: []}
    const asStaff = admitted.kinds.includes("staff") && userScope.capabilities.hrView
    if (!asStaff && !admitted.kinds.includes("team")) denied("RECORD_UNAVAILABLE", "Person " + partyId + " is not available")
    const fromDay = p.fromDate ? dayIn(ec.user.timestampMillis(p.fromDate), null) : dayIn(nowMs(), null)
    let thruDay = p.thruDate ? dayIn(ec.user.timestampMillis(p.thruDate), null) : addDay(fromDay, 13)
    if (thruDay < fromDay) denied("DATES_INVALID", "The last day is on or after the first")
    if (thruDay > addDay(fromDay, previewDays - 1)) thruDay = addDay(fromDay, previewDays - 1)
    const entry =
        Array.from(
            call("mantle.work.ResourceServices.get#PartyCapacity", {partyId, fromDate: fromDay, thruDate: thruDay})
                .capacityList || []
        )[0] || null
    if (!entry) return {partyId, personName: people.personNames([partyId])[partyId] || partyId, source: "", days: [], weeks: []}
    const names = scheduleNames(Array.from(entry.dayList || []).map(row => row.workingScheduleId))
    return {
        partyId,
        personName: people.personNames([partyId])[partyId] || partyId,
        source: entry.source,
        sourceText:
            entry.source === "schedule"
                ? "The working schedule"
                : entry.source === "available"
                  ? "Their own working hours (calendar settings)"
                  : "The timesheet policy's working week",
        base: entry.base,
        capacity: entry.capacity,
        days: Array.from(entry.dayList || []).map(row => ({
            day: row.day,
            weekdayText: dayTexts[Number(row.isoDay)] || "",
            base: row.base,
            holiday: row.holiday || "",
            leave: row.leave,
            capacity: row.capacity,
            scheduleName: row.workingScheduleId ? names[row.workingScheduleId] || "" : ""
        })),
        weeks: Array.from(entry.weekList || [])
    }
}

const operations = {
    findSchedules,
    getSchedule,
    storeSchedule,
    storeScheduleLine,
    getHolidays,
    storeHolidayCalendar,
    storeHoliday,
    capacityPreview
}
function run(op, p) {
    if (!Object.hasOwn(operations, op)) throw new Error("Unknown schedule operation " + op)
    return operations[op](p || {})
}
;({
    execute: run,
    // for Employment.js (assign#Schedule) and the employee record
    checkAssignable,
    checkCalendar,
    scheduleNames,
    // for mantle.work.ResourceServices.get#PartyCapacity
    scheduledDays,
    holidaysOf
})
