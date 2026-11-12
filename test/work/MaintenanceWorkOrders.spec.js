// Maintenance work orders (mantle.work.MaintenanceServices, MaintenanceSettingsServices; IronStone Maintenance design §3, §9;
// impl-maintenance P3): a planner's corrective order approved on create and planned work held for a supervisor (the hours
// threshold), Start refused to an unassigned technician, time on assigned work in progress only, Complete refused with a
// running timer and writing the entered finish, Close a supervisor's, Cancel keeping time and files, the primary
// AssetMaintenance following the root, a second claim on it refused, a retried create answering the first root, stale writes,
// and another organization's work refused as a missing one is. Standalone: spec-local organizations, a facility, equipment,
// groups and users, the services called as each user with the artifact check aside (their own permission and scope checks
// decide, as for the other apps' Mantle services).
// Run: ./moq test mr-mantle --spec MaintenanceWorkOrders
const prefix = "MNT_WO_SPEC"
const orgA = prefix + "_A",
    orgB = prefix + "_B",
    since = "2000-01-01T00:00:00Z"
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
// a user of a spec-local group with the permissions, an agent of the organization
function user(kind, permissions, organizationPartyId) {
    const id = prefix + "_U_" + kind
    call("create#moqui.security.UserGroup", {userGroupId: id, description: "Maintenance work orders " + kind})
    for (const permission of permissions)
        call("create#moqui.security.UserGroupPermission", {userGroupId: id, userPermissionId: permission, fromDate: since})
    const partyId = prefix + "_P_" + kind
    call("create#mantle.party.Party", {partyId, partyTypeEnumId: "PtyPerson"})
    call("create#mantle.party.Person", {partyId, firstName: "Work orders", lastName: kind})
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
const work = workEffortId =>
    ec.entity.find("mantle.work.effort.WorkEffort").condition("workEffortId", workEffortId).disableAuthz().one()
const order = workEffortId =>
    ec.entity.find("mantle.work.maintenance.MaintenanceWorkOrder").condition("workEffortId", workEffortId).disableAuthz().one()
const maintenanceStatus = assetMaintenanceId =>
    ec.entity
        .find("mantle.product.maintenance.AssetMaintenance")
        .condition("assetMaintenanceId", assetMaintenanceId)
        .disableAuthz()
        .one()?.statusId
const revision = workEffortId => Number(order(workEffortId).revision)

spec({
    stepwise: true,
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        organization(orgA, "Work Orders Spec A")
        organization(orgB, "Work Orders Spec B")
        call("create#mantle.facility.Facility", {
            facilityId: prefix + "_SITE",
            facilityName: "Work orders site",
            facilityTypeEnumId: "FcTpBuilding",
            ownerPartyId: orgA
        })
        call("create#mantle.facility.Facility", {
            facilityId: prefix + "_ROOM",
            facilityName: "Work orders room",
            facilityTypeEnumId: "FcTpRoom",
            parentFacilityId: prefix + "_SITE"
        })
        call("create#mantle.facility.Facility", {
            facilityId: prefix + "_OTHER",
            facilityName: "Work orders other site",
            facilityTypeEnumId: "FcTpBuilding",
            ownerPartyId: orgB
        })
        for (const [assetId, facilityId, ownerPartyId] of [
            [prefix + "_PUMP", prefix + "_SITE", orgA],
            [prefix + "_FAN", prefix + "_SITE", orgA],
            [prefix + "_OTHER_PUMP", prefix + "_OTHER", orgB]
        ])
            call("create#mantle.product.asset.Asset", {
                assetId,
                assetTypeEnumId: "AstTpEquipment",
                assetName: assetId,
                ownerPartyId,
                facilityId
            })
        state.planner = user("PLANNER", ["MAINTENANCE_VIEW", "MAINTENANCE_PLAN"], orgA)
        state.supervisor = user("SUPERVISOR", ["MAINTENANCE_VIEW", "MAINTENANCE_SUPERVISE", "MAINTENANCE_SETTINGS_EDIT"], orgA)
        state.tech = user("TECH", ["MAINTENANCE_ASSIGNED_VIEW", "MAINTENANCE_EXECUTE"], orgA)
        state.tech2 = user("TECH2", ["MAINTENANCE_ASSIGNED_VIEW", "MAINTENANCE_EXECUTE"], orgA)
        state.otherPlanner = user("OTHER", ["MAINTENANCE_VIEW", "MAINTENANCE_PLAN"], orgB)
        // a team of A
        call("create#mantle.party.Party", {partyId: prefix + "_TEAM", partyTypeEnumId: "PtyOrganization", ownerPartyId: orgA})
        call("create#mantle.party.Organization", {partyId: prefix + "_TEAM", organizationName: "Work orders team"})
        call("create#mantle.party.PartyRole", {partyId: prefix + "_TEAM", roleTypeId: "OrgTeam"})
    },
    cleanupSpec() {
        ec.message.clearErrors()
        login("john.doe")
    }
})

