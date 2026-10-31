// Warehouse-owned policy boundaries. Artifact authorization being disabled never grants a planning capability.
const E = "mantle.facility.",
    P = "mantle.product.",
    W = E + "WarehousePolicy"
const find = (n, p = {}) => ec.entity.find(n).condition(p).disableAuthz(),
    one = (n, p) => find(n, p).one(),
    rows = (n, p) => Array.from(find(n, p).list())
const call = (n, p = {}) => {
    const out = ec.service.sync().name(n).parameters(p).disableAuthz().call() || {}
    if (ec.message.hasError()) throw new Error(ec.message.getErrorsString())
    return out
}
const map = r => (r?.getMap ? r.getMap() : Object.assign({}, r || {})),
    ms = v => (v == null || v === "" ? null : Number.isFinite(Number(String(v))) ? Number(String(v)) : Date.parse(String(v))),
    iso = v => new Date(ms(v)).toISOString()
const flags = ["lotRequired", "serialRequired", "expiryBlock"],
    days = ["shelfLifeDays", "nearExpiryDays", "minimumRemainingShelfLifeDays"],
    trackingFields = [...flags, ...days, "serialPattern", "lotPattern"]
const current = (r, at) => (ms(r.fromDate) ?? -Infinity) <= at && (ms(r.thruDate) ?? Infinity) > at
const pick = (p, fields) =>
    Object.fromEntries(fields.filter(k => Object.keys(p).includes(k)).map(k => [k, p[k] === "" ? null : p[k]]))
