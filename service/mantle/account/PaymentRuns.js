// Supplier payment runs (mantle.account.PaymentRunServices): a run selects an organization's due approved bills, is
// approved as a whole, then pays each supplier in its own transaction with one payment, and writes the bank file of its
// payments through Mantle's NACHA and Positive Pay services. Holds, balances, bank details and the approved selection
// are read again under lock when a supplier is paid.
const lib = ec.resource.script("component://mr-mantle/service/mantle/account/InvoiceWorkflowLib.js")
const {find, one, rows, call, probe, denied, has} = lib
const terms = ec.resource.script("component://mr-mantle/service/mantle/account/PaymentTerms.js")
const I = lib.invoiceEntity,
    R = "mantle.account.payment.PaymentRun",
    RI = "mantle.account.payment.PaymentRunItem",
    P = "mantle.account.payment.Payment",
    M = "mantle.account.method.PaymentMethod",
    services = "mantle.account.PaymentRunServices."
const instruments = ["PiAch", "PiCompanyCheck"]
const openRunStatuses = ["PrunDraft", "PrunApproved"]
const maxBills = 500

// ---- Scope and values

const dayText = value => (value == null || value === "" ? null : lib.policy.calendarDateText(value))
const startOf = day => ec.l10n.parseTimestamp(day + " 00:00:00", "yyyy-MM-dd HH:mm:ss")
const today = () => ec.l10n.format(ec.user.nowTimestamp, "yyyy-MM-dd")
function readable() {
    if (!["PAYABLE_VIEW", "PAYMENT_VIEW", "ACCOUNTING_VIEW", "ACCOUNTING_ADMIN"].some(has) && !lib.access.systemAdmin())
        denied("PERMISSION_DENIED", "Payables or payment view authority is required")
}
// A run of an organization the user works in, with the permission given (none: a read); locked when asked. The
// organization itself is never locked here: the payments a run makes lock it in their own transactions.
function runScope(p, permission = null, lock = false) {
    let run = one(R, {paymentRunId: p.paymentRunId})
    if (!run) denied("RUN_UNAVAILABLE", "The payment run is not available")
    if (!permission) readable()
    lib.organization(run.organizationPartyId, permission)
    if (p.organizationPartyId && p.organizationPartyId !== run.organizationPartyId)
        denied("ORGANIZATION_DENIED", "The payment run belongs to another organization")
    if (lock) run = find(R, {paymentRunId: p.paymentRunId}).forUpdate(true).one()
    return run
}
// The organization's bank account a run pays from: its own, current and a bank account; for ACH with what a NACHA file
// needs (generate#NachaFile's file and batch header fields), so a run never pays into a file that cannot be written.
function bankMethod(organizationPartyId, paymentMethodId, ach = false) {
    const method = paymentMethodId && one(M, {paymentMethodId})
    if (!method || method.ownerPartyId !== organizationPartyId || !lib.policy.lib.active(method))
        denied("BANK_ACCOUNT_INVALID", "Choose a current bank account of the organization")
    const bank = one("mantle.account.method.BankAccount", {paymentMethodId})
    if (!bank) denied("BANK_ACCOUNT_INVALID", "Choose a current bank account of the organization")
    if (ach) {
        const missing = [
            ["nachaImmedDest", "immediate destination"],
            ["nachaImmedOrig", "immediate origin"],
            ["nachaCompanyId", "company ID"],
            ["nachaEntryDescription", "entry description"]
        ]
            .filter(([field]) => !bank[field])
            .map(([, label]) => label)
        if (!bank.nachaImmedDestName && !bank.bankName) missing.push("bank name")
        if (!bank.nachaCompanyName && !method.companyNameOnAccount) missing.push("company name")
        if (missing.length)
            denied("BANK_ACCOUNT_NACHA_MISSING", "The bank account is not set up for ACH files: " + missing.join(", "))
    }
    return method
}
// A supplier's current bank account (the newest), or null.
function supplierBank(supplierPartyId) {
    const methods = rows(M, {ownerPartyId: supplierPartyId, paymentMethodTypeEnumId: "PmtBankAccount"})
        .filter(row => lib.policy.lib.active(row))
        .sort((a, b) => Number(b.fromDate || 0) - Number(a.fromDate || 0))
    return methods.find(row => one("mantle.account.method.BankAccount", {paymentMethodId: row.paymentMethodId})) || null
}
function currentBank(item) {
    const method = item.toPaymentMethodId && one(M, {paymentMethodId: item.toPaymentMethodId})
    return !!method && method.ownerPartyId === item.supplierPartyId && lib.policy.lib.active(method)
}
const items = (paymentRunId, conditions = {}) =>
    Array.from(find(RI, Object.assign({paymentRunId}, conditions)).orderBy("paymentRunItemSeqId").list())
const selectedItems = paymentRunId => items(paymentRunId, {selectedIndicator: "Y"})
// What approval freezes: the bank, pay date and instrument, and each selected bill's amounts and supplier account.
function version(run) {
    return lib.hash({
        paymentMethodId: run.paymentMethodId,
        paymentInstrumentEnumId: run.paymentInstrumentEnumId,
        currencyUomId: run.currencyUomId,
        payDate: dayText(run.payDate),
        items: selectedItems(run.paymentRunId).map(row => [
            row.invoiceId,
            row.supplierPartyId,
            row.toPaymentMethodId || null,
            String(row.paymentAmount),
            String(row.discountAmount || 0)
        ])
    })
}
const total = list => list.reduce((sum, row) => sum.add(row.paymentAmount || 0), toDecimal(0))
// An approved run whose selection changes goes back to proposed, its approval voided with the reason.
function voidApproval(run, reason) {
    if (run.statusId !== "PrunApproved") return false
    call("update#" + R, {
        paymentRunId: run.paymentRunId,
        statusId: "PrunDraft",
        approvalVoidedDate: ec.user.nowTimestamp,
        approvalVoidReason: reason,
        statusId_changeReason: reason
    })
    return true
}
function editable(run) {
    if (!openRunStatuses.includes(run.statusId) || run.executeOperationKey)
        denied("RUN_CLOSED", "The payment run is executed or cancelled")
}

