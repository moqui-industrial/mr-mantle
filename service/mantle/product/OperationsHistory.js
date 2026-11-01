// Operations history (impl-warehouse P17, WH-REPORT; design-warehouse §14 OperationsHistory): the receipts, shipments,
// returns and transfers of a period, one row per document and product with its expected and actual dates and its expected,
// accepted, rejected, picked, shipped and delivered quantities, and the totals of each unit (never across units). The period
// is on the movement dates (receipts and issues) or the document dates (expected arrival or ship). Read only in the user's
// organizations (StockScope: a document of a facility they own), narrowed to the caller's facilities; no cost.
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const stock = ec.resource.script("component://mr-mantle/service/mantle/product/StockScope.js")
const {find, denied, ms, dateText} = lib

const SEGMENT_VIEW = "mantle.shipment.ShipmentAndRouteSegment"
const operations = {
    receipt: {types: ["ShpTpPurchase", "ShpTpIncoming"], text: "Receipt"},
    shipment: {types: ["ShpTpSales", "ShpTpOutgoing"], text: "Shipment"},
    return: {types: ["ShpTpSalesReturn", "ShpTpPurchaseReturn"], text: "Return"},
    transfer: {types: ["ShpTpTransfer"], text: "Transfer"}
}
const INBOUND = ["ShpTpPurchase", "ShpTpIncoming", "ShpTpSalesReturn"]
const shipmentLimit = 1000
const noLimitCap = 5000
const chunkSize = 500
const DAY = 86400000
// a product's stock unit; one with none counts in each, as Mantle's stock factor does (OrderServices.get#OrderItemStockFactor),
// so its totals are each's and not a unit of their own
const EACH = "OTH_ea"
const stockUnit = product => product?.amountUomId || EACH
const QUANTITIES = [
    "expectedQuantity",
    "acceptedQuantity",
    "rejectedQuantity",
    "pickedQuantity",
    "shippedQuantity",
    "deliveredQuantity"
]

const dayAfter = day => lib.calendarDateText(Date.parse(day) + DAY)
const midnight = day => ec.l10n.parseTimestamp(day, "yyyy-MM-dd")
const today = () => ec.l10n.format(ec.user.nowTimestamp, "yyyy-MM-dd")
const dayOf = value => (value == null ? null : ec.l10n.format(value, "yyyy-MM-dd"))
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
const operationOf = typeId => Object.keys(operations).find(key => operations[key].types.includes(typeId)) || null

function period(p) {
    const thruDay = p.thruDate ? lib.calendarDateText(p.thruDate) : today()
    const fromDay = p.fromDate ? lib.calendarDateText(p.fromDate) : lib.calendarDateText(Date.parse(thruDay) - 29 * DAY)
    if (fromDay > thruDay) denied("DATE_RANGE", "The first day must be on or before the last day")
    return {fromDay, thruDay, from: midnight(fromDay), before: midnight(dayAfter(thruDay))}
}

// The facilities a document may be of: the organizations' (null for every one) narrowed to the caller's and the one chosen.
function allowedFacilities(userScope, p) {
    let ids = stock.facilityIds(userScope)
    if (p.facilityIds != null) {
        const caller = new Set(Array.from(p.facilityIds))
        ids = ids == null ? Array.from(caller) : ids.filter(id => caller.has(id))
    }
    if (p.facilityId) {
        if (ids != null && !ids.includes(p.facilityId))
            denied("FACILITY_UNAVAILABLE", "Facility " + p.facilityId + " is not available")
        ids = [p.facilityId]
    }
    return ids
}

