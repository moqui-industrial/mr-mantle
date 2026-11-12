// Maintenance work orders (IronStone Maintenance design §3 WorkOrders and WorkOrderDetail, §9 Settings, §13.2
// MaintenanceServices, MaintenanceSettingsServices and MaintenanceReportServices; impl-maintenance P3). A work order is a root
// WorkEffort (WetTask, purpose WepMaintenance, no project, owned by its service organization, the WorkEffortMaintenance flow) and
// its MaintenanceWorkOrder row; equipment work has one primary AssetMaintenance that follows the root. Every operation checks the
// maintenance permission and scope first (MaintenanceAccess.js): a missing work order and one outside the scope are refused
// alike (RECORD_UNAVAILABLE), a technician with the assigned view reads only work assigned to them (NOT_ASSIGNED).
//
// - The lifecycle (design §3's table) is transition's: approve, start, hold, resume, complete, close and cancel, each with its
//   gate. The service is the gate, not the status flow (F6, F65): the framework admits any transition one flow has. Status and
//   the entered actual dates are written in the service's own update#WorkEffort, so WorkEffortStartCompleteDates never writes
//   the commit time over an entered finish (F7). A held order remembers where it was and resumes there.
// - Approval: corrective work created or triaged by a planner or supervisor is approved on create; template, preventive and
//   planned work above the organization's threshold in hours (MaintenancePolicy, zero by default: all of it) needs a
//   supervisor; work with no estimated hours is over it. The estimate is the root's with its steps' (P6, F107). The cost half
//   is P11's.
// - From a procedure (P6, design §4.2): create takes templateWorkEffortId and makes the root and its steps in its transaction
//   through ProcessServices' checked path (MaintenanceProcedures.js: approved, effective, applicable to the target, the caller's
//   instantiation permission), the procedure of the work's organization; the root then becomes the work order. A procedure's
//   work is never approved on create as corrective work is.
// - Assignments are schedule's (the generic WorkEffortParty writers refuse managed work, F59): a team (role OrgTeam, a team of the
//   organization) and the people (Assignee, the organization's employees or agents), with the planned window. A new assignee is
//   told on MaintenanceWork after the write.
// - Time (F66): the time services check no work access, so the work order's own entry points check the caller's assignment,
//   the work in progress and no template, then call TimesheetServices start#Timer and stop#Timer and TimeServices.store#TimeEntry
//   unchanged. A root's totals are the sum of the distinct TimeEntry rows of its tree, never a parent's rolled-up time plus its
//   children's.
// - Adoption (design §6, §13.2): an open AssetMaintenance with no linked work (Manufacturing's request, the baseline's) gets a
//   managed root, once (a retry answers the first root); completed and cancelled history stays unmanaged, a warranty repair
//   keeps Customer Service's path (P12).
// - Writes name the revision they read (expectedRevision; RECORD_CHANGED naming the current one), and create takes an operation
//   key (a retry answers the first root; changed input under the key is OPERATION_KEY_CONFLICT).
// - Lists (F83): a holder of every organization who chose an active organization lists that organization's work; a record
//   check still admits every organization. Row names, assignees and counts are read in one query each per page (F96).
// - Downtime (P5; ResourceOutages.js): Start takes the target out of service when the work has offline intent (records or links
//   its one open outage); Complete asks the disposition and may leave the resource down, recording its outage when none is open,
//   with a follow-up work order linked to the same outage; nothing here ends an outage (end#ResourceUnavailability does).
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const maintenanceAccess = ec.resource.script("component://mr-mantle/service/mantle/work/MaintenanceAccess.js")
const procedures = () => ec.resource.script("component://mr-mantle/service/mantle/work/MaintenanceProcedures.js")
// P14: a preventive plan's generation, completion credit and Home's counts (MaintenancePlans.js)
const plans = () => ec.resource.script("component://mr-mantle/service/mantle/work/MaintenancePlans.js")
const outages = ec.resource.script("component://mr-mantle/service/mantle/work/ResourceOutages.js")
// P10: CompleteWork's outside-service line (MaintenancePurchases.js)
const purchases = () => ec.resource.script("component://mr-mantle/service/mantle/work/MaintenancePurchases.js")
// P7: the checklist's gate, close and cancel (ProcessChecks.js), and the time services' way through (WorkProcesses.js)
const checks = () => ec.resource.script("component://mr-mantle/service/mantle/work/ProcessChecks.js")
const workProcesses = ec.resource.script("component://mr-mantle/service/mantle/work/WorkProcesses.js")
// P9: the cost centre and project a work order is charged to (MaintenanceMaterials.js)
const materials = () => ec.resource.script("component://mr-mantle/service/mantle/work/MaintenanceMaterials.js")
const {find, one, denied, call, ms} = lib

const WORK = "mantle.work.effort.WorkEffort"
const ORDER = "mantle.work.maintenance.MaintenanceWorkOrder"
const ORDER_VIEW = "mantle.work.maintenance.MaintenanceWorkOrderDetail"
const POLICY = "mantle.work.maintenance.MaintenancePolicy"
const MAINTENANCE = "mantle.product.maintenance.AssetMaintenance"
const PARTY = "mantle.work.effort.WorkEffortParty"
const TIME = "mantle.work.time.TimeEntry"
const ASSET = "mantle.product.asset.Asset"
const FACILITY = "mantle.facility.Facility"

const openStatuses = ["WeInPlanning", "WeApproved", "WeInProgress", "WeOnHold"]
const doneStatuses = ["WeComplete", "WeClosed", "WeCancelled"]
const stockTypes = ["AstTpInventory", "AstTpSupplies"]
// a priority of this or more urgent (1 is the most) is high
const highPriority = 3
const teamRole = "OrgTeam"
const assigneeRole = "Assignee"
// the relationships that make a person one of an organization's people for assignment
const memberRelationships = ["PrtEmployee", "PrtAgent"]
const facilityDepth = 12
const homeLimit = 2000
const minuteMs = 60 * 1000

const blank = value => value == null || String(value).trim() === ""
const text = value => (blank(value) ? null : String(value).trim())
const flag = value => value === true || value === "true" || value === "Y"
const factory = () => ec.entity.conditionFactory
const like = (field, term) =>
    factory()
        .makeCondition(field, "like", "%" + String(term).replace(/[\\%_]/g, c => "\\" + c) + "%")
        .ignoreCase()
const anyOf = conditions => factory().makeCondition(conditions, "or")
const nowMs = () => ms(ec.user.nowTimestamp)
const stamp = millis => (millis == null ? null : new Date(millis))
const dateText = value => (value == null || value === "" ? "" : lib.dateText(value))
const number = value => (value == null || value === "" ? null : Number(String(value)))
const enumText = enumId => (enumId ? one("moqui.basic.Enumeration", {enumId})?.description || enumId : "")
const statusText = statusId => (statusId ? one("moqui.basic.StatusItem", {statusId})?.description || statusId : "")
const ids = list => Array.from(new Set(list.filter(Boolean)))

// ===== scope =====
function signedIn() {
    if (!ec.user.userId) denied("PERMISSION_DENIED", "Sign in to use maintenance work")
}
// The caller's scope with one of the capabilities (PERMISSION_DENIED without any).
function scopeWithAny(capabilities) {
    signedIn()
    const userScope = maintenanceAccess.scope()
    if (!capabilities.some(name => userScope.capabilities[name]))
        denied("PERMISSION_DENIED", "Maintenance " + capabilities.join(" or ") + " is required")
    return userScope
}
// A list's scope (F83, People's rule): a holder of every organization who has chosen an active internal organization lists
// that organization's work; anyone else's scope is as it is.
function listScope(userScope) {
    if (userScope.organizationPartyIds != null) return userScope
    const activeId = userScope.activeOrganizationPartyId
    const info = activeId
        ? null
        : ec.service.sync().name("mantle.party.PartyServices.get#PartyOrganizationInfo").disableAuthz().call() || {}
    const active = activeId || info?.activeOrgId || null
    if (!active || !one("mantle.party.PartyRole", {partyId: active, roleTypeId: "OrgInternal"})) return userScope
    return Object.assign({}, userScope, {organizationPartyIds: [active]})
}
const unavailable = workEffortId => denied("RECORD_UNAVAILABLE", "Work order " + (workEffortId || "") + " is not available")

// A work order the caller may read (the root's MaintenanceWorkOrder row, its service organization in the scope; a technician's
// assigned): {root, order, organizationPartyId}. A step reads as its root's.
function readOrder(userScope, workEffortId) {
    const id = text(workEffortId)
    if (!id) unavailable(id)
    const found = maintenanceAccess.requireWork(userScope, id)
    const order = one(ORDER, {workEffortId: found.rootWorkEffortId})
    if (!order) unavailable(id)
    const root = one(WORK, {workEffortId: found.rootWorkEffortId})
    if (root.isTemplate === "Y") unavailable(id)
    return {root, order, organizationPartyId: found.organizationPartyId, workEffortId: id}
}
function requireRevision(order, expectedRevision) {
    if (blank(expectedRevision)) return
    if (Number(expectedRevision) !== Number(order.revision || 0))
        denied(
            "RECORD_CHANGED",
            "Work order " + order.workEffortId + " was changed (now revision " + (order.revision || 0) + "); reload it"
        )
}
function requireOpen(root) {
    if (!openStatuses.includes(root.statusId))
        denied("WORK_CLOSED", "Work order " + root.workEffortId + " is " + statusText(root.statusId))
}
function requireEnum(enumId, enumTypeId, label) {
    if (blank(enumId)) return null
    if (!one("moqui.basic.Enumeration", {enumId, enumTypeId})) denied("VALUE_INVALID", label + " " + enumId + " is not known")
    return enumId
}
function hoursOf(value) {
    if (blank(value)) return null
    let decimal
    try {
        decimal = toDecimal(value)
    } catch (_) {
        denied("VALUE_INVALID", "Estimated hours must be a number")
    }
    if (decimal.compare(0) < 0) denied("VALUE_INVALID", "Estimated hours cannot be negative")
    return decimal
}
function requireWindow(fromDate, thruDate) {
    if (fromDate != null && thruDate != null && ms(thruDate) <= ms(fromDate))
        denied("DATES_INVALID", "The planned window ends before it starts")
}

