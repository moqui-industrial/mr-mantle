// The production schedule (design-manufacturing ProductionSchedule, Operations' Reschedule, FacilityDetail's offline change,
// §12 M5, M10, M11; impl-manufacturing P12): get#ProductionSchedule, schedule#ProductionOperation and store#WorkCenterOffline.
//
// A move puts one released operation on a work center (its routing's center or one of that center's alternates) from a start
// to an end; with no end given, the end is the operation's standard hours laid over the center's work hours from the start.
// A preview reads and writes nothing; a commit (apply) locks the operation and its run, rechecks everything and writes the
// operation's center and dates and a ProductionScheduleChange. What a commit rechecks:
// - refusals, never overridden: the operation and work center are the user's and the center is qualified; the operation has
//   not started (actual work pins it) and its run is open; the dates are in order; the operation's schedule revision and the
//   run's revision (its quantity and method) are the ones previewed (version and quantity);
// - conflicts, applied only with a supervisor's override (PRODUCTION_SUPERVISE, with a reason): outside the center's work hours
//   or on a holiday (calendar), the center offline (stops and outages), more operations at once than its parallel slots
//   (capacity), before a predecessor ends or after a successor starts, the run's equipment blocked, out of service or held by
//   another run then, and no operator on the run with the operation's skills.
// An override changes no capacity: it is recorded on the change. A scheduler without the authority asks for it (request): the
// change waits (SchRequested) and the supervisors get ProductionScheduleOverride; a supervisor applies it (approve) after the
// same rechecks or refuses it. Each applied change notifies the run's people (ProductionScheduleChange). Writes take an operation
// key (CX-POSTING), and a retry answers the first result.
//
// An offline change records a planned block of a work center (a ResourceUnavailability RukPlanned of the facility, written by
// mantle.work.ResourceBookingServices.record#ResourceUnavailability since impl-maintenance P15, reason RurOffline) and previews the open operations it overlaps with where each would move: forward to the
// center's next free time after the block, after its moved predecessors, within its slots. With moveOperations the moves are
// applied, each its own schedule#ProductionOperation (one that fails is named and the others go on); posted labor and machine
// facts are never changed.
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const posting = ec.resource.script("component://mr-mantle/service/mantle/shipment/StockPosting.js")
const facilityScope = ec.resource.script("component://mr-mantle/service/mantle/facility/FacilityScope.js")
const time = ec.resource.script("component://mr-mantle/service/mantle/work/ProductionCalendar.js")
const {find, one, rows, ms, call, denied, access} = lib
const payables = () => ec.resource.script("component://mr-mantle/service/mantle/account/Payables.js")
const planning = () => ec.resource.script("component://mr-mantle/service/mantle/work/ProductionPlanning.js")

const WORK = "mantle.work.effort.WorkEffort",
    CHANGE = "mantle.work.production.ProductionScheduleChange",
    ASSOC = "mantle.work.effort.WorkEffortAssoc",
    PARTY = "mantle.work.effort.WorkEffortParty",
    ASSIGN = "mantle.work.effort.WorkEffortAssetAssign",
    ASSET = "mantle.product.asset.Asset",
    OUTAGE = "mantle.work.effort.ResourceUnavailability",
    ALTERNATE = "mantle.work.production.WorkCenterAlternate",
    FACILITY = "mantle.facility.Facility",
    LINE = "mantle.work.production.ProductionRunLine",
    STATUS = "moqui.basic.StatusItem"
const openRunStatuses = ["WeApproved", "WeInProgress", "WeOnHold"]
const movableStatuses = ["WeApproved", "WeOnHold"]
const blockedEquipment = ["AstDeactivated", "AstOnHold", "AstDelivered"]
const laneLimit = 30
const operationLimit = 300
const defaultDays = 14
const {hourMs, dayMs, blank, wall} = time
const str = value => (blank(value) ? null : String(value))
const yes = value => value === true || value === "true" || value === "Y"
const statusText = statusId => (statusId ? one(STATUS, {statusId})?.description || statusId : "")
const hoursText = value => (value == null ? null : String(time.rounded(value)))
const canSchedule = () => access.has("PRODUCTION_SCHEDULE")
const canOverride = () => access.has("PRODUCTION_SUPERVISE")
const userName = userId => {
    if (!userId) return ""
    const account = one("moqui.security.UserAccount", {userId})
    return account?.userFullName || account?.username || userId
}
function requireAny(permissions) {
    if (!permissions.some(access.has)) denied("PERMISSION_DENIED", permissions.join(" or ") + " is required")
}

// ===== the operation, its run and its neighbors =====
// A released operation of the user's organizations (locked when asked), and its run.
function operationOf(ctx, userScope, workEffortId, lock = false) {
    const operation = blank(workEffortId) ? null : find(WORK, {workEffortId}).forUpdate(lock).one()
    const run = operation && operation.workEffortTypeEnumId === "WetTask" ? time.runOfOperation(ctx, operation) : null
    if (!run || !facilityScope.owns(userScope, run.ownerPartyId))
        denied("RECORD_UNAVAILABLE", "Operation " + (workEffortId || "") + " is not available")
    if (lock) {
        const locked = find(WORK, {workEffortId: run.workEffortId}).forUpdate(true).one()
        ctx.runs.set(run.workEffortId, locked)
        return {operation, run: locked}
    }
    return {operation, run}
}
// Why the operation cannot move, or null: its run is not open, or it started (actual work pins it), or it is done.
function lockReason(operation, run) {
    if (!openRunStatuses.includes(run.statusId)) return "Work order " + run.workEffortId + " is " + statusText(run.statusId)
    if (operation.actualStartDate != null || operation.statusId === "WeInProgress") return "Started: its actual work pins it"
    if (!movableStatuses.includes(operation.statusId)) return "It is " + statusText(operation.statusId)
    return null
}
// The run's operation children.
const siblingsOf = run =>
    Array.from(
        find(WORK)
            .condition("rootWorkEffortId", run.workEffortId)
            .condition("workEffortTypeEnumId", "WetTask")
            .condition("statusId", "not-equals", "WeCancelled")
            .list()
    )
// The WeatRoutingComp row of an operation's routing operation as of the run's method date.
function compOf(ctx, operation, run) {
    const key = "comp|" + operation.routingOperationWorkEffortId
    if (ctx.runs.has(key)) return ctx.runs.get(key)
    const routingOperation = one(WORK, {workEffortId: operation.routingOperationWorkEffortId || "_NA_"})
    const date = run.productionMethodDate || run.productionReleaseDate
    const comp = routingOperation
        ? rows(ASSOC, {
              workEffortId: routingOperation.parentWorkEffortId,
              toWorkEffortId: routingOperation.workEffortId,
              workEffortAssocTypeEnumId: "WeatRoutingComp"
          }).find(row => lib.active(row, date)) || null
        : null
    const value = {routingOperation, comp}
    ctx.runs.set(key, value)
    return value
}
const idList = value =>
    String(value || "")
        .split(/[\s,]+/)
        .filter(Boolean)
