// Executing a maintenance procedure's checklist (mantle.work.ProcessServices record#, waive#ProcessStep, amend#ProcessExecution,
// get#ProcessExecution, get#EvidencePolicy, ProcessChecks.js; IronStone Maintenance design §4.3, §12; impl-maintenance P7): a blocked
// predecessor is refused through record#ProcessStep and through set#TaskStatus, independent leaves run together and a group takes no
// response and is complete only by its children; a missing file, a wrong unit, an out-of-range reading, a missing comment and a
// failure leave the step open while a recheck appends; the work order's Complete waits for the required steps; a waiver keeps the
// failure and is refused where the policy forbids it and to a technician; a check's evidence is protected; an amendment invalidates
// an acceptance; Close closes the steps and stores the completed checklist. And the generic writers of managed work (F159: new time,
// a clock-in, parts) refused while the work order's own time entry point still works, a reading in work of the work's own equipment
// only (F94), and a done step's assignee not replaced (F160).
// Standalone: spec-local organizations, equipment, groups and users; the services called as each user with the artifact check aside
// (their own permission and scope checks decide).
// Run: ./moq test mr-mantle --spec ProcessChecks
const prefix = "MNT_CHK_SPEC"
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
    call("create#moqui.security.UserGroup", {userGroupId: id, description: "Checklists " + kind})
    for (const permission of permissions)
        call("create#moqui.security.UserGroupPermission", {userGroupId: id, userPermissionId: permission, fromDate: since})
    const partyId = prefix + "_P_" + kind
    call("create#mantle.party.Party", {partyId, partyTypeEnumId: "PtyPerson"})
    call("create#mantle.party.Person", {partyId, firstName: "Checklists", lastName: kind})
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
const statusOf = workEffortId => work(workEffortId).statusId
// a work order's step by its name
const stepOf = (rootId, name) => find("mantle.work.effort.WorkEffort", {rootWorkEffortId: rootId, workEffortName: name})[0].workEffortId
const step = (rootId, parameters) =>
    as(state.author, W + "store#ProcessStep", Object.assign({rootWorkEffortId: rootId}, parameters))
const record = (username, workEffortId, parameters = {}) =>
    as(username, W + "record#ProcessStep", Object.assign({workEffortId}, parameters))
const checksOf = workEffortId => find("mantle.work.effort.WorkEffortCheck", {workEffortId})
// a file of the work order (a photo the technician took)
function evidence(rootId, name) {
    return call("create#mantle.work.effort.WorkEffortContent", {
        workEffortId: rootId,
        contentTypeEnumId: "WectSupportingMedia",
        contentLocation: "dbresource://mantle/content/workEffort/" + rootId + "/" + name,
        description: name
    }).workEffortContentId
}
// a work order made of the procedure, approved, assigned to the technician and started
function startedWork(name) {
    const made = as(state.planner, S + "create#MaintenanceWorkOrder", {
        assetId: prefix + "_COMP",
        templateWorkEffortId: state.procedure,
        workEffortName: name
    })
    as(state.supervisor, S + "transition#MaintenanceWorkOrder", {workEffortId: made.workEffortId, action: "approve"})
    as(state.planner, S + "schedule#MaintenanceWorkOrder", {workEffortId: made.workEffortId, assigneePartyIds: [state.TECH_PARTY]})
    as(state.tech, S + "transition#MaintenanceWorkOrder", {workEffortId: made.workEffortId, action: "start"})
    return made.workEffortId
}

