// The organizations whose facilities (and the stock in them) the current user works in, for every Mantle facility and
// stock guard: the facility and location saves (FacilitySetup.js), the warehouse policy (WarehousePolicy.js) and the
// stock guards that follow. A system administrator, or a user holding FACILITY_ALL_ORGANIZATIONS, works in every
// organization (organizationPartyIds null). Anyone else works in their own organizations (get#PartyOrganizationInfo
// userOrgIds), narrowed to the active one when it is theirs (filterOrgIds); an active organization they do not belong to,
// which Mantle lets a finance administrator choose, is set aside, and an empty list is no organization. Nothing here
// reads a request parameter; disabled artifact authorization widens nothing. A facility with no owner of its own is its nearest
// owning ancestor's (facilityOrganization, ownsFacility).
const access = ec.resource.script("component://mr-mantle/service/mantle/product/ProductAccess.js")

function scope() {
    const systemAdmin = access.systemAdmin()
    const allOrganizations = systemAdmin || access.has("FACILITY_ALL_ORGANIZATIONS")
    const info = ec.user.userId
        ? ec.service.sync().name("mantle.party.PartyServices.get#PartyOrganizationInfo").disableAuthz().call() || {}
        : {}
    const memberPartyIds = Array.from(info.userOrgIds || [])
    const filtered = Array.from(info.filterOrgIds || []).filter(partyId => memberPartyIds.includes(partyId))
    const activeOrganizationPartyId = memberPartyIds.includes(info.activeOrgId) ? info.activeOrgId : null
    return {
        systemAdmin,
        allOrganizations,
        memberPartyIds,
        activeOrganizationPartyId,
        organizationPartyIds: allOrganizations ? null : filtered.length ? filtered : memberPartyIds
    }
}
// Whether the scope covers an organization (an owner of a facility, stock or product).
function owns(userScope, partyId) {
    return !!partyId && (!userScope.organizationPartyIds || userScope.organizationPartyIds.includes(partyId))
}
// a facility tree deeper than this is taken to be a cycle
const facilityDepth = 12
// A facility's organization (the facility row or its id): its owner, else its nearest owning ancestor's (a room loaded without
// an owner of its own belongs to its building's organization, as Maintenance reads it; impl-maintenance P2, the user's call R8);
// null for a missing facility or one no ancestor owns. An owned facility is its owner's, as before.
function facilityOrganization(facility) {
    const seen = new Set()
    let row = typeof facility === "string" ? ec.entity.find("mantle.facility.Facility").condition("facilityId", facility).one() : facility
    for (let depth = 0; row && !seen.has(row.facilityId) && depth < facilityDepth; depth++) {
        if (row.ownerPartyId) return row.ownerPartyId
        seen.add(row.facilityId)
        row = row.parentFacilityId ? ec.entity.find("mantle.facility.Facility").condition("facilityId", row.parentFacilityId).one() : null
    }
    return null
}
// Whether the scope covers a facility (the row or its id) by its organization (facilityOrganization).
function ownsFacility(userScope, facility) {
    return owns(userScope, facilityOrganization(facility))
}
;({scope, owns, facilityOrganization, ownsFacility})
