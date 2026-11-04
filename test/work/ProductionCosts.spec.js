// Production cost evidence (impl-manufacturing P6, design-manufacturing ProductionCosts, crosscut CX-COST): two issues, the
// return of one unused component and an output receipt each write one event linked to the transaction its stock movement's
// hook posted, and a retried issue writes none; material without a cost is issued unvalued and not posted, and a return or
// output receipt of it is refused, since it would post nothing (F13); a cost estimator reads the frozen estimate and no
// actuals, a financial reader both, a production reader neither, and another organization's reader nothing; a review request
// sets the run's audit-logged review status and notifies Accounting's cost close posters with the run and its revision. The
// users are in spec-local groups.
const P = "mantle.work.ProductionServices.",
    B = "mantle.product.BomServices.",
    R = "mantle.work.RoutingServices."
const EVENT = "mantle.work.production.ProductionCostEvent"
const org = "PPC_ORG",
    other = "PPC_OTHER",
    plant = "PPC_PLANT"
const find = (entity, conditions = {}) => ec.entity.find(entity).condition(conditions).disableAuthz()
const one = (entity, conditions) => find(entity, conditions).one()
const rows = (entity, conditions) => Array.from(find(entity, conditions).list())
const n = value => (value == null ? null : Number(String(value)))
const since = "2000-01-01T00:00:00Z"
const state = {}
let keySeq = 0
const key = () => "ppc-op-" + ++keySeq
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
// a stock asset of a component at the plant, with a cost or none
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
    if (acquireCost != null) call("update#mantle.product.asset.Asset", {assetId, acquireCostUomId: "USD"})
    return assetId
}
// a released run of 10 PPC_FIN at the plant (its frozen standard PPC_STD), with its material lines by product
function releasedRun() {
    const created = run("ppc_planner", P + "create#ProductionOrder", {
        operationKey: key(),
        organizationPartyId: org,
        productId: "PPC_FIN",
        quantity: 10,
        facilityId: plant
    })
    const released = run("ppc_planner", P + "release#ProductionOrder", {
        operationKey: key(),
        workEffortId: created.workEffortId,
        expectedRevision: 1
    })
    if (released.error) throw new Error("Release failed: " + released.error)
    const lines = rows("mantle.work.production.ProductionRunLine", {workEffortId: created.workEffortId})
    const lineOf = productId => lines.find(row => row.productId === productId).productionRunLineId
    return {workEffortId: created.workEffortId, rm1: lineOf("PPC_RM1"), rm2: lineOf("PPC_RM2")}
}
const issue = (workEffortId, productionRunLineId, assetId, quantity, operationKey = key()) =>
    run("ppc_issuer", P + "issue#ProductionMaterial", {operationKey, workEffortId, productionRunLineId, assetId, quantity})
const receiveOutput = (workEffortId, quantity) =>
    run("ppc_issuer", P + "receive#ProductionOutput", {operationKey: key(), workEffortId, quantity})
