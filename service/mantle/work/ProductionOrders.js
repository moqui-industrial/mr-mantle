// The lifecycle of Manufacturing's production runs (design-manufacturing WorkOrders, WorkOrderDetail, Overview and Operations;
// §12 M1, M2 and M4; impl-manufacturing P5a): what mantle.work.ProductionServices' run entry points add to Production.js's
// create and release (Warehouse P16a) and StockPosting.js's operation steps.
// - find#ProductionOrders: the runs of the user's organizations, paged, with their display text and the saved finds' filters
//   (Ready, Late, Blocked, Mine, By product).
// - transition#ProductionOrder: the one path to a run's status. Each action checks its design state and its permission
//   (PRODUCTION_PLAN to release and unrelease, PRODUCTION_SUPERVISE to start, hold, resume, cancel and complete,
//   PRODUCTION_COST_POST to close once Accounting's cost close is posted, impl-manufacturing P15), refuses the
//   generic transitions (In Planning to Complete, a close outside Accounting's cost close), and takes an operation key and
//   the expected revision. Release goes through release#ProductionOrder after the release gate: the method valid as of the
//   run's method date, the product usable, a later release of its methods found with a re-explosion offered, and the
//   shortage policy of the ProductionPolicy in effect at the release time (impl-manufacturing F-P4-4): all components
//   usable, or a staged release a supervisor approves (PsrAllUsable), or a staged release (PsrStaged); a staged release
//   leaves its short lines blocked for issue until the stock covers them. Unrelease and cancel need a run with no stock or
//   time fact. Complete needs the quantity reconciliation (ProductionQuantities.js, impl-manufacturing P7) and close is the
//   cost close's.
// - batch#ProductionAction: an action on several runs, a result per run.
// - get#ProductionLifecycle: a run's actions with what each would do or why it is refused (the Lifecycle dialog's impact
//   preview), its shortages and its status history.
// - store#ProductionOrder (the draft header), store#ProductionEquipment and store#ProductionParty (the guarded assignment
//   over add#/remove#WorkEffortParty), each with an operation key and the expected revision.
// - get#ProductionOperations: the run's operations with their readiness and its reason; get#ProductionPickList: the stock to
//   pick for each material line.
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const posting = ec.resource.script("component://mr-mantle/service/mantle/shipment/StockPosting.js")
const facilityScope = ec.resource.script("component://mr-mantle/service/mantle/facility/FacilityScope.js")
const {find, one, rows, call, denied, access} = lib

const WORK = "mantle.work.effort.WorkEffort",
    LINE = "mantle.work.production.ProductionRunLine",
    ISSUANCE = "mantle.product.issuance.AssetIssuance",
    RECEIPT = "mantle.product.receipt.AssetReceipt",
    TIME = "mantle.work.time.TimeEntry",
    PARTY = "mantle.work.effort.WorkEffortParty",
    ASSIGN = "mantle.work.effort.WorkEffortAssetAssign",
    ASSOC = "mantle.work.effort.WorkEffortAssoc",
    ASSET = "mantle.product.asset.Asset",
    PRODUCT = "mantle.product.Product",
    FACILITY = "mantle.facility.Facility",
    STATUS = "moqui.basic.StatusItem",
    AUDIT = "moqui.entity.EntityAuditLog"
const openStatuses = ["WeInPlanning", "WeApproved", "WeInProgress", "WeOnHold"]
const stockTypes = ["AstTpInventory", "AstTpSupplies"]
const blockedEquipment = ["AstDeactivated", "AstOnHold", "AstDelivered"]
const partyRoles = {Manager: "Supervisor", Assignee: "Operator"}
// the reasons a release or another action waits for something, not a failure (batch#ProductionAction's outcome)
const blockedReasons = [
    "SHORTAGE",
    "METHOD_CHANGED",
    "RUN_HAS_FACTS",
    "RUN_STARTED",
    "QUANTITIES_UNRECONCILED",
    "OUTPUT_HELD",
    "LOSS_PENDING",
    "MATERIAL_UNISSUED",
    "OPERATION_OPEN"
]
const zero = () => toDecimal(0)
const dec = value => toDecimal(value ?? 0)
const blank = value => value == null || String(value).trim() === ""
const str = value => (blank(value) ? null : String(value))
const text = value => (value == null ? null : dec(value).compare(0) === 0 ? "0" : String(dec(value).toNumber()))
const when = value => lib.dateText(value)
const yes = value => value === true || value === "true" || value === "Y"
const production = () => ec.resource.script("component://mr-mantle/service/mantle/work/Production.js")
const productionPolicy = () => ec.resource.script("component://mr-mantle/service/mantle/work/ProductionPolicy.js")
const payables = () => ec.resource.script("component://mr-mantle/service/mantle/account/Payables.js")
const quantities = () => ec.resource.script("component://mr-mantle/service/mantle/work/ProductionQuantities.js")
// impl-manufacturing P8: the run's quality gates
const productionQuality = () => ec.resource.script("component://mr-mantle/service/mantle/work/ProductionQuality.js")
const statusText = statusId => (statusId ? one(STATUS, {statusId})?.description || statusId : "")
const facilityName = facility => (facility ? facility.facilityName || facility.facilityId : "")

function requireAny(permissions) {
    if (!permissions.some(access.has)) denied("PERMISSION_DENIED", permissions.join(" or ") + " is required")
}
function revisionOf(run) {
    return Number(run.productionRevision || 0)
}
function requireRevision(run, expectedRevision) {
    if (blank(expectedRevision)) denied("REVISION_REQUIRED", "Review work order " + run.workEffortId + " and give its revision")
    if (Number(expectedRevision) !== revisionOf(run))
        denied("REVISION_CHANGED", "Work order " + run.workEffortId + " changed; reload and review it")
}
const outputOf = lines => lines.find(line => line.lineRoleEnumId === "PrlrOutput") || null
const operationsOfRun = workEffortId =>
    rows(WORK, {parentWorkEffortId: workEffortId})
        .filter(op => op.statusId !== "WeCancelled")
        .sort((a, b) => Number(a.sequenceNum || 0) - Number(b.sequenceNum || 0))

// ===== the stock a run nets against =====
// The run's facility and, for a line, its plant above it (a run on a line nets against its warehouse, F16).
function stockFacilityIds(run) {
    const facility = run.facilityId ? one(FACILITY, {facilityId: run.facilityId}) : null
    if (!facility) return []
    const ids = [facility.facilityId]
    if (facility.parentFacilityId && facility.facilityTypeEnumId === "FcTpLine") {
        const parent = one(FACILITY, {facilityId: facility.parentFacilityId})
        if (parent && parent.ownerPartyId === run.ownerPartyId) ids.push(parent.facilityId)
    }
    return ids
}
// The run owner's stock of a product free to promise at those facilities.
function available(productId, facilityIds, ownerPartyId) {
    let total = zero()
    for (const facilityId of facilityIds) {
        const out = call("mantle.product.AssetServices.get#AvailableInventory", {
            productId,
            facilityId,
            ownerPartyIdList: [ownerPartyId]
        })
        total = total.add(dec(out.availableToPromiseTotal))
    }
    return total
}
// The material lines the stock does not cover: what each has left against what is free, the product's stock shared in line
// order across its lines.
function shortagesOf(run, lines) {
    const facilityIds = stockFacilityIds(run)
    const left = new Map()
    const out = []
    const names = new Map()
    for (const line of lines.filter(row => row.lineRoleEnumId === "PrlrMaterial")) {
        const need = production().materialTotals(line).remaining
        if (need.compare(0) <= 0) continue
        if (!left.has(line.productId)) left.set(line.productId, available(line.productId, facilityIds, run.ownerPartyId))
        const free = left.get(line.productId)
        const covered = free.compare(need) >= 0 ? need : free.compare(0) > 0 ? free : zero()
        left.set(line.productId, free.subtract(covered))
        if (covered.compare(need) < 0) {
            if (!names.has(line.productId))
                names.set(line.productId, one(PRODUCT, {productId: line.productId})?.productName || line.productId)
            out.push({
                productionRunLineId: line.productionRunLineId,
                productId: line.productId,
                productName: names.get(line.productId),
                required: text(need),
                available: text(covered),
                short: text(need.subtract(covered)),
                stockUomId: line.stockUomId || null
            })
        }
    }
    return out
}
const shortText = shortages => shortages.map(row => row.productName + " short " + row.short + " of " + row.required).join("; ")
// issue#ProductionMaterial's check of a line a staged release left short (Production.js issuePlan): refused until the stock
// covers what the line has left; then the line is no longer held and the issue goes on.
function stagedBlock(run, line) {
    if (dec(line.stagedShortQuantity).compare(0) <= 0) return
    const need = production().materialTotals(line).remaining
    const free = available(line.productId, stockFacilityIds(run), run.ownerPartyId)
    if (free.compare(need) < 0)
        denied(
            "LINE_STAGED_SHORT",
            "Line " +
                line.productionRunLineId +
                " was released short under a staged release: " +
                text(free) +
                " of the " +
                text(need) +
                " it needs is free, so it is not issued yet"
        )
    call("update#" + LINE, {productionRunLineId: line.productionRunLineId, stagedShortQuantity: 0})
}

