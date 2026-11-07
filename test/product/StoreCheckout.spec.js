// A store's checkout settings (impl-commerce P6; mantle.product.StoreAdminServices store#CheckoutPolicy, store#ShippingOption,
// store#StoreShippingGateway, store#StorePaymentGateway, store#StoreTax, preview#StoreTax; StoreCheckout.js): the policy
// dated, validated per field, needing its reason, its support queue one the organization offers (F37); payment gateways only
// from the organization's enabled, current bindings (Z4); shipping gateways only approved ones; a binding's removal recorded
// with its reason (F61); the purchase readiness of the support queue, each site's Support mount (F38) and Terms page; the tax
// preview for a reader of the store, without Accounting's read. The local rates are StoreShippingRates.
// Standalone: spec-local organizations, users, store, queues, gateways and site, artifact authorization disabled (the rules
// are the services' own checks). Run: ./moq test mr-mantle --spec StoreCheckout
const A = "mantle.product.StoreAdminServices."
const S = "mantle.product.store."
const prefix = "STCHK"
const orgA = prefix + "_ORG_A",
    orgB = prefix + "_ORG_B"
const ids = {}
const users = {}

function system(action) {
    login("john.doe")
    const was = ec.artifactExecution.disableAuthz()
    try {
        return action()
    } finally {
        if (!was) ec.artifactExecution.enableAuthz()
    }
}
const make = (entity, values) => call("create#" + entity, values)
function organization(partyId, name) {
    make("mantle.party.Party", {partyId, partyTypeEnumId: "PtyOrganization"})
    make("mantle.party.Organization", {partyId, organizationName: name})
    make("mantle.party.PartyRole", {partyId, roleTypeId: "OrgInternal"})
    make("mantle.ledger.config.PartyAcctgPreference", {organizationPartyId: partyId, baseCurrencyUomId: "USD"})
}
function user(kind, organizationPartyId, permissions) {
    const id = prefix + "_" + kind.toUpperCase()
    make("mantle.party.Party", {partyId: id, partyTypeEnumId: "PtyPerson"})
    make("mantle.party.Person", {partyId: id, firstName: "Checkout", lastName: kind})
    make("mantle.party.PartyRelationship", {
        partyRelationshipId: id,
        fromPartyId: id,
        toPartyId: organizationPartyId,
        relationshipTypeEnumId: "PrtAgent",
        fromDate: 0
    })
    make("moqui.security.UserGroup", {userGroupId: id, description: "Checkout " + kind})
    for (const permission of permissions)
        make("moqui.security.UserGroupPermission", {userGroupId: id, userPermissionId: permission, fromDate: 0})
    make("moqui.security.UserAccount", {
        userId: id,
        username: id,
        partyId: id,
        currentPassword: "16ac58bbfa332c1c55bd98b53e60720bfa90d394",
        passwordHashType: "SHA",
        timeZone: "America/Chicago",
        locale: "en_US"
    })
    make("moqui.security.UserGroupMember", {userId: id, userGroupId: id, fromDate: 0})
    return id
}
// a call as a user, in its own transaction: its result and its refusal code ("" when it succeeds)
function run(username, service, parameters = {}) {
    login(username)
    const was = ec.artifactExecution.disableAuthz()
    ec.message.pushErrors()
    try {
        const out = ec.service.sync().name(service).parameters(parameters).requireNewTransaction(true).call() || {}
        return Object.assign({}, out, {error: ec.message.hasError() ? ec.message.getErrorsString() : ""})
    } catch (error) {
        return {error: String(error.message || error)}
    } finally {
        ec.message.clearErrors()
        ec.message.popErrors()
        if (!was) ec.artifactExecution.enableAuthz()
        login("john.doe")
    }
}
const code = out => (/([A-Z][A-Z0-9_]+):/.exec(out.error || "") || [])[1] || (out.error ? "ERROR" : "")
const manager = (service, parameters) => run(users.manager, A + service, Object.assign({productStoreId: ids.store}, parameters))
const finding = (key, user = users.reader) =>
    run(user, A + "check#StoreReadiness", {productStoreId: ids.store}).findings.find(row => row.key == key) || null
const history = () => run(users.reader, A + "get#Store", {productStoreId: ids.store, include: ["history"]}).history || []

