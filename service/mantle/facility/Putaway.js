// Putaway (design-warehouse §17 WH-PUTAWAY, §4 Putaway and §12 PutawayRules; impl-warehouse P9): the putaway rules
// (mantle.facility.PutawayRule), where stock goes (resolve#Destination) and how full a location is (get#Capacity).
//   - Rules are dated rows of a facility, written by store#PutawayRule with FACILITY_EDIT in the facility's organization
//     (FacilityScope.js): a change ends the row in effect and starts the next with its fields audit-logged under the
//     reason; history is never rewritten.
//   - resolve#Destination tries the product's default location (ProductFacilityLocation) first, then the destinations of
//     the rules that apply, by priority, each under the same checks: open, not where the stock is, a storage location
//     (quarantined stock only in quarantine), a status the stock may take (StatusFlowTransition), the storage type, one
//     owner per location, and the location's (and the rule's) capacity with what is coming to it. It explains each
//     destination it chose or refused; when none fits it names why and the stock stays where it is.
//   - Capacity is measured in the location's capacity unit: the stock unit (no unit, or a count), or a weight or volume
//     through the product's dimensions (ProductUomDimension). Stock it cannot measure is Unmeasured and keeps the location
//     from claiming spare capacity. What is coming to a location is the putaway queue (stock in a receiving or staging
//     location of the facility) of the products whose default location it is.
// Reads need a signed-in user with the facility in their scope; the putaway itself is the guarded
// WarehouseTaskServices.putaway#Stock (STOCK_MOVE), which calls plan and check here.
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const facilityScope = ec.resource.script("component://mr-mantle/service/mantle/facility/FacilityScope.js")
const {find, one, rows, denied, call, ms, dateText} = lib

const RULE = "mantle.facility.PutawayRule",
    LOCATION = "mantle.facility.FacilityLocation",
    ASSET = "mantle.product.asset.Asset"
const ruleFields = [
    "description",
    "fromLocationTypeEnumId",
    "fromLocationSeqId",
    "productId",
    "productCategoryId",
    "storageTypeEnumId",
    "toLocationTypeEnumId",
    "toAreaId",
    "toLocationSeqId",
    "priority",
    "capacity",
    "capacityUomId"
]
// where stock waits to be put away, and the location types that are not storage (a putaway never ends there)
const queueTypes = ["FltReceiving", "FltStaging"]
const notStorageTypes = ["FltReceiving", "FltStaging", "FltQuarantine", "FltMorgue", "FltShipDock"]
const stockTypes = ["AstTpInventory", "AstTpSupplies"]
const countUnits = ["OTH_ea", "OTH_ct"]
const dimensionTypes = {
    UT_WEIGHT_MEASURE: ["Weight", "ShippingWeight"],
    UT_VOLUME_DRY_MEAS: ["Volume", "VolumeLiquid"],
    UT_VOLUME_LIQ_MEAS: ["VolumeLiquid", "Volume"]
}
const candidateLimit = 25
const typeLocationLimit = 50

const blank = value => value == null || String(value).trim() === ""
const text = value => (blank(value) ? null : String(value).trim())
const dec = value => toDecimal(value ?? 0)
const num = value => (value == null ? "0" : dec(value).compare(0) === 0 ? "0" : String(dec(value).toNumber()))
const iso = value => new Date(ms(value)).toISOString()
const yes = value => value === true || value === "true" || value === "Y"
const inEffect = (row, at) => (ms(row.fromDate) ?? -Infinity) <= at && (ms(row.thruDate) ?? Infinity) > at
const closed = (location, now) => location.thruDate != null && ms(location.thruDate) <= now

// ===== scope =====
function readScope() {
    if (!ec.user.userId) denied("PERMISSION_DENIED", "Sign in to read putaway")
    const userScope = facilityScope.scope()
    if (!userScope.systemAdmin && ec.user.hasPermission("PROJECT_CLIENT")) denied("PERMISSION_DENIED", "Putaway is not available")
    return userScope
}
// A facility of the user's; a missing one and another organization's are refused alike.
function facilityOf(userScope, facilityId) {
    const facility = blank(facilityId) ? null : one("mantle.facility.Facility", {facilityId})
    if (!facility || !facilityScope.owns(userScope, facility.ownerPartyId))
        denied("FACILITY_UNAVAILABLE", "Facility " + (facilityId || "") + " is not available")
    return facility
}
function enumText(enumId) {
    return enumId ? one("moqui.basic.Enumeration", {enumId})?.description || enumId : null
}

