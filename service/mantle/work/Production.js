// Manufacturing's production runs and the production stock guards (design-manufacturing §12 M2 and M4, NewWorkOrder,
// WorkOrderDetail, MaterialIssueReceipt, SubcontractDetail; built by impl-warehouse P16): what the entry points of
// mantle.work.ProductionServices add to StockPosting.js's steps.
// A run (WepProductionRun) is made by create#ProductionOrder through Mantle's create#ProductionRun without the legacy
// consume and produce products (no PatMfgBom row is read or written): its own lines (ProductionRunLine) come from Products'
// released BOM and routing as of the method date (get#BomExplosion): the output line, a material line per required
// component (the explosion stops at non-phantom sub-assemblies and blows phantoms through with their routing), and the
// by-products; the WorkEffortProduct WeptConsume/WeptProduce rows are the per-product aggregate planning reads.
// release#ProductionOrder freezes the lines, stamps the release time and the effective approved standard cost, refuses a
// method released again since the method date unless re-exploded as of now, creates the operation children (routing
// operation, sequence, work center, the run's owner) and rewrites the WorkEffortProduct rows from the lines.
// The stock guards issue to a material line (always a new AssetIssuance, never added to an earlier one), return unused
// material as a new receipt fact at its original cost (never cancel#AssetIssuance), receive output at the run's frozen
// standard unit cost (or, with none, the issued cost to date over the quantity, provisional), into quarantine with an
// inspection when one applies, and receive a subcontract's output from the vendor-custody facility in one transaction.
// Every movement carries the run's workEffortId; the line and operation go on the movement (CX-PRODUCTION).
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const posting = ec.resource.script("component://mr-mantle/service/mantle/shipment/StockPosting.js")
const facilityScope = ec.resource.script("component://mr-mantle/service/mantle/facility/FacilityScope.js")
const {find, one, rows, call, denied} = lib

const WORK = "mantle.work.effort.WorkEffort",
    WEP = "mantle.work.effort.WorkEffortProduct",
    LINE = "mantle.work.production.ProductionRunLine",
    ISSUANCE = "mantle.product.issuance.AssetIssuance",
    RECEIPT = "mantle.product.receipt.AssetReceipt",
    ASSET = "mantle.product.asset.Asset",
    PRODUCT = "mantle.product.Product",
    FACILITY = "mantle.facility.Facility",
    BOM = "mantle.product.bom.ProductBom",
    DECISION = "mantle.work.method.MethodReleaseDecision",
    STANDARD = "mantle.product.cost.ProductStandardCost",
    ACCEPTANCE = "mantle.order.purchase.ServiceAcceptance"
// a run takes stock while released or running
const releasedStatuses = ["WeApproved", "WeInProgress"]
const closedStatuses = ["WeClosed", "WeCancelled"]
const zero = () => toDecimal(0)
const dec = value => toDecimal(value ?? 0)
const blank = value => value == null || String(value).trim() === ""
const str = value => (blank(value) ? null : String(value))
const text = value => (value == null ? null : dec(value).compare(0) === 0 ? "0" : String(dec(value).toNumber()))
const day = value => (value == null ? "" : ec.l10n.format(new Date(lib.ms(value)), "yyyy-MM-dd HH:mm"))
const methodPolicy = () => ec.resource.script("component://mr-mantle/service/mantle/product/MethodPolicy.js")

// ===== the run =====
// A production run of the user's organizations (its owner, and its facility's owner): a missing one and one outside the
// scope are refused alike.
function runOf(userScope, workEffortId, lock = false) {
    const run = blank(workEffortId) ? null : find(WORK, {workEffortId}).forUpdate(lock).one()
    const facility = run?.facilityId ? one(FACILITY, {facilityId: run.facilityId}) : null
    if (
        !run ||
        run.purposeEnumId !== "WepProductionRun" ||
        !facilityScope.owns(userScope, run.ownerPartyId) ||
        (facility && !facilityScope.owns(userScope, facility.ownerPartyId))
    )
        denied("RECORD_UNAVAILABLE", "Production run " + (workEffortId || "") + " is not available")
    return run
}
const linesOf = workEffortId =>
    rows(LINE, {workEffortId}).sort(
        (a, b) =>
            Number(a.lineSeqNum || 0) - Number(b.lineSeqNum || 0) ||
            String(a.productionRunLineId).localeCompare(b.productionRunLineId)
    )
// A line of the run in one of the roles, locked when asked; a line of another run is refused (a client-supplied child id).
function lineOf(run, productionRunLineId, roles, lock = false) {
    const line = blank(productionRunLineId) ? null : find(LINE, {productionRunLineId}).forUpdate(lock).one()
    if (!line || line.workEffortId !== run.workEffortId || (roles && !roles.includes(line.lineRoleEnumId)))
        denied(
            "LINE_INVALID",
            "Line " + (productionRunLineId || "") + " is not a " + (roles || []).join(" or ") + " line of run " + run.workEffortId
        )
    return line
}
// The run's output line: the one named, else its only output line.
function outputLineOf(run, productionRunLineId, lock = false) {
    if (!blank(productionRunLineId)) return lineOf(run, productionRunLineId, ["PrlrOutput", "PrlrByproduct"], lock)
    const outputs = linesOf(run.workEffortId).filter(line => line.lineRoleEnumId === "PrlrOutput")
    if (outputs.length !== 1) denied("LINE_REQUIRED", "Choose the output line of run " + run.workEffortId)
    return lineOf(run, outputs[0].productionRunLineId, ["PrlrOutput"], lock)
}
// An operation child of the run (operations never carry stock; the movement names it), or none.
function operationOf(run, operationWorkEffortId) {
    if (blank(operationWorkEffortId)) return null
    const op = one(WORK, {workEffortId: operationWorkEffortId})
    if (!op || op.parentWorkEffortId !== run.workEffortId)
        denied("OPERATION_INVALID", "Operation " + operationWorkEffortId + " is not an operation of run " + run.workEffortId)
    return op.workEffortId
}
function requireReleased(run) {
    if (!releasedStatuses.includes(run.statusId))
        denied("RUN_NOT_RELEASED", "Production run " + run.workEffortId + " is " + run.statusId + "; release it first")
}

