// Maintenance's equipment and facility records (IronStone Maintenance design §6, §13.2 MaintenanceResourceServices; impl-maintenance
// P2): the scoped equipment and facility finds, the equipment writer, the one meter writer, registrations, the guarded custody
// change, the equipment move and the preview of a facility move or close. Every operation checks the maintenance permission and
// scope first (MaintenanceAccess.js): an equipment write MAINTENANCE_RESOURCE_EDIT and the asset's organization, a read the
// resource read (view, assigned view or resource view) and the organization; a missing record and one outside the scope are
// refused alike (RECORD_UNAVAILABLE). Facility writes stay FacilityServices.store#Facility's (FACILITY_EDIT).
//
// - Equipment is an asset that is not stock (its type is not AstTpInventory or AstTpSupplies); one that has left (delivered,
//   deactivated) is listed only when asked. Registration goes through EquipmentServices.create#Equipment and changes through
//   AssetServices.update#Asset, which check nothing themselves (F11): only identity, name, comments, parent, class and the
//   supplier warranty, never quantity, owner, location, cost or book fields, and not AssetRecordServices.update#AssetMetadata,
//   which is Warehouse's under STOCK_ADJUST (F17).
// - A meter reading is an AssetMeter row, keyed by the asset and the reading time (F19): two readings at one time are refused,
//   not overwritten; a cumulative meter (ProductMeter.isCumulative) only counts up, unless the reading is a reset (a lower value
//   from then on) or a correction of a reading already taken, each with its reason in the audit log (AssetMeter.meterValue);
//   the reason enumeration is AssetMeterReadingReason (F70).
// - A custody change ends the role's current holders and starts the new one at one effective date, now or earlier, never later
//   (F61: People's rule completes a separation's return task when the end is written), through
//   AssetServices.replace#AssetPartyAssignment, which checks nothing itself (F18).
// - An equipment move also needs Warehouse's stock movement permission (STOCK_MOVE) and both facilities in the user's facility
//   scope (FacilityScope.js). AssetServices.move#Asset makes a new asset for a move to another facility (a stock rule), so the
//   move writes the asset's facility and location directly, both audit-logged, after the checks.
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const maintenanceAccess = ec.resource.script("component://mr-mantle/service/mantle/work/MaintenanceAccess.js")
const facilityScope = ec.resource.script("component://mr-mantle/service/mantle/facility/FacilityScope.js")
const {find, one, denied, call, ms} = lib

const ASSET = "mantle.product.asset.Asset"
const FACILITY = "mantle.facility.Facility"
const METER = "mantle.product.maintenance.AssetMeter"
const PRODUCT_METER = "mantle.product.maintenance.ProductMeter"
const ASSIGNMENT = "mantle.product.asset.AssetPartyAssignment"
const REGISTRATION = "mantle.product.maintenance.AssetRegistration"
const FEATURE = "mantle.facility.FacilityFeature"
// stock, counted by quantity; every other asset type is equipment here
const stockTypes = ["AstTpInventory", "AstTpSupplies"]
// equipment that has left
const leftStatuses = ["AstDelivered", "AstDeactivated"]
// the reading reasons that may lower a cumulative meter, and need a reason
const lowering = ["AmrReset", "AmrCorrection"]
// a facility tree deeper than this is taken to be a cycle
const facilityDepth = 12
// how many facilities a tree or a scope reads at most
const facilityLimit = 1000
// the days before the end of a supplier warranty when it is expiring
const warrantyNoticeDays = 30
const dayMs = 24 * 60 * 60 * 1000

const blank = value => value == null || String(value).trim() === ""
const text = value => (blank(value) ? null : String(value).trim())
const factory = () => ec.entity.conditionFactory
const like = (field, term) =>
    factory()
        .makeCondition(field, "like", "%" + String(term).replace(/[\\%_]/g, c => "\\" + c) + "%")
        .ignoreCase()
const anyOf = conditions => factory().makeCondition(conditions, "or")
const today = () => ec.l10n.format(ec.user.nowTimestamp, "yyyy-MM-dd")
const dayText = value => (value == null || value === "" ? "" : lib.calendarDateText(value))
const enumText = enumId => (enumId ? one("moqui.basic.Enumeration", {enumId})?.description || enumId : "")
const statusText = statusId => (statusId ? one("moqui.basic.StatusItem", {statusId})?.description || statusId : "")
const flag = value => value === true || value === "true" || value === "Y"

