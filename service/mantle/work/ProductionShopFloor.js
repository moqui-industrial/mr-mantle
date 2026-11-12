// The shop floor and production time (design-manufacturing §4 ShopFloor, OperationExecution and Instructions, §3
// ProductionTime, §12 M7; impl-manufacturing P10):
// - get#ShopFloorQueue: the operations of the user's released, running and held runs at a plant or work center, each with
//   its state (ready, running, paused, blocked, done) and the reason, and the user's person timer;
// - get#ProductionOperation: one operation for its operator: the run, the quantities, the start checks, the timer, the
//   machine runtime and the evidence; get#ProductionInstructions and record#InstructionStep: the instruction in effect at
//   the run's release (P2's dated WorkEffortContent rows) and its acknowledgment, and the evidence the operation requires;
// - start#, pause#, complete#ProductionOperation and override#ProductionOperationStart: the operation's own events over the
//   Projects person timer (TimesheetServices' get#, start# and stop#Timer: one timer per person, a switch confirmed), the
//   start checks (predecessors started, the operator's assignment, required skills and acknowledgment with a supervisor's
//   override, equipment, the material and in-process quality gates) and the completion's coupled quantity and output
//   posting (record#ProductionQuantity) in its transaction, with TimeEntry.pieceCount under the piece-rate policy;
// - record#MachineRuntime: machine time apart from labor, a closed interval valued at the work center's machine
//   WorkCenterRate in effect at its start, else unvalued (§4), and its cost event;
// - sync#ProductionLaborCost: the labor cost events of production time entries, called at post#WorkEffortCost's four call
//   sites (approve and reopen of a timesheet, store# and delete#TimeEntry; F34) as an idempotent delta per entry, under the
//   run owner's laborCostSync policy flag (off by default, so Projects is unchanged); get#ProductionTime: a run's time.
// Each verb checks its permission and the run's organization (Production.js runOf); writes take an operation key, and a
// retry answers the first result.
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const posting = ec.resource.script("component://mr-mantle/service/mantle/shipment/StockPosting.js")
const facilityScope = ec.resource.script("component://mr-mantle/service/mantle/facility/FacilityScope.js")
const {find, one, rows, call, denied, access} = lib

const WORK = "mantle.work.effort.WorkEffort",
    LINE = "mantle.work.production.ProductionRunLine",
    PARTY = "mantle.work.effort.WorkEffortParty",
    ASSOC = "mantle.work.effort.WorkEffortAssoc",
    ASSIGN = "mantle.work.effort.WorkEffortAssetAssign",
    CONTENT = "mantle.work.effort.WorkEffortContent",
    SKILL_STANDARD = "mantle.work.effort.WorkEffortSkillStandard",
    TIME = "mantle.work.time.TimeEntry",
    TIMESHEET = "mantle.work.time.Timesheet",
    ACK = "mantle.work.production.InstructionAcknowledgment",
    RUNTIME = "mantle.work.production.MachineRuntimeEvent",
    EVENT = "mantle.work.production.ProductionCostEvent",
    CENTER_RATE = "mantle.work.production.WorkCenterRate",
    RATE = "mantle.humanres.rate.RateAmount",
    ASSET = "mantle.product.asset.Asset",
    OUTAGE = "mantle.work.effort.ResourceUnavailability",
    FACILITY = "mantle.facility.Facility",
    PRODUCT = "mantle.product.Product",
    STATUS = "moqui.basic.StatusItem",
    ENUM = "moqui.basic.Enumeration"
const runStatuses = ["WeApproved", "WeInProgress", "WeOnHold"]
const blockedEquipment = ["AstDeactivated", "AstOnHold", "AstDelivered"]
const stockTypes = ["AstTpInventory", "AstTpSupplies"]
const queueLimit = 100
// the board's groups (ShopFloor's queue), in the operator's order
const groups = [
    {id: "running", label: "Running", color: "primary"},
    {id: "ready", label: "Ready", color: "positive"},
    {id: "paused", label: "Paused", color: "warning"},
    {id: "blocked", label: "Blocked", color: "negative"},
    {id: "done", label: "Done", color: "grey"}
]

const zero = () => toDecimal(0)
const dec = value => toDecimal(value ?? 0)
const blank = value => value == null || String(value).trim() === ""
const str = value => (blank(value) ? null : String(value).trim())
const text = value => (value == null ? null : dec(value).compare(0) === 0 ? "0" : String(dec(value).toNumber()))
const when = value => lib.dateText(value)
const yes = value => value === true || value === "true" || value === "Y"
const production = () => ec.resource.script("component://mr-mantle/service/mantle/work/Production.js")
const orders = () => ec.resource.script("component://mr-mantle/service/mantle/work/ProductionOrders.js")
const quantities = () => ec.resource.script("component://mr-mantle/service/mantle/work/ProductionQuantities.js")
const quality = () => ec.resource.script("component://mr-mantle/service/mantle/work/ProductionQuality.js")
const productionPolicy = () => ec.resource.script("component://mr-mantle/service/mantle/work/ProductionPolicy.js")
const statusText = statusId => (statusId ? one(STATUS, {statusId})?.description || statusId : "")
const enumText = enumId => (enumId ? one(ENUM, {enumId})?.description || enumId : "")
const productName = productId => (productId ? one(PRODUCT, {productId})?.productName || productId : "")
const facilityName = facilityId => {
    const facility = facilityId ? one(FACILITY, {facilityId}) : null
    return facility ? facility.facilityName || facility.facilityId : ""
}
const opName = op => op.workEffortName || op.workEffortId
const myParty = () => ec.user.userAccount?.partyId || null

function requireAny(permissions) {
    if (!permissions.some(access.has)) denied("PERMISSION_DENIED", permissions.join(" or ") + " is required")
}

// ===== the operation and its run =====
// An operation child of a production run of the user's organizations; a missing one and one outside the scope are refused
// alike, naming the operation only.
function operationOf(userScope, operationWorkEffortId, lock = false) {
    const op = blank(operationWorkEffortId) ? null : find(WORK, {workEffortId: operationWorkEffortId}).forUpdate(lock).one()
    let run = null
    if (op?.parentWorkEffortId && op.workEffortTypeEnumId === "WetTask")
        try {
            run = production().runOf(userScope, op.parentWorkEffortId)
        } catch (error) {
            if (lib.reasonCode(error) !== "RECORD_UNAVAILABLE") throw error
        }
    if (!run) denied("RECORD_UNAVAILABLE", "Operation " + (operationWorkEffortId || "") + " is not available")
    return {op, run}
}
// The run a time entry's work effort belongs to (the run itself, or an operation's run), or null.
function runOfWork(workEffortId) {
    const work = workEffortId ? one(WORK, {workEffortId}) : null
    if (!work) return null
    if (work.purposeEnumId === "WepProductionRun") return work
    const parent = work.parentWorkEffortId ? one(WORK, {workEffortId: work.parentWorkEffortId}) : null
    return parent?.purposeEnumId === "WepProductionRun" ? parent : null
}
const operationsOfRun = workEffortId =>
    rows(WORK, {parentWorkEffortId: workEffortId})
        .filter(op => op.statusId !== "WeCancelled")
        .sort(
            (a, b) => Number(a.operationSequenceNum ?? a.sequenceNum ?? 0) - Number(b.operationSequenceNum ?? b.sequenceNum ?? 0)
        )
// The routing operation a run's operation was released from, and the operation template it was copied from.
function methodOf(op) {
    const routingOp = op.routingOperationWorkEffortId ? one(WORK, {workEffortId: op.routingOperationWorkEffortId}) : null
    const template = routingOp?.methodSourceWorkEffortId ? one(WORK, {workEffortId: routingOp.methodSourceWorkEffortId}) : null
    return {routingOp, template, ids: [routingOp?.workEffortId, template?.workEffortId].filter(Boolean)}
}
// The operation's named predecessors (its routing operation's WeatRoutingComp predecessorWorkEffortIds as of the run's
// method date), as the run's operations.
function predecessorsOf(run, op, operations = operationsOfRun(run.workEffortId)) {
    if (!op.routingOperationWorkEffortId) return []
    const methodDate = run.productionMethodDate || ec.user.nowTimestamp
    const comp = rows(ASSOC, {
        toWorkEffortId: op.routingOperationWorkEffortId,
        workEffortAssocTypeEnumId: "WeatRoutingComp"
    }).find(row => lib.active(row, methodDate))
    const ids = String(comp?.predecessorWorkEffortIds || "")
        .split(/[\s,]+/)
        .filter(Boolean)
    return operations.filter(other => ids.includes(other.routingOperationWorkEffortId))
}
// The operation that receives the run's output: the output line's operation, else the last one.
function isOutputOperation(run, op) {
    const output = production()
        .linesOf(run.workEffortId)
        .find(line => line.lineRoleEnumId === "PrlrOutput")
    if (output?.operationWorkEffortId) return output.operationWorkEffortId === op.workEffortId
    const operations = operationsOfRun(run.workEffortId)
    return !operations.length || operations[operations.length - 1].workEffortId === op.workEffortId
}

