// A store's checkout settings (impl-commerce P6, COM-CHECKOUT; design-commerce §8 CheckoutSettings): the checkout policy as
// dated ProductStoreSetting types (§4, F14), the ship options and shipping gateways a store offers, its local shipping rates
// (ProductStoreShippingRate) with their rating rule and simulator, the payment gateways it takes (only the organization's
// enabled, current PaymentGatewayOrganization rows, Z4), its tax gateway and display with a preview over simulate#SalesTax's
// calculation, and the purchase readiness findings StoreAdmin.js lists. Each operation checks COMMERCE_VIEW to read and
// COMMERCE_STORE_EDIT to change, and the store's scope (StoreAdmin.js: its organization, a store-limited staff member's own
// stores); reads and writes below the checks run without artifact authorization.
//
// Removing a ship option, shipping gateway or payment gateway binding deletes its row, which the framework does not audit
// (F61): the removal writes its own EntityAuditLog row with the user and reason, so the store's History shows it.
//
// The local rating rule (F20): a store with a rate in effect now or later is rated by its rates, the lowest priority number
// among the rates that match the part's zone, carrier and method, currency, weight and value; no match means no delivery,
// never a free one. A store with no rates keeps get#OrderShippingRateLocal's default (zero).
//
// Later phases extend the tables rather than the functions: checkoutPolicy (P10's and P12's policies have their own),
// gatewayCapabilities (Shop P5's hosted checkout, P7's off-session).
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const admin = () => ec.resource.script("component://mr-mantle/service/mantle/product/StoreAdmin.js")
const {find, one, rows, denied, call, ms, active, dateText, partyNames} = lib
const S = "mantle.product.store."
const RATE = S + "ProductStoreShippingRate"
const SETTING = S + "ProductStoreSetting"
const SHIP_OPTION = S + "ProductStoreShipOption"
const SHIP_GATEWAY = S + "ProductStoreShippingGateway"
const PAY_GATEWAY = S + "ProductStorePaymentGateway"
const choiceLimit = 30

// ===== tables =====
// CheckoutPolicy's fields, each a setting type (StoreAdmin.js settingTypes validates its value) with the value an absent row
// means. Shop's checkout reads them through get#CheckoutSettings' policy.
const checkoutPolicy = {
    accountMode: {settingTypeEnumId: "PsstCheckoutAccount", defaultValue: "either", label: "Guest or account checkout"},
    destinations: {settingTypeEnumId: "PsstCheckoutDestinations", defaultValue: "", label: "Destinations"},
    stockDisclosure: {settingTypeEnumId: "PsstCheckoutStockDisclosure", defaultValue: "availability", label: "Stock disclosure"},
    termsRequired: {settingTypeEnumId: "PsstCheckoutTerms", defaultValue: "true", label: "Terms acceptance"},
    contactPhone: {settingTypeEnumId: "PsstCheckoutPhone", defaultValue: "optional", label: "Purchase contact phone"},
    supportQueueId: {settingTypeEnumId: "PsstCheckoutSupportQueue", defaultValue: "", label: "Support queue"}
}
// TaxDisplay's settings beside the store's tax gateway (ProductStore.taxGatewayConfigId, store#Store's policy field).
const taxSettings = {
    taxDisplay: {settingTypeEnumId: "PsstTaxDisplay", defaultValue: "exclusive", label: "Tax display"},
    taxOriginFacilityId: {settingTypeEnumId: "PsstTaxOrigin", defaultValue: "", label: "Tax origin"}
}
const choiceTexts = {
    either: "Guest or account",
    account: "Account only",
    guest: "Guest only",
    hidden: "Hidden",
    availability: "Availability bands",
    backorder: "Availability, backorder disclosed",
    optional: "Optional",
    required: "Required",
    exclusive: "Prices exclude tax",
    inclusive: "Prices include tax",
    true: "Required",
    false: "Not asked"
}
// What each kind of payment gateway can do for Shop (design-shop §8.1): a hosted checkout page, saved payment methods and
// off-session (recurring) charges. Shop P5 (Accept Hosted) and P7 (off-session) turn theirs on; a gateway whose type is not
// here offers none. The test gateway with a hosted page (hostedPending) is hosted.
const gatewayCapabilities = {
    PgtTest: config => ({
        hostedCheckout: String(config.authorizeServiceName || "").includes("hostedPending"),
        savedMethods: false,
        offSession: false
    }),
    PgtAuthorizeNet: () => ({hostedCheckout: false, savedMethods: true, offSession: false}),
    PgtPayTrace: () => ({hostedCheckout: false, savedMethods: false, offSession: false})
}
const capabilityTexts = {hostedCheckout: "Hosted checkout", savedMethods: "Saved methods", offSession: "Off-session"}
const physicalTypes = ["PtAsset", "PtDigitalAsset", "PtAssetUse", "PtPickAssembly"]
const LOCAL_RATE_SERVICE = "mantle.shipment.CarrierServices.get#OrderShippingRateLocal"

// ===== values =====
const text = value => (value == null ? "" : String(value).trim())
const blank = value => value == null || value === ""
// a number of an entity value (a decimal, which has no valueOf) or a parameter; null when empty
const num = value =>
    blank(value)
        ? null
        : typeof value === "object" && typeof value.toNumber === "function"
          ? value.toNumber()
          : Number(String(value))
const enumText = enumId => (enumId ? one("moqui.basic.Enumeration", {enumId})?.description || enumId : "")
const nowMs = () => ms(ec.user.nowTimestamp)
const ending = p => p.end === true || p.end === "true" || p.end === "Y"
const removing = p => p.remove === true || p.remove === "true" || p.remove === "Y"
function reason(p, required) {
    const why = text(p.changeReason)
    if (!why && required) denied("REASON_REQUIRED", "Give a reason for the change")
    if (why.length > 255) denied("VALUE_INVALID", "The reason is at most 255 characters")
    return why || null
}
// A start date: now when empty, never more than a minute past (a past start would rewrite what the store offered).
function startOf(value, label) {
    const at = admin().dateOf(value, nowMs(), label)
    if (at < nowMs() - 60000) denied("VALUE_INVALID", "The " + label + " is now or later")
    return at
}
function decimalOf(value, label, required) {
    if (blank(value)) {
        if (required) denied("VALUE_INVALID", label + " is required")
        return null
    }
    const number = num(String(value))
    if (!Number.isFinite(number) || number < 0) denied("VALUE_INVALID", label + " is a number of at least 0")
    return String(value).trim()
}
function partyName(partyId) {
    return partyId ? partyNames([partyId])[partyId] || partyId : ""
}
const carrierText = partyId => (!partyId ? "Any carrier" : partyId === "_NA_" ? "Own delivery" : partyName(partyId))
function methodText(carrierPartyId, shipmentMethodEnumId) {
    if (!shipmentMethodEnumId) return "any method"
    const row = carrierPartyId
        ? one("mantle.shipment.carrier.CarrierShipmentMethod", {carrierPartyId, shipmentMethodEnumId})
        : null
    return row?.description || enumText(shipmentMethodEnumId)
}
const geoText = geoId => (geoId ? one("moqui.basic.Geo", {geoId})?.geoName || geoId : "")
const uomText = uomId => (uomId ? one("moqui.basic.Uom", {uomId})?.abbreviation || uomId : "")
const moneyText = (value, currency) => (blank(value) ? "" : ec.l10n.formatCurrency(toDecimal(value), currency))
// The removal of an undated binding, which the framework does not audit (F61): one audit row naming what was removed.
function recordRemoval(entity, productStoreId, secondary, field, oldValue, why) {
    call("create#moqui.entity.EntityAuditLog", {
        changedEntityName: entity,
        changedFieldName: field,
        pkPrimaryValue: productStoreId,
        pkSecondaryValue: secondary,
        oldValueText: oldValue,
        newValueText: "(removed)",
        changeReason: why,
        changedDate: ec.user.nowTimestamp,
        changedByUserId: ec.user.userId
    })
}

