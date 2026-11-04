// Manufacturing's reports (design-manufacturing §9, §12 M10; impl-manufacturing P16): mantle.work.ProductionReportServices'
// eight read-only reports and get#ProductionDashboard, the Home Kpis and the provider Insights registers (crosscut §3.17).
//
// Every report checks PRODUCTION_VIEW and reads only the user's organizations and their facilities (FacilityScope.js; a run
// by its owner and facility, as find#ProductionOrders does, F3). It answers its scope (organizations, facility, period), its
// as-of time, the units of its quantities and the currencies of its amounts, and the partitions it could not read: each
// independent source or record (a work order, a work center, the cost events, the machine runtime) is read on its own,
// and one that fails is named with its error and leaves the report incomplete (complete false), its figures out of the totals
// rather than counted as zero. Money columns (amounts, rates, values) need ACCOUNTING_VIEW: without it they are left out of
// the rows and totals, never zero, and withheldText says so. Totals are per unit and per currency, never adding unlike units.
// No report posts or changes anything.
//
// - get#ProductionStatusReport (WorkOrderStatusReport): the runs by status, due date, product, center and assignee, each
//   with its target, good, remaining, days late and what blocks it (find#ProductionOrders' rows).
// - get#ProductionMaterialReport (MaterialReport): each run line's required, issued, returned and net quantity (material),
//   or good and held (output), with its lots and facilities.
// - get#OperationPerformanceReport (OperationPerformanceReport): each work center's OEE over a period, availability ×
//   performance × quality (below), with its planned, downtime, run, machine and labor hours and its counts; and the
//   downtime by reason.
// - get#ProductionLossReport (LossReport): good, scrap, process loss and rework by product, reason and type, the loss rate,
//   the loss's cost (financial read) and the trend by week.
// - get#ProductionQualityReport (QualityReport): production inspections by template and product: samples, readings, the
//   failure rate, holds, re-inspections and the hours to disposition.
// - get#ProductionCostReport (ProductionCostReport): each run's cost by component, output relief, WIP, the cost close's
//   output allocation and variance with its GL transactions (all financial read), and the frozen estimate (with Products'
//   cost read too).
// - get#BomVarianceReport (BillOfMaterialsVarianceReport): each released run's material lines, planned against net issued,
//   substitutes, and the usage variance at actual cost (financial read); each run's yield and planned against actual time.
// - get#ProductionPlanningReport (PlanningReport): the suggestions of the current supply plans (P13's PlanningRun), with
//   required, available, held, suggested and converted quantities, provenance and the plan's freshness.
// - get#ProductionDashboard: the Kpis: completed in the period, on-time completion, OEE, scrap rate and WIP value
//   (financial read), each with the report and filters it opens.
//
// OEE of a work center over a period (design OperationPerformanceReport):
// - planned production time: its work hours in the period (ProductionCalendar.js; around the clock without a calendar,
//   named) less its planned stops and planned outages, times its parallel slots;
// - downtime: its unplanned stops and outages (P11), unioned so an overlap counts once, within the planned time;
// - run time: its machine runtime (P10's MachineRuntimeEvent, unioned per machine) within the planned time and outside the
//   downtime, when any is recorded; else the planned time less the downtime, named;
// - availability = run time / planned time;
// - performance = the ideal hours of every unit counted (the routing operation's standard hours for its run's quantity,
//   per unit) / run time;
// - quality = good / every unit counted, by the units' ideal hours (or by count when they share one unit);
// - the units: an operation's good and lost quantities from its completion (P10) when it has them, else its run's
//   quantity events in the period (P7): good, held, scrap, process loss and rework, each unit once. A rework run's output
//   is left out, since its units were counted as rework where they were made. Held output is outside accepted good
//   (design §3 Quantities): a unit still held is counted but not good, one released is good and one scrapped from held is scrap.
// A factor whose figures are missing (no planned time, no units, an operation without standards) is "Not calculable", never
// zero, with the reason; OEE is then not calculable either.
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const facilityScope = ec.resource.script("component://mr-mantle/service/mantle/facility/FacilityScope.js")
const time = ec.resource.script("component://mr-mantle/service/mantle/work/ProductionCalendar.js")
const {find, one, rows, denied, access, ms, dateText} = lib
const orders = () => ec.resource.script("component://mr-mantle/service/mantle/work/ProductionOrders.js")
const production = () => ec.resource.script("component://mr-mantle/service/mantle/work/Production.js")
const quantities = () => ec.resource.script("component://mr-mantle/service/mantle/work/ProductionQuantities.js")
const planningLoad = () => ec.resource.script("component://mr-mantle/service/mantle/work/ProductionPlanning.js")
const supplyPlanning = () => ec.resource.script("component://mr-mantle/service/mantle/product/SupplyPlanning.js")

const WORK = "mantle.work.effort.WorkEffort",
    LINE = "mantle.work.production.ProductionRunLine",
    QEVENT = "mantle.work.production.ProductionQuantityEvent",
    LOSS = "mantle.work.production.ProductionLoss",
    COST_EVENT = "mantle.work.production.ProductionCostEvent",
    ALLOCATION = "mantle.work.production.ProductionCostAllocation",
    CENTER = "mantle.work.production.WorkCenter",
    ISSUANCE = "mantle.product.issuance.AssetIssuance",
    RECEIPT = "mantle.product.receipt.AssetReceipt",
    ASSET = "mantle.product.asset.Asset",
    PRODUCT = "mantle.product.Product",
    FACILITY = "mantle.facility.Facility",
    TIME_ENTRY = "mantle.work.time.TimeEntry",
    INSPECTION = "mantle.product.quality.QualityInspection",
    READING = "mantle.product.quality.InspectionReading",
    DISPOSITION = "mantle.product.quality.QualityInspectionDisposition",
    TEMPLATE = "mantle.product.quality.InspectionTemplate",
    STANDARD = "mantle.product.cost.ProductStandardCost",
    PLAN_RUN = "mantle.request.requirement.PlanningRun",
    PLAN_RUN_FACILITY = "mantle.request.requirement.PlanningRunFacility",
    SUGGESTION = "mantle.request.requirement.PlanningSuggestion",
    STATUS = "moqui.basic.StatusItem",
    ENUM = "moqui.basic.Enumeration",
    UOM = "moqui.basic.Uom"
// the shop floor's machine runtime (P10's record#MachineRuntime), apart from a person's time
const RUNTIME = "mantle.work.production.MachineRuntimeEvent"

const openStatuses = ["WeInPlanning", "WeApproved", "WeInProgress", "WeOnHold"]
const doneStatuses = ["WeComplete", "WeClosed"]
const countedEventTypes = ["PqetGood", "PqetPending", "PqetScrap", "PqetProcessLoss", "PqetRework"]
const runCap = 2000
const defaultDays = 30
const maxDays = 366
const hourMs = 3600000
const dayMs = 24 * hourMs
const notCalculable = "Not calculable"

const zero = () => toDecimal(0)
const dec = value => toDecimal(value == null || value === "" ? 0 : value)
const blank = value => value == null || String(value).trim() === ""
const str = value => (blank(value) ? null : String(value).trim())
const yes = value => value === true || value === "true" || value === "Y"
const num = value => (value == null ? null : Number(dec(value).toNumber()))
const round = (value, places = 2) => (value == null ? null : Math.round(value * 10 ** places) / 10 ** places)
const percentText = value => (value == null ? notCalculable : (Math.round(value * 1000) / 10).toFixed(1) + "%")
const idList = value =>
    value == null
        ? []
        : (Array.isArray(value) ? value : String(value).split(",")).map(item => String(item).trim()).filter(Boolean)
const unique = list => Array.from(new Set(list.filter(item => item != null && item !== "")))
const byId = (list, field) => new Map(list.map(row => [row[field], row]))
function rowsIn(entity, field, ids, conditions = {}) {
    const values = unique(ids)
    if (!values.length) return []
    const out = []
    for (let start = 0; start < values.length; start += 500)
        out.push(
            ...Array.from(
                find(entity, conditions)
                    .condition(field, "in", values.slice(start, start + 500))
                    .list()
            )
        )
    return out
}

