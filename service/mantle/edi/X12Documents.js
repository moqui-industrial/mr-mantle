// This software is in the public domain under CC0 1.0 Universal plus a
// Grant of Patent License.
//
// To the extent possible under law, the author(s) have dedicated all
// copyright and related and neighboring rights to this software to the
// public domain worldwide. This software is distributed without any
// warranty.
//
// You should have received a copy of the CC0 Public Domain Dedication
// along with this software (see the LICENSE.md file). If not, see
// <http://creativecommons.org/publicdomain/zero/1.0/>.

// The X12 4010 business mappings of the sample profile (plan/payments-shipping-edi.md E1, docs/EdiX12.md): the 850
// purchase order received as a sales order, and the 855 acknowledgment, 856 ship notice and 810 invoice sent from the
// order, shipment and invoice. Ported from the Java Moqui mantle-edi component (github.com/moqui/mantle-edi, 1.1.5,
// commit 134acb6, written by David E. Jones: X12OrderServices.xml, X12ShipmentServices.xml and X12InvoiceServices.xml,
// their segment and element positions, N1 roles and date qualifiers) to JavaScript, with the gaps the plan names made
// explicit: SAC charges and allowances, line outcomes in the 855's ACK, and the 856's pack hierarchy and SSCCs are
// mapped where the profile supports them and refused otherwise, never dropped; customers, ship-to locations and items
// come from the connection and the profile's crosswalks, never invented.
//
// The business records change only through Mantle's order services. A refusal throws its reason code: for an 850 the
// document becomes an exception and no order is made; for a document sent it is Refused and nothing is sent.
const x = ec.resource.script("component://mr-mantle/service/mantle/edi/X12Lib.js")
const {lib, E, IN, find, one, rows, denied, blank, el, kids} = x
const {call} = lib

const ORDER = "mantle.order.OrderHeader",
    PART = "mantle.order.OrderPart",
    ITEM = "mantle.order.OrderItem"
// The segments the sample 850 takes, by parent; any other is refused (UNSUPPORTED_SEGMENT) so that no amount or
// content is dropped. REF, PER and TD5 are read and not applied.
const SUPPORTED_850 = {
    ST: ["elements", "BEG", "CUR", "REF", "PER", "DTM", "TD5", "N9", "N1", "PO1", "SAC", "CTT", "SE"],
    N9: ["elements", "MSG"],
    N1: ["elements", "N2", "N3", "N4", "REF", "PER"],
    PO1: ["elements", "PID", "SAC"],
    CTT: ["elements", "AMT"]
}
const DATES_850 = {
    "001": "autoCancelDate",
    "002": "estimatedDeliveryDate",
    "010": "estimatedShipDate",
    "037": "shipAfterDate",
    "038": "shipBeforeDate"
}

const decimal = value => toDecimal(value ?? 0)
// An identifier sent as it is: never altered to fit (produce#Document refuses one holding a separator,
// SEPARATOR_IN_DATA). Names and descriptions are cleaned instead (x.clean).
const ident = value => x.text(value).trim()
const same = (a, b) => decimal(a).eq(decimal(b))
function context(ediDocumentId) {
    const doc = one(E.DOCUMENT, {ediDocumentId})
    if (!doc) denied("RECORD_UNAVAILABLE", "No EDI document " + ediDocumentId)
    const c = x.connection(doc.systemMessageRemoteId)
    if (!c) denied("CONFIG_INVALID", "Document " + ediDocumentId + " has no EDI connection")
    return {doc, c, separators: c.separators}
}
// The received purchase order a document sent answers to, and its applied data.
function purchaseOrder(orderId, c) {
    const po = x.purchaseOrderOf(orderId)
    if (!po || po.systemMessageRemoteId !== c.systemMessageRemoteId)
        denied("NOT_EDI_ORDER", "Order " + orderId + " did not come in a purchase order on this connection")
    return {po, data: x.parseJson(po.documentData)}
}
const partyName = partyId => {
    const party = one("mantle.party.PartyDetail", {partyId})
    return party ? party.organizationName || [party.firstName, party.lastName].filter(Boolean).join(" ") || partyId : partyId
}
// The partner's location code for an address, as an N1 for its role (with the code when the crosswalk has one).
function n1For(role, partyId, contactMechId, c) {
    const s = c.separators
    const location = contactMechId ? rows(E.LOCATION, {partnerPartyId: c.partnerPartyId, contactMechId})[0] : null
    const n1 = ["N1", role, x.clean(partyName(location?.partyId || partyId), s, 60)]
    if (location) n1.push(location.idQualifier, location.idValue)
    return {elements: n1}
}

