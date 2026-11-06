// Shop's prepaid and recurring access (mr-pass impl-shop P7; mantle.product.ShopSubscriptionServices over
// ShopSubscriptions.js; design-shop §10, §10.1, §10.2, review X5): a verified buyer subscribes with recorded off-session
// consent and the first term activates on the contract's own resource instance, while its RecurringTemplate base never
// reserves, invoices, emails or counts; two concurrent renewal jobs make one occurrence, one order and one charge, extending
// access from the paid boundary; no charge without consent; a declined renewal is retried with one notice and no extension;
// cancelling keeps the paid term; a refund revokes only the term it paid for; another recurring order keeps today's
// behaviour; a merge carries a contract but never its consent. Commerce P12: the hourly job starts a due renewal (one
// occurrence with the nightly hand-off, Shop F113); staff retry a failed renewal through the coordinator once per operation,
// refused while a payment is unresolved; a refund of an automatic contract's latest term ends its renewal (F112); staff read
// the store's contracts with the method masked and cancel keeping the paid term, in their store scope; ending a card bumps
// the revision (F114); the paid-access editor takes installed resources only and refuses removing one in use, naming the
// count. Standalone: spec-local organizations, stores, site, gateways, product, accounts and staff. Run:
// ./moq test mr-mantle --spec ShopSubscriptions
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
// Commerce P12's staff: a spec-local group with the permissions, a member of the organization (a store-limited one through a
// StoreStaff row)
const staffIds = {
    operator: prefix + "_OPERATOR",
    reader: prefix + "_READER",
    limited: prefix + "_LIMITED",
    outsider: prefix + "_OUTSIDER",
    catalog: prefix + "_CATALOG"
}
function staff(userId, organizationPartyId, permissions) {
    make("mantle.party.Party", {partyId: userId, partyTypeEnumId: "PtyPerson"})
    make("mantle.party.Person", {partyId: userId, firstName: "Staff", lastName: userId})
    make("mantle.party.PartyRelationship", {
        partyRelationshipId: userId,
        fromPartyId: userId,
        toPartyId: organizationPartyId,
        relationshipTypeEnumId: "PrtAgent",
        fromDate: 0
    })
    make("moqui.security.UserGroup", {userGroupId: userId, description: "Subscriptions staff " + userId})
    for (const userPermissionId of permissions)
        make("moqui.security.UserGroupPermission", {userGroupId: userId, userPermissionId, fromDate: 0})
    make("moqui.security.UserAccount", {
        userId,
        username: userId,
        partyId: userId,
        currentPassword: "16ac58bbfa332c1c55bd98b53e60720bfa90d394",
        passwordHashType: "SHA",
        timeZone: "UTC"
    })
    make("moqui.security.UserGroupMember", {userId, userGroupId: userId, fromDate: 0})
}
// a staff call in its own transaction: its result, or {error}
function asStaff(username, service, parameters = {}) {
    login(username)
    const was = ec.artifactExecution.disableAuthz()
    ec.message.pushErrors()
    try {
        const out = ec.service.sync().name(service).parameters(parameters).requireNewTransaction(true).call() || {}
        return ec.message.hasError() ? {error: ec.message.getErrorsString()} : out
    } catch (error) {
        return {error: String(error.message || error)}
    } finally {
        ec.message.clearErrors()
        ec.message.popErrors()
        if (!was) ec.artifactExecution.enableAuthz()
        login("john.doe")
    }
}
// contract 2 (the review feature's second subscription) is the one the P12 features renew
const second = () => one(SUB + "StoreRecurringContract", {contractId: state.second})

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
            // (a card kept from the hosted page carries no name, so the store's name check is off too: Shop F102)
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
            // Commerce P12: a second store of the organization, another organization, the staff and a resource whose handler
            // is not installed
            make("mantle.party.Party", {partyId: prefix + "_ORG2", partyTypeEnumId: "PtyOrganization"})
            make("mantle.party.Organization", {partyId: prefix + "_ORG2", organizationName: "Other organization"})
            make("mantle.party.PartyRole", {partyId: prefix + "_ORG2", roleTypeId: "OrgInternal"})
            make(S + "ProductStore", {
                productStoreId: prefix + "_STORE2",
                storeName: "Second store",
                organizationPartyId: ids.org,
                defaultCurrencyUomId: "USD"
            })
            make(S + "ProductStore", {
                productStoreId: prefix + "_STORE3",
                storeName: "Other organization's store",
                organizationPartyId: prefix + "_ORG2",
                defaultCurrencyUomId: "USD"
            })
            const manage = ["COMMERCE_VIEW", "COMMERCE_ORDER_VIEW", "COMMERCE_SUBSCRIPTION_MANAGE"]
            staff(staffIds.operator, ids.org, manage)
            staff(staffIds.reader, ids.org, ["COMMERCE_VIEW", "COMMERCE_ORDER_VIEW"])
            staff(staffIds.limited, ids.org, manage)
            make(S + "ProductStoreParty", {
                productStoreId: prefix + "_STORE2",
                partyId: staffIds.limited,
                roleTypeId: "StoreStaff",
                fromDate: 0
            })
            staff(staffIds.outsider, prefix + "_ORG2", manage)
            staff(staffIds.catalog, ids.org, ["PRODUCT_CATALOG_VIEW"])
            make(SUB + "SubscriptionResource", {
                subscriptionResourceId: prefix + "_RES_X",
                description: "Uninstalled access",
                initServiceName: "mantle.none.NoSuchServices.init#Nothing"
            })
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

