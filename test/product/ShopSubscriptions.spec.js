// Shop's prepaid and recurring access (mr-pass impl-shop P7; mantle.product.ShopSubscriptionServices over
// ShopSubscriptions.js; design-shop §10, §10.1, §10.2, review X5): a verified buyer subscribes with recorded off-session
// consent and the first term activates on the contract's own resource instance, while its RecurringTemplate base never
// reserves, invoices, emails or counts; two concurrent renewal jobs make one occurrence, one order and one charge, extending
// access from the paid boundary; no charge without consent; a declined renewal is retried with one notice and no extension;
// cancelling keeps the paid term; a refund revokes only the term it paid for; another recurring order keeps today's
// behaviour; a merge carries a contract but never its consent. Standalone: spec-local organization, store, site, gateways,
// product and accounts. Run: ./moq test mr-mantle --spec ShopSubscriptions
const R = "mantle.product.ShopSubscriptionServices."
const CHECKOUT = "mantle.order.ShopCheckoutServices."
const S = "mantle.product.store."
const SUB = "mantle.product.subscription."
const prefix = "SHSU"
const ids = {
    org: prefix + "_ORG",
    store: prefix + "_STORE",
    site: prefix + "_SITE",
    host: "shop.shsu.example.test",
    hosted: prefix + "_HOSTED",
    decline: prefix + "_DECLINE",
    product: prefix + "_MONTH",
    resource: prefix + "_RES",
    buyer: prefix + "_BUYER",
    unverified: prefix + "_UNVERIFIED",
    guest: prefix + "_GUEST",
    other: prefix + "_OTHER"
}
const make = (entity, values) => call("create#" + entity, values)
const one = (entity, fields) => ec.entity.find(entity).condition(fields).disableAuthz().one()
const list = (entity, fields) => Array.from(ec.entity.find(entity).condition(fields).disableAuthz().list())
function system(action) {
    login("john.doe")
    const was = ec.artifactExecution.disableAuthz()
    try {
        return action()
    } finally {
        if (!was) ec.artifactExecution.enableAuthz()
    }
}
// an operation as an account: {result} or {error}
function op(username, service, input) {
    login(username)
    ec.message.pushErrors()
    try {
        const out =
            ec.service
                .sync()
                .name(service)
                .parameters({input: Object.assign({siteId: ids.site}, input)})
                .call() || {}
        return ec.message.hasError() ? {error: ec.message.getErrorsString()} : {result: out.result}
    } catch (error) {
        return {error: String(error.message || error)}
    } finally {
        ec.message.clearErrors()
        ec.message.popErrors()
        login("john.doe")
    }
}
const code = out => (/([A-Z][A-Z0-9_]+):/.exec(out.error || "") || [])[1] || ""
function account(partyId, verified) {
    const email = partyId.toLowerCase() + "@shsu.example.test"
    make("mantle.party.Party", {partyId, partyTypeEnumId: "PtyPerson"})
    make("mantle.party.Person", {partyId, firstName: "Sub", lastName: partyId})
    make("mantle.party.PartyRole", {partyId, roleTypeId: "Customer"})
    make("moqui.security.UserAccount", {
        userId: partyId,
        username: partyId,
        partyId,
        emailAddress: email,
        currentPassword: "16ac58bbfa332c1c55bd98b53e60720bfa90d394",
        passwordHashType: "SHA",
        timeZone: "UTC"
    })
    if (verified)
        make("moqui.security.public.VerifiedAddress", {userId: partyId, emailAddress: email, verifiedAt: ec.user.nowTimestamp})
}
const contractOf = () => list(SUB + "StoreRecurringContract", {customerPartyId: ids.buyer})[0]
const occurrences = contractId => list(SUB + "StoreRenewalOccurrence", {contractId})
// the contract's next renewal due now (as if its paid term had reached its end)
const dueNow = contractId =>
    system(() =>
        call("update#" + SUB + "StoreRecurringContract", {
            contractId,
            nextRenewalDate: new Date(Number(ec.user.nowTimestamp) - 60000)
        })
    )
const state = {}

