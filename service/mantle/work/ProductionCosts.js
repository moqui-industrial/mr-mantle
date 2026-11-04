// Manufacturing's cost evidence (design-manufacturing §12 M8 and ProductionCosts, crosscut CX-COST; impl-manufacturing P6):
// record#ProductionCostEvent, the one writer of a ProductionCostEvent, called inside the transaction of the fact that causes
// it; get#ProductionCosts, a run's events with its frozen estimate and actuals for who may read them; and
// review#ProductionCosts, which puts the run up for Accounting's cost close.
// An event is derived from its source record alone, so a caller names the record and never a value: a material issue from
// its AssetIssuance, a return of unused material and an output receipt from their AssetReceipt. Each references the
// AcctgTrans its stock movement's hook (AssetIssuanceGlPost, AssetReceiptGlPost) posted in the same transaction and posts
// nothing itself (D12). One event per source, component and revision: a second call answers the first event. Later phases
// add their sources to the sources table: the scrap of issued material (P7), an approved TimeEntry and a machine runtime
// interval (P10, unvalued without a rate in effect), a service acceptance and a bill match (P14).
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const posting = ec.resource.script("component://mr-mantle/service/mantle/shipment/StockPosting.js")
const {find, one, rows, call, denied, access} = lib

const EVENT = "mantle.work.production.ProductionCostEvent",
    WORK = "mantle.work.effort.WorkEffort",
    LINE = "mantle.work.production.ProductionRunLine",
    ISSUANCE = "mantle.product.issuance.AssetIssuance",
    RECEIPT = "mantle.product.receipt.AssetReceipt",
    ASSET = "mantle.product.asset.Asset",
    PRODUCT = "mantle.product.Product",
    FACILITY = "mantle.facility.Facility",
    STANDARD = "mantle.product.cost.ProductStandardCost",
    TRANS = "mantle.ledger.transaction.AcctgTrans",
    ENTRY = "mantle.ledger.transaction.AcctgTransEntry"
// a run's costs are put up for review once it has been released, and until it is closed or cancelled
const reviewableStatuses = ["WeApproved", "WeInProgress", "WeOnHold", "WeComplete"]
// the estimate's components by the event component they compare with; overhead is an estimate component only (no event
// carries it: the cost close applies it, R-SA-18), so it is shown and not compared
const estimateFields = {
    PrcMaterial: "materialCost",
    PrcLabor: "laborCost",
    PrcMachine: "machineCost",
    PrcOverhead: "overheadCost",
    PrcOutside: "outsideCost"
}
// the frozen estimate's readers: Products' cost read (CostPolicy), so a financial reader sees it too
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
const text = value => (value == null ? null : dec(value).compare(0) === 0 ? "0" : String(dec(value).toNumber()))
const enumText = enumId => (enumId ? one("moqui.basic.Enumeration", {enumId})?.description || enumId : null)
const statusText = statusId => (statusId ? one("moqui.basic.StatusItem", {statusId})?.description || statusId : null)

// ===== record#ProductionCostEvent =====
// The production run a movement carries (its workEffortId, never an operation's), refused when it is none.
function runOfSource(workEffortId, what) {
    const run = workEffortId ? one(WORK, {workEffortId}) : null
    if (!run || run.purposeEnumId !== "WepProductionRun") denied("SOURCE_INVALID", what + " is not a production run's")
    return run
}
// The transaction the movement's hook posted (not a reversal or a reversed one), and its debit total.
function postedTrans(field, id) {
    return (
        Array.from(
            find(TRANS, {[field]: id})
                .condition("reversedByAcctgTransId", "is-null", null)
                .condition("reverseOfAcctgTransId", "is-null", null)
                .orderBy("transactionDate")
                .orderBy("acctgTransId")
                .limit(1)
                .list()
        )[0] || null
    )
}
const debitTotal = trans =>
    rows(ENTRY, {acctgTransId: trans.acctgTransId, debitCreditFlag: "D"}).reduce((sum, row) => sum.add(dec(row.amount)), zero())
