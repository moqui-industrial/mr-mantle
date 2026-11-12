// Maintenance procedures (mantle.work.ProcessServices' checked path for WppMaintenanceProcedure, MaintenanceProcedures.js; IronStone
// Maintenance design §4.1, §4.2, §12; impl-maintenance P6): an author builds a procedure with a nested group, a dependency and a
// reading (a cycle and a group with a response refused); the author may not approve it, an approver does (its instructions
// published as WectInstruction rows, the definition stored as a PDF); two work orders made of it have distinct ids, carry the
// step policies and the requirements, link each node once to its template node and wait for a supervisor by the steps' hours
// (F107); changed input under a key is refused and a retry answers the first root; a change takes the procedure back to Draft
// and the earlier work keeps its instruction; a draft, a retired, a not-yet-effective and an inapplicable procedure are refused;
// the template is refused time, the Tasks collection, update#Task, clone#WorkEffort and the time import while a People checklist
// task is still completed as a task. People's own cases stay in WorkProcess, which passes unchanged.
// Standalone: spec-local organizations, facility, equipment models and equipment, groups and users, the services called as each
// user with the artifact check aside (their own permission and scope checks decide).
// Run: ./moq test mr-mantle --spec MaintenanceProcesses
const prefix = "MNT_PROC_SPEC"
const orgA = prefix + "_A",
    orgB = prefix + "_B",
    since = "2000-01-01T00:00:00Z"
const W = "mantle.work.ProcessServices."
const S = "mantle.work.MaintenanceServices."
const state = {}
const hour = 3600000

// the service's answer as a user, or the reason code it refuses with
function as(username, service, parameters = {}) {
    login(username)
    ec.artifactExecution.disableAuthz()
    try {
        return call(service, parameters)
    } catch (error) {
        const match = /([A-Z][A-Z0-9_]+):/.exec(String(error.message))
        return match ? match[1] : "ERROR " + error.message
    } finally {
        ec.message.clearErrors()
        login("john.doe")
        ec.artifactExecution.disableAuthz()
    }
}
function organization(partyId, name) {
    call("create#mantle.party.Party", {partyId, partyTypeEnumId: "PtyOrganization", ownerPartyId: partyId})
    call("create#mantle.party.Organization", {partyId, organizationName: name})
    call("create#mantle.party.PartyRole", {partyId, roleTypeId: "OrgInternal"})
}
function user(kind, permissions, organizationPartyId) {
    const id = prefix + "_U_" + kind
    call("create#moqui.security.UserGroup", {userGroupId: id, description: "Maintenance procedures " + kind})
    for (const permission of permissions)
        call("create#moqui.security.UserGroupPermission", {userGroupId: id, userPermissionId: permission, fromDate: since})
    const partyId = prefix + "_P_" + kind
    call("create#mantle.party.Party", {partyId, partyTypeEnumId: "PtyPerson"})
    call("create#mantle.party.Person", {partyId, firstName: "Procedures", lastName: kind})
    call("create#mantle.party.PartyRelationship", {
        relationshipTypeEnumId: "PrtAgent",
        fromPartyId: partyId,
        toPartyId: organizationPartyId,
        toRoleTypeId: "OrgInternal",
        fromDate: since
    })
    call("create#moqui.security.UserAccount", {
        userId: id,
        username: id,
        partyId,
        currentPassword: "16ac58bbfa332c1c55bd98b53e60720bfa90d394",
        passwordHashType: "SHA"
    })
    call("create#moqui.security.UserGroupMember", {userId: id, userGroupId: id, fromDate: since})
    state[kind + "_PARTY"] = partyId
    return id
}
const find = (entity, conditions) => Array.from(ec.entity.find(entity).condition(conditions).disableAuthz().list())
const one = (entity, conditions) => ec.entity.find(entity).condition(conditions).disableAuthz().one()
const work = workEffortId => one("mantle.work.effort.WorkEffort", {workEffortId})
const tree = rootId => find("mantle.work.effort.WorkEffort", {rootWorkEffortId: rootId})
const basedOn = workEffortId =>
    find("mantle.work.effort.WorkEffortAssoc", {workEffortId, workEffortAssocTypeEnumId: "WeatBasedOn"})
