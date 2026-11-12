// Maintenance procedures (mantle.work.ProcessServices; IronStone Maintenance design §4.1, §4.2, Procedures and ProcedureDetail,
// §12; impl-maintenance P6): the checked path of the WppMaintenanceProcedure policy over People's process engine
// (WorkProcesses.js), which stays as People built it. A procedure is a template root (isTemplate Y, WetTask, WepMaintenance, the
// WorkEffortProcedure flow) owned by its organization, with ordered child steps (a step with steps under it is a group), each
// with a dated WorkEffortStepPolicy, and the root's WorkEffortProcessPolicy of WppMaintenanceProcedure, which guards execution:
// the template and its steps, and every execution made of it, are managed work the generic task services refuse
// (check#ManagedWork), and a template is never a work order, a task or a time target.
//
// - Authority (permissions, never a group): WORK_PROCESS_VIEW reads the procedures of the caller's maintenance organizations;
//   WORK_PROCESS_EDIT authors them; WORK_PROCESS_APPROVE approves, refuses and retires them; MAINTENANCE_PLAN or _SUPERVISE makes
//   work of one (create#MaintenanceWorkOrder, F58: each policy has its own edit and instantiation permissions). A technician who
//   reads no procedure reads one that work assigned to them was made from, read only. A missing procedure and one outside the
//   scope are refused alike (RECORD_UNAVAILABLE).
// - States: Draft (WeInPlanning), Approved (WeApproved), Retired (WeClosed). An author's change of an approved procedure takes it
//   back to Draft (amended; new work waits for the next approval) and cancels a request waiting; work made earlier keeps its own
//   rows. The approval is a WorkEffortApproval row (F44): requested (request#WorkProcessApproval, which checks the definition and
//   tells the organization's approvers on WorkProcessApproval), then approved or refused by an approver who is not the last
//   author unless the organization's MaintenancePolicy allows self-approval. Approval sets the effective time (now or later),
//   publishes each step's draft instruction as a WectInstruction row in the shape of Manufacturing's rule (F68: stored once
//   with its sha256 and its from date, the one before ended) and stores the definition as a PDF (WectPublishedProcedure).
// - Instantiation (instantiateProcedure, design §4.2 step 1): the caller's instantiation permission and scope, the template
//   approved and effective at the creation time and applicable to the target; then People's two-pass instantiate (ID map,
//   remapped dependencies, one WeatBasedOn link per node, the step policies with their fields); then the planned requirements
//   copied from each template node (WorkEffortProduct, WorkEffortAssetNeeded, WorkEffortSkillStandard; no skill level until
//   People's P18, F75). Instructions are not copied: an execution step resolves its template step's instruction in effect when
//   it was made through its WeatBasedOn link (findInstructions).
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const maintenanceAccess = ec.resource.script("component://mr-mantle/service/mantle/work/MaintenanceAccess.js")
const workProcesses = ec.resource.script("component://mr-mantle/service/mantle/work/WorkProcesses.js")
const {find, one, rows, denied, call, ms} = lib

const WORK = "mantle.work.effort.WorkEffort"
const ASSOC = "mantle.work.effort.WorkEffortAssoc"
const PROCESS = "mantle.work.effort.WorkEffortProcessPolicy"
const STEP = "mantle.work.effort.WorkEffortStepPolicy"
const CONTENT = "mantle.work.effort.WorkEffortContent"
const APPROVAL = "mantle.work.effort.WorkEffortApproval"
const PRODUCT = "mantle.work.effort.WorkEffortProduct"
const ASSET_NEEDED = "mantle.work.effort.WorkEffortAssetNeeded"
const SKILL = "mantle.work.effort.WorkEffortSkillStandard"
const ORDER = "mantle.work.maintenance.MaintenanceWorkOrder"
const POLICY = "mantle.work.maintenance.MaintenancePolicy"
const MESSAGE = "moqui.security.user.NotificationMessage"
const MESSAGE_USER = "moqui.security.user.NotificationMessageUser"
const PROCEDURE = "WppMaintenanceProcedure"
const FLOW = "WorkEffortProcedure"
const DRAFT = "WectProcedureDraft"
const INSTRUCTION = "WectInstruction"
const PUBLISHED = "WectPublishedProcedure"
const TOPIC = "WorkProcessApproval"
const statusNames = {WeInPlanning: "Draft", WeApproved: "Approved", WeClosed: "Retired"}
const memberRelationships = ["PrtEmployee", "PrtAgent"]
const listCap = 2000
const minuteMs = 60 * 1000

const blank = value => value == null || String(value).trim() === ""
const text = value => (blank(value) ? null : String(value).trim())
const flag = value => value === true || value === "true" || value === "Y"
const nowMs = () => ms(ec.user.nowTimestamp)
const stamp = millis => (millis == null ? null : new Date(millis))
const dateText = value => (value == null || value === "" ? "" : lib.dateText(value))
const number = value => (value == null || value === "" ? null : Number(String(value)))
const unique = list => Array.from(new Set(list.filter(Boolean)))
const openAt = (row, at) => (ms(row.fromDate) ?? -Infinity) <= at && (ms(row.thruDate) ?? Infinity) > at
const enumText = enumId => (enumId ? one("moqui.basic.Enumeration", {enumId})?.description || enumId : "")
const unavailable = id => denied("RECORD_UNAVAILABLE", "Procedure " + (id || "") + " is not available")

// ===== the procedure and the caller =====
function signedIn() {
    if (!ec.user.userId) denied("PERMISSION_DENIED", "Sign in to use maintenance procedures")
}
// A procedure's root, its process policy in effect and its organization, or null: a template root of WetTask and WepMaintenance
// whose policy is Maintenance's.
function procedureOf(workEffortId) {
    const root = workEffortId ? one(WORK, {workEffortId}) : null
    if (!root || root.isTemplate !== "Y" || root.rootWorkEffortId || root.parentWorkEffortId) return null
    if (root.workEffortTypeEnumId !== "WetTask" || root.purposeEnumId !== "WepMaintenance") return null
    const policy = latestPolicy(root.workEffortId)
    if (!policy || policy.processPolicyEnumId !== PROCEDURE) return null
    return {root, policy, organizationPartyId: root.ownerPartyId}
}
// The process policy row of a procedure: the one in effect, else the latest (a procedure keeps one row; its effectivity is in its
// publication fields).
function latestPolicy(workEffortId) {
    const found = rows(PROCESS, {workEffortId}).sort((a, b) => ms(b.fromDate) - ms(a.fromDate))
    return found.find(row => openAt(row, nowMs())) || found[0] || null
}
// The caller's work orders made from a procedure (assigned to the root or a step), for a technician's read of it.
function assignedExecution(userScope, procedureId) {
    if (!userScope.capabilities.workRead || !userScope.partyId) return false
    const roots = Array.from(
        find(ORDER, {procedureWorkEffortId: procedureId}).selectField("workEffortId").limit(listCap).list()
    ).map(row => row.workEffortId)
    if (!roots.length) return false
    const assigned = Array.from(
        find("mantle.work.effort.WorkEffortParty", {partyId: userScope.partyId})
            .conditionDate("fromDate", "thruDate", ec.user.nowTimestamp)
            .selectField("workEffortId")
            .list()
    ).map(row => row.workEffortId)
    if (!assigned.length) return false
    if (assigned.some(id => roots.includes(id))) return true
    return find(WORK).condition("workEffortId", "in", unique(assigned)).condition("rootWorkEffortId", "in", roots).count() > 0
}
// A procedure the caller may reach for need (read, edit, approve, instantiate): {root, policy, organizationPartyId, readOnly (no
// authoring), assignedRead (read only as the technician of work made of it)}.
function requireProcedure(userScope, workEffortId, need = "read") {
    const found = procedureOf(text(workEffortId))
    if (!found) unavailable(workEffortId)
    const caps = userScope.capabilities
    const covered = maintenanceAccess.covers(userScope, found.organizationPartyId)
    const reader = covered && caps.processView
    if (need === "read") {
        if (reader) return Object.assign(found, {readOnly: !caps.processEdit, assignedRead: false})
        if (assignedExecution(userScope, found.root.workEffortId))
            return Object.assign(found, {readOnly: true, assignedRead: true})
        unavailable(workEffortId)
    }
    const wanted = {edit: "processEdit", approve: "processApprove", instantiate: null}[need]
    if (need === "instantiate") {
        if (!caps.plan && !caps.supervise)
            denied("PERMISSION_DENIED", "A maintenance planner or supervisor makes work of a procedure")
    } else if (!caps[wanted]) {
        if (!reader) unavailable(workEffortId)
        denied(
            "PERMISSION_DENIED",
            need === "edit" ? "Changing a procedure needs WORK_PROCESS_EDIT" : "Approving a procedure needs WORK_PROCESS_APPROVE"
        )
    }
    if (!covered) unavailable(workEffortId)
    return Object.assign(found, {readOnly: false, assignedRead: false})
}
function scopeWithAny(capabilities) {
    signedIn()
    const userScope = maintenanceAccess.scope()
    if (!capabilities.some(name => userScope.capabilities[name]))
        denied("PERMISSION_DENIED", "Maintenance " + capabilities.join(" or ") + " is required")
    return userScope
}
function organizationName(partyId) {
    return partyId ? lib.partyNames([partyId])[partyId] || partyId : ""
}
function selfApprovalAllowed(organizationPartyId) {
    const row = Array.from(
        find(POLICY, {organizationPartyId})
            .conditionDate("fromDate", "thruDate", ec.user.nowTimestamp)
            .orderBy("-fromDate")
            .limit(1)
            .list()
    )[0]
    return flag(row?.procedureSelfApproval)
}

