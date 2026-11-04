// The materials of Manufacturing's production runs (design-manufacturing Components and MaterialIssueReceipt, crosscut
// §3.9, §12 M2 and M4; impl-manufacturing P5b): what each material line needs, has been issued, returned and has left, with
// the stock free for it, what is held by status apart (R-MFG-24) and what is short; a planner's manual lines on a draft;
// the backflush preview of the lots it would issue and its confirmation through the issue guard; the open runs' shortages
// and the shortage notice. Stock moves only through mantle.work.ProductionServices.issue#ProductionMaterial (Production.js
// issuePlan): the backflush issues each chosen lot through it, inside its own transaction, so a held asset, a shortfall or
// a staged short line refuses the whole backflush and nothing is issued.
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const posting = ec.resource.script("component://mr-mantle/service/mantle/shipment/StockPosting.js")
const facilityScope = ec.resource.script("component://mr-mantle/service/mantle/facility/FacilityScope.js")
const {find, one, rows, call, denied, access} = lib

const WORK = "mantle.work.effort.WorkEffort",
    LINE = "mantle.work.production.ProductionRunLine",
    ASSOC = "mantle.work.effort.WorkEffortAssoc",
    ASSET = "mantle.product.asset.Asset",
    PRODUCT = "mantle.product.Product",
    FACILITY = "mantle.facility.Facility",
    UOM = "moqui.basic.Uom",
    ENUM = "moqui.basic.Enumeration",
    STATUS = "moqui.basic.StatusItem"
const releasedStatuses = ["WeApproved", "WeInProgress"]
const openStatuses = ["WeInPlanning", "WeApproved", "WeInProgress", "WeOnHold"]
// held stock by status, never from available to promise (R-MFG-24): a held asset keeps its ATP
const heldStatuses = ["AstQuarantine", "AstOnHold", "AstDefective"]
const materialTypes = ["PtAsset"]
const optionLimit = 20
const shortageRunLimit = 100
const zero = () => toDecimal(0)
const dec = value => toDecimal(value ?? 0)
const blank = value => value == null || String(value).trim() === ""
const str = value => (blank(value) ? null : String(value))
const text = value => (value == null ? null : dec(value).compare(0) === 0 ? "0" : String(dec(value).toNumber()))
const yes = value => value === true || value === "true" || value === "Y"
const production = () => ec.resource.script("component://mr-mantle/service/mantle/work/Production.js")
const orders = () => ec.resource.script("component://mr-mantle/service/mantle/work/ProductionOrders.js")
const productionPolicy = () => ec.resource.script("component://mr-mantle/service/mantle/work/ProductionPolicy.js")
const payables = () => ec.resource.script("component://mr-mantle/service/mantle/account/Payables.js")
const enumText = enumId => (enumId ? one(ENUM, {enumId})?.description || enumId : "")
const statusText = statusId => (statusId ? one(STATUS, {statusId})?.description || statusId : "")

function requireAny(permissions) {
    if (!permissions.some(access.has)) denied("PERMISSION_DENIED", permissions.join(" or ") + " is required")
}
const revisionOf = run => Number(run.productionRevision || 0)
function requireRevision(run, expectedRevision) {
    if (blank(expectedRevision)) denied("REVISION_REQUIRED", "Review work order " + run.workEffortId + " and give its revision")
    if (Number(expectedRevision) !== revisionOf(run))
        denied("REVISION_CHANGED", "Work order " + run.workEffortId + " changed; reload and review it")
}
function namesOf(entity, field, values) {
    const ids = [...new Set(values.filter(Boolean))]
    if (!ids.length) return new Map()
    return new Map(Array.from(find(entity).condition(field, "in", ids).list()).map(row => [row[field], row]))
}

