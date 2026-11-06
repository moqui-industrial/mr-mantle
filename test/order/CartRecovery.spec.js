// Cart recovery (impl-commerce P10; design-commerce §6 CartDetail, §8 RecoveryPolicy, §12.2 scenario 9;
// mantle.order.StoreOperationsServices' recovery and ShopCartServices.recover#Cart over CartRecovery.js): nothing is sent until
// a store enables recovery, whose policy the store editor saves as dated settings; the job sends one recovery to a signed-in,
// opted-in, verified customer's cart idle past the delay, none to an active, a guest's, an unconsented or a completed cart, a
// failing send does not stop the batch, and a second run sends nothing more (one mail per cart and window, the ledger's key);
// the store's delay is Carts' abandonment; the link restores the cart for its own signed-in account once, repriced with the
// unavailable line named and a new capability, a visitor signs in first and another account, a spent and an expired link reach
// nothing; a completed checkout, the shopper coming back or cart reminders turned off suppresses what was queued; a staff
// send needs COMMERCE_RECOVERY, a reason, the store (another organization's operator reaches nothing) and an eligible cart,
// previews the exact body and answers once per key. Standalone: spec-local organization, stores, sites, products,
// accounts and carts made directly. Run: ./moq test mr-mantle --spec CartRecovery
const O = "mantle.order.StoreOperationsServices."
const capture = ec.factory.getTool("MailCapture")
const prefix = "CRCV"
const ids = {
    org: prefix + "_ORG",
    otherOrg: prefix + "_ORG_B",
    store: prefix + "_STORE",
    storeB: prefix + "_STORE_B",
    site: prefix + "_SITE",
    siteB: prefix + "_SITE_B",
    host: "shop.crcv.example.test",
    mug: prefix + "_MUG",
    pen: prefix + "_PEN",
    template: prefix + "_MAIL",
    buyer: prefix + "_BUYER",
    buyerB: prefix + "_BUYER_B",
    other: prefix + "_OTHER"
}
const carts = {}
const users = {}
const MINUTE = 60000
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
const one = (entity, fields) => ec.entity.find(entity).condition(fields).useCache(false).disableAuthz().one()
const list = (entity, fields) => Array.from(ec.entity.find(entity).condition(fields).useCache(false).disableAuthz().list())
// a call as a user (null: a visitor), in its own transaction: its result and its refusal ("" when it succeeds)
function run(username, service, parameters = {}) {
    if (username) login(username)
    else logout()
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
const code = out => (/([A-Z][A-Z0-9_]+)(\[[^\]]*\])?:/.exec(out.error || "") || [])[1] || (out.error ? "ERROR" : "")
const recover = (username, token) =>
    run(username, "mantle.order.ShopCartServices.recover#Cart", {input: {siteId: ids.site, token}})
