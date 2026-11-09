// Customer credit (AC-11; mantle.account.CreditServices): the organization's policy for a customer in effect, the
// customer's exposure (unpaid invoices and open orders not yet invoiced, less unapplied payments and the payments authorized
// on the open orders), the check of an order on approval, which may put it on a Credit hold, the release of a credit hold
// with its decision, and the policy writers. An organization without a policy is never checked.
const lib = ec.resource.script("component://mr-mantle/service/mantle/account/InvoiceWorkflowLib.js")
const {find, one, rows, call, denied, has} = lib
const POLICY = "mantle.account.billing.CustomerCreditPolicy"
const DECISION = "mantle.account.billing.CreditHoldDecision"
const I = lib.invoiceEntity
const aging = () => ec.resource.script("component://mr-mantle/service/mantle/ledger/Aging.js")
const HOLD = "mantle.order.OrderHoldReason"
const OPEN_INVOICE_STATUSES = ["InvoiceFinalized", "InvoiceSent", "InvoiceAcked"]
const OPEN_ORDER_STATUSES = ["OrderPlaced", "OrderProcessing", "OrderApproved", "OrderHold", "OrderSent"]
const cf = () => ec.entity.conditionFactory
const today = () => ec.l10n.format(ec.user.nowTimestamp, "yyyy-MM-dd")
const startOf = day => ec.l10n.parseTimestamp(day + " 00:00:00", "yyyy-MM-dd HH:mm:ss")
const dayNumber = day => {
    const [year, month, date] = String(day).split("-").map(Number)
    return Date.UTC(year, month - 1, date) / 86400000
}
const money = (value, currency) => ec.l10n.formatCurrency(toDecimal(value ?? 0), currency)

// The policy in effect for a customer: its own row, else the organization's default (no customer).
function policyFor(organizationPartyId, customerPartyId, date = ec.user.nowTimestamp) {
    const dated = query =>
        query
            .condition(cf().makeConditionDate("fromDate", "thruDate", date))
            .orderBy("-fromDate")
            .limit(1)
            .list()
    const own = customerPartyId ? Array.from(dated(find(POLICY, {organizationPartyId, customerPartyId}))) : []
    if (own.length) return Object.assign(lib.map(own[0]), {source: "customer"})
    const fallback = Array.from(dated(find(POLICY, {organizationPartyId}).condition("customerPartyId", "is-null", null)))
    return fallback.length ? Object.assign(lib.map(fallback[0]), {source: "organization"}) : null
}

