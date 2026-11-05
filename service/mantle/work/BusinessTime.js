// Business time on a calendar (impl-customer-service P4, F13, F65; design-drawers-commons §7; Manufacturing's work-center
// time, ProductionCalendar.js, calls the same functions). A schedule is a mantle.work.calendar.Calendar with a time zone:
// its working hours are its WetAvailable work efforts (a weekly series each, expanded by get#EventInstances), less the
// holidays of the calendar and of its organization. One holiday convention: a holiday is an all-day WepHoliday work effort
// owned by the organization (WorkEffort.ownerPartyId, the day in allDayStart), as get#NextBusinessDay reads them; a
// WepHoliday event in the schedule's own calendar counts for that calendar too. Holiday categories (workEffortCategoryIds)
// are not read. A schedule with no working hours works around the clock, and says so (configured false). Every interval is
// epoch millis [from, thru); a holiday's day starts in the schedule's zone (Calendar.timeZone, else the user's), and a
// recurring series expands in its recurrence's zone. The module keeps no state between calls: a caller makes a context
// (forCall) for its caches.
//
// A party's working hours (store#WorkingHours): a person's own are a WetAvailable of the person's (as Commons' Preferences
// keep them, for free/busy); a team's or another party's are its schedule calendar, a resource calendar owned by the party,
// holding the WetAvailable series. A change from a date ends the series in effect (its rule's UNTIL) and starts another, so
// the hours of a past day stay as they were; a change with no date replaces the series in effect.
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const facilityScope = ec.resource.script("component://mr-mantle/service/mantle/facility/FacilityScope.js")
const {find, one, rows, ms, denied} = lib

const WORK = "mantle.work.effort.WorkEffort"
const CALENDAR = "mantle.work.calendar.Calendar"
const MEMBER = "mantle.work.calendar.CalendarWorkEffort"
const RECURRENCE = "mantle.work.effort.WorkEffortRecurrence"
const minuteMs = 60000
const hourMs = 3600000
const dayMs = 24 * hourMs
const dayCodes = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"]

const blank = value => value == null || String(value).trim() === ""
const dayOf = millis => ec.l10n.format(new Date(Number(millis)), "yyyy-MM-dd")
const dayStart = day => ms(ec.l10n.parseTimestamp(String(day).slice(0, 10) + " 00:00:00.000", "yyyy-MM-dd HH:mm:ss.SSS"))
const addDay = (day, count = 1) => {
    const [y, m, d] = String(day).slice(0, 10).split("-").map(Number)
    // calendar arithmetic on a UTC date, written back as yyyy-MM-dd
    const date = new Date(Date.UTC(y, m - 1, d + count))
    return [
        date.getUTCFullYear(),
        String(date.getUTCMonth() + 1).padStart(2, "0"),
        String(date.getUTCDate()).padStart(2, "0")
    ].join("-")
}
const weekdayOf = day => {
    const [y, m, d] = String(day).slice(0, 10).split("-").map(Number)
    return new Date(Date.UTC(y, m - 1, d)).getUTCDay()
}
// The day (yyyy-MM-dd) and wall time of an instant in a zone (none is the user's).
const dayIn = (millis, zone) => ec.l10n.format(new Date(Number(millis)), "yyyy-MM-dd", null, zone || null)
const wallIn = (millis, zone) => ec.l10n.format(new Date(Number(millis)), "yyyy-MM-dd HH:mm", null, zone || null)
// The start of a day (yyyy-MM-dd) in a time zone (an IANA name; none is the user's): the zone's offset read from the wall
// time it formats, twice so a day that starts at a daylight saving change lands on it.
function dayStartIn(day, zone) {
    if (!zone) return dayStart(day)
    const [y, m, d] = String(day).slice(0, 10).split("-").map(Number)
    const utc = Date.UTC(y, m - 1, d)
    const offsetAt = millis => {
        const [date, clock] = ec.l10n.format(new Date(millis), "yyyy-MM-dd HH:mm:ss", null, zone).split(" ")
        const [wy, wm, wd] = date.split("-").map(Number)
        const [hh, mm, ss] = clock.split(":").map(Number)
        return Date.UTC(wy, wm - 1, wd, hh, mm, ss) - millis
    }
    const first = utc - offsetAt(utc)
    return utc - offsetAt(first)
}
// A wall time (yyyy-MM-dd and HH:mm) in a zone as epoch millis: the day's start there plus the clock, read again so a
// clock after a daylight saving change keeps its wall time.
function wallTimeIn(day, clock, zone) {
    const [hh, mm] = String(clock).split(":").map(Number)
    const guess = dayStartIn(day, zone) + (hh * 60 + mm) * minuteMs
    const [, shown] = wallIn(guess, zone).split(" ")
    const [sh, sm] = shown.split(":").map(Number)
    return guess + (hh * 60 + mm - (sh * 60 + sm)) * minuteMs
}

