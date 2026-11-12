// Maintenance outages (mantle.work.ResourceBookingServices record#, find#, correct# and end#ResourceUnavailability, and the work
// order's downtime in transition#MaintenanceWorkOrder; IronStone Maintenance design §6 Downtime, §3, §7.1; impl-maintenance P5,
// F14): an equipment-fault stop in Manufacturing records the asset's one outage, and a second fault Maintenance records links it;
// closing the stop restores nothing and end# does, with the disposition; a technician not on the work is refused; a correction
// keeps the original interval and the row in force is the one the reads count; two work orders linked to one outage cannot each
// end the other's (the outage waits for both, and for a follow-up a completion leaves). Standalone: spec-local organizations, a
// plant with a line, equipment, a stop reason, groups and users; the services called as each user with the artifact check aside.
// Run: ./moq test mr-mantle --spec MaintenanceOutages
const prefix = "MNT_OUT"
const orgA = prefix + "_A",
    orgB = prefix + "_B",
    plant = prefix + "_PLANT",
    line = prefix + "_LINE",
    since = "2000-01-01T00:00:00Z"
const R = "mantle.work.ResourceBookingServices.",
    M = "mantle.work.MaintenanceServices.",
    P = "mantle.work.ProductionServices."
const OUTAGE = "mantle.work.effort.ResourceUnavailability"
const state = {}
let keySeq = 0
const key = () => prefix + "-op-" + ++keySeq
const minutesAgo = minutes => new Date(Date.now() - minutes * 60000)
const ms = value => (/^-?\d+$/.test(String(value)) ? Number(value) : Date.parse(String(value)))

// the service's answer as a user, or the reason code it refuses with, in its own transaction
function as(username, service, parameters = {}) {
    login(username)
    ec.artifactExecution.disableAuthz()
    ec.message.pushErrors()
    try {
        const out = ec.service.sync().name(service).parameters(parameters).requireNewTransaction(true).call() || {}
        if (ec.message.hasError()) {
            const match = /([A-Z][A-Z0-9_]+):/.exec(ec.message.getErrorsString())
            return match ? match[1] : "ERROR " + ec.message.getErrorsString()
        }
        return out
    } catch (error) {
        const match = /([A-Z][A-Z0-9_]+):/.exec(String(error.message))
        return match ? match[1] : "ERROR " + error.message
    } finally {
        ec.message.clearErrors()
        ec.message.popErrors()
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
    call("create#moqui.security.UserGroup", {userGroupId: id, description: "Outages " + kind})
    for (const permission of permissions)
        call("create#moqui.security.UserGroupPermission", {userGroupId: id, userPermissionId: permission, fromDate: since})
    const partyId = prefix + "_P_" + kind
    call("create#mantle.party.Party", {partyId, partyTypeEnumId: "PtyPerson"})
    call("create#mantle.party.Person", {partyId, firstName: "Outages", lastName: kind})
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
        userFullName: "Outages " + kind,
        partyId,
        currentPassword: "16ac58bbfa332c1c55bd98b53e60720bfa90d394",
        passwordHashType: "SHA"
    })
    call("create#moqui.security.UserGroupMember", {userId: id, userGroupId: id, fromDate: since})
    state[kind + "_PARTY"] = partyId
    return id
}
const outage = resourceUnavailabilityId =>
    ec.entity.find(OUTAGE).condition("resourceUnavailabilityId", resourceUnavailabilityId).disableAuthz().one()
const outagesOf = assetId => Array.from(ec.entity.find(OUTAGE).condition("assetId", assetId).disableAuthz().list())
const order = workEffortId =>
    ec.entity.find("mantle.work.maintenance.MaintenanceWorkOrder").condition("workEffortId", workEffortId).disableAuthz().one()
const revision = workEffortId => Number(order(workEffortId).revision)
// a corrective work order on the asset, assigned to the technician and started by them (offline: taking it out of service)
function startedWork(assetId, name, tech, techParty, offline) {
    const created = as(state.planner, M + "create#MaintenanceWorkOrder", {
        assetId,
        workEffortName: name,
        offlineIntent: offline ? "Y" : null
    })
    as(state.planner, M + "schedule#MaintenanceWorkOrder", {
        workEffortId: created.workEffortId,
        expectedRevision: revision(created.workEffortId),
        assigneePartyIds: [techParty]
    })
    const started = as(tech, M + "transition#MaintenanceWorkOrder", {
        workEffortId: created.workEffortId,
        action: "start",
        expectedRevision: revision(created.workEffortId)
    })
    return {workEffortId: created.workEffortId, started}
}

