// A production run's quality gates (design-manufacturing QualityGates, Inspections, QualityInspection and InspectionTemplates;
// §12 M6's inspection part over CX-QUALITY; impl-manufacturing P8): what the run entry points of mantle.work.ProductionServices
// and the shared mantle.product.QualityServices (Quality.js) add for production.
// - The gates written at release (release#ProductionOrder): each operation's in-process gate from its routing operation's
//   template (methodInspectionTemplateId, copied from its operation template) or a published production template attached
//   to that operation; each output line's final gate from a template attached to the run's method (its BOM), else one that
//   applies by product, category and facility. A gate keeps its template as of the release time and the sample plan of
//   then (ProductionQualityGate), so a template revision never changes a released run's gate. A run released this way
//   reads its gates only (WorkEffort.productionGatesDate). An operation naming a template that is not published blocks the
//   release (TEMPLATE_UNAVAILABLE), never the receipt.
// - Each gate's state from its inspections: required (none yet), pending (open, or a final inspection's stock still held),
//   failed (a verified rejection not yet disposed) or passed; a later inspection of an in-process gate supersedes an earlier
//   one, whose failed result stays in history.
// - The guards that read the state (the same reading as get#SourceInspectionStatus): start and resume refuse a run with a
//   failed gate (QUALITY_BLOCKED); an operation after an in-process gate not passed is not ready, naming the inspection
//   (operationBlocks; the operation start of impl-manufacturing P10 calls operationGate); complete refuses a final
//   inspection pending or failed (INSPECTION_PENDING, INSPECTION_FAILED) and an in-process gate not passed
//   (QUALITY_GATE_OPEN), so a supervisor cannot complete past a verifier or a disposition.
// - The output receipt (receive#ProductionOutput): output of a line with a final gate is received held (AstQuarantine) with
//   its inspection of the gate's template as of the release, in the same operation.
// - create#ProductionInspection: an in-process gate's inspection (QUALITY_INSPECT).
// - A scrap disposition of an open run's output (dispose#Inspection) takes impl-manufacturing P7's loss path: an approved
//   PltOutputScrap loss that issues the held asset back to the run.
// - The quality-block notice: a production inspection verified with a rejection notifies the run's supervisors.
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const posting = ec.resource.script("component://mr-mantle/service/mantle/shipment/StockPosting.js")
const {find, one, rows, denied, call, access, ms} = lib

const WORK = "mantle.work.effort.WorkEffort",
    ASSOC = "mantle.work.effort.WorkEffortAssoc",
    GATE = "mantle.work.production.ProductionQualityGate",
    LINE = "mantle.work.production.ProductionRunLine",
    LOSS = "mantle.work.production.ProductionLoss",
    TEMPLATE = "mantle.product.quality.InspectionTemplate",
    INSPECTION = "mantle.product.quality.QualityInspection",
    DISPOSITION = "mantle.product.quality.QualityInspectionDisposition",
    RECEIPT = "mantle.product.receipt.AssetReceipt",
    PRODUCT = "mantle.product.Product"
const openRunStatuses = ["WeApproved", "WeInProgress", "WeOnHold"]
const openInspection = ["QiDraft", "QiSubmitted"]
const acceptedDispositions = ["QdRelease"]
// the order of a gate's states, worst first (the run's or an operation's overall state)
const stateRank = {failed: 0, pending: 1, required: 2, passed: 3}
const stateText = {required: "Inspection required", pending: "Pending", failed: "Failed", passed: "Passed"}

const zero = () => toDecimal(0)
const dec = value => toDecimal(value ?? 0)
const blank = value => value == null || String(value).trim() === ""
const str = value => (blank(value) ? null : String(value).trim())
const text = value => (value == null ? null : dec(value).compare(0) === 0 ? "0" : String(dec(value).toNumber()))
const production = () => ec.resource.script("component://mr-mantle/service/mantle/work/Production.js")
const quality = () => ec.resource.script("component://mr-mantle/service/mantle/product/Quality.js")
const quantities = () => ec.resource.script("component://mr-mantle/service/mantle/work/ProductionQuantities.js")
const payables = () => ec.resource.script("component://mr-mantle/service/mantle/account/Payables.js")
const enumText = enumId => (enumId ? one("moqui.basic.Enumeration", {enumId})?.description || enumId : "")
const statusText = statusId => (statusId ? one("moqui.basic.StatusItem", {statusId})?.description || statusId : "")
const opName = workEffortId => {
    const op = workEffortId ? one(WORK, {workEffortId}) : null
    return op ? op.workEffortName || op.workEffortId : ""
}
function requireAny(permissions) {
    if (!permissions.some(permission => access.has(permission)))
        denied("PERMISSION_DENIED", permissions.join(" or ") + " is required")
}