// The organizations are FacilityScope.js's, as for every facility and stock guard.
const facilityScope = ec.resource.script("component://mr-mantle/service/mantle/facility/FacilityScope.js")
function guard(p, write = false) {
    const s = facilityScope.scope(),
        blocked = !s.systemAdmin && ec.user.hasPermission("PROJECT_CLIENT")
    if (!ec.user.userId || blocked) throw new Error("Warehouse policy is not available")
    const canPlan = s.systemAdmin || ec.user.hasPermission("STOCK_POLICY_PLAN") || ec.user.hasPermission("STOCK_POLICY_MANAGE")
    if (write && !canPlan) throw new Error("Warehouse stock-planner or manager authority is required")
    const facility = p.facilityId && p.facilityId !== "_NA_" ? one(E + "Facility", {facilityId: p.facilityId}) : null
    if (p.facilityId && p.facilityId !== "_NA_" && !facility) throw new Error("Facility is not available")
    const organizationPartyId =
        p.organizationPartyId || facility?.ownerPartyId || s.activeOrganizationPartyId || s.memberPartyIds[0]
    if (
        !organizationPartyId ||
        !one("mantle.party.PartyRole", {partyId: organizationPartyId, roleTypeId: "OrgInternal"}) ||
        !facilityScope.owns(s, organizationPartyId)
    )
        throw new Error("Warehouse organization is not available")
    if (facility && (facility.ownerPartyId !== organizationPartyId || !facilityScope.owns(s, facility.ownerPartyId)))
        throw new Error("Facility is not in the available warehouse organization")
    const product = p.productId && p.productId !== "_NA_" ? one(P + "Product", {productId: p.productId}) : null
    if (
        p.productId &&
        p.productId !== "_NA_" &&
        (!product || (product.ownerPartyId !== "_NA_" && !facilityScope.owns(s, product.ownerPartyId)))
    )
        throw new Error("Product is not available")
    if (write && product && !["PtAsset", "PtDigitalAsset", "PtAssetUse", "PtPickAssembly"].includes(product.productTypeEnumId))
        throw new Error("This product does not carry stock")
    return {
        organizationPartyId,
        facilityId: facility?.facilityId || "_NA_",
        productId: product?.productId || "_NA_",
        facility: map(facility),
        product: map(product),
        canPlan,
        scope: s
    }
}
function reason(p) {
    if (!String(p.changeReason || "").trim()) throw new Error("Give a reason for the policy change")
    return String(p.changeReason).trim()
}
function audit(fields, why) {
    ec.context.putAll(Object.fromEntries(fields.map(k => [k + "_changeReason", why])))
}
function resolve(p) {
    const g = guard(p),
        at = p.asOfDate == null ? ms(ec.user.nowTimestamp) : ms(p.asOfDate)
    if (!Number.isFinite(at)) throw new Error("Choose a valid policy date")
    const all = rows(W, {organizationPartyId: g.organizationPartyId, policyType: "tracking"}),
        scopes = [
            ["_NA_", "_NA_"],
            [g.facilityId, "_NA_"],
            ["_NA_", g.productId],
            [g.facilityId, g.productId]
        ],
        unique = [
            ...new Map(scopes.map(([facilityId, productId]) => [facilityId + "|" + productId, {facilityId, productId}])).values()
        ]
    const trackingPolicy = {
            lotRequired: "N",
            serialRequired: "N",
            expiryBlock: "N",
            shelfLifeDays: null,
            nearExpiryDays: 0,
            minimumRemainingShelfLifeDays: 0,
            serialPattern: null,
            lotPattern: null
        },
        sources = {}
    for (const scope of unique) {
        const row = all
            .filter(r => r.facilityId === scope.facilityId && r.productId === scope.productId && current(r, at))
            .sort((a, b) => ms(b.fromDate) - ms(a.fromDate))[0]
        if (!row) continue
        for (const field of trackingFields) {
            if (row[field] == null) continue
            if (field === "expiryBlock" && trackingPolicy.expiryBlock === "Y" && row[field] === "N") continue
            trackingPolicy[field] = row[field]
            sources[field] = {
                field,
                value: row[field],
                organizationPartyId: g.organizationPartyId,
                facilityId: row.facilityId,
                productId: row.productId,
                fromDate: row.fromDate,
                thruDate: row.thruDate,
                changeReason: row.changeReason
            }
        }
    }
    const exact = all
            .filter(r => r.facilityId === g.facilityId && r.productId === g.productId)
            .sort((a, b) => ms(b.fromDate) - ms(a.fromDate)),
        configuredPolicy = exact.find(r => current(r, at))
    return {
        organizationPartyId: g.organizationPartyId,
        facilityId: g.facilityId,
        productId: g.productId,
        asOfDate: at,
        trackingPolicy,
        configuredPolicy: configuredPolicy ? map(configuredPolicy) : {},
        sources,
        sourceRows: trackingFields.map(
            field => sources[field] || {field, value: trackingPolicy[field], source: "Built-in default"}
        ),
        history: exact.map(map),
        canPlan: g.canPlan
    }
}
function storeTracking(p) {
    const g = guard(p, true),
        why = reason(p),
        now = ms(ec.user.nowTimestamp)
    if (g.productId === "_NA_" && !g.scope.systemAdmin && !ec.user.hasPermission("STOCK_POLICY_MANAGE"))
        throw new Error("Warehouse manager authority is required for tracking defaults")
    find("mantle.party.Party", {partyId: g.organizationPartyId}).forUpdate(true).one()
    const key = {
            organizationPartyId: g.organizationPartyId,
            facilityId: g.facilityId,
            productId: g.productId,
            policyType: "tracking"
        },
        all = rows(W, key).sort((a, b) => ms(a.fromDate) - ms(b.fromDate)),
        old = all.find(r => current(r, now))
    if (ms(p.expectedFromDate) !== ms(old?.fromDate)) throw new Error("Tracking policy changed; reload before saving")
    const at = p.fromDate == null ? Math.max(now, (ms(old?.fromDate) || 0) + 1) : ms(p.fromDate)
    if (!Number.isFinite(at) || at < now) throw new Error("Tracking changes must take effect now or later")
    if (all.some(r => ms(r.fromDate) === at)) throw new Error("A tracking policy already starts at this time")
    const data = Object.assign({}, old ? pick(map(old), trackingFields) : {}, pick(p, trackingFields))
    for (const field of flags)
        if (data[field] != null && !["Y", "N"].includes(data[field])) throw new Error("Choose Inherit, Yes or No for " + field)
    for (const field of days)
        if (data[field] != null && (!Number.isInteger(Number(data[field])) || Number(data[field]) < 0))
            throw new Error(field + " must be a nonnegative whole number")
    for (const field of ["serialPattern", "lotPattern"])
        if (data[field] != null && (String(data[field]).length > 255 || /[\r\n\x00]/.test(String(data[field]))))
            throw new Error("Use a single-line tracking pattern of at most 255 characters")
    const before = all.filter(r => ms(r.fromDate) < at && (r.thruDate == null || ms(r.thruDate) > at)).at(-1),
        after = all.find(r => ms(r.fromDate) > at),
        fromDate = iso(at)
    audit(["fromDate", "thruDate", ...trackingFields, "changeReason"], why)
    if (before) call("update#" + W, Object.assign({}, key, {fromDate: iso(before.fromDate), thruDate: fromDate}))
    call("create#" + W, Object.assign({}, key, data, {fromDate, thruDate: after ? iso(after.fromDate) : null, changeReason: why}))
    return resolve(Object.assign({}, g, {asOfDate: fromDate}))
}
function facilityRead(p) {
    const g = guard(p)
    if (g.facilityId === "_NA_" || g.productId === "_NA_") throw new Error("Choose a product and facility")
    return {
        organizationPartyId: g.organizationPartyId,
        productId: g.productId,
        facilityId: g.facilityId,
        facilityPolicy: map(one(E + "ProductFacility", {productId: g.productId, facilityId: g.facilityId})),
        locationPolicies: rows(E + "ProductFacilityLocation", {productId: g.productId, facilityId: g.facilityId}).map(map),
        canPlan: g.canPlan
    }
}
function facilityStore(p) {
    const g = guard(p, true),
        why = reason(p)
    if (g.facilityId === "_NA_" || g.productId === "_NA_") throw new Error("Choose a product and facility")
    find(E + "Facility", {facilityId: g.facilityId})
        .forUpdate(true)
        .one()
    const location = p.locationSeqId || null,
        key = {productId: g.productId, facilityId: g.facilityId},
        entity = E + (location ? "ProductFacilityLocation" : "ProductFacility")
    if (location) {
        key.locationSeqId = location
        const facilityLocation = one(E + "FacilityLocation", {facilityId: g.facilityId, locationSeqId: location})
        if (!facilityLocation) throw new Error("Location is not in the selected facility")
        // a closed location takes no new policy; its policy may still be removed
        const removing = p.removeLocation === true || p.removeLocation === "true" || p.removeLocation === "Y"
        if (!removing && facilityLocation.thruDate != null && ms(facilityLocation.thruDate) <= ms(ec.user.nowTimestamp))
            throw new Error("Location " + location + " is closed")
    }
    const fields = location
            ? ["minimumStock", "moveQuantity"]
            : ["minimumStock", "maximumStock", "reorderQuantity", "daysToShip", "reorderMethodEnumId", "abcClassEnumId"],
        old = find(entity, key).forUpdate(true).one()
    if (p.expectedLastUpdatedStamp && ms(p.expectedLastUpdatedStamp) !== ms(old?.lastUpdatedStamp))
        throw new Error("Facility policy changed; reload before saving")
    // a product's location policy removed, so the location no longer names it (a location closes only when none does)
    if (location && (p.removeLocation === true || p.removeLocation === "true" || p.removeLocation === "Y")) {
        if (!old) throw new Error("This product has no policy at the location")
        // the fields cleared through the audited update first, so the old values and the reason reach the audit log
        audit([...fields, "changeReason"], why)
        call("update#" + entity, Object.assign({}, key, Object.fromEntries(fields.map(f => [f, null])), {changeReason: why}))
        call("delete#" + entity, key)
        return Object.assign(facilityRead(g), {locationSeqId: location})
    }
    if (
        location &&
        ["maximumStock", "reorderQuantity", "daysToShip", "reorderMethodEnumId", "abcClassEnumId"].some(k => p[k] != null)
    )
        throw new Error("Edit facility levels separately from location levels")
    const changes = pick(p, fields)
    if (!Object.keys(changes).length) throw new Error("Choose a policy field to change")
    const data = Object.assign({}, old ? pick(map(old), fields) : {}, changes)
    for (const field of ["minimumStock", "maximumStock", "reorderQuantity", "moveQuantity"])
        if (data[field] != null && toDecimal(data[field]).compare(0) < 0) throw new Error(field + " cannot be negative")
    if (data.daysToShip != null && (!Number.isInteger(Number(data.daysToShip)) || Number(data.daysToShip) < 0))
        throw new Error("Days to ship must be a nonnegative whole number")
    if (data.maximumStock != null && data.minimumStock != null && toDecimal(data.maximumStock).compare(data.minimumStock) < 0)
        throw new Error("Maximum stock must be at least minimum stock")
    for (const [field, type] of [
        ["reorderMethodEnumId", "ReorderMethod"],
        ["abcClassEnumId", "AbcClass"]
    ])
        if (data[field] && one("moqui.basic.Enumeration", {enumId: data[field]})?.enumTypeId !== type)
            throw new Error("Choose a valid " + field)
    if (data.reorderMethodEnumId === "RdmUpToMaximum" && data.maximumStock == null)
        throw new Error("Up-to-maximum replenishment requires maximum stock")
    audit([...fields, "changeReason"], why)
    call((old ? "update#" : "create#") + entity, Object.assign({}, key, data, {changeReason: why}))
    return Object.assign(facilityRead(g), {locationSeqId: location})
}
function execute(op, p) {
    return {guard, resolve, storeTracking, facilityRead, facilityStore}[op](p)
}
;({execute})