// ===== facts =====
// What makes a run more than a plan: its stock movements and the time on it or its operations (quantity and cost events
// come with impl-manufacturing P6 and P7).
function factsOf(run) {
    const workEffortIds = [run.workEffortId, ...rows(WORK, {parentWorkEffortId: run.workEffortId}).map(op => op.workEffortId)]
    const issuances = find(ISSUANCE, {workEffortId: run.workEffortId}).count()
    const receipts = find(RECEIPT, {workEffortId: run.workEffortId}).count()
    const timeEntries = find(TIME).condition("workEffortId", "in", workEffortIds).count()
    // impl-manufacturing P7: the quantity events and losses recorded on it
    const quantityEvents = find("mantle.work.production.ProductionQuantityEvent", {workEffortId: run.workEffortId}).count()
    const losses = find("mantle.work.production.ProductionLoss", {workEffortId: run.workEffortId}).count()
    // impl-manufacturing P8: the inspections of its gates
    const inspections = find("mantle.product.quality.QualityInspection", {workEffortId: run.workEffortId})
        .condition("statusId", "not-equals", "QiCancelled")
        .count()
    const parts = []
    if (issuances) parts.push(issuances + (issuances === 1 ? " issue" : " issues"))
    if (receipts) parts.push(receipts + (receipts === 1 ? " receipt" : " receipts"))
    if (timeEntries) parts.push(timeEntries + (timeEntries === 1 ? " time entry" : " time entries"))
    if (quantityEvents) parts.push(quantityEvents + (quantityEvents === 1 ? " quantity event" : " quantity events"))
    if (losses) parts.push(losses + (losses === 1 ? " loss" : " losses"))
    if (inspections) parts.push(inspections + (inspections === 1 ? " inspection" : " inspections"))
    return {issuances, receipts, timeEntries, quantityEvents, losses, inspections, any: parts.length > 0, text: parts.join(", ")}
}

// ===== the actions =====
// Each action: its permission, the statuses it starts from, whether it needs a reason, and its label.
const actions = {
    release: {permission: "PRODUCTION_PLAN", from: ["WeInPlanning"], label: "Release"},
    unrelease: {permission: "PRODUCTION_PLAN", from: ["WeApproved"], label: "Unrelease"},
    start: {permission: "PRODUCTION_SUPERVISE", from: ["WeApproved"], label: "Start"},
    hold: {permission: "PRODUCTION_SUPERVISE", from: ["WeApproved", "WeInProgress"], label: "Hold", reason: true},
    resume: {permission: "PRODUCTION_SUPERVISE", from: ["WeOnHold"], label: "Resume"},
    cancel: {permission: "PRODUCTION_SUPERVISE", from: ["WeInPlanning", "WeApproved", "WeOnHold"], label: "Cancel", reason: true},
    complete: {permission: "PRODUCTION_SUPERVISE", from: ["WeInProgress"], label: "Complete"},
    requestStaged: {permission: "PRODUCTION_PLAN", from: ["WeInPlanning"], label: "Request staged release"},
    approveStaged: {permission: "PRODUCTION_SUPERVISE", from: ["WeInPlanning"], label: "Approve staged release"},
    // impl-manufacturing P15: Accounting's post#CostClose closes a completed run once its cost close is posted, in the same
    // transaction; it is not a Lifecycle action
    close: {permission: "PRODUCTION_COST_POST", from: ["WeComplete"], label: "Close", costClose: true}
}
// A hold before start resumes as released, one after start as running (F9).
const resumeStatus = run => (run.actualStartDate ? "WeInProgress" : "WeApproved")
// The action a move to another status is (the board): the generic In Planning to Complete, and a close, are refused.
function actionFor(run, toStatusId) {
    const from = run.statusId
    if (toStatusId === from) denied("NO_CHANGE", "Work order " + run.workEffortId + " is already " + statusText(from))
    if (toStatusId === "WeClosed")
        denied("CLOSE_BY_COST_CLOSE", "A work order is closed by Accounting's cost close, after it is complete")
    if (from === "WeInPlanning" && toStatusId === "WeApproved") return "release"
    if (from === "WeApproved" && toStatusId === "WeInPlanning") return "unrelease"
    if (from === "WeApproved" && toStatusId === "WeInProgress") return "start"
    if (toStatusId === "WeOnHold") return "hold"
    if (from === "WeOnHold" && toStatusId === resumeStatus(run)) return "resume"
    if (toStatusId === "WeCancelled") return "cancel"
    if (toStatusId === "WeComplete" && from !== "WeInPlanning") return "complete"
    denied(
        "TRANSITION_INVALID",
        "Work order " + run.workEffortId + " cannot go from " + statusText(from) + " to " + statusText(toStatusId)
    )
}
// The staged release a supervisor approved holds while the run is at the revision it was given at.
const stagedApproved = run => run.productionStagedRevision != null && Number(run.productionStagedRevision) === revisionOf(run)

// The release gate (design WorkOrderDetail Actions): the product usable, the method valid as of the run's method date, no
// later release of its methods (else a re-explosion is offered), and the shortage policy in effect now. Answers the check as
// a finding, not a refusal, so the Lifecycle dialog can preview it.
function releaseGate(run, lines, p) {
    const output = outputOf(lines)
    if (!output) return {allowed: false, reasonCode: "LINES_REQUIRED", message: "The work order has no lines"}
    const usable = call("mantle.product.ProductServices.check#ProductUsable", {
        productId: output.productId,
        usage: "Produce",
        quantity: dec(output.quantity),
        facilityId: run.facilityId
    })
    if (!usable.usable)
        return {
            allowed: false,
            reasonCode: "PRODUCT_NOT_USABLE",
            message: "Product " + output.productId + " cannot be produced: " + (usable.reason || usable.statusId)
        }
    if (run.productBomId) {
        let findings = []
        try {
            const explosion = call("mantle.product.BomServices.get#BomExplosion", {
                productBomId: run.productBomId,
                asOfDate: run.productionMethodDate || ec.user.nowTimestamp,
                quantity: dec(output.quantity),
                quantityUomId: output.quantityUomId || null
            })
            findings = Array.from(explosion.findings || []).map(row => (row.recordId || "") + ": " + row.message)
        } catch (error) {
            findings = [String(error.message || error).replace(/^(Error: )+/, "")]
        }
        if (findings.length)
            return {allowed: false, reasonCode: "METHOD_INVALID", message: "The method is not valid: " + findings.join("; ")}
    }
    const later = production().laterReleases(run, lines, ec.user.nowTimestamp)
    if (later.length) {
        const dates = later.map(row => when(row.fromDate)).join(", ")
        if (!yes(p.reexplode))
            return {
                allowed: false,
                reasonCode: "METHOD_CHANGED",
                reexplodeOffered: true,
                message:
                    "The method was released again on " +
                    dates +
                    ", after the work order's method date " +
                    when(run.productionMethodDate) +
                    "; re-explode it as of now to release it",
                laterReleases: later
            }
        return {
            allowed: true,
            reexplode: true,
            impact: [
                "Rewrites the lines from the method as of now (released " + dates + "); the work order stays a draft to review"
            ]
        }
    }
    // the quality gates the release keeps: an operation naming a template that is not published blocks it (P8)
    const quality = productionQuality().releaseCheck(run, lines)
    if (quality && !quality.allowed) return quality
    const shortages = shortagesOf(run, lines)
    const policy = productionPolicy().effective(run.ownerPartyId, run.facilityId, ec.user.nowTimestamp).policy
    const staged = policy.shortageReleaseEnumId === "PsrStaged"
    if (shortages.length && !staged && !stagedApproved(run))
        return {
            allowed: false,
            reasonCode: "SHORTAGE",
            stagedApprovalRequired: true,
            shortages,
            message:
                "Components are short: " +
                shortText(shortages) +
                ". A supervisor may approve a staged release, which leaves the short lines blocked until stock covers them"
        }
    const routed = !!run.productionRoutingId || lines.some(line => line.routingOperationWorkEffortId)
    return {
        allowed: true,
        shortages,
        impact: [
            "Freezes the lines and stamps the release time; the run keeps the production policy in effect now",
            routed ? "Creates the operations from the routing" : "No routing: the run keeps its quantities and time itself",
            ...(quality?.impact || []),
            ...(shortages.length ? ["Releases staged: " + shortText(shortages) + " stay blocked for issue until covered"] : [])
        ]
    }
}