const stepPolicy = workEffortId => find("mantle.work.effort.WorkEffortStepPolicy", {workEffortId})[0]
const step = (rootId, parameters) =>
    as(state.author, W + "store#ProcessStep", Object.assign({rootWorkEffortId: rootId}, parameters))
const instruction = (rootId, workEffortId, contentText) =>
    as(state.author, W + "store#ProcessInstruction", {rootWorkEffortId: rootId, workEffortId, contentText})
// a procedure put for approval by the author and approved by the approver, effective from effectiveDate (now when empty)
function publish(rootId, effectiveDate = null) {
    const requested = as(state.author, W + "request#WorkProcessApproval", {workEffortId: rootId})
    const approved = as(state.approver, W + "approve#WorkProcess", {workEffortId: rootId, effectiveDate})
    return {requested, approved}
}

spec({
    stepwise: true,
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        organization(orgA, "Procedures Spec A")
        organization(orgB, "Procedures Spec B")
        call("create#mantle.facility.Facility", {
            facilityId: prefix + "_SITE",
            facilityName: "Procedures site",
            facilityTypeEnumId: "FcTpBuilding",
            ownerPartyId: orgA
        })
        call("create#mantle.facility.Facility", {
            facilityId: prefix + "_ROOM",
            facilityName: "Procedures room",
            facilityTypeEnumId: "FcTpRoom",
            parentFacilityId: prefix + "_SITE"
        })
        for (const productId of [prefix + "_MODEL", prefix + "_OTHER_MODEL"])
            call("create#mantle.product.Product", {
                productId,
                productName: productId,
                productTypeEnumId: "PtAsset",
                assetTypeEnumId: "AstTpEquipment"
            })
        call("create#mantle.product.Product", {
            productId: prefix + "_FILTER",
            productName: "Oil filter",
            productTypeEnumId: "PtAsset"
        })
        call("create#moqui.basic.Enumeration", {
            enumId: prefix + "_SKILL",
            enumTypeId: "SkillType",
            description: "Compressor service"
        })
        for (const [assetId, productId] of [
            [prefix + "_COMP", prefix + "_MODEL"],
            [prefix + "_PUMP", prefix + "_OTHER_MODEL"]
        ])
            call("create#mantle.product.asset.Asset", {
                assetId,
                assetTypeEnumId: "AstTpEquipment",
                assetName: assetId,
                productId,
                ownerPartyId: orgA,
                facilityId: prefix + "_SITE"
            })
        state.author = user("AUTHOR", ["WORK_PROCESS_VIEW", "WORK_PROCESS_EDIT"], orgA)
        state.approver = user("APPROVER", ["WORK_PROCESS_VIEW", "WORK_PROCESS_APPROVE"], orgA)
        state.planner = user("PLANNER", ["MAINTENANCE_VIEW", "MAINTENANCE_PLAN", "WORK_PROCESS_VIEW"], orgA)
        state.supervisor = user("SUPERVISOR", ["MAINTENANCE_VIEW", "MAINTENANCE_SUPERVISE", "MAINTENANCE_SETTINGS_EDIT"], orgA)
        state.tech = user("TECH", ["MAINTENANCE_ASSIGNED_VIEW", "MAINTENANCE_EXECUTE"], orgA)
        state.otherPlanner = user(
            "OTHER",
            ["MAINTENANCE_VIEW", "MAINTENANCE_PLAN", "WORK_PROCESS_VIEW", "WORK_PROCESS_EDIT"],
            orgB
        )
        // planned work up to three hours is approved on create; the procedure's steps add up to four
        as(state.supervisor, "mantle.work.MaintenanceSettingsServices.store#MaintenancePolicy", {
            organizationPartyId: orgA,
            approvalThresholdHours: 3
        })
    },
    cleanupSpec() {
        ec.message.clearErrors()
        login("john.doe")
    }
})

