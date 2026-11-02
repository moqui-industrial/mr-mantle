// The common gateway contracts the provider adapters build on (plan/payments-shipping-edi.md, Phase 0): each gateway
// call gets an idempotency key bound to the payment, gateway, operation and amount, and an operation key replays its
// response and refuses other input; a lost answer is an unknown outcome that blocks a new charge or refund until a
// details lookup by the key resolves it; the HTTP fixtures answer an adapter's outbound calls without the network; and a
// provider callback is kept once per remote and event id. The payment gateways are PaymentTestServices. New spec, no
// Groovy original.
const vendorId = "ORG_ZIZI_RETAIL"
const tests = "mantle.account.PaymentTestServices."
const P = "mantle.account.PaymentServices."
let customerId, cardId

spec({
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        // each gateway answers one way: a lost authorization or refund, and a details lookup that finds it or nothing
        for (const [id, auth, refund, details] of [
            ["GWC_UNKNOWN", "alwaysUnknown", "alwaysApprove", "alwaysApprove"],
            ["GWC_NOTFOUND", "alwaysUnknown", "alwaysApprove", "notFound"],
            ["GWC_REFUND_LOST", "alwaysApprove", "alwaysUnknown", "alwaysApprove"]
        ])
            call("create#mantle.account.method.PaymentGatewayConfig", {
                paymentGatewayConfigId: id,
                paymentGatewayTypeEnumId: "PgtTest",
                description: "Gateway contract " + id,
                authorizeServiceName: tests + auth + "#PaymentAuthorization",
                captureServiceName: tests + "alwaysApprove#PaymentCapture",
                releaseServiceName: tests + "alwaysApprove#PaymentRelease",
                refundServiceName: tests + refund + "#PaymentRefund",
                detailsServiceName: tests + details + "#PaymentDetails"
            })
        call("create#moqui.service.message.SystemMessageType", {
            systemMessageTypeId: "GWC_WEBHOOK",
            description: "Gateway contract webhook"
        })
        for (const remoteId of ["GWC_REMOTE", "GWC_REMOTE_2"])
            call("create#moqui.service.message.SystemMessageRemote", {
                systemMessageRemoteId: remoteId,
                description: "Gateway contract provider " + remoteId,
                systemMessageTypeId: "GWC_WEBHOOK",
                usageCode: "T"
            })
        customerId = call("mantle.party.PartyServices.create#Person", {
            firstName: "Gina",
            lastName: "Contract",
            roleTypeId: "Customer"
        }).partyId
        cardId = call("mantle.account.PaymentMethodServices.store#PaymentMethodInfo", {
            partyId: customerId,
            paymentMethodTypeEnumId: "PmtCreditCard",
            creditCardTypeEnumId: "CctVisa",
            cardNumber: "4111111111111111",
            expireMonth: "12",
            expireYear: String(new Date().getFullYear() + 3),
            firstNameOnAccount: "Gina",
            lastNameOnAccount: "Contract",
            address1: "1 Contract St",
            city: "Orem",
            stateProvinceGeoId: "USA_UT",
            postalCode: "84057",
            countryGeoId: "USA"
        }).paymentMethodId
        ec.artifactExecution.enableAuthz()
    },
    setup() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
    },
    cleanup() {
        ec.message.clearErrors()
        ec.artifactExecution.enableAuthz()
    },
    cleanupSpec() {
        ec.factory.getTool("HttpFixtures").reset()
    }
})

const payment = paymentId => ec.entity.find("mantle.account.payment.Payment").condition("paymentId", paymentId).one()
const response = id =>
    ec.entity.find("mantle.account.method.PaymentGatewayResponse").condition("paymentGatewayResponseId", id).one()
const responses = (paymentId, paymentOperationEnumId) =>
    Array.from(
        ec.entity
            .find("mantle.account.method.PaymentGatewayResponse")
            .condition({paymentId, paymentOperationEnumId})
            .orderBy("paymentGatewayResponseId")
            .list()
    )
function cardPayment(amount) {
    return call(P + "create#Payment", {
        fromPartyId: customerId,
        toPartyId: vendorId,
        amount,
        amountUomId: "USD",
        paymentMethodId: cardId,
        paymentInstrumentEnumId: "PiCreditCard",
        statusId: "PmntPromised"
    }).paymentId
}
// a call's error text ("" when it succeeds), in its own transaction so a refusal rolls back only itself
function refusal(service, parameters) {
    ec.message.pushErrors()
    try {
        ec.service.sync().name(service).parameters(parameters).requireNewTransaction(true).call()
        return ec.message.hasError() ? ec.message.getErrorsString() : ""
    } catch (error) {
        return String(error.message || error)
    } finally {
        ec.message.clearErrors()
        ec.message.popErrors()
    }
}

