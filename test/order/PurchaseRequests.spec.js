// Purchase requests (impl-purchasing P10; design-purchasing §4, crosscut §3.11, R-PUR-01, R-PUR-06, F3, F4, F5): a requester's
// request of their organization with a line's unit and cost centre, its audit-logged revision and the approval refused once
// the request changed; the requester and another organization refused what is not theirs; the approval through the topic's
// handler making one requirement per line with the organization's role and reserving each line's maximum at the request
// stage, a refusal leaving it submitted; sourcing to one draft purchase order per supplier with the line's cost centre, the
// line with no supplier failing by name, the retry after its supplier is chosen making only its order, another conversion
// refused as already sourced and placeAndApproveOrders refused; the purchase order's approval converting the request's
// commitment (nothing counted twice); a cancel releasing the unsourced demand and its commitment; and a project's work item
// completing leaving a purchase request in progress (CX-REQUEST). Standalone: a spec-local organization with its
// accounting configuration and budget, two suppliers, a product, groups and users, with artifact authorization disabled
// (the rules are the services' own permission checks). Run: ./moq test mr-mantle --spec PurchaseRequests
const prefix = "PUR_REQUEST_SPEC"
const org = prefix + "_ORG",
    otherOrg = prefix + "_OTHER_ORG",
    costCenter = prefix + "_CC",
    supplierA = prefix + "_SUP_A",
    supplierB = prefix + "_SUP_B",
    product = prefix + "_PRODUCT",
    since = "2000-01-01T00:00:00Z"
const R = "mantle.request.RequestServices.",
    P = "mantle.order.PurchaseServices.",
    B = "mantle.other.BudgetServices."
const REQUEST = "mantle.request.Request"
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
    call("create#moqui.security.UserGroup", {userGroupId: id, description: "Purchase request " + kind})
    for (const permission of permissions)
        call("create#moqui.security.UserGroupPermission", {userGroupId: id, userPermissionId: permission, fromDate: since})
    call("create#mantle.party.Party", {partyId: id, partyTypeEnumId: "PtyPerson"})
    call("create#mantle.party.Person", {partyId: id, firstName: "Request", lastName: kind})
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
const statusOf = requestId => one(REQUEST, {requestId}).statusId
const keysOf = requestId =>
    rows("mantle.request.RequestItem", {requestId})
        .map(row => requestId + ":" + row.requestItemSeqId)
        .sort()
// a submitted request of the requester with lines [supplierPartyId, quantity, maximumAmount], the first with the cost centre
function submittedRequest(name, lines) {
    const created = run(state.requester, R + "create#PurchaseRequest", {organizationPartyId: org, requestName: name})
    lines.forEach(([supplierPartyId, quantity, maximumAmount], index) =>
        run(state.requester, R + "store#PurchaseRequestItem", {
            requestId: created.requestId,
            productId: product,
            quantity,
            supplierPartyId,
            maximumAmount,
            costCenterId: index === 0 ? costCenter : null
        })
    )
    run(state.requester, R + "submit#PurchaseRequest", {requestId: created.requestId})
    return created.requestId
}
const approve = requestId => run(state.approver, R + "decide#PurchaseRequestApproval", {requestId})

