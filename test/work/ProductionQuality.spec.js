// Production quality gates (impl-manufacturing P8, design-manufacturing QualityGates, Inspections, QualityInspection and
// InspectionTemplates): a release keeps an in-process gate on the operation whose template names one and a final gate on
// the output, each with its template as of the release; output of a run whose final template applies is received held with
// its inspection, and complete is refused while it is pending; an inspector records and submits, cannot verify, and a
// verifier verifies; a disposition releases five, reserved first to the run's pegged order item, and scraps one through the
// run's loss path, and held quantity never counts as good; an in-process failure blocks the dependent operation, the run's
// resume and its completion, naming the inspection, notifies the supervisors, and a rework disposition clears it; a
// template revision leaves the released run's gate as it was; an operation naming an unpublished template blocks the
// release. The users are in spec-local groups.
const P = "mantle.work.ProductionServices.",
    Q = "mantle.product.QualityServices.",
    B = "mantle.product.BomServices.",
    R = "mantle.work.RoutingServices."
const GATE = "mantle.work.production.ProductionQualityGate",
    INSPECTION = "mantle.product.quality.QualityInspection",
    ITEM = "mantle.product.quality.InspectionTemplateItem",
    LOSS = "mantle.work.production.ProductionLoss",
    LINE = "mantle.work.production.ProductionRunLine",
    ASSET = "mantle.product.asset.Asset",
    WORK = "mantle.work.effort.WorkEffort"
const org = "PQG_ORG",
    other = "PQG_OTHER",
    customer = "PQG_CUST",
    plant = "PQG_PLANT"
const find = (entity, conditions = {}) => ec.entity.find(entity).condition(conditions).disableAuthz()
const one = (entity, conditions) => find(entity, conditions).one()
const rows = (entity, conditions) => Array.from(find(entity, conditions).list())
const n = value => (value == null ? null : Number(String(value)))
const since = "2000-01-01T00:00:00Z"
const state = {}
let keySeq = 0
const key = () => "pqg-op-" + ++keySeq
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
const revision = workEffortId => Number(one(WORK, {workEffortId}).productionRevision || 0)
const act = (username, workEffortId, action, extra = {}) =>
    run(
        username,
        P + "transition#ProductionOrder",
        Object.assign({operationKey: key(), workEffortId, action, expectedRevision: revision(workEffortId)}, extra)
    )
function salesOrder(productId, quantity) {
    const created = call("mantle.order.OrderServices.create#Order", {
        vendorPartyId: org,
        customerPartyId: customer,
        currencyUomId: "USD",
        facilityId: plant
    })
    call("mantle.order.OrderServices.add#OrderProductQuantity", {
        orderId: created.orderId,
        orderPartSeqId: created.orderPartSeqId,
        productId,
        quantity,
        unitAmount: 9
    })
    call("mantle.order.OrderServices.place#Order", {orderId: created.orderId})
    return created.orderId
}
// a released and started run of a product, its material issued, with the gates the release kept
function runningRun(productId, quantity, extra = {}) {
    const created = run(
        "pqg_planner",
        P + "create#ProductionOrder",
        Object.assign({operationKey: key(), organizationPartyId: org, productId, quantity, facilityId: plant}, extra)
    )
    if (created.error) throw new Error("Create failed: " + created.error)
    const workEffortId = created.workEffortId
    const released = act("pqg_planner", workEffortId, "release")
    if (released.error) throw new Error("Release failed: " + released.error)
    const started = act("pqg_super", workEffortId, "start")
    if (started.error) throw new Error("Start failed: " + started.error)
    const lines = rows(LINE, {workEffortId})
    const material = lines.find(row => row.lineRoleEnumId === "PrlrMaterial")
    const issued = run("pqg_operator", P + "issue#ProductionMaterial", {
        operationKey: key(),
        workEffortId,
        productionRunLineId: material.productionRunLineId,
        assetId: state.rm,
        quantity
    })
    if (issued.error) throw new Error("Issue failed: " + issued.error)
    const operations = rows(WORK, {parentWorkEffortId: workEffortId}).sort(
        (a, b) => Number(a.operationSequenceNum || 0) - Number(b.operationSequenceNum || 0)
    )
    const gates = rows(GATE, {workEffortId})
    return {
        workEffortId,
        output: lines.find(row => row.lineRoleEnumId === "PrlrOutput").productionRunLineId,
        cut: operations[0]?.workEffortId,
        assemble: operations[1]?.workEffortId,
        gates,
        cutGate: gates.find(row => row.productionStageEnumId === "QpsInProcess"),
        finalGate: gates.find(row => row.productionStageEnumId === "QpsFinal")
    }
}
// the operation done (impl-manufacturing P10 completes operations; until then it is set here)
const finishOperation = workEffortId => as("john.doe", () => call("update#" + WORK, {workEffortId, statusId: "WeComplete"}))
const itemOf = (inspectionTemplateId, name) =>
    rows(ITEM, {inspectionTemplateId}).find(row => row.characteristicName === name && !row.thruDate)
