// People's lifecycle checklists and equipment return (mantle.humanres.PeopleServices find#Checklists, store#Checklist,
// store#ChecklistStep, start#Checklists, get#ChecklistTask, get#AssignedEquipment, get#EquipmentCustody, return#Equipment and
// complete#ReturnTasks; IronStone People design §4, §12 ChecklistTemplates, §13 WorkItemDetail and EquipmentDetail, Employee360's
// AssignedEquipment, PE-02; impl-people P7).
//
// A checklist template is a WorkEffort process (mantle.work.ProcessServices, WorkProcesses.js; MT-03's first part) whose policy is
// People's (WppPeopleChecklist, guarding nothing: its tasks stay ordinary tasks, completed by update#Task and set#TaskStatus from a
// screen or a phone): a root WorkEffort (a WetTask with purpose WepPrOrgMgmt and no documentation space, so it is no project in
// Projects' lists and WorkEffortPartyDocsUsers adds nobody), its steps, and People's facts (ChecklistTemplate: the employer, the
// lifecycle kind and the dates; ChecklistStep: the source link, visibility, protected flag and named assignee). HR readers of the
// employer read them (PEOPLE_HR_VIEW) and HR editors change them (PEOPLE_HR_EDIT).
//
// A hire, an applied transfer and an applied separation start the employer's templates of their kind after the change commits
// (Mantle's tx-commit rules, PeopleChecklists.secas.xml), each template on its own transaction, a failure logged by its employment
// and template and never undoing the change; a retry answers the checklist made (one per template and change). Each task is
// assigned by its step's role: the employee, their manager, the HR officer who made the change, or the step's named person for any
// other role. An offboarding checklist's tasks are protected (left out of the CalDAV Tasks collection, F22), and a separation adds
// one equipment return task per AssetPartyAssignment the person holds on its date, naming the assignment by a WorkEffortAssetAssign
// of the asset and a WorkEffortParty of the holder in the assignment's role (F60); the return is replace#AssetPartyAssignment to
// the receiving custodian after People's check (return#Equipment, F52), and Mantle's rule on the assignment's end
// (PeopleChecklist.eecas.xml) completes the open return tasks of that asset, holder and role, whoever ends it (Warehouse,
// Maintenance, People, F45). Every service checks the caller's People scope first and reads and writes with authorization off.
const people = ec.resource.script("component://mr-mantle/service/mantle/humanres/People.js")
const processes = () => ec.resource.script("component://mr-mantle/service/mantle/work/WorkProcesses.js")
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const {find, one, rows, denied, call, dateText} = lib

const WORK = "mantle.work.effort.WorkEffort"
const TEMPLATE = "mantle.humanres.checklist.ChecklistTemplate"
const STEP = "mantle.humanres.checklist.ChecklistStep"
const RUN = "mantle.humanres.checklist.EmploymentChecklist"
const CHANGE = "mantle.humanres.employment.EmploymentChange"
const RELATIONSHIP = "mantle.party.PartyRelationship"
const CUSTODY = "mantle.product.asset.AssetPartyAssignment"
const ASSET_TASK = "mantle.work.effort.WorkEffortAssetAssign"
const PARTY = "mantle.work.effort.WorkEffortParty"
const policyId = "WppPeopleChecklist"
// the lifecycle kind a change starts
const kindOfChange = {EckHire: "ClkOnboarding", EckTransfer: "ClkTransfer", EckSeparation: "ClkOffboarding"}
const kindTexts = {ClkOnboarding: "Onboarding", ClkTransfer: "Transfer", ClkOffboarding: "Offboarding"}
const sourceLinkTexts = {ClsItAccess: "IT access", ClsEquipmentReturn: "Equipment return", ClsExitInterview: "Exit interview"}
const visibilityTexts = {ChvEmployee: "The employee sees it", ChvStaff: "Staff only"}
// the roles a step is assigned by: those People names, and any other for the step's named person
const roleTexts = {
    Employee: "The employee",
    Manager: "Their manager",
    HumanResourcesManager: "The HR officer",
    SysAdmin: "IT (a named person)",
    Assignee: "A named person"
}
const namedRoles = ["Employee", "Manager", "HumanResourcesManager"]
const openStatuses = ["WeInPlanning", "WeApproved", "WeInProgress", "WeOnHold"]
const DAY = 24 * 60 * 60 * 1000

const ms = lib.ms
const nowMs = () => ms(ec.user.nowTimestamp)
const text = value => String(value ?? "").trim()
const truthy = value => value === true || value === "true" || value === "Y"
const stamp = millis => (millis == null ? null : new Date(millis))
const openAt = (row, at) => (ms(row.fromDate) ?? -Infinity) <= at && (ms(row.thruDate) ?? Infinity) > at
const unique = people.unique

