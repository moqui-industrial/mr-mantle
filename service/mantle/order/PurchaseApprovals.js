// Purchase approval policies and their steps (design-purchasing ApprovalPolicies, Approvals, Supplier360; impl-purchasing
// P4, §2, F23): the effective-dated PurchaseApprovalPolicy rows of an organization and source type (store, with the
// ambiguous band and the band with no eligible approver refused), the steps a source's amount, currency, category and
// facility select (the most specific rows; with no row in effect the no-policy rule, one step by a purchase approver), each
// step's progress at the source's revision (its approvals, quorum and expiry), who may decide it (the approver named, the
// group, self-approval, separation from an earlier step), the PurchaseOrderApproval and PurchaseSupplierApproval messages to
// the approvers of the step waiting, a superseded revision's decisions and their resubmission, the approval preview with the
// budget check, the supplier's onboarding (submit, decide, suspend) and the topics' approve and refuse handlers.
// PurchaseOrders.js decides a purchase order with these.
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const facilityScope = ec.resource.script("component://mr-mantle/service/mantle/facility/FacilityScope.js")
const policyModule = ec.resource.script("component://mr-mantle/service/mantle/order/PurchasePolicy.js")
const orders = () => ec.resource.script("component://mr-mantle/service/mantle/order/PurchaseOrders.js")
const {find, one, rows, call, denied, access, ms} = lib

const POLICY = "mantle.order.purchase.PurchaseApprovalPolicy",
    DECISION = "mantle.order.purchase.PurchaseApprovalDecision",
    ORDER = "mantle.order.OrderHeader",
    ITEM = "mantle.order.OrderItem",
    PARTY = "mantle.party.Party",
    PROFILE = "mantle.party.supplier.SupplierProfile",
    REQUEST = "mantle.request.Request"
// each source's topic and policy source type; P10 adds requests (PurchaseRequests.js requestSource); P12's award is the RFQ
// (a Request) with its own topic and type (Awards.js awardSource: source.topic, PasAward)
const topics = {[ORDER]: "PurchaseOrderApproval", [PARTY]: "PurchaseSupplierApproval", [REQUEST]: "PurchaseRequestApproval"}
// P13: a purchase agreement is approved as a purchase order is, on its topic (§4; PurchaseAgreements.js)
const AGREEMENT = "mantle.party.agreement.Agreement"
const agreements = () => ec.resource.script("component://mr-mantle/service/mantle/party/PurchaseAgreements.js")
topics[AGREEMENT] = "PurchaseOrderApproval"
const sourceTypes = {[ORDER]: "PasOrder", [PARTY]: "PasSupplier", [REQUEST]: "PasRequest"}
const policyFields = [
    "organizationPartyId",
    "sourceTypeEnumId",
    "fromAmount",
    "thruAmount",
    "currencyUomId",
    "productCategoryId",
    "facilityId",
    "sequenceNum",
    "approverUserId",
    "approverUserGroupId",
    "quorum",
    "selfApprovalAllowed",
    "separateApprover",
    "expiryDays",
    "description"
]
const dayMs = 24 * 60 * 60 * 1000
const blank = value => value == null || String(value).trim() === ""
const text = value => (blank(value) ? null : String(value).trim())
const dec = value => toDecimal(value ?? 0)
const now = () => ms(ec.user.nowTimestamp)
const partyName = partyId => lib.partyNames([partyId])[partyId] || partyId || ""
const userName = userId => (userId ? one("moqui.security.UserAccount", {userId})?.userFullName || userId : "")
const quorumOf = step => Math.max(1, Number(step.quorum || 1))
const money = (value, currencyUomId) =>
    value == null ? "" : currencyUomId ? ec.l10n.formatCurrency(lib.money(value, currencyUomId), currencyUomId) : String(value)

function requirePermission(...permissions) {
    if (!permissions.some(permission => access.has(permission)))
        denied("PERMISSION_DENIED", permissions.join(" or ") + " is required")
}
function requireOrganization(organizationPartyId) {
    if (
        !organizationPartyId ||
        !one("mantle.party.PartyRole", {partyId: organizationPartyId, roleTypeId: "OrgInternal"}) ||
        !facilityScope.owns(facilityScope.scope(), organizationPartyId)
    )
        denied("RECORD_UNAVAILABLE", "Organization " + (organizationPartyId || "") + " is not available")
    return String(organizationPartyId)
}

// ===== approvers =====
// The users who may approve in an organization: active members of a group holding PURCHASE_APPROVE whose party is an agent,
// employee or member of the organization, not disabled.
function approvers(organizationPartyId) {
    const groupIds = rows("moqui.security.UserGroupPermission", {userPermissionId: "PURCHASE_APPROVE"})
        .filter(row => lib.active(row))
        .map(row => row.userGroupId)
    if (!groupIds.length) return []
    const userIds = [
        ...new Set(
            Array.from(find("moqui.security.UserGroupMember").condition("userGroupId", "in", groupIds).list())
                .filter(row => lib.active(row))
                .map(row => row.userId)
        )
    ]
    if (!userIds.length) return []
    const accounts = Array.from(find("moqui.security.UserAccount").condition("userId", "in", userIds).list()).filter(
        row => row.partyId && row.disabled !== "Y"
    )
    if (!accounts.length) return []
    const members = new Set(
        Array.from(
            find("mantle.party.PartyRelationship", {toPartyId: organizationPartyId})
                .condition("relationshipTypeEnumId", "in", ["PrtAgent", "PrtEmployee", "PrtMember"])
                .condition(
                    "fromPartyId",
                    "in",
                    accounts.map(row => row.partyId)
                )
                .list()
        )
            .filter(row => lib.active(row))
            .map(row => row.fromPartyId)
    )
    return accounts.filter(row => members.has(row.partyId)).map(row => ({userId: row.userId, partyId: row.partyId}))
}
const groupMember = (userGroupId, userId) =>
    rows("moqui.security.UserGroupMember", {userGroupId, userId}).some(row => lib.active(row))
