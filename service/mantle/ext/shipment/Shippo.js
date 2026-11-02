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

// Shippo shipping gateway (plan/payments-shipping-edi.md S1): the operations behind ShippoServices.xml, on the carrier
// interfaces of mantle.shipment.CarrierServices. Ported from the Java Moqui mantle-shippo component
// (github.com/moqui/mantle-shippo, 1.2.1, commit 2356f07, written by David E. Jones and Michael Jones: its address,
// parcel, carrier, service level, box and insurance mappings, the rate merge per package, the return-label shipment and
// the tracking status map) to the Shippo REST API at the explicit 2018-02-08 version, with durable label attempts
// (Shipping.js), asynchronous transactions and refunds retrieved instead of bought again, and authenticated webhooks.
//
// The contract is CarrierServices.request#ShippingLabels': a label bought is filled in on ShipmentPackageRouteSeg, a
// purchase Shippo accepted and has not finished answers pending, a refusal throws its reason code (nothing was bought:
// safe to send again) and anything else thrown is a lost answer, which find#ShippingLabels resolves by the transaction's
// metadata (Shippo has no idempotency key for transactions). The API token is the remote's encrypted password and is sent
// only to the remote's API base. Requests, answers, addresses and tokens are never logged; the module logs ids and codes.
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const {find, one, rows, denied, call, probe} = lib

const CONFIG = "mantle.shipment.carrier.ShippingGatewayConfig",
    REMOTE = "moqui.service.message.SystemMessageRemote",
    OPTION = "mantle.shipment.carrier.ShippingGatewayOption",
    GW_CARRIER = "mantle.shipment.carrier.ShippingGatewayCarrier",
    GW_METHOD = "mantle.shipment.carrier.ShippingGatewayMethod",
    GW_BOX = "mantle.shipment.carrier.ShippingGatewayBoxType",
    METHOD = "mantle.shipment.carrier.CarrierShipmentMethod",
    REQUEST = "mantle.shipment.carrier.ShippingGatewayRequest",
    SHIPMENT = "mantle.shipment.Shipment",
    SEGMENT = "mantle.shipment.ShipmentRouteSegment",
    PACKAGE = "mantle.shipment.ShipmentPackage",
    ROUTE_SEG = "mantle.shipment.ShipmentPackageRouteSeg",
    BOX = "mantle.shipment.ShipmentBoxType",
    POSTAL = "mantle.party.contact.PostalAddress",
    UOM = "moqui.basic.Uom",
    GEO = "moqui.basic.Geo"
const GATEWAY_TYPE = "ShGtwyShippo"
// the API contract this adapter was written against, sent on every request (the account default may be newer)
const API_VERSION = "2018-02-08"
const TIMEOUT_SECONDS = 40
const DEFAULT_LABEL_TYPE = "PDF_4x6"
// a lost purchase not found in the transaction list is judged not bought only after this (Shippo may list it late)
const GRACE_SECONDS = 300
const SEARCH_MARGIN_MS = 15 * 60000
const PAGE_SIZE = 100
const MAX_PAGES = 5
const labelTypes = ["PNG", "PNG_2.3x7.5", "PDF", "PDF_2.3x7.5", "PDF_4x6", "PDF_4x8", "PDF_A4", "PDF_A5", "PDF_A6", "ZPLII"]
const distanceUnits = ["cm", "in", "ft", "mm", "m", "yd"]
const massUnits = ["g", "oz", "lb", "kg"]
// Shippo's tracking status and Mantle's (PRE_TRANSIT: the label exists, the carrier has not scanned it)
const trackingStatuses = {
    UNKNOWN: "ShTsUnknown",
    PRE_TRANSIT: "ShTsUnknown",
    TRANSIT: "ShTsTransit",
    DELIVERED: "ShTsDelivered",
    RETURNED: "ShTsReturned",
    FAILURE: "ShTsFailure"
}
const unfinished = ["QUEUED", "WAITING"]

const blank = value => value == null || String(value).trim() === ""
const number = value => (value == null || value === "" ? 0 : Number(String(value)))
const truthy = value => value === true || value === "true" || value === "Y"
const clip = (text, length = 255) => (text == null ? null : String(text).slice(0, length))
const errorText = error => String(error?.message ?? error).replace(/^(Error: )+/, "")
const dateOf = text => {
    const parsed = blank(text) ? NaN : Date.parse(String(text))
    return Number.isNaN(parsed) ? null : new Date(parsed)
}
// a time as Shippo's list filters take it: UTC with a Z (no other offset)
function utcText(millis) {
    const date = new Date(millis)
    const two = value => String(value).padStart(2, "0")
    return (
        date.getUTCFullYear() +
        "-" +
        two(date.getUTCMonth() + 1) +
        "-" +
        two(date.getUTCDate()) +
        "T" +
        two(date.getUTCHours()) +
        ":" +
        two(date.getUTCMinutes()) +
        ":" +
        two(date.getUTCSeconds()) +
        "Z"
    )
}
// the outbound or return name of a ShipmentPackageRouteSeg field
const fieldOf = returnLabel => name => (returnLabel ? "return" + name.charAt(0).toUpperCase() + name.slice(1) : name)

// ---- Configuration and transport ----

function option(shippingGatewayConfigId, optionEnumId) {
    return one(OPTION, {shippingGatewayConfigId, optionEnumId})?.optionValue ?? null
}
// The gateway's config and connection; problem says why it cannot be used.
function gateway(shippingGatewayConfigId) {
    const config = blank(shippingGatewayConfigId) ? null : one(CONFIG, {shippingGatewayConfigId})
    const remote = config?.systemMessageRemoteId && one(REMOTE, {systemMessageRemoteId: config.systemMessageRemoteId})
    let problem = null
    if (!config || config.shippingGatewayTypeEnumId !== GATEWAY_TYPE)
        problem = "Gateway " + shippingGatewayConfigId + " is not a Shippo gateway"
    else if (!remote) problem = "Gateway " + shippingGatewayConfigId + " has no connection (SystemMessageRemote)"
    else if (blank(remote.sendUrl) || blank(remote.password))
        problem = "The connection " + remote.systemMessageRemoteId + " needs its API base (sendUrl) and API token (password)"
    if (config && !blank(option(shippingGatewayConfigId, "SgoApiToken")))
        ec.logger.warn(
            "Shippo gateway " +
                shippingGatewayConfigId +
                " has an SgoApiToken option, which is not used: the API token is " +
                "the encrypted password of its SystemMessageRemote"
        )
    const labelType = option(shippingGatewayConfigId, "SgoLabelType") || DEFAULT_LABEL_TYPE
    if (!problem && !labelTypes.includes(labelType)) problem = "Label type " + labelType + " is not a Shippo label_file_type"
    const grace = option(shippingGatewayConfigId, "SgoLookupGraceSeconds")
    return {
        id: shippingGatewayConfigId,
        config,
        remote,
        base: remote ? String(remote.sendUrl || "").replace(/\/+$/, "") : "",
        labelType,
        graceSeconds: blank(grace) ? GRACE_SECONDS : Math.max(0, number(grace)),
        problem
    }
}
function usable(shippingGatewayConfigId) {
    const gw = gateway(shippingGatewayConfigId)
    if (gw.problem) denied("CONFIG_INVALID", gw.problem)
    return gw
}

// The text of Shippo's messages ([{source, code, text}]) or of an error body.
function messagesText(messages) {
    return Array.from(messages || [])
        .map(
            row =>
                (row?.source || row?.code ? "(" + [row.source, row.code].filter(Boolean).join(":") + ") " : "") +
                (row?.text ?? "")
        )
        .join("; ")
}
function errorBodyText(data) {
    if (data == null) return ""
    if (typeof data === "string") return data
    if (Array.isArray(data)) return data.map(errorBodyText).join("; ")
    if (typeof data === "object") {
        if (data.messages) return messagesText(data.messages)
        return Object.entries(data)
            .map(([key, value]) => (key === "detail" || key === "__all__" ? "" : key + ": ") + errorBodyText(value))
            .join("; ")
    }
    return String(data)
}

