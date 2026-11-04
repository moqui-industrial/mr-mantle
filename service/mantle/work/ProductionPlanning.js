// Production planning reads (design-manufacturing §7 Capacity, §12 M5, M10; impl-manufacturing P3, P12): get#WorkCenterLoad, the
// work centers of the user's organizations with their capacity and load over a range, whole or by day or week.
//
// For each center and period (ProductionCalendar.js has the calendar, offline and operation rules):
// - nominal hours: the parallel slots over the whole period at the center's efficiency;
// - calendar-adjusted hours: the slots over its work hours less holidays, at its efficiency (nominal when it has no calendar);
// - downtime hours: the slots over the work hours it is offline (stops and outages), at its efficiency;
// - available hours: calendar-adjusted less downtime;
// - booked hours: the standard hours of its released operations, each prorated over the work hours of its dates that fall in
//   the period (an operation that overlaps the period counts only its part inside it); an operation with no dates counts
//   whole in the range's first period, named as missing data;
// - overload: booked hours above available ones; utilization: booked over available (not OEE).
// Missing data is named per center: no calendar, no slots set, operations without hours or dates, stops awaiting approval
// (counted as downtime, F-P11-3), an open stop or outage. An operation whose hours do not read is logged and named, and the
// others still count. Next available: the first moment from now when the center works, is not offline and has a free slot.
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const {find, one, ms, denied, dateText} = lib
const facilityScope = ec.resource.script("component://mr-mantle/service/mantle/facility/FacilityScope.js")
const time = ec.resource.script("component://mr-mantle/service/mantle/work/ProductionCalendar.js")
const workCenters = () => ec.resource.script("component://mr-mantle/service/mantle/work/WorkCenters.js")

const FACILITY = "mantle.facility.Facility"
const CENTER = "mantle.work.production.WorkCenter"
const CAPACITY = "mantle.work.production.WorkCenterCapacity"
const defaultDays = 14
const maxDays = 366
const maxDayPeriods = 62
const nextAvailableDays = 60
const {hourMs, dayMs, blank, rounded} = time
const decimal = value => toDecimal(value == null || value === "" ? 0 : value)
const like = (field, term) =>
    ec.entity.conditionFactory
        .makeCondition(field, "like", "%" + String(term).replace(/[\\%_]/g, character => "\\" + character) + "%")
        .ignoreCase()
const hoursText = value => String(rounded(value))
const utilizationFormula =
    "Utilization is booked hours over available hours (calendar-adjusted hours less downtime); it is not OEE."

