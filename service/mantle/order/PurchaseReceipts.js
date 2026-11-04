// Purchasing's receipt progress (impl-purchasing P5; design-purchasing §9 Receipts): each stock line of an approved purchase
// order with what is expected, received, accepted, rejected and held, apart, in the product's stock unit, its due date and
// whether it is late; and the nightly late-receipt notice (topic PurchaseLateReceipt). Purchasing posts no stock: the
// receipts are Warehouse's (mantle.shipment.WarehouseTaskServices) and the held quantity is the quality record's
// (mantle.product.QualityServices.get#SourceInspectionStatus). The callers check their own permission and scope first: the
// worklists of an app pass the organizations the user may read; the notice runs as the job.
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const {find, rows, one} = lib

const PART_VIEW = "mantle.order.OrderHeaderAndPart",
    ITEM = "mantle.order.OrderItem",
    RECEIPT = "mantle.product.receipt.AssetReceipt",
    INSPECTION = "mantle.product.quality.QualityInspection",
    SOURCE = "mantle.shipment.ShipmentItemSource",
    SHIPMENT = "mantle.shipment.Shipment"
const TOPIC = "PurchaseLateReceipt"
// the part statuses a receipt is expected in (Mantle allows a receipt only for an approved or sent part), and the closed ones
const openStatuses = ["OrderApproved", "OrderSent", "OrderProcessing", "OrderHold"]
const closedStatuses = ["OrderCompleted"]
const openReceiptStatuses = ["ShipInput", "ShipScheduled"]
const decidedInspection = ["QiSubmitted", "QiVerified", "QiDisposed"]
// a list is computed over at most this many lines (the open lines of the organizations); past it the answer says truncated
const lineCap = 2000
const DAY = 86400000

const dec = value => toDecimal(value ?? 0)
const zero = () => toDecimal(0)
const unique = values => [...new Set(values.filter(value => value != null && value !== ""))]
const text = value => ec.l10n.format(dec(value), "#,##0.###")
const internalIds = () => rows("mantle.party.PartyRole", {roleTypeId: "OrgInternal"}).map(row => row.partyId)
const productItemTypes = () =>
    Array.from(find("moqui.basic.EnumGroupMember", {enumGroupEnumId: "EngItemsProduct"}).useCache(true).list()).map(
        row => row.enumId
    )
// The start of today in the user's zone (the job's: the server's), so a line due today is not late until tomorrow.
function startOfToday(asOf) {
    const day = ec.l10n.format(new Date(lib.ms(asOf || ec.user.nowTimestamp)), "yyyy-MM-dd")
    return lib.ms(ec.l10n.parseTimestamp(day + " 00:00:00", "yyyy-MM-dd HH:mm:ss"))
}

// Stock units in one unit of the line's quantity: 1 when the line has no unit or the product's own, else Mantle's factor
// (a unit it cannot relate counts as 1, as get#OrderItemStockFactor answers).
function factorOf(item, product) {
    if (!item.quantityUomId || !product?.amountUomId || item.quantityUomId === product.amountUomId) return toDecimal(1)
    try {
        const unit = lib.call("mantle.order.OrderServices.get#OrderItemStockFactor", {orderItem: item})
        return dec(unit.stockFactor ?? 1)
    } catch (error) {
        ec.logger.warn("Stock factor of " + item.orderId + ":" + item.orderItemSeqId + ": " + error.message)
        return toDecimal(1)
    }
}

// The open receipt of each order part (its ShpTpPurchase shipment in Input or Scheduled) with its expected arrival, by
// "orderId:orderPartSeqId", for the parts of the given lines.
function openReceipts(items) {
    const orderIds = unique(items.map(item => item.orderId))
    if (!orderIds.length) return {}
    const sources = Array.from(find(SOURCE).condition("orderId", "in", orderIds).list()).filter(
        row => row.statusId !== "SisCancelled"
    )
    const shipmentIds = unique(sources.map(row => row.shipmentId))
    const open = shipmentIds.length
        ? Array.from(
              find(SHIPMENT)
                  .condition("shipmentId", "in", shipmentIds)
                  .condition("shipmentTypeEnumId", "ShpTpPurchase")
                  .condition("statusId", "in", openReceiptStatuses)
                  .orderBy("shipmentId")
                  .list()
          )
        : []
    const byPart = {}
    for (const shipment of open) {
        for (const source of sources.filter(row => row.shipmentId === shipment.shipmentId)) {
            const item = items.find(row => row.orderId === source.orderId && row.orderItemSeqId === source.orderItemSeqId)
            if (!item) continue
            const key = item.orderId + ":" + item.orderPartSeqId
            if (!byPart[key]) byPart[key] = {shipmentId: shipment.shipmentId, estimatedArrivalDate: shipment.estimatedArrivalDate}
        }
    }
    return byPart
}

