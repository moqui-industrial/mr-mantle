// Controlled changes of a production run (design-manufacturing Components Substitute, SplitWorkOrder, WorkOrderDetail's
// cancellation and clone, BillOfMaterialsCompare's amendment; §12.1 amend#ProductionOrder; M4; impl-manufacturing P9): what
// mantle.work.ProductionServices' change entry points add to Production.js's run, ProductionOrders.js's lifecycle and
// ProductionQuantities.js's figures.
// - get#ProductionChanges: a run's substitution and amendment requests with their reviews, the substitutes each material
//   line allows, and what the user may ask or decide.
// - substitute#ProductionMaterial: a material line's remaining quantity replaced by an alternative its BOM line's rule
//   allows (BsrEquivalent: Products' PatEquivalent rows of the component; nothing else), at a factor in the substitute's
//   stock unit, with a supervisor's approval (the policy's substituteApproval, Y by default): a new material line beside
//   the original, whose quantity drops by what is substituted, and the WeptConsume rows rewritten, so planning does not
//   count the demand twice and the substitute's issue is accepted. On a released run it is an amendment of the run's lines
//   (strict release refuses it).
// - preview#ProductionAmendment and amend#ProductionOrder (§12.1, the amendment policy of impl-manufacturing §4): the run's
//   method read again as of a date remaps only its unexecuted lines and operations; issued lines and started or completed
//   operations keep their facts and links. A request is reviewed by a method approver (METHOD_APPROVE) and a production
//   supervisor (PRODUCTION_SUPERVISE), each on the run, and applied when both have; the policy's strictRelease refuses it.
// - preview#ProductionSplit and split#ProductionOrder (PRODUCTION_PLAN): a quantity of the remaining output, and the
//   material it has not yet taken, moved to a new run of the same method date (a split, or a backorder that may complete the
//   source), the demand links (RequirementSupply) conserved; a retry answers the same runs.
// - preview#ProductionCancellation and cancel#ProductionOrder: a run with postings is cancelled only as a reviewed plan: a
//   reversal (every issue returned, then cancelled) when nothing was received, lost or timed, else a residual close (what is
//   left finished as an approved loss, the material variance accepted, the run completed for the cost close). Never a
//   deletion.
// - clone#ProductionOrder: a new draft through create#ProductionOrder from the run's product, quantity, facility and
//   method; no posting, line or timer is copied.
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const posting = ec.resource.script("component://mr-mantle/service/mantle/shipment/StockPosting.js")
const {find, one, rows, call, denied, access} = lib

const WORK = "mantle.work.effort.WorkEffort",
    WEP = "mantle.work.effort.WorkEffortProduct",
    LINE = "mantle.work.production.ProductionRunLine",
    CHANGE = "mantle.work.production.ProductionChange",
    QEVENT = "mantle.work.production.ProductionQuantityEvent",
    LOSS = "mantle.work.production.ProductionLoss",
    ISSUANCE = "mantle.product.issuance.AssetIssuance",
    RECEIPT = "mantle.product.receipt.AssetReceipt",
    TIME = "mantle.work.time.TimeEntry",
    PRODUCT = "mantle.product.Product",
    ASSOC = "mantle.product.ProductAssoc",
    BOM_ITEM = "mantle.product.bom.ProductBomItem",
    SUPPLY = "mantle.request.requirement.RequirementSupply",
    FACILITY = "mantle.facility.Facility",
    STATUS = "moqui.basic.StatusItem",
    ENUM = "moqui.basic.Enumeration"
const openStatuses = ["WeInPlanning", "WeApproved", "WeInProgress", "WeOnHold"]
const releasedStatuses = ["WeApproved", "WeInProgress", "WeOnHold"]
const zero = () => toDecimal(0)
const dec = value => toDecimal(value ?? 0)
const blank = value => value == null || String(value).trim() === ""
const str = value => (blank(value) ? null : String(value).trim())
const text = value => (value == null ? null : dec(value).compare(0) === 0 ? "0" : String(dec(value).toNumber()))
const atLeastZero = value => (value.compare(0) > 0 ? value : zero())
const yes = value => value === true || value === "true" || value === "Y"
const when = value => lib.dateText(value)
const production = () => ec.resource.script("component://mr-mantle/service/mantle/work/Production.js")
const productionPolicy = () => ec.resource.script("component://mr-mantle/service/mantle/work/ProductionPolicy.js")
const quantities = () => ec.resource.script("component://mr-mantle/service/mantle/work/ProductionQuantities.js")
const payables = () => ec.resource.script("component://mr-mantle/service/mantle/account/Payables.js")
const statusText = statusId => (statusId ? one(STATUS, {statusId})?.description || statusId : "")
const enumText = enumId => (enumId ? one(ENUM, {enumId})?.description || enumId : "")
const productName = productId => (productId ? one(PRODUCT, {productId})?.productName || productId : "")
const sum = (list, value) => list.reduce((total, row) => total.add(dec(value(row))), zero())

function requireAny(permissions) {
    if (!permissions.some(access.has)) denied("PERMISSION_DENIED", permissions.join(" or ") + " is required")
}
const revisionOf = run => Number(run.productionRevision || 0)
function requireRevision(run, expectedRevision) {
    if (blank(expectedRevision)) denied("REVISION_REQUIRED", "Review work order " + run.workEffortId + " and give its revision")
    if (Number(expectedRevision) !== revisionOf(run))
        denied("REVISION_CHANGED", "Work order " + run.workEffortId + " changed; reload and review it")
}
// The reason of a change: an active production reason of the run's organization and a text, at least one of them.
function reasonOf(run, p, required = true) {
    const parts = []
    if (!blank(p.reasonCode)) {
        const reason = productionPolicy().activeReason(run.ownerPartyId, p.reasonCode)
        if (!reason) denied("REASON_INVALID", "Reason " + p.reasonCode + " is not an active production reason")
        parts.push(reason.reasonName || p.reasonCode)
    }
    if (!blank(p.reason)) parts.push(String(p.reason).trim())
    if (required && !parts.length) denied("REASON_REQUIRED", "Give the reason for the change")
    return parts.join(": ") || null
}
function lineOf(run, productionRunLineId, roles, lock = false) {
    const line = blank(productionRunLineId) ? null : find(LINE, {productionRunLineId}).forUpdate(lock).one()
    if (!line || line.workEffortId !== run.workEffortId || !roles.includes(line.lineRoleEnumId))
        denied("LINE_INVALID", "Line " + (productionRunLineId || "") + " is not a line of work order " + run.workEffortId)
    return line
}
const outputOf = lines => lines.find(line => line.lineRoleEnumId === "PrlrOutput") || null
const operationsOf = run =>
    rows(WORK, {parentWorkEffortId: run.workEffortId})
        .filter(op => op.statusId !== "WeCancelled")
        .sort((a, b) => Number(a.sequenceNum || 0) - Number(b.sequenceNum || 0))
const bumpRevision = (run, fields = {}) => {
    const revision = revisionOf(one(WORK, {workEffortId: run.workEffortId})) + 1
    call("update#" + WORK, Object.assign({workEffortId: run.workEffortId, productionRevision: revision}, fields))
    return revision
}
function notify(topic, permission, run, recordId, message) {
    try {
        return payables().execute("notify", {
            topic,
            permission,
            organizationPartyId: run.ownerPartyId,
            recordEntityName: CHANGE,
            recordId,
            message: Object.assign(
                {
                    workEffortId: run.workEffortId,
                    workEffortName: run.workEffortName || run.workEffortId,
                    productionChangeId: recordId
                },
                message
            )
        })
    } catch (error) {
        ec.logger.error("Work order " + run.workEffortId + " notice " + topic + " was not sent: " + error.message)
        return null
    }
}
function clearNotices(topic, recordId) {
    try {
        payables().execute("clearNotices", {topic, recordEntityName: CHANGE, recordId})
    } catch (error) {
        ec.logger.error("Notices " + topic + " of " + recordId + " were not cleared: " + error.message)
    }
}
// A requested change of the run, locked; another run's or a decided one is refused.
function changeOf(run, productionChangeId, typeEnumId) {
    const change = blank(productionChangeId) ? null : find(CHANGE, {productionChangeId}).forUpdate(true).one()
    if (!change || change.workEffortId !== run.workEffortId || change.changeTypeEnumId !== typeEnumId)
        denied(
            "RECORD_UNAVAILABLE",
            "Change " + (productionChangeId || "") + " is not a change of work order " + run.workEffortId
        )
    if (change.statusId !== "PchRequested")
        denied("CHANGE_DECIDED", "Change " + change.productionChangeId + " is " + statusText(change.statusId) + " already")
    return change
}
const pendingOf = (run, typeEnumId) =>
    rows(CHANGE, {workEffortId: run.workEffortId, changeTypeEnumId: typeEnumId, statusId: "PchRequested"})