// ===== settings =====
// The setting row of a type in effect at a time, else null.
function settingAt(productStoreId, settingTypeEnumId, at = nowMs()) {
    return rows(SETTING, {productStoreId, settingTypeEnumId}).find(row => active(row, at)) || null
}
function settingsOf(store, table, at) {
    const out = {}
    for (const [field, definition] of Object.entries(table)) {
        const row = settingAt(store.productStoreId, definition.settingTypeEnumId, at)
        const later = rows(SETTING, {productStoreId: store.productStoreId, settingTypeEnumId: definition.settingTypeEnumId})
            .filter(candidate => ms(candidate.fromDate) > at)
            .sort((a, b) => ms(a.fromDate) - ms(b.fromDate))[0]
        out[field] = row ? row.settingValue : definition.defaultValue
        out[field + "Default"] = !row
        out[field + "FromText"] = row ? dateText(row.fromDate) : ""
        out[field + "Next"] = later ? later.settingValue : null
        out[field + "NextText"] = later ? dateText(later.fromDate) : ""
    }
    return out
}
// A dated setting set to a value from a date, or ended (an empty value: the default applies again), with its reason.
function saveSetting(store, settingTypeEnumId, value, fromDate, why) {
    const key = {productStoreId: store.productStoreId, settingTypeEnumId}
    const lib2 = admin()
    if (blank(value)) {
        const current = rows(SETTING, key).find(row => active(row, fromDate))
        if (!current) return false
        call("update#" + SETTING, Object.assign({}, key, {fromDate: current.fromDate, thruDate: fromDate, changeReason: why}))
        return true
    }
    const kept = lib2.settingValue(lib2.settingTypes[settingTypeEnumId], value, enumText(settingTypeEnumId), store)
    const current = rows(SETTING, key).find(row => active(row, fromDate))
    if (current && current.settingValue === kept) return false
    lib2.saveDated(SETTING, key, {settingValue: kept, changeReason: why}, {fromDate})
    return true
}
// store#CheckoutPolicy: the policy's fields from a date (now when empty), each changed one a new dated setting ending the one
// it replaces; an empty field ends its setting, so its default applies. A change needs its reason.
function storeCheckoutPolicy(p) {
    const s = admin().scope("edit")
    const store = admin().storeOf(s, p.productStoreId)
    return storeSettings(store, checkoutPolicy, p)
}
function storeSettings(store, table, p) {
    const fromDate = startOf(p.fromDate, "start date")
    const given = Object.keys(table).filter(field => Object.hasOwn(p, field) && p[field] !== undefined)
    const current = settingsOf(store, table, fromDate)
    const changes = given.filter(field => {
        const value = text(p[field])
        return current[field + "Default"] ? value !== "" && value !== table[field].defaultValue : value !== current[field]
    })
    if (!changes.length) return {productStoreId: store.productStoreId, changed: []}
    const why = reason(p, true)
    const changed = []
    for (const field of changes)
        if (saveSetting(store, table[field].settingTypeEnumId, text(p[field]), fromDate, why)) changed.push(field)
    return {productStoreId: store.productStoreId, changed}
}

// ===== shipping options and gateways =====
function carrierMethodOf(carrierPartyId, shipmentMethodEnumId) {
    const row =
        carrierPartyId && shipmentMethodEnumId
            ? one("mantle.shipment.carrier.CarrierShipmentMethod", {carrierPartyId, shipmentMethodEnumId})
            : null
    if (!row) denied("METHOD_NOT_OFFERED", "Choose a carrier and method the carrier offers")
    return row
}
// store#ShippingOption: a carrier's method offered by the store (create#StoreShippingOption), its order and markup changed,
// or removed with a reason (recorded in History, F61).
function storeShippingOption(p) {
    const s = admin().scope("edit")
    const store = admin().storeOf(s, p.productStoreId)
    const key = {
        productStoreId: store.productStoreId,
        carrierPartyId: p.carrierPartyId,
        shipmentMethodEnumId: p.shipmentMethodEnumId
    }
    const existing = p.carrierPartyId && p.shipmentMethodEnumId ? one(SHIP_OPTION, key) : null
    if (removing(p)) {
        if (!existing) denied("RECORD_UNAVAILABLE", "The store does not offer that method")
        const why = reason(p, true)
        call("delete#" + SHIP_OPTION, key)
        recordRemoval(
            SHIP_OPTION,
            store.productStoreId,
            p.carrierPartyId,
            "shipmentMethodEnumId",
            carrierText(p.carrierPartyId) + " " + methodText(p.carrierPartyId, p.shipmentMethodEnumId),
            why
        )
        return {productStoreId: store.productStoreId, removed: true}
    }
    carrierMethodOf(p.carrierPartyId, p.shipmentMethodEnumId)
    const sequenceNum = blank(p.sequenceNum) ? null : num(String(p.sequenceNum))
    if (sequenceNum != null && !Number.isInteger(sequenceNum)) denied("VALUE_INVALID", "The order is a whole number")
    const markupPercent = decimalOf(p.markupPercent, "The markup percent", false)
    if (markupPercent != null && num(markupPercent) > 100) denied("VALUE_INVALID", "The markup percent is at most 100")
    const markupAmount = decimalOf(p.markupAmount, "The markup amount", false)
    if (!existing) call("mantle.product.StoreServices.create#StoreShippingOption", Object.assign({}, key, {sequenceNum}))
    call("update#" + SHIP_OPTION, Object.assign({}, key, {sequenceNum, markupPercent, markupAmount}))
    return {productStoreId: store.productStoreId, removed: false}
}
// A shipping gateway approved for a carrier: Mantle's local gateway (any carrier), or one the gateway serves the carrier
// through (ShippingGatewayCarrier).
function gatewayApproved(config, carrierPartyId) {
    if (!config) return false
    if (config.shippingGatewayTypeEnumId === "ShGtwyLocal" || config.getOrderRateServiceName === LOCAL_RATE_SERVICE) return true
    return !!one("mantle.shipment.carrier.ShippingGatewayCarrier", {
        shippingGatewayConfigId: config.shippingGatewayConfigId,
        carrierPartyId
    })
}
const isLocalGateway = config =>
    !!config && (config.getOrderRateServiceName === LOCAL_RATE_SERVICE || config.shippingGatewayTypeEnumId === "ShGtwyLocal")
