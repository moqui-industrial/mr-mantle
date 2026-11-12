// Maintenance dispatch (mantle.work.MaintenanceServices find#MaintenanceCandidates, schedule# and act#MaintenanceWorkOrder(s),
// MaintenanceSettingsServices find#MaintenanceTeams and store#MaintenanceTeamDefaults; IronStone Maintenance design §3
// AssignSchedule and BulkWork, §9 Teams, review Y4 and Y8; impl-maintenance P8): the ranked technicians of a work order (a person
// on leave in its window ranks below a free one, the expired qualification is named), the expired qualification warning on
// assignment and refused under the block policy, Start rechecking its assignees, team membership granting no permission and the
// team's defaults the settings editor's, and one refused order in a bulk assignment naming itself while the rest go on.
// Standalone: spec-local organizations, equipment, a skill and a certificate type, three employed technicians (one with an
// expired certificate, one on leave the day of the work), a team, groups and users; the services called as each user with the
// artifact check aside (their own permission and scope checks decide).
// Run: ./moq test mr-mantle --spec MaintenanceDispatch
const prefix = "MNT_DSP_SPEC"
const orgA = prefix + "_A",
    orgB = prefix + "_B",
    since = "2000-01-01T00:00:00Z"
const S = "mantle.work.MaintenanceServices."
const T = "mantle.work.MaintenanceSettingsServices."
const skill = prefix + "_SKILL",
    certificate = prefix + "_CERT",
    team = prefix + "_TEAM"
const state = {}
const day = 24 * 3600000

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
function person(partyId, firstName, organizationPartyId, relationshipTypeEnumId = "PrtEmployee") {
    call("create#mantle.party.Party", {partyId, partyTypeEnumId: "PtyPerson"})
    call("create#mantle.party.Person", {partyId, firstName, lastName: "Dispatch"})
    call("create#mantle.party.PartyRelationship", {
        relationshipTypeEnumId,
        fromPartyId: partyId,
        toPartyId: organizationPartyId,
        toRoleTypeId: relationshipTypeEnumId === "PrtEmployee" ? "OrgEmployer" : "OrgInternal",
        fromDate: since
    })
}
// a user of a spec-local group with the permissions (none for a plain account), an agent of the organization or the person given
function user(kind, permissions, organizationPartyId, partyId = null) {
    const id = prefix + "_U_" + kind
    call("create#moqui.security.UserGroup", {userGroupId: id, description: "Maintenance dispatch " + kind})
    for (const permission of permissions)
        call("create#moqui.security.UserGroupPermission", {userGroupId: id, userPermissionId: permission, fromDate: since})
    if (!partyId) {
        partyId = prefix + "_P_" + kind
        person(partyId, kind, organizationPartyId, "PrtAgent")
    }
    call("create#moqui.security.UserAccount", {
        userId: id,
        username: id,
        partyId,
        currentPassword: "16ac58bbfa332c1c55bd98b53e60720bfa90d394",
        passwordHashType: "SHA"
    })
    call("create#moqui.security.UserGroupMember", {userId: id, userGroupId: id, fromDate: since})
    return id
}
// a technician's evaluated level of the skill and a verified certificate valid until thru
function technician(partyId, firstName, thru) {
    person(partyId, firstName, orgA)
    call("create#mantle.humanres.ability.PartySkill", {
        partyId,
        skillTypeEnumId: skill,
        skillLevel: 4,
        sourceEnumId: "SksEvaluated",
        evaluatedDate: since
    })
    call("create#mantle.humanres.ability.PartyQualification", {
        partyQualificationId: partyId + "_Q",
        partyId,
        qualificationTypeEnumId: certificate,
        fromDate: since,
        thruDate: new Date(thru),
        verificationStatusId: "QlVerVerified"
    })
}
// the next weekday at least two days ahead, 08:00 in the session's zone
function workDay() {
    let at = Number(ec.user.timestampMillis(ec.user.nowTimestamp)) + 2 * day
    for (let i = 0; i < 7; i++, at += day) {
        const text = ec.l10n.format(new Date(at), "yyyy-MM-dd")
        const iso = new Date(text + "T12:00:00Z").getUTCDay()
        if (iso !== 0 && iso !== 6) return text
    }
}

