// Accounting's production cost close (impl-manufacturing P15; design-accounting ProductionCostClose, CostingPolicies and
// §16.3 production-to-GL): a by-product is received as its own stock at its co-product share of the frozen estimate; a
// completed run with material, labor, machine and outside-processing events previews its absorption (by cost component),
// the overhead per work-center hour, the co-product split and the variance, and posts once as one transaction that closes
// the run; a retry answers the first post; a closed period is refused; a labor event after the close is previewed and
// posted as an adjustment; time on an unapproved timesheet and an unvalued event block the close; a cost estimator can
// request the review but not preview or post; the allocation policy is an effective-dated row the close keeps. Labor and
// machine events are written as Manufacturing's shop-floor phase writes them (its sources are not here), each awaiting the
// close. The users are in spec-local groups.
const P = "mantle.work.ProductionServices.",
    C = "mantle.ledger.ProductionCostServices.",
    B = "mantle.product.BomServices.",
    R = "mantle.work.RoutingServices."
const EVENT = "mantle.work.production.ProductionCostEvent",
    ALLOCATION = "mantle.work.production.ProductionCostAllocation",
    WORK = "mantle.work.effort.WorkEffort"
const org = "PCC_ORG",
    other = "PCC_OTHER",
    plant = "PCC_PLANT"
const accounts = {
    GatLaborApplied: "517000000",
    GatOverheadApplied: "519100000",
    GatOutsideProcessAccrued: "511000000",
    GatProductionVariance: "519200000"
}
const find = (entity, conditions = {}) => ec.entity.find(entity).condition(conditions).disableAuthz()
const one = (entity, conditions) => find(entity, conditions).one()
const rows = (entity, conditions) => Array.from(find(entity, conditions).list())
const n = value => (value == null ? null : Number(String(value)))
const near = (a, b) => Math.abs(Number(a) - Number(b)) < 0.005
const since = "2000-01-01T00:00:00Z"
const state = {}
let keySeq = 0
const key = () => "pcc-op-" + ++keySeq
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
const revision = workEffortId => Number(one(WORK, {workEffortId}).productionRevision || 0)
const act = (username, workEffortId, action, extra = {}) =>
    run(
        username,
        P + "transition#ProductionOrder",
        Object.assign({operationKey: key(), workEffortId, action, expectedRevision: revision(workEffortId)}, extra)
    )
const linesOf = workEffortId => rows("mantle.work.production.ProductionRunLine", {workEffortId})
const lineOf = (workEffortId, productId) => linesOf(workEffortId).find(row => row.productId === productId)
// a running run of 10 PCC_FIN with 10 PCC_RM1 issued at 2 and its 10 good output received at the standard 5
function runningRun() {
    const created = run("pcc_planner", P + "create#ProductionOrder", {
        operationKey: key(),
        organizationPartyId: org,
        productId: "PCC_FIN",
        quantity: 10,
        facilityId: plant
    })
    if (created.error) throw new Error("Create failed: " + created.error)
    const workEffortId = created.workEffortId
    const released = act("pcc_planner", workEffortId, "release")
    if (released.error) throw new Error("Release failed: " + released.error)
    const started = act("pcc_super", workEffortId, "start")
    if (started.error) throw new Error("Start failed: " + started.error)
    const issued = run("pcc_issuer", P + "issue#ProductionMaterial", {
        operationKey: key(),
        workEffortId,
        productionRunLineId: lineOf(workEffortId, "PCC_RM1").productionRunLineId,
        assetId: state.rm1,
        quantity: 10
    })
    if (issued.error) throw new Error("Issue failed: " + issued.error)
    const output = run("pcc_issuer", P + "receive#ProductionOutput", {operationKey: key(), workEffortId, quantity: 10})
    if (output.error) throw new Error("Output failed: " + output.error)
    const operation = rows(WORK, {parentWorkEffortId: workEffortId})[0]
    return {workEffortId, operationWorkEffortId: operation?.workEffortId || null}
}
// a cost event as the labor of approved production time (P10's TimeEntry source, its sync behind laborCostSync) and the
// subcontract acceptance (P14) write it: awaiting the close, with its hours or quantity
let eventSeq = 0
function costEvent(r, values) {
    return call(
        "create#" + EVENT,
        Object.assign(
            {
                organizationPartyId: org,
                workEffortId: r.workEffortId,
                operationWorkEffortId: r.operationWorkEffortId,
                sourceEntityName: "PccSpecSource",
                sourceId: "PCC-" + ++eventSeq,
                sourceRevision: 1,
                amountUomId: "USD",
                valuationStatusEnumId: "PcvValued",
                ledgerStatusEnumId: "PclAwaitingClose",
                eventDate: ec.user.nowTimestamp,
                afterClose: "N",
                createdDate: ec.user.nowTimestamp
            },
            values
        )
    ).productionCostEventId
}
const labor = (r, hours, amount, extra = {}) =>
    costEvent(
        r,
        Object.assign(
            {costEventTypeEnumId: "PcetLabor", costComponentEnumId: "PrcLabor", quantity: hours, quantityUomId: "TF_hr", amount},
            extra
        )
    )
