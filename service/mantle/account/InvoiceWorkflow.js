// Invoice controls over Mantle's invoice services: the access scope, the period and lock check, the guarded state change,
// the linked credit's cap, line allocation and application, and the receivables queue with its summary.
const lib = ec.resource.script("component://mr-mantle/service/mantle/account/InvoiceWorkflowLib.js")
const guard = ec.resource.script("component://mr-mantle/service/mantle/ledger/PostingGuard.js")
const {find, one, rows, call, denied, has} = lib
const I = lib.invoiceEntity
const T = "mantle.ledger.transaction.AcctgTrans"
const draftStatuses = ["InvoiceInProcess", "InvoiceIncoming", "InvoiceReceived"]
const changeableStatuses = [...draftStatuses, "InvoiceFinalized", "InvoiceApproved", "InvoiceSent"]
const stateActions = {
    InvoiceFinalized: "finalize",
    InvoiceApproved: "approve",
    InvoiceCancelled: "cancel",
    InvoiceInProcess: "resume",
    InvoiceReceived: "receive",
    InvoiceSent: "sent"
}

function isPosted(invoiceId) {
    return find(T, {invoiceId, isPosted: "Y"}).count() > 0
}
function requireDraft(scope) {
    if (!draftStatuses.includes(scope.record.statusId)) denied("INVOICE_NOT_DRAFT", "Only a draft invoice can be edited")
    if (isPosted(scope.record.invoiceId)) denied("INVOICE_POSTED", "Correct a posted invoice with a linked credit")
}
// The book day of the invoice must be in an open fiscal period and not behind an accounting lock the user has no exception
// for (PostingGuard's checks, which the posting itself runs again). A missing period is created by Mantle when it posts.
function period(scope, record = scope.record) {
    if (record.invoiceDate == null) denied("INVOICE_DATE_REQUIRED", "Choose an invoice date")
    const day = record.accountingDate
        ? lib.policy.calendarDateText(record.accountingDate)
        : ec.l10n.format(record.invoiceDate, "yyyy-MM-dd")
    const fiscal = guard.fiscal(scope.organizationPartyId, record.invoiceDate, true, [], day)
    const closed = fiscal.findings.filter(row => row.code !== "PERIOD_MISSING")
    if (closed.length) denied(closed[0].code, closed.map(row => row.message).join("; "))
    const transaction = {organizationPartyId: scope.organizationPartyId, transactionDate: record.invoiceDate, acctgTransId: null}
    const locks = guard.postingLocks(transaction, ["all", scope.receivable ? "sales" : "purchases"], true, day)
    if (locks.findings.length) denied(locks.findings[0].code, "Invoice date is protected by an accounting lock")
}
// The credits linked to an invoice, cancelled ones aside, cannot exceed its total.
function creditCap(record) {
    if (!record.creditForInvoiceId) return
    const source = one(I, {invoiceId: record.creditForInvoiceId})
    const credited = rows(I, {creditForInvoiceId: record.creditForInvoiceId})
        .filter(row => row.statusId !== "InvoiceCancelled")
        .reduce((sum, row) => sum.add(row.invoiceTotal ?? 0), toDecimal(0))
    if (credited.compare(source?.invoiceTotal ?? 0) > 0)
        denied("CREDIT_EXCEEDS_INVOICE", "Credits cannot exceed the original invoice total")
}

