// Budgets and budget control (AC-14; mantle.other.BudgetServices and BudgetReportServices): a budget's amounts as of a
// revision, approval and revision with the approved PDF, control policies as dated rows, and commitments reserved,
// converted, released and recorded as actual against an approved budget under its policy. A budget's organization is its
// period's party. Each refusal is denied(reason, message).
const wf = ec.resource.script("component://mr-mantle/service/mantle/account/InvoiceWorkflowLib.js")
const policy = wf.policy
const {find, one, rows, call, ms, denied, has} = wf
const BUDGET = "mantle.other.budget.Budget"
const ITEM = "mantle.other.budget.BudgetItem"
const COMMITMENT = "mantle.other.budget.BudgetCommitment"
const POLICY = "mantle.other.budget.BudgetControlPolicy"
const ORDER = "mantle.order.OrderHeader"
const INVOICE = "mantle.account.invoice.Invoice"
// who may reserve and release spending against a budget: the approvers of the documents that spend (a bill's, and a purchase
// order's: Purchasing's decide#PurchaseApproval reserves at its approval, impl-purchasing P4), budget editors and finance
// administrators; converting is also a bill editor's, since a bill's approval converts its order's commitment
const reservePermissions = ["INVOICE_APPROVE", "PURCHASE_APPROVE", "BUDGET_EDIT", "ACCOUNTING_ADMIN"]
const commitPermissions = reservePermissions.concat(["PAYABLE_EDIT"])
// a source document whose open commitments a user releases without BUDGET_OVERRIDE: closed or cancelled
const closedSources = {
    "mantle.order.OrderHeader": ["orderId", ["OrderCompleted", "OrderCancelled", "OrderRejected"]],
    "mantle.request.Request": ["requestId", ["ReqCompleted", "ReqCancelled", "ReqRejected"]],
    "mantle.account.invoice.Invoice": ["invoiceId", ["InvoiceCancelled"]]
}
const readPermissions = ["ACCOUNTING_VIEW", "ACCOUNTING_ADMIN"]
const zero = () => toDecimal(0)
const dec = value => toDecimal(value ?? 0)

function requireAny(permissions, label) {
    if (!permissions.some(permission => has(permission))) denied("PERMISSION_DENIED", label + " authority is required")
}
function day(value) {
    if (value == null || value === "") return ec.l10n.format(ec.user.nowTimestamp, "yyyy-MM-dd")
    return policy.bookDay(/^\d{4}-\d{2}-\d{2}$/.test(String(value)) ? value : null, value)
}
function nextDay(text) {
    return policy.calendarDateText(Date.parse(text + "T00:00:00Z") + 86400000)
}
function periodDays(period) {
    return {fromDay: policy.calendarDateText(period.fromDate), thruDay: policy.calendarDateText(period.thruDate)}
}

// ---------- budgets ----------

// A budget with its period and organization, checked against the user's organizations (and the permission, when one is
// given); locked for a write.
function budgetScope(budgetId, permission = null, lock = false) {
    let budget = budgetId && one(BUDGET, {budgetId})
    if (!budget) denied("BUDGET_UNAVAILABLE", "Budget is not available")
    const period = budget.timePeriodId && one("mantle.party.time.TimePeriod", {timePeriodId: budget.timePeriodId})
    if (!period?.partyId) denied("BUDGET_UNAVAILABLE", "Budget " + budgetId + " has no organization period")
    const organizationPartyId = wf.organization(period.partyId, permission, lock)
    if (lock) budget = find(BUDGET, {budgetId}).forUpdate(true).one()
    return {budget, period, organizationPartyId, statusId: budget.statusId || "BudgetDraft"}
}
// create#Budget and the item writers: BUDGET_EDIT in the organization of the budget's period (or of the period given).
function editScope(p) {
    if (p.budgetId) return budgetScope(p.budgetId, "BUDGET_EDIT")
    const period = p.timePeriodId && one("mantle.party.time.TimePeriod", {timePeriodId: p.timePeriodId})
    if (!period?.partyId) denied("PERIOD_UNAVAILABLE", "Choose a period of the organization")
    return {organizationPartyId: wf.organization(period.partyId, "BUDGET_EDIT", false)}
}
function readScope(budgetId) {
    const scope = budgetScope(budgetId)
    requireAny(readPermissions, "Accounting read")
    return scope
}
function revisions(budgetId) {
    return rows("mantle.other.budget.BudgetRevision", {budgetId}).sort(
        (a, b) => Number(a.revisionSeqId) - Number(b.revisionSeqId)
    )
}
function subPeriods(budget) {
    if (!budget.subTimePeriodTypeId) return []
    return Array.from(
        call("mantle.party.TimeServices.get#DescendantPeriods", {
            parentPeriodId: budget.timePeriodId,
            timePeriodTypeId: budget.subTimePeriodTypeId,
            createMissing: true
        }).timePeriodList || []
    )
}
// The revision a read is as of: the one named, else the last one on or before asOfDate, else the last; null for a budget
// never approved.
function revisionAsOf(budgetId, revisionSeqId, asOfDate) {
    const all = revisions(budgetId)
    if (!all.length) return null
    if (revisionSeqId != null && revisionSeqId !== "") {
        const found = all.find(row => Number(row.revisionSeqId) === Number(revisionSeqId))
        if (!found) denied("REVISION_UNAVAILABLE", "Budget revision " + revisionSeqId + " is not available")
        return found
    }
    if (asOfDate) {
        const before = all.filter(row => ms(row.dateRevised) <= ms(asOfDate))
        if (!before.length) denied("REVISION_UNAVAILABLE", "The budget was not approved by then")
        return before[before.length - 1]
    }
    return all[all.length - 1]
}
// The budget's items with their amounts as of a revision: each item's amount from the latest revision impact on or before
// it, an item no revision had yet left out. A draft (no revision) reads its current amounts.
function itemsAsOf(budgetId, revision) {
    const items = rows(ITEM, {budgetId})
    if (!revision) return items.map(row => Object.assign(policy.lib.map(row), {amount: row.amount}))
    const through = Number(revision.revisionSeqId)
    const latest = {}
    for (const impact of rows("mantle.other.budget.BudgetRevisionImpact", {budgetId})) {
        if (Number(impact.revisionSeqId) > through) continue
        const known = latest[impact.budgetItemSeqId]
        if (!known || Number(known.revisionSeqId) < Number(impact.revisionSeqId)) latest[impact.budgetItemSeqId] = impact
    }
    return items
        .filter(row => latest[row.budgetItemSeqId])
        .map(row => Object.assign(policy.lib.map(row), {amount: latest[row.budgetItemSeqId].revisedAmount}))
}
// For each account and sub period the amount as of the revision: {glAccountId: {main, subs: {timePeriodId: amount}}}.
function amountsByAccount(items) {
    const out = {}
    for (const item of items) {
        if (!item.glAccountId) continue
        const entry = (out[item.glAccountId] ??= {main: null, mainItemSeqId: null, subs: {}, subItems: {}})
        if (item.subTimePeriodId) {
            entry.subs[item.subTimePeriodId] = dec(item.amount)
            entry.subItems[item.subTimePeriodId] = item.budgetItemSeqId
        } else {
            entry.main = dec(item.amount)
            entry.mainItemSeqId = item.budgetItemSeqId
        }
    }
    return out
}

function amounts(p) {
    const scope = readScope(p.budgetId)
    const revision = scope.statusId === "BudgetDraft" ? null : revisionAsOf(p.budgetId, p.revisionSeqId, p.asOfDate)
    const items = itemsAsOf(p.budgetId, revision)
    return {
        budget: policy.display(scope.budget),
        organizationPartyId: scope.organizationPartyId,
        revisionSeqId: revision?.revisionSeqId ?? null,
        revisionDate: revision?.dateRevised ?? null,
        revisionList: revisions(p.budgetId).map(policy.display),
        itemList: items.map(policy.display),
        subTimePeriodList: subPeriods(scope.budget).map(policy.display)
    }
}

// Every account with sub period amounts adds up to its total.
function requireDistribution(items, currencyUomId) {
    for (const [glAccountId, entry] of Object.entries(amountsByAccount(items))) {
        const subs = Object.values(entry.subs)
        if (!subs.length || entry.main == null) continue
        const total = subs.reduce((sum, value) => sum.add(value), zero())
        const round = value => ec.l10n.roundCurrency(value, currencyUomId)
        if (round(total).compare(round(entry.main)) !== 0)
            denied(
                "BUDGET_DISTRIBUTION",
                "The periods of account " +
                    glAccountId +
                    " add up to " +
                    String(round(total)) +
                    ", not its total " +
                    String(round(entry.main))
            )
    }
}
function nextRevisionSeqId(budgetId) {
    const all = revisions(budgetId)
    return String(all.length ? Number(all[all.length - 1].revisionSeqId) + 1 : 0).padStart(3, "0")
}
function recordRevision(budgetId, revisionSeqId, description) {
    call("create#mantle.other.budget.BudgetRevision", {
        budgetId,
        revisionSeqId,
        dateRevised: ec.user.nowTimestamp,
        description,
        revisedByUserId: ec.user.userId
    })
}

