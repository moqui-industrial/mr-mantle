// The production schedule and capacity (impl-manufacturing P12; design-manufacturing ProductionSchedule, Capacity, Operations'
// Reschedule, FacilityDetail's offline change): get#WorkCenterLoad with the calendar (work hours, a holiday), a stop and the
// bookings prorated by day, and its missing data; schedule#ProductionOperation's preview and apply with its refusals (an
// unqualified center, a stale revision, started work, another organization, a reader) and conflicts (calendar, a holiday,
// capacity), a scheduler's override request that a supervisor approves without changing any capacity, unschedule and the
// change notice; store#WorkCenterOffline previewing the operation it moves, applying the move and withdrawing the block; and
// get#ProductionSchedule's lanes. Two lines of a spec plant (line 1 works weekdays 6 to 14 with one slot, line 2, its
// alternate, has no calendar), a routing of Assemble then Test of two hours each for two pieces, and two released runs whose
// operations the setup places on next week's Monday. The users are in spec-local groups.
const L = "mantle.work.ProductionPlanningServices.",
    P = "mantle.work.ProductionServices.",
    B = "mantle.product.BomServices.",
    R = "mantle.work.RoutingServices.",
    W = "mantle.work.WorkCenterServices."
const org = "PS12_ORG",
    other = "PS12_OTHER",
    plant = "PS12_PLANT",
    line1 = "PS12_LINE_1",
    line2 = "PS12_LINE_2",
    line3 = "PS12_LINE_3"