spec({
    stepwise: true,
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        organization(orgA, "Dispatch Spec A")
        organization(orgB, "Dispatch Spec B")
        call("create#moqui.basic.Enumeration", {
            enumId: skill,
            enumTypeId: "SkillType",
            description: "Dispatch compressor service"
        })
        call("create#moqui.basic.Enumeration", {
            enumId: certificate,
            enumTypeId: "QualificationType",
            parentEnumId: "QualCertification",
            description: "Dispatch pressure certificate"
        })
        call("create#mantle.facility.Facility", {
            facilityId: prefix + "_SITE",
            facilityName: "Dispatch site",
            facilityTypeEnumId: "FcTpBuilding",
            ownerPartyId: orgA
        })
        call("create#mantle.facility.Facility", {
            facilityId: prefix + "_OTHER_SITE",
            facilityName: "Dispatch other site",
            facilityTypeEnumId: "FcTpBuilding",
            ownerPartyId: orgB
        })
        for (const [assetId, facilityId, ownerPartyId] of [
            [prefix + "_COMP", prefix + "_SITE", orgA],
            [prefix + "_PUMP", prefix + "_SITE", orgA],
            [prefix + "_OTHER", prefix + "_OTHER_SITE", orgB]
        ])
            call("create#mantle.product.asset.Asset", {
                assetId,
                assetTypeEnumId: "AstTpEquipment",
                assetName: assetId,
                ownerPartyId,
                facilityId
            })
        const now = Number(ec.user.timestampMillis(ec.user.nowTimestamp))
        // the three technicians: qualified, the certificate expired last month, and on leave the day of the work
        state.qualified = prefix + "_QUAL"
        state.expired = prefix + "_EXPIRED"
        state.away = prefix + "_AWAY"
        technician(state.qualified, "Qualified", now + 400 * day)
        technician(state.expired, "Expired", now - 30 * day)
        technician(state.away, "Away", now + 400 * day)
        state.day = workDay()
        const start = Number(
            ec.user.timestampMillis(ec.l10n.parseTimestamp(state.day + " 08:00:00.000", "yyyy-MM-dd HH:mm:ss.SSS"))
        )
        state.from = new Date(start)
        state.thru = new Date(start + 4 * 3600000)
        // People's approved leave as it projects it: an all-day WetTimeOff the person is on (Leave.js project)
        const leave = call("create#mantle.work.effort.WorkEffort", {
            workEffortTypeEnumId: "WetTimeOff",
            workEffortName: "Out of office",
            statusId: "WeApproved",
            ownerPartyId: state.away,
            allDayStart: state.day,
            allDayEnd: state.day,
            estimatedStartDate: new Date(start - 8 * 3600000),
            estimatedCompletionDate: new Date(start + 16 * 3600000)
        }).workEffortId
        call("create#mantle.work.effort.WorkEffortParty", {
            workEffortId: leave,
            partyId: state.away,
            roleTypeId: "Assignee",
            fromDate: since,
            statusId: "WeptAssigned"
        })
        // People's team (OrgTeam of A) with the three, the one away its lead
        call("create#mantle.party.Party", {partyId: team, partyTypeEnumId: "PtyOrganization", ownerPartyId: orgA})
        call("create#mantle.party.Organization", {partyId: team, organizationName: "Dispatch team"})
        call("create#mantle.party.PartyRole", {partyId: team, roleTypeId: "OrgTeam"})
        for (const [partyId, role] of [
            [state.qualified, "Assignee"],
            [state.expired, "Assignee"],
            [state.away, "Manager"]
        ])
            call("create#mantle.party.PartyRelationship", {
                relationshipTypeEnumId: "PrtMember",
                fromPartyId: partyId,
                fromRoleTypeId: role,
                toPartyId: team,
                toRoleTypeId: "OrgTeam",
                fromDate: since
            })
        state.planner = user("PLANNER", ["MAINTENANCE_VIEW", "MAINTENANCE_PLAN"], orgA)
        state.supervisor = user("SUPERVISOR", ["MAINTENANCE_VIEW", "MAINTENANCE_SUPERVISE", "MAINTENANCE_SETTINGS_EDIT"], orgA)
        state.otherPlanner = user("OTHER", ["MAINTENANCE_VIEW", "MAINTENANCE_PLAN"], orgB)
        // the qualified technician's own account, a technician (assigned view) and, for the away one, no Maintenance permission
        state.tech = user("TECH", ["MAINTENANCE_ASSIGNED_VIEW", "MAINTENANCE_EXECUTE"], orgA, state.qualified)
        state.member = user("MEMBER", [], orgA, state.away)
        // the compressor's service in the window, its skill at level 3 proved by the certificate; a pump job; B's work
        const made = as(state.planner, S + "create#MaintenanceWorkOrder", {
            assetId: prefix + "_COMP",
            workEffortName: "Compressor service",
            teamPartyId: team,
            estimatedWorkTime: 3,
            estimatedStartDate: state.from,
            estimatedCompletionDate: state.thru
        })
        state.compressor = made.workEffortId
        call("create#mantle.work.effort.WorkEffortSkillStandard", {
            workEffortId: state.compressor,
            skillTypeEnumId: skill,
            minimumSkillLevel: 3,
            qualificationTypeEnumId: certificate
        })
        state.pump = as(state.planner, S + "create#MaintenanceWorkOrder", {
            assetId: prefix + "_PUMP",
            workEffortName: "Pump check"
        }).workEffortId
        state.other = as(state.otherPlanner, S + "create#MaintenanceWorkOrder", {
            assetId: prefix + "_OTHER",
            workEffortName: "Not A's"
        }).workEffortId
    },
    cleanupSpec() {
        ec.message.clearErrors()
        login("john.doe")
    }
})