// One API request to the remote's base (a path, or a next-page URL on that same base). Answers {data} with the parsed
// answer; {lost} when the request may have gone and no readable answer came back (a timeout, a reset, 408, a 5xx); {limited}
// for 429 and {refused} for another 4xx, both refused before Shippo acted.
function send(gw, method, path, body) {
    const url = /^https?:\/\//.test(path) ? path : gw.base + path
    // the token goes to the configured API base only, never to a host a response names
    if (url !== gw.base && !url.startsWith(gw.base + "/") && !url.startsWith(gw.base + "?"))
        return {refused: "Not a URL of the Shippo connection"}
    let response
    try {
        let client = ec.service
            .rest()
            .method(method)
            .uri(url)
            .timeout(TIMEOUT_SECONDS)
            .addHeader("Authorization", "ShippoToken " + gw.remote.password)
            .addHeader("Shippo-API-Version", API_VERSION)
            .addHeader("Accept", "application/json")
        if (body != null) client = client.jsonObject(JSON.stringify(body))
        response = client.call()
    } catch (error) {
        return {lost: "No answer from Shippo: " + clip(errorText(error), 200)}
    }
    const status = response.getStatusCode()
    let data = null
    try {
        data = JSON.parse(String(response.text() || ""))
    } catch (_) {
        data = null
    }
    if (status === 408 || status >= 500) return {status, lost: "Shippo answered HTTP " + status}
    if (status === 429) return {status, limited: "Shippo is limiting requests (HTTP 429)", data}
    if (status >= 400) return {status, refused: clip(errorBodyText(data), 200) || "HTTP " + status, data}
    if (data == null || typeof data !== "object") return {status, lost: "Shippo answered with unreadable JSON"}
    return {status, data}
}
// A GET whose answer must be read: a failure throws, as an answer that is not known.
function read(gw, path, what) {
    const sent = send(gw, "GET", path)
    if (sent.data) return sent.data
    denied(
        sent.limited ? "RATE_LIMITED" : "CARRIER_NO_ANSWER",
        "Shippo " + what + ": " + (sent.lost || sent.limited || sent.refused)
    )
}
// The label file at Shippo's label URL (a storage link that may have expired), with no Shippo credentials; or null.
function download(url) {
    if (blank(url)) return null
    try {
        const response = ec.service.rest().method("GET").uri(String(url)).timeout(TIMEOUT_SECONDS).call()
        if (response.getStatusCode() !== 200) return null
        const bytes = response.bytes()
        return bytes && bytes.length ? bytes : null
    } catch (error) {
        ec.logger.warn("Shippo label download failed: " + clip(errorText(error), 120))
        return null
    }
}
// A refusal's reason code from Shippo's message text: an address problem, a stale rate, else the fallback.
function refusalCode(text, fallback) {
    const value = String(text || "")
    if (/rate/i.test(value) && /expire|no longer|stale|outdated/i.test(value)) return "RATE_EXPIRED"
    if (/address|zip|postal|street|city|state|country/i.test(value)) return "ADDRESS_INVALID"
    return fallback
}

// ---- Mappings: addresses, parcels, carriers and services ----

function geoCode(geoId) {
    return blank(geoId) ? null : one(GEO, {geoId})?.geoCodeAlpha2 || null
}
function phoneText(telecom) {
    if (!telecom) return null
    const text = [telecom.countryCode, telecom.areaCode, telecom.contactNumber].filter(value => !blank(value)).join("-")
    return text || null
}
// The partyId of an address when exactly one party has it.
function onlyPartyOf(contactMechId) {
    const ids = [...new Set(rows("mantle.party.contact.PartyContactMech", {contactMechId}).map(row => row.partyId))]
    return ids.length === 1 ? ids[0] : null
}
// Shippo's address map of a PostalAddress (the source's get#AddressMap): name and company from attnName/toName or the
// party's name, street1 with the unit, state and country as ISO alpha-2, ZIP+4, and the phone and email of the address or
// of the party's shipping purpose (origin or destination).
function addressMap(contactMechId, partyId, isOrigin, otherPartyId) {
    const postal = blank(contactMechId) ? null : one(POSTAL, {contactMechId})
    if (!postal) denied("ADDRESS_INVALID", "Address " + (contactMechId || "(none)") + " not found")
    partyId = partyId || onlyPartyOf(contactMechId)
    let name = postal.attnName ? postal.attnName : postal.toName
    const company = postal.attnName ? postal.toName : null
    if (blank(name) && partyId) {
        const detail = one("mantle.party.PartyDetail", {partyId})
        if (detail) name = [detail.firstName, detail.lastName].filter(value => !blank(value)).join(" ") || detail.organizationName
    }
    if (blank(name)) denied("ADDRESS_INVALID", "Address " + contactMechId + " has no name to ship to")
    let street1 = postal.address1
    if (!blank(postal.unitNumber)) street1 = street1 + " #" + postal.unitNumber
    let zip = postal.postalCode
    if (!blank(postal.postalCodeExt) && postal.postalCodeExt !== postal.postalCode) zip = zip + "-" + postal.postalCodeExt
    let telecom = postal.telecomContactMechId
        ? one("mantle.party.contact.TelecomNumber", {contactMechId: postal.telecomContactMechId})
        : null
    let email = postal.emailContactMechId
        ? one("mantle.party.contact.ContactMech", {contactMechId: postal.emailContactMechId})?.infoString
        : null
    const contactOf = (id, purposes) =>
        id ? call("mantle.party.ContactServices.get#PartyContactInfo", Object.assign({partyId: id}, purposes)) : {}
    if (!telecom && partyId)
        telecom = contactOf(partyId, {
            telecomContactMechPurposeId: isOrigin ? "PhoneShippingOrigin" : "PhoneShippingDest"
        }).telecomNumber
    // a destination with no phone takes the shipper's, so the label can be issued (the source's rule)
    if (!telecom && !isOrigin && otherPartyId)
        telecom = contactOf(otherPartyId, {telecomContactMechPurposeId: "PhoneShippingDest"}).telecomNumber
    if (!email && partyId)
        email = contactOf(partyId, {
            emailContactMechPurposeId: isOrigin ? "EmailShippingOrigin" : "EmailShippingDest"
        }).emailAddress
    return {
        name: clip(name, 35),
        company: clip(company, 35),
        street1,
        street2: postal.address2 || null,
        city: postal.city,
        state: geoCode(postal.stateProvinceGeoId),
        zip,
        country: geoCode(postal.countryGeoId),
        phone: phoneText(telecom),
        email: email || null
    }
}
// A Shippo unit from a Uom's abbreviation, or null.
function unitOf(uomId, allowed) {
    const abbreviation = blank(uomId) ? null : one(UOM, {uomId})?.abbreviation
    return abbreviation && allowed.includes(abbreviation) ? abbreviation : null
}
// The parcel of a package (box type, weight, weight unit): the box's dimensions and the gateway's box template
// (ShippingGatewayBoxType, else ShipmentBoxType.gatewayBoxId), the package's weight else the box's default gross weight.
function parcelOf(gw, info, label) {
    const box = blank(info.shipmentBoxTypeId) ? null : one(BOX, {shipmentBoxTypeId: info.shipmentBoxTypeId})
    const template =
        (box && one(GW_BOX, {shippingGatewayConfigId: gw.id, shipmentBoxTypeId: box.shipmentBoxTypeId})?.gatewayBoxId) ||
        box?.gatewayBoxId ||
        null
    const weight = number(info.weight) > 0 ? info.weight : box?.defaultGrossWeight
    const weightUomId = number(info.weight) > 0 ? info.weightUomId || box?.weightUomId : box?.weightUomId
    if (!(number(weight) > 0)) denied("PARCEL_INVALID", label + " has no weight")
    const massUnit = unitOf(weightUomId, massUnits)
    if (!massUnit) denied("PARCEL_INVALID", label + " weight unit " + (weightUomId || "(none)") + " is not one Shippo takes")
    const parcel = {weight: String(weight), mass_unit: massUnit}
    const dimensioned = box && number(box.boxLength) > 0 && number(box.boxWidth) > 0 && number(box.boxHeight) > 0
    if (dimensioned) {
        const distanceUnit = unitOf(box.dimensionUomId, distanceUnits)
        if (!distanceUnit)
            denied("PARCEL_INVALID", "Box type " + box.shipmentBoxTypeId + " dimension unit is not one Shippo takes")
        Object.assign(parcel, {
            length: String(box.boxLength),
            width: String(box.boxWidth),
            height: String(box.boxHeight),
            distance_unit: distanceUnit
        })
    } else if (!template) denied("PARCEL_INVALID", label + " has no box type with dimensions or a gateway box template")
    if (template) parcel.template = template
    return parcel
}
// The Shippo carrier account and service level of a carrier's method on this gateway: ShippingGatewayCarrier
// gatewayAccountId, and ShippingGatewayMethod's gatewayServiceCode, else CarrierShipmentMethod's.
function serviceOf(gw, carrierPartyId, shipmentMethodEnumId) {
    const account = one(GW_CARRIER, {shippingGatewayConfigId: gw.id, carrierPartyId})?.gatewayAccountId || null
    const token =
        one(GW_METHOD, {shippingGatewayConfigId: gw.id, carrierPartyId, shipmentMethodEnumId})?.gatewayServiceCode ||
        one(METHOD, {carrierPartyId, shipmentMethodEnumId})?.gatewayServiceCode ||
        null
    return {carrierPartyId, shipmentMethodEnumId, account, token}
}
const tokenOf = rate => rate?.servicelevel?.token ?? rate?.servicelevel_token ?? null
// The cheapest rate of a service level (on its carrier account, when the rate names one).
function rateFor(rates, service) {
    return (
        Array.from(rates || [])
            .filter(
                rate =>
                    tokenOf(rate) === service.token &&
                    (!service.account || !rate.carrier_account || rate.carrier_account === service.account)
            )
            .sort((a, b) => number(a.amount) - number(b.amount))[0] || null
    )
}