// ===== instructions and evidence =====
// The instructions of the operation as of the run's release (its routing operation's and its template's WectInstruction rows
// in effect then), with a later publish named for a revision warning.
function instructionsOf(run, op) {
    const method = methodOf(op)
    const at = run.productionReleaseDate || ec.user.nowTimestamp
    const all = []
    for (const workEffortId of method.ids)
        for (const row of rows(CONTENT, {workEffortId, contentTypeEnumId: "WectInstruction"})) all.push(row)
    const current = all.filter(row => row.fromDate && lib.active(row, at))
    const newer = all.filter(row => lib.ms(row.fromDate) > lib.ms(at))
    return {method, current, newer}
}
// An instruction's text when it is a text file (Markdown or plain), else only its name.
function instructionText(row) {
    const location = row.contentLocation
    const fileName = location ? String(location).split("/").pop() : null
    let body = null
    if (location && /\.(md|markdown|txt|text)$/i.test(fileName || ""))
        try {
            body = String(ec.resource.getLocationReference(location).getText() || "").slice(0, 20000)
        } catch (error) {
            ec.logger.error("Instruction " + row.workEffortContentId + " could not be read: " + error.message)
        }
    return {fileName, body}
}
const acknowledgmentsOf = operationWorkEffortId =>
    rows(ACK, {operationWorkEffortId}).sort((a, b) => lib.ms(a.acknowledgedDate) - lib.ms(b.acknowledgedDate))
const requiredEvidence = method => str(method.routingOp?.methodRequiredEvidence) || str(method.template?.methodRequiredEvidence)
// The skills the operation's routing operation and template require (WorkEffortSkillStandard) that the person lacks.
function skillsOf(method, partyId) {
    if (!method.ids.length) return {required: [], missing: []}
    const required = Array.from(
        new Set(
            Array.from(
                find(SKILL_STANDARD).condition("workEffortId", "in", method.ids).selectField("skillTypeEnumId").list()
            ).map(row => row.skillTypeEnumId)
        )
    )
    const held = new Set(partyId ? rows("mantle.humanres.ability.PartySkill", {partyId}).map(row => row.skillTypeEnumId) : [])
    return {required: required.map(enumText), missing: required.filter(skill => !held.has(skill)).map(enumText)}
}

// ===== the start checks =====
// Each check of an operation's start (design OperationExecution Actions): {code, label, ok, blocking, overridable, message}.
// Required skills and acknowledgment block, unless a supervisor overrode them on the operation; with neither configured an
// advisory says so (§4).
function startChecks(run, op, partyId) {
    const checks = []
    const add = (code, label, ok, message, extra = {}) =>
        checks.push(Object.assign({code, label, ok, blocking: !ok, overridable: false, message}, extra))
    add(
        run.statusId === "WeOnHold" ? "RUN_ON_HOLD" : "RUN_NOT_RUNNING",
        "Work order running",
        run.statusId === "WeInProgress",
        run.statusId === "WeInProgress"
            ? "Work order " + run.workEffortId + " is running"
            : "Work order " + run.workEffortId + " is " + statusText(run.statusId) + "; a supervisor starts or resumes it"
    )
    add(
        "OPERATION_CLOSED",
        "Operation open",
        !["WeComplete", "WeCancelled"].includes(op.statusId),
        "Operation " + opName(op) + " is " + statusText(op.statusId)
    )
    // predecessors started (an operation may overlap the one before it; its completion waits for it, complete#)
    const operations = operationsOfRun(run.workEffortId)
    const notStarted = predecessorsOf(run, op, operations).filter(pred => ["WeApproved", "WeInPlanning"].includes(pred.statusId))
    add(
        "PREDECESSOR_NOT_STARTED",
        "Predecessors",
        !notStarted.length,
        notStarted.length
            ? "Waiting for " + notStarted.map(opName).join(", ") + " to start"
            : "The operations before it have started"
    )
    // the in-process quality gate before it (P8) and a staged short material line of the operation (P5a)
    const gate = quality().operationGate(run, op.workEffortId)
    add("QUALITY_BLOCKED", "Quality gate", !gate, gate ? gate.message : "No quality gate holds it", {
        qualityInspectionId: gate?.qualityInspectionId || null
    })
    const short = production()
        .linesOf(run.workEffortId)
        .filter(line => line.operationWorkEffortId === op.workEffortId && dec(line.stagedShortQuantity).compare(0) > 0)
    add(
        "MATERIAL_SHORT",
        "Material",
        !short.length,
        short.length
            ? "Short of " + short.map(line => productName(line.productId)).join(", ") + " (released short)"
            : "Its material is not held back"
    )
    // the run's equipment: none deactivated, on hold or out of service
    const now = ec.user.nowTimestamp
    const equipment = rows(ASSIGN, {workEffortId: run.workEffortId}).filter(row => lib.active(row, now))
    const down = []
    for (const row of equipment) {
        const asset = one(ASSET, {assetId: row.assetId})
        const outage = find(OUTAGE, {assetId: row.assetId, unavailabilityKindEnumId: "RukActual"})
            .condition("thruDate", "is-null", null)
            .count()
        if ((asset && blockedEquipment.includes(asset.statusId)) || outage) down.push(asset?.assetName || row.assetId)
    }
    add(
        "EQUIPMENT_UNAVAILABLE",
        "Equipment",
        !down.length,
        down.length ? down.join(", ") + " is out of service" : "Its equipment is available"
    )
    // the operator: one assigned to the run or the operation when it names any (a supervisor may start it too)
    const assignees = rows(PARTY, {workEffortId: run.workEffortId, roleTypeId: "Assignee"})
        .concat(rows(PARTY, {workEffortId: op.workEffortId, roleTypeId: "Assignee"}))
        .filter(row => lib.active(row, now))
    const isAssigned = !assignees.length || assignees.some(row => row.partyId === partyId)
    add(
        "NOT_ASSIGNED",
        "Operator",
        isAssigned || access.has("PRODUCTION_SUPERVISE"),
        isAssigned ? "You may run it" : "You are not assigned to work order " + run.workEffortId
    )
    // the skills and the acknowledgment the method requires, overridable by a supervisor
    const method = methodOf(op)
    const skills = skillsOf(method, partyId)
    const instructions = instructionsOf(run, op).current
    const acknowledged = new Set(
        acknowledgmentsOf(op.workEffortId)
            .filter(row => row.stepTypeEnumId === "IstAcknowledge" && row.partyId === partyId)
            .map(row => row.workEffortContentId)
    )
    const unread = instructions.filter(row => !acknowledged.has(row.workEffortContentId))
    const overrideChecks = blank(op.productionStartOverride)
        ? []
        : String(op.productionStartOverrideChecks || "SKILL_MISSING").split(",")
    const overrideText = overrideChecks.length ? "overridden by a supervisor: " + op.productionStartOverride : null
    const skillOverride = overrideChecks.includes("SKILL_MISSING"),
        readOverride = overrideChecks.includes("ACKNOWLEDGMENT_REQUIRED")
    checks.push({
        code: "SKILL_MISSING",
        label: "Skills",
        ok: !skills.missing.length || skillOverride,
        blocking: !!skills.missing.length && !skillOverride,
        overridable: true,
        message: skills.missing.length
            ? "Not qualified in " + skills.missing.join(", ") + (skillOverride ? "; " + overrideText : "")
            : skills.required.length
              ? "Qualified in " + skills.required.join(", ")
              : "No skill is required"
    })
    checks.push({
        code: "ACKNOWLEDGMENT_REQUIRED",
        label: "Instructions",
        ok: !unread.length || readOverride,
        blocking: !!unread.length && !readOverride,
        overridable: true,
        message: unread.length
            ? "Read and acknowledge the instructions first" + (readOverride ? "; " + overrideText : "")
            : instructions.length
              ? "Instructions acknowledged"
              : "No instruction to acknowledge"
    })
    const advisories = []
    if (!skills.required.length && !instructions.length)
        advisories.push("No skills or instruction acknowledgment are required for this operation")
    if (skills.missing.length && skillOverride) advisories.push("Skills " + overrideText)
    if (unread.length && readOverride) advisories.push("Instructions " + overrideText)
    const blocked = checks.find(check => check.blocking) || null
    return {checks, blocked, advisories}
}