feature("each gateway call gets an idempotency key bound to its operation; a key replays its response and refuses other input", {
    when() {
        const paymentId = cardPayment(50)
        const auth = call(P + "authorize#SinglePayment", {
            paymentId,
            paymentGatewayConfigId: "TEST_APPROVE",
            operationKey: "gwc-auth-1"
        })
        const expected = call(P + "make#GatewayIdempotencyKey", {
            payment: payment(paymentId),
            paymentGatewayConfigId: "TEST_APPROVE",
            operation: "authorize",
            amount: 50,
            operationKey: "gwc-auth-1"
        }).idempotencyKey
        const replay = call(P + "authorize#SinglePayment", {
            paymentId,
            paymentGatewayConfigId: "TEST_APPROVE",
            operationKey: "gwc-auth-1"
        })
        const authCount = responses(paymentId, "PgoAuthorize").length
        const otherOperation = refusal(P + "capture#SinglePayment", {paymentId, operationKey: "gwc-auth-1"})
        const capture = call(P + "capture#SinglePayment", {paymentId, amount: 50, operationKey: "gwc-cap-1"})
        const otherAmount = refusal(P + "capture#SinglePayment", {paymentId, amount: 30, operationKey: "gwc-cap-1"})
        // without an operation key each call is its own operation, with a key of its own
        const unkeyedId = cardPayment(20)
        const first = call(P + "authorize#SinglePayment", {paymentId: unkeyedId, paymentGatewayConfigId: "TEST_APPROVE"})
        const second = call(P + "authorize#SinglePayment", {paymentId: unkeyedId, paymentGatewayConfigId: "TEST_APPROVE"})
        return {
            auth: response(auth.paymentGatewayResponseId),
            expected,
            replay,
            authCount,
            otherOperation,
            capture: response(capture.paymentGatewayResponseId),
            otherAmount,
            after: payment(paymentId),
            firstKey: response(first.paymentGatewayResponseId).idempotencyKey,
            secondKey: response(second.paymentGatewayResponseId).idempotencyKey
        }
    },
    then({auth, expected, replay, authCount, otherOperation, capture, otherAmount, after, firstKey, secondKey}) {
        // the adapter received the key and recorded it, and the operation key is attached
        auth.idempotencyKey == expected
        expected.length == 32
        expected.startsWith("mq")
        auth.operationKey == "gwc-auth-1"
        replay.paymentGatewayResponseId == auth.paymentGatewayResponseId
        authCount == 1
        otherOperation.includes("OPERATION_KEY_CONFLICT")
        capture.idempotencyKey != auth.idempotencyKey
        capture.operationKey == "gwc-cap-1"
        otherAmount.includes("OPERATION_KEY_CONFLICT")
        after.statusId == "PmntDelivered"
        firstKey.length == 32
        firstKey != secondKey
    }
})

feature("a lost authorization answer is unknown: no new charge is sent until the lookup finds it approved", {
    when() {
        const paymentId = cardPayment(40)
        const params = {paymentId, paymentGatewayConfigId: "GWC_UNKNOWN", operationKey: "gwc-u-1"}
        const first = call(P + "authorize#SinglePayment", params)
        const whileUnknown = payment(paymentId)
        const sameKey = call(P + "authorize#SinglePayment", params)
        // a new charge is not sent: answered without an error, so a caller going through many payments goes on
        const otherKey = call(P + "authorize#SinglePayment", Object.assign({}, params, {operationKey: "gwc-u-2"}))
        const unkeyed = call(P + "authorize#SinglePayment", {paymentId, paymentGatewayConfigId: "GWC_UNKNOWN"})
        const sent = responses(paymentId, "PgoAuthorize").length
        call(P + "get#SinglePaymentGatewayDetails", {paymentId})
        const found = payment(paymentId)
        const capture = call(P + "capture#SinglePayment", {paymentId, operationKey: "gwc-u-cap"})
        return {
            first: response(first.paymentGatewayResponseId),
            whileUnknown,
            sameKey,
            otherKey,
            unkeyed,
            sent,
            found,
            resolved: response(first.paymentGatewayResponseId),
            captured: response(capture.paymentGatewayResponseId),
            after: payment(paymentId)
        }
    },
    then({first, whileUnknown, sameKey, otherKey, unkeyed, sent, found, resolved, captured, after}) {
        first.resultUnknown == "Y"
        first.resultSuccess == "N" && first.resultDeclined == "N" && first.resultError == "N"
        first.referenceNum == null
        first.idempotencyKey.length == 32
        whileUnknown.statusId == "PmntPromised"
        sameKey.paymentGatewayResponseId == first.paymentGatewayResponseId
        otherKey.reasonCode == "GATEWAY_OUTCOME_UNKNOWN" && otherKey.paymentGatewayResponseId == null
        unkeyed.reasonCode == "GATEWAY_OUTCOME_UNKNOWN"
        sent == 1
        // the lookup by the key found it approved, with the reference it got
        found.statusId == "PmntAuthorized"
        found.paymentRefNum == "TEST-" + first.idempotencyKey.slice(0, 12)
        found.paymentAuthCode == "TESTFOUND"
        resolved.outcomeResolvedDate != null
        resolved.outcomeFound == "Y"
        captured.resultSuccess == "Y"
        after.statusId == "PmntDelivered"
    }
})

