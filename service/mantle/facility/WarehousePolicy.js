// Warehouse-owned policy boundaries: the dated WarehousePolicy families (tracking, operation, reservation), their
// resolution with its trace, and the product facility levels. Artifact authorization being disabled never grants a
// planning capability. Tracking product exceptions take stock-planner or manager authority; every other policy write
// takes manager authority (STOCK_POLICY_MANAGE).
const E = "mantle.facility.",
    P = "mantle.product.",
    W = E + "WarehousePolicy"
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const {denied, access} = lib
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
const flags = ["lotRequired", "serialRequired", "expiryBlock", "inspectionRequired"],
    days = ["shelfLifeDays", "nearExpiryDays", "minimumRemainingShelfLifeDays"],
    trackingFields = [...flags, ...days, "serialPattern", "lotPattern"]
// The default locations of the operation policy, each with the location type it must be (design StockPolicies' steps).
const locationTypes = {
    receivingLocationSeqId: "FltReceiving",
    quarantineLocationSeqId: "FltQuarantine",
    stagingLocationSeqId: "FltStaging"
}
const operationFields = [
    "receiptSteps",
    "deliverySteps",
    ...Object.keys(locationTypes),
    "overReceiptPercent",
    "overShipmentPercent",
    "backorderEnumId",
    "blindCount",
    "autoPrint",
    "inventoryRequestCheck"
]
const reservationFields = ["reservationOrderEnumId", "reservationAutoEnumId"]
// Each family: its fields, its built-in defaults (Mantle's behavior with no row) and its label in messages.
const families = {
    tracking: {
        label: "tracking",
        fields: trackingFields,
        defaults: {
            lotRequired: "N",
            serialRequired: "N",
            expiryBlock: "N",
            inspectionRequired: "N",
            shelfLifeDays: null,
            nearExpiryDays: 0,
            minimumRemainingShelfLifeDays: 0,
            serialPattern: null,
            lotPattern: null
        }
    },
    operation: {
        label: "operation",
        fields: operationFields,
        defaults: {
            receiptSteps: 1,
            deliverySteps: 1,
            receivingLocationSeqId: null,
            quarantineLocationSeqId: null,
            stagingLocationSeqId: null,
            overReceiptPercent: 0,
            overShipmentPercent: 0,
            backorderEnumId: "WhBoBackorder",
            blindCount: "N",
            autoPrint: "N",
            inventoryRequestCheck: "N"
        }
    },
    reservation: {
        label: "reservation",
        fields: reservationFields,
        defaults: {reservationOrderEnumId: "AsResOrdFifoRec", reservationAutoEnumId: "AsResAutoPlaced"}
    }
}
const storeFields = {reservationOrderEnumId: "reservationOrderEnumId", reservationAutoEnumId: "reservationAutoEnumId"}
const current = (r, at) => (ms(r.fromDate) ?? -Infinity) <= at && (ms(r.thruDate) ?? Infinity) > at
const isClosed = location => location.thruDate != null && ms(location.thruDate) <= ms(ec.user.nowTimestamp)
const openLocation = () => {
    const cf = ec.entity.conditionFactory
    return cf.makeCondition(
        [cf.makeCondition("thruDate", "is-null", null), cf.makeCondition("thruDate", "greater", ec.user.nowTimestamp)],
        "or"
    )
}
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
    const store = p.productStoreId ? one(P + "store.ProductStore", {productStoreId: p.productStoreId}) : null
    if (p.productStoreId && !store) throw new Error("Store is not available")
    const facilityId = p.facilityId || (store && !p.organizationPartyId ? store.inventoryFacilityId : null)
    const facility = facilityId && facilityId !== "_NA_" ? one(E + "Facility", {facilityId}) : null
    if (facilityId && facilityId !== "_NA_" && !facility) throw new Error("Facility is not available")
    const organizationPartyId =
        p.organizationPartyId ||
        facility?.ownerPartyId ||
        store?.organizationPartyId ||
        s.activeOrganizationPartyId ||
        s.memberPartyIds[0]
    if (
        !organizationPartyId ||
        !one("mantle.party.PartyRole", {partyId: organizationPartyId, roleTypeId: "OrgInternal"}) ||
        !facilityScope.owns(s, organizationPartyId)
    )
        throw new Error("Warehouse organization is not available")
    if (facility && (facility.ownerPartyId !== organizationPartyId || !facilityScope.owns(s, facility.ownerPartyId)))
        throw new Error("Facility is not in the available warehouse organization")
    if (store && store.organizationPartyId !== organizationPartyId)
        throw new Error("Store is not in the available warehouse organization")
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
        productStoreId: store?.productStoreId || null,
        facility: map(facility),
        product: map(product),
        store: map(store),
        canPlan,
        canManage: s.systemAdmin || access.has("STOCK_POLICY_MANAGE"),
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
function effectiveAt(p) {
    const at = p.asOfDate == null || p.asOfDate === "" ? ms(ec.user.nowTimestamp) : ms(p.asOfDate)
    if (!Number.isFinite(at)) throw new Error("Choose a valid policy date")
    return at
}