// ===== the call: scope, partitions, units, currencies and the answer =====
function requireView() {
    if (!access.has("PRODUCTION_VIEW")) denied("PERMISSION_DENIED", "PRODUCTION_VIEW is required")
}
// The facility and the facilities under it (a plant's lines and their sub-facilities, four levels).
function facilityTree(facilityId) {
    const ids = [facilityId]
    let level = [facilityId]
    for (let depth = 0; depth < 4 && level.length; depth++) {
        level = Array.from(find(FACILITY).condition("parentFacilityId", "in", level).selectField("facilityId").list())
            .map(row => row.facilityId)
            .filter(id => !ids.includes(id))
        ids.push(...level)
    }
    return ids
}
// A day or a stamp from a parameter; a "through" day at midnight is through the end of that day.
function periodOf(p, days = defaultDays) {
    const now = ec.user.nowTimestamp
    let thruMs = blank(p.thruDate) ? ms(now) : ms(p.thruDate)
    if (!blank(p.thruDate) && ec.l10n.format(new Date(thruMs), "HH:mm:ss.SSS") === "00:00:00.000") thruMs += dayMs
    const fromMs = blank(p.fromDate) ? thruMs - days * dayMs : ms(p.fromDate)
    if (!Number.isFinite(fromMs) || !Number.isFinite(thruMs)) denied("PERIOD_INVALID", "Give the period as dates")
    if (thruMs <= fromMs) denied("PERIOD_INVALID", "The period's end must come after its start")
    if (thruMs - fromMs > maxDays * dayMs) denied("PERIOD_TOO_LONG", "A report covers at most " + maxDays + " days")
    return {fromMs, thruMs, fromDate: new Date(fromMs), thruDate: new Date(thruMs)}
}
// The report's call context: the user's scope narrowed to the organization and facility asked for (one outside it is refused
// as missing), the period, financial read, and what it gathers as it reads (partitions not read, units, currencies).
function begin(p, options = {}) {
    requireView()
    if (!ec.user.userId) denied("PERMISSION_DENIED", "A signed-in user is required")
    const userScope = facilityScope.scope()
    const organizationPartyId = str(p.organizationPartyId)
    if (organizationPartyId && !facilityScope.owns(userScope, organizationPartyId))
        denied("RECORD_UNAVAILABLE", "Organization " + organizationPartyId + " is not available")
    const facilityId = str(p.facilityId)
    const facility = facilityId ? one(FACILITY, {facilityId}) : null
    if (facilityId && (!facility || !facilityScope.owns(userScope, facility.ownerPartyId)))
        denied("RECORD_UNAVAILABLE", "Facility " + facilityId + " is not available")
    const organizationPartyIds = organizationPartyId ? [organizationPartyId] : userScope.organizationPartyIds
    return {
        p,
        userScope,
        organizationPartyIds,
        facility,
        facilityIds: facility ? facilityTree(facility.facilityId) : null,
        period: options.period === false ? null : periodOf(p, options.days),
        financialRead: access.has("ACCOUNTING_VIEW"),
        costRead: ["PRODUCT_COST_VIEW", "PRODUCT_COST_ESTIMATE", "PRODUCT_COST_APPROVE"].some(access.has),
        now: ec.user.nowTimestamp,
        partitions: [],
        units: new Set(),
        currencies: new Set(),
        withheld: []
    }
}
// A query's rows, at most cap of them: a larger set is named as a partition not read in full, so the totals are marked
// incomplete rather than cut silently.
function cappedList(report, name, query, cap) {
    const list = Array.from(query.limit(cap + 1).list())
    if (list.length > cap) {
        report.partitions.push({name, message: "More than " + cap + " match; the first " + cap + " are read. Narrow the filters"})
        list.length = cap
    }
    return list
}
// Read one independent partition: its value, or null with the partition named (and logged) when it fails.
function partition(report, name, read) {
    try {
        return read()
    } catch (error) {
        const message = String(error?.message || error)
        ec.logger.error("Production report partition " + name + " not read: " + message)
        report.partitions.push({name, message})
        return null
    }
}
function unitText(uomId) {
    if (!uomId) return ""
    const uom = one(UOM, {uomId})
    return uom ? uom.abbreviation || uom.description || uomId : uomId
}
function finish(report, answer) {
    const p = report.period
    const organizationNames = report.organizationPartyIds ? lib.partyNames(report.organizationPartyIds) : {}
    const scope = {
        organizationPartyIds: report.organizationPartyIds,
        organizationText: report.organizationPartyIds
            ? report.organizationPartyIds.map(id => organizationNames[id] || id).join(", ")
            : "Every organization",
        facilityId: report.facility?.facilityId || null,
        facilityText: report.facility ? report.facility.facilityName || report.facility.facilityId : "Every facility",
        fromDate: p ? p.fromDate : null,
        thruDate: p ? p.thruDate : null,
        periodText: p ? dateText(p.fromDate) + " to " + dateText(new Date(p.thruMs - 1)) : ""
    }
    const unitList = Array.from(report.units)
        .filter(Boolean)
        .sort()
        .map(uomId => ({uomId, unitText: unitText(uomId)}))
    const currencyUomIds = report.financialRead ? Array.from(report.currencies).filter(Boolean).sort() : []
    return Object.assign(
        {
            scope,
            asOf: report.now,
            asOfText: dateText(report.now),
            unitList,
            unitsText: unitList.map(row => row.unitText).join(", "),
            currencyUomIds,
            currencyText: currencyUomIds.join(", "),
            partitions: report.partitions,
            partitionsText: report.partitions.map(row => row.name + ": " + row.message).join("; "),
            complete: report.partitions.length === 0,
            financialRead: report.financialRead,
            withheldText: report.withheld.length ? "Left out without financial read: " + report.withheld.join(", ") : ""
        },
        answer
    )
}
// The Monday of a stamp's week, in the user's zone, as yyyy-MM-dd.
function weekOf(stamp) {
    const [year, month, day] = ec.l10n
        .format(new Date(ms(stamp)), "yyyy-MM-dd")
        .split("-")
        .map(Number)
    const date = new Date(Date.UTC(year, month - 1, day))
    date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7))
    return lib.calendarDateText(date)
}
const pagedOf = (report, list, field) => lib.pageList(list, report.p, field, {noLimitCap: runCap})

// ===== runs =====
// The runs of the report's scope (owner and facility), with more conditions, at most runCap of them: a larger set is named
// as a partition not read in full, so its totals are incomplete rather than cut silently.
function runsOf(report, conditions = q => q, orderBy = "workEffortId") {
    const build = () => {
        let query = find(WORK, {purposeEnumId: "WepProductionRun"})
        if (report.organizationPartyIds) query = query.condition("ownerPartyId", "in", report.organizationPartyIds)
        if (report.facilityIds) query = query.condition("facilityId", "in", report.facilityIds)
        return conditions(query)
    }
    const count = build().count()
    if (count > runCap)
        report.partitions.push({
            name: "Work orders",
            message: count + " match; the first " + runCap + " are read. Narrow the period, facility or product"
        })
    return Array.from(build().orderBy(orderBy).limit(runCap).list()).filter(run => {
        const facility = run.facilityId ? one(FACILITY, {facilityId: run.facilityId}) : null
        return !facility || facilityScope.owns(report.userScope, facility.ownerPartyId)
    })
}
// The runs whose output (or, with any, whose any line) is the product.
function runIdsOfProduct(productId, anyLine = false) {
    const conditions = anyLine ? {productId} : {productId, lineRoleEnumId: "PrlrOutput"}
    return Array.from(find(LINE, conditions).selectField("workEffortId").distinct(true).list()).map(row => row.workEffortId)
}
const narrowTo = ids => query => query.condition("workEffortId", "in", ids.length ? ids : ["_NONE_"])
const outputsOf = runIds => byId(rowsIn(LINE, "workEffortId", runIds, {lineRoleEnumId: "PrlrOutput"}), "workEffortId")
function namesOf(entity, field, ids, label) {
    return new Map(rowsIn(entity, field, ids).map(row => [row[field], label(row)]))
}
const productNames = ids => namesOf(PRODUCT, "productId", ids, row => row.productName || row.pseudoId || row.productId)
const facilityNames = ids => namesOf(FACILITY, "facilityId", ids, row => row.facilityName || row.facilityId)
function enumTexts() {
    const cache = new Map()
    return enumId => {
        if (!enumId) return ""
        if (!cache.has(enumId)) cache.set(enumId, one(ENUM, {enumId})?.description || enumId)
        return cache.get(enumId)
    }
}
function statusTexts() {
    const cache = new Map()
    return statusId => {
        if (!statusId) return ""
        if (!cache.has(statusId)) cache.set(statusId, one(STATUS, {statusId})?.description || statusId)
        return cache.get(statusId)
    }
}
const runLabel = run => (run.workEffortName ? run.workEffortId + " " + run.workEffortName : run.workEffortId)
// Totals per key (a unit, a currency): each named figure summed, a missing figure left out of its sum.
function totalsBy(list, keyOf, fields, extra = () => ({})) {
    const totals = new Map()
    for (const row of list) {
        const key = keyOf(row)
        if (!totals.has(key)) totals.set(key, Object.assign({rowCount: 0}, extra(row)))
        const total = totals.get(key)
        total.rowCount++
        for (const field of fields) if (row[field] != null) total[field] = round((total[field] || 0) + row[field], 6)
    }
    return Array.from(totals.values())
}

// ===== get#ProductionStatusReport =====
function statusReport(p) {
    const report = begin(p, {period: false})
    const found = partition(report, "Work orders", () =>
        orders().execute("find", {
            organizationPartyId: p.organizationPartyId,
            facilityId: p.facilityId,
            productId: p.productId,
            statusId: blank(p.statusId) ? null : idList(p.statusId).join(","),
            assigneePartyId: p.assigneePartyId,
            dueFrom: p.dueFrom,
            dueThru: p.dueThru,
            pageNoLimit: true
        })
    ) || {orderRows: []}
    if (found.orderRowsCount > runCap)
        report.partitions.push({name: "Work orders", message: found.orderRowsCount + " match; the first " + runCap + " are read"})
    const orderRows = Array.from(found.orderRows || [])
    const runs =
        partition(report, "Completion dates", () =>
            byId(
                rowsIn(
                    WORK,
                    "workEffortId",
                    orderRows.map(row => row.workEffortId)
                ),
                "workEffortId"
            )
        ) || null
    const outputs = outputsOf(orderRows.map(row => row.workEffortId))
    const nowMs = ms(report.now)
    // completed in a period (the Kpis' Completed and On-time completion open it so)
    const completedFrom = blank(p.completedFrom) ? null : ms(p.completedFrom)
    let completedThru = blank(p.completedThru) ? null : ms(p.completedThru)
    if (completedThru != null && ec.l10n.format(new Date(completedThru), "HH:mm:ss.SSS") === "00:00:00.000")
        completedThru += dayMs
    const completedIn = run =>
        (completedFrom == null && completedThru == null) ||
        (!!run?.actualCompletionDate &&
            (completedFrom == null || ms(run.actualCompletionDate) >= completedFrom) &&
            (completedThru == null || ms(run.actualCompletionDate) < completedThru))
    if ((completedFrom != null || completedThru != null) && !runs)
        report.partitions.push({name: "Completed in the period", message: "The completion dates were not read"})
    const statusRows = orderRows
        .filter(row => !runs || completedIn(runs.get(row.workEffortId)))
        .map(row => {
            const run = runs ? runs.get(row.workEffortId) : null
            const output = outputs.get(row.workEffortId)
            const stockUomId = output?.stockUomId || output?.quantityUomId || null
            report.units.add(stockUomId)
            const dueMs = row.estimatedCompletionDate ? ms(row.estimatedCompletionDate) : null
            const doneMs = run?.actualCompletionDate ? ms(run.actualCompletionDate) : null
            const late =
                dueMs != null && (doneMs != null ? doneMs > dueMs : !doneStatuses.includes(row.statusId) && nowMs > dueMs)
            const delayDays = !runs ? null : late ? Math.ceil(((doneMs ?? nowMs) - dueMs) / dayMs) : 0
            const target = output ? num(output.stockQuantity) : null
            return {
                workEffortId: row.workEffortId,
                workEffortName: row.workEffortName,
                productId: row.productId,
                productName: row.productName,
                facilityName: row.facilityName,
                statusId: row.statusId,
                statusText: row.statusText,
                statusColor: row.statusColor,
                targetQuantity: target,
                goodQuantity: row.good == null ? null : Number(row.good),
                remainingQuantity: row.remaining == null ? null : Number(row.remaining),
                stockUomId,
                unitText: unitText(stockUomId),
                dueText: row.dueText,
                completedText: run ? dateText(run.actualCompletionDate) : "",
                late,
                delayDays,
                delayText: delayDays == null ? "Unavailable" : late ? delayDays + (delayDays === 1 ? " day" : " days") : "",
                blockText: row.readiness === "On hold" || row.readiness === "Short component" ? row.readiness : ""
            }
        })
    const totalRows = totalsBy(
        statusRows,
        row => row.stockUomId || "",
        ["targetQuantity", "goodQuantity", "remainingQuantity"],
        row => ({
            stockUomId: row.stockUomId,
            unitText: row.unitText
        })
    )
    for (const total of totalRows) {
        const own = statusRows.filter(row => (row.stockUomId || "") === (total.stockUomId || ""))
        total.lateCount = own.filter(row => row.late).length
        total.blockedCount = own.filter(row => row.blockText).length
    }
    const statusCounts = totalsBy(
        statusRows,
        row => row.statusId,
        [],
        row => ({statusId: row.statusId, statusText: row.statusText})
    )
    return finish(report, Object.assign({totalRows, statusCounts}, pagedOf(report, statusRows, "statusRows")))
}