spec({
    stepwise: true,
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        organization(orgA, "Checklists Spec A")
        organization(orgB, "Checklists Spec B")
        call("create#mantle.facility.Facility", {
            facilityId: prefix + "_SITE",
            facilityName: "Checklists site",
            facilityTypeEnumId: "FcTpBuilding",
            ownerPartyId: orgA
        })
        call("create#mantle.product.Product", {
            productId: prefix + "_MODEL",
            productName: "Checklists compressor model",
            productTypeEnumId: "PtAsset",
            assetTypeEnumId: "AstTpEquipment"
        })
        call("create#mantle.product.Product", {productId: prefix + "_FILTER", productName: "Filter", productTypeEnumId: "PtAsset"})
        for (const assetId of [prefix + "_COMP", prefix + "_PUMP"])
            call("create#mantle.product.asset.Asset", {
                assetId,
                assetTypeEnumId: "AstTpEquipment",
                assetName: assetId,
                productId: prefix + "_MODEL",
                ownerPartyId: orgA,
                facilityId: prefix + "_SITE"
            })
        state.author = user("AUTHOR", ["WORK_PROCESS_VIEW", "WORK_PROCESS_EDIT"], orgA)
        state.approver = user("APPROVER", ["WORK_PROCESS_VIEW", "WORK_PROCESS_APPROVE"], orgA)
        state.planner = user("PLANNER", ["MAINTENANCE_VIEW", "MAINTENANCE_PLAN", "WORK_PROCESS_VIEW"], orgA)
        state.supervisor = user("SUPERVISOR", ["MAINTENANCE_VIEW", "MAINTENANCE_SUPERVISE"], orgA)
        state.tech = user("TECH", ["MAINTENANCE_ASSIGNED_VIEW", "MAINTENANCE_EXECUTE"], orgA)
        state.tech2 = user("TECH2", ["MAINTENANCE_ASSIGNED_VIEW", "MAINTENANCE_EXECUTE"], orgA)
        state.resources = user("RESOURCES", ["MAINTENANCE_RESOURCE_VIEW", "MAINTENANCE_RESOURCE_EDIT"], orgA)
        state.otherSupervisor = user("OTHER", ["MAINTENANCE_VIEW", "MAINTENANCE_SUPERVISE"], orgB)
        state.settings = user("SETTINGS", ["MAINTENANCE_VIEW", "MAINTENANCE_SETTINGS_EDIT"], orgA)
        // the procedure: a Prepare group of two check-offs; the oil change waiting for it, with a file required; a pressure reading
        // 7–9 bar with a comment, which a supervisor may waive; a pass or fail inspection that may not be waived; an optional clean
        const root = (state.procedure = as(state.author, W + "store#WorkProcess", {
            workEffortName: "Checklist compressor service",
            organizationPartyId: orgA,
            applicableProductId: prefix + "_MODEL"
        }).workEffortId)
        const prepare = step(root, {workEffortName: "Prepare", sequenceNum: 10}).workEffortId
        step(root, {workEffortName: "Isolate", parentWorkEffortId: prepare, sequenceNum: 10, responseKindEnumId: "WsrCheckOff"})
        step(root, {workEffortName: "Drain", parentWorkEffortId: prepare, sequenceNum: 20, responseKindEnumId: "WsrCheckOff"})
        step(root, {
            workEffortName: "Oil",
            sequenceNum: 20,
            responseKindEnumId: "WsrCheckOff",
            evidenceRequired: "Y",
            dependsOnIds: [prepare]
        })
        step(root, {
            workEffortName: "Pressure",
            sequenceNum: 30,
            responseKindEnumId: "WsrReading",
            measurementTypeId: "AtmosphericPressure",
            measurementUomId: "PRES_bar",
            minimumValue: 7,
            maximumValue: 9,
            commentRequired: "Y",
            waiverAllowed: "Y"
        })
        step(root, {workEffortName: "Inspect", sequenceNum: 40, responseKindEnumId: "WsrPassFail"})
        step(root, {workEffortName: "Clean", sequenceNum: 50, responseKindEnumId: "WsrCheckOff", isRequired: "N"})
        as(state.author, W + "request#WorkProcessApproval", {workEffortId: root})
        as(state.approver, W + "approve#WorkProcess", {workEffortId: root})
        const wo = (state.wo = startedWork("Checklist service, May"))
        for (const name of ["Prepare", "Isolate", "Drain", "Oil", "Pressure", "Inspect", "Clean"]) state[name] = stepOf(wo, name)
    },
    cleanupSpec() {
        ec.message.clearErrors()
        login("john.doe")
    }
})