// The scopes a family resolves through, most general first; later scopes win field by field.
function scopesOf(type, g) {
    const scopes = [
        {facilityId: "_NA_", productId: "_NA_", level: "organization"},
        {facilityId: g.facilityId, productId: "_NA_", level: "facility"}
    ]
    if (type === "tracking")
        scopes.push(
            {facilityId: "_NA_", productId: g.productId, level: "product"},
            {facilityId: g.facilityId, productId: g.productId, level: "facility product"}
        )
    return [...new Map(scopes.map(scope => [scope.facilityId + "|" + scope.productId, scope])).values()]
}
// The effective values of one family at a time, with the source of each value set by a row (or the store).
function layered(type, g, all, at) {
    const family = families[type],
        policy = Object.assign({}, family.defaults),
        sources = {}
    for (const scope of scopesOf(type, g)) {
        const row = all
            .filter(r => r.policyType === type && r.facilityId === scope.facilityId && r.productId === scope.productId)
            .filter(r => current(r, at))
            .sort((a, b) => ms(b.fromDate) - ms(a.fromDate))[0]
        if (!row) continue
        for (const field of family.fields) {
            if (row[field] == null) continue
            // an inherited expiry prohibition cannot be weakened by a narrower scope
            if (field === "expiryBlock" && policy.expiryBlock === "Y" && row[field] === "N") continue
            policy[field] = row[field]
            sources[field] = {
                policyType: type,
                field,
                value: row[field],
                level: scope.level,
                organizationPartyId: g.organizationPartyId,
                facilityId: row.facilityId,
                productId: row.productId,
                fromDate: row.fromDate,
                thruDate: row.thruDate,
                changeReason: row.changeReason
            }
        }
    }
    // a store's own reservation setting wins for that store's orders only
    if (type === "reservation" && g.productStoreId)
        for (const [field, storeField] of Object.entries(storeFields)) {
            if (g.store[storeField] == null || g.store[storeField] === "") continue
            policy[field] = g.store[storeField]
            sources[field] = {
                policyType: type,
                field,
                value: g.store[storeField],
                level: "store",
                organizationPartyId: g.organizationPartyId,
                facilityId: g.facilityId,
                productId: "_NA_",
                productStoreId: g.productStoreId
            }
        }
    // a facility's default location, unset by policy, is its first location of the type the steps use
    if (type === "operation" && g.facilityId !== "_NA_")
        for (const [field, locationTypeEnumId] of Object.entries(locationTypes)) {
            if (policy[field] != null) continue
            // a closed location (FacilityLocation.thruDate passed) is no default
            const first = find(E + "FacilityLocation", {facilityId: g.facilityId, locationTypeEnumId})
                .condition(openLocation())
                .orderBy("locationSeqId")
                .limit(1)
                .list()
            if (!first.size()) continue
            policy[field] = first.get(0).locationSeqId
            sources[field] = {policyType: type, field, value: policy[field], level: "location type", facilityId: g.facilityId}
        }
    return {policy, sources}
}
// What the effective operation policy needs and the facility lacks.
function warningsOf(operationPolicy, g) {
    if (g.facilityId === "_NA_") return []
    const warnings = []
    // a policy row may still name a location closed since (the close refuses one named by a current row)
    for (const field of Object.keys(locationTypes)) {
        if (!operationPolicy[field]) continue
        const location = one(E + "FacilityLocation", {facilityId: g.facilityId, locationSeqId: operationPolicy[field]})
        if (location && isClosed(location)) warnings.push({code: "LOCATION_CLOSED", field, locationSeqId: location.locationSeqId})
    }
    if (Number(operationPolicy.receiptSteps) === 2 && !operationPolicy.receivingLocationSeqId)
        warnings.push({code: "NO_RECEIVING_LOCATION", field: "receivingLocationSeqId"})
    if (Number(operationPolicy.receiptSteps) === 3 && !operationPolicy.quarantineLocationSeqId)
        warnings.push({code: "NO_QUARANTINE_LOCATION", field: "quarantineLocationSeqId"})
    if (Number(operationPolicy.deliverySteps) === 2 && !operationPolicy.stagingLocationSeqId)
        warnings.push({code: "NO_STAGING_LOCATION", field: "stagingLocationSeqId"})
    return warnings
}
function resolve(p) {
    const g = guard(p),
        at = effectiveAt(p),
        type = families[p.policyType] ? p.policyType : "tracking"
    const all = rows(W, {organizationPartyId: g.organizationPartyId}),
        tracking = layered("tracking", g, all, at),
        operation = layered("operation", g, all, at),
        reservation = layered("reservation", g, all, at)
    const exact = all
            .filter(r => r.policyType === type && r.facilityId === g.facilityId)
            .filter(r => r.productId === (type === "tracking" ? g.productId : "_NA_"))
            .sort((a, b) => ms(b.fromDate) - ms(a.fromDate)),
        configuredPolicy = exact.find(r => current(r, at))
    const trace = []
    for (const [type, resolved] of Object.entries({tracking, operation, reservation}))
        for (const field of families[type].fields)
            trace.push(resolved.sources[field] || {policyType: type, field, value: resolved.policy[field], level: "default"})
    return {
        organizationPartyId: g.organizationPartyId,
        facilityId: g.facilityId,
        productId: g.productId,
        productStoreId: g.productStoreId,
        asOfDate: at,
        trackingPolicy: tracking.policy,
        operationPolicy: operation.policy,
        reservationPolicy: reservation.policy,
        configuredPolicy: configuredPolicy ? map(configuredPolicy) : {},
        sources: tracking.sources,
        sourceRows: trackingFields.map(
            field => tracking.sources[field] || {field, value: tracking.policy[field], source: "Built-in default"}
        ),
        trace,
        warnings: warningsOf(operation.policy, g),
        history: exact.map(map),
        canPlan: g.canPlan,
        canManage: g.canManage
    }
}

