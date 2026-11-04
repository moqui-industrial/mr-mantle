// The reversal of a supported pick assembly (design-manufacturing Disassembly; §12.1 reverse#SupportedAssembly; impl-manufacturing
// P9, §4, F15, F29–F32): a PtPickAssembly kit received by its WepPickAssembly work effort and still on hand is broken down
// through Mantle's breakDown#Assembly, which lowers the kit receipt (update#AssetAndReceipt, repost#Asset), and the
// component issuances it used are cancelled here, newest first, by the slices KitCost.js valued the kits at (F30): of each
// component the issued quantity from (kits received − kits reversed) × its quantity to kits received × its quantity, in
// issue order. Both reposts are dated deltas only with the kit owner's PartyAcctgPreference forwardIssuanceRepostEnabled
// (Accounting P2a, IssuanceAdjustments.js) and forwardReceiptRepostEnabled (ReceiptAdjustments.js, F32), so the posted
// history stays and an open period takes the reversing entries now; the reversal is refused naming a flag that is off.
// It is refused too for a kit that is not a pick assembly, more than is on hand (a unit already sold or shipped), a kit asset
// with physical-inventory variances (no delta for them, F31), a held kit, a closed period, components issued other than
// the kit's current BOM uses (breakDown#Assembly's PatMfgBom quantities, F15), and component slices whose cost differs from
// the kits' (the kits reversed are not the newest of the work effort, or part of a batch whose cost was split), so work in
// process nets to zero. General unbuild of produced output is not this (design §14).
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const posting = ec.resource.script("component://mr-mantle/service/mantle/shipment/StockPosting.js")
const facilityScope = ec.resource.script("component://mr-mantle/service/mantle/facility/FacilityScope.js")
const {find, one, rows, call, denied, access} = lib

const WORK = "mantle.work.effort.WorkEffort",
    ASSET = "mantle.product.asset.Asset",
    ISSUANCE = "mantle.product.issuance.AssetIssuance",
    RECEIPT = "mantle.product.receipt.AssetReceipt",
    DETAIL = "mantle.product.asset.AssetDetail",
    PRODUCT = "mantle.product.Product",
    FACILITY = "mantle.facility.Facility",
    BOM_VIEW = "mantle.work.effort.WorkEffortProductAssoc",
    TRANS = "mantle.ledger.transaction.AcctgTrans"
const heldStatuses = ["AstQuarantine", "AstOnHold", "AstDefective"]
const zero = () => toDecimal(0)
const dec = value => toDecimal(value ?? 0)
const blank = value => value == null || String(value).trim() === ""
const str = value => (blank(value) ? null : String(value).trim())
const text = value => (value == null ? null : dec(value).compare(0) === 0 ? "0" : String(dec(value).toNumber()))
const sum = (list, value) => list.reduce((total, row) => total.add(dec(value(row))), zero())
const productName = productId => (productId ? one(PRODUCT, {productId})?.productName || productId : "")
const preference = organizationPartyId =>
    call("mantle.ledger.LedgerServices.find#PartyAcctgPreference", {organizationPartyId})?.partyAcctgPreference || {}

