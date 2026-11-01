// Stock at a date (impl-warehouse P17, WH-REPORT; design-crosscut §3.26): the stock ledger (AssetDetail) read by effective
// date, by product, facility, location, lot and owner, from an opening day through a cut-off day (calendar days in the
// user's zone). An asset's facility, location, lot and owner at a time are read from its audit log (the value an update
// replaced after that time, else the current one), so a whole asset moved, relabelled or reassigned shows as a move out of
// its old row and into its new one; a revaluation split's pair of rows (F34, told from a partial move by its book event,
// F121) and a partial move within one row read as one history row. History from before a facility's first ledger row is
// incomplete: its quantities are unknown (null), never zero. Read only in the user's organizations (StockScope), narrowed to
// the caller's facilities; no cost.
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const stock = ec.resource.script("component://mr-mantle/service/mantle/product/StockScope.js")
const traceability = ec.resource.script("component://mr-mantle/service/mantle/product/Traceability.js")
const {find, denied, ms, dateText} = lib

const ASSET = "mantle.product.asset.Asset"
const DETAIL = "mantle.product.asset.AssetDetail"
const DETAIL_VIEW = "mantle.product.asset.AssetAndDetail"
const AUDIT = "moqui.entity.EntityAuditLog"
const STOCK_TYPES = ["AstTpInventory", "AstTpSupplies"]
// the fields of a stock row that an asset can change over time (audit-logged on Asset)
const PLACE_FIELDS = ["facilityId", "locationSeqId", "lotId", "ownerPartyId"]
const assetLimit = 2000
const historyLimit = 5000
const noLimitCap = 5000
const chunkSize = 500
const facilityStartLimit = 100
const DAY = 86400000
// a product's stock unit; one with none counts in each, as Mantle's stock factor does (OrderServices.get#OrderItemStockFactor),
// so its totals are each's and not a unit of their own
const EACH = "OTH_ea"
const stockUnit = product => product?.amountUomId || EACH

const dayAfter = day => lib.calendarDateText(Date.parse(day) + DAY)
const midnight = day => ec.l10n.parseTimestamp(day, "yyyy-MM-dd")
const today = () => ec.l10n.format(ec.user.nowTimestamp, "yyyy-MM-dd")
const zero = () => toDecimal(0)
const number = value => (value == null ? null : Number(String(value)))
const unique = values => [...new Set(values.filter(value => value != null && value !== ""))]
function chunks(values) {
    const out = []
    for (let index = 0; index < values.length; index += chunkSize) out.push(values.slice(index, index + chunkSize))
    return out
}
function rowsIn(entity, field, values, build = query => query) {
    const out = []
    for (const part of chunks(unique(values))) out.push(...Array.from(build(find(entity).condition(field, "in", part)).list()))
    return out
}
function names(entity, field, nameField, values) {
    return new Map(rowsIn(entity, field, values).map(row => [row[field], row[nameField] || row[field]]))
}

// The days of the report: the cut-off (its end, the start of the next day in the user's zone) and the opening day (the
// first of the cut-off's month by default).
function days(p) {
    const asOfDay = p.asOfDate ? lib.calendarDateText(p.asOfDate) : today()
    if (asOfDay > today()) denied("DATE_FUTURE", "Choose today or an earlier day")
    const fromDay = p.fromDate ? lib.calendarDateText(p.fromDate) : asOfDay.slice(0, 8) + "01"
    if (fromDay > asOfDay) denied("DATE_RANGE", "The first day must be on or before the cut-off day")
    return {asOfDay, fromDay, from: ms(midnight(fromDay)), cutoff: ms(midnight(dayAfter(asOfDay)))}
}

// The facilities a row may be in: the organizations' (null for every one) narrowed to the caller's.
function allowedFacilities(userScope, p) {
    const orgFacilityIds = stock.facilityIds(userScope)
    const callerIds = p.facilityIds == null ? null : Array.from(p.facilityIds)
    if (orgFacilityIds == null) return callerIds
    if (callerIds == null) return orgFacilityIds
    const callerSet = new Set(callerIds)
    return orgFacilityIds.filter(id => callerSet.has(id))
}

