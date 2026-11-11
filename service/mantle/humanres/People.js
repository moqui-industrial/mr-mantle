// People's scope, Home counts and setup readiness (mantle.humanres.PeopleServices; IronStone People design §1.1, §3 Home, §12
// Settings, §16.2): who the caller may see and what they may do, read once here and checked by every People service after it.
//
// Scope is the intersection of the caller's permissions, organizations, employment and its dates, and live reporting lines:
// - capabilities come from the People permissions and the payroll ones (capabilityPermissions), never a group name; an edit
//   permission alone reads nothing;
// - a staff reader (staffReads) sees the employers among their own organizations (get#PartyOrganizationInfo's userOrgIds that
//   hold OrgInternal), only the active one when it is theirs; a holder of PEOPLE_ALL_ORGANIZATIONS (a system administrator too)
//   sees every internal organization, or the active one, which widens the scope and reads nothing by itself. PartyRelationship has no organization filter (MANTLE_USER_ORG_8 is off), so employment is checked here, and
//   Party is read with authorization off after these checks;
// - a unit is an employer or an OrgDepartment or OrgTeam organization that rolls up to one (PrtOrgRollup, walked level by
//   level here, not through filterOrgIds, which reaches one level only);
// - a manager's reports are the people of their live PrtManager relationships (from the manager to the report), for a
//   holder of PEOPLE_TEAM_VIEW;
// - a supplied party is admitted as self (the caller's own party, with PEOPLE_SELF_SERVICE), team (a live report) or staff
//   (an employment by an employer in scope, current on the date for a directory reader, any for an HR reader), and refused
//   otherwise; a supplied party never widens self scope.
// Missing and unauthorized records are refused alike (RECORD_UNAVAILABLE, ORGANIZATION_DENIED: "is not available").
//
// Later phases extend the tables (capabilityPermissions, homeCounts, readinessChecks) rather than the functions.
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const {find, rows, denied, call} = lib
const access = lib.access

const day = 24 * 60 * 60 * 1000
// the window of Home's joins and exits
const recentDays = 30
// a reporting tree deeper than this is taken to be a cycle
const unitDepth = 12
const dueWorkLimit = 20
const unitRoles = ["OrgDepartment", "OrgTeam"]

// ===== capabilities =====
const capabilityPermissions = {
    directory: "PEOPLE_DIRECTORY_VIEW",
    self: "PEOPLE_SELF_SERVICE",
    team: "PEOPLE_TEAM_VIEW",
    requestApprove: "PEOPLE_REQUEST_APPROVE",
    hrView: "PEOPLE_HR_VIEW",
    hrEdit: "PEOPLE_HR_EDIT",
    recruitView: "PEOPLE_RECRUIT_VIEW",
    recruitEdit: "PEOPLE_RECRUIT_EDIT",
    developView: "PEOPLE_DEVELOP_VIEW",
    developEdit: "PEOPLE_DEVELOP_EDIT",
    caseHandle: "PEOPLE_CASE_HANDLE",
    import: "PEOPLE_IMPORT",
    configure: "PEOPLE_CONFIGURE",
    payrollView: "PAYROLL_VIEW",
    payrollEdit: "PAYROLL_EDIT",
    payrollApprove: "PAYROLL_APPROVE",
    // the scope of a staff read in every internal organization, as COMMERCE_ALL_ORGANIZATIONS and FACILITY_ALL_ORGANIZATIONS
    allOrganizations: "PEOPLE_ALL_ORGANIZATIONS"
}
// The capabilities that read across an employer. An edit, import or approve permission alone reads nothing, nor does
// PEOPLE_ALL_ORGANIZATIONS, which only widens a read's employers.
const staffReads = ["directory", "hrView", "recruitView", "developView", "caseHandle", "configure", "payrollView"]

function capabilities() {
    const found = {}
    for (const [name, permission] of Object.entries(capabilityPermissions)) found[name] = access.has(permission)
    found.staff = staffReads.some(name => found[name])
    return found
}

