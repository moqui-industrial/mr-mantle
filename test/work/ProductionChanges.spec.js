// Controlled changes of a production run (impl-manufacturing P9, design-manufacturing Components Substitute, SplitWorkOrder,
// WorkOrderDetail's cancellation and clone, §12.1 amend#ProductionOrder): an approved substitute is issued, the original's
// demand drops and an arbitrary product is refused; after the first operation an amendment to a later BOM release remaps the
// remaining work only, the issued line keeping its facts, reviewed by a method approver and a supervisor, and strict release
// refuses it; a split moves 4 of 10 remaining to a backorder on the same method date and a retry answers the same runs, the
// demand link conserved; a backorder completes the running source; a run with postings is cancelled by a reversal or closed
// out by its residual plan; a clone is a new draft with no postings. The users are in spec-local groups.
const P = "mantle.work.ProductionServices.",
    B = "mantle.product.BomServices.",
    R = "mantle.work.RoutingServices."
const LINE = "mantle.work.production.ProductionRunLine",
    CHANGE = "mantle.work.production.ProductionChange",
    WORK = "mantle.work.effort.WorkEffort",
    WEP = "mantle.work.effort.WorkEffortProduct",
    ISSUANCE = "mantle.product.issuance.AssetIssuance",
    SUPPLY = "mantle.request.requirement.RequirementSupply"
const org = "PCH_ORG",
    other = "PCH_OTHER",
    plant = "PCH_PLANT",
    strictPlant = "PCH_STRICT",
    freePlant = "PCH_FREE"
const find = (entity, conditions = {}) => ec.entity.find(entity).condition(conditions).disableAuthz()
const one = (entity, conditions) => find(entity, conditions).one()
const rows = (entity, conditions) => Array.from(find(entity, conditions).list())
const n = value => (value == null ? null : Number(String(value)))
const since = "2000-01-01T00:00:00Z"
const state = {}
let keySeq = 0
const key = () => "pch-op-" + ++keySeq
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
const revision = workEffortId => Number(one(WORK, {workEffortId}).productionRevision || 0)
const act = (username, workEffortId, action, extra = {}) =>
    run(
        username,
        P + "transition#ProductionOrder",
        Object.assign({operationKey: key(), workEffortId, action, expectedRevision: revision(workEffortId)}, extra)
    )
const lineOf = (workEffortId, productId) =>
    rows(LINE, {workEffortId}).find(row => row.productId === productId && row.lineRoleEnumId !== "PrlrOutput")
const outputOf = workEffortId => rows(LINE, {workEffortId, lineRoleEnumId: "PrlrOutput"})[0]
const demand = (workEffortId, productId) =>
    rows(WEP, {workEffortId, productId})
        .filter(row => row.thruDate == null)
        .reduce((total, row) => total + n(row.estimatedQuantity), 0)
