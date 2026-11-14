// Sales summaries over the search index (mantle.sales.SalesReportServices) and the universal search service. They report
// "Search is not configured" without a search backend and are checked here for the shape they return either way. A Sales
// report reader (SALES_REPORT_VIEW without ACCOUNTING_VIEW, impl-sales P1, F2) is answered for their own organization, as an
// ACCOUNTING_VIEW holder naming it is, with the costs withheld, and refused another organization and a user with neither.
// New spec, no Groovy original.
const effectiveTime = Date.now()
let searchAvailable

spec({
    stepwise: true,
    tempSequences: { start: 58700, banks: {} },
    setupSpec() {
        login("john.doe")
        ec.user.setEffectiveTime(effectiveTime)
    },
    setup() { ec.artifactExecution.disableAuthz() },
    cleanup() { ec.artifactExecution.enableAuthz() },
})

function errorOf(name, params) {
    try { call(name, params) } catch (e) { ec.message.clearErrors(); return String(e.message) }
    return null
}

feature("whether a search backend is available", {
    when() {
        searchAvailable = ec.search.isAvailable()
        return { searchAvailable }
    },
    then({ searchAvailable }) { searchAvailable === true || searchAvailable === false },
})

feature("sales order and invoice summaries return their lists, filtered by every list parameter", {
    when() {
        const common = { interval: "M", intervalCount: 3, maPeriods: 1 }
        const filters = { vendorPartyIds: ["ORG_ZIZI_RETAIL"], customerPartyIds: ["JoeDist"], productStoreIds: ["POPC_DEFAULT"], customerClassificationIds: ["CustDistributor"], productIds: ["DEMO_1_1"] }
        const plain = call("mantle.sales.SalesReportServices.get#SalesOrderSummary", common)
        const filtered = call("mantle.sales.SalesReportServices.get#SalesOrderSummary", Object.assign({}, common, filters))
        const weekly = call("mantle.sales.SalesReportServices.get#SalesOrderSummary", { interval: "w", intervalCount: 2 })
        const invoices = call("mantle.sales.SalesReportServices.get#SalesInvoiceSummary", Object.assign({}, common, { fromPartyIds: ["ORG_ZIZI_RETAIL"], toPartyIds: ["JoeDist"],
                productStoreIds: ["POPC_DEFAULT"], customerClassificationIds: ["CustDistributor"], productIds: ["DEMO_1_1"] }))
        return { plain, filtered, weekly, invoices }
    },
    then({ plain, filtered, weekly, invoices }) {
        if (searchAvailable) {
            // newest-first buckets are reversed, then the average and total lines follow
            plain.salesOrderSummaryList.length >= 2
            plain.salesOrderSummaryList[plain.salesOrderSummaryList.length - 1].dateKey == "Prior Total"
            plain.salesOrderSummaryList[plain.salesOrderSummaryList.length - 2].dateKey == "Prior Average"
            filtered.salesOrderSummaryList != null
            weekly.salesOrderSummaryList != null
            invoices.salesInvoiceSummaryList != null
        } else {
            plain.salesOrderSummaryList == null
            invoices.salesInvoiceSummaryList == null
        }
    },
})

feature("top products and invoices by customer class", {
    when() {
        const products = call("mantle.sales.SalesReportServices.get#SalesTopProduct", { interval: "M", topLimit: 5 })
        const classes = call("mantle.sales.SalesReportServices.get#InvoicesByCustomerClass", { interval: "y" })
        return { products, classes }
    },
    then({ products, classes }) {
        if (searchAvailable) {
            products.topProductList != null
            classes.topCustomerClassList != null
        } else {
            products.topProductList == null
            classes.topCustomerClassList == null
        }
    },
})

feature("universal search", {
    when() {
        const error = errorOf("mantle.search.UniversalSearchServices.search#Universal", { q: "Ziziwork" })
        let out = null
        if (searchAvailable) out = call("mantle.search.UniversalSearchServices.search#Universal", { q: "Ziziwork" })
        return { error, out }
    },
    then({ error, out }) {
        if (searchAvailable) {
            out.results != null
            out.capabilities != null
        } else {
            error.includes("Search is not configured")
        }
    },
})