// The ledger fields of an event from its hook's transaction, or the value a posting would have had.
function ledgerOf(trans, computed, currencyUomId) {
    return {
        acctgTransId: trans?.acctgTransId || null,
        ledgerStatusEnumId: trans ? "PclPosted" : "PclNotPosted",
        accountingDate: trans ? lib.bookDay(null, trans.transactionDate) || null : null,
        amount: trans ? debitTotal(trans) : computed,
        amountUomId: trans?.amountUomId || currencyUomId || null
    }
}
const stockUomOf = (line, productId) => line?.stockUomId || one(PRODUCT, {productId})?.amountUomId || null

// A material issue: the issuance's quantity at its asset's cost, added to WIP; an asset with no cost posts nothing
// (post#AssetIssuance's AtrNoAcquireCost) and the event is unvalued.
function issuanceEvent(assetIssuanceId) {
    const issuance = one(ISSUANCE, {assetIssuanceId})
    if (!issuance) denied("SOURCE_INVALID", "Issuance " + assetIssuanceId + " is not available")
    const run = runOfSource(issuance.workEffortId, "Issuance " + assetIssuanceId)
    const asset = one(ASSET, {assetId: issuance.assetId})
    const cost = asset?.acquireCost == null || dec(asset.acquireCost).isZero() ? null : dec(asset.acquireCost)
    const quantity = dec(issuance.quantity)
    const line = issuance.productionMaterialLineId ? one(LINE, {productionRunLineId: issuance.productionMaterialLineId}) : null
    const ledger = ledgerOf(
        postedTrans("assetIssuanceId", assetIssuanceId),
        cost ? quantity.multiply(cost) : null,
        asset?.acquireCostUomId
    )
    return Object.assign(ledger, {
        run,
        costEventTypeEnumId: "PcetMaterialIssue",
        costComponentEnumId: "PrcMaterial",
        operationWorkEffortId: issuance.operationWorkEffortId || null,
        productionRunLineId: issuance.productionMaterialLineId || null,
        productId: issuance.productId,
        quantity,
        quantityUomId: stockUomOf(line, issuance.productId),
        rateAmount: cost,
        rateEntityName: cost ? ASSET : null,
        rateId: cost ? asset.assetId : null,
        valuationStatusEnumId: cost ? "PcvValued" : "PcvUnvalued",
        assetId: issuance.assetId,
        assetIssuanceId,
        eventDate: issuance.issuedDate || ec.user.nowTimestamp
    })
}
// A return of unused material or an output receipt: the receipt's quantity at its asset's cost, relieving WIP. A receipt
// without a cost would post nothing (F13), so it is refused (COST_UNAVAILABLE) and the movement with it.
function receiptEvent(assetReceiptId) {
    const receipt = one(RECEIPT, {assetReceiptId})
    if (!receipt) denied("SOURCE_INVALID", "Receipt " + assetReceiptId + " is not available")
    const run = runOfSource(receipt.workEffortId, "Receipt " + assetReceiptId)
    const output = !!receipt.productionOutputLineId
    if (!output && !receipt.sourceAssetIssuanceId)
        denied("SOURCE_INVALID", "Receipt " + assetReceiptId + " is neither an output nor a return of run " + run.workEffortId)
    const asset = one(ASSET, {assetId: receipt.assetId})
    requireCost(asset, output ? "Output" : "Returned material")
    const issuance = output ? null : one(ISSUANCE, {assetIssuanceId: receipt.sourceAssetIssuanceId})
    const lineId = output ? receipt.productionOutputLineId : issuance?.productionMaterialLineId || null
    const line = lineId ? one(LINE, {productionRunLineId: lineId}) : null
    const quantity = dec(receipt.quantityAccepted)
    const cost = dec(asset.acquireCost)
    const ledger = ledgerOf(postedTrans("assetReceiptId", assetReceiptId), quantity.multiply(cost), asset.acquireCostUomId)
    // the output takes the frozen standard (its rate row), else the issued cost to date (provisional, the asset's)
    const standard = output && receipt.costProvisional !== "Y" && run.productStandardCostId
    return Object.assign(ledger, {
        run,
        amount: ledger.amount == null ? null : zero().subtract(ledger.amount),
        costEventTypeEnumId: output ? "PcetOutputReceipt" : "PcetMaterialReturn",
        costComponentEnumId: output ? "PrcOutput" : "PrcMaterial",
        operationWorkEffortId: receipt.operationWorkEffortId || issuance?.operationWorkEffortId || null,
        productionRunLineId: lineId,
        productId: receipt.productId,
        quantity,
        quantityUomId: stockUomOf(line, receipt.productId),
        rateAmount: cost,
        rateEntityName: standard ? STANDARD : ASSET,
        rateId: standard ? run.productStandardCostId : asset.assetId,
        valuationStatusEnumId: "PcvValued",
        assetId: receipt.assetId,
        assetIssuanceId: receipt.sourceAssetIssuanceId || null,
        assetReceiptId,
        eventDate: receipt.receivedDate || ec.user.nowTimestamp
    })
}
// The source kinds an event is derived from; a later phase adds its own.
const sources = {
    [ISSUANCE]: issuanceEvent,
    [RECEIPT]: receiptEvent
}