// ===== the method: Products' released BOM and routing as of a date =====
// The product's released BOM of the organization at the date: the one given, else its MAIN method, else its only one.
function chooseBom(productId, organizationPartyId, date) {
    const released = rows(BOM, {productId, organizationPartyId}).filter(bom =>
        rows(DECISION, {methodEntityName: BOM, methodId: bom.productBomId}).some(row => lib.ms(row.fromDate) <= lib.ms(date))
    )
    const main = released.filter(bom => bom.methodCode === "MAIN")
    if (main.length === 1) return main[0]
    if (released.length === 1) return released[0]
    if (released.length) denied("METHOD_AMBIGUOUS", "Several released BOMs make " + productId + "; choose one")
    return null
}
// The operations of the routings as of the date, each routing's in its sequence: the routing operation, its name,
// sequence and work center.
function operationsOf(routingIds, date) {
    const routings = ec.resource.script("component://mr-mantle/service/mantle/work/Routings.js")
    const out = []
    for (const routingWorkEffortId of routingIds) {
        let released
        try {
            released = routings.released(routingWorkEffortId, date)
        } catch (error) {
            denied(
                "METHOD_INVALID",
                "Routing " + routingWorkEffortId + ": " + String(error.message || error).replace(/^(Error: )+/, "")
            )
        }
        const operations = Array.from(released.operations || []).sort(
            (a, b) => Number(a.sequenceNum || 0) - Number(b.sequenceNum || 0)
        )
        for (const op of operations)
            out.push({
                routingWorkEffortId,
                workEffortId: op.workEffortId,
                workEffortName: op.workEffortName || null,
                sequenceNum: op.sequenceNum == null ? null : Number(op.sequenceNum),
                workCenterFacilityId: op.workCenterFacilityId || null
            })
    }
    return out
}
// A line from an explosion row: its BOM line, product, gross quantity and unit, the exact conversion to the stock unit,
// and the routing operation that consumes (or yields) it.
function lineFrom(row, role) {
    return {
        lineRoleEnumId: role,
        productId: row.productId,
        quantity: dec(row.grossQuantity),
        quantityUomId: row.quantityUomId || null,
        stockQuantity: dec(row.inventoryQuantity),
        stockUomId: row.inventoryUomId || null,
        conversionFactor: dec(row.conversionFactor ?? 1),
        uomConversionId: row.uomConversionId || null,
        scrapFactor: row.scrapFactor ?? null,
        substitutionRuleEnumId: row.substitutionRuleEnumId || null,
        bomItemId: row.bomItemId,
        productBomId: row.productBomId,
        bomPath: row.path,
        routingOperationWorkEffortId: row.operationWorkEffortId || null
    }
}
// The run's lines and operations from the method as of the date (§4): the output line, a material line per component the
// explosion requires for production (it stops at non-phantom sub-assemblies, whose stock counts), the by-products of the
// run's BOM and of the phantoms blown through, and the operations of the run's routing after those of the phantoms'.
function method(organizationPartyId, product, quantity, quantityUomId, date, productBomId, givenRoutingId = null) {
    const bom = blank(productBomId) ? chooseBom(product.productId, organizationPartyId, date) : one(BOM, {productBomId})
    if (!bom)
        denied(
            "METHOD_REQUIRED",
            "Product " + product.productId + " has no released BOM of " + organizationPartyId + " at this date"
        )
    if (bom.productId !== product.productId || bom.organizationPartyId !== organizationPartyId)
        denied(
            "METHOD_INVALID",
            "BOM " + bom.productBomId + " is not a method of " + product.productId + " for " + organizationPartyId
        )
    let ex
    try {
        ex = call("mantle.product.BomServices.get#BomExplosion", {
            productBomId: bom.productBomId,
            asOfDate: date,
            quantity,
            quantityUomId: quantityUomId || null
        })
    } catch (error) {
        denied("METHOD_INVALID", String(error.message || error).replace(/^(Error: )+/, ""))
    }
    const findings = Array.from(ex.findings || [])
    if (findings.length) denied("METHOD_INVALID", findings.map(row => (row.recordId || "") + ": " + row.message).join("; "))
    const header = ex.productBom
    const all = Array.from(ex.explosionRows || [])
    const byPath = new Map(all.map(row => [row.path, row]))
    // a row is the run's when each row above it is a phantom blown through
    const inRun = row => {
        for (let parent = byPath.get(row.parentPath); parent; parent = byPath.get(parent.parentPath))
            if (parent.isPhantom !== "Y" || parent.requiredForProduction) return false
        return true
    }
    const materials = all.filter(row => row.applicable && row.roleEnumId === "BmirConsume" && row.requiredForProduction)
    const byproducts = all.filter(row => row.applicable && row.roleEnumId === "BmirByproduct" && inRun(row))
    const phantoms = all.filter(row => row.applicable && row.isPhantom === "Y" && !row.requiredForProduction && inRun(row))
    const routingIds = []
    for (const phantom of phantoms) {
        const detail = call("mantle.product.BomServices.get#BomDetail", {
            productBomId: phantom.componentProductBomId,
            asOfDate: date
        })
        const routingId = detail.approvedHeader?.routingWorkEffortId
        if (routingId && !routingIds.includes(routingId)) routingIds.push(routingId)
    }
    // the routing given, else the BOM's; each line's consuming operation must be one of the run's
    const routingWorkEffortId = str(givenRoutingId) || header.routingWorkEffortId || null
    if (routingWorkEffortId && !routingIds.includes(routingWorkEffortId)) routingIds.push(routingWorkEffortId)
    const operations = operationsOf(routingIds, date)
    const operationIds = new Set(operations.map(op => op.workEffortId))
    const stray = materials
        .concat(byproducts)
        .find(row => row.operationWorkEffortId && !operationIds.has(row.operationWorkEffortId))
    if (stray)
        denied(
            "METHOD_INVALID",
            "BOM line " + stray.bomItemId + "'s operation is not in routing " + (routingWorkEffortId || "(none)")
        )
    const outputUomId = quantityUomId || header.quantityUomId
    const stockUomId = product.amountUomId || outputUomId
    const converted = methodPolicy().convert(quantity, outputUomId, stockUomId, date)
    const lines = [
        {
            lineRoleEnumId: "PrlrOutput",
            productId: product.productId,
            quantity: dec(quantity),
            quantityUomId: outputUomId,
            stockQuantity: converted.quantity,
            stockUomId,
            conversionFactor: converted.factor,
            uomConversionId: converted.uomConversionId || null,
            productBomId: bom.productBomId,
            routingOperationWorkEffortId: operations.length ? operations[operations.length - 1].workEffortId : null
        },
        ...materials.map(row => lineFrom(row, "PrlrMaterial")),
        ...byproducts.map(row => lineFrom(row, "PrlrByproduct"))
    ]
    // the methods the run was read from: its BOM and the phantoms' (each checked for a later release), and its routings in
    // order, the phantoms' first (the operation children come from these, whether or not a line names an operation)
    const bomIds = [bom.productBomId, ...phantoms.map(row => row.componentProductBomId).filter(Boolean)]
    const refs = JSON.stringify({bomIds: [...new Set(bomIds)], routingIds})
    return {bom, header, routingWorkEffortId, routingIds, operations, lines, refs}
}
// The run's lines written (draft): a stable id each, in sequence.
function writeLines(workEffortId, lines) {
    lines.forEach((line, index) => call("create#" + LINE, Object.assign({}, line, {workEffortId, lineSeqNum: (index + 1) * 10})))
}
// The WorkEffortProduct rows planning reads, from the lines in the stock unit: WeptConsume per material product,
// WeptProduce per output and by-product; a row kept is updated, a product no longer on the run ended (M4, R-SA-05).
function writeProducts(workEffortId, lines) {
    const now = ec.user.nowTimestamp
    const wanted = new Map()
    for (const line of lines) {
        const typeEnumId = line.lineRoleEnumId === "PrlrMaterial" ? "WeptConsume" : "WeptProduce"
        const key = line.productId
        const row = wanted.get(key) || {productId: line.productId, typeEnumId, quantity: zero()}
        row.quantity = row.quantity.add(dec(line.stockQuantity))
        wanted.set(key, row)
    }
    const current = rows(WEP, {workEffortId}).filter(
        row => lib.active(row, now) && ["WeptConsume", "WeptProduce"].includes(row.typeEnumId)
    )
    for (const row of current) {
        const keep = wanted.get(row.productId)
        if (keep && keep.typeEnumId === row.typeEnumId) {
            call("update#" + WEP, {
                workEffortId,
                productId: row.productId,
                fromDate: row.fromDate,
                estimatedQuantity: keep.quantity
            })
            wanted.delete(row.productId)
        } else call("update#" + WEP, {workEffortId, productId: row.productId, fromDate: row.fromDate, thruDate: now})
    }
    for (const row of wanted.values())
        call("create#" + WEP, {
            workEffortId,
            productId: row.productId,
            typeEnumId: row.typeEnumId,
            fromDate: now,
            estimatedQuantity: row.quantity
        })
}
// The releases of the run's methods (its BOM, a phantom's BOM, its routings) made after its method date and in effect by
// now: a release since the draft was read (R-SA-12).
function laterReleases(run, lines, now) {
    const refs = refsOf(run)
    const bomIds = new Set([run.productBomId, ...(refs?.bomIds || []), ...lines.map(line => line.productBomId)].filter(Boolean))
    const routingIds = new Set(
        [
            run.productionRoutingId,
            ...lines.map(
                line =>
                    line.routingOperationWorkEffortId &&
                    one(WORK, {
                        workEffortId: line.routingOperationWorkEffortId
                    })?.parentWorkEffortId
            ),
            ...(refs?.routingIds || [])
        ].filter(Boolean)
    )
    const since = lib.ms(run.productionMethodDate),
        until = lib.ms(now)
    const later = []
    for (const [entity, ids] of [
        [BOM, bomIds],
        [WORK, routingIds]
    ])
        for (const methodId of ids)
            for (const row of rows(DECISION, {methodEntityName: entity, methodId}))
                if (lib.ms(row.fromDate) > since && lib.ms(row.fromDate) <= until)
                    later.push({methodEntityName: entity, methodId, fromDate: row.fromDate})
    return later
}
// The methods a run was read from (create#ProductionOrder or a re-explosion): {bomIds, routingIds}, else null.
function refsOf(run) {
    return run.productionMethodRefs ? lib.json(run.productionMethodRefs, null) : null
}
// The routings of a run, the phantoms' first and the run's own last: those it was read from (P16 review B3: a phantom's
// routing counts though no line names its operation), else, for a run made before that, its lines' and its own.
function routingsOfRun(run, lines) {
    const refs = refsOf(run)
    if (refs?.routingIds) return Array.from(refs.routingIds)
    const ids = []
    for (const line of lines) {
        const op = line.routingOperationWorkEffortId ? one(WORK, {workEffortId: line.routingOperationWorkEffortId}) : null
        if (op?.parentWorkEffortId && op.parentWorkEffortId !== run.productionRoutingId && !ids.includes(op.parentWorkEffortId))
            ids.push(op.parentWorkEffortId)
    }
    if (run.productionRoutingId) ids.push(run.productionRoutingId)
    return ids
}
function usable(productId, quantity, facilityId) {
    const check = call("mantle.product.ProductServices.check#ProductUsable", {productId, usage: "Produce", quantity, facilityId})
    if (!check.usable)
        denied("PRODUCT_NOT_USABLE", "Product " + productId + " cannot be produced: " + (check.reason || check.statusId))
}

