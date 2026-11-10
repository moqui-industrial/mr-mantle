// Trade settlement: the allocation plan and its retained review, confirmed through Mantle's apply services, and the
// rules those services check on every application. The retained preview is the authority for what is confirmed.
const workflow = ec.resource.script("component://mr-mantle/service/mantle/account/PaymentWorkflow.js")
const {lib, context, key, parseKey, selected, query, project} = workflow
const {find, one, rows, call, denied, map, hash, policy} = lib
const guard = ec.resource.script("component://mr-mantle/service/mantle/ledger/PostingGuard.js")
const T = "mantle.ledger.transaction.AcctgTrans",
    E = "mantle.ledger.transaction.AcctgTransEntry",
    I = workflow.I,
    P = workflow.P,
    A = workflow.A,
    services = "mantle.account.PaymentServices."
// The item types of a settlement adjustment: a credit memo line posted to the account the user chose.
const adjustmentTypes = ["ItemPromptDiscount", "ItemWriteOff"]
const day = /^\d{4}-\d{2}-\d{2}$/
const terms = () => ec.resource.script("component://mr-mantle/service/mantle/account/PaymentTerms.js")

function dateInput(value, canonicalDay = null) {
    if (!value) denied("EFFECTIVE_DATE_REQUIRED", "Choose an effective accounting date")
    const text = String(value),
        bookDay = canonicalDay || (day.test(text) ? text : ec.l10n.format(value, "yyyy-MM-dd"))
    const timestamp = day.test(text) ? ec.l10n.parseTimestamp(bookDay + " 00:00:00", "yyyy-MM-dd HH:mm:ss") : lib.ms(value)
    if (!timestamp || !day.test(bookDay) || (!canonicalDay && ec.l10n.format(timestamp, "yyyy-MM-dd") !== bookDay))
        denied("DATE_INVALID", "Choose a valid accounting date")
    return {day: bookDay, timestamp}
}
function invoiceAccount(scope, invoice, payable) {
    const result = call("mantle.ledger.InvoiceAutoPostServices.get#InvoiceTypeTransType", {
        organizationPartyId: scope.organizationPartyId,
        invoiceTypeEnumId: invoice.invoiceTypeEnumId,
        isPayable: payable ? "Y" : "N"
    })
    if (!result.glAccountId) denied("MAPPING_MISSING", "The invoice control account is not configured")
    return result.glAccountId
}
function paymentAccount(scope, payment, payable) {
    const result = call("mantle.ledger.PaymentAutoPostServices.get#PaymentTypeGlAccount", {
        organizationPartyId: scope.organizationPartyId,
        paymentTypeEnumId: payment.paymentTypeEnumId,
        isApplied: "N",
        isPayable: payable ? "Y" : "N",
        otherPartyId: scope.partyId
    })
    if (!result.glAccountId) denied("MAPPING_MISSING", "The unapplied payment account is not configured")
    return result.glAccountId
}
// The posted, unreversed source postings of a document: an invoice's own posting or a payment's cash posting.
function activeTransactions(field, id, org = null) {
    let q = find(T, Object.assign({[field]: id, isPosted: "Y"}, org ? {organizationPartyId: org} : {}))
        .condition("reversedByAcctgTransId", "is-null", null)
        .condition("reverseOfAcctgTransId", "is-null", null)
    if (field === "invoiceId") q = q.condition("paymentId", "is-null", null).condition("paymentApplicationId", "is-null", null)
    else q = q.condition("acctgTransTypeEnumId", "in", guard.cashTypes)
    return Array.from(q.orderBy("acctgTransId").list())
}
function lockPostings(scope, selectedRows) {
    const ids = [
        ...new Set(
            selectedRows.flatMap(row =>
                activeTransactions(
                    ["invoice", "credit"].includes(row.sourceKind) ? "invoiceId" : "paymentId",
                    row.sourceId,
                    scope.organizationPartyId
                ).map(tx => tx.acctgTransId)
            )
        )
    ].sort()
    if (!ids.length) return
    Array.from(find(T).condition("acctgTransId", "in", ids).orderBy("acctgTransId").forUpdate(true).list())
    Array.from(find(E).condition("acctgTransId", "in", ids).orderBy("acctgTransId,acctgTransEntrySeqId").forUpdate(true).list())
}
function postedEvidence(record, invoice, scope) {
    const transactions = activeTransactions(
        invoice ? "invoiceId" : "paymentId",
        invoice ? record.invoiceId : record.paymentId,
        scope.organizationPartyId
    )
    if (!transactions.length) denied("SOURCE_NOT_POSTED", "Settlement requires a successfully posted source document")
    const ids = transactions.map(row => row.acctgTransId)
    if (find(T, {isPosted: "Y"}).condition("reverseOfAcctgTransId", "in", ids).limit(1).one())
        denied("SOURCE_POSTING_REVERSED", "An original posting has a posted reversal and cannot fund settlement")
    if (transactions.some(row => row.glFiscalTypeEnumId !== "GLFT_ACTUAL"))
        denied("SOURCE_POSTING_NOT_ACTUAL", "Settlement requires actual ledger backing")
    if (transactions.some(row => row.amountUomId !== scope.currencyUomId))
        denied("SOURCE_POSTING_CURRENCY_MISMATCH", "The original posting currency does not match its financial document")
    const pref = policy.preference(scope.organizationPartyId)
    if (transactions.some(row => row.glJournalId && row.glJournalId === pref.errorGlJournalId))
        denied("SOURCE_NOT_POSTED", "An error journal cannot fund settlement")
    const entries = Array.from(find(E).condition("acctgTransId", "in", ids).orderBy("acctgTransId,acctgTransEntrySeqId").list())
    return {
        transactions: transactions.map(map),
        entries: entries.map(map),
        postingDays: transactions.map(row => ({acctgTransId: row.acctgTransId, day: policy.postingDay(row)}))
    }
}
function proof(evidence, account, flag, amount) {
    try {
        guard.controlProof(evidence, account, flag, amount)
    } catch (error) {
        denied("SOURCE_POSTING_INCOMPLETE", "The posted control amount does not match its financial document")
    }
}
// Cash posted straight to the invoice's control account restores only that invoice, and only with no other history.
function directHistory(payment, invoiceId, transactions, history) {
    if (!payment.forInvoiceId || invoiceId !== payment.forInvoiceId || transactions.some(tx => tx.invoiceId !== invoiceId))
        denied("DIRECT_PAYMENT_HISTORY_INCONSISTENT", "Direct cash can only restore its original invoice application")
    if (history.some(row => row.invoiceId !== invoiceId || row.toInvoiceId || row.toPaymentId))
        denied("DIRECT_PAYMENT_HISTORY_INCONSISTENT", "Reconcile prior off-invoice applications before restoring direct cash")
    const ids = history.map(row => row.paymentApplicationId)
    if (
        ids.length &&
        find(T, {isPosted: "Y"})
            .condition("paymentApplicationId", "in", ids)
            .condition("reverseOfAcctgTransId", "is-null", null)
            .condition("reversedByAcctgTransId", "is-null", null)
            .condition("acctgTransTypeEnumId", "not-in", guard.cashTypes)
            .limit(1)
            .one()
    )
        denied("DIRECT_PAYMENT_HISTORY_INCONSISTENT", "Reconcile additional application postings before restoring direct cash")
}
function allocationPlan(scope, source, target, amount, postingByKey, recordByKey) {
    const sp = parseKey(source.sourceKey),
        tp = parseKey(target.sourceKey)
    if (
        !["payment", "credit"].includes(sp.kind) ||
        !["invoice", "paymentTarget"].includes(tp.kind) ||
        (sp.kind === "credit" && tp.kind !== "invoice")
    )
        denied("SETTLEMENT_PAIR_INVALID", "Choose a payment or credit against an invoice, or opposite payments")
    const s = recordByKey[source.sourceKey],
        t = recordByKey[target.sourceKey]
    if (s.fromPartyId !== t.toPartyId || s.toPartyId !== t.fromPartyId)
        denied("SETTLEMENT_PARTIES_MISMATCH", "The selected records do not have opposite parties")
    const outgoing = s.fromPartyId === scope.organizationPartyId
    const evidence = postingByKey[source.sourceKey],
        targetEvidence = postingByKey[target.sourceKey]
    proof(
        targetEvidence,
        tp.kind === "invoice"
            ? invoiceAccount(scope, t, t.toPartyId === scope.organizationPartyId)
            : paymentAccount(scope, t, t.fromPartyId === scope.organizationPartyId),
        t.fromPartyId === scope.organizationPartyId ? "D" : "C",
        target.original
    )
    const lines = [],
        add = (glAccountId, debitCreditFlag) => lines.push({glAccountId, debitCreditFlag, amount: String(amount)})
    let direct = false
    if (sp.kind === "payment") {
        const unapplied = paymentAccount(scope, s, outgoing)
        const hasUnapplied = evidence.entries.some(row => row.glAccountId === unapplied)
        const accountIds = [...new Set(evidence.entries.map(row => row.glAccountId).filter(Boolean))]
        const posterHasUnapplied =
            accountIds.length > 0 &&
            find("mantle.ledger.account.GlAccount")
                .condition("glAccountId", "in", accountIds)
                .condition("glAccountClassEnumId", "in", ["UNEARNED_REVENUE", "PREPAID_EXPENSE"])
                .count() > 0
        if (hasUnapplied !== posterHasUnapplied)
            denied("SOURCE_POSTING_UNSUPPORTED", "The current payment mapping and original unapplied posting disagree")
        if (!hasUnapplied) {
            if (tp.kind !== "invoice" || s.forInvoiceId !== t.invoiceId)
                denied("SOURCE_NOT_UNAPPLIED", "The payment was not posted to an available unapplied account")
            const history = workflow.applications([s]).filter(row => toDecimal(row.amountApplied || 0).compare(0) > 0)
            directHistory(s, t.invoiceId, evidence.transactions, history)
            const applied = invoiceAccount(scope, t, outgoing)
            proof(evidence, applied, outgoing ? "D" : "C", s.amount)
            direct = true
        } else {
            proof(evidence, unapplied, outgoing ? "D" : "C", s.amount)
            add(unapplied, outgoing ? "C" : "D")
            add(
                tp.kind === "invoice" ? invoiceAccount(scope, t, outgoing) : paymentAccount(scope, t, !outgoing),
                outgoing ? "D" : "C"
            )
        }
    } else {
        proof(evidence, invoiceAccount(scope, s, !outgoing), outgoing ? "D" : "C", source.original)
        add(invoiceAccount(scope, s, !outgoing), outgoing ? "C" : "D")
        add(invoiceAccount(scope, t, outgoing), outgoing ? "D" : "C")
    }
    return {sourceKey: source.sourceKey, targetKey: target.sourceKey, amount: String(amount), direct, lines}
}
function validatePolicy(scope, date, plans, lock = false) {
    const pref = policy.preference(scope.organizationPartyId)
    if (pref.baseCurrencyUomId !== scope.currencyUomId)
        denied("CURRENCY_MISMATCH", "Settlement requires the organization's base currency")
    const fiscal = guard.fiscal(scope.organizationPartyId, date.timestamp, lock, [], date.day)
    const lockOut = guard.postingLocks(
        {organizationPartyId: scope.organizationPartyId, transactionDate: date.timestamp},
        scope.direction === "transfer" ? ["all"] : ["all", scope.direction === "receivable" ? "sales" : "purchases"],
        lock,
        date.day,
        true
    )
    const findings = [...fiscal.findings, ...lockOut.findings]
    if (findings.length) denied(findings[0].code, findings.map(row => row.message).join("; "))
    const accountIds = [...new Set(plans.flatMap(row => row.lines).map(row => row.glAccountId))].sort()
    const accounts = accountIds.map(id => {
        const checked = policy.account(scope.organizationPartyId, id, date.timestamp)
        if (
            pref.requiredLedgerDimensionsEnabled === "Y" &&
            (checked.assignment.facilityRequired === "Y" || checked.assignment.costCenterRequired === "Y")
        )
            denied("DIMENSION_REQUIRED", "Settlement account " + id + " requires ledger dimensions")
        return {
            account: policy.pick(map(checked.row), ["glAccountId", "glAccountTypeEnumId", "disallowPosting"]),
            assignment: policy.pick(map(checked.assignment), ["organizationPartyId", "fromDate", "thruDate"])
        }
    })
    return {
        preference: policy.pick(map(pref), ["baseCurrencyUomId", "postingGuardEnabled", "requiredLedgerDimensionsEnabled"]),
        periods: fiscal.periods.map(row => policy.pick(map(row), ["timePeriodId", "isClosed"])),
        locks: lockOut.locks.map(row => policy.pick(map(row), ["accountingLockId", "lockThroughDate", "isHard"])),
        accounts
    }
}
function adjustmentRow(scope, date, byKey, row, index) {
    if (!adjustmentTypes.includes(row.itemTypeEnumId) || !String(row.reason || "").trim())
        denied("ADJUSTMENT_REASON_REQUIRED", "Choose a discount or write-off and enter a reason")
    const target = byKey[key("invoice", row.invoiceId)],
        amount = lib.amount(row.amount, scope.currencyUomId)
    let glAccountId = row.glAccountId
    // A prompt-payment discount the invoice's due schedule offers on the date posts to the discount account and is issued
    // at once (create#InvoiceCreditMemo promptDiscount); any other discount or write-off names its account, and on a bill
    // its credit is approved, which needs INVOICE_APPROVE.
    // within the terms only on the side's discount account: a discount on another account is a write-off of the bill
    let discountAccount = null
    if (row.itemTypeEnumId === "ItemPromptDiscount")
        try {
            discountAccount = terms().discountAccount(scope.organizationPartyId, scope.direction === "receivable")
        } catch (error) {
            if (!glAccountId) throw error
        }
    const promptDiscount = row.itemTypeEnumId === "ItemPromptDiscount" && (!glAccountId || glAccountId === discountAccount)
    if (promptDiscount) {
        // open on the accounting date and today: a lapsed discount is not taken by dating the settlement back
        const invoice = one(I, {invoiceId: row.invoiceId})
        for (const onDate of [date.timestamp, ec.user.nowTimestamp]) {
            const offered = terms().schedule(invoice, onDate).discountAvailable
            if (offered.isZero() || amount.compare(offered) > 0)
                denied("DISCOUNT_NOT_AVAILABLE", "The invoice's terms offer no discount of this amount on the date and today")
        }
        glAccountId = discountAccount
    } else if (scope.direction === "payable" && !lib.has("INVOICE_APPROVE"))
        denied(
            "ADJUSTMENT_APPROVAL_REQUIRED",
            "A write-off or a discount outside the bill's terms is approved as a credit; ask a user who approves bills"
        )
    if (!glAccountId) denied("ADJUSTMENT_ACCOUNT_REQUIRED", "Choose an explicit adjustment account")
    const account = policy.account(scope.organizationPartyId, glAccountId, date.timestamp)
    return {
        rowSeq: String(index + 1),
        invoiceId: row.invoiceId,
        targetKey: target.sourceKey,
        itemTypeEnumId: row.itemTypeEnumId,
        itemTypeDescription: one("moqui.basic.Enumeration", {enumId: row.itemTypeEnumId})?.description,
        amount: String(amount),
        currencyUomId: scope.currencyUomId,
        glAccountId,
        promptDiscount,
        accountCode: account.row.accountCode,
        accountName: account.row.accountName,
        reason: String(row.reason).trim()
    }
}
// Check a settlement request against current balances and postings, and plan its applications and adjustments.
function normalized(p, lock = false) {
    const scope = context(p, true, lock),
        date = dateInput(p.effectiveDate, p.accountingDate),
        selectionThroughDate = p.asOfDate || ec.user.nowTimestamp,
        selectionThroughDay = p.selectionThroughDay || ec.l10n.format(selectionThroughDate, "yyyy-MM-dd")
    const allocations = Array.from(p.allocations || []),
        adjustments = Array.from(p.adjustments || [])
    if (!allocations.length && !adjustments.length) denied("SETTLEMENT_EMPTY", "Add at least one allocation or adjustment")
    if (allocations.length > 200 || adjustments.length > 50)
        denied("SETTLEMENT_ROW_LIMIT", "Use at most 200 allocations and 50 adjustments")
    const keys = [
        ...new Set([
            ...allocations.flatMap(row => [String(row.sourceKey || ""), String(row.targetKey || "")]),
            ...adjustments.map(row => key("invoice", row.invoiceId))
        ])
    ].sort()
    if (keys.length > 200) denied("SETTLEMENT_SELECTION_LIMIT", "Select at most 200 records")
    const selectedRows = selected(scope, keys, lock),
        byKey = Object.fromEntries(selectedRows.map(row => [row.sourceKey, row]))
    if (keys.some(value => !byKey[value])) denied("SETTLEMENT_RECORD_UNAVAILABLE", "A selected record is unavailable")
    const sourceDay = row => p.sourceDays?.[row.sourceKey] || row.accountingDateText
    for (const row of selectedRows) {
        if (!p.sourceVersions?.[row.sourceKey] || p.sourceVersions[row.sourceKey] !== row.version)
            denied("STALE_PREVIEW", "A selected record changed; review current balances")
        if (row.reasons.length) denied(row.reasons[0], "A selected record is not available for settlement")
        if (sourceDay(row) > selectionThroughDay)
            denied("OUTSIDE_SELECTION_DATE", "A selected record is later than the eligibility date")
        if (date.day < sourceDay(row))
            denied("APPLICATION_BEFORE_SOURCE", "The accounting date cannot precede a selected document")
    }
    const consumption = {},
        take = (k, amount) => {
            consumption[k] = (consumption[k] || toDecimal(0)).add(amount)
        }
    const allocationRows = allocations.map((row, index) => {
        const source = byKey[row.sourceKey],
            target = byKey[row.targetKey],
            amount = lib.amount(row.amount, scope.currencyUomId)
        take(source.sourceKey, amount)
        take(target.sourceKey, amount)
        return {
            rowSeq: String(index + 1),
            sourceKey: source.sourceKey,
            targetKey: target.sourceKey,
            sourceId: source.sourceId,
            targetId: target.sourceId,
            sourceKind: source.sourceKind,
            targetKind: target.sourceKind,
            counterpartyName: source.counterpartyName,
            amount: String(amount),
            currencyUomId: scope.currencyUomId
        }
    })
    const adjustmentRows = adjustments.map((row, index) => {
        const out = adjustmentRow(scope, date, byKey, row, index)
        take(out.targetKey, toDecimal(out.amount))
        return out
    })
    for (const [k, amount] of Object.entries(consumption))
        if (amount.compare(byKey[k].remaining) > 0)
            denied("SETTLEMENT_EXCEEDS_BALANCE", "Combined allocations exceed a selected record's current balance")
    for (const invoiceId of [...new Set(adjustmentRows.map(row => row.invoiceId))]) {
        const existing = rows(I, {creditForInvoiceId: invoiceId}).filter(row => row.statusId !== "InvoiceCancelled")
        const issued = Object.values(lib.totalsMany(existing)).reduce((sum, row) => sum.add(row.invoiceTotal), toDecimal(0))
        const added = adjustmentRows
            .filter(row => row.invoiceId === invoiceId)
            .reduce((sum, row) => sum.add(row.amount), toDecimal(0))
        if (issued.add(added).compare(byKey[key("invoice", invoiceId)].original) > 0)
            denied("CREDIT_EXCEEDS_INVOICE", "Combined linked credits and adjustments exceed the original invoice")
    }
    if (lock) lockPostings(scope, selectedRows)
    const recordByKey = Object.fromEntries(
        selectedRows.map(row => {
            const parsed = parseKey(row.sourceKey)
            return [row.sourceKey, one(parsed.entity, {[parsed.entity === I ? "invoiceId" : "paymentId"]: parsed.id})]
        })
    )
    const postingByKey = Object.fromEntries(
        selectedRows.map(row => [
            row.sourceKey,
            postedEvidence(recordByKey[row.sourceKey], ["invoice", "credit"].includes(row.sourceKind), scope)
        ])
    )
    for (const evidence of Object.values(postingByKey)) {
        const latest = evidence.postingDays
            .map(row => row.day)
            .sort()
            .slice(-1)[0]
        if (date.day < latest)
            denied("APPLICATION_BEFORE_SOURCE_POSTING", "The accounting date cannot precede original posting day " + latest)
    }
    const plans = allocationRows.map(row =>
        allocationPlan(scope, byKey[row.sourceKey], byKey[row.targetKey], row.amount, postingByKey, recordByKey)
    )
    for (const sourceKey of [...new Set(plans.filter(row => row.direct).map(row => row.sourceKey))])
        if (!consumption[sourceKey].eq(byKey[sourceKey].remaining))
            denied(
                "DIRECT_PAYMENT_RESTORE_REQUIRED",
                "Restore the entire currently available direct payment to its original invoice"
            )
    const receivable = scope.direction === "receivable"
    for (const row of adjustmentRows) {
        const control = invoiceAccount(scope, recordByKey[row.targetKey], !receivable)
        proof(postingByKey[row.targetKey], control, receivable ? "D" : "C", byKey[row.targetKey].original)
        // The credit memo posts to its own control account; its application nets that control against the target's.
        const creditControl = invoiceAccount(scope, {invoiceTypeEnumId: "InvoiceCreditMemo"}, receivable)
        plans.push({
            adjustmentRowSeq: row.rowSeq,
            amount: row.amount,
            lines: [
                {glAccountId: row.glAccountId, debitCreditFlag: receivable ? "D" : "C", amount: row.amount},
                {glAccountId: creditControl, debitCreditFlag: receivable ? "C" : "D", amount: row.amount}
            ],
            applicationLines: [
                {glAccountId: creditControl, debitCreditFlag: receivable ? "D" : "C", amount: row.amount},
                {glAccountId: control, debitCreditFlag: receivable ? "C" : "D", amount: row.amount}
            ]
        })
    }
    const allPlans = plans.flatMap(row => (row.applicationLines ? [row, {lines: row.applicationLines}] : [row]))
    const policyEvidence = validatePolicy(scope, date, allPlans, lock)
    const sourceVersions = Object.fromEntries(selectedRows.map(row => [row.sourceKey, row.version]))
    const request = {
        organizationPartyId: scope.organizationPartyId,
        partyId: scope.partyId,
        direction: scope.direction,
        currencyUomId: scope.currencyUomId,
        asOfDate: selectionThroughDate,
        selectionThroughDay,
        sourceDays: Object.fromEntries(selectedRows.map(row => [row.sourceKey, sourceDay(row)])),
        effectiveDate: date.timestamp,
        accountingDate: date.day,
        allocations: allocationRows.map(row => policy.pick(row, ["sourceKey", "targetKey", "amount"])),
        adjustments: adjustmentRows.map(row =>
            policy.pick(row, ["invoiceId", "itemTypeEnumId", "amount", "glAccountId", "reason", "promptDiscount"])
        ),
        sourceVersions
    }
    const beforeBalances = selectedRows.map(row => ({
        sourceKey: row.sourceKey,
        sourceKind: row.sourceKind,
        sourceId: row.sourceId,
        original: String(row.original),
        remaining: String(row.remaining),
        currencyUomId: scope.currencyUomId
    }))
    const afterBalances = beforeBalances.map(row =>
        Object.assign({}, row, {remaining: String(toDecimal(row.remaining).subtract(consumption[row.sourceKey] || 0))})
    )
    const ledgerPreview = scope.capabilities.canReadLedger
        ? allPlans.flatMap((row, index) => row.lines.map(line => Object.assign({rowSeq: String(index + 1)}, line)))
        : adjustmentRows.map(adjustmentLedgerRow)
    return {
        scope,
        request,
        plans,
        policyEvidence,
        payload: {
            organizationPartyId: scope.organizationPartyId,
            partyId: scope.partyId,
            partyName: lib.partyNames([scope.partyId])[scope.partyId],
            direction: scope.direction,
            currencyUomId: scope.currencyUomId,
            balanceBasis: "current",
            selectionThroughDate,
            selectionThroughDateText: selectionThroughDay,
            balanceAsOfDate: ec.user.nowTimestamp,
            effectiveDate: date.timestamp,
            accountingDate: date.day,
            accountingDateText: date.day,
            allocationRows,
            adjustmentRows,
            beforeBalances,
            afterBalances,
            sourceVersions,
            ledgerPreview,
            capabilities: scope.capabilities,
            canApply: true,
            errors: []
        }
    }
}
// The adjustment lines a user without ledger view authority may see.
function adjustmentLedgerRow(row) {
    return policy.pick(row, ["itemTypeEnumId", "glAccountId", "accountCode", "accountName", "amount"])
}
function fingerprint(n) {
    return hash({request: n.request, plans: n.plans, policy: n.policyEvidence})
}
const reviewService = "mantle.account.PaymentServices."
function preview(p) {
    const n = normalized(p),
        inputFingerprint = fingerprint(n),
        kindEnumId = p.sourcePaymentId ? "PrkAutoApply" : "PrkSettlement"
    const stored = call(reviewService + "store#PaymentReview", {
        previewKindEnumId: kindEnumId,
        organizationPartyId: n.scope.organizationPartyId,
        paymentId: p.sourcePaymentId,
        inputFingerprint,
        request: n.request,
        payload: {dto: n.payload, plans: n.plans, policyEvidence: n.policyEvidence}
    })
    // The key that confirms this preview once; a retry with it answers the first result.
    const operationKey = "settle-" + stored.previewId
    call("update#mantle.account.payment.PaymentReview", {previewId: stored.previewId, operationKey})
    return Object.assign({}, n.payload, {
        previewId: stored.previewId,
        inputFingerprint,
        operationKey,
        expiresDate: stored.expiresDate,
        status: "review"
    })
}
// The user's own settlement review (get#PaymentReview) and its scope with the user's current authority.
function retained(p, write = false) {
    const found = call(reviewService + "get#PaymentReview", {
        previewId: p.previewId,
        previewKindEnumIds: ["PrkSettlement", "PrkAutoApply"],
        organizationPartyId: p.organizationPartyId
    })
    return Object.assign(found, {scope: context(found.request, write)})
}
function redacted(result) {
    const clear = row => Object.assign({}, row, {acctgTransIds: []})
    return Object.assign({}, result, {
        acctgTransIds: [],
        allocationResults: Array.from(result.allocationResults || []).map(clear),
        adjustmentResults: Array.from(result.adjustmentResults || []).map(clear)
    })
}
function entrySet(lines) {
    const sums = {}
    for (const line of lines) {
        const k = line.glAccountId + ":" + line.debitCreditFlag
        sums[k] = (sums[k] || toDecimal(0)).add(line.amount || 0)
    }
    return Object.fromEntries(
        Object.keys(sums)
            .sort()
            .map(k => [k, String(sums[k])])
    )
}
// The postings of a confirmed row must be the reviewed accounts and amounts.
function verifyPosting(transactions, expected, org, direct = false) {
    const actual = transactions.filter(
        row => row.organizationPartyId === org && !row.reverseOfAcctgTransId && !row.reversedByAcctgTransId
    )
    if (direct) {
        if (actual.length) denied("POSTING_MISMATCH", "The reviewed direct application produced an unexpected posting")
        return []
    }
    const pref = policy.preference(org)
    if (
        actual.length !== 1 ||
        actual.some(row => row.isPosted !== "Y" || (pref.errorGlJournalId && row.glJournalId === pref.errorGlJournalId))
    )
        denied("SETTLEMENT_NOT_POSTED", "The complete settlement posting could not be verified")
    const entries = Array.from(
        find(E)
            .condition(
                "acctgTransId",
                "in",
                actual.map(row => row.acctgTransId)
            )
            .list()
    )
    const actualSet = entrySet(entries),
        expectedSet = entrySet(expected),
        accountSides = Object.keys(expectedSet)
    if (
        Object.keys(actualSet).length !== accountSides.length ||
        accountSides.some(k => !Object.prototype.hasOwnProperty.call(actualSet, k) || !toDecimal(actualSet[k]).eq(expectedSet[k]))
    )
        denied("POSTING_MISMATCH", "The actual posting differs from the reviewed accounts and amounts")
    return actual.map(row => row.acctgTransId)
}
// One reviewed allocation through Mantle's apply service for its pair, on the reviewed date and book day.
function writeApplication(row, plan, request) {
    const source = parseKey(row.sourceKey),
        target = parseKey(row.targetKey),
        dates = {amount: row.amount, appliedDate: request.effectiveDate, accountingDate: request.accountingDate}
    const made =
        source.kind === "credit"
            ? call(services + "apply#InvoiceToInvoice", Object.assign({invoiceId: source.id, toInvoiceId: target.id}, dates))
            : target.kind === "invoice"
              ? call(services + "apply#InvoicePayment", Object.assign({paymentId: source.id, invoiceId: target.id}, dates))
              : call(services + "apply#PaymentToPayment", Object.assign({paymentId: source.id, toPaymentId: target.id}, dates))
    if (!made.paymentApplicationId || !toDecimal(made.amountApplied ?? 0).eq(row.amount))
        denied("APPLICATION_AMOUNT_MISMATCH", "The actual applied amount differs from the reviewed amount")
    const application = one(A, {paymentApplicationId: made.paymentApplicationId})
    const ids = verifyPosting(
        rows(T, {paymentApplicationId: application.paymentApplicationId}),
        plan.lines,
        request.organizationPartyId,
        plan.direct
    )
    if (plan.direct && application.acctgTransResultEnumId !== "AtrPaymentNotPosted")
        denied("POSTING_MISMATCH", "The direct invoice payment evidence changed")
    if (!plan.direct && application.acctgTransResultEnumId !== "AtrSuccess")
        denied("SETTLEMENT_NOT_POSTED", "The application was not posted successfully")
    return {
        paymentApplicationId: application.paymentApplicationId,
        amountApplied: String(application.amountApplied),
        acctgTransIds: ids,
        sourceKey: row.sourceKey,
        targetKey: row.targetKey,
        reasonCode: plan.direct ? "ALREADY_POSTED_DIRECT" : "OK"
    }
}
// A discount or write-off: a credit memo for the invoice on the chosen account, issued, then applied to the invoice.
function createAdjustment(row, plan, request) {
    const receivable = request.direction === "receivable"
    const made = call("mantle.account.InvoiceServices.create#InvoiceCreditMemo", {
        originalInvoiceId: row.invoiceId,
        organizationPartyId: request.organizationPartyId,
        linkToOriginal: true,
        invoiceDate: request.effectiveDate,
        amount: row.amount,
        itemTypeEnumId: row.itemTypeEnumId,
        overrideGlAccountId: row.glAccountId,
        description: row.reason,
        promptDiscount: !!row.promptDiscount
    })
    if (!row.promptDiscount)
        for (const statusId of receivable ? ["InvoiceFinalized"] : ["InvoiceReceived", "InvoiceApproved"])
            call("update#" + I, {invoiceId: made.invoiceId, statusId, statusId_changeReason: row.reason})
    const invoiceIds = verifyPosting(rows(T, {invoiceId: made.invoiceId}), plan.lines, request.organizationPartyId)
    const application = writeApplication(
        {sourceKey: key("credit", made.invoiceId), targetKey: row.targetKey, amount: row.amount},
        {lines: plan.applicationLines},
        request
    )
    return Object.assign(
        {
            invoiceId: row.invoiceId,
            adjustmentInvoiceId: made.invoiceId,
            itemTypeEnumId: row.itemTypeEnumId,
            glAccountId: row.glAccountId,
            reason: row.reason
        },
        application,
        {acctgTransIds: [...invoiceIds, ...application.acctgTransIds]}
    )
}
// Confirm a retained preview once (claim#PaymentReview): recheck it against current balances, then apply every row and
// adjustment. The organization is locked before the documents and their applications.
function apply(p) {
    const r = retained(p, true)
    const claimed = call(reviewService + "claim#PaymentReview", {
        previewId: p.previewId,
        previewKindEnumIds: ["PrkSettlement", "PrkAutoApply"],
        inputFingerprint: p.inputFingerprint,
        operationKey: p.operationKey
    })
    if (claimed.replay) {
        const old = Object.assign({}, claimed.result, {alreadyApplied: true})
        return r.scope.capabilities.canReadLedger ? old : redacted(old)
    }
    const n = normalized(claimed.request, true)
    if (fingerprint(n) !== claimed.review.inputFingerprint)
        denied("STALE_PREVIEW", "Balances, accounts or posting policy changed; review again")
    const allocationResults = n.payload.allocationRows.map((row, index) =>
        Object.assign({rowSeq: row.rowSeq}, writeApplication(row, n.plans[index], n.request))
    )
    const adjustmentResults = n.payload.adjustmentRows.map((row, index) =>
        Object.assign({rowSeq: row.rowSeq}, createAdjustment(row, n.plans[n.payload.allocationRows.length + index], n.request))
    )
    const remaining = selected(r.scope, Object.keys(n.request.sourceVersions))
    for (const row of remaining) {
        const reviewed = n.payload.afterBalances.find(item => item.sourceKey === row.sourceKey)
        if (!reviewed || !toDecimal(row.remaining).eq(reviewed.remaining))
            denied("SETTLEMENT_BALANCE_MISMATCH", "The actual remaining balance differs from the reviewed result")
    }
    const results = [...allocationResults, ...adjustmentResults]
    const result = {
        settlementId: claimed.operationKey,
        previewId: p.previewId,
        operationKey: claimed.operationKey,
        accountingDate: n.request.accountingDate,
        accountingDateText: n.request.accountingDate,
        applicationIds: results.map(row => row.paymentApplicationId),
        adjustmentInvoiceIds: adjustmentResults.map(row => row.adjustmentInvoiceId),
        acctgTransIds: results.flatMap(row => row.acctgTransIds),
        allocationResults,
        adjustmentResults,
        remainingRows: remaining,
        reasonCode: "OK",
        alreadyApplied: false
    }
    call(reviewService + "complete#PaymentReview", {previewId: p.previewId, operationKey: claimed.operationKey, result})
    return r.scope.capabilities.canReadLedger ? result : redacted(result)
}
function paymentScope(p, write = true) {
    const payment = one(P, {paymentId: p.paymentId})
    if (!payment) denied("PAYMENT_UNAVAILABLE", "Payment is unavailable")
    const org = p.organizationPartyId || workflow.paymentOrganization(payment)
    const direction = workflow.paymentDirection(payment, org)
    const scope = context(
        {
            organizationPartyId: org,
            partyId: payment.fromPartyId === org ? payment.toPartyId : payment.fromPartyId,
            direction,
            currencyUomId: payment.amountUomId
        },
        write
    )
    const available = selected(scope, [key("payment", payment.paymentId)])
    if (available.length !== 1) denied("PAYMENT_UNAVAILABLE", "The payment is not an available settlement source")
    return {scope, payment, row: available[0]}
}
// Plan applying a payment to the counterparty's open invoices, oldest due first, as a retained preview.
function previewAuto(p) {
    const r = paymentScope(p)
    if (!p.sourceVersion || p.sourceVersion !== r.row.version)
        denied("STALE_PREVIEW", "Review the current payment before automatic application")
    let remaining = toDecimal(r.row.remaining),
        offset = 0
    const allocations = [],
        versions = {[r.row.sourceKey]: r.row.version}
    while (remaining.compare(0) > 0) {
        const records = Array.from(
            query(r.scope, "invoice", {asOfDate: ec.user.nowTimestamp})
                .orderBy("dueDate,invoiceDate,invoiceId")
                .offset(offset)
                .limit(100)
                .list()
        )
        if (!records.length) break
        for (const invoice of project(r.scope, "invoice", records)) {
            if (allocations.length >= 199)
                denied("SETTLEMENT_SELECTION_LIMIT", "Automatic application exceeds 200 selected records; select fewer invoices")
            if (invoice.reasons.length) continue
            const amount = remaining.compare(invoice.remaining) < 0 ? remaining : toDecimal(invoice.remaining)
            allocations.push({sourceKey: r.row.sourceKey, targetKey: invoice.sourceKey, amount: String(amount)})
            versions[invoice.sourceKey] = invoice.version
            remaining = remaining.subtract(amount)
            if (remaining.isZero()) break
        }
        offset += records.length
    }
    if (!allocations.length) denied("NO_ELIGIBLE_INVOICES", "No open invoice is eligible for this payment")
    return preview(
        Object.assign({}, r.scope, {
            effectiveDate: p.effectiveDate,
            sourceVersions: versions,
            allocations,
            sourcePaymentId: p.paymentId
        })
    )
}
// Confirm a reviewed automatic application. Without a preview nothing is applied, as in Mantle's original stub.
function autoApply(p) {
    if (!p.previewId) return {invoiceIdList: [], reasonCode: "SETTLEMENT_PREVIEW_REQUIRED", alreadyApplied: false}
    const r = paymentScope(p)
    if (!p.inputFingerprint) denied("SETTLEMENT_PREVIEW_REQUIRED", "Review automatic application before confirming")
    const reviewed = retained(p, true)
    if (
        reviewed.review.previewKindEnumId !== "PrkAutoApply" ||
        reviewed.review.paymentId !== p.paymentId ||
        reviewed.review.organizationPartyId !== r.scope.organizationPartyId
    )
        denied("SETTLEMENT_PREVIEW_MISMATCH", "The reviewed automatic application belongs to another payment")
    const result = apply(p)
    return Object.assign(result, {
        invoiceIdList: [
            ...new Set(reviewed.payload.dto.allocationRows.filter(row => row.targetKind === "invoice").map(row => row.targetId))
        ]
    })
}
// The settlement scope and capabilities of the current user, for the XML Actions reads.
function scope(p) {
    return context(p, !!p.write, false, p.requireParty !== false)
}
// ---- The rules of every application write, run by apply#InvoicePayment, apply#PaymentToPayment, apply#InvoiceToInvoice
// and unapply#PaymentApplication.