function approve(p) {
    const scope = budgetScope(p.budgetId, "BUDGET_APPROVE", true)
    if (scope.statusId !== "BudgetDraft") denied("STATE_TRANSITION_INVALID", "Only a draft budget is approved")
    const items = rows(ITEM, {budgetId: p.budgetId}).filter(row => row.glAccountId && row.amount != null)
    if (!items.length) denied("BUDGET_EMPTY", "A budget needs an amount for at least one account")
    requireDistribution(items, scope.budget.currencyUomId)
    const preference = policy.preference(scope.organizationPartyId)
    const selfApproved = scope.budget.createdByUserId === ec.user.userId
    if (selfApproved && preference.allowAccountingSelfApproval !== "Y")
        denied("SELF_APPROVAL_DENIED", "Another finance approver must approve this budget")
    if (scope.budget.statusId !== "BudgetDraft") call("update#" + BUDGET, {budgetId: p.budgetId, statusId: "BudgetDraft"})
    call("update#" + BUDGET, {budgetId: p.budgetId, statusId: "BudgetApproved"})
    call("create#mantle.other.budget.BudgetReview", {
        budgetId: p.budgetId,
        partyId: ec.user.userAccount?.partyId || null,
        budgetReviewResultEnumId: "BrrApproved",
        reviewDate: ec.user.nowTimestamp,
        isSelfApproved: selfApproved ? "Y" : "N"
    })
    const revisionSeqId = nextRevisionSeqId(p.budgetId)
    recordRevision(p.budgetId, revisionSeqId, p.changeReason || "Approved")
    for (const item of items)
        call("create#mantle.other.budget.BudgetRevisionImpact", {
            budgetId: p.budgetId,
            budgetItemSeqId: item.budgetItemSeqId,
            revisionSeqId,
            revisedAmount: item.amount,
            addDeleteFlag: "A",
            revisionReason: "Approved"
        })
    const stored = storeDocument(scope, revisionSeqId)
    return {statusId: "BudgetApproved", revisionSeqId, budgetContentId: stored}
}

function changeState(p) {
    if (p.action === "approve") return approve(p)
    const transitions = {
        close: ["BudgetApproved", "BudgetClosed", "Only an approved budget is closed"],
        cancel: ["BudgetDraft", "BudgetCancelled", "Only a draft budget is cancelled"]
    }
    const transition = transitions[p.action]
    if (!transition) denied("ACTION_INVALID", "Unknown budget action " + p.action)
    const scope = budgetScope(p.budgetId, "BUDGET_EDIT", true)
    if (scope.statusId !== transition[0]) denied("STATE_TRANSITION_INVALID", transition[2])
    if (!scope.budget.statusId) call("update#" + BUDGET, {budgetId: p.budgetId, statusId: "BudgetDraft"})
    policy.audit(["statusId"], policy.reason(p))
    call("update#" + BUDGET, {budgetId: p.budgetId, statusId: transition[1]})
    return {statusId: transition[1]}
}

// The amount lines of a revision: an item by its id, or an account with an optional sub period of the budget (an account
// or period the budget lacks adds an item).
function revise(p) {
    const scope = budgetScope(p.budgetId, "BUDGET_EDIT", true)
    if (scope.statusId !== "BudgetApproved") denied("STATE_TRANSITION_INVALID", "Only an approved budget is revised")
    const reason = policy.reason(p)
    const current = revisions(p.budgetId)
    if (p.lastRevisionSeqId != null && p.lastRevisionSeqId !== "") {
        const last = current[current.length - 1]
        if (!last || Number(last.revisionSeqId) !== Number(p.lastRevisionSeqId))
            denied("STALE_REVISION", "The budget was revised since; reload before revising")
    }
    const periodIds = subPeriods(scope.budget).map(row => row.timePeriodId)
    // the matrix form, as store#BudgetItemsSubPeriods takes it: an account's total and its sub period amounts by position
    const lines = Array.from(p.lines || [])
    if (p.glAccountId) {
        if (p.amountMain != null && p.amountMain !== "") lines.push({glAccountId: p.glAccountId, amount: p.amountMain})
        periodIds.forEach((timePeriodId, index) => {
            const amount = p["amountPer" + (index + 1)]
            if (amount != null && amount !== "") lines.push({glAccountId: p.glAccountId, subTimePeriodId: timePeriodId, amount})
        })
    }
    if (!lines.length) denied("REVISION_EMPTY", "A revision changes at least one amount")
    const items = rows(ITEM, {budgetId: p.budgetId})
    const currency = scope.budget.currencyUomId
    const changes = []
    for (const line of lines) {
        if (line.amount == null || line.amount === "" || dec(line.amount).compare(0) < 0)
            denied("AMOUNT_INVALID", "A budget amount is zero or more")
        const amount = ec.l10n.roundCurrency(dec(line.amount), currency)
        let item = line.budgetItemSeqId ? items.find(row => row.budgetItemSeqId === line.budgetItemSeqId) : null
        if (line.budgetItemSeqId && !item) denied("ITEM_UNAVAILABLE", "Budget line " + line.budgetItemSeqId + " is not available")
        if (!item) {
            if (!line.glAccountId) denied("ACCOUNT_REQUIRED", "Choose an account")
            if (!policy.accountAssignment(scope.organizationPartyId, line.glAccountId))
                denied("ACCOUNT_UNAVAILABLE", "Choose an account of the organization")
            const sub = line.subTimePeriodId || null
            if (sub && !periodIds.includes(sub)) denied("PERIOD_UNAVAILABLE", "Choose a period of the budget")
            item = items.find(row => row.glAccountId === line.glAccountId && (row.subTimePeriodId || null) === sub)
            if (!item) {
                const created = call("create#" + ITEM, {
                    budgetId: p.budgetId,
                    glAccountId: line.glAccountId,
                    subTimePeriodId: sub,
                    amount,
                    amount_changeReason: reason
                })
                item = one(ITEM, {budgetId: p.budgetId, budgetItemSeqId: created.budgetItemSeqId})
                items.push(item)
                changes.push({item, amount, added: true})
                continue
            }
        }
        if (item.amount != null && dec(item.amount).compare(amount) === 0) continue
        changes.push({item, amount, added: false})
    }
    if (!changes.length) denied("REVISION_EMPTY", "The revision changes no amount")
    const revisionSeqId = nextRevisionSeqId(p.budgetId)
    recordRevision(p.budgetId, revisionSeqId, reason)
    policy.audit(["amount"], reason)
    for (const change of changes) {
        if (!change.added)
            call("update#" + ITEM, {
                budgetId: p.budgetId,
                budgetItemSeqId: change.item.budgetItemSeqId,
                amount: change.amount,
                amount_changeReason: reason
            })
        call("create#mantle.other.budget.BudgetRevisionImpact", {
            budgetId: p.budgetId,
            budgetItemSeqId: change.item.budgetItemSeqId,
            revisionSeqId,
            revisedAmount: change.amount,
            addDeleteFlag: change.added ? "A" : null,
            revisionReason: reason
        })
    }
    requireDistribution(itemsAsOf(p.budgetId, {revisionSeqId}), currency)
    const stored = storeDocument(scope, revisionSeqId)
    return {revisionSeqId, changedCount: changes.length, budgetContentId: stored}
}

function party(p) {
    const scope = budgetScope(p.budgetId, "BUDGET_EDIT", true)
    if (["BudgetClosed", "BudgetCancelled"].includes(scope.statusId))
        denied("STATE_TRANSITION_INVALID", "A closed or cancelled budget keeps its parties")
    if (!p.partyId || !p.roleTypeId) denied("PARTY_REQUIRED", "Choose a party and its role")
    policy.counterparty(p.partyId)
    if (!one("mantle.party.Party", {partyId: p.partyId})) denied("PARTY_UNAVAILABLE", "Party is not available")
    if (!one("mantle.party.RoleType", {roleTypeId: p.roleTypeId})) denied("ROLE_UNAVAILABLE", "Choose a role")
    const key = {budgetId: p.budgetId, partyId: p.partyId, roleTypeId: p.roleTypeId}
    const existing = one("mantle.other.budget.BudgetParty", key)
    if (p.remove) {
        if (existing) call("delete#mantle.other.budget.BudgetParty", key)
        return {changed: !!existing}
    }
    if (!existing) call("create#mantle.other.budget.BudgetParty", key)
    return {changed: !existing}
}