// ---- 850 in ----

function unsupportedSegments(segment, parent) {
    const allowed = SUPPORTED_850[parent]
    for (const key of Object.keys(segment)) {
        if (allowed && !allowed.includes(key))
            denied("UNSUPPORTED_SEGMENT", "Segment " + key + " under " + parent + " is not supported by the profile")
        if (key === "elements") continue
        for (const child of kids(segment, key)) unsupportedSegments(child, key)
    }
}
// The product of a line's ID pairs (PO106..): each qualifier the profile maps to productId or a ProductIdentification type
// must find one product, all the same; a buyer's ID is kept as the line's otherPartyProductId.
function lineProduct(line, c, lineId) {
    const qualifiers = x.codes(c, "EdctProductId")
    const found = new Set()
    let buyerId = null
    const ids = []
    for (let position = 6; position < line.elements.length; position += 2) {
        const qualifier = el(line, position)
        const value = el(line, position + 1)
        if (blank(qualifier)) continue
        ids.push([qualifier, value])
        const target = qualifiers[qualifier]?.internalValue
        if (target === "buyer") buyerId = buyerId || value
        else if (target === "productId") {
            if (one("mantle.product.Product", {productId: value})) found.add(value)
            else denied("ITEM_UNKNOWN", "Line " + lineId + ": no product " + value + " (" + qualifier + ")")
        } else if (target) {
            const matches = rows("mantle.product.ProductIdentification", {productIdTypeEnumId: target, idValue: value})
            if (!matches.length) denied("ITEM_UNKNOWN", "Line " + lineId + ": no product with " + qualifier + " " + value)
            for (const match of matches) found.add(match.productId)
        }
    }
    if (!found.size) denied("ITEM_UNKNOWN", "Line " + lineId + " names no product the profile can find")
    if (found.size > 1) denied("ITEM_MISMATCH", "Line " + lineId + " names different products: " + [...found].join(", "))
    return {productId: [...found][0], buyerId, ids}
}
// A SAC as an adjustment item: its code mapped to an item type of the same kind (A allowance, C charge), a stated
// amount (SAC05), handled off invoice (02) or charged to the customer (06). Percentages and other handling are refused.
function sacAdjustment(sac, c, where) {
    const indicator = el(sac, 1)
    const code = el(sac, 2)
    const mapped = x.codes(c, "EdctCharge")[code]
    if (!mapped || (mapped.ediQualifier && mapped.ediQualifier !== indicator))
        denied("SAC_UNSUPPORTED", where + ": SAC " + indicator + " " + code + " is not a charge or allowance the profile maps")
    const amount = el(sac, 5)
    if (!x.isN(amount))
        denied("SAC_UNSUPPORTED", where + ": SAC " + code + " has no amount (SAC05); percentages are not supported")
    if (!blank(el(sac, 6)) || !blank(el(sac, 7)) || !blank(el(sac, 8)))
        denied("SAC_UNSUPPORTED", where + ": SAC " + code + " has a percentage or rate (SAC06-08), which is not supported")
    const value = x.fromN2(amount)
    return {
        itemTypeEnumId: mapped.internalValue,
        unitAmount: indicator === "A" ? value.multiply(-1) : value,
        itemDescription: el(sac, 15) || mapped.description || code,
        sac: [indicator, code, amount]
    }
}
// apply#PurchaseOrder: a validated 850 as one sales order of the connection's store and partner. The same purchase
// order again is a Duplicate (no second order); its identity with changed content is a Conflict for review.
function applyPurchaseOrder(p) {
    const {doc, c} = context(p.ediDocumentId)
    if (!c.store || !c.partnerPartyId) denied("CONFIG_INVALID", "The connection needs a product store and a partner")
    const data = x.parseJson(doc.documentData)
    const pdoc = x.profileDocument(c, "850", IN)
    const {st} = x.parseSet(doc.documentText, data.separators, pdoc.grammarLocation)
    const beg = kids(st, "BEG")[0]
    const poNumber = el(beg, 3)
    const release = el(beg, 4)
    const businessKey = "PO " + poNumber + (release ? "/" + release : "")
    const body = x.segmentsOf(doc.documentText, data.separators).slice(1, -1)
    const contentHash = ec.user.singleUseCodeHash(body.map(segment => segment.text).join("\n"))
    const prior = rows(E.DOCUMENT, {
        directionEnumId: IN,
        transactionSetId: "850",
        organizationPartyId: doc.organizationPartyId,
        partnerPartyId: doc.partnerPartyId,
        usageCode: doc.usageCode,
        businessKey,
        statusId: "EdocApplied"
    }).filter(row => row.ediDocumentId !== doc.ediDocumentId)
    if (prior.length) {
        const match = prior.find(row => row.contentHash === contentHash)
        call("update#" + E.DOCUMENT, {
            ediDocumentId: doc.ediDocumentId,
            statusId: match ? "EdocDuplicate" : "EdocConflict",
            reasonCode: match ? "DUPLICATE_PO" : "PO_CONFLICT",
            errorText: match
                ? null
                : "Purchase order " +
                  poNumber +
                  " was applied before (order " +
                  prior[0].orderId +
                  ") with other content; review it",
            businessKey,
            contentHash,
            orderId: (match || prior[0]).orderId,
            duplicateOfDocumentId: (match || prior[0]).ediDocumentId
        })
        return {}
    }
    unsupportedSegments(st, "ST")

    const currencyUomId = c.store.defaultCurrencyUomId
    if (!currencyUomId) denied("CONFIG_INVALID", "Product store " + c.store.productStoreId + " has no currency")
    const cur = kids(st, "CUR")[0]
    if (cur && el(cur, 2) !== currencyUomId)
        denied("CURRENCY_MISMATCH", "The order is in " + el(cur, 2) + " and the store sells in " + currencyUomId)
    const shipTos = kids(st, "N1").filter(n1 => el(n1, 1) === "ST")
    if (shipTos.length !== 1) denied("SHIP_TO_REQUIRED", "The order needs one ship-to (N1*ST) location code")
    const shipToCode = {qualifier: el(shipTos[0], 3), id: el(shipTos[0], 4)}
    const location = blank(shipToCode.id)
        ? null
        : one(E.LOCATION, {partnerPartyId: c.partnerPartyId, idQualifier: shipToCode.qualifier, idValue: shipToCode.id})
    if (!location?.contactMechId)
        denied(
            "SHIP_TO_UNKNOWN",
            "Ship-to location " + shipToCode.qualifier + " " + shipToCode.id + " is not in the partner's locations"
        )

    const header = {
        productStoreId: c.store.productStoreId,
        vendorPartyId: c.organizationPartyId,
        customerPartyId: c.partnerPartyId,
        currencyUomId,
        salesChannelEnumId: "ScEdi",
        systemMessageRemoteId: c.systemMessageRemoteId,
        externalId: poNumber,
        otherPartyOrderId: poNumber,
        otherPartyOrderDate: x.parseDate(el(beg, 5)),
        postalContactMechId: location.contactMechId,
        facilityId: c.store.inventoryFacilityId,
        disablePromotions: "Y",
        disableShippingCalc: "Y"
    }
    for (const dtm of kids(st, "DTM")) {
        const field = DATES_850[el(dtm, 1)]
        if (field) header[field] = x.parseDate(el(dtm, 2))
    }
    const uoms = x.codes(c, "EdctUom")
    const seenLines = new Set()
    const lines = kids(st, "PO1").map(po1 => {
        const lineId = el(po1, 1)
        if (seenLines.has(lineId)) denied("LINE_DUPLICATE", "Line " + lineId + " appears twice")
        seenLines.add(lineId)
        const quantity = decimal(el(po1, 2))
        if (quantity.compare(0) <= 0) denied("LINE_QUANTITY_INVALID", "Line " + lineId + " has no positive quantity")
        const unitPrice = decimal(el(po1, 4))
        if (unitPrice.compare(0) < 0) denied("LINE_PRICE_INVALID", "Line " + lineId + " has a negative price")
        const product = lineProduct(po1, c, lineId)
        return {
            lineId,
            quantity: x.decimalText(quantity),
            uom: el(po1, 3),
            quantityUomId: uoms[el(po1, 3)].internalValue,
            unitPrice: x.decimalText(unitPrice),
            basis: el(po1, 5),
            ids: product.ids,
            productId: product.productId,
            buyerId: product.buyerId,
            description: el(kids(po1, "PID")[0], 5),
            adjustments: kids(po1, "SAC").map(sac => sacAdjustment(sac, c, "Line " + lineId))
        }
    })
    const adjustments = kids(st, "SAC").map(sac => sacAdjustment(sac, c, "The order"))
    const notes = kids(st, "N9")
        .flatMap(n9 => kids(n9, "MSG"))
        .map(msg => el(msg, 1))
        .filter(Boolean)

    const created = call("mantle.order.OrderServices.create#Order", header)
    const {orderId, orderPartSeqId} = created
    if (location.partyId && location.partyId !== c.partnerPartyId)
        call("create#mantle.order.OrderPartParty", {
            orderId,
            orderPartSeqId,
            partyId: location.partyId,
            roleTypeId: "CustomerShipTo"
        })
    for (const line of lines) {
        const item = {
            orderId,
            orderPartSeqId,
            productId: line.productId,
            quantity: line.quantity,
            quantityUomId: line.quantityUomId,
            unitAmount: line.unitPrice,
            isModifiedPrice: "N",
            externalItemSeqId: line.lineId,
            otherPartyProductId: line.buyerId,
            requireInventory: false
        }
        if (line.description) item.itemDescription = line.description
        line.orderItemSeqId = call("mantle.order.OrderServices.create#OrderItem", item).orderItemSeqId
        for (const adjustment of line.adjustments)
            call("mantle.order.OrderServices.create#OrderItem", {
                orderId,
                orderPartSeqId,
                parentItemSeqId: line.orderItemSeqId,
                itemTypeEnumId: adjustment.itemTypeEnumId,
                quantity: 1,
                unitAmount: x.decimalText(adjustment.unitAmount),
                itemDescription: adjustment.itemDescription
            })
    }
    for (const adjustment of adjustments)
        call("mantle.order.OrderServices.create#OrderItem", {
            orderId,
            orderPartSeqId,
            itemTypeEnumId: adjustment.itemTypeEnumId,
            quantity: 1,
            unitAmount: x.decimalText(adjustment.unitAmount),
            itemDescription: adjustment.itemDescription
        })
    if (notes.length) call("create#mantle.order.OrderNote", {orderId, noteDate: ec.user.nowTimestamp, noteText: notes.join("\n")})
    // The customer placed it; approving it is the seller's decision, which the 855 reports.
    call("mantle.order.OrderServices.place#Order", {orderId, requireInventory: false})
    call("create#mantle.order.OrderSystemMessage", {orderId, systemMessageId: doc.systemMessageId, externalId: poNumber})
    data.applied = {
        poNumber,
        release,
        poDate: el(beg, 5),
        shipTo: shipToCode,
        lines: lines.map(line => ({
            lineId: line.lineId,
            quantity: line.quantity,
            uom: line.uom,
            unitPrice: line.unitPrice,
            basis: line.basis,
            ids: line.ids,
            orderItemSeqId: line.orderItemSeqId
        })),
        charges: adjustments.map(adjustment => adjustment.sac)
    }
    call("update#" + E.DOCUMENT, {
        ediDocumentId: doc.ediDocumentId,
        statusId: "EdocApplied",
        reasonCode: null,
        errorText: null,
        businessKey,
        contentHash,
        orderId,
        documentData: x.json(data)
    })
    return {orderId}
}

