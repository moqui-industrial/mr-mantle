// Preventive plans and the due projection (mantle.work.MaintenancePlanServices, MaintenancePlans.js; IronStone Maintenance design
// §5.1, §11.2 "PM chronology"; impl-maintenance P13): activation refused with no time zone or a named procedure that does not
// qualify, and a plan with no procedure activated (the user's call, Nov 12: P14 makes it ad hoc work with the plan's name and
// estimate); a procedure of another organization and a first due date with a zone refused; another organization's planner lists
// none of the plans or their due; a monthly
// plan's 31st clamps to a short month and returns to the 31st, and a completion from before the first due date's interval covers
// nothing; a daylight-saving change keeps the local due time; a holiday of a
// People holiday calendar (a WepHoliday event read through EventServices.get#NextBusinessDay, F64) moves the planned day and not
// the due date; a planned or cancelled maintenance and a synthetic threshold advance nothing, a counted completion's reading is
// the new baseline (a completion before the plan's baseline does not move it back) and a reset is counted across; a stale meter
// answers unknown, not "not due"; a change of an active plan's terms leaves the earlier term and the work done under it alone, a
// later change planned is not cut short and a rename changes no term; a plan whose target moved to another organization is
// ended, not changed (TARGET_MOVED). Access: a reader is refused a write, another organization's planner
// the plan. Standalone: spec-local organizations, facilities, an equipment model with a counting meter, procedures, groups and
// users; the services called as each user with the artifact check aside (their own permission and scope checks decide).
// Run: ./moq test mr-mantle --spec MaintenanceDue
const prefix = "MNT_DUE"
const orgA = prefix + "_A",
    orgB = prefix + "_B",
    since = "2000-01-01T00:00:00Z"
const S = "mantle.work.MaintenancePlanServices."
const state = {}
const dayMs = 24 * 3600 * 1000
let keySeq = 0
const key = () => prefix + "-op-" + ++keySeq
const daysAgo = days => new Date(Date.now() - days * dayMs)

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
    call("create#moqui.security.UserGroup", {userGroupId: id, description: "Due " + kind})
    for (const permission of permissions)
        call("create#moqui.security.UserGroupPermission", {userGroupId: id, userPermissionId: permission, fromDate: since})
    const partyId = prefix + "_P_" + kind
    call("create#mantle.party.Party", {partyId, partyTypeEnumId: "PtyPerson"})
    call("create#mantle.party.Person", {partyId, firstName: "Due", lastName: kind})
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
    return id
}
function facility(facilityId, parentFacilityId, ownerPartyId, timeZone, facilityTypeEnumId = "FcTpRoom") {
    call("create#mantle.facility.Facility", {
        facilityId,
        facilityTypeEnumId,
        facilityName: facilityId,
        parentFacilityId,
        ownerPartyId,
        timeZone
    })
}
// an approved maintenance procedure in effect (or a draft), for equipment of a model or for rooms
function procedure(workEffortId, approved, applicability) {
    call("create#mantle.work.effort.WorkEffort", {
        workEffortId,
        workEffortTypeEnumId: "WetTask",
        purposeEnumId: "WepMaintenance",
        isTemplate: "Y",
        statusId: approved ? "WeApproved" : "WeInPlanning",
        statusFlowId: "WorkEffortProcedure",
        ownerPartyId: orgA,
        workEffortName: workEffortId
    })
    call(
        "create#mantle.work.effort.WorkEffortProcessPolicy",
        Object.assign(
            {workEffortId, fromDate: since, processPolicyEnumId: "WppMaintenanceProcedure", guardsExecution: "Y"},
            approved ? {effectiveFromDate: since, approvedDate: since} : {},
            applicability
        )
    )
}
// a work order of a plan, done (or cancelled) at a time, with a reading taken in it when a value is given
function workOrder(workEffortId, maintenanceScheduleId, assetId, statusId, completedAt, reading) {
    call("create#mantle.work.effort.WorkEffort", {
        workEffortId,
        workEffortTypeEnumId: "WetTask",
        purposeEnumId: "WepMaintenance",
        statusId,
        ownerPartyId: orgA,
        workEffortName: workEffortId,
        actualCompletionDate: statusId === "WeCancelled" ? null : completedAt
    })
    call("create#mantle.work.maintenance.MaintenanceWorkOrder", {workEffortId, assetId, maintenanceScheduleId, revision: 1})
    if (reading != null)
        call("create#mantle.product.maintenance.AssetMeter", {
            assetId,
            readingDate: completedAt,
            productMeterId: prefix + "_HOURS",
            productMeterTypeId: "PdMtrMotorTime",
            meterValue: reading,
            readingReasonEnumId: "AmrWork",
            workEffortId
        })
}
function reading(at, value, reasonEnumId = "AmrReading") {
    call("create#mantle.product.maintenance.AssetMeter", {
        assetId: prefix + "_COMP",
        readingDate: at,
        productMeterId: prefix + "_HOURS",
        productMeterTypeId: "PdMtrMotorTime",
        meterValue: value,
        readingReasonEnumId: reasonEnumId
    })
}
const due = (maintenanceScheduleId, asOfDate = null) =>
    as(state.planner, S + "get#MaintenanceDue", {maintenanceScheduleId, asOfDate}).due
