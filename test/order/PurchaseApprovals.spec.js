// Purchase approvals (impl-purchasing P4; design-purchasing ApprovalPolicies, Approvals, Supplier360, D10, F23): the
// effective-dated approval policy rows an administrator stores (an overlapping band, a second row for one step and a step no
// eligible approver can take refused; a change ends the row and starts the next), a purchase order over the first band
// approved in two steps by two approvers with separation and the gate holding approve#Order until the last step, a key
// field's change after a decision superseding it and resubmitting, the topic's handlers refusing a stale revision and a
// refusal rejecting the order, the budget's Stop refusing the approval until an overrider gives a reason and the cancel
// releasing the commitment, and the supplier's onboarding (a new Pending supplier's notice, refusal, submit, approval through
// the topic and suspension). Standalone: a spec-local organization with its accounting configuration, a supplier, a product,
// groups and users, with artifact authorization disabled (the rules are the services' own permission checks).
// Run: ./moq test mr-mantle --spec PurchaseApprovals
const prefix = "PUR_APPROVAL_SPEC"
const org = prefix + "_ORG",
    otherOrg = prefix + "_OTHER_ORG",
    supplier = prefix + "_SUPPLIER",
    product = prefix + "_PRODUCT",
    since = "2000-01-01T00:00:00Z"
const P = "mantle.order.PurchaseServices.",
    O = "mantle.order.OrderServices.",
    B = "mantle.other.BudgetServices."
const ORDER = "mantle.order.OrderHeader"
const find = (entity, conditions = {}) => ec.entity.find(entity).condition(conditions).disableAuthz()
const one = (entity, conditions) => find(entity, conditions).one()
const rows = (entity, conditions) => Array.from(find(entity, conditions).list())
const state = {}