spec({
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        organization(org, "Purchase Request Spec Org", "OrgInternal")
        organization(otherOrg, "Purchase Request Spec Other Org", "OrgInternal")
        organization(costCenter, "Purchase Request Spec Workshop", "OrgInternal")
        call("create#mantle.party.PartyRelationship", {
            relationshipTypeEnumId: "PrtOrgRollup",
            fromPartyId: costCenter,
            fromRoleTypeId: "OrgInternal",
            toPartyId: org,
            toRoleTypeId: "OrgInternal",
            fromDate: since
        })
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
        organization(supplierA, "Request Spec Supplier A", "Supplier", org)
        organization(supplierB, "Request Spec Supplier B", "Supplier", org)
        call("create#mantle.product.Product", {
            productId: product,
            productName: product,
            productTypeEnumId: "PtAsset",
            assetTypeEnumId: "AstTpInventory",
            amountUomId: "OTH_ea",
            ownerPartyId: org,
            statusId: "PrdActive"
        })
        for (const vendorPartyId of [supplierA, supplierB])
            call("create#mantle.product.ProductPrice", {
                productId: product,
                vendorPartyId,
                pricePurposeEnumId: "PppPurchase",
                priceTypeEnumId: "PptCurrent",
                fromDate: since,
                minQuantity: 1,
                price: 10,
                priceUomId: "USD"
            })
        state.account = call("mantle.ledger.InvoiceAutoPostServices.get#InvoiceItemGlAccount", {
            organizationPartyId: org,
            itemTypeEnumId: "ItemProduct",
            productId: product,
            direction: "I"
        }).glAccountId
        state.requester = user("REQUESTER", [])
        state.otherRequester = user("OTHER_REQUESTER", [])
        state.outsider = user("OUTSIDER", [], otherOrg)
        state.buyer = user("BUYER", ["PURCHASE_ORDER_EDIT", "SUPPLIER_PRICE_VIEW"])
        state.approver = user("APPROVER", ["PURCHASE_APPROVE", "PURCHASE_ORDER_APPROVE"])
        state.gl = user("GL", ["BUDGET_EDIT", "ACCOUNTING_VIEW"])
        state.budgetApprover = user("BUDGETAPPROVE", ["BUDGET_APPROVE", "ACCOUNTING_VIEW"])
        // an approved budget on the product's account, so a request's maximum is reserved and a purchase order converts it
        login(state.gl)
        ec.artifactExecution.disableAuthz()
        state.budgetId = call(B + "create#Budget", {timePeriodId: state.yearId, description: "Request spec budget"}).budgetId
        call(B + "store#BudgetItem", {budgetId: state.budgetId, glAccountId: state.account, amount: 100000})
        login(state.budgetApprover)
        ec.artifactExecution.disableAuthz()
        call(B + "change#BudgetState", {budgetId: state.budgetId, action: "approve"})
        login("john.doe")
        ec.artifactExecution.disableAuthz()
    },
    cleanupSpec() {
        ec.message.clearErrors()
        login("john.doe")
    }
})

