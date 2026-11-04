// Outside processing (impl-manufacturing P14, design-manufacturing SubcontractOperations and SubcontractDetail, crosscut
// CX-SUBCONTRACT): a planner requests outside processing for an operation of a released run (a ProductionSubcontract, an
// RqTpProduct requirement with its operation demand link, in the current supply plan); a buyer converts it into a draft
// service purchase order line with OrderItemWorkEffort and RequirementSupply, one order per supplier, at the supplier's
// price; the planner cannot convert it and a second conversion answers the same line; components dispatched to the
// vendor-custody facility stay the organization's; the output receipt issues them, holds the output for inspection, accepts
// the service line once and writes the accrual once; the supplier's bill matches against the accepted quantity and writes the
// price variance; a run reader without a buyer's permission sees no purchase price. The users are in spec-local groups.
const P = "mantle.work.ProductionServices.",
    S = "mantle.product.SupplyPlanningServices.",
    T = "mantle.shipment.WarehouseTaskServices.",
    M = "mantle.account.InvoiceMatchServices.",
    B = "mantle.product.BomServices.",
    R = "mantle.work.RoutingServices."
const org = "PSC_ORG",
    facility = "PSC_FAC",
    vendor = "PSC_VENDOR",
    supplier = "PSC_SUPPLIER",
    other = "PSC_OTHER"
const find = (entity, conditions = {}) => ec.entity.find(entity).condition(conditions).disableAuthz()
const one = (entity, conditions) => find(entity, conditions).one()
const rows = (entity, conditions) => Array.from(find(entity, conditions).list())
const n = value => (value == null ? 0 : Number(String(value)))
const since = "2000-01-01T00:00:00Z"
const state = {}
let keySeq = 0
const key = () => "psc-op-" + ++keySeq

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
function receive(productId, quantity, acquireCost, facilityId = facility, locationSeqId = "PICK1") {
    const assetId = call("mantle.product.AssetServices.receive#Asset", {
        productId,
        quantity,
        facilityId,
        locationSeqId,
        ownerPartyId: org,
        assetTypeEnumId: "AstTpInventory",
        statusId: "AstAvailable",
        acquireCost
    }).assetId
    call("update#mantle.product.asset.Asset", {assetId, acquireCostUomId: "USD"})
    return assetId
}
// a released run of the coated product with its one outside operation
function releasedRun() {
    const created = run("psc_planner", P + "create#ProductionOrder", {
        operationKey: key(),
        organizationPartyId: org,
        productId: "PSC_FIN",
        quantity: 3,
        facilityId: facility
    })
    const released = run("psc_planner", P + "release#ProductionOrder", {operationKey: key(), workEffortId: created.workEffortId})
    return {runId: created.workEffortId, opId: released.result.operationWorkEffortIds[0]}
}
const request = (username, opId, extra = {}) =>
    run(
        username,
        P + "request#SubcontractService",
        Object.assign(
            {operationKey: key(), operationWorkEffortId: opId, productId: "PSC_COAT", quantity: 3, supplierPartyId: supplier},
            extra
        )
    )
const suggestionOf = (planningRunId, requirementId) =>
    rows("mantle.request.requirement.PlanningSuggestion", {planningRunId, requirementId})[0] || null