// ===== stock =====
// The run owner's stock of a product free to promise at the facilities the run nets against (its facility and, for a line,
// the plant above it, F16).
function freeStock(productId, facilityIds, ownerPartyId) {
    let total = zero()
    for (const facilityId of facilityIds)
        total = total.add(
            dec(
                call("mantle.product.AssetServices.get#AvailableInventory", {
                    productId,
                    facilityId,
                    ownerPartyIdList: [ownerPartyId]
                }).availableToPromiseTotal
            )
        )
    return total
}
// The owner's stock of a product held at those facilities, by status: quarantine, on hold and defective.
function heldStock(productId, facilityIds, ownerPartyId) {
    const byStatus = Object.fromEntries(heldStatuses.map(statusId => [statusId, zero()]))
    if (!facilityIds.length) return {total: zero(), byStatus}
    for (const asset of Array.from(
        find(ASSET, {productId, ownerPartyId})
            .condition("facilityId", "in", facilityIds)
            .condition("statusId", "in", heldStatuses)
            .selectField("statusId,quantityOnHandTotal")
            .list()
    ))
        byStatus[asset.statusId] = byStatus[asset.statusId].add(dec(asset.quantityOnHandTotal))
    return {total: Object.values(byStatus).reduce((sum, value) => sum.add(value), zero()), byStatus}
}
// Whether an asset has expired (its own or its lot's date); a backflush never chooses expired stock.
function expired(assetId) {
    try {
        return !!call("mantle.facility.WarehousePolicyServices.get#AssetExpiry", {assetId}).expired
    } catch (error) {
        ec.logger.warn("Expiry of asset " + assetId + " was not read: " + error.message)
        return false
    }
}
// The available stock a line may be issued from, oldest lot expiry first, then the oldest receipt: the run owner's
// AstAvailable assets of the product with something free at the run's facilities (the issue guard checks each again).
function candidates(run, productId, facilityIds, limit = optionLimit) {
    if (!facilityIds.length) return []
    const assets = Array.from(
        find(ASSET, {productId, ownerPartyId: run.ownerPartyId, statusId: "AstAvailable"})
            .condition("facilityId", "in", facilityIds)
            .condition("availableToPromiseTotal", "greater-than", 0)
            .orderBy("receivedDate")
            .orderBy("assetId")
            .limit(limit)
            .list()
    )
    const lots = namesOf(
        "mantle.product.asset.Lot",
        "lotId",
        assets.map(asset => asset.lotId)
    )
    const expiryOf = asset => lib.ms(lots.get(asset.lotId)?.expirationDate) ?? lib.ms(asset.expectedEndOfLife) ?? Infinity
    return assets
        .map((asset, index) => ({asset, index, expiry: expiryOf(asset)}))
        .sort((a, b) => a.expiry - b.expiry || a.index - b.index)
        .map(row => row.asset)
}
const assetLabel = (asset, free) =>
    [
        asset.assetId,
        asset.facilityId + (asset.locationSeqId ? " " + asset.locationSeqId : ""),
        asset.lotId ? "lot " + asset.lotId : null
    ]
        .filter(Boolean)
        .join(" · ") +
    " — free " +
    ec.l10n.format(Number(String(free)), "#,##0.###")