const plan = parameters => as(state.planner, S + "store#MaintenanceSchedule", Object.assign({operationKey: key()}, parameters))
const schedule = maintenanceScheduleId =>
    ec.entity.find("mantle.work.maintenance.MaintenanceSchedule").condition({maintenanceScheduleId}).disableAuthz().one()
const termsOf = maintenanceScheduleId =>
    Array.from(
        ec.entity.find("mantle.work.maintenance.MaintenanceScheduleTerm").condition({maintenanceScheduleId}).disableAuthz().list()
    )

spec({
    stepwise: true,
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        organization(orgA)
        organization(orgB)
        facility(prefix + "_SITE", null, orgA, "America/Chicago", "FcTpBuilding")
        facility(prefix + "_ROOM", prefix + "_SITE", null, null)
        facility(prefix + "_ROOM2", prefix + "_SITE", null, null)
        facility(prefix + "_ROOM3", prefix + "_SITE", null, null)
        // a site with no time zone anywhere above its room
        facility(prefix + "_NOZONE", null, orgA, null, "FcTpBuilding")
        facility(prefix + "_NOZONE_ROOM", prefix + "_NOZONE", null, null)
        facility(prefix + "_OTHER", null, orgB, "America/Chicago", "FcTpBuilding")
        call("create#mantle.product.Product", {
            productId: prefix + "_MODEL",
            productName: "Due model",
            productTypeEnumId: "PtAsset",
            assetTypeEnumId: "AstTpEquipment"
        })
        call("create#mantle.product.maintenance.ProductMeter", {
            productMeterId: prefix + "_HOURS",
            productId: prefix + "_MODEL",
            productMeterTypeId: "PdMtrMotorTime",
            meterUomId: "TF_hr",
            meterName: "Run hours",
            isCumulative: "Y"
        })
        call("create#mantle.product.maintenance.ProductMaintenance", {
            productMaintenanceId: prefix + "_SERVICE",
            productId: prefix + "_MODEL",
            maintenanceTypeEnumId: "MntTpOilChange",
            description: "Oil every 500 hours",
            intervalQuantity: 500,
            intervalProductMeterId: prefix + "_HOURS"
        })
        call("create#mantle.product.asset.Asset", {
            assetId: prefix + "_COMP",
            assetTypeEnumId: "AstTpEquipment",
            assetName: "Due compressor",
            productId: prefix + "_MODEL",
            ownerPartyId: orgA,
            facilityId: prefix + "_ROOM"
        })
        procedure(prefix + "_PROC_COMP", true, {applicableProductId: prefix + "_MODEL"})
        procedure(prefix + "_PROC_ROOM", true, {applicableFacilityTypeEnumId: "FcTpRoom"})
        procedure(prefix + "_PROC_DRAFT", false, {applicableFacilityTypeEnumId: "FcTpRoom"})
        // People's holiday calendar of the organization (a WcatHoliday category) with Memorial Day 2027, a Monday
        call("create#mantle.work.effort.WorkEffortCategory", {
            workEffortCategoryId: prefix + "_HOLIDAYS",
            categoryTypeEnumId: "WcatHoliday",
            description: "Due holidays",
            ownerPartyId: orgA
        })
        call("create#mantle.work.effort.WorkEffort", {
            workEffortId: prefix + "_MEMORIAL",
            workEffortTypeEnumId: "WetEvent",
            purposeEnumId: "WepHoliday",
            workEffortName: "Memorial Day",
            allDayStart: "2027-05-31"
        })
        call("create#mantle.work.effort.WorkEffortCategoryAppl", {
            workEffortId: prefix + "_MEMORIAL",
            workEffortCategoryId: prefix + "_HOLIDAYS"
        })
        state.planner = user("PLANNER", ["MAINTENANCE_VIEW", "MAINTENANCE_PLAN"])
        state.reader = user("READER", ["MAINTENANCE_VIEW"])
        state.otherPlanner = user("OTHER", ["MAINTENANCE_VIEW", "MAINTENANCE_PLAN"], orgB)
    },
    cleanupSpec() {
        ec.message.clearErrors()
        login("john.doe")
    }
})