// ---- Rates ----

// One Shippo shipment per package (Shippo treats several parcels as one multi-piece shipment, which only some carriers
// take): its rates, asked synchronously and read again once if Shippo had not finished them.
function rateShipment(gw, body, label) {
    const sent = send(gw, "POST", "/shipments", body)
    if (!sent.data)
        denied(
            sent.limited ? "RATE_LIMITED" : sent.refused ? refusalCode(sent.refused, "METHOD_UNAVAILABLE") : "RATES_NO_ANSWER",
            "Shippo rates for " + label + ": " + (sent.lost || sent.limited || sent.refused)
        )
    let data = sent.data
    if (unfinished.includes(data.status) && data.object_id) {
        const again = send(gw, "GET", "/shipments/" + encodeURIComponent(data.object_id))
        if (again.data) data = again.data
    }
    if (unfinished.includes(data.status)) denied("RATES_NO_ANSWER", "Shippo has not finished the rates for " + label)
    const text = messagesText(data.messages)
    if (data.status === "ERROR" || !Array.from(data.rates || []).length)
        denied(refusalCode(text, "METHOD_UNAVAILABLE"), "Shippo has no rate for " + label + (text ? ": " + clip(text, 200) : ""))
    return data
}
// Rates of carrier methods for a set of packages: each method's cheapest rate per package, summed, for a method rated for
// every package in one currency (a method a package cannot take is left out, not priced partly).
function quote(gw, p) {
    const services = Array.from(p.methods)
        .map(method => serviceOf(gw, method.carrierPartyId, method.shipmentMethodEnumId))
        .filter(service => service.token && service.account)
    if (!services.length) return []
    const accounts = [...new Set(services.map(service => service.account))]
    const perPackage = []
    for (const [index, info] of p.packages.entries()) {
        const label = "package " + (info.shipmentPackageSeqId || index + 1)
        const parcel = parcelOf(gw, info, label)
        if (info.insurance) parcel.extra = {insurance: info.insurance}
        const data = rateShipment(
            gw,
            {
                address_from: p.addressFrom,
                address_to: p.addressTo,
                parcels: [parcel],
                carrier_accounts: accounts,
                extra: {bypass_address_validation: true},
                async: false
            },
            label
        )
        perPackage.push(data.rates)
    }
    const quotes = []
    for (const service of services) {
        const chosen = perPackage.map(rates => rateFor(rates, service))
        if (chosen.some(rate => !rate)) continue
        const currencies = [...new Set(chosen.map(rate => rate.currency))]
        if (currencies.length !== 1) continue
        quotes.push({
            carrierPartyId: service.carrierPartyId,
            shipmentMethodEnumId: service.shipmentMethodEnumId,
            shippingTotal: String(chosen.reduce((sum, rate) => sum.add(toDecimal(rate.amount ?? 0)), toDecimal(0))),
            currency: currencies[0],
            days: chosen[0].estimated_days ?? chosen[0].days ?? null,
            durationTerms: chosen[0].duration_terms || null,
            serviceName: chosen[0].servicelevel?.name || chosen[0].servicelevel_name || null,
            carrierImageUrl: chosen[0].provider_image_75 || null,
            rateIds: chosen.map(rate => rate.object_id)
        })
    }
    return quotes
}
// Insurance of a package when Mantle requires it (CarrierServices.get#GeneralPackageRequiresInsurance), in the currency
// given; none when there is no currency to state it in.
function insuranceOf(quantityByProductId, currencyUomId, productStoreId, vendorPartyId) {
    if (!quantityByProductId || !Object.keys(quantityByProductId).length) return null
    const out = call("mantle.shipment.CarrierServices.get#GeneralPackageRequiresInsurance", {
        quantityByProductId,
        currencyUomId,
        productStoreId,
        vendorPartyId
    })
    if (!out.insuranceRequired || !(number(out.packageTotalCost) > 0)) return null
    if (blank(currencyUomId)) {
        ec.logger.warn("Shippo insurance left out: no currency for the package's value")
        return null
    }
    return {amount: String(out.packageTotalCost), currency: currencyUomId, content: clip(out.contentDescription, 100)}
}
// get#ShippingRatesBulk: the asked methods of the carriers this gateway serves, priced by Shippo.
function ratesBulk(p) {
    const gw = usable(p.shippingGatewayConfigId)
    const packages = Array.from(p.packageInfoList || []).map(info => ({
        shipmentPackageSeqId: info.shipmentPackageSeqId,
        shipmentBoxTypeId: info.shipmentBoxTypeId,
        weight: info.weight,
        weightUomId: info.weightUomId,
        insurance: insuranceOf(info.quantityByProductId, p.currencyUomId, p.productStoreId, p.vendorPartyId)
    }))
    if (!packages.length) return {shippingRateInfoList: []}
    const quotes = quote(gw, {
        methods: Array.from(p.carrierShipmentMethodList || []),
        packages,
        addressFrom: addressMap(p.originPostalContactMechId, p.fromPartyId, true),
        addressTo: addressMap(p.destPostalContactMechId, p.toPartyId, false, p.fromPartyId)
    })
    return {shippingRateInfoList: quotes.map(({rateIds, ...row}) => row)}
}
// get#OrderShippingRate: an order part's rate for its carrier and method (or the ones given), for the packages given; with
// createOrderItem a shipping item in the order's currency (a rate in another currency is refused).
function orderRate(p) {
    const gw = usable(p.shippingGatewayConfigId)
    const header = one("mantle.order.OrderHeader", {orderId: p.orderId})
    const part = one("mantle.order.OrderPart", {orderId: p.orderId, orderPartSeqId: p.orderPartSeqId})
    if (!header || !part) denied("RECORD_UNAVAILABLE", "Order part " + p.orderId + ":" + p.orderPartSeqId + " not found")
    const carrierPartyId = p.carrierPartyId || part.carrierPartyId
    const shipmentMethodEnumId = p.shipmentMethodEnumId || part.shipmentMethodEnumId
    if (blank(carrierPartyId) || carrierPartyId === "_NA_" || blank(shipmentMethodEnumId))
        denied("METHOD_REQUIRED", "Order part " + p.orderId + ":" + p.orderPartSeqId + " has no carrier and method")
    const packages = Array.from(p.packageInfoList || [])
    if (!packages.length) denied("PARCEL_INVALID", "No package information to rate order " + p.orderId)
    const origin = part.facilityId
        ? call("mantle.facility.ContactServices.get#FacilityDefaultShipOrigin", {facilityId: part.facilityId}).postalContactMechId
        : null
    if (!origin) denied("ADDRESS_INVALID", "The order part's facility has no shipping origin address")
    const quotes = quote(gw, {
        methods: [{carrierPartyId, shipmentMethodEnumId}],
        packages: packages.map(info =>
            Object.assign({}, info, {
                insurance: insuranceOf(info.quantityByProductId, header.currencyUomId, header.productStoreId, part.vendorPartyId)
            })
        ),
        addressFrom: addressMap(origin, part.vendorPartyId, true),
        addressTo: addressMap(p.postalContactMechId || part.postalContactMechId, part.customerPartyId, false, part.vendorPartyId)
    })
    const rate = quotes[0]
    if (!rate) denied("METHOD_UNAVAILABLE", "Shippo has no rate for " + carrierPartyId + " " + shipmentMethodEnumId)
    // a total in another currency than the order's is never answered as the order's (no conversion here)
    if (header.currencyUomId && rate.currency !== header.currencyUomId)
        denied("CURRENCY_MISMATCH", "Shippo rated in " + rate.currency + ", the order is in " + header.currencyUomId)
    const out = {shippingTotal: rate.shippingTotal, currency: rate.currency}
    if (truthy(p.createOrderItem) && number(rate.shippingTotal) > 0) {
        const method = one("moqui.basic.Enumeration", {enumId: shipmentMethodEnumId})
        out.orderItemSeqId = call("create#mantle.order.OrderItem", {
            orderId: p.orderId,
            orderPartSeqId: p.orderPartSeqId,
            itemTypeEnumId: "ItemShipping",
            quantity: 1,
            unitAmount: rate.shippingTotal,
            itemDescription: clip([carrierPartyId, rate.serviceName || method?.description].filter(Boolean).join(" "), 255)
        }).orderItemSeqId
    }
    return out
}

// ---- Labels ----

