// Production reports (impl-manufacturing P16, design-manufacturing §9 and Home's Kpis): OEE for a work center shows its
// availability, performance and quality from its downtime (overlapping stops unioned, a planned stop excluded) and the units
// it counted, a reworked unit counted once; a reader without financial read gets the quantities and no money, a financial
// reader the costs; a work center whose calendar cannot be read is a named partition and the report is incomplete, its
// figures left out of the totals rather than zero; each report answers its scope, as-of time and units; and a user without
// PRODUCTION_VIEW, another organization's reader and a facility outside the scope are refused. The users are in spec-local
// groups. Machine runtime (P10's MachineRuntimeEvent) is read when this build has it, else named as a partition not read.
const P = "mantle.work.ProductionServices.",
    B = "mantle.product.BomServices.",
    R = "mantle.work.RoutingServices.",
    REPORT = "mantle.work.ProductionReportServices."
const RUNTIME = "mantle.work.production.MachineRuntimeEvent"
const org = "PRR_ORG",
    other = "PRR_OTHER",
    second = "PRR_SECOND",
    plant = "PRR_PLANT",
    broken = "PRR_BROKEN"
const find = (entity, conditions = {}) => ec.entity.find(entity).condition(conditions).disableAuthz()
const one = (entity, conditions) => find(entity, conditions).one()
const rows = (entity, conditions) => Array.from(find(entity, conditions).list())
const since = "2000-01-01T00:00:00Z"
const hourMs = 3600000
const state = {}
let keySeq = 0
const key = () => "prr-op-" + ++keySeq
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
const report = (username, noun, parameters) => run(username, REPORT + "get#" + noun, parameters)
function user(partyId, permissions, organizationPartyIds = [org]) {
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
        passwordHashType: "SHA"
    })
    call("create#moqui.security.UserGroupMember", {userId: partyId, userGroupId: partyId + "_G", fromDate: since})
    for (const toPartyId of organizationPartyIds)
        call("create#mantle.party.PartyRelationship", {
            fromPartyId: partyId,
            toPartyId,
            relationshipTypeEnumId: "PrtAgent",
            toRoleTypeId: "OrgInternal",
            fromDate: since
        })
}
function stock(productId, quantity, acquireCost) {
    const assetId = call("mantle.product.AssetServices.receive#Asset", {
        productId,
        quantity,
        facilityId: plant,
        locationSeqId: "PICK1",
        ownerPartyId: org,
        assetTypeEnumId: "AstTpInventory",
        statusId: "AstAvailable",
        acquireCost
    }).assetId
    call("update#mantle.product.asset.Asset", {assetId, acquireCostUomId: "USD"})
    return assetId
}
const revision = workEffortId => Number(one("mantle.work.effort.WorkEffort", {workEffortId}).productionRevision || 0)
// a released run of PRR_FIN at the plant with its material issued in full; its output and material lines
function releasedRun(quantity) {
    const created = run("prr_planner", P + "create#ProductionOrder", {
        operationKey: key(),
        organizationPartyId: org,
        productId: "PRR_FIN",
        quantity,
        facilityId: plant
    })
    if (created.error) throw new Error("Create failed: " + created.error)
    const workEffortId = created.workEffortId
    const released = run("prr_planner", P + "release#ProductionOrder", {
        operationKey: key(),
        workEffortId,
        expectedRevision: revision(workEffortId)
    })
    if (released.error) throw new Error("Release failed: " + released.error)
    const lines = rows("mantle.work.production.ProductionRunLine", {workEffortId})
    const material = lines.find(row => row.productId === "PRR_RM").productionRunLineId
    const issued = run("prr_operator", P + "issue#ProductionMaterial", {
        operationKey: key(),
        workEffortId,
        productionRunLineId: material,
        assetId: state.rm,
        quantity
    })
    if (issued.error) throw new Error("Issue failed: " + issued.error)
    return {workEffortId, material}
}
const downtime = (reasonCode, fromHours, thruHours) => {
    const out = run("prr_operator", P + "store#ProductionDowntime", {
        operationKey: key(),
        action: "open",
        facilityId: plant,
        reasonCode,
        fromDate: new Date(state.t0 + fromHours * hourMs),
        thruDate: new Date(state.t0 + thruHours * hourMs)
    })
    if (out.error) throw new Error("Downtime failed: " + out.error)
}
// the period of the OEE features: 6 hours before the setup to 2 hours after it, 8 hours around the clock (no calendar)
const period = () => ({fromDate: new Date(state.t0 - 6 * hourMs), thruDate: new Date(state.t0 + 2 * hourMs)})
const close = (value, expected) => value != null && Math.abs(value - expected) < 0.001