// ---- Create and select

function create(p) {
    const organizationPartyId = lib.organization(p.organizationPartyId, "PAYABLE_EDIT")
    if (!instruments.includes(p.paymentInstrumentEnumId)) denied("INSTRUMENT_INVALID", "Pay by ACH or by check")
    bankMethod(organizationPartyId, p.paymentMethodId, p.paymentInstrumentEnumId === "PiAch")
    const dueThroughDate = dayText(p.dueThroughDate),
        payDate = dayText(p.payDate)
    if (!dueThroughDate || !payDate) denied("RUN_DATES_REQUIRED", "Give the due-through date and the pay date")
    if (payDate < today()) denied("PAY_DATE_PAST", "The pay date is today or later")
    const baseCurrency = lib.policy.preference(organizationPartyId).baseCurrencyUomId
    if (p.currencyUomId && p.currencyUomId !== baseCurrency)
        denied("CURRENCY_MISMATCH", "A payment run pays in the organization's base currency")
    const made = call("create#" + R, {
        organizationPartyId,
        paymentMethodId: p.paymentMethodId,
        paymentInstrumentEnumId: p.paymentInstrumentEnumId,
        currencyUomId: baseCurrency,
        dueThroughDate,
        payDate,
        description: p.description || null,
        statusId: "PrunDraft",
        createdByUserId: ec.user.userId,
        createdDate: ec.user.nowTimestamp
    })
    return Object.assign({paymentRunId: made.paymentRunId}, select({paymentRunId: made.paymentRunId}))
}
// The organization's approved bills open in the run's currency that are due through its date, or whose discount is open
// on the pay date; each is selected or left out with its reason. A bill the user left out stays left out.
function select(p) {
    const run = runScope(p, "PAYABLE_EDIT", true)
    editable(run)
    voidApproval(run, "The selection changed")
    const org = run.organizationPartyId,
        payDay = dayText(run.payDate),
        dueThrough = dayText(run.dueThroughDate),
        ach = run.paymentInstrumentEnumId === "PiAch"
    const bills = Array.from(
        find(I, {toPartyId: org, statusId: "InvoiceApproved", currencyUomId: run.currencyUomId})
            .condition("invoiceTypeEnumId", "not-equals", "InvoiceCreditMemo")
            .condition("unpaidTotal", "greater", 0)
            .orderBy("dueDate,invoiceId")
            .limit(maxBills + 1)
            .list()
    )
    // more than the cap: the first by due date are selected and the run says that more are due
    const truncated = bills.length > maxBills
    if (truncated) bills.length = maxBills
    const parties = Object.fromEntries(
        bills.length
            ? Array.from(
                  find("mantle.party.Party")
                      .condition("partyId", "in", [...new Set(bills.map(row => row.fromPartyId))])
                      .list()
              ).map(row => [row.partyId, row])
            : []
    )
    const visible = bills.filter(row => {
        const owner = parties[row.fromPartyId]?.privateOwnerUserId
        return row.fromPartyId !== org && (!owner || owner === ec.user.userId)
    })
    const payTime = startOf(payDay)
    const dueSchedules = terms.schedules(visible, payTime)
    const due = visible.filter(row => {
        const dueDay = terms.stampDay(row.dueDate)
        return !dueDay || dueDay <= dueThrough || dueSchedules[row.invoiceId].discountAvailable.compare(0) > 0
    })
    const ids = due.map(row => row.invoiceId)
    const holds = lib.openHolds(ids)
    const holdReasons = Object.fromEntries(
        rows("moqui.basic.Enumeration", {enumTypeId: "InvoiceHoldReason"}).map(row => [row.enumId, row.description])
    )
    const otherRuns = otherRunHolds(run.paymentRunId, ids)
    const userExcluded = Object.fromEntries(
        items(run.paymentRunId, {excludeReasonEnumId: "PrxUser"}).map(row => [row.invoiceId, row.excludeComment || ""])
    )
    for (const row of items(run.paymentRunId))
        call("delete#" + RI, {paymentRunId: row.paymentRunId, paymentRunItemSeqId: row.paymentRunItemSeqId})
    const banks = {}
    let selectedCount = 0,
        selectedTotal = toDecimal(0)
    due.forEach((bill, index) => {
        const schedule = dueSchedules[bill.invoiceId],
            unpaid = lib.totals(bill).unpaidTotal,
            discount = schedule.discountAvailable
        if (!(bill.fromPartyId in banks)) banks[bill.fromPartyId] = supplierBank(bill.fromPartyId)
        const bank = banks[bill.fromPartyId]
        let excludeReasonEnumId = null,
            excludeComment = null
        if (holds[bill.invoiceId]) {
            excludeReasonEnumId = "PrxHeld"
            excludeComment = holds[bill.invoiceId]
                .map(row => holdReasons[row.holdReasonEnumId] || row.holdReasonEnumId)
                .join(", ")
        } else if (otherRuns[bill.invoiceId]) {
            excludeReasonEnumId = "PrxInOtherRun"
            excludeComment = otherRuns[bill.invoiceId]
        } else if (ach && !bank) {
            excludeReasonEnumId = "PrxNoBankAccount"
        } else if (bill.invoiceId in userExcluded) {
            excludeReasonEnumId = "PrxUser"
            excludeComment = userExcluded[bill.invoiceId] || null
        }
        const paymentAmount = unpaid.subtract(discount)
        if (!excludeReasonEnumId) {
            selectedCount++
            selectedTotal = selectedTotal.add(paymentAmount)
        }
        call("create#" + RI, {
            paymentRunId: run.paymentRunId,
            paymentRunItemSeqId: String(index + 1).padStart(3, "0"),
            invoiceId: bill.invoiceId,
            supplierPartyId: bill.fromPartyId,
            toPaymentMethodId: ach && bank ? bank.paymentMethodId : null,
            dueDate: terms.stampDay(bill.dueDate),
            discountDate: discount.compare(0) > 0 ? schedule.discountDate : null,
            unpaidAmount: unpaid,
            discountAmount: discount,
            paymentAmount,
            selectedIndicator: excludeReasonEnumId ? "N" : "Y",
            excludeReasonEnumId,
            excludeComment
        })
    })
    return {itemCount: due.length, selectedCount, excludedCount: due.length - selectedCount, selectedTotal, truncated}
}
// The bills another run holds, by invoice ID with the reason: selected in another open run and not paid there (a supplier
// that failed in an unfinished run releases its bills), or paid by another run's payment not yet applied and not
// declined, voided or cancelled. With paymentsOnly, the payments only.
function otherRunHolds(paymentRunId, ids, paymentsOnly = false) {
    const holds = {}
    if (!ids.length) return holds
    if (!paymentsOnly)
        for (const row of Array.from(
            find(RI, {selectedIndicator: "Y"})
                .condition("invoiceId", "in", ids)
                .condition("paymentRunId", "not-equals", paymentRunId)
                .condition("paymentId", "is-null", null)
                .list()
        ))
            if (row.resultEnumId !== "PrrFailed" && openRunStatuses.includes(one(R, {paymentRunId: row.paymentRunId})?.statusId))
                holds[row.invoiceId] = "Run " + row.paymentRunId
    for (const row of Array.from(
        find(RI)
            .condition("invoiceId", "in", ids)
            .condition("paymentRunId", "not-equals", paymentRunId)
            .condition("paymentId", "is-not-null", null)
            .condition("resultEnumId", "not-in", ["PrrPaid", "PrrReturned"])
            .list()
    ))
        if (!["PmntDeclined", "PmntVoid", "PmntCancelled"].includes(one(P, {paymentId: row.paymentId})?.statusId))
            holds[row.invoiceId] = "Payment " + row.paymentId + " of run " + row.paymentRunId + " is not applied yet"
    return holds
}
// Put a bill in the run or leave it out. A held bill, one in another open run or one without the supplier's bank account
// for ACH is not put in.
function storeItem(p) {
    const run = runScope(p, "PAYABLE_EDIT", true)
    editable(run)
    const item = one(RI, {paymentRunId: run.paymentRunId, paymentRunItemSeqId: p.paymentRunItemSeqId})
    if (!item) denied("RUN_ITEM_UNAVAILABLE", "The bill is not in this run")
    const include = p.selectedIndicator === "Y"
    if (include) {
        if (["PrxHeld", "PrxInOtherRun", "PrxNoBankAccount"].includes(item.excludeReasonEnumId))
            denied("RUN_ITEM_EXCLUDED", "This bill cannot be paid in the run: refresh the selection")
        lib.requireNotHeld(item.invoiceId)
        // another run took the bill since it was left out of this one
        const held = otherRunHolds(run.paymentRunId, [item.invoiceId])[item.invoiceId]
        if (held) denied("RUN_ITEM_IN_OTHER_RUN", "Bill " + item.invoiceId + " is held by another run: " + held)
    }
    if ((item.selectedIndicator === "Y") === include) return {changed: false}
    voidApproval(run, "The selection changed")
    call("update#" + RI, {
        paymentRunId: item.paymentRunId,
        paymentRunItemSeqId: item.paymentRunItemSeqId,
        selectedIndicator: include ? "Y" : "N",
        excludeReasonEnumId: include ? null : "PrxUser",
        excludeComment: include ? null : p.excludeComment || null,
        selectedIndicator_changeReason: p.excludeComment || null
    })
    return {changed: true}
}