// ===== intervals =====
// Sorted and merged.
function merge(list) {
    const sorted = list.filter(row => row[1] > row[0]).sort((a, b) => a[0] - b[0])
    const out = []
    for (const [from, thru] of sorted) {
        const last = out[out.length - 1]
        if (last && from <= last[1]) last[1] = Math.max(last[1], thru)
        else out.push([from, thru])
    }
    return out
}
// What of a is not in b (both merged).
function subtract(a, b) {
    const out = []
    for (const [from, thru] of a) {
        let start = from
        for (const [bFrom, bThru] of b) {
            if (bThru <= start || bFrom >= thru) continue
            if (bFrom > start) out.push([start, bFrom])
            start = Math.max(start, bThru)
            if (start >= thru) break
        }
        if (start < thru) out.push([start, thru])
    }
    return out
}
// What of a is in b (both merged).
function intersect(a, b) {
    const out = []
    for (const [from, thru] of a)
        for (const [bFrom, bThru] of b) {
            const start = Math.max(from, bFrom)
            const end = Math.min(thru, bThru)
            if (end > start) out.push([start, end])
        }
    return merge(out)
}
const length = list => list.reduce((sum, [from, thru]) => sum + (thru - from), 0)
const hoursOf = list => length(list) / hourMs

// ===== a schedule's time =====
function forCall() {
    return {calendars: new Map()}
}
// A schedule's work hours from fromMs to thruMs, less holidays: {configured, work, holidays: [{fromMs, thruMs, name}]}.
// schedule: {key (for the cache), calendarId, timeZone, organizationPartyId}.
function calendarOf(ctx, schedule, fromMs, thruMs) {
    const key = (schedule.key || schedule.calendarId || "_NA_") + "|" + fromMs + "|" + thruMs
    if (ctx.calendars.has(key)) return ctx.calendars.get(key)
    const holidays = []
    let work = []
    let configured = false
    const efforts = schedule.calendarId
        ? (() => {
              const ids = rows(MEMBER, {calendarId: schedule.calendarId}).map(row => row.workEffortId)
              if (!ids.length) return []
              return Array.from(find(WORK).condition("workEffortId", "in", ids).list()).filter(
                  row =>
                      row.statusId !== "WeCancelled" &&
                      (row.workEffortTypeEnumId === "WetAvailable" || row.purposeEnumId === "WepHoliday")
              )
          })()
        : []
    if (efforts.length) {
        const out = lib.call("mantle.work.EventServices.get#EventInstances", {
            workEffortList: efforts.map(row => lib.map(row)),
            rangeStart: new Date(fromMs - dayMs),
            rangeEnd: new Date(thruMs + dayMs)
        })
        for (const instance of Array.from(out.instanceList || [])) {
            const holiday = instance.workEffort?.purposeEnumId === "WepHoliday"
            const span = instance.allDay
                ? [dayStartIn(instance.startDay, schedule.timeZone), dayStartIn(instance.endDay, schedule.timeZone)]
                : [Number(instance.start), instance.end == null ? Number(instance.start) : Number(instance.end)]
            if (holiday) holidays.push({fromMs: span[0], thruMs: span[1], name: instance.workEffort?.workEffortName || "Holiday"})
            else {
                configured = true
                work.push(span)
            }
        }
    }
    // the organization's holidays (an all-day WepHoliday of its own)
    const firstDay = dayOf(fromMs - dayMs)
    const lastDay = dayOf(thruMs + dayMs)
    for (const holiday of Array.from(
        find(WORK)
            .condition("purposeEnumId", "WepHoliday")
            .condition("ownerPartyId", schedule.organizationPartyId || "_NA_")
            .condition("allDayStart", "greater-equals", firstDay)
            .condition("allDayStart", "less-equals", lastDay)
            .list()
    )) {
        const day = lib.calendarDateText(holiday.allDayStart)
        holidays.push({
            fromMs: dayStartIn(day, schedule.timeZone),
            thruMs: dayStartIn(addDay(day), schedule.timeZone),
            name: holiday.workEffortName || "Holiday"
        })
    }
    if (!configured) work = [[fromMs, thruMs]]
    const result = {
        configured,
        work: subtract(merge(work), merge(holidays.map(row => [row.fromMs, row.thruMs]))),
        holidays: holidays.sort((a, b) => a.fromMs - b.fromMs)
    }
    ctx.calendars.set(key, result)
    return result
}