feature("a planner's corrective order is approved on create; planned work over the threshold waits for a supervisor", {
    when() {
        const corrective = as(state.planner, S + "create#MaintenanceWorkOrder", {
            assetId: prefix + "_PUMP",
            workEffortName: "Pump leaks",
            teamPartyId: prefix + "_TEAM",
            operationKey: prefix + "-corrective"
        })
        state.corrective = corrective.workEffortId
        const planned = as(state.planner, S + "create#MaintenanceWorkOrder", {
            assetId: prefix + "_FAN",
            workEffortName: "Fan service",
            maintenanceKindEnumId: "MkPreventive",
            estimatedWorkTime: 2
        })
        state.planned = planned.workEffortId
        const plannerApproves = as(state.planner, S + "transition#MaintenanceWorkOrder", {
            workEffortId: state.planned,
            action: "approve"
        })
        const supervisorApproves = as(state.supervisor, S + "transition#MaintenanceWorkOrder", {
            workEffortId: state.planned,
            action: "approve"
        })
        // a threshold of four hours: two hours of planned work is approved on create
        const policy = as(state.supervisor, "mantle.work.MaintenanceSettingsServices.store#MaintenancePolicy", {
            organizationPartyId: orgA,
            approvalThresholdHours: 4
        })
        const within = as(state.planner, S + "create#MaintenanceWorkOrder", {
            facilityId: prefix + "_ROOM",
            workEffortName: "Room filter change",
            maintenanceKindEnumId: "MkPreventive",
            estimatedWorkTime: 2
        })
        const noEstimate = as(state.planner, S + "create#MaintenanceWorkOrder", {
            facilityId: prefix + "_ROOM",
            workEffortName: "Room survey",
            maintenanceKindEnumId: "MkPreventive"
        })
        state.room = within.workEffortId
        const read = as(state.supervisor, "mantle.work.MaintenanceSettingsServices.get#MaintenancePolicy", {
            organizationPartyId: orgA
        })
        return {corrective, planned, plannerApproves, supervisorApproves, policy, within, noEstimate, read}
    },
    then({corrective, planned, plannerApproves, supervisorApproves, within, noEstimate, read}) {
        corrective.statusId == "WeApproved"
        work(state.corrective).purposeEnumId == "WepMaintenance"
        work(state.corrective).ownerPartyId == orgA
        work(state.corrective).facilityId == prefix + "_SITE"
        work(state.corrective).rootWorkEffortId == null
        order(state.corrective).maintenanceKindEnumId == "MkCorrective"
        maintenanceStatus(corrective.assetMaintenanceId) == "AsMntCreated"
        planned.statusId == "WeInPlanning"
        plannerApproves == "APPROVAL_REQUIRED"
        supervisorApproves.statusId == "WeApproved"
        within.statusId == "WeApproved"
        within.assetMaintenanceId == null
        work(state.room).facilityId == prefix + "_ROOM"
        noEstimate.statusId == "WeInPlanning"
        read.policy.approvalThresholdHours == 4
        read.policy.closurePolicyEnumId == "MclSupervisor"
    }
})