// The assets that may hold stock of a row the filters choose: those whose place matches now or matched before (an audit
// row replaced the value), holding stock now or with a ledger row since the opening day, in the allowed facilities.
function candidateIds(p, facilityIds, from) {
    const factory = ec.entity.conditionFactory
    const conditions = [factory.makeCondition("assetTypeEnumId", "in", STOCK_TYPES)]
    if (p.productId) conditions.push(factory.makeCondition("productId", "equals", p.productId))
    for (const field of PLACE_FIELDS) {
        if (!p[field]) continue
        const earlier = Array.from(
            find(AUDIT, {changedEntityName: ASSET, changedFieldName: field, oldValueText: p[field]})
                .selectField("pkPrimaryValue")
                .distinct(true)
                .limit(assetLimit + 1)
                .list()
        ).map(row => row.pkPrimaryValue)
        const current = factory.makeCondition(field, "equals", p[field])
        conditions.push(
            earlier.length ? factory.makeCondition([current, factory.makeCondition("assetId", "in", earlier)], "or") : current
        )
    }
    if (facilityIds != null)
        conditions.push(factory.makeCondition("facilityId", "in", facilityIds.length ? facilityIds : ["_NA_"]))
    const holding = Array.from(
        find(ASSET)
            .condition(factory.makeCondition(conditions, "and"))
            .condition("quantityOnHandTotal", "not-equals", 0)
            .selectField("assetId")
            .orderBy("assetId")
            .limit(assetLimit + 1)
            .list()
    ).map(row => row.assetId)
    const moved = Array.from(
        find(DETAIL_VIEW)
            .condition(factory.makeCondition(conditions, "and"))
            .condition("effectiveDate", "greater-equals", new Date(from))
            .selectField("assetId")
            .distinct(true)
            .orderBy("assetId")
            .limit(assetLimit + 1)
            .list()
    ).map(row => row.assetId)
    const ids = unique(holding.concat(moved)).sort()
    return {ids: ids.slice(0, assetLimit), truncated: ids.length > assetLimit}
}

// The place of an asset just before a time: the value the first later audit row replaced, else the current value.
function placeBefore(asset, changes, at) {
    const place = {productId: asset.productId}
    for (const field of PLACE_FIELDS) {
        const later = changes.find(change => change.field === field && change.at >= at)
        place[field] = later ? later.oldValue : asset[field] || null
    }
    return place
}
const keyOf = place => [place.productId, place.facilityId, place.locationSeqId, place.lotId, place.ownerPartyId].join("|")

function kindOf(row, revaluations) {
    if (row.assetReceiptId) return "receipt"
    if (row.assetIssuanceId) return "issue"
    if (row.otherAssetId) {
        const incoming = toDecimal(row.quantityOnHandDiff ?? 0).compare(0) > 0
        const pair = incoming ? row.otherAssetId + ">" + row.assetId : row.assetId + ">" + row.otherAssetId
        return revaluations.has(pair) ? "revaluation" : "move"
    }
    // counts, scrap, variances and other ledger entries
    return "adjustment"
}
const kindTexts = {
    receipt: "Receipt",
    issue: "Issue",
    adjustment: "Adjustment",
    move: "Move",
    revaluation: "Revaluation split"
}
function documentOf(row) {
    for (const [field, kind, text] of [
        ["shipmentId", "shipment", "Shipment "],
        ["returnId", "return", "Return "],
        ["workEffortId", "workEffort", "Work effort "],
        ["orderId", "order", "Order "],
        ["physicalInventoryId", "count", "Count "]
    ])
        if (row[field]) return {documentType: kind, documentId: row[field], documentText: text + row[field]}
    return {documentType: null, documentId: null, documentText: ""}
}

// The first ledger row's time in each facility (by the asset's current facility), and over all the allowed facilities.
function historyStarts(facilityIds, allowedIds) {
    const first = condition => {
        let query = find(DETAIL_VIEW).condition("assetTypeEnumId", "in", STOCK_TYPES)
        if (condition) query = query.condition(condition)
        const row = Array.from(query.selectField("effectiveDate").orderBy("effectiveDate").limit(1).list())[0]
        return row?.effectiveDate ? ms(row.effectiveDate) : null
    }
    const factory = ec.entity.conditionFactory
    const starts = new Map()
    for (const facilityId of facilityIds.slice(0, facilityStartLimit))
        starts.set(facilityId, first(factory.makeCondition("facilityId", "equals", facilityId)))
    const overall =
        allowedIds == null ? first(null) : allowedIds.length ? first(factory.makeCondition("facilityId", "in", allowedIds)) : null
    return {starts, overall}
}