// the in-process gate inspected and passed: created, read, submitted by the inspector, verified by the verifier
function passCut(r) {
    const created = run("pqg_inspector", P + "create#ProductionInspection", {
        workEffortId: r.workEffortId,
        productionQualityGateId: r.cutGate.productionQualityGateId,
        quantity: 1
    })
    if (created.error) throw new Error("Inspection failed: " + created.error)
    run("pqg_inspector", Q + "save#InspectionReading", {
        qualityInspectionId: created.qualityInspectionId,
        inspectionTemplateItemId: itemOf(state.cutTemplate, "Edge").inspectionTemplateItemId,
        sampleNumber: 1,
        passIndicator: "Y"
    })
    run("pqg_inspector", Q + "submit#Inspection", {qualityInspectionId: created.qualityInspectionId, quantityAccepted: 1})
    const verified = run("pqg_verifier", Q + "verify#Inspection", {qualityInspectionId: created.qualityInspectionId})
    if (verified.error) throw new Error("Verify failed: " + verified.error)
    return created.qualityInspectionId
}
const receive = (workEffortId, quantity) =>
    run("pqg_operator", P + "receive#ProductionOutput", {
        operationKey: key(),
        workEffortId,
        quantity,
        toLocationSeqId: "QUAR1"
    })
const status = (username, parameters) => run(username, Q + "get#SourceInspectionStatus", parameters)
const primaryOutput = read => read.outputRows.find(row => row.primary)
// a final inspection read and submitted by the inspector: both samples of the width, then the result
function submitFinal(qualityInspectionId, templateId, accepted, rejected) {
    for (const sampleNumber of [1, 2])
        run("pqg_inspector", Q + "save#InspectionReading", {
            qualityInspectionId,
            inspectionTemplateItemId: itemOf(templateId, "Width").inspectionTemplateItemId,
            sampleNumber,
            numericValue: sampleNumber === 1 ? 10 : 12
        })
    return run("pqg_inspector", Q + "submit#Inspection", {
        qualityInspectionId,
        quantityAccepted: accepted,
        quantityRejected: rejected,
        resultReason: rejected ? "One unit too wide" : null
    })
}