// What each line's receipts' inspections decided (the receipt's first inspection, not a re-inspection, which shows through
// the held quantity): rejected units and units not decided yet, by "orderId:orderItemSeqId".
function inspectionSplit(receipts) {
    const receiptIds = receipts.map(row => row.assetReceiptId)
    const split = {}
    if (!receiptIds.length) return split
    const inspections = Array.from(
        find(INSPECTION)
            .condition("assetReceiptId", "in", receiptIds)
            .condition("statusId", "not-equals", "QiCancelled")
            .condition("previousInspectionId", "is-null", null)
            .list()
    )
    for (const inspection of inspections) {
        const receipt = receipts.find(row => row.assetReceiptId === inspection.assetReceiptId)
        const key = receipt.orderId + ":" + receipt.orderItemSeqId
        const entry = split[key] || (split[key] = {rejected: zero(), undecided: zero(), inspectionIds: []})
        entry.inspectionIds.push(inspection.qualityInspectionId)
        if (decidedInspection.includes(inspection.statusId)) entry.rejected = entry.rejected.add(dec(inspection.quantityRejected))
        else entry.undecided = entry.undecided.add(dec(inspection.quantity))
    }
    return split
}

// The held quantity of a line (Mantle's quality status of the order line: open inspections' held quantity, a quarantined
// receipt with no inspection held whole).
function heldOf(orderId, orderItemSeqId) {
    try {
        return dec(lib.call("mantle.product.QualityServices.get#SourceInspectionStatus", {orderId, orderItemSeqId}).heldQuantity)
    } catch (error) {
        ec.logger.error("Held quantity of " + orderId + ":" + orderItemSeqId + ": " + error.message)
        return null
    }
}