// ===== scope =====
// The caller's maintenance scope with a capability required (PERMISSION_DENIED without it).
function scopeWith(capability) {
    if (!ec.user.userId) denied("PERMISSION_DENIED", "Sign in to use maintenance records")
    const userScope = maintenanceAccess.scope()
    maintenanceAccess.requireCapability(userScope, capability)
    return userScope
}
// The scope of a list (impl-maintenance F83, People's rule): a holder of every organization who has chosen an active organization
// lists that organization's records; anyone else's scope is as it is, and a record check still admits every organization. A list
// anchored on a record (anchored: the facility's equipment, a facility's children, the facility itself) is read in the record
// check's scope, so a record the holder opens in another organization shows what is in it.
function listScope(userScope, anchored = false) {
    if (anchored || userScope.organizationPartyIds != null) return userScope
    const info = ec.service.sync().name("mantle.party.PartyServices.get#PartyOrganizationInfo").disableAuthz().call() || {}
    const activeId = info.activeOrgId || null
    if (!activeId || !internalOrganizationIds().includes(activeId)) return userScope
    return Object.assign({}, userScope, {organizationPartyIds: [activeId]})
}
// The internal organizations (an asset owned by one of them belongs to it, wherever it is held).
function internalOrganizationIds() {
    return Array.from(find("mantle.party.PartyRole", {roleTypeId: "OrgInternal"}).selectField("partyId").list()).map(r => r.partyId)
}
// The facilities of the organizations: those they own and, below them, those that name no owner of their own (which take their
// nearest owning ancestor's organization), down to facilityDepth levels.
function facilityIdsOf(organizationPartyIds) {
    if (!organizationPartyIds.length) return []
    const ids = new Set(
        Array.from(
            find(FACILITY).condition("ownerPartyId", "in", organizationPartyIds).selectField("facilityId").limit(facilityLimit).list()
        ).map(row => row.facilityId)
    )
    let frontier = Array.from(ids)
    for (let depth = 0; frontier.length && depth < facilityDepth && ids.size < facilityLimit; depth++) {
        const children = Array.from(
            find(FACILITY)
                .condition("parentFacilityId", "in", frontier)
                .condition("ownerPartyId", "is-null", null)
                .selectField("facilityId")
                .limit(facilityLimit)
                .list()
        )
            .map(row => row.facilityId)
            .filter(id => !ids.has(id))
        for (const id of children) ids.add(id)
        frontier = children
    }
    return Array.from(ids)
}
// A facility and the facilities inside it (to facilityDepth levels), each as far as the read allows (ids, null for every one).
function subtreeIds(facilityId, allowed) {
    const ids = new Set([facilityId])
    let frontier = [facilityId]
    for (let depth = 0; frontier.length && depth < facilityDepth && ids.size < facilityLimit; depth++) {
        const children = Array.from(
            find(FACILITY).condition("parentFacilityId", "in", frontier).selectField("facilityId").limit(facilityLimit).list()
        )
            .map(row => row.facilityId)
            .filter(id => !ids.has(id) && (allowed == null || allowed.has(id)))
        for (const id of children) ids.add(id)
        frontier = children
    }
    return Array.from(ids)
}
// The facilities the scope reads (a Set), or null for every facility.
function scopedFacilities(userScope) {
    return userScope.organizationPartyIds == null ? null : new Set(facilityIdsOf(Array.from(userScope.organizationPartyIds)))
}
// A facility's time zone: its own, else its nearest ancestor's; null when none in its ancestry has one.
function facilityTimeZone(facilityId) {
    const seen = new Set()
    let id = facilityId
    for (let depth = 0; id && !seen.has(id) && depth < facilityDepth; depth++) {
        seen.add(id)
        const facility = one(FACILITY, {facilityId: id})
        if (!facility) return null
        if (facility.timeZone) return {timeZone: facility.timeZone, inherited: id !== facilityId, fromFacilityId: id}
        id = facility.parentFacilityId
    }
    return null
}
// The equipment of a scope, as a find: not stock and, unless every organization, owned by one of the organizations or held at
// one of their facilities when its owner is no internal organization (a customer's equipment in their custody).
function equipmentFind(userScope, facilities) {
    let query = find(ASSET)
        .condition("assetTypeEnumId", "is-not-null", null)
        .condition("assetTypeEnumId", "not-in", stockTypes)
    if (userScope.organizationPartyIds == null) return query
    const organizationPartyIds = Array.from(userScope.organizationPartyIds)
    if (!organizationPartyIds.length) return query.condition("assetId", "_NA_")
    const alternatives = [factory().makeCondition("ownerPartyId", "in", organizationPartyIds)]
    const held = Array.from(facilities || [])
    if (held.length)
        alternatives.push(
            factory().makeCondition(
                [
                    factory().makeCondition("facilityId", "in", held),
                    anyOf([
                        factory().makeCondition("ownerPartyId", "is-null", null),
                        factory().makeCondition("ownerPartyId", "not-in", internalOrganizationIds())
                    ])
                ],
                "and"
            )
        )
    return query.condition(anyOf(alternatives))
}
// The asset, locked when asked, in the caller's scope; a missing asset, stock and one outside the scope are refused alike.
function equipmentOf(userScope, assetId, lock = false) {
    maintenanceAccess.requireAsset(userScope, assetId)
    let query = find(ASSET, {assetId})
    if (lock) query = query.forUpdate(true)
    const asset = query.one()
    if (!asset || !asset.assetTypeEnumId || stockTypes.includes(asset.assetTypeEnumId))
        denied("RECORD_UNAVAILABLE", "Equipment " + (assetId || "") + " is not available")
    return asset
}
function requireRevision(row, expectedRevision) {
    if (blank(expectedRevision)) return
    const current = String(ms(row.lastUpdatedStamp))
    if (String(ms(expectedRevision)) !== current && String(expectedRevision) !== current)
        denied("RECORD_CHANGED", "This record was changed since it was read; its revision is now " + current)
}