spec({
    stepwise: true,
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        for (const partyId of [org, other]) {
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
        call("update#mantle.ledger.config.PartyAcctgPreference", {organizationPartyId: org, receiptInvoiceSelfBilledOnly: "Y"})
        user("PSC_METHOD", ["METHOD_VIEW", "METHOD_EDIT", "METHOD_APPROVE", "METHOD_RESOURCES"])
        user("PSC_PLANNER", ["PRODUCTION_PLAN", "PRODUCTION_VIEW", "METHOD_VIEW", "SUPPLY_PLAN_RUN"])
        user("PSC_READER", ["PRODUCTION_VIEW"])
        user("PSC_BUYER", ["PURCHASE_ORDER_EDIT", "SUPPLIER_PRICE_VIEW", "PRODUCTION_VIEW"])
        user("PSC_MOVER", ["STOCK_MOVE", "STOCK_ISSUE"])
        user("PSC_AP", ["PAYABLE_EDIT", "PAYABLE_VIEW", "PAYABLE_IMPORT"])
        user("PSC_MATCHER", ["INVOICE_MATCH", "PAYABLE_VIEW"])
        user("PSC_FINANCE", ["PRODUCTION_VIEW", "ACCOUNTING_VIEW"])
        user("PSC_OUTSIDER", ["PRODUCTION_PLAN", "PRODUCTION_VIEW", "PURCHASE_ORDER_EDIT"], other)
        for (const facilityId of [facility, vendor])
            call("create#mantle.facility.Facility", {facilityId, facilityTypeEnumId: "FcTpWarehouse", ownerPartyId: org})
        for (const [locationSeqId, locationTypeEnumId] of [
            ["PICK1", "FltPick"],
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
        for (const productId of ["PSC_FIN", "PSC_RM"])
            call("create#mantle.product.Product", {
                productId,
                productName: productId,
                productTypeEnumId: "PtAsset",
                assetTypeEnumId: "AstTpInventory",
                amountUomId: "OTH_ea",
                ownerPartyId: org
            })
        call("create#mantle.product.Product", {
            productId: "PSC_COAT",
            productName: "Coating",
            productTypeEnumId: "PtService",
            amountUomId: "OTH_ea",
            ownerPartyId: org
        })
        // the supplier's price of the service, the shared resolver's
        call("create#mantle.product.ProductPrice", {
            productId: "PSC_COAT",
            vendorPartyId: supplier,
            pricePurposeEnumId: "PppPurchase",
            priceTypeEnumId: "PptCurrent",
            fromDate: since,
            minQuantity: 0,
            price: 4,
            priceUomId: "USD"
        })
        // the output is inspected, so it is received into quarantine
        call("create#mantle.facility.WarehousePolicy", {
            organizationPartyId: org,
            policyType: "tracking",
            facilityId: "_NA_",
            productId: "PSC_FIN",
            fromDate: since,
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
        ec.artifactExecution.enableAuthz()
        as("psc_method", () => {
            call(R + "store#WorkCenter", {
                organizationPartyId: org,
                facilityId: facility,
                efficiencyPercent: 100,
                changeReason: "Spec work center"
            })
            const route = call(R + "store#Routing", {organizationPartyId: org, workEffortName: "Coating", changeReason: "Spec"})
            const routeId = route.routing.workEffortId
            const opId = call(R + "store#RoutingOperation", {
                workEffortId: routeId,
                workEffortName: "Outside coating",
                sequenceNum: 10,
                estimatedWorkTime: 6,
                timeUomId: "TF_min",
                methodBatchQuantity: 1,
                methodQuantityUomId: "OTH_ea",
                methodWorkCenterId: facility,
                changeReason: "Spec"
            }).operationWorkEffortId
            const routing = call(R + "get#RoutingDetail", {workEffortId: routeId})
            call(R + "release#RoutingDraft", {
                workEffortId: routeId,
                expectedRevision: routing.expectedRevision,
                changeReason: "Spec"
            })
            const bom = call(B + "store#Bom", {
                productId: "PSC_FIN",
                organizationPartyId: org,
                routingWorkEffortId: routeId,
                changeReason: "Spec"
            })
            const productBomId = bom.productBom.productBomId
            call(B + "store#BomItem", {
                productBomId,
                productId: "PSC_RM",
                quantity: 1,
                operationWorkEffortId: opId,
                changeReason: "S"
            })
            const detail = call(B + "get#BomDetail", {productBomId})
            call(B + "release#BomDraft", {productBomId, expectedRevision: detail.expectedRevision, changeReason: "Spec"})
        })
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        state.stock = receive("PSC_RM", 20, 2)
        ec.artifactExecution.enableAuthz()
        state.first = releasedRun()
        state.second = releasedRun()
        // a current plan of the facility, which the requests join
        state.plan = run("psc_planner", S + "run#SupplyPlan", {facilityIds: [facility]})
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

feature("a planner requests outside processing; the reader, a draft run, a non-service and a second request are refused", {
    when() {
        const reader = request("psc_reader", state.first.opId)
        const notService = request("psc_planner", state.first.opId, {productId: "PSC_RM"})
        const outsider = request("psc_outsider", state.first.opId)
        const draft = run("psc_planner", P + "create#ProductionOrder", {
            operationKey: key(),
            organizationPartyId: org,
            productId: "PSC_FIN",
            quantity: 1,
            facilityId: facility
        })
        const runAsOperation = request("psc_planner", draft.workEffortId)
        const notCustody = request("psc_planner", state.first.opId, {vendorFacilityId: facility})
        const operationKey = key()
        const parameters = {operationKey, vendorFacilityId: vendor, leadTimeDays: 2, priceBasisNote: "Per piece, quote Q-7"}
        const requested = request("psc_planner", state.first.opId, parameters)
        const retry = run(
            "psc_planner",
            P + "request#SubcontractService",
            Object.assign(
                {operationWorkEffortId: state.first.opId, productId: "PSC_COAT", quantity: 3, supplierPartyId: supplier},
                parameters
            )
        )
        const again = request("psc_planner", state.first.opId)
        state.firstRequest = requested.result
        state.secondRequest = request("psc_planner", state.second.opId).result
        return {reader, notService, outsider, runAsOperation, notCustody, requested, retry, again}
    },
    then({reader, notService, outsider, runAsOperation, notCustody, requested, retry, again}) {
        reader.error.includes("PERMISSION_DENIED")
        notService.error.includes("NOT_SERVICE")
        outsider.error.includes("RECORD_UNAVAILABLE")
        runAsOperation.error.includes("RECORD_UNAVAILABLE")
        notCustody.error.includes("NOT_CUSTODY")
        requested.error == ""
        retry.result.alreadyApplied == true
        retry.result.productionSubcontractId == requested.result.productionSubcontractId
        again.error.includes("SUBCONTRACT_EXISTS")
        const subcontract = one("mantle.work.production.ProductionSubcontract", {
            productionSubcontractId: requested.result.productionSubcontractId
        })
        subcontract.statusId == "PscRequested"
        subcontract.vendorFacilityId == vendor
        // the price basis is not the planner's to set
        subcontract.priceBasisNote == null
        const requirement = one("mantle.request.requirement.Requirement", {requirementId: requested.result.requirementId})
        requirement.requirementTypeEnumId == "RqTpProduct"
        requirement.productId == "PSC_COAT"
        n(requirement.quantity) == 3
        requirement.quantityUomId == "OTH_ea"
        rows("mantle.request.requirement.RequirementParty", {requirementId: requirement.requirementId, roleTypeId: "Supplier"})[0]
            .partyId == supplier
        const demand = rows("mantle.request.requirement.RequirementSupply", {requirementId: requirement.requirementId})
        demand.length == 1
        demand[0].supplyTypeEnumId == "RstOperationDemand"
        demand[0].workEffortId == state.first.opId
        // in the current plan as an outside-processing suggestion
        requested.result.planningRunIds.includes(state.plan.planningRunId)
        const suggestion = suggestionOf(state.plan.planningRunId, requirement.requirementId)
        suggestion.methodEnumId == "PsmOutside"
        suggestion.supplierPartyId == supplier
        n(suggestion.quantity) == 3
    }
})

feature(
    "a buyer converts both requests into one draft order of the supplier; the planner cannot; a second conversion answers the line",
    {
        when() {
            const plan = run("psc_buyer", S + "get#SupplyPlan", {facilityIds: [facility], methodEnumId: "PsmOutside"})
            const ids = [state.firstRequest, state.secondRequest].map(
                requested => suggestionOf(state.plan.planningRunId, requested.requirementId).planningSuggestionId
            )
            const planner = run("psc_planner", S + "convert#PlanningSuggestions", {
                operationKey: key(),
                planningSuggestionIds: ids
            })
            const converted = run("psc_buyer", S + "convert#PlanningSuggestions", {
                operationKey: key(),
                planningSuggestionIds: ids
            })
            const again = run("psc_buyer", S + "convert#PlanningSuggestions", {operationKey: key(), planningSuggestionIds: ids})
            // a new calculation keeps the converted request (not rejected) and does not suggest it again
            const replanned = run("psc_planner", S + "run#SupplyPlan", {facilityIds: [facility]})
            return {plan, planner, converted, again, replanned}
        },
        then({plan, planner, converted, again, replanned}) {
            plan.error == ""
            plan.canConvertOutside == true
            plan.suggestions.filter(row => row.methodEnumId === "PsmOutside" && row.canConvert).length == 2
            planner.results.every(row => !row.ok && row.reasonCode === "PERMISSION_DENIED")
            converted.createdCount == 2
            const [first, second] = converted.results
            first.ok == true
            first.orderId == second.orderId
            first.orderItemSeqId != second.orderItemSeqId
            const header = one("mantle.order.OrderHeader", {orderId: first.orderId})
            // a draft: never placed or approved here
            header.statusId == "OrderOpen"
            header.currencyUomId == "USD"
            const part = rows("mantle.order.OrderPart", {orderId: first.orderId})[0]
            part.vendorPartyId == supplier
            part.customerPartyId == org
            const item = one("mantle.order.OrderItem", {orderId: first.orderId, orderItemSeqId: first.orderItemSeqId})
            item.productId == "PSC_COAT"
            n(item.quantity) == 3
            item.quantityUomId == "OTH_ea"
            n(item.unitAmount) == 4
            const link = one("mantle.order.OrderItemWorkEffort", {
                orderId: first.orderId,
                orderItemSeqId: first.orderItemSeqId,
                workEffortId: state.first.opId
            })
            link.requiredWork == "Y"
            const supply = rows("mantle.request.requirement.RequirementSupply", {
                requirementId: state.firstRequest.requirementId,
                supplyTypeEnumId: "RstPurchaseOrder"
            })
            supply.length == 1
            supply[0].orderItemSeqId == first.orderItemSeqId
            one("mantle.request.requirement.Requirement", {requirementId: state.firstRequest.requirementId}).statusId ==
                "RqmtStOrdered"
            const subcontract = one("mantle.work.production.ProductionSubcontract", {
                productionSubcontractId: state.firstRequest.productionSubcontractId
            })
            subcontract.orderId == first.orderId
            subcontract.statusId == "PscOrdered"
            again.results.every(row => row.ok && row.resultCode === "EXISTING")
            again.results[0].orderId == first.orderId
            again.results[0].orderItemSeqId == first.orderItemSeqId
            rows("mantle.order.OrderItem", {orderId: first.orderId}).length == 2
            replanned.error == ""
            rows("mantle.request.requirement.PlanningSuggestion", {
                planningRunId: replanned.planningRunId,
                requirementId: state.firstRequest.requirementId
            }).length == 0
            one("mantle.request.requirement.Requirement", {requirementId: state.firstRequest.requirementId}).statusId ==
                "RqmtStOrdered"
        }
    }
)

feature("store changes the agreement before the order, and only the buyer's fields after it", {
    when() {
        const subcontractId = state.firstRequest.productionSubcontractId
        const current = () => one("mantle.work.production.ProductionSubcontract", {productionSubcontractId: subcontractId})
        const ordered = run("psc_planner", P + "store#ProductionSubcontract", {
            operationKey: key(),
            productionSubcontractId: subcontractId,
            expectedRevision: current().revision,
            quantity: 5
        })
        const stale = run("psc_buyer", P + "store#ProductionSubcontract", {
            operationKey: key(),
            productionSubcontractId: subcontractId,
            expectedRevision: 1,
            priceBasisNote: "Per piece"
        })
        const plannerNote = run("psc_planner", P + "store#ProductionSubcontract", {
            operationKey: key(),
            productionSubcontractId: subcontractId,
            expectedRevision: current().revision,
            priceBasisNote: "Per piece"
        })
        const buyerNote = run("psc_buyer", P + "store#ProductionSubcontract", {
            operationKey: key(),
            productionSubcontractId: subcontractId,
            expectedRevision: current().revision,
            priceBasisNote: "Per piece, quote Q-7"
        })
        return {ordered, stale, plannerNote, buyerNote, after: current()}
    },
    then({ordered, stale, plannerNote, buyerNote, after}) {
        ordered.error.includes("SUBCONTRACT_ORDERED")
        stale.error.includes("REVISION_CHANGED")
        plannerNote.error.includes("PERMISSION_DENIED")
        buyerNote.error == ""
        after.priceBasisNote == "Per piece, quote Q-7"
        n(after.quantity) == 3
    }
})

feature("components dispatched to the vendor-custody facility stay the organization's; the materials show them there", {
    when() {
        const subcontract = one("mantle.work.production.ProductionSubcontract", {
            productionSubcontractId: state.firstRequest.productionSubcontractId
        })
        state.orderId = subcontract.orderId
        state.orderItemSeqId = subcontract.orderItemSeqId
        // the walk's demo places the order until Purchasing does
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        call("mantle.order.OrderServices.place#Order", {orderId: state.orderId})
        call("mantle.order.OrderServices.approve#Order", {orderId: state.orderId})
        const keys = {
            subcontractWorkEffortId: state.first.opId,
            subcontractOrderId: state.orderId,
            subcontractOrderItemSeqId: state.orderItemSeqId
        }
        const created = run(
            "psc_mover",
            T + "create#Transfer",
            Object.assign(
                {
                    operationKey: key(),
                    originFacilityId: facility,
                    destinationFacilityId: vendor,
                    lines: [{productId: "PSC_RM", quantity: 3}]
                },
                keys
            )
        )
        state.dispatchId = created.result?.shipmentId
        const moved = run("psc_mover", T + "dispatch#SubcontractStock", {
            operationKey: key(),
            shipmentId: state.dispatchId,
            shipmentItemSourceId: created.result?.lines?.[0]?.shipmentItemSourceId,
            assetId: state.stock,
            quantity: 3,
            toLocationSeqId: "CAGE"
        })
        const materials = run("psc_reader", P + "get#SubcontractMaterials", {operationWorkEffortId: state.first.opId})
        const shipment = run("psc_reader", P + "get#SubcontractShipment", {shipmentId: state.dispatchId})
        return {created, moved, materials, shipment, atVendor: rows("mantle.product.asset.Asset", {facilityId: vendor})}
    },
    then({created, moved, materials, shipment, atVendor}) {
        created.error == ""
        moved.error == ""
        atVendor.length == 1
        atVendor[0].ownerPartyId == org
        n(atVendor[0].quantityOnHandTotal) == 3
        // a move posts nothing: no issuance
        rows("mantle.product.issuance.AssetIssuance", {shipmentId: state.dispatchId}).length == 0
        materials.error == ""
        materials.vendorFacilityId == vendor
        materials.custodianName == "Outside coater"
        materials.materials.length == 1
        materials.materials[0].ownerPartyId == org
        materials.materials[0].sentQuantity == "3"
        materials.materials[0].atVendorQuantity == "3"
        materials.shipments.length == 1
        materials.shipments[0].direction == "dispatch"
        shipment.subcontractShipment.ownerPartyId == org
        shipment.subcontractShipment.direction == "dispatch"
        shipment.subcontractShipment.lines[0].deliveredQuantity == "3"
    }
})

feature("the output receipt issues the components, holds the output, accepts the service once and writes the accrual once", {
    when() {
        const parameters = {operationKey: key(), shipmentId: state.dispatchId, quantity: 3}
        const received = run("psc_mover", P + "receive#SubcontractOutput", parameters)
        const retry = run("psc_mover", P + "receive#SubcontractOutput", parameters)
        const status = run("psc_buyer", P + "get#SubcontractStatus", {operationWorkEffortId: state.first.opId})
        return {received, retry, status}
    },
    then({received, retry, status}) {
        received.error == ""
        received.result.issues.length == 1
        n(one("mantle.product.asset.Asset", {assetId: received.result.issues[0].assetId}).quantityOnHandTotal) == 0
        received.result.output.inspected == true
        received.result.output.statusId == "AstQuarantine"
        retry.result.alreadyApplied == true
        const acceptances = rows("mantle.order.purchase.ServiceAcceptance", {
            orderId: state.orderId,
            orderItemSeqId: state.orderItemSeqId
        })
        acceptances.length == 1
        n(acceptances[0].acceptedQuantity) == 3
        const accruals = rows("mantle.work.production.ProductionCostEvent", {costEventTypeEnumId: "PcetOutsideAccrual"}).filter(
            row => row.workEffortId === state.first.runId
        )
        accruals.length == 1
        accruals[0].productionCostEventId == received.result.accrualCostEventId
        n(accruals[0].amount) == 12
        accruals[0].costComponentEnumId == "PrcOutside"
        accruals[0].ledgerStatusEnumId == "PclAwaitingClose"
        accruals[0].operationWorkEffortId == state.first.opId
        status.error == ""
        status.stateText == "Accepted"
        status.serviceLines[0].acceptedQuantity == "3"
        status.output.receipts[0].held == true
    }
})

feature("the supplier's bill matches against the accepted quantity and writes the price variance once", {
    when() {
        login("psc_ap")
        const invoiceId = call("mantle.account.InvoiceServices.import#Bill", {
            organizationPartyId: org,
            supplierPartyId: supplier,
            referenceNumber: "PSC-BILL-1"
        }).invoiceId
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        // billed at 5 for 4 ordered: 4 is more than the 3 accepted
        call("mantle.account.InvoiceServices.create#InvoiceItem", {
            invoiceId,
            itemTypeEnumId: "ItemProduct",
            productId: "PSC_COAT",
            quantity: 3,
            amount: 5
        })
        const invoiceItemSeqId = rows("mantle.account.invoice.InvoiceItem", {invoiceId})[0].invoiceItemSeqId
        const allocation = quantity => [
            {invoiceItemSeqId, orderId: state.orderId, orderItemSeqId: state.orderItemSeqId, quantity: String(quantity)}
        ]
        const evaluated = run("psc_matcher", M + "evaluate#InvoiceMatch", {invoiceId})
        const excess = run("psc_matcher", M + "apply#InvoiceMatch", {invoiceId, allocationList: allocation(4)})
        const applied = run("psc_matcher", M + "apply#InvoiceMatch", {
            invoiceId,
            allocationList: allocation(3),
            operationKey: key()
        })
        return {evaluated, excess, applied, invoiceId}
    },
    then({evaluated, excess, applied, invoiceId}) {
        evaluated.error == ""
        excess.error.includes("QUANTITY_EXCESS")
        applied.error == ""
        const variances = rows("mantle.work.production.ProductionCostEvent", {costEventTypeEnumId: "PcetOutsideVariance"})
        variances.length == 1
        variances[0].workEffortId == state.first.runId
        n(variances[0].amount) == 3
        variances[0].invoiceId == invoiceId
        variances[0].ledgerStatusEnumId == "PclAwaitingClose"
        rows("mantle.order.OrderItemBilling", {invoiceId}).reduce((sum, row) => sum + n(row.quantity), 0) == 3
    }
})

feature("a run reader without a buyer's permission sees no purchase price; the buyer and a financial reader do", {
    when() {
        const read = username => run(username, P + "get#SubcontractStatus", {operationWorkEffortId: state.first.opId})
        const list = username => run(username, P + "find#SubcontractOperations", {workEffortId: state.first.runId})
        const order = username => run(username, P + "get#SubcontractOrder", {orderId: state.orderId})
        return {
            reader: read("psc_reader"),
            buyer: read("psc_buyer"),
            finance: read("psc_finance"),
            readerList: list("psc_reader"),
            buyerList: list("psc_buyer"),
            readerOrder: order("psc_reader"),
            buyerOrder: order("psc_buyer"),
            outsider: read("psc_outsider")
        }
    },
    then({reader, buyer, finance, readerList, buyerList, readerOrder, buyerOrder, outsider}) {
        reader.error == ""
        reader.serviceLines[0].unitAmount === undefined
        reader.subcontract.priceBasisNote === undefined
        reader.costEvents.every(row => row.amount === undefined)
        buyer.serviceLines[0].unitAmount == "4"
        buyer.subcontract.priceBasisNote == "Per piece, quote Q-7"
        finance.serviceLines[0].unitAmount == "4"
        finance.costEvents.some(row => row.amount == "12")
        readerList.operationList.length == 1
        readerList.operationList[0].unitAmount === undefined
        buyerList.operationList[0].unitAmount == "4"
        readerOrder.subcontractOrder.items.every(row => row.unitAmount === undefined)
        readerOrder.subcontractOrder.items[0].links[0].operationWorkEffortId == state.first.opId
        buyerOrder.subcontractOrder.items[0].unitAmount == "4"
        outsider.error.includes("RECORD_UNAVAILABLE")
    }
})

feature("with the service-acceptance rule on a line with nothing accepted is refused; off it matches its ordered quantity", {
    when() {
        const admin = "PSC_ADMIN"
        user(admin, ["ACCOUNTING_ADMIN"])
        login("psc_ap")
        const invoiceId = call("mantle.account.InvoiceServices.import#Bill", {
            organizationPartyId: org,
            supplierPartyId: supplier,
            referenceNumber: "PSC-BILL-2"
        }).invoiceId
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        // the second line: nothing accepted yet
        const secondItem = rows("mantle.order.OrderItem", {orderId: state.orderId}).find(
            row => row.orderItemSeqId !== state.orderItemSeqId
        )
        call("mantle.account.InvoiceServices.create#InvoiceItem", {
            invoiceId,
            itemTypeEnumId: "ItemProduct",
            productId: "PSC_COAT",
            quantity: 3,
            amount: 4
        })
        const invoiceItemSeqId = rows("mantle.account.invoice.InvoiceItem", {invoiceId})[0].invoiceItemSeqId
        const allocationList = [
            {invoiceItemSeqId, orderId: state.orderId, orderItemSeqId: secondItem.orderItemSeqId, quantity: "3"}
        ]
        // the default rule (Y): nothing accepted on the line, nothing to bill
        const unaccepted = run("psc_matcher", M + "apply#InvoiceMatch", {invoiceId, allocationList})
        const stored = run("psc_admin", M + "store#MatchPolicy", {
            organizationPartyId: org,
            productId: "PSC_COAT",
            serviceAcceptanceRequired: "N",
            changeReason: "Bill services as ordered"
        })
        const applied = run("psc_matcher", M + "apply#InvoiceMatch", {invoiceId, allocationList})
        return {unaccepted, stored, applied}
    },
    then({unaccepted, stored, applied}) {
        unaccepted.error.includes("MISSING_RECEIPT")
        stored.error == ""
        applied.error == ""
        // the same price as ordered: no variance event
        rows("mantle.work.production.ProductionCostEvent", {costEventTypeEnumId: "PcetOutsideVariance"}).length == 1
    }
})