// The stock lines of the purchase parts of organizationPartyIds (null for every internal organization), in the given part
// statuses (the open ones by default; "closed" adds the completed), narrowed to vendorPartyId, orderId or facilityId; each
// with its quantities in stock units, its open receipt, its due date (the line's required date, else the part's promised
// delivery, else the open receipt's expected arrival) and whether it is late (due before today and something still to
// come). excludedVendorIds leaves out suppliers the caller's user may not work with. At most lineCap lines (truncated).
function lines(p) {
    const organizations = p.organizationPartyIds == null ? null : Array.from(p.organizationPartyIds)
    if (organizations && !organizations.length) return {lines: [], truncated: false}
    const statuses = p.includeClosed ? openStatuses.concat(closedStatuses) : openStatuses
    let partQuery = find(PART_VIEW)
        .condition("partStatusId", "in", statuses)
        .condition("vendorPartyId", "not-in", internalIds())
        .selectField("orderId,orderPartSeqId,customerPartyId,vendorPartyId,facilityId,partStatusId,estimatedDeliveryDate")
        .selectField("entryDate,orderName")
        .orderBy("-entryDate")
        .orderBy("orderId")
    partQuery = organizations
        ? partQuery.condition("customerPartyId", "in", organizations)
        : partQuery.condition("customerPartyId", "in", internalIds())
    if (p.orderId) partQuery = partQuery.condition("orderId", String(p.orderId))
    if (p.vendorPartyId) partQuery = partQuery.condition("vendorPartyId", String(p.vendorPartyId))
    if (p.facilityId) partQuery = partQuery.condition("facilityId", String(p.facilityId))
    const excluded = Array.from(p.excludedVendorIds || [])
    if (excluded.length) partQuery = partQuery.condition("vendorPartyId", "not-in", excluded)
    const parts = Array.from(partQuery.limit(lineCap).list())
    const orderIds = unique(parts.map(part => part.orderId))
    if (!orderIds.length) return {lines: [], truncated: false}
    let items = Array.from(
        find(ITEM)
            .condition("orderId", "in", orderIds)
            .condition("itemTypeEnumId", "in", productItemTypes())
            .condition("productId", "is-not-null", null)
            .orderBy("orderId")
            .orderBy("orderItemSeqId")
            .list()
    ).filter(item => parts.some(part => part.orderId === item.orderId && part.orderPartSeqId === item.orderPartSeqId))
    if (p.orderItemSeqId) items = items.filter(item => item.orderItemSeqId === String(p.orderItemSeqId))
    const truncated = items.length > lineCap
    items = items.slice(0, lineCap)
    const productIds = unique(items.map(item => item.productId))
    const products = Object.fromEntries(
        (productIds.length ? Array.from(find("mantle.product.Product").condition("productId", "in", productIds).list()) : []).map(
            row => [row.productId, row]
        )
    )
    // a service line receives nothing (it is accepted, accept#ServiceItem)
    items = items.filter(item => products[item.productId] && products[item.productId].productTypeEnumId !== "PtService")
    const receipts = Array.from(find(RECEIPT).condition("orderId", "in", orderIds).list())
    const split = inspectionSplit(receipts)
    const receiptsByPart = openReceipts(items)
    const today = startOfToday(p.asOf)
    const answer = items.map(item => {
        const part = parts.find(row => row.orderId === item.orderId && row.orderPartSeqId === item.orderPartSeqId)
        const product = products[item.productId]
        const factor = factorOf(item, product)
        const own = receipts.filter(row => row.orderItemSeqId === item.orderItemSeqId && row.orderId === item.orderId)
        const dockAccepted = own.reduce((sum, row) => sum.add(dec(row.quantityAccepted)), zero())
        const dockRejected = own.reduce((sum, row) => sum.add(dec(row.quantityRejected)), zero())
        const inspected = split[item.orderId + ":" + item.orderItemSeqId] || {
            rejected: zero(),
            undecided: zero(),
            inspectionIds: []
        }
        const ordered = dec(item.quantity).multiply(factor)
        const cancelled = dec(item.quantityCancelled).multiply(factor)
        const expected = ordered.subtract(cancelled)
        const received = dockAccepted.add(dockRejected)
        let remaining = expected.subtract(received)
        if (remaining.compare(0) < 0) remaining = zero()
        let accepted = dockAccepted.subtract(inspected.rejected).subtract(inspected.undecided)
        if (accepted.compare(0) < 0) accepted = zero()
        const held = own.length ? heldOf(item.orderId, item.orderItemSeqId) : zero()
        const receipt = receiptsByPart[item.orderId + ":" + item.orderPartSeqId] || null
        const dueDate = item.requiredByDate || part.estimatedDeliveryDate || receipt?.estimatedArrivalDate || null
        const open = openStatuses.includes(part.partStatusId) && remaining.compare(0) > 0
        const late = open && dueDate != null && lib.ms(dueDate) < today
        return {
            orderId: item.orderId,
            orderPartSeqId: item.orderPartSeqId,
            orderItemSeqId: item.orderItemSeqId,
            orderName: part.orderName || "",
            organizationPartyId: part.customerPartyId,
            supplierPartyId: part.vendorPartyId,
            facilityId: part.facilityId || null,
            partStatusId: part.partStatusId,
            productId: item.productId,
            itemDescription: item.itemDescription || "",
            stockUomId: product.amountUomId || null,
            orderUomId: item.quantityUomId || null,
            orderedQuantity: dec(item.quantity),
            expectedQuantity: expected,
            receivedQuantity: received,
            acceptedQuantity: accepted,
            rejectedQuantity: dockRejected.add(inspected.rejected),
            undecidedQuantity: inspected.undecided,
            heldQuantity: held,
            remainingQuantity: remaining,
            inspectionIds: inspected.inspectionIds,
            shipmentIds: unique(own.map(row => row.shipmentId)),
            openShipmentId: receipt?.shipmentId || null,
            estimatedArrivalDate: receipt?.estimatedArrivalDate || null,
            dueDate,
            open,
            late
        }
    })
    return {lines: answer, truncated: truncated || parts.length >= lineCap}
}