// a closed machine runtime interval as the shop floor records it (P10's MachineRuntimeEvent), unvalued without an amount,
// and its event through record#ProductionCostEvent (P10's source)
let runtimeSeq = 0
function machine(r, hours, amount) {
    const machineRuntimeEventId = "PCC_RT_" + ++runtimeSeq
    call("create#mantle.work.production.MachineRuntimeEvent", {
        machineRuntimeEventId,
        organizationPartyId: org,
        workEffortId: r.workEffortId,
        operationWorkEffortId: r.operationWorkEffortId,
        facilityId: plant,
        fromDate: ec.user.nowTimestamp,
        thruDate: ec.user.nowTimestamp,
        hours,
        amount,
        rateAmount: amount == null ? null : amount / hours,
        amountUomId: "USD",
        valuationStatusEnumId: amount == null ? "PcvUnvalued" : "PcvValued",
        createdDate: ec.user.nowTimestamp
    })
    return call(P + "record#ProductionCostEvent", {
        sourceEntityName: "mantle.work.production.MachineRuntimeEvent",
        sourceId: machineRuntimeEventId
    }).productionCostEventId
}
const outside = (r, amount) =>
    costEvent(r, {costEventTypeEnumId: "PcetOutsideAccrual", costComponentEnumId: "PrcOutside", quantity: 10, amount})
const preview = (username, workEffortId, extra = {}) =>
    run(username, C + "preview#CostClose", Object.assign({workEffortId}, extra))
const post = (username, previewed, extra = {}) =>
    run(
        username,
        C + "post#CostClose",
        Object.assign(
            {
                operationKey: key(),
                workEffortId: previewed.workEffortId,
                accountingDate: previewed.accountingDate,
                inputFingerprint: previewed.inputFingerprint
            },
            extra
        )
    )
