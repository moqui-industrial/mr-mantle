// People's organization and reporting lines (mantle.humanres.OrganizationServices find#Units, get#Unit, store#Unit,
// store#Membership, get#ReportingTree and change#Manager; IronStone People design §4 OrgStructure and OrgChart, PE-03;
// impl-people P3). Every read is a projection of the caller's People scope (People.js scopeOf), read with authorization off after
// that check; every change needs PEOPLE_HR_VIEW and PEOPLE_HR_EDIT and an employer in the caller's scope.
//
// The records (design §4; impl-people §4, F11, F12, F50, F63):
// - a department is an Organization with the OrgDepartment role and a team one with OrgTeam, never OrgInternal; its parent is a
//   dated PrtOrgRollup relationship from it to the parent. A unit's employer is the internal organization (OrgInternal) its
//   rollups reach; a move is a new rollup from a date that ends the one in effect, never across employers, never into a cycle;
//   the internal organizations themselves (Mantle's demo departments ORG_ZIZI_HR and ORG_ZIZI_SALES among them, §5 Q6) are
//   legal organizations, shown in the tree under their parent and kept by Admin's Organizations;
// - a membership is a dated PrtMember relationship from the person to the unit, from role Assignee for a member (as Mantle's
//   demo) and Manager for its lead, which BusinessTime's hours access reads (F63); never an employment. A department's members are
//   its employees' assignments' (P6, the user's call: Employment.js writes the Assignee row with the assignment), so store#Membership
//   changes a team's members and leads only, and a department's lead through store#Unit; a department is closed with its employees
//   reassigned to another (store#Unit's close);
// - a reporting line is a dated PrtManager relationship from the manager to the report (F50), at the employers that employ both
//   (People.js linesOf): change#Manager writes one only between two employees of one employer; for an employment with an
//   assignment (P6) the change is the assignment's manager change (Employment.js), the line its projection.
// Ended rows are kept; nothing is deleted. A change reason is the ended row's audit (thruDate_changeReason) and the new row's
// comments. Missing and unauthorized records are refused alike (RECORD_UNAVAILABLE).
const people = ec.resource.script("component://mr-mantle/service/mantle/humanres/People.js")
const employees = ec.resource.script("component://mr-mantle/service/mantle/humanres/Employees.js")
const employmentChanges = () => ec.resource.script("component://mr-mantle/service/mantle/humanres/Employment.js")
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const {find, one, rows, denied, call, dateText} = lib

const RELATIONSHIP = "mantle.party.PartyRelationship"
const ROLLUP = "PrtOrgRollup"
const MEMBER = "PrtMember"
const MANAGER = "PrtManager"
const unitKinds = {department: "OrgDepartment", team: "OrgTeam"}
const kindOfRole = {OrgDepartment: "department", OrgTeam: "team", OrgInternal: "organization"}
const kindTexts = {organization: "Legal organization", department: "Department", team: "Team"}
const kindOrder = {organization: 0, department: 1, team: 2}
// a member and a lead (F63: Assignee as Mantle's demo, Manager as BusinessTime reads a lead)
const memberRoles = {member: "Assignee", lead: "Manager"}
const roleTexts = {Assignee: "Member", Manager: "Lead"}
// a parent chain or reporting chain longer than this is taken to be a cycle
const maxDepth = 50
// the most rows a level of the reporting tree pages over
const pageCap = 2000

const ms = lib.ms
const nowMs = () => ms(ec.user.nowTimestamp)
const text = value => String(value ?? "").trim()
const unique = people.unique
const openAt = (row, at) => (ms(row.fromDate) ?? -Infinity) <= at && (ms(row.thruDate) ?? Infinity) > at
const stateOf = (row, at) =>
    (ms(row.thruDate) ?? Infinity) <= at
        ? {state: "ended", stateText: "Ended"}
        : (ms(row.fromDate) ?? -Infinity) > at
          ? {state: "future", stateText: "From " + dateText(row.fromDate)}
          : {state: "current", stateText: "Current"}
// a row's revision: its id and last change, what a change of it names
const revisionOf = row => (row ? row.partyRelationshipId + ":" + (ms(row.lastUpdatedStamp) ?? "") : "")
const nameOf = row => [row?.firstName, row?.lastName].filter(Boolean).join(" ")
const likeText = value => "%" + String(value).replace(/[\\%_]/g, character => "\\" + character) + "%"
// an effective date (now when empty): the start of a date alone, in the user's zone
const effective = value => (value == null || value === "" ? nowMs() : ec.user.timestampMillis(value))

// ===== reads of the records =====
function relationships(type, conditions) {
    return rows(RELATIONSHIP, Object.assign({relationshipTypeEnumId: type}, conditions))
}
// The kinds of the parties (organization, department, team) by their roles: {partyId: kind}, a party of none absent.
function kindsOf(partyIds) {
    const found = {}
    if (!partyIds.length) return found
    const roles = Array.from(
        find("mantle.party.PartyRole")
            .condition("partyId", "in", partyIds)
            .condition("roleTypeId", "in", Object.keys(kindOfRole))
            .list()
    )
    // a unit role wins over OrgInternal: a department is never one (F11), and a party holding both is shown as the unit
    for (const roleTypeId of ["OrgInternal", "OrgTeam", "OrgDepartment"])
        for (const row of roles) if (row.roleTypeId === roleTypeId) found[row.partyId] = kindOfRole[roleTypeId]
    return found
}
const roleOfKind = kind => (kind === "organization" ? "OrgInternal" : unitKinds[kind])
// The parent row of a party on the date (its rollup in effect), or null.
function parentAt(partyId, at) {
    return relationships(ROLLUP, {fromPartyId: partyId}).find(row => openAt(row, at)) || null
}
// The parent row nearest the date: the one in effect, else the next to start, else the last one.
function parentNear(partyId, at) {
    const found = relationships(ROLLUP, {fromPartyId: partyId}).sort((a, b) => (ms(a.fromDate) ?? 0) - (ms(b.fromDate) ?? 0))
    return (
        found.find(row => openAt(row, at)) || found.find(row => (ms(row.fromDate) ?? 0) > at) || found[found.length - 1] || null
    )
}
// The employer of a party: itself when it is an internal organization, else the one its rollups reach (a unit never moves
// across employers, so any of its rollup periods gives it). null when none is reached.
function employerOf(partyId, at) {
    let above = partyId
    for (let depth = 0; above && depth < maxDepth; depth++) {
        const kind = kindsOf([above])[above]
        if (kind === "organization") return above
        if (!kind && depth > 0) return null
        above = parentNear(above, at)?.toPartyId || null
    }
    return null
}
// The children of the parents on the date: {parentPartyId: [rollup row]}.
function childRowsAt(parentPartyIds, at) {
    const found = {}
    if (!parentPartyIds.length) return found
    const query = find(RELATIONSHIP).condition("relationshipTypeEnumId", ROLLUP).condition("toPartyId", "in", parentPartyIds)
    for (const row of Array.from(people.current(query, at).list())) (found[row.toPartyId] = found[row.toPartyId] || []).push(row)
    return found
}
// Whether a child is shown: a department or team, or an internal organization the caller reads as an employer.
const shownChild = (kinds, userScope) => partyId =>
    kinds[partyId] === "department" ||
    kinds[partyId] === "team" ||
    (kinds[partyId] === "organization" && userScope.organizationPartyIds.includes(partyId))
