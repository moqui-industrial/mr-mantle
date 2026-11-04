// Production quantities, by-products and loss (impl-manufacturing P7, design-manufacturing Quantities, ByProducts, ScrapLoss
// and §12.2): a run for 10 receives 6 good, records 1 process loss and the scrap of an issued component (a cost event and no
// stock movement) and shows 3 remaining; scrapping a received and a held output asset of the open run issues each back to
// the run, not to shrinkage; a target cut below the good quantity is refused and a cut to 9 writes a delta that rewrites the
// lines and the WorkEffortProduct rows; output beyond the overproduction tolerance waits for a supervisor; a loss above its
// reason's threshold waits for a supervisor; complete is refused until the quantities reconcile, then succeeds, a retry
// posting nothing twice, and Finish remainder records an approved loss; the completeOnFinalReceipt flag completes on the
// final receipt, and without it the run stays running; a draft's by-product and the labels. The users are in spec-local
// groups.
const P = "mantle.work.ProductionServices.",
    B = "mantle.product.BomServices.",
    R = "mantle.work.RoutingServices."
const LOSS = "mantle.work.production.ProductionLoss",
    QEVENT = "mantle.work.production.ProductionQuantityEvent",
    COST = "mantle.work.production.ProductionCostEvent",
    LINE = "mantle.work.production.ProductionRunLine",
    ISSUANCE = "mantle.product.issuance.AssetIssuance",
    RECEIPT = "mantle.product.receipt.AssetReceipt",
    ASSET = "mantle.product.asset.Asset"
const org = "PPQ_ORG",
    other = "PPQ_OTHER",
    plant = "PPQ_PLANT",
    flagPlant = "PPQ_FLAG"
