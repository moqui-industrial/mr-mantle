// The Warehouse posting guard (impl-warehouse §2 "One posting guard", design-warehouse §17 WH-POST): the steps every
// mantle.shipment.WarehouseTaskServices entry point takes around a Mantle stock primitive, in this order:
//   1. begin: the entry point's Moqui permission, then the operation key on the CX-POSTING record (PostingOperation): a
//      retry with the same request answers the first result before any other check, a changed request under the key is
//      refused. The key is the client's (a scan id, a form's operation id), so the stored key is scoped per user and
//      operation type (F143): another user's or another operation's same key is a different operation.
//   2. stock: the records, locked, in a facility of the user's organizations (FacilityScope.js), still stock, with the
//      quantity on hand. One lock order everywhere: containers (the one moved or the target), then assets by id, then
//      the destination location. Then settled: the operation key once more, so a concurrent submit of the same operation
//      that waited on the locks answers the first.
//   3. destination: the target in the same facility (another facility is a transfer; a container holds one owner's
//      stock), open (check#FacilityLocationOpen, which locks it), and the status its location type gives.
//   4. status, expiry and policy: held stock stays held, and any other status change needs a status flow transition
//      (F8); the expiry of the stock (a warning on a move; the gate of WarehousePolicy.expiryBlock refuses reservation
//      and issue in Mantle itself, §4).
//   5. the Mantle primitive and its dependent writes, in the entry point's one transaction.
//   6. complete: the answer, stored with the operation and returned.
// A batch runs each row as its own operation in its own transaction and names each failure (batch). The period: an entry
// point that posts value (an adjustment, a scrap, a repack) refuses a closed fiscal period of its effective date before
// it posts (period, PostingGuard.js's fiscal periods), as post#AcctgTrans would otherwise send the posting to the error
// journal; a move posts no value and has none.
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const facilityScope = ec.resource.script("component://mr-mantle/service/mantle/facility/FacilityScope.js")
const {find, one, denied, call, hash, access} = lib

const ASSET = "mantle.product.asset.Asset",
    CONTAINER = "mantle.product.asset.Container",
    FACILITY = "mantle.facility.Facility",
    RESERVATION = "mantle.product.issuance.AssetReservation"
// the asset types that are stock (anything else is equipment, which these tasks do not move); no type is stock
const stockTypes = ["AstTpInventory", "AstTpSupplies"]
// statuses only a quality disposition changes (dispose#Inspection, P8): a move keeps them
const heldStatuses = ["AstQuarantine"]
const keyLimit = 200

const blank = value => value == null || String(value).trim() === ""
const number = value => (value == null || value === "" ? null : Number(String(value)))
const text = value => (blank(value) ? null : String(value))

// ===== 1. permission and operation key =====
// The request a retry must repeat: the named fields as text, numbers in a canonical form ("5" for 5.000).
function requestOf(p, fields) {
    return Object.fromEntries(
        fields.map(field => {
            const value = p[field]
            if (blank(value)) return [field, null]
            if (typeof value === "object" && typeof value.toNumber === "function") return [field, String(value.toNumber())]
            if (Array.isArray(value)) return [field, JSON.stringify(value)]
            return [field, String(value)]
        })
    )
}
// The stored key of a client's operation key, scoped by user and operation type, within PostingOperation's 40 characters.
function storedKey(operationType, clientKey) {
    const digest = String(hash([ec.user.userId || "", operationType, clientKey])).replace(/[^A-Za-z0-9]/g, "")
    return "WH" + digest.slice(0, 38)
}
function operation(p, operationType, request) {
    const clientKey = String(p.operationKey || "").trim()
    if (!clientKey || clientKey.length > keyLimit)
        denied("OPERATION_KEY_REQUIRED", "An operation key of at most " + keyLimit + " characters is required")
    const operationKey = storedKey(operationType, clientKey)
    const requestHash = hash(request)
    const op = {operationKey, clientKey, requestHash, old: null, operationType, organizationPartyId: null}
    op.old = stored(op)
    return op
}
// The stored row of the operation, refusing one made for another user, operation type or request.
function stored(op) {
    const old = one(lib.operationEntity, {operationKey: op.operationKey})
    if (old && (old.requestHash !== op.requestHash || old.operationType !== op.operationType || old.userId !== ec.user.userId))
        denied("OPERATION_KEY_CONFLICT", "Operation " + op.clientKey + " was already used for another request")
    return old
}
// The permission, or one of a list of permissions.
function requirePermission(permission) {
    const any = Array.isArray(permission) ? permission : [permission]
    if (!any.some(access.has)) denied("PERMISSION_DENIED", any.join(" or ") + " is required")
}
// The permission, then the operation: {op, previous}, previous the first answer when this is a retry.
function begin(p, operationType, permission, requestFields) {
    requirePermission(permission)
    const op = operation(p, operationType, requestOf(p, requestFields))
    return {op, previous: lib.previous(op)}
}
// After the records are locked, the operation once more: a concurrent submit of the same operation, which waited on the
// lock, finds the first one's row now and answers it (alreadyApplied) rather than failing on what that one changed.
function settled(op) {
    op.old = stored(op)
    return lib.previous(op)
}