// What every package of a route segment's label shares: the shipment, the segment, its addresses (the store's label name
// and company on the origin, the return address), the carrier account and service level, the references and extras.
function labelContext(gw, p, returnLabel) {
    const shipment = one(SHIPMENT, {shipmentId: p.shipmentId})
    const segment = one(SEGMENT, {shipmentId: p.shipmentId, shipmentRouteSegmentSeqId: p.shipmentRouteSegmentSeqId})
    if (!shipment || !segment)
        denied("RECORD_UNAVAILABLE", "Route segment " + p.shipmentRouteSegmentSeqId + " is not on " + p.shipmentId)
    const shipmentMethodEnumId = p.shipmentMethodEnumId || segment.shipmentMethodEnumId
    if (blank(segment.carrierPartyId) || segment.carrierPartyId === "_NA_" || blank(shipmentMethodEnumId))
        denied("CONFIG_INVALID", "Shipment " + p.shipmentId + " has no carrier and method")
    const service = serviceOf(gw, segment.carrierPartyId, shipmentMethodEnumId)
    if (!service.account)
        denied("CONFIG_INVALID", "Gateway " + gw.id + " has no Shippo carrier account for " + segment.carrierPartyId)
    if (!service.token)
        denied("METHOD_UNAVAILABLE", "No Shippo service level for " + segment.carrierPartyId + " " + shipmentMethodEnumId)
    const origin =
        segment.originPostalContactMechId ||
        (segment.originFacilityId
            ? call("mantle.facility.ContactServices.get#FacilityDefaultShipOrigin", {facilityId: segment.originFacilityId})
                  .postalContactMechId
            : null)
    const destination =
        segment.destPostalContactMechId ||
        (segment.destinationFacilityId
            ? call("mantle.facility.ContactServices.get#FacilityDefaultShipDest", {facilityId: segment.destinationFacilityId})
                  .postalContactMechId
            : null)
    if (!origin) denied("ADDRESS_INVALID", "Shipment " + p.shipmentId + " has no origin address")
    if (!destination) denied("ADDRESS_INVALID", "Shipment " + p.shipmentId + " has no destination address")
    const setting = settingTypeEnumId =>
        shipment.productStoreId
            ? Array.from(
                  find("mantle.product.store.ProductStoreSetting", {productStoreId: shipment.productStoreId, settingTypeEnumId})
                      .conditionDate("fromDate", "thruDate", ec.user.nowTimestamp)
                      .orderBy("-fromDate")
                      .limit(1)
                      .list()
              )[0]?.settingValue
            : null
    const overrideName = setting("PsstShipLabelName"),
        overrideCompany = setting("PsstShipLabelCompany")
    const addressFrom = addressMap(origin, shipment.fromPartyId, true)
    if (overrideName) addressFrom.name = clip(overrideName, 35)
    if (overrideCompany) addressFrom.company = clip(overrideCompany, 35)
    const store = shipment.productStoreId
        ? one("mantle.product.store.ProductStore", {productStoreId: shipment.productStoreId})
        : null
    const returnId = segment.returnPostalContactMechId || store?.returnPostalContactMechId
    let addressReturn = null
    if (returnId) {
        addressReturn = addressMap(returnId, shipment.fromPartyId, false)
        if (overrideName) addressReturn.name = clip(overrideName, 35)
        if (overrideCompany) addressReturn.company = clip(overrideCompany, 35)
    }
    const addressTo = addressMap(destination, shipment.toPartyId, false, shipment.fromPartyId)
    // reference_1: the orders (their display ids) and the shipment; reference_2: the customer's order reference
    const orderIds = [
        ...new Set(
            Array.from(
                find("mantle.shipment.ShipmentItemSource", {shipmentId: p.shipmentId})
                    .condition("orderId", "is-not-null", null)
                    .selectField("orderId")
                    .list()
            ).map(row => row.orderId)
        )
    ].sort()
    const orderTexts = orderIds.map(orderId => one("mantle.order.OrderHeader", {orderId})?.displayId || orderId)
    const extra = {
        reference_1: clip((orderTexts.length ? "Order " + orderTexts.join(", ") + " " : "") + "Shipment " + p.shipmentId, 50),
        bypass_address_validation: true,
        is_return: !!returnLabel
    }
    if (!blank(shipment.otherPartyOrderId)) extra.reference_2 = clip("Your Order " + shipment.otherPartyOrderId, 50)
    if (shipment.signatureRequiredEnumId && shipment.signatureRequiredEnumId !== "PsrNone") {
        const code = one("moqui.basic.Enumeration", {enumId: shipment.signatureRequiredEnumId})?.enumCode
        if (code) extra.signature_confirmation = code
        else ec.logger.warn("Shipment " + p.shipmentId + " signature option has no enumCode; no Shippo signature_confirmation")
    }
    const storeGateway = shipment.productStoreId
        ? one("mantle.product.store.ProductStoreShippingGateway", {
              productStoreId: shipment.productStoreId,
              carrierPartyId: segment.carrierPartyId
          })
        : null
    if (storeGateway?.billingType)
        extra.billing = {
            type: storeGateway.billingType,
            account: storeGateway.billingAccount,
            zip: storeGateway.billingZip,
            country: storeGateway.billingCountry
        }
    // a return label goes from the customer back to the return address (else the origin); Shippo refuses address_return
    // with is_return, so the return address takes the origin's place
    const addresses = returnLabel
        ? {address_from: addressReturn || addressFrom, address_to: addressTo}
        : Object.assign({address_from: addressFrom, address_to: addressTo}, addressReturn ? {address_return: addressReturn} : {})
    return {
        shipment,
        segment,
        service,
        addresses,
        extra,
        storeGateway,
        currencyUomId: segment.costUomId || shipment.costUomId || null
    }
}
// The metadata a transaction carries: the request reference, and the package, which find#ShippingLabels searches by.
function metadataOf(reference, key, returnLabel) {
    return clip(
        "mantle " +
            (blank(reference) ? "-" : reference) +
            " " +
            key.shipmentId +
            "/" +
            key.shipmentRouteSegmentSeqId +
            "/" +
            key.shipmentPackageSeqId +
            (returnLabel ? " R" : ""),
        100
    )
}
const packagePartOf = (key, returnLabel) =>
    " " + key.shipmentId + "/" + key.shipmentRouteSegmentSeqId + "/" + key.shipmentPackageSeqId + (returnLabel ? " R" : "")