spec({
    stepwise: true,
    setupSpec() {
        system(() => {
            make("mantle.party.Party", {partyId: ids.org, partyTypeEnumId: "PtyOrganization"})
            make("mantle.party.Organization", {partyId: ids.org, organizationName: "Subscriptions organization"})
            make("mantle.party.PartyRole", {partyId: ids.org, roleTypeId: "OrgInternal"})
            make(S + "ProductStore", {
                productStoreId: ids.store,
                storeName: "Subscriptions store",
                organizationPartyId: ids.org,
                defaultCurrencyUomId: "USD",
                defaultLocale: "en_US",
                requireInventory: "N",
                defaultDisableShippingCalc: "Y"
            })
            // (a card kept from the hosted page carries no name, so the store's name check is off too: F-SP7-1)
            for (const settingTypeEnumId of [
                "PsstCheckoutTerms",
                "PsstOrdApproveNewCust",
                "PsstOrdApproveAddrMissing",
                "PsstOrdApprovePayMethNameDiff",
                // the renewals here come minutes after the purchase, not a term later
                "PsstOrdApproveSimilar"
            ])
                make(S + "ProductStoreSetting", {
                    productStoreId: ids.store,
                    settingTypeEnumId,
                    fromDate: 0,
                    settingValue: "false"
                })
            make("mantle.public.PublicSite", {
                siteId: ids.site,
                name: "Subscriptions site",
                state: "published",
                locale: "en",
                generation: 1
            })
            make("mantle.public.PublicSiteHost", {hostname: ids.host, siteId: ids.site, canonical: "Y"})
            make("mantle.public.PublicSiteApp", {
                siteId: ids.site,
                appMountId: "shop",
                app: "shop",
                pathPrefix: "/shop",
                enabled: "Y",
                targetId: ids.store
            })
            const T = "mantle.account.PaymentTestServices."
            // the store's card gateway: the payer pays on its hosted page; a kept card is charged off-session
            make("mantle.account.method.PaymentGatewayConfig", {
                paymentGatewayConfigId: ids.hosted,
                paymentGatewayTypeEnumId: "PgtTest",
                description: "Subscriptions hosted test gateway",
                authorizeServiceName: T + "hostedPendingOrApprove#PaymentAuthorization",
                captureServiceName: T + "alwaysApprove#PaymentCapture",
                detailsServiceName: T + "hostedOnlyApprove#PaymentDetails"
            })
            make("mantle.account.method.PaymentGatewayConfig", {
                paymentGatewayConfigId: ids.decline,
                paymentGatewayTypeEnumId: "PgtTest",
                description: "Subscriptions declining gateway",
                authorizeServiceName: T + "alwaysDecline#PaymentAuthorization"
            })
            for (const paymentGatewayConfigId of [ids.hosted, ids.decline])
                make("mantle.account.method.PaymentGatewayOrganization", {
                    organizationPartyId: ids.org,
                    paymentGatewayConfigId,
                    fromDate: 0,
                    isEnabled: "Y"
                })
            make(S + "ProductStorePaymentGateway", {
                productStoreId: ids.store,
                paymentInstrumentEnumId: "PiCreditCard",
                paymentGatewayConfigId: ids.hosted
            })
            // a month of the site's paid access, through the Forum's source-bound grants
            make(SUB + "SubscriptionResource", {
                subscriptionResourceId: ids.resource,
                description: "Subscriptions paid access",
                initServiceName: "mantle.forum.EntitlementServices.init#ForumAccess",
                renewServiceName: "mantle.forum.EntitlementServices.renew#ForumAccess",
                revokeAccessServiceName: "mantle.forum.EntitlementServices.revoke#ForumAccess",
                restoreAccessServiceName: "mantle.forum.EntitlementServices.restore#ForumAccess"
            })
            make("mantle.public.PublicSubscriptionBinding", {
                subscriptionResourceId: ids.resource,
                siteId: ids.site,
                targetType: "site",
                targetId: ids.site,
                createdAt: ec.user.nowTimestamp,
                revision: 1
            })
            make("mantle.product.Product", {
                productId: ids.product,
                productName: "Monthly access",
                productTypeEnumId: "PtDigital",
                ownerPartyId: ids.org
            })
            make("mantle.product.ProductPrice", {
                productId: ids.product,
                pricePurposeEnumId: "PppPurchase",
                priceTypeEnumId: "PptCurrent",
                fromDate: 0,
                minQuantity: 1,
                price: "12.00",
                priceUomId: "USD"
            })
            make(S + "ProductStoreProduct", {
                productStoreId: ids.store,
                productId: ids.product,
                fromDate: 0,
                publicationKindEnumId: "PspkPublished"
            })
            make(SUB + "ProductSubscriptionResource", {
                productId: ids.product,
                subscriptionResourceId: ids.resource,
                fromDate: 0,
                availableTime: 1,
                availableTimeUomId: "TF_mon"
            })
            // the renewal notices (the ledger's transactional sends)
            make("moqui.basic.email.EmailServer", {
                emailServerId: prefix + "_SMTP",
                smtpHost: "127.0.0.1",
                smtpPort: "9",
                smtpStartTls: "N"
            })
            for (const type of ["PsetPaymentRetry", "PsetSubscriptionRenewal"]) {
                make("moqui.basic.email.EmailTemplate", {
                    emailTemplateId: prefix + "_" + type,
                    emailServerId: prefix + "_SMTP",
                    fromAddress: "store@shsu.example.test",
                    subject: prefix + " " + type,
                    bodyScreenLocation: "component://framework/screen/ScreenRenderEmail.xml"
                })
                make(S + "ProductStoreEmail", {
                    productStoreId: ids.store,
                    emailTypeEnumId: type,
                    fromDate: 0,
                    emailTemplateId: prefix + "_" + type
                })
            }
            account(ids.buyer, true)
            account(ids.unverified, false)
            // the store's monthly offer, through store#RecurringOffer (Commerce's editor's service)
            state.offerId = call(R + "store#RecurringOffer", {
                productStoreId: ids.store,
                productId: ids.product,
                offerName: "Monthly",
                priceAmount: "12.00",
                autoRenew: "Y",
                termsVersion: "1"
            }).offerId
        })
    },
    cleanupSpec() {
        login("john.doe")
    }
})