// The approved budget as a PDF (template/other/Budget.print.html.fancy), stored as its content for the revision. A PDF
// that cannot be made is logged and the approval stands: the amounts are the record, and the revision reads as of itself.
function storeDocument(scope, revisionSeqId) {
    const budgetId = scope.budget.budgetId
    try {
        const items = itemsAsOf(budgetId, {revisionSeqId})
        const accountIds = [...new Set(items.map(item => item.glAccountId).filter(Boolean))]
        const accounts = Object.fromEntries(
            Array.from(
                find("mantle.ledger.account.GlAccount")
                    .condition("glAccountId", "in", accountIds.length ? accountIds : ["_NA_"])
                    .list()
            ).map(row => [row.glAccountId, (row.accountCode || row.glAccountId) + " " + (row.accountName || "")])
        )
        const periods = Object.fromEntries(subPeriods(scope.budget).map(row => [row.timePeriodId, row.periodName]))
        const currency = scope.budget.currencyUomId
        const lines = items
            .map(item => ({
                account: accounts[item.glAccountId] || item.glAccountId || "",
                period: item.subTimePeriodId ? periods[item.subTimePeriodId] || item.subTimePeriodId : "Whole period",
                amount: ec.l10n.formatCurrency(dec(item.amount), currency),
                sort: (accounts[item.glAccountId] || "") + (item.subTimePeriodId ? "1" + item.subTimePeriodId : "0")
            }))
            .sort((a, b) => a.sort.localeCompare(b.sort))
        const total = items.filter(item => !item.subTimePeriodId).reduce((sum, item) => sum.add(dec(item.amount)), zero())
        const revision = one("mantle.other.budget.BudgetRevision", {budgetId, revisionSeqId})
        const html = ec.resource.template("component://mr-mantle/template/other/Budget.print.html.fancy", {
            budgetId,
            description: scope.budget.description || budgetId,
            organizationName: policy.lib.partyNames([scope.organizationPartyId])[scope.organizationPartyId] || "",
            periodName: scope.period.periodName || scope.period.timePeriodId,
            revisionSeqId,
            revisionText: Number(revisionSeqId) === 0 ? "Approved" : "Revision " + Number(revisionSeqId),
            revisionReason: revision?.description || "",
            revisedText: policy.dateText(revision?.dateRevised),
            revisedBy: ec.user.userAccount?.userFullName || ec.user.username || "",
            totalText: ec.l10n.formatCurrency(total, currency),
            lines
        })
        const location = "dbresource://mantle/content/budget/" + budgetId + "/" + revisionSeqId + "/Budget-" + budgetId + ".pdf"
        ec.resource.getLocationReference(location).putBytes(ec.resource.xslFoTransform(html, null, null, "application/pdf"))
        return call("create#mantle.other.budget.BudgetContent", {
            budgetId,
            revisionSeqId,
            contentTypeEnumId: "BctApprovedDocument",
            contentLocation: location,
            contentDate: ec.user.nowTimestamp,
            userId: ec.user.userId,
            description:
                "Budget " + budgetId + ", " + (Number(revisionSeqId) === 0 ? "approved" : "revision " + Number(revisionSeqId))
        }).budgetContentId
    } catch (error) {
        ec.logger.error("Budget " + budgetId + " revision " + revisionSeqId + " PDF was not stored: " + error.message)
        return null
    }
}

// ---------- control policies ----------

function storePolicy(p) {
    const organizationPartyId = policy.organization(p, "admin").organizationPartyId
    const reason = policy.reason(p)
    const now = ec.user.nowTimestamp
    let replaced = null
    if (p.budgetControlPolicyId) {
        replaced = find(POLICY, {budgetControlPolicyId: p.budgetControlPolicyId}).forUpdate(true).one()
        if (!replaced || replaced.organizationPartyId !== organizationPartyId)
            denied("POLICY_UNAVAILABLE", "Budget control policy is not available")
        if (replaced.thruDate && ms(replaced.thruDate) <= ms(now)) denied("POLICY_ENDED", "The policy has ended")
        if (!p.actionEnumId) {
            const endDate = p.thruDate || now
            if (ms(endDate) <= ms(replaced.fromDate)) denied("POLICY_DATES_INVALID", "A policy must end after it starts")
            policy.audit(["thruDate"], reason)
            call("update#" + POLICY, {budgetControlPolicyId: replaced.budgetControlPolicyId, thruDate: endDate})
            return {budgetControlPolicyId: replaced.budgetControlPolicyId}
        }
    }
    const fields = {
        organizationPartyId,
        budgetId: (replaced ? replaced.budgetId : p.budgetId) || null,
        glAccountId: (replaced ? replaced.glAccountId : p.glAccountId) || null,
        stageEnumId: (replaced ? replaced.stageEnumId : p.stageEnumId) || null,
        actionEnumId: p.actionEnumId,
        thresholdPercent: p.thresholdPercent != null && p.thresholdPercent !== "" ? dec(p.thresholdPercent) : dec(100),
        fromDate: p.fromDate || now,
        thruDate: p.thruDate || null,
        description: p.description || replaced?.description || null,
        changeReason: reason,
        changedByUserId: ec.user.userId
    }
    if (!one("moqui.basic.Enumeration", {enumId: fields.actionEnumId || "_NA_", enumTypeId: "BudgetControlAction"}))
        denied("ACTION_REQUIRED", "Choose Ignore, Warn or Stop")
    if (fields.stageEnumId && !one("moqui.basic.Enumeration", {enumId: fields.stageEnumId, enumTypeId: "BudgetControlStage"}))
        denied("STAGE_INVALID", "Choose a request, purchase order or expense stage")
    if (fields.thresholdPercent.compare(0) <= 0 || fields.thresholdPercent.compare(1000) > 0)
        denied("THRESHOLD_INVALID", "Enter a threshold from 1 to 1000 percent")
    if (fields.budgetId) {
        const scope = budgetScope(fields.budgetId)
        if (scope.organizationPartyId !== organizationPartyId) denied("BUDGET_UNAVAILABLE", "Choose a budget of the organization")
    }
    if (fields.glAccountId && !policy.accountAssignment(organizationPartyId, fields.glAccountId))
        denied("ACCOUNT_UNAVAILABLE", "Choose an account of the organization")
    if (fields.thruDate && ms(fields.thruDate) <= ms(fields.fromDate))
        denied("POLICY_DATES_INVALID", "A policy must end after it starts")
    if (replaced && ms(fields.fromDate) <= ms(replaced.fromDate))
        denied("POLICY_DATES_INVALID", "A new version starts after the one it replaces")
    // no other row of the same scope over the same dates
    const until = row => ms(row.thruDate) ?? Infinity
    const overlapping = rows(POLICY, {organizationPartyId}).filter(
        row =>
            row.budgetControlPolicyId !== replaced?.budgetControlPolicyId &&
            (row.budgetId || null) === fields.budgetId &&
            (row.glAccountId || null) === fields.glAccountId &&
            (row.stageEnumId || null) === fields.stageEnumId &&
            ms(row.fromDate) < (ms(fields.thruDate) ?? Infinity) &&
            until(row) > ms(fields.fromDate)
    )
    if (overlapping.length)
        denied(
            "POLICY_OVERLAP",
            "Policy " + overlapping[0].budgetControlPolicyId + " already covers these dates; change it instead"
        )
    if (replaced) {
        policy.audit(["thruDate"], reason)
        call("update#" + POLICY, {budgetControlPolicyId: replaced.budgetControlPolicyId, thruDate: fields.fromDate})
    }
    return {budgetControlPolicyId: call("create#" + POLICY, fields).budgetControlPolicyId}
}

// The policy row in effect on a day for an account and stage: budget and account, then account, then budget, then the
// organization's; a row for the stage before one for every stage; of equals the latest started.
function policyFor(organizationPartyId, budgetId, glAccountId, stageEnumId, date) {
    const candidates = rows(POLICY, {organizationPartyId}).filter(
        row =>
            policy.active(row, date) &&
            (!row.budgetId || row.budgetId === budgetId) &&
            (!row.glAccountId || row.glAccountId === glAccountId) &&
            (!row.stageEnumId || row.stageEnumId === stageEnumId)
    )
    const rank = row => (row.glAccountId ? 4 : 0) + (row.budgetId ? 2 : 0) + (row.stageEnumId ? 1 : 0)
    candidates.sort((a, b) => rank(b) - rank(a) || ms(b.fromDate) - ms(a.fromDate))
    return candidates[0] || null
}

// ---------- spending against a budget ----------

