// An internal transfer is one PtInternalTransfer payment that post#Payment posts on both sides through transit; a fee is
// its own disbursement. Both sides post or neither does.
const helper = () => ec.resource.script("component://mr-mantle/test/account/AccountingInternalTransferFixtures.js")
let f
spec({
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        f = helper().fixtures("ACCT_P5_XFER")
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
        if (f?.org) helper().lifecycle.settlement.base.cleanupLocks(f.org)
    }
})
feature("a transfer with a fee is one payment posted on both sides through transit and a fee disbursement to its account", {
    when() {
        const h = helper(),
            review = h.preview(f, {feeAmount: "2", feeGlAccountId: f.feeAccountId}),
            result = h.confirm(review, "xfer-fifty-fee-two"),
            again = h.confirm(review, "xfer-fifty-fee-two"),
            other = h.preview(f, {amount: "25"}),
            reused = h.lifecycle.rejected("create#InternalTransfer", {
                previewId: other.previewId,
                inputFingerprint: other.inputFingerprint,
                operationKey: "xfer-fifty-fee-two"
            })
        return {
            review,
            result,
            again,
            reused,
            retained: h.native("get#InternalTransferPreview", {previewId: review.previewId}),
            payment: h.lib.one("mantle.account.payment.Payment", {paymentId: result.paymentId}),
            fee: h.lib.one("mantle.account.payment.Payment", {paymentId: result.feePaymentId}),
            entries: h.entries(result.paymentId),
            feeEntries: h.entries(result.feePaymentId),
            detail: h.lifecycle.detail(f, result.paymentId),
            output: h.native("get#PaymentOutput", {
                organizationPartyId: f.org,
                paymentId: result.paymentId,
                outputId: result.outputRows[0].outputId
            }),
            transfers: h.native("find#Payments", {organizationPartyId: f.org, queue: "transfers", pageSize: 100}),
            unapplied: h.native("find#Payments", {organizationPartyId: f.org, queue: "unapplied", pageSize: 100})
        }
    },
    then({review, result, again, reused, retained, payment, fee, entries, feeEntries, detail, output, transfers, unapplied}) {
        review.previewKind == "transfer"
        review.ledgerPreview.length == 3
        review.feeAccountLabel.includes(f.feeAccountId)
        review.feePartyId == f.bankPartyId
        review.totalAmount == "52"
        result.reasonCode == "INTERNAL_TRANSFER_COMPLETED"
        result.acctgTransIds.length == 3
        result.legRows.map(row => row.leg + ":" + row.paymentId).join() ==
            "transfer:" + result.paymentId + ",fee:" + result.feePaymentId
        // the transfer: one delivered payment from the organization to itself, between its two methods
        payment.paymentTypeEnumId == "PtInternalTransfer"
        payment.statusId == "PmntDelivered"
        payment.fromPartyId == f.org && payment.toPartyId == f.org
        payment.paymentMethodId == f.methodId && payment.toPaymentMethodId == f.toMethodId
        toDecimal(payment.amount).eq(50)
        entries.length == 4 && entries.every(row => row.isPosted === "Y")
        entries.some(row => row.acctgTransTypeEnumId === "AttOutgoingPayment" && row.glAccountId === "111100000" &&
            row.debitCreditFlag === "C" && toDecimal(row.amount).eq(50))
        entries.some(row => row.acctgTransTypeEnumId === "AttIncomingPayment" && row.glAccountId === f.toCashAccountId &&
            row.debitCreditFlag === "D" && toDecimal(row.amount).eq(50))
        entries.filter(row => row.glAccountId === "258300000").map(row => row.debitCreditFlag).sort().join() == "C,D"
        // the fee: a disbursement to the bank, from the from method's cash to the fee account
        fee.paymentTypeEnumId == "PtDisbursement"
        fee.toPartyId == f.bankPartyId && fee.paymentMethodId == f.methodId
        feeEntries.length == 2 && feeEntries.every(row => row.isPosted === "Y")
        feeEntries.some(row => row.glAccountId === f.feeAccountId && row.debitCreditFlag === "D" && toDecimal(row.amount).eq(2))
        feeEntries.some(row => row.glAccountId === "111100000" && row.debitCreditFlag === "C" && toDecimal(row.amount).eq(2))
        // retry with the same key returns the first result; the key cannot confirm another review
        again.alreadyApplied == true && again.paymentId == result.paymentId
        reused.includes("OPERATION_KEY_CONFLICT")
        retained.status == "complete" && retained.results.paymentId == result.paymentId
        detail.payment.cashDirection == "transfer"
        detail.payment.financeDirection == "transfer"
        detail.transferSummary.paymentId == result.paymentId
        detail.transferLegRows.map(row => row.leg).join() == "outgoing,incoming"
        toDecimal(detail.totals.unappliedTotal).isZero()
        result.outputRows.length == 1 && result.outputRows[0].outputType == "detail"
        output.documentHtml.includes("Internal transfer")
        transfers.rows.some(row => row.paymentId === result.paymentId)
        unapplied.rows.every(row => row.paymentId !== result.paymentId)
    }
})
// post#Payment posts the outgoing side first, so the incoming side's account refusing posting fails after it.
feature("a posting failure on the incoming side rolls back the whole transfer, and the same key then succeeds", {
    when() {
        const h = helper(),
            review = h.preview(f, {feeAmount: "1", feeGlAccountId: f.feeAccountId}),
            before = h.counts(f)
        let failure
        h.call("update#mantle.ledger.account.GlAccount", {glAccountId: f.toCashAccountId, disallowPosting: "Y"})
        try {
            failure = h.lifecycle.rejected("create#InternalTransfer", {
                previewId: review.previewId,
                inputFingerprint: review.inputFingerprint,
                operationKey: "xfer-atomic"
            })
        } finally {
            h.call("update#mantle.ledger.account.GlAccount", {glAccountId: f.toCashAccountId, disallowPosting: "N"})
        }
        const after = h.counts(f),
            retained = h.native("get#InternalTransferPreview", {previewId: review.previewId})
        return {failure, before, after, retained, success: h.confirm(review, "xfer-atomic"), done: h.counts(f)}
    },
    then({failure, before, after, retained, success, done}) {
        failure.includes("ENTRY_INVALID") || failure.includes("TRANSFER_NOT_POSTED")
        JSON.stringify(after) == JSON.stringify(before)
        retained.status == "review"
        retained.operationKey == null
        success.reasonCode == "INTERNAL_TRANSFER_COMPLETED"
        done.transfers == before.transfers + 1
        done.disbursements == before.disbursements + 1
        done.transactions == before.transactions + 3
    }
})
feature("invalid transfers and users without payment edit are refused without any record", {
    when() {
        const h = helper(),
            before = h.counts(f),
            errors = [],
            mapping = {organizationPartyId: f.org, paymentTypeEnumId: "PtInternalTransfer", isPayable: "Y", isApplied: "N"},
            saved = h.lib.one("mantle.ledger.config.PaymentTypeGlAccount", mapping),
            workflow = ec.resource.script("component://mr-mantle/service/mantle/account/PaymentWorkflow.js"),
            foreign = h.lib.one("mantle.account.method.PaymentMethod", {paymentMethodId: f.customerMethodId}),
            refuse = (expected, extra) =>
                errors.push({expected, error: h.lifecycle.rejected("preview#InternalTransfer", h.request(f, extra))})
        for (const [expected, extra] of [
            ["AMOUNT_INVALID", {amount: "0"}],
            ["CURRENCY_PRECISION", {amount: "1.001"}],
            ["TRANSFER_FEE_INVALID", {feeAmount: "-1"}],
            ["CURRENCY_PRECISION", {feeAmount: "0.001"}],
            ["TRANSFER_FEE_ACCOUNT_REQUIRED", {feeAmount: "2"}],
            ["TRANSFER_FEE_ACCOUNT_REQUIRED", {feeAmount: "2", feeGlAccountId: "111100000"}],
            ["TRANSFER_FEE_ACCOUNT_REQUIRED", {feeAmount: "2", feeGlAccountId: "412000000"}],
            ["CURRENCY_MISMATCH", {currencyUomId: "EUR"}],
            ["TRANSFER_METHODS_DISTINCT", {toPaymentMethodId: f.methodId}],
            ["STALE_PAYMENT_METHOD", {fromMethodVersion: "changed"}],
            [
                "PAYMENT_METHOD_UNAVAILABLE",
                {fromPaymentMethodId: f.customerMethodId, fromMethodVersion: workflow.methodVersion(foreign)}
            ],
            // the destination bank has no bank party to pay a fee to
            [
                "TRANSFER_FEE_PARTY_REQUIRED",
                {
                    fromPaymentMethodId: f.toMethodId,
                    fromMethodVersion: null,
                    toPaymentMethodId: f.methodId,
                    toMethodVersion: null,
                    feeAmount: "2",
                    feeGlAccountId: f.feeAccountId
                }
            ],
            ["PAYMENT_EVIDENCE_REQUIRED", {reason: " "}]
        ])
            refuse(expected, extra)
        for (const [expected, glAccountId] of [
            ["TRANSFER_TRANSIT_REQUIRED", null],
            ["TRANSFER_TRANSIT_MISMATCH", "111100000"]
        ]) {
            const update = id => h.call("update#mantle.ledger.config.PaymentTypeGlAccount", {...mapping, glAccountId: id})
            update(glAccountId)
            try {
                refuse(expected, {})
            } finally {
                update(saved.glAccountId)
            }
        }
        for (const user of [f.users.ar, f.users.paymentView]) {
            login(user)
            refuse("PERMISSION_DENIED", {})
            errors.push({
                expected: "PERMISSION_DENIED",
                error: h.lifecycle.rejected("find#InternalTransferMethods", {organizationPartyId: f.org})
            })
        }
        login("john.doe")
        return {errors, before, after: h.counts(f)}
    },
    then({errors, before, after}) {
        errors.length == 19
        errors.filter(row => !row.error.includes(row.expected)).map(row => row.expected + ": " + row.error).join("; ") == ""
        JSON.stringify(after) == JSON.stringify(before)
    }
})
feature("method and fee account searches page after filtering; a user without ledger read sees no postings", {
    when() {
        const h = helper(),
            methods = h.native("find#InternalTransferMethods", {
                organizationPartyId: f.org,
                currencyUomId: "USD",
                effectiveDate: f.timestamp,
                text: "oPeRaTiNg",
                selectedIdList: [f.toMethodId],
                pageSize: 1
            }),
            fees = h.native("find#InternalTransferFeeAccounts", {
                organizationPartyId: f.org,
                effectiveDate: f.timestamp,
                text: "no-such-fee-account",
                selectedIdList: [f.feeAccountId, "412000000"],
                pageSize: 1
            }),
            charges = h.native("find#InternalTransferFeeAccounts", {
                organizationPartyId: f.org,
                effectiveDate: f.timestamp,
                text: "service charges",
                pageSize: 1
            })
        login(f.users.transfer)
        const review = h.preview(f),
            result = h.confirm(review),
            retained = h.native("get#InternalTransferPreview", {previewId: review.previewId}),
            payments = h.native("find#Payments", {organizationPartyId: f.org})
        login("john.doe")
        return {methods, fees, charges, review, result, retained, payments}
    },
    then({methods, fees, charges, review, result, retained, payments}) {
        methods.recordCount == 1
        methods.rows[0].paymentMethodId == f.methodId
        Boolean(methods.rows[0].version)
        methods.rows[0].accountNumber == null
        methods.selectedRows.map(row => row.paymentMethodId).join() == f.toMethodId
        fees.recordCount == 0
        fees.selectedRows.map(row => row.glAccountId).join() == f.feeAccountId
        fees.selectedRows[0].postedBalance == null
        charges.recordCount >= 1 && charges.rows.length == 1
        review.canApply == true
        review.ledgerPreview == null
        result.reasonCode == "INTERNAL_TRANSFER_COMPLETED"
        retained.results.acctgTransIds == null
        payments.capabilities.canTransfer == true
    }
})
