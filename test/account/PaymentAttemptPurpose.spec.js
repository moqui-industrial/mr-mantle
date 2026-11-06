// Accounting's typed payment-attempt coordinator (AC-02, X9; mr-pass impl-shop P5, F13, F15, F32): each worker selects its
// own purpose, so Billing's job, result and refresh never touch a Shop checkout attempt and Shop's reconciliation never
// touches an invoice attempt; authorize#OrderPayments skips a promised payment whose attempt is unresolved and authorizes
// one with none as before; a hosted page's pending payment with no reference is looked up, and one with neither still has
// nothing to look up; the Payment hold is placed by the reconciliation (and a failed capture of a Shop payment after
// placement) and released only with PAYMENT_HOLD_RELEASE, a failed capture of any other payment holding nothing.
// Standalone: spec-local organization, customer, store, gateways, orders and payments. Run:
// ./moq test mr-mantle --spec PaymentAttemptPurpose
const T = "mantle.account.PaymentTestServices."
const prefix = "PAPUR"
const ids = {
    org: prefix + "_ORG",
    customer: prefix + "_CUST",
    store: prefix + "_STORE",
    approve: prefix + "_APPROVE",
    decline: prefix + "_DECLINECAP"
}
const state = {}
const sys = (name, parameters) => {
    const out = ec.service.sync().name(name).parameters(parameters).disableAuthz().call() || {}
    if (ec.message.hasError()) {
        const text = ec.message.getErrorsString()
        ec.message.clearErrors()
        throw new Error(text)
    }
    return out
}
const make = (entity, values) => sys("create#" + entity, values)
const one = (entity, fields) => ec.entity.find(entity).condition(fields).disableAuthz().one()
const list = (entity, fields) => Array.from(ec.entity.find(entity).condition(fields).disableAuthz().list())
// a call's refusal text, or "" when it succeeds, in its own transaction
function refusal(name, parameters, asUser) {
    if (!asUser) logout()
    ec.message.pushErrors()
    try {
        ec.service.sync().name(name).parameters(parameters).requireNewTransaction(true).disableAuthz().call()
        return ec.message.hasError() ? ec.message.getErrorsString() : ""
    } catch (error) {
        return String(error.message || error)
    } finally {
        ec.message.clearErrors()
        ec.message.popErrors()
        login("john.doe")
    }
}
function order() {
    return sys("mantle.order.OrderServices.create#Order", {
        productStoreId: ids.store,
        currencyUomId: "USD",
        vendorPartyId: ids.org,
        customerPartyId: ids.customer
    }).orderId
}
function payment(fields) {
    return make(
        "mantle.account.payment.Payment",
        Object.assign(
            {
                fromPartyId: ids.customer,
                toPartyId: ids.org,
                amount: "20.00",
                amountUomId: "USD",
                paymentTypeEnumId: "PtInvoicePayment",
                paymentInstrumentEnumId: "PiCreditCard",
                paymentGatewayConfigId: ids.approve,
                statusId: "PmntPromised",
                effectiveDate: ec.user.nowTimestamp
            },
            fields
        )
    ).paymentId
}
const attempt = (paymentId, purposeEnumId, fields) =>
    make(
        "mantle.account.payment.PortalPaymentAttempt",
        Object.assign({paymentId, purposeEnumId, createdDate: ec.user.nowTimestamp}, fields || {})
    )
// a pending authorization answer at the gateway (its lookup, alwaysApprove#PaymentDetails, approves it)
const pendingAuthorization = paymentId =>
    make("mantle.account.method.PaymentGatewayResponse", {
        paymentGatewayConfigId: ids.approve,
        paymentOperationEnumId: "PgoAuthorize",
        paymentId,
        amount: "20.00",
        amountUomId: "USD",
        referenceNum: "TEST-" + paymentId,
        transactionDate: ec.user.nowTimestamp,
        transactionStatus: "Pending",
        resultSuccess: "N",
        resultDeclined: "N",
        resultError: "N",
        resultUnknown: "N"
    })
const status = paymentId => one("mantle.account.payment.Payment", {paymentId}).statusId
const responses = paymentId => list("mantle.account.method.PaymentGatewayResponse", {paymentId})

