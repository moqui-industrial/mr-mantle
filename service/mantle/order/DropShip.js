// Drop-ship (impl-purchasing P7, design-purchasing §18; F14, F21, F37–F40), Moqui Java's dropship-moqui branch ported and
// finished. A customer order line drops to a supplier by its reservation: reserved at a supplier's drop-ship facility
// (FcTpDropShip, owned by the supplier), against its stock or Mantle's shell asset, it is bought from that supplier on a
// purchase order the sales order's approval makes (create#DropShipPurchaseOrder, after reserve#AssetsForOrder in
// OrderApprovedReserveAssets): one order per sales part and drop-ship facility, its parentOrderId the sales order, its part
// from the facility's owner to the selling organization with the end customer as the CustomerShipTo party and the sales
// part's ship-to, each line at the supplier's price and linked to its sales line (OrderItem.salesOrderId and
// salesOrderItemSeqId, F38). With the buying organization's approval gate on (PurchasePolicy.approvalGateEnabled) the order
// stops at Placed and goes to the approvers (P4), else it is approved at once as the branch does (F40); once approved it
// goes to the supplier's integration (Facility.dropShipRemoteId's send service, the send#DropShipPurchaseOrderPart
// interface) or by email (send#PurchaseOrder's path), after the approval commits (DropShip.secas.xml).
// The supplier's confirmation (finalize#DropShipPurchaseOrder, from the integration or the buyer) ships the purchase order's
// own delivery (a ShpTpPurchase shipment, never received, F38), packs and ships the sales shipment of the linked lines with
// the tracking code (Mantle's pack rule invoices the customer), moves each line's cost from Unreceived Inventory to the cost
// of goods sold (AttDropShipDelivery, F39: the sales issuance of a shell asset posts nothing and the supplier's bill debits
// Unreceived Inventory) and completes a purchase order delivered in full; a retry changes nothing. "Drop-ship from supplier"
// (route#OrderItemToDropShip) moves a customer line to a supplier's drop-ship facility, reserves it there and, on an
// approved order, makes the purchase order at once. An organization with no drop-ship facility sees no change.
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const facilityScope = ec.resource.script("component://mr-mantle/service/mantle/facility/FacilityScope.js")
const policy = ec.resource.script("component://mr-mantle/service/mantle/order/PurchasePolicy.js")
const orders = () => ec.resource.script("component://mr-mantle/service/mantle/order/PurchaseOrders.js")
const approvals = () => ec.resource.script("component://mr-mantle/service/mantle/order/PurchaseApprovals.js")
const documents = () => ec.resource.script("component://mr-mantle/service/mantle/order/PurchaseOrderDocuments.js")
const {find, one, rows, call, denied, access} = lib

const ORDER = "mantle.order.OrderHeader",
    PART = "mantle.order.OrderPart",
    ITEM = "mantle.order.OrderItem",
    FACILITY = "mantle.facility.Facility",
    RESERVATION = "mantle.product.issuance.AssetReservation",
    SIS = "mantle.shipment.ShipmentItemSource"
const DROP_SHIP = "FcTpDropShip"
const readPermissions = ["PURCHASE_ORDER_EDIT", "PURCHASE_APPROVE", "PURCHASE_ORDER_APPROVE"]
const deliverStatuses = ["OrderApproved", "OrderSent", "OrderProcessing"]
const routeStatuses = ["OrderOpen", "OrderPlaced", "OrderProcessing", "OrderApproved", "OrderSent"]
const deadStatuses = ["OrderCancelled", "OrderRejected"]
const shippedStatuses = ["ShipShipped", "ShipDelivered"]
const blank = value => value == null || String(value).trim() === ""
const text = value => (blank(value) ? null : String(value).trim())
const dec = value => toDecimal(value ?? 0)
const zero = () => toDecimal(0)
const unique = list => [...new Set(list.filter(value => value != null))]
const byId = (list, key) => Object.fromEntries(Array.from(list).map(row => [row[key], row]))
const isInternal = partyId => !!partyId && !!one("mantle.party.PartyRole", {partyId, roleTypeId: "OrgInternal"})
const partyName = partyId => lib.partyNames([partyId])[partyId] || partyId || ""
const statusText = statusId => (statusId ? one("moqui.basic.StatusItem", {statusId})?.description || statusId : "")
const quantityText = value => ec.l10n.format(dec(value), "#,##0.###")
const now = () => ec.user.nowTimestamp
let itemTypes = null
function productItemTypes() {
    if (!itemTypes)
        itemTypes = new Set(rows("moqui.basic.EnumGroupMember", {enumGroupEnumId: "EngItemsProduct"}).map(row => row.enumId))
    return itemTypes
}
const openQuantity = item => dec(item.quantity ?? 1).subtract(dec(item.quantityCancelled))
const isProductLine = item => !!item.productId && productItemTypes().has(item.itemTypeEnumId) && !item.parentItemSeqId
function dropShipFacility(facilityId) {
    const facility = blank(facilityId) ? null : one(FACILITY, {facilityId})
    return facility?.facilityTypeEnumId === DROP_SHIP ? facility : null
}
// The supplier's drop-ship facilities.
const dropShipFacilitiesOf = supplierPartyId =>
    blank(supplierPartyId) ? [] : rows(FACILITY, {ownerPartyId: supplierPartyId, facilityTypeEnumId: DROP_SHIP})
// The drop-ship purchase order lines of a sales order on an order still live (not cancelled or rejected), by sales line.
function linkedLines(salesOrderId) {
    const lines = Array.from(find(ITEM).condition("salesOrderId", salesOrderId).list())
    const statuses = byId(
        lines.length
            ? find(ORDER)
                  .condition("orderId", "in", unique(lines.map(line => line.orderId)))
                  .list()
            : [],
        "orderId"
    )
    const linked = new Map()
    for (const line of lines)
        if (statuses[line.orderId] && !deadStatuses.includes(statuses[line.orderId].statusId))
            linked.set(line.salesOrderItemSeqId, Object.assign({statusId: statuses[line.orderId].statusId}, lib.map(line)))
    return linked
}
// A supplier's current purchase price for the organization, read as the order's own rule (no user's price permission): the
// row for the organization before the supplier's general one, the highest minimum quantity the quantity reaches. Drop-ship
// only takes a row the supplier marked canDropShip when asked.
function supplierPrice(supplierPartyId, organizationPartyId, productId, quantity, currencyUomId, dropShipOnly = false) {
    const candidates = rows("mantle.product.ProductPrice", {
        productId,
        vendorPartyId: supplierPartyId,
        pricePurposeEnumId: "PppPurchase",
        priceTypeEnumId: "PptCurrent"
    })
        .filter(row => lib.active(row))
        .filter(row => !currencyUomId || !row.priceUomId || row.priceUomId === currencyUomId)
        .filter(row => !row.customerPartyId || row.customerPartyId === organizationPartyId)
        .filter(row => dec(row.minQuantity).compare(dec(quantity)) <= 0)
        .filter(row => !dropShipOnly || row.canDropShip === "Y")
        .sort(
            (a, b) => (b.customerPartyId ? 1 : 0) - (a.customerPartyId ? 1 : 0) || dec(b.minQuantity).compare(dec(a.minQuantity))
        )
    return candidates[0] || null
}

