// The Mantle test carrier (mantle.shipment.carrier.TestGatewayServices; impl-warehouse §4, F14; design-warehouse §12
// Carriers): a shipping gateway that implements every carrier interface deterministically, for specs, demos and Carriers'
// CarrierTest. Rates are by weight and a zone table (the zone from the first digits of the two postal codes); a label is a
// PDF with the tracking number as a Code 128 barcode (the framework's barcodes, Products P11), recorded in TestCarrierLabel
// in its own transaction as a carrier keeps its own record; refund, tracking and address validation work on that record.
// Reserved postal codes on either address of the route segment set off what a real carrier does on a bad day:
//   99901  the label is issued but the answer is lost (CARRIER_TIMEOUT); the carrier has it when asked later
//   99902  the label is refused (LABEL_REFUSED)
//   99903  the address is invalid (ADDRESS_INVALID; validation marks it CmtlInvalid)
// A request that repeats a reference the carrier already issued a label for answers that label and buys no second one.
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const {find, one, rows, denied, call, probe} = lib

const LABEL = "mantle.shipment.carrier.TestCarrierLabel",
    ROUTE_SEG = "mantle.shipment.ShipmentPackageRouteSeg",
    SEGMENT = "mantle.shipment.ShipmentRouteSegment",
    PACKAGE = "mantle.shipment.ShipmentPackage",
    POSTAL = "mantle.party.contact.PostalAddress"
const reserved = {timeout: "99901", refused: "99902", invalid: "99903"}
// the service of each method: a base charge, a charge per pound (rounded up), and the days in zone 1
const methods = {
    ShMthGround: {base: 6, perPound: 0.5, days: 3},
    ShMthSecondDay: {base: 12, perPound: 1.1, days: 2},
    ShMthNextDay: {base: 22, perPound: 2, days: 1}
}
// the zone table: a rate's factor by zone (1 to 9)
const zoneFactors = [1, 1, 1.1, 1.2, 1.3, 1.4, 1.55, 1.7, 1.85, 2]

const blank = value => value == null || String(value).trim() === ""
const number = value => (value == null || value === "" ? 0 : Number(String(value)))
const money = value => Math.round(value * 100) / 100
const truthy = value => value === true || value === "true" || value === "Y"

function postalCodeOf(contactMechId) {
    return blank(contactMechId) ? "" : String(one(POSTAL, {contactMechId})?.postalCode || "")
}
function segmentOf(p) {
    const segment = one(SEGMENT, {shipmentId: p.shipmentId, shipmentRouteSegmentSeqId: p.shipmentRouteSegmentSeqId})
    if (!segment) denied("RECORD_UNAVAILABLE", "Route segment " + p.shipmentRouteSegmentSeqId + " is not on " + p.shipmentId)
    return segment
}
function originPostalOf(segment) {
    if (segment.originPostalContactMechId) return segment.originPostalContactMechId
    if (!segment.originFacilityId) return null
    return call("mantle.facility.ContactServices.get#FacilityDefaultShipOrigin", {facilityId: segment.originFacilityId})
        .postalContactMechId
}
// the postal codes of the segment's two ends, and the zone between them
function endsOf(segment) {
    const origin = postalCodeOf(originPostalOf(segment))
    const destination = postalCodeOf(segment.destPostalContactMechId)
    return {origin, destination, zone: zoneOf(origin, destination)}
}
function zoneOf(origin, destination) {
    const first = code => (/^\d/.test(code) ? Number(code[0]) : 0)
    return Math.min(9, 1 + Math.abs(first(origin) - first(destination)))
}
function reservedHit(ends, kind) {
    return [ends.origin, ends.destination].some(code => code.startsWith(reserved[kind]))
}
// a weight in pounds
function pounds(weight, weightUomId) {
    const value = number(weight)
    if (!weightUomId || weightUomId === "WT_lb") return value
    const converted = call("org.moqui.impl.BasicServices.convert#Uom", {uomId: weightUomId, toUomId: "WT_lb", amount: value})
    return number(converted.convertedAmount)
}
function rateOf(methodId, weightPounds, zone) {
    const method = methods[methodId]
    if (!method) return null
    return money((method.base + method.perPound * Math.max(1, Math.ceil(weightPounds))) * zoneFactors[zone])
}
const daysOf = (methodId, zone) =>
    methods[methodId] ? methods[methodId].days + (methodId === "ShMthGround" ? Math.floor(zone / 3) : 0) : null