// ===== the tree =====
// The nodes of a procedure in effect now (root first, children after their parent, People's treeOf), with each node's depth and
// whether it is a group (a node with nodes under it).
function nodesOf(root, at = nowMs()) {
    const nodes = Array.from(workProcesses.treeOf(root, at))
    const depth = {[root.workEffortId]: 0}
    const children = {}
    for (const node of nodes)
        if (node.workEffortId !== root.workEffortId) {
            depth[node.workEffortId] = (depth[node.parentWorkEffortId] ?? 0) + 1
            ;(children[node.parentWorkEffortId] || (children[node.parentWorkEffortId] = [])).push(node.workEffortId)
        }
    return {nodes, depth, children}
}
// The tree in display order: each node followed by its children by sequence.
function orderedNodes(tree, root) {
    const byId = Object.fromEntries(tree.nodes.map(node => [node.workEffortId, node]))
    const out = []
    const walk = id => {
        out.push(byId[id])
        const kids = (tree.children[id] || [])
            .map(childId => byId[childId])
            .sort(
                (a, b) =>
                    (number(a.sequenceNum) ?? 0) - (number(b.sequenceNum) ?? 0) || a.workEffortId.localeCompare(b.workEffortId)
            )
        for (const kid of kids) walk(kid.workEffortId)
    }
    walk(root.workEffortId)
    return out
}
function treeIdSet(root) {
    return new Set([root.workEffortId].concat(rows(WORK, {rootWorkEffortId: root.workEffortId}).map(row => row.workEffortId)))
}
function dependenciesOf(nodeIds, at = nowMs()) {
    if (!nodeIds.length) return []
    return Array.from(
        find(ASSOC).condition("workEffortId", "in", nodeIds).condition("workEffortAssocTypeEnumId", "WeatDependsOn").list()
    ).filter(row => openAt(row, at))
}

// ===== an author's change =====
// Before an author's change: a retired procedure takes none; an approved one goes back to Draft (amended) and a request waiting
// is cancelled; the change is the caller's (lastAuthorUserId), which an approval checks.
function touch(found) {
    const {root, policy} = found
    if (root.statusId === "WeClosed")
        denied("PROCESS_RETIRED", "Procedure " + root.workEffortId + " is retired; clone it to change it")
    if (root.statusId === "WeApproved") call("update#" + WORK, {workEffortId: root.workEffortId, statusId: "WeInPlanning"})
    for (const request of pendingRequests(root.workEffortId))
        call("update#" + APPROVAL, {
            workEffortApprovalId: request.workEffortApprovalId,
            statusId: "WeaCancelled",
            decidedByUserId: ec.user.userId,
            decidedDate: ec.user.nowTimestamp,
            decisionComments: "The procedure was changed"
        })
    clearNotices(root.workEffortId)
    call("update#" + PROCESS, {
        workEffortId: policy.workEffortId,
        fromDate: policy.fromDate,
        lastAuthorUserId: ec.user.userId,
        lastAuthoredDate: ec.user.nowTimestamp
    })
}
const pendingRequests = workEffortId => rows(APPROVAL, {workEffortId, statusId: "WeaRequested"})

// ===== validation (the findings that block publication) =====
// Per-step findings: a group with a response, a reading without a measurement, unit or with a unit of another kind or bounds
// the wrong way round, bounds on a step that is no reading, a dependency on a step outside the procedure or in a loop, and a
// procedure with no step.
function findingsOf(root) {
    const tree = nodesOf(root)
    const ids = new Set(tree.nodes.map(node => node.workEffortId))
    const findings = []
    const named = node => node.workEffortName || node.workEffortId
    if (tree.nodes.length < 2) findings.push({workEffortId: root.workEffortId, message: "Add the procedure's steps"})
    for (const node of tree.nodes) {
        if (node.workEffortId === root.workEffortId) continue
        const policy = workProcesses.stepPolicyOf(node.workEffortId)
        if (!policy) continue
        const group = !!(tree.children[node.workEffortId] || []).length
        const kind = policy.responseKindEnumId
        if (group && kind)
            findings.push({workEffortId: node.workEffortId, message: named(node) + " is a group: its steps take the responses"})
        if (kind === "WsrReading") {
            const type = policy.measurementTypeId
                ? one("mantle.work.measurement.MeasurementType", {measurementTypeId: policy.measurementTypeId})
                : null
            const uom = policy.measurementUomId ? one("moqui.basic.Uom", {uomId: policy.measurementUomId}) : null
            if (!type)
                findings.push({workEffortId: node.workEffortId, message: named(node) + " is a reading with no measurement type"})
            if (!uom) findings.push({workEffortId: node.workEffortId, message: named(node) + " is a reading with no unit"})
            if (type && uom && type.uomTypeEnumId && uom.uomTypeEnumId !== type.uomTypeEnumId)
                findings.push({
                    workEffortId: node.workEffortId,
                    message:
                        named(node) +
                        ": the unit " +
                        (uom.abbreviation || uom.uomId) +
                        " does not measure " +
                        (type.description || type.measurementTypeId)
                })
        } else if (policy.minimumValue != null || policy.maximumValue != null)
            findings.push({workEffortId: node.workEffortId, message: named(node) + " has bounds but is no reading"})
        if (
            policy.minimumValue != null &&
            policy.maximumValue != null &&
            number(policy.minimumValue) > number(policy.maximumValue)
        )
            findings.push({workEffortId: node.workEffortId, message: named(node) + ": the minimum is above the maximum"})
    }
    for (const edge of dependenciesOf(Array.from(ids))) {
        if (!ids.has(edge.toWorkEffortId))
            findings.push({workEffortId: edge.workEffortId, message: "A step waits for work outside the procedure"})
        else if (workProcesses.dependsOn(edge.toWorkEffortId, edge.workEffortId, ids))
            findings.push({workEffortId: edge.workEffortId, message: "Steps wait for each other in a loop"})
    }
    return findings
}
// The fields of a step's response policy, checked: a known kind, measurement type and unit of its kind, numeric bounds.
function checkResponse(p) {
    if (
        !blank(p.responseKindEnumId) &&
        !one("moqui.basic.Enumeration", {enumId: text(p.responseKindEnumId), enumTypeId: "WorkStepResponseKind"})
    )
        denied("VALUE_INVALID", "Response kind " + p.responseKindEnumId + " is not known")
    if (
        !blank(p.measurementTypeId) &&
        !one("mantle.work.measurement.MeasurementType", {measurementTypeId: text(p.measurementTypeId)})
    )
        denied("VALUE_INVALID", "Measurement type " + p.measurementTypeId + " is not known")
    if (!blank(p.measurementUomId) && !one("moqui.basic.Uom", {uomId: text(p.measurementUomId)}))
        denied("VALUE_INVALID", "Unit " + p.measurementUomId + " is not known")
    for (const field of ["minimumValue", "maximumValue"])
        if (!blank(p[field]) && !Number.isFinite(Number(String(p[field])))) denied("VALUE_INVALID", "A bound is a number")
    for (const field of ["evidenceRequired", "commentRequired", "waiverAllowed", "isRequired"])
        if (p[field] != null && p[field] !== "") p[field] = flag(p[field]) ? "Y" : "N"
}