// What an action would do to the run, or why it is refused: {allowed, reasonCode, message, impact, ...}. Read only.
function check(run, action, p, lines = production().linesOf(run.workEffortId)) {
    const definition = actions[action]
    if (!definition) return {allowed: false, reasonCode: "ACTION_INVALID", message: "Unknown action " + action}
    const label = definition.label
    if (!access.has(definition.permission))
        return {allowed: false, reasonCode: "PERMISSION_DENIED", message: definition.permission + " is required to " + label}
    if (!definition.from.includes(run.statusId))
        return {
            allowed: false,
            reasonCode: action === "release" ? "RUN_NOT_DRAFT" : "STATUS_INVALID",
            message: label + " is not possible while the work order is " + statusText(run.statusId)
        }
    if (definition.reason && blank(p.reason) && blank(p.reasonCode))
        return {allowed: false, reasonCode: "REASON_REQUIRED", message: "Give the reason to " + label.toLowerCase()}
    // the quantity reconciliation, settled operations and material disposition (impl-manufacturing P7)
    if (action === "complete") return quantities().completeCheck(run, p, lines)
    if (action === "close")
        return run.productionCostClosedDate
            ? {allowed: true, impact: ["Closes the work order; its cost close is posted"]}
            : {
                  allowed: false,
                  reasonCode: "COST_CLOSE_NOT_POSTED",
                  message: "Work order " + run.workEffortId + " is closed by Accounting's cost close, which is not posted"
              }
    if (action === "release") return releaseGate(run, lines, p)
    if (action === "requestStaged" || action === "approveStaged") {
        const shortages = shortagesOf(run, lines)
        if (!shortages.length)
            return {allowed: false, reasonCode: "NO_SHORTAGE", message: "Every component is covered; release it as it is"}
        if (action === "approveStaged" && stagedApproved(run))
            return {allowed: false, reasonCode: "ALREADY_APPROVED", message: "A staged release is approved already"}
        return {
            allowed: true,
            shortages,
            impact: [
                action === "requestStaged"
                    ? "Asks the supervisors to approve a release with " + shortText(shortages)
                    : "Lets the planner release with " + shortText(shortages) + ", those lines blocked until covered"
            ]
        }
    }
    if (action === "unrelease" || action === "cancel") {
        // a run held after its start is not cancelled here: it waits for the reviewed reversal (impl-manufacturing P9)
        if (action === "cancel" && run.actualStartDate)
            return {
                allowed: false,
                reasonCode: "RUN_STARTED",
                message: "Work order " + run.workEffortId + " has started; it is closed out by a reviewed reversal"
            }
        const facts = factsOf(run)
        if (facts.any)
            return {
                allowed: false,
                reasonCode: "RUN_HAS_FACTS",
                message:
                    "Work order " +
                    run.workEffortId +
                    " has " +
                    facts.text +
                    "; " +
                    (action === "cancel" ? "it is closed out by a reviewed reversal" : "it stays released")
            }
        const started = operationsOfRun(run.workEffortId).filter(op => op.statusId !== "WeApproved")
        if (started.length)
            return {
                allowed: false,
                reasonCode: "OPERATION_STARTED",
                message: "Operation " + (started[0].workEffortName || started[0].workEffortId) + " has started"
            }
        const operations = operationsOfRun(run.workEffortId).length
        return {
            allowed: true,
            impact:
                action === "unrelease"
                    ? [
                          "Back to a draft: the lines are unfrozen" +
                              (operations ? " and the " + operations + " operations cancelled" : ""),
                          "A later release reads the method and the production policy again"
                      ]
                    : [
                          "Cancels the work order" +
                              (operations ? " and its " + operations + " operations" : "") +
                              "; nothing is posted"
                      ]
        }
    }
    // a failed quality gate holds the run until its inspection is disposed or inspected again (P8)
    if (action === "start" || action === "resume") {
        const blocked = productionQuality().startGate(run)
        if (blocked) return blocked
    }
    if (action === "start") return {allowed: true, impact: ["The work order is running; its operations may start"]}
    if (action === "hold")
        return {allowed: true, impact: ["Pauses the work order with the reason; person timers are not stopped"]}
    if (action === "resume")
        return {
            allowed: true,
            impact: [run.actualStartDate ? "Resumes it as running" : "Resumes it as released; it has not started"]
        }
    return {allowed: true, impact: []}
}

