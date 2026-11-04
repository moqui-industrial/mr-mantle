// Production planning reads (design-manufacturing §7 and §12 M5, M10; impl-manufacturing P3): get#WorkCenterLoad, the work
// centers of the user's organizations with their capacity and the load of their released operations over a range of days.
// This first version reads capacity and released operations only: a center's nominal hours are its parallel slots over the
// whole range at its efficiency, before work hours, holidays and downtime, which P12 brings with the calendar and the
// schedule. An operation's hours are its routing operation's standards (setup, and run time per batch for the run's output
// quantity), machine time where it has any, else labor time, with nothing for what is done yet. An operation whose hours do
// not read is counted, logged, and named in the center's findings, and the others still count.
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const {find, one, rows, ms, denied, dateText} = lib
const policy = ec.resource.script("component://mr-mantle/service/mantle/product/MethodPolicy.js")
const facilityScope = ec.resource.script("component://mr-mantle/service/mantle/facility/FacilityScope.js")

const FACILITY = "mantle.facility.Facility"
const CENTER = "mantle.work.production.WorkCenter"
const CAPACITY = "mantle.work.production.WorkCenterCapacity"
const WORK = "mantle.work.effort.WorkEffort"
const LINE = "mantle.work.production.ProductionRunLine"
// the operations of a released run that still take the center's time
const openStatuses = ["WeApproved", "WeInProgress", "WeOnHold"]
const defaultDays = 14
const maxDays = 366
const hourMs = 3600000

const blank = value => value == null || String(value).trim() === ""
const decimal = value => toDecimal(value == null || value === "" ? 0 : value)
const rounded = value => Math.round(value * 100) / 100
const facilityName = facility => (facility ? facility.facilityName || facility.facilityId : "")
const like = (field, term) =>
    ec.entity.conditionFactory
        .makeCondition(field, "like", "%" + String(term).replace(/[\\%_]/g, character => "\\" + character) + "%")
        .ignoreCase()

