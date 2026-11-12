// Facility and location setup (mantle.facility.FacilityServices): the facility and location saves, each location type's
// asset status, and closing a location. The writes check FACILITY_EDIT and the organization by party relationship
// (FacilityScope.js, shared with the other facility and stock guards): a facility is the user's when its owner is in
// their scope. Facility parents never form a cycle. A location closes by its audit-logged thruDate only when nothing is
// stored or open there, and each thing that is is named. Disabled artifact authorization widens nothing here.
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const facilityScope = ec.resource.script("component://mr-mantle/service/mantle/facility/FacilityScope.js")
const {find, one, denied, call, ms} = lib

const facilityEntity = "mantle.facility.Facility"
const locationEntity = "mantle.facility.FacilityLocation"
// asset types that are stock, counted by quantity; any other asset (equipment, a fixed asset) blocks while it is there
const stockAssetTypes = ["AstTpInventory", "AstTpSupplies"]
// equipment that has left: delivered or deactivated (Asset has no disposed status; disposal sets actualEndOfLife)
const leftStatuses = ["AstDelivered", "AstDeactivated"]
// how many records of each kind a refusal names
const namedLimit = 10

const blank = value => value == null || String(value).trim() === ""
const text = value => (blank(value) ? null : String(value).trim())

// The user's scope: FACILITY_EDIT for a write, and the organizations whose facilities they work in (null for all).
function scope() {
    if (!ec.user.userId) denied("PERMISSION_DENIED", "Sign in to change facilities")
    if (!lib.access.has("FACILITY_EDIT")) denied("PERMISSION_DENIED", "Facility edit authority is required")
    return facilityScope.scope()
}
const ownedBy = (userScope, partyId) => facilityScope.owns(userScope, partyId)
// A facility of the user's (by its owner, or its nearest owning ancestor when it names none: FacilityScope.facilityOrganization),
// locked for update when asked; a missing one and another organization's are refused alike.
function facilityOf(userScope, facilityId, lock = false) {
    let query = find(facilityEntity, {facilityId: facilityId || "_NA_"})
    if (lock) query = query.forUpdate(true)
    const facility = blank(facilityId) ? null : query.one()
    if (!facility || !facilityScope.ownsFacility(userScope, facility))
        denied("FACILITY_UNAVAILABLE", "Facility " + (facilityId || "") + " is not available")
    return facility
}
function facilityLabel(facility) {
    return facility.facilityName ? facility.facilityName + " (" + facility.facilityId + ")" : facility.facilityId
}
function enumOf(enumId, enumTypeId, label) {
    const row = one("moqui.basic.Enumeration", {enumId})
    if (!row || row.enumTypeId !== enumTypeId) denied("VALUE_INVALID", "Choose a valid " + label)
    return row
}
function closed(location, now = ms(ec.user.nowTimestamp)) {
    return location.thruDate != null && ms(location.thruDate) <= now
}

