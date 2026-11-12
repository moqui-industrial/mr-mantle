// A reusable WorkEffort process (mantle.work.ProcessServices; IronStone Maintenance design §4.1 and §4.2, MT-03), built first and
// minimal for People's lifecycle checklists (mr-boss impl-people P7, §4, F14, F54) and extended by Maintenance's P6, never
// replaced. A template is a root WorkEffort with isTemplate Y and its child steps, each step with a dated WorkEffortStepPolicy
// (required, the role it is assigned by, its due offset) and the root with a dated WorkEffortProcessPolicy (the policy using it
// and whether that policy guards execution).
//
// - storeStep (store#ProcessStep): a step of a template tree, new or changed, with its step policy (a change ends the policy in
//   effect and starts the next; an ended step is left out of new executions);
// - instantiate (instantiate#WorkProcess): the two-pass copy of design-maintenance §4.2 in its own module, so clone#WorkEffort and
//   clone#Project stay as they are: pass one copies the definition fields of each node in effect into a fresh WorkEffort (template
//   flag, status, resolution, actual dates, effort and recurrence reset; due dates from the step's offset after the start) and
//   builds the old to new id map; pass two remaps the WeatDependsOn edges inside the tree, links each new node to its template
//   node by one WeatBasedOn association, copies the step and process policies, and assigns each step to the party its caller
//   names for the step's role (a role no party is named for stays a requirement). One tree in one transaction (the caller's);
//   an operation key answers the first root;
// - checkManagedWork (check#ManagedWork): the managed-work rule of impl-people §4 and impl-maintenance §4, in the same words:
//   the generic task and work-effort services refuse a root that has a MaintenanceWorkOrder row and its steps, and work whose
//   process policy guards execution (MANAGED_WORK). People's checklist tasks stay ordinary tasks: its policy does not guard.
//
// The services check the using policy's permission (policies below); a Mantle owner that checked its own records (People's
// Checklists.js) calls the module's functions directly. Maintenance's P6 adds its policy, the checked path of design §4.2
// (approval and effectivity) for a policy that guards execution, and its step fields; this path stays as it is.
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const {find, one, rows, denied, call} = lib

const WORK = "mantle.work.effort.WorkEffort"
const ASSOC = "mantle.work.effort.WorkEffortAssoc"
const PROCESS = "mantle.work.effort.WorkEffortProcessPolicy"
const STEP = "mantle.work.effort.WorkEffortStepPolicy"
const PARTY = "mantle.work.effort.WorkEffortParty"
// a root that has a work order is managed (Maintenance's record, once it is built)
const WORK_ORDER = "mantle.work.maintenance.MaintenanceWorkOrder"
// The policies using a process: the permission their processes are changed and instantiated with through the services.
const policies = {WppPeopleChecklist: {permission: "PEOPLE_HR_EDIT"}}
// the definition fields a node keeps in an execution (design-maintenance §4.2 step 2); everything else is fresh
const definitionFields = [
    "workEffortTypeEnumId",
    "purposeEnumId",
    "visibilityEnumId",
    "workTypeEnumId",
    "ownerPartyId",
    "priority",
    "sequenceNum",
    "workEffortName",
    "description",
    "location",
    "facilityId",
    "estimatedWorkTime",
    "estimatedSetupTime",
    "timeUomId"
]
const DAY = 24 * 60 * 60 * 1000
// the deepest a template tree is read
const maxDepth = 20

const ms = lib.ms
const nowMs = () => ms(ec.user.nowTimestamp)
const text = value => String(value ?? "").trim()
const stamp = millis => (millis == null ? null : new Date(millis))
const truthy = value => value === true || value === "true" || value === "Y"
const openAt = (row, at) => (ms(row.fromDate) ?? -Infinity) <= at && (ms(row.thruDate) ?? Infinity) > at
const inEffect = (entity, workEffortId, at) =>
    rows(entity, {workEffortId})
        .filter(row => openAt(row, at))
        .sort((a, b) => ms(b.fromDate) - ms(a.fromDate))[0] || null