// The field checks of each family, on the values the new row will hold.
function checkIndicator(data, field) {
    if (data[field] != null && !["Y", "N"].includes(data[field])) throw new Error("Choose Inherit, Yes or No for " + field)
}
function checkEnum(data, field, enumTypeId) {
    if (data[field] && one("moqui.basic.Enumeration", {enumId: data[field]})?.enumTypeId !== enumTypeId)
        denied("POLICY_INVALID", "Choose a valid " + field)
}
const validators = {
    tracking(data) {
        for (const field of flags) checkIndicator(data, field)
        for (const field of days)
            if (data[field] != null && (!Number.isInteger(Number(data[field])) || Number(data[field]) < 0))
                throw new Error(field + " must be a nonnegative whole number")
        for (const field of ["serialPattern", "lotPattern"])
            if (data[field] != null && (String(data[field]).length > 255 || /[\r\n\x00]/.test(String(data[field]))))
                throw new Error("Use a single-line tracking pattern of at most 255 characters")
    },
    operation(data, g, prior) {
        for (const field of ["receiptSteps", "deliverySteps"])
            if (data[field] != null && ![1, 2, 3].includes(Number(String(data[field]))))
                denied("POLICY_INVALID", "Choose 1, 2 or 3 " + (field === "receiptSteps" ? "receipt" : "delivery") + " steps")
        for (const field of ["overReceiptPercent", "overShipmentPercent"]) {
            if (data[field] == null) continue
            const value = Number(String(data[field]))
            if (!Number.isFinite(value) || value < 0 || value > 100)
                denied("POLICY_INVALID", "A tolerance is a percentage from 0 to 100")
        }
        checkEnum(data, "backorderEnumId", "WarehouseBackorder")
        checkIndicator(data, "blindCount")
        checkIndicator(data, "autoPrint")
        checkIndicator(data, "inventoryRequestCheck")
        for (const [field, locationTypeEnumId] of Object.entries(locationTypes)) {
            if (data[field] == null) continue
            if (g.facilityId === "_NA_") denied("POLICY_INVALID", "Default locations are set for a facility")
            const location = one(E + "FacilityLocation", {facilityId: g.facilityId, locationSeqId: data[field]})
            if (!location) denied("POLICY_INVALID", "Location " + data[field] + " is not in the selected facility")
            if (location.locationTypeEnumId !== locationTypeEnumId)
                denied("POLICY_INVALID", "Location " + data[field] + " is not a " + locationTypeEnumId + " location")
            // a location newly named must be open (P2's check, which also refuses a closed facility); one carried
            // over from the row before is not re-checked, so an unrelated change is not refused
            if (data[field] !== prior[field])
                call(E + "FacilityServices.check#FacilityLocationOpen", {facilityId: g.facilityId, locationSeqId: data[field]})
        }
    },
    reservation(data) {
        checkEnum(data, "reservationOrderEnumId", "AssetReservationOrder")
        checkEnum(data, "reservationAutoEnumId", "AssetReservationAuto")
    }
}
// A dated change of one family at one scope: the row in effect at the new start ends there, and the new row, holding
// the earlier row's values with the changes, ends where a later row starts. History is never rewritten.
function storeDated(p, type) {
    const family = families[type],
        g = guard(p, true),
        why = reason(p),
        now = ms(ec.user.nowTimestamp)
    if (type === "tracking") {
        if (g.productId === "_NA_" && !g.scope.systemAdmin && !ec.user.hasPermission("STOCK_POLICY_MANAGE"))
            throw new Error("Warehouse manager authority is required for tracking defaults")
    } else {
        if (!g.canManage) denied("POLICY_MANAGE_REQUIRED", "Warehouse manager authority is required")
        if (g.productId !== "_NA_") denied("POLICY_INVALID", "This policy is set for an organization or a facility")
    }
    find("mantle.party.Party", {partyId: g.organizationPartyId}).forUpdate(true).one()
    const key = {organizationPartyId: g.organizationPartyId, facilityId: g.facilityId, productId: g.productId, policyType: type},
        all = rows(W, key).sort((a, b) => ms(a.fromDate) - ms(b.fromDate)),
        old = all.find(r => current(r, now)),
        label = family.label[0].toUpperCase() + family.label.substring(1)
    if (ms(p.expectedFromDate) !== ms(old?.fromDate)) throw new Error(label + " policy changed; reload before saving")
    const at = p.fromDate == null || p.fromDate === "" ? Math.max(now, (ms(old?.fromDate) || 0) + 1) : ms(p.fromDate)
    if (!Number.isFinite(at) || at < now) throw new Error(label + " changes must take effect now or later")
    if (all.some(r => ms(r.fromDate) === at)) throw new Error("A " + family.label + " policy already starts at this time")
    // the new row holds the values of the row in effect at its start (not now), with the changes
    const before = all.filter(r => ms(r.fromDate) < at && (r.thruDate == null || ms(r.thruDate) > at)).at(-1),
        after = all.find(r => ms(r.fromDate) > at),
        fromDate = iso(at)
    const data = Object.assign({}, before ? pick(map(before), family.fields) : {}, pick(p, family.fields))
    validators[type](data, g, before ? pick(map(before), family.fields) : {})
    audit(["fromDate", "thruDate", ...family.fields, "changeReason"], why)
    if (before) call("update#" + W, Object.assign({}, key, {fromDate: iso(before.fromDate), thruDate: fromDate}))
    call("create#" + W, Object.assign({}, key, data, {fromDate, thruDate: after ? iso(after.fromDate) : null, changeReason: why}))
    return resolve({
        organizationPartyId: g.organizationPartyId,
        facilityId: g.facilityId,
        productId: g.productId,
        policyType: type,
        asOfDate: fromDate
    })
}
const storeTracking = p => storeDated(p, "tracking"),
    storeOperation = p => storeDated(p, "operation"),
    storeReservation = p => storeDated(p, "reservation")

