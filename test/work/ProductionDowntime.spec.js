// Production downtime and maintenance (impl-manufacturing P11, design-manufacturing Downtime, D24, review Y3): an operator
// reports an equipment fault on a line with a maintenance request, which makes a corrective AssetMaintenance and a linked
// maintenance Request; the fault records one outage of the robot, and a second fault on it links the same outage; closing
// the stop leaves the request, the maintenance and the outage open and starts no timer; a no-material stop records no outage
// and suggests no maintenance; a supervisor's correction keeps the original interval and reporter; a stop longer than its
// reason's approval threshold waits for a supervisor's approval. Each refusal is checked
// on parameters that pass for a user who may. The users are in spec-local groups.
const P = "mantle.work.ProductionServices."
const DOWNTIME = "mantle.work.production.ProductionDowntime",
    OUTAGE = "mantle.work.effort.ResourceUnavailability"
const org = "PDT_ORG",
    other = "PDT_OTHER",
    plant = "PDT_PLANT",
    line = "PDT_LINE",
    otherLine = "PDT_OLINE"
const find = (entity, conditions = {}) => ec.entity.find(entity).condition(conditions).disableAuthz()
const one = (entity, conditions) => find(entity, conditions).one()
const rows = (entity, conditions) => Array.from(find(entity, conditions).list())
const since = "2000-01-01T00:00:00Z"
const minutesAgo = minutes => new Date(Date.now() - minutes * 60000)
let keySeq = 0
const key = () => "pdt-op-" + ++keySeq
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
        userFullName: partyId,
        partyId,
        currentPassword: "16ac58bbfa332c1c55bd98b53e60720bfa90d394",
        passwordHashType: "SHA"
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
const store = (username, parameters) =>
    run(username, P + "store#ProductionDowntime", Object.assign({operationKey: key()}, parameters))
const open = (username, parameters) => store(username, Object.assign({action: "open", facilityId: line}, parameters))
const answer = out => out.result || {}
const downtime = productionDowntimeId => one(DOWNTIME, {productionDowntimeId})

spec({
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        for (const partyId of [org, other]) {
            call("create#mantle.party.Party", {partyId, partyTypeEnumId: "PtyOrganization"})
            call("create#mantle.party.Organization", {partyId, organizationName: partyId})
            call("create#mantle.party.PartyRole", {partyId, roleTypeId: "OrgInternal"})
        }
        user("PDT_OPERATOR", ["PRODUCTION_OPERATE"])
        user("PDT_SUPERVISOR", ["PRODUCTION_SUPERVISE", "PRODUCTION_VIEW"])
        user("PDT_READER", ["PRODUCTION_VIEW"])
        user("PDT_OUTSIDER", ["PRODUCTION_OPERATE", "PRODUCTION_VIEW"], other)
        call("create#mantle.facility.Facility", {
            facilityId: plant,
            facilityTypeEnumId: "FcTpPlant",
            facilityName: "Downtime plant",
            ownerPartyId: org
        })
        call("create#mantle.facility.Facility", {
            facilityId: line,
            facilityTypeEnumId: "FcTpLine",
            facilityName: "Downtime line",
            parentFacilityId: plant,
            ownerPartyId: org
        })
        call("create#mantle.facility.Facility", {
            facilityId: otherLine,
            facilityTypeEnumId: "FcTpLine",
            facilityName: "Other line",
            ownerPartyId: other
        })
        for (const facilityId of [line, otherLine]) call("create#mantle.work.production.WorkCenter", {facilityId})
        for (const assetId of ["PDT_ROBOT", "PDT_ROBOT2", "PDT_ROBOT3"])
            call("create#mantle.product.asset.Asset", {
                assetId,
                assetTypeEnumId: "AstTpEquipment",
                assetName: assetId,
                statusId: "AstAvailable",
                facilityId: plant,
                ownerPartyId: org
            })
        call("create#mantle.product.asset.Asset", {
            assetId: "PDT_STOCK",
            assetTypeEnumId: "AstTpInventory",
            statusId: "AstAvailable",
            facilityId: plant,
            ownerPartyId: org
        })
        const reasons = [
            ["PDT_FAULT", "Robot fault", "PrcDowntime", "Y"],
            ["PDT_NOMAT", "No material", "PrcHold", "N"],
            ["PDT_SCRAP", "Damaged", "PrcScrap", "N"],
            ["PDT_JAM", "Jam", "PrcDowntime", "N", 30]
        ]
        for (const [reasonCode, reasonName, reasonCategoryEnumId, equipmentFault, approvalThreshold] of reasons)
            call("create#mantle.work.production.ProductionReason", {
                organizationPartyId: org,
                reasonCode,
                fromDate: since,
                reasonName,
                reasonCategoryEnumId,
                equipmentFault,
                plannedStop: "N",
                approvalThreshold: approvalThreshold ?? null
            })
        // a run in progress on the line, with its operation (as release makes them)
        call("create#mantle.work.effort.WorkEffort", {
            workEffortId: "PDT_RUN",
            workEffortTypeEnumId: "WetEvent",
            purposeEnumId: "WepProductionRun",
            statusId: "WeInProgress",
            facilityId: line,
            ownerPartyId: org,
            workEffortName: "Downtime run"
        })
        call("create#mantle.work.effort.WorkEffort", {
            workEffortId: "PDT_RUN_OP",
            workEffortTypeEnumId: "WetTask",
            parentWorkEffortId: "PDT_RUN",
            rootWorkEffortId: "PDT_RUN",
            statusId: "WeInProgress",
            ownerPartyId: org,
            workEffortName: "Assemble"
        })
    }
})

