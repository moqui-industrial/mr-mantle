// Maintenance's scope (IronStone Maintenance design §1.1, §13.3; impl-maintenance P1, §2): the one module the maintenance
// services call to learn what the caller may do and where, before they read or write a work order, a step, a template, a
// piece of equipment or a facility. No entity filter covers WorkEffort, Asset or AssetMaintenance (impl-maintenance F2), so
// every maintenance read and write is checked here and not by a filter.
//
// - Capabilities come from the maintenance, work process, resource booking and resource policy permissions (permissions,
//   data/MaintenanceSetupData.xml) and FACILITY_EDIT, never a group name, a calling screen or a supplied app root. Broad work
//   view, assigned-work view and own-request view are separate; a write permission alone reads nothing (reads).
// - The caller's organizations are their own (get#PartyOrganizationInfo over get#PartyInternalOrgIds, as FacilityScope.js reads
//   them), narrowed to the active one when it is theirs; every organization (organizationPartyIds null) for a system
//   administrator or a holder of MAINTENANCE_ALL_ORGANIZATIONS, which reads nothing by itself; none for a caller who reads
//   nothing. FACILITY_ALL_ORGANIZATIONS, the facility and stock scope's widening, does not widen Maintenance's (the user's
//   call, impl-maintenance P1 review).
// - A facility's organization is its owner, else its nearest owning ancestor (parentFacilityId); an asset's is its owner when
//   that is an internal organization, else its facility's (equipment in the organization's custody); a work order's root is
//   the WorkEffort's rootWorkEffortId (or itself), and its service organization the root's owner, else its facility's.
// - Assignment is a current WorkEffortParty row of the caller's party on the root, or on the step or the root for a step.
// - Refusals carry reason codes (EntityLib.js denied): a record that does not exist and one outside the scope alike
//   RECORD_UNAVAILABLE, an organization outside it ORGANIZATION_DENIED, a missing permission PERMISSION_DENIED, an unassigned
//   technician NOT_ASSIGNED.
//
// Later phases extend the tables (permissions, reads) and call the functions; this module grants nothing by itself.
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const {find, one, denied} = lib
const access = lib.access

// a facility tree deeper than this is taken to be a cycle
const facilityDepth = 12

// ===== capabilities =====
const permissions = {
    view: "MAINTENANCE_VIEW",
    assignedView: "MAINTENANCE_ASSIGNED_VIEW",
    request: "MAINTENANCE_REQUEST",
    requestViewOwn: "MAINTENANCE_REQUEST_VIEW_OWN",
    plan: "MAINTENANCE_PLAN",
    execute: "MAINTENANCE_EXECUTE",
    supervise: "MAINTENANCE_SUPERVISE",
    costView: "MAINTENANCE_COST_VIEW",
    resourceView: "MAINTENANCE_RESOURCE_VIEW",
    resourceEdit: "MAINTENANCE_RESOURCE_EDIT",
    settingsEdit: "MAINTENANCE_SETTINGS_EDIT",
    import: "MAINTENANCE_IMPORT",
    processView: "WORK_PROCESS_VIEW",
    processEdit: "WORK_PROCESS_EDIT",
    processApprove: "WORK_PROCESS_APPROVE",
    bookingViewAssigned: "RESOURCE_BOOKING_VIEW_ASSIGNED",
    bookingApprove: "RESOURCE_BOOKING_APPROVE",
    policyView: "RESOURCE_POLICY_VIEW",
    policyEdit: "RESOURCE_POLICY_EDIT",
    facilityEdit: "FACILITY_EDIT",
    // the scope of a read in every internal organization; no read by itself
    allOrganizations: "MAINTENANCE_ALL_ORGANIZATIONS"
}
// The derived reads, each from view permissions only: maintenance work (broad or assigned), equipment and facilities, and
// anything of Maintenance at all (an organization's scope). The requester's own-request view is Commons' intake, not a read
// of Maintenance's organizations.
const reads = {
    workRead: ["view", "assignedView"],
    resourceRead: ["view", "assignedView", "resourceView"],
    anyRead: ["view", "assignedView", "resourceView", "processView", "bookingViewAssigned", "policyView"]
}
function capabilities() {
    const found = {}
    for (const [name, permission] of Object.entries(permissions)) found[name] = access.has(permission)
    for (const [name, from] of Object.entries(reads)) found[name] = from.some(capability => found[capability])
    return found
}