feature(
    "activation needs the target's time zone and a named procedure that qualifies, none needed; a reader may not write, another organization not read or list",
    {
        when() {
            const noZone = plan({
                facilityId: prefix + "_NOZONE_ROOM",
                intervalQuantity: 1,
                intervalUomId: "TF_mon",
                firstDueLocal: "2027-01-31 09:00",
                templateWorkEffortId: prefix + "_PROC_ROOM"
            })
            const noZoneActivate = as(state.planner, S + "store#MaintenanceSchedule", {
                maintenanceScheduleId: noZone.maintenanceScheduleId,
                action: "activate"
            })
            const operationKey = key()
            const parameters = {
                operationKey,
                facilityId: prefix + "_ROOM2",
                intervalQuantity: 1,
                intervalUomId: "TF_mon",
                firstDueLocal: "2027-01-31 09:00"
            }
            const roomPlan = as(state.planner, S + "store#MaintenanceSchedule", parameters)
            const retry = as(state.planner, S + "store#MaintenanceSchedule", parameters)
            const changedRetry = as(
                state.planner,
                S + "store#MaintenanceSchedule",
                Object.assign({}, parameters, {intervalQuantity: 2})
            )
            const id = roomPlan.maintenanceScheduleId
            // with no procedure nothing keeps the draft from activation (the user's call, Nov 12)
            const noProcedure = as(state.planner, S + "get#MaintenanceSchedule", {maintenanceScheduleId: id})
            // the draft procedure does not qualify; the approved room inspection does
            const store = templateWorkEffortId =>
                as(state.planner, S + "store#MaintenanceSchedule", {
                    maintenanceScheduleId: id,
                    intervalQuantity: 1,
                    intervalUomId: "TF_mon",
                    firstDueLocal: "2027-01-31 09:00",
                    templateWorkEffortId
                })
            store(prefix + "_PROC_DRAFT")
            const draftProcedure = as(state.planner, S + "store#MaintenanceSchedule", {
                maintenanceScheduleId: id,
                action: "activate"
            })
            const findings = as(state.planner, S + "get#MaintenanceSchedule", {maintenanceScheduleId: id}).findings
            store(prefix + "_PROC_ROOM")
            const readerActivates = as(state.reader, S + "store#MaintenanceSchedule", {
                maintenanceScheduleId: id,
                action: "activate"
            })
            const activated = as(state.planner, S + "store#MaintenanceSchedule", {maintenanceScheduleId: id, action: "activate"})
            const otherReads = as(state.otherPlanner, S + "get#MaintenanceSchedule", {maintenanceScheduleId: id})
            const listed = as(state.planner, S + "find#MaintenanceSchedules", {facilityId: prefix + "_SITE"}).scheduleList
            state.roomPlan = id
            // a plan with no procedure, its estimate kept for P14's ad hoc work, is activated
            const adHoc = plan({
                facilityId: prefix + "_ROOM2",
                intervalQuantity: 1,
                intervalUomId: "TF_yr",
                firstDueLocal: "2027-06-01 08:00",
                estimatedWorkTime: 2
            })
            const adHocActivated = as(state.planner, S + "store#MaintenanceSchedule", {
                maintenanceScheduleId: adHoc.maintenanceScheduleId,
                action: "activate"
            })
            const adHocRead = as(state.planner, S + "get#MaintenanceSchedule", {
                maintenanceScheduleId: adHoc.maintenanceScheduleId
            })
            // another organization's procedure, and a first due date with a zone, are refused
            const foreignProcedure = as(state.otherPlanner, S + "store#MaintenanceSchedule", {
                facilityId: prefix + "_OTHER",
                intervalQuantity: 1,
                intervalUomId: "TF_mon",
                firstDueLocal: "2027-05-31 09:00",
                templateWorkEffortId: prefix + "_PROC_ROOM"
            })
            const zoned = plan({
                facilityId: prefix + "_ROOM2",
                intervalQuantity: 1,
                intervalUomId: "TF_mon",
                firstDueLocal: "2027-01-31T15:00:00Z"
            })
            // another organization's planner lists none of the plans, nor their due
            const otherList = as(state.otherPlanner, S + "find#MaintenanceSchedules", {statusId: "all"}).scheduleList
            const otherDue = as(state.otherPlanner, S + "find#MaintenanceDue", {}).dueList
            return {
                noZoneActivate,
                roomPlan,
                retry,
                changedRetry,
                noProcedure,
                findings,
                draftProcedure,
                readerActivates,
                activated,
                otherReads,
                listed,
                terms: termsOf(id),
                adHocActivated,
                adHocRead,
                foreignProcedure,
                zoned,
                otherList,
                otherDue
            }
        },
        then(out) {
            out.noZoneActivate == "ZONE_REQUIRED"
            out.retry.maintenanceScheduleId == out.roomPlan.maintenanceScheduleId
            out.retry.repeated == true
            out.changedRetry == "OPERATION_KEY_CONFLICT"
            out.noProcedure.findings.length == 0
            out.noProcedure.canActivate == true
            out.draftProcedure == "PROCEDURE_NOT_QUALIFIED"
            out.findings.some(row => row.code == "PROCEDURE_NOT_QUALIFIED")
            out.readerActivates == "PERMISSION_DENIED"
            out.activated.statusId == "MschActive"
            out.otherReads == "RECORD_UNAVAILABLE"
            out.listed.some(row => row.maintenanceScheduleId == out.roomPlan.maintenanceScheduleId && row.statusText == "Active")
            // a draft's terms change in place
            out.terms.length == 1
            out.adHocActivated.statusId == "MschActive"
            out.adHocRead.term.estimatedWorkTime == 2
            out.adHocRead.term.templateWorkEffortId == null
            out.foreignProcedure == "VALUE_INVALID"
            out.zoned == "DATE_INVALID"
            out.otherList.length == 0
            out.otherDue.length == 0
        }
    }
)