const billingTypes = ["SENDER", "RECIPIENT", "THIRD_PARTY"]
// store#StoreShippingGateway: the gateway that rates and labels a carrier's shipments for the store, from the approved ones,
// with its billing and insurance defaults; a changed gateway needs a reason (audit-logged), a removal records its own.
function storeStoreShippingGateway(p) {
    const s = admin().scope("edit")
    const store = admin().storeOf(s, p.productStoreId)
    if (!p.carrierPartyId || !one("mantle.shipment.carrier.CarrierShipmentMethod", {carrierPartyId: p.carrierPartyId}))
        if (!removing(p)) denied("VALUE_INVALID", "Choose a carrier")
    const key = {productStoreId: store.productStoreId, carrierPartyId: p.carrierPartyId}
    const existing = p.carrierPartyId ? one(SHIP_GATEWAY, key) : null
    if (removing(p)) {
        if (!existing) denied("RECORD_UNAVAILABLE", "The store has no gateway for that carrier")
        const why = reason(p, true)
        call("delete#" + SHIP_GATEWAY, key)
        recordRemoval(
            SHIP_GATEWAY,
            store.productStoreId,
            p.carrierPartyId,
            "shippingGatewayConfigId",
            existing.shippingGatewayConfigId,
            why
        )
        return {productStoreId: store.productStoreId, removed: true}
    }
    const config = p.shippingGatewayConfigId
        ? one("mantle.shipment.carrier.ShippingGatewayConfig", {shippingGatewayConfigId: p.shippingGatewayConfigId})
        : null
    if (!gatewayApproved(config, p.carrierPartyId))
        denied("GATEWAY_NOT_APPROVED", "Choose a shipping gateway approved for " + carrierText(p.carrierPartyId))
    const values = {
        shippingGatewayConfigId: config.shippingGatewayConfigId,
        billingType: blank(p.billingType) ? null : text(p.billingType),
        billingAccount: blank(p.billingAccount) ? null : text(p.billingAccount),
        billingZip: blank(p.billingZip) ? null : text(p.billingZip),
        billingCountry: blank(p.billingCountry) ? null : text(p.billingCountry).toUpperCase(),
        insurancePercent: decimalOf(p.insurancePercent, "The insurance percent", false)
    }
    if (values.billingType && !billingTypes.includes(values.billingType))
        denied("VALUE_INVALID", "Billing is SENDER, RECIPIENT or THIRD_PARTY")
    if (values.billingCountry && !/^[A-Z]{2}$/.test(values.billingCountry))
        denied("VALUE_INVALID", "The billing country is its two-letter code")
    if (values.insurancePercent != null && num(values.insurancePercent) > 100)
        denied("VALUE_INVALID", "The insurance percent is at most 100")
    for (const field of ["billingAccount", "billingZip"])
        if (values[field] && (values[field].length > 60 || /[\r\n\x00]/.test(values[field])))
            denied("VALUE_INVALID", "The " + field + " is one line of at most 60 characters")
    if (!existing) {
        call("create#" + SHIP_GATEWAY, Object.assign({}, key, values))
        return {productStoreId: store.productStoreId, removed: false}
    }
    const changedGateway = existing.shippingGatewayConfigId !== values.shippingGatewayConfigId
    const why = reason(p, changedGateway)
    const reasons = why ? {shippingGatewayConfigId_changeReason: why} : {}
    ec.context.putAll(reasons)
    call("update#" + SHIP_GATEWAY, Object.assign({}, key, values, reasons))
    return {productStoreId: store.productStoreId, removed: false}
}

// ===== local shipping rates =====
// The members of a destination zone: the geo and, through GAT_GROUP_MEMBER, its members (groups of groups too).
function zoneMembers(geoId, cache) {
    if (cache[geoId]) return cache[geoId]
    const members = new Set([geoId])
    let frontier = [geoId]
    for (let depth = 0; depth < 5 && frontier.length; depth++) {
        const next = []
        for (const id of frontier)
            for (const row of rows("moqui.basic.GeoAssoc", {geoId: id, geoAssocTypeEnumId: "GAT_GROUP_MEMBER"}))
                if (!members.has(row.toGeoId)) {
                    members.add(row.toGeoId)
                    next.push(row.toGeoId)
                }
        frontier = next
    }
    return (cache[geoId] = members)
}
const inZone = (geoId, geoIdSet, cache) => geoIdSet.some(id => zoneMembers(geoId, cache).has(id))
// [from, thru): a value in a band; an empty bound is open.
const inBand = (value, from, thru) => (blank(from) || num(value) >= num(from)) && (blank(thru) || num(value) < num(thru))
const bandsOverlap = (aFrom, aThru, bFrom, bThru) =>
    (blank(aThru) || blank(bFrom) || num(bFrom) < num(aThru)) && (blank(bThru) || blank(aFrom) || num(aFrom) < num(bThru))
