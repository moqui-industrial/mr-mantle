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
            "WPD_NOBOM",
            "WPD_PV",
            "WPD_BY",
            "WPD_PH2",
            "WPD_RM_E",
            "WPD_RM_F"
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
            // WPD_PV has no standard (provisional output) and a by-product; its phantom has a routing but no line names
            // an operation of it (P16 review B3)
            state.ph2Route = routing("Second phantom routing", ["Kit the second phantom"])
            bom("WPD_PH2", [{productId: "WPD_RM_F", quantity: 1}], {isPhantom: "Y", routingWorkEffortId: state.ph2Route.routeId})
            bom(
                "WPD_PV",
                [
                    {productId: "WPD_RM_E", quantity: 1, operationWorkEffortId: state.coatRoute.ids[0]},
                    {productId: "WPD_PH2", quantity: 1},
                    {productId: "WPD_BY", quantity: 1, roleEnumId: "BmirByproduct", allocationShare: 0.1}
                ],
                {routingWorkEffortId: state.coatRoute.routeId}
            )
        })
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        state.stockA = receive("WPD_RM_A", 10, 2)
        state.stockB = receive("WPD_RM_B", 5, 3)
        state.held = receive("WPD_RM_A", 5, 2, facility, "QUAR1", {statusId: "AstQuarantine"})
        state.foreignOwned = receive("WPD_RM_B", 5, 3, facility, "PICK2", {ownerPartyId: "WPD_OTHER"})
        state.vendorCheap = receive("WPD_RM_A", 2, 2, vendor, "CAGE")
        state.vendorDear = receive("WPD_RM_A", 5, 3, vendor, "CAGE")
        state.stockE1 = receive("WPD_RM_E", 3, 1)
        state.stockE2 = receive("WPD_RM_E", 7, 2)
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
        const draftState = one("mantle.work.effort.WorkEffort", {workEffortId: state.run2}).statusId
        const staleRevision = run("wpd_planner", P + "release#ProductionOrder", {
            operationKey: key(),
            workEffortId: state.run2,
            expectedRevision: 1
        })
        const reviewed = run("wpd_planner", P + "release#ProductionOrder", {
            operationKey: key(),
            workEffortId: state.run2,
            expectedRevision: 2
        })
        return {released, again, stale, reexploded, draftState, staleRevision, reviewed}
    },
    then({released, again, stale, reexploded, draftState, staleRevision, reviewed}) {
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
        // the re-explosion rewrites the draft for review (still a draft at the next revision); a release of it follows
        reexploded.error == ""
        reexploded.result.resultCode == "REEXPLODED"
        reexploded.result.revision == 2
        draftState == "WeInPlanning"
        staleRevision.error.includes("REVISION_CHANGED")
        reviewed.error == ""
        reviewed.result.resultCode == "RELEASED"
        n(lineOf(state.run2, "WPD_RM_A").stockQuantity) == 3
        n(one("mantle.work.effort.WorkEffort", {workEffortId: state.run2}).productionRevision) == 3
        // no unrelease transition is seeded until Manufacturing's guard (P16 review B4)
        !one("moqui.basic.StatusFlowTransition", {statusFlowId: "Default", statusId: "WeApproved", toStatusId: "WeInPlanning"})
    }
})