// ===== capacity =====
// A product quantity in a capacity unit: {amount}, or {unmeasured: why} when the product has no measure in that unit.
function measure(product, quantity, unitId) {
    const amount = dec(quantity)
    const productUnit = product?.amountUomId || null
    if (!unitId || (countUnits.includes(unitId) && (!productUnit || countUnits.includes(productUnit)))) return {amount}
    if (productUnit === unitId) return {amount}
    const unit = one("moqui.basic.Uom", {uomId: unitId})
    const convert = (from, value) => {
        if (from === unitId) return dec(value)
        try {
            const out = call("org.moqui.impl.BasicServices.convert#Uom", {uomId: from, toUomId: unitId, amount: value})
            return out.convertedAmount == null ? null : dec(out.convertedAmount)
        } catch (error) {
            return null
        }
    }
    // the stock unit itself is of the capacity's kind (a product counted in kilograms on a shelf measured in pounds)
    const stockUnit = productUnit ? one("moqui.basic.Uom", {uomId: productUnit}) : null
    if (stockUnit && unit && stockUnit.uomTypeEnumId === unit.uomTypeEnumId) {
        const converted = convert(productUnit, amount)
        if (converted != null) return {amount: converted}
    }
    for (const uomDimensionTypeId of dimensionTypes[unit?.uomTypeEnumId] || []) {
        const dimension = product
            ? Array.from(
                  find("mantle.product.ProductUomDimension", {productId: product.productId, uomDimensionTypeId})
                      .condition("marketSegmentId", "is-null", null)
                      .list()
              ).find(row => row.value != null && row.uomId)
            : null
        if (!dimension) continue
        const each = convert(dimension.uomId, dimension.value)
        if (each != null) return {amount: each.multiply(amount)}
    }
    return {unmeasured: (product?.productName || product?.productId || "Stock") + " has no " + (unit?.description || unitId)}
}
// The open stock on hand at a location by product (assets of a stock type, or of none).
function contentsOf(facilityId, locationSeqId) {
    const totals = new Map()
    const stockType = ec.entity.conditionFactory.makeCondition(
        [
            ec.entity.conditionFactory.makeCondition("assetTypeEnumId", "in", stockTypes),
            ec.entity.conditionFactory.makeCondition("assetTypeEnumId", "is-null", null)
        ],
        "or"
    )
    for (const row of find(ASSET, {facilityId, locationSeqId})
        .condition("quantityOnHandTotal", "greater", 0)
        .condition(stockType)
        .selectField("assetId,productId,ownerPartyId,quantityOnHandTotal")
        .list())
        totals.set(row.productId, (totals.get(row.productId) || dec(0)).add(dec(row.quantityOnHandTotal)))
    return totals
}
// What is coming to a location: the queue's stock (receiving and staging locations of the facility) of the products whose
// default location it is, less the assets being put away now.
function incomingOf(facilityId, locationSeqId, excludeAssetIds) {
    const productIds = Array.from(
        find("mantle.facility.ProductFacilityLocation", {facilityId, locationSeqId}).selectField("productId").list()
    ).map(row => row.productId)
    const totals = new Map()
    if (!productIds.length) return totals
    const queueLocations = Array.from(
        find(LOCATION, {facilityId}).condition("locationTypeEnumId", "in", queueTypes).selectField("locationSeqId").list()
    ).map(row => row.locationSeqId)
    if (!queueLocations.length) return totals
    let query = find(ASSET, {facilityId})
        .condition("productId", "in", productIds)
        .condition("locationSeqId", "in", queueLocations)
        .condition("quantityOnHandTotal", "greater", 0)
    if (excludeAssetIds?.length) query = query.condition("assetId", "not-in", excludeAssetIds)
    for (const row of query.selectField("assetId,productId,quantityOnHandTotal").list())
        totals.set(row.productId, (totals.get(row.productId) || dec(0)).add(dec(row.quantityOnHandTotal)))
    return totals
}
// How full a location is in a capacity unit (the location's, or a rule's limit): capacity, occupied, incoming, remaining,
// and the stock it cannot measure. No capacity is no limit.
function fill(location, capacity, unitId, excludeAssetIds) {
    const answer = {
        locationSeqId: location.locationSeqId,
        limited: capacity != null,
        capacity: capacity == null ? null : num(capacity),
        capacityUomId: unitId || null,
        capacityUnitText: unitId ? one("moqui.basic.Uom", {uomId: unitId})?.abbreviation || unitId : "units",
        occupied: "0",
        incoming: "0",
        remaining: null,
        unmeasured: []
    }
    if (capacity == null) return answer
    const products = new Map()
    const productOf = productId => {
        if (!products.has(productId)) products.set(productId, one("mantle.product.Product", {productId}))
        return products.get(productId)
    }
    let occupied = dec(0),
        incoming = dec(0)
    const add = (totals, onTo) => {
        let total = dec(0)
        for (const [productId, quantity] of totals) {
            const measured = measure(productOf(productId), quantity, unitId)
            if (measured.unmeasured) answer.unmeasured.push(measured.unmeasured)
            else total = total.add(measured.amount)
        }
        return onTo.add(total)
    }
    occupied = add(contentsOf(location.facilityId, location.locationSeqId), occupied)
    incoming = add(incomingOf(location.facilityId, location.locationSeqId, excludeAssetIds), incoming)
    answer.occupied = num(occupied)
    answer.incoming = num(incoming)
    answer.remaining = num(dec(capacity).subtract(occupied).subtract(incoming))
    return answer
}

