// Store operations (impl-commerce P8, COM-OPS; mantle.order.StoreOperationsServices, StoreOperations.js): the order
// worklist leaves out carts and carries its Payment hold and cancellation badges, a stuck Shop placement is listed (impl-shop
// F85); carts with their abandoned and stuck states; returns and cases by the store of their orders; a customer list that is
// no party directory; the permission, the other organization and a store-limited staff member refused another store of
// the same organization (F51), an order of the store vended by another organization (F113); Order again a new open order at
// today's price with no payment copied (F43), once per operation key, a stale revision refused.
// Standalone: spec-local organizations, stores, users, customers and records made directly. Run:
// ./moq test mr-mantle --spec StoreOperations
const O = "mantle.order.StoreOperationsServices."
const prefix = "STOP8"
const orgA = prefix + "_ORG_A",
    orgB = prefix + "_ORG_B"
const ids = {
    storeA: prefix + "_A1",
    storeA2: prefix + "_A2",
    storeB: prefix + "_B1",
    product: prefix + "_PROD",
    customer: prefix + "_CUST",
    customer2: prefix + "_CUST2",
    stranger: prefix + "_STRANGER",
    placed: prefix + "_O1",
    placed2: prefix + "_O2",
    otherOrder: prefix + "_OB",
    // an order of store A vended by organization B (F113: not A's)
    foreign: prefix + "_OF",
    cart: prefix + "_C1",
    stuck: prefix + "_C2",
    return1: prefix + "_R1",
    return2: prefix + "_R2",
    case1: prefix + "_K1",
    case2: prefix + "_K2",
    loose: prefix + "_K3",
    change: prefix + "_X1"
}

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
function party(partyId, organization, name, roleTypeId, ownerPartyId) {
    make("mantle.party.Party", {partyId, partyTypeEnumId: organization ? "PtyOrganization" : "PtyPerson", ownerPartyId})
    if (organization) make("mantle.party.Organization", {partyId, organizationName: name})
    else make("mantle.party.Person", {partyId, firstName: "Store", lastName: name})
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
    make("moqui.security.UserGroup", {userGroupId: id, description: "Store operations " + kind})
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
// a call as a user, in its own transaction: its result and its refusal ("" when it succeeds)
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
const idsOf = (rows, field) => Array.from(rows || []).map(row => row[field])
// an order of a store, with one line of the spec product at the price given, made directly
function order(orderId, productStoreId, vendorPartyId, customerPartyId, statusId, unitAmount = 20) {
    make("mantle.order.OrderHeader", {
        orderId,
        productStoreId,
        statusId,
        currencyUomId: "USD",
        entryDate: ec.user.nowTimestamp,
        placedDate: statusId === "OrderOpen" ? null : ec.user.nowTimestamp,
        grandTotal: unitAmount
    })
    make("mantle.order.OrderPart", {
        orderId,
        orderPartSeqId: "01",
        vendorPartyId,
        customerPartyId,
        statusId,
        partTotal: unitAmount
    })
    make("mantle.order.OrderItem", {
        orderId,
        orderItemSeqId: "01",
        orderPartSeqId: "01",
        itemTypeEnumId: "ItemProduct",
        productId: ids.product,
        quantity: 1,
        unitAmount
    })
}
function storeCase(requestId, extra = {}) {
    make(
        "mantle.request.Request",
        Object.assign(
            {requestId, requestName: "Case " + requestId, statusId: "ReqSubmitted", requestDate: ec.user.nowTimestamp},
            extra
        )
    )
    make("mantle.request.support.CaseProfile", {requestId, intakeDate: ec.user.nowTimestamp})
    make("mantle.request.RequestParty", {requestId, partyId: ids.customer, roleTypeId: "Customer", fromDate: 0})
}

spec({
    setupSpec() {
        system(() => {
            party(orgA, true, "Store operations A", "OrgInternal")
            party(orgB, true, "Store operations B", "OrgInternal")
            for (const [productStoreId, organizationPartyId] of [
                [ids.storeA, orgA],
                [ids.storeA2, orgA],
                [ids.storeB, orgB]
            ])
                make("mantle.product.store.ProductStore", {
                    productStoreId,
                    storeName: "Operations " + productStoreId,
                    organizationPartyId,
                    defaultCurrencyUomId: "USD"
                })
            make("mantle.product.Product", {
                productId: ids.product,
                productName: "Operations item",
                productTypeEnumId: "PtService",
                ownerPartyId: orgA
            })
            make("mantle.product.ProductPrice", {
                productId: ids.product,
                pricePurposeEnumId: "PppPurchase",
                priceTypeEnumId: "PptCurrent",
                fromDate: 0,
                minQuantity: 1,
                price: "10.00",
                priceUomId: "USD"
            })
            party(ids.customer, false, "Buyer", "Customer", orgA)
            party(ids.customer2, false, "Second buyer", "Customer", orgA)
            party(ids.stranger, false, "Stranger", "Customer", orgA)
            users.reader = user("reader", orgA, ["COMMERCE_VIEW"])
            users.operator = user("operator", orgA, ["COMMERCE_VIEW", "COMMERCE_ORDER_VIEW"])
            users.staff = user("staff", orgA, ["COMMERCE_VIEW", "COMMERCE_ORDER_VIEW"])
            users.other = user("other", orgB, ["COMMERCE_VIEW", "COMMERCE_ORDER_VIEW"])
            // the staff member works only the first store of organization A (F51)
            make("mantle.product.store.ProductStoreParty", {
                productStoreId: ids.storeA,
                partyId: users.staff,
                roleTypeId: "StoreStaff",
                fromDate: 0
            })

            order(ids.placed, ids.storeA, orgA, ids.customer, "OrderApproved")
            order(ids.placed2, ids.storeA2, orgA, ids.customer2, "OrderPlaced")
            order(ids.otherOrder, ids.storeB, orgB, ids.customer, "OrderApproved")
            order(ids.foreign, ids.storeA, orgB, ids.customer, "OrderApproved")
            order(ids.cart, ids.storeA, orgA, ids.customer, "OrderOpen")
            order(ids.stuck, ids.storeA, orgA, ids.customer, "OrderOpen")
            // the placed order's authorized payment (never copied by Order again), its Payment hold and a cancel request
            make("mantle.account.payment.Payment", {
                orderId: ids.placed,
                statusId: "PmntAuthorized",
                amount: 20,
                amountUomId: "USD",
                paymentInstrumentEnumId: "PiCreditCard"
            })
            make("mantle.order.OrderHoldReason", {
                orderId: ids.placed,
                holdTypeEnumId: "OhtPayment",
                holdComment: "Capture failed",
                placedDate: ec.user.nowTimestamp
            })
            make("mantle.request.Request", {
                requestId: ids.change,
                requestTypeEnumId: "RqtOrderChange",
                orderChangeKindEnumId: "OckCancel",
                orderId: ids.placed,
                statusId: "ReqSubmitted"
            })
            // a guest-free cart idle for three hours (abandoned) and a paid placement refused ORDER_CHANGED (stuck)
            make("mantle.order.StoreCartAccess", {
                cartAccessId: prefix + "_CA1",
                orderId: ids.cart,
                productStoreId: ids.storeA,
                customerPartyId: ids.customer,
                lastActivityDate: new Date(Number(ec.user.nowTimestamp) - 3 * 3600000),
                createdDate: ec.user.nowTimestamp
            })
            make("mantle.order.StoreCheckout", {
                checkoutId: prefix + "_CO2",
                orderId: ids.stuck,
                productStoreId: ids.storeA,
                statusId: "ScoPlacementPending",
                failureCode: "ORDER_CHANGED",
                placementTries: 1,
                frozenDate: ec.user.nowTimestamp,
                createdDate: ec.user.nowTimestamp
            })
            // returns of the two stores' orders, and cases: one carrying its store, one linked to the second store's order,
            // one of no store
            for (const [returnId, orderId] of [
                [ids.return1, ids.placed],
                [ids.return2, ids.placed2]
            ]) {
                make("mantle.order.return.ReturnHeader", {
                    returnId,
                    statusId: "ReturnRequested",
                    customerPartyId: ids.customer,
                    vendorPartyId: orgA,
                    entryDate: ec.user.nowTimestamp
                })
                make("mantle.order.return.ReturnItem", {
                    returnId,
                    returnItemSeqId: "01",
                    orderId,
                    orderItemSeqId: "01",
                    productId: ids.product,
                    returnQuantity: 1,
                    statusId: "ReturnRequested"
                })
            }
            storeCase(ids.case1, {productStoreId: ids.storeA})
            storeCase(ids.case2)
            make("mantle.request.RequestRecord", {
                requestId: ids.case2,
                recordEntityName: "mantle.order.OrderHeader",
                recordId: ids.placed2
            })
            storeCase(ids.loose)
        })
    }
})

feature(
    "orders leave out carts, carry the Payment hold and the cancel request, list a stuck placement, and keep to the store scope",
    {
        when() {
            const all = run(users.operator, O + "find#StoreOrders", {pageSize: 100})
            return {
                all,
                held: run(users.operator, O + "find#StoreOrders", {attention: "paymentHold"}),
                stuck: run(users.operator, O + "find#StoreOrders", {attention: "stuck"}),
                detail: run(users.operator, O + "get#StoreOrder", {orderId: ids.placed}),
                cartAsOrder: run(users.operator, O + "get#StoreOrder", {orderId: ids.cart}),
                reader: run(users.reader, O + "find#StoreOrders", {}),
                other: run(users.other, O + "find#StoreOrders", {pageSize: 100}),
                otherDetail: run(users.other, O + "get#StoreOrder", {orderId: ids.placed}),
                foreignDetail: run(users.operator, O + "get#StoreOrder", {orderId: ids.foreign}),
                staff: run(users.staff, O + "find#StoreOrders", {pageSize: 100}),
                staffDetail: run(users.staff, O + "get#StoreOrder", {orderId: ids.placed2}),
                staffStore: run(users.staff, O + "find#StoreOrders", {productStoreId: ids.storeA2}),
                summary: run(users.reader, O + "get#StoreWorkSummary", {productStoreId: ids.storeA})
            }
        },
        then(r) {
            code(r.all) == ""
            idsOf(r.all.orders, "orderId").sort() == [ids.placed, ids.placed2].sort()
            const row = r.all.orders.find(order => order.orderId == ids.placed)
            row.paymentHold == true
            row.paymentText == "Payment hold"
            row.cancelRequested == true
            idsOf(r.held.orders, "orderId") == [ids.placed]
            idsOf(r.stuck.orders, "orderId") == [ids.stuck]
            r.stuck.orders[0].stuck == true
            r.detail.holds[0].payment == true
            r.detail.changes[0].cancel == true
            idsOf(r.detail.returns, "returnId") == [ids.return1]
            code(r.cartAsOrder) == "RECORD_UNAVAILABLE"
            code(r.reader) == "PERMISSION_DENIED"
            idsOf(r.other.orders, "orderId") == [ids.otherOrder]
            code(r.otherDetail) == "RECORD_UNAVAILABLE"
            code(r.foreignDetail) == "RECORD_UNAVAILABLE"
            idsOf(r.staff.orders, "orderId") == [ids.placed]
            code(r.staffDetail) == "RECORD_UNAVAILABLE"
            code(r.staffStore) == "RECORD_UNAVAILABLE"
            r.summary.counts.paymentHolds == 1
            r.summary.counts.openCarts == 2
            r.summary.counts.stuckPlacements == 1
            r.summary.recentOrders == []
        }
    }
)

feature("carts, returns, cases and customers are the stores' own: abandoned and stuck carts, no party directory", {
    when() {
        return {
            carts: run(users.operator, O + "find#StoreCarts", {productStoreId: ids.storeA}),
            abandoned: run(users.operator, O + "find#StoreCarts", {state: "abandoned"}),
            cart: run(users.operator, O + "get#StoreCart", {orderId: ids.stuck}),
            returns: run(users.operator, O + "find#StoreReturns", {}),
            staffReturns: run(users.staff, O + "find#StoreReturns", {}),
            otherReturns: run(users.other, O + "find#StoreReturns", {}),
            otherReturn: run(users.other, O + "get#StoreReturn", {returnId: ids.return1}),
            requests: run(users.operator, O + "find#StoreRequests", {}),
            staffRequests: run(users.staff, O + "find#StoreRequests", {}),
            staffCase: run(users.staff, O + "get#StoreRequest", {requestId: ids.case2}),
            looseCase: run(users.operator, O + "get#StoreRequest", {requestId: ids.loose}),
            note: run(users.operator, O + "add#StoreRequestNote", {requestId: ids.case1, body: "Customer asked about delivery"}),
            customers: run(users.operator, O + "find#StoreCustomers", {}),
            staffCustomers: run(users.staff, O + "find#StoreCustomers", {}),
            customer: run(users.operator, O + "get#StoreCustomer", {customerPartyId: ids.customer}),
            stranger: run(users.operator, O + "get#StoreCustomer", {customerPartyId: ids.stranger})
        }
    },
    then(r) {
        idsOf(r.carts.carts, "orderId").sort() == [ids.cart, ids.stuck].sort()
        idsOf(r.abandoned.carts, "orderId") == [ids.cart]
        r.cart.checkout.stuck == true
        r.cart.cart.stateText == "Placement waiting"
        idsOf(r.returns.returns, "returnId").sort() == [ids.return1, ids.return2].sort()
        idsOf(r.staffReturns.returns, "returnId") == [ids.return1]
        r.otherReturns.returns == []
        code(r.otherReturn) == "RECORD_UNAVAILABLE"
        idsOf(r.requests.requests, "requestId").sort() == [ids.case1, ids.case2].sort()
        idsOf(r.staffRequests.requests, "requestId") == [ids.case1]
        code(r.staffCase) == "RECORD_UNAVAILABLE"
        code(r.looseCase) == "RECORD_UNAVAILABLE"
        code(r.note) == ""
        list("mantle.request.RequestCommEvent", {requestId: ids.case1}).length == 1
        idsOf(r.customers.customers, "partyId").sort() == [ids.customer, ids.customer2].sort()
        idsOf(r.staffCustomers.customers, "partyId") == [ids.customer]
        r.customer.customer.accountText == "Guest"
        idsOf(r.customer.orders, "orderId") == [ids.placed]
        code(r.stranger) == "RECORD_UNAVAILABLE"
    }
})

feature("Order again makes a new open order of the same store at today's price, with no payment copied, once per key", {
    when() {
        const key = prefix + "_REORDER_" + Date.now()
        const revision = Number(list("mantle.order.OrderHeader", {orderId: ids.placed})[0].orderRevision ?? 1)
        const out = run(users.operator, O + "reorder#StoreOrder", {
            orderId: ids.placed,
            operationKey: key,
            orderRevision: revision
        })
        return {
            out,
            retry: run(users.operator, O + "reorder#StoreOrder", {
                orderId: ids.placed,
                operationKey: key,
                orderRevision: revision
            }),
            stale: run(users.operator, O + "reorder#StoreOrder", {
                orderId: ids.placed,
                operationKey: key + "_S",
                orderRevision: revision + 5
            }),
            header: out.orderId ? list("mantle.order.OrderHeader", {orderId: out.orderId})[0] : null,
            items: out.orderId ? list("mantle.order.OrderItem", {orderId: out.orderId}) : [],
            payments: out.orderId ? list("mantle.account.payment.Payment", {orderId: out.orderId}) : [],
            other: run(users.other, O + "reorder#StoreOrder", {orderId: ids.placed, operationKey: key + "_O"}),
            cart: run(users.operator, O + "reorder#StoreOrder", {orderId: ids.cart, operationKey: key + "_C"})
        }
    },
    then(r) {
        code(r.out) == ""
        r.header.statusId == "OrderOpen"
        r.header.productStoreId == ids.storeA
        r.items.filter(item => item.productId == ids.product).map(item => Number(String(item.unitAmount))) == [10]
        r.payments == []
        r.retry.orderId == r.out.orderId
        r.retry.alreadyApplied == true
        code(r.stale) == "STALE_REVISION"
        code(r.other) == "RECORD_UNAVAILABLE"
        code(r.cart) == "RECORD_UNAVAILABLE"
    }
})