spec({
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        for (const partyId of [org, other, second]) {
            call("create#mantle.party.Party", {partyId, partyTypeEnumId: "PtyOrganization"})
            call("create#mantle.party.Organization", {partyId, organizationName: partyId})
            call("create#mantle.party.PartyRole", {partyId, roleTypeId: "OrgInternal"})
        }
        call("mantle.ledger.LedgerServices.init#PartyAccountingConfiguration", {
            organizationPartyId: org,
            sourcePartyId: "DefaultSettings",
            baseCurrencyUomId: "USD"
        })
        call("mantle.ledger.LedgerServices.get#OrganizationFiscalTimePeriods", {
            organizationPartyId: org,
            filterDate: ec.user.nowTimestamp
        })
        user("PRR_METHOD", ["METHOD_VIEW", "METHOD_EDIT", "METHOD_APPROVE", "METHOD_RESOURCES"])
        user("PRR_PLANNER", ["PRODUCTION_PLAN", "PRODUCTION_VIEW", "METHOD_VIEW"])
        user("PRR_OPERATOR", ["PRODUCTION_OPERATE", "PRODUCTION_VIEW", "STOCK_ISSUE"])
        user("PRR_READER", ["PRODUCTION_VIEW"])
        user("PRR_FINANCE", ["PRODUCTION_VIEW", "ACCOUNTING_VIEW"])
        user("PRR_NOBODY", ["METHOD_VIEW"])
        user("PRR_OUTSIDER", ["PRODUCTION_VIEW", "ACCOUNTING_VIEW"], [other])
        user("PRR_TWO", ["PRODUCTION_VIEW"], [org, second])
        call("create#mantle.facility.Facility", {
            facilityId: plant,
            facilityTypeEnumId: "FcTpWarehouse",
            facilityName: "Report plant",
            ownerPartyId: org
        })
        call("create#mantle.facility.FacilityLocation", {
            facilityId: plant,
            locationSeqId: "PICK1",
            locationTypeEnumId: "FltPick"
        })
        call("create#mantle.facility.Facility", {
            facilityId: "PRR_OTHER_PLANT",
            facilityTypeEnumId: "FcTpWarehouse",
            facilityName: "Other plant",
            ownerPartyId: other
        })
        for (const productId of ["PRR_FIN", "PRR_RM"])
            call("create#mantle.product.Product", {
                productId,
                productName: productId,
                productTypeEnumId: "PtAsset",
                assetTypeEnumId: "AstTpInventory",
                amountUomId: "OTH_ea",
                ownerPartyId: org
            })
        call("create#mantle.product.cost.ProductStandardCost", {
            productStandardCostId: "PRR_STD",
            productId: "PRR_FIN",
            organizationPartyId: org,
            state: "approved",
            fromDate: since,
            quantity: 1,
            quantityUomId: "OTH_ea",
            priceUomId: "USD",
            unitCost: 5,
            totalCost: 5,
            materialCost: 2,
            laborCost: 3,
            complete: "Y"
        })
        // the reasons: two unplanned stops, a planned one, a scrap and a rework
        const reasons = [
            ["PRR_JAM", "Jam", "PrcDowntime", "N"],
            ["PRR_FAULT", "Fault", "PrcDowntime", "N"],
            ["PRR_CHANGE", "Planned changeover", "PrcDowntime", "Y"],
            ["PRR_DROP", "Dropped", "PrcScrap", "N"],
            ["PRR_REDO", "Redo", "PrcRework", "N"]
        ]
        for (const [reasonCode, reasonName, reasonCategoryEnumId, plannedStop] of reasons)
            call("create#mantle.work.production.ProductionReason", {
                organizationPartyId: org,
                reasonCode,
                fromDate: since,
                reasonName,
                reasonCategoryEnumId,
                equipmentFault: "N",
                plannedStop
            })
        // a work center of the second organization whose calendar's time zone is not known, so its hours cannot be read:
        // its calendar's holiday today starts in that zone
        call("create#mantle.facility.Facility", {
            facilityId: broken,
            facilityTypeEnumId: "FcTpLine",
            facilityName: "Broken line",
            ownerPartyId: second
        })
        call("create#mantle.work.calendar.Calendar", {calendarId: "PRR_BAD_CAL", description: "Bad zone", timeZone: "Not/AZone"})
        call("create#mantle.work.production.WorkCenter", {facilityId: broken, calendarId: "PRR_BAD_CAL"})
        call("create#mantle.work.effort.WorkEffort", {
            workEffortId: "PRR_HOLIDAY",
            workEffortTypeEnumId: "WetEvent",
            purposeEnumId: "WepHoliday",
            ownerPartyId: second,
            workEffortName: "Plant holiday",
            allDayStart: ec.l10n.format(ec.user.nowTimestamp, "yyyy-MM-dd")
        })
        ec.artifactExecution.enableAuthz()
        // the method: one operation of half an hour of machine time a unit at the plant, consuming one PRR_RM a unit
        as("prr_method", () => {
            call(R + "store#WorkCenter", {organizationPartyId: org, facilityId: plant, changeReason: "Spec work center"})
            const routeId = call(R + "store#Routing", {
                organizationPartyId: org,
                workEffortName: "Report routing",
                changeReason: "Spec"
            }).routing.workEffortId
            const operationId = call(R + "store#RoutingOperation", {
                workEffortId: routeId,
                workEffortName: "Assemble",
                sequenceNum: 10,
                estimatedWorkTime: 6,
                methodMachineRunTime: 30,
                timeUomId: "TF_min",
                methodBatchQuantity: 1,
                methodQuantityUomId: "OTH_ea",
                methodWorkCenterId: plant,
                changeReason: "Spec operation"
            }).operationWorkEffortId
            const routing = call(R + "get#RoutingDetail", {workEffortId: routeId})
            call(R + "release#RoutingDraft", {
                workEffortId: routeId,
                expectedRevision: routing.expectedRevision,
                changeReason: "Spec"
            })
            const productBomId = call(B + "store#Bom", {
                productId: "PRR_FIN",
                organizationPartyId: org,
                routingWorkEffortId: routeId,
                changeReason: "Spec method"
            }).productBom.productBomId
            call(B + "store#BomItem", {
                productBomId,
                productId: "PRR_RM",
                quantity: 1,
                operationWorkEffortId: operationId,
                changeReason: "Spec line"
            })
            const detail = call(B + "get#BomDetail", {productBomId})
            call(B + "release#BomDraft", {productBomId, expectedRevision: detail.expectedRevision, changeReason: "Spec release"})
        })
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        state.rm = stock("PRR_RM", 100, 2)
        ec.artifactExecution.enableAuthz()
        state.t0 = Date.now()
        // run A: 10 made, 8 good, 1 scrapped and 1 sent to rework in run B, which makes it good again
        const a = releasedRun(10)
        const b = releasedRun(1)
        const recorded = run("prr_operator", P + "record#ProductionQuantity", {
            operationKey: key(),
            workEffortId: a.workEffortId,
            good: 8,
            scrap: 1,
            reasonCode: "PRR_DROP",
            toLocationSeqId: "PICK1"
        })
        if (recorded.error) throw new Error("Quantities failed: " + recorded.error)
        const reworked = run("prr_operator", P + "record#ProductionLoss", {
            operationKey: key(),
            workEffortId: a.workEffortId,
            lossTypeEnumId: "PltRework",
            quantity: 1,
            reasonCode: "PRR_REDO",
            reworkWorkEffortId: b.workEffortId
        })
        if (reworked.error) throw new Error("Rework failed: " + reworked.error)
        const redone = run("prr_operator", P + "record#ProductionQuantity", {
            operationKey: key(),
            workEffortId: b.workEffortId,
            good: 1,
            toLocationSeqId: "PICK1"
        })
        if (redone.error) throw new Error("Rework output failed: " + redone.error)
        // the plant's stops: two overlapping unplanned ones (1.5 hours together) and a planned changeover of an hour
        downtime("PRR_JAM", -3, -2)
        downtime("PRR_FAULT", -2.5, -1.5)
        downtime("PRR_CHANGE", -5, -4)
        // with the shop floor in this build, the plant's machine ran the whole period
        state.runtimeDefined = ec.entity.isEntityDefined(RUNTIME)
        if (state.runtimeDefined) {
            ec.artifactExecution.disableAuthz()
            call("create#" + RUNTIME, {
                organizationPartyId: org,
                workEffortId: a.workEffortId,
                facilityId: plant,
                runtimeModeEnumId: "MrmRun",
                fromDate: new Date(state.t0 - 6 * hourMs),
                thruDate: new Date(state.t0 + 2 * hourMs)
            })
            ec.artifactExecution.enableAuthz()
        }
        state.a = a
        state.b = b
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

feature("OEE for a work center shows its three factors from its downtime and counted units, a reworked unit counted once", {
    when() {
        const out = report("prr_reader", "OperationPerformanceReport", Object.assign({facilityId: plant}, period()))
        const center = (out.centerRows || []).find(row => row.facilityId === plant) || {}
        const runtimePartition = (out.partitions || []).some(row => row.name === "Machine runtime (shop floor)")
        return {out, center, runtimePartition}
    },
    then({out, center, runtimePartition}) {
        out.error == ""
        // planned: 8 hours less the planned changeover; downtime: the two stops unioned (1.5 hours, not 2)
        close(center.plannedHours, 7)
        close(center.plannedStopHours, 1)
        close(center.downtimeHours, 1.5)
        close(center.runHours, 5.5)
        // 10 units counted (8 good, 1 scrap, 1 rework; run B's redone unit is not counted again), half an hour each
        center.totalQuantity == 10
        center.goodQuantity == 8
        close(center.standardHours, 5)
        close(center.availability, 5.5 / 7)
        close(center.performance, 5 / 5.5)
        close(center.quality, 0.8)
        close(center.oee, 4 / 7)
        center.oeeText == "57.1%"
        close(out.totals.oee, 4 / 7)
        out.downtimeRows.some(row => row.reasonText == "Planned changeover" && row.kindText == "Planned (excluded)")
        // machine runtime: read when this build has it, else named and the report incomplete
        runtimePartition == !state.runtimeDefined
        out.complete == state.runtimeDefined
        state.runtimeDefined ? close(center.machineHours, 5.5) : center.machineHours == null
        out.asOf != null
        out.scope.facilityText == "Report plant"
        out.unitsText != ""
    }
})

feature("a reader without financial read gets the quantities and no money columns; a financial reader gets the costs", {
    when() {
        const parameters = {workEffortId: state.a.workEffortId}
        return {
            reader: report("prr_reader", "ProductionCostReport", parameters),
            finance: report("prr_finance", "ProductionCostReport", parameters),
            readerLoss: report("prr_reader", "ProductionLossReport", {facilityId: plant}),
            financeLoss: report("prr_finance", "ProductionLossReport", {facilityId: plant}),
            readerVariance: report("prr_reader", "BomVarianceReport", parameters)
        }
    },
    then({reader, finance, readerLoss, financeLoss, readerVariance}) {
        reader.error == ""
        reader.financialRead == false
        reader.costRows.length == 1
        reader.costRows[0].goodQuantity == 8
        reader.costRows[0].eventCount > 0
        !("materialCost" in reader.costRows[0]) &&
            !("wipAmount" in reader.costRows[0]) &&
            !("currencyUomId" in reader.costRows[0])
        reader.moneyTotals == null
        reader.currencyUomIds == []
        reader.withheldText.includes("financial read")
        finance.financialRead == true
        finance.costRows[0].materialCost == 20
        finance.costRows[0].wipAmount != null
        finance.currencyUomIds == ["USD"]
        finance.moneyTotals.length == 1
        // the loss's cost is the financial reader's only
        readerLoss.lossRows.length > 0
        readerLoss.lossRows.every(row => !("lossCost" in row))
        readerLoss.costTotals == null
        financeLoss.costTotals != null
        // the variance's quantities without its cost
        readerVariance.lineRows.length == 1
        !("actualCost" in readerVariance.lineRows[0]) && !("usageVariance" in readerVariance.lineRows[0])
    }
})

feature(
    "a work center whose calendar cannot be read is a named partition: the report is incomplete and the center is not counted as zero",
    {
        when() {
            return {out: report("prr_two", "OperationPerformanceReport", period())}
        },
        then({out}) {
            out.error == ""
            out.complete == false
            out.partitions.some(row => row.name == "Work center Broken line" && row.message.includes("Not/AZone"))
            // the readable center is there with its figures; the broken one is not shown with zeros
            out.centerRows.some(row => row.facilityId == plant && row.plannedHours == 7)
            !out.centerRows.some(row => row.facilityId == broken)
            out.totals.centerCount == 1
            out.partitionsText.includes("Broken line")
        }
    }
)

feature("each report answers its scope, as-of time and units with the run's figures", {
    when() {
        const scope = {facilityId: plant}
        return {
            status: report("prr_reader", "ProductionStatusReport", Object.assign({statusId: "all"}, scope)),
            material: report("prr_reader", "ProductionMaterialReport", {workEffortId: state.a.workEffortId}),
            loss: report("prr_reader", "ProductionLossReport", scope),
            quality: report("prr_reader", "ProductionQualityReport", scope),
            variance: report("prr_reader", "BomVarianceReport", {workEffortId: state.a.workEffortId}),
            planning: report("prr_reader", "ProductionPlanningReport", scope),
            dashboard: report("prr_reader", "ProductionDashboard", Object.assign({}, scope, period())),
            financeDashboard: report("prr_finance", "ProductionDashboard", Object.assign({}, scope, period()))
        }
    },
    then({status, material, loss, quality, variance, planning, dashboard, financeDashboard}) {
        const statusRow = status.statusRows.find(row => row.workEffortId == state.a.workEffortId)
        status.error == ""
        statusRow.targetQuantity == 10
        statusRow.goodQuantity == 8
        status.totalRows.length == 1
        status.asOf != null
        material.error == ""
        material.lineRows.find(row => row.roleText == "Material").issuedQuantity == 10
        material.lineRows.find(row => row.roleText == "Output").goodQuantity == 8
        material.unitList.map(row => row.uomId) == ["OTH_ea"]
        loss.error == ""
        loss.totalRows[0].scrapQuantity == 1
        loss.totalRows[0].reworkQuantity == 1
        loss.totalRows[0].goodQuantity == 9
        quality.error == ""
        quality.qualityRows == []
        quality.complete == true
        // planned 10 scaled to the 8 good, against 10 issued
        variance.lineRows[0].plannedQuantity == 8
        variance.lineRows[0].actualQuantity == 10
        variance.lineRows[0].varianceQuantity == 2
        variance.yieldRows[0].yieldText == "80.0%"
        planning.error == ""
        planning.suggestionRows == []
        dashboard.error == ""
        dashboard.kpis.map(row => row.kpiId) == ["completed", "onTime", "oee", "utilization", "scrapRate"]
        dashboard.kpis.find(row => row.kpiId == "oee").valueText == "57.1%"
        dashboard.kpis.find(row => row.kpiId == "oee").reportName == "OperationPerformanceReport"
        dashboard.kpis.find(row => row.kpiId == "oee").parameters.facilityId == plant
        dashboard.withheldText.includes("WIP value")
        financeDashboard.kpis.some(row => row.kpiId == "wipValue")
    }
})

feature(
    "a user without PRODUCTION_VIEW is refused, another organization's reader sees none of these runs, and a facility outside the scope is refused",
    {
        when() {
            const parameters = {workEffortId: state.a.workEffortId}
            return {
                reader: report("prr_reader", "ProductionCostReport", parameters),
                nobody: report("prr_nobody", "ProductionCostReport", parameters),
                nobodyDashboard: report("prr_nobody", "ProductionDashboard", {}),
                outsider: report("prr_outsider", "ProductionCostReport", parameters),
                outsiderStatus: report("prr_outsider", "ProductionStatusReport", {statusId: "all"}),
                otherFacility: report("prr_reader", "ProductionLossReport", {facilityId: "PRR_OTHER_PLANT"}),
                otherOrganization: report("prr_reader", "ProductionStatusReport", {organizationPartyId: other}),
                longPeriod: report("prr_reader", "ProductionLossReport", {fromDate: "2020-01-01", thruDate: "2026-01-01"})
            }
        },
        then({reader, nobody, nobodyDashboard, outsider, outsiderStatus, otherFacility, otherOrganization, longPeriod}) {
            reader.error == ""
            nobody.error.includes("PRODUCTION_VIEW")
            nobodyDashboard.error.includes("PRODUCTION_VIEW")
            outsider.error == ""
            outsider.costRows == []
            !outsiderStatus.statusRows.some(row => row.workEffortId == state.a.workEffortId)
            otherFacility.error.includes("not available")
            otherOrganization.error.includes("not available")
            longPeriod.error.includes("at most")
        }
    }
)