const find = (entity, conditions = {}) => ec.entity.find(entity).condition(conditions).disableAuthz()
const one = (entity, conditions) => find(entity, conditions).one()
const rows = (entity, conditions) => Array.from(find(entity, conditions).list())
const since = "2000-01-01T00:00:00Z"
const state = {}
let keySeq = 0
const key = () => "ps12-op-" + ++keySeq
function as(username, action) {
    login(username)
    ec.artifactExecution.disableAuthz()
    try {
        return action()
    } finally {
        ec.message.clearErrors()
        login("john.doe")
        ec.artifactExecution.disableAuthz()
    }
}
// a call's result with its error text ("" when it succeeds), in its own transaction so a refusal rolls back only itself
function invoke(service, parameters) {
    ec.message.pushErrors()
    try {
        const out = ec.service.sync().name(service).parameters(parameters).requireNewTransaction(true).call() || {}
        return Object.assign({}, out, {error: ec.message.hasError() ? ec.message.getErrorsString() : ""})
    } catch (error) {
        return {error: String(error.message || error)}
    } finally {
        ec.message.clearErrors()
        ec.message.popErrors()
    }
}
const run = (username, service, parameters) => as(username, () => invoke(service, parameters))
function user(partyId, permissions, organizationPartyId = org) {
    call("create#moqui.security.UserGroup", {userGroupId: partyId + "_G"})
    for (const userPermissionId of permissions)
        call("create#moqui.security.UserGroupPermission", {userGroupId: partyId + "_G", userPermissionId, fromDate: since})
    call("create#mantle.party.Party", {partyId, partyTypeEnumId: "PtyPerson"})
    call("create#mantle.party.Person", {partyId, firstName: partyId})
    call("create#moqui.security.UserAccount", {
        userId: partyId,
        username: partyId.toLowerCase(),
        partyId,
        currentPassword: "16ac58bbfa332c1c55bd98b53e60720bfa90d394",
        passwordHashType: "SHA",
        // the zone the spec's times are written in (john.doe's), so each user reads them alike
        timeZone: state.timeZone
    })
    call("create#moqui.security.UserGroupMember", {userId: partyId, userGroupId: partyId + "_G", fromDate: since})
    call("create#mantle.party.PartyRelationship", {
        fromPartyId: partyId,
        toPartyId: organizationPartyId,
        relationshipTypeEnumId: "PrtAgent",
        toRoleTypeId: "OrgInternal",
        fromDate: since
    })
}
// next week's Monday (a day at least six days on) and the days after it, in the user's zone
function monday() {
    const today = ec.l10n.format(ec.user.nowTimestamp, "yyyy-MM-dd")
    const [y, m, d] = today.split("-").map(Number)
    for (let offset = 6; offset < 14; offset++) {
        const day = new Date(Date.UTC(y, m - 1, d + offset))
        if (day.getUTCDay() === 1) return day
    }
    throw new Error("No Monday")
}
const dayText = offset => new Date(state.monday.getTime() + offset * 86400000).toISOString().slice(0, 10)
const at = (offset, clock) => ec.l10n.parseTimestamp(dayText(offset) + " " + clock + ":00.000", "yyyy-MM-dd HH:mm:ss.SSS")
const wallText = (offset, clock) => dayText(offset) + " " + clock
const operation = workEffortId => one("mantle.work.effort.WorkEffort", {workEffortId})
const runRevision = workEffortId => Number(operation(workEffortId).productionRevision || 0)
const scheduleRevision = workEffortId => Number(operation(workEffortId).scheduleRevision || 0)
// a schedule call on an operation at its current revisions
function schedule(username, workEffortId, extra) {
    const op = operation(workEffortId)
    return run(
        username,
        L + "schedule#ProductionOperation",
        Object.assign(
            {
                operationKey: key(),
                workEffortId,
                expectedRevision: scheduleRevision(workEffortId),
                expectedRunRevision: runRevision(op.rootWorkEffortId)
            },
            extra
        )
    )
}
const codes = list => (list || []).map(row => row.code)
// a released run of two pieces with its operations placed as given: [center, from, thru] for Assemble and for Test
function releasedRun(assemble, test) {
    const created = run("ps12_planner", P + "create#ProductionOrder", {
        operationKey: key(),
        organizationPartyId: org,
        productId: "PS12_FIN",
        quantity: 2,
        facilityId: line1,
        estimatedStartDate: at(0, "06:00"),
        estimatedCompletionDate: at(0, "14:00")
    })
    if (created.error) throw new Error("Create failed: " + created.error)
    const released = run("ps12_planner", P + "transition#ProductionOrder", {
        operationKey: key(),
        workEffortId: created.workEffortId,
        action: "release",
        expectedRevision: runRevision(created.workEffortId)
    })
    if (released.error) throw new Error("Release failed: " + released.error)
    const children = rows("mantle.work.effort.WorkEffort", {rootWorkEffortId: created.workEffortId}).sort(
        (a, b) => Number(a.operationSequenceNum) - Number(b.operationSequenceNum)
    )
    ;[assemble, test].forEach(([facilityId, from, thru], index) =>
        call("update#mantle.work.effort.WorkEffort", {
            workEffortId: children[index].workEffortId,
            workCenterFacilityId: facilityId,
            estimatedStartDate: from,
            estimatedCompletionDate: thru
        })
    )
    return {runId: created.workEffortId, assemble: children[0].workEffortId, test: children[1].workEffortId}
}