// ===== transition#ProductionOrder =====
function setStatus(run, statusId, reason, fields = {}) {
    const changeReason = reason || null
    if (changeReason) ec.context.putAll({statusId_changeReason: changeReason})
    call(
        "update#" + WORK,
        Object.assign({workEffortId: run.workEffortId, statusId, statusId_changeReason: changeReason}, fields, {
            productionRevision: revisionOf(run) + 1
        })
    )
}
function reasonOf(run, p) {
    const parts = []
    if (!blank(p.reasonCode)) {
        const reason = productionPolicy().activeReason(run.ownerPartyId, p.reasonCode)
        if (!reason) denied("REASON_INVALID", "Reason " + p.reasonCode + " is not an active production reason")
        parts.push(reason.reasonName || p.reasonCode)
    }
    if (!blank(p.reason)) parts.push(String(p.reason).trim())
    return parts.join(": ") || null
}
const cancelOperations = (run, why) => {
    for (const op of operationsOfRun(run.workEffortId))
        call("update#" + WORK, {workEffortId: op.workEffortId, statusId: "WeCancelled", statusId_changeReason: why})
}
function notifySupervisors(topic, run, message) {
    try {
        return payables().execute("notify", {
            topic,
            permission: "PRODUCTION_SUPERVISE",
            organizationPartyId: run.ownerPartyId,
            recordEntityName: WORK,
            recordId: run.workEffortId,
            message: Object.assign(
                {workEffortId: run.workEffortId, workEffortName: run.workEffortName || run.workEffortId},
                message
            )
        })
    } catch (error) {
        ec.logger.error("Work order " + run.workEffortId + " notice " + topic + " was not sent: " + error.message)
        return null
    }
}
function clearStagedRequests(run) {
    try {
        payables().execute("clearNotices", {topic: "ProductionStagedRelease", recordEntityName: WORK, recordId: run.workEffortId})
    } catch (error) {
        ec.logger.error("Work order " + run.workEffortId + " staged release requests were not cleared: " + error.message)
    }
}
function apply(run, action, p, key, gate) {
    const why = reasonOf(run, p)
    const lines = production().linesOf(run.workEffortId)
    const answer = {workEffortId: run.workEffortId, action, fromStatusId: run.statusId}
    if (action === "release") {
        const released = call("mantle.work.ProductionServices.release#ProductionOrder", {
            operationKey: key + "/release",
            workEffortId: run.workEffortId,
            expectedRevision: revisionOf(run),
            reexplode: !!gate.reexplode
        }).result
        if (released.resultCode === "REEXPLODED")
            return Object.assign(answer, {
                resultCode: "REEXPLODED",
                statusId: released.statusId,
                revision: released.revision,
                findings: released.findings || []
            })
        // the short lines of a staged release stay blocked for issue until the stock covers them
        for (const short of gate.shortages || [])
            call("update#" + LINE, {productionRunLineId: short.productionRunLineId, stagedShortQuantity: short.short})
        // the shortage notice to the planners (impl-manufacturing P5b)
        ec.resource.script("component://mr-mantle/service/mantle/work/ProductionMaterials.js").notifyShortage(run, gate.shortages)
        clearStagedRequests(run)
        notifySupervisors("ProductionRelease", run, {organizationPartyId: run.ownerPartyId, releasedByUserId: ec.user.userId})
        return Object.assign(answer, {
            resultCode: "RELEASED",
            statusId: "WeApproved",
            revision: released.revision,
            releaseDate: released.releaseDate,
            operationWorkEffortIds: released.operationWorkEffortIds || [],
            staged: (gate.shortages || []).length > 0,
            shortages: gate.shortages || []
        })
    }
    if (action === "unrelease") {
        cancelOperations(run, "Work order unreleased")
        for (const line of lines)
            call("update#" + LINE, {
                productionRunLineId: line.productionRunLineId,
                operationWorkEffortId: null,
                frozenDate: null,
                stagedShortQuantity: null
            })
        // the quality gates end with the release (P8)
        productionQuality().endGates(run)
        setStatus(run, "WeInPlanning", why || "Unreleased", {
            productionReleaseDate: null,
            productStandardCostId: null,
            productionStagedRevision: null,
            productionGatesDate: null
        })
    } else if (action === "start") setStatus(run, "WeInProgress", why, {actualStartDate: ec.user.nowTimestamp})
    else if (action === "hold") setStatus(run, "WeOnHold", why)
    else if (action === "resume") setStatus(run, resumeStatus(run), why)
    else if (action === "cancel") {
        cancelOperations(run, "Work order cancelled")
        setStatus(run, "WeCancelled", why, {actualCompletionDate: ec.user.nowTimestamp})
    } else if (action === "complete") quantities().complete(run, p, why)
    else if (action === "close") setStatus(run, "WeClosed", why || "Cost closed")
    else if (action === "approveStaged") {
        call("update#" + WORK, {
            workEffortId: run.workEffortId,
            productionRevision: revisionOf(run) + 1,
            productionStagedRevision: revisionOf(run) + 1,
            productionStagedByUserId: ec.user.userId,
            productionStagedDate: ec.user.nowTimestamp
        })
        clearStagedRequests(run)
        return Object.assign(answer, {resultCode: "APPROVED", statusId: run.statusId, revision: revisionOf(run) + 1})
    } else if (action === "requestStaged") {
        clearStagedRequests(run)
        const sent = notifySupervisors("ProductionStagedRelease", run, {
            organizationPartyId: run.ownerPartyId,
            shortText: shortText(gate.shortages || []),
            requestedByUserId: ec.user.userId,
            reason: why
        })
        return Object.assign(answer, {
            resultCode: "REQUESTED",
            statusId: run.statusId,
            revision: revisionOf(run),
            notified: !!sent
        })
    }
    const after = one(WORK, {workEffortId: run.workEffortId})
    return Object.assign(answer, {
        resultCode: {
            unrelease: "UNRELEASED",
            start: "STARTED",
            hold: "HELD",
            resume: "RESUMED",
            cancel: "CANCELLED",
            complete: "COMPLETED",
            close: "CLOSED"
        }[action],
        statusId: after.statusId,
        revision: revisionOf(after)
    })
}
// transition#ProductionOrder: the action (or the move to toStatusId) on the run, locked, at its expected revision.
function transition(p) {
    const begun = posting.begin(
        p,
        "ProductionTransition",
        ["PRODUCTION_PLAN", "PRODUCTION_SUPERVISE", "PRODUCTION_COST_POST"],
        [
            "workEffortId",
            "action",
            "toStatusId",
            "expectedRevision",
            "reason",
            "reasonCode",
            "reexplode",
            "finishRemainder",
            "acceptMaterialVariance"
        ]
    )
    if (begun.previous) return begun.previous
    const userScope = posting.scope()
    const run = production().runOf(userScope, p.workEffortId, true)
    const settled = posting.settled(begun.op)
    if (settled) return settled
    const action = str(p.action) || (blank(p.toStatusId) ? null : actionFor(run, p.toStatusId))
    if (!action) denied("ACTION_REQUIRED", "Choose what to do with work order " + run.workEffortId)
    // close is the cost close's (post#CostClose, PRODUCTION_COST_POST), never a production user's
    if (action === "close" && !access.has("PRODUCTION_COST_POST"))
        denied("CLOSE_BY_COST_CLOSE", "A work order is closed by Accounting's cost close, after it is complete")
    if (!actions[action]) denied("ACTION_INVALID", "Unknown work order action " + action)
    requireRevision(run, p.expectedRevision)
    const gate = check(run, action, p)
    if (!gate.allowed) denied(gate.reasonCode, gate.message)
    const answer = apply(run, action, p, begun.op.clientKey, gate)
    return posting.complete(begun.op, run.ownerPartyId, WORK, run.workEffortId, answer)
}
// batch#ProductionAction: each run through transition#ProductionOrder in its own transaction, at the revision given for it or
// its current one, as the operation "<batch key>/<run>": a result per run, success, blocked (waiting on stock, a method review
// or facts) or failed, and one failure does not stop the others.
function batch(p) {
    requireAny(["PRODUCTION_PLAN", "PRODUCTION_SUPERVISE"])
    const ids = Array.from(
        new Set(
            Array.from(p.workEffortIds || [])
                .map(String)
                .filter(id => id.trim())
        )
    )
    if (!ids.length) denied("RUNS_REQUIRED", "Choose the work orders")
    if (ids.length > 200) denied("RUNS_LIMIT", "Choose at most 200 work orders at a time")
    const revisions = p.expectedRevisions || {}
    const out = posting.batch(
        p,
        ids,
        id => id,
        "mantle.work.ProductionServices.transition#ProductionOrder",
        id => ({
            workEffortId: id,
            action: p.action,
            reason: p.reason || null,
            reasonCode: p.reasonCode || null,
            expectedRevision:
                revisions[id] != null
                    ? revisions[id]
                    : (() => {
                          const run = one(WORK, {workEffortId: id})
                          return run ? revisionOf(run) : 0
                      })()
        })
    )
    // the refusal's code: posting.reasonOf reads only codes with an underscore, and SHORTAGE has none
    const codeOf = row => (row.ok ? null : /(?:^|[\s:])([A-Z][A-Z0-9_]{2,}):/.exec(row.message || "")?.[1] || row.reasonCode)
    const results = out.results.map(row => {
        const reasonCode = codeOf(row)
        return Object.assign({workEffortId: row.key}, row, {
            reasonCode,
            outcome: row.ok ? "success" : blockedReasons.includes(reasonCode) ? "blocked" : "failed"
        })
    })
    return {
        results,
        successCount: results.filter(row => row.outcome === "success").length,
        blockedCount: results.filter(row => row.outcome === "blocked").length,
        failedCount: results.filter(row => row.outcome === "failed").length
    }
}

