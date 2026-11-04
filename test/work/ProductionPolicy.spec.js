// The production policy and reason codes (impl-manufacturing P4, design-manufacturing ProductionSettings and ReasonCodes):
// an organization default and a plant override of the overproduction tolerance resolve with each value's source; a change
// is a dated row that ends the one before, refused when stale, back-dated or without PRODUCTION_POLICY_EDIT; a run reads
// the policy as of its release; the issue guard admits an issue within the over-consumption tolerance of the policy the
// run was released under and refuses one beyond it, and with no policy keeps refusing anything past the line's
// remainder; reason codes are dated, changed and deactivated, never deleted. The users are in spec-local groups.
const P = "mantle.work.ProductionServices.",
    B = "mantle.product.BomServices.",
    R = "mantle.work.RoutingServices."
const org = "PPL_ORG",
    other = "PPL_OTHER",
    plant = "PPL_PLANT",
    line = "PPL_LINE"
const find = (entity, conditions = {}) => ec.entity.find(entity).condition(conditions).disableAuthz()
const one = (entity, conditions) => find(entity, conditions).one()
const rows = (entity, conditions) => Array.from(find(entity, conditions).list())
const n = value => (value == null ? 0 : Number(String(value)))
const since = "2000-01-01T00:00:00Z"
const state = {}
let keySeq = 0
const key = () => "ppl-op-" + ++keySeq
// the clock moves on, so what is stored next starts after what was read before it
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
const traceOf = (resolved, field) => (resolved.traceRows || []).find(row => row.field === field) || {}
// a released run of 10 PPL_FIN at the plant, its material line of 10 PPL_RM, and the stock to issue from
function releasedRun() {
    const created = run("ppl_planner", P + "create#ProductionOrder", {
        operationKey: key(),
        organizationPartyId: org,
        productId: "PPL_FIN",
        quantity: 10,
        facilityId: plant
    })
    const released = run("ppl_planner", P + "release#ProductionOrder", {
        operationKey: key(),
        workEffortId: created.workEffortId,
        expectedRevision: 1
    })
    if (released.error) throw new Error("Release failed: " + released.error)
    const material = rows("mantle.work.production.ProductionRunLine", {workEffortId: created.workEffortId}).find(
        row => row.productId === "PPL_RM"
    )
    return {workEffortId: created.workEffortId, lineId: material.productionRunLineId}
}
const issue = (workEffortId, productionRunLineId, quantity) =>
    run("ppl_issuer", P + "issue#ProductionMaterial", {
        operationKey: key(),
        workEffortId,
        productionRunLineId,
        assetId: state.stock,
        quantity
    })

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
        user("PPL_ADMIN", ["PRODUCTION_POLICY_EDIT", "PRODUCTION_VIEW"])
        user("PPL_READER", ["PRODUCTION_VIEW"])
        user("PPL_METHOD", ["METHOD_VIEW", "METHOD_EDIT", "METHOD_APPROVE", "METHOD_RESOURCES"])
        user("PPL_PLANNER", ["PRODUCTION_PLAN", "PRODUCTION_VIEW", "METHOD_VIEW"])
        user("PPL_ISSUER", ["STOCK_ISSUE"])
        user("PPL_OUTSIDER", ["PRODUCTION_POLICY_EDIT", "PRODUCTION_VIEW"], other)
        call("create#mantle.facility.Facility", {
            facilityId: plant,
            facilityTypeEnumId: "FcTpWarehouse",
            facilityName: "Policy plant",
            ownerPartyId: org
        })
        call("create#mantle.facility.Facility", {
            facilityId: line,
            facilityTypeEnumId: "FcTpLine",
            facilityName: "Policy line",
            parentFacilityId: plant,
            ownerPartyId: org
        })
        call("create#mantle.facility.FacilityLocation", {
            facilityId: plant,
            locationSeqId: "PICK1",
            locationTypeEnumId: "FltPick"
        })
        for (const productId of ["PPL_FIN", "PPL_RM"])
            call("create#mantle.product.Product", {
                productId,
                productName: productId,
                productTypeEnumId: "PtAsset",
                assetTypeEnumId: "AstTpInventory",
                amountUomId: "OTH_ea",
                ownerPartyId: org
            })
        ec.artifactExecution.enableAuthz()
        // the method: one operation consuming one PPL_RM per PPL_FIN
        as("ppl_method", () => {
            call(R + "store#WorkCenter", {organizationPartyId: org, facilityId: plant, changeReason: "Spec work center"})
            const route = call(R + "store#Routing", {
                organizationPartyId: org,
                workEffortName: "Policy routing",
                changeReason: "Spec"
            })
            const routeId = route.routing.workEffortId
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
            const bom = call(B + "store#Bom", {
                productId: "PPL_FIN",
                organizationPartyId: org,
                routingWorkEffortId: routeId,
                changeReason: "Spec method"
            })
            const productBomId = bom.productBom.productBomId
            call(B + "store#BomItem", {
                productBomId,
                productId: "PPL_RM",
                quantity: 1,
                operationWorkEffortId: operationId,
                changeReason: "Spec line"
            })
            const detail = call(B + "get#BomDetail", {productBomId})
            call(B + "release#BomDraft", {productBomId, expectedRevision: detail.expectedRevision, changeReason: "Spec release"})
        })
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        state.stock = call("mantle.product.AssetServices.receive#Asset", {
            productId: "PPL_RM",
            quantity: 100,
            facilityId: plant,
            locationSeqId: "PICK1",
            ownerPartyId: org,
            assetTypeEnumId: "AstTpInventory",
            statusId: "AstAvailable",
            acquireCost: 2
        }).assetId
        call("update#mantle.product.asset.Asset", {assetId: state.stock, acquireCostUomId: "USD"})
        ec.artifactExecution.enableAuthz()
        // a run released before the organization has any policy: Mantle's default issue guard
        state.before = releasedRun()
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