const processPolicyOf = (workEffortId, at = nowMs()) => inEffect(PROCESS, workEffortId, at)
const stepPolicyOf = (workEffortId, at = nowMs()) => inEffect(STEP, workEffortId, at)

// ===== the services' check =====
// The caller holds the permission of the policy using the template (PROCESS_UNAVAILABLE for a template with none in effect).
function requirePolicy(templateId) {
    const policy = processPolicyOf(templateId)
    const known = policy ? policies[policy.processPolicyEnumId] : null
    if (!policy || !known) denied("PROCESS_UNAVAILABLE", "Process " + templateId + " is not available")
    if (!ec.user.hasPermission(known.permission)) denied("PERMISSION_DENIED", "Changing this process needs " + known.permission)
    return policy
}
function template(workEffortId) {
    const row = workEffortId ? one(WORK, {workEffortId}) : null
    if (!row || row.isTemplate !== "Y") denied("PROCESS_UNAVAILABLE", "Process " + workEffortId + " is not available")
    return row
}

// ===== store#ProcessStep =====
// A step of a template tree: a new child WorkEffort of the root (or of parentWorkEffortId, a node of the same tree), or a change
// of one, with its step policy from now (the one in effect ends). With end, the step's policy ends now: the step is left out of
// new executions, its executions and history stay. dependsOnIds names the steps of the same tree it waits for (WeatDependsOn);
// a step of another tree is refused (DEPENDENCY_INVALID).
function storeStep(p) {
    const root = template(text(p.rootWorkEffortId))
    if (root.rootWorkEffortId && root.rootWorkEffortId !== root.workEffortId)
        denied("PROCESS_UNAVAILABLE", "Steps are added to a template's root")
    const at = nowMs()
    const treeIds = new Set(rows(WORK, {rootWorkEffortId: root.workEffortId}).map(row => row.workEffortId))
    let stepId = text(p.workEffortId)
    if (stepId) {
        if (!treeIds.has(stepId)) denied("RECORD_UNAVAILABLE", "Step " + stepId + " is not a step of this process")
        const before = stepPolicyOf(stepId, at)
        if (truthy(p.end)) {
            if (before) call("update#" + STEP, {workEffortId: stepId, fromDate: before.fromDate, thruDate: stamp(at)})
            return {workEffortId: stepId, ended: true}
        }
        const fields = {workEffortId: stepId}
        for (const field of ["workEffortName", "description", "sequenceNum", "estimatedWorkTime"])
            if (p[field] != null) fields[field] = p[field] === "" ? null : p[field]
        if (Object.keys(fields).length > 1) call("update#" + WORK, fields)
        const next = {
            isRequired: p.isRequired != null ? (truthy(p.isRequired) ? "Y" : "N") : before?.isRequired || "Y",
            roleTypeId: p.roleTypeId != null ? text(p.roleTypeId) || null : before?.roleTypeId || null,
            dueOffsetDays:
                p.dueOffsetDays != null && p.dueOffsetDays !== "" ? Number(p.dueOffsetDays) : (before?.dueOffsetDays ?? null)
        }
        const same =
            before &&
            before.isRequired === next.isRequired &&
            (before.roleTypeId || null) === next.roleTypeId &&
            (before.dueOffsetDays ?? null) === (next.dueOffsetDays ?? null)
        if (!same) {
            if (before && ms(before.fromDate) < at)
                call("update#" + STEP, {workEffortId: stepId, fromDate: before.fromDate, thruDate: stamp(at)})
            if (before && ms(before.fromDate) >= at)
                call("update#" + STEP, Object.assign({workEffortId: stepId, fromDate: before.fromDate}, next))
            else call("create#" + STEP, Object.assign({workEffortId: stepId, fromDate: stamp(at)}, next))
        }
    } else {
        const name = text(p.workEffortName)
        if (!name) denied("NAME_REQUIRED", "Name the step")
        const parentId = text(p.parentWorkEffortId) || root.workEffortId
        if (parentId !== root.workEffortId && !treeIds.has(parentId))
            denied("RECORD_UNAVAILABLE", "Step " + parentId + " is not a step of this process")
        stepId = call("create#" + WORK, {
            workEffortTypeEnumId: "WetTask",
            purposeEnumId: text(p.purposeEnumId) || root.purposeEnumId || null,
            parentWorkEffortId: parentId,
            rootWorkEffortId: root.workEffortId,
            ownerPartyId: root.ownerPartyId || null,
            isTemplate: "Y",
            statusId: "WeInPlanning",
            workEffortName: name,
            description: text(p.description) || null,
            sequenceNum: p.sequenceNum != null && p.sequenceNum !== "" ? Number(p.sequenceNum) : null,
            estimatedWorkTime: p.estimatedWorkTime != null && p.estimatedWorkTime !== "" ? p.estimatedWorkTime : null
        }).workEffortId
        call("create#" + STEP, {
            workEffortId: stepId,
            fromDate: stamp(at),
            isRequired: p.isRequired != null ? (truthy(p.isRequired) ? "Y" : "N") : "Y",
            roleTypeId: text(p.roleTypeId) || null,
            dueOffsetDays: p.dueOffsetDays != null && p.dueOffsetDays !== "" ? Number(p.dueOffsetDays) : null
        })
        treeIds.add(stepId)
    }
    if (p.dependsOnIds != null) {
        const wanted = Array.from(p.dependsOnIds || [])
            .map(text)
            .filter(Boolean)
        for (const id of wanted) {
            if (id === stepId || !treeIds.has(id))
                denied("DEPENDENCY_INVALID", "A step waits only for another step of its process")
            if (dependsOn(id, stepId, treeIds)) denied("DEPENDENCY_INVALID", "A step cannot wait for a step that waits for it")
        }
        const current = rows(ASSOC, {workEffortId: stepId, workEffortAssocTypeEnumId: "WeatDependsOn"}).filter(row =>
            openAt(row, at)
        )
        for (const row of current)
            if (!wanted.includes(row.toWorkEffortId))
                call("update#" + ASSOC, {
                    workEffortId: row.workEffortId,
                    toWorkEffortId: row.toWorkEffortId,
                    workEffortAssocTypeEnumId: row.workEffortAssocTypeEnumId,
                    fromDate: row.fromDate,
                    thruDate: stamp(at)
                })
        for (const id of wanted)
            if (!current.some(row => row.toWorkEffortId === id))
                call("create#" + ASSOC, {
                    workEffortId: stepId,
                    toWorkEffortId: id,
                    workEffortAssocTypeEnumId: "WeatDependsOn",
                    fromDate: stamp(at)
                })
    }
    return {workEffortId: stepId, ended: false}
}
// whether fromId waits for toId, at any remove, within the tree
function dependsOn(fromId, toId, treeIds, seen = new Set()) {
    if (fromId === toId) return true
    if (seen.has(fromId)) return false
    seen.add(fromId)
    return rows(ASSOC, {workEffortId: fromId, workEffortAssocTypeEnumId: "WeatDependsOn"})
        .filter(row => openAt(row, nowMs()) && treeIds.has(row.toWorkEffortId))
        .some(row => dependsOn(row.toWorkEffortId, toId, treeIds, seen))
}