// ===== find#MaintenanceEquipment =====
// The equipment of the caller's scope, found in the query before paging: by id, name, serial, soft identifier or registration
// number, product, class, type, status, facility (with those inside it), custodian, and supplier warranty (expiring within
// warrantyNoticeDays, or expired). Each row carries its names and texts, its custodian and its warranty state; no cost or book
// value.
function findEquipment(p) {
    const userScope = listScope(scopeWith("resourceRead"), !blank(p.facilityId))
    const facilities = scopedFacilities(userScope)
    const build = () => {
        let query = equipmentFind(userScope, facilities)
        if (!flag(p.includeLeft))
            query = query.condition(
                anyOf([
                    factory().makeCondition("statusId", "is-null", null),
                    factory().makeCondition("statusId", "not-in", leftStatuses)
                ])
            )
        if (!blank(p.text)) {
            const alternatives = ["assetId", "assetName", "serialNumber", "softIdentifier"].map(field => like(field, p.text))
            const registered = Array.from(
                find(REGISTRATION)
                    .condition(anyOf([like("registrationNumber", p.text), like("licenseNumber", p.text)]))
                    .selectField("assetId")
                    .limit(100)
                    .list()
            ).map(row => row.assetId)
            if (registered.length) alternatives.push(factory().makeCondition("assetId", "in", registered))
            query = query.condition(anyOf(alternatives))
        }
        for (const field of ["productId", "classEnumId", "assetTypeEnumId", "statusId", "parentAssetId"])
            if (!blank(p[field])) query = query.condition(field, p[field])
        if (!blank(p.facilityId)) query = query.condition("facilityId", "in", subtreeIds(p.facilityId, facilities))
        if (!blank(p.custodianPartyId)) {
            const held = Array.from(
                find(ASSIGNMENT, {partyId: p.custodianPartyId})
                    .conditionDate("fromDate", "thruDate", ec.user.nowTimestamp)
                    .selectField("assetId")
                    .limit(500)
                    .list()
            ).map(row => row.assetId)
            query = query.condition("assetId", "in", held.length ? held : ["_NA_"])
        }
        if (p.warranty === "expiring")
            query = query
                .condition("warrantyThruDate", "greater-equals", today())
                .condition("warrantyThruDate", "less-equals", ec.l10n.format(new Date(ms(ec.user.nowTimestamp) + warrantyNoticeDays * dayMs), "yyyy-MM-dd"))
        else if (p.warranty === "expired") query = query.condition("warrantyThruDate", "less", today())
        return query.orderBy("assetName").orderBy("assetId")
    }
    const paged = lib.page(build(), p, "equipmentList", build().count())
    return {
        equipmentList: equipmentRows(userScope, paged.rows, facilities),
        equipmentListCount: paged.recordCount,
        equipmentListPageIndex: paged.pageIndex,
        equipmentListPageSize: paged.pageSize,
        equipmentListPageMaxIndex: paged.pageMaxIndex,
        equipmentListPageRangeLow: paged.pageRangeLow,
        equipmentListPageRangeHigh: paged.pageRangeHigh
    }
}
// Rows of equipment for a list, their names read in one query each.
function equipmentRows(userScope, assets, facilities) {
    if (!assets.length) return []
    const assetIds = assets.map(asset => asset.assetId)
    const custody = Array.from(
        find(ASSIGNMENT).condition("assetId", "in", assetIds).conditionDate("fromDate", "thruDate", ec.user.nowTimestamp).list()
    )
    const names = lib.partyNames(
        assets.flatMap(asset => [asset.ownerPartyId, asset.warrantyPartyId]).concat(custody.map(row => row.partyId))
    )
    const productIds = [...new Set(assets.map(asset => asset.productId).filter(Boolean))]
    const products = productIds.length
        ? Object.fromEntries(
              Array.from(find("mantle.product.Product").condition("productId", "in", productIds).list()).map(row => [
                  row.productId,
                  row.productName || row.productId
              ])
          )
        : {}
    const facilityIds = [...new Set(assets.map(asset => asset.facilityId).filter(Boolean))]
    const facilityNames = facilityIds.length
        ? Object.fromEntries(
              Array.from(find(FACILITY).condition("facilityId", "in", facilityIds).list()).map(row => [
                  row.facilityId,
                  row.facilityName || row.facilityId
              ])
          )
        : {}
    const day = today()
    const notice = ec.l10n.format(new Date(ms(ec.user.nowTimestamp) + warrantyNoticeDays * dayMs), "yyyy-MM-dd")
    return assets.map(asset => {
        const holders = custody.filter(row => row.assetId === asset.assetId)
        const holder = holders.find(row => row.roleTypeId === "Custodian") || holders[0] || null
        const warrantyThru = dayText(asset.warrantyThruDate)
        const warrantyState = !warrantyThru ? "" : warrantyThru < day ? "expired" : warrantyThru <= notice ? "expiring" : "current"
        // a facility outside the scope (a customer's site) is not named
        const facilityShown = asset.facilityId && (facilities == null || facilities.has(asset.facilityId))
        return {
            assetId: asset.assetId,
            assetName: asset.assetName || asset.assetId,
            serialNumber: asset.serialNumber || "",
            productId: asset.productId || null,
            productName: asset.productId ? products[asset.productId] || asset.productId : "",
            typeText: enumText(asset.assetTypeEnumId),
            classText: enumText(asset.classEnumId),
            parentAssetId: asset.parentAssetId || null,
            ownerPartyId: asset.ownerPartyId || null,
            ownerName: asset.ownerPartyId ? names[asset.ownerPartyId] || asset.ownerPartyId : "",
            organizationPartyId: maintenanceAccess.assetOrganization(asset.assetId),
            facilityId: facilityShown ? asset.facilityId : null,
            facilityName: facilityShown ? facilityNames[asset.facilityId] || asset.facilityId : "",
            locationSeqId: facilityShown ? asset.locationSeqId || "" : "",
            custodianPartyId: holder?.partyId || null,
            custodianName: holder ? names[holder.partyId] || holder.partyId : "",
            statusId: asset.statusId || null,
            statusText: statusText(asset.statusId),
            warrantyThruDate: warrantyThru,
            warrantyPartyName: asset.warrantyPartyId ? names[asset.warrantyPartyId] || asset.warrantyPartyId : "",
            warrantyState,
            warrantyText:
                warrantyState === "expired"
                    ? "Expired " + warrantyThru
                    : warrantyState === "expiring"
                      ? "Ends " + warrantyThru
                      : warrantyThru
                        ? "Through " + warrantyThru
                        : "",
            warrantyColor: warrantyState === "expired" ? "negative" : warrantyState === "expiring" ? "warning" : "grey-8",
            lastUpdatedStamp: asset.lastUpdatedStamp
        }
    })
}

