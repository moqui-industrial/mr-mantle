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
    return {bom, header, routingWorkEffortId, routingIds, operations, lines}
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
    const bomIds = new Set([run.productBomId, ...lines.map(line => line.productBomId)].filter(Boolean))
    const routingIds = new Set(
        [
            run.productionRoutingId,
            ...lines.map(
                line =>
                    line.routingOperationWorkEffortId &&
                    one(WORK, {
                        workEffortId: line.routingOperationWorkEffortId
                    })?.parentWorkEffortId
            )
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
// The routings of a run's lines, the phantoms' first and the run's own last.
function routingsOfRun(run, lines) {
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
    let reexploded = false
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
        methodDate = now
        routingId = plan.routingWorkEffortId
        revision += 1
        reexploded = true
        call("update#" + WORK, {workEffortId: run.workEffortId, productionMethodDate: now, productionRoutingId: routingId})
        lines = linesOf(run.workEffortId)
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

;({
    runOf,
    linesOf,
    create,
    release,
    read,
    materialTotals,
    text
})
