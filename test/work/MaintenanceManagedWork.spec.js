// Managed maintenance work on the generic paths (IronStone Maintenance design §3 "Lifecycle and status authority", §13.3;
// impl-maintenance P3, F59, F63, F69): with mantle.work.maintenance.MaintenanceWorkOrder defined, People's check#ManagedWork
// refuses a work order and its steps on set#TaskStatus, update#Task, delete#WorkEffort and the WorkEffortParty writers
// (MANAGED_WORK) while an ordinary task is unchanged; CalDAV's Tasks collection leaves the steps and templates out and lists
// the work order read only, refusing a PUT or DELETE of it (403) before anything changes; Chatter's and RecordFiles' record
// check (get#RecordLinkInfo) admits a work order only as Maintenance does, not to everyone of its organization; Today leaves it
// to the app's today-source. Standalone: spec-local organization, users and work; the services as each user.
// Run: ./moq test mr-mantle --spec MaintenanceManagedWork
const prefix = "MNT_MANAGED_SPEC"
const org = prefix + "_ORG",
    since = "2000-01-01T00:00:00Z"
const state = {}
const hour = 3600000

// the call as a user (artifact authorization as given), its result or the reason code it is refused with
function as(username, service, parameters = {}, authz = false) {
    login(username)
    if (authz) ec.artifactExecution.enableAuthz()
    else ec.artifactExecution.disableAuthz()
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
function user(kind, permissions) {
    const id = prefix + "_U_" + kind
    call("create#moqui.security.UserGroup", {userGroupId: id, description: "Managed work " + kind})
    for (const permission of permissions)
        call("create#moqui.security.UserGroupPermission", {userGroupId: id, userPermissionId: permission, fromDate: since})
    const partyId = prefix + "_P_" + kind
    call("create#mantle.party.Party", {partyId, partyTypeEnumId: "PtyPerson"})
    call("create#mantle.party.Person", {partyId, firstName: "Managed work", lastName: kind})
    call("create#mantle.party.PartyRelationship", {
        relationshipTypeEnumId: "PrtAgent",
        fromPartyId: partyId,
        toPartyId: org,
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
const task = (suffix, fields) => {
    const workEffortId = prefix + "_W_" + suffix
    call(
        "create#mantle.work.effort.WorkEffort",
        Object.assign(
            {
                workEffortId,
                workEffortTypeEnumId: "WetTask",
                statusId: "WeInPlanning",
                workEffortName: "Managed work " + suffix,
                estimatedCompletionDate: new Date(Date.now() - hour)
            },
            fields
        )
    )
    return workEffortId
}
const assign = (workEffortId, partyId) =>
    call("create#mantle.work.effort.WorkEffortParty", {
        workEffortId,
        partyId,
        roleTypeId: "Assignee",
        fromDate: since,
        statusId: "WeptAssigned"
    })
const work = workEffortId =>
    ec.entity.find("mantle.work.effort.WorkEffort").condition("workEffortId", workEffortId).disableAuthz().one()
const todo = (uid, summary, status) =>
    [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "BEGIN:VTODO",
        "UID:" + uid,
        "SUMMARY:" + summary,
        "STATUS:" + status,
        "END:VTODO",
        "END:VCALENDAR",
        ""
    ].join("\r\n")

spec({
    stepwise: true,
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        call("create#mantle.party.Party", {partyId: org, partyTypeEnumId: "PtyOrganization", ownerPartyId: org})
        call("create#mantle.party.Organization", {partyId: org, organizationName: "Managed Work Spec"})
        call("create#mantle.party.PartyRole", {partyId: org, roleTypeId: "OrgInternal"})
        call("create#mantle.facility.Facility", {
            facilityId: prefix + "_SITE",
            facilityName: "Managed work site",
            facilityTypeEnumId: "FcTpBuilding",
            ownerPartyId: org
        })
        state.planner = user("PLANNER", ["MAINTENANCE_VIEW", "MAINTENANCE_PLAN"])
        state.tech = user("TECH", ["MAINTENANCE_ASSIGNED_VIEW", "MAINTENANCE_EXECUTE"])
        // one of the organization's people with no maintenance permission
        state.member = user("MEMBER", [])
        state.root = as(state.planner, "mantle.work.MaintenanceServices.create#MaintenanceWorkOrder", {
            facilityId: prefix + "_SITE",
            workEffortName: "Replace the lamps",
            estimatedCompletionDate: new Date(Date.now() - hour)
        }).workEffortId
        as(state.planner, "mantle.work.MaintenanceServices.schedule#MaintenanceWorkOrder", {
            workEffortId: state.root,
            assigneePartyIds: [state.TECH_PARTY]
        })
        ec.artifactExecution.disableAuthz()
        // the record check's and the search's services opened to the spec's users, filtered by their organizations (as PeopleChecklists does)
        call("create#moqui.security.ArtifactGroup", {artifactGroupId: prefix + "_RLI", description: "Managed work record links"})
        call("create#moqui.security.ArtifactGroupMember", {
            artifactGroupId: prefix + "_RLI",
            artifactTypeEnumId: "AT_SERVICE",
            artifactName: "mantle.party.CommunicationServices.get#RecordLinkInfo",
            nameIsPattern: "N",
            inheritAuthz: "Y"
        })
        call("create#moqui.security.ArtifactGroupMember", {
            artifactGroupId: prefix + "_RLI",
            artifactTypeEnumId: "AT_SERVICE",
            artifactName: "mantle.search.UniversalSearchServices.search#Universal",
            nameIsPattern: "N",
            inheritAuthz: "Y"
        })
        for (const kind of ["PLANNER", "TECH", "MEMBER"]) {
            const artifactAuthzId = prefix + "_RLI_" + kind
            call("create#moqui.security.ArtifactAuthz", {
                artifactAuthzId,
                userGroupId: prefix + "_U_" + kind,
                artifactGroupId: prefix + "_RLI",
                authzTypeEnumId: "AUTHZT_ALLOW",
                authzActionEnumId: "AUTHZA_ALL"
            })
            call("create#moqui.security.ArtifactAuthzFilter", {artifactAuthzId, entityFilterSetId: "MANTLE_USER_ORG"})
        }
        // a step under it (P6 instantiates them; written here as data), a template assigned to the technician and an ordinary task
        state.step = task("STEP", {parentWorkEffortId: state.root, rootWorkEffortId: state.root, purposeEnumId: "WepMaintenance"})
        state.template = task("TEMPLATE", {isTemplate: "Y", purposeEnumId: "WepMaintenance"})
        state.plain = task("PLAIN", {ownerPartyId: state.TECH_PARTY})
        for (const id of [state.step, state.template, state.plain]) assign(id, state.TECH_PARTY)
    },
    cleanupSpec() {
        ec.message.clearErrors()
        login("john.doe")
    }
})

feature("the generic task and work-effort services refuse a work order and its steps; an ordinary task is unchanged", {
    when() {
        const T = "mantle.work.TaskServices."
        return {
            rootStatus: as(state.tech, T + "set#TaskStatus", {workEffortId: state.root, statusId: "WeInProgress"}),
            stepStatus: as(state.tech, T + "set#TaskStatus", {workEffortId: state.step, statusId: "WeComplete"}),
            rootUpdate: as(state.tech, T + "update#Task", {workEffortId: state.root, workEffortName: "Renamed"}),
            rootDelete: as(state.planner, "mantle.work.WorkEffortServices.delete#WorkEffort", {workEffortId: state.root}),
            rootParty: as(state.planner, "mantle.work.WorkEffortServices.add#WorkEffortParty", {
                workEffortId: state.root,
                partyId: state.MEMBER_PARTY,
                roleTypeId: "Assignee"
            }),
            plainStatus: as(state.tech, T + "set#TaskStatus", {workEffortId: state.plain, statusId: "WeInProgress"}),
            // the maintenance flow's planned-work hold opens no move on other work: an ordinary task in planning is not held by
            // a raw update of a user without the maintenance permission (P3 review)
            rawHold: as(state.member, "update#mantle.work.effort.WorkEffort", {
                workEffortId: task("RAW", {ownerPartyId: state.MEMBER_PARTY}),
                statusId: "WeOnHold"
            })
        }
    },
    then(out) {
        String(out.rawHold).startsWith("ERROR")
        work(prefix + "_W_RAW").statusId == "WeInPlanning"
        out.rootStatus == "MANAGED_WORK"
        out.stepStatus == "MANAGED_WORK"
        out.rootUpdate == "MANAGED_WORK"
        out.rootDelete == "MANAGED_WORK"
        out.rootParty == "MANAGED_WORK"
        work(state.root).statusId == "WeApproved"
        work(state.root).workEffortName == "Replace the lamps"
        work(state.step).statusId == "WeInPlanning"
        work(state.plain).statusId == "WeInProgress"
    }
})

feature(
    "CalDAV's Tasks collection leaves out the steps and templates and lists the work order read only; a PUT or DELETE of it is refused",
    {
        when() {
            const tags = as(state.tech, "mantle.work.CalendarDavServices.get#TaskObjectTags")
            const listed = Array.from(tags.objectList || [])
            const rootObject = listed.find(object => object.workEffortId === state.root)
            const put = as(state.tech, "mantle.work.CalendarDavServices.put#DavObject", {
                collectionId: "tasks",
                objectName: rootObject.name,
                data: todo(rootObject.uid, "Done from the phone", "COMPLETED")
            })
            const removed = as(state.tech, "mantle.work.CalendarDavServices.delete#DavObject", {
                collectionId: "tasks",
                objectName: rootObject.name
            })
            const stillAssigned = ec.entity
                .find("mantle.work.effort.WorkEffortParty")
                .condition({workEffortId: state.root, partyId: state.TECH_PARTY})
                .conditionDate("fromDate", "thruDate", null)
                .disableAuthz()
                .count()
            return {listed, rootObject, put, removed, stillAssigned}
        },
        then({listed, rootObject, put, removed, stillAssigned}) {
            rootObject.readOnly == true
            !listed.some(object => object.workEffortId === state.step)
            !listed.some(object => object.workEffortId === state.template)
            listed.find(object => object.workEffortId === state.plain).readOnly == false
            put.status == 403
            removed.status == 403
            work(state.root).statusId == "WeApproved"
            stillAssigned == 1
        }
    }
)

feature(
    "Chatter's and RecordFiles' record check admits a work order as Maintenance does, not to everyone of its organization; Today leaves it to its app",
    {
        when() {
            const visible = (username, workEffortId) =>
                as(
                    username,
                    "mantle.party.CommunicationServices.get#RecordLinkInfo",
                    {recordEntityName: "mantle.work.effort.WorkEffort", recordId: workEffortId, checkOnly: true},
                    true
                ).recordVisible
            const today = as(state.tech, "mantle.work.WorkEffortServices.get#UserTodayItems")
            const todayIds = []
                .concat(Array.from(today.overdue || []), Array.from(today.dueToday || []), Array.from(today.laterToday || []))
                .map(item => item.workEffortId)
            return {
                member: visible(state.member, state.root),
                memberStep: visible(state.member, state.step),
                planner: visible(state.planner, state.root),
                tech: visible(state.tech, state.step),
                todayIds
            }
        },
        then({member, memberStep, planner, tech, todayIds}) {
            member == false
            memberStep == false
            planner == true
            tech == true
            !todayIds.includes(state.root)
            !todayIds.includes(state.step)
            todayIds.includes(state.plain)
        }
    }
)

feature("search#Universal finds a work order and its steps only for whom Maintenance admits, not for everyone of its organization", {
    when() {
        ec.artifactExecution.disableAuthz()
        for (const workEffortId of [state.root, state.step])
            ec.search.indexDocuments(ec.entity.getDataDocuments("MantleTask", {workEffortId}))
        const found = username => {
            const ids = []
            for (const q of ["lamps", "Managed"]) {
                const out = as(
                    username,
                    "mantle.search.UniversalSearchServices.search#Universal",
                    {q, entityType: "MantleTask", limit: 100, highlight: false},
                    true
                )
                if (typeof out === "string") return out
                ids.push(...Array.from(out.results || []).map(result => result.id))
            }
            return [state.root, state.step].filter(id => ids.includes(id))
        }
        return {
            available: ec.search.isAvailable(),
            member: found(state.member),
            planner: found(state.planner),
            tech: found(state.tech)
        }
    },
    then({available, member, planner, tech}) {
        available
        // the organization's member reaches neither by the organization's search limit alone
        member == []
        planner == [state.root]
        // the technician is a party of both
        tech == [state.root, state.step]
    }
})
