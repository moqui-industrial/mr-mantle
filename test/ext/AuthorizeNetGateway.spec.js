// The Authorize.Net gateway (plan/payments-shipping-edi.md P1, AuthorizeNetServices.xml and AuthorizeNet.js) through
// Mantle's payment services, with the HTTP fixtures answering its JSON API calls with sanitized provider-shaped answers:
// approval, decline and a transaction held for review, capture, void, a settled refund and a refund before settlement,
// customer payment profiles, a lost answer resolved by the lookup of its reference, the webhook kept once and reconciled
// through the details lookup, and the browser token endpoint. No card number, browser token or secret reaches a
// gateway response or a system message. The webhook signature check is the framework's (SmatHmacSha512, its
// Rust test in crates/moqui-core). New spec, no Groovy original.
const vendorId = "ORG_ZIZI_RETAIL"
const P = "mantle.account.PaymentServices."
const A = "mantle.ext.account.gateway.AuthorizeNetServices."
const URL = "https://apitest.authorize.net/xml/v1/request.api"
const SECRETS = ["spec-transaction-key", "spec-signature-key"]
const http = ec.factory.getTool("HttpFixtures")
let customerId
let tokenCount = 0
const tokensSent = []

spec({
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        call("create#moqui.service.message.SystemMessageRemote", {
            systemMessageRemoteId: "ANET_SPEC",
            description: "Authorize.Net spec sandbox",
            systemMessageTypeId: "AuthorizeNetWebhook",
            sendUrl: URL,
            usageCode: "T",
            username: "spec-login",
            password: SECRETS[0],
            sharedSecret: SECRETS[1],
            messageAuthEnumId: "SmatHmacSha512",
            authHeaderName: "X-ANET-Signature"
        })
        for (const [id, authorize, capture] of [
            ["ANET_SPEC", "authorize#Payment", "capture#Payment"],
            ["ANET_SPEC_SALE", "authorizeAndCapture#Payment", null],
            // Shop P5: Accept Hosted
            ["ANET_SPEC_HOSTED", "authorizeHosted#Payment", "capture#Payment"]
        ]) {
            call("create#mantle.account.method.PaymentGatewayConfig", {
                paymentGatewayConfigId: id,
                paymentGatewayTypeEnumId: "PgtAuthorizeNet",
                description: "Authorize.Net spec " + id,
                systemMessageRemoteId: "ANET_SPEC",
                authorizeServiceName: A + authorize,
                captureServiceName: capture ? A + capture : null,
                releaseServiceName: A + "release#Payment",
                refundServiceName: A + "refund#Payment",
                detailsServiceName: A + "get#PaymentGatewayDetails"
            })
            call("create#mantle.account.method.PaymentGatewayAuthorizeNet", {
                paymentGatewayConfigId: id,
                publicClientKey: "spec-public-client-key",
                validationMode: "none",
                lookupGraceSeconds: 0
            })
        }
        customerId = call("mantle.party.PartyServices.create#Person", {
            firstName: "Ana",
            lastName: "Netspec",
            roleTypeId: "Customer"
        }).partyId
        http.enable()
        ec.artifactExecution.enableAuthz()
    },
    setup() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
    },
    cleanup() {
        http.clear()
        ec.message.clearErrors()
        ec.artifactExecution.enableAuthz()
    },
    cleanupSpec() {
        // the spec's payments stay in the database: with no endpoint their gateway sends nothing when a later spec's
        // poll job asks for their details, as the fixtures are off then
        ec.artifactExecution.disableAuthz()
        call("update#moqui.service.message.SystemMessageRemote", {systemMessageRemoteId: "ANET_SPEC", sendUrl: null})
        ec.artifactExecution.enableAuthz()
        http.reset()
    }
})

// ---- the provider's answers (sanitized, shaped as the JSON API's; the answers start with a byte order mark) ----

const ok = {resultCode: "Ok", message: [{code: "I00001", text: "Successful."}]}
const failed = (code, text) => ({resultCode: "Error", message: [{code, text}]})
function answer(bodyContains, data, times = 1) {
    http.add({
        method: "POST",
        url: URL,
        bodyContains,
        status: 200,
        contentType: "application/json",
        body: "\uFEFF" + JSON.stringify(data),
        times
    })
}
function transaction(responseCode, transId, reason) {
    const approved = responseCode === "1" || responseCode === "4"
    const response = {
        responseCode,
        authCode: responseCode === "1" ? "SPC123" : "",
        avsResultCode: "Y",
        cvvResultCode: "P",
        transId,
        refTransID: "",
        testRequest: "0",
        accountNumber: "XXXX1111",
        accountType: "Visa"
    }
    if (approved)
        response.messages = [
            responseCode === "4"
                ? {code: reason || "252", description: "Your order has been received. Thank you for your business!"}
                : {code: "1", description: "This transaction has been approved."}
        ]
    else response.errors = [{errorCode: reason, errorText: "Spec refusal " + reason}]
    return {transactionResponse: response, messages: approved ? ok : failed("E00027", "The transaction was unsuccessful.")}
}
function details(transId, transactionStatus, extra = {}) {
    return {
        transaction: Object.assign(
            {
                transId,
                transactionType: "authOnlyTransaction",
                transactionStatus,
                responseCode: 1,
                responseReasonCode: 1,
                authCode: "SPC123",
                authAmount: 20,
                settleAmount: 20,
                payment: {creditCard: {cardNumber: "XXXX1111", expirationDate: "XXXX", cardType: "Visa"}}
            },
            extra
        ),
        messages: ok
    }
}
const noRecords = {resultCode: "Ok", message: [{code: "I00004", text: "No records found."}]}
const lostRequest = bodyContains => http.add({method: "POST", url: URL, bodyContains, error: "operation timed out", times: 1})
// a reference searched everywhere: transrefId, the held and the other unsettled transactions, and the settled batches
function nothingFound({batches = []} = {}) {
    answer("transrefId", {messages: failed("E00040", "The record cannot be found.")})
    answer("pendingApproval", {messages: noRecords})
    answer("getUnsettledTransactionListRequest", {messages: noRecords})
    answer("getSettledBatchListRequest", batches.length ? {batchList: batches, messages: ok} : {messages: noRecords})
}
// a reference with no transaction yet in the lists (Shop P6, F85: a form token is issued only then)
function noTransactions() {
    answer("pendingApproval", {messages: noRecords})
    answer("getUnsettledTransactionListRequest", {messages: noRecords})
    answer("getSettledBatchListRequest", {messages: noRecords})
}
function token() {
    const value = "spec-opaque-" + ++tokenCount
    tokensSent.push(value)
    return {dataDescriptor: "COMMON.ACCEPT.INAPP.PAYMENT", dataValue: value}
}

// ---- records ----

const payment = paymentId => ec.entity.find("mantle.account.payment.Payment").condition("paymentId", paymentId).one()
const response = id =>
    ec.entity.find("mantle.account.method.PaymentGatewayResponse").condition("paymentGatewayResponseId", id).one()