feature("a monthly plan's 31st clamps to a short month and returns to the 31st; an early completion covers its due date", {
    when() {
        const id = state.roomPlan
        // done long before the plan (before December 31, one interval ahead of the first due date): it covers nothing
        workOrder(prefix + "_WO_OLD", id, null, "WeComplete", "2026-11-15T16:00:00Z")
        const before = due(id, "2027-02-15T12:00:00Z")
        // done a day early: it covers January's 31st; then done on February's last day
        workOrder(prefix + "_WO_JAN", id, null, "WeComplete", "2027-01-30T16:00:00Z")
        const february = due(id, "2027-02-15T12:00:00Z")
        workOrder(prefix + "_WO_FEB", id, null, "WeClosed", "2027-02-28T18:00:00Z")
        const march = due(id, "2027-03-01T12:00:00Z")
        return {before, february, march}
    },
    then({before, february, march}) {
        before.dueDateText == "2027-01-31 09:00 America/Chicago"
        before.state == "overdue"
        before.overdueCount == 1
        february.dueDateText == "2027-02-28 09:00 America/Chicago"
        february.explanation.some(line => line.includes("the 31st falls in a shorter month"))
        march.dueDateText == "2027-03-31 09:00 America/Chicago"
        march.state == "upcoming"
        march.lastCompletionWorkEffortId == prefix + "_WO_FEB"
    }
})