// ===== the person timer =====
const timerOf = () => call("mantle.work.TimesheetServices.get#Timer").timer || null
function timerRow(timer, op) {
    if (!timer) return null
    return {
        timeEntryId: timer.timeEntryId,
        workEffortId: timer.workEffortId,
        workEffortName: timer.workEffortName,
        here: !!op && timer.workEffortId === op.workEffortId,
        elapsedMinutes: timer.elapsedMinutes,
        fromText: when(timer.fromDate)
    }
}

// ===== get#ShopFloorQueue =====
// The facilities a plant or work center covers: itself and the lines under it, in the user's organizations.
function facilityIdsOf(userScope, facilityId) {
    if (blank(facilityId)) return null
    const facility = posting.facility(userScope, facilityId)
    return [facility.facilityId].concat(
        rows(FACILITY, {parentFacilityId: facility.facilityId})
            .filter(row => facilityScope.owns(userScope, row.ownerPartyId))
            .map(row => row.facilityId)
    )
}
function stateOf(run, op, readiness) {
    if (op.statusId === "WeComplete") return "done"
    if (op.statusId === "WeInProgress") return "running"
    if (op.statusId === "WeOnHold") return "paused"
    if (run.statusId === "WeInProgress" && readiness?.ready) return "ready"
    return "blocked"
}
function queue(p) {
    requireAny(["PRODUCTION_VIEW", "PRODUCTION_OPERATE", "PRODUCTION_SUPERVISE"])
    const userScope = posting.scope()
    const facilityIds = facilityIdsOf(userScope, p.facilityId)
    let runFind = find(WORK, {purposeEnumId: "WepProductionRun"}).condition("statusId", "in", runStatuses)
    if (userScope.organizationPartyIds) runFind = runFind.condition("ownerPartyId", "in", userScope.organizationPartyIds)
    if (facilityIds) runFind = runFind.condition("facilityId", "in", facilityIds)
    if (!blank(p.workEffortId)) runFind = runFind.condition("workEffortId", p.workEffortId)
    const partyId = myParty()
    const now = ec.user.nowTimestamp
    // mine: the work orders the user is assigned to, or one of whose operations, chosen before the limit
    if (yes(p.mine)) {
        const mineIds = rows(PARTY, {partyId: partyId || "_NA_", roleTypeId: "Assignee"})
            .filter(row => lib.active(row, now))
            .map(row => row.workEffortId)
        const parentIds = mineIds.length
            ? Array.from(
                  find(WORK)
                      .condition("workEffortId", "in", mineIds)
                      .condition("parentWorkEffortId", "is-not-null", null)
                      .selectField("parentWorkEffortId")
                      .list()
              ).map(row => row.parentWorkEffortId)
            : []
        runFind = runFind.condition("workEffortId", "in", Array.from(new Set(mineIds.concat(parentIds))).concat(["_NA_"]))
    }
    const runs = Array.from(runFind.orderBy("estimatedStartDate").orderBy("workEffortId").limit(queueLimit).list())
    const timer = timerOf()
    const operationRows = []
    for (const run of runs) {
        let read
        try {
            read = orders().execute("operations", {workEffortId: run.workEffortId})
        } catch (error) {
            // a run that cannot be read is named and the others are listed (failure tolerance)
            ec.logger.error("Shop floor queue: work order " + run.workEffortId + " was not read: " + error.message)
            continue
        }
        const output = production()
            .linesOf(run.workEffortId)
            .find(line => line.lineRoleEnumId === "PrlrOutput")
        for (const row of read.operationRows) {
            if (!row.workEffortId) continue
            const op = one(WORK, {workEffortId: row.workEffortId})
            const center = row.workCenterFacilityId || run.facilityId
            if (!blank(p.workCenterFacilityId) && center !== p.workCenterFacilityId) continue
            const state = stateOf(run, op, row)
            if (state === "done" && !yes(p.includeDone)) continue
            if (yes(p.readyOnly) && state !== "ready" && state !== "running") continue
            const due = op.estimatedCompletionDate || run.estimatedCompletionDate || null
            operationRows.push({
                operationWorkEffortId: op.workEffortId,
                operationName: opName(op),
                workEffortId: run.workEffortId,
                runName: run.workEffortName || run.workEffortId,
                productId: output?.productId || null,
                productName: output ? productName(output.productId) : "",
                quantityText: output ? text(output.quantity) : null,
                workCenterFacilityId: center,
                workCenterName: row.workCenterName || facilityName(center),
                sequenceNum: row.sequenceNum,
                statusId: op.statusId,
                statusText: statusText(op.statusId),
                state,
                stateText: groups.find(group => group.id === state).label,
                readinessText: run.statusId === "WeApproved" ? "Work order not started" : row.readinessText,
                dueDate: due,
                dueText: when(due),
                timerHere: !!timer && timer.workEffortId === op.workEffortId,
                title: opName(op) + " · " + (run.workEffortName || run.workEffortId)
            })
        }
    }
    const order = new Map(groups.map((group, index) => [group.id, index]))
    operationRows.sort(
        (a, b) =>
            order.get(a.state) - order.get(b.state) ||
            (lib.ms(a.dueDate) ?? Infinity) - (lib.ms(b.dueDate) ?? Infinity) ||
            Number(a.sequenceNum || 0) - Number(b.sequenceNum || 0)
    )
    return {
        operationRows,
        groups: groups.filter(group => group.id !== "done" || yes(p.includeDone)),
        timer: timerRow(timer, null),
        truncated: runs.length >= queueLimit
    }
}