feature(
    "a blocked step is refused through record#ProcessStep and set#TaskStatus; independent leaves run together; a group takes no response and completes by its children",
    {
        when() {
            const early = record(state.tech, state.Oil)
            const viaTask = as(state.tech, "mantle.work.TaskServices.set#TaskStatus", {workEffortId: state.Oil, statusId: "WeComplete"})
            const group = record(state.tech, state.Prepare)
            const otherTech = record(state.tech2, state.Isolate, {action: "start"})
            const otherOrganization = record(state.otherSupervisor, state.Isolate, {action: "start"})
            record(state.tech, state.Isolate, {action: "start"})
            record(state.tech, state.Drain, {action: "start"})
            const together = [statusOf(state.Isolate), statusOf(state.Drain), statusOf(state.Prepare)]
            const isolated = record(state.tech, state.Isolate)
            const halfway = statusOf(state.Prepare)
            const drained = record(state.tech, state.Drain)
            return {early, viaTask, group, otherTech, otherOrganization, together, isolated, halfway, drained}
        },
        then({early, viaTask, group, otherTech, otherOrganization, together, isolated, halfway, drained}) {
            early == "DEPENDENCY_OPEN"
            viaTask == "MANAGED_WORK"
            group == "GROUP_NO_RESPONSE"
            otherTech == "NOT_ASSIGNED"
            otherOrganization == "RECORD_UNAVAILABLE"
            together.every(statusId => statusId == "WeInProgress")
            isolated.accepted == true && isolated.statusId == "WeComplete"
            halfway == "WeInProgress"
            drained.accepted == true
            statusOf(state.Prepare) == "WeComplete"
        }
    }
)

feature(
    "a missing file, a wrong unit, an out-of-range reading, a missing comment and a failure leave the step open; a recheck appends; Complete waits for the required steps",
    {
        when() {
            const noFile = record(state.tech, state.Oil)
            state.photo = evidence(state.wo, "oil.jpg")
            const withFile = record(state.tech, state.Oil, {evidenceContentIds: [state.photo], operationKey: prefix + "-oil"})
            const retry = record(state.tech, state.Oil, {evidenceContentIds: [state.photo], operationKey: prefix + "-oil"})
            const changed = record(state.tech, state.Oil, {comments: "Other", operationKey: prefix + "-oil"})
            const wrongUnit = record(state.tech, state.Pressure, {measurementValue: 800, measurementUomId: "PRES_kPa", comments: "Gauge in kPa"})
            const high = record(state.tech, state.Pressure, {measurementValue: 11, measurementUomId: "PRES_bar", comments: "Relief valve sticks"})
            const noComment = record(state.tech, state.Pressure, {measurementValue: 8, measurementUomId: "PRES_bar"})
            const noOutcome = record(state.tech, state.Inspect)
            const failed = record(state.tech, state.Inspect, {outcome: "fail", comments: "Belt guard loose"})
            const passed = record(state.tech, state.Inspect, {outcome: "pass", comments: "Guard tightened"})
            const complete = as(state.tech, S + "transition#MaintenanceWorkOrder", {
                workEffortId: state.wo,
                action: "complete",
                outcomeEnumId: "MoutRepaired",
                dispositionEnumId: "MdispAvailable"
            })
            const detail = as(state.tech, W + "get#ProcessExecution", {workEffortId: state.wo})
            return {noFile, withFile, retry, changed, wrongUnit, high, noComment, noOutcome, failed, passed, complete, detail}
        },
        then({noFile, withFile, retry, changed, wrongUnit, high, noComment, noOutcome, failed, passed, complete, detail}) {
            noFile.accepted == false && noFile.findingList.some(text => text.includes("Evidence"))
            withFile.accepted == true && statusOf(state.Oil) == "WeComplete"
            retry.repeated == true && retry.workEffortCheckId == withFile.workEffortCheckId
            changed == "OPERATION_KEY_CONFLICT"
            wrongUnit.accepted == false && wrongUnit.findingList.some(text => text.includes("reads in bar"))
            high.accepted == false && high.findingList.some(text => text.includes("outside"))
            noComment.accepted == false && noComment.findingList.some(text => text.includes("comment"))
            statusOf(state.Pressure) == "WeInProgress"
            // each reading is a Measurement of the step, the wrong unit's too
            find("mantle.work.measurement.Measurement", {workEffortId: state.Pressure}).length == 3
            noOutcome == "OUTCOME_REQUIRED"
            failed.accepted == false && passed.accepted == true
            // the failure stays beside the recheck
            checksOf(state.Inspect).map(row => row.checkStatusEnumId).sort().join(",") == "WcsAccepted,WcsUnresolved"
            complete == "STEPS_OPEN"
            detail.execution.gateList.map(row => row.workEffortId).join(",") == state.Pressure
            detail.execution.nextStepId == state.Pressure
            detail.stepList.find(row => row.workEffortId == state.Pressure).failureCount == 3
            detail.stepList.find(row => row.workEffortId == state.Prepare).isGroup == true
        }
    }
)

