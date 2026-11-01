// The Warehouse shipping entry points' rules (impl-warehouse P13; design-warehouse §10 Ship and PackageTracking, §17
// WH-LABEL and WH-POST): mantle.shipment.WarehouseTaskServices get#ShipmentRates, request#PackageLabels,
// refund#PackageLabels, track#PackageLabels, record#ManualTracking, record#PackageDelivery, ship#OutgoingShipment and the
// gateway path of request#ReturnLabel.
//
// A gateway is called outside any transaction that could roll back after it. Each request to a gateway (a label, a return
// label, a refund) is first recorded as a ShippingGatewayRequest in a transaction of its own (record#ShippingGatewayRequests,
// which holds the shipment's lock and every check), committed, and only then sent, each package in its own transaction; its
// answer is written to the request (Succeeded, Failed) and, when the call times out or fails with no answer, the request is
// Unknown. The next request for that package asks the gateway first (its find#ShippingLabels service) and buys nothing when
// the label is there; the request id is the reference sent to the gateway, so a gateway that keeps references answers a
// repeat with the first label too. The operation (CX-POSTING) is completed only when no package is left Unknown, so a retry
// under the same key asks again rather than answering a stale result.
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const posting = ec.resource.script("component://mr-mantle/service/mantle/shipment/StockPosting.js")
const facilityScope = ec.resource.script("component://mr-mantle/service/mantle/facility/FacilityScope.js")
const {find, one, rows, denied, call, probe} = lib

const SHIPMENT = "mantle.shipment.Shipment",
    SEGMENT = "mantle.shipment.ShipmentRouteSegment",
    PACKAGE = "mantle.shipment.ShipmentPackage",
    CONTENT = "mantle.shipment.ShipmentPackageContent",
    ROUTE_SEG = "mantle.shipment.ShipmentPackageRouteSeg",
    REQUEST = "mantle.shipment.carrier.ShippingGatewayRequest",
    GATEWAY = "mantle.shipment.carrier.ShippingGatewayConfig",
    METHOD = "mantle.shipment.carrier.CarrierShipmentMethod",
    ISSUANCE = "mantle.product.issuance.AssetIssuance"
const T = "mantle.shipment.WarehouseTaskServices."
// shipments a facility receives, and drop shipments, are never shipped here; a transfer ships through ship#Transfer and a
// supplier return through ship#SupplierReturn
const notOutgoing = ["ShpTpPurchase", "ShpTpSalesReturn", "ShpTpDrop"]
const shippedElsewhere = {ShpTpTransfer: "ship#Transfer (Transfers)", ShpTpPurchaseReturn: "ship#SupplierReturn (Returns)"}
const finalStatuses = ["ShipShipped", "ShipDelivered", "ShipCancelled", "ShipRejected"]
// an answer a gateway gives for certain: the request failed and may be sent again; anything else is no answer
const refusals = ["LABEL_REFUSED", "ADDRESS_INVALID", "WEIGHT_REQUIRED", "METHOD_UNAVAILABLE", "NO_PACKAGES", "NO_LABEL"]
// a Requested row younger than this is a call still under way (another session's)
const inFlightMs = 120000
const kinds = {
    label: {type: "SgrLabel", returnLabels: false},
    returnLabel: {type: "SgrReturnLabel", returnLabels: true},
    refund: {type: "SgrRefund", returnLabels: false}
}

const blank = value => value == null || String(value).trim() === ""
const number = value => (value == null || value === "" ? 0 : Number(String(value)))
const text = value => String(Math.round(number(value) * 1000000) / 1000000)
const truthy = value => value === true || value === "true" || value === "Y"
const bySeq = field => (a, b) => String(a[field]).localeCompare(String(b[field]))
const reasonOf = message => posting.reasonOf(String(message || ""))

// ===== the shipment =====
// An outgoing shipment leaving a facility of the user's organizations (its first route segment's origin, F55), locked or
// read; another, a missing one and an incoming or drop shipment are refused alike.
function shipmentOf(userScope, shipmentId, lock = true) {
    const shipment = blank(shipmentId) ? null : find(SHIPMENT, {shipmentId}).forUpdate(lock).one()
    const segments = shipment ? rows(SEGMENT, {shipmentId}).sort(bySeq("shipmentRouteSegmentSeqId")) : []
    const facility = segments[0]?.originFacilityId
        ? one("mantle.facility.Facility", {facilityId: segments[0].originFacilityId})
        : null
    if (
        !shipment ||
        !facility ||
        notOutgoing.includes(shipment.shipmentTypeEnumId) ||
        !facilityScope.owns(userScope, facility.ownerPartyId)
    )
        denied("RECORD_UNAVAILABLE", "Shipment " + (shipmentId || "") + " is not available")
    return {shipment, shipmentId: shipment.shipmentId, facility, facilityId: facility.facilityId, segments}
}
function segmentOf(sh, shipmentRouteSegmentSeqId) {
    const segment = blank(shipmentRouteSegmentSeqId)
        ? sh.segments[0]
        : sh.segments.find(row => row.shipmentRouteSegmentSeqId === shipmentRouteSegmentSeqId)
    if (!segment)
        denied("RECORD_UNAVAILABLE", "Route segment " + (shipmentRouteSegmentSeqId || "") + " is not on " + sh.shipmentId)
    return segment
}
const packagesOf = shipmentId => rows(PACKAGE, {shipmentId}).sort(bySeq("shipmentPackageSeqId"))
function packagesAsked(sh, shipmentPackageSeqId) {
    const packages = packagesOf(sh.shipmentId)
    if (blank(shipmentPackageSeqId)) {
        if (!packages.length) denied("NO_PACKAGES", "Shipment " + sh.shipmentId + " has no package; pack it first")
        return packages
    }
    const row = packages.find(item => item.shipmentPackageSeqId === shipmentPackageSeqId)
    if (!row) denied("PACKAGE_UNAVAILABLE", "Package " + shipmentPackageSeqId + " is not on shipment " + sh.shipmentId)
    return [row]
}
// The route segment row of a package, made when missing (create#ShipmentPackage makes one for each segment).
function routeSegOf(shipmentId, shipmentPackageSeqId, shipmentRouteSegmentSeqId) {
    const key = {shipmentId, shipmentPackageSeqId, shipmentRouteSegmentSeqId}
    let row = one(ROUTE_SEG, key)
    if (!row) {
        call("create#" + ROUTE_SEG, key)
        row = one(ROUTE_SEG, key)
    }
    return row
}
// A label on the package's route segment that was not refunded (the return fields for a return label).
function activeLabel(routeSeg, returnLabels = false) {
    if (!routeSeg) return false
    if (returnLabels)
        return !blank(routeSeg.returnTrackingCode) || !blank(routeSeg.returnGatewayLabelId) || routeSeg.returnLabelImage != null
    const has =
        !blank(routeSeg.trackingCode) ||
        !blank(routeSeg.gatewayLabelId) ||
        routeSeg.labelImage != null ||
        !blank(routeSeg.labelUrl)
    return has && blank(routeSeg.gatewayRefundStatus)
}
// The gateway that serves the shipment's segment (Mantle's get#ShipmentGatewayDetails: the store's for the carrier, the
// segment's, the shipper's setting, the preference), or null.
function gatewayOf(shipmentId, shipmentRouteSegmentSeqId) {
    try {
        const out = probe("mantle.shipment.CarrierServices.get#ShipmentGatewayDetails", {shipmentId, shipmentRouteSegmentSeqId})
        return out.shippingGatewayConfigId ? one(GATEWAY, {shippingGatewayConfigId: out.shippingGatewayConfigId}) : null
    } catch (error) {
        return null
    }
}
function gatewayView(gateway) {
    return gateway
        ? {
              shippingGatewayConfigId: gateway.shippingGatewayConfigId,
              description: gateway.description,
              testMode: gateway.testMode === "Y",
              labels: !blank(gateway.requestLabelsServiceName),
              refunds: !blank(gateway.refundLabelsServiceName),
              tracking: !blank(gateway.trackLabelsServiceName),
              lookup: !blank(gateway.findLabelServiceName),
              rates: !blank(gateway.getShippingRatesBulkName) || !blank(gateway.getRateServiceName),
              validation: !blank(gateway.validateAddressServiceName)
          }
        : null
}