// ===== the stock being put away =====
// What a resolution is for: the facility, product and quantity (the asset's when given), its owner, status and source.
function stockOf(userScope, p) {
    const asset = blank(p.assetId) ? null : one(ASSET, {assetId: p.assetId})
    if (!blank(p.assetId)) {
        const home = asset?.facilityId ? one("mantle.facility.Facility", {facilityId: asset.facilityId}) : null
        if (!asset || !home || !facilityScope.owns(userScope, home.ownerPartyId))
            denied("RECORD_UNAVAILABLE", "Asset " + p.assetId + " is not available")
    }
    const facility = facilityOf(userScope, asset?.facilityId || p.facilityId)
    const productId = asset?.productId || text(p.productId)
    const product = productId ? one("mantle.product.Product", {productId}) : null
    if (!product) denied("PRODUCT_REQUIRED", "Choose the product to put away")
    const quantity = blank(p.quantity) ? (asset ? dec(asset.quantityOnHandTotal) : null) : dec(p.quantity)
    if (quantity == null || quantity.compare(0) <= 0) denied("QUANTITY_INVALID", "Give a quantity above zero")
    const fromLocationSeqId = asset ? asset.locationSeqId || null : text(p.fromLocationSeqId)
    const from = fromLocationSeqId ? one(LOCATION, {facilityId: facility.facilityId, locationSeqId: fromLocationSeqId}) : null
    if (fromLocationSeqId && !from) denied("LOCATION_UNAVAILABLE", "Location " + fromLocationSeqId + " is not available")
    return {
        facility,
        facilityId: facility.facilityId,
        asset,
        product,
        quantity,
        ownerPartyId: asset?.ownerPartyId || text(p.ownerPartyId) || facility.ownerPartyId,
        statusId: asset?.statusId || text(p.statusId),
        fromLocationSeqId,
        // a receipt (no source yet) arrives at receiving
        fromLocationTypeEnumId: from ? from.locationTypeEnumId || null : text(p.fromLocationTypeEnumId) || "FltReceiving",
        lotId: asset?.lotId || text(p.lotId),
        excludeAssetIds: asset ? [asset.assetId] : [],
        at: blank(p.asOfDate) ? ms(ec.user.nowTimestamp) : ms(p.asOfDate),
        now: ms(ec.user.nowTimestamp)
    }
}
// The product's categories now (for a rule's category).
function categoriesOf(productId) {
    const now = ms(ec.user.nowTimestamp)
    return rows("mantle.product.category.ProductCategoryMember", {productId})
        .filter(row => inEffect(row, now))
        .map(row => row.productCategoryId)
}
// The rules in effect at the stock's date that apply to it, by priority.
function rulesFor(stock) {
    const categories = categoriesOf(stock.product.productId)
    return rows(RULE, {facilityId: stock.facilityId})
        .filter(rule => inEffect(rule, stock.at))
        .filter(
            rule =>
                (!rule.productId || rule.productId === stock.product.productId) &&
                (!rule.productCategoryId || categories.includes(rule.productCategoryId)) &&
                (!rule.storageTypeEnumId || rule.storageTypeEnumId === stock.product.storageTypeEnumId) &&
                (!rule.fromLocationSeqId || rule.fromLocationSeqId === stock.fromLocationSeqId) &&
                (!rule.fromLocationTypeEnumId || rule.fromLocationTypeEnumId === stock.fromLocationTypeEnumId)
        )
        .sort(
            (a, b) =>
                (a.priority ?? 1000) - (b.priority ?? 1000) || String(a.putawayRuleId).localeCompare(String(b.putawayRuleId))
        )
}
// The destinations to try: the product's default locations, then each rule's (its location, or the open locations of its
// type and area in pick sequence), the first of each location kept.
function candidatesOf(stock) {
    const candidates = []
    const seen = new Set()
    const push = candidate => {
        if (seen.has(candidate.locationSeqId) || candidates.length >= candidateLimit) return
        seen.add(candidate.locationSeqId)
        candidates.push(candidate)
    }
    const pickOrder = locationIds =>
        locationIds
            .map(locationSeqId => one(LOCATION, {facilityId: stock.facilityId, locationSeqId}) || {locationSeqId})
            .sort(
                (a, b) =>
                    (a.sequenceNum ?? 1e9) - (b.sequenceNum ?? 1e9) || String(a.locationSeqId).localeCompare(b.locationSeqId)
            )
    const defaults = rows("mantle.facility.ProductFacilityLocation", {
        facilityId: stock.facilityId,
        productId: stock.product.productId
    }).map(row => row.locationSeqId)
    for (const location of pickOrder(defaults)) push({locationSeqId: location.locationSeqId, source: "default", rule: null})
    for (const rule of rulesFor(stock)) {
        if (rule.toLocationSeqId) {
            push({locationSeqId: rule.toLocationSeqId, source: "rule", rule})
            continue
        }
        let query = find(LOCATION, {facilityId: stock.facilityId, locationTypeEnumId: rule.toLocationTypeEnumId})
            .condition("thruDate", "is-null", null)
            .orderBy("sequenceNum,locationSeqId")
            .limit(typeLocationLimit)
        if (rule.toAreaId) query = query.condition("areaId", rule.toAreaId)
        for (const location of query.list()) push({locationSeqId: location.locationSeqId, source: "rule", rule})
    }
    return candidates
}