feature(
    "a waiver keeps the failure and is refused to a technician and where the policy forbids it; a check's evidence is not changed; an optional step is skipped with a reason",
    {
        when() {
            const skipRequired = record(state.tech, state.Pressure, {action: "skip", comments: "No"})
            const byTech = as(state.tech, W + "waive#ProcessStep", {workEffortId: state.Pressure, reason: "No"})
            const forbidden = as(state.supervisor, W + "waive#ProcessStep", {workEffortId: state.Clean, reason: "No"})
            const noReason = as(state.supervisor, W + "waive#ProcessStep", {workEffortId: state.Pressure})
            const waived = as(state.supervisor, W + "waive#ProcessStep", {
                workEffortId: state.Pressure,
                reason: "Relief valve on order; within tolerance for a week"
            })
            const policy = as(state.tech, W + "get#EvidencePolicy", {workEffortId: state.wo})
            const changeFile = as(state.tech, "mantle.work.WorkEffortServices.update#WorkEffortContent", {
                workEffortContentId: state.photo,
                description: "Not the oil"
            })
            const skipNoReason = record(state.tech, state.Clean, {action: "skip"})
            const skipped = record(state.tech, state.Clean, {action: "skip", comments: "Clean last month"})
            return {byTech, forbidden, noReason, waived, policy, changeFile, skipRequired, skipNoReason, skipped}
        },
        then({byTech, forbidden, noReason, waived, policy, changeFile, skipRequired, skipNoReason, skipped}) {
            byTech == "PERMISSION_DENIED"
            forbidden == "WAIVER_NOT_ALLOWED"
            noReason == "REASON_REQUIRED"
            waived.statusId == "WeComplete"
            const waiver = find("mantle.work.effort.WorkEffortWaiver", {workEffortId: state.Pressure})
            waiver.length == 1 && waiver[0].workEffortCheckId != null
            checksOf(state.Pressure).every(row => row.checkStatusEnumId == "WcsUnresolved")
            policy.managed == true && policy.canChange == true
            policy.protectedContentIds.includes(state.photo)
            changeFile == "EVIDENCE_PROTECTED"
            skipRequired == "SKIP_NOT_ALLOWED"
            skipNoReason == "REASON_REQUIRED"
            skipped.statusId == "WeCancelled"
        }
    }
)