// ===== rates (RateOptions, CarrierTest) =====
// The configured rate providers for the shipment: each gateway that serves it with its methods, through its
// get#ShippingRatesBulk or get#ShippingRate implementation, and the local-rules provider for the methods with no gateway,
// an adapter over get#OrderShippingRateLocal with the shipment's order part. A provider that fails is named in
// providerErrors and the others go on.
function rates(p) {
    posting.requirePermission(["SHIPMENT_SHIP", "SHIPPING_CARRIER_EDIT", "FACILITY_EDIT"])
    const sh = shipmentOf(posting.scope(), p.shipmentId, false)
    const segment = segmentOf(sh, p.shipmentRouteSegmentSeqId)
    const packages = packagesOf(sh.shipmentId)
    const contents = rows(CONTENT, {shipmentId: sh.shipmentId})
    const packageInfoList = packages.map(row => ({
        shipmentPackageSeqId: row.shipmentPackageSeqId,
        shipmentBoxTypeId: row.shipmentBoxTypeId,
        weight: row.weight,
        weightUomId: row.weightUomId || "WT_lb",
        quantityByProductId: Object.fromEntries(
            contents
                .filter(item => item.shipmentPackageSeqId === row.shipmentPackageSeqId)
                .map(item => [item.productId, item.quantity])
        )
    }))
    const rateRows = [],
        providerErrors = []
    const methodName = id => one("moqui.basic.Enumeration", {enumId: id})?.description || id
    const partyName = partyId =>
        partyId === "_NA_" ? "No carrier" : one("mantle.party.Organization", {partyId})?.organizationName || partyId
    const chosen = row =>
        row.carrierPartyId === segment.carrierPartyId && row.shipmentMethodEnumId === segment.shipmentMethodEnumId
    const add = (row, source, gateway) =>
        rateRows.push({
            rateSource: source,
            shippingGatewayConfigId: gateway?.shippingGatewayConfigId || null,
            gatewayName: gateway?.description || (source === "local" ? "Local rules" : null),
            testMode: gateway?.testMode === "Y",
            canLabel: !!gateway?.requestLabelsServiceName,
            carrierPartyId: row.carrierPartyId,
            carrierName: partyName(row.carrierPartyId),
            shipmentMethodEnumId: row.shipmentMethodEnumId,
            methodName: methodName(row.shipmentMethodEnumId),
            serviceName: row.serviceName || null,
            shippingTotal: row.shippingTotal == null ? null : text(row.shippingTotal),
            currency: row.currency || null,
            days: row.days == null ? null : number(row.days),
            chosen: chosen(row)
        })

    // the gateways: the one asked (CarrierTest), else the store's by carrier, the segment's and the shipper's default
    const gatewayIds = []
    const addGateway = id => {
        if (id && !gatewayIds.includes(id)) gatewayIds.push(id)
    }
    const storeGateways = sh.shipment.productStoreId
        ? rows("mantle.product.store.ProductStoreShippingGateway", {productStoreId: sh.shipment.productStoreId})
        : []
    if (!blank(p.shippingGatewayConfigId)) addGateway(p.shippingGatewayConfigId)
    else {
        storeGateways.forEach(row => addGateway(row.shippingGatewayConfigId))
        addGateway(segment.shippingGatewayConfigId)
        addGateway(gatewayOf(sh.shipmentId, segment.shipmentRouteSegmentSeqId)?.shippingGatewayConfigId)
    }
    const servedCarriers = new Set()
    for (const shippingGatewayConfigId of gatewayIds) {
        const gateway = one(GATEWAY, {shippingGatewayConfigId})
        if (!gateway || (!gateway.getShippingRatesBulkName && !gateway.getRateServiceName)) continue
        const carriers = new Set(
            rows("mantle.shipment.carrier.ShippingGatewayCarrier", {shippingGatewayConfigId})
                .map(row => row.carrierPartyId)
                .concat(
                    storeGateways
                        .filter(row => row.shippingGatewayConfigId === shippingGatewayConfigId)
                        .map(row => row.carrierPartyId)
                )
        )
        carriers.forEach(id => servedCarriers.add(id))
        const methods = carriers.size
            ? Array.from(
                  find(METHOD)
                      .condition("carrierPartyId", "in", [...carriers])
                      .orderBy("sequenceNum")
                      .list()
              )
            : []
        if (!methods.length) continue
        try {
            if (gateway.getShippingRatesBulkName) {
                const origin =
                    segment.originPostalContactMechId ||
                    call("mantle.facility.ContactServices.get#FacilityDefaultShipOrigin", {facilityId: sh.facilityId})
                        .postalContactMechId
                if (!origin || !segment.destPostalContactMechId)
                    denied("ADDRESS_REQUIRED", "The shipment needs both addresses to rate")
                const out = probe(gateway.getShippingRatesBulkName, {
                    shippingGatewayConfigId,
                    carrierShipmentMethodList: methods.map(row => ({
                        carrierPartyId: row.carrierPartyId,
                        shipmentMethodEnumId: row.shipmentMethodEnumId
                    })),
                    fromPartyId: sh.shipment.fromPartyId || sh.facility.ownerPartyId,
                    toPartyId: sh.shipment.toPartyId || sh.facility.ownerPartyId,
                    originFacilityId: sh.facilityId,
                    originPostalContactMechId: origin,
                    destPostalContactMechId: segment.destPostalContactMechId,
                    packageInfoList,
                    productStoreId: sh.shipment.productStoreId,
                    vendorPartyId: sh.shipment.fromPartyId,
                    currencyUomId: sh.shipment.costUomId || undefined
                })
                Array.from(out.shippingRateInfoList || []).forEach(row => add(row, "gateway", gateway))
            } else {
                for (const method of methods) {
                    const out = probe(gateway.getRateServiceName, {
                        shipmentId: sh.shipmentId,
                        shipmentRouteSegmentSeqId: segment.shipmentRouteSegmentSeqId,
                        shippingGatewayConfigId,
                        carrierPartyId: method.carrierPartyId,
                        shipmentMethodEnumId: method.shipmentMethodEnumId
                    })
                    if (out.shippingTotal != null)
                        add(Object.assign({}, out, method.getMap ? method.getMap() : method), "gateway", gateway)
                }
            }
        } catch (error) {
            const message = String(error?.message || error).replace(/^(Error: )+/, "")
            providerErrors.push({
                provider: gateway.description || shippingGatewayConfigId,
                reasonCode: reasonOf(message),
                message
            })
        }
    }

    // local rules: the methods of carriers no gateway serves here, over get#OrderShippingRateLocal and the shipment's order
    const localMethods = Array.from(find(METHOD).orderBy("sequenceNum").list()).filter(
        row =>
            row.carrierPartyId === "_NA_" ||
            (row.carrierPartyId === segment.carrierPartyId && !servedCarriers.has(row.carrierPartyId))
    )
    const source = Array.from(
        find("mantle.shipment.ShipmentItemSource", {shipmentId: sh.shipmentId})
            .condition("orderId", "is-not-null", null)
            .limit(1)
            .list()
    )[0]
    const orderItem = source
        ? one("mantle.order.OrderItem", {orderId: source.orderId, orderItemSeqId: source.orderItemSeqId})
        : null
    if (!orderItem) {
        if (localMethods.length)
            providerErrors.push({
                provider: "Local rules",
                reasonCode: "NO_ORDER",
                message: "Local rules rate an order's shipment; shipment " + sh.shipmentId + " has no order"
            })
    } else {
        for (const method of localMethods) {
            try {
                const out = probe("mantle.shipment.CarrierServices.get#OrderShippingRateLocal", {
                    orderId: orderItem.orderId,
                    orderPartSeqId: orderItem.orderPartSeqId,
                    shippingGatewayConfigId: "NA_LOCAL",
                    createOrderItem: false,
                    carrierPartyId: method.carrierPartyId,
                    shipmentMethodEnumId: method.shipmentMethodEnumId,
                    postalContactMechId: segment.destPostalContactMechId,
                    packageInfoList
                })
                const header = one("mantle.order.OrderHeader", {orderId: orderItem.orderId})
                add(
                    {
                        carrierPartyId: method.carrierPartyId,
                        shipmentMethodEnumId: method.shipmentMethodEnumId,
                        shippingTotal: out.shippingTotal,
                        currency: header?.currencyUomId,
                        serviceName: method.description || null
                    },
                    "local",
                    null
                )
            } catch (error) {
                const message = String(error?.message || error).replace(/^(Error: )+/, "")
                providerErrors.push({provider: "Local rules", reasonCode: reasonOf(message), message})
            }
        }
    }
    const weighed = packages.filter(row => number(row.weight) > 0)
    return {
        shipmentId: sh.shipmentId,
        facilityId: sh.facilityId,
        shipmentRouteSegmentSeqId: segment.shipmentRouteSegmentSeqId,
        carrierPartyId: segment.carrierPartyId || null,
        shipmentMethodEnumId: segment.shipmentMethodEnumId || null,
        packageCount: packages.length,
        weighedCount: weighed.length,
        totalWeight: text(weighed.reduce((sum, row) => sum + number(row.weight), 0)),
        rateRows,
        providerErrors
    }
}