// The weight of a part's items in a unit, or null when one cannot be converted; an item with no shipping weight counts as 1,
// as Mantle's local gateway counts it.
function weightIn(weights, uomId) {
    let total = 0
    for (const weight of weights) {
        if (!weight.uomId || !uomId || weight.uomId === uomId) {
            total += weight.value
            continue
        }
        try {
            const out = lib.probe("org.moqui.impl.BasicServices.convert#Uom", {
                uomId: weight.uomId,
                toUomId: uomId,
                amount: weight.value
            })
            if (out.convertedAmount == null) return null
            total += num(out.convertedAmount)
        } catch (error) {
            return null
        }
    }
    return total
}
// What a store's rates are matched on for an order part: its shipped product items' value and weights, in the order's
// currency (the items Mantle's local gateway counts).
function partMeasure(orderId, orderPartSeqId) {
    const header = one("mantle.order.OrderHeader", {orderId})
    const productTypes = rows("moqui.basic.EnumGroupMember", {enumGroupEnumId: "EngItemsProduct"}).map(row => row.enumId)
    const items = find("mantle.order.OrderItem", {orderId, orderPartSeqId}).condition("itemTypeEnumId", "in", productTypes).list()
    let amount = 0
    let itemCount = 0
    const weights = []
    for (const item of Array.from(items)) {
        const product = item.productId ? one("mantle.product.Product", {productId: item.productId}) : null
        if (!product || product.chargeShipping === "N" || !physicalTypes.includes(product.productTypeEnumId)) continue
        const quantity = num(item.quantity ?? 1)
        itemCount++
        amount += quantity * num(item.unitAmount ?? 0)
        const dimension = one("mantle.product.ProductDimension", {productId: item.productId, dimensionTypeId: "ShippingWeight"})
        weights.push({value: num(dimension?.value ?? 1) * quantity, uomId: dimension?.valueUomId || null})
    }
    return {itemCount, amount, weights, currencyUomId: header?.currencyUomId || null}
}
// The rates of a store in effect now or later; a store with one is rated by its rates.
function liveRates(productStoreId, at = nowMs()) {
    return rows(RATE, {productStoreId}).filter(row => (ms(row.thruDate) ?? Infinity) > at)
}
// The rate that applies to a sale: the store's rates in effect at the time that match its zone, carrier, method, currency,
// weight and value, the lowest priority number first, then the latest start. {rate, shippingTotal} or {rate: null, reason}.
function rate(productStoreId, sale, storeRates = null) {
    const at = sale.at ?? nowMs()
    const cache = {}
    const candidates = (storeRates || rows(RATE, {productStoreId}))
        .filter(row => active(row, at))
        .filter(row => inZone(row.geoId, sale.geoIdSet, cache))
        .filter(row => !row.carrierPartyId || row.carrierPartyId === sale.carrierPartyId)
        .filter(row => !row.shipmentMethodEnumId || row.shipmentMethodEnumId === sale.shipmentMethodEnumId)
        .filter(row => !sale.currencyUomId || row.currencyUomId === sale.currencyUomId)
        .filter(row => inBand(sale.amount, row.fromAmount, row.thruAmount))
        .filter(row => {
            if (blank(row.fromWeight) && blank(row.thruWeight)) return true
            const weight = weightIn(sale.weights, row.weightUomId)
            return weight != null && inBand(weight, row.fromWeight, row.thruWeight)
        })
        .sort(
            (a, b) =>
                num(a.priority ?? 0) - num(b.priority ?? 0) ||
                ms(b.fromDate) - ms(a.fromDate) ||
                String(a.shippingRateId).localeCompare(String(b.shippingRateId))
        )
    if (!candidates.length) return {rate: null, reason: "No local rate delivers there"}
    return {rate: candidates[0], shippingTotal: toDecimal(candidates[0].shippingAmount ?? 0)}
}
// get#StoreShippingRateLocal, the local gateway's rule (no permission: order flows call it): whether the store is rated by its
// rates and, when it is, the part's charge or that nothing delivers it. Every cart change of every store runs it (the order
// item ECA's shipping calculation, F-P6-2), so a store with no rates costs the one indexed read of its rates.
function getStoreShippingRateLocal(p) {
    const live = p.productStoreId ? liveRates(p.productStoreId) : []
    if (!live.length) return {rated: false, available: true}
    const measure = partMeasure(p.orderId, p.orderPartSeqId)
    const found = rate(
        p.productStoreId,
        {
            geoIdSet: Array.from(p.geoIdSet || []).map(String),
            carrierPartyId: p.carrierPartyId,
            shipmentMethodEnumId: p.shipmentMethodEnumId,
            currencyUomId: measure.currencyUomId,
            amount: measure.amount,
            weights: measure.weights
        },
        live
    )
    return found.rate
        ? {rated: true, available: true, shippingTotal: found.shippingTotal, shippingRateId: found.rate.shippingRateId}
        : {rated: true, available: false, shippingTotal: null, shippingRateId: null}
}
const rateFields = [
    "geoId",
    "carrierPartyId",
    "shipmentMethodEnumId",
    "fromWeight",
    "thruWeight",
    "weightUomId",
    "fromAmount",
    "thruAmount",
    "shippingAmount",
    "currencyUomId",
    "priority",
    "description"
]
function rateValues(store, p, base) {
    const v = {}
    for (const field of rateFields) v[field] = Object.hasOwn(p, field) && p[field] !== undefined ? p[field] : base?.[field]
    for (const field of rateFields) if (blank(v[field])) v[field] = null
    if (!v.geoId || !one("moqui.basic.Geo", {geoId: v.geoId})) denied("VALUE_INVALID", "Choose a destination zone")
    if (v.carrierPartyId && !one("mantle.shipment.carrier.CarrierShipmentMethod", {carrierPartyId: v.carrierPartyId}))
        denied("VALUE_INVALID", "Choose a carrier")
    if (v.shipmentMethodEnumId) {
        if (one("moqui.basic.Enumeration", {enumId: v.shipmentMethodEnumId})?.enumTypeId !== "ShipmentMethod")
            denied("VALUE_INVALID", "Choose a shipment method")
        if (v.carrierPartyId) carrierMethodOf(v.carrierPartyId, v.shipmentMethodEnumId)
    }
    v.fromWeight = decimalOf(v.fromWeight, "The weight from", false)
    v.thruWeight = decimalOf(v.thruWeight, "The weight up to", false)
    v.fromAmount = decimalOf(v.fromAmount, "The value from", false)
    v.thruAmount = decimalOf(v.thruAmount, "The value up to", false)
    v.shippingAmount = decimalOf(v.shippingAmount, "The charge", true)
    if (v.fromWeight != null && v.thruWeight != null && num(v.thruWeight) <= num(v.fromWeight))
        denied("BAND_INVALID", "The weight band's upper bound is above its lower bound")
    if (v.fromAmount != null && v.thruAmount != null && num(v.thruAmount) <= num(v.fromAmount))
        denied("BAND_INVALID", "The value band's upper bound is above its lower bound")
    if (v.fromWeight != null || v.thruWeight != null) {
        if (!v.weightUomId || one("moqui.basic.Uom", {uomId: v.weightUomId})?.uomTypeEnumId !== "UT_WEIGHT_MEASURE")
            denied("VALUE_INVALID", "A weight band names its unit of weight")
    } else v.weightUomId = null
    v.currencyUomId = v.currencyUomId || store.defaultCurrencyUomId
    if (!v.currencyUomId || one("moqui.basic.Uom", {uomId: v.currencyUomId})?.uomTypeEnumId !== "UT_CURRENCY_MEASURE")
        denied("VALUE_INVALID", "Choose the rate's currency")
    const priority = v.priority == null ? 10 : num(String(v.priority))
    if (!Number.isInteger(priority) || priority < 0) denied("VALUE_INVALID", "The priority is a whole number of at least 0")
    v.priority = priority
    if (v.description && String(v.description).length > 255) denied("VALUE_INVALID", "The description is at most 255 characters")
    return v
}
// Two rates overlap when a sale could match both at the same priority: the same zone, carrier and method (an empty one is any),
// currency, overlapping weight bands (of one unit) and value bands, and overlapping dates.
function overlapping(a, b) {
    const sameOrAny = (x, y) => !x || !y || x === y
    const datesOverlap =
        (ms(a.thruDate) ?? Infinity) > (ms(b.fromDate) ?? -Infinity) &&
        (ms(b.thruDate) ?? Infinity) > (ms(a.fromDate) ?? -Infinity)
    const weightsOverlap =
        a.weightUomId && b.weightUomId && a.weightUomId !== b.weightUomId
            ? true
            : bandsOverlap(a.fromWeight, a.thruWeight, b.fromWeight, b.thruWeight)
    return (
        num(a.priority ?? 0) === num(b.priority ?? 0) &&
        a.geoId === b.geoId &&
        sameOrAny(a.carrierPartyId, b.carrierPartyId) &&
        sameOrAny(a.shipmentMethodEnumId, b.shipmentMethodEnumId) &&
        a.currencyUomId === b.currencyUomId &&
        weightsOverlap &&
        bandsOverlap(a.fromAmount, a.thruAmount, b.fromAmount, b.thruAmount) &&
        datesOverlap
    )
}
function checkOverlap(store, candidate, exceptId) {
    const clash = rows(RATE, {productStoreId: store.productStoreId}).find(
        row => row.shippingRateId !== exceptId && overlapping(candidate, row)
    )
    if (clash)
        denied(
            "RATE_OVERLAP",
            "It overlaps " + rateLabel(clash) + " at the same priority; give one of them another priority, band or dates"
        )
}
function rateLabel(row) {
    return (
        (row.description || geoText(row.geoId)) +
        " (" +
        [carrierText(row.carrierPartyId), methodText(row.carrierPartyId, row.shipmentMethodEnumId)].join(", ") +
        ", priority " +
        (row.priority ?? 0) +
        ")"
    )
}
// store#StoreShippingRate: a new rate from a date (now when empty, never in the past); a change of a rate in effect ends it and
// starts its successor from the date, one not started yet changes in place; end ends it (or withdraws one not started). A
// change or end of a rate in effect needs its reason. Bands are refused when not ordered, and rates of the same priority whose
// zone, method, bands and dates overlap are refused.
function storeStoreShippingRate(p) {
    const s = admin().scope("edit")
    const store = admin().storeOf(s, p.productStoreId)
    const now = nowMs()
    const row = p.shippingRateId ? one(RATE, {shippingRateId: p.shippingRateId}) : null
    if (p.shippingRateId && (!row || row.productStoreId !== store.productStoreId))
        denied("RECORD_UNAVAILABLE", "Rate " + p.shippingRateId + " is not available")
    if (row && ending(p)) {
        if (ms(row.fromDate) > now) {
            call("delete#" + RATE, {shippingRateId: row.shippingRateId})
            return {productStoreId: store.productStoreId, shippingRateId: row.shippingRateId, ended: true}
        }
        const at = startOf(p.thruDate, "end date")
        if ((ms(row.thruDate) ?? Infinity) <= at) denied("RECORD_UNAVAILABLE", "The rate has ended already")
        call("update#" + RATE, {shippingRateId: row.shippingRateId, thruDate: at, changeReason: reason(p, true)})
        return {productStoreId: store.productStoreId, shippingRateId: row.shippingRateId, ended: true}
    }
    if (row && (ms(row.thruDate) ?? Infinity) <= now) denied("RECORD_UNAVAILABLE", "An ended rate is not changed; add a new one")
    const values = rateValues(store, p, row)
    if (row && ms(row.fromDate) > now) {
        // not started yet: changed in place
        const fromDate = blank(p.fromDate) ? ms(row.fromDate) : startOf(p.fromDate, "start date")
        const thruDate = Object.hasOwn(p, "thruDate") ? admin().dateOf(p.thruDate, null, "end date") : ms(row.thruDate)
        if (thruDate != null && thruDate <= fromDate) denied("VALUE_INVALID", "The end comes after the start")
        const candidate = Object.assign({}, values, {fromDate, thruDate})
        checkOverlap(store, candidate, row.shippingRateId)
        call("update#" + RATE, Object.assign({shippingRateId: row.shippingRateId, changeReason: reason(p, false)}, candidate))
        return {productStoreId: store.productStoreId, shippingRateId: row.shippingRateId, ended: false}
    }
    const fromDate = startOf(p.fromDate, "start date")
    const thruDate = row && !Object.hasOwn(p, "thruDate") ? ms(row.thruDate) : admin().dateOf(p.thruDate, null, "end date")
    if (thruDate != null && thruDate <= fromDate) denied("VALUE_INVALID", "The end comes after the start")
    const candidate = Object.assign({}, values, {fromDate, thruDate})
    checkOverlap(store, candidate, row?.shippingRateId)
    const why = reason(p, !!row)
    if (row) call("update#" + RATE, {shippingRateId: row.shippingRateId, thruDate: fromDate, changeReason: why})
    const created = call(
        "create#" + RATE,
        Object.assign(
            {productStoreId: store.productStoreId, previousRateId: row?.shippingRateId || null, changeReason: why},
            candidate
        )
    )
    return {
        productStoreId: store.productStoreId,
        shippingRateId: created.shippingRateId,
        previousRateId: row?.shippingRateId,
        ended: false
    }
}
function rateRow(row) {
    const dates = admin().rowDates(row)
    const bands = []
    if (!blank(row.fromWeight) || !blank(row.thruWeight))
        bands.push((row.fromWeight ?? 0) + "–" + (row.thruWeight ?? "∞") + " " + uomText(row.weightUomId))
    if (!blank(row.fromAmount) || !blank(row.thruAmount))
        bands.push(
            (blank(row.fromAmount) ? moneyText(0, row.currencyUomId) : moneyText(row.fromAmount, row.currencyUomId)) +
                "–" +
                (blank(row.thruAmount) ? "∞" : moneyText(row.thruAmount, row.currencyUomId))
        )
    return Object.assign(
        {
            shippingRateId: row.shippingRateId,
            geoId: row.geoId,
            zoneText: geoText(row.geoId),
            carrierPartyId: row.carrierPartyId,
            shipmentMethodEnumId: row.shipmentMethodEnumId,
            methodText: carrierText(row.carrierPartyId) + ", " + methodText(row.carrierPartyId, row.shipmentMethodEnumId),
            fromWeight: row.fromWeight,
            thruWeight: row.thruWeight,
            weightUomId: row.weightUomId,
            fromAmount: row.fromAmount,
            thruAmount: row.thruAmount,
            bandText: bands.join(" · ") || "Any weight and value",
            shippingAmount: row.shippingAmount,
            amountText: moneyText(row.shippingAmount, row.currencyUomId),
            currencyUomId: row.currencyUomId,
            priority: row.priority,
            description: row.description || "",
            changeReason: row.changeReason || "",
            fromDate: ms(row.fromDate),
            thruDate: ms(row.thruDate),
            stateText: admin().stateOf(dates)
        },
        dates
    )
}
// The ship options a store offers (its own, else every method of each carrier it has a gateway for, as
// get#StoreShippingOptions answers).
function storeOptions(productStoreId) {
    const own = rows(SHIP_OPTION, {productStoreId}).sort((a, b) => (a.sequenceNum ?? 0) - (b.sequenceNum ?? 0))
    if (own.length) return own
    return rows(SHIP_GATEWAY, {productStoreId}).flatMap(gateway =>
        rows("mantle.shipment.carrier.CarrierShipmentMethod", {carrierPartyId: gateway.carrierPartyId}).sort(
            (a, b) => (a.sequenceNum ?? 0) - (b.sequenceNum ?? 0)
        )
    )
}
// The geos of a sample address as get#PostalAddressGeoIdSet reads them from an address: county, state or province, country and
// postal code.
function sampleGeoIds(p) {
    return [p.countyGeoId, p.stateProvinceGeoId, p.countryGeoId, p.postalCodeGeoId]
        .map(text)
        .filter(Boolean)
        .filter((id, index, all) => all.indexOf(id) === index)
}
// simulate#StoreShipping: what each of the store's options charges a sample cart (weight, value) going to a sample address,
// by the store's rates for a carrier on a local gateway (the rate chosen, or no delivery), Mantle's local default for a store
// with no rates, or the carrier's own gateway. Writes nothing.
function simulateStoreShipping(p) {
    const s = admin().scope()
    const store = admin().storeOf(s, p.productStoreId)
    // a sample address's geos only: an address id would read any party's address (P6 review)
    const geoIdSet = sampleGeoIds(p)
    if (!geoIdSet.length) denied("VALUE_INVALID", "Give the sample address's country")
    const amount = num(decimalOf(p.amount, "The cart value", false) ?? 0)
    const weight = num(decimalOf(p.weight, "The cart weight", false) ?? 0)
    const weightUomId = p.weightUomId || "WT_lb"
    const currencyUomId = p.currencyUomId || store.defaultCurrencyUomId
    const rated = liveRates(store.productStoreId).length > 0
    const gateways = Object.fromEntries(
        rows(SHIP_GATEWAY, {productStoreId: store.productStoreId}).map(row => [row.carrierPartyId, row])
    )
    let options = storeOptions(store.productStoreId)
    if (p.carrierPartyId) options = options.filter(row => row.carrierPartyId === p.carrierPartyId)
    if (p.shipmentMethodEnumId) options = options.filter(row => row.shipmentMethodEnumId === p.shipmentMethodEnumId)
    const quotes = options.map(option => {
        const label = carrierText(option.carrierPartyId) + ", " + methodText(option.carrierPartyId, option.shipmentMethodEnumId)
        const binding = gateways[option.carrierPartyId]
        const config = binding
            ? one("mantle.shipment.carrier.ShippingGatewayConfig", {shippingGatewayConfigId: binding.shippingGatewayConfigId})
            : null
        const base = {carrierPartyId: option.carrierPartyId, shipmentMethodEnumId: option.shipmentMethodEnumId, label}
        if (!config)
            return Object.assign(base, {available: false, amountText: "", ruleText: "No shipping gateway for this carrier"})
        if (!isLocalGateway(config))
            return Object.assign(base, {
                available: true,
                amountText: "",
                ruleText: "Rated by " + (config.description || config.shippingGatewayConfigId)
            })
        if (!rated)
            return Object.assign(base, {
                available: true,
                amountText: moneyText(0, currencyUomId),
                ruleText: "No local rates: Mantle's local gateway charges nothing"
            })
        const found = rate(store.productStoreId, {
            geoIdSet,
            carrierPartyId: option.carrierPartyId,
            shipmentMethodEnumId: option.shipmentMethodEnumId,
            currencyUomId,
            amount,
            weights: [{value: weight, uomId: weightUomId}]
        })
        return found.rate
            ? Object.assign(base, {
                  available: true,
                  shippingRateId: found.rate.shippingRateId,
                  shippingTotal: found.shippingTotal,
                  amountText: moneyText(found.shippingTotal, currencyUomId),
                  ruleText: rateLabel(found.rate)
              })
            : Object.assign(base, {available: false, amountText: "", ruleText: "No delivery: no local rate matches"})
    })
    return {productStoreId: store.productStoreId, rated, geoIds: geoIdSet, quotes}
}

