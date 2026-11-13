// Accounting's payroll-origin projection (design-accounting AC-23 and ExpensePosting's payroll-origin paragraph, design-people §8.3;
// review Y7; built by impl-people P27 as an owner contract): a payroll-origin document is an invoice a pay run's finalization made
// (a People PayrollObligation of an employee's net pay, a payee's amounts or a receivable from a person: mantle.humanres.payroll),
// a payment of payroll (PtPayrollPayment, which a payment run gives a payroll invoice's payment, as create#InvoicePayment does) or
// any payment applied to such an invoice (one made by hand too), and a ledger transaction of either. Per-person payroll documents
// need PAYROLL_VIEW on top of the finance permissions: without it every finance read leaves them out, as missing, and a total that
// must reconcile shows them as one masked "Payroll" amount. An expense claim settled on the payroll route stays an ordinary bill
// (its obligation made no invoice). The check is a permission's, never a group's, and a direct service call gets no more than the
// screen.
//
// The mark (People P27 review): Invoice, Payment and AcctgTrans carry payrollOrigin "Y", so every finance read, its views (each
// aliases its entity's fields) and its exports filter on one field, with no join to People: the finalization makes its invoices
// marked (PayrollObligations.js), and entity ECA rules (entity/PayrollOrigin.eecas.xml) mark a payroll payment, a payment applied to
// a marked invoice or to or from a marked payment, and a transaction of a marked invoice or payment (the payment's transactions
// made before the application too). A mark is never taken off. Payments and transactions of PtPayrollPayment made before the mark
// are marked by migrate#PayrollOriginMarks on a data load (data/ZaaGlAccountsUpdateData.xml).
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const {find, one, denied} = lib

const INVOICE = "mantle.account.invoice.Invoice"
const PAYMENT = "mantle.account.payment.Payment"
const TRANSACTION = "mantle.ledger.transaction.AcctgTrans"
const payrollPaymentType = "PtPayrollPayment"
const field = "payrollOrigin"

// Whether the user reads payroll-origin documents: PAYROLL_VIEW (design-accounting AC-23: "PAYROLL_VIEW with the finance group").
const canRead = () => ec.user.hasPermission("PAYROLL_VIEW")
// The projection is built (People P27): native finalization and P28's live external results, which make the same payroll invoices,
// are refused for an organization until it is (design-people §8 Release 1, impl-people §4). Kept as a function, so a deployment
// that removes the projection's coverage turns both off in one place.
const inPlace = () => true

function marked(entityName, pkField, ids) {
    const list = Array.from(new Set(Array.from(ids || []).filter(Boolean)))
    const out = []
    for (let index = 0; index < list.length; index += 1000)
        for (const row of find(entityName)
            .condition(pkField, "in", list.slice(index, index + 1000))
            .condition(field, "Y")
            .selectField(pkField)
            .list())
            out.push(row[pkField])
    return out
}
// The invoices, payments and transactions of a list that are payroll-origin.
const payrollInvoiceIds = ids => marked(INVOICE, "invoiceId", ids)
const payrollPaymentIds = ids => marked(PAYMENT, "paymentId", ids)
const payrollTransactionIds = ids => marked(TRANSACTION, "acctgTransId", ids)
// Whether any payroll-origin document exists (a search's counts are then the page's for a user without PAYROLL_VIEW).
const anyMarked = () =>
    [INVOICE, PAYMENT, TRANSACTION].some(
        entityName => find(entityName).condition(field, "Y").selectField(field).limit(1).list().length > 0
    )
const isPayrollInvoice = invoiceId => !!invoiceId && payrollInvoiceIds([invoiceId]).length > 0
function isPayrollPayment(payment) {
    if (!payment) return false
    if (typeof payment !== "string") {
        if (payment[field] === "Y" || payment.paymentTypeEnumId === payrollPaymentType) return true
        payment = payment.paymentId
    }
    return !!payment && payrollPaymentIds([payment]).length > 0
}