// store#Facility: a new facility, or a change to one of the user's. Its owner is one of the user's internal
// organizations, and a change of owner needs a reason; its parent is one of their facilities and never itself or a
// facility under it. A blank parent keeps the stored one unless clearParent says the user removed it, and a parent equal
// to the stored one is kept without being checked again (the user may not see it).
function storeFacility(p) {
    const userScope = scope()
    const existing = blank(p.facilityId) ? null : find(facilityEntity, {facilityId: p.facilityId}).forUpdate(true).one()
    if (existing) facilityOf(userScope, existing.facilityId)
    const has = name => Object.prototype.hasOwnProperty.call(p, name) && p[name] !== undefined
    const ownerPartyId = has("ownerPartyId") && !blank(p.ownerPartyId) ? p.ownerPartyId : existing?.ownerPartyId
    // a stored facility that names no owner keeps none and stays its nearest owning ancestor's (facilityOf checked it); a new
    // facility names its owner
    const inherited = existing && !existing.ownerPartyId ? facilityScope.facilityOrganization(existing) : null
    if (!ownerPartyId && !inherited) denied("OWNER_REQUIRED", "Choose the organization that owns the facility")
    if (ownerPartyId && (!one("mantle.party.PartyRole", {partyId: ownerPartyId, roleTypeId: "OrgInternal"}) || !ownedBy(userScope, ownerPartyId)))
        denied("OWNER_UNAVAILABLE", "Organization " + ownerPartyId + " is not available")
    // a change of the facility's organization needs a reason; naming the organization it already takes from its ancestor does not
    if (existing && ownerPartyId && (existing.ownerPartyId || inherited) !== ownerPartyId && blank(p.changeReason))
        denied("REASON_REQUIRED", "Give a reason for the change of owner")
    const facilityName = has("facilityName") ? text(p.facilityName) : existing?.facilityName
    if (!facilityName) denied("NAME_REQUIRED", "Give the facility a name")
    if (!blank(p.facilityTypeEnumId)) enumOf(p.facilityTypeEnumId, "FacilityType", "facility type")
    const clearParent = p.clearParent === true || p.clearParent === "true" || p.clearParent === "Y"
    const parentChanged = !blank(p.parentFacilityId) && p.parentFacilityId !== existing?.parentFacilityId
    if (parentChanged) {
        const parent = facilityOf(userScope, p.parentFacilityId, true)
        // walk up from the parent, locking each ancestor: reaching this facility would make it its own ancestor
        const seen = new Set()
        const above = at =>
            at.parentFacilityId ? find(facilityEntity, {facilityId: at.parentFacilityId}).forUpdate(true).one() : null
        for (let at = parent; at; at = above(at)) {
            if (existing && at.facilityId === existing.facilityId)
                denied(
                    "PARENT_CYCLE",
                    facilityLabel(parent) + " is inside " + facilityLabel(existing) + ", so it cannot be its parent"
                )
            if (seen.has(at.facilityId)) break
            seen.add(at.facilityId)
        }
    }
    if (!blank(p.openedDate) && !blank(p.closedDate) && ms(p.closedDate) < ms(p.openedDate))
        denied("DATES_INVALID", "The facility cannot close before it opens")
    // a room's people capacity and booking, and the facility's time zone (impl-maintenance P2, F16)
    if (!blank(p.bookable) && !["Y", "N"].includes(String(p.bookable))) denied("VALUE_INVALID", "Bookable is Y or N")
    if (!blank(p.capacity)) {
        let capacity
        try {
            capacity = toDecimal(p.capacity)
        } catch (_) {
            capacity = null
        }
        if (capacity == null || capacity.compare(0) <= 0) denied("VALUE_INVALID", "Capacity is a number above zero")
    }
    if (!blank(p.capacityUomId) && !one("moqui.basic.Uom", {uomId: p.capacityUomId}))
        denied("VALUE_INVALID", "Choose a valid capacity unit")
    if (!blank(p.timeZone) && !Array.from(ec.l10n.getAvailableTimeZones() || []).includes(String(p.timeZone)))
        denied("VALUE_INVALID", "Choose a valid time zone")
    const values = Object.assign({}, p, {ownerPartyId, facilityName})
    for (const name of ["facilityId", "facilityTypeEnumId", "description", "bookable", "capacity", "capacityUomId", "timeZone"])
        if (has(name) && blank(p[name])) values[name] = null
    // the parent: the new one, none when the user removed it, else as stored
    if (parentChanged) values.parentFacilityId = p.parentFacilityId
    else if (clearParent && blank(p.parentFacilityId)) values.parentFacilityId = null
    else delete values.parentFacilityId
    delete values.changeReason
    delete values.clearParent
    if (existing) {
        // a new owner first, through the entity's own update, so the audit log keeps it with its reason
        if (existing.ownerPartyId !== ownerPartyId) {
            ec.context.putAll({ownerPartyId_changeReason: text(p.changeReason)})
            call("update#" + facilityEntity, {facilityId: existing.facilityId, ownerPartyId})
        }
        call("mantle.facility.FacilityServices.update#Facility", values)
        return {facilityId: existing.facilityId, created: false}
    }
    const out = call("mantle.facility.FacilityServices.create#Facility", values)
    return {facilityId: out.facilityId, created: true}
}