feature(
    "a retried create answers the first root; changed input under the key, a stale write and another organization's work are refused",
    {
        when() {
            const retry = as(state.planner, S + "create#MaintenanceWorkOrder", {
                assetId: prefix + "_PUMP",
                workEffortName: "Pump leaks",
                teamPartyId: prefix + "_TEAM",
                operationKey: prefix + "-corrective"
            })
            const changed = as(state.planner, S + "create#MaintenanceWorkOrder", {
                assetId: prefix + "_PUMP",
                workEffortName: "Pump leaks badly",
                operationKey: prefix + "-corrective"
            })
            const stale = as(state.planner, S + "store#MaintenanceWorkOrder", {
                workEffortId: state.corrective,
                expectedRevision: 0,
                priority: 2
            })
            const stored = as(state.planner, S + "store#MaintenanceWorkOrder", {
                workEffortId: state.corrective,
                expectedRevision: revision(state.corrective),
                priority: 2
            })
            const otherReads = as(state.otherPlanner, S + "get#MaintenanceWorkOrder", {workEffortId: state.corrective})
            const otherTarget = as(state.planner, S + "create#MaintenanceWorkOrder", {
                assetId: prefix + "_OTHER_PUMP",
                workEffortName: "Not ours"
            })
            const missing = as(state.planner, S + "get#MaintenanceWorkOrder", {workEffortId: prefix + "_NONE"})
            const listed = as(state.otherPlanner, S + "find#MaintenanceWorkOrders", {statusId: "all"})
            return {retry, changed, stale, stored, otherReads, otherTarget, missing, listed}
        },
        then({retry, changed, stale, stored, otherReads, otherTarget, missing, listed}) {
            retry.workEffortId == state.corrective
            retry.repeated == true
            changed == "OPERATION_KEY_CONFLICT"
            stale == "RECORD_CHANGED"
            stored.revision > 1
            work(state.corrective).priority == 2
            otherReads == "RECORD_UNAVAILABLE"
            otherTarget == "RECORD_UNAVAILABLE"
            missing == "RECORD_UNAVAILABLE"
            !listed.workOrderList.some(row => row.workEffortId == state.corrective)
        }
    }
)

feature("Start is refused to an unassigned technician; assigned, they start it and record their own time on it in progress", {
    when() {
        const unassignedReads = as(state.tech, S + "get#MaintenanceWorkOrder", {workEffortId: state.corrective})
        const unassignedStarts = as(state.tech, S + "transition#MaintenanceWorkOrder", {
            workEffortId: state.corrective,
            action: "start"
        })
        const outsider = as(state.planner, S + "schedule#MaintenanceWorkOrder", {
            workEffortId: state.corrective,
            assigneePartyIds: [state.OTHER_PARTY]
        })
        const scheduled = as(state.planner, S + "schedule#MaintenanceWorkOrder", {
            workEffortId: state.corrective,
            expectedRevision: revision(state.corrective),
            assigneePartyIds: [state.TECH_PARTY],
            estimatedStartDate: new Date(Date.now() - 4 * hour),
            estimatedCompletionDate: new Date(Date.now() + 4 * hour)
        })
        const maintenanceScheduled = maintenanceStatus(order(state.corrective).assetMaintenanceId)
        const timeBefore = as(state.tech, S + "record#MaintenanceTime", {
            workEffortId: state.corrective,
            fromDate: new Date(Date.now() - 3 * hour),
            hours: 1
        })
        const otherTech = as(state.tech2, S + "transition#MaintenanceWorkOrder", {
            workEffortId: state.corrective,
            action: "start"
        })
        const started = as(state.tech, S + "transition#MaintenanceWorkOrder", {
            workEffortId: state.corrective,
            action: "start",
            actualStartDate: new Date(Date.now() - 3 * hour)
        })
        const time = as(state.tech, S + "record#MaintenanceTime", {
            workEffortId: state.corrective,
            fromDate: new Date(Date.now() - 3 * hour),
            thruDate: new Date(Date.now() - 2 * hour),
            comments: "Found the leak"
        })
        const read = as(state.tech, S + "get#MaintenanceWorkOrder", {workEffortId: state.corrective})
        return {
            unassignedReads,
            unassignedStarts,
            outsider,
            scheduled,
            maintenanceScheduled,
            timeBefore,
            otherTech,
            started,
            time,
            read
        }
    },
    then({
        unassignedReads,
        unassignedStarts,
        outsider,
        scheduled,
        maintenanceScheduled,
        timeBefore,
        otherTech,
        started,
        time,
        read
    }) {
        unassignedReads == "NOT_ASSIGNED"
        unassignedStarts == "NOT_ASSIGNED"
        outsider == "ASSIGNEE_UNAVAILABLE"
        scheduled.addedPartyIds == [state.TECH_PARTY]
        maintenanceScheduled == "AsMntScheduled"
        timeBefore == "WORK_NOT_STARTED"
        otherTech == "NOT_ASSIGNED"
        started.statusId == "WeInProgress"
        maintenanceStatus(order(state.corrective).assetMaintenanceId) == "AsMntInProcess"
        !!time.timeEntryId
        read.workOrder.statusText == "In Progress"
        read.timeEntryList.length == 1
        read.ownHours == 1
        // a technician sees their own time, not the team's total
        read.totalHours == null
        read.assignmentList.some(row => row.partyId == state.TECH_PARTY && row.roleText == "Technician")
        read.assignmentList.some(row => row.partyId == prefix + "_TEAM" && row.roleText == "Team")
    }
})

