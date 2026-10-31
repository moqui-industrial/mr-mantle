// Counts with snapshots, review and guarded posting (design-warehouse §17 WH-COUNT; impl-warehouse P10), the logic of
// mantle.product.InventoryCountServices. A count is a PhysicalInventory with a count mode; its lines are
// PhysicalInventoryCount rows, one per asset the scope held when the count started (the snapshot), plus a line for stock
// found that the snapshot did not hold. Entering a count saves an observation only; review compares the snapshot, the
// balance at the time each line was counted and the movements since, and approves a line or names its conflict; posting
// adds each approved line's delta to its own asset once, in its own transaction, through Mantle's change#AssetQuantity,
// whose AssetDetail the AssetDetailPhysicalVarianceGlPost SECA values (once per asset per PhysicalInventory, F5). Blind
// counts withhold expected quantities from the server's answers until the count is submitted, and then give them to
// reviewers and adjusters only. Permissions: STOCK_COUNT to create, start, record and submit; STOCK_COUNT_REVIEW to review,
// recount and resolve; STOCK_ADJUST to post. The organization scope is FacilityScope.js's (through StockPosting.js).
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const facilityScope = ec.resource.script("component://mr-mantle/service/mantle/facility/FacilityScope.js")
const posting = ec.resource.script("component://mr-mantle/service/mantle/shipment/StockPosting.js")
const {find, one, rows, denied, call, access, ms, dateText} = lib

const PI = "mantle.product.asset.PhysicalInventory",
    LINE = "mantle.product.asset.PhysicalInventoryCount",
    ASSET = "mantle.product.asset.Asset",
    DETAIL = "mantle.product.asset.AssetDetail",
    FACILITY = "mantle.facility.Facility",
    LOCATION = "mantle.facility.FacilityLocation",
    SCHEDULE = "mantle.facility.CountSchedule",
    PRODUCT_FACILITY = "mantle.facility.ProductFacility"
const openCountStatuses = ["PIInPlanning", "PIInProgress", "PIInValidation"]
const finalLineStatuses = ["PicPosted", "PicSkipped"]
const reviewedStatuses = ["PIInValidation", "PIComplete"]
const lineLimit = 5000
const dueLimit = 2000
const scopeFields = [
    "scopeLocationTypeEnumId",
    "scopeAreaId",
    "scopeLocationSeqId",
    "scopeProductId",
    "scopeProductCategoryId",
    "scopeLotId",
    "scopeAbcClassEnumId"
]

const factory = () => ec.entity.conditionFactory
const cond = (field, operator, value) => factory().makeCondition(field, operator, value)
const anyOf = conditions => factory().makeCondition(conditions, "or")
const blank = value => value == null || String(value).trim() === ""
const text = value => (blank(value) ? null : String(value).trim())
const decimal = value => (value == null || value === "" ? null : toDecimal(value))
const dec = value => toDecimal(value ?? 0)
const textOf = value => (value == null ? null : String(toDecimal(value).toNumber()))
const truthy = value => value === true || value === "true" || value === "Y"
const unique = values => [...new Set(values.filter(value => value != null && value !== ""))]
const now = () => ec.user.nowTimestamp
const iso = value => new Date(ms(value)).toISOString()

// ===== access =====
function requireAny(permissions) {
    if (!permissions.some(permission => access.has(permission)))
        denied("PERMISSION_DENIED", permissions.join(" or ") + " is required")
}
// The count, locked when asked, in a facility of the user's organizations: a missing count, an immediate posting (no count
// mode, such as scrap or record#PhysicalInventoryQuantity's) and one outside the scope are refused alike.
function countOf(userScope, physicalInventoryId, lock = false) {
    let query = find(PI, {physicalInventoryId: physicalInventoryId || "_NA_"})
    if (lock) query = query.forUpdate(true)
    const count = blank(physicalInventoryId) ? null : query.one()
    const facility = count?.facilityId ? one(FACILITY, {facilityId: count.facilityId}) : null
    if (!count || !count.countModeEnumId || !facility || !facilityScope.owns(userScope, facility.ownerPartyId))
        denied("RECORD_UNAVAILABLE", "Count " + (physicalInventoryId || "") + " is not available")
    return {count, facility}
}
function requireStatus(count, statuses, code, message) {
    if (!statuses.includes(count.statusId)) denied(code, "Count " + count.physicalInventoryId + " " + message)
}
// A line with its count in the user's scope, both locked in the one order (the count, then its lines).
function lineOf(userScope, physicalInventoryCountId) {
    const found = blank(physicalInventoryCountId) ? null : one(LINE, {physicalInventoryCountId})
    if (!found) denied("RECORD_UNAVAILABLE", "Count line " + (physicalInventoryCountId || "") + " is not available")
    const counted = countOf(userScope, found.physicalInventoryId, true)
    const line = find(LINE, {physicalInventoryCountId}).forUpdate(true).one()
    return Object.assign({line}, counted)
}
// Expected quantities and variances are shown for a count that is not blind, and for a blind one once it is submitted, to
// reviewers and adjusters only (design CountDetail States).
function showsExpected(count) {
    if (count.blindIndicator !== "Y") return true
    return reviewedStatuses.includes(count.statusId) && (access.has("STOCK_COUNT_REVIEW") || access.has("STOCK_ADJUST"))
}
function checkEnum(value, enumTypeId, label) {
    if (blank(value)) return null
    if (one("moqui.basic.Enumeration", {enumId: value})?.enumTypeId !== enumTypeId)
        denied("COUNT_INVALID", "Choose a valid " + label)
    return value
}
// A count variance reason: an inventory variance reason that is not scrap (scrap and expiry are Adjustments' Scrap).
function checkReason(value) {
    if (blank(value)) return null
    const reason = one("moqui.basic.Enumeration", {enumId: value})
    if (reason?.enumTypeId !== "InventoryVarianceReason") denied("REASON_INVALID", "Choose a valid variance reason")
    if (reason.enumCode === "scrap") denied("REASON_INVALID", "Scrap and expiry are recorded as scrap, not as a count variance")
    return value
}
const defaultReason = delta => (dec(delta).compare(0) > 0 ? "InVrFound" : "InVrLost")

// ===== the scope =====
// The scope fields of a count, checked against its facility.
function scopeOf(p, facility) {
    const scope = {}
    for (const field of scopeFields) scope[field] = text(p[field])
    checkEnum(scope.scopeLocationTypeEnumId, "FacilityLocationType", "location type")
    checkEnum(scope.scopeAbcClassEnumId, "AbcClass", "ABC class")
    if (scope.scopeLocationSeqId && !one(LOCATION, {facilityId: facility.facilityId, locationSeqId: scope.scopeLocationSeqId}))
        denied("COUNT_INVALID", "Location " + scope.scopeLocationSeqId + " is not in facility " + facility.facilityId)
    if (scope.scopeProductId && !one("mantle.product.Product", {productId: scope.scopeProductId}))
        denied("COUNT_INVALID", "Product " + scope.scopeProductId + " is not available")
    if (
        scope.scopeProductCategoryId &&
        !one("mantle.product.category.ProductCategory", {productCategoryId: scope.scopeProductCategoryId})
    )
        denied("COUNT_INVALID", "Category " + scope.scopeProductCategoryId + " is not available")
    if (scope.scopeLotId && !one("mantle.product.asset.Lot", {lotId: scope.scopeLotId}))
        denied("COUNT_INVALID", "Lot " + scope.scopeLotId + " is not available")
    return scope
}
const hasScope = count => scopeFields.some(field => !blank(count[field]))
// The given assets: stock of the facility, each named when it is not.
function assetsOf(facility, assetIds) {
    const ids = unique(Array.from(assetIds || []).map(String))
    if (ids.length > lineLimit) denied("SCOPE_TOO_LARGE", "Count at most " + lineLimit + " assets at once")
    const found = ids.length ? Array.from(find(ASSET).condition("assetId", "in", ids).list()) : []
    for (const assetId of ids) {
        const asset = found.find(row => row.assetId === assetId)
        if (!asset || asset.facilityId !== facility.facilityId)
            denied("RECORD_UNAVAILABLE", "Asset " + assetId + " is not stock of facility " + facility.facilityId)
        if (asset.assetTypeEnumId && !posting.stockTypes.includes(asset.assetTypeEnumId))
            denied("NOT_STOCK", "Asset " + assetId + " is equipment, not stock")
    }
    return found
}
// The locations of a facility a scope or schedule names by location type, area or location; null for any location.
function locationIdsOf(facilityId, locationTypeEnumId, areaId, locationSeqId) {
    if (blank(locationTypeEnumId) && blank(areaId) && blank(locationSeqId)) return null
    let query = find(LOCATION, {facilityId}).selectField("locationSeqId")
    if (!blank(locationTypeEnumId)) query = query.condition("locationTypeEnumId", locationTypeEnumId)
    if (!blank(areaId)) query = query.condition("areaId", areaId)
    if (!blank(locationSeqId)) query = query.condition("locationSeqId", locationSeqId)
    return Array.from(query.list()).map(row => row.locationSeqId)
}
// The products a scope or schedule names by category (members in effect) or ABC class at the facility; null for any.
function productIdsOf(facilityId, productCategoryId, abcClassEnumId) {
    let ids = null
    if (!blank(productCategoryId))
        ids = Array.from(
            find("mantle.product.category.ProductCategoryMember", {productCategoryId})
                .condition(anyOf([cond("thruDate", "is-null", null), cond("thruDate", "greater", now())]))
                .selectField("productId")
                .list()
        ).map(row => row.productId)
    if (!blank(abcClassEnumId)) {
        const classed = Array.from(find(PRODUCT_FACILITY, {facilityId, abcClassEnumId}).selectField("productId").list()).map(
            row => row.productId
        )
        ids = ids ? ids.filter(id => classed.includes(id)) : classed
    }
    return ids
}
// Stock of a facility, not awaiting scrap (AstMorgue), as an asset query.
function stockQuery(facilityId) {
    return find(ASSET, {facilityId})
        .condition(anyOf([cond("assetTypeEnumId", "is-null", null), cond("assetTypeEnumId", "in", posting.stockTypes)]))
        .condition(anyOf([cond("statusId", "is-null", null), cond("statusId", "not-equals", "AstMorgue")]))
}
// Whether an asset's stock went to zero by scrap (a PhysicalInventory P6 marks scrapIndicator): that is no zero to confirm.
function scrapDepleted(detail) {
    if (!detail?.physicalInventoryId) return false
    if (!ec.entity.getEntityDefinition(PI).isField("scrapIndicator")) return false
    return one(PI, {physicalInventoryId: detail.physicalInventoryId})?.scrapIndicator === "Y"
}
// The last movement of an asset (its latest AssetDetail).
function lastMovement(assetId) {
    const latest = find(DETAIL, {assetId}).orderBy("-effectiveDate").limit(1).list()
    return latest.size() ? latest.get(0) : null
}
// The assets a count's scope holds when it starts: stock with a quantity, and for a zero confirmation the stock at its
// locations that reached zero since the location was last counted (not by scrap).
function scopeAssets(count, facility, zeroConfirmation) {
    const facilityId = facility.facilityId
    const locationIds = locationIdsOf(facilityId, count.scopeLocationTypeEnumId, count.scopeAreaId, count.scopeLocationSeqId)
    const productIds = productIdsOf(facilityId, count.scopeProductCategoryId, count.scopeAbcClassEnumId)
    if ((locationIds && !locationIds.length) || (productIds && !productIds.length)) return []
    const narrowed = query => {
        if (locationIds) query = query.condition("locationSeqId", "in", locationIds)
        if (productIds) query = query.condition("productId", "in", productIds)
        if (count.scopeProductId) query = query.condition("productId", count.scopeProductId)
        if (count.scopeLotId) query = query.condition("lotId", count.scopeLotId)
        return query
    }
    const held = Array.from(
        narrowed(stockQuery(facilityId))
            .condition("quantityOnHandTotal", "not-equals", 0)
            .orderBy("locationSeqId,productId,assetId")
            .limit(lineLimit + 1)
            .list()
    )
    if (held.length > lineLimit) denied("SCOPE_TOO_LARGE", "The scope holds more than " + lineLimit + " assets; narrow it")
    if (!zeroConfirmation) return held
    const lastCounts = new Map(
        Array.from(find(LOCATION, {facilityId}).list()).map(location => [location.locationSeqId, location.lastCountDate])
    )
    const depleted = Array.from(
        narrowed(stockQuery(facilityId))
            .condition(anyOf([cond("quantityOnHandTotal", "equals", 0), cond("quantityOnHandTotal", "is-null", null)]))
            .condition("hasQuantity", "Y")
            .orderBy("locationSeqId,productId,assetId")
            .limit(500)
            .list()
    ).filter(asset => {
        const latest = lastMovement(asset.assetId)
        const lastCount = lastCounts.get(asset.locationSeqId)
        return latest && !scrapDepleted(latest) && (lastCount == null || ms(latest.effectiveDate) > ms(lastCount))
    })
    return held.concat(depleted)
}
// A line's snapshot of an asset: its identity and quantity now.
function snapshotOf(asset, product, at) {
    return {
        facilityId: asset.facilityId,
        locationSeqId: asset.locationSeqId || null,
        productId: asset.productId,
        lotId: asset.lotId || null,
        assetId: asset.assetId,
        ownerPartyId: asset.ownerPartyId || null,
        assetPoolId: asset.assetPoolId || null,
        assetStatusId: asset.statusId || null,
        containerId: asset.containerId || null,
        quantityUomId: product?.amountUomId || null,
        snapshotQuantity: asset.quantityOnHandTotal ?? 0,
        snapshotDate: at
    }
}
const productOf = productId => (productId ? one("mantle.product.Product", {productId}) : null)