// ===== find#WorkProcesses =====
// The procedures of the caller's scope (WORK_PROCESS_VIEW; a planner or supervisor choosing one for new work with usable), by
// text, organization, state (draft, approved, retired; every state by default), maintenance type, equipment model, effective
// date, and, with usable, only those approved, effective now and applicable to assetId or facilityId.
function findProcesses(p) {
    const usable = flag(p.usable)
    const userScope = scopeWithAny(usable ? ["processView", "plan", "supervise"] : ["processView"])
    let query = find(WORK)
        .condition({isTemplate: "Y", workEffortTypeEnumId: "WetTask", purposeEnumId: "WepMaintenance"})
        .condition("rootWorkEffortId", "is-null", null)
        .condition("parentWorkEffortId", "is-null", null)
        .orderBy("workEffortName")
        .limit(listCap)
    const organizations = userScope.organizationPartyIds
    if (organizations != null) {
        if (!organizations.length) return pageOf([], p)
        query = query.condition("ownerPartyId", "in", organizations)
    }
    if (text(p.organizationPartyId)) query = query.condition("ownerPartyId", text(p.organizationPartyId))
    if (text(p.text)) {
        const factory = ec.entity.conditionFactory
        const like = "%" + text(p.text).replace(/[\\%_]/g, c => "\\" + c) + "%"
        query = query.condition(
            factory.makeCondition(
                ["workEffortId", "workEffortName"].map(field => factory.makeCondition(field, "like", like).ignoreCase()),
                "or"
            )
        )
    }
    const state = text(p.statusId)
    const statusOf = {draft: "WeInPlanning", approved: "WeApproved", retired: "WeClosed"}
    if (state && statusOf[state]) query = query.condition("statusId", statusOf[state])
    else if (usable) query = query.condition("statusId", "WeApproved")
    const roots = Array.from(query.list())
    const policies = {}
    if (roots.length)
        for (const row of Array.from(
            find(PROCESS)
                .condition(
                    "workEffortId",
                    "in",
                    roots.map(root => root.workEffortId)
                )
                .list()
        ))
            if (
                row.processPolicyEnumId === PROCEDURE &&
                (!policies[row.workEffortId] || ms(row.fromDate) > ms(policies[row.workEffortId].fromDate))
            )
                policies[row.workEffortId] = row
    const at = blank(p.effectiveDate) ? nowMs() : ms(p.effectiveDate)
    const target = usable ? targetOf(userScope, p) : null
    let found = roots.filter(root => policies[root.workEffortId])
    if (text(p.maintenanceTypeEnumId))
        found = found.filter(root => policies[root.workEffortId].maintenanceTypeEnumId === text(p.maintenanceTypeEnumId))
    if (text(p.applicableProductId))
        found = found.filter(root => policies[root.workEffortId].applicableProductId === text(p.applicableProductId))
    if (!blank(p.effectiveDate) || usable) found = found.filter(root => effectiveAt(root, policies[root.workEffortId], at))
    if (target) found = found.filter(root => !applicabilityRefusal(policies[root.workEffortId], target))
    return pageOf(
        found.map(root => rowOf(root, policies[root.workEffortId])),
        p
    )
}
function pageOf(list, p) {
    const paged = lib.pageList(list, p, "procedureList")
    return paged
}
function effectiveAt(root, policy, at) {
    return (
        root.statusId === "WeApproved" &&
        policy.effectiveFromDate != null &&
        ms(policy.effectiveFromDate) <= at &&
        (policy.effectiveThruDate == null || ms(policy.effectiveThruDate) > at)
    )
}
function rowOf(root, policy) {
    const stepRows = rows(WORK, {rootWorkEffortId: root.workEffortId})
    const stepPolicies = stepRows.length
        ? Array.from(
              find(STEP)
                  .condition(
                      "workEffortId",
                      "in",
                      stepRows.map(row => row.workEffortId)
                  )
                  .list()
          ).filter(row => openAt(row, nowMs()))
        : []
    const requested = pendingRequests(root.workEffortId).length > 0
    return {
        workEffortId: root.workEffortId,
        workEffortName: root.workEffortName || root.workEffortId,
        description: root.description || "",
        organizationPartyId: root.ownerPartyId,
        organizationName: organizationName(root.ownerPartyId),
        statusId: root.statusId,
        statusText: statusNames[root.statusId] || root.statusId,
        approvalText: requested
            ? "Waiting for approval"
            : root.statusId === "WeApproved"
              ? "Approved " + dateText(policy.approvedDate)
              : "",
        effectiveFromDate: policy.effectiveFromDate,
        effectiveText: effectiveText(policy),
        applicabilityText: applicabilityText(policy),
        maintenanceTypeText: enumText(policy.maintenanceTypeEnumId),
        stepCount: stepPolicies.length,
        requiredCount: stepPolicies.filter(row => row.isRequired !== "N").length,
        estimatedWorkTime: number(root.estimatedWorkTime)
    }
}
function effectiveText(policy) {
    if (!policy.effectiveFromDate) return ""
    return (
        "From " +
        dateText(policy.effectiveFromDate) +
        (policy.effectiveThruDate ? " to " + dateText(policy.effectiveThruDate) : "")
    )
}
function applicabilityText(policy) {
    const parts = []
    if (policy.applicableProductId)
        parts.push(
            one("mantle.product.Product", {productId: policy.applicableProductId})?.productName || policy.applicableProductId
        )
    if (policy.applicableAssetClassEnumId) parts.push(enumText(policy.applicableAssetClassEnumId))
    if (policy.applicableFacilityTypeEnumId) parts.push(enumText(policy.applicableFacilityTypeEnumId))
    return parts.length ? parts.join(", ") : "Any equipment or facility"
}

// ===== applicability =====
// The target of new work (equipment or a facility the caller's scope holds), as applicability reads it.
function targetOf(userScope, p) {
    if (text(p.assetId)) {
        maintenanceAccess.requireAsset(userScope, text(p.assetId))
        const asset = one("mantle.product.asset.Asset", {assetId: text(p.assetId)})
        return {assetId: asset.assetId, productId: asset.productId || null, classEnumId: asset.classEnumId || null}
    }
    if (text(p.facilityId)) {
        maintenanceAccess.requireFacility(userScope, text(p.facilityId))
        const facility = one("mantle.facility.Facility", {facilityId: text(p.facilityId)})
        return {facilityId: facility.facilityId, facilityTypeEnumId: facility.facilityTypeEnumId || null}
    }
    return null
}
// Why a procedure does not apply to a target, or null: a model or class names equipment of that model or class; a facility type
// names facility work of that type.
function applicabilityRefusal(policy, target) {
    if (!target) return null
    if (target.assetId) {
        if (policy.applicableFacilityTypeEnumId && !policy.applicableProductId && !policy.applicableAssetClassEnumId)
            return "It is for facility work"
        if (policy.applicableProductId && policy.applicableProductId !== target.productId)
            return "It is for another equipment model"
        if (policy.applicableAssetClassEnumId && policy.applicableAssetClassEnumId !== target.classEnumId)
            return "It is for another class of equipment"
        return null
    }
    if (target.productId !== undefined && !target.facilityId) {
        // an equipment model's default (Product360)
        if (policy.applicableProductId && policy.applicableProductId !== target.productId)
            return "It is for another equipment model"
        if (policy.applicableFacilityTypeEnumId && !policy.applicableProductId && !policy.applicableAssetClassEnumId)
            return "It is for facility work"
        return null
    }
    if (policy.applicableProductId || policy.applicableAssetClassEnumId) return "It is for equipment"
    if (policy.applicableFacilityTypeEnumId && policy.applicableFacilityTypeEnumId !== target.facilityTypeEnumId)
        return "It is for another type of facility"
    return null
}
// check#ProcessApplicability: whether a procedure may be named for an equipment model (Product360's maintenance default, an owner
// contract with Products) or a target: a maintenance procedure, not retired, whose applicability admits it. A data check; the
// caller checks its own permission.
function checkApplicability(p) {
    const found = procedureOf(text(p.templateWorkEffortId))
    if (!found) return {applicable: false, reasonCode: "PROCESS_UNAVAILABLE", message: "Not a maintenance procedure"}
    if (found.root.statusId === "WeClosed")
        return {applicable: false, reasonCode: "PROCESS_RETIRED", message: "The procedure is retired"}
    const target = text(p.assetId)
        ? (asset =>
              asset
                  ? {assetId: asset.assetId, productId: asset.productId || null, classEnumId: asset.classEnumId || null}
                  : null)(one("mantle.product.asset.Asset", {assetId: text(p.assetId)}))
        : text(p.facilityId)
          ? {
                facilityId: text(p.facilityId),
                facilityTypeEnumId: one("mantle.facility.Facility", {facilityId: text(p.facilityId)})?.facilityTypeEnumId || null
            }
          : text(p.productId)
            ? {productId: text(p.productId)}
            : null
    const refused = applicabilityRefusal(found.policy, target)
    return refused
        ? {applicable: false, reasonCode: "PROCESS_NOT_APPLICABLE", message: refused}
        : {applicable: true, reasonCode: null, message: ""}
}