// The departments and teams under the organizations on the date, every level (a tree deeper than maxDepth is cut).
function unitsUnderAt(organizationPartyIds, at) {
    const seen = new Set(organizationPartyIds)
    const found = []
    let level = organizationPartyIds
    for (let depth = 0; level.length && depth < maxDepth; depth++) {
        const children = unique(
            Object.values(childRowsAt(level, at))
                .flat()
                .map(row => row.fromPartyId)
        ).filter(partyId => !seen.has(partyId))
        const kinds = kindsOf(children)
        level = children.filter(partyId => kinds[partyId] === "department" || kinds[partyId] === "team")
        for (const partyId of level) {
            seen.add(partyId)
            found.push(partyId)
        }
    }
    return found
}

// ===== scope =====
function readerScope() {
    const userScope = people.scopeOf()
    if (!userScope.capabilities.staff) denied("PERMISSION_DENIED", "The organization is not available")
    return userScope
}
function editorScope() {
    const userScope = people.scopeOf()
    const caps = userScope.capabilities
    if (!caps.hrView || !caps.hrEdit)
        denied("PERMISSION_DENIED", "Changing the organization needs PEOPLE_HR_VIEW and PEOPLE_HR_EDIT")
    return userScope
}
// A party the caller reads in the organization: an internal organization they read as an employer, or a department or team
// whose employer they read; {partyId, kind, employerPartyId}. Refused alike when missing or outside (RECORD_UNAVAILABLE).
function visibleParty(userScope, partyId, at) {
    const id = text(partyId)
    const kind = id ? kindsOf([id])[id] : null
    const employerPartyId = kind ? employerOf(id, at) : null
    if (!kind || !employerPartyId || !userScope.organizationPartyIds.includes(employerPartyId))
        denied("RECORD_UNAVAILABLE", "Organization " + id + " is not available")
    return {partyId: id, kind, employerPartyId}
}
// A department or team the caller reads; an internal organization is Admin's to change (NOT_A_UNIT).
function visibleUnit(userScope, partyId, at) {
    const found = visibleParty(userScope, partyId, at)
    if (found.kind === "organization")
        denied("NOT_A_UNIT", people.organizationNames([found.partyId])[found.partyId] + " is a legal organization, kept in Admin")
    return found
}

// ===== unit rows =====
// The revision of a unit: the later change of its Organization row, its rollups and its lead rows, what store#Unit names (its
// form sends the lead it read, so a lead changed since is a stale write, not one to put back).
function unitRevision(partyId) {
    const stamps = [ms(one("mantle.party.Organization", {partyId})?.lastUpdatedStamp) ?? 0]
        .concat(relationships(ROLLUP, {fromPartyId: partyId}).map(row => ms(row.lastUpdatedStamp) ?? 0))
        .concat(relationships(MEMBER, {toPartyId: partyId, fromRoleTypeId: "Manager"}).map(row => ms(row.lastUpdatedStamp) ?? 0))
    return String(Math.max(...stamps))
}
// The rows of the organizations and units on the date, as the tree shows them: name, kind, parent and since when, employer,
// lead (a unit's), people (an organization's employees, a unit's members), children shown and whether the caller may change it.
function unitRows(userScope, partyIds, at) {
    if (!partyIds.length) return []
    const kinds = kindsOf(partyIds)
    const names = people.organizationNames(partyIds)
    const parents = {}
    for (const row of Array.from(
        people
            .current(find(RELATIONSHIP).condition("relationshipTypeEnumId", ROLLUP).condition("fromPartyId", "in", partyIds), at)
            .list()
    ))
        parents[row.fromPartyId] = row
    const childRows = childRowsAt(partyIds, at)
    const childKinds = kindsOf(
        unique(
            Object.values(childRows)
                .flat()
                .map(row => row.fromPartyId)
        )
    )
    const shown = shownChild(childKinds, userScope)
    // a unit's members and lead on the date, an organization's employees
    const unitIds = partyIds.filter(partyId => kinds[partyId] !== "organization")
    const members = {}
    const leads = {}
    if (unitIds.length)
        for (const row of Array.from(
            people
                .current(find(RELATIONSHIP).condition("relationshipTypeEnumId", MEMBER).condition("toPartyId", "in", unitIds), at)
                .list()
        )) {
            ;(members[row.toPartyId] = members[row.toPartyId] || new Set()).add(row.fromPartyId)
            if (row.fromRoleTypeId === "Manager") leads[row.toPartyId] = row.fromPartyId
        }
    const organizationIds = partyIds.filter(partyId => kinds[partyId] === "organization")
    const employed = {}
    if (organizationIds.length)
        for (const row of Array.from(
            people.current(people.employmentFind().condition("toPartyId", "in", organizationIds), at).list()
        ))
            (employed[row.toPartyId] = employed[row.toPartyId] || new Set()).add(row.fromPartyId)
    const leadNames = people.personNames(unique(Object.values(leads)))
    const parentNames = people.organizationNames(unique(Object.values(parents).map(row => row.toPartyId)))
    const caps = userScope.capabilities
    const employerIds = Object.fromEntries(
        partyIds.map(partyId => [partyId, kinds[partyId] === "organization" ? partyId : employerOf(partyId, at)])
    )
    const employerNames = people.organizationNames(unique(Object.values(employerIds).filter(Boolean)))
    return partyIds
        .map(partyId => {
            const kind = kinds[partyId] || "organization"
            const parent = parents[partyId] || null
            const employerPartyId = employerIds[partyId]
            const peopleCount = kind === "organization" ? employed[partyId]?.size || 0 : members[partyId]?.size || 0
            return {
                partyId,
                organizationName: names[partyId] || partyId,
                unitKind: kind,
                kindText: kindTexts[kind],
                // a top-level row of the tree has no parent the caller reads
                parentPartyId:
                    parent && (kind !== "organization" || userScope.organizationPartyIds.includes(parent.toPartyId))
                        ? parent.toPartyId
                        : null,
                parentName: parent ? parentNames[parent.toPartyId] || parent.toPartyId : "",
                sinceText: parent ? dateText(parent.fromDate) : "",
                employerPartyId,
                employerName: employerNames[employerPartyId] || "",
                headPartyId: leads[partyId] || null,
                headName: leads[partyId] ? leadNames[leads[partyId]] || leads[partyId] : "",
                peopleCount,
                childCount: (childRows[partyId] || []).filter(row => shown(row.fromPartyId)).length,
                canEdit: kind !== "organization" && !!caps.hrView && !!caps.hrEdit,
                revision: kind === "organization" ? "" : unitRevision(partyId)
            }
        })
        .sort((a, b) => kindOrder[a.unitKind] - kindOrder[b.unitKind] || a.organizationName.localeCompare(b.organizationName))
}