function person(partyId, lastName) {
    make("mantle.party.Party", {partyId, partyTypeEnumId: "PtyPerson"})
    make("mantle.party.Person", {partyId, firstName: "Recovery", lastName})
}
function customer(partyId) {
    person(partyId, partyId)
    make("mantle.party.PartyRole", {partyId, roleTypeId: "Customer"})
    const email = partyId.toLowerCase() + "@crcv.example.test"
    make("moqui.security.UserAccount", {
        userId: partyId,
        username: partyId,
        partyId,
        emailAddress: email,
        currentPassword: "16ac58bbfa332c1c55bd98b53e60720bfa90d394",
        passwordHashType: "SHA",
        timeZone: "UTC"
    })
    make("moqui.security.public.VerifiedAddress", {userId: partyId, emailAddress: email, verifiedAt: ec.user.nowTimestamp})
}
function consent(partyId, productStoreId) {
    call("mantle.public.AccountHubServices.apply#CheckoutOptIn", {
        optInId: "cartReminders",
        mode: "grant",
        partyId,
        productStoreId,
        sourceEnumId: "PcsForm",
        evidenceText: "Cart recovery spec"
    })
}
function staff(kind, permissions, organizationPartyId = ids.org) {
    const id = prefix + "_" + kind.toUpperCase()
    person(id, kind)
    make("mantle.party.PartyRelationship", {
        partyRelationshipId: id,
        fromPartyId: id,
        toPartyId: organizationPartyId,
        relationshipTypeEnumId: "PrtAgent",
        fromDate: 0
    })
    make("moqui.security.UserGroup", {userGroupId: id, description: "Cart recovery " + kind})
    for (const permission of permissions)
        make("moqui.security.UserGroupPermission", {userGroupId: id, userPermissionId: permission, fromDate: 0})
    make("moqui.security.UserAccount", {
        userId: id,
        username: id,
        partyId: id,
        currentPassword: "16ac58bbfa332c1c55bd98b53e60720bfa90d394",
        passwordHashType: "SHA",
        timeZone: "UTC"
    })
    make("moqui.security.UserGroupMember", {userId: id, userGroupId: id, fromDate: 0})
    return id
}
function site(siteId, productStoreId, hostname) {
    make("mantle.public.PublicSite", {siteId, name: "Recovery site", state: "published", locale: "en", generation: 1})
    if (hostname) make("mantle.public.PublicSiteHost", {hostname, siteId, canonical: "Y"})
    make("mantle.public.PublicSiteApp", {
        siteId,
        appMountId: "shop",
        app: "shop",
        pathPrefix: "/shop",
        enabled: "Y",
        targetId: productStoreId
    })
    make("mantle.public.PublicSiteApp", {
        siteId,
        appMountId: "account",
        app: "account",
        pathPrefix: "/account",
        enabled: "Y",
        targetId: ids.org
    })
}
// a Shop cart made directly: an open order of the store with its lines at their prices, and its access row (the account's,
// or a guest's) last active minutesIdle ago
function cart(name, {partyId, productStoreId = ids.store, siteId = ids.site, minutesIdle = 180, lines = [[ids.mug, 2, "8.00"]]}) {
    const orderId = prefix + "_" + name.toUpperCase()
    const guest = !partyId
    if (guest) person(orderId + "_G", "Guest")
    make("mantle.order.OrderHeader", {
        orderId,
        productStoreId,
        statusId: "OrderOpen",
        currencyUomId: "USD",
        salesChannelEnumId: "ScWeb",
        entryDate: ec.user.nowTimestamp,
        grandTotal: "16.00"
    })
    make("mantle.order.OrderPart", {
        orderId,
        orderPartSeqId: "01",
        vendorPartyId: ids.org,
        customerPartyId: partyId || orderId + "_G",
        statusId: "OrderOpen"
    })
    lines.forEach(([productId, quantity, unitAmount], index) =>
        make("mantle.order.OrderItem", {
            orderId,
            orderItemSeqId: "0" + (index + 1),
            orderPartSeqId: "01",
            itemTypeEnumId: "ItemProduct",
            productId,
            itemDescription: "Recovery " + productId,
            quantity,
            unitAmount
        })
    )
    make("mantle.order.StoreCartAccess", {
        cartAccessId: orderId,
        orderId,
        siteId,
        appMountId: "shop",
        productStoreId,
        currencyUomId: "USD",
        customerPartyId: partyId || null,
        guestPartyId: guest ? orderId + "_G" : null,
        capabilityDigest: ec.user.singleUseCodeHash(orderId + "-capability"),
        lastActivityDate: new Date(Date.now() - minutesIdle * MINUTE),
        expireDate: new Date(Date.now() + 30 * 1440 * MINUTE),
        createdDate: ec.user.nowTimestamp
    })
    carts[name] = orderId
    return orderId
}
const deliveries = orderId =>
    list("mantle.party.MessageDelivery", {sourceEnumId: "MdsrcCartRecovery"}).filter(row =>
        String(row.eventKey).startsWith("cartRecovery:" + orderId + ":")
    )
const tokenOf = message => decodeURIComponent((/Recover\?r=([A-Za-z0-9_%-]+)/.exec(message?.body || "") || [])[1] || "")