// ===== the gates written at release =====
// A published production template of the organization in effect at the time.
function usable(template, organizationPartyId, asOf) {
    return (
        !!template &&
        template.statusId === "QtPublished" &&
        template.organizationPartyId === organizationPartyId &&
        (!template.inspectionContextEnumId || template.inspectionContextEnumId === "QicProduction") &&
        (!template.publishedDate || ms(template.publishedDate) <= ms(asOf))
    )
}
// The published production template of the organization attached to one of the records (an operation or a method).
function attached(organizationPartyId, field, ids, asOf) {
    const wanted = ids.filter(Boolean)
    if (!wanted.length) return null
    return (
        rows(TEMPLATE, {organizationPartyId, statusId: "QtPublished"})
            .filter(row => wanted.includes(row[field]) && usable(row, organizationPartyId, asOf))
            .sort((a, b) => String(a.inspectionTemplateId).localeCompare(b.inspectionTemplateId))[0] || null
    )
}
const stageOf = (template, fallback) => template.productionStageEnumId || fallback
// The run's primary output line: its method's product, else its first output line.
function primaryOf(run, lines) {
    const outputs = lines.filter(line => line.lineRoleEnumId === "PrlrOutput")
    const bom = run.productBomId ? one("mantle.product.bom.ProductBom", {productBomId: run.productBomId}) : null
    return outputs.find(line => bom && line.productId === bom.productId) || outputs[0] || null
}
// The gates a run would keep if released at asOf, from its lines and the routing operations (operationsOf's rows), and the
// operations whose template is not published (problems): {gates: [{routingOperationWorkEffortId, productionRunLineId,
// stage, template, attachedEnumId}], problems: [text]}.
function planGates(run, lines, operations, asOf) {
    const organizationPartyId = run.ownerPartyId
    const outputs = lines.filter(line => line.lineRoleEnumId === "PrlrOutput")
    const primary = primaryOf(run, lines)
    const gates = [],
        problems = []
    for (const op of operations) {
        const routingOp = one(WORK, {workEffortId: op.workEffortId})
        if (!routingOp) continue
        let template = null
        if (routingOp.methodInspectionTemplateId) {
            template = one(TEMPLATE, {inspectionTemplateId: routingOp.methodInspectionTemplateId})
            if (!usable(template, organizationPartyId, asOf)) {
                problems.push(
                    (routingOp.workEffortName || routingOp.workEffortId) +
                        " names inspection template " +
                        routingOp.methodInspectionTemplateId +
                        ", which is not published"
                )
                continue
            }
        } else
            template = attached(
                organizationPartyId,
                "operationWorkEffortId",
                [routingOp.workEffortId, routingOp.methodSourceWorkEffortId],
                asOf
            )
        if (!template) continue
        // an operation's template is its in-process check unless the template is a final one, which then gates the output
        if (stageOf(template, "QpsInProcess") === "QpsFinal") {
            if (primary)
                gates.push({
                    routingOperationWorkEffortId: op.workEffortId,
                    productionRunLineId: primary.productionRunLineId,
                    stage: "QpsFinal",
                    template,
                    attachedEnumId: "PgsOperation"
                })
        } else
            gates.push({
                routingOperationWorkEffortId: op.workEffortId,
                productionRunLineId: null,
                stage: "QpsInProcess",
                template,
                attachedEnumId: "PgsOperation"
            })
    }
    for (const line of outputs) {
        if (gates.some(gate => gate.stage === "QpsFinal" && gate.productionRunLineId === line.productionRunLineId)) continue
        let template = null,
            attachedEnumId = "PgsMethod"
        if (line === primary && run.productBomId)
            template = attached(organizationPartyId, "productBomId", [run.productBomId], asOf)
        if (template && stageOf(template, "QpsFinal") !== "QpsFinal") template = null
        if (!template) {
            template = quality().applicableTemplate(organizationPartyId, line.productId, run.facilityId, "QicProduction", asOf)
            attachedEnumId = "PgsApplicability"
        }
        if (template)
            gates.push({
                routingOperationWorkEffortId: line.routingOperationWorkEffortId || null,
                productionRunLineId: line.productionRunLineId,
                stage: "QpsFinal",
                template,
                attachedEnumId
            })
    }
    return {gates, problems}
}
// The release gate's quality part (ProductionOrders.js releaseGate): refused when an operation names a template that is not
// published; else the impact text of the gates the release keeps.
function releaseCheck(run, lines) {
    if (!run.productionMethodDate && !lines.length) return null
    let operations = []
    try {
        operations = production().operationsOf(
            production().routingsOf(run, lines),
            run.productionMethodDate || ec.user.nowTimestamp
        )
    } catch (error) {
        // the method's own check reports an invalid routing
        return null
    }
    const plan = planGates(run, lines, operations, ec.user.nowTimestamp)
    if (plan.problems.length)
        return {
            allowed: false,
            reasonCode: "TEMPLATE_UNAVAILABLE",
            message: "An inspection template the method needs is not published: " + plan.problems.join("; ")
        }
    if (!plan.gates.length) return {allowed: true, impact: []}
    const inProcess = plan.gates.filter(gate => gate.stage === "QpsInProcess").length
    const final = plan.gates.length - inProcess
    return {
        allowed: true,
        impact: [
            "Keeps " +
                [inProcess ? inProcess + " in-process" : "", final ? final + " final" : ""].filter(Boolean).join(" and ") +
                " quality gate" +
                (plan.gates.length === 1 ? "" : "s") +
                " with the templates as of now" +
                (final ? "; the output is received held for inspection" : "")
        ]
    }
}
// The gates written at release (Production.js release): the operation children by routing operation (children), the frozen
// lines, the release time; then the run marked as reading its gates.
function writeGates(run, lines, operations, children, releaseDate) {
    const plan = planGates(run, lines, operations, releaseDate)
    if (plan.problems.length)
        denied("TEMPLATE_UNAVAILABLE", "An inspection template the method needs is not published: " + plan.problems.join("; "))
    const ids = []
    for (const gate of plan.gates) {
        const t = gate.template
        const created = call("create#" + GATE, {
            workEffortId: run.workEffortId,
            operationWorkEffortId: gate.routingOperationWorkEffortId ? children[gate.routingOperationWorkEffortId] || null : null,
            productionRunLineId: gate.productionRunLineId,
            productionStageEnumId: gate.stage,
            inspectionTemplateId: t.inspectionTemplateId,
            templateName: t.templateName || t.inspectionTemplateId,
            templateAsOfDate: releaseDate,
            samplePolicyEnumId: t.samplePolicyEnumId || "QspAll",
            sampleSize: t.sampleSize ?? null,
            samplePercent: t.samplePercent ?? null,
            sampleBasisEnumId: t.sampleBasisEnumId || "QsbReceipt",
            attachedEnumId: gate.attachedEnumId,
            createdDate: releaseDate
        })
        ids.push(created.productionQualityGateId)
    }
    call("update#" + WORK, {workEffortId: run.workEffortId, productionGatesDate: releaseDate})
    return ids
}
// An unrelease ends the run's gates (their inspections keep their history) and clears the mark.
function endGates(run) {
    for (const gate of rows(GATE, {workEffortId: run.workEffortId}).filter(row => !row.thruDate))
        call("update#" + GATE, {productionQualityGateId: gate.productionQualityGateId, thruDate: ec.user.nowTimestamp})
}
const gatesOf = workEffortId =>
    rows(GATE, {workEffortId})
        .filter(row => !row.thruDate)
        .sort(
            (a, b) =>
                (a.productionStageEnumId === "QpsFinal") - (b.productionStageEnumId === "QpsFinal") ||
                String(a.productionQualityGateId).localeCompare(b.productionQualityGateId)
        )