const carriersOf = shippingGatewayConfigId =>
    rows("mantle.shipment.carrier.ShippingGatewayCarrier", {shippingGatewayConfigId}).map(row => row.carrierPartyId)

// ===== rates =====
// get#ShippingRatesBulk: each asked method of a carrier this gateway serves, the sum of its packages' rates
function ratesBulk(p) {
    const origin = postalCodeOf(p.originPostalContactMechId)
    const destination = postalCodeOf(p.destPostalContactMechId)
    const ends = {origin, destination, zone: zoneOf(origin, destination)}
    if (reservedHit(ends, "invalid")) return {shippingRateInfoList: []}
    const packages = Array.from(p.packageInfoList || [])
    if (!packages.length || packages.some(row => !(number(row.weight) > 0))) return {shippingRateInfoList: []}
    const carriers = carriersOf(p.shippingGatewayConfigId)
    const shippingRateInfoList = []
    for (const method of Array.from(p.carrierShipmentMethodList || [])) {
        if (!carriers.includes(method.carrierPartyId) || !methods[method.shipmentMethodEnumId]) continue
        const total = packages.reduce(
            (sum, row) => sum + rateOf(method.shipmentMethodEnumId, pounds(row.weight, row.weightUomId), ends.zone),
            0
        )
        shippingRateInfoList.push({
            carrierPartyId: method.carrierPartyId,
            shipmentMethodEnumId: method.shipmentMethodEnumId,
            shippingTotal: String(money(total)),
            currency: p.currencyUomId || "USD",
            days: daysOf(method.shipmentMethodEnumId, ends.zone),
            serviceName: "Test " + method.shipmentMethodEnumId.replace(/^ShMth/, "") + " (zone " + ends.zone + ")"
        })
    }
    return {shippingRateInfoList}
}
// get#ShippingRate: the shipment's packages (or one), at the segment's method or the one given
function rate(p) {
    const segment = segmentOf(p)
    const ends = endsOf(segment)
    if (reservedHit(ends, "invalid")) denied("ADDRESS_INVALID", "The test carrier does not deliver to " + ends.destination)
    const methodId = p.shipmentMethodEnumId || segment.shipmentMethodEnumId
    if (!methods[methodId]) denied("METHOD_UNAVAILABLE", "The test carrier has no " + (methodId || "method"))
    const packages = rows(PACKAGE, {shipmentId: p.shipmentId}).filter(
        row => blank(p.shipmentPackageSeqId) || row.shipmentPackageSeqId === p.shipmentPackageSeqId
    )
    if (!packages.length) denied("NO_PACKAGES", "Shipment " + p.shipmentId + " has no package to rate")
    const unweighed = packages.filter(row => !(number(row.weight) > 0)).map(row => row.shipmentPackageSeqId)
    if (unweighed.length) denied("WEIGHT_REQUIRED", "Weigh package " + unweighed.join(", ") + " before rating it")
    const total = packages.reduce((sum, row) => sum + rateOf(methodId, pounds(row.weight, row.weightUomId), ends.zone), 0)
    return {
        shippingTotal: String(money(total)),
        currency: "USD",
        days: daysOf(methodId, ends.zone),
        serviceName: "Test " + methodId
    }
}