// The approvers of a step: the organization's, narrowed to the user or the group it names.
function stepApprovers(organizationPartyId, step) {
    return approvers(organizationPartyId).filter(
        user =>
            (!step.approverUserId || user.userId === step.approverUserId) &&
            (!step.approverUserGroupId || groupMember(step.approverUserGroupId, user.userId))
    )
}
function approverText(step) {
    if (step.approverUserId) return userName(step.approverUserId)
    if (step.approverUserGroupId)
        return one("moqui.security.UserGroup", {userGroupId: step.approverUserGroupId})?.description || step.approverUserGroupId
    return "A purchase approver"
}

// ===== policies and steps =====
const inBand = (row, amount) =>
    amount.compare(dec(row.fromAmount)) >= 0 && (row.thruAmount == null || amount.compare(dec(row.thruAmount)) < 0)
const rank = row => (row.productCategoryId ? 2 : 0) + (row.facilityId ? 1 : 0)
// The no-policy rule's one step (design ApprovalPolicies, R-PUR-14): any purchase approver, self-approval by the buying policy.
const noPolicyStep = {purchaseApprovalPolicyId: null, sequenceNum: 1, quorum: 1, noPolicy: true}
// The steps of a source: {source} with organizationPartyId, sourceTypeEnumId, amount, currencyUomId, facilityId and
// categoryIds. The rows in effect of the organization and source type that fit it, of the most specific rank (facility and
// category, category, facility, the organization's), by sequence; none in effect is the no-policy rule; rows in effect
// none of which fits is a missing policy (no monetary approval outside configured policy, design §18).
function stepsFor(source, at = now()) {
    const all = rows(POLICY, {
        organizationPartyId: source.organizationPartyId,
        sourceTypeEnumId: source.sourceTypeEnumId
    }).filter(row => lib.active(row, at))
    if (!all.length) return {noPolicy: true, missing: false, steps: [noPolicyStep]}
    const amount = dec(source.amount)
    const fits = all.filter(
        row =>
            (!row.currencyUomId || row.currencyUomId === source.currencyUomId) &&
            (!row.facilityId || row.facilityId === source.facilityId) &&
            (!row.productCategoryId || (source.categoryIds || []).includes(row.productCategoryId)) &&
            inBand(row, amount)
    )
    if (!fits.length) return {noPolicy: false, missing: true, steps: []}
    const top = Math.max(...fits.map(rank))
    const steps = fits
        .filter(row => rank(row) === top)
        .map(row => lib.map(row))
        .sort(
            (a, b) =>
                Number(a.sequenceNum || 0) - Number(b.sequenceNum || 0) ||
                String(a.purchaseApprovalPolicyId).localeCompare(String(b.purchaseApprovalPolicyId))
        )
    return {noPolicy: false, missing: false, steps}
}
// The decisions of a source's revision that count: not superseded.
function decisionsOf(source) {
    return rows(DECISION, {
        sourceEntityName: source.sourceEntityName,
        sourceId: source.sourceId,
        sourceRevision: source.revision
    }).filter(row => !row.supersededDate)
}
// A source's approval at its revision: each step with the users whose approval counts (not expired), done when they reach
// its quorum; the current step (the first not done); complete when every step is; refused when a decision refused it.
function progress(source, at = now()) {
    const plan = stepsFor(source, at)
    const decisions = decisionsOf(source)
    const steps = plan.steps.map(step => {
        const approvals = decisions.filter(
            row =>
                row.decisionEnumId === "PadApproved" &&
                (row.approvalPolicyId || null) === (step.purchaseApprovalPolicyId || null) &&
                (!step.expiryDays || ms(row.decisionDate) + Number(step.expiryDays) * dayMs > at)
        )
        const userIds = [...new Set(approvals.map(row => row.decidedByUserId))]
        return Object.assign({}, step, {userIds, done: userIds.length >= quorumOf(step)})
    })
    const current = steps.find(step => !step.done) || null
    return {
        noPolicy: plan.noPolicy,
        missing: plan.missing,
        steps,
        current,
        complete: !plan.missing && steps.length > 0 && !current,
        refused: decisions.some(row => row.decisionEnumId === "PadRefused"),
        decisions
    }
}
const stepText = (state, step) =>
    state.noPolicy
        ? "one approval"
        : "step " +
          (state.steps.indexOf(step) + 1) +
          " of " +
          state.steps.length +
          (quorumOf(step) > 1 ? ", " + quorumOf(step) + " approvers" : "")
// Why the user may not decide the current step of a source, or null: the approver the step names, its group, the source's
// placer without self-approval (the step's setting, else the buying policy's), a second approval of the same step and,
// where the step separates its approver, a user who decided an earlier step of the revision.
function refusalFor(source, state, userId, partyId) {
    const step = state.current
    if (!step) return null
    if (step.approverUserId && step.approverUserId !== userId)
        return ["NOT_ELIGIBLE", "Step " + step.sequenceNum + " is " + userName(step.approverUserId) + "'s to decide"]
    if (step.approverUserGroupId && !groupMember(step.approverUserGroupId, userId))
        return ["NOT_ELIGIBLE", "Step " + step.sequenceNum + " is decided by " + approverText(step)]
    const buying = policyModule.effective(source.organizationPartyId).policy
    const selfAllowed =
        step.selfApprovalAllowed === "Y" || (step.selfApprovalAllowed !== "N" && buying.selfApprovalAllowed === "Y")
    if (!selfAllowed && source.submittedBy(userId, partyId))
        return ["SELF_APPROVAL", "You entered or submitted " + source.label + "; another approver decides it"]
    if (step.userIds.includes(userId)) return ["ALREADY_DECIDED", "You already approved this step of " + source.label]
    if (step.separateApprover === "Y") {
        const earlier = state.steps.slice(0, state.steps.indexOf(step))
        if (earlier.some(other => other.userIds.includes(userId)))
            return [
                "SEPARATION_REQUIRED",
                "You approved an earlier step of " + source.label + "; another approver takes this one"
            ]
    }
    return null
}