// ===== the output receipt =====
// The final gate of an output line, or null.
function finalGate(run, line) {
    return (
        gatesOf(run.workEffortId).find(
            gate => gate.productionStageEnumId === "QpsFinal" && gate.productionRunLineId === line.productionRunLineId
        ) || null
    )
}
// Whether an output receipt is received held for inspection, and the gate it answers: a final gate of the line; the tracking
// policy's inspectionRequired; for a run released before its gates were kept, a production template that applies now.
function outputInspection(run, line, facility, productId, policy) {
    const gate = run.productionGatesDate ? finalGate(run, line) : null
    if (gate) return {inspect: true, gate}
    if (policy.tracking?.inspectionRequired === "Y") return {inspect: true, gate: null}
    if (run.productionGatesDate) return {inspect: false, gate: null}
    return {inspect: quality().outputNeedsInspection(facility, productId, policy), gate: null}
}
// The template, as-of time, sample and production links an inspection of a gate takes (Quality.js createInspection): the
// sample by the gate's policy on the receipt's quantity, or on the line's target for the run basis, never above the
// quantity inspected.
function inspectionPlan(gate, quantity) {
    const line = gate.productionRunLineId ? one(LINE, {productionRunLineId: gate.productionRunLineId}) : null
    const basis =
        gate.sampleBasisEnumId === "QsbRun" && line
            ? dec(line.stockQuantity).compare(quantity) > 0
                ? dec(line.stockQuantity)
                : quantity
            : quantity
    let sample = basis
    if (gate.samplePolicyEnumId === "QspFixed") sample = dec(gate.sampleSize).compare(basis) > 0 ? basis : dec(gate.sampleSize)
    else if (gate.samplePolicyEnumId === "QspPercent") {
        const percent = Math.ceil((basis.toNumber() * dec(gate.samplePercent).toNumber()) / 100)
        sample = toDecimal(Math.max(1, Math.min(basis.toNumber(), percent)))
    }
    if (sample.compare(quantity) > 0) sample = quantity
    if (sample.compare(0) <= 0) sample = quantity
    return {
        inspectionTemplateId: gate.inspectionTemplateId,
        templateAsOfDate: gate.templateAsOfDate,
        sampleSize: sample,
        operationWorkEffortId: gate.operationWorkEffortId || null,
        productionRunLineId: gate.productionRunLineId || null,
        productionQualityGateId: gate.productionQualityGateId
    }
}