function refuseChange(run, change, p, topic) {
    if (blank(p.refusalReason) && blank(p.reason)) denied("REASON_REQUIRED", "Give the reason for the refusal")
    call("update#" + CHANGE, {
        productionChangeId: change.productionChangeId,
        statusId: "PchRefused",
        refusedByUserId: ec.user.userId,
        refusalReason: str(p.refusalReason) || str(p.reason)
    })
    clearNotices(topic, change.productionChangeId)
    return {resultCode: "REFUSED", workEffortId: run.workEffortId, productionChangeId: change.productionChangeId}
}

// ===== substitutes =====
// The alternatives a material line allows: none unless its BOM line's rule is BsrEquivalent, then the component's active
// PatEquivalent rows (R-PRD-31); availability never makes a product a candidate.
function candidatesOf(line) {
    if (line.substitutionRuleEnumId !== "BsrEquivalent" || line.substituteOfLineId) return []
    return rows(ASSOC, {productId: line.productId, productAssocTypeEnumId: "PatEquivalent"})
        .filter(row => lib.active(row))
        .map(row => one(PRODUCT, {productId: row.toProductId}))
        .filter(product => product && product.productId !== line.productId)
}
// What a substitution of a line would do, or why it is refused: the line, its candidate, the quantity of the original moved
// (at most what it has left to issue) and the substitute's quantity at the factor, in the substitute's stock unit.
function substitutionPlan(run, line, p) {
    if (!openStatuses.includes(run.statusId))
        denied("RUN_CLOSED", "Work order " + run.workEffortId + " is " + statusText(run.statusId))
    if (releasedStatuses.includes(run.statusId) && productionPolicy().runPolicy(run).strictRelease === "Y")
        denied("STRICT_RELEASE", "Work order " + run.workEffortId + " is released under strict release; make a linked new run")
    if (line.substituteOfLineId) denied("LINE_INVALID", "Line " + line.productionRunLineId + " is a substitute already")
    const candidates = candidatesOf(line)
    const substitute = candidates.find(product => product.productId === p.substituteProductId)
    if (!substitute)
        denied(
            "SUBSTITUTE_NOT_ALLOWED",
            "Product " +
                (p.substituteProductId || "") +
                " is not an allowed substitute of " +
                productName(line.productId) +
                (candidates.length
                    ? "; its BOM line allows " + candidates.map(row => row.productName || row.productId).join(", ")
                    : "; its BOM line allows none")
        )
    const remaining = production().materialTotals(line).remaining
    const quantity = blank(p.quantity) ? remaining : dec(p.quantity)
    if (quantity.compare(0) <= 0) denied("QUANTITY_INVALID", "Give a quantity above zero")
    if (quantity.compare(remaining) > 0)
        denied("QUANTITY_EXCEEDS_REMAINING", "Line " + line.productionRunLineId + " has " + text(remaining) + " left to issue")
    const factor = blank(p.conversionFactor) ? toDecimal(1) : dec(p.conversionFactor)
    if (factor.compare(0) <= 0) denied("QUANTITY_INVALID", "Give a factor above zero")
    const stockUomId = substitute.amountUomId || line.stockUomId || null
    if (blank(p.conversionFactor) && substitute.amountUomId && line.stockUomId && substitute.amountUomId !== line.stockUomId)
        denied(
            "UNIT_INCOMPATIBLE",
            productName(substitute.productId) +
                " is stocked in " +
                substitute.amountUomId +
                ", not " +
                line.stockUomId +
                "; give the factor of its unit"
        )
    const substituteQuantity = quantity.multiply(factor)
    return {
        line,
        substitute,
        quantity,
        factor,
        substituteQuantity,
        stockUomId,
        previewKey: lib.hash([
            run.workEffortId,
            revisionOf(run),
            line.productionRunLineId,
            substitute.productId,
            text(quantity),
            text(factor)
        ])
    }
}
// The substitution applied: the substitute's line beside the original (its operation, the original's BOM line), the
// original's quantity lowered by what is moved, the WeptConsume rows rewritten, the revision counted up.
function applySubstitution(run, change) {
    const line = lineOf(run, change.productionRunLineId, ["PrlrMaterial"], true)
    const remaining = production().materialTotals(line).remaining
    const moved = dec(change.quantity)
    if (moved.compare(remaining) > 0)
        denied(
            "QUANTITY_EXCEEDS_REMAINING",
            "Line " + line.productionRunLineId + " has only " + text(remaining) + " left to issue now"
        )
    const substitute = one(PRODUCT, {productId: change.substituteProductId})
    const stockUomId = substitute?.amountUomId || line.stockUomId || null
    const keep = dec(line.stockQuantity).subtract(moved)
    const lineFactor = dec(line.conversionFactor ?? 1)
    call("update#" + LINE, {
        productionRunLineId: line.productionRunLineId,
        stockQuantity: keep,
        quantity: lineFactor.isZero() ? keep : keep.divide(lineFactor, 6, "HALF_UP")
    })
    const created = call("create#" + LINE, {
        workEffortId: run.workEffortId,
        lineRoleEnumId: "PrlrMaterial",
        lineSeqNum: Number(line.lineSeqNum || 0) + 1,
        productId: substitute.productId,
        quantity: dec(change.substituteQuantity),
        quantityUomId: stockUomId,
        stockQuantity: dec(change.substituteQuantity),
        stockUomId,
        conversionFactor: 1,
        scrapFactor: line.scrapFactor ?? null,
        substitutionRuleEnumId: "BsrNone",
        bomItemId: line.bomItemId || null,
        productBomId: line.productBomId || null,
        bomPath: line.bomPath || null,
        routingOperationWorkEffortId: line.routingOperationWorkEffortId || null,
        operationWorkEffortId: line.operationWorkEffortId || null,
        frozenDate: line.frozenDate ? ec.user.nowTimestamp : null,
        sourceFacilityId: line.sourceFacilityId || null,
        substituteOfLineId: line.productionRunLineId,
        productionChangeId: change.productionChangeId
    })
    production().writeProducts(run.workEffortId, production().linesOf(run.workEffortId))
    const revision = bumpRevision(run)
    call("update#" + CHANGE, {
        productionChangeId: change.productionChangeId,
        statusId: "PchApplied",
        substituteRunLineId: created.productionRunLineId,
        appliedDate: ec.user.nowTimestamp,
        resultRevision: revision
    })
    return {revision, substituteRunLineId: created.productionRunLineId}
}
function substitute(p) {
    const action = str(p.action) || "request"
    const begun = posting.begin(
        p,
        "ProductionSubstitution",
        ["PRODUCTION_PLAN", "PRODUCTION_SUPERVISE"],
        [
            "workEffortId",
            "action",
            "expectedRevision",
            "productionRunLineId",
            "substituteProductId",
            "quantity",
            "conversionFactor",
            "reason",
            "reasonCode",
            "productionChangeId",
            "refusalReason"
        ]
    )
    if (begun.previous) return begun.previous
    const userScope = posting.scope()
    const run = production().runOf(userScope, p.workEffortId, true)
    const settled = posting.settled(begun.op)
    if (settled) return settled
    let answer
    if (action === "request") {
        requireRevision(run, p.expectedRevision)
        const line = lineOf(run, p.productionRunLineId, ["PrlrMaterial"], true)
        const plan = substitutionPlan(run, line, p)
        const why = reasonOf(run, p)
        if (pendingOf(run, "PchtSubstitution").some(row => row.productionRunLineId === line.productionRunLineId))
            denied("CHANGE_PENDING", "A substitute of " + productName(line.productId) + " waits for a supervisor already")
        const supervisor = access.has("PRODUCTION_SUPERVISE")
        const needsApproval = productionPolicy().runPolicy(run).substituteApproval !== "N"
        const change = call("create#" + CHANGE, {
            workEffortId: run.workEffortId,
            organizationPartyId: run.ownerPartyId,
            changeTypeEnumId: "PchtSubstitution",
            statusId: "PchRequested",
            runRevision: revisionOf(run),
            previewKey: plan.previewKey,
            productionRunLineId: line.productionRunLineId,
            substituteProductId: plan.substitute.productId,
            quantity: plan.quantity,
            conversionFactor: plan.factor,
            substituteQuantity: plan.substituteQuantity,
            reasonCode: str(p.reasonCode),
            reason: why,
            requestedByUserId: ec.user.userId,
            requestedDate: ec.user.nowTimestamp,
            supervisorApprovedByUserId: supervisor ? ec.user.userId : null,
            supervisorApprovedDate: supervisor ? ec.user.nowTimestamp : null
        })
        const changeId = change.productionChangeId
        if (supervisor || !needsApproval) {
            const applied = applySubstitution(run, one(CHANGE, {productionChangeId: changeId}))
            answer = Object.assign(
                {resultCode: "APPLIED", productionChangeId: changeId, amendment: releasedStatuses.includes(run.statusId)},
                applied
            )
        } else {
            const sent = notify("ProductionSubstitution", "PRODUCTION_SUPERVISE", run, changeId, {
                productName: productName(line.productId),
                substituteName: plan.substitute.productName || plan.substitute.productId,
                quantity: text(plan.quantity),
                requestedByUserId: ec.user.userId,
                reason: why
            })
            answer = {resultCode: "REQUESTED", productionChangeId: changeId, revision: revisionOf(run), notified: !!sent}
        }
    } else if (action === "approve" || action === "refuse") {
        requireAny(["PRODUCTION_SUPERVISE"])
        const change = changeOf(run, p.productionChangeId, "PchtSubstitution")
        if (action === "refuse") answer = refuseChange(run, change, p, "ProductionSubstitution")
        else {
            // a decision revalidates the request: the run at its revision, the candidate still allowed, the quantity left
            if (revisionOf(run) !== Number(change.runRevision))
                denied("CHANGE_STALE", "Work order " + run.workEffortId + " changed since the substitute was asked; ask again")
            const line = lineOf(run, change.productionRunLineId, ["PrlrMaterial"], true)
            substitutionPlan(run, line, {
                substituteProductId: change.substituteProductId,
                quantity: change.quantity,
                conversionFactor: change.conversionFactor
            })
            call("update#" + CHANGE, {
                productionChangeId: change.productionChangeId,
                supervisorApprovedByUserId: ec.user.userId,
                supervisorApprovedDate: ec.user.nowTimestamp
            })
            const applied = applySubstitution(run, one(CHANGE, {productionChangeId: change.productionChangeId}))
            clearNotices("ProductionSubstitution", change.productionChangeId)
            answer = Object.assign(
                {
                    resultCode: "APPLIED",
                    productionChangeId: change.productionChangeId,
                    amendment: releasedStatuses.includes(run.statusId)
                },
                applied
            )
        }
    } else denied("ACTION_INVALID", "Unknown substitution action " + action)
    return posting.complete(
        begun.op,
        run.ownerPartyId,
        CHANGE,
        answer.productionChangeId,
        Object.assign({workEffortId: run.workEffortId}, answer)
    )
}