// The documents of the period, filtered in the query (type, facility, party, carrier, product and dates) before the limit.
function documentIds(p, facilityIds, dates) {
    const factory = ec.entity.conditionFactory
    const condition = (field, operator, value) => factory.makeCondition(field, operator, value)
    const types = p.operation ? operations[p.operation]?.types : Object.values(operations).flatMap(entry => entry.types)
    if (!types) denied("OPERATION_INVALID", "Choose receipts, shipments, returns or transfers")
    const base = [condition("shipmentTypeEnumId", "in", types)]
    if (facilityIds != null) {
        const ids = facilityIds.length ? facilityIds : ["_NA_"]
        base.push(
            factory.makeCondition([condition("originFacilityId", "in", ids), condition("destinationFacilityId", "in", ids)], "or")
        )
    }
    if (p.partyId)
        base.push(
            factory.makeCondition(
                [condition("fromPartyId", "equals", p.partyId), condition("toPartyId", "equals", p.partyId)],
                "or"
            )
        )
    if (p.carrierPartyId) base.push(condition("carrierPartyId", "equals", p.carrierPartyId))
    // the shipments to read: by movement, those with a receipt or issue in the period; by document, those expected in it
    let limitTo = null
    if (p.dateBasis === "document") {
        // the expected date each row shows: arrival for incoming; a transfer's arrival, else its ship date; an outgoing
        // shipment's ship date, else its ready date
        const all = list => factory.makeCondition(list, "and")
        const inPeriod = field => all([condition(field, "greater-equals", dates.from), condition(field, "less", dates.before)])
        const firstOf = (primary, fallback) =>
            factory.makeCondition([inPeriod(primary), all([condition(primary, "is-null", null), inPeriod(fallback)])], "or")
        const inbound = all([condition("shipmentTypeEnumId", "in", INBOUND), inPeriod("estimatedArrivalDate")])
        const transfer = all([
            condition("shipmentTypeEnumId", "equals", "ShpTpTransfer"),
            firstOf("estimatedArrivalDate", "estimatedShipDate")
        ])
        const outbound = all([
            condition("shipmentTypeEnumId", "not-in", INBOUND.concat(["ShpTpTransfer"])),
            firstOf("estimatedShipDate", "estimatedReadyDate")
        ])
        base.push(factory.makeCondition([inbound, transfer, outbound], "or"))
        if (p.productId)
            limitTo = Array.from(
                find("mantle.shipment.ShipmentItem", {productId: p.productId}).selectField("shipmentId").distinct(true).list()
            ).map(row => row.shipmentId)
    } else {
        // the receipts (by their asset's facility) and issues (by theirs) in the period, in the facilities first
        const moved = (entity, dateField) => {
            let query = find(entity)
                .condition(dateField, "greater-equals", dates.from)
                .condition(dateField, "less", dates.before)
                .condition("shipmentId", "is-not-null", null)
            if (p.productId) query = query.condition("productId", p.productId)
            if (facilityIds != null) query = query.condition("facilityId", "in", facilityIds.length ? facilityIds : ["_NA_"])
            return Array.from(query.selectField("shipmentId").distinct(true).list()).map(row => row.shipmentId)
        }
        limitTo = unique(
            moved("mantle.product.receipt.AssetReceiptDetail", "receivedDate").concat(
                moved("mantle.product.issuance.AssetIssuance", "issuedDate")
            )
        )
    }
    const found = new Set()
    const read = extra => {
        let query = find(SEGMENT_VIEW).condition(factory.makeCondition(base.concat(extra), "and"))
        for (const row of query
            .selectField("shipmentId")
            .distinct(true)
            .orderBy("-shipmentId")
            .limit(shipmentLimit + 1)
            .list())
            found.add(row.shipmentId)
    }
    if (limitTo == null) read([])
    else for (const part of chunks(limitTo)) read([condition("shipmentId", "in", part)])
    const ids = Array.from(found).sort().reverse()
    return {ids: ids.slice(0, shipmentLimit), truncated: ids.length > shipmentLimit}
}