// ---- 855 out ----

// produce#PurchaseOrderAck: the order's decision on each line of the purchase order: IA accepted as ordered, IQ a
// changed quantity, IP a changed price, IC both, IR rejected (the line cancelled, or the order rejected or cancelled).
// BAK02 AD with no change, AC with changes, RD for an order rejected or cancelled. A line the seller added is refused
// (LINE_ADDED_UNSUPPORTED); SAC lines are not acknowledged.
function purchaseOrderAck(p) {
    const {doc, c, separators} = context(p.ediDocumentId)
    const order = one(ORDER, {orderId: doc.orderId})
    if (!order) denied("RECORD_UNAVAILABLE", "No order " + doc.orderId)
    if (rows(PART, {orderId: order.orderId}).length !== 1)
        denied("MULTIPLE_PARTS", "Order " + order.orderId + " has more than one part")
    const {data} = purchaseOrder(order.orderId, c)
    const applied = data.applied
    const rejected = ["OrderCancelled", "OrderRejected"].includes(order.statusId)
    if (!rejected && order.statusId !== "OrderApproved" && order.statusId !== "OrderCompleted")
        denied("ORDER_NOT_DECIDED", "Order " + order.orderId + " is " + order.statusId + ", not decided")
    const items = rows(ITEM, {orderId: order.orderId})
    const known = new Set(applied.lines.map(line => line.orderItemSeqId))
    const added = items.filter(item => item.productId && !item.parentItemSeqId && !known.has(item.orderItemSeqId))
    if (added.length)
        denied(
            "LINE_ADDED_UNSUPPORTED",
            "Order lines not in the purchase order: " + added.map(item => item.orderItemSeqId).join(", ")
        )
    let changed = rejected
    const po1s = applied.lines.map(line => {
        const item = items.find(row => row.orderItemSeqId === line.orderItemSeqId)
        const ordered = decimal(line.quantity)
        const quantity = item ? decimal(item.quantity).subtract(decimal(item.quantityCancelled)) : decimal(0)
        let code = "IA"
        if (rejected || !item || quantity.compare(0) <= 0) code = "IR"
        else {
            const quantityChanged = !quantity.eq(ordered)
            const priceChanged = !same(item.unitAmount, line.unitPrice)
            code = quantityChanged && priceChanged ? "IC" : quantityChanged ? "IQ" : priceChanged ? "IP" : "IA"
        }
        if (code !== "IA") changed = true
        const price = item && code !== "IR" ? x.decimalText(item.unitAmount) : line.unitPrice
        const elements = ["PO1", line.lineId, line.quantity, line.uom, price, line.basis || ""]
        for (const [qualifier, value] of line.ids) elements.push(qualifier, ident(value))
        return {
            elements,
            ACK: [{elements: ["ACK", code, code === "IR" ? "0" : x.decimalText(quantity), line.uom]}]
        }
    })
    const ackType = rejected ? "RD" : changed ? "AC" : "AD"
    return {
        bodyEdiMap: {
            BAK: [
                {
                    elements: [
                        "BAK",
                        doc.purposeCode || "00",
                        ackType,
                        applied.poNumber,
                        applied.poDate,
                        applied.release || "",
                        "",
                        "",
                        order.orderId,
                        x.x12Date(ec.user.nowTimestamp)
                    ]
                }
            ],
            PO1: po1s,
            CTT: [{elements: ["CTT", String(po1s.length)]}]
        }
    }
}