feature("Complete is refused with a running timer and writes the entered finish; a supervisor closes the work", {
    when() {
        const timer = as(state.tech, S + "start#MaintenanceTimer", {workEffortId: state.corrective})
        const withTimer = as(state.tech, S + "transition#MaintenanceWorkOrder", {
            workEffortId: state.corrective,
            action: "complete",
            outcomeEnumId: "MoutRepaired",
            dispositionEnumId: "MdispAvailable"
        })
        const stopped = as(state.tech, S + "stop#MaintenanceTimer", {workEffortId: state.corrective})
        const noDisposition = as(state.tech, S + "transition#MaintenanceWorkOrder", {
            workEffortId: state.corrective,
            action: "complete",
            outcomeEnumId: "MoutRepaired"
        })
        state.finish = Date.now() - hour
        const completed = as(state.tech, S + "transition#MaintenanceWorkOrder", {
            workEffortId: state.corrective,
            action: "complete",
            outcomeEnumId: "MoutRepaired",
            dispositionEnumId: "MdispAvailable",
            actualCompletionDate: new Date(state.finish)
        })
        const techCloses = as(state.tech, S + "transition#MaintenanceWorkOrder", {
            workEffortId: state.corrective,
            action: "close"
        })
        const closed = as(state.supervisor, S + "transition#MaintenanceWorkOrder", {
            workEffortId: state.corrective,
            action: "close"
        })
        const afterClose = as(state.tech, S + "record#MaintenanceTime", {
            workEffortId: state.corrective,
            fromDate: new Date(Date.now() - 2 * hour),
            hours: 1
        })
        return {timer, withTimer, stopped, noDisposition, completed, techCloses, closed, afterClose}
    },
    then({timer, withTimer, stopped, noDisposition, completed, techCloses, closed, afterClose}) {
        !!timer.timeEntryId
        withTimer == "TIMER_RUNNING"
        stopped.timeEntryId == timer.timeEntryId
        noDisposition == "DISPOSITION_REQUIRED"
        completed.resultCode == "COMPLETED"
        Number(String(work(state.corrective).actualCompletionDate)) == state.finish
        order(state.corrective).outcomeEnumId == "MoutRepaired"
        maintenanceStatus(order(state.corrective).assetMaintenanceId) == "AsMntCompleted"
        techCloses == "PERMISSION_DENIED"
        closed.statusId == "WeClosed"
        afterClose == "WORK_NOT_STARTED"
    }
})

feature("Cancel keeps the work's time and files; a planner may not cancel started work, a supervisor may with a reason", {
    when() {
        as(state.supervisor, S + "schedule#MaintenanceWorkOrder", {
            workEffortId: state.planned,
            assigneePartyIds: [state.TECH2_PARTY]
        })
        as(state.tech2, S + "transition#MaintenanceWorkOrder", {workEffortId: state.planned, action: "start"})
        as(state.tech2, S + "record#MaintenanceTime", {
            workEffortId: state.planned,
            fromDate: new Date(Date.now() - 2 * hour),
            hours: 1
        })
        ec.artifactExecution.disableAuthz()
        call("create#mantle.work.effort.WorkEffortContent", {
            workEffortId: state.planned,
            contentLocation: "dbresource://spec/maintenance/fan-photo.txt",
            contentDate: ec.user.nowTimestamp
        })
        const plannerCancels = as(state.planner, S + "transition#MaintenanceWorkOrder", {
            workEffortId: state.planned,
            action: "cancel",
            cancelReasonEnumId: "McrNotNeeded"
        })
        const noReason = as(state.supervisor, S + "transition#MaintenanceWorkOrder", {
            workEffortId: state.planned,
            action: "cancel"
        })
        const cancelled = as(state.supervisor, S + "transition#MaintenanceWorkOrder", {
            workEffortId: state.planned,
            action: "cancel",
            cancelReasonEnumId: "McrNotNeeded"
        })
        ec.artifactExecution.disableAuthz()
        const timeKept = ec.entity.find("mantle.work.time.TimeEntry").condition("workEffortId", state.planned).count()
        const filesKept = ec.entity.find("mantle.work.effort.WorkEffortContent").condition("workEffortId", state.planned).count()
        return {plannerCancels, noReason, cancelled, timeKept, filesKept}
    },
    then({plannerCancels, noReason, cancelled, timeKept, filesKept}) {
        plannerCancels == "PERMISSION_DENIED"
        noReason == "REASON_REQUIRED"
        cancelled.statusId == "WeCancelled"
        maintenanceStatus(order(state.planned).assetMaintenanceId) == "AsMntCancelled"
        timeKept == 1
        filesKept == 1
    }
})