// ===== the organization's policy =====
const defaultPolicy = {
    approvalThresholdHours: 0,
    closurePolicyEnumId: "MclSupervisor",
    defaultMaintenanceTypeEnumId: null,
    defaultTeamPartyId: null,
    productionRequestsManaged: false,
    warrantyRepairsManaged: false,
    procedureSelfApproval: false,
    voiceNoteTranscription: false,
    pmLeadDays: null
}
// The policy in effect for an organization, or the defaults (fromDate null).
function policyOf(organizationPartyId, at = ec.user.nowTimestamp) {
    const row = organizationPartyId
        ? Array.from(
              find(POLICY, {organizationPartyId}).conditionDate("fromDate", "thruDate", at).orderBy("-fromDate").limit(1).list()
          )[0]
        : null
    if (!row) return Object.assign({organizationPartyId, fromDate: null}, defaultPolicy)
    return {
        organizationPartyId,
        fromDate: row.fromDate,
        approvalThresholdHours: number(row.approvalThresholdHours) ?? 0,
        closurePolicyEnumId: row.closurePolicyEnumId || defaultPolicy.closurePolicyEnumId,
        defaultMaintenanceTypeEnumId: row.defaultMaintenanceTypeEnumId || null,
        defaultTeamPartyId: row.defaultTeamPartyId || null,
        productionRequestsManaged: flag(row.productionRequestsManaged),
        warrantyRepairsManaged: flag(row.warrantyRepairsManaged),
        procedureSelfApproval: flag(row.procedureSelfApproval),
        voiceNoteTranscription: flag(row.voiceNoteTranscription),
        pmLeadDays: number(row.pmLeadDays),
        comments: row.comments || null
    }
}
// Within the threshold: a positive threshold and estimated hours no more than it (no estimate is over it).
function withinThreshold(policy, hours) {
    const threshold = Number(policy.approvalThresholdHours || 0)
    return threshold > 0 && hours != null && Number(String(hours)) <= threshold
}
function policyOrganization(userScope, organizationPartyId) {
    const id = text(organizationPartyId)
    if (!id) denied("ORGANIZATION_REQUIRED", "Choose an organization")
    maintenanceAccess.requireOrganization(userScope, id)
    return id
}
function getPolicy(p) {
    const userScope = scopeWithAny(["settingsEdit", "anyRead"])
    const organizationPartyId = policyOrganization(userScope, p.organizationPartyId)
    const policy = policyOf(organizationPartyId)
    return {
        policy: Object.assign({}, policy, {
            fromDateText: dateText(policy.fromDate),
            closurePolicyText: enumText(policy.closurePolicyEnumId),
            defaultMaintenanceTypeText: enumText(policy.defaultMaintenanceTypeEnumId),
            defaultTeamName: policy.defaultTeamPartyId ? partyNames([policy.defaultTeamPartyId])[policy.defaultTeamPartyId] : ""
        }),
        canEdit: !!userScope.capabilities.settingsEdit
    }
}
// store#MaintenancePolicy: the organization's policy from now, ending the row in effect (MAINTENANCE_SETTINGS_EDIT).
function storePolicy(p) {
    const userScope = scopeWithAny(["settingsEdit"])
    const organizationPartyId = policyOrganization(userScope, p.organizationPartyId)
    const threshold = hoursOf(p.approvalThresholdHours) ?? toDecimal(0)
    const closurePolicyEnumId =
        requireEnum(p.closurePolicyEnumId, "MaintenanceClosurePolicy", "Closure policy") || defaultPolicy.closurePolicyEnumId
    const typeId = requireEnum(p.defaultMaintenanceTypeEnumId, "MaintenanceType", "Maintenance type")
    const teamId = text(p.defaultTeamPartyId)
    if (teamId) requireTeam(organizationPartyId, teamId)
    // P14: the days ahead preventive work is made for a plan that names none
    const leadDays = blank(p.pmLeadDays) ? null : Number(String(p.pmLeadDays))
    if (leadDays != null && (!Number.isInteger(leadDays) || leadDays < 0 || leadDays > 365))
        denied("VALUE_INVALID", "Enter the days ahead as a whole number from 0 to 365")
    const now = ec.user.nowTimestamp
    for (const row of Array.from(find(POLICY, {organizationPartyId}).conditionDate("fromDate", "thruDate", now).list()))
        call("update#" + POLICY, {organizationPartyId, fromDate: row.fromDate, thruDate: now})
    call("create#" + POLICY, {
        organizationPartyId,
        fromDate: now,
        approvalThresholdHours: threshold,
        closurePolicyEnumId,
        defaultMaintenanceTypeEnumId: typeId,
        defaultTeamPartyId: teamId,
        productionRequestsManaged: flag(p.productionRequestsManaged) ? "Y" : "N",
        warrantyRepairsManaged: flag(p.warrantyRepairsManaged) ? "Y" : "N",
        procedureSelfApproval: flag(p.procedureSelfApproval) ? "Y" : "N",
        voiceNoteTranscription: flag(p.voiceNoteTranscription) ? "Y" : "N",
        pmLeadDays: leadDays,
        changedByUserId: ec.user.userId,
        comments: text(p.comments)
    })
    return {organizationPartyId, fromDate: now}
}

// ===== targets, teams and people =====
// The work's target: equipment (not stock; its facility is the work's) or a facility, in the caller's scope; its organization.
function targetOf(userScope, p) {
    const assetId = text(p.assetId)
    if (assetId) {
        const found = maintenanceAccess.requireAsset(userScope, assetId)
        const asset = one(ASSET, {assetId})
        if (stockTypes.includes(asset.assetTypeEnumId) || !asset.assetTypeEnumId)
            denied("TARGET_INVALID", "Asset " + assetId + " is stock, not equipment")
        return {assetId, facilityId: asset.facilityId || null, organizationPartyId: found.organizationPartyId, asset}
    }
    const facilityId = text(p.facilityId)
    if (!facilityId) denied("TARGET_REQUIRED", "Choose the equipment or the facility the work is for")
    const found = maintenanceAccess.requireFacility(userScope, facilityId)
    return {assetId: null, facilityId, organizationPartyId: found.organizationPartyId, asset: null}
}
// A team of the organization: an OrgTeam party it owns.
function requireTeam(organizationPartyId, partyId) {
    const party = one("mantle.party.Party", {partyId})
    if (!party || party.ownerPartyId !== organizationPartyId || !one("mantle.party.PartyRole", {partyId, roleTypeId: teamRole}))
        denied("TEAM_UNAVAILABLE", "Team " + partyId + " is not one of the organization's teams")
    return partyId
}
// One of the organization's people now: a person with a current employee or agent relationship to it.
function requireMember(organizationPartyId, partyId) {
    const person = one("mantle.party.Person", {partyId})
    const member =
        !!person &&
        find("mantle.party.PartyRelationship")
            .condition({fromPartyId: partyId, toPartyId: organizationPartyId})
            .condition("relationshipTypeEnumId", "in", memberRelationships)
            .conditionDate("fromDate", "thruDate", ec.user.nowTimestamp)
            .count() > 0
    if (!member) denied("ASSIGNEE_UNAVAILABLE", "Person " + partyId + " does not work for the organization")
    return partyId
}
function currentParties(workEffortId, roleTypeId) {
    return Array.from(
        find(PARTY, {workEffortId, roleTypeId})
            .conditionDate("fromDate", "thruDate", ec.user.nowTimestamp)
            .condition(factory().makeCondition("statusId", "not-in", ["WeptDeclined", "WeptUnassigned"], true))
            .list()
    )
}
// Names of parties, read in one query (EntityLib.partyNames: a party another user keeps private is left out).
const partyNames = partyIds => lib.partyNames(partyIds)

// ===== the tree, timers and time =====
// The ids of a root's tree: the root and every work effort that names it as its root.
function treeIds(rootId) {
    return [rootId].concat(
        Array.from(find(WORK, {rootWorkEffortId: rootId}).selectField("workEffortId").list()).map(row => row.workEffortId)
    )
}
// The estimated hours of a root with its steps (F107: a procedure's work is estimated by its steps): the steps' sum when any step
// has an estimate (Mantle's WorkEffortUpdateProject rollup also writes that sum on the root, so the two are not added), else the
// root's own; null when none has one.
function treeHours(rootId) {
    const steps = Array.from(find(WORK, {rootWorkEffortId: rootId}).selectField("workEffortId,estimatedWorkTime").list())
        .map(row => number(row.estimatedWorkTime))
        .filter(value => value != null)
    if (steps.length) return steps.reduce((total, value) => total + value, 0)
    return number(one(WORK, {workEffortId: rootId})?.estimatedWorkTime)
}
function runningTimers(rootId) {
    return Array.from(
        find(TIME)
            .condition("workEffortId", "in", treeIds(rootId))
            .condition("thruDate", "is-null", null)
            .condition("fromDate", "is-not-null", null)
            .list()
    )
}
// The time of a root's tree: its distinct entries (a technician with the assigned view only their own), and the totals.
function timeOf(userScope, rootId) {
    const partyId = userScope.partyId
    const all = Array.from(find(TIME).condition("workEffortId", "in", treeIds(rootId)).orderBy("-fromDate").list())
    const own = all.filter(row => row.partyId === partyId)
    const shown = userScope.capabilities.view ? all : own
    const names = partyNames(shown.map(row => row.partyId))
    const hoursOfRow = row => number(row.hours) ?? 0
    const sum = rowsList => Math.round(rowsList.reduce((total, row) => total + hoursOfRow(row), 0) * 100) / 100
    return {
        timeEntries: shown.map(row => ({
            timeEntryId: row.timeEntryId,
            workEffortId: row.workEffortId,
            partyId: row.partyId,
            partyName: names[row.partyId] || row.partyId,
            fromDate: row.fromDate,
            thruDate: row.thruDate,
            fromDateText: dateText(row.fromDate),
            thruDateText: row.thruDate ? dateText(row.thruDate) : "running",
            hours: row.thruDate ? hoursOfRow(row) : null,
            workTypeText: enumText(row.workTypeEnumId),
            comments: row.comments || ""
        })),
        ownHours: sum(own.filter(row => row.thruDate)),
        // the team's total only for a broad reader; a technician sees their own
        totalHours: userScope.capabilities.view ? sum(all.filter(row => row.thruDate)) : null,
        runningCount: all.filter(row => !row.thruDate && row.fromDate).length
    }
}
// The caller's own time on a work effort of a work order: execute, assigned to it (the step or its root), not a template.
function timeWork(userScope, workEffortId, needsProgress) {
    if (!userScope.capabilities.execute) denied("PERMISSION_DENIED", "Maintenance execute is required to record time")
    const found = readOrder(userScope, workEffortId)
    const work = one(WORK, {workEffortId: found.workEffortId})
    if (work.isTemplate === "Y") denied("TEMPLATE_TIME", "A template takes no time")
    if (!maintenanceAccess.assignment(userScope, found.workEffortId).step)
        denied("NOT_ASSIGNED", "Work " + found.workEffortId + " is not assigned to you")
    if (needsProgress && (found.root.statusId !== "WeInProgress" || work.statusId !== "WeInProgress"))
        denied(
            "WORK_NOT_STARTED",
            "Time is recorded on work in progress; work " + found.workEffortId + " is " + statusText(work.statusId)
        )
    return found
}
// start#MaintenanceTimer: the caller's timer on assigned work in progress (start#Timer: one timer a person, a running one stops).
function startTimer(p) {
    const userScope = scopeWithAny(["execute"])
    const found = timeWork(userScope, p.workEffortId, true)
    // P7 (F159): the time services refuse managed work but through its owner, which checked the caller above
    const out = workProcesses.asManagedOwner([found.root.workEffortId], () =>
        call("mantle.work.TimesheetServices.start#Timer", {
            workEffortId: found.workEffortId,
            comments: text(p.comments),
            workTypeEnumId: text(p.workTypeEnumId)
        })
    )
    return {timeEntryId: out.timeEntryId, alreadyRunning: !!out.alreadyRunning}
}
// stop#MaintenanceTimer: the caller's running timer on the work order's tree.
function stopTimer(p) {
    const userScope = scopeWithAny(["execute"])
    const found = timeWork(userScope, p.workEffortId, false)
    const running = runningTimers(found.root.workEffortId).find(row => row.partyId === userScope.partyId)
    if (!running) denied("NO_TIMER", "No timer of yours is running on work order " + found.root.workEffortId)
    const out = workProcesses.asManagedOwner([found.root.workEffortId], () =>
        call("mantle.work.TimesheetServices.stop#Timer", {timeEntryId: running.timeEntryId})
    )
    return {timeEntryId: running.timeEntryId, hours: out.hours ?? null, discarded: !!out.discarded}
}
// record#MaintenanceTime: the caller's own time on assigned work in progress, by its start and end or its hours on a day.
function recordTime(p) {
    const userScope = scopeWithAny(["execute"])
    const found = timeWork(userScope, p.workEffortId, true)
    const fromDate = p.fromDate || null
    const thruDate = p.thruDate || null
    const hours = blank(p.hours) ? null : hoursOf(p.hours)
    if (fromDate == null) denied("DATES_INVALID", "Enter when the work started")
    if (thruDate == null && (hours == null || hours.compare(0) <= 0)) denied("HOURS_INVALID", "Enter the end or the hours")
    if (thruDate != null && ms(thruDate) <= ms(fromDate)) denied("DATES_INVALID", "The time ends before it starts")
    const latest = thruDate != null ? ms(thruDate) : ms(fromDate)
    if (latest > nowMs() + minuteMs) denied("DATE_FUTURE", "Time is recorded once it is worked")
    const out = workProcesses.asManagedOwner([found.root.workEffortId], () =>
        call("mantle.work.TimeServices.store#TimeEntry", {
            partyId: userScope.partyId,
            workEffortId: found.workEffortId,
            fromDate,
            thruDate,
            hours: thruDate != null ? null : hours,
            workTypeEnumId: text(p.workTypeEnumId),
            comments: text(p.comments)
        })
    )
    return {timeEntryId: out.timeEntryId}
}

