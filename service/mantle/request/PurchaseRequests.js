// Purchase requests and their sourcing (design-purchasing §4 Requests, RequestDetail and RequestSourcing; crosscut §3.11
// PurchaseSourcingProgress and PurchaseRequestApproval; impl-purchasing P10, R-PUR-01, R-PUR-06, F3, F4): a Request of type
// RqtPurchase whose organization is its OrgInternal RequestParty, its lines RequestItems with a unit and a cost centre
// (PurchaseRequestEntities.xml). Its revision is the time of the last change to a line's audit-logged product, quantity,
// unit, required date, supplier or cost centre. A requester files and submits their own request (no permission: the request
// is their organization's demand, the approval its gate); a buyer (PURCHASE_ORDER_EDIT) edits any of the organization's.
// Submitting sends the PurchaseRequestApproval topic to the approval policy's approvers (PasRequest rows, else the no-policy
// rule; PurchaseApprovals.js); the last step's approval makes each line one approved Requirement of the organization
// (RequirementRequestItem, RequirementParty OrgInternal) and reserves its maximum amount at the request stage
// (reserve#Commitment); a refusal leaves the request Submitted; a cancel releases the unsourced demand and its commitment.
// Sourcing makes one draft purchase order per supplier group through the buyer's order services (create#PurchaseOrder,
// store#PurchaseOrderItem, so their line checks apply), each group in its own transaction under the lock of its
// requirements, with RequestItemOrder and RequirementSupply; a group fails by name and the others go on, a retry with the
// same operation key repeats only the failures, quantity already sourced is refused, and nothing is placed or approved
// (create#PurchaseRequestOrder stays Mantle's, F4). A line for a customer's order line may take the drop-ship route
// (route#OrderItemToDropShip). A purchase order's approval converts a sourced line's request commitment
// (convertOrderCommitments, called by PurchaseOrders.js decide).
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const facilityScope = ec.resource.script("component://mr-mantle/service/mantle/facility/FacilityScope.js")
const policyModule = ec.resource.script("component://mr-mantle/service/mantle/order/PurchasePolicy.js")
const approvals = () => ec.resource.script("component://mr-mantle/service/mantle/order/PurchaseApprovals.js")
const orders = () => ec.resource.script("component://mr-mantle/service/mantle/order/PurchaseOrders.js")
const planning = () => ec.resource.script("component://mr-mantle/service/mantle/product/SupplyPlanning.js")
const {find, one, rows, call, probe, denied, access, ms, dateText} = lib

const REQUEST = "mantle.request.Request",
    ITEM = "mantle.request.RequestItem",
    REQUEST_PARTY = "mantle.request.RequestParty",
    ITEM_ORDER = "mantle.request.RequestItemOrder",
    REQUIREMENT = "mantle.request.requirement.Requirement",
    REQUIREMENT_ITEM = "mantle.request.requirement.RequirementRequestItem",
    SUPPLY = "mantle.request.requirement.RequirementSupply",
    ORDER = "mantle.order.OrderHeader",
    PART = "mantle.order.OrderPart",
    ORDER_ITEM = "mantle.order.OrderItem",
    DECISION = "mantle.order.purchase.PurchaseApprovalDecision",
    COMMITMENT = "mantle.other.budget.BudgetCommitment"
const purchaseType = "RqtPurchase"
// the line fields whose change is the request's revision (audit-logged with "true", F57)
const revisionFields = ["productId", "quantity", "quantityUomId", "requiredByDate", "supplierPartyId", "costCenterId"]
const editableStatuses = ["ReqDraft", "ReqSubmitted"]
const closedStatuses = ["ReqCompleted", "ReqCancelled"]
const liveRequirementStatuses = ["RqmtStApproved", "RqmtStOrdered"]
const deadOrderStatuses = ["OrderCancelled", "OrderRejected"]
// who reads a request of their organization besides its people: its buyers, approvers and planners
const readPermissions = ["PURCHASE_ORDER_EDIT", "PURCHASE_APPROVE", "SUPPLY_PLAN_VIEW", "SUPPLY_PLAN_RUN"]
// the failures a retry may cure once the line or the supplier is fixed
const retryableCodes = [
    "MISSING_SUPPLIER",
    "SUPPLIER_UNAVAILABLE",
    "SUPPLIER_BLOCKED",
    "SUPPLIER_SUSPENDED",
    "SUPPLIER_UNAPPROVED",
    "PRICE_UNAVAILABLE",
    "PRODUCT_NOT_USABLE",
    "PRODUCT_REQUIRED",
    "NO_CUSTOMER_LINE",
    "DROP_SHIP_PENDING",
    "NOT_DROP_SHIPPABLE",
    "NO_DROP_SHIP_FACILITY",
    "PERMISSION_DENIED",
    "FAILED"
]

const blank = value => value == null || String(value).trim() === ""
const text = value => (blank(value) ? null : String(value).trim())
const dec = value => toDecimal(value == null || value === "" ? 0 : value)
const zero = () => toDecimal(0)
const qty = value => (value == null ? "" : dec(value).compare(0) === 0 ? "0" : String(dec(value).toNumber()))
const partyName = partyId => (partyId ? lib.partyNames([partyId])[partyId] || partyId : "")
const statusText = statusId => (statusId ? one("moqui.basic.StatusItem", {statusId})?.description || statusId : "")
const uomText = uomId => (uomId ? one("moqui.basic.Uom", {uomId})?.abbreviation || uomId : "")
const productName = productId => (productId ? one("mantle.product.Product", {productId})?.productName || productId : "")
const money = (value, currencyUomId) =>
    value == null ? "" : currencyUomId ? ec.l10n.formatCurrency(lib.money(value, currencyUomId), currencyUomId) : String(value)
const keyOf = (requestId, requestItemSeqId) => requestId + ":" + requestItemSeqId

function requirePermission(...permissions) {
    if (!permissions.some(permission => access.has(permission)))
        denied("PERMISSION_DENIED", permissions.join(" or ") + " is required")
}
const isInternal = partyId => !!partyId && !!one("mantle.party.PartyRole", {partyId, roleTypeId: "OrgInternal"})
function requireOrganization(organizationPartyId) {
    if (
        !organizationPartyId ||
        !isInternal(organizationPartyId) ||
        !facilityScope.owns(facilityScope.scope(), organizationPartyId)
    )
        denied("RECORD_UNAVAILABLE", "Organization " + (organizationPartyId || "") + " is not available")
    return String(organizationPartyId)
}

// ===== the request =====
// A purchase request of one of the user's organizations (its OrgInternal RequestParty): the request, its organization and
// whether the user is one of its people (the filer, or a party of it other than the organization). A missing request, one of
// another type and one outside the user's organizations are refused alike (RECORD_UNAVAILABLE).
function purchaseRequest(requestId, lock = false) {
    const unavailable = () => denied("RECORD_UNAVAILABLE", "Purchase request " + (requestId || "") + " is not available")
    if (blank(requestId)) unavailable()
    const request = lock ? find(REQUEST, {requestId}).forUpdate(true).one() : one(REQUEST, {requestId})
    if (!request || request.requestTypeEnumId !== purchaseType) unavailable()
    const parties = rows(REQUEST_PARTY, {requestId}).filter(row => lib.active(row))
    const organizationPartyId = parties.find(row => row.roleTypeId === "OrgInternal")?.partyId || null
    if (!organizationPartyId || !facilityScope.owns(facilityScope.scope(), organizationPartyId)) unavailable()
    const partyId = ec.user.userAccount?.partyId || null
    const own =
        !!partyId &&
        (request.filedByPartyId === partyId || parties.some(row => row.partyId === partyId && row.roleTypeId !== "OrgInternal"))
    return {request, requestId: String(requestId), organizationPartyId, own}
}
// A requester edits their own request; a buyer any request of the organization.
function requireEdit(pr) {
    if (!pr.own && !access.has("PURCHASE_ORDER_EDIT"))
        denied(
            "PERMISSION_DENIED",
            "Purchase request " + pr.requestId + " is its requester's, or PURCHASE_ORDER_EDIT is required"
        )
}
function requireRead(pr) {
    if (!pr.own && !readPermissions.some(permission => access.has(permission)))
        denied("PERMISSION_DENIED", "Purchase request " + pr.requestId + " is its people's, or " + readPermissions.join(" or "))
}
const itemsOf = requestId =>
    rows(ITEM, {requestId})
        .filter(item => item.statusId !== "ReqCancelled")
        .sort((a, b) => String(a.requestItemSeqId).localeCompare(String(b.requestItemSeqId)))