spec({
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        make("mantle.party.Party", {partyId: ids.org, partyTypeEnumId: "PtyOrganization"})
        make("mantle.party.Organization", {partyId: ids.org, organizationName: "Attempt organization"})
        make("mantle.party.PartyRole", {partyId: ids.org, roleTypeId: "OrgInternal"})
        make("mantle.party.Party", {partyId: ids.customer, partyTypeEnumId: "PtyPerson"})
        make("mantle.party.Person", {partyId: ids.customer, firstName: "Attempt", lastName: "Customer"})
        make("mantle.party.PartyRole", {partyId: ids.customer, roleTypeId: "Customer"})
        make("mantle.product.store.ProductStore", {
            productStoreId: ids.store,
            storeName: "Attempt store",
            organizationPartyId: ids.org,
            defaultCurrencyUomId: "USD",
            requireInventory: "N"
        })
        for (const [id, capture] of [
            [ids.approve, "alwaysApprove"],
            [ids.decline, "alwaysDecline"]
        ])
            make("mantle.account.method.PaymentGatewayConfig", {
                paymentGatewayConfigId: id,
                paymentGatewayTypeEnumId: "PgtTest",
                description: "Attempt gateway " + id,
                authorizeServiceName: T + "alwaysApprove#PaymentAuthorization",
                captureServiceName: T + capture + "#PaymentCapture",
                detailsServiceName: T + "alwaysApprove#PaymentDetails"
            })
        state.methodId = make("mantle.account.method.PaymentMethod", {
            paymentMethodTypeEnumId: "PmtCreditCard",
            ownerPartyId: ids.customer,
            paymentGatewayConfigId: ids.approve,
            fromDate: ec.user.nowTimestamp
        }).paymentMethodId
        ec.artifactExecution.enableAuthz()
    },
    cleanup() {
        login("john.doe")
    }
})

feature("each worker selects its purpose: Billing never refreshes a Shop attempt, Shop never an invoice attempt", {
    when() {
        const shopPayment = payment({paymentRefNum: "TEST-SHOP"})
        attempt(shopPayment, "PapShopCheckout")
        pendingAuthorization(shopPayment)
        const invoicePayment = payment({paymentRefNum: "TEST-INVOICE"})
        attempt(invoicePayment, "PapInvoice")
        pendingAuthorization(invoicePayment)
        // Shop's reconciliation first: the invoice attempt stays as it is
        sys("mantle.order.ShopCheckoutServices.reconcile#Checkouts", {limit: 50})
        const afterShop = {shop: status(shopPayment), invoice: status(invoicePayment)}
        // Billing's job, refresh and result: its own attempt is looked up and captured, the Shop attempt never
        sys("mantle.account.PortalServices.resolve#PortalPayments", {limit: 500})
        const refreshed = sys("mantle.account.PortalServices.refresh#PortalPayment", {input: {paymentId: shopPayment}}).result
        let result
        try {
            result = ec.service
                .sync()
                .throwOnError(true)
                .name("mantle.account.PortalServices.get#PaymentResult")
                .parameters({input: {attemptId: shopPayment, siteId: "NONE", returnKey: "x".repeat(40)}})
                .disableAuthz()
                .call().result
        } catch (error) {
            ec.message.clearErrors()
            result = {errorKind: error.moquiErrorKind}
        }
        return {
            afterShop,
            shop: status(shopPayment),
            invoice: status(invoicePayment),
            refreshed,
            result,
            shopResponses: responses(shopPayment).filter(row => row.paymentOperationEnumId == "PgoTxDetails").length,
            shopAttempt: one("mantle.account.payment.PortalPaymentAttempt", {paymentId: shopPayment})
        }
    },
    then({afterShop, shop, invoice, refreshed, result, shopResponses, shopAttempt}) {
        afterShop.invoice == "PmntPromised"
        invoice == "PmntDelivered"
        shop == "PmntPromised"
        afterShop.shop == "PmntPromised"
        refreshed.statusId == null
        result.errorKind == "NotFound"
        shopResponses == 0
        shopAttempt.settledDate == null
    }
})

feature("authorize#OrderPayments skips a promised payment with an unresolved attempt; one with none is authorized as before", {
    when() {
        const orderId = order()
        const held = payment({orderId, orderPartSeqId: "01", paymentMethodId: state.methodId})
        attempt(held, "PapShopCheckout", {orderId})
        const plain = payment({orderId, orderPartSeqId: "01", paymentMethodId: state.methodId})
        const out = sys("mantle.account.PaymentServices.authorize#OrderPayments", {orderId})
        return {
            out,
            held: status(held),
            heldResponses: responses(held).length,
            plain: status(plain),
            plainResponses: responses(plain).length
        }
    },
    then({out, held, heldResponses, plain, plainResponses}) {
        held == "PmntPromised"
        heldResponses == 0
        plain == "PmntAuthorized"
        plainResponses == 1
        out.authFailed == false
    }
})