// ===== AssetMaintenance synchronization =====
// The AssetMaintenance status a root's status asks for (null: keep it, a hold).
function maintenanceStatusFor(root) {
    switch (root.statusId) {
        case "WeInPlanning":
            return "AsMntCreated"
        case "WeApproved":
            return root.estimatedStartDate && root.estimatedCompletionDate ? "AsMntScheduled" : "AsMntCreated"
        case "WeInProgress":
            return "AsMntInProcess"
        case "WeComplete":
        case "WeClosed":
            return "AsMntCompleted"
        case "WeCancelled":
            return "AsMntCancelled"
        default:
            return null
    }
}
function syncMaintenance(order) {
    if (!order.assetMaintenanceId) return
    const root = one(WORK, {workEffortId: order.workEffortId})
    const maintenance = one(MAINTENANCE, {assetMaintenanceId: order.assetMaintenanceId})
    if (!maintenance) return
    const wanted = maintenanceStatusFor(root)
    const fields = {assetMaintenanceId: maintenance.assetMaintenanceId}
    let changed = false
    if (wanted && wanted !== maintenance.statusId) {
        // from created straight to completed or cancelled goes through in process where the flow needs it
        if (wanted === "AsMntCompleted" && maintenance.statusId !== "AsMntInProcess")
            call("update#" + MAINTENANCE, {assetMaintenanceId: maintenance.assetMaintenanceId, statusId: "AsMntInProcess"})
        fields.statusId = wanted
        changed = true
    }
    if (
        root.estimatedStartDate &&
        ms(root.estimatedStartDate) !== ms(maintenance.maintenanceDate) &&
        !doneStatuses.includes(root.statusId)
    ) {
        fields.maintenanceDate = root.estimatedStartDate
        changed = true
    }
    if (order.assetId && order.assetId !== maintenance.assetId) {
        fields.assetId = order.assetId
        changed = true
    }
    if (changed) call("update#" + MAINTENANCE, fields)
}
function bump(order, fields = {}) {
    const revision = Number(order.revision || 0) + 1
    call("update#" + ORDER, Object.assign({workEffortId: order.workEffortId, revision}, fields))
    return revision
}

// ===== create#MaintenanceWorkOrder =====
const createFields = [
    "assetId",
    "facilityId",
    "workEffortName",
    "description",
    "maintenanceKindEnumId",
    "maintenanceTypeEnumId",
    "sourceEnumId",
    "severityEnumId",
    "failureModeEnumId",
    "priority",
    "estimatedWorkTime",
    "estimatedStartDate",
    "estimatedCompletionDate",
    "teamPartyId",
    "templateWorkEffortId"
]
// The request's fingerprint: text and numbers as they are, a date by its instant (P6: every text once hashed as NaN, Date.parse
// of a name, so changed input under a key went unseen)
function requestHash(p) {
    const valueOf = value => {
        if (value == null) return ""
        if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value)
        const millis = ms(value)
        return Number.isFinite(millis) ? String(millis) : String(value)
    }
    const values = createFields.map(field => valueOf(p[field]))
    // P5: offline intent, hashed only when set
    if (flag(p.offlineIntent)) values.push("offline")
    return lib.hash(values)
}
// A retry of a create under its operation key: the first root, or OPERATION_KEY_CONFLICT for changed input.
function previousCreate(userScope, operationKey, hash) {
    if (!operationKey) return null
    if (operationKey.length > 60) denied("OPERATION_KEY_INVALID", "An operation key has at most 60 characters")
    const earlier = Array.from(find(ORDER, {operationKey}).limit(1).list())[0]
    if (!earlier) return null
    if (earlier.operationHash !== hash) denied("OPERATION_KEY_CONFLICT", "The operation key was used for another work order")
    readOrder(userScope, earlier.workEffortId)
    const root = one(WORK, {workEffortId: earlier.workEffortId})
    return {
        workEffortId: earlier.workEffortId,
        statusId: root.statusId,
        assetMaintenanceId: earlier.assetMaintenanceId,
        repeated: true
    }
}
// The root, its row and the primary AssetMaintenance of new work (create and adoption share it).
function makeOrder(userScope, target, p, options) {
    const templateId = text(p.templateWorkEffortId)
    const template = templateId ? one(WORK, {workEffortId: templateId}) : null
    const name = text(p.workEffortName) || (template?.isTemplate === "Y" ? template.workEffortName : null)
    if (!name) denied("NAME_REQUIRED", "Name the work")
    const kind = requireEnum(p.maintenanceKindEnumId, "MaintenanceKind", "Kind") || "MkCorrective"
    const policy = policyOf(target.organizationPartyId)
    const typeId =
        requireEnum(p.maintenanceTypeEnumId, "MaintenanceType", "Maintenance type") ||
        policy.defaultMaintenanceTypeEnumId ||
        (kind === "MkCorrective" ? "MntTpCorrective" : "MntTpPreventive")
    const sourceId = requireEnum(p.sourceEnumId, "MaintenanceSource", "Source") || options.sourceEnumId || "MsrcPlanned"
    const severityId = requireEnum(p.severityEnumId, "MaintenanceSeverity", "Severity")
    const failureId = requireEnum(p.failureModeEnumId, "MaintenanceFailureMode", "Failure mode")
    const hours = hoursOf(p.estimatedWorkTime)
    const priority = blank(p.priority) ? 5 : Number(p.priority)
    if (!Number.isInteger(priority) || priority < 1 || priority > 9) denied("VALUE_INVALID", "Priority is 1 (most urgent) to 9")
    requireWindow(p.estimatedStartDate, p.estimatedCompletionDate)
    const teamId = text(p.teamPartyId) || policy.defaultTeamPartyId
    if (teamId) requireTeam(target.organizationPartyId, teamId)
    // from a procedure (P6): the root and its steps made through the checked path, in this transaction; the procedure is the
    // work's organization's, and the people named for its roles are the organization's
    let instantiatedId = null
    if (templateId) {
        if (template?.isTemplate === "Y" && template.ownerPartyId && template.ownerPartyId !== target.organizationPartyId)
            denied("PROCESS_NOT_APPLICABLE", "Procedure " + templateId + " is another organization's")
        const roleParties = {}
        const named = p.roleParties && typeof p.roleParties === "object" ? p.roleParties : {}
        for (const roleTypeId of Object.keys(named)) {
            const partyId = text(named[roleTypeId])
            if (partyId) roleParties[roleTypeId] = requireMember(target.organizationPartyId, partyId)
        }
        instantiatedId = procedures().instantiateWith(userScope, {
            templateWorkEffortId: templateId,
            assetId: target.assetId,
            facilityId: target.assetId ? null : target.facilityId,
            startDate: p.estimatedStartDate || null,
            roleParties,
            rootFields: {workEffortName: name, description: text(p.description) ?? template.description ?? null, ownerPartyId: target.organizationPartyId}
        }).workEffortId
        if (hours != null) call("update#" + WORK, {workEffortId: instantiatedId, estimatedWorkTime: hours})
    }
    // corrective work by a planner or supervisor (not a procedure's), any work a supervisor creates and planned work within the
    // threshold (the root's estimate with its steps', F107) is approved on create; the rest waits in planning for a supervisor
    const totalHours = instantiatedId ? treeHours(instantiatedId) : hours
    const approved =
        options.statusId ||
        ((kind === "MkCorrective" && !instantiatedId) ||
        userScope.capabilities.supervise ||
        withinThreshold(policy, totalHours)
            ? "WeApproved"
            : "WeInPlanning")
    const rootFields = {
        workEffortTypeEnumId: "WetTask",
        purposeEnumId: "WepMaintenance",
        statusId: approved,
        statusFlowId: "WorkEffortMaintenance",
        ownerPartyId: target.organizationPartyId,
        facilityId: target.facilityId,
        workEffortName: name,
        description: text(p.description) ?? (instantiatedId ? template.description ?? null : null),
        priority,
        estimatedStartDate: p.estimatedStartDate || null,
        estimatedCompletionDate: p.estimatedCompletionDate || null,
        actualStartDate: approved === "WeInProgress" ? ec.user.nowTimestamp : null,
        timeUomId: "TF_hr"
    }
    if (!instantiatedId) rootFields.estimatedWorkTime = hours
    const workEffortId = instantiatedId
        ? (call("update#" + WORK, Object.assign({workEffortId: instantiatedId}, rootFields)), instantiatedId)
        : call("create#" + WORK, rootFields).workEffortId
    let assetMaintenanceId = options.assetMaintenanceId || null
    if (target.assetId && !assetMaintenanceId) {
        const root = {
            statusId: approved,
            estimatedStartDate: p.estimatedStartDate,
            estimatedCompletionDate: p.estimatedCompletionDate
        }
        assetMaintenanceId = call("mantle.product.EquipmentServices.create#AssetMaintenance", {
            assetId: target.assetId,
            statusId: maintenanceStatusFor(root) === "AsMntScheduled" ? "AsMntScheduled" : "AsMntCreated",
            maintenanceDate: p.estimatedStartDate || ec.user.nowTimestamp,
            maintenanceTypeEnumId: typeId,
            taskWorkEffortId: workEffortId,
            comments: name
        }).assetMaintenanceId
    }
    call("create#" + ORDER, {
        workEffortId,
        assetId: target.assetId,
        assetMaintenanceId,
        maintenanceKindEnumId: kind,
        maintenanceTypeEnumId: typeId,
        sourceEnumId: sourceId,
        severityEnumId: severityId,
        failureModeEnumId: failureId,
        procedureWorkEffortId: instantiatedId ? templateId : null,
        procedureDate: instantiatedId ? ec.user.nowTimestamp : null,
        revision: 1,
        offlineIntent: flag(p.offlineIntent) ? "Y" : null,
        // P14: the plan generated work executes, set by its generation alone (MaintenancePlans.js), never from a caller
        maintenanceScheduleId: options.maintenanceScheduleId || null,
        operationKey: options.operationKey || null,
        operationHash: options.operationHash || null
    })
    if (teamId)
        call("create#" + PARTY, {
            workEffortId,
            partyId: teamId,
            roleTypeId: teamRole,
            fromDate: ec.user.nowTimestamp,
            statusId: "WeptAssigned"
        })
    return {workEffortId, statusId: approved, approved: approved !== "WeInPlanning", assetMaintenanceId, repeated: false}
}
function createWorkOrder(p) {
    const userScope = scopeWithAny(["plan", "supervise"])
    const operationKey = text(p.operationKey)
    const hash = requestHash(p)
    const earlier = previousCreate(userScope, operationKey, hash)
    if (earlier) return earlier
    const target = targetOf(userScope, p)
    return makeOrder(userScope, target, p, {operationKey, operationHash: operationKey ? hash : null})
}

