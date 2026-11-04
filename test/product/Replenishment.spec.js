// Replenishment (impl-purchasing P14a; design-purchasing §8 SupplyPlanning and ReorderRules, crosscut CX-PLANNING and
// CX-FACILITY-POLICY, R-PUR-19): a sales shortage of a bought product is a buy suggestion; a buyer converts buy suggestions
// into one draft purchase order per supplier and facility (never placed), a retry answers it, a competing conversion is
// DEMAND_ALREADY_COVERED and makes no second order, and the next plan counts the draft's lines as supply; a reorder rule
// orders up to its maximum or at least its reorder quantity; a snoozed rule still shows its shortage and only an automatic
// conversion leaves it; the snooze needs a future date, a reason and STOCK_POLICY_PLAN, and is audit-logged; suggested levels
// come from demand history and the supplier's lead time, a product without history is named, and each row is applied through
// store#ProductFacilityPolicy with its failure named; and reorder-rule rows import through the same store with a row result
// each. The users are in spec-local groups.
const S = "mantle.product.SupplyPlanningServices.",
    R = "mantle.facility.ReorderRuleServices.",
    F = "mantle.facility.FacilityServices.",
    I = "mantle.product.ProductImportServices."
const org = "RPL_ORG",
    warehouse = "RPL_WH",
    supplier = "RPL_SUPPLIER",
    customer = "RPL_CUSTOMER"
const find = (entity, conditions = {}) => ec.entity.find(entity).condition(conditions).disableAuthz()
const one = (entity, conditions) => find(entity, conditions).one()
const rows = (entity, conditions) => Array.from(find(entity, conditions).list())
const since = "2000-01-01T00:00:00Z"
const dayMs = 86400000
const state = {}
let keySeq = 0
const key = () => "rpl-op-" + ++keySeq

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
function user(partyId, permissions) {
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
        toPartyId: org,
        relationshipTypeEnumId: "PrtAgent",
        toRoleTypeId: "OrgInternal",
        fromDate: since
    })
}
function salesOrder(orderId, productId, quantity) {
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
        requiredByDate: new Date(Date.now() + 5 * dayMs)
    })
}
function receive(productId, quantity) {
    return call("create#mantle.product.asset.Asset", {
        productId,
        facilityId: warehouse,
        ownerPartyId: org,
        assetTypeEnumId: "AstTpInventory",
        statusId: "AstAvailable",
        hasQuantity: "Y",
        quantityOnHandTotal: quantity,
        availableToPromiseTotal: quantity
    }).assetId
}
const plan = username => run(username, S + "run#SupplyPlan", {organizationPartyId: org, facilityIds: [warehouse]})
const read = username => run(username, S + "get#SupplyPlan", {organizationPartyId: org, facilityIds: [warehouse]})
const byProduct = (answer, productId) => (answer.suggestions || []).find(row => row.productId === productId) || {}
const policy = (username, parameters) =>
    run(username, F + "store#ProductFacilityPolicy", Object.assign({facilityId: warehouse, changeReason: "Spec"}, parameters))
const convert = (username, ids, extra = {}) =>
    run(username, S + "convert#PlanningSuggestions", Object.assign({operationKey: key(), planningSuggestionIds: ids}, extra))
const resultOf = (converted, planningSuggestionId) =>
    (converted.results || []).find(row => row.planningSuggestionId === planningSuggestionId) || {}