// ===== scope =====
function hrScope(edit, what) {
    const userScope = people.scopeOf()
    const caps = userScope.capabilities
    if (!caps.hrView || (edit && !caps.hrEdit))
        denied("PERMISSION_DENIED", what + (edit ? " needs PEOPLE_HR_VIEW and PEOPLE_HR_EDIT" : " needs PEOPLE_HR_VIEW"))
    return userScope
}
// A template of an employer in the caller's scope; refused alike when missing or outside (RECORD_UNAVAILABLE).
function templateIn(userScope, workEffortId) {
    const id = text(workEffortId)
    const row = id ? one(TEMPLATE, {workEffortId: id}) : null
    if (!row || !userScope.organizationPartyIds.includes(row.organizationPartyId))
        denied("RECORD_UNAVAILABLE", "Checklist " + id + " is not available")
    return row
}
// The employers a person is or was employed by (any dates).
function employersOf(partyId) {
    return unique(rows(RELATIONSHIP, {relationshipTypeEnumId: "PrtEmployee", fromPartyId: partyId}).map(row => row.toPartyId))
}
const hrReads = (userScope, partyId) =>
    !!userScope.capabilities.hrView && employersOf(partyId).some(org => userScope.organizationPartyIds.includes(org))

// ===== find#Checklists =====
// The templates of the employers in the caller's scope (organizationPartyId narrows; ended ones with includeEnded), each with its
// steps in effect (and the ended ones marked when asked).
function findChecklists(p) {
    const userScope = hrScope(false, "Reading checklists")
    let orgIds = userScope.organizationPartyIds
    if (text(p.organizationPartyId)) {
        people.requireOrganization(userScope, text(p.organizationPartyId))
        orgIds = [text(p.organizationPartyId)]
    }
    const at = nowMs()
    let query = find(TEMPLATE).condition("organizationPartyId", "in", orgIds.length ? orgIds : ["_NA_"])
    if (text(p.lifecycleKindEnumId)) query = query.condition("lifecycleKindEnumId", text(p.lifecycleKindEnumId))
    const templates = Array.from(query.list()).filter(row => truthy(p.includeEnded) || (ms(row.thruDate) ?? Infinity) > at)
    if (!templates.length) return {checklists: [], canEdit: !!userScope.capabilities.hrEdit}
    const roots = new Map(
        Array.from(
            find(WORK)
                .condition(
                    "workEffortId",
                    "in",
                    templates.map(row => row.workEffortId)
                )
                .list()
        ).map(row => [row.workEffortId, row])
    )
    const organizations = people.organizationNames(unique(templates.map(row => row.organizationPartyId)))
    const checklists = templates
        .map(row => {
            const root = roots.get(row.workEffortId) || {}
            const steps = stepsOf(row.workEffortId, at, truthy(p.includeEnded))
            return {
                workEffortId: row.workEffortId,
                workEffortName: root.workEffortName || row.workEffortId,
                description: root.description || "",
                organizationPartyId: row.organizationPartyId,
                organizationName: organizations[row.organizationPartyId] || row.organizationPartyId,
                lifecycleKindEnumId: row.lifecycleKindEnumId,
                kindText: kindTexts[row.lifecycleKindEnumId] || "",
                fromDateText: dateText(row.fromDate),
                thruDateText: dateText(row.thruDate),
                active: openAt(row, at),
                stateText: openAt(row, at)
                    ? "In use"
                    : (ms(row.fromDate) ?? 0) > at
                      ? "Starts " + dateText(row.fromDate)
                      : "Ended",
                stepCount: steps.filter(step => !step.ended).length,
                steps,
                revision: String(ms(root.lastUpdatedStamp) ?? "")
            }
        })
        .sort((a, b) => a.organizationName.localeCompare(b.organizationName) || a.workEffortName.localeCompare(b.workEffortName))
    return {checklists, canEdit: !!userScope.capabilities.hrEdit}
}
// A template's steps, by sequence: their names, policy (required, role, due offset) and People's facts.
function stepsOf(templateId, at, includeEnded) {
    const nodes = Array.from(find(WORK).condition("rootWorkEffortId", templateId).orderBy(["sequenceNum", "workEffortId"]).list())
    if (!nodes.length) return []
    const ids = nodes.map(row => row.workEffortId)
    const facts = new Map(Array.from(find(STEP).condition("workEffortId", "in", ids).list()).map(row => [row.workEffortId, row]))
    const policies = {}
    for (const row of Array.from(find("mantle.work.effort.WorkEffortStepPolicy").condition("workEffortId", "in", ids).list()))
        (policies[row.workEffortId] = policies[row.workEffortId] || []).push(row)
    const assignees = people.personNames(
        unique(
            Array.from(facts.values())
                .map(row => row.assigneePartyId)
                .filter(Boolean)
        )
    )
    const out = []
    for (const node of nodes) {
        const all = (policies[node.workEffortId] || []).sort((a, b) => ms(b.fromDate) - ms(a.fromDate))
        const policy = all.find(row => openAt(row, at)) || null
        const ended = !policy
        if (ended && !includeEnded) continue
        const shown = policy || all[0] || {}
        const fact = facts.get(node.workEffortId) || {}
        out.push({
            workEffortId: node.workEffortId,
            workEffortName: node.workEffortName || node.workEffortId,
            description: node.description || "",
            sequenceNum: node.sequenceNum,
            isRequired: shown.isRequired || "Y",
            requiredText: shown.isRequired === "N" ? "Optional" : "Required",
            roleTypeId: shown.roleTypeId || "",
            roleText: roleTexts[shown.roleTypeId] || shown.roleTypeId || "Unassigned",
            dueOffsetDays: shown.dueOffsetDays ?? null,
            dueText:
                shown.dueOffsetDays == null
                    ? ""
                    : Number(shown.dueOffsetDays) === 0
                      ? "On the day"
                      : Math.abs(Number(shown.dueOffsetDays)) +
                        (Math.abs(Number(shown.dueOffsetDays)) === 1 ? " day " : " days ") +
                        (Number(shown.dueOffsetDays) < 0 ? "before" : "after"),
            sourceLinkEnumId: fact.sourceLinkEnumId || "",
            sourceLinkText: sourceLinkTexts[fact.sourceLinkEnumId] || "",
            visibilityEnumId: fact.visibilityEnumId || "ChvStaff",
            visibilityText: visibilityTexts[fact.visibilityEnumId || "ChvStaff"],
            isProtected: fact.isProtected === "Y" ? "Y" : "N",
            assigneePartyId: fact.assigneePartyId || "",
            assigneeName: fact.assigneePartyId ? assignees[fact.assigneePartyId] || fact.assigneePartyId : "",
            ended
        })
    }
    return out
}

