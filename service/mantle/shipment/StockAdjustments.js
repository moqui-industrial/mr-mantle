// The Warehouse adjustment, scrap, lot correction and repack rules (impl-warehouse P6, design-warehouse §6 Adjustments and
// Lots, §8 Repack) that mantle.shipment.WarehouseTaskServices' entry points use beside StockPosting.js's guard steps:
//   - bucket: the exact stock bucket an adjustment changes, found as record#PhysicalInventoryQuantity and
//     record#PhysicalInventoryChange find it (product and facility; a location and a lot each a value, None or Any; the
//     owner, the facility owner unless given, as Mantle's change defaults it; pool and status a value or Any; received
//     on or before the effective date), or one fixed asset; with each asset's quantity on hand as of that date;
//   - plan: the adjustment's before and after, its change, the assets it reaches in Mantle's order, the fingerprint a
//     movement after the preview changes, and its value only for a user with ACCOUNTING_VIEW (cost is not read otherwise);
//   - lotScope: a lot whose stock is all in the user's facilities, or a lot with no stock;
//   - repackPlan: the pack conversion of a repack through Products' resolve#ScannedProduct (PRD-PACKAGING): unpack when the
//     source is a pack of the target, repack when the target is a pack of the source.
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const facilityScope = ec.resource.script("component://mr-mantle/service/mantle/facility/FacilityScope.js")
const {find, one, denied, call, hash, access} = lib

const ASSET = "mantle.product.asset.Asset"
// a bucket larger than this is refused: choose a location or lot
const bucketLimit = 500
const scopes = ["value", "none", "any"]

const blank = value => value == null || String(value).trim() === ""
const text = value => (blank(value) ? null : String(value).trim())
const decimal = value => (value == null || value === "" ? toDecimal(0) : toDecimal(String(value)))
const ms = value => lib.ms(value)