feature(
    "a verified buyer subscribes with consent; the first term is the contract's; its base never reserves, invoices, emails or counts",
    {
        when() {
            const unverified = op(ids.unverified, R + "begin#SubscriptionPurchase", {offerId: state.offerId})
            const begun = op(ids.buyer, R + "begin#SubscriptionPurchase", {offerId: state.offerId})
            op(ids.buyer, CHECKOUT + "select#Payment", {paymentOptionId: "PiCreditCard"})
            const view = op(ids.buyer, CHECKOUT + "get#Checkout", {}).result
            const revision = view.checkout.revision
            const noConsent = op(ids.buyer, CHECKOUT + "submit#Checkout", {expectedRevision: revision})
            const submitted = op(ids.buyer, CHECKOUT + "submit#Checkout", {
                expectedRevision: revision,
                recurringConsent: true
            }).result
            const row = one("mantle.order.StoreCheckout", {returnReference: submitted.checkout.reference})
            system(() =>
                call("update#mantle.account.payment.PortalPaymentAttempt", {paymentId: row.paymentId, lastCheckDate: null})
            )
            op(ids.buyer, CHECKOUT + "get#CheckoutPaymentResult", {
                reference: submitted.checkout.reference,
                key: submitted.returnKey
            })
            assert(ec.factory.waitWorkerPoolEmpty(50), "Worker pool did not drain")
            const contract = contractOf()
            state.contractId = contract?.contractId
            const base = one("mantle.order.OrderHeader", {orderId: contract?.baseOrderId})
            // the base's own rules: no reservation, store email or invoice; not open exposure, not a store order
            const guards = system(() => {
                call("mantle.product.AssetServices.reserve#AssetsForOrder", {orderId: base.orderId})
                call("mantle.order.OrderInfoServices.send#OrderStoreEmail", {
                    orderId: base.orderId,
                    emailTypeEnumId: "PsetOrderApproved"
                })
                ec.message.pushErrors()
                let invoiceRefusal = ""
                try {
                    ec.service
                        .sync()
                        .name("mantle.account.InvoiceServices.create#EntireOrderPartInvoice")
                        .parameters({orderId: base.orderId, orderPartSeqId: "01"})
                        .requireNewTransaction(true)
                        .call()
                    invoiceRefusal = ec.message.getErrorsString()
                } catch (error) {
                    invoiceRefusal = String(error.message)
                } finally {
                    ec.message.clearErrors()
                    ec.message.popErrors()
                }
                const exposure = ec.resource
                    .script("component://mr-mantle/service/mantle/account/Credit.js")
                    .exposure(ids.org, ids.buyer, "USD")
                const listed = ec.resource
                    .script("component://mr-mantle/service/mantle/order/StoreOperations.js")
                    .withoutRecurringBases(
                        ec.entity.find("mantle.order.OrderHeader").condition("orderId", "in", [base.orderId, row.orderId])
                    )
                    .disableAuthz()
                    .count()
                return {invoiceRefusal, openOrders: exposure.openOrders, listed}
            })
            const subs = list(SUB + "Subscription", {resourceInstanceId: contract?.contractId})
            return {
                unverified,
                begun,
                view,
                noConsent,
                row: one("mantle.order.StoreCheckout", {checkoutId: row.checkoutId}),
                contract,
                base,
                guards,
                subs,
                grants: list("mantle.public.PublicAccessGrant", {partyId: ids.buyer, sourceType: "subscription"}),
                basePayments: list("mantle.account.payment.Payment", {orderId: base?.orderId}),
                baseReservations: list("mantle.product.issuance.AssetReservation", {orderId: base?.orderId}),
                baseBillings: list("mantle.order.OrderItemBilling", {orderId: base?.orderId}),
                baseItems: list("mantle.order.OrderItem", {orderId: base?.orderId}),
                site: one("mantle.public.PublicSite", {siteId: ids.site}),
                listedFirst: op(ids.buyer, R + "get#Subscriptions", {}).result
            }
        },
        then(r) {
            code(r.unverified) == "SIGN_IN_REQUIRED"
            r.begun.result?.next == "checkout"
            r.view.checkout.recurring?.consentRequired == true
            r.view.checkout.recurring?.price?.amount == "12.00"
            r.noConsent.error.includes("recurringConsent") || code(r.noConsent) == "VALUE_INVALID"
            r.row.statusId == "ScoCompleted"
            r.row.recurringConsentDate != null
            // the contract: active, its consent for the card kept at the checkout, paid through the first term
            r.contract?.stateEnumId == "ScsActive"
            r.contract.consentDate != null
            r.contract.paymentMethodId != null && r.contract.consentMethodId == r.contract.paymentMethodId
            r.contract.consentPaymentId == r.row.paymentId
            r.subs.length == 1
            r.subs[0].orderId == r.row.orderId
            Number(r.contract.paidThroughDate) == Number(r.subs[0].thruDate)
            r.grants.length == 1 && r.grants[0].sourceId == r.subs[0].subscriptionId
            // the base: the next period's template, approved, unpaid, never reserved, invoiced, emailed or counted
            r.base.orderPurposeEnumId == "OrpRecurringTemplate"
            r.base.statusId == "OrderApproved"
            r.base.recurCronExpression != null
            r.basePayments.length == 0
            r.baseReservations.length == 0
            r.baseBillings.length == 0
            r.baseItems.length == 1 && String(r.baseItems[0].unitAmount) == "12"
            r.guards.invoiceRefusal.includes("RECURRING_TEMPLATE")
            Number(String(r.guards.openOrders)) == 0
            r.guards.listed == 1
            // the site's subscription address is Shop's page; the account lists the subscription
            r.site.subscriptionUrl == "https://" + ids.host + "/shop/Subscriptions"
            r.listedFirst.subscriptions.length == 1
            r.listedFirst.subscriptions[0].hasAccess == true
            r.listedFirst.subscriptions[0].nextAmount?.amount == "12.00"
        }
    }
)