// The condition a finance read adds for a user without PAYROLL_VIEW (none for a holder): the mark on the entity or view read, by
// its alias (payrollOrigin where the view aliases all of the Invoice, Payment or AcctgTrans it reads; a view that joins one under
// another name passes the alias).
function notMarked(alias = field) {
    const cf = ec.entity.conditionFactory
    return cf.makeCondition([cf.makeCondition(alias, "is-null", null), cf.makeCondition(alias, "not-equals", "Y")], "or")
}
const hidden = (alias = field) => (canRead() ? null : notMarked(alias))
const invoiceCondition = (alias = field) => hidden(alias)
const paymentCondition = (alias = field) => hidden(alias)
const transactionCondition = (alias = field) => hidden(alias)

// An invoice or payment read or changed through Accounting: a payroll-origin one is missing to a user without PAYROLL_VIEW (the same
// refusal as a missing one, so its existence is not told).
function requireInvoice(invoiceId) {
    if (!canRead() && isPayrollInvoice(invoiceId)) denied("INVOICE_UNAVAILABLE", "Invoice is not available")
}
function requirePayment(payment) {
    if (!canRead() && isPayrollPayment(payment)) denied("PAYMENT_UNAVAILABLE", "Payment is not available")
}

// A list of rows that carry an invoice id, the payroll-origin ones folded into one masked "Payroll" row for a user without
// PAYROLL_VIEW, so a total that must reconcile still does: {rows, masked} where masked is the folded rows (none for a holder).
function maskRows(list, invoiceField = "invoiceId") {
    if (canRead() || !list.length) return {rows: list, masked: []}
    const payroll = new Set(payrollInvoiceIds(list.map(row => row[invoiceField])))
    if (!payroll.size) return {rows: list, masked: []}
    return {rows: list.filter(row => !payroll.has(row[invoiceField])), masked: list.filter(row => payroll.has(row[invoiceField]))}
}
// The rows of a list a user without PAYROLL_VIEW may see: none naming a payroll-origin invoice, payment or transaction in the given
// fields (fields: {invoice: [...], payment: [...], transaction: [...]}). A holder sees them all.
function visibleRows(list, fields = {}) {
    if (canRead() || !list.length) return list
    const ids = (names, fn) => {
        const values = []
        for (const row of list) for (const name of names || []) if (row[name]) values.push(row[name])
        return new Set(values.length ? fn(values) : [])
    }
    const invoices = ids(fields.invoice, payrollInvoiceIds)
    const payments = ids(fields.payment, payrollPaymentIds)
    const transactions = ids(fields.transaction, payrollTransactionIds)
    const shows = row =>
        !(fields.invoice || []).some(name => invoices.has(row[name])) &&
        !(fields.payment || []).some(name => payments.has(row[name])) &&
        !(fields.transaction || []).some(name => transactions.has(row[name]))
    return list.filter(shows)
}

// ===== the mark (entity/PayrollOrigin.eecas.xml) =====
const markRows = (entityName, conditions) =>
    find(entityName, conditions)
        .condition(notMarked())
        .updateAll({[field]: "Y"})
// A payment marked, with every transaction of it.
function markPayment(paymentId) {
    if (!paymentId) return
    markRows(PAYMENT, {paymentId})
    markRows(TRANSACTION, {paymentId})
}
// A payment of payroll's type is marked as it is written (run before its create or update).
function markPaymentValue(entityValue) {
    if (entityValue?.paymentTypeEnumId === payrollPaymentType && entityValue[field] !== "Y") entityValue[field] = "Y"
}
// A transaction of a marked invoice or payment is marked as it is written (run before its create or update).
function markTransactionValue(entityValue) {
    if (!entityValue || entityValue[field] === "Y") return
    if (
        [entityValue.invoiceId, entityValue.toInvoiceId].some(id => id && one(INVOICE, {invoiceId: id})?.[field] === "Y") ||
        [entityValue.paymentId, entityValue.toPaymentId].some(id => id && one(PAYMENT, {paymentId: id})?.[field] === "Y")
    )
        entityValue[field] = "Y"
}
// An application: a payment applied to a marked invoice is marked (one made by hand too), as is a payment applied to or from a
// marked one (a refund of a payroll payment), and the application's own transactions.
function markApplication(application) {
    if (!application) return
    const invoice = [application.invoiceId, application.toInvoiceId].some(id => id && isPayrollInvoice(id))
    const payments = [application.paymentId, application.toPaymentId].filter(Boolean)
    const payment = payments.some(id => payrollPaymentIds([id]).length > 0)
    if (!invoice && !payment) return
    for (const id of payments) markPayment(id)
    if (application.paymentApplicationId) markRows(TRANSACTION, {paymentApplicationId: application.paymentApplicationId})
}