feature("an operator reports an equipment fault with a maintenance request: a corrective maintenance and a linked request", {
    when() {
        const opened = open("pdt_operator", {
            assetId: "PDT_ROBOT",
            operationWorkEffortId: "PDT_RUN_OP",
            reasonCode: "PDT_FAULT",
            fromDate: minutesAgo(20),
            description: "Gripper stuck"
        })
        const id = answer(opened).productionDowntimeId
        const requested = run("pdt_operator", P + "request#ProductionMaintenance", {
            operationKey: key(),
            productionDowntimeId: id,
            problem: "Gripper stuck closed",
            priority: 2,
            createRequest: true
        })
        const row = downtime(id)
        const maintenance = one("mantle.product.maintenance.AssetMaintenance", {assetMaintenanceId: row.assetMaintenanceId})
        const request = one("mantle.request.Request", {requestId: row.requestId})
        const links = rows("mantle.request.RequestRecord", {requestId: row.requestId}).map(link => link.recordEntityName)
        const workLink = one("mantle.request.RequestWorkEffort", {requestId: row.requestId, workEffortId: "PDT_RUN_OP"})
        const again = run("pdt_operator", P + "request#ProductionMaintenance", {
            operationKey: key(),
            productionDowntimeId: id,
            problem: "Again",
            createRequest: false
        })
        return {opened: answer(opened), requested: answer(requested), row, maintenance, request, links, workLink, again}
    },
    then({opened, requested, row, maintenance, request, links, workLink, again}) {
        opened.resultCode == "OPENED"
        opened.suggestMaintenance == true
        opened.workEffortId == "PDT_RUN"
        row.statusId == "PdtOpen"
        row.reportedByUserId == "PDT_OPERATOR"
        row.equipmentFault == "Y"
        requested.resultCode == "MAINTENANCE_REQUESTED"
        maintenance.statusId == "AsMntCreated"
        maintenance.maintenanceTypeEnumId == "MntTpCorrective"
        maintenance.assetId == "PDT_ROBOT"
        request.requestTypeEnumId == "RqtMaintenance"
        request.statusId == "ReqSubmitted"
        request.facilityId == line
        request.priority == 2
        links.includes(DOWNTIME)
        links.includes("mantle.product.asset.Asset")
        links.includes("mantle.product.maintenance.AssetMaintenance")
        workLink != null
        again.error.includes("MAINTENANCE_REQUESTED")
    }
})