// The invoice and its organization for a read, a write or an approval: the side's permission, the organization the user
// works in, and no counterparty another user keeps private. need "draft" also checks a draft that is not posted, its
// revision when checkRevision is set, and the period of the invoice date (or of periodDate, a new date). The invoice comes
// with its party and status names and stored totals; version adds its sourceVersion, capabilities what the user may do.
function scope(p) {
    const need = p.need || "read"
    if (need === "projectRead" && !lib.projectEditor(p)) denied("PERMISSION_DENIED", "Project invoice view authority is required")
    const found =
        need === "read"
            ? lib.readInvoice(p)
            : need === "projectRead"
              ? lib.invoice(p)
              : need === "approve"
                ? lib.invoice(p, "INVOICE_APPROVE", true)
                : lib.writeInvoice(p)
    const record = found.record
    if (need === "draft") {
        requireDraft(found)
        if (p.checkRevision) lib.revision(record, p.lastUpdatedStamp)
        period(found, p.periodDate ? Object.assign(lib.map(record), {invoiceDate: p.periodDate, accountingDate: null}) : record)
    }
    const names = lib.partyNames([record.fromPartyId, record.toPartyId])
    const status = one("moqui.basic.StatusItem", {statusId: record.statusId})
    const result = {
        invoice: Object.assign(lib.invoiceDisplay(record), {
            fromName: names[record.fromPartyId] || "",
            toName: names[record.toPartyId] || "",
            statusDescription: status?.description || record.statusId
        }),
        organizationPartyId: found.organizationPartyId,
        receivable: found.receivable,
        partyId: found.partyId,
        editPermission: found.permission,
        totals: lib.storedTotals(record)
    }
    if (p.version || p.capabilities) result.sourceVersion = lib.fingerprint(record)
    if (p.capabilities) result.capabilities = capabilities(found, result.totals)
    return result
}
// What the user may do with an invoice, by the same rules the services apply.
function capabilities(found, totals) {
    const record = found.record
    const canEdit = has(found.permission)
    const draft = draftStatuses.includes(record.statusId)
    const posted = isPosted(record.invoiceId)
    const issued = !draft && record.statusId !== "InvoiceCancelled"
    const canChangeExistingState =
        canEdit && totals.appliedPayments.isZero() && !posted && changeableStatuses.includes(record.statusId)
    return {
        canReadLedger: lib.access.systemAdmin() || ["ACCOUNTING_VIEW", "ACCOUNTING_GL_POST", "ACCOUNTING_ADMIN"].some(has),
        canDraftEdit: canEdit && draft && !posted,
        canApprove: has("INVOICE_APPROVE") && draft,
        canFinalize: canEdit && draft && lib.policy.preference(found.organizationPartyId).invoiceApprovalRequired !== "Y",
        canSend:
            canEdit &&
            found.receivable &&
            ["InvoiceInProcess", "InvoiceFinalized", "InvoiceSent", "InvoiceAcked"].includes(record.statusId),
        canCredit: canEdit && issued,
        canApply: canEdit && issued && record.invoiceTypeEnumId !== "InvoiceCreditMemo" && totals.unpaidTotal.compare(0) > 0,
        canCancel: canChangeExistingState,
        canResume: canChangeExistingState && !draft,
        canReverse:
            canEdit &&
            found.receivable &&
            record.statusId === "InvoiceInProcess" &&
            !record.creditForInvoiceId &&
            totals.invoiceTotal.compare(0) < 0 &&
            !posted &&
            totals.appliedPayments.isZero()
    }
}
// The organization for a new document, with the permission named.
function organization(p) {
    return {organizationPartyId: lib.organization(p.organizationPartyId, p.permission || null, !!p.lock)}
}
// Which of the permissions named the user holds, as the finance services decide it (ProductAccess.has: an administrator
// holds each, a project client none).
function permissions(p) {
    return Object.fromEntries(Array.from(p.permissions || []).map(permission => [permission, has(permission)]))
}
function check(p) {
    if (p.check === "creditCap") creditCap(one(I, {invoiceId: p.invoiceId}))
    else denied("CHECK_UNKNOWN", "Unknown invoice check " + p.check)
    return {}
}