spec({
    setupSpec() {
        system(() => {
            organization(orgA, "Checkout organization A")
            organization(orgB, "Checkout organization B")
            users.reader = user("reader", orgA, ["COMMERCE_VIEW"])
            users.manager = user("manager", orgA, ["COMMERCE_VIEW", "COMMERCE_STORE_EDIT"])
            users.other = user("other", orgB, ["COMMERCE_VIEW", "COMMERCE_STORE_EDIT"])
            // each organization's service queue (Customer Service set up: a policy whose default queue it offers)
            for (const [org, queue] of [
                [orgA, prefix + "_Q_A"],
                [orgB, prefix + "_Q_B"]
            ]) {
                make("mantle.request.RequestCategory", {
                    requestCategoryId: queue,
                    description: "Queue " + queue,
                    ownerPartyId: org
                })
                make("mantle.request.support.ServiceQueue", {serviceQueueId: queue, requestCategoryId: queue, fromDate: 0})
                make("mantle.request.support.ServicePolicy", {
                    servicePolicyId: queue,
                    organizationPartyId: org,
                    defaultCategoryId: queue,
                    caseWorkflowId: "CwfDefault",
                    fromDate: 0
                })
            }
            // gateways: A's enabled one and A's disabled one, and B's enabled one
            for (const [gateway, org, enabled] of [
                ["ON", orgA, "Y"],
                ["OFF", orgA, "N"],
                ["B", orgB, "Y"]
            ]) {
                const paymentGatewayConfigId = prefix + "_PG_" + gateway
                make("mantle.account.method.PaymentGatewayConfig", {
                    paymentGatewayConfigId,
                    paymentGatewayTypeEnumId: "PgtTest",
                    description: "Checkout gateway " + gateway,
                    authorizeServiceName: "mantle.account.PaymentTestServices.alwaysApprove#PaymentAuthorization"
                })
                make("mantle.account.method.PaymentGatewayOrganization", {
                    organizationPartyId: org,
                    paymentGatewayConfigId,
                    fromDate: 0,
                    isEnabled: enabled
                })
            }
            // a shipping gateway that serves no carrier
            make("mantle.shipment.carrier.ShippingGatewayConfig", {
                shippingGatewayConfigId: prefix + "_SHIP",
                description: "Checkout carrier gateway",
                getOrderRateServiceName: "mantle.shipment.CarrierServices.get#OrderShippingRate"
            })
            make("mantle.facility.Facility", {
                facilityId: prefix + "_WH",
                facilityTypeEnumId: "FcTpWarehouse",
                ownerPartyId: orgA
            })
        })
        ids.store = run(users.manager, A + "store#Store", {storeName: "Checkout store", organizationPartyId: orgA}).productStoreId
    }
})

feature(
    "the checkout policy is dated and validated per field, needs its reason, and takes only a queue the organization offers",
    {
        when() {
            const before = manager("get#CheckoutSettings").policy
            const refused = {
                badChoice: code(manager("store#CheckoutPolicy", {accountMode: "anyone", changeReason: "Test"})),
                otherQueue: code(manager("store#CheckoutPolicy", {supportQueueId: prefix + "_Q_B", changeReason: "Test"})),
                badGeo: code(manager("store#CheckoutPolicy", {destinations: "USA,NOWHERE", changeReason: "Test"})),
                noReason: code(manager("store#CheckoutPolicy", {accountMode: "account"})),
                reader: code(
                    run(users.reader, A + "store#CheckoutPolicy", {
                        productStoreId: ids.store,
                        accountMode: "account",
                        changeReason: "Test"
                    })
                ),
                other: code(
                    run(users.other, A + "store#CheckoutPolicy", {
                        productStoreId: ids.store,
                        accountMode: "account",
                        changeReason: "Test"
                    })
                )
            }
            const saved = manager("store#CheckoutPolicy", {
                accountMode: "account",
                destinations: "USA, CAN",
                supportQueueId: prefix + "_Q_A",
                contactPhone: "optional",
                changeReason: "Accounts only for launch"
            })
            const later = manager("store#CheckoutPolicy", {
                contactPhone: "required",
                fromDate: Date.now() + 86400000,
                changeReason: "Carriers ask for a phone"
            })
            const after = manager("get#CheckoutSettings").policy
            return {before, refused, saved, later: code(later), after, history: history()}
        },
        then({before, refused, saved, later, after, history}) {
            before.accountMode == "either"
            before.accountModeDefault == true
            before.termsRequired == "true"
            refused.badChoice == "VALUE_INVALID"
            refused.otherQueue == "QUEUE_NOT_OFFERED"
            refused.badGeo == "VALUE_INVALID"
            refused.noReason == "REASON_REQUIRED"
            refused.reader == "PERMISSION_DENIED"
            refused.other == "RECORD_UNAVAILABLE"
            // the phone kept its default value, so it is not a change
            saved.changed.sort() == ["accountMode", "destinations", "supportQueueId"]
            later == ""
            after.accountMode == "account"
            after.accountModeDefault == false
            after.destinations == "USA,CAN"
            after.contactPhone == "optional"
            after.contactPhoneNext == "required"
            // a new setting's audit rows carry its reason as its changeReason field (a create's audit row takes no reason, F63)
            history.some(
                row =>
                    row.fieldText.startsWith("Checkout: guest or account") &&
                    (row.changeReason == "Accounts only for launch" || row.newValueText == "Accounts only for launch")
            )
        }
    }
)