feature(
    "an author builds a procedure with a nested group, a dependency and a reading; a cycle, a bad unit and a group's response are refused; the author may not approve it and an approver does",
    {
        when() {
            const made = as(state.author, W + "store#WorkProcess", {
                workEffortName: "Compressor service",
                organizationPartyId: orgA,
                maintenanceTypeEnumId: "MntTpPreventive",
                applicableProductId: prefix + "_MODEL"
            })
            const root = (state.procedure = made.workEffortId)
            const prepare = step(root, {workEffortName: "Prepare", estimatedWorkTime: 1})
            const isolate = step(root, {
                workEffortName: "Isolate power",
                parentWorkEffortId: prepare.workEffortId,
                responseKindEnumId: "WsrCheckOff"
            })
            const drain = step(root, {
                workEffortName: "Drain the tank",
                parentWorkEffortId: prepare.workEffortId,
                estimatedWorkTime: 1
            })
            const oil = step(root, {workEffortName: "Change the oil", estimatedWorkTime: 1, dependsOnIds: [prepare.workEffortId]})
            const pressure = step(root, {
                workEffortName: "Read the pressure",
                estimatedWorkTime: 1,
                responseKindEnumId: "WsrReading",
                measurementTypeId: "AtmosphericPressure",
                measurementUomId: "LEN_m",
                minimumValue: 7,
                maximumValue: 9,
                waiverAllowed: "Y"
            })
            Object.assign(state, {
                prepare: prepare.workEffortId,
                isolate: isolate.workEffortId,
                oil: oil.workEffortId,
                pressure: pressure.workEffortId
            })
            const cycle = step(root, {workEffortId: prepare.workEffortId, dependsOnIds: [oil.workEffortId]})
            const groupResponse = step(root, {workEffortId: prepare.workEffortId, responseKindEnumId: "WsrPassFail"})
            const badKind = step(root, {workEffortId: oil.workEffortId, responseKindEnumId: "NO_SUCH_KIND"})
            const findings = as(state.author, W + "request#WorkProcessApproval", {workEffortId: root})
            // fixed: the group takes no response, the reading a pressure unit
            step(root, {workEffortId: prepare.workEffortId, responseKindEnumId: ""})
            step(root, {workEffortId: pressure.workEffortId, measurementUomId: "PRES_bar"})
            const part = as(state.author, W + "store#ProcessRequirements", {
                rootWorkEffortId: root,
                workEffortId: oil.workEffortId,
                kind: "product",
                productId: prefix + "_FILTER",
                estimatedQuantity: 2
            })
            const skill = as(state.author, W + "store#ProcessRequirements", {
                rootWorkEffortId: root,
                workEffortId: oil.workEffortId,
                kind: "skill",
                skillTypeEnumId: prefix + "_SKILL"
            })
            instruction(root, oil.workEffortId, "Drain at 40 C; refill with 2 l ISO 46.")
            const reader = as(state.planner, W + "store#ProcessStep", {rootWorkEffortId: root, workEffortName: "No"})
            const other = as(state.otherPlanner, W + "get#WorkProcess", {workEffortId: root})
            const requested = as(state.author, W + "request#WorkProcessApproval", {workEffortId: root})
            const again = as(state.author, W + "request#WorkProcessApproval", {workEffortId: root})
            const plannerUses = as(state.planner, S + "create#MaintenanceWorkOrder", {
                assetId: prefix + "_COMP",
                templateWorkEffortId: root
            })
            // the approver (not its author) approves it; a second approval finds no draft
            const approved = as(state.approver, W + "approve#WorkProcess", {workEffortId: root})
            const twice = as(state.approver, W + "approve#WorkProcess", {workEffortId: root})
            const detail = as(state.planner, W + "get#WorkProcess", {workEffortId: root})
            return {
                made,
                cycle,
                groupResponse,
                badKind,
                findings,
                part,
                skill,
                reader,
                other,
                requested,
                again,
                plannerUses,
                approved,
                twice,
                detail
            }
        },
        then({
            made,
            cycle,
            groupResponse,
            badKind,
            findings,
            part,
            skill,
            reader,
            other,
            requested,
            again,
            plannerUses,
            approved,
            twice,
            detail
        }) {
            made.statusId == "WeInPlanning"
            work(state.procedure).isTemplate == "Y"
            work(state.procedure).purposeEnumId == "WepMaintenance"
            find("mantle.work.effort.WorkEffortProcessPolicy", {workEffortId: state.procedure})[0].guardsExecution == "Y"
            work(state.isolate).parentWorkEffortId == state.prepare
            cycle == "DEPENDENCY_INVALID"
            // a group's response is stored and found at the request, which names each finding
            groupResponse.workEffortId == state.prepare
            badKind == "VALUE_INVALID"
            findings == "PUBLICATION_INVALID"
            part.workEffortId == state.oil && skill.workEffortId == state.oil
            reader == "PERMISSION_DENIED"
            other == "RECORD_UNAVAILABLE"
            requested.repeated == false
            again.repeated == true && again.workEffortApprovalId == requested.workEffortApprovalId
            plannerUses == "PROCESS_NOT_APPROVED"
            approved.statusId == "WeApproved" && approved.publishedCount == 1
            twice == "STATUS_INVALID"
            detail.procedure.statusText == "Approved"
            detail.stepList.length == 5
            detail.stepList.find(row => row.workEffortId == state.prepare).isGroup == true
            detail.stepList.find(row => row.workEffortId == state.oil).dependsOnIds.includes(state.prepare)
            detail.stepList.find(row => row.workEffortId == state.pressure).responseText.includes("Reading")
            find("mantle.work.effort.WorkEffortApproval", {workEffortId: state.procedure, statusId: "WeaApproved"}).length == 1
            find("mantle.work.effort.WorkEffortContent", {workEffortId: state.oil, contentTypeEnumId: "WectInstruction"})
                .length == 1
            find("mantle.work.effort.WorkEffortContent", {
                workEffortId: state.procedure,
                contentTypeEnumId: "WectPublishedProcedure"
            }).length == 1
        }
    }
)