spec({
    setupSpec() {
        capture.enable()
        system(() => {
            make("mantle.party.Party", {partyId: ids.org, partyTypeEnumId: "PtyOrganization"})
            make("mantle.party.Organization", {partyId: ids.org, organizationName: "Recovery organization"})
            make("mantle.party.PartyRole", {partyId: ids.org, roleTypeId: "OrgInternal"})
            make("mantle.party.Party", {partyId: ids.otherOrg, partyTypeEnumId: "PtyOrganization"})
            make("mantle.party.Organization", {partyId: ids.otherOrg, organizationName: "Recovery other organization"})
            make("mantle.party.PartyRole", {partyId: ids.otherOrg, roleTypeId: "OrgInternal"})
            make("moqui.basic.email.EmailServer", {
                emailServerId: "CRCV_SMTP",
                smtpHost: "127.0.0.1",
                smtpPort: "9",
                smtpStartTls: "N"
            })
            make("moqui.basic.email.EmailTemplate", {
                emailTemplateId: ids.template,
                description: "Cart recovery spec",
                emailServerId: "CRCV_SMTP",
                fromAddress: "store@crcv.example.test",
                subject: "Your cart is waiting",
                bodyScreenLocation: "component://framework/screen/ScreenRenderEmail.xml"
            })
            for (const productStoreId of [ids.store, ids.storeB]) {
                make("mantle.product.store.ProductStore", {
                    productStoreId,
                    storeName: "Recovery store",
                    organizationPartyId: ids.org,
                    defaultCurrencyUomId: "USD",
                    defaultLocale: "en_US",
                    requireInventory: "N",
                    defaultDisableShippingCalc: "Y"
                })
                make("mantle.product.store.ProductStoreEmail", {
                    productStoreId,
                    emailTypeEnumId: "PsetCartRecovery",
                    fromDate: 0,
                    emailTemplateId: ids.template
                })
            }
            site(ids.site, ids.store, ids.host)
            // store B's site has no canonical host, so its recovery has no link to make: a failing send
            site(ids.siteB, ids.storeB, null)
            for (const [productId, price] of [
                [ids.mug, "10.00"],
                [ids.pen, "5.00"]
            ]) {
                make("mantle.product.Product", {
                    productId,
                    productName: "Recovery " + productId,
                    productTypeEnumId: "PtDigital",
                    ownerPartyId: ids.org
                })
                make("mantle.product.ProductPrice", {
                    productId,
                    pricePurposeEnumId: "PppPurchase",
                    priceTypeEnumId: "PptCurrent",
                    fromDate: 0,
                    minQuantity: 1,
                    price,
                    priceUomId: "USD"
                })
                for (const productStoreId of [ids.store, ids.storeB])
                    make("mantle.product.store.ProductStoreProduct", {
                        productStoreId,
                        productId,
                        fromDate: 0,
                        publicationKindEnumId: "PspkPublished"
                    })
            }
            for (const partyId of [ids.buyer, ids.buyerB, ids.other]) customer(partyId)
            consent(ids.buyer, ids.store)
            consent(ids.buyerB, ids.storeB)
            users.operator = staff("operator", [
                "COMMERCE_VIEW",
                "COMMERCE_ORDER_VIEW",
                "COMMERCE_RECOVERY",
                "COMMERCE_STORE_EDIT"
            ])
            users.reader = staff("reader", ["COMMERCE_VIEW", "COMMERCE_ORDER_VIEW"])
            // another organization's operator, every recovery permission but not this store
            users.outsider = staff(
                "outsider",
                ["COMMERCE_VIEW", "COMMERCE_ORDER_VIEW", "COMMERCE_RECOVERY", "COMMERCE_STORE_EDIT"],
                ids.otherOrg
            )
            cart("ok", {
                partyId: ids.buyer,
                lines: [
                    [ids.mug, 2, "8.00"],
                    [ids.pen, 1, "5.00"]
                ]
            })
            // idle 90 minutes: abandoned by the default hour, not by the store's two-hour delay
            cart("active", {partyId: ids.buyer, minutesIdle: 90})
            cart("guest", {partyId: null})
            cart("unconsented", {partyId: ids.other})
            const done = cart("done", {partyId: ids.buyer})
            call("update#mantle.order.OrderHeader", {orderId: done, statusId: "OrderPlaced"})
            make("mantle.order.StoreCheckout", {
                checkoutId: done,
                cartAccessId: done,
                orderId: done,
                siteId: ids.site,
                productStoreId: ids.store,
                statusId: "ScoCompleted",
                createdDate: ec.user.nowTimestamp
            })
            cart("broken", {partyId: ids.buyerB, productStoreId: ids.storeB, siteId: ids.siteB})
        })
    },
    cleanupSpec() {
        capture.reset()
        login("john.doe")
    }
})

