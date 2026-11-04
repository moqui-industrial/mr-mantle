// A production run's quantities, by-products and loss (design-manufacturing Quantities, ByProducts, ScrapLoss and §12.2; §12
// M2, M4, M6 and M8; impl-manufacturing P7): what mantle.work.ProductionServices' quantity entry points add to Production.js's
// run and stock guards and ProductionOrders.js's lifecycle.
// - get#ProductionQuantities: each output line's target, accepted good, produced-held, process loss, scrap, rework and what
//   is left, each material line's required, issued, returned, scrapped and remaining quantity, the quantity events and losses,
//   the reconciliation the completion needs and, with Products' cost read, the by-products' allocation estimate.
// - store#ProductionOutput: a draft run's secondary outputs and by-products.
// - record#ProductionQuantity: good and produced-held output in one orchestration with its receipt (receive#ProductionOutput),
//   process loss, scrap and rework, each its quantity event; output beyond the target and the policy's overproduction
//   tolerance waits for a supervisor.
// - change#ProductionQuantity: a new target as a delta event that rewrites the run's lines and their WeptConsume/WeptProduce
//   rows, never below what the run has already accounted for (never set#ProducedProductQuantity, F8).
// - record#ProductionLoss by its three paths (R-MFG-20): issued components scrapped in WIP (a scrap cost event, no stock
//   movement), received or held output of an open run issued back to it (so the loss reaches production variance at the cost
//   close), and process loss (a quantity only); and rework. A loss above its reason's threshold waits for a supervisor.
// - approve#ProductionException: a supervisor's decision on a pending loss or an overproduction request (F40, decided on the
//   record).
// - find#ProductionLosses: the losses of the user's organizations.
// - complete in transition#ProductionOrder (completeCheck, complete): target = accepted good + produced-held + remaining +
//   terminal loss for each output line (§12.2), with nothing held, no loss waiting, no operation running and the material
//   issued (or its variance accepted); Finish remainder records what is left as an approved loss first. With the policy's
//   completeOnFinalReceipt flag the final output receipt completes the run in the same transaction (afterReceipt).
// - get#ProductionLabels: finished, secondary and WIP labels; a held output's label says it is not accepted.
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const posting = ec.resource.script("component://mr-mantle/service/mantle/shipment/StockPosting.js")
const facilityScope = ec.resource.script("component://mr-mantle/service/mantle/facility/FacilityScope.js")
const {find, one, rows, call, denied, access} = lib

const WORK = "mantle.work.effort.WorkEffort",
    LINE = "mantle.work.production.ProductionRunLine",
    QEVENT = "mantle.work.production.ProductionQuantityEvent",
    LOSS = "mantle.work.production.ProductionLoss",
    COST_EVENT = "mantle.work.production.ProductionCostEvent",
    ISSUANCE = "mantle.product.issuance.AssetIssuance",
    RECEIPT = "mantle.product.receipt.AssetReceipt",
    ASSET = "mantle.product.asset.Asset",
    PRODUCT = "mantle.product.Product",
    FACILITY = "mantle.facility.Facility",
    STANDARD = "mantle.product.cost.ProductStandardCost",
    STATUS = "moqui.basic.StatusItem",
    ENUM = "moqui.basic.Enumeration"
const releasedStatuses = ["WeApproved", "WeInProgress"]
const openStatuses = ["WeApproved", "WeInProgress", "WeOnHold"]
const heldStatuses = ["AstQuarantine", "AstOnHold", "AstDefective"]
const outputRoles = ["PrlrOutput", "PrlrByproduct"]
// each loss type: its reason category, whether it is in the output line's units, and its quantity event
const lossTypes = {
    PltComponentScrap: {category: "PrcScrap", output: false, eventType: null},
    PltOutputScrap: {category: "PrcScrap", output: true, eventType: "PqetScrap"},
    PltProcessLoss: {category: "PrcProcessLoss", output: true, eventType: "PqetProcessLoss"},
    PltRework: {category: "PrcRework", output: true, eventType: "PqetRework"}
}
// the cost readers of the frozen estimate (ProductionCosts.js, CostPolicy)
const estimateReaders = [
    "PRODUCT_COST_VIEW",
    "PRODUCT_COST_ESTIMATE",
    "PRODUCT_COST_APPROVE",
    "ACCOUNTING_VIEW",
    "ACCOUNTING_GL_POST"
]

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
const payables = () => ec.resource.script("component://mr-mantle/service/mantle/account/Payables.js")
const statusText = statusId => (statusId ? one(STATUS, {statusId})?.description || statusId : "")
const enumText = enumId => (enumId ? one(ENUM, {enumId})?.description || enumId : "")
const productName = productId => (productId ? one(PRODUCT, {productId})?.productName || productId : "")
const sum = (list, value) => list.reduce((total, row) => total.add(dec(value(row))), zero())

function requireAny(permissions) {
    if (!permissions.some(access.has)) denied("PERMISSION_DENIED", permissions.join(" or ") + " is required")
}
const revisionOf = run => Number(run.productionRevision || 0)
function requireRevision(run, expectedRevision, required = true) {
    if (blank(expectedRevision)) {
        if (required) denied("REVISION_REQUIRED", "Review work order " + run.workEffortId + " and give its revision")
        return
    }
    if (Number(expectedRevision) !== revisionOf(run))
        denied("REVISION_CHANGED", "Work order " + run.workEffortId + " changed; reload and review it")
}
function quantityOf(value, label) {
    if (blank(value)) return zero()
    const quantity = dec(value)
    if (quantity.compare(0) < 0) denied("QUANTITY_INVALID", label + " cannot be below zero")
    return quantity
}
// an operation child of the run, or none
function operationOf(run, operationWorkEffortId) {
    if (blank(operationWorkEffortId)) return null
    const op = one(WORK, {workEffortId: operationWorkEffortId})
    if (!op || op.parentWorkEffortId !== run.workEffortId)
        denied(
            "OPERATION_INVALID",
            "Operation " + operationWorkEffortId + " is not an operation of work order " + run.workEffortId
        )
    return op.workEffortId
}
// A line of the run in one of the roles (locked when asked); a line of another run is refused.
function lineOf(run, productionRunLineId, roles, lock = false) {
    const line = blank(productionRunLineId) ? null : find(LINE, {productionRunLineId}).forUpdate(lock).one()
    if (!line || line.workEffortId !== run.workEffortId || !roles.includes(line.lineRoleEnumId))
        denied("LINE_INVALID", "Line " + (productionRunLineId || "") + " is not a line of work order " + run.workEffortId)
    return line
}
const primaryOf = lines => lines.find(line => line.lineRoleEnumId === "PrlrOutput") || null
// The output line named (an output or a by-product), else the run's primary output.
function outputLine(run, productionRunLineId, lock = false) {
    if (!blank(productionRunLineId)) return lineOf(run, productionRunLineId, outputRoles, lock)
    const primary = primaryOf(production().linesOf(run.workEffortId))
    if (!primary) denied("LINE_REQUIRED", "Work order " + run.workEffortId + " has no output line")
    return lineOf(run, primary.productionRunLineId, outputRoles, lock)
}