feature("two concurrent renewal jobs make one occurrence, one order and one charge; access goes on from the paid boundary", {
    when() {
        const contractId = state.contractId
        const before = one(SUB + "StoreRecurringContract", {contractId})
        dueNow(contractId)
        // the nightly job's hand-off and a second job at once
        system(() => {
            call("mantle.order.OrderServices.create#RecurringOrders", {})
            ec.service
                .async()
                .name(R + "dispatch#Renewal")
                .parameters({baseOrderId: before.baseOrderId})
                .call()
        })
        assert(ec.factory.waitWorkerPoolEmpty(100), "Worker pool did not drain")
        // a retried job answers the same occurrence
        system(() => call(R + "dispatch#Renewal", {baseOrderId: before.baseOrderId}))
        assert(ec.factory.waitWorkerPoolEmpty(50), "Worker pool did not drain")
        const found = occurrences(contractId)
        const orderId = found[0]?.orderId
        const payments = list("mantle.account.payment.Payment", {orderId})
        const subs = list(SUB + "Subscription", {resourceInstanceId: contractId}).sort(
            (a, b) => Number(a.fromDate) - Number(b.fromDate)
        )
        return {
            before,
            found,
            order: one("mantle.order.OrderHeader", {orderId}),
            payments,
            attempt: payments[0] ? one("mantle.account.payment.PortalPaymentAttempt", {paymentId: payments[0].paymentId}) : null,
            authorizations: list("mantle.account.method.PaymentGatewayResponse", {
                paymentId: payments[0]?.paymentId,
                paymentOperationEnumId: "PgoAuthorize"
            }),
            subs,
            after: one(SUB + "StoreRecurringContract", {contractId}),
            renewalOrders: list("mantle.order.OrderHeader", {parentOrderId: before.baseOrderId}),
            notices: list("mantle.party.MessageDelivery", {eventKey: "shopRenewal:renewed:" + found[0]?.occurrenceId})
        }
    },
    then(r) {
        r.found.length == 1
        r.found[0].stateEnumId == "SrsActivated"
        r.renewalOrders.length == 1
        r.order.orderPurposeEnumId == null
        r.order.statusId == "OrderApproved" || r.order.statusId == "OrderCompleted"
        r.payments.length == 1
        r.payments[0].statusId == "PmntDelivered"
        r.payments[0].paymentMethodId == r.before.paymentMethodId
        r.attempt.purposeEnumId == "PapShopRenewal" && r.attempt.occurrenceId == r.found[0].occurrenceId
        r.authorizations.length == 1 && r.authorizations[0].operationKey == "shop-renew-" + r.payments[0].paymentId
        // the second term starts where the first ends, on the same resource instance
        r.subs.length == 2
        Number(r.subs[1].fromDate) == Number(r.subs[0].thruDate)
        Number(r.after.paidThroughDate) == Number(r.subs[1].thruDate)
        r.after.stateEnumId == "ScsActive"
        r.notices.length == 1
    }
})