// ===== store#Checklist and store#ChecklistStep =====
// A template new (an employer in scope, its lifecycle kind and name: the root WorkEffort, People's policy and the template row)
// or changed (its name and description), or ended (end: from now, never deleted; its checklists started stay).
function storeChecklist(p) {
    const userScope = hrScope(true, "Changing a checklist")
    const at = nowMs()
    const id = text(p.workEffortId)
    if (id) {
        const row = templateIn(userScope, id)
        const root = one(WORK, {workEffortId: id})
        if (text(p.expectedRevision) && text(p.expectedRevision) !== String(ms(root.lastUpdatedStamp) ?? ""))
            denied("REVISION_CHANGED", "This checklist changed since you read it; open it again")
        if (truthy(p.end)) {
            if ((ms(row.thruDate) ?? Infinity) > at) {
                call("update#" + TEMPLATE, {workEffortId: id, thruDate: stamp(at), thruDate_changeReason: text(p.reason) || null})
                const policy = processes().processPolicyOf(id, at)
                if (policy)
                    call("update#mantle.work.effort.WorkEffortProcessPolicy", {
                        workEffortId: id,
                        fromDate: policy.fromDate,
                        thruDate: stamp(at)
                    })
            }
            return {workEffortId: id, ended: true}
        }
        const fields = {workEffortId: id}
        if (p.workEffortName != null) {
            if (!text(p.workEffortName)) denied("NAME_REQUIRED", "Name the checklist")
            fields.workEffortName = text(p.workEffortName)
        }
        if (p.description != null) fields.description = text(p.description) || null
        if (Object.keys(fields).length > 1) call("update#" + WORK, fields)
        return {workEffortId: id, ended: false}
    }
    const organizationPartyId = text(p.organizationPartyId)
    if (!organizationPartyId) denied("ORGANIZATION_REQUIRED", "Choose the employer")
    people.requireOrganization(userScope, organizationPartyId)
    const kind = text(p.lifecycleKindEnumId)
    if (!Object.hasOwn(kindTexts, kind)) denied("KIND_INVALID", "Choose onboarding, transfer or offboarding")
    const name = text(p.workEffortName)
    if (!name) denied("NAME_REQUIRED", "Name the checklist")
    const workEffortId = call("create#" + WORK, {
        workEffortTypeEnumId: "WetTask",
        purposeEnumId: "WepPrOrgMgmt",
        isTemplate: "Y",
        statusId: "WeInPlanning",
        ownerPartyId: organizationPartyId,
        workEffortName: name,
        description: text(p.description) || null
    }).workEffortId
    call("create#mantle.work.effort.WorkEffortProcessPolicy", {
        workEffortId,
        fromDate: stamp(at),
        processPolicyEnumId: policyId,
        guardsExecution: "N"
    })
    call("create#" + TEMPLATE, {workEffortId, organizationPartyId, lifecycleKindEnumId: kind, fromDate: stamp(at)})
    return {workEffortId, ended: false}
}
// A step of a template in scope, new or changed (store#ProcessStep's fields and People's facts), or ended. A role People does not
// name needs the named person (ASSIGNEE_REQUIRED), one employed by the template's employer now (ASSIGNEE_OUTSIDE).
function storeChecklistStep(p) {
    const userScope = hrScope(true, "Changing a checklist")
    const template = templateIn(userScope, p.templateWorkEffortId)
    const stepId = text(p.workEffortId)
    if (stepId && !one(WORK, {workEffortId: stepId, rootWorkEffortId: template.workEffortId}))
        denied("RECORD_UNAVAILABLE", "Step " + stepId + " is not a step of this checklist")
    if (truthy(p.end)) return processes().storeStep({rootWorkEffortId: template.workEffortId, workEffortId: stepId, end: true})
    const roleTypeId = p.roleTypeId == null ? null : text(p.roleTypeId)
    if (roleTypeId && !Object.hasOwn(roleTexts, roleTypeId)) denied("VALUE_INVALID", "Choose who does the step")
    const fact = stepId ? one(STEP, {workEffortId: stepId}) : null
    const assigneePartyId = p.assigneePartyId != null ? text(p.assigneePartyId) || null : fact?.assigneePartyId || null
    const role = roleTypeId ?? (stepId ? processes().stepPolicyOf(stepId)?.roleTypeId || null : null)
    if (role && !namedRoles.includes(role)) {
        if (!assigneePartyId) denied("ASSIGNEE_REQUIRED", "Name the person who does this step")
        const employed = people.employersOfParties([assigneePartyId], null)[assigneePartyId] || []
        if (!employed.includes(template.organizationPartyId))
            denied("ASSIGNEE_OUTSIDE", "The person is not employed by the checklist's employer")
    }
    const sourceLinkEnumId = p.sourceLinkEnumId != null ? text(p.sourceLinkEnumId) || null : fact?.sourceLinkEnumId || null
    if (sourceLinkEnumId && !Object.hasOwn(sourceLinkTexts, sourceLinkEnumId))
        denied("VALUE_INVALID", "Choose what the step links to")
    const visibilityEnumId =
        p.visibilityEnumId != null ? text(p.visibilityEnumId) || "ChvStaff" : fact?.visibilityEnumId || "ChvStaff"
    if (!Object.hasOwn(visibilityTexts, visibilityEnumId)) denied("VALUE_INVALID", "Choose who sees the step")
    const stored = processes().storeStep({
        rootWorkEffortId: template.workEffortId,
        workEffortId: stepId || null,
        workEffortName: p.workEffortName,
        purposeEnumId: "WepTask",
        description: p.description,
        sequenceNum: p.sequenceNum,
        isRequired: p.isRequired,
        roleTypeId: roleTypeId,
        dueOffsetDays: p.dueOffsetDays
    })
    const values = {
        workEffortId: stored.workEffortId,
        sourceLinkEnumId,
        visibilityEnumId,
        isProtected: p.isProtected != null ? (truthy(p.isProtected) ? "Y" : "N") : fact?.isProtected || "N",
        assigneePartyId: role && !namedRoles.includes(role) ? assigneePartyId : null
    }
    call((fact ? "update#" : "create#") + STEP, values)
    return {workEffortId: stored.workEffortId, ended: false}
}