feature(
    "a requester files a request of their organization with a line's unit and cost centre; another organization, another requester's request and a decision on a changed request are refused; the topic's approval makes one requirement per line with the organization's role and reserves the maximum",
    {
        when() {
            const outside = run(state.requester, R + "create#PurchaseRequest", {organizationPartyId: otherOrg, requestName: "X"})
            const created = run(state.requester, R + "create#PurchaseRequest", {
                organizationPartyId: org,
                requestName: "Shop supplies"
            })
            const requestId = created.requestId
            const line = run(state.requester, R + "store#PurchaseRequestItem", {
                requestId,
                productId: product,
                quantity: 4,
                maximumAmount: 60,
                costCenterId: costCenter
            })
            const badCostCenter = run(state.requester, R + "store#PurchaseRequestItem", {
                requestId,
                productId: product,
                quantity: 1,
                costCenterId: otherOrg
            })
            const otherEdit = run(state.otherRequester, R + "store#PurchaseRequestItem", {
                requestId,
                productId: product,
                quantity: 1
            })
            const outsiderRead = run(state.outsider, R + "get#PurchaseRequestProgress", {requestId})
            const submitted = run(state.requester, R + "submit#PurchaseRequest", {requestId})
            const notified = rows("moqui.security.user.NotificationMessage", {
                topic: "PurchaseRequestApproval",
                recordId: requestId
            })
            const requesterDecides = run(state.requester, R + "decide#PurchaseRequestApproval", {requestId})
            // the requester changes the quantity: a new revision, so a decision on the reviewed one is refused
            const changed = run(state.requester, R + "store#PurchaseRequestItem", {
                requestId,
                requestItemSeqId: line.requestItemSeqId,
                quantity: 5,
                changeReason: "One more"
            })
            const stale = run(state.approver, R + "decide#PurchaseRequestApproval", {
                requestId,
                sourceRevision: submitted.sourceRevision
            })
            const refusedNoReason = run(state.approver, R + "decide#PurchaseRequestApproval", {requestId, decision: "refuse"})
            // the approval through the topic's handler, at the revision of the newest message
            const message = rows("moqui.security.user.NotificationMessage", {
                topic: "PurchaseRequestApproval",
                recordId: requestId
            })
                .map(row => JSON.parse(row.messageJson || "{}"))
                .sort((a, b) => Number(b.sourceRevision) - Number(a.sourceRevision))[0]
            const approved = run(state.approver, P + "approve#PurchaseSource", {
                recordEntityName: REQUEST,
                recordId: requestId,
                message
            })
            const item = one("mantle.request.RequestItem", {requestId, requestItemSeqId: line.requestItemSeqId})
            const audit = rows("moqui.entity.EntityAuditLog", {
                changedEntityName: "mantle.request.RequestItem",
                pkPrimaryValue: requestId,
                changedFieldName: "quantity"
            })
            const link = rows("mantle.request.requirement.RequirementRequestItem", {requestId})
            const requirement = link.length
                ? one("mantle.request.requirement.Requirement", {requirementId: link[0].requirementId})
                : {}
            const requirementParty = link.length
                ? rows("mantle.request.requirement.RequirementParty", {requirementId: link[0].requirementId})
                : []
            const reserved = rows("mantle.other.budget.BudgetCommitment", {sourceId: requestId, stageEnumId: "BcsRequest"})
            const progress = run(state.requester, R + "get#PurchaseRequestProgress", {requestId}).progress || {}
            return {
                outside,
                created,
                line,
                badCostCenter,
                otherEdit,
                outsiderRead,
                submitted,
                notified,
                requesterDecides,
                changed,
                stale,
                refusedNoReason,
                approved,
                item,
                audit,
                link,
                requirement,
                requirementParty,
                reserved,
                progress,
                status: statusOf(requestId)
            }
        },
        then(r) {
            r.outside.error.includes("RECORD_UNAVAILABLE")
            r.created.error == ""
            r.line.error == ""
            r.badCostCenter.error.includes("COST_CENTER_INVALID")
            r.otherEdit.error.includes("PERMISSION_DENIED")
            r.outsiderRead.error.includes("RECORD_UNAVAILABLE")
            r.submitted.statusId == "ReqSubmitted"
            r.submitted.sourceRevision > 0
            r.notified.length >= 1
            r.requesterDecides.error.includes("PERMISSION_DENIED")
            r.changed.error == ""
            r.changed.sourceRevision > r.submitted.sourceRevision
            r.stale.error.includes("STALE_REVISION")
            r.refusedNoReason.error.includes("REASON_REQUIRED")
            r.approved.error == ""
            r.item.quantityUomId == "OTH_ea"
            r.item.costCenterId == costCenter
            r.audit.some(row => row.changeReason == "One more")
            r.link.length == 1
            r.requirement.statusId == "RqmtStApproved"
            r.requirement.requirementTypeEnumId == "RqTpProduct"
            r.requirement.quantity.toNumber() == 5
            r.requirement.quantityUomId == "OTH_ea"
            r.requirementParty.some(row => row.partyId == org && row.roleTypeId == "OrgInternal")
            r.reserved.length == 1
            r.reserved[0].amount.toNumber() == 60
            r.reserved[0].statusId == "BcReserved"
            r.status == "ReqInProgress"
            r.progress.approval.stateText == "Approved"
            r.progress.itemRows[0].remainingText == "5"
        }
    }
)