// ===== get#ProductionLifecycle =====
// The run's status changes with their reasons, newest first (WorkEffort.statusId is audit-logged).
function historyOf(run) {
    return Array.from(
        find(AUDIT, {changedEntityName: WORK, changedFieldName: "statusId", pkPrimaryValue: run.workEffortId})
            .orderBy("-changedDate")
            .limit(50)
            .list()
    ).map(row => ({
        changedDate: row.changedDate,
        changedDateText: when(row.changedDate),
        fromStatusText: statusText(row.oldValueText),
        toStatusText: statusText(row.newValueText),
        changeReason: row.changeReason || null,
        changedByUserId: row.changedByUserId || null
    }))
}
function lifecycle(p) {
    requireAny(["PRODUCTION_VIEW"])
    const userScope = posting.scope()
    const run = production().runOf(userScope, p.workEffortId)
    const lines = production().linesOf(run.workEffortId)
    const output = outputOf(lines)
    const product = output ? one(PRODUCT, {productId: output.productId}) : null
    const facility = run.facilityId ? one(FACILITY, {facilityId: run.facilityId}) : null
    const received = output
        ? rows(RECEIPT, {productionOutputLineId: output.productionRunLineId}).reduce(
              (sum, row) => sum.add(dec(row.quantityAccepted)),
              zero()
          )
        : zero()
    const remaining = output ? dec(output.stockQuantity).subtract(received) : zero()
    const actionRows = Object.keys(actions)
        .filter(action => actions[action].from.includes(run.statusId) && !actions[action].costClose)
        .map(action => {
            let result
            try {
                result = check(run, action, {reason: "preview", reexplode: false}, lines)
            } catch (error) {
                ec.logger.error("Work order " + run.workEffortId + " " + action + " preview failed: " + error.message)
                result = {allowed: false, reasonCode: lib.reasonCode(error) || "FAILED", message: error.message}
            }
            return Object.assign(
                {
                    action,
                    label: actions[action].label,
                    permitted: access.has(actions[action].permission),
                    reasonRequired: !!actions[action].reason,
                    impact: []
                },
                result
            )
        })
    const shortages = run.statusId === "WeInPlanning" ? shortagesOf(run, lines) : []
    const stagedLines = lines.filter(line => dec(line.stagedShortQuantity).compare(0) > 0)
    return {
        run: {
            workEffortId: run.workEffortId,
            workEffortName: run.workEffortName || null,
            description: run.description || null,
            priority: run.priority ?? null,
            statusId: run.statusId,
            statusText: statusText(run.statusId),
            revision: revisionOf(run),
            ownerPartyId: run.ownerPartyId,
            facilityId: run.facilityId || null,
            facilityName: facilityName(facility),
            productId: output?.productId || null,
            productName: product?.productName || output?.productId || null,
            quantity: output ? text(output.quantity) : null,
            quantityUomId: output?.quantityUomId || null,
            received: text(received),
            remaining: text(remaining.compare(0) > 0 ? remaining : zero()),
            productBomId: run.productBomId || null,
            routingWorkEffortId: run.productionRoutingId || null,
            methodDate: run.productionMethodDate || null,
            methodDateText: when(run.productionMethodDate),
            releaseDate: run.productionReleaseDate || null,
            releaseDateText: when(run.productionReleaseDate),
            estimatedStartDate: run.estimatedStartDate || null,
            estimatedStartText: when(run.estimatedStartDate),
            estimatedCompletionDate: run.estimatedCompletionDate || null,
            estimatedCompletionText: when(run.estimatedCompletionDate),
            actualStartText: when(run.actualStartDate),
            late:
                openStatuses.includes(run.statusId) &&
                run.estimatedCompletionDate != null &&
                lib.ms(run.estimatedCompletionDate) < lib.ms(ec.user.nowTimestamp),
            demandOrderId: run.demandOrderId || null,
            demandOrderItemSeqId: run.demandOrderItemSeqId || null,
            demandRequirementId: run.demandRequirementId || null,
            stagedApproved: stagedApproved(run),
            stagedApprovedText: stagedApproved(run) ? when(run.productionStagedDate) : null,
            stagedLineCount: stagedLines.length,
            lineCount: lines.length
        },
        actions: actionRows,
        shortages,
        facts: factsOf(run),
        history: historyOf(run)
    }
}

// ===== find#ProductionOrders =====
const likeText = value => "%" + String(value).replace(/[\\%_]/g, character => "\\" + character) + "%"
function idsWhere(entity, conditions, field = "workEffortId") {
    return Array.from(find(entity, conditions).selectField(field).distinct(true).list()).map(row => row[field])
}
// The runs a party works on: assigned on the run or on one of its operations.
function runIdsOfParty(partyId) {
    const now = ec.user.nowTimestamp
    const assigned = Array.from(
        find(PARTY, {partyId})
            .condition(
                ec.entity.conditionFactory.makeCondition(
                    [
                        ec.entity.conditionFactory.makeCondition("thruDate", "is-null", null),
                        ec.entity.conditionFactory.makeCondition("thruDate", "greater-than", now)
                    ],
                    "or"
                )
            )
            .selectField("workEffortId")
            .list()
    ).map(row => row.workEffortId)
    if (!assigned.length) return []
    const parents = Array.from(
        find(WORK)
            .condition("workEffortId", "in", assigned)
            .condition("parentWorkEffortId", "is-not-null", null)
            .selectField("parentWorkEffortId")
            .list()
    ).map(row => row.parentWorkEffortId)
    return Array.from(new Set([...assigned, ...parents]))
}
const statusColors = {
    WeInPlanning: "grey-8",
    WeApproved: "primary",
    WeInProgress: "positive",
    WeOnHold: "warning",
    WeComplete: "teal",
    WeClosed: "grey-7",
    WeCancelled: "negative"
}
function findOrders(p) {
    requireAny(["PRODUCTION_VIEW"])
    const userScope = posting.scope()
    const factory = ec.entity.conditionFactory
    const now = ec.user.nowTimestamp
    // the conditions, kept to make the count's find and the page's (a find is used once)
    const conditions = []
    let query = {
        condition(...args) {
            conditions.push(args)
            return query
        }
    }
    if (userScope.organizationPartyIds) query = query.condition("ownerPartyId", "in", userScope.organizationPartyIds)
    if (!blank(p.organizationPartyId)) query = query.condition("ownerPartyId", p.organizationPartyId)
    // the facilities of the user's organizations; a plant takes the lines under it
    if (!blank(p.facilityId)) {
        const facilityIds = [p.facilityId, ...idsWhere(FACILITY, {parentFacilityId: p.facilityId}, "facilityId")]
        query = query.condition("facilityId", "in", facilityIds)
    }
    const statuses =
        p.statusId === "all" ? null : !blank(p.statusId) ? String(p.statusId).split(",").filter(Boolean) : openStatuses
    if (statuses) query = query.condition("statusId", "in", statuses)
    if (!blank(p.text)) {
        const pattern = likeText(String(p.text).trim())
        query = query.condition(
            factory.makeCondition(
                [
                    factory.makeCondition("workEffortId", "like", pattern).ignoreCase(),
                    factory.makeCondition("workEffortName", "like", pattern).ignoreCase()
                ],
                "or"
            )
        )
    }
    const narrow = ids => {
        query = query.condition("workEffortId", "in", ids.length ? ids : ["_NONE_"])
    }
    if (!blank(p.productId)) narrow(idsWhere(LINE, {productId: p.productId, lineRoleEnumId: "PrlrOutput"}))
    if (!blank(p.demandOrderId)) query = query.condition("demandOrderId", p.demandOrderId)
    if (!blank(p.assigneePartyId)) narrow(runIdsOfParty(p.assigneePartyId))
    if (yes(p.mine)) narrow(ec.user.userAccount?.partyId ? runIdsOfParty(ec.user.userAccount.partyId) : [])
    if (yes(p.late))
        query = query.condition("statusId", "in", openStatuses).condition("estimatedCompletionDate", "less-than", now)
    const shortRunIds = () =>
        Array.from(
            find(LINE).condition("stagedShortQuantity", "greater-than", 0).selectField("workEffortId").distinct(true).list()
        ).map(row => row.workEffortId)
    if (yes(p.ready)) {
        query = query.condition("statusId", "WeApproved")
        const short = shortRunIds()
        if (short.length) query = query.condition("workEffortId", "not-in", short)
    }
    if (yes(p.blocked)) {
        const short = shortRunIds()
        query = query.condition(
            short.length
                ? factory.makeCondition(
                      [
                          factory.makeCondition("statusId", "equals", "WeOnHold"),
                          factory.makeCondition("workEffortId", "in", short)
                      ],
                      "or"
                  )
                : factory.makeCondition("statusId", "equals", "WeOnHold")
        )
    }
    if (!blank(p.dueFrom)) query = query.condition("estimatedCompletionDate", "greater-equals", p.dueFrom)
    if (!blank(p.dueThru)) query = query.condition("estimatedCompletionDate", "less-equals", p.dueThru)
    const orderBy = {
        due: "estimatedCompletionDate",
        "-due": "-estimatedCompletionDate",
        id: "workEffortId",
        "-id": "-workEffortId"
    }
    const build = () =>
        conditions
            .reduce((found, args) => found.condition(...args), find(WORK, {purposeEnumId: "WepProductionRun"}))
            .orderBy(orderBy[p.orderByField] || "estimatedCompletionDate")
            .orderBy("workEffortId")
    const count = build().count()
    const paged = lib.page(build(), p, "orderRows", count, {noLimitCap: 2000})
    const runs = paged.rows
    const runIds = runs.map(run => run.workEffortId)
    const outputs = runIds.length
        ? Array.from(find(LINE, {lineRoleEnumId: "PrlrOutput"}).condition("workEffortId", "in", runIds).list())
        : []
    const outputByRun = new Map(outputs.map(line => [line.workEffortId, line]))
    const productIds = Array.from(new Set(outputs.map(line => line.productId)))
    const products = new Map(
        (productIds.length ? Array.from(find(PRODUCT).condition("productId", "in", productIds).list()) : []).map(row => [
            row.productId,
            row
        ])
    )
    const facilityIds = Array.from(new Set(runs.map(run => run.facilityId).filter(Boolean)))
    const facilities = new Map(
        (facilityIds.length ? Array.from(find(FACILITY).condition("facilityId", "in", facilityIds).list()) : []).map(row => [
            row.facilityId,
            row
        ])
    )
    const outputLineIds = outputs.map(line => line.productionRunLineId)
    const receivedByLine = new Map()
    if (outputLineIds.length)
        for (const row of Array.from(find(RECEIPT).condition("productionOutputLineId", "in", outputLineIds).list()))
            receivedByLine.set(
                row.productionOutputLineId,
                (receivedByLine.get(row.productionOutputLineId) || zero()).add(dec(row.quantityAccepted))
            )
    const short = new Set(
        runIds.length
            ? Array.from(
                  find(LINE)
                      .condition("workEffortId", "in", runIds)
                      .condition("stagedShortQuantity", "greater-than", 0)
                      .selectField("workEffortId")
                      .list()
              ).map(row => row.workEffortId)
            : []
    )
    const statusNames = new Map()
    const nameOf = statusId => {
        if (!statusNames.has(statusId)) statusNames.set(statusId, statusText(statusId))
        return statusNames.get(statusId)
    }
    const orderRows = runs.map(run => {
        const output = outputByRun.get(run.workEffortId)
        const product = output ? products.get(output.productId) : null
        const received = output ? receivedByLine.get(output.productionRunLineId) || zero() : zero()
        const left = output ? dec(output.stockQuantity).subtract(received) : zero()
        const late =
            openStatuses.includes(run.statusId) &&
            run.estimatedCompletionDate != null &&
            lib.ms(run.estimatedCompletionDate) < lib.ms(now)
        const readiness =
            run.statusId === "WeOnHold"
                ? "On hold"
                : short.has(run.workEffortId)
                  ? "Short component"
                  : run.statusId === "WeApproved"
                    ? "Ready"
                    : run.statusId === "WeInPlanning"
                      ? "Draft"
                      : ""
        return {
            workEffortId: run.workEffortId,
            workEffortName: run.workEffortName || null,
            ownerPartyId: run.ownerPartyId,
            statusId: run.statusId,
            statusText: nameOf(run.statusId),
            statusColor: statusColors[run.statusId] || "grey-8",
            revision: revisionOf(run),
            facilityId: run.facilityId || null,
            facilityName: facilityName(facilities.get(run.facilityId)),
            productId: output?.productId || null,
            productName: product?.productName || output?.productId || null,
            productPseudoId: product?.pseudoId || output?.productId || null,
            quantity: output ? text(output.quantity) : null,
            quantityUomId: output?.quantityUomId || null,
            plannedText: output ? text(output.quantity) + " " + (output.quantityUomId || "") : "",
            good: text(received),
            remaining: text(left.compare(0) > 0 ? left : zero()),
            estimatedStartDate: run.estimatedStartDate || null,
            estimatedStartText: when(run.estimatedStartDate),
            estimatedCompletionDate: run.estimatedCompletionDate || null,
            dueText: when(run.estimatedCompletionDate),
            late,
            readiness,
            blocked: readiness === "On hold" || readiness === "Short component",
            calendarTitle: (run.workEffortName || run.workEffortId) + (product ? " · " + (product.productName || "") : "")
        }
    })
    return Object.assign({orderRows}, pagedFields(paged, "orderRows"))
}
const pagedFields = (paged, field) =>
    Object.fromEntries(
        ["Count", "PageIndex", "PageSize", "PageMaxIndex", "PageRangeLow", "PageRangeHigh"].map(key => [
            field + key,
            paged[field + key]
        ])
    )