// ===== get#WorkProcess =====
function getProcess(p) {
    const userScope = scopeWithAny(["processView", "workRead"])
    const found = requireProcedure(userScope, p.workEffortId, "read")
    const {root, policy} = found
    const caps = userScope.capabilities
    const tree = nodesOf(root)
    const ordered = orderedNodes(tree, root)
    const nodeIds = ordered.map(node => node.workEffortId)
    const stepPolicies = Object.fromEntries(nodeIds.map(id => [id, workProcesses.stepPolicyOf(id)]))
    const edges = dependenciesOf(nodeIds)
    const names = Object.fromEntries(ordered.map(node => [node.workEffortId, node.workEffortName || node.workEffortId]))
    const requirements = requirementsOf(nodeIds)
    const instructions = currentInstructions(nodeIds)
    const editable = !found.readOnly && !!caps.processEdit && root.statusId !== "WeClosed"
    const steps = ordered
        .filter(node => node.workEffortId !== root.workEffortId)
        .map(node => {
            const policyRow = stepPolicies[node.workEffortId] || {}
            const siblings = tree.children[node.parentWorkEffortId] || []
            return {
                workEffortId: node.workEffortId,
                parentWorkEffortId: node.parentWorkEffortId === root.workEffortId ? null : node.parentWorkEffortId,
                workEffortName: node.workEffortName || node.workEffortId,
                description: node.description || "",
                depth: tree.depth[node.workEffortId],
                indentedName:
                    "   ".repeat(Math.max(0, tree.depth[node.workEffortId] - 1)) + (node.workEffortName || node.workEffortId),
                sequenceNum: number(node.sequenceNum),
                isGroup: !!(tree.children[node.workEffortId] || []).length,
                estimatedWorkTime: number(node.estimatedWorkTime),
                isRequired: policyRow.isRequired !== "N",
                requiredText: policyRow.isRequired === "N" ? "Optional" : "Required",
                roleTypeId: policyRow.roleTypeId || null,
                responseKindEnumId: policyRow.responseKindEnumId || null,
                responseText: responseText(policyRow),
                measurementTypeId: policyRow.measurementTypeId || null,
                measurementUomId: policyRow.measurementUomId || null,
                minimumValue: number(policyRow.minimumValue),
                maximumValue: number(policyRow.maximumValue),
                evidenceRequired: policyRow.evidenceRequired === "Y",
                commentRequired: policyRow.commentRequired === "Y",
                waiverAllowed: policyRow.waiverAllowed === "Y",
                dependsOnIds: edges.filter(edge => edge.workEffortId === node.workEffortId).map(edge => edge.toWorkEffortId),
                dependsOnText: edges
                    .filter(edge => edge.workEffortId === node.workEffortId)
                    .map(edge => names[edge.toWorkEffortId] || edge.toWorkEffortId)
                    .join(", "),
                requirementText: requirements
                    .filter(row => row.workEffortId === node.workEffortId)
                    .map(row => row.label)
                    .join("; "),
                instructionText: instructions[node.workEffortId]?.summary || "",
                canMoveUp: editable && siblings.indexOf(node.workEffortId) > 0,
                canMoveDown:
                    editable &&
                    siblings.indexOf(node.workEffortId) >= 0 &&
                    siblings.indexOf(node.workEffortId) < siblings.length - 1
            }
        })
    const approvals = rows(APPROVAL, {workEffortId: root.workEffortId}).sort((a, b) => ms(b.requestedDate) - ms(a.requestedDate))
    const userNames = userNamesOf(
        approvals
            .flatMap(row => [row.requestedByUserId, row.decidedByUserId])
            .concat([policy.approvedByUserId, policy.lastAuthorUserId])
    )
    const pending = approvals.find(row => row.statusId === "WeaRequested") || null
    const selfApproval = selfApprovalAllowed(root.ownerPartyId)
    const lastAuthor = policy.lastAuthorUserId === ec.user.userId
    const findings = found.assignedRead ? [] : findingsOf(root)
    return {
        procedure: {
            workEffortId: root.workEffortId,
            workEffortName: root.workEffortName || root.workEffortId,
            description: root.description || "",
            organizationPartyId: root.ownerPartyId,
            organizationName: organizationName(root.ownerPartyId),
            statusId: root.statusId,
            statusText: statusNames[root.statusId] || root.statusId,
            estimatedWorkTime: number(root.estimatedWorkTime),
            maintenanceTypeEnumId: policy.maintenanceTypeEnumId || null,
            maintenanceTypeText: enumText(policy.maintenanceTypeEnumId),
            applicableProductId: policy.applicableProductId || null,
            applicableAssetClassEnumId: policy.applicableAssetClassEnumId || null,
            applicableFacilityTypeEnumId: policy.applicableFacilityTypeEnumId || null,
            applicabilityText: applicabilityText(policy),
            effectiveFromDate: policy.effectiveFromDate,
            effectiveThruDate: policy.effectiveThruDate,
            effectiveText: effectiveText(policy),
            approvedText: policy.approvedDate
                ? "Approved " +
                  dateText(policy.approvedDate) +
                  " by " +
                  (userNames[policy.approvedByUserId] || policy.approvedByUserId || "")
                : "",
            lastAuthorText: policy.lastAuthorUserId
                ? "Last changed " +
                  dateText(policy.lastAuthoredDate) +
                  " by " +
                  (userNames[policy.lastAuthorUserId] || policy.lastAuthorUserId)
                : "",
            sourceWorkEffortId: policy.sourceWorkEffortId || null,
            publishedContentId: policy.publishedContentId || null,
            pendingApprovalId: pending?.workEffortApprovalId || null,
            readOnly: !!found.readOnly,
            assignedRead: !!found.assignedRead
        },
        stepList: steps,
        requirementList: requirements,
        instructionList: nodeIds
            .filter(id => instructions[id])
            .map(id => Object.assign({workEffortId: id, nodeName: names[id]}, instructions[id])),
        approvalList: approvals.map(row => ({
            workEffortApprovalId: row.workEffortApprovalId,
            statusId: row.statusId,
            statusText: enumStatus(row.statusId),
            requestedText:
                dateText(row.requestedDate) + " by " + (userNames[row.requestedByUserId] || row.requestedByUserId || ""),
            decidedText: row.decidedDate
                ? dateText(row.decidedDate) + " by " + (userNames[row.decidedByUserId] || row.decidedByUserId || "")
                : "",
            comments: [row.requestComments, row.decisionComments].filter(Boolean).join(" · ")
        })),
        findingList: findings,
        canEdit: editable,
        canRequest:
            !found.assignedRead && (caps.processEdit || caps.processApprove) && root.statusId === "WeInPlanning" && !pending,
        canApprove:
            !found.assignedRead &&
            !!caps.processApprove &&
            root.statusId === "WeInPlanning" &&
            !!pending &&
            (selfApproval || !lastAuthor) &&
            !findings.length,
        approveWhyNot:
            !caps.processApprove || found.assignedRead
                ? "An approver approves a procedure"
                : root.statusId !== "WeInPlanning"
                  ? "Only a draft is approved"
                  : !pending
                    ? "Approval has not been requested"
                    : !selfApproval && lastAuthor
                      ? "You changed it last; another approver approves it"
                      : findings.length
                        ? "Resolve the findings first"
                        : "",
        canRetire: !found.assignedRead && !!caps.processApprove && root.statusId !== "WeClosed",
        canUse: (caps.plan || caps.supervise) && effectiveAt(root, policy, nowMs())
    }
}
const statusTexts = {WeaRequested: "Requested", WeaApproved: "Approved", WeaRefused: "Refused", WeaCancelled: "Cancelled"}
const enumStatus = statusId => statusTexts[statusId] || statusId
function responseText(policy) {
    if (!policy?.responseKindEnumId) return ""
    let out = enumText(policy.responseKindEnumId)
    if (policy.responseKindEnumId === "WsrReading") {
        const type = policy.measurementTypeId
            ? one("mantle.work.measurement.MeasurementType", {measurementTypeId: policy.measurementTypeId})
            : null
        const uom = policy.measurementUomId ? one("moqui.basic.Uom", {uomId: policy.measurementUomId}) : null
        out += ": " + (type?.description || policy.measurementTypeId || "?")
        if (policy.minimumValue != null || policy.maximumValue != null)
            out +=
                " " +
                (policy.minimumValue != null ? number(policy.minimumValue) : "") +
                "–" +
                (policy.maximumValue != null ? number(policy.maximumValue) : "")
        if (uom) out += " " + (uom.abbreviation || uom.uomId)
    }
    const needs = []
    if (policy.evidenceRequired === "Y") needs.push("evidence")
    if (policy.commentRequired === "Y") needs.push("a comment")
    if (needs.length) out += "; needs " + needs.join(" and ")
    if (policy.waiverAllowed === "Y") out += "; may be waived"
    return out
}
function userNamesOf(userIds) {
    const ids = unique(userIds)
    if (!ids.length) return {}
    const accounts = Array.from(find("moqui.security.UserAccount").condition("userId", "in", ids).list())
    const parties = lib.partyNames(accounts.map(row => row.partyId))
    return Object.fromEntries(
        accounts.map(row => [row.userId, parties[row.partyId] || row.userFullName || row.username || row.userId])
    )
}

// ===== requirements =====
function requirementsOf(nodeIds) {
    if (!nodeIds.length) return []
    const at = nowMs()
    const out = []
    for (const row of Array.from(find(PRODUCT).condition("workEffortId", "in", nodeIds).list()).filter(row => openAt(row, at))) {
        const product = one("mantle.product.Product", {productId: row.productId})
        out.push({
            workEffortId: row.workEffortId,
            kind: "product",
            key: row.productId,
            name: product?.productName || row.productId,
            quantity: number(row.estimatedQuantity),
            label: (number(row.estimatedQuantity) ?? 1) + " × " + (product?.productName || row.productId)
        })
    }
    for (const row of Array.from(find(ASSET_NEEDED).condition("workEffortId", "in", nodeIds).list())) {
        const product = one("mantle.product.Product", {productId: row.assetProductId})
        out.push({
            workEffortId: row.workEffortId,
            kind: "asset",
            key: row.assetProductId,
            name: product?.productName || row.assetProductId,
            quantity: number(row.estimatedQuantity),
            duration: number(row.estimatedDuration),
            label: "Equipment: " + (product?.productName || row.assetProductId)
        })
    }
    for (const row of Array.from(find(SKILL).condition("workEffortId", "in", nodeIds).list()))
        out.push({
            workEffortId: row.workEffortId,
            kind: "skill",
            key: row.skillTypeEnumId,
            name: enumText(row.skillTypeEnumId),
            quantity: number(row.estimatedNumPeople),
            duration: number(row.estimatedDuration),
            label:
                "Skill: " +
                enumText(row.skillTypeEnumId) +
                (number(row.estimatedNumPeople) ? " × " + number(row.estimatedNumPeople) : "")
        })
    return out
}
// store#ProcessRequirements: one planned requirement of a node of the procedure, new, changed or removed (remove): a part
// (WorkEffortProduct, dated: a change ends the row and starts the next), equipment needed (WorkEffortAssetNeeded) or a skill
// (WorkEffortSkillStandard; minimumSkillLevel joins with People's P18, impl-maintenance F75).
function storeRequirements(p) {
    const userScope = scopeWithAny(["processEdit"])
    const found = requireProcedure(userScope, p.rootWorkEffortId, "edit")
    const nodeId = text(p.workEffortId) || found.root.workEffortId
    if (!treeIdSet(found.root).has(nodeId)) denied("RECORD_UNAVAILABLE", "Step " + nodeId + " is not a step of this procedure")
    const kind = text(p.kind)
    const remove = flag(p.remove)
    const quantity = blank(p.estimatedQuantity) ? null : Number(String(p.estimatedQuantity))
    if (quantity != null && !(quantity > 0)) denied("VALUE_INVALID", "A quantity is more than zero")
    touch(found)
    const now = ec.user.nowTimestamp
    if (kind === "product") {
        const productId = text(p.productId)
        if (!productId || !one("mantle.product.Product", {productId})) denied("VALUE_INVALID", "Choose the part")
        for (const row of Array.from(find(PRODUCT, {workEffortId: nodeId, productId}).list()).filter(row => openAt(row, ms(now))))
            call("update#" + PRODUCT, {workEffortId: nodeId, productId, fromDate: row.fromDate, thruDate: now})
        if (!remove)
            call("create#" + PRODUCT, {
                workEffortId: nodeId,
                productId,
                fromDate: now,
                typeEnumId: "WeptConsume",
                estimatedQuantity: quantity ?? 1
            })
        return {workEffortId: nodeId}
    }
    if (kind === "asset") {
        const assetProductId = text(p.assetProductId || p.productId)
        if (!assetProductId || !one("mantle.product.Product", {productId: assetProductId}))
            denied("VALUE_INVALID", "Choose the equipment needed")
        const existing = one(ASSET_NEEDED, {workEffortId: nodeId, assetProductId})
        if (remove) {
            if (existing) call("delete#" + ASSET_NEEDED, {workEffortId: nodeId, assetProductId})
        } else
            call((existing ? "update#" : "create#") + ASSET_NEEDED, {
                workEffortId: nodeId,
                assetProductId,
                estimatedQuantity: quantity ?? 1,
                estimatedDuration: blank(p.estimatedDuration) ? null : p.estimatedDuration
            })
        return {workEffortId: nodeId}
    }
    if (kind === "skill") {
        const skillTypeEnumId = text(p.skillTypeEnumId)
        if (!skillTypeEnumId || !one("moqui.basic.Enumeration", {enumId: skillTypeEnumId, enumTypeId: "SkillType"}))
            denied("VALUE_INVALID", "Choose the skill")
        const existing = one(SKILL, {workEffortId: nodeId, skillTypeEnumId})
        if (remove) {
            if (existing) call("delete#" + SKILL, {workEffortId: nodeId, skillTypeEnumId})
        } else
            call((existing ? "update#" : "create#") + SKILL, {
                workEffortId: nodeId,
                skillTypeEnumId,
                estimatedNumPeople: blank(p.estimatedNumPeople) ? 1 : p.estimatedNumPeople,
                estimatedDuration: blank(p.estimatedDuration) ? null : p.estimatedDuration
            })
        return {workEffortId: nodeId}
    }
    denied("VALUE_INVALID", "A requirement is a part, equipment or a skill")
}
// The requirements of each template node copied to its new node (F58: People's instantiate copies none).
function copyRequirements(idMap) {
    const at = nowMs()
    const now = ec.user.nowTimestamp
    const templateIds = Object.keys(idMap)
    if (!templateIds.length) return
    for (const row of Array.from(find(PRODUCT).condition("workEffortId", "in", templateIds).list()).filter(row =>
        openAt(row, at)
    ))
        call("create#" + PRODUCT, {
            workEffortId: idMap[row.workEffortId],
            productId: row.productId,
            fromDate: now,
            typeEnumId: row.typeEnumId || "WeptConsume",
            estimatedQuantity: row.estimatedQuantity
        })
    for (const row of Array.from(find(ASSET_NEEDED).condition("workEffortId", "in", templateIds).list()))
        call("create#" + ASSET_NEEDED, {
            workEffortId: idMap[row.workEffortId],
            assetProductId: row.assetProductId,
            estimatedQuantity: row.estimatedQuantity,
            estimatedDuration: row.estimatedDuration
        })
    for (const row of Array.from(find(SKILL).condition("workEffortId", "in", templateIds).list()))
        call("create#" + SKILL, {
            workEffortId: idMap[row.workEffortId],
            skillTypeEnumId: row.skillTypeEnumId,
            estimatedNumPeople: row.estimatedNumPeople,
            estimatedDuration: row.estimatedDuration
        })
}