feature(
    "an amendment invalidates an acceptance and reopens the step; Complete then waits for it; Close closes the steps and stores the checklist",
    {
        when() {
            const change = [{workEffortId: state.Drain, evidenceRequired: "Y"}]
            const byTech = as(state.tech, W + "amend#ProcessExecution", {rootWorkEffortId: state.wo, changeList: change, reason: "No"})
            const preview = as(state.supervisor, W + "amend#ProcessExecution", {rootWorkEffortId: state.wo, changeList: change, preview: true})
            const unchanged = statusOf(state.Drain)
            const amended = as(state.supervisor, W + "amend#ProcessExecution", {
                rootWorkEffortId: state.wo,
                changeList: change,
                reason: "Photograph the drained receiver from now on"
            })
            const reopened = [statusOf(state.Drain), statusOf(state.Prepare)]
            const blocked = as(state.tech, S + "transition#MaintenanceWorkOrder", {
                workEffortId: state.wo,
                action: "complete",
                outcomeEnumId: "MoutRepaired",
                dispositionEnumId: "MdispAvailable"
            })
            const drained = record(state.tech, state.Drain, {evidenceContentIds: [evidence(state.wo, "receiver.jpg")]})
            const completed = as(state.tech, S + "transition#MaintenanceWorkOrder", {
                workEffortId: state.wo,
                action: "complete",
                outcomeEnumId: "MoutRepaired",
                dispositionEnumId: "MdispAvailable"
            })
            const closed = as(state.supervisor, S + "transition#MaintenanceWorkOrder", {workEffortId: state.wo, action: "close"})
            const afterClose = as(state.supervisor, W + "amend#ProcessExecution", {rootWorkEffortId: state.wo, changeList: change, reason: "Late"})
            const closedPolicy = as(state.supervisor, W + "get#EvidencePolicy", {workEffortId: state.wo})
            return {byTech, preview, unchanged, amended, reopened, blocked, drained, completed, closed, afterClose, closedPolicy}
        },
        then({byTech, preview, unchanged, amended, reopened, blocked, drained, completed, closed, afterClose, closedPolicy}) {
            byTech == "PERMISSION_DENIED"
            preview.invalidatedList.map(row => row.workEffortId).join(",") == state.Drain
            unchanged == "WeComplete"
            amended.executionAmendmentId != null
            reopened.join(",") == "WeInProgress,WeInProgress"
            checksOf(state.Drain).some(row => row.checkStatusEnumId == "WcsInvalidated" && row.executionAmendmentId == amended.executionAmendmentId)
            blocked == "STEPS_OPEN"
            drained.accepted == true
            completed.statusId == "WeComplete"
            closed.statusId == "WeClosed"
            ;["Prepare", "Isolate", "Drain", "Oil", "Pressure", "Inspect"].every(name => statusOf(state[name]) == "WeClosed")
            statusOf(state.Clean) == "WeCancelled"
            find("mantle.work.effort.WorkEffortContent", {workEffortId: state.wo, contentTypeEnumId: "WectCompletedChecklist"}).length == 1
            afterClose == "WORK_CLOSED"
            closedPolicy.canChange == false
        }
    }
)