// ===== the figures =====
const lossesOf = workEffortId => rows(LOSS, {workEffortId})
const approved = loss => loss.statusId === "PlsApproved"
// An output line's figures (§12.2): accepted good and produced-held from its receipts (each receipt's asset by its status
// now, less what was scrapped back to the run from it), the approved process loss, scrap and rework, and what is left of the
// target; the overproduction tolerance of the run's policy and a supervisor's approval beyond it; and how much the line may
// still take (receivable).
function outputFigures(run, line, losses = lossesOf(run.workEffortId), policy = null) {
    const lineLosses = losses.filter(loss => loss.productionRunLineId === line.productionRunLineId)
    const receipts = rows(RECEIPT, {productionOutputLineId: line.productionRunLineId})
    const received = sum(receipts, row => row.quantityAccepted)
    let good = zero(),
        held = zero()
    const byAsset = new Map()
    // a receipt with an inspection is held by what its inspections still hold (a disposition's Release, Use as is and Scrap
    // take it; a re-inspection takes the earlier one's), so a part released from a held asset counts good at once
    // (impl-manufacturing P8); a receipt with none by its asset's status now
    const inspected = receipts.length
        ? Array.from(
              find("mantle.product.quality.QualityInspection")
                  .condition(
                      "assetReceiptId",
                      "in",
                      receipts.map(row => row.assetReceiptId)
                  )
                  .condition("statusId", "not-equals", "QiCancelled")
                  .list()
          )
        : []
    for (const receipt of receipts) {
        const own = inspected.filter(row => row.assetReceiptId === receipt.assetReceiptId)
        if (!own.length) {
            byAsset.set(receipt.assetId, dec(byAsset.get(receipt.assetId)).add(dec(receipt.quantityAccepted)))
            continue
        }
        const scrapped = sum(
            lineLosses.filter(
                loss => approved(loss) && loss.lossTypeEnumId === "PltOutputScrap" && loss.assetId === receipt.assetId
            ),
            loss => loss.quantity
        )
        const left = atLeastZero(dec(receipt.quantityAccepted).subtract(scrapped))
        const stillHeld = sum(own, row => row.heldQuantity)
        const heldHere = stillHeld.compare(left) > 0 ? left : stillHeld
        held = held.add(heldHere)
        good = good.add(left.subtract(heldHere))
    }
    for (const [assetId, quantity] of byAsset) {
        const scrapped = sum(
            lineLosses.filter(loss => approved(loss) && loss.lossTypeEnumId === "PltOutputScrap" && loss.assetId === assetId),
            loss => loss.quantity
        )
        const left = atLeastZero(quantity.subtract(scrapped))
        const asset = assetId ? one(ASSET, {assetId}) : null
        if (asset && heldStatuses.includes(asset.statusId)) held = held.add(left)
        else good = good.add(left)
    }
    const ofType = type =>
        sum(
            lineLosses.filter(loss => approved(loss) && loss.lossTypeEnumId === type),
            loss => loss.quantity
        )
    const processLoss = ofType("PltProcessLoss"),
        scrap = ofType("PltOutputScrap"),
        rework = ofType("PltRework")
    const pendingLoss = sum(
        lineLosses.filter(loss => loss.statusId === "PlsPending"),
        loss => loss.quantity
    )
    const target = dec(line.stockQuantity)
    const accounted = good.add(held).add(processLoss).add(scrap).add(rework)
    const percent = dec((policy || productionPolicy().runPolicy(run)).overProducePercent)
    const tolerance = percent.compare(0) > 0 ? target.multiply(percent).divide(toDecimal(100), 6, "HALF_UP") : zero()
    const approvedOver = dec(line.overApprovedQuantity)
    return {
        target,
        received,
        good,
        held,
        processLoss,
        scrap,
        rework,
        pendingLoss,
        accounted,
        remaining: atLeastZero(target.subtract(accounted)),
        over: atLeastZero(accounted.subtract(target)),
        tolerance,
        approvedOver,
        receivable: target.add(tolerance).add(approvedOver).subtract(accounted).subtract(pendingLoss)
    }
}
// What an output line may still take now (receive#ProductionOutput's limit): its target, the tolerance and a supervisor's
// approval, less what it accounts for and the losses waiting for approval.
function receivableLeft(run, line) {
    return outputFigures(run, line).receivable
}
// A material line's figures: required, issued, returned, net issued, scrapped in WIP (approved and waiting) and remaining.
function materialFigures(line, losses) {
    const totals = production().materialTotals(line)
    const lineLosses = losses.filter(
        loss => loss.productionRunLineId === line.productionRunLineId && loss.lossTypeEnumId === "PltComponentScrap"
    )
    return {
        required: dec(line.stockQuantity),
        issued: totals.issued,
        returned: totals.returned,
        net: totals.net,
        remaining: totals.remaining,
        scrapped: sum(lineLosses.filter(approved), loss => loss.quantity),
        scrapPending: sum(
            lineLosses.filter(loss => loss.statusId === "PlsPending"),
            loss => loss.quantity
        )
    }
}

// ===== the reconciliation and complete =====
// Whether the run reconciles for its completion (§12.2, design WorkOrderDetail Complete), as a finding: each output line
// accounted for (target = good + held + remaining + terminal loss, nothing left, nothing held awaiting disposition), no loss
// waiting for a supervisor, no operation running or held, and each material line issued, unless the supervisor accepts the
// variance. finishRemainder treats what is left as an approved loss to record first. Read only.
function completeCheck(run, p = {}, lines = production().linesOf(run.workEffortId)) {
    const losses = lossesOf(run.workEffortId)
    const policy = productionPolicy().runPolicy(run)
    const finish = yes(p.finishRemainder)
    const outputs = lines.filter(line => line.lineRoleEnumId === "PrlrOutput")
    if (!outputs.length) return {allowed: false, reasonCode: "LINES_REQUIRED", message: "The work order has no output line"}
    // no final inspection pending or failed, each in-process gate passed (impl-manufacturing P8, ProductionQuality.js)
    const qualityBlock = ec.resource.script("component://mr-mantle/service/mantle/work/ProductionQuality.js").completeGate(run)
    if (qualityBlock) return qualityBlock
    const impact = []
    const pending = losses.filter(loss => loss.statusId === "PlsPending")
    if (pending.length)
        return {
            allowed: false,
            reasonCode: "LOSS_PENDING",
            message: pending.length + " loss" + (pending.length === 1 ? " waits" : "es wait") + " for a supervisor's approval"
        }
    let remainingTotal = zero()
    for (const line of outputs) {
        const figures = outputFigures(run, line, losses, policy)
        if (figures.held.compare(0) > 0)
            return {
                allowed: false,
                reasonCode: "OUTPUT_HELD",
                message:
                    text(figures.held) +
                    " of " +
                    productName(line.productId) +
                    " is held awaiting disposition; it is accepted, reworked or scrapped before the work order completes"
            }
        if (figures.remaining.compare(0) > 0) {
            if (!finish)
                return {
                    allowed: false,
                    reasonCode: "QUANTITIES_UNRECONCILED",
                    finishRemainderOffered: true,
                    remaining: text(figures.remaining),
                    message:
                        text(figures.remaining) +
                        " of " +
                        productName(line.productId) +
                        " are still to produce (target " +
                        text(figures.target) +
                        ", good " +
                        text(figures.good) +
                        ", loss " +
                        text(figures.processLoss.add(figures.scrap).add(figures.rework)) +
                        "); receive them, record their loss, or finish the remainder with an approved loss"
                }
            remainingTotal = remainingTotal.add(figures.remaining)
            impact.push(
                "Records the remaining " + text(figures.remaining) + " of " + productName(line.productId) + " as an approved loss"
            )
        }
    }
    if (finish && remainingTotal.compare(0) <= 0)
        return {allowed: false, reasonCode: "NOTHING_REMAINING", message: "Nothing is left to finish as a loss"}
    if (finish && blank(p.reason) && blank(p.reasonCode))
        return {allowed: false, reasonCode: "REASON_REQUIRED", message: "Give the reason for the loss of the remainder"}
    const operations = rows(WORK, {parentWorkEffortId: run.workEffortId}).filter(op => op.statusId !== "WeCancelled")
    const running = operations.filter(op => ["WeInProgress", "WeOnHold"].includes(op.statusId))
    if (running.length)
        return {
            allowed: false,
            reasonCode: "OPERATION_OPEN",
            message:
                "Operation " + (running[0].workEffortName || running[0].workEffortId) + " is " + statusText(running[0].statusId)
        }
    const unissued = lines
        .filter(line => line.lineRoleEnumId === "PrlrMaterial")
        .map(line => ({line, figures: materialFigures(line, losses)}))
        .filter(row => row.figures.remaining.compare(0) > 0)
    if (unissued.length && !yes(p.acceptMaterialVariance))
        return {
            allowed: false,
            reasonCode: "MATERIAL_UNISSUED",
            materialVarianceOffered: true,
            message:
                unissued
                    .map(row => productName(row.line.productId) + " has " + text(row.figures.remaining) + " not issued")
                    .join("; ") + "; issue it, or accept the material variance"
        }
    if (unissued.length)
        impact.push(
            "Accepts the material not issued as a variance: " + unissued.map(row => productName(row.line.productId)).join(", ")
        )
    // an operation not completed on the shop floor (impl-manufacturing P10, F95) is closed with the run only when the
    // supervisor accepts it, as with the material variance; it then has no time or quantity of its own
    const open = operations.filter(op => op.statusId !== "WeComplete")
    if (open.length && !yes(p.closeUnreportedOperations))
        return {
            allowed: false,
            reasonCode: "OPERATION_UNREPORTED",
            unreportedOperationsOffered: true,
            message:
                "Operation " +
                open.map(op => op.workEffortName || op.workEffortId).join(", ") +
                (open.length === 1 ? " was" : " were") +
                " not completed on the shop floor; complete " +
                (open.length === 1 ? "it" : "them") +
                ", or close the unreported operations with the work order"
        }
    if (open.length)
        impact.push(
            "Closes the " +
                open.length +
                " operation" +
                (open.length === 1 ? "" : "s") +
                " not reported, with no time or quantity"
        )
    const byproducts = lines.filter(line => line.lineRoleEnumId === "PrlrByproduct")
    if (byproducts.length) impact.push("By-products take their share of the run's cost at the cost close")
    impact.unshift("Completes the work order; Accounting's cost close closes it")
    return {allowed: true, impact}
}
// Complete the run (transition#ProductionOrder complete, or the final receipt under completeOnFinalReceipt): the remainder's
// approved loss when asked, the operations not reported completed with it, the run WeComplete at its next revision.
function complete(run, p, why) {
    const lines = production().linesOf(run.workEffortId)
    if (yes(p.finishRemainder)) {
        const losses = lossesOf(run.workEffortId)
        for (const line of lines.filter(row => row.lineRoleEnumId === "PrlrOutput")) {
            const left = outputFigures(run, line, losses).remaining
            if (left.compare(0) <= 0) continue
            const loss = call("create#" + LOSS, {
                organizationPartyId: run.ownerPartyId,
                workEffortId: run.workEffortId,
                productionRunLineId: line.productionRunLineId,
                lossTypeEnumId: "PltProcessLoss",
                productId: line.productId,
                quantity: left,
                quantityUomId: line.stockUomId || null,
                reasonCode: str(p.reasonCode),
                reasonName: why || "Finish remainder",
                reasonCategoryEnumId: "PrcProcessLoss",
                comments: "Finish remainder with approved loss",
                statusId: "PlsApproved",
                requestedByUserId: ec.user.userId,
                approvedByUserId: ec.user.userId,
                approvedDate: ec.user.nowTimestamp,
                lossDate: ec.user.nowTimestamp,
                createdByUserId: ec.user.userId
            })
            quantityEvent(run, line, "PqetProcessLoss", left, {
                productionLossId: loss.productionLossId,
                reasonCode: p.reasonCode,
                reason: why
            })
        }
    }
    for (const op of rows(WORK, {parentWorkEffortId: run.workEffortId}).filter(
        row => !["WeComplete", "WeCancelled"].includes(row.statusId)
    ))
        call("update#" + WORK, {
            workEffortId: op.workEffortId,
            statusId: "WeComplete",
            statusId_changeReason: "Completed with work order " + run.workEffortId,
            actualCompletionDate: ec.user.nowTimestamp
        })
    const current = one(WORK, {workEffortId: run.workEffortId})
    const reason = why || null
    if (reason) ec.context.putAll({statusId_changeReason: reason})
    call("update#" + WORK, {
        workEffortId: run.workEffortId,
        statusId: "WeComplete",
        statusId_changeReason: reason,
        actualCompletionDate: ec.user.nowTimestamp,
        productionRevision: revisionOf(current) + 1
    })
}
// After an output receipt (receive#ProductionOutput): under the run's completeOnFinalReceipt flag (off by default), a
// running run that now reconciles completes in the same transaction with the same evidence (§4). Answers whether it did,
// and why not when the flag is on.
function afterReceipt(runId) {
    const run = one(WORK, {workEffortId: runId})
    if (!run || productionPolicy().runPolicy(run).completeOnFinalReceipt !== "Y") return {completed: false, blockCode: null}
    if (run.statusId !== "WeInProgress") return {completed: false, blockCode: "STATUS_INVALID"}
    // the opt-in flag is the acceptance of closing the operations not reported with the final receipt
    const gate = completeCheck(run, {closeUnreportedOperations: true})
    if (!gate.allowed) return {completed: false, blockCode: gate.reasonCode}
    complete(run, {}, "Completed on its final output receipt")
    return {completed: true, blockCode: null}
}

