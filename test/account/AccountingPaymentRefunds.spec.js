// Manual refunds through Mantle's create#RefundPayment: get#PaymentRefundSummary, preview#PaymentRefund and
// refund#ReviewedPayment, the cumulative refund cap with pending refunds counted, and the funding application a
// completed refund keeps.
const helper = () => ec.resource.script("component://mr-mantle/test/account/AccountingPaymentLifecycleFixtures.js")
let f
spec({
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        f = helper().fixtures("ACCT_RFD")
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

// A delivered customer receipt of 60, posted through the payment lifecycle.
function receipt() {
    return helper().delivered(f, {paymentInstrumentEnumId: "PiOther"})
}
function review(paymentId, extra = {}) {
    return helper().native(
        "preview#PaymentRefund",
        Object.assign(
            {
                organizationPartyId: f.org,
                paymentId,
                amount: "20",
                effectiveDate: f.timestamp,
                reason: "Return unused cash",
                referenceNumber: "RFD-1"
            },
            extra
        )
    )
}
function confirm(preview, operationKey = helper().key("rfd-")) {
    return helper().native("refund#ReviewedPayment", {
        previewId: preview.previewId,
        inputFingerprint: preview.inputFingerprint,
        operationKey
    })
}
const payment = paymentId => helper().lib.one("mantle.account.payment.Payment", {paymentId})
const summary = paymentId => helper().native("get#PaymentRefundSummary", {organizationPartyId: f.org, paymentId})

feature("treasury refunds part of a receipt on its own book day; a retry with the same key answers the first result", {
    when() {
        const h = helper()
        login(f.users.treasury)
        const paymentId = receipt(),
            before = summary(paymentId),
            preview = review(paymentId),
            operationKey = h.key("rfd-first-"),
            first = confirm(preview, operationKey),
            retry = confirm(preview, operationKey),
            refund = payment(first.refundPaymentId),
            applications = h.lib.rows("mantle.account.payment.PaymentApplication", {
                paymentId: first.refundPaymentId,
                toPaymentId: paymentId
            }),
            reopened = h.native("get#PaymentRefundPreview", {organizationPartyId: f.org, previewId: preview.previewId})
        return {before, preview, first, retry, refund, applications, reopened, after: summary(paymentId)}
    },
    then({before, preview, first, retry, refund, applications, reopened, after}) {
        before.canRefund == true
        toDecimal(before.refundSummary.refundableAmount).eq(60)
        preview.canApply == true
        toDecimal(preview.amount).eq(20)
        preview.organizationMethod.paymentMethodId == f.methodId
        preview.organizationMethod.accountNumber == null
        first.statusId == "PmntDelivered"
        first.acctgTransIds.length > 0
        first.accountingDateText == f.day
        retry.alreadyApplied == true
        retry.refundPaymentId == first.refundPaymentId
        refund.paymentTypeEnumId == "PtRefund"
        refund.refundForPaymentId == first.paymentId
        refund.paymentMethodId == f.methodId
        refund.paymentRefNum == "RFD-1"
        refund.comments == "Return unused cash"
        ec.l10n.format(refund.effectiveDate, "yyyy-MM-dd") == f.day
        applications.length == 1 && toDecimal(applications[0].amountApplied).eq(20)
        reopened.status == "complete"
        reopened.results.refundPaymentId == first.refundPaymentId
        toDecimal(after.refundSummary.completedRefundAmount).eq(20)
        toDecimal(after.refundSummary.refundableAmount).eq(40)
    }
})

feature("the refund cap counts completed and pending refunds and keeps to the unapplied cash", {
    when() {
        const h = helper()
        login(f.users.treasury)
        const paymentId = receipt()
        confirm(review(paymentId, {amount: "15"}))
        // a pending refund, not yet applied, holds its amount
        h.native("create#RefundPayment", {paymentId, amount: "30", statusId: "PmntPromised"})
        const held = summary(paymentId).refundSummary,
            overPreview = h.rejected("preview#PaymentRefund", {
                organizationPartyId: f.org,
                paymentId,
                amount: "16",
                effectiveDate: f.timestamp,
                reason: "Over the cap"
            }),
            overCreate = h.rejected("create#RefundPayment", {paymentId, amount: "16", statusId: "PmntPromised"}),
            finer = h.rejected("preview#PaymentRefund", {
                organizationPartyId: f.org,
                paymentId,
                amount: "0.005",
                effectiveDate: f.timestamp,
                reason: "Finer than the currency"
            })
        return {held, overPreview, overCreate, finer}
    },
    then({held, overPreview, overCreate, finer}) {
        toDecimal(held.completedRefundAmount).eq(15)
        toDecimal(held.pendingRefundAmount).eq(30)
        toDecimal(held.unappliedTotal).eq(45)
        toDecimal(held.refundableAmount).eq(15)
        overPreview.includes("REFUND_AMOUNT_INVALID")
        overCreate.includes("greater than refundable amount")
        finer.includes("REFUND_AMOUNT_INVALID")
    }
})

feature("a review is stale after the refunds change, owned by its user, and refused to receivables users", {
    when() {
        const h = helper()
        login(f.users.treasury)
        const paymentId = receipt(),
            preview = review(paymentId)
        h.native("create#RefundPayment", {paymentId, amount: "5", statusId: "PmntPromised"})
        const stale = h.rejected("refund#ReviewedPayment", {
            previewId: preview.previewId,
            inputFingerprint: preview.inputFingerprint,
            operationKey: h.key("rfd-stale-")
        })
        const current = review(paymentId)
        login(f.users.ar)
        const arSummary = summary(paymentId),
            arPreview = h.rejected("preview#PaymentRefund", {
                organizationPartyId: f.org,
                paymentId,
                amount: "5",
                effectiveDate: f.timestamp,
                reason: "Not mine"
            }),
            arConfirm = h.rejected("refund#ReviewedPayment", {
                previewId: current.previewId,
                inputFingerprint: current.inputFingerprint,
                operationKey: h.key("rfd-ar-")
            })
        return {
            stale,
            arSummary,
            arPreview,
            arConfirm,
            refunds: h.count("mantle.account.payment.Payment", {refundForPaymentId: paymentId})
        }
    },
    then({stale, arSummary, arPreview, arConfirm, refunds}) {
        stale.includes("STALE_PREVIEW")
        arSummary.canRefund == false
        arSummary.reasonCode == "PERMISSION_DENIED"
        arPreview.includes("PERMISSION_DENIED")
        arConfirm.includes("REFUND_PREVIEW_UNAVAILABLE")
        refunds == 1
    }
})

feature("a completed refund keeps its application to the original until the refund itself is voided", {
    when() {
        const h = helper()
        login(f.users.treasury)
        const paymentId = receipt(),
            refunded = confirm(review(paymentId, {amount: "25"})),
            unapplyRefused = h.rejected("unapply#PaymentApplication", {paymentApplicationId: refunded.paymentApplicationId})
        login("john.doe")
        h.call("update#mantle.account.payment.Payment", {paymentId: refunded.refundPaymentId, statusId: "PmntVoid"})
        const application = h.lib.one("mantle.account.payment.PaymentApplication", {
            paymentApplicationId: refunded.paymentApplicationId
        })
        return {unapplyRefused, application, after: summary(paymentId).refundSummary}
    },
    then({unapplyRefused, application, after}) {
        unapplyRefused.includes("REFUND_FUNDING_IMMUTABLE")
        application == null || toDecimal(application.amountApplied ?? 0).eq(0)
        toDecimal(after.completedRefundAmount).eq(0)
        toDecimal(after.refundableAmount).eq(60)
    }
})