// ===== get#ProductionOperation =====
const financial = () => access.has("ACCOUNTING_VIEW")
function runtimeRow(row, showValue) {
    const asset = row.assetId ? one(ASSET, {assetId: row.assetId}) : null
    return Object.assign(
        {
            machineRuntimeEventId: row.machineRuntimeEventId,
            assetId: row.assetId || null,
            assetName: asset?.assetName || row.assetId || "",
            modeText: enumText(row.runtimeModeEnumId),
            fromText: when(row.fromDate),
            thruText: when(row.thruDate),
            hours: text(row.hours),
            open: row.thruDate == null,
            valued: row.valuationStatusEnumId === "PcvValued",
            valuationText: row.thruDate == null ? "Running" : row.valuationStatusEnumId === "PcvValued" ? "Valued" : "Not valued"
        },
        showValue ? {rateAmount: text(row.rateAmount), amount: text(row.amount), amountUomId: row.amountUomId || null} : {}
    )
}
function readOperation(p) {
    requireAny(["PRODUCTION_VIEW", "PRODUCTION_OPERATE", "PRODUCTION_SUPERVISE"])
    const userScope = posting.scope()
    const {op, run} = operationOf(userScope, p.operationWorkEffortId)
    const partyId = myParty()
    const lines = production().linesOf(run.workEffortId)
    const output = lines.find(line => line.lineRoleEnumId === "PrlrOutput") || null
    const figures = output ? quantities().outputFigures(run, output) : null
    const readiness = orders()
        .execute("operations", {workEffortId: run.workEffortId})
        .operationRows.find(row => row.workEffortId === op.workEffortId)
    const checks = startChecks(run, op, partyId)
    const timer = timerOf()
    const method = methodOf(op)
    const evidenceText = requiredEvidence(method)
    const acknowledgments = acknowledgmentsOf(op.workEffortId)
    const instructions = instructionsOf(run, op)
    const runtimes = rows(RUNTIME, {operationWorkEffortId: op.workEffortId}).sort(
        (a, b) => lib.ms(b.fromDate) - lib.ms(a.fromDate)
    )
    const policy = productionPolicy().runPolicy(run)
    const predecessors = predecessorsOf(run, op)
    const open = !["WeComplete", "WeCancelled"].includes(op.statusId)
    const operate = access.has("PRODUCTION_OPERATE")
    return {
        operation: {
            operationWorkEffortId: op.workEffortId,
            operationName: opName(op),
            description: op.description || null,
            statusId: op.statusId,
            statusText: statusText(op.statusId),
            sequenceNum: op.operationSequenceNum ?? op.sequenceNum ?? null,
            workCenterFacilityId: op.workCenterFacilityId || run.facilityId || null,
            workCenterName: facilityName(op.workCenterFacilityId || run.facilityId),
            plannedText: [when(op.estimatedStartDate), when(op.estimatedCompletionDate)].filter(Boolean).join(" to "),
            actualText: [when(op.actualStartDate), when(op.actualCompletionDate)].filter(Boolean).join(" to "),
            goodQuantity: text(op.productionGoodQuantity),
            lossQuantity: text(op.productionLossQuantity),
            readinessText: readiness?.readinessText || "",
            predecessorText: predecessors.map(pred => opName(pred) + " (" + statusText(pred.statusId) + ")").join(", "),
            outputOperation: isOutputOperation(run, op),
            override: op.productionStartOverride || null,
            overrideText: op.productionStartOverride
                ? "Start overridden " + when(op.productionStartOverrideDate) + ": " + op.productionStartOverride
                : null
        },
        run: {
            workEffortId: run.workEffortId,
            runName: run.workEffortName || run.workEffortId,
            statusId: run.statusId,
            statusText: statusText(run.statusId),
            revision: Number(run.productionRevision || 0),
            releaseText: when(run.productionReleaseDate),
            productId: output?.productId || null,
            productName: output ? productName(output.productId) : "",
            facilityName: facilityName(run.facilityId),
            productionRunLineId: output?.productionRunLineId || null,
            unitText: output?.stockUomId ? one("moqui.basic.Uom", {uomId: output.stockUomId})?.description || null : null
        },
        quantities: figures
            ? {
                  target: text(figures.target),
                  good: text(figures.good),
                  held: text(figures.held),
                  loss: text(figures.processLoss.add(figures.scrap).add(figures.rework)),
                  remaining: text(figures.remaining)
              }
            : null,
        materialRows: lines
            .filter(line => line.lineRoleEnumId === "PrlrMaterial" && line.operationWorkEffortId === op.workEffortId)
            .map(line => ({
                productionRunLineId: line.productionRunLineId,
                productName: productName(line.productId),
                quantity: text(line.stockQuantity ?? line.quantity)
            })),
        checks: checks.checks,
        blocked: checks.blocked ? {code: checks.blocked.code, message: checks.blocked.message} : null,
        advisories: checks.advisories,
        timer: timerRow(timer, op),
        runtimeRows: runtimes.map(row => runtimeRow(row, financial())),
        openRuntimeId: runtimes.find(row => row.thruDate == null)?.machineRuntimeEventId || null,
        instructionCount: instructions.current.length,
        evidence: {
            required: !!evidenceText,
            text: evidenceText,
            recorded: acknowledgments.some(row => row.stepTypeEnumId === "IstEvidence")
        },
        policy: {
            machineRuntimeEnumId: policy.machineRuntimeEnumId || null,
            pieceRate: policy.pieceRate === "Y",
            timeLogEnforcementEnumId: policy.timeLogEnforcementEnumId || null
        },
        can: {
            start: operate && open && !checks.blocked,
            pause: operate && op.statusId === "WeInProgress",
            complete: operate && ["WeInProgress", "WeOnHold"].includes(op.statusId),
            machine: operate && open && policy.machineRuntimeEnumId !== "PmrNotRecorded",
            override: access.has("PRODUCTION_SUPERVISE") && open,
            receiveOutput: access.has("STOCK_ISSUE")
        }
    }
}

// ===== get#ProductionInstructions and record#InstructionStep =====
function readInstructions(p) {
    requireAny(["PRODUCTION_VIEW", "PRODUCTION_OPERATE", "PRODUCTION_SUPERVISE"])
    const {op, run} = operationOf(posting.scope(), p.operationWorkEffortId)
    const partyId = myParty()
    const found = instructionsOf(run, op)
    const acknowledgments = acknowledgmentsOf(op.workEffortId)
    const evidenceText = requiredEvidence(found.method)
    const instructionRows = found.current.map((row, index) => {
        const mine = acknowledgments.find(
            ack =>
                ack.stepTypeEnumId === "IstAcknowledge" &&
                ack.workEffortContentId === row.workEffortContentId &&
                ack.partyId === partyId
        )
        const read = instructionText(row)
        return {
            stepNumber: index + 1,
            workEffortContentId: row.workEffortContentId,
            title: row.description || read.fileName || "Instruction " + (index + 1),
            fileName: read.fileName,
            body: read.body,
            contentChecksum: row.contentChecksum || null,
            fromText: when(row.fromDate),
            acknowledged: !!mine,
            acknowledgedText: mine ? "Acknowledged " + when(mine.acknowledgedDate) : "Not acknowledged yet"
        }
    })
    const people = new Map()
    const personName = id => {
        if (!id) return ""
        if (!people.has(id)) {
            const person = one("mantle.party.Person", {partyId: id})
            people.set(id, person ? [person.firstName, person.lastName].filter(Boolean).join(" ") || id : id)
        }
        return people.get(id)
    }
    return {
        operationWorkEffortId: op.workEffortId,
        operationName: opName(op),
        workEffortId: run.workEffortId,
        runName: run.workEffortName || run.workEffortId,
        releaseText: when(run.productionReleaseDate),
        instructionRows,
        allAcknowledged: instructionRows.every(row => row.acknowledged),
        revisionWarning: found.newer.length
            ? "A newer instruction was published " +
              when(found.newer[0].fromDate) +
              "; this work order keeps the one of its release until it is amended"
            : null,
        evidence: {
            required: !!evidenceText,
            text: evidenceText,
            recorded: acknowledgments.some(row => row.stepTypeEnumId === "IstEvidence")
        },
        acknowledgmentRows: acknowledgments.map(row => ({
            instructionAcknowledgmentId: row.instructionAcknowledgmentId,
            stepText: enumText(row.stepTypeEnumId),
            personName: personName(row.partyId),
            whenText: when(row.acknowledgedDate),
            valueText: row.valueText || null,
            comments: row.comments || null
        })),
        canRecord: access.has("PRODUCTION_OPERATE") && !["WeComplete", "WeCancelled"].includes(op.statusId)
    }
}
function recordStep(p) {
    const begun = posting.begin(p, "InstructionStep", "PRODUCTION_OPERATE", [
        "operationWorkEffortId",
        "stepTypeEnumId",
        "workEffortContentId",
        "valueText",
        "valueUomId",
        "contentLocation",
        "comments"
    ])
    if (begun.previous) return begun.previous
    const {op, run} = operationOf(posting.scope(), p.operationWorkEffortId, true)
    const settled = posting.settled(begun.op)
    if (settled) return settled
    if (!runStatuses.includes(run.statusId))
        denied("RUN_NOT_RELEASED", "Work order " + run.workEffortId + " is " + statusText(run.statusId))
    if (["WeComplete", "WeCancelled"].includes(op.statusId))
        denied("OPERATION_CLOSED", "Operation " + opName(op) + " is " + statusText(op.statusId))
    const partyId = myParty()
    if (!partyId) denied("PARTY_REQUIRED", "Sign in as a person to record an instruction step")
    const stepTypeEnumId = str(p.stepTypeEnumId) || "IstAcknowledge"
    const found = instructionsOf(run, op)
    let workEffortContentId = null
    if (stepTypeEnumId === "IstAcknowledge") {
        const row = found.current.find(instruction => instruction.workEffortContentId === p.workEffortContentId)
        if (!row)
            denied(
                "INSTRUCTION_INVALID",
                "Instruction " + (p.workEffortContentId || "") + " is not the instruction of operation " + opName(op)
            )
        workEffortContentId = row.workEffortContentId
        const already = acknowledgmentsOf(op.workEffortId).find(
            ack =>
                ack.stepTypeEnumId === stepTypeEnumId &&
                ack.workEffortContentId === workEffortContentId &&
                ack.partyId === partyId
        )
        if (already)
            return posting.complete(begun.op, run.ownerPartyId, ACK, already.instructionAcknowledgmentId, {
                resultCode: "ALREADY_ACKNOWLEDGED",
                instructionAcknowledgmentId: already.instructionAcknowledgmentId,
                operationWorkEffortId: op.workEffortId
            })
    } else if (stepTypeEnumId === "IstEvidence") {
        if (!requiredEvidence(found.method) && blank(p.valueText) && blank(p.contentLocation))
            denied("EVIDENCE_NOT_REQUIRED", "Operation " + opName(op) + " requires no evidence")
        if (blank(p.valueText) && blank(p.contentLocation))
            denied("VALUE_REQUIRED", "Enter the evidence: " + (requiredEvidence(found.method) || "a value or a file"))
        workEffortContentId = found.current[0]?.workEffortContentId || null
    } else denied("STEP_INVALID", "Unknown instruction step " + stepTypeEnumId)
    const created = call("create#" + ACK, {
        organizationPartyId: run.ownerPartyId,
        workEffortId: run.workEffortId,
        operationWorkEffortId: op.workEffortId,
        workEffortContentId,
        stepTypeEnumId,
        partyId,
        userId: ec.user.userId,
        acknowledgedDate: ec.user.nowTimestamp,
        valueText: str(p.valueText),
        valueUomId: str(p.valueUomId),
        contentLocation: str(p.contentLocation),
        comments: str(p.comments)
    })
    return posting.complete(begun.op, run.ownerPartyId, ACK, created.instructionAcknowledgmentId, {
        resultCode: stepTypeEnumId === "IstEvidence" ? "EVIDENCE_RECORDED" : "ACKNOWLEDGED",
        instructionAcknowledgmentId: created.instructionAcknowledgmentId,
        operationWorkEffortId: op.workEffortId,
        workEffortContentId
    })
}