// ===== start#Checklists =====
// The checklists of an applied change (a hire, a transfer, a separation), each template of its employer and kind in use now on its
// own transaction, and a separation's equipment return; a failure is logged by employment and template and the rest go on. The
// change's own record decides: its caller needs no permission (a manager whose approval applied a transfer starts its checklist).
function startChecklists(p) {
    const change = appliedChange(p.employmentChangeId)
    if (!change) return {started: 0, failed: 0}
    const kind = kindOfChange[change.changeKindEnumId]
    if (!kind) return {started: 0, failed: 0}
    const at = nowMs()
    const templates = rows(TEMPLATE, {organizationPartyId: change.organizationPartyId, lifecycleKindEnumId: kind}).filter(row =>
        openAt(row, at)
    )
    let started = 0
    let failed = 0
    const each = (label, service, parameters) => {
        ec.message.pushErrors()
        try {
            ec.service.sync().name(service).parameters(parameters).requireNewTransaction(true).disableAuthz().call()
            if (ec.message.hasError()) throw new Error(ec.message.getErrorsString())
            started++
        } catch (error) {
            failed++
            ec.logger.error(
                "The " +
                    label +
                    " of employment " +
                    change.partyRelationshipId +
                    " (change " +
                    change.employmentChangeId +
                    ") was not started: " +
                    error.message
            )
        } finally {
            ec.message.clearErrors()
            ec.message.popErrors()
        }
    }
    for (const template of templates)
        each("checklist " + template.workEffortId, "mantle.humanres.PeopleServices.start#Checklist", {
            employmentChangeId: change.employmentChangeId,
            templateWorkEffortId: template.workEffortId
        })
    if (kind === "ClkOffboarding")
        each("equipment return", "mantle.humanres.PeopleServices.start#EquipmentReturn", {
            employmentChangeId: change.employmentChangeId
        })
    return {started, failed}
}
function appliedChange(employmentChangeId) {
    const change = text(employmentChangeId) ? one(CHANGE, {employmentChangeId: text(employmentChangeId)}) : null
    return change && change.statusId === "EchApplied" ? change : null
}
// The parties of a change's roles: the employee, their manager at the employer on the change's date and the HR officer who
// asked for it.
function roleParties(change) {
    const at = ms(change.effectiveDate) ?? nowMs()
    const assigned = people.assignmentsAt([change.partyId], at)[change.organizationPartyId + "/" + change.partyId]
    const manager =
        assigned?.managerPartyId ||
        people
            .linesOf({reportPartyIds: [change.partyId]}, at)
            .find(line => line.organizationPartyIds.includes(change.organizationPartyId))?.managerPartyId ||
        null
    const requester = change.requestedByUserId ? one("moqui.security.UserAccount", {userId: change.requestedByUserId}) : null
    return {
        Employee: change.partyId,
        Manager: change.changeKindEnumId === "EckSeparation" ? null : manager,
        HumanResourcesManager: requester?.partyId || null
    }
}
// One template's checklist for a change (in its own transaction, start#Checklists'): the template's tree instantiated (People's
// policy, the key of the change and template answering a retry), its root named for the person, People's step facts copied to
// each task (protected for offboarding), the IT task linked to the change's access request and the checklist recorded.
function startChecklist(p) {
    const change = appliedChange(p.employmentChangeId)
    const template = text(p.templateWorkEffortId) ? one(TEMPLATE, {workEffortId: text(p.templateWorkEffortId)}) : null
    if (!change || !template || template.organizationPartyId !== change.organizationPartyId)
        denied("RECORD_UNAVAILABLE", "The checklist is not available for this change")
    if (template.lifecycleKindEnumId !== kindOfChange[change.changeKindEnumId])
        denied("KIND_INVALID", "The checklist is not of this change's kind")
    const done = rows(RUN, {employmentChangeId: change.employmentChangeId, templateWorkEffortId: template.workEffortId})[0]
    if (done) return {workEffortId: done.workEffortId, repeated: true}
    const root = one(WORK, {workEffortId: template.workEffortId})
    const personName = people.personNames([change.partyId])[change.partyId] || change.partyId
    const parties = roleParties(change)
    const facts = new Map(
        Array.from(
            find(STEP)
                .condition(
                    "workEffortId",
                    "in",
                    rows(WORK, {rootWorkEffortId: template.workEffortId})
                        .map(row => row.workEffortId)
                        .concat(["_NA_"])
                )
                .list()
        ).map(row => [row.workEffortId, row])
    )
    // a role People does not name takes the step's named person: per step, so the copy assigns each by its template step
    const made = processes().instantiate({
        templateWorkEffortId: template.workEffortId,
        operationKey: "checklist-" + change.employmentChangeId + "-" + template.workEffortId,
        startDate: change.effectiveDate,
        roleParties: parties,
        rootFields: {
            workEffortName: (root.workEffortName || kindTexts[template.lifecycleKindEnumId]) + ": " + personName,
            ownerPartyId: change.organizationPartyId
        }
    })
    const protectedKind = template.lifecycleKindEnumId === "ClkOffboarding"
    for (const [templateStepId, taskId] of Object.entries(made.idMap || {})) {
        if (templateStepId === template.workEffortId) continue
        const fact = facts.get(templateStepId) || {}
        call("create#" + STEP, {
            workEffortId: taskId,
            sourceLinkEnumId: fact.sourceLinkEnumId || null,
            visibilityEnumId: fact.visibilityEnumId || "ChvStaff",
            isProtected: protectedKind || fact.isProtected === "Y" ? "Y" : "N",
            operationId: fact.sourceLinkEnumId === "ClsItAccess" ? change.accessOperationId || null : null
        })
        const role = processes().stepPolicyOf(taskId)?.roleTypeId
        if (role && !namedRoles.includes(role) && fact.assigneePartyId)
            call("create#" + PARTY, {
                workEffortId: taskId,
                partyId: fact.assigneePartyId,
                roleTypeId: "Assignee",
                fromDate: ec.user.nowTimestamp,
                statusId: "WeptAssigned"
            })
    }
    call("create#" + RUN, {
        workEffortId: made.workEffortId,
        partyRelationshipId: change.partyRelationshipId,
        partyId: change.partyId,
        organizationPartyId: change.organizationPartyId,
        employmentChangeId: change.employmentChangeId,
        templateWorkEffortId: template.workEffortId,
        lifecycleKindEnumId: template.lifecycleKindEnumId,
        startedDate: ec.user.nowTimestamp
    })
    return {workEffortId: made.workEffortId, repeated: false}
}
// A separation's equipment return (its own transaction): one task per AssetPartyAssignment the person holds on the separation's
// date, under a root of its own (People's policy, protected, due on the date, assigned to the HR officer who asked for the
// separation), each naming its assignment by a WorkEffortAssetAssign of the asset and a WorkEffortParty of the holder in the
// assignment's role. An assignment with an open return task already is left (a retry makes none again).
function startEquipmentReturn(p) {
    const change = appliedChange(p.employmentChangeId)
    if (!change || change.changeKindEnumId !== "EckSeparation") denied("RECORD_UNAVAILABLE", "The separation is not available")
    const at = ms(change.effectiveDate) ?? nowMs()
    const held = rows(CUSTODY, {partyId: change.partyId}).filter(
        row => (ms(row.thruDate) ?? Infinity) > at && (ms(row.fromDate) ?? -Infinity) <= Math.max(at, nowMs())
    )
    const pending = held.filter(row => !openReturnTasks(row.assetId, row.partyId, row.roleTypeId).length)
    if (!pending.length) return {workEffortId: null, taskCount: 0}
    const personName = people.personNames([change.partyId])[change.partyId] || change.partyId
    const receiver = roleParties(change).HumanResourcesManager
    let rootId = rows(RUN, {employmentChangeId: change.employmentChangeId}).find(row => !row.templateWorkEffortId)?.workEffortId
    if (!rootId) {
        rootId = call("create#" + WORK, {
            workEffortTypeEnumId: "WetTask",
            purposeEnumId: "WepPrOrgMgmt",
            statusId: "WeInPlanning",
            resolutionEnumId: "WerUnresolved",
            ownerPartyId: change.organizationPartyId,
            workEffortName: "Equipment return: " + personName,
            estimatedCompletionDate: stamp(at)
        }).workEffortId
        call("create#mantle.work.effort.WorkEffortProcessPolicy", {
            workEffortId: rootId,
            fromDate: ec.user.nowTimestamp,
            processPolicyEnumId: policyId,
            guardsExecution: "N",
            operationKey: "equipment-return-" + change.employmentChangeId
        })
        call("create#" + RUN, {
            workEffortId: rootId,
            partyRelationshipId: change.partyRelationshipId,
            partyId: change.partyId,
            organizationPartyId: change.organizationPartyId,
            employmentChangeId: change.employmentChangeId,
            lifecycleKindEnumId: "ClkOffboarding",
            startedDate: ec.user.nowTimestamp
        })
    }
    const assets = new Map(
        Array.from(
            find("mantle.product.asset.Asset")
                .condition("assetId", "in", unique(pending.map(row => row.assetId)))
                .list()
        ).map(row => [row.assetId, row])
    )
    for (const assignment of pending) {
        const asset = assets.get(assignment.assetId) || {}
        const taskId = call("create#" + WORK, {
            workEffortTypeEnumId: "WetTask",
            purposeEnumId: "WepTask",
            statusId: "WeInPlanning",
            resolutionEnumId: "WerUnresolved",
            parentWorkEffortId: rootId,
            rootWorkEffortId: rootId,
            ownerPartyId: change.organizationPartyId,
            workEffortName: "Return " + (asset.assetName || assignment.assetId),
            description:
                "Return " +
                (asset.assetName || assignment.assetId) +
                (asset.serialNumber ? " (serial " + asset.serialNumber + ")" : "") +
                " from " +
                personName,
            estimatedCompletionDate: stamp(at)
        }).workEffortId
        call("create#" + ASSET_TASK, {
            workEffortId: taskId,
            assetId: assignment.assetId,
            fromDate: ec.user.nowTimestamp,
            statusId: "WeaaAssigned"
        })
        call("create#" + PARTY, {
            workEffortId: taskId,
            partyId: assignment.partyId,
            roleTypeId: assignment.roleTypeId,
            fromDate: ec.user.nowTimestamp
        })
        if (receiver)
            call("create#" + PARTY, {
                workEffortId: taskId,
                partyId: receiver,
                roleTypeId: "Assignee",
                fromDate: ec.user.nowTimestamp,
                statusId: "WeptAssigned"
            })
        call("create#" + STEP, {
            workEffortId: taskId,
            sourceLinkEnumId: "ClsEquipmentReturn",
            visibilityEnumId: "ChvStaff",
            isProtected: "Y"
        })
    }
    return {workEffortId: rootId, taskCount: pending.length}
}
// The open return tasks of an assignment: open tasks with the equipment return link, a WorkEffortAssetAssign of the asset and a
// WorkEffortParty of the holder in the role.
function openReturnTasks(assetId, partyId, roleTypeId) {
    const byAsset = rows(ASSET_TASK, {assetId}).map(row => row.workEffortId)
    if (!byAsset.length) return []
    const holderOf = new Set(
        Array.from(find(PARTY).condition("workEffortId", "in", byAsset).condition({partyId, roleTypeId}).list()).map(
            row => row.workEffortId
        )
    )
    const linked = Array.from(holderOf)
    if (!linked.length) return []
    const returns = new Set(
        Array.from(
            find(STEP).condition("workEffortId", "in", linked).condition("sourceLinkEnumId", "ClsEquipmentReturn").list()
        ).map(row => row.workEffortId)
    )
    if (!returns.size) return []
    return Array.from(
        find(WORK).condition("workEffortId", "in", Array.from(returns)).condition("statusId", "in", openStatuses).list()
    ).map(row => row.workEffortId)
}
// complete#ReturnTasks (Mantle's rule on an AssetPartyAssignment ended, whoever ends it): the open return tasks of the asset,
// holder and role completed through set#TaskStatus. Never refuses: a failure is logged and the custody change stands.
function completeReturnTasks(p) {
    let completed = 0
    try {
        for (const workEffortId of openReturnTasks(text(p.assetId), text(p.partyId), text(p.roleTypeId))) {
            call("mantle.work.TaskServices.set#TaskStatus", {workEffortId, statusId: "WeComplete"})
            completed++
        }
    } catch (error) {
        ec.message.clearErrors()
        ec.logger.error(
            "The return tasks of asset " + p.assetId + " held by " + p.partyId + " were not completed: " + error.message
        )
    }
    return {completed}
}