feature("a refusal leaves the request submitted with the refused decision, and needs a purchase approver", {
    when() {
        const requestId = submittedRequest("Refused supplies", [[supplierA, 2, null]])
        const refused = run(state.approver, R + "decide#PurchaseRequestApproval", {
            requestId,
            decision: "refuse",
            reason: "Use stock"
        })
        const decision = rows("mantle.order.purchase.PurchaseApprovalDecision", {sourceId: requestId})[0] || {}
        return {refused, decision, status: statusOf(requestId)}
    },
    then(r) {
        r.refused.error == ""
        r.decision.decisionEnumId == "PadRefused"
        r.status == "ReqSubmitted"
    }
})

feature(
    "sourcing makes one draft order per supplier with the line's cost centre and names the line with no supplier; the retry after its supplier is chosen makes only its order; another conversion is refused as already sourced; nothing is placed",
    {
        when() {
            const requestId = submittedRequest("Three lines", [
                [supplierA, 3, 40],
                [supplierB, 2, null],
                [null, 1, null]
            ])
            approve(requestId)
            state.sourcedRequestId = requestId
            const keys = keysOf(requestId)
            const requester = run(state.requester, R + "convert#PurchaseSourcing", {
                requestItemKeys: keys,
                operationKey: "spec-src-1"
            })
            const placing = run(state.buyer, R + "convert#PurchaseSourcing", {
                requestItemKeys: keys,
                operationKey: "spec-src-0",
                placeAndApproveOrders: "true"
            })
            const preview = run(state.buyer, R + "preview#PurchaseSourcing", {requestItemKeys: keys})
            const first = run(state.buyer, R + "convert#PurchaseSourcing", {requestItemKeys: keys, operationKey: "spec-src-1"})
            // the buyer chooses the third line's supplier, and retries the same operation
            run(state.buyer, R + "store#PurchaseRequestItem", {
                requestId,
                requestItemSeqId: keys[2].split(":")[1],
                supplierPartyId: supplierB
            })
            const retry = run(state.buyer, R + "convert#PurchaseSourcing", {requestItemKeys: keys, operationKey: "spec-src-1"})
            const again = run(state.buyer, R + "convert#PurchaseSourcing", {requestItemKeys: keys, operationKey: "spec-src-2"})
            const created = (first.results || []).filter(row => row.resultStatus == "CREATED")
            const orderA = created.find(row => row.supplierPartyId == supplierA)?.orderId
            const lineA = orderA ? rows("mantle.order.OrderItem", {orderId: orderA})[0] : {}
            const supply = rows("mantle.request.requirement.RequirementSupply", {requestId})
            const orderStatuses = [
                ...new Set(supply.map(row => one("mantle.order.OrderHeader", {orderId: row.orderId}).statusId))
            ]
            return {requester, placing, preview, first, retry, again, created, lineA, supply, orderStatuses}
        },
        then(r) {
            r.requester.error.includes("PERMISSION_DENIED")
            r.placing.error.includes("PLACE_NOT_ALLOWED")
            r.preview.groupRows.filter(row => row.resultStatus == "READY").length == 2
            r.preview.groupRows.some(row => row.errorCode == "MISSING_SUPPLIER" && row.retryable)
            r.first.createdCount == 2
            r.first.failedCount == 1
            r.first.results.some(row => row.errorCode == "MISSING_SUPPLIER")
            r.lineA.costCenterId == costCenter
            r.lineA.quantity.toNumber() == 3
            r.retry.createdCount == 1
            r.retry.existingCount == 2
            r.retry.failedCount == 0
            r.again.createdCount == 0
            r.again.results.every(row => row.errorCode == "ALREADY_SOURCED" && !row.retryable)
            r.supply.length == 3
            r.orderStatuses.join(",") == "OrderOpen"
        }
    }
)

