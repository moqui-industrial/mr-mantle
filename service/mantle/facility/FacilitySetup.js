// Facility and location setup (mantle.facility.FacilityServices): the facility and location saves, each location type's
// asset status, and closing a location. The writes check FACILITY_EDIT and the organization by party relationship: a
// facility is the user's when its owner is one of their organizations (get#PartyOrganizationInfo userOrgIds), and a
// system administrator works in every one. Facility parents never form a cycle. A location closes by its audit-logged
// thruDate only when nothing is stored or open there, and each thing that is is named. Disabled artifact authorization
// widens nothing here.
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const {find, one, rows, denied, call, ms} = lib

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
    if (lib.access.systemAdmin()) return {organizationPartyIds: null}
    const organization = call("mantle.party.PartyServices.get#PartyOrganizationInfo")
    return {organizationPartyIds: Array.from(organization.userOrgIds || [])}
}
function ownedBy(userScope, partyId) {
    return !!partyId && (!userScope.organizationPartyIds || userScope.organizationPartyIds.includes(partyId))
}
// A facility of the user's, locked for update when asked; a missing one and another organization's are refused alike.
function facilityOf(userScope, facilityId, lock = false) {
    let query = find(facilityEntity, {facilityId: facilityId || "_NA_"})
    if (lock) query = query.forUpdate(true)
    const facility = blank(facilityId) ? null : query.one()
    if (!facility || !ownedBy(userScope, facility.ownerPartyId))
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
// organizations; its parent is one of their facilities and never itself or a facility under it.
function storeFacility(p) {
    const userScope = scope()
    const existing = blank(p.facilityId) ? null : find(facilityEntity, {facilityId: p.facilityId}).forUpdate(true).one()
    if (existing) facilityOf(userScope, existing.facilityId)
    const has = name => Object.prototype.hasOwnProperty.call(p, name) && p[name] !== undefined
    const ownerPartyId = has("ownerPartyId") && !blank(p.ownerPartyId) ? p.ownerPartyId : existing?.ownerPartyId
    if (!ownerPartyId) denied("OWNER_REQUIRED", "Choose the organization that owns the facility")
    if (!one("mantle.party.PartyRole", {partyId: ownerPartyId, roleTypeId: "OrgInternal"}) || !ownedBy(userScope, ownerPartyId))
        denied("OWNER_UNAVAILABLE", "Organization " + ownerPartyId + " is not available")
    const facilityName = has("facilityName") ? text(p.facilityName) : existing?.facilityName
    if (!facilityName) denied("NAME_REQUIRED", "Give the facility a name")
    if (!blank(p.facilityTypeEnumId)) enumOf(p.facilityTypeEnumId, "FacilityType", "facility type")
    if (has("parentFacilityId") && !blank(p.parentFacilityId)) {
        const parent = facilityOf(userScope, p.parentFacilityId)
        // walk up from the parent: reaching this facility would make it its own ancestor
        const seen = new Set()
        for (let at = parent; at; at = at.parentFacilityId ? one(facilityEntity, {facilityId: at.parentFacilityId}) : null) {
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
    const values = Object.assign({}, p, {ownerPartyId, facilityName})
    for (const name of ["facilityId", "facilityTypeEnumId", "parentFacilityId", "description"])
        if (has(name) && blank(p[name])) values[name] = null
    delete values.changeReason
    if (existing) {
        // the owner is audit-logged with the reason given
        if (!blank(p.changeReason)) ec.context.putAll({ownerPartyId_changeReason: String(p.changeReason).trim()})
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
    for (const name of fields.concat(["capacity", "capacityUomId", "sequenceNum"]))
        if (p[name] !== undefined) values[name] = blank(p[name]) ? null : p[name]
    call((existing ? "update#" : "create#") + locationEntity, values)
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
// asset stays at zero and does not block), equipment there that has not left, a container, a reservation not issued on an
// asset there (an open pick), a count line there on a count not complete, and a product's location policy naming it.
function blockersOf(facilityId, locationSeqId) {
    const at = {facilityId, locationSeqId}
    const blockers = []
    const add = (kind, label, records) => {
        if (!records.length) return
        const named = records.slice(0, namedLimit).join(", ")
        const more = records.length > namedLimit ? " and " + (records.length - namedLimit) + " more" : ""
        blockers.push({
            kind,
            label,
            recordIds: records.slice(0, namedLimit),
            count: records.length,
            text: label + " " + named + more
        })
    }
    const factory = ec.entity.conditionFactory
    const assets = rows("mantle.product.asset.Asset", at)
    const stock = assets.filter(asset => !asset.assetTypeEnumId || stockAssetTypes.includes(asset.assetTypeEnumId))
    const zero = value => value == null || toDecimal(value).isZero()
    add(
        "stock",
        "stock on hand or promised:",
        stock.filter(asset => !zero(asset.quantityOnHandTotal) || !zero(asset.availableToPromiseTotal)).map(a => a.assetId)
    )
    add(
        "equipment",
        "equipment that has not left:",
        assets
            .filter(asset => asset.assetTypeEnumId && !stockAssetTypes.includes(asset.assetTypeEnumId))
            .filter(asset => !leftStatuses.includes(asset.statusId) && asset.actualEndOfLife == null)
            .map(asset => asset.assetId)
    )
    add(
        "container",
        "containers:",
        rows("mantle.product.asset.Container", at).map(container => container.containerId)
    )
    const assetIds = assets.map(asset => asset.assetId)
    add(
        "reservation",
        "reservations not issued (open picks) on",
        assetIds.length
            ? Array.from(
                  find("mantle.product.issuance.AssetReservation")
                      .condition("assetId", "in", assetIds)
                      .condition("quantityNotIssued", "greater", 0)
                      .orderBy("assetReservationId")
                      .list()
              ).map(row => row.assetReservationId + " (asset " + row.assetId + ")")
            : []
    )
    const countLines = Array.from(
        find("mantle.product.asset.PhysicalInventoryCount")
            .condition(factory.makeCondition("physicalInventoryId", "is-not-null", null))
            .condition(at)
            .list()
    )
    const countIds = [...new Set(countLines.map(line => line.physicalInventoryId))]
    const openCountIds = countIds.length
        ? Array.from(
              find("mantle.product.asset.PhysicalInventory")
                  .condition("physicalInventoryId", "in", countIds)
                  .condition(
                      factory.makeCondition(
                          [
                              factory.makeCondition("statusId", "is-null", null),
                              factory.makeCondition("statusId", "not-equals", "PIComplete")
                          ],
                          "or"
                      )
                  )
                  .list()
          ).map(row => row.physicalInventoryId)
        : []
    add("count", "counts not complete:", openCountIds)
    add(
        "productLocation",
        "product location policies of",
        rows("mantle.facility.ProductFacilityLocation", at).map(row => row.productId)
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
// check#FacilityLocationOpen: refuses a location that does not exist or is closed (a destination guard calls it inside
// its own operation, which has checked the user and the facility).
function checkOpen(p) {
    const location =
        blank(p.facilityId) || blank(p.locationSeqId)
            ? null
            : one(locationEntity, {facilityId: p.facilityId, locationSeqId: p.locationSeqId})
    if (!location) denied("LOCATION_UNAVAILABLE", "Location " + (p.locationSeqId || "") + " is not available")
    if (closed(location))
        denied("LOCATION_CLOSED", "Location " + location.locationSeqId + " of facility " + location.facilityId + " is closed")
    return {locationTypeEnumId: location.locationTypeEnumId || null}
}

const operations = {storeFacility, storeLocation, storeLocationType, blockers, closeLocation, reopenLocation, checkOpen}
function execute(op, parameters) {
    if (!operations[op]) throw new Error("Unknown facility operation " + op)
    return operations[op](parameters)
}
;({execute})