// What the customer owes and has committed to in one currency, each part summed in its query: unpaid issued invoices,
// open order parts less what was billed of them, less unapplied payments and the payments authorized on its orders.
// With overdue, the oldest invoice portion past due (P8's due schedule less what was applied, as the aging reads it); a
// customer with more unpaid invoices than that check reads is incomplete, which a policy treats as over, never as a pass.
const OVERDUE_LIMIT = 1000
function exposure(organizationPartyId, customerPartyId, currencyUomId, overdue = false) {
    const sum = (entity, conditions, field, extra = query => query) =>
        toDecimal(extra(find(entity, conditions)).selectField(field).one()?.[field] ?? 0)
    const unpaid = sum(
        "mantle.account.invoice.CollectionOverdueSummary",
        {fromPartyId: organizationPartyId, toPartyId: customerPartyId, currencyUomId},
        "overdueTotal",
        query => query.condition("statusId", "in", OPEN_INVOICE_STATUSES).condition("unpaidTotal", "greater", toDecimal(0))
    )
    const parts = {vendorPartyId: organizationPartyId, customerPartyId, currencyUomId}
    const openParts = query => query.condition("partStatusId", "in", OPEN_ORDER_STATUSES)
    // a recurring base (RecurringTemplate, X5) is the next period's template, never an open order (mr-pass impl-shop P7)
    const notBase = query =>
        openParts(query).condition(
            ec.entity.conditionFactory.makeCondition(
                [
                    ec.entity.conditionFactory.makeCondition("orderPurposeEnumId", "is-null", null),
                    ec.entity.conditionFactory.makeCondition("orderPurposeEnumId", "not-equals", "OrpRecurringTemplate")
                ],
                "or"
            )
        )
    const ordered = sum("mantle.order.CreditOpenOrderSum", parts, "partTotalSum", notBase)
    const billed = sum("mantle.order.CreditOrderBillingSum", parts, "billedSum", openParts)
    const payments = {fromPartyId: customerPartyId, toPartyId: organizationPartyId, amountUomId: currencyUomId}
    const unapplied = sum("mantle.account.payment.CreditPaymentSum", payments, "unappliedSum", query =>
        query.condition("statusId", "in", ["PmntDelivered", "PmntConfirmed"]).condition("unappliedTotal", "greater", toDecimal(0))
    )
    // payments authorized on the customer's open orders only
    const authorized = sum("mantle.account.payment.CreditOrderPaymentSum", payments, "amountSum", query =>
        query.condition("statusId", "PmntAuthorized").condition("orderStatusId", "in", OPEN_ORDER_STATUSES)
    )
    const round = value => ec.l10n.roundCurrency(value, currencyUomId)
    const uninvoiced = ordered.subtract(billed).compare(0) > 0 ? ordered.subtract(billed) : toDecimal(0)
    const out = {
        currencyUomId,
        unpaidInvoices: round(unpaid),
        openOrders: round(uninvoiced),
        unappliedPayments: round(unapplied),
        authorizedPayments: round(authorized),
        exposure: round(unpaid.add(uninvoiced).subtract(unapplied).subtract(authorized)),
        overdueInvoices: round(toDecimal(0)),
        oldestDueDate: null,
        overdueDays: 0,
        incomplete: false
    }
    if (!overdue) return out
    const invoices = Array.from(
        find(I, {fromPartyId: organizationPartyId, toPartyId: customerPartyId, currencyUomId})
            .condition("statusId", "in", OPEN_INVOICE_STATUSES)
            .condition("unpaidTotal", "greater", toDecimal(0))
            .orderBy("invoiceDate")
            .limit(OVERDUE_LIMIT + 1)
            .list()
    )
    out.incomplete = invoices.length > OVERDUE_LIMIT
    const late = aging().pastDue(invoices.slice(0, OVERDUE_LIMIT), today())
    const rows = Object.values(late)
    out.overdueInvoices = round(rows.reduce((total, row) => total.add(row.amount), toDecimal(0)))
    out.oldestDueDate = rows.map(row => row.oldestDueDay).sort()[0] || null
    out.overdueDays = out.oldestDueDate ? dayNumber(today()) - dayNumber(out.oldestDueDate) : 0
    return out
}

// The finding of a policy over an exposure: pass, or the policy's action with each reason.
function judge(policy, numbers, orderCurrency, customerName) {
    const reasons = []
    const currency = policy.currencyUomId
    if (orderCurrency && currency && orderCurrency !== currency)
        reasons.push({
            code: "CURRENCY_DIFFERENT",
            message: "the order is in " + orderCurrency + " and the credit limit in " + currency
        })
    if (policy.creditLimit != null && numbers.exposure.compare(policy.creditLimit) > 0)
        reasons.push({
            code: "CREDIT_LIMIT_EXCEEDED",
            message: "exposure " + money(numbers.exposure, currency) + " is over the limit " + money(policy.creditLimit, currency)
        })
    if (numbers.incomplete)
        reasons.push({
            code: "CREDIT_INCOMPLETE",
            message: "the customer has more unpaid invoices than the credit check reads"
        })
    if (policy.overdueDaysLimit != null && numbers.overdueDays > Number(policy.overdueDaysLimit))
        reasons.push({
            code: "OVERDUE_LIMIT_EXCEEDED",
            message: "an invoice is " + numbers.overdueDays + " days overdue (limit " + policy.overdueDaysLimit + ")"
        })
    if (!reasons.length) return {resultEnumId: "pass", reasons, warning: null}
    const resultEnumId = policy.actionEnumId === "CpaHold" ? "hold" : "warn"
    return {
        resultEnumId,
        reasons,
        warning:
            "Credit " +
            (resultEnumId === "hold" ? "hold" : "warning") +
            " for " +
            customerName +
            ": " +
            reasons.map(row => row.message).join("; ")
    }
}