feature("a declined renewal is retried after a day with one notice and no extension; without consent nothing is charged", {
    when() {
        const contractId = state.contractId
        const contract = one(SUB + "StoreRecurringContract", {contractId})
        // the kept card's provider now declines
        system(() =>
            call("update#mantle.account.method.PaymentMethod", {
                paymentMethodId: contract.paymentMethodId,
                paymentGatewayConfigId: ids.decline
            })
        )
        dueNow(contractId)
        system(() => call(R + "dispatch#Renewal", {baseOrderId: contract.baseOrderId}))
        // the job again before the retry is due: nothing more is charged
        system(() => call(R + "run#Renewals", {}))
        const declined = occurrences(contractId).find(row => row.stateEnumId !== "SrsActivated")
        const paymentsAfterDecline = list("mantle.account.payment.Payment", {orderId: declined?.orderId})
        const retryNotices = list("mantle.party.MessageDelivery", {
            eventKey: "shopRenewal:retry:" + paymentsAfterDecline[0]?.paymentId
        })
        const pastDue = one(SUB + "StoreRecurringContract", {contractId})
        // the consent cleared (as a merge or an ended card would), and the retry due: no charge, the customer is asked
        system(() => {
            call("update#" + SUB + "StoreRecurringContract", {contractId, consentDate: null})
            call("update#" + SUB + "StoreRenewalOccurrence", {
                occurrenceId: declined.occurrenceId,
                nextRetryDate: new Date(Number(ec.user.nowTimestamp) - 1000)
            })
            call(R + "run#Renewals", {})
        })
        const waiting = one(SUB + "StoreRenewalOccurrence", {occurrenceId: declined.occurrenceId})
        state.waitingId = declined.occurrenceId
        return {
            contract,
            declined,
            paymentsAfterDecline,
            retryNotices,
            pastDue,
            waiting,
            paymentsAfterWait: list("mantle.account.payment.Payment", {orderId: declined.orderId}),
            actionNotices: list("mantle.party.MessageDelivery", {eventKey: "shopRenewal:action:" + declined.occurrenceId})
        }
    },
    then(r) {
        r.declined.stateEnumId == "SrsRetry"
        r.declined.attemptCount == 1
        // the first retry one day after the failure
        Math.round((Number(r.declined.nextRetryDate) - Number(r.declined.firstFailureDate)) / 3600000) == 24
        r.paymentsAfterDecline.length == 1
        r.paymentsAfterDecline[0].statusId == "PmntDeclined" || r.paymentsAfterDecline[0].statusId == "PmntCancelled"
        r.retryNotices.length == 1
        // no extension on a failed payment
        r.pastDue.stateEnumId == "ScsPastDue"
        Number(r.pastDue.paidThroughDate) == Number(r.contract.paidThroughDate)
        // no consent, no charge
        r.waiting.stateEnumId == "SrsActionRequired"
        r.waiting.failureCode == "CONSENT_REQUIRED"
        r.paymentsAfterWait.length == 1
        r.actionNotices.length == 1
    }
})