// The approved budget line an account's spending on a day counts against: the sub period item that holds the day, else
// the account's item for the budget's whole period. Of several approved budgets the first made.
function budgetLine(organizationPartyId, glAccountId, bookDay) {
    const periodIds = rows("mantle.party.time.TimePeriod", {partyId: organizationPartyId})
        .filter(row => policy.calendarDateText(row.fromDate) <= bookDay && policy.calendarDateText(row.thruDate) >= bookDay)
        .map(row => row.timePeriodId)
    if (!periodIds.length) return null
    const budgets = Array.from(
        find(BUDGET, {statusId: "BudgetApproved"}).condition("timePeriodId", "in", periodIds).orderBy("budgetId").list()
    )
    for (const budget of budgets) {
        // an approved budget's numbers are its latest revision's; one approved without a revision controls nothing. Only
        // the account's items and their revision impacts are read.
        const latest = Array.from(
            find("mantle.other.budget.BudgetRevision", {budgetId: budget.budgetId}).orderBy("-revisionSeqId").limit(1).list()
        )[0]
        if (!latest) continue
        const accountItems = rows(ITEM, {budgetId: budget.budgetId, glAccountId})
        if (!accountItems.length) continue
        const revised = {}
        for (const impact of find("mantle.other.budget.BudgetRevisionImpact", {budgetId: budget.budgetId})
            .condition(
                "budgetItemSeqId",
                "in",
                accountItems.map(row => row.budgetItemSeqId)
            )
            .list()) {
            if (Number(impact.revisionSeqId) > Number(latest.revisionSeqId)) continue
            const known = revised[impact.budgetItemSeqId]
            if (!known || Number(known.revisionSeqId) < Number(impact.revisionSeqId)) revised[impact.budgetItemSeqId] = impact
        }
        const items = accountItems
            .filter(row => revised[row.budgetItemSeqId]?.revisedAmount != null)
            .map(row => Object.assign(policy.lib.map(row), {amount: revised[row.budgetItemSeqId].revisedAmount}))
        if (!items.length) continue
        for (const item of items.filter(row => row.subTimePeriodId)) {
            const sub = one("mantle.party.time.TimePeriod", {timePeriodId: item.subTimePeriodId})
            if (sub && policy.calendarDateText(sub.fromDate) <= bookDay && policy.calendarDateText(sub.thruDate) >= bookDay)
                return {budget, item, period: sub, amount: dec(item.amount)}
        }
        const main = items.find(row => !row.subTimePeriodId)
        if (main)
            return {
                budget,
                item: main,
                period: one("mantle.party.time.TimePeriod", {timePeriodId: budget.timePeriodId}),
                amount: dec(main.amount)
            }
    }
    return null
}
// Posted debits less credits of an account over the days (the actual, net of credits).
function actualAmount(organizationPartyId, glAccountIds, fromDay, thruDay) {
    const totals = {}
    if (!glAccountIds.length) return totals
    const afterDay = nextDay(thruDay)
    const dates = policy.accountingDateCondition({
        fromDate: ec.l10n.parseTimestamp(fromDay, "yyyy-MM-dd"),
        thruDate: ec.l10n.parseTimestamp(afterDay, "yyyy-MM-dd"),
        fromDay,
        thruDay: afterDay
    })
    // a period close's closing entries move the balance to retained earnings; they are not spending
    const conditions = ec.entity.conditionFactory
    const notClosing = conditions.makeCondition(
        [
            conditions.makeCondition("acctgTransTypeEnumId", "is-null", null),
            conditions.makeCondition("acctgTransTypeEnumId", "not-in", ["AttPeriodClosing", "AttNetIncomeClosing"])
        ],
        "or"
    )
    const query = find("mantle.ledger.transaction.AcctgTransAndEntrySummary", {organizationPartyId, isPosted: "Y"})
        .condition("glAccountId", "in", glAccountIds)
        .condition(dates)
        .condition(notClosing)
        .selectField("glAccountId")
        .selectField("debitCreditFlag")
        .selectField("amount")
    for (const row of query.list()) {
        const signed = dec(row.amount).multiply(row.debitCreditFlag === "D" ? 1 : -1)
        totals[row.glAccountId] = (totals[row.glAccountId] || zero()).add(signed)
    }
    return totals
}
// What each commitment has passed on to later stages: the commitments converted from it (except blocked and reversed ones).
function consumedAmounts(commitmentIds) {
    const consumed = {}
    if (!commitmentIds.length) return consumed
    for (const child of find(COMMITMENT)
        .condition("convertedFromId", "in", commitmentIds)
        .condition("statusId", "not-in", ["BcBlocked", "BcReversed"])
        .list())
        consumed[child.convertedFromId] = (consumed[child.convertedFromId] || zero()).add(dec(child.amount))
    return consumed
}
function openAmount(commitment, consumed) {
    const open = dec(commitment.amount).subtract(consumed[commitment.budgetCommitmentId] || zero())
    return open.compare(0) > 0 ? open : zero()
}
// Open reserved amounts by account over the days.
function committedAmount(organizationPartyId, glAccountIds, fromDay, thruDay) {
    const totals = {}
    if (!glAccountIds.length) return totals
    const reserved = Array.from(
        find(COMMITMENT, {organizationPartyId, statusId: "BcReserved"})
            .condition("glAccountId", "in", glAccountIds)
            .condition("commitmentDate", "greater-equals", fromDay)
            .condition("commitmentDate", "less-equals", thruDay)
            .list()
    )
    const consumed = consumedAmounts(reserved.map(row => row.budgetCommitmentId))
    for (const row of reserved) totals[row.glAccountId] = (totals[row.glAccountId] || zero()).add(openAmount(row, consumed))
    return totals
}

// The budget decision for spending of an account on a day: requested (new spending less what earlier stages already
// hold for it), projected (actual and committed after it), and the policy's action when the projection passes the
// threshold. posted: the spending is already in the actual (a bill approved and posted).
function evaluate(
    organizationPartyId,
    stageEnumId,
    glAccountId,
    bookDay,
    amount,
    consumed = zero(),
    posted = false,
    line = budgetLine(organizationPartyId, glAccountId, bookDay)
) {
    const requested = dec(amount).subtract(consumed)
    const result = {glAccountId, requestedAmount: requested, decisionEnumId: "BcdNoControl", over: false, blocked: false}
    if (!line) return Object.assign(result, {message: "No approved budget for account " + glAccountId + " on " + bookDay})
    const {fromDay, thruDay} = periodDays(line.period)
    const actual = actualAmount(organizationPartyId, [glAccountId], fromDay, thruDay)[glAccountId] || zero()
    const committed = committedAmount(organizationPartyId, [glAccountId], fromDay, thruDay)[glAccountId] || zero()
    const spent = posted ? actual.subtract(dec(amount)).add(committed) : actual.add(committed)
    const projected = spent.add(dec(amount)).subtract(consumed)
    const rule = policyFor(organizationPartyId, line.budget.budgetId, glAccountId, stageEnumId, ec.user.nowTimestamp)
    const threshold = rule?.thresholdPercent != null ? dec(rule.thresholdPercent) : dec(100)
    const limit = line.amount.multiply(threshold).divide(100)
    const currency = line.budget.currencyUomId
    const over = requested.compare(0) > 0 && projected.compare(limit) > 0
    const action = rule?.actionEnumId || "BcaIgnore"
    Object.assign(result, {
        budgetId: line.budget.budgetId,
        budgetItemSeqId: line.item.budgetItemSeqId,
        timePeriodId: line.period.timePeriodId,
        periodName: line.period.periodName,
        currencyUomId: currency,
        budgetAmount: line.amount,
        actualAmount: actual,
        committedAmount: committed,
        spentAmount: spent,
        availableAmount: limit.subtract(spent),
        projectedAmount: projected,
        thresholdPercent: threshold,
        budgetControlPolicyId: rule?.budgetControlPolicyId || null,
        actionEnumId: action,
        over
    })
    const money = value => ec.l10n.formatCurrency(value, currency)
    const facts =
        "account " +
        glAccountId +
        " in " +
        (line.period.periodName || line.period.timePeriodId) +
        ": budget " +
        money(line.amount) +
        ", spent and committed " +
        money(spent) +
        ", requested " +
        money(requested)
    if (action === "BcaIgnore") return Object.assign(result, {message: "Not controlled: " + facts})
    if (!over) return Object.assign(result, {decisionEnumId: "BcdWithin", message: "Within budget: " + facts})
    if (action === "BcaWarn") return Object.assign(result, {decisionEnumId: "BcdWarned", message: "Over budget: " + facts})
    return Object.assign(result, {decisionEnumId: "BcdBlocked", blocked: true, message: "Over budget (Stop): " + facts})
}