spec({
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        for (const partyId of [org, other]) {
            call("create#mantle.party.Party", {partyId, partyTypeEnumId: "PtyOrganization"})
            call("create#mantle.party.Organization", {partyId, organizationName: partyId})
            call("create#mantle.party.PartyRole", {partyId, roleTypeId: "OrgInternal"})
        }
        call("create#mantle.party.Party", {partyId: customer, partyTypeEnumId: "PtyOrganization"})
        call("create#mantle.party.Organization", {partyId: customer, organizationName: customer})
        call("create#mantle.party.PartyRole", {partyId: customer, roleTypeId: "Customer"})
        call("mantle.ledger.LedgerServices.init#PartyAccountingConfiguration", {
            organizationPartyId: org,
            sourcePartyId: "DefaultSettings",
            baseCurrencyUomId: "USD"
        })
        call("mantle.ledger.LedgerServices.get#OrganizationFiscalTimePeriods", {
            organizationPartyId: org,
            filterDate: ec.user.nowTimestamp
        })
        user("PQG_METHOD", ["METHOD_VIEW", "METHOD_EDIT", "METHOD_APPROVE", "METHOD_RESOURCES"])
        user("PQG_PLANNER", ["PRODUCTION_PLAN", "PRODUCTION_VIEW", "METHOD_VIEW"])
        user("PQG_SUPER", ["PRODUCTION_SUPERVISE", "PRODUCTION_VIEW", "PRODUCTION_OPERATE"])
        user("PQG_OPERATOR", ["PRODUCTION_OPERATE", "PRODUCTION_VIEW", "STOCK_ISSUE"])
        user("PQG_INSPECTOR", ["QUALITY_INSPECT", "PRODUCTION_VIEW"])
        user("PQG_VERIFIER", ["QUALITY_VERIFY", "QUALITY_DISPOSE", "PRODUCTION_VIEW"])
        user("PQG_QADMIN", ["QUALITY_TEMPLATE_EDIT", "PRODUCTION_VIEW"])
        user("PQG_OUTSIDER", ["QUALITY_INSPECT", "PRODUCTION_VIEW"], other)
        call("create#mantle.facility.Facility", {
            facilityId: plant,
            facilityTypeEnumId: "FcTpWarehouse",
            facilityName: plant,
            ownerPartyId: org
        })
        for (const [locationSeqId, locationTypeEnumId] of [
            ["PICK1", "FltPick"],
            ["QUAR1", "FltQuarantine"]
        ])
            call("create#mantle.facility.FacilityLocation", {facilityId: plant, locationSeqId, locationTypeEnumId})
        for (const productId of ["PQG_FIN", "PQG_REV", "PQG_BAD", "PQG_RM"])
            call("create#mantle.product.Product", {
                productId,
                productName: productId,
                productTypeEnumId: "PtAsset",
                assetTypeEnumId: "AstTpInventory",
                amountUomId: "OTH_ea",
                ownerPartyId: org
            })
        for (const productId of ["PQG_FIN", "PQG_REV", "PQG_BAD"])
            call("create#mantle.product.cost.ProductStandardCost", {
                productStandardCostId: productId + "_STD",
                productId,
                organizationPartyId: org,
                state: "approved",
                fromDate: since,
                quantity: 1,
                quantityUomId: "OTH_ea",
                priceUomId: "USD",
                unitCost: 5,
                totalCost: 5,
                materialCost: 5,
                complete: "Y"
            })
        ec.artifactExecution.enableAuthz()
        // the templates: Edge (pass or fail) in-process; Width (9 to 11) final for PQG_FIN and PQG_REV, two units each
        const template = (templateName, productionStageEnumId, productId, itemList) =>
            run("pqg_qadmin", Q + "store#InspectionTemplate", {
                templateName,
                organizationPartyId: org,
                inspectionContextEnumId: "QicProduction",
                productId: productId || null,
                samplePolicyEnumId: productionStageEnumId === "QpsFinal" ? "QspFixed" : "QspAll",
                sampleSize: productionStageEnumId === "QpsFinal" ? 2 : null,
                productionApplicability: "Y",
                productionStageEnumId,
                sampleBasisEnumId: "QsbReceipt",
                itemList,
                action: "publish"
            })
        const width = [{characteristicName: "Width", readingTypeEnumId: "QrtNumeric", lowerLimit: 9, upperLimit: 11}]
        const cut = template("Edge check", "QpsInProcess", null, [{characteristicName: "Edge", readingTypeEnumId: "QrtPassFail"}])
        const fin = template("Final width", "QpsFinal", "PQG_FIN", width)
        const rev = template("Revised width", "QpsFinal", "PQG_REV", width)
        for (const out of [cut, fin, rev]) if (out.error) throw new Error("Template failed: " + out.error)
        state.cutTemplate = cut.inspectionTemplateId
        state.finTemplate = fin.inspectionTemplateId
        state.revTemplate = rev.inspectionTemplateId
        // a draft template an operation names: a release of its method is refused
        const draftTemplate = run("pqg_qadmin", Q + "store#InspectionTemplate", {
            templateName: "Not yet",
            organizationPartyId: org,
            inspectionContextEnumId: "QicProduction",
            itemList: [{characteristicName: "Look", readingTypeEnumId: "QrtPassFail"}]
        })
        // the methods: Cut (the Edge template, from its operation template) then Assemble after it; PQG_BAD's Cut names the
        // draft template
        as("pqg_method", () => {
            call(R + "store#WorkCenter", {organizationPartyId: org, facilityId: plant, changeReason: "Spec work center"})
            const routing = (name, templateId) => {
                const opTemplate = call(R + "store#OperationTemplate", {
                    organizationPartyId: org,
                    workEffortName: "Cut " + name,
                    estimatedWorkTime: 6,
                    timeUomId: "TF_min",
                    methodBatchQuantity: 1,
                    methodQuantityUomId: "OTH_ea",
                    methodWorkCenterId: plant,
                    methodInspectionTemplateId: templateId,
                    changeReason: "Spec template"
                }).template.workEffortId
                const routeId = call(R + "store#Routing", {
                    organizationPartyId: org,
                    workEffortName: "Quality routing " + name,
                    changeReason: "Spec"
                }).routing.workEffortId
                const copied = call(R + "copy#RoutingOperations", {
                    workEffortId: routeId,
                    sourceWorkEffortIds: [opTemplate],
                    changeReason: "Spec copy"
                })
                const cutId = copied.copiedOperationIds[0]
                const assembleId = call(R + "store#RoutingOperation", {
                    workEffortId: routeId,
                    workEffortName: "Assemble",
                    sequenceNum: 20,
                    estimatedWorkTime: 6,
                    timeUomId: "TF_min",
                    methodBatchQuantity: 1,
                    methodQuantityUomId: "OTH_ea",
                    methodWorkCenterId: plant,
                    methodPredecessorIds: cutId,
                    changeReason: "Spec operation"
                }).operationWorkEffortId
                const detail = call(R + "get#RoutingDetail", {workEffortId: routeId})
                call(R + "release#RoutingDraft", {
                    workEffortId: routeId,
                    expectedRevision: detail.expectedRevision,
                    changeReason: "Spec"
                })
                return {routeId, cutId, assembleId}
            }
            const method = (productId, route) => {
                const productBomId = call(B + "store#Bom", {
                    productId,
                    organizationPartyId: org,
                    routingWorkEffortId: route.routeId,
                    changeReason: "Spec method"
                }).productBom.productBomId
                call(B + "store#BomItem", {
                    productBomId,
                    productId: "PQG_RM",
                    quantity: 1,
                    operationWorkEffortId: route.cutId,
                    changeReason: "Spec line"
                })
                const detail = call(B + "get#BomDetail", {productBomId})
                call(B + "release#BomDraft", {
                    productBomId,
                    expectedRevision: detail.expectedRevision,
                    changeReason: "Spec release"
                })
            }
            const good = routing("good", state.cutTemplate)
            method("PQG_FIN", good)
            method("PQG_REV", good)
            method("PQG_BAD", routing("bad", draftTemplate.inspectionTemplateId))
        })
        tick()
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        const rm = call("mantle.product.AssetServices.receive#Asset", {
            productId: "PQG_RM",
            quantity: 500,
            facilityId: plant,
            locationSeqId: "PICK1",
            ownerPartyId: org,
            assetTypeEnumId: "AstTpInventory",
            statusId: "AstAvailable",
            acquireCost: 2
        })
        call("update#" + ASSET, {assetId: rm.assetId, acquireCostUomId: "USD"})
        state.rm = rm.assetId
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

feature("output of a run whose final template applies is received held, and complete is refused while it is pending", {
    when() {
        // the run made for a sales order item (create#ProductionOrder's sourceOrderId): the peg its inspections carry
        const peggedOrder = salesOrder("PQG_FIN", 5)
        const r = runningRun("PQG_FIN", 6, {sourceOrderId: peggedOrder, orderItemSeqId: "01"})
        const cutInspection = passCut(r)
        finishOperation(r.cut)
        const received = receive(r.workEffortId, 6)
        const inspection = received.result
            ? one(INSPECTION, {qualityInspectionId: received.result.qualityInspectionIds[0]})
            : null
        const read = run("pqg_super", P + "get#ProductionQuantities", {workEffortId: r.workEffortId})
        const completed = act("pqg_super", r.workEffortId, "complete")
        const runStatus = status("pqg_super", {workEffortId: r.workEffortId})
        const lineStatus = status("pqg_inspector", {productionRunLineId: r.output})
        const outsider = status("pqg_outsider", {workEffortId: r.workEffortId})
        state.held = {r, inspection, peggedOrder}
        return {r, cutInspection, received, inspection, read, completed, runStatus, lineStatus, outsider}
    },
    then({r, received, inspection, read, completed, runStatus, lineStatus, outsider}) {
        r.gates.length == 2
        r.cutGate.operationWorkEffortId == r.cut
        r.cutGate.inspectionTemplateId == state.cutTemplate
        r.finalGate.productionRunLineId == r.output
        r.finalGate.inspectionTemplateId == state.finTemplate
        n(r.finalGate.sampleSize) == 2
        one(WORK, {workEffortId: r.workEffortId}).productionGatesDate != null
        received.error == ""
        received.result.inspected == true
        received.result.statusId == "AstQuarantine"
        inspection.productionQualityGateId == r.finalGate.productionQualityGateId
        inspection.productionRunLineId == r.output
        inspection.inspectionTemplateId == state.finTemplate
        inspection.inspectionContextEnumId == "QicProduction"
        n(inspection.sampleSize) == 2
        n(inspection.heldQuantity) == 6
        inspection.demandOrderId == state.held.peggedOrder
        inspection.demandOrderItemSeqId == "01"
        String(inspection.templateAsOfDate) == String(r.finalGate.templateAsOfDate)
        // held quantity never counts as good
        n(primaryOutput(read).good) == 0
        n(primaryOutput(read).held) == 6
        completed.error.includes("INSPECTION_PENDING")
        completed.error.includes(inspection.qualityInspectionId)
        runStatus.error == ""
        runStatus.gateStatus == "pending"
        runStatus.blockingInspectionId == inspection.qualityInspectionId
        runStatus.gateRows.length == 2
        runStatus.gateRows.find(row => row.productionStageEnumId == "QpsInProcess").state == "passed"
        lineStatus.gateRows.length == 1
        n(lineStatus.heldQuantity) == 6
        outsider.error.includes("RECORD_UNAVAILABLE")
    }
})

feature("an inspector records and submits, cannot verify, and a verifier verifies", {
    when() {
        const {inspection} = state.held
        const submitted = submitFinal(inspection.qualityInspectionId, state.finTemplate, 5, 1)
        const byInspector = run("pqg_inspector", Q + "verify#Inspection", {qualityInspectionId: inspection.qualityInspectionId})
        const read = run("pqg_verifier", Q + "get#Inspection", {qualityInspectionId: inspection.qualityInspectionId})
        const byVerifier = run("pqg_verifier", Q + "verify#Inspection", {qualityInspectionId: inspection.qualityInspectionId})
        const after = one(INSPECTION, {qualityInspectionId: inspection.qualityInspectionId})
        const notices = rows("moqui.security.user.NotificationMessage", {topic: "ProductionQualityBlock"}).filter(row =>
            String(row.messageJson || "").includes(inspection.qualityInspectionId)
        )
        // the submit's decision notice to the verifiers carries the production context, for an app's link (F-P8-2)
        const decisions = rows("moqui.security.user.NotificationMessage", {topic: "QualityInspectionDecision"}).filter(row =>
            String(row.messageJson || "").includes(inspection.qualityInspectionId)
        )
        return {submitted, byInspector, read, byVerifier, after, notices, decisions}
    },
    then({submitted, byInspector, read, byVerifier, after, notices, decisions}) {
        submitted.error == ""
        byInspector.error.includes("PERMISSION_DENIED")
        read.error == ""
        read.items.length == 1
        read.items[0].characteristicName == "Width"
        byVerifier.error == ""
        after.statusId == "QiVerified"
        after.verifiedByUserId == "PQG_VERIFIER"
        n(after.quantityRejected) == 1
        // a rejection blocks the gate: the supervisors are told
        notices.length == 1
        decisions.length > 0
        decisions.every(row => String(row.messageJson).includes("QicProduction"))
        // with BOSS's link template a production inspection opens in Manufacturing
        decisions.every(row => !row.linkText || String(row.linkText).includes("/Manufacturing/Quality/QualityInspection"))
    }
})

feature("a disposition releases five, reserved first to the pegged order item, and scraps one through the loss path", {
    when() {
        // the peg: the run's own demand provenance, which the receipt's inspection took (the first feature)
        const {r, inspection, peggedOrder} = state.held
        const id = inspection.qualityInspectionId
        const beforeComplete = act("pqg_super", r.workEffortId, "complete")
        const released = run("pqg_verifier", Q + "dispose#Inspection", {
            operationKey: key(),
            qualityInspectionId: id,
            dispositionEnumId: "QdRelease",
            quantity: 5
        })
        const middle = run("pqg_super", P + "get#ProductionQuantities", {workEffortId: r.workEffortId})
        const scrapped = run("pqg_verifier", Q + "dispose#Inspection", {
            operationKey: key(),
            qualityInspectionId: id,
            dispositionEnumId: "QdScrap",
            quantity: 1,
            reason: "Too wide"
        })
        const read = run("pqg_super", P + "get#ProductionQuantities", {workEffortId: r.workEffortId})
        const losses = rows(LOSS, {workEffortId: r.workEffortId})
        const runStatus = status("pqg_super", {workEffortId: r.workEffortId})
        const completed = act("pqg_super", r.workEffortId, "complete")
        return {
            r,
            id,
            peggedOrder,
            beforeComplete,
            released,
            middle,
            scrapped,
            read,
            losses,
            runStatus,
            completed,
            reservations: rows("mantle.product.issuance.AssetReservation", {orderId: peggedOrder}),
            after: one(INSPECTION, {qualityInspectionId: id}),
            asset: one(ASSET, {assetId: inspection.assetId})
        }
    },
    then({r, beforeComplete, released, middle, scrapped, read, losses, runStatus, completed, reservations, after, asset}) {
        beforeComplete.error.includes("INSPECTION_FAILED")
        released.error == ""
        released.result.statusId == "AstAvailable"
        released.result.reservedOrderId != null
        reservations.some(row => row.assetId == released.result.resultAssetId && n(row.quantity) == 5)
        n(primaryOutput(middle).good) == 5
        n(primaryOutput(middle).held) == 1
        scrapped.error == ""
        scrapped.result.productionLossId != null
        scrapped.result.physicalInventoryId == null
        losses.length == 1
        losses[0].lossTypeEnumId == "PltOutputScrap"
        losses[0].statusId == "PlsApproved"
        losses[0].assetIssuanceId != null
        losses[0].assetId == asset.assetId
        n(asset.quantityOnHandTotal) == 0
        n(primaryOutput(read).good) == 5
        n(primaryOutput(read).scrap) == 1
        n(primaryOutput(read).held) == 0
        after.statusId == "QiDisposed"
        n(after.heldQuantity) == 0
        runStatus.gateStatus == "passed"
        completed.error == ""
        one(WORK, {workEffortId: r.workEffortId}).statusId == "WeComplete"
    }
})

feature("an in-process failure blocks the dependent operation's start, the resume and the completion, naming the inspection", {
    when() {
        const r = runningRun("PQG_FIN", 4)
        const wrongGate = run("pqg_inspector", P + "create#ProductionInspection", {
            workEffortId: r.workEffortId,
            productionQualityGateId: r.finalGate.productionQualityGateId
        })
        const outsider = run("pqg_outsider", P + "create#ProductionInspection", {
            workEffortId: r.workEffortId,
            productionQualityGateId: r.cutGate.productionQualityGateId
        })
        const created = run("pqg_inspector", P + "create#ProductionInspection", {
            workEffortId: r.workEffortId,
            productionQualityGateId: r.cutGate.productionQualityGateId
        })
        const second = run("pqg_inspector", P + "create#ProductionInspection", {
            workEffortId: r.workEffortId,
            productionQualityGateId: r.cutGate.productionQualityGateId
        })
        const id = created.qualityInspectionId
        run("pqg_inspector", Q + "save#InspectionReading", {
            qualityInspectionId: id,
            inspectionTemplateItemId: itemOf(state.cutTemplate, "Edge").inspectionTemplateItemId,
            sampleNumber: 1,
            passIndicator: "N"
        })
        run("pqg_inspector", Q + "submit#Inspection", {
            qualityInspectionId: id,
            quantityAccepted: 0,
            quantityRejected: 4,
            resultReason: "Burred edges"
        })
        run("pqg_verifier", Q + "verify#Inspection", {qualityInspectionId: id})
        finishOperation(r.cut)
        const operations = run("pqg_super", P + "get#ProductionOperations", {workEffortId: r.workEffortId})
        const assembleStatus = status("pqg_super", {operationWorkEffortId: r.assemble})
        const completed = act("pqg_super", r.workEffortId, "complete", {finishRemainder: true, reason: "Spec"})
        const held = act("pqg_super", r.workEffortId, "hold", {reason: "Quality"})
        const resumed = act("pqg_super", r.workEffortId, "resume")
        // approved rework of the rejected units clears the gate; the failed result stays in history
        const reworked = run("pqg_verifier", Q + "dispose#Inspection", {
            operationKey: key(),
            qualityInspectionId: id,
            dispositionEnumId: "QdRework",
            quantity: 4,
            reason: "Deburr"
        })
        const resumedAfter = act("pqg_super", r.workEffortId, "resume")
        const after = run("pqg_super", P + "get#ProductionOperations", {workEffortId: r.workEffortId})
        return {
            r,
            id,
            wrongGate,
            outsider,
            created,
            second,
            operations,
            assembleStatus,
            held,
            resumed,
            completed,
            reworked,
            after,
            resumedAfter
        }
    },
    then({
        r,
        id,
        wrongGate,
        outsider,
        created,
        second,
        operations,
        assembleStatus,
        held,
        resumed,
        completed,
        reworked,
        after,
        resumedAfter
    }) {
        wrongGate.error.includes("GATE_FINAL")
        outsider.error.includes("RECORD_UNAVAILABLE")
        created.error == ""
        one(INSPECTION, {qualityInspectionId: id}).operationWorkEffortId == r.cut
        n(one(INSPECTION, {qualityInspectionId: id}).heldQuantity) == 0
        second.error.includes("INSPECTION_EXISTS")
        const assemble = operations.operationRows.find(row => row.workEffortId == r.assemble)
        assemble.ready == false
        assemble.readinessText.includes(id)
        assemble.blockingInspectionId == id
        assembleStatus.startAllowed == false
        assembleStatus.startBlockInspectionId == id
        held.error == ""
        resumed.error.includes("QUALITY_BLOCKED")
        resumed.error.includes(id)
        completed.error.includes("QUALITY_GATE_OPEN")
        reworked.error == ""
        after.operationRows.find(row => row.workEffortId == r.assemble).ready == true
        resumedAfter.error == ""
    }
})

feature("a template revision leaves the released run's gate as it was", {
    when() {
        const before = runningRun("PQG_REV", 3)
        passCut(before)
        // the quality administrator widens the width and samples three: a new item row, the sample changed
        const width = itemOf(state.revTemplate, "Width")
        const revised = run("pqg_qadmin", Q + "store#InspectionTemplate", {
            inspectionTemplateId: state.revTemplate,
            templateName: "Revised width",
            inspectionContextEnumId: "QicProduction",
            productId: "PQG_REV",
            samplePolicyEnumId: "QspFixed",
            sampleSize: 3,
            itemList: [{inspectionTemplateItemId: width.inspectionTemplateItemId, lowerLimit: 8, upperLimit: 12}],
            changeReason: "Wider tolerance"
        })
        const afterRun = runningRun("PQG_REV", 3)
        passCut(afterRun)
        const first = receive(before.workEffortId, 3)
        const second = receive(afterRun.workEffortId, 3)
        const inspectionOf = received => one(INSPECTION, {qualityInspectionId: received.result.qualityInspectionIds[0]})
        const firstRead = run("pqg_verifier", Q + "get#Inspection", {
            qualityInspectionId: first.result.qualityInspectionIds[0]
        })
        const secondRead = run("pqg_verifier", Q + "get#Inspection", {
            qualityInspectionId: second.result.qualityInspectionIds[0]
        })
        const template = one("mantle.product.quality.InspectionTemplate", {inspectionTemplateId: state.revTemplate})
        return {
            before,
            afterRun,
            revised,
            template,
            firstInspection: inspectionOf(first),
            secondInspection: inspectionOf(second),
            firstRead,
            secondRead
        }
    },
    then({before, afterRun, revised, template, firstInspection, secondInspection, firstRead, secondRead}) {
        revised.error == ""
        // the production applicability is kept by a header change that does not give it
        template.productionStageEnumId == "QpsFinal"
        n(before.finalGate.sampleSize) == 2
        n(afterRun.finalGate.sampleSize) == 3
        n(firstInspection.sampleSize) == 2
        n(secondInspection.sampleSize) == 3
        n(firstRead.items[0].upperLimit) == 11
        n(secondRead.items[0].upperLimit) == 12
        String(firstInspection.templateAsOfDate) == String(before.finalGate.templateAsOfDate)
    }
})

feature("an operation naming a template that is not published blocks the release, naming it", {
    when() {
        const created = run("pqg_planner", P + "create#ProductionOrder", {
            operationKey: key(),
            organizationPartyId: org,
            productId: "PQG_BAD",
            quantity: 2,
            facilityId: plant
        })
        const released = act("pqg_planner", created.workEffortId, "release")
        return {created, released, gates: rows(GATE, {workEffortId: created.workEffortId})}
    },
    then({created, released, gates}) {
        created.error == ""
        released.error.includes("TEMPLATE_UNAVAILABLE")
        gates.length == 0
        one(WORK, {workEffortId: created.workEffortId}).statusId == "WeInPlanning"
    }
})

feature("a run released before its gates were kept keeps P16's rule; a gated run reads its gates only", {
    when() {
        // released before P8 (no productionGatesDate): a production template that applies now holds the output
        const legacy = runningRun("PQG_FIN", 2)
        as("john.doe", () => call("update#" + WORK, {workEffortId: legacy.workEffortId, productionGatesDate: null}))
        const legacyReceived = receive(legacy.workEffortId, 2)
        // a gated run whose final gate is gone: the template that applies by product adds no gate after the release
        const gated = runningRun("PQG_FIN", 2)
        as("john.doe", () =>
            call("update#" + GATE, {
                productionQualityGateId: gated.finalGate.productionQualityGateId,
                thruDate: ec.user.nowTimestamp
            })
        )
        const gatedReceived = run("pqg_operator", P + "receive#ProductionOutput", {
            operationKey: key(),
            workEffortId: gated.workEffortId,
            quantity: 2,
            toLocationSeqId: "PICK1"
        })
        const legacyInspection = legacyReceived.result?.qualityInspectionIds?.[0]
            ? one(INSPECTION, {qualityInspectionId: legacyReceived.result.qualityInspectionIds[0]})
            : null
        return {legacyReceived, legacyInspection, gatedReceived}
    },
    then({legacyReceived, legacyInspection, gatedReceived}) {
        legacyReceived.error == ""
        legacyReceived.result.inspected == true
        legacyInspection.inspectionTemplateId == state.finTemplate
        legacyInspection.productionQualityGateId == null
        gatedReceived.error == ""
        gatedReceived.result.inspected != true
        gatedReceived.result.qualityInspectionIds.length == 0
    }
})

feature("an unrelease counts the gates' inspections as facts, and ends the gates once there are none", {
    when() {
        const created = run("pqg_planner", P + "create#ProductionOrder", {
            operationKey: key(),
            organizationPartyId: org,
            productId: "PQG_FIN",
            quantity: 2,
            facilityId: plant
        })
        const workEffortId = created.workEffortId
        act("pqg_planner", workEffortId, "release")
        const gate = rows(GATE, {workEffortId}).find(row => row.productionStageEnumId === "QpsInProcess")
        const inspection = run("pqg_inspector", P + "create#ProductionInspection", {
            workEffortId,
            productionQualityGateId: gate.productionQualityGateId
        })
        const refused = act("pqg_planner", workEffortId, "unrelease", {reason: "Spec"})
        run("pqg_inspector", Q + "cancel#Inspection", {qualityInspectionId: inspection.qualityInspectionId, reason: "Spec"})
        const unreleased = act("pqg_planner", workEffortId, "unrelease", {reason: "Spec"})
        return {workEffortId, inspection, refused, unreleased, gates: rows(GATE, {workEffortId})}
    },
    then({workEffortId, inspection, refused, unreleased, gates}) {
        inspection.error == ""
        refused.error.includes("RUN_HAS_FACTS")
        refused.error.includes("1 inspection")
        unreleased.error == ""
        gates.length == 2
        gates.every(row => row.thruDate != null)
        one(WORK, {workEffortId}).productionGatesDate == null
        one(WORK, {workEffortId}).statusId == "WeInPlanning"
    }
})
