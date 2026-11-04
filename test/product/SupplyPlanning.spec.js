// The shared supply plan (impl-manufacturing P13, design-crosscut CX-PLANNING and §3.20, design-manufacturing §10.3's
// shortage to finished stock): a sales demand for a made product yields a make suggestion dated by its BOM's lead and
// preparation days, a make suggestion for its non-phantom sub-assembly netted against its own stock, and buy suggestions for
// the components, a phantom's blown through; a kit's sales demand counts as its components' and a kit assembly run is shown
// and not netted; held stock is a pending-release line, netted only by the schedule's option within the lead time; an
// obsolete product and one with no source are exceptions; converting the make suggestion creates a draft run with its lines,
// RequirementSupply and WrfDelivers, a second conversion answers that run, a buy suggestion is the buyer's (Replenishment.spec), and a
// superseded plan is refused; a run nets the draft run on its line; a second facility's surplus is a transfer; and the
// permissions and the organization are checked. The users are in spec-local groups.
const S = "mantle.product.SupplyPlanningServices.",
    B = "mantle.product.BomServices.",
    R = "mantle.work.RoutingServices."
const org = "SPL_ORG",
    other = "SPL_OTHER",
    warehouse = "SPL_WH",
    line = "SPL_LINE",
    second = "SPL_WH2",
    supplier = "SPL_SUPPLIER",
    customer = "SPL_CUSTOMER"