// store#FacilityLocation: a new location of one of the user's facilities (isNew refuses an id in use), or a change to an
// open one. Its id is given or made from the area, aisle, section, level and position.
function storeLocation(p) {
    const userScope = scope()
    const facility = facilityOf(userScope, p.facilityId, true)
    const locationSeqId =
        text(p.locationSeqId) || [p.areaId, p.aisleId, p.sectionId, p.levelId, p.positionId].map(v => text(v) || "").join("")
    if (!locationSeqId) denied("LOCATION_REQUIRED", "Give the location an id, or its area, aisle, section, level or position")
    const existing = find(locationEntity, {facilityId: facility.facilityId, locationSeqId}).forUpdate(true).one()
    if (existing && p.isNew)
        denied("LOCATION_EXISTS", "Location " + locationSeqId + " already exists in " + facilityLabel(facility))
    if (existing && closed(existing)) denied("LOCATION_CLOSED", "Location " + locationSeqId + " is closed; reopen it first")
    if (!blank(p.locationTypeEnumId)) enumOf(p.locationTypeEnumId, "FacilityLocationType", "location type")
    if (!blank(p.storageTypeEnumId)) enumOf(p.storageTypeEnumId, "StorageType", "storage type")
    if (!blank(p.capacity)) {
        let capacity
        try {
            capacity = toDecimal(p.capacity)
        } catch (_) {
            capacity = null
        }
        if (capacity == null || capacity.compare(0) < 0) denied("VALUE_INVALID", "Capacity cannot be negative")
    }
    if (!blank(p.capacityUomId) && !one("moqui.basic.Uom", {uomId: p.capacityUomId}))
        denied("VALUE_INVALID", "Choose a valid capacity unit")
    if (!blank(p.sequenceNum) && (!Number.isInteger(Number(p.sequenceNum)) || Number(p.sequenceNum) < 0))
        denied("VALUE_INVALID", "The pick sequence is a whole number, zero or more")
    const fields = ["locationTypeEnumId", "description", "areaId", "aisleId", "sectionId", "levelId", "positionId"]
    const values = {facilityId: facility.facilityId, locationSeqId}
    for (const name of fields.concat(["capacity", "capacityUomId", "sequenceNum", "storageTypeEnumId"]))
        if (p[name] !== undefined) values[name] = blank(p[name]) ? null : p[name]
    if (existing) call("update#" + locationEntity, values)
    else call("mantle.facility.FacilityServices.create#FacilityLocation", values)
    return {facilityId: facility.facilityId, locationSeqId, created: !existing}
}

// store#FacilityLocationType: the asset status that receive#Asset and move#Asset give stock put in a location of this type
// in the facility (none: they leave the status as it is). The change is audit-logged with its reason.
function storeLocationType(p) {
    const userScope = scope()
    const facility = facilityOf(userScope, p.facilityId, true)
    enumOf(p.locationTypeEnumId, "FacilityLocationType", "location type")
    const autoStatusId = text(p.autoStatusId)
    if (autoStatusId && one("moqui.basic.StatusItem", {statusId: autoStatusId})?.statusTypeId !== "Asset")
        denied("VALUE_INVALID", "Choose an asset status")
    if (blank(p.changeReason)) denied("REASON_REQUIRED", "Give a reason for the change")
    const key = {facilityId: facility.facilityId, locationTypeEnumId: p.locationTypeEnumId}
    const existing = find("mantle.facility.FacilityLocationType", key).forUpdate(true).one()
    ec.context.putAll({autoStatusId_changeReason: String(p.changeReason).trim()})
    if (existing) call("update#mantle.facility.FacilityLocationType", Object.assign({}, key, {autoStatusId}))
    else call("create#mantle.facility.FacilityLocationType", Object.assign({}, key, {autoStatusId}))
    return {facilityId: facility.facilityId, locationTypeEnumId: p.locationTypeEnumId, autoStatusId}
}