// A Stop passes only with an override: a reason from a user holding BUDGET_OVERRIDE. Otherwise the refusal is recorded as
// a blocked commitment, in its own transaction, and the organization's overriders are notified once for it.
function decide(evaluation, p, key) {
    if (!evaluation.blocked) return evaluation
    const reason = String(p.overrideReason || "").trim()
    if (reason && has("BUDGET_OVERRIDE")) {
        if (reason.length > 255) denied("OVERRIDE_REASON_INVALID", "Give an override reason of at most 255 characters")
        return Object.assign(evaluation, {
            decisionEnumId: "BcdOverridden",
            blocked: false,
            overrideReason: reason,
            overrideByUserId: ec.user.userId
        })
    }
    try {
        ec.service
            .sync()
            .name("mantle.other.BudgetServices.record#BlockedCommitment")
            .parameters({fields: commitmentFields(evaluation, key, "BcBlocked")})
            .requireNewTransaction(true)
            .disableAuthz()
            .call()
    } catch (error) {
        ec.logger.error("Blocked budget commitment for " + key.sourceId + " was not recorded: " + error.message)
    }
    if (reason) denied("PERMISSION_DENIED", "BUDGET_OVERRIDE authority is required to pass a Stop. " + evaluation.message)
    denied("BUDGET_EXCEEDED", evaluation.message + "; an override needs a reason and BUDGET_OVERRIDE authority")
}
function commitmentFields(evaluation, key, statusId) {
    return {
        organizationPartyId: key.organizationPartyId,
        budgetId: evaluation.budgetId || null,
        budgetItemSeqId: evaluation.budgetItemSeqId || null,
        glAccountId: evaluation.glAccountId,
        timePeriodId: evaluation.timePeriodId || null,
        commitmentDate: key.commitmentDate,
        sourceEntityName: key.sourceEntityName,
        sourceId: key.sourceId,
        sourceItemId: key.sourceItemId || null,
        sourceRevision: key.sourceRevision,
        stageEnumId: key.stageEnumId,
        amount: key.amount,
        currencyUomId: evaluation.currencyUomId || key.currencyUomId || null,
        statusId,
        convertedFromId: key.convertedFromId || null,
        budgetControlPolicyId: evaluation.budgetControlPolicyId || null,
        decisionEnumId: evaluation.decisionEnumId,
        budgetAmount: evaluation.budgetAmount ?? null,
        spentAmount: evaluation.spentAmount ?? null,
        availableAmount: evaluation.availableAmount ?? null,
        decisionMessage: String(evaluation.message || "").slice(0, 255),
        overrideReason: evaluation.overrideReason || null,
        overrideByUserId: evaluation.overrideByUserId || null,
        createdDate: ec.user.nowTimestamp,
        createdByUserId: ec.user.userId
    }
}
// record#BlockedCommitment: one blocked row per source key, and the BudgetOverride notice when it is first recorded.
function recordBlocked(p) {
    const fields = p.fields
    // two refusals of the same line at once record one row: the budget item orders them (the caller holds the budget,
    // and its posting the accounts)
    find(ITEM, {budgetId: fields.budgetId, budgetItemSeqId: fields.budgetItemSeqId}).forUpdate(true).one()
    const existing = rows(COMMITMENT, {
        sourceEntityName: fields.sourceEntityName,
        sourceId: fields.sourceId,
        sourceRevision: fields.sourceRevision,
        stageEnumId: fields.stageEnumId,
        statusId: "BcBlocked"
    }).find(row => (row.sourceItemId || null) === (fields.sourceItemId || null) && row.glAccountId === fields.glAccountId)
    if (existing) return {budgetCommitmentId: existing.budgetCommitmentId, notified: false}
    const budgetCommitmentId = call("create#" + COMMITMENT, fields).budgetCommitmentId
    const payables = ec.resource.script("component://mr-mantle/service/mantle/account/Payables.js")
    payables.execute("notify", {
        topic: "BudgetOverride",
        permission: "BUDGET_OVERRIDE",
        organizationPartyId: fields.organizationPartyId,
        recordEntityName: COMMITMENT,
        recordId: budgetCommitmentId,
        message: {
            budgetCommitmentId,
            organizationPartyId: fields.organizationPartyId,
            sourceEntityName: fields.sourceEntityName,
            sourceId: fields.sourceId,
            amount: String(fields.amount),
            currencyUomId: fields.currencyUomId,
            message: fields.decisionMessage
        }
    })
    return {budgetCommitmentId, notified: true}
}
// The commitments of a source key that are not blocked.
function keyed(key) {
    return rows(COMMITMENT, {
        sourceEntityName: key.sourceEntityName,
        sourceId: key.sourceId,
        stageEnumId: key.stageEnumId
    }).filter(
        row =>
            !["BcBlocked", "BcReversed"].includes(row.statusId) &&
            (row.sourceItemId || null) === (key.sourceItemId || null) &&
            (key.sourceRevision == null || row.sourceRevision === key.sourceRevision)
    )
}
// Overriders' notices about a source line are read once it passes.
function clearBlocked(key, glAccountId) {
    const blocked = rows(COMMITMENT, {
        sourceEntityName: key.sourceEntityName,
        sourceId: key.sourceId,
        statusId: "BcBlocked"
    }).filter(row => (row.sourceItemId || null) === (key.sourceItemId || null) && row.glAccountId === glAccountId)
    const payables = ec.resource.script("component://mr-mantle/service/mantle/account/Payables.js")
    for (const row of blocked)
        payables.execute("clearNotices", {
            topic: "BudgetOverride",
            recordEntityName: COMMITMENT,
            recordId: row.budgetCommitmentId
        })
}
function commitScope(p, permissions = commitPermissions) {
    requireAny(permissions, "Budget commitment")
    if (!p.organizationPartyId) denied("ORGANIZATION_REQUIRED", "Choose an internal organization")
    return wf.organization(p.organizationPartyId, null, false)
}
function sourceKey(p, organizationPartyId, stageEnumId) {
    if (!p.sourceEntityName || !p.sourceId) denied("SOURCE_REQUIRED", "A commitment names its source document")
    if (p.sourceRevision == null || p.sourceRevision === "") denied("SOURCE_REVISION_REQUIRED", "Name the source's revision")
    if (!one("moqui.basic.Enumeration", {enumId: stageEnumId || "_NA_", enumTypeId: "BudgetControlStage"}))
        denied("STAGE_INVALID", "Choose a request, purchase order or expense stage")
    if (p.amount == null || p.amount === "" || dec(p.amount).compare(0) <= 0)
        denied("AMOUNT_INVALID", "A commitment amount is more than zero")
    return {
        organizationPartyId,
        sourceEntityName: p.sourceEntityName,
        sourceId: p.sourceId,
        sourceItemId: p.sourceItemId || null,
        sourceRevision: String(p.sourceRevision),
        stageEnumId,
        amount: dec(p.amount),
        currencyUomId: p.currencyUomId || null,
        commitmentDate: day(p.commitmentDate)
    }
}
function requireSame(existing, key, glAccountId) {
    if (dec(existing.amount).compare(key.amount) !== 0 || existing.glAccountId !== glAccountId)
        denied("SOURCE_REVISION_REUSED", "Commitment " + existing.budgetCommitmentId + " holds this source revision differently")
}
function lockBudget(evaluation) {
    if (evaluation.budgetId) find(BUDGET, {budgetId: evaluation.budgetId}).forUpdate(true).one()
}
function answer(row, existing) {
    return {
        budgetCommitmentId: row.budgetCommitmentId,
        statusId: row.statusId,
        decisionEnumId: row.decisionEnumId,
        message: row.decisionMessage,
        availableAmount: row.availableAmount,
        existing
    }
}

function reserve(p) {
    const organizationPartyId = commitScope(p, reservePermissions)
    const stageEnumId = p.stageEnumId || "BcsRequest"
    if (stageEnumId === "BcsExpense") denied("STAGE_INVALID", "An expense is recorded by convert#Commitment")
    const key = sourceKey(p, organizationPartyId, stageEnumId)
    if (!p.glAccountId || !policy.accountAssignment(organizationPartyId, p.glAccountId))
        denied("ACCOUNT_UNAVAILABLE", "Choose an account of the organization")
    // what the source line's earlier revisions already passed on to later stages stays there: the new revision holds
    // the rest
    const earlier = () =>
        keyed(Object.assign({}, key, {sourceRevision: null})).filter(row => row.sourceRevision !== key.sourceRevision)
    const carried = () => {
        const before = earlier()
        const consumed = consumedAmounts(before.map(row => row.budgetCommitmentId))
        return before.reduce((sum, row) => sum.add(consumed[row.budgetCommitmentId] || zero()), zero())
    }
    // a retry of the same source revision answers the first
    const retry = () => {
        const same = keyed(key)[0]
        if (!same) return null
        requireSame(same, Object.assign({}, key, {amount: key.amount.subtract(carried())}), p.glAccountId)
        return answer(same, true)
    }
    const first = retry()
    if (first) return first
    const amount = key.amount.subtract(carried())
    // the budget is locked before any commitment row: budget, then commitment, everywhere
    const budgetOf = budgetLine(organizationPartyId, p.glAccountId, key.commitmentDate)
    lockBudget({budgetId: budgetOf?.budget.budgetId})
    const again = retry()
    if (again) return again
    // a new revision of the source line replaces the open commitment of an earlier one
    for (const row of earlier().filter(row => row.statusId === "BcReserved"))
        call("update#" + COMMITMENT, {
            budgetCommitmentId: row.budgetCommitmentId,
            statusId: "BcReleased",
            releasedDate: ec.user.nowTimestamp
        })
    if (amount.compare(0) <= 0)
        return {
            budgetCommitmentId: null,
            statusId: null,
            decisionEnumId: null,
            existing: false,
            message: "Later stages already hold the whole amount of this source line"
        }
    const net = Object.assign({}, key, {amount})
    const evaluation = decide(
        evaluate(organizationPartyId, stageEnumId, p.glAccountId, key.commitmentDate, amount, zero(), false, budgetOf),
        p,
        net
    )
    requireCurrency(evaluation, key)
    if (evaluation.decisionEnumId === "BcdWarned") ec.message.addMessage(evaluation.message, "warning")
    const created = call("create#" + COMMITMENT, commitmentFields(evaluation, net, "BcReserved"))
    clearBlocked(key, p.glAccountId)
    return answer(one(COMMITMENT, {budgetCommitmentId: created.budgetCommitmentId}), false)
}
function requireCurrency(evaluation, key) {
    if (key.currencyUomId && evaluation.currencyUomId && key.currencyUomId !== evaluation.currencyUomId)
        denied("CURRENCY_MISMATCH", "The budget is in " + evaluation.currencyUomId + ", not " + key.currencyUomId)
}
// A reserved commitment is converted once later stages hold all of it, and reserved again when some comes back.
function settleParents(parentIds) {
    const consumed = consumedAmounts(parentIds)
    for (const id of parentIds) {
        const parent = one(COMMITMENT, {budgetCommitmentId: id})
        const open = parent ? openAmount(parent, consumed).compare(0) > 0 : false
        if (parent?.statusId === "BcReserved" && !open)
            call("update#" + COMMITMENT, {budgetCommitmentId: id, statusId: "BcConverted"})
        else if (parent?.statusId === "BcConverted" && open)
            call("update#" + COMMITMENT, {budgetCommitmentId: id, statusId: "BcReserved"})
    }
}
// Lock the budgets of evaluations in budgetId order, so two sessions never wait on each other.
function lockBudgets(evaluations) {
    for (const budgetId of [...new Set(evaluations.map(row => row.budgetId).filter(Boolean))].sort())
        find(BUDGET, {budgetId}).forUpdate(true).one()
}