// ===== adopt#MaintenanceRecord =====
// An open AssetMaintenance with no linked work gets a managed root, once: a retry, or a second adoption, answers the first root.
function adoptRecord(p) {
    return adoptWith(scopeWithAny(["plan", "supervise"]), p)
}
function adoptWith(userScope, p) {
    const assetMaintenanceId = text(p.assetMaintenanceId)
    const maintenance = assetMaintenanceId ? one(MAINTENANCE, {assetMaintenanceId}) : null
    if (!maintenance || !maintenance.assetId)
        denied("RECORD_UNAVAILABLE", "Maintenance " + (assetMaintenanceId || "") + " is not available")
    const target = targetOf(userScope, {assetId: maintenance.assetId})
    const earlier = Array.from(find(ORDER, {assetMaintenanceId}).limit(1).list())[0]
    if (earlier) {
        readOrder(userScope, earlier.workEffortId)
        return {
            workEffortId: earlier.workEffortId,
            statusId: one(WORK, {workEffortId: earlier.workEffortId}).statusId,
            repeated: true
        }
    }
    if (["AsMntCompleted", "AsMntCancelled"].includes(maintenance.statusId))
        denied(
            "RECORD_CLOSED",
            "Maintenance " + assetMaintenanceId + " is " + statusText(maintenance.statusId) + "; its history stays as it is"
        )
    if (maintenance.maintenanceTypeEnumId === "MntTpWarranty")
        denied("OWNER_PATH", "Maintenance " + assetMaintenanceId + " is a warranty repair, worked from its case")
    if (maintenance.taskWorkEffortId)
        denied("LINKED_WORK", "Maintenance " + assetMaintenanceId + " already has work " + maintenance.taskWorkEffortId)
    const asset = target.asset
    const fromProduction =
        find("mantle.request.RequestRecord").condition({recordEntityName: MAINTENANCE, recordId: assetMaintenanceId}).count() > 0
    const statusId = maintenance.statusId === "AsMntInProcess" ? "WeInProgress" : "WeApproved"
    const made = makeOrder(
        userScope,
        target,
        {
            workEffortName:
                text(p.workEffortName) || maintenance.comments || "Maintenance of " + (asset.assetName || asset.assetId),
            description: maintenance.comments,
            maintenanceKindEnumId:
                maintenance.maintenanceTypeEnumId === "MntTpCorrective" || fromProduction ? "MkCorrective" : "MkPreventive",
            maintenanceTypeEnumId: maintenance.maintenanceTypeEnumId,
            priority: p.priority,
            estimatedStartDate: maintenance.maintenanceDate
        },
        {sourceEnumId: fromProduction ? "MsrcProduction" : "MsrcAdopted", assetMaintenanceId, statusId}
    )
    call("update#" + MAINTENANCE, {assetMaintenanceId, taskWorkEffortId: made.workEffortId})
    return Object.assign(made, {adopted: true})
}

// ===== store#MaintenanceWorkOrder =====
function storeWorkOrder(p) {
    const userScope = scopeWithAny(["plan", "supervise"])
    const {root, order, organizationPartyId} = readOrder(userScope, p.workEffortId)
    if (root.workEffortId !== text(p.workEffortId)) unavailable(p.workEffortId)
    requireRevision(order, p.expectedRevision)
    requireOpen(root)
    const workFields = {workEffortId: root.workEffortId}
    const orderFields = {}
    if (p.workEffortName != null) {
        const name = text(p.workEffortName)
        if (!name) denied("NAME_REQUIRED", "Name the work")
        workFields.workEffortName = name
    }
    if (p.description != null) workFields.description = text(p.description)
    if (!blank(p.priority)) {
        const priority = Number(p.priority)
        if (!Number.isInteger(priority) || priority < 1 || priority > 9)
            denied("VALUE_INVALID", "Priority is 1 (most urgent) to 9")
        workFields.priority = priority
    }
    if (!blank(p.estimatedWorkTime)) {
        const hours = hoursOf(p.estimatedWorkTime)
        // the estimate decides approval: after approval only a supervisor changes it
        if (
            root.statusId !== "WeInPlanning" &&
            !userScope.capabilities.supervise &&
            String(hours ?? "") !== String(root.estimatedWorkTime ?? "")
        )
            denied("APPROVAL_REQUIRED", "A supervisor changes the estimate of approved work")
        workFields.estimatedWorkTime = hours
    }
    for (const [field, type, label] of [
        ["maintenanceTypeEnumId", "MaintenanceType", "Maintenance type"],
        ["severityEnumId", "MaintenanceSeverity", "Severity"],
        ["failureModeEnumId", "MaintenanceFailureMode", "Failure mode"]
    ])
        if (p[field] != null) orderFields[field] = requireEnum(p[field], type, label)
    if (p.offlineIntent != null && p.offlineIntent !== "") orderFields.offlineIntent = flag(p.offlineIntent) ? "Y" : "N"
    // P9: the cost centre and project (design §3 "Charging a project"), audited on the row
    Object.assign(orderFields, materials().chargeFields(p, organizationPartyId))
    // the target: equipment work keeps equipment and facility work a facility, of the same organization
    if (!blank(p.assetId) && p.assetId !== order.assetId) {
        if (!order.assetId) denied("TARGET_KIND", "Facility work stays facility work; create equipment work instead")
        if (!["WeInPlanning", "WeApproved"].includes(root.statusId))
            denied("WORK_STARTED", "The target is fixed once work starts")
        const target = targetOf(userScope, {assetId: p.assetId})
        if (target.organizationPartyId !== organizationPartyId) denied("ORGANIZATION_CHANGE", "The work stays its organization's")
        orderFields.assetId = target.assetId
        workFields.facilityId = target.facilityId
    } else if (!blank(p.facilityId) && !order.assetId && p.facilityId !== root.facilityId) {
        if (!["WeInPlanning", "WeApproved"].includes(root.statusId))
            denied("WORK_STARTED", "The target is fixed once work starts")
        const target = targetOf(userScope, {facilityId: p.facilityId})
        if (target.organizationPartyId !== organizationPartyId) denied("ORGANIZATION_CHANGE", "The work stays its organization's")
        workFields.facilityId = target.facilityId
    }
    call("update#" + WORK, workFields)
    auditWork(root, workFields)
    const revision = bump(order, orderFields)
    syncMaintenance(one(ORDER, {workEffortId: root.workEffortId}))
    return {workEffortId: root.workEffortId, revision}
}
// The work order's own audit rows for the header fields WorkEffort does not audit (its priority, estimate and facility), so
// History shows each change with who made it, as the audited status and organization are (P3 review).
const auditedHere = ["priority", "estimatedWorkTime", "facilityId"]
function auditWork(root, fields) {
    for (const field of auditedHere) {
        if (!Object.hasOwn(fields, field)) continue
        const numeric = field !== "facilityId"
        const before = numeric ? number(root[field]) : text(root[field])
        const after = numeric ? number(fields[field]) : text(fields[field])
        if (before === after) continue
        call("create#moqui.entity.EntityAuditLog", {
            changedEntityName: WORK,
            changedFieldName: field,
            pkPrimaryValue: root.workEffortId,
            oldValueText: before == null ? null : String(before),
            newValueText: after == null ? null : String(after),
            changedDate: ec.user.nowTimestamp,
            changedByUserId: ec.user.userId || null
        })
    }
}