feature("a lost answer the gateway never acted on resolves to the status the payment had, and it can be sent again", {
    when() {
        const paymentId = cardPayment(30)
        const first = call(P + "authorize#SinglePayment", {
            paymentId,
            paymentGatewayConfigId: "GWC_NOTFOUND",
            operationKey: "gwc-nf-1"
        })
        call(P + "get#SinglePaymentGatewayDetails", {paymentId})
        const afterLookup = payment(paymentId)
        // the same key again: not a replay of the lost answer, the operation is sent again with the same idempotency key
        const sameKey = call(P + "authorize#SinglePayment", {
            paymentId,
            paymentGatewayConfigId: "GWC_NOTFOUND",
            operationKey: "gwc-nf-1"
        })
        const sameKeyResponse = response(sameKey.paymentGatewayResponseId)
        call(P + "get#SinglePaymentGatewayDetails", {paymentId})
        const again = call(P + "authorize#SinglePayment", {
            paymentId,
            paymentGatewayConfigId: "TEST_APPROVE",
            operationKey: "gwc-nf-2"
        })
        return {
            resolved: response(first.paymentGatewayResponseId),
            afterLookup,
            sameKeyResponse,
            again: response(again.paymentGatewayResponseId),
            after: payment(paymentId)
        }
    },
    then({resolved, afterLookup, sameKeyResponse, again, after}) {
        resolved.resultUnknown == "Y"
        resolved.outcomeResolvedDate != null
        resolved.outcomeFound == "N"
        sameKeyResponse.paymentGatewayResponseId != resolved.paymentGatewayResponseId
        sameKeyResponse.idempotencyKey == resolved.idempotencyKey
        sameKeyResponse.operationKey == "gwc-nf-1"
        afterLookup.statusId == "PmntPromised"
        again.resultSuccess == "Y"
        after.statusId == "PmntAuthorized"
    }
})

feature("a lost refund answer holds a promised refund, blocks another refund, and its lookup completes it", {
    when() {
        const paymentId = cardPayment(60)
        call(P + "authorize#SinglePayment", {paymentId, paymentGatewayConfigId: "GWC_REFUND_LOST"})
        call(P + "capture#SinglePayment", {paymentId})
        const lost = call(P + "refund#SinglePayment", {paymentId, amount: 15, operationKey: "gwc-r-1"})
        const refundWhileUnknown = payment(lost.refundPaymentId)
        const blocked = call(P + "refund#SinglePayment", {paymentId, amount: 5, operationKey: "gwc-r-2"})
        const otherAmount = refusal(P + "refund#SinglePayment", {paymentId, amount: 10, operationKey: "gwc-r-1"})
        const sameAmount = call(P + "refund#SinglePayment", {paymentId, amount: 15, operationKey: "gwc-r-1"})
        call(P + "get#SinglePaymentGatewayDetails", {paymentId: lost.refundPaymentId})
        const applied = Array.from(
            ec.entity
                .find("mantle.account.payment.PaymentApplication")
                .condition({paymentId: lost.refundPaymentId, toPaymentId: paymentId})
                .list()
        )
        return {
            lost,
            lostResponse: response(lost.paymentGatewayResponseId),
            refundWhileUnknown,
            blocked,
            otherAmount,
            sameAmount,
            refund: payment(lost.refundPaymentId),
            applied
        }
    },
    then({lost, lostResponse, refundWhileUnknown, blocked, otherAmount, sameAmount, refund, applied}) {
        lostResponse.resultUnknown == "Y"
        lostResponse.refundPaymentId == lost.refundPaymentId
        lostResponse.operationKey == "gwc-r-1"
        refundWhileUnknown.statusId == "PmntPromised"
        toDecimal(refundWhileUnknown.amount).eq(15)
        blocked.reasonCode == "GATEWAY_OUTCOME_UNKNOWN" && blocked.refundPaymentId == null
        otherAmount.includes("OPERATION_KEY_CONFLICT")
        sameAmount.paymentGatewayResponseId == lost.paymentGatewayResponseId
        sameAmount.refundPaymentId == lost.refundPaymentId
        refund.statusId == "PmntDelivered"
        applied.length == 1 && toDecimal(applied[0].amountApplied).eq(15)
    }
})