// ===== find#Units =====
// The organization as a tree, a level at a time (design §4 OrgStructure): without a parent, the top (the employers the caller
// reads whose parent they do not read); with parentPartyId, its children on the date (departments, teams, and the internal
// organizations the caller reads as employers); with term, every department and team under the employers whose name matches,
// searched in the query ignoring case. organizationPartyId narrows the employers (refused outside the scope).
function findUnits(p) {
    const userScope = readerScope()
    people.requireOrganization(userScope, p.organizationPartyId)
    const at = people.asOfMillis(p.asOfDate)
    const employerIds = p.organizationPartyId ? [p.organizationPartyId] : userScope.organizationPartyIds
    let partyIds
    if (text(p.parentPartyId)) {
        const parent = visibleParty(userScope, p.parentPartyId, at)
        const children = (childRowsAt([parent.partyId], at)[parent.partyId] || []).map(row => row.fromPartyId)
        partyIds = unique(children).filter(shownChild(kindsOf(children), userScope))
    } else if (text(p.term)) {
        const candidates = employerIds.concat(unitsUnderAt(employerIds, at))
        const factory = ec.entity.conditionFactory
        partyIds = candidates.length
            ? Array.from(
                  find("mantle.party.Organization")
                      .condition("partyId", "in", candidates)
                      .condition(
                          factory.makeCondition(
                              ["partyId", "organizationName"].map(field =>
                                  factory.makeCondition(field, "like", likeText(text(p.term))).ignoreCase()
                              ),
                              "or"
                          )
                      )
                      .selectField("partyId")
                      .limit(200)
                      .list()
              ).map(row => row.partyId)
            : []
    } else {
        const parents = {}
        for (const partyId of employerIds) parents[partyId] = parentAt(partyId, at)?.toPartyId || null
        partyIds = employerIds.filter(partyId => !employerIds.includes(parents[partyId]))
    }
    return {units: unitRows(userScope, partyIds, at), asOfDate: at}
}

// ===== get#Unit =====
// One organization or unit the caller reads: its row on the date, its parents (every dated rollup, newest first) and its
// memberships (every dated PrtMember row, current first: a team's or department's members and lead).
function getUnit(p) {
    const userScope = readerScope()
    const at = people.asOfMillis(p.asOfDate)
    const found = visibleParty(userScope, p.partyId, at)
    const unit = unitRows(userScope, [found.partyId], at)[0]
    const parentRows = relationships(ROLLUP, {fromPartyId: found.partyId}).sort(
        (a, b) => (ms(b.fromDate) ?? 0) - (ms(a.fromDate) ?? 0)
    )
    const parentNames = people.organizationNames(unique(parentRows.map(row => row.toPartyId)))
    const parents = parentRows.map(row =>
        Object.assign(
            {
                parentPartyId: row.toPartyId,
                parentName: parentNames[row.toPartyId] || row.toPartyId,
                fromDateText: dateText(row.fromDate),
                thruDateText: dateText(row.thruDate),
                reason: row.comments || ""
            },
            stateOf(row, at)
        )
    )
    let members = []
    if (found.kind !== "organization") {
        const memberRows = relationships(MEMBER, {toPartyId: found.partyId})
        const names = people.personNames(unique(memberRows.map(row => row.fromPartyId)))
        const rank = {current: 0, future: 1, ended: 2}
        members = memberRows
            .map(row =>
                Object.assign(
                    {
                        partyRelationshipId: row.partyRelationshipId,
                        partyId: row.fromPartyId,
                        personName: names[row.fromPartyId] || row.fromPartyId,
                        memberRole: row.fromRoleTypeId === "Manager" ? "lead" : "member",
                        roleText: roleTexts[row.fromRoleTypeId] || "Member",
                        fromDateText: dateText(row.fromDate),
                        thruDateText: dateText(row.thruDate),
                        revision: revisionOf(row)
                    },
                    stateOf(row, at)
                )
            )
            .sort(
                (a, b) =>
                    rank[a.state] - rank[b.state] ||
                    Number(a.memberRole !== "lead") - Number(b.memberRole !== "lead") ||
                    a.personName.localeCompare(b.personName)
            )
    }
    // a department's members are its assignments' (P6): changed with the employment, its lead with the unit
    unit.membersEditable = found.kind === "team" && unit.canEdit
    return {unit, parents, members, asOfDate: at}
}