feature("two components issue in two operations as two issuances; a retry answers the first; held and foreign stock refused", {
    when() {
        const lineA = lineOf(state.run1, "WPD_RM_A"),
            lineB = lineOf(state.run1, "WPD_RM_B")
        const issue = (assetId, line, quantity, operationKey = key()) =>
            run("wpd_issuer", P + "issue#ProductionMaterial", {
                operationKey,
                workEffortId: state.run1,
                productionRunLineId: line.productionRunLineId,
                assetId,
                quantity
            })
        const firstKey = key()
        const first = issue(state.stockA, lineA, 2, firstKey)
        const second = issue(state.stockB, lineB, 1)
        const retry = issue(state.stockA, lineA, 2, firstKey)
        const more = issue(state.stockA, lineA, 2)
        const held = issue(state.held, lineA, 1)
        const foreign = issue(state.foreignOwned, lineB, 1)
        const wrongProduct = issue(state.stockB, lineA, 1)
        const tooMuch = issue(state.stockA, lineA, 1)
        const drafted = run("wpd_planner", P + "create#ProductionOrder", {
            operationKey: key(),
            organizationPartyId: org,
            productId: "WPD_FIN",
            quantity: 1,
            facilityId: facility
        })
        const draft = run("wpd_issuer", P + "issue#ProductionMaterial", {
            operationKey: key(),
            workEffortId: drafted.workEffortId,
            productionRunLineId: lineOf(drafted.workEffortId, "WPD_RM_A").productionRunLineId,
            assetId: state.stockA,
            quantity: 1
        })
        const planner = run("wpd_planner", P + "issue#ProductionMaterial", {
            operationKey: key(),
            workEffortId: state.run1,
            productionRunLineId: lineB.productionRunLineId,
            assetId: state.stockB,
            quantity: 1
        })
        state.issueA = first.result?.assetIssuanceId
        state.issueA2 = more.result?.assetIssuanceId
        return {lineA, lineB, first, second, retry, more, held, foreign, wrongProduct, tooMuch, draft, planner}
    },
    then({lineA, lineB, first, second, retry, more, held, foreign, wrongProduct, tooMuch, draft, planner}) {
        first.error == ""
        second.error == ""
        retry.result.alreadyApplied == true
        retry.result.assetIssuanceId == first.result.assetIssuanceId
        more.error == ""
        more.result.assetIssuanceId != first.result.assetIssuanceId
        const issuances = rows("mantle.product.issuance.AssetIssuance", {workEffortId: state.run1})
        issuances.length == 3
        const one1 = issuances.find(row => row.assetIssuanceId === first.result.assetIssuanceId)
        one1.productionMaterialLineId == lineA.productionRunLineId
        one1.operationWorkEffortId == lineA.operationWorkEffortId
        n(one1.quantity) == 2
        const one2 = issuances.find(row => row.assetIssuanceId === second.result.assetIssuanceId)
        one2.operationWorkEffortId == lineB.operationWorkEffortId
        one2.operationWorkEffortId != one1.operationWorkEffortId
        n(asset(state.stockA).quantityOnHandTotal) == 6
        held.error.includes("HELD_STOCK")
        foreign.error.includes("OWNER_MISMATCH")
        wrongProduct.error.includes("PRODUCT_MISMATCH")
        tooMuch.error.includes("QUANTITY_EXCEEDS_REMAINING")
        draft.error.includes("RUN_NOT_RELEASED")
        planner.error.includes("PERMISSION_DENIED")
        // each issue posted once to WIP (the run owned by the organization)
        rows("mantle.ledger.transaction.AcctgTrans", {assetIssuanceId: first.result.assetIssuanceId}).length == 1
    }
})

feature("an unused component returns as a new receipt at its cost, into its asset or a new one; the issuance is unchanged", {
    when() {
        const back = run("wpd_issuer", P + "return#UnusedMaterial", {
            operationKey: key(),
            assetIssuanceId: state.issueA,
            quantity: 1,
            reason: "Left over"
        })
        const moved = run("wpd_issuer", P + "return#UnusedMaterial", {
            operationKey: key(),
            assetIssuanceId: state.issueA2,
            quantity: 1,
            toLocationSeqId: "PICK2"
        })
        const tooMuch = run("wpd_issuer", P + "return#UnusedMaterial", {
            operationKey: key(),
            assetIssuanceId: state.issueA,
            quantity: 2
        })
        const read = run("wpd_reader", P + "get#ProductionOrder", {workEffortId: state.run1})
        return {back, moved, tooMuch, read}
    },
    then({back, moved, tooMuch, read}) {
        back.error == ""
        back.result.intoOriginal == true
        back.result.assetId == state.stockA
        asset(state.stockA).acquireWorkEffortId == null
        n(asset(state.stockA).quantityOnHandTotal) == 7
        const receipt = one("mantle.product.receipt.AssetReceipt", {assetReceiptId: back.result.assetReceiptId})
        receipt.sourceAssetIssuanceId == state.issueA
        receipt.workEffortId == state.run1
        n(one("mantle.product.issuance.AssetIssuance", {assetIssuanceId: state.issueA}).quantity) == 2
        moved.error == ""
        moved.result.intoOriginal == false
        n(asset(moved.result.assetId).acquireCost) == 2
        asset(moved.result.assetId).locationSeqId == "PICK2"
        tooMuch.error.includes("QUANTITY_EXCEEDS_ISSUED")
        // the reader sees the line's issued and returned quantities, and no value without financial read
        read.error == ""
        const lineA = read.lines.find(line => line.productId === "WPD_RM_A")
        lineA.issued == "4"
        lineA.returned == "2"
        lineA.remaining == "2"
        read.issuances.every(row => row.value == null)
        read.run.standardUnitCost == null
        read.run.productStandardCostId == "WPD_STD"
    }
})