// The operation's predecessors and successors among its run's operations (the routing's predecessor ids).
function neighborsOf(ctx, operation, run) {
    const siblings = siblingsOf(run)
    const byRouting = new Map(siblings.map(row => [row.routingOperationWorkEffortId, row]))
    const own = idList(compOf(ctx, operation, run).comp?.predecessorWorkEffortIds)
    const predecessors = own.map(id => byRouting.get(id)).filter(Boolean)
    const successors = siblings.filter(
        row =>
            row.workEffortId !== operation.workEffortId &&
            idList(compOf(ctx, row, run).comp?.predecessorWorkEffortIds).includes(operation.routingOperationWorkEffortId)
    )
    return {predecessors, successors}
}
// The centers the operation may run on: its routing operation's center, that center's alternates in effect (for the run's
// product or every product), and the center it is on.
function qualifiedOf(ctx, operation, run) {
    const {routingOperation, comp} = compOf(ctx, operation, run)
    const home = comp?.workCenterFacilityId || routingOperation?.methodWorkCenterId || operation.workCenterFacilityId
    const ids = new Set([home, operation.workCenterFacilityId].filter(Boolean))
    const output = rows(LINE, {workEffortId: run.workEffortId, lineRoleEnumId: "PrlrOutput"})[0]
    for (const centerId of Array.from(ids))
        for (const row of rows(ALTERNATE, {facilityId: centerId}).filter(row => lib.active(row)))
            if (!row.productId || row.productId === output?.productId) ids.add(row.alternateFacilityId)
    return {home, ids}
}
// The operation's standard hours, or null when they do not read.
function hoursOf(ctx, operation, run) {
    try {
        return time.operationHours(ctx, operation, run)
    } catch (error) {
        ec.logger.warn("Schedule: hours of operation " + operation.workEffortId + ": " + error.message)
        return null
    }
}

// ===== the checks =====
const conflict = (code, message) => ({code, message})
// The refusals and conflicts of putting the operation on the center from fromMs to thruMs.
function evaluate(ctx, userScope, operation, run, target) {
    const refusals = []
    const conflicts = []
    const center = time.centerOf(ctx, target.facilityId)
    if (
        !center ||
        !facilityScope.owns(userScope, center.organizationPartyId) ||
        center.organizationPartyId !== run.ownerPartyId
    ) {
        refusals.push(conflict("CENTER_UNAVAILABLE", "Work center " + (target.facilityId || "") + " is not available"))
        return {refusals, conflicts, center: null}
    }
    const qualified = qualifiedOf(ctx, operation, run)
    if (!qualified.ids.has(center.facilityId))
        refusals.push(
            conflict("CENTER_NOT_QUALIFIED", center.facilityName + " is not the operation's work center or one of its alternates")
        )
    const locked = lockReason(operation, run)
    if (locked) refusals.push(conflict("OPERATION_LOCKED", locked))
    if (!(target.fromMs < target.thruMs)) refusals.push(conflict("DATES_INVALID", "The end is after the start"))
    if (refusals.length) return {refusals, conflicts, center}
    const span = [[target.fromMs, target.thruMs]]
    // calendar: outside the work hours, or on a holiday
    const {calendar, offline} = time.freeOf(ctx, center, target.fromMs, target.thruMs)
    const holidays = calendar.holidays.filter(row => row.fromMs < target.thruMs && row.thruMs > target.fromMs)
    const outside = time.hoursOf(time.subtract(span, calendar.work))
    if (holidays.length)
        conflicts.push(
            conflict("CALENDAR", "It runs on " + holidays.map(row => row.name + " (" + time.dayOf(row.fromMs) + ")").join(", "))
        )
    else if (outside > 0.01 && calendar.configured)
        conflicts.push(
            conflict("CALENDAR", hoursText(outside) + " hours of it fall outside " + center.facilityName + "'s work hours")
        )
    // offline: stops and outages
    for (const row of offline)
        conflicts.push(
            conflict(
                "OFFLINE",
                center.facilityName +
                    " is offline then: " +
                    row.kindText +
                    ", " +
                    row.reasonText +
                    " from " +
                    wall(row.fromMs) +
                    (row.open ? "" : " to " + wall(row.thruMs))
            )
        )
    // capacity: the operations at the center at once with it, against its slots
    const others = time
        .openOperations(ctx, [center.facilityId], target.fromMs, target.thruMs)
        .filter(row => row.workEffortId !== operation.workEffortId)
        .map(row => ({row, interval: time.intervalOf(row, hoursOf(ctx, row, time.runOfOperation(ctx, row)))}))
        .filter(item => item.interval && item.interval[0] < target.thruMs && item.interval[1] > target.fromMs)
    const points = [target.fromMs, ...others.map(item => item.interval[0]).filter(at => at > target.fromMs && at < target.thruMs)]
    let most = 0,
        mostIds = []
    for (const at of points) {
        const busy = others.filter(item => item.interval[0] <= at && item.interval[1] > at)
        if (busy.length > most) {
            most = busy.length
            mostIds = busy.map(item => item.row.workEffortId)
        }
    }
    if (most + 1 > center.parallelSlots)
        conflicts.push(
            conflict(
                "CAPACITY",
                center.facilityName +
                    " would run " +
                    (most + 1) +
                    " operations at once (" +
                    center.parallelSlots +
                    " " +
                    (center.parallelSlots === 1 ? "slot" : "slots") +
                    "): with " +
                    mostIds.join(", ")
            )
        )
    // predecessors and successors of the run
    const {predecessors, successors} = neighborsOf(ctx, operation, run)
    for (const before of predecessors) {
        const ends =
            before.statusId === "WeComplete"
                ? ms(before.actualCompletionDate)
                : time.intervalOf(before, hoursOf(ctx, before, run))?.[1]
        if (ends != null && ends > target.fromMs)
            conflicts.push(
                conflict(
                    "PREDECESSOR",
                    "It starts before " + (before.workEffortName || before.workEffortId) + " ends (" + wall(ends) + ")"
                )
            )
    }
    for (const after of successors) {
        if (after.statusId === "WeComplete" || after.actualStartDate != null) {
            conflicts.push(conflict("SUCCESSOR", (after.workEffortName || after.workEffortId) + " has started already"))
            continue
        }
        const starts = ms(after.estimatedStartDate)
        if (starts != null && starts < target.thruMs)
            conflicts.push(
                conflict(
                    "SUCCESSOR",
                    "It ends after " + (after.workEffortName || after.workEffortId) + " starts (" + wall(starts) + ")"
                )
            )
    }
    // equipment: the run's assigned equipment then
    const assigned = rows(ASSIGN, {workEffortId: run.workEffortId}).filter(
        row => row.thruDate == null || ms(row.thruDate) > target.fromMs
    )
    for (const assignment of assigned) {
        const asset = one(ASSET, {assetId: assignment.assetId})
        if (!asset) continue
        const label = asset.assetName || asset.assetId
        if (blockedEquipment.includes(asset.statusId))
            conflicts.push(conflict("EQUIPMENT", label + " is " + statusText(asset.statusId)))
        const outage = Array.from(
            find(OUTAGE, {assetId: asset.assetId})
                .condition("fromDate", "less", new Date(target.thruMs))
                .condition("supersededByUnavailabilityId", "is-null", null)
                .list()
        ).find(row => row.thruDate == null || ms(row.thruDate) > target.fromMs)
        if (outage) conflicts.push(conflict("EQUIPMENT", label + " is out of service from " + wall(ms(outage.fromDate))))
        const clash = rows(ASSIGN, {assetId: asset.assetId}).find(row => {
            if (row.workEffortId === run.workEffortId) return false
            if ((ms(row.fromDate) ?? -Infinity) >= target.thruMs || (ms(row.thruDate) ?? Infinity) <= target.fromMs) return false
            const other = one(WORK, {workEffortId: row.workEffortId})
            return other?.purposeEnumId === "WepProductionRun" && openRunStatuses.concat("WeInPlanning").includes(other.statusId)
        })
        if (clash) conflicts.push(conflict("EQUIPMENT", label + " is assigned to work order " + clash.workEffortId + " then"))
    }
    // skills: an operator of the run with the operation's skills, when it has operators
    const {routingOperation} = compOf(ctx, operation, run)
    const standardIds = [routingOperation?.workEffortId, routingOperation?.methodSourceWorkEffortId].filter(Boolean)
    const required = standardIds.length
        ? Array.from(
              new Set(
                  Array.from(
                      find("mantle.work.effort.WorkEffortSkillStandard")
                          .condition("workEffortId", "in", standardIds)
                          .selectField("skillTypeEnumId")
                          .list()
                  ).map(row => row.skillTypeEnumId)
              )
          )
        : []
    const operators = rows(PARTY, {workEffortId: run.workEffortId, roleTypeId: "Assignee"}).filter(
        row => row.thruDate == null || ms(row.thruDate) > ms(ec.user.nowTimestamp)
    )
    if (required.length && operators.length) {
        const qualifiedOperator = operators.some(row => {
            const held = new Set(
                rows("mantle.humanres.ability.PartySkill", {partyId: row.partyId}).map(skill => skill.skillTypeEnumId)
            )
            return required.every(skill => held.has(skill))
        })
        if (!qualifiedOperator)
            conflicts.push(
                conflict(
                    "SKILLS",
                    "No operator of the work order has " +
                        required.map(id => one("moqui.basic.Enumeration", {enumId: id})?.description || id).join(", ")
                )
            )
    }
    return {refusals, conflicts, center}
}