// ===== get#ProductionMaterialReport =====
function materialReport(p) {
    const report = begin(p)
    const {fromDate, thruDate} = report.period
    const movement = str(p.movementType)
    let runIds
    if (!blank(p.workEffortId)) runIds = [p.workEffortId]
    else {
        // the runs with a movement in the period: an issue to one of its material lines or a receipt of its output
        const issued = Array.from(
            find(ISSUANCE)
                .condition("productionMaterialLineId", "is-not-null", null)
                .condition("issuedDate", "greater-equals", fromDate)
                .condition("issuedDate", "less-than", thruDate)
                .selectField("workEffortId")
                .distinct(true)
                .list()
        ).map(row => row.workEffortId)
        const received = Array.from(
            find(RECEIPT)
                .condition("workEffortId", "is-not-null", null)
                .condition("receivedDate", "greater-equals", fromDate)
                .condition("receivedDate", "less-than", thruDate)
                .selectField("workEffortId")
                .distinct(true)
                .list()
        ).map(row => row.workEffortId)
        runIds = unique(movement === "issue" ? issued : movement === "receipt" ? received : issued.concat(received))
    }
    if (!blank(p.productId)) {
        const ofProduct = new Set(runIdsOfProduct(p.productId, true))
        runIds = runIds.filter(id => ofProduct.has(id))
    }
    const runs = runsOf(report, narrowTo(runIds))
    const products = productNames(
        rowsIn(
            LINE,
            "workEffortId",
            runs.map(run => run.workEffortId)
        ).map(line => line.productId)
    )
    const lineRows = []
    for (const run of runs)
        partition(report, "Work order " + run.workEffortId, () => {
            const lines = production().linesOf(run.workEffortId)
            const losses = rows(LOSS, {workEffortId: run.workEffortId})
            for (const line of lines) {
                if (!blank(p.productId) && line.productId !== p.productId) continue
                const material = line.lineRoleEnumId === "PrlrMaterial"
                if (movement && (movement === "receipt") === material) continue
                const stockUomId = line.stockUomId || line.quantityUomId || null
                const row = {
                    workEffortId: run.workEffortId,
                    workEffortName: run.workEffortName || "",
                    productionRunLineId: line.productionRunLineId,
                    roleText: material ? "Material" : line.lineRoleEnumId === "PrlrByproduct" ? "By-product" : "Output",
                    productId: line.productId,
                    productName: products.get(line.productId) || line.productId,
                    requiredQuantity: num(line.stockQuantity),
                    stockUomId,
                    unitText: unitText(stockUomId)
                }
                let assets
                if (material) {
                    const totals = production().materialTotals(line)
                    const issuances = rows(ISSUANCE, {productionMaterialLineId: line.productionRunLineId})
                    if (movement === "return" && totals.returned.compare(0) === 0) continue
                    Object.assign(row, {
                        issuedQuantity: num(totals.issued),
                        returnedQuantity: num(totals.returned),
                        netQuantity: num(totals.net),
                        remainingQuantity: num(totals.remaining)
                    })
                    assets = rowsIn(
                        ASSET,
                        "assetId",
                        issuances.map(issuance => issuance.assetId)
                    )
                } else {
                    const figures = quantities().outputFigures(run, line, losses)
                    Object.assign(row, {
                        goodQuantity: num(figures.good),
                        heldQuantity: num(figures.held),
                        remainingQuantity: num(figures.remaining)
                    })
                    assets = rowsIn(
                        ASSET,
                        "assetId",
                        rows(RECEIPT, {productionOutputLineId: line.productionRunLineId}).map(receipt => receipt.assetId)
                    )
                }
                if (!blank(p.lotId) && !assets.some(asset => asset.lotId === p.lotId)) continue
                const facilities = facilityNames(assets.map(asset => asset.facilityId))
                row.lotText = unique(assets.map(asset => asset.lotId)).join(", ")
                row.facilityText = unique(assets.map(asset => facilities.get(asset.facilityId))).join(", ")
                report.units.add(stockUomId)
                lineRows.push(row)
            }
        })
    // lineage: an output's component lots, from the material lines of the same run
    for (const row of lineRows.filter(row => row.roleText !== "Material"))
        row.lineageText = unique(
            lineRows
                .filter(other => other.workEffortId === row.workEffortId && other.roleText === "Material" && other.lotText)
                .map(other => other.productName + " " + other.lotText)
        ).join("; ")
    const totalRows = totalsBy(
        lineRows,
        row => row.roleText + "|" + (row.stockUomId || ""),
        ["requiredQuantity", "issuedQuantity", "returnedQuantity", "netQuantity", "goodQuantity", "heldQuantity"],
        row => ({roleText: row.roleText, stockUomId: row.stockUomId, unitText: row.unitText})
    )
    return finish(report, Object.assign({totalRows}, pagedOf(report, lineRows, "lineRows")))
}