feature("the last author is refused approval unless the organization allows self-approval", {
    when() {
        const made = as(state.author, W + "store#WorkProcess", {workEffortName: "Room inspection", organizationPartyId: orgA})
        state.inspection = made.workEffortId
        step(made.workEffortId, {workEffortName: "Look at the ceiling", responseKindEnumId: "WsrPassFail"})
        as(state.author, W + "request#WorkProcessApproval", {workEffortId: made.workEffortId})
        // the approver changes the description: now the last author
        const both = user("BOTH", ["WORK_PROCESS_VIEW", "WORK_PROCESS_EDIT", "WORK_PROCESS_APPROVE"], orgA)
        as(both, W + "store#WorkProcess", {workEffortId: made.workEffortId, description: "Every room, monthly"})
        as(both, W + "request#WorkProcessApproval", {workEffortId: made.workEffortId})
        const self = as(both, W + "approve#WorkProcess", {workEffortId: made.workEffortId})
        as(state.supervisor, "mantle.work.MaintenanceSettingsServices.store#MaintenancePolicy", {
            organizationPartyId: orgA,
            approvalThresholdHours: 3,
            procedureSelfApproval: "Y"
        })
        const allowed = as(both, W + "approve#WorkProcess", {workEffortId: made.workEffortId})
        as(state.supervisor, "mantle.work.MaintenanceSettingsServices.store#MaintenancePolicy", {
            organizationPartyId: orgA,
            approvalThresholdHours: 3,
            procedureSelfApproval: "N"
        })
        return {self, allowed}
    },
    then({self, allowed}) {
        self == "SELF_APPROVAL"
        allowed.statusId == "WeApproved"
    }
})