// ---- Approval

function requestApproval(p) {
    const run = runScope(p, "PAYABLE_EDIT")
    if (run.statusId !== "PrunDraft") denied("STATE_TRANSITION_INVALID", "Only a proposed run is sent for approval")
    const selected = selectedItems(run.paymentRunId)
    if (!selected.length) denied("RUN_EMPTY", "Select at least one bill")
    return ec.resource.script("component://mr-mantle/service/mantle/account/Payables.js").execute("notify", {
        topic: "PaymentRunApproval",
        permission: "PAYMENT_RUN_APPROVE",
        organizationPartyId: run.organizationPartyId,
        recordEntityName: R,
        recordId: run.paymentRunId,
        message: {
            paymentRunId: run.paymentRunId,
            organizationPartyId: run.organizationPartyId,
            amount: String(total(selected)),
            currencyUomId: run.currencyUomId
        }
    })
}
// Approve the run as it is: its total and the version of its selection, which execution checks. The run's creator
// approves it only when the organization allows self-approval.
function approve(p) {
    const run = runScope(p, "PAYMENT_RUN_APPROVE", true)
    lib.policy.revision(run, p.lastUpdatedStamp)
    if (run.statusId !== "PrunDraft") denied("STATE_TRANSITION_INVALID", "Only a proposed run is approved")
    const selected = selectedItems(run.paymentRunId)
    if (!selected.length) denied("RUN_EMPTY", "Select at least one bill")
    for (const item of selected) lib.requireNotHeld(item.invoiceId)
    const selfApproved = run.createdByUserId === ec.user.userId
    if (selfApproved && lib.policy.preference(run.organizationPartyId).allowAccountingSelfApproval !== "Y")
        denied("SELF_APPROVAL_DENIED", "Another finance approver must approve this payment run")
    const approvedTotal = total(selected)
    call("update#" + R, {
        paymentRunId: run.paymentRunId,
        statusId: "PrunApproved",
        approvedByUserId: ec.user.userId,
        approvedDate: ec.user.nowTimestamp,
        approvedTotal,
        approvedVersion: version(run),
        isSelfApproved: selfApproved ? "Y" : "N",
        approvalVoidedDate: null,
        approvalVoidReason: null
    })
    ec.resource.script("component://mr-mantle/service/mantle/account/Payables.js").execute("clearNotices", {
        topic: "PaymentRunApproval",
        recordEntityName: R,
        recordId: run.paymentRunId
    })
    return {statusId: "PrunApproved", approvedTotal, isSelfApproved: selfApproved ? "Y" : "N"}
}
// A supplier's bank details changed (the update#BankAccount SECA): every open run that pays the supplier takes the
// supplier's current bank account, and an approved one goes back to proposed with the reason (D26). Mantle moves a
// changed outside party's bank account to a new payment method, so the change is found by the supplier.
function voidRunApproval(p) {
    const method = p.paymentMethodId && one(M, {paymentMethodId: p.paymentMethodId})
    const supplierPartyId = p.supplierPartyId || method?.ownerPartyId
    if (!supplierPartyId || one("mantle.party.PartyRole", {partyId: supplierPartyId, roleTypeId: "OrgInternal"}))
        return {voidedRunIds: []}
    // the supplier's bills in open runs that are not executing
    const pending = Array.from(find(RI, {supplierPartyId}).condition("paymentId", "is-null", null).list()).filter(row => {
        const run = one(R, {paymentRunId: row.paymentRunId})
        return run && openRunStatuses.includes(run.statusId) && !run.executeOperationKey
    })
    // a change: the method given was ended, or an ACH run pays the supplier into an account that is no longer its current
    // one (ended, or a newer one added: Mantle's copy of a changed account is a new method); an update that changed
    // nothing voids nothing. A check run does not pay into a bank account.
    const now = lib.ms(ec.user.nowTimestamp)
    const newest = supplierBank(supplierPartyId)?.paymentMethodId || null
    const changed =
        (method?.thruDate && lib.ms(method.thruDate) <= now) ||
        pending.some(row => row.toPaymentMethodId && (!currentBank(row) || row.toPaymentMethodId !== newest))
    if (!changed) return {voidedRunIds: []}
    const runIds = [...new Set(pending.map(row => row.paymentRunId))].sort()
    const voidedRunIds = [],
        bank = supplierBank(supplierPartyId),
        name = lib.partyNames([supplierPartyId])[supplierPartyId] || supplierPartyId
    for (const paymentRunId of runIds) {
        const run = find(R, {paymentRunId}).forUpdate(true).one()
        if (!run || !openRunStatuses.includes(run.statusId) || run.executeOperationKey) continue
        if (voidApproval(run, "Bank details of " + name + " changed")) voidedRunIds.push(paymentRunId)
        if (run.paymentInstrumentEnumId === "PiAch")
            for (const item of pending.filter(row => row.paymentRunId === paymentRunId))
                call("update#" + RI, {
                    paymentRunId,
                    paymentRunItemSeqId: item.paymentRunItemSeqId,
                    toPaymentMethodId: bank?.paymentMethodId || null
                })
    }
    return {voidedRunIds}
}