// ===== find#MaintenanceFacilities =====
// The facilities of the caller's scope (each in its organization's scope by its owner or nearest owning ancestor), found in the
// query before paging by name or id, type, owning organization, parent, bookable, capacity and a current room feature; closed
// ones only when asked. With roots, the top of the tree: the facilities whose parent is none or outside the scope, each such
// parent shown once as an unnamed node (hiddenAncestor, its key hidden-<n>) with the facilities under it, so a name or id the
// caller may not see is not given. With parentFacilityId, a level of the tree (hidden-<n> names an unnamed node's). With
// facilityId, that facility alone (a record's header).
function findFacilities(p) {
    const anchored = !blank(p.facilityId) || (!blank(p.parentFacilityId) && !String(p.parentFacilityId).startsWith("hidden-"))
    const userScope = listScope(scopeWith("resourceRead"), anchored)
    const facilities = scopedFacilities(userScope)
    const scoped = query => (facilities == null ? query : query.condition("facilityId", "in", facilities.size ? Array.from(facilities) : ["_NA_"]))
    let hiddenRows = []
    const filtered = () => {
        let query = scoped(find(FACILITY))
        if (!blank(p.facilityId)) query = query.condition("facilityId", p.facilityId)
        if (!blank(p.text)) query = query.condition(anyOf([like("facilityId", p.text), like("facilityName", p.text)]))
        if (!blank(p.facilityTypeEnumId)) query = query.condition("facilityTypeEnumId", p.facilityTypeEnumId)
        if (flag(p.bookable)) query = query.condition("bookable", "Y")
        if (!blank(p.minCapacity)) query = query.condition("capacity", "greater-equals", toDecimal(p.minCapacity))
        if (!blank(p.organizationPartyId)) {
            maintenanceAccess.requireOrganization(userScope, p.organizationPartyId)
            const owned = facilityIdsOf([p.organizationPartyId])
            query = query.condition("facilityId", "in", owned.length ? owned : ["_NA_"])
        }
        if (!blank(p.featureEnumId)) {
            const featured = Array.from(
                find(FEATURE, {featureEnumId: p.featureEnumId})
                    .conditionDate("fromDate", "thruDate", ec.user.nowTimestamp)
                    .selectField("facilityId")
                    .limit(facilityLimit)
                    .list()
            ).map(row => row.facilityId)
            query = query.condition("facilityId", "in", featured.length ? featured : ["_NA_"])
        }
        if (!flag(p.includeClosed))
            query = query.condition(
                anyOf([
                    factory().makeCondition("closedDate", "is-null", null),
                    factory().makeCondition("closedDate", "greater", ec.user.nowTimestamp)
                ])
            )
        return query
    }
    const hiddenParents = () => {
        // the parents outside the scope of the scope's facilities, in id order, numbered from 1
        if (facilities == null) return []
        const parents = new Set()
        for (const row of Array.from(scoped(find(FACILITY)).condition("parentFacilityId", "is-not-null", null).selectField(["parentFacilityId"]).list()))
            if (!facilities.has(row.parentFacilityId)) parents.add(row.parentFacilityId)
        return Array.from(parents).sort()
    }
    let build = () => filtered().orderBy("facilityName").orderBy("facilityId")
    const hidden = hiddenParents()
    const levelOf = parentFacilityId => build().condition("parentFacilityId", parentFacilityId)
    if (!blank(p.parentFacilityId) && String(p.parentFacilityId).startsWith("hidden-")) {
        const parentId = hidden[Number(String(p.parentFacilityId).slice(7)) - 1] || "_NA_"
        build = () => filtered().condition("parentFacilityId", parentId).orderBy("facilityName").orderBy("facilityId")
    } else if (!blank(p.parentFacilityId)) {
        build = () => filtered().condition("parentFacilityId", p.parentFacilityId).orderBy("facilityName").orderBy("facilityId")
    } else if (flag(p.roots)) {
        const tops = [factory().makeCondition("parentFacilityId", "is-null", null)]
        if (hidden.length) tops.push(factory().makeCondition("parentFacilityId", "in", hidden))
        build = () => filtered().condition(anyOf(tops)).orderBy("facilityName").orderBy("facilityId")
    }
    const paged = lib.page(build(), p, "facilityList", build().count())
    const rows = facilityRows(userScope, paged.rows, facilities, hidden)
    // above a page that is not one level or one facility, one unnamed node for each parent outside the scope that holds a
    // facility of the page
    if (blank(p.parentFacilityId) && blank(p.facilityId)) {
        const keys = [...new Set(rows.filter(row => row.hiddenParent && row.parentFacilityId).map(row => row.parentFacilityId))]
        hiddenRows = keys.map(key => ({
            facilityId: key,
            facilityName: "",
            label: "A facility you do not have access to",
            hiddenAncestor: true,
            parentFacilityId: null,
            childCount: levelOf(hidden[Number(key.slice(7)) - 1]).count()
        }))
    }
    return {
        facilityList: hiddenRows.concat(rows),
        facilityListCount: paged.recordCount,
        facilityListPageIndex: paged.pageIndex,
        facilityListPageSize: paged.pageSize,
        facilityListPageMaxIndex: paged.pageMaxIndex,
        facilityListPageRangeLow: paged.pageRangeLow,
        facilityListPageRangeHigh: paged.pageRangeHigh
    }
}
// Rows of facilities for a list or a tree: the parent named only when the caller reads it (else the unnamed node's key), the
// organization by the owner or nearest owning ancestor, the time zone with whether it is inherited, the open state, the children
// and equipment counts and the current room features.
function facilityRows(userScope, list, facilities, hidden) {
    if (!list.length) return []
    const ids = list.map(row => row.facilityId)
    const parentIds = [...new Set(list.map(row => row.parentFacilityId).filter(Boolean))]
    const parents = parentIds.length
        ? Object.fromEntries(Array.from(find(FACILITY).condition("facilityId", "in", parentIds).list()).map(row => [row.facilityId, row]))
        : {}
    const organizations = Object.fromEntries(list.map(row => [row.facilityId, maintenanceAccess.facilityOrganization(row.facilityId)]))
    const names = lib.partyNames(Object.values(organizations))
    const features = Array.from(
        find(FEATURE).condition("facilityId", "in", ids).conditionDate("fromDate", "thruDate", ec.user.nowTimestamp).list()
    )
    const now = ms(ec.user.nowTimestamp)
    return list.map(facility => {
        const parentShown = facility.parentFacilityId && (facilities == null || facilities.has(facility.parentFacilityId))
        const hiddenIndex = facility.parentFacilityId && !parentShown ? hidden.indexOf(facility.parentFacilityId) : -1
        const zone = facilityTimeZone(facility.facilityId)
        const closed = facility.closedDate != null && ms(facility.closedDate) <= now
        const organizationPartyId = organizations[facility.facilityId]
        const childQuery = find(FACILITY, {parentFacilityId: facility.facilityId})
        return {
            facilityId: facility.facilityId,
            facilityName: facility.facilityName || facility.facilityId,
            facilityTypeEnumId: facility.facilityTypeEnumId || null,
            typeText: enumText(facility.facilityTypeEnumId),
            parentFacilityId: parentShown ? facility.parentFacilityId : hiddenIndex >= 0 ? "hidden-" + (hiddenIndex + 1) : null,
            parentName: parentShown ? parents[facility.parentFacilityId]?.facilityName || facility.parentFacilityId : "",
            hiddenParent: !!facility.parentFacilityId && !parentShown,
            ownerPartyId: facility.ownerPartyId || null,
            organizationPartyId,
            organizationName: organizationPartyId ? names[organizationPartyId] || organizationPartyId : "",
            bookable: facility.bookable === "Y",
            bookableText: facility.bookable === "Y" ? "Bookable" : "",
            capacity: facility.capacity,
            capacityUomId: facility.capacityUomId || null,
            timeZone: zone?.timeZone || null,
            timeZoneText: zone ? zone.timeZone + (zone.inherited ? " (inherited)" : "") : "",
            closed,
            stateText: closed ? "Closed" : "Open",
            stateColor: closed ? "grey-8" : "positive",
            childCount: facilities == null ? childQuery.count() : Array.from(childQuery.selectField("facilityId").list()).filter(row => facilities.has(row.facilityId)).length,
            equipmentCount: find(ASSET, {facilityId: facility.facilityId})
                .condition("assetTypeEnumId", "is-not-null", null)
                .condition("assetTypeEnumId", "not-in", stockTypes)
                .count(),
            featuresText: features
                .filter(row => row.facilityId === facility.facilityId)
                .map(row => enumText(row.featureEnumId))
                .join(", "),
            hiddenAncestor: false,
            label: facility.facilityName || facility.facilityId
        }
    })
}

