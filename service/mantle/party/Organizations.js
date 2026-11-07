// Internal organizations, mantle.party.IdentityServices (mr-boss plan/design-admin.md §7 Organizations and OrganizationDetail,
// §17.2; impl-admin P7). An internal organization is a party with the OrgInternal role; its parent is a dated PrtOrgRollup
// relationship from the child to the parent, both internal (departments and teams are People's, never here). Which organizations
// the caller administers is Mantle's identity scope (Identity.js scope()): the find on mantle.party.InternalOrganization under the
// organization entity filters of the authorization the call runs under (impl-admin §4), so a delegate of one organization sees it
// and its child organizations (get#PartyInternalOrgIds) and an administrator with MANTLE_ACTIVE_ORG every one with none active.
//
// Reads need ADMIN_SETTINGS_VIEW, changes ADMIN_SETTINGS_MANAGE (design §1.1: the configuration administrator's organization
// setup), each through ProductAccess has (ADMIN holds all). An organization out of scope and a missing one are refused alike
// (RECORD_UNAVAILABLE). A refusal of a change is a reason (applied false, reasonCode, reason). Creating an organization makes the
// party, its OrgInternal role and its parent link only: no accounting, membership, secret or currency (Accounting's setup is its
// own reviewed action, linked from Admin's SetupLinks). A new organization has a parent in scope, unless the caller administers
// every internal organization, so a delegate cannot make an organization outside its own scope; a parent is set only between two
// organizations in scope, never making a cycle, so no one adopts another's organization into their scope. Memberships are
// store#OrganizationMembership's (Identity.js). Organization defaults are the PartySettingType rows registered for the OrgInternal
// role (PartySettingTypeRole); only the typed ones and those this module validates are changed here, the others by their owners.
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const {find, one, rows, denied, call} = lib
const access = lib.access
const identityLib = () => ec.resource.script("component://mr-mantle/service/mantle/party/Identity.js")
const VIEW = "ADMIN_SETTINGS_VIEW"
const MANAGE = "ADMIN_SETTINGS_MANAGE"
const RELATIONSHIP = "mantle.party.PartyRelationship"
const ROLLUP = "PrtOrgRollup"
const membershipRelationships = ["PrtAgent", "PrtEmployee", "PrtMember", "PrtRepresentative"]
const relationshipNames = {PrtEmployee: "Employee", PrtAgent: "Agent", PrtMember: "Member", PrtRepresentative: "Representative"}
// the setting types this module validates beyond their type: the value must name a record of the organization
const recordDefaults = {
    OrgInvoiceProductStoreId: partyId => value =>
        !!one("mantle.product.store.ProductStore", {productStoreId: value, organizationPartyId: partyId})
}
const ms = lib.ms
const nowMs = () => ms(ec.user.nowTimestamp)
const iso = value => (value == null ? null : new Date(value).toISOString())
const text = value => String(value ?? "").trim()
const stamp = row => String(ms(row?.lastUpdatedStamp) ?? "")
const openAt = (row, at = nowMs()) => (ms(row.fromDate) ?? -Infinity) <= at && (ms(row.thruDate) ?? Infinity) > at
const refused = (reasonCode, reason, extra = {}) => Object.assign({applied: false, reasonCode, reason}, extra)
const likeText = value => "%" + String(value).replace(/[\\%_]/g, character => "\\" + character) + "%"
const isInternal = partyId => !!partyId && !!one("mantle.party.PartyRole", {partyId, roleTypeId: "OrgInternal"})