// ===== the amendment =====
// The facts of an operation child: started (not Approved any more) or any movement or time on it.
function operationExecuted(run, op) {
    if (op.statusId !== "WeApproved") return true
    return (
        find(ISSUANCE, {workEffortId: run.workEffortId, operationWorkEffortId: op.workEffortId}).count() > 0 ||
        find(RECEIPT, {workEffortId: run.workEffortId, operationWorkEffortId: op.workEffortId}).count() > 0 ||
        find(TIME, {workEffortId: op.workEffortId}).count() > 0
    )
}
// The BOM lines a line of the method replaces, nearest first (a released correction is a new dated line linked to its
// predecessor).
function lineageOf(bomItemId) {
    const ids = []
    let item = bomItemId ? one(BOM_ITEM, {bomItemId}) : null
    while (item?.replacesBomItemId && ids.length < 20 && !ids.includes(item.replacesBomItemId)) {
        ids.push(item.replacesBomItemId)
        item = one(BOM_ITEM, {bomItemId: item.replacesBomItemId})
    }
    return ids
}
// What substitutes took of a line: the original's quantity the applied substitutions moved.
const substitutedOf = (run, line) =>
    sum(
        rows(CHANGE, {
            workEffortId: run.workEffortId,
            changeTypeEnumId: "PchtSubstitution",
            statusId: "PchApplied",
            productionRunLineId: line.productionRunLineId
        }),
        row => row.quantity
    )