// The credit check of an order: each sales part (an internal organization selling to an outside customer), or the part
// given, against its customer's policy. A part released by a credit decision that has not expired passes. With
// placeHold a Hold result holds the part (the whole order when it has one part) and notifies the organization's credit
// managers (CreditHoldRelease). The answer is the part found worst, with every part held.
function evaluate(p) {
    const pass = {resultEnumId: "pass", reasons: [], warning: null, held: false, heldPartSeqIds: []}
    const header = one("mantle.order.OrderHeader", {orderId: p.orderId})
    if (!header) return pass
    const allParts = rows("mantle.order.OrderPart", {orderId: p.orderId})
    const vendors = [...new Set(allParts.map(row => row.vendorPartyId).filter(Boolean))]
    // most organizations have no credit policy: one indexed count and the check is done
    if (!vendors.length || !find(POLICY).condition("organizationPartyId", "in", vendors).count()) return pass
    const internal = partyId => !!partyId && !!one("mantle.party.PartyRole", {partyId, roleTypeId: "OrgInternal"})
    const salesParts = allParts.filter(
        part =>
            (!p.orderPartSeqId || part.orderPartSeqId === p.orderPartSeqId) &&
            // only a part awaiting approval: an approved, held or completed part is never checked or held
            ["OrderPlaced", "OrderProcessing"].includes(part.statusId) &&
            internal(part.vendorPartyId) &&
            part.customerPartyId &&
            !internal(part.customerPartyId)
    )
    const rank = {pass: 0, warn: 1, hold: 2}
    let worst = null
    const heldPartSeqIds = []
    for (const part of salesParts) {
        const out = evaluatePart(p, header, part, allParts.length > 1)
        if (!out) continue
        if (out.held) heldPartSeqIds.push(part.orderPartSeqId)
        if (!worst || rank[out.resultEnumId] > rank[worst.resultEnumId]) worst = out
    }
    if (!worst) return pass
    return Object.assign(worst, {held: heldPartSeqIds.length > 0, heldPartSeqIds})
}
// A release decision for the order (or the part) that stands now.
function standingRelease(orderId, orderPartSeqId) {
    return rows(DECISION, {orderId, decisionEnumId: "CrdRelease"}).find(
        row =>
            (!row.orderPartSeqId || row.orderPartSeqId === orderPartSeqId) &&
            (row.expireDate == null || lib.ms(row.expireDate) > lib.ms(ec.user.nowTimestamp))
    )
}
function evaluatePart(p, header, part, multiPart) {
    const organizationPartyId = part.vendorPartyId,
        customerPartyId = part.customerPartyId
    const policy = policyFor(organizationPartyId, customerPartyId)
    if (!policy) return null
    const base = {
        held: false,
        orderHoldReasonId: null,
        organizationPartyId,
        customerPartyId,
        customerCreditPolicyId: policy.customerCreditPolicyId,
        creditLimit: policy.creditLimit,
        overdueDaysLimit: policy.overdueDaysLimit,
        currencyUomId: policy.currencyUomId || header.currencyUomId
    }
    const decision = standingRelease(p.orderId, part.orderPartSeqId)
    if (decision)
        return Object.assign(base, {
            resultEnumId: "pass",
            reasons: [{code: "CREDIT_RELEASED", message: "released by the credit decision " + decision.creditHoldDecisionId}],
            warning: null,
            exposure: null,
            overdueDays: null
        })
    const currencyUomId = base.currencyUomId
    const numbers = exposure(organizationPartyId, customerPartyId, currencyUomId, policy.overdueDaysLimit != null)
    // a part not yet counted as open (an approval of an order in another state) adds its own total
    if (!OPEN_ORDER_STATUSES.includes(part.statusId) && header.currencyUomId === currencyUomId)
        numbers.exposure = numbers.exposure.add(part.partTotal ?? header.grandTotal ?? 0)
    const names = lib.partyNames([customerPartyId])
    const finding = judge(policy, numbers, header.currencyUomId, names[customerPartyId] || customerPartyId)
    const out = Object.assign(base, finding, {exposure: numbers.exposure, overdueDays: numbers.overdueDays})
    if (finding.resultEnumId !== "hold" || !p.placeHold) return out
    const placed = call("mantle.order.OrderServices.hold#Order", {
        orderId: p.orderId,
        orderPartSeqId: multiPart ? part.orderPartSeqId : null,
        holdTypeEnumId: "OhtCredit",
        holdComment: finding.warning.slice(0, 255)
    })
    out.held = true
    out.orderHoldReasonId = placed.orderHoldReasonId
    if (!placed.alreadyHeld)
        ec.resource.script("component://mr-mantle/service/mantle/account/Payables.js").execute("notify", {
            topic: "CreditHoldRelease",
            permission: "CREDIT_HOLD_RELEASE",
            organizationPartyId,
            recordEntityName: "mantle.order.OrderHeader",
            recordId: p.orderId,
            message: {
                orderId: p.orderId,
                orderPartSeqId: multiPart ? part.orderPartSeqId : null,
                organizationPartyId,
                customerPartyId,
                customerName: names[customerPartyId] || customerPartyId,
                exposure: String(numbers.exposure),
                creditLimit: policy.creditLimit == null ? null : String(policy.creditLimit),
                currencyUomId
            }
        })
    return out
}