// ===== store#Unit =====
// A new department or team under a parent from a date, or a unit's new name, parent or lead (design §4 EditUnit). Refused: a
// caller without PEOPLE_HR_VIEW and PEOPLE_HR_EDIT (PERMISSION_DENIED); a kind other than department or team (KIND_INVALID);
// no name (NAME_REQUIRED) or parent (PARENT_REQUIRED); a parent or unit outside the scope (RECORD_UNAVAILABLE); an internal
// organization, which is Admin's (NOT_A_UNIT); a department under a team (PARENT_KIND); a move to another employer
// (EMPLOYER_CHANGE), under itself or a unit below it (PARENT_CYCLE), dated before its parent in effect began (DATE_STALE) or
// while a later move is set (PARENT_SCHEDULED); a revision other than the one read (REVISION_CHANGED).
function checkParent(userScope, kind, parentPartyId, at) {
    if (!text(parentPartyId)) denied("PARENT_REQUIRED", "Choose the organization or unit it belongs to")
    const parent = visibleParty(userScope, parentPartyId, at)
    if (kind === "department" && parent.kind === "team")
        denied("PARENT_KIND", "A department belongs to an organization or a department")
    return parent
}
function linkParent(partyId, kind, parent, fromMs, reason) {
    return call("create#" + RELATIONSHIP, {
        relationshipTypeEnumId: ROLLUP,
        fromPartyId: partyId,
        fromRoleTypeId: roleOfKind(kind),
        toPartyId: parent.partyId,
        toRoleTypeId: roleOfKind(parent.kind),
        fromDate: new Date(fromMs),
        comments: reason || null
    }).partyRelationshipId
}
function endRow(row, thruMs, reason) {
    call("update#" + RELATIONSHIP, {
        partyRelationshipId: row.partyRelationshipId,
        thruDate: new Date(thruMs),
        thruDate_changeReason: reason || null
    })
}
function storeUnit(p) {
    const userScope = editorScope()
    const fromMs = effective(p.fromDate)
    const reason = text(p.changeReason)
    const name = text(p.organizationName)
    if (!text(p.partyId)) {
        const kind = text(p.unitKind)
        if (!unitKinds[kind]) denied("KIND_INVALID", "A unit is a department or a team")
        if (!name) denied("NAME_REQUIRED", "A unit has a name")
        const parent = checkParent(userScope, kind, p.parentPartyId, fromMs)
        const employerPartyId = parent.kind === "organization" ? parent.partyId : parent.employerPartyId
        const created = call("mantle.party.PartyServices.create#Organization", {
            organizationName: name,
            roleTypeId: unitKinds[kind],
            // owned by its employer, so the employer's users find it as the employer's
            ownerPartyId: employerPartyId
        })
        const unit = {partyId: created.partyId, kind, employerPartyId}
        linkParent(unit.partyId, kind, parent, fromMs, reason)
        if (text(p.headPartyId)) addMembership(unit, text(p.headPartyId), "lead", fromMs, reason)
        return {partyId: unit.partyId, revision: unitRevision(unit.partyId)}
    }
    const unit = visibleUnit(userScope, p.partyId, fromMs)
    const revision = unitRevision(unit.partyId)
    if (text(p.expectedRevision) !== revision)
        denied("REVISION_CHANGED", "This unit changed since you read it; open it again (revision " + revision + ")")
    if (p.close === true || p.close === "true" || p.close === "Y") return closeUnit(userScope, unit, p, reason)
    if (name && name !== (one("mantle.party.Organization", {partyId: unit.partyId})?.organizationName || ""))
        call("update#mantle.party.Organization", {partyId: unit.partyId, organizationName: name})
    const parentPartyId = text(p.parentPartyId)
    const current = parentAt(unit.partyId, fromMs)
    if (parentPartyId && parentPartyId !== current?.toPartyId) {
        const parent = checkParent(userScope, unit.kind, parentPartyId, fromMs)
        const parentEmployer = parent.kind === "organization" ? parent.partyId : parent.employerPartyId
        if (parentEmployer !== unit.employerPartyId)
            denied("EMPLOYER_CHANGE", "A unit stays with its legal employer; start a unit under the other employer instead")
        // the new parent and every unit above it on the date: the unit must not be among them
        let above = parent.partyId
        for (let depth = 0; above && depth < maxDepth; depth++) {
            if (above === unit.partyId) denied("PARENT_CYCLE", "A unit cannot belong to itself or to a unit below it")
            above = parentAt(above, fromMs)?.toPartyId || null
        }
        if (!current) denied("DATE_STALE", "This unit has no parent on that date; move it from a date when it has one")
        if (relationships(ROLLUP, {fromPartyId: unit.partyId}).some(row => (ms(row.fromDate) ?? 0) > fromMs))
            denied("PARENT_SCHEDULED", "This unit already has a later move; change that one")
        endRow(current, fromMs, reason)
        linkParent(unit.partyId, unit.kind, parent, fromMs, reason)
    }
    if (text(p.headPartyId)) {
        const lead = relationships(MEMBER, {toPartyId: unit.partyId, fromRoleTypeId: "Manager"}).find(row => openAt(row, fromMs))
        if (lead?.fromPartyId !== text(p.headPartyId)) addMembership(unit, text(p.headPartyId), "lead", fromMs, reason)
    }
    return {partyId: unit.partyId, revision: unitRevision(unit.partyId)}
}