feature("a daylight-saving change keeps the local due time; a holiday moves the planned day and not the due date", {
    when() {
        // weekly from Monday March 8, 2027 at 09:00 Central (CST); daylight saving starts March 14
        const weekly = plan({
            facilityId: prefix + "_ROOM3",
            intervalQuantity: 1,
            intervalUomId: "TF_wk",
            firstDueLocal: "2027-03-08 09:00",
            templateWorkEffortId: prefix + "_PROC_ROOM"
        })
        workOrder(prefix + "_WO_WEEK", weekly.maintenanceScheduleId, null, "WeComplete", "2027-03-08T16:00:00Z")
        const afterChange = due(weekly.maintenanceScheduleId, "2027-03-10T12:00:00Z")
        // monthly on the last Monday of May 2027, Memorial Day in the organization's People holiday calendar
        const holiday = plan({
            facilityId: prefix + "_ROOM3",
            intervalQuantity: 1,
            intervalUomId: "TF_mon",
            firstDueLocal: "2027-05-31 09:00",
            businessDaysOnly: "Y",
            holidayCategoryId: prefix + "_HOLIDAYS",
            templateWorkEffortId: prefix + "_PROC_ROOM"
        })
        const moved = due(holiday.maintenanceScheduleId, "2027-05-01T12:00:00Z")
        // another organization's holiday calendar is refused
        const otherCalendar = as(state.otherPlanner, S + "store#MaintenanceSchedule", {
            facilityId: prefix + "_OTHER",
            intervalQuantity: 1,
            intervalUomId: "TF_mon",
            firstDueLocal: "2027-05-31 09:00",
            holidayCategoryId: prefix + "_HOLIDAYS"
        })
        return {afterChange, moved, otherCalendar}
    },
    then({afterChange, moved, otherCalendar}) {
        afterChange.dueDateText == "2027-03-15 09:00 America/Chicago"
        // 09:00 CDT is 14:00 UTC (it was 15:00 UTC a week before)
        Number(afterChange.dueDate) == Date.parse("2027-03-15T14:00:00Z")
        moved.dueDateText == "2027-05-31 09:00 America/Chicago"
        moved.plannedDateText == "2027-06-01 09:00 America/Chicago"
        moved.moved == true
        moved.explanation.some(line => line.includes("2027-05-31 is a holiday"))
        otherCalendar == "VALUE_INVALID"
    }
})