feature("with no policy every value is the built-in default, the flags off, and the trace names it", {
    when() {
        return run("ppl_reader", P + "get#ProductionPolicy", {organizationPartyId: org, facilityId: plant})
    },
    then(resolved) {
        resolved.error == ""
        resolved.policy.consumptionMethodEnumId == "PcmManual"
        n(resolved.policy.overConsumePercent) == 0
        resolved.policy.completeOnFinalReceipt == "N"
        resolved.policy.strictRelease == "N"
        resolved.policy.laborCostSync == "N"
        resolved.policy.shortageReleaseEnumId == "PsrAllUsable"
        traceOf(resolved, "overProducePercent").sourceText == "Built-in default"
        resolved.history.length == 0
        resolved.canEdit == false
    }
})

feature("an organization default and a plant override of the overproduction tolerance resolve with each value's source", {
    when() {
        const organization = run("ppl_admin", P + "store#ProductionPolicy", {
            organizationPartyId: org,
            overProducePercent: 5,
            overConsumePercent: 10,
            planningHorizonDays: 60,
            changeReason: "Organization default"
        })
        const plantRow = run("ppl_admin", P + "store#ProductionPolicy", {
            facilityId: plant,
            overProducePercent: 8,
            changeReason: "Plant override"
        })
        // a second change at the plant names only another field: the first override is kept
        tick()
        const plantInEffect = run("ppl_admin", P + "get#ProductionPolicy", {facilityId: plant})
        const plantAgain = run("ppl_admin", P + "store#ProductionPolicy", {
            facilityId: plant,
            expectedFromDate: plantInEffect.expectedFromDate,
            strictRelease: "Y",
            changeReason: "Strict at the plant"
        })
        const atPlant = run("ppl_reader", P + "get#ProductionPolicy", {facilityId: plant})
        const atLine = run("ppl_reader", P + "get#ProductionPolicy", {facilityId: line})
        const atOrganization = run("ppl_reader", P + "get#ProductionPolicy", {organizationPartyId: org})
        return {organization, plantRow, plantAgain, atPlant, atLine, atOrganization}
    },
    then({organization, plantRow, plantAgain, atPlant, atLine, atOrganization}) {
        organization.error == ""
        plantRow.error == ""
        plantAgain.error == ""
        n(atPlant.policy.overProducePercent) == 8
        traceOf(atPlant, "overProducePercent").level == "facility"
        traceOf(atPlant, "overProducePercent").sourceText == "Plant override: Policy plant"
        traceOf(atPlant, "overProducePercent").changeReason == "Strict at the plant"
        atPlant.policy.strictRelease == "Y"
        n(atPlant.policy.overConsumePercent) == 10
        traceOf(atPlant, "overConsumePercent").sourceText == "Organization default"
        n(atPlant.policy.planningHorizonDays) == 60
        traceOf(atPlant, "consumptionMethodEnumId").sourceText == "Built-in default"
        traceOf(atPlant, "overProducePercent").valueText == "8%"
        // the plant's history: two dated rows, the first ended where the second starts
        atPlant.history.length == 2
        atPlant.history[1].thruDate != null
        atPlant.history[0].inEffect == true
        // a line under the plant inherits the plant's override; the organization reads its own default
        n(atLine.policy.overProducePercent) == 8
        n(atOrganization.policy.overProducePercent) == 5
        atOrganization.policy.strictRelease == "N"
        traceOf(atOrganization, "overProducePercent").level == "organization"
    }
})