// ---- 856 out ----

// The GS1 check digit of an 18-digit SSCC.
function ssccValid(value) {
    if (!/^\d{18}$/.test(value)) return false
    let sum = 0
    for (let index = 0; index < 17; index++) sum += Number(value[index]) * (index % 2 === 0 ? 3 : 1)
    return (10 - (sum % 10)) % 10 === Number(value[17])
}
// produce#ShipNotice: the shipment in the Shipment, Order, Pack, Item hierarchy (BSN05 0001), from its actual packages:
// each package (with its SSCC in MAN*GM, else its tracking number in MAN*CP) under its order, each content under its
// package with the purchase order's line ID and IDs. Refused: a shipment not shipped, an order not received on this
// connection, a product of two order lines (CONTENTS_AMBIGUOUS), contents not all packed (UNPACKED_CONTENTS), a package
// of two orders (PACKAGE_MIXES_ORDERS), a missing or invalid SSCC the profile requires (SSCC_MISSING, SSCC_INVALID).
function shipNotice(p) {
    const {doc, c, separators} = context(p.ediDocumentId)
    const shipment = one("mantle.shipment.Shipment", {shipmentId: doc.shipmentId})
    if (!shipment) denied("RECORD_UNAVAILABLE", "No shipment " + doc.shipmentId)
    if (!["ShipShipped", "ShipDelivered"].includes(shipment.statusId))
        denied("SHIPMENT_NOT_SHIPPED", "Shipment " + shipment.shipmentId + " is not shipped")
    const sources = rows("mantle.shipment.ShipmentItemSource", {shipmentId: shipment.shipmentId})
    const orders = {}
    const lineOf = {}
    for (const source of sources) {
        if (!source.orderId) continue
        orders[source.orderId] = orders[source.orderId] || purchaseOrder(source.orderId, c).data.applied
        const key = source.orderId + "/" + source.orderItemSeqId
        lineOf[source.productId] = lineOf[source.productId] || new Set()
        lineOf[source.productId].add(key)
    }
    if (!Object.keys(orders).length) denied("NOT_EDI_ORDER", "Shipment " + shipment.shipmentId + " has no order items")
    for (const productId of Object.keys(lineOf))
        if (lineOf[productId].size > 1)
            denied("CONTENTS_AMBIGUOUS", "Product " + productId + " ships for more than one order line")
    const lineFor = productId => {
        const [orderId, orderItemSeqId] = [...lineOf[productId]][0].split("/")
        const line = orders[orderId].lines.find(row => row.orderItemSeqId === orderItemSeqId)
        if (!line) denied("LINE_UNKNOWN", "Order item " + orderId + "/" + orderItemSeqId + " is not a purchase order line")
        return {orderId, line}
    }
    const packages = rows("mantle.shipment.ShipmentPackage", {shipmentId: shipment.shipmentId}).sort((a, b) =>
        String(a.shipmentPackageSeqId).localeCompare(String(b.shipmentPackageSeqId))
    )
    if (!packages.length) denied("NO_PACKAGES", "Shipment " + shipment.shipmentId + " has no packages")
    const contents = rows("mantle.shipment.ShipmentPackageContent", {shipmentId: shipment.shipmentId})
    const packed = {}
    for (const content of contents) {
        if (!lineOf[content.productId]) denied("LINE_UNKNOWN", "Packed product " + content.productId + " is on no order line")
        packed[content.productId] = decimal(packed[content.productId]).add(decimal(content.quantity))
    }
    for (const item of rows("mantle.shipment.ShipmentItem", {shipmentId: shipment.shipmentId}))
        if (!decimal(packed[item.productId]).eq(decimal(item.quantity)))
            denied(
                "UNPACKED_CONTENTS",
                "Product " + item.productId + ": " + item.quantity + " shipped and " + (packed[item.productId] ?? 0) + " packed"
            )
    const routeSegments = rows("mantle.shipment.ShipmentRouteSegment", {shipmentId: shipment.shipmentId}).sort((a, b) =>
        String(a.shipmentRouteSegmentSeqId).localeCompare(String(b.shipmentRouteSegmentSeqId))
    )
    const segment = routeSegments[0] || {}
    const trackingOf = pkg =>
        rows("mantle.shipment.ShipmentPackageRouteSeg", {
            shipmentId: shipment.shipmentId,
            shipmentPackageSeqId: pkg.shipmentPackageSeqId
        })
            .map(row => row.trackingCode)
            .find(Boolean)
    const packs = packages.map(pkg => {
        const own = contents
            .filter(content => content.shipmentPackageSeqId === pkg.shipmentPackageSeqId)
            .sort((a, b) => String(a.productId).localeCompare(String(b.productId)))
        const orderIds = [...new Set(own.map(content => lineFor(content.productId).orderId))]
        if (orderIds.length > 1)
            denied("PACKAGE_MIXES_ORDERS", "Package " + pkg.shipmentPackageSeqId + " holds items of " + orderIds.join(" and "))
        if (!blank(pkg.sscc) && !ssccValid(pkg.sscc))
            denied("SSCC_INVALID", "Package " + pkg.shipmentPackageSeqId + " has an invalid SSCC")
        if (blank(pkg.sscc) && c.profile.requireSscc === "Y")
            denied("SSCC_MISSING", "Package " + pkg.shipmentPackageSeqId + " has no SSCC, which the profile requires")
        return {pkg, own, orderId: orderIds[0], tracking: trackingOf(pkg)}
    })

    const now = ec.user.nowTimestamp
    const shippedDate = segment.actualStartDate || shipment.estimatedShipDate || now
    let hlCount = 0
    const hls = []
    const hl = (parent, level, children) => {
        hlCount++
        const node = Object.assign({elements: ["HL", String(hlCount), parent, level]}, children)
        hls.push(node)
        return String(hlCount)
    }
    const shipmentLevel = {}
    const weightUom = packages[0].weightUomId
    // TD101/TD102 (packaging code and package count) come together, the code the profile's; TD106-108 the gross weight.
    const packaging = blank(c.profile.asnPackagingCode) ? ["", ""] : [c.profile.asnPackagingCode, String(packages.length)]
    if (packages.every(pkg => pkg.weight != null && pkg.weightUomId === weightUom)) {
        const code = x.codeFor(c, "EdctWeightUom", weightUom)
        if (!code) denied("UOM_UNSUPPORTED", "Weight unit " + weightUom + " is not in the profile")
        const weight = packages.reduce((total, pkg) => total.add(decimal(pkg.weight)), decimal(0))
        shipmentLevel.TD1 = [{elements: ["TD1", ...packaging, "", "", "", "G", x.decimalText(weight), code.ediCode]}]
    } else if (packaging[0]) shipmentLevel.TD1 = [{elements: ["TD1", ...packaging]}]
    const method = segment.carrierPartyId
        ? one("mantle.shipment.carrier.CarrierShipmentMethod", {
              carrierPartyId: segment.carrierPartyId,
              shipmentMethodEnumId: segment.shipmentMethodEnumId
          })
        : null
    if (method?.scaCode) shipmentLevel.TD5 = [{elements: ["TD5", "", "2", ident(method.scaCode)]}]
    if (segment.trackingIdNumber) shipmentLevel.REF = [{elements: ["REF", "CN", ident(segment.trackingIdNumber)]}]
    shipmentLevel.DTM = [{elements: ["DTM", "011", x.x12Date(shippedDate)]}]
    const firstOrder = Object.keys(orders)[0]
    const part = rows(PART, {orderId: firstOrder})[0]
    shipmentLevel.N1 = [
        n1For("ST", shipment.toPartyId || part?.customerPartyId, segment.destPostalContactMechId || part?.postalContactMechId, c),
        {elements: ["N1", "SF", x.clean(partyName(shipment.fromPartyId || c.organizationPartyId), separators, 60)]}
    ]
    const shipmentHl = hl("", "S", shipmentLevel)
    for (const orderId of Object.keys(orders)) {
        const applied = orders[orderId]
        const orderHl = hl(shipmentHl, "O", {
            PRF: [{elements: ["PRF", applied.poNumber, applied.release || "", "", applied.poDate]}]
        })
        for (const pack of packs.filter(row => row.orderId === orderId)) {
            const man = !blank(pack.pkg.sscc)
                ? ["MAN", "GM", pack.pkg.sscc]
                : pack.tracking
                  ? ["MAN", "CP", ident(pack.tracking)]
                  : null
            const packHl = hl(orderHl, "P", man ? {MAN: [{elements: man}]} : {})
            for (const content of pack.own) {
                const {line} = lineFor(content.productId)
                const lin = ["LIN", line.lineId]
                for (const [qualifier, value] of line.ids) lin.push(qualifier, ident(value))
                hl(packHl, "I", {
                    LIN: [{elements: lin}],
                    SN1: [{elements: ["SN1", "", x.decimalText(content.quantity), line.uom]}]
                })
            }
        }
    }
    return {
        bodyEdiMap: {
            BSN: [
                {
                    elements: [
                        "BSN",
                        doc.purposeCode || "00",
                        ident(shipment.shipmentId),
                        x.x12Date(now),
                        x.x12Date(now, "HHmm"),
                        "0001"
                    ]
                }
            ],
            HL: hls,
            CTT: [{elements: ["CTT", String(hlCount)]}]
        }
    }
}