// ===== a gate's state =====
// What is left to dispose of an inspection: its accepted quantity less Release, its rejected less the others.
function leftOf(inspection) {
    const done = rows(DISPOSITION, {qualityInspectionId: inspection.qualityInspectionId})
    const taken = test => done.filter(row => test(row.dispositionEnumId)).reduce((sum, row) => sum.add(dec(row.quantity)), zero())
    return {
        accepted: dec(inspection.quantityAccepted).subtract(taken(id => acceptedDispositions.includes(id))),
        rejected: dec(inspection.quantityRejected).subtract(taken(id => !acceptedDispositions.includes(id))),
        dispositions: done
    }
}
// One inspection's outcome for its gate: pending while open, or while a final inspection's stock is still held; failed
// while a verified rejection is left to dispose; passed otherwise (accepted, or the rejection disposed: scrapped, reworked,
// used as is).
function outcomeOf(inspection, final) {
    if (openInspection.includes(inspection.statusId)) return "pending"
    const left = leftOf(inspection)
    if (inspection.statusId === "QiVerified" && left.rejected.compare(0) > 0) return "failed"
    if (final && dec(inspection.heldQuantity).compare(0) > 0) return "pending"
    return "passed"
}
const inspectionsOfGate = productionQualityGateId =>
    rows(INSPECTION, {productionQualityGateId})
        .filter(row => row.statusId !== "QiCancelled")
        .sort((a, b) => (ms(a.createdDate) ?? 0) - (ms(b.createdDate) ?? 0))
// A gate's state: an in-process gate by its latest inspection (a reinspection supersedes, the earlier result kept), a final
// gate by the worst of its receipts' inspections; the inspection that decides it.
function stateOf(gate) {
    const final = gate.productionStageEnumId === "QpsFinal"
    const inspections = inspectionsOfGate(gate.productionQualityGateId)
    if (!inspections.length) return {state: "required", inspections, decidingInspection: null}
    if (!final) {
        const latest = inspections[inspections.length - 1]
        return {state: outcomeOf(latest, false), inspections, decidingInspection: latest}
    }
    let worst = null,
        state = "passed"
    for (const inspection of inspections) {
        const outcome = outcomeOf(inspection, true)
        if (stateRank[outcome] < stateRank[state]) {
            state = outcome
            worst = inspection
        }
    }
    return {state, inspections, decidingInspection: worst || inspections[inspections.length - 1]}
}
// The words of a gate that is not passed, naming its inspection.
function blockText(gate, read) {
    const where =
        gate.productionStageEnumId === "QpsFinal"
            ? "the final inspection of " + (one(PRODUCT, {productId: lineProduct(gate)})?.productName || "the output")
            : "the inspection of " + opName(gate.operationWorkEffortId)
    const id = read.decidingInspection?.qualityInspectionId
    if (read.state === "required") return where + " is required"
    if (read.state === "failed") return "inspection " + id + " (" + where + ") failed"
    return "inspection " + id + " (" + where + ") is pending"
}
const lineProduct = gate =>
    gate.productionRunLineId ? one(LINE, {productionRunLineId: gate.productionRunLineId})?.productId : null