// ===== create#DropShipPurchaseOrder =====
// The sales lines reserved at a drop-ship facility of an approved order, bought on a purchase order per sales part and
// facility. A line already on a live drop-ship purchase order is answered with that order (a retry). A line that is meant
// to drop (its part's facility, or its reservation, is a drop-ship facility) but cannot is named in skippedItems: no
// reservation (NO_RESERVATION), reserved apart from it (RESERVATION_SPLIT), a facility with no owner (NO_SUPPLIER) or an
// internal owner (INTERNAL_OWNER); a line with no current price from the supplier is bought at zero and named in
// unpricedItems. No permission check: it runs as the user who approved the sales order.
function create(p) {
    const salesOrderId = text(p.salesOrderId)
    const result = {purchaseOrderIds: [], createdOrderIds: [], skippedItems: [], unpricedItems: []}
    const header = salesOrderId ? one(ORDER, {orderId: salesOrderId}) : null
    if (!header) return result
    const salesParts = rows(PART, {orderId: salesOrderId}).filter(part => isInternal(part.vendorPartyId))
    if (!salesParts.length) return result
    const reservations = rows(RESERVATION, {orderId: salesOrderId})
    const assets = byId(
        reservations.length
            ? find("mantle.product.asset.Asset")
                  .condition("assetId", "in", unique(reservations.map(row => row.assetId)))
                  .list()
            : [],
        "assetId"
    )
    const facilityIds = unique(Object.values(assets).map(asset => asset.facilityId)).concat(
        unique(salesParts.map(part => part.facilityId))
    )
    const dropFacilities = byId(
        facilityIds.length
            ? find(FACILITY).condition("facilityId", "in", unique(facilityIds)).condition("facilityTypeEnumId", DROP_SHIP).list()
            : [],
        "facilityId"
    )
    if (!Object.keys(dropFacilities).length) return result
    const partOf = byId(salesParts, "orderPartSeqId")
    const linked = linkedLines(salesOrderId)
    const groups = new Map()
    const skip = (item, reasonCode, message) =>
        result.skippedItems.push({orderItemSeqId: item.orderItemSeqId, productId: item.productId, reasonCode, message})
    for (const item of rows(ITEM, {orderId: salesOrderId}).sort((a, b) => a.orderItemSeqId.localeCompare(b.orderItemSeqId))) {
        const part = partOf[item.orderPartSeqId]
        if (!part || !isProductLine(item) || openQuantity(item).compare(0) <= 0) continue
        const own = reservations.filter(row => row.orderItemSeqId === item.orderItemSeqId)
        const dropOwn = own.filter(row => dropFacilities[assets[row.assetId]?.facilityId])
        if (!dropOwn.length && !dropFacilities[part.facilityId]) continue
        const existing = linked.get(item.orderItemSeqId)
        if (existing) {
            if (!result.purchaseOrderIds.includes(existing.orderId)) result.purchaseOrderIds.push(existing.orderId)
            continue
        }
        if (!dropOwn.length) {
            skip(item, "NO_RESERVATION", "Line " + item.orderItemSeqId + " is not reserved at the drop-ship facility")
            continue
        }
        const facilityIdsOf = unique(dropOwn.map(row => assets[row.assetId].facilityId))
        if (own.length > dropOwn.length || facilityIdsOf.length > 1) {
            skip(item, "RESERVATION_SPLIT", "Line " + item.orderItemSeqId + " is reserved at more than one facility")
            continue
        }
        const facility = dropFacilities[facilityIdsOf[0]]
        if (!facility.ownerPartyId) {
            skip(item, "NO_SUPPLIER", "Drop-ship facility " + facility.facilityId + " has no supplier (owner)")
            continue
        }
        if (isInternal(facility.ownerPartyId)) {
            skip(item, "INTERNAL_OWNER", "Drop-ship facility " + facility.facilityId + " is owned by an internal organization")
            continue
        }
        const key = part.orderPartSeqId + "|" + facility.facilityId
        if (!groups.has(key)) groups.set(key, {part, facility, items: []})
        groups.get(key).items.push(item)
    }
    for (const group of groups.values()) {
        const made = makeOrder(header, group, result)
        result.createdOrderIds.push(made.orderId)
        result.purchaseOrderIds.push(made.orderId)
    }
    for (const skipped of result.skippedItems)
        ec.logger.warn("Drop-ship of order " + salesOrderId + " passed over " + skipped.reasonCode + ": " + skipped.message)
    return result
}
// The purchase order of one sales part's lines at one drop-ship facility, placed, then approved (gate off) or sent to its
// approvers (gate on).
function makeOrder(header, group, result) {
    const {part, facility, items} = group
    const supplierPartyId = facility.ownerPartyId,
        organizationPartyId = part.vendorPartyId
    const orderId = call("create#" + ORDER, {
        parentOrderId: header.orderId,
        orderName: "Drop-ship for order " + header.orderId,
        entryDate: now(),
        statusId: "OrderOpen",
        currencyUomId: header.currencyUomId,
        orderRevision: 1
    }).orderId
    const orderPartSeqId = "01"
    call("create#" + PART, {
        orderId,
        orderPartSeqId,
        statusId: "OrderOpen",
        vendorPartyId: supplierPartyId,
        customerPartyId: organizationPartyId,
        facilityId: facility.facilityId,
        postalContactMechId: part.postalContactMechId,
        telecomContactMechId: part.telecomContactMechId,
        carrierPartyId: part.carrierPartyId,
        shipmentMethodEnumId: part.shipmentMethodEnumId,
        shippingInstructions: part.shippingInstructions
    })
    const shipTo =
        rows("mantle.order.OrderPartParty", {
            orderId: header.orderId,
            orderPartSeqId: part.orderPartSeqId,
            roleTypeId: "CustomerShipTo"
        })[0]?.partyId || part.customerPartyId
    if (shipTo)
        call("create#mantle.order.OrderPartParty", {orderId, orderPartSeqId, partyId: shipTo, roleTypeId: "CustomerShipTo"})
    // the sales part's ship-to contact (shipping purposes only: the customer's billing stays with the sales order)
    for (const contact of rows("mantle.order.OrderPartContactMech", {
        orderId: header.orderId,
        orderPartSeqId: part.orderPartSeqId
    }))
        if (/Ship/.test(contact.contactMechPurposeId || ""))
            call("create#mantle.order.OrderPartContactMech", Object.assign(lib.map(contact), {orderId, orderPartSeqId}))
    const seqOf = {}
    items.forEach((item, index) => {
        const orderItemSeqId = String(index + 1).padStart(2, "0")
        seqOf[item.orderItemSeqId] = orderItemSeqId
        const quantity = openQuantity(item)
        const price = supplierPrice(supplierPartyId, organizationPartyId, item.productId, quantity, header.currencyUomId)
        if (!price) result.unpricedItems.push({orderItemSeqId: item.orderItemSeqId, productId: item.productId})
        call("create#" + ITEM, {
            orderId,
            orderItemSeqId,
            orderPartSeqId,
            itemTypeEnumId: item.itemTypeEnumId,
            productId: item.productId,
            itemDescription: item.itemDescription,
            quantity,
            quantityUomId: item.quantityUomId,
            unitAmount: price ? price.price : 0,
            productPriceId: price?.productPriceId || null,
            otherPartyProductId: price?.otherPartyItemId || null,
            isModifiedPrice: "N",
            requiredByDate: item.requiredByDate,
            salesOrderId: header.orderId,
            salesOrderItemSeqId: item.orderItemSeqId
        })
    })
    // the branch's copies: the lines' content and work efforts, and the order's notes that are not internal
    const salesSeqs = items.map(item => item.orderItemSeqId)
    for (const content of Array.from(
        find("mantle.order.OrderContent").condition("orderId", header.orderId).condition("orderItemSeqId", "in", salesSeqs).list()
    ))
        call(
            "create#mantle.order.OrderContent",
            Object.assign(lib.map(content), {orderContentId: null, orderId, orderItemSeqId: seqOf[content.orderItemSeqId]})
        )
    for (const effort of Array.from(
        find("mantle.order.OrderItemWorkEffort")
            .condition("orderId", header.orderId)
            .condition("orderItemSeqId", "in", salesSeqs)
            .list()
    ))
        call(
            "create#mantle.order.OrderItemWorkEffort",
            Object.assign(lib.map(effort), {orderId, orderItemSeqId: seqOf[effort.orderItemSeqId]})
        )
    for (const note of rows("mantle.order.OrderNote", {orderId: header.orderId}).filter(note => note.internalNote !== "Y"))
        call("create#mantle.order.OrderNote", Object.assign(lib.map(note), {orderId}))
    call("mantle.order.OrderServices.update#OrderPartTotal", {orderId, orderPartSeqId})
    call("mantle.order.OrderServices.place#Order", {orderId})
    const partRow = one(PART, {orderId, orderPartSeqId})
    if (policy.effective(organizationPartyId).policy.approvalGateEnabled === "Y") {
        // F40: with the gate on the order waits at Placed for decide#PurchaseApproval; its first step's approvers are told
        approvals().notify(approvals().orderSource({orderId, part: partRow, organizationPartyId, supplierPartyId}))
    } else {
        call("mantle.order.OrderServices.update#OrderStatus", {orderId, statusId: "OrderApproved", approvedDate: now()})
    }
    return {orderId}
}