// ===== store#WorkProcess =====
const applicabilityFields = [
    "maintenanceTypeEnumId",
    "applicableProductId",
    "applicableAssetClassEnumId",
    "applicableFacilityTypeEnumId"
]
function checkApplicabilityFields(p) {
    if (
        !blank(p.maintenanceTypeEnumId) &&
        !one("moqui.basic.Enumeration", {enumId: text(p.maintenanceTypeEnumId), enumTypeId: "MaintenanceType"})
    )
        denied("VALUE_INVALID", "Maintenance type " + p.maintenanceTypeEnumId + " is not known")
    if (!blank(p.applicableProductId)) {
        const product = one("mantle.product.Product", {productId: text(p.applicableProductId)})
        if (!product || product.assetTypeEnumId !== "AstTpEquipment") denied("VALUE_INVALID", "Choose an equipment model")
    }
    if (
        !blank(p.applicableFacilityTypeEnumId) &&
        !one("moqui.basic.Enumeration", {enumId: text(p.applicableFacilityTypeEnumId), enumTypeId: "FacilityType"})
    )
        denied("VALUE_INVALID", "Facility type " + p.applicableFacilityTypeEnumId + " is not known")
}
// A new procedure (a draft of its organization, optionally cloned from sourceWorkEffortId: new ids, no approval copied) or a
// change of one's name, description, estimate and applicability.
function storeProcess(p) {
    const userScope = scopeWithAny(["processEdit"])
    checkApplicabilityFields(p)
    const id = text(p.workEffortId)
    if (id) {
        const found = requireProcedure(userScope, id, "edit")
        touch(found)
        const fields = {workEffortId: id}
        // a field given changes (an empty one clears it); one not given stays
        for (const field of ["workEffortName", "description", "estimatedWorkTime"])
            if (p[field] != null) fields[field] = blank(p[field]) ? null : p[field]
        if (fields.workEffortName === null) denied("NAME_REQUIRED", "Name the procedure")
        if (Object.keys(fields).length > 1) call("update#" + WORK, fields)
        const policyFields = {workEffortId: found.policy.workEffortId, fromDate: found.policy.fromDate}
        for (const field of applicabilityFields) if (p[field] != null) policyFields[field] = text(p[field])
        if (Object.keys(policyFields).length > 2) call("update#" + PROCESS, policyFields)
        return {workEffortId: id, statusId: one(WORK, {workEffortId: id}).statusId}
    }
    const name = text(p.workEffortName)
    if (!name) denied("NAME_REQUIRED", "Name the procedure")
    const organizationPartyId =
        text(p.organizationPartyId) || (userScope.organizationPartyIds?.length === 1 ? userScope.organizationPartyIds[0] : null)
    if (!organizationPartyId) denied("ORGANIZATION_REQUIRED", "Choose an organization")
    maintenanceAccess.requireOrganization(userScope, organizationPartyId)
    const source = text(p.sourceWorkEffortId) ? requireProcedure(userScope, p.sourceWorkEffortId, "read") : null
    const now = ec.user.nowTimestamp
    const rootId = call("create#" + WORK, {
        workEffortTypeEnumId: "WetTask",
        purposeEnumId: "WepMaintenance",
        isTemplate: "Y",
        statusId: "WeInPlanning",
        statusFlowId: FLOW,
        ownerPartyId: organizationPartyId,
        workEffortName: name,
        description: text(p.description) ?? source?.root.description ?? null,
        estimatedWorkTime: blank(p.estimatedWorkTime) ? (source?.root.estimatedWorkTime ?? null) : p.estimatedWorkTime,
        timeUomId: "TF_hr"
    }).workEffortId
    const policy = {
        workEffortId: rootId,
        fromDate: now,
        processPolicyEnumId: PROCEDURE,
        guardsExecution: "Y",
        lastAuthorUserId: ec.user.userId,
        lastAuthoredDate: now,
        sourceWorkEffortId: source?.root.workEffortId || null
    }
    for (const field of applicabilityFields) policy[field] = text(p[field]) ?? source?.policy[field] ?? null
    call("create#" + PROCESS, policy)
    if (source) cloneDefinition(source.root, rootId, organizationPartyId)
    return {workEffortId: rootId, statusId: "WeInPlanning"}
}
// A source procedure's tree in effect copied into a new draft: the nodes' definition fields, step policies, dependencies,
// requirements and each node's instruction text (its draft, else its published one) as a draft. Nothing of an execution or an
// approval is copied.
function cloneDefinition(sourceRoot, rootId, organizationPartyId) {
    const tree = nodesOf(sourceRoot)
    const idMap = {[sourceRoot.workEffortId]: rootId}
    const now = ec.user.nowTimestamp
    for (const node of orderedNodes(tree, sourceRoot)) {
        if (node.workEffortId === sourceRoot.workEffortId) continue
        idMap[node.workEffortId] = call("create#" + WORK, {
            workEffortTypeEnumId: "WetTask",
            purposeEnumId: "WepMaintenance",
            parentWorkEffortId: idMap[node.parentWorkEffortId],
            rootWorkEffortId: rootId,
            ownerPartyId: organizationPartyId,
            isTemplate: "Y",
            statusId: "WeInPlanning",
            workEffortName: node.workEffortName,
            description: node.description,
            sequenceNum: node.sequenceNum,
            estimatedWorkTime: node.estimatedWorkTime,
            timeUomId: node.timeUomId
        }).workEffortId
        const policy = workProcesses.stepPolicyOf(node.workEffortId)
        if (policy) {
            const copied = {
                workEffortId: idMap[node.workEffortId],
                fromDate: now,
                isRequired: policy.isRequired,
                roleTypeId: policy.roleTypeId,
                dueOffsetDays: policy.dueOffsetDays
            }
            for (const field of workProcesses.stepFields) if (policy[field] != null) copied[field] = policy[field]
            call("create#" + STEP, copied)
        }
    }
    for (const edge of dependenciesOf(Object.keys(idMap)))
        if (idMap[edge.toWorkEffortId])
            call("create#" + ASSOC, {
                workEffortId: idMap[edge.workEffortId],
                toWorkEffortId: idMap[edge.toWorkEffortId],
                workEffortAssocTypeEnumId: "WeatDependsOn",
                fromDate: now
            })
    copyRequirements(idMap)
    const instructions = currentInstructions(Object.keys(idMap))
    for (const [sourceId, row] of Object.entries(instructions))
        if (row.text != null) writeDraft(idMap[sourceId], row.text, row.description)
}