spec({
    stepwise: true,
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        organization(orgA)
        organization(orgB)
        call("create#mantle.facility.Facility", {
            facilityId: plant,
            facilityTypeEnumId: "FcTpPlant",
            facilityName: "Outage plant",
            ownerPartyId: orgA
        })
        call("create#mantle.facility.Facility", {
            facilityId: line,
            facilityTypeEnumId: "FcTpLine",
            facilityName: "Outage line",
            parentFacilityId: plant,
            ownerPartyId: orgA
        })
        call("create#mantle.work.production.WorkCenter", {facilityId: line})
        call("create#mantle.facility.Facility", {
            facilityId: prefix + "_OTHER",
            facilityTypeEnumId: "FcTpBuilding",
            facilityName: "Other site",
            ownerPartyId: orgB
        })
        for (const [assetId, facilityId, ownerPartyId] of [
            [prefix + "_PRESS", plant, orgA],
            [prefix + "_COMP", plant, orgA],
            [prefix + "_OTHER_PUMP", prefix + "_OTHER", orgB]
        ])
            call("create#mantle.product.asset.Asset", {
                assetId,
                assetTypeEnumId: "AstTpEquipment",
                assetName: assetId,
                statusId: "AstAvailable",
                ownerPartyId,
                facilityId
            })
        call("create#mantle.work.production.ProductionReason", {
            organizationPartyId: orgA,
            reasonCode: prefix + "_FAULT",
            fromDate: since,
            reasonName: "Press fault",
            reasonCategoryEnumId: "PrcDowntime",
            equipmentFault: "Y",
            plannedStop: "N"
        })
        state.operator = user("OPERATOR", ["PRODUCTION_OPERATE", "PRODUCTION_VIEW"])
        state.planner = user("PLANNER", ["MAINTENANCE_VIEW", "MAINTENANCE_PLAN"])
        state.supervisor = user("SUPERVISOR", ["MAINTENANCE_VIEW", "MAINTENANCE_SUPERVISE"])
        state.resources = user("RESOURCES", ["MAINTENANCE_RESOURCE_VIEW", "MAINTENANCE_RESOURCE_EDIT"])
        state.tech = user("TECH", ["MAINTENANCE_ASSIGNED_VIEW", "MAINTENANCE_EXECUTE"])
        state.tech2 = user("TECH2", ["MAINTENANCE_ASSIGNED_VIEW", "MAINTENANCE_EXECUTE"])
        state.otherSupervisor = user("OTHER", ["MAINTENANCE_VIEW", "MAINTENANCE_SUPERVISE"], orgB)
    },
    cleanupSpec() {
        ec.message.clearErrors()
        login("john.doe")
    }
})

feature("an equipment-fault stop records the press's one outage; a second fault Maintenance records links it", {
    when() {
        const stop = as(state.operator, P + "store#ProductionDowntime", {
            operationKey: key(),
            action: "open",
            facilityId: line,
            assetId: prefix + "_PRESS",
            reasonCode: prefix + "_FAULT",
            fromDate: minutesAgo(90)
        }).result
        state.stop = stop
        const second = as(state.supervisor, R + "record#ResourceUnavailability", {
            assetId: prefix + "_PRESS",
            unavailabilityReasonEnumId: "RurSafety",
            description: "Guard cracked as well"
        })
        // the operator's stop names no other asset: Manufacturing's entry is the stop's own equipment
        const wrongAsset = as(state.operator, R + "record#ResourceUnavailability", {
            assetId: prefix + "_COMP",
            sourceProductionDowntimeId: stop.productionDowntimeId
        })
        const listed = as(state.planner, R + "find#ResourceUnavailability", {assetId: prefix + "_PRESS"})
        return {stop, second, wrongAsset, listed, rows: outagesOf(prefix + "_PRESS")}
    },
    then({stop, second, wrongAsset, listed, rows}) {
        rows.length == 1
        stop.resourceUnavailabilityId == rows[0].resourceUnavailabilityId
        rows[0].unavailabilityReasonEnumId == "RurEquipmentFault"
        rows[0].plannedOutage == "N"
        second.linked == true
        second.resourceUnavailabilityId == rows[0].resourceUnavailabilityId
        wrongAsset == "SOURCE_INVALID"
        listed.outageList.length == 1
        listed.outageList[0].stateText == "Out of service"
        listed.outageList[0].productionText.includes("Outage line")
        listed.outageList[0].productionText.includes("Press fault")
        listed.outageList[0].canRestore == false
    }
})