// The request's revision: the time of the last change to a line's audit-logged fields (0 before any).
function revisionOf(requestId) {
    const latest = Array.from(
        find("moqui.entity.EntityAuditLog", {changedEntityName: ITEM, pkPrimaryValue: requestId})
            .condition("changedFieldName", "in", revisionFields)
            .orderBy("-changedDate")
            .limit(1)
            .list()
    )[0]
    return latest ? Number(ms(latest.changedDate)) : 0
}
const revisionText = revision => (revision ? dateText(revision) : "")
// The buying organization's currency: the buying policy's, else its accounting currency.
function currencyOf(organizationPartyId) {
    const fromPolicy = policyModule.effective(organizationPartyId).policy.currencyUomId
    if (fromPolicy) return fromPolicy
    return (
        call("mantle.ledger.LedgerServices.find#PartyAcctgPreference", {organizationPartyId}).partyAcctgPreference
            ?.baseCurrencyUomId || null
    )
}
function decimal(value, label, allowZero = false) {
    let number
    try {
        number = toDecimal(value)
    } catch (_) {
        number = null
    }
    if (number == null || number.compare(0) < 0 || (!allowZero && number.isZero()))
        denied("QUANTITY_INVALID", "Enter a " + (allowZero ? "" : "positive ") + label)
    return number
}

// create#PurchaseRequest: a draft purchase request of one of the user's organizations, filed by the user.
function create(p) {
    const organizationPartyId = requireOrganization(text(p.organizationPartyId))
    const requestName = text(p.requestName)
    if (!requestName) denied("NAME_REQUIRED", "Name the request")
    const facilityId = text(p.facilityId)
    if (facilityId && one("mantle.facility.Facility", {facilityId})?.ownerPartyId !== organizationPartyId)
        denied("FACILITY_INVALID", "Choose a facility of " + partyName(organizationPartyId))
    const currencyUomId = text(p.currencyUomId) || currencyOf(organizationPartyId)
    if (currencyUomId && one("moqui.basic.Uom", {uomId: currencyUomId})?.uomTypeEnumId !== "UT_CURRENCY_MEASURE")
        denied("CURRENCY_INVALID", "Choose a currency")
    const rootWorkEffortId = text(p.rootWorkEffortId)
    if (rootWorkEffortId && !one("mantle.work.effort.WorkEffort", {workEffortId: rootWorkEffortId}))
        denied("PROJECT_INVALID", "Choose a project")
    const requestCategoryId = text(p.requestCategoryId)
    if (requestCategoryId && !one("mantle.request.RequestCategory", {requestCategoryId}))
        denied("CATEGORY_INVALID", "Choose a purpose")
    const created = call("mantle.request.RequestServices.create#Request", {
        requestTypeEnumId: purchaseType,
        statusId: "ReqDraft",
        requestName,
        description: text(p.description),
        facilityId,
        currencyUomId,
        requestCategoryId,
        rootWorkEffortId,
        responseRequiredDate: blank(p.responseRequiredDate) ? null : p.responseRequiredDate,
        assignToPartyId: text(p.assignToPartyId)
    })
    call("create#" + REQUEST_PARTY, {
        requestId: created.requestId,
        partyId: organizationPartyId,
        roleTypeId: "OrgInternal",
        fromDate: ec.user.nowTimestamp
    })
    return {requestId: created.requestId}
}

// store#PurchaseRequestItem: a line of a draft or submitted request (new, or changed), or on an approved request the
// buyer's supplier and cost centre of a line still to source.
function storeItem(p) {
    const pr = purchaseRequest(p.requestId, true)
    requireEdit(pr)
    const status = pr.request.statusId
    const sourcingOnly = status === "ReqInProgress"
    if (!editableStatuses.includes(status) && !sourcingOnly)
        denied("REQUEST_CLOSED", "Purchase request " + pr.requestId + " is " + statusText(status) + "; its lines are fixed")
    let item = null
    if (!blank(p.requestItemSeqId)) {
        item = one(ITEM, {requestId: pr.requestId, requestItemSeqId: p.requestItemSeqId})
        if (!item) denied("ITEM_UNAVAILABLE", "Line " + p.requestItemSeqId + " is not on purchase request " + pr.requestId)
    }
    const given = field => Object.keys(p).includes(field) && p[field] !== undefined
    if (sourcingOnly) {
        // an approved line keeps its demand: a buyer chooses its supplier or cost centre for sourcing
        requirePermission("PURCHASE_ORDER_EDIT")
        if (!item) denied("REQUEST_CLOSED", "Purchase request " + pr.requestId + " is approved; add a line on a new request")
        const fixed = ["productId", "quantity", "quantityUomId", "requiredByDate", "maximumAmount"].filter(
            field => given(field) && !blank(p[field]) && String(p[field]) !== String(item[field] ?? "")
        )
        if (fixed.length)
            denied("REQUEST_APPROVED", "An approved line keeps its " + fixed.join(", ") + "; cancel and request again")
    }
    const changes = {}
    const productId = given("productId") ? text(p.productId) : (item?.productId ?? null)
    const product = productId ? one("mantle.product.Product", {productId}) : null
    if (productId && !product) denied("PRODUCT_REQUIRED", "Choose a product")
    if (given("productId") && productId !== (item?.productId ?? null)) changes.productId = productId
    const quantity = given("quantity") && !blank(p.quantity) ? decimal(p.quantity, "quantity") : item ? null : dec(1)
    if (quantity != null) changes.quantity = quantity
    if (given("quantityUomId")) {
        const uomId = text(p.quantityUomId)
        if (uomId && !one("moqui.basic.Uom", {uomId})) denied("UOM_INVALID", "Choose a unit")
        changes.quantityUomId = uomId
    } else if (!item) changes.quantityUomId = product?.amountUomId || null
    if (given("requiredByDate")) changes.requiredByDate = blank(p.requiredByDate) ? null : p.requiredByDate
    else if (!item) changes.requiredByDate = pr.request.responseRequiredDate || null
    if (given("supplierPartyId")) {
        const supplierPartyId = text(p.supplierPartyId)
        if (supplierPartyId) orders().supplierOf(pr.organizationPartyId, supplierPartyId)
        changes.supplierPartyId = supplierPartyId
    }
    if (given("costCenterId")) changes.costCenterId = orders().costCenterOf(pr.organizationPartyId, text(p.costCenterId))
    if (given("maximumAmount")) changes.maximumAmount = blank(p.maximumAmount) ? null : decimal(p.maximumAmount, "amount", true)
    if (given("description")) changes.description = text(p.description)
    if (!item && !productId && !changes.description) denied("ITEM_INVALID", "Choose a product or describe the line")
    // a product line is one the organization may buy (Products' check#ProductUsable, usage Purchase)
    if (productId && (changes.productId || changes.quantity || !item)) {
        const usable = call("mantle.product.ProductServices.check#ProductUsable", {
            productId,
            usage: "Purchase",
            quantity: changes.quantity ?? item?.quantity ?? 1,
            facilityId: pr.request.facilityId || null,
            vendorPartyId: changes.supplierPartyId ?? item?.supplierPartyId ?? null,
            customerPartyId: pr.organizationPartyId
        })
        if (!usable.usable) denied("PRODUCT_NOT_USABLE", usable.reason || productId + " is not usable for buying")
    }
    if (p.changeReason)
        ec.context.putAll(
            Object.fromEntries(Object.keys(changes).map(field => [field + "_changeReason", String(p.changeReason)]))
        )
    let requestItemSeqId = item?.requestItemSeqId
    if (!item) {
        const created = call(
            "create#" + ITEM,
            Object.assign({requestId: pr.requestId, statusId: status}, changes, {
                description: changes.description ?? (product ? product.productName || productId : null)
            })
        )
        requestItemSeqId = created.requestItemSeqId
    } else if (Object.keys(changes).length) {
        call("update#" + ITEM, Object.assign({requestId: pr.requestId, requestItemSeqId}, changes))
    }
    // a submitted request changed goes back to its approvers at its new revision; earlier decisions no longer count
    if (
        status === "ReqSubmitted" &&
        Object.keys(changes).some(field => revisionFields.includes(field) || field === "maximumAmount")
    )
        approvals().notify(requestSource(purchaseRequest(pr.requestId)))
    return {requestId: pr.requestId, requestItemSeqId, sourceRevision: revisionOf(pr.requestId)}
}