const entriesOf = acctgTransId => {
    const out = {}
    for (const row of rows("mantle.ledger.transaction.AcctgTransEntry", {acctgTransId})) {
        const signed = n(row.amount) * (row.debitCreditFlag === "D" ? 1 : -1)
        out[row.glAccountId] = (out[row.glAccountId] || 0) + signed
    }
    return out
}
const codes = previewed => (previewed.findings || []).map(row => row.code)

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
        // the production cost close accounts (no DefaultSettings default: each organization maps them)
        for (const [glAccountTypeEnumId, glAccountId] of Object.entries(accounts))
            call("create#mantle.ledger.config.GlAccountTypeDefault", {organizationPartyId: org, glAccountTypeEnumId, glAccountId})
        // a closed fiscal month in the past, for the closed period refusal
        call("create#mantle.party.time.TimePeriod", {
            timePeriodId: "PCC_CLOSED_MONTH",
            partyId: org,
            timePeriodTypeId: "FiscalMonth",
            periodName: "Closed month",
            fromDate: "2020-01-01",
            thruDate: "2020-01-31",
            isClosed: "Y"
        })
        user("PCC_METHOD", ["METHOD_VIEW", "METHOD_EDIT", "METHOD_APPROVE", "METHOD_RESOURCES"])
        user("PCC_PLANNER", ["PRODUCTION_PLAN", "PRODUCTION_VIEW", "METHOD_VIEW"])
        user("PCC_SUPER", ["PRODUCTION_SUPERVISE", "PRODUCTION_VIEW"])
        user("PCC_ISSUER", ["STOCK_ISSUE"])
        user("PCC_ESTIMATOR", ["PRODUCTION_VIEW", "PRODUCT_COST_VIEW", "PRODUCTION_COST_REVIEW"])
        user("PCC_GL", ["ACCOUNTING_VIEW", "ACCOUNTING_GL_POST"])
        user("PCC_POSTER", ["ACCOUNTING_VIEW", "PRODUCTION_COST_POST"])
        user("PCC_ADMIN", ["ACCOUNTING_ADMIN", "ACCOUNTING_VIEW"])
        user("PCC_OTHER_POSTER", ["ACCOUNTING_VIEW", "PRODUCTION_COST_POST", "ACCOUNTING_GL_POST"], other)
        call("create#mantle.facility.Facility", {
            facilityId: plant,
            facilityTypeEnumId: "FcTpWarehouse",
            facilityName: "Cost close plant",
            ownerPartyId: org
        })
        call("create#mantle.facility.FacilityLocation", {
            facilityId: plant,
            locationSeqId: "PICK1",
            locationTypeEnumId: "FltPick"
        })
        for (const productId of ["PCC_FIN", "PCC_RM1", "PCC_BY"])
            call("create#mantle.product.Product", {
                productId,
                productName: productId,
                productTypeEnumId: "PtAsset",
                assetTypeEnumId: "AstTpInventory",
                amountUomId: "OTH_ea",
                ownerPartyId: org
            })
        // the approved estimate release freezes: 5 a unit
        call("create#mantle.product.cost.ProductStandardCost", {
            productStandardCostId: "PCC_STD",
            productId: "PCC_FIN",
            organizationPartyId: org,
            state: "approved",
            fromDate: since,
            quantity: 1,
            quantityUomId: "OTH_ea",
            priceUomId: "USD",
            unitCost: 5,
            totalCost: 5,
            materialCost: 2,
            laborCost: 1.5,
            machineCost: 1,
            overheadCost: 0.5,
            complete: "Y"
        })
        ec.artifactExecution.enableAuthz()
        // the method: one operation consuming one PCC_RM1 per PCC_FIN and yielding 0.2 PCC_BY
        as("pcc_method", () => {
            call(R + "store#WorkCenter", {organizationPartyId: org, facilityId: plant, changeReason: "Spec work center"})
            const routeId = call(R + "store#Routing", {
                organizationPartyId: org,
                workEffortName: "Cost close routing",
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
                productId: "PCC_FIN",
                organizationPartyId: org,
                routingWorkEffortId: routeId,
                changeReason: "Spec method"
            }).productBom.productBomId
            call(B + "store#BomItem", {
                productBomId,
                productId: "PCC_RM1",
                quantity: 1,
                operationWorkEffortId: operationId,
                changeReason: "Spec line"
            })
            call(B + "store#BomItem", {
                productBomId,
                productId: "PCC_BY",
                roleEnumId: "BmirByproduct",
                quantity: 0.2,
                quantityUomId: "OTH_ea",
                operationWorkEffortId: operationId,
                changeReason: "Spec by-product"
            })
            const detail = call(B + "get#BomDetail", {productBomId})
            call(B + "release#BomDraft", {productBomId, expectedRevision: detail.expectedRevision, changeReason: "Spec release"})
        })
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        state.rm1 = stock("PCC_RM1", 200, 2)
        // the plant's overhead: 10 an hour
        call("create#mantle.work.production.WorkCenterRate", {
            workCenterRateId: "PCC_OVERHEAD",
            facilityId: plant,
            componentTypeEnumId: "PccOverhead",
            rateAmount: 10,
            priceUomId: "USD",
            fromDate: since,
            state: "approved",
            changeReason: "Spec rate"
        })
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