// The target of a move: the center (the operation's), the start (its own) and the end (given, else its hours over the
// center's work hours from the start, else its current length).
function targetOf(ctx, operation, run, p) {
    const facilityId = str(p.facilityId) || operation.workCenterFacilityId
    const hours = hoursOf(ctx, operation, run)
    const fromMs = blank(p.startDate) ? ms(operation.estimatedStartDate) : ms(p.startDate)
    if (fromMs == null || !Number.isFinite(fromMs))
        denied("START_REQUIRED", "Give the start of operation " + operation.workEffortId)
    let thruMs = blank(p.endDate) ? null : ms(p.endDate)
    let endComputed = false
    if (thruMs == null) {
        const center = time.centerOf(ctx, facilityId)
        if (hours != null && center) thruMs = time.endAfter(ctx, center, fromMs, hours)
        if (thruMs == null) {
            const current = time.intervalOf(operation, hours)
            thruMs = current ? fromMs + (current[1] - current[0]) : null
        }
        if (thruMs == null)
            denied("END_REQUIRED", "Give the end: the hours of operation " + operation.workEffortId + " do not read")
        endComputed = true
    }
    return {facilityId, fromMs, thruMs, hours, endComputed}
}
const revisionOf = operation => Number(operation.scheduleRevision || 0)
const runRevisionOf = run => Number(run.productionRevision || 0)
function requireRevisions(operation, run, p) {
    if (blank(p.expectedRevision) || blank(p.expectedRunRevision))
        denied("REVISION_REQUIRED", "Preview the move of operation " + operation.workEffortId + " and give its revisions")
    if (Number(p.expectedRevision) !== revisionOf(operation) || Number(p.expectedRunRevision) !== runRevisionOf(run))
        denied("REVISION_CHANGED", "Operation " + operation.workEffortId + " or its work order changed; preview it again")
}
// The answer of a preview: where the operation is and where it would go, with what refuses and what conflicts.
function previewAnswer(ctx, userScope, operation, run, target) {
    const checked = evaluate(ctx, userScope, operation, run, target)
    const supervise = canOverride()
    const current = time.intervalOf(operation, target.hours)
    return {
        preview: true,
        workEffortId: operation.workEffortId,
        operationName: operation.workEffortName || operation.workEffortId,
        runWorkEffortId: run.workEffortId,
        runName: run.workEffortName || run.workEffortId,
        fromFacilityId: operation.workCenterFacilityId || null,
        fromFacilityName: time.facilityName(one(FACILITY, {facilityId: operation.workCenterFacilityId || "_NA_"})),
        fromStartText: current ? wall(current[0]) : "",
        fromEndText: current ? wall(current[1]) : "",
        facilityId: target.facilityId,
        facilityName: checked.center?.facilityName || target.facilityId,
        startDate: new Date(target.fromMs),
        endDate: new Date(target.thruMs),
        startText: wall(target.fromMs),
        endText: wall(target.thruMs),
        endComputed: target.endComputed,
        hours: hoursText(target.hours),
        refusals: checked.refusals,
        conflicts: checked.conflicts,
        conflictText: checked.conflicts.map(row => row.message).join("; "),
        refusalText: checked.refusals.map(row => row.message).join("; "),
        expectedRevision: revisionOf(operation),
        expectedRunRevision: runRevisionOf(run),
        canApply: canSchedule() && !checked.refusals.length && (!checked.conflicts.length || supervise),
        needsOverride: !checked.refusals.length && checked.conflicts.length > 0,
        canOverride: supervise,
        canRequestOverride: canSchedule() && !supervise && !checked.refusals.length && checked.conflicts.length > 0
    }
}