// delete#PurchaseRequestItem: a draft's line removed (a submitted request's lines change, so its revision moves).
function removeItem(p) {
    const pr = purchaseRequest(p.requestId, true)
    requireEdit(pr)
    if (pr.request.statusId !== "ReqDraft")
        denied("REQUEST_NOT_DRAFT", "Purchase request " + pr.requestId + " is submitted; change the line's quantity instead")
    if (blank(p.requestItemSeqId) || !one(ITEM, {requestId: pr.requestId, requestItemSeqId: p.requestItemSeqId}))
        denied("ITEM_UNAVAILABLE", "Line " + (p.requestItemSeqId || "") + " is not on purchase request " + pr.requestId)
    call("delete#" + ITEM, {requestId: pr.requestId, requestItemSeqId: String(p.requestItemSeqId)})
    return {requestId: pr.requestId}
}

// ===== the approval =====
// Whether the user filed or submitted the request (self-approval).
function submittedBy(pr, userId, partyId) {
    if (partyId && pr.request.filedByPartyId === partyId) return true
    return rows("moqui.entity.EntityAuditLog", {
        changedEntityName: REQUEST,
        changedFieldName: "statusId",
        pkPrimaryValue: pr.requestId,
        newValueText: "ReqSubmitted"
    }).some(row => row.changedByUserId === userId)
}
// A purchase request as an approval source (PurchaseApprovals.js): its lines' maximum amounts in the request's currency, its
// facility, the categories of its products, its revision and its people.
function requestSource(pr) {
    const items = itemsOf(pr.requestId)
    const amount = items.reduce((total, item) => total.add(dec(item.maximumAmount)), zero())
    // a line with no maximum counts nothing toward the approval bands (F-P10-2): its approvers are told which lines
    const unpricedIds = items.filter(item => item.maximumAmount == null).map(item => item.requestItemSeqId)
    const productIds = [...new Set(items.map(item => item.productId).filter(Boolean))]
    const categoryIds = productIds.length
        ? [
              ...new Set(
                  Array.from(
                      find("mantle.product.category.ProductCategoryMember").condition("productId", "in", productIds).list()
                  )
                      .filter(row => lib.active(row))
                      .map(row => row.productCategoryId)
              )
          ]
        : []
    const revision = revisionOf(pr.requestId)
    return {
        sourceEntityName: REQUEST,
        sourceId: pr.requestId,
        sourceTypeEnumId: "PasRequest",
        organizationPartyId: pr.organizationPartyId,
        supplierPartyId: null,
        amount,
        currencyUomId: pr.request.currencyUomId || null,
        facilityId: pr.request.facilityId || null,
        categoryIds,
        revision,
        statusId: pr.request.statusId,
        label: "purchase request " + pr.requestId,
        unpricedIds,
        message: {
            requestId: pr.requestId,
            requestName: pr.request.requestName || pr.requestId,
            revisionText: revisionText(revision),
            amountText:
                money(amount, pr.request.currencyUomId) +
                (unpricedIds.length ? " + " + unpricedText(unpricedIds).toLowerCase() : "")
        },
        submittedBy: (userId, partyId) => submittedBy(pr, userId, partyId)
    }
}

// The lines of a request with no maximum amount, named for its approvers (F-P10-2).
const unpricedText = ids => (ids.length ? (ids.length === 1 ? "Line " : "Lines ") + ids.join(", ") + " with no amount" : "")

// submit#PurchaseRequest: a draft with lines, each with a product or a description and a quantity, submitted and sent to the
// approvers of its first step.
function submit(p) {
    const pr = purchaseRequest(p.requestId, true)
    requireEdit(pr)
    if (pr.request.statusId !== "ReqDraft")
        denied("NOT_DRAFT", "Purchase request " + pr.requestId + " is " + statusText(pr.request.statusId))
    const items = itemsOf(pr.requestId)
    if (!items.length) denied("NO_ITEMS", "Add a line to purchase request " + pr.requestId + " before submitting it")
    for (const item of items)
        if (dec(item.quantity).compare(0) <= 0 || (!item.productId && blank(item.description)))
            denied("ITEM_INVALID", "Line " + item.requestItemSeqId + " needs a product or description and a quantity")
    call("update#" + REQUEST, {requestId: pr.requestId, statusId: "ReqSubmitted"})
    for (const item of items)
        call("update#" + ITEM, {requestId: pr.requestId, requestItemSeqId: item.requestItemSeqId, statusId: "ReqSubmitted"})
    const source = requestSource(purchaseRequest(pr.requestId))
    const notified = approvals().notify(source)
    return {
        requestId: pr.requestId,
        statusId: "ReqSubmitted",
        sourceRevision: source.revision,
        notifiedCount: notified.notifiedCount
    }
}

// The budget account of a request line: the account a bill of it would post to (get#InvoiceItemGlAccount, incoming), for a
// product line its product's (ItemProduct), else an expense (ItemExpense), with the line's supplier.
function lineAccount(organizationPartyId, item) {
    return (
        call("mantle.ledger.InvoiceAutoPostServices.get#InvoiceItemGlAccount", {
            organizationPartyId,
            otherPartyId: item.supplierPartyId || null,
            itemTypeEnumId: item.productId ? "ItemProduct" : "ItemExpense",
            productId: item.productId || null,
            direction: "I"
        }).glAccountId || null
    )
}
// The accounts of a set of lines under an approved budget of the organization (check#Budget, nothing written).
function controlledAccounts(organizationPartyId, stageEnumId, byAccount) {
    const accounts = Object.keys(byAccount)
    if (!accounts.length) return new Set()
    const checked = call("mantle.other.BudgetServices.check#Budget", {
        organizationPartyId,
        stageEnumId,
        lines: accounts.map(glAccountId => ({glAccountId, amount: byAccount[glAccountId]}))
    })
    return new Set(
        Array.from(checked.checkList || [])
            .filter(row => row.budgetId)
            .map(row => row.glAccountId)
    )
}
// At the request's approval: each line with a maximum amount on an account under an approved budget reserved at the request
// stage, keyed by the request's revision (a Stop refuses, BUDGET_EXCEEDED, unless a BUDGET_OVERRIDE holder gives a reason).
function reserveRequest(pr, revision, overrideReason) {
    const lines = []
    for (const item of itemsOf(pr.requestId)) {
        const amount = dec(item.maximumAmount)
        if (amount.compare(0) <= 0) continue
        const glAccountId = lineAccount(pr.organizationPartyId, item)
        if (glAccountId) lines.push({item, amount, glAccountId})
    }
    if (!lines.length) return 0
    const byAccount = {}
    for (const line of lines) byAccount[line.glAccountId] = dec(byAccount[line.glAccountId]).add(line.amount)
    const controlled = controlledAccounts(pr.organizationPartyId, "BcsRequest", byAccount)
    let reservedCount = 0
    for (const line of lines.filter(row => controlled.has(row.glAccountId))) {
        call("mantle.other.BudgetServices.reserve#Commitment", {
            organizationPartyId: pr.organizationPartyId,
            stageEnumId: "BcsRequest",
            sourceEntityName: REQUEST,
            sourceId: pr.requestId,
            sourceItemId: line.item.requestItemSeqId,
            sourceRevision: String(revision),
            glAccountId: line.glAccountId,
            amount: line.amount,
            currencyUomId: pr.request.currencyUomId || null,
            overrideReason: text(overrideReason)
        })
        reservedCount++
    }
    return reservedCount
}
// At the request's approval: each line one approved Requirement of the organization (a product line RqTpProduct, else
// RqTpInternal), linked through RequirementRequestItem, with the organization as its OrgInternal RequirementParty; a line
// already linked keeps its requirement, brought to the line's quantity, unit and date.
function requirementsOf(pr) {
    const requirementIds = []
    for (const item of itemsOf(pr.requestId)) {
        const values = {
            productId: item.productId || null,
            quantity: item.quantity,
            quantityUomId: item.quantityUomId || null,
            requiredByDate: item.requiredByDate || pr.request.responseRequiredDate || null,
            facilityId: pr.request.facilityId || null,
            estimatedBudget: item.maximumAmount ?? null
        }
        const linked = rows(REQUIREMENT_ITEM, {requestId: pr.requestId, requestItemSeqId: item.requestItemSeqId})[0]
        if (linked) {
            call("update#" + REQUIREMENT, Object.assign({requirementId: linked.requirementId}, values))
            requirementIds.push(linked.requirementId)
            continue
        }
        const created = call(
            "create#" + REQUIREMENT,
            Object.assign(
                {
                    requirementTypeEnumId: item.productId ? "RqTpProduct" : "RqTpInternal",
                    statusId: "RqmtStApproved",
                    description:
                        "Purchase request " +
                        pr.requestId +
                        " line " +
                        item.requestItemSeqId +
                        (item.description ? ": " + item.description : "")
                },
                values
            )
        )
        call("create#" + REQUIREMENT_ITEM, {
            requirementId: created.requirementId,
            requestId: pr.requestId,
            requestItemSeqId: item.requestItemSeqId
        })
        call("create#mantle.request.requirement.RequirementParty", {
            requirementId: created.requirementId,
            partyId: pr.organizationPartyId,
            roleTypeId: "OrgInternal",
            fromDate: ec.user.nowTimestamp
        })
        requirementIds.push(created.requirementId)
    }
    return requirementIds
}