// ===== the gateway requests =====
// record#ShippingGatewayRequests, in its own transaction: the shipment locked and every check made, the method chosen (when
// given) on the segment, and a request row per package that needs the gateway: a new one, or the earlier one that got no
// answer (Unknown, or Requested long ago), which is asked about first ('ask'); a package whose label is there (or, for a
// refund, has none) is answered at once.
function recordRequests(p) {
    const kind = kinds[p.kind]
    if (!kind) throw new Error("Unknown shipping gateway request " + p.kind)
    posting.requirePermission("SHIPMENT_SHIP")
    const sh = shipmentOf(posting.scope(), p.shipmentId, true)
    const status = sh.shipment.statusId
    if (p.kind === "label" && status !== "ShipPacked")
        denied(
            status === "ShipShipped" || status === "ShipDelivered" ? "SHIPMENT_SHIPPED" : "SHIPMENT_NOT_PACKED",
            "Shipment " + sh.shipmentId + " is " + status + ": labels are bought for a packed shipment that has not shipped"
        )
    if (p.kind !== "label" && !["ShipPacked", "ShipShipped", "ShipDelivered"].includes(status))
        denied("SHIPMENT_NOT_PACKED", "Shipment " + sh.shipmentId + " is " + status)
    let segment = segmentOf(sh, p.shipmentRouteSegmentSeqId)
    if (p.kind === "label" && (!blank(p.carrierPartyId) || !blank(p.shipmentMethodEnumId))) {
        const carrierPartyId = p.carrierPartyId || segment.carrierPartyId,
            shipmentMethodEnumId = p.shipmentMethodEnumId || segment.shipmentMethodEnumId
        if (!one(METHOD, {carrierPartyId, shipmentMethodEnumId}))
            denied("METHOD_INVALID", "Carrier " + carrierPartyId + " has no method " + shipmentMethodEnumId)
        if (!blank(p.shippingGatewayConfigId) && !one(GATEWAY, {shippingGatewayConfigId: p.shippingGatewayConfigId}))
            denied("GATEWAY_INVALID", "There is no shipping gateway " + p.shippingGatewayConfigId)
        call("update#" + SEGMENT, {
            shipmentId: sh.shipmentId,
            shipmentRouteSegmentSeqId: segment.shipmentRouteSegmentSeqId,
            carrierPartyId,
            shipmentMethodEnumId,
            shippingGatewayConfigId: blank(p.shippingGatewayConfigId)
                ? segment.shippingGatewayConfigId
                : p.shippingGatewayConfigId
        })
        segment = one(SEGMENT, {shipmentId: sh.shipmentId, shipmentRouteSegmentSeqId: segment.shipmentRouteSegmentSeqId})
    }
    const gateway = gatewayOf(sh.shipmentId, segment.shipmentRouteSegmentSeqId)
    const serviceField = p.kind === "refund" ? "refundLabelsServiceName" : "requestLabelsServiceName"
    if (!gateway || !gateway[serviceField])
        denied(
            "NO_GATEWAY",
            p.kind === "refund"
                ? "No shipping gateway refunds labels for this shipment"
                : "No shipping gateway buys labels for this method; record the tracking code and cost by hand"
        )
    const packages = packagesAsked(sh, p.shipmentPackageSeqId)
    if (p.kind !== "refund") {
        const unweighed = packages.filter(row => !(number(row.weight) > 0)).map(row => row.shipmentPackageSeqId)
        if (unweighed.length) denied("WEIGHT_REQUIRED", "Weigh package " + unweighed.join(", ") + " before buying its label")
    }
    const plan = packages.map(packageRow => planPackage(p.kind, sh.shipmentId, segment, gateway, packageRow, p.operationKey))
    return {
        kind: p.kind,
        shipmentId: sh.shipmentId,
        facilityId: sh.facilityId,
        organizationPartyId: sh.facility.ownerPartyId,
        shipmentRouteSegmentSeqId: segment.shipmentRouteSegmentSeqId,
        shippingGatewayConfigId: gateway.shippingGatewayConfigId,
        statusId: status,
        packages: plan
    }
}
// One package's place in a request: answered at once (its label is there, or for a refund is not; a call under way), the
// earlier request that got no answer to ask about first ('ask'), or a new request row ('send'). Inside the recording
// transaction, under the shipment's lock.
function planPackage(kindName, shipmentId, segment, gateway, packageRow, operationKey) {
    const kind = kinds[kindName]
    const routeSeg = routeSegOf(shipmentId, packageRow.shipmentPackageSeqId, segment.shipmentRouteSegmentSeqId)
    const item = {shipmentPackageSeqId: packageRow.shipmentPackageSeqId, requestId: null, mode: null, skipCode: null}
    const labelled = activeLabel(routeSeg, kind.returnLabels)
    if (kindName === "refund" && !labelled) item.skipCode = blank(routeSeg.gatewayRefundStatus) ? "NO_LABEL" : "ALREADY_REFUNDED"
    else if (kindName !== "refund" && labelled) item.skipCode = "LABEL_EXISTS"
    if (item.skipCode) return item
    const last = Array.from(
        find(REQUEST, {shipmentId, shipmentPackageSeqId: packageRow.shipmentPackageSeqId, requestTypeEnumId: kind.type})
            .orderBy("-requestDate")
            .orderBy("-shippingGatewayRequestId")
            .limit(1)
            .list()
    )[0]
    const age = last ? lib.ms(ec.user.nowTimestamp) - lib.ms(last.requestDate) : 0
    if (last?.statusId === "SgrqRequested" && age < inFlightMs) {
        item.skipCode = "REQUEST_IN_PROGRESS"
        return item
    }
    if (last && (last.statusId === "SgrqUnknown" || last.statusId === "SgrqRequested")) {
        // the earlier request got no answer: the gateway is asked about it first
        call("update#" + REQUEST, {
            shippingGatewayRequestId: last.shippingGatewayRequestId,
            statusId: "SgrqRequested",
            requestDate: ec.user.nowTimestamp,
            attemptCount: number(last.attemptCount) + 1,
            operationKey: operationKey || last.operationKey
        })
        return Object.assign(item, {requestId: last.shippingGatewayRequestId, mode: "ask"})
    }
    // a refunded label is replaced: its fields leave the package before the new one is bought
    if (kindName === "label" && !blank(routeSeg.gatewayRefundStatus))
        call("mantle.shipment.CarrierServices.remove#ShipmentLabelInfo", {
            shipmentId,
            shipmentPackageSeqId: packageRow.shipmentPackageSeqId,
            shipmentRouteSegmentSeqId: segment.shipmentRouteSegmentSeqId
        })
    const made = call("create#" + REQUEST, {
        requestTypeEnumId: kind.type,
        statusId: "SgrqRequested",
        shippingGatewayConfigId: gateway.shippingGatewayConfigId,
        shipmentId,
        shipmentRouteSegmentSeqId: segment.shipmentRouteSegmentSeqId,
        shipmentPackageSeqId: packageRow.shipmentPackageSeqId,
        carrierPartyId: segment.carrierPartyId,
        shipmentMethodEnumId: segment.shipmentMethodEnumId,
        operationKey: operationKey || null,
        userId: ec.user.userId,
        requestDate: ec.user.nowTimestamp,
        attemptCount: 1
    })
    return Object.assign(item, {requestId: made.shippingGatewayRequestId, mode: "send"})
}
// The answer of a request written to its row, in its own transaction.
function settleRequest(requestId, statusId, fields = {}) {
    probe(
        "update#" + REQUEST,
        Object.assign({shippingGatewayRequestId: requestId, statusId, responseDate: ec.user.nowTimestamp}, fields)
    )
}
// One package's request sent (or asked about) with no transaction of ours open: the gateway's own work commits in a
// transaction of its own, so nothing rolls back after the gateway answered.
function sendOne(plan, item) {
    const kind = kinds[plan.kind]
    const key = {
        shipmentId: plan.shipmentId,
        shipmentPackageSeqId: item.shipmentPackageSeqId,
        shipmentRouteSegmentSeqId: plan.shipmentRouteSegmentSeqId
    }
    const out = {shipmentPackageSeqId: item.shipmentPackageSeqId, requestId: item.requestId}
    if (item.skipCode)
        return Object.assign(out, {
            state: item.skipCode === "REQUEST_IN_PROGRESS" ? "pending" : "skipped",
            reasonCode: item.skipCode
        })
    const gateway = one(GATEWAY, {shippingGatewayConfigId: plan.shippingGatewayConfigId})
    const done = () => {
        const routeSeg = one(ROUTE_SEG, key)
        if (plan.kind === "refund") return routeSeg && !blank(routeSeg.gatewayRefundStatus)
        return activeLabel(routeSeg, kind.returnLabels)
    }
    const succeed = asked => {
        const routeSeg = one(ROUTE_SEG, key)
        const r = kind.returnLabels ? "return" : ""
        const value = name => routeSeg?.[r ? r + name.charAt(0).toUpperCase() + name.slice(1) : name] ?? null
        settleRequest(item.requestId, "SgrqSucceeded", {
            trackingCode: value("trackingCode"),
            gatewayLabelId: value("gatewayLabelId"),
            amount: kind.returnLabels ? routeSeg?.returnEstimatedAmount : (routeSeg?.actualAmount ?? routeSeg?.estimatedAmount),
            reasonCode: null,
            resultMessage: asked ? "Found at the gateway after an earlier request got no answer" : null
        })
        return Object.assign(out, {state: "done", recovered: !!asked, trackingCode: value("trackingCode")})
    }
    // ask first: the earlier request may have been done by the gateway though its answer was lost
    if (item.mode === "ask" && gateway?.findLabelServiceName) {
        try {
            const found = probe(
                gateway.findLabelServiceName,
                Object.assign({}, key, {
                    shippingGatewayConfigId: gateway.shippingGatewayConfigId,
                    requestReference: item.requestId,
                    getReturnLabels: kind.returnLabels
                })
            )
            if (plan.kind === "refund" ? found.refunded : found.found && !found.refunded) {
                if (plan.kind === "refund")
                    probe("update#" + ROUTE_SEG, Object.assign({}, key, {gatewayRefundStatus: "refunded"}))
                if (done()) return succeed(true)
            }
        } catch (error) {
            const message = String(error?.message || error).replace(/^(Error: )+/, "")
            settleRequest(item.requestId, "SgrqUnknown", {
                reasonCode: reasonOf(message),
                resultMessage: "Asking the gateway failed: " + message
            })
            return Object.assign(out, {state: "unknown", reasonCode: reasonOf(message), message})
        }
    }
    try {
        if (plan.kind === "refund")
            probe(
                "mantle.shipment.CarrierServices.refund#ShipmentLabels",
                Object.assign({}, key, {requestReference: item.requestId})
            )
        else
            probe(
                "mantle.shipment.CarrierServices.request#ShipmentLabels",
                Object.assign({}, key, {getReturnLabels: kind.returnLabels, requestReference: item.requestId})
            )
    } catch (error) {
        const message = String(error?.message || error).replace(/^(Error: )+/, "")
        const reasonCode = reasonOf(message)
        const definite = refusals.includes(reasonCode)
        settleRequest(item.requestId, definite ? "SgrqFailed" : "SgrqUnknown", {reasonCode, resultMessage: message})
        return Object.assign(out, {state: definite ? "failed" : "unknown", reasonCode, message})
    }
    if (done()) return succeed(false)
    settleRequest(item.requestId, "SgrqFailed", {reasonCode: "NO_ANSWER", resultMessage: "The gateway answered with no label"})
    return Object.assign(out, {state: "failed", reasonCode: "NO_ANSWER", message: "The gateway answered with no label"})
}
function summary(plan, results) {
    const count = state => results.filter(row => row.state === state).length
    const doneCount = count("done") + count("skipped")
    const unknownCount = count("unknown") + count("pending")
    const failedCount = count("failed")
    const word = plan.kind === "refund" ? "REFUNDED" : "LABELED"
    return {
        resultCode: unknownCount ? "PENDING" : failedCount ? (doneCount ? "PARTIAL" : "FAILED") : word,
        shipmentId: plan.shipmentId,
        shipmentRouteSegmentSeqId: plan.shipmentRouteSegmentSeqId,
        shippingGatewayConfigId: plan.shippingGatewayConfigId,
        statusId: one(SHIPMENT, {shipmentId: plan.shipmentId})?.statusId,
        packages: results,
        doneCount,
        failedCount,
        unknownCount
    }
}
// request#PackageLabels and refund#PackageLabels: begin (the permission, the operation key), record in a transaction of its
// own, send each package, and complete the operation when nothing is left without an answer.
function gatewayRequest(p, kindName, operationType) {
    const begun = posting.begin(p, operationType, "SHIPMENT_SHIP", [
        "shipmentId",
        "shipmentPackageSeqId",
        "shipmentRouteSegmentSeqId",
        "carrierPartyId",
        "shipmentMethodEnumId",
        "shippingGatewayConfigId"
    ])
    if (begun.previous) return begun.previous
    const plan = probe(T + "record#ShippingGatewayRequests", Object.assign({}, p, {kind: kindName})).plan
    const results = []
    for (const item of plan.packages) {
        try {
            results.push(sendOne(plan, item))
        } catch (error) {
            const message = String(error?.message || error)
            ec.logger.error("Shipping gateway request " + item.requestId + " of " + plan.shipmentId + ": " + message)
            results.push({
                shipmentPackageSeqId: item.shipmentPackageSeqId,
                requestId: item.requestId,
                state: "unknown",
                reasonCode: "FAILED",
                message
            })
        }
    }
    return finish(begun.op, plan, summary(plan, results))
}
// The operation completed in its own transaction, unless a package is left without an answer: a retry under the same key
// then asks the gateway again instead of answering this.
function finish(op, plan, answer) {
    if (answer.unknownCount)
        return Object.assign({operationKey: op.clientKey, operationType: op.operationType, alreadyApplied: false}, answer)
    try {
        return probe(T + "finish#ShippingGatewayRequests", {
            op,
            organizationPartyId: plan.organizationPartyId,
            resultId: plan.shipmentId,
            answer
        }).result
    } catch (error) {
        ec.logger.warn("Shipping operation " + op.clientKey + " was not stored: " + error.message)
        return Object.assign({operationKey: op.clientKey, operationType: op.operationType, alreadyApplied: false}, answer)
    }
}
function finishRequests(p) {
    posting.requirePermission(["SHIPMENT_SHIP", "RETURN_AUTHORIZE"])
    const op = p.op
    if (!op?.operationKey || op.operationKey.indexOf("WH") !== 0) denied("OPERATION_KEY_REQUIRED", "An operation is required")
    op.old = null
    return {result: posting.complete(op, p.organizationPartyId, SHIPMENT, p.resultId, p.answer)}
}