// ===== the bucket =====
// A location or lot selector: its value, or None (no location, no lot) when blank, or Any when chosen explicitly.
function selector(value, scope) {
    if (!blank(value)) return {value: text(value), scope: "value"}
    const chosen = text(scope) || "none"
    if (!scopes.includes(chosen) || chosen === "value") denied("SCOPE_INVALID", "Choose a value, None or Any")
    return {value: null, scope: chosen}
}
function bucketOf(p) {
    const date = p.physicalInventoryDate || ec.user.nowTimestamp
    if (ms(date) > ms(ec.user.nowTimestamp) + 60000) denied("DATE_INVALID", "An adjustment cannot be dated in the future")
    if (!blank(p.assetId)) {
        const asset = one(ASSET, {assetId: p.assetId})
        if (!asset || !asset.facilityId) denied("RECORD_UNAVAILABLE", "Asset " + p.assetId + " is not available")
        return {
            assetId: asset.assetId,
            productId: asset.productId,
            facilityId: asset.facilityId,
            location: {value: asset.locationSeqId || null, scope: asset.locationSeqId ? "value" : "none"},
            lot: {value: asset.lotId || null, scope: asset.lotId ? "value" : "none"},
            ownerPartyId: asset.ownerPartyId || null,
            assetPoolId: asset.assetPoolId || null,
            statusId: asset.statusId || null,
            date,
            dated: !blank(p.physicalInventoryDate)
        }
    }
    if (blank(p.productId) || blank(p.facilityId)) denied("SCOPE_REQUIRED", "Choose the product and the facility")
    const facility = one("mantle.facility.Facility", {facilityId: p.facilityId})
    return {
        assetId: null,
        productId: text(p.productId),
        facilityId: text(p.facilityId),
        location: selector(p.locationSeqId, p.locationScope),
        lot: selector(p.lotId, p.lotScope),
        // record#PhysicalInventoryChange takes the facility owner's stock when no owner is given
        ownerPartyId: text(p.ownerPartyId) || facility?.ownerPartyId || null,
        assetPoolId: text(p.assetPoolId),
        statusId: text(p.statusId),
        date,
        dated: !blank(p.physicalInventoryDate)
    }
}
// The bucket's assets as Mantle's physical inventory services find them, ordered by id (the one lock order), locked when
// asked; a fixed asset alone.
function assetsOf(bucket, lock) {
    let query = find(ASSET)
    if (bucket.assetId) query = query.condition("assetId", bucket.assetId)
    else {
        const factory = ec.entity.conditionFactory
        query = query.condition("productId", bucket.productId).condition("facilityId", bucket.facilityId)
        for (const [field, choice] of [
            ["locationSeqId", bucket.location],
            ["lotId", bucket.lot]
        ]) {
            if (choice.scope === "value") query = query.condition(field, choice.value)
            else if (choice.scope === "none") query = query.condition(field, "is-null", null)
        }
        if (bucket.ownerPartyId) query = query.condition("ownerPartyId", bucket.ownerPartyId)
        if (bucket.assetPoolId) query = query.condition("assetPoolId", bucket.assetPoolId)
        if (bucket.statusId) query = query.condition("statusId", bucket.statusId)
        query = query.condition(
            factory.makeCondition(
                [
                    factory.makeCondition("receivedDate", "less-equals", bucket.date),
                    factory.makeCondition("receivedDate", "is-null", null)
                ],
                "or"
            )
        )
    }
    const list = Array.from(
        query
            .orderBy("assetId")
            .limit(bucketLimit + 1)
            .forUpdate(!!lock)
            .list()
    )
    if (list.length > bucketLimit)
        denied("BUCKET_TOO_LARGE", "More than " + bucketLimit + " assets are in this stock; choose a location or lot")
    return list
}
// Each asset's quantity on hand as of the date (its ledger up to then), as Mantle's physical inventory services read it.
function quantitiesAsOf(assetIds, date) {
    const quantities = new Map(assetIds.map(id => [id, toDecimal(0)]))
    if (!assetIds.length) return quantities
    for (const row of Array.from(
        find("mantle.product.asset.AssetDetailSummary")
            .condition("assetId", "in", assetIds)
            .condition("effectiveDate", "less-equals", date)
            .selectField("assetId,quantityOnHandTotal")
            .list()
    ))
        quantities.set(row.assetId, decimal(row.quantityOnHandTotal))
    return quantities
}
// What a movement after the preview changes: the bucket's assets, their quantities as of the date and their ledger rows.
function fingerprintOf(bucket, assets, quantities) {
    const ids = assets.map(asset => asset.assetId)
    const ledgerRows = ids.length ? find("mantle.product.asset.AssetDetail").condition("assetId", "in", ids).count() : 0
    return hash({
        // the date when one was given (now, when not, differs between the preview and the posting)
        bucket: Object.assign({}, bucket, {date: bucket.dated ? ms(bucket.date) : null}),
        assets: ids.map(id => [id, String(quantities.get(id).toNumber())]),
        ledgerRows
    })
}
// The assets a change reaches, in record#PhysicalInventoryChange's order (oldest received first, then by id descending):
// a reduction takes from each in turn, an increase goes to the first (or a new asset when there is none).
function changeOrder(assets) {
    return assets.slice().sort((a, b) => {
        const ra = ms(a.receivedDate),
            rb = ms(b.receivedDate)
        if (ra !== rb) return ra == null ? 1 : rb == null ? -1 : ra - rb
        return String(b.assetId).localeCompare(String(a.assetId))
    })
}
// The change's value at each reached asset's cost; null (unavailable) when a reached asset has no cost.
function valueOf(bucket, assets, quantities, change) {
    const ordered = changeOrder(assets)
    if (change.isZero()) return {valueChange: toDecimal(0), costUomId: ordered[0]?.acquireCostUomId || null}
    if (change.compare(0) > 0) {
        let costAsset = ordered[0]
        if (!costAsset) {
            // a new asset takes the cost of the product's most recent asset at the facility (create#ProductAssetAdHoc)
            let query = find(ASSET, {productId: bucket.productId, facilityId: bucket.facilityId})
            if (bucket.ownerPartyId) query = query.condition("ownerPartyId", bucket.ownerPartyId)
            costAsset = query.orderBy("-assetId").limit(1).one()
        }
        if (!costAsset || costAsset.acquireCost == null) return {valueChange: null, costUomId: null}
        return {valueChange: change.multiply(costAsset.acquireCost), costUomId: costAsset.acquireCostUomId || null}
    }
    let remaining = change.negate(),
        value = toDecimal(0),
        costUomId = null
    for (const asset of ordered) {
        if (remaining.isZero()) break
        const onHand = quantities.get(asset.assetId)
        if (onHand.compare(0) <= 0) continue
        const take = remaining.compare(onHand) > 0 ? onHand : remaining
        if (asset.acquireCost == null) return {valueChange: null, costUomId: null}
        value = value.subtract(take.multiply(asset.acquireCost))
        costUomId = costUomId || asset.acquireCostUomId || null
        remaining = remaining.subtract(take)
    }
    return {valueChange: value, costUomId}
}
// The adjustment: mode count (the quantity is what is there) or delta (the quantity is the change), its before and after
// as of the effective date, the assets it reaches and the fingerprint; value only with ACCOUNTING_VIEW.
function plan(p, lock = false) {
    const mode = text(p.mode) || "count"
    if (!["count", "delta"].includes(mode)) denied("MODE_INVALID", "Choose a count or a change")
    if (blank(p.quantity)) denied("QUANTITY_REQUIRED", "Enter the counted quantity or the change; zero is a count")
    let entered
    try {
        entered = decimal(p.quantity)
    } catch (error) {
        denied("QUANTITY_INVALID", "Enter a number")
    }
    if (mode === "count" && entered.compare(0) < 0) denied("QUANTITY_INVALID", "A count cannot be below zero")
    if (mode === "delta" && entered.isZero()) denied("QUANTITY_INVALID", "A change cannot be zero; enter a count instead")
    const bucket = bucketOf(p)
    const assets = assetsOf(bucket, lock)
    const quantities = quantitiesAsOf(
        assets.map(asset => asset.assetId),
        bucket.date
    )
    const before = Array.from(quantities.values()).reduce((sum, quantity) => sum.add(quantity), toDecimal(0))
    const change = mode === "count" ? entered.subtract(before) : entered
    const after = before.add(change)
    if (after.compare(0) < 0)
        denied("QUANTITY_EXCEEDS_ON_HAND", "Only " + String(before.toNumber()) + " was on hand then; the change is too large")
    const answer = {
        mode,
        bucket,
        assets,
        quantities,
        before,
        change,
        after,
        fingerprint: fingerprintOf(bucket, assets, quantities),
        financialRead: access.has("ACCOUNTING_VIEW"),
        valueChange: null,
        costUomId: null
    }
    if (answer.financialRead) Object.assign(answer, valueOf(bucket, assets, quantities, change))
    return answer
}
// The organizations whose books an adjustment of the bucket posts to: the owners of its assets and the bucket's owner.
function postingOrganizations(adjustment) {
    return [...new Set([adjustment.bucket.ownerPartyId, ...adjustment.assets.map(asset => asset.ownerPartyId)].filter(Boolean))]
}
// The plan as a service answer: quantities as text, the bucket's selectors, and value only with financial read.
function previewOf(adjustment) {
    const {bucket} = adjustment
    const answer = {
        mode: adjustment.mode,
        productId: bucket.productId,
        facilityId: bucket.facilityId,
        assetId: bucket.assetId,
        locationSeqId: bucket.location.value,
        locationScope: bucket.location.scope,
        lotId: bucket.lot.value,
        lotScope: bucket.lot.scope,
        ownerPartyId: bucket.ownerPartyId,
        assetPoolId: bucket.assetPoolId,
        statusId: bucket.statusId,
        physicalInventoryDate: bucket.date,
        quantityBefore: String(adjustment.before.toNumber()),
        quantityChange: String(adjustment.change.toNumber()),
        quantityAfter: String(adjustment.after.toNumber()),
        previewFingerprint: adjustment.fingerprint,
        assets: adjustment.assets.map(asset => ({
            assetId: asset.assetId,
            lotId: asset.lotId || null,
            locationSeqId: asset.locationSeqId || null,
            statusId: asset.statusId || null,
            ownerPartyId: asset.ownerPartyId || null,
            quantityOnHand: String(adjustment.quantities.get(asset.assetId).toNumber())
        })),
        valueIncluded: adjustment.financialRead
    }
    if (adjustment.financialRead)
        Object.assign(answer, {
            valueChange: adjustment.valueChange == null ? null : String(adjustment.valueChange.toNumber()),
            valueAvailable: adjustment.valueChange != null,
            costUomId: adjustment.costUomId
        })
    return answer
}