// ===== sources =====
// A purchase order as a source (po from PurchaseOrders.js purchaseOrder): its total, currency, facility and the categories of
// its lines' products, the revision and the user who entered or placed it.
function orderSource(po) {
    const order = one(ORDER, {orderId: po.orderId})
    const productIds = [
        ...new Set(
            rows(ITEM, {orderId: po.orderId})
                .map(item => item.productId)
                .filter(Boolean)
        )
    ]
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
    return {
        sourceEntityName: ORDER,
        sourceId: po.orderId,
        sourceTypeEnumId: "PasOrder",
        organizationPartyId: po.organizationPartyId,
        supplierPartyId: po.supplierPartyId,
        amount: order.grandTotal ?? 0,
        currencyUomId: order.currencyUomId || null,
        facilityId: po.part.facilityId || null,
        categoryIds,
        revision: Number(order.orderRevision ?? 1),
        statusId: order.statusId,
        label: "purchase order " + po.orderId,
        submittedBy: (userId, partyId) => orders().placedBy(order, userId, partyId)
    }
}
// A supplier as a source of an organization: its revision is the count of its profile rows (each change starts one), and the
// user who submitted it is the one who started the profile row in effect.
function supplierSource(organizationPartyId, supplierPartyId) {
    const profileRows = rows(PROFILE, {organizationPartyId, supplierPartyId})
    const current = profileRows.filter(row => lib.active(row)).sort((a, b) => ms(b.fromDate) - ms(a.fromDate))[0] || null
    return {
        sourceEntityName: PARTY,
        sourceId: String(supplierPartyId),
        sourceTypeEnumId: "PasSupplier",
        organizationPartyId,
        supplierPartyId: String(supplierPartyId),
        amount: 0,
        currencyUomId: null,
        facilityId: null,
        categoryIds: [],
        revision: profileRows.length,
        profile: current,
        statusId: current?.approvalStatusId || null,
        label: "supplier " + partyName(supplierPartyId),
        submittedBy: userId => !!current && current.changedByUserId === userId
    }
}

// ===== notifications =====
// The message of a source's approval waiting: the source, its revision, the organization, supplier and amount, the step.
function messageOf(source, state) {
    const message = {
        sourceEntityName: source.sourceEntityName,
        sourceId: source.sourceId,
        sourceRevision: source.revision,
        organizationPartyId: source.organizationPartyId,
        organizationName: partyName(source.organizationPartyId),
        supplierPartyId: source.supplierPartyId,
        supplierName: partyName(source.supplierPartyId),
        amountText: money(source.amount, source.currencyUomId),
        currencyUomId: source.currencyUomId,
        stepText: state.current ? stepText(state, state.current) : "",
        approvalPolicyId: state.current?.purchaseApprovalPolicyId || null
    }
    if (source.sourceEntityName === ORDER) message.orderId = source.sourceId
    // P10: a source's own fields for its topic's title and link (a request's id, name and revision time)
    if (source.message) Object.assign(message, source.message)
    if (source.sourceEntityName === AGREEMENT) message.agreementId = source.sourceId
    return message
}
// The approvers' messages of a source are read once its step is decided: each unread copy is marked read, so the approval
// leaves every approver's list.
function clearNotices(source) {
    let cleared = 0
    const messageIds = rows("moqui.security.user.NotificationMessage", {
        topic: source.topic || topics[source.sourceEntityName],
        recordEntityName: source.sourceEntityName,
        recordId: source.sourceId
    }).map(row => row.notificationMessageId)
    if (!messageIds.length) return cleared
    for (const user of Array.from(
        find("moqui.security.user.NotificationMessageUser")
            .condition("notificationMessageId", "in", messageIds)
            .condition("viewedDate", "is-null", null)
            .list()
    )) {
        call("update#moqui.security.user.NotificationMessageUser", {
            notificationMessageId: user.notificationMessageId,
            userId: user.userId,
            viewedDate: ec.user.nowTimestamp
        })
        cleared++
    }
    return cleared
}
// The step waiting of a source, to its approvers who may decide it (the placer left out unless self-approval is allowed,
// and those the step's separation or quorum refuses): one message for a step one approval decides, one per approver for a
// quorum, so one approver's decision does not read the others' copies. A failure is logged and the change stays.
function notify(source, state = null) {
    try {
        state = state || progress(source)
        clearNotices(source)
        if (!state.current || state.refused) return {notifiedCount: 0}
        const step = state.current
        const userIds = stepApprovers(source.organizationPartyId, step)
            .filter(user => !refusalFor(source, state, user.userId, user.partyId))
            .map(user => user.userId)
        if (!userIds.length) return {notifiedCount: 0}
        const message = messageOf(source, state)
        const batches = quorumOf(step) > 1 ? userIds.map(userId => [userId]) : [userIds]
        for (const batch of batches) {
            const notice = ec
                .makeNotificationMessage()
                .topic(source.topic || topics[source.sourceEntityName])
                .message(message)
                .record(source.sourceEntityName, source.sourceId)
                .actorUserId(ec.user.userId)
                .userIds(batch)
            // P13: a source of its own wording (an agreement on the purchase order topic)
            if (source.title) notice.title(source.title(state))
            notice.send()
        }
        return {notifiedCount: userIds.length}
    } catch (error) {
        ec.logger.error("Approval notice of " + source.label + " was not sent: " + error.message)
        return {notifiedCount: 0}
    }
}