// ===== payment gateways =====
// The organization's enabled, current gateway bindings (Z4), by gateway.
function enabledGateways(organizationPartyId) {
    return Object.fromEntries(
        rows("mantle.account.method.PaymentGatewayOrganization", {organizationPartyId})
            .filter(row => row.isEnabled !== "N" && active(row))
            .map(row => [row.paymentGatewayConfigId, row])
    )
}
function capabilitiesOf(config) {
    const of = config ? gatewayCapabilities[config.paymentGatewayTypeEnumId] : null
    const found = of ? of(config) : {}
    return Object.fromEntries(Object.keys(capabilityTexts).map(key => [key, !!found[key]]))
}
const capabilitiesText = capabilities =>
    Object.keys(capabilityTexts)
        .filter(key => capabilities[key])
        .map(key => capabilityTexts[key])
        .join(", ") || "Card payment only"
// store#StorePaymentGateway: the gateway that takes an instrument's payments for the store, only one of the organization's
// enabled, current gateways (GATEWAY_NOT_ENABLED otherwise); a changed gateway needs its reason (audit-logged), a removal
// records its own.
function storeStorePaymentGateway(p) {
    const s = admin().scope("edit")
    const store = admin().storeOf(s, p.productStoreId)
    if (one("moqui.basic.Enumeration", {enumId: p.paymentInstrumentEnumId || ""})?.enumTypeId !== "PaymentInstrument")
        denied("VALUE_INVALID", "Choose a payment instrument")
    const key = {productStoreId: store.productStoreId, paymentInstrumentEnumId: p.paymentInstrumentEnumId}
    const existing = one(PAY_GATEWAY, key)
    if (removing(p)) {
        if (!existing) denied("RECORD_UNAVAILABLE", "The store takes no " + enumText(p.paymentInstrumentEnumId))
        const why = reason(p, true)
        call("delete#" + PAY_GATEWAY, key)
        recordRemoval(
            PAY_GATEWAY,
            store.productStoreId,
            p.paymentInstrumentEnumId,
            "paymentGatewayConfigId",
            existing.paymentGatewayConfigId,
            why
        )
        return {productStoreId: store.productStoreId, removed: true}
    }
    if (!p.paymentGatewayConfigId || !enabledGateways(store.organizationPartyId)[p.paymentGatewayConfigId])
        denied("GATEWAY_NOT_ENABLED", "Choose one of the payment gateways enabled for the store's organization")
    if (!existing) {
        call("create#" + PAY_GATEWAY, Object.assign({}, key, {paymentGatewayConfigId: p.paymentGatewayConfigId}))
        return {productStoreId: store.productStoreId, removed: false}
    }
    if (existing.paymentGatewayConfigId === p.paymentGatewayConfigId)
        return {productStoreId: store.productStoreId, removed: false}
    const why = reason(p, true)
    ec.context.putAll({paymentGatewayConfigId_changeReason: why})
    call(
        "update#" + PAY_GATEWAY,
        Object.assign({}, key, {paymentGatewayConfigId: p.paymentGatewayConfigId, paymentGatewayConfigId_changeReason: why})
    )
    return {productStoreId: store.productStoreId, removed: false}
}