const lineFields = [
    "productId",
    "quantity",
    "quantityUomId",
    "stockQuantity",
    "stockUomId",
    "conversionFactor",
    "uomConversionId",
    "scrapFactor",
    "bomItemId",
    "productBomId",
    "bomPath",
    "routingOperationWorkEffortId"
]
// The remap an amendment as of the date makes (design §12.1): the run's method read as of it; an operation child with facts
// or started is kept as it is, an unexecuted one follows the routing (kept, cancelled when its routing operation is gone,
// added for a new one); a method material line with an issue or on an executed operation is kept with its facts and links,
// an unexecuted one takes the new line's quantity and operation (less what substitutes took), a new line is added and a
// line the method no longer has is removed. Manual and substitute lines and the output stay. Read only: {allowed,
// reasonCode, message, lineRows, operationRows, findings, previewKey, plan}.
function amendmentPlan(run, methodDate) {
    const refused = (reasonCode, message) => ({
        allowed: false,
        reasonCode,
        message,
        lineRows: [],
        operationRows: [],
        findings: []
    })
    if (!releasedStatuses.includes(run.statusId))
        return refused(
            "AMEND_NOT_RELEASED",
            run.statusId === "WeInPlanning"
                ? "A draft is changed directly or re-exploded at its release"
                : "Work order " + run.workEffortId + " is " + statusText(run.statusId)
        )
    if (productionPolicy().runPolicy(run).strictRelease === "Y")
        return refused(
            "STRICT_RELEASE",
            "Work order " + run.workEffortId + " is released under strict release; make a linked new run"
        )
    const date = methodDate || ec.user.nowTimestamp
    const lines = production().linesOf(run.workEffortId)
    const output = outputOf(lines)
    if (!output) return refused("LINES_REQUIRED", "The work order has no output line")
    let plan
    try {
        plan = production().method(
            run.ownerPartyId,
            one(PRODUCT, {productId: output.productId}),
            dec(output.quantity),
            output.quantityUomId,
            date,
            run.productBomId,
            run.productionRoutingId
        )
    } catch (error) {
        return refused(lib.reasonCode(error) || "METHOD_INVALID", String(error.message || error).replace(/^(Error: )+/, ""))
    }
    const findings = []
    // the operations
    const children = operationsOf(run)
    const executed = new Map(children.map(op => [op.workEffortId, operationExecuted(run, op)]))
    const operationRows = []
    const byRoutingOp = new Map()
    for (const op of plan.operations) {
        const child = children.find(row => row.routingOperationWorkEffortId === op.workEffortId)
        if (child) {
            byRoutingOp.set(op.workEffortId, child.workEffortId)
            const changed =
                !executed.get(child.workEffortId) &&
                ((op.workEffortName || null) !== (child.workEffortName || null) ||
                    (op.workCenterFacilityId || null) !== (child.workCenterFacilityId || null))
            operationRows.push({
                change: executed.get(child.workEffortId) ? "kept" : changed ? "changed" : "unchanged",
                workEffortId: child.workEffortId,
                routingOperationWorkEffortId: op.workEffortId,
                workEffortName: op.workEffortName || child.workEffortName,
                workCenterFacilityId: op.workCenterFacilityId || null,
                sequenceNum: op.sequenceNum,
                statusText: statusText(child.statusId)
            })
        } else
            operationRows.push({
                change: "added",
                workEffortId: null,
                routingOperationWorkEffortId: op.workEffortId,
                workEffortName: op.workEffortName,
                workCenterFacilityId: op.workCenterFacilityId || null,
                sequenceNum: op.sequenceNum,
                statusText: ""
            })
    }
    for (const child of children)
        if (!plan.operations.some(op => op.workEffortId === child.routingOperationWorkEffortId)) {
            const keep = executed.get(child.workEffortId)
            operationRows.push({
                change: keep ? "kept" : "cancelled",
                workEffortId: child.workEffortId,
                routingOperationWorkEffortId: child.routingOperationWorkEffortId,
                workEffortName: child.workEffortName,
                workCenterFacilityId: child.workCenterFacilityId || null,
                sequenceNum: child.operationSequenceNum ?? child.sequenceNum,
                statusText: statusText(child.statusId)
            })
            if (keep)
                findings.push({
                    code: "OPERATION_EXECUTED_KEPT",
                    message:
                        "Operation " +
                        (child.workEffortName || child.workEffortId) +
                        " has started; it stays though the routing no longer has it"
                })
        }
    // the material lines of the method (manual and substitute lines stay as they are)
    const methodLines = lines.filter(
        line => line.lineRoleEnumId === "PrlrMaterial" && line.manualLine !== "Y" && !line.substituteOfLineId
    )
    const losses = rows(LOSS, {workEffortId: run.workEffortId})
    const lineExecuted = line =>
        production().materialTotals(line).issued.compare(0) > 0 ||
        losses.some(loss => loss.productionRunLineId === line.productionRunLineId) ||
        (!!line.operationWorkEffortId && !!executed.get(line.operationWorkEffortId))
    const matched = new Set()
    const lineRows = []
    for (const next of plan.lines.filter(line => line.lineRoleEnumId === "PrlrMaterial")) {
        const free = methodLines.filter(line => !matched.has(line.productionRunLineId))
        const lineage = lineageOf(next.bomItemId)
        const current =
            free.find(line => line.bomItemId && line.bomItemId === next.bomItemId) ||
            free.find(line => line.bomItemId && lineage.includes(line.bomItemId)) ||
            free.find(
                line =>
                    line.productId === next.productId &&
                    (line.routingOperationWorkEffortId || null) === (next.routingOperationWorkEffortId || null)
            ) ||
            free.find(line => line.productId === next.productId)
        const nextStock = dec(next.stockQuantity)
        if (!current) {
            lineRows.push({
                change: "added",
                productionRunLineId: null,
                productId: next.productId,
                productName: productName(next.productId),
                before: null,
                after: text(nextStock),
                stockUomId: next.stockUomId || null,
                routingOperationWorkEffortId: next.routingOperationWorkEffortId || null,
                next: lib.map(next)
            })
            continue
        }
        matched.add(current.productionRunLineId)
        // what substitutes took of the line stays theirs, and an issue already made stays the floor
        const taken = substitutedOf(run, current)
        const net = production().materialTotals(current).net
        let target = atLeastZero(nextStock.subtract(taken))
        if (target.compare(net) < 0) target = net
        const before = dec(current.stockQuantity)
        if (lineExecuted(current)) {
            lineRows.push({
                change: "kept",
                productionRunLineId: current.productionRunLineId,
                productId: current.productId,
                productName: productName(current.productId),
                before: text(before),
                after: text(before),
                stockUomId: current.stockUomId || null,
                routingOperationWorkEffortId: current.routingOperationWorkEffortId || null
            })
            if (target.compare(before) !== 0 || next.productId !== current.productId)
                findings.push({
                    code: "LINE_EXECUTED_KEPT",
                    message:
                        productName(current.productId) +
                        " has been issued or its operation has started; it keeps " +
                        text(before) +
                        " where the method now asks " +
                        text(nextStock)
                })
            continue
        }
        const changed =
            target.compare(before) !== 0 ||
            next.productId !== current.productId ||
            (next.routingOperationWorkEffortId || null) !== (current.routingOperationWorkEffortId || null) ||
            (next.bomItemId || null) !== (current.bomItemId || null)
        lineRows.push({
            change: changed ? "changed" : "unchanged",
            productionRunLineId: current.productionRunLineId,
            productId: next.productId,
            productName: productName(next.productId),
            before: text(before),
            after: text(target),
            stockUomId: next.stockUomId || null,
            routingOperationWorkEffortId: next.routingOperationWorkEffortId || null,
            next: Object.assign(lib.map(next), {stockQuantity: target})
        })
    }
    for (const line of methodLines.filter(row => !matched.has(row.productionRunLineId))) {
        const keep = lineExecuted(line)
        lineRows.push({
            change: keep ? "kept" : "removed",
            productionRunLineId: line.productionRunLineId,
            productId: line.productId,
            productName: productName(line.productId),
            before: text(line.stockQuantity),
            after: keep ? text(line.stockQuantity) : "0",
            stockUomId: line.stockUomId || null,
            routingOperationWorkEffortId: line.routingOperationWorkEffortId || null
        })
        if (keep)
            findings.push({
                code: "LINE_EXECUTED_KEPT",
                message: productName(line.productId) + " has been issued; it stays though the method no longer has it"
            })
    }
    const changes =
        lineRows.filter(row => ["added", "changed", "removed"].includes(row.change)).length +
        operationRows.filter(row => ["added", "changed", "cancelled"].includes(row.change)).length
    const summary = (list, kind) =>
        ["added", "changed", "removed", "cancelled", "kept"]
            .map(change => [change, list.filter(row => row.change === change).length])
            .filter(([, count]) => count)
            .map(([change, count]) => count + " " + kind + (count === 1 ? "" : "s") + " " + change)
    const impact = summary(lineRows, "line").concat(summary(operationRows, "operation"))
    const previewKey = lib.hash({
        workEffortId: run.workEffortId,
        revision: revisionOf(run),
        date: lib.ms(date),
        lines: lineRows.map(row => [row.change, row.productionRunLineId, row.productId, row.after]),
        operations: operationRows.map(row => [row.change, row.workEffortId, row.routingOperationWorkEffortId])
    })
    const strip = row => Object.fromEntries(Object.entries(row).filter(([key]) => key !== "next"))
    if (!changes)
        return {
            allowed: false,
            reasonCode: "NO_CHANGE",
            message: "The method as of " + when(date) + " changes none of the remaining lines or operations",
            lineRows: lineRows.map(strip),
            operationRows,
            findings,
            previewKey
        }
    return {
        allowed: true,
        methodDate: date,
        methodDateText: when(date),
        impact,
        lineRows: lineRows.map(strip),
        operationRows,
        findings,
        previewKey,
        plan,
        detail: {lineRows, operationRows}
    }
}
function previewAmendment(p) {
    requireAny(["PRODUCTION_VIEW", "PRODUCTION_PLAN", "METHOD_APPROVE"])
    const run = production().runOf(posting.scope(), p.workEffortId)
    const out = amendmentPlan(run, p.methodDate || null)
    delete out.plan
    delete out.detail
    return Object.assign(out, {workEffortId: run.workEffortId, revision: revisionOf(run)})
}
// The amendment applied (both reviews given): the operations cancelled, changed and added, the lines changed, added and
// removed, the WeptConsume/WeptProduce rows rewritten, and the run's method date, routing and method refs at the next
// revision, each an audit-logged change with the amendment as its reason.
function applyAmendment(run, change, amendment) {
    const why = "Amendment " + change.productionChangeId + (change.reason ? ": " + change.reason : "")
    const now = ec.user.nowTimestamp
    const {plan, detail} = amendment
    const opIds = new Map()
    let sequence = operationsOf(run).reduce((max, op) => Math.max(max, Number(op.sequenceNum || 0)), 0)
    for (const row of detail.operationRows) {
        if (row.change === "cancelled")
            call("update#" + WORK, {workEffortId: row.workEffortId, statusId: "WeCancelled", statusId_changeReason: why})
        else if (row.change === "changed") {
            call("update#" + WORK, {
                workEffortId: row.workEffortId,
                workEffortName: row.workEffortName,
                workCenterFacilityId: row.workCenterFacilityId,
                operationSequenceNum: row.sequenceNum ?? null
            })
            opIds.set(row.routingOperationWorkEffortId, row.workEffortId)
        } else if (row.change === "added") {
            sequence += 1
            const child = call("create#" + WORK, {
                parentWorkEffortId: run.workEffortId,
                rootWorkEffortId: run.workEffortId,
                workEffortTypeEnumId: "WetTask",
                statusId: "WeApproved",
                ownerPartyId: run.ownerPartyId,
                facilityId: run.facilityId,
                workEffortName: row.workEffortName || "Operation " + sequence,
                sequenceNum: sequence,
                operationSequenceNum: row.sequenceNum ?? sequence * 10,
                routingOperationWorkEffortId: row.routingOperationWorkEffortId,
                workCenterFacilityId: row.workCenterFacilityId,
                estimatedStartDate: run.estimatedStartDate || null,
                estimatedCompletionDate: run.estimatedCompletionDate || null
            })
            opIds.set(row.routingOperationWorkEffortId, child.workEffortId)
        } else if (row.workEffortId) opIds.set(row.routingOperationWorkEffortId, row.workEffortId)
    }
    let seq = production()
        .linesOf(run.workEffortId)
        .reduce((max, line) => Math.max(max, Number(line.lineSeqNum || 0)), 0)
    for (const row of detail.lineRows) {
        if (row.change === "removed") call("delete#" + LINE, {productionRunLineId: row.productionRunLineId})
        else if (row.change === "changed" || row.change === "added") {
            const next = row.next
            const fields = Object.fromEntries(lineFields.map(name => [name, next[name] ?? null]))
            const stock = dec(next.stockQuantity)
            const factor = dec(next.conversionFactor ?? 1)
            fields.stockQuantity = stock
            fields.quantity = factor.isZero() ? stock : stock.divide(factor, 6, "HALF_UP")
            fields.operationWorkEffortId = next.routingOperationWorkEffortId
                ? opIds.get(next.routingOperationWorkEffortId) || null
                : null
            fields.productionChangeId = change.productionChangeId
            if (row.change === "changed")
                call("update#" + LINE, Object.assign({productionRunLineId: row.productionRunLineId}, fields))
            else {
                seq += 10
                call(
                    "create#" + LINE,
                    Object.assign(fields, {
                        workEffortId: run.workEffortId,
                        lineRoleEnumId: "PrlrMaterial",
                        lineSeqNum: seq,
                        substitutionRuleEnumId: next.substitutionRuleEnumId || null,
                        frozenDate: now
                    })
                )
            }
        }
    }
    production().writeProducts(run.workEffortId, production().linesOf(run.workEffortId))
    ec.context.putAll({productionMethodDate_changeReason: why})
    const revision = bumpRevision(run, {
        productionMethodDate: amendment.methodDate,
        productionMethodDate_changeReason: why,
        productionRoutingId: plan.routingWorkEffortId || run.productionRoutingId || null,
        productionMethodRefs: plan.refs
    })
    call("update#" + CHANGE, {
        productionChangeId: change.productionChangeId,
        statusId: "PchApplied",
        appliedDate: now,
        resultRevision: revision,
        planJson: JSON.stringify({
            lineRows: amendment.lineRows,
            operationRows: amendment.operationRows,
            findings: amendment.findings
        })
    })
    clearNotices("ProductionAmendment", change.productionChangeId)
    return revision
}
// The reviews an amendment still needs, and whether the user gives one of them.
function reviewsOf(change) {
    const method = !change.methodApprovedByUserId,
        supervisor = !change.supervisorApprovedByUserId
    return {
        method,
        supervisor,
        canGive: (method && access.has("METHOD_APPROVE")) || (supervisor && access.has("PRODUCTION_SUPERVISE"))
    }
}
// The user's reviews stamped on the amendment; applied once both are given, else the next reviewers told.
function review(run, change, amendment) {
    const fields = {productionChangeId: change.productionChangeId}
    if (!change.methodApprovedByUserId && access.has("METHOD_APPROVE"))
        Object.assign(fields, {methodApprovedByUserId: ec.user.userId, methodApprovedDate: ec.user.nowTimestamp})
    if (!change.supervisorApprovedByUserId && access.has("PRODUCTION_SUPERVISE"))
        Object.assign(fields, {supervisorApprovedByUserId: ec.user.userId, supervisorApprovedDate: ec.user.nowTimestamp})
    if (Object.keys(fields).length > 1) call("update#" + CHANGE, fields)
    const current = one(CHANGE, {productionChangeId: change.productionChangeId})
    const left = reviewsOf(current)
    if (!left.method && !left.supervisor) {
        const revision = applyAmendment(run, current, amendment)
        return {resultCode: "APPLIED", productionChangeId: change.productionChangeId, revision}
    }
    // the method approvers review first, then the supervisors
    const permission = left.method ? "METHOD_APPROVE" : "PRODUCTION_SUPERVISE"
    clearNotices("ProductionAmendment", change.productionChangeId)
    const sent = notify("ProductionAmendment", permission, run, change.productionChangeId, {
        methodDateText: when(current.methodDate),
        requestedByUserId: current.requestedByUserId,
        reason: current.reason
    })
    return {
        resultCode: Object.keys(fields).length > 1 ? "REVIEWED" : "REQUESTED",
        productionChangeId: change.productionChangeId,
        revision: revisionOf(run),
        waitingFor: left.method ? "method approval" : "supervisor approval",
        notified: !!sent
    }
}
function amend(p) {
    const action = str(p.action) || "request"
    const begun = posting.begin(
        p,
        "ProductionAmendment",
        ["PRODUCTION_PLAN", "METHOD_EDIT", "METHOD_APPROVE", "PRODUCTION_SUPERVISE"],
        [
            "workEffortId",
            "action",
            "expectedRevision",
            "methodDate",
            "reason",
            "reasonCode",
            "changeNoticeId",
            "productionChangeId",
            "previewKey",
            "refusalReason"
        ]
    )
    if (begun.previous) return begun.previous
    const userScope = posting.scope()
    const run = production().runOf(userScope, p.workEffortId, true)
    const settled = posting.settled(begun.op)
    if (settled) return settled
    let answer
    if (action === "request") {
        requireAny(["PRODUCTION_PLAN", "METHOD_EDIT"])
        requireRevision(run, p.expectedRevision)
        const why = reasonOf(run, p)
        if (pendingOf(run, "PchtAmendment").length)
            denied("CHANGE_PENDING", "An amendment of work order " + run.workEffortId + " waits for review already")
        const amendment = amendmentPlan(run, p.methodDate || null)
        if (!amendment.allowed) denied(amendment.reasonCode, amendment.message)
        if (!blank(p.previewKey) && p.previewKey !== amendment.previewKey)
            denied("PREVIEW_CHANGED", "The amendment changed since it was previewed; review it again")
        const change = call("create#" + CHANGE, {
            workEffortId: run.workEffortId,
            organizationPartyId: run.ownerPartyId,
            changeTypeEnumId: "PchtAmendment",
            statusId: "PchRequested",
            runRevision: revisionOf(run),
            previewKey: amendment.previewKey,
            methodDate: amendment.methodDate,
            changeNoticeId: str(p.changeNoticeId),
            planJson: JSON.stringify({
                lineRows: amendment.lineRows,
                operationRows: amendment.operationRows,
                findings: amendment.findings
            }),
            reasonCode: str(p.reasonCode),
            reason: why,
            requestedByUserId: ec.user.userId,
            requestedDate: ec.user.nowTimestamp
        })
        answer = review(run, one(CHANGE, {productionChangeId: change.productionChangeId}), amendment)
    } else if (action === "approve" || action === "refuse") {
        requireAny(["METHOD_APPROVE", "PRODUCTION_SUPERVISE"])
        const change = changeOf(run, p.productionChangeId, "PchtAmendment")
        if (action === "refuse") answer = refuseChange(run, change, p, "ProductionAmendment")
        else {
            if (!reviewsOf(change).canGive)
                denied("PERMISSION_DENIED", "Amendment " + change.productionChangeId + " waits for a review you do not give")
            // a decision revalidates: the run at the revision and the remap it was asked with
            if (revisionOf(run) !== Number(change.runRevision))
                denied("CHANGE_STALE", "Work order " + run.workEffortId + " changed since the amendment was asked; ask again")
            const amendment = amendmentPlan(run, change.methodDate)
            if (!amendment.allowed) denied(amendment.reasonCode, amendment.message)
            if (amendment.previewKey !== change.previewKey)
                denied("PREVIEW_CHANGED", "The work order's remaining work changed since the amendment was asked; ask again")
            answer = review(run, change, amendment)
        }
    } else denied("ACTION_INVALID", "Unknown amendment action " + action)
    return posting.complete(
        begun.op,
        run.ownerPartyId,
        CHANGE,
        answer.productionChangeId,
        Object.assign({workEffortId: run.workEffortId}, answer)
    )
}