// A unit closed from a date (P6; design §4 OrgStructure: a closure reassigns its employees): no earlier than now; refused while a
// unit is under it (UNIT_HAS_CHILDREN), a position is in the department (UNIT_HAS_POSITIONS) or a membership starts later
// (MEMBERSHIP_SCHEDULED); a department's employees (the assignments naming it) move to another department of the employer
// (reassignPartyId; REASSIGNMENT_REQUIRED without one, REASSIGNMENT_INVALID for the unit itself, a team or another employer's),
// each a reorganization from the date (Employment.js). The remaining memberships (its lead, a team's members) and its rollup end
// on the date, with the reason; nothing is deleted.
function closeUnit(userScope, unit, p, reason) {
    const at = Math.max(effective(p.thruDate), nowMs())
    const name = people.organizationNames([unit.partyId])[unit.partyId] || unit.partyId
    const current = parentAt(unit.partyId, at)
    if (!current) denied("DATE_STALE", name + " has no parent on that date; it is closed already")
    if (relationships(ROLLUP, {toPartyId: unit.partyId}).some(row => (ms(row.thruDate) ?? Infinity) > at))
        denied("UNIT_HAS_CHILDREN", "Units belong to " + name + " then; move or close them first")
    if (
        unit.kind === "department" &&
        rows("mantle.humanres.position.EmplPosition", {departmentPartyId: unit.partyId}).some(
            row => (ms(row.thruDate) ?? Infinity) > at
        )
    )
        denied("UNIT_HAS_POSITIONS", "Positions belong to " + name + " then; move or end them first")
    const memberships = relationships(MEMBER, {toPartyId: unit.partyId}).filter(row => (ms(row.thruDate) ?? Infinity) > at)
    let moved = 0
    if (unit.kind === "department") {
        const assigned = rows("mantle.humanres.employment.EmploymentAssignment", {departmentPartyId: unit.partyId}).filter(
            row => (ms(row.thruDate) ?? Infinity) > at
        )
        if (assigned.length) {
            const reassignPartyId = text(p.reassignPartyId)
            if (!reassignPartyId)
                denied("REASSIGNMENT_REQUIRED", "People work in " + name + "; choose the department they move to")
            const target = visibleUnit(userScope, reassignPartyId, at)
            if (
                target.kind !== "department" ||
                target.partyId === unit.partyId ||
                target.employerPartyId !== unit.employerPartyId
            )
                denied("REASSIGNMENT_INVALID", "Choose another department of the same employer")
            moved = employmentChanges().reassignDepartment(unit.partyId, target.partyId, at, reason || "Department closed")
        }
    }
    const remaining = relationships(MEMBER, {toPartyId: unit.partyId}).filter(row => (ms(row.thruDate) ?? Infinity) > at)
    if (remaining.some(row => (ms(row.fromDate) ?? -Infinity) > at))
        denied("MEMBERSHIP_SCHEDULED", "Someone joins " + name + " after that date; change that membership first")
    for (const row of remaining) endRow(row, at, reason || "Unit closed")
    endRow(current, at, reason || "Unit closed")
    return {partyId: unit.partyId, revision: unitRevision(unit.partyId), moved, endedMemberships: memberships.length}
}

// ===== store#Membership =====
// A person joins a unit as a member or its lead from a date, or a membership ends (design §4 TeamMembers): a dated PrtMember row
// from the person to the unit, never an employment. A person who is a member already in another role changes role from the
// date (the row ends, a new one starts); a new lead's predecessor stays on as a member. Refused: a person not employed by the
// unit's employer on the date (NOT_EMPLOYED), a membership in the same role (ALREADY_MEMBER) or one starting later
// (MEMBERSHIP_SCHEDULED), an unknown role (ROLE_INVALID); an end: a membership not of the unit (RECORD_UNAVAILABLE), already
// ended (MEMBERSHIP_ENDED), dated before it starts (DATE_STALE), or at a revision other than the one read (REVISION_CHANGED).
function addMembership(unit, partyId, memberRole, fromMs, reason) {
    const roleTypeId = memberRoles[memberRole]
    if (!roleTypeId) denied("ROLE_INVALID", "A member's role is member or lead")
    const employed = people
        .current(people.employmentFind().condition({fromPartyId: partyId, toPartyId: unit.employerPartyId}), fromMs)
        .count()
    const names = people.personNames([partyId])
    if (!employed)
        denied(
            "NOT_EMPLOYED",
            (names[partyId] || partyId) +
                " is not employed by " +
                people.organizationNames([unit.employerPartyId])[unit.employerPartyId] +
                " on that date"
        )
    const open = relationships(MEMBER, {fromPartyId: partyId, toPartyId: unit.partyId}).filter(
        row => (ms(row.thruDate) ?? Infinity) > fromMs && (unit.kind !== "department" || row.fromRoleTypeId === roleTypeId)
    )
    if (open.some(row => (ms(row.fromDate) ?? 0) > fromMs))
        denied("MEMBERSHIP_SCHEDULED", (names[partyId] || partyId) + " already has a later membership of this unit")
    if (open.some(row => row.fromRoleTypeId === roleTypeId))
        denied("ALREADY_MEMBER", (names[partyId] || partyId) + " is already its " + roleTexts[roleTypeId].toLowerCase())
    // a role change: the membership in the other role ends on the date (a department's Assignee row is its assignment's, P6:
    // its lead keeps it)
    for (const row of open) if (unit.kind !== "department") endRow(row, fromMs, reason || "Role changed")
    const join = (memberPartyId, memberRoleTypeId) => {
        call("mantle.party.PartyServices.ensure#PartyRole", {partyId: memberPartyId, roleTypeId: memberRoleTypeId})
        return call("create#" + RELATIONSHIP, {
            relationshipTypeEnumId: MEMBER,
            fromPartyId: memberPartyId,
            fromRoleTypeId: memberRoleTypeId,
            toPartyId: unit.partyId,
            toRoleTypeId: unitKinds[unit.kind],
            fromDate: new Date(fromMs),
            comments: reason || null
        }).partyRelationshipId
    }
    if (roleTypeId === "Manager")
        // one lead at a time: the lead before stays a member of a team from the date (a department's members are its
        // assignments')
        for (const lead of relationships(MEMBER, {toPartyId: unit.partyId, fromRoleTypeId: "Manager"}).filter(
            row => openAt(row, fromMs) && row.fromPartyId !== partyId
        )) {
            endRow(lead, fromMs, reason || "New lead")
            if (unit.kind !== "department") join(lead.fromPartyId, "Assignee")
        }
    return join(partyId, roleTypeId)
}
function storeMembership(p) {
    const userScope = editorScope()
    const unit = visibleUnit(userScope, p.unitPartyId, nowMs())
    if (unit.kind === "department")
        denied(
            "DEPARTMENT_MEMBERSHIP",
            "A department's members come from their employment; change the employment, or the department's lead on the unit"
        )
    const reason = text(p.changeReason)
    if (text(p.partyRelationshipId)) {
        const row = one(RELATIONSHIP, {partyRelationshipId: text(p.partyRelationshipId)})
        if (!row || row.relationshipTypeEnumId !== MEMBER || row.toPartyId !== unit.partyId)
            denied("RECORD_UNAVAILABLE", "Membership " + text(p.partyRelationshipId) + " is not available")
        if (text(p.expectedRevision) !== revisionOf(row))
            denied(
                "REVISION_CHANGED",
                "This membership changed since you read it; open it again (revision " + revisionOf(row) + ")"
            )
        const thruMs = effective(p.thruDate)
        if ((ms(row.thruDate) ?? Infinity) <= nowMs()) denied("MEMBERSHIP_ENDED", "This membership has ended")
        if (thruMs < (ms(row.fromDate) ?? -Infinity)) denied("DATE_STALE", "A membership ends on or after it starts")
        endRow(row, thruMs, reason)
        return {partyRelationshipId: row.partyRelationshipId}
    }
    if (!text(p.partyId)) denied("PERSON_REQUIRED", "Choose the person")
    return {
        partyRelationshipId: addMembership(unit, text(p.partyId), text(p.memberRole) || "member", effective(p.fromDate), reason)
    }
}