// ===== get#OperationPerformanceReport: OEE =====
const intervalHours = list => time.hoursOf(list)
// The work centers of the scope: the facility asked for (a center, or the centers under a plant), else every center of
// the user's organizations.
function centersOf(report) {
    let query = find(CENTER)
    if (report.facilityIds) query = query.condition("facilityId", "in", report.facilityIds)
    const centerRows = cappedList(report, "Work centers", query, 500)
    const facilities = byId(
        rowsIn(
            FACILITY,
            "facilityId",
            centerRows.map(row => row.facilityId)
        ),
        "facilityId"
    )
    return centerRows
        .map(row => facilities.get(row.facilityId))
        .filter(facility => facility && facilityScope.owns(report.userScope, facility.ownerPartyId))
        .filter(facility => !report.organizationPartyIds || report.organizationPartyIds.includes(facility.ownerPartyId))
        .sort((a, b) => String(a.facilityName || a.facilityId).localeCompare(String(b.facilityName || b.facilityId)))
}
// The units counted at each center: {centerId: [{operation, run, good, total, uomId}]}, from the operations' completions
// (P10's complete#ProductionOperation: good with the held, and the losses) or else their runs' quantity events in the period (P7); rework runs left out;
// held output not good until released (a unit scrapped from held is a loss, counted once).
function creditsOf(report, ctx, centerIds) {
    const {fromDate, thruDate} = report.period
    const credits = new Map(centerIds.map(id => [id, []]))
    const notes = new Map(centerIds.map(id => [id, new Set()]))
    if (!centerIds.length) return {credits, notes}
    // the runs with quantity events in the period, in the scope and of the product asked for
    const events = Array.from(
        find(QEVENT)
            .condition("quantityEventTypeEnumId", "in", countedEventTypes)
            .condition("eventDate", "greater-equals", fromDate)
            .condition("eventDate", "less-than", thruDate)
            .condition(
                ec.entity.conditionFactory.makeCondition(
                    [
                        ec.entity.conditionFactory.makeCondition("approvalStatusEnumId", "is-null", null),
                        ec.entity.conditionFactory.makeCondition("approvalStatusEnumId", "equals", "PapApproved")
                    ],
                    "or"
                )
            )
            .list()
    )
    let runIds = unique(events.map(event => event.workEffortId))
    if (!blank(report.p.productId)) {
        const ofProduct = new Set(runIdsOfProduct(report.p.productId))
        runIds = runIds.filter(id => ofProduct.has(id))
    }
    const reworkRunIds = new Set(
        rowsIn(LOSS, "reworkWorkEffortId", runIds)
            .filter(loss => loss.statusId === "PlsApproved")
            .map(loss => loss.reworkWorkEffortId)
    )
    // a run of the scope's organizations (its operations may be at a center under another plant)
    const runs = byId(
        rowsIn(WORK, "workEffortId", runIds).filter(
            run =>
                run.purposeEnumId === "WepProductionRun" &&
                (!report.organizationPartyIds || report.organizationPartyIds.includes(run.ownerPartyId))
        ),
        "workEffortId"
    )
    const outputs = outputsOf(Array.from(runs.keys()))
    const operations = rowsIn(WORK, "parentWorkEffortId", Array.from(runs.keys()))
    // an operation completed on the shop floor (complete#ProductionOperation) carries its own good and lost quantity
    const hasCounts = operation => operation.productionGoodQuantity != null
    // held output is outside accepted good until it is disposed (design §3 Quantities): a run's output still held now, or
    // scrapped from held, is not good; a released unit is. Per run: its output's held quantity now (Quantities' outputFigures,
    // which the dispositions reduce) and its approved scrap from held, with those losses' ids (their quantity events)
    const heldByRun = new Map()
    const heldOf = run => {
        if (heldByRun.has(run.workEffortId)) return heldByRun.get(run.workEffortId)
        const line = outputs.get(run.workEffortId)
        const out = {held: 0, scrapped: 0, lossIds: new Set()}
        if (line)
            partition(report, "Held output of work order " + run.workEffortId, () => {
                out.held = num(quantities().outputFigures(run, line).held) || 0
                for (const loss of rows(LOSS, {
                    workEffortId: run.workEffortId,
                    productionRunLineId: line.productionRunLineId,
                    lossTypeEnumId: "PltOutputScrap",
                    statusId: "PlsApproved",
                    fromHeld: "Y"
                })) {
                    out.scrapped += num(loss.quantity) || 0
                    out.lossIds.add(loss.productionLossId)
                }
            })
        heldByRun.set(run.workEffortId, out)
        return out
    }
    const heldNote = (centerId, held) => {
        if (held.held > 0 || held.scrapped > 0) notes.get(centerId).add("Held output counts good only once it is released")
    }
    const idealOf = (operation, run) => {
        const output = outputs.get(run.workEffortId)
        if (!output || dec(output.stockQuantity).compare(0) <= 0) throw new Error("its work order has no output quantity")
        return time.operationHours(ctx, operation, run) / num(output.stockQuantity)
    }
    const add = (centerId, operation, run, good, total) => {
        const output = outputs.get(run.workEffortId)
        let ideal = null
        try {
            ideal = idealOf(operation, run)
        } catch (error) {
            notes
                .get(centerId)
                .add(
                    "Operation " +
                        (operation.workEffortName || operation.workEffortId) +
                        " has no standards (" +
                        error.message +
                        ")"
                )
        }
        credits.get(centerId).push({operation, run, good, total, uomId: output?.stockUomId || null, ideal})
    }
    for (const operation of operations) {
        const centerId = operation.workCenterFacilityId
        if (!credits.has(centerId)) continue
        const run = runs.get(operation.parentWorkEffortId)
        if (!run) continue
        if (reworkRunIds.has(run.workEffortId)) {
            notes.get(centerId).add("Rework work orders' output is counted where its units were made")
            continue
        }
        if (hasCounts(operation)) continue
        const own = events.filter(event => event.workEffortId === run.workEffortId)
        const ofType = type =>
            own.filter(event => event.quantityEventTypeEnumId === type).reduce((sum, event) => sum + num(event.quantity), 0)
        // a held unit is counted once: as good when released, as scrap when scrapped from held (its scrap event not again)
        const held = heldOf(run)
        const pending = ofType("PqetPending")
        const scrapFromHeld = own
            .filter(event => event.quantityEventTypeEnumId === "PqetScrap" && held.lossIds.has(event.productionLossId))
            .reduce((sum, event) => sum + num(event.quantity), 0)
        const good = ofType("PqetGood") + Math.max(0, pending - held.held - held.scrapped)
        const total = countedEventTypes.reduce((sum, type) => sum + ofType(type), 0) - Math.min(scrapFromHeld, pending)
        if (total > 0) {
            notes.get(centerId).add("Counts from the work orders' output: each operation is credited with its run's quantities")
            heldNote(centerId, held)
            add(centerId, operation, run, good, total)
        }
    }
    // the operations completed in the period with their own counts (P10)
    for (const operation of rowsIn(WORK, "workCenterFacilityId", centerIds)
        .filter(
            row =>
                row.actualCompletionDate &&
                ms(row.actualCompletionDate) >= ms(fromDate) &&
                ms(row.actualCompletionDate) < ms(thruDate)
        )
        .filter(hasCounts)) {
        const run = one(WORK, {workEffortId: operation.parentWorkEffortId})
        if (!run || run.purposeEnumId !== "WepProductionRun") continue
        if (report.organizationPartyIds && !report.organizationPartyIds.includes(run.ownerPartyId)) continue
        if (!blank(report.p.productId) && !runIdsOfProduct(report.p.productId).includes(run.workEffortId)) continue
        if (reworkRunIds.has(run.workEffortId)) continue
        if (!outputs.has(run.workEffortId))
            outputs.set(run.workEffortId, rows(LINE, {workEffortId: run.workEffortId, lineRoleEnumId: "PrlrOutput"})[0])
        // its completion counts its held output as good (good + pending): what of it is still held or was scrapped from
        // held is not good, the unit counted once
        const produced = num(operation.productionGoodQuantity) || 0
        const pendingHere = rows(QEVENT, {
            operationWorkEffortId: operation.workEffortId,
            quantityEventTypeEnumId: "PqetPending"
        }).reduce((sum, event) => sum + (num(event.quantity) || 0), 0)
        const held = pendingHere > 0 ? heldOf(run) : {held: 0, scrapped: 0}
        const good = Math.max(0, produced - Math.min(pendingHere, held.held + held.scrapped))
        if (pendingHere > 0) heldNote(operation.workCenterFacilityId, held)
        add(operation.workCenterFacilityId, operation, run, good, produced + (num(operation.productionLossQuantity) || 0))
    }
    return {credits, notes}
}
// Each machine's runtime at the centers in the period (P10), as {centerId: [[from, thru]] per machine}.
function runtimeOf(report, centerIds) {
    const {fromDate, thruDate} = report.period
    const nowMs = ms(report.now)
    const out = new Map()
    const factory = ec.entity.conditionFactory
    for (const event of Array.from(
        find(RUNTIME)
            .condition("facilityId", "in", centerIds.length ? centerIds : ["_NONE_"])
            .condition("fromDate", "less-than", thruDate)
            .condition(
                factory.makeCondition(
                    [
                        factory.makeCondition("thruDate", "is-null", null),
                        factory.makeCondition("thruDate", "greater-than", fromDate)
                    ],
                    "or"
                )
            )
            .list()
    )) {
        if (!out.has(event.facilityId)) out.set(event.facilityId, {machines: new Map(), setupHours: 0, runHours: 0})
        const center = out.get(event.facilityId)
        const key = event.assetId || "_CENTER_"
        if (!center.machines.has(key)) center.machines.set(key, [])
        const interval = [ms(event.fromDate), event.thruDate ? ms(event.thruDate) : Math.max(nowMs, ms(event.fromDate))]
        center.machines.get(key).push(interval)
        const inPeriod = intervalHours(time.intersect([interval], [[ms(fromDate), ms(thruDate)]]))
        if (event.runtimeModeEnumId === "MrmSetup") center.setupHours += inPeriod
        else center.runHours += inPeriod
    }
    return out
}
// The labor hours on the centers' operations in the period: {centerId: {setupHours, runHours}}.
function laborOf(report, centerIds) {
    const {fromDate, thruDate} = report.period
    const operations = rowsIn(WORK, "workCenterFacilityId", centerIds).filter(row => row.parentWorkEffortId)
    const centerOf = new Map(operations.map(row => [row.workEffortId, row.workCenterFacilityId]))
    const out = new Map()
    for (const entry of rowsIn(
        TIME_ENTRY,
        "workEffortId",
        operations.map(row => row.workEffortId)
    ).filter(entry => entry.fromDate && ms(entry.fromDate) >= ms(fromDate) && ms(entry.fromDate) < ms(thruDate))) {
        const centerId = centerOf.get(entry.workEffortId)
        if (!out.has(centerId)) out.set(centerId, {setupHours: 0, runHours: 0})
        const hours = num(entry.hours) || 0
        if (entry.workTypeEnumId === "WktpProductionSetup") out.get(centerId).setupHours += hours
        else out.get(centerId).runHours += hours
    }
    return out
}
// One center's OEE over the period, with its hours, counts, factors and what made a factor not calculable.
function centerOee(report, ctx, facility, credits, centerNotes, runtime, labor, downtimeRows) {
    const {fromMs, thruMs} = report.period
    const center = time.centerOf(ctx, facility.facilityId, new Date(fromMs))
    if (!center) throw new Error("its work center is not found")
    const notes = Array.from(centerNotes)
    const calendar = time.calendarOf(ctx, center, fromMs, thruMs)
    if (!calendar.configured) notes.push("No work calendar: its hours count around the clock")
    const offline = time.offlineOf(ctx, center, fromMs, thruMs)
    const plannedOffline = offline.filter(row => row.kind === "planned" || row.kindText === "Planned stop")
    const unplanned = offline.filter(row => !plannedOffline.includes(row))
    const work = time.intersect(calendar.work, [[fromMs, thruMs]])
    const planned = time.subtract(work, time.merge(plannedOffline.map(row => [row.fromMs, row.thruMs])))
    const down = time.intersect(planned, time.merge(unplanned.map(row => [row.fromMs, row.thruMs])))
    const slots = center.parallelSlots
    const plannedHours = intervalHours(planned) * slots
    const plannedStopHours =
        intervalHours(time.intersect(work, time.merge(plannedOffline.map(row => [row.fromMs, row.thruMs])))) * slots
    const downtimeHours = intervalHours(down) * slots
    if (offline.some(row => row.open)) notes.push("A stop or outage is still open: counted until now")
    if (offline.some(row => row.awaitingApproval)) notes.push("Stops awaiting approval are counted as downtime")
    for (const row of offline) {
        const hours = intervalHours(time.intersect([[row.fromMs, row.thruMs]], [[fromMs, thruMs]]))
        const reason = row.reasonText || row.kindText
        if (!blank(report.p.reasonCode) && row.sourceId && row.kind === "downtime") {
            const stop = one("mantle.work.production.ProductionDowntime", {productionDowntimeId: row.sourceId})
            if (stop?.reasonCode !== report.p.reasonCode) continue
        }
        downtimeRows.push({
            facilityId: facility.facilityId,
            facilityName: center.facilityName,
            kindText: row.kindText,
            reasonText: reason,
            planned: plannedOffline.includes(row),
            hours: round(hours),
            sourceId: row.sourceId,
            fromText: dateText(new Date(row.fromMs)),
            thruText: row.open ? "Open" : dateText(new Date(row.thruMs)),
            open: !!row.open
        })
    }
    // run time: the machines' runtime (P10) within the planned time and outside the downtime, else planned less downtime
    const machine = runtime ? runtime.get(facility.facilityId) : null
    let machineHours = null
    if (runtime) {
        machineHours = 0
        if (machine)
            for (const intervals of machine.machines.values())
                machineHours += intervalHours(time.subtract(time.intersect(time.merge(intervals), planned), down))
    }
    const runFromMachines = machineHours != null && machineHours > 0
    if (!runFromMachines) notes.push("Run time is the planned time less the downtime: no machine runtime is recorded")
    const runHours = runFromMachines ? machineHours : Math.max(0, plannedHours - downtimeHours)
    // the units counted, each once, and their ideal hours
    const units = new Set(credits.map(credit => credit.uomId))
    const goodQuantity = credits.reduce((sum, credit) => sum + credit.good, 0)
    const totalQuantity = credits.reduce((sum, credit) => sum + credit.total, 0)
    const withStandards = credits.every(credit => credit.ideal != null)
    const idealTotalHours = withStandards ? credits.reduce((sum, credit) => sum + credit.ideal * credit.total, 0) : null
    const idealGoodHours = withStandards ? credits.reduce((sum, credit) => sum + credit.ideal * credit.good, 0) : null
    const reasons = {}
    const availability = plannedHours > 0 ? runHours / plannedHours : null
    if (availability == null) reasons.availability = "No planned production time in the period"
    let performance = null
    if (!credits.length) reasons.performance = "No units were counted at this center in the period"
    else if (!withStandards) reasons.performance = "An operation has no standard hours"
    else if (!(runHours > 0)) reasons.performance = "No run time"
    else performance = idealTotalHours / runHours
    let quality = null
    if (!(totalQuantity > 0)) reasons.quality = "No units were counted at this center in the period"
    else if (withStandards && idealTotalHours > 0) quality = idealGoodHours / idealTotalHours
    else if (units.size === 1) quality = goodQuantity / totalQuantity
    else reasons.quality = "The units counted are in several units and have no standards to weigh them"
    const oee = availability != null && performance != null && quality != null ? availability * performance * quality : null
    if (oee == null) reasons.oee = "A factor is not calculable"
    const laborHours = labor ? labor.get(facility.facilityId) || {setupHours: 0, runHours: 0} : null
    for (const uomId of units) report.units.add(uomId)
    return {
        facilityId: facility.facilityId,
        facilityName: center.facilityName,
        plannedHours: round(plannedHours),
        plannedStopHours: round(plannedStopHours),
        downtimeHours: round(downtimeHours),
        runHours: round(runHours),
        machineHours: machineHours == null ? null : round(machineHours),
        machineSetupHours: machine ? round(machine.setupHours) : runtime ? 0 : null,
        laborSetupHours: laborHours ? round(laborHours.setupHours) : null,
        laborRunHours: laborHours ? round(laborHours.runHours) : null,
        standardHours: idealTotalHours == null ? null : round(idealTotalHours),
        goodQuantity: units.size === 1 || !credits.length ? round(goodQuantity, 6) : null,
        totalQuantity: units.size === 1 || !credits.length ? round(totalQuantity, 6) : null,
        unitText: Array.from(units).map(unitText).join(", "),
        availability: availability == null ? null : round(availability, 4),
        performance: performance == null ? null : round(performance, 4),
        quality: quality == null ? null : round(quality, 4),
        oee: oee == null ? null : round(oee, 4),
        availabilityText: percentText(availability),
        performanceText: percentText(performance),
        qualityText: percentText(quality),
        oeeText: percentText(oee),
        notCalculableText: Object.values(reasons)
            .filter((value, index, list) => list.indexOf(value) === index)
            .join("; "),
        notesText: unique(notes).join("; "),
        // for the totals: the unit-free sums of a center whose figures are all known
        sums: {plannedHours, runHours, idealTotalHours, idealGoodHours, calculable: oee != null}
    }
}
function oeeReport(p) {
    const report = begin(p, {days: 7})
    const ctx = time.forCall()
    const centers = centersOf(report)
    const centerIds = centers.map(facility => facility.facilityId)
    const counted = partition(report, "Quantities", () => creditsOf(report, ctx, centerIds))
    const runtime = partition(report, "Machine runtime", () => runtimeOf(report, centerIds))
    const labor = partition(report, "Labor time", () => laborOf(report, centerIds))
    const centerRows = []
    const downtimeRows = []
    for (const facility of centers)
        partition(report, "Work center " + (facility.facilityName || facility.facilityId), () => {
            const credits = counted ? counted.credits.get(facility.facilityId) || [] : []
            const notes = counted ? counted.notes.get(facility.facilityId) || new Set() : new Set(["Quantities not read"])
            const row = centerOee(report, ctx, facility, credits, notes, runtime, labor, downtimeRows)
            if (!counted)
                Object.assign(row, {
                    performance: null,
                    quality: null,
                    oee: null,
                    performanceText: notCalculable,
                    qualityText: notCalculable,
                    oeeText: notCalculable
                })
            centerRows.push(row)
        })
    // the plant's figures over the centers whose figures are all known
    const known = centerRows.filter(row => row.sums.calculable)
    const sum = field => known.reduce((total, row) => total + row.sums[field], 0)
    const planned = sum("plannedHours"),
        run = sum("runHours"),
        ideal = sum("idealTotalHours"),
        good = sum("idealGoodHours")
    const totals = {
        centerCount: centerRows.length,
        calculableCount: known.length,
        plannedHours: round(centerRows.reduce((total, row) => total + (row.plannedHours || 0), 0)),
        downtimeHours: round(centerRows.reduce((total, row) => total + (row.downtimeHours || 0), 0)),
        availability: known.length && planned > 0 ? round(run / planned, 4) : null,
        performance: known.length && run > 0 ? round(ideal / run, 4) : null,
        quality: known.length && ideal > 0 ? round(good / ideal, 4) : null,
        oee: known.length && planned > 0 ? round(good / planned, 4) : null
    }
    for (const factor of ["availability", "performance", "quality", "oee"]) totals[factor + "Text"] = percentText(totals[factor])
    totals.notesText =
        known.length === centerRows.length
            ? ""
            : centerRows.length - known.length + " of " + centerRows.length + " work centers are not calculable and are left out"
    for (const row of centerRows) delete row.sums
    const downtimeByReason = totalsBy(
        downtimeRows,
        row => row.facilityId + "|" + row.reasonText + "|" + row.planned,
        ["hours"],
        row => ({
            facilityName: row.facilityName,
            reasonText: row.reasonText,
            kindText: row.planned ? "Planned (excluded)" : row.kindText
        })
    ).map(row => Object.assign(row, {stopCount: row.rowCount}))
    return finish(report, Object.assign({totals, downtimeRows: downtimeByReason}, pagedOf(report, centerRows, "centerRows")))
}