// Writes the event of a source revision once, inside the caller's transaction; a second call answers the first event.
function record(p) {
    if (!Object.hasOwn(sources, p.sourceEntityName)) throw new Error("Unknown production cost source " + p.sourceEntityName)
    const sourceId = String(p.sourceId ?? "")
    const sourceRevision = blank(p.sourceRevision) ? 1 : Number(p.sourceRevision)
    const event = sources[p.sourceEntityName](sourceId)
    const run = event.run
    delete event.run
    const existing = find(EVENT, {
        sourceEntityName: p.sourceEntityName,
        sourceId,
        costComponentEnumId: event.costComponentEnumId,
        sourceRevision
    }).one()
    if (existing) return {productionCostEventId: existing.productionCostEventId, existing: true}
    const created = call(
        "create#" + EVENT,
        Object.assign(event, {
            organizationPartyId: run.ownerPartyId,
            workEffortId: run.workEffortId,
            sourceEntityName: p.sourceEntityName,
            sourceId,
            sourceRevision,
            // an event after the run's close is an adjustment the cost close previews apart (R-SA-11)
            afterClose: run.statusId === "WeClosed" ? "Y" : "N",
            createdDate: ec.user.nowTimestamp,
            createdByUserId: ec.user.userId || null
        })
    )
    return {productionCostEventId: created.productionCostEventId, existing: false}
}
// The events of several sources of one kind (a guard's movements), each once; their ids.
function recordAll(sourceEntityName, sourceIds) {
    return sourceIds
        .filter(Boolean)
        .map(sourceId => call("mantle.work.ProductionServices.record#ProductionCostEvent", {sourceEntityName, sourceId}))
        .map(out => out.productionCostEventId)
}
// A receipt into WIP's relief must carry a cost (F13): the asset it goes into, refused before anything posts.
function requireCost(asset, what = "Receipt") {
    if (asset?.acquireCost == null)
        denied(
            "COST_UNAVAILABLE",
            what + " into asset " + (asset?.assetId || "") + " has no cost, so it would post nothing; it is not received"
        )
}