// ===== notices =====
// The users of the run's people (its supervisors and operators), else the organization's supervisors, but the actor.
function notifyChange(run, operation, change, changeText) {
    try {
        const message = {
            workEffortId: run.workEffortId,
            workEffortName: run.workEffortName || run.workEffortId,
            operationWorkEffortId: operation.workEffortId,
            operationName: operation.workEffortName || operation.workEffortId,
            scheduleChangeId: change.scheduleChangeId,
            changeText
        }
        const partyIds = rows(PARTY, {workEffortId: run.workEffortId})
            .filter(row => row.thruDate == null || ms(row.thruDate) > ms(ec.user.nowTimestamp))
            .map(row => row.partyId)
        const userIds = partyIds.length
            ? Array.from(find("moqui.security.UserAccount").condition("partyId", "in", partyIds).selectField("userId").list())
                  .map(row => row.userId)
                  .filter(userId => userId !== ec.user.userId)
            : []
        if (userIds.length) {
            const notification = ec
                .makeNotificationMessage()
                .topic("ProductionScheduleChange")
                .message(message)
                .record(WORK, run.workEffortId)
                .actorUserId(ec.user.userId)
                .userIds(userIds)
            notification.send()
        } else if (!partyIds.length)
            payables().execute("notify", {
                topic: "ProductionScheduleChange",
                permission: "PRODUCTION_SUPERVISE",
                organizationPartyId: run.ownerPartyId,
                recordEntityName: WORK,
                recordId: run.workEffortId,
                message
            })
    } catch (error) {
        ec.logger.error("Schedule change " + change.scheduleChangeId + " notice was not sent: " + error.message)
    }
}
function notifyOverride(run, operation, change, preview) {
    try {
        payables().execute("notify", {
            topic: "ProductionScheduleOverride",
            permission: "PRODUCTION_SUPERVISE",
            organizationPartyId: run.ownerPartyId,
            recordEntityName: CHANGE,
            recordId: change.scheduleChangeId,
            message: {
                scheduleChangeId: change.scheduleChangeId,
                workEffortId: run.workEffortId,
                operationWorkEffortId: operation.workEffortId,
                operationName: operation.workEffortName || operation.workEffortId,
                facilityName: preview.facilityName,
                startText: preview.startText,
                conflictText: preview.conflictText
            }
        })
    } catch (error) {
        ec.logger.error("Schedule override request " + change.scheduleChangeId + " was not sent: " + error.message)
    }
}
function clearOverrideNotices(change) {
    try {
        payables().execute("clearNotices", {
            topic: "ProductionScheduleOverride",
            recordEntityName: CHANGE,
            recordId: change.scheduleChangeId
        })
    } catch (error) {
        ec.logger.error("Schedule override request " + change.scheduleChangeId + " notices were not cleared: " + error.message)
    }
}