feature("a technician records an outage only from work assigned to them; a reader of another organization is refused", {
    when() {
        const work = startedWork(prefix + "_COMP", "Compressor trips", state.tech, state.TECH_PARTY, false)
        state.compWork = work.workEffortId
        const parameters = {
            assetId: prefix + "_COMP",
            unavailabilityReasonEnumId: "RurEquipmentFault",
            workEffortId: work.workEffortId
        }
        const notAssigned = as(state.tech2, R + "record#ResourceUnavailability", parameters)
        const noWork = as(state.tech, R + "record#ResourceUnavailability", {
            assetId: prefix + "_COMP",
            unavailabilityReasonEnumId: "RurEquipmentFault"
        })
        const planner = as(state.planner, R + "record#ResourceUnavailability", {
            assetId: prefix + "_COMP",
            unavailabilityReasonEnumId: "RurEquipmentFault"
        })
        const noReason = as(state.tech, R + "record#ResourceUnavailability", {
            assetId: prefix + "_COMP",
            workEffortId: work.workEffortId
        })
        const otherOrg = as(state.otherSupervisor, R + "record#ResourceUnavailability", {
            assetId: prefix + "_COMP",
            unavailabilityReasonEnumId: "RurEquipmentFault"
        })
        const recorded = as(state.tech, R + "record#ResourceUnavailability", parameters)
        const techEnds = as(state.tech, R + "end#ResourceUnavailability", {
            resourceUnavailabilityId: recorded.resourceUnavailabilityId,
            expectedRevision: 1,
            dispositionEnumId: "MdispAvailable"
        })
        const otherFinds = as(state.otherSupervisor, R + "find#ResourceUnavailability", {
            resourceUnavailabilityId: recorded.resourceUnavailabilityId
        })
        state.compOutage = recorded.resourceUnavailabilityId
        return {work, notAssigned, noWork, planner, noReason, otherOrg, recorded, techEnds, otherFinds}
    },
    then({work, notAssigned, noWork, planner, noReason, otherOrg, recorded, techEnds, otherFinds}) {
        work.started.statusId == "WeInProgress"
        notAssigned == "NOT_ASSIGNED"
        noWork == "WORK_REQUIRED"
        planner == "PERMISSION_DENIED"
        noReason == "REASON_INVALID"
        otherOrg == "RECORD_UNAVAILABLE"
        recorded.linked == false
        outage(recorded.resourceUnavailabilityId).workEffortId == work.workEffortId
        order(work.workEffortId).resourceUnavailabilityId == recorded.resourceUnavailabilityId
        techEnds == "PERMISSION_DENIED"
        otherFinds == "RECORD_UNAVAILABLE"
    }
})