// convert#Commitment: a reserved commitment passed on to a later stage (a request to its purchase order, an order line to
// its expense), or with invoiceId every posted line of an approved bill.
function convert(p) {
    if (p.invoiceId) return convertInvoice(p)
    const organizationPartyId = commitScope(p)
    const stageEnumId = p.stageEnumId || "BcsOrder"
    const key = sourceKey(p, organizationPartyId, stageEnumId)
    let parent = p.fromCommitmentId ? one(COMMITMENT, {budgetCommitmentId: p.fromCommitmentId}) : null
    if (!parent && p.fromSourceEntityName)
        parent = rows(COMMITMENT, {
            organizationPartyId,
            sourceEntityName: p.fromSourceEntityName,
            sourceId: p.fromSourceId,
            statusId: "BcReserved"
        }).find(row => (row.sourceItemId || null) === (p.fromSourceItemId || null))
    if (!parent || parent.organizationPartyId !== organizationPartyId)
        denied("COMMITMENT_UNAVAILABLE", "No open commitment of the source to convert")
    const glAccountId = p.glAccountId || parent.glAccountId
    const retry = () => {
        const same = keyed(key)[0]
        if (!same) return null
        requireSame(same, key, glAccountId)
        return answer(same, true)
    }
    const first = retry()
    if (first) return first
    const posted = stageEnumId === "BcsExpense"
    const budgetOf = budgetLine(organizationPartyId, glAccountId, key.commitmentDate)
    lockBudgets([{budgetId: budgetOf?.budget.budgetId}, {budgetId: parent.budgetId}])
    const again = retry()
    if (again) return again
    parent = find(COMMITMENT, {budgetCommitmentId: parent.budgetCommitmentId}).forUpdate(true).one()
    if (parent.statusId !== "BcReserved") denied("COMMITMENT_CLOSED", "Commitment " + parent.budgetCommitmentId + " is not open")
    const open = openAmount(parent, consumedAmounts([parent.budgetCommitmentId]))
    const used = open.compare(key.amount) < 0 ? open : key.amount
    // a commitment converts only on its own account; on another account its share is released and the spending is new
    const sameAccount = parent.glAccountId === glAccountId
    const consumed = sameAccount ? used : zero()
    const evaluation = decide(
        evaluate(organizationPartyId, stageEnumId, glAccountId, key.commitmentDate, key.amount, consumed, posted, budgetOf),
        p,
        key
    )
    requireCurrency(evaluation, key)
    if (evaluation.decisionEnumId === "BcdWarned") ec.message.addMessage(evaluation.message, "warning")
    if (!sameAccount && used.compare(0) > 0) releaseShare(parent, used, key, glAccountId)
    const fields = commitmentFields(
        evaluation,
        Object.assign({}, key, {convertedFromId: sameAccount ? parent.budgetCommitmentId : null}),
        posted ? "BcActual" : "BcReserved"
    )
    const created = call("create#" + COMMITMENT, fields)
    settleParents([parent.budgetCommitmentId])
    clearBlocked(key, glAccountId)
    return answer(one(COMMITMENT, {budgetCommitmentId: created.budgetCommitmentId}), false)
}
// The share of a commitment that later spending took on another account: released, as a child of the commitment, so the
// commitment's account no longer holds it and the other account counts the spending itself.
function releaseShare(parent, amount, key, glAccountId) {
    call(
        "create#" + COMMITMENT,
        Object.assign(
            commitmentFields(
                {
                    glAccountId: parent.glAccountId,
                    budgetId: parent.budgetId,
                    budgetItemSeqId: parent.budgetItemSeqId,
                    timePeriodId: parent.timePeriodId,
                    currencyUomId: parent.currencyUomId,
                    decisionEnumId: "BcdNoControl",
                    message: "Spent on account " + glAccountId + " by " + key.sourceId
                },
                Object.assign({}, key, {amount, convertedFromId: parent.budgetCommitmentId}),
                "BcReleased"
            ),
            {releasedDate: ec.user.nowTimestamp}
        )
    )
}