function approve(scope, preference) {
    lib.requirePermission("INVOICE_APPROVE")
    const record = scope.record
    const selfApproved = record.draftedByUserId === ec.user.userId
    if (selfApproved && preference.allowAccountingSelfApproval !== "Y")
        denied("SELF_APPROVAL_DENIED", "Another finance approver must approve this invoice")
    call("update#" + I, {
        invoiceId: record.invoiceId,
        approvedByUserId: ec.user.userId,
        approvedDate: ec.user.nowTimestamp,
        approvedSourceVersion: lib.fingerprint(record),
        isSelfApproved: selfApproved ? "Y" : "N"
    })
}
// The target status of each action, after its checks.
const transitions = {
    approve: issue,
    finalize: issue,
    resume: reopen,
    cancel: reopen,
    receive: scope => {
        if (scope.record.statusId !== "InvoiceIncoming")
            denied("STATE_TRANSITION_INVALID", "Only an incoming invoice can be received")
        return "InvoiceReceived"
    },
    sent: scope => {
        if (scope.record.statusId !== "InvoiceFinalized")
            denied("STATE_TRANSITION_INVALID", "Only a finalized invoice can be marked sent")
        if (!find("mantle.account.invoice.InvoiceEmailMessage", {invoiceId: scope.record.invoiceId}).count())
            denied("DELIVERY_REQUIRED", "Send this invoice before marking it sent")
        return "InvoiceSent"
    }
}
function issue(scope, p, preference, action) {
    const record = scope.record
    if (!draftStatuses.includes(record.statusId)) denied("STATE_TRANSITION_INVALID", "This invoice cannot be finalized now")
    if (!scope.receivable) lib.requireNotHeld(record.invoiceId)
    if (!find("mantle.account.invoice.InvoiceItem", {invoiceId: record.invoiceId}).count())
        denied("INVOICE_EMPTY", "An invoice needs at least one line")
    if (lib.totals(record).invoiceTotal.compare(0) < 0) denied("INVOICE_NEGATIVE", "Reverse a negative draft before finalizing")
    creditCap(record)
    // A sales invoice gets its tax lines before it is issued; one whose tax cannot be calculated is refused (AC-08).
    if (scope.receivable) call("mantle.other.TaxServices.calculate#InvoiceSalesTax", {invoiceId: record.invoiceId})
    if (action === "approve" || !scope.receivable) approve(scope, preference)
    else if (
        preference.invoiceApprovalRequired === "Y" &&
        (!record.approvedByUserId || record.approvedSourceVersion !== lib.fingerprint(record))
    )
        denied("APPROVAL_REQUIRED", "A finance approver must approve this version before it is finalized")
    return scope.receivable ? "InvoiceFinalized" : "InvoiceApproved"
}
function reopen(scope, p, preference, action) {
    const record = scope.record
    if (lib.totals(record).appliedPayments.compare(0) !== 0)
        denied("INVOICE_APPLIED", "Unapply the invoice before changing its state")
    if (isPosted(record.invoiceId)) denied("INVOICE_POSTED", "Correct a posted invoice with a linked credit")
    if (!changeableStatuses.includes(record.statusId))
        denied("STATE_TRANSITION_INVALID", "This invoice cannot be changed that way now")
    if (!String(p.changeReason || "").trim()) denied("REASON_REQUIRED", "Give a reason for this invoice change")
    if (action === "cancel") return "InvoiceCancelled"
    return record.fromPartyId === scope.organizationPartyId ? "InvoiceInProcess" : "InvoiceReceived"
}
// An issued invoice posts in the same transaction: a posting sent to the error journal refuses the change, and so does no
// posting at all of an invoice with a total.
function requirePosting(scope) {
    const record = scope.record
    const transactions = rows(T, {invoiceId: record.invoiceId, organizationPartyId: scope.organizationPartyId}).filter(
        row => !row.reverseOfAcctgTransId && !row.reversedByAcctgTransId
    )
    const failed = transactions.find(row => row.isPosted !== "Y")
    if (failed)
        denied(
            failed.postingFailureCode || "INVOICE_POST_FAILED",
            failed.postingFailureMessage || "Invoice posting did not complete"
        )
    if (!transactions.length && lib.totals(record).invoiceTotal.compare(0) > 0)
        denied("INVOICE_POST_FAILED", "Invoice finalization did not produce a posted ledger transaction")
}
function changeState(p) {
    const action = p.action || stateActions[p.statusId]
    if (!transitions[action]) denied("STATE_ACTION_INVALID", "Choose an invoice action")
    const scope = action === "approve" ? lib.invoice(p, "INVOICE_APPROVE", true) : lib.writeInvoice(p)
    const record = scope.record
    const request = {
        invoiceId: record.invoiceId,
        organizationPartyId: scope.organizationPartyId,
        action,
        lastUpdatedStamp: p.lastUpdatedStamp == null ? null : String(p.lastUpdatedStamp),
        changeReason: p.changeReason || null
    }
    const operation = p.operationKey && lib.operation(p, "InvoiceState", scope.organizationPartyId, request)
    if (operation?.old) return lib.previous(operation)
    if (p.lastUpdatedStamp != null) lib.revision(record, p.lastUpdatedStamp)
    else if (!p.sourceVersion || p.sourceVersion !== lib.fingerprint(record))
        denied("STALE_REVISION", "Review the current invoice before changing its state")
    const preference = lib.policy.preference(scope.organizationPartyId)
    if (action !== "sent") period(scope)
    const target = transitions[action](scope, p, preference, action)
    call("update#" + I, {
        invoiceId: record.invoiceId,
        statusId: target,
        statusId_changeReason: p.changeReason || "Invoice " + action
    })
    if (action === "approve" || action === "finalize") requirePosting(scope)
    // an approved bill's spending against its budget, after its posting: a purchase order's commitment becomes actual,
    // and a budget Stop refuses the approval unless an overrider gives budgetOverrideReason
    if (!scope.receivable && target === "InvoiceApproved")
        call("mantle.other.BudgetServices.convert#Commitment", {
            invoiceId: record.invoiceId,
            overrideReason: p.budgetOverrideReason || null
        })
    // a sales invoice back in draft is taxed again when it is issued
    if (target === "InvoiceInProcess")
        call("mantle.other.TaxServices.calculate#InvoiceSalesTax", {invoiceId: record.invoiceId, clear: true})
    const saved = one(I, {invoiceId: record.invoiceId})
    const result = {
        invoiceId: record.invoiceId,
        organizationPartyId: scope.organizationPartyId,
        statusId: saved.statusId,
        lastUpdatedStamp: saved.lastUpdatedStamp,
        sourceVersion: lib.fingerprint(saved),
        reasonCode: "OK",
        alreadyApplied: false
    }
    if (operation) lib.complete(operation, I, record.invoiceId, result)
    return result
}