function operationsHistory(p) {
    const userScope = stock.scope()
    const dates = period(p)
    const facilityIds = allowedFacilities(userScope, p)
    const documents = documentIds(p, facilityIds, dates)
    const ids = documents.ids
    const shipments = new Map(rowsIn("mantle.shipment.Shipment", "shipmentId", ids).map(row => [row.shipmentId, row]))
    const segments = new Map()
    for (const row of rowsIn("mantle.shipment.ShipmentRouteSegment", "shipmentId", ids, query =>
        query.orderBy("shipmentRouteSegmentSeqId")
    ))
        if (!segments.has(row.shipmentId)) segments.set(row.shipmentId, row)
    // each document's lines by product: expected (its items), accepted and rejected (receipts), picked (sources), shipped
    const lines = new Map()
    const line = (shipmentId, productId) => {
        const key = shipmentId + "|" + productId
        if (!lines.has(key))
            lines.set(key, {
                shipmentId,
                productId,
                expected: toDecimal(0),
                accepted: toDecimal(0),
                rejected: toDecimal(0),
                picked: toDecimal(0),
                shipped: toDecimal(0),
                received: null,
                issued: null,
                returnId: null
            })
        return lines.get(key)
    }
    const wanted = productId => !p.productId || productId === p.productId
    const later = (current, value) => (value != null && (current == null || ms(value) > ms(current)) ? value : current)
    for (const item of rowsIn("mantle.shipment.ShipmentItem", "shipmentId", ids))
        if (wanted(item.productId)) line(item.shipmentId, item.productId).expected = toDecimal(item.quantity ?? 0)
    for (const receipt of rowsIn("mantle.product.receipt.AssetReceipt", "shipmentId", ids)) {
        if (!wanted(receipt.productId)) continue
        const entry = line(receipt.shipmentId, receipt.productId)
        entry.accepted = entry.accepted.add(toDecimal(receipt.quantityAccepted ?? 0))
        entry.rejected = entry.rejected.add(toDecimal(receipt.quantityRejected ?? 0))
        entry.received = later(entry.received, receipt.receivedDate)
        entry.returnId = entry.returnId || receipt.returnId || null
    }
    for (const issuance of rowsIn("mantle.product.issuance.AssetIssuance", "shipmentId", ids)) {
        if (!wanted(issuance.productId)) continue
        const entry = line(issuance.shipmentId, issuance.productId)
        entry.shipped = entry.shipped.add(toDecimal(issuance.quantity ?? 0)).subtract(toDecimal(issuance.quantityCancelled ?? 0))
        entry.issued = later(entry.issued, issuance.issuedDate)
    }
    for (const source of rowsIn("mantle.shipment.ShipmentItemSource", "shipmentId", ids)) {
        if (!wanted(source.productId)) continue
        const entry = line(source.shipmentId, source.productId)
        entry.picked = entry.picked.add(toDecimal(source.quantityPicked ?? 0))
        entry.returnId = entry.returnId || source.returnId || null
    }
    const entries = Array.from(lines.values()).filter(entry => shipments.has(entry.shipmentId))
    const products = new Map(
        rowsIn(
            "mantle.product.Product",
            "productId",
            entries.map(entry => entry.productId)
        ).map(row => [row.productId, row])
    )
    const units = names("moqui.basic.Uom", "uomId", "description", Array.from(products.values()).map(stockUnit).concat([EACH]))
    const facilityNames = names(
        "mantle.facility.Facility",
        "facilityId",
        "facilityName",
        Array.from(segments.values()).flatMap(row => [row.originFacilityId, row.destinationFacilityId])
    )
    const statuses = names(
        "moqui.basic.StatusItem",
        "statusId",
        "description",
        Array.from(shipments.values()).map(row => row.statusId)
    )
    const parties = lib.partyNames(
        Array.from(shipments.values())
            .flatMap(row => [row.fromPartyId, row.toPartyId])
            .concat(Array.from(segments.values()).map(row => row.carrierPartyId))
    )

    const historyRows = entries.map(entry => {
        const shipment = shipments.get(entry.shipmentId)
        const segment = segments.get(entry.shipmentId) || {}
        const product = products.get(entry.productId)
        const operation = operationOf(shipment.shipmentTypeEnumId)
        const inbound = INBOUND.includes(shipment.shipmentTypeEnumId)
        const transfer = operation === "transfer"
        const expectedDate = inbound
            ? shipment.estimatedArrivalDate
            : transfer
              ? shipment.estimatedArrivalDate || shipment.estimatedShipDate
              : shipment.estimatedShipDate || shipment.estimatedReadyDate
        const actualDate = inbound ? entry.received : transfer ? entry.received || entry.issued : entry.issued
        const expectedDay = dayOf(expectedDate),
            actualDay = dayOf(actualDate)
        const otherPartyId = transfer ? null : inbound ? shipment.fromPartyId : shipment.toPartyId
        const facilityText = [segment.originFacilityId, segment.destinationFacilityId]
            .filter(Boolean)
            .map(id => facilityNames.get(id) || id)
            .join(" → ")
        const outbound = !inbound
        return {
            shipmentId: entry.shipmentId,
            operation,
            operationText: operations[operation]?.text || "",
            shipmentTypeEnumId: shipment.shipmentTypeEnumId,
            statusId: shipment.statusId,
            statusText: statuses.get(shipment.statusId) || shipment.statusId || "",
            returnId: entry.returnId,
            partyId: otherPartyId,
            partyName: otherPartyId ? parties[otherPartyId] || otherPartyId : "",
            originFacilityId: segment.originFacilityId || null,
            destinationFacilityId: segment.destinationFacilityId || null,
            facilityText,
            carrierPartyId: segment.carrierPartyId || null,
            carrierName: segment.carrierPartyId ? parties[segment.carrierPartyId] || segment.carrierPartyId : "",
            productId: entry.productId,
            productName: product?.productName || entry.productId,
            quantityUomId: stockUnit(product),
            unitText: units.get(stockUnit(product)) || stockUnit(product),
            expectedQuantity: number(entry.expected),
            acceptedQuantity: inbound || transfer ? number(entry.accepted) : null,
            rejectedQuantity: inbound || transfer ? number(entry.rejected) : null,
            pickedQuantity: outbound ? number(entry.picked) : null,
            shippedQuantity: outbound ? number(entry.shipped) : null,
            // delivered only once the shipment is: unknown (null) before, not zero
            deliveredQuantity: outbound && shipment.statusId === "ShipDelivered" ? number(entry.shipped) : null,
            expectedDateText: expectedDay || "",
            actualDateText: actualDate ? dateText(actualDate) : "",
            daysFromExpected:
                expectedDay && actualDay ? Math.round((Date.parse(actualDay) - Date.parse(expectedDay)) / DAY) : null,
            sortDate: ms(actualDate || expectedDate || shipment.entryDate || 0) || 0
        }
    })
    historyRows.sort(
        (a, b) =>
            b.sortDate - a.sortDate ||
            String(b.shipmentId).localeCompare(String(a.shipmentId)) ||
            String(a.productName).localeCompare(String(b.productName))
    )
    for (const row of historyRows) delete row.sortDate

    // the totals of each unit, over every row of the period (not one page); never across units
    const totals = new Map()
    for (const row of historyRows) {
        const unit = row.quantityUomId || ""
        if (!totals.has(unit))
            totals.set(
                unit,
                Object.assign(
                    {quantityUomId: row.quantityUomId, unitText: row.unitText, rowCount: 0},
                    Object.fromEntries(QUANTITIES.map(field => [field, null]))
                )
            )
        const total = totals.get(unit)
        total.rowCount++
        for (const field of QUANTITIES)
            if (row[field] != null) total[field] = (total[field] || toDecimal(0)).add(toDecimal(row[field]))
    }
    const totalRows = Array.from(totals.values()).map(total =>
        Object.assign({}, total, Object.fromEntries(QUANTITIES.map(field => [field, number(total[field])])))
    )
    return Object.assign(
        {
            fromDay: dates.fromDay,
            thruDay: dates.thruDay,
            dateBasis: p.dateBasis === "document" ? "document" : "movement",
            complete: !documents.truncated,
            totalRows
        },
        lib.pageList(historyRows, p, "historyRows", {noLimitCap})
    )
}

;({
    execute: (op, parameters) => {
        if (op !== "operationsHistory") throw new Error("Unknown operations history operation " + op)
        return operationsHistory(parameters)
    }
})