// The range: fromDate (now) through thruDate (fromDate and two weeks), at most a year.
function rangeOf(p) {
    const fromMs = blank(p.fromDate) ? ms(ec.user.nowTimestamp) : ms(p.fromDate)
    const thruMs = blank(p.thruDate) ? fromMs + defaultDays * dayMs : ms(p.thruDate)
    if (!Number.isFinite(fromMs) || !Number.isFinite(thruMs) || thruMs <= fromMs)
        throw new Error("The range ends after it starts")
    if (thruMs - fromMs > maxDays * dayMs) throw new Error("The range is at most a year")
    return {fromMs, thruMs, hours: (thruMs - fromMs) / hourMs}
}
// The periods of the range: the whole range, or split at the start of each day or week (Monday) in the user's zone.
function periodsOf(range, bucket) {
    if (blank(bucket) || bucket === "range") return [[range.fromMs, range.thruMs]]
    if (!["day", "week"].includes(bucket)) throw new Error("The bucket is day, week or the whole range")
    const starts = []
    let day = time.dayOf(range.fromMs)
    let at = time.dayStart(day)
    while (at < range.thruMs) {
        const weekday = new Date(day + "T00:00:00Z").getUTCDay()
        if (at > range.fromMs && (bucket === "day" || weekday === 1)) starts.push(at)
        const [y, m, d] = day.split("-").map(Number)
        day = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10)
        at = time.dayStart(day)
    }
    const edges = [range.fromMs, ...starts, range.thruMs]
    if (edges.length - 1 > maxDayPeriods) throw new Error("At most " + maxDayPeriods + " periods: choose a longer bucket")
    return edges.slice(0, -1).map((from, index) => [from, edges[index + 1]])
}
// The centers of the user's organizations, by facility, plant and text: a find used once.
function centerFind(userScope, p) {
    const centerIds = Array.from(find(CENTER).selectField("facilityId").list()).map(row => row.facilityId)
    let query = find(FACILITY).condition("facilityId", "in", centerIds.length ? centerIds : ["_NA_"])
    if (userScope.organizationPartyIds) query = query.condition("ownerPartyId", "in", userScope.organizationPartyIds)
    if (!blank(p.facilityId)) query = query.condition("facilityId", p.facilityId)
    const facilityIds = Array.isArray(p.facilityIds)
        ? p.facilityIds
        : String(p.facilityIds || "")
              .split(/[\s,]+/)
              .filter(Boolean)
    if (facilityIds.length) query = query.condition("facilityId", "in", facilityIds)
    if (!blank(p.plantFacilityId)) {
        const planted = Array.from(find(CENTER, {plantFacilityId: p.plantFacilityId}).selectField("facilityId").list()).map(
            row => row.facilityId
        )
        const factory = ec.entity.conditionFactory
        const inPlant = [factory.makeCondition("parentFacilityId", "equals", p.plantFacilityId)]
        if (planted.length) inPlant.push(factory.makeCondition("facilityId", "in", planted))
        query = query.condition(inPlant.length === 1 ? inPlant[0] : factory.makeCondition(inPlant, "or"))
    }
    if (!blank(p.text)) {
        const factory = ec.entity.conditionFactory
        query = query.condition(factory.makeCondition([like("facilityId", p.text), like("facilityName", p.text)], "or"))
    }
    return query.orderBy("facilityName").orderBy("facilityId")
}
// The rate capacities of a center in effect at the date, as text.
function rateText(ctx, facilityId, date) {
    if (!ctx.workCenters) ctx.workCenters = workCenters()
    return Array.from(find(CAPACITY, {facilityId}).list())
        .filter(row => row.capacityBasisEnumId === "WccbRate" && lib.active(row, date))
        .map(row => ctx.workCenters.capacityRow(row))
        .map(row => row.capacityText + " · " + row.appliesToText)
        .join("; ")
}

// The center's booked operations over the range: each with its hours, interval (null without dates) and work time.
function bookedOperations(ctx, center, range, calendar) {
    const findings = []
    const booked = []
    for (const operation of time.openOperations(ctx, [center.facilityId], range.fromMs, range.thruMs, true)) {
        const run = time.runOfOperation(ctx, operation)
        let hours
        try {
            hours = time.operationHours(ctx, operation, run)
        } catch (error) {
            ec.logger.error("Work center load of operation " + operation.workEffortId + ": " + error.message)
            findings.push({
                workEffortId: operation.workEffortId,
                message: "No hours for " + operation.workEffortId + ": " + error.message
            })
            continue
        }
        const interval = time.intervalOf(operation, hours)
        const worked = interval ? time.intersect(calendar.work, [interval]) : []
        booked.push({operation, hours, interval, worked, workMs: time.length(worked)})
    }
    return {booked, findings}
}
// The booked hours of the operations that fall in the period: each operation's hours times the part of its work time (else
// of its dates) inside the period; one with no dates in the range's first period.
function bookedIn(booked, period, first) {
    let hours = 0
    for (const row of booked) {
        if (!row.interval) {
            if (first) hours += row.hours
            continue
        }
        if (row.workMs > 0) hours += (row.hours * time.length(time.intersect(row.worked, [period]))) / row.workMs
        else {
            const span = row.interval[1] - row.interval[0]
            const inside = Math.max(0, Math.min(row.interval[1], period[1]) - Math.max(row.interval[0], period[0]))
            hours += span > 0 ? (row.hours * inside) / span : 0
        }
    }
    return hours
}
// The first moment from now (within 60 days) when the center works, is not offline and runs fewer operations than its slots.
function nextAvailable(ctx, center) {
    const now = ms(ec.user.nowTimestamp)
    const thru = now + nextAvailableDays * dayMs
    const free = time.freeOf(ctx, center, now, thru).free
    const intervals = []
    for (const operation of time.openOperations(ctx, [center.facilityId], now, thru)) {
        let hours = 0
        try {
            hours = time.operationHours(ctx, operation, time.runOfOperation(ctx, operation))
        } catch (error) {
            hours = 0
        }
        const interval = time.intervalOf(operation, hours)
        if (interval) intervals.push(interval)
    }
    const busy = at => intervals.filter(([from, to]) => from <= at && to > at).length
    for (const [from, to] of free) {
        const points = [from, ...intervals.map(row => row[1]).filter(at => at > from && at < to)].sort((a, b) => a - b)
        for (const at of points) if (busy(at) < center.parallelSlots) return at
    }
    return null
}
// The offline interval now, else the next one in the range: its text.
function offlineReason(offline) {
    const now = ms(ec.user.nowTimestamp)
    const current = offline.find(row => row.fromMs <= now && row.thruMs > now)
    if (current)
        return {
            offlineNow: true,
            text:
                current.kindText +
                ": " +
                current.reasonText +
                (current.open && current.kind !== "downtime"
                    ? " (until Maintenance ends it)"
                    : current.open
                      ? ""
                      : ", until " + time.wall(current.thruMs))
        }
    const next = offline.find(row => row.fromMs > now)
    return {offlineNow: false, text: next ? next.kindText + " from " + time.wall(next.fromMs) + ": " + next.reasonText : ""}
}