// The finance account of each credit line: the account the original line posted to, else its override, else the item's
// account for the direction. More than one posted account for a line refuses, as does none. An open item imported at
// accounting setup posted to migration clearing, which a later credit must not reach: its credit takes the account the
// organization maps to the Opening balance item type for the direction (impl-accounting §4, F403).
function lineAccount(scope, line, entries, opening = false) {
    if (opening) {
        const mapped = call("mantle.ledger.InvoiceAutoPostServices.get#InvoiceItemGlAccount", {
            organizationPartyId: scope.organizationPartyId,
            otherPartyId: scope.partyId,
            itemTypeEnumId: line.itemTypeEnumId,
            direction: scope.receivable ? "O" : "I"
        }).glAccountId
        if (!mapped)
            denied(
                "CREDIT_ACCOUNT_MISSING",
                "Map the Opening balance item type in the posting defaults to credit an open item imported at setup"
            )
        return mapped
    }
    const posted = [...new Set(entries.filter(row => row.invoiceItemSeqId === line.invoiceItemSeqId).map(row => row.glAccountId))]
    if (posted.length > 1)
        denied("CREDIT_ACCOUNT_AMBIGUOUS", "Source line " + line.invoiceItemSeqId + " has several posted accounts")
    const account =
        posted[0] ||
        line.overrideGlAccountId ||
        call("mantle.ledger.InvoiceAutoPostServices.get#InvoiceItemGlAccount", {
            organizationPartyId: scope.organizationPartyId,
            otherPartyId: scope.partyId,
            itemTypeEnumId: line.itemTypeEnumId,
            productId: line.productId,
            direction: scope.receivable ? "O" : "I"
        }).glAccountId
    if (!account) denied("CREDIT_ACCOUNT_MISSING", "Source line " + line.invoiceItemSeqId + " has no original posting account")
    return account
}
// A linked credit's lines: the amount split over the original's lines in proportion to their totals, the last line taking
// the rounding, each on the account its original line posted to.
function creditLines(p) {
    const record = one(I, {invoiceId: p.invoiceId})
    const scope = {organizationPartyId: p.organizationPartyId, receivable: p.receivable, partyId: p.partyId}
    const amount = ec.l10n.roundCurrency(toDecimal(p.amount), record.currencyUomId)
    const credited = rows(I, {creditForInvoiceId: p.invoiceId})
        .filter(row => row.statusId !== "InvoiceCancelled")
        .reduce((sum, row) => sum.add(row.invoiceTotal ?? 0), toDecimal(0))
    const originalTotal = toDecimal(record.invoiceTotal ?? 0)
    if (credited.add(amount).compare(originalTotal) > 0)
        denied("CREDIT_EXCEEDS_INVOICE", "Credits cannot exceed the original invoice total")
    const lines = Array.from(
        find("mantle.account.invoice.InvoiceItem", {invoiceId: p.invoiceId}).orderBy("invoiceItemSeqId").list()
    )
    const transactionIds = rows(T, {invoiceId: p.invoiceId, organizationPartyId: p.organizationPartyId, isPosted: "Y"})
        .filter(row => !row.reverseOfAcctgTransId && !row.reversedByAcctgTransId)
        .map(row => row.acctgTransId)
    const entries = transactionIds.length
        ? Array.from(
              find("mantle.ledger.transaction.AcctgTransEntry")
                  .condition("acctgTransId", "in", transactionIds)
                  .condition("debitCreditFlag", p.receivable ? "C" : "D")
                  .list()
          )
        : []
    const creditLineList = []
    let allocated = toDecimal(0)
    lines.forEach((line, index) => {
        const portion =
            index === lines.length - 1
                ? amount.subtract(allocated)
                : ec.l10n.roundCurrency(
                      lib.lineTotal(line, record.currencyUomId).multiply(amount).divide(originalTotal, 12, "HALF_UP"),
                      record.currencyUomId
                  )
        allocated = allocated.add(portion)
        if (portion.isZero()) return
        creditLineList.push({
            itemTypeEnumId: line.itemTypeEnumId,
            productId: line.productId,
            quantity: "1",
            amount: portion,
            overrideGlAccountId: lineAccount(scope, line, entries, !!record.openingSetupRunId),
            description: p.description || line.description || "Credit for " + p.invoiceId
        })
    })
    return {creditLineList}
}
// Apply a linked credit to its invoice through apply#InvoiceToInvoice, under both invoices' locks: the same parties and
// currency, both issued, the amount within both balances, and the period of the later document's date open.
function applyCredit(p) {
    const credit = lib.writeInvoice(p)
    const target = lib.writeInvoice({invoiceId: p.toInvoiceId, organizationPartyId: credit.organizationPartyId})
    if (credit.record.creditForInvoiceId !== target.record.invoiceId)
        denied("CREDIT_SOURCE_INVALID", "Choose a credit linked to this invoice")
    if (
        credit.record.currencyUomId !== target.record.currencyUomId ||
        credit.record.fromPartyId !== target.record.toPartyId ||
        credit.record.toPartyId !== target.record.fromPartyId
    )
        denied("SETTLEMENT_SCOPE_INVALID", "A credit and invoice must have the same parties and currency")
    if ([credit.record, target.record].some(row => draftStatuses.includes(row.statusId) || row.statusId === "InvoiceCancelled"))
        denied("SETTLEMENT_STATE_INVALID", "Finalize the credit and invoice before applying them")
    creditCap(credit.record)
    const creditBalance = lib.totals(credit.record).unpaidTotal
    const invoiceBalance = lib.totals(target.record).unpaidTotal
    const requested =
        p.amount == null ? (creditBalance.compare(invoiceBalance) < 0 ? creditBalance : invoiceBalance) : toDecimal(p.amount)
    const amount = ec.l10n.roundCurrency(requested, credit.record.currencyUomId)
    const operation = lib.operation(p, "InvoiceCreditApply", credit.organizationPartyId, {
        invoiceId: p.invoiceId,
        toInvoiceId: p.toInvoiceId,
        amount: p.amount == null ? null : String(p.amount),
        changeReason: p.changeReason || null
    })
    if (operation.old) return lib.previous(operation)
    // The application posts on the later document's date: a closed period of the original does not close the credit.
    const dated = lib.ms(credit.record.invoiceDate) >= lib.ms(target.record.invoiceDate) ? credit.record : target.record
    period(credit, dated)
    if (amount.compare(0) <= 0 || amount.compare(creditBalance) > 0 || amount.compare(invoiceBalance) > 0)
        denied("SETTLEMENT_AMOUNT_INVALID", "The amount must be positive and within both remaining balances")
    const result = call("mantle.account.PaymentServices.apply#InvoiceToInvoice", {
        invoiceId: p.invoiceId,
        toInvoiceId: p.toInvoiceId,
        amount
    })
    if (!result.paymentApplicationId || toDecimal(result.amountApplied || 0).compare(amount) !== 0)
        denied("SETTLEMENT_NOT_APPLIED", "The credit application did not complete")
    const out = {
        invoiceId: p.invoiceId,
        toInvoiceId: p.toInvoiceId,
        paymentApplicationId: result.paymentApplicationId,
        amountApplied: result.amountApplied,
        alreadyApplied: false
    }
    lib.complete(operation, "mantle.account.payment.PaymentApplication", result.paymentApplicationId, out)
    return out
}

