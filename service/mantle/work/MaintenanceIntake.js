// Maintenance intake (IronStone Maintenance design §3 Requests, §1.4 Mail intake, §13.2 MaintenanceServices; MT-02, MT-10, MT-15;
// impl-maintenance P4). A reported problem is a Request of type RqtMaintenance: its organization an OrgInternal RequestParty (as
// Manufacturing's maintenance request has it), its reporter the filer and Reporter, its one target, equipment (an Asset) or a
// facility, a RequestRecord, and its work order by RequestWorkEffort once triaged. No record of its own.
//
// - Report (report#MaintenanceProblem): a holder of MAINTENANCE_REQUEST reports on equipment or a facility of their own
//   organizations (a requester has no Maintenance read, MaintenanceAccess.requesterOrganizations, impl-maintenance F78), the
//   reporter the authenticated party, never a supplied one; exactly one target; an operation key answers a retry with the first
//   request. The mail intake (create#MaintenanceRequestFromEmail) makes the same request with the sender as reporter and a target
//   only when the subject names one equipment id of the team's organization; otherwise the target is left for triage.
// - Follow and triage (find#MaintenanceRequests, triage#MaintenanceRequest): a requester with MAINTENANCE_REQUEST_VIEW_OWN reads
//   the requests they filed, and of them only a safe summary (state, target, the linked work order's name and status; no cost,
//   no time, no people, no other report); a planner or supervisor reads and triages the requests of their organizations: create
//   work (adopting the request's open AssetMaintenance when Manufacturing made one), link an open work order (several reports to
//   one order), reject with a reason, or assign the request. A request is triaged once: a retry, or create again, answers the
//   work order it has (repeated); another decision is REQUEST_TRIAGED.
// - The production handoff (request#ProductionMaintenance, Manufacturing's owner contract): when the organization's
//   MaintenancePolicy manages production requests, its new AssetMaintenance is adopted into a work order at once and its request
//   linked; otherwise both wait in Requests (the request) and the adoption queue (find#UnmanagedMaintenance).
// - The triage notice (notify#RequestTriage): an RqtMaintenance request goes to the planners of its organization, named by its
//   target only.
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const maintenanceAccess = ec.resource.script("component://mr-mantle/service/mantle/work/MaintenanceAccess.js")
const maintenanceWork = ec.resource.script("component://mr-mantle/service/mantle/work/MaintenanceWork.js")
const {find, one, denied, call, ms} = lib

const REQUEST = "mantle.request.Request"
const REQUEST_VIEW = "mantle.work.maintenance.MaintenanceRequestDetail"
const REQUEST_PARTY = "mantle.request.RequestParty"
const REQUEST_RECORD = "mantle.request.RequestRecord"
const REQUEST_WORK = "mantle.request.RequestWorkEffort"
const ORDER = "mantle.work.maintenance.MaintenanceWorkOrder"
const WORK = "mantle.work.effort.WorkEffort"
const MAINTENANCE = "mantle.product.maintenance.AssetMaintenance"
const ASSET = "mantle.product.asset.Asset"
const FACILITY = "mantle.facility.Facility"

const requestType = "RqtMaintenance"
const openStatuses = ["ReqSubmitted", "ReqReviewed", "ReqInProgress"]
const doneStatuses = ["ReqCompleted", "ReqCancelled"]
const workOpenStatuses = ["WeInPlanning", "WeApproved", "WeInProgress", "WeOnHold"]
const maintenanceOpenStatuses = ["AsMntCreated", "AsMntScheduled", "AsMntInProcess"]
const stockTypes = ["AstTpInventory", "AstTpSupplies"]
const rejectReasons = ["RrRejected", "RrDuplicate", "RrWontFix", "RrInsufficient", "RrCantReproduce"]
const memberRelationships = ["PrtEmployee", "PrtAgent"]
const targetEntities = {asset: ASSET, facility: FACILITY}
const facilityDepth = 6
const queueScanLimit = 500
const queueLimit = 50
const choiceLimit = 20
const plusTagSetting = "MntIntakePlusTag"

const blank = value => value == null || String(value).trim() === ""
const text = value => (blank(value) ? null : String(value).trim())
const factory = () => ec.entity.conditionFactory
const like = (field, term) =>
    factory()
        .makeCondition(field, "like", "%" + String(term).replace(/[\\%_]/g, c => "\\" + c) + "%")
        .ignoreCase()
const anyOf = conditions => factory().makeCondition(conditions, "or")
const dateText = value => (value == null || value === "" ? "" : lib.dateText(value))
const enumText = enumId => (enumId ? one("moqui.basic.Enumeration", {enumId})?.description || enumId : "")
const statusText = statusId => (statusId ? one("moqui.basic.StatusItem", {statusId})?.description || statusId : "")
const ids = list => Array.from(new Set(list.filter(Boolean)))
const now = () => ec.user.nowTimestamp

// ===== scope =====
function signedIn() {
    if (!ec.user.userId) denied("PERMISSION_DENIED", "Sign in to report or follow maintenance problems")
}
// The caller's reach over requests: the organizations whose requests they triage (a planner or supervisor; null: every one),
// or their own requests (own: true) for a holder of MAINTENANCE_REQUEST_VIEW_OWN; PERMISSION_DENIED for anyone else.
function requestScope() {
    signedIn()
    const userScope = maintenanceAccess.scope()
    const caps = userScope.capabilities
    const partyId = userScope.partyId
    if (caps.plan || caps.supervise) return {triage: true, own: false, partyId, userScope}
    if (caps.requestViewOwn) return {triage: false, own: true, partyId, userScope}
    denied("PERMISSION_DENIED", "Maintenance planning, or the view of your own requests, is required")
}
// The organizations a reporter reports for: a Maintenance reader's scope, else their own (a requester reads nothing else).
function reportOrganizations(userScope) {
    return userScope.capabilities.anyRead ? userScope.organizationPartyIds : maintenanceAccess.requesterOrganizations()
}
const covers = (organizationPartyIds, partyId) =>
    !!partyId && (organizationPartyIds == null || organizationPartyIds.includes(partyId))