// ===== start#, override#, pause# and complete#ProductionOperation =====
function overrideStart(p) {
    const begun = posting.begin(p, "ProductionOperationOverride", "PRODUCTION_SUPERVISE", [
        "operationWorkEffortId",
        "reason",
        "acknowledgment"
    ])
    if (begun.previous) return begun.previous
    const {op, run} = operationOf(posting.scope(), p.operationWorkEffortId, true)
    const settled = posting.settled(begun.op)
    if (settled) return settled
    if (["WeComplete", "WeCancelled"].includes(op.statusId))
        denied("OPERATION_CLOSED", "Operation " + opName(op) + " is " + statusText(op.statusId))
    const reason = str(p.reason)
    if (!reason) denied("REASON_REQUIRED", "Give the reason the operation may start without the skills or acknowledgment")
    call("update#" + WORK, {
        workEffortId: op.workEffortId,
        productionStartOverride: reason.slice(0, 255),
        productionStartOverrideChecks: yes(p.acknowledgment) ? "SKILL_MISSING,ACKNOWLEDGMENT_REQUIRED" : "SKILL_MISSING",
        productionStartOverrideByUserId: ec.user.userId,
        productionStartOverrideDate: ec.user.nowTimestamp
    })
    return posting.complete(begun.op, run.ownerPartyId, WORK, op.workEffortId, {
        resultCode: "OVERRIDDEN",
        operationWorkEffortId: op.workEffortId,
        workEffortId: run.workEffortId
    })
}
function start(p) {
    const begun = posting.begin(p, "ProductionOperationStart", "PRODUCTION_OPERATE", [
        "operationWorkEffortId",
        "workTypeEnumId",
        "confirmSwitch",
        "comments"
    ])
    if (begun.previous) return begun.previous
    const {op, run} = operationOf(posting.scope(), p.operationWorkEffortId, true)
    const settled = posting.settled(begun.op)
    if (settled) return settled
    const partyId = myParty()
    if (!partyId) denied("PARTY_REQUIRED", "Sign in as a person to start an operation")
    const checks = startChecks(run, op, partyId)
    if (checks.blocked) denied(checks.blocked.code, checks.blocked.message)
    // one person timer suite-wide: a timer running on other work stops only once the switch is confirmed
    const timer = timerOf()
    if (timer && timer.workEffortId !== op.workEffortId && !yes(p.confirmSwitch))
        denied(
            "TIMER_SWITCH_REQUIRED",
            "Your timer is running on " +
                (timer.workEffortName || timer.workEffortId || "other work") +
                "; confirm to stop it and start " +
                opName(op)
        )
    const policy = productionPolicy().runPolicy(run)
    const started = call("mantle.work.TimesheetServices.start#Timer", {
        workEffortId: op.workEffortId,
        workTypeEnumId: str(p.workTypeEnumId) || policy.workTypeEnumId || "WktpProductionRun",
        comments: str(p.comments)
    })
    const resultCode = op.statusId === "WeInProgress" ? "JOINED" : op.statusId === "WeOnHold" ? "RESUMED" : "STARTED"
    if (op.statusId !== "WeInProgress")
        call("update#" + WORK, {
            workEffortId: op.workEffortId,
            statusId: "WeInProgress",
            actualStartDate: op.actualStartDate || ec.user.nowTimestamp
        })
    return posting.complete(begun.op, run.ownerPartyId, WORK, op.workEffortId, {
        resultCode,
        operationWorkEffortId: op.workEffortId,
        workEffortId: run.workEffortId,
        timeEntryId: started.timeEntryId || null,
        stoppedTimeEntryIds: Array.from(started.stoppedTimeEntryIds || []),
        switched: Array.from(started.stoppedTimeEntryIds || []).length > 0,
        advisories: checks.advisories
    })
}
// The reason of a pause: an active hold or downtime reason of the run's organization, and the text.
function pauseReason(run, p) {
    const parts = []
    if (!blank(p.reasonCode)) {
        const reason = productionPolicy().activeReason(run.ownerPartyId, p.reasonCode)
        if (!reason) denied("REASON_INVALID", "Reason " + p.reasonCode + " is not an active production reason")
        parts.push(reason.reasonName || p.reasonCode)
    }
    if (!blank(p.reason)) parts.push(String(p.reason).trim())
    return parts.join(": ") || null
}
function pause(p) {
    const begun = posting.begin(p, "ProductionOperationPause", "PRODUCTION_OPERATE", [
        "operationWorkEffortId",
        "reason",
        "reasonCode",
        "stopTimer"
    ])
    if (begun.previous) return begun.previous
    const {op, run} = operationOf(posting.scope(), p.operationWorkEffortId, true)
    const settled = posting.settled(begun.op)
    if (settled) return settled
    if (op.statusId !== "WeInProgress")
        denied("OPERATION_NOT_RUNNING", "Operation " + opName(op) + " is " + statusText(op.statusId))
    const why = pauseReason(run, p)
    if (!why) denied("REASON_REQUIRED", "Give the reason for the pause")
    let stopped = null
    const timer = timerOf()
    if (yes(p.stopTimer) && timer?.workEffortId === op.workEffortId)
        stopped = call("mantle.work.TimesheetServices.stop#Timer", {timeEntryId: timer.timeEntryId})
    ec.context.putAll({statusId_changeReason: why})
    call("update#" + WORK, {workEffortId: op.workEffortId, statusId: "WeOnHold", statusId_changeReason: why})
    return posting.complete(begun.op, run.ownerPartyId, WORK, op.workEffortId, {
        resultCode: "PAUSED",
        operationWorkEffortId: op.workEffortId,
        workEffortId: run.workEffortId,
        stoppedTimeEntryId: stopped?.timeEntryId || null,
        timerRunning: !stopped && timer?.workEffortId === op.workEffortId
    })
}
const quantityFields = ["good", "pending", "processLoss", "scrap", "rework"]
function quantityOf(value, label) {
    if (blank(value)) return zero()
    const quantity = dec(value)
    if (quantity.compare(0) < 0) denied("QUANTITY_INVALID", label + " cannot be negative")
    return quantity
}
function completeOperation(p) {
    const begun = posting.begin(
        p,
        "ProductionOperationComplete",
        "PRODUCTION_OPERATE",
        ["operationWorkEffortId", "productionRunLineId"].concat(quantityFields, [
            "reasonCode",
            "reason",
            "toLocationSeqId",
            "heldLocationSeqId",
            "lotNumber",
            "stopTimer"
        ])
    )
    if (begun.previous) return begun.previous
    const {op, run} = operationOf(posting.scope(), p.operationWorkEffortId, true)
    const settled = posting.settled(begun.op)
    if (settled) return settled
    if (["WeComplete", "WeCancelled"].includes(op.statusId))
        denied("OPERATION_CLOSED", "Operation " + opName(op) + " is " + statusText(op.statusId))
    if (!["WeInProgress", "WeOnHold"].includes(op.statusId))
        denied("OPERATION_NOT_STARTED", "Operation " + opName(op) + " has not started; start it first")
    if (run.statusId !== "WeInProgress")
        denied("RUN_NOT_RUNNING", "Work order " + run.workEffortId + " is " + statusText(run.statusId))
    // the operations before it complete, each named
    const open = predecessorsOf(run, op).filter(pred => pred.statusId !== "WeComplete")
    if (open.length)
        denied(
            "PREDECESSOR_OPEN",
            "Operation " +
                opName(op) +
                " waits for " +
                open.map(opName).join(", ") +
                "; complete " +
                (open.length === 1 ? "it" : "them") +
                " first"
        )
    const method = methodOf(op)
    const evidence = requiredEvidence(method)
    if (evidence && !acknowledgmentsOf(op.workEffortId).some(row => row.stepTypeEnumId === "IstEvidence"))
        denied("EVIDENCE_REQUIRED", "Record the evidence the operation requires: " + evidence)
    const running = rows(RUNTIME, {operationWorkEffortId: op.workEffortId}).find(row => row.thruDate == null)
    if (running) denied("MACHINE_RUNNING", "Stop the machine runtime started " + when(running.fromDate) + " first")
    const q = Object.fromEntries(quantityFields.map(field => [field, quantityOf(p[field], field)]))
    const outputOperation = isOutputOperation(run, op)
    // the output operation receives its good and pending output, coupled in this transaction; any operation records loss
    const posted = Object.fromEntries(
        quantityFields.map(field => [field, outputOperation || !["good", "pending"].includes(field) ? q[field] : zero()])
    )
    if (posted.good.add(posted.pending).compare(0) > 0 && !access.has("STOCK_ISSUE"))
        denied(
            "STOCK_ISSUE_REQUIRED",
            "Receiving the output needs the stock issue permission (STOCK_ISSUE) at the plant; complete with a stock handler, " +
                "or record the quantities on the work order's Quantities"
        )
    let quantity = null
    if (Object.values(posted).some(value => value.compare(0) > 0)) {
        quantity = call(
            "mantle.work.ProductionServices.record#ProductionQuantity",
            Object.assign(
                {
                    operationKey: begun.op.clientKey + "/quantity",
                    workEffortId: run.workEffortId,
                    productionRunLineId: str(p.productionRunLineId),
                    operationWorkEffortId: op.workEffortId,
                    reasonCode: str(p.reasonCode),
                    reason: str(p.reason),
                    toLocationSeqId: str(p.toLocationSeqId),
                    heldLocationSeqId: str(p.heldLocationSeqId),
                    lotNumber: str(p.lotNumber)
                },
                Object.fromEntries(quantityFields.map(field => [field, posted[field].compare(0) > 0 ? posted[field] : null]))
            )
        ).result
        // beyond the target and tolerance only a supervisor's request is recorded: the operation stays open
        if (quantity?.resultCode === "APPROVAL_REQUESTED")
            return posting.complete(begun.op, run.ownerPartyId, WORK, op.workEffortId, {
                resultCode: "APPROVAL_REQUESTED",
                operationWorkEffortId: op.workEffortId,
                workEffortId: run.workEffortId,
                quantity,
                message: quantity.message
            })
    }
    // the person timer on it stops (unless the operator keeps it running), and under piece rate its entry takes the pieces
    let stopped = null
    const timer = timerOf()
    if ((p.stopTimer == null || yes(p.stopTimer)) && timer?.workEffortId === op.workEffortId)
        stopped = call("mantle.work.TimesheetServices.stop#Timer", {timeEntryId: timer.timeEntryId})
    const policy = productionPolicy().runPolicy(run)
    let pieceEntryId = null
    if (policy.pieceRate === "Y" && q.good.compare(0) > 0) {
        const partyId = myParty()
        const entry = stopped && !stopped.discarded ? one(TIME, {timeEntryId: stopped.timeEntryId}) : null
        const latest =
            entry ||
            Array.from(
                find(TIME, {workEffortId: op.workEffortId, partyId: partyId || "_NA_"})
                    .orderBy("-fromDate")
                    .limit(1)
                    .list()
            )[0]
        if (latest) {
            call("update#" + TIME, {timeEntryId: latest.timeEntryId, pieceCount: q.good})
            pieceEntryId = latest.timeEntryId
        }
    }
    call("update#" + WORK, {
        workEffortId: op.workEffortId,
        statusId: "WeComplete",
        actualCompletionDate: ec.user.nowTimestamp,
        productionGoodQuantity: q.good.add(q.pending),
        productionLossQuantity: q.processLoss.add(q.scrap).add(q.rework)
    })
    const left = operationsOfRun(run.workEffortId).filter(row => row.statusId !== "WeComplete")
    return posting.complete(begun.op, run.ownerPartyId, WORK, op.workEffortId, {
        resultCode: "COMPLETED",
        operationWorkEffortId: op.workEffortId,
        workEffortId: run.workEffortId,
        outputOperation,
        quantity,
        timeEntryId: stopped?.timeEntryId || null,
        hours: stopped && !stopped.discarded ? text(stopped.hours) : null,
        pieceCountEntryId: pieceEntryId,
        pieceCount: pieceEntryId ? text(q.good) : null,
        operationsLeft: left.length,
        message: left.length ? null : "Every operation is complete; the supervisor completes the work order"
    })
}