feature("an equipment fault records one outage of the robot; a second fault links it, and a retry answers the first", {
    when() {
        const parameters = {
            operationKey: "pdt-fault-a",
            action: "open",
            facilityId: line,
            assetId: "PDT_ROBOT2",
            reasonCode: "PDT_FAULT"
        }
        const first = answer(run("pdt_operator", P + "store#ProductionDowntime", parameters))
        const retry = answer(run("pdt_operator", P + "store#ProductionDowntime", parameters))
        const second = answer(open("pdt_operator", {assetId: "PDT_ROBOT2", reasonCode: "PDT_FAULT"}))
        const outages = rows(OUTAGE, {assetId: "PDT_ROBOT2"})
        return {first, retry, second, outages, stops: rows(DOWNTIME, {assetId: "PDT_ROBOT2"}).length}
    },
    then({first, retry, second, outages, stops}) {
        outages.length == 1
        outages[0].unavailabilityKindEnumId == "RukActual"
        outages[0].thruDate == null
        outages[0].sourceProductionDowntimeId == first.productionDowntimeId
        outages[0].organizationPartyId == org
        first.outageLinked == false
        first.resourceUnavailabilityId == outages[0].resourceUnavailabilityId
        retry.alreadyApplied == true
        retry.productionDowntimeId == first.productionDowntimeId
        second.outageLinked == true
        second.resourceUnavailabilityId == outages[0].resourceUnavailabilityId
        stops == 2
    }
})

feature("closing the stop leaves its request, maintenance and outage open and starts no timer", {
    when() {
        const opened = answer(open("pdt_operator", {assetId: "PDT_ROBOT3", reasonCode: "PDT_FAULT", fromDate: minutesAgo(30)}))
        const id = opened.productionDowntimeId
        run("pdt_operator", P + "request#ProductionMaintenance", {
            operationKey: key(),
            productionDowntimeId: id,
            problem: "Arm drift",
            createRequest: true
        })
        const timersBefore = rows("mantle.work.time.TimeEntry", {userId: "PDT_OPERATOR"}).length
        const stale = store("pdt_operator", {action: "close", productionDowntimeId: id, expectedRevision: 0})
        const closed = answer(store("pdt_operator", {action: "close", productionDowntimeId: id, expectedRevision: 1}))
        const twice = store("pdt_operator", {action: "close", productionDowntimeId: id, expectedRevision: 2})
        const row = downtime(id)
        return {
            stale: stale.error,
            closed,
            twice: twice.error,
            row,
            maintenance: one("mantle.product.maintenance.AssetMaintenance", {assetMaintenanceId: row.assetMaintenanceId}),
            request: one("mantle.request.Request", {requestId: row.requestId}),
            outage: one(OUTAGE, {resourceUnavailabilityId: row.resourceUnavailabilityId}),
            timers: rows("mantle.work.time.TimeEntry", {userId: "PDT_OPERATOR"}).length - timersBefore
        }
    },
    then({stale, closed, twice, row, maintenance, request, outage, timers}) {
        stale.includes("REVISION_CHANGED")
        closed.resultCode == "CLOSED"
        twice.includes("DOWNTIME_CLOSED")
        row.statusId == "PdtClosed"
        row.thruDate != null
        row.closedByUserId == "PDT_OPERATOR"
        maintenance.statusId == "AsMntCreated"
        request.statusId == "ReqSubmitted"
        outage.thruDate == null
        timers == 0
    }
})

feature("a no-material stop records no outage and suggests no maintenance", {
    when() {
        const stop = answer(open("pdt_operator", {assetId: "PDT_ROBOT", workEffortId: "PDT_RUN", reasonCode: "PDT_NOMAT"}))
        const listed = run("pdt_reader", P + "find#ProductionDowntime", {productionDowntimeId: stop.productionDowntimeId})
        return {stop, row: downtime(stop.productionDowntimeId), listed: listed.downtimeList[0]}
    },
    then({stop, row, listed}) {
        stop.resultCode == "OPENED"
        stop.suggestMaintenance == false
        stop.resourceUnavailabilityId == null
        row.equipmentFault == "N"
        row.reasonCategoryEnumId == "PrcHold"
        listed.suggestMaintenance == false
        listed.reasonName == "No material"
        listed.workText == "Downtime run"
    }
})