feature(
    "managed work refuses new time, a clock-in and parts but through its owner; a reading in work is of the work's equipment; a done step keeps its assignee when the leaver's work moves",
    {
        when() {
            const wo = (state.wo2 = startedWork("Checklist service, June"))
            const isolate = stepOf(wo, "Isolate")
            const drain = stepOf(wo, "Drain")
            for (const id of [isolate, drain])
                call("create#mantle.work.effort.WorkEffortParty", {
                    workEffortId: id,
                    partyId: state.TECH_PARTY,
                    roleTypeId: "Assignee",
                    fromDate: ec.user.nowTimestamp,
                    statusId: "WeptAssigned"
                })
            record(state.tech, isolate)
            const from = new Date(Number(String(ec.user.nowTimestamp)) - 3 * hour)
            const time = as(state.tech, "mantle.work.TimeServices.store#TimeEntry", {workEffortId: wo, fromDate: from, hours: 1})
            const clockIn = as(state.tech, "mantle.work.TimeServices.create#TimeEntryClockIn", {workEffortId: wo})
            const part = as(state.planner, "mantle.work.WorkEffortServices.add#WorkEffortProduct", {
                workEffortId: drain,
                productId: prefix + "_FILTER",
                typeEnumId: "WeptConsume",
                estimatedQuantity: 1
            })
            const own = as(state.tech, S + "record#MaintenanceTime", {workEffortId: wo, fromDate: from, hours: 1})
            const meter = as(state.resources, "mantle.product.MaintenanceResourceServices.record#MaintenanceMeter", {
                assetId: prefix + "_PUMP",
                productMeterTypeId: "PdMtrMotorTime",
                meterValue: 5,
                workEffortId: wo
            })
            const moved = as(state.planner, S + "schedule#MaintenanceWorkOrder", {
                workEffortId: wo,
                replacePartyId: state.TECH_PARTY,
                withPartyId: state.TECH2_PARTY
            })
            const current = id =>
                Array.from(
                    ec.entity
                        .find("mantle.work.effort.WorkEffortParty")
                        .condition({workEffortId: id, roleTypeId: "Assignee"})
                        .conditionDate("fromDate", "thruDate", ec.user.nowTimestamp)
                        .disableAuthz()
                        .list()
                ).map(row => row.partyId)
            return {time, clockIn, part, own, meter, moved, isolateParties: current(isolate), drainParties: current(drain)}
        },
        then({time, clockIn, part, own, meter, moved, isolateParties, drainParties}) {
            time == "MANAGED_WORK"
            clockIn == "MANAGED_WORK"
            part == "MANAGED_WORK"
            own.timeEntryId != null
            meter == "WORK_TARGET_MISMATCH"
            moved.workEffortId == state.wo2
            isolateParties.join(",") == state.TECH_PARTY
            drainParties.join(",") == state.TECH2_PARTY
        }
    }
)

// P7 review (the user's call of Nov 12): an amendment adds a step and removes one not yet started; a started, completed or group
// step with a started child is not removed; the gate and the checklist follow; a waiver waits for its dependencies (R4)
feature(
    "an amendment adds a step and removes one not started, refuses to remove a started or completed one, and the gate follows; a waiver waits for its dependencies",
    {
        when() {
            const wo = (state.wo3 = startedWork("Checklist service, July"))
            for (const name of ["Prepare", "Isolate", "Drain", "Oil", "Pressure", "Inspect", "Clean"]) state[name + "3"] = stepOf(wo, name)
            const amend = (username, changeList, extra = {}) =>
                as(username, W + "amend#ProcessExecution", Object.assign({rootWorkEffortId: wo, changeList, reason: "Spec"}, extra))
            record(state.tech, state.Isolate3)
            record(state.tech, state.Drain3, {action: "start"})
            const removeStarted = amend(state.supervisor, [{action: "remove", workEffortId: state.Drain3}])
            const removeDone = amend(state.supervisor, [{action: "remove", workEffortId: state.Isolate3}])
            const removeGroup = amend(state.supervisor, [{action: "remove", workEffortId: state.Prepare3}])
            record(state.tech, state.Drain3)
            const prepared = statusOf(state.Prepare3)
            const add = {action: "add", workEffortName: "Vent", parentWorkEffortId: state.Prepare3, responseKindEnumId: "WsrCheckOff"}
            const byTech = amend(state.tech, [add])
            const underLeaf = amend(state.supervisor, [Object.assign({}, add, {parentWorkEffortId: state.Oil3})])
            const preview = amend(state.supervisor, [add, {action: "remove", workEffortId: state.Inspect3}], {preview: true})
            const unchanged = [statusOf(state.Prepare3), statusOf(state.Inspect3)]
            const applied = amend(state.supervisor, [add, {action: "remove", workEffortId: state.Inspect3}], {reason: "Vent the line; no inspection this time"})
            const vent = stepOf(wo, "Vent")
            const after = {prepare: statusOf(state.Prepare3), vent: statusOf(vent), inspect: statusOf(state.Inspect3), ventRoot: work(vent).rootWorkEffortId}
            const detail = as(state.tech, W + "get#ProcessExecution", {workEffortId: wo})
            // R4: the oil change made waivable waits for its group, now open again
            amend(state.supervisor, [{workEffortId: state.Oil3, waiverAllowed: "Y"}])
            const waiveBlocked = as(state.supervisor, W + "waive#ProcessStep", {workEffortId: state.Oil3, reason: "Spec"})
            const vented = record(state.tech, vent)
            return {removeStarted, removeDone, removeGroup, prepared, byTech, underLeaf, preview, unchanged, applied, vent, after, detail,
                waiveBlocked, vented}
        },
        then({removeStarted, removeDone, removeGroup, prepared, byTech, underLeaf, preview, unchanged, applied, vent, after, detail, waiveBlocked, vented}) {
            removeStarted == "STEP_STARTED"
            removeDone == "STEP_STARTED"
            removeGroup == "STEP_STARTED"
            prepared == "WeComplete"
            byTech == "PERMISSION_DENIED"
            underLeaf == "GROUP_REQUIRED"
            // the preview names the group the step reopens and the step removed, and writes nothing
            preview.invalidatedList.map(row => row.workEffortId).join(",") == state.Prepare3
            preview.removedList.map(row => row.workEffortId).join(",") == state.Inspect3
            unchanged.join(",") == "WeComplete,WeInPlanning"
            applied.executionAmendmentId != null
            after.prepare == "WeInProgress" && after.vent == "WeInPlanning" && after.inspect == "WeCancelled"
            after.ventRoot == state.wo3
            detail.stepList.find(row => row.workEffortId == state.Inspect3).statusText == "Removed"
            detail.execution.gateList.map(row => row.workEffortId).includes(vent)
            !detail.execution.gateList.map(row => row.workEffortId).includes(state.Inspect3)
            detail.amendmentList[0].summary.includes("added Vent") && detail.amendmentList[0].summary.includes("removed Inspect")
            waiveBlocked == "DEPENDENCY_OPEN"
            vented.accepted == true
            statusOf(state.Prepare3) == "WeComplete"
        }
    }
)