// ===== schedule#ProductionOperation =====
const requestFields = [
    "workEffortId",
    "action",
    "facilityId",
    "startDate",
    "endDate",
    "reason",
    "override",
    "expectedRevision",
    "expectedRunRevision",
    "scheduleChangeId"
]
// Write the move or unschedule, its change row and its notice.
function writeChange(operation, run, target, kind, p, checked, overrideApplied, request) {
    const unschedule = kind === "SckUnschedule"
    call("update#" + WORK, {
        workEffortId: operation.workEffortId,
        workCenterFacilityId: unschedule ? operation.workCenterFacilityId : target.facilityId,
        estimatedStartDate: unschedule ? null : new Date(target.fromMs),
        estimatedCompletionDate: unschedule ? null : new Date(target.thruMs),
        scheduleRevision: revisionOf(operation) + 1
    })
    const fields = {
        organizationPartyId: run.ownerPartyId,
        workEffortId: operation.workEffortId,
        runWorkEffortId: run.workEffortId,
        changeKindEnumId: kind,
        statusId: "SchApplied",
        fromFacilityId: operation.workCenterFacilityId || null,
        fromStartDate: operation.estimatedStartDate || null,
        fromEndDate: operation.estimatedCompletionDate || null,
        toFacilityId: unschedule ? null : target.facilityId,
        toStartDate: unschedule ? null : new Date(target.fromMs),
        toEndDate: unschedule ? null : new Date(target.thruMs),
        fromRevision: revisionOf(operation),
        runRevision: runRevisionOf(run),
        reason: str(p.reason),
        conflictsJson: JSON.stringify(checked.conflicts || []),
        overrideApplied: overrideApplied ? "Y" : "N"
    }
    let change
    if (request) {
        call(
            "update#" + CHANGE,
            Object.assign({}, fields, {
                scheduleChangeId: request.scheduleChangeId,
                reason: request.reason,
                decidedByUserId: ec.user.userId,
                decidedDate: ec.user.nowTimestamp,
                decisionReason: str(p.reason)
            })
        )
        change = {scheduleChangeId: request.scheduleChangeId}
    } else
        change = call(
            "create#" + CHANGE,
            Object.assign(fields, {requestedByUserId: ec.user.userId, requestedDate: ec.user.nowTimestamp})
        )
    const centerName = time.facilityName(one(FACILITY, {facilityId: target.facilityId || "_NA_"}))
    const changeText = unschedule ? "unscheduled" : centerName + " from " + wall(target.fromMs) + " to " + wall(target.thruMs)
    notifyChange(run, operation, change, changeText)
    return {change, changeText}
}
function preview(p) {
    requireAny(["PRODUCTION_SCHEDULE", "PRODUCTION_SUPERVISE"])
    const ctx = time.forCall()
    const userScope = posting.scope()
    const {operation, run} = operationOf(ctx, userScope, p.workEffortId)
    return previewAnswer(ctx, userScope, operation, run, targetOf(ctx, operation, run, p))
}
function apply(p) {
    const begun = posting.begin(p, "ProductionSchedule", "PRODUCTION_SCHEDULE", requestFields)
    if (begun.previous) return begun.previous
    const ctx = time.forCall()
    const userScope = posting.scope()
    const {operation, run} = operationOf(ctx, userScope, p.workEffortId, true)
    const settled = posting.settled(begun.op)
    if (settled) return settled
    requireRevisions(operation, run, p)
    const target = targetOf(ctx, operation, run, p)
    const checked = evaluate(ctx, userScope, operation, run, target)
    if (checked.refusals.length) denied(checked.refusals[0].code, checked.refusals.map(row => row.message).join("; "))
    const override = yes(p.override)
    if (checked.conflicts.length) {
        if (!override)
            denied("SCHEDULE_CONFLICT", checked.conflicts.map(row => row.message).join("; ") + ". A supervisor may override it")
        if (!canOverride()) denied("OVERRIDE_NOT_PERMITTED", "PRODUCTION_SUPERVISE is required to override a conflict")
        if (blank(p.reason)) denied("REASON_REQUIRED", "Give the reason for the override")
    }
    const {change, changeText} = writeChange(operation, run, target, "SckMove", p, checked, checked.conflicts.length > 0)
    return posting.complete(begun.op, run.ownerPartyId, CHANGE, change.scheduleChangeId, {
        resultCode: checked.conflicts.length ? "OVERRIDDEN" : "SCHEDULED",
        scheduleChangeId: change.scheduleChangeId,
        workEffortId: operation.workEffortId,
        facilityId: target.facilityId,
        startDate: new Date(target.fromMs),
        endDate: new Date(target.thruMs),
        revision: revisionOf(operation) + 1,
        conflicts: checked.conflicts,
        message: (operation.workEffortName || operation.workEffortId) + " moved: " + changeText
    })
}
function unschedule(p) {
    const begun = posting.begin(p, "ProductionSchedule", "PRODUCTION_SCHEDULE", requestFields)
    if (begun.previous) return begun.previous
    const ctx = time.forCall()
    const userScope = posting.scope()
    const {operation, run} = operationOf(ctx, userScope, p.workEffortId, true)
    const settled = posting.settled(begun.op)
    if (settled) return settled
    requireRevisions(operation, run, p)
    const locked = lockReason(operation, run)
    if (locked) denied("OPERATION_LOCKED", locked)
    if (operation.estimatedStartDate == null) denied("NOT_SCHEDULED", "Operation " + operation.workEffortId + " is not scheduled")
    const {change} = writeChange(
        operation,
        run,
        {facilityId: operation.workCenterFacilityId},
        "SckUnschedule",
        p,
        {conflicts: []},
        false
    )
    return posting.complete(begun.op, run.ownerPartyId, CHANGE, change.scheduleChangeId, {
        resultCode: "UNSCHEDULED",
        scheduleChangeId: change.scheduleChangeId,
        workEffortId: operation.workEffortId,
        revision: revisionOf(operation) + 1,
        message: (operation.workEffortName || operation.workEffortId) + " unscheduled"
    })
}
// A scheduler's request that a supervisor apply a move over its conflicts.
function request(p) {
    const begun = posting.begin(p, "ProductionSchedule", "PRODUCTION_SCHEDULE", requestFields)
    if (begun.previous) return begun.previous
    const ctx = time.forCall()
    const userScope = posting.scope()
    const {operation, run} = operationOf(ctx, userScope, p.workEffortId, true)
    const settled = posting.settled(begun.op)
    if (settled) return settled
    requireRevisions(operation, run, p)
    if (blank(p.reason)) denied("REASON_REQUIRED", "Give the reason for the override")
    const target = targetOf(ctx, operation, run, p)
    const answer = previewAnswer(ctx, userScope, operation, run, target)
    if (answer.refusals.length) denied(answer.refusals[0].code, answer.refusalText)
    if (!answer.conflicts.length) denied("NO_CONFLICT", "The move has no conflict: apply it")
    const change = call("create#" + CHANGE, {
        organizationPartyId: run.ownerPartyId,
        workEffortId: operation.workEffortId,
        runWorkEffortId: run.workEffortId,
        changeKindEnumId: "SckMove",
        statusId: "SchRequested",
        fromFacilityId: operation.workCenterFacilityId || null,
        fromStartDate: operation.estimatedStartDate || null,
        fromEndDate: operation.estimatedCompletionDate || null,
        toFacilityId: target.facilityId,
        toStartDate: new Date(target.fromMs),
        toEndDate: new Date(target.thruMs),
        fromRevision: revisionOf(operation),
        runRevision: runRevisionOf(run),
        reason: str(p.reason),
        conflictsJson: JSON.stringify(answer.conflicts),
        overrideApplied: "N",
        requestedByUserId: ec.user.userId,
        requestedDate: ec.user.nowTimestamp
    })
    notifyOverride(run, operation, change, answer)
    return posting.complete(begun.op, run.ownerPartyId, CHANGE, change.scheduleChangeId, {
        resultCode: "REQUESTED",
        scheduleChangeId: change.scheduleChangeId,
        workEffortId: operation.workEffortId,
        conflicts: answer.conflicts,
        message: "A supervisor is asked to override the move of " + (operation.workEffortName || operation.workEffortId)
    })
}
// A requested override, locked, still waiting, of the user's organizations.
function requestOf(userScope, scheduleChangeId) {
    const change = blank(scheduleChangeId) ? null : find(CHANGE, {scheduleChangeId}).forUpdate(true).one()
    if (!change || !facilityScope.owns(userScope, change.organizationPartyId))
        denied("RECORD_UNAVAILABLE", "Schedule change " + (scheduleChangeId || "") + " is not available")
    if (change.statusId !== "SchRequested")
        denied("CHANGE_DECIDED", "Schedule change " + scheduleChangeId + " is decided already")
    return change
}
// A supervisor applies a requested override after the same rechecks, at the revisions it was asked at.
function approve(p) {
    const begun = posting.begin(p, "ProductionScheduleDecision", "PRODUCTION_SUPERVISE", requestFields)
    if (begun.previous) return begun.previous
    const ctx = time.forCall()
    const userScope = posting.scope()
    const request = requestOf(userScope, p.scheduleChangeId)
    const {operation, run} = operationOf(ctx, userScope, request.workEffortId, true)
    const settled = posting.settled(begun.op)
    if (settled) return settled
    if (Number(request.fromRevision || 0) !== revisionOf(operation) || Number(request.runRevision || 0) !== runRevisionOf(run))
        denied("REVISION_CHANGED", "Operation " + operation.workEffortId + " changed since the request; refuse it and ask again")
    const target = {facilityId: request.toFacilityId, fromMs: ms(request.toStartDate), thruMs: ms(request.toEndDate)}
    const checked = evaluate(ctx, userScope, operation, run, target)
    if (checked.refusals.length) denied(checked.refusals[0].code, checked.refusals.map(row => row.message).join("; "))
    const {changeText} = writeChange(operation, run, target, "SckMove", p, checked, checked.conflicts.length > 0, request)
    clearOverrideNotices(request)
    return posting.complete(begun.op, run.ownerPartyId, CHANGE, request.scheduleChangeId, {
        resultCode: "OVERRIDDEN",
        scheduleChangeId: request.scheduleChangeId,
        workEffortId: operation.workEffortId,
        revision: revisionOf(operation) + 1,
        conflicts: checked.conflicts,
        message: "Override applied: " + (operation.workEffortName || operation.workEffortId) + " moved to " + changeText
    })
}
function refuse(p) {
    const begun = posting.begin(p, "ProductionScheduleDecision", "PRODUCTION_SUPERVISE", requestFields)
    if (begun.previous) return begun.previous
    const userScope = posting.scope()
    const request = requestOf(userScope, p.scheduleChangeId)
    const settled = posting.settled(begun.op)
    if (settled) return settled
    if (blank(p.reason)) denied("REASON_REQUIRED", "Give the reason for the refusal")
    call("update#" + CHANGE, {
        scheduleChangeId: request.scheduleChangeId,
        statusId: "SchRefused",
        decidedByUserId: ec.user.userId,
        decidedDate: ec.user.nowTimestamp,
        decisionReason: str(p.reason)
    })
    clearOverrideNotices(request)
    return posting.complete(begun.op, request.organizationPartyId, CHANGE, request.scheduleChangeId, {
        resultCode: "REFUSED",
        scheduleChangeId: request.scheduleChangeId,
        workEffortId: request.workEffortId,
        message: "Override refused"
    })
}
const scheduleActions = {preview, apply, unschedule, request, approve, refuse}
function schedule(p) {
    const action = str(p.action) || "preview"
    if (!scheduleActions[action]) denied("ACTION_INVALID", "Unknown schedule action " + action)
    return scheduleActions[action](p)
}