feature(
    "payment gateways come only from the organization's enabled ones and shipping gateways only approved ones; removals are recorded",
    {
        when() {
            const pay = (paymentGatewayConfigId, extra = {}) =>
                manager(
                    "store#StorePaymentGateway",
                    Object.assign({paymentInstrumentEnumId: "PiCreditCard", paymentGatewayConfigId}, extra)
                )
            const refused = {
                disabled: code(pay(prefix + "_PG_OFF")),
                otherOrganization: code(pay(prefix + "_PG_B")),
                noInstrument: code(
                    manager("store#StorePaymentGateway", {
                        paymentInstrumentEnumId: "ShMthGround",
                        paymentGatewayConfigId: prefix + "_PG_ON"
                    })
                ),
                shipNotApproved: code(
                    manager("store#StoreShippingGateway", {carrierPartyId: "_NA_", shippingGatewayConfigId: prefix + "_SHIP"})
                ),
                methodNotOffered: code(
                    manager("store#ShippingOption", {carrierPartyId: "_NA_", shipmentMethodEnumId: "ShMthMotor"})
                )
            }
            const bound = code(pay(prefix + "_PG_ON"))
            const ready = finding("payments")
            const settings = manager("get#CheckoutSettings")
            const shipGateway = code(
                manager("store#StoreShippingGateway", {carrierPartyId: "_NA_", shippingGatewayConfigId: "NA_LOCAL"})
            )
            const shipOption = code(
                manager("store#ShippingOption", {
                    carrierPartyId: "_NA_",
                    shipmentMethodEnumId: "ShMthGround",
                    sequenceNum: 1,
                    markupPercent: "5"
                })
            )
            const removeNoReason = code(pay(prefix + "_PG_ON", {remove: true}))
            const removed = pay(prefix + "_PG_ON", {remove: true, changeReason: "Moving to the hosted gateway"})
            const optionRemoved = code(
                manager("store#ShippingOption", {
                    carrierPartyId: "_NA_",
                    shipmentMethodEnumId: "ShMthGround",
                    remove: true,
                    changeReason: "No ground"
                })
            )
            return {
                refused,
                bound,
                ready,
                settings,
                shipGateway,
                shipOption,
                removeNoReason,
                removed,
                optionRemoved,
                after: finding("payments"),
                history: history()
            }
        },
        then(r) {
            r.refused.disabled == "GATEWAY_NOT_ENABLED"
            r.refused.otherOrganization == "GATEWAY_NOT_ENABLED"
            r.refused.noInstrument == "VALUE_INVALID"
            r.refused.shipNotApproved == "GATEWAY_NOT_APPROVED"
            r.refused.methodNotOffered == "METHOD_NOT_OFFERED"
            r.bound == ""
            r.ready.ready == true
            r.settings.paymentGateways[0].enabled == true
            r.settings.paymentGateways[0].capabilitiesText == "Card payment only"
            r.shipGateway == ""
            r.shipOption == ""
            r.removeNoReason == "REASON_REQUIRED"
            r.removed.removed == true
            r.optionRemoved == ""
            r.after.ready == false
            r.history.some(
                row =>
                    row.fieldText == "Payment gateway" &&
                    row.newValueText == "(removed)" &&
                    row.changeReason == "Moving to the hosted gateway"
            )
            r.history.some(
                row =>
                    row.fieldText == "Ship option method" &&
                    row.oldValueText.includes("Ground") &&
                    row.changeReason == "No ground"
            )
        }
    }
)

feature("readiness for purchase needs the support queue, each site's Support mount for the organization and its Terms page", {
    when() {
        const queue = finding("supportQueue")
        const noSite = {mount: finding("supportMount"), terms: finding("terms")}
        system(() => {
            make("mantle.public.PublicSite", {siteId: prefix + "_SITE", name: "Checkout site", state: "disabled"})
            make("mantle.public.PublicSiteApp", {
                siteId: prefix + "_SITE",
                appMountId: "shop",
                app: "shop",
                pathPrefix: "/",
                enabled: "Y",
                targetId: ids.store
            })
            make("mantle.public.PublicSiteApp", {
                siteId: prefix + "_SITE",
                appMountId: "support",
                app: "support",
                pathPrefix: "/support",
                enabled: "Y",
                targetId: orgB
            })
        })
        const wrongMount = finding("supportMount")
        system(() =>
            call("update#mantle.public.PublicSiteApp", {siteId: prefix + "_SITE", appMountId: "support", targetId: orgA})
        )
        const mount = finding("supportMount")
        const terms = finding("terms")
        manager("store#CheckoutPolicy", {termsRequired: "false", changeReason: "Terms on the invoice"})
        const pass = run(users.reader, A + "check#StoreReadiness", {
            input: {siteId: prefix + "_SITE", app: "shop", targetId: ids.store}
        })
        return {queue, noSite, wrongMount, mount, terms, termsOff: finding("terms"), pass}
    },
    then(r) {
        r.queue.ready == true
        r.queue.fix == "checkout"
        r.noSite.mount == null
        r.noSite.terms == null
        r.wrongMount.ready == false
        r.wrongMount.severity == "blocking"
        r.mount.ready == true
        r.terms.ready == false
        r.termsOff.ready == true
        r.pass.result.checks.some(row => row.name == "support pages" && row.ready)
        r.pass.result.checks.some(row => row.name == "local rates" && !row.ready)
    }
})