feature("a supervisor's correction keeps the original interval and reporter; the operator may not correct", {
    when() {
        const from = minutesAgo(90)
        const thru = minutesAgo(60)
        const stop = answer(open("pdt_operator", {reasonCode: "PDT_NOMAT", fromDate: from, thruDate: thru}))
        const id = stop.productionDowntimeId
        const correction = {
            action: "correct",
            productionDowntimeId: id,
            expectedRevision: 1,
            fromDate: minutesAgo(80),
            changeReason: "Started later than reported"
        }
        const before = downtime(id)
        const operator = store("pdt_operator", correction)
        const corrected = answer(store("pdt_supervisor", correction))
        const unchanged = downtime(id)
        const replacement = downtime(corrected.productionDowntimeId)
        const again = store("pdt_supervisor", Object.assign({}, correction, {expectedRevision: 2}))
        const listed = run("pdt_reader", P + "find#ProductionDowntime", {productionDowntimeId: id})
        const current = run("pdt_reader", P + "find#ProductionDowntime", {facilityId: plant})
        return {
            before,
            stop,
            operator: operator.error,
            corrected,
            unchanged,
            replacement,
            again: again.error,
            listed,
            current
        }
    },
    then({before, stop, operator, corrected, unchanged, replacement, again, listed, current}) {
        stop.resultCode == "RECORDED"
        operator.includes("PERMISSION_DENIED")
        corrected.resultCode == "CORRECTED"
        corrected.correctedDowntimeId == stop.productionDowntimeId
        unchanged.statusId == "PdtCorrected"
        unchanged.supersededByDowntimeId == corrected.productionDowntimeId
        String(unchanged.fromDate) == String(before.fromDate)
        String(unchanged.thruDate) == String(before.thruDate)
        String(replacement.fromDate) != String(before.fromDate)
        String(replacement.thruDate) == String(before.thruDate)
        unchanged.reportedByUserId == "PDT_OPERATOR"
        replacement.reportedByUserId == "PDT_OPERATOR"
        replacement.correctedByUserId == "PDT_SUPERVISOR"
        replacement.originalDowntimeId == stop.productionDowntimeId
        replacement.statusId == "PdtClosed"
        replacement.changeReason == "Started later than reported"
        again.includes("DOWNTIME_CORRECTED")
        listed.history.length == 2
        listed.history[0].statusId == "PdtCorrected"
        listed.history[1].correctedByName == "PDT_SUPERVISOR"
        !current.downtimeList.some(row => row.productionDowntimeId == stop.productionDowntimeId)
        current.downtimeList.some(row => row.productionDowntimeId == corrected.productionDowntimeId)
    }
})