feature("the planner's picker ranks a technician on leave below the free ones and names the expired qualification", {
    when() {
        const found = as(state.planner, S + "find#MaintenanceCandidates", {workEffortId: state.compressor})
        const other = as(state.otherPlanner, S + "find#MaintenanceCandidates", {workEffortId: state.compressor})
        const technician = as(state.tech, S + "find#MaintenanceCandidates", {workEffortId: state.compressor})
        return {found, other, technician}
    },
    then({found, other, technician}) {
        const rows = found.candidateList
        const of = partyId => rows.find(row => row.partyId == partyId)
        const rank = partyId => rows.findIndex(row => row.partyId == partyId)
        rows[0].partyId == state.qualified
        of(state.qualified).qualificationState == "qualified" && of(state.qualified).fits == true
        of(state.qualified).onTeam == true
        of(state.qualified).skills[0].level == 4 && of(state.qualified).skills[0].meets == true
        of(state.expired).qualificationState == "expired" && of(state.expired).warns == true
        of(state.expired).qualificationText.includes("Expired")
        of(state.away).fits == false && of(state.away).freeHours == 0
        rank(state.away) > rank(state.qualified) && rank(state.away) > rank(state.expired)
        // the staffing answer only: no certificate number, issuer or file
        !JSON.stringify(rows).includes("referenceNumber")
        found.requirementList[0].minimumLevel == 3 && found.requirementList[0].qualificationTypeEnumId == certificate
        found.qualificationBlocks == false
        other == "RECORD_UNAVAILABLE"
        technician == "PERMISSION_DENIED"
    }
})

feature("assigning the expired technician warns; under the block policy it is refused and Start rechecks the assignees", {
    when() {
        const warned = as(state.planner, S + "schedule#MaintenanceWorkOrder", {
            workEffortId: state.compressor,
            assigneePartyIds: [state.expired]
        })
        const policy = as(state.supervisor, T + "store#MaintenancePolicy", {organizationPartyId: orgA, qualificationBlocks: "Y"})
        const read = as(state.supervisor, T + "get#MaintenancePolicy", {organizationPartyId: orgA}).policy
        const startBlocked = as(state.supervisor, S + "transition#MaintenanceWorkOrder", {
            workEffortId: state.compressor,
            action: "start"
        })
        const replaced = as(state.planner, S + "schedule#MaintenanceWorkOrder", {
            workEffortId: state.compressor,
            assigneePartyIds: [state.qualified]
        })
        const blocked = as(state.planner, S + "schedule#MaintenanceWorkOrder", {
            workEffortId: state.compressor,
            assigneePartyIds: [state.qualified, state.expired]
        })
        const assignees = ec.entity
            .find("mantle.work.effort.WorkEffortParty")
            .condition({workEffortId: state.compressor, roleTypeId: "Assignee"})
            .conditionDate("fromDate", "thruDate", ec.user.nowTimestamp)
            .disableAuthz()
            .list()
        const assigneeIds = Array.from(assignees).map(row => row.partyId)
        const started = as(state.supervisor, S + "transition#MaintenanceWorkOrder", {
            workEffortId: state.compressor,
            action: "start"
        })
        // the other technicians' work is not checked: the pump asks no skill
        const unchecked = as(state.planner, S + "schedule#MaintenanceWorkOrder", {
            workEffortId: state.pump,
            assigneePartyIds: [state.expired]
        })
        as(state.supervisor, T + "store#MaintenancePolicy", {organizationPartyId: orgA, qualificationBlocks: "N"})
        return {warned, policy, read, startBlocked, replaced, blocked, assignees: assigneeIds, started, unchecked}
    },
    then({warned, read, startBlocked, replaced, blocked, assignees, started, unchecked}) {
        warned.qualificationWarnings.length == 1
        warned.qualificationWarnings[0].partyId == state.expired && warned.qualificationWarnings[0].state == "expired"
        read.qualificationBlocks == true
        startBlocked == "QUALIFICATION_BLOCKED"
        replaced.qualificationWarnings.length == 0
        blocked == "QUALIFICATION_BLOCKED"
        assignees.length == 1 && assignees[0] == state.qualified
        started.statusId == "WeInProgress" && started.qualificationWarnings.length == 0
        unchecked.qualificationWarnings.length == 0
    }
})

