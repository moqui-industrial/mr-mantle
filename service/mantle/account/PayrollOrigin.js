// Accounting's payroll-origin projection (design-accounting AC-23 and ExpensePosting's payroll-origin paragraph, design-people §8.3;
// review Y7; built by impl-people P27 as an owner contract): a payroll-origin document is an invoice a pay run's finalization made
// (a People PayrollObligation of an employee's net pay, a payee's aggregate or a receivable from a person: mantle.humanres.payroll),
// a payment of payroll (PtPayrollPayment, which a payment run gives a payroll invoice's payment, as create#InvoicePayment does), and
// a ledger transaction of either. Per-person payroll documents need PAYROLL_VIEW on top of the finance permissions: without it the
// finance reads (AccountingPolicy.js query and record: the invoice, bill, payment, journal and entry lists, the palette and record
// reads; InvoiceWorkflowLib.js invoice: every invoice read and operation; Aging.js; PaymentRuns.js) leave them out, as missing,
// and a total that must reconcile shows them as one masked "Payroll" amount. An expense claim settled on the payroll route stays an
// ordinary bill (its obligation made no invoice). The check is a permission's, never a group's, and a direct service call gets no
// more than the screen.
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const {find, one, denied} = lib

const OBLIGATION = "mantle.humanres.payroll.PayrollObligation"
// the obligation kinds whose invoice the finalization made: the claim's (PokClaim) is the claimant's own bill
const madeKinds = ["PokNetPay", "PokPayee", "PokReceivable"]
const payrollPaymentType = "PtPayrollPayment"

// Whether the user reads payroll-origin documents: PAYROLL_VIEW (design-accounting AC-23: "PAYROLL_VIEW with the finance group").
const canRead = () => ec.user.hasPermission("PAYROLL_VIEW")
// The projection is built (People P27): native finalization and P28's live external results, which make the same payroll invoices,
// are refused for an organization until it is (design-people §8 Release 1, impl-people §4). Kept as a function, so a deployment
// that removes the projection's coverage turns both off in one place.
const inPlace = () => true

// The invoices of a list that are payroll-origin.
function payrollInvoiceIds(invoiceIds) {
    const ids = Array.from(new Set(Array.from(invoiceIds || []).filter(Boolean)))
    const out = []
    for (let index = 0; index < ids.length; index += 1000)
        for (const row of find(OBLIGATION)
            .condition("invoiceId", "in", ids.slice(index, index + 1000))
            .condition("obligationKindEnumId", "in", madeKinds)
            .selectField("invoiceId")
            .list())
            out.push(row.invoiceId)
    return out
}
const isPayrollInvoice = invoiceId => !!invoiceId && payrollInvoiceIds([invoiceId]).length > 0
function isPayrollPayment(payment) {
    const row = typeof payment === "string" ? one("mantle.account.payment.Payment", {paymentId: payment}) : payment
    return !!row && row.paymentTypeEnumId === payrollPaymentType
}

// The conditions a finance read adds for a user without PAYROLL_VIEW (none for a holder): on InvoiceFinance's
// payrollObligationKindEnumId, a Payment's paymentTypeEnumId, and AcctgTransFinance's or AcctgTransAndEntryFinance's two.
function invoiceCondition() {
    if (canRead()) return null
    const cf = ec.entity.conditionFactory
    return cf.makeCondition(
        [
            cf.makeCondition("payrollObligationKindEnumId", "is-null", null),
            cf.makeCondition("payrollObligationKindEnumId", "not-in", madeKinds)
        ],
        "or"
    )
}
function paymentCondition() {
    if (canRead()) return null
    const cf = ec.entity.conditionFactory
    return cf.makeCondition(
        [
            cf.makeCondition("paymentTypeEnumId", "is-null", null),
            cf.makeCondition("paymentTypeEnumId", "not-equals", payrollPaymentType)
        ],
        "or"
    )
}
function transactionCondition() {
    if (canRead()) return null
    return ec.entity.conditionFactory.makeCondition([invoiceCondition(), paymentCondition()], "and")
}

// An invoice read or changed through Accounting: a payroll-origin one is missing to a user without PAYROLL_VIEW (the same
// refusal as a missing invoice, so its existence is not told).
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

;({
    canRead,
    inPlace,
    madeKinds,
    payrollPaymentType,
    payrollInvoiceIds,
    isPayrollInvoice,
    isPayrollPayment,
    invoiceCondition,
    paymentCondition,
    transactionCondition,
    requireInvoice,
    requirePayment,
    maskRows
})