// ===== store#MaintenanceEquipment =====
// Register equipment (no assetId) or change one of the caller's (MAINTENANCE_RESOURCE_EDIT). A new piece names an internal
// organization of the scope as its owner and is registered through EquipmentServices.create#Equipment (type AstTpEquipment
// unless another equipment type is given, status in use, no quantity); a change goes through AssetServices.update#Asset with
// only the identity, name, comments, parent, class and supplier warranty given. A facility, parent or warrantor is checked:
// the facility and the parent in the scope, the parent never the equipment or one under it (PARENT_CYCLE), the warranty's end
// a date. expectedRevision (the lastUpdatedStamp read) refuses a change since (RECORD_CHANGED).
const identityFields = ["assetName", "comments", "serialNumber", "softIdentifier", "classEnumId", "warrantyThruDate", "warrantyPartyId"]
function storeEquipment(p) {
    const userScope = scopeWith("resourceEdit")
    const existing = blank(p.assetId) ? null : equipmentOf(userScope, p.assetId, true)
    if (existing) requireRevision(existing, p.expectedRevision)
    const has = name => Object.prototype.hasOwnProperty.call(p, name) && p[name] !== undefined
    const values = {}
    for (const name of identityFields) if (has(name)) values[name] = blank(p[name]) ? null : p[name]
    if (has("assetName") && blank(p.assetName)) denied("NAME_REQUIRED", "Give the equipment a name")
    if (!blank(p.classEnumId)) enumOf(p.classEnumId, "AssetClass", "asset class")
    if (!blank(p.warrantyPartyId) && !one("mantle.party.Party", {partyId: p.warrantyPartyId}))
        denied("VALUE_INVALID", "Choose a valid warrantor")
    if (has("parentAssetId")) {
        values.parentAssetId = blank(p.parentAssetId) ? null : p.parentAssetId
        if (values.parentAssetId) {
            equipmentOf(userScope, values.parentAssetId)
            const seen = new Set()
            for (let at = one(ASSET, {assetId: values.parentAssetId}); at; at = at.parentAssetId ? one(ASSET, {assetId: at.parentAssetId}) : null) {
                if ((existing && at.assetId === existing.assetId) || seen.has(at.assetId))
                    denied("PARENT_CYCLE", "Equipment " + values.parentAssetId + " is part of this equipment, so it cannot be its parent")
                seen.add(at.assetId)
            }
        }
    }
    if (existing) {
        call("mantle.product.AssetServices.update#Asset", Object.assign({assetId: existing.assetId}, values))
        return {assetId: existing.assetId, created: false}
    }
    if (blank(p.assetName)) denied("NAME_REQUIRED", "Give the equipment a name")
    const ownerPartyId = text(p.ownerPartyId) || userScope.activeOrganizationPartyId
    if (!ownerPartyId || !internalOrganizationIds().includes(ownerPartyId) || !maintenanceAccess.covers(userScope, ownerPartyId))
        denied("OWNER_UNAVAILABLE", "Organization " + (ownerPartyId || "") + " is not available")
    const assetTypeEnumId = text(p.assetTypeEnumId) || "AstTpEquipment"
    if (stockTypes.includes(assetTypeEnumId)) denied("TYPE_INVALID", "Equipment is not stock")
    enumOf(assetTypeEnumId, "AssetType", "asset type")
    if (!blank(p.facilityId)) maintenanceAccess.requireFacility(userScope, p.facilityId)
    if (!blank(p.productId) && !one("mantle.product.Product", {productId: p.productId})) denied("VALUE_INVALID", "Choose a valid product")
    const created = call(
        "mantle.product.EquipmentServices.create#Equipment",
        Object.assign({}, values, {
            assetTypeEnumId,
            statusId: "AstInUse",
            ownerPartyId,
            hasQuantity: "N",
            productId: text(p.productId),
            facilityId: text(p.facilityId),
            acquiredDate: blank(p.acquiredDate) ? null : p.acquiredDate,
            receivedDate: blank(p.receivedDate) ? null : p.receivedDate
        })
    )
    return {assetId: created.assetId, created: true}
}
function enumOf(enumId, enumTypeId, label) {
    const row = one("moqui.basic.Enumeration", {enumId})
    const typeIds = [enumTypeId]
    if (!row || !typeIds.includes(row.enumTypeId)) denied("VALUE_INVALID", "Choose a valid " + label)
    return row
}