// ===== store#ProductionOrder: the draft header =====
function storeOrder(p) {
    const begun = posting.begin(p, "ProductionStore", "PRODUCTION_PLAN", [
        "workEffortId",
        "expectedRevision",
        "workEffortName",
        "description",
        "priority",
        "estimatedStartDate",
        "estimatedCompletionDate",
        "facilityId"
    ])
    if (begun.previous) return begun.previous
    const userScope = posting.scope()
    const run = production().runOf(userScope, p.workEffortId, true)
    const settled = posting.settled(begun.op)
    if (settled) return settled
    if (run.statusId !== "WeInPlanning")
        denied("RUN_NOT_DRAFT", "Work order " + run.workEffortId + " is " + statusText(run.statusId) + "; only a draft is edited")
    requireRevision(run, p.expectedRevision)
    const fields = {workEffortId: run.workEffortId, productionRevision: revisionOf(run) + 1}
    for (const name of ["workEffortName", "description", "estimatedStartDate", "estimatedCompletionDate"])
        if (p[name] !== undefined) fields[name] = blank(p[name]) ? null : p[name]
    if (p.priority !== undefined) fields.priority = blank(p.priority) ? null : Number(p.priority)
    if (fields.workEffortName === null) denied("NAME_REQUIRED", "Give the work order a name")
    const start = fields.estimatedStartDate !== undefined ? fields.estimatedStartDate : run.estimatedStartDate
    const end = fields.estimatedCompletionDate !== undefined ? fields.estimatedCompletionDate : run.estimatedCompletionDate
    if (start != null && end != null && lib.ms(end) < lib.ms(start)) denied("DATES_INVALID", "The due date is before the start")
    if (!blank(p.facilityId) && p.facilityId !== run.facilityId) {
        const facility = posting.facility(userScope, p.facilityId)
        if (facility.ownerPartyId !== run.ownerPartyId)
            denied("FACILITY_OWNER", "Facility " + facility.facilityId + " is not " + run.ownerPartyId + "'s")
        fields.facilityId = facility.facilityId
    }
    call("update#" + WORK, fields)
    return posting.complete(begun.op, run.ownerPartyId, WORK, run.workEffortId, {
        resultCode: "STORED",
        workEffortId: run.workEffortId,
        revision: revisionOf(run) + 1
    })
}

// ===== store#ProductionEquipment =====
function openMaintenance(assetId) {
    const factory = ec.entity.conditionFactory
    return find("mantle.product.maintenance.AssetMaintenance", {assetId})
        .condition("statusId", "not-in", ["AsMntCompleted", "AsMntCancelled"])
        .condition(
            factory.makeCondition(
                [
                    factory.makeCondition("maintenanceDate", "is-null", null),
                    factory.makeCondition("maintenanceDate", "less-equals", ec.user.nowTimestamp)
                ],
                "or"
            )
        )
        .count()
}
const overlaps = (aFrom, aThru, bFrom, bThru) =>
    (lib.ms(aFrom) ?? -Infinity) < (lib.ms(bThru) ?? Infinity) && (lib.ms(bFrom) ?? -Infinity) < (lib.ms(aThru) ?? Infinity)