const sent = () => Array.from(http.requests()).map(row => JSON.parse(row.body))
const requestOf = body => Object.values(body)[0]
function cardPayment(amount, gatewayId = "ANET_SPEC", fields = {}) {
    return call(
        P + "create#Payment",
        Object.assign(
            {
                fromPartyId: customerId,
                toPartyId: vendorId,
                amount,
                amountUomId: "USD",
                paymentInstrumentEnumId: "PiCreditCard",
                paymentGatewayConfigId: gatewayId,
                statusId: "PmntPromised"
            },
            fields
        )
    ).paymentId
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

feature("a browser token authorizes, and the capture reads the transaction's status before it captures", {
    when() {
        const paymentId = cardPayment(20)
        answer("authOnlyTransaction", transaction("1", "60001"))
        const auth = call(P + "authorize#SinglePayment", {paymentId, paymentToken: token(), operationKey: "anet-a-1"})
        const authorized = payment(paymentId)
        answer('"transId":"60001"', details("60001", "authorizedPendingCapture"))
        answer("priorAuthCaptureTransaction", transaction("1", "60001"))
        const capture = call(P + "capture#SinglePayment", {paymentId, operationKey: "anet-c-1"})
        const requests = sent()
        return {
            auth: response(auth.paymentGatewayResponseId),
            authorized,
            capture: response(capture.paymentGatewayResponseId),
            after: payment(paymentId),
            requests
        }
    },
    then({auth, authorized, capture, after, requests}) {
        auth.resultSuccess == "Y"
        auth.referenceNum == "60001"
        auth.approvalCode == "SPC123"
        auth.avsResult == "Y" && auth.cvResult == "P"
        authorized.statusId == "PmntAuthorized"
        authorized.paymentRefNum == "60001"
        // the authorization went with the token, the amount in its currency and the reference the lookup searches
        requests.length == 3
        requestOf(requests[0]).merchantAuthentication.name == "spec-login"
        requestOf(requests[0]).refId == auth.idempotencyKey.slice(0, 20)
        requestOf(requests[0]).transactionRequest.order.invoiceNumber == auth.idempotencyKey.slice(0, 20)
        requestOf(requests[0]).transactionRequest.payment.opaqueData.dataValue == tokensSent[0]
        requestOf(requests[0]).transactionRequest.currencyCode == "USD"
        toDecimal(requestOf(requests[0]).transactionRequest.amount).eq(20)
        Object.keys(requestOf(requests[0]).transactionRequest)
            .join()
            .startsWith("transactionType,amount,currencyCode,payment,order,customer")
        requestOf(requests[1]).transId == "60001"
        requestOf(requests[2]).transactionRequest.refTransId == "60001"
        capture.resultSuccess == "Y"
        after.statusId == "PmntDelivered"
    }
})

feature("a decline declines the payment, and a transaction held for review stays pending with its reference", {
    when() {
        const declinedId = cardPayment(21)
        answer("authOnlyTransaction", transaction("2", "60010", "2"))
        const declined = call(P + "authorize#SinglePayment", {paymentId: declinedId, paymentToken: token()})
        const badCardId = cardPayment(22)
        answer("authOnlyTransaction", transaction("3", "0", "6"))
        const badCard = call(P + "authorize#SinglePayment", {paymentId: badCardId, paymentToken: token()})
        const heldId = cardPayment(23)
        answer("authOnlyTransaction", transaction("4", "60011", "252"))
        const held = call(P + "authorize#SinglePayment", {paymentId: heldId, paymentToken: token()})
        answer('"transId":"60011"', details("60011", "FDSPendingReview"))
        call(P + "get#SinglePaymentGatewayDetails", {paymentId: heldId})
        return {
            declined: response(declined.paymentGatewayResponseId),
            declinedPayment: payment(declinedId),
            badCard: response(badCard.paymentGatewayResponseId),
            held: response(held.paymentGatewayResponseId),
            heldPayment: payment(heldId)
        }
    },
    then({declined, declinedPayment, badCard, held, heldPayment}) {
        declined.resultDeclined == "Y" && declined.reasonCode == "2"
        declinedPayment.statusId == "PmntDeclined"
        badCard.resultBadCardNumber == "Y" && badCard.referenceNum == null
        held.resultSuccess == "N" && held.resultDeclined == "N" && held.resultError == "N" && held.resultUnknown == "N"
        held.transactionStatus == "held"
        heldPayment.statusId == "PmntPromised"
        heldPayment.paymentRefNum == "60011"
    }
})

feature("a release voids the authorization", {
    when() {
        const paymentId = cardPayment(24)
        answer("authOnlyTransaction", transaction("1", "60020"))
        call(P + "authorize#SinglePayment", {paymentId, paymentToken: token()})
        answer("voidTransaction", transaction("1", "60020"))
        const release = call(P + "release#SinglePayment", {paymentId})
        return {release: response(release.paymentGatewayResponseId), after: payment(paymentId), voidRequest: requestOf(sent()[1])}
    },
    then({release, after, voidRequest}) {
        release.resultSuccess == "Y"
        voidRequest.transactionRequest.transactionType == "voidTransaction"
        voidRequest.transactionRequest.refTransId == "60020"
        after.statusId == "PmntPromised"
        after.paymentRefNum == null
    }
})

feature("a settled sale refunds linked to its transaction; before settlement the whole amount is voided and a part refused", {
    when() {
        const settledId = cardPayment(40, "ANET_SPEC_SALE")
        answer("authCaptureTransaction", transaction("1", "60030"))
        call(P + "authorize#SinglePayment", {paymentId: settledId, paymentToken: token()})
        const sold = payment(settledId)
        answer(
            '"transId":"60030"',
            details("60030", "settledSuccessfully", {settleAmount: 40, batch: {settlementTimeUTC: "2026-11-01T10:00:00Z"}})
        )
        answer("refundTransaction", transaction("1", "60031"))
        const settledRefund = call(P + "refund#SinglePayment", {paymentId: settledId, amount: 15, operationKey: "anet-r-1"})
        const refundRequest = requestOf(sent()[2]).transactionRequest

        const unsettledId = cardPayment(30, "ANET_SPEC_SALE")
        answer("authCaptureTransaction", transaction("1", "60040"))
        call(P + "authorize#SinglePayment", {paymentId: unsettledId, paymentToken: token()})
        answer('"transId":"60040"', details("60040", "capturedPendingSettlement", {settleAmount: 30}), 2)
        const partial = call(P + "refund#SinglePayment", {paymentId: unsettledId, amount: 10})
        answer("voidTransaction", transaction("1", "60040"))
        const whole = call(P + "refund#SinglePayment", {paymentId: unsettledId, amount: 30})
        const applied = id =>
            Array.from(ec.entity.find("mantle.account.payment.PaymentApplication").condition({paymentId: id}).list())
        return {
            sold,
            settledRefund: response(settledRefund.paymentGatewayResponseId),
            refundPayment: payment(settledRefund.refundPaymentId),
            refundApplied: applied(settledRefund.refundPaymentId),
            refundRequest,
            partial: response(partial.paymentGatewayResponseId),
            partialRefundId: partial.refundPaymentId,
            whole: response(whole.paymentGatewayResponseId),
            wholeRefund: payment(whole.refundPaymentId),
            original: payment(unsettledId)
        }
    },
    then({
        sold,
        settledRefund,
        refundPayment,
        refundApplied,
        refundRequest,
        partial,
        partialRefundId,
        whole,
        wholeRefund,
        original
    }) {
        sold.statusId == "PmntDelivered" && sold.paymentRefNum == "60030"
        settledRefund.resultSuccess == "Y" && settledRefund.referenceNum == "60031"
        refundRequest.transactionType == "refundTransaction"
        refundRequest.refTransId == "60030"
        refundRequest.payment.creditCard.cardNumber == "1111"
        refundRequest.payment.creditCard.expirationDate == "XXXX"
        toDecimal(refundRequest.amount).eq(15)
        refundPayment.statusId == "PmntDelivered"
        refundPayment.paymentRefNum == "60031"
        toDecimal(refundPayment.amount).eq(15)
        refundApplied.length == 1 && toDecimal(refundApplied[0].amountApplied).eq(15)
        // a part of an unsettled capture is refused and sends nothing; the whole is a void, recorded as the refund
        partial.resultError == "Y" && partial.reasonCode == "REFUND_BEFORE_SETTLEMENT"
        partialRefundId == null
        whole.resultSuccess == "Y" && whole.reasonCode == "VOID_BEFORE_SETTLEMENT"
        whole.paymentOperationEnumId == "PgoRefund"
        wholeRefund.statusId == "PmntDelivered"
        wholeRefund.paymentRefNum == null
        whole.referenceNum == null && whole.altReference == "60040"
        toDecimal(wholeRefund.amount).eq(30)
        original.statusId == "PmntDelivered"
    }
})

feature("a payment profile made from a browser token is used for later payments and deleted with its method", {
    when() {
        answer("createCustomerProfileRequest", {
            customerProfileId: "70001",
            customerPaymentProfileIdList: ["80001"],
            messages: ok
        })
        answer("getCustomerPaymentProfileRequest", {
            paymentProfile: {
                customerPaymentProfileId: "80001",
                payment: {creditCard: {cardNumber: "XXXX1111", expirationDate: "XXXX", cardType: "Visa"}}
            },
            messages: ok
        })
        const stored = call(A + "store#CustomerPaymentProfile", {
            partyId: customerId,
            paymentGatewayConfigId: "ANET_SPEC",
            paymentToken: token()
        })
        const method = ec.entity
            .find("mantle.account.method.PaymentMethod")
            .condition("paymentMethodId", stored.paymentMethodId)
            .one()
        const card = ec.entity.find("mantle.account.method.CreditCard").condition("paymentMethodId", stored.paymentMethodId).one()
        const paymentId = cardPayment(25, "ANET_SPEC", {paymentMethodId: stored.paymentMethodId})
        answer("authOnlyTransaction", transaction("1", "60050"))
        const auth = call(P + "authorize#SinglePayment", {paymentId})
        const profileAuth = requestOf(sent()[2]).transactionRequest
        // a second card of the same party goes on its customer profile, and is deleted with its method
        answer("createCustomerPaymentProfileRequest", {
            customerProfileId: "70001",
            customerPaymentProfileId: "80002",
            messages: ok
        })
        answer("getCustomerPaymentProfileRequest", {
            paymentProfile: {payment: {creditCard: {cardNumber: "XXXX4242", cardType: "Visa"}}},
            messages: ok
        })
        const second = call(A + "store#CustomerPaymentProfile", {
            partyId: customerId,
            paymentGatewayConfigId: "ANET_SPEC",
            paymentToken: token()
        })
        const secondRequest = requestOf(sent()[3])
        answer("deleteCustomerPaymentProfileRequest", {messages: ok})
        call("mantle.account.PaymentMethodServices.delete#PaymentMethod", {paymentMethodId: second.paymentMethodId})
        const deleteRequest = requestOf(sent()[5])
        const deleted = ec.entity
            .find("mantle.account.method.PaymentMethod")
            .condition("paymentMethodId", second.paymentMethodId)
            .one()
        return {
            stored,
            method,
            card,
            auth: response(auth.paymentGatewayResponseId),
            profileAuth,
            second,
            secondRequest,
            deleteRequest,
            deleted
        }
    },
    then({stored, method, card, auth, profileAuth, second, secondRequest, deleteRequest, deleted}) {
        method.gatewayCustomerId == "70001" && method.gatewayCimId == "80001"
        method.paymentGatewayConfigId == "ANET_SPEC"
        card.cardNumber == "XXXX1111"
        card.creditCardTypeEnumId == "CctVisa"
        response(stored.paymentGatewayResponseId).paymentOperationEnumId == "PgoStoreCim"
        auth.resultSuccess == "Y"
        profileAuth.profile.customerProfileId == "70001"
        profileAuth.profile.paymentProfile.paymentProfileId == "80001"
        profileAuth.payment == null
        second.gatewayCustomerId == "70001" && second.gatewayCimId == "80002"
        secondRequest.customerProfileId == "70001"
        deleteRequest.customerPaymentProfileId == "80002"
        deleted.thruDate != null
        deleted.gatewayCimId == null
    }
})

feature("a lost answer is unknown and blocks a new charge until the lookup finds the transaction by its reference", {
    when() {
        const paymentId = cardPayment(26)
        http.add({method: "POST", url: URL, bodyContains: "authOnlyTransaction", error: "operation timed out", times: 1})
        const lost = call(P + "authorize#SinglePayment", {paymentId, paymentToken: token(), operationKey: "anet-u-1"})
        const lostResponse = response(lost.paymentGatewayResponseId)
        const blocked = call(P + "authorize#SinglePayment", {paymentId, paymentToken: token(), operationKey: "anet-u-2"})
        const refId = lostResponse.idempotencyKey.slice(0, 20)
        answer("transrefId", {messages: failed("E00040", "The record cannot be found.")})
        answer("pendingApproval", {messages: noRecords})
        answer("getUnsettledTransactionListRequest", {
            transactions: [
                {transId: "60059", invoiceNumber: "another-reference", transactionStatus: "authorizedPendingCapture"},
                {transId: "60060", invoiceNumber: refId, transactionStatus: "authorizedPendingCapture", accountNumber: "XXXX1111"}
            ],
            totalNumInResultSet: 2,
            messages: ok
        })
        answer('"transId":"60060"', details("60060", "authorizedPendingCapture", {authAmount: 26, order: {invoiceNumber: refId}}))
        call(P + "get#SinglePaymentGatewayDetails", {paymentId})
        const lookups = sent()
            .slice(1)
            .map(body => Object.keys(body)[0])
        return {lostResponse, blocked, resolved: response(lost.paymentGatewayResponseId), after: payment(paymentId), lookups}
    },
    then({lostResponse, blocked, resolved, after, lookups}) {
        lostResponse.resultUnknown == "Y"
        lostResponse.resultError == "N" && lostResponse.resultSuccess == "N"
        lostResponse.reasonMessage.includes("No answer")
        blocked.reasonCode == "GATEWAY_OUTCOME_UNKNOWN"
        lookups.join() ==
            "getTransactionDetailsRequest,getUnsettledTransactionListRequest,getUnsettledTransactionListRequest,getTransactionDetailsRequest"
        resolved.outcomeFound == "Y" && resolved.outcomeResolvedDate != null
        after.statusId == "PmntAuthorized"
        after.paymentRefNum == "60060"
        after.paymentAuthCode == "SPC123"
    }
})

feature("a webhook is kept once per notification, and consuming it reconciles the payment through the details lookup", {
    when() {
        const paymentId = cardPayment(27)
        answer("authOnlyTransaction", transaction("4", "60070", "252"))
        call(P + "authorize#SinglePayment", {paymentId, paymentToken: token()})
        const notification = JSON.stringify({
            notificationId: "spec-notification-1",
            eventType: "net.authorize.payment.fraud.approved",
            eventDate: "2026-11-02T10:00:00.000Z",
            webhookId: "spec-webhook",
            // the payload says declined; the lookup reads the provider's state
            payload: {responseCode: 2, authCode: "", avsResponse: "Y", authAmount: 27, entityName: "transaction", id: "60070"}
        })
        const receive = () =>
            call(A + "receive#Webhook", {
                systemMessageTypeId: "AuthorizeNetWebhook",
                systemMessageRemoteId: "ANET_SPEC",
                messageText: notification
            })
        const first = receive()
        const again = receive()
        answer('"transId":"60070"', details("60070", "authorizedPendingCapture", {authAmount: 27}))
        call("org.moqui.impl.SystemMessageServices.consume#ReceivedSystemMessage", {
            systemMessageId: first.systemMessageIdList[0]
        })
        const message = ec.entity
            .find("moqui.service.message.SystemMessage")
            .condition("systemMessageId", first.systemMessageIdList[0])
            .one()
        // an event of a transaction Mantle did not send is consumed with nothing to do
        const other = call(A + "receive#Webhook", {
            systemMessageTypeId: "AuthorizeNetWebhook",
            systemMessageRemoteId: "ANET_SPEC",
            messageText: JSON.stringify({
                notificationId: "spec-notification-2",
                eventType: "net.authorize.payment.authcapture.created",
                payload: {entityName: "transaction", id: "69999"}
            })
        })
        call("org.moqui.impl.SystemMessageServices.consume#ReceivedSystemMessage", {
            systemMessageId: other.systemMessageIdList[0]
        })
        const otherMessage = ec.entity
            .find("moqui.service.message.SystemMessage")
            .condition("systemMessageId", other.systemMessageIdList[0])
            .one()
        return {first, again, message, after: payment(paymentId), otherMessage, lookups: sent().length}
    },
    then({first, again, message, after, otherMessage, lookups}) {
        first.systemMessageIdList.length == 1
        again.systemMessageIdList.length == 0
        again.duplicateOfId == first.systemMessageIdList[0]
        message.messageId == "spec-notification-1"
        message.statusId == "SmsgConsumed"
        after.statusId == "PmntAuthorized"
        after.paymentAuthCode == "SPC123"
        otherMessage.statusId == "SmsgConsumed"
        lookups == 2
    }
})

feature("a payer pays in the browser with a token and keeps the card; another customer may not pay that payment", {
    when() {
        const ownId = cardPayment(28, "ANET_SPEC", {fromPartyId: "CustJqp"})
        const othersId = cardPayment(28)
        login("joe@public.com")
        const config = call(A + "get#BrowserPaymentConfig", {paymentId: ownId})
        // the same through the scoped REST endpoint a page calls
        const rest = screenTest("rest").render("s1/mantle/my/payments/" + ownId + "/authorizeNet", null, "get")
        answer("createCustomerProfileRequest", {
            customerProfileId: "70002",
            customerPaymentProfileIdList: ["80003"],
            messages: ok
        })
        answer("getCustomerPaymentProfileRequest", {
            paymentProfile: {payment: {creditCard: {cardNumber: "XXXX1111", cardType: "Visa"}}},
            messages: ok
        })
        answer("authOnlyTransaction", transaction("1", "60080"))
        const browserToken = token()
        const paid = call(A + "submit#BrowserPaymentToken", {
            paymentId: ownId,
            dataDescriptor: browserToken.dataDescriptor,
            dataValue: browserToken.dataValue,
            savePaymentMethod: true,
            operationId: "spec-page-0001"
        })
        const requests = sent().map(body => Object.keys(body)[0])
        const refused = refusal(A + "get#BrowserPaymentConfig", {paymentId: othersId})
        const refusedSubmit = refusal(A + "submit#BrowserPaymentToken", {
            paymentId: othersId,
            dataDescriptor: browserToken.dataDescriptor,
            dataValue: "spec-opaque-refused"
        })
        login("john.doe")
        return {config, rest, paid, requests, refused, refusedSubmit, sentCount: sent().length, other: payment(othersId)}
    },
    then({config, rest, paid, requests, refused, refusedSubmit, sentCount, other}) {
        rest.status == 200
        rest.output.includes("spec-public-client-key")
        !rest.output.includes(SECRETS[0])
        config.apiLoginId == "spec-login"
        config.clientKey == "spec-public-client-key"
        config.acceptUiUrl == "https://jstest.authorize.net/v3/AcceptUI.js"
        config.currencyUomId == "USD"
        paid.state == "approved"
        paid.statusId == "PmntAuthorized"
        paid.paymentMethodId != null
        requests.join() == "createCustomerProfileRequest,getCustomerPaymentProfileRequest,createTransactionRequest"
        refused.includes("PERMISSION_DENIED")
        refusedSubmit.includes("PERMISSION_DENIED")
        sentCount == 3
        other.statusId == "PmntPromised"
    }
})

feature("a duplicate refusal is unknown, and the lookup by transrefId finds the first transaction", {
    when() {
        const paymentId = cardPayment(31)
        answer("authOnlyTransaction", transaction("3", "0", "11"))
        const duplicate = call(P + "authorize#SinglePayment", {paymentId, paymentToken: token(), operationKey: "anet-d-1"})
        const refId = response(duplicate.paymentGatewayResponseId).idempotencyKey.slice(0, 20)
        answer("transrefId", details("60090", "authorizedPendingCapture", {authAmount: 31, order: {invoiceNumber: refId}}))
        call(P + "get#SinglePaymentGatewayDetails", {paymentId})
        return {duplicate: response(duplicate.paymentGatewayResponseId), after: payment(paymentId), lookups: sent().length}
    },
    then({duplicate, after, lookups}) {
        duplicate.resultUnknown == "Y" && duplicate.reasonCode == "11"
        duplicate.outcomeFound == "Y"
        after.statusId == "PmntAuthorized"
        after.paymentRefNum == "60090"
        after.paymentAuthCode == "SPC123"
        lookups == 2
    }
})

feature("a capture or void the provider already did is a success on a retry (311, 310)", {
    when() {
        const capturedId = cardPayment(32)
        answer("authOnlyTransaction", transaction("1", "60100"))
        call(P + "authorize#SinglePayment", {paymentId: capturedId, paymentToken: token()})
        answer('"transId":"60100"', details("60100", "authorizedPendingCapture"))
        answer("priorAuthCaptureTransaction", transaction("3", "60100", "311"))
        const capture = call(P + "capture#SinglePayment", {paymentId: capturedId})
        const voidedId = cardPayment(33)
        answer("authOnlyTransaction", transaction("1", "60101"))
        call(P + "authorize#SinglePayment", {paymentId: voidedId, paymentToken: token()})
        answer("voidTransaction", transaction("3", "60101", "310"))
        const release = call(P + "release#SinglePayment", {paymentId: voidedId})
        return {
            capture: response(capture.paymentGatewayResponseId),
            captured: payment(capturedId),
            release: response(release.paymentGatewayResponseId),
            voided: payment(voidedId)
        }
    },
    then({capture, captured, release, voided}) {
        capture.resultSuccess == "Y" && capture.reasonCode == "311"
        captured.statusId == "PmntDelivered"
        release.resultSuccess == "Y" && release.reasonCode == "310"
        voided.statusId == "PmntPromised"
    }
})

feature("a lost sale is found in a settled batch; a lost authorization found nowhere is not done and is sent again", {
    when() {
        const saleId = cardPayment(34, "ANET_SPEC_SALE")
        lostRequest("authCaptureTransaction")
        const sale = call(P + "authorize#SinglePayment", {paymentId: saleId, paymentToken: token(), operationKey: "anet-s-1"})
        const saleRef = response(sale.paymentGatewayResponseId).idempotencyKey.slice(0, 20)
        nothingFound({
            batches: [{batchId: "9001", settlementTimeUTC: "2026-11-01T10:00:00Z", settlementState: "settledSuccessfully"}]
        })
        answer("getTransactionListRequest", {
            transactions: [{transId: "60110", invoiceNumber: saleRef, transactionStatus: "settledSuccessfully"}],
            totalNumInResultSet: 1,
            messages: ok
        })
        answer(
            '"transId":"60110"',
            details("60110", "settledSuccessfully", {
                transactionType: "authCaptureTransaction",
                authAmount: 34,
                settleAmount: 34,
                order: {invoiceNumber: saleRef},
                batch: {batchId: "9001", settlementTimeUTC: "2026-11-01T10:00:00Z"}
            })
        )
        call(P + "get#SinglePaymentGatewayDetails", {paymentId: saleId})
        const saleLookups = sent()
            .slice(1)
            .map(body => Object.keys(body)[0])
            .join()
        http.clear()

        const authId = cardPayment(35)
        const params = {paymentId: authId, paymentToken: token(), operationKey: "anet-n-1"}
        lostRequest("authOnlyTransaction")
        const lost = call(P + "authorize#SinglePayment", params)
        nothingFound()
        call(P + "get#SinglePaymentGatewayDetails", {paymentId: authId})
        const notDone = payment(authId)
        answer("authOnlyTransaction", transaction("1", "60111"))
        const again = call(P + "authorize#SinglePayment", Object.assign({}, params, {paymentToken: token()}))
        return {
            sale: response(sale.paymentGatewayResponseId),
            sold: payment(saleId),
            saleLookups,
            lost: response(lost.paymentGatewayResponseId),
            notDone,
            again: response(again.paymentGatewayResponseId),
            after: payment(authId)
        }
    },
    then({sale, sold, saleLookups, lost, notDone, again, after}) {
        sale.outcomeFound == "Y"
        saleLookups ==
            "getTransactionDetailsRequest,getUnsettledTransactionListRequest,getUnsettledTransactionListRequest," +
                "getSettledBatchListRequest,getTransactionListRequest,getTransactionDetailsRequest"
        sold.statusId == "PmntConfirmed"
        sold.paymentRefNum == "60110" && sold.paymentAuthCode == "SPC123"
        sold.settlementDate != null
        lost.outcomeFound == "N" && lost.outcomeResolvedDate != null
        notDone.statusId == "PmntPromised"
        again.idempotencyKey == lost.idempotencyKey
        again.resultSuccess == "Y"
        after.statusId == "PmntAuthorized"
    }
})

feature("a lost capture is found captured, and a lost void found voided, on the authorization's transaction", {
    when() {
        const captureId = cardPayment(36)
        answer("authOnlyTransaction", transaction("1", "60120"))
        call(P + "authorize#SinglePayment", {paymentId: captureId, paymentToken: token()})
        answer('"transId":"60120"', details("60120", "authorizedPendingCapture"))
        lostRequest("priorAuthCaptureTransaction")
        const capture = call(P + "capture#SinglePayment", {paymentId: captureId})
        answer('"transId":"60120"', details("60120", "capturedPendingSettlement"))
        call(P + "get#SinglePaymentGatewayDetails", {paymentId: captureId})
        const voidId = cardPayment(37)
        answer("authOnlyTransaction", transaction("1", "60121"))
        call(P + "authorize#SinglePayment", {paymentId: voidId, paymentToken: token()})
        lostRequest("voidTransaction")
        const release = call(P + "release#SinglePayment", {paymentId: voidId})
        const whileLost = payment(voidId)
        answer('"transId":"60121"', details("60121", "voided"))
        call(P + "get#SinglePaymentGatewayDetails", {paymentId: voidId})
        return {
            capture: response(capture.paymentGatewayResponseId),
            captured: payment(captureId),
            release: response(release.paymentGatewayResponseId),
            whileLost,
            voided: payment(voidId)
        }
    },
    then({capture, captured, release, whileLost, voided}) {
        capture.resultUnknown == "Y" && capture.outcomeFound == "Y"
        captured.statusId == "PmntDelivered"
        release.resultUnknown == "Y" && release.outcomeFound == "Y"
        whileLost.statusId == "PmntAuthorized"
        voided.statusId == "PmntPromised"
        voided.paymentRefNum == null && voided.paymentAuthCode == null
    }
})

feature("a lost refund before settlement is found through the voided original", {
    when() {
        const paymentId = cardPayment(38, "ANET_SPEC_SALE")
        answer("authCaptureTransaction", transaction("1", "60130"))
        call(P + "authorize#SinglePayment", {paymentId, paymentToken: token()})
        answer('"transId":"60130"', details("60130", "capturedPendingSettlement", {settleAmount: 38}))
        lostRequest("voidTransaction")
        const lost = call(P + "refund#SinglePayment", {paymentId, amount: 38, operationKey: "anet-rv-1"})
        const whileLost = payment(lost.refundPaymentId)
        nothingFound()
        answer('"transId":"60130"', details("60130", "voided", {settleAmount: 38}))
        call(P + "get#SinglePaymentGatewayDetails", {paymentId: lost.refundPaymentId})
        const applied = Array.from(
            ec.entity.find("mantle.account.payment.PaymentApplication").condition({paymentId: lost.refundPaymentId}).list()
        )
        return {lost: response(lost.paymentGatewayResponseId), whileLost, refund: payment(lost.refundPaymentId), applied}
    },
    then({lost, whileLost, refund, applied}) {
        lost.resultUnknown == "Y" && lost.outcomeFound == "Y"
        whileLost.statusId == "PmntPromised"
        refund.statusId == "PmntDelivered"
        refund.paymentRefNum == null
        applied.length == 1 && toDecimal(applied[0].amountApplied).eq(38)
    }
})

feature("a held authorization is not sent again; only the payer keeps a card, and a declined new card is not kept", {
    when() {
        const heldId = cardPayment(39, "ANET_SPEC", {fromPartyId: "CustJqp"})
        login("joe@public.com")
        const submit = (paymentId, operationId, savePaymentMethod = false) => {
            const browserToken = token()
            return call(A + "submit#BrowserPaymentToken", {
                paymentId,
                dataDescriptor: browserToken.dataDescriptor,
                dataValue: browserToken.dataValue,
                savePaymentMethod,
                operationId
            })
        }
        answer("authOnlyTransaction", transaction("4", "60140", "252"))
        const held = submit(heldId, "spec-held-0001")
        const resubmit = submit(heldId, "spec-held-0002")
        const heldSent = sent().length
        // a declined card the payer chose to keep: its new profile is deleted and the payment keeps no method
        const declinedId = cardPayment(40, "ANET_SPEC", {fromPartyId: "CustJqp"})
        answer("createCustomerPaymentProfileRequest", {
            customerProfileId: "70002",
            customerPaymentProfileId: "80009",
            messages: ok
        })
        answer("createCustomerProfileRequest", {
            customerProfileId: "70002",
            customerPaymentProfileIdList: ["80009"],
            messages: ok
        })
        answer("getCustomerPaymentProfileRequest", {
            paymentProfile: {payment: {creditCard: {cardNumber: "XXXX0002"}}},
            messages: ok
        })
        answer("authOnlyTransaction", transaction("2", "60141", "2"))
        answer("deleteCustomerPaymentProfileRequest", {messages: ok})
        const declined = submit(declinedId, "spec-decl-0001", true)
        const declinedSent = sent()
            .slice(heldSent)
            .map(body => Object.keys(body)[0])
        const kept = Array.from(
            ec.entity
                .find("mantle.account.method.PaymentMethod")
                .condition({ownerPartyId: "CustJqp", gatewayCimId: "80009"})
                .list()
        )
        const dropped = Array.from(
            ec.entity
                .find("mantle.account.method.PaymentMethod")
                .condition({ownerPartyId: "CustJqp", gatewayCustomerId: "70002"})
                .list()
        ).filter(row => row.thruDate != null)
        login("john.doe")
        // treasury pays for the customer: the card is used once and not kept
        const treasuryId = cardPayment(41)
        answer("authOnlyTransaction", transaction("1", "60142"))
        const before = sent().length
        const treasury = submit(treasuryId, "spec-tres-0001", true)
        const treasurySent = sent()
            .slice(before)
            .map(body => Object.keys(body)[0])
        return {
            held,
            resubmit,
            heldSent,
            unkeyed: call(P + "authorize#SinglePayment", {paymentId: heldId}),
            declined,
            declinedSent,
            kept,
            dropped,
            declinedPayment: payment(declinedId),
            treasury,
            treasurySent
        }
    },
    then({held, resubmit, heldSent, unkeyed, declined, declinedSent, kept, dropped, declinedPayment, treasury, treasurySent}) {
        held.state == "pending"
        resubmit.state == "pending"
        heldSent == 1
        unkeyed.reasonCode == "GATEWAY_OUTCOME_PENDING"
        declined.state == "declined"
        declined.paymentMethodId == null
        declinedSent.includes("deleteCustomerPaymentProfileRequest")
        kept.length == 0
        dropped.length == 1
        declinedPayment.paymentMethodId == null
        treasury.state == "approved"
        treasury.paymentMethodId == null
        treasurySent.join() == "createTransactionRequest"
    }
})

// The adapter logs only fixed text and reason codes, never a request or an answer; a run's console is checked for the
// same values by hand (plan P1 record).
feature("Accept Hosted: the payment waits at its page, a form token per visit, and a webhook finds it by its reference", {
    when() {
        const paymentId = cardPayment(30, "ANET_SPEC_HOSTED")
        const returnUrl = "https://shop.example.test/Checkout/return?ref=1&key=" + "k".repeat(40)
        const auth = call(P + "authorize#SinglePayment", {paymentId, operationKey: "anet-h-1", returnUrl})
        const pending = response(auth.paymentGatewayResponseId)
        const nothingSent = sent().length
        noTransactions()
        answer("getHostedPaymentPageRequest", {token: "spec-form-token-1", messages: ok})
        const form = call(A + "get#HostedPaymentForm", {
            paymentId,
            returnUrl,
            cancelUrl: returnUrl + "&cancelled=true",
            merchantName: "Spec Store"
        })
        const formRequest = sent().find(body => body.getHostedPaymentPageRequest).getHostedPaymentPageRequest
        const reference = pending.idempotencyKey.slice(0, 20)
        // the payer paid on the page; the webhook names the transaction with no merchant reference: its invoice number
        // (getTransactionDetails) matches the waiting payment, whose lookup finds it by the reference
        answer(
            '"transId":"60200"',
            details("60200", "authorizedPendingCapture", {order: {invoiceNumber: reference}, authAmount: 30})
        )
        answer(
            "transrefId",
            details("60200", "authorizedPendingCapture", {
                order: {invoiceNumber: reference},
                authAmount: 30,
                networkTransId: "SPECNTI0001"
            })
        )
        noTransactions()
        const notification = call(A + "receive#Webhook", {
            systemMessageTypeId: "AuthorizeNetWebhook",
            systemMessageRemoteId: "ANET_SPEC",
            messageText: JSON.stringify({
                notificationId: "spec-notification-hosted-1",
                eventType: "net.authorize.payment.authorization.created",
                payload: {entityName: "transaction", id: "60200", authAmount: 30}
            })
        })
        call("org.moqui.impl.SystemMessageServices.consume#ReceivedSystemMessage", {
            systemMessageId: notification.systemMessageIdList[0]
        })
        const lookups = ec.entity
            .find("mantle.account.method.PaymentGatewayResponse")
            .condition({paymentId, paymentOperationEnumId: "PgoTxDetails"})
            .list()
        return {
            pending,
            nothingSent,
            form,
            formRequest,
            reference,
            after: payment(paymentId),
            lookup: Array.from(lookups)[0],
            formDate: response(pending.paymentGatewayResponseId).hostedFormDate
        }
    },
    then({pending, nothingSent, form, formRequest, reference, after, lookup, formDate}) {
        // authorized at the page, nothing sent: pending with no result and no transaction yet
        pending.transactionStatus == "HostedPending"
        pending.resultSuccess == "N" && pending.resultDeclined == "N" && pending.resultUnknown == "N"
        nothingSent == 0
        // the form: a fresh token for the sandbox page, the reference in refId and invoiceNumber, the canonical return
        form.token == "spec-form-token-1"
        form.formUrl == "https://test.authorize.net/payment/payment"
        formRequest.refId == reference
        formRequest.transactionRequest.order.invoiceNumber == reference
        formRequest.transactionRequest.transactionType == "authOnlyTransaction"
        toDecimal(formRequest.transactionRequest.amount).eq(30)
        JSON.parse(formRequest.hostedPaymentSettings.setting[0].settingValue).url.startsWith(
            "https://shop.example.test/Checkout/return"
        )
        JSON.parse(formRequest.hostedPaymentSettings.setting[2].settingValue).merchantName == "Spec Store"
        formDate != null
        // the webhook's lookup: the transaction found by the reference, its amount and network transaction id kept
        after.statusId == "PmntAuthorized"
        after.paymentRefNum == "60200"
        lookup.networkTransId == "SPECNTI0001"
        toDecimal(lookup.amount).eq(30)
    }
})

// Shop P5 review: Accept Hosted lets the payer try again on the page after a decline, so a decline found while a form
// token can still be used leaves the payment waiting, and after it the reference's newest transaction decides.
feature("Accept Hosted: a decline is final only once no form token can be used, and a later approval wins", {
    when() {
        const paymentId = cardPayment(31, "ANET_SPEC_HOSTED")
        const returnUrl = "https://shop.example.test/Checkout/return?ref=2&key=" + "k".repeat(40)
        const auth = call(P + "authorize#SinglePayment", {paymentId, operationKey: "anet-h-2", returnUrl})
        const pending = response(auth.paymentGatewayResponseId)
        const reference = pending.idempotencyKey.slice(0, 20)
        noTransactions()
        answer("getHostedPaymentPageRequest", {token: "spec-form-token-2", messages: ok})
        call(A + "get#HostedPaymentForm", {paymentId, returnUrl, merchantName: "Spec Store"})
        const declined = details("60310", "declined", {order: {invoiceNumber: reference}, authAmount: 31, responseCode: 2})
        answer("transrefId", declined)
        call(P + "get#SinglePaymentGatewayDetails", {paymentId})
        const during = payment(paymentId)
        // the token's time is over: the decline found again, and the newest transaction of the reference, approved
        call("update#mantle.account.method.PaymentGatewayResponse", {
            paymentGatewayResponseId: pending.paymentGatewayResponseId,
            hostedFormDate: new Date(Date.now() - 20 * 60000)
        })
        answer("transrefId", declined)
        answer("pendingApproval", {messages: noRecords})
        answer("getUnsettledTransactionListRequest", {
            transactions: [
                {transId: "60311", invoiceNumber: reference, transactionStatus: "authorizedPendingCapture"},
                {transId: "60310", invoiceNumber: reference, transactionStatus: "declined"}
            ],
            totalNumInResultSet: 2,
            messages: ok
        })
        answer('"transId":"60311"', details("60311", "authorizedPendingCapture", {order: {invoiceNumber: reference}, authAmount: 31}))
        call(P + "get#SinglePaymentGatewayDetails", {paymentId})
        return {during, after: payment(paymentId)}
    },
    then({during, after}) {
        during.statusId == "PmntPromised" && during.paymentRefNum == null
        after.statusId == "PmntAuthorized"
        after.paymentRefNum == "60311"
    }
})

// Shop P6 (F85): one page per reference, and two approvals under one reference an exception
feature("Accept Hosted: a used reference gets no new form; a second approval under it is flagged", {
    when() {
        const paymentId = cardPayment(32, "ANET_SPEC_HOSTED")
        const returnUrl = "https://shop.example.test/Checkout/return?ref=3&key=" + "k".repeat(40)
        const auth = call(P + "authorize#SinglePayment", {paymentId, operationKey: "anet-h-3", returnUrl})
        const reference = response(auth.paymentGatewayResponseId).idempotencyKey.slice(0, 20)
        answer("pendingApproval", {messages: noRecords})
        answer("getUnsettledTransactionListRequest", {
            transactions: [{transId: "60400", invoiceNumber: reference, transactionStatus: "declined"}],
            totalNumInResultSet: 1,
            messages: ok
        })
        let refused = null
        ec.message.pushErrors()
        try {
            call(A + "get#HostedPaymentForm", {paymentId, returnUrl, merchantName: "Spec Store"})
        } catch (error) {
            refused = String(error.message)
        } finally {
            if (!refused && ec.message.hasError()) refused = ec.message.getErrorsString()
            ec.message.clearErrors()
            ec.message.popErrors()
        }
        const formsAsked = sent().filter(body => body.getHostedPaymentPageRequest).length
        // two pages paid: the lookup finds one approval, and the lists show another under the reference
        answer("transrefId", details("60401", "authorizedPendingCapture", {order: {invoiceNumber: reference}, authAmount: 32}))
        answer("pendingApproval", {messages: noRecords})
        answer("getUnsettledTransactionListRequest", {
            transactions: [
                {transId: "60402", invoiceNumber: reference, transactionStatus: "authorizedPendingCapture"},
                {transId: "60401", invoiceNumber: reference, transactionStatus: "authorizedPendingCapture"}
            ],
            totalNumInResultSet: 2,
            messages: ok
        })
        answer("getSettledBatchListRequest", {messages: noRecords})
        call(P + "get#SinglePaymentGatewayDetails", {paymentId})
        const flagged = Array.from(
            ec.entity
                .find("mantle.account.method.PaymentGatewayResponse")
                .condition({paymentId, reasonCode: "DUPLICATE_APPROVAL"})
                .list()
        )
        return {refused, formsAsked, flagged, after: payment(paymentId)}
    },
    then({refused, formsAsked, flagged, after}) {
        refused.includes("HOSTED_ALREADY_USED")
        formsAsked == 0
        after.paymentRefNum == "60401"
        flagged.length == 1
        flagged[0].resultSuccess == "N"
        flagged[0].reasonMessage.includes("60402")
    }
})

// Shop P6 (F40): the hosted profile page for a card kept outside a checkout, and the profile's read after it
feature("Accept Hosted profile page: a form token for a new customer profile; the sync keeps each new card once", {
    when() {
        const partyId = call("mantle.party.PartyServices.create#Person", {firstName: "Hana", lastName: "Hosted", roleTypeId: "Customer"}).partyId
        answer("createCustomerProfileRequest", {customerProfileId: "70100", messages: ok})
        answer("getHostedProfilePageRequest", {token: "spec-profile-token-1", messages: ok})
        const form = call(A + "get#HostedProfileForm", {
            partyId,
            paymentGatewayConfigId: "ANET_SPEC",
            returnUrl: "https://shop.example.test/shop/PaymentMethods/return?setup=1"
        })
        const profile = {
            profile: {
                customerProfileId: "70100",
                paymentProfiles: [{customerPaymentProfileId: "80100", payment: {creditCard: {cardNumber: "XXXX4242", cardType: "Visa"}}}]
            },
            messages: ok
        }
        answer("getCustomerProfileRequest", profile)
        const synced = call(A + "sync#CustomerProfile", {partyId, paymentGatewayConfigId: "ANET_SPEC"})
        answer("getCustomerProfileRequest", profile)
        const again = call(A + "sync#CustomerProfile", {partyId, paymentGatewayConfigId: "ANET_SPEC"})
        const requests = sent()
        return {
            form,
            synced,
            again,
            byMerchant: requests.find(body => body.getCustomerProfileRequest)?.getCustomerProfileRequest,
            methods: Array.from(
                ec.entity.find("mantle.account.method.PaymentMethod").condition({ownerPartyId: partyId}).disableAuthz().list()
            )
        }
    },
    then({form, synced, again, byMerchant, methods}) {
        form.fields.token == "spec-profile-token-1"
        form.formUrl == "https://test.authorize.net/customer/addPayment"
        byMerchant.merchantCustomerId != null
        synced.added == 1
        again.added == 0
        methods.length == 1
        methods[0].gatewayCimId == "80100"
        methods[0].description == "Card ending 4242"
    }
})

feature("no card number, browser token or secret is in a gateway response or a system message", {
    when() {
        // its own payment, kept card and notification, so the check stands alone
        const leakToken = token()
        answer("createCustomerProfileRequest", {
            customerProfileId: "70003",
            customerPaymentProfileIdList: ["80010"],
            messages: ok
        })
        answer("getCustomerPaymentProfileRequest", {
            paymentProfile: {payment: {creditCard: {cardNumber: "XXXX1111"}}},
            messages: ok
        })
        const leakParty = call("mantle.party.PartyServices.create#Person", {
            firstName: "Lee",
            lastName: "Kcheck",
            roleTypeId: "Customer"
        }).partyId
        const stored = call(A + "store#CustomerPaymentProfile", {
            partyId: leakParty,
            paymentGatewayConfigId: "ANET_SPEC",
            paymentToken: leakToken
        })
        const paymentId = cardPayment(42, "ANET_SPEC", {fromPartyId: leakParty, paymentMethodId: stored.paymentMethodId})
        answer("authOnlyTransaction", transaction("1", "60150"))
        call(P + "authorize#SinglePayment", {paymentId, cardSecurityCode: "999"})
        call(A + "receive#Webhook", {
            systemMessageTypeId: "AuthorizeNetWebhook",
            systemMessageRemoteId: "ANET_SPEC",
            messageText: JSON.stringify({
                notificationId: "spec-notification-leak",
                payload: {entityName: "transaction", id: "60150"}
            })
        })
        const responses = Array.from(
            ec.entity
                .find("mantle.account.method.PaymentGatewayResponse")
                .condition("paymentGatewayConfigId", "in", ["ANET_SPEC", "ANET_SPEC_SALE"])
                .list()
        ).map(row => JSON.stringify(row.getMap ? row.getMap() : row))
        const messages = Array.from(
            ec.entity.find("moqui.service.message.SystemMessage").condition("systemMessageRemoteId", "ANET_SPEC").list()
        ).map(row => String(row.messageText))
        const card = ec.entity.find("mantle.account.method.CreditCard").condition("paymentMethodId", stored.paymentMethodId).one()
        const forbidden = tokensSent.concat(SECRETS, ["4111111111111111", "spec-opaque-refused"])
        const found = (texts, label) =>
            texts.flatMap(text => forbidden.filter(value => text.includes(value)).map(value => label + ": " + value))
        return {
            responseCount: responses.length,
            messageCount: messages.length,
            card,
            leaks: found(responses, "response").concat(
                found(messages, "message"),
                found([JSON.stringify(card.getMap ? card.getMap() : card)], "card")
            )
        }
    },
    then({responseCount, messageCount, card, leaks}) {
        responseCount >= 2
        messageCount >= 1
        card.cardNumber == "XXXX1111" && card.cardSecurityCode == null
        leaks.length == 0
    }
})

feature("Shop P7: a renewal charges the kept profile with the stored-credential indicators, also on an Accept Hosted gateway", {
    when() {
        const card = ec.resource
            .script("component://mr-mantle/service/mantle/ext/account/gateway/GatewayLib.js")
            .createCardMethod(customerId, {paymentGatewayConfigId: "ANET_SPEC_HOSTED", gatewayCimId: "80070", gatewayCustomerId: "70070"}, "1111", "CctVisa")
        const paymentId = cardPayment(12, "ANET_SPEC_HOSTED", {paymentMethodId: card})
        answer("authOnlyTransaction", transaction("1", "60070"))
        const auth = call(P + "authorize#SinglePayment", {
            paymentId,
            operationKey: "shop-renew-" + paymentId,
            storedCredential: {kind: "recurring", originalNetworkTransId: "NTI-FIRST-1", originalAuthAmount: "12"}
        })
        const request = requestOf(sent()[0]).transactionRequest
        // a customer-initiated profile charge sends none of them
        const plainId = cardPayment(5, "ANET_SPEC", {paymentMethodId: card})
        call("update#mantle.account.method.PaymentMethod", {paymentMethodId: card, paymentGatewayConfigId: "ANET_SPEC"})
        answer("authOnlyTransaction", transaction("1", "60071"))
        call(P + "authorize#SinglePayment", {paymentId: plainId})
        return {auth: response(auth.paymentGatewayResponseId), request, keys: Object.keys(request), plain: requestOf(sent()[1]).transactionRequest}
    },
    then({auth, request, keys, plain}) {
        auth.resultSuccess == "Y"
        request.profile.customerProfileId == "70070"
        request.processingOptions.isSubsequentAuth == "true"
        request.processingOptions.isStoredCredentials == "true"
        request.subsequentAuthInformation.originalNetworkTransId == "NTI-FIRST-1"
        request.subsequentAuthInformation.originalAuthAmount == "12.00" || request.subsequentAuthInformation.originalAuthAmount == "12"
        request.authorizationIndicatorType.authorizationIndicator == "pre"
        // the schema's order: after the order and the customer's facts
        keys.indexOf("processingOptions") > keys.indexOf("order")
        keys.indexOf("subsequentAuthInformation") > keys.indexOf("processingOptions")
        keys.indexOf("authorizationIndicatorType") == keys.length - 1
        plain.processingOptions == null
    }
})