// decide#PurchaseRequestApproval: a purchase approver's decision on the step waiting of a submitted request at its revision
// (PurchaseApprovals.js steps, the PasRequest policy rows or the no-policy rule). A refusal (with its reason) leaves the
// request Submitted; an approval leaving a step waiting sends it on; the last step's approval makes the requirements,
// reserves the budget and puts the request in progress, ready to source. The same operation key answers the first result.
function decide(p) {
    requirePermission("PURCHASE_APPROVE")
    const pr = purchaseRequest(p.requestId, true)
    const decision = String(p.decision || "approve")
    if (!["approve", "refuse"].includes(decision)) denied("DECISION_INVALID", "Approve or refuse the purchase request")
    const request = {
        requestId: pr.requestId,
        sourceRevision: p.sourceRevision == null ? null : Number(p.sourceRevision),
        decision
    }
    const operation = blank(p.operationKey) ? null : lib.operation(p, "PurchaseRequestApproval", pr.organizationPartyId, request)
    if (operation?.old) return lib.previous(operation)
    if (pr.request.statusId !== "ReqSubmitted")
        denied("NOT_SUBMITTED", "Purchase request " + pr.requestId + " is not waiting for approval")
    const source = requestSource(pr)
    if (!blank(p.sourceRevision) && Number(p.sourceRevision) !== source.revision)
        denied(
            "STALE_REVISION",
            "Purchase request " +
                pr.requestId +
                " changed since (revision of " +
                revisionText(source.revision) +
                "); review it again"
        )
    const reason = text(p.reason)
    if (decision === "refuse" && !reason)
        denied("REASON_REQUIRED", "Give the reason for refusing purchase request " + pr.requestId)
    const state = approvals().progress(source)
    if (state.missing)
        denied(
            "POLICY_MISSING",
            "No approval policy of " + partyName(pr.organizationPartyId) + " covers purchase request " + pr.requestId
        )
    const partyId = ec.user.userAccount?.partyId || null
    const refusal = approvals().refusalFor(source, state, ec.user.userId, partyId)
    if (refusal) denied(refusal[0], refusal[1])
    const policyRow = policyModule.effective(pr.organizationPartyId).row
    const step = state.current
    const created = call("create#" + DECISION, {
        sourceEntityName: REQUEST,
        sourceId: pr.requestId,
        sourceRevision: source.revision,
        organizationPartyId: pr.organizationPartyId,
        decisionEnumId: decision === "approve" ? "PadApproved" : "PadRefused",
        decisionDate: ec.user.nowTimestamp,
        decidedByUserId: ec.user.userId,
        decidedByPartyId: partyId,
        reason,
        policyFromDate: policyRow ? policyRow.fromDate : null,
        approvalPolicyId: step?.purchaseApprovalPolicyId || null,
        stepSeqId: step ? String(step.sequenceNum) : null,
        operationKey: operation?.operationKey || null
    })
    const result = {
        requestId: pr.requestId,
        sourceRevision: source.revision,
        purchaseApprovalDecisionId: created.purchaseApprovalDecisionId,
        pendingStepText: null,
        requirementIds: [],
        reservedCount: 0
    }
    if (decision === "refuse") approvals().clearNotices(source)
    else {
        const after = approvals().progress(source)
        if (!after.complete) {
            result.pendingStepText = approvals().stepText(after, after.current)
            approvals().notify(source, after)
        } else {
            result.requirementIds = requirementsOf(pr)
            result.reservedCount = reserveRequest(pr, source.revision, p.budgetOverrideReason)
            call("update#" + REQUEST, {requestId: pr.requestId, statusId: "ReqInProgress"})
            for (const item of itemsOf(pr.requestId))
                call("update#" + ITEM, {
                    requestId: pr.requestId,
                    requestItemSeqId: item.requestItemSeqId,
                    statusId: "ReqInProgress"
                })
            approvals().clearNotices(source)
        }
    }
    result.statusId = one(REQUEST, {requestId: pr.requestId}).statusId
    if (operation) lib.complete(operation, DECISION, created.purchaseApprovalDecisionId, result)
    return Object.assign(result, {alreadyApplied: false})
}

// cancel#PurchaseRequest: an open request cancelled with its reason (in the status change's audit row). Its demand not yet
// sourced is released: a requirement with nothing covered is rejected, one partly covered keeps only what is covered; what
// is left of its commitments is released (release#ClosedSourceCommitments). The purchase orders made from it stay, named in
// orderIds, for the buyer to decide on.
function cancel(p) {
    const pr = purchaseRequest(p.requestId, true)
    requireEdit(pr)
    const reason = text(p.reason)
    if (!reason) denied("REASON_REQUIRED", "Give a reason for cancelling purchase request " + pr.requestId)
    if (closedStatuses.includes(pr.request.statusId))
        denied("REQUEST_CLOSED", "Purchase request " + pr.requestId + " is " + statusText(pr.request.statusId))
    ec.context.putAll({statusId_changeReason: reason})
    call("update#" + REQUEST, {requestId: pr.requestId, statusId: "ReqCancelled"})
    const covered = planning().coveredOf
    for (const link of rows(REQUIREMENT_ITEM, {requestId: pr.requestId})) {
        const requirement = find(REQUIREMENT, {requirementId: link.requirementId}).forUpdate(true).one()
        if (!requirement || !liveRequirementStatuses.includes(requirement.statusId)) continue
        const sourced = covered(requirement.requirementId)
        if (sourced.compare(0) <= 0)
            call("update#" + REQUIREMENT, {requirementId: requirement.requirementId, statusId: "RqmtStRejected", reason})
        else if (sourced.compare(dec(requirement.quantity)) < 0)
            call("update#" + REQUIREMENT, {
                requirementId: requirement.requirementId,
                quantity: sourced,
                statusId: "RqmtStOrdered"
            })
    }
    const released = call("mantle.other.BudgetServices.release#ClosedSourceCommitments", {
        sourceEntityName: REQUEST,
        sourceId: pr.requestId
    })
    approvals().clearNotices(requestSource(purchaseRequest(pr.requestId)))
    // a request a supply plan conversion made no longer covers the plan's demand (impl-purchasing P14b)
    ec.resource.script("component://mr-mantle/service/mantle/product/SupplyPlanningRoutes.js").releaseRequestSupply(pr.requestId)
    const orderIds = [
        ...new Set(
            rows(ITEM_ORDER, {requestId: pr.requestId})
                .map(row => row.orderId)
                .filter(orderId => !deadOrderStatuses.includes(one(ORDER, {orderId})?.statusId))
        )
    ]
    return {requestId: pr.requestId, statusId: "ReqCancelled", releasedCount: released.releasedCount || 0, orderIds}
}