// ===== get#ProductionLossReport =====
const lossFields = {
    PltOutputScrap: "scrapQuantity",
    PltProcessLoss: "processLossQuantity",
    PltRework: "reworkQuantity",
    PltComponentScrap: "componentScrapQuantity"
}
function lossReport(p) {
    const report = begin(p)
    const {fromDate, thruDate} = report.period
    const enumText = enumTexts()
    const statusId = blank(p.statusId) ? "PlsApproved" : p.statusId
    const losses =
        partition(report, "Losses", () => {
            let query = find(LOSS, {statusId})
                .condition("lossDate", "greater-equals", fromDate)
                .condition("lossDate", "less-than", thruDate)
            if (report.organizationPartyIds) query = query.condition("organizationPartyId", "in", report.organizationPartyIds)
            if (!blank(p.productId)) query = query.condition("productId", p.productId)
            if (!blank(p.reasonCode)) query = query.condition("reasonCode", p.reasonCode)
            if (!blank(p.lossTypeEnumId)) query = query.condition("lossTypeEnumId", p.lossTypeEnumId)
            if (!blank(p.operationWorkEffortId)) query = query.condition("operationWorkEffortId", p.operationWorkEffortId)
            return cappedList(report, "Losses", query, 5000)
        }) || []
    const goodEvents =
        partition(report, "Good output", () => {
            let query = find(QEVENT, {quantityEventTypeEnumId: "PqetGood"})
                .condition("eventDate", "greater-equals", fromDate)
                .condition("eventDate", "less-than", thruDate)
            if (!blank(p.operationWorkEffortId)) query = query.condition("operationWorkEffortId", p.operationWorkEffortId)
            return cappedList(report, "Good output", query, 5000)
        }) || null
    // the runs of the scope (organization and facility) the losses and good output belong to
    const runIds = unique(losses.map(row => row.workEffortId).concat((goodEvents || []).map(row => row.workEffortId)))
    const runs = byId(runsOf(report, narrowTo(runIds)), "workEffortId")
    const lines = byId(
        rowsIn(
            LINE,
            "productionRunLineId",
            (goodEvents || []).map(row => row.productionRunLineId)
        ),
        "productionRunLineId"
    )
    const inScope = losses.filter(loss => runs.has(loss.workEffortId))
    const good = (goodEvents || [])
        .filter(event => runs.has(event.workEffortId))
        .map(event => ({event, line: lines.get(event.productionRunLineId)}))
        .filter(row => row.line && (blank(p.productId) || row.line.productId === p.productId))
    // the cost of each loss (financial read): its scrap cost events
    let lossCosts = null
    if (report.financialRead)
        lossCosts = partition(report, "Loss cost", () => {
            const byLoss = new Map()
            const issuanceLoss = new Map(
                inScope.filter(loss => loss.assetIssuanceId).map(loss => [loss.assetIssuanceId, loss.productionLossId])
            )
            const events = rowsIn(
                COST_EVENT,
                "sourceId",
                inScope.map(loss => loss.productionLossId),
                {sourceEntityName: LOSS}
            ).concat(
                rowsIn(COST_EVENT, "assetIssuanceId", Array.from(issuanceLoss.keys()), {costEventTypeEnumId: "PcetOutputScrap"})
            )
            for (const event of events) {
                const lossId = event.sourceEntityName === LOSS ? event.sourceId : issuanceLoss.get(event.assetIssuanceId)
                if (!byLoss.has(lossId)) byLoss.set(lossId, [])
                byLoss.get(lossId).push(event)
            }
            return byLoss
        })
    else report.withheld.push("Loss cost")
    const products = productNames(inScope.map(row => row.productId).concat(good.map(row => row.line.productId)))
    const groups = new Map()
    const groupOf = (productId, uomId, reasonCode, reasonName, lossTypeEnumId) => {
        const key = [productId, uomId, reasonCode || "", lossTypeEnumId || ""].join("|")
        if (!groups.has(key))
            groups.set(key, {
                productId,
                productName: products.get(productId) || productId,
                reasonCode: reasonCode || null,
                reasonText: reasonName || reasonCode || "",
                lossTypeEnumId: lossTypeEnumId || null,
                lossTypeText: lossTypeEnumId ? enumText(lossTypeEnumId) : "Good",
                stockUomId: uomId,
                unitText: unitText(uomId),
                quantity: 0,
                lossCount: 0,
                currencyUomId: null
            })
        return groups.get(key)
    }
    for (const loss of inScope) {
        const group = groupOf(loss.productId, loss.quantityUomId, loss.reasonCode, loss.reasonName, loss.lossTypeEnumId)
        group.quantity = round(group.quantity + num(loss.quantity), 6)
        group.lossCount++
        if (lossCosts) {
            for (const event of lossCosts.get(loss.productionLossId) || []) {
                // a loss's cost relieves WIP or moves value into variance: shown as a positive cost
                group.lossCost = round((group.lossCost || 0) + Math.abs(num(event.amount) || 0), 6)
                group.currencyUomId = event.amountUomId || group.currencyUomId
                report.currencies.add(event.amountUomId)
            }
        }
        report.units.add(loss.quantityUomId)
    }
    // good output per product and unit, to compute each loss row's rate
    const goodBy = new Map()
    for (const {event, line} of good) {
        const key = line.productId + "|" + (event.quantityUomId || line.stockUomId)
        goodBy.set(key, (goodBy.get(key) || 0) + num(event.quantity))
        report.units.add(event.quantityUomId || line.stockUomId)
    }
    const lossRows = Array.from(groups.values())
    const outputLossOf = (productId, uomId) =>
        lossRows
            .filter(row => row.productId === productId && row.stockUomId === uomId && row.lossTypeEnumId !== "PltComponentScrap")
            .reduce((sum, row) => sum + row.quantity, 0)
    for (const row of lossRows) {
        row.goodQuantity = goodEvents ? round(goodBy.get(row.productId + "|" + row.stockUomId) || 0, 6) : null
        const base = row.goodQuantity == null ? null : row.goodQuantity + outputLossOf(row.productId, row.stockUomId)
        row.lossRate = row.lossTypeEnumId === "PltComponentScrap" || !base ? null : round(row.quantity / base, 4)
        row.lossRateText =
            row.lossRate == null ? (row.lossTypeEnumId === "PltComponentScrap" ? "" : notCalculable) : percentText(row.lossRate)
        if (!report.financialRead) delete row.currencyUomId
    }
    // the totals per unit: good and each kind of loss, and the output loss rate
    const totals = new Map()
    const totalOf = uomId => {
        if (!totals.has(uomId))
            totals.set(uomId, {
                stockUomId: uomId,
                unitText: unitText(uomId),
                goodQuantity: goodEvents ? 0 : null,
                scrapQuantity: 0,
                processLossQuantity: 0,
                reworkQuantity: 0,
                componentScrapQuantity: 0
            })
        return totals.get(uomId)
    }
    for (const [key, quantity] of goodBy) {
        const total = totalOf(key.split("|")[1])
        total.goodQuantity = round(total.goodQuantity + quantity, 6)
    }
    for (const row of lossRows) {
        const total = totalOf(row.stockUomId)
        total[lossFields[row.lossTypeEnumId]] = round(total[lossFields[row.lossTypeEnumId]] + row.quantity, 6)
    }
    const totalRows = Array.from(totals.values()).map(total => {
        const lost = total.scrapQuantity + total.processLossQuantity + total.reworkQuantity
        const base = total.goodQuantity == null ? null : total.goodQuantity + lost
        total.lossRate = base ? round(lost / base, 4) : null
        total.lossRateText = percentText(total.lossRate)
        return total
    })
    // the trend: each week's quantities by kind and unit
    const trend = new Map()
    const trendOf = (week, uomId) => {
        const key = week + "|" + uomId
        if (!trend.has(key))
            trend.set(key, {
                weekText: week,
                unitText: unitText(uomId),
                goodQuantity: goodEvents ? 0 : null,
                scrapQuantity: 0,
                processLossQuantity: 0,
                reworkQuantity: 0,
                componentScrapQuantity: 0
            })
        return trend.get(key)
    }
    for (const {event, line} of good) {
        const row = trendOf(weekOf(event.eventDate), event.quantityUomId || line.stockUomId)
        row.goodQuantity = round(row.goodQuantity + num(event.quantity), 6)
    }
    for (const loss of inScope) {
        const row = trendOf(weekOf(loss.lossDate), loss.quantityUomId)
        row[lossFields[loss.lossTypeEnumId]] = round(row[lossFields[loss.lossTypeEnumId]] + num(loss.quantity), 6)
    }
    const trendRows = Array.from(trend.values()).sort((a, b) => a.weekText.localeCompare(b.weekText))
    if (report.financialRead) {
        const costTotals = totalsBy(
            lossRows.filter(row => row.lossCost != null),
            row => row.currencyUomId,
            ["lossCost"],
            row => ({currencyUomId: row.currencyUomId})
        )
        return finish(report, Object.assign({totalRows, trendRows, costTotals}, pagedOf(report, lossRows, "lossRows")))
    }
    return finish(report, Object.assign({totalRows, trendRows}, pagedOf(report, lossRows, "lossRows")))
}