function inventoryAtDate(p) {
    const userScope = stock.scope()
    const {asOfDay, fromDay, from, cutoff} = days(p)
    const facilityIds = allowedFacilities(userScope, p)
    if (p.facilityId && facilityIds != null && !facilityIds.includes(p.facilityId))
        denied("FACILITY_UNAVAILABLE", "Facility " + p.facilityId + " is not available")
    const allowedSet = facilityIds == null ? null : new Set(facilityIds)
    const matches = place =>
        (!p.productId || place.productId === p.productId) &&
        PLACE_FIELDS.every(field => !p[field] || place[field] === p[field]) &&
        (allowedSet == null || allowedSet.has(place.facilityId))

    const candidates = candidateIds(p, facilityIds, from)
    const cutoffStamp = new Date(cutoff)
    const assets = rowsIn(ASSET, "assetId", candidates.ids)
    const details = new Map()
    for (const row of rowsIn(DETAIL, "assetId", candidates.ids, query =>
        query.condition("effectiveDate", "less", cutoffStamp).orderBy("effectiveDate").orderBy("assetDetailId")
    )) {
        if (!details.has(row.assetId)) details.set(row.assetId, [])
        details.get(row.assetId).push(row)
    }
    const changes = new Map()
    for (const row of rowsIn(AUDIT, "pkPrimaryValue", candidates.ids, query =>
        query
            .condition("changedEntityName", ASSET)
            .condition("changedFieldName", "in", PLACE_FIELDS)
            .orderBy("changedDate")
            .orderBy("auditHistorySeqId")
    )) {
        if (!changes.has(row.pkPrimaryValue)) changes.set(row.pkPrimaryValue, [])
        changes.get(row.pkPrimaryValue).push({
            field: row.changedFieldName,
            at: ms(row.changedDate),
            oldValue: row.oldValueText || null
        })
    }
    const revaluations = traceability.revaluationPairs(
        Array.from(details.values()).flatMap(list => list.flatMap(row => [row.assetId, row.otherAssetId]))
    )

    // the rows of the report by place, and the history in the window
    const groups = new Map()
    const group = place => {
        const key = keyOf(place)
        if (!groups.has(key))
            groups.set(key, {
                key,
                place,
                opening: zero(),
                receipt: zero(),
                issue: zero(),
                adjustment: zero(),
                move: zero(),
                closing: zero()
            })
        return groups.get(key)
    }
    const history = []
    for (const asset of assets) {
        const rows = details.get(asset.assetId) || []
        const assetChanges = changes.get(asset.assetId) || []
        if (!rows.length) continue
        const events = []
        let opening = zero()
        let closing = zero()
        for (const row of rows) {
            const at = ms(row.effectiveDate)
            const diff = toDecimal(row.quantityOnHandDiff ?? 0)
            closing = closing.add(diff)
            if (at < from) opening = opening.add(diff)
            else events.push({at, row, diff})
        }
        // a change of place in the window moves what the asset held then (its rows up to that time)
        for (const at of unique(assetChanges.map(change => change.at).filter(at => at >= from && at < cutoff)))
            events.push({at, change: true})
        events.sort((a, b) => a.at - b.at || (a.change ? 1 : 0) - (b.change ? 1 : 0))
        const openingPlace = placeBefore(asset, assetChanges, from)
        if (!opening.isZero() && matches(openingPlace)) group(openingPlace).opening = group(openingPlace).opening.add(opening)
        let balance = opening
        for (const event of events) {
            if (event.change) {
                const before = placeBefore(asset, assetChanges, event.at)
                const after = placeBefore(asset, assetChanges, event.at + 1)
                if (balance.isZero() || keyOf(before) === keyOf(after)) continue
                for (const [place, quantity, other] of [
                    [before, balance.negate(), after],
                    [after, balance, before]
                ]) {
                    if (!matches(place)) continue
                    group(place).move = group(place).move.add(quantity)
                    history.push({
                        at: event.at,
                        assetId: asset.assetId,
                        kind: "move",
                        quantity,
                        place,
                        text: (quantity.compare(0) < 0 ? "Moved to " : "Moved from ") + placeText(other),
                        sequence: "~" + event.at
                    })
                }
                continue
            }
            const {row, diff} = event
            balance = balance.add(diff)
            const place = placeBefore(asset, assetChanges, event.at)
            if (!matches(place)) continue
            const kind = kindOf(row, revaluations)
            const target = group(place)
            if (kind === "receipt") target.receipt = target.receipt.add(diff)
            else if (kind === "issue") target.issue = target.issue.subtract(diff)
            else if (kind === "adjustment") target.adjustment = target.adjustment.add(diff)
            else target.move = target.move.add(diff)
            history.push(
                Object.assign(
                    {
                        at: event.at,
                        assetId: asset.assetId,
                        assetDetailId: row.assetDetailId,
                        otherAssetId: row.otherAssetId || null,
                        kind,
                        quantity: diff,
                        place,
                        recordedDate: row.lastUpdatedStamp || null,
                        reasonEnumId: row.varianceReasonEnumId || null,
                        text: row.description || "",
                        sequence: row.assetDetailId
                    },
                    documentOf(row)
                )
            )
        }
        const closingPlace = placeBefore(asset, assetChanges, cutoff)
        if (!closing.isZero() && matches(closingPlace)) group(closingPlace).closing = group(closingPlace).closing.add(closing)
    }
    const merged = mergePairs(history)

    // names, units and the start of each facility's history
    const places = Array.from(groups.values()).map(entry => entry.place)
    const products = new Map(
        rowsIn(
            "mantle.product.Product",
            "productId",
            places.map(place => place.productId)
        ).map(row => [row.productId, row])
    )
    const facilityNames = names(
        "mantle.facility.Facility",
        "facilityId",
        "facilityName",
        places.map(place => place.facilityId)
    )
    const lotNumbers = names(
        "mantle.product.asset.Lot",
        "lotId",
        "lotNumber",
        places.map(place => place.lotId)
    )
    const owners = lib.partyNames(places.map(place => place.ownerPartyId))
    const units = names("moqui.basic.Uom", "uomId", "description", Array.from(products.values()).map(stockUnit).concat([EACH]))
    const reasons = names(
        "moqui.basic.Enumeration",
        "enumId",
        "description",
        merged.map(row => row.reasonEnumId)
    )
    const facilityList = unique(places.map(place => place.facilityId).concat(p.facilityId ? [p.facilityId] : []))
    const {starts, overall} = historyStarts(facilityList, p.facilityId ? [p.facilityId] : facilityIds)
    const startOf = facilityId => (starts.has(facilityId) ? starts.get(facilityId) : overall)
    const describe = place => {
        const product = products.get(place.productId)
        return {
            productId: place.productId,
            productName: product?.productName || place.productId || "",
            facilityId: place.facilityId,
            facilityName: facilityNames.get(place.facilityId) || place.facilityId || "",
            locationSeqId: place.locationSeqId,
            lotId: place.lotId,
            lotNumber: lotNumbers.get(place.lotId) || place.lotId || "",
            ownerPartyId: place.ownerPartyId,
            ownerName: owners[place.ownerPartyId] || place.ownerPartyId || "",
            quantityUomId: stockUnit(product),
            unitText: units.get(stockUnit(product)) || stockUnit(product)
        }
    }
    function placeText(place) {
        return [place.facilityId, place.locationSeqId, place.lotId ? "lot " + place.lotId : null, place.ownerPartyId]
            .filter(Boolean)
            .join(" · ")
    }

    const stockRows = []
    for (const entry of groups.values()) {
        const values = [entry.opening, entry.receipt, entry.issue, entry.adjustment, entry.move, entry.closing]
        if (values.every(value => value.isZero())) continue
        const start = startOf(entry.place.facilityId)
        const openingKnown = start == null || from >= start
        const closingKnown = start == null || cutoff > start
        stockRows.push(
            Object.assign(describe(entry.place), {
                key: entry.key,
                openingQuantity: openingKnown ? number(entry.opening) : null,
                receiptQuantity: number(entry.receipt),
                issueQuantity: number(entry.issue),
                adjustmentQuantity: number(entry.adjustment),
                moveQuantity: number(entry.move),
                closingQuantity: closingKnown ? number(entry.closing) : null,
                complete: openingKnown && closingKnown,
                historyStartText: start == null ? "" : dateText(new Date(start))
            })
        )
    }
    const sortText = row => [row.productName, row.facilityName, row.locationSeqId || "", row.lotNumber, row.ownerName]
    stockRows.sort((a, b) => {
        const left = sortText(a),
            right = sortText(b)
        for (let index = 0; index < left.length; index++) {
            const order = String(left[index]).localeCompare(String(right[index]))
            if (order) return order
        }
        return 0
    })
    const rowsByKey = new Map(stockRows.map(row => [row.key, row]))

    // the history, oldest first, each row with its place's balance after it (unknown when its opening is)
    merged.sort((a, b) => a.at - b.at || String(a.sequence).localeCompare(String(b.sequence)))
    const running = new Map()
    const historyRows = []
    for (const entry of merged) {
        const key = keyOf(entry.place)
        const owner = rowsByKey.get(key)
        if (!owner) continue
        if (!running.has(key)) running.set(key, owner.openingQuantity == null ? null : toDecimal(owner.openingQuantity))
        const balance = running.get(key) == null ? null : running.get(key).add(entry.quantity)
        running.set(key, balance)
        const stamp = new Date(entry.at)
        historyRows.push(
            Object.assign(describe(entry.place), {
                key,
                effectiveDate: stamp,
                effectiveDateText: dateText(stamp),
                recordedDateText: entry.recordedDate ? dateText(entry.recordedDate) : "",
                kind: entry.kind,
                kindText: kindTexts[entry.kind],
                quantity: number(entry.quantity),
                movedQuantity: entry.movedQuantity == null ? null : number(entry.movedQuantity),
                balance: number(balance),
                assetId: entry.assetId,
                otherAssetId: entry.otherAssetId || null,
                assetDetailId: entry.assetDetailId || null,
                documentType: entry.documentType || null,
                documentId: entry.documentId || null,
                documentText: entry.documentText || "",
                reasonText: reasons.get(entry.reasonEnumId) || "",
                text: entry.text || ""
            })
        )
    }
    const historyTruncated = historyRows.length > historyLimit
    if (historyTruncated) historyRows.length = historyLimit

    // the totals of each unit; never across units
    const totals = new Map()
    for (const row of stockRows) {
        const unit = row.quantityUomId || ""
        if (!totals.has(unit))
            totals.set(unit, {
                quantityUomId: row.quantityUomId,
                unitText: row.unitText,
                openingQuantity: zero(),
                receiptQuantity: zero(),
                issueQuantity: zero(),
                adjustmentQuantity: zero(),
                moveQuantity: zero(),
                closingQuantity: zero()
            })
        const total = totals.get(unit)
        for (const field of Object.keys(total).filter(field => field.endsWith("Quantity")))
            total[field] = total[field] == null || row[field] == null ? null : total[field].add(toDecimal(row[field]))
    }
    const totalRows = Array.from(totals.values()).map(total =>
        Object.fromEntries(
            Object.entries(total).map(([field, value]) => [field, field.endsWith("Quantity") ? number(value) : value])
        )
    )

    const historyKnown = overall == null || from >= overall
    const complete = !candidates.truncated && !historyTruncated && historyKnown && stockRows.every(row => row.complete)
    return Object.assign(
        {
            asOfDay,
            fromDay,
            complete,
            truncated: candidates.truncated || historyTruncated,
            historyIncomplete: !historyKnown || stockRows.some(row => !row.complete),
            historyStartText: overall == null ? "" : dateText(new Date(overall)),
            totalRows
        },
        lib.pageList(stockRows, p, "stockRows", {noLimitCap}),
        lib.pageList(historyRows, p, "historyRows", {noLimitCap, pageIndex: p.historyPageIndex})
    )
}