// The receivables of an organization the user may read: its customer invoices, linked customer credits and customer
// credits, private counterparties of other users left out, filtered in the query.
function receivableQuery(p) {
    if (!has("ACCOUNTING_VIEW") && !has("ACCOUNTING_ADMIN")) lib.requirePermission("RECEIVABLE_VIEW")
    const organizationPartyId = lib.organization(p.organizationPartyId || lib.policy.access().activeOrganizationPartyId)
    const cf = ec.entity.conditionFactory
    const all = conditions => cf.makeCondition(conditions, "and")
    let query = find("mantle.account.invoice.InvoiceFinance").condition(
        cf.makeCondition(
            [
                all([
                    cf.makeCondition("fromPartyId", "equals", organizationPartyId),
                    cf.makeCondition("creditForInvoiceId", "is-null", null),
                    cf.makeCondition("financeDirection", "is-null", null)
                ]),
                all([
                    cf.makeCondition("sourceFromPartyId", "equals", organizationPartyId),
                    cf.makeCondition("financeDirection", "is-null", null)
                ]),
                all([
                    cf.makeCondition("financeOrganizationPartyId", "equals", organizationPartyId),
                    cf.makeCondition("financeDirection", "equals", "receivable")
                ])
            ],
            "or"
        )
    )
    if (!lib.access.systemAdmin())
        for (const field of ["fromPrivateOwnerUserId", "toPrivateOwnerUserId"])
            query = query.condition(
                cf.makeCondition(
                    [cf.makeCondition(field, "is-null", null), cf.makeCondition(field, "equals", ec.user.userId)],
                    "or"
                )
            )
    if (p.customerPartyId)
        query = query.condition(
            cf.makeCondition(
                [
                    cf.makeCondition("toPartyId", "equals", p.customerPartyId),
                    cf.makeCondition("fromPartyId", "equals", p.customerPartyId)
                ],
                "or"
            )
        )
    if (p.recordId || p.invoiceId) query = query.condition("invoiceId", p.recordId || p.invoiceId)
    if (p.text)
        query = query.condition(
            cf.makeCondition(
                ["invoiceId", "description", "referenceNumber"].map(field =>
                    cf.makeCondition(field, "like", "%" + p.text + "%").ignoreCase()
                ),
                "or"
            )
        )
    if (p.statusId) query = query.condition("statusId", p.statusId)
    if (p.invoiceTypeEnumId) query = query.condition("invoiceTypeEnumId", p.invoiceTypeEnumId)
    if (p.currencyUomId) query = query.condition("currencyUomId", p.currencyUomId)
    for (const [input, field, op] of [
        ["fromDate", "invoiceDate", "greater-equals"],
        ["thruDate", "invoiceDate", "less"],
        ["dueFromDate", "dueDate", "greater-equals"],
        ["dueThruDate", "dueDate", "less"]
    ])
        if (p[input]) query = query.condition(field, op, p[input])
    const queue = p.queue || "all"
    if (queue === "draft") query = query.condition("statusId", "InvoiceInProcess")
    else if (queue === "credits") query = query.condition("invoiceTypeEnumId", "InvoiceCreditMemo")
    else if (["unpaid", "overdue"].includes(queue)) {
        query = query.condition("statusId", "in", ["InvoiceFinalized", "InvoiceSent", "InvoiceAcked"])
        query = query.condition("unpaidTotal", "greater", 0)
        if (queue === "overdue") query = query.condition("dueDate", "less", ec.user.nowTimestamp)
    } else if (queue !== "all") denied("QUEUE_INVALID", "Unknown receivables queue")
    return {query, organizationPartyId}
}
function statusNames(ids) {
    const wanted = [...new Set(ids.filter(Boolean))]
    if (!wanted.length) return {}
    return Object.fromEntries(
        Array.from(find("moqui.basic.StatusItem").condition("statusId", "in", wanted).list()).map(row => [
            row.statusId,
            row.description || row.statusId
        ])
    )
}
// Rows for a screen: display values, stored totals, party and status names.
function receivableRows(records) {
    const names = lib.partyNames(records.flatMap(row => [row.toPartyId, row.fromPartyId]))
    const statuses = statusNames(records.map(row => row.statusId))
    return records.map(row =>
        Object.assign(lib.invoiceDisplay(row), lib.storedTotals(row), {
            toName: names[row.toPartyId],
            fromName: names[row.fromPartyId],
            statusDescription: statuses[row.statusId] || row.statusId
        })
    )
}
function receivables(p) {
    const {query} = receivableQuery(p)
    const result = lib.page(query.orderBy("-invoiceDate,invoiceId"), p, "records", receivableQuery(p).query.count())
    result.rows = receivableRows(result.rows)
    result.records = result.rows
    result.counts = {}
    return result
}
function summary(p) {
    const {query, organizationPartyId} = receivableQuery(p)
    if (receivableQuery(p).query.count() > 10000)
        return {
            summaryRows: [],
            calendarRows: [],
            complete: false,
            incomplete: true,
            errors: [{reasonCode: "REPORT_SCOPE_TOO_LARGE", message: "Narrow the report filters to at most 10000 invoices"}]
        }
    const records = receivableRows(Array.from(query.orderBy("invoiceId").limit(10000).list()))
    const grouped = {}
    for (const record of records) {
        const customerPartyId = record.fromPartyId === organizationPartyId ? record.toPartyId : record.fromPartyId
        const customerName = record.fromPartyId === organizationPartyId ? record.toName : record.fromName
        const key = JSON.stringify([customerPartyId, record.currencyUomId, record.statusId])
        const item =
            grouped[key] ||
            (grouped[key] = {
                customerPartyId,
                customerName,
                statusId: record.statusId,
                statusDescription: record.statusDescription,
                currencyUomId: record.currencyUomId,
                invoiceCount: 0,
                invoiceTotal: toDecimal(0),
                unpaidTotal: toDecimal(0)
            })
        const sign = record.invoiceTypeEnumId === "InvoiceCreditMemo" ? -1 : 1
        item.invoiceCount++
        item.invoiceTotal = item.invoiceTotal.add(record.invoiceTotal.multiply(sign))
        item.unpaidTotal = item.unpaidTotal.add(record.unpaidTotal.multiply(sign))
        record.customerName = customerName
    }
    return {summaryRows: Object.values(grouped), calendarRows: records, complete: true, incomplete: false, errors: []}
}

