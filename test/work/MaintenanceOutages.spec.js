// Maintenance outages (mantle.work.ResourceBookingServices record#, find#, correct# and end#ResourceUnavailability, and the work
// order's downtime in transition#MaintenanceWorkOrder; IronStone Maintenance design §6 Downtime, §3, §7.1; impl-maintenance P5,
// F14): an equipment-fault stop in Manufacturing records the asset's one outage, and a second fault Maintenance records links it;
// closing the stop restores nothing and end# does, with the disposition; a technician not on the work is refused; a correction
// keeps the original interval and the row in force is the one the reads count, and a planned block is corrected as a block (P15,
// replacing the P5 review's KIND_INVALID: Manufacturing's offline time goes through record# now and its withdraw ends the row in force); a stop
// already recorded cannot be named again to record another outage; two work orders linked to one outage cannot each end the
// other's (no completion or cancel restores), and a restoration while linked work is open (a completion's follow-up) lists it,
// needs its reason and leaves it open (the user's call, Nov 12). Standalone: spec-local organizations, a
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
        // the work order's title is its readers' (F69): the resource administrator and another technician see its id and status
        const workOf = user =>
            as(user, R + "find#ResourceUnavailability", {resourceUnavailabilityId: recorded.resourceUnavailabilityId})
                .outageList[0].workList[0]
        const seen = {supervisor: workOf(state.supervisor), resources: workOf(state.resources), tech2: workOf(state.tech2)}
        state.compOutage = recorded.resourceUnavailabilityId
        return {work, notAssigned, noWork, planner, noReason, otherOrg, recorded, techEnds, otherFinds, seen}
    },
    then({work, notAssigned, noWork, planner, noReason, otherOrg, recorded, techEnds, otherFinds, seen}) {
        seen.supervisor.workEffortName == "Compressor trips"
        seen.resources.workEffortId == work.workEffortId
        seen.resources.workEffortName == ""
        seen.resources.readable == false
        seen.tech2.workEffortName == ""
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
        // the stop recorded its outage: naming it again records no new one, open or ended
        const replay = as(state.operator, R + "record#ResourceUnavailability", {
            assetId: prefix + "_PRESS",
            sourceProductionDowntimeId: state.stop.productionDowntimeId
        })
        const forged = as(state.operator, R + "record#ResourceUnavailability", {
            assetId: prefix + "_PRESS",
            sourceProductionDowntimeId: state.stop.productionDowntimeId,
            fromDate: minutesAgo(600),
            thruDate: minutesAgo(500)
        })
        return {
            replay,
            forged,
            outageCount: outagesOf(prefix + "_PRESS").length,
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
    then({
        closed,
        afterClose,
        stale,
        noDisposition,
        stillDown,
        restored,
        again,
        manufacturing,
        row,
        replay,
        forged,
        outageCount
    }) {
        replay == "SOURCE_INVALID"
        forged == "SOURCE_INVALID"
        outageCount == 1
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
        // a planned block (Manufacturing's offline time of the line) is corrected as a block by the supervisor of its scope (P15)
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        const block = call("create#" + OUTAGE, {
            unavailabilityKindEnumId: "RukPlanned",
            facilityId: line,
            organizationPartyId: orgA,
            fromDate: minutesAgo(30),
            thruDate: minutesAgo(10),
            description: "Line offline (spec)"
        }).resourceUnavailabilityId
        const plannedCorrected = as(state.supervisor, R + "correct#ResourceUnavailability", {
            resourceUnavailabilityId: block,
            expectedRevision: 0,
            changeReason: "Not here"
        })
        const history = as(state.supervisor, R + "find#ResourceUnavailability", {
            resourceUnavailabilityId: corrected.resourceUnavailabilityId
        })
        state.compOutage = corrected.resourceUnavailabilityId
        return {
            block,
            original,
            noReason,
            techCorrects,
            corrected,
            twice,
            linked,
            listed,
            history,
            plannedCorrected,
            kept: outage(original.resourceUnavailabilityId),
            now: outage(corrected.resourceUnavailabilityId)
        }
    },
    then({block, original, noReason, techCorrects, corrected, twice, linked, listed, history, plannedCorrected, kept, now}) {
        plannedCorrected.correctedUnavailabilityId == block
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

feature("no work order ends another's outage; restoring with a follow-up open lists it, needs a reason and leaves it open", {
    when() {
        // a second work order on the compressor, taken offline: it links the open outage
        const second = startedWork(prefix + "_COMP", "Compressor valve", state.tech2, state.TECH2_PARTY, true)
        const linkedSecond = order(second.workEffortId).resourceUnavailabilityId
        // the first completes with the compressor available: the second's outage stays open
        const firstDone = as(state.tech, M + "transition#MaintenanceWorkOrder", {
            workEffortId: state.compWork,
            action: "complete",
            expectedRevision: revision(state.compWork),
            outcomeEnumId: "MoutRepaired",
            dispositionEnumId: "MdispAvailable"
        })
        const afterFirst = outage(state.compOutage).thruDate
        // a third, taken offline and cancelled: cancelling restores nothing
        const third = startedWork(prefix + "_COMP", "Compressor guard", state.tech, state.TECH_PARTY, true)
        const cancelled = as(state.supervisor, M + "transition#MaintenanceWorkOrder", {
            workEffortId: third.workEffortId,
            action: "cancel",
            expectedRevision: revision(third.workEffortId),
            cancelReasonEnumId: "McrDuplicate"
        })
        const afterCancel = outage(state.compOutage).thruDate
        const secondDone = as(state.tech2, M + "transition#MaintenanceWorkOrder", {
            workEffortId: second.workEffortId,
            action: "complete",
            expectedRevision: revision(second.workEffortId),
            outcomeEnumId: "MoutNotRepaired",
            dispositionEnumId: "MdispUnavailable",
            followUpName: "Replace compressor valve"
        })
        const followUp = secondDone.followUpWorkEffortId
        const preview = as(state.supervisor, R + "find#ResourceUnavailability", {resourceUnavailabilityId: state.compOutage})
        const noReason = as(state.supervisor, R + "end#ResourceUnavailability", {
            resourceUnavailabilityId: state.compOutage,
            expectedRevision: 1,
            dispositionEnumId: "MdispAvailable"
        })
        const restored = as(state.supervisor, R + "end#ResourceUnavailability", {
            resourceUnavailabilityId: state.compOutage,
            expectedRevision: 1,
            dispositionEnumId: "MdispRestricted",
            openWorkReason: "Runs on the old valve at reduced pressure until the new one comes"
        })
        const followUpStatus = ec.entity
            .find("mantle.work.effort.WorkEffort")
            .condition("workEffortId", followUp)
            .disableAuthz()
            .one().statusId
        // equipment left down with no outage open records one at completion
        const fourth = startedWork(prefix + "_COMP", "Compressor noise", state.tech, state.TECH_PARTY, false)
        const fourthDone = as(state.tech, M + "transition#MaintenanceWorkOrder", {
            workEffortId: fourth.workEffortId,
            action: "complete",
            expectedRevision: revision(fourth.workEffortId),
            outcomeEnumId: "MoutNotRepaired",
            dispositionEnumId: "MdispUnavailable"
        })
        const read = as(state.tech, M + "get#MaintenanceWorkOrder", {workEffortId: fourth.workEffortId})
        return {
            second,
            linkedSecond,
            firstDone,
            afterFirst,
            cancelled,
            afterCancel,
            secondDone,
            followUp,
            preview,
            noReason,
            restored,
            followUpStatus,
            fourthDone,
            read
        }
    },
    then({
        second,
        linkedSecond,
        firstDone,
        afterFirst,
        cancelled,
        afterCancel,
        secondDone,
        followUp,
        preview,
        noReason,
        restored,
        followUpStatus,
        fourthDone,
        read
    }) {
        second.started.resourceUnavailabilityId == state.compOutage
        linkedSecond == state.compOutage
        firstDone.statusId == "WeComplete"
        afterFirst == null
        cancelled.statusId == "WeCancelled"
        afterCancel == null
        secondDone.statusId == "WeComplete"
        followUp != null
        order(followUp).sourceEnumId == "MsrcFollowUp"
        order(followUp).resourceUnavailabilityId == state.compOutage
        preview.outageList[0].canRestore == true
        preview.outageList[0].openWorkList.map(work => work.workEffortId).join() == followUp
        noReason == "OPEN_WORK"
        restored.resultCode == "RESTORED"
        Array.from(restored.openWorkList)
            .map(work => work.workEffortId)
            .join() == followUp
        outage(state.compOutage).thruDate != null
        outage(state.compOutage).dispositionEnumId == "MdispRestricted"
        outage(state.compOutage)
            .openWorkReason.startsWith("Runs on the old valve")
            [("WeInPlanning", "WeApproved")].includes(followUpStatus)
        fourthDone.resourceUnavailabilityId != null
        fourthDone.resourceUnavailabilityId != state.compOutage
        outage(fourthDone.resourceUnavailabilityId).thruDate == null
        read.workOrder.outage.open == true
    }
})