// ===== create#ProductionOrder =====
function create(userScope, p) {
    const organizationPartyId = str(p.organizationPartyId)
    if (!organizationPartyId || !facilityScope.owns(userScope, organizationPartyId))
        denied("RECORD_UNAVAILABLE", "Organization " + (organizationPartyId || "") + " is not available")
    const facility = posting.facility(userScope, p.facilityId)
    if (facility.ownerPartyId !== organizationPartyId)
        denied("FACILITY_OWNER", "Facility " + facility.facilityId + " is not " + organizationPartyId + "'s")
    if (!blank(p.originFacilityId)) posting.facility(userScope, p.originFacilityId)
    const product = blank(p.productId) ? null : one(PRODUCT, {productId: p.productId})
    if (!product) denied("PRODUCT_REQUIRED", "Choose the product to make")
    const quantity = blank(p.quantity) ? zero() : dec(p.quantity)
    if (quantity.compare(0) <= 0) denied("QUANTITY_INVALID", "Give a quantity above zero")
    usable(product.productId, quantity, facility.facilityId)
    const date = p.methodDate || ec.user.nowTimestamp
    const plan = method(organizationPartyId, product, quantity, str(p.quantityUomId), date, p.productBomId, p.routingWorkEffortId)
    // Mantle's run, without the legacy consume and produce products (D15)
    const created = call("mantle.work.ManufacturingServices.create#ProductionRun", {
        facilityId: facility.facilityId,
        originFacilityId: str(p.originFacilityId),
        ownerPartyId: organizationPartyId,
        workEffortName: str(p.workEffortName) || "Make " + text(quantity) + " " + (product.productName || product.productId),
        estimatedStartDate: p.estimatedStartDate || null,
        estimatedCompletionDate: p.estimatedCompletionDate || null,
        productionRevision: 1,
        productionMethodDate: date,
        productBomId: plan.bom.productBomId,
        productionRoutingId: plan.routingWorkEffortId,
        productionMethodRefs: plan.refs,
        demandOrderId: str(p.sourceOrderId),
        demandOrderItemSeqId: str(p.orderItemSeqId),
        demandRequirementId: str(p.requirementId)
    })
    writeLines(created.workEffortId, plan.lines)
    writeProducts(created.workEffortId, plan.lines)
    return {
        workEffortId: created.workEffortId,
        organizationPartyId,
        facilityId: facility.facilityId,
        productId: product.productId,
        productBomId: plan.bom.productBomId,
        routingWorkEffortId: plan.routingWorkEffortId,
        methodDate: date,
        revision: 1,
        lines: linesOf(created.workEffortId).map(lineAnswer),
        operationCount: plan.operations.length
    }
}
function lineAnswer(line) {
    return {
        productionRunLineId: line.productionRunLineId,
        lineRoleEnumId: line.lineRoleEnumId,
        productId: line.productId,
        quantity: text(line.quantity),
        quantityUomId: line.quantityUomId || null,
        stockQuantity: text(line.stockQuantity),
        stockUomId: line.stockUomId || null,
        bomItemId: line.bomItemId || null,
        routingOperationWorkEffortId: line.routingOperationWorkEffortId || null,
        operationWorkEffortId: line.operationWorkEffortId || null
    }
}

