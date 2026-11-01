// Production runs and the production stock guards (impl-warehouse P16, design-manufacturing §12 M2 and M4, design §19
// "subcontract output"): a run is created from Products' released BOM and routing (its lines stop at a non-phantom
// sub-assembly and blow a phantom through with its routing; no PatMfgBom row), released with its operations and frozen
// standard, and keeps its lines after a later release of the BOM, while a draft read before that release must be
// re-exploded; two components are issued in two operations as two issuances and a retried issue answers the first; a
// quarantined component and another owner's are refused; an unused component returns as a new receipt at its cost; output
// is received into quarantine with generated serials at the frozen standard cost; a subcontract's output is received from
// the vendor-custody facility, its components issued there and the service line accepted once. The users are in spec-local
// groups.
const P = "mantle.work.ProductionServices.",
    B = "mantle.product.BomServices.",
    R = "mantle.work.RoutingServices."
const org = "WPD_ORG",
    facility = "WPD_FAC",
    vendor = "WPD_VENDOR",
    supplier = "WPD_SUPPLIER"
const find = (entity, conditions = {}) => ec.entity.find(entity).condition(conditions).disableAuthz()
const one = (entity, conditions) => find(entity, conditions).one()
const rows = (entity, conditions) => Array.from(find(entity, conditions).list())
const n = value => (value == null ? 0 : Number(String(value)))
const since = "2000-01-01T00:00:00Z"
const state = {}
let keySeq = 0
const key = () => "wpd-op-" + ++keySeq
// the clock moves on, so a release made next is after what was read before it
function tick() {
    const until = Date.now() + 25
    while (Date.now() < until) {}
}

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
function receive(productId, quantity, acquireCost, facilityId = facility, locationSeqId = "PICK1", extra = {}) {
    const assetId = call(
        "mantle.product.AssetServices.receive#Asset",
        Object.assign(
            {productId, quantity, facilityId, locationSeqId, ownerPartyId: org, assetTypeEnumId: "AstTpInventory"},
            {statusId: "AstAvailable", acquireCost},
            extra
        )
    ).assetId
    call("update#mantle.product.asset.Asset", {assetId, acquireCostUomId: "USD"})
    return assetId
}
const asset = assetId => one("mantle.product.asset.Asset", {assetId})
const linesOf = workEffortId => rows("mantle.work.production.ProductionRunLine", {workEffortId})
const lineOf = (workEffortId, productId) => linesOf(workEffortId).find(line => line.productId === productId)
// a routing of one or more operations, released (as the method engineer and approver)
function routing(name, operations) {
    const route = call(R + "store#Routing", {organizationPartyId: org, workEffortName: name, changeReason: "Spec routing"})
    const routeId = route.routing.workEffortId
    const ids = operations.map(
        (opName, index) =>
            call(R + "store#RoutingOperation", {
                workEffortId: routeId,
                workEffortName: opName,
                sequenceNum: (index + 1) * 10,
                estimatedWorkTime: 6,
                timeUomId: "TF_min",
                methodBatchQuantity: 1,
                methodQuantityUomId: "OTH_ea",
                methodWorkCenterId: facility,
                changeReason: "Spec operation"
            }).operationWorkEffortId
    )
    const detail = call(R + "get#RoutingDetail", {workEffortId: routeId})
    call(R + "release#RoutingDraft", {workEffortId: routeId, expectedRevision: detail.expectedRevision, changeReason: "Spec"})
    return {routeId, ids}
}
// a BOM of the product with its lines, released
function bom(productId, items, header = {}) {
    const created = call(
        B + "store#Bom",
        Object.assign({productId, organizationPartyId: org, changeReason: "Spec method"}, header)
    )
    const productBomId = created.productBom.productBomId
    for (const item of items) call(B + "store#BomItem", Object.assign({productBomId, changeReason: "Spec line"}, item))
    const detail = call(B + "get#BomDetail", {productBomId})
    call(B + "release#BomDraft", {productBomId, expectedRevision: detail.expectedRevision, changeReason: "Spec release"})
    return productBomId
}