feature("the allocation policy is an effective-dated row a finance administrator stores and the others cannot", {
    when() {
        const first = run("pcc_gl", C + "get#AllocationPolicies", {organizationPartyId: org})
        const refused = run("pcc_gl", C + "store#AllocationPolicy", {
            organizationPartyId: org,
            coproductMethodEnumId: "PcmQuantity",
            changeReason: "Spec"
        })
        const stored = run("pcc_admin", C + "store#AllocationPolicy", {
            organizationPartyId: org,
            overheadBasisEnumId: "PobWorkCenterHour",
            coproductMethodEnumId: "PcmQuantity",
            changeReason: "Spec policy"
        })
        const stale = run("pcc_admin", C + "store#AllocationPolicy", {
            organizationPartyId: org,
            coproductMethodEnumId: "PcmSalesValue",
            changeReason: "Spec stale"
        })
        const outsider = run("pcc_other_poster", C + "get#AllocationPolicies", {organizationPartyId: org})
        state.policyId = stored.productionAllocationPolicyId
        return {first, refused, stored, stale, outsider}
    },
    then({first, refused, stored, stale, outsider}) {
        first.error == ""
        first.policy.stateText == "Default"
        first.policy.overheadBasisEnumId == "PobWorkCenterHour"
        first.policy.coproductMethodEnumId == "PcmQuantity"
        refused.error.includes("PERMISSION_DENIED")
        stored.error == ""
        stored.policy.productionAllocationPolicyId == stored.productionAllocationPolicyId
        stored.policy.inEffect == true
        // a second change without the row in effect's from date is stale
        stale.error.includes("POLICY_CHANGED")
        outsider.error.includes("ORGANIZATION_DENIED")
        rows("moqui.entity.EntityAuditLog", {
            changedEntityName: "mantle.work.production.ProductionAllocationPolicy",
            pkPrimaryValue: stored.productionAllocationPolicyId,
            changedFieldName: "coproductMethodEnumId"
        }).length == 1
    }
})

feature("a by-product is received as its own stock at its co-product share of the frozen estimate", {
    when() {
        const r = runningRun()
        const byLine = lineOf(r.workEffortId, "PCC_BY")
        const received = run("pcc_issuer", P + "receive#ProductionOutput", {
            operationKey: key(),
            workEffortId: r.workEffortId,
            productionRunLineId: byLine.productionRunLineId,
            quantity: 2
        })
        const assets = (received.result?.assetIds || []).map(assetId => one("mantle.product.asset.Asset", {assetId}))
        state.byRun = r
        return {byLine, received, assets}
    },
    then({byLine, received, assets}) {
        n(byLine.stockQuantity) == 2
        received.error == ""
        received.result.costSource == "allocation"
        assets.every(asset => asset.productId == "PCC_BY" && asset.ownerPartyId == org)
        // 2 of the 12 output units by quantity: the primary's standard 5 a unit is its own 10/12, so the run's estimate is 60
        // and the 2 take 10, 5 a unit as the primary's
        near(
            assets.reduce((sum, asset) => sum + n(asset.quantityOnHandTotal) * n(asset.acquireCost), 0),
            10
        )
        received.result.productionCostEventIds.length >= 1
    }
})

feature(
    "a completed run with material, labor, machine and outside-processing events previews its absorption, overhead, co-product split and variance",
    {
        when() {
            const r = state.byRun
            labor(r, 1.5, 15)
            machine(r, 2, 20)
            outside(r, 30)
            const early = preview("pcc_gl", r.workEffortId)
            const completed = act("pcc_super", r.workEffortId, "complete", {closeUnreportedOperations: true})
            const previewed = preview("pcc_gl", r.workEffortId)
            const posterPreview = preview("pcc_poster", r.workEffortId)
            state.previewed = previewed
            return {early, completed, previewed, posterPreview}
        },
        then({early, completed, previewed, posterPreview}) {
            codes(early).includes("RUN_NOT_COMPLETE")
            completed.error == ""
            previewed.error == ""
            previewed.mode == "close"
            previewed.blocked == false
            // the GL poster previews, the cost close poster posts
            previewed.canPost == false
            posterPreview.canPost == true
            previewed.absorptionRows.length == 3
            previewed.absorptionRows.map(row => n(row.amount)).sort((a, b) => a - b) == [15, 20, 30]
            // overhead on the machine hours at the plant's rate (the operation has machine runtime, so not on its labor)
            previewed.overheadRows.length == 1
            n(previewed.overheadRows[0].amount) == 20
            n(previewed.overheadRows[0].basisQuantity) == 2
            // WIP: issued 20, relieved 50 + 10, absorbed 65 and overhead 20: 45 left to variance
            near(previewed.totals.residual, 45)
            near(previewed.totals.runCost, 105)
            previewed.outputRows.length == 2
            near(previewed.outputRows.find(row => row.lineRoleEnumId == "PrlrOutput").share, 87.5)
            near(previewed.outputRows.find(row => row.lineRoleEnumId == "PrlrByproduct").share, 17.5)
            near(previewed.outputRows.find(row => row.lineRoleEnumId == "PrlrOutput").variance, 37.5)
            near(previewed.outputRows.find(row => row.lineRoleEnumId == "PrlrByproduct").variance, 7.5)
            previewed.policy.productionAllocationPolicyId == state.policyId
            // the ledger lines balance
            const debit = previewed.ledgerRows.reduce((sum, row) => sum + (n(row.debit) || 0), 0)
            const credit = previewed.ledgerRows.reduce((sum, row) => sum + (n(row.credit) || 0), 0)
            near(debit, credit)
            near(previewed.ledgerRows.find(row => row.glAccountId == accounts.GatOverheadApplied).credit, 40)
            near(previewed.ledgerRows.find(row => row.glAccountId == accounts.GatLaborApplied).credit, 15)
            near(previewed.ledgerRows.find(row => row.glAccountId == accounts.GatOutsideProcessAccrued).credit, 30)
            near(previewed.ledgerRows.find(row => row.glAccountId == accounts.GatProductionVariance).debit, 45)
        }
    }
)

