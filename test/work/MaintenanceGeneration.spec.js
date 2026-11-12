// Preventive generation, occurrences and compliance (mantle.work.MaintenancePlanServices, MaintenancePlans.js; IronStone Maintenance
// design §5.1, DueMaintenance, §8 PreventiveComplianceReport, §11.2 "PM concurrency and missed work"; impl-maintenance P14): the job
// and a planner make one occurrence and one work order of an obligation (ad hoc, from the plan's name and estimate, the plan set on
// it, the planners told), the occurrence's key a real unique key and a retry under the operation key answering its first result; one
// failing plan in a batch named and the others generated, a retired procedure blocking its plan; a cancelled order counted as no
// completion (the obligation open again and made again); missed due dates coalesced into one catch-up, not on time; a reopened
// order making no second next order; a meter plan's work completed only with its reading, which becomes the baseline, and a stale
// meter blocked until a reading; a skip and a correction with their reasons; a reader and another organization refused. Review:
// the job's scope is the job's alone (a person who runs it generates as themselves); obligations stay under the term they fell in
// when the interval changes (F186); a plan's work reminds its assignees of its due date.
// Standalone: spec-local organizations, facilities, an equipment model with a counting meter, a procedure, groups and users; the
// services called as each user with the artifact check aside (their own permission and scope checks decide).
// Run: ./moq test mr-mantle --spec MaintenanceGeneration
const prefix = "MNT_GEN"
const orgA = prefix + "_A",
    orgB = prefix + "_B",
    since = "2000-01-01T00:00:00Z",
    zone = "America/Chicago"
const S = "mantle.work.MaintenancePlanServices."
const W = "mantle.work.MaintenanceServices."
const OCCURRENCE = "mantle.work.maintenance.MaintenanceOccurrence"
const state = {}
const dayMs = 24 * 3600 * 1000
let keySeq = 0
const key = () => prefix + "-op-" + ++keySeq
// a local date in the facilities' zone, days from now
const localDay = days => ec.l10n.format(new Date(Date.now() + days * dayMs), "yyyy-MM-dd", null, zone)