// ===== schedule#MaintenanceWorkOrder =====
// One work order's team, people and planned window; the generic WorkEffortParty writers refuse managed work.
function scheduleWorkOrder(p) {
    const userScope = scopeWithAny(["plan", "supervise"])
    const {root, order, organizationPartyId} = readOrder(userScope, p.workEffortId)
    if (root.workEffortId !== text(p.workEffortId)) unavailable(p.workEffortId)
    requireRevision(order, p.expectedRevision)
    requireOpen(root)
    const now = ec.user.nowTimestamp
    const added = []
    const removed = []
    // a person replaced by another on the root and on each step of its tree (a leaver's work, Admin's offboarding; F113): their
    // current assignee rows ended and the other's made on the same work efforts
    if (text(p.replacePartyId)) {
        const leaverId = text(p.replacePartyId)
        const byId = text(p.withPartyId)
        if (!byId) denied("ASSIGNEE_REQUIRED", "Name who takes the work")
        requireMember(organizationPartyId, byId)
        // P7 (F160): a step that is done keeps who did it; only the root and the open steps move
        const doneSteps = new Set(
            Array.from(
                find(WORK, {rootWorkEffortId: root.workEffortId})
                    .condition("statusId", "in", doneStatuses)
                    .selectField("workEffortId")
                    .list()
            ).map(row => row.workEffortId)
        )
        const held = Array.from(
            find(PARTY, {partyId: leaverId, roleTypeId: assigneeRole})
                .condition("workEffortId", "in", treeIds(root.workEffortId))
                .conditionDate("fromDate", "thruDate", now)
                .list()
        ).filter(row => !doneSteps.has(row.workEffortId))
        for (const row of held) {
            call("update#" + PARTY, {
                workEffortId: row.workEffortId,
                partyId: row.partyId,
                roleTypeId: row.roleTypeId,
                fromDate: row.fromDate,
                thruDate: now
            })
            if (!currentParties(row.workEffortId, assigneeRole).some(other => other.partyId === byId))
                call("create#" + PARTY, {
                    workEffortId: row.workEffortId,
                    partyId: byId,
                    roleTypeId: assigneeRole,
                    fromDate: now,
                    statusId: "WeptAssigned"
                })
        }
        if (held.length) {
            removed.push(leaverId)
            added.push(byId)
        }
    }
    // the people: the list given replaces the current assignees
    if (p.assigneePartyIds != null) {
        const wanted = ids(Array.from(p.assigneePartyIds || []).map(text))
        for (const partyId of wanted) requireMember(organizationPartyId, partyId)
        const current = currentParties(root.workEffortId, assigneeRole)
        for (const row of current)
            if (!wanted.includes(row.partyId)) {
                call("update#" + PARTY, {
                    workEffortId: row.workEffortId,
                    partyId: row.partyId,
                    roleTypeId: row.roleTypeId,
                    fromDate: row.fromDate,
                    thruDate: now
                })
                removed.push(row.partyId)
            }
        for (const partyId of wanted)
            if (!current.some(row => row.partyId === partyId)) {
                call("create#" + PARTY, {
                    workEffortId: root.workEffortId,
                    partyId,
                    roleTypeId: assigneeRole,
                    fromDate: now,
                    statusId: "WeptAssigned"
                })
                added.push(partyId)
            }
    }
    // the team: one at a time; empty removes it
    if (p.teamPartyId != null) {
        const teamId = text(p.teamPartyId)
        if (teamId) requireTeam(organizationPartyId, teamId)
        for (const row of currentParties(root.workEffortId, teamRole))
            if (row.partyId !== teamId)
                call("update#" + PARTY, {
                    workEffortId: row.workEffortId,
                    partyId: row.partyId,
                    roleTypeId: row.roleTypeId,
                    fromDate: row.fromDate,
                    thruDate: now
                })
        if (teamId && !currentParties(root.workEffortId, teamRole).some(row => row.partyId === teamId))
            call("create#" + PARTY, {
                workEffortId: root.workEffortId,
                partyId: teamId,
                roleTypeId: teamRole,
                fromDate: now,
                statusId: "WeptAssigned"
            })
    }
    // the planned window
    const fromDate = p.estimatedStartDate != null ? p.estimatedStartDate : root.estimatedStartDate
    const thruDate = p.estimatedCompletionDate != null ? p.estimatedCompletionDate : root.estimatedCompletionDate
    requireWindow(fromDate, thruDate)
    if (ms(fromDate) !== ms(root.estimatedStartDate) || ms(thruDate) !== ms(root.estimatedCompletionDate))
        call("update#" + WORK, {workEffortId: root.workEffortId, estimatedStartDate: fromDate, estimatedCompletionDate: thruDate})
    const revision = bump(order)
    syncMaintenance(one(ORDER, {workEffortId: root.workEffortId}))
    if (added.length) notifyAssigned(root.workEffortId, added)
    return {workEffortId: root.workEffortId, revision, addedPartyIds: added, removedPartyIds: removed}
}
// The new assignees are told on MaintenanceWork (the work order and its target, never a cost); a failure is logged.
function notifyAssigned(workEffortId, partyIds) {
    try {
        const root = one(WORK, {workEffortId})
        const order = one(ORDER, {workEffortId})
        const userIds = Array.from(
            find("moqui.security.UserAccount").condition("partyId", "in", partyIds).selectField("userId").list()
        )
            .map(row => row.userId)
            .filter(userId => userId !== ec.user.userId)
        if (!userIds.length) return
        ec.makeNotificationMessage()
            .topic("MaintenanceWork")
            .userIds(userIds)
            .message({workEffortId, workEffortName: root.workEffortName || workEffortId, targetName: targetName(root, order)})
            .record(WORK, workEffortId)
            .send()
    } catch (error) {
        ec.logger.error("Maintenance work order " + workEffortId + ": the assignment notice was not sent: " + error.message)
    }
}
function targetName(root, order) {
    if (order?.assetId) return one(ASSET, {assetId: order.assetId})?.assetName || order.assetId
    return root.facilityId ? one(FACILITY, {facilityId: root.facilityId})?.facilityName || root.facilityId : ""
}