feature("the HTTP fixtures answer an adapter's outbound calls in order, record them, and refuse the rest", {
    when() {
        const http = ec.factory.getTool("HttpFixtures")
        const url = "https://gateway.example.test/v1/charges"
        http.enable()
        try {
            http.add({
                method: "POST",
                url,
                status: 200,
                body: JSON.stringify({id: "ch_1", status: "approved"}),
                contentType: "application/json",
                times: 1
            })
            http.add({url, error: "operation timed out"})
            const charge = () =>
                ec.service
                    .rest()
                    .method("POST")
                    .uri(url)
                    .addHeader("Idempotency-Key", "mq-test-key")
                    .addHeader("Authorization", "Bearer test-secret")
                    .jsonObject({amount: "10.00"})
                    .call()
            const answered = charge()
            let lost = "",
                refused = ""
            try {
                charge()
            } catch (error) {
                lost = String(error.message)
            }
            try {
                ec.service.rest().method("GET").uri("https://elsewhere.example.test/").call()
            } catch (error) {
                refused = String(error.message)
            }
            return {
                status: answered.getStatusCode(),
                body: answered.jsonObject(),
                lost,
                refused,
                sent: http.requests()
            }
        } finally {
            http.reset()
        }
    },
    then({status, body, lost, refused, sent}) {
        status == 200
        body.id == "ch_1"
        lost.includes("operation timed out")
        refused.includes("no HTTP fixture for GET")
        sent.length == 3
        sent[0].headers["Idempotency-Key"] == "mq-test-key"
        sent[0].headers["Authorization"] == "[redacted]"
        sent[0].body.includes("10.00")
        sent.map(row => row.fixture).join() == "0,1,-1"
    }
})

feature("a provider callback is kept once per remote and event id, also when it arrives twice at once", {
    when() {
        const S = "org.moqui.impl.SystemMessageServices.store#ReceivedSystemMessage"
        const event = {systemMessageTypeId: "GWC_WEBHOOK", systemMessageRemoteId: "GWC_REMOTE", messageId: "evt-1"}
        const first = call(S, Object.assign({messageText: '{"id":"evt-1"}'}, event))
        const again = call(S, Object.assign({messageText: '{"id":"evt-1","retry":true}'}, event))
        const otherRemote = call(S, Object.assign({}, event, {systemMessageRemoteId: "GWC_REMOTE_2", messageText: "{}"}))
        const results = parallel(
            3,
            (thread, args) => {
                login("john.doe")
                ec.artifactExecution.disableAuthz()
                return call("org.moqui.impl.SystemMessageServices.store#ReceivedSystemMessage", {
                    systemMessageTypeId: "GWC_WEBHOOK",
                    systemMessageRemoteId: "GWC_REMOTE",
                    messageId: "evt-2",
                    messageText: "thread " + thread
                }).systemMessageIdList.length
            },
            {}
        )
        const kept = id =>
            ec.entity
                .find("moqui.service.message.SystemMessage")
                .condition({systemMessageRemoteId: "GWC_REMOTE", messageId: id})
                .count()
        return {first, again, otherRemote, results, keptOne: kept("evt-1"), keptTwo: kept("evt-2")}
    },
    then({first, again, otherRemote, results, keptOne, keptTwo}) {
        first.systemMessageIdList.length == 1
        payloadOf(first.systemMessageId) == '{"id":"evt-1"}'
        again.systemMessageIdList.length == 0
        again.duplicateOfId == first.systemMessageId
        otherRemote.systemMessageIdList.length == 1
        otherRemote.systemMessageId != first.systemMessageId
        keptOne == 1
        results.reduce((sum, count) => sum + count, 0) == 1
        keptTwo == 1
    }
})
function payloadOf(systemMessageId) {
    const row = ec.entity.find("moqui.service.message.SystemMessage").condition("systemMessageId", systemMessageId).one()
    return row.messageText
}