spec({
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        for (const [partyId, roleTypeId] of [
            [org, "OrgInternal"],
            [supplier, "Supplier"],
            [customer, "Customer"]
        ]) {
            call("create#mantle.party.Party", {partyId, partyTypeEnumId: "PtyOrganization"})
            call("create#mantle.party.Organization", {partyId, organizationName: partyId})
            call("create#mantle.party.PartyRole", {partyId, roleTypeId})
        }
        call("create#mantle.ledger.config.PartyAcctgPreference", {organizationPartyId: org, baseCurrencyUomId: "USD"})
        call("create#mantle.facility.Facility", {facilityId: warehouse, facilityTypeEnumId: "FcTpWarehouse", ownerPartyId: org})
        user("RPL_BUYER", ["PURCHASE_ORDER_EDIT", "SUPPLIER_PRICE_VIEW"])
        user("RPL_BUYER2", ["PURCHASE_ORDER_EDIT", "SUPPLIER_PRICE_VIEW"])
        user("RPL_PLANNER", ["SUPPLY_PLAN_RUN", "STOCK_POLICY_PLAN"])
        user("RPL_VIEWER", ["SUPPLY_PLAN_VIEW"])
        user("RPL_IMPORTER", ["PRODUCT_CATALOG_VIEW", "STOCK_POLICY_PLAN"])
        const products = ["RPL_A", "RPL_B", "RPL_MAX", "RPL_FIX", "RPL_SNZ", "RPL_HIST", "RPL_NOHIST", "RPL_IMP", "RPL_IMP2"]
        for (const productId of products)
            call("create#mantle.product.Product", {
                productId,
                productName: productId,
                productTypeEnumId: "PtAsset",
                assetTypeEnumId: "AstTpInventory",
                amountUomId: "OTH_ea",
                ownerPartyId: org,
                statusId: "PrdActive"
            })
        for (const productId of products.slice(0, 7))
            call("create#mantle.product.ProductPrice", {
                productId,
                vendorPartyId: supplier,
                pricePurposeEnumId: "PppPurchase",
                priceTypeEnumId: "PptCurrent",
                fromDate: since,
                price: 3,
                priceUomId: "USD",
                standardLeadTimeDays: productId === "RPL_HIST" ? 5 : null
            })
        salesOrder("RPL_SO_A", "RPL_A", 10)
        salesOrder("RPL_SO_B", "RPL_B", 4)
        receive("RPL_A", 3)
        receive("RPL_MAX", 4)
        receive("RPL_FIX", 8)
        // the reorder rules: up to a maximum of 50, a fixed reorder quantity of 20, and a minimum of 5 to snooze
        for (const [productId, fields] of [
            ["RPL_MAX", {minimumStock: 10, maximumStock: 50, reorderMethodEnumId: "RdmUpToMaximum"}],
            ["RPL_FIX", {minimumStock: 10, reorderQuantity: 20, reorderMethodEnumId: "RdmFixedQuantity"}],
            ["RPL_SNZ", {minimumStock: 5}],
            ["RPL_NOHIST", {minimumStock: 1}]
        ])
            call("create#mantle.facility.ProductFacility", Object.assign({productId, facilityId: warehouse}, fields))
        // 180 issued from the warehouse over the last 90 days: an average daily demand of 2
        const histAssetId = receive("RPL_HIST", 0)
        for (const days of [10, 40, 70])
            call("create#mantle.product.issuance.AssetIssuance", {
                assetId: histAssetId,
                productId: "RPL_HIST",
                facilityId: warehouse,
                issuedDate: new Date(Date.now() - days * dayMs),
                quantity: 60
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

feature("a snooze needs a future date, a reason and STOCK_POLICY_PLAN, and is audit-logged", {
    when() {
        const thru = new Date(Date.now() + 10 * dayMs)
        return {
            noReason: policy("rpl_planner", {productId: "RPL_SNZ", snoozeThruDate: thru}),
            past: policy("rpl_planner", {
                productId: "RPL_SNZ",
                snoozeThruDate: new Date(Date.now() - dayMs),
                snoozeReason: "Late"
            }),
            buyer: policy("rpl_buyer", {productId: "RPL_SNZ", snoozeThruDate: thru, snoozeReason: "Supplier closed"}),
            stored: policy("rpl_planner", {productId: "RPL_SNZ", snoozeThruDate: thru, snoozeReason: "Supplier closed"}),
            // another field changed later keeps the snooze
            kept: policy("rpl_planner", {productId: "RPL_SNZ", reorderQuantity: 6})
        }
    },
    then({noReason, past, buyer, stored, kept}) {
        noReason.error.includes("SNOOZE_REASON_REQUIRED")
        past.error.includes("SNOOZE_INVALID")
        buyer.error.includes("stock-planner")
        stored.error == ""
        kept.error == ""
        kept.facilityPolicy.snoozeReason == "Supplier closed"
        rows("moqui.entity.EntityAuditLog", {
            changedEntityName: "mantle.facility.ProductFacility",
            changedFieldName: "snoozeThruDate",
            pkPrimaryValue: "RPL_SNZ"
        }).length == 1
    }
})

feature("a sales shortage is a buy; a rule orders up to its maximum or its reorder quantity; a snoozed rule still shows", {
    when() {
        const ran = plan("rpl_planner")
        const answer = read("rpl_viewer")
        for (const productId of ["RPL_A", "RPL_B", "RPL_MAX", "RPL_FIX", "RPL_SNZ"])
            state[productId] = byProduct(answer, productId).planningSuggestionId
        const explained = run("rpl_viewer", S + "get#SupplyPlan", {
            organizationPartyId: org,
            facilityIds: [warehouse],
            planningSuggestionId: state.RPL_MAX
        })
        return {ran, answer, explained}
    },
    then({ran, answer, explained}) {
        ran.error == ""
        answer.error == ""
        byProduct(answer, "RPL_A").methodEnumId == "PsmBuy"
        byProduct(answer, "RPL_A").supplierPartyId == supplier
        byProduct(answer, "RPL_A").quantity == "7"
        byProduct(answer, "RPL_B").quantity == "4"
        byProduct(answer, "RPL_MAX").quantity == "46"
        byProduct(answer, "RPL_FIX").quantity == "20"
        byProduct(answer, "RPL_SNZ").quantity == "5"
        byProduct(answer, "RPL_SNZ").snoozed == true
        byProduct(answer, "RPL_SNZ").warningText.includes("snoozed until")
        byProduct(answer, "RPL_SNZ").warningText.includes("Supplier closed")
        // a viewer reads the plan but converts nothing
        answer.suggestions.every(row => row.canConvert == false)
        answer.canConvertBuy == false
        explained.demandSupply.some(row => row.kindText == "Reorder rule" && row.quantity == "40")
    }
})

feature("a buyer converts buys to one draft order per supplier; a retry answers it; a competitor is DemandAlreadyCovered", {
    when() {
        const planner = convert("rpl_planner", [state.RPL_A])
        const operationKey = key()
        const converted = convert("rpl_buyer", [state.RPL_A, state.RPL_B], {operationKey})
        const retry = convert("rpl_buyer", [state.RPL_A, state.RPL_B], {operationKey})
        const competing = convert("rpl_buyer2", [state.RPL_A])
        const snoozedAutomatic = convert("rpl_buyer", [state.RPL_SNZ], {automatic: true})
        const first = resultOf(converted, state.RPL_A)
        const header = one("mantle.order.OrderHeader", {orderId: first.orderId || "_NA_"})
        const parts = rows("mantle.order.OrderPart", {orderId: first.orderId || "_NA_"})
        const items = rows("mantle.order.OrderItem", {orderId: first.orderId || "_NA_"})
        const supply = rows("mantle.request.requirement.RequirementSupply", {requirementId: first.requirementId || "_NA_"})
        const requirement = one("mantle.request.requirement.Requirement", {requirementId: first.requirementId || "_NA_"})
        const orders = rows("mantle.order.OrderPart", {vendorPartyId: supplier, customerPartyId: org})
        return {planner, converted, retry, competing, snoozedAutomatic, first, header, parts, items, supply, requirement, orders}
    },
    then({planner, converted, retry, competing, snoozedAutomatic, first, header, parts, items, supply, requirement, orders}) {
        planner.error.includes("PERMISSION_DENIED")
        converted.error == ""
        converted.createdCount == 2
        resultOf(converted, state.RPL_B).orderId == first.orderId
        header.statusId == "OrderOpen"
        parts.length == 1
        parts[0].vendorPartyId == supplier
        parts[0].customerPartyId == org
        parts[0].facilityId == warehouse
        items.length == 2
        items.some(row => row.productId == "RPL_A" && Number(String(row.quantity)) == 7 && Number(String(row.unitAmount)) == 3)
        supply.length == 1
        supply[0].supplyTypeEnumId == "RstPurchaseOrder"
        supply[0].orderItemSeqId == first.orderItemSeqId
        requirement.statusId == "RqmtStOrdered"
        retry.existingCount == 2
        resultOf(retry, state.RPL_A).orderId == first.orderId
        competing.failedCount == 1
        competing.results[0].reasonCode == "DEMAND_ALREADY_COVERED"
        competing.results[0].message.includes(first.orderId)
        snoozedAutomatic.results[0].reasonCode == "SUGGESTION_SNOOZED"
        orders.length == 1
    }
})

feature("the next plan counts the converted draft lines as supply", {
    when() {
        plan("rpl_planner")
        return {answer: read("rpl_planner")}
    },
    then({answer}) {
        byProduct(answer, "RPL_A").productId == null
        byProduct(answer, "RPL_B").productId == null
        byProduct(answer, "RPL_MAX").quantity == "46"
    }
})

feature("suggested levels come from demand history and lead time; one without history is named; rows apply one by one", {
    when() {
        const preview = run("rpl_planner", R + "preview#ReorderLevels", {
            facilityId: warehouse,
            productIds: ["RPL_HIST", "RPL_NOHIST"],
            safetyDays: 7
        })
        const buyer = run("rpl_buyer", R + "preview#ReorderLevels", {facilityId: warehouse, productIds: ["RPL_HIST"]})
        const hist = (preview.levelRows || []).find(row => row.productId === "RPL_HIST") || {}
        const applied = run("rpl_planner", R + "apply#ReorderLevels", {
            changeReason: "Suggested levels",
            reorderMethodEnumId: "RdmUpToMaximum",
            levelRows: [
                {
                    productId: "RPL_HIST",
                    facilityId: warehouse,
                    minimumStock: hist.suggestedMinimum,
                    maximumStock: hist.suggestedMaximum
                },
                {productId: "RPL_NOHIST", facilityId: warehouse, minimumStock: 9, maximumStock: 3}
            ]
        })
        const rule = one("mantle.facility.ProductFacility", {productId: "RPL_HIST", facilityId: warehouse})
        return {preview, buyer, hist, applied, rule}
    },
    then({preview, buyer, hist, applied, rule}) {
        preview.error == ""
        buyer.error.includes("PERMISSION_DENIED")
        hist.averageDailyDemand == "2"
        hist.leadTimeDays == "5"
        hist.leadTimeSource == "Supplier"
        hist.suggestedMinimum == "24"
        hist.suggestedMaximum == "84"
        preview.levelRows.find(row => row.productId == "RPL_NOHIST").reasonCode == "NO_DEMAND_HISTORY"
        preview.failedCount == 1
        applied.appliedCount == 1
        applied.failedCount == 1
        applied.results.find(row => row.productId == "RPL_NOHIST").message.includes("Maximum stock must be at least")
        rule.minimumStock == 24
        rule.maximumStock == 84
        rule.reorderMethodEnumId == "RdmUpToMaximum"
    }
})

feature("reorder-rule rows import through store#ProductFacilityPolicy with a row result each", {
    when() {
        return as("rpl_importer", () => {
            const staged = call(I + "stage#CatalogImport", {
                kindId: "reorderRules",
                organizationPartyId: org,
                sourceText:
                    "productId,facilityId,minimumStock,maximumStock,reorderMethodEnumId,changeReason\n" +
                    "RPL_IMP,RPL_WH,5,15,RdmUpToMaximum,Imported rule\n" +
                    "RPL_IMP2,RPL_WH,9,3,,Imported rule\n"
            })
            const validated = call(I + "validate#CatalogImport", {
                operationKey: staged.operationKey,
                mappingRevision: staged.mappingRevision
            })
            const applied = call(I + "apply#CatalogImport", {
                operationKey: staged.operationKey,
                inputFingerprint: validated.inputFingerprint
            })
            const report = call(I + "get#CatalogImportReport", {operationKey: staged.operationKey, errorsOnly: true})
            return {validated, applied, report}
        })
    },
    then({validated, applied, report}) {
        validated.validCount == 1
        validated.errorCount == 1
        applied.appliedCount == 1
        one("mantle.facility.ProductFacility", {productId: "RPL_IMP", facilityId: warehouse}).maximumStock == 15
        one("mantle.facility.ProductFacility", {productId: "RPL_IMP2", facilityId: warehouse}) == null
        report.reportCsv.includes("Maximum stock must be at least minimum stock")
    }
})