spec({
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        state.monday = monday()
        state.timeZone = String(ec.user.timeZone || "") || null
        for (const partyId of [org, other]) {
            call("create#mantle.party.Party", {partyId, partyTypeEnumId: "PtyOrganization"})
            call("create#mantle.party.Organization", {partyId, organizationName: partyId})
            call("create#mantle.party.PartyRole", {partyId, roleTypeId: "OrgInternal"})
        }
        call("mantle.ledger.LedgerServices.init#PartyAccountingConfiguration", {
            organizationPartyId: org,
            sourcePartyId: "DefaultSettings",
            baseCurrencyUomId: "USD"
        })
        user("PS12_PLANNER", ["PRODUCTION_PLAN", "PRODUCTION_VIEW", "METHOD_VIEW"])
        user("PS12_SCHEDULER", ["PRODUCTION_SCHEDULE", "PRODUCTION_VIEW"])
        user("PS12_SUPER", ["PRODUCTION_SUPERVISE", "PRODUCTION_VIEW"])
        user("PS12_READER", ["PRODUCTION_VIEW"])
        user("PS12_METHOD", ["METHOD_VIEW", "METHOD_EDIT", "METHOD_APPROVE", "METHOD_RESOURCES"])
        user("PS12_OUTSIDER", ["PRODUCTION_SCHEDULE", "PRODUCTION_SUPERVISE", "PRODUCTION_VIEW"], other)
        call("create#mantle.facility.Facility", {
            facilityId: plant,
            facilityTypeEnumId: "FcTpWarehouse",
            facilityName: "Schedule plant",
            ownerPartyId: org
        })
        for (const [facilityId, facilityName] of [
            [line1, "Schedule line one"],
            [line2, "Schedule line two"],
            [line3, "Schedule line three"]
        ])
            call("create#mantle.facility.Facility", {
                facilityId,
                facilityTypeEnumId: "FcTpLine",
                facilityName,
                parentFacilityId: plant,
                ownerPartyId: org
            })
        call("create#mantle.facility.FacilityLocation", {
            facilityId: plant,
            locationSeqId: "PICK1",
            locationTypeEnumId: "FltPick"
        })
        for (const productId of ["PS12_FIN", "PS12_RM"])
            call("create#mantle.product.Product", {
                productId,
                productName: productId,
                productTypeEnumId: "PtAsset",
                assetTypeEnumId: "AstTpInventory",
                amountUomId: "OTH_ea",
                ownerPartyId: org
            })
        // line 1's calendar: weekdays 6 to 14; the organization's holiday on Wednesday
        call("create#mantle.work.calendar.Calendar", {
            calendarId: "PS12_CAL",
            ownerPartyId: org,
            calendarName: "Line one shifts",
            calendarKindEnumId: "CalkResource"
        })
        call("create#mantle.work.effort.WorkEffort", {
            workEffortId: "PS12_SHIFT",
            workEffortTypeEnumId: "WetAvailable",
            statusId: "WeApproved",
            workEffortName: "Day shift",
            estimatedStartDate: at(-7, "06:00"),
            estimatedCompletionDate: at(-7, "14:00")
        })
        call("create#mantle.work.effort.WorkEffortRecurrence", {
            workEffortId: "PS12_SHIFT",
            rrule: "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR"
        })
        call("create#mantle.work.calendar.CalendarWorkEffort", {calendarId: "PS12_CAL", workEffortId: "PS12_SHIFT"})
        call("create#mantle.work.effort.WorkEffort", {
            workEffortId: "PS12_HOLIDAY",
            workEffortTypeEnumId: "WetEvent",
            purposeEnumId: "WepHoliday",
            statusId: "WeApproved",
            workEffortName: "Spec holiday",
            ownerPartyId: org,
            allDayStart: dayText(2)
        })
        ec.artifactExecution.enableAuthz()
        as("ps12_method", () => {
            call(R + "store#WorkCenter", {
                organizationPartyId: org,
                facilityId: line1,
                calendarId: "PS12_CAL",
                changeReason: "Spec"
            })
            call(R + "store#WorkCenter", {organizationPartyId: org, facilityId: line2, changeReason: "Spec"})
            call(R + "store#WorkCenter", {organizationPartyId: org, facilityId: line3, changeReason: "Spec"})
            for (const facilityId of [line1, line2])
                call(W + "store#WorkCenterCapacity", {
                    facilityId,
                    capacityBasisEnumId: "WccbSlots",
                    parallelSlots: 1,
                    changeReason: "Spec"
                })
            call(W + "store#WorkCenterAlternate", {facilityId: line1, alternateFacilityId: line2, changeReason: "Spec"})
            const routeId = call(R + "store#Routing", {
                organizationPartyId: org,
                workEffortName: "Schedule routing",
                changeReason: "Spec"
            }).routing.workEffortId
            const step = (workEffortName, sequenceNum, predecessors) =>
                call(R + "store#RoutingOperation", {
                    workEffortId: routeId,
                    workEffortName,
                    sequenceNum,
                    estimatedWorkTime: 60,
                    timeUomId: "TF_min",
                    methodBatchQuantity: 1,
                    methodQuantityUomId: "OTH_ea",
                    methodWorkCenterId: line1,
                    methodPredecessorIds: predecessors || null,
                    changeReason: "Spec operation"
                }).operationWorkEffortId
            const assemble = step("Assemble", 10)
            step("Test", 20, assemble)
            const routing = call(R + "get#RoutingDetail", {workEffortId: routeId})
            call(R + "release#RoutingDraft", {
                workEffortId: routeId,
                expectedRevision: routing.expectedRevision,
                changeReason: "Spec"
            })
            const bom = call(B + "store#Bom", {
                productId: "PS12_FIN",
                organizationPartyId: org,
                routingWorkEffortId: routeId,
                changeReason: "Spec"
            }).productBom.productBomId
            call(B + "store#BomItem", {
                productBomId: bom,
                productId: "PS12_RM",
                quantity: 1,
                operationWorkEffortId: assemble,
                changeReason: "Spec"
            })
            const detail = call(B + "get#BomDetail", {productBomId: bom})
            call(B + "release#BomDraft", {productBomId: bom, expectedRevision: detail.expectedRevision, changeReason: "Spec"})
        })
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        call("mantle.product.AssetServices.receive#Asset", {
            productId: "PS12_RM",
            quantity: 100,
            facilityId: plant,
            locationSeqId: "PICK1",
            ownerPartyId: org,
            assetTypeEnumId: "AstTpInventory",
            statusId: "AstAvailable",
            acquireCost: 2
        })
        // run 1: Assemble on line 1 Monday 6 to 8, Test 8 to 10; run 2: Assemble on line 2 Monday 6 to 8, Test on line 1 from
        // Monday 12 to Tuesday 8 (two hours over two days of work hours)
        state.run1 = releasedRun([line1, at(0, "06:00"), at(0, "08:00")], [line1, at(0, "08:00"), at(0, "10:00")])
        state.run2 = releasedRun([line2, at(0, "06:00"), at(0, "08:00")], [line1, at(0, "12:00"), at(1, "08:00")])
        // a closed stop of line 1 on Tuesday from 6 to 8
        call("create#mantle.work.production.ProductionDowntime", {
            productionDowntimeId: "PS12_STOP",
            organizationPartyId: org,
            facilityId: line1,
            statusId: "PdtClosed",
            reasonCode: "PS12_JAM",
            fromDate: at(1, "06:00"),
            thruDate: at(1, "08:00"),
            revision: 1
        })
    },
    setup() {
        ec.artifactExecution.disableAuthz()
    },
    cleanup() {
        ec.message.clearErrors()
        login("john.doe")
        ec.artifactExecution.enableAuthz()
    }
})