// ===== progress =====
// Whether an order part is a purchase part (the organization buys) or a sales part (it sells).
const isPurchasePart = part => isInternal(part.customerPartyId) && !!part.vendorPartyId && !isInternal(part.vendorPartyId)
const isSalesPart = part => isInternal(part.vendorPartyId) && !isInternal(part.customerPartyId)
function partOf(orderId, orderItemSeqId) {
    const item = one(ORDER_ITEM, {orderId, orderItemSeqId})
    return item ? one(PART, {orderId, orderPartSeqId: item.orderPartSeqId}) : null
}
// A line's customer order line: a RequestItemOrder to a sales part's line (the demand a drop-ship route moves).
function customerLineOf(requestId, requestItemSeqId) {
    return (
        rows(ITEM_ORDER, {requestId, requestItemSeqId}).find(row => {
            const part = partOf(row.orderId, row.orderItemSeqId)
            return !!part && isSalesPart(part)
        }) || null
    )
}
// The requirement of a line (its RequirementRequestItem), or null before approval.
function requirementOfItem(requestId, requestItemSeqId) {
    const link = rows(REQUIREMENT_ITEM, {requestId, requestItemSeqId})[0]
    return link ? one(REQUIREMENT, {requirementId: link.requirementId}) : null
}
const activeSupply = requirementId =>
    rows(SUPPLY, {requirementId}).filter(
        row => row.supplyTypeEnumId !== "RstOperationDemand" && (!row.thruDate || ms(row.thruDate) > ms(ec.user.nowTimestamp))
    )
// The purchase order lines a line was sourced to: each with its order, status, ordered and received quantity.
function orderLinesOf(requestId, requestItemSeqId) {
    const lines = []
    for (const link of rows(ITEM_ORDER, {requestId, requestItemSeqId})) {
        const part = partOf(link.orderId, link.orderItemSeqId)
        if (!part || !isPurchasePart(part)) continue
        const order = one(ORDER, {orderId: link.orderId})
        const item = one(ORDER_ITEM, {orderId: link.orderId, orderItemSeqId: link.orderItemSeqId})
        const ordered = deadOrderStatuses.includes(order.statusId)
            ? zero()
            : dec(item?.quantity).subtract(dec(item?.quantityCancelled))
        const received = rows("mantle.product.receipt.AssetReceipt", {
            orderId: link.orderId,
            orderItemSeqId: link.orderItemSeqId
        }).reduce((total, row) => total.add(dec(row.quantityAccepted)), zero())
        lines.push({
            orderId: link.orderId,
            orderItemSeqId: link.orderItemSeqId,
            orderStatusId: order.statusId,
            orderStatusText: statusText(order.statusId),
            supplierPartyId: part.vendorPartyId,
            supplierName: partyName(part.vendorPartyId),
            ordered,
            orderedText: qty(ordered),
            received,
            receivedText: qty(received)
        })
    }
    return lines
}
// The approval of a request explained for its detail: the state, the step waiting, the decisions at the revision and
// before, and whether the user may decide.
function approvalOf(pr, source) {
    const state = approvals().progress(source)
    const partyId = ec.user.userAccount?.partyId || null
    const refusal = state.current ? approvals().refusalFor(source, state, ec.user.userId, partyId) : null
    const decisions = rows(DECISION, {sourceEntityName: REQUEST, sourceId: pr.requestId})
        .sort((a, b) => ms(b.decisionDate) - ms(a.decisionDate))
        .map(row => ({
            decisionText: row.decisionEnumId === "PadApproved" ? "Approved" : "Refused",
            decidedByText: one("moqui.security.UserAccount", {userId: row.decidedByUserId})?.userFullName || row.decidedByUserId,
            decisionDateText: dateText(row.decisionDate),
            revisionText: revisionText(row.sourceRevision),
            current: Number(row.sourceRevision) === source.revision,
            reason: row.reason || ""
        }))
    const submitted = pr.request.statusId === "ReqSubmitted"
    let stateText = "Not submitted"
    if (["ReqInProgress", "ReqCompleted"].includes(pr.request.statusId)) stateText = "Approved"
    else if (pr.request.statusId === "ReqCancelled") stateText = "Cancelled"
    else if (submitted && state.refused) stateText = "Refused at this revision; change the request to send it again"
    else if (submitted && state.missing) stateText = "No approval policy covers this request"
    else if (submitted && state.current) stateText = "Waiting for " + approvals().stepText(state, state.current)
    return {
        stateText,
        refused: state.refused,
        missing: state.missing,
        currentStepText: state.current ? approvals().stepText(state, state.current) : "",
        // F-P10-2: the lines whose amount the approval bands could not count
        unpricedText: unpricedText(source.unpricedIds || []),
        canDecide: submitted && !!state.current && !state.refused && access.has("PURCHASE_APPROVE") && !refusal,
        refusalText: refusal ? refusal[1] : "",
        decisionRows: decisions
    }
}
// get#PurchaseRequestProgress (crosscut §3.11 PurchaseSourcingProgress, CX-REQUEST): each line's requested quantity and
// unit, the approved quantity of its requirement, what is sourced (its RequirementSupply), ordered and received on its
// purchase order lines, and what remains to source; the request's revision, approval and the actions the user may take.
function progress(p) {
    const pr = purchaseRequest(p.requestId)
    requireRead(pr)
    const request = pr.request
    const source = requestSource(pr)
    const canBuy = access.has("PURCHASE_ORDER_EDIT")
    const open = !closedStatuses.includes(request.statusId)
    const itemRows = itemsOf(pr.requestId).map(item => {
        const requirement = requirementOfItem(pr.requestId, item.requestItemSeqId)
        const live = requirement && liveRequirementStatuses.includes(requirement.statusId)
        const approved = live ? dec(requirement.quantity) : zero()
        const supplies = live ? activeSupply(requirement.requirementId) : []
        const sourced = supplies.reduce((total, row) => total.add(dec(row.quantity)), zero())
        const remaining = approved.subtract(sourced).compare(0) > 0 ? approved.subtract(sourced) : zero()
        const orderLines = orderLinesOf(pr.requestId, item.requestItemSeqId)
        const ordered = orderLines.reduce((total, row) => total.add(row.ordered), zero())
        const received = orderLines.reduce((total, row) => total.add(row.received), zero())
        const customerLine = customerLineOf(pr.requestId, item.requestItemSeqId)
        return {
            requestItemSeqId: item.requestItemSeqId,
            requestItemKey: keyOf(pr.requestId, item.requestItemSeqId),
            productId: item.productId || null,
            productName: item.productId ? productName(item.productId) : "",
            description: item.description || "",
            quantity: item.quantity,
            quantityText: qty(item.quantity),
            quantityUomId: item.quantityUomId || null,
            uomText: uomText(item.quantityUomId),
            requiredByDate: item.requiredByDate || null,
            requiredByText: dateText(item.requiredByDate),
            supplierPartyId: item.supplierPartyId || null,
            supplierName: partyName(item.supplierPartyId),
            costCenterId: item.costCenterId || null,
            costCenterName: partyName(item.costCenterId),
            maximumAmount: item.maximumAmount ?? null,
            maximumText: money(item.maximumAmount, request.currencyUomId),
            requirementId: requirement?.requirementId || null,
            requirementStatusText: requirement ? statusText(requirement.statusId) : "",
            approvedText: live ? qty(approved) : "",
            sourcedText: qty(sourced),
            orderedText: qty(ordered),
            receivedText: qty(received),
            remainingText: live ? qty(remaining) : "",
            remaining: live ? remaining.toNumber() : 0,
            orderLines,
            ordersText: [...new Set(orderLines.map(row => row.orderId))].join(", "),
            customerOrderId: customerLine?.orderId || null,
            customerOrderItemSeqId: customerLine?.orderItemSeqId || null
        }
    })
    const editable = open && (pr.own || canBuy)
    return {
        requestId: pr.requestId,
        requestName: request.requestName || pr.requestId,
        statusId: request.statusId,
        statusText: statusText(request.statusId),
        organizationPartyId: pr.organizationPartyId,
        organizationName: partyName(pr.organizationPartyId),
        filedByPartyId: request.filedByPartyId || null,
        filedByName: partyName(request.filedByPartyId),
        facilityId: request.facilityId || null,
        facilityName: request.facilityId
            ? one("mantle.facility.Facility", {facilityId: request.facilityId})?.facilityName || request.facilityId
            : "",
        currencyUomId: request.currencyUomId || null,
        responseRequiredText: dateText(request.responseRequiredDate),
        requestDateText: dateText(request.requestDate),
        maximumTotalText: money(source.amount, request.currencyUomId),
        sourceRevision: source.revision,
        revisionText: revisionText(source.revision),
        own: pr.own,
        itemRows,
        approval: approvalOf(pr, source),
        canEditItems: editable && editableStatuses.includes(request.statusId),
        canRemoveItems: editable && request.statusId === "ReqDraft",
        canChooseSupplier: open && canBuy && request.statusId === "ReqInProgress",
        canSubmit: editable && request.statusId === "ReqDraft" && itemRows.length > 0,
        canCancel: editable,
        canSource: open && canBuy && itemRows.some(row => row.remaining > 0)
    }
}

