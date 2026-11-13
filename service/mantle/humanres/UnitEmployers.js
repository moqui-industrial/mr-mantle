// The organization a department or team belongs to, one rule for People and Maintenance (IronStone People follow-up 3, the
// user's call of Nov 12, 2026; impl-people P3, F11; impl-maintenance's teams): the internal organization (OrgInternal) its dated
// PrtOrgRollup rows reach, as People's OrgStructure keeps units; a team with no rollup at all (one made outside People) belongs to
// its owner (Party.ownerPartyId) when that is an internal organization. A department has no such fallback. People's Organization.js
// (its tree, get#Unit and store#Membership) and Maintenance's team readers (MaintenanceDispatch.js, MaintenanceWork.js,
// MaintenancePlans.js, MaintenanceIntake.js and BOSS Maintenance.js's choices) read a team's organization here, so the two apps
// agree on it. Reads only; no access check (each caller checks its own scope first).
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const {find, one, rows, ms} = lib

const RELATIONSHIP = "mantle.party.PartyRelationship"
const ROLLUP = "PrtOrgRollup"
const kindOfRole = {OrgDepartment: "department", OrgTeam: "team", OrgInternal: "organization"}
// a parent chain longer than this is taken to be a cycle
const maxDepth = 50
// the most teams a list of an organization's teams reads
const teamCap = 2000

const openAt = (row, at) => (ms(row.fromDate) ?? -Infinity) <= at && (ms(row.thruDate) ?? Infinity) > at

// The kinds of the parties (organization, department, team) by their roles: {partyId: kind}, a party of none absent. A unit
// role wins over OrgInternal: a department is never one (F11), and a party holding both is taken as the unit.
function kindsOf(partyIds) {
    const found = {}
    if (!partyIds.length) return found
    const roles = Array.from(
        find("mantle.party.PartyRole")
            .condition("partyId", "in", partyIds)
            .condition("roleTypeId", "in", Object.keys(kindOfRole))
            .list()
    )
    for (const roleTypeId of ["OrgInternal", "OrgTeam", "OrgDepartment"])
        for (const row of roles) if (row.roleTypeId === roleTypeId) found[row.partyId] = kindOfRole[roleTypeId]
    return found
}
// The parent row nearest the date: the one in effect, else the next to start, else the last one; null when it has none.
function parentNear(partyId, at) {
    const found = rows(RELATIONSHIP, {relationshipTypeEnumId: ROLLUP, fromPartyId: partyId}).sort(
        (a, b) => (ms(a.fromDate) ?? 0) - (ms(b.fromDate) ?? 0)
    )
    return (
        found.find(row => openAt(row, at)) || found.find(row => (ms(row.fromDate) ?? 0) > at) || found[found.length - 1] || null
    )
}
// The owner of a party when it is an internal organization, else null.
function internalOwnerOf(partyId) {
    const ownerPartyId = one("mantle.party.Party", {partyId})?.ownerPartyId || null
    return ownerPartyId && kindsOf([ownerPartyId])[ownerPartyId] === "organization" ? ownerPartyId : null
}
// The employer of a party: itself when it is an internal organization, else the one its rollups reach (a unit never moves across
// employers, so any of its rollup periods gives it); for a team with no rollup at all, its internal owner. null when none.
function employerOf(partyId, at) {
    let above = partyId
    for (let depth = 0; above && depth < maxDepth; depth++) {
        const kind = kindsOf([above])[above]
        if (kind === "organization") return above
        if (!kind && depth > 0) return null
        const parent = parentNear(above, at)?.toPartyId || null
        if (!parent && depth === 0 && kind === "team") return internalOwnerOf(partyId)
        above = parent
    }
    return null
}
// The organization of each team (an OrgTeam party) on the date: {partyId: organizationPartyId}, a party that is no team, or
// reaches no organization, absent.
function teamOrganizations(partyIds, at = ms(ec.user.nowTimestamp)) {
    const found = {}
    const ids = Array.from(new Set(Array.from(partyIds || []).filter(Boolean)))
    if (!ids.length) return found
    const kinds = kindsOf(ids)
    for (const partyId of ids) {
        if (kinds[partyId] !== "team") continue
        const organizationPartyId = employerOf(partyId, at)
        if (organizationPartyId) found[partyId] = organizationPartyId
    }
    return found
}
// The teams of organizations (null: every one), by name, each {partyId, organizationName, organizationPartyId}; term narrows them
// by id or name, ignoring case. The organization is the rule's, so it is read for each team: the teams are few (at most teamCap).
function teamsOf(organizationPartyIds, term = null, at = ms(ec.user.nowTimestamp)) {
    if (organizationPartyIds != null && !organizationPartyIds.length) return []
    const teamIds = Array.from(find("mantle.party.PartyRole", {roleTypeId: "OrgTeam"}).selectField("partyId").list()).map(
        row => row.partyId
    )
    if (!teamIds.length) return []
    const factory = ec.entity.conditionFactory
    let query = find("mantle.party.PartyDetail")
        .condition("partyId", "in", teamIds)
        .selectField("partyId,organizationName")
        .orderBy("^organizationName")
        .limit(teamCap)
    if (term) {
        const like = "%" + String(term).replace(/[\\%_]/g, character => "\\" + character) + "%"
        query = query.condition(
            factory.makeCondition(
                ["partyId", "organizationName"].map(field => factory.makeCondition(field, "like", like).ignoreCase()),
                "or"
            )
        )
    }
    const teams = Array.from(query.list())
    const organizations = teamOrganizations(
        teams.map(row => row.partyId),
        at
    )
    return teams
        .filter(
            row =>
                organizations[row.partyId] &&
                (organizationPartyIds == null || Array.from(organizationPartyIds).includes(organizations[row.partyId]))
        )
        .map(row => ({
            partyId: row.partyId,
            organizationName: row.organizationName,
            organizationPartyId: organizations[row.partyId]
        }))
}

;({kindsOf, parentNear, employerOf, teamOrganizations, teamsOf})