// ===== the guards =====
// Start and resume (ProductionOrders.js check): a run with a failed in-process gate stays as it is until its inspection is
// disposed or inspected again.
function startGate(run) {
    // an in-process failure holds the run; a final one holds its output (received held), not the run
    for (const gate of gatesOf(run.workEffortId).filter(row => row.productionStageEnumId === "QpsInProcess")) {
        const read = stateOf(gate)
        if (read.state === "failed")
            return {
                allowed: false,
                reasonCode: "QUALITY_BLOCKED",
                qualityInspectionId: read.decidingInspection.qualityInspectionId,
                message: "Work order " + run.workEffortId + " is blocked: " + blockText(gate, read)
            }
    }
    return null
}
// Complete (ProductionQuantities.js completeCheck): no final inspection pending or failed, and each in-process gate passed.
function completeGate(run) {
    // the output's final inspections first, then the operations' gates
    const gates = gatesOf(run.workEffortId).sort(
        (a, b) => (b.productionStageEnumId === "QpsFinal") - (a.productionStageEnumId === "QpsFinal")
    )
    for (const gate of gates) {
        const read = stateOf(gate)
        const final = gate.productionStageEnumId === "QpsFinal"
        if (read.state === "passed" || (final && read.state === "required")) continue
        return {
            allowed: false,
            reasonCode: final ? (read.state === "failed" ? "INSPECTION_FAILED" : "INSPECTION_PENDING") : "QUALITY_GATE_OPEN",
            qualityInspectionId: read.decidingInspection?.qualityInspectionId || null,
            message: "Work order " + run.workEffortId + " cannot complete: " + blockText(gate, read)
        }
    }
    return null
}
// The operations each operation follows: its predecessors through the routing (transitively) when the routing names any,
// else those before it in sequence.
function precedingOf(run) {
    const children = rows(WORK, {parentWorkEffortId: run.workEffortId}).filter(op => op.statusId !== "WeCancelled")
    const byRouting = new Map(children.map(op => [op.routingOperationWorkEffortId, op.workEffortId]))
    const methodDate = run.productionMethodDate || ec.user.nowTimestamp
    const direct = new Map()
    for (const routingId of production().routingsOf(run, production().linesOf(run.workEffortId)))
        for (const assoc of rows(ASSOC, {workEffortId: routingId, workEffortAssocTypeEnumId: "WeatRoutingComp"}).filter(row =>
            lib.active(row, methodDate)
        )) {
            const child = byRouting.get(assoc.toWorkEffortId)
            if (!child) continue
            const ids = String(assoc.predecessorWorkEffortIds || "")
                .split(/[\s,]+/)
                .filter(Boolean)
                .map(id => byRouting.get(id))
                .filter(Boolean)
            direct.set(child, ids)
        }
    const named = Array.from(direct.values()).some(ids => ids.length)
    const preceding = new Map()
    for (const op of children) {
        if (!named) {
            const sequence = Number(op.operationSequenceNum ?? op.sequenceNum ?? 0)
            preceding.set(
                op.workEffortId,
                children
                    .filter(other => Number(other.operationSequenceNum ?? other.sequenceNum ?? 0) < sequence)
                    .map(other => other.workEffortId)
            )
            continue
        }
        const seen = new Set(),
            stack = [...(direct.get(op.workEffortId) || [])]
        while (stack.length) {
            const id = stack.pop()
            if (seen.has(id) || id === op.workEffortId) continue
            seen.add(id)
            stack.push(...(direct.get(id) || []))
        }
        preceding.set(op.workEffortId, Array.from(seen))
    }
    return preceding
}
// The operations an in-process gate not passed holds (get#ProductionOperations' readiness; P10's operation start): by
// operation, the first such gate of the operations it follows, with its inspection and words.
function operationBlocks(run) {
    const gates = gatesOf(run.workEffortId).filter(gate => gate.productionStageEnumId === "QpsInProcess")
    if (!gates.length) return {}
    const reads = new Map(gates.map(gate => [gate.productionQualityGateId, stateOf(gate)]))
    const preceding = precedingOf(run)
    const blocks = {}
    for (const [operationId, before] of preceding) {
        const gate = gates.find(
            row => before.includes(row.operationWorkEffortId) && reads.get(row.productionQualityGateId).state !== "passed"
        )
        if (!gate) continue
        const read = reads.get(gate.productionQualityGateId)
        blocks[operationId] = {
            allowed: false,
            reasonCode: "QUALITY_GATE",
            productionQualityGateId: gate.productionQualityGateId,
            qualityInspectionId: read.decidingInspection?.qualityInspectionId || null,
            state: read.state,
            message: "Blocked: " + blockText(gate, read)
        }
    }
    return blocks
}
// One operation's start check (P10's start#ProductionOperation): null when no gate holds it.
function operationGate(run, operationWorkEffortId) {
    return operationBlocks(run)[operationWorkEffortId] || null
}