// ---- Execution

function failMessage(error) {
    const code = lib.entityLib.reasonCode(error)
    const text = String(error?.message || error).split("\n")[0]
    return (code && !text.startsWith(code) ? code + ": " : "") + text.slice(0, 250)
}
// Execute an approved run under its operation key. A completed execution under the key is answered first from its
// operation record (PostingOperation, CX-POSTING); the run's claim (executeOperationKey) keeps one key on a run while it
// executes. Each supplier is paid in its own transaction (a failure is recorded on that supplier's bills and the others go
// on), the bank file is written and the ACH payments it delivered are applied. The run is executed only when every
// payment made is applied; otherwise it stays approved with the reason, and the same key resumes it where it stopped. A
// supplier already paid is never paid again. A pay date in the past is refused before anything is paid.
function execute(p) {
    const operationKey = String(p.operationKey || "")
    if (!operationKey || operationKey.length > 40)
        denied("OPERATION_KEY_REQUIRED", "An operation key of at most 40 characters is required")
    let run = runScope(p, "PAYMENT_EDIT")
    // EntityLib's operation: InvoiceWorkflowLib's locks the organization, which the payments lock in their own transactions
    const op = lib.entityLib.operation({operationKey}, "PaymentRunExecute", run.organizationPartyId, {
        paymentRunId: run.paymentRunId
    })
    if (lib.previous(op)) return Object.assign(result(run), {alreadyExecuted: true, complete: true})
    if (run.executeOperationKey && run.executeOperationKey !== operationKey)
        denied("RUN_EXECUTED", "The payment run is being or was executed")
    const late = dayText(run.payDate) < today()
    if (late && !run.executeOperationKey)
        denied("PAY_DATE_PAST", "The pay date has passed; refresh the selection with a new pay date")
    probe(services + "claim#RunExecution", {
        paymentRunId: run.paymentRunId,
        operationKey,
        lastUpdatedStamp: p.lastUpdatedStamp
    })
    const unpaid = () => selectedItems(run.paymentRunId).filter(row => !row.paymentId)
    const fail = (supplierPartyId, message) => {
        for (const item of unpaid().filter(row => row.supplierPartyId === supplierPartyId))
            probe("update#" + RI, {
                paymentRunId: item.paymentRunId,
                paymentRunItemSeqId: item.paymentRunItemSeqId,
                resultEnumId: "PrrFailed",
                resultMessage: message
            })
    }
    for (const supplierPartyId of [...new Set(unpaid().map(row => row.supplierPartyId))].sort()) {
        // resumed after its pay date: no new payment is made, so no discount is taken after its date
        if (late) {
            fail(supplierPartyId, "PAY_DATE_PAST: The pay date passed before this supplier was paid")
            continue
        }
        try {
            probe(services + "pay#RunSupplier", {paymentRunId: run.paymentRunId, supplierPartyId})
        } catch (error) {
            const message = failMessage(error)
            ec.logger.error("Payment run " + run.paymentRunId + " supplier " + supplierPartyId + ": " + message)
            fail(supplierPartyId, message)
        }
    }
    let fileError = null
    try {
        probe(services + "generate#RunFile", {paymentRunId: run.paymentRunId})
    } catch (error) {
        fileError = failMessage(error)
        ec.logger.error("Payment run " + run.paymentRunId + " bank file: " + fileError)
    }
    run = find(R, {paymentRunId: run.paymentRunId}).forUpdate(true).one()
    if (run.statusId === "PrunExecuted") return Object.assign(result(run), {alreadyExecuted: true, complete: true})
    const waiting = selectedItems(run.paymentRunId).filter(row => row.paymentId && row.resultEnumId === "PrrSent")
    if (fileError || waiting.length) {
        const executionMessage = fileError
            ? "The bank file was not written: " + fileError
            : waiting.length +
              " bills are paid and not yet applied" +
              (waiting[0].resultMessage ? ": " + waiting[0].resultMessage : "")
        call("update#" + R, {paymentRunId: run.paymentRunId, executionMessage: executionMessage.slice(0, 255)})
        return Object.assign(result(one(R, {paymentRunId: run.paymentRunId})), {alreadyExecuted: false, complete: false})
    }
    call("update#" + R, {
        paymentRunId: run.paymentRunId,
        statusId: "PrunExecuted",
        executedByUserId: ec.user.userId,
        executedDate: ec.user.nowTimestamp,
        executionMessage: null
    })
    const out = result(one(R, {paymentRunId: run.paymentRunId}))
    lib.complete(op, R, run.paymentRunId, out)
    return Object.assign(out, {alreadyExecuted: false, complete: true})
}
// Claim an approved run for execution, in its own transaction: the approved selection must be the run's now.
function claim(p) {
    const run = runScope(p, "PAYMENT_EDIT", true)
    if (run.executeOperationKey === p.operationKey && run.statusId === "PrunApproved") return {}
    if (run.statusId !== "PrunApproved" || run.executeOperationKey) denied("RUN_NOT_APPROVED", "Only an approved run is executed")
    if (p.lastUpdatedStamp != null && p.lastUpdatedStamp !== "") lib.policy.revision(run, p.lastUpdatedStamp)
    if (version(run) !== run.approvedVersion) denied("RUN_CHANGED", "The run changed after its approval; approve it again")
    call("update#" + R, {paymentRunId: run.paymentRunId, executeOperationKey: p.operationKey})
    return {}
}
function result(run) {
    const list = items(run.paymentRunId, {selectedIndicator: "Y"})
    const count = enumId => list.filter(row => row.resultEnumId === enumId).length
    return {
        statusId: run.statusId,
        paymentIdList: [...new Set(list.map(row => row.paymentId).filter(Boolean))],
        paidCount: count("PrrPaid"),
        sentCount: count("PrrSent"),
        failedCount: count("PrrFailed"),
        waitingCount: count("PrrSent"),
        paymentMethodFileId: run.paymentMethodFileId || null,
        executionMessage: run.executionMessage || null
    }
}
// Pay one supplier's selected bills of an executing run with one payment, in the caller's (new) transaction: the bills
// locked and their holds, status, balances, discounts and the supplier's bank account read again. A check is numbered,
// delivered and applied now; an ACH payment is authorized for the bank file and applied when the file delivers it.
function paySupplier(p) {
    // the run is locked first: a concurrent execution under the same key waits here, then finds the supplier paid
    const run = runScope(p, "PAYMENT_EDIT", true)
    if (run.statusId !== "PrunApproved" || !run.executeOperationKey)
        denied("RUN_NOT_EXECUTING", "The payment run is not being executed")
    const list = selectedItems(run.paymentRunId).filter(row => row.supplierPartyId === p.supplierPartyId && !row.paymentId)
    if (!list.length) return {}
    const ach = run.paymentInstrumentEnumId === "PiAch",
        payTime = startOf(dayText(run.payDate))
    bankMethod(run.organizationPartyId, run.paymentMethodId, ach)
    const bills = Object.fromEntries(
        Array.from(
            find(I)
                .condition(
                    "invoiceId",
                    "in",
                    list.map(row => row.invoiceId)
                )
                .orderBy("invoiceId")
                .forUpdate(true)
                .list()
        ).map(row => [row.invoiceId, row])
    )
    const elsewhere = otherRunHolds(run.paymentRunId, Object.keys(bills), true)
    for (const item of list) {
        const bill = bills[item.invoiceId]
        lib.requireNotHeld(item.invoiceId)
        if (elsewhere[item.invoiceId])
            denied("RUN_ITEM_IN_OTHER_RUN", "Bill " + item.invoiceId + ": " + elsewhere[item.invoiceId])
        if (!bill || bill.statusId !== "InvoiceApproved")
            denied("BILL_STATE_CHANGED", "Bill " + item.invoiceId + " is no longer approved")
        if (!lib.totals(bill).unpaidTotal.eq(item.unpaidAmount))
            denied("BALANCE_CHANGED", "The open amount of bill " + item.invoiceId + " changed")
        if (
            toDecimal(item.discountAmount || 0).compare(0) > 0 &&
            terms.schedule(bill, payTime).discountAvailable.compare(item.discountAmount) < 0
        )
            denied("DISCOUNT_NOT_AVAILABLE", "The discount on bill " + item.invoiceId + " is no longer available")
        if (ach && !currentBank(item)) denied("BANK_DETAILS_CHANGED", "The supplier's bank details changed; refresh the run")
    }
    const amount = total(list)
    const payment = call("mantle.account.PaymentServices.create#Payment", {
        paymentTypeEnumId: "PtInvoicePayment",
        fromPartyId: run.organizationPartyId,
        toPartyId: p.supplierPartyId,
        amount,
        amountUomId: run.currencyUomId,
        paymentMethodId: run.paymentMethodId,
        toPaymentMethodId: ach ? list[0].toPaymentMethodId : null,
        paymentInstrumentEnumId: run.paymentInstrumentEnumId,
        effectiveDate: payTime,
        statusId: ach ? "PmntAuthorized" : "PmntPromised",
        comments: "Payment run " + run.paymentRunId
    })
    for (const item of list)
        call("update#" + RI, {
            paymentRunId: item.paymentRunId,
            paymentRunItemSeqId: item.paymentRunItemSeqId,
            paymentId: payment.paymentId,
            resultEnumId: "PrrSent",
            resultMessage: null
        })
    if (!ach) {
        call("mantle.account.PaymentServices.assign#BankAccountCheckNumber", {paymentId: payment.paymentId})
        call("update#" + P, {paymentId: payment.paymentId, statusId: "PmntDelivered"})
        applyItems(run, payment.paymentId)
    }
    return {paymentId: payment.paymentId}
}
// Apply a delivered run payment to its bills: each bill's discount first, as a prompt-payment credit on the discount
// account, then the payment.
function applyItems(run, paymentId) {
    const payTime = startOf(dayText(run.payDate))
    for (const item of items(run.paymentRunId, {paymentId}).filter(row => row.resultEnumId !== "PrrPaid")) {
        let discountInvoiceId = item.discountInvoiceId || null
        if (!discountInvoiceId && toDecimal(item.discountAmount || 0).compare(0) > 0)
            discountInvoiceId = takeDiscount(run, item, payTime)
        const applied = call("mantle.account.PaymentServices.apply#InvoicePayment", {
            paymentId,
            invoiceId: item.invoiceId,
            amount: item.paymentAmount,
            appliedDate: payTime
        })
        if (!toDecimal(applied.amountApplied ?? 0).eq(item.paymentAmount))
            denied("APPLICATION_AMOUNT_MISMATCH", "Bill " + item.invoiceId + " was not paid the run's amount")
        call("update#" + RI, {
            paymentRunId: item.paymentRunId,
            paymentRunItemSeqId: item.paymentRunItemSeqId,
            discountInvoiceId,
            resultEnumId: "PrrPaid",
            resultMessage: null
        })
    }
}
// The discount a run takes: the prompt-payment discount the bill's due schedule offers on the pay date, a credit memo the
// organization issues against the bill through create#InvoiceCreditMemo (linkToOriginal, promptDiscount: on the discount
// account, within the bill's credits, finalized with no approval step), applied to the bill.
function takeDiscount(run, item, payTime) {
    const credit = call("mantle.account.InvoiceServices.create#InvoiceCreditMemo", {
        originalInvoiceId: item.invoiceId,
        organizationPartyId: run.organizationPartyId,
        linkToOriginal: true,
        promptDiscount: true,
        invoiceDate: payTime,
        amount: item.discountAmount,
        description: "Prompt payment discount, payment run " + run.paymentRunId
    })
    call("mantle.account.PaymentServices.apply#InvoiceToInvoice", {
        invoiceId: credit.invoiceId,
        toInvoiceId: item.invoiceId,
        amount: item.discountAmount,
        appliedDate: payTime
    })
    return credit.invoiceId
}
// The run's bank file: the one written before, else a new one of the run's payments (write#RunFile, in its own
// transaction, since delivering the payments posts them); then the ACH payments it delivered are applied, each supplier
// on its own. Asking again gives the same file.
function generateFile(p) {
    let run = runScope(p, "PAYMENT_EDIT")
    if (!run.executeOperationKey) denied("RUN_NOT_EXECUTED", "Execute the run first")
    const paymentIdList = [
        ...new Set(
            selectedItems(run.paymentRunId)
                .map(row => row.paymentId)
                .filter(Boolean)
        )
    ]
    const ach = run.paymentInstrumentEnumId === "PiAch"
    if (!run.paymentMethodFileId && paymentIdList.length) {
        probe(services + "write#RunFile", {paymentRunId: run.paymentRunId})
        run = one(R, {paymentRunId: run.paymentRunId})
    }
    if (ach)
        for (const paymentId of paymentIdList) {
            const payment = one(P, {paymentId})
            if (!["PmntDelivered", "PmntConfirmed"].includes(payment.statusId)) continue
            try {
                probe(services + "apply#RunPayment", {paymentRunId: run.paymentRunId, paymentId})
            } catch (error) {
                const message = failMessage(error)
                ec.logger.error("Payment run " + run.paymentRunId + " payment " + paymentId + ": " + message)
                for (const item of items(run.paymentRunId, {paymentId}).filter(row => row.resultEnumId !== "PrrPaid"))
                    probe("update#" + RI, {
                        paymentRunId: item.paymentRunId,
                        paymentRunItemSeqId: item.paymentRunItemSeqId,
                        resultMessage: "Sent, not applied: " + message
                    })
            }
        }
    return file(run)
}
// Write the bank file of an executed run's payments once: NACHA for ACH, which delivers them; Positive Pay for checks when
// the bank account has a format.
function writeFile(p) {
    let run = runScope(p, "PAYMENT_EDIT", true)
    const paymentIdList = [
        ...new Set(
            selectedItems(run.paymentRunId)
                .map(row => row.paymentId)
                .filter(Boolean)
        )
    ]
    const ach = run.paymentInstrumentEnumId === "PiAch"
    if (!run.paymentMethodFileId && paymentIdList.length) {
        const bank = one("mantle.account.method.BankAccount", {paymentMethodId: run.paymentMethodId})
        const thruDate = ec.l10n.parseTimestamp(dayText(run.payDate) + " 23:59:59.999", "yyyy-MM-dd HH:mm:ss.SSS")
        let made = null
        if (ach)
            made = call("mantle.ext.account.NachaServices.generate#NachaFile", {
                paymentMethodId: run.paymentMethodId,
                paymentIdList,
                thruDate,
                effectiveEntryDate: dayText(run.payDate) > today() ? dayText(run.payDate) : null
            })
        else if (bank?.posPayFormatEnumId)
            made = call("mantle.ext.account.PositivePayServices.generate#PositivePayFile", {
                paymentMethodId: run.paymentMethodId,
                paymentIdList,
                thruDate
            })
        if (made?.paymentMethodFileId)
            call("update#" + R, {paymentRunId: run.paymentRunId, paymentMethodFileId: made.paymentMethodFileId})
    }
    return {}
}
function applyPayment(p) {
    const run = runScope(p, "PAYMENT_EDIT", true)
    if (!items(run.paymentRunId, {paymentId: p.paymentId}).length) denied("PAYMENT_UNAVAILABLE", "The payment is not the run's")
    applyItems(run, p.paymentId)
    return {}
}
function file(run) {
    const found =
        run.paymentMethodFileId && one("mantle.account.method.PaymentMethodFile", {paymentMethodFileId: run.paymentMethodFileId})
    if (!found) return {paymentMethodFileId: null, fileText: null, fileName: null}
    return {
        paymentMethodFileId: found.paymentMethodFileId,
        fileTypeEnumId: found.fileTypeEnumId,
        fileText: found.fileText,
        fileName: "PaymentRun-" + run.paymentRunId + "-" + found.paymentMethodFileId + ".txt"
    }
}
// The run's bank file as written, for a user who may execute runs.
function runFile(p) {
    return file(runScope(p, "PAYMENT_EDIT"))
}
// A bank's NACHA return file for the run's bank account (import#NachaReturn, which skips a payment already returned): a
// returned payment is declined, which reverses its posting and unapplies it (the PaymentUnDeliverCleanup SECA). Its bills,
// in whichever run of the bank account paid them, show Returned with the bank's reason, and the discount credits those
// runs took on them are cancelled, so each bill is open again in full.
function importReturn(p) {
    const run = runScope(p, "PAYMENT_EDIT")
    if (run.paymentInstrumentEnumId !== "PiAch" || !run.executeOperationKey)
        denied("RUN_NOT_ACH", "Bank returns are imported for an executed ACH run")
    if (!String(p.nachaString || "").trim()) denied("RETURN_FILE_REQUIRED", "Choose the bank's return file")
    const runIds = Array.from(
        find(R, {organizationPartyId: run.organizationPartyId, paymentMethodId: run.paymentMethodId})
            .condition("executeOperationKey", "is-not-null", null)
            .list()
    ).map(row => row.paymentRunId)
    const paidItems = () =>
        Array.from(find(RI).condition("paymentRunId", "in", runIds).condition("paymentId", "is-not-null", null).list())
    const declined = () =>
        new Set(
            paidItems()
                .map(row => row.paymentId)
                .filter(paymentId => one(P, {paymentId})?.statusId === "PmntDeclined")
        )
    const before = declined()
    ec.message.pushErrors()
    let errors = ""
    try {
        ec.service
            .sync()
            .name("mantle.ext.account.NachaServices.import#NachaReturn")
            .parameters({paymentMethodId: run.paymentMethodId, nachaString: p.nachaString})
            .disableAuthz()
            .call()
        errors = ec.message.getErrorsString() || ""
    } finally {
        ec.message.clearErrors()
        ec.message.popErrors()
    }
    if (errors) denied("RETURN_FILE_INVALID", errors.split("\n")[0])
    // the RunPaymentReturned SECA marked each declined payment's bills; this answers what the file declined
    const returnedPaymentIds = [...declined()].filter(paymentId => !before.has(paymentId))
    return {returnedPaymentIds}
}