feature("team membership grants no permission; the team is read with its members and its defaults are the settings editor's", {
    when() {
        // the away lead holds no Maintenance permission; the qualified member is a technician not assigned the pump's work
        const memberReads = as(state.member, S + "get#MaintenanceWorkOrder", {workEffortId: state.compressor})
        const memberTeams = as(state.member, T + "find#MaintenanceTeams", {})
        as(state.planner, S + "schedule#MaintenanceWorkOrder", {
            workEffortId: state.pump,
            teamPartyId: team,
            assigneePartyIds: []
        })
        const techReads = as(state.tech, S + "get#MaintenanceWorkOrder", {workEffortId: state.pump})
        const teams = as(state.planner, T + "find#MaintenanceTeams", {organizationPartyId: orgA})
        const plannerStores = as(state.planner, T + "store#MaintenanceTeamDefaults", {teamPartyId: team, intakeTag: "pumps"})
        const notMember = as(state.supervisor, T + "store#MaintenanceTeamDefaults", {
            teamPartyId: team,
            defaultAssigneePartyId: prefix + "_P_PLANNER"
        })
        const stored = as(state.supervisor, T + "store#MaintenanceTeamDefaults", {
            teamPartyId: team,
            facilityId: prefix + "_SITE",
            defaultAssigneePartyId: state.qualified,
            intakeTag: "Dispatch-Spec-Compressors"
        })
        const otherTeam = as(state.otherPlanner, T + "find#MaintenanceTeams", {teamPartyId: team})
        const otherFacility = as(state.supervisor, T + "store#MaintenanceTeamDefaults", {
            teamPartyId: team,
            facilityId: prefix + "_OTHER_SITE"
        })
        const after = as(state.planner, T + "find#MaintenanceTeams", {teamPartyId: team}).teamList[0]
        const ranked = as(state.planner, S + "find#MaintenanceCandidates", {workEffortId: state.pump}).candidateList
        return {
            memberReads,
            memberTeams,
            techReads,
            teams,
            plannerStores,
            notMember,
            stored,
            otherTeam,
            otherFacility,
            after,
            ranked
        }
    },
    then(r) {
        r.memberReads == "PERMISSION_DENIED"
        r.memberTeams == "PERMISSION_DENIED"
        r.techReads == "NOT_ASSIGNED"
        const found = r.teams.teamList.find(row => row.teamPartyId == team)
        found.memberCount == 3 && found.leadName.includes("Away")
        found.members.length == 3
        r.teams.canEdit == false
        r.plannerStores == "PERMISSION_DENIED"
        r.notMember == "ASSIGNEE_INVALID"
        r.stored.teamPartyId == team
        r.otherTeam == "RECORD_UNAVAILABLE"
        r.otherFacility == "FACILITY_INVALID"
        r.after.defaults.intakeTag == "dispatch-spec-compressors" && r.after.defaults.defaultAssigneeName.includes("Qualified")
        r.after.defaults.facilityId == prefix + "_SITE"
        r.ranked.find(row => row.partyId == state.qualified).isDefault == true
    }
})

feature("one refused work order in a bulk assignment names itself and the others are assigned", {
    when() {
        const bulk = as(state.planner, S + "act#MaintenanceWorkOrders", {
            workEffortIds: [state.pump, state.other, state.compressor],
            action: "assign",
            teamPartyId: team,
            assigneePartyIds: [state.expired]
        })
        const nothing = as(state.planner, S + "act#MaintenanceWorkOrders", {workEffortIds: [state.pump], action: "schedule"})
        const scheduled = as(state.planner, S + "act#MaintenanceWorkOrders", {
            workEffortIds: [state.pump],
            action: "schedule",
            estimatedStartDate: state.from,
            estimatedCompletionDate: state.thru
        })
        return {bulk, nothing, scheduled}
    },
    then({bulk, nothing, scheduled}) {
        bulk.successCount == 2 && bulk.failedCount == 1
        const refused = bulk.results.find(row => !row.ok)
        refused.workEffortId == state.other && refused.reasonCode == "RECORD_UNAVAILABLE"
        bulk.results.find(row => row.workEffortId == state.pump).resultCode == "ASSIGNED"
        // the compressor's assignee is now the expired technician: assigned with the warning in its result
        bulk.results.find(row => row.workEffortId == state.compressor).message.includes("Qualification warning")
        nothing == "VALUE_REQUIRED"
        scheduled.results[0].resultCode == "SCHEDULED"
    }
})