feature("review: retries run out, then a changed card's consent charges the renewal once; another's contract is not reachable", {
    when() {
        // a second subscription of the buyer, bought as the first
        op(ids.buyer, R + "begin#SubscriptionPurchase", {offerId: state.offerId})
        op(ids.buyer, CHECKOUT + "select#Payment", {paymentOptionId: "PiCreditCard"})
        const revision = op(ids.buyer, CHECKOUT + "get#Checkout", {}).result.checkout.revision
        const submitted = op(ids.buyer, CHECKOUT + "submit#Checkout", {expectedRevision: revision, recurringConsent: true}).result
        const row = one("mantle.order.StoreCheckout", {returnReference: submitted.checkout.reference})
        system(() => call("update#mantle.account.payment.PortalPaymentAttempt", {paymentId: row.paymentId, lastCheckDate: null}))
        op(ids.buyer, CHECKOUT + "get#CheckoutPaymentResult", {reference: submitted.checkout.reference, key: submitted.returnKey})
        assert(ec.factory.waitWorkerPoolEmpty(50), "Worker pool did not drain")
        const contract = one(SUB + "StoreRecurringContract", {originOrderId: row.orderId})
        const contractId = contract.contractId
        // its card declines: the renewal fails, and its last retry fails too (retries run out)
        system(() =>
            call("update#mantle.account.method.PaymentMethod", {
                paymentMethodId: contract.paymentMethodId,
                paymentGatewayConfigId: ids.decline
            })
        )
        dueNow(contractId)
        system(() => call(R + "dispatch#Renewal", {baseOrderId: contract.baseOrderId}))
        const failing = occurrences(contractId)[0]
        system(() => {
            call("update#" + SUB + "StoreRenewalOccurrence", {
                occurrenceId: failing.occurrenceId,
                attemptCount: 3,
                nextRetryDate: new Date(Number(ec.user.nowTimestamp) - 1000)
            })
            call(R + "run#Renewals", {})
        })
        const exhausted = one(SUB + "StoreRenewalOccurrence", {occurrenceId: failing.occurrenceId})
        const listed = op(ids.buyer, R + "get#Subscription", {contractId}).result
        const paymentsExhausted = list("mantle.account.payment.Payment", {orderId: failing.orderId})
        // the customer's recovery: the card working again, chosen with consent; the renewal is charged once at once
        system(() =>
            call("update#mantle.account.method.PaymentMethod", {
                paymentMethodId: contract.paymentMethodId,
                paymentGatewayConfigId: ids.hosted
            })
        )
        const current = one(SUB + "StoreRecurringContract", {contractId})
        const stale = op(ids.buyer, R + "change#SubscriptionMethod", {
            contractId,
            paymentMethodId: contract.paymentMethodId,
            consent: true,
            expectedRevision: "0"
        })
        const changed = op(ids.buyer, R + "change#SubscriptionMethod", {
            contractId,
            paymentMethodId: contract.paymentMethodId,
            consent: true,
            expectedRevision: current.revision
        })
        assert(ec.factory.waitWorkerPoolEmpty(50), "Worker pool did not drain")
        // a resume now answers as it is: nothing is charged again
        const resumed = op(ids.buyer, R + "resume#Renewal", {contractId})
        assert(ec.factory.waitWorkerPoolEmpty(50), "Worker pool did not drain")
        return {
            contract,
            exhausted,
            listed,
            paymentsExhausted,
            stale,
            changed,
            resumed,
            after: one(SUB + "StoreRecurringContract", {contractId}),
            occurrence: one(SUB + "StoreRenewalOccurrence", {occurrenceId: failing.occurrenceId}),
            payments: list("mantle.account.payment.Payment", {orderId: failing.orderId}),
            subs: list(SUB + "Subscription", {resourceInstanceId: contractId}),
            // the merged party's contract (the previous feature's) is another customer's
            forged: op(ids.buyer, R + "get#Subscription", {contractId: prefix + "_MERGED"})
        }
    },
    then(r) {
        r.exhausted.stateEnumId == "SrsFailed"
        r.listed.subscription.actionNeeded == true
        r.paymentsExhausted.length == 2
        code(r.stale) == "STALE_REVISION"
        r.changed.error == null
        r.resumed.error == null
        r.after.consentDate != null && r.after.consentMethodId == r.contract.paymentMethodId
        r.after.stateEnumId == "ScsActive"
        r.occurrence.stateEnumId == "SrsActivated"
        r.payments.length == 3
        r.payments.filter(payment => ["PmntAuthorized", "PmntDelivered"].includes(payment.statusId)).length == 1
        r.subs.length == 2
        Number(r.after.paidThroughDate) == Math.max(...r.subs.map(sub => Number(sub.thruDate)))
        code(r.forged) == "NOT_AVAILABLE"
    }
})