// ===== the quantity events =====
function quantityEvent(run, line, type, quantity, fields = {}) {
    return call(
        "create#" + QEVENT,
        Object.assign(
            {
                workEffortId: run.workEffortId,
                productionRunLineId: line.productionRunLineId,
                quantityEventTypeEnumId: type,
                quantity,
                quantityUomId: line.stockUomId || null,
                runRevision: revisionOf(one(WORK, {workEffortId: run.workEffortId})),
                eventDate: ec.user.nowTimestamp,
                createdByUserId: ec.user.userId || null
            },
            fields,
            {reasonCode: str(fields.reasonCode), reason: str(fields.reason)}
        )
    ).productionQuantityEventId
}
function notifySupervisors(topic, run, recordEntityName, recordId, message) {
    try {
        return payables().execute("notify", {
            topic,
            permission: "PRODUCTION_SUPERVISE",
            organizationPartyId: run.ownerPartyId,
            recordEntityName,
            recordId,
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
function clearNotices(topic, recordEntityName, recordId) {
    try {
        payables().execute("clearNotices", {topic, recordEntityName, recordId})
    } catch (error) {
        ec.logger.error("Notices " + topic + " of " + recordId + " were not cleared: " + error.message)
    }
}

// ===== the losses =====
// The reason of a loss: an active production reason of the run's owner in the loss type's category, else a reason's text.
function lossReason(run, type, p) {
    const reasonText = str(p.reason)
    if (!blank(p.reasonCode)) {
        const reason = productionPolicy().activeReason(run.ownerPartyId, p.reasonCode)
        if (!reason) denied("REASON_INVALID", "Reason " + p.reasonCode + " is not an active production reason")
        if (reason.reasonCategoryEnumId && reason.reasonCategoryEnumId !== lossTypes[type].category)
            denied(
                "REASON_INVALID",
                "Reason " +
                    p.reasonCode +
                    " is a " +
                    enumText(reason.reasonCategoryEnumId) +
                    " reason, not " +
                    enumText(lossTypes[type].category)
            )
        return {
            reasonCode: reason.reasonCode,
            reasonName: [reason.reasonName || reason.reasonCode, reasonText].filter(Boolean).join(": "),
            category: reason.reasonCategoryEnumId || lossTypes[type].category,
            threshold: reason.approvalThreshold
        }
    }
    if (!reasonText) denied("REASON_REQUIRED", "Give the reason for the " + enumText(type).toLowerCase())
    return {reasonCode: null, reasonName: reasonText, category: lossTypes[type].category, threshold: null}
}
// What a loss is of, by its path, checked before anything is written: the line, the asset (an output asset of this run, in
// the user's facilities and on hand; for a component, an asset issued to the line) and the quantity it may be.
function lossPlan(userScope, run, p) {
    const type = str(p.lossTypeEnumId)
    if (!type || !lossTypes[type])
        denied("LOSS_TYPE_INVALID", "Choose a loss type: component scrap, output scrap, process loss or rework")
    const quantity = blank(p.quantity) ? zero() : dec(p.quantity)
    if (quantity.compare(0) <= 0) denied("QUANTITY_INVALID", "Give a quantity above zero")
    const operationWorkEffortId = operationOf(run, p.operationWorkEffortId)
    const losses = lossesOf(run.workEffortId)
    let line,
        asset = null
    if (type === "PltComponentScrap") {
        line = lineOf(run, p.productionRunLineId, ["PrlrMaterial"], true)
        const figures = materialFigures(line, losses)
        const scrappable = figures.net.subtract(figures.scrapped).subtract(figures.scrapPending)
        if (quantity.compare(scrappable) > 0)
            denied(
                "QUANTITY_EXCEEDS_ISSUED",
                "Only " +
                    text(atLeastZero(scrappable)) +
                    " of line " +
                    line.productionRunLineId +
                    "'s issued material is left to scrap"
            )
        if (!blank(p.assetId)) {
            const issued = rows(ISSUANCE, {productionMaterialLineId: line.productionRunLineId, assetId: p.assetId})
            if (!issued.length)
                denied("ASSET_INVALID", "Asset " + p.assetId + " was not issued to line " + line.productionRunLineId)
            asset = one(ASSET, {assetId: p.assetId})
        }
    } else if (type === "PltOutputScrap" && !blank(p.assetId)) {
        // the output stock of this run, still in the user's facilities and on hand, scrapped back into the run
        const receipt = rows(RECEIPT, {assetId: p.assetId, workEffortId: run.workEffortId}).find(
            row => row.productionOutputLineId
        )
        if (!receipt) denied("ASSET_INVALID", "Asset " + p.assetId + " is not output of work order " + run.workEffortId)
        requireAny(["STOCK_ISSUE"])
        asset = posting.stock(userScope, p.assetId, quantity)
        line = lineOf(run, receipt.productionOutputLineId, outputRoles, true)
        if (asset.ownerPartyId !== run.ownerPartyId)
            denied("OWNER_MISMATCH", "Asset " + asset.assetId + " is not owned by the run's owner " + run.ownerPartyId)
        if (quantity.compare(dec(asset.availableToPromiseTotal)) > 0)
            denied(
                "QUANTITY_EXCEEDS_AVAILABLE",
                "Only " + text(asset.availableToPromiseTotal) + " of asset " + asset.assetId + " is free"
            )
    } else {
        line = outputLine(run, p.productionRunLineId, true)
        if (line.lineRoleEnumId !== "PrlrOutput" && type !== "PltOutputScrap")
            denied("LINE_INVALID", "A " + enumText(type).toLowerCase() + " is recorded on an output line")
    }
    const reason = lossReason(run, type, p)
    // above the reason's threshold (a percent of the line's quantity) a loss waits for a supervisor, unless one records it
    const base = dec(line.stockQuantity)
    const percent = base.compare(0) > 0 ? quantity.multiply(toDecimal(100)).divide(base, 6, "HALF_UP") : zero()
    const exceptional = reason.threshold != null && percent.compare(dec(reason.threshold)) > 0
    const supervisor = access.has("PRODUCTION_SUPERVISE")
    return {
        type,
        quantity,
        operationWorkEffortId: operationWorkEffortId || line.operationWorkEffortId || null,
        line,
        asset,
        reason,
        pending: exceptional && !supervisor,
        approvedBySupervisor: exceptional && supervisor
    }
}
// A loss written from its plan: pending (a supervisor is notified) or applied now.
function writeLoss(userScope, run, plan, p) {
    const asset = plan.asset
    const loss = call("create#" + LOSS, {
        organizationPartyId: run.ownerPartyId,
        workEffortId: run.workEffortId,
        operationWorkEffortId: plan.operationWorkEffortId,
        productionRunLineId: plan.line.productionRunLineId,
        lossTypeEnumId: plan.type,
        productId: asset?.productId || plan.line.productId,
        assetId: asset?.assetId || null,
        lotId: asset?.lotId || null,
        quantity: plan.quantity,
        quantityUomId: plan.line.stockUomId || null,
        fromHeld: asset ? (heldStatuses.includes(asset.statusId) ? "Y" : "N") : null,
        reasonCode: plan.reason.reasonCode,
        reasonName: plan.reason.reasonName,
        reasonCategoryEnumId: plan.reason.category,
        comments: str(p.comments),
        statusId: plan.pending ? "PlsPending" : "PlsApproved",
        requestedByUserId: ec.user.userId,
        approvedByUserId: plan.approvedBySupervisor ? ec.user.userId : null,
        approvedDate: plan.approvedBySupervisor ? ec.user.nowTimestamp : null,
        reworkWorkEffortId: plan.type === "PltRework" ? str(p.reworkWorkEffortId) : null,
        lossDate: ec.user.nowTimestamp,
        createdByUserId: ec.user.userId
    })
    const row = one(LOSS, {productionLossId: loss.productionLossId})
    if (plan.pending) {
        notifySupervisors("ProductionLossApproval", run, LOSS, row.productionLossId, {
            productionLossId: row.productionLossId,
            quantity: text(plan.quantity),
            productName: productName(row.productId),
            lossType: enumText(plan.type),
            reasonName: plan.reason.reasonName
        })
        return {loss: row, effects: {}}
    }
    return {loss: row, effects: applyLoss(userScope, run, row)}
}
// A loss's effect by its path (R-MFG-20): a component scrap's cost event (no stock moves: the stock is already in WIP), an
// output asset issued back to the run (its issuance's hook posts it into WIP and its cost event follows) and the quantity
// event of a loss in output units.
function applyLoss(userScope, run, loss) {
    const costs = ec.resource.script("component://mr-mantle/service/mantle/work/ProductionCosts.js")
    const effects = {}
    if (loss.lossTypeEnumId === "PltComponentScrap")
        effects.productionCostEventId = costs.recordAll(LOSS, [loss.productionLossId])[0] || null
    if (loss.lossTypeEnumId === "PltOutputScrap" && loss.assetId) {
        posting.period([run.ownerPartyId], ec.user.nowTimestamp, {lock: false})
        const asset = posting.stock(userScope, loss.assetId, dec(loss.quantity))
        if (dec(loss.quantity).compare(dec(asset.availableToPromiseTotal)) > 0)
            denied(
                "QUANTITY_EXCEEDS_AVAILABLE",
                "Only " + text(asset.availableToPromiseTotal) + " of asset " + asset.assetId + " is free"
            )
        const issued = call("mantle.product.AssetServices.issue#AssetToWorkEffort", {
            assetId: loss.assetId,
            workEffortId: run.workEffortId,
            quantity: dec(loss.quantity),
            noConsumeProduct: "ignore",
            noOriginFacility: "ignore",
            issuanceFields: {
                operationWorkEffortId: loss.operationWorkEffortId || null,
                productionLossId: loss.productionLossId,
                enteredQuantity: dec(loss.quantity),
                enteredQuantityUomId: loss.quantityUomId || null,
                appliedConversionFactor: 1
            }
        })
        call("update#" + LOSS, {productionLossId: loss.productionLossId, assetIssuanceId: issued.assetIssuanceId})
        effects.assetIssuanceId = issued.assetIssuanceId
        effects.productionCostEventId = costs.recordAll(ISSUANCE, [issued.assetIssuanceId])[0] || null
    }
    const eventType = lossTypes[loss.lossTypeEnumId].eventType
    if (eventType) {
        const line = one(LINE, {productionRunLineId: loss.productionRunLineId})
        effects.productionQuantityEventId = quantityEvent(run, line, eventType, dec(loss.quantity), {
            operationWorkEffortId: loss.operationWorkEffortId,
            productionLossId: loss.productionLossId,
            reasonCode: loss.reasonCode,
            reason: loss.reasonName
        })
    }
    return effects
}
// The cost event of a component scrap (record#ProductionCostEvent's ProductionLoss source): the scrapped quantity at its
// asset's cost, or the line's issued cost a unit, as WIP the cost close moves to scrap variance; nothing moves in stock, so
// nothing posts now (PclAwaitingClose), and it does not change the run's WIP balance.
function lossCostEvent(productionLossId) {
    const loss = one(LOSS, {productionLossId})
    if (!loss || loss.lossTypeEnumId !== "PltComponentScrap")
        denied("SOURCE_INVALID", "Loss " + productionLossId + " is not a scrap of issued material")
    const run = one(WORK, {workEffortId: loss.workEffortId})
    if (!run || run.purposeEnumId !== "WepProductionRun")
        denied("SOURCE_INVALID", "Loss " + productionLossId + " is not a production run's")
    let cost = null,
        currency = null,
        rateEntityName = null,
        rateId = null
    const asset = loss.assetId ? one(ASSET, {assetId: loss.assetId}) : null
    if (asset?.acquireCost != null) {
        cost = dec(asset.acquireCost)
        currency = asset.acquireCostUomId || null
        rateEntityName = ASSET
        rateId = asset.assetId
    } else {
        // the line's issued cost a unit: what was issued to it at each asset's cost over the quantity issued
        let quantity = zero(),
            value = zero()
        for (const issuance of rows(ISSUANCE, {productionMaterialLineId: loss.productionRunLineId})) {
            const issuedAsset = one(ASSET, {assetId: issuance.assetId})
            if (issuedAsset?.acquireCost == null) continue
            quantity = quantity.add(dec(issuance.quantity))
            value = value.add(dec(issuance.quantity).multiply(dec(issuedAsset.acquireCost)))
            currency = currency || issuedAsset.acquireCostUomId || null
        }
        if (quantity.compare(0) > 0) {
            cost = value.divide(quantity, 6, "HALF_UP")
            rateEntityName = LINE
            rateId = loss.productionRunLineId
        }
    }
    const valued = cost != null && !cost.isZero()
    return {
        run,
        costEventTypeEnumId: "PcetMaterialScrap",
        costComponentEnumId: "PrcMaterial",
        operationWorkEffortId: loss.operationWorkEffortId || null,
        productionRunLineId: loss.productionRunLineId,
        productId: loss.productId,
        quantity: dec(loss.quantity),
        quantityUomId: loss.quantityUomId || null,
        rateAmount: valued ? cost : null,
        rateEntityName: valued ? rateEntityName : null,
        rateId: valued ? rateId : null,
        amount: valued ? dec(loss.quantity).multiply(cost) : null,
        amountUomId: currency,
        valuationStatusEnumId: valued ? "PcvValued" : "PcvUnvalued",
        ledgerStatusEnumId: "PclAwaitingClose",
        acctgTransId: null,
        accountingDate: null,
        assetId: loss.assetId || null,
        reasonCode: loss.reasonCode || null,
        eventDate: loss.lossDate || ec.user.nowTimestamp
    }
}

// ===== record#ProductionLoss =====
function recordLoss(p) {
    const begun = posting.begin(p, "ProductionLoss", "PRODUCTION_OPERATE", [
        "workEffortId",
        "lossTypeEnumId",
        "productionRunLineId",
        "operationWorkEffortId",
        "assetId",
        "quantity",
        "reasonCode",
        "reason",
        "comments",
        "reworkWorkEffortId"
    ])
    if (begun.previous) return begun.previous
    const userScope = posting.scope()
    const run = production().runOf(userScope, p.workEffortId, true)
    const settled = posting.settled(begun.op)
    if (settled) return settled
    if (!openStatuses.includes(run.statusId))
        denied(
            "RUN_NOT_OPEN",
            "Work order " + run.workEffortId + " is " + statusText(run.statusId) + "; a loss is recorded on an open run"
        )
    const plan = lossPlan(userScope, run, p)
    const written = writeLoss(userScope, run, plan, p)
    return posting.complete(begun.op, run.ownerPartyId, LOSS, written.loss.productionLossId, {
        resultCode: written.loss.statusId === "PlsPending" ? "APPROVAL_REQUESTED" : "RECORDED",
        workEffortId: run.workEffortId,
        productionLossId: written.loss.productionLossId,
        lossTypeEnumId: plan.type,
        productionRunLineId: plan.line.productionRunLineId,
        assetId: written.loss.assetId || null,
        quantity: text(plan.quantity),
        statusId: written.loss.statusId,
        pendingApproval: written.loss.statusId === "PlsPending",
        assetIssuanceId: written.effects.assetIssuanceId || null,
        productionCostEventId: written.effects.productionCostEventId || null,
        productionQuantityEventId: written.effects.productionQuantityEventId || null
    })
}

// ===== record#ProductionQuantity =====
// Good and produced-held output with its receipt in one orchestration (the receipt under this operation's key, so a retry
// receives nothing twice), and process loss, scrap and rework with their losses, in one transaction. Output beyond the
// target, the policy's tolerance and a supervisor's approval records nothing but an overproduction request for the
// supervisors.
function recordQuantity(p) {
    const fields = ["workEffortId", "productionRunLineId", "operationWorkEffortId", "good", "pending", "processLoss", "scrap"]
    const begun = posting.begin(
        p,
        "ProductionQuantity",
        "PRODUCTION_OPERATE",
        fields.concat([
            "rework",
            "reasonCode",
            "reason",
            "expectedRevision",
            "facilityId",
            "toLocationSeqId",
            "heldLocationSeqId",
            "lotNumber",
            "serialNumbers",
            "firstSerialNumber"
        ])
    )
    if (begun.previous) return begun.previous
    const userScope = posting.scope()
    const run = production().runOf(userScope, p.workEffortId, true)
    const settled = posting.settled(begun.op)
    if (settled) return settled
    if (!releasedStatuses.includes(run.statusId))
        denied(
            "RUN_NOT_RELEASED",
            "Work order " +
                run.workEffortId +
                " is " +
                statusText(run.statusId) +
                "; quantities are recorded on a released or running one"
        )
    requireRevision(run, p.expectedRevision, false)
    const line = outputLine(run, p.productionRunLineId, true)
    const operationWorkEffortId = operationOf(run, p.operationWorkEffortId)
    const q = {
        good: quantityOf(p.good, "Good"),
        pending: quantityOf(p.pending, "Pending"),
        processLoss: quantityOf(p.processLoss, "Process loss"),
        scrap: quantityOf(p.scrap, "Scrap"),
        rework: quantityOf(p.rework, "Rework")
    }
    const total = Object.values(q).reduce((all, value) => all.add(value), zero())
    if (total.compare(0) <= 0) denied("QUANTITY_REQUIRED", "Give a good, pending, loss, scrap or rework quantity")
    const figures = outputFigures(run, line)
    const excess = total.subtract(figures.receivable)
    const answer = {workEffortId: run.workEffortId, productionRunLineId: line.productionRunLineId, operationWorkEffortId}
    if (excess.compare(0) > 0) {
        // beyond the target and tolerance: a request a supervisor decides (approve#ProductionException), nothing recorded
        const eventId = quantityEvent(run, line, "PqetOverproduction", excess, {
            operationWorkEffortId,
            approvalStatusEnumId: "PapPending",
            reasonCode: p.reasonCode,
            reason: p.reason
        })
        notifySupervisors("ProductionOverproduction", run, QEVENT, eventId, {
            productionQuantityEventId: eventId,
            productionRunLineId: line.productionRunLineId,
            quantity: text(excess),
            productName: productName(line.productId),
            target: text(figures.target),
            tolerance: text(figures.tolerance)
        })
        return posting.complete(
            begun.op,
            run.ownerPartyId,
            QEVENT,
            eventId,
            Object.assign(answer, {
                resultCode: "APPROVAL_REQUESTED",
                productionQuantityEventId: eventId,
                excess: text(excess),
                message:
                    text(excess) +
                    " beyond the target of " +
                    text(figures.target) +
                    " and the tolerance of " +
                    text(figures.tolerance) +
                    " waits for a supervisor's approval"
            })
        )
    }
    const lossIds = [],
        eventIds = []
    const lossKinds = [
        ["processLoss", "PltProcessLoss"],
        ["scrap", "PltOutputScrap"],
        ["rework", "PltRework"]
    ]
    for (const [field, type] of lossKinds) {
        if (q[field].compare(0) <= 0) continue
        const plan = lossPlan(userScope, run, {
            lossTypeEnumId: type,
            productionRunLineId: line.productionRunLineId,
            operationWorkEffortId,
            quantity: q[field],
            reasonCode: p.reasonCode,
            reason: p.reason
        })
        const written = writeLoss(userScope, run, plan, p)
        lossIds.push(written.loss.productionLossId)
        if (written.effects.productionQuantityEventId) eventIds.push(written.effects.productionQuantityEventId)
    }
    const receipts = []
    let completed = false
    for (const [field, type] of [
        ["good", "PqetGood"],
        ["pending", "PqetPending"]
    ]) {
        if (q[field].compare(0) <= 0) continue
        const received = call("mantle.work.ProductionServices.receive#ProductionOutput", {
            operationKey: begun.op.clientKey + "/" + field,
            workEffortId: run.workEffortId,
            productionRunLineId: line.productionRunLineId,
            quantity: q[field],
            operationWorkEffortId,
            facilityId: str(p.facilityId),
            toLocationSeqId: field === "good" ? str(p.toLocationSeqId) : str(p.heldLocationSeqId),
            lotNumber: str(p.lotNumber),
            serialNumbers: field === "good" ? p.serialNumbers || null : null,
            firstSerialNumber: field === "good" ? str(p.firstSerialNumber) : null,
            hold: field === "pending"
        }).result
        receipts.push(received)
        completed = completed || !!received.completed
        eventIds.push(
            quantityEvent(run, line, type, q[field], {
                operationWorkEffortId,
                assetReceiptId: (received.assetReceiptIds || [])[0] || null,
                reasonCode: p.reasonCode,
                reason: p.reason
            })
        )
    }
    const after = outputFigures(
        one(WORK, {workEffortId: run.workEffortId}),
        one(LINE, {productionRunLineId: line.productionRunLineId})
    )
    return posting.complete(
        begun.op,
        run.ownerPartyId,
        WORK,
        run.workEffortId,
        Object.assign(answer, {
            resultCode: "RECORDED",
            productionQuantityEventIds: eventIds,
            productionLossIds: lossIds,
            pendingLossIds: lossIds.filter(id => one(LOSS, {productionLossId: id})?.statusId === "PlsPending"),
            receipts,
            completed,
            good: text(after.good),
            held: text(after.held),
            remaining: text(after.remaining)
        })
    )
}

// ===== approve#ProductionException =====
// A supervisor's decision on the record (F40): a pending loss approved (its effect applied now) or refused, or an
// overproduction request approved (the line may take that much more) or refused. The decision marks the notices read.
function approveException(p) {
    const begun = posting.begin(p, "ProductionException", "PRODUCTION_SUPERVISE", [
        "workEffortId",
        "productionLossId",
        "productionQuantityEventId",
        "decision",
        "quantity",
        "reason"
    ])
    if (begun.previous) return begun.previous
    const decision = str(p.decision) || "approve"
    if (!["approve", "refuse"].includes(decision)) denied("DECISION_INVALID", "Approve or refuse")
    if (decision === "refuse" && blank(p.reason)) denied("REASON_REQUIRED", "Give the reason to refuse")
    const userScope = posting.scope()
    if (!blank(p.productionLossId)) {
        const loss = find(LOSS, {productionLossId: p.productionLossId}).forUpdate(true).one()
        // a loss of the work order named, when one is (the screen's record check is of that work order)
        if (!loss || (!blank(p.workEffortId) && loss.workEffortId !== String(p.workEffortId).trim()))
            denied("RECORD_UNAVAILABLE", "Loss " + p.productionLossId + " is not available")
        const run = production().runOf(userScope, loss.workEffortId, true)
        const settled = posting.settled(begun.op)
        if (settled) return settled
        if (loss.statusId !== "PlsPending")
            denied("NOT_PENDING", "Loss " + loss.productionLossId + " is " + statusText(loss.statusId))
        let effects = {}
        if (decision === "approve") {
            if (!openStatuses.includes(run.statusId))
                denied("RUN_NOT_OPEN", "Work order " + run.workEffortId + " is " + statusText(run.statusId))
            effects = applyLoss(userScope, run, loss)
        }
        call("update#" + LOSS, {
            productionLossId: loss.productionLossId,
            statusId: decision === "approve" ? "PlsApproved" : "PlsRefused",
            statusId_changeReason: str(p.reason),
            approvedByUserId: ec.user.userId,
            approvedDate: ec.user.nowTimestamp
        })
        clearNotices("ProductionLossApproval", LOSS, loss.productionLossId)
        return posting.complete(begun.op, run.ownerPartyId, LOSS, loss.productionLossId, {
            resultCode: decision === "approve" ? "APPROVED" : "REFUSED",
            workEffortId: run.workEffortId,
            productionLossId: loss.productionLossId,
            assetIssuanceId: effects.assetIssuanceId || null,
            productionCostEventId: effects.productionCostEventId || null,
            productionQuantityEventId: effects.productionQuantityEventId || null
        })
    }
    if (blank(p.productionQuantityEventId)) denied("RECORD_REQUIRED", "Choose the loss or the overproduction request to decide")
    const event = find(QEVENT, {productionQuantityEventId: p.productionQuantityEventId}).forUpdate(true).one()
    if (
        !event ||
        event.quantityEventTypeEnumId !== "PqetOverproduction" ||
        (!blank(p.workEffortId) && event.workEffortId !== String(p.workEffortId).trim())
    )
        denied("RECORD_UNAVAILABLE", "Overproduction request " + p.productionQuantityEventId + " is not available")
    const run = production().runOf(userScope, event.workEffortId, true)
    const settled = posting.settled(begun.op)
    if (settled) return settled
    if (event.approvalStatusEnumId !== "PapPending")
        denied(
            "NOT_PENDING",
            "Overproduction request " + event.productionQuantityEventId + " is " + enumText(event.approvalStatusEnumId)
        )
    const line = lineOf(run, event.productionRunLineId, outputRoles, true)
    const quantity = blank(p.quantity) ? dec(event.quantity) : dec(p.quantity)
    if (decision === "approve") {
        if (quantity.compare(0) <= 0) denied("QUANTITY_INVALID", "Give a quantity above zero")
        call("update#" + LINE, {
            productionRunLineId: line.productionRunLineId,
            overApprovedQuantity: dec(line.overApprovedQuantity).add(quantity),
            overApprovedByUserId: ec.user.userId,
            overApprovedDate: ec.user.nowTimestamp
        })
    }
    call("update#" + QEVENT, {
        productionQuantityEventId: event.productionQuantityEventId,
        approvalStatusEnumId: decision === "approve" ? "PapApproved" : "PapRefused",
        approvedByUserId: ec.user.userId,
        approvedDate: ec.user.nowTimestamp
    })
    clearNotices("ProductionOverproduction", QEVENT, event.productionQuantityEventId)
    return posting.complete(begun.op, run.ownerPartyId, QEVENT, event.productionQuantityEventId, {
        resultCode: decision === "approve" ? "APPROVED" : "REFUSED",
        workEffortId: run.workEffortId,
        productionQuantityEventId: event.productionQuantityEventId,
        productionRunLineId: line.productionRunLineId,
        approvedQuantity: decision === "approve" ? text(quantity) : null
    })
}

// ===== change#ProductionQuantity =====
// A new target for an output line of a released run as a delta (design ChangeQuantity, R-SA-05): never below what the line
// already accounts for (good, held, loss and losses waiting); the material and by-product lines scale with it, never below
// what each has already issued or received, but a planner's manual material line (P5b, store#ProductionMaterial: a quantity
// entered for the run, not per unit made) keeps its quantity unless scaleManual; the WeptConsume/WeptProduce rows are
// rewritten from the lines (F-P7-10).
function changeQuantity(p) {
    const begun = posting.begin(p, "ProductionQuantityChange", "PRODUCTION_PLAN", [
        "workEffortId",
        "productionRunLineId",
        "targetQuantity",
        "expectedRevision",
        "reason",
        "reasonCode",
        "scaleManual"
    ])
    if (begun.previous) return begun.previous
    const userScope = posting.scope()
    const run = production().runOf(userScope, p.workEffortId, true)
    const settled = posting.settled(begun.op)
    if (settled) return settled
    requireRevision(run, p.expectedRevision)
    if (!openStatuses.includes(run.statusId))
        denied(
            "RUN_NOT_RELEASED",
            "Work order " + run.workEffortId + " is " + statusText(run.statusId) + "; a draft is changed directly"
        )
    if (blank(p.reason) && blank(p.reasonCode)) denied("REASON_REQUIRED", "Give the reason for the change")
    let reasonText = str(p.reason)
    if (!blank(p.reasonCode)) {
        const reason = productionPolicy().activeReason(run.ownerPartyId, p.reasonCode)
        if (!reason) denied("REASON_INVALID", "Reason " + p.reasonCode + " is not an active production reason")
        reasonText = [reason.reasonName || p.reasonCode, reasonText].filter(Boolean).join(": ")
    }
    const line = outputLine(run, p.productionRunLineId, true)
    if (line.lineRoleEnumId !== "PrlrOutput") denied("LINE_INVALID", "The target is an output line's")
    const target = blank(p.targetQuantity) ? zero() : dec(p.targetQuantity)
    if (target.compare(0) <= 0) denied("QUANTITY_INVALID", "Give a target above zero")
    const previous = dec(line.stockQuantity)
    if (target.compare(previous) === 0) denied("NO_CHANGE", "The target is " + text(previous) + " already")
    const figures = outputFigures(run, line)
    const floor = figures.accounted.add(figures.pendingLoss)
    if (target.compare(floor) < 0)
        denied(
            "TARGET_BELOW_FACTS",
            "The target cannot go below the " +
                text(floor) +
                " already accounted for (good " +
                text(figures.good) +
                ", held " +
                text(figures.held) +
                ", loss " +
                text(figures.processLoss.add(figures.scrap).add(figures.rework).add(figures.pendingLoss)) +
                ")"
        )
    const ratio = target.divide(previous, 10, "HALF_UP")
    const scaled = (row, floorQuantity) => {
        let stock = dec(row.stockQuantity).multiply(ratio)
        if (stock.compare(floorQuantity) < 0) stock = floorQuantity
        const factor = dec(row.conversionFactor ?? 1)
        return {stockQuantity: stock, quantity: factor.isZero() ? stock : stock.divide(factor, 6, "HALF_UP")}
    }
    const lines = production().linesOf(run.workEffortId)
    const losses = lossesOf(run.workEffortId)
    for (const row of lines) {
        if (row.productionRunLineId === line.productionRunLineId) {
            const factor = dec(row.conversionFactor ?? 1)
            call("update#" + LINE, {
                productionRunLineId: row.productionRunLineId,
                stockQuantity: target,
                quantity: factor.isZero() ? target : target.divide(factor, 6, "HALF_UP")
            })
        } else if (row.lineRoleEnumId === "PrlrMaterial") {
            if (row.manualLine === "Y" && !yes(p.scaleManual)) continue
            const figures = materialFigures(row, losses)
            call("update#" + LINE, Object.assign({productionRunLineId: row.productionRunLineId}, scaled(row, figures.net)))
        } else if (row.lineRoleEnumId === "PrlrByproduct") {
            const received = sum(
                rows(RECEIPT, {productionOutputLineId: row.productionRunLineId}),
                receipt => receipt.quantityAccepted
            )
            call("update#" + LINE, Object.assign({productionRunLineId: row.productionRunLineId}, scaled(row, received)))
        }
    }
    production().writeProducts(run.workEffortId, production().linesOf(run.workEffortId))
    const revision = revisionOf(run) + 1
    call("update#" + WORK, {workEffortId: run.workEffortId, productionRevision: revision})
    const delta = target.subtract(previous)
    const eventId = quantityEvent(run, line, "PqetTargetChange", delta, {
        previousTargetQuantity: previous,
        targetQuantity: target,
        reasonCode: p.reasonCode,
        reason: reasonText
    })
    return posting.complete(begun.op, run.ownerPartyId, QEVENT, eventId, {
        resultCode: "CHANGED",
        workEffortId: run.workEffortId,
        productionRunLineId: line.productionRunLineId,
        previousTarget: text(previous),
        target: text(target),
        delta: text(delta),
        revision,
        productionQuantityEventId: eventId
    })
}

// ===== store#ProductionOutput =====
// A draft run's secondary output or by-product line: added, changed or removed (not the primary output, which is the run's
// product and changes with change#ProductionQuantity once released). The quantity in its unit with the exact conversion to
// the product's stock unit; the WorkEffortProduct rows rewritten; the revision counted up.
function storeOutput(p) {
    const begun = posting.begin(p, "ProductionOutputStore", "PRODUCTION_PLAN", [
        "workEffortId",
        "productionRunLineId",
        "lineRoleEnumId",
        "productId",
        "quantity",
        "quantityUomId",
        "routingOperationWorkEffortId",
        "expectedRevision",
        "remove"
    ])
    if (begun.previous) return begun.previous
    const userScope = posting.scope()
    const run = production().runOf(userScope, p.workEffortId, true)
    const settled = posting.settled(begun.op)
    if (settled) return settled
    requireRevision(run, p.expectedRevision)
    if (run.statusId !== "WeInPlanning")
        denied(
            "RUN_NOT_DRAFT",
            "Work order " + run.workEffortId + " is " + statusText(run.statusId) + "; outputs are planned on a draft"
        )
    const lines = production().linesOf(run.workEffortId)
    const primary = primaryOf(lines)
    let existing = null
    if (!blank(p.productionRunLineId)) {
        existing = lineOf(run, p.productionRunLineId, outputRoles, true)
        if (primary && existing.productionRunLineId === primary.productionRunLineId)
            denied("OUTPUT_PRIMARY", "The work order's own product is changed by its target, not here")
    }
    let resultCode, productionRunLineId
    if (yes(p.remove)) {
        if (!existing) denied("LINE_REQUIRED", "Choose the output to remove")
        call("delete#" + LINE, {productionRunLineId: existing.productionRunLineId})
        resultCode = "REMOVED"
        productionRunLineId = existing.productionRunLineId
    } else {
        const role = str(p.lineRoleEnumId) || existing?.lineRoleEnumId || "PrlrByproduct"
        if (!outputRoles.includes(role)) denied("ROLE_INVALID", "An output is a secondary output or a by-product")
        const productId = str(p.productId) || existing?.productId
        const product = productId ? one(PRODUCT, {productId}) : null
        if (!product) denied("PRODUCT_REQUIRED", "Choose the product of the output")
        const quantity = blank(p.quantity) ? zero() : dec(p.quantity)
        if (quantity.compare(0) <= 0) denied("QUANTITY_INVALID", "Give a quantity above zero")
        const quantityUomId = str(p.quantityUomId) || product.amountUomId || existing?.quantityUomId || null
        const stockUomId = product.amountUomId || quantityUomId
        const methodPolicy = ec.resource.script("component://mr-mantle/service/mantle/product/MethodPolicy.js")
        let converted
        try {
            converted = methodPolicy.convert(quantity, quantityUomId, stockUomId, ec.user.nowTimestamp)
        } catch (error) {
            denied("UNIT_CONVERSION", String(error.message || error).replace(/^(Error: )+/, ""))
        }
        let routingOperationWorkEffortId = str(p.routingOperationWorkEffortId) || existing?.routingOperationWorkEffortId || null
        if (routingOperationWorkEffortId) {
            const routings = production().routingsOf(run, lines)
            const op = one(WORK, {workEffortId: routingOperationWorkEffortId})
            if (!op || !routings.includes(op.parentWorkEffortId))
                denied("OPERATION_INVALID", "Operation " + routingOperationWorkEffortId + " is not in the work order's routing")
        }
        const fields = {
            lineRoleEnumId: role,
            productId: product.productId,
            quantity,
            quantityUomId,
            stockQuantity: converted.quantity,
            stockUomId,
            conversionFactor: converted.factor,
            uomConversionId: converted.uomConversionId || null,
            routingOperationWorkEffortId
        }
        if (existing) {
            call("update#" + LINE, Object.assign({productionRunLineId: existing.productionRunLineId}, fields))
            productionRunLineId = existing.productionRunLineId
            resultCode = "STORED"
        } else {
            const seq = lines.reduce((max, row) => Math.max(max, Number(row.lineSeqNum || 0)), 0) + 10
            productionRunLineId = call(
                "create#" + LINE,
                Object.assign({workEffortId: run.workEffortId, lineSeqNum: seq}, fields)
            ).productionRunLineId
            resultCode = "ADDED"
        }
    }
    production().writeProducts(run.workEffortId, production().linesOf(run.workEffortId))
    const revision = revisionOf(run) + 1
    call("update#" + WORK, {workEffortId: run.workEffortId, productionRevision: revision})
    return posting.complete(begun.op, run.ownerPartyId, WORK, run.workEffortId, {
        resultCode,
        workEffortId: run.workEffortId,
        productionRunLineId,
        revision
    })
}

// ===== get#ProductionQuantities =====
function lossRow(loss, financial) {
    const row = {
        productionLossId: loss.productionLossId,
        workEffortId: loss.workEffortId,
        operationWorkEffortId: loss.operationWorkEffortId || null,
        productionRunLineId: loss.productionRunLineId || null,
        lossTypeEnumId: loss.lossTypeEnumId,
        lossTypeText: enumText(loss.lossTypeEnumId),
        productId: loss.productId,
        productName: productName(loss.productId),
        assetId: loss.assetId || null,
        lotId: loss.lotId || null,
        quantity: text(loss.quantity),
        quantityUomId: loss.quantityUomId || null,
        reasonCode: loss.reasonCode || null,
        reasonName: loss.reasonName || null,
        statusId: loss.statusId,
        statusText: statusText(loss.statusId),
        pending: loss.statusId === "PlsPending",
        lossDate: loss.lossDate || null,
        lossDateText: when(loss.lossDate),
        assetIssuanceId: loss.assetIssuanceId || null,
        reworkWorkEffortId: loss.reworkWorkEffortId || null,
        effectText:
            loss.lossTypeEnumId === "PltComponentScrap"
                ? "Scrap cost event, no stock movement"
                : loss.lossTypeEnumId === "PltOutputScrap"
                  ? loss.assetId
                      ? "Output issued back to the run"
                      : "Output scrapped before receipt"
                  : loss.lossTypeEnumId === "PltRework"
                    ? "Sent to rework"
                    : "Quantity only"
    }
    // the loss's cost only with financial read, left out otherwise (§2)
    if (financial) {
        const event = loss.assetIssuanceId
            ? find(COST_EVENT, {sourceEntityName: ISSUANCE, sourceId: loss.assetIssuanceId}).one()
            : find(COST_EVENT, {sourceEntityName: LOSS, sourceId: loss.productionLossId}).one()
        row.costAmount = event?.amount == null ? null : text(event.amount)
        row.costUomId = event?.amountUomId || null
    }
    return row
}
function eventRow(event) {
    return {
        productionQuantityEventId: event.productionQuantityEventId,
        quantityEventTypeEnumId: event.quantityEventTypeEnumId,
        eventTypeText: enumText(event.quantityEventTypeEnumId),
        productionRunLineId: event.productionRunLineId || null,
        operationWorkEffortId: event.operationWorkEffortId || null,
        quantity: text(event.quantity),
        quantityUomId: event.quantityUomId || null,
        previousTarget: text(event.previousTargetQuantity),
        target: text(event.targetQuantity),
        assetReceiptId: event.assetReceiptId || null,
        productionLossId: event.productionLossId || null,
        reason: event.reason || event.reasonCode || null,
        approvalStatusEnumId: event.approvalStatusEnumId || null,
        approvalText: event.approvalStatusEnumId ? enumText(event.approvalStatusEnumId) : null,
        pending: event.approvalStatusEnumId === "PapPending",
        eventDate: event.eventDate || null,
        eventDateText: when(event.eventDate),
        runRevision: event.runRevision == null ? null : Number(event.runRevision)
    }
}
// The by-products' allocation estimate (design ByProducts AllocationReview): the frozen estimate of the output quantity shared
// by quantity across the output and by-product lines in the primary output's unit (the default co-product rule, §4); a line in
// another unit is not shared. Accounting's cost close makes the actual allocation (P15).
function allocationEstimate(run, lines) {
    const primary = primaryOf(lines)
    const standard = run.productStandardCostId ? one(STANDARD, {productStandardCostId: run.productStandardCostId}) : null
    if (!primary || standard?.unitCost == null) return {available: false, rows: []}
    const total = dec(standard.unitCost).multiply(dec(primary.stockQuantity))
    const shared = lines.filter(line => outputRoles.includes(line.lineRoleEnumId))
    const inUnit = shared.filter(line => (line.stockUomId || null) === (primary.stockUomId || null))
    const quantity = sum(inUnit, line => line.stockQuantity)
    return {
        available: true,
        method: "By quantity",
        currencyUomId: standard.priceUomId || null,
        totalCost: text(total),
        productStandardCostId: standard.productStandardCostId,
        rows: shared.map(line => {
            const counted = inUnit.includes(line) && quantity.compare(0) > 0
            const share = counted ? dec(line.stockQuantity).multiply(toDecimal(100)).divide(quantity, 2, "HALF_UP") : null
            return {
                productionRunLineId: line.productionRunLineId,
                lineRoleEnumId: line.lineRoleEnumId,
                roleText: enumText(line.lineRoleEnumId),
                productName: productName(line.productId),
                quantity: text(line.stockQuantity),
                stockUomId: line.stockUomId || null,
                sharePercent: share == null ? null : text(share),
                amount: counted ? text(total.multiply(share).divide(toDecimal(100), 4, "HALF_UP")) : null,
                note: counted ? null : "Another unit: not shared by quantity"
            }
        })
    }
}
function read(p) {
    requireAny(["PRODUCTION_VIEW", "PRODUCTION_OPERATE"])
    const userScope = posting.scope()
    const run = production().runOf(userScope, p.workEffortId)
    const lines = production().linesOf(run.workEffortId)
    const losses = lossesOf(run.workEffortId)
    const policy = productionPolicy().runPolicy(run)
    const financial = access.has("ACCOUNTING_VIEW")
    const primary = primaryOf(lines)
    const outputRows = lines
        .filter(line => outputRoles.includes(line.lineRoleEnumId))
        .map(line => {
            const figures = outputFigures(run, line, losses, policy)
            return {
                productionRunLineId: line.productionRunLineId,
                lineRoleEnumId: line.lineRoleEnumId,
                roleText: line === primary ? "Output" : enumText(line.lineRoleEnumId),
                primary: line === primary,
                productId: line.productId,
                productName: productName(line.productId),
                stockUomId: line.stockUomId || null,
                operationWorkEffortId: line.operationWorkEffortId || null,
                target: text(figures.target),
                received: text(figures.received),
                good: text(figures.good),
                held: text(figures.held),
                processLoss: text(figures.processLoss),
                scrap: text(figures.scrap),
                rework: text(figures.rework),
                pendingLoss: text(figures.pendingLoss),
                remaining: text(figures.remaining),
                over: text(figures.over),
                tolerance: text(figures.tolerance),
                approvedOver: text(figures.approvedOver),
                receivable: text(atLeastZero(figures.receivable)),
                overApprovedByUserId: line.overApprovedByUserId || null
            }
        })
    const materialRows = lines
        .filter(line => line.lineRoleEnumId === "PrlrMaterial")
        .map(line => {
            const figures = materialFigures(line, losses)
            return {
                productionRunLineId: line.productionRunLineId,
                productId: line.productId,
                productName: productName(line.productId),
                stockUomId: line.stockUomId || null,
                operationWorkEffortId: line.operationWorkEffortId || null,
                required: text(figures.required),
                issued: text(figures.issued),
                returned: text(figures.returned),
                net: text(figures.net),
                scrapped: text(figures.scrapped),
                remaining: text(figures.remaining)
            }
        })
    const events = Array.from(
        find(QEVENT, {workEffortId: run.workEffortId}).orderBy("-eventDate").orderBy("-productionQuantityEventId").list()
    )
    let reconciliation
    try {
        reconciliation = completeCheck(run, {}, lines)
    } catch (error) {
        ec.logger.error("Work order " + run.workEffortId + " reconciliation failed: " + error.message)
        reconciliation = {allowed: false, reasonCode: lib.reasonCode(error) || "FAILED", message: error.message}
    }
    const released = releasedStatuses.includes(run.statusId)
    const open = openStatuses.includes(run.statusId)
    const canSupervise = access.has("PRODUCTION_SUPERVISE")
    return {
        run: {
            workEffortId: run.workEffortId,
            workEffortName: run.workEffortName || null,
            statusId: run.statusId,
            statusText: statusText(run.statusId),
            revision: revisionOf(run),
            ownerPartyId: run.ownerPartyId || null,
            facilityId: run.facilityId || null,
            productId: primary?.productId || null,
            productName: primary ? productName(primary.productId) : null,
            overProducePercent: text(policy.overProducePercent),
            completeOnFinalReceipt: policy.completeOnFinalReceipt === "Y"
        },
        outputRows,
        materialRows,
        eventRows: events.map(eventRow),
        lossRows: losses
            .sort((a, b) => (lib.ms(b.lossDate) || 0) - (lib.ms(a.lossDate) || 0))
            .map(loss => lossRow(loss, financial)),
        reconciliation: {
            reconciled: !!reconciliation.allowed,
            reasonCode: reconciliation.reasonCode || null,
            message: reconciliation.message || null,
            finishRemainderOffered: !!reconciliation.finishRemainderOffered,
            materialVarianceOffered: !!reconciliation.materialVarianceOffered,
            impact: reconciliation.impact || []
        },
        allocation: estimateReaders.some(access.has) ? allocationEstimate(run, lines) : null,
        financialRead: financial,
        can: {
            record: released && access.has("PRODUCTION_OPERATE"),
            recordLoss: open && access.has("PRODUCTION_OPERATE"),
            change: open && access.has("PRODUCTION_PLAN"),
            storeOutput: run.statusId === "WeInPlanning" && access.has("PRODUCTION_PLAN"),
            complete: run.statusId === "WeInProgress" && canSupervise,
            approve: canSupervise,
            issue: access.has("STOCK_ISSUE")
        }
    }
}

// ===== find#ProductionLosses =====
function findLosses(p) {
    requireAny(["PRODUCTION_VIEW", "PRODUCTION_OPERATE"])
    const userScope = posting.scope()
    let query = find(LOSS)
    if (userScope.organizationPartyIds) query = query.condition("organizationPartyId", "in", userScope.organizationPartyIds)
    for (const field of [
        "workEffortId",
        "operationWorkEffortId",
        "productId",
        "reasonCode",
        "lossTypeEnumId",
        "statusId",
        "organizationPartyId"
    ])
        if (!blank(p[field])) query = query.condition(field, String(p[field]).trim())
    if (!blank(p.fromDate)) query = query.condition("lossDate", "greater-equals", p.fromDate)
    if (!blank(p.thruDate)) query = query.condition("lossDate", "less-than", p.thruDate)
    if (!blank(p.workCenterFacilityId)) {
        const ops = Array.from(find(WORK, {workCenterFacilityId: p.workCenterFacilityId}).selectField("workEffortId").list()).map(
            row => row.workEffortId
        )
        query = query.condition("operationWorkEffortId", "in", ops.length ? ops : ["_NA_"])
    }
    const financial = access.has("ACCOUNTING_VIEW")
    // each loss's run checked again: its owner and facility the user's (F3)
    const visible = Array.from(query.orderBy("-lossDate").orderBy("-productionLossId").limit(2000).list()).filter(loss => {
        const run = one(WORK, {workEffortId: loss.workEffortId})
        const facility = run?.facilityId ? one(FACILITY, {facilityId: run.facilityId}) : null
        return (
            run &&
            facilityScope.owns(userScope, run.ownerPartyId) &&
            (!facility || facilityScope.owns(userScope, facility.ownerPartyId))
        )
    })
    const pageSize = Math.max(1, Math.min(Number(p.pageSize || 20), 200))
    const pageIndex = Math.max(0, Number(p.pageIndex || 0))
    const pageRows = visible.slice(pageIndex * pageSize, (pageIndex + 1) * pageSize)
    const count = visible.length
    return {
        lossRows: pageRows.map(loss => {
            const row = lossRow(loss, financial)
            const run = one(WORK, {workEffortId: loss.workEffortId})
            row.workEffortName = run?.workEffortName || null
            return row
        }),
        lossRowsCount: count,
        lossRowsPageIndex: pageIndex,
        lossRowsPageSize: pageSize,
        lossRowsPageMaxIndex: Math.max(0, Math.ceil(count / pageSize) - 1),
        lossRowsPageRangeLow: count ? pageIndex * pageSize + 1 : 0,
        lossRowsPageRangeHigh: Math.min(count, (pageIndex + 1) * pageSize),
        financialRead: financial,
        canApprove: access.has("PRODUCTION_SUPERVISE")
    }
}

// ===== get#ProductionLabels =====
// Finished (the primary output), secondary (another output or a by-product) and WIP labels of a run (design §11; on Products
// P11's label contract: an approved template size and a Code 128 of the asset or run id): each output asset received, with
// its product, quantity on hand, unit, lot and serial, owner, facility, run and operation; a held asset's label says it is
// held and not accepted (no label claims acceptance before disposition). A WIP label per operation (or the run) names the
// run, the operation and the product to make.
function labels(p) {
    requireAny(["PRODUCTION_VIEW", "STOCK_ISSUE"])
    const userScope = posting.scope()
    const run = production().runOf(userScope, p.workEffortId)
    const lines = production().linesOf(run.workEffortId)
    const primary = primaryOf(lines)
    const wanted = Array.isArray(p.assetIds) && p.assetIds.length ? new Set(p.assetIds.map(String)) : null
    const kind = str(p.kind)
    const barcode = value => {
        try {
            return ec.resource.barcodeSvg("Code128", String(value), {
                moduleWidth: 0.25,
                height: 10,
                quietZone: 11,
                humanReadable: true
            })
        } catch (error) {
            ec.logger.warn("Label barcode of " + value + " was not drawn: " + error.message)
            return null
        }
    }
    const labelRows = []
    const findings = []
    for (const receipt of rows(RECEIPT, {workEffortId: run.workEffortId}).filter(row => row.productionOutputLineId)) {
        if (wanted && !wanted.has(receipt.assetId)) continue
        const line = lines.find(row => row.productionRunLineId === receipt.productionOutputLineId)
        const asset = one(ASSET, {assetId: receipt.assetId})
        if (!asset) continue
        const labelKind = line && primary && line.productionRunLineId === primary.productionRunLineId ? "finished" : "secondary"
        if (kind && kind !== labelKind) continue
        if (dec(asset.quantityOnHandTotal).compare(0) <= 0) {
            findings.push({assetId: asset.assetId, message: "Asset " + asset.assetId + " has nothing on hand; no label"})
            continue
        }
        const held = heldStatuses.includes(asset.statusId)
        labelRows.push({
            kind: labelKind,
            kindText: labelKind === "finished" ? "Finished product" : "Secondary product",
            assetId: asset.assetId,
            productId: asset.productId,
            productName: productName(asset.productId),
            quantity: text(asset.quantityOnHandTotal),
            quantityUomId: line?.stockUomId || null,
            lotId: asset.lotId || null,
            serialNumber: asset.serialNumber || null,
            ownerPartyId: asset.ownerPartyId || null,
            facilityId: asset.facilityId || null,
            locationSeqId: asset.locationSeqId || null,
            workEffortId: run.workEffortId,
            operationWorkEffortId: receipt.operationWorkEffortId || null,
            statusId: asset.statusId,
            held,
            stateText: held ? "HELD: not accepted, awaiting disposition" : "Accepted stock",
            receivedDateText: when(receipt.receivedDate),
            barcodeValue: asset.assetId,
            barcodeSvg: barcode(asset.assetId)
        })
    }
    if (!kind || kind === "wip") {
        const operations = rows(WORK, {parentWorkEffortId: run.workEffortId})
            .filter(op => op.statusId !== "WeCancelled")
            .sort((a, b) => Number(a.sequenceNum || 0) - Number(b.sequenceNum || 0))
        const targets = operations.length ? operations : [null]
        for (const op of targets)
            labelRows.push({
                kind: "wip",
                kindText: "Work in process",
                assetId: null,
                productId: primary?.productId || null,
                productName: primary ? productName(primary.productId) : null,
                quantity: primary ? text(primary.stockQuantity) : null,
                quantityUomId: primary?.stockUomId || null,
                ownerPartyId: run.ownerPartyId || null,
                facilityId: run.facilityId || null,
                workEffortId: run.workEffortId,
                operationWorkEffortId: op?.workEffortId || null,
                operationName: op?.workEffortName || null,
                held: false,
                stateText: "Work in process: not stock",
                barcodeValue: op?.workEffortId || run.workEffortId,
                barcodeSvg: barcode(op?.workEffortId || run.workEffortId)
            })
    }
    return {
        run: {workEffortId: run.workEffortId, workEffortName: run.workEffortName || null, statusText: statusText(run.statusId)},
        labelRows,
        findings,
        template: {templateId: "product-50x30", width: 50, height: 30}
    }
}

const operations = {
    read,
    storeOutput,
    recordQuantity,
    changeQuantity,
    recordLoss,
    approveException,
    findLosses,
    labels
}
;({
    receivableLeft,
    outputFigures,
    completeCheck,
    complete,
    afterReceipt,
    // impl-manufacturing P8: a scrap disposition of an open run's output takes the loss path (ProductionQuality.js)
    applyLoss,
    lossCostEvent,
    execute: (op, parameters) => {
        if (!operations[op]) throw new Error("Unknown production quantity operation " + op)
        return operations[op](parameters)
    }
})