// ===== record#MaintenanceMeter =====
// A meter reading of one of the caller's pieces of equipment: MAINTENANCE_RESOURCE_EDIT, or MAINTENANCE_EXECUTE with the work
// (workEffortId) assigned to the caller. The meter is one of the equipment model's (ProductMeter) or, for equipment with no model
// meter, a meter type; its unit is the model's (a different unit given is UNIT_MISMATCH). The reading time is now or earlier
// (DATE_FUTURE) and no other reading of the equipment has it (READING_EXISTS: AssetMeter's key is the asset and the time). On a
// cumulative meter a reading below the one before it, or above the one after it, is refused (READING_DECREASING) unless it is a
// reset; a correction changes a reading already taken (correctReadingDate). A reset and a correction need a reason
// (REASON_REQUIRED), which the audit log keeps with the value.
function recordMeter(p) {
    if (!ec.user.userId) denied("PERMISSION_DENIED", "Sign in to record a reading")
    const userScope = maintenanceAccess.scope()
    const inWork = !blank(p.workEffortId)
    if (!userScope.capabilities.resourceEdit) {
        if (!inWork || !userScope.capabilities.execute) denied("PERMISSION_DENIED", "Maintenance resource edit is required")
        maintenanceAccess.requireWork(userScope, p.workEffortId)
        if (!maintenanceAccess.assignment(userScope, p.workEffortId).step)
            denied("NOT_ASSIGNED", "Work " + p.workEffortId + " is not assigned to you")
    }
    const asset = equipmentOf(userScope, p.assetId, true)
    const meter = meterOf(asset, p)
    if (!blank(p.meterUomId) && meter.meterUomId && p.meterUomId !== meter.meterUomId)
        denied("UNIT_MISMATCH", "This meter reads in " + meter.meterUomId)
    let value
    try {
        value = toDecimal(p.meterValue)
    } catch (_) {
        value = null
    }
    if (value == null) denied("VALUE_INVALID", "Enter the reading")
    const reasonEnumId = text(p.readingReasonEnumId) || (inWork ? "AmrWork" : "AmrReading")
    enumOf(reasonEnumId, "AssetMeterReadingReason", "reading reason")
    const changeReason = text(p.changeReason)
    if (lowering.includes(reasonEnumId) && !changeReason) denied("REASON_REQUIRED", "Give the reason for the reset or correction")
    if (meter.isCumulative && value.compare(0) < 0) denied("VALUE_INVALID", "A counting meter does not read below zero")
    const sameMeter = query =>
        meter.productMeterId
            ? query.condition("productMeterId", meter.productMeterId)
            : query.condition("productMeterTypeId", meter.productMeterTypeId)

    // a correction of a reading already taken
    if (!blank(p.correctReadingDate)) {
        if (reasonEnumId !== "AmrCorrection") denied("VALUE_INVALID", "A change of a reading is a correction")
        const old = find(METER, {assetId: asset.assetId, readingDate: p.correctReadingDate}).forUpdate(true).one()
        if (!old || (old.productMeterTypeId || null) !== meter.productMeterTypeId)
            denied("RECORD_UNAVAILABLE", "That reading is not available")
        call("update#" + METER, {
            assetId: asset.assetId,
            readingDate: old.readingDate,
            meterValue: value,
            meterValue_changeReason: changeReason,
            readingReasonEnumId: reasonEnumId
        })
        return {assetId: asset.assetId, readingDate: old.readingDate, corrected: true}
    }
    if (reasonEnumId === "AmrCorrection") denied("VALUE_INVALID", "Name the reading the correction changes")

    const readingDate = blank(p.readingDate) ? ec.user.nowTimestamp : p.readingDate
    if (ms(readingDate) > ms(ec.user.nowTimestamp) + 60 * 1000) denied("DATE_FUTURE", "A reading is taken now or earlier")
    if (one(METER, {assetId: asset.assetId, readingDate}))
        denied("READING_EXISTS", "A reading of this equipment is already recorded at that time")
    if (meter.isCumulative && reasonEnumId !== "AmrReset") {
        const before = sameMeter(find(METER, {assetId: asset.assetId}))
            .condition("readingDate", "less", readingDate)
            .orderBy("-readingDate")
            .limit(1)
            .one()
        if (before?.meterValue != null && value.compare(before.meterValue) < 0)
            denied("READING_DECREASING", "The reading is below the one before it (" + String(before.meterValue) + "); record a reset or a correction")
        const after = sameMeter(find(METER, {assetId: asset.assetId}))
            .condition("readingDate", "greater", readingDate)
            .orderBy("readingDate")
            .limit(1)
            .one()
        if (after?.meterValue != null && after.readingReasonEnumId !== "AmrReset" && value.compare(after.meterValue) > 0)
            denied("READING_DECREASING", "The reading is above the one after it (" + String(after.meterValue) + ")")
    }
    call("create#" + METER, {
        meterValue_changeReason: changeReason,
        assetId: asset.assetId,
        readingDate,
        productMeterTypeId: meter.productMeterTypeId,
        productMeterId: meter.productMeterId,
        meterValue: value,
        readingReasonEnumId: reasonEnumId,
        workEffortId: text(p.workEffortId),
        assetMaintenanceId: text(p.assetMaintenanceId)
    })
    return {assetId: asset.assetId, readingDate, corrected: false}
}
// The meter of a reading: the model's meter (productMeterId, or the model's meter of the type given), else a meter type for
// equipment whose model has none.
function meterOf(asset, p) {
    const modelMeters = asset.productId ? Array.from(find(PRODUCT_METER, {productId: asset.productId}).list()) : []
    let meter = null
    if (!blank(p.productMeterId)) meter = modelMeters.find(row => row.productMeterId === p.productMeterId) || null
    else if (!blank(p.productMeterTypeId)) meter = modelMeters.find(row => row.productMeterTypeId === p.productMeterTypeId) || null
    if (meter)
        return {
            productMeterId: meter.productMeterId,
            productMeterTypeId: meter.productMeterTypeId,
            meterUomId: meter.meterUomId || one("mantle.product.maintenance.ProductMeterType", {productMeterTypeId: meter.productMeterTypeId})?.defaultUomId || null,
            isCumulative: meter.isCumulative === "Y"
        }
    if (modelMeters.length || blank(p.productMeterTypeId)) denied("METER_UNAVAILABLE", "Choose one of this equipment's meters")
    const type = one("mantle.product.maintenance.ProductMeterType", {productMeterTypeId: p.productMeterTypeId})
    if (!type) denied("METER_UNAVAILABLE", "Choose one of this equipment's meters")
    return {productMeterId: null, productMeterTypeId: type.productMeterTypeId, meterUomId: type.defaultUomId || null, isCumulative: false}
}

// ===== store#MaintenanceRegistration =====
// A registration of one of the caller's pieces of equipment (MAINTENANCE_RESOURCE_EDIT): a new one, or a change to one
// (assetRegSeqId). Needs a registration or license number; through is not before from (DATES_INVALID); an agency is a party.
function storeRegistration(p) {
    const userScope = scopeWith("resourceEdit")
    const asset = equipmentOf(userScope, p.assetId, true)
    const existing = blank(p.assetRegSeqId) ? null : one(REGISTRATION, {assetId: asset.assetId, assetRegSeqId: p.assetRegSeqId})
    if (!blank(p.assetRegSeqId) && !existing) denied("RECORD_UNAVAILABLE", "That registration is not available")
    const values = {}
    for (const name of ["fromDate", "thruDate", "registrationDate", "govAgencyPartyId", "registrationNumber", "licenseNumber"])
        if (p[name] !== undefined) values[name] = blank(p[name]) ? null : p[name]
    const merged = Object.assign({}, existing ? lib.map(existing) : {}, values)
    if (blank(merged.registrationNumber) && blank(merged.licenseNumber))
        denied("NUMBER_REQUIRED", "Give the registration or license number")
    if (merged.fromDate != null && merged.thruDate != null && ms(merged.thruDate) < ms(merged.fromDate))
        denied("DATES_INVALID", "The registration cannot end before it starts")
    if (!blank(values.govAgencyPartyId) && !one("mantle.party.Party", {partyId: values.govAgencyPartyId}))
        denied("VALUE_INVALID", "Choose a valid agency")
    if (existing) {
        call("update#" + REGISTRATION, Object.assign({assetId: asset.assetId, assetRegSeqId: existing.assetRegSeqId}, values))
        return {assetId: asset.assetId, assetRegSeqId: existing.assetRegSeqId}
    }
    const out = call("create#" + REGISTRATION, Object.assign({assetId: asset.assetId}, values))
    return {assetId: asset.assetId, assetRegSeqId: out.assetRegSeqId}
}