// ===== migrate#PayrollOrigin (data/ZaaGlAccountsUpdateData.xml) =====
// An existing database's payroll posting mappings added where missing (DefaultSettings and each organization with its own), and
// payroll payments made before the mark marked; each organization on its own (failure tolerant). Nothing to do once done.
function migrate() {
    const PTGA = "mantle.ledger.config.PaymentTypeGlAccount"
    const ITTT = "mantle.ledger.config.InvoiceTypeTransType"
    const already = ec.artifactExecution.disableAuthz()
    const out = {mappingCount: 0, markedCount: 0, failedCount: 0}
    const each = (what, body) => {
        try {
            ec.transaction.runRequireNew(null, what + " failed", body)
        } catch (error) {
            out.failedCount++
            ec.logger.error(what + " failed: " + (error?.message || error))
        }
    }
    try {
        const orgIds = new Set(
            Array.from(find(PTGA).condition("paymentTypeEnumId", "PtInvoicePayment").condition("isPayable", "Y").list()).map(
                row => row.organizationPartyId
            )
        )
        for (const organizationPartyId of orgIds)
            each("Adding PtPayrollPayment's mappings for " + organizationPartyId, () => {
                const has = isApplied =>
                    !!one(PTGA, {organizationPartyId, paymentTypeEnumId: payrollPaymentType, isApplied, isPayable: "Y"})
                const payable = one(ITTT, {organizationPartyId, invoiceTypeEnumId: "InvoicePayroll", isPayable: "Y"})?.glAccountId
                const unapplied = one(PTGA, {
                    organizationPartyId,
                    paymentTypeEnumId: "PtInvoicePayment",
                    isApplied: "N",
                    isPayable: "Y"
                })?.glAccountId
                for (const [isApplied, glAccountId] of [
                    ["Y", payable],
                    ["N", unapplied]
                ])
                    if (glAccountId && !has(isApplied)) {
                        ec.entity
                            .makeValue(PTGA)
                            .setAll({
                                organizationPartyId,
                                paymentTypeEnumId: payrollPaymentType,
                                isApplied,
                                isPayable: "Y",
                                glAccountId
                            })
                            .create()
                        out.mappingCount++
                    }
            })
        const payrollOrgIds = new Set(
            Array.from(find(ITTT).condition("invoiceTypeEnumId", "InvoicePayroll").condition("isPayable", "Y").list()).map(
                row => row.organizationPartyId
            )
        )
        for (const organizationPartyId of payrollOrgIds)
            each("Adding InvoicePayroll's receivable mapping for " + organizationPartyId, () => {
                if (one(ITTT, {organizationPartyId, invoiceTypeEnumId: "InvoicePayroll", isPayable: "N"})) return
                const receivable = one(ITTT, {
                    organizationPartyId,
                    invoiceTypeEnumId: "InvoiceSales",
                    isPayable: "N"
                })?.glAccountId
                if (!receivable) return
                ec.entity
                    .makeValue(ITTT)
                    .setAll({
                        organizationPartyId,
                        invoiceTypeEnumId: "InvoicePayroll",
                        isPayable: "N",
                        acctgTransTypeEnumId: "AttPayrollInvoice",
                        glAccountId: receivable
                    })
                    .create()
                out.mappingCount++
            })
        const unmarked = Array.from(
            find(PAYMENT)
                .condition("paymentTypeEnumId", payrollPaymentType)
                .condition(notMarked())
                .selectField("paymentId")
                .list()
        )
        for (const row of unmarked)
            each("Marking payroll payment " + row.paymentId, () => {
                markPayment(row.paymentId)
                out.markedCount++
            })
    } finally {
        if (!already) ec.artifactExecution.enableAuthz()
    }
    return out
}

;({
    canRead,
    inPlace,
    field,
    payrollPaymentType,
    payrollInvoiceIds,
    payrollPaymentIds,
    payrollTransactionIds,
    anyMarked,
    isPayrollInvoice,
    isPayrollPayment,
    invoiceCondition,
    paymentCondition,
    transactionCondition,
    requireInvoice,
    requirePayment,
    maskRows,
    visibleRows,
    markPayment,
    markPaymentValue,
    markTransactionValue,
    markApplication,
    migrate
})