feature(
    "P12: the hourly job starts a due renewal, one occurrence with the nightly hand-off (F113); staff retry it once per operation, refused while a payment is unresolved",
    {
        when() {
            state.second = list(SUB + "StoreRecurringContract", {customerPartyId: ids.buyer, stateEnumId: "ScsActive"}).find(
                row => !!row.baseOrderId
            )?.contractId
            const contract = second()
            const occurrencesBefore = occurrences(state.second).length
            system(() =>
                call("update#mantle.account.method.PaymentMethod", {
                    paymentMethodId: contract.paymentMethodId,
                    paymentGatewayConfigId: ids.decline
                })
            )
            dueNow(state.second)
            // the hourly job claims the period (the card declines), then the nightly hand-off and the job again at once
            system(() => call(R + "run#Renewals", {}))
            const claimed = occurrences(state.second).find(row => Number(row.periodStartDate) == Number(contract.paidThroughDate))
            system(() => {
                ec.service
                    .async()
                    .name(R + "dispatch#Renewal")
                    .parameters({baseOrderId: contract.baseOrderId})
                    .call()
                call(R + "run#Renewals", {})
            })
            assert(ec.factory.waitWorkerPoolEmpty(50), "Worker pool did not drain")
            const failing = occurrences(state.second).find(row => Number(row.periodStartDate) == Number(contract.paidThroughDate))
            const claimedCount = occurrences(state.second).length
            const declinedPayments = list("mantle.account.payment.Payment", {orderId: failing.orderId}).length
            // a payment in flight: the retry is refused, nothing is charged again
            system(() =>
                call("update#" + SUB + "StoreRenewalOccurrence", {occurrenceId: failing.occurrenceId, stateEnumId: "SrsCharging"})
            )
            const unresolved = asStaff(staffIds.operator, R + "retry#Renewal", {
                contractId: state.second,
                operationKey: prefix + "-R0"
            })
            system(() =>
                call("update#" + SUB + "StoreRenewalOccurrence", {
                    occurrenceId: failing.occurrenceId,
                    stateEnumId: failing.stateEnumId
                })
            )
            const reader = asStaff(staffIds.reader, R + "retry#Renewal", {contractId: state.second, operationKey: prefix + "-R1"})
            const detail = asStaff(staffIds.operator, R + "get#StoreSubscription", {contractId: state.second})
            // the card works again; the operator's retry charges the same occurrence once
            system(() =>
                call("update#mantle.account.method.PaymentMethod", {
                    paymentMethodId: contract.paymentMethodId,
                    paymentGatewayConfigId: ids.hosted
                })
            )
            const retried = asStaff(staffIds.operator, R + "retry#Renewal", {
                contractId: state.second,
                operationKey: prefix + "-R2"
            })
            assert(ec.factory.waitWorkerPoolEmpty(50), "Worker pool did not drain")
            const again = asStaff(staffIds.operator, R + "retry#Renewal", {
                contractId: state.second,
                operationKey: prefix + "-R2"
            })
            const nothing = asStaff(staffIds.operator, R + "retry#Renewal", {
                contractId: state.second,
                operationKey: prefix + "-R3"
            })
            return {
                occurrencesBefore,
                claimed,
                claimedCount,
                declinedPayments,
                failing,
                unresolved,
                reader,
                detail,
                retried,
                again,
                nothing,
                occurrence: one(SUB + "StoreRenewalOccurrence", {occurrenceId: failing.occurrenceId}),
                payments: list("mantle.account.payment.Payment", {orderId: failing.orderId})
            }
        },
        then(r) {
            r.claimed != null && r.claimed.occurrenceId == r.failing.occurrenceId
            r.claimedCount == r.occurrencesBefore + 1
            r.declinedPayments == 1
            r.failing.stateEnumId == "SrsRetry"
            code(r.unresolved) == "PAYMENT_UNRESOLVED"
            code(r.reader) == "PERMISSION_DENIED"
            r.detail.subscription.canRetry == true
            r.detail.renewals.find(row => row.occurrenceId == r.failing.occurrenceId).retryable == true
            r.retried.error == null && r.retried.occurrenceId == r.failing.occurrenceId
            r.again.alreadyApplied == true && r.again.occurrenceId == r.failing.occurrenceId
            code(r.nothing) == "NOTHING_TO_RETRY"
            r.occurrence.stateEnumId == "SrsActivated"
            // the declined attempt and one approved charge, nothing more
            r.payments.length == 2
            r.payments.filter(payment => ["PmntAuthorized", "PmntDelivered"].includes(payment.statusId)).length == 1
        }
    }
)