// An operation key already used: the same request answers its first result, another request is refused.
function replay(p) {
    const operation = lib.operation(p, p.operationType, p.organizationPartyId, p.request || {}, false)
    return {previous: operation.old ? lib.previous(operation) : null, requestHash: operation.requestHash}
}
// Keep an operation's result under its key, in the transaction of the change.
function record(p) {
    lib.complete(
        {
            operationKey: p.operationKey,
            operationType: p.operationType,
            organizationPartyId: p.organizationPartyId,
            requestHash: p.requestHash
        },
        p.resultEntityName || null,
        p.resultId || null,
        p.result || {}
    )
    return {}
}
// process#InvoiceBatch: each invoice in its own transaction, its failure named and the others done.
function batch(p) {
    const organizationPartyId = lib.organization(p.organizationPartyId, "RECEIVABLE_EDIT")
    const ids = [...new Set(Array.from(p.invoiceIdList || []))]
    if (!ids.length || ids.length > 500) denied("BATCH_SELECTION_INVALID", "Select between one and 500 invoices")
    const action = p.action || "send"
    if (!["send", "finalize", "print"].includes(action)) denied("BATCH_ACTION_INVALID", "Choose send, finalize or print")
    const selections = p.attachmentSelectionsByInvoice || {}
    const operation = lib.operation(
        p,
        "InvoiceBatch",
        organizationPartyId,
        {
            invoiceIdList: ids,
            action,
            toAddresses: p.toAddresses || null,
            note: p.note || null,
            sourceVersions: p.sourceVersions || null,
            attachmentSelectionsByInvoice: selections
        },
        false
    )
    if (operation.old) return lib.previous(operation)
    const results = []
    for (const invoiceId of ids) {
        const common = {
            invoiceId,
            organizationPartyId,
            operationKey: "ib:" + lib.hash([p.operationKey, invoiceId, action]).slice(0, 37)
        }
        try {
            if (action !== "print" && p.sourceVersions?.[invoiceId] == null)
                denied("STALE_REVISION", "Review every selected invoice before processing the batch")
            const stamp = {lastUpdatedStamp: p.sourceVersions?.[invoiceId]}
            let result
            if (action === "finalize")
                result = lib.probe(
                    "mantle.account.InvoiceServices.change#InvoiceState",
                    Object.assign(common, stamp, {action: "finalize"})
                )
            else if (action === "print")
                result = lib.probe("mantle.account.InvoiceServices.get#InvoiceOutput", {
                    invoiceId,
                    organizationPartyId,
                    asPdf: true
                })
            else
                result = lib.probe(
                    "mantle.account.InvoiceServices.send#Invoice",
                    Object.assign(common, stamp, p.emailTemplateId ? {emailTemplateId: p.emailTemplateId} : {}, {
                        toAddresses: p.toAddresses || null,
                        note: p.note || null,
                        attachmentContentIdList: selections[invoiceId]?.attachmentContentIdList || [],
                        attachmentVersions: selections[invoiceId]?.attachmentVersions || {}
                    })
                )
            const kept = lib.policy.pick(result, [
                "statusId",
                "contentLocation",
                "invoiceContentId",
                "recipientResults",
                "successCount",
                "failureCount"
            ])
            results.push({invoiceId, success: !result.failureCount, result: kept})
        } catch (error) {
            ec.logger.error("Invoice batch " + p.operationKey + " invoice " + invoiceId + ": " + error.message)
            results.push({
                invoiceId,
                success: false,
                reasonCode: /\b([A-Z][A-Z_]+[A-Z]):/.exec(String(error.message))?.[1] || "BATCH_ITEM_FAILED",
                errorMessage: error.message
            })
        }
    }
    const result = {
        results,
        successCount: results.filter(row => row.success).length,
        failureCount: results.filter(row => !row.success).length,
        alreadyApplied: false
    }
    lib.complete(operation, null, null, result)
    return result
}

const operations = {
    scope,
    organization,
    permissions,
    check,
    changeState,
    creditLines,
    applyCredit,
    receivables,
    summary,
    replay,
    record,
    batch
}
;({
    execute: (op, parameters) => {
        if (!operations[op]) denied("OPERATION_UNKNOWN", "Unknown invoice workflow operation " + op)
        return operations[op](parameters)
    }
})
