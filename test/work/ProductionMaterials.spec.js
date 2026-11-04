// The materials of production runs (impl-manufacturing P5b; design-manufacturing Components and MaterialIssueReceipt):
// get#ProductionMaterials shows each line's required, issued, returned and remaining quantity, the stock free for it, what is
// short and what is held by status apart; store#ProductionMaterial adds, changes and removes a manual line of a draft, kept
// at release; preview#ProductionBackflush shows the lots a backflush issues (oldest expiry first) and
// backflush#ProductionMaterials issues them once through the issue guard, or nothing on a shortfall, a held lot or a manual
// policy, also at a facility that allows issue beyond quantity on hand (F12); the shortage notice and
// get#ProductionShortages. The users are in spec-local groups.
const P = "mantle.work.ProductionServices.",
    B = "mantle.product.BomServices.",
    R = "mantle.work.RoutingServices."
const org = "PM5_ORG",
    other = "PM5_OTHER",
    plant = "PM5_PLANT",
    line = "PM5_LINE",
    flushLine = "PM5_FLUSH"
const find = (entity, conditions = {}) => ec.entity.find(entity).condition(conditions).disableAuthz()
const one = (entity, conditions) => find(entity, conditions).one()
const rows = (entity, conditions) => Array.from(find(entity, conditions).list())
const n = value => (value == null ? 0 : Number(String(value)))
const since = "2000-01-01T00:00:00Z"
const state = {}
let keySeq = 0
const key = () => "pm5-op-" + ++keySeq
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
const runOf = workEffortId => one("mantle.work.effort.WorkEffort", {workEffortId})
const linesOf = workEffortId => rows("mantle.work.production.ProductionRunLine", {workEffortId})
const lineOf = (workEffortId, productId) => linesOf(workEffortId).find(row => row.productId === productId)
const revisionOf = workEffortId => n(runOf(workEffortId).productionRevision)
const byProduct = (list, productId) => Array.from(list || []).find(row => row.productId === productId) || {}
const issuancesOf = workEffortId => rows("mantle.product.issuance.AssetIssuance", {workEffortId})
function draft(quantity, productId, facilityId = line) {
    const created = run("pm5_planner", P + "create#ProductionOrder", {
        operationKey: key(),
        organizationPartyId: org,
        productId,
        quantity,
        facilityId
    })
    if (created.error) throw new Error("Create failed: " + created.error)
    return created.workEffortId
}
const act = (username, workEffortId, action, extra = {}) =>
    run(
        username,
        P + "transition#ProductionOrder",
        Object.assign({operationKey: key(), workEffortId, action, expectedRevision: revisionOf(workEffortId)}, extra)
    )