feature("P12 (F112): refunding an automatic contract's latest term ends its renewal at the new paid-through; nothing renews", {
    when() {
        const before = second()
        const latest = occurrences(state.second)
            .filter(row => row.stateEnumId === "SrsActivated")
            .sort((a, b) => Number(b.periodStartDate) - Number(a.periodStartDate))[0]
        const line = list("mantle.order.OrderItem", {orderId: latest.orderId}).find(item => item.productId === ids.product)
        system(() =>
            call("mantle.product.ShopFulfillmentServices.reconcile#RefundedItem", {
                orderId: latest.orderId,
                orderItemSeqId: line.orderItemSeqId,
                reasonEnumId: "SdrChargeback"
            })
        )
        const after = second()
        const count = occurrences(state.second).length
        // as if the old renewal date had come: neither job claims anything
        system(() => {
            call("update#" + SUB + "StoreRecurringContract", {
                contractId: state.second,
                nextRenewalDate: new Date(Number(ec.user.nowTimestamp) - 60000)
            })
            call(R + "dispatch#Renewal", {baseOrderId: before.baseOrderId})
            call(R + "run#Renewals", {})
        })
        return {
            before,
            latest,
            after,
            count,
            countAfter: occurrences(state.second).length,
            base: one("mantle.order.OrderHeader", {orderId: before.baseOrderId}),
            view: op(ids.buyer, R + "get#Subscription", {contractId: state.second}).result
        }
    },
    then(r) {
        Number(r.after.paidThroughDate) == Number(r.latest.periodStartDate)
        r.after.stateEnumId == "ScsCancelled"
        r.after.nextRenewalDate == null
        Number(r.after.cancelAtDate) == Number(r.after.paidThroughDate)
        r.base.recurCronExpression == null
        r.countAfter == r.count
        r.view.subscription.billingState == "ScsCancelled"
        r.view.subscription.canCancel == false
    }
})