// One center's load over the range and its periods.
function centerLoad(ctx, userScope, facility, range, periods) {
    const center = time.centerOf(ctx, facility.facilityId, new Date(range.fromMs))
    const plantId = center.workCenter.plantFacilityId || facility.parentFacilityId
    const plant = plantId ? one(FACILITY, {facilityId: plantId}) : null
    const {calendar, offline} = time.freeOf(ctx, center, range.fromMs, range.thruMs)
    const offlineIntervals = time.offlineIntervals(offline)
    const {booked, findings} = bookedOperations(ctx, center, range, calendar)
    const factor = (center.parallelSlots * center.efficiency) / 100
    const periodList = periods.map(([from, thru], index) => {
        const period = [[from, thru]]
        const work = time.intersect(calendar.work, period)
        const nominal = ((thru - from) / hourMs) * factor
        const calendarHours = time.hoursOf(work) * factor
        const downtime = time.hoursOf(time.intersect(work, offlineIntervals)) * factor
        const available = Math.max(0, calendarHours - downtime)
        const bookedHours = bookedIn(booked, [from, thru], index === 0)
        return {
            fromDate: new Date(from),
            thruDate: new Date(thru),
            periodText: time.wall(from) + " to " + time.wall(thru),
            nominalHours: hoursText(nominal),
            calendarHours: hoursText(calendarHours),
            downtimeHours: hoursText(downtime),
            availableHours: hoursText(available),
            bookedHours: hoursText(bookedHours),
            overloadHours: hoursText(Math.max(0, bookedHours - available)),
            overloaded: bookedHours - available > 0.005,
            utilizationPercent: available > 0 ? hoursText((bookedHours / available) * 100) : null
        }
    })
    const total = field => periodList.reduce((sum, row) => sum + Number(row[field]), 0)
    const available = total("availableHours")
    const bookedHours = total("bookedHours")
    const missingList = []
    if (!calendar.configured)
        missingList.push({code: "NO_CALENDAR", message: "No work calendar: its hours count around the clock, less holidays"})
    if (!center.slotsConfigured) missingList.push({code: "NO_SLOTS", message: "No parallel slots set: it counts as one"})
    if (findings.length)
        missingList.push({code: "NO_HOURS", message: findings.length + " operations without standard hours, not counted"})
    const undated = booked.filter(row => !row.interval).length
    if (undated) missingList.push({code: "NO_DATES", message: undated + " operations without dates, counted whole"})
    const awaiting = offline.filter(row => row.awaitingApproval).length
    if (awaiting) missingList.push({code: "STOP_APPROVAL", message: awaiting + " stops awaiting approval, counted as downtime"})
    if (offline.some(row => row.open && row.kind === "downtime"))
        missingList.push({code: "OPEN_STOP", message: "A stop is still open: counted until now"})
    if (offline.some(row => row.open && row.kind !== "downtime"))
        missingList.push({code: "OPEN_OUTAGE", message: "Out of service until Maintenance ends the outage"})
    const next = nextAvailable(ctx, center)
    const reason = offlineReason(offline)
    return {
        facilityId: facility.facilityId,
        facilityName: center.facilityName,
        facilityTypeEnumId: facility.facilityTypeEnumId,
        plantFacilityId: plantId || null,
        plantName: plant && facilityScope.owns(userScope, plant.ownerPartyId) ? time.facilityName(plant) : "",
        efficiencyPercent: String(center.efficiency),
        parallelSlots: center.parallelSlots,
        slotsConfigured: center.slotsConfigured,
        calendarConfigured: calendar.configured,
        capacityText: rateText(ctx, facility.facilityId, new Date(range.fromMs)),
        nominalHours: hoursText(total("nominalHours")),
        calendarHours: hoursText(total("calendarHours")),
        downtimeHours: hoursText(total("downtimeHours")),
        availableHours: hoursText(available),
        bookedHours: hoursText(bookedHours),
        loadHours: hoursText(bookedHours),
        overloadHours: hoursText(Math.max(0, bookedHours - available)),
        overloaded: bookedHours - available > 0.005,
        operationCount: booked.length + findings.length,
        utilizationPercent: available > 0 ? hoursText((bookedHours / available) * 100) : null,
        nextAvailableDate: next == null ? null : new Date(next),
        nextAvailableText: next == null ? "Not within 60 days" : time.wall(next),
        offlineNow: reason.offlineNow,
        offlineReasonText: reason.text,
        offlineList: offline.map(row => ({
            kind: row.kind,
            kindText: row.kindText,
            reasonText: row.reasonText,
            fromText: time.wall(row.fromMs),
            thruText: row.open ? "" : time.wall(row.thruMs),
            sourceId: row.sourceId,
            open: row.open,
            awaitingApproval: row.awaitingApproval
        })),
        missingList,
        missingText: missingList.map(row => row.message).join("; "),
        findings,
        periodList
    }
}