// ===== get#ProductionCosts =====
// The frozen estimate the run was released with, for its output quantity: the unit and total cost and each component.
function estimateOf(run, output) {
    const standard = run.productStandardCostId ? one(STANDARD, {productStandardCostId: run.productStandardCostId}) : null
    if (!standard) return {productStandardCostId: null, available: false}
    const runQuantity = dec(output?.stockQuantity)
    const batch = dec(standard.quantity).compare(0) > 0 ? dec(standard.quantity) : toDecimal(1)
    const perRun = value => (value == null ? null : dec(value).multiply(runQuantity).divide(batch, 6, "HALF_UP"))
    return {
        productStandardCostId: standard.productStandardCostId,
        available: true,
        fromDate: standard.fromDate || null,
        fromDateText: lib.dateText(standard.fromDate),
        currencyUomId: standard.priceUomId || null,
        unitCost: text(standard.unitCost),
        quantity: text(runQuantity),
        totalCost: text(dec(standard.unitCost).multiply(runQuantity)),
        components: Object.entries(estimateFields)
            .filter(([, field]) => standard[field] != null)
            .map(([componentEnumId, field]) => ({
                componentEnumId,
                componentText: enumText(componentEnumId),
                amount: text(perRun(standard[field]))
            }))
    }
}
// The run's events as rows: what any production reader sees, with each value, rate and ledger link only for financial read.
function eventRows(events, financial) {
    const names = new Map()
    const nameOf = productId => {
        if (!names.has(productId)) names.set(productId, one(PRODUCT, {productId})?.productName || productId)
        return names.get(productId)
    }
    return events.map(event => {
        const row = {
            productionCostEventId: event.productionCostEventId,
            costEventTypeEnumId: event.costEventTypeEnumId,
            eventTypeText: enumText(event.costEventTypeEnumId),
            costComponentEnumId: event.costComponentEnumId,
            componentText: enumText(event.costComponentEnumId),
            productId: event.productId || null,
            productName: event.productId ? nameOf(event.productId) : null,
            quantity: text(event.quantity),
            quantityUomId: event.quantityUomId || null,
            operationWorkEffortId: event.operationWorkEffortId || null,
            productionRunLineId: event.productionRunLineId || null,
            sourceEntityName: event.sourceEntityName,
            sourceId: event.sourceId,
            sourceRevision: event.sourceRevision == null ? null : Number(event.sourceRevision),
            assetIssuanceId: event.assetIssuanceId || null,
            assetReceiptId: event.assetReceiptId || null,
            eventDate: event.eventDate || null,
            eventDateText: lib.dateText(event.eventDate),
            valuationStatusEnumId: event.valuationStatusEnumId,
            valuationText: enumText(event.valuationStatusEnumId),
            ledgerStatusEnumId: event.ledgerStatusEnumId,
            ledgerText: enumText(event.ledgerStatusEnumId),
            afterClose: event.afterClose === "Y"
        }
        // values and ledger links are left out, not zeroed, without financial read (§2)
        if (financial)
            Object.assign(row, {
                amount: text(event.amount),
                amountUomId: event.amountUomId || null,
                rateAmount: text(event.rateAmount),
                acctgTransId: event.acctgTransId || null,
                closeAcctgTransId: event.closeAcctgTransId || null,
                accountingDate: event.accountingDate || null
            })
        return row
    })
}
// The actual cost: each component's net amount, the material issued and returned, the output's relief and what is left in
// WIP (the variance the cost close settles), in the events' currency.
function actualsOf(events) {
    const sum = filter =>
        events.filter(filter).reduce((total, event) => (event.amount == null ? total : total.add(dec(event.amount))), zero())
    const components = Array.from(new Set(events.map(event => event.costComponentEnumId))).map(componentEnumId => ({
        componentEnumId,
        componentText: enumText(componentEnumId),
        amount: text(sum(event => event.costComponentEnumId === componentEnumId))
    }))
    const currencies = Array.from(new Set(events.map(event => event.amountUomId).filter(Boolean)))
    return {
        currencyUomId: currencies.length === 1 ? currencies[0] : null,
        currencies,
        components,
        issued: text(sum(event => event.costEventTypeEnumId === "PcetMaterialIssue")),
        returned: text(zero().subtract(sum(event => event.costEventTypeEnumId === "PcetMaterialReturn"))),
        outputRelieved: text(zero().subtract(sum(event => event.costEventTypeEnumId === "PcetOutputReceipt"))),
        wipBalance: text(sum(() => true))
    }
}
// Estimate against actual per component, for a reader of both.
function comparisonOf(estimate, actuals) {
    if (!estimate.available) return []
    return estimate.components
        .filter(component => component.componentEnumId !== "PrcOverhead")
        .map(component => {
            const actual = actuals.components.find(row => row.componentEnumId === component.componentEnumId)
            const actualAmount = actual ? dec(actual.amount) : zero()
            return {
                componentEnumId: component.componentEnumId,
                componentText: component.componentText,
                estimate: component.amount,
                actual: text(actualAmount),
                difference: text(actualAmount.subtract(dec(component.amount)))
            }
        })
}
// What stands in the way of the cost close, for every reader: unvalued events, events their movement did not post, and
// events awaiting the close (P10's labor and machine, P14's accrual).
function exceptionsOf(events) {
    const count = filter => events.filter(filter).length
    return {
        eventCount: events.length,
        unvaluedCount: count(event => event.valuationStatusEnumId === "PcvUnvalued"),
        notPostedCount: count(event => event.ledgerStatusEnumId === "PclNotPosted"),
        awaitingCloseCount: count(event => event.ledgerStatusEnumId === "PclAwaitingClose"),
        afterCloseCount: count(event => event.afterClose === "Y")
    }
}
// Whether the run's costs can be put up for review now: its status, its events and a review already requested at this
// revision; the reason code when not.
function reviewBlock(run, eventCount) {
    if (!reviewableStatuses.includes(run.statusId))
        return {
            code: run.statusId === "WeInPlanning" ? "RUN_NOT_RELEASED" : "RUN_CLOSED",
            message: "Work order " + run.workEffortId + " is " + statusText(run.statusId)
        }
    if (
        run.productionCostReviewStatusId === "PcrRequested" &&
        Number(run.productionCostReviewRevision ?? -1) === Number(run.productionRevision || 0)
    )
        return {
            code: "REVIEW_REQUESTED",
            message: "The cost review of work order " + run.workEffortId + " was already requested at this revision"
        }
    if (!eventCount) return {code: "NO_COST_EVENTS", message: "Work order " + run.workEffortId + " has no costs to review yet"}
    return null
}
// The period of an accounting date, as a warning when it is closed (Accounting chooses an open date at the close).
function periodWarnings(organizationPartyId, accountingDate) {
    const guard = ec.resource.script("component://mr-mantle/service/mantle/ledger/PostingGuard.js")
    const closed = guard
        .fiscal(organizationPartyId, ec.user.nowTimestamp, false, [], accountingDate)
        .findings.find(row => row.code === "PERIOD_CLOSED")
    return closed
        ? [
              {
                  code: "PERIOD_CLOSED",
                  message: "The fiscal period of " + accountingDate + " is closed; the cost close needs an open date"
              }
          ]
        : []
}