// ===== 2. stock =====
function scope() {
    if (!ec.user.userId) denied("PERMISSION_DENIED", "A signed-in user is required")
    return facilityScope.scope()
}
// A facility of the user's organizations; a missing one and one outside the scope are refused alike.
function facility(userScope, facilityId) {
    const row = facilityId ? one(FACILITY, {facilityId}) : null
    if (!row || !facilityScope.owns(userScope, row.ownerPartyId))
        denied("RECORD_UNAVAILABLE", "Facility " + (facilityId || "") + " is not available")
    return row
}
// The asset, locked: stock in a facility of the user's organizations, with on hand; quantity (when given) above zero and
// at most the on-hand quantity.
function stock(userScope, assetId, quantity) {
    const asset = blank(assetId) ? null : find(ASSET, {assetId}).forUpdate(true).one()
    const home = asset?.facilityId ? one(FACILITY, {facilityId: asset.facilityId}) : null
    if (!asset || !home || !facilityScope.owns(userScope, home.ownerPartyId))
        denied("RECORD_UNAVAILABLE", "Asset " + (assetId || "") + " is not available")
    if (asset.assetTypeEnumId && !stockTypes.includes(asset.assetTypeEnumId))
        denied("NOT_STOCK", "Asset " + assetId + " is equipment, not stock")
    const onHand = number(asset.quantityOnHandTotal) || 0
    if (onHand <= 0) denied("NO_STOCK", "Asset " + assetId + " has nothing on hand")
    if (quantity != null && quantity !== "") {
        const wanted = number(quantity)
        if (!(wanted > 0)) denied("QUANTITY_INVALID", "Give a quantity above zero")
        if (wanted > onHand) denied("QUANTITY_EXCEEDS_ON_HAND", "Asset " + assetId + " has only " + onHand + " on hand")
    }
    return asset
}
// A container, locked, in the user's facilities.
function container(userScope, containerId) {
    const row = blank(containerId) ? null : find(CONTAINER, {containerId}).forUpdate(true).one()
    const home = row?.facilityId ? one(FACILITY, {facilityId: row.facilityId}) : null
    if (!row || !home || !facilityScope.owns(userScope, home.ownerPartyId))
        denied("RECORD_UNAVAILABLE", "Container " + (containerId || "") + " is not available")
    return row
}

// ===== 3. destination =====
// The target of a move in facilityId: a location, or a container (its location). A different facility is a transfer
// (OTHER_FACILITY). The location must be open, locked against a close (check#FacilityLocationOpen); autoStatusId is the
// status its location type gives stock there.
function destination(userScope, facilityId, p) {
    if (!blank(p.toFacilityId) && p.toFacilityId !== facilityId)
        denied("OTHER_FACILITY", "A move to another facility is a transfer; open Transfers")
    let target = null,
        locationSeqId = text(p.toLocationSeqId)
    if (!blank(p.toContainerId)) {
        target = container(userScope, p.toContainerId)
        if (target.facilityId !== facilityId)
            denied("OTHER_FACILITY", "Container " + target.containerId + " is in another facility; a move there is a transfer")
        if (!target.locationSeqId) denied("LOCATION_REQUIRED", "Container " + target.containerId + " has no location")
        if (locationSeqId && locationSeqId !== target.locationSeqId)
            denied("LOCATION_MISMATCH", "Container " + target.containerId + " is at " + target.locationSeqId)
        // a container holds one owner's stock
        const otherOwners = p.ownerPartyId
            ? find(ASSET, {containerId: target.containerId}).condition("ownerPartyId", "not-equals", p.ownerPartyId).count()
            : 0
        if (otherOwners) denied("CONTAINER_OWNER", "Container " + target.containerId + " holds another owner's stock")
        locationSeqId = target.locationSeqId
    }
    if (!locationSeqId) denied("LOCATION_REQUIRED", "Choose a location to move to")
    const open = call("mantle.facility.FacilityServices.check#FacilityLocationOpen", {facilityId, locationSeqId})
    const type = open.locationTypeEnumId
        ? one("mantle.facility.FacilityLocationType", {facilityId, locationTypeEnumId: open.locationTypeEnumId})
        : null
    return {
        facilityId,
        locationSeqId,
        containerId: target?.containerId || null,
        locationTypeEnumId: open.locationTypeEnumId || null,
        autoStatusId: type?.autoStatusId || null
    }
}