// A split's pair of rows (a revaluation, or a partial move) in one place at one time reads as one history row: the
// quantity moved between the two assets, with no change to the place's stock.
function mergePairs(history) {
    const pairs = new Map()
    const out = []
    for (const entry of history) {
        if (!entry.otherAssetId || (entry.kind !== "revaluation" && entry.kind !== "move")) {
            out.push(entry)
            continue
        }
        const pairKey = [
            [entry.assetId, entry.otherAssetId].sort().join(">"),
            entry.at,
            keyOf(entry.place),
            String(entry.quantity.abs())
        ].join("|")
        const first = pairs.get(pairKey)
        if (first && first.quantity.add(entry.quantity).isZero()) {
            const source = first.quantity.compare(0) < 0 ? first : entry
            const target = source === first ? entry : first
            Object.assign(first, {
                quantity: zero(),
                movedQuantity: target.quantity,
                assetId: source.assetId,
                otherAssetId: target.assetId,
                text:
                    (first.kind === "revaluation" ? "Revaluation split of " : "Moved part of ") +
                    String(target.quantity) +
                    " from asset " +
                    source.assetId +
                    " to asset " +
                    target.assetId
            })
            pairs.delete(pairKey)
            continue
        }
        pairs.set(pairKey, entry)
        out.push(entry)
    }
    return out
}

const operations = {inventoryAtDate}
;({
    execute: (op, parameters) => {
        if (!operations[op]) throw new Error("Unknown inventory at date operation " + op)
        return operations[op](parameters)
    }
})