feature("a closed period is refused, and the close is not posted outside the cost close", {
    when() {
        const r = state.byRun
        const closedPreview = preview("pcc_gl", r.workEffortId, {accountingDate: "2020-01-15"})
        const closedPost = post("pcc_poster", closedPreview)
        // the run's close itself waits for the cost close: the poster's own transition is refused, and a supervisor's
        const direct = act("pcc_poster", r.workEffortId, "close")
        const supervisor = act("pcc_super", r.workEffortId, "close")
        return {closedPreview, closedPost, direct, supervisor, status: one(WORK, {workEffortId: r.workEffortId}).statusId}
    },
    then({closedPreview, closedPost, direct, supervisor, status}) {
        codes(closedPreview).includes("PERIOD_CLOSED")
        closedPreview.blocked == true
        closedPost.error.includes("PERIOD_CLOSED")
        direct.error.includes("COST_CLOSE_NOT_POSTED")
        supervisor.error.includes("CLOSE_BY_COST_CLOSE")
        status == "WeComplete"
    }
})

feature("a cost estimator can request the review but not preview or post, and the GL poster cannot post", {
    when() {
        const r = state.byRun
        const requested = run("pcc_estimator", P + "review#ProductionCosts", {
            operationKey: key(),
            workEffortId: r.workEffortId,
            expectedRevision: revision(r.workEffortId)
        })
        const estimatorPreview = preview("pcc_estimator", r.workEffortId)
        const estimatorPost = post("pcc_estimator", state.previewed)
        const glPost = post("pcc_gl", state.previewed)
        const outsider = preview("pcc_other_poster", r.workEffortId)
        return {requested, estimatorPreview, estimatorPost, glPost, outsider}
    },
    then({requested, estimatorPreview, estimatorPost, glPost, outsider}) {
        requested.error == ""
        estimatorPreview.error.includes("PERMISSION_DENIED")
        estimatorPost.error.includes("PERMISSION_DENIED")
        glPost.error.includes("PERMISSION_DENIED")
        outsider.error.includes("RECORD_UNAVAILABLE")
    }
})

