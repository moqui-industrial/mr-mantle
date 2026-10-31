// Asset pools (WH-POLICY, design-warehouse AssetPools): stock set aside for the parties and stores that may consume
// it. A pool is owned by an internal organization; reading takes membership of it, and every change takes
// STOCK_POLICY_MANAGE there. Members qualify between their dates (get#AssetPools); ending one never touches a
// reservation already made, and the preview names the open reservations a change leaves unqualified.
const P = "mantle.product.",
    A = P + "asset."
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const {find, one, rows, map, ms, denied, access} = lib
const policy = ec.resource.script("component://mr-mantle/service/mantle/facility/WarehousePolicy.js")
const call = (name, parameters = {}) => {
    const out = ec.service.sync().name(name).parameters(parameters).disableAuthz().call() || {}
    if (ec.message.hasError()) throw new Error(ec.message.getErrorsString())
    return out
}
const listLimit = 100,
    previewLimit = 200
const roles = ["Vendor", "Customer"]
const blank = value => value == null || value === ""
const current = (row, at) => (ms(row.fromDate) ?? -Infinity) <= at && (ms(row.thruDate) ?? Infinity) > at

// The organizations whose pools the user reads; null for every one (a system administrator).
function owners() {
    const scope = call(P + "ProductServices.get#CatalogOwnerScope")
    if (!ec.user.userId || (!scope.systemAdmin && ec.user.hasPermission("PROJECT_CLIENT")))
        denied("POOL_UNAVAILABLE", "Asset pools are not available")
    return scope.systemAdmin ? null : Array.from(scope.ownerPartyIds).filter(id => id !== "_NA_")
}
// A pool the user may read (manage: and change), refused alike when missing or another organization's.
function pool(assetPoolId, manage = false) {
    const found = assetPoolId ? one(A + "AssetPool", {assetPoolId}) : null,
        ownerIds = owners()
    if (!found || (ownerIds && !ownerIds.includes(found.ownerPartyId)))
        denied("POOL_UNAVAILABLE", "Asset pool " + (assetPoolId || "") + " is not available")
    if (manage) requireManage()
    return found
}
function requireManage() {
    if (!access.has("STOCK_POLICY_MANAGE")) denied("POLICY_MANAGE_REQUIRED", "Warehouse manager authority is required")
}
function reason(p) {
    if (!String(p.changeReason || "").trim()) denied("POLICY_INVALID", "Give a reason for the change")
    return String(p.changeReason).trim()
}
function audit(fields, why) {
    ec.context.putAll(Object.fromEntries(fields.map(field => [field + "_changeReason", why])))
}