// ===== record#MachineRuntime =====
// The work center's machine rate in effect at a date: its approved PccMachine WorkCenterRate, the latest started.
function machineRate(facilityId, at) {
    if (!facilityId) return null
    return (
        rows(CENTER_RATE, {facilityId, componentTypeEnumId: "PccMachine"})
            .filter(row => row.state === "approved" && lib.active(row, at))
            .sort((a, b) => lib.ms(b.fromDate) - lib.ms(a.fromDate))[0] || null
    )
}
// A closed interval: its hours, its value at the rate in effect at its start (unvalued without one) and its cost event.
function closeRuntime(row, thruDate) {
    const millis = lib.ms(thruDate) - lib.ms(row.fromDate)
    const hours = toDecimal(millis).divide(toDecimal(3600000), 4, "HALF_UP")
    const rate = machineRate(row.facilityId, row.fromDate)
    const currency = rate?.priceUomId || null
    const amount = rate ? lib.money(hours.multiply(dec(rate.rateAmount)), currency) : null
    call("update#" + RUNTIME, {
        machineRuntimeEventId: row.machineRuntimeEventId,
        thruDate,
        hours,
        workCenterRateId: rate?.workCenterRateId || null,
        rateAmount: rate ? dec(rate.rateAmount) : null,
        amount,
        amountUomId: currency,
        valuationStatusEnumId: rate ? "PcvValued" : "PcvUnvalued",
        stoppedByUserId: ec.user.userId
    })
    const event = call("mantle.work.ProductionServices.record#ProductionCostEvent", {
        sourceEntityName: RUNTIME,
        sourceId: row.machineRuntimeEventId
    })
    call("update#" + RUNTIME, {
        machineRuntimeEventId: row.machineRuntimeEventId,
        productionCostEventId: event.productionCostEventId
    })
    return {hours, valued: !!rate, productionCostEventId: event.productionCostEventId}
}
function machineRuntime(p) {
    const begun = posting.begin(p, "MachineRuntime", "PRODUCTION_OPERATE", [
        "action",
        "operationWorkEffortId",
        "machineRuntimeEventId",
        "assetId",
        "runtimeModeEnumId",
        "fromDate",
        "thruDate",
        "reasonCode",
        "comments"
    ])
    if (begun.previous) return begun.previous
    const {op, run} = operationOf(posting.scope(), p.operationWorkEffortId, true)
    const settled = posting.settled(begun.op)
    if (settled) return settled
    const action = str(p.action) || "record"
    if (!["start", "stop", "record"].includes(action)) denied("ACTION_INVALID", "Unknown machine runtime action " + action)
    if (productionPolicy().runPolicy(run).machineRuntimeEnumId === "PmrNotRecorded")
        denied("MACHINE_RUNTIME_OFF", "The production policy records no machine runtime")
    if (!["WeInProgress", "WeOnHold"].includes(run.statusId))
        denied("RUN_NOT_RUNNING", "Work order " + run.workEffortId + " is " + statusText(run.statusId))
    if (op.statusId === "WeCancelled" || (action === "start" && op.statusId === "WeComplete"))
        denied("OPERATION_CLOSED", "Operation " + opName(op) + " is " + statusText(op.statusId))
    let asset = null
    if (!blank(p.assetId)) {
        asset = one(ASSET, {assetId: p.assetId})
        if (!asset || stockTypes.includes(asset.assetTypeEnumId) || asset.ownerPartyId !== run.ownerPartyId)
            denied(
                "ASSET_INVALID",
                "Asset " + p.assetId + " is not equipment of work order " + run.workEffortId + "'s organization"
            )
    }
    const now = ec.user.nowTimestamp
    const openRows = rows(RUNTIME, {operationWorkEffortId: op.workEffortId}).filter(
        row => row.thruDate == null && (row.assetId || null) === (asset?.assetId || null)
    )
    const answer = {operationWorkEffortId: op.workEffortId, workEffortId: run.workEffortId}
    const create = (fromDate, thruDate) =>
        call("create#" + RUNTIME, {
            organizationPartyId: run.ownerPartyId,
            workEffortId: run.workEffortId,
            operationWorkEffortId: op.workEffortId,
            facilityId: op.workCenterFacilityId || run.facilityId || null,
            assetId: asset?.assetId || null,
            runtimeModeEnumId: str(p.runtimeModeEnumId) || "MrmRun",
            fromDate,
            thruDate: null,
            reasonCode: str(p.reasonCode),
            comments: str(p.comments),
            startedByUserId: ec.user.userId,
            createdDate: now
        }).machineRuntimeEventId
    const interval = (from, thru) => {
        if (!from || !thru || lib.ms(thru) <= lib.ms(from) || lib.ms(thru) > lib.ms(now) + 60000)
            denied("INTERVAL_INVALID", "The machine ran from a start to a later end, not in the future")
    }
    let id, closed
    if (action === "start") {
        if (openRows.length)
            denied("RUNTIME_OPEN", "Machine runtime of " + opName(op) + " is running since " + when(openRows[0].fromDate))
        const from = p.fromDate || now
        if (lib.ms(from) > lib.ms(now) + 60000) denied("INTERVAL_INVALID", "The machine starts now or earlier")
        id = create(from, null)
        return posting.complete(
            begun.op,
            run.ownerPartyId,
            RUNTIME,
            id,
            Object.assign(answer, {resultCode: "STARTED", machineRuntimeEventId: id})
        )
    }
    if (action === "stop") {
        const row = !blank(p.machineRuntimeEventId)
            ? one(RUNTIME, {machineRuntimeEventId: p.machineRuntimeEventId})
            : openRows[0] || rows(RUNTIME, {operationWorkEffortId: op.workEffortId}).find(other => other.thruDate == null)
        if (!row || row.operationWorkEffortId !== op.workEffortId || row.thruDate != null)
            denied("RUNTIME_NOT_OPEN", "No machine runtime of " + opName(op) + " is running")
        const thru = p.thruDate || now
        interval(row.fromDate, thru)
        id = row.machineRuntimeEventId
        closed = closeRuntime(row, thru)
    } else {
        interval(p.fromDate, p.thruDate)
        id = create(p.fromDate, null)
        closed = closeRuntime(one(RUNTIME, {machineRuntimeEventId: id}), p.thruDate)
    }
    return posting.complete(
        begun.op,
        run.ownerPartyId,
        RUNTIME,
        id,
        Object.assign(answer, {
            resultCode: action === "stop" ? "STOPPED" : "RECORDED",
            machineRuntimeEventId: id,
            hours: text(closed.hours),
            valued: closed.valued,
            productionCostEventId: closed.productionCostEventId,
            message: closed.valued ? null : "No machine rate is in effect for the work center: the runtime is listed for review"
        })
    )
}
// The machine cost event of a closed runtime interval (record#ProductionCostEvent's MachineRuntimeEvent source), awaiting
// the cost close; unvalued with no rate in effect.
function machineEvent(machineRuntimeEventId) {
    const row = one(RUNTIME, {machineRuntimeEventId})
    if (!row || row.thruDate == null) denied("SOURCE_INVALID", "Machine runtime " + machineRuntimeEventId + " is not closed")
    const run = one(WORK, {workEffortId: row.workEffortId})
    if (!run || run.purposeEnumId !== "WepProductionRun") denied("SOURCE_INVALID", "Machine runtime is not a production run's")
    const valued = row.valuationStatusEnumId === "PcvValued"
    return {
        run,
        costEventTypeEnumId: "PcetMachine",
        costComponentEnumId: "PrcMachine",
        operationWorkEffortId: row.operationWorkEffortId,
        productId: null,
        quantity: dec(row.hours),
        quantityUomId: "TF_hr",
        rateAmount: valued ? dec(row.rateAmount) : null,
        rateEntityName: valued ? CENTER_RATE : null,
        rateId: valued ? row.workCenterRateId : null,
        amount: valued ? dec(row.amount) : null,
        amountUomId: row.amountUomId || null,
        valuationStatusEnumId: valued ? "PcvValued" : "PcvUnvalued",
        ledgerStatusEnumId: "PclAwaitingClose",
        acctgTransId: null,
        accountingDate: null,
        assetId: row.assetId || null,
        eventDate: row.fromDate
    }
}