function storeEquipment(p) {
    const begun = posting.begin(p, "ProductionEquipment", "PRODUCTION_PLAN", [
        "workEffortId",
        "expectedRevision",
        "assetId",
        "fromDate",
        "thruDate",
        "end",
        "comments"
    ])
    if (begun.previous) return begun.previous
    const userScope = posting.scope()
    const run = production().runOf(userScope, p.workEffortId, true)
    const settled = posting.settled(begun.op)
    if (settled) return settled
    if (!openStatuses.includes(run.statusId))
        denied("RUN_CLOSED", "Work order " + run.workEffortId + " is " + statusText(run.statusId))
    requireRevision(run, p.expectedRevision)
    const asset = blank(p.assetId) ? null : one(ASSET, {assetId: p.assetId})
    const home = asset?.facilityId ? one(FACILITY, {facilityId: asset.facilityId}) : null
    if (!asset || !home || !facilityScope.owns(userScope, home.ownerPartyId) || home.ownerPartyId !== run.ownerPartyId)
        denied("RECORD_UNAVAILABLE", "Equipment " + (p.assetId || "") + " is not available")
    if (stockTypes.includes(asset.assetTypeEnumId))
        denied("EQUIPMENT_INVALID", "Asset " + asset.assetId + " is stock, not equipment")
    const now = ec.user.nowTimestamp
    const current = rows(ASSIGN, {workEffortId: run.workEffortId, assetId: asset.assetId}).filter(
        row => row.thruDate == null || lib.ms(row.thruDate) > lib.ms(now)
    )
    let resultCode
    if (yes(p.end)) {
        if (!current.length) denied("NOT_ASSIGNED", "Equipment " + asset.assetId + " is not assigned to this work order")
        for (const row of current)
            call("update#" + ASSIGN, {
                workEffortId: row.workEffortId,
                assetId: row.assetId,
                fromDate: row.fromDate,
                thruDate: lib.ms(row.fromDate) > lib.ms(now) ? row.fromDate : now
            })
        resultCode = "ENDED"
    } else {
        if (current.length) denied("ALREADY_ASSIGNED", "Equipment " + asset.assetId + " is assigned to this work order already")
        if (blockedEquipment.includes(asset.statusId) || openMaintenance(asset.assetId))
            denied("EQUIPMENT_BLOCKED", "Equipment " + asset.assetId + " is " + (statusText(asset.statusId) || "in maintenance"))
        const fromDate = p.fromDate || run.estimatedStartDate || now
        const thruDate = p.thruDate || run.estimatedCompletionDate || null
        if (thruDate != null && lib.ms(thruDate) <= lib.ms(fromDate))
            denied("DATES_INVALID", "The assignment ends before it starts")
        // another open run holding the same equipment over the same time
        const clash = rows(ASSIGN, {assetId: asset.assetId}).find(row => {
            if (row.workEffortId === run.workEffortId || !overlaps(fromDate, thruDate, row.fromDate, row.thruDate)) return false
            const other = one(WORK, {workEffortId: row.workEffortId})
            return other?.purposeEnumId === "WepProductionRun" && openStatuses.includes(other.statusId)
        })
        if (clash)
            denied(
                "EQUIPMENT_OVERLAP",
                "Equipment " + asset.assetId + " is assigned to work order " + clash.workEffortId + " over that time"
            )
        call("create#" + ASSIGN, {
            workEffortId: run.workEffortId,
            assetId: asset.assetId,
            fromDate,
            thruDate,
            statusId: "WeaaAssigned",
            comments: str(p.comments)
        })
        resultCode = "ASSIGNED"
    }
    call("update#" + WORK, {workEffortId: run.workEffortId, productionRevision: revisionOf(run) + 1})
    return posting.complete(begun.op, run.ownerPartyId, WORK, run.workEffortId, {
        resultCode,
        workEffortId: run.workEffortId,
        assetId: asset.assetId,
        revision: revisionOf(run) + 1
    })
}

// ===== store#ProductionParty: the guarded assignment =====
// The skills the run's operation templates require that the person lacks: advisory here (impl-manufacturing §4: blocking at
// start, P10).
function missingSkills(run, partyId) {
    const operations = operationsOfRun(run.workEffortId)
    const templateIds = operations.map(op => op.routingOperationWorkEffortId).filter(Boolean)
    if (!templateIds.length) return []
    const sources = Array.from(find(WORK).condition("workEffortId", "in", templateIds).list())
    const standardIds = Array.from(new Set([...templateIds, ...sources.map(row => row.methodSourceWorkEffortId).filter(Boolean)]))
    const required = Array.from(
        new Set(
            Array.from(
                find("mantle.work.effort.WorkEffortSkillStandard")
                    .condition("workEffortId", "in", standardIds)
                    .selectField("skillTypeEnumId")
                    .list()
            ).map(row => row.skillTypeEnumId)
        )
    )
    const held = new Set(rows("mantle.party.PartySkill", {partyId}).map(row => row.skillTypeEnumId))
    return required
        .filter(skill => !held.has(skill))
        .map(skill => one("moqui.basic.Enumeration", {enumId: skill})?.description || skill)
}
function storeParty(p) {
    const begun = posting.begin(
        p,
        "ProductionParty",
        ["PRODUCTION_PLAN", "PRODUCTION_SUPERVISE"],
        ["workEffortId", "expectedRevision", "partyId", "roleTypeId", "remove"]
    )
    if (begun.previous) return begun.previous
    const userScope = posting.scope()
    const run = production().runOf(userScope, p.workEffortId, true)
    const settled = posting.settled(begun.op)
    if (settled) return settled
    if (!openStatuses.includes(run.statusId))
        denied("RUN_CLOSED", "Work order " + run.workEffortId + " is " + statusText(run.statusId))
    requireRevision(run, p.expectedRevision)
    const roleTypeId = str(p.roleTypeId)
    if (!roleTypeId || !partyRoles[roleTypeId]) denied("ROLE_INVALID", "Assign a supervisor or an operator")
    // a person of the run's organization (an employee or agent), checked without telling whether another party exists
    const person = blank(p.partyId) ? null : one("mantle.party.Person", {partyId: p.partyId})
    const member =
        person &&
        rows("mantle.party.PartyRelationship", {fromPartyId: person.partyId, toPartyId: run.ownerPartyId}).some(row =>
            lib.active(row)
        )
    if (!member) denied("PARTY_UNAVAILABLE", "Person " + (p.partyId || "") + " is not available for this work order")
    let warnings = []
    if (yes(p.remove)) {
        call("mantle.work.WorkEffortServices.remove#WorkEffortParty", {
            workEffortId: run.workEffortId,
            partyId: person.partyId,
            roleTypeId
        })
    } else {
        call("mantle.work.WorkEffortServices.add#WorkEffortParty", {
            workEffortId: run.workEffortId,
            partyId: person.partyId,
            roleTypeId,
            statusId: "WeptAssigned"
        })
        if (roleTypeId === "Assignee")
            warnings = missingSkills(run, person.partyId).map(
                skill => "Not qualified in " + skill + " (required by an operation)"
            )
    }
    call("update#" + WORK, {workEffortId: run.workEffortId, productionRevision: revisionOf(run) + 1})
    return posting.complete(begun.op, run.ownerPartyId, WORK, run.workEffortId, {
        resultCode: yes(p.remove) ? "REMOVED" : "ASSIGNED",
        workEffortId: run.workEffortId,
        partyId: person.partyId,
        roleTypeId,
        revision: revisionOf(run) + 1,
        warnings
    })
}
// The run's equipment and people, for Overview.
function resources(p) {
    requireAny(["PRODUCTION_VIEW"])
    const run = production().runOf(posting.scope(), p.workEffortId)
    const now = ec.user.nowTimestamp
    const equipmentRows = rows(ASSIGN, {workEffortId: run.workEffortId})
        .sort((a, b) => lib.ms(b.fromDate) - lib.ms(a.fromDate))
        .map(row => {
            const asset = one(ASSET, {assetId: row.assetId})
            return {
                assetId: row.assetId,
                assetName: asset?.assetName || row.assetId,
                fromDate: row.fromDate,
                fromText: when(row.fromDate),
                thruText: when(row.thruDate),
                current: row.thruDate == null || lib.ms(row.thruDate) > lib.ms(now),
                statusText: statusText(row.statusId),
                comments: row.comments || null
            }
        })
    const peopleRows = rows(PARTY, {workEffortId: run.workEffortId})
        .filter(row => partyRoles[row.roleTypeId])
        .sort((a, b) => lib.ms(b.fromDate) - lib.ms(a.fromDate))
        .map(row => {
            const person = one("mantle.party.Person", {partyId: row.partyId})
            return {
                partyId: row.partyId,
                partyName: person ? [person.firstName, person.lastName].filter(Boolean).join(" ") || row.partyId : row.partyId,
                roleTypeId: row.roleTypeId,
                roleText: partyRoles[row.roleTypeId],
                fromText: when(row.fromDate),
                thruText: when(row.thruDate),
                current: row.thruDate == null || lib.ms(row.thruDate) > lib.ms(now)
            }
        })
    return {equipmentRows, peopleRows, revision: revisionOf(run), statusId: run.statusId}
}

// ===== get#ProductionOperations =====
const idList = value =>
    String(value || "")
        .split(/[\s,]+/)
        .filter(Boolean)
