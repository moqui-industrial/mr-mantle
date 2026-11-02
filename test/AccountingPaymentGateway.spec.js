// Reviewed gateway actions through Mantle's gateway services: get#PaymentGatewayActions, preview# and
// execute#PaymentGatewayAction over authorize#, capture#, release# and refund#SinglePayment with an operation key,
// lookup#PaymentGatewayDetails, and the gateway transaction reads. The test gateways are PaymentTestServices.
const helper = () => ec.resource.script("component://mr-mantle/test/AccountingPaymentLifecycleFixtures.js")
let f
const tests = "mantle.account.PaymentTestServices."
spec({
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        const h = helper()
        f = h.fixtures("ACCT_GW")
        // one test gateway per kind of answer: approve everything, leave capture and refund pending, decline refunds,
        // lose the authorization's answer
        f.gateways = {
            approve: "ACCT_GW_APPROVE",
            pending: "ACCT_GW_PENDING",
            decline: "ACCT_GW_DECLINE",
            unknown: "ACCT_GW_UNKNOWN"
        }
        for (const [kind, services] of Object.entries({
            approve: ["alwaysApprove", "alwaysApprove", "alwaysApprove", "alwaysApprove"],
            pending: ["alwaysApprove", "alwaysPending", "alwaysApprove", "alwaysPending"],
            decline: ["alwaysApprove", "alwaysApprove", "alwaysDecline", "alwaysDecline"],
            unknown: ["alwaysUnknown", "alwaysApprove", "alwaysApprove", "alwaysApprove"]
        }))
            h.call("create#mantle.account.method.PaymentGatewayConfig", {
                paymentGatewayConfigId: f.gateways[kind],
                paymentGatewayTypeEnumId: "PgtTest",
                description: "Test gateway " + kind,
                authorizeServiceName: tests + services[0] + "#PaymentAuthorization",
                captureServiceName: tests + services[1] + "#PaymentCapture",
                releaseServiceName: tests + services[2] + "#PaymentRelease",
                refundServiceName: tests + services[3] + "#PaymentRefund",
                detailsServiceName: tests + "alwaysApprove#PaymentDetails"
            })
        h.call("create#mantle.account.method.PaymentGatewayOrganization", {
            organizationPartyId: f.org,
            paymentGatewayConfigId: f.gateways.approve,
            fromDate: 0,
            isEnabled: "Y"
        })
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

// A promised customer payment through the organization's gateway of this kind.
function promised(kind, amount = "60") {
    return helper().native("create#Payment", {
        fromPartyId: f.customer,
        toPartyId: f.org,
        paymentTypeEnumId: "PtInvoicePayment",
        paymentInstrumentEnumId: "PiAch",
        paymentMethodId: f.customerMethodId,
        toPaymentMethodId: f.methodId,
        paymentGatewayConfigId: f.gateways[kind],
        amount,
        amountUomId: "USD",
        statusId: "PmntPromised",
        effectiveDate: f.timestamp
    }).paymentId
}
function review(paymentId, action, extra = {}) {
    return helper().native(
        "preview#PaymentGatewayAction",
        Object.assign({organizationPartyId: f.org, paymentId, action, reason: "Customer instruction"}, extra)
    )
}
function execute(preview, operationKey = helper().key("gw-")) {
    return helper().native("execute#PaymentGatewayAction", {
        previewId: preview.previewId,
        inputFingerprint: preview.inputFingerprint,
        operationKey
    })
}
function act(paymentId, action, extra = {}) {
    return execute(review(paymentId, action, extra))
}
const payment = paymentId => helper().lib.one("mantle.account.payment.Payment", {paymentId})
const actions = paymentId => helper().native("get#PaymentGatewayActions", {organizationPartyId: f.org, paymentId})
const summary = paymentId => helper().native("get#PaymentRefundSummary", {organizationPartyId: f.org, paymentId}).refundSummary

feature("treasury authorizes a reviewed payment once; a retry with the same key answers the first response", {
    when() {
        const h = helper()
        login(f.users.treasury)
        const paymentId = promised("approve"),
            before = actions(paymentId),
            preview = review(paymentId, "authorize"),
            operationKey = h.key("gw-auth-"),
            first = execute(preview, operationKey),
            retry = execute(preview, operationKey),
            otherKey = h.rejected("execute#PaymentGatewayAction", {
                previewId: preview.previewId,
                inputFingerprint: preview.inputFingerprint,
                operationKey: h.key("gw-other-")
            }),
            serviceRetry = h.native("authorize#SinglePayment", {paymentId, operationKey}),
            responses = h.count("mantle.account.method.PaymentGatewayResponse", {
                paymentId,
                paymentOperationEnumId: "PgoAuthorize"
            }),
            response = h.lib.one("mantle.account.method.PaymentGatewayResponse", {
                paymentGatewayResponseId: first.paymentGatewayResponseId
            })
        return {before, preview, first, retry, otherKey, serviceRetry, responses, response, after: payment(paymentId)}
    },
    then({before, preview, first, retry, otherKey, serviceRetry, responses, response, after}) {
        before.actionList.join() == "authorize"
        before.gatewayDescription == "Test gateway approve"
        preview.canApply == true
        toDecimal(preview.amount).eq(60)
        preview.afterStatusId == "PmntAuthorized"
        first.outcome == "accepted"
        first.statusId == "PmntAuthorized"
        retry.alreadyApplied == true
        retry.paymentGatewayResponseId == first.paymentGatewayResponseId
        otherKey.includes("GATEWAY_PREVIEW_CONSUMED")
        serviceRetry.paymentGatewayResponseId == first.paymentGatewayResponseId
        responses == 1
        response.operationKey == first.operationKey
        after.statusId == "PmntAuthorized"
    }
})

feature("capture delivers and posts the authorized payment; release is refused once it is captured", {
    when() {
        const h = helper()
        login(f.users.treasury)
        const paymentId = promised("approve")
        act(paymentId, "authorize")
        const listed = actions(paymentId).actionList,
            captured = act(paymentId, "capture"),
            posted = h.count("mantle.ledger.transaction.AcctgTrans", {paymentId, isPosted: "Y"}),
            releaseRefused = h.rejected("preview#PaymentGatewayAction", {
                organizationPartyId: f.org,
                paymentId,
                action: "release",
                reason: "Too late"
            })
        const released = promised("approve")
        act(released, "authorize")
        const release = act(released, "release")
        return {listed, captured, posted, releaseRefused, release, after: payment(paymentId), releasedAfter: payment(released)}
    },
    then({listed, captured, posted, releaseRefused, release, after, releasedAfter}) {
        listed.includes("capture") && listed.includes("release") && listed.includes("lookup")
        captured.outcome == "accepted"
        after.statusId == "PmntDelivered"
        posted == 1
        releaseRefused.includes("GATEWAY_ACTION_UNAVAILABLE")
        release.outcome == "accepted"
        releasedAfter.statusId == "PmntPromised"
    }
})

feature("a gateway refund delivers a refund payment applied to the original, within what is left to refund", {
    when() {
        const h = helper()
        login(f.users.treasury)
        const paymentId = promised("approve")
        act(paymentId, "authorize")
        act(paymentId, "capture")
        const preview = review(paymentId, "refund", {amount: "25"}),
            refunded = execute(preview),
            refund = payment(refunded.refundPaymentId),
            response = h.lib.one("mantle.account.method.PaymentGatewayResponse", {
                paymentGatewayResponseId: refunded.paymentGatewayResponseId
            }),
            applied = h.lib.rows("mantle.account.payment.PaymentApplication", {
                paymentId: refunded.refundPaymentId,
                toPaymentId: paymentId
            }),
            tooMuch = h.rejected("preview#PaymentGatewayAction", {
                organizationPartyId: f.org,
                paymentId,
                action: "refund",
                amount: "40",
                reason: "Over the limit"
            }),
            finer = h.rejected("preview#PaymentGatewayAction", {
                organizationPartyId: f.org,
                paymentId,
                action: "refund",
                amount: "1.005",
                reason: "Finer than the currency"
            })
        return {preview, refunded, refund, response, applied, tooMuch, finer, left: summary(paymentId)}
    },
    then({preview, refunded, refund, response, applied, tooMuch, finer, left}) {
        toDecimal(preview.refundSummary.refundableAmount).eq(60)
        refunded.outcome == "accepted"
        refunded.statusId == "PmntDelivered"
        refund.statusId == "PmntDelivered"
        refund.refundForPaymentId == refunded.paymentId
        toDecimal(refund.amount).eq(25)
        response.refundPaymentId == refunded.refundPaymentId
        applied.length == 1 && toDecimal(applied[0].amountApplied).eq(25)
        toDecimal(left.completedRefundAmount).eq(25)
        toDecimal(left.refundableAmount).eq(35)
        tooMuch.includes("GATEWAY_AMOUNT_INVALID")
        finer.includes("GATEWAY_AMOUNT_INVALID")
    }
})

feature("pending answers leave the payment and the refund as they were until a lookup resolves them", {
    when() {
        const h = helper()
        login(f.users.treasury)
        const paymentId = promised("pending")
        act(paymentId, "authorize")
        const pendingCapture = act(paymentId, "capture"),
            whilePending = payment(paymentId).statusId,
            lookedUp = h.native("lookup#PaymentGatewayDetails", {organizationPartyId: f.org, paymentId}),
            pendingRefund = act(paymentId, "refund", {amount: "10"}),
            refundWhilePending = payment(pendingRefund.refundPaymentId),
            heldBack = summary(paymentId),
            refundLookup = h.native("lookup#PaymentGatewayDetails", {
                organizationPartyId: f.org,
                paymentId: pendingRefund.refundPaymentId
            }),
            applied = h.lib.rows("mantle.account.payment.PaymentApplication", {
                paymentId: pendingRefund.refundPaymentId,
                toPaymentId: paymentId
            })
        return {pendingCapture, whilePending, lookedUp, pendingRefund, refundWhilePending, heldBack, refundLookup, applied}
    },
    then({pendingCapture, whilePending, lookedUp, pendingRefund, refundWhilePending, heldBack, refundLookup, applied}) {
        pendingCapture.outcome == "pending"
        whilePending == "PmntAuthorized"
        lookedUp.previousStatusId == "PmntAuthorized"
        lookedUp.statusId == "PmntDelivered"
        pendingRefund.outcome == "pending"
        refundWhilePending.statusId == "PmntPromised"
        refundWhilePending.paymentRefNum == "TEST-PENDING"
        toDecimal(heldBack.pendingRefundAmount).eq(10)
        toDecimal(heldBack.refundableAmount).eq(50)
        refundLookup.statusId == "PmntDelivered"
        applied.length == 1 && toDecimal(applied[0].amountApplied).eq(10)
    }
})

feature("a lost answer is unknown: only a lookup is offered until it resolves the payment", {
    when() {
        const h = helper()
        login(f.users.treasury)
        const paymentId = promised("unknown"),
            lost = act(paymentId, "authorize"),
            whileUnknown = actions(paymentId),
            refused = h.rejected("preview#PaymentGatewayAction", {
                organizationPartyId: f.org,
                paymentId,
                action: "authorize",
                reason: "Try again"
            }),
            listed = h.native("find#PaymentGatewayTransactions", {organizationPartyId: f.org, paymentId, outcome: "unknown"}),
            lookedUp = h.native("lookup#PaymentGatewayDetails", {organizationPartyId: f.org, paymentId}),
            afterLookup = actions(paymentId)
        return {lost, whileUnknown, refused, listed, lookedUp, afterLookup}
    },
    then({lost, whileUnknown, refused, listed, lookedUp, afterLookup}) {
        lost.outcome == "unknown"
        lost.reasonCode == "GATEWAY_UNKNOWN"
        lost.statusId == "PmntPromised"
        whileUnknown.outcomeUnknown == true
        whileUnknown.actionList.join() == "lookup"
        whileUnknown.reasonCode == "GATEWAY_OUTCOME_UNKNOWN"
        refused.includes("GATEWAY_ACTION_UNAVAILABLE")
        listed.rows.length == 1 && listed.rows[0].outcome == "unknown" && listed.rows[0].idempotencyKey.length == 32
        lookedUp.previousStatusId == "PmntPromised"
        lookedUp.statusId == "PmntAuthorized"
        afterLookup.outcomeUnknown == false
        afterLookup.actionList.includes("capture")
    }
})

feature("a declined gateway refund declines its refund payment and frees what it held", {
    when() {
        login(f.users.treasury)
        const paymentId = promised("decline")
        act(paymentId, "authorize")
        act(paymentId, "capture")
        const declined = act(paymentId, "refund", {amount: "15"})
        return {declined, refund: payment(declined.refundPaymentId), left: summary(paymentId)}
    },
    then({declined, refund, left}) {
        declined.outcome == "declined"
        declined.refundStatusId == "PmntDeclined"
        refund.statusId == "PmntDeclined"
        toDecimal(left.pendingRefundAmount).eq(0)
        toDecimal(left.refundableAmount).eq(60)
    }
})

feature("a receivables user reads the payment but neither reviews gateway actions nor reads gateway records", {
    when() {
        const h = helper()
        login(f.users.treasury)
        const paymentId = promised("approve"),
            preview = review(paymentId, "authorize")
        login(f.users.ar)
        const seen = actions(paymentId),
            previewRefused = h.rejected("preview#PaymentGatewayAction", {
                organizationPartyId: f.org,
                paymentId,
                action: "authorize",
                reason: "Not mine"
            }),
            confirmRefused = h.rejected("execute#PaymentGatewayAction", {
                previewId: preview.previewId,
                inputFingerprint: preview.inputFingerprint,
                operationKey: h.key("gw-ar-")
            }),
            listRefused = h.rejected("find#PaymentGatewayTransactions", {organizationPartyId: f.org})
        return {seen, previewRefused, confirmRefused, listRefused, after: payment(paymentId)}
    },
    then({seen, previewRefused, confirmRefused, listRefused, after}) {
        seen.actionList.length == 0
        seen.reasonCode == "PERMISSION_DENIED"
        previewRefused.includes("GATEWAY_ACTION_UNAVAILABLE")
        confirmRefused.includes("GATEWAY_PREVIEW_UNAVAILABLE")
        listRefused != ""
        after.statusId == "PmntPromised"
    }
})

feature("gateway transactions list the organization's responses by payment, action and outcome", {
    when() {
        const h = helper()
        login(f.users.treasury)
        const paymentId = promised("pending")
        act(paymentId, "authorize")
        act(paymentId, "capture")
        const all = h.native("find#PaymentGatewayTransactions", {organizationPartyId: f.org, paymentId}),
            pending = h.native("find#PaymentGatewayTransactions", {organizationPartyId: f.org, paymentId, outcome: "pending"}),
            captures = h.native("find#PaymentGatewayTransactions", {organizationPartyId: f.org, action: "capture"}),
            paged = h.native("find#PaymentGatewayTransactions", {organizationPartyId: f.org, pageSize: 2}),
            providers = h.native("find#PaymentGatewayProviders", {
                organizationPartyId: f.org,
                selectedIdList: [f.gateways.pending]
            })
        return {all, pending, captures, paged, providers}
    },
    then({all, pending, captures, paged, providers}) {
        all.rows.every(row => row.paymentId == all.rows[0].paymentId)
        all.rows.some(row => row.action == "authorize" && row.outcome == "accepted")
        pending.rows.length == 1 && pending.rows[0].action == "capture"
        captures.rows.every(row => row.paymentOperationEnumId == "PgoCapture")
        paged.rows.length == 2 && paged.recordCount > 2 && paged.pageMaxIndex > 0
        providers.rows.map(row => row.paymentGatewayConfigId).join() == f.gateways.approve
        providers.selectedRows[0].description == "Test gateway pending"
    }
})