// An approved bill's actuals: each posted debit line (not reversed) with an approved budget or a purchase order line
// commitment becomes an actual commitment, converting the order line's open commitment (OrderItemBilling) first when it
// is on the line's account. Each order commitment's open amount is used once across the bill's lines. The lines of an
// account are decided together, after the posting, keyed by the bill's approved version, with the budgets locked in
// order.
function convertInvoice(p) {
    const invoice = one(INVOICE, {invoiceId: p.invoiceId})
    if (!invoice) denied("INVOICE_UNAVAILABLE", "Invoice is not available")
    const organizationPartyId = invoice.toPartyId
    commitScope({organizationPartyId})
    const revision = invoice.approvedSourceVersion || wf.fingerprint(invoice)
    const base = {
        organizationPartyId,
        sourceEntityName: INVOICE,
        sourceId: p.invoiceId,
        sourceRevision: revision,
        stageEnumId: "BcsExpense",
        currencyUomId: invoice.currencyUomId,
        commitmentDate: policy.bookDay(invoice.accountingDate, invoice.invoiceDate)
    }
    const done = () =>
        rows(COMMITMENT, {sourceEntityName: INVOICE, sourceId: p.invoiceId, sourceRevision: revision}).filter(
            row => !["BcBlocked", "BcReversed"].includes(row.statusId)
        )
    if (done().length) return {budgetCommitmentIds: done().map(row => row.budgetCommitmentId), existing: true}
    // the posted debit lines of the bill, by line and account, from its posting in effect (as revert#InvoicePost reads it)
    const transIds = rows("mantle.ledger.transaction.AcctgTrans", {invoiceId: p.invoiceId, isPosted: "Y"})
        .filter(row => !row.reversedByAcctgTransId && !row.reverseOfAcctgTransId)
        .map(row => row.acctgTransId)
    const lines = {}
    if (transIds.length)
        for (const entry of find("mantle.ledger.transaction.AcctgTransEntry")
            .condition("acctgTransId", "in", transIds)
            .condition("debitCreditFlag", "D")
            .list()) {
            if (!entry.invoiceItemSeqId || !entry.glAccountId) continue
            const lineKey = entry.invoiceItemSeqId + ":" + entry.glAccountId
            const line = (lines[lineKey] ??= {
                invoiceItemSeqId: entry.invoiceItemSeqId,
                glAccountId: entry.glAccountId,
                amount: zero()
            })
            line.amount = line.amount.add(dec(entry.amount))
        }
    const lineList = Object.values(lines).sort((a, b) => String(a.invoiceItemSeqId).localeCompare(String(b.invoiceItemSeqId)))
    // the budgets first, then the commitment rows (budget, then commitment, everywhere): the budget line of each account
    // of the bill and the budgets of the order commitments its lines would convert
    const lineOf = {}
    for (const line of lineList)
        if (!(line.glAccountId in lineOf))
            lineOf[line.glAccountId] = budgetLine(organizationPartyId, line.glAccountId, base.commitmentDate)
    const billings = {}
    const parentBudgets = []
    for (const line of lineList) {
        billings[line.invoiceItemSeqId] ??= rows("mantle.order.OrderItemBilling", {
            invoiceId: p.invoiceId,
            invoiceItemSeqId: line.invoiceItemSeqId
        })
        for (const billing of billings[line.invoiceItemSeqId])
            for (const row of rows(COMMITMENT, {
                sourceEntityName: ORDER,
                sourceId: billing.orderId,
                sourceItemId: billing.orderItemSeqId,
                statusId: "BcReserved"
            }))
                parentBudgets.push({budgetId: row.budgetId})
    }
    lockBudgets(
        Object.values(lineOf)
            .map(line => ({budgetId: line?.budget.budgetId}))
            .concat(parentBudgets)
    )
    if (done().length) return {budgetCommitmentIds: done().map(row => row.budgetCommitmentId), existing: true}
    // each line's purchase order commitments through its billing links; what one line takes of a commitment the next
    // cannot take again
    const usedOf = {}
    const consumedOf = {}
    for (const line of lineList) {
        line.parents = []
        line.consumed = zero()
        let remaining = line.amount
        for (const billing of billings[line.invoiceItemSeqId]) {
            const reserved = Array.from(
                find(COMMITMENT, {
                    sourceEntityName: ORDER,
                    sourceId: billing.orderId,
                    sourceItemId: billing.orderItemSeqId,
                    statusId: "BcReserved"
                })
                    .orderBy("budgetCommitmentId")
                    .forUpdate(true)
                    .list()
            )
            Object.assign(
                consumedOf,
                consumedAmounts(reserved.map(row => row.budgetCommitmentId).filter(id => !(id in consumedOf)))
            )
            for (const parent of reserved) {
                if (remaining.compare(0) <= 0) break
                const open = openAmount(parent, consumedOf).subtract(usedOf[parent.budgetCommitmentId] || zero())
                const used = open.compare(remaining) < 0 ? open : remaining
                if (used.compare(0) <= 0) continue
                usedOf[parent.budgetCommitmentId] = (usedOf[parent.budgetCommitmentId] || zero()).add(used)
                const sameAccount = parent.glAccountId === line.glAccountId
                line.parents.push({parent, used, sameAccount})
                if (sameAccount) line.consumed = line.consumed.add(used)
                remaining = remaining.subtract(used)
            }
        }
    }
    // decide each account's lines together, each account evaluated once
    const byAccount = {}
    for (const line of lineList) (byAccount[line.glAccountId] ??= []).push(line)
    const groups = Object.entries(byAccount).map(([glAccountId, accountLines]) => ({
        glAccountId,
        accountLines,
        amount: accountLines.reduce((sum, line) => sum.add(line.amount), zero()),
        consumed: accountLines.reduce((sum, line) => sum.add(line.consumed), zero()),
        linked: accountLines.some(line => line.parents.length)
    }))
    const created = []
    const parentIds = new Set()
    groups.forEach(group => {
        const {glAccountId, accountLines, amount, consumed} = group
        if (!lineOf[glAccountId] && !group.linked) return
        const accountKey = Object.assign({}, base, {amount, sourceItemId: accountLines[0].invoiceItemSeqId})
        const evaluation = decide(
            evaluate(
                organizationPartyId,
                "BcsExpense",
                glAccountId,
                base.commitmentDate,
                amount,
                consumed,
                true,
                lineOf[glAccountId]
            ),
            p,
            accountKey
        )
        if (evaluation.decisionEnumId === "BcdWarned") ec.message.addMessage(evaluation.message, "warning")
        for (const line of accountLines) {
            const lineKey = Object.assign({}, base, {sourceItemId: line.invoiceItemSeqId})
            // the part converted from each order commitment on the line's account, then the rest of the line on its own;
            // a commitment on another account gives up its share
            const pieces = []
            for (const {parent, used, sameAccount} of line.parents) {
                parentIds.add(parent.budgetCommitmentId)
                if (sameAccount) pieces.push({amount: used, convertedFromId: parent.budgetCommitmentId})
                else releaseShare(parent, used, lineKey, glAccountId)
            }
            const rest = line.amount.subtract(line.consumed)
            if (rest.compare(0) > 0 || !pieces.length) pieces.push({amount: rest, convertedFromId: null})
            for (const piece of pieces) {
                if (piece.amount.compare(0) <= 0) continue
                const key = Object.assign({}, lineKey, {amount: piece.amount, convertedFromId: piece.convertedFromId})
                const fields = commitmentFields(Object.assign({}, evaluation, {glAccountId}), key, "BcActual")
                created.push(call("create#" + COMMITMENT, fields).budgetCommitmentId)
            }
        }
        clearBlocked(accountKey, glAccountId)
    })
    settleParents([...parentIds])
    return {budgetCommitmentIds: created, existing: false}
}

// reverse#InvoiceActuals: a bill whose approval is undone (Approved to Received) or which is cancelled reverses its actual
// commitments, so the order commitments they converted are open again.
function reverseInvoice(p) {
    // the budgets first, then the commitment rows
    const affected = rows(COMMITMENT, {sourceEntityName: INVOICE, sourceId: p.invoiceId}).filter(
        row => row.statusId === "BcActual" || (row.statusId === "BcReleased" && row.convertedFromId)
    )
    const parents = [...new Set(affected.map(row => row.convertedFromId).filter(Boolean))].map(id =>
        one(COMMITMENT, {budgetCommitmentId: id})
    )
    lockBudgets(affected.concat(parents.filter(Boolean)))
    const actual = Array.from(
        find(COMMITMENT, {sourceEntityName: INVOICE, sourceId: p.invoiceId, statusId: "BcActual"}).forUpdate(true).list()
    )
    // the order shares released to another account by the bill come back too
    const shares = rows(COMMITMENT, {sourceEntityName: INVOICE, sourceId: p.invoiceId, statusId: "BcReleased"}).filter(
        row => row.convertedFromId
    )
    for (const row of actual.concat(shares))
        call("update#" + COMMITMENT, {
            budgetCommitmentId: row.budgetCommitmentId,
            statusId: "BcReversed",
            releasedDate: ec.user.nowTimestamp
        })
    const reopened = new Set()
    for (const row of actual.concat(shares)) {
        const parent = row.convertedFromId && one(COMMITMENT, {budgetCommitmentId: row.convertedFromId})
        if (!parent) continue
        if (parent.statusId !== "BcReleased") {
            reopened.add(parent.budgetCommitmentId)
            continue
        }
        // the order line was revised since: its current revision holds the amount again
        const current = rows(COMMITMENT, {
            sourceEntityName: parent.sourceEntityName,
            sourceId: parent.sourceId,
            stageEnumId: parent.stageEnumId
        })
            .filter(
                other =>
                    (other.sourceItemId || null) === (parent.sourceItemId || null) &&
                    ["BcReserved", "BcConverted"].includes(other.statusId)
            )
            .sort((a, b) => ms(b.createdDate) - ms(a.createdDate))[0]
        if (!current) continue
        call("update#" + COMMITMENT, {
            budgetCommitmentId: current.budgetCommitmentId,
            amount: dec(current.amount).add(dec(row.amount)),
            amount_changeReason: "Bill " + p.invoiceId + " reversed"
        })
        reopened.add(current.budgetCommitmentId)
    }
    settleParents([...reopened])
    return {reversedCount: actual.length}
}

// release#Commitment: what is left of a closed or cancelled source's open commitments; a source still open needs
// BUDGET_OVERRIDE or finance administration.
function release(p) {
    const organizationPartyId = commitScope(p, reservePermissions)
    if (!p.sourceEntityName || !p.sourceId) denied("SOURCE_REQUIRED", "Name the source document to release")
    if (!has("BUDGET_OVERRIDE") && !has("ACCOUNTING_ADMIN")) {
        const [pkName, statuses] = closedSources[p.sourceEntityName] || []
        const source = pkName ? one(p.sourceEntityName, {[pkName]: p.sourceId}) : null
        if (!source || !statuses.includes(source.statusId))
            denied("SOURCE_OPEN", "Only a closed or cancelled source's commitments are released, or by BUDGET_OVERRIDE")
    }
    return releaseOpen(organizationPartyId, p)
}
// release#ClosedSourceCommitments: internal to a service that closed the source in its own checked operation (Purchasing's
// close#PurchaseRemainders completing or cancelling an order): what is left of the closed source's open commitments, in
// each organization that holds them. The source must be closed or cancelled; no permission of its own.
function releaseClosed(p) {
    const [pkName, statuses] = closedSources[p.sourceEntityName] || []
    const source = pkName && p.sourceId ? one(p.sourceEntityName, {[pkName]: p.sourceId}) : null
    if (!source || !statuses.includes(source.statusId))
        denied("SOURCE_OPEN", "Only a closed or cancelled source's commitments are released")
    const organizations = [
        ...new Set(
            rows(COMMITMENT, {sourceEntityName: p.sourceEntityName, sourceId: p.sourceId, statusId: "BcReserved"}).map(
                row => row.organizationPartyId
            )
        )
    ]
    const released = organizations.map(organizationPartyId => releaseOpen(organizationPartyId, p))
    return {
        releasedCount: released.reduce((total, part) => total + part.releasedCount, 0),
        budgetCommitmentIds: released.flatMap(part => part.budgetCommitmentIds)
    }
}
function releaseOpen(organizationPartyId, p) {
    const open = Array.from(
        find(COMMITMENT, {
            organizationPartyId,
            sourceEntityName: p.sourceEntityName,
            sourceId: p.sourceId,
            statusId: "BcReserved"
        })
            .forUpdate(true)
            .list()
    ).filter(
        row =>
            (!p.sourceItemId || row.sourceItemId === p.sourceItemId) &&
            (!p.stageEnumId || row.stageEnumId === p.stageEnumId) &&
            (!p.sourceRevision || row.sourceRevision === String(p.sourceRevision))
    )
    for (const row of open)
        call("update#" + COMMITMENT, {
            budgetCommitmentId: row.budgetCommitmentId,
            statusId: "BcReleased",
            releasedDate: ec.user.nowTimestamp
        })
    return {releasedCount: open.length, budgetCommitmentIds: open.map(row => row.budgetCommitmentId)}
}