// A run payment the bank declined after delivery (the RunPaymentReturned SECA, whatever imported the return): its bills
// show Returned with the bank's reason, and the discount credits the run took on them are cancelled. Once only.
function markReturned(p) {
    const payment = one(P, {paymentId: p.paymentId})
    if (payment?.statusId !== "PmntDeclined") return {returnedCount: 0}
    const response = Array.from(
        find("mantle.account.method.PaymentGatewayResponse", {paymentId: p.paymentId}).orderBy("-transactionDate").limit(1).list()
    )[0]
    let returnedCount = 0
    for (const item of Array.from(find(RI, {paymentId: p.paymentId}).list()).filter(row => row.resultEnumId !== "PrrReturned")) {
        if (item.discountInvoiceId && one(I, {invoiceId: item.discountInvoiceId})?.statusId !== "InvoiceCancelled")
            call("update#" + I, {
                invoiceId: item.discountInvoiceId,
                statusId: "InvoiceCancelled",
                statusId_changeReason: "Payment " + p.paymentId + " returned by the bank"
            })
        call("update#" + RI, {
            paymentRunId: item.paymentRunId,
            paymentRunItemSeqId: item.paymentRunItemSeqId,
            resultEnumId: "PrrReturned",
            resultMessage: [response?.reasonCode, response?.reasonMessage].filter(Boolean).join(" ") || "Returned"
        })
        returnedCount++
    }
    return {returnedCount}
}