// ===== get#ProductionMaterials =====
// The draft's routing operations a line may name (WeatRoutingComp rows as of the method date), by sequence.
function draftOperations(run, lines) {
    const methodDate = run.productionMethodDate || ec.user.nowTimestamp
    const out = []
    for (const routingId of production().routingsOf(run, lines))
        for (const assoc of rows(ASSOC, {workEffortId: routingId, workEffortAssocTypeEnumId: "WeatRoutingComp"})
            .filter(row => lib.active(row, methodDate))
            .sort((a, b) => Number(a.sequenceNum || 0) - Number(b.sequenceNum || 0))) {
            const op = one(WORK, {workEffortId: assoc.toWorkEffortId})
            out.push({value: assoc.toWorkEffortId, label: op?.workEffortName || assoc.toWorkEffortId})
        }
    return out
}
function materials(p) {
    requireAny(["PRODUCTION_VIEW", "STOCK_ISSUE"])
    const userScope = posting.scope()
    const run = production().runOf(userScope, p.workEffortId)
    const lines = production().linesOf(run.workEffortId)
    const facilityIds = orders().stockFacilityIds(run)
    const policy = productionPolicy().runPolicy(run)
    const draft = run.statusId === "WeInPlanning"
    const released = releasedStatuses.includes(run.statusId)
    const canIssue = released && access.has("STOCK_ISSUE")
    const canPlan = draft && access.has("PRODUCTION_PLAN")
    const material = lines.filter(line => line.lineRoleEnumId === "PrlrMaterial")
    const products = namesOf(
        PRODUCT,
        "productId",
        material.map(line => line.productId)
    )
    const units = namesOf(
        UOM,
        "uomId",
        material.map(line => line.stockUomId)
    )
    const children = rows(WORK, {parentWorkEffortId: run.workEffortId})
    const operationNames = new Map(children.map(op => [op.workEffortId, op.workEffortName || op.workEffortId]))
    const routingOperations = draft ? draftOperations(run, lines) : []
    const routingNames = new Map(routingOperations.map(op => [op.value, op.label]))
    const sourceFacilities = namesOf(
        FACILITY,
        "facilityId",
        material.map(line => line.sourceFacilityId)
    )
    // the stock free for each product, shared in line order across its lines (as the release gate's shortages)
    const free = new Map()
    const materialRows = material.map(line => {
        const totals = production().materialTotals(line)
        if (!free.has(line.productId)) free.set(line.productId, freeStock(line.productId, facilityIds, run.ownerPartyId))
        const left = free.get(line.productId)
        const covered = left.compare(totals.remaining) >= 0 ? totals.remaining : left.compare(0) > 0 ? left : zero()
        free.set(line.productId, left.subtract(covered))
        const held = heldStock(line.productId, facilityIds, run.ownerPartyId)
        const short = totals.remaining.subtract(covered)
        const allowance = productionPolicy().overConsumeAllowance(run, line)
        const product = products.get(line.productId)
        const row = {
            productionRunLineId: line.productionRunLineId,
            lineSeqNum: line.lineSeqNum == null ? null : Number(line.lineSeqNum),
            productId: line.productId,
            productName: product?.productName || line.productId,
            pseudoId: product?.pseudoId || line.productId,
            operationWorkEffortId: line.operationWorkEffortId || null,
            routingOperationWorkEffortId: line.routingOperationWorkEffortId || null,
            operationName: line.operationWorkEffortId
                ? operationNames.get(line.operationWorkEffortId) || line.operationWorkEffortId
                : routingNames.get(line.routingOperationWorkEffortId) ||
                  (line.routingOperationWorkEffortId
                      ? one(WORK, {workEffortId: line.routingOperationWorkEffortId})?.workEffortName || ""
                      : ""),
            required: text(line.stockQuantity),
            allowance: text(allowance),
            issued: text(totals.issued),
            returned: text(totals.returned),
            net: text(totals.net),
            remaining: text(totals.remaining),
            stockUomId: line.stockUomId || null,
            unitText:
                units.get(line.stockUomId)?.abbreviation || units.get(line.stockUomId)?.description || line.stockUomId || "",
            available: text(covered),
            short: short.compare(0) > 0 ? text(short) : null,
            held: text(held.total),
            heldQuarantine: text(held.byStatus.AstQuarantine),
            heldOnHold: text(held.byStatus.AstOnHold),
            heldDefective: text(held.byStatus.AstDefective),
            stagedShort: dec(line.stagedShortQuantity).compare(0) > 0 ? text(line.stagedShortQuantity) : null,
            manual: line.manualLine === "Y",
            sourceFacilityId: line.sourceFacilityId || null,
            sourceFacilityName: sourceFacilities.get(line.sourceFacilityId)?.facilityName || line.sourceFacilityId || null,
            instructionText: line.instructionText || null,
            canEdit: canPlan && line.manualLine === "Y",
            canIssue: canIssue && totals.remaining.compare(0) > 0
        }
        // the stock to issue from, for those who issue (the guard checks it again)
        if (yes(p.withStock) && row.canIssue)
            row.stockOptions = candidates(run, line.productId, facilityIds).map(asset => ({
                value: asset.assetId,
                label: assetLabel(asset, asset.availableToPromiseTotal)
            }))
        return row
    })
    const facility = run.facilityId ? one(FACILITY, {facilityId: run.facilityId}) : null
    return {
        run: {
            workEffortId: run.workEffortId,
            workEffortName: run.workEffortName || null,
            statusId: run.statusId,
            statusText: statusText(run.statusId),
            revision: revisionOf(run),
            ownerPartyId: run.ownerPartyId,
            facilityId: run.facilityId || null,
            facilityName: facility?.facilityName || run.facilityId || null,
            stockFacilityIds: facilityIds,
            draft,
            released
        },
        policy: {
            consumptionMethodEnumId: policy.consumptionMethodEnumId || "PcmManual",
            consumptionText: enumText(policy.consumptionMethodEnumId || "PcmManual"),
            issuePointEnumId: policy.issuePointEnumId || null,
            issuePointText: enumText(policy.issuePointEnumId),
            backflush: policy.consumptionMethodEnumId === "PcmBackflush"
        },
        materialRows,
        shortCount: materialRows.filter(row => row.short).length,
        heldCount: materialRows.filter(row => dec(row.held).compare(0) > 0).length,
        routingOperations,
        canAdd: canPlan,
        canIssue
    }
}

