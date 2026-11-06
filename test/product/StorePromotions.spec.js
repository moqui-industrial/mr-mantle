// Store promotions (impl-commerce P7, COM-PROMO; mantle.product.StorePromotionServices, StorePromotions.js): a rule that is
// not registered refused, typed parameters and products, the permission and store refusals; codes taken ignoring case, the
// generated batch's collisions and retry, an expired code still readable; and the use limits counted under a lock at
// place#Order (F18): an order whose promotions set no limit placed as before, the TEST2 code of the demo store as the order
// screens use it, the promotion's per-customer and total limits, and two concurrent placements past a code's limit, one
// refused.
// Standalone: spec-local organizations, users, a store, products and customers; the demo store POPC_DEFAULT only for its
// TEST2 code. Run: ./moq test mr-mantle --spec StorePromotions
const P = "mantle.product.StorePromotionServices."
const S = "mantle.product.store."
const prefix = "STP7"
const orgA = prefix + "_ORG_A",
    orgB = prefix + "_ORG_B"
const ids = {
    store: prefix + "_STORE",
    other: prefix + "_OTHER",
    product: prefix + "_PROD",
    second: prefix + "_PROD2",
    foreign: prefix + "_FOREIGN"
}
const vendorId = "ORG_ZIZI_RETAIL"

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
const list = (entity, conditions) =>
    system(() =>
        Array.from(ec.entity.find(entity).condition(conditions).useCache(false).disableAuthz().list()).map(row => row.getMap())
    )