const find = (entity, conditions = {}) => ec.entity.find(entity).condition(conditions).disableAuthz()
const one = (entity, conditions) => find(entity, conditions).one()
const rows = (entity, conditions) => Array.from(find(entity, conditions).list())
const n = value => (value == null ? 0 : Number(String(value)))
const since = "2000-01-01T00:00:00Z"
const dayMs = 86400000
const msOf = value => (/^-?\d+$/.test(String(value)) ? Number(value) : Date.parse(String(value)))
const state = {}
let keySeq = 0
const key = () => "spl-op-" + ++keySeq

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
function receive(productId, quantity, facilityId = warehouse, statusId = "AstAvailable") {
    return call("create#mantle.product.asset.Asset", {
        productId,
        facilityId,
        ownerPartyId: org,
        assetTypeEnumId: "AstTpInventory",
        statusId,
        hasQuantity: "Y",
        quantityOnHandTotal: quantity,
        availableToPromiseTotal: statusId === "AstAvailable" ? quantity : 0
    }).assetId
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
function salesOrder(orderId, productId, quantity, requiredByDate) {
    call("create#mantle.order.OrderHeader", {orderId, statusId: "OrderApproved", currencyUomId: "USD"})
    call("create#mantle.order.OrderPart", {
        orderId,
        orderPartSeqId: "01",
        vendorPartyId: org,
        customerPartyId: customer,
        facilityId: warehouse,
        statusId: "OrderApproved"
    })
    call("create#mantle.order.OrderItem", {
        orderId,
        orderPartSeqId: "01",
        orderItemSeqId: "01",
        productId,
        quantity,
        unitAmount: 10,
        requiredByDate
    })
}
const plan = (username, parameters = {}) =>
    run(username, S + "run#SupplyPlan", Object.assign({organizationPartyId: org, facilityIds: [warehouse]}, parameters))
const read = (username, parameters = {}) =>
    run(username, S + "get#SupplyPlan", Object.assign({organizationPartyId: org, facilityIds: [warehouse]}, parameters))
const byProduct = (answer, productId, methodEnumId) =>
    (answer.suggestions || []).find(row => row.productId === productId && (!methodEnumId || row.methodEnumId === methodEnumId)) ||
    {}

spec({
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        for (const partyId of [org, other]) {
            call("create#mantle.party.Party", {partyId, partyTypeEnumId: "PtyOrganization"})
            call("create#mantle.party.Organization", {partyId, organizationName: partyId})
            call("create#mantle.party.PartyRole", {partyId, roleTypeId: "OrgInternal"})
        }
        for (const [partyId, roleTypeId] of [
            [supplier, "Supplier"],
            [customer, "Customer"]
        ]) {
            call("create#mantle.party.Party", {partyId, partyTypeEnumId: "PtyOrganization"})
            call("create#mantle.party.Organization", {partyId, organizationName: partyId})
            call("create#mantle.party.PartyRole", {partyId, roleTypeId})
        }
        user("SPL_METHOD", ["METHOD_VIEW", "METHOD_EDIT", "METHOD_APPROVE", "METHOD_RESOURCES"])
        user("SPL_PLANNER", ["SUPPLY_PLAN_RUN", "PRODUCTION_PLAN", "PRODUCTION_VIEW", "METHOD_VIEW"])
        user("SPL_RUNNER", ["SUPPLY_PLAN_RUN", "METHOD_VIEW"])
        user("SPL_NOMETHOD", ["SUPPLY_PLAN_RUN"])
        user("SPL_READER", ["PRODUCTION_VIEW"])
        user("SPL_NONE", ["STOCK_ISSUE"])
        user("SPL_OUTSIDER", ["SUPPLY_PLAN_RUN", "PRODUCTION_PLAN", "PRODUCTION_VIEW", "METHOD_VIEW"], other)
        for (const facilityId of [warehouse, second])
            call("create#mantle.facility.Facility", {facilityId, facilityTypeEnumId: "FcTpWarehouse", ownerPartyId: org})
        call("create#mantle.facility.Facility", {
            facilityId: line,
            facilityTypeEnumId: "FcTpLine",
            ownerPartyId: org,
            parentFacilityId: warehouse
        })
        for (const productId of ["SPL_FIN", "SPL_SUB", "SPL_PH", "SPL_RM_A", "SPL_RM_C", "SPL_RM_D", "SPL_OBS", "SPL_NOSRC"])
            call("create#mantle.product.Product", {
                productId,
                productName: productId,
                productTypeEnumId: "PtAsset",
                assetTypeEnumId: "AstTpInventory",
                amountUomId: "OTH_ea",
                ownerPartyId: org,
                statusId: productId === "SPL_OBS" ? "PrdObsolete" : "PrdActive"
            })
        call("create#mantle.product.Product", {
            productId: "SPL_KIT",
            productName: "Spec kit",
            productTypeEnumId: "PtPickAssembly",
            ownerPartyId: org
        })
        call("create#mantle.product.ProductAssoc", {
            productId: "SPL_KIT",
            toProductId: "SPL_RM_A",
            productAssocTypeEnumId: "PatMfgBom",
            fromDate: since,
            quantity: 1
        })
        for (const productId of ["SPL_RM_A", "SPL_RM_C", "SPL_RM_D", "SPL_OBS"])
            call("create#mantle.product.ProductPrice", {
                productId,
                vendorPartyId: supplier,
                pricePurposeEnumId: "PppPurchase",
                priceTypeEnumId: "PptCurrent",
                fromDate: since,
                price: 1,
                priceUomId: "USD"
            })
        ec.artifactExecution.enableAuthz()
        // the methods: SPL_FIN of a raw material, a phantom and a sub-assembly that has its own BOM, on a routing at the line
        as("spl_method", () => {
            call(R + "store#WorkCenter", {
                organizationPartyId: org,
                facilityId: line,
                efficiencyPercent: 100,
                changeReason: "Spec"
            })
            const route = call(R + "store#Routing", {
                organizationPartyId: org,
                workEffortName: "Spec finish",
                changeReason: "Spec"
            })
            const routeId = route.routing.workEffortId
            call(R + "store#RoutingOperation", {
                workEffortId: routeId,
                workEffortName: "Assemble",
                sequenceNum: 10,
                estimatedWorkTime: 6,
                timeUomId: "TF_min",
                methodBatchQuantity: 1,
                methodQuantityUomId: "OTH_ea",
                methodWorkCenterId: line,
                changeReason: "Spec operation"
            })
            const detail = call(R + "get#RoutingDetail", {workEffortId: routeId})
            call(R + "release#RoutingDraft", {
                workEffortId: routeId,
                expectedRevision: detail.expectedRevision,
                changeReason: "Spec"
            })
            bom("SPL_SUB", [{productId: "SPL_RM_D", quantity: 2}], {leadTimeDays: 2})
            bom("SPL_PH", [{productId: "SPL_RM_C", quantity: 3}], {isPhantom: "Y"})
            state.finBom = bom(
                "SPL_FIN",
                [
                    {productId: "SPL_RM_A", quantity: 2},
                    {productId: "SPL_PH", quantity: 1},
                    {productId: "SPL_SUB", quantity: 1}
                ],
                {routingWorkEffortId: routeId, leadTimeDays: 3, prepareDays: 1}
            )
        })
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        state.requiredMs = Date.now() + 10 * dayMs
        salesOrder("SPL_SO_FIN", "SPL_FIN", 5, new Date(state.requiredMs))
        salesOrder("SPL_SO_KIT", "SPL_KIT", 2, new Date(state.requiredMs))
        salesOrder("SPL_SO_OBS", "SPL_OBS", 1, new Date(state.requiredMs))
        salesOrder("SPL_SO_NOSRC", "SPL_NOSRC", 1, new Date(state.requiredMs))
        receive("SPL_SUB", 1)
        receive("SPL_RM_A", 3)
        receive("SPL_RM_C", 20, second)
        // two of the sub-assembly held for an inspection due tomorrow
        const held = receive("SPL_SUB", 2, warehouse, "AstQuarantine")
        call("create#mantle.product.quality.QualityInspection", {
            organizationPartyId: org,
            facilityId: warehouse,
            statusId: "QiDraft",
            productId: "SPL_SUB",
            assetId: held,
            quantity: 2,
            heldQuantity: 2,
            dueDate: new Date(Date.now() + dayMs)
        })
        // a kit assembly run consuming the raw material: shown, not netted
        call("create#mantle.work.effort.WorkEffort", {
            workEffortId: "SPL_KIT_RUN",
            workEffortTypeEnumId: "WetTask",
            purposeEnumId: "WepPickAssembly",
            statusId: "WeInProgress",
            facilityId: warehouse,
            ownerPartyId: org
        })
        call("create#mantle.work.effort.WorkEffortProduct", {
            workEffortId: "SPL_KIT_RUN",
            productId: "SPL_RM_A",
            typeEnumId: "WeptConsume",
            fromDate: since,
            estimatedQuantity: 50
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

feature("a sales demand yields a make suggestion, the sub-assembly netted against its stock, and buys for the components", {
    when() {
        const ran = plan("spl_planner")
        const answer = read("spl_planner")
        state.firstRunId = ran.planningRunId
        state.answer = answer
        const fin = byProduct(answer, "SPL_FIN")
        state.finSuggestionId = fin.planningSuggestionId
        state.subSuggestionId = byProduct(answer, "SPL_SUB").planningSuggestionId
        state.buySuggestionId = byProduct(answer, "SPL_RM_A").planningSuggestionId
        const requirement = one("mantle.request.requirement.Requirement", {requirementId: fin.requirementId})
        const party = rows("mantle.request.requirement.RequirementParty", {requirementId: fin.requirementId})
        const orderItems = rows("mantle.request.requirement.RequirementOrderItem", {requirementId: fin.requirementId})
        return {ran, answer, fin, requirement, party, orderItems}
    },
    then({ran, answer, fin, requirement, party, orderItems}) {
        ran.error == ""
        answer.run.isCurrent == true
        answer.run.stale == false
        fin.methodEnumId == "PsmMake"
        fin.quantity == "5"
        fin.planningLevel == 0
        fin.productBomId == state.finBom
        // the required date less 3 lead and 1 preparation days
        Math.round((state.requiredMs - msOf(fin.releaseDate)) / dayMs) == 4
        byProduct(answer, "SPL_SUB").methodEnumId == "PsmMake"
        byProduct(answer, "SPL_SUB").quantity == "4"
        byProduct(answer, "SPL_SUB").planningLevel == 1
        byProduct(answer, "SPL_SUB").pendingReleaseQuantity == "2"
        // 5 × 2 for the make and 2 for the kit, less 3 on hand; the kit assembly run's 50 is not netted
        byProduct(answer, "SPL_RM_A").methodEnumId == "PsmBuy"
        byProduct(answer, "SPL_RM_A").quantity == "9"
        byProduct(answer, "SPL_RM_A").supplierPartyId == supplier
        // the phantom blown through: 5 × 3
        byProduct(answer, "SPL_RM_C").quantity == "15"
        byProduct(answer, "SPL_PH").productId == null
        // the sub-assembly's shortage exploded at its own level: 4 × 2
        byProduct(answer, "SPL_RM_D").quantity == "8"
        byProduct(answer, "SPL_RM_D").planningLevel == 2
        requirement.statusId == "RqmtStProposed"
        requirement.quantityUomId == "OTH_ea"
        party.length == 1
        party[0].partyId == org
        party[0].roleTypeId == "OrgInternal"
        orderItems.map(row => row.orderId) == ["SPL_SO_FIN"]
        answer.pendingRelease.some(row => row.productId == "SPL_SUB" && row.quantity == "2" && row.nettedText == "Not netted")
    }
})

feature("an obsolete product and a product with no source are exceptions, never a silent zero", {
    when() {
        return {obsolete: byProduct(state.answer, "SPL_OBS"), noSource: byProduct(state.answer, "SPL_NOSRC")}
    },
    then({obsolete, noSource}) {
        obsolete.exceptionCode == "PRODUCT_NOT_USABLE"
        obsolete.canConvert == false
        obsolete.stateEnumId == "PssException"
        noSource.exceptionCode == "NO_SOURCE"
        noSource.quantity == "1"
    }
})

feature("the demand and supply of a suggestion explain it, the kit assembly run shown and not netted", {
    when() {
        const answer = read("spl_reader", {planningSuggestionId: state.buySuggestionId})
        return {answer, kinds: answer.demandSupply.map(row => row.kindText + ":" + row.quantity + ":" + row.nettedText)}
    },
    then({answer, kinds}) {
        answer.error == ""
        answer.selected.productId == "SPL_RM_A"
        kinds.includes("Planned make:10:Netted")
        kinds.includes("Kit on sales order:2:Netted")
        kinds.includes("On hand:3:Netted")
        kinds.includes("Kit assembly material:50:Not netted")
        answer.canRun == false
        answer.suggestions.every(row => row.canConvert == false)
    }
})

feature("converting the make suggestion creates a draft run with its supply links; a second conversion answers that run", {
    when() {
        const converted = run("spl_planner", S + "convert#PlanningSuggestions", {
            operationKey: key(),
            planningSuggestionIds: [state.finSuggestionId, state.buySuggestionId]
        })
        const again = run("spl_planner", S + "convert#PlanningSuggestions", {
            operationKey: key(),
            planningSuggestionIds: [state.finSuggestionId]
        })
        const made = (converted.results || []).find(row => row.planningSuggestionId === state.finSuggestionId) || {}
        const buy = (converted.results || []).find(row => row.planningSuggestionId === state.buySuggestionId) || {}
        const runRow = one("mantle.work.effort.WorkEffort", {workEffortId: made.workEffortId})
        const lines = rows("mantle.work.production.ProductionRunLine", {workEffortId: made.workEffortId})
        const supply = rows("mantle.request.requirement.RequirementSupply", {requirementId: made.requirementId})
        const fulfillment = rows("mantle.request.requirement.WorkRequirementFulfillment", {requirementId: made.requirementId})
        const requirement = one("mantle.request.requirement.Requirement", {requirementId: made.requirementId})
        state.workEffortId = made.workEffortId
        return {converted, again, made, buy, runRow, lines, supply, fulfillment, requirement}
    },
    then({converted, again, made, buy, runRow, lines, supply, fulfillment, requirement}) {
        converted.error == ""
        converted.createdCount == 1
        converted.failedCount == 1
        made.resultCode == "CREATED"
        // a buy is converted by a buyer (PURCHASE_ORDER_EDIT; impl-purchasing P14a, Replenishment.spec)
        buy.ok == false
        buy.reasonCode == "PERMISSION_DENIED"
        runRow.purposeEnumId == "WepProductionRun"
        runRow.statusId == "WeInPlanning"
        runRow.facilityId == line
        runRow.ownerPartyId == org
        runRow.demandRequirementId == made.requirementId
        runRow.demandOrderId == "SPL_SO_FIN"
        lines.some(row => row.lineRoleEnumId == "PrlrOutput" && n(row.quantity) == 5)
        lines.some(row => row.productId == "SPL_SUB" && n(row.quantity) == 5)
        supply.length == 1
        supply[0].workEffortId == made.workEffortId
        supply[0].supplyTypeEnumId == "RstProductionRun"
        n(supply[0].quantity) == 5
        fulfillment.length == 1
        fulfillment[0].fulfillmentTypeEnumId == "WrfDelivers"
        requirement.statusId == "RqmtStOrdered"
        again.existingCount == 1
        again.results[0].workEffortId == made.workEffortId
    }
})

feature("conversion needs PRODUCTION_PLAN, a run needs SUPPLY_PLAN_RUN, and another organization's plan is unavailable", {
    when() {
        return {
            runner: run("spl_runner", S + "convert#PlanningSuggestions", {
                operationKey: key(),
                planningSuggestionIds: [state.subSuggestionId]
            }),
            reader: plan("spl_reader"),
            none: read("spl_none"),
            outsider: read("spl_outsider"),
            outsiderRun: run("spl_outsider", S + "get#SupplyPlan", {planningRunId: state.firstRunId}),
            outsiderConvert: run("spl_outsider", S + "convert#PlanningSuggestions", {
                operationKey: key(),
                planningSuggestionIds: [state.subSuggestionId]
            })
        }
    },
    then({runner, reader, none, outsider, outsiderRun, outsiderConvert}) {
        runner.error.includes("PERMISSION_DENIED")
        reader.error.includes("PERMISSION_DENIED")
        none.error.includes("PERMISSION_DENIED")
        outsider.error.includes("RECORD_UNAVAILABLE")
        outsiderRun.error.includes("RECORD_UNAVAILABLE")
        outsiderConvert.results[0].reasonCode == "RECORD_UNAVAILABLE"
    }
})

feature("a new run nets the draft run on the line and supersedes the last, whose suggestions are refused as stale", {
    when() {
        const ran = plan("spl_planner")
        const answer = read("spl_planner")
        const stale = run("spl_planner", S + "convert#PlanningSuggestions", {
            operationKey: key(),
            planningSuggestionIds: [state.subSuggestionId]
        })
        const firstRun = one("mantle.request.requirement.PlanningRun", {planningRunId: state.firstRunId})
        const oldSub = one("mantle.request.requirement.PlanningSuggestion", {planningSuggestionId: state.subSuggestionId})
        state.secondSub = byProduct(answer, "SPL_SUB")
        return {ran, answer, stale, firstRun, oldSub}
    },
    then({ran, answer, stale, firstRun, oldSub}) {
        ran.error == ""
        answer.run.revision == 2
        byProduct(answer, "SPL_FIN").productId == null
        // the draft run's material is the sub-assembly's demand now: 5, less 1 on hand
        byProduct(answer, "SPL_SUB").quantity == "4"
        byProduct(answer, "SPL_SUB").requirementId == oldSub.requirementId
        byProduct(answer, "SPL_RM_A").quantity == "9"
        stale.results[0].reasonCode == "PLAN_STALE"
        firstRun.isCurrent == "N"
        firstRun.supersededByRunId == ran.planningRunId
        oldSub.stateEnumId == "PssSuperseded"
    }
})

feature("the schedule's option nets held quantity whose inspection is due within the lead time; off, it is not netted", {
    when() {
        const reader = run("spl_reader", S + "store#PlanSchedule", {organizationPartyId: org, netHeldQuantity: "Y"})
        const stored = run("spl_planner", S + "store#PlanSchedule", {
            organizationPartyId: org,
            facilityIds: [warehouse],
            intervalHours: 24,
            netHeldQuantity: "Y",
            changeReason: "Net held stock due within the lead time"
        })
        plan("spl_planner")
        const netted = read("spl_planner")
        run("spl_planner", S + "store#PlanSchedule", {organizationPartyId: org, facilityIds: [warehouse], netHeldQuantity: "N"})
        plan("spl_planner")
        const plain = read("spl_planner")
        return {reader, stored, netted, plain}
    },
    then({reader, stored, netted, plain}) {
        reader.error.includes("PERMISSION_DENIED")
        stored.error == ""
        stored.schedule.netHeldQuantity == "Y"
        stored.schedule.active == "N"
        netted.run.netHeldQuantity == "Y"
        // 5 less 1 on hand and the 2 held, due tomorrow within the two lead days
        byProduct(netted, "SPL_SUB").quantity == "2"
        byProduct(plain, "SPL_SUB").quantity == "4"
        plain.schedule.netHeldQuantity == "N"
    }
})

feature("a second facility's surplus is a transfer suggestion, shown and not converted here", {
    when() {
        const ran = plan("spl_planner", {facilityIds: [warehouse, second]})
        const answer = read("spl_planner", {facilityIds: [warehouse, second]})
        const transfer = byProduct(answer, "SPL_RM_C", "PsmTransfer")
        const converted = run("spl_planner", S + "convert#PlanningSuggestions", {
            operationKey: key(),
            planningSuggestionIds: [transfer.planningSuggestionId]
        })
        return {ran, transfer, converted, buys: answer.suggestions.filter(row => row.productId === "SPL_RM_C").length}
    },
    then({ran, transfer, converted, buys}) {
        ran.error == ""
        transfer.facilityId == warehouse
        transfer.sourceFacilityId == second
        transfer.quantity == "15"
        buys == 1
        converted.results[0].reasonCode == "METHOD_NOT_CONVERTED"
    }
})

feature("an active schedule that is due runs as the user who kept it, and its next run moves on by its interval", {
    when() {
        const stored = run("spl_planner", S + "store#PlanSchedule", {
            organizationPartyId: org,
            facilityIds: [warehouse],
            intervalHours: 12,
            active: "Y",
            nextRunDate: new Date(Date.now() - 60000)
        })
        const ran = invoke(S + "run#ScheduledSupplyPlans", {})
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        const mine = (ran.results || []).find(row => row.organizationPartyId === org) || {}
        const planningRun = one("mantle.request.requirement.PlanningRun", {planningRunId: mine.planningRunId || "_NA_"})
        const schedule = one("mantle.request.requirement.PlanSchedule", {organizationPartyId: org})
        run("spl_planner", S + "store#PlanSchedule", {organizationPartyId: org, facilityIds: [warehouse], active: "N"})
        return {stored, ran, mine, planningRun, schedule}
    },
    then({stored, ran, mine, planningRun, schedule}) {
        stored.error == ""
        ran.error == ""
        mine.error == null
        planningRun.scheduled == "Y"
        planningRun.startedByUserId == "SPL_PLANNER"
        schedule.lastPlanningRunId == mine.planningRunId
        msOf(schedule.nextRunDate) > Date.now() + 11 * 3600000
    }
})

feature("a reservation's unavailable part and a transfer in transit are each counted once", {
    when() {
        for (const productId of ["SPL_RES", "SPL_TR"]) {
            call("create#mantle.product.Product", {
                productId,
                productName: productId,
                productTypeEnumId: "PtAsset",
                assetTypeEnumId: "AstTpInventory",
                amountUomId: "OTH_ea",
                ownerPartyId: org,
                statusId: "PrdActive"
            })
            call("create#mantle.product.ProductPrice", {
                productId,
                vendorPartyId: supplier,
                pricePurposeEnumId: "PppPurchase",
                priceTypeEnumId: "PptCurrent",
                fromDate: since,
                price: 1,
                priceUomId: "USD"
            })
        }
        // 10 ordered and reserved against 6 on hand: 4 not available, the asset's available to promise -4 (as
        // reserve#AssetForOrderItem leaves it)
        salesOrder("SPL_SO_RES", "SPL_RES", 10, new Date(state.requiredMs))
        const reservedAsset = call("create#mantle.product.asset.Asset", {
            productId: "SPL_RES",
            facilityId: warehouse,
            ownerPartyId: org,
            assetTypeEnumId: "AstTpInventory",
            statusId: "AstAvailable",
            hasQuantity: "Y",
            quantityOnHandTotal: 6,
            availableToPromiseTotal: -4
        }).assetId
        call("create#mantle.product.issuance.AssetReservation", {
            assetId: reservedAsset,
            productId: "SPL_RES",
            orderId: "SPL_SO_RES",
            orderItemSeqId: "01",
            quantity: 10,
            quantityNotAvailable: 4,
            quantityNotIssued: 10,
            reservedDate: new Date()
        })
        // 5 ordered, 3 issued at the second warehouse on a transfer to this one and 1 received: 2 in transit
        salesOrder("SPL_SO_TR", "SPL_TR", 5, new Date(state.requiredMs))
        call("create#mantle.shipment.Shipment", {
            shipmentId: "SPL_TRANSFER",
            shipmentTypeEnumId: "ShpTpTransfer",
            statusId: "ShipShipped",
            fromPartyId: org,
            toPartyId: org
        })
        call("create#mantle.shipment.ShipmentRouteSegment", {
            shipmentId: "SPL_TRANSFER",
            shipmentRouteSegmentSeqId: "01",
            originFacilityId: second,
            destinationFacilityId: warehouse
        })
        call("create#mantle.shipment.ShipmentItem", {shipmentId: "SPL_TRANSFER", productId: "SPL_TR", quantity: 3})
        call("create#mantle.shipment.ShipmentItemSource", {
            shipmentItemSourceId: "SPL_TRANSFER_01",
            shipmentId: "SPL_TRANSFER",
            productId: "SPL_TR",
            quantity: 3,
            statusId: "SisPending"
        })
        call("create#mantle.product.issuance.AssetIssuance", {
            assetId: receive("SPL_TR", 0, second),
            productId: "SPL_TR",
            shipmentId: "SPL_TRANSFER",
            shipmentItemSourceId: "SPL_TRANSFER_01",
            quantity: 3,
            issuedDate: new Date()
        })
        call("create#mantle.product.receipt.AssetReceipt", {
            assetId: receive("SPL_TR", 1),
            productId: "SPL_TR",
            shipmentId: "SPL_TRANSFER",
            shipmentItemSourceId: "SPL_TRANSFER_01",
            quantityAccepted: 1,
            receivedDate: new Date()
        })
        const ran = plan("spl_planner", {productIds: ["SPL_RES", "SPL_TR"]})
        const answer = read("spl_planner")
        const transfer = byProduct(answer, "SPL_TR")
        const explained = read("spl_planner", {planningSuggestionId: transfer.planningSuggestionId})
        return {ran, answer, explained}
    },
    then({ran, answer, explained}) {
        ran.error == ""
        // 10 less the 6 on hand: the 4 not available is the negative available to promise, not open demand as well
        byProduct(answer, "SPL_RES").quantity == "4"
        // 5 less the 1 received and the 2 in transit
        byProduct(answer, "SPL_TR").quantity == "2"
        explained.demandSupply.some(
            row => row.kindText == "Transfer in transit" && row.quantity == "2" && row.nettedText == "Netted"
        )
    }
})

feature("a schedule whose user can no longer sign in is named on it, the other schedules still run, and a runner without METHOD_VIEW gets the made product named", {
    when() {
        call("create#mantle.facility.Facility", {
            facilityId: "SPL_OTHER_WH",
            facilityTypeEnumId: "FcTpWarehouse",
            ownerPartyId: other
        })
        const outsider = run("spl_outsider", S + "store#PlanSchedule", {
            organizationPartyId: other,
            intervalHours: 6,
            active: "Y",
            nextRunDate: new Date(Date.now() - 60000)
        })
        const mine = run("spl_planner", S + "store#PlanSchedule", {
            organizationPartyId: org,
            facilityIds: [warehouse],
            intervalHours: 12,
            active: "Y",
            nextRunDate: new Date(Date.now() - 60000)
        })
        call("update#moqui.security.UserAccount", {userId: "SPL_OUTSIDER", disabled: "Y"})
        const ran = invoke(S + "run#ScheduledSupplyPlans", {})
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        call("update#moqui.security.UserAccount", {userId: "SPL_OUTSIDER", disabled: "N"})
        const results = ran.results || []
        const otherSchedule = one("mantle.request.requirement.PlanSchedule", {organizationPartyId: other})
        run("spl_planner", S + "store#PlanSchedule", {organizationPartyId: org, facilityIds: [warehouse], active: "N"})
        call("update#mantle.request.requirement.PlanSchedule", {organizationPartyId: other, active: "N"})
        // the sub-assembly's BOM cannot be read without METHOD_VIEW: the run goes on, naming it (F-P14a-2)
        const noMethod = plan("spl_nomethod", {productIds: ["SPL_SUB"]})
        const noMethodSub = byProduct(read("spl_planner"), "SPL_SUB")
        return {outsider, mine, ran, results, otherSchedule, noMethod, noMethodSub}
    },
    then({outsider, mine, ran, results, otherSchedule, noMethod, noMethodSub}) {
        noMethod.error == ""
        noMethodSub.exceptionCode == "METHOD_INVALID"
        outsider.error == ""
        mine.error == ""
        ran.error == ""
        results.find(row => row.organizationPartyId == other).error.includes("SCHEDULE_USER_UNAVAILABLE")
        !!results.find(row => row.organizationPartyId == org).planningRunId
        otherSchedule.lastRunMessage.includes("SCHEDULE_USER_UNAVAILABLE")
        msOf(otherSchedule.nextRunDate) > Date.now() + 5 * 3600000
    }
})