// ===== lots =====
// A lot the user may correct: every facility that holds its stock is theirs (another organization's stock of the lot
// is refused, LOT_SHARED), or it has no stock. Locked for update.
function lotScope(userScope, lotId) {
    const lot = blank(lotId) ? null : find("mantle.product.asset.Lot", {lotId}).forUpdate(true).one()
    if (!lot) denied("RECORD_UNAVAILABLE", "Lot " + (lotId || "") + " is not available")
    const facilityIds = [
        ...new Set(
            Array.from(find(ASSET, {lotId}).selectField("facilityId").distinct(true).list())
                .map(row => row.facilityId)
                .filter(Boolean)
        )
    ]
    if (!facilityIds.length) return {lot, facilityIds, owners: []}
    const facilities = Array.from(find("mantle.facility.Facility").condition("facilityId", "in", facilityIds).list())
    const inScope = facilities.filter(facility => facilityScope.owns(userScope, facility.ownerPartyId))
    if (!inScope.length) denied("RECORD_UNAVAILABLE", "Lot " + lotId + " is not available")
    if (inScope.length < facilities.length)
        denied(
            "LOT_SHARED",
            "Lot " + (lot.lotNumber || lotId) + " also has stock of another organization; it cannot be corrected here"
        )
    return {lot, facilityIds, owners: [...new Set(facilities.map(facility => facility.ownerPartyId))]}
}