feature(
    "two work orders made of the procedure have their own ids, step policies, requirements and one source link a node; they wait for a supervisor by the steps' hours; a retry answers the first and changed input is refused",
    {
        when() {
            const create = (key, name) =>
                as(state.planner, S + "create#MaintenanceWorkOrder", {
                    assetId: prefix + "_COMP",
                    templateWorkEffortId: state.procedure,
                    workEffortName: name,
                    operationKey: key
                })
            const first = create(prefix + "-first", "Compressor service, March")
            const second = create(prefix + "-second", "Compressor service, April")
            const retry = create(prefix + "-first", "Compressor service, March")
            const changed = create(prefix + "-first", "Compressor service, May")
            const plannerApproves = as(state.planner, S + "transition#MaintenanceWorkOrder", {
                workEffortId: first.workEffortId,
                action: "approve"
            })
            const detail = as(state.planner, S + "get#MaintenanceWorkOrder", {workEffortId: first.workEffortId})
            const wrongModel = as(state.planner, S + "create#MaintenanceWorkOrder", {
                assetId: prefix + "_PUMP",
                templateWorkEffortId: state.procedure
            })
            const otherOrganization = as(state.otherPlanner, S + "create#MaintenanceWorkOrder", {
                assetId: prefix + "_COMP",
                templateWorkEffortId: state.procedure
            })
            Object.assign(state, {first: first.workEffortId, second: second.workEffortId})
            return {first, second, retry, changed, plannerApproves, detail, wrongModel, otherOrganization}
        },
        then({first, second, retry, changed, plannerApproves, detail, wrongModel, otherOrganization}) {
            first.workEffortId != second.workEffortId
            // four hours of steps over the three-hour threshold: a supervisor's (F107)
            first.statusId == "WeInPlanning"
            plannerApproves == "APPROVAL_REQUIRED"
            detail.workOrder.totalEstimatedHours == 4
            detail.workOrder.procedureWorkEffortId == state.procedure
            retry.repeated == true && retry.workEffortId == first.workEffortId
            changed == "OPERATION_KEY_CONFLICT"
            wrongModel == "PROCESS_NOT_APPLICABLE"
            otherOrganization == "RECORD_UNAVAILABLE"
            const firstTree = tree(state.first)
            const secondTree = tree(state.second)
            firstTree.length == 5 && secondTree.length == 5
            !firstTree.some(row => secondTree.some(other => other.workEffortId == row.workEffortId))
            firstTree.every(row => row.isTemplate == "N" && row.statusId == "WeInPlanning")
            ;[state.first].concat(firstTree.map(row => row.workEffortId)).every(id => basedOn(id).length == 1)
            const oil = firstTree.find(row => basedOn(row.workEffortId)[0].toWorkEffortId == state.oil)
            const pressure = firstTree.find(row => basedOn(row.workEffortId)[0].toWorkEffortId == state.pressure)
            stepPolicy(pressure.workEffortId).responseKindEnumId == "WsrReading"
            stepPolicy(pressure.workEffortId).waiverAllowed == "Y"
            find("mantle.work.effort.WorkEffortProduct", {workEffortId: oil.workEffortId, productId: prefix + "_FILTER"})
                .length == 1
            find("mantle.work.effort.WorkEffortSkillStandard", {workEffortId: oil.workEffortId}).length == 1
            // the dependency is remapped inside the new tree
            const depends = find("mantle.work.effort.WorkEffortAssoc", {
                workEffortId: oil.workEffortId,
                workEffortAssocTypeEnumId: "WeatDependsOn"
            })
            depends.length == 1 && firstTree.some(row => row.workEffortId == depends[0].toWorkEffortId)
            // the work is managed by its policy and its work order
            find("mantle.work.effort.WorkEffortProcessPolicy", {workEffortId: state.first})[0].guardsExecution == "Y"
        }
    }
)

feature(
    "a change takes the procedure back to Draft: no new work until it is approved again, and earlier work keeps its instruction",
    {
        when() {
            const oilStep = tree(state.first).find(row => basedOn(row.workEffortId)[0].toWorkEffortId == state.oil).workEffortId
            instruction(state.procedure, state.oil, "Drain at 50 C; refill with 2.5 l ISO 68.")
            const draft = work(state.procedure).statusId
            const blocked = as(state.planner, S + "create#MaintenanceWorkOrder", {
                assetId: prefix + "_COMP",
                templateWorkEffortId: state.procedure
            })
            const republished = publish(state.procedure)
            const third = as(state.planner, S + "create#MaintenanceWorkOrder", {
                assetId: prefix + "_COMP",
                templateWorkEffortId: state.procedure
            })
            const thirdOil = tree(third.workEffortId).find(
                row => basedOn(row.workEffortId)[0].toWorkEffortId == state.oil
            ).workEffortId
            const earlier = as(state.planner, W + "find#ProcessInstructions", {workEffortId: oilStep})
            const later = as(state.planner, W + "find#ProcessInstructions", {workEffortId: thirdOil})
            return {draft, blocked, republished, earlier, later}
        },
        then({draft, blocked, republished, earlier, later}) {
            draft == "WeInPlanning"
            blocked == "PROCESS_NOT_APPROVED"
            republished.approved.statusId == "WeApproved"
            earlier.instructionList[0].text.includes("ISO 46")
            later.instructionList[0].text.includes("ISO 68")
            find("mantle.work.effort.WorkEffortContent", {workEffortId: state.oil, contentTypeEnumId: "WectInstruction"})
                .length == 2
        }
    }
)