// ---- Reads

// A run for its screen: header, totals, capabilities and its bills with names, masked bank accounts and results.
function getRun(p) {
    const run = runScope(p)
    const list = items(run.paymentRunId)
    const names = lib.partyNames([...new Set(list.map(row => row.supplierPartyId))])
    const workflow = ec.resource.script("component://mr-mantle/service/mantle/account/PaymentWorkflow.js")
    const methodIds = [...new Set([run.paymentMethodId, ...list.map(row => row.toPaymentMethodId)].filter(Boolean))]
    const methods = Object.fromEntries(
        workflow
            .methodRows(methodIds.length ? Array.from(find(M).condition("paymentMethodId", "in", methodIds).list()) : [])
            .map(row => [row.paymentMethodId, row.label])
    )
    const bills = Object.fromEntries(
        list.length
            ? Array.from(
                  find(I)
                      .condition(
                          "invoiceId",
                          "in",
                          list.map(row => row.invoiceId)
                      )
                      .list()
              ).map(row => [row.invoiceId, row])
            : []
    )
    const paymentIds = [...new Set(list.map(row => row.paymentId).filter(Boolean))]
    const payments = Object.fromEntries(
        paymentIds.length
            ? Array.from(find(P).condition("paymentId", "in", paymentIds).list()).map(row => [row.paymentId, row])
            : []
    )
    const enumText = Object.fromEntries(
        Array.from(
            find("moqui.basic.Enumeration")
                .condition("enumTypeId", "in", ["PaymentRunExclusion", "PaymentRunResult", "PaymentInstrument"])
                .list()
        ).map(row => [row.enumId, row.description])
    )
    const statusText = id => (id ? one("moqui.basic.StatusItem", {statusId: id})?.description || id : "")
    const selected = list.filter(row => row.selectedIndicator === "Y")
    const fileRow =
        run.paymentMethodFileId && one("mantle.account.method.PaymentMethodFile", {paymentMethodFileId: run.paymentMethodFileId})
    const executing = !!run.executeOperationKey
    const capabilities = {
        canSelect: has("PAYABLE_EDIT") && openRunStatuses.includes(run.statusId) && !executing,
        canRequestApproval: has("PAYABLE_EDIT") && run.statusId === "PrunDraft" && selected.length > 0,
        canApprove: has("PAYMENT_RUN_APPROVE") && run.statusId === "PrunDraft" && selected.length > 0,
        canExecute: has("PAYMENT_EDIT") && run.statusId === "PrunApproved" && !executing,
        canResume: has("PAYMENT_EDIT") && run.statusId === "PrunApproved" && executing,
        canReadFile: has("PAYMENT_EDIT") && executing,
        canImportReturn: has("PAYMENT_EDIT") && executing && run.paymentInstrumentEnumId === "PiAch",
        canCancel: has("PAYABLE_EDIT") && openRunStatuses.includes(run.statusId) && !executing
    }
    return {
        run: Object.assign(lib.display(run), {
            statusText: statusText(run.statusId),
            instrumentText: enumText[run.paymentInstrumentEnumId] || run.paymentInstrumentEnumId,
            bankText: methods[run.paymentMethodId] || run.paymentMethodId,
            organizationName: lib.partyNames([run.organizationPartyId])[run.organizationPartyId],
            dueThroughDateText: dayText(run.dueThroughDate),
            payDateText: dayText(run.payDate),
            selectedTotal: total(selected),
            selectedCount: selected.length,
            excludedCount: list.length - selected.length,
            discountTotal: selected.reduce((sum, row) => sum.add(row.discountAmount || 0), toDecimal(0)),
            paidCount: selected.filter(row => row.resultEnumId === "PrrPaid").length,
            failedCount: selected.filter(row => row.resultEnumId === "PrrFailed").length,
            returnedCount: selected.filter(row => row.resultEnumId === "PrrReturned").length,
            waitingCount: selected.filter(row => row.resultEnumId === "PrrSent").length,
            // the claim's key only for a user who may resume the execution with it
            executeOperationKey: capabilities.canResume ? run.executeOperationKey : null,
            fileTypeText: fileRow ? one("moqui.basic.Enumeration", {enumId: fileRow.fileTypeEnumId})?.description : null,
            fileEntryCount: fileRow?.entryCount ?? null,
            approvedByName: run.approvedByUserId
                ? one("moqui.security.UserAccount", {userId: run.approvedByUserId})?.userFullName || run.approvedByUserId
                : null,
            version: String(lib.ms(run.lastUpdatedStamp))
        }),
        runItems: list.map(row =>
            Object.assign(lib.display(row), {
                supplierName: names[row.supplierPartyId] || row.supplierPartyId,
                referenceNumber: bills[row.invoiceId]?.referenceNumber || null,
                bankText: row.toPaymentMethodId ? methods[row.toPaymentMethodId] || "" : "",
                dueDateText: dayText(row.dueDate),
                discountDateText: dayText(row.discountDate),
                excludeText: row.excludeReasonEnumId
                    ? [enumText[row.excludeReasonEnumId], row.excludeComment].filter(Boolean).join(": ")
                    : "",
                resultText: row.resultEnumId ? enumText[row.resultEnumId] : "",
                paymentStatusText: row.paymentId ? statusText(payments[row.paymentId]?.statusId) : "",
                checkNumber:
                    !run.paymentInstrumentEnumId || run.paymentInstrumentEnumId === "PiAch"
                        ? null
                        : payments[row.paymentId]?.paymentRefNum || null,
                currencyUomId: run.currencyUomId
            })
        ),
        capabilities
    }
}
function cancel(p) {
    const run = runScope(p, "PAYABLE_EDIT", true)
    editable(run)
    call("update#" + R, {
        paymentRunId: run.paymentRunId,
        statusId: "PrunCancelled",
        statusId_changeReason: p.changeReason || null
    })
    return {statusId: "PrunCancelled"}
}

const operations = {
    create,
    select,
    storeItem,
    requestApproval,
    approve,
    voidRunApproval,
    execute,
    claim,
    paySupplier,
    applyPayment,
    generateFile,
    writeFile,
    runFile,
    importReturn,
    markReturned,
    getRun,
    cancel
}
function run(op, parameters) {
    if (!operations[op]) throw new Error("Unknown payment run operation " + op)
    const out = operations[op](parameters) || {}
    ec.context.putAll(out)
    return out
}
;({execute: run})