// ===== send#DropShipPurchaseOrder =====
// An approved drop-ship purchase order to its supplier, run once the approval commits: the drop-ship facility's remote's
// send service (send#DropShipPurchaseOrderPart) when the facility names one, else by email to the supplier's order address
// (send#PurchaseOrder's path). A send that fails is logged and the order stays approved for the buyer to send; no
// permission check (the approver's or the sales approver's commit runs it).
function send(p) {
    const orderId = text(p.orderId)
    const order = orderId ? one(ORDER, {orderId}) : null
    if (!order?.parentOrderId || order.statusId !== "OrderApproved") return {sent: false}
    const part = rows(PART, {orderId}).find(row => orders().isPurchasePart(row))
    if (!part || !rows(ITEM, {orderId}).some(item => item.salesOrderId)) return {sent: false}
    const facility = dropShipFacility(part.facilityId)
    if (facility?.dropShipRemoteId) {
        const remote = one("moqui.service.message.SystemMessageRemote", {systemMessageRemoteId: facility.dropShipRemoteId})
        if (!remote?.sendServiceName) {
            ec.logger.warn(
                "Drop-ship purchase order " + orderId + " not sent: remote " + facility.dropShipRemoteId + " has no send service"
            )
            return {sent: false, reasonCode: "REMOTE_INVALID"}
        }
        ec.message.pushErrors()
        try {
            ec.service
                .sync()
                .name(remote.sendServiceName)
                .parameters({orderId, orderPartSeqId: part.orderPartSeqId, facilityId: facility.facilityId})
                .disableAuthz()
                .call()
            if (ec.message.hasError()) throw new Error(ec.message.getErrorsString())
        } catch (error) {
            ec.logger.error(
                "Drop-ship purchase order " + orderId + " was not sent to " + remote.systemMessageRemoteId + ": " + error.message
            )
            return {sent: false, reasonCode: "REMOTE_FAILED"}
        } finally {
            ec.message.clearErrors()
            ec.message.popErrors()
        }
        call("mantle.order.OrderServices.update#OrderStatus", {orderId, statusId: "OrderSent"})
        return {sent: true, channel: "remote"}
    }
    try {
        const out = documents().issue(orderId, {operationKey: "DS-" + orderId + "-" + ec.user.randomString(16)})
        return {sent: out.successCount > 0, channel: "email"}
    } catch (error) {
        ec.message.clearErrors()
        ec.logger.error("Drop-ship purchase order " + orderId + " was not emailed: " + error.message)
        return {sent: false, reasonCode: lib.reasonCode(error) || "SEND_FAILED"}
    }
}