// ===== sourcing =====
// The lines a sourcing names: requestItemKeys ("requestId:requestItemSeqId"), lines (maps with the key's parts and an
// optional supplier, quantity and route), or every line of requestIds.
function linesOf(p) {
    const lines = []
    const add = line => {
        const key = keyOf(line.requestId, line.requestItemSeqId)
        if (!lines.some(row => row.key === key)) lines.push(Object.assign({key}, line))
    }
    for (const line of Array.from(p.lines || []))
        add({
            requestId: String(line.requestId),
            requestItemSeqId: String(line.requestItemSeqId),
            supplierPartyId: text(line.supplierPartyId),
            quantity: blank(line.quantity) ? null : line.quantity,
            route: text(line.route)
        })
    const keys = Array.isArray(p.requestItemKeys)
        ? p.requestItemKeys
        : blank(p.requestItemKeys)
          ? []
          : String(p.requestItemKeys).split(",")
    for (const key of keys.map(value => String(value).trim()).filter(Boolean)) {
        const [requestId, requestItemSeqId] = key.split(":")
        if (requestId && requestItemSeqId) add({requestId, requestItemSeqId})
    }
    const requestIds = Array.isArray(p.requestIds) ? p.requestIds : blank(p.requestIds) ? [] : String(p.requestIds).split(",")
    if (!blank(p.requestId)) requestIds.push(String(p.requestId))
    for (const requestId of requestIds.map(value => String(value).trim()).filter(Boolean))
        for (const item of itemsOf(requestId)) add({requestId, requestItemSeqId: item.requestItemSeqId})
    if (!lines.length) denied("DEMAND_REQUIRED", "Choose the request lines to source")
    return lines
}
// One line's demand for sourcing, read again (under its requirement's lock within a group): the request (in the user's
// organizations), its requirement and what remains of it, the supplier and route, and the refusal that keeps it out of a
// group (a code and message), or EXISTING when this operation sourced it already.
function demandOf(line, operationKey, covered) {
    const pr = purchaseRequest(line.requestId)
    const item = one(ITEM, {requestId: pr.requestId, requestItemSeqId: line.requestItemSeqId})
    if (!item) denied("ITEM_UNAVAILABLE", "Line " + line.requestItemSeqId + " is not on purchase request " + pr.requestId)
    const requirement = requirementOfItem(pr.requestId, item.requestItemSeqId)
    const customerLine = customerLineOf(pr.requestId, item.requestItemSeqId)
    const demand = {
        key: line.key,
        requestId: pr.requestId,
        requestItemSeqId: item.requestItemSeqId,
        organizationPartyId: pr.organizationPartyId,
        request: pr.request,
        item,
        requirementId: requirement?.requirementId || null,
        supplierPartyId: line.supplierPartyId || item.supplierPartyId || null,
        route: line.route === "dropship" ? "dropship" : "po",
        facilityId: pr.request.facilityId || null,
        quantityUomId: item.quantityUomId || requirement?.quantityUomId || null,
        revision: revisionOf(pr.requestId),
        customerLine,
        refusal: null,
        existing: null
    }
    const refuse = (code, message) => {
        demand.refusal = {code, message}
        return demand
    }
    if (!requirement || !liveRequirementStatuses.includes(requirement.statusId) || closedStatuses.includes(pr.request.statusId))
        return refuse(
            "NOT_APPROVED",
            "Purchase request " + pr.requestId + " line " + item.requestItemSeqId + " is not approved demand"
        )
    const supplies = activeSupply(requirement.requirementId)
    const mine = operationKey ? supplies.filter(row => row.operationKey === operationKey) : []
    if (mine.length) {
        demand.existing = mine
        return demand
    }
    const sourced = covered(requirement.requirementId)
    const remaining = dec(requirement.quantity).subtract(sourced)
    demand.remaining = remaining.compare(0) > 0 ? remaining : zero()
    demand.quantity = line.quantity == null ? demand.remaining : dec(line.quantity)
    if (remaining.compare(0) <= 0)
        return refuse(
            "ALREADY_SOURCED",
            "Purchase request " +
                pr.requestId +
                " line " +
                item.requestItemSeqId +
                " is already sourced on " +
                supplies.map(row => (row.orderId ? "purchase order " + row.orderId : row.supplyTypeEnumId)).join(", ")
        )
    if (demand.quantity.compare(0) <= 0 || demand.quantity.compare(remaining) > 0)
        return refuse(
            "ALREADY_SOURCED",
            "Purchase request " + pr.requestId + " line " + item.requestItemSeqId + " has " + qty(remaining) + " left to source"
        )
    if (!item.productId) return refuse("PRODUCT_REQUIRED", "Line " + item.requestItemSeqId + " names no product to order")
    if (demand.route === "dropship" && !customerLine)
        return refuse("NO_CUSTOMER_LINE", "Line " + item.requestItemSeqId + " is not for a customer order line")
    if (!demand.supplierPartyId)
        return refuse(
            "MISSING_SUPPLIER",
            "Choose a supplier for purchase request " + pr.requestId + " line " + item.requestItemSeqId
        )
    return demand
}
// The group of a demand: one purchase order per organization, supplier, receiving facility and route.
const groupKeyOf = demand =>
    [demand.organizationPartyId, demand.supplierPartyId || "", demand.facilityId || "", demand.route].join("|")
// The result envelope of a group (design RequestSourcing "Fields for new result envelope").
function envelope(operationKey, demands, fields) {
    const uoms = [...new Set(demands.map(demand => demand.quantityUomId).filter(Boolean))]
    const requested = demands.reduce((total, demand) => total.add(dec(demand.quantity ?? demand.item.quantity)), zero())
    const first = demands[0]
    return Object.assign(
        {
            operationId: operationKey || null,
            supplierGroupId: groupKeyOf(first),
            supplierPartyId: first.supplierPartyId || null,
            supplierName: partyName(first.supplierPartyId),
            route: first.route,
            organizationPartyId: first.organizationPartyId,
            facilityId: first.facilityId,
            sourceRevision: Math.max(...demands.map(demand => demand.revision)),
            requestItemKeys: demands.map(demand => demand.key),
            requirementIds: demands.map(demand => demand.requirementId).filter(Boolean),
            requestedQuantity: qty(requested),
            allocatedQuantity: "0",
            quantityUomId: uoms.length === 1 ? uoms[0] : null,
            resultStatus: "FAILED",
            orderId: null,
            orderPartSeqId: null,
            rfqRequestId: null,
            errorCode: null,
            errorMessage: null,
            retryable: false
        },
        fields
    )
}
// The demands read and sorted into groups: the existing (this operation's, by order), the refused (one group per refusal of
// a supplier group) and the ready ones.
function grouped(p, operationKey) {
    const covered = planning().coveredOf
    const demands = linesOf(p).map(line => {
        try {
            return demandOf(line, operationKey, covered)
        } catch (error) {
            const [requestId, requestItemSeqId] = [line.requestId, line.requestItemSeqId]
            return {
                key: line.key,
                requestId,
                requestItemSeqId,
                organizationPartyId: null,
                supplierPartyId: line.supplierPartyId || null,
                route: "po",
                facilityId: null,
                revision: 0,
                item: {quantity: null},
                refusal: {code: lib.reasonCode(error) || "FAILED", message: String(error.message).replace(/^(Error: )+/, "")}
            }
        }
    })
    const existing = new Map(),
        refused = new Map(),
        ready = new Map()
    for (const demand of demands) {
        if (demand.existing) {
            const orderId = demand.existing[0].orderId || ""
            if (!existing.has(orderId)) existing.set(orderId, [])
            existing.get(orderId).push(demand)
        } else {
            const map = demand.refusal ? refused : ready
            const key = groupKeyOf(demand) + (demand.refusal ? "|" + demand.refusal.code : "")
            if (!map.has(key)) map.set(key, [])
            map.get(key).push(demand)
        }
    }
    return {demands, existing, refused, ready}
}
const existingEnvelope = (operationKey, orderId, demands) =>
    envelope(operationKey, demands, {
        resultStatus: "EXISTING",
        orderId: orderId || null,
        orderPartSeqId: orderId ? rows(PART, {orderId})[0]?.orderPartSeqId || null : null,
        allocatedQuantity: qty(
            demands.reduce(
                (total, demand) => total.add(demand.existing.reduce((sum, row) => sum.add(dec(row.quantity)), zero())),
                zero()
            )
        )
    })