feature(
    "P12: staff read the store's contracts, the method masked, and cancel keeping the paid term, in their scope; a card's end bumps the revision (F114)",
    {
        when() {
            const contractId = prefix + "_DIRECT"
            const paidThrough = new Date(Number(ec.user.nowTimestamp) + 20 * 86400000)
            system(() => {
                make("mantle.account.method.PaymentMethod", {
                    paymentMethodId: prefix + "_CARD2",
                    paymentMethodTypeEnumId: "PmtCreditCard",
                    ownerPartyId: ids.buyer,
                    paymentGatewayConfigId: ids.hosted,
                    gatewayCimId: prefix + "_CIM_SECRET",
                    fromDate: ec.user.nowTimestamp
                })
                make("mantle.account.method.CreditCard", {
                    paymentMethodId: prefix + "_CARD2",
                    creditCardTypeEnumId: "CctVisa",
                    cardNumber: "4111111111111111"
                })
                make("mantle.order.OrderHeader", {
                    orderId: prefix + "_DBASE",
                    statusId: "OrderApproved",
                    currencyUomId: "USD",
                    orderPurposeEnumId: "OrpRecurringTemplate",
                    recurCronExpression: "0 0 2 * * ?",
                    entryDate: ec.user.nowTimestamp
                })
                make(SUB + "StoreRecurringContract", {
                    contractId,
                    productStoreId: ids.store,
                    siteId: ids.site,
                    customerPartyId: ids.buyer,
                    productId: ids.product,
                    subscriptionResourceId: ids.resource,
                    priceAmount: "12.00",
                    currencyUomId: "USD",
                    autoRenew: "Y",
                    stateEnumId: "ScsActive",
                    baseOrderId: prefix + "_DBASE",
                    paymentMethodId: prefix + "_CARD2",
                    consentDate: ec.user.nowTimestamp,
                    consentMethodId: prefix + "_CARD2",
                    consentEvidence: prefix + "_EVIDENCE_SECRET",
                    paidThroughDate: paidThrough,
                    nextRenewalDate: paidThrough,
                    revision: 1,
                    createdDate: ec.user.nowTimestamp
                })
                make(SUB + "Subscription", {
                    subscriptionId: prefix + "_DSUB",
                    subscriptionResourceId: ids.resource,
                    subscriberPartyId: ids.buyer,
                    productId: ids.product,
                    resourceInstanceId: contractId,
                    fromDate: ec.user.nowTimestamp,
                    thruDate: paidThrough
                })
            })
            const listed = asStaff(staffIds.operator, R + "find#StoreSubscriptions", {productStoreId: ids.store})
            const detail = asStaff(staffIds.operator, R + "get#StoreSubscription", {contractId})
            const readerList = asStaff(staffIds.reader, R + "find#StoreSubscriptions", {})
            const outsider = asStaff(staffIds.outsider, R + "get#StoreSubscription", {contractId})
            const limited = asStaff(staffIds.limited, R + "get#StoreSubscription", {contractId})
            const limitedList = asStaff(staffIds.limited, R + "find#StoreSubscriptions", {})
            // the buyer ends the card in Shop: its consent goes and the revision moves on
            const ended = op(ids.buyer, "mantle.party.ShopCustomerServices.end#PaymentMethod", {
                paymentMethodId: prefix + "_CARD2",
                confirm: true
            })
            const afterEnd = one(SUB + "StoreRecurringContract", {contractId})
            const stale = asStaff(staffIds.operator, R + "cancel#RecurringContract", {contractId, expectedRevision: "1"})
            const reader = asStaff(staffIds.reader, R + "cancel#RecurringContract", {
                contractId,
                expectedRevision: afterEnd.revision
            })
            const cancelled = asStaff(staffIds.operator, R + "cancel#RecurringContract", {
                contractId,
                expectedRevision: afterEnd.revision,
                reason: "Asked by phone"
            })
            return {
                contractId,
                listed,
                detail,
                detailJson: JSON.stringify(detail),
                readerList,
                outsider,
                limited,
                limitedList,
                ended,
                afterEnd,
                stale,
                reader,
                cancelled,
                after: one(SUB + "StoreRecurringContract", {contractId}),
                base: one("mantle.order.OrderHeader", {orderId: prefix + "_DBASE"}),
                sub: one(SUB + "Subscription", {subscriptionId: prefix + "_DSUB"}),
                paidThrough
            }
        },
        then(r) {
            r.listed.subscriptions.some(
                row => row.contractId == r.contractId && row.hasAccess && row.customerName.includes(ids.buyer)
            )
            r.detail.subscription.methodText.includes("1111")
            r.detail.subscription.consentHolds == true && r.detail.subscription.canCancel == true
            r.detail.access.length == 1 && r.detail.access[0].stateText == "Current"
            !r.detailJson.includes("CIM_SECRET") &&
                !r.detailJson.includes("EVIDENCE_SECRET") &&
                !r.detailJson.includes("4111111111111111")
            // the reader reads; another organization's operator and a member of the other store do not
            r.readerList.subscriptions.some(row => row.contractId == r.contractId)
            code(r.outsider) == "RECORD_UNAVAILABLE"
            code(r.limited) == "RECORD_UNAVAILABLE"
            r.limitedList.subscriptions.length == 0
            r.ended.error == null
            r.afterEnd.consentDate == null && r.afterEnd.consentEndedReason == "METHOD_ENDED" && r.afterEnd.revision == 2
            code(r.stale) == "STALE_REVISION"
            code(r.reader) == "PERMISSION_DENIED"
            r.cancelled.subscription.billingState == "ScsCancelled"
            r.cancelled.subscription.hasAccess == true
            r.after.stateEnumId == "ScsCancelled" && r.after.cancelReason == "Asked by phone"
            Number(r.after.cancelAtDate) == Number(r.paidThrough)
            r.base.recurCronExpression == null
            Number(r.sub.thruDate) == Number(r.paidThrough) && r.sub.accessRevokedDate == null
        }
    }
)