function requirePermission(permission) {
    if (!ec.user.userId) denied("SIGN_IN", "Sign in to administer organizations")
    if (!access.has(permission)) denied("PERMISSION_DENIED", permission + " is required")
}
// The organizations the caller administers (the filtered find on InternalOrganization) and whether that is every internal
// organization.
function scope() {
    const found = identityLib().scope()
    const ids = found.organizationIds
    const everyOrganization =
        found.all || rows("mantle.party.PartyRole", {roleTypeId: "OrgInternal"}).every(row => ids.includes(row.partyId))
    return {organizationIds: ids, everyOrganization}
}
function inScope(userScope, partyId) {
    if (!text(partyId) || !userScope.organizationIds.includes(text(partyId)) || !isInternal(text(partyId)))
        denied("RECORD_UNAVAILABLE", "Organization " + text(partyId) + " is not available")
    return text(partyId)
}
function organizationName(partyId) {
    const organization = one("mantle.party.Organization", {partyId})
    return organization?.organizationName || one("mantle.party.Party", {partyId})?.pseudoId || partyId
}
function personName(partyId) {
    const person = one("mantle.party.Person", {partyId})
    const name = person ? [person.firstName, person.lastName].filter(Boolean).join(" ") : ""
    return name || organizationName(partyId)
}
// The current parent of an organization (its open PrtOrgRollup row), or null.
function currentParent(partyId, at = nowMs()) {
    return rows(RELATIONSHIP, {fromPartyId: partyId, relationshipTypeEnumId: ROLLUP}).find(row => openAt(row, at)) || null
}
// The revision of an organization's profile: the later stamp of its Party and Organization rows.
function profileRevision(partyId) {
    return String(
        Math.max(
            ms(one("mantle.party.Party", {partyId})?.lastUpdatedStamp) ?? 0,
            ms(one("mantle.party.Organization", {partyId})?.lastUpdatedStamp) ?? 0
        )
    )
}

// ===== find#InternalOrganizations =====
// The internal organizations in scope, narrowed by text (name or pseudo id, ignoring case, in the query) and a parent; each
// with its current parent and its count of child organizations.
function findInternalOrganizations(p) {
    requirePermission(VIEW)
    const userScope = scope()
    const factory = ec.entity.conditionFactory
    let query = find("mantle.party.PartyDetail").condition(
        "partyId",
        "in",
        userScope.organizationIds.length ? userScope.organizationIds : ["_NA_"]
    )
    if (text(p.text))
        query = query.condition(
            factory.makeCondition(
                ["organizationName", "pseudoId"].map(field =>
                    factory.makeCondition(field, "like", likeText(text(p.text))).ignoreCase()
                ),
                "or"
            )
        )
    const at = nowMs()
    const rollups = rows(RELATIONSHIP, {relationshipTypeEnumId: ROLLUP}).filter(row => openAt(row, at))
    const parentOf = new Map(rollups.map(row => [row.fromPartyId, row.toPartyId]))
    const parentPartyId = text(p.parentPartyId)
    const all = Array.from(query.orderBy("organizationName").limit(1000).list())
        .filter(row => !parentPartyId || parentOf.get(row.partyId) === parentPartyId)
        .map(row => {
            const parentId = parentOf.get(row.partyId) || null
            return {
                organizationPartyId: row.partyId,
                pseudoId: row.pseudoId || "",
                organizationName: row.organizationName || row.pseudoId || row.partyId,
                parentPartyId: parentId,
                parentName: parentId ? organizationName(parentId) : "",
                parentInScope: !!parentId && userScope.organizationIds.includes(parentId),
                childCount: rollups.filter(rollup => rollup.toPartyId === row.partyId).length
            }
        })
    const limit = Math.max(1, Math.min(200, Number(p.pageSize || 50)))
    const offset = Math.max(0, Number(p.pageIndex || 0)) * limit
    return {
        organizationList: all.slice(offset, offset + limit),
        organizationListCount: all.length,
        everyOrganization: userScope.everyOrganization,
        canManage: access.has(MANAGE)
    }
}