feature("approved work is held by a supervisor with a reason and resumes where it was; a planner may not hold it", {
    when() {
        const plannerHolds = as(state.planner, S + "transition#MaintenanceWorkOrder", {
            workEffortId: state.room,
            action: "hold",
            holdReasonEnumId: "MhrParts"
        })
        const noReason = as(state.supervisor, S + "transition#MaintenanceWorkOrder", {workEffortId: state.room, action: "hold"})
        const held = as(state.supervisor, S + "transition#MaintenanceWorkOrder", {
            workEffortId: state.room,
            action: "hold",
            holdReasonEnumId: "MhrParts"
        })
        const heldFrom = order(state.room).holdFromStatusId
        const resumed = as(state.supervisor, S + "transition#MaintenanceWorkOrder", {workEffortId: state.room, action: "resume"})
        return {plannerHolds, noReason, held, heldFrom, resumed}
    },
    then({plannerHolds, noReason, held, heldFrom, resumed}) {
        plannerHolds == "PERMISSION_DENIED"
        noReason == "REASON_REQUIRED"
        held.statusId == "WeOnHold"
        heldFrom == "WeApproved"
        resumed.statusId == "WeApproved"
        order(state.room).holdReasonEnumId == null
    }
})

feature(
    "an AssetMaintenance has one work order: adoption makes it once, and closed history or one linked to other work is refused",
    {
        when() {
            ec.artifactExecution.disableAuthz()
            const open = call("mantle.product.EquipmentServices.create#AssetMaintenance", {
                assetId: prefix + "_FAN",
                statusId: "AsMntCreated",
                maintenanceTypeEnumId: "MntTpCorrective",
                comments: "Fan rattles"
            }).assetMaintenanceId
            const done = call("mantle.product.EquipmentServices.create#AssetMaintenance", {
                assetId: prefix + "_FAN",
                statusId: "AsMntCreated",
                comments: "Old service"
            }).assetMaintenanceId
            call("update#mantle.product.maintenance.AssetMaintenance", {assetMaintenanceId: done, statusId: "AsMntInProcess"})
            call("update#mantle.product.maintenance.AssetMaintenance", {assetMaintenanceId: done, statusId: "AsMntCompleted"})
            const adopted = as(state.planner, S + "adopt#MaintenanceRecord", {assetMaintenanceId: open})
            const again = as(state.supervisor, S + "adopt#MaintenanceRecord", {assetMaintenanceId: open})
            const closed = as(state.planner, S + "adopt#MaintenanceRecord", {assetMaintenanceId: done})
            // the primary AssetMaintenance of one work order is not taken by another
            const primary = as(state.planner, S + "adopt#MaintenanceRecord", {
                assetMaintenanceId: order(state.planned).assetMaintenanceId
            })
            ec.artifactExecution.disableAuthz()
            const linked = call("mantle.product.EquipmentServices.create#AssetMaintenance", {
                assetId: prefix + "_FAN",
                statusId: "AsMntCreated",
                taskWorkEffortId: state.room,
                comments: "Linked elsewhere"
            }).assetMaintenanceId
            const linkedAdopt = as(state.planner, S + "adopt#MaintenanceRecord", {assetMaintenanceId: linked})
            return {open, adopted, again, closed, primary, linkedAdopt}
        },
        then({open, adopted, again, closed, primary, linkedAdopt}) {
            adopted.statusId == "WeApproved"
            adopted.repeated == false
            order(adopted.workEffortId).assetMaintenanceId == open
            order(adopted.workEffortId).sourceEnumId == "MsrcAdopted"
            again.workEffortId == adopted.workEffortId
            again.repeated == true
            closed == "RECORD_CLOSED"
            primary.workEffortId == state.planned
            primary.repeated == true
            linkedAdopt == "LINKED_WORK"
        }
    }
)