feature("the close posts once, closing the run in the same transaction, and a retry answers the first post", {
    when() {
        const r = state.byRun
        const previewed = preview("pcc_poster", r.workEffortId)
        const operationKey = key()
        const posted = post("pcc_poster", previewed, {operationKey, changeReason: "Month end"})
        const retried = post("pcc_poster", previewed, {operationKey, changeReason: "Month end"})
        const after = one(WORK, {workEffortId: r.workEffortId})
        const events = rows(EVENT, {workEffortId: r.workEffortId})
        const allocations = rows(ALLOCATION, {workEffortId: r.workEffortId})
        const transactions = rows("mantle.ledger.transaction.AcctgTrans", {
            workEffortId: r.workEffortId,
            acctgTransTypeEnumId: "AttManufacturing"
        })
        const closed = run("pcc_poster", C + "get#CostClose", {workEffortId: r.workEffortId})
        const notices = rows("moqui.security.user.NotificationMessage", {topic: "ProductionCostReview", recordId: r.workEffortId})
        const afterClose = preview("pcc_poster", r.workEffortId)
        return {previewed, posted, retried, after, events, allocations, transactions, closed, notices, afterClose}
    },
    then({previewed, posted, retried, after, events, allocations, transactions, closed, notices, afterClose}) {
        previewed.blocked == false
        posted.error == ""
        posted.result.resultCode == "CLOSED"
        posted.result.transitionResultCode == "CLOSED"
        retried.error == ""
        retried.result.alreadyApplied == true
        retried.result.acctgTransId == posted.result.acctgTransId
        transactions.length == 1
        transactions[0].isPosted == "Y"
        // the run closed with its cost close, the policy row it applied and the review decided
        after.statusId == "WeClosed"
        after.productionCostCloseTransId == posted.result.acctgTransId
        after.productionAllocationPolicyId == state.policyId
        after.productionCostReviewStatusId == "PcrClosed"
        events
            .filter(event => ["PcetLabor", "PcetMachine", "PcetOutsideAccrual"].includes(event.costEventTypeEnumId))
            .every(event => event.ledgerStatusEnumId == "PclClosePosted" && event.closeAcctgTransId == posted.result.acctgTransId)
        allocations.every(row => row.productionAllocationPolicyId == state.policyId && row.adjustment == "N")
        allocations.filter(row => row.destinationEnumId == "PcdByproduct").length == 1
        // the entries balance, and the run's WIP (its stock postings with the close's allocations) ends at zero
        const lines = entriesOf(posted.result.acctgTransId)
        near(
            Object.values(lines).reduce((sum, value) => sum + value, 0),
            0
        )
        near(lines[accounts.GatProductionVariance], 45)
        afterClose.mode == "adjustment"
        near(afterClose.totals.before, 0)
        codes(afterClose).includes("NOTHING_TO_ADJUST")
        closed.closed == true
        closed.allocationRows.length == allocations.length
        notices.every(notice =>
            rows("moqui.security.user.NotificationMessageUser", {notificationMessageId: notice.notificationMessageId}).every(
                row => row.viewedDate != null
            )
        )
    }
})

feature("a labor event after the close is previewed and posted as an adjustment", {
    when() {
        const r = state.byRun
        const late = labor(r, 0.5, 5, {afterClose: "Y"})
        // the review's proposed day is the close's; an adjustment is dated today, an open period
        call("update#" + WORK, {workEffortId: r.workEffortId, productionCostAccountingDate: "2020-01-15"})
        const previewed = preview("pcc_poster", r.workEffortId)
        const posted = post("pcc_poster", previewed)
        const again = preview("pcc_poster", r.workEffortId)
        return {late, previewed, posted, again, after: one(WORK, {workEffortId: r.workEffortId})}
    },
    then({late, previewed, posted, again, after}) {
        previewed.error == ""
        previewed.mode == "adjustment"
        !codes(previewed).includes("PERIOD_CLOSED")
        previewed.absorptionRows.length == 1
        previewed.absorptionRows[0].productionCostEventId == late
        previewed.absorptionRows[0].afterClose == true
        // labor on an operation with machine runtime takes no overhead; all of it goes to variance by the output shares
        previewed.overheadRows.length == 0
        near(previewed.totals.residual, 5)
        posted.error == ""
        posted.result.resultCode == "ADJUSTED"
        after.statusId == "WeClosed"
        codes(again).includes("NOTHING_TO_ADJUST")
        rows(ALLOCATION, {workEffortId: after.workEffortId}).filter(row => row.adjustment == "Y").length >= 2
    }
})

feature("time on an unapproved timesheet and an unvalued event block the close", {
    when() {
        const r = runningRun()
        const completed = act("pcc_super", r.workEffortId, "complete", {closeUnreportedOperations: true})
        machine(r, 1, null)
        call("create#mantle.work.time.Timesheet", {timesheetId: "PCC_SHEET", partyId: "PCC_SUPER", statusId: "TmshCompleted"})
        call("create#mantle.work.time.TimeEntry", {
            timeEntryId: "PCC_TIME",
            timesheetId: "PCC_SHEET",
            partyId: "PCC_SUPER",
            workEffortId: r.workEffortId,
            fromDate: ec.user.nowTimestamp,
            hours: 1
        })
        const blocked = preview("pcc_poster", r.workEffortId)
        const refused = post("pcc_poster", blocked)
        call("update#mantle.work.time.Timesheet", {timesheetId: "PCC_SHEET", statusId: "TmshApproved"})
        const approved = preview("pcc_poster", r.workEffortId)
        return {completed, blocked, refused, approved}
    },
    then({completed, blocked, refused, approved}) {
        completed.error == ""
        codes(blocked).includes("TIME_UNAPPROVED")
        codes(blocked).includes("UNVALUED_EVENTS")
        refused.error != ""
        !codes(approved).includes("TIME_UNAPPROVED")
        codes(approved).includes("UNVALUED_EVENTS")
    }
})

