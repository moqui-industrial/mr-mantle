// The organizations whose facilities (and the stock in them) the current user works in, for every Mantle facility and
// stock guard: the facility and location saves (FacilitySetup.js), the warehouse policy (WarehousePolicy.js) and the
// stock guards that follow. A system administrator, or a user holding FACILITY_ALL_ORGANIZATIONS, works in every
// organization (organizationPartyIds null). Anyone else works in their own organizations (get#PartyOrganizationInfo
// userOrgIds), narrowed to the active one when it is theirs (filterOrgIds); an active organization they do not belong to,
// which Mantle lets a finance administrator choose, is set aside, and an empty list is no organization. Nothing here
// reads a request parameter; disabled artifact authorization widens nothing.
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
;({scope, owns})