// ===== get#SourceInspectionStatus for production sources =====
function gateRow(run, gate) {
    const read = stateOf(gate)
    const final = gate.productionStageEnumId === "QpsFinal"
    const deciding = read.decidingInspection
    const held = read.inspections.reduce((sum, row) => sum.add(dec(row.heldQuantity)), zero())
    const line = gate.productionRunLineId ? one(LINE, {productionRunLineId: gate.productionRunLineId}) : null
    const dispositions = deciding ? leftOf(deciding).dispositions : []
    const sampleText =
        gate.samplePolicyEnumId === "QspFixed"
            ? text(gate.sampleSize) + " units"
            : gate.samplePolicyEnumId === "QspPercent"
              ? text(gate.samplePercent) + "%"
              : "every unit"
    return {
        productionQualityGateId: gate.productionQualityGateId,
        productionStageEnumId: gate.productionStageEnumId,
        stageText: enumText(gate.productionStageEnumId),
        operationWorkEffortId: gate.operationWorkEffortId || null,
        operationName: opName(gate.operationWorkEffortId),
        productionRunLineId: gate.productionRunLineId || null,
        productId: line?.productId || null,
        productName: line ? one(PRODUCT, {productId: line.productId})?.productName || line.productId : "",
        inspectionTemplateId: gate.inspectionTemplateId,
        templateName: gate.templateName,
        templateAsOfDate: gate.templateAsOfDate,
        templateAsOfText: lib.dateText(gate.templateAsOfDate),
        attachedText: enumText(gate.attachedEnumId),
        sampleText: sampleText + (gate.sampleBasisEnumId === "QsbRun" ? " of the run" : " of each receipt"),
        state: read.state,
        stateText: stateText[read.state],
        blocking: read.state !== "passed" && !(final && read.state === "required"),
        blockText: read.state === "passed" ? "" : blockText(gate, read),
        inspectionCount: read.inspections.length,
        qualityInspectionId: deciding?.qualityInspectionId || null,
        inspectionStatusText: deciding ? statusText(deciding.statusId) : "",
        resultText: deciding?.resultEnumId ? enumText(deciding.resultEnumId) : "",
        heldQuantity: text(held),
        dispositionText: dispositions.map(row => enumText(row.dispositionEnumId) + " " + text(row.quantity)).join(", "),
        inspectionIds: read.inspections.map(row => row.qualityInspectionId),
        canCreate:
            !final &&
            access.has("QUALITY_INSPECT") &&
            openRunStatuses.includes(run.statusId) &&
            !read.inspections.some(row => openInspection.includes(row.statusId) || row.statusId === "QiVerified") &&
            read.state !== "passed"
    }
}
// The gates of a run, or of its operation or output line, with their state, the worst of them, the inspection that decides
// it, the held quantity and, for an operation, whether a gate before it holds its start. Needs a production or quality
// permission and the run in the user's organizations.
function sourceStatus(p) {
    requireAny([
        "PRODUCTION_VIEW",
        "PRODUCTION_OPERATE",
        "PRODUCTION_SUPERVISE",
        "QUALITY_INSPECT",
        "QUALITY_VERIFY",
        "QUALITY_DISPOSE"
    ])
    const userScope = posting.scope()
    let runId = str(p.workEffortId)
    const operation = blank(p.operationWorkEffortId) ? null : one(WORK, {workEffortId: p.operationWorkEffortId})
    const line = blank(p.productionRunLineId) ? null : one(LINE, {productionRunLineId: p.productionRunLineId})
    if (!blank(p.operationWorkEffortId) && !operation)
        denied("RECORD_UNAVAILABLE", "Operation " + p.operationWorkEffortId + " is not available")
    if (!blank(p.productionRunLineId) && !line)
        denied("RECORD_UNAVAILABLE", "Line " + p.productionRunLineId + " is not available")
    if (!runId) runId = operation ? operation.rootWorkEffortId || operation.parentWorkEffortId : line.workEffortId
    const run = production().runOf(userScope, runId)
    if (operation && operation.parentWorkEffortId !== run.workEffortId)
        denied("RECORD_UNAVAILABLE", "Operation " + operation.workEffortId + " is not available")
    if (line && line.workEffortId !== run.workEffortId)
        denied("RECORD_UNAVAILABLE", "Line " + line.productionRunLineId + " is not available")
    let gates = gatesOf(run.workEffortId)
    if (operation) gates = gates.filter(gate => gate.operationWorkEffortId === operation.workEffortId)
    if (line) gates = gates.filter(gate => gate.productionRunLineId === line.productionRunLineId)
    const gateRows = gates.map(gate => gateRow(run, gate))
    let worst = null
    for (const row of gateRows) if (!worst || stateRank[row.state] < stateRank[worst.state]) worst = row
    const block = operation ? operationGate(run, operation.workEffortId) : null
    return {
        workEffortId: run.workEffortId,
        gated: !!run.productionGatesDate,
        gateRows,
        gateStatus: worst ? worst.state : "none",
        gateStatusText: worst ? stateText[worst.state] : "No quality gate",
        blockingInspectionId: worst && worst.state !== "passed" ? worst.qualityInspectionId : null,
        blockingText: worst && worst.blocking ? worst.blockText : "",
        heldQuantity: gateRows.reduce((sum, row) => sum.add(dec(row.heldQuantity)), zero()),
        startAllowed: !block,
        startBlockText: block ? block.message : "",
        startBlockInspectionId: block ? block.qualityInspectionId : null
    }
}