// ===== store#ProductionMaterial: a manual draft line =====
// The quantity of a manual line in the product's stock unit; another unit is refused (UNIT_CONVERSION).
function stockUnitOf(product, quantityUomId) {
    const stockUomId = product.amountUomId || null
    if (!blank(quantityUomId) && quantityUomId !== stockUomId)
        denied("UNIT_CONVERSION", "Give the quantity of " + product.productId + " in its stock unit " + (stockUomId || "(none)"))
    return stockUomId
}
function storeMaterial(p) {
    const begun = posting.begin(p, "ProductionMaterialStore", "PRODUCTION_PLAN", [
        "workEffortId",
        "expectedRevision",
        "productionRunLineId",
        "productId",
        "quantity",
        "quantityUomId",
        "routingOperationWorkEffortId",
        "sourceFacilityId",
        "instructionText",
        "remove",
        "clearEmpty"
    ])
    if (begun.previous) return begun.previous
    const userScope = posting.scope()
    const run = production().runOf(userScope, p.workEffortId, true)
    const settled = posting.settled(begun.op)
    if (settled) return settled
    if (run.statusId !== "WeInPlanning")
        denied("RUN_NOT_DRAFT", "Work order " + run.workEffortId + " is " + statusText(run.statusId) + "; only a draft is edited")
    requireRevision(run, p.expectedRevision)
    const lines = production().linesOf(run.workEffortId)
    let line = null
    if (!blank(p.productionRunLineId)) {
        line = lines.find(row => row.productionRunLineId === p.productionRunLineId)
        if (!line || line.lineRoleEnumId !== "PrlrMaterial")
            denied("LINE_INVALID", "Line " + p.productionRunLineId + " is not a material line of work order " + run.workEffortId)
        if (line.manualLine !== "Y")
            denied(
                "LINE_NOT_MANUAL",
                "Line " + line.productionRunLineId + " comes from the method; change the method, or re-explode it"
            )
    }
    let resultCode, productionRunLineId
    if (yes(p.remove)) {
        if (!line) denied("LINE_REQUIRED", "Choose the manual line to remove")
        call("delete#" + LINE, {productionRunLineId: line.productionRunLineId})
        resultCode = "REMOVED"
        productionRunLineId = line.productionRunLineId
    } else {
        const productId = str(p.productId) || line?.productId
        const product = productId ? one(PRODUCT, {productId}) : null
        if (!product) denied("PRODUCT_REQUIRED", "Choose the component")
        if (product.ownerPartyId && product.ownerPartyId !== "_NA_" && !facilityScope.owns(userScope, product.ownerPartyId))
            denied("RECORD_UNAVAILABLE", "Product " + productId + " is not available")
        if (!materialTypes.includes(product.productTypeEnumId))
            denied("NOT_STOCK", "Product " + productId + " is not a stocked component")
        const output = lines.find(row => row.lineRoleEnumId === "PrlrOutput")
        if (output && output.productId === productId)
            denied("PRODUCT_INVALID", "Product " + productId + " is what the work order makes")
        const quantity = blank(p.quantity) ? (line ? dec(line.quantity) : zero()) : dec(p.quantity)
        if (quantity.compare(0) <= 0) denied("QUANTITY_INVALID", "Give a quantity above zero")
        const stockUomId = stockUnitOf(product, p.quantityUomId)
        // on a change, a field left empty keeps the line's value, or clears it with clearEmpty (an edit form that posts every
        // field): a declared but absent parameter arrives as null, so "not given" and "cleared" look alike (F-P5b-1)
        const given = field => (yes(p.clearEmpty) ? str(p[field]) : str(p[field]) || line?.[field] || null)
        const routingOperationWorkEffortId = given("routingOperationWorkEffortId")
        if (routingOperationWorkEffortId && !draftOperations(run, lines).some(op => op.value === routingOperationWorkEffortId))
            denied(
                "OPERATION_INVALID",
                "Operation " +
                    routingOperationWorkEffortId +
                    " is not an operation of work order " +
                    run.workEffortId +
                    "'s routing"
            )
        const sourceFacilityId = given("sourceFacilityId")
        if (sourceFacilityId) {
            const facility = posting.facility(userScope, sourceFacilityId)
            if (facility.ownerPartyId !== run.ownerPartyId)
                denied("FACILITY_OWNER", "Facility " + facility.facilityId + " is not " + run.ownerPartyId + "'s")
        }
        const fields = {
            productId,
            quantity,
            quantityUomId: stockUomId,
            stockQuantity: quantity,
            stockUomId,
            conversionFactor: toDecimal(1),
            routingOperationWorkEffortId,
            sourceFacilityId,
            instructionText: given("instructionText")
        }
        if (line) {
            call("update#" + LINE, Object.assign({productionRunLineId: line.productionRunLineId}, fields))
            resultCode = "UPDATED"
            productionRunLineId = line.productionRunLineId
        } else {
            const lastSeq = lines.reduce((max, row) => Math.max(max, Number(row.lineSeqNum || 0)), 0)
            productionRunLineId = call(
                "create#" + LINE,
                Object.assign(fields, {
                    workEffortId: run.workEffortId,
                    lineRoleEnumId: "PrlrMaterial",
                    lineSeqNum: lastSeq + 10,
                    manualLine: "Y"
                })
            ).productionRunLineId
            resultCode = "ADDED"
        }
    }
    // planning reads the WeptConsume rows (R-SA-05); a staged approval was given at the old revision and is asked again
    production().writeProducts(run.workEffortId, production().linesOf(run.workEffortId))
    call("update#" + WORK, {workEffortId: run.workEffortId, productionRevision: revisionOf(run) + 1})
    return posting.complete(begun.op, run.ownerPartyId, LINE, productionRunLineId, {
        resultCode,
        workEffortId: run.workEffortId,
        productionRunLineId,
        revision: revisionOf(run) + 1
    })
}