function get(p) {
    posting.requirePermission(["PRODUCTION_VIEW", "PRODUCTION_COST_REVIEW", "ACCOUNTING_VIEW"])
    const production = ec.resource.script("component://mr-mantle/service/mantle/work/Production.js")
    const run = production.runOf(posting.scope(), p.workEffortId)
    const financial = access.has("ACCOUNTING_VIEW")
    const estimateRead = estimateReaders.some(access.has)
    const canReview = access.has("PRODUCTION_COST_REVIEW")
    const events = Array.from(
        find(EVENT, {workEffortId: run.workEffortId}).orderBy("eventDate").orderBy("productionCostEventId").list()
    )
    const output = production.linesOf(run.workEffortId).find(line => line.lineRoleEnumId === "PrlrOutput") || null
    const facility = run.facilityId ? one(FACILITY, {facilityId: run.facilityId}) : null
    const estimate = estimateRead ? estimateOf(run, output) : null
    const actuals = financial ? actualsOf(events) : null
    const block = reviewBlock(run, events.length)
    const today = lib.bookDay(null, ec.user.nowTimestamp)
    return {
        run: {
            workEffortId: run.workEffortId,
            workEffortName: run.workEffortName || null,
            statusId: run.statusId,
            statusText: statusText(run.statusId),
            facilityId: run.facilityId || null,
            facilityName: facility?.facilityName || null,
            ownerPartyId: run.ownerPartyId || null,
            ownerName: lib.partyNames([run.ownerPartyId])[run.ownerPartyId] || run.ownerPartyId || null,
            revision: Number(run.productionRevision || 0),
            releaseDate: run.productionReleaseDate || null,
            releaseDateText: lib.dateText(run.productionReleaseDate),
            productId: output?.productId || null,
            productName: output ? one(PRODUCT, {productId: output.productId})?.productName || output.productId : null,
            quantity: output ? text(output.stockQuantity) : null,
            quantityUomId: output?.stockUomId || null
        },
        events: eventRows(events, financial),
        estimate,
        actuals,
        comparison: estimate && actuals ? comparisonOf(estimate, actuals) : null,
        exceptions: exceptionsOf(events),
        review: {
            statusId: run.productionCostReviewStatusId || null,
            statusText: statusText(run.productionCostReviewStatusId) || "Not requested",
            requestedDate: run.productionCostReviewDate || null,
            requestedDateText: lib.dateText(run.productionCostReviewDate),
            requestedByUserId: run.productionCostReviewByUserId || null,
            revision: run.productionCostReviewRevision == null ? null : Number(run.productionCostReviewRevision),
            accountingDate: run.productionCostAccountingDate || null,
            note: run.productionCostReviewNote || null,
            canRequest: canReview && !block,
            blockCode: block?.code || null,
            blockMessage: block?.message || null,
            accountingDateDefault: today,
            warnings: canReview && run.ownerPartyId ? periodWarnings(run.ownerPartyId, today) : []
        },
        estimateRead,
        financialRead: financial,
        canReview
    }
}

