// Maintenance intake (mantle.work.MaintenanceServices report#MaintenanceProblem, find#MaintenanceRequests, triage#MaintenanceRequest,
// create#MaintenanceRequestFromEmail, find#UnmanagedMaintenance; the production handoff of request#ProductionMaintenance; IronStone
// Maintenance design §3 Requests, §1.4 Mail intake; impl-maintenance P4): a requester reports with one target and reads only
// their own requests, a safe summary; two targets are refused (the report and link#RequestRecord); triage twice links one order and
// a second report joins it; a rejected report keeps its reason; a mail to a team's plus-tag address makes one request with the
// sender as reporter and no target left for triage; request#ProductionMaintenance twice makes one root under the policy; the
// triage notice goes to the organization's planners; complete#RequestFromWork moves nothing for a work order (F27). Standalone:
// spec-local organizations, facilities, equipment, groups and users, the services called as each user with the artifact check
// aside (their own permission and scope checks decide).
// Run: ./moq test mr-mantle --spec MaintenanceIntake
const prefix = "MNT_IN_SPEC"
const orgA = prefix + "_A",
    orgB = prefix + "_B",
    since = "2000-01-01T00:00:00Z"
const S = "mantle.work.MaintenanceServices."
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
function organization(partyId, name) {
    call("create#mantle.party.Party", {partyId, partyTypeEnumId: "PtyOrganization", ownerPartyId: partyId})
    call("create#mantle.party.Organization", {partyId, organizationName: name})
    call("create#mantle.party.PartyRole", {partyId, roleTypeId: "OrgInternal"})
}
// a user of a spec-local group with the permissions, an agent of the organization
function user(kind, permissions, organizationPartyId) {
    const id = prefix + "_U_" + kind
    call("create#moqui.security.UserGroup", {userGroupId: id, description: "Maintenance intake " + kind})
    for (const permission of permissions)
        call("create#moqui.security.UserGroupPermission", {userGroupId: id, userPermissionId: permission, fromDate: since})
    const partyId = prefix + "_P_" + kind
    call("create#mantle.party.Party", {partyId, partyTypeEnumId: "PtyPerson"})
    call("create#mantle.party.Person", {partyId, firstName: "Intake", lastName: kind})
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
const one = (entityName, fields) => ec.entity.find(entityName).condition(fields).disableAuthz().one()
const rows = (entityName, fields) => Array.from(ec.entity.find(entityName).condition(fields).disableAuthz().list())
const request = requestId => one("mantle.request.Request", {requestId})
const ids = list => Array.from(list || []).map(row => row.requestId)
const rowOf = (list, requestId) => Array.from(list || []).find(row => row.requestId === requestId) || {}
let messageCount = 0
function receive(fields) {
    messageCount++
    const id = prefix + "_MSG" + messageCount
    call(
        "store#moqui.basic.email.EmailMessage",
        Object.assign(
            {
                emailMessageId: id,
                statusId: "ES_RECEIVED",
                contentType: "text/plain",
                messageDate: ec.user.nowTimestamp,
                receivedDate: ec.user.nowTimestamp,
                isRead: "N",
                hasAttachment: "N",
                fromAddress: "dock.worker@intake.example",
                fromName: "Dock Worker",
                messageId: "<mnt-in-" + messageCount + "@intake.example>",
                rootEmailMessageId: id
            },
            fields
        )
    )
    return id
}

spec({
    stepwise: true,
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        organization(orgA, "Intake Spec A")
        organization(orgB, "Intake Spec B")
        call("create#mantle.facility.Facility", {
            facilityId: prefix + "_SITE",
            facilityName: "Intake site",
            facilityTypeEnumId: "FcTpPlant",
            ownerPartyId: orgA
        })
        call("create#mantle.facility.Facility", {
            facilityId: prefix + "_ROOM",
            facilityName: "Intake room",
            facilityTypeEnumId: "FcTpRoom",
            parentFacilityId: prefix + "_SITE"
        })
        call("create#mantle.facility.Facility", {
            facilityId: prefix + "_OTHER",
            facilityName: "Intake other site",
            facilityTypeEnumId: "FcTpBuilding",
            ownerPartyId: orgB
        })
        for (const [assetId, facilityId, ownerPartyId] of [
            [prefix + "_PUMP", prefix + "_SITE", orgA],
            [prefix + "_PRESS", prefix + "_SITE", orgA],
            [prefix + "_OTHER_PUMP", prefix + "_OTHER", orgB]
        ])
            call("create#mantle.product.asset.Asset", {
                assetId,
                assetTypeEnumId: "AstTpEquipment",
                assetName: assetId,
                ownerPartyId,
                facilityId
            })
        state.requester = user("REQ", ["MAINTENANCE_REQUEST", "MAINTENANCE_REQUEST_VIEW_OWN"], orgA)
        state.requester2 = user("REQ2", ["MAINTENANCE_REQUEST", "MAINTENANCE_REQUEST_VIEW_OWN"], orgA)
        state.planner = user("PLANNER", ["MAINTENANCE_VIEW", "MAINTENANCE_PLAN"], orgA)
        state.otherPlanner = user("OTHER", ["MAINTENANCE_VIEW", "MAINTENANCE_PLAN"], orgB)
        state.member = user("MEMBER", ["MAINTENANCE_VIEW"], orgA)
        state.operator = user("OPERATOR", ["PRODUCTION_OPERATE"], orgA)
        // a team of A with its intake plus tag
        call("create#mantle.party.Party", {partyId: prefix + "_TEAM", partyTypeEnumId: "PtyOrganization", ownerPartyId: orgA})
        call("create#mantle.party.Organization", {partyId: prefix + "_TEAM", organizationName: "Intake team"})
        call("create#mantle.party.PartyRole", {partyId: prefix + "_TEAM", roleTypeId: "OrgTeam"})
        call("create#mantle.party.PartySetting", {
            partyId: prefix + "_TEAM",
            partySettingTypeId: "MntIntakePlusTag",
            settingValue: "intakespec"
        })
    },
    cleanupSpec() {
        ec.message.clearErrors()
        login("john.doe")
    }
})