// An order's open credit hold (the part's when one is named) and its sales part, for a credit manager of its organization.
function heldOrder(p, permission) {
    const reasons = rows(HOLD, {orderId: p.orderId, holdTypeEnumId: "OhtCredit"})
        .filter(row => !row.releasedDate)
        .filter(row => !p.orderPartSeqId || row.orderPartSeqId === p.orderPartSeqId)
    const reason = reasons[0] || null
    const parts = rows("mantle.order.OrderPart", {orderId: p.orderId})
    const part =
        parts.find(row => reason?.orderPartSeqId && row.orderPartSeqId === reason.orderPartSeqId) ||
        parts.find(row => one("mantle.party.PartyRole", {partyId: row.vendorPartyId, roleTypeId: "OrgInternal"}))
    if (!part) denied("ORDER_UNAVAILABLE", "The order is not available")
    lib.organization(part.vendorPartyId, permission)
    return {part, reason, organizationPartyId: part.vendorPartyId, customerPartyId: part.customerPartyId}
}

// Release a credit hold with a reason: the decision is recorded with the exposure it was made on and until when it
// stands (the credit check passes the order, or its part, while it does), the hold released (release#OrderHold, which
// returns the order to where it was when no other reason is open) and its notifications marked read. An order back in
// Placed then goes through Mantle's automatic approval (autoApprove#Order), which approves it when its payments cover it
// and its checks pass; otherwise it waits for an approver.
function release(p) {
    const reasonText = String(p.reason || "").trim()
    if (!reasonText) denied("REASON_REQUIRED", "Give the reason for releasing the hold")
    const scope = heldOrder(p, "CREDIT_HOLD_RELEASE")
    if (!scope.reason) denied("HOLD_UNAVAILABLE", "The order has no open credit hold")
    if (p.expireDate && lib.ms(p.expireDate) <= lib.ms(ec.user.nowTimestamp))
        denied("EXPIRE_DATE_PAST", "The decision must stand until a later day")
    const header = one("mantle.order.OrderHeader", {orderId: p.orderId})
    const policy = policyFor(scope.organizationPartyId, scope.customerPartyId)
    const currencyUomId = policy?.currencyUomId || header.currencyUomId
    const numbers = exposure(scope.organizationPartyId, scope.customerPartyId, currencyUomId)
    const decision = call("create#mantle.account.billing.CreditHoldDecision", {
        orderId: p.orderId,
        orderPartSeqId: scope.reason.orderPartSeqId || null,
        orderHoldReasonId: scope.reason.orderHoldReasonId,
        organizationPartyId: scope.organizationPartyId,
        customerPartyId: scope.customerPartyId,
        decisionEnumId: "CrdRelease",
        reason: reasonText.slice(0, 255),
        decidedByUserId: ec.user.userId,
        decidedDate: ec.user.nowTimestamp,
        expireDate: p.expireDate || null,
        exposureAmount: numbers.exposure,
        creditLimit: policy?.creditLimit ?? null,
        currencyUomId
    })
    call("update#" + HOLD, {orderHoldReasonId: scope.reason.orderHoldReasonId, sourceId: decision.creditHoldDecisionId})
    const released = call("mantle.order.OrderServices.release#OrderHold", {
        orderHoldReasonId: scope.reason.orderHoldReasonId,
        releaseComment: reasonText.slice(0, 255)
    })
    ec.resource.script("component://mr-mantle/service/mantle/account/Payables.js").execute("clearNotices", {
        topic: "CreditHoldRelease",
        recordEntityName: "mantle.order.OrderHeader",
        recordId: p.orderId
    })
    if (!released.stillHeld && one("mantle.order.OrderHeader", {orderId: p.orderId})?.statusId === "OrderPlaced")
        call("mantle.order.OrderServices.autoApprove#Order", {orderId: p.orderId})
    const after = one("mantle.order.OrderHeader", {orderId: p.orderId})
    const partAfter = scope.reason.orderPartSeqId
        ? one("mantle.order.OrderPart", {orderId: p.orderId, orderPartSeqId: scope.reason.orderPartSeqId})
        : null
    return {
        creditHoldDecisionId: decision.creditHoldDecisionId,
        statusId: (partAfter || after).statusId,
        stillHeld: released.stillHeld
    }
}