// ===== create, update, start =====
function create(p) {
    requireAny(["STOCK_COUNT"])
    return createCount(p, posting.scope())
}
function createCount(p, userScope) {
    const facility = posting.facility(userScope, p.facilityId)
    const scope = scopeOf(p, facility)
    const assets = assetsOf(facility, p.assetIds)
    const mode = checkEnum(p.countModeEnumId || "CntModeCycle", "CountMode", "count mode")
    const source = checkEnum(p.countSourceEnumId || "CntSrcPlanned", "CountSource", "count source")
    if (!scopeFields.some(field => scope[field]) && !assets.length && mode !== "CntModeFull")
        denied("SCOPE_REQUIRED", "A cycle or spot count needs a location, product, lot or assets to count")
    const blind = blank(p.blindIndicator) ? blindDefault(facility) : truthy(p.blindIndicator) ? "Y" : "N"
    if (p.assigneePartyId && !one("mantle.party.Party", {partyId: p.assigneePartyId}))
        denied("COUNT_INVALID", "Assignee " + p.assigneePartyId + " is not available")
    if (p.countScheduleId && !one(SCHEDULE, {countScheduleId: p.countScheduleId}))
        denied("COUNT_INVALID", "Count schedule " + p.countScheduleId + " is not available")
    const created = call(
        "create#" + PI,
        Object.assign({}, scope, {
            statusId: "PIInPlanning",
            facilityId: facility.facilityId,
            partyId: ec.user.userAccount?.partyId || null,
            comments: text(p.comments),
            countModeEnumId: mode,
            blindIndicator: blind,
            assigneePartyId: text(p.assigneePartyId),
            plannedDate: p.plannedDate || null,
            countSourceEnumId: source,
            sourceReference: text(p.sourceReference),
            countScheduleId: text(p.countScheduleId),
            scopeVersion: 1
        })
    )
    for (const asset of assets)
        call("create#" + LINE, {
            physicalInventoryId: created.physicalInventoryId,
            facilityId: facility.facilityId,
            locationSeqId: asset.locationSeqId || null,
            productId: asset.productId,
            lotId: asset.lotId || null,
            assetId: asset.assetId,
            statusId: "PicOpen",
            recountNumber: 0
        })
    return {physicalInventoryId: created.physicalInventoryId, lineCount: assets.length, blindIndicator: blind}
}
// The facility's blind-count default (the operation policy, F101), else not blind.
function blindDefault(facility) {
    try {
        const resolved = call("mantle.facility.WarehousePolicyServices.resolve#WarehousePolicy", {
            facilityId: facility.facilityId
        })
        return resolved.operationPolicy?.blindCount === "Y" ? "Y" : "N"
    } catch (error) {
        ec.logger.warn("Blind count default of " + facility.facilityId + ": " + error.message)
        return "N"
    }
}
function update(p) {
    requireAny(["STOCK_COUNT"])
    const userScope = posting.scope()
    const {count, facility} = countOf(userScope, p.physicalInventoryId, true)
    requireStatus(count, ["PIInPlanning"], "COUNT_NOT_PLANNED", "has started; its scope is fixed")
    if (p.expectedScopeVersion != null && Number(p.expectedScopeVersion) !== Number(count.scopeVersion || 0))
        denied("COUNT_CHANGED", "Count " + count.physicalInventoryId + " changed; reload before saving")
    const changes = {physicalInventoryId: count.physicalInventoryId}
    // a field given (an empty one clears it); a field not given keeps its value
    const given = scopeFields.filter(field => p[field] != null)
    if (given.length) {
        const scope = scopeOf(Object.assign({}, lib.map(count), lib.pick(p, given)), facility)
        if (scopeFields.some(field => (scope[field] || null) !== (count[field] || null))) {
            Object.assign(changes, scope)
            changes.scopeVersion = Number(count.scopeVersion || 0) + 1
        }
    }
    if (p.countModeEnumId) changes.countModeEnumId = checkEnum(p.countModeEnumId, "CountMode", "count mode")
    if (!blank(p.blindIndicator)) changes.blindIndicator = truthy(p.blindIndicator) ? "Y" : "N"
    if (p.assigneePartyId != null) {
        if (p.assigneePartyId && !one("mantle.party.Party", {partyId: p.assigneePartyId}))
            denied("COUNT_INVALID", "Assignee " + p.assigneePartyId + " is not available")
        changes.assigneePartyId = text(p.assigneePartyId)
    }
    if (p.plannedDate != null) changes.plannedDate = p.plannedDate || null
    if (p.comments != null) changes.comments = text(p.comments)
    call("update#" + PI, changes)
    return {physicalInventoryId: count.physicalInventoryId, scopeVersion: changes.scopeVersion ?? count.scopeVersion}
}
function start(p) {
    requireAny(["STOCK_COUNT"])
    const userScope = posting.scope()
    const {count, facility} = countOf(userScope, p.physicalInventoryId, true)
    requireStatus(count, ["PIInPlanning"], "COUNT_NOT_PLANNED", "has already started")
    const at = now()
    const planned = rows(LINE, {physicalInventoryId: count.physicalInventoryId})
    const plannedAssetIds = new Set(planned.map(line => line.assetId).filter(Boolean))
    const schedule = count.countScheduleId ? one(SCHEDULE, {countScheduleId: count.countScheduleId}) : null
    const zeroConfirmation = schedule?.scheduleKindEnumId === "CskZero"
    const scoped = hasScope(count) || !planned.length ? scopeAssets(count, facility, zeroConfirmation) : []
    const products = new Map()
    const productFor = productId => {
        if (!products.has(productId)) products.set(productId, productOf(productId))
        return products.get(productId)
    }
    for (const line of planned) {
        const asset = line.assetId ? one(ASSET, {assetId: line.assetId}) : null
        if (!asset) continue
        call(
            "update#" + LINE,
            Object.assign(
                {physicalInventoryCountId: line.physicalInventoryCountId},
                snapshotOf(asset, productFor(asset.productId), at)
            )
        )
    }
    let added = 0
    for (const asset of scoped) {
        if (plannedAssetIds.has(asset.assetId)) continue
        plannedAssetIds.add(asset.assetId)
        call(
            "create#" + LINE,
            Object.assign(
                {physicalInventoryId: count.physicalInventoryId, statusId: "PicOpen", recountNumber: 0},
                snapshotOf(asset, productFor(asset.productId), at)
            )
        )
        added++
    }
    call("update#" + PI, {
        physicalInventoryId: count.physicalInventoryId,
        statusId: "PIInProgress",
        startedDate: at,
        startedByUserId: ec.user.userId
    })
    return {physicalInventoryId: count.physicalInventoryId, lineCount: planned.length + added}
}