// ===== scope =====
const asOfMillis = value => ec.user.timestampMillis(value || ec.user.nowTimestamp)
// a time for a find condition: a Date, which crosses as a timestamp (a number of milliseconds does not)
const stamp = millis => (millis == null ? null : new Date(Number(millis)))
const current = (query, asOf) => query.conditionDate("fromDate", "thruDate", stamp(asOf))
const unique = values => Array.from(new Set(values))
function partyIdsWithRole(partyIds, roleTypeIds) {
    if (!partyIds.length) return []
    const query = find("mantle.party.PartyRole")
        .condition("partyId", "in", partyIds)
        .condition("roleTypeId", "in", Array.isArray(roleTypeIds) ? roleTypeIds : [roleTypeIds])
        .selectField("partyId")
    return unique(Array.from(query.list()).map(row => row.partyId))
}
// The employers a staff reader sees (none when the caller reads no employer), the active one and whether they are every one.
function employers(caps, info) {
    if (!caps.staff) return {organizationPartyIds: [], activeOrganizationPartyId: null, allOrganizations: false}
    // PEOPLE_ALL_ORGANIZATIONS (ADMIN holds every permission): every internal organization, or the active one
    if (caps.allOrganizations) {
        const all = rows("mantle.party.PartyRole", {roleTypeId: "OrgInternal"}).map(row => row.partyId)
        const activeId = all.includes(info.activeOrgId) ? info.activeOrgId : null
        return {
            organizationPartyIds: activeId ? [activeId] : all,
            activeOrganizationPartyId: activeId,
            allOrganizations: !activeId
        }
    }
    const internal = partyIdsWithRole(Array.from(info.userOrgIds || []), "OrgInternal")
    const activeId = internal.includes(info.activeOrgId) ? info.activeOrgId : null
    return {organizationPartyIds: activeId ? [activeId] : internal, activeOrganizationPartyId: activeId, allOrganizations: false}
}
// The units under the employers, level by level: the OrgDepartment and OrgTeam organizations rolling up to them, as of now.
function unitsUnder(organizationPartyIds) {
    const seen = new Set(organizationPartyIds)
    let level = organizationPartyIds
    for (let depth = 0; level.length && depth < unitDepth; depth++) {
        const children = unique(
            Array.from(
                current(
                    find("mantle.party.PartyRelationship")
                        .condition("relationshipTypeEnumId", "PrtOrgRollup")
                        .condition("toPartyId", "in", level),
                    null
                )
                    .selectField("fromPartyId")
                    .list()
            ).map(row => row.fromPartyId)
        ).filter(partyId => !seen.has(partyId))
        level = partyIdsWithRole(children, unitRoles)
        for (const partyId of level) seen.add(partyId)
    }
    return Array.from(seen).filter(partyId => !organizationPartyIds.includes(partyId))
}
const employmentFields = ["partyRelationshipId", "fromPartyId", "toPartyId", "fromDate", "thruDate"]
const employmentOf = row => ({
    partyRelationshipId: row.partyRelationshipId,
    partyId: row.fromPartyId,
    organizationPartyId: row.toPartyId,
    fromDate: row.fromDate,
    thruDate: row.thruDate
})
function employmentFind() {
    return find("mantle.party.PartyRelationship").condition("relationshipTypeEnumId", "PrtEmployee").selectField(employmentFields)
}
// The people employed by the organizations on the date, each once (distinct in the query).
function employeeIdsOf(organizationPartyIds, asOf) {
    const query = find("mantle.party.PartyRelationship")
        .condition("relationshipTypeEnumId", "PrtEmployee")
        .condition("toPartyId", "in", organizationPartyIds)
        .selectField("fromPartyId")
        .distinct(true)
    return Array.from(current(query, asOf).list()).map(row => row.fromPartyId)
}

// The scope of the current user (get#Scope without a party): their capabilities, the employers and units they read, their
// own current employments and live reports.
function scopeOf() {
    const caps = capabilities()
    const partyId = ec.user.userAccount?.partyId || null
    const info = ec.user.userId && caps.staff ? call("mantle.party.PartyServices.get#PartyOrganizationInfo") : {}
    const employed = employers(caps, info)
    const ownEmployments = partyId
        ? Array.from(current(employmentFind().condition("fromPartyId", partyId), null).list()).map(employmentOf)
        : []
    const reportPartyIds =
        partyId && caps.team
            ? unique(
                  Array.from(
                      current(
                          find("mantle.party.PartyRelationship")
                              .condition("relationshipTypeEnumId", "PrtManager")
                              .condition("fromPartyId", partyId),
                          null
                      )
                          .selectField("toPartyId")
                          .list()
                  ).map(row => row.toPartyId)
              )
            : []
    return Object.assign(employed, {
        capabilities: caps,
        partyId,
        unitPartyIds: unitsUnder(employed.organizationPartyIds),
        employments: ownEmployments,
        reportPartyIds
    })
}
function requireOrganization(userScope, organizationPartyId) {
    if (organizationPartyId && !userScope.organizationPartyIds.includes(organizationPartyId))
        denied("ORGANIZATION_DENIED", "Organization " + organizationPartyId + " is not available")
}
// How the scope admits a party, and the employments it shows of them; refused when nothing admits them.
function partyAccess(userScope, partyId, asOf) {
    const caps = userScope.capabilities
    const kinds = []
    let employments = []
    if (partyId === userScope.partyId && caps.self) {
        kinds.push("self")
        employments = employments.concat(userScope.employments)
    }
    if (userScope.reportPartyIds.includes(partyId)) {
        kinds.push("team")
        employments = employments.concat(
            Array.from(current(employmentFind().condition("fromPartyId", partyId), null).list()).map(employmentOf)
        )
    }
    if (caps.staff && userScope.organizationPartyIds.length) {
        let query = employmentFind()
            .condition("fromPartyId", partyId)
            .condition("toPartyId", "in", userScope.organizationPartyIds)
        // a directory reader sees the employments in effect on the date; an HR reader their history too
        if (!caps.hrView) query = current(query, asOf)
        const staffRows = Array.from(query.list()).map(employmentOf)
        if (staffRows.length) {
            kinds.push("staff")
            employments = employments.concat(staffRows)
        }
    }
    if (!kinds.length) denied("RECORD_UNAVAILABLE", "Person " + partyId + " is not available")
    const byId = new Map(employments.map(row => [row.partyRelationshipId, row]))
    return {kinds, employments: Array.from(byId.values())}
}