feature("a stop longer than its reason's approval threshold waits for a supervisor's approval once it has ended", {
    when() {
        const long = answer(open("pdt_operator", {reasonCode: "PDT_JAM", fromDate: minutesAgo(50)}))
        const openList = run("pdt_supervisor", P + "find#ProductionDowntime", {productionDowntimeId: long.productionDowntimeId})
        const closed = answer(
            store("pdt_operator", {action: "close", productionDowntimeId: long.productionDowntimeId, expectedRevision: 1})
        )
        const short = answer(open("pdt_operator", {reasonCode: "PDT_JAM", fromDate: minutesAgo(20), thruDate: minutesAgo(5)}))
        const approval = {action: "approve", productionDowntimeId: long.productionDowntimeId, expectedRevision: 2}
        const waiting = run("pdt_supervisor", P + "find#ProductionDowntime", {facilityId: line, needsApproval: true})
        const operator = store("pdt_operator", approval)
        const approved = answer(store("pdt_supervisor", approval))
        const twice = store("pdt_supervisor", Object.assign({}, approval, {expectedRevision: 3}))
        const none = store("pdt_supervisor", {
            action: "approve",
            productionDowntimeId: short.productionDowntimeId,
            expectedRevision: 1
        })
        const listed = run("pdt_reader", P + "find#ProductionDowntime", {productionDowntimeId: long.productionDowntimeId})
        return {
            long,
            opened: openList.downtimeList[0],
            closed,
            short,
            waiting: waiting.downtimeList.map(row => row.productionDowntimeId),
            operator: operator.error,
            approved,
            twice: twice.error,
            none: none.error,
            listed: listed.downtimeList[0],
            row: downtime(long.productionDowntimeId)
        }
    },
    then({long, opened, closed, short, waiting, operator, approved, twice, none, listed, row}) {
        long.approvalRequired == false
        opened.canApprove == false
        closed.approvalRequired == true
        short.approvalRequired == false
        waiting.includes(long.productionDowntimeId)
        !waiting.includes(short.productionDowntimeId)
        operator.includes("PERMISSION_DENIED")
        approved.resultCode == "APPROVED"
        approved.approvalRequired == false
        twice.includes("DOWNTIME_APPROVED")
        none.includes("APPROVAL_NOT_REQUIRED")
        row.approvedByUserId == "PDT_SUPERVISOR"
        row.reportedByUserId == "PDT_OPERATOR"
        listed.approvalText == "Approved by PDT_SUPERVISOR"
        listed.canApprove == false
    }
})

feature("each refusal fails for its reason on parameters a permitted user passes with", {
    when() {
        const good = {reasonCode: "PDT_NOMAT", fromDate: minutesAgo(5)}
        return {
            passes: open("pdt_operator", good).error,
            reader: open("pdt_reader", good).error,
            outsider: open("pdt_outsider", good).error,
            otherLine: open("pdt_operator", Object.assign({}, good, {facilityId: otherLine})).error,
            notCenter: open("pdt_operator", Object.assign({}, good, {facilityId: plant})).error,
            scrap: open("pdt_operator", Object.assign({}, good, {reasonCode: "PDT_SCRAP"})).error,
            future: open("pdt_operator", Object.assign({}, good, {fromDate: new Date(Date.now() + 3600000)})).error,
            backwards: open("pdt_operator", Object.assign({}, good, {thruDate: minutesAgo(10)})).error,
            stock: open("pdt_operator", Object.assign({}, good, {assetId: "PDT_STOCK"})).error,
            badOperation: open(
                "pdt_operator",
                Object.assign({}, good, {workEffortId: "PDT_RUN", operationWorkEffortId: "PDT_RUN"})
            ).error,
            noKey: run("pdt_operator", P + "store#ProductionDowntime", Object.assign({action: "open", facilityId: line}, good))
                .error,
            noAsset: run("pdt_operator", P + "request#ProductionMaintenance", {operationKey: key(), problem: "Noise"}).error,
            outsiderList: run("pdt_outsider", P + "find#ProductionDowntime", {facilityId: line}).downtimeList.length,
            readerList: run("pdt_reader", P + "find#ProductionDowntime", {facilityId: line}).downtimeListCount
        }
    },
    then(r) {
        r.passes == ""
        r.reader.includes("PERMISSION_DENIED")
        r.outsider.includes("RECORD_UNAVAILABLE")
        r.otherLine.includes("RECORD_UNAVAILABLE")
        r.notCenter.includes("CENTER_INVALID")
        r.scrap.includes("REASON_INVALID")
        r.future.includes("INTERVAL_INVALID")
        r.backwards.includes("INTERVAL_INVALID")
        r.stock.includes("ASSET_INVALID")
        r.badOperation.includes("OPERATION_INVALID")
        r.noKey.includes("Operation Key")
        r.noAsset.includes("ASSET_REQUIRED")
        r.outsiderList == 0
        r.readerList > 0
    }
})