// ===== release#ProductionOrder =====
function release(userScope, run, p) {
    if (run.statusId !== "WeInPlanning") denied("RUN_NOT_DRAFT", "Production run " + run.workEffortId + " is " + run.statusId)
    if (!blank(p.expectedRevision) && Number(p.expectedRevision) !== Number(run.productionRevision || 0))
        denied("REVISION_CHANGED", "Production run " + run.workEffortId + " changed; reload and review it")
    let lines = linesOf(run.workEffortId)
    const output = lines.find(line => line.lineRoleEnumId === "PrlrOutput")
    if (!output)
        denied("LINES_REQUIRED", "Production run " + run.workEffortId + " has no lines; create it through create#ProductionOrder")
    usable(output.productId, dec(output.quantity), run.facilityId)
    const now = ec.user.nowTimestamp
    let methodDate = run.productionMethodDate || now,
        revision = Number(run.productionRevision || 0),
        routingId = run.productionRoutingId
    const later = laterReleases(run, lines, now)
    const reexploded = false
    if (later.length) {
        if (p.reexplode !== true && p.reexplode !== "true")
            denied(
                "METHOD_CHANGED",
                "The method was released again on " +
                    later.map(row => day(row.fromDate)).join(", ") +
                    ", after the run's method date " +
                    day(methodDate) +
                    "; re-explode the run as of now to release it"
            )
        // the re-explosion as of now rewrites the draft lines and the planning rows (R-SA-12)
        const product = one(PRODUCT, {productId: output.productId})
        const plan = method(
            run.ownerPartyId,
            product,
            dec(output.quantity),
            output.quantityUomId,
            now,
            run.productBomId,
            run.productionRoutingId
        )
        for (const line of lines) call("delete#" + LINE, {productionRunLineId: line.productionRunLineId})
        writeLines(run.workEffortId, plan.lines)
        writeProducts(run.workEffortId, plan.lines)
        // the rewritten draft goes back for review: it stays WeInPlanning at the next revision, and a release follows with
        // that revision (P16 review B7; design WorkOrderDetail "returns a finding and offers a re-explosion")
        call("update#" + WORK, {
            workEffortId: run.workEffortId,
            productionMethodDate: now,
            productionRoutingId: plan.routingWorkEffortId,
            productionMethodRefs: plan.refs,
            productionRevision: revision + 1
        })
        return {
            resultCode: "REEXPLODED",
            workEffortId: run.workEffortId,
            statusId: run.statusId,
            methodDate: now,
            reexploded: true,
            revision: revision + 1,
            findings: later.map(row => ({
                methodEntityName: row.methodEntityName,
                methodId: row.methodId,
                fromDate: row.fromDate
            })),
            lines: linesOf(run.workEffortId).map(lineAnswer)
        }
    }
    // the operation children, from the routings as of the method date, each with its owner (R-SA-03)
    const operations = operationsOf(routingsOfRun(Object.assign({}, run, {productionRoutingId: routingId}), lines), methodDate)
    const children = {}
    operations.forEach((op, index) => {
        const child = call("create#" + WORK, {
            parentWorkEffortId: run.workEffortId,
            rootWorkEffortId: run.workEffortId,
            workEffortTypeEnumId: "WetTask",
            statusId: "WeApproved",
            ownerPartyId: run.ownerPartyId,
            facilityId: run.facilityId,
            workEffortName: op.workEffortName || "Operation " + (index + 1),
            sequenceNum: index + 1,
            operationSequenceNum: op.sequenceNum ?? (index + 1) * 10,
            routingOperationWorkEffortId: op.workEffortId,
            workCenterFacilityId: op.workCenterFacilityId,
            estimatedStartDate: run.estimatedStartDate || null,
            estimatedCompletionDate: run.estimatedCompletionDate || null
        })
        children[op.workEffortId] = child.workEffortId
    })
    // the lines frozen, each on its operation child
    for (const line of lines)
        call("update#" + LINE, {
            productionRunLineId: line.productionRunLineId,
            operationWorkEffortId: line.routingOperationWorkEffortId ? children[line.routingOperationWorkEffortId] || null : null,
            frozenDate: now
        })
    lines = linesOf(run.workEffortId)
    writeProducts(run.workEffortId, lines)
    // the frozen standard: the approved estimate in effect now for the organization and facility (Products P9)
    const costs = ec.resource.script("component://mr-mantle/service/mantle/product/Costs.js")
    const standard = costs.effective(output.productId, run.ownerPartyId, now, run.facilityId)
    call("update#" + WORK, {
        workEffortId: run.workEffortId,
        statusId: "WeApproved",
        productionReleaseDate: now,
        productStandardCostId: standard?.productStandardCostId || null,
        productionRevision: revision + 1
    })
    return {
        resultCode: "RELEASED",
        workEffortId: run.workEffortId,
        statusId: "WeApproved",
        releaseDate: now,
        methodDate,
        reexploded,
        revision: revision + 1,
        productStandardCostId: standard?.productStandardCostId || null,
        operationWorkEffortIds: operations.map(op => children[op.workEffortId]),
        lines: lines.map(lineAnswer)
    }
}

// ===== get#ProductionOrder =====
const issuancesOfLine = productionRunLineId => rows(ISSUANCE, {productionMaterialLineId: productionRunLineId})
// what came back of an issuance: the receipts made from it (return#UnusedMaterial)
const returnedOf = assetIssuanceId =>
    rows(RECEIPT, {sourceAssetIssuanceId: assetIssuanceId}).reduce((sum, row) => sum.add(dec(row.quantityAccepted)), zero())