function released(quantity, productId, facilityId = line) {
    const workEffortId = draft(quantity, productId, facilityId)
    const done = act("pm5_planner", workEffortId, "release")
    if (done.error) throw new Error("Release failed: " + done.error)
    return workEffortId
}
// stock of the organization at the plant: available, or held (statusId), in a lot expiring in the given days
function stock(productId, quantity, options = {}) {
    login("john.doe")
    ec.artifactExecution.disableAuthz()
    if (options.lotId)
        call("create#mantle.product.asset.Lot", {
            lotId: options.lotId,
            productId,
            expirationDate: new Date(Date.now() + options.expiresDays * 86400000)
        })
    const assetId = call("mantle.product.AssetServices.receive#Asset", {
        productId,
        quantity,
        facilityId: plant,
        locationSeqId: "PICK1",
        ownerPartyId: org,
        assetTypeEnumId: "AstTpInventory",
        statusId: options.statusId || "AstAvailable",
        lotId: options.lotId || null,
        acquireCost: 2
    }).assetId
    call("update#mantle.product.asset.Asset", {assetId, acquireCostUomId: "USD"})
    tick()
    return assetId
}
// a released method of one product on the spec routing: its lines {productId, quantity, operation index}
function method(productId, lines) {
    const bom = call(B + "store#Bom", {
        productId,
        organizationPartyId: org,
        routingWorkEffortId: state.routeId,
        changeReason: "Spec method"
    })
    const productBomId = bom.productBom.productBomId
    for (const row of lines)
        call(B + "store#BomItem", {
            productBomId,
            productId: row.productId,
            quantity: row.quantity,
            operationWorkEffortId: state.operationIds[row.operation],
            changeReason: "Spec line"
        })
    const detail = call(B + "get#BomDetail", {productBomId})
    call(B + "release#BomDraft", {productBomId, expectedRevision: detail.expectedRevision, changeReason: "Spec release"})
    return productBomId
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
        call("mantle.ledger.LedgerServices.init#PartyAccountingConfiguration", {
            organizationPartyId: org,
            sourcePartyId: "DefaultSettings",
            baseCurrencyUomId: "USD"
        })
        call("mantle.ledger.LedgerServices.get#OrganizationFiscalTimePeriods", {
            organizationPartyId: org,
            filterDate: ec.user.nowTimestamp
        })
        user("PM5_PLANNER", ["PRODUCTION_PLAN", "PRODUCTION_VIEW", "METHOD_VIEW"])
        user("PM5_PLANNER2", ["PRODUCTION_PLAN", "PRODUCTION_VIEW"])
        user("PM5_SUPER", ["PRODUCTION_SUPERVISE", "PRODUCTION_VIEW"])
        user("PM5_READER", ["PRODUCTION_VIEW"])
        user("PM5_ISSUER", ["STOCK_ISSUE"])
        user("PM5_OPERATOR", ["PRODUCTION_OPERATE", "PRODUCTION_VIEW"])
        user("PM5_ADMIN", ["PRODUCTION_POLICY_EDIT", "PRODUCTION_VIEW"])
        user("PM5_METHOD", ["METHOD_VIEW", "METHOD_EDIT", "METHOD_APPROVE", "METHOD_RESOURCES"])
        user("PM5_OUTSIDER", ["PRODUCTION_PLAN", "PRODUCTION_VIEW", "STOCK_ISSUE"], other)
        // the plant issues beyond quantity on hand (F12): the backflush still refuses held stock and a shortfall
        call("create#mantle.facility.Facility", {
            facilityId: plant,
            facilityTypeEnumId: "FcTpWarehouse",
            facilityName: "Materials plant",
            ownerPartyId: org,
            assetAllowIssueOverQoh: "Y"
        })
        for (const [facilityId, facilityName] of [
            [line, "Materials line"],
            [flushLine, "Backflush line"]
        ])
            call("create#mantle.facility.Facility", {
                facilityId,
                facilityTypeEnumId: "FcTpLine",
                facilityName,
                parentFacilityId: plant,
                ownerPartyId: org
            })
        call("create#mantle.facility.Facility", {
            facilityId: "PM5_OTHER_WH",
            facilityTypeEnumId: "FcTpWarehouse",
            facilityName: "Other warehouse",
            ownerPartyId: other
        })
        call("create#mantle.facility.FacilityLocation", {
            facilityId: plant,
            locationSeqId: "PICK1",
            locationTypeEnumId: "FltPick"
        })
        for (const productId of [
            "PM5_FIN",
            "PM5_RM",
            "PM5_RM2",
            "PM5_EXTRA",
            "PM5_BF",
            "PM5_BF_A",
            "PM5_BF_B",
            "PM5_SF",
            "PM5_SF_A"
        ])
            call("create#mantle.product.Product", {
                productId,
                productName: productId,
                productTypeEnumId: "PtAsset",
                assetTypeEnumId: "AstTpInventory",
                amountUomId: "OTH_ea",
                ownerPartyId: org
            })
        ec.artifactExecution.enableAuthz()
        // the routing: Assemble (10), then Test (20)
        as("pm5_method", () => {
            call(R + "store#WorkCenter", {organizationPartyId: org, facilityId: line, changeReason: "Spec work center"})
            call(R + "store#WorkCenter", {organizationPartyId: org, facilityId: flushLine, changeReason: "Spec work center"})
            const routeId = call(R + "store#Routing", {
                organizationPartyId: org,
                workEffortName: "Materials routing",
                changeReason: "Spec"
            }).routing.workEffortId
            const operation = (workEffortName, sequenceNum, predecessors) =>
                call(R + "store#RoutingOperation", {
                    workEffortId: routeId,
                    workEffortName,
                    sequenceNum,
                    estimatedWorkTime: 6,
                    timeUomId: "TF_min",
                    methodBatchQuantity: 1,
                    methodQuantityUomId: "OTH_ea",
                    methodWorkCenterId: line,
                    methodPredecessorIds: predecessors || null,
                    changeReason: "Spec operation"
                }).operationWorkEffortId
            const assemble = operation("Assemble", 10)
            const test = operation("Test", 20, assemble)
            const routing = call(R + "get#RoutingDetail", {workEffortId: routeId})
            call(R + "release#RoutingDraft", {
                workEffortId: routeId,
                expectedRevision: routing.expectedRevision,
                changeReason: "Spec"
            })
            state.routeId = routeId
            state.operationIds = [assemble, test]
            method("PM5_FIN", [
                {productId: "PM5_RM", quantity: 1, operation: 0},
                {productId: "PM5_RM2", quantity: 2, operation: 1}
            ])
            method("PM5_BF", [
                {productId: "PM5_BF_A", quantity: 1, operation: 0},
                {productId: "PM5_BF_B", quantity: 1, operation: 1}
            ])
            method("PM5_SF", [{productId: "PM5_SF_A", quantity: 1, operation: 0}])
        })
        state.rm = stock("PM5_RM", 50)
        state.rm2 = stock("PM5_RM2", 50)
        stock("PM5_EXTRA", 10)
        // the backflush lots: the later expiry received first, the earlier one after it
        state.bfLate = stock("PM5_BF_A", 2, {lotId: "PM5_LOT_LATE", expiresDays: 60})
        state.bfEarly = stock("PM5_BF_A", 5, {lotId: "PM5_LOT_EARLY", expiresDays: 20})
        state.bfB = stock("PM5_BF_B", 4)
        // the shortfall component: one available, the rest held in quarantine and on hold
        state.sfFree = stock("PM5_SF_A", 1)
        state.sfQuarantine = stock("PM5_SF_A", 5, {statusId: "AstQuarantine"})
        state.sfOnHold = stock("PM5_SF_A", 2, {statusId: "AstOnHold"})
        // the backflush line issues by backflush and releases short lines staged
        const policy = run("pm5_admin", P + "store#ProductionPolicy", {
            facilityId: flushLine,
            consumptionMethodEnumId: "PcmBackflush",
            issuePointEnumId: "PipOperationComplete",
            shortageReleaseEnumId: "PsrStaged",
            changeReason: "Backflush line"
        })
        if (policy.error) throw new Error("Policy failed: " + policy.error)
        tick()
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

feature("the materials show required, issued, returned and remaining, the free stock, the shortage and held stock apart", {
    when() {
        const workEffortId = released(3, "PM5_FIN")
        const rmLine = lineOf(workEffortId, "PM5_RM").productionRunLineId
        const issued = run("pm5_issuer", P + "issue#ProductionMaterial", {
            operationKey: key(),
            workEffortId,
            productionRunLineId: rmLine,
            assetId: state.rm,
            quantity: 2
        })
        const issuanceId = issued.result?.assetIssuanceId
        const returned = run("pm5_issuer", P + "return#UnusedMaterial", {
            operationKey: key(),
            assetIssuanceId: issuanceId,
            quantity: 1
        })
        const read = run("pm5_reader", P + "get#ProductionMaterials", {workEffortId})
        const withStock = run("pm5_issuer", P + "get#ProductionMaterials", {workEffortId, withStock: true})
        // the shortfall run (staged on the backflush line): one free, seven held by status
        const shortRun = released(3, "PM5_SF", flushLine)
        const short = run("pm5_reader", P + "get#ProductionMaterials", {workEffortId: shortRun})
        const outsider = run("pm5_outsider", P + "get#ProductionMaterials", {workEffortId})
        return {workEffortId, issued, returned, read, withStock, short, outsider}
    },
    then({issued, returned, read, withStock, short, outsider}) {
        issued.error == ""
        returned.error == ""
        read.error == ""
        read.run.released == true
        read.canIssue == false
        read.materialRows.length == 2
        byProduct(read.materialRows, "PM5_RM").required == "3"
        byProduct(read.materialRows, "PM5_RM").issued == "2"
        byProduct(read.materialRows, "PM5_RM").returned == "1"
        byProduct(read.materialRows, "PM5_RM").remaining == "2"
        byProduct(read.materialRows, "PM5_RM").operationName == "Assemble"
        byProduct(read.materialRows, "PM5_RM2").required == "6"
        byProduct(read.materialRows, "PM5_RM2").short == null
        read.policy.consumptionMethodEnumId == "PcmManual"
        withStock.canIssue == true
        byProduct(withStock.materialRows, "PM5_RM").stockOptions[0].value == state.rm
        short.materialRows[0].available == "1"
        short.materialRows[0].short == "2"
        short.materialRows[0].held == "7"
        short.materialRows[0].heldQuarantine == "5"
        short.materialRows[0].heldOnHold == "2"
        short.materialRows[0].stagedShort == "2"
        short.shortCount == 1
        short.policy.backflush == true
        outsider.error.includes("RECORD_UNAVAILABLE")
    }
})

feature("a planner adds, changes and removes a manual line of a draft; release keeps it; a method line and others are refused", {
    when() {
        const workEffortId = draft(1, "PM5_FIN")
        const before = revisionOf(workEffortId)
        const addRequest = {
            operationKey: key(),
            workEffortId,
            expectedRevision: before,
            productId: "PM5_EXTRA",
            quantity: 2,
            routingOperationWorkEffortId: state.operationIds[1],
            sourceFacilityId: plant,
            instructionText: "Stage beside the test bench"
        }
        const reader = run("pm5_reader", P + "store#ProductionMaterial", Object.assign({}, addRequest, {operationKey: key()}))
        const added = run("pm5_planner", P + "store#ProductionMaterial", addRequest)
        const retry = run("pm5_planner", P + "store#ProductionMaterial", addRequest)
        const manual = lineOf(workEffortId, "PM5_EXTRA")
        const consume = rows("mantle.work.effort.WorkEffortProduct", {
            workEffortId,
            productId: "PM5_EXTRA",
            typeEnumId: "WeptConsume"
        })
        const changed = run("pm5_planner", P + "store#ProductionMaterial", {
            operationKey: key(),
            workEffortId,
            expectedRevision: revisionOf(workEffortId),
            productionRunLineId: manual.productionRunLineId,
            quantity: 3
        })
        const afterChange = lineOf(workEffortId, "PM5_EXTRA")
        // an edit form posting every field clears the empty ones (F-P5b-1)
        const cleared = run("pm5_planner", P + "store#ProductionMaterial", {
            operationKey: key(),
            workEffortId,
            expectedRevision: revisionOf(workEffortId),
            productionRunLineId: manual.productionRunLineId,
            quantity: 3,
            routingOperationWorkEffortId: state.operationIds[1],
            clearEmpty: true
        })
        const methodLine = run("pm5_planner", P + "store#ProductionMaterial", {
            operationKey: key(),
            workEffortId,
            expectedRevision: revisionOf(workEffortId),
            productionRunLineId: lineOf(workEffortId, "PM5_RM").productionRunLineId,
            quantity: 5
        })
        const stale = run("pm5_planner", P + "store#ProductionMaterial", {
            operationKey: key(),
            workEffortId,
            expectedRevision: before,
            productId: "PM5_EXTRA",
            quantity: 1
        })
        const output = run("pm5_planner", P + "store#ProductionMaterial", {
            operationKey: key(),
            workEffortId,
            expectedRevision: revisionOf(workEffortId),
            productId: "PM5_FIN",
            quantity: 1
        })
        const unit = run("pm5_planner", P + "store#ProductionMaterial", {
            operationKey: key(),
            workEffortId,
            expectedRevision: revisionOf(workEffortId),
            productId: "PM5_EXTRA",
            quantity: 1,
            quantityUomId: "WT_kg"
        })
        const foreignFacility = run("pm5_planner", P + "store#ProductionMaterial", {
            operationKey: key(),
            workEffortId,
            expectedRevision: revisionOf(workEffortId),
            productId: "PM5_EXTRA",
            quantity: 1,
            sourceFacilityId: "PM5_OTHER_WH"
        })
        const extraLine = lineOf(workEffortId, "PM5_EXTRA")
        const releasedNow = act("pm5_planner", workEffortId, "release")
        const kept = lineOf(workEffortId, "PM5_EXTRA")
        const afterRelease = run("pm5_planner", P + "store#ProductionMaterial", {
            operationKey: key(),
            workEffortId,
            expectedRevision: revisionOf(workEffortId),
            productId: "PM5_EXTRA",
            quantity: 1
        })
        // a second draft: a manual line removed
        const second = draft(1, "PM5_FIN")
        run("pm5_planner", P + "store#ProductionMaterial", {
            operationKey: key(),
            workEffortId: second,
            expectedRevision: revisionOf(second),
            productId: "PM5_EXTRA",
            quantity: 1
        })
        const removed = run("pm5_planner", P + "store#ProductionMaterial", {
            operationKey: key(),
            workEffortId: second,
            expectedRevision: revisionOf(second),
            productionRunLineId: lineOf(second, "PM5_EXTRA").productionRunLineId,
            remove: true
        })
        const secondConsume = rows("mantle.work.effort.WorkEffortProduct", {
            workEffortId: second,
            productId: "PM5_EXTRA",
            typeEnumId: "WeptConsume"
        }).filter(row => row.thruDate == null)
        return {
            before,
            reader,
            added,
            retry,
            manual,
            consume,
            changed,
            afterChange,
            cleared,
            methodLine,
            stale,
            output,
            unit,
            foreignFacility,
            extraLine,
            releasedNow,
            kept,
            afterRelease,
            removed,
            second,
            secondConsume
        }
    },
    then(r) {
        r.reader.error.includes("PERMISSION_DENIED")
        r.added.error == ""
        r.added.result.resultCode == "ADDED"
        r.added.result.revision == r.before + 1
        r.retry.result.alreadyApplied == true
        r.manual.manualLine == "Y"
        r.manual.sourceFacilityId == plant
        r.manual.routingOperationWorkEffortId == state.operationIds[1]
        r.manual.instructionText == "Stage beside the test bench"
        n(r.consume[0].estimatedQuantity) == 2
        r.changed.error == ""
        r.changed.result.resultCode == "UPDATED"
        r.afterChange.instructionText == "Stage beside the test bench"
        r.afterChange.sourceFacilityId == plant
        r.cleared.error == ""
        r.extraLine.instructionText == null
        r.extraLine.sourceFacilityId == null
        r.extraLine.routingOperationWorkEffortId == state.operationIds[1]
        r.methodLine.error.includes("LINE_NOT_MANUAL")
        r.stale.error.includes("REVISION_CHANGED")
        r.output.error.includes("PRODUCT_INVALID")
        r.unit.error.includes("UNIT_CONVERSION")
        r.foreignFacility.error.includes("RECORD_UNAVAILABLE")
        n(r.extraLine.stockQuantity) == 3
        r.releasedNow.error == ""
        !!r.kept.operationWorkEffortId
        r.afterRelease.error.includes("RUN_NOT_DRAFT")
        r.removed.result.resultCode == "REMOVED"
        lineOf(r.second, "PM5_EXTRA") == null
        r.secondConsume.length == 0
    }
})

feature("a backflush preview shows its lots, oldest expiry first, and issues once; a manual policy previews nothing", {
    when() {
        const workEffortId = released(3, "PM5_BF", flushLine)
        const operatorPreview = run("pm5_operator", P + "preview#ProductionBackflush", {workEffortId})
        const preview = run("pm5_issuer", P + "preview#ProductionBackflush", {workEffortId})
        const request = {operationKey: "pm5-backflush-once", workEffortId, previewKey: preview.previewKey}
        const stale = run("pm5_issuer", P + "backflush#ProductionMaterials", {
            operationKey: key(),
            workEffortId,
            previewKey: "stale"
        })
        const confirmed = run("pm5_issuer", P + "backflush#ProductionMaterials", request)
        const issuedOnce = issuancesOf(workEffortId)
        const retry = run("pm5_issuer", P + "backflush#ProductionMaterials", request)
        const issuedAfterRetry = issuancesOf(workEffortId)
        const events = rows("mantle.work.production.ProductionCostEvent", {workEffortId})
        const after = run("pm5_issuer", P + "preview#ProductionBackflush", {workEffortId})
        // a run under the manual policy
        const manualRun = released(1, "PM5_FIN")
        const manual = run("pm5_issuer", P + "preview#ProductionBackflush", {workEffortId: manualRun})
        const manualConfirm = run("pm5_issuer", P + "backflush#ProductionMaterials", {
            operationKey: key(),
            workEffortId: manualRun,
            previewKey: manual.previewKey
        })
        return {
            workEffortId,
            operatorPreview,
            preview,
            stale,
            confirmed,
            issuedOnce,
            retry,
            issuedAfterRetry,
            events,
            after,
            manual,
            manualConfirm
        }
    },
    then(r) {
        r.operatorPreview.error.includes("PERMISSION_DENIED")
        r.preview.error == ""
        r.preview.canConfirm == true
        r.preview.lineRows.length == 2
        byProduct(r.preview.lineRows, "PM5_BF_A").picks.length == 1
        byProduct(r.preview.lineRows, "PM5_BF_A").picks[0].assetId == state.bfEarly
        byProduct(r.preview.lineRows, "PM5_BF_A").picks[0].lotId == "PM5_LOT_EARLY"
        byProduct(r.preview.lineRows, "PM5_BF_A").picks[0].quantity == "3"
        byProduct(r.preview.lineRows, "PM5_BF_B").picks[0].assetId == state.bfB
        r.stale.error.includes("PREVIEW_CHANGED")
        r.confirmed.error == ""
        r.confirmed.result.resultCode == "BACKFLUSHED"
        r.confirmed.result.issuedCount == 2
        r.issuedOnce.length == 2
        r.issuedOnce.every(row => !!row.productionMaterialLineId)
        r.retry.result.alreadyApplied == true
        r.issuedAfterRetry.length == 2
        r.events.length == 2
        r.after.canConfirm == false
        r.after.findings.some(row => row.reasonCode === "NOTHING_TO_ISSUE")
        r.manual.canConfirm == false
        r.manual.findings[0].reasonCode == "BACKFLUSH_NOT_POLICY"
        r.manualConfirm.error.includes("BACKFLUSH_NOT_POLICY")
    }
})

feature("a shortfall with held stock issues nothing, even where issue beyond on hand is allowed; the shortage is noticed", {
    when() {
        const workEffortId = released(3, "PM5_SF", flushLine)
        const notices = rows("moqui.security.user.NotificationMessage", {topic: "ProductionShortage", recordId: workEffortId})
        const recipients = notices.length
            ? rows("moqui.security.user.NotificationMessageUser", {notificationMessageId: notices[0].notificationMessageId}).map(
                  row => row.userId
              )
            : []
        const preview = run("pm5_issuer", P + "preview#ProductionBackflush", {workEffortId})
        const confirm = run("pm5_issuer", P + "backflush#ProductionMaterials", {
            operationKey: key(),
            workEffortId,
            previewKey: preview.previewKey
        })
        const heldIssue = run("pm5_issuer", P + "issue#ProductionMaterial", {
            operationKey: key(),
            workEffortId,
            productionRunLineId: lineOf(workEffortId, "PM5_SF_A").productionRunLineId,
            assetId: state.sfQuarantine,
            quantity: 1
        })
        const shortages = run("pm5_reader", P + "get#ProductionShortages", {facilityId: plant})
        const noView = run("pm5_issuer", P + "get#ProductionShortages", {facilityId: plant})
        return {workEffortId, notices, recipients, preview, confirm, heldIssue, shortages, noView}
    },
    then(r) {
        r.notices.length == 1
        r.recipients.includes("PM5_PLANNER2")
        !r.recipients.includes("PM5_READER")
        r.preview.canConfirm == false
        r.preview.findings.some(row => row.reasonCode === "SHORTFALL")
        r.preview.findings.some(row => row.reasonCode === "LINE_STAGED_SHORT")
        r.preview.lineRows[0].short == "2"
        r.confirm.error.includes("SHORTFALL")
        issuancesOf(r.workEffortId).length == 0
        r.heldIssue.error.includes("LINE_STAGED_SHORT") || r.heldIssue.error.includes("HELD_STOCK")
        r.shortages.error == ""
        r.shortages.shortRows.some(row => row.workEffortId === r.workEffortId && row.shortageText.includes("PM5_SF_A"))
        r.noView.error.includes("PERMISSION_DENIED")
    }
})