feature("the load of line one by day: work hours less the holiday, the stop as downtime, bookings prorated over work hours", {
    when() {
        const load = run("ps12_reader", L + "get#WorkCenterLoad", {
            facilityIds: [line1, line2].join(","),
            fromDate: at(0, "00:00"),
            thruDate: at(5, "00:00"),
            bucket: "day"
        })
        const centers = Object.fromEntries((load.centerList || []).map(row => [row.facilityId, row]))
        return {load, one: centers[line1], two: centers[line2]}
    },
    then({load, one, two}) {
        load.error == ""
        load.utilizationFormula.includes("not OEE")
        one.periodList.length == 5
        // five days of 24 hours; four work days of eight hours (the holiday Wednesday); two hours stopped on Tuesday
        one.nominalHours == "120"
        one.calendarHours == "32"
        one.downtimeHours == "2"
        one.availableHours == "30"
        // Monday: Assemble and Test of run 1 (four hours) and half of run 2's Test; Tuesday the other half
        one.periodList[0].bookedHours == "5"
        one.periodList[1].bookedHours == "1"
        one.periodList[1].downtimeHours == "2"
        one.periodList[2].calendarHours == "0"
        one.bookedHours == "6"
        one.calendarConfigured == true
        one.missingList.length == 0
        // line two has no calendar: around the clock less the organization's holiday, named as missing data
        two.calendarConfigured == false
        codes(two.missingList).includes("NO_CALENDAR")
        two.calendarHours == "96"
        two.bookedHours == "2"
    }
})