// A store's own reservation settings (the override over the facility default) and its inventory facility: a
// field-scoped change of ProductStore, with manager authority in the store's organization; the facility must be the
// organization's. Each changed field is audit-logged with the reason.
const storeReservationFields = ["inventoryFacilityId", "reservationOrderEnumId", "reservationAutoEnumId", "requireInventory"]
function storeStoreReservation(p) {
    if (!p.productStoreId) denied("POLICY_INVALID", "Choose a store")
    const g = guard({productStoreId: p.productStoreId, organizationPartyId: p.organizationPartyId}, true),
        why = reason(p)
    if (!g.canManage) denied("POLICY_MANAGE_REQUIRED", "Warehouse manager authority is required")
    const store = find(P + "store.ProductStore", {productStoreId: g.productStoreId})
        .forUpdate(true)
        .one()
    if (p.expectedLastUpdatedStamp && ms(p.expectedLastUpdatedStamp) !== ms(store.lastUpdatedStamp))
        throw new Error("Store settings changed; reload before saving")
    const changes = pick(p, storeReservationFields)
    if (!Object.keys(changes).length) denied("POLICY_INVALID", "Choose a store setting to change")
    checkEnum(changes, "reservationOrderEnumId", "AssetReservationOrder")
    checkEnum(changes, "reservationAutoEnumId", "AssetReservationAuto")
    checkIndicator(changes, "requireInventory")
    if (changes.inventoryFacilityId) {
        const facility = one(E + "Facility", {facilityId: changes.inventoryFacilityId})
        if (!facility || facility.ownerPartyId !== g.organizationPartyId)
            denied("POLICY_INVALID", "The inventory facility must belong to the store's organization")
    }
    audit(Object.keys(changes), why)
    call("update#" + P + "store.ProductStore", Object.assign({productStoreId: g.productStoreId}, changes))
    return resolve({productStoreId: g.productStoreId, organizationPartyId: g.organizationPartyId, policyType: "reservation"})
}