function referenceOf(metadata) {
    const match = /^mantle (\S+) /.exec(String(metadata || ""))
    return match && match[1] !== "-" ? match[1] : null
}
// The ShippingGatewayRequest of a reference, when it is one of this package and gateway.
function requestOf(gw, reference, key) {
    if (blank(reference)) return null
    const request = one(REQUEST, {shippingGatewayRequestId: String(reference)})
    return request &&
        request.shippingGatewayConfigId === gw.id &&
        request.shipmentId === key.shipmentId &&
        request.shipmentPackageSeqId === key.shipmentPackageSeqId
        ? request
        : null
}
// When a request was first sent: its firstSentDate, which later asks do not move (else its dates, for an older row).
const firstSent = request => (request ? lib.ms(request.firstSentDate || request.sentDate || request.requestDate) : null)
function hasLabel(routeSeg, returnLabel) {
    const f = fieldOf(returnLabel)
    if (!routeSeg || blank(routeSeg[f("gatewayLabelId")])) return false
    return returnLabel || blank(routeSeg.gatewayRefundStatus)
}
// The rate a transaction bought: its rate object, else the rate read by its id.
function rateOfTransaction(gw, tx) {
    if (tx.rate && typeof tx.rate === "object") return tx.rate
    if (blank(tx.rate)) return {}
    const sent = send(gw, "GET", "/rates/" + encodeURIComponent(String(tx.rate)))
    return sent.data || {object_id: String(tx.rate)}
}
// A finished label filled in on the package (the return fields for a return label), in its own transaction: the
// transaction, rate and shipment ids, the label format, link and file, the tracking number and the charge with its
// currency. A label link that no longer answers is asked for again (GET the transaction gives a fresh one); a label that
// still cannot be downloaded keeps its link, and track#ShippingLabels tries again.
function fillLabel(gw, key, tx, rate, returnLabel, extra = {}) {
    const f = fieldOf(returnLabel)
    let labelUrl = tx.label_url || null
    let image = download(labelUrl)
    if (!image && tx.object_id) {
        const fresh = send(gw, "GET", "/transactions/" + encodeURIComponent(tx.object_id))
        if (fresh.data?.label_url && fresh.data.label_url !== labelUrl) {
            labelUrl = fresh.data.label_url
            image = download(labelUrl)
        }
    }
    const notes = [messagesText(tx.messages), extra.note, image ? null : "LABEL_IMAGE_MISSING: the label file was not downloaded"]
        .filter(value => !blank(value))
        .join("; ")
    const values = Object.assign({}, key, {
        [f("trackingCode")]: tx.tracking_number || null,
        [f("trackingUrl")]: tx.tracking_url_provider || null,
        [f("trackingStatusEnumId")]: "ShTsUnknown",
        [f("labelDate")]: dateOf(tx.object_created) || ec.user.nowTimestamp,
        [f("labelUrl")]: labelUrl,
        [f("labelFileType")]: tx.label_file_type || gw.labelType,
        [f("gatewayLabelId")]: tx.object_id,
        [f("gatewayStatus")]: tx.status,
        [f("gatewayMessage")]: clip(notes || null)
    })
    if (!blank(rate.object_id)) values[f("gatewayRateId")] = rate.object_id
    // the charge only when the rate was read: a lookup whose rate read failed keeps the estimate recorded before
    if (rate.amount != null)
        Object.assign(values, {
            [f("estimatedAmount")]: rate.amount,
            [f("baseAmount")]: rate.amount,
            [f("actualAmount")]: rate.amount,
            [f("gatewayAmountUomId")]: rate.currency || null
        })
    if (extra.shipmentObjectId) values[f("gatewayShipmentId")] = extra.shipmentObjectId
    if (image) values[f("labelImage")] = image
    if (!returnLabel && extra.insuredAmount) {
        values.insuredAmount = extra.insuredAmount
        if (number(extra.insurancePercent) > 0 && extra.insuranceCurrency)
            values.insuranceAmount = lib.money(
                toDecimal(extra.insurancePercent).multiply(toDecimal(extra.insuredAmount)).divide(100),
                extra.insuranceCurrency
            )
    }
    probe("update#" + ROUTE_SEG, values)
    return {trackingCode: tx.tracking_number || null, gatewayLabelId: tx.object_id}
}
// A transaction bought for a package, matched on the metadata Mantle sent (the request's, else any of the package's): by
// the rate it was rated with (exact and cheap), then, unless rateOnly, among those created since the request. A failed
// search throws (the outcome stays unknown).
function searchTransactions(gw, s) {
    const matches = tx =>
        s.metadata
            ? tx?.metadata === s.metadata
            : String(tx?.metadata || "").startsWith("mantle ") && String(tx.metadata).endsWith(s.packagePart)
    const pages = first => {
        let path = first
        for (let page = 0; path && page < MAX_PAGES; page++) {
            const data = read(gw, path, "transaction search")
            const found = Array.from(data.results || []).find(tx => matches(tx) && (!s.accept || s.accept(tx)))
            if (found) return found
            path = data.next || null
        }
        return null
    }
    if (!blank(s.rateId)) {
        const found = pages("/transactions?rate=" + encodeURIComponent(s.rateId) + "&results=" + PAGE_SIZE)
        if (found || s.rateOnly) return found
    }
    const since = (firstSent(s.request) ?? lib.ms(ec.user.nowTimestamp)) - SEARCH_MARGIN_MS
    return pages("/transactions?object_created_gte=" + encodeURIComponent(utcText(since)) + "&results=" + PAGE_SIZE)
}
// A transaction's answer for a package: a finished label filled in, an unfinished one pending, a refusal thrown.
function settleTransaction(gw, key, tx, rate, returnLabel, extra) {
    if (tx.status === "SUCCESS" || tx.status === "REFUNDREJECTED") return fillLabel(gw, key, tx, rate, returnLabel, extra)
    if (unfinished.includes(tx.status)) {
        probe(
            "update#" + ROUTE_SEG,
            Object.assign({}, key, {
                [fieldOf(returnLabel)("gatewayStatus")]: tx.status,
                [fieldOf(returnLabel)("gatewayRateId")]: rate.object_id || null
            })
        )
        return {pending: true}
    }
    const text = messagesText(tx.messages)
    // only ERROR is a refusal; a status this adapter does not know is an answer not understood, looked up later
    denied(
        tx.status === "ERROR" ? refusalCode(text, "LABEL_REFUSED") : "CARRIER_NO_ANSWER",
        "Shippo transaction " +
            (tx.object_id || "") +
            " is " +
            (tx.status || "without a status") +
            (text ? ": " + clip(text, 200) : "")
    )
}
// One package's label: a transaction this package already has at its rate (an earlier attempt Shippo may have finished)
// is retrieved, never bought again; else a fresh shipment is rated, its rate recorded before the purchase (so a lost
// purchase is found by its rate and metadata), and the rate bought synchronously.
function buyPackage(gw, ctx, packageRow, p, returnLabel) {
    const key = {
        shipmentId: packageRow.shipmentId,
        shipmentPackageSeqId: packageRow.shipmentPackageSeqId,
        shipmentRouteSegmentSeqId: ctx.segment.shipmentRouteSegmentSeqId
    }
    const f = fieldOf(returnLabel)
    let routeSeg = one(ROUTE_SEG, key)
    if (!routeSeg) {
        probe("create#" + ROUTE_SEG, key)
        routeSeg = one(ROUTE_SEG, key)
    }
    if (hasLabel(routeSeg, returnLabel)) return {}
    const request = requestOf(gw, p.requestReference, key)
    const metadata = metadataOf(request ? request.shippingGatewayRequestId : p.requestReference, key, returnLabel)
    const label = "package " + key.shipmentPackageSeqId + " of " + key.shipmentId
    if (!blank(routeSeg[f("gatewayRateId")]) && ["RATED", ...unfinished].includes(routeSeg[f("gatewayStatus")])) {
        const earlier = searchTransactions(gw, {
            rateId: routeSeg[f("gatewayRateId")],
            rateOnly: true,
            packagePart: packagePartOf(key, returnLabel),
            accept: tx => tx.status === "SUCCESS" || unfinished.includes(tx.status)
        })
        if (earlier)
            return settleTransaction(gw, key, earlier, rateOfTransaction(gw, earlier), returnLabel, {
                shipmentObjectId: routeSeg[f("gatewayShipmentId")]
            })
    }
    const insuranceOut = returnLabel
        ? {}
        : call("mantle.shipment.CarrierServices.get#ShipmentPackageRequiresInsurance", {
              shipmentId: key.shipmentId,
              shipmentPackageSeqId: key.shipmentPackageSeqId
          })
    const parcel = parcelOf(gw, packageRow, label)
    let insuredAmount = null
    if (insuranceOut.insuranceRequired && number(insuranceOut.packageTotalCost) > 0) {
        if (ctx.currencyUomId) {
            insuredAmount = insuranceOut.packageTotalCost
            parcel.extra = {
                insurance: {
                    amount: String(insuredAmount),
                    currency: ctx.currencyUomId,
                    content: clip(insuranceOut.contentDescription, 100)
                }
            }
        } else ec.logger.warn("Shippo insurance of " + label + " left out: the shipment has no cost currency")
    }
    const shipmentData = rateShipment(
        gw,
        Object.assign({}, ctx.addresses, {
            parcels: [parcel],
            carrier_accounts: [ctx.service.account],
            extra: ctx.extra,
            async: false,
            metadata
        }),
        label
    )
    const rate = rateFor(shipmentData.rates, ctx.service)
    if (!rate)
        denied(
            "METHOD_UNAVAILABLE",
            "Shippo has no " +
                ctx.service.token +
                " rate for " +
                label +
                messagesText(shipmentData.messages).replace(/^(.)/, ": $1")
        )
    // the rate and shipment recorded before buying, in their own transaction
    probe(
        "update#" + ROUTE_SEG,
        Object.assign({}, key, {
            [f("gatewayRateId")]: rate.object_id,
            [f("gatewayShipmentId")]: shipmentData.object_id || null,
            [f("gatewayStatus")]: "RATED"
        })
    )
    const sent = send(gw, "POST", "/transactions", {
        rate: rate.object_id,
        label_file_type: gw.labelType,
        metadata,
        async: false
    })
    if (sent.lost)
        denied(
            "CARRIER_TIMEOUT",
            "Shippo did not answer the purchase of " + label + " (" + sent.lost + "); it is looked up before any retry"
        )
    if (sent.limited) denied("RATE_LIMITED", "Shippo did not take the purchase of " + label + ": " + sent.limited)
    if (sent.refused)
        denied(refusalCode(sent.refused, "LABEL_REFUSED"), "Shippo refused the label for " + label + ": " + sent.refused)
    const currencyNote =
        ctx.currencyUomId && rate.currency && rate.currency !== ctx.currencyUomId
            ? "CURRENCY_DIFFERS: charged in " + rate.currency + ", the shipment's cost currency is " + ctx.currencyUomId
            : null
    return settleTransaction(gw, key, sent.data, rate, returnLabel, {
        shipmentObjectId: shipmentData.object_id,
        insuredAmount,
        insurancePercent: ctx.storeGateway?.insurancePercent,
        insuranceCurrency: ctx.currencyUomId,
        note: currencyNote
    })
}
// The failure of a call over several packages that a caller must treat most carefully: a lost answer before a refusal,
// and a package left pending makes the whole call not decided (a refusal would let a caller buy everything again).
const refusalCodes = [
    "CONFIG_INVALID",
    "PARCEL_INVALID",
    "ADDRESS_INVALID",
    "METHOD_UNAVAILABLE",
    "RATE_EXPIRED",
    "LABEL_REFUSED",
    "RATE_LIMITED",
    "RATES_NO_ANSWER",
    "REFUND_REFUSED",
    "NO_LABEL",
    "NO_PACKAGES",
    "RECORD_UNAVAILABLE"
]
function severest(failures, pending) {
    const codeOf = message => /^([A-Z][A-Z0-9_]+):/.exec(message)?.[1] || null
    const lost = failures.find(message => !refusalCodes.includes(codeOf(message)))
    if (lost) return lost
    if (pending) return "LABEL_PENDING: a package is pending at Shippo and another failed (" + clip(failures[0], 200) + ")"
    return failures[0]
}
// request#ShippingLabels: each package of the segment (or the one given) on its own: a package that fails leaves the
// others' labels, which are each written in their own transaction; the first refusal is thrown after the rest are done.
function requestLabels(p) {
    const gw = usable(p.shippingGatewayConfigId)
    const returnLabel = truthy(p.getReturnLabels)
    const ctx = labelContext(gw, p, returnLabel)
    const packages = rows(PACKAGE, {shipmentId: p.shipmentId})
        .filter(row => blank(p.shipmentPackageSeqId) || row.shipmentPackageSeqId === p.shipmentPackageSeqId)
        .sort((a, b) => String(a.shipmentPackageSeqId).localeCompare(String(b.shipmentPackageSeqId)))
    if (!packages.length) denied("NO_PACKAGES", "Shipment " + p.shipmentId + " has no package")
    let pending = false
    const failures = []
    for (const packageRow of packages) {
        try {
            if (buyPackage(gw, ctx, packageRow, p, returnLabel).pending) pending = true
        } catch (error) {
            if (packages.length === 1) throw error
            ec.logger.error(
                "Shippo label of package " +
                    packageRow.shipmentPackageSeqId +
                    " of " +
                    p.shipmentId +
                    ": " +
                    clip(errorText(error), 200)
            )
            failures.push(errorText(error))
        }
    }
    if (failures.length) throw new Error(severest(failures, pending))
    return {pending}
}
// find#ShippingLabels: what Shippo did for a request whose answer was lost or pending. A label request: the transaction
// with the request's metadata (by the package's rate, then the transactions created since the request); a refund: the
// refund recorded on the package, else the label's transaction status. Nothing is bought.
function findLabels(p) {
    const gw = usable(p.shippingGatewayConfigId)
    const returnLabel = truthy(p.getReturnLabels)
    const key = {
        shipmentId: p.shipmentId,
        shipmentPackageSeqId: p.shipmentPackageSeqId,
        shipmentRouteSegmentSeqId: p.shipmentRouteSegmentSeqId
    }
    const routeSeg = one(ROUTE_SEG, key)
    const request = requestOf(gw, p.requestReference, key)
    if (request?.requestTypeEnumId === "SgrRefund") return findRefund(gw, routeSeg)
    if (hasLabel(routeSeg, returnLabel)) {
        const f = fieldOf(returnLabel)
        return {
            found: true,
            refunded: false,
            trackingCode: routeSeg[f("trackingCode")],
            gatewayLabelId: routeSeg[f("gatewayLabelId")]
        }
    }
    const metadata = blank(p.requestReference)
        ? null
        : metadataOf(request ? request.shippingGatewayRequestId : p.requestReference, key, returnLabel)
    const tx = searchTransactions(gw, {
        rateId: routeSeg?.[fieldOf(returnLabel)("gatewayRateId")],
        metadata,
        packagePart: packagePartOf(key, returnLabel),
        request,
        accept: metadata ? null : tx => !["ERROR", "REFUNDED", "REFUNDPENDING"].includes(tx.status)
    })
    if (!tx) {
        const sentAt = firstSent(request)
        const young = sentAt != null && lib.ms(ec.user.nowTimestamp) - sentAt < gw.graceSeconds * 1000
        return young ? {found: false, refunded: false, pending: true} : {found: false, refunded: false}
    }
    if (tx.status === "ERROR") return {found: false, refunded: false}
    if (["REFUNDED", "REFUNDPENDING"].includes(tx.status)) return {found: true, refunded: true, gatewayLabelId: tx.object_id}
    const settled = settleTransaction(gw, key, tx, rateOfTransaction(gw, tx), returnLabel, {
        shipmentObjectId: routeSeg?.[fieldOf(returnLabel)("gatewayShipmentId")]
    })
    if (settled.pending) return {found: true, refunded: false, pending: true}
    return {found: true, refunded: false, trackingCode: settled.trackingCode, gatewayLabelId: settled.gatewayLabelId}
}
function findRefund(gw, routeSeg) {
    if (!routeSeg || blank(routeSeg.gatewayLabelId)) return {found: false, refunded: false}
    if (!blank(routeSeg.gatewayRefundId)) {
        const refund = read(gw, "/refunds/" + encodeURIComponent(routeSeg.gatewayRefundId), "refund")
        if (refund.status === "SUCCESS") return {found: true, refunded: true, gatewayLabelId: routeSeg.gatewayLabelId}
        if (["QUEUED", "PENDING"].includes(refund.status)) return {found: true, refunded: false, pending: true}
    }
    const tx = read(gw, "/transactions/" + encodeURIComponent(routeSeg.gatewayLabelId), "transaction")
    if (tx.status === "REFUNDED") return {found: true, refunded: true, gatewayLabelId: tx.object_id}
    if (tx.status === "REFUNDPENDING") return {found: true, refunded: false, pending: true}
    return {found: true, refunded: false, gatewayLabelId: tx.object_id}
}