// ===== transition#MaintenanceWorkOrder =====
const actions = {
    approve: {label: "Approve", from: ["WeInPlanning"]},
    start: {label: "Start", from: ["WeApproved"]},
    hold: {label: "Hold", from: ["WeInPlanning", "WeApproved", "WeInProgress"]},
    resume: {label: "Resume", from: ["WeOnHold"]},
    complete: {label: "Complete", from: ["WeInProgress"]},
    close: {label: "Close", from: ["WeComplete"]},
    cancel: {label: "Cancel", from: ["WeInPlanning", "WeApproved", "WeInProgress", "WeOnHold"]}
}
const executing = (caps, assigned) => (caps.execute && assigned) || caps.supervise
// Why an action is refused now for the caller ({reason, message}), or null: the status, the caller's authority and the state
// of the work; input (a reason, the outcome) is checked when it is taken.
function refusalOf(userScope, ctx, action) {
    const definition = actions[action]
    const {root, order} = ctx
    const caps = userScope.capabilities
    if (!definition) return {reason: "ACTION_INVALID", message: "Unknown action " + action}
    if (!definition.from.includes(root.statusId))
        return {
            reason: "STATUS_INVALID",
            message: definition.label + " is not open while the work is " + statusText(root.statusId)
        }
    const assigned = maintenanceAccess.assignment(userScope, root.workEffortId).root
    const kind = order.maintenanceKindEnumId
    const policy = policyOf(ctx.organizationPartyId)
    switch (action) {
        case "approve":
            if (caps.supervise) return null
            if (
                caps.plan &&
                ((kind === "MkCorrective" && !order.procedureWorkEffortId) || withinThreshold(policy, treeHours(root.workEffortId)))
            )
                return null
            return {
                reason: "APPROVAL_REQUIRED",
                message: "Planned work over the approval threshold needs a supervisor's approval"
            }
        case "start":
            if (executing(caps, assigned)) return null
            return caps.execute
                ? {reason: "NOT_ASSIGNED", message: "Work order " + root.workEffortId + " is not assigned to you"}
                : {reason: "PERMISSION_DENIED", message: "A technician assigned to the work, or a supervisor, starts it"}
        case "resume": {
            const to = order.holdFromStatusId || "WeApproved"
            if (to === "WeInProgress") {
                if (executing(caps, assigned)) return null
                return {reason: "NOT_ASSIGNED", message: "A technician assigned to the work, or a supervisor, resumes it"}
            }
            // approved work is a supervisor's to hold and resume (the flow's row needs MAINTENANCE_SUPERVISE)
            if (to === "WeApproved" ? caps.supervise : caps.plan || caps.supervise) return null
            return {
                reason: "PERMISSION_DENIED",
                message:
                    to === "WeApproved" ? "A supervisor resumes approved work" : "A planner or supervisor resumes planned work"
            }
        }
        case "hold":
            if (root.statusId === "WeApproved" && !caps.supervise)
                return {reason: "PERMISSION_DENIED", message: "A supervisor holds approved work"}
            if (root.statusId === "WeInPlanning" && !(caps.plan || caps.supervise))
                return {reason: "PERMISSION_DENIED", message: "A planner or supervisor holds planned work"}
            if (!(caps.plan || caps.supervise || (caps.execute && assigned)))
                return {reason: "PERMISSION_DENIED", message: "A planner, a supervisor or the assigned technician holds work"}
            if (runningTimers(root.workEffortId).length)
                return {reason: "TIMER_RUNNING", message: "Stop the running timers first"}
            return null
        case "complete": {
            if (!executing(caps, assigned))
                return {reason: "NOT_ASSIGNED", message: "A technician assigned to the work, or a supervisor, completes it"}
            if (runningTimers(root.workEffortId).length)
                return {reason: "TIMER_RUNNING", message: "Stop the running timers first"}
            // P7: the checklist's required steps complete or waived
            const open = checks().gateOf(root.workEffortId)
            if (open.length)
                return {
                    reason: "STEPS_OPEN",
                    message: "Required steps are open: " + open.map(row => row.name).join(", ")
                }
            return null
        }
        case "close":
            if (caps.supervise) return null
            return {reason: "PERMISSION_DENIED", message: "A supervisor accepts and closes completed work"}
        case "cancel": {
            const started =
                root.statusId === "WeInProgress" || (root.statusId === "WeOnHold" && order.holdFromStatusId === "WeInProgress")
            if (started ? !caps.supervise : !(caps.plan || caps.supervise))
                return {
                    reason: "PERMISSION_DENIED",
                    message: started ? "A supervisor cancels started work" : "A planner or supervisor cancels work"
                }
            if (runningTimers(root.workEffortId).length)
                return {reason: "TIMER_RUNNING", message: "Stop the running timers first"}
            return null
        }
    }
    return null
}
// The actions open from the status, each allowed or with why not, and the input it asks for.
function actionsFor(userScope, ctx) {
    return Object.entries(actions)
        .filter(([, definition]) => definition.from.includes(ctx.root.statusId))
        .map(([action, definition]) => {
            const refused = refusalOf(userScope, ctx, action)
            return {
                action,
                label: action === "resume" && ctx.order.holdFromStatusId === "WeInProgress" ? "Resume work" : definition.label,
                allowed: !refused,
                reasonCode: refused?.reason || null,
                message: refused?.message || "",
                needsHoldReason: action === "hold",
                needsCancelReason: action === "cancel",
                needsCompletion: action === "complete",
                needsDisposition: action === "complete" && !!ctx.order.assetId,
                // P5: Start's offline intent and Complete's follow-up
                needsOffline: action === "start",
                offlineIntent: ctx.order.offlineIntent === "Y",
                needsFollowUp: action === "complete",
                // P14 (F187): a meter plan's work asks for the reading it took when it has none
                readingMeterName: action === "complete" ? plans().readingNeeded(ctx.order)?.meterName || null : null,
                // P10: the outside-service lines the caller may accept at completion, with the work's files as evidence
                ...(action === "complete" && !refused
                    ? purchases().completionLines(userScope, ctx)
                    : {serviceLines: [], evidenceFiles: []})
            }
        })
}
function transitionWorkOrder(p) {
    const userScope = scopeWithAny(["plan", "supervise", "execute"])
    const ctx = readOrder(userScope, p.workEffortId)
    const {root, order} = ctx
    if (root.workEffortId !== text(p.workEffortId)) unavailable(p.workEffortId)
    const action = text(p.action)
    if (!Object.hasOwn(actions, action || "")) denied("ACTION_INVALID", "Unknown action " + action)
    requireRevision(order, p.expectedRevision)
    const refused = refusalOf(userScope, ctx, action)
    if (refused) denied(refused.reason, refused.message)
    const now = ec.user.nowTimestamp
    const workFields = {workEffortId: root.workEffortId}
    const orderFields = {}
    let resultCode
    switch (action) {
        case "approve":
            workFields.statusId = "WeApproved"
            resultCode = "APPROVED"
            break
        case "start": {
            const started = p.actualStartDate || now
            if (ms(started) > nowMs() + minuteMs) denied("DATE_FUTURE", "Work starts now or earlier")
            workFields.statusId = "WeInProgress"
            if (!root.actualStartDate) workFields.actualStartDate = started
            resultCode = "STARTED"
            break
        }
        case "hold": {
            const reason = requireEnum(p.holdReasonEnumId, "MaintenanceHoldReason", "Hold reason")
            if (!reason) denied("REASON_REQUIRED", "Say why the work is held")
            workFields.statusId = "WeOnHold"
            Object.assign(orderFields, {holdReasonEnumId: reason, holdFromStatusId: root.statusId})
            resultCode = "HELD"
            break
        }
        case "resume":
            workFields.statusId = order.holdFromStatusId || "WeApproved"
            Object.assign(orderFields, {holdReasonEnumId: null, holdFromStatusId: null})
            resultCode = "RESUMED"
            break
        case "complete": {
            const outcome = requireEnum(p.outcomeEnumId, "MaintenanceOutcome", "Outcome")
            if (!outcome) denied("OUTCOME_REQUIRED", "Say what the work achieved")
            const disposition = requireEnum(p.dispositionEnumId, "MaintenanceDisposition", "Disposition")
            if (order.assetId && !disposition) denied("DISPOSITION_REQUIRED", "Say whether the equipment can be used")
            const finished = p.actualCompletionDate || now
            if (ms(finished) > nowMs() + minuteMs) denied("DATE_FUTURE", "The finish is now or earlier")
            if (root.actualStartDate && ms(finished) < ms(root.actualStartDate))
                denied("DATES_INVALID", "The finish is before the work started")
            // P14 (F187): a meter plan's work records the reading it took before it completes
            plans().requireCompletionReading(order, root, p, finished)
            workFields.statusId = "WeComplete"
            workFields.actualCompletionDate = finished
            Object.assign(orderFields, {
                outcomeEnumId: outcome,
                dispositionEnumId: disposition,
                failureModeEnumId:
                    requireEnum(p.failureModeEnumId, "MaintenanceFailureMode", "Failure mode") || order.failureModeEnumId
            })
            resultCode = "COMPLETED"
            break
        }
        case "close":
            workFields.statusId = "WeClosed"
            resultCode = "CLOSED"
            break
        case "cancel": {
            const reason = requireEnum(p.cancelReasonEnumId, "MaintenanceCancelReason", "Cancel reason")
            if (!reason) denied("REASON_REQUIRED", "Say why the work is cancelled")
            workFields.statusId = "WeCancelled"
            orderFields.cancelReasonEnumId = reason
            resultCode = "CANCELLED"
            break
        }
    }
    call("update#" + WORK, workFields)
    // P5: the target out of service from the start, or left down at completion with its follow-up (ResourceOutages.js)
    const downtime = downtimeOf(userScope, ctx, action, p, workFields)
    // P10: CompleteWork's outside-service line, accepted under Purchasing's check in the completion's transaction
    const accepted = action === "complete" ? purchases().acceptAtCompletion(userScope, ctx, p) : null
    // completion closes the work where the organization's policy says so
    if (action === "complete" && policyOf(ctx.organizationPartyId).closurePolicyEnumId === "MclOnComplete") {
        call("update#" + WORK, {workEffortId: root.workEffortId, statusId: "WeClosed"})
        resultCode = "CLOSED"
    }
    // P7: Close moves the checklist's complete steps to Closed and stores it; Cancel cancels its open steps
    if (resultCode === "CLOSED" || resultCode === "CANCELLED")
        checks().closeExecution(root.workEffortId, resultCode === "CLOSED" ? "WeClosed" : "WeCancelled")
    const revision = bump(order, orderFields)
    syncMaintenance(one(ORDER, {workEffortId: root.workEffortId}))
    const statusAfter = one(WORK, {workEffortId: root.workEffortId}).statusId
    // P14: the plan's obligation completed once, or open again after a cancellation
    plans().creditCompletion(order, statusAfter)
    return {
        workEffortId: root.workEffortId,
        statusId: statusAfter,
        revision,
        resultCode,
        resourceUnavailabilityId: downtime.resourceUnavailabilityId || null,
        followUpWorkEffortId: downtime.followUpWorkEffortId || null,
        serviceAcceptanceId: accepted?.serviceAcceptanceId || null
    }
}
// The downtime of a transition (P5): Start with offline intent (the order's, or offlineIntent given) records the target's outage
// as planned maintenance, or links the one open; Complete leaving equipment still unavailable records its outage when none is
// open, and a follow-up (followUpName) is a new corrective work order on the same target, caused by this one and linked to its
// open outage, which a restoration lists while it is open (it stays open). Hold and Cancel leave an outage as it is.
function downtimeOf(userScope, ctx, action, p, workFields) {
    const {root, order} = ctx
    const target = order.assetId ? {assetId: order.assetId} : {facilityId: root.facilityId}
    const answer = {}
    if (action === "start") {
        const offline = p.offlineIntent != null && p.offlineIntent !== "" ? flag(p.offlineIntent) : order.offlineIntent === "Y"
        if (offline)
            answer.resourceUnavailabilityId = outages.record(
                Object.assign({}, target, {
                    workEffortId: root.workEffortId,
                    unavailabilityReasonEnumId: text(p.unavailabilityReasonEnumId) || "RurMaintenance",
                    fromDate: workFields.actualStartDate || null,
                    description: "Out of service for work order " + root.workEffortId
                })
            ).resourceUnavailabilityId
        return answer
    }
    if (action !== "complete") return answer
    const linked = outages.workOutage(one(ORDER, {workEffortId: root.workEffortId}))
    let openId = linked?.open ? linked.resourceUnavailabilityId : outages.openOutage(target)?.resourceUnavailabilityId || null
    if (!openId && order.assetId && text(p.dispositionEnumId) === "MdispUnavailable")
        openId = outages.record(
            Object.assign({}, target, {
                workEffortId: root.workEffortId,
                unavailabilityReasonEnumId: text(p.unavailabilityReasonEnumId) || "RurEquipmentFault",
                description: "Still unavailable after work order " + root.workEffortId
            })
        ).resourceUnavailabilityId
    answer.resourceUnavailabilityId = openId
    const followUpName = text(p.followUpName)
    if (followUpName) {
        const team = currentParties(root.workEffortId, teamRole)[0]?.partyId || null
        const made = makeOrder(
            userScope,
            {assetId: order.assetId || null, facilityId: root.facilityId || null, organizationPartyId: ctx.organizationPartyId},
            {
                workEffortName: followUpName,
                description: "Follow-up of work order " + root.workEffortId,
                maintenanceKindEnumId: "MkCorrective",
                severityEnumId: order.severityEnumId,
                priority: root.priority,
                teamPartyId: team
            },
            {sourceEnumId: "MsrcFollowUp"}
        )
        call("create#mantle.work.effort.WorkEffortAssoc", {
            workEffortId: made.workEffortId,
            toWorkEffortId: root.workEffortId,
            workEffortAssocTypeEnumId: "WeatCausedBy",
            fromDate: ec.user.nowTimestamp
        })
        if (openId) call("update#" + ORDER, {workEffortId: made.workEffortId, resourceUnavailabilityId: openId})
        answer.followUpWorkEffortId = made.workEffortId
    }
    return answer
}
// act#MaintenanceWorkOrders: one action on each of several work orders, each in its own transaction; a refusal or failure is
// named for its work order and the rest go on.
function actWorkOrders(p) {
    scopeWithAny(["plan", "supervise", "execute"])
    const results = []
    for (const workEffortId of ids(Array.from(p.workEffortIds || []).map(text))) {
        try {
            const out = lib.probe("mantle.work.MaintenanceServices.transition#MaintenanceWorkOrder", {
                workEffortId,
                action: p.action,
                holdReasonEnumId: p.holdReasonEnumId,
                cancelReasonEnumId: p.cancelReasonEnumId
            })
            results.push({workEffortId, ok: true, resultCode: out.resultCode, reasonCode: null, message: ""})
        } catch (error) {
            results.push({
                workEffortId,
                ok: false,
                resultCode: null,
                reasonCode: lib.reasonCode(error),
                message: String(error.message)
            })
        }
    }
    return {results, successCount: results.filter(row => row.ok).length, failedCount: results.filter(row => !row.ok).length}
}

