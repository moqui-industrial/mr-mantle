// The PayTrace gateway (plan/payments-shipping-edi.md P2, PayTraceServices.xml and PayTrace.js) through Mantle's payment
// services, with the HTTP fixtures answering its JSON API v3 calls with sanitized answers shaped as the v3 OpenAPI
// schema's (the "data" wrapper, response codes, error lists, batch items): approval, decline, capture, void, a settled
// refund and a refund before settlement, vault customers, a lost answer resolved by the lookup of its reference (found,
// and not found), the OAuth token cached and renewed once after a 401, order and invoice lines mapped to enhanced data
// with their totals, rejected enhanced data recorded and sent again without a second charge, and the Protect.js browser
// endpoints. No card number, token or secret reaches a gateway response, a payment method or a card record. New spec, no
// Groovy original.
const vendorId = "ORG_ZIZI_RETAIL"
const P = "mantle.account.PaymentServices."
const T = "mantle.ext.account.gateway.PayTraceServices."
const BASE = "https://api.sandbox.paytrace.com"
const SECRETS = ["spec-api-password"]
const TOKEN_CACHE = "mantle.ext.account.gateway.PayTrace.accessToken"
const http = ec.factory.getTool("HttpFixtures")
let customerId, productId, addressId
let tokenCount = 0
const tokensSent = []

spec({
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        call("create#moqui.service.message.SystemMessageRemote", {
            systemMessageRemoteId: "PT_SPEC",
            description: "PayTrace spec sandbox",
            sendUrl: BASE,
            usageCode: "T",
            username: "spec-api-user",
            password: SECRETS[0]
        })
        for (const [id, authorize, capture] of [
            ["PT_SPEC", "authorize#Payment", "capture#Payment"],
            ["PT_SPEC_SALE", "authorizeAndCapture#Payment", null]
        ]) {
            call("create#mantle.account.method.PaymentGatewayConfig", {
                paymentGatewayConfigId: id,
                paymentGatewayTypeEnumId: "PgtPayTrace",
                description: "PayTrace spec " + id,
                systemMessageRemoteId: "PT_SPEC",
                authorizeServiceName: T + authorize,
                captureServiceName: capture ? T + capture : null,
                releaseServiceName: T + "release#Payment",
                refundServiceName: T + "refund#Payment",
                detailsServiceName: T + "get#PaymentGatewayDetails"
            })
            call("create#mantle.account.method.PaymentGatewayPayTrace", {
                paymentGatewayConfigId: id,
                merchantId: "9999",
                integratorId: "specintegr01",
                currencyUomId: "USD",
                lookupGraceSeconds: 0,
                sendEnhancedData: "Y",
                commodityCode: "SPEC-100",
                defaultUnitOfMeasure: "PCE"
            })
        }
        customerId = call("mantle.party.PartyServices.create#Person", {
            firstName: "Pat",
            lastName: "Tracespec",
            roleTypeId: "Customer"
        }).partyId
        productId = call("create#mantle.product.Product", {
            productName: "Spec widget",
            pseudoId: "PTW-1",
            productTypeEnumId: "PtAsset"
        }).productId
        call("create#mantle.product.ProductIdentification", {
            productId,
            productIdTypeEnumId: "PidtCommodityCode",
            idValue: "4321"
        })
        addressId = call("create#mantle.party.contact.ContactMech", {contactMechTypeEnumId: "CmtPostalAddress"}).contactMechId
        call("create#mantle.party.contact.PostalAddress", {
            contactMechId: addressId,
            address1: "1 Spec Street",
            city: "Salt Lake City",
            postalCode: "84101",
            countryGeoId: "USA"
        })
        http.enable()
        ec.artifactExecution.enableAuthz()
    },
    setup() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        // each feature asks for its own access token first
        ec.cache.getCache(TOKEN_CACHE).clear()
        accessToken()
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
        call("update#moqui.service.message.SystemMessageRemote", {systemMessageRemoteId: "PT_SPEC", sendUrl: null})
        ec.artifactExecution.enableAuthz()
        http.reset()
        ec.cache.getCache(TOKEN_CACHE).clear()
    }
})

// ---- the provider's answers (sanitized, shaped as the v3 schema's: the data wrapper of every answer) ----

function reply(method, path, data, {status = 200, times = 1, bodyContains} = {}) {
    http.add({
        method,
        url: BASE + path,
        bodyContains,
        status,
        contentType: "application/json",
        body: JSON.stringify({status: status < 300 ? "success" : "error", status_code: status, data}),
        times
    })
}
function accessToken(times = 1) {
    const token = "spec-access-" + ++tokenCount
    tokensSent.push(token)
    reply(
        "POST",
        "/v3/token",
        {
            access_token: token,
            refresh_token: token + "-refresh",
            token_type: "Bearer",
            expires_in: 7200,
            refresh_expires_in: 86400
        },
        {status: 201, times}
    )
}
function approved(transactionId, code = 101) {
    return {
        response_code: code,
        response_message: "Your transaction was successfully approved.",
        transaction_id: transactionId,
        approval_code: "TAS123",
        approval_message: "  NO  MATCH - Approved and completed",
        avs_response: "No Match",
        csc_response: "",
        masked_card_number: "xxxxxxxxxxxx5439"
    }
}
const declined = transactionId => ({
    response_code: 102,
    response_message: "Your transaction was not approved.",
    transaction_id: transactionId,
    approval_code: "",
    approval_message: "    DECLINE - Do not honor",
    avs_response: "",
    csc_response: ""
})
const failure = (errorId, detail, type = "LOGIC") => [{detail, type, code: "CONSTRAINT", field: null, error_id: errorId}]
const batch = (transactionId, data, status = "success") => [
    {transaction_id: transactionId, status, status_code: status === "success" ? 200 : 422, data}
]
function transaction(transactionId, status, action, extra = {}) {
    return Object.assign(
        {
            transaction_id: transactionId,
            merchant_id: 9999,
            status,
            action,
            requested_amount: 20,
            settle_amount: 20,
            card_last4: "5439",
            card_brand: "VISA",
            approval_message: "APPROVAL TAS123",
            created_at: "2026-11-02T08:54:17.277000"
        },
        extra
    )
}
const readTx = (transactionId, data, times = 1) => reply("GET", "/v3/card/transaction/" + transactionId + "*", data, {times})
const lost = path => http.add({method: "POST", url: BASE + path, error: "operation timed out", times: 1})
// the enhanced data of a capture or sale goes once its transaction commits, on a service thread
const settled = () => ec.factory.waitWorkerPoolEmpty(100)
const capturableList = list => reply("GET", "/v3/card/transactions/capturable/9999*", list)
function protectToken() {
    const n = ++tokenCount
    const token = {hpf_token: "spec-hpf-" + n, enc_key: "spec-enc-" + n}
    tokensSent.push(token.hpf_token, token.enc_key)
    return token
}