function materialTotals(line) {
    const issuances = issuancesOfLine(line.productionRunLineId)
    const issued = issuances.reduce((sum, row) => sum.add(dec(row.quantity)), zero())
    const returned = issuances.reduce((sum, row) => sum.add(returnedOf(row.assetIssuanceId)), zero())
    const net = issued.subtract(returned)
    const remaining = dec(line.stockQuantity).subtract(net)
    return {issued, returned, net, remaining: remaining.compare(0) > 0 ? remaining : zero()}
}
function receivedOf(line) {
    return rows(RECEIPT, {productionOutputLineId: line.productionRunLineId}).reduce(
        (sum, row) => sum.add(dec(row.quantityAccepted)),
        zero()
    )
}
// The run, its lines with what was issued, returned and received, its operations and its movements; a standard's cost and
// a movement's value only with financial read.
function read(userScope, workEffortId) {
    const run = runOf(userScope, workEffortId)
    const financial = lib.access.has("ACCOUNTING_VIEW")
    const lines = linesOf(run.workEffortId)
    const names = new Map(
        Array.from(new Set(lines.map(line => line.productId))).map(id => [id, one(PRODUCT, {productId: id})?.productName || id])
    )
    const lineRows = lines.map(line => {
        const answer = Object.assign(lineAnswer(line), {
            productName: names.get(line.productId),
            bomPath: line.bomPath || null,
            frozenDate: line.frozenDate || null
        })
        if (line.lineRoleEnumId === "PrlrMaterial") {
            const totals = materialTotals(line)
            Object.assign(answer, {
                issued: text(totals.issued),
                returned: text(totals.returned),
                remaining: text(totals.remaining)
            })
        } else {
            const received = receivedOf(line)
            const left = dec(line.stockQuantity).subtract(received)
            Object.assign(answer, {received: text(received), remaining: text(left.compare(0) > 0 ? left : zero())})
        }
        return answer
    })
    const operations = rows(WORK, {parentWorkEffortId: run.workEffortId})
        .sort((a, b) => Number(a.sequenceNum || 0) - Number(b.sequenceNum || 0))
        .map(op => ({
            workEffortId: op.workEffortId,
            workEffortName: op.workEffortName || null,
            statusId: op.statusId || null,
            sequenceNum: op.operationSequenceNum ?? op.sequenceNum ?? null,
            routingOperationWorkEffortId: op.routingOperationWorkEffortId || null,
            workCenterFacilityId: op.workCenterFacilityId || null
        }))
    const assetOf = assetId => (assetId ? one(ASSET, {assetId}) : null)
    const value = (quantity, asset) =>
        financial && asset?.acquireCost != null ? String(dec(quantity).multiply(dec(asset.acquireCost)).toNumber()) : null
    const issuances = rows(ISSUANCE, {workEffortId: run.workEffortId}).map(row => {
        const asset = assetOf(row.assetId)
        return {
            assetIssuanceId: row.assetIssuanceId,
            productionMaterialLineId: row.productionMaterialLineId || null,
            operationWorkEffortId: row.operationWorkEffortId || null,
            assetId: row.assetId,
            productId: row.productId,
            lotId: asset?.lotId || null,
            quantity: text(row.quantity),
            returnable: text(dec(row.quantity).subtract(returnedOf(row.assetIssuanceId))),
            issuedDate: row.issuedDate,
            value: value(row.quantity, asset)
        }
    })
    const receipts = rows(RECEIPT, {workEffortId: run.workEffortId}).map(row => {
        const asset = assetOf(row.assetId)
        return {
            assetReceiptId: row.assetReceiptId,
            kind: row.productionOutputLineId ? "output" : row.sourceAssetIssuanceId ? "return" : "receipt",
            productionOutputLineId: row.productionOutputLineId || null,
            sourceAssetIssuanceId: row.sourceAssetIssuanceId || null,
            operationWorkEffortId: row.operationWorkEffortId || null,
            assetId: row.assetId,
            productId: row.productId,
            lotId: asset?.lotId || null,
            serialNumber: asset?.serialNumber || null,
            statusId: asset?.statusId || null,
            quantity: text(row.quantityAccepted),
            receivedDate: row.receivedDate,
            costProvisional: row.costProvisional === "Y",
            value: value(row.quantityAccepted, asset)
        }
    })
    const standard = run.productStandardCostId ? one(STANDARD, {productStandardCostId: run.productStandardCostId}) : null
    const facility = run.facilityId ? one(FACILITY, {facilityId: run.facilityId}) : null
    return {
        run: {
            workEffortId: run.workEffortId,
            workEffortName: run.workEffortName || null,
            statusId: run.statusId,
            facilityId: run.facilityId || null,
            facilityName: facility?.facilityName || null,
            ownerPartyId: run.ownerPartyId || null,
            revision: run.productionRevision == null ? null : Number(run.productionRevision),
            methodDate: run.productionMethodDate || null,
            releaseDate: run.productionReleaseDate || null,
            productBomId: run.productBomId || null,
            routingWorkEffortId: run.productionRoutingId || null,
            productStandardCostId: run.productStandardCostId || null,
            standardUnitCost: financial && standard?.unitCost != null ? String(standard.unitCost) : null,
            standardCurrencyUomId: financial ? standard?.priceUomId || null : null,
            demandOrderId: run.demandOrderId || null,
            demandOrderItemSeqId: run.demandOrderItemSeqId || null,
            demandRequirementId: run.demandRequirementId || null,
            estimatedStartDate: run.estimatedStartDate || null,
            estimatedCompletionDate: run.estimatedCompletionDate || null
        },
        lines: lineRows,
        operations,
        issuances,
        receipts,
        financialRead: financial
    }
}