// ===== get#InternalOrganization =====
// One organization in scope: its profile and revision, its roles, its parent rows (dated, ended kept), its child organizations,
// its members (the dated staff and representative relationships: names for an ADMIN_IDENTITY_VIEW holder, else counted) and its
// registered defaults.
function getInternalOrganization(p) {
    requirePermission(VIEW)
    const userScope = scope()
    const partyId = inScope(userScope, p.organizationPartyId)
    const party = one("mantle.party.Party", {partyId})
    const at = nowMs()
    const parents = rows(RELATIONSHIP, {fromPartyId: partyId, relationshipTypeEnumId: ROLLUP})
        .map(row => ({
            partyRelationshipId: row.partyRelationshipId,
            parentPartyId: row.toPartyId,
            parentName: organizationName(row.toPartyId),
            fromDate: ms(row.fromDate),
            thruDate: ms(row.thruDate),
            active: openAt(row, at)
        }))
        .sort((a, b) => (b.fromDate ?? 0) - (a.fromDate ?? 0))
    const current = parents.find(row => row.active) || null
    const children = rows(RELATIONSHIP, {toPartyId: partyId, relationshipTypeEnumId: ROLLUP})
        .filter(row => openAt(row, at))
        .map(row => ({organizationPartyId: row.fromPartyId, organizationName: organizationName(row.fromPartyId)}))
    const memberRows = rows(RELATIONSHIP, {toPartyId: partyId}).filter(
        row =>
            membershipRelationships.includes(row.relationshipTypeEnumId) &&
            !!one("mantle.party.Person", {partyId: row.fromPartyId})
    )
    const readMembers = access.has("ADMIN_IDENTITY_VIEW")
    const members = readMembers
        ? memberRows
              .map(row => ({
                  partyRelationshipId: row.partyRelationshipId,
                  partyId: row.fromPartyId,
                  name: personName(row.fromPartyId),
                  userId: one("moqui.security.UserAccount", {partyId: row.fromPartyId})?.userId || null,
                  relationshipTypeEnumId: row.relationshipTypeEnumId,
                  kindText: relationshipNames[row.relationshipTypeEnumId],
                  fromDate: ms(row.fromDate),
                  thruDate: ms(row.thruDate),
                  active: openAt(row, at),
                  ended: (ms(row.thruDate) ?? Infinity) <= at,
                  revision: stamp(row)
              }))
              .sort((a, b) => Number(a.ended) - Number(b.ended) || a.name.localeCompare(b.name))
        : []
    return {
        organization: {
            organizationPartyId: partyId,
            pseudoId: party?.pseudoId || "",
            organizationName: organizationName(partyId),
            revision: profileRevision(partyId),
            roles: rows("mantle.party.PartyRole", {partyId}).map(row => row.roleTypeId)
        },
        parentPartyId: current?.parentPartyId || null,
        parentName: current?.parentName || "",
        parents,
        children,
        members,
        memberCount: memberRows.filter(row => openAt(row, at)).length,
        membersShown: readMembers,
        defaults: organizationDefaults(partyId),
        everyOrganization: userScope.everyOrganization,
        canManage: access.has(MANAGE)
    }
}

// ===== create#InternalOrganization =====
// A new internal organization: the party (PartyServices.create#Organization with the OrgInternal role, owning itself as the demo
// organizations do) and its parent link from now. The parent must be in scope; with none, the caller must administer every
// internal organization (PARENT_REQUIRED).
function createInternalOrganization(p) {
    requirePermission(MANAGE)
    const userScope = scope()
    const organizationName = text(p.organizationName)
    if (!organizationName) throw new Error("An organization has a name")
    const parentPartyId = text(p.parentPartyId)
    if (parentPartyId) inScope(userScope, parentPartyId)
    else if (!userScope.everyOrganization)
        return refused("PARENT_REQUIRED", "Choose the organization it belongs to: you administer only some organizations")
    const pseudoId = text(p.pseudoId)
    if (pseudoId && one("mantle.party.Party", {pseudoId}))
        return refused("PSEUDO_ID_IN_USE", "Another party has the identifier " + pseudoId)
    const created = call("mantle.party.PartyServices.create#Organization", {
        organizationName,
        pseudoId: pseudoId || null,
        roleTypeId: "OrgInternal"
    })
    const partyId = created.partyId
    call("update#mantle.party.Party", {partyId, ownerPartyId: partyId})
    if (parentPartyId) linkParent(partyId, parentPartyId, nowMs())
    return {applied: true, organizationPartyId: partyId}
}