// The order parts with a late line, by "orderId:orderPartSeqId": the earliest due date, the late lines and their remaining.
function lateParts(p) {
    const found = lines(p)
    const parts = {}
    for (const line of found.lines.filter(row => row.late)) {
        const key = line.orderId + ":" + line.orderPartSeqId
        const entry =
            parts[key] ||
            (parts[key] = {
                orderId: line.orderId,
                orderPartSeqId: line.orderPartSeqId,
                organizationPartyId: line.organizationPartyId,
                supplierPartyId: line.supplierPartyId,
                dueDate: line.dueDate,
                lines: []
            })
        if (lib.ms(line.dueDate) < lib.ms(entry.dueDate)) entry.dueDate = line.dueDate
        entry.lines.push({
            orderItemSeqId: line.orderItemSeqId,
            productId: line.productId,
            remaining: text(line.remainingQuantity)
        })
    }
    return {parts: Object.values(parts), truncated: found.truncated}
}

// The users told of an organization's late receipt: those with PURCHASE_ORDER_EDIT who are agents, employees or members of
// it (the buyers).
function buyersOf(organizationPartyId) {
    const groupIds = unique(
        rows("moqui.security.UserGroupPermission", {userPermissionId: "PURCHASE_ORDER_EDIT"})
            .filter(row => lib.active(row))
            .map(row => row.userGroupId)
    )
    if (!groupIds.length) return []
    const userIds = unique(
        Array.from(find("moqui.security.UserGroupMember").condition("userGroupId", "in", groupIds).list())
            .filter(row => lib.active(row))
            .map(row => row.userId)
    )
    if (!userIds.length) return []
    const accounts = Array.from(find("moqui.security.UserAccount").condition("userId", "in", userIds).list()).filter(
        row => row.partyId && row.disabled !== "Y"
    )
    if (!accounts.length) return []
    const members = new Set(
        Array.from(
            find("mantle.party.PartyRelationship", {toPartyId: organizationPartyId})
                .condition("relationshipTypeEnumId", "in", ["PrtAgent", "PrtEmployee", "PrtMember"])
                .condition(
                    "fromPartyId",
                    "in",
                    accounts.map(row => row.partyId)
                )
                .list()
        )
            .filter(row => lib.active(row))
            .map(row => row.fromPartyId)
    )
    return accounts.filter(row => members.has(row.partyId)).map(row => row.userId)
}

// notify#LateReceipts: once for each order part and due date, the buyers of its organization hear that it is late (the late
// lines and what is still to come). A part that fails is logged and the others go on.
function notifyLate(p) {
    const found = lateParts({organizationPartyIds: p.organizationPartyId ? [p.organizationPartyId] : null, asOf: p.asOf})
    let notified = 0
    for (const part of found.parts) {
        try {
            const dueDay = ec.l10n.format(new Date(lib.ms(part.dueDate)), "yyyy-MM-dd")
            const sent = rows("moqui.security.user.NotificationMessage", {
                topic: TOPIC,
                recordEntityName: "mantle.order.OrderHeader",
                recordId: part.orderId
            }).some(row => {
                const message = lib.json(row.messageJson, {})
                return message.orderPartSeqId === part.orderPartSeqId && message.dueDay === dueDay
            })
            if (sent) continue
            const userIds = buyersOf(part.organizationPartyId)
            if (!userIds.length) continue
            const supplier =
                one("mantle.party.Organization", {partyId: part.supplierPartyId})?.organizationName || part.supplierPartyId
            ec.makeNotificationMessage()
                .topic(TOPIC)
                .message({
                    orderId: part.orderId,
                    orderPartSeqId: part.orderPartSeqId,
                    supplierName: supplier,
                    dueDay,
                    lineCount: part.lines.length,
                    lines: part.lines
                })
                .record("mantle.order.OrderHeader", part.orderId)
                .userIds(userIds)
                .send()
            notified++
        } catch (error) {
            ec.logger.error("Late receipt notice of order " + part.orderId + ":" + part.orderPartSeqId + ": " + error.message)
        }
    }
    return {notifiedCount: notified, lateCount: found.parts.length}
}

const operations = {lines, lateParts, notifyLate}
;({
    lines,
    lateParts,
    inspectionSplit,
    startOfToday,
    DAY,
    execute: (op, parameters) => {
        if (!operations[op]) throw new Error("Unknown purchase receipt operation " + op)
        return operations[op](parameters)
    }
})