// What keeps a location from closing, each named: stock there with on-hand or available-to-promise not zero (a depleted
// asset stays at zero and does not block), equipment there that has not left (an asset counted by quantity with on-hand
// and available-to-promise both zero is gone, whatever its type), a container, a reservation not issued on an asset there
// (an open pick), a count line there on a count not complete, a product's location policy naming it, a warehouse
// operation policy in effect or to come naming it as a default location, and a putaway rule in effect or to come naming it
// as its source or destination (P9). Each kind is
// one find filtered in the database: its count and the first records it names.
function blockersOf(facilityId, locationSeqId) {
    const at = {facilityId, locationSeqId}
    const factory = ec.entity.conditionFactory
    const cond = (field, operator, value) => factory.makeCondition(field, operator, value)
    const anyOf = conditions => factory.makeCondition(conditions, "or")
    const allOf = conditions => factory.makeCondition(conditions, "and")
    const blockers = []
    const add = (kind, label, query, field, show = row => row[field]) => {
        const count = query().count()
        if (!count) return
        const records = Array.from(query().orderBy(field).limit(namedLimit).list()).map(show)
        const more = count > namedLimit ? " and " + (count - namedLimit) + " more" : ""
        blockers.push({kind, label, recordIds: records, count, text: label + " " + records.join(", ") + more})
    }
    const notZero = anyOf([cond("quantityOnHandTotal", "not-equals", 0), cond("availableToPromiseTotal", "not-equals", 0)])
    const stockType = anyOf([cond("assetTypeEnumId", "is-null", null), cond("assetTypeEnumId", "in", stockAssetTypes)])
    add(
        "stock",
        "stock on hand or promised:",
        () => find("mantle.product.asset.Asset", at).condition(stockType).condition(notZero),
        "assetId"
    )
    add(
        "equipment",
        "equipment that has not left:",
        () =>
            find("mantle.product.asset.Asset", at)
                .condition("assetTypeEnumId", "not-in", stockAssetTypes)
                .condition(cond("assetTypeEnumId", "is-not-null", null))
                .condition(anyOf([cond("statusId", "is-null", null), cond("statusId", "not-in", leftStatuses)]))
                .condition(cond("actualEndOfLife", "is-null", null))
                .condition(anyOf([cond("hasQuantity", "is-null", null), cond("hasQuantity", "not-equals", "Y"), notZero])),
        "assetId"
    )
    add("container", "containers:", () => find("mantle.product.asset.Container", at), "containerId")
    add(
        "reservation",
        "reservations not issued (open picks) on",
        () => find("mantle.product.issuance.AssetAndReservation", at).condition("quantityNotIssued", "greater", 0),
        "assetReservationId",
        row => row.assetReservationId + " (asset " + row.assetId + ")"
    )
    const countIds = Array.from(
        find("mantle.product.asset.PhysicalInventoryCount", at)
            .condition(cond("physicalInventoryId", "is-not-null", null))
            .selectField("physicalInventoryId")
            .distinct(true)
            .list()
    ).map(row => row.physicalInventoryId)
    // a planned count scoped to the location has no lines yet (P10)
    for (const row of find("mantle.product.asset.PhysicalInventory", {facilityId, scopeLocationSeqId: locationSeqId})
        .selectField("physicalInventoryId")
        .list())
        if (!countIds.includes(row.physicalInventoryId)) countIds.push(row.physicalInventoryId)
    if (countIds.length)
        add(
            "count",
            "counts still open:",
            () =>
                find("mantle.product.asset.PhysicalInventory")
                    .condition("physicalInventoryId", "in", countIds)
                    // a count still open (P10's statuses): neither complete nor cancelled
                    .condition(
                        anyOf([cond("statusId", "is-null", null), cond("statusId", "not-in", ["PIComplete", "PICancelled"])])
                    ),
            "physicalInventoryId"
        )
    add("productLocation", "product location policies of", () => find("mantle.facility.ProductFacilityLocation", at), "productId")
    // a warehouse operation policy in effect or to come that names it as a default location (WarehousePolicy.js)
    add(
        "operationPolicy",
        "warehouse operation policies naming it, from",
        () =>
            find("mantle.facility.WarehousePolicy", {facilityId, policyType: "operation"})
                .condition(
                    anyOf(
                        ["receivingLocationSeqId", "quarantineLocationSeqId", "stagingLocationSeqId"].map(field =>
                            cond(field, "equals", locationSeqId)
                        )
                    )
                )
                .condition(anyOf([cond("thruDate", "is-null", null), cond("thruDate", "greater", ec.user.nowTimestamp)])),
        "fromDate",
        row => ec.l10n.format(new Date(ms(row.fromDate)), "yyyy-MM-dd HH:mm")
    )
    // a putaway rule in effect or to come that names it (Putaway.js, P9)
    add(
        "putawayRule",
        "putaway rules naming it:",
        () =>
            find("mantle.facility.PutawayRule", {facilityId})
                .condition(
                    anyOf([cond("toLocationSeqId", "equals", locationSeqId), cond("fromLocationSeqId", "equals", locationSeqId)])
                )
                .condition(anyOf([cond("thruDate", "is-null", null), cond("thruDate", "greater", ec.user.nowTimestamp)])),
        "putawayRuleId"
    )
    return blockers
}
function locationOf(userScope, p, lock) {
    const facility = facilityOf(userScope, p.facilityId, lock)
    let query = find(locationEntity, {facilityId: facility.facilityId, locationSeqId: p.locationSeqId || "_NA_"})
    if (lock) query = query.forUpdate(true)
    const location = blank(p.locationSeqId) ? null : query.one()
    if (!location) denied("LOCATION_UNAVAILABLE", "Location " + (p.locationSeqId || "") + " is not available")
    return {facility, location}
}
// get#FacilityLocationBlockers: what keeps the location from closing now.
function blockers(p) {
    const {facility, location} = locationOf(scope(), p, false)
    return {blockers: blockersOf(facility.facilityId, location.locationSeqId), locationClosed: closed(location)}
}
// close#FacilityLocation: the location closes now, with its reason in the audit log, when nothing blocks it.
function closeLocation(p) {
    const {facility, location} = locationOf(scope(), p, true)
    if (closed(location)) denied("LOCATION_CLOSED", "Location " + location.locationSeqId + " is already closed")
    if (blank(p.changeReason)) denied("REASON_REQUIRED", "Give a reason for closing the location")
    const found = blockersOf(facility.facilityId, location.locationSeqId)
    if (found.length)
        denied(
            "LOCATION_IN_USE",
            "Location " + location.locationSeqId + " cannot close until it is empty: " + found.map(b => b.text).join("; ")
        )
    const thruDate = ec.user.nowTimestamp
    ec.context.putAll({thruDate_changeReason: String(p.changeReason).trim()})
    call("update#" + locationEntity, {facilityId: facility.facilityId, locationSeqId: location.locationSeqId, thruDate})
    return {facilityId: facility.facilityId, locationSeqId: location.locationSeqId, thruDate}
}
// reopen#FacilityLocation: a closed location is open again, with its reason in the audit log.
function reopenLocation(p) {
    const {facility, location} = locationOf(scope(), p, true)
    if (location.thruDate == null) denied("LOCATION_OPEN", "Location " + location.locationSeqId + " is open")
    if (blank(p.changeReason)) denied("REASON_REQUIRED", "Give a reason for reopening the location")
    ec.context.putAll({thruDate_changeReason: String(p.changeReason).trim()})
    call("update#" + locationEntity, {facilityId: facility.facilityId, locationSeqId: location.locationSeqId, thruDate: null})
    return {facilityId: facility.facilityId, locationSeqId: location.locationSeqId}
}
// check#FacilityLocationOpen: refuses a location that does not exist or is closed, or one of a facility that has closed.
// A destination guard calls it inside its own operation and transaction, which has checked the user and the facility;
// the location row is locked for update, so a close of the location waits for the guard's transaction or the guard for
// the close.
function checkOpen(p) {
    const location =
        blank(p.facilityId) || blank(p.locationSeqId)
            ? null
            : find(locationEntity, {facilityId: p.facilityId, locationSeqId: p.locationSeqId}).forUpdate(true).one()
    if (!location) denied("LOCATION_UNAVAILABLE", "Location " + (p.locationSeqId || "") + " is not available")
    if (closed(location))
        denied("LOCATION_CLOSED", "Location " + location.locationSeqId + " of facility " + location.facilityId + " is closed")
    const facility = one(facilityEntity, {facilityId: location.facilityId})
    if (facility?.closedDate != null && ms(facility.closedDate) <= ms(ec.user.nowTimestamp))
        denied("FACILITY_CLOSED", "Facility " + location.facilityId + " is closed")
    return {locationTypeEnumId: location.locationTypeEnumId || null}
}

