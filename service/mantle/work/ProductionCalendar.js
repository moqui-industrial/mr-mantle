// A work center's time for planning and scheduling (design-manufacturing ProductionSchedule and Capacity, §12 M5; impl-manufacturing
// P12): its work hours from its calendar (the WetAvailable work efforts, recurring ones expanded by get#EventInstances), less
// the holidays of its calendar and of its organization (WepHoliday); its offline intervals (the production stops at the
// center, and the outages of the center or of equipment located at it: ResourceUnavailability, actual or planned); its
// parallel slots and efficiency; and the open operations at it with their standard hours. Every interval is epoch millis
// [from, thru). A center with no calendar works around the clock, and that is named as missing data by its callers. A stop
// still open counts until now; an outage still open counts to the end of the range (only Maintenance ends it, F-P11-4). A
// stop or outage takes the whole center for its interval (a line stops with its equipment). The module keeps no state between
// calls: a caller makes a context (forCall) for its caches. A holiday's day starts in the calendar's time zone (Calendar.timeZone,
// else the user's) and a recurring shift expands in its recurrence's zone (else the user's), so a plant's calendar with its
// zone reads alike to users in any zone (F-P12-1).
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const {find, one, rows, ms, dateText} = lib
const policy = ec.resource.script("component://mr-mantle/service/mantle/product/MethodPolicy.js")

const FACILITY = "mantle.facility.Facility"
const CENTER = "mantle.work.production.WorkCenter"
const CAPACITY = "mantle.work.production.WorkCenterCapacity"
const WORK = "mantle.work.effort.WorkEffort"
const LINE = "mantle.work.production.ProductionRunLine"
const DOWNTIME = "mantle.work.production.ProductionDowntime"
const OUTAGE = "mantle.work.effort.ResourceUnavailability"
// the operations of a released run that still take a center's time
const openStatuses = ["WeApproved", "WeInProgress", "WeOnHold"]
const hourMs = 3600000
const dayMs = 24 * hourMs

const blank = value => value == null || String(value).trim() === ""
const decimal = value => toDecimal(value == null || value === "" ? 0 : value)
const rounded = value => Math.round(value * 100) / 100
const wall = millis => ec.l10n.format(new Date(Number(millis)), "yyyy-MM-dd HH:mm")
const dayOf = millis => ec.l10n.format(new Date(Number(millis)), "yyyy-MM-dd")
const dayStart = day => ms(ec.l10n.parseTimestamp(String(day).slice(0, 10) + " 00:00:00.000", "yyyy-MM-dd HH:mm:ss.SSS"))
const addDay = day => {
    const [y, m, d] = String(day).slice(0, 10).split("-").map(Number)
    return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10)
}
const facilityName = facility => (facility ? facility.facilityName || facility.facilityId : "")
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

// ===== the call's context =====
function forCall() {
    // extraOffline: blocks not recorded yet that a preview counts as offline, by work center
    return {centers: new Map(), calendars: new Map(), offline: new Map(), runs: new Map(), outputs: new Map(), extraOffline: {}}
}

// A center: its facility, WorkCenter row, parallel slots in effect at the date (one when none is set) and efficiency.
function centerOf(ctx, facilityId, date = ec.user.nowTimestamp) {
    const key = facilityId + "|" + ms(date)
    if (ctx.centers.has(key)) return ctx.centers.get(key)
    const facility = facilityId ? one(FACILITY, {facilityId}) : null
    const workCenter = facility ? one(CENTER, {facilityId}) : null
    let center = null
    if (facility && workCenter) {
        const slots = rows(CAPACITY, {facilityId})
            .filter(row => row.capacityBasisEnumId === "WccbSlots" && !row.productId && !row.productTypeEnumId)
            .filter(row => lib.active(row, date))
            .map(row => Number(row.parallelSlots || 0))
        center = {
            facilityId,
            facility,
            workCenter,
            facilityName: facilityName(facility),
            organizationPartyId: facility.ownerPartyId,
            parallelSlots: slots.length ? Math.max(1, ...slots) : 1,
            slotsConfigured: slots.length > 0,
            efficiency: workCenter.efficiencyPercent == null ? 100 : decimal(workCenter.efficiencyPercent).toNumber(),
            calendarId: workCenter.calendarId || null,
            // the plant's zone: its calendar's (F-P12-1), else the user's; a recurrence expands in its own zone
            timeZone:
                (workCenter.calendarId && one("mantle.work.calendar.Calendar", {calendarId: workCenter.calendarId})?.timeZone) ||
                null
        }
    }
    ctx.centers.set(key, center)
    return center
}