// ===== record =====
// An observation of a line, or of stock found that the snapshot did not hold (an extra line by product, location and
// lot). Never changes stock. With increment the quantity adds to the line's observation (scan-quantity mode), and needs an
// operation key so a repeated request is answered rather than added again.
function record(p) {
    requireAny(["STOCK_COUNT"])
    const incrementing = truthy(p.increment)
    if (incrementing && blank(p.operationKey))
        denied("OPERATION_KEY_REQUIRED", "Adding to a count needs an operation key, so a repeated scan is not added twice")
    let begun = null
    if (!blank(p.operationKey)) {
        begun = posting.begin(p, "CountRecord", "STOCK_COUNT", [
            "physicalInventoryCountId",
            "physicalInventoryId",
            "productId",
            "locationSeqId",
            "lotId",
            "quantity",
            "increment",
            "skipReasonEnumId",
            "comments"
        ])
        if (begun.previous) return begun.previous
    }
    const userScope = posting.scope()
    let found
    if (!blank(p.physicalInventoryCountId)) found = lineOf(userScope, p.physicalInventoryCountId)
    else found = extraLine(userScope, p)
    const {line, count, facility} = found
    requireStatus(count, ["PIInProgress"], "COUNT_NOT_IN_PROGRESS", "is not being counted")
    if (begun) {
        const settled = posting.settled(begun.op)
        if (settled) return settled
    }
    const skipping = !blank(p.skipReasonEnumId)
    const changes = {physicalInventoryCountId: line.physicalInventoryCountId, countedByUserId: ec.user.userId}
    if (p.comments != null) changes.comments = text(p.comments)
    if (skipping) {
        if (line.extraIndicator === "Y") denied("COUNT_INVALID", "Remove found stock by counting zero, not by skipping")
        Object.assign(changes, {
            statusId: "PicSkipped",
            skipReasonEnumId: checkEnum(p.skipReasonEnumId, "CountSkipReason", "skip reason"),
            quantityOnHand: null,
            countDate: p.countDate || now()
        })
    } else {
        let quantity = decimal(p.quantity)
        if (quantity == null) denied("QUANTITY_REQUIRED", "Enter the quantity counted; zero is a count, blank is no entry")
        if (quantity.compare(0) < 0) denied("QUANTITY_INVALID", "A counted quantity cannot be negative")
        if (incrementing && line.quantityOnHand != null) quantity = dec(line.quantityOnHand).add(quantity)
        Object.assign(changes, {
            statusId: "PicCounted",
            quantityOnHand: quantity,
            skipReasonEnumId: null,
            countDate: p.countDate || now()
        })
    }
    call("update#" + LINE, changes)
    const stored = one(LINE, {physicalInventoryCountId: line.physicalInventoryCountId})
    const answer = {
        resultCode: skipping ? "SKIPPED" : "COUNTED",
        physicalInventoryId: count.physicalInventoryId,
        physicalInventoryCountId: line.physicalInventoryCountId,
        line: lineView(stored, count, showsExpected(count), false)
    }
    if (begun) return posting.complete(begun.op, facility.ownerPartyId, LINE, line.physicalInventoryCountId, answer)
    return answer
}
// The extra line of stock found: the open count's line for that product, location and lot, made when there is none. A
// line of the snapshot for the same stock is refused: the count goes on that line (LINE_EXISTS).
function extraLine(userScope, p) {
    const {count, facility} = countOf(userScope, p.physicalInventoryId, true)
    requireStatus(count, ["PIInProgress"], "COUNT_NOT_IN_PROGRESS", "is not being counted")
    const product = productOf(p.productId)
    if (!product) denied("COUNT_INVALID", "Choose the product found")
    const locationSeqId = text(p.locationSeqId)
    if (locationSeqId && !one(LOCATION, {facilityId: facility.facilityId, locationSeqId}))
        denied("COUNT_INVALID", "Location " + locationSeqId + " is not in facility " + facility.facilityId)
    const lotId = text(p.lotId)
    if (lotId && !one("mantle.product.asset.Lot", {lotId})) denied("COUNT_INVALID", "Lot " + lotId + " is not available")
    const same = {physicalInventoryId: count.physicalInventoryId, productId: product.productId, locationSeqId, lotId}
    const existing = rows(LINE, same)
    const snapshotLine = existing.find(line => line.extraIndicator !== "Y")
    if (snapshotLine)
        denied(
            "LINE_EXISTS",
            "Count this stock on line " + snapshotLine.physicalInventoryCountId + " (" + snapshotLine.assetId + ")"
        )
    let line = existing.find(row => row.extraIndicator === "Y")
    if (!line) {
        const created = call(
            "create#" + LINE,
            Object.assign({}, same, {
                facilityId: facility.facilityId,
                extraIndicator: "Y",
                statusId: "PicOpen",
                quantityUomId: product.amountUomId || null,
                snapshotQuantity: 0,
                snapshotDate: now(),
                recountNumber: 0
            })
        )
        line = find(LINE, {physicalInventoryCountId: created.physicalInventoryCountId}).forUpdate(true).one()
    }
    return {line, count, facility}
}

// ===== review, recount, resolve =====
// The asset's quantity on hand as of a time (its AssetDetail up to then), as record#PhysicalInventoryQuantity computes it.
function quantityAsOf(assetId, at) {
    const summary = find("mantle.product.asset.AssetDetailSummary", {assetId})
        .condition("effectiveDate", "less-equals", at)
        .selectField("quantityOnHandTotal")
        .list()
    return summary.size() ? dec(summary.get(0).quantityOnHandTotal) : dec(0)
}
// The asset's movements of other records since the snapshot.
function movementsSince(assetId, since, physicalInventoryId) {
    return Array.from(
        find(DETAIL, {assetId})
            .condition("effectiveDate", "greater", since)
            .condition(
                anyOf([
                    cond("physicalInventoryId", "is-null", null),
                    cond("physicalInventoryId", "not-equals", physicalInventoryId)
                ])
            )
            .orderBy("effectiveDate")
            .limit(200)
            .list()
    )
}
// A line compared: the balance when it was counted, the movements since the snapshot, a move of the asset, and the delta
// it would post (observed less snapshot; with a conflict, observed less the balance at the count's time once carried).
function compare(line, count) {
    if (line.extraIndicator === "Y" || !line.assetId)
        return {countTime: dec(0), intervening: dec(0), conflict: null, delta: dec(line.quantityOnHand)}
    const asset = one(ASSET, {assetId: line.assetId})
    const countTime = quantityAsOf(line.assetId, line.countDate || now())
    const movements = movementsSince(line.assetId, line.snapshotDate, count.physicalInventoryId)
    const intervening = movements.reduce((total, row) => total.add(dec(row.quantityOnHandDiff)), dec(0))
    const reasons = []
    if (!asset) reasons.push("the asset is gone")
    else {
        if ((asset.locationSeqId || null) !== (line.locationSeqId || null))
            reasons.push("moved to " + (asset.locationSeqId || "no location"))
        if ((asset.containerId || null) !== (line.containerId || null))
            reasons.push(asset.containerId ? "put in container " + asset.containerId : "taken out of its container")
    }
    if (movements.length) reasons.push(movements.length + " movement" + (movements.length > 1 ? "s" : "") + " since the snapshot")
    return {
        countTime,
        intervening,
        conflict: reasons.length ? reasons.join("; ") : null,
        delta: dec(line.quantityOnHand).subtract(dec(line.snapshotQuantity))
    }
}
function review(p) {
    requireAny(["STOCK_COUNT_REVIEW"])
    const userScope = posting.scope()
    const {count} = countOf(userScope, p.physicalInventoryId, true)
    requireStatus(count, ["PIInValidation"], "COUNT_NOT_IN_REVIEW", "is not submitted for review")
    const reason = checkReason(p.varianceReasonEnumId)
    const skipUncounted = p.skipUncounted == null || truthy(p.skipUncounted)
    const at = now()
    const totals = {approved: 0, conflict: 0, skipped: 0}
    const lines = Array.from(
        find(LINE, {physicalInventoryId: count.physicalInventoryId}).orderBy("physicalInventoryCountId").forUpdate(true).list()
    )
    for (const line of lines) {
        if (line.statusId === "PicOpen") {
            if (!skipUncounted) continue
            call("update#" + LINE, {
                physicalInventoryCountId: line.physicalInventoryCountId,
                statusId: "PicSkipped",
                skipReasonEnumId: "CntSkNotCounted",
                reviewedByUserId: ec.user.userId,
                reviewedDate: at
            })
            totals.skipped++
            continue
        }
        if (!["PicCounted", "PicApproved", "PicConflict", "PicFailed"].includes(line.statusId)) continue
        const compared = compare(line, count)
        const changes = {
            physicalInventoryCountId: line.physicalInventoryCountId,
            countTimeQuantity: compared.countTime,
            interveningQuantity: compared.intervening,
            reviewedByUserId: ec.user.userId,
            reviewedDate: at,
            postReasonCode: null,
            postMessage: null
        }
        if (compared.conflict) {
            Object.assign(changes, {statusId: "PicConflict", conflictText: compared.conflict, approvedDelta: null})
            totals.conflict++
        } else {
            Object.assign(changes, {
                statusId: "PicApproved",
                conflictText: null,
                approvedDelta: compared.delta,
                varianceReasonEnumId: compared.delta.isZero()
                    ? null
                    : reason || line.varianceReasonEnumId || defaultReason(compared.delta)
            })
            totals.approved++
        }
        call("update#" + LINE, changes)
    }
    const reviewVersion = Number(count.reviewVersion || 0) + 1
    call("update#" + PI, {
        physicalInventoryId: count.physicalInventoryId,
        reviewedDate: at,
        reviewedByUserId: ec.user.userId,
        reviewVersion
    })
    return {
        physicalInventoryId: count.physicalInventoryId,
        reviewVersion,
        approvedCount: totals.approved,
        conflictCount: totals.conflict,
        skippedCount: totals.skipped
    }
}
// A line counted again: a new snapshot of its asset where it is now, its observation cleared (the audit log keeps it).
function recountLine(line) {
    const asset = line.assetId ? one(ASSET, {assetId: line.assetId}) : null
    const changes = {
        physicalInventoryCountId: line.physicalInventoryCountId,
        statusId: "PicOpen",
        quantityOnHand: null,
        countDate: null,
        countedByUserId: null,
        approvedDelta: null,
        countTimeQuantity: null,
        interveningQuantity: null,
        conflictText: null,
        postReasonCode: null,
        postMessage: null,
        skipReasonEnumId: null,
        recountNumber: Number(line.recountNumber || 0) + 1
    }
    if (asset)
        Object.assign(changes, {
            locationSeqId: asset.locationSeqId || null,
            containerId: asset.containerId || null,
            assetStatusId: asset.statusId || null,
            snapshotQuantity: asset.quantityOnHandTotal ?? 0,
            snapshotDate: now()
        })
    else if (line.extraIndicator === "Y") changes.snapshotDate = now()
    call("update#" + LINE, changes)
}
function backToCounting(count) {
    call("update#" + PI, {
        physicalInventoryId: count.physicalInventoryId,
        statusId: "PIInProgress",
        reviewVersion: Number(count.reviewVersion || 0) + 1
    })
}
const recountable = ["PicConflict", "PicFailed", "PicApproved", "PicSkipped", "PicCounted"]
function recount(p) {
    requireAny(["STOCK_COUNT_REVIEW"])
    const userScope = posting.scope()
    const {count} = countOf(userScope, p.physicalInventoryId, true)
    requireStatus(count, ["PIInValidation"], "COUNT_NOT_IN_REVIEW", "is not submitted for review")
    const lines = rows(LINE, {physicalInventoryId: count.physicalInventoryId})
    const wanted = p.lineIds?.length ? new Set(Array.from(p.lineIds).map(String)) : null
    const chosen = lines.filter(line =>
        wanted ? wanted.has(line.physicalInventoryCountId) : ["PicConflict", "PicFailed"].includes(line.statusId)
    )
    for (const line of chosen) {
        if (!recountable.includes(line.statusId))
            denied(
                "LINE_FINAL",
                "Line " + line.physicalInventoryCountId + " is " + line.statusId + " and cannot be counted again"
            )
        recountLine(find(LINE, {physicalInventoryCountId: line.physicalInventoryCountId}).forUpdate(true).one())
    }
    if (!chosen.length) denied("NOTHING_TO_RECOUNT", "Choose the lines to count again")
    backToCounting(count)
    return {physicalInventoryId: count.physicalInventoryId, recountCount: chosen.length}
}
// A conflict resolved: counted again (the default), or the observed variance carried forward from the balance at the
// count's time, with a reason, after examining the movements. A current quantity is never overwritten by a stale count.
function resolve(p) {
    requireAny(["STOCK_COUNT_REVIEW"])
    const userScope = posting.scope()
    const {line, count} = lineOf(userScope, p.physicalInventoryCountId)
    requireStatus(count, ["PIInValidation"], "COUNT_NOT_IN_REVIEW", "is not submitted for review")
    if (!["PicConflict", "PicFailed"].includes(line.statusId))
        denied("NO_CONFLICT", "Line " + line.physicalInventoryCountId + " has no conflict to resolve")
    const action = p.resolution || "recount"
    if (action === "recount") {
        recountLine(line)
        backToCounting(count)
        return {physicalInventoryCountId: line.physicalInventoryCountId, resolution: "recount", countStatusId: "PIInProgress"}
    }
    if (action !== "carry") denied("COUNT_INVALID", "Choose recount or carry the variance")
    const reason = checkReason(p.varianceReasonEnumId)
    if (!reason) denied("REASON_REQUIRED", "Give the reason for carrying the variance")
    if (line.quantityOnHand == null) denied("QUANTITY_REQUIRED", "Line " + line.physicalInventoryCountId + " was not counted")
    const countTime = line.assetId ? quantityAsOf(line.assetId, line.countDate || now()) : dec(0)
    const delta = dec(line.quantityOnHand).subtract(countTime)
    call("update#" + LINE, {
        physicalInventoryCountId: line.physicalInventoryCountId,
        statusId: "PicApproved",
        countTimeQuantity: countTime,
        approvedDelta: delta,
        varianceReasonEnumId: reason,
        comments: text(p.comments) ?? line.comments,
        reviewedByUserId: ec.user.userId,
        reviewedDate: now(),
        postReasonCode: null,
        postMessage: null
    })
    call("update#" + PI, {physicalInventoryId: count.physicalInventoryId, reviewVersion: Number(count.reviewVersion || 0) + 1})
    return {
        physicalInventoryCountId: line.physicalInventoryCountId,
        resolution: "carry",
        approvedDelta: showsExpected(count) ? textOf(delta) : null,
        countStatusId: count.statusId
    }
}