// ---- 810 out ----

// produce#Invoice: the invoice of one EDI order: an IT1 per product line with the purchase order's line ID and IDs; a
// child charge or allowance as the line's SAC and another as a summary SAC (the profile's EdctCharge codes); tax items as
// TXI (EdctTax); TDS the invoice total. Refused: an item type the profile does not map (CHARGE_UNSUPPORTED), a charge
// with the sign of an allowance or the reverse (CHARGE_SIGN), more than two decimal places (AMOUNT_PRECISION), and
// lines and charges that do not add up to the invoice total (TOTAL_MISMATCH), so no amount is dropped.
function invoice(p) {
    const {doc, c, separators} = context(p.ediDocumentId)
    const inv = one("mantle.account.invoice.Invoice", {invoiceId: doc.invoiceId})
    if (!inv) denied("RECORD_UNAVAILABLE", "No invoice " + doc.invoiceId)
    const billings = rows("mantle.order.OrderItemBilling", {invoiceId: inv.invoiceId})
    const orderIds = [...new Set(billings.map(row => row.orderId))]
    if (orderIds.length !== 1)
        denied("MULTIPLE_ORDERS", "Invoice " + inv.invoiceId + " bills " + orderIds.length + " orders; one is supported")
    const {data} = purchaseOrder(orderIds[0], c)
    const applied = data.applied
    const productTypes = rows("moqui.basic.EnumGroupMember", {enumGroupEnumId: "EngItemsProduct"}).map(row => row.enumId)
    const items = rows("mantle.account.invoice.InvoiceItem", {invoiceId: inv.invoiceId}).sort((a, b) =>
        String(a.invoiceItemSeqId).localeCompare(String(b.invoiceItemSeqId))
    )
    const extended = item => decimal(item.quantity ?? 1).multiply(decimal(item.amount))
    let total = decimal(0)
    const lines = {}
    const it1s = []
    for (const item of items.filter(row => productTypes.includes(row.itemTypeEnumId) && !row.parentItemSeqId)) {
        const billing = billings.find(row => row.invoiceItemSeqId === item.invoiceItemSeqId)
        const line = billing && applied.lines.find(row => row.orderItemSeqId === billing.orderItemSeqId)
        if (!line) denied("LINE_UNKNOWN", "Invoice item " + item.invoiceItemSeqId + " is not a purchase order line")
        const elements = [
            "IT1",
            line.lineId,
            x.decimalText(item.quantity ?? 1),
            line.uom,
            x.decimalText(item.amount),
            line.basis || ""
        ]
        for (const [qualifier, value] of line.ids) elements.push(qualifier, ident(value))
        const it1 = {elements}
        lines[item.invoiceItemSeqId] = it1
        it1s.push(it1)
        total = total.add(extended(item))
    }
    const taxes = []
    const charges = []
    for (const item of items.filter(row => !lines[row.invoiceItemSeqId])) {
        const amount = extended(item)
        total = total.add(amount)
        const tax = x.codeFor(c, "EdctTax", item.itemTypeEnumId)
        if (tax) {
            taxes.push({elements: ["TXI", tax.ediCode, x.decimalText(amount)]})
            continue
        }
        const charge = x.codeFor(c, "EdctCharge", item.itemTypeEnumId)
        if (!charge)
            denied(
                "CHARGE_UNSUPPORTED",
                "Invoice item " + item.invoiceItemSeqId + " of type " + item.itemTypeEnumId + " has no SAC code in the profile"
            )
        const indicator = charge.ediQualifier || (amount.compare(0) < 0 ? "A" : "C")
        if ((indicator === "A" && amount.compare(0) > 0) || (indicator === "C" && amount.compare(0) < 0))
            denied(
                "CHARGE_SIGN",
                "Invoice item " + item.invoiceItemSeqId + " has the sign of the other kind for SAC " + indicator
            )
        const sac = {
            elements: ["SAC", indicator, charge.ediCode, "", "", x.toN2(amount.compare(0) < 0 ? amount.multiply(-1) : amount)]
        }
        const parent = item.parentItemSeqId && lines[item.parentItemSeqId]
        if (parent) (parent.SAC = parent.SAC || []).push(sac)
        else charges.push(sac)
    }
    if (!it1s.length) denied("NO_LINES", "Invoice " + inv.invoiceId + " has no product lines")
    const invoiceTotal = decimal(call("mantle.account.InvoiceServices.get#InvoiceTotal", {invoiceId: inv.invoiceId}).invoiceTotal)
    if (!total.eq(invoiceTotal))
        denied(
            "TOTAL_MISMATCH",
            "The lines and charges come to " + x.decimalText(total) + " and the invoice to " + x.decimalText(invoiceTotal)
        )
    const big = ["BIG", x.x12Date(inv.invoiceDate), ident(inv.invoiceId), applied.poDate, applied.poNumber]
    if (applied.release || (doc.purposeCode && doc.purposeCode !== "00")) big.push(applied.release || "")
    if (doc.purposeCode && doc.purposeCode !== "00") big.push("", "", doc.purposeCode)
    const body = {
        BIG: [{elements: big}],
        N1: [
            {elements: ["N1", "RE", x.clean(partyName(inv.fromPartyId), separators, 60)]},
            n1For("ST", inv.toPartyId, rows(PART, {orderId: orderIds[0]})[0]?.postalContactMechId, c)
        ]
    }
    if (inv.dueDate) body.ITD = [{elements: ["ITD", "01", "3", "", "", "", x.x12Date(inv.dueDate)]}]
    body.IT1 = it1s
    body.TDS = [{elements: ["TDS", x.toN2(invoiceTotal)]}]
    if (taxes.length) body.TXI = taxes
    if (charges.length) body.SAC = charges
    body.CTT = [{elements: ["CTT", String(it1s.length)]}]
    return {bodyEdiMap: body}
}

const operations = {applyPurchaseOrder, purchaseOrderAck, shipNotice, invoice}
;({
    ssccValid,
    execute(op, input) {
        if (!operations[op]) throw new Error("Unknown X12 document operation " + op)
        const was = ec.artifactExecution.disableAuthz()
        try {
            return operations[op](input || {}) || {}
        } finally {
            if (!was) ec.artifactExecution.enableAuthz()
        }
    }
})
