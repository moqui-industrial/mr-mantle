// The rules every application follows, checked by Mantle's apply services and by PostingGuard on the ledger services:
// an application is not dated before its documents or their postings, and a posting that backs a positive
// application is not reversed until the application is unapplied. The data is spec-local.
const helper = () => ec.resource.script("component://mr-mantle/test/account/AccountingSettlementFixtures.js")
const A = "mantle.account.payment.PaymentApplication",
    T = "mantle.ledger.transaction.AcctgTrans",
    services = "mantle.account.PaymentServices."
let f
function refusal(action) {
    try {
        action()
        return ""
    } catch (error) {
        ec.message.clearErrors()
        return String(error.message)
    }
}
function sourcePosting(h, field, id) {
    return h.lib
        .find(T, {[field]: id, isPosted: "Y"})
        .condition("reverseOfAcctgTransId", "is-null", null)
        .condition("reversedByAcctgTransId", "is-null", null)
        .condition("paymentApplicationId", "is-null", null)
        .one()
}
spec({
    stepwise: true,
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        f = helper().fixtures("ACCT_APP_RULES")
        // The rules hold without the general posting guard, which would also ask for reviewed journal operations.
        helper().call("update#mantle.ledger.config.PartyAcctgPreference", {organizationPartyId: f.org, postingGuardEnabled: "N"})
    },
    setup() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
    },
    cleanupSpec() {
        login("john.doe")
        if (f?.org) helper().base.cleanupLocks(f.org)
    }
})
feature("apply#InvoicePayment keeps the reviewed day and paid date, and refuses a day before a document or a sub-cent amount", {
    when() {
        const h = helper(),
            invoiceId = h.invoice(f, "10"),
            paymentId = h.payment(f, "10"),
            before = h.count(A)
        const earlier = refusal(() =>
            h.call(services + "apply#InvoicePayment", {paymentId, invoiceId, appliedDate: Number(f.timestamp) - 2 * 86400000})
        )
        const subCent = refusal(() => h.call(services + "apply#InvoicePayment", {paymentId, invoiceId, amount: "0.001"}))
        const refused = h.count(A) - before
        const applied = h.call(services + "apply#InvoicePayment", {
            paymentId,
            invoiceId,
            appliedDate: f.timestamp,
            accountingDate: f.day
        })
        return {
            earlier,
            subCent,
            refused,
            application: h.lib.one(A, {paymentApplicationId: applied.paymentApplicationId}),
            posting: h.lib.one(T, {paymentApplicationId: applied.paymentApplicationId}),
            invoice: h.lib.one(h.lib.invoiceEntity, {invoiceId})
        }
    },
    then({earlier, subCent, refused, application, posting, invoice}) {
        earlier.includes("APPLICATION_DATE_INVALID")
        subCent.includes("APPLICATION_AMOUNT_PRECISION")
        refused == 0
        toDecimal(application.amountApplied).eq(10)
        helper().lib.policy.calendarDateText(application.accountingDate) == f.day
        helper().lib.policy.calendarDateText(posting.accountingDate) == f.day
        invoice.statusId == "InvoicePmtRecvd"
        helper().lib.ms(invoice.paidDate) == Number(f.timestamp)
    }
})
// 20:30 in Chicago on October 30, already October 31 in UTC: the invoice, the payment's posting and the application all
// take the user's day.
const chicagoEvening = Date.UTC(2026, 9, 31, 1, 30)
feature("an evening application in the Americas is not before its same-day invoice and payment", {
    when() {
        const h = helper(),
            savedTimeZone = ec.user.userAccount?.timeZone || null
        ec.user.setTimeZone("America/Chicago")
        ec.user.setEffectiveTime(chicagoEvening)
        try {
            const invoiceId = h.call("mantle.account.InvoiceServices.create#Invoice", {
                fromPartyId: f.org,
                toPartyId: f.customer,
                currencyUomId: "USD"
            }).invoiceId
            h.call("mantle.account.InvoiceServices.create#InvoiceItem", {
                invoiceId,
                quantity: "1",
                amount: "7",
                itemTypeEnumId: "ItemTimeEntry",
                overrideGlAccountId: "412000000",
                description: "Evening consulting"
            })
            h.call("update#mantle.account.invoice.Invoice", {invoiceId, statusId: "InvoiceFinalized"})
            const paymentId = h.payment(f, "7", "receivable", {effectiveDate: ec.user.nowTimestamp})
            const applied = h.call(services + "apply#InvoicePayment", {paymentId, invoiceId})
            return {
                invoice: h.lib.one(h.lib.invoiceEntity, {invoiceId}),
                cash: sourcePosting(h, "paymentId", paymentId),
                application: h.lib.one(A, {paymentApplicationId: applied.paymentApplicationId}),
                posting: h.lib.one(T, {paymentApplicationId: applied.paymentApplicationId})
            }
        } finally {
            ec.user.setEffectiveTime(null)
            ec.user.setTimeZone(savedTimeZone)
        }
    },
    then({invoice, cash, application, posting}) {
        helper().lib.policy.calendarDateText(invoice.accountingDate) == "2026-10-30"
        helper().lib.policy.postingDay(cash) == "2026-10-30"
        toDecimal(application.amountApplied).eq(7)
        helper().lib.policy.bookDay(application.accountingDate, application.appliedDate) == "2026-10-30"
        posting.isPosted == "Y"
        invoice.statusId == "InvoicePmtRecvd"
    }
})
feature("an application between payments is not dated before either payment's posting", {
    when() {
        const h = helper(),
            receipt = h.payment(f, "5"),
            refund = h.payment(f, "5", "payable"),
            message = refusal(() =>
                h.call(services + "apply#PaymentToPayment", {
                    paymentId: refund,
                    toPaymentId: receipt,
                    appliedDate: Number(f.timestamp) - 2 * 86400000
                })
            )
        return {message, count: h.count(A, {paymentId: refund})}
    },
    then({message, count}) {
        message.includes("APPLICATION_BEFORE_SOURCE_POSTING")
        count == 0
    }
})
feature("a source posting and an application's own posting are not reversed until the application is unapplied", {
    when() {
        const h = helper(),
            invoiceId = h.invoice(f, "8"),
            paymentId = h.payment(f, "8"),
            applied = h.call(services + "apply#InvoicePayment", {paymentId, invoiceId}),
            invoicePosting = sourcePosting(h, "invoiceId", invoiceId),
            applicationPosting = h.lib.one(T, {paymentApplicationId: applied.paymentApplicationId})
        const reverse = acctgTransId => h.call("mantle.ledger.LedgerServices.post#ReverseAcctgTrans", {acctgTransId})
        const source = refusal(() => reverse(invoicePosting.acctgTransId)),
            own = refusal(() => reverse(applicationPosting.acctgTransId))
        h.call(services + "unapply#PaymentApplication", {paymentApplicationId: applied.paymentApplicationId})
        const reversal = reverse(invoicePosting.acctgTransId)
        return {
            source,
            own,
            reversal,
            applicationPosting: h.lib.one(T, {acctgTransId: applicationPosting.acctgTransId}),
            invoice: h.lib.one(h.lib.invoiceEntity, {invoiceId})
        }
    },
    then({source, own, reversal, applicationPosting, invoice}) {
        source.includes("SOURCE_HAS_APPLICATIONS")
        own.includes("SOURCE_HAS_APPLICATIONS")
        !!reversal.acctgTransId
        !!applicationPosting.reversedByAcctgTransId
        invoice.statusId == "InvoiceFinalized"
    }
})
feature("a source does not post after the day of an application that consumes it", {
    when() {
        const h = helper(),
            invoiceId = h.invoice(f, "6"),
            paymentId = h.payment(f, "6")
        h.call(services + "apply#InvoicePayment", {paymentId, invoiceId, appliedDate: f.timestamp, accountingDate: f.day})
        const cash = sourcePosting(h, "paymentId", paymentId)
        h.call("mantle.ledger.LedgerServices.unpost#AcctgTrans", {acctgTransId: cash.acctgTransId})
        h.call("update#" + T, {acctgTransId: cash.acctgTransId, transactionDate: Number(f.timestamp) + 2 * 86400000})
        const message = refusal(() => h.call("mantle.ledger.LedgerServices.post#AcctgTrans", {acctgTransId: cash.acctgTransId}))
        return {message, posting: h.lib.one(T, {acctgTransId: cash.acctgTransId})}
    },
    then({message, posting}) {
        message.includes("APPLICATION_BEFORE_SOURCE_POSTING")
        posting.isPosted == "N"
    }
})
feature("unapplying a directly posted payment with two applications reposts it unapplied, one application at a time", {
    when() {
        const h = helper(),
            invoiceId = h.invoice(f, "10"),
            direct = h.legacyDirectPayment(f, invoiceId, "10"),
            paymentId = direct.paymentId
        login(f.users.ar)
        const settled = h.confirm(
            h.review(f, [
                {sourceKey: h.key("payment", paymentId), targetKey: h.key("invoice", invoiceId), amount: "6"},
                {sourceKey: h.key("payment", paymentId), targetKey: h.key("invoice", invoiceId), amount: "4"}
            ])
        )
        login("john.doe")
        const directPosting = sourcePosting(h, "paymentId", paymentId) || h.lib.rows(T, {paymentId}).find(tx => tx.invoiceId)
        const [first, second] = settled.applicationIds
        h.call(services + "unapply#PaymentApplication", {paymentApplicationId: first})
        const between = h.lib.rows(T, {paymentId}).filter(tx => tx.isPosted === "Y" && !tx.reversedByAcctgTransId)
        h.call(services + "unapply#PaymentApplication", {paymentApplicationId: second})
        const active = h.lib
            .rows(T, {paymentId})
            .filter(tx => tx.isPosted === "Y" && !tx.reversedByAcctgTransId && !tx.reverseOfAcctgTransId)
        return {
            settled,
            directPosting,
            between,
            active,
            applications: [first, second].map(id => h.lib.one(A, {paymentApplicationId: id})),
            invoice: h.lib.one(h.lib.invoiceEntity, {invoiceId})
        }
    },
    then({settled, directPosting, between, active, applications, invoice}) {
        settled.allocationResults.every(row => row.reasonCode === "ALREADY_POSTED_DIRECT")
        directPosting.invoiceId != null
        helper().lib.one(T, {acctgTransId: directPosting.acctgTransId}) == null
        between.some(tx => tx.paymentApplicationId === applications[1].paymentApplicationId)
        applications.every(row => toDecimal(row.amountApplied).isZero())
        active.length == 1
        active[0].invoiceId == null
        active[0].paymentApplicationId == null
        invoice.statusId == "InvoiceFinalized"
    }
})