// a spec-local user, agent of the organization, holding the permissions (a SALES_REPORT_VIEW reader, or nothing of reports)
function reportUser(userId, permissions) {
    call("create#mantle.party.Party", { partyId: userId, partyTypeEnumId: "PtyPerson" })
    call("create#mantle.party.Person", { partyId: userId, firstName: "Sales", lastName: userId })
    call("create#mantle.party.PartyRelationship", { fromPartyId: userId, toPartyId: "ORG_ZIZI_RETAIL", relationshipTypeEnumId: "PrtAgent",
            toRoleTypeId: "OrgInternal", fromDate: 0 })
    call("create#moqui.security.UserGroup", { userGroupId: userId, description: "Sales reports " + userId })
    for (const userPermissionId of permissions)
        call("create#moqui.security.UserGroupPermission", { userGroupId: userId, userPermissionId, fromDate: 0 })
    call("create#moqui.security.UserAccount", { userId, username: userId, partyId: userId,
            currentPassword: "16ac58bbfa332c1c55bd98b53e60720bfa90d394", passwordHashType: "SHA" })
    call("create#moqui.security.UserGroupMember", { userId, userGroupId: userId, fromDate: 0 })
    return userId
}
// a summary as the user, in its own transaction: its result and its refusal's reason code ("" when it succeeds)
function asReader(username, name, params) {
    login(username)
    ec.message.pushErrors()
    try {
        const out = ec.service.sync().name(name).parameters(params).requireNewTransaction(true).call() || {}
        return Object.assign({}, out, { refusal: ec.message.hasError() ? ec.message.getErrorsString() : "" })
    } catch (e) {
        return { refusal: String(e.message) }
    } finally {
        ec.message.clearErrors()
        ec.message.popErrors()
        login("john.doe")
    }
}
const codeOf = text => (/([A-Z][A-Z0-9_]+):/.exec(text || "") || [])[1] || (text ? "ERROR" : "")
const periodLines = list => (list || []).slice(0, Math.max(0, (list || []).length - 2))

feature("a SALES_REPORT_VIEW reader reads their organization's summaries, costs withheld, and is refused another's", {
    when() {
        const reader = reportUser("SRP_SALES_READER", ["SALES_REPORT_VIEW"])
        const none = reportUser("SRP_NO_READ", ["SALES_VIEW"])
        const common = { interval: "M", intervalCount: 3 }
        return {
            orders: asReader(reader, "mantle.sales.SalesReportServices.get#SalesOrderSummary", common),
            accountant: call("mantle.sales.SalesReportServices.get#SalesOrderSummary", Object.assign({ vendorPartyIds: ["ORG_ZIZI_RETAIL"] }, common)),
            invoices: asReader(reader, "mantle.sales.SalesReportServices.get#SalesInvoiceSummary", common),
            top: asReader(reader, "mantle.sales.SalesReportServices.get#SalesTopProduct", { interval: "y", topLimit: 5 }),
            classes: asReader(reader, "mantle.sales.SalesReportServices.get#InvoicesByCustomerClass", { interval: "y" }),
            other: codeOf(asReader(reader, "mantle.sales.SalesReportServices.get#SalesOrderSummary",
                    Object.assign({ vendorPartyIds: ["ORG_ZIZI_SALES"] }, common)).refusal),
            otherClasses: codeOf(asReader(reader, "mantle.sales.SalesReportServices.get#InvoicesByCustomerClass",
                    { interval: "y", fromPartyIds: ["ORG_ZIZI_SALES"] }).refusal),
            noRead: codeOf(asReader(none, "mantle.sales.SalesReportServices.get#SalesOrderSummary", common).refusal)
        }
    },
    then({ orders, accountant, invoices, top, classes, other, otherClasses, noRead }) {
        orders.refusal == ""
        invoices.refusal == ""
        top.refusal == ""
        classes.refusal == ""
        other == "ORGANIZATION_DENIED"
        otherClasses == "ORGANIZATION_DENIED"
        noRead == "ACCESS_DENIED"
        if (searchAvailable) {
            // the organization's orders, as an ACCOUNTING_VIEW holder naming it reads them, without the costs
            JSON.stringify(periodLines(orders.salesOrderSummaryList).map(line => [line.dateKey, line.orderCount, line.netSales])) ==
                JSON.stringify(periodLines(accountant.salesOrderSummaryList).map(line => [line.dateKey, line.orderCount, line.netSales]))
            orders.salesOrderSummaryList.every(line => line.productCostTotal == null)
            invoices.salesInvoiceSummaryList.every(line => line.productCostTotal == null)
            top.topProductList.every(line => line.productCostTotal == null)
            classes.topCustomerClassList.every(line => line.productCostTotal == null)
        }
    },
})