// ===== get#ProductionChanges =====
function changeRow(change) {
    const plan = lib.json(change.planJson, {})
    const reviews = reviewsOf(change)
    const substitution = change.changeTypeEnumId === "PchtSubstitution"
    const line = change.productionRunLineId ? one(LINE, {productionRunLineId: change.productionRunLineId}) : null
    const canDecide =
        change.statusId === "PchRequested" &&
        (substitution ? access.has("PRODUCTION_SUPERVISE") : reviews.canGive || access.has("PRODUCTION_SUPERVISE"))
    const summary = substitution
        ? text(change.quantity) +
          " " +
          productName(line?.productId) +
          " by " +
          text(change.substituteQuantity) +
          " " +
          productName(change.substituteProductId)
        : "Method as of " +
          when(change.methodDate) +
          ": " +
          (plan.lineRows || [])
              .filter(row => row.change !== "unchanged" && row.change !== "kept")
              .map(
                  row =>
                      row.productName + " " + row.change + (row.change === "changed" ? " " + row.before + " to " + row.after : "")
              )
              .concat(
                  (plan.operationRows || [])
                      .filter(row => ["added", "changed", "cancelled"].includes(row.change))
                      .map(row => "operation " + (row.workEffortName || "") + " " + row.change)
              )
              .join("; ")
    return {
        productionChangeId: change.productionChangeId,
        changeTypeEnumId: change.changeTypeEnumId,
        changeTypeText: enumText(change.changeTypeEnumId),
        statusId: change.statusId,
        statusText: statusText(change.statusId),
        statusColor: {PchRequested: "warning", PchApplied: "positive", PchRefused: "negative"}[change.statusId] || "grey-8",
        summary,
        reason: change.reason || null,
        requestedByUserId: change.requestedByUserId || null,
        requestedDateText: when(change.requestedDate),
        methodApprovedByUserId: change.methodApprovedByUserId || null,
        supervisorApprovedByUserId: change.supervisorApprovedByUserId || null,
        reviewText: substitution
            ? change.supervisorApprovedByUserId
                ? "Approved by " + change.supervisorApprovedByUserId
                : "Waiting for a supervisor"
            : [
                  change.methodApprovedByUserId
                      ? "Method approved by " + change.methodApprovedByUserId
                      : "Waiting for a method approver",
                  change.supervisorApprovedByUserId
                      ? "supervisor approved by " + change.supervisorApprovedByUserId
                      : "waiting for a supervisor"
              ].join("; "),
        refusalReason: change.refusalReason || null,
        appliedDateText: when(change.appliedDate),
        changeNoticeId: change.changeNoticeId || null,
        findings: (plan.findings || []).map(row => row.message).join("; "),
        canDecide,
        canApprove: change.statusId === "PchRequested" && (substitution ? access.has("PRODUCTION_SUPERVISE") : reviews.canGive)
    }
}
function changes(p) {
    requireAny(["PRODUCTION_VIEW"])
    const run = production().runOf(posting.scope(), p.workEffortId)
    const changeRows = Array.from(find(CHANGE, {workEffortId: run.workEffortId}).orderBy("-requestedDate").limit(100).list()).map(
        changeRow
    )
    const open = openStatuses.includes(run.statusId)
    const strict = releasedStatuses.includes(run.statusId) && productionPolicy().runPolicy(run).strictRelease === "Y"
    const canSubstitute = open && !strict && (access.has("PRODUCTION_PLAN") || access.has("PRODUCTION_SUPERVISE"))
    const pendingLines = new Set(pendingOf(run, "PchtSubstitution").map(row => row.productionRunLineId))
    const substituteRows = production()
        .linesOf(run.workEffortId)
        .filter(line => line.lineRoleEnumId === "PrlrMaterial")
        .map(line => ({
            productionRunLineId: line.productionRunLineId,
            productId: line.productId,
            productName: productName(line.productId),
            remaining: text(production().materialTotals(line).remaining),
            stockUomId: line.stockUomId || null,
            pending: pendingLines.has(line.productionRunLineId),
            candidates: candidatesOf(line).map(product => ({
                value: product.productId,
                label: [product.pseudoId || product.productId, product.productName].filter(Boolean).join(" · "),
                amountUomId: product.amountUomId || null
            }))
        }))
        .filter(row => row.candidates.length && dec(row.remaining).compare(0) > 0)
    return {
        workEffortId: run.workEffortId,
        revision: revisionOf(run),
        statusId: run.statusId,
        strictRelease: strict,
        changeRows,
        substituteRows,
        canSubstitute,
        canAmend:
            releasedStatuses.includes(run.statusId) && !strict && (access.has("PRODUCTION_PLAN") || access.has("METHOD_EDIT")),
        amendmentPending: pendingOf(run, "PchtAmendment").length > 0,
        sourceRunId: run.productionSourceRunId || null,
        sourceText: run.productionSourceRunId ? enumText(run.productionSourceEnumId) + " " + run.productionSourceRunId : null
    }
}