feature("a stale, back-dated, invalid or unpermitted change is refused, and another organization is out of reach", {
    when() {
        const inEffect = run("ppl_admin", P + "get#ProductionPolicy", {organizationPartyId: org})
        const parameters = {
            organizationPartyId: org,
            expectedFromDate: inEffect.expectedFromDate,
            overProducePercent: 6,
            changeReason: "Spec"
        }
        const reader = run("ppl_reader", P + "store#ProductionPolicy", parameters)
        const outsider = run("ppl_outsider", P + "store#ProductionPolicy", parameters)
        const outsiderRead = run("ppl_outsider", P + "get#ProductionPolicy", {organizationPartyId: org})
        const issuerRead = run("ppl_issuer", P + "get#ProductionPolicy", {organizationPartyId: org})
        const stale = run("ppl_admin", P + "store#ProductionPolicy", Object.assign({}, parameters, {expectedFromDate: null}))
        const backDated = run("ppl_admin", P + "store#ProductionPolicy", Object.assign({}, parameters, {fromDate: since}))
        const percent = run("ppl_admin", P + "store#ProductionPolicy", Object.assign({}, parameters, {overProducePercent: 150}))
        const choice = run(
            "ppl_admin",
            P + "store#ProductionPolicy",
            Object.assign({}, parameters, {shortageReleaseEnumId: "PcmManual"})
        )
        const after = run("ppl_admin", P + "get#ProductionPolicy", {organizationPartyId: org})
        return {reader, outsider, outsiderRead, issuerRead, stale, backDated, percent, choice, after}
    },
    then({reader, outsider, outsiderRead, issuerRead, stale, backDated, percent, choice, after}) {
        reader.error.includes("PERMISSION_DENIED")
        outsider.error.includes("RECORD_UNAVAILABLE")
        outsiderRead.error.includes("RECORD_UNAVAILABLE")
        issuerRead.error.includes("PERMISSION_DENIED")
        stale.error.includes("POLICY_CHANGED")
        backDated.error.includes("POLICY_INVALID")
        percent.error.includes("POLICY_INVALID")
        choice.error.includes("POLICY_INVALID")
        n(after.policy.overProducePercent) == 5
        after.history.length == 1
    }
})

feature("a change of one form's group leaves the other groups' fields as they were", {
    when() {
        const inEffect = run("ppl_admin", P + "get#ProductionPolicy", {organizationPartyId: org})
        run("ppl_admin", P + "store#ProductionPolicy", {
            organizationPartyId: org,
            expectedFromDate: inEffect.expectedFromDate,
            policyGroup: "planning",
            planningHorizonDays: 45,
            overConsumePercent: null,
            overProducePercent: null,
            changeReason: "Planning only"
        })
        return run("ppl_reader", P + "get#ProductionPolicy", {organizationPartyId: org})
    },
    then(after) {
        n(after.policy.planningHorizonDays) == 45
        n(after.policy.overConsumePercent) == 10
        n(after.policy.overProducePercent) == 5
        after.history.length == 2
    }
})

feature("an issue within the over-consumption tolerance passes and one beyond it is refused; with no policy, the remainder", {
    when() {
        // released after the 10% organization default: 10 to issue and 1 of scrap allowance
        const within = releasedRun()
        const full = issue(within.workEffortId, within.lineId, 10)
        const allowance = issue(within.workEffortId, within.lineId, 1)
        const beyond = issue(within.workEffortId, within.lineId, 0.5)
        // released before any policy: nothing past the line's 10
        const exact = issue(state.before.workEffortId, state.before.lineId, 10)
        const none = issue(state.before.workEffortId, state.before.lineId, 0.5)
        return {full, allowance, beyond, exact, none}
    },
    then({full, allowance, beyond, exact, none}) {
        full.error == ""
        allowance.error == ""
        allowance.result.resultCode == "ISSUED"
        beyond.error.includes("QUANTITY_EXCEEDS_REMAINING")
        beyond.error.includes("scrap allowance of 1")
        exact.error == ""
        none.error.includes("QUANTITY_EXCEEDS_REMAINING")
        !none.error.includes("scrap allowance")
    }
})

