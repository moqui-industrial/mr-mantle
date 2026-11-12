// Maintenance's work status report (mantle.work.MaintenanceReportServices.get#MaintenanceStatusReport; IronStone Maintenance
// design §8 WorkStatusReport; impl-maintenance P17): over execution roots only (a procedure's template root and a process step are
// not counted); opened, completed, cancelled in the period and the backlog, overdue and unassigned at the as-of time, each from
// the root's status audit; an order completed, reopened and completed again counts once, a completion reopened and still open is
// backlog, and completed again after the period's start counts in that period (review R1: by its last completion, not its first);
// overdue is past its required completion, never unscheduled; as of before the work existed nothing counts; another
// organization's roots are left out and asked for by name refused; a technician's assigned view reads none of it. Standalone:
// spec-local organizations, a site, a team, users and work orders made through the work order services as each user.
// Run: ./moq test mr-mantle --spec MaintenanceReports
const prefix = "MNT_RPT"
const orgA = prefix + "_A",
    orgB = prefix + "_B",
    site = prefix + "_SITE",
    team = prefix + "_TEAM",
    since = "2000-01-01T00:00:00Z"
const S = "mantle.work.MaintenanceServices."
const R = "mantle.work.MaintenanceReportServices.get#MaintenanceStatusReport"
const WORK = "mantle.work.effort.WorkEffort"
const {ms} = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const state = {}

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
function organization(partyId) {
    call("create#mantle.party.Party", {partyId, partyTypeEnumId: "PtyOrganization", ownerPartyId: partyId})
    call("create#mantle.party.Organization", {partyId, organizationName: partyId})
    call("create#mantle.party.PartyRole", {partyId, roleTypeId: "OrgInternal"})
}
function user(kind, permissions, organizationPartyId = orgA) {
    const id = prefix + "_U_" + kind
    call("create#moqui.security.UserGroup", {userGroupId: id, description: "Reports " + kind})
    for (const permission of permissions)
        call("create#moqui.security.UserGroupPermission", {userGroupId: id, userPermissionId: permission, fromDate: since})
    const partyId = prefix + "_P_" + kind
    call("create#mantle.party.Party", {partyId, partyTypeEnumId: "PtyPerson"})
    call("create#mantle.party.Person", {partyId, firstName: "Reports", lastName: kind})
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
// a facility work order of the site, made by the planner (corrective: approved on create)
function work(name, extra = {}) {
    return as(state.planner, S + "create#MaintenanceWorkOrder", Object.assign({facilityId: site, workEffortName: name}, extra))
        .workEffortId
}
const move = (workEffortId, action, extra = {}) =>
    as(state.supervisor, S + "transition#MaintenanceWorkOrder", Object.assign({workEffortId, action}, extra))
const complete = workEffortId =>
    move(workEffortId, "complete", {outcomeEnumId: "MoutRepaired", dispositionEnumId: "MdispAvailable"})
// a reopening by a baseline path: the status set back, audited as any change of it is
function reopen(workEffortId) {
    ec.entity.find(WORK).condition("workEffortId", workEffortId).disableAuthz().one().set("statusId", "WeInProgress").update()
}
const report = (username, parameters = {}) => as(username, R, Object.assign({fromDate: state.from}, parameters))

spec({
    stepwise: true,
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        state.from = new Date(Date.now() - 60000)
        organization(orgA)
        organization(orgB)
        call("create#mantle.facility.Facility", {
            facilityId: site,
            facilityTypeEnumId: "FcTpBuilding",
            facilityName: "Report site",
            ownerPartyId: orgA
        })
        call("create#mantle.facility.Facility", {
            facilityId: prefix + "_OTHER",
            facilityTypeEnumId: "FcTpBuilding",
            facilityName: "Other site",
            ownerPartyId: orgB
        })
        call("create#mantle.party.Party", {partyId: team, partyTypeEnumId: "PtyOrganization", ownerPartyId: orgA})
        call("create#mantle.party.Organization", {partyId: team, organizationName: "Report team"})
        call("create#mantle.party.PartyRole", {partyId: team, roleTypeId: "OrgTeam"})
        state.reader = user("READER", ["MAINTENANCE_VIEW"])
        state.planner = user("PLANNER", ["MAINTENANCE_VIEW", "MAINTENANCE_PLAN"])
        state.supervisor = user("SUPERVISOR", ["MAINTENANCE_VIEW", "MAINTENANCE_SUPERVISE"])
        state.tech = user("TECH", ["MAINTENANCE_ASSIGNED_VIEW", "MAINTENANCE_EXECUTE"])
        state.otherPlanner = user("OTHER", ["MAINTENANCE_VIEW", "MAINTENANCE_PLAN"], orgB)
    },
    cleanupSpec() {
        ec.message.clearErrors()
        login("john.doe")
    }
})