const opsOf = workEffortId => rows(WORK, {parentWorkEffortId: workEffortId}).sort((a, b) => n(a.sequenceNum) - n(b.sequenceNum))
// a released run of PCH_FIN, started when asked
function released(quantity, options = {}) {
    const created = run("pch_planner", P + "create#ProductionOrder", {
        operationKey: key(),
        organizationPartyId: org,
        productId: "PCH_FIN",
        quantity,
        facilityId: options.facilityId || plant
    })
    if (created.error) throw new Error("Create failed: " + created.error)
    const workEffortId = created.workEffortId
    const release = act("pch_planner", workEffortId, "release")
    if (release.error) throw new Error("Release failed: " + release.error)
    if (options.start) {
        const started = act("pch_super", workEffortId, "start")
        if (started.error) throw new Error("Start failed: " + started.error)
    }
    return workEffortId
}
function issue(workEffortId, productId, quantity) {
    const out = run("pch_operator", P + "issue#ProductionMaterial", {
        operationKey: key(),
        workEffortId,
        productionRunLineId: lineOf(workEffortId, productId).productionRunLineId,
        assetId: state.stock[productId],
        quantity
    })
    if (out.error) throw new Error("Issue failed: " + out.error)
    return out.result
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
        user("PCH_METHOD", ["METHOD_VIEW", "METHOD_EDIT", "METHOD_APPROVE", "METHOD_RESOURCES"])
        user("PCH_PLANNER", ["PRODUCTION_PLAN", "PRODUCTION_VIEW", "METHOD_VIEW"])
        user("PCH_SUPER", ["PRODUCTION_SUPERVISE", "PRODUCTION_VIEW", "PRODUCTION_OPERATE", "METHOD_VIEW"])
        user("PCH_LEAD", ["PRODUCTION_SUPERVISE", "PRODUCTION_PLAN", "PRODUCTION_VIEW", "STOCK_ISSUE", "METHOD_VIEW"])
        user("PCH_APPROVER", ["METHOD_APPROVE", "METHOD_VIEW", "PRODUCTION_VIEW"])
        user("PCH_OPERATOR", ["PRODUCTION_OPERATE", "PRODUCTION_VIEW", "STOCK_ISSUE"])
        user("PCH_READER", ["PRODUCTION_VIEW"])
        user("PCH_ADMIN", ["PRODUCTION_POLICY_EDIT", "PRODUCTION_VIEW"])
        user("PCH_OUTSIDER", ["PRODUCTION_VIEW", "PRODUCTION_PLAN", "PRODUCTION_SUPERVISE", "METHOD_APPROVE"], other)
        facility(plant)
        facility(strictPlant)
        facility(freePlant)
        for (const productId of ["PCH_FIN", "PCH_RM1", "PCH_RM2", "PCH_ALT", "PCH_ODD"])
            call("create#mantle.product.Product", {
                productId,
                productName: productId,
                productTypeEnumId: "PtAsset",
                assetTypeEnumId: "AstTpInventory",
                amountUomId: "OTH_ea",
                ownerPartyId: org
            })
        // PCH_ALT is the approved equivalent of PCH_RM2; PCH_ODD is no one's
        call("create#mantle.product.ProductAssoc", {
            productId: "PCH_RM2",
            toProductId: "PCH_ALT",
            productAssocTypeEnumId: "PatEquivalent",
            fromDate: since
        })
        ec.artifactExecution.enableAuthz()
        // the method: Cut consumes one PCH_RM1, Assemble one PCH_RM2 (whose BOM line allows approved equivalents)
        as("pch_method", () => {
            call(R + "store#WorkCenter", {organizationPartyId: org, facilityId: plant, changeReason: "Spec work center"})
            const routeId = call(R + "store#Routing", {
                organizationPartyId: org,
                workEffortName: "Change routing",
                changeReason: "Spec"
            }).routing.workEffortId
            const operation = (name, sequenceNum) =>
                call(R + "store#RoutingOperation", {
                    workEffortId: routeId,
                    workEffortName: name,
                    sequenceNum,
                    estimatedWorkTime: 6,
                    timeUomId: "TF_min",
                    methodBatchQuantity: 1,
                    methodQuantityUomId: "OTH_ea",
                    methodWorkCenterId: plant,
                    changeReason: "Spec operation"
                }).operationWorkEffortId
            state.cut = operation("Cut", 10)
            state.assemble = operation("Assemble", 20)
            const routing = call(R + "get#RoutingDetail", {workEffortId: routeId})
            call(R + "release#RoutingDraft", {
                workEffortId: routeId,
                expectedRevision: routing.expectedRevision,
                changeReason: "Spec"
            })
            state.bomId = call(B + "store#Bom", {
                productId: "PCH_FIN",
                organizationPartyId: org,
                routingWorkEffortId: routeId,
                changeReason: "Spec method"
            }).productBom.productBomId
            state.rm1Item = call(B + "store#BomItem", {
                productBomId: state.bomId,
                productId: "PCH_RM1",
                quantity: 1,
                operationWorkEffortId: state.cut,
                changeReason: "Spec line"
            }).bomItemId
            state.rm2Item = call(B + "store#BomItem", {
                productBomId: state.bomId,
                productId: "PCH_RM2",
                quantity: 1,
                operationWorkEffortId: state.assemble,
                substitutionRuleEnumId: "BsrEquivalent",
                changeReason: "Spec line"
            }).bomItemId
            const detail = call(B + "get#BomDetail", {productBomId: state.bomId})
            call(B + "release#BomDraft", {
                productBomId: state.bomId,
                expectedRevision: detail.expectedRevision,
                changeReason: "Spec release"
            })
        })
        const policy = run("pch_admin", P + "store#ProductionPolicy", {
            organizationPartyId: org,
            facilityId: strictPlant,
            strictRelease: "Y",
            changeReason: "Spec strict release"
        })
        if (policy.error) throw new Error("Policy failed: " + policy.error)
        const free = run("pch_admin", P + "store#ProductionPolicy", {
            organizationPartyId: org,
            facilityId: freePlant,
            substituteApproval: "N",
            changeReason: "Spec substitutes without approval"
        })
        if (free.error) throw new Error("Policy failed: " + free.error)
        tick()
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        state.stock = {
            PCH_RM1: stock("PCH_RM1", 500, 2),
            PCH_RM2: stock("PCH_RM2", 500, 1),
            PCH_ALT: stock("PCH_ALT", 500, 1.5)
        }
        stock("PCH_RM1", 50, 2, strictPlant)
        stock("PCH_RM2", 50, 1, strictPlant)
        stock("PCH_RM1", 50, 2, freePlant)
        stock("PCH_RM2", 50, 1, freePlant)
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

feature("an approved substitute is issued, the original's demand drops, and an arbitrary product is refused", {
    when() {
        const workEffortId = released(10, {start: true})
        const rm1 = lineOf(workEffortId, "PCH_RM1").productionRunLineId,
            rm2 = lineOf(workEffortId, "PCH_RM2").productionRunLineId
        const ask = (username, extra) =>
            run(
                username,
                P + "substitute#ProductionMaterial",
                Object.assign(
                    {operationKey: key(), workEffortId, expectedRevision: revision(workEffortId), reason: "Out of RM2"},
                    extra
                )
            )
        const arbitrary = ask("pch_planner", {productionRunLineId: rm2, substituteProductId: "PCH_ODD", quantity: 4})
        const noRule = ask("pch_planner", {productionRunLineId: rm1, substituteProductId: "PCH_ALT", quantity: 4})
        const reader = ask("pch_reader", {productionRunLineId: rm2, substituteProductId: "PCH_ALT", quantity: 4})
        const outsider = ask("pch_outsider", {productionRunLineId: rm2, substituteProductId: "PCH_ALT", quantity: 4})
        const tooMuch = ask("pch_planner", {productionRunLineId: rm2, substituteProductId: "PCH_ALT", quantity: 11})
        const before = demand(workEffortId, "PCH_RM2")
        const requested = ask("pch_planner", {productionRunLineId: rm2, substituteProductId: "PCH_ALT", quantity: 4})
        const pendingDemand = demand(workEffortId, "PCH_RM2")
        const notices = rows("moqui.security.user.NotificationMessage", {
            topic: "ProductionSubstitution",
            recordId: requested.result?.productionChangeId
        })
        const recipients = notices.length
            ? rows("moqui.security.user.NotificationMessageUser", {notificationMessageId: notices[0].notificationMessageId}).map(
                  row => row.userId
              )
            : []
        const listed = run("pch_super", P + "get#ProductionChanges", {workEffortId})
        const approveKey = key()
        const decide = (username, operationKey = key()) =>
            run(username, P + "substitute#ProductionMaterial", {
                operationKey,
                workEffortId,
                action: "approve",
                productionChangeId: requested.result?.productionChangeId
            })
        const plannerApproves = decide("pch_planner")
        const approved = decide("pch_super", approveKey)
        const retried = decide("pch_super", approveKey)
        const substituteLine = one(LINE, {productionRunLineId: approved.result?.substituteRunLineId})
        const issued = run("pch_operator", P + "issue#ProductionMaterial", {
            operationKey: key(),
            workEffortId,
            productionRunLineId: substituteLine?.productionRunLineId,
            assetId: state.stock.PCH_ALT,
            quantity: 4
        })
        // the original line takes no more than its 6 now
        const overIssue = run("pch_operator", P + "issue#ProductionMaterial", {
            operationKey: key(),
            workEffortId,
            productionRunLineId: rm2,
            assetId: state.stock.PCH_RM2,
            quantity: 7
        })
        state.substituteRun = workEffortId
        return {
            arbitrary,
            noRule,
            reader,
            outsider,
            tooMuch,
            before,
            requested,
            pendingDemand,
            recipients,
            listed,
            plannerApproves,
            approved,
            retried,
            substituteLine,
            original: one(LINE, {productionRunLineId: rm2}),
            issued,
            overIssue,
            rm2Demand: demand(workEffortId, "PCH_RM2"),
            altDemand: demand(workEffortId, "PCH_ALT"),
            change: one(CHANGE, {productionChangeId: requested.result?.productionChangeId})
        }
    },
    then(x) {
        x.arbitrary.error.includes("SUBSTITUTE_NOT_ALLOWED")
        x.noRule.error.includes("SUBSTITUTE_NOT_ALLOWED")
        x.reader.error.includes("PERMISSION_DENIED")
        x.outsider.error.includes("RECORD_UNAVAILABLE")
        x.tooMuch.error.includes("QUANTITY_EXCEEDS_REMAINING")
        x.requested.error === ""
        x.requested.result.resultCode === "REQUESTED"
        x.before === 10
        // nothing changes before the approval
        x.pendingDemand === 10
        x.recipients.includes("PCH_SUPER")
        !x.recipients.includes("PCH_PLANNER")
        x.listed.changeRows.length === 1
        x.listed.changeRows[0].canApprove === true
        x.listed.substituteRows.some(
            row => row.productId === "PCH_RM2" && row.candidates.some(option => option.value === "PCH_ALT")
        )
        x.plannerApproves.error.includes("PERMISSION_DENIED")
        x.approved.error === ""
        x.approved.result.resultCode === "APPLIED"
        x.approved.result.amendment === true
        x.retried.result.alreadyApplied === true
        x.retried.result.substituteRunLineId === x.approved.result.substituteRunLineId
        x.substituteLine.productId === "PCH_ALT"
        x.substituteLine.substituteOfLineId === x.original.productionRunLineId
        n(x.substituteLine.stockQuantity) === 4
        x.substituteLine.operationWorkEffortId === x.original.operationWorkEffortId
        n(x.original.stockQuantity) === 6
        x.rm2Demand === 6
        x.altDemand === 4
        x.issued.error === ""
        x.overIssue.error.includes("QUANTITY_EXCEEDS_REMAINING")
        x.change.statusId === "PchApplied"
        x.change.supervisorApprovedByUserId === "PCH_SUPER"
    }
})

feature("a supervisor's own substitute applies at once, and a refused one leaves the line as it was", {
    when() {
        const workEffortId = released(5)
        const rm2 = lineOf(workEffortId, "PCH_RM2").productionRunLineId
        const own = run("pch_super", P + "substitute#ProductionMaterial", {
            operationKey: key(),
            workEffortId,
            expectedRevision: revision(workEffortId),
            productionRunLineId: rm2,
            substituteProductId: "PCH_ALT",
            quantity: 2,
            reason: "Use the equivalent"
        })
        const asked = run("pch_planner", P + "substitute#ProductionMaterial", {
            operationKey: key(),
            workEffortId,
            expectedRevision: revision(workEffortId),
            productionRunLineId: rm2,
            substituteProductId: "PCH_ALT",
            quantity: 1,
            reason: "One more"
        })
        const noReason = run("pch_super", P + "substitute#ProductionMaterial", {
            operationKey: key(),
            workEffortId,
            action: "refuse",
            productionChangeId: asked.result?.productionChangeId
        })
        const refused = run("pch_super", P + "substitute#ProductionMaterial", {
            operationKey: key(),
            workEffortId,
            action: "refuse",
            productionChangeId: asked.result?.productionChangeId,
            refusalReason: "Keep the rest on RM2"
        })
        return {
            own,
            asked,
            noReason,
            refused,
            original: one(LINE, {productionRunLineId: rm2}),
            change: one(CHANGE, {productionChangeId: asked.result?.productionChangeId})
        }
    },
    then(x) {
        x.own.result.resultCode === "APPLIED"
        x.asked.result.resultCode === "REQUESTED"
        x.noReason.error.includes("REASON_REQUIRED")
        x.refused.result.resultCode === "REFUSED"
        n(x.original.stockQuantity) === 3
        x.change.statusId === "PchRefused"
        x.change.refusalReason === "Keep the rest on RM2"
    }
})

feature("with substituteApproval N a draft's substitute applies at once, while a released run's waits for a supervisor", {
    when() {
        const ask = workEffortId =>
            run("pch_planner", P + "substitute#ProductionMaterial", {
                operationKey: key(),
                workEffortId,
                expectedRevision: revision(workEffortId),
                productionRunLineId: lineOf(workEffortId, "PCH_RM2").productionRunLineId,
                substituteProductId: "PCH_ALT",
                quantity: 1,
                reason: "Use the equivalent"
            })
        const draft = run("pch_planner", P + "create#ProductionOrder", {
            operationKey: key(),
            organizationPartyId: org,
            productId: "PCH_FIN",
            quantity: 3,
            facilityId: freePlant
        })
        return {draft: ask(draft.workEffortId), releasedRun: ask(released(3, {facilityId: freePlant}))}
    },
    then(x) {
        x.draft.error === ""
        x.draft.result.resultCode === "APPLIED"
        x.releasedRun.error === ""
        x.releasedRun.result.resultCode === "REQUESTED"
    }
})

feature(
    "after the first operation an amendment to a later BOM release remaps the remaining work only; issued facts keep their lines",
    {
        when() {
            const workEffortId = released(5, {start: true})
            const rm1 = lineOf(workEffortId, "PCH_RM1"),
                rm2 = lineOf(workEffortId, "PCH_RM2")
            const issuance = issue(workEffortId, "PCH_RM1", 5)
            const [cut, assemble] = opsOf(workEffortId)
            call("update#" + WORK, {workEffortId: cut.workEffortId, statusId: "WeInProgress"})
            call("update#" + WORK, {workEffortId: cut.workEffortId, statusId: "WeComplete"})
            const noChange = run("pch_planner", P + "preview#ProductionAmendment", {workEffortId})
            // a later release of the BOM: two of each component
            tick()
            as("pch_method", () => {
                for (const bomItemId of [state.rm1Item, state.rm2Item])
                    call(B + "store#BomItem", {
                        bomItemId,
                        quantity: bomItemId === state.rm1Item ? 2 : 3,
                        changeReason: "Spec change"
                    })
                const detail = call(B + "get#BomDetail", {productBomId: state.bomId})
                call(B + "release#BomDraft", {
                    productBomId: state.bomId,
                    expectedRevision: detail.expectedRevision,
                    changeReason: "Spec second release"
                })
            })
            tick()
            const preview = run("pch_planner", P + "preview#ProductionAmendment", {workEffortId})
            const startRevision = revision(workEffortId)
            const requested = run("pch_planner", P + "amend#ProductionOrder", {
                operationKey: key(),
                workEffortId,
                expectedRevision: startRevision,
                methodDate: preview.methodDate,
                previewKey: preview.previewKey,
                reason: "Second BOM release"
            })
            const second = run("pch_planner", P + "amend#ProductionOrder", {
                operationKey: key(),
                workEffortId,
                expectedRevision: startRevision,
                reason: "Again"
            })
            const changeId = requested.result?.productionChangeId
            const approve = (username, operationKey = key()) =>
                run(username, P + "amend#ProductionOrder", {
                    operationKey,
                    workEffortId,
                    action: "approve",
                    productionChangeId: changeId
                })
            const methodNotices = rows("moqui.security.user.NotificationMessage", {
                topic: "ProductionAmendment",
                recordId: changeId
            })
            const supervisorFirst = approve("pch_super")
            const reader = approve("pch_reader")
            const methodReview = approve("pch_approver")
            const sameAgain = approve("pch_approver")
            const applyKey = key()
            const applied = approve("pch_super", applyKey)
            const retried = approve("pch_super", applyKey)
            return {
                noChange,
                preview,
                startRevision,
                requested,
                second,
                methodNotices,
                supervisorFirst,
                reader,
                methodReview,
                sameAgain,
                applied,
                retried,
                rm1After: one(LINE, {productionRunLineId: rm1.productionRunLineId}),
                rm2After: one(LINE, {productionRunLineId: rm2.productionRunLineId}),
                rm2Before: rm2,
                issuanceAfter: one(ISSUANCE, {assetIssuanceId: issuance.assetIssuanceId}),
                opsAfter: opsOf(workEffortId),
                cut,
                assemble,
                runAfter: one(WORK, {workEffortId}),
                rm2Demand: demand(workEffortId, "PCH_RM2"),
                rm1Demand: demand(workEffortId, "PCH_RM1"),
                change: one(CHANGE, {productionChangeId: changeId})
            }
        },
        then(x) {
            x.noChange.allowed === false
            x.noChange.reasonCode === "NO_CHANGE"
            x.preview.allowed === true
            x.preview.lineRows.some(row => row.productId === "PCH_RM1" && row.change === "kept")
            x.preview.lineRows.some(
                row => row.productId === "PCH_RM2" && row.change === "changed" && row.before === "5" && row.after === "15"
            )
            x.preview.operationRows.some(row => row.workEffortId === x.cut.workEffortId && row.change === "kept")
            x.preview.findings.some(row => row.code === "LINE_EXECUTED_KEPT")
            x.requested.error === ""
            x.requested.result.resultCode === "REQUESTED"
            x.requested.result.waitingFor === "method approval"
            x.second.error.includes("CHANGE_PENDING")
            x.methodNotices.length === 1
            // the supervisor reviews too, but the method approver's review is still needed
            x.supervisorFirst.error === ""
            x.supervisorFirst.result.resultCode === "REVIEWED"
            x.supervisorFirst.result.waitingFor === "method approval"
            x.reader.error.includes("PERMISSION_DENIED")
            x.methodReview.result.resultCode === "APPLIED"
            x.sameAgain.error.includes("CHANGE_DECIDED")
            // the issued line and its issuance keep their facts; the remaining line takes the later release's quantity
            n(x.rm1After.stockQuantity) === 5
            x.issuanceAfter.productionMaterialLineId === x.rm1After.productionRunLineId
            n(x.issuanceAfter.quantity) === 5
            n(x.rm2After.stockQuantity) === 15
            x.rm2After.bomItemId !== x.rm2Before.bomItemId
            x.rm2After.operationWorkEffortId === x.assemble.workEffortId
            x.rm2Demand === 15
            x.rm1Demand === 5
            x.opsAfter.find(op => op.workEffortId === x.cut.workEffortId).statusId === "WeComplete"
            x.opsAfter.find(op => op.workEffortId === x.assemble.workEffortId).statusId === "WeApproved"
            x.opsAfter.filter(op => op.statusId !== "WeCancelled").length === 2
            Number(x.runAfter.productionRevision) === x.startRevision + 1
            x.change.statusId === "PchApplied"
            x.change.methodApprovedByUserId === "PCH_APPROVER"
            x.change.supervisorApprovedByUserId === "PCH_SUPER"
        }
    }
)

feature("strict release refuses an amendment and a substitute of a released run", {
    when() {
        const workEffortId = released(3, {facilityId: strictPlant})
        tick()
        as("pch_method", () => {
            call(B + "store#BomItem", {
                bomItemId: lineOf(workEffortId, "PCH_RM2").bomItemId,
                quantity: 4,
                changeReason: "Spec strict change"
            })
            const detail = call(B + "get#BomDetail", {productBomId: state.bomId})
            call(B + "release#BomDraft", {
                productBomId: state.bomId,
                expectedRevision: detail.expectedRevision,
                changeReason: "Spec third release"
            })
        })
        tick()
        const preview = run("pch_planner", P + "preview#ProductionAmendment", {workEffortId})
        const amend = run("pch_planner", P + "amend#ProductionOrder", {
            operationKey: key(),
            workEffortId,
            expectedRevision: revision(workEffortId),
            reason: "Strict"
        })
        const substitute = run("pch_super", P + "substitute#ProductionMaterial", {
            operationKey: key(),
            workEffortId,
            expectedRevision: revision(workEffortId),
            productionRunLineId: lineOf(workEffortId, "PCH_RM2").productionRunLineId,
            substituteProductId: "PCH_ALT",
            quantity: 1,
            reason: "Strict"
        })
        return {preview, amend, substitute}
    },
    then(x) {
        x.preview.allowed === false
        x.preview.reasonCode === "STRICT_RELEASE"
        x.amend.error.includes("STRICT_RELEASE")
        x.substitute.error.includes("STRICT_RELEASE")
    }
})

feature("a split moves 4 of 10 remaining to a backorder on the same method date, and a retry answers the same runs", {
    when() {
        const workEffortId = released(10)
        call("create#mantle.request.requirement.Requirement", {requirementId: "PCH_REQ", productId: "PCH_FIN", quantity: 10})
        call("create#" + SUPPLY, {
            requirementId: "PCH_REQ",
            workEffortId,
            quantity: 10,
            quantityUomId: "OTH_ea",
            fromDate: ec.user.nowTimestamp
        })
        const source = one(WORK, {workEffortId})
        const readerPreview = run("pch_reader", P + "preview#ProductionSplit", {workEffortId, mode: "backorder", quantity: 4})
        const all = run("pch_planner", P + "preview#ProductionSplit", {workEffortId, mode: "split", quantity: 10})
        const preview = run("pch_planner", P + "preview#ProductionSplit", {workEffortId, mode: "backorder", quantity: 4})
        const splitKey = key()
        const confirm = operationKey =>
            run("pch_planner", P + "split#ProductionOrder", {
                operationKey,
                workEffortId,
                expectedRevision: source.productionRevision,
                mode: "backorder",
                quantity: 4,
                previewKey: preview.split?.previewKey,
                reason: "Customer takes 6 now"
            })
        const stale = run("pch_planner", P + "split#ProductionOrder", {
            operationKey: key(),
            workEffortId,
            expectedRevision: source.productionRevision,
            mode: "backorder",
            quantity: 3,
            previewKey: preview.split?.previewKey,
            reason: "Stale"
        })
        const done = confirm(splitKey)
        const retried = confirm(splitKey)
        const newId = done.result?.newWorkEffortId
        const links = rows(SUPPLY, {requirementId: "PCH_REQ"}).filter(row => row.thruDate == null)
        return {
            readerPreview,
            all,
            preview,
            stale,
            done,
            retried,
            source,
            backorder: one(WORK, {workEffortId: newId}),
            sourceOutput: outputOf(workEffortId),
            newOutput: outputOf(newId),
            sourceRm1: lineOf(workEffortId, "PCH_RM1"),
            newRm1: lineOf(newId, "PCH_RM1"),
            sourceDemand: demand(workEffortId, "PCH_RM1"),
            newDemand: demand(newId, "PCH_RM1"),
            newOps: opsOf(newId),
            links,
            event: rows("mantle.work.production.ProductionQuantityEvent", {
                workEffortId,
                quantityEventTypeEnumId: "PqetTargetChange"
            })
        }
    },
    then(x) {
        x.readerPreview.error.includes("PERMISSION_DENIED")
        x.all.error.includes("SPLIT_ALL")
        x.preview.split.quantity === "4"
        x.preview.split.sourceTarget === "6"
        x.preview.split.lineRows.some(row => row.productId === "PCH_RM1" && Number(row.moved) * 6 === Number(row.keep) * 4)
        x.preview.split.supplyRows.length === 1
        x.stale.error.includes("PREVIEW_CHANGED")
        x.done.error === ""
        x.done.result.resultCode === "BACKORDERED"
        x.retried.result.alreadyApplied === true
        x.retried.result.newWorkEffortId === x.done.result.newWorkEffortId
        // the backorder: the same method date and BOM, released with its own operations, linked to its source
        x.backorder.productBomId === x.source.productBomId
        Number(x.backorder.productionMethodDate) === Number(x.source.productionMethodDate)
        x.backorder.statusId === "WeApproved"
        x.backorder.productionSourceRunId === x.source.workEffortId
        x.backorder.productionSourceEnumId === "PsoBackorder"
        x.newOps.length === 2
        n(x.sourceOutput.stockQuantity) === 6
        n(x.newOutput.stockQuantity) === 4
        n(x.sourceRm1.stockQuantity) * 4 === n(x.newRm1.stockQuantity) * 6
        x.sourceDemand === n(x.sourceRm1.stockQuantity)
        x.newDemand === n(x.newRm1.stockQuantity)
        // the demand link is conserved: 6 on the source and 4 on the backorder
        x.links.length === 2
        x.links.reduce((total, row) => total + n(row.quantity), 0) === 10
        x.links.some(row => row.workEffortId === x.done.result.newWorkEffortId && n(row.quantity) === 4)
        x.event.length === 1
        n(x.event[0].targetQuantity) === 6
    }
})

feature("a backorder completes the running source with what it received; issued material stays with it", {
    when() {
        const workEffortId = released(10, {start: true})
        // six tenths of each line, what the 6 kept need
        const perTen = productId => n(lineOf(workEffortId, productId).stockQuantity)
        state.backorderRm2 = perTen("PCH_RM2")
        issue(workEffortId, "PCH_RM1", (perTen("PCH_RM1") * 6) / 10)
        issue(workEffortId, "PCH_RM2", (perTen("PCH_RM2") * 6) / 10)
        const good = run("pch_operator", P + "record#ProductionQuantity", {
            operationKey: key(),
            workEffortId,
            good: 6,
            facilityId: plant,
            toLocationSeqId: "PICK1"
        })
        const preview = run("pch_lead", P + "preview#ProductionSplit", {workEffortId, mode: "backorder", complete: true})
        const done = run("pch_lead", P + "split#ProductionOrder", {
            operationKey: key(),
            workEffortId,
            expectedRevision: revision(workEffortId),
            mode: "backorder",
            complete: true,
            previewKey: preview.split?.previewKey,
            reason: "Ship what is made"
        })
        return {
            good,
            preview,
            done,
            sourceAfter: one(WORK, {workEffortId}),
            newRm2: lineOf(done.result?.newWorkEffortId, "PCH_RM2")
        }
    },
    then(x) {
        x.good.error === ""
        x.preview.split.quantity === "4"
        x.preview.split.completeCheck.allowed === true
        x.done.error === ""
        x.done.result.completed === true
        x.sourceAfter.statusId === "WeComplete"
        n(x.newRm2.stockQuantity) === (state.backorderRm2 * 4) / 10
    }
})

feature("a run with postings is cancelled by a reversal or closed out by its residual plan, never deleted", {
    when() {
        const reversalId = released(4)
        issue(reversalId, "PCH_RM1", 3)
        const reversalPlan = run("pch_lead", P + "preview#ProductionCancellation", {workEffortId: reversalId})
        const plainCancel = act("pch_super", reversalId, "cancel", {reason: "Not needed"})
        const readerCancel = run("pch_reader", P + "cancel#ProductionOrder", {
            operationKey: key(),
            workEffortId: reversalId,
            expectedRevision: revision(reversalId),
            previewKey: reversalPlan.previewKey,
            reason: "Not needed"
        })
        const reversed = run("pch_lead", P + "cancel#ProductionOrder", {
            operationKey: key(),
            workEffortId: reversalId,
            expectedRevision: revision(reversalId),
            previewKey: reversalPlan.previewKey,
            reason: "Not needed"
        })
        const residualId = released(5, {start: true})
        issue(residualId, "PCH_RM1", n(lineOf(residualId, "PCH_RM1").stockQuantity))
        issue(residualId, "PCH_RM2", n(lineOf(residualId, "PCH_RM2").stockQuantity))
        run("pch_operator", P + "record#ProductionQuantity", {
            operationKey: key(),
            workEffortId: residualId,
            good: 2,
            facilityId: plant,
            toLocationSeqId: "PICK1"
        })
        const residualPlan = run("pch_lead", P + "preview#ProductionCancellation", {
            workEffortId: residualId,
            reason: "Order cancelled"
        })
        const closed = run("pch_lead", P + "cancel#ProductionOrder", {
            operationKey: key(),
            workEffortId: residualId,
            expectedRevision: revision(residualId),
            previewKey: residualPlan.previewKey,
            reason: "Order cancelled"
        })
        return {
            reversalPlan,
            plainCancel,
            readerCancel,
            reversed,
            reversalRun: one(WORK, {workEffortId: reversalId}),
            reversalIssuances: rows(ISSUANCE, {workEffortId: reversalId}),
            returns: rows("mantle.product.receipt.AssetReceipt", {workEffortId: reversalId}).filter(
                row => row.sourceAssetIssuanceId
            ),
            residualPlan,
            closed,
            residualRun: one(WORK, {workEffortId: residualId}),
            losses: rows("mantle.work.production.ProductionLoss", {workEffortId: residualId})
        }
    },
    then(x) {
        x.reversalPlan.mode === "reversal"
        x.reversalPlan.returnRows.length === 1
        x.plainCancel.error.includes("RUN_HAS_FACTS")
        x.readerCancel.error.includes("PERMISSION_DENIED")
        x.reversed.error === ""
        x.reversed.result.resultCode === "CANCELLED"
        x.reversalRun.statusId === "WeCancelled"
        // the issue stays as it was, its return is a new receipt fact
        x.reversalIssuances.length === 1
        n(x.reversalIssuances[0].quantity) === 3
        x.returns.length === 1
        n(x.returns[0].quantityAccepted) === 3
        x.residualPlan.mode === "residual"
        x.residualPlan.allowed === true
        x.closed.error === ""
        x.closed.result.resultCode === "CLOSED_OUT"
        x.residualRun.statusId === "WeComplete"
        x.losses.some(loss => loss.lossTypeEnumId === "PltProcessLoss" && n(loss.quantity) === 3)
    }
})

feature("a run whose only facts are a split's target change or an inspection, or that has started, is reversed here", {
    when() {
        const preview = workEffortId => run("pch_lead", P + "preview#ProductionCancellation", {workEffortId})
        const cancel = (workEffortId, plan) =>
            run("pch_lead", P + "cancel#ProductionOrder", {
                operationKey: key(),
                workEffortId,
                expectedRevision: revision(workEffortId),
                previewKey: plan.previewKey,
                reason: "Not needed"
            })
        // a split's source: its target change is a fact the lifecycle's cancel refuses
        const splitId = released(5)
        const splitPreview = run("pch_planner", P + "preview#ProductionSplit", {workEffortId: splitId, quantity: 2})
        const splitDone = run("pch_planner", P + "split#ProductionOrder", {
            operationKey: key(),
            workEffortId: splitId,
            expectedRevision: revision(splitId),
            quantity: 2,
            previewKey: splitPreview.split?.previewKey,
            reason: "Two later"
        })
        const splitLifecycle = act("pch_super", splitId, "cancel", {reason: "Not needed"})
        const splitPlan = preview(splitId)
        const splitCancelled = cancel(splitId, splitPlan)
        // a P8 inspection of the run
        const inspectedId = released(3)
        call("create#mantle.product.quality.QualityInspection", {
            organizationPartyId: org,
            facilityId: plant,
            statusId: "QiDraft",
            inspectionContextEnumId: "QicProduction",
            workEffortId: inspectedId,
            productId: "PCH_FIN",
            quantity: 1
        })
        const inspectedLifecycle = act("pch_super", inspectedId, "cancel", {reason: "Not needed"})
        const inspectedPlan = preview(inspectedId)
        const inspectedCancelled = cancel(inspectedId, inspectedPlan)
        // started with no fact: the lifecycle refuses it (RUN_STARTED), the reversal cancels it
        const startedId = released(3, {start: true})
        const startedPlan = preview(startedId)
        const startedCancelled = cancel(startedId, startedPlan)
        // a released run with no fact still goes to the lifecycle
        const plainPlan = preview(released(3))
        return {
            splitDone,
            splitLifecycle,
            splitPlan,
            splitCancelled,
            inspectedLifecycle,
            inspectedPlan,
            inspectedCancelled,
            startedPlan,
            startedCancelled,
            plainPlan,
            statuses: [splitId, inspectedId, startedId].map(workEffortId => one(WORK, {workEffortId}).statusId)
        }
    },
    then(x) {
        x.splitDone.error === ""
        x.splitLifecycle.error.includes("RUN_HAS_FACTS")
        x.splitPlan.allowed === true
        x.splitPlan.mode === "reversal"
        x.splitCancelled.error === ""
        x.inspectedLifecycle.error.includes("RUN_HAS_FACTS")
        x.inspectedPlan.allowed === true
        x.inspectedPlan.facts.inspections === 1
        x.inspectedCancelled.error === ""
        x.startedPlan.allowed === true
        x.startedCancelled.error === ""
        x.statuses.every(statusId => statusId === "WeCancelled")
        x.plainPlan.allowed === false
        x.plainPlan.reasonCode === "NO_FACTS"
    }
})

feature("a clone is a new draft through create#ProductionOrder with no postings", {
    when() {
        const workEffortId = state.substituteRun
        const cloneKey = key()
        const cloned = run("pch_planner", P + "clone#ProductionOrder", {operationKey: cloneKey, workEffortId})
        const again = run("pch_planner", P + "clone#ProductionOrder", {operationKey: cloneKey, workEffortId})
        const reader = run("pch_reader", P + "clone#ProductionOrder", {operationKey: key(), workEffortId})
        const newId = cloned.result?.workEffortId
        return {
            cloned,
            again,
            reader,
            copy: one(WORK, {workEffortId: newId}),
            lines: rows(LINE, {workEffortId: newId}),
            issuances: rows(ISSUANCE, {workEffortId: newId})
        }
    },
    then(x) {
        x.cloned.error === ""
        x.cloned.result.resultCode === "CLONED"
        x.again.result.workEffortId === x.cloned.result.workEffortId
        x.reader.error.includes("PERMISSION_DENIED")
        x.copy.statusId === "WeInPlanning"
        x.copy.productionSourceEnumId === "PsoClone"
        // the method's lines (the substitute is not copied), no posting
        x.lines.length === 3
        !x.lines.some(line => line.productId === "PCH_ALT")
        x.issuances.length === 0
    }
})