// The reservations at a facility that check#FacilityReservations would repair, without changing anything: each named
// by its reason. The repair itself is a separate guarded action.
const previewLimit = 200
function reservationCheck(p) {
    const g = guard(p)
    if (g.facilityId === "_NA_") denied("POLICY_INVALID", "Choose a facility")
    let query = find("mantle.product.issuance.AssetAndReservation")
        .condition("facilityId", g.facilityId)
        .condition("quantity", "greater", 0)
    if (g.productId !== "_NA_") query = query.condition("productId", g.productId)
    const found = Array.from(
        query
            .orderBy("orderId,orderItemSeqId,assetReservationId")
            .limit(previewLimit + 1)
            .list()
    ).map(map)
    const reservations = found.slice(0, previewLimit),
        orderIds = [...new Set(reservations.map(r => r.orderId).filter(Boolean))]
    const items = orderIds.length ? Array.from(find("mantle.order.OrderItem").condition("orderId", "in", orderIds).list()) : [],
        parts = orderIds.length ? Array.from(find("mantle.order.OrderPart").condition("orderId", "in", orderIds).list()) : [],
        headers = orderIds.length ? Array.from(find("mantle.order.OrderHeader").condition("orderId", "in", orderIds).list()) : []
    const partOf = r => {
        const item = items.find(i => i.orderId === r.orderId && i.orderItemSeqId === r.orderItemSeqId)
        return item ? parts.find(part => part.orderId === item.orderId && part.orderPartSeqId === item.orderPartSeqId) : null
    }
    const poolCache = {}
    const poolsFor = (header, part) => {
        const key = [header?.productStoreId, part?.vendorPartyId, part?.customerPartyId].join("|")
        if (!poolCache[key])
            poolCache[key] = Array.from(
                call(P + "AssetServices.get#AssetPools", {
                    productStoreId: header?.productStoreId,
                    vendorPartyId: part?.vendorPartyId,
                    customerPartyId: part?.customerPartyId
                }).assetPoolIdSet || []
            )
        return poolCache[key]
    }
    const available = {}
    const availableFor = productId => {
        if (available[productId] == null)
            available[productId] = find(P + "asset.Asset")
                .condition({facilityId: g.facilityId, productId, statusId: "AstAvailable"})
                .condition("availableToPromiseTotal", "greater", 0)
                .count()
        return available[productId]
    }
    const findings = []
    for (const r of reservations) {
        const part = partOf(r),
            header = headers.find(h => h.orderId === r.orderId)
        let reasonCode = null
        if (r.statusId !== "AstAvailable") reasonCode = "ASSET_NOT_AVAILABLE"
        else if (part?.facilityId && part.facilityId !== g.facilityId) reasonCode = "OTHER_FACILITY"
        else if (r.assetPoolId && (!r.orderId || !poolsFor(header, part).includes(r.assetPoolId)))
            reasonCode = "POOL_NOT_QUALIFIED"
        else if (r.quantityNotAvailable != null && Number(String(r.quantityNotAvailable)) > 0 && availableFor(r.productId))
            reasonCode = "AVAILABLE_ELSEWHERE"
        if (!reasonCode) continue
        findings.push({
            reasonCode,
            assetReservationId: r.assetReservationId,
            assetId: r.assetId,
            productId: r.productId,
            orderId: r.orderId,
            orderItemSeqId: r.orderItemSeqId,
            quantity: r.quantity,
            quantityNotAvailable: r.quantityNotAvailable,
            statusId: r.statusId,
            assetPoolId: r.assetPoolId,
            orderFacilityId: part?.facilityId || null
        })
    }
    return {
        organizationPartyId: g.organizationPartyId,
        facilityId: g.facilityId,
        productId: g.productId,
        checkedCount: reservations.length,
        truncated: found.length > previewLimit,
        findings,
        // what a repair confirms it repairs (WarehouseTaskServices.repair#FacilityReservations): a change since is refused
        previewFingerprint: lib.hash(
            findings.map(f => [f.reasonCode, f.assetReservationId, f.assetId, String(f.quantity), String(f.quantityNotAvailable)])
        )
    }
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
// The product facility levels a store would write, checked as facilityStore checks them, without writing: the import of
// reorder rules (ReorderLevelServices.validate#ReorderRuleImportRow) previews a row through it.
function facilityPreview(p) {
    const checked = facilityValues(p, false)
    if (checked.removing) throw new Error("A preview does not remove a location policy")
    return {
        organizationPartyId: checked.g.organizationPartyId,
        productId: checked.g.productId,
        facilityId: checked.g.facilityId,
        locationSeqId: checked.location,
        before: checked.old ? pick(map(checked.old), checked.fields) : null,
        values: Object.assign({}, checked.data, {changeReason: checked.why})
    }
}
function facilityStore(p) {
    const checked = facilityValues(p, true)
    const {g, why, location, key, entity, fields, old, data} = checked
    // a product's location policy removed, so the location no longer names it (a location closes only when none does)
    if (checked.removing) {
        if (!old) throw new Error("This product has no policy at the location")
        // the fields cleared through the audited update first, so the old values and the reason reach the audit log
        audit([...fields, "changeReason"], why)
        call("update#" + entity, Object.assign({}, key, Object.fromEntries(fields.map(f => [f, null])), {changeReason: why}))
        call("delete#" + entity, key)
        return Object.assign(facilityRead(g), {locationSeqId: location})
    }
    audit([...fields, "changeReason"], why)
    call((old ? "update#" : "create#") + entity, Object.assign({}, key, data, {changeReason: why}))
    return Object.assign(facilityRead(g), {locationSeqId: location})
}
// The checks of a product facility store and the values it writes. The snooze of a reorder rule (impl-purchasing P14a,
// CX-FACILITY-POLICY) is a thru date and its reason: it stops automatic conversion of the rule's shortage, not the shortage.
function facilityValues(p, lock) {
    const g = guard(p, true),
        why = reason(p)
    if (g.facilityId === "_NA_" || g.productId === "_NA_") throw new Error("Choose a product and facility")
    if (lock)
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
            : [
                  "minimumStock",
                  "maximumStock",
                  "reorderQuantity",
                  "daysToShip",
                  "reorderMethodEnumId",
                  "abcClassEnumId",
                  "snoozeThruDate",
                  "snoozeReason"
              ],
        old = lock ? find(entity, key).forUpdate(true).one() : one(entity, key)
    if (p.expectedLastUpdatedStamp && ms(p.expectedLastUpdatedStamp) !== ms(old?.lastUpdatedStamp))
        throw new Error("Facility policy changed; reload before saving")
    const removing = !!location && (p.removeLocation === true || p.removeLocation === "true" || p.removeLocation === "Y")
    if (removing) return {g, why, location, key, entity, fields, old, removing}
    if (
        location &&
        [
            "maximumStock",
            "reorderQuantity",
            "daysToShip",
            "reorderMethodEnumId",
            "abcClassEnumId",
            "snoozeThruDate",
            "snoozeReason"
        ].some(k => p[k] != null)
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
    // a new snooze ends after now and says why; ending it clears its reason; one left as it was is kept, past or not
    if (!location) {
        const snoozeChanged =
            Object.keys(changes).includes("snoozeThruDate") &&
            data.snoozeThruDate != null &&
            ms(data.snoozeThruDate) !== ms(old?.snoozeThruDate)
        if (data.snoozeThruDate == null || data.snoozeThruDate === "") {
            data.snoozeThruDate = null
            data.snoozeReason = null
        } else if (snoozeChanged) {
            if (!Number.isFinite(ms(data.snoozeThruDate)) || ms(data.snoozeThruDate) <= ms(ec.user.nowTimestamp))
                denied("SNOOZE_INVALID", "A snooze ends after now")
            if (!String(data.snoozeReason || "").trim())
                denied("SNOOZE_REASON_REQUIRED", "Give the reason for snoozing the reorder rule")
            data.snoozeThruDate = new Date(ms(data.snoozeThruDate))
        } else if (!String(data.snoozeReason || "").trim())
            denied("SNOOZE_REASON_REQUIRED", "Give the reason for snoozing the reorder rule")
    }
    return {g, why, location, key, entity, fields, old, data, removing: false}
}
function execute(op, p) {
    const operations = {
        guard,
        resolve,
        storeTracking,
        storeOperation,
        storeReservation,
        storeStoreReservation,
        reservationCheck,
        facilityRead,
        facilityStore,
        facilityPreview
    }
    if (!operations[op]) throw new Error("Unknown warehouse policy operation " + op)
    return operations[op](p)
}
;({execute})