// ===== get#ChecklistTask: People's context of a task (WorkItemDetail's People mount) =====
// A checklist task (or an equipment return) the caller may open under People: one of its parties, an HR reader of the
// employment's employer, or the employee when the step is visible to them. Its employment, person and checklist by name, what it
// links to (the equipment, the Admin outcome of the IT access request) and the next steps; none for anyone else, alike when
// missing (RECORD_UNAVAILABLE). Never pay or a case's text.
function getChecklistTask(p) {
    const userScope = people.scopeOf()
    const workEffortId = text(p.workEffortId)
    const task = workEffortId ? one(WORK, {workEffortId}) : null
    const run = task ? one(RUN, {workEffortId: task.rootWorkEffortId || task.workEffortId}) : null
    const unavailable = () => denied("RECORD_UNAVAILABLE", "Task " + workEffortId + " is not available in People")
    if (!task || !run) unavailable()
    const fact = one(STEP, {workEffortId}) || {}
    const partyId = ec.user.userAccount?.partyId || null
    const isParty = !!partyId && rows(PARTY, {workEffortId, partyId}).some(row => (ms(row.thruDate) ?? Infinity) > nowMs())
    const hr = !!userScope.capabilities.hrView && userScope.organizationPartyIds.includes(run.organizationPartyId)
    const employee = partyId === run.partyId && fact.visibilityEnumId === "ChvEmployee"
    if (!isParty && !hr && !employee) unavailable()
    const checklistRoot = one(WORK, {workEffortId: run.workEffortId})
    const status = task.statusId ? one("moqui.basic.StatusItem", {statusId: task.statusId}) : null
    const out = {
        workEffortId,
        workEffortName: task.workEffortName || workEffortId,
        statusText: status?.description || "",
        dueText: dateText(task.estimatedCompletionDate),
        partyId: hr ? run.partyId : null,
        personName: people.personNames([run.partyId])[run.partyId] || "",
        organizationName: people.organizationNames([run.organizationPartyId])[run.organizationPartyId] || "",
        checklistName: checklistRoot?.workEffortName || "",
        kindText: kindTexts[run.lifecycleKindEnumId] || "",
        sourceLinkEnumId: fact.sourceLinkEnumId || "",
        sourceLinkText: sourceLinkTexts[fact.sourceLinkEnumId] || "",
        isProtected: fact.isProtected === "Y",
        canReadEmployee: hr,
        equipment: null,
        access: null,
        siblings: []
    }
    if (fact.sourceLinkEnumId === "ClsEquipmentReturn") {
        const assigned = rows(ASSET_TASK, {workEffortId})[0]
        const asset = assigned ? one("mantle.product.asset.Asset", {assetId: assigned.assetId}) : null
        if (asset)
            out.equipment = {
                assetId: asset.assetId,
                assetName: asset.assetName || asset.assetId,
                serialNumber: asset.serialNumber || ""
            }
    }
    if (fact.sourceLinkEnumId === "ClsItAccess") {
        const change = one(CHANGE, {employmentChangeId: run.employmentChangeId}) || {}
        const operationId = fact.operationId || change.accessOperationId || null
        const operation = operationId ? one("mantle.party.UserLifecycleOperation", {operationId}) : null
        const steps = operation ? rows("mantle.party.UserLifecycleOperationStep", {operationId}) : []
        const stepNames = {UlstDone: "Done", UlstWaiting: "Waiting", UlstFailed: "Failed", UlstSkipped: "Skipped"}
        out.access = operation
            ? {
                  operationId,
                  statusText:
                      {UlopCompleted: "Completed", UlopScheduled: "Scheduled", UlopAttention: "Needs attention"}[
                          operation.statusId
                      ] || operation.statusId,
                  stepsText: steps
                      .sort((a, b) => a.stepSeqId.localeCompare(b.stepSeqId))
                      .map(
                          step =>
                              (step.title || step.stepKind) +
                              ": " +
                              (step.statusId === "UlstWaiting" && step.reasonCode === "OPERATOR_REQUIRED"
                                  ? "waiting for an identity operator"
                                  : (stepNames[step.statusId] || step.statusId).toLowerCase())
                      )
                      .join("; ")
              }
            : {
                  operationId: null,
                  statusText: change.accessRequestFailure
                      ? "Not requested: " + change.accessRequestFailure
                      : change.accessRequested === "Y"
                        ? "Requested, not recorded yet"
                        : "No account was asked for",
                  stepsText: ""
              }
    }
    // the checklist's other tasks, for the next step
    out.siblings = Array.from(
        find(WORK).condition("rootWorkEffortId", run.workEffortId).orderBy(["sequenceNum", "workEffortId"]).limit(30).list()
    )
        .filter(row => row.workEffortId !== workEffortId)
        .map(row => ({
            workEffortId: row.workEffortId,
            workEffortName: row.workEffortName || row.workEffortId,
            done: !openStatuses.includes(row.statusId)
        }))
    return out
}