feature("nothing is sent until a store enables recovery, a policy of dated settings the store editor saves", {
    when() {
        capture.clear()
        const before = run(users.operator, O + "run#CartRecovery", {productStoreIds: [ids.store, ids.storeB]})
        const off = run(users.operator, O + "get#CartRecovery", {orderId: carts.ok}).recovery
        const policy = {productStoreId: ids.store, enabled: "true", delayMinutes: "120", maxSends: "1"}
        const reader = run(users.reader, "mantle.product.StoreAdminServices.store#CartRecoveryPolicy", policy)
        const noReason = run(users.operator, "mantle.product.StoreAdminServices.store#CartRecoveryPolicy", policy)
        const tooSoon = run(
            users.operator,
            "mantle.product.StoreAdminServices.store#CartRecoveryPolicy",
            Object.assign({}, policy, {delayMinutes: "5", changeReason: "Start recovery"})
        )
        const badOptIn = run(users.operator, "mantle.product.StoreAdminServices.store#CartRecoveryPolicy", {
            productStoreId: ids.store,
            checkoutOptIns: "news,spam",
            changeReason: "Opt-ins"
        })
        const saved = run(
            users.operator,
            "mantle.product.StoreAdminServices.store#CartRecoveryPolicy",
            Object.assign({}, policy, {checkoutOptIns: "cartReminders,reviewRequests", changeReason: "Start recovery"})
        )
        const savedB = run(users.operator, "mantle.product.StoreAdminServices.store#CartRecoveryPolicy", {
            productStoreId: ids.storeB,
            enabled: "true",
            changeReason: "Start recovery"
        })
        const read = run(users.reader, "mantle.product.StoreAdminServices.get#CartRecoveryPolicy", {productStoreId: ids.store})
        return {before, off, reader, noReason, tooSoon, badOptIn, saved, savedB, read, sent: capture.count()}
    },
    then(r) {
        r.before.stores == 0 && r.sent == 0
        r.off.reasonCode == "RECOVERY_OFF"
        r.off.eligible == false
        code(r.reader) == "PERMISSION_DENIED"
        code(r.noReason) == "REASON_REQUIRED"
        code(r.tooSoon) == "VALUE_INVALID"
        code(r.badOptIn) == "VALUE_INVALID"
        r.saved.error == ""
        r.saved.changed.includes("enabled") && r.saved.changed.includes("delayMinutes")
        // reviewRequests is shown first, as the checkout lists them
        r.read.values.checkoutOptIns == "reviewRequests,cartReminders"
        r.read.view.enabledText == "On"
        r.read.view.delayText == "2 hours"
        r.read.canEdit == false
        r.savedB.error == ""
    }
})

feature("the job sends one recovery to the opted-in idle cart and no other; a failing send does not stop the batch", {
    when() {
        capture.clear()
        const first = run(users.operator, O + "run#CartRecovery", {productStoreIds: [ids.store, ids.storeB]})
        const mails = capture.getMessages()
        const second = run(users.operator, O + "run#CartRecovery", {productStoreIds: [ids.store, ids.storeB]})
        const reason = name => run(users.operator, O + "get#CartRecovery", {orderId: carts[name]}).recovery?.reasonCode
        const found = run(users.operator, O + "find#StoreCarts", {productStoreId: ids.store, state: "abandoned", pageSize: 50})
        return {
            first,
            second,
            mails,
            after: capture.count(),
            ok: deliveries(carts.ok),
            broken: deliveries(carts.broken),
            others: ["active", "guest", "unconsented", "done"].map(name => deliveries(carts[name]).length),
            reasons: Object.fromEntries(["ok", "active", "guest", "unconsented"].map(name => [name, reason(name)])),
            history: run(users.operator, O + "get#CartRecovery", {orderId: carts.ok}).recovery,
            abandoned: (found.carts || []).map(row => row.orderId),
            okAccess: one("mantle.order.StoreCartAccess", {cartAccessId: carts.ok}),
            unconsentedAccess: one("mantle.order.StoreCartAccess", {cartAccessId: carts.unconsented})
        }
    },
    then(r) {
        r.first.queued == 2
        r.first.failed == 1
        r.first.failures[0].startsWith(carts.broken)
        r.mails.length == 1
        r.mails[0].toList.includes("crcv_buyer@crcv.example.test")
        r.mails[0].body.includes("Recover?r=")
        r.mails[0].body.includes("/account/EmailPreferences")
        r.ok.length == 1 && r.ok[0].stateEnumId == "MdsSent"
        JSON.parse(r.ok[0].consentJson).granted == true
        r.broken.length == 1 && r.broken[0].stateEnumId == "MdsFailed"
        r.others == [0, 0, 0, 0]
        r.second.queued == 0
        // the two carts handled for this visit are marked and not read again (F133); the unconsented one still is
        r.second.carts == r.first.carts - 2
        Number(r.okAccess.recoveryHandledDate) == Number(r.okAccess.lastActivityDate)
        r.unconsentedAccess.recoveryHandledDate == null
        r.after == 1
        r.reasons.ok == "ALREADY_SENT"
        r.reasons.active == "ACTIVE"
        r.reasons.guest == "GUEST"
        r.reasons.unconsented == "NO_CONSENT"
        r.history.sends.length == 1
        r.history.sends[0].toText == "c…@crcv.example.test"
        r.history.consentText == "Cart reminders on"
        // the store's two-hour delay is Carts' abandonment
        r.abandoned.includes(carts.ok)
        !r.abandoned.includes(carts.active)
    }
})