// ---- Refunds ----

// refund#ShippingLabels: each labelled package's refund, decided or pending. A refund recorded earlier is read again,
// never asked for twice; a refused request is checked against the label's transaction (it may be refunded already).
function refundPackage(gw, routeSeg) {
    const key = {
        shipmentId: routeSeg.shipmentId,
        shipmentPackageSeqId: routeSeg.shipmentPackageSeqId,
        shipmentRouteSegmentSeqId: routeSeg.shipmentRouteSegmentSeqId
    }
    const label = "package " + key.shipmentPackageSeqId + " of " + key.shipmentId
    let refund
    if (!blank(routeSeg.gatewayRefundId)) refund = read(gw, "/refunds/" + encodeURIComponent(routeSeg.gatewayRefundId), "refund")
    else {
        const sent = send(gw, "POST", "/refunds", {transaction: routeSeg.gatewayLabelId, async: false})
        if (sent.lost)
            denied(
                "CARRIER_TIMEOUT",
                "Shippo did not answer the refund of " + label + " (" + sent.lost + "); it is looked up first"
            )
        if (sent.data) refund = sent.data
        else {
            const tx = read(gw, "/transactions/" + encodeURIComponent(routeSeg.gatewayLabelId), "transaction")
            if (tx.status === "REFUNDED") refund = {status: "SUCCESS", object_id: null}
            else if (tx.status === "REFUNDPENDING") refund = {status: "PENDING", object_id: null}
            else
                denied(
                    sent.limited ? "RATE_LIMITED" : "REFUND_REFUSED",
                    "Shippo refused the refund of " + label + ": " + (sent.limited || sent.refused)
                )
        }
    }
    if (refund.status === "SUCCESS") {
        probe(
            "update#" + ROUTE_SEG,
            Object.assign({}, key, {
                gatewayRefundId: refund.object_id || routeSeg.gatewayRefundId,
                gatewayRefundStatus: "refunded"
            })
        )
        return {}
    }
    if (["QUEUED", "PENDING"].includes(refund.status)) {
        if (refund.object_id) probe("update#" + ROUTE_SEG, Object.assign({}, key, {gatewayRefundId: refund.object_id}))
        return {pending: true}
    }
    // an ERROR refund is not kept, so a later refund is asked for anew
    if (!blank(routeSeg.gatewayRefundId)) probe("update#" + ROUTE_SEG, Object.assign({}, key, {gatewayRefundId: null}))
    denied("REFUND_REFUSED", "Shippo refused the refund of " + label + " (" + (refund.status || "no status") + ")")
}
function refundLabels(p) {
    const gw = usable(p.shippingGatewayConfigId)
    const routeSegs = rows(ROUTE_SEG, {shipmentId: p.shipmentId, shipmentRouteSegmentSeqId: p.shipmentRouteSegmentSeqId})
        .filter(row => blank(p.shipmentPackageSeqId) || row.shipmentPackageSeqId === p.shipmentPackageSeqId)
        .filter(row => !blank(row.gatewayLabelId) && blank(row.gatewayRefundStatus))
    if (!routeSegs.length) denied("NO_LABEL", "There is no Shippo label to refund")
    let pending = false
    const failures = []
    for (const routeSeg of routeSegs) {
        try {
            if (refundPackage(gw, routeSeg).pending) pending = true
        } catch (error) {
            if (routeSegs.length === 1) throw error
            ec.logger.error(
                "Shippo refund of package " +
                    routeSeg.shipmentPackageSeqId +
                    " of " +
                    p.shipmentId +
                    ": " +
                    clip(errorText(error), 200)
            )
            failures.push(errorText(error))
        }
    }
    if (failures.length) throw new Error(severest(failures, pending))
    return {pending}
}