const find = (entity, conditions = {}) => ec.entity.find(entity).condition(conditions).disableAuthz()
const one = (entity, conditions) => find(entity, conditions).one()
const rows = (entity, conditions) => Array.from(find(entity, conditions).list())
const n = value => (value == null ? null : Number(String(value)))
const since = "2000-01-01T00:00:00Z"
const state = {}
let keySeq = 0
const key = () => "ppq-op-" + ++keySeq
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
function facility(facilityId) {
    call("create#mantle.facility.Facility", {
        facilityId,
        facilityTypeEnumId: "FcTpWarehouse",
        facilityName: facilityId,
        ownerPartyId: org
    })
    call("create#mantle.facility.FacilityLocation", {facilityId, locationSeqId: "PICK1", locationTypeEnumId: "FltPick"})
    call("create#mantle.facility.FacilityLocation", {facilityId, locationSeqId: "QUAR1", locationTypeEnumId: "FltQuarantine"})
}
function stock(productId, quantity, acquireCost, facilityId = plant) {
    const assetId = call("mantle.product.AssetServices.receive#Asset", {
        productId,
        quantity,
        facilityId,
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
const act = (username, workEffortId, action, extra = {}) =>
    run(
        username,
        P + "transition#ProductionOrder",
        Object.assign({operationKey: key(), workEffortId, action, expectedRevision: revision(workEffortId)}, extra)
    )
// a draft run of PPQ_FIN at the plant, with its lines by product
function draft(quantity, facilityId = plant) {
    const created = run("ppq_planner", P + "create#ProductionOrder", {
        operationKey: key(),
        organizationPartyId: org,
        productId: "PPQ_FIN",
        quantity,
        facilityId
    })
    if (created.error) throw new Error("Create failed: " + created.error)
    return created.workEffortId
}
function linesOf(workEffortId) {
    const lines = rows(LINE, {workEffortId})
    const lineOf = productId => lines.find(row => row.productId === productId)?.productionRunLineId
    return {
        output: lines.find(row => row.lineRoleEnumId === "PrlrOutput").productionRunLineId,
        rm1: lineOf("PPQ_RM1"),
        rm2: lineOf("PPQ_RM2")
    }
}
// a released and started run, its materials issued in full unless told otherwise
function runningRun(quantity, options = {}) {
    const workEffortId = draft(quantity, options.facilityId || plant)
    const released = act("ppq_planner", workEffortId, "release")
    if (released.error) throw new Error("Release failed: " + released.error)
    const started = act("ppq_super", workEffortId, "start")
    if (started.error) throw new Error("Start failed: " + started.error)
    const lines = linesOf(workEffortId)
    const issued = options.issue || {rm1: quantity, rm2: quantity}
    const assets = options.facilityId === flagPlant ? state.flagStock : state.stock
    for (const [line, amount] of Object.entries(issued)) {
        if (!amount) continue
        const out = run("ppq_operator", P + "issue#ProductionMaterial", {
            operationKey: key(),
            workEffortId,
            productionRunLineId: lines[line],
            assetId: assets[line],
            quantity: amount
        })
        if (out.error) throw new Error("Issue failed: " + out.error)
    }
    return Object.assign({workEffortId}, lines)
}
const record = (username, workEffortId, quantities, operationKey = key()) =>
    run(username, P + "record#ProductionQuantity", Object.assign({operationKey, workEffortId}, quantities))
const loss = (username, workEffortId, parameters, operationKey = key()) =>
    run(username, P + "record#ProductionLoss", Object.assign({operationKey, workEffortId}, parameters))
const quantities = (username, workEffortId) => run(username, P + "get#ProductionQuantities", {workEffortId})
const outputRow = read => read.outputRows.find(row => row.primary)

spec({
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
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
        call("mantle.ledger.LedgerServices.get#OrganizationFiscalTimePeriods", {
            organizationPartyId: org,
            filterDate: ec.user.nowTimestamp
        })
        user("PPQ_METHOD", ["METHOD_VIEW", "METHOD_EDIT", "METHOD_APPROVE", "METHOD_RESOURCES"])
        user("PPQ_PLANNER", ["PRODUCTION_PLAN", "PRODUCTION_VIEW", "METHOD_VIEW"])
        user("PPQ_SUPER", ["PRODUCTION_SUPERVISE", "PRODUCTION_VIEW", "PRODUCTION_OPERATE"])
        user("PPQ_OPERATOR", ["PRODUCTION_OPERATE", "PRODUCTION_VIEW", "STOCK_ISSUE"])
        user("PPQ_NOSTOCK", ["PRODUCTION_OPERATE", "PRODUCTION_VIEW"])
        user("PPQ_READER", ["PRODUCTION_VIEW"])
        user("PPQ_FINANCE", ["PRODUCTION_VIEW", "ACCOUNTING_VIEW"])
        user("PPQ_ADMIN", ["PRODUCTION_POLICY_EDIT", "PRODUCTION_VIEW"])
        user("PPQ_OUTSIDER", ["PRODUCTION_VIEW", "PRODUCTION_OPERATE", "PRODUCTION_SUPERVISE"], other)
        facility(plant)
        facility(flagPlant)
        for (const productId of ["PPQ_FIN", "PPQ_RM1", "PPQ_RM2", "PPQ_BY"])
            call("create#mantle.product.Product", {
                productId,
                productName: productId,
                productTypeEnumId: "PtAsset",
                assetTypeEnumId: "AstTpInventory",
                amountUomId: "OTH_ea",
                ownerPartyId: org
            })
        call("create#mantle.product.cost.ProductStandardCost", {
            productStandardCostId: "PPQ_STD",
            productId: "PPQ_FIN",
            organizationPartyId: org,
            state: "approved",
            fromDate: since,
            quantity: 1,
            quantityUomId: "OTH_ea",
            priceUomId: "USD",
            unitCost: 5,
            totalCost: 5,
            materialCost: 3,
            laborCost: 2,
            complete: "Y"
        })
        ec.artifactExecution.enableAuthz()
        // the method: one operation consuming one PPQ_RM1 and one PPQ_RM2 per PPQ_FIN
        as("ppq_method", () => {
            call(R + "store#WorkCenter", {organizationPartyId: org, facilityId: plant, changeReason: "Spec work center"})
            const routeId = call(R + "store#Routing", {
                organizationPartyId: org,
                workEffortName: "Quantity routing",
                changeReason: "Spec"
            }).routing.workEffortId
            const operationId = call(R + "store#RoutingOperation", {
                workEffortId: routeId,
                workEffortName: "Assemble",
                sequenceNum: 10,
                estimatedWorkTime: 6,
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
                productId: "PPQ_FIN",
                organizationPartyId: org,
                routingWorkEffortId: routeId,
                changeReason: "Spec method"
            }).productBom.productBomId
            for (const productId of ["PPQ_RM1", "PPQ_RM2"])
                call(B + "store#BomItem", {
                    productBomId,
                    productId,
                    quantity: 1,
                    operationWorkEffortId: operationId,
                    changeReason: "Spec line"
                })
            const detail = call(B + "get#BomDetail", {productBomId})
            call(B + "release#BomDraft", {productBomId, expectedRevision: detail.expectedRevision, changeReason: "Spec release"})
        })
        // the policy: a 10% overproduction tolerance for the organization; the flag plant completes on its final receipt;
        // the reasons: a scrap and a process loss reason, and a scrap reason above 15% of the quantity for a supervisor
        const policies = [
            run("ppq_admin", P + "store#ProductionPolicy", {
                organizationPartyId: org,
                overProducePercent: 10,
                changeReason: "Spec tolerance"
            }),
            run("ppq_admin", P + "store#ProductionPolicy", {
                organizationPartyId: org,
                facilityId: flagPlant,
                completeOnFinalReceipt: "Y",
                changeReason: "Spec flag"
            }),
            run("ppq_admin", P + "store#ProductionReasons", {
                organizationPartyId: org,
                changeReason: "Spec reasons",
                reasons: [
                    {reasonCode: "PPQ_DROP", reasonName: "Dropped", reasonCategoryEnumId: "PrcScrap"},
                    {reasonCode: "PPQ_SPILL", reasonName: "Spilled", reasonCategoryEnumId: "PrcProcessLoss"},
                    {reasonCode: "PPQ_BIG", reasonName: "Batch ruined", reasonCategoryEnumId: "PrcScrap", approvalThreshold: 15}
                ]
            })
        ]
        for (const out of policies) if (out.error) throw new Error("Policy failed: " + out.error)
        tick()
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        state.stock = {rm1: stock("PPQ_RM1", 500, 2), rm2: stock("PPQ_RM2", 500, 1)}
        state.flagStock = {rm1: stock("PPQ_RM1", 50, 2, flagPlant), rm2: stock("PPQ_RM2", 50, 1, flagPlant)}
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

feature(
    "a run for 10 receives 6 good, records 1 process loss and the scrap of an issued component (a cost event, no stock movement) and shows 3 remaining",
    {
        when() {
            const r = runningRun(10)
            const recorded = record("ppq_operator", r.workEffortId, {good: 6, processLoss: 1, reasonCode: "PPQ_SPILL"})
            const issuancesBefore = rows(ISSUANCE, {workEffortId: r.workEffortId}).length
            const receiptsBefore = rows(RECEIPT, {workEffortId: r.workEffortId}).length
            const assetBefore = n(one(ASSET, {assetId: state.stock.rm1}).quantityOnHandTotal)
            const scrapped = loss("ppq_operator", r.workEffortId, {
                lossTypeEnumId: "PltComponentScrap",
                productionRunLineId: r.rm1,
                quantity: 2,
                reasonCode: "PPQ_DROP"
            })
            const tooMuch = loss("ppq_operator", r.workEffortId, {
                lossTypeEnumId: "PltComponentScrap",
                productionRunLineId: r.rm1,
                quantity: 9,
                reasonCode: "PPQ_DROP"
            })
            const wrongReason = loss("ppq_operator", r.workEffortId, {
                lossTypeEnumId: "PltComponentScrap",
                productionRunLineId: r.rm1,
                quantity: 1,
                reasonCode: "PPQ_SPILL"
            })
            const reader = loss("ppq_reader", r.workEffortId, {lossTypeEnumId: "PltProcessLoss", quantity: 1, reason: "x"})
            return {
                r,
                recorded,
                scrapped,
                tooMuch,
                wrongReason,
                reader,
                issuancesBefore,
                receiptsBefore,
                issuancesAfter: rows(ISSUANCE, {workEffortId: r.workEffortId}).length,
                receiptsAfter: rows(RECEIPT, {workEffortId: r.workEffortId}).length,
                assetBefore,
                assetAfter: n(one(ASSET, {assetId: state.stock.rm1}).quantityOnHandTotal),
                read: quantities("ppq_reader", r.workEffortId),
                finance: quantities("ppq_finance", r.workEffortId),
                costEvent: one(COST, {sourceEntityName: LOSS, sourceId: scrapped.result?.productionLossId}),
                costs: run("ppq_finance", P + "get#ProductionCosts", {workEffortId: r.workEffortId})
            }
        },
        then(x) {
            x.recorded.error == ""
            x.recorded.result.resultCode == "RECORDED"
            x.recorded.result.receipts.length == 1
            x.recorded.result.good == "6"
            x.recorded.result.remaining == "3"
            x.scrapped.error == ""
            x.scrapped.result.statusId == "PlsApproved"
            // no stock moves for issued material scrapped in WIP
            x.issuancesAfter == x.issuancesBefore
            x.receiptsAfter == x.receiptsBefore
            x.assetAfter == x.assetBefore
            x.costEvent.costEventTypeEnumId == "PcetMaterialScrap"
            x.costEvent.ledgerStatusEnumId == "PclAwaitingClose"
            x.costEvent.acctgTransId == null
            n(x.costEvent.amount) == 4
            x.scrapped.result.productionCostEventId == x.costEvent.productionCostEventId
            // the scrap is shown apart and does not change the run's WIP balance (10 + 10 issued at 2 and 1, 6 out at 5)
            x.costs.actuals.scrapped == "4"
            x.costs.actuals.wipBalance == "0"
            x.tooMuch.error.includes("QUANTITY_EXCEEDS_ISSUED")
            x.wrongReason.error.includes("REASON_INVALID")
            x.reader.error.includes("PERMISSION_DENIED")
            const output = outputRow(x.read)
            output.target == "10"
            output.good == "6"
            output.processLoss == "1"
            output.remaining == "3"
            x.read.materialRows.find(row => row.productionRunLineId == x.r.rm1).scrapped == "2"
            x.read.reconciliation.reconciled == false
            x.read.reconciliation.reasonCode == "QUANTITIES_UNRECONCILED"
            x.read.reconciliation.finishRemainderOffered == true
            // a loss's cost only for a financial reader
            !Object.keys(x.read.lossRows.find(row => row.lossTypeEnumId == "PltComponentScrap")).includes("costAmount")
            x.finance.lossRows.find(row => row.lossTypeEnumId == "PltComponentScrap").costAmount == "4"
            x.read.eventRows.some(row => row.quantityEventTypeEnumId == "PqetGood" && row.quantity == "6")
            x.read.eventRows.some(row => row.quantityEventTypeEnumId == "PqetProcessLoss" && row.quantity == "1")
        }
    }
)

feature("scrapping a received and a held output asset of the open run issues each back to the run, not to shrinkage", {
    when() {
        const r = runningRun(5)
        const good = record("ppq_operator", r.workEffortId, {good: 3})
        const held = record("ppq_operator", r.workEffortId, {pending: 1, heldLocationSeqId: "QUAR1"})
        const goodAsset = good.result?.receipts?.[0]?.assetIds?.[0]
        const heldAsset = held.result?.receipts?.[0]?.assetIds?.[0]
        const heldStatus = one(ASSET, {assetId: heldAsset})?.statusId
        const before = quantities("ppq_reader", r.workEffortId)
        const labels = run("ppq_reader", P + "get#ProductionLabels", {workEffortId: r.workEffortId})
        const noStock = loss("ppq_nostock", r.workEffortId, {
            lossTypeEnumId: "PltOutputScrap",
            assetId: goodAsset,
            quantity: 1,
            reasonCode: "PPQ_DROP"
        })
        const scrapGood = loss("ppq_operator", r.workEffortId, {
            lossTypeEnumId: "PltOutputScrap",
            assetId: goodAsset,
            quantity: 1,
            reasonCode: "PPQ_DROP"
        })
        const scrapHeld = loss("ppq_operator", r.workEffortId, {
            lossTypeEnumId: "PltOutputScrap",
            assetId: heldAsset,
            quantity: 1,
            reasonCode: "PPQ_DROP"
        })
        const issuance = one(ISSUANCE, {assetIssuanceId: scrapGood.result?.assetIssuanceId})
        const trans = rows("mantle.ledger.transaction.AcctgTrans", {assetIssuanceId: scrapGood.result?.assetIssuanceId})
        return {
            r,
            good,
            held,
            heldStatus,
            before,
            labels,
            noStock,
            scrapGood,
            scrapHeld,
            issuance,
            trans,
            event: one(COST, {sourceEntityName: ISSUANCE, sourceId: scrapGood.result?.assetIssuanceId}),
            goodAsset: one(ASSET, {assetId: goodAsset}),
            after: quantities("ppq_reader", r.workEffortId)
        }
    },
    then(x) {
        x.good.error == ""
        x.held.error == ""
        x.heldStatus == "AstQuarantine"
        outputRow(x.before).good == "3"
        outputRow(x.before).held == "1"
        // a held output's label says it is not accepted; the WIP label names the operation
        x.labels.labelRows.some(row => row.kind == "finished" && !row.held && row.stateText == "Accepted stock")
        x.labels.labelRows.some(row => row.kind == "finished" && row.held && row.stateText.startsWith("HELD"))
        x.labels.labelRows.some(row => row.kind == "wip" && row.operationWorkEffortId != null)
        x.noStock.error.includes("PERMISSION_DENIED")
        x.scrapGood.error == ""
        x.scrapHeld.error == ""
        // the output asset is issued back to the run (its workEffortId, the loss), and its hook posts it into WIP
        x.issuance.workEffortId == x.r.workEffortId
        x.issuance.productionLossId == x.scrapGood.result.productionLossId
        n(x.issuance.quantity) == 1
        x.trans.length == 1
        x.event.costEventTypeEnumId == "PcetOutputScrap"
        x.event.costComponentEnumId == "PrcOutput"
        x.event.acctgTransId == x.trans[0].acctgTransId
        n(x.event.amount) == 5
        n(x.goodAsset.quantityOnHandTotal) == 2
        one(LOSS, {productionLossId: x.scrapHeld.result.productionLossId}).fromHeld == "Y"
        const output = outputRow(x.after)
        output.good == "2"
        output.held == "0"
        output.scrap == "2"
        output.remaining == "1"
    }
})

feature("a target cut below the good quantity is refused, and a cut to 9 writes a delta that rewrites the lines", {
    when() {
        const r = runningRun(10, {issue: {rm1: 5, rm2: 10}})
        record("ppq_operator", r.workEffortId, {good: 6})
        const change = (username, targetQuantity, extra = {}) =>
            run(
                username,
                P + "change#ProductionQuantity",
                Object.assign(
                    {
                        operationKey: key(),
                        workEffortId: r.workEffortId,
                        expectedRevision: revision(r.workEffortId),
                        targetQuantity,
                        reason: "Customer cut"
                    },
                    extra
                )
            )
        const below = change("ppq_planner", 5)
        const operator = change("ppq_operator", 9)
        const stale = change("ppq_planner", 9, {expectedRevision: 1})
        const noReason = change("ppq_planner", 9, {reason: null})
        const cut = change("ppq_planner", 9)
        const products = rows("mantle.work.effort.WorkEffortProduct", {workEffortId: r.workEffortId}).filter(
            row => row.thruDate == null
        )
        return {
            r,
            below,
            operator,
            stale,
            noReason,
            cut,
            products,
            lines: rows(LINE, {workEffortId: r.workEffortId}),
            read: quantities("ppq_reader", r.workEffortId)
        }
    },
    then(x) {
        x.below.error.includes("TARGET_BELOW_FACTS")
        x.operator.error.includes("PERMISSION_DENIED")
        x.stale.error.includes("REVISION_CHANGED")
        x.noReason.error.includes("REASON_REQUIRED")
        x.cut.error == ""
        x.cut.result.delta == "-1"
        x.cut.result.previousTarget == "10"
        const event = one(QEVENT, {productionQuantityEventId: x.cut.result.productionQuantityEventId})
        event.quantityEventTypeEnumId == "PqetTargetChange"
        n(event.quantity) == -1
        n(event.targetQuantity) == 9
        n(x.lines.find(row => row.productionRunLineId == x.r.output).stockQuantity) == 9
        // a material line scales with the target, never below what it issued
        n(x.lines.find(row => row.productionRunLineId == x.r.rm1).stockQuantity) == 9
        n(x.lines.find(row => row.productionRunLineId == x.r.rm2).stockQuantity) == 10
        n(x.products.find(row => row.productId == "PPQ_FIN").estimatedQuantity) == 9
        n(x.products.find(row => row.productId == "PPQ_RM1").estimatedQuantity) == 9
        outputRow(x.read).remaining == "3"
    }
})

feature("output beyond the overproduction tolerance waits for a supervisor, then is received", {
    when() {
        const r = runningRun(10)
        const full = record("ppq_operator", r.workEffortId, {good: 10})
        const withinTolerance = record("ppq_operator", r.workEffortId, {good: 1})
        const beyond = record("ppq_operator", r.workEffortId, {good: 2})
        const direct = run("ppq_operator", P + "receive#ProductionOutput", {
            operationKey: key(),
            workEffortId: r.workEffortId,
            quantity: 2
        })
        const eventId = beyond.result?.productionQuantityEventId
        const notices = rows("moqui.security.user.NotificationMessage", {topic: "ProductionOverproduction", recordId: eventId})
        const decide = (username, decision = "approve") =>
            run(username, P + "approve#ProductionException", {operationKey: key(), productionQuantityEventId: eventId, decision})
        const operatorApproves = decide("ppq_operator")
        const outsider = decide("ppq_outsider")
        const approved = decide("ppq_super")
        const again = decide("ppq_super")
        const received = record("ppq_operator", r.workEffortId, {good: 2})
        return {
            full,
            withinTolerance,
            beyond,
            direct,
            notices,
            operatorApproves,
            outsider,
            approved,
            again,
            received,
            read: quantities("ppq_reader", r.workEffortId)
        }
    },
    then(x) {
        x.full.error == ""
        x.withinTolerance.error == ""
        x.withinTolerance.result.resultCode == "RECORDED"
        x.beyond.error == ""
        x.beyond.result.resultCode == "APPROVAL_REQUESTED"
        x.beyond.result.excess == "2"
        x.direct.error.includes("OVER_RECEIPT")
        x.notices.length == 1
        x.operatorApproves.error.includes("PERMISSION_DENIED")
        x.outsider.error.includes("RECORD_UNAVAILABLE")
        x.approved.error == ""
        x.approved.result.approvedQuantity == "2"
        x.again.error.includes("NOT_PENDING")
        x.received.error == ""
        x.received.result.resultCode == "RECORDED"
        const output = outputRow(x.read)
        output.good == "13"
        output.over == "3"
        output.approvedOver == "2"
        output.receivable == "0"
    }
})

feature("a loss above its reason's threshold waits for a supervisor, who approves it; another is refused", {
    when() {
        const r = runningRun(10)
        const big = loss("ppq_operator", r.workEffortId, {lossTypeEnumId: "PltOutputScrap", quantity: 2, reasonCode: "PPQ_BIG"})
        const small = loss("ppq_operator", r.workEffortId, {lossTypeEnumId: "PltOutputScrap", quantity: 1, reasonCode: "PPQ_BIG"})
        const pendingRead = quantities("ppq_reader", r.workEffortId)
        const bigAgain = loss("ppq_operator", r.workEffortId, {
            lossTypeEnumId: "PltOutputScrap",
            quantity: 3,
            reasonCode: "PPQ_BIG"
        })
        const approved = run("ppq_super", P + "approve#ProductionException", {
            operationKey: key(),
            productionLossId: big.result?.productionLossId
        })
        const refusedNoReason = run("ppq_super", P + "approve#ProductionException", {
            operationKey: key(),
            productionLossId: bigAgain.result?.productionLossId,
            decision: "refuse"
        })
        const refused = run("ppq_super", P + "approve#ProductionException", {
            operationKey: key(),
            productionLossId: bigAgain.result?.productionLossId,
            decision: "refuse",
            reason: "Recount"
        })
        // a supervisor's own loss above the threshold is approved as it is recorded
        const supervisor = loss("ppq_super", r.workEffortId, {
            lossTypeEnumId: "PltOutputScrap",
            quantity: 2,
            reasonCode: "PPQ_BIG"
        })
        return {
            r,
            big,
            small,
            pendingRead,
            approved,
            refusedNoReason,
            refused,
            supervisor,
            read: quantities("ppq_reader", r.workEffortId),
            found: run("ppq_reader", P + "find#ProductionLosses", {workEffortId: r.workEffortId}),
            pendingFound: run("ppq_reader", P + "find#ProductionLosses", {statusId: "PlsRefused", workEffortId: r.workEffortId}),
            outsiderFound: run("ppq_outsider", P + "find#ProductionLosses", {workEffortId: r.workEffortId})
        }
    },
    then(x) {
        x.big.result.resultCode == "APPROVAL_REQUESTED"
        x.big.result.statusId == "PlsPending"
        x.small.result.resultCode == "RECORDED"
        outputRow(x.pendingRead).scrap == "1"
        outputRow(x.pendingRead).pendingLoss == "2"
        x.pendingRead.reconciliation.reasonCode == "LOSS_PENDING"
        x.approved.error == ""
        x.approved.result.resultCode == "APPROVED"
        x.refusedNoReason.error.includes("REASON_REQUIRED")
        x.refused.result.resultCode == "REFUSED"
        x.supervisor.result.statusId == "PlsApproved"
        outputRow(x.read).scrap == "5"
        outputRow(x.read).pendingLoss == "0"
        x.found.lossRowsCount == 4
        x.pendingFound.lossRowsCount == 1
        x.outsiderFound.lossRowsCount == 0
        rows("moqui.security.user.NotificationMessage", {
            topic: "ProductionLossApproval",
            recordId: x.big.result.productionLossId
        }).length == 1
    }
})

feature("complete is refused until the quantities reconcile, then succeeds, and a retry posts nothing twice", {
    when() {
        const r = runningRun(4)
        const partKey = key()
        const part = record("ppq_operator", r.workEffortId, {good: 3}, partKey)
        const early = act("ppq_super", r.workEffortId, "complete")
        const planner = act("ppq_planner", r.workEffortId, "complete")
        const last = record("ppq_operator", r.workEffortId, {good: 1})
        // without the completeOnFinalReceipt flag the final receipt leaves the run running
        const statusAfterLast = one("mantle.work.effort.WorkEffort", {workEffortId: r.workEffortId}).statusId
        const completeKey = key()
        const parameters = {
            operationKey: completeKey,
            workEffortId: r.workEffortId,
            action: "complete",
            expectedRevision: revision(r.workEffortId)
        }
        const completed = run("ppq_super", P + "transition#ProductionOrder", parameters)
        const retried = run("ppq_super", P + "transition#ProductionOrder", parameters)
        const receipts = rows(RECEIPT, {workEffortId: r.workEffortId}).length
        const events = rows(QEVENT, {workEffortId: r.workEffortId}).length
        const partAgain = record("ppq_operator", r.workEffortId, {good: 3}, partKey)
        return {
            r,
            part,
            early,
            planner,
            last,
            statusAfterLast,
            completed,
            retried,
            partAgain,
            receipts,
            events,
            receiptsAfter: rows(RECEIPT, {workEffortId: r.workEffortId}).length,
            eventsAfter: rows(QEVENT, {workEffortId: r.workEffortId}).length,
            runAfter: one("mantle.work.effort.WorkEffort", {workEffortId: r.workEffortId}),
            operations: rows("mantle.work.effort.WorkEffort", {parentWorkEffortId: r.workEffortId})
        }
    },
    then(x) {
        x.part.error == ""
        x.early.error.includes("QUANTITIES_UNRECONCILED")
        x.planner.error.includes("PERMISSION_DENIED")
        x.last.error == ""
        x.last.result.completed == false
        x.statusAfterLast == "WeInProgress"
        x.completed.error == ""
        x.completed.result.resultCode == "COMPLETED"
        x.retried.error == ""
        x.retried.result.alreadyApplied == true
        x.partAgain.result.alreadyApplied == true
        x.receiptsAfter == x.receipts
        x.eventsAfter == x.events
        x.runAfter.statusId == "WeComplete"
        x.operations.every(op => op.statusId == "WeComplete" || op.statusId == "WeCancelled")
    }
})

feature("Finish remainder records the rest as an approved loss; unissued material needs its variance accepted", {
    when() {
        const r = runningRun(4, {issue: {rm1: 4, rm2: 2}})
        record("ppq_operator", r.workEffortId, {good: 3})
        const noReason = act("ppq_super", r.workEffortId, "complete", {finishRemainder: true})
        const unissued = act("ppq_super", r.workEffortId, "complete", {finishRemainder: true, reason: "Last unit failed"})
        const done = act("ppq_super", r.workEffortId, "complete", {
            finishRemainder: true,
            acceptMaterialVariance: true,
            reason: "Last unit failed"
        })
        return {
            r,
            noReason,
            unissued,
            done,
            losses: rows(LOSS, {workEffortId: r.workEffortId}),
            status: one("mantle.work.effort.WorkEffort", {workEffortId: r.workEffortId}).statusId
        }
    },
    then(x) {
        x.noReason.error.includes("REASON_REQUIRED")
        x.unissued.error.includes("MATERIAL_UNISSUED")
        x.done.error == ""
        x.done.result.resultCode == "COMPLETED"
        x.status == "WeComplete"
        x.losses.length == 1
        x.losses[0].lossTypeEnumId == "PltProcessLoss"
        n(x.losses[0].quantity) == 1
        x.losses[0].statusId == "PlsApproved"
    }
})

feature("under the completeOnFinalReceipt flag the final output receipt completes the run in the same transaction", {
    when() {
        const r = runningRun(4, {facilityId: flagPlant})
        const first = record("ppq_operator", r.workEffortId, {good: 2})
        const final = record("ppq_operator", r.workEffortId, {good: 2})
        return {first, final, status: one("mantle.work.effort.WorkEffort", {workEffortId: r.workEffortId}).statusId}
    },
    then(x) {
        x.first.error == ""
        x.first.result.completed == false
        x.final.error == ""
        x.final.result.completed == true
        x.status == "WeComplete"
    }
})

feature("a draft's by-product is planned, refused for receipt until its cost allocation, and estimated by quantity", {
    when() {
        const workEffortId = draft(10)
        const added = run("ppq_planner", P + "store#ProductionOutput", {
            operationKey: key(),
            workEffortId,
            expectedRevision: revision(workEffortId),
            productId: "PPQ_BY",
            quantity: 2
        })
        const reader = run("ppq_reader", P + "store#ProductionOutput", {
            operationKey: key(),
            workEffortId,
            expectedRevision: revision(workEffortId),
            productId: "PPQ_BY",
            quantity: 1
        })
        const primary = run("ppq_planner", P + "store#ProductionOutput", {
            operationKey: key(),
            workEffortId,
            expectedRevision: revision(workEffortId),
            productionRunLineId: linesOf(workEffortId).output,
            quantity: 3
        })
        const produce = rows("mantle.work.effort.WorkEffortProduct", {workEffortId, productId: "PPQ_BY"})
        act("ppq_planner", workEffortId, "release")
        act("ppq_super", workEffortId, "start")
        const late = run("ppq_planner", P + "store#ProductionOutput", {
            operationKey: key(),
            workEffortId,
            expectedRevision: revision(workEffortId),
            productId: "PPQ_BY",
            quantity: 1
        })
        const byproductReceipt = run("ppq_operator", P + "receive#ProductionOutput", {
            operationKey: key(),
            workEffortId,
            productionRunLineId: added.result?.productionRunLineId,
            quantity: 1
        })
        return {
            added,
            reader,
            primary,
            produce,
            late,
            byproductReceipt,
            read: quantities("ppq_finance", workEffortId),
            readerRead: quantities("ppq_reader", workEffortId)
        }
    },
    then(x) {
        x.added.error == ""
        x.added.result.resultCode == "ADDED"
        x.reader.error.includes("PERMISSION_DENIED")
        x.primary.error.includes("OUTPUT_PRIMARY")
        x.produce.length == 1
        x.produce[0].typeEnumId == "WeptProduce"
        n(x.produce[0].estimatedQuantity) == 2
        x.late.error.includes("RUN_NOT_DRAFT")
        x.byproductReceipt.error.includes("BYPRODUCT_NOT_COSTED")
        x.read.outputRows.length == 2
        x.read.allocation.available == true
        x.read.allocation.totalCost == "50"
        x.read.allocation.rows.find(row => row.lineRoleEnumId == "PrlrByproduct").sharePercent == "16.67"
        x.readerRead.allocation == null
    }
})