feature("output is received into quarantine with generated serials at the run's frozen standard cost, inspected", {
    when() {
        const operationKey = key()
        const parameters = {operationKey, workEffortId: state.run1, quantity: 2, firstSerialNumber: "WPD-SN-001"}
        const received = run("wpd_issuer", P + "receive#ProductionOutput", parameters)
        const retry = run("wpd_issuer", P + "receive#ProductionOutput", parameters)
        const over = run("wpd_issuer", P + "receive#ProductionOutput", {
            operationKey: key(),
            workEffortId: state.run1,
            quantity: 1,
            serialNumbers: ["WPD-SN-009"]
        })
        const outsider = run("wpd_outsider", P + "get#ProductionOrder", {workEffortId: state.run1})
        const nobody = run("wpd_buyer", P + "get#ProductionOrder", {workEffortId: state.run1})
        return {received, retry, over, outsider, nobody}
    },
    then({received, retry, over, outsider, nobody}) {
        received.error == ""
        received.result.costSource == "standard"
        received.result.costProvisional == false
        received.result.unitCost == "10.5"
        received.result.statusId == "AstQuarantine"
        received.result.inspected == true
        received.result.qualityInspectionIds.length == 2
        received.result.serialNumbers.join(",") == "WPD-SN-001,WPD-SN-002"
        const assets = received.result.assetIds.map(asset)
        assets.every(row => row.statusId === "AstQuarantine" && row.locationSeqId === "QUAR1" && n(row.acquireCost) === 10.5)
        assets.every(row => row.ownerPartyId === org)
        const receipts = received.result.assetReceiptIds.map(id =>
            one("mantle.product.receipt.AssetReceipt", {assetReceiptId: id})
        )
        receipts.every(
            row =>
                row.workEffortId === state.run1 &&
                row.productionOutputLineId === lineOf(state.run1, "WPD_FIN").productionRunLineId
        )
        const inspection = one("mantle.product.quality.QualityInspection", {
            qualityInspectionId: received.result.qualityInspectionIds[0]
        })
        inspection.sourceTypeEnumId == "QisWorkEffort"
        inspection.workEffortId == state.run1
        retry.result.alreadyApplied == true
        rows("mantle.product.receipt.AssetReceipt", {productionOutputLineId: lineOf(state.run1, "WPD_FIN").productionRunLineId})
            .length == 2
        // no ProductionPolicy row and no loss: the limit is still the target less what was received (impl-manufacturing F-P7-2)
        over.error.includes("OVER_RECEIPT")
        outsider.error.includes("RECORD_UNAVAILABLE")
        nobody.error.includes("PERMISSION_DENIED")
    }
})