// ===== split and backorder =====
const scale = (value, ratio) => dec(value).multiply(ratio).setScale(6, "HALF_UP")
const lineQuantity = (line, stock) => {
    const factor = dec(line.conversionFactor ?? 1)
    return factor.isZero() ? stock : stock.divide(factor, 6, "HALF_UP")
}
// What a split of quantity of the remaining output would move (design SplitWorkOrder Allocation and Disposition): the new
// run's target, each material line's share of it no more than what the line has left to issue (what was issued stays with
// the source as WIP), the by-products' share beyond what they received, the demand links moved newest first, and the
// source's operations and facts, which stay. Read only.
function splitPlan(run, p) {
    const mode = str(p.mode) || "split"
    if (!["split", "backorder"].includes(mode)) denied("MODE_INVALID", "Choose a split or a backorder")
    if (!openStatuses.includes(run.statusId))
        denied("RUN_CLOSED", "Work order " + run.workEffortId + " is " + statusText(run.statusId))
    const lines = production().linesOf(run.workEffortId)
    const output = outputOf(lines)
    if (!output) denied("LINES_REQUIRED", "The work order has no output line")
    const figures = quantities().outputFigures(run, output)
    const open = atLeastZero(figures.remaining.subtract(figures.pendingLoss))
    if (open.compare(0) <= 0) denied("NOTHING_REMAINING", "Nothing of work order " + run.workEffortId + " is left to produce")
    const quantity = blank(p.quantity) ? (mode === "backorder" ? open : zero()) : dec(p.quantity)
    if (quantity.compare(0) <= 0) denied("QUANTITY_INVALID", "Give a quantity above zero")
    if (quantity.compare(open) > 0)
        denied("QUANTITY_EXCEEDS_REMAINING", "Only " + text(open) + " of work order " + run.workEffortId + " is left to produce")
    const target = dec(output.stockQuantity)
    if (quantity.compare(target) >= 0)
        denied("SPLIT_ALL", "Moving the whole of work order " + run.workEffortId + " is a reschedule, not a split")
    const ratio = quantity.divide(target, 10, "HALF_UP")
    const findings = []
    const lineRows = []
    for (const line of lines) {
        if (line.lineRoleEnumId === "PrlrOutput") {
            lineRows.push({role: "output", line, moved: quantity, keep: target.subtract(quantity)})
            continue
        }
        const stock = dec(line.stockQuantity)
        let movable
        if (line.lineRoleEnumId === "PrlrMaterial") movable = production().materialTotals(line).remaining
        else
            movable = atLeastZero(
                stock.subtract(
                    sum(rows(RECEIPT, {productionOutputLineId: line.productionRunLineId}), row => row.quantityAccepted)
                )
            )
        const share = scale(stock, ratio)
        const moved = share.compare(movable) > 0 ? movable : share
        if (moved.compare(share) < 0 && line.lineRoleEnumId === "PrlrMaterial")
            findings.push({
                code: "MATERIAL_STAYS",
                message:
                    productName(line.productId) +
                    ": " +
                    text(share.subtract(moved)) +
                    " of its share is issued already; it stays with work order " +
                    run.workEffortId +
                    " as work in process"
            })
        lineRows.push({
            role: line.lineRoleEnumId === "PrlrMaterial" ? "material" : "byproduct",
            line,
            moved,
            keep: stock.subtract(moved)
        })
    }
    // the demand this run covers (P13's RequirementSupply), newest link first
    let left = quantity
    const supplyRows = []
    for (const link of rows(SUPPLY, {workEffortId: run.workEffortId})
        .filter(row => row.thruDate == null)
        .sort((a, b) => (lib.ms(b.fromDate) || 0) - (lib.ms(a.fromDate) || 0))) {
        if (left.compare(0) <= 0) break
        const have = dec(link.quantity)
        const moved = have.compare(left) > 0 ? left : have
        left = left.subtract(moved)
        supplyRows.push({link, moved, keep: have.subtract(moved)})
    }
    const facilityId = str(p.facilityId) || run.facilityId
    const operations = operationsOf(run)
    const completeCheck =
        mode === "backorder" && yes(p.complete) && run.statusId === "WeInProgress"
            ? quantities().completeCheck(
                  Object.assign({}, run),
                  {acceptMaterialVariance: p.acceptMaterialVariance, reason: p.reason, reasonCode: p.reasonCode},
                  lines.map(line => {
                      const row = lineRows.find(entry => entry.line.productionRunLineId === line.productionRunLineId)
                      return row ? Object.assign({}, line, {stockQuantity: row.keep}) : line
                  })
              )
            : null
    if (mode === "backorder" && yes(p.complete) && run.statusId !== "WeInProgress")
        findings.push({code: "COMPLETE_UNAVAILABLE", message: "Only a running work order is completed with its backorder"})
    const display = row => ({
        role: row.role,
        productionRunLineId: row.line.productionRunLineId,
        productId: row.line.productId,
        productName: productName(row.line.productId),
        current: text(row.line.stockQuantity),
        moved: text(row.moved),
        keep: text(row.keep),
        stockUomId: row.line.stockUomId || null
    })
    const previewKey = lib.hash({
        workEffortId: run.workEffortId,
        revision: revisionOf(run),
        mode,
        quantity: text(quantity),
        facilityId,
        lines: lineRows.map(row => [row.line.productionRunLineId, text(row.moved)]),
        supply: supplyRows.map(row => [row.link.requirementSupplyId, text(row.moved)])
    })
    return {
        mode,
        quantity,
        ratio,
        output,
        lineRows,
        supplyRows,
        facilityId,
        findings,
        completeCheck,
        previewKey,
        answer: {
            workEffortId: run.workEffortId,
            revision: revisionOf(run),
            mode,
            quantity: text(quantity),
            remaining: text(open),
            target: text(target),
            sourceTarget: text(target.subtract(quantity)),
            facilityId,
            methodDate: run.productionMethodDate || null,
            methodDateText: when(run.productionMethodDate),
            productBomId: run.productBomId || null,
            newStatusText: run.statusId === "WeInPlanning" ? "Draft" : "Released at the same method date",
            lineRows: lineRows.map(display),
            supplyRows: supplyRows.map(row => ({
                requirementSupplyId: row.link.requirementSupplyId,
                requirementId: row.link.requirementId,
                current: text(row.link.quantity),
                moved: text(row.moved),
                keep: text(row.keep)
            })),
            operationRows: operations.map(op => ({
                workEffortId: op.workEffortId,
                workEffortName: op.workEffortName || op.workEffortId,
                statusText: statusText(op.statusId),
                disposition:
                    op.statusId === "WeApproved"
                        ? "Stays with " +
                          run.workEffortId +
                          " for its " +
                          text(target.subtract(quantity)) +
                          "; the new run gets its own"
                        : "Stays with " + run.workEffortId + " with its facts"
            })),
            findings,
            completeCheck,
            previewKey
        }
    }
}
function previewSplit(p) {
    requireAny(["PRODUCTION_PLAN"])
    const run = production().runOf(posting.scope(), p.workEffortId)
    return splitPlan(run, p).answer
}
function split(p) {
    const begun = posting.begin(p, "ProductionSplit", "PRODUCTION_PLAN", [
        "workEffortId",
        "expectedRevision",
        "mode",
        "quantity",
        "facilityId",
        "estimatedCompletionDate",
        "reason",
        "reasonCode",
        "previewKey",
        "complete",
        "acceptMaterialVariance"
    ])
    if (begun.previous) return begun.previous
    const userScope = posting.scope()
    const run = production().runOf(userScope, p.workEffortId, true)
    const settled = posting.settled(begun.op)
    if (settled) return settled
    requireRevision(run, p.expectedRevision)
    const why = reasonOf(run, p)
    if (blank(p.previewKey)) denied("PREVIEW_REQUIRED", "Review the split's disposition first")
    const plan = splitPlan(run, p)
    if (p.previewKey !== plan.previewKey)
        denied("PREVIEW_CHANGED", "The work order changed since the split was previewed; review it again")
    const completing = plan.mode === "backorder" && yes(p.complete)
    if (completing) {
        requireAny(["PRODUCTION_SUPERVISE"])
        if (run.statusId !== "WeInProgress") denied("STATUS_INVALID", "Only a running work order is completed with its backorder")
    }
    if (plan.facilityId !== run.facilityId) {
        const facility = posting.facility(userScope, plan.facilityId)
        if (facility.ownerPartyId !== run.ownerPartyId)
            denied("FACILITY_OWNER", "Facility " + facility.facilityId + " is not " + run.ownerPartyId + "'s")
    }
    const origin = plan.mode === "backorder" ? "PsoBackorder" : "PsoSplit"
    // the new run: Mantle's run with no legacy products, at the source's method date and method (D15, R-SA-12)
    const created = call("mantle.work.ManufacturingServices.create#ProductionRun", {
        facilityId: plan.facilityId,
        ownerPartyId: run.ownerPartyId,
        workEffortName: (run.workEffortName || run.workEffortId) + (plan.mode === "backorder" ? " (backorder)" : " (split)"),
        estimatedStartDate: run.estimatedStartDate || null,
        estimatedCompletionDate: p.estimatedCompletionDate || run.estimatedCompletionDate || null,
        priority: run.priority ?? null,
        productionRevision: 1,
        productionMethodDate: run.productionMethodDate,
        productBomId: run.productBomId,
        productionRoutingId: run.productionRoutingId,
        productionMethodRefs: run.productionMethodRefs,
        demandOrderId: run.demandOrderId || null,
        demandOrderItemSeqId: run.demandOrderItemSeqId || null,
        demandRequirementId: run.demandRequirementId || null,
        productionSourceRunId: run.workEffortId,
        productionSourceEnumId: origin
    })
    const newId = created.workEffortId
    const copied = new Map()
    const copyFields = [
        "lineRoleEnumId",
        "lineSeqNum",
        "productId",
        "quantityUomId",
        "stockUomId",
        "conversionFactor",
        "uomConversionId",
        "scrapFactor",
        "substitutionRuleEnumId",
        "bomItemId",
        "productBomId",
        "bomPath",
        "routingOperationWorkEffortId",
        "manualLine",
        "sourceFacilityId",
        "instructionText",
        "productionChangeId"
    ]
    for (const row of plan.lineRows) {
        if (row.moved.compare(0) <= 0 && row.role !== "output") continue
        const fields = Object.fromEntries(copyFields.map(name => [name, row.line[name] ?? null]))
        const made = call(
            "create#" + LINE,
            Object.assign(fields, {workEffortId: newId, stockQuantity: row.moved, quantity: lineQuantity(row.line, row.moved)})
        )
        copied.set(row.line.productionRunLineId, made.productionRunLineId)
    }
    // a substitute keeps standing in for its original's copy
    for (const row of plan.lineRows)
        if (row.line.substituteOfLineId && copied.has(row.line.productionRunLineId))
            call("update#" + LINE, {
                productionRunLineId: copied.get(row.line.productionRunLineId),
                substituteOfLineId: copied.get(row.line.substituteOfLineId) || null
            })
    // the source keeps the rest
    for (const row of plan.lineRows)
        call("update#" + LINE, {
            productionRunLineId: row.line.productionRunLineId,
            stockQuantity: row.keep,
            quantity: lineQuantity(row.line, row.keep)
        })
    production().writeProducts(run.workEffortId, production().linesOf(run.workEffortId))
    production().writeProducts(newId, production().linesOf(newId))
    // the demand links: the moved quantity ends the link and starts one for each run (history stays)
    const now = ec.user.nowTimestamp
    for (const row of plan.supplyRows) {
        call("update#" + SUPPLY, {requirementSupplyId: row.link.requirementSupplyId, thruDate: now})
        const base = {
            requirementId: row.link.requirementId,
            supplyTypeEnumId: row.link.supplyTypeEnumId,
            quantityUomId: row.link.quantityUomId || null,
            planningSuggestionId: row.link.planningSuggestionId || null,
            operationKey: begun.op.clientKey,
            fromDate: now,
            createdByUserId: ec.user.userId
        }
        if (row.keep.compare(0) > 0)
            call("create#" + SUPPLY, Object.assign({}, base, {workEffortId: run.workEffortId, quantity: row.keep}))
        call("create#" + SUPPLY, Object.assign({}, base, {workEffortId: newId, quantity: row.moved}))
    }
    const revision = bumpRevision(run)
    // the source's target change, as change#ProductionQuantity records it
    const event = call("create#" + QEVENT, {
        workEffortId: run.workEffortId,
        productionRunLineId: plan.output.productionRunLineId,
        quantityEventTypeEnumId: "PqetTargetChange",
        quantity: zero().subtract(plan.quantity),
        quantityUomId: plan.output.stockUomId || null,
        previousTargetQuantity: dec(plan.output.stockQuantity),
        targetQuantity: dec(plan.output.stockQuantity).subtract(plan.quantity),
        runRevision: revision,
        eventDate: now,
        createdByUserId: ec.user.userId,
        reasonCode: str(p.reasonCode),
        reason: (plan.mode === "backorder" ? "Backorder " : "Split to ") + newId + (why ? ": " + why : "")
    })
    // a released source's new run is released at the same method date (no re-explosion), with its own operations
    let newStatusId = "WeInPlanning",
        newRevision = 1
    if (run.statusId !== "WeInPlanning") {
        const released = production().release(userScope, one(WORK, {workEffortId: newId}), {
            expectedRevision: 1,
            keepMethod: true
        })
        newStatusId = released.statusId
        newRevision = released.revision
    }
    let completed = false
    if (completing) {
        const fresh = one(WORK, {workEffortId: run.workEffortId})
        const gate = quantities().completeCheck(fresh, {acceptMaterialVariance: p.acceptMaterialVariance, reason: why})
        if (!gate.allowed) denied(gate.reasonCode, gate.message)
        quantities().complete(fresh, {acceptMaterialVariance: p.acceptMaterialVariance}, "Completed with backorder " + newId)
        completed = true
    }
    const after = one(WORK, {workEffortId: run.workEffortId})
    return posting.complete(begun.op, run.ownerPartyId, WORK, newId, {
        resultCode: plan.mode === "backorder" ? "BACKORDERED" : "SPLIT",
        workEffortId: run.workEffortId,
        newWorkEffortId: newId,
        quantity: text(plan.quantity),
        revision: revisionOf(after),
        statusId: after.statusId,
        newStatusId,
        newRevision,
        completed,
        productionQuantityEventId: event.productionQuantityEventId
    })
}