// ===== store#InternalOrganization =====
// An organization's name and pseudo id at the revision read (PartyServices.update#PartyDetail with those fields alone).
function storeInternalOrganization(p) {
    requirePermission(MANAGE)
    const partyId = inScope(scope(), p.organizationPartyId)
    if (text(p.expectedRevision) !== profileRevision(partyId))
        return refused("REVISION_CHANGED", "The organization changed since you read it; reload it", {
            revision: profileRevision(partyId)
        })
    const organizationName = text(p.organizationName)
    if (!organizationName) throw new Error("An organization has a name")
    const pseudoId = text(p.pseudoId)
    const holder = pseudoId ? one("mantle.party.Party", {pseudoId}) : null
    if (holder && holder.partyId !== partyId) return refused("PSEUDO_ID_IN_USE", "Another party has the identifier " + pseudoId)
    const parameters = {partyId, organizationName}
    if (pseudoId) parameters.pseudoId = pseudoId
    call("mantle.party.PartyServices.update#PartyDetail", parameters)
    return {applied: true, revision: profileRevision(partyId)}
}

// ===== store#OrganizationParent =====
// The parent of an organization from fromDate (now when empty): its current parent row ended then and a new one started, both
// kept; with no parentPartyId the current parent ends, making it top-level, which (as creating a top-level organization) only a
// caller administering every internal organization may do (PARENT_REQUIRED): it would leave the scope of its parent's
// administrators. Both organizations internal (NOT_INTERNAL) and in scope, the parent not the organization or one below it
// (PARENT_CYCLE); refused while a later parent is already set (PARENT_SCHEDULED), which this change would leave in place.
function linkParent(partyId, parentPartyId, fromDate) {
    const value = ec.entity.makeValue(RELATIONSHIP)
    value.setSequencedIdPrimary()
    value.setFields(
        {
            relationshipTypeEnumId: ROLLUP,
            fromPartyId: partyId,
            fromRoleTypeId: "OrgInternal",
            toPartyId: parentPartyId,
            toRoleTypeId: "OrgInternal",
            fromDate: iso(fromDate)
        },
        true,
        null,
        null
    )
    value.create()
    return value.get("partyRelationshipId")
}
function storeOrganizationParent(p) {
    requirePermission(MANAGE)
    const userScope = scope()
    const partyId = text(p.organizationPartyId)
    const parentPartyId = text(p.parentPartyId)
    if (!isInternal(partyId) || (parentPartyId && !isInternal(parentPartyId)))
        return refused("NOT_INTERNAL", "A parent links two internal organizations")
    inScope(userScope, partyId)
    if (parentPartyId) inScope(userScope, parentPartyId)
    if (!parentPartyId && !userScope.everyOrganization)
        return refused("PARENT_REQUIRED", "Choose the organization it belongs to: you administer only some organizations")
    const fromDate = p.fromDate != null && p.fromDate !== "" ? ms(p.fromDate) : nowMs()
    if (!Number.isFinite(fromDate) || fromDate < nowMs() - 60000) throw new Error("A parent changes now or later")
    if (
        rows(RELATIONSHIP, {fromPartyId: partyId, relationshipTypeEnumId: ROLLUP}).some(
            row => (ms(row.fromDate) ?? -Infinity) > fromDate && (ms(row.thruDate) ?? Infinity) > (ms(row.fromDate) ?? 0)
        )
    )
        return refused("PARENT_SCHEDULED", organizationName(partyId) + " already has a later parent change")
    // the parent and every organization above it, at that date: the organization must not be among them
    if (parentPartyId) {
        let above = parentPartyId
        for (let depth = 0; above && depth < 50; depth++) {
            if (above === partyId) return refused("PARENT_CYCLE", "An organization cannot belong to itself or to one below it")
            above = currentParent(above, fromDate)?.toPartyId || null
        }
    }
    const current = currentParent(partyId, fromDate)
    if (current && current.toPartyId === parentPartyId)
        return refused("PARENT_UNCHANGED", organizationName(partyId) + " already belongs to " + organizationName(parentPartyId))
    if (!current && !parentPartyId) return refused("PARENT_UNCHANGED", organizationName(partyId) + " has no parent")
    if (current) {
        const ended = ec.entity.makeValue(RELATIONSHIP)
        ended.setFields(
            {
                partyRelationshipId: current.partyRelationshipId,
                thruDate: iso(Math.max(fromDate, ms(current.fromDate) ?? fromDate))
            },
            true,
            null,
            null
        )
        ended.update()
    }
    const partyRelationshipId = parentPartyId ? linkParent(partyId, parentPartyId, fromDate) : null
    return {applied: true, partyRelationshipId}
}