// ===== tracking (PackageTracking) =====
// A refresh of each shipment's tracking through its gateway, each its own request row and transaction: a shipment that
// fails is named and the others go on. Tracking never ships, unships or delivers anything by itself beyond Mantle's
// ShipmentPackageDeliveredCheckShipment when the carrier reports every package delivered.
function track(p) {
    posting.requirePermission("SHIPMENT_SHIP")
    const userScope = posting.scope()
    const shipmentIds = [...new Set(Array.from(p.shipmentIds || []).concat(blank(p.shipmentId) ? [] : [p.shipmentId]))].sort()
    if (!shipmentIds.length) denied("RECORD_REQUIRED", "Choose a shipment to refresh")
    const results = []
    for (const shipmentId of shipmentIds) {
        try {
            const sh = shipmentOf(userScope, shipmentId, false)
            const segment = segmentOf(sh, null)
            const gateway = gatewayOf(shipmentId, segment.shipmentRouteSegmentSeqId)
            if (!gateway?.trackLabelsServiceName) {
                results.push({shipmentId, ok: false, reasonCode: "NO_GATEWAY", message: "No gateway tracks this shipment"})
                continue
            }
            const made = probe("create#" + REQUEST, {
                requestTypeEnumId: "SgrTrack",
                statusId: "SgrqRequested",
                shippingGatewayConfigId: gateway.shippingGatewayConfigId,
                shipmentId,
                shipmentRouteSegmentSeqId: segment.shipmentRouteSegmentSeqId,
                userId: ec.user.userId,
                requestDate: ec.user.nowTimestamp,
                attemptCount: 1
            })
            try {
                probe("mantle.shipment.CarrierServices.track#ShipmentLabels", {
                    shipmentId,
                    shipmentRouteSegmentSeqId: segment.shipmentRouteSegmentSeqId
                })
            } catch (error) {
                const message = String(error?.message || error).replace(/^(Error: )+/, "")
                settleRequest(made.shippingGatewayRequestId, "SgrqUnknown", {
                    reasonCode: reasonOf(message),
                    resultMessage: message
                })
                results.push({shipmentId, ok: false, reasonCode: reasonOf(message), message})
                continue
            }
            settleRequest(made.shippingGatewayRequestId, "SgrqSucceeded")
            const routeSegs = rows(ROUTE_SEG, {shipmentId, shipmentRouteSegmentSeqId: segment.shipmentRouteSegmentSeqId})
            results.push({
                shipmentId,
                ok: true,
                statusId: one(SHIPMENT, {shipmentId}).statusId,
                packages: routeSegs.map(row => ({
                    shipmentPackageSeqId: row.shipmentPackageSeqId,
                    trackingStatusEnumId: row.trackingStatusEnumId,
                    trackingEta: row.trackingEta
                }))
            })
        } catch (error) {
            const message = String(error?.message || error).replace(/^(Error: )+/, "")
            results.push({shipmentId, ok: false, reasonCode: reasonOf(message), message})
        }
    }
    return {results, okCount: results.filter(row => row.ok).length, failedCount: results.filter(row => !row.ok).length}
}