feature("a draft, a retired, a not yet effective and an inapplicable procedure make no work", {
    when() {
        const draft = as(state.author, W + "store#WorkProcess", {workEffortName: "Draft only", organizationPartyId: orgA})
        step(draft.workEffortId, {workEffortName: "One", responseKindEnumId: "WsrCheckOff"})
        const fromDraft = as(state.planner, S + "create#MaintenanceWorkOrder", {
            facilityId: prefix + "_ROOM",
            templateWorkEffortId: draft.workEffortId
        })
        const later = as(state.author, W + "store#WorkProcess", {workEffortName: "Next month", organizationPartyId: orgA})
        step(later.workEffortId, {workEffortName: "One", responseKindEnumId: "WsrCheckOff"})
        publish(later.workEffortId, new Date(Date.now() + 30 * 24 * hour))
        const notYet = as(state.planner, S + "create#MaintenanceWorkOrder", {
            facilityId: prefix + "_ROOM",
            templateWorkEffortId: later.workEffortId
        })
        const room = as(state.planner, S + "create#MaintenanceWorkOrder", {
            facilityId: prefix + "_ROOM",
            templateWorkEffortId: state.inspection
        })
        const forEquipment = as(state.planner, S + "create#MaintenanceWorkOrder", {
            facilityId: prefix + "_ROOM",
            templateWorkEffortId: state.procedure
        })
        const retired = as(state.approver, W + "retire#WorkProcess", {workEffortId: state.inspection})
        const fromRetired = as(state.planner, S + "create#MaintenanceWorkOrder", {
            facilityId: prefix + "_ROOM",
            templateWorkEffortId: state.inspection
        })
        const usable = as(state.planner, W + "find#WorkProcesses", {usable: true, assetId: prefix + "_COMP"})
        const all = as(state.author, W + "find#WorkProcesses", {})
        const usage = as(state.planner, W + "find#ProcessExecutions", {workEffortId: state.procedure})
        return {fromDraft, notYet, room, forEquipment, retired, fromRetired, usable, all, usage}
    },
    then({fromDraft, notYet, room, forEquipment, retired, fromRetired, usable, all, usage}) {
        fromDraft == "PROCESS_NOT_APPROVED"
        notYet == "PROCESS_NOT_EFFECTIVE"
        room.workEffortId != null && room.statusId == "WeInPlanning"
        forEquipment == "PROCESS_NOT_APPLICABLE"
        retired.statusId == "WeClosed"
        fromRetired == "PROCESS_RETIRED"
        Array.from(usable.procedureList)
            .map(row => row.workEffortId)
            .join() == state.procedure
        Array.from(all.procedureList).some(row => row.workEffortId == state.inspection && row.statusText == "Retired")
        usage.executionListCount == 3
    }
})