// P7 review (the user's call of Nov 12): a voice note is transcribed only when the organization's work policy turns it on; the
// audio is kept either way
feature("a voice note is not sent to the speech model unless the organization's work policy turns transcription on; the audio stays", {
    when() {
        const checked = record(state.tech, state.Pressure3, {measurementValue: 8, measurementUomId: "PRES_bar", comments: "Steady"})
        const voice = call("create#mantle.work.effort.WorkEffortContent", {
            workEffortId: state.wo3,
            contentTypeEnumId: "WectVoiceNote",
            contentLocation: "dbresource://mantle/content/workEffort/" + state.wo3 + "/voice/pressure.ogg",
            description: "Voice note on Pressure"
        }).workEffortContentId
        call("create#mantle.work.effort.WorkEffortCheckEvidence", {
            workEffortCheckId: checked.workEffortCheckId,
            workEffortContentId: voice,
            evidenceKindEnumId: "WceVoiceNote",
            fromDate: ec.user.nowTimestamp
        })
        const off = as(state.tech, W + "transcribe#CheckVoiceNote", {workEffortCheckId: checked.workEffortCheckId})
        const defaults = as(state.settings, "mantle.work.MaintenanceSettingsServices.get#MaintenancePolicy", {organizationPartyId: orgA})
        as(state.settings, "mantle.work.MaintenanceSettingsServices.store#MaintenancePolicy", {organizationPartyId: orgA, voiceNoteTranscription: "Y"})
        const turnedOn = as(state.settings, "mantle.work.MaintenanceSettingsServices.get#MaintenancePolicy", {organizationPartyId: orgA})
        const on = as(state.tech, W + "transcribe#CheckVoiceNote", {workEffortCheckId: checked.workEffortCheckId})
        as(state.settings, "mantle.work.MaintenanceSettingsServices.store#MaintenancePolicy", {organizationPartyId: orgA, voiceNoteTranscription: "N"})
        return {off, defaults, turnedOn, on, voice}
    },
    then({off, defaults, turnedOn, on, voice}) {
        off.transcribed == false && off.reasonCode == "TRANSCRIPTION_OFF"
        defaults.policy.voiceNoteTranscription == false
        turnedOn.policy.voiceNoteTranscription == true
        // on, the speech model is asked (none is bound here, so it answers its own reason)
        on.reasonCode != "TRANSCRIPTION_OFF"
        one("mantle.work.effort.WorkEffortContent", {workEffortContentId: voice}) != null
    }
})