// ===== finalize#DropShipPurchaseOrder =====
// What each drop-ship line of a purchase order has been delivered: its sources on the order's shipped purchase shipments.
function deliveredOf(orderId) {
    const sources = Array.from(find("mantle.shipment.ShipmentAndItemSource").condition("orderId", orderId).list()).filter(
        row => row.shipmentTypeEnumId === "ShpTpPurchase" && shippedStatuses.includes(row.shipmentStatusId)
    )
    const delivered = {}
    for (const row of sources) delivered[row.orderItemSeqId] = (delivered[row.orderItemSeqId] || zero()).add(dec(row.quantity))
    return {delivered, shipmentIds: unique(sources.map(row => row.shipmentId))}
}
// The quantity of each line the confirmation names: by line (itemQuantityList), or by product as the branch's integrations
// call it (productQuantityList; a product on two lines is refused), else what is left of every line.
function confirmedQuantities(lines, remaining, p) {
    const byLine = {}
    const given = Array.from(p.itemQuantityList || [])
    const byProduct = Array.from(p.productQuantityList || [])
    for (const row of given) {
        const line = lines.find(item => item.orderItemSeqId === String(row.orderItemSeqId))
        if (!line) denied("ITEM_UNAVAILABLE", "Line " + row.orderItemSeqId + " is not a drop-ship line of the order")
        byLine[line.orderItemSeqId] =
            row.quantity == null || row.quantity === "" ? remaining[line.orderItemSeqId] : dec(row.quantity)
    }
    for (const row of byProduct) {
        const matches = lines.filter(item => item.productId === String(row.productId))
        if (!matches.length) denied("ITEM_UNAVAILABLE", "Product " + row.productId + " is not on the order")
        if (matches.length > 1)
            denied("PRODUCT_AMBIGUOUS", "Product " + row.productId + " is on more than one line; confirm by line")
        const line = matches[0]
        byLine[line.orderItemSeqId] =
            row.quantity == null || row.quantity === "" ? remaining[line.orderItemSeqId] : dec(row.quantity)
    }
    if (!given.length && !byProduct.length) for (const line of lines) byLine[line.orderItemSeqId] = remaining[line.orderItemSeqId]
    for (const [seq, quantity] of Object.entries(byLine)) {
        if (quantity.compare(0) < 0) denied("QUANTITY_INVALID", "Enter a quantity of zero or more for line " + seq)
        if (quantity.compare(remaining[seq]) > 0)
            denied(
                "QUANTITY_EXCESS",
                "Line " + seq + " has " + quantityText(remaining[seq]) + " left to deliver, not " + quantityText(quantity)
            )
    }
    return byLine
}
// The purchase order's own delivery: a ShpTpPurchase shipment from the supplier's drop-ship facility to the customer's
// address, with the confirmed lines and the tracking code, shipped (never received).
function deliveryShipment(po, confirmed, lines, p) {
    const part = po.part
    const shipDate = p.shipDate || now()
    const shipmentId = call("create#mantle.shipment.Shipment", {
        shipmentTypeEnumId: "ShpTpPurchase",
        statusId: "ShipInput",
        fromPartyId: po.supplierPartyId,
        toPartyId: po.organizationPartyId,
        entryDate: now(),
        costUomId: po.order.currencyUomId,
        otherPartyOrderId: part.otherPartyOrderId,
        handlingInstructions: "Drop-ship delivery of purchase order " + po.orderId
    }).shipmentId
    call("create#mantle.shipment.ShipmentRouteSegment", {
        shipmentId,
        shipmentRouteSegmentSeqId: "01",
        originFacilityId: part.facilityId,
        destPostalContactMechId: part.postalContactMechId,
        destTelecomContactMechId: part.telecomContactMechId,
        carrierPartyId: text(p.carrierPartyId) || part.carrierPartyId,
        shipmentMethodEnumId: part.shipmentMethodEnumId
    })
    const packageSeqId = call("mantle.shipment.ShipmentServices.create#ShipmentPackage", {shipmentId}).shipmentPackageSeqId
    if (text(p.trackingCode))
        call("mantle.shipment.ShipmentServices.update#ShipmentPackageAndRouteSeg", {
            shipmentId,
            shipmentPackageSeqId: packageSeqId,
            trackingCode: text(p.trackingCode)
        })
    const byProduct = {}
    for (const line of lines) {
        const quantity = confirmed[line.orderItemSeqId]
        if (quantity && !quantity.isZero()) byProduct[line.productId] = (byProduct[line.productId] || zero()).add(quantity)
    }
    for (const [productId, quantity] of Object.entries(byProduct)) {
        call("create#mantle.shipment.ShipmentItem", {shipmentId, productId, quantity})
        call("create#mantle.shipment.ShipmentPackageContent", {
            shipmentId,
            shipmentPackageSeqId: packageSeqId,
            productId,
            quantity
        })
    }
    for (const line of lines) {
        const quantity = confirmed[line.orderItemSeqId]
        if (!quantity || quantity.isZero()) continue
        call("create#" + SIS, {
            shipmentId,
            productId: line.productId,
            orderId: po.orderId,
            orderItemSeqId: line.orderItemSeqId,
            quantity,
            quantityNotHandled: 0,
            statusId: "SisPacked"
        })
    }
    call("mantle.shipment.ShipmentServices.ship#Shipment", {shipmentId, actualStartDate: shipDate})
    return shipmentId
}
// The sales shipments of the delivered lines: per sales part an open shipment of its lines or a new one, each line packed
// at its confirmed quantity (issuing its reservation at the drop-ship facility), the tracking code on its package, then
// packed (Mantle's pack rule invoices the customer) and shipped.
function salesShipments(po, confirmed, lines, p) {
    const salesOrderId = po.order.parentOrderId
    const shipDate = p.shipDate || now()
    const salesItems = byId(
        Array.from(
            find(ITEM)
                .condition("orderId", salesOrderId)
                .condition("orderItemSeqId", "in", unique(lines.map(line => line.salesOrderItemSeqId)))
                .list()
        ),
        "orderItemSeqId"
    )
    const byPart = new Map()
    for (const line of lines) {
        const quantity = confirmed[line.orderItemSeqId]
        const salesItem = salesItems[line.salesOrderItemSeqId]
        if (!quantity || quantity.isZero() || !salesItem) continue
        if (!byPart.has(salesItem.orderPartSeqId)) byPart.set(salesItem.orderPartSeqId, [])
        byPart.get(salesItem.orderPartSeqId).push({salesItem, quantity})
    }
    const shipmentIds = []
    for (const [orderPartSeqId, entries] of byPart) {
        const seqs = entries.map(entry => entry.salesItem.orderItemSeqId)
        const open = Array.from(
            find("mantle.shipment.ShipmentAndItemSource")
                .condition("orderId", salesOrderId)
                .condition("orderItemSeqId", "in", seqs)
                .condition("shipmentStatusId", "in", ["ShipInput", "ShipScheduled", "ShipPicked"])
                .condition("statusId", "not-equals", "SisCancelled")
                .list()
        )
        let shipmentId = open[0]?.shipmentId || null
        if (!shipmentId)
            shipmentId =
                call("mantle.shipment.ShipmentServices.create#OrderPartShipment", {orderId: salesOrderId, orderPartSeqId})
                    .shipmentId || null
        if (!shipmentId)
            denied("SALES_SHIPMENT", "Order " + salesOrderId + " part " + orderPartSeqId + " has nothing left to ship")
        const packageSeqId = call("mantle.shipment.ShipmentServices.create#ShipmentPackage", {shipmentId}).shipmentPackageSeqId
        for (const entry of entries) {
            const source = Array.from(
                find(SIS)
                    .condition({shipmentId, orderId: salesOrderId, orderItemSeqId: entry.salesItem.orderItemSeqId})
                    .condition("statusId", "not-equals", "SisCancelled")
                    .list()
            )[0]
            if (!source)
                denied(
                    "SALES_SHIPMENT",
                    "Line " + entry.salesItem.orderItemSeqId + " of order " + salesOrderId + " is not on " + shipmentId
                )
            call("mantle.shipment.ShipmentServices.pack#ShipmentItemSource", {
                shipmentItemSourceId: source.shipmentItemSourceId,
                quantity: entry.quantity,
                shipmentPackageSeqId: packageSeqId,
                packDate: shipDate
            })
        }
        if (text(p.trackingCode))
            call("mantle.shipment.ShipmentServices.update#ShipmentPackageAndRouteSeg", {
                shipmentId,
                shipmentPackageSeqId: packageSeqId,
                trackingCode: text(p.trackingCode)
            })
        call("mantle.shipment.ShipmentServices.pack#Shipment", {shipmentId, packedDate: shipDate})
        call("mantle.shipment.ShipmentServices.ship#Shipment", {shipmentId, actualStartDate: shipDate})
        shipmentIds.push(shipmentId)
    }
    return shipmentIds
}
// F39: the delivered lines' cost moved from Unreceived Inventory (where the supplier's bill debits it, as for any purchase
// of stock) to the cost of goods sold, as a receipt would move it to Inventory and the sale's issuance on to the cost of
// goods sold: the shell asset issued to the customer has no cost, so its issuance posts nothing. One transaction per
// delivery, at the order's prices, for an organization with an accounting preference; a missing account puts it in the
// organization's error journal.
function postDeliveryCost(po, shipmentId, confirmed, lines, shipDate) {
    const organizationPartyId = po.organizationPartyId
    const preference = call("mantle.ledger.LedgerServices.find#PartyAcctgPreference", {organizationPartyId}).partyAcctgPreference
    if (!preference) return null
    const currencyUomId = po.order.currencyUomId
    const amounts = lines
        .map(line => ({
            line,
            amount: ec.l10n.roundCurrency(dec(confirmed[line.orderItemSeqId]).multiply(dec(line.unitAmount)), currencyUomId)
        }))
        .filter(row => !row.amount.isZero())
    if (!amounts.length) return null
    const account = glAccountTypeEnumId =>
        call("mantle.ledger.LedgerServices.get#DefaultGlAccountByType", {
            glAccountTypeEnumId,
            acctgTransTypeEnumId: "AttDropShipDelivery",
            organizationPartyId,
            otherPartyId: null
        }).glAccountId || null
    const cogsGlAccountId = account("GatCogs"),
        unreceivedGlAccountId = account("GatUnreceivedInventory")
    const acctgTransId = call("mantle.ledger.LedgerServices.create#AcctgTrans", {
        acctgTransTypeEnumId: "AttDropShipDelivery",
        organizationPartyId,
        otherPartyId: po.supplierPartyId,
        amountUomId: currencyUomId,
        shipmentId,
        transactionDate: shipDate,
        description: "Drop-ship delivery of purchase order " + po.orderId
    }).acctgTransId
    for (const {line, amount} of amounts) {
        call("mantle.ledger.LedgerServices.create#AcctgTransEntry", {
            acctgTransId,
            debitCreditFlag: "C",
            glAccountTypeEnumId: "GatUnreceivedInventory",
            glAccountId: unreceivedGlAccountId,
            amount,
            productId: line.productId,
            description: "Order line " + po.orderId + ":" + line.orderItemSeqId
        })
        call("mantle.ledger.LedgerServices.create#AcctgTransEntry", {
            acctgTransId,
            debitCreditFlag: "D",
            glAccountTypeEnumId: "GatCogs",
            glAccountId: cogsGlAccountId,
            amount,
            productId: line.productId,
            description: "Order line " + po.orderId + ":" + line.orderItemSeqId
        })
    }
    if (cogsGlAccountId && unreceivedGlAccountId)
        call("mantle.ledger.LedgerServices.post#AcctgTrans", {acctgTransId, reviewed: true})
    else if (preference.errorGlJournalId)
        call("update#mantle.ledger.transaction.AcctgTrans", {acctgTransId, glJournalId: preference.errorGlJournalId})
    return acctgTransId
}
// finalize#DropShipPurchaseOrder: the supplier's confirmation of a drop-ship purchase order (the confirmed quantities, the
// tracking code), from its integration or the buyer, under PURCHASE_ORDER_EDIT in the buying organization. Refuses an order
// that is not a drop-ship order (NOT_DROP_SHIP), not approved or sent (ORDER_NOT_APPROVED), a line or product it does not
// have (ITEM_UNAVAILABLE, PRODUCT_AMBIGUOUS) and more than is left (QUANTITY_EXCESS); an order delivered in full answers
// what was delivered and changes nothing (alreadyApplied).
function finalize(p) {
    orders().requirePermission("PURCHASE_ORDER_EDIT")
    const po = orders().purchaseOrder(text(p.purchaseOrderId) || text(p.orderId), true)
    const lines = rows(ITEM, {orderId: po.orderId})
        .filter(item => item.salesOrderId)
        .sort((a, b) => a.orderItemSeqId.localeCompare(b.orderItemSeqId))
    if (!lines.length || !po.order.parentOrderId)
        denied("NOT_DROP_SHIP", "Purchase order " + po.orderId + " is not a drop-ship order")
    const before = deliveredOf(po.orderId)
    const remaining = {}
    for (const line of lines) {
        const left = openQuantity(line).subtract(before.delivered[line.orderItemSeqId] || zero())
        remaining[line.orderItemSeqId] = left.compare(0) > 0 ? left : zero()
    }
    const answer = extra => {
        const delivered = deliveredOf(po.orderId).delivered
        return Object.assign(
            {
                purchaseOrderId: po.orderId,
                salesOrderId: po.order.parentOrderId,
                statusId: one(ORDER, {orderId: po.orderId}).statusId,
                deliveredItems: lines.map(line => ({
                    orderItemSeqId: line.orderItemSeqId,
                    salesOrderItemSeqId: line.salesOrderItemSeqId,
                    productId: line.productId,
                    deliveredQuantity: delivered[line.orderItemSeqId] || zero()
                }))
            },
            extra
        )
    }
    if (Object.values(remaining).every(left => left.isZero()))
        return answer({shipmentId: before.shipmentIds[0] || null, salesShipmentIds: [], alreadyApplied: true})
    if (!deliverStatuses.includes(po.order.statusId))
        denied("ORDER_NOT_APPROVED", "Purchase order " + po.orderId + " is confirmed once it is approved")
    const confirmed = confirmedQuantities(lines, remaining, p)
    if (Object.values(confirmed).every(quantity => quantity.isZero()))
        denied("QUANTITY_INVALID", "Confirm a quantity delivered on at least one line")
    const shipDate = p.shipDate || now()
    const shipmentId = deliveryShipment(po, confirmed, lines, p)
    const salesShipmentIds = salesShipments(po, confirmed, lines, p)
    const acctgTransId = postDeliveryCost(po, shipmentId, confirmed, lines, shipDate)
    const after = deliveredOf(po.orderId).delivered
    if (lines.every(line => openQuantity(line).compare(after[line.orderItemSeqId] || zero()) <= 0))
        call("mantle.order.OrderServices.update#OrderStatus", {
            orderId: po.orderId,
            statusId: "OrderCompleted",
            completedDate: now()
        })
    return answer({shipmentId, salesShipmentIds, acctgTransId, alreadyApplied: false})
}