// ===== equipment =====
// get#AssignedEquipment: the equipment a person holds now (current AssetPartyAssignment rows), for the person themselves or an HR
// reader of an employer of theirs; refused alike when missing or outside (RECORD_UNAVAILABLE). No cost.
function getAssignedEquipment(p) {
    const userScope = people.scopeOf()
    const partyId = text(p.partyId)
    const self = !!partyId && partyId === userScope.partyId && !!userScope.capabilities.self
    if (!partyId || (!self && !hrReads(userScope, partyId)))
        denied("RECORD_UNAVAILABLE", "Person " + partyId + " is not available")
    const at = nowMs()
    const held = rows(CUSTODY, {partyId}).filter(row => openAt(row, at))
    return {equipmentList: equipmentRows(held), canReturn: !!userScope.capabilities.hrEdit && hrReads(userScope, partyId)}
}
function equipmentRows(assignments) {
    if (!assignments.length) return []
    const assets = new Map(
        Array.from(
            find("mantle.product.asset.Asset")
                .condition("assetId", "in", unique(assignments.map(row => row.assetId)))
                .list()
        ).map(row => [row.assetId, row])
    )
    const products = new Map(
        Array.from(
            find("mantle.product.Product")
                .condition(
                    "productId",
                    "in",
                    unique(
                        Array.from(assets.values())
                            .map(row => row.productId)
                            .filter(Boolean)
                    ).concat(["_NA_"])
                )
                .list()
        ).map(row => [row.productId, row])
    )
    const roles = new Map(
        Array.from(
            find("mantle.party.RoleType")
                .condition("roleTypeId", "in", unique(assignments.map(row => row.roleTypeId)))
                .list()
        ).map(row => [row.roleTypeId, row.description])
    )
    return assignments.map(row => {
        const asset = assets.get(row.assetId) || {}
        return {
            assetId: row.assetId,
            assetName: asset.assetName || row.assetId,
            productName: products.get(asset.productId)?.productName || "",
            serialNumber: asset.serialNumber || "",
            partyId: row.partyId,
            roleTypeId: row.roleTypeId,
            roleText: roles.get(row.roleTypeId) || row.roleTypeId,
            fromDateText: dateText(row.fromDate),
            thruDateText: dateText(row.thruDate),
            current: openAt(row, nowMs()),
            returnTaskId: openReturnTasks(row.assetId, row.partyId, row.roleTypeId)[0] || null
        }
    })
}
// get#EquipmentCustody: an asset People's EquipmentDetail may show: one a person the caller reads as HR holds or held (or the
// caller themselves); its identity (product, serial, status, location; never cost) and its custody history, with each open
// return task, and whether the caller may end a holding (an HR editor of the holder's employer).
function getEquipmentCustody(p) {
    const userScope = people.scopeOf()
    const assetId = text(p.assetId)
    const asset = assetId ? one("mantle.product.asset.Asset", {assetId}) : null
    const history = asset ? rows(CUSTODY, {assetId}).sort((a, b) => ms(b.fromDate) - ms(a.fromDate)) : []
    const admitted = history.filter(
        row => (row.partyId === userScope.partyId && userScope.capabilities.self) || hrReads(userScope, row.partyId)
    )
    if (!asset || !admitted.length) denied("RECORD_UNAVAILABLE", "Equipment " + assetId + " is not available in People")
    const names = people.personNames(unique(history.map(row => row.partyId)))
    const rowsOut = equipmentRows(history).map(row =>
        Object.assign(row, {
            holderName: names[row.partyId] || row.partyId,
            canReturn: row.current && !!userScope.capabilities.hrEdit && hrReads(userScope, row.partyId)
        })
    )
    const product = asset.productId ? one("mantle.product.Product", {productId: asset.productId}) : null
    const facility = asset.facilityId ? one("mantle.facility.Facility", {facilityId: asset.facilityId}) : null
    const status = asset.statusId ? one("moqui.basic.StatusItem", {statusId: asset.statusId}) : null
    return {
        asset: {
            assetId,
            assetName: asset.assetName || assetId,
            productName: product?.productName || "",
            serialNumber: asset.serialNumber || "",
            statusText: status?.description || "",
            facilityName: facility?.facilityName || ""
        },
        custodyList: rowsOut,
        canReturn: rowsOut.some(row => row.canReturn)
    }
}
// return#Equipment: a holding ended by its return to the receiving custodian (replace#AssetPartyAssignment, which requires the
// new holder and ends every other holder of the role, F52), for an HR editor of the holder's employer; the receiving custodian is
// a person employed now by one of the caller's employers, not the holder (CUSTODIAN_INVALID). The rule on the assignment's end
// completes its return task.
function returnEquipment(p) {
    const userScope = hrScope(true, "Ending a holding")
    const assetId = text(p.assetId)
    const partyId = text(p.partyId)
    const roleTypeId = text(p.roleTypeId)
    const holding = rows(CUSTODY, {assetId, partyId, roleTypeId}).find(row => openAt(row, nowMs()))
    if (!holding || !hrReads(userScope, partyId)) denied("RECORD_UNAVAILABLE", "This holding is not available")
    const newPartyId = text(p.newPartyId)
    if (!newPartyId || newPartyId === partyId) denied("CUSTODIAN_INVALID", "Choose who receives the equipment")
    const employers = people.employersOfParties([newPartyId], null)[newPartyId] || []
    if (!employers.some(org => userScope.organizationPartyIds.includes(org)))
        denied("CUSTODIAN_INVALID", "The person receiving it is not employed by one of your employers")
    call("mantle.product.AssetServices.replace#AssetPartyAssignment", {assetId, roleTypeId, newPartyId})
    return {completed: !openReturnTasks(assetId, partyId, roleTypeId).length}
}

// ===== get#TaskObjectTags: protected tasks (F22) =====
// The tasks of the ids that are protected (offboarding, separation and grievance-linked tasks): left out of a phone's Tasks.
function protectedTaskIds(workEffortIds) {
    const ids = unique(Array.from(workEffortIds || []).filter(Boolean))
    if (!ids.length) return []
    return Array.from(find(STEP).condition("workEffortId", "in", ids).condition("isProtected", "Y").list()).map(
        row => row.workEffortId
    )
}

const operations = {
    findChecklists,
    storeChecklist,
    storeChecklistStep,
    startChecklists,
    startChecklist,
    startEquipmentReturn,
    completeReturnTasks,
    getChecklistTask,
    getAssignedEquipment,
    getEquipmentCustody,
    returnEquipment
}
;({
    execute: (op, parameters) => {
        if (!Object.hasOwn(operations, op)) throw new Error("Unknown checklist operation " + op)
        return operations[op](parameters || {})
    },
    // for CalendarDavServices.get#TaskObjectTags and Employees.js
    protectedTaskIds,
    equipmentRows
})