feature("approving a sourced purchase order converts the request's commitment, so the amount is not counted twice", {
    when() {
        const requestId = state.sourcedRequestId
        const link = rows("mantle.request.RequestItemOrder", {requestId, requestItemSeqId: "01"})[0]
        const orderId = link.orderId
        const before = rows("mantle.other.budget.BudgetCommitment", {sourceId: requestId, stageEnumId: "BcsRequest"})
        run(state.buyer, P + "place#PurchaseOrder", {orderId})
        const decided = run(state.approver, P + "decide#PurchaseApproval", {orderId})
        const order = rows("mantle.other.budget.BudgetCommitment", {sourceId: orderId, stageEnumId: "BcsOrder"})
        const parent = one("mantle.other.budget.BudgetCommitment", {budgetCommitmentId: before[0]?.budgetCommitmentId})
        return {before, decided, order, parent}
    },
    then(r) {
        r.before.length == 1
        r.decided.error == ""
        r.decided.statusId == "OrderApproved"
        r.order.length == 1
        r.order[0].convertedFromId == r.before[0].budgetCommitmentId
        r.order[0].amount.toNumber() == 30
        r.parent.statusId == "BcReserved"
    }
})

feature("a cancel releases the unsourced demand and its commitment, and names the orders made from the request", {
    when() {
        const requestId = submittedRequest("Cancelled supplies", [[supplierA, 2, 25]])
        approve(requestId)
        const requirementId = rows("mantle.request.requirement.RequirementRequestItem", {requestId})[0].requirementId
        const noReason = run(state.requester, R + "cancel#PurchaseRequest", {requestId})
        const cancelled = run(state.requester, R + "cancel#PurchaseRequest", {requestId, reason: "Project dropped"})
        const commitments = rows("mantle.other.budget.BudgetCommitment", {sourceId: requestId})
        const sourcedCancel = run(state.buyer, R + "cancel#PurchaseRequest", {requestId: state.sourcedRequestId, reason: "Spec"})
        return {
            noReason,
            cancelled,
            requirement: one("mantle.request.requirement.Requirement", {requirementId}),
            commitments,
            sourcedCancel,
            status: statusOf(requestId)
        }
    },
    then(r) {
        r.noReason.error.includes("REASON_REQUIRED")
        r.cancelled.error == ""
        r.status == "ReqCancelled"
        r.requirement.statusId == "RqmtStRejected"
        r.commitments.every(row => row.statusId == "BcReleased")
        r.cancelled.releasedCount == 1
        r.sourcedCancel.orderIds.length == 3
    }
})

feature("a project's work item linked to a purchase request completes and the request stays in progress (CX-REQUEST)", {
    when() {
        call("mantle.work.ProjectServices.create#Project", {
            workEffortId: "PURREQP",
            workEffortName: "Purchase request project",
            visibilityEnumId: "WevWorkGroup",
            assignToPartyId: "EX_JOHN_DOE",
            assignRoleTypeId: "ProjectManager"
        })
        call("mantle.work.ProjectServices.store#ProjectSetting", {
            workEffortId: "PURREQP",
            settingTypeEnumId: "WstModules",
            settingValue: "requests"
        })
        const created = run(state.requester, R + "create#PurchaseRequest", {
            organizationPartyId: org,
            requestName: "Project supplies",
            rootWorkEffortId: "PURREQP"
        })
        run(state.requester, R + "store#PurchaseRequestItem", {requestId: created.requestId, productId: product, quantity: 1})
        run(state.requester, R + "submit#PurchaseRequest", {requestId: created.requestId})
        approve(created.requestId)
        const task = call(R + "make#RequestWorkItem", {
            requestId: created.requestId,
            workEffortName: "Fit the parts"
        }).workEffortId
        call("mantle.work.TaskServices.set#TaskStatus", {workEffortId: task, statusId: "WeInProgress"})
        call("mantle.work.TaskServices.set#TaskStatus", {workEffortId: task, statusId: "WeComplete"})
        return {status: statusOf(created.requestId)}
    },
    then(r) {
        r.status == "ReqInProgress"
    }
})
