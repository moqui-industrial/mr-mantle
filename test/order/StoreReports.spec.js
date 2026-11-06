// Store reports (impl-commerce P11, COM-REPORTS; StoreOperationsServices.get#CartRecoverySummary,
// StorePromotionServices.get#PromotionUseSummary, StoreReports.js): the cart recovery funnel of a store's carts opened in the
// period, by currency (opened, placed, abandoned, signed in, sends with a suppressed one left out, delivered, recovered by
// the link used after the latest send, F130, and its value), an open cart never counted as placed; promotion use by
// promotion, code and currency (orders, uses, discount, the orders' net sales, the uses left), an open cart's promotion line
// never counted; the store scope (another organization's store, and another store for a store-limited staff member,
// refused) and the period.
// Standalone: spec-local organizations, stores, users, carts, orders, deliveries and promotions made directly. Run:
// ./moq test mr-mantle --spec StoreReports
const O = "mantle.order.StoreOperationsServices."
const P = "mantle.product.StorePromotionServices."
const prefix = "SRPT"
const orgA = prefix + "_ORG_A",
    orgB = prefix + "_ORG_B"
const ids = {
    storeA: prefix + "_A1",
    storeA2: prefix + "_A2",
    storeB: prefix + "_B1",
    product: prefix + "_PROD",
    customer: prefix + "_CUST",
    promotion: prefix + "_PROMO",
    code: prefix + "_CODE"
}
const hour = 3600000

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
function party(partyId, organization, name, roleTypeId) {
    make("mantle.party.Party", {partyId, partyTypeEnumId: organization ? "PtyOrganization" : "PtyPerson"})
    if (organization) make("mantle.party.Organization", {partyId, organizationName: name})
    else make("mantle.party.Person", {partyId, firstName: "Report", lastName: name})
    make("mantle.party.PartyRole", {partyId, roleTypeId})
}
function user(kind, organizationPartyId, permissions) {
    const id = prefix + "_" + kind.toUpperCase()
    party(id, false, kind, "StoreStaff")
    make("mantle.party.PartyRelationship", {
        partyRelationshipId: id,
        fromPartyId: id,
        toPartyId: organizationPartyId,
        relationshipTypeEnumId: "PrtAgent",
        fromDate: 0
    })
    make("moqui.security.UserGroup", {userGroupId: id, description: "Store reports " + kind})
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
const num = value => (value == null ? null : Number(String(value)))
const ago = millis => new Date(Number(ec.user.nowTimestamp) - millis)
// a cart of a store (its order and Shop access row): statusId OrderOpen for a cart, a placed status for one checked out
function cart(key, productStoreId, options) {
    const orderId = prefix + "_" + key
    const statusId = options.statusId || "OrderOpen"
    const currencyUomId = options.currencyUomId || "USD"
    make("mantle.order.OrderHeader", {
        orderId,
        productStoreId,
        statusId,
        currencyUomId,
        entryDate: ago(4 * hour),
        placedDate: statusId === "OrderOpen" ? null : ago(hour),
        grandTotal: 20
    })
    make("mantle.order.OrderPart", {
        orderId,
        orderPartSeqId: "01",
        vendorPartyId: productStoreId === ids.storeB ? orgB : orgA,
        customerPartyId: ids.customer,
        statusId,
        partTotal: 20
    })
    make("mantle.order.OrderItem", {
        orderId,
        orderItemSeqId: "01",
        orderPartSeqId: "01",
        itemTypeEnumId: "ItemProduct",
        productId: ids.product,
        quantity: 2,
        unitAmount: 10
    })
    if (options.promotion)
        make("mantle.order.OrderItem", {
            orderId,
            orderItemSeqId: "02",
            orderPartSeqId: "01",
            itemTypeEnumId: "ItemPromoDiscount",
            storePromotionId: ids.promotion,
            promoCodeId: ids.code,
            promoCodeText: ids.code,
            promoTimesUsed: 1,
            quantity: 1,
            unitAmount: -2
        })
    make("mantle.order.StoreCartAccess", {
        cartAccessId: orderId + "_CA",
        orderId,
        productStoreId,
        currencyUomId,
        customerPartyId: options.guest ? null : ids.customer,
        lastActivityDate: ago(options.idle ?? 3 * hour),
        recoveryUsedDate: options.usedAgo != null ? ago(options.usedAgo) : null,
        createdDate: ago(4 * hour)
    })
    for (const [index, send] of (options.sends || []).entries())
        make("mantle.party.MessageDelivery", {
            deliveryId: orderId + "_D" + index,
            eventKey: "cartRecovery:" + orderId + ":" + index,
            sourceEnumId: "MdsrcCartRecovery",
            productStoreId,
            stateEnumId: send.state,
            createdDate: ago(send.ago),
            sentDate: send.state === "MdsSent" ? ago(send.ago) : null
        })
    return orderId
}

spec({
    setupSpec() {
        system(() => {
            party(orgA, true, "Store reports A", "OrgInternal")
            party(orgB, true, "Store reports B", "OrgInternal")
            party(ids.customer, false, "Buyer", "Customer")
            for (const [productStoreId, organizationPartyId] of [
                [ids.storeA, orgA],
                [ids.storeA2, orgA],
                [ids.storeB, orgB]
            ])
                make("mantle.product.store.ProductStore", {
                    productStoreId,
                    storeName: "Reports " + productStoreId,
                    organizationPartyId,
                    defaultCurrencyUomId: "USD"
                })
            make("mantle.product.Product", {
                productId: ids.product,
                productName: "Report item",
                productTypeEnumId: "PtService",
                ownerPartyId: orgA
            })
            make("mantle.product.store.ProductStorePromotion", {
                storePromotionId: ids.promotion,
                productStoreId: ids.storeA,
                serviceRegisterId: "FlatDiscount",
                itemDescription: "Report promotion",
                useLimitPerPromotion: 5,
                fromDate: 0
            })
            make("mantle.product.store.ProductStorePromoCode", {
                promoCodeId: ids.code,
                storePromotionId: ids.promotion,
                useLimitPerCode: 3
            })
            users.reader = user("reader", orgA, ["COMMERCE_VIEW"])
            users.staff = user("staff", orgA, ["COMMERCE_VIEW"])
            users.other = user("other", orgB, ["COMMERCE_VIEW"])
            make("mantle.product.store.ProductStoreParty", {
                productStoreId: ids.storeA,
                partyId: users.staff,
                roleTypeId: "StoreStaff",
                fromDate: 0
            })
            // store A1: a reminded idle cart (with a promotion line, never counted), an idle guest cart, an active cart, a cart
            // recovered (the link used after its send, then placed, with the promotion), a placed EUR cart, an active cart whose
            // only send was suppressed; store B1's cart is another organization's
            cart("C1", ids.storeA, {sends: [{state: "MdsSent", ago: 2 * hour}], promotion: true})
            cart("C2", ids.storeA, {guest: true})
            cart("C3", ids.storeA, {idle: 5 * 60000})
            cart("C4", ids.storeA, {
                statusId: "OrderApproved",
                sends: [{state: "MdsSent", ago: 2 * hour}],
                usedAgo: 1.5 * hour,
                promotion: true
            })
            cart("C5", ids.storeA, {statusId: "OrderApproved", currencyUomId: "EUR"})
            cart("C6", ids.storeA, {idle: 5 * 60000, sends: [{state: "MdsSuppressed", ago: hour}]})
            cart("CB", ids.storeB, {statusId: "OrderApproved", promotion: false})
        })
    }
})

const period = () => ({fromDate: ago(24 * hour), thruDate: ago(-hour)})
const rowOf = (out, currencyUomId) => (out.rows || []).find(row => row.currencyUomId === currencyUomId) || {}

feature("the cart recovery funnel counts the store's carts once each, by currency, an open cart never placed", {
    when() {
        return {
            all: run(users.reader, O + "get#CartRecoverySummary", period()),
            staff: run(users.staff, O + "get#CartRecoverySummary", Object.assign({productStoreId: ids.storeA}, period()))
        }
    },
    then({all, staff}) {
        all.error == ""
        all.truncated == false
        all.rows.length == 2
        all.rows.every(row => row.productStoreId === ids.storeA)
        const usd = rowOf(all, "USD")
        usd.opened == 5
        usd.placed == 1
        // the reminded idle cart, the idle guest cart and the recovered one
        usd.abandoned == 3
        usd.signedIn == 2
        // the suppressed send is no send
        usd.sends == 2
        usd.delivered == 2
        usd.recovered == 1
        // the order's total, its promotion line taken off
        num(usd.recoveredValue) == 18
        const eur = rowOf(all, "EUR")
        eur.opened == 1
        eur.placed == 1
        eur.recovered == 0
        all.totals.length == 2
        all.totals.find(total => total.currencyUomId === "USD").opened == 5
        staff.error == ""
        rowOf(staff, "USD").opened == 5
    }
})

feature("promotion use counts the placed uses by promotion, code and currency, with the uses left", {
    when() {
        return {
            uses: run(users.reader, P + "get#PromotionUseSummary", period()),
            one: run(users.reader, P + "get#PromotionUseSummary", Object.assign({storePromotionId: ids.promotion}, period()))
        }
    },
    then({uses, one}) {
        uses.error == ""
        // the placed recovered order only: the open cart's promotion line is no use
        uses.rows.length == 1
        const row = uses.rows[0]
        row.storePromotionId == ids.promotion
        row.promoCodeId == ids.code
        row.currencyUomId == "USD"
        row.orderCount == 1
        row.useCount == 1
        num(row.discount) == 2
        // the product lines less the discount
        num(row.netSales) == 18
        row.promotionUsesLeft == 4
        row.codeUsesLeft == 2
        uses.totals.length == 1
        uses.totals[0].orderCount == 1
        num(uses.totals[0].netSales) == 18
        one.rows.length == 1
    }
})

feature("the reports keep to the store scope and a valid period", {
    when() {
        return {
            otherStore: code(
                run(users.reader, O + "get#CartRecoverySummary", Object.assign({productStoreId: ids.storeB}, period()))
            ),
            secondStore: code(
                run(users.staff, P + "get#PromotionUseSummary", Object.assign({productStoreIds: [ids.storeA2]}, period()))
            ),
            otherOrganization: code(
                run(users.other, P + "get#PromotionUseSummary", Object.assign({storePromotionId: ids.promotion}, period()))
            ),
            otherCarts: run(users.other, O + "get#CartRecoverySummary", period()),
            backwards: code(run(users.reader, O + "get#CartRecoverySummary", {fromDate: ago(0), thruDate: ago(hour)}))
        }
    },
    then({otherStore, secondStore, otherOrganization, otherCarts, backwards}) {
        otherStore == "RECORD_UNAVAILABLE"
        secondStore == "RECORD_UNAVAILABLE"
        otherOrganization == "RECORD_UNAVAILABLE"
        // the other organization's reader sees its own store's carts only
        otherCarts.error == ""
        otherCarts.rows.every(row => row.productStoreId === ids.storeB)
        backwards == "PERIOD_INVALID"
    }
})