// ===== a key-field change after a decision =====
// handle#PurchaseApprovalRevision, the SECA on increment#OrderRevision: a commercial change of a purchase order (not a
// status, file or note) after a decision supersedes the decisions of earlier revisions, and a placed order sent for approval
// goes back to its first step's approvers at the new revision. An order with neither a decision nor an approval notice
// returns at once, and so does an order with no purchase part (a sales order: every order's revision passes here, and
// NotificationMessage has no index on its record). No permission check: it runs as any user.
function revisionChanged(p) {
    if (["status", "content", "note"].includes(p.revisionKind) || blank(p.orderId)) return {supersededCount: 0}
    const part = rows("mantle.order.OrderPart", {orderId: p.orderId}).find(row => orders().isPurchasePart(row))
    if (!part) return {supersededCount: 0}
    const decisions = rows(DECISION, {sourceEntityName: ORDER, sourceId: p.orderId}).filter(row => !row.supersededDate)
    const noticed =
        find("moqui.security.user.NotificationMessage", {
            topic: topics[ORDER],
            recordEntityName: ORDER,
            recordId: p.orderId
        }).count() > 0
    if (!decisions.length && !noticed) return {supersededCount: 0}
    const order = one(ORDER, {orderId: p.orderId})
    const revision = Number(order?.orderRevision ?? 1)
    const stale = decisions.filter(row => Number(row.sourceRevision) < revision)
    for (const row of stale)
        call("update#" + DECISION, {
            purchaseApprovalDecisionId: row.purchaseApprovalDecisionId,
            supersededDate: ec.user.nowTimestamp
        })
    // a placed order's approvers are sent the new revision: its earlier decisions no longer count, and an earlier notice would
    // be refused as stale
    if ((stale.length || noticed) && order.statusId === "OrderPlaced") {
        try {
            notify(
                orderSource({
                    orderId: String(p.orderId),
                    part,
                    organizationPartyId: part.customerPartyId,
                    supplierPartyId: part.vendorPartyId
                })
            )
        } catch (error) {
            ec.logger.error("Purchase order " + p.orderId + " was not resubmitted for approval: " + error.message)
        }
    }
    return {supersededCount: stale.length}
}

// ===== budget =====
// The budget lines of a purchase order: each line with an amount, not converted from a request (P10 converts those), on its
// account: the line's override, else the account a bill of it posts to (get#InvoiceItemGlAccount, incoming).
function budgetLines(po) {
    const requested = new Set(rows("mantle.request.RequestItemOrder", {orderId: po.orderId}).map(row => row.orderItemSeqId))
    const lines = []
    for (const item of rows(ITEM, {orderId: po.orderId})) {
        const amount = dec(item.quantity).multiply(dec(item.unitAmount))
        if (amount.compare(0) <= 0 || requested.has(item.orderItemSeqId)) continue
        let glAccountId = item.overrideGlAccountId || null
        if (!glAccountId && item.itemTypeEnumId)
            glAccountId =
                call("mantle.ledger.InvoiceAutoPostServices.get#InvoiceItemGlAccount", {
                    organizationPartyId: po.organizationPartyId,
                    otherPartyId: po.supplierPartyId,
                    itemTypeEnumId: item.itemTypeEnumId,
                    productId: item.productId || null,
                    direction: "I"
                }).glAccountId || null
        if (glAccountId) lines.push({orderItemSeqId: item.orderItemSeqId, glAccountId, amount})
    }
    return lines
}
// The budget decision of a purchase order's lines at the PO stage, by account (check#Budget, nothing written): the rows,
// and OK, WARN or STOP; NONE when no line is under an approved budget.
function budgetCheck(po, lines = budgetLines(po)) {
    if (!lines.length) return {result: "NONE", budgetRows: [], lines}
    const byAccount = {}
    for (const line of lines) byAccount[line.glAccountId] = dec(byAccount[line.glAccountId]).add(line.amount)
    const checked = call("mantle.other.BudgetServices.check#Budget", {
        organizationPartyId: po.organizationPartyId,
        stageEnumId: "BcsOrder",
        lines: Object.entries(byAccount).map(([glAccountId, amount]) => ({glAccountId, amount}))
    })
    const budgetRows = Array.from(checked.checkList || []).map(row => ({
        glAccountId: row.glAccountId,
        budgetId: row.budgetId || null,
        decisionEnumId: row.decisionEnumId,
        decisionText: one("moqui.basic.Enumeration", {enumId: row.decisionEnumId})?.description || row.decisionEnumId,
        requestedText: money(row.requestedAmount, row.currencyUomId),
        availableText: row.availableAmount == null ? "" : money(row.availableAmount, row.currencyUomId),
        message: row.message || "",
        canOverride: !!row.canOverride
    }))
    const controlled = budgetRows.filter(row => row.budgetId)
    const result = !controlled.length ? "NONE" : checked.blocked ? "STOP" : checked.warned ? "WARN" : "OK"
    return {result, budgetRows, lines, controlledAccounts: new Set(controlled.map(row => row.glAccountId))}
}
// At the approval of a purchase order with no request: each line under an approved budget reserved at the PO stage, keyed by
// the order's revision (reserve#Commitment refuses a Stop, BUDGET_EXCEEDED, unless a BUDGET_OVERRIDE holder gives a reason,
// and warns on a Warn).
function reserveBudget(po, revision, overrideReason) {
    const checked = budgetCheck(po)
    if (checked.result === "NONE") return {reservedCount: 0, budgetResult: "NONE"}
    let reservedCount = 0
    for (const line of checked.lines.filter(row => checked.controlledAccounts.has(row.glAccountId))) {
        call("mantle.other.BudgetServices.reserve#Commitment", {
            organizationPartyId: po.organizationPartyId,
            stageEnumId: "BcsOrder",
            sourceEntityName: ORDER,
            sourceId: po.orderId,
            sourceItemId: line.orderItemSeqId,
            sourceRevision: String(revision),
            glAccountId: line.glAccountId,
            amount: line.amount,
            currencyUomId: one(ORDER, {orderId: po.orderId}).currencyUomId,
            overrideReason: text(overrideReason)
        })
        reservedCount++
    }
    return {reservedCount, budgetResult: checked.result}
}