// ===== labels =====
// The label PDF: the addresses, the method and weight, and the tracking number as a Code 128 barcode drawn from the
// framework's barcode (its bars, in millimetres, become filled rectangles in points), on a 4 by 6 inch page.
function pdfText(value) {
    return String(value ?? "")
        .replace(/[^\x20-\x7e]/g, "?")
        .replace(/([\\()])/g, "\\$1")
}
function labelPdf(label) {
    const width = 288,
        height = 432,
        point = 72 / 25.4
    const svg = ec.resource.barcodeSvg("Code128", label.trackingCode, {
        moduleWidth: 0.33,
        height: 22,
        quietZone: 10,
        humanReadable: false
    })
    const bars = []
    const rect = /<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)"\/>/g
    let match
    while ((match = rect.exec(svg))) {
        const [x, y, w, h] = match.slice(1).map(Number)
        const top = 230
        bars.push(
            [18 + x * point, top - (y + h) * point, w * point, h * point].map(value => value.toFixed(2)).join(" ") + " re f"
        )
    }
    const lines = [
        [18, 405, 14, label.returnLabel ? "TEST CARRIER - RETURN LABEL" : "TEST CARRIER"],
        [18, 385, 9, "FROM: " + label.fromText],
        [18, 350, 11, "SHIP TO:"],
        [18, 335, 11, label.toText],
        [18, 290, 9, label.methodText + "   " + label.weightText],
        [18, 275, 9, "Shipment " + label.shipmentId + " package " + label.shipmentPackageSeqId],
        [18, 245, 12, "TRACKING " + label.trackingCode],
        [18, 120, 8, "Test label: not valid for shipping"]
    ]
    const text = lines.map(([x, y, size, value]) => `BT /F1 ${size} Tf ${x} ${y} Td (${pdfText(value)}) Tj ET`).join("\n")
    const content = text + "\n0 g\n" + bars.join("\n") + "\n"
    const objects = [
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /Font << /F1 4 0 R >> >> ` +
            "/Contents 5 0 R >>",
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        `<< /Length ${content.length} >>\nstream\n${content}endstream`
    ]
    let pdf = "%PDF-1.4\n"
    const offsets = []
    objects.forEach((body, index) => {
        offsets.push(pdf.length)
        pdf += `${index + 1} 0 obj\n${body}\nendobj\n`
    })
    const xref = pdf.length
    pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
    for (const offset of offsets) pdf += String(offset).padStart(10, "0") + " 00000 n \n"
    pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
    const bytes = new Uint8Array(pdf.length)
    for (let index = 0; index < pdf.length; index++) bytes[index] = pdf.charCodeAt(index) & 0xff
    return bytes
}
function addressText(contactMechId) {
    const address = blank(contactMechId) ? null : one(POSTAL, {contactMechId})
    if (!address) return "(no address)"
    return [address.toName, address.address1, address.city, address.stateProvinceGeoId, address.postalCode]
        .filter(value => !blank(value))
        .join(", ")
}
// The label's fields on the package's route segment, outbound or return.
function fillPackage(segment, label, withImage) {
    const r = truthy(label.returnLabel) ? "return" : ""
    const field = name => (r ? r + name.charAt(0).toUpperCase() + name.slice(1) : name)
    const values = {
        shipmentId: label.shipmentId,
        shipmentPackageSeqId: label.shipmentPackageSeqId,
        shipmentRouteSegmentSeqId: label.shipmentRouteSegmentSeqId,
        [field("trackingCode")]: label.trackingCode,
        [field("labelDate")]: label.issuedDate,
        [field("gatewayLabelId")]: label.testCarrierLabelId,
        [field("gatewayStatus")]: "issued",
        [field("gatewayMessage")]: "Test carrier label (zone " + label.zone + ")",
        [field("estimatedAmount")]: label.amount
    }
    if (!r) Object.assign(values, {baseAmount: label.amount, actualAmount: label.amount})
    if (withImage) {
        values[field("labelImage")] = labelPdf({
            trackingCode: label.trackingCode,
            returnLabel: !!r,
            fromText: addressText(r ? segment.destPostalContactMechId : originPostalOf(segment)),
            toText: addressText(r ? originPostalOf(segment) : segment.destPostalContactMechId),
            methodText: (one("moqui.basic.Enumeration", {enumId: label.shipmentMethodEnumId})?.description || "") + "",
            weightText: number(label.weight) + " lb",
            shipmentId: label.shipmentId,
            shipmentPackageSeqId: label.shipmentPackageSeqId
        })
    }
    call("update#" + ROUTE_SEG, values)
}
// request#ShippingLabels: a label per package of the segment (or the one given)
function requestLabels(p) {
    const segment = segmentOf(p)
    const ends = endsOf(segment)
    const returnLabel = truthy(p.getReturnLabels)
    if (reservedHit(ends, "invalid"))
        denied("ADDRESS_INVALID", "The test carrier cannot deliver to postal code " + reserved.invalid + " (invalid address)")
    if (reservedHit(ends, "refused")) denied("LABEL_REFUSED", "The test carrier refused the label for this shipment")
    const methodId = p.shipmentMethodEnumId || segment.shipmentMethodEnumId
    if (!methods[methodId]) denied("METHOD_UNAVAILABLE", "The test carrier has no " + (methodId || "method") + " service")
    const packages = rows(PACKAGE, {shipmentId: p.shipmentId}).filter(
        row => blank(p.shipmentPackageSeqId) || row.shipmentPackageSeqId === p.shipmentPackageSeqId
    )
    if (!packages.length) denied("NO_PACKAGES", "Shipment " + p.shipmentId + " has no package")
    const unweighed = packages.filter(row => !(number(row.weight) > 0)).map(row => row.shipmentPackageSeqId)
    if (unweighed.length) denied("WEIGHT_REQUIRED", "Package " + unweighed.join(", ") + " has no weight")
    let timedOut = false
    for (const packageRow of packages) {
        const reference = blank(p.requestReference)
            ? null
            : packages.length === 1
              ? String(p.requestReference)
              : p.requestReference + "/" + packageRow.shipmentPackageSeqId
        // the label already issued for this reference: answered again, nothing bought
        let label = reference
            ? Array.from(find(LABEL, {requestReference: reference}).condition("refundedDate", "is-null", null).list())[0]
            : null
        if (!label) {
            const weight = pounds(packageRow.weight, packageRow.weightUomId)
            const amount = rateOf(methodId, weight, ends.zone)
            // the carrier's own record, in its own transaction: it stays even when the caller's work rolls back
            const made = probe("create#" + LABEL, {
                requestReference: reference,
                shippingGatewayConfigId: p.shippingGatewayConfigId,
                shipmentId: p.shipmentId,
                shipmentRouteSegmentSeqId: segment.shipmentRouteSegmentSeqId,
                shipmentPackageSeqId: packageRow.shipmentPackageSeqId,
                returnLabel: returnLabel ? "Y" : "N",
                shipmentMethodEnumId: methodId,
                amount,
                amountUomId: "USD",
                zone: ends.zone,
                weight,
                issuedDate: ec.user.nowTimestamp
            })
            probe("update#" + LABEL, {
                testCarrierLabelId: made.testCarrierLabelId,
                trackingCode:
                    "1ZTEST" +
                    String(made.testCarrierLabelId)
                        .replace(/[^A-Za-z0-9]/g, "")
                        .padStart(10, "0")
            })
            label = one(LABEL, {testCarrierLabelId: made.testCarrierLabelId})
            if (reservedHit(ends, "timeout")) {
                timedOut = true
                continue
            }
        }
        fillPackage(segment, label, true)
    }
    if (timedOut) denied("CARRIER_TIMEOUT", "The test carrier did not answer in time (postal code " + reserved.timeout + ")")
    return {}
}
// find#ShippingLabels: the label of the reference (or the package's newest), filled in when found and not refunded
function findLabels(p) {
    const segment = segmentOf(p)
    const returnLabel = truthy(p.getReturnLabels) ? "Y" : "N"
    let label = null
    if (!blank(p.requestReference)) {
        const references = [String(p.requestReference), p.requestReference + "/" + p.shipmentPackageSeqId]
        label = Array.from(
            find(LABEL).condition("requestReference", "in", references).orderBy("-testCarrierLabelId").limit(1).list()
        )[0]
    } else {
        label = Array.from(
            find(LABEL, {shipmentId: p.shipmentId, shipmentPackageSeqId: p.shipmentPackageSeqId, returnLabel})
                .orderBy("-testCarrierLabelId")
                .limit(1)
                .list()
        )[0]
    }
    if (!label) return {found: false, refunded: false}
    const refunded = label.refundedDate != null
    if (!refunded) fillPackage(segment, label, true)
    return {found: true, refunded, trackingCode: label.trackingCode, gatewayLabelId: label.testCarrierLabelId}
}
// refund#ShippingLabels: the packages' labels marked refunded in the carrier's record and on the package; a label
// already refunded answers the same
function refundLabels(p) {
    const segment = segmentOf(p)
    const routeSegs = rows(ROUTE_SEG, {shipmentId: p.shipmentId, shipmentRouteSegmentSeqId: segment.shipmentRouteSegmentSeqId})
        .filter(row => blank(p.shipmentPackageSeqId) || row.shipmentPackageSeqId === p.shipmentPackageSeqId)
        .filter(row => row.gatewayLabelId)
    if (!routeSegs.length) denied("NO_LABEL", "There is no test carrier label to refund")
    for (const routeSeg of routeSegs) {
        const label = one(LABEL, {testCarrierLabelId: routeSeg.gatewayLabelId})
        if (!label) denied("NO_LABEL", "The test carrier issued no label " + routeSeg.gatewayLabelId)
        if (!label.refundedDate)
            probe("update#" + LABEL, {testCarrierLabelId: label.testCarrierLabelId, refundedDate: ec.user.nowTimestamp})
        call("update#" + ROUTE_SEG, {
            shipmentId: routeSeg.shipmentId,
            shipmentPackageSeqId: routeSeg.shipmentPackageSeqId,
            shipmentRouteSegmentSeqId: routeSeg.shipmentRouteSegmentSeqId,
            gatewayRefundId: label.testCarrierLabelId,
            gatewayRefundStatus: "refunded"
        })
    }
    return {}
}
// track#ShippingLabels: each labelled package in transit, its estimate the label day plus the method's days
function trackLabels(p) {
    const segment = segmentOf(p)
    const routeSegs = rows(ROUTE_SEG, {shipmentId: p.shipmentId, shipmentRouteSegmentSeqId: segment.shipmentRouteSegmentSeqId})
        .filter(row => blank(p.shipmentPackageSeqId) || row.shipmentPackageSeqId === p.shipmentPackageSeqId)
        .filter(row => row.gatewayLabelId && row.trackingStatusEnumId !== "ShTsDelivered")
    for (const routeSeg of routeSegs) {
        const label = one(LABEL, {testCarrierLabelId: routeSeg.gatewayLabelId})
        if (!label) continue
        const refunded = label.refundedDate != null
        const days = daysOf(label.shipmentMethodEnumId, number(label.zone)) || 3
        call("update#" + ROUTE_SEG, {
            shipmentId: routeSeg.shipmentId,
            shipmentPackageSeqId: routeSeg.shipmentPackageSeqId,
            shipmentRouteSegmentSeqId: routeSeg.shipmentRouteSegmentSeqId,
            trackingStatusEnumId: refunded ? "ShTsFailure" : "ShTsTransit",
            trackingSubStatus: refunded ? "Label refunded" : "In transit (test carrier)",
            trackingStatusDate: ec.user.nowTimestamp,
            trackingEta: new Date(lib.ms(label.issuedDate) + days * 86400000),
            trackingOrigEta: routeSeg.trackingOrigEta || new Date(lib.ms(label.issuedDate) + days * 86400000)
        })
    }
    return {}
}
// validate#ShippingPostalAddress: the reserved invalid code is CmtlInvalid, any other address CmtlValid
function validateAddress(p) {
    const code = postalCodeOf(p.contactMechId)
    const invalid = code.startsWith(reserved.invalid)
    call("update#mantle.party.contact.ContactMech", {
        contactMechId: p.contactMechId,
        trustLevelEnumId: invalid ? "CmtlInvalid" : "CmtlValid",
        validateMessage: invalid ? "ADDRESS_INVALID: the test carrier knows no address at " + code : "Valid (test carrier)"
    })
    return {contactMechId: p.contactMechId}
}

const operations = {ratesBulk, rate, requestLabels, findLabels, refundLabels, trackLabels, validateAddress}
;({
    reserved,
    labelPdf,
    execute(op, parameters) {
        if (!operations[op]) throw new Error("Unknown test carrier operation " + op)
        return operations[op](parameters)
    }
})