feature("the link restores the cart for its own account once, repriced with the unavailable line named", {
    when() {
        const token = tokenOf(capture.getMessages()[0])
        // the pen is withdrawn from the store, so it cannot be bought now
        system(() => {
            const row = one("mantle.product.store.ProductStoreProduct", {productStoreId: ids.store, productId: ids.pen})
            call("update#mantle.product.store.ProductStoreProduct", {
                productStoreId: ids.store,
                productId: ids.pen,
                fromDate: row.fromDate,
                thruDate: ec.user.nowTimestamp
            })
        })
        const visitor = recover(null, token)
        const other = recover(ids.other, token)
        const restored = recover(ids.buyer, token)
        const again = recover(ids.buyer, token)
        const access = one("mantle.order.StoreCartAccess", {cartAccessId: carts.ok})
        // an expired link: the active cart's token past its window
        system(() =>
            call("update#mantle.order.StoreCartAccess", {
                cartAccessId: carts.active,
                recoveryTokenDigest: ec.user.singleUseCodeHash("x".repeat(48)),
                recoveryExpireDate: new Date(Date.now() - MINUTE)
            })
        )
        const expired = recover(ids.buyer, "x".repeat(48))
        return {
            token,
            visitor,
            other,
            restored,
            again,
            access,
            expired,
            history: run(users.operator, O + "get#CartRecovery", {orderId: carts.ok}).recovery
        }
    },
    then(r) {
        r.token.length == 48
        code(r.visitor) == "SIGN_IN_REQUIRED"
        code(r.other) == "NOT_AVAILABLE"
        r.restored.error == ""
        r.restored.result.recovered == true
        r.restored.result.token.length == 48
        r.restored.result.unavailableItems == ["Recovery " + ids.pen]
        r.restored.result.cart.items.find(item => item.productId == ids.mug).unitPrice.amount == "10.00"
        code(r.again) == "NOT_AVAILABLE"
        r.access.recoveryTokenDigest == null
        r.access.recoveryUsedDate != null
        // the restored visit clears the job's mark (F133)
        r.access.recoveryHandledDate == null
        r.access.capabilityDigest == ec.user.singleUseCodeHash(r.restored.result.token)
        code(r.expired) == "NOT_AVAILABLE"
        r.history.sends[0].redeemed == true
        r.history.redeemedText != ""
    }
})