feature(
    "a procedure is managed work: its steps are refused update#Task, time, clone#WorkEffort, the time import and the Tasks collection, while a People checklist task is completed as a task",
    {
        when() {
            // the technician named on a template step and on the first work order's root (as a system write, for the checks)
            const now = ec.user.nowTimestamp
            for (const workEffortId of [state.oil, state.first])
                call("create#mantle.work.effort.WorkEffortParty", {
                    workEffortId,
                    partyId: state.TECH_PARTY,
                    roleTypeId: "Assignee",
                    fromDate: now,
                    statusId: "WeptAssigned"
                })
            const update = as(state.tech, "mantle.work.TaskServices.update#Task", {
                workEffortId: state.oil,
                workEffortName: "Changed"
            })
            const time = as(state.tech, S + "record#MaintenanceTime", {
                workEffortId: state.oil,
                fromDate: new Date(Date.now() - hour),
                hours: 1
            })
            const taskTime = as(state.tech, "mantle.work.TaskServices.add#TaskTime", {
                workEffortId: state.oil,
                hours: 1,
                fromDate: new Date(Date.now() - hour)
            })
            const cloned = as("john.doe", "mantle.work.WorkEffortServices.clone#WorkEffort", {baseWorkEffortId: state.procedure})
            const dependency = as("john.doe", "mantle.work.TaskServices.add#TaskDependency", {
                workEffortId: state.oil,
                toWorkEffortId: state.pressure
            })
            const tags = Array.from(as(state.tech, "mantle.work.CalendarDavServices.get#TaskObjectTags").objectList || [])
            const firstStep = tree(state.first)[0].workEffortId
            const csv =
                "Date;Email;Work item;Duration;Description\n" + `2027-02-03;john.doe;${firstStep};1;Imported onto a step\n`
            const imported = as("john.doe", "mantle.work.TimeServices.import#TimeEntryCsv", {fileText: csv, preview: true})
            // the technician reads the procedure of work assigned to them, read only, and no other
            const techRead = as(state.tech, W + "get#WorkProcess", {workEffortId: state.procedure})
            const techOther = as(state.tech, W + "get#WorkProcess", {workEffortId: state.inspection})
            // a People checklist: its task is an ordinary task
            const checklist = call("create#mantle.work.effort.WorkEffort", {
                workEffortTypeEnumId: "WetTask",
                purposeEnumId: "WepPrOrgMgmt",
                isTemplate: "Y",
                statusId: "WeInPlanning",
                workEffortName: "Onboarding",
                ownerPartyId: orgA
            }).workEffortId
            call("create#mantle.work.effort.WorkEffortProcessPolicy", {
                workEffortId: checklist,
                fromDate: since,
                processPolicyEnumId: "WppPeopleChecklist"
            })
            const hr = user("HR", ["PEOPLE_HR_VIEW", "PEOPLE_HR_EDIT"], orgA)
            as(hr, W + "store#ProcessStep", {rootWorkEffortId: checklist, workEffortName: "Sign the handbook"})
            const run = as(hr, W + "instantiate#WorkProcess", {templateWorkEffortId: checklist})
            const task = tree(run.workEffortId)[0].workEffortId
            const done = as("john.doe", "mantle.work.TaskServices.set#TaskStatus", {workEffortId: task, statusId: "WeComplete"})
            return {update, time, taskTime, cloned, dependency, tags, imported, techRead, techOther, task, done}
        },
        then({update, time, taskTime, cloned, dependency, tags, imported, techRead, techOther, task, done}) {
            update == "MANAGED_WORK"
            time == "RECORD_UNAVAILABLE"
            taskTime == "MANAGED_WORK"
            cloned == "MANAGED_WORK"
            dependency == "MANAGED_WORK"
            !tags.some(object => object.workEffortId == state.oil || object.workEffortId == state.procedure)
            imported.counts.fail == 1
            techRead.procedure.readOnly == true && techRead.canEdit == false
            techOther == "RECORD_UNAVAILABLE"
            typeof done != "string"
            work(task).statusId == "WeComplete"
        }
    }
)

// Review R2: an approval taking effect before an instruction an earlier approval published for later would leave that older
// instruction to take over at its start (Manufacturing's rule keeps a published start and an ended row's end); it is refused
// (DATE_INVALID), and a later date ends the earlier one there
feature("an approval takes effect no earlier than an instruction published for later", {
    when() {
        const made = as(state.author, W + "store#WorkProcess", {workEffortName: "Valve check", organizationPartyId: orgA})
        const valve = step(made.workEffortId, {workEffortName: "Turn the valve", responseKindEnumId: "WsrCheckOff"})
        instruction(made.workEffortId, valve.workEffortId, "A quarter turn.")
        const later = new Date(Date.now() + 48 * hour)
        const first = publish(made.workEffortId, later).approved
        instruction(made.workEffortId, valve.workEffortId, "Half a turn.")
        as(state.author, W + "request#WorkProcessApproval", {workEffortId: made.workEffortId})
        const early = as(state.approver, W + "approve#WorkProcess", {workEffortId: made.workEffortId})
        const draft = work(made.workEffortId).statusId
        const after = as(state.approver, W + "approve#WorkProcess", {
            workEffortId: made.workEffortId,
            effectiveDate: new Date(Date.now() + 72 * hour)
        })
        const rows = find("mantle.work.effort.WorkEffortContent", {
            workEffortId: valve.workEffortId,
            contentTypeEnumId: "WectInstruction"
        })
        return {first, early, draft, after, rows}
    },
    then({first, early, draft, after, rows}) {
        first.statusId == "WeApproved"
        early == "DATE_INVALID"
        draft == "WeInPlanning"
        after.statusId == "WeApproved"
        rows.length == 2
        rows.filter(row => row.thruDate == null).length == 1
        // the earlier approval's instruction ends where the later one starts
        rows.some(
            ended =>
                ended.thruDate != null &&
                rows.some(open => open.thruDate == null && String(open.fromDate) == String(ended.thruDate))
        )
    }
})