feature("the store's tax gateway changes with its reason, and a reader previews its tax without Accounting's read", {
    when() {
        const noReason = code(manager("store#StoreTax", {taxGatewayConfigId: "LOCAL"}))
        const notFacility = code(manager("store#StoreTax", {taxOriginFacilityId: prefix + "_WH", changeReason: "Origin"}))
        const saved = manager("store#StoreTax", {taxGatewayConfigId: "LOCAL", taxDisplay: "inclusive", changeReason: "Local tax"})
        const preview = run(users.reader, A + "preview#StoreTax", {
            productStoreId: ids.store,
            destinationGeoId: "USA_TX",
            amount: "100",
            shippingAmount: "5"
        })
        const other = code(
            run(users.other, A + "preview#StoreTax", {productStoreId: ids.store, destinationGeoId: "USA_TX", amount: "100"})
        )
        return {noReason, notFacility, saved, preview, other, tax: manager("get#CheckoutSettings").tax}
    },
    then(r) {
        r.noReason == "REASON_REQUIRED"
        r.notFacility == "FACILITY_UNAVAILABLE"
        r.saved.changed.sort() == ["taxDisplay", "taxGatewayConfigId"]
        r.preview.error == ""
        r.preview.gatewayName == "Local gateway for sales tax calc"
        r.preview.taxDisplay == "inclusive"
        r.preview.displayText.startsWith("Shown in prices")
        r.other == "RECORD_UNAVAILABLE"
        r.tax.taxGatewayConfigId == "LOCAL"
        r.tax.taxDisplayText == "Prices include tax"
    }
})

// Commerce P15: the store's readiness and configuration summary (get#StoreSummary; design-commerce §13): the reader's grouped
// sections, CSV and print, every credential redacted (a setting named as a token, a carrier's account; no gateway
// configuration); another organization's store refused.
feature("the configuration summary groups the store's settings for CSV and print with credentials redacted", {
    when() {
        system(() => {
            make("moqui.basic.Enumeration", {
                enumId: prefix + "_API_TOKEN",
                enumTypeId: "ProductStoreSettingType",
                description: "Partner API token"
            })
            make(S + "ProductStoreSetting", {
                productStoreId: ids.store,
                settingTypeEnumId: prefix + "_API_TOKEN",
                fromDate: 0,
                settingValue: "tok-s3cr3t-value"
            })
            call("store#" + S + "ProductStoreShippingGateway", {
                productStoreId: ids.store,
                carrierPartyId: "_NA_",
                shippingGatewayConfigId: prefix + "_SHIP",
                billingAccount: "ACCT-987654321"
            })
        })
        return {
            summary: run(users.reader, A + "get#StoreSummary", {productStoreId: ids.store}),
            other: run(users.other, A + "get#StoreSummary", {productStoreId: ids.store})
        }
    },
    then({summary, other}) {
        summary.error == ""
        summary.sections.map(section => section.key) ==
            ["readiness", "general", "sites", "facilities", "staff", "emails", "orderChecks", "content", "settings", "checkout"]
        summary.sections.find(section => section.key == "readiness").rows.length > 0
        summary.sections.find(section => section.key == "settings").rows.find(entry => entry.item == "Partner API token").value ==
            "[redacted]"
        summary.sections.find(section => section.key == "checkout").rows.some(entry => entry.state.includes("[redacted]"))
        summary.sections.find(section => section.key == "checkout").rows.some(entry => entry.item == "Tax gateway")
        summary.csvText.startsWith("Store configuration summary,Checkout store (" + ids.store + ")")
        summary.csvText.includes("Section,Item,Value,State")
        summary.printHtml.includes("<h1>Checkout store (" + ids.store + ")</h1>")
        summary.fileName.startsWith("store-" + ids.store + "-")
        !JSON.stringify(summary).includes("tok-s3cr3t-value")
        !JSON.stringify(summary).includes("987654321")
        !JSON.stringify(summary).includes("alwaysApprove")
        code(other) == "RECORD_UNAVAILABLE"
    }
})
