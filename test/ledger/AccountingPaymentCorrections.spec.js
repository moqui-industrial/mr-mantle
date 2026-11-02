const helper = () => ec.resource.script("component://mr-mantle/test/account/AccountingPaymentLifecycleFixtures.js")
let f
spec({
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        f = helper().fixtures("ACCT_P5_CORR")
    },
    setup() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
    },
    cleanup() {
        login("john.doe")
    },
    cleanupSpec() {
        login("john.doe")
        if (f?.org) helper().settlement.base.cleanupLocks(f.org)
    }
})
function unapply(h, request, key) {
    const p = h.native("preview#PaymentUnapply", request)
    return h.native("unapply#ReviewedPayment", {previewId: p.previewId, inputFingerprint: p.inputFingerprint, operationKey: key})
}
feature("unapplying one of two receipts restores only its own original application and keeps the other receipt", {
    when() {
        const h = helper(),
            invoiceId = h.settlement.invoice(f, "100"),
            first = h.delivered(f, {amount: "60"}),
            second = h.delivered(f, {amount: "40"})
        h.apply(f, first, invoiceId, "60")
        h.apply(f, second, invoiceId, "40")
        const beforeCash = h.lib
                .rows("mantle.ledger.transaction.AcctgTrans", {paymentId: first})
                .find(row => row.acctgTransTypeEnumId === "AttIncomingPayment"),
            request = h.unapplyRequest(f, first)
        login(f.users.treasury)
        const denied = h.rejected("preview#PaymentUnapply", request)
        login("john.doe")
        const preview = h.native("preview#PaymentUnapply", request),
            result = h.native("unapply#ReviewedPayment", {
                previewId: preview.previewId,
                inputFingerprint: preview.inputFingerprint,
                operationKey: "corr-one-of-two"
            }),
            again = h.native("unapply#ReviewedPayment", {
                previewId: preview.previewId,
                inputFingerprint: preview.inputFingerprint,
                operationKey: "corr-one-of-two"
            })
        return {
            denied,
            result,
            again,
            first: h.detail(f, first),
            second: h.detail(f, second),
            invoice: h.lib.one(h.lib.invoiceEntity, {invoiceId}),
            cash: h.lib.one("mantle.ledger.transaction.AcctgTrans", {acctgTransId: beforeCash.acctgTransId})
        }
    },
    then({denied, result, again, first, second, invoice, cash}) {
        denied.includes("PERMISSION_DENIED")
        result.reversalAcctgTransIds.length == 1
        result.replacementAcctgTransIds.length == 0
        again.alreadyApplied == true
        toDecimal(first.totals.unappliedTotal).eq(60)
        toDecimal(second.totals.unappliedTotal).isZero()
        second.applicationRows.some(row => toDecimal(row.amountApplied).eq(40))
        invoice.statusId == "InvoiceFinalized"
        toDecimal(invoice.unpaidTotal).eq(60)
        cash.isPosted == "Y"
        cash.reversedByAcctgTransId == null
    }
})
feature("a selected ordinary application reverses exactly while another application on the same payment remains", {
    when() {
        const h = helper(),
            paymentId = h.delivered(f),
            a = h.settlement.invoice(f, "30"),
            b = h.settlement.invoice(f, "30")
        h.apply(f, paymentId, a, "30")
        h.apply(f, paymentId, b, "30")
        const application = h.detail(f, paymentId).applicationRows.find(row => row.invoiceId === a),
            result = unapply(h, h.unapplyRequest(f, paymentId, [application.paymentApplicationId]), "corr-selected-ordinary")
        return {
            result,
            view: h.detail(f, paymentId),
            a: h.lib.one(h.lib.invoiceEntity, {invoiceId: a}),
            b: h.lib.one(h.lib.invoiceEntity, {invoiceId: b})
        }
    },
    then({result, view, a, b}) {
        result.applicationResults.length == 1
        result.reversalAcctgTransIds.length == 1
        toDecimal(view.totals.unappliedTotal).eq(30)
        toDecimal(a.unpaidTotal).eq(30)
        toDecimal(b.unpaidTotal).isZero()
        b.statusId == "InvoicePmtRecvd"
    }
})
feature("void zeroes every application before exact application and cash reversals and retries once", {
    when() {
        const h = helper(),
            paymentId = h.delivered(f),
            a = h.settlement.invoice(f, "30"),
            b = h.settlement.invoice(f, "30")
        h.apply(f, paymentId, a, "30")
        h.apply(f, paymentId, b, "30")
        const reviewed = h.preview(f, paymentId, "void", {reason: "Duplicate receipt correction"}),
            result = h.confirm(reviewed, "corr-void-complete"),
            again = h.confirm(reviewed, "corr-void-complete")
        return {
            result,
            again,
            row: h.lib.one("mantle.account.payment.Payment", {paymentId}),
            applications: h.lib.rows("mantle.account.payment.PaymentApplication", {paymentId}),
            transactions: h.lib.rows("mantle.ledger.transaction.AcctgTrans", {paymentId}),
            a: h.lib.one(h.lib.invoiceEntity, {invoiceId: a}),
            b: h.lib.one(h.lib.invoiceEntity, {invoiceId: b})
        }
    },
    then({result, again, row, applications, transactions, a, b}) {
        row.statusId == "PmntVoid"
        result.reversalAcctgTransIds.length == 3
        result.replacementAcctgTransIds.length == 0
        transactions.length == 6
        transactions.every(tx => tx.isPosted === "Y")
        applications.every(ap => toDecimal(ap.amountApplied).isZero())
        toDecimal(a.unpaidTotal).eq(30)
        toDecimal(b.unpaidTotal).eq(30)
        again.alreadyApplied == true
    }
})
feature("a closed original fiscal period refuses application reversal with every original amount and posting intact", {
    when() {
        const h = helper(),
            paymentId = h.delivered(f),
            invoiceId = h.settlement.invoice(f, "60")
        h.apply(f, paymentId, invoiceId, "60")
        const request = h.unapplyRequest(f, paymentId),
            preview = h.native("preview#PaymentUnapply", request),
            before = h.count("mantle.ledger.transaction.AcctgTrans", {paymentId}),
            periods = Array.from(
                h.lib
                    .find("mantle.party.time.TimePeriod", {partyId: f.org})
                    .condition("fromDate", "less-equals", f.day)
                    .condition("thruDate", "greater-equals", f.day)
                    .list()
            ),
            states = periods.map(row => ({timePeriodId: row.timePeriodId, isClosed: row.isClosed}))
        if (!periods.length) throw new Error("The financial fixture requires an original fiscal period")
        let refusal
        try {
            for (const period of periods)
                h.call("update#mantle.party.time.TimePeriod", {timePeriodId: period.timePeriodId, isClosed: "Y"})
            refusal = h.rejected("unapply#ReviewedPayment", {
                previewId: preview.previewId,
                inputFingerprint: preview.inputFingerprint,
                operationKey: "corr-closed-original"
            })
        } finally {
            for (const state of states) h.call("update#mantle.party.time.TimePeriod", state)
        }
        return {
            refusal,
            before,
            after: h.count("mantle.ledger.transaction.AcctgTrans", {paymentId}),
            view: h.detail(f, paymentId)
        }
    },
    then({refusal, before, after, view}) {
        refusal.includes("PERIOD_CLOSED")
        after == before
        view.applicationRows.some(row => toDecimal(row.amountApplied).eq(60))
        view.payment.statusId == "PmntDelivered"
    }
})
feature("direct cash unapplication reposts the cash unapplied on its original day through revert#PaymentApplicationPost", {
    when() {
        const h = helper(),
            invoiceId = h.settlement.invoice(f, "10"),
            direct = h.settlement.legacyDirectPayment(f, invoiceId, "10")
        h.apply(f, direct.paymentId, invoiceId, "10")
        const before = h.lib.rows("mantle.ledger.transaction.AcctgTrans", {paymentId: direct.paymentId}),
            result = unapply(h, h.unapplyRequest(f, direct.paymentId), "corr-direct-whole"),
            replacement = h.lib.one("mantle.ledger.transaction.AcctgTrans", {acctgTransId: result.replacementAcctgTransIds[0]})
        return {
            before,
            result,
            replacement,
            after: h.detail(f, direct.paymentId),
            invoice: h.lib.one(h.lib.invoiceEntity, {invoiceId})
        }
    },
    then({before, result, replacement, after, invoice}) {
        before.length == 1
        result.originalAcctgTransIds.length == 1
        result.replacementAcctgTransIds.length == 1
        replacement.isPosted == "Y"
        replacement.invoiceId == null
        helper().lib.policy.postingDay(replacement) == helper().lib.policy.postingDay(before[0])
        toDecimal(after.totals.unappliedTotal).eq(10)
        toDecimal(invoice.unpaidTotal).eq(10)
        after.applicationRows.every(row => toDecimal(row.amountApplied).isZero())
    }
})
feature("an unreviewed ledger reversal is refused for the same treasury actor whose reviewed native void succeeds", {
    when() {
        const h = helper()
        login(f.users.treasury)
        const paymentId = h.delivered(f, {amount: "15"}),
            original = h.lib.rows("mantle.ledger.transaction.AcctgTrans", {paymentId})[0],
            denied = h.rejected("mantle.ledger.LedgerServices.post#ReverseAcctgTrans", {
                acctgTransId: original.acctgTransId,
                changeReason: "Unreviewed direct attempt"
            }),
            afterDenied = h.lib.rows("mantle.ledger.transaction.AcctgTrans", {paymentId}),
            originalAfterDenied = h.lib.one("mantle.ledger.transaction.AcctgTrans", {acctgTransId: original.acctgTransId}),
            result = h.confirm(h.preview(f, paymentId, "void", {reason: "Reviewed correction"}), "corr-native-versus-direct"),
            after = h.lib.rows("mantle.ledger.transaction.AcctgTrans", {paymentId})
        return {denied, afterDenied, originalAfterDenied, result, after}
    },
    then({denied, afterDenied, originalAfterDenied, result, after}) {
        denied.includes("REVIEW_REQUIRED")
        afterDenied.length == 1
        originalAfterDenied.isPosted == "Y"
        originalAfterDenied.reversedByAcctgTransId == null
        result.statusId == "PmntVoid"
        result.reversalAcctgTransIds.length == 1
        after.length == 2
        after.every(tx => tx.isPosted === "Y")
    }
})
feature("bank identity changes invalidate reviewed draft methods and retained delivery without changing money", {
    when() {
        const h = helper(),
            paymentId = h.draft(f),
            preview = h.preview(f, paymentId, "deliver"),
            request = h.request(f),
            bank = h.lib.one("mantle.account.method.BankAccount", {paymentMethodId: f.methodId}),
            old = bank.accountNumber
        let draftDenied, deliveryDenied
        try {
            h.call("update#mantle.account.method.BankAccount", {paymentMethodId: f.methodId, accountNumber: "999999999"})
            draftDenied = h.rejected("create#PaymentDraft", request)
            deliveryDenied = h.rejected("change#PaymentState", {
                previewId: preview.previewId,
                inputFingerprint: preview.inputFingerprint,
                operationKey: "corr-bank-changed"
            })
        } finally {
            h.call("update#mantle.account.method.BankAccount", {paymentMethodId: f.methodId, accountNumber: old})
        }
        return {
            draftDenied,
            deliveryDenied,
            count: h.count("mantle.ledger.transaction.AcctgTrans", {paymentId}),
            status: h.detail(f, paymentId).payment.statusId
        }
    },
    then({draftDenied, deliveryDenied, count, status}) {
        draftDenied.includes("STALE_PAYMENT_METHOD")
        deliveryDenied.includes("STALE_PREVIEW")
        count == 0
        status == "PmntProposed"
    }
})
feature("AP bill unapplication restores the approved status while preserving its original outgoing cash", {
    when() {
        const h = helper(),
            invoiceId = h.settlement.invoice(f, "25", "payable"),
            paymentId = h.delivered(f, {cashDirection: "outgoing", amount: "25"})
        h.apply(f, paymentId, invoiceId, "25", "payable")
        const result = unapply(h, h.unapplyRequest(f, paymentId), "corr-payable-unapply")
        return {result, invoice: h.lib.one(h.lib.invoiceEntity, {invoiceId}), view: h.detail(f, paymentId)}
    },
    then({result, invoice, view}) {
        invoice.statusId == "InvoiceApproved"
        toDecimal(invoice.unpaidTotal).eq(25)
        result.reversalAcctgTransIds.length == 1
        view.payment.cashDirection == "outgoing"
        toDecimal(view.totals.unappliedTotal).eq(25)
    }
})
feature("simultaneous exact void confirmations reverse each original once and replay the recorded IDs", {
    when() {
        const h = helper(),
            paymentId = h.delivered(f),
            invoiceId = h.settlement.invoice(f, "60")
        h.apply(f, paymentId, invoiceId, "60")
        const preview = h.preview(f, paymentId, "void"),
            args = {previewId: preview.previewId, inputFingerprint: preview.inputFingerprint, operationKey: "corr-void-parallel"},
            results = parallel(
                2,
                (thread, args) => {
                    login("john.doe")
                    ec.artifactExecution.disableAuthz()
                    return call("mantle.account.PaymentServices.change#PaymentState", args)
                },
                args,
                {transaction: false, timeout: 30}
            )
        return {
            results,
            row: h.lib.one("mantle.account.payment.Payment", {paymentId}),
            transactions: h.lib.rows("mantle.ledger.transaction.AcctgTrans", {paymentId})
        }
    },
    then({results, row, transactions}) {
        results.length == 2
        results.filter(result => result.alreadyApplied).length == 1
        results[0].reversalAcctgTransIds.join(",") == results[1].reversalAcctgTransIds.join(",")
        row.statusId == "PmntVoid"
        transactions.length == 4
        transactions.filter(tx => tx.reverseOfAcctgTransId).length == 2
        transactions.every(tx => tx.isPosted === "Y")
    }
})