// ===== get#ProductionQualityReport =====
function qualityReport(p) {
    const report = begin(p)
    const {fromDate, thruDate} = report.period
    const enumText = enumTexts()
    const inspections =
        partition(report, "Inspections", () => {
            let query = find(INSPECTION)
                .condition("workEffortId", "is-not-null", null)
                .condition("statusId", "not-equals", "QiCancelled")
                .condition("createdDate", "greater-equals", fromDate)
                .condition("createdDate", "less-than", thruDate)
            if (report.organizationPartyIds) query = query.condition("organizationPartyId", "in", report.organizationPartyIds)
            if (!blank(p.inspectionTemplateId)) query = query.condition("inspectionTemplateId", p.inspectionTemplateId)
            if (!blank(p.productId)) query = query.condition("productId", p.productId)
            if (!blank(p.lotId)) query = query.condition("lotId", p.lotId)
            if (!blank(p.resultEnumId)) query = query.condition("resultEnumId", p.resultEnumId)
            if (!blank(p.operationWorkEffortId)) query = query.condition("operationWorkEffortId", p.operationWorkEffortId)
            return cappedList(report, "Inspections", query, 5000)
        }) || []
    // production inspections of the scope's runs
    const runs = byId(runsOf(report, narrowTo(unique(inspections.map(row => row.workEffortId)))), "workEffortId")
    const own = inspections.filter(row => runs.has(row.workEffortId))
    const ids = own.map(row => row.qualityInspectionId)
    const readings = partition(report, "Readings", () => rowsIn(READING, "qualityInspectionId", ids))
    const dispositions = partition(report, "Dispositions", () => rowsIn(DISPOSITION, "qualityInspectionId", ids))
    const templates = namesOf(
        TEMPLATE,
        "inspectionTemplateId",
        own.map(row => row.inspectionTemplateId),
        row => row.templateName || row.inspectionTemplateId
    )
    const products = productNames(own.map(row => row.productId))
    const groups = new Map()
    for (const inspection of own) {
        const uomId = (inspection.productId && one(PRODUCT, {productId: inspection.productId})?.amountUomId) || null
        const key = [inspection.inspectionTemplateId || "", inspection.productId || "", uomId || ""].join("|")
        if (!groups.has(key))
            groups.set(key, {
                inspectionTemplateId: inspection.inspectionTemplateId || null,
                templateText: templates.get(inspection.inspectionTemplateId) || inspection.inspectionTemplateId || "No template",
                productId: inspection.productId || null,
                productName: products.get(inspection.productId) || inspection.productId || "",
                stockUomId: uomId,
                unitText: unitText(uomId),
                inspectionCount: 0,
                openCount: 0,
                sampleCount: 0,
                readingCount: readings ? 0 : null,
                failedReadingCount: readings ? 0 : null,
                acceptedQuantity: 0,
                rejectedQuantity: 0,
                heldQuantity: 0,
                reinspectionCount: 0,
                dispositionHours: [],
                results: new Map()
            })
        const group = groups.get(key)
        group.inspectionCount++
        if (["QiDraft", "QiSubmitted"].includes(inspection.statusId)) group.openCount++
        group.sampleCount += num(inspection.sampleSize) || 0
        group.acceptedQuantity = round(group.acceptedQuantity + (num(inspection.quantityAccepted) || 0), 6)
        group.rejectedQuantity = round(group.rejectedQuantity + (num(inspection.quantityRejected) || 0), 6)
        group.heldQuantity = round(group.heldQuantity + (num(inspection.heldQuantity) || 0), 6)
        if (inspection.previousInspectionId) group.reinspectionCount++
        if (inspection.resultEnumId)
            group.results.set(inspection.resultEnumId, (group.results.get(inspection.resultEnumId) || 0) + 1)
        if (readings) {
            const mine = readings.filter(row => row.qualityInspectionId === inspection.qualityInspectionId)
            group.readingCount += mine.length
            group.failedReadingCount += mine.filter(row => row.passIndicator === "N").length
        }
        if (dispositions && inspection.submittedDate) {
            const first = dispositions
                .filter(row => row.qualityInspectionId === inspection.qualityInspectionId && row.disposedDate)
                .map(row => ms(row.disposedDate))
                .sort((a, b) => a - b)[0]
            if (first != null) group.dispositionHours.push((first - ms(inspection.submittedDate)) / hourMs)
        }
        report.units.add(uomId)
    }
    const qualityRows = Array.from(groups.values()).map(group => {
        const decided = group.acceptedQuantity + group.rejectedQuantity
        group.failureRate = decided > 0 ? round(group.rejectedQuantity / decided, 4) : null
        group.failureRateText = percentText(group.failureRate)
        group.readingFailureRate = group.readingCount ? round(group.failedReadingCount / group.readingCount, 4) : null
        group.readingFailureRateText = group.readingCount == null ? "Unavailable" : percentText(group.readingFailureRate)
        group.dispositionHoursAverage = group.dispositionHours.length
            ? round(group.dispositionHours.reduce((sum, hours) => sum + hours, 0) / group.dispositionHours.length)
            : null
        group.dispositionText =
            group.dispositionHoursAverage == null
                ? dispositions
                    ? "None disposed"
                    : "Unavailable"
                : group.dispositionHoursAverage + " h"
        group.resultText = Array.from(group.results.entries())
            .map(([enumId, count]) => enumText(enumId) + " " + count)
            .join(", ")
        delete group.dispositionHours
        delete group.results
        return group
    })
    const totalRows = totalsBy(
        qualityRows,
        row => row.stockUomId || "",
        [
            "inspectionCount",
            "openCount",
            "sampleCount",
            "readingCount",
            "failedReadingCount",
            "acceptedQuantity",
            "rejectedQuantity",
            "heldQuantity",
            "reinspectionCount"
        ],
        row => ({stockUomId: row.stockUomId, unitText: row.unitText})
    ).map(total => {
        const decided = (total.acceptedQuantity || 0) + (total.rejectedQuantity || 0)
        total.failureRateText = percentText(decided > 0 ? (total.rejectedQuantity || 0) / decided : null)
        return total
    })
    return finish(report, Object.assign({totalRows}, pagedOf(report, qualityRows, "qualityRows")))
}