// ===== cancellation after postings =====
// The facts of a run and what a cancellation would do with them (design WorkOrderDetail: "any posted stock/time/cost creates
// a reviewed reversal or residual-close plan, never deletion"): a reversal returns each issue's unreturned quantity into its
// asset and cancels the run when nothing was received, lost or timed; otherwise a residual close finishes what is left as an
// approved loss, accepts the material variance (returning the unused issues first when asked) and completes the run, which
// the cost close then settles. Read only.
function cancellationPlan(run, p = {}) {
    if (!releasedStatuses.includes(run.statusId))
        return {
            allowed: false,
            reasonCode: run.statusId === "WeInPlanning" ? "NO_FACTS" : "STATUS_INVALID",
            message:
                run.statusId === "WeInPlanning"
                    ? "A draft has no postings; cancel it from the lifecycle"
                    : "Work order " + run.workEffortId + " is " + statusText(run.statusId)
        }
    const issuances = rows(ISSUANCE, {workEffortId: run.workEffortId}).filter(row => dec(row.quantity).compare(0) > 0)
    const returnedOf = row =>
        sum(rows(RECEIPT, {sourceAssetIssuanceId: row.assetIssuanceId}), receipt => receipt.quantityAccepted)
    const returnRows = issuances
        .map(row => ({
            assetIssuanceId: row.assetIssuanceId,
            assetId: row.assetId,
            productId: row.productId,
            productName: productName(row.productId),
            returnable: text(dec(row.quantity).subtract(returnedOf(row)))
        }))
        .filter(row => dec(row.returnable).compare(0) > 0)
    const outputReceipts = rows(RECEIPT, {workEffortId: run.workEffortId}).filter(row => row.productionOutputLineId)
    const operationIds = operationsOf(run).map(op => op.workEffortId)
    const timeEntries = find(TIME)
        .condition("workEffortId", "in", [run.workEffortId, ...operationIds])
        .count()
    const losses = rows(LOSS, {workEffortId: run.workEffortId})
    const facts = issuances.length + outputReceipts.length + timeEntries + losses.length
    if (!facts)
        return {
            allowed: false,
            reasonCode: "NO_FACTS",
            message: "Work order " + run.workEffortId + " has no postings; cancel it from the lifecycle"
        }
    const mode = !outputReceipts.length && !timeEntries && !losses.length ? "reversal" : "residual"
    const steps = []
    let completeCheck = null
    if (mode === "reversal") {
        for (const row of returnRows)
            steps.push(
                "Returns " + row.returnable + " " + row.productName + " of issue " + row.assetIssuanceId + " into its stock"
            )
        steps.push("Cancels the work order and its operations; the returns leave no work in process")
    } else {
        if (yes(p.returnUnused))
            for (const row of returnRows)
                steps.push("Returns " + row.returnable + " " + row.productName + " of issue " + row.assetIssuanceId)
        completeCheck = quantities().completeCheck(run, {
            finishRemainder: true,
            acceptMaterialVariance: true,
            reason: p.reason || "Close out",
            reasonCode: p.reasonCode
        })
        if (completeCheck.reasonCode === "NOTHING_REMAINING")
            completeCheck = quantities().completeCheck(run, {acceptMaterialVariance: true, reason: p.reason || "Close out"})
        steps.push(...(completeCheck.impact || []))
        if (!completeCheck.allowed)
            return {
                allowed: false,
                mode,
                reasonCode: completeCheck.reasonCode,
                message: completeCheck.message,
                steps,
                returnRows
            }
    }
    const previewKey = lib.hash({workEffortId: run.workEffortId, revision: revisionOf(run), mode, returnRows, steps})
    return {
        allowed: true,
        mode,
        modeText:
            mode === "reversal"
                ? "Reversal: every issue returned, then cancelled"
                : "Residual close: the rest written off, then completed",
        steps,
        returnRows,
        facts: {issuances: issuances.length, receipts: outputReceipts.length, timeEntries, losses: losses.length},
        previewKey
    }
}
function previewCancellation(p) {
    requireAny(["PRODUCTION_VIEW", "PRODUCTION_SUPERVISE"])
    const run = production().runOf(posting.scope(), p.workEffortId)
    return Object.assign({workEffortId: run.workEffortId, revision: revisionOf(run)}, cancellationPlan(run, p))
}
function cancelOrder(p) {
    const begun = posting.begin(p, "ProductionCancellation", "PRODUCTION_SUPERVISE", [
        "workEffortId",
        "expectedRevision",
        "previewKey",
        "reason",
        "reasonCode",
        "returnUnused"
    ])
    if (begun.previous) return begun.previous
    const userScope = posting.scope()
    const run = production().runOf(userScope, p.workEffortId, true)
    const settled = posting.settled(begun.op)
    if (settled) return settled
    requireRevision(run, p.expectedRevision)
    const why = reasonOf(run, p)
    const plan = cancellationPlan(run, p)
    if (!plan.allowed) denied(plan.reasonCode, plan.message)
    if (blank(p.previewKey)) denied("PREVIEW_REQUIRED", "Review the cancellation plan first")
    if (p.previewKey !== plan.previewKey)
        denied("PREVIEW_CHANGED", "The work order changed since the plan was previewed; review it again")
    const returns = plan.mode === "reversal" || yes(p.returnUnused) ? plan.returnRows : []
    if (returns.length) requireAny(["STOCK_ISSUE"])
    const returned = []
    for (const row of returns) {
        const out = call("mantle.work.ProductionServices.return#UnusedMaterial", {
            operationKey: begun.op.clientKey + "/return/" + row.assetIssuanceId,
            assetIssuanceId: row.assetIssuanceId,
            quantity: dec(row.returnable),
            reason: why
        })
        returned.push(out.result?.assetReceiptId || null)
    }
    let resultCode
    if (plan.mode === "reversal") {
        for (const op of operationsOf(run))
            call("update#" + WORK, {
                workEffortId: op.workEffortId,
                statusId: "WeCancelled",
                statusId_changeReason: "Work order cancelled"
            })
        ec.context.putAll({statusId_changeReason: why})
        bumpRevision(run, {statusId: "WeCancelled", statusId_changeReason: why, actualCompletionDate: ec.user.nowTimestamp})
        resultCode = "CANCELLED"
    } else {
        const fresh = one(WORK, {workEffortId: run.workEffortId})
        const finish = {finishRemainder: true, acceptMaterialVariance: true, reason: why, reasonCode: p.reasonCode}
        let gate = quantities().completeCheck(fresh, finish)
        if (gate.reasonCode === "NOTHING_REMAINING") {
            finish.finishRemainder = false
            gate = quantities().completeCheck(fresh, finish)
        }
        if (!gate.allowed) denied(gate.reasonCode, gate.message)
        quantities().complete(fresh, finish, "Closed out: " + why)
        resultCode = "CLOSED_OUT"
    }
    const after = one(WORK, {workEffortId: run.workEffortId})
    return posting.complete(begun.op, run.ownerPartyId, WORK, run.workEffortId, {
        resultCode,
        workEffortId: run.workEffortId,
        mode: plan.mode,
        statusId: after.statusId,
        revision: revisionOf(after),
        returnReceiptIds: returned
    })
}