// ===== the checks of one destination =====
// The status stock has there: the location type's, else a receiving hold released (putaway into storage), else its own.
function statusThere(stock, location) {
    const type = location.locationTypeEnumId
        ? one("mantle.facility.FacilityLocationType", {
              facilityId: stock.facilityId,
              locationTypeEnumId: location.locationTypeEnumId
          })
        : null
    if (type?.autoStatusId) return type.autoStatusId
    if (stock.statusId === "AstOnHold" && !notStorageTypes.includes(location.locationTypeEnumId)) return "AstAvailable"
    return stock.statusId || null
}
const refused = (reasonCode, explanation, extra = {}) => Object.assign({ok: false, reasonCode, explanation}, extra)
// Whether stock may go to a location: {ok, reasonCode, explanation, statusAfter, fill}.
function check(stock, candidate) {
    const id = candidate.locationSeqId
    const location = one(LOCATION, {facilityId: stock.facilityId, locationSeqId: id})
    if (!location) return refused("LOCATION_UNAVAILABLE", "Location " + id + " does not exist")
    if (closed(location, stock.now)) return refused("LOCATION_CLOSED", "Location " + id + " is closed")
    if (stock.facility.closedDate != null && ms(stock.facility.closedDate) <= stock.now)
        return refused("FACILITY_CLOSED", "Facility " + stock.facilityId + " is closed")
    if (id === stock.fromLocationSeqId) return refused("SAME_LOCATION", "The stock is already at " + id)
    const typeText = enumText(location.locationTypeEnumId) || "untyped"
    if (stock.statusId === "AstQuarantine") {
        if (location.locationTypeEnumId !== "FltQuarantine")
            return refused("QUARANTINE_ONLY", "Quarantined stock moves only within quarantine; " + id + " is " + typeText)
    } else if (notStorageTypes.includes(location.locationTypeEnumId)) {
        return refused("NOT_STORAGE", id + " is a " + typeText.toLowerCase() + " location, not storage")
    }
    const statusAfter = statusThere(stock, location)
    if (stock.statusId && statusAfter !== stock.statusId) {
        const flows = find("moqui.basic.StatusFlowTransition", {statusId: stock.statusId, toStatusId: statusAfter}).count()
        if (!flows)
            return refused(
                "STATUS_FLOW",
                "Stock that is " + enumStatus(stock.statusId) + " cannot become " + enumStatus(statusAfter) + " at " + id
            )
    }
    const productType = stock.product.storageTypeEnumId || null
    if ((location.storageTypeEnumId || null) !== productType)
        return refused(
            "STORAGE_TYPE",
            location.storageTypeEnumId
                ? id + " stores " + enumText(location.storageTypeEnumId) + " products only"
                : stock.product.productName + " needs " + enumText(productType) + " storage; " + id + " has none"
        )
    const otherOwner = find(ASSET, {facilityId: stock.facilityId, locationSeqId: id})
        .condition("quantityOnHandTotal", "greater", 0)
        .condition("ownerPartyId", "not-equals", stock.ownerPartyId)
        .count()
    if (otherOwner) return refused("OTHER_OWNER", id + " holds another owner's stock")
    const limits = [{label: "Location", capacity: location.capacity, unitId: location.capacityUomId, code: "CAPACITY_EXCEEDED"}]
    if (candidate.rule?.capacity != null)
        limits.push({
            label: "Rule " + candidate.rule.putawayRuleId,
            capacity: candidate.rule.capacity,
            unitId: candidate.rule.capacityUomId,
            code: "RULE_CAPACITY"
        })
    let locationFill = null
    for (const limit of limits) {
        const filled = fill(location, limit.capacity, limit.unitId, stock.excludeAssetIds)
        if (!locationFill) locationFill = filled
        if (!filled.limited) continue
        if (filled.unmeasured.length)
            return refused(
                "CAPACITY_UNMEASURED",
                limit.label + " " + id + " cannot claim spare capacity: " + filled.unmeasured.join("; "),
                {fill: filled}
            )
        const wanted = measure(stock.product, stock.quantity, limit.unitId)
        if (wanted.unmeasured)
            return refused("CAPACITY_UNMEASURED", wanted.unmeasured + ", so it cannot be measured against " + id, {
                fill: filled
            })
        if (dec(filled.remaining).compare(wanted.amount) < 0)
            return refused(
                limit.code,
                `${limit.label} ${id} holds ${filled.occupied} of ${filled.capacity} ${filled.capacityUnitText}` +
                    ` with ${filled.incoming} coming; ${num(wanted.amount)} more do not fit (${filled.remaining} left)`,
                {fill: filled}
            )
    }
    return {
        ok: true,
        reasonCode: null,
        explanation:
            (candidate.source === "default" ? "The product's default location" : "Rule " + candidate.rule.putawayRuleId) +
            (locationFill?.limited ? `; ${locationFill.remaining} ${locationFill.capacityUnitText} free` : "; no capacity limit"),
        statusAfter,
        fill: locationFill
    }
}
function enumStatus(statusId) {
    return statusId ? one("moqui.basic.StatusItem", {statusId})?.description || statusId : "none"
}
function candidateRow(stock, candidate, checked, chosen) {
    const location = one(LOCATION, {facilityId: stock.facilityId, locationSeqId: candidate.locationSeqId})
    return {
        locationSeqId: candidate.locationSeqId,
        locationText: location?.description ? candidate.locationSeqId + " " + location.description : candidate.locationSeqId,
        locationTypeEnumId: location?.locationTypeEnumId || null,
        sequenceNum: location?.sequenceNum ?? null,
        source: candidate.source,
        sourceText: candidate.source === "default" ? "Default location" : "Rule " + candidate.rule.putawayRuleId,
        putawayRuleId: candidate.rule?.putawayRuleId || null,
        chosen,
        ok: checked.ok,
        reasonCode: checked.reasonCode,
        explanation: checked.explanation,
        statusAfter: checked.statusAfter || null,
        capacity: checked.fill?.capacity ?? null,
        occupied: checked.fill?.limited ? checked.fill.occupied : null,
        incoming: checked.fill?.limited ? checked.fill.incoming : null,
        remaining: checked.fill?.remaining ?? null,
        capacityUnitText: checked.fill?.limited ? checked.fill.capacityUnitText : null
    }
}
// The destination of the stock with each candidate explained.
function resolveStock(stock) {
    const candidates = candidatesOf(stock)
    let chosen = null
    const candidateRows = candidates.map(candidate => {
        const checked = check(stock, candidate)
        const pick = checked.ok && !chosen
        const row = candidateRow(stock, candidate, checked, pick)
        if (pick) chosen = row
        return row
    })
    const productName = stock.product.productName || stock.product.productId
    let reasonText = null
    if (!chosen)
        reasonText = candidateRows.length
            ? "No location fits " +
              productName +
              ": " +
              candidateRows.map(row => row.locationSeqId + " " + row.explanation.replace(/^Location \S+ /, "")).join("; ")
            : "No default location or putaway rule applies to " + productName + " here"
    return {
        facilityId: stock.facilityId,
        productId: stock.product.productId,
        quantity: num(stock.quantity),
        fromLocationSeqId: stock.fromLocationSeqId,
        statusId: stock.statusId,
        locationSeqId: chosen?.locationSeqId || null,
        source: chosen?.source || null,
        putawayRuleId: chosen?.putawayRuleId || null,
        statusAfter: chosen?.statusAfter || null,
        explanation: chosen ? chosen.locationSeqId + ": " + chosen.explanation : null,
        reasonCode: chosen ? null : "NO_DESTINATION",
        reasonText,
        candidates: candidateRows
    }
}
// resolve#Destination.
function resolve(p) {
    return resolveStock(stockOf(readScope(), p))
}
// The step-1 receipt destination (Receiving.js): the resolver's location for incoming stock, or none with its reason.
function forReceipt(userScope, facilityId, productId, quantity, ownerPartyId) {
    if (quantity == null || dec(quantity).compare(0) <= 0) return {locationSeqId: null, reasonText: null}
    return resolveStock(
        stockOf(userScope, {facilityId, productId, quantity, ownerPartyId, fromLocationTypeEnumId: "FltReceiving"})
    )
}