// ===== change#MaintenanceCustody =====
// A new holder of a role of one of the caller's pieces of equipment (MAINTENANCE_RESOURCE_EDIT) from an effective date, now or
// earlier (DATE_FUTURE; F61) and not before a current holder's start (DATE_BEFORE_HOLDING): the current holders of the role end
// and the new one starts at that date, through AssetServices.replace#AssetPartyAssignment. The new holder is one of the scope's
// organizations, a person they employ now, or the asset's owner organization (HOLDER_UNAVAILABLE otherwise; the user's call, R7).
function changeCustody(p) {
    const userScope = scopeWith("resourceEdit")
    const asset = equipmentOf(userScope, p.assetId, true)
    const roleTypeId = text(p.roleTypeId) || "Custodian"
    if (!one("mantle.party.RoleType", {roleTypeId})) denied("VALUE_INVALID", "Choose a valid role")
    const party = blank(p.newPartyId) ? null : one("mantle.party.Party", {partyId: p.newPartyId})
    if (!party || !["PtyPerson", "PtyOrganization"].includes(party.partyTypeEnumId) || party.disabled === "Y")
        denied("PARTY_UNAVAILABLE", "Choose the person or organization who holds it")
    if (!holderAdmitted(userScope, asset, party.partyId))
        denied("HOLDER_UNAVAILABLE", "Equipment is held by one of your organizations or their current employees, or by its owner")
    const effectiveDate = blank(p.effectiveDate) ? ec.user.nowTimestamp : p.effectiveDate
    if (ms(effectiveDate) > ms(ec.user.nowTimestamp) + 60 * 1000)
        denied("DATE_FUTURE", "A custody change takes effect now or earlier; record it when the equipment changes hands")
    const current = Array.from(
        find(ASSIGNMENT, {assetId: asset.assetId, roleTypeId}).conditionDate("fromDate", "thruDate", ec.user.nowTimestamp).list()
    )
    const ending = current.filter(row => row.partyId !== party.partyId)
    for (const row of ending)
        if (ms(row.fromDate) > ms(effectiveDate))
            denied("DATE_BEFORE_HOLDING", "The current holding started " + lib.dateText(row.fromDate) + ", after that date")
    // nor inside another holder's ended holding of the role: two holders at once
    const overlapped = find(ASSIGNMENT, {assetId: asset.assetId, roleTypeId})
        .condition("partyId", "not-equals", party.partyId)
        .condition("thruDate", "greater", effectiveDate)
        .condition("thruDate", "less-equals", ec.user.nowTimestamp)
        .orderBy("-thruDate")
        .limit(1)
        .one()
    if (overlapped)
        denied("DATE_BEFORE_HOLDING", "An earlier holding ended " + lib.dateText(overlapped.thruDate) + ", after that date")
    call("mantle.product.AssetServices.replace#AssetPartyAssignment", {
        assetId: asset.assetId,
        roleTypeId,
        newPartyId: party.partyId,
        effectiveDate
    })
    return {assetId: asset.assetId, endedCount: ending.length, effectiveDate}
}

// Whether a party may hold equipment of the scope (the user's call, R7): one of the scope's internal organizations, a person
// employed now by one of them (PrtEmployee), or the asset's own owner organization (a customer's equipment in its custody).
function holderAdmitted(userScope, asset, partyId) {
    if (asset.ownerPartyId && partyId === asset.ownerPartyId) return true
    const internal = internalOrganizationIds()
    const organizations = userScope.organizationPartyIds == null ? internal : Array.from(userScope.organizationPartyIds).filter(id => internal.includes(id))
    if (!organizations.length) return false
    if (organizations.includes(partyId)) return true
    return (
        find("mantle.party.PartyRelationship", {relationshipTypeEnumId: "PrtEmployee", fromPartyId: partyId})
            .condition("toPartyId", "in", organizations)
            .conditionDate("fromDate", "thruDate", ec.user.nowTimestamp)
            .count() > 0
    )
}