// ===== store#PurchaseApprovalPolicy =====
const given = (p, field) => Object.keys(p).includes(field) && p[field] !== undefined
function amountOf(value, label) {
    if (blank(value)) return null
    let number
    try {
        number = toDecimal(value)
    } catch (_) {
        number = null
    }
    if (number == null || number.compare(0) < 0) denied("POLICY_INVALID", "Enter a " + label + " of zero or more")
    return number
}
function wholeOf(value, label, minimum) {
    if (blank(value)) return null
    const number = Number(value)
    if (!Number.isInteger(number) || number < minimum)
        denied("POLICY_INVALID", "Enter a " + label + " of " + minimum + " or more")
    return number
}
function validate(values) {
    if (!one("moqui.basic.Enumeration", {enumId: values.sourceTypeEnumId || "_NA_", enumTypeId: "PurchaseApprovalSource"}))
        denied("POLICY_INVALID", "Choose what the policy approves")
    values.fromAmount = amountOf(values.fromAmount, "from amount")
    values.thruAmount = amountOf(values.thruAmount, "through amount")
    if (values.thruAmount != null && values.thruAmount.compare(dec(values.fromAmount)) <= 0)
        denied("POLICY_INVALID", "A band's upper amount is above its lower amount")
    if (values.currencyUomId && one("moqui.basic.Uom", {uomId: values.currencyUomId})?.uomTypeEnumId !== "UT_CURRENCY_MEASURE")
        denied("POLICY_INVALID", "Choose a currency")
    if (
        values.productCategoryId &&
        !one("mantle.product.category.ProductCategory", {productCategoryId: values.productCategoryId})
    )
        denied("POLICY_INVALID", "Choose a product category")
    if (
        values.facilityId &&
        one("mantle.facility.Facility", {facilityId: values.facilityId})?.ownerPartyId !== values.organizationPartyId
    )
        denied("POLICY_INVALID", "Choose a facility of " + partyName(values.organizationPartyId))
    values.sequenceNum = wholeOf(values.sequenceNum, "step", 1) ?? 1
    values.quorum = wholeOf(values.quorum, "number of approvers", 1) ?? 1
    values.expiryDays = wholeOf(values.expiryDays, "number of days", 1)
    if (values.approverUserId && !one("moqui.security.UserAccount", {userId: values.approverUserId}))
        denied("POLICY_INVALID", "Choose an approver")
    if (values.approverUserGroupId && !one("moqui.security.UserGroup", {userGroupId: values.approverUserGroupId}))
        denied("POLICY_INVALID", "Choose an approver group")
    for (const field of ["selfApprovalAllowed", "separateApprover"])
        if (values[field] != null && !["Y", "N"].includes(values[field])) denied("POLICY_INVALID", "Choose yes or no")
}
const sameScope = (a, b) =>
    ["organizationPartyId", "sourceTypeEnumId", "currencyUomId", "productCategoryId", "facilityId"].every(
        field => (a[field] || null) === (b[field] || null)
    )
const sameAmount = (a, b) => (a == null && b == null) || (a != null && b != null && dec(a).compare(dec(b)) === 0)
const overlaps = (a, b) =>
    (b.thruAmount == null || dec(a.fromAmount).compare(dec(b.thruAmount)) < 0) &&
    (a.thruAmount == null || dec(b.fromAmount).compare(dec(a.thruAmount)) < 0)