// ===== targets =====
// The one target of a report: equipment (not stock) or a facility, of the organizations; {kind, id, entityName, name,
// facilityId, organizationPartyId}. Two targets are ONE_TARGET, none TARGET_REQUIRED, one outside the organizations is refused as
// a missing one is (RECORD_UNAVAILABLE).
function targetOf(organizationPartyIds, assetId, facilityId, required = true) {
    const asset = text(assetId)
    const facility = text(facilityId)
    if (asset && facility) denied("ONE_TARGET", "A report is about one piece of equipment or one facility, not both")
    if (asset) {
        const row = one(ASSET, {assetId: asset})
        const organizationPartyId = row ? maintenanceAccess.assetOrganization(asset) : null
        if (!row || !covers(organizationPartyIds, organizationPartyId))
            denied("RECORD_UNAVAILABLE", "Equipment " + asset + " is not available")
        if (!row.assetTypeEnumId || stockTypes.includes(row.assetTypeEnumId))
            denied("TARGET_INVALID", "Asset " + asset + " is stock, not equipment")
        return {
            kind: "asset",
            id: asset,
            entityName: ASSET,
            name: row.assetName || asset,
            facilityId: row.facilityId || null,
            organizationPartyId
        }
    }
    if (facility) {
        const row = one(FACILITY, {facilityId: facility})
        const organizationPartyId = row ? maintenanceAccess.facilityOrganization(facility) : null
        if (!row || !covers(organizationPartyIds, organizationPartyId))
            denied("RECORD_UNAVAILABLE", "Facility " + facility + " is not available")
        return {
            kind: "facility",
            id: facility,
            entityName: FACILITY,
            name: row.facilityName || facility,
            facilityId: facility,
            organizationPartyId
        }
    }
    if (required) denied("TARGET_REQUIRED", "Choose the equipment or the facility the problem is on")
    return null
}
// A request's recorded target (its one Asset or Facility RequestRecord), or null.
function recordedTarget(requestId) {
    const row = Array.from(
        find(REQUEST_RECORD, {requestId})
            .condition("recordEntityName", "in", Object.values(targetEntities))
            .orderBy("linkedDate")
            .limit(1)
            .list()
    )[0]
    if (!row) return null
    if (row.recordEntityName === ASSET) {
        const asset = one(ASSET, {assetId: row.recordId})
        return {kind: "asset", id: row.recordId, entityName: ASSET, name: asset?.assetName || row.recordId}
    }
    const facility = one(FACILITY, {facilityId: row.recordId})
    return {kind: "facility", id: row.recordId, entityName: FACILITY, name: facility?.facilityName || row.recordId}
}
function recordTarget(requestId, target) {
    if (!target) return
    if (find(REQUEST_RECORD, {requestId, recordEntityName: target.entityName, recordId: target.id}).count() > 0) return
    call("create#" + REQUEST_RECORD, {
        requestId,
        recordEntityName: target.entityName,
        recordId: target.id,
        linkedByUserId: ec.user.userId || null,
        linkedDate: now()
    })
}
// The facilities of organizations with those inside them (a room inherits its building's owner), bounded.
function facilityTree(organizationPartyIds) {
    let level = Array.from(
        (organizationPartyIds == null ? find(FACILITY) : find(FACILITY).condition("ownerPartyId", "in", organizationPartyIds))
            .selectField("facilityId")
            .limit(queueScanLimit)
            .list()
    ).map(row => row.facilityId)
    const all = new Set(level)
    for (let depth = 0; level.length && depth < facilityDepth && all.size < queueScanLimit; depth++) {
        level = Array.from(
            find(FACILITY)
                .condition("parentFacilityId", "in", level)
                .condition("ownerPartyId", "is-null", null)
                .selectField("facilityId")
                .limit(queueScanLimit)
                .list()
        )
            .map(row => row.facilityId)
            .filter(id => !all.has(id))
        for (const id of level) all.add(id)
    }
    return Array.from(all)
}