// ===== backflush =====
// What a backflush would issue (design MaterialIssueReceipt Preview backflush): each material line's exact remaining
// quantity (of the given operation's lines, or all), from the lots chosen oldest expiry first then oldest receipt, each
// asset's free quantity shared across the lines in order. A line the stock does not cover, a staged short line still short
// and a policy that issues by hand leave nothing to confirm: a backflush issues every line, or none.
function plan(userScope, p) {
    const run = production().runOf(userScope, p.workEffortId)
    if (!releasedStatuses.includes(run.statusId))
        denied("RUN_NOT_RELEASED", "Work order " + run.workEffortId + " is " + statusText(run.statusId) + "; release it first")
    const policy = productionPolicy().runPolicy(run)
    const operationWorkEffortId = str(p.operationWorkEffortId)
    if (operationWorkEffortId) {
        const op = one(WORK, {workEffortId: operationWorkEffortId})
        if (!op || op.parentWorkEffortId !== run.workEffortId)
            denied(
                "OPERATION_INVALID",
                "Operation " + operationWorkEffortId + " is not an operation of work order " + run.workEffortId
            )
    }
    const facilityIds = orders().stockFacilityIds(run)
    const lines = production()
        .linesOf(run.workEffortId)
        .filter(line => line.lineRoleEnumId === "PrlrMaterial")
        .filter(line => !operationWorkEffortId || line.operationWorkEffortId === operationWorkEffortId)
    const products = namesOf(
        PRODUCT,
        "productId",
        lines.map(line => line.productId)
    )
    const taken = new Map()
    const findings = []
    const lineRows = []
    for (const line of lines) {
        const need = production().materialTotals(line).remaining
        if (need.compare(0) <= 0) continue
        const productName = products.get(line.productId)?.productName || line.productId
        let left = need
        const picks = []
        for (const asset of candidates(run, line.productId, facilityIds, 50)) {
            if (left.compare(0) <= 0) break
            const free = dec(asset.availableToPromiseTotal).subtract(taken.get(asset.assetId) || zero())
            if (free.compare(0) <= 0 || expired(asset.assetId)) continue
            const quantity = free.compare(left) >= 0 ? left : free
            taken.set(asset.assetId, (taken.get(asset.assetId) || zero()).add(quantity))
            left = left.subtract(quantity)
            picks.push({
                assetId: asset.assetId,
                lotId: asset.lotId || null,
                facilityId: asset.facilityId,
                locationSeqId: asset.locationSeqId || null,
                quantity: text(quantity)
            })
        }
        const short = left.compare(0) > 0 ? text(left) : null
        if (short)
            findings.push({
                reasonCode: "SHORTFALL",
                productionRunLineId: line.productionRunLineId,
                message: productName + " is short " + short + " of " + text(need) + "; held stock is not issued"
            })
        if (dec(line.stagedShortQuantity).compare(0) > 0 && short)
            findings.push({
                reasonCode: "LINE_STAGED_SHORT",
                productionRunLineId: line.productionRunLineId,
                message: productName + " was released short and stays blocked until stock covers it"
            })
        lineRows.push({
            productionRunLineId: line.productionRunLineId,
            productId: line.productId,
            productName,
            operationWorkEffortId: line.operationWorkEffortId || null,
            quantity: text(need),
            stockUomId: line.stockUomId || null,
            short,
            picks,
            pickText: picks
                .map(pick => pick.quantity + " from " + (pick.lotId ? "lot " + pick.lotId + ", " : "") + pick.assetId)
                .join("; ")
        })
    }
    const backflush = policy.consumptionMethodEnumId === "PcmBackflush"
    if (!backflush)
        findings.unshift({
            reasonCode: "BACKFLUSH_NOT_POLICY",
            message: "Work order " + run.workEffortId + "'s production policy issues material by hand"
        })
    if (!lineRows.length) findings.push({reasonCode: "NOTHING_TO_ISSUE", message: "No material is left to issue"})
    // the preview's identity: the run's revision and every pick, so a confirmation issues what was shown
    const previewKey = String(
        lib.hash([run.workEffortId, revisionOf(run), lineRows.map(row => [row.productionRunLineId, row.picks])])
    )
        .replace(/[^A-Za-z0-9]/g, "")
        .slice(0, 32)
    return {
        run,
        operationWorkEffortId,
        lineRows,
        findings,
        canConfirm: findings.length === 0,
        previewKey,
        consumptionText: enumText(policy.consumptionMethodEnumId || "PcmManual"),
        issuePointText: enumText(policy.issuePointEnumId)
    }
}
function previewBackflush(p) {
    requireAny(["STOCK_ISSUE"])
    const planned = plan(posting.scope(), p)
    return {
        workEffortId: planned.run.workEffortId,
        revision: revisionOf(planned.run),
        operationWorkEffortId: planned.operationWorkEffortId,
        lineRows: planned.lineRows,
        findings: planned.findings,
        canConfirm: planned.canConfirm,
        previewKey: planned.previewKey,
        consumptionText: planned.consumptionText,
        issuePointText: planned.issuePointText
    }
}
// Confirm a backflush preview: each pick through issue#ProductionMaterial (its own operation key under this one), in this
// service's transaction, so one refusal issues nothing. A retry with the same operation key answers the first.
function backflush(p) {
    const begun = posting.begin(p, "ProductionBackflush", "STOCK_ISSUE", ["workEffortId", "operationWorkEffortId", "previewKey"])
    if (begun.previous) return begun.previous
    const userScope = posting.scope()
    production().runOf(userScope, p.workEffortId, true)
    const settled = posting.settled(begun.op)
    if (settled) return settled
    const planned = plan(userScope, p)
    if (!planned.canConfirm) denied(planned.findings[0].reasonCode, planned.findings.map(row => row.message).join("; "))
    if (blank(p.previewKey) || p.previewKey !== planned.previewKey)
        denied("PREVIEW_CHANGED", "The stock or the work order changed since the preview; review the backflush again")
    const issued = []
    for (const row of planned.lineRows)
        for (const pick of row.picks) {
            const out = call("mantle.work.ProductionServices.issue#ProductionMaterial", {
                operationKey: begun.op.operationKey + "/" + row.productionRunLineId + "/" + pick.assetId,
                workEffortId: planned.run.workEffortId,
                productionRunLineId: row.productionRunLineId,
                assetId: pick.assetId,
                quantity: dec(pick.quantity)
            }).result
            issued.push({
                productionRunLineId: row.productionRunLineId,
                assetId: pick.assetId,
                lotId: pick.lotId,
                quantity: pick.quantity,
                assetIssuanceId: out.assetIssuanceId
            })
        }
    return posting.complete(begun.op, planned.run.ownerPartyId, WORK, planned.run.workEffortId, {
        resultCode: "BACKFLUSHED",
        workEffortId: planned.run.workEffortId,
        operationWorkEffortId: planned.operationWorkEffortId,
        issued,
        issuedCount: issued.length
    })
}