feature("cancelling keeps the paid term and stops renewals; a renewal in flight must settle first", {
    when() {
        const contractId = state.contractId
        const contract = one(SUB + "StoreRecurringContract", {contractId})
        // a renewal payment in flight refuses the cancellation
        const waitingRow = one(SUB + "StoreRenewalOccurrence", {occurrenceId: state.waitingId})
        system(() =>
            call("update#" + SUB + "StoreRenewalOccurrence", {occurrenceId: state.waitingId, stateEnumId: "SrsCharging"})
        )
        const inFlight = op(ids.buyer, R + "cancel#Subscription", {contractId, expectedRevision: contract.revision})
        system(() =>
            call("update#" + SUB + "StoreRenewalOccurrence", {occurrenceId: state.waitingId, stateEnumId: waitingRow.stateEnumId})
        )
        const stale = op(ids.buyer, R + "cancel#Subscription", {contractId, expectedRevision: "0"})
        const subsBefore = list(SUB + "Subscription", {resourceInstanceId: contractId})
        const cancelled = op(ids.buyer, R + "cancel#Subscription", {
            contractId,
            expectedRevision: contract.revision,
            reason: "Not using it"
        })
        dueNow(contractId)
        system(() => call(R + "dispatch#Renewal", {baseOrderId: contract.baseOrderId}))
        return {
            contract,
            inFlight,
            stale,
            cancelled,
            subsBefore,
            subsAfter: list(SUB + "Subscription", {resourceInstanceId: contractId}),
            after: one(SUB + "StoreRecurringContract", {contractId}),
            waiting: one(SUB + "StoreRenewalOccurrence", {occurrenceId: state.waitingId}),
            base: one("mantle.order.OrderHeader", {orderId: contract.baseOrderId}),
            count: occurrences(contractId).length
        }
    },
    then(r) {
        code(r.inFlight) == "RENEWAL_IN_PROGRESS"
        code(r.stale) == "STALE_REVISION"
        r.cancelled.result?.subscription?.billingState == "ScsCancelled"
        r.cancelled.result.subscription.hasAccess == true
        r.after.stateEnumId == "ScsCancelled"
        Number(r.after.cancelAtDate) == Number(r.contract.paidThroughDate)
        r.waiting.stateEnumId == "SrsCancelled"
        r.base.recurCronExpression == null
        // the paid terms stay as they were, and nothing renews
        r.subsAfter.length == r.subsBefore.length
        r.subsAfter.every(sub =>
            r.subsBefore.some(old => old.subscriptionId == sub.subscriptionId && Number(old.thruDate) == Number(sub.thruDate))
        )
        r.count == 2
    }
})