// ===== get#ProductionCostReport =====
const componentFields = {
    PrcMaterial: "materialCost",
    PrcLabor: "laborCost",
    PrcMachine: "machineCost",
    PrcOverhead: "overheadCost",
    PrcOutside: "outsideCost"
}
const moneyFields = [
    "materialCost",
    "laborCost",
    "machineCost",
    "overheadCost",
    "outsideCost",
    "totalCost",
    "outputRelief",
    "wipAmount",
    "allocatedOutput",
    "varianceAmount",
    "estimateAmount"
]
function costReport(p) {
    const report = begin(p)
    const {fromDate, thruDate} = report.period
    const statusText = statusTexts()
    // the runs: the one asked for; or those completed in the period (completed), or open now (open)
    const basis = p.basis === "open" ? "open" : "completed"
    let conditions = q => q
    if (!blank(p.workEffortId)) conditions = narrowTo([p.workEffortId])
    else if (basis === "open")
        conditions = q => q.condition("statusId", "in", ["WeApproved", "WeInProgress", "WeOnHold", "WeComplete"])
    else
        conditions = q =>
            q
                .condition("actualCompletionDate", "greater-equals", fromDate)
                .condition("actualCompletionDate", "less-than", thruDate)
    if (!blank(p.productId)) {
        const before = conditions
        const ids = runIdsOfProduct(p.productId)
        conditions = q => narrowTo(ids)(before(q))
    }
    const runs = runsOf(report, conditions)
    const runIds = runs.map(run => run.workEffortId)
    const outputs = outputsOf(runIds)
    const products = productNames(Array.from(outputs.values()).map(line => line.productId))
    const events = partition(report, "Cost events", () => rowsIn(COST_EVENT, "workEffortId", runIds)) || null
    const allocations = partition(report, "Cost close allocations", () => rowsIn(ALLOCATION, "workEffortId", runIds)) || null
    const standards =
        report.financialRead && report.costRead
            ? partition(report, "Frozen estimates", () =>
                  byId(
                      rowsIn(
                          STANDARD,
                          "productStandardCostId",
                          runs.map(run => run.productStandardCostId)
                      ),
                      "productStandardCostId"
                  )
              )
            : null
    if (!report.financialRead) report.withheld.push("Costs, WIP, allocations and variance")
    const currency = str(p.currencyUomId)
    const costRows = []
    for (const run of runs)
        partition(report, "Work order " + run.workEffortId, () => {
            const output = outputs.get(run.workEffortId)
            const figures = output ? quantities().outputFigures(run, output) : null
            const own = events ? events.filter(event => event.workEffortId === run.workEffortId) : null
            const stockUomId = output?.stockUomId || null
            report.units.add(stockUomId)
            const row = {
                workEffortId: run.workEffortId,
                workEffortName: run.workEffortName || "",
                productId: output?.productId || null,
                productName: output ? products.get(output.productId) || output.productId : "",
                statusText: statusText(run.statusId),
                completedText: dateText(run.actualCompletionDate),
                goodQuantity: figures ? num(figures.good) : null,
                stockUomId,
                unitText: unitText(stockUomId),
                closeText:
                    run.statusId === "WeClosed"
                        ? "Closed"
                        : run.productionCostClosedDate
                          ? "Cost closed"
                          : run.productionCostReviewStatusId
                            ? statusText(run.productionCostReviewStatusId)
                            : "Not requested",
                eventCount: own ? own.length : null,
                unvaluedCount: own ? own.filter(event => event.valuationStatusEnumId === "PcvUnvalued").length : null,
                awaitingCloseCount: own ? own.filter(event => event.ledgerStatusEnumId === "PclAwaitingClose").length : null
            }
            if (report.financialRead) {
                const currencies = unique((own || []).map(event => event.amountUomId))
                const chosen = currency || currencies[0] || null
                if (currencies.length > 1 && !currency)
                    row.currencyNote = "Amounts in " + currencies.join(", ") + ": choose a currency"
                const mine = (own || []).filter(event => (event.amountUomId || null) === chosen)
                row.currencyUomId = chosen
                report.currencies.add(chosen)
                if (own) {
                    const sumOf = predicate =>
                        round(
                            mine.filter(predicate).reduce((total, event) => total + (num(event.amount) || 0), 0),
                            6
                        )
                    for (const [component, field] of Object.entries(componentFields))
                        row[field] = sumOf(event => event.costComponentEnumId === component)
                    row.totalCost = round(
                        Object.values(componentFields).reduce((total, field) => total + row[field], 0),
                        6
                    )
                    row.outputRelief = round(-sumOf(event => event.costComponentEnumId === "PrcOutput"), 6)
                    row.wipAmount = sumOf(() => true)
                }
                if (allocations) {
                    const allocated = allocations.filter(
                        row => row.workEffortId === run.workEffortId && (row.amountUomId || chosen) === chosen
                    )
                    const sumOf = destinations =>
                        round(
                            allocated
                                .filter(row => destinations.includes(row.destinationEnumId))
                                .reduce((total, row) => total + (num(row.allocatedAmount) || 0), 0),
                            6
                        )
                    row.allocatedOutput = sumOf(["PcdOutput", "PcdByproduct"])
                    // the production variance and the scrap of issued material (P15's PcdScrap)
                    row.varianceAmount = sumOf(["PcdVariance", "PcdScrap"])
                    row.glText = unique(
                        allocated.map(row => row.acctgTransId).concat(mine.map(event => event.closeAcctgTransId))
                    ).join(", ")
                }
                const standard = standards ? standards.get(run.productStandardCostId) : null
                if (standard && figures && (standard.priceUomId || chosen) === chosen && standard.unitCost != null)
                    row.estimateAmount = round(num(standard.unitCost) * num(figures.good), 6)
            }
            costRows.push(row)
        })
    const quantityTotals = totalsBy(
        costRows,
        row => row.stockUomId || "",
        ["goodQuantity", "eventCount", "unvaluedCount", "awaitingCloseCount"],
        row => ({stockUomId: row.stockUomId, unitText: row.unitText})
    )
    const answer = {quantityTotals}
    if (report.financialRead)
        answer.moneyTotals = totalsBy(
            costRows.filter(row => row.currencyUomId),
            row => row.currencyUomId,
            moneyFields,
            row => ({currencyUomId: row.currencyUomId})
        )
    return finish(report, Object.assign(answer, pagedOf(report, costRows, "costRows")))
}

// ===== get#BomVarianceReport =====
function varianceReport(p) {
    const report = begin(p)
    const {fromDate, thruDate} = report.period
    const basisGood = p.quantityBasis !== "target"
    let conditions = q => q.condition("productionReleaseDate", "is-not-null", null)
    if (!blank(p.workEffortId))
        conditions = q => narrowTo([p.workEffortId])(q.condition("productionReleaseDate", "is-not-null", null))
    else
        conditions = q =>
            q
                .condition("productionReleaseDate", "greater-equals", fromDate)
                .condition("productionReleaseDate", "less-than", thruDate)
    const narrowers = []
    if (!blank(p.productBomId)) narrowers.push(q => q.condition("productBomId", p.productBomId))
    if (!blank(p.productId)) narrowers.push(narrowTo(runIdsOfProduct(p.productId)))
    const runs = runsOf(report, q => narrowers.reduce((query, narrow) => narrow(query), conditions(q)))
    if (!report.financialRead) report.withheld.push("Actual material cost and usage variance")
    const allLines = rowsIn(
        LINE,
        "workEffortId",
        runs.map(run => run.workEffortId)
    )
    const products = productNames(allLines.map(line => line.productId))
    const events = report.financialRead
        ? partition(report, "Cost events", () =>
              rowsIn(
                  COST_EVENT,
                  "workEffortId",
                  runs.map(run => run.workEffortId),
                  {costComponentEnumId: "PrcMaterial"}
              )
          )
        : null
    const ctx = time.forCall()
    const lineRows = []
    const yieldRows = []
    for (const run of runs)
        partition(report, "Work order " + run.workEffortId, () => {
            const lines = allLines.filter(line => line.workEffortId === run.workEffortId)
            const output = lines.find(line => line.lineRoleEnumId === "PrlrOutput")
            const figures = output ? quantities().outputFigures(run, output) : null
            const target = output ? num(output.stockQuantity) : null
            const good = figures ? num(figures.good) : null
            const scale = basisGood ? (target ? (good || 0) / target : null) : 1
            const operations = rows(WORK, {parentWorkEffortId: run.workEffortId})
            let plannedHours = 0,
                standardsMissing = false
            for (const operation of operations) {
                if (!blank(p.operationWorkEffortId) && operation.workEffortId !== p.operationWorkEffortId) continue
                try {
                    plannedHours += time.operationHours(ctx, operation, run)
                } catch (_) {
                    standardsMissing = true
                }
            }
            const laborHours = rowsIn(
                TIME_ENTRY,
                "workEffortId",
                operations.map(row => row.workEffortId).concat([run.workEffortId])
            ).reduce((total, entry) => total + (num(entry.hours) || 0), 0)
            if (output) report.units.add(output.stockUomId)
            yieldRows.push({
                workEffortId: run.workEffortId,
                workEffortName: run.workEffortName || "",
                productName: output ? products.get(output.productId) || output.productId : "",
                releaseText: dateText(run.productionReleaseDate),
                productBomId: run.productBomId || null,
                targetQuantity: target,
                goodQuantity: good,
                unitText: output ? unitText(output.stockUomId) : "",
                yieldRate: target && good != null ? round(good / target, 4) : null,
                yieldText: target && good != null ? percentText(good / target) : notCalculable,
                plannedHours: standardsMissing ? null : round(plannedHours),
                plannedHoursText: standardsMissing ? notCalculable : String(round(plannedHours)),
                actualHours: round(laborHours),
                timeVarianceHours: standardsMissing ? null : round(laborHours - plannedHours)
            })
            for (const line of lines.filter(line => line.lineRoleEnumId === "PrlrMaterial")) {
                if (!blank(p.operationWorkEffortId) && line.operationWorkEffortId !== p.operationWorkEffortId) continue
                const totals = production().materialTotals(line)
                const planned = scale == null ? null : num(line.stockQuantity) * scale
                const actual = num(totals.net)
                const variance = planned == null ? null : actual - planned
                const substituteOf = line.substituteOfLineId
                    ? lines.find(other => other.productionRunLineId === line.substituteOfLineId)
                    : null
                const row = {
                    workEffortId: run.workEffortId,
                    productionRunLineId: line.productionRunLineId,
                    productBomId: line.productBomId || run.productBomId || null,
                    releaseText: dateText(run.productionReleaseDate),
                    productId: line.productId,
                    productName: products.get(line.productId) || line.productId,
                    operationText: line.operationWorkEffortId
                        ? one(WORK, {workEffortId: line.operationWorkEffortId})?.workEffortName || line.operationWorkEffortId
                        : "",
                    plannedQuantity: planned == null ? null : round(planned, 6),
                    actualQuantity: round(actual, 6),
                    varianceQuantity: variance == null ? null : round(variance, 6),
                    variancePercentText: planned ? percentText(variance / planned) : notCalculable,
                    substituteText: substituteOf
                        ? "Substitute for " + (products.get(substituteOf.productId) || substituteOf.productId)
                        : line.substituteOfLineId
                          ? "Substitute"
                          : "",
                    stockUomId: line.stockUomId,
                    unitText: unitText(line.stockUomId)
                }
                report.units.add(line.stockUomId)
                if (events) {
                    const mine = events.filter(event => event.productionRunLineId === line.productionRunLineId)
                    const cost = mine.reduce((total, event) => total + (num(event.amount) || 0), 0)
                    const currencyUomId = mine[0]?.amountUomId || null
                    row.actualCost = round(cost, 6)
                    row.currencyUomId = currencyUomId
                    report.currencies.add(currencyUomId)
                    row.usageVariance = variance != null && actual ? round((cost / actual) * variance, 6) : null
                }
                lineRows.push(row)
            }
        })
    const totalRows = totalsBy(
        lineRows,
        row => row.stockUomId || "",
        ["plannedQuantity", "actualQuantity", "varianceQuantity"],
        row => ({stockUomId: row.stockUomId, unitText: row.unitText})
    )
    const answer = {totalRows, yieldRows}
    if (report.financialRead)
        answer.moneyTotals = totalsBy(
            lineRows.filter(row => row.currencyUomId),
            row => row.currencyUomId,
            ["actualCost", "usageVariance"],
            row => ({currencyUomId: row.currencyUomId})
        )
    return finish(report, Object.assign(answer, pagedOf(report, lineRows, "lineRows")))
}