feature("subcontract output is received from the vendor facility: components issued there, the service line accepted once", {
    when() {
        const created = run("wpd_planner", P + "create#ProductionOrder", {
            operationKey: key(),
            organizationPartyId: org,
            productId: "WPD_CF",
            quantity: 3,
            facilityId: facility
        })
        const released = run("wpd_planner", P + "release#ProductionOrder", {
            operationKey: key(),
            workEffortId: created.workEffortId
        })
        const runId = created.workEffortId
        const opId = released.result.operationWorkEffortIds[0]
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        call("create#mantle.order.OrderHeader", {orderId: "WPD_PO", statusId: "OrderApproved", currencyUomId: "USD"})
        call("create#mantle.order.OrderPart", {
            orderId: "WPD_PO",
            orderPartSeqId: "01",
            vendorPartyId: supplier,
            customerPartyId: org,
            statusId: "OrderApproved"
        })
        call("create#mantle.order.OrderItem", {
            orderId: "WPD_PO",
            orderItemSeqId: "01",
            orderPartSeqId: "01",
            productId: "WPD_COAT",
            quantity: 3,
            unitAmount: 4,
            itemTypeEnumId: "ItemProduct"
        })
        call("create#mantle.order.OrderItemWorkEffort", {orderId: "WPD_PO", orderItemSeqId: "01", workEffortId: opId})
        call("create#mantle.shipment.Shipment", {
            shipmentId: "WPD_SHIP",
            shipmentTypeEnumId: "ShpTpTransfer",
            statusId: "ShipDelivered",
            fromPartyId: org,
            toPartyId: org,
            subcontractWorkEffortId: opId,
            subcontractOrderId: "WPD_PO",
            subcontractOrderItemSeqId: "01"
        })
        call("create#mantle.shipment.ShipmentRouteSegment", {
            shipmentId: "WPD_SHIP",
            shipmentRouteSegmentSeqId: "01",
            originFacilityId: facility,
            destinationFacilityId: vendor
        })
        const lineId = lineOf(runId, "WPD_RM_A").productionRunLineId
        const unknownLine = run("wpd_issuer", "mantle.work.ProductionServices.receive#SubcontractOutput", {
            operationKey: key(),
            shipmentId: "WPD_SHIP",
            quantity: 1,
            toLocationSeqId: "PICK1",
            materialQuantities: {WPD_NO_LINE: 1}
        })
        const tooMuch = run("wpd_issuer", "mantle.work.ProductionServices.receive#SubcontractOutput", {
            operationKey: key(),
            shipmentId: "WPD_SHIP",
            quantity: 1,
            toLocationSeqId: "PICK1",
            materialQuantities: {[lineId]: 4}
        })
        const operationKey = key()
        const parameters = {operationKey, shipmentId: "WPD_SHIP", quantity: 3, toLocationSeqId: "PICK1"}
        const received = run("wpd_issuer", "mantle.work.ProductionServices.receive#SubcontractOutput", parameters)
        const retry = run("wpd_issuer", "mantle.work.ProductionServices.receive#SubcontractOutput", parameters)
        const more = run(
            "wpd_issuer",
            "mantle.work.ProductionServices.receive#SubcontractOutput",
            Object.assign({}, parameters, {operationKey: key(), quantity: 1})
        )
        const extra = run("wpd_buyer", "mantle.order.OrderServices.accept#ServiceItem", {
            operationKey: key(),
            orderId: "WPD_PO",
            orderItemSeqId: "01",
            acceptedQuantity: 1
        })
        const issuerAccept = run("wpd_issuer", "mantle.order.OrderServices.accept#ServiceItem", {
            operationKey: key(),
            orderId: "WPD_PO",
            orderItemSeqId: "01",
            acceptedQuantity: 1
        })
        return {runId, opId, received, retry, more, extra, issuerAccept, unknownLine, tooMuch}
    },
    then({runId, opId, received, retry, more, extra, issuerAccept, unknownLine, tooMuch}) {
        unknownLine.error.includes("LINE_INVALID")
        tooMuch.error.includes("QUANTITY_EXCEEDS_REMAINING")
        received.error == ""
        received.result.vendorFacilityId == vendor
        received.result.operationWorkEffortId == opId
        // the components issued at the vendor facility, oldest first: 2 at 2 and 1 at 3
        received.result.issues.length == 2
        n(asset(state.vendorCheap).quantityOnHandTotal) == 0
        n(asset(state.vendorDear).quantityOnHandTotal) == 4
        rows("mantle.product.issuance.AssetIssuance", {workEffortId: runId}).every(row => row.operationWorkEffortId === opId)
        // the output at the issued cost to date (no standard): 7 over 3, the last unit carrying the remainder; provisional
        const output = received.result.output
        output.costSource == "issued"
        output.costProvisional == true
        output.facilityId == facility
        const outputReceipts = output.assetReceiptIds.map(id => one("mantle.product.receipt.AssetReceipt", {assetReceiptId: id}))
        outputReceipts.every(row => row.costProvisional === "Y" && row.workEffortId === runId && !row.shipmentId)
        const value = output.assetIds.map(asset).reduce((sum, row) => sum + n(row.quantityOnHandTotal) * n(row.acquireCost), 0)
        Math.abs(value - 7) < 0.00001
        // the service line accepted once, with the output receipt as its evidence
        const acceptances = rows("mantle.order.purchase.ServiceAcceptance", {orderId: "WPD_PO", orderItemSeqId: "01"})
        acceptances.length == 1
        n(acceptances[0].acceptedQuantity) == 3
        acceptances[0].assetReceiptId == output.assetReceiptIds[0]
        acceptances[0].workEffortId == opId
        // a cost event for each material issue and output receipt, each referencing its hook's transaction (impl-manufacturing P6)
        const costEvents = rows("mantle.work.production.ProductionCostEvent", {workEffortId: runId})
        costEvents.filter(row => row.costEventTypeEnumId === "PcetMaterialIssue").length == 2
        costEvents.filter(row => row.costEventTypeEnumId === "PcetOutputReceipt").length == output.assetReceiptIds.length
        costEvents.every(row => row.acctgTransId != null && row.ledgerStatusEnumId === "PclPosted")
        retry.result.alreadyApplied == true
        more.error.includes("OVER_RECEIPT")
        extra.error.includes("QUANTITY_EXCEEDS_ORDERED")
        issuerAccept.error.includes("PERMISSION_DENIED")
        rows("mantle.order.purchase.ServiceAcceptance", {orderId: "WPD_PO"}).length == 1
    }
})