function findPools(p) {
    const ownerIds = owners()
    let query = find(A + "AssetPool")
    if (ownerIds) query = query.condition("ownerPartyId", "in", ownerIds.length ? ownerIds : ["_NONE_"])
    if (p.ownerPartyId) query = query.condition("ownerPartyId", p.ownerPartyId)
    const term = String(p.term || "").trim()
    if (term) {
        const cf = ec.entity.conditionFactory,
            like = "%" + term.replace(/[\\%_]/g, c => "\\" + c) + "%"
        query = query.condition(
            cf.makeCondition(
                ["assetPoolId", "pseudoId", "description"].map(field => cf.makeCondition(field, "like", like).ignoreCase()),
                "or"
            )
        )
    }
    const pools = Array.from(
        query
            .orderBy("pseudoId")
            .limit(listLimit + 1)
            .list()
    ).map(map)
    const shown = pools.slice(0, listLimit),
        poolIds = shown.map(row => row.assetPoolId),
        now = ms(ec.user.nowTimestamp)
    const members = entity => (poolIds.length ? Array.from(find(entity).condition("assetPoolId", "in", poolIds).list()) : [])
    const parties = members(A + "AssetPoolParty"),
        stores = members(A + "AssetPoolStore")
    return {
        poolList: shown.map(row =>
            Object.assign(row, {
                partyCount: parties.filter(r => r.assetPoolId === row.assetPoolId && current(r, now)).length,
                storeCount: stores.filter(r => r.assetPoolId === row.assetPoolId && current(r, now)).length
            })
        ),
        truncated: pools.length > listLimit,
        canManage: access.has("STOCK_POLICY_MANAGE")
    }
}
function getPool(p) {
    const found = pool(p.assetPoolId),
        now = ms(ec.user.nowTimestamp)
    const withState = row =>
        Object.assign(map(row), {current: current(row, now), ended: ms(row.thruDate) != null && ms(row.thruDate) <= now})
    return {
        pool: map(found),
        parties: rows(A + "AssetPoolParty", {assetPoolId: found.assetPoolId}).map(withState),
        stores: rows(A + "AssetPoolStore", {assetPoolId: found.assetPoolId}).map(withState),
        canManage: access.has("STOCK_POLICY_MANAGE")
    }
}
function storePool(p) {
    const why = reason(p)
    requireManage()
    const pseudoId = String(p.pseudoId || "").trim()
    if (p.assetPoolId) {
        const found = pool(p.assetPoolId, true)
        if (p.ownerPartyId && p.ownerPartyId !== found.ownerPartyId)
            denied("POLICY_INVALID", "A pool keeps the organization it was created for")
        const changes = {}
        if (pseudoId && pseudoId !== found.pseudoId) changes.pseudoId = pseudoId
        if (p.description != null && p.description !== found.description) changes.description = p.description || null
        if (changes.pseudoId && one(A + "AssetPool", {pseudoId, ownerPartyId: found.ownerPartyId}))
            denied("POLICY_INVALID", "Pool " + pseudoId + " already exists")
        if (Object.keys(changes).length) {
            audit(Object.keys(changes), why)
            call("update#" + A + "AssetPool", Object.assign({assetPoolId: found.assetPoolId}, changes))
        }
        return getPool({assetPoolId: found.assetPoolId})
    }
    if (!p.ownerPartyId) denied("POLICY_INVALID", "Choose the organization that owns the pool")
    // the owner must be an internal organization of the user's
    policy.execute("guard", {organizationPartyId: p.ownerPartyId, facilityId: "_NA_"})
    if (!pseudoId) denied("POLICY_INVALID", "Give the pool an ID")
    if (one(A + "AssetPool", {pseudoId, ownerPartyId: p.ownerPartyId}))
        denied("POLICY_INVALID", "Pool " + pseudoId + " already exists")
    const created = call("create#" + A + "AssetPool", {
        pseudoId,
        ownerPartyId: p.ownerPartyId,
        description: p.description || null
    })
    return getPool({assetPoolId: created.assetPoolId})
}
// A member's dates: a membership in effect keeps its start; a new one, a future one or one that has ended starts now or
// later; an end is now or later and after the start. No change reaches back before now, so no reservation already made
// is rewritten.
function memberDates(p, old) {
    const now = ms(ec.user.nowTimestamp),
        inEffect = old && (blank(old.fromDate) || ms(old.fromDate) <= now) && (blank(old.thruDate) || ms(old.thruDate) > now)
    let fromDate
    if (inEffect) {
        fromDate = blank(old.fromDate) ? null : ms(old.fromDate)
    } else {
        fromDate = blank(p.fromDate) ? now : ms(p.fromDate)
        if (!Number.isFinite(fromDate)) denied("POLICY_INVALID", "Choose a valid start date")
        if (fromDate < now) denied("POLICY_INVALID", "A membership starts now or later")
    }
    const flag = value => value === true || value === "true" || value === "Y"
    // an empty end keeps a membership's scheduled end; clearThruDate opens it again
    const keptEnd = old && !blank(old.thruDate) && ms(old.thruDate) > now && !flag(p.clearThruDate) ? ms(old.thruDate) : null
    const thruDate = flag(p.endNow) ? now : blank(p.thruDate) ? keptEnd : ms(p.thruDate)
    if (thruDate != null && !Number.isFinite(thruDate)) denied("POLICY_INVALID", "Choose a valid end date")
    if (thruDate != null && thruDate < now) denied("POLICY_INVALID", "A membership ends now or later")
    if (thruDate != null && fromDate != null && thruDate < fromDate) denied("POLICY_INVALID", "A membership ends after it starts")
    return {
        fromDate: fromDate == null ? null : new Date(fromDate).toISOString(),
        thruDate: thruDate == null ? null : new Date(thruDate).toISOString()
    }
}
function storeMember(p, kind) {
    const why = reason(p),
        found = pool(p.assetPoolId, true)
    const entity = A + (kind === "party" ? "AssetPoolParty" : "AssetPoolStore"),
        key = {assetPoolId: found.assetPoolId}
    const values = {}
    if (kind === "party") {
        if (!p.partyId || !one("mantle.party.Party", {partyId: p.partyId})) denied("POLICY_INVALID", "Choose a party")
        if (!blank(p.roleTypeId) && !roles.includes(p.roleTypeId))
            denied("POLICY_INVALID", "A pool party is a vendor, a customer or either")
        key.partyId = p.partyId
        values.roleTypeId = blank(p.roleTypeId) ? null : p.roleTypeId
    } else {
        const store = p.productStoreId ? one(P + "store.ProductStore", {productStoreId: p.productStoreId}) : null,
            ownerIds = owners()
        if (!store || (ownerIds && !ownerIds.includes(store.organizationPartyId)))
            denied("POLICY_INVALID", "Store " + (p.productStoreId || "") + " is not available")
        if (store.organizationPartyId !== found.ownerPartyId)
            denied("POLICY_INVALID", "Store " + store.productStoreId + " belongs to another organization than the pool")
        key.productStoreId = store.productStoreId
    }
    const old = find(entity, key).forUpdate(true).one()
    Object.assign(values, memberDates(p, old))
    audit(Object.keys(values), why)
    call((old ? "update#" : "create#") + entity, Object.assign({}, key, values))
    return getPool({assetPoolId: found.assetPoolId})
}
const storeParty = p => storeMember(p, "party"),
    storeStore = p => storeMember(p, "store")