// ===== instantiate#WorkProcess =====
// The template's tree in effect at the time: the root, and each child whose step policy is in effect (a node with no policy, a
// group, is kept), breadth first, a child left out with its sub-steps.
function treeOf(root, at) {
    const nodes = [root]
    let level = [root.workEffortId]
    for (let depth = 0; level.length && depth < maxDepth; depth++) {
        const children = Array.from(
            find(WORK).condition("parentWorkEffortId", "in", level).orderBy(["sequenceNum", "workEffortId"]).list()
        ).filter(row => row.rootWorkEffortId === root.workEffortId && row.workEffortId !== root.workEffortId)
        const kept = children.filter(row => {
            const stepRows = rows(STEP, {workEffortId: row.workEffortId})
            return !stepRows.length || stepRows.some(policy => openAt(policy, at))
        })
        nodes.push(...kept)
        level = kept.map(row => row.workEffortId)
    }
    return nodes
}
// The answer of an execution made earlier under the key: its root and the id map read back from its WeatBasedOn links.
function earlierExecution(operationKey) {
    const policy = rows(PROCESS, {operationKey})[0]
    if (!policy) return null
    const root = one(WORK, {workEffortId: policy.workEffortId})
    const nodeIds = [root.workEffortId].concat(rows(WORK, {rootWorkEffortId: root.workEffortId}).map(row => row.workEffortId))
    const idMap = {}
    for (const row of Array.from(
        find(ASSOC).condition("workEffortId", "in", nodeIds).condition("workEffortAssocTypeEnumId", "WeatBasedOn").list()
    ))
        idMap[row.toWorkEffortId] = row.workEffortId
    return {workEffortId: root.workEffortId, idMap, repeated: true}
}
// The two-pass copy (design-maintenance §4.2): the template (isTemplate Y, its process policy in effect) and its tree in effect
// into fresh WorkEfforts. rootFields override the new root's name, description and owner; startDate (now when empty) is the base
// of the due offsets; roleParties names the party assigned to each role (roleTypeId to partyId). A retry with operationKey
// answers the first root (repeated).
function instantiate(p) {
    const templateRoot = template(text(p.templateWorkEffortId))
    const at = nowMs()
    const policy = processPolicyOf(templateRoot.workEffortId, at)
    if (!policy) denied("PROCESS_UNAVAILABLE", "Process " + templateRoot.workEffortId + " is not in use")
    const operationKey = text(p.operationKey) || null
    if (operationKey) {
        const earlier = earlierExecution(operationKey)
        if (earlier) return earlier
    }
    const startMs = p.startDate == null || p.startDate === "" ? at : ms(p.startDate)
    const roleParties = p.roleParties && typeof p.roleParties === "object" ? p.roleParties : {}
    const rootFields = p.rootFields && typeof p.rootFields === "object" ? p.rootFields : {}
    const nodes = treeOf(templateRoot, at)
    const idMap = {}
    const steps = {}
    // pass one: each node's definition fields into a fresh WorkEffort, children after their parent
    for (const node of nodes) {
        const isRoot = node.workEffortId === templateRoot.workEffortId
        const fields = {}
        for (const field of definitionFields) if (node[field] != null) fields[field] = node[field]
        if (isRoot)
            for (const field of ["workEffortName", "description", "ownerPartyId"])
                if (rootFields[field] != null) fields[field] = rootFields[field]
        const stepPolicy = isRoot ? null : stepPolicyOf(node.workEffortId, at)
        steps[node.workEffortId] = stepPolicy
        Object.assign(fields, {
            isTemplate: "N",
            statusId: "WeInPlanning",
            resolutionEnumId: "WerUnresolved",
            percentComplete: null,
            parentWorkEffortId: isRoot ? null : idMap[node.parentWorkEffortId],
            rootWorkEffortId: isRoot ? null : idMap[templateRoot.workEffortId],
            remainingWorkTime: fields.estimatedWorkTime ?? null,
            estimatedStartDate: stamp(startMs),
            estimatedCompletionDate:
                stepPolicy?.dueOffsetDays != null ? stamp(startMs + Number(stepPolicy.dueOffsetDays) * DAY) : null
        })
        idMap[node.workEffortId] = call("create#" + WORK, fields).workEffortId
    }
    const rootId = idMap[templateRoot.workEffortId]
    // the execution's policy before its steps are assigned, so an assignment's notice knows whose work it is (People's lifecycle
    // work is told on its own topic, impl-people P8)
    call("create#" + PROCESS, {
        workEffortId: rootId,
        fromDate: stamp(at),
        processPolicyEnumId: policy.processPolicyEnumId,
        guardsExecution: policy.guardsExecution || "N",
        operationKey
    })
    // pass two: the dependencies inside the tree remapped, one WeatBasedOn link per node, the policies, the assignments
    const templateIds = nodes.map(node => node.workEffortId)
    for (const edge of Array.from(
        find(ASSOC).condition("workEffortId", "in", templateIds).condition("workEffortAssocTypeEnumId", "WeatDependsOn").list()
    ).filter(row => openAt(row, at) && idMap[row.toWorkEffortId]))
        call("create#" + ASSOC, {
            workEffortId: idMap[edge.workEffortId],
            toWorkEffortId: idMap[edge.toWorkEffortId],
            workEffortAssocTypeEnumId: "WeatDependsOn",
            fromDate: stamp(at),
            lagDays: edge.lagDays ?? null
        })
    for (const node of nodes) {
        call("create#" + ASSOC, {
            workEffortId: idMap[node.workEffortId],
            toWorkEffortId: node.workEffortId,
            workEffortAssocTypeEnumId: "WeatBasedOn",
            fromDate: stamp(at)
        })
        const stepPolicy = steps[node.workEffortId]
        if (stepPolicy)
            call("create#" + STEP, {
                workEffortId: idMap[node.workEffortId],
                fromDate: stamp(at),
                isRequired: stepPolicy.isRequired,
                roleTypeId: stepPolicy.roleTypeId,
                dueOffsetDays: stepPolicy.dueOffsetDays
            })
        const partyId = stepPolicy?.roleTypeId ? text(roleParties[stepPolicy.roleTypeId]) : ""
        if (partyId)
            call("create#" + PARTY, {
                workEffortId: idMap[node.workEffortId],
                partyId,
                roleTypeId: "Assignee",
                fromDate: stamp(at),
                statusId: "WeptAssigned"
            })
    }
    return {workEffortId: rootId, idMap, repeated: false}
}