// get#WorkCenterLoad: the user's work centers (by facility, centers, plant or text, a page at a time) with their capacity
// and load.
function load(p) {
    if (!lib.access.has("PRODUCTION_VIEW")) denied("PERMISSION_DENIED", "PRODUCTION_VIEW is required")
    const userScope = facilityScope.scope()
    if (!blank(p.facilityId)) {
        const facility = one(FACILITY, {facilityId: p.facilityId})
        if (!facility || !facilityScope.owns(userScope, facility.ownerPartyId) || !one(CENTER, {facilityId: p.facilityId}))
            denied("RECORD_UNAVAILABLE", "Work center " + p.facilityId + " is not available")
    }
    const range = rangeOf(p)
    const periods = periodsOf(range, p.bucket)
    const paged = lib.page(centerFind(userScope, p), p, "centerList", centerFind(userScope, p).count())
    const ctx = time.forCall()
    const centerList = paged.rows.map(facility => {
        try {
            return centerLoad(ctx, userScope, facility, range, periods)
        } catch (error) {
            ec.logger.error("Work center load of " + facility.facilityId + " not read: " + error.message)
            return {
                facilityId: facility.facilityId,
                facilityName: time.facilityName(facility),
                missingList: [{code: "LOAD_FAILED", message: "The load could not be read: " + error.message}],
                missingText: "The load could not be read: " + error.message,
                findings: [],
                periodList: [],
                offlineList: []
            }
        }
    })
    return Object.assign({}, paged, {
        rows: undefined,
        centerList,
        fromDate: new Date(range.fromMs),
        thruDate: new Date(range.thruMs),
        rangeText: dateText(new Date(range.fromMs)) + " to " + dateText(new Date(range.thruMs)),
        rangeHours: hoursText(range.hours),
        bucket: blank(p.bucket) ? "range" : p.bucket,
        utilizationFormula,
        timeZone: String(ec.user.timeZone || "")
    })
}

const operations = {load}
;({
    // the user's work centers by facility, centers, plant and text (get#ProductionSchedule's lanes)
    centerFind,
    execute: (op, parameters) => {
        if (!operations[op]) throw new Error("Unknown production planning operation " + op)
        return operations[op](parameters)
    }
})