// ===== the stock guards =====
// The quantity in the stock unit: given in the stock unit, or in the line's unit through the line's exact conversion.
function unitOf(line, quantity, quantityUomId) {
    const entered = blank(quantity) ? zero() : dec(quantity)
    if (entered.compare(0) <= 0) denied("QUANTITY_INVALID", "Give a quantity above zero")
    if (blank(quantityUomId) || quantityUomId === line.stockUomId)
        return {stockQuantity: entered, enteredQuantity: entered, enteredUomId: line.stockUomId || null, factor: toDecimal(1)}
    if (quantityUomId === line.quantityUomId) {
        const factor = dec(line.conversionFactor ?? 1)
        return {stockQuantity: entered.multiply(factor), enteredQuantity: entered, enteredUomId: quantityUomId, factor}
    }
    denied(
        "UNIT_CONVERSION",
        "Unit " + quantityUomId + " is neither line " + line.productionRunLineId + "'s unit nor its stock unit"
    )
}
// issue#ProductionMaterial's checks, before anything posts: the released run, its material line (locked), the operation,
// the stock (locked; the user's facilities, on hand), its product, AstAvailable (a quarantined or other held component is
// refused, R-SA-03: issue#AssetToWorkEffort does not check the status), owned by the run's owner, free to issue, and no more
// than the line has left.
function issuePlan(userScope, p) {
    const run = runOf(userScope, p.workEffortId)
    requireReleased(run)
    const line = lineOf(run, p.productionRunLineId, ["PrlrMaterial"], true)
    const operationWorkEffortId = operationOf(run, str(p.operationWorkEffortId) || line.operationWorkEffortId)
    const unit = unitOf(line, p.quantity, p.quantityUomId)
    const asset = posting.stock(userScope, p.assetId, unit.stockQuantity)
    if (asset.productId !== line.productId)
        denied(
            "PRODUCT_MISMATCH",
            "Asset " +
                asset.assetId +
                " is " +
                asset.productId +
                ", not line " +
                line.productionRunLineId +
                "'s " +
                line.productId
        )
    if (asset.statusId !== "AstAvailable")
        denied(
            "HELD_STOCK",
            "Asset " + asset.assetId + " is " + asset.statusId + "; only available stock is issued to production"
        )
    if (asset.ownerPartyId !== run.ownerPartyId)
        denied(
            "OWNER_MISMATCH",
            "Asset " +
                asset.assetId +
                " is owned by " +
                (asset.ownerPartyId || "nobody") +
                ", not the run's owner " +
                run.ownerPartyId
        )
    if (unit.stockQuantity.compare(dec(asset.availableToPromiseTotal)) > 0)
        denied(
            "QUANTITY_EXCEEDS_AVAILABLE",
            "Only " + text(asset.availableToPromiseTotal) + " of asset " + asset.assetId + " is free to issue"
        )
    const totals = materialTotals(line)
    if (unit.stockQuantity.compare(totals.remaining) > 0)
        denied(
            "QUANTITY_EXCEEDS_REMAINING",
            "Line " + line.productionRunLineId + " has " + text(totals.remaining) + " left to issue"
        )
    return {run, line, operationWorkEffortId, unit, asset}
}
// return#UnusedMaterial's checks: the issuance (locked) of a run of the user's, not closed, with what has not come back of
// it; the destination: the original asset (locked, its location open) or a location of a facility of the same owner.
function returnPlan(userScope, p) {
    const issuance = blank(p.assetIssuanceId) ? null : find(ISSUANCE, {assetIssuanceId: p.assetIssuanceId}).forUpdate(true).one()
    if (!issuance?.workEffortId) denied("RECORD_UNAVAILABLE", "Issuance " + (p.assetIssuanceId || "") + " is not available")
    const run = runOf(userScope, issuance.workEffortId)
    if (closedStatuses.includes(run.statusId)) denied("RUN_CLOSED", "Production run " + run.workEffortId + " is " + run.statusId)
    const quantity = blank(p.quantity) ? zero() : dec(p.quantity)
    if (quantity.compare(0) <= 0) denied("QUANTITY_INVALID", "Give a quantity above zero")
    const returnable = dec(issuance.quantity).subtract(returnedOf(issuance.assetIssuanceId))
    if (quantity.compare(returnable) > 0)
        denied(
            "QUANTITY_EXCEEDS_ISSUED",
            "Only " + text(returnable) + " of issuance " + issuance.assetIssuanceId + " is left to return"
        )
    const source = find(ASSET, {assetId: issuance.assetId}).forUpdate(true).one()
    if (!source) denied("RECORD_UNAVAILABLE", "Asset " + issuance.assetId + " is not available")
    let target, intoOriginal
    if (blank(p.toLocationSeqId)) {
        // back into the original asset where it is
        const home = posting.facility(userScope, source.facilityId)
        if (!source.locationSeqId && home.assetInventoryLocRequire === "Y")
            denied("LOCATION_REQUIRED", "Choose a location to return to")
        target = source.locationSeqId
            ? posting.destination(userScope, source.facilityId, {toLocationSeqId: source.locationSeqId})
            : {facilityId: source.facilityId, locationSeqId: null, autoStatusId: null}
        intoOriginal = true
    } else {
        const facilityId = str(p.toFacilityId) || source.facilityId
        const facility = posting.facility(userScope, facilityId)
        if (facility.ownerPartyId !== run.ownerPartyId)
            denied("OWNER_MISMATCH", "Facility " + facilityId + " is not the run owner's")
        target = posting.destination(userScope, facilityId, {toLocationSeqId: p.toLocationSeqId})
        intoOriginal = false
    }
    // after a provisional output receipt (no approved standard), what comes back lowers the WIP the rest of the output takes;
    // the earlier receipts stay flagged costProvisional for the cost close's true-up. Once all the output is received at a
    // provisional cost nothing is left to take it, so a return is refused (P16 review A1)
    const provisional = rows(RECEIPT, {workEffortId: run.workEffortId, costProvisional: "Y"})
    const warnings = []
    if (provisional.length) {
        const outputs = linesOf(run.workEffortId).filter(line => line.lineRoleEnumId === "PrlrOutput")
        if (outputs.every(line => receivedOf(line).compare(dec(line.stockQuantity)) >= 0))
            denied(
                "PROVISIONAL_CLOSED",
                "All of run " +
                    run.workEffortId +
                    "'s output was received at its issued cost; a return now would leave WIP below zero"
            )
        warnings.push({
            code: "PROVISIONAL_TRUE_UP",
            assetReceiptIds: provisional.map(row => row.assetReceiptId),
            message: "Output already received at a provisional cost carries this material; the cost close trues it up"
        })
    }
    return {issuance, run, source, quantity, target, intoOriginal, warnings}
}
// The receipt lines that carry a value exactly: the unit cost at the four decimals acquireCost keeps, rounded down, the last
// unit apart at the remainder's cost when that leaves one, so the remainder is never below the unit cost (P6/P12, F166; P16
// review A2); serials are one unit a line; a quantity of one or less is one line at its value over the quantity.
function costLines(total, quantity, serials) {
    if (!serials.length && quantity.compare(1) <= 0)
        return [{quantity, cost: total.divide(quantity, 4, "HALF_UP"), serialNumber: null}]
    const unitCost = total.divide(quantity, 4, "DOWN")
    const exact = quantity.multiply(unitCost).eq(total)
    if (serials.length) {
        const last = total.subtract(unitCost.multiply(toDecimal(serials.length - 1)))
        return serials.map((serialNumber, index) => ({
            quantity: toDecimal(1),
            cost: index === serials.length - 1 && !exact ? last : unitCost,
            serialNumber
        }))
    }
    if (exact) return [{quantity, cost: unitCost, serialNumber: null}]
    const rest = quantity.subtract(1)
    return [
        {quantity: rest, cost: unitCost, serialNumber: null},
        {quantity: toDecimal(1), cost: total.subtract(rest.multiply(unitCost)), serialNumber: null}
    ]
}
// The value the run still holds in WIP: what was issued to it at each asset's cost, less returns and output received.
function wipValue(run) {
    const valueOf = (quantity, assetId) => {
        const asset = assetId ? one(ASSET, {assetId}) : null
        return asset?.acquireCost == null ? zero() : dec(quantity).multiply(dec(asset.acquireCost))
    }
    const issued = rows(ISSUANCE, {workEffortId: run.workEffortId}).reduce(
        (sum, row) => sum.add(valueOf(row.quantity, row.assetId)),
        zero()
    )
    const back = rows(RECEIPT, {workEffortId: run.workEffortId}).reduce(
        (sum, row) => sum.add(valueOf(row.quantityAccepted, row.assetId)),
        zero()
    )
    return issued.subtract(back)
}
// The output's cost (D12, R-SA-01): the run's frozen standard unit cost; with no approved standard, the issued cost to date
// over the quantity, provisional. Output is never received without a cost.
function outputCost(run, line, quantity) {
    const standard = run.productStandardCostId ? one(STANDARD, {productStandardCostId: run.productStandardCostId}) : null
    if (standard?.unitCost != null)
        return {
            total: dec(standard.unitCost).multiply(quantity),
            currencyUomId: standard.priceUomId || null,
            provisional: false,
            costSource: "standard"
        }
    const wip = wipValue(run)
    if (wip.compare(0) <= 0)
        denied(
            "COST_UNAVAILABLE",
            "Run " + run.workEffortId + " has no approved standard cost and no issued cost to receive its output at"
        )
    const issued = rows(ISSUANCE, {workEffortId: run.workEffortId})
    const currency = issued.length ? one(ASSET, {assetId: issued[0].assetId})?.acquireCostUomId || null : null
    // a part of the output takes its share of the net WIP (what is left to receive), the last receipt the rest (P16 review A1)
    const left = dec(line.stockQuantity).subtract(receivedOf(line))
    const total = quantity.compare(left) >= 0 ? wip : wip.multiply(quantity).divide(left, 6, "DOWN")
    return {total, currencyUomId: currency, provisional: true, costSource: "issued"}
}
// receive#ProductionOutput's checks and plan, before anything posts: the released run, the output line (locked), no more
// than it has left, the tracking (serials given or generated from a first value, P7's rules), the cost, the destination by
// the receipt steps (into quarantine when an inspection applies, P8's rule; otherwise the putaway resolver or the given
// location, the facility the run's or another of its owner's).
function outputPlan(userScope, p) {
    const receiving = ec.resource.script("component://mr-mantle/service/mantle/shipment/Receiving.js")
    const quality = ec.resource.script("component://mr-mantle/service/mantle/product/Quality.js")
    const run = runOf(userScope, p.workEffortId)
    requireReleased(run)
    const line = outputLineOf(run, p.productionRunLineId, true)
    // a by-product's cost is Accounting's allocation (design ByProducts, D12), which is not built: it is not received here
    if (line.lineRoleEnumId === "PrlrByproduct")
        denied("BYPRODUCT_NOT_COSTED", "By-product " + line.productId + " is received once its cost allocation exists")
    const operationWorkEffortId = operationOf(run, str(p.operationWorkEffortId) || line.operationWorkEffortId)
    const unit = unitOf(line, p.quantity, p.quantityUomId)
    const left = dec(line.stockQuantity).subtract(receivedOf(line))
    if (unit.stockQuantity.compare(left) > 0)
        denied(
            "OVER_RECEIPT",
            "Line " + line.productionRunLineId + " has " + text(left.compare(0) > 0 ? left : zero()) + " left to receive"
        )
    const facility = posting.facility(userScope, str(p.facilityId) || run.facilityId)
    if (facility.ownerPartyId !== run.ownerPartyId)
        denied("OWNER_MISMATCH", "Facility " + facility.facilityId + " is not the run owner's")
    const product = one(PRODUCT, {productId: line.productId})
    const policy = receiving.policyOf(facility.facilityId, product.productId)
    let serialNumbers = p.serialNumbers
    if (blank(serialNumbers) && !blank(p.firstSerialNumber)) {
        if (unit.stockQuantity.compare(Math.floor(unit.stockQuantity.toNumber())) !== 0)
            denied("SERIAL_COUNT_MISMATCH", "Serial-tracked output is received in whole units")
        const generated = receiving.generate({
            trackingKind: "serial",
            productId: product.productId,
            count: unit.stockQuantity.toNumber(),
            firstValue: p.firstSerialNumber
        })
        const taken = generated.identityRows.filter(row => row.duplicate).map(row => row.value)
        if (taken.length) denied("SERIAL_DUPLICATE", "Serial numbers already in stock: " + taken.join(", "))
        serialNumbers = generated.identityRows.map(row => row.value)
    }
    const track = receiving.tracking(policy.tracking, product, unit.stockQuantity, {
        serialNumbers,
        lotNumber: p.lotNumber,
        lotId: p.lotId,
        expirationDate: p.expirationDate,
        mfgPartyId: run.ownerPartyId
    })
    const inspect = quality.outputNeedsInspection(facility, product.productId, policy)
    const operation = inspect
        ? Object.assign({}, policy.operation, {receiptSteps: 3})
        : Object.assign({}, policy.operation, {receiptSteps: 1})
    const target = receiving.destination(
        userScope,
        facility.facilityId,
        product.productId,
        operation,
        str(p.toLocationSeqId),
        unit.stockQuantity,
        run.ownerPartyId
    )
    if (!target.locationSeqId && facility.assetInventoryLocRequire === "Y")
        denied("LOCATION_REQUIRED", "Choose where the output goes")
    const cost = outputCost(run, line, unit.stockQuantity)
    return {
        run,
        line,
        operationWorkEffortId,
        unit,
        facility,
        product,
        track,
        inspect,
        target,
        cost,
        lines: costLines(cost.total, unit.stockQuantity, track.serialized ? track.serials : [])
    }
}
// The output received: each cost line through receive#Asset with the run's workEffortId, the owner, lot and serial, at
// its cost (AssetReceiptGlPost relieves WIP), each receipt carrying its line, operation, entered quantity and whether its
// cost is provisional; then the inspection of each receipt when one applies.
function postOutput(userScope, plan, p) {
    const quality = ec.resource.script("component://mr-mantle/service/mantle/product/Quality.js")
    const assetIds = [],
        assetReceiptIds = []
    for (const costLine of plan.lines) {
        const out = call("mantle.product.AssetServices.receive#Asset", {
            productId: plan.product.productId,
            quantity: costLine.quantity,
            facilityId: plan.facility.facilityId,
            locationSeqId: plan.target.locationSeqId || null,
            statusId: plan.target.statusId || null,
            ownerPartyId: plan.run.ownerPartyId,
            acquireCost: costLine.cost,
            acquireCostUomId: plan.cost.currencyUomId,
            serialNumber: costLine.serialNumber,
            lotId: str(p.lotId),
            lotNumber: str(p.lotNumber),
            mfgPartyId: blank(p.lotNumber) ? null : plan.run.ownerPartyId,
            expirationDate: plan.track.expirationDate || null,
            manufacturedDate: ec.user.nowTimestamp,
            workEffortId: plan.run.workEffortId
        })
        if (out.assetId) {
            assetIds.push(out.assetId)
            // receive#Asset takes the cost's currency from an order only
            if (plan.cost.currencyUomId)
                call("update#" + ASSET, {assetId: out.assetId, acquireCostUomId: plan.cost.currencyUomId})
        }
        call("update#" + RECEIPT, {
            assetReceiptId: out.assetReceiptId,
            productionOutputLineId: plan.line.productionRunLineId,
            operationWorkEffortId: plan.operationWorkEffortId,
            costProvisional: plan.cost.provisional ? "Y" : null,
            enteredQuantity: costLine.quantity.divide(plan.unit.factor, 6, "HALF_UP"),
            enteredQuantityUomId: plan.unit.enteredUomId,
            appliedConversionFactor: plan.unit.factor
        })
        assetReceiptIds.push(out.assetReceiptId)
    }
    const qualityInspectionIds = plan.inspect ? quality.outputInspections(userScope, assetReceiptIds, plan.run.workEffortId) : []
    return {assetIds, assetReceiptIds, qualityInspectionIds}
}