// ===== check#ManagedWork =====
// Whether work is managed (impl-people §4, impl-maintenance §4): its own process policy, its root's or its parent's guards
// execution, or its root has a work order (Maintenance's record, when it is defined). Refused with MANAGED_WORK.
function managedReason(workEffortIds) {
    const ids = Array.from(new Set(workEffortIds.filter(Boolean)))
    if (!ids.length) return null
    const at = nowMs()
    const work = Array.from(
        find(WORK).condition("workEffortId", "in", ids).selectField("workEffortId,rootWorkEffortId,parentWorkEffortId").list()
    )
    const related = Array.from(
        new Set(ids.concat(work.flatMap(row => [row.rootWorkEffortId, row.parentWorkEffortId]).filter(Boolean)))
    )
    const guarded = Array.from(
        find(PROCESS).condition("workEffortId", "in", related).condition("guardsExecution", "Y").list()
    ).some(row => openAt(row, at))
    if (guarded) return "This work follows its process; change it there"
    if (ec.entity.isEntityDefined(WORK_ORDER)) {
        const roots = Array.from(new Set(work.map(row => row.rootWorkEffortId || row.workEffortId)))
        if (roots.length && find(WORK_ORDER).condition("workEffortId", "in", roots).count())
            return "This work is a work order's; change it from the work order"
    }
    return null
}
function checkManagedWork(p) {
    const ids = [text(p.workEffortId)].concat(Array.from(p.workEffortIdList || []).map(text))
    const reason = managedReason(ids)
    if (reason) denied("MANAGED_WORK", reason)
    return {managed: false}
}

// ===== the services =====
function storeProcessStep(p) {
    requirePolicy(text(p.rootWorkEffortId))
    return storeStep(p)
}
function instantiateWorkProcess(p) {
    requirePolicy(text(p.templateWorkEffortId))
    return instantiate(p)
}

const operations = {storeProcessStep, instantiateWorkProcess, checkManagedWork}
;({
    execute: (op, parameters) => {
        if (!Object.hasOwn(operations, op)) throw new Error("Unknown work process operation " + op)
        return operations[op](parameters || {})
    },
    // for a Mantle owner that checked its own records (People's Checklists.js)
    storeStep,
    instantiate,
    processPolicyOf,
    stepPolicyOf,
    managedReason
})