// ===== tax =====
// store#StoreTax: the store's tax gateway (store#Store's policy field, with its reason and revision) and its display and
// origin settings from a date.
function storeStoreTax(p) {
    const s = admin().scope("edit")
    const store = admin().storeOf(s, p.productStoreId)
    let gatewayChanged = false
    if (
        Object.hasOwn(p, "taxGatewayConfigId") &&
        p.taxGatewayConfigId !== undefined &&
        text(p.taxGatewayConfigId) !== text(store.taxGatewayConfigId)
    ) {
        const config = p.taxGatewayConfigId
            ? one("mantle.other.tax.TaxGatewayConfig", {taxGatewayConfigId: p.taxGatewayConfigId})
            : null
        if (p.taxGatewayConfigId && !config?.calculateServiceName)
            denied("GATEWAY_NOT_APPROVED", "Choose a tax gateway that calculates sales tax")
        admin().execute("storeStore", {
            productStoreId: store.productStoreId,
            taxGatewayConfigId: p.taxGatewayConfigId || null,
            changeReason: p.changeReason,
            expectedLastUpdatedStamp: p.expectedLastUpdatedStamp
        })
        gatewayChanged = true
    }
    const saved = storeSettings(store, taxSettings, p)
    return {productStoreId: store.productStoreId, changed: (gatewayChanged ? ["taxGatewayConfigId"] : []).concat(saved.changed)}
}
// preview#StoreTax: the tax the store's gateway charges a sample sale (an amount, quantity and shipping going to a destination
// geo), simulate#SalesTax's calculation for a user who reads the store. Writes nothing.
function previewStoreTax(p) {
    const s = admin().scope()
    const store = admin().storeOf(s, p.productStoreId)
    if (!p.destinationGeoId || !one("moqui.basic.Geo", {geoId: p.destinationGeoId}))
        denied("VALUE_INVALID", "Choose the sample destination")
    const out = ec.resource.script("component://mr-mantle/service/mantle/other/SalesTax.js").sample(store.organizationPartyId, {
        productStoreId: store.productStoreId,
        destinationGeoId: p.destinationGeoId,
        productId: p.productId || null,
        quantity: blank(p.quantity) ? 1 : p.quantity,
        amount: decimalOf(p.amount, "The sample amount", true),
        shippingAmount: decimalOf(p.shippingAmount, "The sample shipping", false),
        currencyUomId: store.defaultCurrencyUomId
    })
    const display = settingsOf(store, taxSettings, nowMs()).taxDisplay
    const total = Array.from(out.rows || []).reduce((sum, row) => sum + num(row.taxAmount ?? 0) * 1, 0)
    return Object.assign({}, out, {
        productStoreId: store.productStoreId,
        taxDisplay: display,
        taxTotalText: moneyText(total, out.currencyUomId),
        displayText:
            display === "inclusive"
                ? "Shown in prices: the sample's price includes " + moneyText(total, out.currencyUomId) + " of tax"
                : "Added at checkout: " + moneyText(total, out.currencyUomId) + " of tax on the sample"
    })
}

