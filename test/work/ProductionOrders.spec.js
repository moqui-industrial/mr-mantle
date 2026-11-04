// The lifecycle of production runs (impl-manufacturing P5a; design-manufacturing WorkOrders, WorkOrderDetail, Overview and
// Operations): transition#ProductionOrder releases through release#ProductionOrder after the release gate (the policy as of
// the release, a later method release with its re-explosion, the shortage policy with a supervisor's staged release whose
// short line stays blocked for issue), unreleases while no fact exists, holds before start and resumes as released, starts,
// cancels an unposted draft, refuses complete, close and the generic transitions, and checks each action's permission;
// batch#ProductionAction answers per run; the seeded transitions carry their permission; find#ProductionOrders,
// get#ProductionOperations, the header, equipment and people stores. The users are in spec-local groups.
const P = "mantle.work.ProductionServices.",
    B = "mantle.product.BomServices.",
    R = "mantle.work.RoutingServices."
const org = "PO5_ORG",
    other = "PO5_OTHER",
    plant = "PO5_PLANT",
    line = "PO5_LINE",
    stagedLine = "PO5_LINE_STAGED"
const find = (entity, conditions = {}) => ec.entity.find(entity).condition(conditions).disableAuthz()
const one = (entity, conditions) => find(entity, conditions).one()
const rows = (entity, conditions) => Array.from(find(entity, conditions).list())
const n = value => (value == null ? 0 : Number(String(value)))
const since = "2000-01-01T00:00:00Z"
const state = {}
let keySeq = 0
const key = () => "po5-op-" + ++keySeq
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
function draft(quantity, productId = "PO5_FIN", facilityId = line) {
    const created = run("po5_planner", P + "create#ProductionOrder", {
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
const stock = (productId, quantity) => {
    login("john.doe")
    ec.artifactExecution.disableAuthz()
    const assetId = call("mantle.product.AssetServices.receive#Asset", {
        productId,
        quantity,
        facilityId: plant,
        locationSeqId: "PICK1",
        ownerPartyId: org,
        assetTypeEnumId: "AstTpInventory",
        statusId: "AstAvailable",
        acquireCost: 2
    }).assetId
    call("update#mantle.product.asset.Asset", {assetId, acquireCostUomId: "USD"})
    return assetId
}
const issue = (workEffortId, productId, assetId, quantity) =>
    run("po5_issuer", P + "issue#ProductionMaterial", {
        operationKey: key(),
        workEffortId,
        productionRunLineId: lineOf(workEffortId, productId).productionRunLineId,
        assetId,
        quantity
    })
// a method of one product: a BOM on the spec routing, its lines {productId, quantity, operation index}
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
        user("PO5_PLANNER", ["PRODUCTION_PLAN", "PRODUCTION_VIEW", "METHOD_VIEW"])
        user("PO5_SUPER", ["PRODUCTION_SUPERVISE", "PRODUCTION_VIEW"])
        user("PO5_READER", ["PRODUCTION_VIEW"])
        user("PO5_ISSUER", ["STOCK_ISSUE"])
        user("PO5_ADMIN", ["PRODUCTION_POLICY_EDIT", "PRODUCTION_VIEW"])
        user("PO5_METHOD", ["METHOD_VIEW", "METHOD_EDIT", "METHOD_APPROVE", "METHOD_RESOURCES"])
        user("PO5_OUTSIDER", ["PRODUCTION_PLAN", "PRODUCTION_SUPERVISE", "PRODUCTION_VIEW"], other)
        user("PO5_OPERATOR", ["PRODUCTION_OPERATE"])
        call("create#mantle.facility.Facility", {
            facilityId: plant,
            facilityTypeEnumId: "FcTpWarehouse",
            facilityName: "Orders plant",
            ownerPartyId: org
        })
        for (const [facilityId, facilityName] of [
            [line, "Orders line"],
            [stagedLine, "Staged line"]
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
        for (const productId of ["PO5_FIN", "PO5_ALT", "PO5_RM", "PO5_SHORT"])
            call("create#mantle.product.Product", {
                productId,
                productName: productId,
                productTypeEnumId: "PtAsset",
                assetTypeEnumId: "AstTpInventory",
                amountUomId: "OTH_ea",
                ownerPartyId: org
            })
        call("create#mantle.product.asset.Asset", {
            assetId: "PO5_ROBOT",
            assetTypeEnumId: "AstTpEquipment",
            assetName: "Spec robot",
            facilityId: plant,
            ownerPartyId: org,
            statusId: "AstAvailable"
        })
        call("create#mantle.product.asset.Asset", {
            assetId: "PO5_BROKEN",
            assetTypeEnumId: "AstTpEquipment",
            assetName: "Spec broken robot",
            facilityId: plant,
            ownerPartyId: org,
            statusId: "AstOnHold"
        })
        ec.artifactExecution.enableAuthz()
        // the routing: Assemble (10), then Test (20) after it; FIN takes PO5_RM at Assemble and PO5_SHORT at Test, ALT only RM
        as("po5_method", () => {
            call(R + "store#WorkCenter", {organizationPartyId: org, facilityId: line, changeReason: "Spec work center"})
            const routeId = call(R + "store#Routing", {
                organizationPartyId: org,
                workEffortName: "Orders routing",
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
            state.finBom = method("PO5_FIN", [
                {productId: "PO5_RM", quantity: 1, operation: 0},
                {productId: "PO5_SHORT", quantity: 1, operation: 1}
            ])
            state.altBom = method("PO5_ALT", [{productId: "PO5_RM", quantity: 1, operation: 0}])
        })
        state.rm = stock("PO5_RM", 100)
        state.short = stock("PO5_SHORT", 2)
        // the staged line releases short lines without an approval (its own override of the shortage policy)
        const staged = run("po5_admin", P + "store#ProductionPolicy", {
            facilityId: stagedLine,
            shortageReleaseEnumId: "PsrStaged",
            changeReason: "Staged line"
        })
        if (staged.error) throw new Error("Policy failed: " + staged.error)
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

feature("a planner releases a covered draft through the transition, and the run keeps the policy of its release", {
    when() {
        const workEffortId = draft(2)
        const lifecycle = run("po5_planner", P + "get#ProductionLifecycle", {workEffortId})
        const request = {operationKey: "po5-release-once", workEffortId, action: "release", expectedRevision: 1}
        const released = run("po5_planner", P + "transition#ProductionOrder", request)
        const retry = run("po5_planner", P + "transition#ProductionOrder", request)
        const start = act("po5_planner", workEffortId, "start")
        tick()
        const changed = run("po5_admin", P + "store#ProductionPolicy", {
            organizationPartyId: org,
            overProducePercent: 7,
            changeReason: "After the release"
        })
        const kept = run("po5_reader", P + "get#ProductionPolicy", {workEffortId})
        const later = run("po5_reader", P + "get#ProductionPolicy", {organizationPartyId: org})
        const notices = rows("moqui.security.user.NotificationMessage", {topic: "ProductionRelease", recordId: workEffortId})
        return {workEffortId, lifecycle, released, retry, start, changed, kept, later, notices}
    },
    then({workEffortId, lifecycle, released, retry, start, changed, kept, later, notices}) {
        lifecycle.error == ""
        lifecycle.actions.find(row => row.action === "release").allowed == true
        lifecycle.actions.find(row => row.action === "cancel").permitted == false
        released.error == ""
        released.result.resultCode == "RELEASED"
        released.result.staged == false
        runOf(workEffortId).statusId == "WeApproved"
        rows("mantle.work.effort.WorkEffort", {parentWorkEffortId: workEffortId}).length == 2
        // a retry under the same key answers the first result; a planner cannot start it
        retry.error == ""
        retry.result.alreadyApplied == true
        retry.result.revision == released.result.revision
        start.error.includes("PERMISSION_DENIED")
        notices.length == 1
        changed.error == ""
        n(kept.policy.overProducePercent) == 0
        n(later.policy.overProducePercent) == 7
    }
})

feature("a short draft waits for a supervisor's staged release, and the short line's issue stays blocked until covered", {
    when() {
        const workEffortId = draft(10)
        const refused = act("po5_planner", workEffortId, "release")
        const supervisorRelease = act("po5_super", workEffortId, "release")
        const requested = act("po5_planner", workEffortId, "requestStaged")
        const notices = rows("moqui.security.user.NotificationMessage", {
            topic: "ProductionStagedRelease",
            recordId: workEffortId
        })
        const planned = act("po5_planner", workEffortId, "approveStaged")
        const approved = act("po5_super", workEffortId, "approveStaged")
        const released = act("po5_planner", workEffortId, "release")
        const shortLine = lineOf(workEffortId, "PO5_SHORT")
        const order = run("po5_reader", P + "get#ProductionOrder", {workEffortId})
        const blockedIssue = issue(workEffortId, "PO5_SHORT", state.short, 1)
        const coveredIssue = issue(workEffortId, "PO5_RM", state.rm, 10)
        const more = stock("PO5_SHORT", 20)
        const issuedAfter = issue(workEffortId, "PO5_SHORT", more, 10)
        const cleared = lineOf(workEffortId, "PO5_SHORT")
        const unrelease = act("po5_planner", workEffortId, "unrelease")
        return {
            refused,
            supervisorRelease,
            requested,
            notices,
            planned,
            approved,
            released,
            shortLine,
            order,
            blockedIssue,
            coveredIssue,
            issuedAfter,
            cleared,
            unrelease
        }
    },
    then(r) {
        r.refused.error.includes("SHORTAGE")
        r.refused.error.includes("PO5_SHORT short 8 of 10")
        r.supervisorRelease.error.includes("PERMISSION_DENIED")
        r.requested.error == ""
        r.requested.result.resultCode == "REQUESTED"
        r.notices.length == 1
        r.planned.error.includes("PERMISSION_DENIED")
        r.approved.error == ""
        r.approved.result.resultCode == "APPROVED"
        r.released.error == ""
        r.released.result.staged == true
        n(r.shortLine.stagedShortQuantity) == 8
        r.order.lines.find(row => row.productId === "PO5_SHORT").stagedShort == "8"
        r.blockedIssue.error.includes("LINE_STAGED_SHORT")
        r.coveredIssue.error == ""
        r.issuedAfter.error == ""
        n(r.cleared.stagedShortQuantity) == 0
        // an unrelease after an issue is refused, naming the facts
        r.unrelease.error.includes("RUN_HAS_FACTS")
        r.unrelease.error.includes("2 issues")
    }
})

feature("the staged policy of a line releases a short draft without an approval, its short line blocked", {
    when() {
        const workEffortId = draft(50, "PO5_FIN", stagedLine)
        const released = act("po5_planner", workEffortId, "release")
        return {released, line: lineOf(workEffortId, "PO5_SHORT")}
    },
    then({released, line}) {
        released.error == ""
        released.result.staged == true
        n(line.stagedShortQuantity) > 0
    }
})

feature("a later release of the method is found and a re-explosion offered, then the reviewed draft releases", {
    when() {
        const workEffortId = draft(3, "PO5_ALT")
        // a planner's manual line (impl-manufacturing P5b) survives the re-explosion
        const manualAdded = run("po5_planner", P + "store#ProductionMaterial", {
            operationKey: key(),
            workEffortId,
            expectedRevision: revisionOf(workEffortId),
            productId: "PO5_SHORT",
            quantity: 1
        })
        tick()
        as("po5_method", () => {
            const bomLine = call(B + "get#BomDetail", {productBomId: state.altBom}).bomItemRows.find(
                row => row.productId === "PO5_RM"
            )
            call(B + "store#BomItem", {bomItemId: bomLine.bomItemId, quantity: 2, changeReason: "Two of RM"})
            const detail = call(B + "get#BomDetail", {productBomId: state.altBom})
            call(B + "release#BomDraft", {
                productBomId: state.altBom,
                expectedRevision: detail.expectedRevision,
                changeReason: "Second"
            })
        })
        tick()
        const preview = run("po5_planner", P + "get#ProductionLifecycle", {workEffortId})
        const stale = act("po5_planner", workEffortId, "release")
        const reexploded = act("po5_planner", workEffortId, "release", {reexplode: true})
        const draftStatus = runOf(workEffortId).statusId
        const manualKept = linesOf(workEffortId).filter(row => row.manualLine === "Y")
        const methodLines = linesOf(workEffortId).filter(row => row.productId === "PO5_RM")
        // the short manual line is removed before the release
        const manualRemoved = run("po5_planner", P + "store#ProductionMaterial", {
            operationKey: key(),
            workEffortId,
            expectedRevision: revisionOf(workEffortId),
            productionRunLineId: manualKept[0]?.productionRunLineId,
            remove: true
        })
        const released = act("po5_planner", workEffortId, "release")
        return {
            workEffortId,
            manualAdded,
            preview,
            stale,
            reexploded,
            draftStatus,
            manualKept,
            methodLines,
            manualRemoved,
            released
        }
    },
    then({workEffortId, manualAdded, preview, stale, reexploded, draftStatus, manualKept, methodLines, manualRemoved, released}) {
        manualAdded.error == ""
        preview.actions.find(row => row.action === "release").reasonCode == "METHOD_CHANGED"
        preview.actions.find(row => row.action === "release").reexplodeOffered == true
        stale.error.includes("METHOD_CHANGED")
        reexploded.error == ""
        reexploded.result.resultCode == "REEXPLODED"
        draftStatus == "WeInPlanning"
        manualKept.length == 1
        manualKept[0].productId == "PO5_SHORT"
        methodLines.length == 1
        manualRemoved.error == ""
        released.error == ""
        released.result.resultCode == "RELEASED"
        n(lineOf(workEffortId, "PO5_RM").stockQuantity) == 6
    }
})

feature("a released run held before start resumes as released; started, held and resumed it runs again", {
    when() {
        const workEffortId = draft(1, "PO5_ALT")
        act("po5_planner", workEffortId, "release")
        const noReason = act("po5_super", workEffortId, "hold")
        const held = act("po5_super", workEffortId, "hold", {reason: "Fixture repair"})
        const heldStatus = runOf(workEffortId).statusId
        const resumed = act("po5_super", workEffortId, "resume")
        const resumedStatus = runOf(workEffortId).statusId
        const started = act("po5_super", workEffortId, "start")
        const heldAgain = act("po5_super", workEffortId, "hold", {reasonCode: "NONE_SUCH"})
        const heldCoded = act("po5_super", workEffortId, "hold", {reason: "Robot fault"})
        // a run held after its start is not cancelled, though nothing is posted
        const startedCancel = act("po5_super", workEffortId, "cancel", {reason: "Not needed"})
        const runningAgain = act("po5_super", workEffortId, "resume")
        const runningStatus = runOf(workEffortId).statusId
        const lifecycle = run("po5_super", P + "get#ProductionLifecycle", {workEffortId})
        return {
            noReason,
            held,
            heldStatus,
            resumed,
            resumedStatus,
            started,
            heldAgain,
            heldCoded,
            startedCancel,
            runningAgain,
            runningStatus,
            lifecycle
        }
    },
    then(r) {
        r.noReason.error.includes("REASON_REQUIRED")
        r.held.error == ""
        r.heldStatus == "WeOnHold"
        r.resumed.result.resultCode == "RESUMED"
        r.resumedStatus == "WeApproved"
        r.started.result.resultCode == "STARTED"
        r.heldAgain.error.includes("REASON_INVALID")
        r.heldCoded.error == ""
        r.startedCancel.error.includes("RUN_STARTED")
        r.runningAgain.error == ""
        r.runningStatus == "WeInProgress"
        // the history names the hold's reason
        r.lifecycle.history.some(row => row.toStatusText === "On Hold" && row.changeReason === "Fixture repair")
        r.lifecycle.actions.find(row => row.action === "complete").reasonCode == "COMPLETE_UNAVAILABLE"
    }
})

feature("an unposted draft is cancelled and an unposted release unreleased; complete, close and generic moves are refused", {
    when() {
        const cancelled = draft(1, "PO5_ALT")
        const cancel = act("po5_super", cancelled, "cancel", {reason: "Demand withdrawn"})
        const released = draft(1, "PO5_ALT")
        act("po5_planner", released, "release")
        const unrelease = act("po5_planner", released, "unrelease")
        const afterUnrelease = runOf(released)
        const operations = rows("mantle.work.effort.WorkEffort", {parentWorkEffortId: released})
        const generic = draft(1, "PO5_ALT")
        const toComplete = act("po5_super", generic, null, {toStatusId: "WeComplete"})
        const toClosed = act("po5_super", generic, "close")
        const boardRelease = act("po5_planner", generic, null, {toStatusId: "WeApproved"})
        const stale = run("po5_super", P + "transition#ProductionOrder", {
            operationKey: key(),
            workEffortId: generic,
            action: "start",
            expectedRevision: 1
        })
        return {cancel, cancelled, unrelease, afterUnrelease, operations, released, toComplete, toClosed, boardRelease, stale}
    },
    then(r) {
        r.cancel.error == ""
        runOf(r.cancelled).statusId == "WeCancelled"
        r.unrelease.error == ""
        r.afterUnrelease.statusId == "WeInPlanning"
        r.afterUnrelease.productionReleaseDate == null
        r.operations.every(op => op.statusId === "WeCancelled")
        linesOf(r.released).every(row => row.frozenDate == null && row.operationWorkEffortId == null)
        r.toComplete.error.includes("TRANSITION_INVALID")
        r.toClosed.error.includes("CLOSE_BY_COST_CLOSE")
        r.boardRelease.error == ""
        r.boardRelease.result.resultCode == "RELEASED"
        r.stale.error.includes("REVISION_CHANGED")
    }
})

feature("the seeded transitions carry their permission: a task takes them only with it", {
    when() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        const task = call("create#mantle.work.effort.WorkEffort", {
            workEffortTypeEnumId: "WetTask",
            statusId: "WeApproved",
            workEffortName: "Spec task",
            ownerPartyId: org
        }).workEffortId
        const update = (username, statusId) =>
            run(username, "update#mantle.work.effort.WorkEffort", {workEffortId: task, statusId})
        return {
            readerHold: update("po5_reader", "WeOnHold"),
            readerUnrelease: update("po5_reader", "WeInPlanning"),
            supervisorHold: update("po5_super", "WeOnHold"),
            supervisorResume: update("po5_super", "WeApproved")
        }
    },
    then(r) {
        r.readerHold.error != ""
        r.readerUnrelease.error != ""
        r.supervisorHold.error == ""
        r.supervisorResume.error == ""
        !one("moqui.basic.StatusFlowTransition", {statusFlowId: "Default", statusId: "WeApproved", toStatusId: "WeInPlanning"})
    }
})

feature("a bulk release of three runs names the blocked one and releases the others", {
    when() {
        const ids = [draft(1, "PO5_ALT"), draft(500), draft(1, "PO5_ALT")]
        const batch = run("po5_planner", P + "batch#ProductionAction", {
            operationKey: key(),
            action: "release",
            workEffortIds: ids
        })
        return {ids, batch}
    },
    then({ids, batch}) {
        batch.error == ""
        batch.successCount == 2
        batch.blockedCount == 1
        batch.results.find(row => row.workEffortId === ids[1]).reasonCode == "SHORTAGE"
        batch.results.find(row => row.workEffortId === ids[1]).outcome == "blocked"
        runOf(ids[0]).statusId == "WeApproved"
        runOf(ids[1]).statusId == "WeInPlanning"
    }
})

feature("another organization reaches no run, and a reader changes nothing", {
    when() {
        const workEffortId = draft(1, "PO5_ALT")
        return {
            workEffortId,
            outsider: act("po5_outsider", workEffortId, "release"),
            outsiderRead: run("po5_outsider", P + "get#ProductionLifecycle", {workEffortId}),
            outsiderFind: run("po5_outsider", P + "find#ProductionOrders", {statusId: "all"}),
            reader: act("po5_reader", workEffortId, "release"),
            readerStore: run("po5_reader", P + "store#ProductionOrder", {
                operationKey: key(),
                workEffortId,
                expectedRevision: 1,
                workEffortName: "Renamed"
            }),
            readerFind: run("po5_reader", P + "find#ProductionOrders", {productId: "PO5_ALT", statusId: "all"}),
            operator: run("po5_operator", P + "find#ProductionOrders", {})
        }
    },
    then(r) {
        r.outsider.error.includes("RECORD_UNAVAILABLE")
        r.outsiderRead.error.includes("RECORD_UNAVAILABLE")
        r.outsiderFind.error == ""
        !r.outsiderFind.orderRows.some(row => row.workEffortId === r.workEffortId)
        r.reader.error.includes("PERMISSION_DENIED")
        r.readerStore.error.includes("PERMISSION_DENIED")
        r.readerFind.orderRows.some(row => row.workEffortId === r.workEffortId)
        r.readerFind.orderRows.every(row => row.productId === "PO5_ALT")
        r.operator.error.includes("PERMISSION_DENIED")
    }
})

feature("the draft header, equipment and people are stored with the revision; a released header is not", {
    when() {
        const workEffortId = draft(1, "PO5_ALT")
        const stored = run("po5_planner", P + "store#ProductionOrder", {
            operationKey: key(),
            workEffortId,
            expectedRevision: 1,
            workEffortName: "Renamed run",
            estimatedStartDate: "2030-01-02T08:00:00Z",
            estimatedCompletionDate: "2030-01-01T08:00:00Z"
        })
        const renamed = run("po5_planner", P + "store#ProductionOrder", {
            operationKey: key(),
            workEffortId,
            expectedRevision: 1,
            workEffortName: "Renamed run",
            priority: 3
        })
        const equipment = (assetId, extra = {}) =>
            run(
                "po5_planner",
                P + "store#ProductionEquipment",
                Object.assign({operationKey: key(), workEffortId, expectedRevision: revisionOf(workEffortId), assetId}, extra)
            )
        const robot = equipment("PO5_ROBOT", {fromDate: "2030-01-01T08:00:00Z", thruDate: "2030-01-02T08:00:00Z"})
        const broken = equipment("PO5_BROKEN")
        const stockAsset = equipment(state.rm)
        const party = (partyId, roleTypeId, extra = {}) =>
            run(
                "po5_planner",
                P + "store#ProductionParty",
                Object.assign(
                    {operationKey: key(), workEffortId, expectedRevision: revisionOf(workEffortId), partyId, roleTypeId},
                    extra
                )
            )
        const supervisor = party("PO5_SUPER", "Manager")
        const outsider = party("PO5_OUTSIDER", "Assignee")
        const role = party("PO5_SUPER", "Customer")
        const resources = run("po5_reader", P + "get#ProductionResources", {workEffortId})
        // another run cannot take the robot over the same days until this one ends its assignment
        const otherRun = draft(1, "PO5_ALT")
        const otherEquipment = () =>
            run("po5_planner", P + "store#ProductionEquipment", {
                operationKey: key(),
                workEffortId: otherRun,
                expectedRevision: revisionOf(otherRun),
                assetId: "PO5_ROBOT",
                fromDate: "2030-01-01T12:00:00Z",
                thruDate: "2030-01-03T08:00:00Z"
            })
        const clash = otherEquipment()
        const ended = equipment("PO5_ROBOT", {end: true})
        const afterEnd = otherEquipment()
        act("po5_planner", workEffortId, "release")
        const releasedStore = run("po5_planner", P + "store#ProductionOrder", {
            operationKey: key(),
            workEffortId,
            expectedRevision: revisionOf(workEffortId),
            workEffortName: "Too late"
        })
        return {
            workEffortId,
            stored,
            renamed,
            robot,
            broken,
            stockAsset,
            supervisor,
            outsider,
            role,
            resources,
            clash,
            ended,
            afterEnd,
            releasedStore
        }
    },
    then(r) {
        r.stored.error.includes("DATES_INVALID")
        r.renamed.error == ""
        runOf(r.workEffortId).workEffortName == "Renamed run"
        r.robot.error == ""
        r.broken.error.includes("EQUIPMENT_BLOCKED")
        r.stockAsset.error.includes("EQUIPMENT_INVALID")
        r.supervisor.error == ""
        r.outsider.error.includes("PARTY_UNAVAILABLE")
        r.role.error.includes("ROLE_INVALID")
        r.resources.equipmentRows.length == 1
        r.resources.peopleRows.some(row => row.partyId === "PO5_SUPER" && row.roleText === "Supervisor")
        r.clash.error.includes("EQUIPMENT_OVERLAP")
        r.ended.error == ""
        r.afterEnd.error == ""
        r.releasedStore.error.includes("RUN_NOT_DRAFT")
    }
})

feature("the operations of a released run show their readiness and predecessors; a draft shows the routing's", {
    when() {
        const workEffortId = draft(1, "PO5_ALT")
        const planned = run("po5_reader", P + "get#ProductionOperations", {workEffortId})
        act("po5_planner", workEffortId, "release")
        const released = run("po5_reader", P + "get#ProductionOperations", {workEffortId})
        const picks = run("po5_reader", P + "get#ProductionPickList", {workEffortId})
        return {planned, released, picks}
    },
    then({planned, released, picks}) {
        planned.error == ""
        planned.draft == true
        planned.operationRows.length == 2
        planned.operationRows[0].readinessText == "Work order not released"
        released.operationRows.length == 2
        released.operationRows[0].ready == true
        released.operationRows[1].ready == false
        released.operationRows[1].readinessText == "Waiting for Assemble"
        released.operationRows[1].predecessorText == "Assemble"
        picks.pickRows.length == 1
        picks.pickRows[0].picks.length == 1
        picks.pickRows[0].short == null
    }
})
