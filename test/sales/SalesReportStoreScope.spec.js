// The store-scoped sales reads (impl-commerce P11, F21, the owner contract X11; mantle.sales.SalesReportServices'
// get#SalesOrderSummary, get#SalesInvoiceSummary and get#SalesTopProduct, SalesAnalysis.js organizations): a holder of
// COMMERCE_VIEW without ACCOUNTING_VIEW is answered for productStoreIds all in their store scope, costs withheld without
// PRODUCT_COST_VIEW, by currency when asked; a store outside the scope (another organization's, or another store of the
// organization for a store-limited staff member) and no store at all are refused; an ACCOUNTING_VIEW holder's answers are
// unchanged (a store of no Commerce scope answered, costs kept, the same orders as the store reader's).
// Standalone: spec-local organizations, stores, users and orders, indexed by the MantleSales feed. Run:
// ./moq test mr-mantle --spec SalesReportStoreScope
const R = "mantle.sales.SalesReportServices."
const prefix = "SRSS"
const orgA = prefix + "_ORG_A",
    orgB = prefix + "_ORG_B"
const ids = {
    storeA: prefix + "_A1",
    storeA2: prefix + "_A2",
    storeB: prefix + "_B1",
    customer: prefix + "_CUST",
    product: prefix + "_PROD"
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
function party(partyId, organization, name, roleTypeId) {
    make("mantle.party.Party", {partyId, partyTypeEnumId: organization ? "PtyOrganization" : "PtyPerson"})
    if (organization) make("mantle.party.Organization", {partyId, organizationName: name})
    else make("mantle.party.Person", {partyId, firstName: "Sales", lastName: name})
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
    make("moqui.security.UserGroup", {userGroupId: id, description: "Sales report scope " + kind})
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
const num = value => (value == null ? 0 : Number(String(value)))
// the period lines of a summary (its buckets, without the average and total lines at the end)
const periods = list => (list || []).slice(0, Math.max(0, (list || []).length - 2))
const total = (list, field) => Math.round(periods(list).reduce((sum, line) => sum + num(line[field]), 0) * 100) / 100
const costs = list => periods(list).map(line => line.productCostTotal)
// this month and the one before, so the orders placed now are in the summaries
const window = {interval: "M", intervalCount: 1}
function order(orderId, productStoreId, vendorPartyId, currencyUomId, unitAmount) {
    make("mantle.order.OrderHeader", {
        orderId,
        productStoreId,
        statusId: "OrderApproved",
        currencyUomId,
        entryDate: ec.user.nowTimestamp,
        placedDate: ec.user.nowTimestamp,
        grandTotal: unitAmount * 2
    })
    make("mantle.order.OrderPart", {
        orderId,
        orderPartSeqId: "01",
        vendorPartyId,
        customerPartyId: ids.customer,
        statusId: "OrderApproved",
        partTotal: unitAmount * 2
    })
    make("mantle.order.OrderItem", {
        orderId,
        orderItemSeqId: "01",
        orderPartSeqId: "01",
        itemTypeEnumId: "ItemProduct",
        productId: ids.product,
        quantity: 2,
        unitAmount
    })
}
const searchCount = queryString =>
    num(
        call("org.moqui.search.SearchServices.search#DataDocuments", {
            indexName: "mantle_sales",
            documentType: "MantleSalesOrderItem",
            queryString,
            pageSize: 10
        }).documentListCount
    )
let searchAvailable = false

spec({
    setupSpec() {
        system(() => {
            party(orgA, true, "Sales scope A", "OrgInternal")
            party(orgB, true, "Sales scope B", "OrgInternal")
            party(ids.customer, false, "Buyer", "Customer")
            make("mantle.product.Product", {
                productId: ids.product,
                productName: "Sales scope item",
                productTypeEnumId: "PtService",
                ownerPartyId: orgA
            })
            for (const [productStoreId, organizationPartyId] of [
                [ids.storeA, orgA],
                [ids.storeA2, orgA],
                [ids.storeB, orgB]
            ])
                make("mantle.product.store.ProductStore", {
                    productStoreId,
                    storeName: "Sales " + productStoreId,
                    organizationPartyId,
                    defaultCurrencyUomId: "USD"
                })
            users.reader = user("reader", orgA, ["COMMERCE_VIEW"])
            users.costReader = user("cost", orgA, ["COMMERCE_VIEW", "PRODUCT_COST_VIEW"])
            users.staff = user("staff", orgA, ["COMMERCE_VIEW"])
            users.other = user("other", orgB, ["COMMERCE_VIEW"])
            users.accountant = user("accountant", orgA, ["ACCOUNTING_VIEW"])
            // the staff member works only the first store of organization A (F51)
            make("mantle.product.store.ProductStoreParty", {
                productStoreId: ids.storeA,
                partyId: users.staff,
                roleTypeId: "StoreStaff",
                fromDate: 0
            })
            // store A1's orders in two currencies, A2's and B1's
            order(prefix + "_O1", ids.storeA, orgA, "USD", 10)
            order(prefix + "_O2", ids.storeA, orgA, "EUR", 7)
            order(prefix + "_O3", ids.storeA2, orgA, "USD", 5)
            order(prefix + "_O4", ids.storeB, orgB, "USD", 3)
            searchAvailable = ec.search.isAvailable()
        })
        if (searchAvailable)
            system(() => {
                const started = Date.now()
                while (Date.now() - started < 10000) {
                    call("org.moqui.EntityServices.process#DataFeedPending", {})
                    if (searchCount("orderId:" + prefix + "_O4") > 0) break
                }
            })
    }
})

feature("a COMMERCE_VIEW holder reads the summaries of the stores in their scope, by currency, costs withheld", {
    when() {
        const scoped = Object.assign({productStoreIds: [ids.storeA]}, window)
        return {
            orders: run(users.reader, R + "get#SalesOrderSummary", scoped),
            usd: run(users.reader, R + "get#SalesOrderSummary", Object.assign({currencyUomIds: ["USD"]}, scoped)),
            both: run(
                users.reader,
                R + "get#SalesOrderSummary",
                Object.assign({}, window, {productStoreIds: [ids.storeA, ids.storeA2], currencyUomIds: ["USD"]})
            ),
            invoices: run(users.reader, R + "get#SalesInvoiceSummary", scoped),
            top: run(users.reader, R + "get#SalesTopProduct", {
                interval: "M",
                poffset: 0,
                productStoreIds: [ids.storeA],
                currencyUomIds: ["USD"]
            }),
            costed: run(users.costReader, R + "get#SalesOrderSummary", scoped),
            staff: run(users.staff, R + "get#SalesOrderSummary", scoped)
        }
    },
    then({orders, usd, both, invoices, top, costed, staff}) {
        orders.error == ""
        usd.error == ""
        both.error == ""
        invoices.error == ""
        top.error == ""
        costed.error == ""
        staff.error == ""
        // the test runtime has a search backend (MantleSearch checks it too), so the counts below are checked
        searchAvailable
        if (searchAvailable) {
            total(orders.salesOrderSummaryList, "orderCount") == 2
            total(usd.salesOrderSummaryList, "orderCount") == 1
            total(usd.salesOrderSummaryList, "productSaleTotal") == 20
            total(both.salesOrderSummaryList, "orderCount") == 2
            total(both.salesOrderSummaryList, "productSaleTotal") == 30
            // withheld, never zero; a holder of PRODUCT_COST_VIEW keeps them
            costs(orders.salesOrderSummaryList).every(cost => cost == null)
            costs(costed.salesOrderSummaryList).every(cost => cost != null)
            top.topProductList.length == 1
            top.topProductList[0].productId == ids.product
            top.topProductList[0].productCostTotal == null
            total(staff.salesOrderSummaryList, "orderCount") == 2
        }
    }
})

feature("a store outside the reader's scope, and no store at all, are refused", {
    when() {
        return {
            otherOrganization: code(
                run(users.reader, R + "get#SalesOrderSummary", Object.assign({productStoreIds: [ids.storeB]}, window))
            ),
            mixed: code(
                run(
                    users.reader,
                    R + "get#SalesInvoiceSummary",
                    Object.assign({productStoreIds: [ids.storeA, ids.storeB]}, window)
                )
            ),
            secondStore: code(
                run(users.staff, R + "get#SalesOrderSummary", Object.assign({productStoreIds: [ids.storeA2]}, window))
            ),
            otherReader: code(run(users.other, R + "get#SalesTopProduct", {interval: "M", productStoreIds: [ids.storeA]})),
            noStore: code(run(users.reader, R + "get#SalesOrderSummary", window)),
            otherVendor: code(
                run(
                    users.reader,
                    R + "get#SalesOrderSummary",
                    Object.assign({productStoreIds: [ids.storeA], vendorPartyIds: [orgB]}, window)
                )
            )
        }
    },
    then(refused) {
        refused.otherOrganization == "RECORD_UNAVAILABLE"
        refused.mixed == "RECORD_UNAVAILABLE"
        refused.secondStore == "RECORD_UNAVAILABLE"
        refused.otherReader == "RECORD_UNAVAILABLE"
        refused.noStore == "ACCESS_DENIED"
        refused.otherVendor == "ORGANIZATION_DENIED"
    }
})

feature("an ACCOUNTING_VIEW holder's answers are unchanged", {
    when() {
        return {
            // a store of no Commerce scope is no refusal for report read: its organization's orders only, as before
            otherStore: run(
                users.accountant,
                R + "get#SalesOrderSummary",
                Object.assign({productStoreIds: [ids.storeB]}, window)
            ),
            store: run(users.accountant, R + "get#SalesOrderSummary", Object.assign({productStoreIds: [ids.storeA]}, window)),
            organization: run(users.accountant, R + "get#SalesOrderSummary", window),
            reader: run(users.reader, R + "get#SalesOrderSummary", Object.assign({productStoreIds: [ids.storeA]}, window)),
            top: run(users.accountant, R + "get#SalesTopProduct", {interval: "M", poffset: 0, vendorPartyIds: [orgA]})
        }
    },
    then({otherStore, store, organization, reader, top}) {
        otherStore.error == ""
        store.error == ""
        organization.error == ""
        top.error == ""
        if (searchAvailable) {
            total(otherStore.salesOrderSummaryList, "orderCount") == 0
            total(organization.salesOrderSummaryList, "orderCount") == 3
            // the same orders and amounts as the store reader's, with the costs kept
            JSON.stringify(periods(store.salesOrderSummaryList).map(line => [line.dateKey, line.orderCount, line.netSales])) ==
                JSON.stringify(periods(reader.salesOrderSummaryList).map(line => [line.dateKey, line.orderCount, line.netSales]))
            costs(store.salesOrderSummaryList).every(cost => cost != null)
            top.topProductList.some(line => line.productCostTotal != null)
        }
    }
})