// P7 review (R3): the evidence guard is the entity's, whatever the path: a check's evidence and the stored checklist are not
// updated or deleted, a check's link to its evidence stays, closed work takes no new file, a completed checklist is stored only by
// the close; ordinary work's files behave as before
feature("a check's evidence and the stored checklist cannot be deleted or changed through any path; closed work takes no new file; other work's files as before", {
    when() {
        const checklist = find("mantle.work.effort.WorkEffortContent", {workEffortId: state.wo, contentTypeEnumId: "WectCompletedChecklist"})[0]
        const link = find("mantle.work.effort.WorkEffortCheckEvidence", {workEffortContentId: state.photo})[0]
        const deleteEvidence = as(state.supervisor, "delete#mantle.work.effort.WorkEffortContent", {workEffortContentId: state.photo})
        const updateEvidence = as(state.supervisor, "update#mantle.work.effort.WorkEffortContent", {workEffortContentId: state.photo, description: "Other"})
        const deleteChecklist = as(state.supervisor, "delete#mantle.work.effort.WorkEffortContent", {workEffortContentId: checklist.workEffortContentId})
        const changeChecklist = as(state.supervisor, "mantle.work.WorkEffortServices.update#WorkEffortContent", {
            workEffortContentId: checklist.workEffortContentId,
            description: "Other"
        })
        const unlink = as(state.supervisor, "delete#mantle.work.effort.WorkEffortCheckEvidence", {
            workEffortCheckId: link.workEffortCheckId,
            workEffortContentId: state.photo
        })
        const closedFile = as(state.supervisor, "mantle.work.WorkEffortServices.create#WorkEffortContent", {
            workEffortId: state.Oil,
            contentTypeEnumId: "WectSupportingMedia",
            description: "Late photo"
        })
        const forged = as(state.supervisor, "mantle.work.WorkEffortServices.create#WorkEffortContent", {
            workEffortId: state.wo3,
            contentTypeEnumId: "WectCompletedChecklist",
            description: "Not the real one"
        })
        // an ordinary task's file is added and removed as before
        const task = call("create#mantle.work.effort.WorkEffort", {workEffortTypeEnumId: "WetTask", workEffortName: "Checklists spec plain task", statusId: "WeClosed"}).workEffortId
        const plain = call("create#mantle.work.effort.WorkEffortContent", {workEffortId: task, contentTypeEnumId: "WectSupportingMedia", description: "Plain"}).workEffortContentId
        const plainDelete = as(state.supervisor, "delete#mantle.work.effort.WorkEffortContent", {workEffortContentId: plain})
        return {deleteEvidence, updateEvidence, deleteChecklist, changeChecklist, unlink, closedFile, forged, plain, plainDelete}
    },
    then({deleteEvidence, updateEvidence, deleteChecklist, changeChecklist, unlink, closedFile, forged, plain, plainDelete}) {
        deleteEvidence == "EVIDENCE_PROTECTED"
        updateEvidence == "EVIDENCE_PROTECTED"
        deleteChecklist == "EVIDENCE_PROTECTED"
        changeChecklist == "EVIDENCE_PROTECTED"
        unlink == "EVIDENCE_PROTECTED"
        closedFile == "WORK_CLOSED"
        forged == "EVIDENCE_PROTECTED"
        one("mantle.work.effort.WorkEffortContent", {workEffortContentId: state.photo}) != null
        find("mantle.work.effort.WorkEffortCheckEvidence", {workEffortContentId: state.photo}).length == 1
        typeof plainDelete == "object"
        one("mantle.work.effort.WorkEffortContent", {workEffortContentId: plain}) == null
    }
})