// ===== get#MaintenanceWorkOrder =====
function getWorkOrder(p) {
    const userScope = scopeWithAny(["workRead"])
    const ctx = readOrder(userScope, p.workEffortId)
    const {root, order, organizationPartyId} = ctx
    const caps = userScope.capabilities
    const assignees = currentParties(root.workEffortId, assigneeRole)
    const teams = currentParties(root.workEffortId, teamRole)
    const names = partyNames(
        assignees
            .map(row => row.partyId)
            .concat(
                teams.map(row => row.partyId),
                [organizationPartyId]
            )
    )
    const asset = order.assetId ? one(ASSET, {assetId: order.assetId}) : null
    const facility = root.facilityId ? one(FACILITY, {facilityId: root.facilityId}) : null
    const maintenance = order.assetMaintenanceId ? one(MAINTENANCE, {assetMaintenanceId: order.assetMaintenanceId}) : null
    const now = nowMs()
    const open = openStatuses.includes(root.statusId)
    const time = timeOf(userScope, root.workEffortId)
    const timer = Array.from(
        find(TIME)
            .condition("workEffortId", "in", treeIds(root.workEffortId))
            .condition("partyId", userScope.partyId || "_NA_")
            .condition("thruDate", "is-null", null)
            .condition("fromDate", "is-not-null", null)
            .list()
    )[0]
    const assignment = maintenanceAccess.assignment(userScope, root.workEffortId)
    const canLogTime = caps.execute && assignment.step && root.statusId === "WeInProgress"
    const openSteps = open ? checks().gateOf(root.workEffortId) : []
    const workOrder = {
        workEffortId: root.workEffortId,
        workEffortName: root.workEffortName || root.workEffortId,
        description: root.description || "",
        statusId: root.statusId,
        statusText: statusText(root.statusId),
        priority: root.priority ?? null,
        highPriority: root.priority != null && Number(root.priority) <= highPriority,
        maintenanceKindEnumId: order.maintenanceKindEnumId,
        kindText: enumText(order.maintenanceKindEnumId),
        maintenanceTypeEnumId: order.maintenanceTypeEnumId,
        typeText: enumText(order.maintenanceTypeEnumId),
        sourceText: enumText(order.sourceEnumId),
        severityEnumId: order.severityEnumId || null,
        severityText: enumText(order.severityEnumId),
        failureModeEnumId: order.failureModeEnumId || null,
        failureModeText: enumText(order.failureModeEnumId),
        holdReasonText: enumText(order.holdReasonEnumId),
        cancelReasonText: enumText(order.cancelReasonEnumId),
        outcomeText: enumText(order.outcomeEnumId),
        dispositionText: enumText(order.dispositionEnumId),
        assetId: order.assetId || null,
        assetName: asset ? asset.assetName || asset.assetId : "",
        facilityId: root.facilityId || null,
        facilityName: facility ? facility.facilityName || facility.facilityId : "",
        targetName: asset ? asset.assetName || asset.assetId : facility ? facility.facilityName || facility.facilityId : "",
        organizationPartyId,
        organizationName: names[organizationPartyId] || organizationPartyId,
        estimatedStartDate: root.estimatedStartDate,
        estimatedCompletionDate: root.estimatedCompletionDate,
        estimatedStartText: dateText(root.estimatedStartDate),
        estimatedCompletionText: dateText(root.estimatedCompletionDate),
        actualStartText: dateText(root.actualStartDate),
        actualCompletionText: dateText(root.actualCompletionDate),
        estimatedHours: number(root.estimatedWorkTime),
        // the root's estimate with its steps' (F107)
        totalEstimatedHours: treeHours(root.workEffortId),
        procedureWorkEffortId: order.procedureWorkEffortId || null,
        procedureName: order.procedureWorkEffortId
            ? one(WORK, {workEffortId: order.procedureWorkEffortId})?.workEffortName || order.procedureWorkEffortId
            : "",
        procedureDateText: dateText(order.procedureDate),
        // P9: the cost centre and project it is charged to
        ...materials().chargeOf(order),
        overdue: open && root.estimatedCompletionDate != null && ms(root.estimatedCompletionDate) < now,
        teamPartyId: teams[0]?.partyId || null,
        teamName: teams[0] ? names[teams[0].partyId] || teams[0].partyId : "",
        assigneeNames: assignees.map(row => names[row.partyId] || row.partyId).join(", "),
        assetMaintenanceId: order.assetMaintenanceId || null,
        assetMaintenanceStatusText: maintenance ? statusText(maintenance.statusId) : "",
        revision: Number(order.revision || 0),
        // P5: offline intent and the outage the work recorded or linked
        offlineIntent: order.offlineIntent === "Y",
        outage: outages.workOutage(order)
    }
    return {
        workOrder,
        assignmentList: assignees
            .map(row => ({
                partyId: row.partyId,
                partyName: names[row.partyId] || row.partyId,
                roleText: "Technician",
                fromDateText: dateText(row.fromDate)
            }))
            .concat(
                teams.map(row => ({
                    partyId: row.partyId,
                    partyName: names[row.partyId] || row.partyId,
                    roleText: "Team",
                    fromDateText: dateText(row.fromDate)
                }))
            ),
        timeEntryList: time.timeEntries,
        ownHours: time.ownHours,
        totalHours: time.totalHours,
        timer: timer ? {timeEntryId: timer.timeEntryId, fromDateText: dateText(timer.fromDate)} : null,
        actionList: actionsFor(userScope, ctx),
        blockerList: (runningTimers(root.workEffortId).length
            ? [
                  {
                      blocker: "Timers running",
                      detail: "Each running timer is stopped before the work is completed, held or cancelled"
                  }
              ]
            : []
        ).concat(
            // P7: the checklist's open required steps
            openSteps.length
                ? [{blocker: "Steps open", detail: "Required steps are completed or waived first: " + openSteps.map(row => row.name).join(", ")}]
                : []
        ),
        canEdit: (caps.plan || caps.supervise) && open,
        canSchedule: (caps.plan || caps.supervise) && open,
        canLogTime: !!canLogTime,
        assigned: !!assignment.root,
        historyList: historyOf(root.workEffortId)
    }
}

// The work order's history: the audit log of its status, priority, estimate and target, and of its row's key fields, newest
// first, with names for the statuses and users (the time entries and files have their own tabs).
const historyFields = {
    [WORK]: {
        statusId: "Status",
        priority: "Priority",
        estimatedWorkTime: "Estimated hours",
        facilityId: "Facility",
        ownerPartyId: "Organization"
    },
    [ORDER]: {assetId: "Equipment", maintenanceKindEnumId: "Kind", costCenterId: "Cost centre", projectWorkEffortId: "Project"}
}
function historyOf(workEffortId) {
    const found = []
    for (const [entityName, fields] of Object.entries(historyFields))
        found.push(
            ...Array.from(
                find("moqui.entity.EntityAuditLog", {changedEntityName: entityName, pkPrimaryValue: workEffortId})
                    .condition("changedFieldName", "in", Object.keys(fields))
                    .orderBy("-changedDate")
                    .limit(100)
                    .list()
            ).map(row => ({
                changedDate: row.changedDate,
                changedDateText: dateText(row.changedDate),
                fieldText: fields[row.changedFieldName],
                oldText: row.changedFieldName === "statusId" ? statusText(row.oldValueText) : row.oldValueText || "",
                newText: row.changedFieldName === "statusId" ? statusText(row.newValueText) : row.newValueText || "",
                changedByUserId: row.changedByUserId || null
            }))
        )
    const users = new Map(
        ids(found.map(row => row.changedByUserId)).length
            ? Array.from(
                  find("moqui.security.UserAccount")
                      .condition("userId", "in", ids(found.map(row => row.changedByUserId)))
                      .selectField("userId,userFullName,username")
                      .list()
              ).map(row => [row.userId, row.userFullName || row.username])
            : []
    )
    return found
        .sort((a, b) => (ms(b.changedDate) ?? 0) - (ms(a.changedDate) ?? 0))
        .map(row => Object.assign(row, {changedByName: users.get(row.changedByUserId) || ""}))
}