// ---- records ----

const payment = paymentId => ec.entity.find("mantle.account.payment.Payment").condition("paymentId", paymentId).one()
const response = id =>
    ec.entity.find("mantle.account.method.PaymentGatewayResponse").condition("paymentGatewayResponseId", id).one()
const sent = () => Array.from(http.requests())
const paths = list => list.map(row => row.method + " " + row.url.replace(BASE, "").replace(/\?.*$/, "")).join()
const bodyOf = row => JSON.parse(row.body)
function cardPayment(amount, gatewayId = "PT_SPEC", fields = {}) {
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
const enhancedResponses = paymentId =>
    Array.from(
        ec.entity
            .find("mantle.account.method.PaymentGatewayResponse")
            .condition({paymentId, paymentOperationEnumId: "PgoLevel3Data"})
            .orderBy("paymentGatewayResponseId")
            .list()
    )
// An order of a widget line (3 at 10.00, a 3.00 discount and 2.16 tax), a service line (1 hour at 5.00), shipping 7.50,
// an order discount of 2.00, VAT (not in totals) and a cancelled line: 39.66 in all.
function makeOrder() {
    const orderId = call("create#mantle.order.OrderHeader", {
        statusId: "OrderPlaced",
        currencyUomId: "USD",
        entryDate: ec.user.nowTimestamp
    }).orderId
    call("create#mantle.order.OrderPart", {
        orderId,
        orderPartSeqId: "01",
        vendorPartyId: vendorId,
        customerPartyId: customerId,
        otherPartyOrderId: "PO-SPEC-77",
        postalContactMechId: addressId
    })
    const item = (orderItemSeqId, fields) =>
        call("create#mantle.order.OrderItem", Object.assign({orderId, orderItemSeqId, orderPartSeqId: "01"}, fields))
    item("01", {itemTypeEnumId: "ItemProduct", productId, quantity: 3, unitAmount: 10})
    item("02", {itemTypeEnumId: "ItemDiscount", parentItemSeqId: "01", quantity: 1, unitAmount: -3})
    item("03", {itemTypeEnumId: "ItemSalesTax", parentItemSeqId: "01", quantity: 1, unitAmount: 2.16})
    item("04", {
        itemTypeEnumId: "ItemProduct",
        itemDescription: "Setup service",
        quantity: 1,
        unitAmount: 5,
        quantityUomId: "TF_hr"
    })
    item("05", {itemTypeEnumId: "ItemShipping", itemDescription: "Ground", quantity: 1, unitAmount: 7.5})
    item("06", {itemTypeEnumId: "ItemDiscount", itemDescription: "Order discount", quantity: 1, unitAmount: -2})
    item("07", {itemTypeEnumId: "ItemVatTax", quantity: 1, unitAmount: 1})
    item("08", {itemTypeEnumId: "ItemProduct", productId, quantity: 2, quantityCancelled: 2, unitAmount: 10})
    return orderId
}
const enhancedOk = () => ({response_code: 170, response_message: "Enhanced data was successfully added."})
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

feature("a Protect.js token authorizes with the reference and the integrator id, and the capture captures it", {
    when() {
        const paymentId = cardPayment(20)
        reply("POST", "/v3/card/authorize/pt-protect", approved("70001"))
        const auth = call(P + "authorize#SinglePayment", {paymentId, paymentToken: protectToken(), operationKey: "pt-a-1"})
        const authorized = payment(paymentId)
        // capture#SinglePayment reads the authorization's status first
        readTx("70001", transaction("70001", "A", "auth_only"))
        reply(
            "POST",
            "/v3/card/batch/capture",
            batch("70001", {
                response_code: 112,
                response_message: "Your transaction was successfully captured.",
                transaction_id: "70001"
            })
        )
        const capture = call(P + "capture#SinglePayment", {paymentId, operationKey: "pt-c-1"})
        const requests = sent()
        // a poll that still reads A/auth_only (PayTrace's status after a capture is not documented) leaves it Delivered
        readTx("70001", transaction("70001", "A", "auth_only"))
        call(P + "get#SinglePaymentGatewayDetails", {paymentId})
        return {
            auth: response(auth.paymentGatewayResponseId),
            authorized,
            capture: response(capture.paymentGatewayResponseId),
            after: payment(paymentId),
            requests
        }
    },
    then({auth, authorized, capture, after, requests}) {
        auth.resultSuccess == "Y" && auth.reasonCode == "101"
        auth.referenceNum == "70001" && auth.approvalCode == "TAS123"
        authorized.statusId == "PmntAuthorized" && authorized.paymentRefNum == "70001"
        // the token, then the authorization, then the capture with the same token (cached)
        paths(requests) ==
            "POST /v3/token,POST /v3/card/authorize/pt-protect,GET /v3/card/transaction/70001,POST /v3/card/batch/capture"
        requests[0].body.includes("grant_type=client_credentials")
        requests[0].headers["X-Integrator-Id"] == "specintegr01"
        requests[1].headers["Authorization"] == "[redacted]"
        requests[1].headers["X-Integrator-Id"] == "specintegr01"
        bodyOf(requests[1]).hpf_token == tokensSent[tokensSent.length - 2]
        bodyOf(requests[1]).merchant_id == 9999
        toDecimal(bodyOf(requests[1]).amount).eq(20)
        bodyOf(requests[1]).invoice_number == auth.idempotencyKey
        bodyOf(requests[1]).description.startsWith(auth.idempotencyKey + " Payment ")
        bodyOf(requests[1]).csc == null
        requests[2].url.endsWith("?merchant_id=9999")
        bodyOf(requests[3]).batch_items[0].transaction_id == "70001"
        toDecimal(bodyOf(requests[3]).batch_items[0].amount).eq(20)
        capture.resultSuccess == "Y" && capture.reasonCode == "112"
        after.statusId == "PmntDelivered"
    }
})

feature("a decline, a fraud block and a bad card number are refusals of their kinds", {
    when() {
        const declinedId = cardPayment(21)
        reply("POST", "/v3/card/authorize/pt-protect", declined("70010"))
        const decline = call(P + "authorize#SinglePayment", {paymentId: declinedId, paymentToken: protectToken()})
        const blockedId = cardPayment(22)
        reply(
            "POST",
            "/v3/card/authorize/pt-protect",
            failure("779", "BLOCKED - This card number has been blocked to prevent potential fraud."),
            {status: 400}
        )
        const blocked = call(P + "authorize#SinglePayment", {paymentId: blockedId, paymentToken: protectToken()})
        const badId = cardPayment(23)
        reply(
            "POST",
            "/v3/card/authorize/pt-protect",
            failure("35", "Please provide a valid Credit Card Number.", "VALIDATION"),
            {status: 422}
        )
        const bad = call(P + "authorize#SinglePayment", {paymentId: badId, paymentToken: protectToken()})
        return {
            decline: response(decline.paymentGatewayResponseId),
            declinedPayment: payment(declinedId),
            blocked: response(blocked.paymentGatewayResponseId),
            bad: response(bad.paymentGatewayResponseId)
        }
    },
    then({decline, declinedPayment, blocked, bad}) {
        decline.resultDeclined == "Y" && decline.reasonCode == "102" && decline.referenceNum == "70010"
        declinedPayment.statusId == "PmntDeclined"
        blocked.resultDeclined == "Y" && blocked.reasonCode == "779"
        bad.resultBadCardNumber == "Y" && bad.resultDeclined == "N" && bad.reasonCode == "35"
    }
})

feature("an answer without a response code is unknown; a capture refused while no longer capturable was already done", {
    when() {
        const shapelessId = cardPayment(51)
        reply("POST", "/v3/card/authorize/pt-protect", {})
        const shapeless = call(P + "authorize#SinglePayment", {paymentId: shapelessId, paymentToken: protectToken()})
        const blocked = call(P + "authorize#SinglePayment", {paymentId: shapelessId, paymentToken: protectToken()})
        const validationId = cardPayment(52)
        // the API's request validation answers {detail: [...]}
        http.add({
            method: "POST",
            url: BASE + "/v3/card/authorize/pt-protect",
            status: 422,
            contentType: "application/json",
            body: JSON.stringify({detail: [{loc: ["body", "amount"], msg: "field required", type: "value_error.missing"}]}),
            times: 1
        })
        const validation = call(P + "authorize#SinglePayment", {paymentId: validationId, paymentToken: protectToken()})
        // 816 on a capture whose record still reads A/auth_only: not capturable any more, so it was captured
        const doneId = cardPayment(53)
        reply("POST", "/v3/card/authorize/pt-protect", approved("70130"))
        call(P + "authorize#SinglePayment", {paymentId: doneId, paymentToken: protectToken()})
        readTx("70130", transaction("70130", "A", "auth_only"), 2)
        reply(
            "POST",
            "/v3/card/batch/capture",
            batch("70130", failure("816", "The Transaction ID that you provided could not be captured.")[0], "error"),
            {status: 422}
        )
        capturableList([])
        const done = call(P + "capture#SinglePayment", {paymentId: doneId})
        // still capturable: the refusal stands
        const openId = cardPayment(54)
        reply("POST", "/v3/card/authorize/pt-protect", approved("70131"))
        call(P + "authorize#SinglePayment", {paymentId: openId, paymentToken: protectToken()})
        readTx("70131", transaction("70131", "A", "auth_only"), 2)
        reply(
            "POST",
            "/v3/card/batch/capture",
            batch("70131", failure("816", "The Transaction ID that you provided could not be captured.")[0], "error"),
            {status: 422}
        )
        capturableList([transaction("70131", "A", "auth_only")])
        const refused = call(P + "capture#SinglePayment", {paymentId: openId})
        return {
            shapeless: response(shapeless.paymentGatewayResponseId),
            blocked,
            validation: response(validation.paymentGatewayResponseId),
            done: response(done.paymentGatewayResponseId),
            donePayment: payment(doneId),
            refused: response(refused.paymentGatewayResponseId),
            openPayment: payment(openId)
        }
    },
    then({shapeless, blocked, validation, done, donePayment, refused, openPayment}) {
        shapeless.resultUnknown == "Y" && shapeless.resultError == "N"
        blocked.reasonCode == "GATEWAY_OUTCOME_UNKNOWN"
        validation.resultError == "Y" && validation.reasonMessage.includes("body.amount field required")
        done.resultSuccess == "Y" && done.reasonCode == "ALREADY_CAPTURED"
        donePayment.statusId == "PmntDelivered"
        refused.resultError == "Y" && refused.reasonCode == "816"
        openPayment.statusId == "PmntAuthorized"
    }
})

feature("a release voids the authorization, and a void PayTrace refuses as already voided is a success", {
    when() {
        const paymentId = cardPayment(24)
        reply("POST", "/v3/card/authorize/pt-protect", approved("70020"))
        call(P + "authorize#SinglePayment", {paymentId, paymentToken: protectToken()})
        reply(
            "POST",
            "/v3/card/batch/void",
            batch("70020", {
                response_code: 109,
                response_message: "Your transaction was successfully voided.",
                transaction_id: "70020"
            })
        )
        const release = call(P + "release#SinglePayment", {paymentId})
        const voidRequest = bodyOf(sent()[2])
        const againId = cardPayment(25)
        reply("POST", "/v3/card/authorize/pt-protect", approved("70021"))
        call(P + "authorize#SinglePayment", {paymentId: againId, paymentToken: protectToken()})
        reply(
            "POST",
            "/v3/card/batch/void",
            batch("70021", failure("818", "The Transaction ID that you provided could not be voided.")[0], "error"),
            {status: 422}
        )
        readTx("70021", transaction("70021", "V", "auth_only"))
        const already = call(P + "release#SinglePayment", {paymentId: againId})
        return {
            release: response(release.paymentGatewayResponseId),
            voidRequest,
            after: payment(paymentId),
            already: response(already.paymentGatewayResponseId),
            againAfter: payment(againId)
        }
    },
    then({release, voidRequest, after, already, againAfter}) {
        release.resultSuccess == "Y" && release.reasonCode == "109"
        voidRequest.merchant_id == 9999 && voidRequest.batch_items[0].transaction_id == "70020"
        after.statusId == "PmntPromised" && after.paymentRefNum == null
        already.resultSuccess == "Y" && already.reasonCode == "ALREADY_VOIDED"
        againAfter.statusId == "PmntPromised"
    }
})

feature("a settled sale refunds linked by a refund authorization; before settlement the whole is voided and a part refused", {
    when() {
        const settledId = cardPayment(40, "PT_SPEC_SALE")
        reply("POST", "/v3/card/sale/pt-protect", approved("70030"))
        call(P + "authorize#SinglePayment", {paymentId: settledId, paymentToken: protectToken()})
        const sold = payment(settledId)
        readTx("70030", transaction("70030", "S", "sale", {requested_amount: 40, settle_amount: 40}))
        reply("POST", "/v3/card/refund-auth/by-transaction/70030", approved("70031", 106))
        const settledRefund = call(P + "refund#SinglePayment", {paymentId: settledId, amount: 15, operationKey: "pt-r-1"})
        const refundRequest = sent().find(row => row.url.includes("/refund-auth/"))

        const unsettledId = cardPayment(30, "PT_SPEC_SALE")
        reply("POST", "/v3/card/sale/pt-protect", approved("70040"))
        call(P + "authorize#SinglePayment", {paymentId: unsettledId, paymentToken: protectToken()})
        readTx("70040", transaction("70040", "A", "sale", {requested_amount: 30, settle_amount: 30}), 2)
        const partial = call(P + "refund#SinglePayment", {paymentId: unsettledId, amount: 10})
        reply(
            "POST",
            "/v3/card/batch/void",
            batch("70040", {
                response_code: 109,
                response_message: "Your transaction was successfully voided.",
                transaction_id: "70040"
            })
        )
        const whole = call(P + "refund#SinglePayment", {paymentId: unsettledId, amount: 30})
        return {
            sold,
            settledRefund: response(settledRefund.paymentGatewayResponseId),
            refundPayment: payment(settledRefund.refundPaymentId),
            refundRequest,
            partial: response(partial.paymentGatewayResponseId),
            partialRefundId: partial.refundPaymentId,
            whole: response(whole.paymentGatewayResponseId),
            wholeRefund: payment(whole.refundPaymentId),
            original: payment(unsettledId)
        }
    },
    then({sold, settledRefund, refundPayment, refundRequest, partial, partialRefundId, whole, wholeRefund, original}) {
        sold.statusId == "PmntDelivered" && sold.paymentRefNum == "70030"
        settledRefund.resultSuccess == "Y" && settledRefund.reasonCode == "106" && settledRefund.referenceNum == "70031"
        toDecimal(bodyOf(refundRequest).amount).eq(15)
        bodyOf(refundRequest).invoice_number == settledRefund.idempotencyKey
        refundPayment.statusId == "PmntDelivered" && refundPayment.paymentRefNum == "70031"
        partial.resultError == "Y" && partial.reasonCode == "REFUND_BEFORE_SETTLEMENT"
        partialRefundId == null
        whole.resultSuccess == "Y" && whole.reasonCode == "VOID_BEFORE_SETTLEMENT"
        whole.referenceNum == null && whole.altReference == "70040"
        wholeRefund.statusId == "PmntDelivered" && wholeRefund.paymentRefNum == null
        original.statusId == "PmntDelivered"
    }
})

feature("a vault customer made from a Protect.js token is used for later payments and deleted with its method", {
    when() {
        reply("POST", "/v3/customer/create/pt-protect", {
            response_code: 160,
            status_message: "The customer profile for mantle was successfully created.",
            customer_id: 81001
        })
        reply("GET", "/v3/customer/81001", {
            customer_id: 81001,
            merchant_id: 9999,
            customer_label: "x",
            card_masked: "xxxxxxxxxxxx5439",
            exp_month: "12",
            exp_year: "29"
        })
        const stored = call(T + "store#CustomerPaymentProfile", {
            partyId: customerId,
            paymentGatewayConfigId: "PT_SPEC",
            paymentToken: protectToken()
        })
        const createRequest = bodyOf(sent()[1])
        const method = ec.entity
            .find("mantle.account.method.PaymentMethod")
            .condition("paymentMethodId", stored.paymentMethodId)
            .one()
        const card = ec.entity.find("mantle.account.method.CreditCard").condition("paymentMethodId", stored.paymentMethodId).one()
        const paymentId = cardPayment(26, "PT_SPEC", {paymentMethodId: stored.paymentMethodId})
        reply("POST", "/v3/card/authorize/customer/81001", approved("70050"))
        const auth = call(P + "authorize#SinglePayment", {paymentId, cardSecurityCode: "999"})
        const vaultRequest = sent()[3]
        // a second card, with no payments, is deleted with its method
        reply("POST", "/v3/customer/create/pt-protect", {response_code: 160, status_message: "created", customer_id: 81003})
        reply("GET", "/v3/customer/81003", {customer_id: 81003, card_masked: "xxxxxxxxxxxx0057", exp_month: "02", exp_year: "29"})
        const second = call(T + "store#CustomerPaymentProfile", {
            partyId: customerId,
            paymentGatewayConfigId: "PT_SPEC",
            paymentToken: protectToken()
        })
        reply("DELETE", "/v3/customer/81003", {
            response_code: 162,
            status_message: "The customer profile was successfully deleted.",
            customer_id: 81003
        })
        call("mantle.account.PaymentMethodServices.delete#PaymentMethod", {paymentMethodId: second.paymentMethodId})
        const deleted = ec.entity
            .find("mantle.account.method.PaymentMethod")
            .condition("paymentMethodId", second.paymentMethodId)
            .one()
        return {
            stored,
            createRequest,
            method,
            card,
            auth: response(auth.paymentGatewayResponseId),
            vaultRequest,
            deleteRequest: sent()[6],
            deleted
        }
    },
    then({stored, createRequest, method, card, auth, vaultRequest, deleteRequest, deleted}) {
        createRequest.customer_label == "mantle-" + stored.paymentMethodId
        createRequest.billing_address.name == "Pat Tracespec"
        method.gatewayCimId == "81001" && method.gatewayCustomerId == "mantle-" + stored.paymentMethodId
        method.paymentGatewayConfigId == "PT_SPEC"
        card.cardNumber == "XXXX5439" && card.expireDate == "12/2029" && card.cardSecurityCode == null
        auth.resultSuccess == "Y"
        vaultRequest.url == BASE + "/v3/card/authorize/customer/81001"
        bodyOf(vaultRequest).hpf_token == null && bodyOf(vaultRequest).csc == null
        deleteRequest.method == "DELETE" && deleteRequest.url == BASE + "/v3/customer/81003"
        deleted.thruDate != null && deleted.gatewayCimId == null
    }
})

feature("a lost answer is unknown and blocks a new charge; the lookup finds it by its reference, or not and it is sent again", {
    when() {
        const paymentId = cardPayment(27)
        lost("/v3/card/authorize/pt-protect")
        const first = call(P + "authorize#SinglePayment", {paymentId, paymentToken: protectToken(), operationKey: "pt-u-1"})
        const lostResponse = response(first.paymentGatewayResponseId)
        const blocked = call(P + "authorize#SinglePayment", {paymentId, paymentToken: protectToken(), operationKey: "pt-u-2"})
        const key = lostResponse.idempotencyKey
        reply(
            "POST",
            "/v3/transactions/export/by-date",
            {
                response_code: 1,
                status_message: "",
                transactions: [
                    {transaction_id: "70059", description: "another payment", approval_code: "OTHER1"},
                    {transaction_id: "70060", description: key + " Payment " + paymentId, approval_code: "TAS777", amount: 27}
                ]
            },
            {times: 1}
        )
        readTx("70060", transaction("70060", "A", "auth_only", {requested_amount: 27, invoice_number: key}))
        call(P + "get#SinglePaymentGatewayDetails", {paymentId})
        const lookup = sent().slice(2)
        const exportBody = bodyOf(lookup[0])

        // another lost authorization found nowhere: not done, and sent again with the same key
        const notId = cardPayment(28)
        const params = {paymentId: notId, paymentToken: protectToken(), operationKey: "pt-n-1"}
        lost("/v3/card/authorize/pt-protect")
        const lostAgain = call(P + "authorize#SinglePayment", params)
        // the export answers error 180 when nothing matches
        reply("POST", "/v3/transactions/export/by-date", failure("180", "No transactions were found with these criteria."), {
            status: 422
        })
        call(P + "get#SinglePaymentGatewayDetails", {paymentId: notId})
        const notDone = payment(notId)
        reply("POST", "/v3/card/authorize/pt-protect", approved("70061"))
        const again = call(P + "authorize#SinglePayment", Object.assign({}, params, {paymentToken: protectToken()}))
        return {
            lostResponse,
            blocked,
            resolved: response(first.paymentGatewayResponseId),
            after: payment(paymentId),
            lookup: paths(lookup),
            exportBody,
            datesOk: [exportBody.start_date, exportBody.end_date].every(text => /^\d\d\/\d\d\/\d{4}$/.test(text)),
            key,
            notFound: response(lostAgain.paymentGatewayResponseId),
            notDone,
            again: response(again.paymentGatewayResponseId),
            sentAgain: payment(notId)
        }
    },
    then({lostResponse, blocked, resolved, after, lookup, exportBody, datesOk, key, notFound, notDone, again, sentAgain}) {
        lostResponse.resultUnknown == "Y" && lostResponse.resultError == "N"
        lostResponse.reasonMessage.includes("No answer")
        blocked.reasonCode == "GATEWAY_OUTCOME_UNKNOWN"
        lookup == "POST /v3/transactions/export/by-date,GET /v3/card/transaction/70060"
        exportBody.including_text == key
        datesOk
        resolved.outcomeFound == "Y" && resolved.outcomeResolvedDate != null
        after.statusId == "PmntAuthorized" && after.paymentRefNum == "70060" && after.paymentAuthCode == "TAS777"
        notFound.outcomeFound == "N" && notFound.outcomeResolvedDate != null
        notDone.statusId == "PmntPromised"
        again.idempotencyKey == notFound.idempotencyKey && again.resultSuccess == "Y"
        sentAgain.statusId == "PmntAuthorized"
    }
})

feature("a duplicate block is unknown, and a lost capture is found captured on the authorization's transaction", {
    when() {
        const paymentId = cardPayment(29)
        reply(
            "POST",
            "/v3/card/authorize/pt-protect",
            failure(
                "777",
                "PayTrace blocked this transaction because it is a duplicate, and it may be reprocessed in 5 minute(s)."
            ),
            {status: 400}
        )
        const duplicate = call(P + "authorize#SinglePayment", {paymentId, paymentToken: protectToken(), operationKey: "pt-d-1"})
        const key = response(duplicate.paymentGatewayResponseId).idempotencyKey
        reply("POST", "/v3/transactions/export/by-date", {
            response_code: 1,
            status_message: "",
            transactions: [{transaction_id: "70070", description: key + " Payment " + paymentId, approval_code: "TAS070"}]
        })
        readTx("70070", transaction("70070", "A", "auth_only", {invoice_number: key}))
        call(P + "get#SinglePaymentGatewayDetails", {paymentId})
        const found = payment(paymentId)
        readTx("70070", transaction("70070", "A", "auth_only"))
        lost("/v3/card/batch/capture")
        const capture = call(P + "capture#SinglePayment", {paymentId})
        // the record still reads A/auth_only, and PayTrace no longer lists it as capturable: captured
        readTx("70070", transaction("70070", "A", "auth_only"))
        capturableList([])
        call(P + "get#SinglePaymentGatewayDetails", {paymentId})
        return {
            duplicate: response(duplicate.paymentGatewayResponseId),
            found,
            capture: response(capture.paymentGatewayResponseId),
            after: payment(paymentId)
        }
    },
    then({duplicate, found, capture, after}) {
        duplicate.resultUnknown == "Y" && duplicate.reasonCode == "777" && duplicate.outcomeFound == "Y"
        found.statusId == "PmntAuthorized" && found.paymentRefNum == "70070"
        capture.resultUnknown == "Y" && capture.outcomeFound == "Y"
        after.statusId == "PmntDelivered"
    }
})

feature("the access token is cached; a 401 gets a new token and is sent once more, without a second charge", {
    when() {
        // the token of setup() is used for both payments: one token request
        const firstId = cardPayment(31)
        reply("POST", "/v3/card/authorize/pt-protect", approved("70080"))
        call(P + "authorize#SinglePayment", {paymentId: firstId, paymentToken: protectToken()})
        const secondId = cardPayment(32)
        reply("POST", "/v3/card/authorize/pt-protect", approved("70081"))
        call(P + "authorize#SinglePayment", {paymentId: secondId, paymentToken: protectToken()})
        const cached = paths(sent())
        // the cache keeps the token sealed: not readable in the Tools cache screen
        const tokenKey = "PT_SPEC|" + BASE + "|spec-api-user"
        const held = JSON.stringify(ec.cache.getCache(TOKEN_CACHE).get(tokenKey))
        const readable = tokensSent.filter(token => token.startsWith("spec-access-") && held.includes(token))
        http.clear()

        // the cached token is refused (expired or revoked): one new token, the authorization sent once more, approved once
        const renewedId = cardPayment(33)
        reply("POST", "/v3/card/authorize/pt-protect", [{detail: "invalid_token", type: "AUTH", code: "invalid_token"}], {
            status: 401
        })
        accessToken()
        reply("POST", "/v3/card/authorize/pt-protect", approved("70082"))
        const renewed = call(P + "authorize#SinglePayment", {paymentId: renewedId, paymentToken: protectToken()})
        const renewal = paths(sent())
        http.clear()

        // refused again with the new token: not sent a third time, and not done (an error, not an unknown outcome)
        const refusedId = cardPayment(34)
        reply("POST", "/v3/card/authorize/pt-protect", [{detail: "invalid_token", type: "AUTH", code: "invalid_token"}], {
            status: 401,
            times: 2
        })
        accessToken()
        const refused = call(P + "authorize#SinglePayment", {paymentId: refusedId, paymentToken: protectToken()})
        const refusal = paths(sent())
        http.clear()
        // and for a minute nothing is sent for that connection
        const backedOffId = cardPayment(36)
        const backedOff = call(P + "authorize#SinglePayment", {paymentId: backedOffId, paymentToken: protectToken()})
        const backedOffSent = sent().length

        // a token past its lifetime is not used: a new one is asked for first
        const cache = ec.cache.getCache(TOKEN_CACHE)
        for (const key of ["PT_SPEC|" + BASE + "|spec-api-user"])
            cache.put(key, {token: "spec-access-stale", expiresAt: Number(ec.user.nowTimestamp) - 1000})
        tokensSent.push("spec-access-stale")
        accessToken()
        const expiredId = cardPayment(35)
        reply("POST", "/v3/card/authorize/pt-protect", approved("70083"))
        call(P + "authorize#SinglePayment", {paymentId: expiredId, paymentToken: protectToken()})
        return {
            cached,
            renewed: response(renewed.paymentGatewayResponseId),
            renewal,
            renewedPayment: payment(renewedId),
            refused: response(refused.paymentGatewayResponseId),
            refusal,
            refusedPayment: payment(refusedId),
            backedOff: response(backedOff.paymentGatewayResponseId),
            backedOffSent,
            held,
            readable,
            expired: paths(sent())
        }
    },
    then({
        cached,
        renewed,
        renewal,
        renewedPayment,
        refused,
        refusal,
        refusedPayment,
        backedOff,
        backedOffSent,
        held,
        readable,
        expired
    }) {
        cached == "POST /v3/token,POST /v3/card/authorize/pt-protect,POST /v3/card/authorize/pt-protect"
        held.includes("sealed") && readable.length == 0
        backedOff.resultError == "Y" && backedOff.reasonMessage.includes("not sent again for a minute")
        backedOffSent == 0
        renewal == "POST /v3/card/authorize/pt-protect,POST /v3/token,POST /v3/card/authorize/pt-protect"
        renewed.resultSuccess == "Y" && renewed.referenceNum == "70082"
        renewedPayment.statusId == "PmntAuthorized"
        refusal == "POST /v3/card/authorize/pt-protect,POST /v3/token,POST /v3/card/authorize/pt-protect"
        refused.resultError == "Y" && refused.resultUnknown == "N"
        refused.reasonMessage.includes("HTTP 401")
        refusedPayment.statusId != "PmntAuthorized"
        expired == "POST /v3/token,POST /v3/card/authorize/pt-protect"
    }
})

feature("order lines map to level 3 enhanced data whose totals balance; invoice lines too; a partial payment sends level 2", {
    when() {
        const orderId = makeOrder()
        const paymentId = cardPayment(39.66, "PT_SPEC_SALE", {orderId, orderPartSeqId: "01"})
        reply("POST", "/v3/card/sale/pt-protect", approved("70090"))
        reply("PUT", "/v3/invoice/by-transaction-id/70090", enhancedOk())
        const sale = call(P + "authorize#SinglePayment", {paymentId, paymentToken: protectToken()})
        settled()
        const putOf = transactionId => sent().find(row => row.method == "PUT" && row.url.endsWith("/" + transactionId))
        const put = putOf("70090")
        const data = bodyOf(put)
        const lines = data.line_items
        const sum = lines.reduce((total, line) => total.add(toDecimal(line.item_total_amount)), toDecimal(0))
        const balance = sum
            .subtract(toDecimal(data.discount_amount))
            .add(toDecimal(data.freight_amount))
            .add(toDecimal(data.tax_amount))

        // an invoice with no customer PO: 2 at 12.50, 3 at 0.125 (0.38, finer than the currency) and 1.75 tax
        const invoiceId = call("create#mantle.account.invoice.Invoice", {
            invoiceTypeEnumId: "InvoiceSales",
            fromPartyId: vendorId,
            toPartyId: customerId,
            statusId: "InvoiceInProcess",
            currencyUomId: "USD",
            invoiceDate: ec.user.nowTimestamp
        }).invoiceId
        call("create#mantle.account.invoice.InvoiceItem", {
            invoiceId,
            invoiceItemSeqId: "01",
            itemTypeEnumId: "ItemProduct",
            productId,
            quantity: 2,
            amount: 12.5,
            description: "Spec widget pair"
        })
        call("create#mantle.account.invoice.InvoiceItem", {
            invoiceId,
            invoiceItemSeqId: "02",
            itemTypeEnumId: "ItemSalesTax",
            quantity: 1,
            amount: 1.75
        })
        call("create#mantle.account.invoice.InvoiceItem", {
            invoiceId,
            invoiceItemSeqId: "03",
            itemTypeEnumId: "ItemProduct",
            quantity: 3,
            amount: 0.125,
            description: "Spec washer"
        })
        const invoicePaymentId = cardPayment(27.13, "PT_SPEC_SALE", {forInvoiceId: invoiceId})
        reply("POST", "/v3/card/sale/pt-protect", approved("70091"))
        reply("PUT", "/v3/invoice/by-transaction-id/70091", enhancedOk())
        call(P + "authorize#SinglePayment", {paymentId: invoicePaymentId, paymentToken: protectToken()})
        settled()
        const invoiceData = bodyOf(putOf("70091"))

        // a payment of part of the order: its lines do not describe it, so level 2 only
        const partId = cardPayment(20, "PT_SPEC_SALE", {orderId, orderPartSeqId: "01"})
        reply("POST", "/v3/card/sale/pt-protect", approved("70092"))
        reply("PUT", "/v3/invoice/by-transaction-id/70092", enhancedOk())
        call(P + "authorize#SinglePayment", {paymentId: partId, paymentToken: protectToken()})
        settled()
        const partData = bodyOf(putOf("70092"))
        return {
            orderId,
            sale: response(sale.paymentGatewayResponseId),
            enhanced: enhancedResponses(paymentId),
            data,
            lines,
            balance,
            invoiceId,
            invoiceData,
            partData,
            partEnhanced: enhancedResponses(partId)
        }
    },
    then({orderId, sale, enhanced, data, lines, balance, invoiceId, invoiceData, partData, partEnhanced}) {
        sale.resultSuccess == "Y"
        enhanced.length == 1 && enhanced[0].resultSuccess == "Y" && enhanced[0].transactionStatus == "level3"
        enhanced[0].referenceNum == "70090" && enhanced[0].reasonCode == "170"
        data.customer_reference_id == "PO-SPEC-77"
        data.invoice_number == orderId
        toDecimal(data.tax_amount).eq(2.16)
        toDecimal(data.freight_amount).eq(7.5)
        toDecimal(data.discount_amount).eq(2)
        data.shipping_address.postal_code == "84101" && data.shipping_address.country == "US"
        data.merchant_tax_id == null && data.customer_tax_id == null
        // the widget (its discount and tax), the service line; not the VAT, the shipping or the cancelled line
        lines.length == 2
        lines[0].product_label == "Spec widget" && lines[0].product_code == "PTW-1" && lines[0].commodity_code == "4321"
        toDecimal(lines[0].quantity).eq(3) && toDecimal(lines[0].unit_cost).eq(10)
        toDecimal(lines[0].discount_amount).eq(3) && toDecimal(lines[0].item_total_amount).eq(27)
        toDecimal(lines[0].item_tax_amount).eq(2.16)
        lines[0].unit_of_measure == "PCE"
        lines[1].product_label == "Setup service" && lines[1].unit_of_measure == "HUR" && lines[1].commodity_code == "SPEC-100"
        toDecimal(lines[1].item_total_amount).eq(5)
        balance.eq(toDecimal(39.66))
        // no PO: the invoice id is the customer reference, which level 2 and 3 require
        invoiceData.invoice_number == invoiceId && invoiceData.customer_reference_id == invoiceId
        invoiceData.line_items.length == 2 && toDecimal(invoiceData.line_items[0].item_total_amount).eq(25)
        toDecimal(invoiceData.tax_amount).eq(1.75)
        // quantity times unit cost is the line's amount: 3 at 0.125 rounds to 0.38, sent as 1 at 0.38
        toDecimal(invoiceData.line_items[1].item_total_amount).eq(0.38)
        toDecimal(invoiceData.line_items[1].quantity).eq(1) && toDecimal(invoiceData.line_items[1].unit_cost).eq(0.38)
        toDecimal(invoiceData.line_items[0].quantity).eq(2) && toDecimal(invoiceData.line_items[0].unit_cost).eq(12.5)
        partData.line_items == null && partData.tax_amount == null && partData.customer_reference_id == "PO-SPEC-77"
        partEnhanced[0].transactionStatus == "level2" && partEnhanced[0].resultSuccess == "Y"
    }
})

feature("rejected enhanced data is recorded apart from the capture and sent again without charging again", {
    when() {
        const orderId = makeOrder()
        const paymentId = cardPayment(39.66, "PT_SPEC", {orderId, orderPartSeqId: "01"})
        reply("POST", "/v3/card/authorize/pt-protect", approved("70100"))
        call(P + "authorize#SinglePayment", {paymentId, paymentToken: protectToken()})
        readTx("70100", transaction("70100", "A", "auth_only", {requested_amount: 39.66}))
        reply(
            "POST",
            "/v3/card/batch/capture",
            batch("70100", {
                response_code: 112,
                response_message: "Your transaction was successfully captured.",
                transaction_id: "70100"
            })
        )
        reply(
            "PUT",
            "/v3/invoice/by-transaction-id/70100",
            [
                {
                    detail: "Please provide a valid Line Item Commodity Code.",
                    type: "VALIDATION",
                    code: "INVALID",
                    field: "body/line_items/1/commodity_code",
                    error_id: "201"
                }
            ],
            {status: 422}
        )
        const capture = call(P + "capture#SinglePayment", {paymentId})
        settled()
        const captured = payment(paymentId)
        const rejected = enhancedResponses(paymentId)
        // sent again by hand: accepted, and nothing else sent
        reply("PUT", "/v3/invoice/by-transaction-id/70100", enhancedOk())
        const resent = call(T + "send#EnhancedData", {paymentId})

        // a lost answer is an error to send again, never an unknown outcome blocking the payment; the job sends it again
        const otherId = cardPayment(39.66, "PT_SPEC", {orderId, orderPartSeqId: "01"})
        reply("POST", "/v3/card/authorize/pt-protect", approved("70101"))
        call(P + "authorize#SinglePayment", {paymentId: otherId, paymentToken: protectToken()})
        readTx("70101", transaction("70101", "A", "auth_only", {requested_amount: 39.66}))
        reply(
            "POST",
            "/v3/card/batch/capture",
            batch("70101", {
                response_code: 112,
                response_message: "Your transaction was successfully captured.",
                transaction_id: "70101"
            })
        )
        http.add({method: "PUT", url: BASE + "/v3/invoice/by-transaction-id/70101", error: "operation timed out", times: 1})
        call(P + "capture#SinglePayment", {paymentId: otherId})
        settled()
        const noAnswer = enhancedResponses(otherId)

        // a capture whose enhanced data was never sent (here: the gateway sent none then) is found by the job
        const setSend = value =>
            call("update#mantle.account.method.PaymentGatewayPayTrace", {
                paymentGatewayConfigId: "PT_SPEC",
                sendEnhancedData: value
            })
        setSend("N")
        const missingId = cardPayment(39.66, "PT_SPEC", {orderId, orderPartSeqId: "01"})
        reply("POST", "/v3/card/authorize/pt-protect", approved("70102"))
        call(P + "authorize#SinglePayment", {paymentId: missingId, paymentToken: protectToken()})
        readTx("70102", transaction("70102", "A", "auth_only", {requested_amount: 39.66}))
        reply(
            "POST",
            "/v3/card/batch/capture",
            batch("70102", {response_code: 112, response_message: "captured", transaction_id: "70102"})
        )
        call(P + "capture#SinglePayment", {paymentId: missingId})
        settled()
        const missingBefore = enhancedResponses(missingId).length
        setSend("Y")

        // a sale voided before settlement as its refund takes no enhanced data, by hand or by the job
        const voidedId = cardPayment(39.66, "PT_SPEC_SALE", {orderId, orderPartSeqId: "01"})
        reply("POST", "/v3/card/sale/pt-protect", approved("70103"))
        reply("PUT", "/v3/invoice/by-transaction-id/70103", failure("201", "Please provide a valid Line Item Commodity Code."), {
            status: 422
        })
        call(P + "authorize#SinglePayment", {paymentId: voidedId, paymentToken: protectToken()})
        settled()
        readTx("70103", transaction("70103", "A", "sale", {requested_amount: 39.66}))
        reply(
            "POST",
            "/v3/card/batch/void",
            batch("70103", {response_code: 109, response_message: "voided", transaction_id: "70103"})
        )
        call(P + "refund#SinglePayment", {paymentId: voidedId, amount: 39.66})
        const voidedRefused = refusal(T + "send#EnhancedData", {paymentId: voidedId})

        // the job: at most maxAttempts sends a payment (the lost one has had one), then again with the default
        reply("PUT", "/v3/invoice/by-transaction-id/70102", enhancedOk())
        const firstRun = call(T + "retry#EnhancedData", {maxAttempts: 1})
        reply("PUT", "/v3/invoice/by-transaction-id/70101", enhancedOk())
        const retried = call(T + "retry#EnhancedData", {})
        const charges = sent().filter(row => /\/batch\/capture|\/authorize\/|\/sale\//.test(row.url)).length
        const notCaptured = refusal(T + "send#EnhancedData", {paymentId: cardPayment(5)})
        return {
            capture: response(capture.paymentGatewayResponseId),
            captured,
            rejected,
            resent,
            after: enhancedResponses(paymentId),
            noAnswer,
            retried,
            otherAfter: enhancedResponses(otherId),
            other: payment(otherId),
            missingBefore,
            missingAfter: enhancedResponses(missingId),
            voidedRefused,
            voidedAfter: enhancedResponses(voidedId),
            firstRun,
            charges,
            notCaptured
        }
    },
    then({
        capture,
        captured,
        rejected,
        resent,
        after,
        noAnswer,
        retried,
        otherAfter,
        other,
        missingBefore,
        missingAfter,
        voidedRefused,
        voidedAfter,
        firstRun,
        charges,
        notCaptured
    }) {
        capture.resultSuccess == "Y" && capture.reasonCode == "112"
        captured.statusId == "PmntDelivered"
        rejected.length == 1 && rejected[0].resultError == "Y" && rejected[0].resultUnknown == "N"
        rejected[0].reasonCode == "ENHANCED_DATA_REJECTED" && rejected[0].responseCode == "201"
        rejected[0].reasonMessage.includes("Commodity Code")
        resent.sent && resent.accepted && resent.level == "level3"
        after.length == 2 && after[1].resultSuccess == "Y"
        noAnswer.length == 1 && noAnswer[0].reasonCode == "ENHANCED_DATA_NO_ANSWER" && noAnswer[0].resultUnknown == "N"
        // the first run sends only the capture that had none; the second the lost one
        firstRun.retried == 1 && firstRun.accepted == 1 && firstRun.failed == 0
        retried.retried == 1 && retried.accepted == 1 && retried.failed == 0
        otherAfter.length == 2 && otherAfter[1].resultSuccess == "Y"
        other.statusId == "PmntDelivered"
        missingBefore == 0 && missingAfter.length == 1 && missingAfter[0].resultSuccess == "Y"
        voidedRefused.includes("TRANSACTION_VOIDED")
        voidedAfter.length == 1 && voidedAfter[0].resultError == "Y"
        // three authorizations with their captures and a sale: no charge was sent again
        charges == 7
        notCaptured.includes("PAYMENT_NOT_CAPTURED")
    }
})

feature("a payer pays in the browser with a Protect.js token and keeps the card; another customer may not pay that payment", {
    when() {
        const ownId = cardPayment(36, "PT_SPEC", {fromPartyId: "CustJqp"})
        const othersId = cardPayment(36)
        login("joe@public.com")
        reply("POST", "/v3/payment-fields/token", {clientKey: "spec-client-key-1"})
        tokensSent.push("spec-client-key-1")
        const config = call(T + "get#BrowserPaymentConfig", {paymentId: ownId})
        reply("POST", "/v3/payment-fields/token", {clientKey: "spec-client-key-2"})
        tokensSent.push("spec-client-key-2")
        const rest = screenTest("rest").render("s1/mantle/my/payments/" + ownId + "/payTrace", null, "get")
        reply("POST", "/v3/customer/create/pt-protect", {response_code: 160, status_message: "created", customer_id: 81002})
        reply("GET", "/v3/customer/81002", {customer_id: 81002, card_masked: "xxxxxxxxxxxx5439", exp_month: "02", exp_year: "29"})
        reply("POST", "/v3/card/authorize/customer/81002", approved("70110"))
        const token = protectToken()
        const before = sent().length
        const paid = call(T + "submit#BrowserPaymentToken", {
            paymentId: ownId,
            hpfToken: token.hpf_token,
            encKey: token.enc_key,
            savePaymentMethod: true,
            operationId: "spec-page-0001"
        })
        const requests = paths(sent().slice(before))
        const refused = refusal(T + "get#BrowserPaymentConfig", {paymentId: othersId})
        const refusedSubmit = refusal(T + "submit#BrowserPaymentToken", {
            paymentId: othersId,
            hpfToken: "spec-hpf-refused",
            encKey: "spec-enc-refused"
        })
        tokensSent.push("spec-hpf-refused", "spec-enc-refused")
        login("john.doe")
        return {config, rest, paid, requests, refused, refusedSubmit, sentCount: sent().length - before, other: payment(othersId)}
    },
    then({config, rest, paid, requests, refused, refusedSubmit, sentCount, other}) {
        config.clientKey == "spec-client-key-1"
        config.protectJsUrl == "https://protect.sandbox.paytrace.com/js/protect.min.js"
        config.currencyUomId == "USD"
        rest.status == 200
        rest.output.includes("spec-client-key-2")
        !rest.output.includes(SECRETS[0]) && !rest.output.includes("spec-access-")
        paid.state == "approved" && paid.statusId == "PmntAuthorized" && paid.paymentMethodId != null
        requests == "POST /v3/customer/create/pt-protect,GET /v3/customer/81002,POST /v3/card/authorize/customer/81002"
        refused.includes("PERMISSION_DENIED")
        refusedSubmit.includes("PERMISSION_DENIED")
        sentCount == 3
        other.statusId == "PmntPromised"
    }
})

// The adapter logs only fixed text and reason codes, never a request or an answer; a run's console is checked for the
// same values by hand (plan P2 record).
feature("no card number, token or secret is in a gateway response, a payment method, a card record or a system message", {
    when() {
        // its own kept card and payment, so the check stands alone
        const leakParty = call("mantle.party.PartyServices.create#Person", {
            firstName: "Lee",
            lastName: "Kcheck",
            roleTypeId: "Customer"
        }).partyId
        reply("POST", "/v3/customer/create/pt-protect", {response_code: 160, status_message: "created", customer_id: 81009})
        reply("GET", "/v3/customer/81009", {customer_id: 81009, card_masked: "xxxxxxxxxxxx5439", exp_month: "02", exp_year: "29"})
        const stored = call(T + "store#CustomerPaymentProfile", {
            partyId: leakParty,
            paymentGatewayConfigId: "PT_SPEC",
            paymentToken: protectToken()
        })
        const paymentId = cardPayment(37, "PT_SPEC", {fromPartyId: leakParty, paymentMethodId: stored.paymentMethodId})
        reply("POST", "/v3/card/authorize/customer/81009", approved("70120"))
        call(P + "authorize#SinglePayment", {paymentId, cardSecurityCode: "999"})
        const responses = Array.from(
            ec.entity
                .find("mantle.account.method.PaymentGatewayResponse")
                .condition("paymentGatewayConfigId", "in", ["PT_SPEC", "PT_SPEC_SALE"])
                .list()
        ).map(row => JSON.stringify(row.getMap ? row.getMap() : row))
        const methods = Array.from(
            ec.entity
                .find("mantle.account.method.PaymentMethod")
                .condition("paymentGatewayConfigId", "in", ["PT_SPEC", "PT_SPEC_SALE"])
                .list()
        )
        const cards = Array.from(
            ec.entity
                .find("mantle.account.method.CreditCard")
                .condition("paymentMethodId", "in", methods.map(row => row.paymentMethodId).concat(["-"]))
                .list()
        ).map(row => JSON.stringify(row.getMap ? row.getMap() : row))
        const messages = Array.from(
            ec.entity.find("moqui.service.message.SystemMessage").condition("systemMessageRemoteId", "PT_SPEC").list()
        ).map(row => String(row.messageText))
        const forbidden = tokensSent.concat(SECRETS, ["4012000098765439"])
        const found = (texts, label) =>
            texts.flatMap(text => forbidden.filter(value => text.includes(value)).map(value => label + ": " + value))
        return {
            responseCount: responses.length,
            cardCount: cards.length,
            leaks: found(responses, "response").concat(
                found(
                    methods.map(row => JSON.stringify(row.getMap ? row.getMap() : row)),
                    "method"
                ),
                found(cards, "card"),
                found(messages, "message")
            )
        }
    },
    then({responseCount, cardCount, leaks}) {
        responseCount >= 2
        cardCount >= 1
        leaks.length == 0
    }
})