// ===== get#ProductionSchedule =====
// A requested change for the schedule's list.
function requestRow(ctx, userScope, change) {
    const operation = one(WORK, {workEffortId: change.workEffortId})
    let conflicts = lib.json(change.conflictsJson, [])
    return {
        scheduleChangeId: change.scheduleChangeId,
        workEffortId: change.workEffortId,
        operationName: operation?.workEffortName || change.workEffortId,
        runWorkEffortId: change.runWorkEffortId,
        statusId: change.statusId,
        statusText: statusText(change.statusId),
        toFacilityId: change.toFacilityId,
        toFacilityName: time.facilityName(one(FACILITY, {facilityId: change.toFacilityId || "_NA_"})),
        toStartText: change.toStartDate ? wall(ms(change.toStartDate)) : "",
        toEndText: change.toEndDate ? wall(ms(change.toEndDate)) : "",
        reason: change.reason || "",
        requestedByName: userName(change.requestedByUserId),
        requestedText: change.requestedDate ? wall(ms(change.requestedDate)) : "",
        decisionReason: change.decisionReason || "",
        conflicts,
        conflictText: conflicts.map(row => row.message).join("; "),
        canDecide: change.statusId === "SchRequested" && canOverride()
    }
}
function scheduleRead(p) {
    requireAny(["PRODUCTION_VIEW", "PRODUCTION_SCHEDULE", "PRODUCTION_SUPERVISE"])
    const ctx = time.forCall()
    const userScope = posting.scope()
    const now = ms(ec.user.nowTimestamp)
    const fromMs = blank(p.fromDate) ? time.dayStart(time.dayOf(now)) : ms(p.fromDate)
    const thruMs = blank(p.thruDate) ? fromMs + defaultDays * dayMs : ms(p.thruDate)
    if (!(thruMs > fromMs)) denied("RANGE_INVALID", "The range ends after it starts")
    if (thruMs - fromMs > 92 * dayMs) denied("RANGE_INVALID", "The schedule shows at most three months")
    // the lanes: the user's work centers (by plant or the given ones)
    const centerQuery = planning().centerFind(userScope, {plantFacilityId: p.plantFacilityId, facilityIds: p.facilityIds})
    const facilities = Array.from(centerQuery.limit(laneLimit).list())
    const laneList = []
    for (const facility of facilities) {
        try {
            const center = time.centerOf(ctx, facility.facilityId)
            const {calendar, offline} = time.freeOf(ctx, center, fromMs, thruMs)
            const holidayIntervals = time.merge(calendar.holidays.map(row => [row.fromMs, row.thruMs]))
            const closed = calendar.configured
                ? time.subtract(time.subtract([[fromMs, thruMs]], calendar.work), holidayIntervals)
                : []
            laneList.push({
                facilityId: facility.facilityId,
                facilityName: center.facilityName,
                parallelSlots: center.parallelSlots,
                slotsConfigured: center.slotsConfigured,
                calendarConfigured: calendar.configured,
                efficiencyPercent: String(center.efficiency),
                closedList: closed.map(([from, thru]) => ({fromText: wall(from), thruText: wall(thru)})),
                holidayList: calendar.holidays
                    .filter(row => row.thruMs > fromMs && row.fromMs < thruMs)
                    .map(row => ({fromText: wall(row.fromMs), thruText: wall(row.thruMs), name: row.name})),
                offlineList: offline.map(row => ({
                    fromText: wall(Math.max(row.fromMs, fromMs)),
                    thruText: wall(Math.min(row.thruMs, thruMs)),
                    kind: row.kind,
                    kindText: row.kindText,
                    reasonText: row.reasonText,
                    sourceId: row.sourceId,
                    open: row.open
                }))
            })
        } catch (error) {
            ec.logger.error("Schedule lane " + facility.facilityId + " not read: " + error.message)
            laneList.push({
                facilityId: facility.facilityId,
                facilityName: time.facilityName(facility),
                failed: true,
                closedList: [],
                holidayList: [],
                offlineList: []
            })
        }
    }
    const centerIds = laneList.map(row => row.facilityId)
    const found = time.openOperations(ctx, centerIds, fromMs, thruMs, true)
    const truncated = found.length > operationLimit
    const schedule = canSchedule()
    const operationList = []
    const unscheduledList = []
    for (const operation of found.slice(0, operationLimit)) {
        try {
            const run = time.runOfOperation(ctx, operation)
            const hours = hoursOf(ctx, operation, run)
            const interval = time.intervalOf(operation, hours)
            const locked = lockReason(operation, run)
            const {predecessors} = neighborsOf(ctx, operation, run)
            const output = rows(LINE, {workEffortId: run.workEffortId, lineRoleEnumId: "PrlrOutput"})[0]
            const product = output ? one("mantle.product.Product", {productId: output.productId}) : null
            const row = {
                workEffortId: operation.workEffortId,
                operationName: operation.workEffortName || operation.workEffortId,
                sequenceNum: operation.operationSequenceNum ?? null,
                runWorkEffortId: run.workEffortId,
                runName: run.workEffortName || run.workEffortId,
                productName: product ? product.productName || product.productId : "",
                quantityText: output ? String(toDecimal(output.quantity).toNumber()) : "",
                facilityId: operation.workCenterFacilityId,
                statusId: operation.statusId,
                statusText: statusText(operation.statusId),
                hours: hoursText(hours),
                startText: interval ? wall(interval[0]) : "",
                endText: interval ? wall(interval[1]) : "",
                locked: !!locked,
                lockedReason: locked || "",
                predecessorIds: predecessors.map(row => row.workEffortId),
                expectedRevision: revisionOf(operation),
                expectedRunRevision: runRevisionOf(run),
                canMove: schedule && !locked,
                conflicts: [],
                conflictText: ""
            }
            if (interval && !locked) {
                const checked = evaluate(ctx, userScope, operation, run, {
                    facilityId: operation.workCenterFacilityId,
                    fromMs: interval[0],
                    thruMs: interval[1]
                })
                row.conflicts = checked.refusals.concat(checked.conflicts)
                row.conflictText = row.conflicts.map(item => item.message).join("; ")
            }
            if (interval) operationList.push(row)
            else unscheduledList.push(row)
        } catch (error) {
            ec.logger.error("Schedule operation " + operation.workEffortId + " not read: " + error.message)
        }
    }
    const conflictList = []
    for (const row of operationList)
        for (const item of row.conflicts)
            conflictList.push({
                workEffortId: row.workEffortId,
                operationName: row.operationName,
                runWorkEffortId: row.runWorkEffortId,
                facilityId: row.facilityId,
                code: item.code,
                message: item.message
            })
    // the override requests waiting at these centers, and the one asked for
    const changeQuery = find(CHANGE).condition("statusId", "SchRequested")
    const requests = centerIds.length ? Array.from(changeQuery.condition("toFacilityId", "in", centerIds).limit(50).list()) : []
    if (!blank(p.scheduleChangeId) && !requests.some(row => row.scheduleChangeId === p.scheduleChangeId)) {
        const asked = one(CHANGE, {scheduleChangeId: p.scheduleChangeId})
        if (asked && facilityScope.owns(userScope, asked.organizationPartyId)) requests.unshift(asked)
    }
    const requestList = requests
        .filter(row => facilityScope.owns(userScope, row.organizationPartyId))
        .map(row => requestRow(ctx, userScope, row))
    return {
        fromDate: new Date(fromMs),
        thruDate: new Date(thruMs),
        fromText: wall(fromMs),
        thruText: wall(thruMs),
        nowText: wall(now),
        todayText: time.dayOf(now),
        laneList,
        operationList,
        unscheduledList,
        conflictList,
        requestList,
        canSchedule: schedule,
        canOverride: canOverride(),
        truncated
    }
}

