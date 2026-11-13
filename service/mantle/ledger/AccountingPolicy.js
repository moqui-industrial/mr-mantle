// Native finance authorization. No artifact authorization or request-supplied scope can replace these checks. A refusal
// is denied(reason, message): callers compare the reason code. The entity and value helpers are EntityLib's, exported
// here too for the ledger modules that read them through this module.
const domain = ec.resource.script("component://mr-mantle/service/mantle/product/ProductAccess.js")
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const {find, one, rows, map, call, probe, ms, active, pick, hash, dateText, calendarDateText, display, denied, check} = lib
const payrollOrigin = () => ec.resource.script("component://mr-mantle/service/mantle/account/PayrollOrigin.js")
// A posting's book day: its accounting day, else the day of its transaction date in the user's zone, the rule of a
// document's and an application's book day.
function postingDay(transaction) {
    const day = lib.bookDay(transaction.accountingDate, transaction.transactionDate)
    if (!day) denied("POSTING_DATE_INVALID", "A ledger posting needs its original accounting day or timestamp")
    return day
}
// New postings carry a fixed business day; older postings retain their existing timestamp range semantics.
function accountingDateCondition({fromDate, thruDate, fromDay, thruDay, inclusive = false}) {
    if (!fromDate && !thruDate && !fromDay && !thruDay) return null
    if (!fromDay && fromDate) fromDay = ec.l10n.format(fromDate, "yyyy-MM-dd")
    if (!thruDay && thruDate) thruDay = ec.l10n.format(thruDate, "yyyy-MM-dd")
    const cf = ec.entity.conditionFactory
    const dated = [cf.makeCondition("accountingDate", "is-not-null", null)]
    const legacy = [cf.makeCondition("accountingDate", "is-null", null)]
    if (fromDay) dated.push(cf.makeCondition("accountingDate", "greater-equals", fromDay))
    if (thruDay) dated.push(cf.makeCondition("accountingDate", inclusive ? "less-equals" : "less", thruDay))
    if (fromDate) legacy.push(cf.makeCondition("transactionDate", "greater-equals", fromDate))
    if (thruDate) legacy.push(cf.makeCondition("transactionDate", inclusive ? "less-equals" : "less", thruDate))
    return cf.makeCondition([cf.makeCondition(dated, "and"), cf.makeCondition(legacy, "and")], "or")
}
function capabilities() {
    const has = domain.has
    const admin = has("ACCOUNTING_ADMIN")
    const out = {
        systemAdmin: domain.systemAdmin(),
        admin,
        glPost: has("ACCOUNTING_GL_POST"),
        reportRead: has("ACCOUNTING_VIEW"),
        arRead: has("RECEIVABLE_VIEW"),
        apRead: has("PAYABLE_VIEW"),
        paymentRead: has("PAYMENT_VIEW"),
        arEdit: has("RECEIVABLE_EDIT"),
        apEdit: has("PAYABLE_EDIT"),
        paymentEdit: has("PAYMENT_EDIT"),
        runApprove: has("PAYMENT_RUN_APPROVE"),
        bankReconcile: has("BANK_RECONCILE"),
        match: has("INVOICE_MATCH"),
        taxEdit: has("TAX_STATEMENT_EDIT"),
        approve: has("INVOICE_APPROVE"),
        holdPlace: has("INVOICE_HOLD"),
        holdRelease: has("INVOICE_HOLD_RELEASE"),
        payableImport: has("PAYABLE_IMPORT"),
        supplierTermsEdit: has("SUPPLIER_TERMS_EDIT"),
        budgetEdit: has("BUDGET_EDIT"),
        budgetApprove: has("BUDGET_APPROVE"),
        budgetOverride: has("BUDGET_OVERRIDE"),
        returnCreditApprove: has("RETURN_CREDIT_APPROVE"),
        fiscalClose: has("FISCAL_CLOSE"),
        fiscalReopen: has("FISCAL_REOPEN"),
        creditView: has("CUSTOMER_CREDIT_VIEW"),
        creditRelease: has("CREDIT_HOLD_RELEASE")
    }
    // An edit permission alone opens no reads: other apps' groups hold some (Projects' RECEIVABLE_EDIT for billing).
    out.read = [
        out.systemAdmin,
        out.admin,
        out.glPost,
        out.reportRead,
        out.arRead,
        out.apRead,
        out.paymentRead,
        out.match,
        out.taxEdit,
        out.approve,
        out.fiscalClose,
        out.fiscalReopen
    ].some(Boolean)
    return out
}
// A scope's organizations. A narrow capability (bankReconcile) opens only the scope that names it, not every read.
function access(need = "read") {
    const c = capabilities()
    if (!c.read && !(need === "bankReconcile" && c.bankReconcile)) denied("ACCESS_DENIED", "Accounting access is required")
    let ids, activeId
    if (c.admin) {
        ids = Array.from(find("mantle.party.PartyRole", {roleTypeId: "OrgInternal"}).selectField("partyId").list()).map(
            r => r.partyId
        )
        activeId = ec.user.getPreference("ACTIVE_ORGANIZATION") || null
    } else {
        const org = call("mantle.party.PartyServices.get#PartyOrganizationInfo")
        ids = Array.from(org.userOrgIds || [])
        activeId = org.activeOrgId || null
    }
    if (!ids.includes(activeId)) activeId = null
    return {
        capabilities: c,
        organizationPartyIds: ids,
        activeOrganizationPartyId: activeId,
        allowedOrganizationPartyIds: activeId ? [activeId] : ids
    }
}
function scope(p = {}, need = "read") {
    const a = access(need)
    if (!Object.prototype.hasOwnProperty.call(a.capabilities, need) || !a.capabilities[need])
        denied("PERMISSION_DENIED", "Accounting " + need + " authority is required")
    const org =
        p.organizationPartyId ||
        a.activeOrganizationPartyId ||
        (a.allowedOrganizationPartyIds.length === 1 ? a.allowedOrganizationPartyIds[0] : null)
    if (org && !a.allowedOrganizationPartyIds.includes(org))
        denied("ORGANIZATION_DENIED", "Accounting organization is not available")
    return Object.assign(a, {organizationPartyId: org})
}
// The organizations a scope covers: the chosen one, else every one the user may work in.
function organizationIds(scope) {
    return scope.organizationPartyId ? [scope.organizationPartyId] : scope.allowedOrganizationPartyIds
}
function organization(p, need = "read") {
    const s = scope(p, need)
    if (!s.organizationPartyId) denied("ORGANIZATION_REQUIRED", "Choose an internal organization")
    return s
}
function preference(org) {
    return (
        call("mantle.ledger.LedgerServices.find#PartyAcctgPreference", {
            organizationPartyId: org
        }).partyAcctgPreference || {}
    )
}
function reason(p) {
    const value = String(p.changeReason || "").trim()
    if (!value || value.length > 255) denied("CHANGE_REASON_REQUIRED", "Give a change reason of 1–255 characters")
    return value
}
function audit(fields, why) {
    ec.context.putAll(Object.fromEntries(fields.map(f => [f + "_changeReason", why])))
}
function revision(row, expected) {
    if (row && (expected == null || ms(row.lastUpdatedStamp) !== ms(expected)))
        denied("STALE_REVISION", "Record changed; reload before saving")
}
function organizationChain(org, date = ec.user.nowTimestamp, visited = []) {
    if (visited.includes(org)) denied("ORGANIZATION_CYCLE", "Organization configuration hierarchy contains a cycle")
    const parents = rows("mantle.party.PartyRelationship", {
        fromPartyId: org,
        relationshipTypeEnumId: "PrtOrgRollup"
    }).filter(r => active(r, date))
    return [org].concat(parents.flatMap(r => organizationChain(r.toPartyId, date, [...visited, org])))
}
function accountAssignment(org, id, date = ec.user.nowTimestamp) {
    for (const organizationPartyId of organizationChain(org, date)) {
        const row = one("mantle.ledger.account.GlAccountOrganization", {
            glAccountId: id,
            organizationPartyId
        })
        if (row) return row
    }
    return null
}
function account(org, id, date = ec.user.nowTimestamp) {
    const row = one("mantle.ledger.account.GlAccount", {glAccountId: id})
    const assignment = accountAssignment(org, id, date)
    if (!row || row.disallowPosting === "Y" || !assignment || !active(assignment, date))
        denied("ACCOUNT_UNAVAILABLE", "Choose an active posting account assigned to this organization")
    return {row, assignment}
}
function dimensions(org, values, date = ec.user.nowTimestamp) {
    if (values.facilityId && one("mantle.facility.Facility", {facilityId: values.facilityId})?.ownerPartyId !== org)
        denied("DIMENSION_SCOPE", "Facility is outside the posting organization")
    if (
        values.costCenterId &&
        (!one("mantle.party.PartyRole", {
            partyId: values.costCenterId,
            roleTypeId: "OrgInternal"
        }) ||
            !organizationChain(values.costCenterId, date).includes(org))
    )
        denied("DIMENSION_SCOPE", "Cost centre is outside the posting organization")
}
function counterparty(id) {
    if (!id) return
    const party = one("mantle.party.Party", {partyId: id})
    if (!party || (party.privateOwnerUserId && party.privateOwnerUserId !== ec.user.userId))
        denied("PARTY_UNAVAILABLE", "Counterparty is not available")
}
function currency(id) {
    const r = one("moqui.basic.Uom", {uomId: id})
    if (!r || r.uomTypeEnumId !== "UT_CURRENCY_MEASURE") denied("CURRENCY_REQUIRED", "Choose a currency")
    return r
}
const kinds = {
    invoices: ["mantle.account.invoice.InvoiceFinance", "invoiceId", "fromPartyId", "arRead"],
    bills: ["mantle.account.invoice.InvoiceFinance", "invoiceId", "toPartyId", "apRead"],
    payments: ["mantle.account.payment.Payment", "paymentId", "fromPartyId", "paymentRead"],
    accounts: ["mantle.ledger.account.GlAccountAndOrganization", "glAccountId", "organizationPartyId", "glPost"],
    journals: ["mantle.ledger.transaction.AcctgTrans", "acctgTransId", "organizationPartyId", "glPost"],
    entries: ["mantle.ledger.transaction.AcctgTransAndEntry", "acctgTransId", "organizationPartyId", "glPost"],
    periods: ["mantle.party.time.TimePeriod", "timePeriodId", "partyId", "glPost"],
    batches: ["mantle.ledger.transaction.GlJournal", "glJournalId", "organizationPartyId", "glPost"],
    templates: ["mantle.ledger.transaction.AcctgTransTemplate", "acctgTransTemplateId", "organizationPartyId", "glPost"],
    locks: ["mantle.ledger.config.AccountingLock", "accountingLockId", "organizationPartyId", "admin"],
    exceptions: ["mantle.ledger.config.AccountingLockException", "accountingLockExceptionId", "organizationPartyId", "admin"]
}
// People P27 (AC-23): the transaction kinds read through a view that joins their payroll origin
const transactionViews = {
    journals: "mantle.ledger.transaction.AcctgTransFinance",
    entries: "mantle.ledger.transaction.AcctgTransAndEntryFinance"
}
// The fields a search text matches, ignoring case: the record's id and its names.
const searchFields = {
    invoices: ["invoiceId", "description", "referenceNumber"],
    bills: ["invoiceId", "description", "referenceNumber"],
    payments: ["paymentId", "paymentRefNum", "comments"],
    accounts: ["glAccountId", "accountCode", "accountName"],
    journals: ["acctgTransId", "description"],
    entries: ["acctgTransId", "txDescription", "description"],
    periods: ["timePeriodId", "periodName"],
    batches: ["glJournalId", "glJournalName"],
    templates: ["acctgTransTemplateId", "templateName", "description"],
    locks: ["accountingLockId", "lockScope", "changeReason"],
    exceptions: ["accountingLockExceptionId", "lockScope", "changeReason"]
}
// A linked credit belongs to its source's financial side even though Mantle reverses its parties.
function invoiceDirectionCondition(kind, ids) {
    const cf = ec.entity.conditionFactory
    const partyIds = ids.length ? ids : ["_DENIED_"]
    const receivable = kind === "invoices"
    return cf.makeCondition(
        [
            cf.makeCondition(
                [
                    cf.makeCondition("financeDirection", "equals", receivable ? "receivable" : "payable"),
                    cf.makeCondition("financeOrganizationPartyId", "in", partyIds)
                ],
                "and"
            ),
            cf.makeCondition(
                [
                    cf.makeCondition("financeDirection", "is-null", null),
                    cf.makeCondition("creditForInvoiceId", "is-not-null", null),
                    cf.makeCondition(receivable ? "sourceFromPartyId" : "sourceToPartyId", "in", partyIds)
                ],
                "and"
            ),
            cf.makeCondition(
                [
                    cf.makeCondition("financeDirection", "is-null", null),
                    cf.makeCondition("creditForInvoiceId", "is-null", null),
                    cf.makeCondition(receivable ? "fromPartyId" : "toPartyId", "in", partyIds)
                ],
                "and"
            )
        ],
        "or"
    )
}
function query(p) {
    const kind = kinds[p.kind]
    if (!kind) denied("RECORD_KIND_INVALID", "Unknown accounting record kind")
    const s = scope(p)
    if (
        !s.capabilities.reportRead &&
        !s.capabilities.admin &&
        !s.capabilities[kind[3]] &&
        !(p.kind === "payments" && (s.capabilities.arRead || s.capabilities.apRead))
    )
        denied("RECORD_UNAVAILABLE", "Accounting record is not available")
    let ids = organizationIds(s)
    if (["accounts", "periods"].includes(p.kind)) ids = [...new Set(ids.flatMap(id => organizationChain(id)))]
    // People P27 (AC-23, the payroll-origin projection): payroll-origin invoices, payments and ledger lines are a holder of
    // PAYROLL_VIEW's. For anyone else a list leaves them out and a record read finds none: a transaction read without a lock
    // through its view with the payroll origin joined (a locked read, which a view's outer joins cannot take, is checked on the row
    // it finds, record below)
    const origin = payrollOrigin()
    const originView = !p.forUpdate && !origin.canRead() ? transactionViews[p.kind] : null
    let q = find(originView || kind[0])
    if (["invoices", "bills"].includes(p.kind)) {
        q = q.condition(invoiceDirectionCondition(p.kind, ids))
        if (!s.capabilities.systemAdmin) {
            const cf = ec.entity.conditionFactory
            for (const field of ["fromPrivateOwnerUserId", "toPrivateOwnerUserId"])
                q = q.condition(
                    cf.makeCondition(
                        [cf.makeCondition(field, "is-null", null), cf.makeCondition(field, "equals", ec.user.userId)],
                        "or"
                    )
                )
        }
    } else if (p.kind === "payments") {
        const cf = ec.entity.conditionFactory
        q = q.condition(
            cf.makeCondition(
                [
                    cf.makeCondition("fromPartyId", "in", ids.length ? ids : ["_DENIED_"]),
                    cf.makeCondition("toPartyId", "in", ids.length ? ids : ["_DENIED_"])
                ],
                "or"
            )
        )
    } else q = q.condition(kind[2], "in", ids.length ? ids : ["_DENIED_"])
    const originCondition = ["invoices", "bills"].includes(p.kind)
        ? origin.invoiceCondition()
        : p.kind === "payments"
          ? origin.paymentCondition()
          : originView
            ? origin.transactionCondition()
            : null
    if (originCondition) q = q.condition(originCondition)
    if (p.recordId) q = q.condition(kind[1], p.recordId)
    if (p.acctgTransId && p.kind === "entries") q = q.condition("acctgTransId", p.acctgTransId)
    if (p.parentGlAccountId && p.kind === "accounts") q = q.condition("parentGlAccountId", p.parentGlAccountId)
    if (p.glAccountId && ["accounts", "entries"].includes(p.kind)) q = q.condition("glAccountId", p.glAccountId)
    if (p.isPosted && ["journals", "entries"].includes(p.kind)) q = q.condition("isPosted", p.isPosted)
    if (p.glJournalId && p.kind === "journals") q = q.condition("glJournalId", p.glJournalId)
    const text = String(p.text || "").trim()
    if (text) {
        const cf = ec.entity.conditionFactory
        q = q.condition(
            cf.makeCondition(
                (searchFields[p.kind] || [kind[1]]).map(field => cf.makeCondition(field, "like", "%" + text + "%").ignoreCase()),
                "or"
            )
        )
    }
    return {q, s, kind}
}
function record(p, need = "read", lock = false) {
    if (!p.recordId) denied("RECORD_REQUIRED", "An accounting record ID is required")
    const {q, s} = query(lock ? Object.assign({}, p, {forUpdate: true}) : p)
    if (need !== "read" && !s.capabilities[need]) denied("PERMISSION_DENIED", "Accounting " + need + " authority is required")
    const row = (lock ? q.forUpdate(true) : q).one()
    if (!row) denied("RECORD_UNAVAILABLE", "Accounting record is not available")
    // People P27 (AC-23): a locked transaction read is checked on its row (its query had no payroll origin joined)
    if (lock && transactionViews[p.kind]) {
        const origin = payrollOrigin()
        if (!origin.canRead() && (origin.isPayrollInvoice(row.invoiceId) || origin.isPayrollPayment(row.paymentId || null)))
            denied("RECORD_UNAVAILABLE", "Accounting record is not available")
    }
    return row
}
;({
    lib,
    denied,
    check,
    find,
    one,
    rows,
    map,
    display,
    dateText,
    calendarDateText,
    bookDay: lib.bookDay,
    postingDay,
    accountingDateCondition,
    call,
    probe,
    ms,
    active,
    pick,
    hash,
    capabilities,
    access,
    scope,
    organizationIds,
    organization,
    preference,
    reason,
    audit,
    revision,
    account,
    accountAssignment,
    organizationChain,
    currency,
    dimensions,
    counterparty,
    invoiceDirectionCondition,
    kinds,
    query,
    record
})