// ===== receive#SubcontractOutput =====
// The subcontract dispatch's work and service order item (P15's Shipment.subcontract* keys), its vendor-custody facility
// (the custodian is the order's supplier), the run and operation, the output line, and the material lines the vendor used:
// each line of the operation (or of the run) at the output's share of its quantity, or the supplier-reported actuals
// after review, taken from the run owner's available stock at the vendor facility, oldest first (MATERIAL_SHORT when it
// is not there).
function subcontractPlan(userScope, p) {
    const transfers = ec.resource.script("component://mr-mantle/service/mantle/shipment/Transfers.js")
    const shipment = blank(p.shipmentId) ? null : one("mantle.shipment.Shipment", {shipmentId: p.shipmentId})
    if (!shipment) denied("RECORD_UNAVAILABLE", "Shipment " + (p.shipmentId || "") + " is not available")
    if (!shipment.subcontractWorkEffortId)
        denied("NOT_SUBCONTRACT", "Shipment " + shipment.shipmentId + " is not a subcontract dispatch")
    if (shipment.statusId === "ShipCancelled")
        denied("SHIPMENT_CANCELLED", "Subcontract dispatch " + shipment.shipmentId + " is cancelled")
    const segments = rows("mantle.shipment.ShipmentRouteSegment", {shipmentId: shipment.shipmentId}).sort((a, b) =>
        String(a.shipmentRouteSegmentSeqId).localeCompare(String(b.shipmentRouteSegmentSeqId))
    )
    const vendorFacilityId = segments.length ? segments[segments.length - 1].destinationFacilityId : null
    const vendorFacility = posting.facility(userScope, vendorFacilityId)
    const custodian = transfers.custodianOf(vendorFacility.facilityId)
    if (!custodian) denied("NOT_CUSTODY", "Facility " + vendorFacility.facilityId + " is not a vendor-custody facility")
    const work = one(WORK, {workEffortId: shipment.subcontractWorkEffortId})
    const runId = work?.purposeEnumId === "WepProductionRun" ? work.workEffortId : work?.parentWorkEffortId
    const run = runOf(userScope, runId)
    requireReleased(run)
    const operationWorkEffortId = work.workEffortId === run.workEffortId ? null : work.workEffortId
    const item = one("mantle.order.OrderItem", {
        orderId: shipment.subcontractOrderId,
        orderItemSeqId: shipment.subcontractOrderItemSeqId
    })
    const part = item ? one("mantle.order.OrderPart", {orderId: item.orderId, orderPartSeqId: item.orderPartSeqId}) : null
    // the service is bought by the run's owner (P16 review C)
    if (!part || part.customerPartyId !== run.ownerPartyId)
        denied("RECORD_UNAVAILABLE", "Order " + shipment.subcontractOrderId + " is not a purchase of " + run.ownerPartyId)
    if (part?.vendorPartyId !== custodian)
        denied(
            "CUSTODIAN_MISMATCH",
            "Order " + shipment.subcontractOrderId + " is not with the facility's custodian " + custodian
        )
    const output = outputLineOf(run, p.productionRunLineId)
    const quantity = blank(p.quantity) ? zero() : dec(p.quantity)
    if (quantity.compare(0) <= 0) denied("QUANTITY_INVALID", "Give the quantity of output received")
    const actuals = p.materialQuantities && typeof p.materialQuantities === "object" ? p.materialQuantities : null
    const materials = linesOf(run.workEffortId).filter(
        line =>
            line.lineRoleEnumId === "PrlrMaterial" &&
            (!operationWorkEffortId || line.operationWorkEffortId === operationWorkEffortId)
    )
    // reviewed actuals name only the dispatch's material lines (P16 review B6)
    if (actuals)
        for (const lineId of Object.keys(actuals))
            if (!materials.some(line => line.productionRunLineId === lineId))
                denied("LINE_INVALID", "Line " + lineId + " is not a material line of this subcontract's work")
    // the last of the output takes what is left of each line, so no rounding residue stays on it (P16 review C)
    const outputLeft = dec(output.stockQuantity).subtract(receivedOf(output))
    const final = quantity.compare(outputLeft) >= 0
    const issues = []
    for (const line of materials) {
        const given = actuals ? actuals[line.productionRunLineId] : null
        const left = materialTotals(line).remaining
        const share =
            given != null && given !== ""
                ? dec(given)
                : final
                  ? left
                  : dec(line.stockQuantity).multiply(quantity).divide(dec(output.stockQuantity), 6, "HALF_UP")
        if (given != null && given !== "" && share.compare(left) > 0)
            denied("QUANTITY_EXCEEDS_REMAINING", "Line " + line.productionRunLineId + " has " + text(left) + " left to issue")
        let need = share.compare(left) > 0 ? left : share
        if (need.compare(0) <= 0) continue
        const stock = Array.from(
            find(ASSET, {
                facilityId: vendorFacility.facilityId,
                productId: line.productId,
                ownerPartyId: run.ownerPartyId,
                statusId: "AstAvailable"
            })
                .condition("availableToPromiseTotal", "greater", 0)
                .orderBy("receivedDate")
                .orderBy("assetId")
                .list()
        )
        for (const asset of stock) {
            if (need.compare(0) <= 0) break
            const take = dec(asset.availableToPromiseTotal).compare(need) < 0 ? dec(asset.availableToPromiseTotal) : need
            issues.push({
                productionRunLineId: line.productionRunLineId,
                assetId: asset.assetId,
                quantity: take,
                operationWorkEffortId: line.operationWorkEffortId || operationWorkEffortId
            })
            need = need.subtract(take)
        }
        if (need.compare(0) > 0)
            denied(
                "MATERIAL_SHORT",
                "The vendor facility " +
                    vendorFacility.facilityId +
                    " holds " +
                    text(share.subtract(need)) +
                    " of " +
                    line.productId +
                    " for line " +
                    line.productionRunLineId +
                    "; " +
                    text(share) +
                    " are used"
            )
    }
    // the service accepted: the order item's quantity in the output's proportion, all that is left with the last output,
    // capped at what is left to accept (P16 review B5)
    const ordered = dec(item.quantity).subtract(dec(item.quantityCancelled))
    const acceptedBefore = rows("mantle.order.purchase.ServiceAcceptance", {
        orderId: item.orderId,
        orderItemSeqId: item.orderItemSeqId
    }).reduce((sum, row) => sum.add(dec(row.acceptedQuantity)), zero())
    const acceptLeft = ordered.subtract(acceptedBefore)
    const proportional = final ? acceptLeft : ordered.multiply(quantity).divide(dec(output.stockQuantity), 6, "HALF_UP")
    const acceptQuantity = blank(p.acceptedQuantity)
        ? proportional.compare(acceptLeft) > 0
            ? acceptLeft
            : proportional
        : dec(p.acceptedQuantity)
    return {
        acceptQuantity,
        shipment,
        vendorFacility,
        custodian,
        run,
        operationWorkEffortId,
        output,
        quantity,
        issues,
        orderId: shipment.subcontractOrderId,
        orderItemSeqId: shipment.subcontractOrderItemSeqId
    }
}

;({
    runOf,
    linesOf,
    create,
    release,
    read,
    issuePlan,
    returnPlan,
    outputPlan,
    postOutput,
    subcontractPlan,
    materialTotals,
    costLines,
    text
})