// ===== the labor cost of production time (F33-F35) =====
// The person's position class: the entry's, else the class of their position in effect at its start.
function positionClassOf(entry) {
    if (entry.emplPositionClassId) return entry.emplPositionClassId
    if (!entry.partyId) return null
    const at = entry.fromDate || ec.user.nowTimestamp
    for (const row of rows("mantle.humanres.position.EmplPositionParty", {partyId: entry.partyId})) {
        if (!lib.active(row, at)) continue
        const position = one("mantle.humanres.position.EmplPosition", {emplPositionId: row.emplPositionId})
        if (position?.emplPositionClassId) return position.emplPositionClassId
    }
    return null
}
// The costing rate of an entry (design Y2): the one labor costing purpose's row in effect at its start for its work type and the
// person's position class (mantle.humanres.RateServices.get#CostingRate, People P10, whose rules are this lookup's of before:
// matching or naming neither, the most specific first, then the newest; never a rate of the person or a work effort).
function costingRate(entry) {
    const found = call("mantle.humanres.RateServices.get#CostingRate", {
        emplPositionClassId: positionClassOf(entry),
        workTypeEnumId: entry.workTypeEnumId || null,
        onDate: entry.fromDate || ec.user.nowTimestamp
    })
    return found.rateAmountId ? one(RATE, {rateAmountId: found.rateAmountId}) : null
}
const laborEventsOf = timeEntryId =>
    rows(EVENT, {sourceEntityName: TIME, sourceId: timeEntryId}).sort(
        (a, b) => Number(a.sourceRevision) - Number(b.sourceRevision)
    )