feature(
    "P12: paid access takes installed resources only, a change starts a successor row, and a resource in use is not removed",
    {
        when() {
            const P = {productId: ids.product, subscriptionResourceId: ids.resource}
            const read = asStaff(staffIds.operator, R + "get#ProductPaidAccess", {productId: ids.product})
            const catalog = asStaff(staffIds.catalog, R + "get#ProductPaidAccess", {productId: ids.product})
            const reader = asStaff(
                staffIds.reader,
                R + "store#ProductSubscriptionResource",
                Object.assign({fromDate: "0", change: "Y", availableTime: 2}, P)
            )
            const outsider = asStaff(
                staffIds.outsider,
                R + "store#ProductSubscriptionResource",
                Object.assign({fromDate: "0", change: "Y", availableTime: 2}, P)
            )
            const uninstalled = asStaff(staffIds.operator, R + "store#ProductSubscriptionResource", {
                productId: ids.product,
                subscriptionResourceId: prefix + "_RES_X"
            })
            const bound = asStaff(staffIds.operator, R + "store#ProductSubscriptionResource", P)
            const subsBefore = list(SUB + "Subscription", {productId: ids.product})
                .map(sub => sub.subscriptionId + ":" + Number(sub.thruDate))
                .sort()
            const changed = asStaff(
                staffIds.operator,
                R + "store#ProductSubscriptionResource",
                Object.assign({fromDate: "0", change: "Y", availableTime: 2, availableTimeUomId: "TF_mon"}, P)
            )
            const removed = asStaff(
                staffIds.operator,
                R + "store#ProductSubscriptionResource",
                Object.assign({fromDate: String(changed.fromDate), ended: "Y"}, P)
            )
            return {
                read,
                catalog,
                reader,
                outsider,
                uninstalled,
                bound,
                changed,
                removed,
                rows: list(SUB + "ProductSubscriptionResource", P).sort((a, b) => Number(a.fromDate) - Number(b.fromDate)),
                subsBefore,
                subsAfter: list(SUB + "Subscription", {productId: ids.product})
                    .map(sub => sub.subscriptionId + ":" + Number(sub.thruDate))
                    .sort()
            }
        },
        then(r) {
            r.read.canEdit == true
            r.read.terms.length == 1 && r.read.terms[0].handlersText.includes("mantle.forum.EntitlementServices.init#ForumAccess")
            r.read.resourceOptions.some(option => option.value == ids.resource)
            !r.read.resourceOptions.some(option => option.value == prefix + "_RES_X")
            // Products reads the rows, never edits them
            r.catalog.canEdit == false && r.catalog.terms.length == 1
            code(r.reader) == "PERMISSION_DENIED"
            code(r.outsider) == "RECORD_UNAVAILABLE"
            code(r.uninstalled) == "RESOURCE_UNAVAILABLE"
            code(r.bound) == "RESOURCE_BOUND"
            // the row in effect ended and its successor started: only later purchases take two months
            r.rows.length == 2
            r.rows[0].thruDate != null && Number(r.rows[0].thruDate) == Number(r.rows[1].fromDate)
            r.rows[1].availableTime == 2 && r.rows[1].thruDate == null
            JSON.stringify(r.subsAfter) == JSON.stringify(r.subsBefore)
            code(r.removed) == "SUBSCRIPTIONS_LIVE"
            String(r.removed.error).match(/\d+ live subscription/) != null
        }
    }
)