// ===== route#OrderItemToDropShip =====
// "Drop-ship from supplier": a customer order line moved to a supplier's drop-ship facility, under PURCHASE_ORDER_EDIT in the
// selling organization, for a supplier whose current price of the product is marked canDropShip (NOT_DROP_SHIPPABLE) and
// which has a drop-ship facility (NO_DROP_SHIP_FACILITY), not stopped by the buying policy. The line moves to the order's
// part at that facility (its part itself when it is the part's only line, else a new part with its customer, ship-to and
// shipping), its reservation is made again there, and an approved order's purchase order is made at once. Refuses a line
// already shipped (LINE_SHIPPED) or on a drop-ship purchase order (ALREADY_DROP_SHIPPED), and an order not open for it
// (ORDER_STATE).
function route(p) {
    orders().requirePermission("PURCHASE_ORDER_EDIT")
    const orderId = text(p.orderId)
    const header = orderId ? find(ORDER, {orderId}).forUpdate(true).one() : null
    const item = header ? one(ITEM, {orderId, orderItemSeqId: text(p.orderItemSeqId)}) : null
    const part = item ? one(PART, {orderId, orderPartSeqId: item.orderPartSeqId}) : null
    if (!part || !isInternal(part.vendorPartyId) || !facilityScope.owns(facilityScope.scope(), part.vendorPartyId))
        denied("RECORD_UNAVAILABLE", "Order line " + (orderId || "") + ":" + (p.orderItemSeqId || "") + " is not available")
    if (!isProductLine(item)) denied("ITEM_UNAVAILABLE", "Line " + item.orderItemSeqId + " is not a product line")
    if (!routeStatuses.includes(header.statusId))
        denied("ORDER_STATE", "Order " + orderId + " is " + statusText(header.statusId) + "; its lines no longer move")
    if (linkedLines(orderId).has(item.orderItemSeqId))
        denied("ALREADY_DROP_SHIPPED", "Line " + item.orderItemSeqId + " is already on a drop-ship purchase order")
    const issued = Array.from(
        find("mantle.product.issuance.AssetIssuance").condition({orderId, orderItemSeqId: item.orderItemSeqId}).list()
    )
    const onShipment = Array.from(
        find("mantle.shipment.ShipmentAndItemSource")
            .condition({orderId, orderItemSeqId: item.orderItemSeqId})
            .condition("shipmentStatusId", "not-in", ["ShipRejected", "ShipCancelled"])
            .condition("statusId", "not-equals", "SisCancelled")
            .list()
    )
    if (issued.length || onShipment.length)
        denied("LINE_SHIPPED", "Line " + item.orderItemSeqId + " is already on a shipment; it ships from the warehouse")
    const organizationPartyId = part.vendorPartyId
    const supplierPartyId = text(p.supplierPartyId)
    const supplier = supplierPartyId ? one("mantle.party.Party", {partyId: supplierPartyId}) : null
    if (
        !supplier ||
        isInternal(supplierPartyId) ||
        (supplier.ownerPartyId && !["_NA_", organizationPartyId].includes(supplier.ownerPartyId))
    )
        denied("SUPPLIER_UNAVAILABLE", "Choose an available supplier")
    if (!supplierPrice(supplierPartyId, organizationPartyId, item.productId, openQuantity(item), header.currencyUomId, true))
        denied("NOT_DROP_SHIPPABLE", partyName(supplierPartyId) + " has no current drop-ship price for " + item.productId)
    const facilities = dropShipFacilitiesOf(supplierPartyId)
    const facility = text(p.facilityId) ? facilities.find(row => row.facilityId === text(p.facilityId)) : facilities[0]
    if (!facility) denied("NO_DROP_SHIP_FACILITY", partyName(supplierPartyId) + " has no drop-ship facility")
    const checked = policy.supplierUsable(organizationPartyId, supplierPartyId)
    if (checked.result === "STOP") denied(checked.reasonCode, checked.message)
    if (checked.result === "WARN") ec.message.addMessage(checked.message, "warning")

    const partLines = rows(ITEM, {orderId, orderPartSeqId: part.orderPartSeqId}).filter(row => !row.parentItemSeqId)
    let targetSeqId = part.orderPartSeqId
    if (part.facilityId !== facility.facilityId) {
        if (partLines.length === 1) {
            call("update#" + PART, {orderId, orderPartSeqId: part.orderPartSeqId, facilityId: facility.facilityId})
        } else {
            const sibling = rows(PART, {orderId}).find(
                row =>
                    row.facilityId === facility.facilityId &&
                    row.vendorPartyId === part.vendorPartyId &&
                    row.customerPartyId === part.customerPartyId &&
                    row.statusId === part.statusId
            )
            targetSeqId = sibling ? sibling.orderPartSeqId : newPart(header, part, facility)
            call("update#" + ITEM, {orderId, orderItemSeqId: item.orderItemSeqId, orderPartSeqId: targetSeqId})
            call("mantle.order.OrderServices.update#OrderPartTotal", {orderId, orderPartSeqId: part.orderPartSeqId})
            call("mantle.order.OrderServices.update#OrderPartTotal", {orderId, orderPartSeqId: targetSeqId})
        }
    }
    // the reservation made again at the drop-ship facility (its stock, else Mantle's shell asset)
    call("mantle.product.AssetServices.remove#OrderItemReservations", {orderId, orderItemSeqId: item.orderItemSeqId})
    call("mantle.product.AssetServices.reserve#AssetForOrderItem", {
        orderId,
        orderItemSeqId: item.orderItemSeqId,
        forceReserve: true
    })
    const result = {orderId, orderItemSeqId: item.orderItemSeqId, orderPartSeqId: targetSeqId, facilityId: facility.facilityId}
    if (["OrderApproved", "OrderSent", "OrderProcessing"].includes(header.statusId)) {
        const made = create({salesOrderId: orderId})
        result.purchaseOrderIds = made.purchaseOrderIds
        result.skippedItems = made.skippedItems
    } else {
        result.purchaseOrderIds = []
        result.skippedItems = []
    }
    return result
}
// A new part of the sales order at the drop-ship facility, with the part's customer, ship-to, shipping and status.
function newPart(header, part, facility) {
    const existing = rows(PART, {orderId: header.orderId}).map(row => Number(row.orderPartSeqId) || 0)
    const orderPartSeqId = String(Math.max(0, ...existing) + 1).padStart(2, "0")
    const values = Object.assign(lib.map(part), {
        orderPartSeqId,
        facilityId: facility.facilityId,
        partTotal: 0,
        lastUpdatedStamp: null
    })
    call("create#" + PART, values)
    for (const party of rows("mantle.order.OrderPartParty", {orderId: header.orderId, orderPartSeqId: part.orderPartSeqId}))
        call("create#mantle.order.OrderPartParty", Object.assign(lib.map(party), {orderPartSeqId, lastUpdatedStamp: null}))
    for (const contact of rows("mantle.order.OrderPartContactMech", {
        orderId: header.orderId,
        orderPartSeqId: part.orderPartSeqId
    }))
        call(
            "create#mantle.order.OrderPartContactMech",
            Object.assign(lib.map(contact), {orderPartSeqId, lastUpdatedStamp: null})
        )
    return orderPartSeqId
}