feature("closing the production stop restores nothing; end# restores the press with its disposition", {
    when() {
        const closed = as(state.operator, P + "store#ProductionDowntime", {
            operationKey: key(),
            action: "close",
            productionDowntimeId: state.stop.productionDowntimeId,
            expectedRevision: state.stop.revision
        }).result
        const afterClose = outage(state.stop.resourceUnavailabilityId)
        const stale = as(state.supervisor, R + "end#ResourceUnavailability", {
            resourceUnavailabilityId: state.stop.resourceUnavailabilityId,
            expectedRevision: 7,
            dispositionEnumId: "MdispAvailable"
        })
        const noDisposition = as(state.supervisor, R + "end#ResourceUnavailability", {
            resourceUnavailabilityId: state.stop.resourceUnavailabilityId,
            expectedRevision: 1
        })
        const stillDown = as(state.supervisor, R + "end#ResourceUnavailability", {
            resourceUnavailabilityId: state.stop.resourceUnavailabilityId,
            expectedRevision: 1,
            dispositionEnumId: "MdispUnavailable"
        })
        const restored = as(state.resources, R + "end#ResourceUnavailability", {
            resourceUnavailabilityId: state.stop.resourceUnavailabilityId,
            expectedRevision: 1,
            dispositionEnumId: "MdispAvailable",
            endComments: "Guard replaced, test run clean"
        })
        const again = as(state.supervisor, R + "end#ResourceUnavailability", {
            resourceUnavailabilityId: state.stop.resourceUnavailabilityId,
            expectedRevision: 2,
            dispositionEnumId: "MdispAvailable"
        })
        const manufacturing = as(state.operator, P + "find#ProductionDowntime", {
            productionDowntimeId: state.stop.productionDowntimeId
        })
        return {
            closed,
            afterClose,
            stale,
            noDisposition,
            stillDown,
            restored,
            again,
            manufacturing,
            row: outage(state.stop.resourceUnavailabilityId)
        }
    },
    then({closed, afterClose, stale, noDisposition, stillDown, restored, again, manufacturing, row}) {
        closed.statusId == "PdtClosed"
        afterClose.thruDate == null
        stale == "REVISION_CHANGED"
        noDisposition == "DISPOSITION_REQUIRED"
        stillDown == "DISPOSITION_INVALID"
        restored.resultCode == "RESTORED"
        row.thruDate != null
        row.dispositionEnumId == "MdispAvailable"
        row.endedByUserId == state.resources
        row.endComments == "Guard replaced, test run clean"
        again == "OUTAGE_ENDED"
        manufacturing.downtimeList[0].outageText.startsWith("Restored")
        manufacturing.downtimeList[0].outageText.includes("Outages RESOURCES")
    }
})

feature("a correction keeps the original interval; the row in force is the one counted and linked", {
    when() {
        const original = outage(state.compOutage)
        const noReason = as(state.supervisor, R + "correct#ResourceUnavailability", {
            resourceUnavailabilityId: state.compOutage,
            expectedRevision: 1,
            fromDate: minutesAgo(45)
        })
        const techCorrects = as(state.tech, R + "correct#ResourceUnavailability", {
            resourceUnavailabilityId: state.compOutage,
            expectedRevision: 1,
            fromDate: minutesAgo(45),
            changeReason: "Tripped earlier"
        })
        const corrected = as(state.supervisor, R + "correct#ResourceUnavailability", {
            resourceUnavailabilityId: state.compOutage,
            expectedRevision: 1,
            fromDate: minutesAgo(45),
            changeReason: "The night shift saw it trip earlier"
        })
        const twice = as(state.supervisor, R + "correct#ResourceUnavailability", {
            resourceUnavailabilityId: state.compOutage,
            expectedRevision: 2,
            changeReason: "Again"
        })
        // a second fault now links the corrected row, never the superseded one
        const linked = as(state.supervisor, R + "record#ResourceUnavailability", {
            assetId: prefix + "_COMP",
            unavailabilityReasonEnumId: "RurDamage"
        })
        const listed = as(state.supervisor, R + "find#ResourceUnavailability", {assetId: prefix + "_COMP"})
        const history = as(state.supervisor, R + "find#ResourceUnavailability", {
            resourceUnavailabilityId: corrected.resourceUnavailabilityId
        })
        state.compOutage = corrected.resourceUnavailabilityId
        return {
            original,
            noReason,
            techCorrects,
            corrected,
            twice,
            linked,
            listed,
            history,
            kept: outage(original.resourceUnavailabilityId),
            now: outage(corrected.resourceUnavailabilityId)
        }
    },
    then({original, noReason, techCorrects, corrected, twice, linked, listed, history, kept, now}) {
        noReason == "REASON_REQUIRED"
        techCorrects == "PERMISSION_DENIED"
        corrected.correctedUnavailabilityId == original.resourceUnavailabilityId
        ms(kept.fromDate) == ms(original.fromDate)
        kept.supersededByUnavailabilityId == corrected.resourceUnavailabilityId
        ms(now.fromDate) < ms(original.fromDate)
        now.correctionOfUnavailabilityId == original.resourceUnavailabilityId
        now.changeReason == "The night shift saw it trip earlier"
        now.createdByUserId == state.tech
        twice == "OUTAGE_CORRECTED"
        linked.resourceUnavailabilityId == corrected.resourceUnavailabilityId
        order(state.compWork).resourceUnavailabilityId == corrected.resourceUnavailabilityId
        listed.outageList.length == 1
        history.history.length == 2
        history.history[0].stateText == "Corrected"
    }
})