// ===== store#ProcessStep (the checked path) =====
const stepParameters = [
    "workEffortId",
    "parentWorkEffortId",
    "workEffortName",
    "description",
    "sequenceNum",
    "estimatedWorkTime",
    "isRequired",
    "roleTypeId",
    "dueOffsetDays",
    "dependsOnIds",
    "end"
]
function storeProcessStep(p) {
    const userScope = scopeWithAny(["processEdit"])
    const found = requireProcedure(userScope, p.rootWorkEffortId, "edit")
    checkResponse(p)
    if (!blank(p.workEffortId) && !treeIdSet(found.root).has(text(p.workEffortId)))
        denied("RECORD_UNAVAILABLE", "Step " + p.workEffortId + " is not a step of this procedure")
    touch(found)
    // the fields given (an absent one keeps the step's value; an empty one clears it)
    const parameters = {rootWorkEffortId: found.root.workEffortId, purposeEnumId: "WepMaintenance"}
    for (const field of stepParameters.concat(workProcesses.stepFields)) if (p[field] != null) parameters[field] = p[field]
    if (blank(p.workEffortId) && blank(p.sequenceNum)) {
        const parentId = text(p.parentWorkEffortId) || found.root.workEffortId
        const siblings = rows(WORK, {parentWorkEffortId: parentId})
        parameters.sequenceNum = (Math.max(0, ...siblings.map(row => number(row.sequenceNum) ?? 0)) || 0) + 10
    }
    const out = workProcesses.storeStep(parameters)
    if (blank(p.workEffortId))
        call("update#" + WORK, {workEffortId: out.workEffortId, ownerPartyId: found.root.ownerPartyId, timeUomId: "TF_hr"})
    return out
}
// move#ProcessStep: a step one place up or down among its siblings (the order is sequenceNum, renumbered by tens).
function moveStep(p) {
    const userScope = scopeWithAny(["processEdit"])
    const found = requireProcedure(userScope, p.rootWorkEffortId, "edit")
    const id = text(p.workEffortId)
    if (!id || !treeIdSet(found.root).has(id) || id === found.root.workEffortId)
        denied("RECORD_UNAVAILABLE", "Step " + id + " is not a step of this procedure")
    const direction = text(p.direction)
    if (!["up", "down"].includes(direction)) denied("VALUE_INVALID", "Move a step up or down")
    const step = one(WORK, {workEffortId: id})
    const siblings = Array.from(
        find(WORK, {parentWorkEffortId: step.parentWorkEffortId}).orderBy(["sequenceNum", "workEffortId"]).list()
    ).filter(row => row.rootWorkEffortId === found.root.workEffortId && openStep(row.workEffortId))
    const at = siblings.findIndex(row => row.workEffortId === id)
    const to = direction === "up" ? at - 1 : at + 1
    if (at < 0 || to < 0 || to >= siblings.length) return {workEffortId: id, moved: false}
    touch(found)
    const order = siblings.map(row => row.workEffortId)
    order.splice(at, 1)
    order.splice(to, 0, id)
    order.forEach((siblingId, index) => {
        const row = siblings.find(sibling => sibling.workEffortId === siblingId)
        if (number(row.sequenceNum) !== (index + 1) * 10)
            call("update#" + WORK, {workEffortId: siblingId, sequenceNum: (index + 1) * 10})
    })
    return {workEffortId: id, moved: true}
}
const openStep = id => {
    const policies = rows(STEP, {workEffortId: id})
    return !policies.length || policies.some(row => openAt(row, nowMs()))
}
// store#ProcessDependency: the steps of the same procedure a step waits for (People's storeStep: another tree's step and a cycle
// are refused, DEPENDENCY_INVALID).
function storeDependency(p) {
    const userScope = scopeWithAny(["processEdit"])
    const found = requireProcedure(userScope, p.rootWorkEffortId, "edit")
    const id = text(p.workEffortId)
    if (!id || !treeIdSet(found.root).has(id) || id === found.root.workEffortId)
        denied("RECORD_UNAVAILABLE", "Step " + id + " is not a step of this procedure")
    const wanted = Array.from(p.dependsOnIds || [])
        .map(text)
        .filter(Boolean)
    touch(found)
    workProcesses.storeStep({rootWorkEffortId: found.root.workEffortId, workEffortId: id, dependsOnIds: wanted})
    return {workEffortId: id}
}

// ===== instructions =====
// The newest open draft of a node, its instruction in effect at a time, and the text of a location.
function draftOf(workEffortId) {
    return (
        rows(CONTENT, {workEffortId, contentTypeEnumId: DRAFT})
            .filter(row => !row.thruDate)
            .sort((a, b) => ms(b.contentDate) - ms(a.contentDate))[0] || null
    )
}
function instructionAt(workEffortId, at) {
    return (
        rows(CONTENT, {workEffortId, contentTypeEnumId: INSTRUCTION})
            .filter(row => openAt(row, at))
            .sort((a, b) => ms(b.fromDate) - ms(a.fromDate))[0] || null
    )
}
function textOf(location) {
    try {
        const ref = ec.resource.getLocationReference(location)
        return ref.getExists() ? String(ref.getText() ?? "") : null
    } catch (error) {
        return null
    }
}
const summaryOf = value => (value == null ? "" : String(value).replace(/\s+/g, " ").trim().slice(0, 120))
// Each node's current instruction: its open draft (a draft procedure's), else its published one in effect.
function currentInstructions(nodeIds) {
    const out = {}
    const at = nowMs()
    for (const id of nodeIds) {
        const draft = draftOf(id)
        const published = instructionAt(id, at)
        const row = draft || published
        if (!row) continue
        const body = textOf(row.contentLocation)
        out[id] = {
            workEffortContentId: row.workEffortContentId,
            description: row.description || "",
            text: body,
            summary: summaryOf(body ?? row.description),
            stateText: draft
                ? published && draft.contentChecksum === published.contentChecksum
                    ? "Published"
                    : "Draft"
                : "Published",
            publishedFromText: published ? dateText(published.fromDate) : ""
        }
    }
    return out
}
function writeDraft(workEffortId, body, description) {
    const contentId = ec.entity.sequencedIdPrimary(CONTENT, null, null)
    const location = "dbresource://mantle/content/workEffort/" + workEffortId + "/draft_" + contentId + "/instruction.md"
    ec.resource.getLocationReference(location).putText(String(body))
    const checksum = ec.resource.digest(location, "sha256")
    for (const row of rows(CONTENT, {workEffortId, contentTypeEnumId: DRAFT}).filter(row => !row.thruDate))
        call("update#" + CONTENT, {workEffortContentId: row.workEffortContentId, thruDate: ec.user.nowTimestamp})
    call("create#" + CONTENT, {
        workEffortContentId: contentId,
        workEffortId,
        contentTypeEnumId: DRAFT,
        contentLocation: location,
        contentChecksum: checksum,
        description: text(description) || "Instruction",
        contentDate: ec.user.nowTimestamp,
        userId: ec.user.userId
    })
    return contentId
}
// store#ProcessInstruction: a node's draft instruction text (a new draft ends the one before); with end, the node has none from
// the next approval. Published instructions change only at approval.
function storeInstruction(p) {
    const userScope = scopeWithAny(["processEdit"])
    const found = requireProcedure(userScope, p.rootWorkEffortId, "edit")
    const nodeId = text(p.workEffortId) || found.root.workEffortId
    if (!treeIdSet(found.root).has(nodeId)) denied("RECORD_UNAVAILABLE", "Step " + nodeId + " is not a step of this procedure")
    touch(found)
    if (flag(p.end)) {
        for (const row of rows(CONTENT, {workEffortId: nodeId, contentTypeEnumId: DRAFT}).filter(row => !row.thruDate))
            call("update#" + CONTENT, {workEffortContentId: row.workEffortContentId, thruDate: ec.user.nowTimestamp})
        // an empty draft marks the instruction removed at the next approval
        const contentId = writeDraft(nodeId, "", "No instruction")
        return {workEffortContentId: contentId}
    }
    if (blank(p.contentText)) denied("TEXT_REQUIRED", "Enter the instruction")
    return {workEffortContentId: writeDraft(nodeId, p.contentText, p.description)}
}
// Publication (F68): each node's draft that differs from its instruction in effect is stored once as a WectInstruction row in the
// shape of Manufacturing's rule (the file under dbresource://mantle/content/workEffort/, its sha256, the from date), and the one
// before is ended; an empty draft ends it. The drafts stay as the definition's working copy.
function publishInstructions(root, effectiveMs) {
    const effective = stamp(effectiveMs)
    let published = 0
    for (const node of nodesOf(root).nodes) {
        const draft = draftOf(node.workEffortId)
        if (!draft) continue
        const current = instructionAt(node.workEffortId, effectiveMs) || instructionAt(node.workEffortId, nowMs())
        if (current && current.contentChecksum === draft.contentChecksum) continue
        const body = textOf(draft.contentLocation) ?? ""
        if (current) call("update#" + CONTENT, {workEffortContentId: current.workEffortContentId, thruDate: effective})
        if (!body.trim()) continue
        const contentId = ec.entity.sequencedIdPrimary(CONTENT, null, null)
        const location =
            "dbresource://mantle/content/workEffort/" + node.workEffortId + "/instruction_" + contentId + "/instruction.md"
        ec.resource.getLocationReference(location).putText(body)
        call("create#" + CONTENT, {
            workEffortContentId: contentId,
            workEffortId: node.workEffortId,
            contentTypeEnumId: INSTRUCTION,
            contentLocation: location,
            contentChecksum: ec.resource.digest(location, "sha256"),
            description: draft.description || "Instruction",
            fromDate: effective,
            contentDate: ec.user.nowTimestamp,
            userId: ec.user.userId
        })
        published++
    }
    return published
}
// find#ProcessInstructions: a node's instructions. A template node's in effect now (and its draft for an author); an execution
// node's (a work order's step or root) through its WeatBasedOn link, the template node's instruction in effect when the
// execution was made (nothing copied; a later approval does not change it).
function findInstructions(p) {
    const userScope = scopeWithAny(["processView", "workRead"])
    const id = text(p.workEffortId)
    const node = id ? one(WORK, {workEffortId: id}) : null
    if (!node) unavailable(id)
    const rootId = node.rootWorkEffortId || node.workEffortId
    let templateId = id
    let at = nowMs()
    if (node.isTemplate === "Y") requireProcedure(userScope, rootId, "read")
    else {
        maintenanceAccess.requireWork(userScope, id)
        const link = rows(ASSOC, {workEffortId: id, workEffortAssocTypeEnumId: "WeatBasedOn"}).sort(
            (a, b) => ms(a.fromDate) - ms(b.fromDate)
        )[0]
        if (!link) return {instructionList: []}
        templateId = link.toWorkEffortId
        at = ms(link.fromDate)
    }
    const row = instructionAt(templateId, at)
    if (!row) return {instructionList: []}
    return {
        instructionList: [
            {
                workEffortContentId: row.workEffortContentId,
                templateWorkEffortId: templateId,
                description: row.description || "",
                text: textOf(row.contentLocation),
                contentChecksum: row.contentChecksum,
                fromDate: row.fromDate,
                fromText: dateText(row.fromDate)
            }
        ]
    }
}