function organization(partyId, name) {
    make("mantle.party.Party", {partyId, partyTypeEnumId: "PtyOrganization"})
    make("mantle.party.Organization", {partyId, organizationName: name})
    make("mantle.party.PartyRole", {partyId, roleTypeId: "OrgInternal"})
}
function user(kind, organizationPartyId, permissions) {
    const id = prefix + "_" + kind.toUpperCase()
    make("mantle.party.Party", {partyId: id, partyTypeEnumId: "PtyPerson"})
    make("mantle.party.Person", {partyId: id, firstName: "Promotion", lastName: kind})
    make("mantle.party.PartyRelationship", {
        partyRelationshipId: id,
        fromPartyId: id,
        toPartyId: organizationPartyId,
        relationshipTypeEnumId: "PrtAgent",
        fromDate: 0
    })
    make("moqui.security.UserGroup", {userGroupId: id, description: "Store promotions " + kind})
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
const users = {}
// a call as a user, in its own transaction: its result and its refusal code ("" when it succeeds)
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
const code = out => (/([A-Z][A-Z0-9_]+):/.exec(out.error || "") || [])[1] || (out.error ? "ERROR" : "")
const key = () => prefix + "-" + Math.random().toString(36).slice(2, 12)
const manage = (service, parameters) => run(users.manager, P + service, parameters)
// a flat discount of 5 off a unit of a product of its own (so no other promotion of the store takes the unit first), with
// the limits given, on the spec store
let productCount = 0
function flatPromotion(description, extra = {}) {
    const productId = prefix + "_FLAT" + ++productCount
    system(() =>
        make("mantle.product.Product", {productId, productName: description, productTypeEnumId: "PtService", ownerPartyId: orgA})
    )
    const out = manage(
        "store#Promotion",
        Object.assign(
            {productStoreId: ids.store, serviceRegisterId: "FlatDiscount", itemDescription: description, requireCode: "N"},
            extra
        )
    )
    assert(!out.error, "promotion " + description + ": " + out.error)
    manage("store#PromotionParameters", {storePromotionId: out.storePromotionId, parameters: {discountAmount: "5"}})
    manage("store#PromotionProducts", {storePromotionId: out.storePromotionId, productIds: [productId]})
    return {storePromotionId: out.storePromotionId, productId}
}
function customer(name) {
    return system(
        () =>
            call("mantle.party.PartyServices.create#Person", {firstName: "Promo", lastName: name, roleTypeId: "Customer"}).partyId
    )
}
// a cart of the spec store (or another) for a customer with one unit of the spec product, repriced with its promotions
function cart(customerPartyId, productStoreId = ids.store, productId = ids.product, quantity = 1) {
    return system(() => {
        const created = call("mantle.order.OrderServices.create#Order", {
            vendorPartyId: vendorId,
            customerPartyId,
            productStoreId
        })
        call("mantle.order.OrderServices.add#OrderProductQuantity", {
            orderId: created.orderId,
            orderPartSeqId: created.orderPartSeqId,
            productId,
            quantity,
            unitAmount: 20,
            requireInventory: false
        })
        return created.orderId
    })
}
const addCode = (orderId, promoCode) =>
    system(() => call("mantle.product.PromotionServices.add#OrderPromoCode", {orderId, promoCode}))
const place = orderId => run("john.doe", "mantle.order.OrderServices.place#Order", {orderId, requireInventory: false})
const statusOf = orderId => list("mantle.order.OrderHeader", {orderId})[0].statusId
const promoItems = (orderId, storePromotionId) =>
    list("mantle.order.OrderItem", {orderId, isPromo: "Y"}).filter(
        item => !storePromotionId || item.storePromotionId === storePromotionId
    )

spec({
    setupSpec() {
        system(() => {
            organization(orgA, "Promotions organization A")
            organization(orgB, "Promotions organization B")
            make(S + "ProductStore", {
                productStoreId: ids.store,
                storeName: "Promotions store",
                organizationPartyId: orgA,
                defaultCurrencyUomId: "USD"
            })
            make(S + "ProductStore", {
                productStoreId: ids.other,
                storeName: "Other store",
                organizationPartyId: orgB,
                defaultCurrencyUomId: "USD"
            })
            make("mantle.product.Product", {
                productId: ids.product,
                productName: "Promotion service",
                productTypeEnumId: "PtService",
                ownerPartyId: orgA
            })
            make("mantle.product.Product", {
                productId: ids.second,
                productName: "Shared service",
                productTypeEnumId: "PtService",
                ownerPartyId: "_NA_"
            })
            make("mantle.product.Product", {
                productId: ids.foreign,
                productName: "Foreign service",
                productTypeEnumId: "PtService",
                ownerPartyId: orgB
            })
            users.reader = user("reader", orgA, ["COMMERCE_VIEW"])
            users.manager = user("manager", orgA, ["COMMERCE_VIEW", "COMMERCE_PROMOTION_EDIT"])
            users.other = user("other", orgB, ["COMMERCE_VIEW", "COMMERCE_PROMOTION_EDIT"])
        })
    }
})

feature("a promotion takes only a registered rule, its parameters typed by the rule, its store's products; others are refused", {
    when() {
        const base = {productStoreId: ids.store, itemDescription: "Ten percent", requireCode: "Y"}
        const notRegistered = manage("store#Promotion", Object.assign({serviceRegisterId: "OrderManualApprove"}, base))
        const forged = manage("store#Promotion", Object.assign({serviceRegisterId: "NoSuchRule"}, base))
        const zeroLimit = manage(
            "store#Promotion",
            Object.assign({serviceRegisterId: "BuyGetDiscount", useLimitPerCustomer: "0"}, base)
        )
        const reader = run(users.reader, P + "store#Promotion", Object.assign({serviceRegisterId: "BuyGetDiscount"}, base))
        const otherStore = run(users.other, P + "store#Promotion", Object.assign({serviceRegisterId: "BuyGetDiscount"}, base))
        const made = manage(
            "store#Promotion",
            Object.assign({serviceRegisterId: "BuyGetDiscount", useLimitPerCustomer: "1"}, base)
        )
        const storePromotionId = made.storePromotionId
        const badValue = manage("store#PromotionParameters", {storePromotionId, parameters: {discountPercent: "ten"}})
        const unknown = manage("store#PromotionParameters", {storePromotionId, parameters: {serviceName: "x"}})
        const partial = manage("store#PromotionParameters", {
            storePromotionId,
            parameters: {discountPercent: "10", buyQuantity: "0"}
        })
        const saved = manage("store#PromotionParameters", {
            storePromotionId,
            parameters: {getQuantity: "1", itemsWithPromo: "true"}
        })
        const foreign = manage("store#PromotionProducts", {storePromotionId, productIds: [ids.foreign]})
        const products = manage("store#PromotionProducts", {storePromotionId, productIds: [ids.product, ids.second]})
        manage("store#PromotionProducts", {storePromotionId, productIds: [ids.second], excludeProduct: "Y"})
        const ruleChange = manage("store#Promotion", {storePromotionId, serviceRegisterId: "FlatDiscount"})
        const stale = manage("store#Promotion", {storePromotionId, sequenceNum: 5, expectedLastUpdatedStamp: 1000})
        const read = run(users.reader, P + "get#Promotion", {storePromotionId})
        const otherRead = run(users.other, P + "get#Promotion", {storePromotionId})
        const found = run(users.reader, P + "find#Promotions", {productStoreId: ids.store, term: "ten"})
        const otherFind = run(users.other, P + "find#Promotions", {productStoreId: ids.store})
        const rules = run(users.reader, P + "find#PromotionOptions", {choice: "rules"})
        return {
            notRegistered,
            forged,
            zeroLimit,
            reader,
            otherStore,
            made,
            badValue,
            unknown,
            partial,
            saved,
            foreign,
            products,
            ruleChange,
            stale,
            read,
            otherRead,
            found,
            otherFind,
            rules
        }
    },
    then(r) {
        code(r.notRegistered) == "SERVICE_NOT_REGISTERED"
        code(r.forged) == "SERVICE_NOT_REGISTERED"
        code(r.zeroLimit) == "VALUE_INVALID"
        code(r.reader) == "PERMISSION_DENIED"
        code(r.otherStore) == "RECORD_UNAVAILABLE"
        code(r.made) == ""
        code(r.badValue) == "VALUE_INVALID"
        code(r.unknown) == "VALUE_INVALID"
        r.partial.missing == ["getQuantity"]
        r.saved.missing == []
        code(r.foreign) == "PRODUCT_UNAVAILABLE"
        code(r.products) == ""
        code(r.ruleChange) == "VALUE_INVALID"
        code(r.stale) == "STALE_REVISION"
        code(r.read) == ""
        r.read.canEdit == false
        r.read.promotion.limitsText == "1 uses per customer"
        r.read.parameters.find(row => row.parameterName == "discountPercent").kind == "number"
        r.read.parameters.find(row => row.parameterName == "discountPercent").parameterValue == "10"
        r.read.parameters.find(row => row.parameterName == "itemsWithPromo").kind == "boolean"
        r.read.parameters.some(row => row.parameterName == "storePromotionId") == false
        r.read.products.map(row => row.productId + ":" + row.excludeProduct) == [ids.product + ":N", ids.second + ":Y"]
        code(r.otherRead) == "RECORD_UNAVAILABLE"
        r.found.promotions.map(row => row.storePromotionId) == [r.made.storePromotionId]
        r.found.promotions[0].ruleText == "Buy X Get Y at Z% Discount"
        code(r.otherFind) == "RECORD_UNAVAILABLE"
        r.rules.options.map(option => option.value).includes("FlatDiscount")
        r.rules.options.map(option => option.value).includes("OrderManualApprove") == false
    }
})

feature(
    "codes: one taken ignoring case is refused, a generated batch names its collisions and a retry its first result, an expired code stays readable",
    {
        when() {
            const {storePromotionId} = flatPromotion("Code promotion", {requireCode: "Y"})
            const one = manage("store#PromoCode", {storePromotionId, promoCode: prefix + "SPRING", useLimitPerCustomer: "1"})
            const taken = manage("store#PromoCode", {storePromotionId, promoCode: (prefix + "spring").toLowerCase()})
            const badText = manage("store#PromoCode", {storePromotionId, promoCode: "two words"})
            manage("store#PromoCode", {storePromotionId, promoCode: prefix + "N3"})
            const batch = {storePromotionId, count: 5, prefix: prefix + "N", numbered: true, useLimitPerCustomer: "1"}
            const preview = manage("generate#PromoCodes", Object.assign({preview: true}, batch))
            const operationKey = key()
            const made = manage("generate#PromoCodes", Object.assign({operationKey}, batch))
            const retry = manage("generate#PromoCodes", Object.assign({operationKey}, batch))
            const random = manage("generate#PromoCodes", {storePromotionId, count: 3, prefix: prefix + "R-", operationKey: key()})
            const tooMany = manage("generate#PromoCodes", {storePromotionId, count: 501, operationKey: key()})
            const reader = run(users.reader, P + "generate#PromoCodes", Object.assign({operationKey: key()}, batch))
            const party = manage("store#PromoCodeParty", {promoCodeId: one.promoCodeId, partyId: customer("Party")})
            const expired = manage("expire#PromoCode", {promoCodeId: one.promoCodeId, changeReason: "Spec"})
            const again = manage("expire#PromoCode", {promoCodeId: one.promoCodeId})
            const read = run(users.reader, P + "get#PromoCode", {promoCodeId: one.promoCodeId})
            const ended = run(users.reader, P + "find#PromoCodes", {storePromotionId, state: "ended"})
            const all = run(users.reader, P + "find#PromoCodes", {storePromotionId, pageSize: 50})
            const otherRead = run(users.other, P + "get#PromoCode", {promoCodeId: one.promoCodeId})
            const audit = list("moqui.entity.EntityAuditLog", {
                changedEntityName: S + "ProductStorePromoCode",
                pkPrimaryValue: one.promoCodeId,
                changedFieldName: "thruDate"
            })
            return {
                one,
                taken,
                badText,
                preview,
                made,
                retry,
                random,
                tooMany,
                reader,
                party,
                expired,
                again,
                read,
                ended,
                all,
                otherRead,
                audit
            }
        },
        then(r) {
            code(r.one) == ""
            code(r.taken) == "CODE_TAKEN"
            code(r.badText) == "VALUE_INVALID"
            r.preview.taken == [prefix + "N3"]
            r.preview.makeCount == 4
            r.preview.existingWithPrefix == 1
            r.made.doneCount == 4
            r.made.failedCount == 1
            r.made.results.find(result => !result.ok).code == "CODE_TAKEN"
            r.retry.alreadyApplied == true
            r.retry.doneCount == 4
            r.random.doneCount == 3
            r.random.results.every(
                result => result.promoCode.startsWith(prefix + "R-") && result.promoCode.length == prefix.length + 10
            )
            code(r.tooMany) == "VALUE_INVALID"
            code(r.reader) == "PERMISSION_DENIED"
            code(r.party) == ""
            code(r.expired) == ""
            code(r.again) == "ALREADY_EXPIRED"
            r.read.code.state == "Ended"
            r.read.parties.length == 1
            r.ended.codes.map(row => row.promoCodeId) == [r.one.promoCodeId]
            r.all.codesCount == 9
            code(r.otherRead) == "RECORD_UNAVAILABLE"
            r.audit.map(row => row.changeReason).includes("Spec")
        }
    }
)

feature("a store order whose promotions set no limit is placed as before and locks nothing", {
    when() {
        const {storePromotionId, productId} = flatPromotion("No limit")
        const orderId = cart(customer("Unlimited"), ids.store, productId)
        const before = promoItems(orderId, storePromotionId).length
        const check = system(() => call(P + "check#OrderPromotionLimits", {orderId}))
        const placed = place(orderId)
        return {before, check, placed, status: statusOf(orderId), after: promoItems(orderId, storePromotionId).length}
    },
    then({before, check, placed, status, after}) {
        before == 1
        check.withinLimits == true
        check.locked == []
        placed.error == ""
        status == "OrderPlaced"
        after == 1
    }
})

feature(
    "the demo store's TEST2 code, as the order screens add it, is placed as before; the same customer's next order is refused the code",
    {
        when() {
            const customerPartyId = customer("Demo")
            const first = cart(customerPartyId, "POPC_DEFAULT", ids.second, 2)
            addCode(first, "TEST2")
            const before = promoItems(first, "PopcBuyGet").length
            const check = system(() => call(P + "check#OrderPromotionLimits", {orderId: first, lock: false}))
            const placed = place(first)
            const second = cart(customerPartyId, "POPC_DEFAULT", ids.second, 2)
            addCode(second, "TEST2")
            return {
                before,
                check,
                placed,
                status: statusOf(first),
                after: promoItems(first, "PopcBuyGet").length,
                secondCodes: list("mantle.order.OrderPromoCode", {orderId: second}).length,
                secondPlaced: place(second),
                secondStatus: statusOf(second)
            }
        },
        then(r) {
            // with one unit no buy-one-get-one applies; the order places with the items it had
            r.check.withinLimits == true
            r.placed.error == ""
            r.status == "OrderPlaced"
            r.after == r.before
            // add#OrderPromoCode's warning refuses the code once its per-customer use is placed (unchanged)
            r.secondCodes == (r.before > 0 ? 0 : 1)
            r.secondPlaced.error == ""
            r.secondStatus == "OrderPlaced"
        }
    }
)

feature(
    "the promotion's per-customer and total limits refuse a placement past them; repriced, the order places without the discount",
    {
        when() {
            const {storePromotionId, productId} = flatPromotion("Once each, twice in all", {
                useLimitPerCustomer: "1",
                useLimitPerPromotion: "2"
            })
            const shopper = customer("Shopper"),
                second = customer("Second"),
                third = customer("Third")
            // every cart is priced before any is placed, so each carries the discount
            const firstOrder = cart(shopper, ids.store, productId),
                againOrder = cart(shopper, ids.store, productId),
                secondOrder = cart(second, ids.store, productId),
                thirdOrder = cart(third, ids.store, productId)
            const firstPlaced = place(firstOrder)
            const preview = system(() => call(P + "check#OrderPromotionLimits", {orderId: againOrder, lock: false}))
            const again = place(againOrder)
            const secondPlaced = place(secondOrder)
            const third1 = place(thirdOrder)
            const partSeqId = list("mantle.order.OrderPart", {orderId: againOrder})[0].orderPartSeqId
            system(() =>
                call("mantle.order.OrderServices.handle#OrderMajorChange", {orderId: againOrder, orderPartSeqId: partSeqId})
            )
            const repriced = place(againOrder)
            return {
                firstPlaced,
                preview,
                again,
                secondPlaced,
                third1,
                thirdStatus: statusOf(thirdOrder),
                repriced,
                againItems: promoItems(againOrder, storePromotionId).length,
                uses: run(users.reader, P + "find#PromotionUses", {storePromotionId})
            }
        },
        then(r) {
            r.firstPlaced.error == ""
            r.preview.withinLimits == false
            r.preview.locked == []
            r.preview.exceeded.map(limit => limit.limitField) == ["useLimitPerCustomer"]
            code(r.again) == "PROMOTION_LIMIT_REACHED"
            r.secondPlaced.error == ""
            code(r.third1) == "PROMOTION_LIMIT_REACHED"
            r.third1.error.includes("2 uses in all")
            r.thirdStatus == "OrderOpen"
            r.repriced.error == ""
            r.againItems == 0
            r.uses.useCount == 2
            r.uses.orderCount == 2
            r.uses.uses.every(row => row.customerName && dec(row.discount).eq(5))
        }
    }
)

feature("a two-part order with a once-per-customer promotion: the second part is priced without it, and the order places", {
    when() {
        const {storePromotionId, productId} = flatPromotion("Once each over two parts", {useLimitPerCustomer: "1"})
        const shopper = customer("TwoParts")
        const orderId = cart(shopper, ids.store, productId)
        system(() => {
            const part = call("mantle.order.OrderServices.create#OrderPart", {
                orderId,
                vendorPartyId: vendorId,
                customerPartyId: shopper
            })
            call("mantle.order.OrderServices.add#OrderProductQuantity", {
                orderId,
                orderPartSeqId: part.orderPartSeqId,
                productId,
                quantity: 1,
                unitAmount: 20,
                requireInventory: false
            })
        })
        const discounted = promoItems(orderId, storePromotionId).length
        return {discounted, placed: place(orderId), status: statusOf(orderId)}
    },
    then({discounted, placed, status}) {
        // each part is priced alone; the other part's use counts against the limit (else place#Order refuses it every time)
        discounted == 1
        placed.error == ""
        status == "OrderPlaced"
    }
})

feature("two concurrent placements past a code's use limit: the second waits for the first's lock and is refused", {
    when() {
        const {storePromotionId, productId} = flatPromotion("One use of the code", {requireCode: "Y"})
        const made = manage("store#PromoCode", {storePromotionId, promoCode: prefix + "ONCE", useLimitPerCode: "1"})
        const orders = [cart(customer("First"), ids.store, productId), cart(customer("Racer"), ids.store, productId)]
        for (const orderId of orders) addCode(orderId, prefix + "ONCE")
        const discounted = orders.map(orderId => promoItems(orderId, storePromotionId).length)
        // the first thread places and holds its transaction (and the code's lock) a while; the second places meanwhile, in
        // its own transaction: without the lock it would count no use and place too
        const results = parallel(
            2,
            (thread, args) => {
                login("john.doe")
                ec.artifactExecution.disableAuthz()
                const wait = until => {
                    while (Date.now() < until);
                }
                if (thread === 0) {
                    ec.service
                        .sync()
                        .name("mantle.order.OrderServices.place#Order")
                        .parameters({orderId: args.orders[0], requireInventory: false})
                        .call()
                    const error = ec.message.hasError() ? ec.message.getErrorsString() : ""
                    wait(Date.now() + 400)
                    return {thread, error, at: Date.now()}
                }
                wait(Date.now() + 100)
                ec.message.pushErrors()
                try {
                    ec.service
                        .sync()
                        .name("mantle.order.OrderServices.place#Order")
                        .parameters({orderId: args.orders[1], requireInventory: false})
                        .requireNewTransaction(true)
                        .call()
                    return {thread, error: ec.message.hasError() ? ec.message.getErrorsString() : "", at: Date.now()}
                } finally {
                    ec.message.clearErrors()
                    ec.message.popErrors()
                }
            },
            {orders}
        )
        return {discounted, results, statuses: orders.map(statusOf), made}
    },
    then({discounted, results, statuses, made}) {
        code(made) == ""
        discounted == [1, 1]
        // the first thread normally takes the lock; under load the second may, so either one places and the other is refused
        const refused = statuses.indexOf("OrderOpen")
        statuses.filter(status => status == "OrderPlaced").length == 1
        refused >= 0
        results[1 - refused].error == ""
        code(results[refused]) == "PROMOTION_LIMIT_REACHED"
    }
})