feature("the variance of a subcontract bill whose match was unapplied is reversed at the close (F115)", {
    when() {
        const r = runningRun()
        act("pcc_super", r.workEffortId, "complete", {closeUnreportedOperations: true})
        call("create#mantle.order.OrderHeader", {orderId: "PCC_PO", statusId: "OrderOpen", currencyUomId: "USD"})
        call("create#mantle.order.OrderPart", {
            orderId: "PCC_PO",
            orderPartSeqId: "01",
            vendorPartyId: other,
            customerPartyId: org
        })
        call("create#mantle.order.OrderItem", {
            orderId: "PCC_PO",
            orderItemSeqId: "01",
            orderPartSeqId: "01",
            itemTypeEnumId: "ItemServiceProduct",
            quantity: 2,
            unitAmount: 10
        })
        call("create#mantle.order.OrderItemWorkEffort", {
            orderId: "PCC_PO",
            orderItemSeqId: "01",
            workEffortId: r.operationWorkEffortId
        })
        call("create#mantle.account.invoice.InvoiceMatch", {
            invoiceMatchId: "PCC_MATCH",
            organizationPartyId: org,
            statusId: "ImApplied"
        })
        call("create#mantle.account.invoice.InvoiceMatchLine", {
            invoiceMatchId: "PCC_MATCH",
            invoiceMatchLineSeqId: "01",
            orderId: "PCC_PO",
            orderItemSeqId: "01",
            quantity: 2,
            invoiceUnitAmount: 12,
            orderUnitAmount: 10,
            currencyUomId: "USD"
        })
        const variance = call(P + "record#ProductionCostEvent", {
            sourceEntityName: "mantle.account.invoice.InvoiceMatchLine",
            sourceId: "PCC_MATCH|01"
        }).productionCostEventId
        call("update#mantle.account.invoice.InvoiceMatch", {invoiceMatchId: "PCC_MATCH", statusId: "ImUnapplied"})
        const previewed = preview("pcc_poster", r.workEffortId)
        const posted = post("pcc_poster", previewed)
        const reversal = rows(EVENT, {originalCostEventId: variance})[0] || null
        return {variance, previewed, posted, reversal}
    },
    then({variance, previewed, posted, reversal}) {
        previewed.error == ""
        previewed.absorptionRows
            .filter(row => row.componentText == "Outside processing")
            .map(row => n(row.amount))
            .sort() == [-4, 4]
        previewed.absorptionRows.find(row => n(row.amount) == -4).reversalOf == variance
        posted.error == ""
        reversal != null
        n(reversal.amount) == -4
        reversal.sourceRevision == 2
        reversal.ledgerStatusEnumId == "PclClosePosted"
        one(EVENT, {productionCostEventId: variance}).ledgerStatusEnumId == "PclClosePosted"
    }
})

feature("the period close lists the runs awaiting their cost close and the production WIP", {
    when() {
        const r = runningRun()
        act("pcc_super", r.workEffortId, "complete", {closeUnreportedOperations: true})
        const day = ec.l10n.format(ec.user.nowTimestamp, "yyyy-MM-dd")
        const month = rows("mantle.party.time.TimePeriod", {partyId: org, timePeriodTypeId: "FiscalMonth"}).find(
            row => ec.l10n.format(row.fromDate, "yyyy-MM-dd") <= day && ec.l10n.format(row.thruDate, "yyyy-MM-dd") >= day
        )
        const check = checkEnumId =>
            run("pcc_gl", C + "check#ProductionClose", {organizationPartyId: org, timePeriodId: month.timePeriodId, checkEnumId})
        return {workEffortId: r.workEffortId, awaiting: check("PccProductionCostClose"), wip: check("PccProductionWip")}
    },
    then({workEffortId, awaiting, wip}) {
        awaiting.error == ""
        awaiting.items.some(item => item.recordId == workEffortId && item.recordKind == "productionCostClose")
        wip.error == ""
        wip.items.some(item => item.recordId == workEffortId)
    }
})