// A customer's credit for a reader: the policy in effect and its history, the exposure in its currency (the
// organization's base currency without one), what is left of the limit, the open credit holds and recent decisions.
function status(p) {
    const organizationPartyId = lib.organization(p.organizationPartyId, "CUSTOMER_CREDIT_VIEW")
    const customerPartyId = p.customerPartyId
    const customer = customerPartyId ? one("mantle.party.Party", {partyId: customerPartyId}) : null
    if (!customer || (customer.privateOwnerUserId && customer.privateOwnerUserId !== ec.user.userId))
        denied("CUSTOMER_UNAVAILABLE", "The customer is not available")
    const policy = policyFor(organizationPartyId, customerPartyId)
    const preference = lib.policy.preference(organizationPartyId)
    const currencyUomId = policy?.currencyUomId || preference.baseCurrencyUomId || null
    const numbers = currencyUomId ? exposure(organizationPartyId, customerPartyId, currencyUomId, true) : null
    const history = Array.from(find(POLICY, {organizationPartyId, customerPartyId}).orderBy("-fromDate").limit(20).list()).map(
        row => lib.display(row)
    )
    const holdRows = []
    const heldParts = Array.from(
        find("mantle.order.OrderHeaderAndPart", {vendorPartyId: organizationPartyId, customerPartyId, partStatusId: "OrderHold"})
            .selectField("orderId")
            .selectField("grandTotal")
            .selectField("currencyUomId")
            .limit(100)
            .list()
    )
    const heldIds = [...new Set(heldParts.map(row => row.orderId))]
    if (heldIds.length)
        for (const reason of find(HOLD, {holdTypeEnumId: "OhtCredit"})
            .condition("orderId", "in", heldIds)
            .condition("releasedDate", "is-null", null)
            .orderBy("placedDate")
            .list()) {
            const order = heldParts.find(row => row.orderId === reason.orderId)
            holdRows.push(
                Object.assign(lib.display(reason), {
                    grandTotal: order?.grandTotal ?? null,
                    currencyUomId: order?.currencyUomId ?? null
                })
            )
        }
    const decisions = Array.from(
        find("mantle.account.billing.CreditHoldDecision", {organizationPartyId, customerPartyId})
            .orderBy("-decidedDate")
            .limit(20)
            .list()
    ).map(row => lib.display(row))
    const available =
        policy?.creditLimit != null && numbers
            ? ec.l10n.roundCurrency(toDecimal(policy.creditLimit).subtract(numbers.exposure), currencyUomId)
            : null
    return {
        policy: policy ? lib.display(policy) : null,
        policyHistory: history,
        exposure: numbers,
        available,
        currencyUomId,
        holds: holdRows,
        decisions,
        canEditPolicy: has("ACCOUNTING_ADMIN") || has("CREDIT_HOLD_RELEASE"),
        canRelease: has("CREDIT_HOLD_RELEASE")
    }
}