// ===== shortages =====
// The open runs of the user's organizations at a facility (a plant takes the lines under it) whose material lines the free
// stock does not cover, by due date, the earliest runs first up to a limit: each with its short lines (the release gate's
// shortagesOf). A draft counts too: it is what planning will release.
function shortages(p) {
    requireAny(["PRODUCTION_VIEW"])
    const userScope = posting.scope()
    let query = find(WORK, {purposeEnumId: "WepProductionRun"}).condition("statusId", "in", openStatuses)
    if (userScope.organizationPartyIds) query = query.condition("ownerPartyId", "in", userScope.organizationPartyIds)
    if (!blank(p.facilityId)) {
        const lineIds = Array.from(find(FACILITY, {parentFacilityId: p.facilityId}).selectField("facilityId").list()).map(
            row => row.facilityId
        )
        query = query.condition("facilityId", "in", [p.facilityId, ...lineIds])
    }
    const runs = Array.from(
        query
            .orderBy("estimatedCompletionDate")
            .orderBy("workEffortId")
            .limit(shortageRunLimit + 1)
            .list()
    )
    const truncated = runs.length > shortageRunLimit
    const shortRows = []
    for (const run of runs.slice(0, shortageRunLimit)) {
        // each run on its own: one that fails is named and the others still show
        try {
            const short = orders().shortagesOf(run, production().linesOf(run.workEffortId))
            if (!short.length) continue
            shortRows.push({
                workEffortId: run.workEffortId,
                workEffortName: run.workEffortName || run.workEffortId,
                statusId: run.statusId,
                statusText: statusText(run.statusId),
                facilityId: run.facilityId || null,
                estimatedCompletionDate: run.estimatedCompletionDate || null,
                dueText: lib.dateText(run.estimatedCompletionDate),
                shortageText: short.map(row => row.productName + " short " + row.short + " of " + row.required).join("; "),
                lines: short
            })
        } catch (error) {
            ec.logger.error("Shortages of work order " + run.workEffortId + " were not read: " + error.message)
        }
    }
    return {shortRows, shortRunCount: shortRows.length, checkedRunCount: Math.min(runs.length, shortageRunLimit), truncated}
}