feature("a requester reports a problem with one target and reads only their own requests, a safe summary", {
    when() {
        const report = parameters => as(state.requester, S + "report#MaintenanceProblem", parameters)
        const first = report({
            assetId: prefix + "_PUMP",
            summary: "Pump is leaking oil",
            description: "A puddle under the pump",
            priority: 2,
            operationKey: prefix + "-report-1"
        })
        state.report1 = first.requestId
        const retried = report({
            assetId: prefix + "_PUMP",
            summary: "Pump is leaking oil",
            description: "A puddle under the pump",
            priority: 2,
            operationKey: prefix + "-report-1"
        })
        const second = as(state.requester2, S + "report#MaintenanceProblem", {
            assetId: prefix + "_PUMP",
            summary: "Oil on the floor by the pump"
        })
        state.report2 = second.requestId
        const room = report({facilityId: prefix + "_ROOM", summary: "Light out in the room"})
        state.report3 = room.requestId
        return {
            first,
            retried,
            reporter: rows("mantle.request.RequestParty", {requestId: state.report1, roleTypeId: "Reporter"})[0]?.partyId,
            organization: rows("mantle.request.RequestParty", {requestId: state.report1, roleTypeId: "OrgInternal"})[0]?.partyId,
            target: rows("mantle.request.RequestRecord", {requestId: state.report1})[0]?.recordId,
            row: request(state.report1),
            own: as(state.requester, S + "find#MaintenanceRequests", {}),
            planned: as(state.planner, S + "find#MaintenanceRequests", {}),
            other: as(state.otherPlanner, S + "find#MaintenanceRequests", {}),
            outside: report({assetId: prefix + "_OTHER_PUMP", summary: "Not ours"}),
            noPermission: as(state.member, S + "report#MaintenanceProblem", {
                assetId: prefix + "_PUMP",
                summary: "No permission"
            }),
            noSummary: report({assetId: prefix + "_PUMP"}),
            memberList: as(state.member, S + "find#MaintenanceRequests", {}),
            targets: as(state.requester, S + "find#MaintenanceReportTargets", {term: "pump"}).options
        }
    },
    then({
        first,
        retried,
        reporter,
        organization,
        target,
        row,
        own,
        planned,
        other,
        outside,
        noPermission,
        noSummary,
        memberList,
        targets
    }) {
        !!first.requestId
        retried.requestId == first.requestId
        retried.repeated == true
        reporter == state.REQ_PARTY
        organization == orgA
        target == prefix + "_PUMP"
        row.requestTypeEnumId == "RqtMaintenance"
        row.statusId == "ReqSubmitted"
        row.filedByPartyId == state.REQ_PARTY
        // own requests only, and no other report on the same asset
        ids(own.requestList).includes(state.report1)
        ids(own.requestList).includes(state.report3)
        !ids(own.requestList).includes(state.report2)
        own.canTriage == false
        rowOf(own.requestList, state.report1).reporterName == ""
        rowOf(own.requestList, state.report1).targetName == prefix + "_PUMP"
        // the planner reads the organization's, with the reporter
        ids(planned.requestList).includes(state.report2)
        rowOf(planned.requestList, state.report2).reporterName == "Intake REQ2"
        planned.canTriage == true
        !ids(other.requestList).includes(state.report1)
        outside == "RECORD_UNAVAILABLE"
        noPermission == "PERMISSION_DENIED"
        noSummary == "SUMMARY_REQUIRED"
        // a reader who neither plans nor holds the own view lists nothing
        memberList == "PERMISSION_DENIED"
        targets.map(option => option.value).includes("asset:" + prefix + "_PUMP")
        !targets.map(option => option.value).includes("asset:" + prefix + "_OTHER_PUMP")
    }
})