// An execution node's instruction (impl-maintenance P7: the checklist's and the print's), with no scope check (the caller read the
// work): its template node's instruction in effect when the execution was made, through its WeatBasedOn link; null when none.
function executionInstruction(workEffortId) {
    const link = rows(ASSOC, {workEffortId, workEffortAssocTypeEnumId: "WeatBasedOn"}).sort(
        (a, b) => ms(a.fromDate) - ms(b.fromDate)
    )[0]
    const row = link ? instructionAt(link.toWorkEffortId, ms(link.fromDate)) : null
    return row ? {description: row.description || "", text: textOf(row.contentLocation), summary: summaryOf(textOf(row.contentLocation))} : null
}

// ===== approval =====
// The approvers of an organization's procedures: users holding WORK_PROCESS_APPROVE through an active group membership whose
// party is one of the organization's people now, but the procedure's last author unless self-approval is allowed.
function approverUserIds(found) {
    const groupIds = unique(
        Array.from(find("moqui.security.UserGroupPermission").condition("userPermissionId", "WORK_PROCESS_APPROVE").list())
            .filter(row => lib.active(row))
            .map(row => row.userGroupId)
    )
    if (!groupIds.length) return []
    const userIds = unique(
        Array.from(find("moqui.security.UserGroupMember").condition("userGroupId", "in", groupIds).list())
            .filter(row => lib.active(row))
            .map(row => row.userId)
    )
    if (!userIds.length) return []
    const accounts = Array.from(find("moqui.security.UserAccount").condition("userId", "in", userIds).list()).filter(
        row => row.partyId && row.disabled !== "Y" && (ms(row.terminateDate) ?? Infinity) > nowMs()
    )
    const members = new Set(
        accounts.length
            ? Array.from(
                  find("mantle.party.PartyRelationship")
                      .condition(
                          "fromPartyId",
                          "in",
                          accounts.map(row => row.partyId)
                      )
                      .condition("toPartyId", found.organizationPartyId)
                      .condition("relationshipTypeEnumId", "in", memberRelationships)
                      .conditionDate("fromDate", "thruDate", ec.user.nowTimestamp)
                      .list()
              ).map(row => row.fromPartyId)
            : []
    )
    const self = selfApprovalAllowed(found.organizationPartyId)
    return accounts
        .filter(row => members.has(row.partyId))
        .map(row => row.userId)
        .filter(userId => self || userId !== found.policy.lastAuthorUserId)
}
function clearNotices(workEffortId) {
    const messageIds = Array.from(
        find(MESSAGE)
            .condition({topic: TOPIC, recordEntityName: WORK, recordId: workEffortId})
            .selectField("notificationMessageId")
            .list()
    ).map(row => row.notificationMessageId)
    if (!messageIds.length) return
    for (const user of Array.from(
        find(MESSAGE_USER).condition("notificationMessageId", "in", messageIds).condition("viewedDate", "is-null", null).list()
    ))
        call("update#" + MESSAGE_USER, {
            notificationMessageId: user.notificationMessageId,
            userId: user.userId,
            viewedDate: ec.user.nowTimestamp
        })
}
function notifyApprovers(found, workEffortApprovalId) {
    try {
        const userIds = approverUserIds(found).filter(
            userId => userId !== ec.user.userId || selfApprovalAllowed(found.organizationPartyId)
        )
        if (!userIds.length) return 0
        ec.makeNotificationMessage()
            .topic(TOPIC)
            .reason("approval")
            .message({
                workEffortId: found.root.workEffortId,
                workEffortName: found.root.workEffortName || found.root.workEffortId,
                workEffortApprovalId,
                organizationName: organizationName(found.organizationPartyId)
            })
            .record(WORK, found.root.workEffortId)
            .actorUserId(ec.user.userId)
            .userIds(userIds)
            .send()
        return userIds.length
    } catch (error) {
        ec.logger.error("Procedure " + found.root.workEffortId + ": the approval notice was not sent: " + error.message)
        return 0
    }
}
// request#WorkProcessApproval: a draft with no finding is put to the organization's approvers (an author or an approver asks);
// a request already waiting is answered (repeated). PUBLICATION_INVALID names the findings.
function requestApproval(p) {
    const userScope = scopeWithAny(["processEdit", "processApprove"])
    const found = requireProcedure(userScope, p.workEffortId, userScope.capabilities.processEdit ? "edit" : "approve")
    if (found.root.statusId !== "WeInPlanning") denied("STATUS_INVALID", "Only a draft is put for approval")
    const waiting = pendingRequests(found.root.workEffortId)[0]
    if (waiting) return {workEffortApprovalId: waiting.workEffortApprovalId, repeated: true, notifiedCount: 0}
    const findings = findingsOf(found.root)
    if (findings.length) denied("PUBLICATION_INVALID", findings.map(row => row.message).join("; "))
    const workEffortApprovalId = call("create#" + APPROVAL, {
        workEffortId: found.root.workEffortId,
        statusId: "WeaRequested",
        requestedByUserId: ec.user.userId,
        requestedDate: ec.user.nowTimestamp,
        requestComments: text(p.comments)
    }).workEffortApprovalId
    return {workEffortApprovalId, repeated: false, notifiedCount: notifyApprovers(found, workEffortApprovalId)}
}
// The procedure a topic notice or a screen names (workEffortId, or the notice's recordId).
const noticeTarget = p => text(p.workEffortId) || (p.recordEntityName && p.recordEntityName !== WORK ? null : text(p.recordId))
// approve#WorkProcess: an approver of the organization (WORK_PROCESS_APPROVE), not the last author unless the organization allows
// self-approval (SELF_APPROVAL), approves the draft waiting for approval from effectiveDate (now or later): the decision on its
// WorkEffortApproval row, the procedure Approved and effective, its draft instructions published (F68) and the definition
// stored as a PDF. A notice of a procedure no longer waiting is refused (APPROVAL_NOT_REQUESTED).
function approveProcess(p) {
    const userScope = scopeWithAny(["processApprove"])
    const id = noticeTarget(p)
    if (!id) denied("SOURCE_INVALID", "The notice is not a procedure's")
    const found = requireProcedure(userScope, id, "approve")
    const {root, policy} = found
    if (root.statusId !== "WeInPlanning")
        denied("STATUS_INVALID", "Procedure " + id + " is " + (statusNames[root.statusId] || root.statusId))
    const request = pendingRequests(id)[0]
    if (!request) denied("APPROVAL_NOT_REQUESTED", "Approval of procedure " + id + " has not been requested")
    if (policy.lastAuthorUserId === ec.user.userId && !selfApprovalAllowed(found.organizationPartyId))
        denied("SELF_APPROVAL", "You changed procedure " + id + " last; another approver approves it")
    const findings = findingsOf(root)
    if (findings.length) denied("PUBLICATION_INVALID", findings.map(row => row.message).join("; "))
    const effectiveMs = blank(p.effectiveDate) ? nowMs() : ms(p.effectiveDate)
    if (effectiveMs < nowMs() - minuteMs) denied("DATE_PAST", "A procedure takes effect now or later")
    // Manufacturing's rule keeps a published instruction's start and an ended one's end (F68), so an approval cannot take effect
    // before an instruction an earlier approval published for later: that one would take over at its start (review R2)
    const latestStart = Math.max(
        -Infinity,
        ...Array.from(
            find(CONTENT)
                .condition("workEffortId", "in", Array.from(treeIdSet(root)))
                .condition("contentTypeEnumId", INSTRUCTION)
                .list()
        ).map(row => ms(row.fromDate) ?? -Infinity)
    )
    if (latestStart > effectiveMs)
        denied(
            "DATE_INVALID",
            "Procedure " +
                id +
                " has instructions in effect from " +
                dateText(stamp(latestStart)) +
                "; it takes effect then or later"
        )
    call("update#" + WORK, {workEffortId: id, statusId: "WeApproved"})
    call("update#" + APPROVAL, {
        workEffortApprovalId: request.workEffortApprovalId,
        statusId: "WeaApproved",
        decidedByUserId: ec.user.userId,
        decidedDate: ec.user.nowTimestamp,
        decisionComments: text(p.comments)
    })
    const published = publishInstructions(root, effectiveMs)
    call("update#" + PROCESS, {
        workEffortId: policy.workEffortId,
        fromDate: policy.fromDate,
        effectiveFromDate: stamp(effectiveMs),
        effectiveThruDate: null,
        approvedByUserId: ec.user.userId,
        approvedDate: ec.user.nowTimestamp
    })
    const contentId = storeDocument(procedureOf(id))
    if (contentId)
        call("update#" + PROCESS, {workEffortId: policy.workEffortId, fromDate: policy.fromDate, publishedContentId: contentId})
    clearNotices(id)
    return {
        workEffortId: id,
        statusId: "WeApproved",
        workEffortApprovalId: request.workEffortApprovalId,
        publishedCount: published,
        publishedContentId: contentId
    }
}
// refuse#WorkProcess: an approver refuses the request waiting, with the reason; the procedure stays a draft.
function refuseProcess(p) {
    const userScope = scopeWithAny(["processApprove"])
    const id = noticeTarget(p)
    if (!id) denied("SOURCE_INVALID", "The notice is not a procedure's")
    requireProcedure(userScope, id, "approve")
    const reason = text(p.reason) || text(p.comments)
    if (!reason) denied("REASON_REQUIRED", "Say why the procedure is refused")
    const request = pendingRequests(id)[0]
    if (!request) denied("APPROVAL_NOT_REQUESTED", "Approval of procedure " + id + " has not been requested")
    call("update#" + APPROVAL, {
        workEffortApprovalId: request.workEffortApprovalId,
        statusId: "WeaRefused",
        decidedByUserId: ec.user.userId,
        decidedDate: ec.user.nowTimestamp,
        decisionComments: reason
    })
    clearNotices(id)
    return {workEffortId: id, statusId: "WeInPlanning", workEffortApprovalId: request.workEffortApprovalId}
}
// retire#WorkProcess: an approver retires a procedure: no new work is made of it from now; its executions and history stay, and it
// stays searchable for provenance.
function retireProcess(p) {
    const userScope = scopeWithAny(["processApprove"])
    const found = requireProcedure(userScope, p.workEffortId, "approve")
    const {root, policy} = found
    if (root.statusId === "WeClosed") return {workEffortId: root.workEffortId, statusId: "WeClosed", repeated: true}
    for (const request of pendingRequests(root.workEffortId))
        call("update#" + APPROVAL, {
            workEffortApprovalId: request.workEffortApprovalId,
            statusId: "WeaCancelled",
            decidedByUserId: ec.user.userId,
            decidedDate: ec.user.nowTimestamp,
            decisionComments: "The procedure was retired"
        })
    clearNotices(root.workEffortId)
    call("update#" + WORK, {workEffortId: root.workEffortId, statusId: "WeClosed"})
    call("update#" + PROCESS, {
        workEffortId: policy.workEffortId,
        fromDate: policy.fromDate,
        effectiveThruDate: ec.user.nowTimestamp,
        comments: text(p.comments) ?? policy.comments
    })
    return {workEffortId: root.workEffortId, statusId: "WeClosed", repeated: false}
}