feature(
    "a completed checkout, the shopper back or reminders turned off suppress a queued recovery; a staff send needs COMMERCE_RECOVERY, a reason, the store and an eligible cart, once per key",
    {
        when() {
            capture.clear()
            const late = system(() => cart("late", {partyId: ids.buyer}))
            const manual = system(() => cart("manual", {partyId: ids.buyer}))
            const queued = run(users.operator, O + "queue#CartRecovery", {orderId: late, sendNow: false})
            system(() => {
                call("update#mantle.order.OrderHeader", {orderId: late, statusId: "OrderPlaced"})
                make("mantle.order.StoreCheckout", {
                    checkoutId: late,
                    cartAccessId: late,
                    orderId: late,
                    siteId: ids.site,
                    productStoreId: ids.store,
                    statusId: "ScoCompleted",
                    createdDate: ec.user.nowTimestamp
                })
            })
            const attempted = run(users.operator, "mantle.party.MessageServices.attempt#Delivery", {
                deliveryId: queued.deliveryId
            })
            const send = (user, extra) =>
                run(user, O + "send#CartRecovery", Object.assign({orderId: manual, operationKey: "CRCV-SEND-1"}, extra))
            const reader = send(users.reader, {reason: "Asked by phone"})
            const noReason = send(users.operator, {})
            const preview = run(users.operator, O + "get#CartRecovery", {orderId: manual, preview: true}).recovery
            const sent = send(users.operator, {reason: "Asked by phone", orderRevision: preview.orderRevision})
            const retry = send(users.operator, {reason: "Asked by phone", orderRevision: preview.orderRevision})
            const secondKey = send(users.operator, {reason: "Asked by phone", operationKey: "CRCV-SEND-2"})
            const guest = run(users.operator, O + "send#CartRecovery", {
                orderId: carts.guest,
                reason: "Try",
                operationKey: "CRCV-SEND-3"
            })
            const outsiderRead = run(users.outsider, O + "get#CartRecovery", {orderId: manual})
            const outsiderSend = run(users.outsider, O + "send#CartRecovery", {
                orderId: manual,
                reason: "Try",
                operationKey: "CRCV-SEND-4"
            })
            // queued, then the shopper came back to one cart and turned cart reminders off for the other: both suppressed
            const back = system(() => cart("back", {partyId: ids.buyer}))
            const backQueued = run(users.operator, O + "queue#CartRecovery", {orderId: back, sendNow: false})
            system(() =>
                call("update#mantle.order.StoreCartAccess", {cartAccessId: back, lastActivityDate: ec.user.nowTimestamp})
            )
            const backAttempt = run(users.operator, "mantle.party.MessageServices.attempt#Delivery", {
                deliveryId: backQueued.deliveryId
            })
            const withdrawn = system(() => cart("withdrawn", {partyId: ids.buyer}))
            const withdrawnQueued = run(users.operator, O + "queue#CartRecovery", {orderId: withdrawn, sendNow: false})
            system(() =>
                call("mantle.party.ConsentServices.store#PartyConsent", {
                    partyId: ids.buyer,
                    purposeEnumId: "PcpCartReminder",
                    statusId: "PconWithdrawn",
                    contactListId: ec.resource
                        .script("component://mr-mantle/service/mantle/public/StoreTopics.js")
                        .topicList("cartReminders", ids.store, false),
                    sourceEnumId: "PcsForm",
                    evidenceText: "Cart recovery spec: turned off",
                    updateSolicitation: false
                })
            )
            const withdrawnAttempt = run(users.operator, "mantle.party.MessageServices.attempt#Delivery", {
                deliveryId: withdrawnQueued.deliveryId
            })
            const lastError = deliveryId => one("mantle.party.MessageDelivery", {deliveryId})?.lastError
            return {
                backError: lastError(backQueued.deliveryId),
                withdrawnError: lastError(withdrawnQueued.deliveryId),
                outsiderRead,
                outsiderSend,
                backQueued,
                backAttempt,
                withdrawnQueued,
                withdrawnAttempt,
                queued,
                attempted,
                late: one("mantle.party.MessageDelivery", {deliveryId: queued.deliveryId}),
                reader,
                noReason,
                preview,
                sent,
                retry,
                secondKey,
                guest,
                mails: capture.count()
            }
        },
        then(r) {
            r.queued.queued == true
            r.attempted.stateEnumId == "MdsSuppressed"
            r.late.stateEnumId == "MdsSuppressed"
            code(r.reader) == "PERMISSION_DENIED"
            code(r.noReason) == "REASON_REQUIRED"
            r.preview.canSend == true
            r.preview.preview.subject == "Your cart is waiting"
            r.preview.preview.body.includes("You left items in your cart at Recovery store")
            r.preview.preview.body.includes("LINK-MADE-WHEN-SENT")
            r.sent.error == "" && r.sent.stateEnumId == "MdsSent"
            r.retry.alreadyApplied == true && r.retry.deliveryId == r.sent.deliveryId
            code(r.secondKey) == "ALREADY_SENT"
            code(r.guest) == "GUEST"
            code(r.outsiderRead) == "RECORD_UNAVAILABLE"
            code(r.outsiderSend) == "RECORD_UNAVAILABLE"
            r.backQueued.queued == true && r.backAttempt.stateEnumId == "MdsSuppressed"
            r.withdrawnQueued.queued == true && r.withdrawnAttempt.stateEnumId == "MdsSuppressed"
            r.backError == "The shopper came back to the cart"
            r.withdrawnError == "No consent for this message"
            r.mails == 1
        }
    }
)