feature("a move to the alternate line conflicts on capacity; the scheduler asks for an override and a supervisor applies it", {
    when() {
        const target = {facilityId: line2, startDate: at(0, "06:00")}
        const preview = schedule("ps12_scheduler", state.run1.assemble, Object.assign({action: "preview"}, target))
        const plain = schedule("ps12_scheduler", state.run1.assemble, Object.assign({action: "apply"}, target))
        const notAllowed = schedule(
            "ps12_scheduler",
            state.run1.assemble,
            Object.assign({action: "apply", override: true, reason: "Rush"}, target)
        )
        const capacityBefore = rows("mantle.work.production.WorkCenterCapacity", {facilityId: line2}).length
        const request = schedule(
            "ps12_scheduler",
            state.run1.assemble,
            Object.assign({action: "request", reason: "Rush order"}, target)
        )
        const changeId = request.result?.scheduleChangeId
        const notices = rows("moqui.security.user.NotificationMessage", {
            topic: "ProductionScheduleOverride",
            recordId: changeId || "_NA_"
        })
        const asked = rows("moqui.security.user.NotificationMessageUser", {
            notificationMessageId: notices[0]?.notificationMessageId || "_NA_"
        })
        const approveKey = key()
        const approveParameters = {operationKey: approveKey, action: "approve", scheduleChangeId: changeId}
        const schedulerApproves = run("ps12_scheduler", L + "schedule#ProductionOperation", approveParameters)
        const approved = run("ps12_super", L + "schedule#ProductionOperation", approveParameters)
        const retry = run("ps12_super", L + "schedule#ProductionOperation", approveParameters)
        const change = one("mantle.work.production.ProductionScheduleChange", {scheduleChangeId: changeId || "_NA_"})
        const cleared = rows("moqui.security.user.NotificationMessageUser", {
            notificationMessageId: notices[0]?.notificationMessageId || "_NA_"
        })
        return {
            preview,
            plain,
            notAllowed,
            request,
            asked,
            schedulerApproves,
            approved,
            retry,
            change,
            cleared,
            capacityBefore,
            capacityAfter: rows("mantle.work.production.WorkCenterCapacity", {facilityId: line2}).length,
            moved: operation(state.run1.assemble)
        }
    },
    then(r) {
        r.preview.error == ""
        codes(r.preview.result.conflicts).includes("CAPACITY")
        r.preview.result.refusals.length == 0
        r.preview.result.endText == wallText(0, "08:00")
        r.preview.result.canApply == false
        r.preview.result.canRequestOverride == true
        r.plain.error.includes("SCHEDULE_CONFLICT")
        r.notAllowed.error.includes("OVERRIDE_NOT_PERMITTED")
        r.request.error == ""
        r.request.result.resultCode == "REQUESTED"
        r.asked.map(row => row.userId).includes("PS12_SUPER")
        r.schedulerApproves.error.includes("PERMISSION_DENIED")
        r.approved.error == ""
        r.approved.result.resultCode == "OVERRIDDEN"
        r.retry.result.alreadyApplied == true
        r.change.statusId == "SchApplied"
        r.change.overrideApplied == "Y"
        r.change.decidedByUserId == "PS12_SUPER"
        r.cleared.every(row => row.viewedDate != null)
        r.moved.workCenterFacilityId == line2
        Number(r.moved.scheduleRevision) == 1
        // an override changes no capacity
        r.capacityAfter == r.capacityBefore
    }
})