// ===== post =====
// The stock bucket of a line: its asset, or for stock found its product, location and lot (a new asset).
const bucketOf = line =>
    line.assetId ? "asset:" + line.assetId : ["found", line.productId, line.locationSeqId || "", line.lotId || ""].join(":")
function post(p) {
    const begun = posting.begin(p, "CountPost", "STOCK_ADJUST", [
        "physicalInventoryId",
        "lineIds",
        "effectiveDate",
        "reviewVersion"
    ])
    if (begun.previous) return begun.previous
    const userScope = posting.scope()
    const {count, facility} = countOf(userScope, p.physicalInventoryId)
    requireStatus(count, ["PIInValidation"], "COUNT_NOT_IN_REVIEW", "is not reviewed")
    if (p.reviewVersion != null && Number(p.reviewVersion) !== Number(count.reviewVersion || 0))
        denied("REVIEW_CHANGED", "Count " + count.physicalInventoryId + " was reviewed again; check the variances before posting")
    if (!count.reviewedDate) denied("COUNT_NOT_REVIEWED", "Review count " + count.physicalInventoryId + " before posting")
    const effectiveDate = p.effectiveDate ? iso(p.effectiveDate) : iso(now())
    if (ms(effectiveDate) > ms(now()) + 60000) denied("DATE_INVALID", "A count posts now or on an earlier date")
    const wanted = p.lineIds?.length ? new Set(Array.from(p.lineIds).map(String)) : null
    const lines = rows(LINE, {physicalInventoryId: count.physicalInventoryId}).filter(
        line => ["PicApproved", "PicFailed"].includes(line.statusId) && (!wanted || wanted.has(line.physicalInventoryCountId))
    )
    // the open period of the effective date, before anything posts (post#AcctgTrans sends a closed-period posting to the
    // error journal rather than refusing it, F155)
    periodCheck(facility, lines, effectiveDate)
    // the poster values each variance at the count's date: set before the lines post, each in its own transaction
    lib.probe("update#" + PI, {physicalInventoryId: count.physicalInventoryId, physicalInventoryDate: effectiveDate})
    const buckets = new Map()
    for (const line of lines) {
        const key = bucketOf(line)
        if (!buckets.has(key)) buckets.set(key, [])
        buckets.get(key).push(line.physicalInventoryCountId)
    }
    const results = []
    for (const [key, lineIds] of [...buckets.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
        try {
            const out = lib.probe("mantle.product.InventoryCountServices.post#CountLines", {
                physicalInventoryId: count.physicalInventoryId,
                lineIds,
                effectiveDate
            })
            results.push(Object.assign({key, ok: true}, out.result))
        } catch (error) {
            const message = String(error?.message || error).replace(/^(Error: )+/, "")
            const reasonCode = posting.reasonOf(message)
            ec.logger.warn("Count " + count.physicalInventoryId + " bucket " + key + " not posted: " + message)
            results.push({key, ok: false, lineIds, reasonCode, message})
            try {
                lib.probe("mantle.product.InventoryCountServices.fail#CountLines", {lineIds, reasonCode, message})
            } catch (markError) {
                ec.logger.error(
                    "Count " + count.physicalInventoryId + " lines " + lineIds + " not marked failed: " + markError.message
                )
            }
        }
    }
    const remaining = find(LINE, {physicalInventoryId: count.physicalInventoryId})
        .condition("statusId", "not-in", finalLineStatuses)
        .count()
    let countStatusId = count.statusId
    if (!remaining) {
        complete(count)
        countStatusId = "PIComplete"
    }
    const failed = results.filter(row => !row.ok)
    return posting.complete(begun.op, facility.ownerPartyId, PI, count.physicalInventoryId, {
        resultCode: failed.length ? (failed.length === results.length ? "FAILED" : "PARTIAL") : "POSTED",
        physicalInventoryId: count.physicalInventoryId,
        effectiveDate,
        postedCount: results.filter(row => row.ok).length,
        failedCount: failed.length,
        results,
        countStatusId
    })
}
// The period guard step of StockPosting.js (posting.period, P6) for the organizations whose stock the lines post: the
// facility's owner and each asset's owner. Until that step is in StockPosting.js the AC-06 guard in post#AcctgTrans is
// the only period check.
function periodCheck(facility, lines, effectiveDate) {
    if (typeof posting.period !== "function") return
    const assetIds = unique(lines.map(line => line.assetId))
    const owners = assetIds.length
        ? Array.from(find(ASSET).condition("assetId", "in", assetIds).selectField("ownerPartyId").distinct(true).list()).map(
              row => row.ownerPartyId
          )
        : []
    posting.period(unique([facility.ownerPartyId].concat(owners)), effectiveDate)
}
// A count with every line posted or skipped is complete; a single location's count dates that location even with no line
// (a zero confirmed where nothing was found).
function complete(count) {
    call("update#" + PI, {physicalInventoryId: count.physicalInventoryId, statusId: "PIComplete", completedDate: now()})
    if (count.scopeLocationSeqId) {
        const counted = rows(LINE, {physicalInventoryId: count.physicalInventoryId, locationSeqId: count.scopeLocationSeqId})
        if (!counted.some(line => line.statusId === "PicSkipped"))
            stampLocation(count.facilityId, count.scopeLocationSeqId, count.startedDate || now())
    }
}
function stampLocation(facilityId, locationSeqId, at) {
    const location = one(LOCATION, {facilityId, locationSeqId})
    if (location && (location.lastCountDate == null || ms(location.lastCountDate) < ms(at)))
        call("update#" + LOCATION, {facilityId, locationSeqId, lastCountDate: at})
}
function stampProduct(facilityId, productId, at) {
    const row = one(PRODUCT_FACILITY, {facilityId, productId})
    if (!row) call("create#" + PRODUCT_FACILITY, {facilityId, productId, lastCountDate: at})
    else if (row.lastCountDate == null || ms(row.lastCountDate) < ms(at))
        call("update#" + PRODUCT_FACILITY, {facilityId, productId, lastCountDate: at})
}
// One stock bucket's approved lines, in the caller's transaction: the lines and the asset locked, the reviewed version
// checked again (the asset where the line found it, nothing moved since the review), the summed delta added once
// through change#AssetQuantity (stock found: a new asset through create#ProductAssetAdHoc), and each line's outcome and
// the last count dates written. A line already posted is skipped, so a retry never posts it twice.
function postLines(p) {
    posting.requirePermission("STOCK_ADJUST")
    const userScope = posting.scope()
    const ids = unique(Array.from(p.lineIds || []).map(String)).sort()
    const lines = ids.length
        ? Array.from(
              find(LINE)
                  .condition("physicalInventoryCountId", "in", ids)
                  .orderBy("physicalInventoryCountId")
                  .forUpdate(true)
                  .list()
          )
        : []
    if (!lines.length) denied("NOTHING_TO_POST", "No count line to post")
    const {count, facility} = countOf(userScope, lines[0].physicalInventoryId)
    const open = lines.filter(line => line.statusId !== "PicPosted")
    if (!open.length) return {result: {resultCode: "ALREADY_POSTED", lineIds: ids}}
    for (const line of open) {
        if (line.physicalInventoryId !== count.physicalInventoryId) denied("COUNT_INVALID", "Lines of one count post together")
        if (!["PicApproved", "PicFailed"].includes(line.statusId) || line.approvedDelta == null)
            denied("NOT_APPROVED", "Line " + line.physicalInventoryCountId + " is not approved")
    }
    const delta = open.reduce((total, line) => total.add(dec(line.approvedDelta)), dec(0))
    const first = open[0]
    const effectiveDate = p.effectiveDate || now()
    const reason = first.varianceReasonEnumId || (delta.isZero() ? null : defaultReason(delta))
    let postAssetId = first.assetId || null,
        assetDetailId = null,
        accounting = null
    if (first.assetId) {
        const asset = find(ASSET, {assetId: first.assetId}).forUpdate(true).one()
        if (!asset || asset.facilityId !== count.facilityId)
            denied("STOCK_MOVED", "Asset " + first.assetId + " left the facility")
        if (
            (asset.locationSeqId || null) !== (first.locationSeqId || null) ||
            (asset.containerId || null) !== (first.containerId || null)
        )
            denied("STOCK_MOVED", "Asset " + first.assetId + " moved since the review; review or count it again")
        const since = first.reviewedDate || first.snapshotDate
        if (movementsSince(first.assetId, since, count.physicalInventoryId).length)
            denied("STOCK_MOVED", "Asset " + first.assetId + " changed since the review; review or count it again")
        if (find(DETAIL, {assetId: first.assetId, physicalInventoryId: count.physicalInventoryId}).count())
            denied("ALREADY_POSTED", "Asset " + first.assetId + " already has a variance of count " + count.physicalInventoryId)
        if (!delta.isZero()) {
            if (dec(asset.quantityOnHandTotal).add(delta).compare(0) < 0)
                denied(
                    "QUANTITY_EXCEEDS_ON_HAND",
                    "Asset " + first.assetId + " has only " + textOf(asset.quantityOnHandTotal) + " on hand"
                )
            call("mantle.product.AssetServices.change#AssetQuantity", {
                assetId: first.assetId,
                quantityDiff: delta,
                effectiveDate,
                productId: asset.productId,
                physicalInventoryId: count.physicalInventoryId,
                physicalInventoryCountId: first.physicalInventoryCountId,
                varianceReasonEnumId: reason
            })
        }
    } else if (!delta.isZero()) {
        if (delta.compare(0) < 0) denied("QUANTITY_INVALID", "Stock found cannot be less than zero")
        let statusId = null
        if (first.locationSeqId) {
            const open = call("mantle.facility.FacilityServices.check#FacilityLocationOpen", {
                facilityId: count.facilityId,
                locationSeqId: first.locationSeqId
            })
            const type = open.locationTypeEnumId
                ? one("mantle.facility.FacilityLocationType", {
                      facilityId: count.facilityId,
                      locationTypeEnumId: open.locationTypeEnumId
                  })
                : null
            statusId = type?.autoStatusId || null
        }
        const created = call("mantle.product.AssetServices.create#ProductAssetAdHoc", {
            productId: first.productId,
            facilityId: count.facilityId,
            locationSeqId: first.locationSeqId || null,
            lotId: first.lotId || null,
            ownerPartyId: facility.ownerPartyId,
            statusId,
            createdDate: effectiveDate
        })
        postAssetId = created.assetId
        call("create#" + DETAIL, {
            assetId: postAssetId,
            effectiveDate,
            quantityOnHandDiff: delta,
            availableToPromiseDiff: delta,
            productId: first.productId,
            physicalInventoryId: count.physicalInventoryId,
            physicalInventoryCountId: first.physicalInventoryCountId,
            varianceReasonEnumId: reason
        })
        call("mantle.product.AssetServices.reserve#IncreasedAsset", {assetId: postAssetId})
    }
    if (postAssetId && !delta.isZero()) {
        const detail = find(DETAIL, {assetId: postAssetId, physicalInventoryId: count.physicalInventoryId}).list()
        if (detail.size()) {
            assetDetailId = detail.get(0).assetDetailId
            accounting = one(DETAIL, {assetDetailId})?.acctgTransResultEnumId || null
        }
    }
    const at = now()
    for (const line of open) {
        call("update#" + LINE, {
            physicalInventoryCountId: line.physicalInventoryCountId,
            statusId: "PicPosted",
            postedDelta: line.approvedDelta,
            postedDate: at,
            postAssetId,
            assetDetailId,
            postReasonCode: accounting,
            postMessage: null
        })
        const counted = line.countDate || at
        if (line.locationSeqId) stampLocation(count.facilityId, line.locationSeqId, counted)
        if (line.productId) stampProduct(count.facilityId, line.productId, counted)
    }
    return {
        result: {
            resultCode: "POSTED",
            lineIds: open.map(line => line.physicalInventoryCountId),
            assetId: postAssetId,
            quantity: textOf(delta),
            assetDetailId,
            accountingResult: accounting
        }
    }
}
// A bucket that failed: its lines named with the reason (a move since the review is a conflict to resolve again).
function failLines(p) {
    posting.requirePermission("STOCK_ADJUST")
    for (const physicalInventoryCountId of Array.from(p.lineIds || [])) {
        const line = find(LINE, {physicalInventoryCountId}).forUpdate(true).one()
        if (!line || line.statusId === "PicPosted") continue
        const moved = p.reasonCode === "STOCK_MOVED"
        call("update#" + LINE, {
            physicalInventoryCountId,
            statusId: moved ? "PicConflict" : "PicFailed",
            conflictText: moved ? String(p.message || "").slice(0, 255) : line.conflictText,
            postReasonCode: String(p.reasonCode || "FAILED").slice(0, 60),
            postMessage: String(p.message || "").slice(0, 255)
        })
    }
    return {}
}

// ===== reads =====
const statusNames = ids =>
    new Map(
        unique(ids).length
            ? Array.from(find("moqui.basic.StatusItem").condition("statusId", "in", unique(ids)).list()).map(row => [
                  row.statusId,
                  row.description
              ])
            : []
    )
const enumNames = ids =>
    new Map(
        unique(ids).length
            ? Array.from(find("moqui.basic.Enumeration").condition("enumId", "in", unique(ids)).list()).map(row => [
                  row.enumId,
                  row.description
              ])
            : []
    )
// A line for a screen: the expected quantity, variance and value only when the count shows them to this user.
function lineView(line, count, expected, financial, names = {}) {
    const view = {
        physicalInventoryCountId: line.physicalInventoryCountId,
        physicalInventoryId: line.physicalInventoryId,
        statusId: line.statusId,
        statusText: names.status?.get(line.statusId) || line.statusId,
        facilityId: line.facilityId,
        locationSeqId: line.locationSeqId || null,
        productId: line.productId,
        productName: names.product?.get(line.productId) || line.productId,
        lotId: line.lotId || null,
        lotNumber: names.lot?.get(line.lotId) || null,
        assetId: line.assetId || null,
        serialNumber: names.serial?.get(line.assetId) || null,
        containerId: line.containerId || null,
        ownerPartyId: line.ownerPartyId || null,
        assetStatusId: line.assetStatusId || null,
        quantityUomId: line.quantityUomId || null,
        extra: line.extraIndicator === "Y",
        counted: line.quantityOnHand != null,
        quantityOnHand: textOf(line.quantityOnHand),
        countDate: line.countDate || null,
        countDateText: dateText(line.countDate),
        countedByUserId: line.countedByUserId || null,
        skipReasonEnumId: line.skipReasonEnumId || null,
        skipReasonText: names.enums?.get(line.skipReasonEnumId) || null,
        comments: line.comments || null,
        recountNumber: Number(line.recountNumber || 0),
        conflictText: line.conflictText || null,
        varianceReasonEnumId: line.varianceReasonEnumId || null,
        varianceReasonText: names.enums?.get(line.varianceReasonEnumId) || null,
        postedDate: line.postedDate || null,
        postedDateText: dateText(line.postedDate),
        postAssetId: line.postAssetId || null,
        assetDetailId: line.assetDetailId || null,
        postReasonCode: line.postReasonCode || null,
        postMessage: line.postMessage || null,
        expectedShown: expected
    }
    if (expected) {
        Object.assign(view, {
            snapshotQuantity: textOf(line.snapshotQuantity),
            snapshotDateText: dateText(line.snapshotDate),
            countTimeQuantity: textOf(line.countTimeQuantity),
            interveningQuantity: textOf(line.interveningQuantity),
            varianceQuantity:
                line.quantityOnHand == null ? null : textOf(dec(line.quantityOnHand).subtract(dec(line.snapshotQuantity))),
            approvedDelta: textOf(line.approvedDelta),
            postedDelta: textOf(line.postedDelta)
        })
        if (financial && names.cost?.has(line.assetId)) {
            const cost = names.cost.get(line.assetId)
            view.unitCost = textOf(cost.acquireCost)
            view.costUomId = cost.acquireCostUomId || null
            if (line.approvedDelta != null && cost.acquireCost != null)
                view.valueAmount = textOf(dec(line.approvedDelta).multiply(dec(cost.acquireCost)))
        }
    }
    return view
}
// The names a page of lines shows, read in one query each.
function namesFor(lines, financial) {
    const assetIds = unique(lines.map(line => line.assetId))
    const assets = assetIds.length ? Array.from(find(ASSET).condition("assetId", "in", assetIds).list()) : []
    const productIds = unique(lines.map(line => line.productId))
    const lotIds = unique(lines.map(line => line.lotId))
    return {
        status: statusNames(lines.map(line => line.statusId)),
        enums: enumNames(lines.flatMap(line => [line.skipReasonEnumId, line.varianceReasonEnumId])),
        product: new Map(
            productIds.length
                ? Array.from(find("mantle.product.Product").condition("productId", "in", productIds).list()).map(row => [
                      row.productId,
                      row.productName || row.productId
                  ])
                : []
        ),
        lot: new Map(
            lotIds.length
                ? Array.from(find("mantle.product.asset.Lot").condition("lotId", "in", lotIds).list()).map(row => [
                      row.lotId,
                      row.lotNumber
                  ])
                : []
        ),
        serial: new Map(assets.filter(asset => asset.serialNumber).map(asset => [asset.assetId, asset.serialNumber])),
        cost: financial ? new Map(assets.map(asset => [asset.assetId, asset])) : null
    }
}
// A count's header for a screen.
function headerView(count, facility) {
    const enums = enumNames([count.countModeEnumId, count.countSourceEnumId])
    const party = count.assigneePartyId ? lib.partyNames([count.assigneePartyId]) : {}
    return {
        physicalInventoryId: count.physicalInventoryId,
        statusId: count.statusId,
        statusText: statusNames([count.statusId]).get(count.statusId) || count.statusId,
        facilityId: count.facilityId,
        facilityName: facility.facilityName || facility.facilityId,
        ownerPartyId: facility.ownerPartyId,
        countModeEnumId: count.countModeEnumId,
        countModeText: enums.get(count.countModeEnumId) || count.countModeEnumId,
        countSourceEnumId: count.countSourceEnumId || null,
        countSourceText: enums.get(count.countSourceEnumId) || null,
        sourceReference: count.sourceReference || null,
        blind: count.blindIndicator === "Y",
        assigneePartyId: count.assigneePartyId || null,
        assigneeName: party[count.assigneePartyId] || count.assigneePartyId || null,
        plannedDate: count.plannedDate || null,
        plannedDateText: dateText(count.plannedDate),
        comments: count.comments || null,
        countScheduleId: count.countScheduleId || null,
        scope: Object.fromEntries(scopeFields.map(field => [field, count[field] || null])),
        scopeVersion: Number(count.scopeVersion || 0),
        reviewVersion: Number(count.reviewVersion || 0),
        startedDateText: dateText(count.startedDate),
        submittedDateText: dateText(count.submittedDate),
        reviewedDateText: dateText(count.reviewedDate),
        completedDateText: dateText(count.completedDate),
        physicalInventoryDateText: dateText(count.physicalInventoryDate)
    }
}
// One count, its line totals by status and a page of its lines (filtered by location, product, status or remaining
// ones), the conflicts' movements for those who see expected quantities. Readers: count, review and adjust.
function get(p) {
    requireAny(["STOCK_COUNT", "STOCK_COUNT_REVIEW", "STOCK_ADJUST"])
    const userScope = posting.scope()
    const {count, facility} = countOf(userScope, p.physicalInventoryId)
    if (p.facilityIds && !Array.from(p.facilityIds).includes(count.facilityId))
        denied("RECORD_UNAVAILABLE", "Count " + count.physicalInventoryId + " is not available")
    const expected = showsExpected(count)
    const financial = expected && access.has("ACCOUNTING_VIEW")
    const totals = {}
    for (const row of find(LINE, {physicalInventoryId: count.physicalInventoryId}).selectField("statusId").list())
        totals[row.statusId] = (totals[row.statusId] || 0) + 1
    const lineQuery = () => {
        let query = find(LINE, {physicalInventoryId: count.physicalInventoryId})
        if (!blank(p.locationSeqId)) query = query.condition("locationSeqId", p.locationSeqId)
        if (!blank(p.productId)) query = query.condition("productId", p.productId)
        if (!blank(p.assetId)) query = query.condition("assetId", p.assetId)
        if (!blank(p.lineStatusId)) query = query.condition("statusId", p.lineStatusId)
        if (truthy(p.remainingOnly)) query = query.condition("statusId", "PicOpen")
        query = query.orderBy("locationSeqId,productId,physicalInventoryCountId")
        return query
    }
    const paged = lib.page(lineQuery(), p, "lines", lineQuery().count(), {noLimitCap: lineLimit})
    const names = namesFor(paged.rows, financial)
    const lines = paged.rows.map(line => {
        const view = lineView(line, count, expected, financial, names)
        if (expected && line.statusId === "PicConflict" && line.assetId)
            view.movements = movementsSince(line.assetId, line.snapshotDate, count.physicalInventoryId).map(row => ({
                effectiveDateText: dateText(row.effectiveDate),
                quantity: textOf(row.quantityOnHandDiff),
                source: row.assetReceiptId
                    ? "receipt " + row.assetReceiptId
                    : row.assetIssuanceId
                      ? "issuance " + row.assetIssuanceId
                      : row.physicalInventoryId
                        ? "count or adjustment " + row.physicalInventoryId
                        : row.otherAssetId
                          ? "move with " + row.otherAssetId
                          : "movement " + row.assetDetailId
            }))
        return view
    })
    const lineCount = Object.values(totals).reduce((total, value) => total + value, 0)
    return Object.assign(
        {
            count: headerView(count, facility),
            expectedShown: expected,
            financialShown: financial,
            lineTotals: totals,
            lineCount,
            countedCount:
                (totals.PicCounted || 0) +
                (totals.PicApproved || 0) +
                (totals.PicConflict || 0) +
                (totals.PicPosted || 0) +
                (totals.PicFailed || 0),
            lines
        },
        Object.fromEntries(
            ["linesPageIndex", "linesPageSize", "linesPageMaxIndex", "linesPageRangeLow", "linesPageRangeHigh"].map(key => [
                key,
                paged[key]
            ])
        )
    )
}
// The counts of the user's facilities (the caller's facilityIds narrow them), newest first, with progress: never an
// immediate posting or a scrap record (no count mode).
function list(p) {
    requireAny(["STOCK_COUNT", "STOCK_COUNT_REVIEW", "STOCK_ADJUST"])
    const userScope = posting.scope()
    const countQuery = () => {
        let query = find(PI).condition("countModeEnumId", "is-not-null", null)
        const facilityIds = facilityIdsOf(userScope, p.facilityIds)
        if (facilityIds) query = query.condition("facilityId", "in", facilityIds.length ? facilityIds : ["_NA_"])
        if (!blank(p.facilityId)) query = query.condition("facilityId", p.facilityId)
        if (!blank(p.statusId)) query = query.condition("statusId", p.statusId)
        if (truthy(p.openOnly)) query = query.condition("statusId", "in", openCountStatuses)
        if (!blank(p.countModeEnumId)) query = query.condition("countModeEnumId", p.countModeEnumId)
        if (!blank(p.assigneePartyId)) query = query.condition("assigneePartyId", p.assigneePartyId)
        if (!blank(p.physicalInventoryId)) query = query.condition("physicalInventoryId", p.physicalInventoryId)
        if (p.fromDate) query = query.condition("plannedDate", "greater-equals", p.fromDate)
        if (p.thruDate) query = query.condition("plannedDate", "less", p.thruDate)
        query = query.orderBy("-physicalInventoryId")
        return query
    }
    const paged = lib.page(countQuery(), p, "counts", countQuery().count(), {noLimitCap: 5000})
    const ids = paged.rows.map(row => row.physicalInventoryId)
    const progress = {}
    if (ids.length)
        for (const line of find(LINE)
            .condition("physicalInventoryId", "in", ids)
            .selectField("physicalInventoryId,statusId")
            .list()) {
            const entry = (progress[line.physicalInventoryId] ||= {total: 0, counted: 0, failed: 0})
            entry.total++
            if (line.statusId !== "PicOpen") entry.counted++
            if (line.statusId === "PicFailed") entry.failed++
        }
    const facilities = new Map(
        unique(paged.rows.map(row => row.facilityId)).length
            ? Array.from(
                  find(FACILITY)
                      .condition("facilityId", "in", unique(paged.rows.map(row => row.facilityId)))
                      .list()
              ).map(row => [row.facilityId, row])
            : []
    )
    const counts = paged.rows.map(row => {
        const view = headerView(row, facilities.get(row.facilityId) || {facilityId: row.facilityId})
        const entry = progress[row.physicalInventoryId] || {total: 0, counted: 0, failed: 0}
        return Object.assign(view, {lineCount: entry.total, countedCount: entry.counted, failedCount: entry.failed})
    })
    return Object.assign(
        {counts},
        Object.fromEntries(
            [
                "countsCount",
                "countsPageIndex",
                "countsPageSize",
                "countsPageMaxIndex",
                "countsPageRangeLow",
                "countsPageRangeHigh"
            ].map(key => [key, paged[key]])
        )
    )
}
// The facilities in the organization scope, narrowed to the caller's (an app's own facility scope); null for every one.
function facilityIdsOf(userScope, given) {
    const narrowed = given == null ? null : Array.from(given).map(String)
    if (!userScope.organizationPartyIds) return narrowed
    const owned = Array.from(
        find(FACILITY)
            .condition("ownerPartyId", "in", userScope.organizationPartyIds.length ? userScope.organizationPartyIds : ["_NA_"])
            .selectField("facilityId")
            .list()
    ).map(row => row.facilityId)
    return narrowed ? owned.filter(id => narrowed.includes(id)) : owned
}

// ===== due counts =====
const dayOf = value => (value == null || value === "" ? null : ec.l10n.format(new Date(ms(value)), "yyyy-MM-dd"))
const dayMs = day => Date.parse(day + "T00:00:00Z")
const addDays = (day, days) => new Date(dayMs(day) + days * 86400000).toISOString().slice(0, 10)
const pad = number => String(number).padStart(2, "0")
// The first occurrence of an annual date after a day (on or after it when inclusive); 29 February falls back to the 28th.
function annualAfter(month, dayOfMonth, day, inclusive) {
    const year = Number(day.slice(0, 4))
    for (const candidateYear of [year, year + 1]) {
        const last = new Date(Date.UTC(candidateYear, month, 0)).getUTCDate()
        const candidate = candidateYear + "-" + pad(month) + "-" + pad(Math.min(dayOfMonth, last))
        if (inclusive ? candidate >= day : candidate > day) return candidate
    }
    return null
}
// A schedule's next date for an item last counted on lastDay (null when never), and the reason.
function nextOf(schedule, lastDay, fromDay) {
    if (schedule.scheduleKindEnumId === "CskPeriodic") {
        const days = Number(schedule.frequencyDays || 0)
        if (!(days > 0)) return null
        return lastDay ? addDays(lastDay, days) : fromDay
    }
    if (schedule.scheduleKindEnumId === "CskAnnual") {
        if (!schedule.annualMonth || !schedule.annualDay) return null
        return lastDay
            ? annualAfter(Number(schedule.annualMonth), Number(schedule.annualDay), lastDay, false)
            : annualAfter(Number(schedule.annualMonth), Number(schedule.annualDay), fromDay, true)
    }
    return null
}
const kindNames = {CskPeriodic: "periodic", CskAnnual: "annual", CskZero: "zero"}
// The schedules in effect on a day for an organization's facility (its own rows and the organization's).
function schedulesFor(facility, at) {
    return rows(SCHEDULE, {organizationPartyId: facility.ownerPartyId}).filter(
        row =>
            (!row.facilityId || row.facilityId === facility.facilityId) &&
            (ms(row.fromDate) ?? -Infinity) <= ms(at) &&
            (ms(row.thruDate) ?? Infinity) > ms(at)
    )
}
// The due items of one facility up to a day: each location (or product at the facility) with the earliest next date of
// the schedules that reach it, a location whose stock reached zero since its last count, and the planned ad hoc counts
// (Request a count, the short-pick recount).
function dueOf(facility, throughDay, todayDay) {
    const at = now()
    const items = new Map()
    // the earliest date wins; on the same day the more specific reason (zero, then periodic, then annual)
    const rank = {zero: 0, periodic: 1, annual: 2}
    const offer = (key, item) => {
        const old = items.get(key)
        if (!old || item.nextDate < old.nextDate || (item.nextDate === old.nextDate && rank[item.kind] < rank[old.kind]))
            items.set(key, item)
    }
    const locations = Array.from(
        find(LOCATION, {facilityId: facility.facilityId})
            .condition(anyOf([cond("thruDate", "is-null", null), cond("thruDate", "greater", at)]))
            .orderBy("locationSeqId")
            .limit(dueLimit)
            .list()
    )
    for (const schedule of schedulesFor(facility, at)) {
        const base = {
            facilityId: facility.facilityId,
            countScheduleId: schedule.countScheduleId,
            kind: kindNames[schedule.scheduleKindEnumId] || "periodic",
            countModeEnumId: schedule.countModeEnumId || "CntModeCycle",
            blindIndicator: schedule.blindIndicator || null,
            assigneePartyId: schedule.assigneePartyId || null
        }
        const fromDay = dayOf(schedule.fromDate) || todayDay
        const productScoped = !blank(schedule.productCategoryId) || !blank(schedule.abcClassEnumId)
        if (productScoped) {
            const productIds = productIdsOf(facility.facilityId, schedule.productCategoryId, schedule.abcClassEnumId) || []
            if (!productIds.length) continue
            const stocked = unique(
                Array.from(
                    stockQuery(facility.facilityId)
                        .condition("productId", "in", productIds)
                        .condition("quantityOnHandTotal", "not-equals", 0)
                        .selectField("productId")
                        .distinct(true)
                        .limit(dueLimit)
                        .list()
                ).map(row => row.productId)
            )
            const policies = new Map(
                stocked.length
                    ? Array.from(
                          find(PRODUCT_FACILITY, {facilityId: facility.facilityId}).condition("productId", "in", stocked).list()
                      ).map(row => [row.productId, row])
                    : []
            )
            for (const productId of stocked) {
                const lastDay = dayOf(policies.get(productId)?.lastCountDate)
                const nextDate = nextOf(schedule, lastDay, fromDay)
                if (!nextDate || nextDate > throughDay) continue
                offer(
                    "product:" + productId,
                    Object.assign({}, base, {itemType: "product", productId, lastCountDay: lastDay, nextDate})
                )
            }
            continue
        }
        const inScope = locations.filter(
            location =>
                (blank(schedule.locationTypeEnumId) || location.locationTypeEnumId === schedule.locationTypeEnumId) &&
                (blank(schedule.areaId) || location.areaId === schedule.areaId) &&
                (blank(schedule.locationSeqId) || location.locationSeqId === schedule.locationSeqId)
        )
        if (schedule.scheduleKindEnumId === "CskZero") {
            for (const location of inScope) {
                const reached = zeroReached(facility.facilityId, location)
                if (!reached || reached > throughDay) continue
                offer(
                    "location:" + location.locationSeqId,
                    Object.assign({}, base, {
                        itemType: "location",
                        locationSeqId: location.locationSeqId,
                        locationTypeEnumId: location.locationTypeEnumId || null,
                        lastCountDay: dayOf(location.lastCountDate),
                        nextDate: reached
                    })
                )
            }
            continue
        }
        for (const location of inScope) {
            const lastDay = dayOf(location.lastCountDate)
            const nextDate = nextOf(schedule, lastDay, fromDay)
            if (!nextDate || nextDate > throughDay) continue
            offer(
                "location:" + location.locationSeqId,
                Object.assign({}, base, {
                    itemType: "location",
                    locationSeqId: location.locationSeqId,
                    locationTypeEnumId: location.locationTypeEnumId || null,
                    lastCountDay: lastDay,
                    nextDate
                })
            )
        }
    }
    // the open counts of a location mark it (a count already planned or running there)
    const openCounts = Array.from(
        find(PI, {facilityId: facility.facilityId})
            .condition("countModeEnumId", "is-not-null", null)
            .condition("statusId", "in", openCountStatuses)
            .limit(500)
            .list()
    )
    const openAt = new Map()
    for (const count of openCounts) {
        if (count.scopeLocationSeqId) openAt.set(count.scopeLocationSeqId, count.physicalInventoryId)
        if (count.statusId !== "PIInPlanning")
            for (const line of find(LINE, {physicalInventoryId: count.physicalInventoryId})
                .selectField("locationSeqId")
                .distinct(true)
                .list())
                if (line.locationSeqId && !openAt.has(line.locationSeqId))
                    openAt.set(line.locationSeqId, count.physicalInventoryId)
    }
    const due = [...items.values()].map(item =>
        Object.assign(item, {
            openPhysicalInventoryId: item.locationSeqId ? openAt.get(item.locationSeqId) || null : null,
            overdue: item.nextDate < todayDay
        })
    )
    // the ad hoc dues: planned counts of Request a count and the short-pick recount
    for (const count of openCounts) {
        if (count.statusId !== "PIInPlanning" || !["CntSrcRequest", "CntSrcShortPick"].includes(count.countSourceEnumId)) continue
        const nextDate = dayOf(count.plannedDate) || dayOf(count.lastUpdatedStamp) || todayDay
        if (nextDate > throughDay) continue
        due.push({
            facilityId: facility.facilityId,
            itemType: "count",
            kind: count.countSourceEnumId === "CntSrcShortPick" ? "shortPick" : "request",
            physicalInventoryId: count.physicalInventoryId,
            openPhysicalInventoryId: count.physicalInventoryId,
            locationSeqId: count.scopeLocationSeqId || null,
            productId: count.scopeProductId || null,
            countModeEnumId: count.countModeEnumId,
            blindIndicator: count.blindIndicator || null,
            assigneePartyId: count.assigneePartyId || null,
            nextDate,
            overdue: nextDate < todayDay
        })
    }
    return due
}
// The day a location's stock reached zero since its last count: it holds no stock now and an asset there moved since the
// last count (not by scrap); null otherwise.
function zeroReached(facilityId, location) {
    if (
        stockQuery(facilityId)
            .condition({locationSeqId: location.locationSeqId})
            .condition("quantityOnHandTotal", "not-equals", 0)
            .count()
    )
        return null
    const assets = Array.from(
        stockQuery(facilityId).condition({locationSeqId: location.locationSeqId}).selectField("assetId").limit(200).list()
    ).map(row => row.assetId)
    let latest = null
    for (const assetId of assets) {
        const movement = lastMovement(assetId)
        if (!movement || scrapDepleted(movement)) continue
        if (location.lastCountDate != null && ms(movement.effectiveDate) <= ms(location.lastCountDate)) continue
        if (!latest || ms(movement.effectiveDate) > ms(latest)) latest = movement.effectiveDate
    }
    return latest ? dayOf(latest) : null
}
function dueRows(facilities, p) {
    const todayDay = dayOf(now())
    const throughDay = p.throughDate ? dayOf(p.throughDate) : addDays(todayDay, Math.max(0, Number(p.horizonDays || 0)))
    const all = []
    for (const facility of facilities) {
        try {
            all.push(...dueOf(facility, throughDay, todayDay))
        } catch (error) {
            ec.logger.error("Due counts of facility " + facility.facilityId + ": " + error.message)
        }
    }
    return all.sort((a, b) =>
        a.nextDate !== b.nextDate
            ? a.nextDate < b.nextDate
                ? -1
                : 1
            : String(a.locationSeqId || a.productId || "").localeCompare(String(b.locationSeqId || b.productId || ""))
    )
}
function due(p) {
    requireAny(["STOCK_COUNT", "STOCK_COUNT_REVIEW", "STOCK_ADJUST"])
    const userScope = posting.scope()
    let facilityIds = facilityIdsOf(userScope, p.facilityIds)
    if (!blank(p.facilityId)) facilityIds = (facilityIds || [p.facilityId]).filter(id => id === p.facilityId)
    let query = find(FACILITY)
    if (facilityIds) query = query.condition("facilityId", "in", facilityIds.length ? facilityIds : ["_NA_"])
    const facilities = Array.from(query.orderBy("facilityId").limit(200).list())
    let found = dueRows(facilities, p)
    if (truthy(p.assignedOnly)) {
        const partyId = ec.user.userAccount?.partyId
        found = found.filter(row => row.assigneePartyId && row.assigneePartyId === partyId)
    }
    const productIds = unique(found.map(row => row.productId))
    const productNames = new Map(
        productIds.length
            ? Array.from(find("mantle.product.Product").condition("productId", "in", productIds).list()).map(row => [
                  row.productId,
                  row.productName
              ])
            : []
    )
    const facilityNames = new Map(facilities.map(row => [row.facilityId, row.facilityName || row.facilityId]))
    const parties = lib.partyNames(found.map(row => row.assigneePartyId))
    const pageSize = Math.min(100, Math.max(1, Number(p.pageSize) || 50))
    const pageIndex = Math.max(0, Number(p.pageIndex) || 0)
    const rowsOut = found.slice(pageIndex * pageSize, (pageIndex + 1) * pageSize).map(row =>
        Object.assign(row, {
            facilityName: facilityNames.get(row.facilityId) || row.facilityId,
            productName: row.productId ? productNames.get(row.productId) || row.productId : null,
            assigneeName: row.assigneePartyId ? parties[row.assigneePartyId] || row.assigneePartyId : null
        })
    )
    return {
        dueRows: rowsOut,
        dueCount: found.length,
        overdueCount: found.filter(row => row.overdue).length,
        dueRowsPageIndex: pageIndex,
        dueRowsPageSize: pageSize,
        dueRowsPageMaxIndex: Math.max(0, Math.ceil(found.length / pageSize) - 1),
        dueRowsPageRangeLow: found.length ? pageIndex * pageSize + 1 : 0,
        dueRowsPageRangeHigh: Math.min(found.length, (pageIndex + 1) * pageSize)
    }
}
// Once a day per facility with due counts: its organization's counters (STOCK_COUNT) and the assignees hear of them
// (WarehouseCountsDue). Each facility is its own step: one that fails is logged and the others go on.
function notifyDue(p) {
    const facilities = Array.from(
        find(FACILITY)
            .condition(
                "ownerPartyId",
                "in",
                unique(
                    rows(SCHEDULE)
                        .filter(row => row.thruDate == null || ms(row.thruDate) > ms(now()))
                        .map(row => row.organizationPartyId)
                ).concat(["_NA_"])
            )
            .list()
    )
    let notified = 0
    for (const facility of facilities) {
        try {
            const found = dueRows([facility], {})
            if (!found.length) continue
            const already = find("moqui.security.user.NotificationMessage", {
                topic: "WarehouseCountsDue",
                recordEntityName: FACILITY,
                recordId: facility.facilityId
            })
                .condition("sentDate", "greater-equals", new Date(ms(now()) - 20 * 3600000).toISOString())
                .count()
            if (already) continue
            const notification = ec
                .makeNotificationMessage()
                .topic("WarehouseCountsDue")
                .message({
                    facilityId: facility.facilityId,
                    facilityName: facility.facilityName || facility.facilityId,
                    dueCount: found.length
                })
                .record(FACILITY, facility.facilityId)
                .userIds(countersOf(facility, found))
            notification.send()
            notified++
        } catch (error) {
            ec.logger.error("Due count notice of facility " + facility.facilityId + ": " + error.message)
        }
    }
    return {notifiedCount: notified}
}
// The users told of a facility's due counts: those with STOCK_COUNT who are agents or employees of its organization, and
// the assignees of the due items.
function countersOf(facility, found) {
    const groupIds = unique(
        rows("moqui.security.UserGroupPermission", {userPermissionId: "STOCK_COUNT"})
            .filter(row => lib.active(row))
            .map(row => row.userGroupId)
    )
    const members = groupIds.length
        ? unique(
              Array.from(find("moqui.security.UserGroupMember").condition("userGroupId", "in", groupIds).list())
                  .filter(row => lib.active(row))
                  .map(row => row.userId)
          )
        : []
    const partyIds = unique(
        Array.from(
            find("mantle.party.PartyRelationship", {toPartyId: facility.ownerPartyId})
                .condition("relationshipTypeEnumId", "in", ["PrtAgent", "PrtEmployee"])
                .list()
        )
            .filter(row => lib.active(row))
            .map(row => row.fromPartyId)
            .concat(found.map(row => row.assigneePartyId))
    )
    const accounts = partyIds.length
        ? Array.from(find("moqui.security.UserAccount").condition("partyId", "in", partyIds).list())
        : []
    const assignees = new Set(found.map(row => row.assigneePartyId).filter(Boolean))
    return unique(
        accounts.filter(account => members.includes(account.userId) || assignees.has(account.partyId)).map(row => row.userId)
    )
}

// ===== ad hoc dues =====
// Request a count (Odoo's wizard on selected stock) and the short-pick recount: a planned count of the given assets, or of a
// location or product, with a date, an assignee and the blind flag. A short-pick recount of stock an open recount already
// covers answers that count. Needs STOCK_COUNT, or SHIPMENT_PICK for a short-pick recount.
function request(p) {
    const shortPick = p.countSourceEnumId === "CntSrcShortPick"
    requireAny(shortPick ? ["STOCK_COUNT", "SHIPMENT_PICK"] : ["STOCK_COUNT"])
    const userScope = posting.scope()
    const facility = posting.facility(userScope, p.facilityId)
    if (shortPick) {
        const open = Array.from(
            find(PI, {facilityId: facility.facilityId, countSourceEnumId: "CntSrcShortPick", statusId: "PIInPlanning"}).list()
        ).find(
            count =>
                (p.scopeLocationSeqId && count.scopeLocationSeqId === p.scopeLocationSeqId) ||
                Array.from(p.assetIds || []).some(assetId => one(LINE, {physicalInventoryId: count.physicalInventoryId, assetId}))
        )
        if (open) return {physicalInventoryId: open.physicalInventoryId, existing: true}
    }
    const created = createCount(
        Object.assign({}, p, {
            countSourceEnumId: shortPick ? "CntSrcShortPick" : "CntSrcRequest",
            countModeEnumId: p.countModeEnumId || "CntModeSpot",
            plannedDate: p.plannedDate || now()
        }),
        userScope
    )
    return Object.assign(created, {existing: false})
}

// ===== import =====
// Count lines from CSV text (columns: line or asset, or location, product and lot; quantity, counted at, comments, skip
// reason), each row through record#CountLine in its own transaction: a row that fails is named and the others are saved.
// With preview nothing is saved and each row says what it would do. The answer's resultCsv is the row-result file.
function importLines(p) {
    requireAny(["STOCK_COUNT"])
    const userScope = posting.scope()
    const {count} = countOf(userScope, p.physicalInventoryId)
    requireStatus(count, ["PIInProgress"], "COUNT_NOT_IN_PROGRESS", "is not being counted")
    const csv = ec.resource.script("component://mr-mantle/service/mantle/product/CatalogCsv.js")
    const parsed = csv.parse(p.csvText, p.delimiter || ",")
    const value = (row, ...names) => {
        for (const name of names) {
            const found = Object.keys(row.sourceValues).find(key => key.toLowerCase() === name.toLowerCase())
            if (found && !blank(row.sourceValues[found])) return String(row.sourceValues[found]).trim()
        }
        return null
    }
    const preview = truthy(p.preview)
    const results = []
    for (const row of parsed.rows) {
        const out = {rowNumber: row.rowNumber, lineId: null, ok: false, reasonCode: null, message: null}
        try {
            if (row.sourceError) denied("ROW_INVALID", row.sourceError)
            let lineId = value(row, "line", "physicalInventoryCountId")
            const assetId = value(row, "asset", "assetId")
            if (!lineId && assetId)
                lineId = one(LINE, {physicalInventoryId: count.physicalInventoryId, assetId})?.physicalInventoryCountId || null
            const parameters = {
                physicalInventoryId: count.physicalInventoryId,
                physicalInventoryCountId: lineId,
                quantity: value(row, "quantity", "counted"),
                countDate: value(row, "countedAt", "countDate"),
                comments: value(row, "comments"),
                skipReasonEnumId: value(row, "skipReason", "skipReasonEnumId")
            }
            if (!lineId) {
                const locationSeqId = value(row, "location", "locationSeqId")
                const productId = value(row, "product", "productId")
                const lotId = value(row, "lot", "lotId")
                if (!productId) denied("ROW_INVALID", "Name the line, the asset, or the product found")
                const same = rows(LINE, {
                    physicalInventoryId: count.physicalInventoryId,
                    productId,
                    locationSeqId,
                    lotId: lotId || null
                })
                const existing = same.find(line => line.extraIndicator !== "Y") || same[0]
                if (existing) parameters.physicalInventoryCountId = existing.physicalInventoryCountId
                else Object.assign(parameters, {productId, locationSeqId, lotId})
            } else if (!one(LINE, {physicalInventoryCountId: lineId, physicalInventoryId: count.physicalInventoryId}))
                denied("RECORD_UNAVAILABLE", "Line " + lineId + " is not a line of count " + count.physicalInventoryId)
            if (parameters.quantity == null && !parameters.skipReasonEnumId)
                denied("QUANTITY_REQUIRED", "Enter the quantity counted; zero is a count, blank is no entry")
            if (parameters.quantity != null && !/^\d+(\.\d+)?$/.test(parameters.quantity))
                denied("QUANTITY_INVALID", "The quantity " + parameters.quantity + " is not a number of zero or more")
            out.lineId = parameters.physicalInventoryCountId
            if (!preview) {
                const saved = lib.probe("mantle.product.InventoryCountServices.record#CountLine", parameters)
                out.lineId = saved.physicalInventoryCountId || out.lineId
            }
            out.ok = true
            out.message = preview ? (out.lineId ? "Will count line " + out.lineId : "Will add stock found") : "Saved"
        } catch (error) {
            const message = String(error?.message || error).replace(/^(Error: )+/, "")
            out.reasonCode = posting.reasonOf(message)
            out.message = message
        }
        results.push(out)
    }
    return {
        results,
        savedCount: preview ? 0 : results.filter(row => row.ok).length,
        failedCount: results.filter(row => !row.ok).length,
        resultCsv: csv.csv(
            ["rowNumber", "lineId", "ok", "reasonCode", "message"],
            results.map(row => Object.assign({}, row, {ok: row.ok ? "Y" : "N"}))
        )
    }
}

// ===== the variance report =====
// Reviewed and posted count lines of the user's facilities (CountVariance): snapshot, observed, approved and posted delta
// and reason, by facility, counted date, counter, product and reason; values with financial read. For reviewers and
// adjusters only, so no counter receives a blind count's quantities; counts not yet submitted are left out.
function variance(p) {
    requireAny(["STOCK_COUNT_REVIEW", "STOCK_ADJUST"])
    const userScope = posting.scope()
    const financial = access.has("ACCOUNTING_VIEW")
    const facilityIds = facilityIdsOf(userScope, p.facilityIds)
    let counts = find(PI).condition("countModeEnumId", "is-not-null", null).condition("statusId", "in", reviewedStatuses)
    if (facilityIds) counts = counts.condition("facilityId", "in", facilityIds.length ? facilityIds : ["_NA_"])
    if (!blank(p.facilityId)) counts = counts.condition("facilityId", p.facilityId)
    if (!blank(p.physicalInventoryId)) counts = counts.condition("physicalInventoryId", p.physicalInventoryId)
    const countRows = Array.from(counts.selectField("physicalInventoryId,facilityId,statusId").limit(5000).list())
    const countIds = countRows.map(row => row.physicalInventoryId)
    const varianceQuery = () => {
        let query = find(LINE)
            .condition("physicalInventoryId", "in", countIds.length ? countIds : ["_NA_"])
            .condition("statusId", "in", ["PicApproved", "PicPosted", "PicFailed", "PicConflict"])
        if (!blank(p.productId)) query = query.condition("productId", p.productId)
        if (!blank(p.countedByUserId)) query = query.condition("countedByUserId", p.countedByUserId)
        if (!blank(p.varianceReasonEnumId)) query = query.condition("varianceReasonEnumId", p.varianceReasonEnumId)
        if (p.fromDate) query = query.condition("countDate", "greater-equals", p.fromDate)
        if (p.thruDate) query = query.condition("countDate", "less", p.thruDate)
        if (truthy(p.varianceOnly)) query = query.condition("approvedDelta", "not-equals", 0)
        query = query.orderBy("-countDate,physicalInventoryCountId")
        return query
    }
    const paged = lib.page(varianceQuery(), p, "varianceRows", varianceQuery().count(), {noLimitCap: 5000})
    const names = namesFor(paged.rows, financial)
    const users = new Map(
        unique(paged.rows.map(row => row.countedByUserId)).length
            ? Array.from(
                  find("moqui.security.UserAccount")
                      .condition("userId", "in", unique(paged.rows.map(row => row.countedByUserId)))
                      .list()
              ).map(row => [row.userId, row.userFullName || row.username])
            : []
    )
    const varianceRows = paged.rows.map(line => {
        const view = lineView(line, {blindIndicator: "N"}, true, financial, names)
        view.countedByName = users.get(line.countedByUserId) || line.countedByUserId || null
        return view
    })
    return Object.assign(
        {varianceRows, financialShown: financial},
        Object.fromEntries(
            [
                "varianceRowsCount",
                "varianceRowsPageIndex",
                "varianceRowsPageSize",
                "varianceRowsPageMaxIndex",
                "varianceRowsPageRangeLow",
                "varianceRowsPageRangeHigh"
            ].map(key => [key, paged[key]])
        )
    )
}

const operations = {
    create,
    update,
    start,
    record,
    review,
    recount,
    resolve,
    post,
    postLines,
    failLines,
    get,
    list,
    due,
    notifyDue,
    request,
    importLines,
    variance
}
;({
    countOf,
    requireStatus,
    showsExpected,
    openCountStatuses,
    execute(op, parameters) {
        if (!operations[op]) throw new Error("Unknown inventory count operation " + op)
        return operations[op](parameters)
    }
})