// ---- Tracking ----

// One package's tracking (or its return label's), read from its Shippo transaction: the status, the tracking number when
// Shippo changed it, the estimate, and a label file that was not downloaded yet. The status comes from Shippo, never from
// a webhook's payload; a webhook event of the same status adds its details (substatus, date, text). Nothing is written
// when nothing changed, so a repeated event is a no-op.
function trackPackage(gw, routeSeg, returnLabel, event) {
    const f = fieldOf(returnLabel)
    const labelId = routeSeg[f("gatewayLabelId")]
    if (blank(labelId)) return {skipped: true}
    const tx = read(gw, "/transactions/" + encodeURIComponent(labelId), "transaction")
    const status = tx.tracking_status && typeof tx.tracking_status === "object" ? tx.tracking_status.status : tx.tracking_status
    const statusEnumId = trackingStatuses[status] || null
    const key = {
        shipmentId: routeSeg.shipmentId,
        shipmentPackageSeqId: routeSeg.shipmentPackageSeqId,
        shipmentRouteSegmentSeqId: routeSeg.shipmentRouteSegmentSeqId
    }
    const values = {}
    if (!blank(tx.tracking_number) && tx.tracking_number !== routeSeg[f("trackingCode")])
        values[f("trackingCode")] = tx.tracking_number
    const detail = event?.tracking_status && event.tracking_status.status === status ? event.tracking_status : null
    if (statusEnumId && statusEnumId !== routeSeg[f("trackingStatusEnumId")]) {
        values[f("trackingStatusEnumId")] = statusEnumId
        values[f("trackingStatusDate")] = dateOf(detail?.status_date) || ec.user.nowTimestamp
    }
    if (detail) {
        const sub =
            detail.substatus && typeof detail.substatus === "object"
                ? detail.substatus.code || detail.substatus.text
                : detail.substatus
        if (!blank(sub) && clip(sub, 60) !== routeSeg[f("trackingSubStatus")]) values[f("trackingSubStatus")] = clip(sub, 60)
        const date = dateOf(detail.status_date)
        if (date && lib.ms(date) > (lib.ms(routeSeg[f("trackingStatusDate")]) ?? 0)) values[f("trackingStatusDate")] = date
    }
    if (!returnLabel) {
        const eta = dateOf(tx.eta ?? event?.eta)
        if (eta && lib.ms(eta) !== lib.ms(routeSeg.trackingEta)) values.trackingEta = eta
        const original = dateOf(event?.original_eta) || eta
        if (original && routeSeg.trackingOrigEta == null) values.trackingOrigEta = original
    }
    if (routeSeg[f("labelImage")] == null && !blank(tx.label_url)) {
        const image = download(tx.label_url)
        if (image) Object.assign(values, {[f("labelImage")]: image, [f("labelUrl")]: tx.label_url})
    }
    if (!Object.keys(values).length) return {changed: false, status}
    probe("update#" + ROUTE_SEG, Object.assign({}, key, values))
    return {changed: true, status}
}
// track#ShippingLabels: each labelled package of the segment (or the one given), outbound and return; a package that fails
// is logged and the others go on, and the call fails only when none could be read.
function trackLabels(p) {
    const gw = usable(p.shippingGatewayConfigId)
    const routeSegs = rows(ROUTE_SEG, {shipmentId: p.shipmentId, shipmentRouteSegmentSeqId: p.shipmentRouteSegmentSeqId}).filter(
        row => blank(p.shipmentPackageSeqId) || row.shipmentPackageSeqId === p.shipmentPackageSeqId
    )
    let tried = 0
    const failures = []
    for (const routeSeg of routeSegs) {
        for (const returnLabel of [false, true]) {
            if (blank(routeSeg[fieldOf(returnLabel)("gatewayLabelId")])) continue
            if (!returnLabel && routeSeg.trackingStatusEnumId === "ShTsDelivered") continue
            tried++
            try {
                trackPackage(gw, routeSeg, returnLabel, null)
            } catch (error) {
                ec.logger.error(
                    "Shippo tracking of package " +
                        routeSeg.shipmentPackageSeqId +
                        " of " +
                        p.shipmentId +
                        ": " +
                        clip(errorText(error), 200)
                )
                failures.push(errorText(error))
            }
        }
    }
    if (tried && failures.length === tried) throw new Error(failures[0])
    return {}
}

// ---- Address validation ----

// validate#ShippingPostalAddress: Shippo's validation of the address sets its trust level (valid, invalid, incomplete), the
// validation messages and Shippo's address id; the address itself is not rewritten. A provider failure leaves the address
// as it was and is reported, not thrown, so entering an order does not depend on Shippo being up.
function validateAddress(p) {
    const gw = usable(p.shippingGatewayConfigId)
    const postal = one(POSTAL, {contactMechId: p.contactMechId})
    if (!postal) return {contactMechId: p.contactMechId}
    const body = Object.assign(addressMap(p.contactMechId, p.partyId, !!p.facilityId), {validate: true})
    const sent = send(gw, "POST", "/addresses", body)
    if (!sent.data) {
        ec.logger.warn("Shippo validation of address " + p.contactMechId + " got no answer")
        ec.message.addMessage("Shippo could not validate the address: " + (sent.lost || sent.limited || sent.refused), "warning")
        return {contactMechId: p.contactMechId}
    }
    const data = sent.data
    const results = data.validation_results || {}
    const complete = data.is_complete !== false
    const valid =
        results.is_valid === true || (results.is_valid == null && complete && !Array.from(results.messages || []).length)
    const trustLevelEnumId = valid && complete ? "CmtlValid" : complete ? "CmtlInvalid" : "CmtlIncomplete"
    const message = messagesText(results.messages)
    call("update#mantle.party.contact.ContactMech", {
        contactMechId: p.contactMechId,
        trustLevelEnumId,
        validateMessage: clip(message || (valid ? "Valid (Shippo)" : "Not valid (Shippo)"))
    })
    if (!blank(data.object_id)) call("update#" + POSTAL, {contactMechId: p.contactMechId, shipGatewayAddressId: data.object_id})
    ec.logger.info("Shippo validated address " + p.contactMechId + ": " + trustLevelEnumId)
    return {contactMechId: p.contactMechId}
}

// ---- Webhooks ----