// the service's answer as a user, or the reason code it refuses with, in its own transaction
function as(username, service, parameters = {}) {
    if (username) login(username)
    else ec.user.logoutUser()
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
    call("create#moqui.security.UserGroup", {userGroupId: id, description: "Generation " + kind})
    for (const permission of permissions)
        call("create#moqui.security.UserGroupPermission", {userGroupId: id, userPermissionId: permission, fromDate: since})
    const partyId = prefix + "_P_" + kind
    call("create#mantle.party.Party", {partyId, partyTypeEnumId: "PtyPerson"})
    call("create#mantle.party.Person", {partyId, firstName: "Generation", lastName: kind})
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
function equipment(assetId) {
    call("create#mantle.product.asset.Asset", {
        assetId,
        assetTypeEnumId: "AstTpEquipment",
        assetName: assetId,
        productId: prefix + "_MODEL",
        ownerPartyId: orgA,
        facilityId: prefix + "_ROOM"
    })
}
function reading(assetId, at, value) {
    call("create#mantle.product.maintenance.AssetMeter", {
        assetId,
        readingDate: at,
        productMeterId: prefix + "_HOURS",
        productMeterTypeId: "PdMtrMotorTime",
        meterValue: value,
        readingReasonEnumId: "AmrReading"
    })
}
// an active plan (a draft stored, then activated)
function activePlan(parameters) {
    const made = as(state.planner, S + "store#MaintenanceSchedule", Object.assign({operationKey: key()}, parameters))
    as(state.planner, S + "store#MaintenanceSchedule", {maintenanceScheduleId: made.maintenanceScheduleId, action: "activate"})
    return made.maintenanceScheduleId
}
const generate = (username, parameters) => as(username, S + "generate#MaintenanceWorkOrders", parameters)
const due = maintenanceScheduleId => as(state.planner, S + "get#MaintenanceDue", {maintenanceScheduleId}).due
const occurrences = maintenanceScheduleId =>
    Array.from(ec.entity.find(OCCURRENCE).condition({maintenanceScheduleId}).orderBy("dueDate").disableAuthz().list())
const orders = maintenanceScheduleId =>
    Array.from(
        ec.entity.find("mantle.work.maintenance.MaintenanceWorkOrder").condition({maintenanceScheduleId}).disableAuthz().list()
    )
const root = workEffortId => ec.entity.find("mantle.work.effort.WorkEffort").condition({workEffortId}).disableAuthz().one()
// the supervisor approves, starts and completes a work order (the outcome, and for equipment the disposition)
function finish(workEffortId, extra = {}) {
    const move = (action, more = {}) =>
        as(state.supervisor, W + "transition#MaintenanceWorkOrder", Object.assign({workEffortId, action}, more))
    if (root(workEffortId).statusId === "WeInPlanning") move("approve")
    if (root(workEffortId).statusId === "WeApproved") move("start")
    return move("complete", Object.assign({outcomeEnumId: "MoutDone"}, extra))
}
const compliance = (maintenanceScheduleId, fromDays) =>
    as(state.planner, "mantle.work.MaintenanceReportServices.get#MaintenanceCompliance", {
        maintenanceScheduleId,
        fromDate: new Date(Date.now() - fromDays * dayMs),
        pageSize: 50
    })

spec({
    stepwise: true,
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        organization(orgA)
        organization(orgB)
        facility(prefix + "_SITE", null, orgA, zone, "FcTpBuilding")
        for (const room of ["_ROOM", "_ROOM2", "_ROOM3", "_ROOM4"]) facility(prefix + room, prefix + "_SITE", null, null)
        call("create#mantle.product.Product", {
            productId: prefix + "_MODEL",
            productName: "Generation model",
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
        for (const asset of ["_COMP", "_STALE", "_STOCK"]) equipment(prefix + asset)
        // an approved room procedure in effect
        call("create#mantle.work.effort.WorkEffort", {
            workEffortId: prefix + "_PROC",
            workEffortTypeEnumId: "WetTask",
            purposeEnumId: "WepMaintenance",
            isTemplate: "Y",
            statusId: "WeApproved",
            statusFlowId: "WorkEffortProcedure",
            ownerPartyId: orgA,
            workEffortName: "Generation room check"
        })
        call("create#mantle.work.effort.WorkEffortProcessPolicy", {
            workEffortId: prefix + "_PROC",
            fromDate: since,
            processPolicyEnumId: "WppMaintenanceProcedure",
            guardsExecution: "Y",
            effectiveFromDate: since,
            approvedDate: since,
            applicableFacilityTypeEnumId: "FcTpRoom"
        })
        state.planner = user("PLANNER", ["MAINTENANCE_VIEW", "MAINTENANCE_PLAN"])
        state.otherPlanner = user("PLANNER2", ["MAINTENANCE_VIEW", "MAINTENANCE_PLAN"])
        state.reader = user("READER", ["MAINTENANCE_VIEW"])
        // the supervisor holds no resource edit: the reading a meter plan's Complete asks for is the completer's (review R2)
        state.supervisor = user("SUPER", ["MAINTENANCE_VIEW", "MAINTENANCE_SUPERVISE"])
        state.foreign = user("FOREIGN", ["MAINTENANCE_VIEW", "MAINTENANCE_PLAN"], orgB)
        // review: another organization's maintenance administrator and planner, and a technician of A
        state.foreignAdmin = user("FADMIN", ["MAINTENANCE_VIEW", "MAINTENANCE_PLAN", "MAINTENANCE_SETTINGS_EDIT"], orgB)
        state.tech = user("TECH", ["MAINTENANCE_ASSIGNED_VIEW", "MAINTENANCE_EXECUTE"])
    },
    cleanupSpec() {
        ec.message.clearErrors()
        login("john.doe")
    }
})

feature(
    "the job and a planner make one occurrence and one ad hoc work order of an obligation; the key is unique and a retry answers the first",
    {
        when() {
            // monthly, the first due date two days ago: overdue, ad hoc with its estimate
            const id = activePlan({
                scheduleName: "Generation room walk",
                facilityId: prefix + "_ROOM",
                intervalQuantity: 1,
                intervalUomId: "TF_mon",
                firstDueLocal: localDay(-2) + " 08:00",
                estimatedWorkTime: 2
            })
            state.walkPlan = id
            const preview = generate(state.planner, {maintenanceScheduleId: id, preview: true})
            const afterPreview = occurrences(id).length
            // the job (no user) makes the work; the planner's generation of the same plan then finds it open
            const job = as(null, S + "run#MaintenanceGeneration", {batchSize: 2})
            const planner = generate(state.planner, {maintenanceScheduleId: id})
            const made = occurrences(id)
            const order = orders(id)
            const work = root(order[0].workEffortId)
            // the obligation's key is unique: a second row of it is refused by the database
            let duplicate = "created"
            try {
                ec.transaction.runRequireNew(null, "spec duplicate", () =>
                    ec.service
                        .sync()
                        .name("create#" + OCCURRENCE)
                        .parameters({maintenanceScheduleId: id, obligationKey: made[0].obligationKey, statusId: "MocOpen"})
                        .disableAuthz()
                        .call()
                )
                if (ec.message.hasError()) duplicate = "refused"
            } catch (error) {
                duplicate = "refused"
            }
            ec.message.clearErrors()
            // a planner's generation under an operation key, retried with the same key, answers its first result
            const keyed = activePlan({
                facilityId: prefix + "_ROOM2",
                intervalQuantity: 1,
                intervalUomId: "TF_yr",
                firstDueLocal: localDay(-1) + " 09:00",
                estimatedWorkTime: 1
            })
            state.keyedPlan = keyed
            const operationKey = key()
            const first = generate(state.planner, {maintenanceScheduleId: keyed, operationKey})
            const retry = generate(state.planner, {maintenanceScheduleId: keyed, operationKey})
            const notices = Array.from(
                ec.entity
                    .find("moqui.security.user.NotificationMessageUser")
                    .condition({userId: state.planner})
                    .disableAuthz()
                    .list()
            )
                .map(row =>
                    ec.entity
                        .find("moqui.security.user.NotificationMessage")
                        .condition({notificationMessageId: row.notificationMessageId})
                        .disableAuthz()
                        .one()
                )
                .filter(row => row?.topic === "MaintenanceDue")
            return {preview, afterPreview, job, planner, made, order, work, duplicate, first, retry, keyed, notices}
        },
        then({preview, afterPreview, job, planner, made, order, work, duplicate, first, retry, keyed, notices}) {
            preview.results[0].outcome == "ready"
            afterPreview == 0
            job.generatedCount >= 1
            planner.results[0].outcome == "open"
            planner.results[0].code == "WORK_OPEN"
            planner.results[0].workEffortId == order[0].workEffortId
            made.length == 1
            made[0].statusId == "MocGenerated"
            made[0].generatedByUserId == null
            made[0].termFromDate != null
            order.length == 1
            order[0].maintenanceKindEnumId == "MkPreventive"
            order[0].sourceEnumId == "MsrcSchedule"
            work.workEffortName == "Generation room walk"
            Number(String(work.estimatedWorkTime)) == 2
            work.statusId == "WeInPlanning"
            duplicate == "refused"
            first.results[0].outcome == "generated"
            retry.results[0].outcome == "generated"
            retry.results[0].repeated == true
            retry.results[0].workEffortId == first.results[0].workEffortId
            orders(keyed).length == 1
            notices.length >= 1
        }
    }
)

feature("one failing plan in a batch is named and the others generated; a retired procedure blocks its plan", {
    when() {
        // a second room procedure, retired once its plan is active
        call("create#mantle.work.effort.WorkEffort", {
            workEffortId: prefix + "_PROC2",
            workEffortTypeEnumId: "WetTask",
            purposeEnumId: "WepMaintenance",
            isTemplate: "Y",
            statusId: "WeApproved",
            statusFlowId: "WorkEffortProcedure",
            ownerPartyId: orgA,
            workEffortName: "Generation retired check"
        })
        call("create#mantle.work.effort.WorkEffortProcessPolicy", {
            workEffortId: prefix + "_PROC2",
            fromDate: since,
            processPolicyEnumId: "WppMaintenanceProcedure",
            guardsExecution: "Y",
            effectiveFromDate: since,
            approvedDate: since,
            applicableFacilityTypeEnumId: "FcTpRoom"
        })
        const retired = activePlan({
            facilityId: prefix + "_ROOM3",
            intervalQuantity: 1,
            intervalUomId: "TF_wk",
            firstDueLocal: localDay(-1) + " 08:00",
            templateWorkEffortId: prefix + "_PROC2"
        })
        const broken = activePlan({
            assetId: prefix + "_STOCK",
            triggerEnumId: "MstCalendar",
            intervalQuantity: 1,
            intervalUomId: "TF_mon",
            firstDueLocal: localDay(-1) + " 08:00",
            estimatedWorkTime: 1
        })
        const good = activePlan({
            scheduleName: "Generation room four check",
            facilityId: prefix + "_ROOM4",
            intervalQuantity: 1,
            intervalUomId: "TF_mon",
            firstDueLocal: localDay(-5) + " 08:00",
            templateWorkEffortId: prefix + "_PROC"
        })
        state.goodPlan = good
        // after activation the procedure of the first is retired and the equipment of the second becomes stock
        call("update#mantle.work.effort.WorkEffort", {workEffortId: prefix + "_PROC2", statusId: "WeClosed"})
        call("update#mantle.product.asset.Asset", {assetId: prefix + "_STOCK", assetTypeEnumId: "AstTpInventory"})
        const batch = generate(state.planner, {maintenanceScheduleIds: [retired, broken, good]})
        const byPlan = Object.fromEntries(batch.results.map(row => [row.maintenanceScheduleId, row]))
        const goodWork = root(orders(good)[0]?.workEffortId || "_NA_")
        return {batch, retiredOut: byPlan[retired], broken: byPlan[broken], goodOut: byPlan[good], goodWork}
    },
    then({batch, retiredOut, broken, goodOut, goodWork}) {
        batch.results.length == 3
        retiredOut.outcome == "blocked"
        retiredOut.code == "PROCEDURE_NOT_QUALIFIED"
        broken.outcome == "failed"
        broken.code == "RECORD_UNAVAILABLE"
        goodOut.outcome == "generated"
        batch.generatedCount == 1 && batch.failedCount == 1 && batch.blockedCount == 1
        goodWork.workEffortName == "Generation room four check"
        goodWork.purposeEnumId == "WepMaintenance"
    }
})

feature("a cancelled order counts as no completion: the obligation is open again and its work made again", {
    when() {
        const id = state.goodPlan
        const first = orders(id)[0].workEffortId
        const cancelled = as(state.supervisor, W + "transition#MaintenanceWorkOrder", {
            workEffortId: first,
            action: "cancel",
            cancelReasonEnumId: "McrNotNeeded"
        })
        const opened = occurrences(id)
        const after = due(id)
        const again = generate(state.planner, {maintenanceScheduleId: id})
        const report = compliance(id, 30)
        return {cancelled, opened, after, again, first, made: occurrences(id), report}
    },
    then({cancelled, opened, after, again, first, made, report}) {
        cancelled.statusId == "WeCancelled"
        opened.length == 1 && opened[0].statusId == "MocOpen" && opened[0].workEffortId == null
        after.state == "overdue"
        again.results[0].outcome == "generated"
        again.results[0].workEffortId != first
        made.length == 1 && made[0].statusId == "MocGenerated"
        made[0].maintenanceOccurrenceId == opened[0].maintenanceOccurrenceId
        report.summary.outstandingCount == 1 && report.summary.onTimeCount == 0
    }
})

feature("missed due dates are coalesced into one catch-up; its completion counts for each, late, and the plan moves on", {
    when() {
        // monthly from about three months ago: four missed due dates
        const id = activePlan({
            scheduleName: "Generation missed walk",
            facilityId: prefix + "_ROOM",
            intervalQuantity: 1,
            intervalUomId: "TF_mon",
            firstDueLocal: localDay(-95) + " 08:00",
            estimatedWorkTime: 1
        })
        state.missedPlan = id
        const before = due(id)
        const noReason = as(state.planner, S + "reconcile#MaintenanceSchedule", {maintenanceScheduleId: id, action: "coalesce"})
        const coalesced = as(state.planner, S + "reconcile#MaintenanceSchedule", {
            maintenanceScheduleId: id,
            action: "coalesce",
            changeReason: "The room was closed for the summer"
        })
        const rowsAfter = occurrences(id)
        const pending = compliance(id, 120)
        const done = finish(coalesced.workEffortId)
        const after = due(id)
        const report = compliance(id, 120)
        return {before, noReason, coalesced, rowsAfter, pending, done, after, report}
    },
    then({before, noReason, coalesced, rowsAfter, pending, done, after, report}) {
        before.overdueCount == 4
        noReason == "REASON_REQUIRED"
        coalesced.occurrenceIds.length == 4
        rowsAfter.filter(row => row.statusId == "MocCoalesced").length == 3
        rowsAfter.filter(row => row.catchUp == "Y").length == 1
        rowsAfter
            .filter(row => row.statusId == "MocCoalesced")
            .every(row => row.coveredByOccurrenceId == coalesced.occurrenceIds[0])
        pending.summary.outstandingCount == 4
        done.statusId == "WeComplete"
        after.overdueCount == 0
        after.state != "overdue"
        // four obligations due, none on time: the catch-up is not one compliant order
        report.summary.dueCount == 4
        report.summary.lateCount == 4
        report.summary.onTimeCount == 0
        report.summary.onTimePercent == 0
    }
})

feature("a reopened order makes no second next order and its completion counts once", {
    when() {
        // weekly from ten days ago: two missed due dates
        const id = activePlan({
            facilityId: prefix + "_ROOM2",
            intervalQuantity: 1,
            intervalUomId: "TF_wk",
            firstDueLocal: localDay(-10) + " 08:00",
            estimatedWorkTime: 1
        })
        const first = generate(state.planner, {maintenanceScheduleId: id}).results[0].workEffortId
        finish(first)
        const completedAt = occurrences(id)[0].completedDate
        const second = generate(state.planner, {maintenanceScheduleId: id}).results[0]
        // the first order reopened (a baseline path) and completed again
        call("update#mantle.work.effort.WorkEffort", {workEffortId: first, statusId: "WeInProgress"})
        const again = finish(first)
        const third = generate(state.planner, {maintenanceScheduleId: id}).results[0]
        return {id, first, completedAt, second, again, third, made: occurrences(id), count: orders(id).length}
    },
    then({first, completedAt, second, again, third, made, count}) {
        second.outcome == "generated"
        second.workEffortId != first
        again.statusId == "WeComplete"
        third.outcome == "open"
        third.workEffortId == second.workEffortId
        count == 2
        made.length == 2
        made.filter(row => row.statusId == "MocCompleted").length == 1
        Number(made.find(row => row.workEffortId == first).completedDate) == Number(completedAt)
    }
})

feature("a meter plan's work completes with its reading, the new baseline; a stale meter is blocked until a reading", {
    when() {
        reading(prefix + "_COMP", new Date(Date.now() - 10 * dayMs), 100)
        reading(prefix + "_COMP", new Date(Date.now() - dayMs), 400)
        const id = activePlan({
            assetId: prefix + "_COMP",
            triggerEnumId: "MstMeter",
            productMeterId: prefix + "_HOURS",
            intervalQuantity: 250,
            baselineValue: 100,
            baselineDate: new Date(Date.now() - 10 * dayMs),
            estimatedWorkTime: 1
        })
        const made = generate(state.planner, {maintenanceScheduleId: id}).results[0]
        const unread = finish(made.workEffortId, {dispositionEnumId: "MdispAvailable"})
        const read = finish(made.workEffortId, {dispositionEnumId: "MdispAvailable", meterValue: 410})
        const after = due(id)
        const occurrence = occurrences(id)[0]
        // a meter last read forty days ago
        reading(prefix + "_STALE", new Date(Date.now() - 40 * dayMs), 900)
        const stale = activePlan({
            assetId: prefix + "_STALE",
            triggerEnumId: "MstMeter",
            productMeterId: prefix + "_HOURS",
            intervalQuantity: 250,
            baselineValue: 800,
            baselineDate: new Date(Date.now() - 50 * dayMs)
        })
        const blocked = generate(state.planner, {maintenanceScheduleId: stale}).results[0]
        const skipMeter = as(state.planner, S + "reconcile#MaintenanceSchedule", {
            maintenanceScheduleId: stale,
            action: "skip",
            changeReason: "Not used"
        })
        return {made, unread, read, after, occurrence, blocked, skipMeter, staleOrders: orders(stale).length}
    },
    then({made, unread, read, after, occurrence, blocked, skipMeter, staleOrders}) {
        made.outcome == "generated"
        made.obligationText == "the threshold 350 hr"
        unread == "READING_REQUIRED"
        read.statusId == "WeComplete"
        occurrence.statusId == "MocCompleted"
        occurrence.obligationKey == "meter 350"
        after.baselineValue == 410
        after.nextThreshold == 660
        blocked.outcome == "blocked"
        blocked.code == "READING_STALE"
        blocked.message.startsWith("Request a reading")
        skipMeter == "VALUE_INVALID"
        staleOrders == 0
    }
})

feature("a skip and a correction keep their reasons; a reader and another organization may not generate", {
    when() {
        // the walk's order done, then its completion corrected as not counted: open again, the order kept
        const walk = state.walkPlan
        const order = orders(walk)[0].workEffortId
        finish(order)
        const completed = occurrences(walk)[0]
        const corrected = as(state.planner, S + "reconcile#MaintenanceSchedule", {
            maintenanceScheduleId: walk,
            action: "correct",
            maintenanceOccurrenceId: completed.maintenanceOccurrenceId,
            changeReason: "Done in the wrong room"
        })
        const afterCorrect = occurrences(walk)[0]
        const walkDue = due(walk)
        // the missed plan's next due date skipped with its reason
        const skipped = as(state.planner, S + "reconcile#MaintenanceSchedule", {
            maintenanceScheduleId: state.missedPlan,
            action: "skip",
            changeReason: "Room under renovation"
        })
        const skippedRow = ec.entity
            .find(OCCURRENCE)
            .condition({maintenanceOccurrenceId: skipped.occurrenceIds[0]})
            .disableAuthz()
            .one()
        const history = as(state.planner, S + "find#MaintenanceOccurrences", {maintenanceScheduleId: state.missedPlan})
        const reader = generate(state.reader, {maintenanceScheduleId: walk})
        const foreign = generate(state.foreign, {maintenanceScheduleId: walk})
        const foreignReconcile = as(state.foreign, S + "reconcile#MaintenanceSchedule", {
            maintenanceScheduleId: walk,
            action: "skip",
            changeReason: "Not ours"
        })
        return {order, corrected, afterCorrect, walkDue, skippedRow, history, reader, foreign, foreignReconcile}
    },
    then({order, afterCorrect, walkDue, skippedRow, history, reader, foreign, foreignReconcile}) {
        afterCorrect.statusId == "MocOpen"
        afterCorrect.uncountedWorkEffortId == order
        afterCorrect.decisionReason == "Done in the wrong room"
        root(order).statusId == "WeComplete"
        walkDue.state == "overdue"
        skippedRow.statusId == "MocSkipped"
        skippedRow.decisionReason == "Room under renovation"
        history.occurrenceList.some(row => row.statusText == "Skipped")
        history.occurrenceList.some(row => row.statusText == "Completed (catch-up)" && row.timelinessText == "Late")
        history.workList.length == 1
        reader == "PERMISSION_DENIED"
        foreign.results[0].outcome == "failed" && foreign.results[0].code == "RECORD_UNAVAILABLE"
        foreignReconcile == "RECORD_UNAVAILABLE"
    }
})

// P14 review R1: the job's scope (every organization) is the job's alone. A person who runs it (ec.service.job(...).run() as
// themselves) generates as a planner of their own organizations: another organization's administrator, who holds
// MAINTENANCE_SETTINGS_EDIT (the job's manage permission), reaches none of A's plans; a reader is refused.
feature("a person who runs the generation job generates in their own scope, never the job's", {
    when() {
        const before = ec.entity.find(OCCURRENCE).disableAuthz().count()
        const foreignAdmin = as(state.foreignAdmin, S + "run#MaintenanceGeneration", {batchSize: 2})
        const foreign = as(state.foreign, S + "run#MaintenanceGeneration", {})
        const reader = as(state.reader, S + "run#MaintenanceGeneration", {})
        return {before, after: ec.entity.find(OCCURRENCE).disableAuthz().count(), foreignAdmin, foreign, reader}
    },
    then({before, after, foreignAdmin, foreign, reader}) {
        foreignAdmin.scheduleCount == 0
        foreign.scheduleCount == 0
        reader == "PERMISSION_DENIED"
        after == before
    }
})

// P14 review (F186): a change of a calendar plan's interval leaves the obligations before it where they fell. Monthly from about
// three months ago, changed to weekly from a minute ahead: four days later the four monthly due dates and the first weekly one,
// three days ahead, are the missed ones (the weekly cadence read back over the months would make fourteen); compliance counts five.
feature("a change of a calendar plan's interval leaves the earlier obligations under their own term", {
    when() {
        const id = activePlan({
            facilityId: prefix + "_ROOM3",
            intervalQuantity: 1,
            intervalUomId: "TF_mon",
            firstDueLocal: localDay(-95) + " 08:00",
            estimatedWorkTime: 1
        })
        const stored = as(state.planner, S + "get#MaintenanceSchedule", {maintenanceScheduleId: id})
        const changed = as(
            state.planner,
            S + "store#MaintenanceSchedule",
            Object.assign({}, stored.storedTerm, {
                maintenanceScheduleId: id,
                intervalUomId: "TF_wk",
                changeReason: "Weekly from now",
                effectiveDate: new Date(Date.now() + 60 * 1000)
            })
        )
        const asOfDate = new Date(Date.now() + 4 * dayMs)
        const later = as(state.planner, S + "get#MaintenanceDue", {maintenanceScheduleId: id, asOfDate}).due
        const report = as(state.planner, "mantle.work.MaintenanceReportServices.get#MaintenanceCompliance", {
            maintenanceScheduleId: id,
            fromDate: new Date(Date.now() - 100 * dayMs),
            asOfDate
        })
        return {changed, later, report}
    },
    then({changed, later, report}) {
        changed.statusId == "MschActive"
        later.overdueCount == 5
        later.obligationKey == localDay(-95) + " 08:00"
        later.missed.slice(0, 4).every(row => Number(row.termFromDate) == Number(later.missed[0].termFromDate))
        later.missed[4].obligationKey == localDay(3) + " 08:00"
        Number(later.missed[4].termFromDate) != Number(later.missed[0].termFromDate)
        report.summary.dueCount == 5
        report.summary.outstandingCount == 5
    }
})

// P14 review: a plan's work reminds the person assigned to it a day before its due date (written for the assignee, not the
// planner who assigns), and a person taken off it keeps no reminder of it
feature("a plan's work reminds its assignee of its due date; taken off it, they have none", {
    when() {
        const workEffortId = orders(state.keyedPlan)[0].workEffortId
        const techParty = prefix + "_P_TECH"
        const reminders = () =>
            Array.from(ec.entity.find("mantle.work.effort.WorkEffortReminder").condition({workEffortId}).disableAuthz().list())
        const assigned = as(state.planner, W + "schedule#MaintenanceWorkOrder", {workEffortId, assigneePartyIds: [techParty]})
        const set = reminders()
        as(state.planner, W + "schedule#MaintenanceWorkOrder", {workEffortId, assigneePartyIds: []})
        return {assigned, set, cleared: reminders(), techParty}
    },
    then({assigned, set, cleared, techParty}) {
        assigned.addedPartyIds.includes(techParty)
        set.length == 1
        set[0].partyId == techParty
        Number(String(set[0].offsetMinutes)) == 1440
        cleared.length == 0
    }
})