feature("a refund revokes only the term it paid for; a manual grant and the other term stay", {
    when() {
        const contractId = state.contractId
        const renewal = occurrences(contractId).find(row => row.stateEnumId === "SrsActivated")
        const line = list("mantle.order.OrderItem", {orderId: renewal.orderId}).find(item => item.productId === ids.product)
        system(() =>
            make("mantle.public.PublicAccessGrant", {
                grantId: prefix + "_MANUAL",
                partyId: ids.buyer,
                siteId: ids.site,
                targetType: "site",
                targetId: ids.site,
                sourceType: "manual",
                sourceId: prefix + "_STAFF",
                fromDate: ec.user.nowTimestamp,
                createdAt: ec.user.nowTimestamp,
                revision: 1
            })
        )
        // Accounting's chargeback intake (or a settled return) of the renewal's line
        const out = system(() =>
            call("mantle.product.ShopFulfillmentServices.reconcile#RefundedItem", {
                orderId: renewal.orderId,
                orderItemSeqId: line.orderItemSeqId,
                reasonEnumId: "SdrChargeback"
            })
        )
        const subs = list(SUB + "Subscription", {resourceInstanceId: contractId}).sort(
            (a, b) => Number(a.fromDate) - Number(b.fromDate)
        )
        return {
            out,
            renewal,
            subs,
            grants: list("mantle.public.PublicAccessGrant", {partyId: ids.buyer, siteId: ids.site}),
            contract: one(SUB + "StoreRecurringContract", {contractId})
        }
    },
    then(r) {
        r.out.revoked >= 1
        r.subs[1].subscriptionId == r.renewal.subscriptionId
        r.subs[1].accessRevokedDate != null
        r.subs[0].accessRevokedDate == null
        r.grants.find(grant => grant.sourceId == r.subs[1].subscriptionId).revokedAt != null
        r.grants.find(grant => grant.sourceId == r.subs[0].subscriptionId).revokedAt == null
        r.grants.find(grant => grant.grantId == prefix + "_MANUAL").revokedAt == null
        Number(r.contract.paidThroughDate) == Number(r.subs[0].thruDate)
    }
})

feature("another recurring order keeps today's behaviour; a merge carries a contract but never its consent", {
    when() {
        const native = system(() => {
            make("mantle.order.OrderHeader", {
                orderId: prefix + "_NATIVE",
                statusId: "OrderApproved",
                currencyUomId: "USD",
                entryDate: ec.user.nowTimestamp,
                recurCronExpression: "0 0 2 * * ?"
            })
            make("mantle.order.OrderPart", {
                orderId: prefix + "_NATIVE",
                orderPartSeqId: "01",
                vendorPartyId: ids.org,
                customerPartyId: ids.buyer,
                statusId: "OrderApproved"
            })
            make("mantle.order.OrderItem", {
                orderId: prefix + "_NATIVE",
                orderItemSeqId: "01",
                orderPartSeqId: "01",
                itemTypeEnumId: "ItemProduct",
                productId: ids.product,
                quantity: 1,
                unitAmount: 3
            })
            call("mantle.order.OrderServices.create#RecurringOrders", {})
            return null
        })
        assert(ec.factory.waitWorkerPoolEmpty(50), "Worker pool did not drain")
        const clones = list("mantle.order.OrderHeader", {parentOrderId: prefix + "_NATIVE"})
        // a guest-held contract with consent merged into another party
        const merged = system(() => {
            for (const partyId of [ids.guest, ids.other]) {
                make("mantle.party.Party", {partyId, partyTypeEnumId: "PtyPerson"})
                make("mantle.party.Person", {partyId, firstName: "Merge", lastName: partyId})
            }
            make("mantle.account.method.PaymentMethod", {
                paymentMethodId: prefix + "_CARD",
                paymentMethodTypeEnumId: "PmtCreditCard",
                ownerPartyId: ids.guest,
                fromDate: ec.user.nowTimestamp
            })
            make(SUB + "StoreRecurringContract", {
                contractId: prefix + "_MERGED",
                productStoreId: ids.store,
                customerPartyId: ids.guest,
                productId: ids.product,
                autoRenew: "Y",
                stateEnumId: "ScsActive",
                consentDate: ec.user.nowTimestamp,
                consentMethodId: prefix + "_CARD",
                paymentMethodId: prefix + "_CARD",
                revision: 1
            })
            call("mantle.party.DuplicateServices.merge#Parties", {fromPartyId: ids.guest, toPartyId: ids.other})
            return one(SUB + "StoreRecurringContract", {contractId: prefix + "_MERGED"})
        })
        return {native: one("mantle.order.OrderHeader", {orderId: prefix + "_NATIVE"}), clones, merged}
    },
    then(r) {
        r.clones.length == 1
        r.clones[0].statusId != "OrderOpen"
        r.native.lastOrderedDate != null
        r.native.orderPurposeEnumId == null
        r.merged.customerPartyId == ids.other
        r.merged.consentDate == null
        r.merged.consentEndedReason == "PARTY_MERGED"
    }
})