feature("two targets are refused, in the report and in link#RequestRecord", {
    when() {
        return {
            both: as(state.requester, S + "report#MaintenanceProblem", {
                assetId: prefix + "_PUMP",
                facilityId: prefix + "_ROOM",
                summary: "Two things"
            }),
            linked: as("john.doe", "mantle.request.RequestServices.link#RequestRecord", {
                requestId: state.report1,
                recordEntityName: "mantle.product.asset.Asset",
                recordId: prefix + "_PRESS"
            }),
            again: as("john.doe", "mantle.request.RequestServices.link#RequestRecord", {
                requestId: state.report1,
                recordEntityName: "mantle.product.asset.Asset",
                recordId: prefix + "_PUMP"
            })
        }
    },
    then({both, linked, again}) {
        both == "ONE_TARGET"
        linked == "ONE_TARGET"
        again.created == false
    }
})

feature("triage creates one work order: triage twice links one order, and a second report of the fault joins it", {
    when() {
        const triage = parameters => as(state.planner, S + "triage#MaintenanceRequest", parameters)
        const created = triage({requestId: state.report1, decision: "create", operationKey: prefix + "-triage-1"})
        state.workEffortId = created.workEffortId
        const twice = triage({requestId: state.report1, decision: "create"})
        const joined = triage({requestId: state.report2, decision: "link", workEffortId: state.workEffortId})
        return {
            created,
            twice,
            joined,
            order: one("mantle.work.maintenance.MaintenanceWorkOrder", {workEffortId: state.workEffortId}),
            roots: rows("mantle.work.maintenance.MaintenanceWorkOrder", {assetId: prefix + "_PUMP"}).length,
            links: rows("mantle.request.RequestWorkEffort", {workEffortId: state.workEffortId}).length,
            status: request(state.report1).statusId,
            rejectAfter: triage({requestId: state.report1, decision: "reject", requestResolutionEnumId: "RrRejected"}),
            otherOrg: as(state.otherPlanner, S + "triage#MaintenanceRequest", {requestId: state.report3, decision: "create"}),
            requester: as(state.requester, S + "triage#MaintenanceRequest", {requestId: state.report3, decision: "create"}),
            followed: rowOf(
                as(state.requester, S + "find#MaintenanceRequests", {requestId: state.report1}).requestList,
                state.report1
            )
        }
    },
    then({created, twice, joined, order, roots, links, status, rejectAfter, otherOrg, requester, followed}) {
        !!created.workEffortId
        created.repeated == false
        twice.workEffortId == created.workEffortId
        twice.repeated == true
        joined.workEffortId == created.workEffortId
        order.sourceEnumId == "MsrcReport"
        order.maintenanceKindEnumId == "MkCorrective"
        roots == 1
        links == 2
        status == "ReqReviewed"
        rejectAfter == "REQUEST_TRIAGED"
        otherOrg == "RECORD_UNAVAILABLE"
        requester == "PERMISSION_DENIED"
        // the requester follows it: the work order's name and status, nothing else of the work
        followed.workEffortId == created.workEffortId
        followed.workStatusText == "Approved"
        followed.reporterName == ""
    }
})

feature("a rejected report keeps its reason", {
    when() {
        const triage = parameters => as(state.planner, S + "triage#MaintenanceRequest", parameters)
        const noReason = triage({requestId: state.report3, decision: "reject"})
        const rejected = triage({
            requestId: state.report3,
            decision: "reject",
            requestResolutionEnumId: "RrDuplicate",
            comments: "Reported already"
        })
        return {
            noReason,
            rejected,
            row: request(state.report3),
            followed: rowOf(
                as(state.requester, S + "find#MaintenanceRequests", {requestId: state.report3, statusId: "all"}).requestList,
                state.report3
            ),
            createAfter: triage({requestId: state.report3, decision: "create"})
        }
    },
    then({noReason, rejected, row, followed, createAfter}) {
        noReason == "REASON_REQUIRED"
        rejected.statusId == "ReqCancelled"
        row.requestResolutionEnumId == "RrDuplicate"
        followed.resolutionText == "Duplicate"
        createAfter == "REQUEST_CLOSED"
    }
})