// The approved definition as a PDF (template/work/Procedure.print.html.fancy), stored as the root's WectPublishedProcedure
// content. A PDF that cannot be made is logged and the approval stands: the rows are the record.
function storeDocument(found) {
    const {root, policy} = found
    try {
        const tree = nodesOf(root)
        const ordered = orderedNodes(tree, root)
        const ids = ordered.map(node => node.workEffortId)
        const instructions = currentInstructions(ids)
        const requirements = requirementsOf(ids)
        const steps = ordered
            .filter(node => node.workEffortId !== root.workEffortId)
            .map(node => {
                const stepPolicy = workProcesses.stepPolicyOf(node.workEffortId) || {}
                return {
                    name: node.workEffortName || node.workEffortId,
                    indentMm: Math.max(0, tree.depth[node.workEffortId] - 1) * 5 + 2,
                    description: node.description || "",
                    required: stepPolicy.isRequired === "N" ? "Optional" : "Required",
                    response: responseText(stepPolicy),
                    instruction: instructions[node.workEffortId]?.text || "",
                    requirements: requirements
                        .filter(row => row.workEffortId === node.workEffortId)
                        .map(row => row.label)
                        .join("; ")
                }
            })
        const approved = procedureOf(root.workEffortId).policy
        const html = ec.resource.template("component://mr-mantle/template/work/Procedure.print.html.fancy", {
            workEffortId: root.workEffortId,
            workEffortName: root.workEffortName || root.workEffortId,
            description: root.description || "",
            organizationName: organizationName(root.ownerPartyId),
            effectiveText: effectiveText(approved),
            approvedText: dateText(approved.approvedDate),
            approvedBy: ec.user.userAccount?.userFullName || ec.user.username || "",
            applicabilityText: applicabilityText(approved),
            rootInstruction: instructions[root.workEffortId]?.text || "",
            steps
        })
        const sequence = rows(CONTENT, {workEffortId: root.workEffortId, contentTypeEnumId: PUBLISHED}).length + 1
        const location =
            "dbresource://mantle/content/workEffort/" +
            root.workEffortId +
            "/procedure_" +
            sequence +
            "/Procedure-" +
            root.workEffortId +
            ".pdf"
        ec.resource.getLocationReference(location).putBytes(ec.resource.xslFoTransform(html, null, null, "application/pdf"))
        return call("create#" + CONTENT, {
            workEffortId: root.workEffortId,
            contentTypeEnumId: PUBLISHED,
            contentLocation: location,
            contentChecksum: ec.resource.digest(location, "sha256"),
            description:
                "Procedure " + (root.workEffortName || root.workEffortId) + ", approved " + dateText(approved.approvedDate),
            contentDate: ec.user.nowTimestamp,
            userId: ec.user.userId
        }).workEffortContentId
    } catch (error) {
        ec.logger.error("Procedure " + root.workEffortId + ": the published PDF was not stored: " + error.message)
        return null
    }
}

// ===== instantiate#WorkProcess (the checked path, design §4.2 step 1) =====
// The caller makes work of a procedure (MAINTENANCE_PLAN or _SUPERVISE in its organization; create#MaintenanceWorkOrder calls it in
// its transaction): approved (PROCESS_NOT_APPROVED; a retired one PROCESS_RETIRED), effective at the creation time
// (PROCESS_NOT_EFFECTIVE) and applicable to the target (assetId or facilityId; PROCESS_NOT_APPLICABLE); then People's two-pass
// copy, and the requirements copied after it. A retry under operationKey answers the first root.
function instantiateProcedure(p) {
    const userScope = scopeWithAny(["plan", "supervise"])
    const found = requireProcedure(userScope, p.templateWorkEffortId, "instantiate")
    const {root, policy} = found
    if (root.statusId === "WeClosed") denied("PROCESS_RETIRED", "Procedure " + root.workEffortId + " is retired")
    if (root.statusId !== "WeApproved") denied("PROCESS_NOT_APPROVED", "Procedure " + root.workEffortId + " is not approved")
    if (!effectiveAt(root, policy, nowMs()))
        denied("PROCESS_NOT_EFFECTIVE", "Procedure " + root.workEffortId + " is not in effect now")
    const target = targetOf(userScope, p)
    const refused = applicabilityRefusal(policy, target)
    if (refused) denied("PROCESS_NOT_APPLICABLE", "Procedure " + root.workEffortId + " does not apply: " + refused)
    const out = workProcesses.instantiate(p)
    if (!out.repeated) copyRequirements(out.idMap)
    return out
}

// ===== find#ProcessExecutions =====
// The work made of a procedure that the caller's scope covers (a reader of the procedure): each work order's id, name, target,
// created time, state and outcome; a link only for a reader of work.
function findExecutions(p) {
    const userScope = scopeWithAny(["processView"])
    const found = requireProcedure(userScope, p.workEffortId, "read")
    const orders = Array.from(
        find(ORDER, {procedureWorkEffortId: found.root.workEffortId}).orderBy("-procedureDate").limit(listCap).list()
    )
    const out = []
    for (const order of orders) {
        const root = one(WORK, {workEffortId: order.workEffortId})
        if (!root || !maintenanceAccess.covers(userScope, maintenanceAccess.rootOrganization(root.workEffortId))) continue
        const targetName = order.assetId
            ? one("mantle.product.asset.Asset", {assetId: order.assetId})?.assetName || order.assetId
            : root.facilityId
              ? one("mantle.facility.Facility", {facilityId: root.facilityId})?.facilityName || root.facilityId
              : ""
        out.push({
            workEffortId: root.workEffortId,
            workEffortName: root.workEffortName || root.workEffortId,
            targetName,
            createdText: dateText(order.procedureDate),
            statusId: root.statusId,
            statusText: one("moqui.basic.StatusItem", {statusId: root.statusId})?.description || root.statusId,
            outcomeText: enumText(order.outcomeEnumId),
            canOpen: !!userScope.capabilities.view
        })
    }
    return lib.pageList(out, p, "executionList")
}

const operations = {
    findProcesses,
    getProcess,
    storeProcess,
    storeProcessStep,
    moveStep,
    storeDependency,
    storeRequirements,
    storeInstruction,
    findInstructions,
    requestApproval,
    approveProcess,
    refuseProcess,
    retireProcess,
    findExecutions,
    instantiateProcedure,
    checkApplicability
}
;({
    execute: (op, parameters) => {
        if (!Object.hasOwn(operations, op)) throw new Error("Unknown maintenance procedure operation " + op)
        return operations[op](parameters || {})
    },
    procedureOf,
    requireProcedure,
    executionInstruction,
    responseText,
    effectiveAt,
    applicabilityRefusal
})
