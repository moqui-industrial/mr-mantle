// The organization scope of stock records for the current user (impl-warehouse §2), on Mantle's one facility and stock
// scope rule (mantle/facility/FacilityScope.js: the user's organizations by party relationship, narrowed to the active one
// when it is theirs, every organization for a system administrator or FACILITY_ALL_ORGANIZATIONS). An asset is in scope
// when its owner or its facility's owner is one of them; a facility when its owner is. Whether they read cost
// (ACCOUNTING_VIEW). An app narrows this further (Warehouse's facility scope); nothing here widens what an app allows.
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const facilityScope = ec.resource.script("component://mr-mantle/service/mantle/facility/FacilityScope.js")
const {one, denied} = lib
const access = lib.access

function scope() {
    if (!ec.user.userId) denied("PERMISSION_DENIED", "A signed-in user is required")
    const shared = facilityScope.scope()
    return {
        systemAdmin: shared.systemAdmin,
        organizationIds: shared.organizationPartyIds,
        financeRead: access.has("ACCOUNTING_VIEW")
    }
}
function ownerAllowed(userScope, partyId) {
    return facilityScope.owns({organizationPartyIds: userScope.organizationIds}, partyId)
}
function facilityAllowed(userScope, facility) {
    return !!facility && ownerAllowed(userScope, facility.ownerPartyId)
}
function assetAllowed(userScope, asset) {
    if (!asset) return false
    if (userScope.organizationIds == null) return true
    if (ownerAllowed(userScope, asset.ownerPartyId)) return true
    const facility = asset.facilityId ? one("mantle.facility.Facility", {facilityId: asset.facilityId}) : null
    return facilityAllowed(userScope, facility)
}
// The ids of the facilities in scope, for a query condition; null for every facility.
function facilityIds(userScope) {
    if (userScope.organizationIds == null) return null
    if (!userScope.organizationIds.length) return []
    return Array.from(
        lib
            .find("mantle.facility.Facility")
            .condition("ownerPartyId", "in", userScope.organizationIds)
            .selectField("facilityId")
            .list()
    ).map(row => row.facilityId)
}
// A permission the user must hold, refused with PERMISSION_DENIED.
function requirePermission(permission) {
    if (!access.has(permission)) denied("PERMISSION_DENIED", permission + " is required")
}

;({scope, ownerAllowed, facilityAllowed, assetAllowed, facilityIds, requirePermission})