// ===== the manual carrier (ManualCarrier) =====
// A package's tracking code and the segment's actual cost when the method has no gateway that buys labels.
function manualTracking(p) {
    const begun = posting.begin(p, "ShipmentManualTracking", "SHIPMENT_SHIP", [
        "shipmentId",
        "shipmentPackageSeqId",
        "trackingCode",
        "actualCost",
        "costUomId",
        "carrierPartyId",
        "shipmentMethodEnumId"
    ])
    if (begun.previous) return begun.previous
    const sh = shipmentOf(posting.scope(), p.shipmentId, true)
    if (sh.shipment.statusId !== "ShipPacked")
        denied(
            finalStatuses.includes(sh.shipment.statusId) ? "SHIPMENT_SHIPPED" : "SHIPMENT_NOT_PACKED",
            "Shipment " + sh.shipmentId + " is " + sh.shipment.statusId + ": tracking is recorded on a packed shipment"
        )
    const settledAnswer = posting.settled(begun.op)
    if (settledAnswer) return settledAnswer
    let segment = segmentOf(sh, p.shipmentRouteSegmentSeqId)
    const carrierPartyId = p.carrierPartyId || segment.carrierPartyId,
        shipmentMethodEnumId = p.shipmentMethodEnumId || segment.shipmentMethodEnumId
    if (!carrierPartyId || !shipmentMethodEnumId) denied("METHOD_REQUIRED", "Choose the carrier and its method")
    if (!one(METHOD, {carrierPartyId, shipmentMethodEnumId}))
        denied("METHOD_INVALID", "Carrier " + carrierPartyId + " has no method " + shipmentMethodEnumId)
    if (carrierPartyId !== segment.carrierPartyId || shipmentMethodEnumId !== segment.shipmentMethodEnumId)
        call("update#" + SEGMENT, {
            shipmentId: sh.shipmentId,
            shipmentRouteSegmentSeqId: segment.shipmentRouteSegmentSeqId,
            carrierPartyId,
            shipmentMethodEnumId
        })
    const gateway = gatewayOf(sh.shipmentId, segment.shipmentRouteSegmentSeqId)
    const gatewayCarriers = gateway
        ? rows("mantle.shipment.carrier.ShippingGatewayCarrier", {shippingGatewayConfigId: gateway.shippingGatewayConfigId}).map(
              row => row.carrierPartyId
          )
        : []
    if (gateway?.requestLabelsServiceName && (gatewayCarriers.includes(carrierPartyId) || !gatewayCarriers.length))
        denied(
            "GATEWAY_LABELS",
            "Gateway " + (gateway.description || gateway.shippingGatewayConfigId) + " buys this method's labels; request them"
        )
    if (blank(p.trackingCode)) denied("TRACKING_REQUIRED", "Give the carrier's tracking code")
    const packages = packagesAsked(sh, p.shipmentPackageSeqId)
    const cost = blank(p.actualCost) ? null : number(p.actualCost)
    if (cost != null && !(cost >= 0)) denied("COST_INVALID", "The cost is not an amount")
    let costUomId = p.costUomId || segment.costUomId || sh.shipment.costUomId
    if (cost != null && !costUomId)
        costUomId = call("mantle.ledger.LedgerServices.find#PartyAcctgPreference", {
            organizationPartyId: sh.facility.ownerPartyId
        }).partyAcctgPreference?.baseCurrencyUomId
    if (cost != null && !costUomId) denied("CURRENCY_REQUIRED", "Choose the cost's currency")
    for (const packageRow of packages) {
        routeSegOf(sh.shipmentId, packageRow.shipmentPackageSeqId, segment.shipmentRouteSegmentSeqId)
        call("mantle.shipment.ShipmentServices.update#ShipmentPackageAndRouteSeg", {
            shipmentId: sh.shipmentId,
            shipmentPackageSeqId: packageRow.shipmentPackageSeqId,
            shipmentRouteSegmentSeqId: segment.shipmentRouteSegmentSeqId,
            trackingCode: String(p.trackingCode).trim()
        })
    }
    if (cost != null)
        call("update#" + SEGMENT, {
            shipmentId: sh.shipmentId,
            shipmentRouteSegmentSeqId: segment.shipmentRouteSegmentSeqId,
            actualCost: cost,
            costUomId
        })
    return posting.complete(begun.op, sh.facility.ownerPartyId, SHIPMENT, sh.shipmentId, {
        resultCode: "TRACKING_RECORDED",
        shipmentId: sh.shipmentId,
        shipmentRouteSegmentSeqId: segment.shipmentRouteSegmentSeqId,
        packages: packages.map(row => row.shipmentPackageSeqId),
        trackingCode: String(p.trackingCode).trim(),
        carrierPartyId,
        shipmentMethodEnumId,
        actualCost: cost == null ? null : text(cost),
        costUomId: cost == null ? null : costUomId
    })
}