// ===== repack =====
// The conversion of a repack of the source asset's product into the target product, through Products' scan resolver
// (resolve#ScannedProduct, PRD-PACKAGING): unpack when the source is a pack whose contents are the target, repack when the
// target is a pack of the source. quantity is in the source's unit; a repack needs whole packs.
function repackPlan(asset, targetProductId, quantity) {
    const source = asset.productId
    const resolve = productId =>
        call("mantle.product.ProductServices.resolve#ScannedProduct", {
            scanId: productId,
            organizationPartyId: asset.ownerPartyId || null
        })
    const wanted = decimal(quantity)
    if (!(wanted.compare(0) > 0)) denied("QUANTITY_INVALID", "Give a quantity above zero")
    const asSource = resolve(source)
    if (
        asSource.found &&
        asSource.packProductId === source &&
        (blank(targetProductId) || asSource.productId === targetProductId)
    ) {
        const factor = decimal(asSource.containedQuantity)
        return {
            direction: "unpack",
            sourceProductId: source,
            targetProductId: asSource.productId,
            factor,
            targetQuantity: wanted.multiply(factor),
            quantityUomId: asSource.quantityUomId || null
        }
    }
    if (blank(targetProductId)) denied("PACK_UNDEFINED", "Product " + source + " is not a pack; choose the pack to make")
    const asTarget = resolve(targetProductId)
    if (asTarget.found && asTarget.packProductId === targetProductId && asTarget.productId === source) {
        const factor = decimal(asTarget.containedQuantity)
        const packs = wanted.divide(factor, 6, "HALF_UP")
        if (!packs.eq(packs.setScale(0, "DOWN")))
            denied(
                "QUANTITY_NOT_WHOLE_PACKS",
                "A pack of " + targetProductId + " holds " + String(factor.toNumber()) + "; repack a multiple of it"
            )
        return {
            direction: "repack",
            sourceProductId: source,
            targetProductId,
            factor,
            targetQuantity: packs.setScale(0, "DOWN"),
            quantityUomId: asTarget.quantityUomId || null
        }
    }
    denied("PACK_UNDEFINED", "No packaging converts " + source + " into " + targetProductId)
}

;({bucketOf, assetsOf, quantitiesAsOf, plan, previewOf, postingOrganizations, lotScope, repackPlan})