// ===== the settings read =====
function supportQueueText(organizationPartyId, requestCategoryId) {
    if (!requestCategoryId) return ""
    const category = one("mantle.request.RequestCategory", {requestCategoryId})
    return category?.description || requestCategoryId
}
// get#CheckoutSettings: the store's checkout policy (each field's value, whether it is the default, and a later change), its
// ship options, shipping gateways (the carrier account masked), local rates (in effect, later and ended), payment gateways
// with their state and capabilities, and tax; and whether the user may change them.
function getCheckoutSettings(p) {
    const s = admin().scope()
    const store = admin().storeOf(s, p.productStoreId)
    const now = nowMs()
    const policy = settingsOf(store, checkoutPolicy, now)
    for (const field of Object.keys(checkoutPolicy))
        policy[field + "Text"] =
            field === "supportQueueId"
                ? supportQueueText(store.organizationPartyId, policy[field]) || "None chosen"
                : field === "destinations"
                  ? policy[field]
                      ? policy[field].split(",").map(geoText).join(", ")
                      : "Anywhere the rates deliver"
                  : choiceTexts[policy[field]] || policy[field]
    const shipOptions = rows(SHIP_OPTION, {productStoreId: store.productStoreId})
        .sort((a, b) => (a.sequenceNum ?? 0) - (b.sequenceNum ?? 0))
        .map(row => ({
            carrierPartyId: row.carrierPartyId,
            shipmentMethodEnumId: row.shipmentMethodEnumId,
            carrierText: carrierText(row.carrierPartyId),
            methodText: methodText(row.carrierPartyId, row.shipmentMethodEnumId),
            sequenceNum: row.sequenceNum,
            markupPercent: row.markupPercent,
            markupAmount: row.markupAmount
        }))
    const shippingGateways = rows(SHIP_GATEWAY, {productStoreId: store.productStoreId}).map(row => {
        const config = one("mantle.shipment.carrier.ShippingGatewayConfig", {
            shippingGatewayConfigId: row.shippingGatewayConfigId
        })
        return {
            carrierPartyId: row.carrierPartyId,
            carrierText: carrierText(row.carrierPartyId),
            shippingGatewayConfigId: row.shippingGatewayConfigId,
            gatewayText: config?.description || row.shippingGatewayConfigId,
            local: isLocalGateway(config),
            billingType: row.billingType,
            // the carrier account is the store's, shown masked
            billingAccountText: row.billingAccount ? "••••" + String(row.billingAccount).slice(-4) : "",
            billingZip: row.billingZip,
            billingCountry: row.billingCountry,
            insurancePercent: row.insurancePercent
        }
    })
    const rates = rows(RATE, {productStoreId: store.productStoreId})
        .map(rateRow)
        .sort(
            (a, b) =>
                Number(a.ended) - Number(b.ended) ||
                a.zoneText.localeCompare(b.zoneText) ||
                num(a.priority ?? 0) - num(b.priority ?? 0) ||
                (b.fromDate ?? 0) - (a.fromDate ?? 0)
        )
    const enabled = enabledGateways(store.organizationPartyId)
    const paymentGateways = rows(PAY_GATEWAY, {productStoreId: store.productStoreId}).map(row => {
        const config = one("mantle.account.method.PaymentGatewayConfig", {paymentGatewayConfigId: row.paymentGatewayConfigId})
        const capabilities = capabilitiesOf(config)
        const allowed = !!enabled[row.paymentGatewayConfigId]
        return Object.assign(
            {
                paymentInstrumentEnumId: row.paymentInstrumentEnumId,
                instrumentText: enumText(row.paymentInstrumentEnumId),
                paymentGatewayConfigId: row.paymentGatewayConfigId,
                gatewayText: config?.description || row.paymentGatewayConfigId,
                enabled: allowed,
                stateText: allowed ? "Enabled for the organization" : "Not enabled for the organization",
                capabilitiesText: capabilitiesText(capabilities)
            },
            capabilities
        )
    })
    const taxGateway = store.taxGatewayConfigId
        ? one("mantle.other.tax.TaxGatewayConfig", {taxGatewayConfigId: store.taxGatewayConfigId})
        : null
    const taxValues = settingsOf(store, taxSettings, now)
    const origin = taxValues.taxOriginFacilityId
        ? one("mantle.facility.Facility", {facilityId: taxValues.taxOriginFacilityId})
        : null
    const tax = Object.assign(taxValues, {
        taxGatewayConfigId: store.taxGatewayConfigId,
        taxGatewayText: taxGateway?.description || store.taxGatewayConfigId || "None",
        taxDisplayText: choiceTexts[taxValues.taxDisplay] || taxValues.taxDisplay,
        taxOriginText: origin?.facilityName || taxValues.taxOriginFacilityId || "Not set",
        lastUpdatedStamp: ms(store.lastUpdatedStamp)
    })
    return {
        store: {
            productStoreId: store.productStoreId,
            storeName: store.storeName || store.productStoreId,
            organizationPartyId: store.organizationPartyId,
            defaultCurrencyUomId: store.defaultCurrencyUomId
        },
        policy,
        shipOptions,
        shippingGateways,
        rates,
        rated: liveRates(store.productStoreId, now).length > 0,
        paymentGateways,
        tax,
        canEdit: s.canEdit
    }
}

// ===== options =====
const termCondition = (fields, term) => {
    const factory = ec.entity.conditionFactory
    const like = "%" + String(term).replace(/[\\%_]/g, c => "\\" + c) + "%"
    return factory.makeCondition(
        fields.map(field => factory.makeCondition(field, "like", like).ignoreCase()),
        "or"
    )
}
const optionSources = {
    // every carrier method (CarrierShipmentMethod), as carrier:method
    shipMethods: () =>
        rows("mantle.shipment.carrier.CarrierShipmentMethod", {})
            .sort(
                (a, b) =>
                    String(a.carrierPartyId).localeCompare(String(b.carrierPartyId)) ||
                    (a.sequenceNum ?? 0) - (b.sequenceNum ?? 0)
            )
            .map(row => ({
                value: row.carrierPartyId + ":" + row.shipmentMethodEnumId,
                label: carrierText(row.carrierPartyId) + ", " + methodText(row.carrierPartyId, row.shipmentMethodEnumId)
            })),
    carriers: () =>
        Array.from(new Set(rows("mantle.shipment.carrier.CarrierShipmentMethod", {}).map(row => row.carrierPartyId))).map(id => ({
            value: id,
            label: carrierText(id)
        })),
    methods: () =>
        rows("moqui.basic.Enumeration", {enumTypeId: "ShipmentMethod"})
            .sort((a, b) => (a.sequenceNum ?? 0) - (b.sequenceNum ?? 0))
            .map(row => ({value: row.enumId, label: row.description || row.enumId})),
    // the gateways approved for a carrier
    shippingGateways: (store, term, p) =>
        rows("mantle.shipment.carrier.ShippingGatewayConfig", {})
            .filter(config => !p.carrierPartyId || gatewayApproved(config, p.carrierPartyId))
            .map(config => ({
                value: config.shippingGatewayConfigId,
                label: config.description || config.shippingGatewayConfigId
            })),
    paymentInstruments: () =>
        rows("moqui.basic.Enumeration", {enumTypeId: "PaymentInstrument"}).map(row => ({
            value: row.enumId,
            label: row.description || row.enumId
        })),
    // the organization's enabled, current gateways only (Z4)
    paymentGateways: store =>
        Object.keys(enabledGateways(store.organizationPartyId)).map(id => {
            const config = one("mantle.account.method.PaymentGatewayConfig", {paymentGatewayConfigId: id})
            return {value: id, label: (config?.description || id) + " · " + capabilitiesText(capabilitiesOf(config))}
        }),
    // countries and zones (geo groups), searched
    geos: (store, term) => {
        let query = find("moqui.basic.Geo").condition("geoTypeEnumId", "in", [
            "GEOT_COUNTRY",
            "GEOT_GROUP",
            "GEOT_STATE",
            "GEOT_PROVINCE"
        ])
        if (term) query = query.condition(termCondition(["geoId", "geoName"], term))
        return Array.from(query.orderBy("geoName").limit(choiceLimit).list()).map(row => ({
            value: row.geoId,
            label: (row.geoName || row.geoId) + (row.geoTypeEnumId === "GEOT_GROUP" ? " (zone)" : "")
        }))
    },
    supportQueues: store =>
        ec.resource
            .script("component://mr-mantle/service/mantle/request/SupportPortal.js")
            .offeredQueues(store.organizationPartyId)
            .map(queue => ({
                value: queue.requestCategoryId,
                label: queue.queue.category?.description || queue.category?.description || queue.requestCategoryId
            })),
    taxGateways: () =>
        rows("mantle.other.tax.TaxGatewayConfig", {})
            .filter(row => row.calculateServiceName)
            .map(row => ({value: row.taxGatewayConfigId, label: row.description || row.taxGatewayConfigId})),
    storeFacilities: store =>
        rows(S + "ProductStoreFacility", {productStoreId: store.productStoreId})
            .filter(row => active(row))
            .map(row => ({
                value: row.facilityId,
                label: one("mantle.facility.Facility", {facilityId: row.facilityId})?.facilityName || row.facilityId
            })),
    weightUoms: () =>
        rows("moqui.basic.Uom", {uomTypeEnumId: "UT_WEIGHT_MEASURE"}).map(row => ({
            value: row.uomId,
            label: row.description || row.uomId
        })),
    currencies: (store, term) => {
        let query = find("moqui.basic.Uom", {uomTypeEnumId: "UT_CURRENCY_MEASURE"})
        if (term) query = query.condition(termCondition(["uomId", "description"], term))
        return Array.from(query.orderBy("uomId").limit(choiceLimit).list()).map(row => ({
            value: row.uomId,
            label: row.uomId + " · " + (row.description || "")
        }))
    }
}
// find#CheckoutOptions: the options of a checkout form's drop-down, the values its save accepts.
function findCheckoutOptions(p) {
    const s = admin().scope()
    const store = admin().storeOf(s, p.productStoreId)
    if (!Object.hasOwn(optionSources, p.choice || "")) throw new Error("Unknown checkout option " + p.choice)
    const term = text(p.term)
    let options = optionSources[p.choice](store, term, p)
    if (term && !["geos", "currencies"].includes(p.choice))
        options = options.filter(option => (option.value + " " + option.label).toLowerCase().includes(term.toLowerCase()))
    if (p.selected && !options.some(option => option.value === p.selected)) {
        const match = optionSources[p.choice](store, String(p.selected), p).find(option => option.value === p.selected)
        if (match) options.push(match)
    }
    return {options: options.slice(0, 200)}
}