// store#PurchaseApprovalPolicy: a new step row from its date; given a row (purchaseApprovalPolicyId), the next version of it
// (the row ends where the next starts), or with endPolicy Y the row ended. Refuses a band that overlaps another band of the
// same scope without being the same band, two rows for one step of a band (POLICY_AMBIGUOUS), and a step fewer eligible
// approvers than its quorum hold PURCHASE_APPROVE for (NO_ELIGIBLE_APPROVER).
function storePolicy(p) {
    requirePermission("PURCHASE_POLICY_EDIT")
    const reason = text(p.changeReason)
    if (!reason) denied("REASON_REQUIRED", "Give the reason for the change")
    let replaced = null
    if (!blank(p.purchaseApprovalPolicyId)) {
        replaced = one(POLICY, {purchaseApprovalPolicyId: p.purchaseApprovalPolicyId})
        if (!replaced) denied("POLICY_UNAVAILABLE", "Approval policy " + p.purchaseApprovalPolicyId + " is not available")
        requireOrganization(replaced.organizationPartyId)
        if (replaced.thruDate && ms(replaced.thruDate) <= now()) denied("POLICY_ENDED", "The approval policy has ended")
    }
    const auditReason = fields => ec.context.putAll(Object.fromEntries(fields.map(name => [name + "_changeReason", reason])))
    if (replaced && p.endPolicy === "Y") {
        const thru = blank(p.thruDate) ? now() : ms(p.thruDate)
        if (!Number.isFinite(thru) || thru <= ms(replaced.fromDate)) denied("POLICY_INVALID", "A policy ends after it starts")
        auditReason(["thruDate"])
        call("update#" + POLICY, {
            purchaseApprovalPolicyId: replaced.purchaseApprovalPolicyId,
            thruDate: thru,
            changeReason: reason,
            changedByUserId: ec.user.userId
        })
        return {purchaseApprovalPolicyId: replaced.purchaseApprovalPolicyId, ended: true}
    }
    const values = {}
    for (const field of policyFields) values[field] = replaced ? (replaced[field] ?? null) : null
    for (const field of policyFields) if (given(p, field)) values[field] = text(p[field])
    if (replaced) values.organizationPartyId = replaced.organizationPartyId
    values.organizationPartyId = requireOrganization(values.organizationPartyId)
    validate(values)
    const fromMillis = blank(p.fromDate) ? now() : ms(p.fromDate)
    if (!Number.isFinite(fromMillis) || fromMillis < now() - 60000)
        denied("POLICY_INVALID", "A policy starts now or later; the earlier ones stay with their history")
    const thruMillis = blank(p.thruDate) ? null : ms(p.thruDate)
    if (thruMillis != null && thruMillis <= fromMillis) denied("POLICY_INVALID", "A policy ends after it starts")
    if (replaced && ms(replaced.fromDate) >= fromMillis)
        denied("POLICY_INVALID", "The new version starts after the one it replaces")
    // the rows of the scope in effect from the start, but the one replaced
    const others = rows(POLICY, {organizationPartyId: values.organizationPartyId, sourceTypeEnumId: values.sourceTypeEnumId})
        .filter(row => row.purchaseApprovalPolicyId !== replaced?.purchaseApprovalPolicyId)
        .filter(
            row =>
                (row.thruDate == null || ms(row.thruDate) > fromMillis) && (thruMillis == null || ms(row.fromDate) < thruMillis)
        )
        .filter(row => sameScope(row, values))
    for (const other of others) {
        const sameBand =
            sameAmount(other.fromAmount ?? 0, values.fromAmount ?? 0) && sameAmount(other.thruAmount, values.thruAmount)
        if (!sameBand && overlaps(other, values))
            denied(
                "POLICY_AMBIGUOUS",
                "The band overlaps approval policy " +
                    other.purchaseApprovalPolicyId +
                    "'s; bands of one scope meet or are the same"
            )
        if (sameBand && Number(other.sequenceNum || 1) === values.sequenceNum)
            denied(
                "POLICY_AMBIGUOUS",
                "Approval policy " + other.purchaseApprovalPolicyId + " is already step " + values.sequenceNum + " of the band"
            )
    }
    const eligible = stepApprovers(values.organizationPartyId, values)
    if (eligible.length < values.quorum)
        denied(
            "NO_ELIGIBLE_APPROVER",
            "The step needs " +
                values.quorum +
                " approvers and " +
                eligible.length +
                " of " +
                partyName(values.organizationPartyId) +
                " may approve (" +
                approverText(values) +
                ", holding PURCHASE_APPROVE)"
        )
    auditReason(policyFields.concat(["fromDate", "thruDate", "changeReason"]))
    if (replaced)
        call("update#" + POLICY, {
            purchaseApprovalPolicyId: replaced.purchaseApprovalPolicyId,
            thruDate: fromMillis,
            changeReason: reason,
            changedByUserId: ec.user.userId
        })
    const created = call(
        "create#" + POLICY,
        Object.assign({}, values, {
            fromDate: fromMillis,
            thruDate: thruMillis,
            changeReason: reason,
            changedByUserId: ec.user.userId
        })
    )
    return {purchaseApprovalPolicyId: created.purchaseApprovalPolicyId, ended: false}
}