// ===== putaway#Stock's plan and its check under the lock =====
// The suggestion for the locked asset, and the destination it goes to: the one asked for (a reason is needed when it is not
// the suggestion; it passes the same checks) or the suggestion (NO_DESTINATION when there is none, the stock stays).
function plan(userScope, asset, quantity, toLocationSeqId, reason) {
    const stock = stockOf(userScope, {assetId: asset.assetId, quantity})
    const resolved = resolveStock(stock)
    const wanted = text(toLocationSeqId)
    if (!wanted) {
        if (!resolved.locationSeqId) denied("NO_DESTINATION", resolved.reasonText + "; the stock stays where it is")
        return {stock, resolved, locationSeqId: resolved.locationSeqId, suggested: true}
    }
    if (wanted !== resolved.locationSeqId && blank(reason))
        denied(
            "REASON_REQUIRED",
            "Give a reason for putting it at " +
                wanted +
                (resolved.locationSeqId ? " rather than " + resolved.locationSeqId : " (no location was suggested)")
        )
    return {stock, resolved, locationSeqId: wanted, suggested: wanted === resolved.locationSeqId}
}
// The destination checked again once it is locked (check#FacilityLocationOpen): a concurrent putaway into it has finished.
function recheck(planned) {
    const candidate = planned.resolved.candidates.find(row => row.locationSeqId === planned.locationSeqId)
    const rule = candidate?.putawayRuleId ? one(RULE, {putawayRuleId: candidate.putawayRuleId}) : null
    const checked = check(planned.stock, {locationSeqId: planned.locationSeqId, source: rule ? "rule" : "default", rule})
    if (!checked.ok) denied(checked.reasonCode, checked.explanation)
    return checked
}