// ===== 4. status, expiry and policy =====
// The status stock has after the move, refusing one that would release held stock (F8): only a quality disposition
// changes a quarantined asset's status, so it moves only where its status stays. Any other change of status needs a
// status flow transition from the current status to the new one (move#Asset checks one on a whole move only, so a part
// moved into a pick bin would otherwise leave the morgue or a defect as available stock): HELD_STOCK too.
function keepHeld(asset, target) {
    const after = target.autoStatusId || asset.statusId
    if (after === asset.statusId) return after
    const released = heldStatuses.includes(asset.statusId)
    const flows =
        released || !asset.statusId
            ? 0
            : find("moqui.basic.StatusFlowTransition", {statusId: asset.statusId, toStatusId: after}).count()
    if (released || (asset.statusId && !flows))
        denied(
            "HELD_STOCK",
            `Asset ${asset.assetId} is ${asset.statusId}; location ${target.locationSeqId} would make it ${after}` +
                (released ? ". Only an inspection's disposition releases held stock" : "")
        )
    return after
}
// The asset's expiry as warnings: expired, or within the near-expiry days of its tracking policy, each with its date.
function expiryWarnings(assetId) {
    const expiry = call("mantle.facility.WarehousePolicyServices.get#AssetExpiry", {assetId})
    if (expiry.expired) return [{code: "EXPIRED", expiryDate: expiry.expiryDate, message: "Expired on " + expiry.expiryDate}]
    if (expiry.nearExpiry)
        return [{code: "NEAR_EXPIRY", expiryDate: expiry.expiryDate, message: "Expires on " + expiry.expiryDate}]
    return []
}

// The fiscal period of the effective date, for each organization that posts: refused when a period of the organization,
// or of one it rolls up to, holds the day and is closed (PERIOD_CLOSED). The periods are read for update, so a close
// waits for the posting. Accounting's own check (PostingGuard.js) runs again inside post#AcctgTrans.
function period(organizationPartyIds, effectiveDate) {
    const guard = ec.resource.script("component://mr-mantle/service/mantle/ledger/PostingGuard.js")
    const date = effectiveDate || ec.user.nowTimestamp
    for (const organizationPartyId of [...new Set(organizationPartyIds.filter(Boolean))].sort()) {
        const closed = guard.fiscal(organizationPartyId, date, true).findings.find(row => row.code === "PERIOD_CLOSED")
        if (closed)
            denied(
                "PERIOD_CLOSED",
                "The fiscal period of " + ec.l10n.format(date, "yyyy-MM-dd") + " is closed for " + organizationPartyId
            )
    }
    return date
}

// ===== 5. the posting and its dependent writes =====
// A reservation carried onto stock that is not available (a partial move into a held location carries the quantity
// beyond the source's ATP) is checked again, so the order is re-reserved on available stock (F38). A whole asset that
// changes status is checked by Mantle's AssetStatusNotAvailableReservations.
function recheckReservations(assetId) {
    const moved = one(ASSET, {assetId})
    if (!moved || moved.statusId === "AstAvailable") return false
    if (!find(RESERVATION, {assetId}).count()) return false
    call("mantle.product.AssetServices.check#AssetReservations", {assetId})
    return true
}

// ===== 6. the answer =====
// Stores the answer with the operation (its organization, the record it made or changed) and returns it.
function complete(op, organizationPartyId, resultEntityName, resultId, answer) {
    op.organizationPartyId = organizationPartyId || null
    const result = Object.assign(
        {operationKey: op.clientKey, operationType: op.operationType, alreadyApplied: false, postedDate: ec.user.nowTimestamp},
        answer
    )
    lib.complete(op, resultEntityName, resultId, result)
    return result
}

// ===== batch =====
// The reason code of a refusal's text ("CODE: message", perhaps after a prefix), else FAILED.
function reasonOf(message) {
    const match = /(?:^|[\s:])([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+):/.exec(message)
    return match ? match[1] : "FAILED"
}
// Each row through the single-row entry point, in its own transaction, as the operation "<batch key>/<row key>": a row
// that fails is named with its reason and the others go on, and a retry of the batch answers the rows already done.
function batch(p, rows, rowKey, serviceName, parametersOf) {
    const batchKey = String(p.operationKey || "").trim()
    if (!batchKey) denied("OPERATION_KEY_REQUIRED", "An operation key is required")
    const results = []
    for (const row of rows) {
        const key = rowKey(row)
        try {
            const out = lib.probe(serviceName, Object.assign(parametersOf(row), {operationKey: batchKey + "/" + key}))
            results.push({key, ok: true, resultCode: out.result?.resultCode || "DONE", result: out.result})
        } catch (error) {
            const message = String(error?.message || error).replace(/^(Error: )+/, "")
            ec.logger.warn("Warehouse batch row " + key + " of " + serviceName + " failed: " + message)
            results.push({key, ok: false, reasonCode: reasonOf(message), message})
        }
    }
    return {results, okCount: results.filter(row => row.ok).length, failedCount: results.filter(row => !row.ok).length}
}

;({
    stockTypes,
    heldStatuses,
    requirePermission,
    begin,
    settled,
    scope,
    facility,
    stock,
    container,
    destination,
    keepHeld,
    expiryWarnings,
    period,
    recheckReservations,
    complete,
    reasonOf,
    batch
})