// ===== preview#PurchaseApproval =====
function stepRows(source, state) {
    return state.steps.map(step => {
        const eligible = stepApprovers(source.organizationPartyId, step)
        return {
            purchaseApprovalPolicyId: step.purchaseApprovalPolicyId || null,
            sequenceNum: step.sequenceNum,
            approverText: step.noPolicy ? "A purchase approver" : approverText(step),
            quorum: quorumOf(step),
            approvedCount: step.userIds.length,
            approvedByText: step.userIds.map(userName).join(", "),
            eligibleText: eligible.map(user => userName(user.userId)).join(", "),
            eligibleCount: eligible.length,
            separateApprover: step.separateApprover === "Y",
            selfApprovalText:
                step.selfApprovalAllowed === "Y"
                    ? "Allowed"
                    : step.selfApprovalAllowed === "N"
                      ? "Not allowed"
                      : "As the buying policy",
            expiryText: step.expiryDays ? step.expiryDays + " days" : "",
            state: step.done ? "Done" : step === state.current ? "Waiting" : "Next",
            stepText: stepText(state, step)
        }
    })
}
// The approval of a source explained: the steps its amount selects with who may decide each and what is decided at its
// revision, the missing policy, and for a purchase order the budget's decision of its lines (to a user who reads budgets:
// a purchase approver or a finance reader; else withheld).
function preview(p) {
    requirePermission("PURCHASE_APPROVE", "PURCHASE_POLICY_EDIT", "PURCHASE_ORDER_EDIT")
    let source,
        po = null
    if (!blank(p.orderId)) {
        po = orders().purchaseOrder(p.orderId)
        source = orderSource(po)
    } else if (!blank(p.agreementId)) {
        source = agreements().agreementSource(agreements().purchaseAgreement(p.agreementId))
    } else if (!blank(p.supplierPartyId)) {
        const organizationPartyId = requireOrganization(text(p.organizationPartyId))
        orders().supplierOf(organizationPartyId, text(p.supplierPartyId))
        source = supplierSource(organizationPartyId, text(p.supplierPartyId))
    } else {
        const organizationPartyId = requireOrganization(text(p.organizationPartyId))
        const sourceTypeEnumId = text(p.sourceTypeEnumId) || "PasOrder"
        source = {
            sourceEntityName: null,
            sourceId: null,
            sourceTypeEnumId,
            organizationPartyId,
            amount: amountOf(p.amount, "amount") ?? 0,
            currencyUomId: text(p.currencyUomId),
            facilityId: text(p.facilityId),
            categoryIds: blank(p.productCategoryId) ? [] : [String(p.productCategoryId)],
            revision: null,
            label: "the amount",
            submittedBy: () => false
        }
    }
    const state = progress(source.sourceId ? source : Object.assign({}, source, {sourceEntityName: "_NA_", sourceId: "_NA_"}))
    let budget = {result: "NONE", budgetRows: []}
    const budgetReader = access.has("PURCHASE_APPROVE") || access.has("ACCOUNTING_VIEW") || access.has("BUDGET_EDIT")
    if (po && budgetReader) budget = budgetCheck(po)
    else if (po) budget = {result: "WITHHELD", budgetRows: []}
    const userId = ec.user.userId,
        partyId = ec.user.userAccount?.partyId || null
    const refusal = source.sourceId && state.current ? refusalFor(source, state, userId, partyId) : null
    return {
        preview: {
            sourceEntityName: source.sourceEntityName,
            sourceId: source.sourceId,
            sourceRevision: source.revision,
            organizationPartyId: source.organizationPartyId,
            organizationName: partyName(source.organizationPartyId),
            amountText: money(source.amount, source.currencyUomId),
            currencyUomId: source.currencyUomId,
            noPolicy: state.noPolicy,
            missing: state.missing,
            missingMessage: state.missing
                ? "No approval policy of " +
                  partyName(source.organizationPartyId) +
                  " covers " +
                  money(source.amount, source.currencyUomId)
                : "",
            complete: state.complete,
            refused: state.refused,
            currentStepText: state.current ? stepText(state, state.current) : "",
            canDecide: !!state.current && access.has("PURCHASE_APPROVE") && !refusal,
            refusalText: refusal ? refusal[1] : "",
            stepRows: stepRows(source, state),
            budgetResult: budget.result,
            budgetRows: budget.budgetRows
        }
    }
}

// ===== suppliers =====
function supplierOf(p, permission) {
    requirePermission(permission)
    const organizationPartyId = requireOrganization(text(p.organizationPartyId))
    const supplierPartyId = text(p.supplierPartyId)
    orders().supplierOf(organizationPartyId, supplierPartyId)
    return {organizationPartyId, supplierPartyId}
}
const blockInEffect = (profile, at = now()) =>
    !!profile?.purchaseBlockFromDate &&
    ms(profile.purchaseBlockFromDate) <= at &&
    (profile.purchaseBlockThruDate == null || ms(profile.purchaseBlockThruDate) > at)