const refusedEnvelope = (operationKey, demands) =>
    envelope(operationKey, demands, {
        errorCode: demands[0].refusal.code,
        errorMessage: demands.map(demand => demand.refusal.message).join("; "),
        retryable: retryableCodes.includes(demands[0].refusal.code)
    })

// A demand row for SourceDemand: the line, its required, sourced and remaining quantity, supplier, route and refusal.
function demandRow(demand) {
    const item = demand.item || {}
    const requirement = demand.requirementId ? one(REQUIREMENT, {requirementId: demand.requirementId}) : null
    return {
        requestItemKey: demand.key,
        requestId: demand.requestId,
        requestItemSeqId: demand.requestItemSeqId,
        requestName: demand.request?.requestName || demand.requestId,
        productId: item.productId || null,
        productName: item.productId ? productName(item.productId) : item.description || "",
        requiredText: requirement ? qty(requirement.quantity) : qty(item.quantity),
        remainingText: demand.remaining != null ? qty(demand.remaining) : "",
        quantityText: demand.quantity != null ? qty(demand.quantity) : "",
        uomText: uomText(demand.quantityUomId),
        requiredByText: dateText(item.requiredByDate),
        facilityId: demand.facilityId,
        supplierPartyId: demand.supplierPartyId,
        supplierName: partyName(demand.supplierPartyId),
        route: demand.route,
        canDropShip: !!demand.customerLine,
        state: demand.existing ? "EXISTING" : demand.refusal ? demand.refusal.code : "READY",
        message: demand.existing
            ? "Sourced on purchase order " + demand.existing.map(row => row.orderId).join(", ")
            : demand.refusal?.message || ""
    }
}
// preview#PurchaseSourcing: the lines and the supplier groups a conversion would make, writing nothing: each ready group's
// supplier check and, for a supplier-price reader, each line's price and the group's amount.
function preview(p) {
    requirePermission("PURCHASE_ORDER_EDIT")
    const operationKey = text(p.operationKey)
    const {demands, existing, refused, ready} = grouped(p, operationKey)
    const groupRows = []
    for (const [orderId, group] of existing) groupRows.push(existingEnvelope(operationKey, orderId, group))
    for (const group of refused.values()) groupRows.push(refusedEnvelope(operationKey, group))
    for (const group of ready.values()) {
        const first = group[0]
        const checked = policyModule.supplierUsable(first.organizationPartyId, first.supplierPartyId)
        if (checked.result === "STOP") {
            groupRows.push(
                envelope(operationKey, group, {errorCode: checked.reasonCode, errorMessage: checked.message, retryable: true})
            )
            continue
        }
        let total = zero(),
            priced = true
        const currencyUomId = first.request.currencyUomId || null
        const lineRows = group.map(demand => {
            const price = call("mantle.product.PriceServices.get#ProductPrice", {
                productId: demand.item.productId,
                quantity: demand.quantity,
                quantityUomId: demand.quantityUomId,
                vendorPartyId: demand.supplierPartyId,
                customerPartyId: demand.organizationPartyId,
                organizationPartyId: demand.organizationPartyId,
                pricePurposeEnumId: "PppPurchase",
                priceUomId: currencyUomId,
                direction: "purchase",
                validDate: ec.user.nowTimestamp
            })
            if (!price.priceAvailable) priced = false
            else total = total.add(dec(price.price).multiply(demand.quantity))
            return {
                requestItemKey: demand.key,
                productId: demand.item.productId,
                quantityText: qty(demand.quantity),
                priceText: price.priceAvailable ? money(price.price, currencyUomId) : "No price you may read"
            }
        })
        const due = group.map(demand => ms(demand.item.requiredByDate)).filter(Number.isFinite)
        groupRows.push(
            envelope(operationKey, group, {
                resultStatus: "READY",
                supplierResult: checked.result,
                supplierMessage: checked.message || "",
                lineRows,
                amountText: priced ? money(total, currencyUomId) : "",
                dueText: due.length ? dateText(Math.min(...due)) : ""
            })
        )
    }
    return {demandRows: demands.map(demandRow), groupRows}
}