// ===== report#MaintenanceProblem =====
const reportFields = ["assetId", "facilityId", "summary", "description", "priority", "observedDate"]
function priorityOf(value) {
    if (blank(value)) return 5
    const priority = Number(String(value))
    if (!Number.isInteger(priority) || priority < 1 || priority > 9) denied("VALUE_INVALID", "Priority is 1 (most urgent) to 9")
    return priority
}
// The request itself (report and mail share it): RqtMaintenance, submitted, the organization as OrgInternal, the target.
function makeRequest(fields) {
    const requestId = call("mantle.request.RequestServices.create#Request", {
        requestTypeEnumId: requestType,
        statusId: "ReqSubmitted",
        requestName: fields.summary.substring(0, 255),
        description: fields.description,
        priority: fields.priority,
        requestDate: fields.requestDate || now(),
        facilityId: fields.target?.facilityId || null,
        salesChannelEnumId: fields.salesChannelEnumId || null,
        filedByPartyId: fields.reporterPartyId || null,
        emailContactMechId: fields.emailContactMechId || null
    }).requestId
    call("create#" + REQUEST_PARTY, {
        requestId,
        partyId: fields.organizationPartyId,
        roleTypeId: "OrgInternal",
        fromDate: now()
    })
    if (fields.teamPartyId)
        call("create#" + REQUEST_PARTY, {requestId, partyId: fields.teamPartyId, roleTypeId: "OrgTeam", fromDate: now()})
    recordTarget(requestId, fields.target)
    return requestId
}
function reportProblem(p) {
    signedIn()
    const userScope = maintenanceAccess.scope()
    if (!userScope.capabilities.request) denied("PERMISSION_DENIED", "Maintenance request is required to report a problem")
    const reporterPartyId = userScope.partyId
    if (!reporterPartyId) denied("PERMISSION_DENIED", "A person's account is required to report a problem")
    const target = targetOf(reportOrganizations(userScope), p.assetId, p.facilityId)
    const organizationPartyId = text(p.organizationPartyId) || target.organizationPartyId
    if (organizationPartyId !== target.organizationPartyId)
        denied("ORGANIZATION_DENIED", "The target is not the organization's " + organizationPartyId)
    const summary = text(p.summary)
    if (!summary) denied("SUMMARY_REQUIRED", "Say what the problem is")
    const observed = p.observedDate || null
    if (observed != null && ms(observed) > ms(now()) + 60000) denied("DATE_FUTURE", "A problem is reported once it is seen")
    const priority = priorityOf(p.priority)
    let op = null
    if (!blank(p.operationKey)) {
        op = lib.operation(
            p,
            "MaintenanceReport",
            organizationPartyId,
            reportFields.map(field => (p[field] == null ? "" : String(ms(p[field]) ?? p[field])))
        )
        const earlier = lib.previous(op)
        if (earlier) return {requestId: earlier.requestId, repeated: true}
    }
    const description = [observed != null ? "Observed " + dateText(observed) : null, text(p.description)]
        .filter(Boolean)
        .join("\n\n")
    const requestId = makeRequest({
        summary,
        description: description || null,
        priority,
        target,
        organizationPartyId,
        reporterPartyId
    })
    // a photo or other file of the problem
    if (p.contentFile != null && Number(p.contentFile.size || 0) > 0)
        call("mantle.request.RequestServices.create#RequestContent", {
            requestId,
            contentTypeEnumId: "RqCntUserDefined",
            description: String(p.contentFile.getName?.() || "Photo").substring(0, 255),
            contentDate: now(),
            contentFile: p.contentFile
        })
    if (op) lib.complete(op, REQUEST, requestId, {requestId})
    return {requestId, repeated: false}
}

