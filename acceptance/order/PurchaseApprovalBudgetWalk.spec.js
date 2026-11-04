// Purchasing P4's budget "usable when" (impl-purchasing P4, D10), Mantle only: under a Warn budget control a purchase order
// over its budget is approved with the warning and its commitment reserved at the order's revision; closing what is left of
// the order (close#PurchaseRemainders, nothing received) releases the unused commitment. The Stop's refusal and the cancel's
// release are the regression PurchaseApprovals spec's. Standalone: a spec-local organization with its accounting
// configuration, a supplier, a product, a budget and users. Run: ./moq accept mr-mantle --spec PurchaseApprovalBudgetWalk
const prefix = "PUR_APPROVAL_BUDGET_WALK"
const org = prefix + "_ORG",
    supplier = prefix + "_SUPPLIER",
    product = prefix + "_PRODUCT",
    since = "2000-01-01T00:00:00Z"
const P = "mantle.order.PurchaseServices.",
    B = "mantle.other.BudgetServices."
const find = (entity, conditions = {}) => ec.entity.find(entity).condition(conditions).disableAuthz()
const one = (entity, conditions) => find(entity, conditions).one()
const rows = (entity, conditions) => Array.from(find(entity, conditions).list())
const state = {}

// a call as a user: its result with its error and warning texts, in its own transaction
function run(username, service, parameters) {
    login(username)
    ec.artifactExecution.disableAuthz()
    ec.message.pushErrors()
    try {
        const out = ec.service.sync().name(service).parameters(parameters).requireNewTransaction(true).call() || {}
        return Object.assign({}, out, {
            error: ec.message.hasError() ? ec.message.getErrorsString() : "",
            messages: Array.from(ec.message.messageInfos || []).map(info => String(info.message))
        })
    } catch (error) {
        return {error: String(error.message || error), messages: []}
    } finally {
        ec.message.clearErrors()
        ec.message.popErrors()
        login("john.doe")
        ec.artifactExecution.disableAuthz()
    }
}
function user(kind, permissions) {
    const id = prefix + "_" + kind
    call("create#moqui.security.UserGroup", {userGroupId: id, description: "Budget walk " + kind})
    for (const permission of permissions)
        call("create#moqui.security.UserGroupPermission", {userGroupId: id, userPermissionId: permission, fromDate: since})
    call("create#mantle.party.Party", {partyId: id, partyTypeEnumId: "PtyPerson"})
    call("create#mantle.party.Person", {partyId: id, firstName: "Budget", lastName: kind})
    call("create#mantle.party.PartyRelationship", {
        relationshipTypeEnumId: "PrtAgent",
        fromPartyId: id,
        toPartyId: org,
        toRoleTypeId: "OrgInternal",
        fromDate: since
    })
    call("create#moqui.security.UserAccount", {
        userId: id,
        username: id,
        partyId: id,
        currentPassword: "16ac58bbfa332c1c55bd98b53e60720bfa90d394",
        passwordHashType: "SHA",
        timeZone: ec.user.userAccount?.timeZone || "America/Chicago"
    })
    call("create#moqui.security.UserGroupMember", {userId: id, userGroupId: id, fromDate: since})
    return id
}