// Store a customer's policy (or, isDefault, the organization's default): the row in effect ends and the next starts,
// unless nothing changed; ended ends it.
function store(p) {
    const isDefault = !!p.isDefault
    const organizationPartyId = lib.organization(p.organizationPartyId, isDefault ? "ACCOUNTING_ADMIN" : null)
    if (!isDefault && !has("ACCOUNTING_ADMIN") && !has("CREDIT_HOLD_RELEASE"))
        denied("PERMISSION_DENIED", "ACCOUNTING_ADMIN or CREDIT_HOLD_RELEASE authority is required")
    const customerPartyId = isDefault ? null : p.customerPartyId
    if (!isDefault) {
        const customer = customerPartyId ? one("mantle.party.Party", {partyId: customerPartyId}) : null
        if (!customer || (customer.privateOwnerUserId && customer.privateOwnerUserId !== ec.user.userId))
            denied("CUSTOMER_UNAVAILABLE", "The customer is not available")
    }
    const changeReason = String(p.changeReason || "").trim()
    if (!changeReason) denied("CHANGE_REASON_REQUIRED", "Give the reason for the change")
    const lockKey = {organizationPartyId}
    find("mantle.party.Party", {partyId: organizationPartyId}).forUpdate(true).one()
    let query = find(POLICY, lockKey).condition(cf().makeConditionDate("fromDate", "thruDate", ec.user.nowTimestamp))
    query = customerPartyId
        ? query.condition("customerPartyId", customerPartyId)
        : query.condition("customerPartyId", "is-null", null)
    const current = Array.from(query.list())
    const end = () => {
        for (const row of current)
            call("update#" + POLICY, {
                customerCreditPolicyId: row.customerCreditPolicyId,
                thruDate: ec.user.nowTimestamp,
                changeReason
            })
    }
    if (p.ended === "Y") {
        end()
        return {customerCreditPolicyId: null, changed: current.length > 0}
    }
    const preference = lib.policy.preference(organizationPartyId)
    const currencyUomId = p.currencyUomId || preference.baseCurrencyUomId
    if (!currencyUomId) denied("CURRENCY_REQUIRED", "Choose the currency of the limit")
    const actionEnumId = p.actionEnumId || "CpaHold"
    if (!["CpaWarn", "CpaHold"].includes(actionEnumId)) denied("ACTION_INVALID", "Choose warn or hold")
    let creditLimit = null
    if (p.creditLimit != null && p.creditLimit !== "") {
        creditLimit = toDecimal(p.creditLimit)
        if (creditLimit.compare(0) < 0) denied("LIMIT_INVALID", "The credit limit is not negative")
        creditLimit = ec.l10n.roundCurrency(creditLimit, currencyUomId)
    }
    let overdueDaysLimit = null
    if (p.overdueDaysLimit != null && p.overdueDaysLimit !== "") {
        overdueDaysLimit = Number(p.overdueDaysLimit)
        if (!Number.isInteger(overdueDaysLimit) || overdueDaysLimit < 0)
            denied("OVERDUE_DAYS_INVALID", "The overdue days are a whole number, not negative")
    }
    if (creditLimit == null && overdueDaysLimit == null) denied("POLICY_EMPTY", "Give a credit limit or overdue days")
    const same =
        current.length === 1 &&
        current[0].currencyUomId === currencyUomId &&
        current[0].actionEnumId === actionEnumId &&
        String(current[0].creditLimit ?? "") === String(creditLimit ?? "") &&
        String(current[0].overdueDaysLimit ?? "") === String(overdueDaysLimit ?? "")
    if (same) return {customerCreditPolicyId: current[0].customerCreditPolicyId, changed: false}
    end()
    const created = call("create#" + POLICY, {
        organizationPartyId,
        customerPartyId,
        currencyUomId,
        creditLimit,
        overdueDaysLimit,
        actionEnumId,
        fromDate: ec.user.nowTimestamp,
        changeReason,
        changedByUserId: ec.user.userId
    })
    return {customerCreditPolicyId: created.customerCreditPolicyId, changed: true}
}

const operations = {evaluate, release, status, store}
;({
    policyFor,
    exposure,
    execute(op, parameters) {
        if (!operations[op]) throw new Error("Unknown credit operation " + op)
        return operations[op](parameters)
    }
})