// ===== the report's targets (Commons' ReportProblem) =====
// The equipment and facilities the user may report on, searched by term in the query ignoring case: value "asset:<id>" or
// "facility:<id>"; the selected value's label too.
function reportTargets(p) {
    signedIn()
    const userScope = maintenanceAccess.scope()
    if (!userScope.capabilities.request) return {options: []}
    const organizationPartyIds = reportOrganizations(userScope)
    if (organizationPartyIds != null && !organizationPartyIds.length) return {options: []}
    const term = text(p.term)
    const facilityIds = facilityTree(organizationPartyIds)
    const options = []
    const equipment = find(ASSET)
        .condition("assetTypeEnumId", "not-in", stockTypes)
        .condition("assetTypeEnumId", "is-not-null", null)
        .orderBy("assetName")
        .limit(choiceLimit)
    const owned = organizationPartyIds == null ? null : factory().makeCondition("ownerPartyId", "in", organizationPartyIds)
    const inFacilities = facilityIds.length ? factory().makeCondition("facilityId", "in", facilityIds) : null
    const where = [owned, inFacilities].filter(Boolean)
    if (organizationPartyIds != null) equipment.condition(where.length ? anyOf(where) : owned)
    if (term) equipment.condition(anyOf([like("assetName", term), like("assetId", term), like("serialNumber", term)]))
    for (const row of Array.from(equipment.list()))
        if (covers(organizationPartyIds, maintenanceAccess.assetOrganization(row.assetId)))
            options.push({value: "asset:" + row.assetId, label: (row.assetName || row.assetId) + " (equipment)"})
    if (facilityIds.length) {
        const facilities = find(FACILITY).condition("facilityId", "in", facilityIds).orderBy("facilityName").limit(choiceLimit)
        if (term) facilities.condition(anyOf([like("facilityName", term), like("facilityId", term)]))
        for (const row of Array.from(facilities.list()))
            options.push({value: "facility:" + row.facilityId, label: (row.facilityName || row.facilityId) + " (facility)"})
    }
    const selected = text(p.selected)
    if (selected && !options.some(option => option.value === selected)) {
        const [kind, id] = selected.split(":")
        try {
            const target = targetOf(organizationPartyIds, kind === "asset" ? id : null, kind === "facility" ? id : null)
            options.unshift({value: selected, label: target.name + (kind === "asset" ? " (equipment)" : " (facility)")})
        } catch (error) {
            // a selected value the user may not report on is left out
        }
    }
    return {options: options.slice(0, choiceLimit + 1)}
}
// A scanned asset tag (its EquipmentDetail link, or a typed id or serial) as the equipment the user may report on.
function resolveReportScan(p) {
    signedIn()
    const userScope = maintenanceAccess.scope()
    const scanText = text(p.scanText)
    if (!userScope.capabilities.request || !scanText) return {matches: []}
    const organizationPartyIds = reportOrganizations(userScope)
    const linked = /[?&]assetId=([^&#]+)/.exec(scanText)
    const wanted = linked ? decodeURIComponent(linked[1]) : scanText
    const rows = Array.from(
        find(ASSET)
            .condition(
                anyOf([
                    factory().makeCondition("assetId", "equals", wanted),
                    factory().makeCondition("serialNumber", "equals", wanted)
                ])
            )
            .limit(10)
            .list()
    )
    const matches = []
    for (const row of rows) {
        if (!row.assetTypeEnumId || stockTypes.includes(row.assetTypeEnumId)) continue
        if (!covers(organizationPartyIds, maintenanceAccess.assetOrganization(row.assetId))) continue
        matches.push({
            identityType: "asset",
            id: row.assetId,
            label: "Equipment " + (row.assetName || row.assetId),
            detail: row.serialNumber || ""
        })
    }
    return {matches}
}

// ===== find#MaintenanceRequests =====
// The organization of a request (its current OrgInternal party), or null.
function requestOrganization(requestId) {
    const row = Array.from(
        find(REQUEST_PARTY, {requestId, roleTypeId: "OrgInternal"}).conditionDate("fromDate", "thruDate", now()).limit(1).list()
    )[0]
    return row?.partyId || null
}
// The managed work order a request is linked to (RequestWorkEffort to a root with a MaintenanceWorkOrder row), or null.
function linkedOrder(requestId) {
    const workIds = Array.from(find(REQUEST_WORK, {requestId}).list()).map(row => row.workEffortId)
    if (!workIds.length) return null
    const order = Array.from(find(ORDER).condition("workEffortId", "in", workIds).limit(1).list())[0]
    return order ? one(WORK, {workEffortId: order.workEffortId}) : null
}
function requestRows(rows, reach) {
    const requestIds = rows.map(row => row.requestId)
    const targets = {}
    const works = {}
    if (requestIds.length) {
        for (const link of Array.from(
            find(REQUEST_RECORD)
                .condition("requestId", "in", requestIds)
                .condition("recordEntityName", "in", Object.values(targetEntities))
                .list()
        ))
            if (!targets[link.requestId]) targets[link.requestId] = link
        const links = Array.from(find(REQUEST_WORK).condition("requestId", "in", requestIds).list())
        const workIds = ids(links.map(link => link.workEffortId))
        const managed = workIds.length
            ? new Set(
                  Array.from(find(ORDER).condition("workEffortId", "in", workIds).selectField("workEffortId").list()).map(
                      r => r.workEffortId
                  )
              )
            : new Set()
        const roots = workIds.length
            ? Object.fromEntries(
                  Array.from(find(WORK).condition("workEffortId", "in", workIds).list()).map(r => [r.workEffortId, r])
              )
            : {}
        for (const link of links)
            if (managed.has(link.workEffortId) && !works[link.requestId]) works[link.requestId] = roots[link.workEffortId]
    }
    const assetIds = Object.values(targets)
        .filter(t => t.recordEntityName === ASSET)
        .map(t => t.recordId)
    const facilityIds = Object.values(targets)
        .filter(t => t.recordEntityName === FACILITY)
        .map(t => t.recordId)
    const assetNames = assetIds.length
        ? Object.fromEntries(
              Array.from(find(ASSET).condition("assetId", "in", assetIds).list()).map(r => [r.assetId, r.assetName])
          )
        : {}
    const facilityNames = facilityIds.length
        ? Object.fromEntries(
              Array.from(find(FACILITY).condition("facilityId", "in", facilityIds).list()).map(r => [
                  r.facilityId,
                  r.facilityName
              ])
          )
        : {}
    const reporters = reach.triage ? lib.partyNames(rows.map(row => row.filedByPartyId)) : {}
    return rows.map(row => {
        const target = targets[row.requestId]
        const work = works[row.requestId]
        const kind = target ? (target.recordEntityName === ASSET ? "asset" : "facility") : null
        return {
            requestId: row.requestId,
            requestName: row.requestName || row.requestId,
            statusId: row.statusId,
            statusText: statusText(row.statusId),
            resolutionText: row.statusId === "ReqCancelled" ? enumText(row.requestResolutionEnumId) : "",
            priority: row.priority,
            requestDateText: dateText(row.requestDate),
            targetKind: kind,
            targetId: target?.recordId || null,
            targetName: target
                ? (kind === "asset" ? assetNames[target.recordId] : facilityNames[target.recordId]) || target.recordId
                : "",
            // the reporter's name for a triager; a requester reads only their own requests
            reporterName: reach.triage ? reporters[row.filedByPartyId] || "" : "",
            triaged: !!work || doneStatuses.includes(row.statusId),
            workEffortId: work?.workEffortId || null,
            workEffortName: work ? work.workEffortName || work.workEffortId : "",
            workStatusText: work ? statusText(work.statusId) : ""
        }
    })
}
function findRequests(p) {
    const reach = requestScope()
    let query = find(REQUEST_VIEW)
        .condition("requestTypeEnumId", requestType)
        .condition("organizationRoleTypeId", "OrgInternal")
        .condition("organizationThruDate", "is-null", null)
    if (reach.triage) {
        const organizationPartyIds = reach.userScope.organizationPartyIds
        if (organizationPartyIds != null)
            query.condition("organizationPartyId", "in", organizationPartyIds.length ? organizationPartyIds : ["_NA_"])
        if (!blank(p.organizationPartyId)) query.condition("organizationPartyId", text(p.organizationPartyId))
    } else {
        query.condition("filedByPartyId", reach.partyId || "_NA_")
    }
    if (!blank(p.requestId)) query.condition("requestId", text(p.requestId))
    const term = text(p.text)
    if (term) query.condition(anyOf([like("requestId", term), like("requestName", term)]))
    const status = text(p.statusId) || "open"
    if (status === "open") query.condition("statusId", "in", openStatuses)
    else if (status === "untriaged") query.condition("statusId", "ReqSubmitted")
    else if (status !== "all") query.condition("statusId", status)
    const assetId = text(p.assetId)
    const facilityId = text(p.facilityId)
    if (assetId || facilityId) {
        const linked = Array.from(
            find(REQUEST_RECORD, {recordEntityName: assetId ? ASSET : FACILITY, recordId: assetId || facilityId})
                .selectField("requestId")
                .limit(queueScanLimit)
                .list()
        ).map(row => row.requestId)
        query.condition("requestId", "in", linked.length ? linked : ["_NA_"])
    }
    query = query.orderBy("priority").orderBy("-requestDate")
    const count = query.count()
    const paged = lib.page(query, p, "requestList", count)
    const rows = requestRows(paged.rows, reach)
    const untriaged = status === "untriaged" ? rows.filter(row => !row.workEffortId) : rows
    return {
        requestList: untriaged,
        requestListCount: paged.requestListCount,
        requestListPageIndex: paged.requestListPageIndex,
        requestListPageSize: paged.requestListPageSize,
        requestListPageMaxIndex: paged.requestListPageMaxIndex,
        requestListPageRangeLow: paged.requestListPageRangeLow,
        requestListPageRangeHigh: paged.requestListPageRangeHigh,
        canTriage: reach.triage
    }
}

// ===== triage#MaintenanceRequest =====
const triageFields = [
    "requestId",
    "decision",
    "workEffortId",
    "assetId",
    "facilityId",
    "workEffortName",
    "priority",
    "teamPartyId",
    "severityEnumId",
    "requestResolutionEnumId",
    "comments",
    "assigneePartyId"
]
// A request the caller triages: RqtMaintenance of their organizations (missing and outside alike RECORD_UNAVAILABLE).
function triageRequest(reach, requestId) {
    const id = text(requestId)
    const request = id ? one(REQUEST, {requestId: id}) : null
    const organizationPartyId = request ? requestOrganization(id) : null
    if (!request || request.requestTypeEnumId !== requestType || !maintenanceAccess.covers(reach.userScope, organizationPartyId))
        denied("RECORD_UNAVAILABLE", "Request " + (id || "") + " is not available")
    return {request, organizationPartyId}
}
function reviewed(request) {
    if (request.statusId === "ReqSubmitted") call("update#" + REQUEST, {requestId: request.requestId, statusId: "ReqReviewed"})
}
function linkWork(requestId, workEffortId) {
    if (find(REQUEST_WORK, {requestId, workEffortId}).count() === 0) call("create#" + REQUEST_WORK, {requestId, workEffortId})
}
// The request's open AssetMaintenance that no work has yet (Manufacturing's request), or null.
function requestMaintenance(requestId) {
    const links = Array.from(find(REQUEST_RECORD, {requestId, recordEntityName: MAINTENANCE}).list())
    for (const link of links) {
        const row = one(MAINTENANCE, {assetMaintenanceId: link.recordId})
        if (row && maintenanceOpenStatuses.includes(row.statusId)) return row
    }
    return null
}
// One of the organization's people now (an employee or agent), for the request's assignee.
function requireMember(organizationPartyId, partyId) {
    const member =
        !!one("mantle.party.Person", {partyId}) &&
        find("mantle.party.PartyRelationship")
            .condition({fromPartyId: partyId, toPartyId: organizationPartyId})
            .condition("relationshipTypeEnumId", "in", memberRelationships)
            .conditionDate("fromDate", "thruDate", now())
            .count() > 0
    if (!member) denied("ASSIGNEE_UNAVAILABLE", "Person " + partyId + " does not work for the organization")
}
function triage(p) {
    const reach = requestScope()
    if (!reach.triage) denied("PERMISSION_DENIED", "Maintenance planning is required to triage a request")
    const decision = text(p.decision)
    if (!["create", "link", "reject", "assign"].includes(decision))
        denied("VALUE_INVALID", "Decide to create work, link work, reject or assign, not " + (decision || "nothing"))
    const {request, organizationPartyId} = triageRequest(reach, p.requestId)
    const requestId = request.requestId
    let op = null
    if (!blank(p.operationKey)) {
        op = lib.operation(
            p,
            "MaintenanceTriage",
            organizationPartyId,
            triageFields.map(field => (p[field] == null ? "" : String(p[field])))
        )
        const earlier = lib.previous(op)
        if (earlier) return Object.assign({}, earlier, {repeated: true})
    }
    const finish = result => {
        if (op) lib.complete(op, REQUEST, requestId, result)
        return result
    }
    const linked = linkedOrder(requestId)
    if (decision === "assign") {
        const assigneePartyId = text(p.assigneePartyId)
        if (!assigneePartyId) denied("ASSIGNEE_REQUIRED", "Choose who handles the request")
        requireMember(organizationPartyId, assigneePartyId)
        for (const row of Array.from(
            find(REQUEST_PARTY, {requestId, roleTypeId: "Assignee"}).conditionDate("fromDate", "thruDate", now()).list()
        ))
            if (row.partyId !== assigneePartyId)
                call("update#" + REQUEST_PARTY, {
                    requestId,
                    partyId: row.partyId,
                    roleTypeId: "Assignee",
                    fromDate: row.fromDate,
                    thruDate: now()
                })
        if (
            find(REQUEST_PARTY, {requestId, partyId: assigneePartyId, roleTypeId: "Assignee"})
                .conditionDate("fromDate", "thruDate", now())
                .count() === 0
        )
            call("create#" + REQUEST_PARTY, {requestId, partyId: assigneePartyId, roleTypeId: "Assignee", fromDate: now()})
        return finish({
            requestId,
            decision,
            statusId: request.statusId,
            workEffortId: linked?.workEffortId || null,
            repeated: false
        })
    }
    if (decision === "create" && linked)
        return finish({requestId, decision, statusId: request.statusId, workEffortId: linked.workEffortId, repeated: true})
    if (decision === "link" && linked && linked.workEffortId === text(p.workEffortId))
        return finish({requestId, decision, statusId: request.statusId, workEffortId: linked.workEffortId, repeated: true})
    if (linked) denied("REQUEST_TRIAGED", "Request " + requestId + " was triaged to work order " + linked.workEffortId)
    if (doneStatuses.includes(request.statusId))
        denied("REQUEST_CLOSED", "Request " + requestId + " is " + statusText(request.statusId))
    if (decision === "reject") {
        const reason = text(p.requestResolutionEnumId)
        if (!reason || !rejectReasons.includes(reason)) denied("REASON_REQUIRED", "Give the reason the request is rejected")
        call("update#" + REQUEST, {requestId, statusId: "ReqCancelled", requestResolutionEnumId: reason})
        if (text(p.comments))
            call("mantle.request.RequestServices.add#RequestComment", {
                requestId,
                subject: "Rejected: " + enumText(reason),
                body: text(p.comments)
            })
        return finish({requestId, decision, statusId: "ReqCancelled", workEffortId: null, repeated: false})
    }
    let workEffortId
    if (decision === "link") {
        workEffortId = text(p.workEffortId)
        if (!workEffortId) denied("WORK_REQUIRED", "Choose the work order the request belongs to")
        const found = maintenanceAccess.requireWork(reach.userScope, workEffortId)
        const root = one(WORK, {workEffortId: found.rootWorkEffortId})
        if (found.rootWorkEffortId !== workEffortId || !one(ORDER, {workEffortId}) || root.isTemplate === "Y")
            denied("RECORD_UNAVAILABLE", "Work order " + workEffortId + " is not available")
        if (!workOpenStatuses.includes(root.statusId))
            denied("WORK_CLOSED", "Work order " + workEffortId + " is " + statusText(root.statusId))
        if (found.organizationPartyId !== organizationPartyId)
            denied("ORGANIZATION_MISMATCH", "Work order " + workEffortId + " is another organization's work")
    } else {
        // create: adopt the request's open AssetMaintenance (Manufacturing's), else new corrective work on its target
        const maintenance = requestMaintenance(requestId)
        if (maintenance && !maintenance.taskWorkEffortId) {
            workEffortId = maintenanceWork.execute("adoptRecord", {
                assetMaintenanceId: maintenance.assetMaintenanceId,
                workEffortName: text(p.workEffortName) || request.requestName,
                priority: blank(p.priority) ? request.priority : p.priority
            }).workEffortId
        } else if (maintenance?.taskWorkEffortId && one(ORDER, {workEffortId: maintenance.taskWorkEffortId})) {
            workEffortId = maintenance.taskWorkEffortId
        } else {
            const recorded = recordedTarget(requestId)
            const given = targetOf(
                reach.userScope.organizationPartyIds,
                text(p.assetId) || (!text(p.facilityId) && recorded?.kind === "asset" ? recorded.id : null),
                text(p.facilityId) || (!text(p.assetId) && recorded?.kind === "facility" ? recorded.id : null)
            )
            if (given.organizationPartyId !== organizationPartyId)
                denied("ORGANIZATION_MISMATCH", "The target is not the request's organization's")
            if (recorded && recorded.id !== given.id)
                denied("ONE_TARGET", "Request " + requestId + " is about " + recorded.name + "; its work is too")
            if (!recorded) recordTarget(requestId, given)
            const team = Array.from(find(REQUEST_PARTY, {requestId, roleTypeId: "OrgTeam"}).limit(1).list())[0]
            workEffortId = maintenanceWork.execute("createWorkOrder", {
                assetId: given.kind === "asset" ? given.id : null,
                facilityId: given.kind === "facility" ? given.id : null,
                workEffortName: text(p.workEffortName) || request.requestName,
                description: request.description,
                maintenanceKindEnumId: "MkCorrective",
                sourceEnumId: "MsrcReport",
                severityEnumId: text(p.severityEnumId),
                priority: blank(p.priority) ? request.priority : p.priority,
                teamPartyId: text(p.teamPartyId) || team?.partyId || null
            }).workEffortId
        }
    }
    linkWork(requestId, workEffortId)
    reviewed(request)
    return finish({requestId, decision, statusId: one(REQUEST, {requestId}).statusId, workEffortId, repeated: false})
}

// ===== the adoption queue =====
// find#UnmanagedMaintenance: the open AssetMaintenance records with no work of the caller's organizations (Manufacturing's
// requests, the baseline's), newest first, each with the request that asked for it; a warranty repair is Customer Service's.
function unmanaged(p) {
    const reach = requestScope()
    if (!reach.triage) denied("PERMISSION_DENIED", "Maintenance planning is required")
    const organizationPartyIds = reach.userScope.organizationPartyIds
    const rows = Array.from(
        find(MAINTENANCE)
            .condition("statusId", "in", maintenanceOpenStatuses)
            .condition("taskWorkEffortId", "is-null", null)
            .condition(
                anyOf([
                    factory().makeCondition("maintenanceTypeEnumId", "is-null", null),
                    factory().makeCondition("maintenanceTypeEnumId", "not-equals", "MntTpWarranty")
                ])
            )
            .orderBy("-maintenanceDate")
            .limit(queueScanLimit)
            .list()
    )
    const assetIds = ids(rows.map(row => row.assetId))
    const assets = assetIds.length
        ? Object.fromEntries(Array.from(find(ASSET).condition("assetId", "in", assetIds).list()).map(r => [r.assetId, r]))
        : {}
    const organizations = {}
    const wanted = text(p.organizationPartyId)
    const kept = rows
        .filter(row => {
            if (!row.assetId || !assets[row.assetId]) return false
            if (!(row.assetId in organizations)) organizations[row.assetId] = maintenanceAccess.assetOrganization(row.assetId)
            const organizationPartyId = organizations[row.assetId]
            return covers(organizationPartyIds, organizationPartyId) && (!wanted || wanted === organizationPartyId)
        })
        .slice(0, queueLimit)
    const maintenanceIds = kept.map(row => row.assetMaintenanceId)
    const requests = {}
    if (maintenanceIds.length)
        for (const link of Array.from(
            find(REQUEST_RECORD).condition("recordEntityName", MAINTENANCE).condition("recordId", "in", maintenanceIds).list()
        ))
            requests[link.recordId] = link.requestId
    return {
        maintenanceList: kept.map(row => ({
            assetMaintenanceId: row.assetMaintenanceId,
            assetId: row.assetId,
            assetName: assets[row.assetId].assetName || row.assetId,
            statusText: statusText(row.statusId),
            typeText: enumText(row.maintenanceTypeEnumId),
            maintenanceDateText: dateText(row.maintenanceDate),
            comments: row.comments || "",
            requestId: requests[row.assetMaintenanceId] || null
        }))
    }
}

// ===== create#MaintenanceRequestFromEmail =====
// The maintenance team a message is for: the rule's value (a team's partyId), else the team whose plus tag one of its To or Cc
// addresses carries; only a team the rule's owner works for (an employee or agent of the team's organization), so a rule cannot
// file mail into another organization. {teamPartyId, organizationPartyId} or null.
function intakeTeam(message, value, ruleOwnerUserId) {
    let candidates = []
    if (!blank(value)) candidates = [text(value)]
    else {
        const tags = new Set()
        for (const list of [message.toAddresses, message.ccAddresses])
            for (const match of String(list || "").matchAll(/[^\s<>,;"]+\+([A-Za-z0-9._-]+)@[^\s<>,;"]+/g))
                tags.add(match[1].toLowerCase())
        if (!tags.size) return null
        candidates = Array.from(find("mantle.party.PartySetting", {partySettingTypeId: plusTagSetting}).list())
            .filter(row =>
                tags.has(
                    String(row.settingValue || "")
                        .trim()
                        .toLowerCase()
                )
            )
            .map(row => row.partyId)
    }
    const ownerPartyId = ruleOwnerUserId ? one("moqui.security.UserAccount", {userId: ruleOwnerUserId})?.partyId : null
    for (const partyId of candidates) {
        const team = one("mantle.party.Party", {partyId})
        if (!team?.ownerPartyId || !one("mantle.party.PartyRole", {partyId, roleTypeId: "OrgTeam"})) continue
        const member =
            !!ownerPartyId &&
            find("mantle.party.PartyRelationship")
                .condition({fromPartyId: ownerPartyId, toPartyId: team.ownerPartyId})
                .condition("relationshipTypeEnumId", "in", memberRelationships)
                .conditionDate("fromDate", "thruDate", now())
                .count() > 0
        if (!member) {
            ec.logger.warn(
                "Email " +
                    message.emailMessageId +
                    ": the rule of " +
                    (ruleOwnerUserId || "nobody") +
                    " may not file into team " +
                    partyId
            )
            continue
        }
        return {teamPartyId: partyId, organizationPartyId: team.ownerPartyId}
    }
    return null
}
// The equipment of the organization whose id the subject names, when it names exactly one; else none (left for triage).
function subjectTarget(subject, organizationPartyId) {
    const tokens = ids(
        String(subject || "")
            .split(/[^A-Za-z0-9_-]+/)
            .filter(token => token.length >= 3)
    ).slice(0, 30)
    if (!tokens.length) return null
    const found = Array.from(find(ASSET).condition("assetId", "in", tokens).list()).filter(
        row =>
            row.assetTypeEnumId &&
            !stockTypes.includes(row.assetTypeEnumId) &&
            maintenanceAccess.assetOrganization(row.assetId) === organizationPartyId
    )
    if (found.length !== 1) return null
    return targetOf([organizationPartyId], found[0].assetId, null)
}
function fromEmail(p) {
    const wasDisabled = ec.artifactExecution.disableAuthz()
    try {
        const emailMessageId = text(p.emailMessageId)
        const message = emailMessageId ? one("moqui.basic.email.EmailMessage", {emailMessageId}) : null
        if (!message) denied("RECORD_UNAVAILABLE", "Email message " + (emailMessageId || "") + " is not available")
        const already = Array.from(find("mantle.request.RequestEmailMessage", {emailMessageId}).limit(1).list())[0]
        if (already) return {requestId: already.requestId, created: false, joined: false}
        const thread = call("mantle.request.RequestServices.find#EmailRequest", {emailMessageId})
        if (thread.requestId) {
            call("mantle.request.RequestServices.file#RequestEmail", {requestId: thread.requestId, emailMessageId})
            return {requestId: thread.requestId, created: false, joined: true}
        }
        const team = intakeTeam(message, p.value, p.ruleOwnerUserId)
        // no maintenance team: an ordinary request, as the createRequest action makes it
        if (!team) {
            const out = call("mantle.request.RequestServices.create#RequestFromEmail", {
                emailMessageId,
                emailAccountId: p.emailAccountId || null,
                emailRuleId: p.emailRuleId || null,
                ruleOwnerUserId: p.ruleOwnerUserId || null
            })
            return {requestId: out.requestId || null, created: !!out.created, joined: !!out.joined}
        }
        const sender = call("mantle.request.RequestServices.findOrCreate#EmailSender", {emailMessageId})
        const body = String(
            message.bodyText ||
                String(message.body || "")
                    .replace(/<(style|script)[^>]*>[\s\S]*?<\/\1>/gi, " ")
                    .replace(/<br\s*\/?>/gi, "\n")
                    .replace(/<\/p>/gi, "\n\n")
                    .replace(/<[^>]*>/g, " ")
                    .replace(/&nbsp;/g, " ")
                    .replace(/&lt;/g, "<")
                    .replace(/&gt;/g, ">")
                    .replace(/&amp;/g, "&")
        ).trim()
        const requestId = makeRequest({
            summary: String(message.subject || "").trim() || ec.l10n.localize("(no subject)"),
            description: body.substring(0, 20000) || null,
            priority: 5,
            target: subjectTarget(message.subject, team.organizationPartyId),
            organizationPartyId: team.organizationPartyId,
            teamPartyId: team.teamPartyId,
            reporterPartyId: sender.partyId || null,
            emailContactMechId: sender.contactMechId || null,
            salesChannelEnumId: "ScEmail",
            requestDate: message.receivedDate || message.messageDate || now()
        })
        call("mantle.request.RequestServices.file#RequestEmail", {requestId, emailMessageId})
        return {requestId, created: true, joined: false}
    } finally {
        if (!wasDisabled) ec.artifactExecution.enableAuthz()
    }
}

// ===== Mantle's own callers =====
// link#RequestRecord's rule (design §3 Requests): a maintenance request has at most one Asset or Facility target; another is
// ONE_TARGET (the work order holds the related resources).
function checkTargetLink(requestId, recordEntityName, recordId) {
    if (!Object.values(targetEntities).includes(recordEntityName)) return
    const request = one(REQUEST, {requestId})
    if (request?.requestTypeEnumId !== requestType) return
    const other = Array.from(
        find(REQUEST_RECORD, {requestId}).condition("recordEntityName", "in", Object.values(targetEntities)).list()
    ).find(row => !(row.recordEntityName === recordEntityName && row.recordId === recordId))
    if (other)
        denied("ONE_TARGET", "Request " + requestId + " is about " + other.recordId + "; a maintenance request has one target")
}
// request#ProductionMaintenance's handoff (impl-maintenance P4, F25; Manufacturing's owner contract): with the organization's
// policy managing production requests, the new AssetMaintenance is adopted into a work order once and its request linked to it;
// otherwise nothing changes. A failure leaves the request for triage and is logged, never the stop's.
function productionHandoff(requested) {
    const organizationPartyId = requested?.organizationPartyId
    if (!organizationPartyId || !requested.assetMaintenanceId) return requested
    if (!maintenanceWork.policyOf(organizationPartyId).productionRequestsManaged) return requested
    ec.message.pushErrors()
    try {
        const adopted = maintenanceWork.adoptForOwner({
            assetMaintenanceId: requested.assetMaintenanceId,
            organizationPartyId
        })
        if (requested.requestId) {
            linkWork(requested.requestId, adopted.workEffortId)
            reviewed(one(REQUEST, {requestId: requested.requestId}))
        }
        return Object.assign({}, requested, {workEffortId: adopted.workEffortId})
    } catch (error) {
        // its refusals come before any write (the record, the organization, the team)
        ec.logger.error("Maintenance " + requested.assetMaintenanceId + " was not adopted: " + error.message)
        return requested
    } finally {
        ec.message.clearErrors()
        ec.message.popErrors()
    }
}
// notify#RequestTriage's routing of a maintenance request (design §13.3 RequestTriageNotice): the users of its organization who
// hold MAINTENANCE_PLAN (through a current group membership; a person employed by or an agent of it), and the title's name: its
// target's, never the reporter's text. null for any other request.
function triageNotice(request) {
    if (request?.requestTypeEnumId !== requestType) return null
    const organizationPartyId = requestOrganization(request.requestId)
    const target = recordedTarget(request.requestId)
    const requestName = target ? "Problem reported on " + target.name : "Problem reported, no target yet"
    if (!organizationPartyId) return {userIds: [], requestName}
    const groupIds = ids(
        Array.from(find("moqui.security.UserGroupPermission", {userPermissionId: "MAINTENANCE_PLAN"}).list())
            .filter(row => lib.active(row))
            .map(row => row.userGroupId)
    )
    if (!groupIds.length) return {userIds: [], requestName}
    const userIds = ids(
        Array.from(find("moqui.security.UserGroupMember").condition("userGroupId", "in", groupIds).list())
            .filter(row => lib.active(row))
            .map(row => row.userId)
    )
    if (!userIds.length) return {userIds: [], requestName}
    const accounts = Array.from(find("moqui.security.UserAccount").condition("userId", "in", userIds).list()).filter(
        row => row.partyId && row.disabled !== "Y"
    )
    const partyIds = ids(accounts.map(row => row.partyId))
    const members = partyIds.length
        ? new Set(
              Array.from(
                  find("mantle.party.PartyRelationship")
                      .condition("fromPartyId", "in", partyIds)
                      .condition("toPartyId", organizationPartyId)
                      .condition("relationshipTypeEnumId", "in", memberRelationships)
                      .conditionDate("fromDate", "thruDate", now())
                      .list()
              ).map(row => row.fromPartyId)
          )
        : new Set()
    return {userIds: accounts.filter(row => members.has(row.partyId)).map(row => row.userId), requestName}
}

const operations = {
    reportProblem,
    reportTargets,
    resolveReportScan,
    findRequests,
    triage,
    unmanaged,
    fromEmail
}
;({
    execute: (op, parameters) => {
        if (!Object.hasOwn(operations, op)) throw new Error("Unknown maintenance intake operation " + op)
        return operations[op](parameters || {})
    },
    checkTargetLink,
    productionHandoff,
    triageNotice
})