spec({
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        call("create#mantle.party.Party", {partyId: org, partyTypeEnumId: "PtyOrganization"})
        call("create#mantle.party.Organization", {partyId: org, organizationName: "Budget Walk Org"})
        call("create#mantle.party.PartyRole", {partyId: org, roleTypeId: "OrgInternal"})
        call("mantle.ledger.LedgerServices.init#PartyAccountingConfiguration", {
            organizationPartyId: org,
            sourcePartyId: "DefaultSettings",
            baseCurrencyUomId: "USD"
        })
        const yearId = call("mantle.ledger.LedgerServices.get#OrganizationFiscalTimePeriods", {
            organizationPartyId: org,
            filterDate: ec.user.nowTimestamp,
            timePeriodTypeId: "FiscalYear"
        }).timePeriodList[0].timePeriodId
        state.account = call("mantle.ledger.InvoiceAutoPostServices.get#InvoiceItemGlAccount", {
            organizationPartyId: org,
            itemTypeEnumId: "ItemExpense",
            direction: "I"
        }).glAccountId
        call("create#mantle.party.Party", {partyId: supplier, partyTypeEnumId: "PtyOrganization", ownerPartyId: org})
        call("create#mantle.party.Organization", {partyId: supplier, organizationName: "Budget Walk Supplier"})
        call("create#mantle.party.PartyRole", {partyId: supplier, roleTypeId: "Supplier"})
        call("create#mantle.product.Product", {
            productId: product,
            productName: product,
            productTypeEnumId: "PtAsset",
            assetTypeEnumId: "AstTpInventory",
            amountUomId: "OTH_ea",
            ownerPartyId: org,
            statusId: "PrdActive"
        })
        call("create#mantle.product.ProductPrice", {
            productId: product,
            vendorPartyId: supplier,
            pricePurposeEnumId: "PppPurchase",
            priceTypeEnumId: "PptCurrent",
            fromDate: since,
            minQuantity: 1,
            price: 7.5,
            priceUomId: "USD"
        })
        state.buyer = user("BUYER", ["PURCHASE_ORDER_EDIT", "SUPPLIER_PRICE_VIEW"])
        state.approver = user("APPROVER", ["PURCHASE_APPROVE", "PURCHASE_ORDER_APPROVE"])
        const gl = user("GL", ["BUDGET_EDIT", "ACCOUNTING_VIEW"])
        const budgetApprover = user("BUDGETAPPROVE", ["BUDGET_APPROVE", "ACCOUNTING_VIEW"])
        const finance = user("FINANCE", ["ACCOUNTING_ADMIN", "ACCOUNTING_VIEW"])
        login(gl)
        ec.artifactExecution.disableAuthz()
        const budgetId = call(B + "create#Budget", {timePeriodId: yearId, description: "Walk budget"}).budgetId
        call(B + "store#BudgetItem", {budgetId, glAccountId: state.account, amount: 50})
        login(budgetApprover)
        ec.artifactExecution.disableAuthz()
        call(B + "change#BudgetState", {budgetId, action: "approve"})
        login(finance)
        ec.artifactExecution.disableAuthz()
        call(B + "store#Policy", {
            organizationPartyId: org,
            glAccountId: state.account,
            stageEnumId: "BcsOrder",
            actionEnumId: "BcaWarn",
            fromDate: Number(ec.user.nowTimestamp) - 1000,
            changeReason: "Walk: warn over budget"
        })
        login("john.doe")
        ec.artifactExecution.disableAuthz()
    },
    cleanupSpec() {
        ec.message.clearErrors()
        login("john.doe")
    }
})

feature("under a Warn budget control an order over its budget is approved with the warning and its commitment reserved", {
    when() {
        const created = run(state.buyer, P + "create#PurchaseOrder", {organizationPartyId: org, vendorPartyId: supplier})
        state.orderId = created.orderId
        const line = run(state.buyer, P + "store#PurchaseOrderItem", {orderId: state.orderId, productId: product, quantity: 10})
        call("mantle.order.OrderServices.update#OrderItem", {
            orderId: state.orderId,
            orderItemSeqId: line.orderItemSeqId,
            overrideGlAccountId: state.account
        })
        run(state.buyer, P + "place#PurchaseOrder", {orderId: state.orderId})
        const preview = run(state.approver, P + "preview#PurchaseApproval", {orderId: state.orderId})
        const approved = run(state.approver, P + "decide#PurchaseApproval", {orderId: state.orderId})
        const reserved = rows("mantle.other.budget.BudgetCommitment", {sourceId: state.orderId, statusId: "BcReserved"})
        return {preview, approved, reserved}
    },
    then({preview, approved, reserved}) {
        preview.preview.budgetResult == "WARN"
        approved.error == ""
        approved.statusId == "OrderApproved"
        approved.messages.some(message => message.includes("Over budget"))
        reserved.length == 1
        reserved[0].decisionEnumId == "BcdWarned"
        reserved[0].sourceRevision == String(approved.orderRevision)
    }
})

feature("closing the order's remainder with nothing received releases its unused commitment", {
    when() {
        const closed = run(state.buyer, "mantle.order.OrderServices.close#PurchaseRemainders", {
            orderId: state.orderId,
            reason: "Walk: no longer needed"
        })
        return {
            closed,
            reserved: rows("mantle.other.budget.BudgetCommitment", {sourceId: state.orderId, statusId: "BcReserved"}),
            released: rows("mantle.other.budget.BudgetCommitment", {sourceId: state.orderId, statusId: "BcReleased"})
        }
    },
    then({closed, reserved, released}) {
        closed.error == ""
        reserved.length == 0
        released.length == 1
    }
})