// The kit asset in the user's scope (its facility's owner), locked when asked; a missing one and one outside are alike.
function kitOf(userScope, assetId, lock) {
    const asset = blank(assetId) ? null : find(ASSET, {assetId}).forUpdate(lock).one()
    const home = asset?.facilityId ? one(FACILITY, {facilityId: asset.facilityId}) : null
    if (!asset || !home || !facilityScope.owns(userScope, home.ownerPartyId))
        denied("RECORD_UNAVAILABLE", "Asset " + (assetId || "") + " is not available")
    return asset
}
// What a reversal of quantity kits of the asset would do, or why it is refused (design Disassembly's Preview): the work
// effort, the kits on hand, each component slice to cancel (issuance, asset, lot, quantity, value with financial read),
// the kits' value and the slices', and a previewKey over them.
function plan(userScope, p, lock = false) {
    const asset = kitOf(userScope, p.assetId, lock)
    const product = one(PRODUCT, {productId: asset.productId})
    if (product?.productTypeEnumId !== "PtPickAssembly")
        denied(
            "ASSEMBLY_UNSUPPORTED",
            productName(asset.productId) + " is not a pick assembly kit; only a kit's assembly is reversed"
        )
    const receipts = rows(RECEIPT, {assetId: asset.assetId}).filter(row => row.workEffortId)
    const effort = receipts.length ? one(WORK, {workEffortId: receipts[0].workEffortId}) : null
    if (!effort || effort.purposeEnumId !== "WepPickAssembly")
        denied("ASSEMBLY_UNSUPPORTED", "Asset " + asset.assetId + " was not received from a pick assembly")
    const flags = preference(asset.ownerPartyId)
    if (flags.forwardIssuanceRepostEnabled !== "Y")
        denied(
            "FORWARD_REPOST_REQUIRED",
            "Accounting's forwardIssuanceRepostEnabled is off for " +
                asset.ownerPartyId +
                "; a kit is reversed only with dated issuance deltas"
        )
    if (flags.forwardReceiptRepostEnabled !== "Y")
        denied(
            "FORWARD_REPOST_REQUIRED",
            "Accounting's forwardReceiptRepostEnabled is off for " +
                asset.ownerPartyId +
                "; a kit is reversed only with a dated receipt delta"
        )
    const onHand = dec(asset.quantityOnHandTotal)
    const quantity = blank(p.quantity) ? onHand : dec(p.quantity)
    if (quantity.compare(0) <= 0) {
        if (onHand.compare(0) <= 0)
            denied("KIT_SOLD", "Nothing of kit " + asset.assetId + " is on hand; a kit already sold or shipped is not reversed")
        denied("QUANTITY_INVALID", "Give a quantity above zero")
    }
    if (quantity.compare(onHand) > 0)
        denied(
            "KIT_SOLD",
            "Only " + text(onHand) + " of kit " + asset.assetId + " is on hand; a kit already sold or shipped is not reversed"
        )
    if (heldStatuses.includes(asset.statusId))
        denied("KIT_HELD", "Kit " + asset.assetId + " is held (" + asset.statusId + "); dispose of it first")
    if (find(DETAIL, {assetId: asset.assetId}).condition("physicalInventoryId", "is-not-null", null).count())
        denied("KIT_COUNTED", "Kit " + asset.assetId + " has physical inventory variances, which have no dated delta")
    posting.period([asset.ownerPartyId], ec.user.nowTimestamp, {lock})
    // the kit's components as KitCost.js reads them, and the kits the work effort received of the product
    const now = ec.user.nowTimestamp
    const bom = Array.from(
        find(BOM_VIEW, {workEffortId: effort.workEffortId, typeEnumId: "WeptProduce", productId: asset.productId})
            .conditionDate("fromDate", "thruDate", now)
            .conditionDate("componentFromDate", "componentThruDate", now)
            .list()
    )
    if (!bom.length) denied("BOM_MISSING", "Kit " + asset.productId + " has no components on work effort " + effort.workEffortId)
    const kits = sum(rows(RECEIPT, {workEffortId: effort.workEffortId, productId: asset.productId}), row => row.quantityAccepted)
    const financial = access.has("ACCOUNTING_VIEW")
    const sliceRows = []
    let sliceValue = zero(),
        valued = true
    for (const component of bom) {
        const per = dec(component.componentQuantity ?? 1)
        const issuances = Array.from(
            find(ISSUANCE, {workEffortId: effort.workEffortId, productId: component.toProductId})
                .orderBy("assetIssuanceId")
                .list()
        ).filter(row => dec(row.quantity).compare(0) > 0)
        const issued = sum(issuances, row => row.quantity)
        const used = kits.multiply(per)
        if (issued.compare(used) < 0)
            denied(
                "BOM_CHANGED",
                productName(component.toProductId) +
                    ": " +
                    text(issued) +
                    " issued where the kit's components now use " +
                    text(used) +
                    " for " +
                    text(kits) +
                    " kits; the kit's method changed since it was assembled"
            )
        // the slice [used − reversed, used) of the issuances in issue order, cancelled newest first
        const from = used.subtract(quantity.multiply(per))
        let start = zero()
        const portions = []
        for (const issuance of issuances) {
            const end = start.add(dec(issuance.quantity))
            const low = start.compare(from) > 0 ? start : from
            const high = end.compare(used) < 0 ? end : used
            if (high.compare(low) > 0) portions.push({issuance, quantity: high.subtract(low)})
            start = end
            if (start.compare(used) >= 0) break
        }
        for (const portion of portions.reverse()) {
            const source = one(ASSET, {assetId: portion.issuance.assetId})
            if (source?.acquireCost == null) valued = false
            else sliceValue = sliceValue.add(portion.quantity.multiply(source.acquireCost))
            sliceRows.push({
                productId: component.toProductId,
                productName: productName(component.toProductId),
                assetIssuanceId: portion.issuance.assetIssuanceId,
                assetId: portion.issuance.assetId,
                lotId: source?.lotId || null,
                statusId: source?.statusId || null,
                issued: text(portion.issuance.quantity),
                quantity: text(portion.quantity),
                componentQuantity: text(per),
                unitCost: financial && source?.acquireCost != null ? String(source.acquireCost) : null,
                value: financial && source?.acquireCost != null ? text(portion.quantity.multiply(source.acquireCost)) : null
            })
        }
    }
    // the kits were received at their components' cost (kitCostFromComponents): the slices must carry that value exactly
    const kitValue = asset.acquireCost == null ? null : quantity.multiply(asset.acquireCost)
    if (kitValue != null && (!valued || sliceValue.compare(kitValue) !== 0))
        denied(
            "COST_SLICE_MISMATCH",
            "The " +
                text(quantity) +
                " kits were received at " +
                text(kitValue) +
                " while the newest component issues they would return carry " +
                (valued ? text(sliceValue) : "no cost") +
                "; reverse the newest kits of the work effort first, all of a batch whose cost was split"
        )
    const previewKey = lib.hash({
        assetId: asset.assetId,
        onHand: text(onHand),
        quantity: text(quantity),
        slices: sliceRows.map(row => [row.assetIssuanceId, row.quantity])
    })
    return {
        asset,
        effort,
        quantity,
        sliceRows,
        answer: {
            assetId: asset.assetId,
            productId: asset.productId,
            productName: product.productName || asset.productId,
            workEffortId: effort.workEffortId,
            workEffortName: effort.workEffortName || effort.workEffortId,
            facilityId: asset.facilityId,
            onHand: text(onHand),
            quantity: text(quantity),
            kitsReceived: text(kits),
            kitValue: financial && kitValue != null ? text(kitValue) : null,
            sliceValue: financial && valued ? text(sliceValue) : null,
            componentRows: sliceRows,
            previewKey
        }
    }
}
function preview(p) {
    if (!access.has("PRODUCTION_SUPERVISE") && !access.has("PRODUCTION_VIEW"))
        denied("PERMISSION_DENIED", "PRODUCTION_SUPERVISE or PRODUCTION_VIEW is required")
    return plan(posting.scope(), p).answer
}
// reverse#SupportedAssembly: the kits broken down and the slices cancelled in one transaction, at the preview the user saw.
function reverse(p) {
    const begun = posting.begin(p, "SupportedAssemblyReversal", "PRODUCTION_SUPERVISE", [
        "assetId",
        "quantity",
        "previewKey",
        "reason"
    ])
    if (begun.previous) return begun.previous
    const userScope = posting.scope()
    const found = plan(userScope, p, true)
    const settled = posting.settled(begun.op)
    if (settled) return settled
    if (blank(p.reason)) denied("REASON_REQUIRED", "Give the reason for the reversal")
    if (blank(p.previewKey)) denied("PREVIEW_REQUIRED", "Review the reversal first")
    if (p.previewKey !== found.answer.previewKey)
        denied("PREVIEW_CHANGED", "The kit changed since it was previewed; review it again")
    const started = ec.user.nowTimestamp
    const receiptIds = rows(RECEIPT, {assetId: found.asset.assetId, workEffortId: found.effort.workEffortId}).map(
        row => row.assetReceiptId
    )
    const broken = call("mantle.work.ManufacturingServices.breakDown#Assembly", {
        assetId: found.asset.assetId,
        workEffortId: found.effort.workEffortId,
        quantityToBreakDown: found.quantity,
        unissueAssemblyComponents: false,
        breakDownDate: started
    })
    for (const row of found.sliceRows)
        call("mantle.product.AssetServices.cancel#AssetIssuance", {
            assetIssuanceId: row.assetIssuanceId,
            quantityToCancel: dec(row.quantity),
            reserveAsset: false
        })
    // the dated reversing entries this made: the receipt's and the issuances' deltas
    const issuanceIds = found.sliceRows.map(row => row.assetIssuanceId)
    const entries = Array.from(
        find(TRANS)
            .condition("transactionDate", "greater-equals", started)
            .condition(
                ec.entity.conditionFactory.makeCondition(
                    [
                        ec.entity.conditionFactory.makeCondition(
                            "assetReceiptId",
                            "in",
                            receiptIds.length ? receiptIds : ["_NONE_"]
                        ),
                        ec.entity.conditionFactory.makeCondition("assetIssuanceId", "in", issuanceIds)
                    ],
                    "or"
                )
            )
            .list()
    ).map(row => row.acctgTransId)
    return posting.complete(begun.op, found.asset.ownerPartyId, ASSET, found.asset.assetId, {
        resultCode: "REVERSED",
        assetId: found.asset.assetId,
        workEffortId: found.effort.workEffortId,
        quantity: text(broken.quantityBrokenDown ?? found.quantity),
        cancelledIssuanceIds: issuanceIds,
        acctgTransIds: entries,
        reason: str(p.reason)
    })
}

const operations = {preview, reverse}
;({
    execute: (op, parameters) => {
        if (!operations[op]) throw new Error("Unknown supported assembly operation " + op)
        return operations[op](parameters)
    }
})