// convert#PurchaseSourcing: each supplier group in its own transaction (convert#PurchaseSourcingGroup); a refused line's
// group fails by name and the others go on; this operation's earlier successes answer their orders.
function convert(p) {
    requirePermission("PURCHASE_ORDER_EDIT")
    if (p.placeAndApproveOrders === true || p.placeAndApproveOrders === "true" || p.placeAndApproveOrders === "Y")
        denied("PLACE_NOT_ALLOWED", "Sourcing makes draft purchase orders; place and approve each on its own")
    const operationKey = text(p.operationKey)
    if (!operationKey) denied("OPERATION_KEY_REQUIRED", "An operation key is required")
    const {existing, refused, ready} = grouped(p, operationKey)
    const results = []
    for (const [orderId, group] of existing) results.push(existingEnvelope(operationKey, orderId, group))
    for (const group of refused.values()) results.push(refusedEnvelope(operationKey, group))
    for (const group of ready.values()) {
        const lines = group.map(demand => ({
            requestId: demand.requestId,
            requestItemSeqId: demand.requestItemSeqId,
            quantity: demand.quantity,
            supplierPartyId: demand.supplierPartyId,
            route: demand.route
        }))
        try {
            const out = probe("mantle.request.RequestServices.convert#PurchaseSourcingGroup", {lines, operationKey})
            results.push(
                envelope(operationKey, group, {
                    resultStatus: "CREATED",
                    orderId: out.orderId,
                    orderPartSeqId: out.orderPartSeqId,
                    allocatedQuantity: out.allocatedQuantity
                })
            )
        } catch (error) {
            const message = String(error.message || error).replace(/^(Error: )+/, "")
            const errorCode = lib.reasonCode({message}) || (/([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+):/.exec(message) || [])[1] || "FAILED"
            ec.logger.warn("Sourcing of supplier group " + groupKeyOf(group[0]) + " failed: " + message)
            results.push(
                envelope(operationKey, group, {errorCode, errorMessage: message, retryable: retryableCodes.includes(errorCode)})
            )
        }
    }
    return {
        results,
        createdCount: results.filter(row => row.resultStatus === "CREATED").length,
        existingCount: results.filter(row => row.resultStatus === "EXISTING").length,
        failedCount: results.filter(row => row.resultStatus === "FAILED").length
    }
}
// A sourced line's lineage: the RequestItemOrder, the RequirementSupply under the operation, the requirement Ordered once it
// is covered.
function linkLine(demand, orderId, orderItemSeqId, quantity, operationKey) {
    call("create#" + ITEM_ORDER, {
        requestId: demand.requestId,
        requestItemSeqId: demand.requestItemSeqId,
        orderId,
        orderItemSeqId,
        quantity
    })
    call("create#" + SUPPLY, {
        requirementId: demand.requirementId,
        supplyTypeEnumId: "RstPurchaseOrder",
        orderId,
        orderItemSeqId,
        requestId: demand.requestId,
        requestItemSeqId: demand.requestItemSeqId,
        quantity,
        quantityUomId: demand.quantityUomId,
        operationKey,
        fromDate: ec.user.nowTimestamp,
        createdByUserId: ec.user.userId
    })
    const requirement = one(REQUIREMENT, {requirementId: demand.requirementId})
    if (
        requirement.statusId === "RqmtStApproved" &&
        planning().coveredOf(demand.requirementId).compare(dec(requirement.quantity)) >= 0
    )
        call("update#" + REQUIREMENT, {requirementId: demand.requirementId, statusId: "RqmtStOrdered"})
}
// convert#PurchaseSourcingGroup: one supplier group, in the caller's transaction: its requirements locked in id order, each
// line read again (ALREADY_SOURCED and the other refusals by name), then a draft purchase order through the buyer's services
// with a line per demand, or the drop-ship route of each customer line, and the lineage.
function convertGroup(p) {
    requirePermission("PURCHASE_ORDER_EDIT")
    const operationKey = text(p.operationKey)
    if (!operationKey) denied("OPERATION_KEY_REQUIRED", "An operation key is required")
    const lines = Array.from(p.lines || []).map(line =>
        Object.assign({}, line, {key: keyOf(line.requestId, line.requestItemSeqId)})
    )
    if (!lines.length) denied("DEMAND_REQUIRED", "Choose the request lines to source")
    // the lock on each requirement's remaining quantity: a competing conversion waits here, then reads it covered
    const requirementIds = lines
        .map(line => requirementOfItem(line.requestId, line.requestItemSeqId)?.requirementId)
        .filter(Boolean)
    for (const requirementId of [...new Set(requirementIds)].sort()) find(REQUIREMENT, {requirementId}).forUpdate(true).one()
    const covered = planning().coveredOf
    const demands = lines.map(line => demandOf(line, operationKey, covered))
    for (const demand of demands) {
        if (demand.existing)
            denied(
                "ALREADY_SOURCED",
                "Purchase request " +
                    demand.requestId +
                    " line " +
                    demand.requestItemSeqId +
                    " is already sourced by this operation"
            )
        if (demand.refusal) denied(demand.refusal.code, demand.refusal.message)
    }
    const first = demands[0]
    if (demands.some(demand => groupKeyOf(demand) !== groupKeyOf(first)))
        denied("GROUP_INVALID", "A supplier group is one organization, supplier, facility and route")
    let allocated = zero()
    if (first.route === "dropship") {
        let orderId = null
        for (const demand of demands) {
            const line = demand.customerLine
            call("mantle.order.DropShipServices.route#OrderItemToDropShip", {
                orderId: line.orderId,
                orderItemSeqId: line.orderItemSeqId,
                supplierPartyId: demand.supplierPartyId
            })
            const poLine = Array.from(
                find(ORDER_ITEM)
                    .condition("salesOrderId", line.orderId)
                    .condition("salesOrderItemSeqId", line.orderItemSeqId)
                    .list()
            ).find(row => !deadOrderStatuses.includes(one(ORDER, {orderId: row.orderId})?.statusId))
            if (!poLine)
                denied(
                    "DROP_SHIP_PENDING",
                    "Customer order " + line.orderId + " is not approved, so its drop-ship purchase order is not made yet"
                )
            linkLine(demand, poLine.orderId, poLine.orderItemSeqId, demand.quantity, operationKey)
            allocated = allocated.add(demand.quantity)
            orderId = poLine.orderId
        }
        return {orderId, orderPartSeqId: rows(PART, {orderId})[0]?.orderPartSeqId || null, allocatedQuantity: qty(allocated)}
    }
    const requestIds = [...new Set(demands.map(demand => demand.requestId))]
    const created = call("mantle.order.PurchaseServices.create#PurchaseOrder", {
        organizationPartyId: first.organizationPartyId,
        vendorPartyId: first.supplierPartyId,
        facilityId: first.facilityId,
        orderName: "Purchase request " + requestIds.join(", ")
    })
    for (const demand of demands) {
        const stored = call("mantle.order.PurchaseServices.store#PurchaseOrderItem", {
            orderId: created.orderId,
            productId: demand.item.productId,
            quantity: demand.quantity,
            quantityUomId: demand.quantityUomId,
            requiredByDate: demand.item.requiredByDate || demand.request.responseRequiredDate || null,
            costCenterId: demand.item.costCenterId || null,
            itemDescription: demand.item.description || null
        })
        linkLine(demand, created.orderId, stored.orderItemSeqId, demand.quantity, operationKey)
        allocated = allocated.add(demand.quantity)
    }
    return {orderId: created.orderId, orderPartSeqId: created.orderPartSeqId, allocatedQuantity: qty(allocated)}
}

// ===== the purchase order's approval (PurchaseOrders.js decide) =====
// At the approval of a purchase order: each line sourced from a request line (RequestItemOrder) passes on the request's
// commitment (convert#Commitment, keyed by the order's revision), so the amount is not counted twice; a revised line whose
// request commitment is still open replaces its earlier order commitment and converts the rest; a line with no open request
// commitment is reserved as the order's other lines are (reserve#Commitment, which replaces an earlier revision's), where
// its account is under an approved budget.
function convertOrderCommitments(po, revision, overrideReason) {
    const links = rows(ITEM_ORDER, {orderId: po.orderId})
    if (!links.length) return {convertedCount: 0, reservedCount: 0}
    const order = one(ORDER, {orderId: po.orderId})
    let convertedCount = 0,
        reservedCount = 0
    const toReserve = []
    for (const link of links) {
        const item = one(ORDER_ITEM, {orderId: po.orderId, orderItemSeqId: link.orderItemSeqId})
        if (!item) continue
        const amount = dec(item.quantity).subtract(dec(item.quantityCancelled)).multiply(dec(item.unitAmount))
        if (amount.compare(0) <= 0) continue
        const glAccountId =
            item.overrideGlAccountId ||
            call("mantle.ledger.InvoiceAutoPostServices.get#InvoiceItemGlAccount", {
                organizationPartyId: po.organizationPartyId,
                otherPartyId: po.supplierPartyId,
                itemTypeEnumId: item.itemTypeEnumId || "ItemProduct",
                productId: item.productId || null,
                direction: "I"
            }).glAccountId ||
            null
        if (!glAccountId) continue
        const line = {
            organizationPartyId: po.organizationPartyId,
            stageEnumId: "BcsOrder",
            sourceEntityName: ORDER,
            sourceId: po.orderId,
            sourceItemId: link.orderItemSeqId,
            sourceRevision: String(revision),
            glAccountId,
            amount,
            currencyUomId: order.currencyUomId,
            overrideReason: text(overrideReason)
        }
        const earlier = rows(COMMITMENT, {sourceEntityName: ORDER, sourceId: po.orderId, stageEnumId: "BcsOrder"}).filter(
            row => row.sourceItemId === link.orderItemSeqId && !["BcBlocked", "BcReversed"].includes(row.statusId)
        )
        // the request line's commitment still open; a line that already holds a commitment at this revision (a retry, or a
        // lowered line's) answers it through reserve#Commitment
        const parent = earlier.some(row => String(row.sourceRevision) === String(revision))
            ? null
            : rows(COMMITMENT, {
                  organizationPartyId: po.organizationPartyId,
                  sourceEntityName: REQUEST,
                  sourceId: link.requestId,
                  sourceItemId: link.requestItemSeqId,
                  statusId: "BcReserved"
              })[0]
        if (parent) {
            // a revision of a line converted at an earlier revision (F-P10-6): its earlier order commitment is replaced, as
            // reserve#Commitment replaces an earlier revision's, and the new one converts what the request still holds, so
            // the request's remainder is not held beside the line's new amount (counted twice)
            for (const row of earlier.filter(row => row.statusId === "BcReserved"))
                call("update#" + COMMITMENT, {
                    budgetCommitmentId: row.budgetCommitmentId,
                    statusId: "BcReleased",
                    releasedDate: ec.user.nowTimestamp
                })
            call(
                "mantle.other.BudgetServices.convert#Commitment",
                Object.assign({fromCommitmentId: parent.budgetCommitmentId}, line)
            )
            convertedCount++
        } else toReserve.push(line)
    }
    if (toReserve.length) {
        const byAccount = {}
        for (const line of toReserve) byAccount[line.glAccountId] = dec(byAccount[line.glAccountId]).add(line.amount)
        const controlled = controlledAccounts(po.organizationPartyId, "BcsOrder", byAccount)
        for (const line of toReserve.filter(row => controlled.has(row.glAccountId))) {
            call("mantle.other.BudgetServices.reserve#Commitment", line)
            reservedCount++
        }
    }
    return {convertedCount, reservedCount}
}

// The sources of a purchase order for its Sources section: each line's request line and requirement.
function orderSources(orderId) {
    return rows(ITEM_ORDER, {orderId}).map(link => {
        const request = one(REQUEST, {requestId: link.requestId})
        const supply = rows(SUPPLY, {orderId, orderItemSeqId: link.orderItemSeqId})[0] || null
        return {
            orderItemSeqId: link.orderItemSeqId,
            requestId: link.requestId,
            requestItemSeqId: link.requestItemSeqId,
            requestName: request?.requestName || link.requestId,
            requestTypeEnumId: request?.requestTypeEnumId || null,
            quantityText: qty(link.quantity),
            requirementId: supply?.requirementId || null
        }
    })
}

const operations = {create, storeItem, removeItem, submit, decide, cancel, progress, preview, convert, convertGroup}
;({
    requestSource,
    revisionOf,
    purchaseRequest,
    convertOrderCommitments,
    orderSources,
    execute: (op, parameters) => {
        if (!operations[op]) throw new Error("Unknown purchase request operation " + op)
        return operations[op](parameters || {})
    }
})