feature("refusals and conflicts of a move: qualification, calendar, holiday, revision, started work, readers and outsiders", {
    when() {
        const test = state.run1.test
        const unqualified = schedule("ps12_scheduler", test, {action: "preview", facilityId: line3, startDate: at(3, "06:00")})
        const unqualifiedApply = schedule("ps12_scheduler", test, {action: "apply", facilityId: line3, startDate: at(3, "06:00")})
        const lateShift = schedule("ps12_scheduler", test, {action: "preview", facilityId: line1, startDate: at(0, "13:00")})
        const holiday = schedule("ps12_scheduler", test, {action: "preview", facilityId: line1, startDate: at(2, "06:00")})
        const readerPreview = schedule("ps12_reader", test, {action: "preview", facilityId: line1, startDate: at(3, "06:00")})
        const outsider = schedule("ps12_outsider", test, {action: "preview", facilityId: line1, startDate: at(3, "06:00")})
        const stale = run("ps12_scheduler", L + "schedule#ProductionOperation", {
            operationKey: key(),
            action: "apply",
            workEffortId: test,
            facilityId: line1,
            startDate: at(3, "06:00"),
            expectedRevision: scheduleRevision(test) + 5,
            expectedRunRevision: runRevision(state.run1.runId)
        })
        const moved = schedule("ps12_scheduler", test, {action: "apply", facilityId: line1, startDate: at(3, "06:00")})
        const notices = rows("moqui.security.user.NotificationMessage", {
            topic: "ProductionScheduleChange",
            recordId: state.run1.runId
        })
        // run 2's Test has started: actual work pins it
        call("update#mantle.work.effort.WorkEffort", {workEffortId: state.run2.test, actualStartDate: at(0, "12:00")})
        const started = schedule("ps12_scheduler", state.run2.test, {
            action: "apply",
            facilityId: line1,
            startDate: at(3, "10:00")
        })
        return {unqualified, unqualifiedApply, lateShift, holiday, readerPreview, outsider, stale, moved, notices, started}
    },
    then(r) {
        codes(r.unqualified.result.refusals).includes("CENTER_NOT_QUALIFIED")
        r.unqualified.result.canApply == false
        r.unqualifiedApply.error.includes("CENTER_NOT_QUALIFIED")
        // from 13 on Monday its two hours end at 9 on Tuesday, over the night and Tuesday's stop: outside the work hours,
        // offline, and with run 2's Test on the line's one slot
        r.lateShift.result.endText == wallText(1, "09:00")
        codes(r.lateShift.result.conflicts).includes("CALENDAR")
        codes(r.lateShift.result.conflicts).includes("OFFLINE")
        codes(r.lateShift.result.conflicts).includes("CAPACITY")
        codes(r.holiday.result.conflicts).includes("CALENDAR")
        r.holiday.result.conflictText.includes("Spec holiday")
        r.readerPreview.error.includes("PERMISSION_DENIED")
        r.outsider.error.includes("RECORD_UNAVAILABLE")
        r.stale.error.includes("REVISION_CHANGED")
        r.moved.error == ""
        r.moved.result.resultCode == "SCHEDULED"
        r.moved.result.conflicts.length == 0
        operation(state.run1.test).estimatedStartDate != null
        r.notices.length >= 1
        r.started.error.includes("OPERATION_LOCKED")
    }
})