// ===== scope =====
// The caller's own organizations (as FacilityScope.js reads them, without its FACILITY_ALL_ORGANIZATIONS widening): those they
// belong to, narrowed to the active one when it is theirs; an active organization they do not belong to is set aside.
function ownOrganizations() {
    const info = ec.user.userId
        ? ec.service.sync().name("mantle.party.PartyServices.get#PartyOrganizationInfo").disableAuthz().call() || {}
        : {}
    const memberPartyIds = Array.from(info.userOrgIds || [])
    const filtered = Array.from(info.filterOrgIds || []).filter(partyId => memberPartyIds.includes(partyId))
    return {
        activeOrganizationPartyId: memberPartyIds.includes(info.activeOrgId) ? info.activeOrgId : null,
        organizationPartyIds: filtered.length ? filtered : memberPartyIds
    }
}
// The caller's capabilities, party and organizations (organizationPartyIds null: every organization).
function scope() {
    const caps = capabilities()
    const own = caps.anyRead ? ownOrganizations() : null
    const all = !!own && (access.systemAdmin() || caps.allOrganizations)
    return {
        capabilities: caps,
        partyId: ec.user.userAccount?.partyId || null,
        allOrganizations: all,
        activeOrganizationPartyId: own?.activeOrganizationPartyId || null,
        organizationPartyIds: own ? (all ? null : own.organizationPartyIds) : []
    }
}
// The organizations a requester reports for and follows reports of (impl-maintenance P4, F78): their own, as ownOrganizations
// reads them, for a holder of MAINTENANCE_REQUEST or MAINTENANCE_REQUEST_VIEW_OWN, whose own-request view is not a read of
// Maintenance (scope() gives them none); none for anyone else.
function requesterOrganizations() {
    const caps = capabilities()
    if (!ec.user.userId || !(caps.request || caps.requestViewOwn)) return []
    return ownOrganizations().organizationPartyIds
}
// Whether the scope covers an organization.
function covers(userScope, partyId) {
    return !!partyId && (userScope.organizationPartyIds == null || userScope.organizationPartyIds.includes(partyId))
}
function requireCapability(userScope, capability) {
    if (!Object.hasOwn(userScope.capabilities, capability)) throw new Error("Unknown maintenance capability " + capability)
    if (!userScope.capabilities[capability]) denied("PERMISSION_DENIED", "Maintenance " + capability + " is required")
}
function requireOrganization(userScope, partyId) {
    if (!covers(userScope, partyId)) denied("ORGANIZATION_DENIED", "Organization " + (partyId || "") + " is not available")
    return partyId
}
const unavailable = (kind, id) => denied("RECORD_UNAVAILABLE", kind + " " + (id || "") + " is not available")

// ===== record organizations =====
// A facility's organization: its owner, else the nearest owning ancestor's; null for a missing facility or one no ancestor owns.
function facilityOrganization(facilityId) {
    const seen = new Set()
    let id = facilityId
    for (let depth = 0; id && !seen.has(id) && depth < facilityDepth; depth++) {
        seen.add(id)
        const facility = one("mantle.facility.Facility", {facilityId: id})
        if (!facility) return null
        if (facility.ownerPartyId) return facility.ownerPartyId
        id = facility.parentFacilityId
    }
    return null
}
const isInternal = partyId => !!partyId && !!one("mantle.party.PartyRole", {partyId, roleTypeId: "OrgInternal"})
// An asset's organization: its internal owner, else the organization of the facility that holds it.
function assetOrganization(assetId) {
    const asset = assetId ? one("mantle.product.asset.Asset", {assetId}) : null
    if (!asset) return null
    if (isInternal(asset.ownerPartyId)) return asset.ownerPartyId
    return asset.facilityId ? facilityOrganization(asset.facilityId) : null
}
// The root of a work effort (itself when it has none), or null when it does not exist.
function rootOf(workEffortId) {
    const workEffort = workEffortId ? one("mantle.work.effort.WorkEffort", {workEffortId}) : null
    if (!workEffort) return null
    const rootId = workEffort.rootWorkEffortId || workEffort.workEffortId
    return rootId === workEffort.workEffortId ? workEffort : one("mantle.work.effort.WorkEffort", {workEffortId: rootId})
}
// A root's service organization: its owner, else its facility's organization.
function rootOrganization(workEffortId) {
    const root = rootOf(workEffortId)
    if (!root) return null
    return root.ownerPartyId || (root.facilityId ? facilityOrganization(root.facilityId) : null)
}

// ===== assignment =====
function assignedTo(workEffortIds, partyId) {
    const ids = workEffortIds.filter(Boolean)
    if (!partyId || !ids.length) return false
    return (
        find("mantle.work.effort.WorkEffortParty")
            .condition("workEffortId", "in", ids)
            .condition("partyId", partyId)
            .conditionDate("fromDate", "thruDate", ec.user.nowTimestamp)
            .count() > 0
    )
}
// The caller's assignment to a work effort: to its root (root), or to the step itself or its root (step).
function assignment(userScope, workEffortId) {
    const workEffort = workEffortId ? one("mantle.work.effort.WorkEffort", {workEffortId}) : null
    if (!workEffort) return {root: false, step: false}
    const rootId = workEffort.rootWorkEffortId || workEffort.workEffortId
    const root = assignedTo([rootId], userScope.partyId)
    return {root, step: root || (rootId !== workEffort.workEffortId && assignedTo([workEffort.workEffortId], userScope.partyId))}
}