// a call as a user: its result with its error text ("" when it succeeds), in its own transaction
function run(username, service, parameters) {
    login(username)
    ec.artifactExecution.disableAuthz()
    ec.message.pushErrors()
    try {
        const out = ec.service.sync().name(service).parameters(parameters).requireNewTransaction(true).call() || {}
        return Object.assign({}, out, {error: ec.message.hasError() ? ec.message.getErrorsString() : ""})
    } catch (error) {
        return {error: String(error.message || error)}
    } finally {
        ec.message.clearErrors()
        ec.message.popErrors()
        login("john.doe")
        ec.artifactExecution.disableAuthz()
    }
}
function user(kind, permissions, organizationPartyId = org) {
    const id = prefix + "_" + kind
    call("create#moqui.security.UserGroup", {userGroupId: id, description: "Purchase approval " + kind})
    for (const permission of permissions)
        call("create#moqui.security.UserGroupPermission", {userGroupId: id, userPermissionId: permission, fromDate: since})
    call("create#mantle.party.Party", {partyId: id, partyTypeEnumId: "PtyPerson"})
    call("create#mantle.party.Person", {partyId: id, firstName: "Approval", lastName: kind})
    call("create#mantle.party.PartyRelationship", {
        relationshipTypeEnumId: "PrtAgent",
        fromPartyId: id,
        toPartyId: organizationPartyId,
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
function organization(partyId, name, roleTypeId, ownerPartyId) {
    call("create#mantle.party.Party", {partyId, partyTypeEnumId: "PtyOrganization", ownerPartyId: ownerPartyId || null})
    call("create#mantle.party.Organization", {partyId, organizationName: name})
    call("create#mantle.party.PartyRole", {partyId, roleTypeId})
}
// a placed order of the buyer: a draft with one line of the spec product at 7.50, its account given, placed
function placedOrder(quantity, glAccountId) {
    const created = run(state.buyer, P + "create#PurchaseOrder", {organizationPartyId: org, vendorPartyId: supplier})
    const line = run(state.buyer, P + "store#PurchaseOrderItem", {orderId: created.orderId, productId: product, quantity})
    if (glAccountId)
        call(O + "update#OrderItem", {
            orderId: created.orderId,
            orderItemSeqId: line.orderItemSeqId,
            overrideGlAccountId: glAccountId
        })
    run(state.buyer, P + "place#PurchaseOrder", {orderId: created.orderId})
    return created.orderId
}
const statusOf = orderId => one(ORDER, {orderId}).statusId
const revisionOf = orderId => Number(one(ORDER, {orderId}).orderRevision)
// the unread approval messages of a record, by user
function waiting(topic, recordId) {
    const ids = rows("moqui.security.user.NotificationMessage", {topic, recordId}).map(row => row.notificationMessageId)
    if (!ids.length) return []
    return Array.from(
        find("moqui.security.user.NotificationMessageUser")
            .condition("notificationMessageId", "in", ids)
            .condition("viewedDate", "is-null", null)
            .list()
    )
        .map(row => row.userId)
        .sort()
}
// the message of a record's latest revision
function messageOf(topic, recordId) {
    const messages = rows("moqui.security.user.NotificationMessage", {topic, recordId}).map(row =>
        JSON.parse(row.messageJson || "{}")
    )
    return messages.sort((a, b) => Number(b.sourceRevision) - Number(a.sourceRevision))[0] || {}
}
const policyStep = values =>
    run(
        state.admin,
        P + "store#PurchaseApprovalPolicy",
        Object.assign(
            {organizationPartyId: org, sourceTypeEnumId: "PasOrder", currencyUomId: "USD", changeReason: "Spec"},
            values
        )
    )

spec({
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        organization(org, "Purchase Approval Spec Org", "OrgInternal")
        organization(otherOrg, "Purchase Approval Spec Other Org", "OrgInternal")
        call("mantle.ledger.LedgerServices.init#PartyAccountingConfiguration", {
            organizationPartyId: org,
            sourcePartyId: "DefaultSettings",
            baseCurrencyUomId: "USD"
        })
        state.yearId = call("mantle.ledger.LedgerServices.get#OrganizationFiscalTimePeriods", {
            organizationPartyId: org,
            filterDate: ec.user.nowTimestamp,
            timePeriodTypeId: "FiscalYear"
        }).timePeriodList[0].timePeriodId
        state.account = call("mantle.ledger.InvoiceAutoPostServices.get#InvoiceItemGlAccount", {
            organizationPartyId: org,
            itemTypeEnumId: "ItemExpense",
            direction: "I"
        }).glAccountId
        organization(supplier, "Approval Spec Supplier", "Supplier", org)
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
        // the buying policy: the approval gate, the commercial revision and supplier approval on
        call("create#mantle.order.purchase.PurchasePolicy", {
            organizationPartyId: org,
            fromDate: Number(ec.user.nowTimestamp) - 1000,
            approvalGateEnabled: "Y",
            commercialRevisionOnly: "Y",
            supplierApprovalRequired: "Y",
            unapprovedSupplierEnumId: "PusWarn",
            changeReason: "Spec"
        })
        state.admin = user("ADMIN", ["PURCHASE_POLICY_EDIT"])
        state.buyer = user("BUYER", ["PURCHASE_ORDER_EDIT", "SUPPLIER_PRICE_VIEW", "SUPPLIER_PROFILE_EDIT"])
        state.first = user("FIRST", ["PURCHASE_APPROVE", "PURCHASE_ORDER_APPROVE"])
        state.second = user("SECOND", ["PURCHASE_APPROVE", "PURCHASE_ORDER_APPROVE", "BUDGET_OVERRIDE"])
        state.gl = user("GL", ["BUDGET_EDIT", "ACCOUNTING_VIEW"])
        state.budgetApprover = user("BUDGETAPPROVE", ["BUDGET_APPROVE", "ACCOUNTING_VIEW"])
        state.finance = user("FINANCE", ["ACCOUNTING_ADMIN", "ACCOUNTING_VIEW"])
    },
    cleanupSpec() {
        ec.message.clearErrors()
        login("john.doe")
    }
})

feature(
    "an administrator stores a two-band approval policy; a buyer, an overlapping band, a second row for one step, a step no eligible approver can take and another organization are refused; a change ends the row and starts the next",
    {
        when() {
            const small = policyStep({fromAmount: 0, thruAmount: 100, sequenceNum: 1, description: "Up to 100"})
            const largeFirst = policyStep({fromAmount: 100, sequenceNum: 1, description: "Buyer's manager"})
            const largeSecond = policyStep({fromAmount: 100, sequenceNum: 2, separateApprover: "Y", description: "Director"})
            const buyer = run(state.buyer, P + "store#PurchaseApprovalPolicy", {
                organizationPartyId: org,
                sourceTypeEnumId: "PasOrder",
                fromAmount: 500,
                changeReason: "Spec"
            })
            const overlap = policyStep({fromAmount: 50, thruAmount: 150, sequenceNum: 1})
            const sameStep = policyStep({fromAmount: 100, sequenceNum: 2})
            const noApprover = policyStep({fromAmount: 100, sequenceNum: 3, approverUserId: state.buyer})
            const quorum = policyStep({fromAmount: 100, sequenceNum: 3, quorum: 5})
            const otherOrganization = policyStep({organizationPartyId: otherOrg, fromAmount: 0, sequenceNum: 1})
            const startsAt = Number(ec.user.nowTimestamp) + 2000
            const changed = run(state.admin, P + "store#PurchaseApprovalPolicy", {
                purchaseApprovalPolicyId: small.purchaseApprovalPolicyId,
                description: "Up to 100, any approver",
                fromDate: startsAt,
                changeReason: "Clearer name"
            })
            const ended = one("mantle.order.purchase.PurchaseApprovalPolicy", {
                purchaseApprovalPolicyId: small.purchaseApprovalPolicyId
            })
            const next = one("mantle.order.purchase.PurchaseApprovalPolicy", {
                purchaseApprovalPolicyId: changed.purchaseApprovalPolicyId
            })
            const audit = rows("moqui.entity.EntityAuditLog", {
                changedEntityName: "mantle.order.purchase.PurchaseApprovalPolicy",
                pkPrimaryValue: changed.purchaseApprovalPolicyId,
                changedFieldName: "description"
            })
            const previewLarge = run(state.admin, P + "preview#PurchaseApproval", {
                organizationPartyId: org,
                sourceTypeEnumId: "PasOrder",
                amount: 150,
                currencyUomId: "USD"
            })
            const previewSmall = run(state.admin, P + "preview#PurchaseApproval", {
                organizationPartyId: org,
                sourceTypeEnumId: "PasOrder",
                amount: 30,
                currencyUomId: "USD"
            })
            const previewEuro = run(state.admin, P + "preview#PurchaseApproval", {
                organizationPartyId: org,
                sourceTypeEnumId: "PasOrder",
                amount: 30,
                currencyUomId: "EUR"
            })
            return {
                small,
                largeFirst,
                largeSecond,
                buyer,
                overlap,
                sameStep,
                noApprover,
                quorum,
                otherOrganization,
                changed,
                ended,
                next,
                startsAt,
                audit,
                previewLarge,
                previewSmall,
                previewEuro
            }
        },
        then(r) {
            r.small.error == ""
            r.largeFirst.error == ""
            r.largeSecond.error == ""
            r.buyer.error.includes("PERMISSION_DENIED")
            r.overlap.error.includes("POLICY_AMBIGUOUS")
            r.sameStep.error.includes("POLICY_AMBIGUOUS")
            r.noApprover.error.includes("NO_ELIGIBLE_APPROVER")
            r.quorum.error.includes("NO_ELIGIBLE_APPROVER")
            r.otherOrganization.error.includes("RECORD_UNAVAILABLE")
            r.changed.error == ""
            Number(r.ended.thruDate) == r.startsAt
            Number(r.next.fromDate) == r.startsAt
            r.next.fromAmount == 0
            r.next.thruAmount == 100
            r.audit.some(row => row.changeReason == "Clearer name")
            r.previewLarge.preview.stepRows.length == 2
            r.previewLarge.preview.stepRows[1].separateApprover == true
            r.previewLarge.preview.stepRows[0].eligibleCount == 2
            r.previewSmall.preview.stepRows.length == 1
            r.previewSmall.preview.noPolicy == false
            r.previewEuro.preview.missing == true
        }
    }
)

feature(
    "a purchase order over the first band takes two approvers in sequence: the first step's approval leaves it placed and sends the second step, approve#Order is held by the gate, the first approver cannot take the second step, and the second approves it",
    {
        when() {
            const orderId = placedOrder(20)
            const placed = statusOf(orderId)
            const firstNotice = waiting("PurchaseOrderApproval", orderId)
            const buyer = run(state.buyer, P + "decide#PurchaseApproval", {orderId})
            const first = run(state.first, P + "decide#PurchaseApproval", {orderId, orderRevision: revisionOf(orderId)})
            const secondNotice = waiting("PurchaseOrderApproval", orderId)
            const direct = run(state.first, O + "approve#Order", {orderId})
            const again = run(state.first, P + "decide#PurchaseApproval", {orderId})
            const second = run(state.second, P + "decide#PurchaseApproval", {orderId, orderRevision: revisionOf(orderId)})
            const decisions = rows("mantle.order.purchase.PurchaseApprovalDecision", {sourceId: orderId})
            return {
                placed,
                firstNotice,
                buyer,
                first,
                secondNotice,
                direct,
                again,
                second,
                decisions,
                status: statusOf(orderId),
                after: waiting("PurchaseOrderApproval", orderId)
            }
        },
        then(r) {
            r.placed == "OrderPlaced"
            r.firstNotice.join(",") == [state.first, state.second].sort().join(",")
            r.buyer.error.includes("PERMISSION_DENIED")
            r.first.error == ""
            r.first.statusId == "OrderPlaced"
            r.first.pendingStepText.includes("step 2 of 2")
            r.secondNotice.join(",") == state.second
            r.direct.error.includes("PURCHASE_APPROVAL_REQUIRED")
            r.again.error.includes("SEPARATION_REQUIRED")
            r.second.error == ""
            r.second.statusId == "OrderApproved"
            r.decisions.length == 2
            r.decisions.every(row => row.approvalPolicyId && row.decisionEnumId == "PadApproved")
            r.status == "OrderApproved"
            r.after.length == 0
        }
    }
)

feature(
    "a line's change after the first step's decision supersedes it and sends the first step again; the topic's handler refuses the old revision naming the current one, and a refusal with its reason rejects the order",
    {
        when() {
            const orderId = placedOrder(20)
            const reviewed = revisionOf(orderId)
            run(state.first, P + "decide#PurchaseApproval", {orderId, orderRevision: reviewed})
            const item = rows("mantle.order.OrderItem", {orderId})[0]
            call(O + "update#OrderItem", {orderId, orderItemSeqId: item.orderItemSeqId, quantity: 21})
            const revised = revisionOf(orderId)
            const decision = rows("mantle.order.purchase.PurchaseApprovalDecision", {sourceId: orderId})[0]
            const resent = waiting("PurchaseOrderApproval", orderId)
            const stale = run(state.second, P + "approve#PurchaseSource", {
                recordEntityName: ORDER,
                recordId: orderId,
                message: {sourceRevision: reviewed}
            })
            const noReason = run(state.second, P + "refuse#PurchaseSource", {
                recordEntityName: ORDER,
                recordId: orderId,
                message: messageOf("PurchaseOrderApproval", orderId)
            })
            const refused = run(state.second, P + "refuse#PurchaseSource", {
                recordEntityName: ORDER,
                recordId: orderId,
                message: messageOf("PurchaseOrderApproval", orderId),
                reason: "Wrong supplier"
            })
            return {reviewed, revised, decision, resent, stale, noReason, refused, status: statusOf(orderId)}
        },
        then(r) {
            r.revised > r.reviewed
            r.decision.supersededDate != null
            r.resent.join(",") == [state.first, state.second].sort().join(",")
            r.stale.error.includes("STALE_REVISION")
            r.stale.error.includes("revision " + r.revised)
            r.noReason.error.includes("REASON_REQUIRED")
            r.refused.error == ""
            r.status == "OrderRejected"
        }
    }
)

feature(
    "a budget under Stop refuses the approval, an overrider's reason passes it with the commitment reserved at the order's revision, and the cancel releases it",
    {
        given() {
            login(state.gl)
            ec.artifactExecution.disableAuthz()
            const budgetId = call(B + "create#Budget", {timePeriodId: state.yearId, description: "Spec budget"}).budgetId
            call(B + "store#BudgetItem", {budgetId, glAccountId: state.account, amount: 50})
            login(state.budgetApprover)
            ec.artifactExecution.disableAuthz()
            call(B + "change#BudgetState", {budgetId, action: "approve"})
            login(state.finance)
            ec.artifactExecution.disableAuthz()
            call(B + "store#Policy", {
                organizationPartyId: org,
                glAccountId: state.account,
                stageEnumId: "BcsOrder",
                actionEnumId: "BcaStop",
                fromDate: Number(ec.user.nowTimestamp) - 1000,
                changeReason: "Spec"
            })
            login("john.doe")
            ec.artifactExecution.disableAuthz()
        },
        when() {
            const orderId = placedOrder(10, state.account)
            const preview = run(state.first, P + "preview#PurchaseApproval", {orderId})
            const buyerPreview = run(state.buyer, P + "preview#PurchaseApproval", {orderId})
            const stopped = run(state.first, P + "decide#PurchaseApproval", {orderId})
            const stoppedStatus = statusOf(orderId)
            const overridden = run(state.second, P + "decide#PurchaseApproval", {
                orderId,
                budgetOverrideReason: "Urgent repair",
                operationKey: orderId + "-approve"
            })
            // a retry with the operation key answers the first result: one decision, one commitment
            const retried = run(state.second, P + "decide#PurchaseApproval", {
                orderId,
                budgetOverrideReason: "Urgent repair",
                operationKey: orderId + "-approve"
            })
            const decisionCount = rows("mantle.order.purchase.PurchaseApprovalDecision", {sourceId: orderId}).length
            const reserved = rows("mantle.other.budget.BudgetCommitment", {sourceId: orderId, statusId: "BcReserved"})
            const cancelled = run(state.buyer, P + "cancel#PurchaseOrder", {orderId, reason: "No longer needed"})
            const released = rows("mantle.other.budget.BudgetCommitment", {sourceId: orderId, statusId: "BcReleased"})
            return {
                preview,
                buyerPreview,
                stopped,
                stoppedStatus,
                overridden,
                retried,
                decisionCount,
                reserved,
                cancelled,
                released
            }
        },
        then(r) {
            r.preview.preview.budgetResult == "STOP"
            r.buyerPreview.preview.budgetResult == "WITHHELD"
            r.stopped.error.includes("BUDGET_EXCEEDED")
            r.stoppedStatus == "OrderPlaced"
            r.overridden.error == ""
            r.overridden.statusId == "OrderApproved"
            r.retried.alreadyApplied == true
            r.retried.purchaseApprovalDecisionId == r.overridden.purchaseApprovalDecisionId
            r.decisionCount == 1
            r.reserved.length == 1
            r.reserved[0].stageEnumId == "BcsOrder"
            r.reserved[0].decisionEnumId == "BcdOverridden"
            r.cancelled.error == ""
            r.released.length == 1
        }
    }
)

feature(
    "a new supplier starts Pending with its notice to the approvers; a buyer may not decide it, a refusal needs a reason and rejects it; resubmitted, the topic's handler refuses a stale revision and approves the current one; a suspension blocks it",
    {
        when() {
            const created = run(state.buyer, "mantle.party.SupplierServices.create#Supplier", {
                organizationPartyId: org,
                organizationName: "Approval Spec New Supplier"
            })
            const supplierPartyId = created.partyId
            const notice = waiting("PurchaseSupplierApproval", supplierPartyId)
            const decide = parameters =>
                Object.assign({organizationPartyId: org, supplierPartyId, decision: "approve"}, parameters)
            const buyer = run(state.buyer, P + "decide#SupplierApproval", decide({}))
            const noReason = run(state.first, P + "decide#SupplierApproval", decide({decision: "refuse"}))
            const refused = run(state.first, P + "decide#SupplierApproval", decide({decision: "refuse", reason: "No references"}))
            const submitted = run(state.buyer, P + "submit#SupplierApproval", {
                organizationPartyId: org,
                supplierPartyId,
                reason: "References added"
            })
            const message = messageOf("PurchaseSupplierApproval", supplierPartyId)
            const stale = run(state.first, P + "approve#PurchaseSource", {
                recordEntityName: "mantle.party.Party",
                recordId: supplierPartyId,
                message: Object.assign({}, message, {sourceRevision: 1})
            })
            const approved = run(state.first, P + "approve#PurchaseSource", {
                recordEntityName: "mantle.party.Party",
                recordId: supplierPartyId,
                message
            })
            const approvedStatus = run(state.buyer, P + "check#SupplierUsable", {organizationPartyId: org, supplierPartyId})
            const suspended = run(state.buyer, P + "suspend#Supplier", {
                organizationPartyId: org,
                supplierPartyId,
                reason: "Late deliveries"
            })
            const check = run(state.buyer, P + "check#SupplierUsable", {organizationPartyId: org, supplierPartyId})
            const blockedSubmit = run(state.buyer, P + "submit#SupplierApproval", {organizationPartyId: org, supplierPartyId})
            return {
                created,
                notice,
                buyer,
                noReason,
                refused,
                submitted,
                stale,
                approved,
                approvedStatus,
                suspended,
                check,
                blockedSubmit
            }
        },
        then(r) {
            r.created.approvalStatusId == "SupaPending"
            r.notice.join(",") == [state.first, state.second].sort().join(",")
            r.buyer.error.includes("PERMISSION_DENIED")
            r.noReason.error.includes("REASON_REQUIRED")
            r.refused.approvalStatusId == "SupaRejected"
            r.submitted.approvalStatusId == "SupaPending"
            r.submitted.notifiedCount == 2
            r.stale.error.includes("STALE_REVISION")
            r.approved.error == ""
            r.approvedStatus.approvalStatusId == "SupaApproved"
            r.approvedStatus.result == "OK"
            r.suspended.approvalStatusId == "SupaSuspended"
            r.check.result == "STOP"
            r.blockedSubmit.error.includes("SUPPLIER_BLOCKED")
        }
    }
)