// The shortage notice (design §11): a release that leaves lines short (a staged release) tells the organization's planners,
// who replenish them (PRODUCTION_PLAN holders), with the run and its short lines. A notice that fails is logged; the
// release stands.
function notifyShortage(run, short) {
    if (!short?.length) return null
    try {
        return payables().execute("notify", {
            topic: "ProductionShortage",
            permission: "PRODUCTION_PLAN",
            organizationPartyId: run.ownerPartyId,
            recordEntityName: WORK,
            recordId: run.workEffortId,
            message: {
                workEffortId: run.workEffortId,
                workEffortName: run.workEffortName || run.workEffortId,
                organizationPartyId: run.ownerPartyId,
                facilityId: run.facilityId || null,
                shortText: short.map(row => row.productName + " short " + row.short + " of " + row.required).join("; "),
                lineIds: short.map(row => row.productionRunLineId)
            }
        })
    } catch (error) {
        ec.logger.error("Work order " + run.workEffortId + " shortage notice was not sent: " + error.message)
        return null
    }
}

const operations = {materials, store: storeMaterial, previewBackflush, backflush, shortages}
;({
    notifyShortage,
    execute: (op, parameters) => {
        if (!operations[op]) throw new Error("Unknown production material operation " + op)
        return operations[op](parameters)
    }
})