feature("with no standard, output in parts takes its share of the net WIP and the last the rest; a return after it is trued up", {
    when() {
        const created = run("wpd_planner", P + "create#ProductionOrder", {
            operationKey: key(),
            organizationPartyId: org,
            productId: "WPD_PV",
            quantity: 10,
            facilityId: facility
        })
        const runId = created.workEffortId
        const released = run("wpd_planner", P + "release#ProductionOrder", {operationKey: key(), workEffortId: runId})
        const lineE = lineOf(runId, "WPD_RM_E")
        const issue = (assetId, quantity) =>
            run("wpd_issuer", P + "issue#ProductionMaterial", {
                operationKey: key(),
                workEffortId: runId,
                productionRunLineId: lineE.productionRunLineId,
                assetId,
                quantity
            })
        const cheap = issue(state.stockE1, 3)
        const dear = issue(state.stockE2, 7)
        const receive = quantity =>
            run("wpd_issuer", P + "receive#ProductionOutput", {
                operationKey: key(),
                workEffortId: runId,
                quantity,
                toLocationSeqId: "PICK1"
            })
        const byproduct = run("wpd_issuer", P + "receive#ProductionOutput", {
            operationKey: key(),
            workEffortId: runId,
            productionRunLineId: lineOf(runId, "WPD_BY").productionRunLineId,
            quantity: 1,
            toLocationSeqId: "PICK1"
        })
        const first = receive(4)
        const returned = run("wpd_issuer", P + "return#UnusedMaterial", {
            operationKey: key(),
            assetIssuanceId: dear.result.assetIssuanceId,
            quantity: 1
        })
        const last = receive(6)
        const late = run("wpd_issuer", P + "return#UnusedMaterial", {
            operationKey: key(),
            assetIssuanceId: dear.result.assetIssuanceId,
            quantity: 1
        })
        return {runId, released, cheap, dear, byproduct, first, returned, last, late}
    },
    then({runId, released, cheap, dear, byproduct, first, returned, last, late}) {
        released.error == ""
        // the phantom's routing makes an operation though no line names it (B3)
        released.result.operationWorkEffortIds.length == 2
        cheap.error == ""
        dear.error == ""
        byproduct.error.includes("BYPRODUCT_NOT_COSTED")
        // issued 3 at 1 and 7 at 2 = 17: four take 4/10 of it, 6.8
        first.error == ""
        first.result.costProvisional == true
        const value = result =>
            result.assetIds.map(asset).reduce((sum, row) => sum + n(row.quantityOnHandTotal) * n(row.acquireCost), 0)
        Math.abs(value(first.result) - 6.8) < 0.000001
        returned.error == ""
        returned.result.warnings[0].code == "PROVISIONAL_TRUE_UP"
        // the last six take the rest: 17 - 2 returned - 6.8 = 8.2, the unit rounded down and the remainder on the last
        last.error == ""
        Math.abs(value(last.result) - 8.2) < 0.000001
        last.result.assetIds.map(asset).every(row => n(row.acquireCost) >= 1.3666)
        late.error.includes("PROVISIONAL_CLOSED")
        // the run's WIP nets to zero
        const valueOf = (quantity, assetId) => n(quantity) * n(asset(assetId).acquireCost)
        const issued = rows("mantle.product.issuance.AssetIssuance", {workEffortId: runId}).reduce(
            (sum, row) => sum + valueOf(row.quantity, row.assetId),
            0
        )
        const back = rows("mantle.product.receipt.AssetReceipt", {workEffortId: runId}).reduce(
            (sum, row) => sum + valueOf(row.quantityAccepted, row.assetId),
            0
        )
        Math.abs(issued - back) < 0.000001
    }
})

feature("cost lines round the unit cost down so the last unit's remainder is never negative, serials and parts alike", {
    expect() {
        const production = ec.resource.script("component://mr-mantle/service/mantle/work/Production.js")
        const bulk = production.costLines(toDecimal("12.36"), toDecimal(1000), [])
        bulk.length == 2
        String(bulk[0].cost) == "0.0123"
        bulk[1].cost.compare(0) > 0
        bulk[0].quantity.multiply(bulk[0].cost).add(bulk[1].cost).compare(toDecimal("12.36")) == 0
        const serials = production.costLines(toDecimal("10"), toDecimal(3), ["S1", "S2", "S3"])
        serials.map(row => String(row.cost)).join(",") == "3.3333,3.3333,3.3334"
        const part = production.costLines(toDecimal("5"), toDecimal("0.5"), [])
        part.length == 1
        String(part[0].cost) == "10.0000"
        production.costLines(toDecimal("6"), toDecimal(3), []).length == 1
    }
})