// ===== clone =====
function clone(p) {
    const begun = posting.begin(p, "ProductionClone", "PRODUCTION_PLAN", [
        "workEffortId",
        "quantity",
        "facilityId",
        "estimatedCompletionDate"
    ])
    if (begun.previous) return begun.previous
    const userScope = posting.scope()
    const run = production().runOf(userScope, p.workEffortId)
    const output = outputOf(production().linesOf(run.workEffortId))
    if (!output) denied("LINES_REQUIRED", "Work order " + run.workEffortId + " has no output line")
    const created = call("mantle.work.ProductionServices.create#ProductionOrder", {
        operationKey: begun.op.clientKey + "/create",
        organizationPartyId: run.ownerPartyId,
        productId: output.productId,
        quantity: blank(p.quantity) ? dec(output.quantity) : dec(p.quantity),
        quantityUomId: output.quantityUomId || null,
        facilityId: str(p.facilityId) || run.facilityId,
        estimatedCompletionDate: p.estimatedCompletionDate || null,
        productBomId: run.productBomId || null,
        routingWorkEffortId: run.productionRoutingId || null,
        workEffortName: (run.workEffortName || run.workEffortId) + " (copy)"
    })
    call("update#" + WORK, {
        workEffortId: created.workEffortId,
        productionSourceRunId: run.workEffortId,
        productionSourceEnumId: "PsoClone"
    })
    return posting.complete(begun.op, run.ownerPartyId, WORK, created.workEffortId, {
        resultCode: "CLONED",
        workEffortId: created.workEffortId,
        sourceWorkEffortId: run.workEffortId,
        revision: 1
    })
}

const operations = {
    changes,
    substitute,
    previewAmendment,
    amend,
    previewSplit,
    split,
    previewCancellation,
    cancel: cancelOrder,
    clone
}
;({
    execute: (op, parameters) => {
        if (!operations[op]) throw new Error("Unknown production change operation " + op)
        return operations[op](parameters)
    }
})