// store#FacilityFeature: a room feature of one of the user's facilities from a date, or the end of the one in effect; rows are
// ended, never deleted, so the features on a past day stay readable (impl-maintenance P2).
function storeFeature(p) {
    const userScope = scope()
    const facility = facilityOf(userScope, p.facilityId, true)
    enumOf(p.featureEnumId, "RoomFeature", "room feature")
    const now = ms(ec.user.nowTimestamp)
    const rows = Array.from(
        find("mantle.facility.FacilityFeature", {facilityId: facility.facilityId, featureEnumId: p.featureEnumId}).forUpdate(true).list()
    )
    const open = rows.filter(row => row.thruDate == null || ms(row.thruDate) > now)
    if (p.end === true || p.end === "true" || p.end === "Y") {
        const current = open.find(row => ms(row.fromDate) <= now) || open[0]
        if (!current) denied("RECORD_UNAVAILABLE", "The room has no such feature in effect")
        const thruDate = blank(p.thruDate) ? ec.user.nowTimestamp : p.thruDate
        if (ms(thruDate) < ms(current.fromDate)) denied("DATES_INVALID", "A feature cannot end before it starts")
        call("update#mantle.facility.FacilityFeature", {
            facilityId: facility.facilityId,
            featureEnumId: p.featureEnumId,
            fromDate: current.fromDate,
            thruDate
        })
        return {facilityId: facility.facilityId, featureEnumId: p.featureEnumId, fromDate: current.fromDate}
    }
    if (open.length) denied("FEATURE_EXISTS", "The room already has this feature")
    const fromDate = blank(p.fromDate) ? ec.user.nowTimestamp : p.fromDate
    if (!blank(p.thruDate) && ms(p.thruDate) < ms(fromDate)) denied("DATES_INVALID", "A feature cannot end before it starts")
    call("create#mantle.facility.FacilityFeature", {
        facilityId: facility.facilityId,
        featureEnumId: p.featureEnumId,
        fromDate,
        thruDate: blank(p.thruDate) ? null : p.thruDate,
        comments: text(p.comments)
    })
    return {facilityId: facility.facilityId, featureEnumId: p.featureEnumId, fromDate}
}

const operations = {storeFacility, storeLocation, storeLocationType, blockers, closeLocation, reopenLocation, checkOpen, storeFeature}
function execute(op, parameters) {
    if (!operations[op]) throw new Error("Unknown facility operation " + op)
    return operations[op](parameters)
}
;({execute})