// ===== find#MaintenanceWorkOrders =====
// The facilities inside one (to facilityDepth levels), so a building's work lists its rooms'.
function subtreeIds(facilityId) {
    const found = new Set([facilityId])
    let frontier = [facilityId]
    for (let depth = 0; frontier.length && depth < facilityDepth; depth++) {
        const children = Array.from(find(FACILITY).condition("parentFacilityId", "in", frontier).selectField("facilityId").list())
            .map(row => row.facilityId)
            .filter(id => !found.has(id))
        for (const id of children) found.add(id)
        frontier = children
    }
    return Array.from(found)
}
// The work order ids a party is a current assignee of (Assignee, or team member through the team role).
function assignedRootIds(partyId, roleTypeId = assigneeRole) {
    if (!partyId) return []
    return ids(
        Array.from(
            find(PARTY, {partyId, roleTypeId})
                .conditionDate("fromDate", "thruDate", ec.user.nowTimestamp)
                .condition(factory().makeCondition("statusId", "not-in", ["WeptDeclined", "WeptUnassigned"], true))
                .selectField("workEffortId")
                .list()
        ).map(row => row.workEffortId)
    )
}
// The scoped query of work orders, with the filters; the caller pages it.
function scopedQuery(userScope, p) {
    let query = find(ORDER_VIEW).condition(
        anyOf([factory().makeCondition("isTemplate", "is-null", null), factory().makeCondition("isTemplate", "equals", "N")])
    )
    const scoped = listScope(userScope)
    if (scoped.organizationPartyIds != null)
        query = query.condition("ownerPartyId", "in", Array.from(scoped.organizationPartyIds).concat(["_NA_"]))
    // a technician with the assigned view reads only their own
    if (!userScope.capabilities.view)
        query = query.condition("workEffortId", "in", assignedRootIds(userScope.partyId).concat(["_NA_"]))
    const term = text(p.text)
    if (term) query = query.condition(anyOf([like("workEffortId", term), like("workEffortName", term)]))
    const organizationId = text(p.organizationPartyId)
    if (organizationId) {
        if (!maintenanceAccess.covers(userScope, organizationId)) query = query.condition("ownerPartyId", "_NA_")
        else query = query.condition("ownerPartyId", organizationId)
    }
    if (text(p.facilityId)) query = query.condition("facilityId", "in", subtreeIds(text(p.facilityId)))
    if (text(p.assetId)) query = query.condition("assetId", text(p.assetId))
    const status = text(p.statusId)
    if (status === "all") {
        // every status
    } else if (status === "done") query = query.condition("statusId", "in", doneStatuses)
    else if (status) query = query.condition("statusId", status)
    else query = query.condition("statusId", "in", openStatuses)
    if (text(p.maintenanceKindEnumId)) query = query.condition("maintenanceKindEnumId", text(p.maintenanceKindEnumId))
    if (text(p.sourceEnumId)) query = query.condition("sourceEnumId", text(p.sourceEnumId))
    if (flag(p.highPriority)) query = query.condition("priority", "less-equals", highPriority)
    if (flag(p.overdue))
        query = query.condition("statusId", "in", openStatuses).condition("estimatedCompletionDate", "less", ec.user.nowTimestamp)
    if (flag(p.blocked)) query = query.condition("statusId", "WeOnHold")
    if (flag(p.mine)) query = query.condition("workEffortId", "in", assignedRootIds(userScope.partyId).concat(["_NA_"]))
    if (text(p.assigneePartyId))
        query = query.condition("workEffortId", "in", assignedRootIds(text(p.assigneePartyId)).concat(["_NA_"]))
    if (text(p.teamPartyId))
        query = query.condition("workEffortId", "in", assignedRootIds(text(p.teamPartyId), teamRole).concat(["_NA_"]))
    if (flag(p.unassigned)) {
        // the work orders of the other filters (to homeLimit, as Home counts them) less those with a current technician: the
        // assignee rows are read for those work orders only, not every assignment of every work effort (P3 review)
        const candidates = Array.from(
            scopedQuery(userScope, Object.assign({}, p, {unassigned: null}))
                .selectField("workEffortId")
                .limit(homeLimit)
                .list()
        ).map(row => row.workEffortId)
        const assigned = new Set(
            candidates.length
                ? Array.from(
                      find(PARTY, {roleTypeId: assigneeRole})
                          .condition("workEffortId", "in", candidates)
                          .conditionDate("fromDate", "thruDate", ec.user.nowTimestamp)
                          .condition(factory().makeCondition("statusId", "not-in", ["WeptDeclined", "WeptUnassigned"], true))
                          .selectField("workEffortId")
                          .list()
                  ).map(row => row.workEffortId)
                : []
        )
        query = query.condition(
            "workEffortId",
            "in",
            candidates.filter(id => !assigned.has(id)).concat(["_NA_"])
        )
    }
    if (p.fromDate)
        query = query.condition(
            anyOf([
                factory().makeCondition("estimatedCompletionDate", "is-null", null),
                factory().makeCondition("estimatedCompletionDate", "greater-equals", p.fromDate)
            ])
        )
    if (p.thruDate)
        query = query.condition(
            anyOf([
                factory().makeCondition("estimatedStartDate", "is-null", null),
                factory().makeCondition("estimatedStartDate", "less", p.thruDate)
            ])
        )
    return query
}
// The display rows of a page of work orders, their names, assignees and teams read in one query each.
function displayRows(rowsList) {
    const workIds = rowsList.map(row => row.workEffortId)
    const parties = workIds.length
        ? Array.from(
              find(PARTY)
                  .condition("workEffortId", "in", workIds)
                  .condition("roleTypeId", "in", [assigneeRole, teamRole])
                  .conditionDate("fromDate", "thruDate", ec.user.nowTimestamp)
                  .list()
          )
        : []
    const assets = new Map(
        ids(rowsList.map(row => row.assetId)).length
            ? Array.from(
                  find(ASSET)
                      .condition("assetId", "in", ids(rowsList.map(row => row.assetId)))
                      .selectField("assetId,assetName")
                      .list()
              ).map(row => [row.assetId, row.assetName || row.assetId])
            : []
    )
    const facilities = new Map(
        ids(rowsList.map(row => row.facilityId)).length
            ? Array.from(
                  find(FACILITY)
                      .condition("facilityId", "in", ids(rowsList.map(row => row.facilityId)))
                      .selectField("facilityId,facilityName")
                      .list()
              ).map(row => [row.facilityId, row.facilityName || row.facilityId])
            : []
    )
    const statuses = new Map(
        Array.from(find("moqui.basic.StatusItem", {statusTypeId: "WorkEffort"}).list()).map(row => [
            row.statusId,
            row.description
        ])
    )
    const enumIds = ids(rowsList.flatMap(row => [row.maintenanceKindEnumId, row.holdReasonEnumId, row.sourceEnumId]))
    const enums = new Map(
        enumIds.length
            ? Array.from(find("moqui.basic.Enumeration").condition("enumId", "in", enumIds).list()).map(row => [
                  row.enumId,
                  row.description
              ])
            : []
    )
    const names = partyNames(ids(parties.map(row => row.partyId).concat(rowsList.map(row => row.ownerPartyId))))
    const now = nowMs()
    return rowsList.map(row => {
        const mine = parties.filter(party => party.workEffortId === row.workEffortId)
        const assignees = mine
            .filter(party => party.roleTypeId === assigneeRole)
            .map(party => names[party.partyId] || party.partyId)
        const team = mine.find(party => party.roleTypeId === teamRole)
        const open = openStatuses.includes(row.statusId)
        const overdue = open && row.estimatedCompletionDate != null && ms(row.estimatedCompletionDate) < now
        return {
            workEffortId: row.workEffortId,
            workEffortName: row.workEffortName || row.workEffortId,
            assetId: row.assetId || null,
            facilityId: row.facilityId || null,
            targetName: row.assetId ? assets.get(row.assetId) || row.assetId : facilities.get(row.facilityId) || "",
            targetKind: row.assetId ? "Equipment" : "Facility",
            organizationPartyId: row.ownerPartyId,
            organizationName: names[row.ownerPartyId] || row.ownerPartyId,
            priority: row.priority ?? null,
            highPriority: row.priority != null && Number(row.priority) <= highPriority,
            statusId: row.statusId,
            statusText: statuses.get(row.statusId) || row.statusId,
            kindText: enums.get(row.maintenanceKindEnumId) || "",
            sourceText: enums.get(row.sourceEnumId) || "",
            blockingText: row.statusId === "WeOnHold" ? enums.get(row.holdReasonEnumId) || "On hold" : "",
            assigneeNames: assignees.join(", "),
            unassigned: !assignees.length,
            teamPartyId: team?.partyId || null,
            teamName: team ? names[team.partyId] || team.partyId : "",
            estimatedStartDate: row.estimatedStartDate,
            estimatedCompletionDate: row.estimatedCompletionDate,
            estimatedStartText: dateText(row.estimatedStartDate),
            dueText: dateText(row.estimatedCompletionDate),
            windowText: [dateText(row.estimatedStartDate), dateText(row.estimatedCompletionDate)].filter(Boolean).join(" – "),
            overdue,
            revision: Number(row.revision || 0)
        }
    })
}
function findWorkOrders(p) {
    const userScope = scopeWithAny(["workRead"])
    const query = scopedQuery(userScope, p).orderBy(["priority", "estimatedCompletionDate", "workEffortId"])
    const count = scopedQuery(userScope, p).count()
    const paged = lib.page(query, p, "workOrderList", count, {noLimitCap: 1000})
    return Object.assign({}, paged, {rows: undefined, records: undefined, workOrderList: displayRows(paged.rows)})
}

// ===== get#MaintenanceHome =====
// Home's counters, the caller's work and the teams' (design §3 Home): over the scope (a chosen organization or facility), read
// in a few queries (F96). A technician's counters are over their own work and they get no team totals. The overdue plans and
// unknown meter readings (P14) are a reader of work's, null for anyone else (never zero); downtime is P5's.
function home(p) {
    const userScope = scopeWithAny(["workRead"])
    const filters = {organizationPartyId: p.organizationPartyId, facilityId: p.facilityId, statusId: null}
    const openRows = Array.from(
        scopedQuery(userScope, filters)
            .selectField("workEffortId,priority,statusId,estimatedStartDate,estimatedCompletionDate")
            .limit(homeLimit)
            .list()
    )
    const workIds = openRows.map(row => row.workEffortId)
    const parties = workIds.length
        ? Array.from(
              find(PARTY)
                  .condition("workEffortId", "in", workIds)
                  .condition("roleTypeId", "in", [assigneeRole, teamRole])
                  .conditionDate("fromDate", "thruDate", ec.user.nowTimestamp)
                  .list()
          )
        : []
    const assignedIds = new Set(parties.filter(row => row.roleTypeId === assigneeRole).map(row => row.workEffortId))
    const now = nowMs()
    const overdue = row => row.estimatedCompletionDate != null && ms(row.estimatedCompletionDate) < now
    const counters = {
        openCount: openRows.length,
        unassignedCount: openRows.filter(row => !assignedIds.has(row.workEffortId)).length,
        highPriorityCount: openRows.filter(row => row.priority != null && Number(row.priority) <= highPriority).length,
        overdueCount: openRows.filter(overdue).length,
        // P14: the active plans overdue and those whose meter reading is unknown (a reader of work's; null for another)
        ...plans().homeCounts(userScope, filters),
        downResourceCount: outages.downCount(userScope, filters),
        capped: openRows.length >= homeLimit
    }
    const myWork = findWorkOrders(Object.assign({}, filters, {mine: "Y", pageSize: 10})).workOrderList
    const teamWork = []
    if (userScope.capabilities.view) {
        const byTeam = new Map()
        for (const party of parties.filter(row => row.roleTypeId === teamRole)) {
            const entry = byTeam.get(party.partyId) || {teamPartyId: party.partyId, rows: []}
            entry.rows.push(openRows.find(row => row.workEffortId === party.workEffortId))
            byTeam.set(party.partyId, entry)
        }
        const names = partyNames(Array.from(byTeam.keys()))
        for (const entry of byTeam.values())
            teamWork.push({
                teamPartyId: entry.teamPartyId,
                teamName: names[entry.teamPartyId] || entry.teamPartyId,
                activeCount: entry.rows.filter(row => row.statusId === "WeInProgress").length,
                unscheduledCount: entry.rows.filter(row => !row.estimatedStartDate).length,
                blockedCount: entry.rows.filter(row => row.statusId === "WeOnHold").length,
                dueCount: entry.rows.filter(overdue).length,
                openCount: entry.rows.length
            })
        teamWork.sort((a, b) => a.teamName.localeCompare(b.teamName))
    }
    return {counters, myWorkList: myWork, teamWorkList: teamWork, teamTotals: !!userScope.capabilities.view}
}

// ===== the production handoff (impl-maintenance P4) =====
// The adoption an owner's service makes for its own record, after its own permission and organization checks
// (ProductionServices.request#ProductionMaintenance, when the organization's policy manages production requests): a planner's
// scope of that organization alone, as adopt#MaintenanceRecord's, never a reader of anything else. Once, as adoption is.
function adoptForOwner(p) {
    signedIn()
    const organizationPartyId = text(p.organizationPartyId)
    if (!organizationPartyId) denied("ORGANIZATION_REQUIRED", "The record's organization is required")
    const caps = maintenanceAccess.capabilities()
    for (const name of Object.keys(caps)) caps[name] = false
    Object.assign(caps, {plan: true, view: true, workRead: true, resourceRead: true, anyRead: true})
    const ownerScope = {
        capabilities: caps,
        partyId: ec.user.userAccount?.partyId || null,
        allOrganizations: false,
        activeOrganizationPartyId: organizationPartyId,
        organizationPartyIds: [organizationPartyId]
    }
    return adoptWith(ownerScope, p)
}

const operations = {
    findWorkOrders,
    getWorkOrder,
    createWorkOrder,
    storeWorkOrder,
    scheduleWorkOrder,
    transitionWorkOrder,
    actWorkOrders,
    adoptRecord,
    startTimer,
    stopTimer,
    recordTime,
    getPolicy,
    storePolicy,
    home
}
;({
    execute: (op, parameters) => {
        if (!Object.hasOwn(operations, op)) throw new Error("Unknown maintenance work operation " + op)
        return operations[op](parameters || {})
    },
    // P4: for Mantle's own callers only (MaintenanceIntake.js), never a service's parameters
    adoptForOwner,
    // P14: a plan's work order, for its generation alone (MaintenancePlans.js): the scope it resolved and the plan
    createForPlan: (userScope, p, options) =>
        makeOrder(userScope, targetOf(userScope, p), p, {
            maintenanceScheduleId: options.maintenanceScheduleId,
            operationKey: null,
            operationHash: null
        }),
    policyOf
})