feature(
    "the period's work orders: opened, completed once, cancelled, and the backlog, overdue and unassigned at the as-of time",
    {
        when() {
            // done: the team's, its technician's, completed
            state.done = work("Door closer", {teamPartyId: team})
            as(state.planner, S + "schedule#MaintenanceWorkOrder", {
                workEffortId: state.done,
                assigneePartyIds: [state.TECH_PARTY]
            })
            move(state.done, "start")
            complete(state.done)
            // twice: completed, reopened and completed again, which counts once
            state.twice = work("Window latch")
            move(state.twice, "start")
            complete(state.twice)
            reopen(state.twice)
            complete(state.twice)
            // reopened: completed, then reopened and still open: backlog, not a completion
            state.reopened = work("Ceiling tile")
            move(state.reopened, "start")
            complete(state.reopened)
            reopen(state.reopened)
            // cancelled
            state.cancelled = work("Paint touch-up")
            move(state.cancelled, "cancel", {cancelReasonEnumId: "McrNotNeeded"})
            // unscheduled and unassigned: backlog, not overdue
            state.unscheduled = work("Loose handrail")
            // past its required completion, assigned: overdue
            state.late = work("Leaking tap")
            as(state.planner, S + "schedule#MaintenanceWorkOrder", {
                workEffortId: state.late,
                assigneePartyIds: [state.TECH_PARTY]
            })
            ec.entity
                .find(WORK)
                .condition("workEffortId", state.late)
                .disableAuthz()
                .one()
                .set("estimatedCompletionDate", new Date(Date.now() - 3600000))
                .update()
            // not counted: a procedure's template root with a work order row, a process step of the done order, another organization's
            call("create#mantle.work.effort.WorkEffort", {
                workEffortId: prefix + "_TEMPLATE",
                workEffortTypeEnumId: "WetTask",
                workEffortName: "Template",
                ownerPartyId: orgA,
                facilityId: site,
                isTemplate: "Y",
                statusId: "WeInPlanning"
            })
            call("create#mantle.work.maintenance.MaintenanceWorkOrder", {workEffortId: prefix + "_TEMPLATE"})
            call("create#mantle.work.effort.WorkEffort", {
                workEffortId: prefix + "_STEP",
                workEffortTypeEnumId: "WetTask",
                workEffortName: "Step",
                parentWorkEffortId: state.done,
                rootWorkEffortId: state.done,
                ownerPartyId: orgA,
                facilityId: site,
                statusId: "WeInPlanning"
            })
            state.other = as(state.otherPlanner, S + "create#MaintenanceWorkOrder", {
                facilityId: prefix + "_OTHER",
                workEffortName: "Other organization's"
            }).workEffortId
            return {
                all: report(state.reader, {pageSize: 50}),
                completed: report(state.reader, {measure: "completed"}),
                byState: report(state.reader, {groupBy: "state"})
            }
        },
        then({all, completed, byState}) {
            const counted = all.statusList.map(row => row.workEffortId)
            all.summary.openedCount == 6
            all.summary.completedCount == 2
            all.summary.cancelledCount == 1
            all.summary.backlogCount == 3
            all.summary.overdueCount == 1
            all.summary.unassignedCount == 2
            all.summary.capped == false
            !counted.includes(prefix + "_TEMPLATE")
            !counted.includes(prefix + "_STEP")
            !counted.includes(state.other)
            completed.statusList.map(row => row.workEffortId).sort() == [state.done, state.twice].sort()
            all.statusList.find(row => row.workEffortId === state.reopened).backlog == true
            all.statusList.find(row => row.workEffortId === state.reopened).completed == false
            all.statusList.find(row => row.workEffortId === state.unscheduled).overdue == false
            all.statusList.find(row => row.workEffortId === state.late).overdue == true
            // by team (the default): the team's one completion, the rest with no team
            const teamGroup = all.groupList.find(group => group.groupKey === team)
            teamGroup.groupText == "Report team"
            teamGroup.completedCount == 1
            all.groupList.find(group => group.groupKey === "_none").backlogCount == 3
            byState.groupList.find(group => group.groupKey === "WeCancelled").cancelledCount == 1
            !JSON.stringify(all).includes("amount")
        }
    }
)

feature("as of before the work existed nothing counts; a group's rows; another organization refused, a technician refused", {
    when() {
        return {
            before: report(state.reader, {thruDate: state.from}),
            teamRows: report(state.reader, {groupKey: team}),
            otherReads: report(state.otherPlanner),
            named: report(state.reader, {organizationPartyId: orgB}),
            tech: report(state.tech),
            badMeasure: report(state.reader, {measure: "cost"})
        }
    },
    then({before, teamRows, otherReads, named, tech, badMeasure}) {
        before.summary.openedCount == 0
        before.summary.backlogCount == 0
        before.statusList.length == 0
        teamRows.statusList.map(row => row.workEffortId) == [state.done]
        // B's planner reads only B's order
        otherReads.statusList.map(row => row.workEffortId) == [state.other]
        named == "ORGANIZATION_DENIED"
        tech == "PERMISSION_DENIED"
        badMeasure == "VALUE_INVALID"
    }
})

// Review R1: a completion reopened before the period began and completed again in it counts in the period, by the completion in
// force at the as-of time; the earlier period, whose end saw the order open, counts none of it
feature("an order completed, reopened before the period and completed again in it counts in the period", {
    when() {
        // the period starts after the reopening of state.reopened (its last status audit) and before its completion
        const reopenedAt = Math.max(
            ...Array.from(
                ec.entity
                    .find("moqui.entity.EntityAuditLog")
                    .condition({changedEntityName: WORK, changedFieldName: "statusId", pkPrimaryValue: state.reopened})
                    .disableAuthz()
                    .list()
            ).map(row => ms(row.changedDate))
        )
        const periodStart = new Date(reopenedAt + 1)
        while (Date.now() <= reopenedAt + 5) {
            // wait for the clock to pass the period's start
        }
        complete(state.reopened)
        return {
            period: report(state.reader, {fromDate: periodStart, measure: "completed"}),
            earlier: report(state.reader, {thruDate: periodStart, measure: "completed"})
        }
    },
    then({period, earlier}) {
        period.statusList.map(row => row.workEffortId).includes(state.reopened)
        !earlier.statusList.map(row => row.workEffortId).includes(state.reopened)
    }
})