// ===== get#ProductionPlanningReport =====
function planningReport(p) {
    const report = begin(p, {period: false})
    const enumText = enumTexts()
    const planning = supplyPlanning()
    // the plans: the one asked for, else the current plan of each facility set of the scope's organizations
    let planRuns
    if (!blank(p.planningRunId)) {
        const run = one(PLAN_RUN, {planningRunId: p.planningRunId})
        if (!run || !facilityScope.owns(report.userScope, run.organizationPartyId))
            denied("RECORD_UNAVAILABLE", "Supply plan " + p.planningRunId + " is not available")
        planRuns = [run]
    } else {
        let query = find(PLAN_RUN, {isCurrent: "Y"})
        if (report.organizationPartyIds) query = query.condition("organizationPartyId", "in", report.organizationPartyIds)
        planRuns = Array.from(query.orderBy("-startedDate").limit(50).list())
        if (report.facilityIds) {
            const withFacility = new Set(
                rowsIn(PLAN_RUN_FACILITY, "facilityId", report.facilityIds).map(row => row.planningRunId)
            )
            planRuns = planRuns.filter(run => withFacility.has(run.planningRunId))
        }
    }
    const bucket = p.bucket === "day" || p.bucket === "week" ? p.bucket : null
    const bucketOf = stamp => {
        if (!bucket || stamp == null) return ""
        const day = ec.l10n.format(new Date(ms(stamp)), "yyyy-MM-dd")
        return bucket === "day" ? day : "Week of " + weekOf(stamp)
    }
    const planRows = []
    const suggestionRows = []
    for (const run of planRuns)
        partition(report, "Supply plan " + run.planningRunId, () => {
            const stale = planning.staleOf(run)
            const facilities = rows(PLAN_RUN_FACILITY, {planningRunId: run.planningRunId}).map(row => row.facilityId)
            const names = facilityNames(facilities)
            planRows.push({
                planningRunId: run.planningRunId,
                organizationPartyId: run.organizationPartyId,
                facilityText: facilities.map(id => names.get(id) || id).join(", "),
                completedText: dateText(run.completedDate || run.startedDate),
                horizonText: dateText(run.horizonDate),
                suggestionCount: run.suggestionCount,
                exceptionCount: run.exceptionCount,
                stale: stale.stale,
                staleText: stale.stale ? stale.reason : "Current"
            })
            let query = find(SUGGESTION, {planningRunId: run.planningRunId})
            if (!blank(p.productId)) query = query.condition("productId", p.productId)
            if (!blank(p.methodEnumId)) query = query.condition("methodEnumId", p.methodEnumId)
            if (report.facilityIds) query = query.condition("facilityId", "in", report.facilityIds)
            const suggestions = cappedList(
                report,
                "Supply plan " + run.planningRunId + " suggestions",
                query.orderBy("planningLevel").orderBy("requiredByDate"),
                2000
            )
            const products = productNames(suggestions.map(row => row.productId))
            const facilityText = facilityNames(suggestions.map(row => row.facilityId))
            for (const row of suggestions) {
                const converted = row.requirementId ? num(planning.coveredOf(row.requirementId)) : 0
                const provenance = lib.json(row.provenanceJson, [])
                report.units.add(row.quantityUomId)
                suggestionRows.push({
                    planningRunId: run.planningRunId,
                    planningSuggestionId: row.planningSuggestionId,
                    productId: row.productId,
                    productName: products.get(row.productId) || row.productId,
                    facilityName: facilityText.get(row.facilityId) || row.facilityId || "",
                    methodText: row.methodEnumId ? enumText(row.methodEnumId) : "No source",
                    stateText: enumText(row.stateEnumId),
                    planningLevel: row.planningLevel,
                    requiredQuantity: num(row.grossQuantity),
                    availableQuantity: num(row.availableQuantity),
                    heldQuantity: num(row.pendingReleaseQuantity),
                    suggestedQuantity: num(row.quantity),
                    convertedQuantity: round(converted, 6),
                    stockUomId: row.quantityUomId || null,
                    unitText: unitText(row.quantityUomId),
                    requiredByText: dateText(row.requiredByDate),
                    releaseText: dateText(row.releaseDate),
                    bucketText: bucketOf(row.requiredByDate),
                    provenanceText: unique(provenance.filter(line => !line.supply).map(line => line.label))
                        .slice(0, 5)
                        .join("; "),
                    supplyText: unique(provenance.filter(line => line.supply).map(line => line.label))
                        .slice(0, 5)
                        .join("; "),
                    exceptionText: row.exceptionMessage || row.exceptionCode || "",
                    staleText: stale.stale ? stale.reason : ""
                })
            }
        })
    const totalRows = totalsBy(
        suggestionRows,
        row => (bucket ? row.bucketText + "|" : "") + (row.stockUomId || ""),
        ["requiredQuantity", "availableQuantity", "heldQuantity", "suggestedQuantity", "convertedQuantity"],
        row => ({bucketText: bucket ? row.bucketText : "", stockUomId: row.stockUomId, unitText: row.unitText})
    )
    return finish(
        report,
        Object.assign(
            {planRows, totalRows, stale: planRows.some(row => row.stale)},
            pagedOf(report, suggestionRows, "suggestionRows")
        )
    )
}

// ===== get#ProductionDashboard =====
// The Kpis of a plant (or the user's organizations) over a period (this month to now by default), each read on its own:
// value is a fraction or count, valueText its display ("Not calculable", "Unavailable" when its source failed, never zero
// for a missing figure), and reportName and parameters the report it opens with the same filters.
function dashboard(p) {
    requireView()
    const now = ec.user.nowTimestamp
    const monthStart = ec.l10n.parseTimestamp(ec.l10n.format(now, "yyyy-MM") + "-01 00:00:00.000", "yyyy-MM-dd HH:mm:ss.SSS")
    const fromDate = blank(p.fromDate) ? monthStart : p.fromDate
    const thruDate = blank(p.thruDate) ? now : p.thruDate
    const filters = {organizationPartyId: str(p.organizationPartyId), facilityId: str(p.facilityId), fromDate, thruDate}
    const report = begin(Object.assign({}, p, filters))
    const linkFilters = {
        organizationPartyId: filters.organizationPartyId,
        facilityId: filters.facilityId,
        fromDate: ec.l10n.format(report.period.fromDate, "yyyy-MM-dd"),
        thruDate: ec.l10n.format(new Date(report.period.thruMs - 1), "yyyy-MM-dd")
    }
    const kpis = []
    const kpi = (kpiId, title, reportName, parameters, read) => {
        const value = partition(report, title, read)
        kpis.push(
            Object.assign(
                {
                    kpiId,
                    title,
                    reportName,
                    parameters: Object.fromEntries(
                        Object.entries(Object.assign({}, linkFilters, parameters)).filter(([, v]) => v != null)
                    )
                },
                value || {value: null, valueText: "Unavailable"}
            )
        )
    }
    let completedRuns = null
    const completedFilters = {
        statusId: "WeComplete,WeClosed",
        completedFrom: linkFilters.fromDate,
        completedThru: linkFilters.thruDate,
        fromDate: null,
        thruDate: null
    }
    kpi("completed", "Completed", "WorkOrderStatusReport", completedFilters, () => {
        completedRuns = runsOf(report, q =>
            q
                .condition("actualCompletionDate", "greater-equals", report.period.fromDate)
                .condition("actualCompletionDate", "less-than", report.period.thruDate)
        )
        return {value: completedRuns.length, valueText: String(completedRuns.length)}
    })
    kpi("onTime", "On-time completion", "WorkOrderStatusReport", completedFilters, () => {
        const runs = completedRuns || []
        const dated = runs.filter(run => run.estimatedCompletionDate)
        if (!dated.length) return {value: null, valueText: notCalculable, detail: "No completed work order with a due date"}
        const onTime = dated.filter(run => ms(run.actualCompletionDate) <= ms(run.estimatedCompletionDate)).length
        return {
            value: round(onTime / dated.length, 4),
            valueText: percentText(onTime / dated.length),
            detail: onTime + " of " + dated.length
        }
    })
    kpi("oee", "OEE", "OperationPerformanceReport", {}, () => {
        const oee = oeeReport(Object.assign({}, p, filters, {pageNoLimit: true}))
        if (!oee.complete)
            report.partitions.push(...oee.partitions.map(row => ({name: "OEE: " + row.name, message: row.message})))
        return {
            value: oee.totals.oee,
            valueText: oee.totals.oeeText,
            detail: ["availability", "performance", "quality"]
                .map(f => f[0].toUpperCase() + f.slice(1) + " " + oee.totals[f + "Text"])
                .join(" · ")
        }
    })
    // utilization as Capacity reads it (get#WorkCenterLoad): booked hours over available hours, not OEE
    kpi("utilization", "Utilization", "OperationPerformanceReport", {}, () => {
        const facility = report.facility
        const center = facility ? one(CENTER, {facilityId: facility.facilityId}) : null
        const load = planningLoad().execute("load", {
            facilityId: center ? facility.facilityId : null,
            plantFacilityId: facility && !center ? facility.facilityId : null,
            fromDate: report.period.fromDate,
            thruDate: report.period.thruDate,
            pageSize: 100
        })
        const centers = Array.from(load.centerList || []).filter(
            row =>
                !report.organizationPartyIds ||
                report.organizationPartyIds.includes(
                    row.organizationPartyId || one(FACILITY, {facilityId: row.facilityId})?.ownerPartyId
                )
        )
        const booked = centers.reduce((total, row) => total + Number(row.loadHours || 0), 0)
        const available = centers.reduce((total, row) => total + Number(row.availableHours || 0), 0)
        if (!(available > 0)) return {value: null, valueText: notCalculable, detail: "No available hours"}
        return {
            value: round(booked / available, 4),
            valueText: percentText(booked / available),
            detail: "Booked over available hours"
        }
    })
    kpi("scrapRate", "Scrap rate", "LossReport", {}, () => {
        const loss = lossReport(Object.assign({}, p, filters, {pageNoLimit: true}))
        if (!loss.complete)
            report.partitions.push(...loss.partitions.map(row => ({name: "Loss: " + row.name, message: row.message})))
        if (loss.totalRows.length !== 1)
            return {
                value: null,
                valueText: loss.totalRows.length ? notCalculable : "No output",
                detail: loss.totalRows.length ? "Output in several units" : ""
            }
        return {
            value: loss.totalRows[0].lossRate,
            valueText: loss.totalRows[0].lossRateText,
            detail: "Scrap, process loss and rework over all output"
        }
    })
    // WIP value only with financial read: left out of the Kpis otherwise (never zero)
    if (report.financialRead)
        kpi("wipValue", "WIP value", "ProductionCostReport", {basis: "open", fromDate: null, thruDate: null}, () => {
            const cost = costReport(Object.assign({}, p, filters, {basis: "open", pageNoLimit: true}))
            if (!cost.complete)
                report.partitions.push(...cost.partitions.map(row => ({name: "WIP: " + row.name, message: row.message})))
            const totals = cost.moneyTotals || []
            if (!totals.length) return {value: 0, valueText: "No open work", detail: ""}
            return {
                value: totals.length === 1 ? totals[0].wipAmount : null,
                valueText: totals
                    .map(row => String(lib.money(row.wipAmount || 0, row.currencyUomId)) + " " + row.currencyUomId)
                    .join(", "),
                currencyUomId: totals.length === 1 ? totals[0].currencyUomId : null,
                detail: "Open work orders' cost not yet relieved"
            }
        })
    else report.withheld.push("WIP value")
    return finish(report, {kpis, completedCount: completedRuns ? completedRuns.length : null})
}

const operations = {
    status: statusReport,
    material: materialReport,
    performance: oeeReport,
    loss: lossReport,
    quality: qualityReport,
    cost: costReport,
    variance: varianceReport,
    planning: planningReport,
    dashboard
}
;({
    execute: (op, parameters) => {
        if (!operations[op]) throw new Error("Unknown production report " + op)
        return operations[op](parameters || {})
    }
})