// ===== organization defaults =====
// The setting types registered for internal organizations (PartySettingTypeRole OrgInternal), each with the organization's
// value or the type's default, its source and revision, and whether it is changed here: a typed one (an enumeration or a
// pattern) or one this module validates (recordDefaults). The others, free text read by their owners (template locations,
// gateway configurations, an app's JSON settings), are shown and changed by their owners.
function organizationDefaults(partyId) {
    const typeIds = Array.from(
        new Set(rows("mantle.party.PartySettingTypeRole", {roleTypeId: "OrgInternal"}).map(row => row.partySettingTypeId))
    )
    return typeIds
        .map(partySettingTypeId => {
            const type = one("mantle.party.PartySettingType", {partySettingTypeId})
            const setting = one("mantle.party.PartySetting", {partyId, partySettingTypeId})
            const value = setting?.settingValue ?? null
            return {
                partySettingTypeId,
                description: type?.description || partySettingTypeId,
                settingValue: value ?? type?.defaultValue ?? null,
                source: value != null ? "organization" : type?.defaultValue != null ? "default" : "none",
                enumTypeId: type?.enumTypeId || null,
                editable: !!(type?.enumTypeId || type?.validRegexp || recordDefaults[partySettingTypeId]),
                revision: stamp(setting)
            }
        })
        .sort((a, b) => Number(b.editable) - Number(a.editable) || a.description.localeCompare(b.description))
}
// store#OrganizationDefault: a registered, editable default of an organization in scope at the revision read (the setting's
// stamp, empty when it has none); an empty value removes the organization's own, so the type's default applies.
function storeOrganizationDefault(p) {
    requirePermission(MANAGE)
    const partyId = inScope(scope(), p.organizationPartyId)
    const partySettingTypeId = text(p.partySettingTypeId)
    const registered = organizationDefaults(partyId).find(row => row.partySettingTypeId === partySettingTypeId)
    if (!registered) return refused("NOT_REGISTERED", partySettingTypeId + " is not an organization default")
    if (!registered.editable)
        return refused("OWNER_SETTING", registered.description + " is set by the application that uses it, not here")
    if (text(p.expectedRevision) !== registered.revision)
        return refused("REVISION_CHANGED", registered.description + " changed since you read it; reload it", {
            revision: registered.revision
        })
    const settingValue = text(p.settingValue)
    if (!settingValue) {
        find("mantle.party.PartySetting").condition({partyId, partySettingTypeId}).deleteAll()
        return {applied: true, revision: ""}
    }
    const validator = recordDefaults[partySettingTypeId]
    if (validator && !validator(partyId)(settingValue))
        return refused("VALUE_INVALID", settingValue + " is not one of " + organizationName(partyId) + "'s records")
    call("mantle.party.PartyServices.store#PartySetting", {partyId, partySettingTypeId, settingValue})
    return {applied: true, revision: stamp(one("mantle.party.PartySetting", {partyId, partySettingTypeId}))}
}

const operations = {
    findInternalOrganizations,
    getInternalOrganization,
    createInternalOrganization,
    storeInternalOrganization,
    storeOrganizationParent,
    storeOrganizationDefault
}
;({
    execute: (op, parameters) => {
        if (!Object.hasOwn(operations, op)) throw new Error("Unknown organization operation " + op)
        return operations[op](parameters)
    }
})