// ===== get#ReportingTree =====
// The reporting lines as a tree, a level at a time (design §4 OrgChart): one node per employment by an employer the caller
// reads, current on the date, placed under the manager of its line at that employer (People.js linesOf). Without a manager, the
// top: the employments with no manager at their employer, listed and not lost (noManager); with managerPartyId, that manager's
// reports (at organizationPartyId, else at each employer the caller reads); with parentNodeId (a node's id, as the tree asks for a
// level), that node's reports; with partyId, that person's own nodes; with term, the people whose name matches, searched in the
// query ignoring case. Each node is the person's public work identity (the directory's projection), their manager and the count
// of their reports; an editor (PEOPLE_HR_EDIT) also gets the line's revision, which change#Manager names. Paged.
const nodeId = (organizationPartyId, partyId) => organizationPartyId + "/" + partyId
function reportingTree(p) {
    const userScope = readerScope()
    people.requireOrganization(userScope, p.organizationPartyId)
    const at = people.asOfMillis(p.asOfDate)
    let organizationPartyId = text(p.organizationPartyId) || null
    let managerPartyId = text(p.managerPartyId) || null
    if (text(p.parentNodeId)) {
        const [nodeOrganization, nodeParty] = text(p.parentNodeId).split("/")
        people.requireOrganization(userScope, nodeOrganization)
        organizationPartyId = nodeOrganization
        managerPartyId = nodeParty || null
    }
    const employerIds = organizationPartyId ? [organizationPartyId] : userScope.organizationPartyIds
    if (!employerIds.length) return Object.assign({nodes: [], asOfDate: at}, lib.pageList([], p, "nodes"))
    // the current employments by the employers, each person once per employer
    const byKey = new Map()
    for (const row of Array.from(people.current(people.employmentFind().condition("toPartyId", "in", employerIds), at).list()))
        byKey.set(nodeId(row.toPartyId, row.fromPartyId), {partyId: row.fromPartyId, organizationPartyId: row.toPartyId})
    const employments = Array.from(byKey.values())
    const partyIds = unique(employments.map(row => row.partyId))
    // the line of each employment at its employer (the newest when a person has two there)
    const lineOf = {}
    for (const line of people.linesOf({reportPartyIds: partyIds}, at))
        for (const organization of line.organizationPartyIds) {
            const key = nodeId(organization, line.partyId)
            if (byKey.has(key) && !lineOf[key]) lineOf[key] = line
        }
    const reportCounts = {}
    for (const [key, line] of Object.entries(lineOf)) {
        const managerKey = nodeId(key.split("/")[0], line.managerPartyId)
        reportCounts[managerKey] = (reportCounts[managerKey] || 0) + 1
    }
    let chosen
    if (managerPartyId)
        chosen = employments.filter(
            row => lineOf[nodeId(row.organizationPartyId, row.partyId)]?.managerPartyId === managerPartyId
        )
    else if (text(p.partyId)) {
        chosen = employments.filter(row => row.partyId === text(p.partyId))
        if (!chosen.length) denied("RECORD_UNAVAILABLE", "Person " + text(p.partyId) + " is not available")
    } else if (text(p.term)) {
        const factory = ec.entity.conditionFactory
        const matched = partyIds.length
            ? new Set(
                  Array.from(
                      find("mantle.party.Person")
                          .condition("partyId", "in", partyIds)
                          .condition(
                              factory.makeCondition(
                                  ["partyId", "firstName", "lastName", "nickname"].map(field =>
                                      factory.makeCondition(field, "like", likeText(text(p.term))).ignoreCase()
                                  ),
                                  "or"
                              )
                          )
                          .selectField("partyId")
                          .list()
                  ).map(row => row.partyId)
              )
            : new Set()
        chosen = employments.filter(row => matched.has(row.partyId))
    } else chosen = employments.filter(row => !lineOf[nodeId(row.organizationPartyId, row.partyId)])
    const names = {}
    const chosenIds = unique(chosen.map(row => row.partyId))
    if (chosenIds.length)
        for (const row of Array.from(find("mantle.party.Person").condition("partyId", "in", chosenIds).list()))
            names[row.partyId] = {personName: nameOf(row) || row.partyId, preferredName: row.nickname || ""}
    chosen.sort(
        (a, b) =>
            (names[a.partyId]?.personName || "").localeCompare(names[b.partyId]?.personName || "") ||
            a.organizationPartyId.localeCompare(b.organizationPartyId)
    )
    const paged = lib.pageList(chosen.slice(0, pageCap), p, "nodes", {noLimitCap: pageCap})
    const shown = paged.nodes
    // the public work identity of the page's people: titles by employment, work contacts, managers' and employers' names
    const employmentIds = {}
    if (shown.length)
        for (const row of Array.from(
            people
                .current(
                    people
                        .employmentFind()
                        .condition("fromPartyId", "in", unique(shown.map(row => row.partyId)))
                        .condition("toPartyId", "in", unique(shown.map(row => row.organizationPartyId))),
                    at
                )
                .list()
        ))
            employmentIds[nodeId(row.toPartyId, row.fromPartyId)] =
                employmentIds[nodeId(row.toPartyId, row.fromPartyId)] || row.partyRelationshipId
    const titles = employees.titlesOf(Object.values(employmentIds))
    const contacts = employees.contactsOf(unique(shown.map(row => row.partyId)), employees.workPurposes)
    const managerIds = unique(
        shown.map(row => lineOf[nodeId(row.organizationPartyId, row.partyId)]?.managerPartyId).filter(Boolean)
    )
    const managerNames = people.personNames(managerIds)
    const organizations = people.organizationNames(unique(shown.map(row => row.organizationPartyId)))
    const canEdit = !!userScope.capabilities.hrView && !!userScope.capabilities.hrEdit
    const assignments = canEdit ? people.assignmentsAt(unique(shown.map(row => row.partyId)), at) : {}
    const nodes = shown.map(row => {
        const key = nodeId(row.organizationPartyId, row.partyId)
        const line = lineOf[key] || null
        const contact = contacts[row.partyId] || {}
        const out = {
            nodeId: key,
            parentNodeId: line ? nodeId(row.organizationPartyId, line.managerPartyId) : "",
            partyId: row.partyId,
            personName: names[row.partyId]?.personName || row.partyId,
            preferredName: names[row.partyId]?.preferredName || "",
            organizationPartyId: row.organizationPartyId,
            organizationName: organizations[row.organizationPartyId] || row.organizationPartyId,
            jobTitle: titles[employmentIds[key]]?.jobTitle || "",
            managerPartyId: line?.managerPartyId || null,
            managerName: line ? managerNames[line.managerPartyId] || line.managerPartyId : "",
            noManager: !line,
            workEmail: contact.workEmail || "",
            workPhone: contact.workPhone || "",
            workLocation: contact.workAddressCity || "",
            reportCount: reportCounts[key] || 0
        }
        if (canEdit) {
            // the manager of an employment with an assignment is the assignment's (P6): its revision is the employment's
            const assignment = assignments[key]
            out.lineRevision = assignment ? assignmentRevision(assignment.partyRelationshipId) : revisionOf(line)
            out.lineSinceText = line ? dateText(line.fromDate) : ""
        }
        return out
    })
    const out = {nodes, canEdit, asOfDate: at}
    for (const field of ["Count", "PageIndex", "PageSize", "PageMaxIndex", "PageRangeLow", "PageRangeHigh"])
        out["nodes" + field] = paged["nodes" + field]
    return out
}