// ===== delivery (RecordDelivery) =====
// A package's delivery recorded by hand when no carrier event exists, with who received it or the evidence: the package's
// tracking status Delivered on its route segments, so Mantle's ShipmentPackageDeliveredCheckShipment delivers the shipment
// once every package is.
function packageDelivery(p) {
    const begun = posting.begin(p, "ShipmentPackageDelivery", "SHIPMENT_SHIP", [
        "shipmentId",
        "shipmentPackageSeqId",
        "deliveredDate",
        "recipientName",
        "note"
    ])
    if (begun.previous) return begun.previous
    const sh = shipmentOf(posting.scope(), p.shipmentId, true)
    if (sh.shipment.statusId !== "ShipShipped")
        denied(
            sh.shipment.statusId === "ShipDelivered" ? "ALREADY_DELIVERED" : "NOT_SHIPPED",
            "Shipment " + sh.shipmentId + " is " + sh.shipment.statusId + ": delivery is recorded on a shipped shipment"
        )
    const settledAnswer = posting.settled(begun.op)
    if (settledAnswer) return settledAnswer
    if (blank(p.recipientName) && blank(p.note))
        denied("EVIDENCE_REQUIRED", "Name who received the package, or say what shows it was delivered")
    const delivered = p.deliveredDate ? lib.ms(p.deliveredDate) : lib.ms(ec.user.nowTimestamp)
    if (delivered > lib.ms(ec.user.nowTimestamp) + 60000) denied("DATE_INVALID", "A delivery cannot be in the future")
    const shipped = sh.segments[0]?.actualStartDate ? lib.ms(sh.segments[0].actualStartDate) : null
    if (shipped != null && delivered < shipped) denied("DATE_INVALID", "A delivery cannot be before the shipment shipped")
    const packages = packagesAsked(sh, p.shipmentPackageSeqId)
    const routeSegs = rows(ROUTE_SEG, {shipmentId: sh.shipmentId}).filter(row =>
        packages.some(item => item.shipmentPackageSeqId === row.shipmentPackageSeqId)
    )
    if (routeSegs.length && routeSegs.every(row => row.trackingStatusEnumId === "ShTsDelivered"))
        denied("ALREADY_DELIVERED", "The package is already delivered")
    for (const packageRow of packages) {
        const segmentRows = routeSegs.filter(row => row.shipmentPackageSeqId === packageRow.shipmentPackageSeqId)
        const targets = segmentRows.length
            ? segmentRows
            : [
                  routeSegOf(
                      sh.shipmentId,
                      packageRow.shipmentPackageSeqId,
                      sh.segments[sh.segments.length - 1].shipmentRouteSegmentSeqId
                  )
              ]
        for (const routeSeg of targets)
            call("update#" + ROUTE_SEG, {
                shipmentId: routeSeg.shipmentId,
                shipmentPackageSeqId: routeSeg.shipmentPackageSeqId,
                shipmentRouteSegmentSeqId: routeSeg.shipmentRouteSegmentSeqId,
                trackingStatusEnumId: "ShTsDelivered",
                trackingStatusDate: new Date(delivered),
                trackingSubStatus: "Recorded by hand",
                deliveryRecipientName: blank(p.recipientName) ? null : String(p.recipientName).trim(),
                deliveryNote: blank(p.note) ? null : String(p.note).trim(),
                deliveryRecordedByUserId: ec.user.userId,
                deliveryRecordedDate: ec.user.nowTimestamp
            })
    }
    const after = one(SHIPMENT, {shipmentId: sh.shipmentId})
    return posting.complete(begun.op, sh.facility.ownerPartyId, SHIPMENT, sh.shipmentId, {
        resultCode: "DELIVERY_RECORDED",
        shipmentId: sh.shipmentId,
        packages: packages.map(row => row.shipmentPackageSeqId),
        statusId: after.statusId,
        shipmentDelivered: after.statusId === "ShipDelivered"
    })
}