// Lock the internal organizations, then the invoices, then the payments, each in id order: the order settlement uses.
function lockApplication(p) {
    const invoiceIds = [...new Set(Array.from(p.invoiceIds || []).filter(Boolean))].sort(),
        paymentIds = [...new Set(Array.from(p.paymentIds || []).filter(Boolean))].sort()
    const documents = [
        ...(invoiceIds.length ? Array.from(find(I).condition("invoiceId", "in", invoiceIds).list()) : []),
        ...(paymentIds.length ? Array.from(find(P).condition("paymentId", "in", paymentIds).list()) : [])
    ]
    const parties = [...new Set(documents.flatMap(row => [row.fromPartyId, row.toPartyId]).filter(Boolean))]
    const orgs = parties.length
        ? Array.from(find("mantle.party.PartyRole", {roleTypeId: "OrgInternal"}).condition("partyId", "in", parties).list())
              .map(row => row.partyId)
              .sort()
        : []
    if (orgs.length)
        Array.from(find("mantle.party.Party").condition("partyId", "in", orgs).orderBy("partyId").forNoKeyUpdate(true).list())
    if (invoiceIds.length)
        Array.from(find(I).condition("invoiceId", "in", invoiceIds).orderBy("invoiceId").forUpdate(true).list())
    if (paymentIds.length)
        Array.from(find(P).condition("paymentId", "in", paymentIds).orderBy("paymentId").forUpdate(true).list())
}
// The latest posting day of the documents an application consumes.
function latestPostingDay(invoices, payments) {
    const days = [
        ...invoices.flatMap(row => activeTransactions("invoiceId", row.invoiceId)),
        ...payments.flatMap(row => activeTransactions("paymentId", row.paymentId))
    ].map(tx => policy.postingDay(tx))
    return days.sort().slice(-1)[0] || null
}
function checkApplication(p) {
    const amount = toDecimal(p.amount ?? 0)
    if (amount.compare(0) <= 0) return
    const invoices = [p.invoiceId, p.toInvoiceId].filter(Boolean).map(invoiceId => one(I, {invoiceId}))
    const payments = [p.paymentId, p.toPaymentId].filter(Boolean).map(paymentId => one(P, {paymentId}))
    const currency = invoices[0]?.currencyUomId || payments[0]?.amountUomId
    if (currency && !ec.l10n.roundCurrency(amount, currency).eq(amount))
        denied("APPLICATION_AMOUNT_PRECISION", "Application amount must use its currency's precision")
    if (payments.some(row => row.paymentTypeEnumId === "PtInternalTransfer"))
        denied("TRANSFER_APPLICATION_REFUSED", "Internal transfers cannot fund trade applications or refunds")
    // the hold guard: nothing is applied to a bill on hold
    for (const invoice of invoices) lib.requireNotHeld(invoice.invoiceId)
    // The book day: as reviewed, else the day the posting would take from its source, else the applied date's day.
    const bookDay = p.accountingDate
        ? policy.calendarDateText(p.accountingDate)
        : guard.calendarDay({transactionDate: p.appliedDate}, {paymentId: map(payments[0]), invoiceId: map(invoices[0])}, true) ||
          policy.bookDay(null, p.appliedDate)
    if ([...invoices, ...payments].some(row => row.accountingDate && policy.calendarDateText(row.accountingDate) > bookDay))
        denied("APPLICATION_DATE_INVALID", "The application date cannot precede its financial records")
    const latest = latestPostingDay(invoices, payments)
    if (latest && latest > bookDay)
        denied("APPLICATION_BEFORE_SOURCE_POSTING", "The application date cannot precede a document's posting day " + latest)
}
// An application that funds a completed refund stays applied: a delivered or confirmed refund applied to the payment it
// refunds. Voiding the refund first (PaymentCancelledCleanup) unapplies it.
function checkUnapply(p) {
    const row = p.paymentApplication
    if (!row?.paymentId || !row.toPaymentId || toDecimal(row.amountApplied ?? 0).compare(0) <= 0) return
    const refund = one(P, {paymentId: row.paymentId})
    if (refund?.refundForPaymentId === row.toPaymentId && ["PmntDelivered", "PmntConfirmed"].includes(refund.statusId))
        denied("REFUND_FUNDING_IMMUTABLE", "A completed refund keeps its application to the payment it refunds")
}

const operations = {
    preview,
    apply,
    previewAuto,
    autoApply,
    scope,
    lockApplication,
    checkApplication,
    checkUnapply
}
// Runs one settlement operation for its service and puts its results, if any, in the service's context.
function execute(op, parameters) {
    if (!operations[op]) throw new Error("Unknown settlement operation " + op)
    const result = operations[op](parameters)
    if (result) ec.context.putAll(result)
    return result
}
// dateInput and validatePolicy are shared with the payment lifecycle, refund and gateway reviews.
;({execute, normalized, dateInput, validatePolicy})