feature("a run keeps the policy of its release: a later change reaches neither its read nor its issue guard", {
    when() {
        const released = releasedRun()
        tick()
        const inEffect = run("ppl_admin", P + "get#ProductionPolicy", {organizationPartyId: org})
        const raised = run("ppl_admin", P + "store#ProductionPolicy", {
            organizationPartyId: org,
            expectedFromDate: inEffect.expectedFromDate,
            overConsumePercent: 50,
            changeReason: "More scrap allowed"
        })
        const ofRun = run("ppl_reader", P + "get#ProductionPolicy", {workEffortId: released.workEffortId})
        const now = run("ppl_reader", P + "get#ProductionPolicy", {organizationPartyId: org})
        const issued = issue(released.workEffortId, released.lineId, 11)
        const beyond = issue(released.workEffortId, released.lineId, 1)
        // a run released after the change takes it
        const later = releasedRun()
        const laterIssue = issue(later.workEffortId, later.lineId, 15)
        return {raised, ofRun, now, issued, beyond, laterIssue}
    },
    then({raised, ofRun, now, issued, beyond, laterIssue}) {
        raised.error == ""
        ofRun.error == ""
        n(ofRun.policy.overConsumePercent) == 10
        n(now.policy.overConsumePercent) == 50
        issued.error == ""
        beyond.error.includes("QUANTITY_EXCEEDS_REMAINING")
        laterIssue.error == ""
    }
})

feature("reason codes are added, changed by dated rows and deactivated, never deleted; a refused row leaves the others", {
    when() {
        const added = run("ppl_admin", P + "store#ProductionReasons", {
            organizationPartyId: org,
            changeReason: "First reasons",
            reasons: [
                {reasonCode: "JAM", reasonName: "Feeder jam", reasonCategoryEnumId: "PrcDowntime", equipmentFault: "Y"},
                {reasonCode: "SETUP", reasonName: "Changeover", reasonCategoryEnumId: "PrcDowntime", plannedStop: "Y"},
                {reasonCode: "BAD CODE", reasonName: "Spaces", reasonCategoryEnumId: "PrcScrap"},
                {reasonCode: "NOCAT", reasonName: "No category"}
            ]
        })
        tick()
        const listed = run("ppl_reader", P + "find#ProductionReasons", {organizationPartyId: org})
        const jam = listed.reasons.find(row => row.reasonCode === "JAM")
        const changed = run("ppl_admin", P + "store#ProductionReasons", {
            organizationPartyId: org,
            changeReason: "Threshold",
            reasons: [{reasonCode: "JAM", expectedFromDate: jam.expectedFromDate, approvalThreshold: 30}]
        })
        const stale = run("ppl_admin", P + "store#ProductionReasons", {
            organizationPartyId: org,
            changeReason: "Stale",
            reasons: [{reasonCode: "JAM", expectedFromDate: jam.expectedFromDate, approvalThreshold: 40}]
        })
        tick()
        const deactivated = run("ppl_admin", P + "store#ProductionReasons", {
            organizationPartyId: org,
            changeReason: "No longer used",
            reasons: [{reasonCode: "SETUP", active: "N"}]
        })
        const again = run("ppl_admin", P + "store#ProductionReasons", {
            organizationPartyId: org,
            changeReason: "Again",
            reasons: [{reasonCode: "SETUP", active: "N"}]
        })
        const reader = run("ppl_reader", P + "store#ProductionReasons", {
            organizationPartyId: org,
            changeReason: "Reader",
            reasons: [{reasonCode: "READ", reasonName: "Reader", reasonCategoryEnumId: "PrcHold"}]
        })
        const active = run("ppl_reader", P + "find#ProductionReasons", {organizationPartyId: org})
        const all = run("ppl_reader", P + "find#ProductionReasons", {
            organizationPartyId: org,
            includeInactive: true,
            reasonCode: "JAM"
        })
        return {added, changed, stale, deactivated, again, reader, active, all}
    },
    then({added, changed, stale, deactivated, again, reader, active, all}) {
        added.error == ""
        added.results.filter(row => row.resultCode === "STORED").length == 2
        added.results.find(row => row.reasonCode === "BAD CODE").errorCode == "REASON_INVALID"
        added.results.find(row => row.reasonCode === "NOCAT").errorCode == "REASON_INVALID"
        changed.error == ""
        changed.results[0].resultCode == "CHANGED"
        stale.error.includes("REASON_CHANGED")
        deactivated.results[0].resultCode == "DEACTIVATED"
        again.error.includes("REASON_INACTIVE")
        reader.error.includes("PERMISSION_DENIED")
        // the active list leaves SETUP out; the full list keeps it, inactive, with its rows
        active.reasons.map(row => row.reasonCode).join(",") == "JAM"
        n(active.reasons[0].approvalThreshold) == 30
        active.reasons[0].equipmentFault == "Y"
        active.reasons[0].reasonName == "Feeder jam"
        all.reasons.find(row => row.reasonCode === "SETUP").active == false
        all.reasons.find(row => row.reasonCode === "SETUP").activeText == "Inactive"
        all.history.length == 2
        rows("mantle.work.production.ProductionReason", {organizationPartyId: org, reasonCode: "SETUP"}).length == 1
        rows("mantle.work.production.ProductionReason", {organizationPartyId: org, reasonCode: "SETUP"})[0].thruDate != null
    }
})