spec({
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        for (const partyId of [org, "WPD_OTHER"]) {
            call("create#mantle.party.Party", {partyId, partyTypeEnumId: "PtyOrganization"})
            call("create#mantle.party.Organization", {partyId, organizationName: partyId})
            call("create#mantle.party.PartyRole", {partyId, roleTypeId: "OrgInternal"})
        }
        call("create#mantle.party.Party", {partyId: supplier, partyTypeEnumId: "PtyOrganization"})
        call("create#mantle.party.Organization", {partyId: supplier, organizationName: "Outside coater"})
        call("create#mantle.party.PartyRole", {partyId: supplier, roleTypeId: "Supplier"})
        call("mantle.ledger.LedgerServices.init#PartyAccountingConfiguration", {
            organizationPartyId: org,
            sourcePartyId: "DefaultSettings",
            baseCurrencyUomId: "USD"
        })
        call("mantle.ledger.LedgerServices.get#OrganizationFiscalTimePeriods", {
            organizationPartyId: org,
            filterDate: ec.user.nowTimestamp
        })
        user("WPD_METHOD", ["METHOD_VIEW", "METHOD_EDIT", "METHOD_APPROVE", "METHOD_RESOURCES"])
        user("WPD_PLANNER", ["PRODUCTION_PLAN", "PRODUCTION_VIEW", "METHOD_VIEW"])
        user("WPD_ISSUER", ["STOCK_ISSUE", "ACCOUNTING_VIEW"])
        user("WPD_READER", ["PRODUCTION_VIEW"])
        user("WPD_BUYER", ["PURCHASE_ORDER_EDIT"])
        user("WPD_OUTSIDER", ["STOCK_ISSUE", "PRODUCTION_PLAN", "PRODUCTION_VIEW", "METHOD_VIEW"], "WPD_OTHER")
        for (const facilityId of [facility, vendor])
            call("create#mantle.facility.Facility", {facilityId, facilityTypeEnumId: "FcTpWarehouse", ownerPartyId: org})
        call("create#mantle.facility.Facility", {
            facilityId: "WPD_FOREIGN",
            facilityTypeEnumId: "FcTpWarehouse",
            ownerPartyId: "WPD_OTHER"
        })
        for (const [locationSeqId, locationTypeEnumId] of [
            ["PICK1", "FltPick"],
            ["PICK2", "FltPick"],
            ["QUAR1", "FltQuarantine"]
        ])
            call("create#mantle.facility.FacilityLocation", {facilityId: facility, locationSeqId, locationTypeEnumId})
        call("create#mantle.facility.FacilityLocation", {
            facilityId: vendor,
            locationSeqId: "CAGE",
            locationTypeEnumId: "FltBulk"
        })
        call("create#mantle.facility.FacilityParty", {
            facilityId: vendor,
            partyId: supplier,
            roleTypeId: "Custodian",
            fromDate: since
        })
        for (const productId of [
            "WPD_FIN",
            "WPD_SUB",
            "WPD_PH",
            "WPD_RM_A",
            "WPD_RM_B",
            "WPD_RM_C",
            "WPD_RM_D",
            "WPD_CF",
            "WPD_NOBOM"
        ])
            call("create#mantle.product.Product", {
                productId,
                productName: productId,
                productTypeEnumId: "PtAsset",
                assetTypeEnumId: "AstTpInventory",
                amountUomId: "OTH_ea",
                ownerPartyId: org
            })
        call("create#mantle.product.Product", {
            productId: "WPD_COAT",
            productName: "Coating",
            productTypeEnumId: "PtService",
            ownerPartyId: org
        })
        // the finished product is serial-tracked and inspected; output goes to quarantine at QUAR1
        call("create#mantle.facility.WarehousePolicy", {
            organizationPartyId: org,
            policyType: "tracking",
            facilityId: "_NA_",
            productId: "WPD_FIN",
            fromDate: since,
            serialRequired: "Y",
            inspectionRequired: "Y"
        })
        call("create#mantle.facility.WarehousePolicy", {
            organizationPartyId: org,
            policyType: "operation",
            facilityId: facility,
            productId: "_NA_",
            fromDate: since,
            receiptSteps: 1,
            quarantineLocationSeqId: "QUAR1"
        })
        // the approved standard cost of the finished product (Products P9; its approval is Products' spec)
        call("create#mantle.product.cost.ProductStandardCost", {
            productStandardCostId: "WPD_STD",
            productId: "WPD_FIN",
            organizationPartyId: org,
            state: "approved",
            fromDate: since,
            quantity: 1,
            quantityUomId: "OTH_ea",
            priceUomId: "USD",
            unitCost: 10.5,
            totalCost: 10.5
        })
        ec.artifactExecution.enableAuthz()
        // the methods: WPD_FIN from two operations, a phantom with its own routing, and a sub-assembly that stops the run's
        // lines; WPD_CF of one outside operation
        as("wpd_method", () => {
            call(R + "store#WorkCenter", {
                organizationPartyId: org,
                facilityId: facility,
                efficiencyPercent: 100,
                changeReason: "Spec work center"
            })
            state.route = routing("Finish routing", ["Prepare", "Assemble"])
            state.phantomRoute = routing("Phantom routing", ["Kit the phantom"])
            state.coatRoute = routing("Coating routing", ["Outside coating"])
            bom("WPD_SUB", [{productId: "WPD_RM_D", quantity: 1}])
            bom("WPD_PH", [{productId: "WPD_RM_C", quantity: 3, operationWorkEffortId: state.phantomRoute.ids[0]}], {
                isPhantom: "Y",
                routingWorkEffortId: state.phantomRoute.routeId
            })
            state.finBom = bom(
                "WPD_FIN",
                [
                    {productId: "WPD_RM_A", quantity: 2, operationWorkEffortId: state.route.ids[0]},
                    {productId: "WPD_RM_B", quantity: 1, operationWorkEffortId: state.route.ids[1]},
                    {productId: "WPD_PH", quantity: 1, operationWorkEffortId: state.route.ids[1]},
                    {productId: "WPD_SUB", quantity: 1, operationWorkEffortId: state.route.ids[1]}
                ],
                {routingWorkEffortId: state.route.routeId}
            )
            bom("WPD_CF", [{productId: "WPD_RM_A", quantity: 1, operationWorkEffortId: state.coatRoute.ids[0]}], {
                routingWorkEffortId: state.coatRoute.routeId
            })
        })
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        state.stockA = receive("WPD_RM_A", 10, 2)
        state.stockB = receive("WPD_RM_B", 5, 3)
        state.held = receive("WPD_RM_A", 5, 2, facility, "QUAR1", {statusId: "AstQuarantine"})
        state.foreignOwned = receive("WPD_RM_B", 5, 3, facility, "PICK2", {ownerPartyId: "WPD_OTHER"})
        state.vendorCheap = receive("WPD_RM_A", 2, 2, vendor, "CAGE")
        state.vendorDear = receive("WPD_RM_A", 5, 3, vendor, "CAGE")
        ec.artifactExecution.enableAuthz()
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

feature("a run is created from the released BOM with its own lines; no PatMfgBom row; a retry answers the first draft", {
    when() {
        const operationKey = key()
        const parameters = {operationKey, organizationPartyId: org, productId: "WPD_FIN", quantity: 2, facilityId: facility}
        const created = run("wpd_planner", P + "create#ProductionOrder", parameters)
        const retry = run("wpd_planner", P + "create#ProductionOrder", parameters)
        const issuer = run("wpd_issuer", P + "create#ProductionOrder", Object.assign({}, parameters, {operationKey: key()}))
        const outsider = run("wpd_outsider", P + "create#ProductionOrder", Object.assign({}, parameters, {operationKey: key()}))
        const noMethod = run(
            "wpd_planner",
            P + "create#ProductionOrder",
            Object.assign({}, parameters, {operationKey: key(), productId: "WPD_NOBOM"})
        )
        state.run1 = created.workEffortId
        return {created, retry, issuer, outsider, noMethod}
    },
    then({created, retry, issuer, outsider, noMethod}) {
        created.error == ""
        created.existing == false
        retry.existing == true
        retry.workEffortId == created.workEffortId
        issuer.error.includes("PERMISSION_DENIED")
        outsider.error.includes("RECORD_UNAVAILABLE")
        noMethod.error.includes("METHOD_REQUIRED")
        const effort = one("mantle.work.effort.WorkEffort", {workEffortId: created.workEffortId})
        effort.purposeEnumId == "WepProductionRun"
        effort.statusId == "WeInPlanning"
        effort.ownerPartyId == org
        n(effort.productionRevision) == 1
        effort.productBomId == state.finBom
        // the lines: the output, the components to the sub-assembly (whose stock counts), the phantom's component
        const lines = linesOf(created.workEffortId)
        lines.length == 5
        n(lineOf(created.workEffortId, "WPD_FIN").stockQuantity) == 2
        lineOf(created.workEffortId, "WPD_FIN").lineRoleEnumId == "PrlrOutput"
        n(lineOf(created.workEffortId, "WPD_RM_A").stockQuantity) == 4
        n(lineOf(created.workEffortId, "WPD_RM_B").stockQuantity) == 2
        n(lineOf(created.workEffortId, "WPD_RM_C").stockQuantity) == 6
        n(lineOf(created.workEffortId, "WPD_SUB").stockQuantity) == 2
        lineOf(created.workEffortId, "WPD_RM_D") == null
        lineOf(created.workEffortId, "WPD_PH") == null
        lineOf(created.workEffortId, "WPD_RM_C").routingOperationWorkEffortId == state.phantomRoute.ids[0]
        !!lineOf(created.workEffortId, "WPD_RM_A").bomItemId
        // the planning aggregate, and nothing of the legacy BOM
        const products = rows("mantle.work.effort.WorkEffortProduct", {workEffortId: created.workEffortId})
        products.filter(row => row.typeEnumId === "WeptConsume").length == 4
        products.find(row => row.typeEnumId === "WeptProduce").productId == "WPD_FIN"
        rows("mantle.product.ProductAssoc", {productId: "WPD_FIN", productAssocTypeEnumId: "PatMfgBom"}).length == 0
    }
})

feature("release freezes the lines on their operations with the standard; a later BOM release leaves them; a draft re-explodes", {
    when() {
        const released = run("wpd_planner", P + "release#ProductionOrder", {
            operationKey: key(),
            workEffortId: state.run1,
            expectedRevision: 1
        })
        const again = run("wpd_planner", P + "release#ProductionOrder", {operationKey: key(), workEffortId: state.run1})
        const draft = run("wpd_planner", P + "create#ProductionOrder", {
            operationKey: key(),
            organizationPartyId: org,
            productId: "WPD_FIN",
            quantity: 1,
            facilityId: facility
        })
        state.run2 = draft.workEffortId
        tick()
        // the method changes: three of WPD_RM_A from now
        as("wpd_method", () => {
            const line = call(B + "get#BomDetail", {productBomId: state.finBom}).bomItemRows.find(
                row => row.productId === "WPD_RM_A"
            )
            call(B + "store#BomItem", {bomItemId: line.bomItemId, quantity: 3, changeReason: "More of A"})
            const detail = call(B + "get#BomDetail", {productBomId: state.finBom})
            call(B + "release#BomDraft", {
                productBomId: state.finBom,
                expectedRevision: detail.expectedRevision,
                changeReason: "Second method"
            })
        })
        tick()
        const stale = run("wpd_planner", P + "release#ProductionOrder", {operationKey: key(), workEffortId: state.run2})
        const reexploded = run("wpd_planner", P + "release#ProductionOrder", {
            operationKey: key(),
            workEffortId: state.run2,
            reexplode: true
        })
        return {released, again, stale, reexploded}
    },
    then({released, again, stale, reexploded}) {
        released.error == ""
        released.result.resultCode == "RELEASED"
        released.result.productStandardCostId == "WPD_STD"
        released.result.operationWorkEffortIds.length == 3
        again.error.includes("RUN_NOT_DRAFT")
        const effort = one("mantle.work.effort.WorkEffort", {workEffortId: state.run1})
        effort.statusId == "WeApproved"
        effort.productStandardCostId == "WPD_STD"
        !!effort.productionReleaseDate
        n(effort.productionRevision) == 2
        // the operation children: the phantom's first, each with its routing operation, owner and work center
        const ops = rows("mantle.work.effort.WorkEffort", {parentWorkEffortId: state.run1})
        ops.length == 3
        ops.every(op => op.ownerPartyId === org && op.workCenterFacilityId === facility)
        const opOf = routingOp => ops.find(op => op.routingOperationWorkEffortId === routingOp)
        n(opOf(state.phantomRoute.ids[0]).sequenceNum) == 1
        lineOf(state.run1, "WPD_RM_A").operationWorkEffortId == opOf(state.route.ids[0]).workEffortId
        lineOf(state.run1, "WPD_RM_B").operationWorkEffortId == opOf(state.route.ids[1]).workEffortId
        linesOf(state.run1).every(line => !!line.frozenDate)
        // the later release leaves the released run's lines
        n(lineOf(state.run1, "WPD_RM_A").stockQuantity) == 4
        // the draft read before it is refused, then re-exploded as of now
        stale.error.includes("METHOD_CHANGED")
        reexploded.error == ""
        reexploded.result.reexploded == true
        n(lineOf(state.run2, "WPD_RM_A").stockQuantity) == 3
        n(one("mantle.work.effort.WorkEffort", {workEffortId: state.run2}).productionRevision) == 3
        // unrelease is a seeded transition (its guard is Manufacturing's)
        !!one("moqui.basic.StatusFlowTransition", {statusFlowId: "Default", statusId: "WeApproved", toStatusId: "WeInPlanning"})
    }
})