feature("P12 review: refunding a past-due contract's only term ends its renewal; no new period is claimed (R1)", {
    when() {
        const contractId = prefix + "_PASTDUE"
        const ended = new Date(Number(ec.user.nowTimestamp) - 2 * 86400000)
        system(() => {
            make(SUB + "SubscriptionResource", {subscriptionResourceId: prefix + "_RES_P", description: "Plain access"})
            make("mantle.order.OrderHeader", {
                orderId: prefix + "_PBASE",
                statusId: "OrderApproved",
                currencyUomId: "USD",
                orderPurposeEnumId: "OrpRecurringTemplate",
                recurCronExpression: "0 0 2 * * ?",
                entryDate: ec.user.nowTimestamp
            })
            make("mantle.order.OrderHeader", {
                orderId: prefix + "_PORD",
                statusId: "OrderCompleted",
                currencyUomId: "USD",
                entryDate: ec.user.nowTimestamp
            })
            make("mantle.order.OrderPart", {
                orderId: prefix + "_PORD",
                orderPartSeqId: "01",
                vendorPartyId: ids.org,
                customerPartyId: ids.buyer,
                statusId: "OrderCompleted"
            })
            make("mantle.order.OrderItem", {
                orderId: prefix + "_PORD",
                orderItemSeqId: "01",
                orderPartSeqId: "01",
                itemTypeEnumId: "ItemProduct",
                productId: ids.product,
                quantity: 1,
                unitAmount: 12
            })
            make(SUB + "StoreRecurringContract", {
                contractId,
                productStoreId: ids.store,
                customerPartyId: ids.buyer,
                productId: ids.product,
                priceAmount: "12.00",
                currencyUomId: "USD",
                autoRenew: "Y",
                stateEnumId: "ScsPastDue",
                baseOrderId: prefix + "_PBASE",
                paidThroughDate: ended,
                nextRenewalDate: ended,
                revision: 1,
                createdDate: ec.user.nowTimestamp
            })
            make(SUB + "Subscription", {
                subscriptionId: prefix + "_PSUB",
                subscriptionResourceId: prefix + "_RES_P",
                subscriberPartyId: ids.buyer,
                productId: ids.product,
                orderId: prefix + "_PORD",
                orderItemSeqId: "01",
                resourceInstanceId: contractId,
                fromDate: new Date(Number(ended) - 30 * 86400000),
                thruDate: ended
            })
            make(SUB + "StoreRenewalOccurrence", {
                occurrenceId: prefix + "_POCC",
                contractId,
                periodStartDate: ended,
                stateEnumId: "SrsRetry",
                attemptCount: 1,
                nextRetryDate: new Date(Number(ec.user.nowTimestamp) + 86400000),
                createdDate: ec.user.nowTimestamp
            })
            make("mantle.product.store.StoreItemFulfillment", {
                fulfillmentId: prefix + "_PFUL",
                orderId: prefix + "_PORD",
                orderItemSeqId: "01",
                orderPartSeqId: "01",
                productId: ids.product,
                productStoreId: ids.store
            })
        })
        system(() =>
            call("mantle.product.ShopFulfillmentServices.reconcile#RefundedItem", {
                orderId: prefix + "_PORD",
                orderItemSeqId: "01",
                reasonEnumId: "SdrChargeback"
            })
        )
        system(() => call(R + "dispatch#Renewal", {baseOrderId: prefix + "_PBASE"}))
        return {
            sub: one(SUB + "Subscription", {subscriptionId: prefix + "_PSUB"}),
            contract: one(SUB + "StoreRecurringContract", {contractId}),
            occurrences: occurrences(contractId)
        }
    },
    then(r) {
        r.sub.accessRevokedDate != null
        r.contract.stateEnumId == "ScsCancelled" && r.contract.nextRenewalDate == null
        r.occurrences.length == 1 && r.occurrences[0].stateEnumId == "SrsCancelled"
    }
})