feature(
    "a meter plan advances from counted completions only: a planned or cancelled maintenance and a synthetic threshold advance nothing",
    {
        when() {
            // the model default is every 500 hours; this plan overrides it to 250 from a baseline of 1000
            const created = plan({
                assetId: prefix + "_COMP",
                productMaintenanceId: prefix + "_SERVICE",
                intervalQuantity: 250,
                baselineValue: 1000,
                baselineDate: daysAgo(20),
                templateWorkEffortId: prefix + "_PROC_COMP"
            })
            const id = created.maintenanceScheduleId
            state.meterPlan = id
            // a completed record of the model default from before the plan's baseline, its reading 800: the plan's baseline stays
            call("mantle.product.EquipmentServices.create#AssetMaintenance", {
                assetId: prefix + "_COMP",
                productMaintenanceId: prefix + "_SERVICE",
                statusId: "AsMntCompleted",
                maintenanceDate: daysAgo(60),
                intervalQuantity: 800
            })
            reading(daysAgo(10), 1100)
            reading(daysAgo(5), 1200)
            const first = due(id)
            // a planned maintenance record of the model default with a future threshold (create#AssetMaintenance makes its synthetic
            // reading of 1600), and a cancelled work order of the plan with a reading taken in it
            call("mantle.product.EquipmentServices.create#AssetMaintenance", {
                assetId: prefix + "_COMP",
                productMaintenanceId: prefix + "_SERVICE",
                statusId: "AsMntScheduled",
                maintenanceDate: daysAgo(4),
                intervalQuantity: 1600
            })
            workOrder(prefix + "_WO_CANCELLED", id, prefix + "_COMP", "WeCancelled", daysAgo(3), 1210)
            const unmoved = due(id)
            // a completed work order of the plan took a reading of 1220: the new baseline
            workOrder(prefix + "_WO_DONE", id, prefix + "_COMP", "WeComplete", daysAgo(2), 1220)
            const completed = due(id)
            // a reading, then the meter replaced (a reset to 0) and read again: the usage is counted across the reset
            reading(new Date(Date.now() - 36 * 3600 * 1000), 1230)
            reading(new Date(Date.now() - 30 * 3600 * 1000), 0, "AmrReset")
            reading(new Date(Date.now() - 24 * 3600 * 1000), 30)
            const reset = due(id)
            // forty days on, the last reading is stale: unknown, not "not due"
            const stale = due(id, new Date(Date.now() + 40 * dayMs))
            const activated = as(state.planner, S + "store#MaintenanceSchedule", {maintenanceScheduleId: id, action: "activate"})
            return {first, unmoved, completed, reset, stale, activated}
        },
        then({first, unmoved, completed, reset, stale, activated}) {
            first.state == "upcoming"
            first.baselineValue == 1000
            first.nextThreshold == 1250
            first.remaining == 50
            first.explanation.some(line => line.includes("the model default is 500 h"))
            unmoved.state == "upcoming"
            unmoved.baselineValue == 1000
            unmoved.nextThreshold == 1250
            unmoved.lastReadingValue == 1210
            completed.baselineValue == 1220
            completed.nextThreshold == 1470
            completed.baselineText.includes(prefix + "_WO_DONE")
            reset.usage == 40
            reset.nextThreshold == 240
            reset.remaining == 210
            stale.state == "unknown"
            stale.reasonCode == "READING_STALE"
            stale.explanation.some(line => line.includes("Reading older than 30 days"))
            activated.statusId == "MschActive"
        }
    }
)