// ===== create#ProductionInspection =====
// An inspection of an in-process gate of an open run (QUALITY_INSPECT): the run's output product at its facility, the
// quantity inspected (the output line's target by default), the gate's template as of the release with its sample, the
// inspector and due date; one open inspection a gate (INSPECTION_EXISTS); a final gate's inspections come with the output
// receipt (GATE_FINAL); a passed gate needs no other (GATE_PASSED).
function createInspection(p) {
    requireAny(["QUALITY_INSPECT"])
    const userScope = posting.scope()
    const run = production().runOf(userScope, p.workEffortId, true)
    if (!openRunStatuses.includes(run.statusId))
        denied("RUN_NOT_OPEN", "Work order " + run.workEffortId + " is " + statusText(run.statusId))
    const gate = blank(p.productionQualityGateId) ? null : one(GATE, {productionQualityGateId: p.productionQualityGateId})
    if (!gate || gate.workEffortId !== run.workEffortId || gate.thruDate)
        denied("RECORD_UNAVAILABLE", "Quality gate " + (p.productionQualityGateId || "") + " is not available")
    if (gate.productionStageEnumId === "QpsFinal")
        denied("GATE_FINAL", "A final gate's inspections are created by the output receipt, which holds the output")
    const read = stateOf(gate)
    if (read.inspections.some(row => openInspection.includes(row.statusId) || row.statusId === "QiVerified"))
        denied("INSPECTION_EXISTS", "The gate already has inspection " + read.decidingInspection.qualityInspectionId + " open")
    if (read.state === "passed") denied("GATE_PASSED", "The gate's inspection passed")
    const output = primaryOf(run, production().linesOf(run.workEffortId))
    const quantity = blank(p.quantity) ? dec(output?.stockQuantity) : dec(p.quantity)
    const plan = inspectionPlan(gate, quantity)
    if (!blank(p.sampleSize)) plan.sampleSize = null
    const created = quality().createInspection(
        userScope,
        {
            facilityId: run.facilityId,
            productId: output?.productId || null,
            quantity,
            workEffortId: run.workEffortId,
            sourceTypeEnumId: "QisWorkEffort",
            inspectionContextEnumId: "QicProduction",
            sampleSize: str(p.sampleSize),
            inspectorPartyId: str(p.inspectorPartyId),
            dueDate: p.dueDate || null,
            comments: str(p.comments)
        },
        plan
    )
    return {
        qualityInspectionId: created.qualityInspectionId,
        productionQualityGateId: gate.productionQualityGateId,
        inspectionTemplateId: created.inspectionTemplateId
    }
}