// ===== store#WorkCenterOffline =====
// The center of an offline change: a work center of the user's organizations.
function offlineCenter(ctx, userScope, facilityId) {
    const center = blank(facilityId) ? null : time.centerOf(ctx, facilityId)
    if (!center || !facilityScope.owns(userScope, center.organizationPartyId))
        denied("RECORD_UNAVAILABLE", "Work center " + (facilityId || "") + " is not available")
    return center
}
// Where each open operation the block overlaps would move: forward to the center's first free time after the block (and
// after its predecessors' new ends) with a free slot for its hours.
function affectedBy(ctx, userScope, center, fromMs, thruMs) {
    const overlapping = time
        .openOperations(ctx, [center.facilityId], fromMs, thruMs)
        .map(operation => {
            const run = time.runOfOperation(ctx, operation)
            const hours = hoursOf(ctx, operation, run)
            return {operation, run, hours, interval: time.intervalOf(operation, hours)}
        })
        .filter(item => item.interval && item.interval[0] < thruMs && item.interval[1] > fromMs)
        .sort((a, b) => a.interval[0] - b.interval[0])
    // the other operations at the center from the block on, which keep their places
    const placed = time
        .openOperations(ctx, [center.facilityId], fromMs, thruMs + 366 * dayMs)
        .filter(row => !overlapping.some(item => item.operation.workEffortId === row.workEffortId))
        .map(row => time.intervalOf(row, hoursOf(ctx, row, time.runOfOperation(ctx, row))))
        .filter(Boolean)
    const moved = new Map()
    return overlapping.map(item => {
        const {operation, run, hours, interval} = item
        const locked = lockReason(operation, run)
        const base = {
            workEffortId: operation.workEffortId,
            operationName: operation.workEffortName || operation.workEffortId,
            runWorkEffortId: run.workEffortId,
            runName: run.workEffortName || run.workEffortId,
            fromStartText: wall(interval[0]),
            fromEndText: wall(interval[1]),
            expectedRevision: revisionOf(operation),
            expectedRunRevision: runRevisionOf(run),
            locked: !!locked,
            lockedReason: locked || ""
        }
        if (locked) return Object.assign(base, {moves: false, toStartText: "", toEndText: "", note: locked})
        const length = hours != null ? null : interval[1] - interval[0]
        let earliest = Math.max(thruMs, interval[0])
        for (const before of neighborsOf(ctx, operation, run).predecessors)
            if (moved.has(before.workEffortId)) earliest = Math.max(earliest, moved.get(before.workEffortId)[1])
        let start = null,
            end = null
        for (let attempt = 0; attempt < 100; attempt++) {
            start = time.nextFree(ctx, center, earliest)
            if (start == null) break
            end = length != null ? start + length : time.endAfter(ctx, center, start, hours)
            if (end == null) break
            const busy = placed.filter(([from, to]) => from < end && to > start)
            const points = [start, ...busy.map(row => row[0]).filter(at => at > start && at < end)]
            const full = points.some(at => busy.filter(([from, to]) => from <= at && to > at).length >= center.parallelSlots)
            if (!full) break
            earliest = Math.min(...busy.map(row => row[1]).filter(at => at > start))
            start = null
        }
        if (start == null || end == null)
            return Object.assign(base, {moves: false, toStartText: "", toEndText: "", note: "No free time found within a year"})
        placed.push([start, end])
        moved.set(operation.workEffortId, [start, end])
        return Object.assign(base, {
            moves: true,
            toStartDate: new Date(start),
            toEndDate: new Date(end),
            toStartText: wall(start),
            toEndText: wall(end),
            note: ""
        })
    })
}
function offlineInterval(p) {
    const fromMs = ms(p.fromDate)
    const thruMs = ms(p.thruDate)
    if (fromMs == null || thruMs == null || !Number.isFinite(fromMs) || !Number.isFinite(thruMs))
        denied("DATES_REQUIRED", "Give the start and end of the offline time")
    if (thruMs <= fromMs) denied("DATES_INVALID", "The end is after the start")
    if (thruMs - fromMs > 366 * dayMs) denied("DATES_INVALID", "An offline time is at most a year")
    return {fromMs, thruMs}
}
function offline(p) {
    const action = str(p.action) || "preview"
    if (!["preview", "apply", "withdraw"].includes(action)) denied("ACTION_INVALID", "Unknown offline action " + action)
    if (action === "preview") {
        requireAny(["PRODUCTION_SCHEDULE", "METHOD_RESOURCES"])
        const ctx = time.forCall()
        const userScope = posting.scope()
        const center = offlineCenter(ctx, userScope, p.facilityId)
        const {fromMs, thruMs} = offlineInterval(p)
        // the block counts as offline in the preview, as it will once recorded
        ctx.extraOffline[center.facilityId] = [
            {
                fromMs,
                thruMs,
                kind: "planned",
                kindText: "Planned offline",
                reasonText: str(p.reason) || "Planned offline",
                open: false
            }
        ]
        const affectedList = affectedBy(ctx, userScope, center, fromMs, thruMs)
        return {
            preview: true,
            facilityId: center.facilityId,
            facilityName: center.facilityName,
            fromText: wall(fromMs),
            thruText: wall(thruMs),
            affectedList,
            affectedCount: affectedList.length,
            movableCount: affectedList.filter(row => row.moves).length,
            canMove: canSchedule()
        }
    }
    const begun = posting.begin(
        p,
        "WorkCenterOffline",
        ["PRODUCTION_SCHEDULE", "METHOD_RESOURCES"],
        ["facilityId", "action", "fromDate", "thruDate", "reason", "moveOperations", "resourceUnavailabilityId"]
    )
    if (begun.previous) return begun.previous
    const ctx = time.forCall()
    const userScope = posting.scope()
    const center = offlineCenter(ctx, userScope, p.facilityId)
    const settled = posting.settled(begun.op)
    if (settled) return settled
    if (action === "withdraw") {
        // the row in force of the block named: Maintenance may have corrected it (impl-maintenance P15), so a superseded row is
        // followed to its correction
        let named = blank(p.resourceUnavailabilityId) ? null : one(OUTAGE, {resourceUnavailabilityId: p.resourceUnavailabilityId})
        for (let guard = 0; named?.supersededByUnavailabilityId && guard < 50; guard++)
            named = one(OUTAGE, {resourceUnavailabilityId: named.supersededByUnavailabilityId})
        const outage = named
            ? find(OUTAGE, {resourceUnavailabilityId: named.resourceUnavailabilityId}).forUpdate(true).one()
            : null
        if (!outage || outage.facilityId !== center.facilityId || outage.unavailabilityKindEnumId !== "RukPlanned")
            denied("RECORD_UNAVAILABLE", "Planned offline time " + (p.resourceUnavailabilityId || "") + " is not available")
        const now = ms(ec.user.nowTimestamp)
        if (outage.thruDate != null && ms(outage.thruDate) <= now) denied("OFFLINE_ENDED", "That offline time has ended")
        const ends = ms(outage.fromDate) > now ? outage.fromDate : ec.user.nowTimestamp
        call("update#" + OUTAGE, {resourceUnavailabilityId: outage.resourceUnavailabilityId, thruDate: ends})
        return posting.complete(begun.op, center.organizationPartyId, OUTAGE, outage.resourceUnavailabilityId, {
            resultCode: ms(outage.fromDate) > now ? "WITHDRAWN" : "ENDED",
            resourceUnavailabilityId: outage.resourceUnavailabilityId,
            message: ms(outage.fromDate) > now ? "Offline time withdrawn" : "Offline time ended now"
        })
    }
    const {fromMs, thruMs} = offlineInterval(p)
    if (blank(p.reason)) denied("REASON_REQUIRED", "Give the reason the work center is offline")
    const move = yes(p.moveOperations)
    if (move && !canSchedule()) denied("PERMISSION_DENIED", "PRODUCTION_SCHEDULE is required to move the operations")
    // the one writer of planned blocks (impl-maintenance P15, F14), which admits a scheduler of the work center by data
    const created = call("mantle.work.ResourceBookingServices.record#ResourceUnavailability", {
        unavailabilityKindEnumId: "RukPlanned",
        unavailabilityReasonEnumId: "RurOffline",
        facilityId: center.facilityId,
        fromDate: new Date(fromMs),
        thruDate: new Date(thruMs),
        description: str(p.reason)
    })
    const moveResults = []
    if (move) {
        // the block is recorded in this transaction: the preview with it counted, then each move its own transaction
        const fresh = time.forCall()
        for (const row of affectedBy(fresh, userScope, center, fromMs, thruMs)) {
            if (!row.moves) {
                moveResults.push({workEffortId: row.workEffortId, ok: false, reasonCode: "NOT_MOVED", message: row.note})
                continue
            }
            try {
                const out = lib.probe("mantle.work.ProductionPlanningServices.schedule#ProductionOperation", {
                    operationKey: begun.op.clientKey + "/" + row.workEffortId,
                    action: "apply",
                    workEffortId: row.workEffortId,
                    facilityId: center.facilityId,
                    startDate: row.toStartDate,
                    endDate: row.toEndDate,
                    expectedRevision: row.expectedRevision,
                    expectedRunRevision: row.expectedRunRevision,
                    reason: "Offline: " + str(p.reason)
                })
                moveResults.push({
                    workEffortId: row.workEffortId,
                    ok: true,
                    resultCode: out.result?.resultCode,
                    message: out.result?.message
                })
            } catch (error) {
                const message = String(error?.message || error).replace(/^(Error: )+/, "")
                ec.logger.warn("Offline move of operation " + row.workEffortId + " failed: " + message)
                moveResults.push({
                    workEffortId: row.workEffortId,
                    ok: false,
                    reasonCode: lib.reasonCode(error) || "FAILED",
                    message
                })
            }
        }
    }
    return posting.complete(begun.op, center.organizationPartyId, OUTAGE, created.resourceUnavailabilityId, {
        resultCode: "OFFLINE_RECORDED",
        resourceUnavailabilityId: created.resourceUnavailabilityId,
        moveResults,
        movedCount: moveResults.filter(row => row.ok).length,
        message:
            center.facilityName +
            " offline from " +
            wall(fromMs) +
            " to " +
            wall(thruMs) +
            (move ? "; " + moveResults.filter(row => row.ok).length + " of " + moveResults.length + " operations moved" : "")
    })
}
const operationsTable = {schedule, read: scheduleRead, offline}
;({
    execute: (op, parameters) => {
        if (!operationsTable[op]) throw new Error("Unknown production schedule operation " + op)
        return operationsTable[op](parameters)
    }
})