feature("a mail to the team's plus-tag address makes one request, the sender its reporter, an unknown asset left for triage", {
    when() {
        const unknown = receive({
            subject: "Leak at the loading dock",
            toAddresses: "maintenance+intakespec@intake.example",
            bodyText: "Water"
        })
        const mail = emailMessageId =>
            as("john.doe", S + "create#MaintenanceRequestFromEmail", {emailMessageId, ruleOwnerUserId: state.planner})
        const made = mail(unknown)
        const again = mail(unknown)
        const named = mail(
            receive({
                subject: "Noise from " + prefix + "_PRESS",
                toAddresses: "maintenance+intakespec@intake.example",
                bodyText: "Loud"
            })
        )
        const reporter = rows("mantle.request.RequestParty", {requestId: made.requestId, roleTypeId: "Reporter"})[0]?.partyId
        return {
            made,
            again,
            named,
            row: request(made.requestId),
            organization: rows("mantle.request.RequestParty", {requestId: made.requestId, roleTypeId: "OrgInternal"})[0]?.partyId,
            team: rows("mantle.request.RequestParty", {requestId: made.requestId, roleTypeId: "OrgTeam"})[0]?.partyId,
            reporter,
            reporterAddress: rows("mantle.party.contact.PartyContactMechInfo", {partyId: reporter})[0]?.infoString,
            targets: rows("mantle.request.RequestRecord", {requestId: made.requestId}).length,
            namedTarget: rows("mantle.request.RequestRecord", {requestId: named.requestId})[0]?.recordId,
            filed: rows("mantle.request.RequestEmailMessage", {emailMessageId: unknown}).length
        }
    },
    then({made, again, named, row, organization, team, reporter, reporterAddress, targets, namedTarget, filed}) {
        made.created == true
        again.requestId == made.requestId
        again.created == false
        row.requestTypeEnumId == "RqtMaintenance"
        row.salesChannelEnumId == "ScEmail"
        organization == orgA
        team == prefix + "_TEAM"
        row.filedByPartyId == reporter
        reporterAddress == "dock.worker@intake.example"
        targets == 0
        namedTarget == prefix + "_PRESS"
        filed == 1
        named.created == true
    }
})

feature("request#ProductionMaintenance twice makes one root under the organization's policy, its request linked", {
    when() {
        call("create#mantle.work.maintenance.MaintenancePolicy", {
            organizationPartyId: orgA,
            fromDate: since,
            approvalThresholdHours: 0,
            closurePolicyEnumId: "MclSupervisor",
            productionRequestsManaged: "Y",
            warrantyRepairsManaged: "N"
        })
        const parameters = {
            operationKey: prefix + "-production-1",
            assetId: prefix + "_PRESS",
            problem: "Press ram sticks",
            createRequest: true
        }
        const first = as(state.operator, "mantle.work.ProductionServices.request#ProductionMaintenance", parameters).result || {}
        const second = as(state.operator, "mantle.work.ProductionServices.request#ProductionMaintenance", parameters).result || {}
        return {
            first,
            second,
            roots: rows("mantle.work.maintenance.MaintenanceWorkOrder", {assetMaintenanceId: first.assetMaintenanceId}).length,
            order: one("mantle.work.maintenance.MaintenanceWorkOrder", {workEffortId: first.workEffortId}),
            linked: rows("mantle.request.RequestWorkEffort", {requestId: first.requestId, workEffortId: first.workEffortId})
                .length,
            status: request(first.requestId).statusId,
            queue: as(state.planner, S + "find#UnmanagedMaintenance", {}).maintenanceList
        }
    },
    then({first, second, roots, order, linked, status, queue}) {
        !!first.workEffortId
        second.workEffortId == first.workEffortId
        roots == 1
        order.sourceEnumId == "MsrcProduction"
        linked == 1
        status == "ReqReviewed"
        !Array.from(queue).some(row => row.assetMaintenanceId == first.assetMaintenanceId)
    }
})

feature(
    "the triage notice goes to the organization's planners by the target's name; a work order's completion moves no request",
    {
        when() {
            const notice = as("john.doe", "mantle.request.RequestServices.notify#RequestTriage", {
                requestId: state.report2,
                force: true
            })
            const report = as(state.requester, S + "report#MaintenanceProblem", {assetId: prefix + "_PUMP", summary: "Pump hums"})
            const told = as("john.doe", "mantle.request.RequestServices.notify#RequestTriage", {
                requestId: report.requestId,
                force: true
            })
            const moved = as("john.doe", "mantle.request.RequestServices.complete#RequestFromWork", {
                workEffortId: state.workEffortId
            })
            return {notice, told, moved, status: request(state.report1).statusId}
        },
        then({notice, told, moved, status}) {
            // report2 was triaged (Reviewed): no notice; a new report tells the planner, not the requester or another organization
            Array.from(notice.userIdList || []).length == 0
            Array.from(told.userIdList).includes(state.planner)
            !Array.from(told.userIdList).includes(state.requester)
            !Array.from(told.userIdList).includes(state.otherPlanner)
            Array.from(moved.changedList || []).length == 0
            status == "ReqReviewed"
        }
    }
)