// ===== purchase readiness (StoreAdmin.js readinessChecks) =====
const shopSites = store =>
    (admin().shopMounts([store.productStoreId])[store.productStoreId] || []).filter(mount => mount.enabled === "Y")
// a page binding live now: in its window, bound to a mount, its wiki version the published one (SitePages.js' live rule)
function livePage(row, at) {
    if (!row.appMountId || !row.versionName || !active(row, at)) return false
    const wiki = row.wikiPageId ? one("moqui.resource.wiki.WikiPage", {wikiPageId: row.wikiPageId}) : null
    return !!wiki && wiki.publishedVersionName === row.versionName
}
const readiness = {
    payments(store) {
        const bound = rows(PAY_GATEWAY, {productStoreId: store.productStoreId})
        if (!bound.length) return {ready: false, message: "No payment gateway takes the store's payments"}
        const enabled = enabledGateways(store.organizationPartyId)
        const refused = bound.filter(row => !enabled[row.paymentGatewayConfigId])
        if (refused.length)
            return {
                ready: false,
                message:
                    "Not enabled for the organization: " +
                    refused
                        .map(row => enumText(row.paymentInstrumentEnumId) + " through " + row.paymentGatewayConfigId)
                        .join(", ")
            }
        return {
            ready: true,
            message: bound
                .map(row => {
                    const config = one("mantle.account.method.PaymentGatewayConfig", {
                        paymentGatewayConfigId: row.paymentGatewayConfigId
                    })
                    return (
                        enumText(row.paymentInstrumentEnumId) +
                        " through " +
                        (config?.description || row.paymentGatewayConfigId) +
                        " (" +
                        capabilitiesText(capabilitiesOf(config)) +
                        ")"
                    )
                })
                .join("; ")
        }
    },
    delivery(store) {
        const gateways = rows(SHIP_GATEWAY, {productStoreId: store.productStoreId})
        if (!gateways.length)
            return {ready: false, message: "No shipping gateway rates its deliveries; a store of digital items only needs none"}
        const carriers = new Set(gateways.map(row => row.carrierPartyId))
        const unrated = rows(SHIP_OPTION, {productStoreId: store.productStoreId}).filter(row => !carriers.has(row.carrierPartyId))
        return unrated.length
            ? {
                  ready: false,
                  message: "No gateway for " + Array.from(new Set(unrated.map(row => carrierText(row.carrierPartyId)))).join(", ")
              }
            : {ready: true, message: "Delivered by " + Array.from(carriers).map(carrierText).join(", ")}
    },
    localRates(store) {
        const local = rows(SHIP_GATEWAY, {productStoreId: store.productStoreId}).filter(row =>
            isLocalGateway(
                one("mantle.shipment.carrier.ShippingGatewayConfig", {shippingGatewayConfigId: row.shippingGatewayConfigId})
            )
        )
        if (!local.length) return null
        const current = rows(RATE, {productStoreId: store.productStoreId}).filter(row => active(row))
        return current.length
            ? {ready: true, message: current.length + (current.length === 1 ? " local rate" : " local rates") + " in effect"}
            : {ready: false, message: "Bound to the local gateway with no local rate: checkout would ship free; add rates"}
    },
    terms(store) {
        const sites = shopSites(store)
        if (!sites.length) return null
        const required = (settingAt(store.productStoreId, "PsstCheckoutTerms")?.settingValue ?? "true") !== "false"
        if (!required) return {ready: true, message: "Buyers are not asked to accept terms"}
        const at = nowMs()
        const missing = sites.filter(
            mount =>
                !rows("mantle.public.PublicSitePage", {siteId: mount.siteId, pageRole: "terms"}).some(row => livePage(row, at))
        )
        return missing.length
            ? {ready: false, message: "No published Terms page on " + missing.map(mount => mount.siteId).join(", ")}
            : {ready: true, message: "Every site has its published Terms page"}
    },
    supportQueue(store) {
        const queueId = settingAt(store.productStoreId, "PsstCheckoutSupportQueue")?.settingValue
        if (!queueId) return {ready: false, message: "No support queue is chosen for the store's customers"}
        const offered = ec.resource
            .script("component://mr-mantle/service/mantle/request/SupportPortal.js")
            .offeredQueues(store.organizationPartyId)
        return offered.some(queue => queue.requestCategoryId === queueId)
            ? {ready: true, message: "Customers' requests go to " + supportQueueText(store.organizationPartyId, queueId)}
            : {ready: false, message: "The support queue " + queueId + " is no longer one the organization offers"}
    },
    supportMount(store) {
        const sites = shopSites(store)
        if (!sites.length) return null
        const missing = sites.filter(
            mount =>
                !rows("mantle.public.PublicSiteApp", {siteId: mount.siteId, app: "support"}).some(
                    row => row.enabled === "Y" && row.targetId === store.organizationPartyId
                )
        )
        return missing.length
            ? {
                  ready: false,
                  message: "No Support mount for the store's organization on " + missing.map(mount => mount.siteId).join(", ")
              }
            : {ready: true, message: "Every site's Support pages serve the store's organization"}
    }
}

const operations = {
    getCheckoutSettings,
    storeCheckoutPolicy,
    storeShippingOption,
    storeStoreShippingGateway,
    storeStoreShippingRate,
    simulateStoreShipping,
    getStoreShippingRateLocal,
    storeStorePaymentGateway,
    storeStoreTax,
    previewStoreTax,
    findCheckoutOptions
}
;({
    // tables later phases extend
    checkoutPolicy,
    gatewayCapabilities,
    // the purchase readiness checks StoreAdmin.js lists, and the reads Shop's checkout uses
    readiness,
    rate,
    settingAt,
    execute: (op, parameters) => {
        if (!operations[op]) throw new Error("Unknown checkout operation " + op)
        return operations[op](parameters || {})
    }
})