function operations(p) {
    requireAny(["PRODUCTION_VIEW", "PRODUCTION_OPERATE"])
    const run = production().runOf(posting.scope(), p.workEffortId)
    const lines = production().linesOf(run.workEffortId)
    const methodDate = run.productionMethodDate || ec.user.nowTimestamp
    // the routing operations' sequence, predecessors and work center as of the method date (WeatRoutingComp rows)
    const routingIds = production().routingsOf(run, lines)
    const comps = new Map()
    for (const routingId of routingIds)
        for (const assoc of rows(ASSOC, {workEffortId: routingId, workEffortAssocTypeEnumId: "WeatRoutingComp"}).filter(row =>
            lib.active(row, methodDate)
        ))
            comps.set(assoc.toWorkEffortId, assoc)
    const centerNames = new Map()
    const centerName = facilityId => {
        if (!facilityId) return ""
        if (!centerNames.has(facilityId)) centerNames.set(facilityId, facilityName(one(FACILITY, {facilityId})))
        return centerNames.get(facilityId)
    }
    const children = operationsOfRun(run.workEffortId)
    const draft = !children.length
    const base = draft
        ? Array.from(comps.values())
              .sort((a, b) => Number(a.sequenceNum || 0) - Number(b.sequenceNum || 0))
              .map(assoc => {
                  const op = one(WORK, {workEffortId: assoc.toWorkEffortId})
                  return {
                      workEffortId: null,
                      routingOperationWorkEffortId: assoc.toWorkEffortId,
                      workEffortName: op?.workEffortName || assoc.toWorkEffortId,
                      sequenceNum: assoc.sequenceNum == null ? null : Number(assoc.sequenceNum),
                      workCenterFacilityId: assoc.workCenterFacilityId || op?.methodWorkCenterId || null,
                      statusId: null
                  }
              })
        : children.map(op => ({
              workEffortId: op.workEffortId,
              routingOperationWorkEffortId: op.routingOperationWorkEffortId || null,
              workEffortName: op.workEffortName || op.workEffortId,
              sequenceNum: op.operationSequenceNum ?? op.sequenceNum ?? null,
              workCenterFacilityId: op.workCenterFacilityId || null,
              statusId: op.statusId,
              estimatedStartDate: op.estimatedStartDate,
              estimatedCompletionDate: op.estimatedCompletionDate,
              actualStartDate: op.actualStartDate,
              actualCompletionDate: op.actualCompletionDate
          }))
    const byRouting = new Map(base.map(row => [row.routingOperationWorkEffortId, row]))
    // an in-process quality gate not passed holds the operations after it, naming its inspection (P8)
    const gateBlocks = draft ? {} : productionQuality().operationBlocks(run)
    const shortLines = lines.filter(line => dec(line.stagedShortQuantity).compare(0) > 0)
    const operationRows = base.map(row => {
        const predecessorIds = idList(comps.get(row.routingOperationWorkEffortId)?.predecessorWorkEffortIds)
        const predecessors = predecessorIds.map(id => byRouting.get(id)).filter(Boolean)
        const waiting = predecessors.filter(pred => pred.statusId !== "WeComplete")
        const short = shortLines.filter(
            line =>
                line.operationWorkEffortId === row.workEffortId ||
                (!line.operationWorkEffortId && line.routingOperationWorkEffortId === row.routingOperationWorkEffortId)
        )
        let ready = false,
            readinessText
        if (draft || run.statusId === "WeInPlanning") readinessText = "Work order not released"
        else if (row.statusId === "WeComplete") readinessText = "Done"
        else if (row.statusId === "WeCancelled") readinessText = "Cancelled"
        else if (run.statusId === "WeOnHold") readinessText = "Work order on hold"
        else if (!["WeApproved", "WeInProgress"].includes(run.statusId)) readinessText = "Work order " + statusText(run.statusId)
        else if (waiting.length) readinessText = "Waiting for " + waiting.map(pred => pred.workEffortName).join(", ")
        else if (gateBlocks[row.workEffortId]) readinessText = gateBlocks[row.workEffortId].message
        else if (short.length)
            readinessText =
                "Short of " +
                short.map(line => one(PRODUCT, {productId: line.productId})?.productName || line.productId).join(", ")
        else {
            ready = true
            readinessText = row.statusId === "WeInProgress" ? "In progress" : "Ready"
        }
        return Object.assign(row, {
            statusText: row.statusId ? statusText(row.statusId) : "Planned",
            workCenterName: centerName(row.workCenterFacilityId),
            predecessorText: predecessors.map(pred => pred.workEffortName).join(", "),
            plannedText: [when(row.estimatedStartDate), when(row.estimatedCompletionDate)].filter(Boolean).join(" to "),
            actualText: [when(row.actualStartDate), when(row.actualCompletionDate)].filter(Boolean).join(" to "),
            materialCount: lines.filter(
                line =>
                    line.lineRoleEnumId === "PrlrMaterial" &&
                    (line.operationWorkEffortId
                        ? line.operationWorkEffortId === row.workEffortId
                        : line.routingOperationWorkEffortId === row.routingOperationWorkEffortId)
            ).length,
            ready,
            readinessText,
            blockingInspectionId: gateBlocks[row.workEffortId]?.qualityInspectionId || null
        })
    })
    return {operationRows, draft, routed: routingIds.length > 0, statusId: run.statusId}
}

// ===== get#ProductionPickList =====
// Each material line with what it has left and the stock to pick for it: available assets of the run's owner at the
// facilities the run nets against, oldest receipt first, up to the need.
function pickList(p) {
    requireAny(["PRODUCTION_VIEW", "STOCK_ISSUE"])
    const run = production().runOf(posting.scope(), p.workEffortId)
    const lines = production()
        .linesOf(run.workEffortId)
        .filter(line => line.lineRoleEnumId === "PrlrMaterial")
    const facilityIds = stockFacilityIds(run)
    const ops = new Map(rows(WORK, {parentWorkEffortId: run.workEffortId}).map(op => [op.workEffortId, op]))
    const taken = new Map()
    const pickRows = lines.map(line => {
        const product = one(PRODUCT, {productId: line.productId})
        const need = production().materialTotals(line).remaining
        let left = need
        const picks = []
        if (facilityIds.length && need.compare(0) > 0) {
            const assets = Array.from(
                find(ASSET, {productId: line.productId, ownerPartyId: run.ownerPartyId, statusId: "AstAvailable"})
                    .condition("facilityId", "in", facilityIds)
                    .condition("availableToPromiseTotal", "greater-than", 0)
                    .orderBy("receivedDate")
                    .orderBy("assetId")
                    .limit(50)
                    .list()
            )
            for (const asset of assets) {
                if (left.compare(0) <= 0) break
                const free = dec(asset.availableToPromiseTotal).subtract(taken.get(asset.assetId) || zero())
                if (free.compare(0) <= 0) continue
                const pick = free.compare(left) >= 0 ? left : free
                taken.set(asset.assetId, (taken.get(asset.assetId) || zero()).add(pick))
                left = left.subtract(pick)
                picks.push({
                    assetId: asset.assetId,
                    lotId: asset.lotId || null,
                    facilityId: asset.facilityId,
                    locationSeqId: asset.locationSeqId || null,
                    quantity: text(pick)
                })
            }
        }
        const op = line.operationWorkEffortId ? ops.get(line.operationWorkEffortId) : null
        return {
            productionRunLineId: line.productionRunLineId,
            productId: line.productId,
            productName: product?.productName || line.productId,
            pseudoId: product?.pseudoId || line.productId,
            operationName: op?.workEffortName || "",
            required: text(line.stockQuantity),
            remaining: text(need),
            stockUomId: line.stockUomId || null,
            short: left.compare(0) > 0 ? text(left) : null,
            pickText: picks
                .map(pick => pick.quantity + " from " + (pick.lotId ? "lot " + pick.lotId + ", " : "") + pick.assetId)
                .join("; "),
            picks
        }
    })
    return {pickRows}
}

const operationsTable = {
    find: findOrders,
    transition,
    batch,
    lifecycle,
    store: storeOrder,
    storeEquipment,
    storeParty,
    resources,
    operations,
    pickList
}
;({
    stagedBlock,
    stockFacilityIds,
    shortagesOf,
    execute: (op, parameters) => {
        if (!operationsTable[op]) throw new Error("Unknown production order operation " + op)
        return operationsTable[op](parameters)
    }
})