// The schedule calendar of a party (a team's working hours): its resource calendar of working hours, the first made.
function scheduleCalendarId(partyId) {
    if (!partyId) return null
    const calendar = Array.from(
        find(CALENDAR, {ownerPartyId: partyId, calendarKindEnumId: "CalkResource"}).orderBy("createdDate").limit(1).list()
    )[0]
    return calendar?.calendarId || null
}
// The schedule a business time is counted on: a calendar given, else the party's schedule calendar; its zone (the
// calendar's, else the one given, else the user's); its organization for the holidays (the one given, else the calendar
// owner's owner organization, else the owner).
function scheduleOf(p) {
    const calendarId = p.calendarId || scheduleCalendarId(p.partyId) || null
    const calendar = calendarId ? one(CALENDAR, {calendarId}) : null
    const owner = calendar?.ownerPartyId ? one("mantle.party.Party", {partyId: calendar.ownerPartyId}) : null
    const ownerOrganization = owner?.ownerPartyId && owner.ownerPartyId !== "_NA_" ? owner.ownerPartyId : owner?.partyId
    return {
        key: calendarId || "_NA_",
        calendarId: calendar ? calendarId : null,
        timeZone: calendar?.timeZone || p.timeZone || ec.user.timeZone || null,
        organizationPartyId: p.organizationPartyId || ownerOrganization || null
    }
}
// The instant a schedule's working time of the given minutes after startMs ends (the clock starts at the first working
// moment at or after startMs), at most a year on; null when the schedule has no working time left in that year.
function dueAfter(ctx, schedule, startMs, minutes) {
    let left = Math.max(0, Number(minutes) || 0) * minuteMs
    let windowFrom = startMs
    for (let step = 0; step < 13; step++) {
        const windowThru = windowFrom + 31 * dayMs
        for (const [from, thru] of intersect(calendarOf(ctx, schedule, windowFrom, windowThru).work, [
            [windowFrom, windowThru]
        ])) {
            if (thru <= startMs) continue
            const begin = Math.max(from, startMs)
            if (thru - begin >= left) return begin + left
            left -= thru - begin
        }
        windowFrom = windowThru
    }
    return null
}
// The working minutes of a schedule from fromMs to thruMs, less the pauses given ([[from, thru]]), whole minutes down.
function elapsedMinutes(ctx, schedule, fromMs, thruMs, pauses = []) {
    if (!(thruMs > fromMs)) return 0
    let total = 0
    for (let windowFrom = fromMs; windowFrom < thruMs; windowFrom += 31 * dayMs) {
        const windowThru = Math.min(thruMs, windowFrom + 31 * dayMs)
        const work = intersect(calendarOf(ctx, schedule, windowFrom, windowThru).work, [[windowFrom, windowThru]])
        total += length(subtract(work, merge(pauses.map(([from, thru]) => [from, thru]))))
    }
    return Math.floor(total / minuteMs)
}
const configuredOf = (ctx, schedule, fromMs, thruMs) => calendarOf(ctx, schedule, fromMs, thruMs).configured