// ===== record checks =====
// Each refuses a missing record and one outside the scope alike, and answers the record's organization.
function requireFacility(userScope, facilityId) {
    if (!userScope.capabilities.resourceRead) denied("PERMISSION_DENIED", "Maintenance resource view is required")
    const organizationPartyId = facilityOrganization(facilityId)
    if (!covers(userScope, organizationPartyId)) unavailable("Facility", facilityId)
    return {facilityId, organizationPartyId}
}
function requireAsset(userScope, assetId) {
    if (!userScope.capabilities.resourceRead) denied("PERMISSION_DENIED", "Maintenance resource view is required")
    const organizationPartyId = assetOrganization(assetId)
    if (!covers(userScope, organizationPartyId)) unavailable("Asset", assetId)
    return {assetId, organizationPartyId}
}
// A work effort the caller may read: a root or step of their service organizations with MAINTENANCE_VIEW, or one assigned to
// them with MAINTENANCE_ASSIGNED_VIEW (NOT_ASSIGNED when it is in scope but not theirs).
function requireWork(userScope, workEffortId) {
    if (!userScope.capabilities.workRead) denied("PERMISSION_DENIED", "Maintenance work view is required")
    const organizationPartyId = rootOrganization(workEffortId)
    if (!covers(userScope, organizationPartyId)) unavailable("Work", workEffortId)
    if (!userScope.capabilities.view && !assignment(userScope, workEffortId).step)
        denied("NOT_ASSIGNED", "Work " + workEffortId + " is not assigned to you")
    return {workEffortId, rootWorkEffortId: rootOf(workEffortId).workEffortId, organizationPartyId}
}
// Whether a work effort is managed maintenance work the caller may not reach outside Maintenance (impl-maintenance F69; the
// record check of get#RecordLinkInfo and search#Universal, in every app): its root has a MaintenanceWorkOrder row and the caller
// is neither a current party of the root or of the work effort itself nor admitted by requireWork. An organization role alone
// does not open it. Ordinary work, and a missing work effort, answer false (their own rules apply).
function workHidden(workEffortId, partyId) {
    if (!workEffortId || !ec.entity.isEntityDefined("mantle.work.maintenance.MaintenanceWorkOrder")) return false
    const workEffort = one("mantle.work.effort.WorkEffort", {workEffortId})
    if (!workEffort) return false
    const rootId = workEffort.rootWorkEffortId || workEffort.workEffortId
    if (!one("mantle.work.maintenance.MaintenanceWorkOrder", {workEffortId: rootId})) return false
    if (assignedTo(ids([rootId, workEffortId]), partyId)) return false
    try {
        requireWork(scope(), workEffortId)
        return false
    } catch (error) {
        return true
    }
}
// Whether a reported maintenance problem is hidden from the caller outside Maintenance (impl-maintenance P4 review; design §3
// Requests "States": a reporter sees their own request, not other reports; §1.1 own-request view is its own permission; the record
// check of get#RecordLinkInfo and search#Universal, in every app): a Request of type RqtMaintenance that Maintenance's intake made
// (a report or a mail; no AssetMaintenance of Manufacturing's is linked to it) is reached by its filer, a current party of it in
// person (its Reporter, Assignee or a Watcher), a maintenance planner, supervisor or reader of its organization, or one Maintenance
// admits to its work order (workHidden); its organization's other members do not reach it through its OrgInternal party or its
// facility. Manufacturing's production request (an AssetMaintenance linked, ProductionDowntime.js requestMaintenance) keeps its
// owner's rule, and any other request, or a missing one, answers false (their own rules apply).
function requestHidden(request, partyId) {
    if (!request || request.requestTypeEnumId !== "RqtMaintenance") return false
    if (partyId && request.filedByPartyId === partyId) return false
    const requestId = request.requestId
    const now = ec.user.nowTimestamp
    if (
        find("mantle.request.RequestRecord", {requestId, recordEntityName: "mantle.product.maintenance.AssetMaintenance"}).count() >
        0
    )
        return false
    if (partyId && find("mantle.request.RequestParty", {requestId, partyId}).conditionDate("fromDate", "thruDate", now).count() > 0)
        return false
    const userScope = scope()
    const caps = userScope.capabilities
    if (caps.plan || caps.supervise || caps.view) {
        const organizations = Array.from(
            find("mantle.request.RequestParty", {requestId, roleTypeId: "OrgInternal"}).conditionDate("fromDate", "thruDate", now).list()
        ).map(row => row.partyId)
        if (organizations.some(organizationPartyId => covers(userScope, organizationPartyId))) return false
    }
    const workIds = Array.from(find("mantle.request.RequestWorkEffort", {requestId}).list()).map(row => row.workEffortId)
    const managed = workIds.length
        ? Array.from(find("mantle.work.maintenance.MaintenanceWorkOrder").condition("workEffortId", "in", workIds).list()).map(
              row => row.workEffortId
          )
        : []
    return !managed.some(workEffortId => !workHidden(workEffortId, partyId))
}
const ids = list => Array.from(new Set(list.filter(Boolean)))

;({
    permissions,
    reads,
    capabilities,
    scope,
    requesterOrganizations,
    covers,
    requireCapability,
    requireOrganization,
    facilityOrganization,
    assetOrganization,
    rootOf,
    rootOrganization,
    assignment,
    requireFacility,
    requireAsset,
    requireWork,
    workHidden,
    requestHidden,
    denied,
    reasonCode: lib.reasonCode
})