// submit#SupplierApproval: a supplier not approved (none, Pending, Rejected, or Suspended once its block has ended) put
// Pending and sent to its approvers.
function submitSupplier(p) {
    const {organizationPartyId, supplierPartyId} = supplierOf(p, "SUPPLIER_PROFILE_EDIT")
    let source = supplierSource(organizationPartyId, supplierPartyId)
    if (source.statusId === "SupaApproved") denied("ALREADY_APPROVED", partyName(supplierPartyId) + " is approved")
    if (source.statusId === "SupaSuspended" && blockInEffect(source.profile))
        denied("SUPPLIER_BLOCKED", partyName(supplierPartyId) + " is suspended until its block ends")
    call("mantle.party.SupplierServices.store#SupplierProfile", {
        organizationPartyId,
        supplierPartyId,
        approvalStatusId: "SupaPending",
        changeReason: text(p.reason) || "Submitted for approval"
    })
    source = supplierSource(organizationPartyId, supplierPartyId)
    const notified = notify(source)
    return {approvalStatusId: source.statusId, sourceRevision: source.revision, notifiedCount: notified.notifiedCount}
}
// The PurchaseSupplierApproval notice of a new supplier that starts Pending (create#Supplier; F49): as submit, without the
// status change.
function notifyNewSupplier(organizationPartyId, supplierPartyId) {
    return notify(supplierSource(organizationPartyId, supplierPartyId))
}
// decide#SupplierApproval: a Pending supplier's step decided at its revision; the last step's approval sets it Approved, a
// refusal (with its reason) Rejected.
function decideSupplier(p) {
    const {organizationPartyId, supplierPartyId} = supplierOf(p, "PURCHASE_APPROVE")
    const decision = String(p.decision || "approve")
    if (!["approve", "refuse"].includes(decision)) denied("DECISION_INVALID", "Approve or refuse")
    const reason = text(p.reason)
    if (decision === "refuse" && !reason) denied("REASON_REQUIRED", "Give the reason for refusing")
    find(PARTY, {partyId: supplierPartyId}).forNoKeyUpdate(true).one()
    const source = supplierSource(organizationPartyId, supplierPartyId)
    if (source.statusId !== "SupaPending")
        denied("NOT_PENDING", partyName(supplierPartyId) + " is not waiting for approval; submit it first")
    if (!blank(p.sourceRevision) && Number(p.sourceRevision) !== source.revision)
        denied(
            "STALE_REVISION",
            partyName(supplierPartyId) + "'s profile is at revision " + source.revision + "; review it again"
        )
    const state = progress(source)
    if (state.missing) denied("POLICY_MISSING", "No approval policy of " + partyName(organizationPartyId) + " covers suppliers")
    const partyId = ec.user.userAccount?.partyId || null
    const refusal = refusalFor(source, state, ec.user.userId, partyId)
    if (refusal) denied(refusal[0], refusal[1])
    const policyRow = policyModule.effective(organizationPartyId).row
    const created = call("create#" + DECISION, {
        sourceEntityName: PARTY,
        sourceId: supplierPartyId,
        sourceRevision: source.revision,
        organizationPartyId,
        decisionEnumId: decision === "approve" ? "PadApproved" : "PadRefused",
        decisionDate: ec.user.nowTimestamp,
        decidedByUserId: ec.user.userId,
        decidedByPartyId: partyId,
        reason,
        policyFromDate: policyRow ? policyRow.fromDate : null,
        approvalPolicyId: state.current?.purchaseApprovalPolicyId || null,
        stepSeqId: state.current ? String(state.current.sequenceNum) : null
    })
    let approvalStatusId = "SupaPending"
    if (decision === "refuse") approvalStatusId = "SupaRejected"
    else if (progress(source).complete) approvalStatusId = "SupaApproved"
    if (approvalStatusId !== "SupaPending")
        ec.resource.script("component://mr-mantle/service/mantle/party/SupplierProfile.js").storeDecision({
            organizationPartyId,
            supplierPartyId,
            approvalStatusId,
            changeReason: reason || (decision === "approve" ? "Approved" : "Refused")
        })
    // a status change starts a profile row, a new revision: the decision stays on the revision it decided
    if (approvalStatusId === "SupaPending") notify(source)
    else clearNotices(source)
    return {purchaseApprovalDecisionId: created.purchaseApprovalDecisionId, approvalStatusId}
}
// suspend#Supplier: Suspended, with a dated purchase block and its reason (check#SupplierUsable stops it); once the block
// ends the supplier is submitted and approved again.
function suspendSupplier(p) {
    const {organizationPartyId, supplierPartyId} = supplierOf(p, "SUPPLIER_PROFILE_EDIT")
    const reason = text(p.reason)
    if (!reason) denied("REASON_REQUIRED", "Give the reason for the suspension")
    const fromDate = blank(p.fromDate) ? ec.user.nowTimestamp : p.fromDate
    call("mantle.party.SupplierServices.store#SupplierProfile", {
        organizationPartyId,
        supplierPartyId,
        approvalStatusId: "SupaSuspended",
        purchaseBlockFromDate: fromDate,
        purchaseBlockThruDate: blank(p.thruDate) ? null : p.thruDate,
        purchaseBlockReason: reason,
        changeReason: reason
    })
    clearNotices(supplierSource(organizationPartyId, supplierPartyId))
    return {approvalStatusId: "SupaSuspended"}
}

// ===== the topics' handlers (F23) =====
// approve#PurchaseSource and refuse#PurchaseSource: the framework calls them as the user deciding a PurchaseOrderApproval or
// PurchaseSupplierApproval notice; each decides the source at the revision in the message, so a superseded one is refused
// naming the current revision.
function decideSource(p, decision) {
    requirePermission("PURCHASE_APPROVE")
    const message = p.message || {}
    if (p.recordEntityName === ORDER)
        return call("mantle.order.PurchaseServices.decide#PurchaseApproval", {
            orderId: p.recordId,
            orderRevision: message.sourceRevision ?? null,
            decision,
            reason: text(p.reason)
        })
    if (p.recordEntityName === AGREEMENT)
        return call("mantle.order.PurchaseServices.decide#PurchaseApproval", {
            agreementId: p.recordId,
            agreementRevision: message.sourceRevision ?? null,
            decision,
            reason: text(p.reason)
        })
    if (p.recordEntityName === PARTY)
        return call("mantle.order.PurchaseServices.decide#SupplierApproval", {
            organizationPartyId: message.organizationPartyId,
            supplierPartyId: p.recordId,
            sourceRevision: message.sourceRevision ?? null,
            decision,
            reason: text(p.reason)
        })
    // P12: an award of an RFQ's quotes (PurchaseAwardApproval, its message naming the award) at the revision in the message
    if (p.recordEntityName === REQUEST && message.awardKey)
        return call("mantle.order.SourcingServices.decide#AwardApproval", {
            requestId: p.recordId,
            awardKey: message.awardKey,
            sourceRevision: message.sourceRevision ?? null,
            decision,
            reason: text(p.reason)
        })
    // P10: a purchase request at the revision in the message
    if (p.recordEntityName === REQUEST)
        return call("mantle.request.RequestServices.decide#PurchaseRequestApproval", {
            requestId: p.recordId,
            sourceRevision: message.sourceRevision ?? null,
            decision,
            reason: text(p.reason)
        })
    denied("SOURCE_INVALID", "Not a purchase approval")
}

const operations = {
    storePolicy,
    preview,
    submitSupplier,
    decideSupplier,
    suspendSupplier,
    revisionChanged,
    approveSource: p => decideSource(p, "approve"),
    refuseSource: p => decideSource(p, "refuse")
}
;({
    orderSource,
    supplierSource,
    progress,
    refusalFor,
    stepText,
    notify,
    clearNotices,
    notifyNewSupplier,
    reserveBudget,
    execute: (op, parameters) => {
        if (!operations[op]) throw new Error("Unknown purchase approval operation " + op)
        return operations[op](parameters)
    }
})