// ===== get#Capacity =====
function capacity(p) {
    const userScope = readScope()
    const facility = facilityOf(userScope, p.facilityId)
    const ids = Array.from(p.locationSeqIds || []).filter(Boolean)
    let query = find(LOCATION, {facilityId: facility.facilityId}).condition("thruDate", "is-null", null)
    query = ids.length ? query.condition("locationSeqId", "in", ids) : query.condition("capacity", "is-not-null", null)
    const locations = Array.from(query.orderBy("sequenceNum,locationSeqId").limit(200).list())
    const product = blank(p.productId) ? null : one("mantle.product.Product", {productId: p.productId})
    if (!blank(p.productId) && !product) denied("PRODUCT_REQUIRED", "Product " + p.productId + " is not available")
    const excludeAssetIds = Array.from(p.excludeAssetIds || []).filter(Boolean)
    return {
        facilityId: facility.facilityId,
        capacityRows: locations.map(location => {
            const filled = fill(location, location.capacity, location.capacityUomId, excludeAssetIds)
            const row = Object.assign(filled, {
                description: location.description || null,
                locationTypeEnumId: location.locationTypeEnumId || null,
                measured: !filled.unmeasured.length
            })
            if (product && !blank(p.quantity) && filled.limited) {
                const wanted = measure(product, p.quantity, location.capacityUomId)
                row.fits = !wanted.unmeasured && row.measured && dec(filled.remaining).compare(wanted.amount) >= 0
            }
            return row
        })
    }
}