const costs = (username, workEffortId) => run(username, P + "get#ProductionCosts", {workEffortId})
// the hook's transaction of a movement
const transOf = (field, id) => rows("mantle.ledger.transaction.AcctgTrans", {[field]: id})[0] || null
// the notices of the topic a user has about a run
const notices = (userId, workEffortId) =>
    rows("moqui.security.user.NotificationMessageUser", {userId})
        .map(row => one("moqui.security.user.NotificationMessage", {notificationMessageId: row.notificationMessageId}))
        .filter(notice => notice && notice.topic === "ProductionCostReview" && notice.recordId === workEffortId)

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
        user("PPC_METHOD", ["METHOD_VIEW", "METHOD_EDIT", "METHOD_APPROVE", "METHOD_RESOURCES"])
        user("PPC_PLANNER", ["PRODUCTION_PLAN", "PRODUCTION_VIEW", "METHOD_VIEW"])
        user("PPC_ISSUER", ["STOCK_ISSUE"])
        user("PPC_ESTIMATOR", ["PRODUCTION_VIEW", "PRODUCT_COST_VIEW", "PRODUCTION_COST_REVIEW"])
        user("PPC_FINANCE", ["ACCOUNTING_VIEW"])
        user("PPC_READER", ["PRODUCTION_VIEW"])
        user("PPC_POSTER", ["PRODUCTION_COST_POST"])
        user("PPC_OTHER_POSTER", ["PRODUCTION_COST_POST"], other)
        user("PPC_NOBODY", ["METHOD_VIEW"])
        user("PPC_OUTSIDER", ["PRODUCTION_VIEW", "ACCOUNTING_VIEW", "PRODUCTION_COST_REVIEW"], other)
        call("create#mantle.facility.Facility", {
            facilityId: plant,
            facilityTypeEnumId: "FcTpWarehouse",
            facilityName: "Cost plant",
            ownerPartyId: org
        })
        call("create#mantle.facility.FacilityLocation", {
            facilityId: plant,
            locationSeqId: "PICK1",
            locationTypeEnumId: "FltPick"
        })
        for (const productId of ["PPC_FIN", "PPC_RM1", "PPC_RM2"])
            call("create#mantle.product.Product", {
                productId,
                productName: productId,
                productTypeEnumId: "PtAsset",
                assetTypeEnumId: "AstTpInventory",
                amountUomId: "OTH_ea",
                ownerPartyId: org
            })
        // the approved estimate release freezes: 5 a unit, 3 material, 1.5 labor and 0.5 overhead
        call("create#mantle.product.cost.ProductStandardCost", {
            productStandardCostId: "PPC_STD",
            productId: "PPC_FIN",
            organizationPartyId: org,
            state: "approved",
            fromDate: since,
            quantity: 1,
            quantityUomId: "OTH_ea",
            priceUomId: "USD",
            unitCost: 5,
            totalCost: 5,
            materialCost: 3,
            laborCost: 1.5,
            overheadCost: 0.5,
            complete: "Y"
        })
        ec.artifactExecution.enableAuthz()
        // the method: one operation consuming one PPC_RM1 and one PPC_RM2 per PPC_FIN
        as("ppc_method", () => {
            call(R + "store#WorkCenter", {organizationPartyId: org, facilityId: plant, changeReason: "Spec work center"})
            const routeId = call(R + "store#Routing", {
                organizationPartyId: org,
                workEffortName: "Cost routing",
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
                productId: "PPC_FIN",
                organizationPartyId: org,
                routingWorkEffortId: routeId,
                changeReason: "Spec method"
            }).productBom.productBomId
            for (const productId of ["PPC_RM1", "PPC_RM2"])
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
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        state.rm1 = stock("PPC_RM1", 100, 2)
        state.rm2 = stock("PPC_RM2", 100, 1)
        state.uncosted = stock("PPC_RM1", 10, null)
        ec.artifactExecution.enableAuthz()
        // the runs the read and review features use: one issue and the output of each
        for (const name of ["readRun", "reviewRun"]) {
            const costed = releasedRun()
            const issued = issue(costed.workEffortId, costed.rm1, state.rm1, 10)
            if (issued.error) throw new Error("Issue failed: " + issued.error)
            const received = receiveOutput(costed.workEffortId, 10)
            if (received.error) throw new Error("Output failed: " + received.error)
            state[name] = costed.workEffortId
        }
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
    "two issues, a return of one unused component and an output receipt each write one event linked to its hook's transaction, and a retried issue writes none",
    {
        when() {
            const costed = releasedRun()
            const firstKey = key()
            const first = issue(costed.workEffortId, costed.rm1, state.rm1, 10, firstKey)
            const retried = issue(costed.workEffortId, costed.rm1, state.rm1, 10, firstKey)
            const second = issue(costed.workEffortId, costed.rm2, state.rm2, 10)
            const returned = run("ppc_issuer", P + "return#UnusedMaterial", {
                operationKey: key(),
                assetIssuanceId: second.result?.assetIssuanceId,
                quantity: 2
            })
            const output = receiveOutput(costed.workEffortId, 10)
            // the internal writer called again for the first issuance answers its event
            const again = invoke(P + "record#ProductionCostEvent", {
                sourceEntityName: "mantle.product.issuance.AssetIssuance",
                sourceId: first.result?.assetIssuanceId
            })
            const events = rows(EVENT, {workEffortId: costed.workEffortId})
            const byType = type => events.filter(event => event.costEventTypeEnumId === type)
            return {first, retried, second, returned, output, again, events, byType}
        },
        then({first, retried, second, returned, output, again, events, byType}) {
            first.error == ""
            retried.error == ""
            second.error == ""
            returned.error == ""
            output.error == ""
            events.length == 4
            byType("PcetMaterialIssue").length == 2
            byType("PcetMaterialReturn").length == 1
            byType("PcetOutputReceipt").length == 1
            // the retry answered the first issue and its event, and wrote nothing
            retried.result.alreadyApplied == true
            retried.result.productionCostEventId == first.result.productionCostEventId
            again.existing == true
            again.productionCostEventId == first.result.productionCostEventId
            // each event references the transaction its movement's hook posted, and posted nothing itself
            const issueEvent = events.find(event => event.productionCostEventId == first.result.productionCostEventId)
            issueEvent.acctgTransId == transOf("assetIssuanceId", first.result.assetIssuanceId).acctgTransId
            issueEvent.ledgerStatusEnumId == "PclPosted"
            issueEvent.valuationStatusEnumId == "PcvValued"
            issueEvent.costComponentEnumId == "PrcMaterial"
            issueEvent.productionRunLineId == first.result.productionRunLineId
            n(issueEvent.amount) == 20
            n(issueEvent.rateAmount) == 2
            const returnEvent = byType("PcetMaterialReturn")[0]
            returnEvent.acctgTransId == transOf("assetReceiptId", returned.result.assetReceiptId).acctgTransId
            returnEvent.productionCostEventId == returned.result.productionCostEventId
            returnEvent.assetIssuanceId == second.result.assetIssuanceId
            n(returnEvent.amount) == -2
            const outputEvent = byType("PcetOutputReceipt")[0]
            outputEvent.acctgTransId == transOf("assetReceiptId", output.result.assetReceiptIds[0]).acctgTransId
            output.result.productionCostEventIds == [outputEvent.productionCostEventId]
            outputEvent.costComponentEnumId == "PrcOutput"
            outputEvent.rateEntityName == "mantle.product.cost.ProductStandardCost"
            outputEvent.rateId == "PPC_STD"
            n(outputEvent.amount) == -50
            events.every(event => event.organizationPartyId == org && event.afterClose == "N")
            rows("mantle.ledger.transaction.AcctgTrans", {assetIssuanceId: first.result.assetIssuanceId}).length == 1
        }
    }
)

feature(
    "material without a cost is issued unvalued and not posted, and its return or an output receipt without a cost is refused (F13)",
    {
        when() {
            const costed = releasedRun()
            const issued = issue(costed.workEffortId, costed.rm1, state.uncosted, 3)
            const returned = run("ppc_issuer", P + "return#UnusedMaterial", {
                operationKey: key(),
                assetIssuanceId: issued.result?.assetIssuanceId,
                quantity: 1
            })
            // a receipt of the run's output with no cost, as another path would make it, is refused by the event writer
            const outputLineId = rows("mantle.work.production.ProductionRunLine", {workEffortId: costed.workEffortId}).find(
                row => row.lineRoleEnumId === "PrlrOutput"
            ).productionRunLineId
            const received = call("mantle.product.AssetServices.receive#Asset", {
                productId: "PPC_FIN",
                quantity: 1,
                facilityId: plant,
                locationSeqId: "PICK1",
                ownerPartyId: org,
                workEffortId: costed.workEffortId,
                noProduceProduct: "ignore"
            })
            call("update#mantle.product.receipt.AssetReceipt", {
                assetReceiptId: received.assetReceiptId,
                productionOutputLineId: outputLineId
            })
            const recorded = invoke(P + "record#ProductionCostEvent", {
                sourceEntityName: "mantle.product.receipt.AssetReceipt",
                sourceId: received.assetReceiptId
            })
            const events = rows(EVENT, {workEffortId: costed.workEffortId})
            const returns = rows("mantle.product.receipt.AssetReceipt", {sourceAssetIssuanceId: issued.result?.assetIssuanceId})
            return {issued, returned, recorded, events, returns}
        },
        then({issued, returned, recorded, events, returns}) {
            issued.error == ""
            events.length == 1
            events[0].valuationStatusEnumId == "PcvUnvalued"
            events[0].ledgerStatusEnumId == "PclNotPosted"
            events[0].acctgTransId == null
            events[0].amount == null
            returned.error.includes("COST_UNAVAILABLE")
            returns.length == 0
            recorded.error.includes("COST_UNAVAILABLE")
        }
    }
)

feature("a cost estimator reads the frozen estimate and no actuals, a financial reader both, a production reader neither", {
    when() {
        return {
            estimator: costs("ppc_estimator", state.readRun),
            finance: costs("ppc_finance", state.readRun),
            reader: costs("ppc_reader", state.readRun),
            outsider: costs("ppc_outsider", state.readRun),
            nobody: costs("ppc_nobody", state.readRun)
        }
    },
    then({estimator, finance, reader, outsider, nobody}) {
        estimator.error == ""
        estimator.events.length == 2
        estimator.estimate.unitCost == "5"
        estimator.estimate.totalCost == "50"
        estimator.estimate.components.find(row => row.componentEnumId == "PrcMaterial").amount == "30"
        estimator.estimate.components.find(row => row.componentEnumId == "PrcOverhead").amount == "5"
        // actual values and ledger links are left out, never zero
        estimator.actuals == null
        estimator.comparison == null
        !Object.keys(estimator.events[0]).includes("amount")
        !Object.keys(estimator.events[0]).includes("acctgTransId")
        estimator.financialRead == false
        estimator.canReview == true
        finance.error == ""
        finance.estimate.unitCost == "5"
        finance.actuals.issued == "20"
        finance.actuals.outputRelieved == "50"
        finance.actuals.wipBalance == "-30"
        finance.events.every(row => row.acctgTransId != null && row.amount != null)
        finance.comparison.find(row => row.componentEnumId == "PrcMaterial").actual == "20"
        // overhead is the estimate's only: the cost close applies it, so it is not compared
        !finance.comparison.some(row => row.componentEnumId == "PrcOverhead")
        finance.canReview == false
        reader.error == ""
        reader.events.length == 2
        reader.estimate == null
        reader.actuals == null
        !Object.keys(reader.events[0]).includes("amount")
        reader.exceptions.eventCount == 2
        outsider.error.includes("RECORD_UNAVAILABLE")
        nobody.error.includes("PERMISSION_DENIED")
    }
})

feature("a review request sets the run's review status and notifies Accounting with the run and its revision", {
    when() {
        const revision = costs("ppc_estimator", state.reviewRun).run.revision
        const parameters = expectedRevision => ({
            operationKey: key(),
            workEffortId: state.reviewRun,
            expectedRevision,
            note: "Ready for close"
        })
        const reader = run("ppc_reader", P + "review#ProductionCosts", parameters(revision))
        const outsider = run("ppc_outsider", P + "review#ProductionCosts", parameters(revision))
        const stale = run("ppc_estimator", P + "review#ProductionCosts", parameters(revision - 1))
        const first = parameters(revision)
        const requested = run("ppc_estimator", P + "review#ProductionCosts", first)
        const retried = run("ppc_estimator", P + "review#ProductionCosts", first)
        const again = run("ppc_estimator", P + "review#ProductionCosts", parameters(revision))
        const draft = run("ppc_planner", P + "create#ProductionOrder", {
            operationKey: key(),
            organizationPartyId: org,
            productId: "PPC_FIN",
            quantity: 1,
            facilityId: plant
        })
        const draftReview = run("ppc_estimator", P + "review#ProductionCosts", {
            operationKey: key(),
            workEffortId: draft.workEffortId,
            expectedRevision: 1
        })
        const after = costs("ppc_estimator", state.reviewRun)
        const workEffort = one("mantle.work.effort.WorkEffort", {workEffortId: state.reviewRun})
        const audited = rows("moqui.entity.EntityAuditLog", {
            changedEntityName: "mantle.work.effort.WorkEffort",
            pkPrimaryValue: state.reviewRun,
            changedFieldName: "productionCostReviewStatusId"
        })
        return {
            revision,
            reader,
            outsider,
            stale,
            requested,
            retried,
            again,
            draftReview,
            after,
            workEffort,
            audited,
            poster: notices("PPC_POSTER", state.reviewRun),
            otherPoster: notices("PPC_OTHER_POSTER", state.reviewRun),
            estimatorNotices: notices("PPC_READER", state.reviewRun)
        }
    },
    then({
        revision,
        reader,
        outsider,
        stale,
        requested,
        retried,
        again,
        draftReview,
        after,
        workEffort,
        audited,
        poster,
        otherPoster,
        estimatorNotices
    }) {
        reader.error.includes("PERMISSION_DENIED")
        outsider.error.includes("RECORD_UNAVAILABLE")
        stale.error.includes("REVISION_CHANGED")
        requested.error == ""
        requested.result.resultCode == "REVIEW_REQUESTED"
        requested.result.revision == revision
        retried.result.alreadyApplied == true
        again.error.includes("REVIEW_REQUESTED")
        draftReview.error.includes("RUN_NOT_RELEASED")
        workEffort.productionCostReviewStatusId == "PcrRequested"
        n(workEffort.productionCostReviewRevision) == revision
        workEffort.productionCostReviewNote == "Ready for close"
        workEffort.productionCostReviewByUserId == "PPC_ESTIMATOR"
        audited.length == 1
        audited[0].newValueText == "PcrRequested"
        after.review.statusId == "PcrRequested"
        after.review.canRequest == false
        after.review.blockCode == "REVIEW_REQUESTED"
        // one notice to the organization's cost close poster, with the run and its revision; none to another
        // organization's poster or to a production reader
        poster.length == 1
        otherPoster.length == 0
        JSON.parse(poster[0].messageJson).workEffortId == state.reviewRun
        JSON.parse(poster[0].messageJson).sourceRevision == revision
        estimatorNotices.length == 0
    }
})