// What an entry's labor events recorded: their net hours, and the basis of the current recording (its first event since the
// net was last nothing), with the events since then.
function laborRecorded(events) {
    let net = zero(),
        basis = null,
        since = []
    for (const row of events) {
        if (net.compare(0) === 0 && dec(row.quantity).compare(0) > 0) {
            basis = row
            since = []
        }
        since.push(row)
        net = net.add(dec(row.quantity))
        if (net.compare(0) === 0) basis = null
    }
    return {net, basis, since: basis ? since : []}
}
// Whether a recording still fits its entry (F35): the same run and operation, and the rate it was valued at still the costing
// rate's match for the entry's work type, position class and date. A RateAmount whose amount was corrected still fits (the
// rate is frozen at the approval; P15's review re-records it); an unvalued recording stays for that review.
function laborFits(basis, entry, run) {
    if (!run || basis.workEffortId !== run.workEffortId) return false
    if ((basis.operationWorkEffortId || null) !== (entry.workEffortId !== run.workEffortId ? entry.workEffortId : null))
        return false
    if (!basis.rateId) return true
    const row = one(RATE, {rateAmountId: basis.rateId})
    return (
        !!row &&
        lib.active(row, entry.fromDate || ec.user.nowTimestamp) &&
        (!row.workTypeEnumId || row.workTypeEnumId === entry.workTypeEnumId) &&
        (!row.emplPositionClassId || row.emplPositionClassId === positionClassOf(entry))
    )
}
// The labor event an entry needs now (record#ProductionCostEvent's TimeEntry source), or null when its events already match:
// what should be recorded (its hours while its timesheet is approved, it is on a production run and it is not being deleted,
// else nothing) less what its events recorded. A first approval values it at the costing rate (unvalued without one); a
// reopen or deletion reverses what was recorded; an hours change of an approved entry is a delta at the rate it was valued
// at; a change of what values it (its work type, position class or date choosing another costing rate, or its work effort
// moving it to another operation or run; F35) reverses the recording, and the next event records it afresh.
function laborEvent(timeEntryId, removed = false) {
    const entry = one(TIME, {timeEntryId})
    if (!entry) denied("SOURCE_INVALID", "Time entry " + timeEntryId + " is not available")
    const run = runOfWork(entry.workEffortId)
    const events = laborEventsOf(timeEntryId)
    const recorded = laborRecorded(events)
    if (!run && recorded.net.compare(0) === 0)
        denied("SOURCE_INVALID", "Time entry " + timeEntryId + " is not on a production run")
    const sheet = entry.timesheetId ? one(TIMESHEET, {timesheetId: entry.timesheetId}) : null
    const should = run && !removed && sheet?.statusId === "TmshApproved" ? dec(entry.hours) : zero()
    const basis = recorded.basis
    const fits = !basis || laborFits(basis, entry, run)
    const delta = fits ? should.subtract(recorded.net) : recorded.net.negate()
    if (delta.compare(0) === 0) return null
    const valuedSince = recorded.since.length > 0 && recorded.since.every(row => row.amount != null)
    const reversal = should.compare(0) === 0 || !fits
    let rate = null,
        amount = null,
        currency = null,
        rateId = null
    if (!basis) {
        const row = costingRate(entry)
        if (row) {
            rate = dec(row.rateAmount)
            currency = row.rateCurrencyUomId || null
            rateId = row.rateAmountId
            amount = lib.money(delta.multiply(rate), currency)
        }
    } else {
        rate = basis.rateAmount == null ? null : dec(basis.rateAmount)
        currency = basis.amountUomId || null
        rateId = basis.rateId || null
        if (valuedSince && rate != null)
            amount = reversal
                ? zero().subtract(recorded.since.reduce((sum, row) => sum.add(dec(row.amount)), zero()))
                : lib.money(delta.multiply(rate), currency)
    }
    // a reversal is the recording's own run and operation; a new recording or delta the entry's
    const eventRun = basis && !fits ? one(WORK, {workEffortId: basis.workEffortId}) : run
    return {
        run: eventRun,
        costEventTypeEnumId: "PcetLabor",
        costComponentEnumId: "PrcLabor",
        operationWorkEffortId:
            basis && !fits
                ? basis.operationWorkEffortId || null
                : entry.workEffortId !== run.workEffortId
                  ? entry.workEffortId
                  : null,
        productId: null,
        timeEntryId: entry.timeEntryId,
        quantity: delta,
        quantityUomId: "TF_hr",
        rateAmount: rate,
        rateEntityName: rate == null ? null : RATE,
        rateId,
        amount,
        amountUomId: currency,
        valuationStatusEnumId: amount == null ? "PcvUnvalued" : "PcvValued",
        ledgerStatusEnumId: "PclAwaitingClose",
        acctgTransId: null,
        accountingDate: null,
        originalCostEventId: basis?.productionCostEventId || null,
        eventDate: entry.fromDate || ec.user.nowTimestamp,
        comments: removed
            ? "Time entry deleted"
            : !fits
              ? "Time entry changed; recorded again"
              : should.compare(0) === 0
                ? "Timesheet reopened"
                : null
    }
}
// sync#ProductionLaborCost: the entries of a timesheet or a list, each on its own: an entry not on a production run, or of a
// run whose owner's policy leaves laborCostSync off, is passed over unless it has labor recorded to bring to it; one that
// fails is logged and named, the others go on. A recording that no longer fits is reversed and then recorded afresh.
function syncLabor(p) {
    const ids = !blank(p.timesheetId)
        ? Array.from(find(TIME, {timesheetId: p.timesheetId}).selectField("timeEntryId").list()).map(row => row.timeEntryId)
        : Array.from(p.timeEntryIdList || []).map(String)
    const removed = yes(p.deleting)
    const productionCostEventIds = [],
        failedTimeEntryIds = []
    for (const timeEntryId of ids) {
        let event
        try {
            const entry = one(TIME, {timeEntryId})
            const run = entry ? runOfWork(entry.workEffortId) : null
            const on = !!run && productionPolicy().runPolicy(run).laborCostSync === "Y"
            if (!entry || (!on && laborRecorded(laborEventsOf(timeEntryId)).net.compare(0) === 0)) continue
            event = laborEvent(timeEntryId, removed)
        } catch (error) {
            ec.logger.error("Production labor cost of time entry " + timeEntryId + " was not recorded: " + error.message)
            failedTimeEntryIds.push(timeEntryId)
            continue
        }
        // at most a reversal of a recording that no longer fits and its new recording, in the caller's transaction (F-P10-7)
        for (let step = 0; event && step < 2; step++) {
            const revision =
                laborEventsOf(timeEntryId).reduce((max, row) => Math.max(max, Number(row.sourceRevision || 0)), 0) + 1
            const out = call("mantle.work.ProductionServices.record#ProductionCostEvent", {
                sourceEntityName: TIME,
                sourceId: timeEntryId,
                sourceRevision: revision,
                sourceRemoved: removed
            })
            if (!out.productionCostEventId) break
            productionCostEventIds.push(out.productionCostEventId)
        }
    }
    return {productionCostEventIds, failedTimeEntryIds}
}

// ===== get#ProductionTime =====
function readTime(p) {
    requireAny(["PRODUCTION_VIEW", "PRODUCTION_OPERATE", "PRODUCTION_SUPERVISE"])
    const userScope = posting.scope()
    let run,
        operation = null
    if (!blank(p.operationWorkEffortId)) {
        const found = operationOf(userScope, p.operationWorkEffortId)
        run = found.run
        operation = found.op
    } else run = production().runOf(userScope, p.workEffortId)
    const operations = operationsOfRun(run.workEffortId)
    const workIds = operation ? [operation.workEffortId] : [run.workEffortId].concat(operations.map(op => op.workEffortId))
    const entries = Array.from(find(TIME).condition("workEffortId", "in", workIds).orderBy("-fromDate").limit(500).list())
    const names = new Map(operations.map(op => [op.workEffortId, opName(op)]).concat([[run.workEffortId, "Work order"]]))
    const people = new Map()
    const personName = id => {
        if (!id) return ""
        if (!people.has(id)) {
            const person = one("mantle.party.Person", {partyId: id})
            people.set(id, person ? [person.firstName, person.lastName].filter(Boolean).join(" ") || id : id)
        }
        return people.get(id)
    }
    const sheets = new Map()
    const me = myParty()
    const showCost = financial()
    const timeRows = entries.map(entry => {
        if (entry.timesheetId && !sheets.has(entry.timesheetId))
            sheets.set(entry.timesheetId, one(TIMESHEET, {timesheetId: entry.timesheetId}))
        const sheet = entry.timesheetId ? sheets.get(entry.timesheetId) : null
        const events = laborEventsOf(entry.timeEntryId)
        const net = events.reduce((sum, row) => sum.add(dec(row.quantity)), zero())
        return Object.assign(
            {
                timeEntryId: entry.timeEntryId,
                partyId: entry.partyId,
                personName: personName(entry.partyId),
                operationName: names.get(entry.workEffortId) || entry.workEffortId,
                workTypeText: enumText(entry.workTypeEnumId),
                fromText: when(entry.fromDate),
                thruText: entry.thruDate ? when(entry.thruDate) : "Running",
                hours: text(entry.hours),
                pieceCount: text(entry.pieceCount),
                timesheetId: entry.timesheetId || null,
                timesheetText: sheet ? statusText(sheet.statusId) : "",
                mine: !!me && entry.partyId === me,
                running: entry.thruDate == null && entry.fromDate != null,
                laborRecorded: net.compare(0) > 0,
                laborText: net.compare(0) > 0 ? "Labor cost recorded" : events.length ? "Reversed" : ""
            },
            showCost && net.compare(0) > 0
                ? {
                      laborAmount: text(events.reduce((sum, row) => sum.add(dec(row.amount)), zero())),
                      amountUomId: events[0].amountUomId
                  }
                : {}
        )
    })
    // each week of the run's time with its status and what the user may do with it (TimesheetServices' access)
    const timesheetRows = Array.from(sheets.values())
        .filter(Boolean)
        .map(sheet => {
            const sheetAccess = call("mantle.work.TimesheetServices.get#TimesheetAccess", {timesheetId: sheet.timesheetId})
            return {
                timesheetId: sheet.timesheetId,
                personName: personName(sheet.partyId),
                weekText: [lib.calendarDateText(sheet.fromDate), lib.calendarDateText(sheet.thruDate)]
                    .filter(Boolean)
                    .join(" to "),
                statusId: sheet.statusId,
                statusText: statusText(sheet.statusId),
                canApprove: !!sheetAccess.canApprove,
                canReopen: !!sheetAccess.canReopen,
                canSubmit: !!sheetAccess.canSubmit
            }
        })
    const hours = entries.reduce((sum, entry) => sum.add(dec(entry.hours)), zero())
    return {
        workEffortId: run.workEffortId,
        runName: run.workEffortName || run.workEffortId,
        operationWorkEffortId: operation?.workEffortId || null,
        timeRows,
        timesheetRows,
        totalHours: text(hours),
        timer: timerRow(timerOf(), operation)
    }
}

const operationsTable = {
    queue,
    read: readOperation,
    instructions: readInstructions,
    recordStep,
    override: overrideStart,
    start,
    pause,
    complete: completeOperation,
    machineRuntime,
    syncLabor,
    time: readTime
}
;({
    machineEvent,
    laborEvent,
    execute: (op, parameters) => {
        if (!operationsTable[op]) throw new Error("Unknown shop floor operation " + op)
        return operationsTable[op](parameters)
    }
})