feature("P12 review: a product also sold in a store outside the user's scope is not theirs to edit (R2)", {
    when() {
        // the product joins the second store's assortment: the operator works both, the limited member the second only
        system(() =>
            make(S + "ProductStoreProduct", {
                productStoreId: prefix + "_STORE2",
                productId: ids.product,
                fromDate: 0,
                publicationKindEnumId: "PspkPublished"
            })
        )
        const limited = asStaff(staffIds.limited, R + "get#ProductPaidAccess", {productId: ids.product})
        const limitedEdit = asStaff(staffIds.limited, R + "store#ProductSubscriptionResource", {
            productId: ids.product,
            subscriptionResourceId: ids.resource
        })
        const operator = asStaff(staffIds.operator, R + "get#ProductPaidAccess", {productId: ids.product})
        const noRow = asStaff(staffIds.operator, R + "store#ProductSubscriptionResource", {
            productId: ids.product,
            subscriptionResourceId: ids.resource,
            ended: "Y"
        })
        return {limited, limitedEdit, operator, noRow}
    },
    then(r) {
        r.limited.canEdit == false && r.limited.terms.length > 0
        code(r.limitedEdit) == "PRODUCT_SHARED"
        r.operator.canEdit == true
        code(r.noRow) == "RECORD_UNAVAILABLE"
    }
})

feature("Shop P9 (F126): the fulfillment job finds a renewal order whose approval never started fulfillment", {
    when() {
        // a renewal occurrence's order approved with no fulfillment row (the approval SECA never ran); its payment declined,
        // so the run holds the row and grants nothing
        const orderId = prefix + "_BORD"
        system(() => {
            make("mantle.order.OrderHeader", {
                orderId,
                statusId: "OrderApproved",
                currencyUomId: "USD",
                entryDate: ec.user.nowTimestamp
            })
            make("mantle.order.OrderPart", {
                orderId,
                orderPartSeqId: "01",
                vendorPartyId: ids.org,
                customerPartyId: ids.buyer,
                statusId: "OrderApproved"
            })
            make("mantle.order.OrderItem", {
                orderId,
                orderItemSeqId: "01",
                orderPartSeqId: "01",
                itemTypeEnumId: "ItemProduct",
                productId: ids.product,
                quantity: 1,
                unitAmount: 12
            })
            make("mantle.account.payment.Payment", {
                paymentId: prefix + "_BPAY",
                statusId: "PmntDeclined",
                amount: "12.00",
                amountUomId: "USD",
                fromPartyId: ids.buyer,
                toPartyId: ids.org
            })
            make(SUB + "StoreRenewalOccurrence", {
                occurrenceId: prefix + "_BOCC",
                contractId: prefix + "_PASTDUE",
                periodStartDate: new Date(Number(ec.user.nowTimestamp) + 100 * 86400000),
                stateEnumId: "SrsCharging",
                orderId,
                paymentId: prefix + "_BPAY",
                attemptCount: 1,
                createdDate: ec.user.nowTimestamp
            })
        })
        const F = "mantle.product.store.StoreItemFulfillment"
        const before = list(F, {orderId}).length
        const job = system(() => call("mantle.product.ShopFulfillmentServices.fulfill#StoreItems", {limit: 500}))
        const after = list(F, {orderId})
        // left inert: the row and the occurrence removed so no later run retries them
        system(() => {
            for (const row of after) call("delete#" + F, {fulfillmentId: row.fulfillmentId})
            call("delete#" + SUB + "StoreRenewalOccurrence", {occurrenceId: prefix + "_BOCC"})
        })
        return {before, job, after}
    },
    then(r) {
        r.before == 0
        r.job.orders >= 1
        r.after.length == 1
        r.after[0].productStoreId == ids.store && r.after[0].recipientPartyId == ids.buyer
        r.after[0].stepEnumId == "SifHeld" && r.after[0].failureCode == "CAPTURE_DECLINED"
    }
})