// ===== reads =====
// A postal address as one line.
function addressText(contactMechId) {
    const address = blank(contactMechId) ? null : one("mantle.party.contact.PostalAddress", {contactMechId})
    if (!address) return ""
    const geo = geoId => (geoId ? one("moqui.basic.Geo", {geoId})?.geoCodeAlpha2 || geoId : "")
    return [
        address.address1,
        address.address2,
        [address.city, geo(address.stateProvinceGeoId), address.postalCode].filter(Boolean).join(" "),
        geo(address.countryGeoId)
    ]
        .filter(Boolean)
        .join(", ")
}
// The drop-ship ship-to of a purchase order (the customer and the address its supplier ships to), or null for an order that
// is not a drop-ship order: the print shows it in place of the buyer's receiving facility.
function shipToOf(po) {
    if (!po.order.parentOrderId || !rows(ITEM, {orderId: po.orderId}).some(item => item.salesOrderId)) return null
    const party = rows("mantle.order.OrderPartParty", {
        orderId: po.orderId,
        orderPartSeqId: po.part.orderPartSeqId,
        roleTypeId: "CustomerShipTo"
    })[0]
    const address = po.part.postalContactMechId
        ? one("mantle.party.contact.PostalAddress", {contactMechId: po.part.postalContactMechId})
        : null
    const name = address?.toName || (party ? partyName(party.partyId) : "")
    return {shipToName: name, shipToAddress: addressText(po.part.postalContactMechId), customerPartyId: party?.partyId || null}
}
// The quantity a drop-ship purchase order line has been delivered (for the bill's match: the delivery is its evidence, as a
// receipt is for a line received), or null for a line that is not a drop-ship line.
function deliveredQuantity(item) {
    if (!item?.salesOrderId) return null
    return deliveredOf(item.orderId).delivered[item.orderItemSeqId] || zero()
}
const stateColors = {warehouse: "grey-8", pending: "warning", ordered: "primary", delivered: "positive", skipped: "negative"}
// get#OrderDropShip: an order's drop-ship state for a purchasing user (PURCHASE_ORDER_EDIT, PURCHASE_APPROVE or
// PURCHASE_ORDER_APPROVE) of its organization. A customer order: each product line's facility, its drop-ship purchase order
// and state, and, for a buyer, the suppliers it may drop from (a canDropShip price and a drop-ship facility). A drop-ship
// purchase order: its customer and ship-to, the parent order and each line's delivered and remaining quantity. Answers
// kind null for anything else, or a user who may not read it.
function orderView(p) {
    const none = {kind: null, lines: []}
    const orderId = text(p.orderId)
    const header = orderId ? one(ORDER, {orderId}) : null
    if (!header || !readPermissions.some(permission => access.has(permission))) return none
    const userScope = facilityScope.scope()
    const parts = rows(PART, {orderId})
    const purchasePart = parts.length === 1 && orders().isPurchasePart(parts[0]) ? parts[0] : null
    const canBuy = access.has("PURCHASE_ORDER_EDIT")
    if (purchasePart) {
        if (!facilityScope.owns(userScope, purchasePart.customerPartyId)) return none
        const lines = rows(ITEM, {orderId})
            .filter(item => item.salesOrderId)
            .sort((a, b) => a.orderItemSeqId.localeCompare(b.orderItemSeqId))
        if (!lines.length || !header.parentOrderId) return none
        const shipTo = shipToOf({orderId, order: header, part: purchasePart})
        const {delivered, shipmentIds} = deliveredOf(orderId)
        const trackingCodes = shipmentIds.length
            ? unique(
                  Array.from(
                      find("mantle.shipment.ShipmentPackageRouteSeg").condition("shipmentId", "in", shipmentIds).list()
                  ).map(row => row.trackingCode)
              )
            : []
        const lineRows = lines.map(line => {
            const done = delivered[line.orderItemSeqId] || zero()
            const left = openQuantity(line).subtract(done)
            return {
                orderItemSeqId: line.orderItemSeqId,
                salesOrderItemSeqId: line.salesOrderItemSeqId,
                productId: line.productId,
                productName: productName(line.productId),
                orderedText: quantityText(openQuantity(line)),
                deliveredText: quantityText(done),
                remainingText: quantityText(left.compare(0) > 0 ? left : 0),
                remaining: left.compare(0) > 0 ? quantityText(left) : "0"
            }
        })
        const pending = lineRows.some(row => row.remaining !== "0") && deliverStatuses.includes(header.statusId)
        return {
            kind: "purchase",
            orderId,
            salesOrderId: header.parentOrderId,
            customerName: shipTo?.customerPartyId ? partyName(shipTo.customerPartyId) : shipTo?.shipToName || "",
            shipToName: shipTo?.shipToName || "",
            shipToAddress: shipTo?.shipToAddress || "",
            facilityName: facilityName(purchasePart.facilityId),
            pending,
            canConfirm: pending && canBuy,
            stateText: pending
                ? "Waiting for the supplier's delivery"
                : lineRows.every(row => row.remaining === "0")
                  ? "Delivered"
                  : statusText(header.statusId),
            trackingText: trackingCodes.join(", "),
            deliveryShipmentIds: shipmentIds,
            lines: lineRows
        }
    }
    const salesParts = parts.filter(part => isInternal(part.vendorPartyId) && !isInternal(part.customerPartyId))
    if (!salesParts.length || !salesParts.some(part => facilityScope.owns(userScope, part.vendorPartyId))) return none
    const partOf = byId(salesParts, "orderPartSeqId")
    const items = rows(ITEM, {orderId})
        .filter(item => partOf[item.orderPartSeqId] && isProductLine(item))
        .sort((a, b) => a.orderItemSeqId.localeCompare(b.orderItemSeqId))
    if (!items.length) return none
    const linked = linkedLines(orderId)
    const reservations = rows(RESERVATION, {orderId})
    const assets = byId(
        reservations.length
            ? find("mantle.product.asset.Asset")
                  .condition("assetId", "in", unique(reservations.map(row => row.assetId)))
                  .list()
            : [],
        "assetId"
    )
    const canRoute = canBuy && routeStatuses.includes(header.statusId)
    const lineRows = items.map(item => {
        const part = partOf[item.orderPartSeqId]
        const resFacilityIds = unique(
            reservations.filter(row => row.orderItemSeqId === item.orderItemSeqId).map(row => assets[row.assetId]?.facilityId)
        )
        const facilityId = resFacilityIds[0] || part.facilityId
        const drop = dropShipFacility(facilityId)
        const link = linked.get(item.orderItemSeqId)
        const deliveredQty = link ? deliveredOf(link.orderId).delivered[link.orderItemSeqId] || zero() : zero()
        const state = link
            ? deliveredQty.compare(openQuantity(link)) >= 0
                ? "delivered"
                : "ordered"
            : drop
              ? "pending"
              : "warehouse"
        const stateTexts = {
            warehouse: "Ships from " + (facilityName(facilityId) || "the warehouse"),
            pending: "Drops from " + partyName(drop?.ownerPartyId) + " when the order is approved",
            ordered: "Drop-ship on purchase order " + link?.orderId + " · " + statusText(link?.statusId),
            delivered:
                "Delivered by " +
                partyName(link ? one(PART, {orderId: link.orderId, orderPartSeqId: link.orderPartSeqId})?.vendorPartyId : null)
        }
        const routable = canRoute && !link && !drop
        return {
            orderItemSeqId: item.orderItemSeqId,
            productId: item.productId,
            productName: productName(item.productId),
            quantityText: quantityText(openQuantity(item)),
            state,
            stateText: stateTexts[state],
            stateColor: stateColors[state],
            purchaseOrderId: link?.orderId || null,
            supplierOptions: routable ? dropShipSuppliers(item, part.vendorPartyId, header.currencyUomId) : []
        }
    })
    if (!lineRows.some(row => row.state !== "warehouse" || row.supplierOptions.length)) return none
    return {kind: "sales", orderId, canRoute, lines: lineRows}
}
function productName(productId) {
    const product = productId ? one("mantle.product.Product", {productId}) : null
    return product ? [product.pseudoId || product.productId, product.productName].filter(Boolean).join(" · ") : productId || ""
}
function facilityName(facilityId) {
    const facility = facilityId ? one(FACILITY, {facilityId}) : null
    return facility ? facility.facilityName || facility.facilityId : ""
}
// The suppliers a line may drop from: a current canDropShip purchase price of the product (any quantity), a drop-ship
// facility, and a supplier the organization may buy from (its own or shared).
function dropShipSuppliers(item, organizationPartyId, currencyUomId) {
    const supplierIds = unique(
        rows("mantle.product.ProductPrice", {
            productId: item.productId,
            pricePurposeEnumId: "PppPurchase",
            canDropShip: "Y"
        })
            .filter(
                row =>
                    lib.active(row) &&
                    row.vendorPartyId &&
                    (!row.priceUomId || !currencyUomId || row.priceUomId === currencyUomId)
            )
            .map(row => row.vendorPartyId)
    )
    return supplierIds
        .filter(partyId => {
            const party = one("mantle.party.Party", {partyId})
            return (
                party &&
                !isInternal(partyId) &&
                (!party.ownerPartyId || ["_NA_", organizationPartyId].includes(party.ownerPartyId)) &&
                dropShipFacilitiesOf(partyId).length > 0
            )
        })
        .map(partyId => ({supplierPartyId: partyId, supplierName: partyName(partyId)}))
}