feature("a hosted page's pending payment with no reference is looked up; one with neither has nothing to look up", {
    when() {
        const hosted = payment({})
        make("mantle.account.method.PaymentGatewayResponse", {
            paymentGatewayConfigId: ids.approve,
            paymentOperationEnumId: "PgoAuthorize",
            paymentId: hosted,
            amount: "20.00",
            amountUomId: "USD",
            transactionDate: ec.user.nowTimestamp,
            transactionStatus: "HostedPending",
            resultSuccess: "N",
            resultDeclined: "N",
            resultError: "N",
            resultUnknown: "N"
        })
        const bare = payment({})
        ec.message.pushErrors()
        sys("mantle.account.PaymentServices.get#SinglePaymentGatewayDetails", {paymentId: hosted})
        const bareOut = ec.service
            .sync()
            .name("mantle.account.PaymentServices.get#SinglePaymentGatewayDetails")
            .parameters({paymentId: bare})
            .disableAuthz()
            .call()
        const bareMessages = ec.message.getMessagesString?.() || ""
        ec.message.clearErrors()
        ec.message.popErrors()
        return {hosted: status(hosted), bare: status(bare), bareResponses: responses(bare).length, bareOut}
    },
    then({hosted, bare, bareResponses}) {
        hosted == "PmntAuthorized"
        bare == "PmntPromised"
        bareResponses == 0
    }
})

feature(
    "the Payment hold is the reconciliation's to place and PAYMENT_HOLD_RELEASE's to release; a failed capture holds only a Shop payment",
    {
        when() {
            const holdType = one("moqui.basic.Enumeration", {enumId: "OhtPayment"})
            const adminGrant = list("moqui.security.UserGroupPermission", {
                userGroupId: "ADMIN",
                userPermissionId: "PAYMENT_HOLD_RELEASE"
            })
            const placed = () => {
                const orderId = order()
                sys("mantle.order.OrderServices.place#Order", {orderId})
                return orderId
            }
            // placed with no user's permission (as the reconciliation does), refused a release without the permission
            const orderId = placed()
            logout()
            const hold = ec.service
                .sync()
                .name("mantle.order.OrderServices.hold#Order")
                .parameters({orderId, holdTypeEnumId: "OhtPayment", holdComment: "Amount mismatch"})
                .disableAuthz()
                .call()
            login("john.doe")
            const reason = hold.orderHoldReasonId
            const heldStatus = one("mantle.order.OrderHeader", {orderId}).statusId
            const anonymous = refusal("mantle.order.OrderServices.release#OrderHold", {
                orderHoldReasonId: reason,
                releaseComment: "no"
            })
            const released = refusal(
                "mantle.order.OrderServices.release#OrderHold",
                {orderHoldReasonId: reason, releaseComment: "Reconciled"},
                true
            )
            // a Shop payment's capture declined after placement holds its order; another payment's does not
            const captured = withAttempt => {
                const capturedOrderId = placed()
                const paymentId = payment({
                    orderId: capturedOrderId,
                    orderPartSeqId: "01",
                    paymentGatewayConfigId: ids.decline,
                    statusId: "PmntAuthorized",
                    paymentRefNum: "TEST-CAP"
                })
                if (withAttempt)
                    attempt(paymentId, "PapShopCheckout", {orderId: capturedOrderId, settledDate: ec.user.nowTimestamp})
                sys("mantle.account.PaymentServices.capture#SinglePayment", {paymentId})
                return list("mantle.order.OrderHoldReason", {orderId: capturedOrderId}).filter(
                    row => row.holdTypeEnumId == "OhtPayment"
                ).length
            }
            return {
                holdType,
                adminGrant,
                heldStatus,
                anonymous,
                released,
                releasedStatus: one("mantle.order.OrderHeader", {orderId}).statusId,
                shopCaptureHolds: captured(true),
                otherCaptureHolds: captured(false)
            }
        },
        then({holdType, adminGrant, heldStatus, anonymous, released, releasedStatus, shopCaptureHolds, otherCaptureHolds}) {
            holdType.enumCode == "PAYMENT_HOLD_RELEASE"
            adminGrant.length == 1
            heldStatus == "OrderHold"
            anonymous.length > 0
            released == ""
            releasedStatus == "OrderPlaced"
            shopCaptureHolds == 1
            otherCaptureHolds == 0
        }
    }
)