feature("two work orders on one outage cannot each end the other's; a completion leaving it down makes a linked follow-up", {
    when() {
        // a second work order on the compressor, taken offline: it links the open outage
        const second = startedWork(prefix + "_COMP", "Compressor valve", state.tech2, state.TECH2_PARTY, true)
        const linkedSecond = order(second.workEffortId).resourceUnavailabilityId
        const firstDone = as(state.tech, M + "transition#MaintenanceWorkOrder", {
            workEffortId: state.compWork,
            action: "complete",
            expectedRevision: revision(state.compWork),
            outcomeEnumId: "MoutRepaired",
            dispositionEnumId: "MdispAvailable"
        })
        const blocked = as(state.supervisor, R + "end#ResourceUnavailability", {
            resourceUnavailabilityId: state.compOutage,
            expectedRevision: 1,
            dispositionEnumId: "MdispAvailable"
        })
        const secondDone = as(state.tech2, M + "transition#MaintenanceWorkOrder", {
            workEffortId: second.workEffortId,
            action: "complete",
            expectedRevision: revision(second.workEffortId),
            outcomeEnumId: "MoutNotRepaired",
            dispositionEnumId: "MdispUnavailable",
            followUpName: "Replace compressor valve"
        })
        const followUpBlocks = as(state.supervisor, R + "end#ResourceUnavailability", {
            resourceUnavailabilityId: state.compOutage,
            expectedRevision: 1,
            dispositionEnumId: "MdispAvailable"
        })
        const cancelled = as(state.supervisor, M + "transition#MaintenanceWorkOrder", {
            workEffortId: secondDone.followUpWorkEffortId,
            action: "cancel",
            expectedRevision: revision(secondDone.followUpWorkEffortId),
            cancelReasonEnumId: "McrDuplicate"
        })
        const stillOpen = outage(state.compOutage).thruDate
        const restored = as(state.supervisor, R + "end#ResourceUnavailability", {
            resourceUnavailabilityId: state.compOutage,
            expectedRevision: 1,
            dispositionEnumId: "MdispRestricted"
        })
        // equipment left down with no outage open records one at completion
        const third = startedWork(prefix + "_COMP", "Compressor noise", state.tech, state.TECH_PARTY, false)
        const thirdDone = as(state.tech, M + "transition#MaintenanceWorkOrder", {
            workEffortId: third.workEffortId,
            action: "complete",
            expectedRevision: revision(third.workEffortId),
            outcomeEnumId: "MoutNotRepaired",
            dispositionEnumId: "MdispUnavailable"
        })
        const read = as(state.tech, M + "get#MaintenanceWorkOrder", {workEffortId: third.workEffortId})
        return {
            second,
            linkedSecond,
            firstDone,
            blocked,
            secondDone,
            followUpBlocks,
            cancelled,
            stillOpen,
            restored,
            thirdDone,
            read
        }
    },
    then({
        second,
        linkedSecond,
        firstDone,
        blocked,
        secondDone,
        followUpBlocks,
        cancelled,
        stillOpen,
        restored,
        thirdDone,
        read
    }) {
        second.started.resourceUnavailabilityId == state.compOutage
        linkedSecond == state.compOutage
        firstDone.statusId == "WeComplete"
        blocked == "OPEN_WORK"
        secondDone.statusId == "WeComplete"
        secondDone.followUpWorkEffortId != null
        order(secondDone.followUpWorkEffortId).sourceEnumId == "MsrcFollowUp"
        order(secondDone.followUpWorkEffortId).resourceUnavailabilityId == state.compOutage
        followUpBlocks == "OPEN_WORK"
        cancelled.statusId == "WeCancelled"
        stillOpen == null
        restored.resultCode == "RESTORED"
        outage(state.compOutage).dispositionEnumId == "MdispRestricted"
        thirdDone.resourceUnavailabilityId != null
        thirdDone.resourceUnavailabilityId != state.compOutage
        outage(thirdDone.resourceUnavailabilityId).thruDate == null
        read.workOrder.outage.open == true
    }
})