// check#Budget: the decision each line would get now, with nothing written.
function check(p) {
    requireAny(commitPermissions.concat(readPermissions, ["BUDGET_OVERRIDE"]), "Budget")
    if (!p.organizationPartyId) denied("ORGANIZATION_REQUIRED", "Choose an internal organization")
    const organizationPartyId = wf.organization(p.organizationPartyId, null, false)
    const stageEnumId = p.stageEnumId || "BcsExpense"
    const bookDay = day(p.commitmentDate)
    const lines = Array.from(p.lines || []).concat(p.glAccountId ? [{glAccountId: p.glAccountId, amount: p.amount}] : [])
    if (!lines.length) denied("LINES_REQUIRED", "Name an account and amount to check")
    const results = lines.map(line => {
        const evaluation = evaluate(organizationPartyId, stageEnumId, line.glAccountId, bookDay, dec(line.amount))
        const out = {}
        for (const [name, value] of Object.entries(evaluation)) out[name] = value
        out.canOverride = evaluation.blocked && has("BUDGET_OVERRIDE")
        return out
    })
    return {checkList: results, blocked: results.some(row => row.blocked), warned: results.some(row => row.over)}
}

// ---------- reads ----------

// run#BudgetVariance: for each account of the budget the amount as of the revision, what is committed and the actual
// (posted debits less credits) over the budget's period or one of its sub periods, the remaining amount and the variance.
// The organization is checked, and the period must be the budget's own (F6).
function variance(p) {
    const s = policy.organization(p, "reportRead")
    const scope = budgetScope(p.budgetId)
    if (scope.organizationPartyId !== s.organizationPartyId)
        denied("BUDGET_UNAVAILABLE", "The budget belongs to another organization")
    const subs = subPeriods(scope.budget)
    let period = scope.period
    if (p.timePeriodId && p.timePeriodId !== scope.budget.timePeriodId) {
        period = subs.find(row => row.timePeriodId === p.timePeriodId)
        if (!period) denied("PERIOD_UNAVAILABLE", "Choose the budget's period or one of its sub periods")
    }
    const revision = scope.statusId === "BudgetDraft" ? null : revisionAsOf(p.budgetId, p.revisionSeqId, p.asOfDate)
    const byAccount = amountsByAccount(itemsAsOf(p.budgetId, revision))
    let accountIds = Object.keys(byAccount)
    if (p.glAccountId) accountIds = accountIds.filter(id => id === p.glAccountId)
    const {fromDay, thruDay} = periodDays(period)
    const actual = actualAmount(scope.organizationPartyId, accountIds, fromDay, thruDay)
    const committed = committedAmount(scope.organizationPartyId, accountIds, fromDay, thruDay)
    const accounts = accountIds.length
        ? Object.fromEntries(
              Array.from(find("mantle.ledger.account.GlAccount").condition("glAccountId", "in", accountIds).list()).map(row => [
                  row.glAccountId,
                  row
              ])
          )
        : {}
    const isSub = period.timePeriodId !== scope.budget.timePeriodId
    const totals = {approved: zero(), committed: zero(), actual: zero(), remaining: zero()}
    const varianceRows = accountIds
        .map(glAccountId => {
            const entry = byAccount[glAccountId]
            const approvedAmount = isSub
                ? (entry.subs[period.timePeriodId] ?? null)
                : (entry.main ?? Object.values(entry.subs).reduce((sum, value) => sum.add(value), zero()))
            const actualValue = actual[glAccountId] || zero()
            const committedValue = committed[glAccountId] || zero()
            const remaining = approvedAmount == null ? null : approvedAmount.subtract(actualValue).subtract(committedValue)
            const varianceValue = approvedAmount == null ? null : actualValue.add(committedValue).subtract(approvedAmount)
            totals.approved = totals.approved.add(approvedAmount ?? zero())
            totals.committed = totals.committed.add(committedValue)
            totals.actual = totals.actual.add(actualValue)
            if (remaining != null) totals.remaining = totals.remaining.add(remaining)
            const account = accounts[glAccountId]
            return {
                glAccountId,
                accountCode: account?.accountCode || glAccountId,
                accountName: account?.accountName || "",
                timePeriodId: period.timePeriodId,
                periodName: period.periodName || period.timePeriodId,
                approvedAmount,
                committedAmount: committedValue,
                actualAmount: actualValue,
                remainingAmount: remaining,
                varianceAmount: varianceValue,
                // a zero budget has no percent: unavailable, not infinity
                variancePercent:
                    approvedAmount == null || approvedAmount.isZero()
                        ? null
                        : varianceValue.multiply(100).divide(approvedAmount).toNumber(),
                overBudget: remaining != null && remaining.compare(0) < 0
            }
        })
        .sort((a, b) => String(a.accountCode).localeCompare(String(b.accountCode)))
    return {
        budget: policy.display(scope.budget),
        organizationPartyId: scope.organizationPartyId,
        timePeriodId: period.timePeriodId,
        periodName: period.periodName || period.timePeriodId,
        revisionSeqId: revision?.revisionSeqId ?? null,
        revisionDateText: revision ? policy.dateText(revision.dateRevised) : "",
        isDraft: scope.statusId === "BudgetDraft",
        currencyUomId: scope.budget.currencyUomId,
        varianceRows,
        // a row without a budget amount (no amount for the sub period) leaves the budget and remaining totals unavailable
        totalApproved: varianceRows.some(row => row.approvedAmount == null) ? null : totals.approved,
        totalCommitted: totals.committed,
        totalActual: totals.actual,
        totalRemaining: varianceRows.some(row => row.approvedAmount == null) ? null : totals.remaining,
        subTimePeriodList: subs.map(policy.display),
        asOf: ec.l10n.format(ec.user.nowTimestamp, "yyyy-MM-dd HH:mm:ss")
    }
}

// An invoice's budget evidence (InvoiceDetail's Budget details): its commitments with their budget, account and status.
function invoiceCommitments(invoiceId) {
    return rows(COMMITMENT, {sourceEntityName: INVOICE, sourceId: invoiceId})
        .filter(row => row.statusId !== "BcBlocked")
        .sort((a, b) => ms(a.createdDate) - ms(b.createdDate))
        .map(row => {
            const out = policy.display(row)
            const budget = row.budgetId && one(BUDGET, {budgetId: row.budgetId})
            const account = row.glAccountId && one("mantle.ledger.account.GlAccount", {glAccountId: row.glAccountId})
            out.budgetText = budget ? budget.description || budget.budgetId : ""
            out.accountText = account ? (account.accountCode || account.glAccountId) + " " + (account.accountName || "") : ""
            out.statusText = one("moqui.basic.StatusItem", {statusId: row.statusId})?.description || row.statusId
            out.decisionText = row.decisionEnumId
                ? one("moqui.basic.Enumeration", {enumId: row.decisionEnumId})?.description || row.decisionEnumId
                : ""
            if (row.convertedFromId) {
                const from = one(COMMITMENT, {budgetCommitmentId: row.convertedFromId})
                out.convertedFromText = from
                    ? "Order " + from.sourceId + (from.sourceItemId ? " line " + from.sourceItemId : "")
                    : ""
            }
            return out
        })
}

const operations = {
    amounts,
    changeState,
    revise,
    party,
    storePolicy,
    reserve,
    convert,
    release,
    releaseClosed,
    reverseInvoice,
    editScope: p => ({organizationPartyId: editScope(p).organizationPartyId}),
    check,
    recordBlocked,
    variance,
    invoiceCommitments,
    openAmounts: ids => consumedAmounts(ids)
}
;({
    execute: (op, parameters) => {
        if (!operations[op]) denied("OPERATION_UNKNOWN", "Unknown budget operation " + op)
        return operations[op](parameters)
    },
    commitPermissions,
    readPermissions
})