const webhookAuth = ["SmatHmacSha256Timestamp", "SmatUrlToken"]
// receive#Webhook: the endpoint (/rest/sm/ShippoWebhook/{remote}) checked the remote's HMAC header or URL token; this keeps
// the event once per remote and body (Shippo sends no event id: a repeated delivery has the same body). A remote whose
// endpoint authenticates nothing is refused.
function receiveWebhook(p) {
    if (blank(p.systemMessageRemoteId)) throw new Error("A Shippo webhook needs the remote of its endpoint")
    const remote = one(REMOTE, {systemMessageRemoteId: p.systemMessageRemoteId})
    if (!remote || !webhookAuth.includes(remote.messageAuthEnumId) || blank(remote.sharedSecret))
        denied(
            "WEBHOOK_UNAUTHENTICATED",
            "Remote " +
                p.systemMessageRemoteId +
                " does not authenticate Shippo webhooks (SmatHmacSha256Timestamp or SmatUrlToken " +
                "with its sharedSecret)"
        )
    let event
    try {
        event = JSON.parse(String(p.messageText))
    } catch (_) {
        throw new Error("The Shippo webhook is not JSON")
    }
    if (!event?.event || event.data == null) throw new Error("The Shippo webhook has no event or data")
    const digest = String(ec.user.singleUseCodeHash(String(p.messageText))).replace(/[^A-Za-z0-9]/g, "")
    return call("org.moqui.impl.SystemMessageServices.store#ReceivedSystemMessage", {
        systemMessageTypeId: p.systemMessageTypeId,
        systemMessageRemoteId: p.systemMessageRemoteId,
        messageId: "shippo-" + digest.slice(0, 48),
        messageText: p.messageText,
        remoteMessageId: p.remoteMessageId,
        messageDate: dateOf(event.data?.object_updated) || ec.user.nowTimestamp,
        docType: clip(event.event, 60)
    })
}
// consume#Webhook: the packages an event is about, among the shipments of the Shippo gateways on the message's remote (by
// the transaction id, the rate, the request reference in its metadata, or the tracking number). A package with a request
// still without an answer has that request finished through find#ShippingLabels (Shipping.js finishPending); any other is
// tracked through its transaction. The payload is never applied as it is; a test event on a production remote (and the
// reverse) is consumed with nothing done. One package that fails is logged and the others go on; the message then fails,
// to be retried.
function consumeWebhook(p) {
    const message = one("moqui.service.message.SystemMessage", {systemMessageId: p.systemMessageId})
    const event = lib.json(message?.messageText, {})
    const data = event.data && typeof event.data === "object" ? event.data : {}
    const remote = message && one(REMOTE, {systemMessageRemoteId: message.systemMessageRemoteId})
    const gatewayIds = message
        ? rows(CONFIG, {systemMessageRemoteId: message.systemMessageRemoteId, shippingGatewayTypeEnumId: GATEWAY_TYPE}).map(
              row => row.shippingGatewayConfigId
          )
        : []
    if (!gatewayIds.length) return {}
    // an event that states no test flag is consumed: the remote authenticated it, and consuming only reads the provider's
    // state with this remote's own token, so it can change nothing the account does not report
    if (typeof event.test === "boolean" && event.test !== (remote?.usageCode !== "P")) {
        ec.logger.warn(
            "Shippo " + event.event + " test=" + event.test + " on remote " + remote?.systemMessageRemoteId + ": ignored"
        )
        return {}
    }
    const routeSegKeys = new Map()
    const requests = new Map()
    const addRouteSegs = conditions => {
        for (const row of rows(ROUTE_SEG, conditions))
            routeSegKeys.set(row.shipmentId + "|" + row.shipmentPackageSeqId + "|" + row.shipmentRouteSegmentSeqId, row)
    }
    let transactionId = null
    if (["transaction_created", "transaction_updated"].includes(event.event)) {
        transactionId = data.object_id || null
        const rateId = data.rate && typeof data.rate === "object" ? data.rate.object_id : data.rate
        const reference = referenceOf(data.metadata)
        if (reference) {
            const request = one(REQUEST, {shippingGatewayRequestId: reference})
            if (request && gatewayIds.includes(request.shippingGatewayConfigId)) requests.set(reference, request)
        }
        if (!blank(rateId)) {
            addRouteSegs({gatewayRateId: String(rateId)})
            addRouteSegs({returnGatewayRateId: String(rateId)})
        }
    } else if (event.event === "track_updated") {
        transactionId = data.transaction || null
        if (blank(transactionId) && !blank(data.tracking_number)) {
            addRouteSegs({trackingCode: String(data.tracking_number)})
            addRouteSegs({returnTrackingCode: String(data.tracking_number)})
        }
    } else return {}
    if (!blank(transactionId)) {
        addRouteSegs({gatewayLabelId: String(transactionId)})
        addRouteSegs({returnGatewayLabelId: String(transactionId)})
    }
    const shipping = ec.resource.script("component://mr-mantle/service/mantle/shipment/Shipping.js")
    // the gateway of a package as the label flow knows it: the one its latest gateway request was recorded against,
    // else the segment's gateway in Mantle's lookup order (the store's for the carrier first, then the segment's)
    const gatewayOfPackage = routeSeg =>
        Array.from(
            find(REQUEST, {
                shipmentId: routeSeg.shipmentId,
                shipmentPackageSeqId: routeSeg.shipmentPackageSeqId,
                shipmentRouteSegmentSeqId: routeSeg.shipmentRouteSegmentSeqId
            })
                .condition("requestTypeEnumId", "in", ["SgrLabel", "SgrReturnLabel", "SgrRefund"])
                .orderBy("-requestDate")
                .orderBy("-shippingGatewayRequestId")
                .limit(1)
                .list()
        )[0]?.shippingGatewayConfigId ||
        shipping.gatewayOf(routeSeg.shipmentId, routeSeg.shipmentRouteSegmentSeqId)?.shippingGatewayConfigId
    const work = []
    for (const routeSeg of routeSegKeys.values()) {
        const shippingGatewayConfigId = gatewayOfPackage(routeSeg)
        if (!gatewayIds.includes(shippingGatewayConfigId)) continue
        const open = Array.from(
            find(REQUEST, {
                shipmentId: routeSeg.shipmentId,
                shipmentPackageSeqId: routeSeg.shipmentPackageSeqId,
                shipmentRouteSegmentSeqId: routeSeg.shipmentRouteSegmentSeqId,
                statusId: "SgrqUnknown"
            })
                .condition("shippingGatewayConfigId", "in", gatewayIds)
                .condition("requestTypeEnumId", "in", ["SgrLabel", "SgrReturnLabel", "SgrRefund"])
                .list()
        )
        for (const request of open) requests.set(request.shippingGatewayRequestId, request)
        if (!open.length) work.push({routeSeg, shippingGatewayConfigId})
    }
    for (const request of requests.values()) work.push({request})
    if (!work.length) ec.logger.info("Shippo " + event.event + ": no Mantle package")
    const failed = []
    for (const item of work) {
        try {
            if (item.request) {
                if (item.request.statusId !== "SgrqUnknown") continue
                const out = shipping.execute("finishPending", {
                    shippingGatewayRequestId: item.request.shippingGatewayRequestId,
                    anyReason: true
                })
                const result = Array.from(out.results || [])[0]
                if (result && !result.ok) throw new Error(result.reasonCode + ": " + (result.message || ""))
            } else {
                const routeSeg = item.routeSeg
                const gw = usable(item.shippingGatewayConfigId)
                const returnLabel =
                    !blank(transactionId) && routeSeg.returnGatewayLabelId === transactionId
                        ? true
                        : !blank(data.tracking_number) &&
                          routeSeg.returnTrackingCode === data.tracking_number &&
                          routeSeg.trackingCode !== data.tracking_number
                trackPackage(gw, routeSeg, returnLabel, event.event === "track_updated" ? data : null)
            }
        } catch (error) {
            const name = item.request
                ? "request " + item.request.shippingGatewayRequestId
                : "package " + item.routeSeg.shipmentPackageSeqId + " of " + item.routeSeg.shipmentId
            ec.logger.error("Shippo " + event.event + ": " + name + " failed: " + clip(errorText(error), 200))
            failed.push(name)
        }
    }
    if (failed.length)
        throw new Error("Shippo " + event.event + " of " + failed.join(", ") + " failed; the event is kept to retry")
    return {}
}

const operations = {
    ratesBulk,
    orderRate,
    rate: p => shipmentRate(p),
    requestLabels,
    findLabels,
    refundLabels,
    trackLabels,
    validateAddress,
    receiveWebhook,
    consumeWebhook
}
// get#ShippingRate: a shipment's packages (or one) at the segment's method or the one given.
function shipmentRate(p) {
    const gw = usable(p.shippingGatewayConfigId)
    const shipment = one(SHIPMENT, {shipmentId: p.shipmentId})
    const segment = one(SEGMENT, {shipmentId: p.shipmentId, shipmentRouteSegmentSeqId: p.shipmentRouteSegmentSeqId})
    if (!shipment || !segment)
        denied("RECORD_UNAVAILABLE", "Route segment " + p.shipmentRouteSegmentSeqId + " is not on " + p.shipmentId)
    const carrierPartyId = p.carrierPartyId || segment.carrierPartyId
    const shipmentMethodEnumId = p.shipmentMethodEnumId || segment.shipmentMethodEnumId
    const ctx = labelContext(gw, Object.assign({}, p, {shipmentMethodEnumId}), false)
    const packages = rows(PACKAGE, {shipmentId: p.shipmentId}).filter(
        row => blank(p.shipmentPackageSeqId) || row.shipmentPackageSeqId === p.shipmentPackageSeqId
    )
    if (!packages.length) denied("NO_PACKAGES", "Shipment " + p.shipmentId + " has no package to rate")
    const rate = quote(gw, {
        methods: [{carrierPartyId, shipmentMethodEnumId}],
        packages,
        addressFrom: ctx.addresses.address_from,
        addressTo: ctx.addresses.address_to
    })[0]
    if (!rate) denied("METHOD_UNAVAILABLE", "Shippo has no rate for " + carrierPartyId + " " + shipmentMethodEnumId)
    return {shippingTotal: rate.shippingTotal, currency: rate.currency, days: rate.days, serviceName: rate.serviceName}
}
;({
    API_VERSION,
    trackingStatuses,
    execute(op, input) {
        if (!operations[op]) throw new Error("Unknown Shippo operation " + op)
        const was = ec.artifactExecution.disableAuthz()
        try {
            return operations[op](input || {})
        } finally {
            if (!was) ec.artifactExecution.enableAuthz()
        }
    }
})