// ===== dispatch (ShipConfirm) =====
// What keeps a packed shipment from shipping: a package with no tracking (a label not refunded, or a code recorded by hand;
// a customer pick-up needs none), packages that do not hold what was issued, issued stock held for an inspection or under
// an open inspection of the shipment, and expired issued stock where the expiry gate blocks it (P5b's gate, by the stock's
// own policy). Each blocker is named.
function shipBlockers(sh) {
    const segment = sh.segments[0]
    const packages = packagesOf(sh.shipmentId)
    const contents = rows(CONTENT, {shipmentId: sh.shipmentId})
    const issuances = rows(ISSUANCE, {shipmentId: sh.shipmentId}).filter(row => number(row.quantity) > 0)
    const blockers = []
    if (!packages.length) blockers.push({code: "NO_PACKAGES", message: "The shipment has no package"})
    const empty = packages.filter(row => !contents.some(item => item.shipmentPackageSeqId === row.shipmentPackageSeqId))
    if (empty.length)
        blockers.push({
            code: "EMPTY_PACKAGE",
            message: "Package " + empty.map(row => row.shipmentPackageSeqId).join(", ") + " is empty"
        })
    // tracking totals: a tracking code on every package (a pick-up needs none)
    if (segment?.shipmentMethodEnumId !== "ShMthPickUp") {
        const untracked = packages.filter(row => {
            const routeSeg = one(ROUTE_SEG, {
                shipmentId: sh.shipmentId,
                shipmentPackageSeqId: row.shipmentPackageSeqId,
                shipmentRouteSegmentSeqId: segment.shipmentRouteSegmentSeqId
            })
            return !routeSeg || blank(routeSeg.trackingCode) || !blank(routeSeg.gatewayRefundStatus)
        })
        if (untracked.length)
            blockers.push({
                code: "TRACKING_REQUIRED",
                message: "Package " + untracked.map(row => row.shipmentPackageSeqId).join(", ") + " has no label or tracking code"
            })
    }
    // the packages hold what was issued, product by product
    const issued = new Map(),
        packed = new Map()
    issuances.forEach(row => issued.set(row.productId, (issued.get(row.productId) || 0) + number(row.quantity)))
    contents.forEach(row => packed.set(row.productId, (packed.get(row.productId) || 0) + number(row.quantity)))
    const mismatched = [...new Set([...issued.keys(), ...packed.keys()])].filter(
        productId => Math.abs((issued.get(productId) || 0) - (packed.get(productId) || 0)) > 0.000001
    )
    if (mismatched.length)
        blockers.push({
            code: "PACKAGE_TOTALS",
            message:
                "Packages and issued stock differ: " +
                mismatched.map(id => id + " issued " + text(issued.get(id)) + ", packed " + text(packed.get(id))).join("; ")
        })
    // inspection release
    const assetIds = [...new Set(issuances.map(row => row.assetId).filter(Boolean))].sort()
    const held = assetIds.length
        ? Array.from(
              find("mantle.product.asset.Asset")
                  .condition("assetId", "in", assetIds)
                  .condition("statusId", "AstQuarantine")
                  .list()
          )
        : []
    const openStatuses = ["QiDraft", "QiSubmitted", "QiVerified"]
    const inspected = assetIds.length
        ? Array.from(
              find("mantle.product.quality.QualityInspection")
                  .condition("assetId", "in", assetIds)
                  .condition("statusId", "in", openStatuses)
                  .condition("heldQuantity", "greater", 0)
                  .list()
          )
        : []
    const shipmentInspections = rows("mantle.product.quality.QualityInspection", {shipmentId: sh.shipmentId}).filter(row =>
        openStatuses.includes(row.statusId)
    )
    const holds = [...new Set(held.map(row => row.assetId).concat(inspected.map(row => row.assetId)))]
    if (holds.length) blockers.push({code: "INSPECTION_HOLD", message: "Stock " + holds.join(", ") + " is held for inspection"})
    if (shipmentInspections.length)
        blockers.push({
            code: "INSPECTION_HOLD",
            message:
                "Inspection " + shipmentInspections.map(row => row.qualityInspectionId).join(", ") + " of the shipment is open"
        })
    // expiry: P5b's gate, by each issued asset's own policy (off by default)
    for (const assetId of assetIds) {
        try {
            probe("mantle.facility.WarehousePolicyServices.check#AssetExpiryGate", {assetId})
        } catch (error) {
            const message = String(error?.message || error).replace(/^(Error: )+/, "")
            blockers.push({code: reasonOf(message) === "FAILED" ? "ASSET_EXPIRED" : reasonOf(message), message})
        }
    }
    return blockers
}
function ship(p) {
    const begun = posting.begin(p, "ShipmentShip", "SHIPMENT_SHIP", ["shipmentId", "actualStartDate"])
    if (begun.previous) return begun.previous
    const userScope = posting.scope()
    const sh = shipmentOf(userScope, p.shipmentId, true)
    if (shippedElsewhere[sh.shipment.shipmentTypeEnumId])
        denied(
            "SHIPPED_ELSEWHERE",
            "Shipment " + sh.shipmentId + " ships through " + shippedElsewhere[sh.shipment.shipmentTypeEnumId]
        )
    if (sh.shipment.statusId !== "ShipPacked")
        denied(
            finalStatuses.includes(sh.shipment.statusId) ? "SHIPMENT_SHIPPED" : "SHIPMENT_NOT_PACKED",
            "Shipment " + sh.shipmentId + " is " + sh.shipment.statusId + ": complete pack first"
        )
    const settledAnswer = posting.settled(begun.op)
    if (settledAnswer) return settledAnswer
    const blockers = shipBlockers(sh)
    if (blockers.length)
        denied(
            blockers[0].code,
            blockers.map((row, index) => (index && row.code !== blockers[0].code ? row.code + ": " : "") + row.message).join("; ")
        )
    const shipDate = p.actualStartDate || ec.user.nowTimestamp
    if (lib.ms(shipDate) > lib.ms(ec.user.nowTimestamp) + 60000) denied("DATE_INVALID", "A shipment cannot ship in the future")
    // shipping finalizes the pack invoice behind D3's flag, which posts: its period checked without locking (as a pack)
    posting.period([sh.facility.ownerPartyId], shipDate, {lock: false})
    call("mantle.shipment.ShipmentServices.ship#Shipment", {shipmentId: sh.shipmentId, actualStartDate: shipDate})
    const after = one(SHIPMENT, {shipmentId: sh.shipmentId})
    if (after.statusId !== "ShipShipped")
        denied("SHIP_FAILED", "Shipment " + sh.shipmentId + " is " + after.statusId + ", not shipped")
    const routeSegs = rows(ROUTE_SEG, {
        shipmentId: sh.shipmentId,
        shipmentRouteSegmentSeqId: sh.segments[0].shipmentRouteSegmentSeqId
    })
    return posting.complete(begun.op, sh.facility.ownerPartyId, SHIPMENT, sh.shipmentId, {
        resultCode: "SHIPPED",
        shipmentId: sh.shipmentId,
        statusId: after.statusId,
        facilityId: sh.facilityId,
        packageCount: routeSegs.length,
        trackingCodes: routeSegs.map(row => row.trackingCode).filter(Boolean),
        invoices: [...new Set(rows("mantle.order.OrderItemBilling", {shipmentId: sh.shipmentId}).map(row => row.invoiceId))]
            .sort()
            .map(invoiceId => ({invoiceId, statusId: one("mantle.account.invoice.Invoice", {invoiceId})?.statusId}))
    })
}
// ShipConfirm's summary, read only: what ships and what blocks it.
function shipReadiness(p) {
    posting.requirePermission(["SHIPMENT_SHIP", "SHIPMENT_PACK"])
    const sh = shipmentOf(posting.scope(), p.shipmentId, false)
    const blockers = sh.shipment.statusId === "ShipPacked" ? shipBlockers(sh) : []
    return {
        shipmentId: sh.shipmentId,
        statusId: sh.shipment.statusId,
        canShip: sh.shipment.statusId === "ShipPacked" && !blockers.length && !shippedElsewhere[sh.shipment.shipmentTypeEnumId],
        blockers
    }
}

const operations = {rates, recordRequests, finishRequests, track, manualTracking, packageDelivery, ship, shipReadiness}
;({
    activeLabel,
    planPackage,
    gatewayOf,
    gatewayView,
    routeSegOf,
    sendOne,
    settleRequest,
    summary,
    finish,
    requestLabels: p => gatewayRequest(p, truthy(p.returnLabels) ? "returnLabel" : "label", "ShipmentLabelRequest"),
    refundLabels: p => gatewayRequest(p, "refund", "ShipmentLabelRefund"),
    execute(op, parameters) {
        if (op === "requestLabels") return this.requestLabels(parameters)
        if (op === "refundLabels") return this.refundLabels(parameters)
        if (!operations[op]) throw new Error("Unknown shipping operation " + op)
        return operations[op](parameters)
    }
})