// ===== review#ProductionCosts =====
// Puts the run's costs up for Accounting's cost close (design ProductionCosts CloseReview): the review status, date, user,
// revision, proposed accounting date and note on the run (audit-logged), and the ProductionCostReview notice with the run
// and its revision to the organization's holders of PRODUCTION_COST_POST. A closed period of the accounting date is a
// warning: Accounting posts the close at an open date.
function review(run, p) {
    if (blank(p.expectedRevision) || Number(p.expectedRevision) !== Number(run.productionRevision || 0))
        denied("REVISION_CHANGED", "Work order " + run.workEffortId + " changed; reload and review it")
    const block = reviewBlock(run, find(EVENT, {workEffortId: run.workEffortId}).count())
    if (block) denied(block.code, block.message)
    const accountingDate = blank(p.accountingDate)
        ? lib.bookDay(null, ec.user.nowTimestamp)
        : lib.calendarDateText(p.accountingDate)
    const revision = Number(run.productionRevision || 0)
    const note = blank(p.note) ? null : String(p.note).trim().slice(0, 255)
    call("update#" + WORK, {
        workEffortId: run.workEffortId,
        productionCostReviewStatusId: "PcrRequested",
        productionCostReviewDate: ec.user.nowTimestamp,
        productionCostReviewByUserId: ec.user.userId,
        productionCostReviewRevision: revision,
        productionCostAccountingDate: accountingDate,
        productionCostReviewNote: note
    })
    const exceptions = exceptionsOf(Array.from(find(EVENT, {workEffortId: run.workEffortId}).list()))
    const notice = ec.resource.script("component://mr-mantle/service/mantle/account/Payables.js").execute("notify", {
        topic: "ProductionCostReview",
        permission: "PRODUCTION_COST_POST",
        organizationPartyId: run.ownerPartyId,
        recordEntityName: WORK,
        recordId: run.workEffortId,
        message: {
            workEffortId: run.workEffortId,
            workEffortLabel: run.workEffortName ? run.workEffortName + " (" + run.workEffortId + ")" : run.workEffortId,
            organizationPartyId: run.ownerPartyId,
            sourceRevision: revision,
            accountingDate,
            note,
            unvaluedCount: exceptions.unvaluedCount,
            notPostedCount: exceptions.notPostedCount
        }
    })
    return {
        resultCode: "REVIEW_REQUESTED",
        workEffortId: run.workEffortId,
        reviewStatusId: "PcrRequested",
        revision,
        accountingDate,
        notificationMessageId: notice.notificationMessageId || null,
        exceptions,
        warnings: periodWarnings(run.ownerPartyId, accountingDate)
    }
}

const operations = {record, get}
;({
    recordAll,
    requireCost,
    review,
    execute: (op, parameters) => {
        if (!operations[op]) throw new Error("Unknown production cost operation " + op)
        return operations[op](parameters)
    }
})