// get#Scope: the scope, narrowed to an organization asked for (its employers, its units and a staff admission by its
// employments) and with the access of a party asked for.
function scope(p) {
    const userScope = scopeOf()
    requireOrganization(userScope, p.organizationPartyId)
    const out = Object.assign({}, userScope, {partyAccess: [], partyEmployments: []})
    if (p.organizationPartyId) {
        out.organizationPartyIds = [p.organizationPartyId]
        out.unitPartyIds = unitsUnder(out.organizationPartyIds)
    }
    if (p.partyId) {
        const admitted = partyAccess(out, p.partyId, asOfMillis(p.asOfDate))
        out.partyAccess = admitted.kinds
        out.partyEmployments = admitted.employments.filter(
            row => !p.organizationPartyId || row.organizationPartyId === p.organizationPartyId
        )
    }
    return out
}

// ===== Home =====
// The organizations a Home or readiness read covers: the one asked for, refused outside the scope, else every one of it.
function organizationsFor(userScope, organizationPartyId) {
    requireOrganization(userScope, organizationPartyId)
    return organizationPartyId ? [organizationPartyId] : userScope.organizationPartyIds
}
const employmentsOf = organizationPartyIds => employmentFind().condition("toPartyId", "in", organizationPartyIds)
// The current employees of the organizations with no live manager (no current PrtManager relationship to them).
function withoutManager(organizationPartyIds, asOf) {
    const employeeIds = employeeIdsOf(organizationPartyIds, asOf)
    if (!employeeIds.length) return []
    const managed = new Set(
        Array.from(
            current(
                find("mantle.party.PartyRelationship")
                    .condition("relationshipTypeEnumId", "PrtManager")
                    .condition("toPartyId", "in", employeeIds),
                asOf
            )
                .selectField("toPartyId")
                .list()
        ).map(row => row.toPartyId)
    )
    return employeeIds.filter(partyId => !managed.has(partyId))
}
function personNames(partyIds) {
    if (!partyIds.length) return {}
    const people = Array.from(find("mantle.party.Person").condition("partyId", "in", partyIds).list())
    return Object.fromEntries(people.map(row => [row.partyId, [row.firstName, row.lastName].filter(Boolean).join(" ")]))
}
function organizationNames(partyIds) {
    if (!partyIds.length) return {}
    const organizations = Array.from(find("mantle.party.Organization").condition("partyId", "in", partyIds).list())
    return Object.fromEntries(organizations.map(row => [row.partyId, row.organizationName || row.partyId]))
}
// Home's counts: each with the capability that reads it; a count of a phase not built is absent. Headcount is distinct
// people, employments are counted apart (a person employed by two employers counts once and twice).
const homeCounts = {
    headcount: {
        needs: "staff",
        // count() counts rows whatever is selected, so the people's ids are read, distinct in the query
        count: (organizationPartyIds, asOf) => employeeIdsOf(organizationPartyIds, asOf).length
    },
    employments: {
        needs: "staff",
        count: (organizationPartyIds, asOf) => current(employmentsOf(organizationPartyIds), asOf).count()
    },
    joins: {
        needs: "hrView",
        count: (organizationPartyIds, asOf) =>
            employmentsOf(organizationPartyIds)
                .condition("fromDate", ">", stamp(asOf - recentDays * day))
                .condition("fromDate", "<=", stamp(asOf))
                .count()
    },
    exits: {
        needs: "hrView",
        count: (organizationPartyIds, asOf) =>
            employmentsOf(organizationPartyIds)
                .condition("thruDate", ">", stamp(asOf - recentDays * day))
                .condition("thruDate", "<=", stamp(asOf))
                .count()
    }
}
function home(p) {
    const userScope = scopeOf()
    const caps = userScope.capabilities
    if (!caps.staff) denied("PERMISSION_DENIED", "People's summary is not available")
    const organizationPartyIds = organizationsFor(userScope, p.organizationPartyId)
    const asOf = asOfMillis(p.asOfDate)
    const counts = {}
    for (const [name, definition] of Object.entries(homeCounts))
        if (caps[definition.needs]) counts[name] = organizationPartyIds.length ? definition.count(organizationPartyIds, asOf) : 0
    // the due work an HR reader clears: employees with no manager, the first few by name
    let dueWork = []
    let dueWorkCount = 0
    if (caps.hrView && organizationPartyIds.length) {
        const unmanaged = withoutManager(organizationPartyIds, asOf)
        dueWorkCount = unmanaged.length
        const names = personNames(unmanaged)
        const employmentRows = Array.from(
            current(
                employmentsOf(organizationPartyIds).condition("fromPartyId", "in", unmanaged.length ? unmanaged : ["_NA_"]),
                asOf
            ).list()
        )
        const organizations = organizationNames(unique(employmentRows.map(row => row.toPartyId)))
        dueWork = unmanaged
            .map(partyId => {
                const organizationPartyId = employmentRows.find(row => row.fromPartyId === partyId)?.toPartyId || null
                return {
                    dueKind: "noManager",
                    dueText: "No manager",
                    partyId,
                    personName: names[partyId] || partyId,
                    organizationPartyId,
                    organizationName: organizations[organizationPartyId] || ""
                }
            })
            .sort((a, b) => a.personName.localeCompare(b.personName))
            .slice(0, dueWorkLimit)
    }
    return {
        organizationPartyIds,
        organizationPartyId: p.organizationPartyId || null,
        asOfDate: asOf,
        counts,
        hasEmployees: counts.employments == null ? null : counts.employments > 0,
        dueWork,
        dueWorkCount
    }
}