// The open reservations on the pool's stock, each with whether its order still qualifies for the pool now (by store,
// vendor or customer, as get#AssetPools decides). Reads only; re-reserving is a separate guarded action.
function previewReservations(p) {
    const found = pool(p.assetPoolId)
    const reservations = Array.from(
        find("mantle.product.issuance.AssetAndReservation")
            .condition("assetPoolId", found.assetPoolId)
            .condition("quantity", "greater", 0)
            .orderBy("orderId,orderItemSeqId,assetReservationId")
            .limit(previewLimit + 1)
            .list()
    ).map(map)
    const shown = reservations.slice(0, previewLimit),
        orderIds = [...new Set(shown.map(row => row.orderId).filter(Boolean))]
    const items = orderIds.length ? Array.from(find("mantle.order.OrderItem").condition("orderId", "in", orderIds).list()) : []
    const parts = orderIds.length ? Array.from(find("mantle.order.OrderPart").condition("orderId", "in", orderIds).list()) : []
    const headers = orderIds.length
        ? Array.from(find("mantle.order.OrderHeader").condition("orderId", "in", orderIds).list())
        : []
    const pools = {}
    const reservationRows = shown.map(row => {
        const item = items.find(i => i.orderId === row.orderId && i.orderItemSeqId === row.orderItemSeqId),
            part = item ? parts.find(r => r.orderId === item.orderId && r.orderPartSeqId === item.orderPartSeqId) : null,
            header = headers.find(h => h.orderId === row.orderId)
        const key = [header?.productStoreId, part?.vendorPartyId, part?.customerPartyId].join("|")
        if (!pools[key])
            pools[key] = Array.from(
                call(P + "AssetServices.get#AssetPools", {
                    productStoreId: header?.productStoreId,
                    vendorPartyId: part?.vendorPartyId,
                    customerPartyId: part?.customerPartyId
                }).assetPoolIdSet || []
            )
        return {
            assetReservationId: row.assetReservationId,
            assetId: row.assetId,
            productId: row.productId,
            facilityId: row.facilityId,
            orderId: row.orderId,
            orderItemSeqId: row.orderItemSeqId,
            productStoreId: header?.productStoreId || null,
            customerPartyId: part?.customerPartyId || null,
            quantity: row.quantity,
            qualifies: !!row.orderId && pools[key].includes(found.assetPoolId)
        }
    })
    return {
        assetPoolId: found.assetPoolId,
        reservations: reservationRows,
        unqualifiedCount: reservationRows.filter(row => !row.qualifies).length,
        truncated: reservations.length > previewLimit
    }
}

function execute(op, p) {
    const operations = {findPools, getPool, storePool, storeParty, storeStore, previewReservations}
    if (!operations[op]) throw new Error("Unknown asset pool operation " + op)
    return operations[op](p)
}
;({execute})