// ===== working hours =====
const daysOf = value =>
    Array.from(
        new Set(
            (Array.isArray(value) ? value : String(value ?? "").split(","))
                .map(day => String(day).trim())
                .filter(day => /^[0-6]$/.test(day))
                .map(Number)
        )
    ).sort()
const clockOf = value => {
    const text = String(value ?? "").trim()
    return /^\d{1,2}:\d{2}$/.test(text) ? text.padStart(5, "0") : null
}
const ruleOf = days =>
    "FREQ=WEEKLY;BYDAY=" +
    ["MO", "TU", "WE", "TH", "FR", "SA", "SU"].filter(code => days.includes(dayCodes.indexOf(code))).join(",")
// A rule's UNTIL (yyyyMMddTHHmmssZ) as epoch millis, null when it has none.
const untilOf = rrule => {
    const found = /(?:^|;)UNTIL=(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/.exec(String(rrule || ""))
    return found ? Date.UTC(+found[1], +found[2] - 1, +found[3], +found[4], +found[5], +found[6]) : null
}
// The series of working hours, the latest start first: a person's own (by its source) or a calendar's; with all false only
// the open one (no UNTIL), which a change replaces or ends.
function currentSeries(target, all = false) {
    let efforts
    if (target.calendarId) {
        const ids = rows(MEMBER, {calendarId: target.calendarId}).map(row => row.workEffortId)
        efforts = ids.length
            ? Array.from(find(WORK).condition("workEffortId", "in", ids).condition("workEffortTypeEnumId", "WetAvailable").list())
            : []
    } else
        efforts = rows(WORK, {
            ownerPartyId: target.partyId,
            workEffortTypeEnumId: "WetAvailable",
            sourceReferenceId: target.sourceReferenceId
        })
    return efforts
        .filter(row => row.statusId !== "WeCancelled")
        .map(row => ({effort: row, recurrence: one(RECURRENCE, {workEffortId: row.workEffortId})}))
        .filter(row => all || untilOf(row.recurrence?.rrule) == null)
        .sort((a, b) => Number(ms(b.effort.estimatedStartDate) || 0) - Number(ms(a.effort.estimatedStartDate) || 0))
}
// Who may change a party's or calendar's working hours: a person their own; else an editor of its calendar
// (check#CalendarAccess), the party's manager (a current relationship from the user to it in the Manager role), or a holder of
// WORKING_HOURS_EDIT for a party of one of the user's organizations.
function requireHoursAccess(ownerPartyId, calendarId) {
    const me = ec.user.userAccount?.partyId
    if (!me) denied("PERMISSION_DENIED", "Working hours need a user with a party")
    if (calendarId) {
        const checked = lib.call("mantle.work.CalendarServices.check#CalendarAccess", {calendarId})
        if (["CalpEdit", "CalpManage"].includes(checked.userPermissionEnumId)) return
    }
    const manages = Array.from(
        find("mantle.party.PartyRelationship", {fromPartyId: me, toPartyId: ownerPartyId, fromRoleTypeId: "Manager"})
            .conditionDate("fromDate", "thruDate", ec.user.nowTimestamp)
            .list()
    ).length
    if (manages) return
    if (lib.access.has("WORKING_HOURS_EDIT")) {
        const owner = one("mantle.party.Party", {partyId: ownerPartyId})
        const userScope = facilityScope.scope()
        if (owner && (facilityScope.owns(userScope, ownerPartyId) || facilityScope.owns(userScope, owner.ownerPartyId))) return
    }
    denied(
        "PERMISSION_DENIED",
        "You may not change the working hours of " + (lib.partyNames([ownerPartyId])[ownerPartyId] || ownerPartyId)
    )
}
// store#WorkingHours: the weekly working hours of the user (no party), of a party (its schedule calendar, made on first use)
// or of a calendar, from a date or in place.
function storeWorkingHours(p) {
    const me = ec.user.userAccount?.partyId || null
    const own = !p.calendarId && (!p.partyId || p.partyId === me)
    if (own && !me) denied("PERMISSION_DENIED", "Working hours need a user with a party")
    const days = daysOf(p.workDays ?? "1,2,3,4,5")
    const start = clockOf(p.workStart) || "09:00"
    const end = clockOf(p.workEnd) || "17:00"
    if (!days.length) denied("DAYS_REQUIRED", "Pick at least one working day")
    if (end <= start) denied("HOURS_INVALID", "Working hours end after they start")
    let calendar = p.calendarId ? one(CALENDAR, {calendarId: p.calendarId}) : null
    if (p.calendarId && !calendar) denied("RECORD_UNAVAILABLE", "Calendar " + p.calendarId + " not found")
    const ownerPartyId = own ? me : calendar?.ownerPartyId || p.partyId
    if (!own) {
        if (!calendar) {
            const scheduleId = scheduleCalendarId(ownerPartyId)
            calendar = scheduleId ? one(CALENDAR, {calendarId: scheduleId}) : null
        }
        if (!ownerPartyId || !one("mantle.party.Party", {partyId: ownerPartyId}))
            denied("RECORD_UNAVAILABLE", "Party " + (ownerPartyId || "") + " not found")
        requireHoursAccess(ownerPartyId, calendar?.calendarId)
    }
    const zone = p.timeZone || calendar?.timeZone || ec.user.timeZone || null
    if (!own && !calendar) {
        const name = lib.partyNames([ownerPartyId])[ownerPartyId] || ownerPartyId
        const calendarId = lib.call("create#" + CALENDAR, {
            calendarName: name + " working hours",
            calendarKindEnumId: "CalkResource",
            ownerPartyId,
            timeZone: zone,
            isDefault: "N",
            createdDate: ec.user.nowTimestamp
        }).calendarId
        calendar = one(CALENDAR, {calendarId})
    } else if (!own && calendar && zone && calendar.timeZone !== zone) {
        calendar.set("timeZone", zone)
        calendar.update()
    }
    const target = own
        ? {partyId: me, sourceReferenceId: p.sourceReferenceId || "WorkingHours"}
        : {calendarId: calendar.calendarId, partyId: ownerPartyId}
    // the first working day of the series: on or after the from date, else of the last week (so the series has started)
    const fromMs = p.fromDate ? Number(ms(p.fromDate)) : null
    let first = fromMs != null ? dayIn(fromMs, zone) : addDay(dayIn(ms(ec.user.nowTimestamp), zone), -7)
    for (let i = 0; i < 7 && !days.includes(weekdayOf(first)); i++) first = addDay(first)
    const startMs = wallTimeIn(first, start, zone)
    const endMs = wallTimeIn(first, end, zone)
    const fields = {
        estimatedStartDate: new Date(startMs),
        estimatedCompletionDate: new Date(endMs),
        estimatedWorkDuration: (endMs - startMs) / hourMs
    }
    const rule = ruleOf(days)
    const series = currentSeries(target)[0] || null
    let workEffortId
    const inPlace = series && (fromMs == null || fromMs <= Number(ms(series.effort.estimatedStartDate)))
    if (inPlace) {
        for (const [field, value] of Object.entries(fields)) series.effort.set(field, value)
        series.effort.update()
        workEffortId = series.effort.workEffortId
    } else {
        if (series?.recurrence) {
            // the series in effect ends before the new one starts (UNTIL is inclusive, in UTC)
            const until = ec.l10n.format(new Date(fromMs - 1000), "yyyyMMdd'T'HHmmss'Z'", null, "UTC")
            series.recurrence.set("rrule", series.recurrence.rrule + ";UNTIL=" + until)
            series.recurrence.update()
        }
        workEffortId = lib.call(
            "create#" + WORK,
            Object.assign(
                {
                    workEffortTypeEnumId: "WetAvailable",
                    workEffortName: p.workEffortName || ec.l10n.localize("Working hours"),
                    statusId: "WeApproved",
                    ownerPartyId,
                    timeUomId: "TF_hr",
                    sourceReferenceId: own ? target.sourceReferenceId : "WorkingHours",
                    visibilityEnumId: "WevRestricted"
                },
                fields
            )
        ).workEffortId
        if (own)
            lib.call("create#mantle.work.effort.WorkEffortParty", {
                workEffortId,
                partyId: me,
                roleTypeId: "Assignee",
                fromDate: ec.user.nowTimestamp,
                statusId: "WeptAssigned"
            })
        else lib.call("create#" + MEMBER, {calendarId: calendar.calendarId, workEffortId, addedDate: ec.user.nowTimestamp})
    }
    const recurrence = one(RECURRENCE, {workEffortId})
    if (recurrence == null) lib.call("create#" + RECURRENCE, {workEffortId, rrule: rule, timeZone: zone})
    else {
        recurrence.set("rrule", rule)
        recurrence.set("timeZone", zone)
        recurrence.update()
    }
    return {workEffortId, calendarId: own ? null : calendar.calendarId, timeZone: zone}
}
// get#WorkingHours: the working hours in effect of the user, a party or a calendar: the days, from and to (wall clock in its
// zone), since when, and a text such as "Mon-Fri 09:00-17:00 (America/Chicago)".
function workingHours(p) {
    const me = ec.user.userAccount?.partyId || null
    const own = !p.calendarId && (!p.partyId || p.partyId === me)
    const calendarId = own ? null : p.calendarId || scheduleCalendarId(p.partyId)
    const calendar = calendarId ? one(CALENDAR, {calendarId}) : null
    const target = own ? {partyId: me, sourceReferenceId: p.sourceReferenceId || "WorkingHours"} : calendar ? {calendarId} : null
    // the series in effect now (started and not ended), else the next to start
    const now = Number(ms(ec.user.nowTimestamp))
    const all = target ? currentSeries(target, true) : []
    const series =
        all.find(
            row => Number(ms(row.effort.estimatedStartDate)) <= now && (untilOf(row.recurrence?.rrule) ?? Infinity) >= now
        ) ||
        all.filter(row => Number(ms(row.effort.estimatedStartDate)) > now).pop() ||
        null
    if (!series) return {configured: false, calendarId: calendar?.calendarId || null, text: "Not set: around the clock"}
    const zone = series.recurrence?.timeZone || calendar?.timeZone || ec.user.timeZone || null
    const days = String(/BYDAY=([A-Z,]+)/.exec(series.recurrence?.rrule || "")?.[1] || "")
        .split(",")
        .map(code => dayCodes.indexOf(code))
        .filter(day => day >= 0)
        .sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7))
    const [, workStart] = wallIn(ms(series.effort.estimatedStartDate), zone).split(" ")
    const [, workEnd] = wallIn(ms(series.effort.estimatedCompletionDate), zone).split(" ")
    const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
    const consecutive = days.every((day, i) => i === 0 || (days[i - 1] + 1) % 7 === day)
    const dayText =
        days.length > 2 && consecutive
            ? names[days[0]] + "-" + names[days[days.length - 1]]
            : days.map(day => names[day]).join(", ")
    return {
        configured: true,
        calendarId: calendar?.calendarId || null,
        workEffortId: series.effort.workEffortId,
        workDays: days,
        workStart,
        workEnd,
        timeZone: zone,
        fromDate: series.effort.estimatedStartDate,
        text: dayText + " " + workStart + "-" + workEnd + (zone ? " (" + zone + ")" : "")
    }
}

;({
    minuteMs,
    hourMs,
    dayMs,
    dayOf,
    dayStart,
    dayStartIn,
    wallTimeIn,
    dayIn,
    wallIn,
    addDay,
    merge,
    subtract,
    intersect,
    length,
    hoursOf,
    forCall,
    calendarOf,
    scheduleCalendarId,
    scheduleOf,
    dueAfter,
    elapsedMinutes,
    configuredOf,
    storeWorkingHours,
    workingHours,
    blank
})