// ===== change#Manager =====
// A dated reporting change (design §4 ChangeManager): the person's line at the employer ends on the date and, with a manager, a
// new one starts (PrtManager from the manager to the person, F50); without one, the person has no manager there from the date.
// Refused: a caller without PEOPLE_HR_VIEW and PEOPLE_HR_EDIT (PERMISSION_DENIED); a person the employers the caller reads do
// not employ (RECORD_UNAVAILABLE), or not on the date (NOT_EMPLOYED); a person employed by two of them with no employer named
// (ORGANIZATION_REQUIRED); the person as their own manager (SELF_REPORTING); a manager the employer does not employ on the date
// (MANAGER_NOT_EMPLOYED); a manager who reports to the person, directly or not, at that employer (REPORTING_CYCLE); the manager
// they have (MANAGER_UNCHANGED); a line starting later (MANAGER_SCHEDULED); a line ended or started that is also a line at an
// employer the caller does not read (LINE_SHARED); a revision other than the line read (REVISION_CHANGED; "" for none).
function employedOn(partyId, organizationPartyId, at) {
    return (
        people.current(people.employmentFind().condition({fromPartyId: partyId, toPartyId: organizationPartyId}), at).count() > 0
    )
}
function changeManager(p) {
    const userScope = editorScope()
    const partyId = text(p.partyId)
    if (!partyId) denied("PERSON_REQUIRED", "Choose the person")
    const fromMs = effective(p.fromDate)
    const reason = text(p.changeReason)
    // the employer of the line: the one named, else the one employer the caller reads that employs the person on the date
    let organizationPartyId = text(p.organizationPartyId)
    const employedBy = unique(
        Array.from(
            people
                .employmentFind()
                .condition("fromPartyId", partyId)
                .condition("toPartyId", "in", userScope.organizationPartyIds.length ? userScope.organizationPartyIds : ["_NA_"])
                .list()
        ).map(row => row.toPartyId)
    )
    if (!employedBy.length) denied("RECORD_UNAVAILABLE", "Person " + partyId + " is not available")
    if (!organizationPartyId) {
        const onDate = employedBy.filter(organization => employedOn(partyId, organization, fromMs))
        if (onDate.length > 1) denied("ORGANIZATION_REQUIRED", "Choose the employer whose reporting line changes")
        organizationPartyId = onDate[0] || employedBy[0]
    }
    people.requireOrganization(userScope, organizationPartyId)
    if (!employedBy.includes(organizationPartyId)) denied("RECORD_UNAVAILABLE", "Person " + partyId + " is not available")
    const names = people.personNames([partyId])
    const employerName = people.organizationNames([organizationPartyId])[organizationPartyId]
    if (!employedOn(partyId, organizationPartyId, fromMs))
        denied("NOT_EMPLOYED", (names[partyId] || partyId) + " is not employed by " + employerName + " on that date")
    const managerPartyId = text(p.managerPartyId) || null
    if (managerPartyId === partyId) denied("SELF_REPORTING", "A person cannot report to themselves")
    if (managerPartyId && !employedOn(managerPartyId, organizationPartyId, fromMs))
        denied("MANAGER_NOT_EMPLOYED", "The manager is not employed by " + employerName + " on that date")
    // an employment with an assignment (P6): the manager is the assignment's, changed as an employment change from the date
    const assignment = people.assignmentsAt([partyId], fromMs)[organizationPartyId + "/" + partyId]
    if (assignment) return changeAssignedManager(assignment, managerPartyId, fromMs, reason, p, names[partyId] || partyId)
    // the person's lines at the employer: a line at the employer is one whose manager it employs, or who has no employer
    const atEmployer = (row, at) => {
        const theirs = people.employersOfParties([row.fromPartyId], at)[row.fromPartyId]
        return !theirs || theirs.includes(organizationPartyId)
    }
    const lines = relationships(MANAGER, {toPartyId: partyId}).filter(row => (ms(row.thruDate) ?? Infinity) > fromMs)
    if (lines.some(row => (ms(row.fromDate) ?? 0) > fromMs && atEmployer(row, ms(row.fromDate))))
        denied("MANAGER_SCHEDULED", (names[partyId] || partyId) + " already has a later manager change; change that one")
    // the lines at the employer on the date as the tree reads them (People.js linesOf, newest first), so the revision is of the
    // line the tree shows
    const open = people
        .linesOf({reportPartyIds: [partyId]}, fromMs)
        .filter(line => line.organizationPartyIds.includes(organizationPartyId) && (ms(line.fromDate) ?? -Infinity) <= fromMs)
    const revision = revisionOf(open[0] || null)
    if (text(p.expectedRevision) !== revision)
        denied(
            "REVISION_CHANGED",
            "This reporting line changed since you read it; open it again (revision " + (revision || "none") + ")"
        )
    if (managerPartyId ? open.some(line => line.managerPartyId === managerPartyId) : !open.length)
        denied(
            "MANAGER_UNCHANGED",
            managerPartyId ? "That is the manager already" : (names[partyId] || partyId) + " has no manager"
        )
    checkCycle(partyId, managerPartyId, organizationPartyId, fromMs, names[partyId] || partyId)
    // the change is the employment's (P6): its first assignment from the date, with the manager, the line its projection
    // (Employment.js), so the line at another employer of the person is never changed (F91); an orphan relationship (no
    // Employment row) keeps the line write below
    const employment = Array.from(
        people.current(people.employmentFind().condition({fromPartyId: partyId, toPartyId: organizationPartyId}), fromMs).list()
    ).find(row => one("mantle.humanres.employment.Employment", {partyRelationshipId: row.partyRelationshipId}))
    if (employment) {
        employmentChanges().changeManagerOfAssignment(employment.partyRelationshipId, managerPartyId, fromMs, reason)
        const line = managerPartyId
            ? relationships(MANAGER, {fromPartyId: managerPartyId, toPartyId: partyId}).find(row => openAt(row, fromMs))
            : null
        return {partyRelationshipId: line?.partyRelationshipId || null, organizationPartyId}
    }
    // a line is at every employer of the report that employs the manager too (People.js linesOf): the line ended and the one
    // started must be at employers the caller reads, so a change at one employer never changes another employer's line
    const endedIds = new Set(open.map(row => row.partyRelationshipId))
    const affected = people
        .linesOf({reportPartyIds: [partyId]}, fromMs)
        .filter(line => endedIds.has(line.partyRelationshipId))
        .flatMap(line => line.organizationPartyIds)
    if (managerPartyId) {
        const employers = people.employersOfParties([managerPartyId, partyId], fromMs)
        for (const organization of employers[partyId] || [])
            if ((employers[managerPartyId] || []).includes(organization)) affected.push(organization)
    }
    if (affected.some(organization => !userScope.organizationPartyIds.includes(organization)))
        denied(
            "LINE_SHARED",
            "This reporting line is also kept at another employer of " +
                (names[partyId] || partyId) +
                "; it is changed by someone who reads both employers"
        )
    for (const row of open) endRow(row, fromMs, reason)
    let partyRelationshipId = null
    if (managerPartyId) {
        call("mantle.party.PartyServices.ensure#PartyRole", {partyId: managerPartyId, roleTypeId: "Manager"})
        partyRelationshipId = call("create#" + RELATIONSHIP, {
            relationshipTypeEnumId: MANAGER,
            fromPartyId: managerPartyId,
            fromRoleTypeId: "Manager",
            toPartyId: partyId,
            toRoleTypeId: "Employee",
            fromDate: new Date(fromMs),
            comments: reason || null
        }).partyRelationshipId
    }
    return {partyRelationshipId, organizationPartyId}
}