// The range: fromDate (now) through thruDate (fromDate and two weeks), at most a year.
function rangeOf(p) {
    const fromMs = blank(p.fromDate) ? ms(ec.user.nowTimestamp) : ms(p.fromDate)
    const thruMs = blank(p.thruDate) ? fromMs + defaultDays * 24 * hourMs : ms(p.thruDate)
    if (!Number.isFinite(fromMs) || !Number.isFinite(thruMs) || thruMs <= fromMs)
        throw new Error("The range ends after it starts")
    if (thruMs - fromMs > maxDays * 24 * hourMs) throw new Error("The range is at most a year")
    return {fromMs, thruMs, hours: (thruMs - fromMs) / hourMs}
}
// The centers of the user's organizations, by facility, plant and text: a find used once.
function centerFind(userScope, p) {
    const centerIds = Array.from(find(CENTER).selectField("facilityId").list()).map(row => row.facilityId)
    let query = find(FACILITY).condition("facilityId", "in", centerIds.length ? centerIds : ["_NA_"])
    if (userScope.organizationPartyIds) query = query.condition("ownerPartyId", "in", userScope.organizationPartyIds)
    if (!blank(p.facilityId)) query = query.condition("facilityId", p.facilityId)
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

// The hours of a released operation: its routing operation's standards as of the run's method date, for the run's output
// quantity in the operation's batch unit.
function operationHours(operation, run, cache) {
    const date = run.productionMethodDate || run.productionReleaseDate
    const routingOperation = one(WORK, {workEffortId: operation.routingOperationWorkEffortId || "_NA_"})
    if (!routingOperation) throw new Error("its routing operation is not found")
    const assoc = rows("mantle.work.effort.WorkEffortAssoc", {
        workEffortId: routingOperation.parentWorkEffortId,
        toWorkEffortId: routingOperation.workEffortId,
        workEffortAssocTypeEnumId: "WeatRoutingComp"
    }).filter(row => lib.active(row, date))[0]
    if (!assoc) throw new Error("its routing operation has no released standards on " + dateText(date))
    if (!cache.has(run.workEffortId)) {
        const output = rows(LINE, {workEffortId: run.workEffortId, lineRoleEnumId: "PrlrOutput"})[0]
        cache.set(run.workEffortId, output || null)
    }
    const output = cache.get(run.workEffortId)
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
// The released operations at the centers over the range: an operation counts when its run is released and it overlaps the
// range by its estimated dates, or has none.
function releasedOperations(centerIds, range) {
    if (!centerIds.length) return []
    const factory = ec.entity.conditionFactory
    const from = new Date(range.fromMs)
    const thru = new Date(range.thruMs)
    return Array.from(
        find(WORK)
            .condition("workCenterFacilityId", "in", centerIds)
            .condition("workEffortTypeEnumId", "WetTask")
            .condition("statusId", "in", openStatuses)
            .condition(
                factory.makeCondition(
                    [
                        factory.makeCondition("estimatedStartDate", "is-null", null),
                        factory.makeCondition("estimatedStartDate", "less", thru)
                    ],
                    "or"
                )
            )
            .condition(
                factory.makeCondition(
                    [
                        factory.makeCondition("estimatedCompletionDate", "is-null", null),
                        factory.makeCondition("estimatedCompletionDate", "greater-equals", from)
                    ],
                    "or"
                )
            )
            .list()
    )
}
// A center's slots and rate capacities in effect at the start of the range.
function capacityOf(facilityId, range) {
    const workCenters = ec.resource.script("component://mr-mantle/service/mantle/work/WorkCenters.js")
    const date = new Date(range.fromMs)
    const inEffect = rows(CAPACITY, {facilityId}).filter(row => lib.active(row, date))
    const slots = inEffect
        .filter(row => row.capacityBasisEnumId === "WccbSlots" && !row.productId && !row.productTypeEnumId)
        .map(row => Number(row.parallelSlots || 0))
    return {
        parallelSlots: slots.length ? Math.max(...slots) : 1,
        slotsConfigured: slots.length > 0,
        rateCapacities: inEffect.filter(row => row.capacityBasisEnumId === "WccbRate").map(workCenters.capacityRow)
    }
}

// get#WorkCenterLoad: the user's work centers (by facility, plant or text, a page at a time) with their capacity and load.
function load(p) {
    if (!lib.access.has("PRODUCTION_VIEW")) denied("PERMISSION_DENIED", "PRODUCTION_VIEW is required")
    const userScope = facilityScope.scope()
    if (!blank(p.facilityId)) {
        const facility = one(FACILITY, {facilityId: p.facilityId})
        if (!facility || !facilityScope.owns(userScope, facility.ownerPartyId) || !one(CENTER, {facilityId: p.facilityId}))
            denied("RECORD_UNAVAILABLE", "Work center " + p.facilityId + " is not available")
    }
    const range = rangeOf(p)
    const paged = lib.page(centerFind(userScope, p), p, "centerList", centerFind(userScope, p).count())
    const centerIds = paged.rows.map(row => row.facilityId)
    const byCenter = new Map(centerIds.map(id => [id, []]))
    for (const operation of releasedOperations(centerIds, range)) byCenter.get(operation.workCenterFacilityId)?.push(operation)
    const runs = new Map()
    const outputs = new Map()
    const runOf = workEffortId => {
        if (!runs.has(workEffortId)) runs.set(workEffortId, one(WORK, {workEffortId}))
        return runs.get(workEffortId)
    }
    const centerList = paged.rows.map(facility => {
        const center = one(CENTER, {facilityId: facility.facilityId})
        const plantId = center.plantFacilityId || facility.parentFacilityId
        const plant = plantId ? one(FACILITY, {facilityId: plantId}) : null
        const efficiency = center.efficiencyPercent == null ? 100 : decimal(center.efficiencyPercent).toNumber()
        const capacity = capacityOf(facility.facilityId, range)
        const nominalHours = capacity.parallelSlots * range.hours * (efficiency / 100)
        let loadHours = 0
        let operationCount = 0
        const findings = []
        for (const operation of byCenter.get(facility.facilityId)) {
            const run = runOf(operation.rootWorkEffortId || operation.parentWorkEffortId)
            // only a released run's operations: a draft has none, and anything else under the center is not production work
            if (!run || run.purposeEnumId !== "WepProductionRun" || run.productionReleaseDate == null) continue
            operationCount++
            try {
                loadHours += operationHours(operation, run, outputs)
            } catch (error) {
                ec.logger.error("Work center load of operation " + operation.workEffortId + ": " + error.message)
                findings.push({
                    workEffortId: operation.workEffortId,
                    message: "No hours for " + operation.workEffortId + ": " + error.message
                })
            }
        }
        return {
            facilityId: facility.facilityId,
            facilityName: facilityName(facility),
            facilityTypeEnumId: facility.facilityTypeEnumId,
            plantFacilityId: plantId || null,
            plantName: plant && facilityScope.owns(userScope, plant.ownerPartyId) ? facilityName(plant) : "",
            efficiencyPercent: String(efficiency),
            parallelSlots: capacity.parallelSlots,
            slotsConfigured: capacity.slotsConfigured,
            capacityText: capacity.rateCapacities.map(row => row.capacityText + " · " + row.appliesToText).join("; "),
            nominalHours: String(rounded(nominalHours)),
            loadHours: String(rounded(loadHours)),
            operationCount,
            utilizationPercent: nominalHours > 0 ? String(rounded((loadHours / nominalHours) * 100)) : null,
            findings
        }
    })
    return Object.assign({}, paged, {
        rows: undefined,
        centerList,
        fromDate: new Date(range.fromMs),
        thruDate: new Date(range.thruMs),
        rangeText: dateText(new Date(range.fromMs)) + " to " + dateText(new Date(range.thruMs)),
        rangeHours: String(rounded(range.hours))
    })
}

const operations = {load}
;({
    execute: (op, parameters) => {
        if (!operations[op]) throw new Error("Unknown production planning operation " + op)
        return operations[op](parameters)
    }
})