// The center's work hours from fromMs to thruMs, less holidays: {configured, work, holidays: [{fromMs, thruMs, name}]}.
function calendarOf(ctx, center, fromMs, thruMs) {
    const key = center.facilityId + "|" + fromMs + "|" + thruMs
    if (ctx.calendars.has(key)) return ctx.calendars.get(key)
    const holidays = []
    let work = []
    let configured = false
    const efforts = center.calendarId
        ? (() => {
              const ids = rows("mantle.work.calendar.CalendarWorkEffort", {calendarId: center.calendarId}).map(
                  row => row.workEffortId
              )
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
                ? [dayStartIn(instance.startDay, center.timeZone), dayStartIn(instance.endDay, center.timeZone)]
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
            .condition("ownerPartyId", center.organizationPartyId || "_NA_")
            .condition("allDayStart", "greater-equals", firstDay)
            .condition("allDayStart", "less-equals", lastDay)
            .list()
    )) {
        const day = lib.calendarDateText(holiday.allDayStart)
        holidays.push({
            fromMs: dayStartIn(day, center.timeZone),
            thruMs: dayStartIn(addDay(day), center.timeZone),
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

// The center's offline intervals overlapping fromMs to thruMs: its production stops (not corrected) and the outages of the
// center or of equipment located at it, each {fromMs, thruMs, kind, reasonText, sourceId, open, awaitingApproval}.
function offlineOf(ctx, center, fromMs, thruMs) {
    const key = center.facilityId + "|" + fromMs + "|" + thruMs
    if (ctx.offline.has(key)) return ctx.offline.get(key)
    const now = ms(ec.user.nowTimestamp)
    const factory = ec.entity.conditionFactory
    const overlapping = query =>
        query
            .condition("fromDate", "less", new Date(thruMs))
            .condition(
                factory.makeCondition(
                    [
                        factory.makeCondition("thruDate", "is-null", null),
                        factory.makeCondition("thruDate", "greater", new Date(fromMs))
                    ],
                    "or"
                )
            )
    const out = []
    for (const stop of Array.from(
        overlapping(find(DOWNTIME).condition("facilityId", center.facilityId))
            .condition("statusId", "not-equals", "PdtCorrected")
            .list()
    )) {
        if (stop.supersededByDowntimeId) continue
        const open = stop.thruDate == null
        const reasons = rows("mantle.work.production.ProductionReason", {
            organizationPartyId: stop.organizationPartyId || "_NA_",
            reasonCode: stop.reasonCode || "_NA_"
        })
        const reason = reasons.find(row => lib.active(row, stop.fromDate)) || reasons[0]
        out.push({
            fromMs: ms(stop.fromDate),
            thruMs: open ? Math.max(now, ms(stop.fromDate)) : ms(stop.thruDate),
            kind: "downtime",
            kindText: stop.plannedStop === "Y" ? "Planned stop" : "Stop",
            reasonText: reason?.reasonName || stop.reasonCode || "Stop",
            description: stop.description || "",
            sourceId: stop.productionDowntimeId,
            open,
            awaitingApproval: stop.approvalRequired === "Y" && !stop.approvedDate
        })
    }
    const assetIds = Array.from(
        find("mantle.product.asset.Asset", {facilityId: center.facilityId}).selectField("assetId").list()
    ).map(row => row.assetId)
    const resourceConditions = [factory.makeCondition("facilityId", "equals", center.facilityId)]
    if (assetIds.length) resourceConditions.push(factory.makeCondition("assetId", "in", assetIds))
    for (const outage of Array.from(
        overlapping(find(OUTAGE)).condition(factory.makeCondition(resourceConditions, "or")).list()
    )) {
        // a stop's outage is the stop's interval already when it is the same; an outage still open runs to the range's end
        const open = outage.thruDate == null
        const planned = outage.unavailabilityKindEnumId === "RukPlanned"
        out.push({
            fromMs: ms(outage.fromDate),
            thruMs: open ? Math.max(thruMs, ms(outage.fromDate)) : ms(outage.thruDate),
            kind: planned ? "planned" : "outage",
            kindText: planned ? "Planned offline" : "Out of service",
            reasonText: outage.description || (planned ? "Planned offline" : "Equipment outage"),
            description: outage.assetId ? "Equipment " + outage.assetId : "",
            sourceId: outage.resourceUnavailabilityId,
            assetId: outage.assetId || null,
            open,
            awaitingApproval: false
        })
    }
    for (const extra of ctx.extraOffline[center.facilityId] || [])
        if (extra.fromMs < thruMs && extra.thruMs > fromMs) out.push(extra)
    // only what falls in the range (a stop still open counts until now, so it may end before the range starts)
    const result = out
        .filter(row => row.thruMs > row.fromMs && row.thruMs > fromMs && row.fromMs < thruMs)
        .sort((a, b) => a.fromMs - b.fromMs)
    ctx.offline.set(key, result)
    return result
}
const offlineIntervals = offline => merge(offline.map(row => [row.fromMs, row.thruMs]))

// The time the center can work from fromMs to thruMs: its work hours less its offline intervals.
function freeOf(ctx, center, fromMs, thruMs) {
    const calendar = calendarOf(ctx, center, fromMs, thruMs)
    const offline = offlineOf(ctx, center, fromMs, thruMs)
    return {calendar, offline, free: subtract(intersect(calendar.work, [[fromMs, thruMs]]), offlineIntervals(offline))}
}

// ===== operations =====
const runOf = (ctx, workEffortId) => {
    if (!workEffortId) return null
    if (!ctx.runs.has(workEffortId)) ctx.runs.set(workEffortId, one(WORK, {workEffortId}))
    return ctx.runs.get(workEffortId)
}
// A released run's operation: its run is a production run with a release date.
const runOfOperation = (ctx, operation) => {
    const run = runOf(ctx, operation.rootWorkEffortId || operation.parentWorkEffortId)
    return run && run.purposeEnumId === "WepProductionRun" && run.productionReleaseDate != null ? run : null
}

// The standard hours of a released operation: its routing operation's standards as of the run's method date, for the run's
// output quantity in the operation's batch unit; machine time where it has any, else labor time.
function operationHours(ctx, operation, run) {
    const date = run.productionMethodDate || run.productionReleaseDate
    const routingOperation = one(WORK, {workEffortId: operation.routingOperationWorkEffortId || "_NA_"})
    if (!routingOperation) throw new Error("its routing operation is not found")
    const assoc = rows("mantle.work.effort.WorkEffortAssoc", {
        workEffortId: routingOperation.parentWorkEffortId,
        toWorkEffortId: routingOperation.workEffortId,
        workEffortAssocTypeEnumId: "WeatRoutingComp"
    }).filter(row => lib.active(row, date))[0]
    if (!assoc) throw new Error("its routing operation has no released standards on " + dateText(date))
    if (!ctx.outputs.has(run.workEffortId)) {
        const output = rows(LINE, {workEffortId: run.workEffortId, lineRoleEnumId: "PrlrOutput"})[0]
        ctx.outputs.set(run.workEffortId, output || null)
    }
    const output = ctx.outputs.get(run.workEffortId)
    if (!output) throw new Error("its work order has no output line")
    const quantity =
        assoc.quantityUomId && output.quantityUomId && assoc.quantityUomId !== output.quantityUomId
            ? policy.convert(output.quantity, output.quantityUomId, assoc.quantityUomId, date).quantity
            : decimal(output.quantity)
    const batches =
        assoc.batchQuantity && decimal(assoc.batchQuantity).compare(0) > 0 ? quantity.divide(assoc.batchQuantity) : quantity
    const machine = decimal(assoc.machineSetupTime).add(decimal(assoc.machineRunTime).multiply(batches))
    const labor = decimal(assoc.setupTime).add(decimal(assoc.runTime).multiply(batches))
    const time = machine.compare(0) > 0 ? machine : labor
    return policy.convert(time, assoc.timeUomId || "TF_min", "TF_hr", date).quantity.toNumber()
}
// The open operations at the centers whose estimated dates overlap fromMs to thruMs, and with unscheduled true also those
// with no start date; only a released run's (a draft has none, and anything else at a center is not production work).
function openOperations(ctx, centerIds, fromMs, thruMs, unscheduled = false) {
    if (!centerIds.length) return []
    const factory = ec.entity.conditionFactory
    const dated = factory.makeCondition(
        [
            factory.makeCondition("estimatedStartDate", "less", new Date(thruMs)),
            factory.makeCondition(
                [
                    factory.makeCondition("estimatedCompletionDate", "is-null", null),
                    factory.makeCondition("estimatedCompletionDate", "greater", new Date(fromMs))
                ],
                "or"
            )
        ],
        "and"
    )
    const when = unscheduled
        ? factory.makeCondition([dated, factory.makeCondition("estimatedStartDate", "is-null", null)], "or")
        : dated
    return Array.from(
        find(WORK)
            .condition("workCenterFacilityId", "in", centerIds)
            .condition("workEffortTypeEnumId", "WetTask")
            .condition("statusId", "in", openStatuses)
            .condition(when)
            .orderBy("estimatedStartDate")
            .limit(2000)
            .list()
    ).filter(operation => runOfOperation(ctx, operation))
}
// An operation's interval: its estimated dates; with no end, its start and its hours.
function intervalOf(operation, hours) {
    const from = ms(operation.estimatedStartDate)
    if (from == null) return null
    let thru = ms(operation.estimatedCompletionDate)
    if (thru == null || thru <= from) thru = from + Math.max(hours || 0, 0) * hourMs
    return thru > from ? [from, thru] : [from, from + 1]
}

// The end of work of the given hours started at startMs on the center: the hours laid over its free time (work hours, not
// offline), at most a year on. With no free time left, null.
function endAfter(ctx, center, startMs, hours) {
    let left = Math.max(0, hours) * hourMs
    if (left === 0) return startMs
    let windowFrom = startMs
    for (let step = 0; step < 12; step++) {
        const windowThru = windowFrom + 31 * dayMs
        for (const [from, thru] of freeOf(ctx, center, windowFrom, windowThru).free) {
            if (thru <= startMs) continue
            const begin = Math.max(from, startMs)
            if (thru - begin >= left) return begin + left
            left -= thru - begin
        }
        windowFrom = windowThru
    }
    return null
}
// The first free moment of the center at or after startMs (within a year), or null.
function nextFree(ctx, center, startMs) {
    let windowFrom = startMs
    for (let step = 0; step < 12; step++) {
        const windowThru = windowFrom + 31 * dayMs
        const free = freeOf(ctx, center, windowFrom, windowThru).free.find(([, thru]) => thru > startMs)
        if (free) return Math.max(free[0], startMs)
        windowFrom = windowThru
    }
    return null
}
// The center's average work hours a day over the week from fromMs (its calendar, less holidays; 24 without one).
function workHoursPerDay(ctx, center, fromMs) {
    const calendar = calendarOf(ctx, center, fromMs, fromMs + 7 * dayMs)
    if (!calendar.configured) return 24
    return hoursOf(intersect(calendar.work, [[fromMs, fromMs + 7 * dayMs]])) / 7
}

;({
    hourMs,
    dayMs,
    openStatuses,
    blank,
    rounded,
    wall,
    dayOf,
    dayStart,
    dayStartIn,
    facilityName,
    merge,
    subtract,
    intersect,
    length,
    hoursOf,
    forCall,
    centerOf,
    calendarOf,
    offlineOf,
    offlineIntervals,
    freeOf,
    runOf,
    runOfOperation,
    operationHours,
    openOperations,
    intervalOf,
    endAfter,
    nextFree,
    workHoursPerDay
})
