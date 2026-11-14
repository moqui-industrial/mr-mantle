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
// The organization a new record is for when none is named, from any app's scope ({activeOrganizationPartyId,
// organizationPartyIds: null for every organization, partyId: the user's when absent}): the active one, else the scope's only
// one, else the only one of the scope the user works for themselves (a current PrtAgent or PrtEmployee relationship; with every
// organization, an internal one); null when that leaves a choice. A user's scope holds their organization's rollup children too
// (get#PartyInternalOrgIds), so "the scope's only one" alone leaves a representative of Retail, whose scope also holds Retail's
// Returns Center, with an empty field (impl-sales F111). Sales (SalesAccess.js) and the apps' contexts read it here.
function defaultOrganization(userScope) {
    if (!userScope) return null
    if (userScope.activeOrganizationPartyId) return userScope.activeOrganizationPartyId
    const ids = userScope.organizationPartyIds == null ? null : Array.from(userScope.organizationPartyIds)
    if (ids?.length === 1) return ids[0]
    const partyId = userScope.partyId || ec.user.userAccount?.partyId
    if ((ids != null && !ids.length) || !partyId) return null
    let query = ec.entity
        .find("mantle.party.PartyRelationship")
        .condition("fromPartyId", partyId)
        .condition("relationshipTypeEnumId", "in", ["PrtAgent", "PrtEmployee"])
        .conditionDate("fromDate", "thruDate", ec.user.nowTimestamp)
        .selectField("toPartyId")
        .disableAuthz()
    if (ids != null) query = query.condition("toPartyId", "in", ids)
    const isInternal = id =>
        !!ec.entity.find("mantle.party.PartyRole").condition({partyId: id, roleTypeId: "OrgInternal"}).disableAuthz().one()
    const own = Array.from(new Set(Array.from(query.list()).map(row => row.toPartyId))).filter(
        id => ids != null || isInternal(id)
    )
    return own.length === 1 ? own[0] : null
}
;({scope, owns, facilityOrganization, ownsFacility, defaultOrganization})