// ===== readiness =====
// The checks of what is built, for an organization with current employees; one with none is not yet People's and answers no
// check. Each answers Admin's readiness contract: checkKey, title, state, reasonCode, message, fixPath.
const settingsPath = "People/Settings"
const readinessChecks = [
    {
        checkKey: "people.departments",
        title: "Departments",
        run(organizationPartyId) {
            const units = partyIdsWithRole(unitsUnder([organizationPartyId]), "OrgDepartment")
            return units.length
                ? {state: "ready", message: units.length + (units.length === 1 ? " department" : " departments")}
                : {state: "warning", reasonCode: "NO_DEPARTMENT", message: "No department is set up"}
        }
    },
    {
        checkKey: "people.managers",
        title: "Managers",
        run(organizationPartyId, asOf) {
            const unmanaged = withoutManager([organizationPartyId], asOf).length
            return unmanaged
                ? {
                      state: "warning",
                      reasonCode: "EMPLOYEE_NO_MANAGER",
                      message: unmanaged + (unmanaged === 1 ? " employee has" : " employees have") + " no manager"
                  }
                : {state: "ready", message: "Every employee has a manager"}
        }
    }
]
function readiness(p) {
    const userScope = scopeOf()
    if (!userScope.capabilities.configure) denied("PERMISSION_DENIED", "People's setup readiness is not available")
    const organizationPartyIds = organizationsFor(userScope, p.organizationPartyId)
    const asOf = asOfMillis(null)
    const names = organizationNames(organizationPartyIds)
    const checks = []
    for (const organizationPartyId of organizationPartyIds) {
        // an organization whose employees cannot be counted is logged by name and the others go on
        let employed
        try {
            employed = current(employmentsOf([organizationPartyId]), asOf).count() > 0
        } catch (error) {
            ec.logger.error("People readiness for " + organizationPartyId + " failed: " + error.message)
            employed = true
        }
        if (!employed) continue
        for (const check of readinessChecks) {
            let found
            // one check that fails is shown unavailable, by name, and the others go on
            try {
                found = check.run(organizationPartyId, asOf)
            } catch (error) {
                ec.logger.error(
                    "People readiness " + check.checkKey + " for " + organizationPartyId + " failed: " + error.message
                )
                found = {state: "unavailable", reasonCode: "CHECK_FAILED", message: check.title + " could not be checked"}
            }
            checks.push({
                checkKey: check.checkKey,
                title: check.title,
                state: found.state,
                reasonCode: found.reasonCode || null,
                message: found.message,
                fixPath: settingsPath,
                organizationPartyId,
                organizationName: names[organizationPartyId] || organizationPartyId
            })
        }
    }
    return {checks}
}

const operations = {scope, home, readiness}
function run(op, p) {
    if (!Object.hasOwn(operations, op)) throw new Error("Unknown People operation " + op)
    return operations[op](p || {})
}
;({execute: run})