feature("an offline block of line one previews the operation it moves, applies the move and is withdrawn", {
    when() {
        const block = {facilityId: line1, fromDate: at(3, "05:00"), thruDate: at(3, "09:00"), reason: "Fixture change"}
        const preview = run("ps12_scheduler", L + "store#WorkCenterOffline", Object.assign({action: "preview"}, block))
        const reader = run("ps12_reader", L + "store#WorkCenterOffline", Object.assign({action: "preview"}, block))
        const applied = run(
            "ps12_scheduler",
            L + "store#WorkCenterOffline",
            Object.assign({action: "apply", moveOperations: true, operationKey: key()}, block)
        )
        const moved = operation(state.run1.test)
        const load = run("ps12_reader", L + "get#WorkCenterLoad", {
            facilityId: line1,
            fromDate: at(3, "00:00"),
            thruDate: at(4, "00:00")
        })
        const withdrawn = run("ps12_scheduler", L + "store#WorkCenterOffline", {
            action: "withdraw",
            facilityId: line1,
            resourceUnavailabilityId: applied.result?.resourceUnavailabilityId,
            operationKey: key()
        })
        return {preview, reader, applied, moved, load, withdrawn}
    },
    then({preview, reader, applied, moved, load, withdrawn}) {
        preview.error == ""
        preview.result.affectedList.length == 1
        preview.result.affectedList[0].workEffortId == state.run1.test
        preview.result.affectedList[0].moves == true
        preview.result.affectedList[0].toStartText == wallText(3, "09:00")
        preview.result.affectedList[0].toEndText == wallText(3, "11:00")
        reader.error.includes("PERMISSION_DENIED")
        applied.error == ""
        applied.result.resultCode == "OFFLINE_RECORDED"
        applied.result.movedCount == 1
        moved.workCenterFacilityId == line1
        ec.l10n.format(moved.estimatedStartDate, "yyyy-MM-dd HH:mm") == wallText(3, "09:00")
        // the block takes three of Thursday's work hours
        load.centerList[0].downtimeHours == "3"
        load.centerList[0].offlineList.some(row => row.kind == "planned")
        withdrawn.error == ""
        withdrawn.result.resultCode == "WITHDRAWN"
    }
})

feature("the schedule's lanes, operations and rights; unschedule takes an operation off it", {
    when() {
        const range = {facilityIds: [line1, line2].join(","), fromDate: at(0, "00:00"), thruDate: at(5, "00:00")}
        const reader = run("ps12_reader", L + "get#ProductionSchedule", range)
        const scheduler = run("ps12_scheduler", L + "get#ProductionSchedule", range)
        const unscheduled = schedule("ps12_scheduler", state.run1.test, {action: "unschedule", reason: "Wait for material"})
        const after = run("ps12_scheduler", L + "get#ProductionSchedule", range)
        const load = run("ps12_reader", L + "get#WorkCenterLoad", {
            facilityId: line1,
            fromDate: at(0, "00:00"),
            thruDate: at(5, "00:00")
        })
        return {reader, scheduler, unscheduled, after, load}
    },
    then({reader, scheduler, unscheduled, after, load}) {
        reader.error == ""
        reader.laneList.map(row => row.facilityId).join(",") == [line1, line2].join(",")
        reader.laneList[0].closedList.length > 0
        reader.laneList[0].holidayList.some(row => row.name == "Spec holiday")
        reader.laneList[0].offlineList.some(row => row.sourceId == "PS12_STOP")
        reader.operationList.some(row => row.workEffortId == state.run1.assemble && row.facilityId == line2)
        reader.operationList.find(row => row.workEffortId == state.run2.test).locked == true
        reader.canSchedule == false
        reader.operationList.every(row => row.canMove == false)
        scheduler.canSchedule == true
        scheduler.canOverride == false
        unscheduled.error == ""
        unscheduled.result.resultCode == "UNSCHEDULED"
        after.unscheduledList.some(row => row.workEffortId == state.run1.test)
        codes(load.centerList[0].missingList).includes("NO_DATES")
    }
})

feature("a center's work hours a day, the work days a routing lead time counts in (F82)", {
    when() {
        return as("ps12_reader", () => {
            const time = ec.resource.script("component://mr-mantle/service/mantle/work/ProductionCalendar.js")
            const ctx = time.forCall()
            const startMs = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js").ms(at(0, "00:00"))
            return {
                one: time.workHoursPerDay(ctx, time.centerOf(ctx, line1), startMs),
                two: time.workHoursPerDay(ctx, time.centerOf(ctx, line2), startMs)
            }
        })
    },
    then({one, two}) {
        // four days of eight hours in the week (Wednesday is the holiday); line two has no calendar
        Math.round(one * 1000) == Math.round((32 / 7) * 1000)
        two == 24
    }
})