// The new manager and every manager above them at the employer on the date: the person must not be among them.
function checkCycle(partyId, managerPartyId, organizationPartyId, fromMs, personName) {
    if (!managerPartyId) return
    let above = managerPartyId
    for (let depth = 0; above && depth < maxDepth; depth++) {
        if (above === partyId)
            denied("REPORTING_CYCLE", "The manager reports to " + personName + "; a reporting line cannot loop")
        above =
            people
                .linesOf({reportPartyIds: [above]}, fromMs)
                .find(line => line.organizationPartyIds.includes(organizationPartyId))?.managerPartyId || null
    }
}
// The revision of a manager kept by an employment's assignment (P6): the employment's, what the tree gives as the line's.
const assignmentRevision = partyRelationshipId => "A:" + people.employmentRevision(partyRelationshipId)
// change#Manager of an employment with an assignment: the employment's revision read, the manager unchanged or a later change set
// refused, the cycle checked, then the assignment's manager change from the date (Employment.js: the line follows, ended only where
// no other employment uses it; a line an assignment names is that employment's alone, so no other employer's line changes).
function changeAssignedManager(assignment, managerPartyId, fromMs, reason, p, personName) {
    const partyId = assignment.partyId
    const organizationPartyId = assignment.organizationPartyId
    const revision = assignmentRevision(assignment.partyRelationshipId)
    if (text(p.expectedRevision) !== revision)
        denied("REVISION_CHANGED", "This reporting line changed since you read it; open it again (revision " + revision + ")")
    if ((assignment.managerPartyId || null) === managerPartyId)
        denied("MANAGER_UNCHANGED", managerPartyId ? "That is the manager already" : personName + " has no manager")
    if (
        rows("mantle.humanres.employment.EmploymentAssignment", {partyRelationshipId: assignment.partyRelationshipId}).some(
            row => (ms(row.fromDate) ?? -Infinity) >= fromMs
        )
    )
        denied("MANAGER_SCHEDULED", personName + " already has a later change; change that one")
    checkCycle(partyId, managerPartyId, organizationPartyId, fromMs, personName)
    employmentChanges().changeManagerOfAssignment(assignment.partyRelationshipId, managerPartyId, fromMs, reason)
    const line = managerPartyId
        ? relationships(MANAGER, {fromPartyId: managerPartyId, toPartyId: partyId}).find(row => openAt(row, fromMs))
        : null
    return {partyRelationshipId: line?.partyRelationshipId || null, organizationPartyId}
}

const operations = {findUnits, getUnit, storeUnit, storeMembership, reportingTree, changeManager}
function run(op, p) {
    if (!Object.hasOwn(operations, op)) throw new Error("Unknown organization operation " + op)
    return operations[op](p || {})
}
;({execute: run})