// ===== after a verification and a scrap disposition (Quality.js) =====
// A production inspection verified with a rejection blocks its gate: the run's supervisors are told, naming what it holds.
function afterVerify(inspection) {
    if (!inspection.workEffortId) return null
    const current = one(INSPECTION, {qualityInspectionId: inspection.qualityInspectionId})
    if (current.statusId !== "QiVerified" || dec(current.quantityRejected).compare(0) <= 0) return null
    const run = one(WORK, {workEffortId: current.workEffortId})
    if (!run || run.purposeEnumId !== "WepProductionRun") return null
    const gate = current.productionQualityGateId ? one(GATE, {productionQualityGateId: current.productionQualityGateId}) : null
    const holds =
        gate?.productionStageEnumId === "QpsInProcess"
            ? "the operations after " + opName(gate.operationWorkEffortId)
            : "the output and the work order's completion"
    try {
        return payables().execute("notify", {
            topic: "ProductionQualityBlock",
            permission: "PRODUCTION_SUPERVISE",
            organizationPartyId: run.ownerPartyId,
            recordEntityName: WORK,
            recordId: run.workEffortId,
            message: {
                workEffortId: run.workEffortId,
                workEffortName: run.workEffortName || run.workEffortId,
                qualityInspectionId: current.qualityInspectionId,
                organizationPartyId: run.ownerPartyId,
                quantityRejected: text(current.quantityRejected),
                decision: "rejected " + text(current.quantityRejected) + ": it holds " + holds
            }
        })
    } catch (error) {
        ec.logger.error("Quality block notice of inspection " + current.qualityInspectionId + " was not sent: " + error.message)
        return null
    }
}
// A scrap disposition of output of an open run (dispose#Inspection, which checked QUALITY_DISPOSE and the inspection): P7's
// loss path, an approved PltOutputScrap of the held asset issued back to the run (so the loss reaches production variance at
// the cost close, never shrinkage). Null when the stock is not output of an open run (Quality.js then scraps it as stock).
function scrapToRun(userScope, inspection, asset, quantity, p) {
    if (!inspection.workEffortId || !asset) return null
    const run = one(WORK, {workEffortId: inspection.workEffortId})
    if (!run || run.purposeEnumId !== "WepProductionRun" || !openRunStatuses.includes(run.statusId)) return null
    const receipt = rows(RECEIPT, {assetId: asset.assetId, workEffortId: run.workEffortId}).find(
        row => row.productionOutputLineId
    )
    if (!receipt) return null
    const line = one(LINE, {productionRunLineId: receipt.productionOutputLineId})
    const reason = str(p.reason)
    const loss = call("create#" + LOSS, {
        organizationPartyId: run.ownerPartyId,
        workEffortId: run.workEffortId,
        operationWorkEffortId: inspection.operationWorkEffortId || receipt.operationWorkEffortId || null,
        productionRunLineId: line.productionRunLineId,
        lossTypeEnumId: "PltOutputScrap",
        productId: asset.productId,
        assetId: asset.assetId,
        lotId: asset.lotId || null,
        quantity,
        quantityUomId: line.stockUomId || null,
        fromHeld: "Y",
        reasonName: "Inspection " + inspection.qualityInspectionId + " scrap" + (reason ? ": " + reason : ""),
        reasonCategoryEnumId: "PrcScrap",
        comments: "Disposition of inspection " + inspection.qualityInspectionId,
        statusId: "PlsApproved",
        requestedByUserId: ec.user.userId,
        approvedByUserId: ec.user.userId,
        approvedDate: ec.user.nowTimestamp,
        lossDate: ec.user.nowTimestamp,
        createdByUserId: ec.user.userId
    })
    const row = one(LOSS, {productionLossId: loss.productionLossId})
    const effects = quantities().applyLoss(userScope, run, row)
    return {productionLossId: row.productionLossId, assetIssuanceId: effects.assetIssuanceId || null}
}

const operations = {
    sourceStatus,
    createInspection
}
;({
    planGates,
    releaseCheck,
    writeGates,
    endGates,
    gatesOf,
    finalGate,
    outputInspection,
    inspectionPlan,
    stateOf,
    startGate,
    completeGate,
    operationBlocks,
    operationGate,
    afterVerify,
    scrapToRun,
    execute: (op, parameters) => {
        if (!operations[op]) throw new Error("Unknown production quality operation " + op)
        return operations[op](parameters)
    }
})