// ===== the rules =====
function checkEnum(value, enumTypeId, label) {
    if (value && one("moqui.basic.Enumeration", {enumId: value})?.enumTypeId !== enumTypeId)
        denied("RULE_INVALID", "Choose a valid " + label)
}
// The values a rule row will hold, checked against its facility.
function validate(data, facility) {
    const facilityId = facility.facilityId
    checkEnum(data.fromLocationTypeEnumId, "FacilityLocationType", "source location type")
    checkEnum(data.toLocationTypeEnumId, "FacilityLocationType", "destination location type")
    checkEnum(data.storageTypeEnumId, "StorageType", "storage type")
    if (!data.toLocationSeqId && !data.toLocationTypeEnumId)
        denied("RULE_INVALID", "Choose the destination: a location, or a location type")
    if (data.toLocationSeqId) {
        const to = one(LOCATION, {facilityId, locationSeqId: data.toLocationSeqId})
        if (!to) denied("RULE_INVALID", "Location " + data.toLocationSeqId + " is not in facility " + facilityId)
        if (closed(to, ms(ec.user.nowTimestamp))) denied("LOCATION_CLOSED", "Location " + data.toLocationSeqId + " is closed")
        data.toLocationTypeEnumId = null
        data.toAreaId = null
    }
    if (data.fromLocationSeqId && !one(LOCATION, {facilityId, locationSeqId: data.fromLocationSeqId}))
        denied("RULE_INVALID", "Location " + data.fromLocationSeqId + " is not in facility " + facilityId)
    if (data.productId) {
        const product = one("mantle.product.Product", {productId: data.productId})
        if (
            !product ||
            (product.ownerPartyId && product.ownerPartyId !== "_NA_" && product.ownerPartyId !== facility.ownerPartyId)
        )
            denied("RULE_INVALID", "Product " + data.productId + " is not available")
    }
    if (data.productCategoryId && !one("mantle.product.category.ProductCategory", {productCategoryId: data.productCategoryId}))
        denied("RULE_INVALID", "Category " + data.productCategoryId + " is not available")
    if (data.priority != null && (!Number.isInteger(data.priority) || data.priority < 0 || data.priority > 9999))
        denied("RULE_INVALID", "The priority is a whole number from 0 to 9999")
    if (data.capacity != null && data.capacity.compare(0) < 0) denied("RULE_INVALID", "Capacity cannot be negative")
    if (data.capacityUomId && !one("moqui.basic.Uom", {uomId: data.capacityUomId}))
        denied("RULE_INVALID", "Choose a valid capacity unit")
    return data
}
function valuesOf(p, before) {
    const data = Object.assign({}, before ? lib.pick(lib.map(before), ruleFields) : {})
    for (const field of ruleFields) {
        if (p[field] == null) continue
        if (field === "priority") data.priority = blank(p.priority) ? null : Number(String(p.priority))
        else if (field === "capacity") {
            let value = null
            try {
                value = blank(p.capacity) ? null : toDecimal(String(p.capacity))
            } catch (error) {
                denied("RULE_INVALID", "Capacity is a number")
            }
            data.capacity = value
        } else data[field] = text(p[field])
    }
    return data
}
// store#PutawayRule: a rule added, or one changed (putawayRuleId: it ends where the next starts) or ended (endNow).
function store(p) {
    if (!ec.user.userId) denied("PERMISSION_DENIED", "Sign in to change putaway rules")
    if (!lib.access.has("FACILITY_EDIT")) denied("PERMISSION_DENIED", "Facility edit authority is required")
    const userScope = facilityScope.scope()
    const why = String(p.changeReason || "").trim()
    const before = blank(p.putawayRuleId) ? null : one(RULE, {putawayRuleId: p.putawayRuleId})
    if (!blank(p.putawayRuleId) && !before) denied("RECORD_UNAVAILABLE", "Putaway rule " + p.putawayRuleId + " is not available")
    const facility = (() => {
        const row = one("mantle.facility.Facility", {facilityId: before?.facilityId || p.facilityId || "_NA_"})
        if (!row || !facilityScope.owns(userScope, row.ownerPartyId))
            denied(before ? "RECORD_UNAVAILABLE" : "FACILITY_UNAVAILABLE", "The facility is not available")
        return row
    })()
    if (!why) denied("REASON_REQUIRED", "Give a reason for the rule change")
    // one change of a facility's rules at a time
    find("mantle.facility.Facility", {facilityId: facility.facilityId}).forUpdate(true).one()
    const now = ms(ec.user.nowTimestamp)
    const auditFields = [...ruleFields, "organizationPartyId", "facilityId", "fromDate", "thruDate", "changeReason"]
    ec.context.putAll(Object.fromEntries(auditFields.map(field => [field + "_changeReason", why])))
    if (before) {
        const locked = find(RULE, {putawayRuleId: before.putawayRuleId}).forUpdate(true).one()
        if (locked.thruDate != null && ms(locked.thruDate) <= now) denied("RULE_ENDED", "This rule has ended")
        if (!blank(p.expectedLastUpdatedStamp) && ms(p.expectedLastUpdatedStamp) !== ms(locked.lastUpdatedStamp))
            denied("RULE_CHANGED", "The rule changed; reload before saving")
    }
    if (before && yes(p.endNow)) {
        call("update#" + RULE, {
            putawayRuleId: before.putawayRuleId,
            thruDate: iso(Math.max(now, ms(before.fromDate))),
            changeReason: why
        })
        return {putawayRuleId: before.putawayRuleId, rule: view(one(RULE, {putawayRuleId: before.putawayRuleId}), now)}
    }
    const at = blank(p.fromDate) ? now : ms(p.fromDate)
    if (!Number.isFinite(at) || at < now - 60000) denied("RULE_INVALID", "Rule changes take effect now or later")
    if (before && at <= ms(before.fromDate)) denied("RULE_INVALID", "A change starts after the rule it replaces")
    const data = validate(valuesOf(p, before), facility)
    if (before) call("update#" + RULE, {putawayRuleId: before.putawayRuleId, thruDate: iso(at), changeReason: why})
    const created = call(
        "create#" + RULE,
        Object.assign({}, data, {
            organizationPartyId: facility.ownerPartyId,
            facilityId: facility.facilityId,
            fromDate: iso(at),
            thruDate: before?.thruDate && ms(before.thruDate) > at ? before.thruDate : null,
            previousPutawayRuleId: before?.putawayRuleId || null,
            changeReason: why
        })
    )
    return {putawayRuleId: created.putawayRuleId, rule: view(one(RULE, {putawayRuleId: created.putawayRuleId}), now)}
}
// A rule for a screen, with its names.
function view(row, now) {
    const productName = row.productId ? one("mantle.product.Product", {productId: row.productId})?.productName : null
    const categoryName = row.productCategoryId
        ? one("mantle.product.category.ProductCategory", {productCategoryId: row.productCategoryId})?.categoryName
        : null
    const appliesText =
        [
            row.productId ? productName || row.productId : null,
            row.productCategoryId ? "category " + (categoryName || row.productCategoryId) : null,
            row.storageTypeEnumId ? enumText(row.storageTypeEnumId) + " storage" : null
        ]
            .filter(Boolean)
            .join(", ") || "Any product"
    const fromText =
        [
            row.fromLocationTypeEnumId ? enumText(row.fromLocationTypeEnumId) : null,
            row.fromLocationSeqId ? "location " + row.fromLocationSeqId : null
        ]
            .filter(Boolean)
            .join(", ") || "Anywhere"
    const toText = row.toLocationSeqId
        ? "Location " + row.toLocationSeqId
        : enumText(row.toLocationTypeEnumId) + " locations" + (row.toAreaId ? " in area " + row.toAreaId : "")
    const unit = row.capacityUomId ? one("moqui.basic.Uom", {uomId: row.capacityUomId})?.abbreviation || row.capacityUomId : null
    return Object.assign(lib.map(row), {
        appliesText,
        fromText,
        toText,
        capacityText: row.capacity == null ? "" : num(row.capacity) + " " + (unit || "units"),
        fromDateText: dateText(row.fromDate),
        thruDateText: dateText(row.thruDate),
        current: inEffect(row, now),
        future: ms(row.fromDate) > now
    })
}
// find#PutawayRules: a facility's rules in effect and to come (every row with includeHistory), by priority.
function list(p) {
    const userScope = readScope()
    const facility = facilityOf(userScope, p.facilityId)
    const now = ms(ec.user.nowTimestamp)
    const all = rows(RULE, {facilityId: facility.facilityId}).filter(
        row => yes(p.includeHistory) || row.thruDate == null || ms(row.thruDate) > now
    )
    all.sort(
        (a, b) =>
            (a.priority ?? 1000) - (b.priority ?? 1000) ||
            ms(a.fromDate) - ms(b.fromDate) ||
            String(a.putawayRuleId).localeCompare(String(b.putawayRuleId))
    )
    return {
        facilityId: facility.facilityId,
        canEdit: lib.access.has("FACILITY_EDIT"),
        rules: all.map(row => view(row, now))
    }
}

const operations = {store, list, resolve, capacity}
;({
    execute(op, parameters) {
        if (!operations[op]) throw new Error("Unknown putaway operation " + op)
        return operations[op](parameters)
    },
    forReceipt,
    plan,
    recheck,
    queueTypes,
    notStorageTypes
})