// ===== the drop-ship setup =====
// store#DropShipFacility: a supplier's drop-ship facility (new, or its name and remote changed) under PURCHASE_POLICY_EDIT in
// one of the user's organizations, for a supplier the organization may buy from: type FcTpDropShip, owned by the supplier,
// assetAllowOtherOwner Y (the reservation takes the supplier's stock) and assetAllowIssueOverQoh Y (the sales shipment issues
// the shell asset, which holds nothing). The remote is a SystemMessageRemote (REMOTE_INVALID), empty to email the orders.
function storeFacility(p) {
    orders().requirePermission("PURCHASE_POLICY_EDIT")
    const organizationPartyId = text(p.organizationPartyId)
    const userScope = facilityScope.scope()
    if (!organizationPartyId || !isInternal(organizationPartyId) || !facilityScope.owns(userScope, organizationPartyId))
        denied("RECORD_UNAVAILABLE", "Organization " + (organizationPartyId || "") + " is not available")
    const supplierPartyId = text(p.supplierPartyId)
    orders().supplierOf(organizationPartyId, supplierPartyId)
    const remoteId = text(p.dropShipRemoteId)
    if (remoteId && !one("moqui.service.message.SystemMessageRemote", {systemMessageRemoteId: remoteId}))
        denied("REMOTE_INVALID", "Choose a system message remote")
    const facilityName = text(p.facilityName) || partyName(supplierPartyId) + " drop-ship"
    const facilityId = text(p.facilityId)
    if (facilityId) {
        const facility = dropShipFacility(facilityId)
        if (!facility || facility.ownerPartyId !== supplierPartyId)
            denied("FACILITY_INVALID", "Facility " + facilityId + " is not a drop-ship facility of " + partyName(supplierPartyId))
        call("update#" + FACILITY, {facilityId, facilityName, dropShipRemoteId: remoteId})
        return {facilityId, created: false}
    }
    const created = call("create#" + FACILITY, {
        facilityTypeEnumId: DROP_SHIP,
        ownerPartyId: supplierPartyId,
        facilityName,
        assetAllowOtherOwner: "Y",
        assetAllowIssueOverQoh: "Y",
        dropShipRemoteId: remoteId
    })
    return {facilityId: created.facilityId, created: true}
}
// get#DropShipSetup: a supplier's drop-ship facilities with their remotes, and the remotes to choose from, for a purchasing
// reader of one of the user's organizations.
function setup(p) {
    if (![...readPermissions, "PURCHASE_POLICY_EDIT"].some(permission => access.has(permission)))
        denied("PERMISSION_DENIED", "A purchasing permission is required")
    const supplierPartyId = text(p.supplierPartyId)
    if (!supplierPartyId) denied("SUPPLIER_UNAVAILABLE", "Choose a supplier")
    const facilities = dropShipFacilitiesOf(supplierPartyId).map(row => {
        const remote = row.dropShipRemoteId
            ? one("moqui.service.message.SystemMessageRemote", {systemMessageRemoteId: row.dropShipRemoteId})
            : null
        return {
            facilityId: row.facilityId,
            facilityName: row.facilityName || row.facilityId,
            dropShipRemoteId: row.dropShipRemoteId || null,
            remoteText: remote ? remote.description || remote.systemMessageRemoteId : "Email (no integration)"
        }
    })
    const remotes = Array.from(
        find("moqui.service.message.SystemMessageRemote").orderBy("systemMessageRemoteId").limit(100).list()
    ).map(row => ({key: row.systemMessageRemoteId, text: row.description || row.systemMessageRemoteId}))
    return {facilities, remotes, canEdit: access.has("PURCHASE_POLICY_EDIT")}
}

const operations = {create, send, finalize, route, orderView, storeFacility, setup}
;({
    shipToOf,
    deliveredQuantity,
    execute: (op, parameters) => {
        if (!operations[op]) throw new Error("Unknown drop-ship operation " + op)
        return operations[op](parameters)
    }
})