// ===== move#MaintenanceEquipment =====
// One of the caller's pieces of equipment to another facility (and location) of the scope: MAINTENANCE_RESOURCE_EDIT and
// Warehouse's STOCK_MOVE, with both facilities in the caller's facility scope (RECORD_UNAVAILABLE). With preview, nothing is
// written and the answer is the effect: the facilities and organizations before and after, the time zones, the parts that stay
// where they are (child equipment) and the bookings to come. A move to a location of the facility needs an open one
// (LOCATION_UNAVAILABLE); a move to where it is is SAME_LOCATION.
function moveEquipment(p) {
    const userScope = scopeWith("resourceEdit")
    const asset = equipmentOf(userScope, p.assetId, !flag(p.preview))
    const toFacilityId = text(p.toFacilityId)
    if (!toFacilityId) denied("VALUE_INVALID", "Choose where the equipment goes")
    maintenanceAccess.requireFacility(userScope, toFacilityId)
    const toLocationSeqId = text(p.toLocationSeqId)
    if (toLocationSeqId) {
        const location = one("mantle.facility.FacilityLocation", {facilityId: toFacilityId, locationSeqId: toLocationSeqId})
        if (!location || (location.thruDate != null && ms(location.thruDate) <= ms(ec.user.nowTimestamp)))
            denied("LOCATION_UNAVAILABLE", "Location " + toLocationSeqId + " is not open there")
    }
    if (asset.facilityId === toFacilityId && (asset.locationSeqId || null) === toLocationSeqId)
        denied("SAME_LOCATION", "The equipment is already there")
    const fromOrganizationPartyId = maintenanceAccess.assetOrganization(asset.assetId)
    const ownerInternal = !!asset.ownerPartyId && internalOrganizationIds().includes(asset.ownerPartyId)
    const toOrganizationPartyId = ownerInternal ? asset.ownerPartyId : maintenanceAccess.facilityOrganization(toFacilityId)
    const facilityName = id => (id ? one(FACILITY, {facilityId: id})?.facilityName || id : "")
    const effect = {
        assetId: asset.assetId,
        fromFacilityId: asset.facilityId || null,
        fromFacilityName: facilityName(asset.facilityId),
        toFacilityId,
        toFacilityName: facilityName(toFacilityId),
        toLocationSeqId,
        fromOrganizationPartyId,
        toOrganizationPartyId,
        organizationChanges: fromOrganizationPartyId !== toOrganizationPartyId,
        fromTimeZone: asset.facilityId ? facilityTimeZone(asset.facilityId)?.timeZone || null : null,
        toTimeZone: facilityTimeZone(toFacilityId)?.timeZone || null,
        childCount: find(ASSET, {parentAssetId: asset.assetId}).count(),
        bookingCount: futureAssetBookings(asset.assetId)
    }
    if (flag(p.preview)) return {effect, moved: false}
    if (!lib.access.has("STOCK_MOVE")) denied("PERMISSION_DENIED", "Stock move authority is required to move equipment")
    const stockScope = facilityScope.scope()
    // each facility by its owner or nearest owning ancestor, as Warehouse's facility checks read it (R8)
    for (const id of [asset.facilityId, toFacilityId].filter(Boolean))
        if (!facilityScope.ownsFacility(stockScope, id)) denied("RECORD_UNAVAILABLE", "Facility " + id + " is not available")
    if (effect.organizationChanges)
        denied("ORGANIZATION_CHANGE", "The equipment would pass to another organization; its owner changes it first")
    // out of any container too, as move#Asset's whole move does (a container's move would carry it back, ContainerAssetLocation)
    call("update#" + ASSET, {assetId: asset.assetId, facilityId: toFacilityId, locationSeqId: toLocationSeqId, containerId: null})
    return {effect, moved: true}
}
// The bookings of a piece of equipment from now on (requested or assigned), counted; their events are not named.
function futureAssetBookings(assetId) {
    const assigned = Array.from(
        find("mantle.work.effort.WorkEffortAssetAssign", {assetId})
            .condition("statusId", "in", ["WeaaRequested", "WeaaAssigned"])
            .selectField("workEffortId")
            .limit(500)
            .list()
    ).map(row => row.workEffortId)
    return futureEvents(assigned)
}
function futureEvents(workEffortIds) {
    if (!workEffortIds.length) return 0
    const now = ec.user.nowTimestamp
    return find("mantle.work.effort.WorkEffort")
        .condition("workEffortId", "in", workEffortIds)
        .condition(
            anyOf([
                factory().makeCondition("statusId", "is-null", null),
                factory().makeCondition("statusId", "not-in", ["WeCancelled", "WeClosed"])
            ])
        )
        .condition(
            anyOf([
                factory().makeCondition("estimatedCompletionDate", "greater", now),
                factory().makeCondition(
                    [
                        factory().makeCondition("estimatedCompletionDate", "is-null", null),
                        factory().makeCondition("estimatedStartDate", "greater-equals", now)
                    ],
                    "and"
                )
            ])
        )
        .count()
}

// ===== preview#MaintenanceFacilityChange =====
// What a move of one of the caller's facilities under another parent, or its close, changes, before store#Facility makes it:
// its organization and time zone before and after (both inherited from the nearest ancestor that has one), the facilities
// inside it that go with it, the equipment there and in them, and the bookings of it and its rooms from now on (counted, never
// named). The open work orders join with P3. Nothing is written; the change itself is store#Facility's (FACILITY_EDIT).
function previewFacilityChange(p) {
    const userScope = scopeWith("resourceRead")
    maintenanceAccess.requireFacility(userScope, p.facilityId)
    const facility = one(FACILITY, {facilityId: p.facilityId})
    const newParentId = text(p.parentFacilityId)
    if (newParentId) {
        maintenanceAccess.requireFacility(userScope, newParentId)
        for (let at = one(FACILITY, {facilityId: newParentId}), depth = 0; at && depth < facilityDepth; depth++) {
            if (at.facilityId === facility.facilityId)
                denied("PARENT_CYCLE", "That facility is inside this one, so it cannot be its parent")
            at = at.parentFacilityId ? one(FACILITY, {facilityId: at.parentFacilityId}) : null
        }
    }
    const inside = subtreeIds(facility.facilityId, null)
    const organizationAfter = facility.ownerPartyId || (newParentId ? maintenanceAccess.facilityOrganization(newParentId) : maintenanceAccess.facilityOrganization(facility.facilityId))
    const zoneBefore = facilityTimeZone(facility.facilityId)
    const zoneAfter = facility.timeZone
        ? {timeZone: facility.timeZone, inherited: false}
        : newParentId
          ? facilityTimeZone(newParentId)
          : zoneBefore
    const booked = Array.from(
        find("mantle.work.effort.WorkEffortFacility")
            .condition("facilityId", "in", inside)
            .condition("statusId", "in", ["WefRequested", "WefAssigned"])
            .selectField("workEffortId")
            .limit(500)
            .list()
    ).map(row => row.workEffortId)
    const names = lib.partyNames([maintenanceAccess.facilityOrganization(facility.facilityId), organizationAfter])
    const organizationBefore = maintenanceAccess.facilityOrganization(facility.facilityId)
    return {
        effect: {
            facilityId: facility.facilityId,
            organizationBefore: names[organizationBefore] || organizationBefore || "",
            organizationAfter: names[organizationAfter] || organizationAfter || "",
            organizationChanges: organizationBefore !== organizationAfter,
            timeZoneBefore: zoneBefore?.timeZone || null,
            timeZoneAfter: zoneAfter?.timeZone || null,
            insideCount: inside.length - 1,
            equipmentCount: find(ASSET)
                .condition("facilityId", "in", inside)
                .condition("assetTypeEnumId", "is-not-null", null)
                .condition("assetTypeEnumId", "not-in", stockTypes)
                .count(),
            bookingCount: futureEvents(booked),
            closing: !blank(p.closedDate)
        }
    }
}

const operations = {
    findEquipment,
    findFacilities,
    storeEquipment,
    recordMeter,
    storeRegistration,
    changeCustody,
    moveEquipment,
    previewFacilityChange
}
function run(op, p) {
    if (!Object.hasOwn(operations, op)) throw new Error("Unknown maintenance resource operation " + op)
    return operations[op](p || {})
}
;({execute: run, facilityTimeZone, facilityIdsOf, subtreeIds, stockTypes})