feature(
    "a change of an active plan's terms starts the next term with its reason and leaves the earlier term and its work alone",
    {
        when() {
            const id = state.meterPlan
            const stored = as(state.planner, S + "get#MaintenanceSchedule", {maintenanceScheduleId: id})
            const change = Object.assign({}, stored.storedTerm, {
                maintenanceScheduleId: id,
                expectedRevision: Number(schedule(id).revision),
                intervalQuantity: 300
            })
            const noReason = as(state.planner, S + "store#MaintenanceSchedule", change)
            const stale = as(
                state.planner,
                S + "store#MaintenanceSchedule",
                Object.assign({}, change, {expectedRevision: 1, changeReason: "Heavier use"})
            )
            const changed = as(
                state.planner,
                S + "store#MaintenanceSchedule",
                Object.assign({}, change, {changeReason: "Heavier use"})
            )
            const work = ec.entity
                .find("mantle.work.effort.WorkEffort")
                .condition("workEffortId", prefix + "_WO_DONE")
                .disableAuthz()
                .one()
            const after = due(id)
            const terms = termsOf(id)
            const history = as(state.planner, S + "get#MaintenanceSchedule", {maintenanceScheduleId: id}).terms
            // a rename names no term: no reason needed, the terms as they were
            const renamed = as(state.planner, S + "store#MaintenanceSchedule", {
                maintenanceScheduleId: id,
                scheduleName: "Due compressor oil"
            })
            const renamedTerms = termsOf(id)
            // a change planned for later is not cut short by one before it
            const later = Object.assign({}, change, {expectedRevision: null, changeReason: "Season ahead"})
            const planned = as(
                state.planner,
                S + "store#MaintenanceSchedule",
                Object.assign({}, later, {intervalQuantity: 400, effectiveDate: new Date(Date.now() + 10 * dayMs)})
            )
            const between = as(
                state.planner,
                S + "store#MaintenanceSchedule",
                Object.assign({}, later, {intervalQuantity: 350, effectiveDate: new Date(Date.now() + 5 * dayMs)})
            )
            const ended = as(state.planner, S + "store#MaintenanceSchedule", {maintenanceScheduleId: id, action: "end"})
            return {noReason, stale, changed, terms, work, after, ended, history, renamed, renamedTerms, planned, between}
        },
        then({noReason, stale, changed, terms, work, after, ended, history, renamed, renamedTerms, planned, between}) {
            noReason == "REASON_REQUIRED"
            stale == "RECORD_CHANGED"
            changed.statusId == "MschActive"
            terms.length == 2
            terms.filter(row => row.thruDate == null).length == 1
            terms.find(row => row.thruDate == null).changeReason == "Heavier use"
            terms.some(row => row.thruDate != null && Number(String(row.intervalQuantity)) == 250)
            // the work done under the earlier term is as it was, and its reading stays the baseline
            work.statusId == "WeComplete"
            after.baselineValue == 1220
            after.usage == 40
            after.nextThreshold == 290
            history.some(row => row.intervalText == "300 hr") && history.some(row => row.intervalText == "250 hr")
            renamed.revision > changed.revision
            renamedTerms.length == 2
            schedule(state.meterPlan).scheduleName == "Due compressor oil"
            planned.statusId == "MschActive"
            between == "DATE_INVALID"
            ended == "REASON_REQUIRED"
        }
    }
)

feature("a plan whose target moved to another organization is not changed or activated, and may be ended", {
    when() {
        call("create#mantle.product.asset.Asset", {
            assetId: prefix + "_MOVER",
            assetTypeEnumId: "AstTpEquipment",
            assetName: "Due mover",
            productId: prefix + "_MODEL",
            ownerPartyId: orgA,
            facilityId: prefix + "_ROOM"
        })
        const created = plan({
            assetId: prefix + "_MOVER",
            triggerEnumId: "MstCalendar",
            intervalQuantity: 1,
            intervalUomId: "TF_yr",
            firstDueLocal: "2027-03-01 08:00"
        })
        const id = created.maintenanceScheduleId
        call("update#mantle.product.asset.Asset", {assetId: prefix + "_MOVER", ownerPartyId: orgB})
        const activate = as(state.planner, S + "store#MaintenanceSchedule", {maintenanceScheduleId: id, action: "activate"})
        const change = as(state.planner, S + "store#MaintenanceSchedule", {
            maintenanceScheduleId: id,
            intervalQuantity: 2,
            intervalUomId: "TF_yr",
            firstDueLocal: "2027-03-01 08:00"
        })
        const ended = as(state.planner, S + "store#MaintenanceSchedule", {
            maintenanceScheduleId: id,
            action: "end",
            changeReason: "Sold to Retail"
        })
        return {activate, change, ended}
    },
    then({activate, change, ended}) {
        activate == "TARGET_MOVED"
        change == "TARGET_MOVED"
        ended.statusId == "MschEnded"
    }
})
