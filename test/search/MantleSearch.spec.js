// Mantle's search callers on the search facade, over Mantle's data and a small sales fixture: the feed indexes the Mantle
// document types, including the wiki pages; the sales report services and projected inventory aggregate the fixture's
// orders and invoices; party search, the universal search and the general search run; and a user limited to their
// organizations sees nothing owned by another, in results, totals or facets. Ported from mr-moqui's
// crates/moqui-host/tests/mantle_search.rs. New spec, no Groovy original.
const dayMillis = 86400000
// the fixture's dates are days before now at noon, so the weekly periods hold them whatever today is
const noon = (() => { const date = new Date(); date.setHours(12, 0, 0, 0); return date.getTime() })()
const day = (days) => noon - days * dayMillis
const pad = (n) => String(n).padStart(2, "0")
const ymd = (millis) => { const date = new Date(millis); return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` }
const customers = ["SF_CUST_A", "SF_CUST_B"]

spec({
    stepwise: true,
    setupSpec() { login("john.doe") },
    setup() { ec.artifactExecution.disableAuthz() },
    cleanup() { ec.artifactExecution.enableAuthz() },
})

// two customers (one wholesale), three orders from the retail org (one cancelled), two invoices, and a payment applied
// before the first invoice's date; and a user employed by the retail org whose group may run the general search with the
// user organization filter, which administrators may run without it
function fixture() {
    const [d8, d9, d15, d30] = [day(8), day(9), day(15), day(3650)]
    return `<entity-facade-xml>
    <mantle.party.Party partyId="SF_CUST_A" partyTypeEnumId="PtyPerson" ownerPartyId="ORG_ZIZI_RETAIL">
        <mantle.party.Person firstName="Sally" lastName="Sfixture"/>
        <mantle.party.PartyRole roleTypeId="Customer"/>
    </mantle.party.Party>
    <mantle.party.Party partyId="SF_CUST_B" partyTypeEnumId="PtyOrganization" ownerPartyId="ORG_ZIZI_RETAIL">
        <mantle.party.Organization organizationName="Sfixture Wholesale"/>
        <mantle.party.PartyRole roleTypeId="Customer"/>
        <mantle.party.PartyClassificationAppl partyClassificationId="CustWholesale" fromDate="${d30}"/>
    </mantle.party.Party>

    <mantle.order.OrderHeader orderId="SF_ORD_1" entryDate="${d8}" placedDate="${d8}" statusId="OrderCompleted" currencyUomId="USD" productStoreId="POPC_DEFAULT">
        <mantle.order.OrderPart orderPartSeqId="01" vendorPartyId="ORG_ZIZI_RETAIL" customerPartyId="SF_CUST_A" statusId="OrderCompleted" isNewCustomer="Y"/>
        <mantle.order.OrderItem orderItemSeqId="01" orderPartSeqId="01" itemTypeEnumId="ItemProduct" productId="DEMO_1_1" quantity="2" unitAmount="10.00"/>
        <mantle.order.OrderItem orderItemSeqId="02" orderPartSeqId="01" itemTypeEnumId="ItemDiscount" quantity="1" unitAmount="-2.00"/>
    </mantle.order.OrderHeader>
    <mantle.order.OrderHeader orderId="SF_ORD_2" entryDate="${d15}" placedDate="${d15}" statusId="OrderApproved" currencyUomId="USD" productStoreId="POPC_DEFAULT">
        <mantle.order.OrderPart orderPartSeqId="01" vendorPartyId="ORG_ZIZI_RETAIL" customerPartyId="SF_CUST_B" statusId="OrderApproved" isNewCustomer="N"/>
        <mantle.order.OrderItem orderItemSeqId="01" orderPartSeqId="01" itemTypeEnumId="ItemProduct" productId="DEMO_2_1" quantity="3" unitAmount="5.00"/>
    </mantle.order.OrderHeader>
    <mantle.order.OrderHeader orderId="SF_ORD_3" entryDate="${d8}" placedDate="${d8}" statusId="OrderCancelled" currencyUomId="USD" productStoreId="POPC_DEFAULT">
        <mantle.order.OrderPart orderPartSeqId="01" vendorPartyId="ORG_ZIZI_RETAIL" customerPartyId="SF_CUST_A" statusId="OrderCancelled"/>
        <mantle.order.OrderItem orderItemSeqId="01" orderPartSeqId="01" itemTypeEnumId="ItemProduct" productId="DEMO_1_1" quantity="100" unitAmount="10.00"/>
    </mantle.order.OrderHeader>

    <mantle.account.invoice.Invoice invoiceId="SF_INV_1" invoiceTypeEnumId="InvoiceSales" fromPartyId="ORG_ZIZI_RETAIL" toPartyId="SF_CUST_A"
            statusId="InvoicePmtRecvd" invoiceDate="${d8}" currencyUomId="USD" invoiceTotal="20.00" appliedPaymentsTotal="20.00" unpaidTotal="0">
        <mantle.account.invoice.InvoiceItem invoiceItemSeqId="01" itemTypeEnumId="ItemProduct" productId="DEMO_1_1" quantity="2" amount="10.00"/>
    </mantle.account.invoice.Invoice>
    <mantle.account.invoice.Invoice invoiceId="SF_INV_2" invoiceTypeEnumId="InvoiceSales" fromPartyId="ORG_ZIZI_RETAIL" toPartyId="SF_CUST_B"
            statusId="InvoiceFinalized" invoiceDate="${d15}" currencyUomId="USD" invoiceTotal="15.00" appliedPaymentsTotal="0" unpaidTotal="15.00">
        <mantle.account.invoice.InvoiceItem invoiceItemSeqId="01" itemTypeEnumId="ItemProduct" productId="DEMO_2_1" quantity="3" amount="5.00"/>
    </mantle.account.invoice.Invoice>
    <mantle.account.payment.Payment paymentId="SF_PAY_1" paymentTypeEnumId="PtInvoicePayment" fromPartyId="SF_CUST_A" toPartyId="ORG_ZIZI_RETAIL"
            statusId="PmntDelivered" effectiveDate="${d9}" amount="20.00" amountUomId="USD"/>
    <mantle.account.payment.PaymentApplication paymentApplicationId="SF_PA_1" paymentId="SF_PAY_1" invoiceId="SF_INV_1" amountApplied="20.00" appliedDate="${d8}"/>

    <mantle.party.Party partyId="SF_EMP" partyTypeEnumId="PtyPerson">
        <mantle.party.Person firstName="Olga" lastName="Orgonly"/>
        <mantle.party.PartyRole roleTypeId="Employee"/>
    </mantle.party.Party>
    <mantle.party.PartyRelationship partyRelationshipId="SF_EMP_REL" relationshipTypeEnumId="PrtEmployee" fromPartyId="SF_EMP"
            fromRoleTypeId="Employee" toPartyId="ORG_ZIZI_RETAIL" toRoleTypeId="OrgInternal" fromDate="${d30}"/>
    <moqui.security.UserAccount userId="SF_ORG_USER" username="sf.org.user" partyId="SF_EMP" userFullName="Olga Orgonly"/>
    <moqui.security.UserGroup userGroupId="SF_ORG_GROUP" description="Search fixture org users"/>
    <moqui.security.UserGroupMember userGroupId="SF_ORG_GROUP" userId="SF_ORG_USER" fromDate="${d30}"/>
    <moqui.security.ArtifactGroup artifactGroupId="SF_SEARCH" description="General search, limited to the user's organizations">
        <artifacts artifactName="mantle.GeneralServices.search#MantleFiltered" artifactTypeEnumId="AT_SERVICE" inheritAuthz="Y"/>
        <artifacts artifactName="mantle.party.PartyServices.setup#UserOrganizationInfo" artifactTypeEnumId="AT_SERVICE" inheritAuthz="Y"/>
        <artifacts artifactName="mantle.search.UniversalSearchServices.search#Universal" artifactTypeEnumId="AT_SERVICE" inheritAuthz="Y"/>
        <authz artifactAuthzId="SF_SEARCH_ORG" userGroupId="SF_ORG_GROUP" authzTypeEnumId="AUTHZT_ALWAYS" authzActionEnumId="AUTHZA_ALL">
            <filters entityFilterSetId="MANTLE_USER_ORG"/></authz>
        <authz artifactAuthzId="SF_SEARCH_ADMIN" userGroupId="ADMIN" authzTypeEnumId="AUTHZT_ALWAYS" authzActionEnumId="AUTHZA_ALL"/>
    </moqui.security.ArtifactGroup>
</entity-facade-xml>`
}

const num = (value) => value == null ? 0 : Number(String(value))
// the period lines of a summary, without the average and total lines at the end
const periods = (list) => (list || []).slice(0, Math.max(0, (list || []).length - 2))
const total = (lines, field) => Math.round(lines.reduce((acc, line) => acc + num(line[field]), 0) * 1000) / 1000
const documentCount = (indexName, documentType, queryString) => num(call("org.moqui.search.SearchServices.search#DataDocuments",
    { indexName, documentType, queryString, pageSize: 100 }).documentListCount)

// deliver the feed of the fixture, and wait until the sales index has its orders and invoices
function settle() {
    const started = Date.now()
    while (Date.now() - started < 30000) {
        call("org.moqui.EntityServices.process#DataFeedPending", {})
        if (documentCount("mantle_sales", "MantleSalesOrderItem", "orderId:SF_ORD_1") > 0 &&
                documentCount("mantle_sales", "MantleSalesInvoice", "invoiceId:SF_INV_2") > 0 &&
                documentCount("mantle", "MantleParty", "partyId:SF_CUST_B") > 0) return true
    }
    return false
}

// the universal search for a name every organization in the demo data has, with the type facet
const universalSearch = () => call("mantle.search.UniversalSearchServices.search#Universal", { q: "ziziwork", limit: 100, facets: ["entityType"] })
const generalSearch = () => call("mantle.GeneralServices.search#MantleFiltered", { indexName: "mantle", queryString: "Ziziwork", pageSize: 100 })

feature("the sales fixture loads and its feed is indexed", {
    when() {
        const searchAvailable = ec.search.isAvailable()
        ec.entity.makeDataLoader().xmlText(fixture()).load()
        return { searchAvailable, settled: settle() }
    },
    then({ searchAvailable, settled }) {
        searchAvailable
        settled
    },
})

// every Mantle document type that has records is in its index; the wiki pages carry their page text from the manual
// data service
feature("the feed indexed the Mantle document types and the wiki pages' text", {
    expect() {
        for (const documentType of ["MantleParty", "MantleProduct", "MantleFacility", "MantleWikiPage"])
            assert(documentCount("mantle", documentType, "*:*") > 0, `${documentType} has no documents`)
        documentCount("mantle", "MantleWikiPage", '"About Us"') == 1
    },
})

// totals are summed over every period line so the result does not depend on where today falls in the week; the fixture's
// customers are the filter, so the orders and invoices of other specs are out
feature("the sales order and invoice summaries over the fixture", {
    when() {
        const orders = call("mantle.sales.SalesReportServices.get#SalesOrderSummary", { interval: "w", customerPartyIds: customers })
        const invoices = call("mantle.sales.SalesReportServices.get#SalesInvoiceSummary", { interval: "w", toPartyIds: customers })
        return { orders: periods(orders.salesOrderSummaryList), invoices: periods(invoices.salesInvoiceSummaryList) }
    },
    then({ orders, invoices }) {
        // the cancelled order is out
        total(orders, "orderCount") == 2
        total(orders, "newCustomerOrderCount") == 1
        total(orders, "productSaleTotal") == 35
        total(orders, "discountTotal") == -2
        total(orders, "totalSales") == 33
        total(orders, "netSales") == 33
        total(orders, "productQuantityTotal") == 5

        total(invoices, "invoiceCount") == 2
        total(invoices, "invoiceTotal") == 35
        total(invoices, "invoicePaymentsApplied") == 20
        // paid the day before the invoice date
        total(invoices, "prePaymentsTotal") == 20
        total(invoices, "productSaleTotal") == 35
    },
})

feature("the top product of the first order's week and the invoices by customer class", {
    when() {
        // the week before the one seven days after the first order is that order's week
        const top = call("mantle.sales.SalesReportServices.get#SalesTopProduct", { interval: "w", thruDate: ymd(day(8) + 7 * dayMillis) })
        const classes = call("mantle.sales.SalesReportServices.get#InvoicesByCustomerClass", { interval: "M", poffset: 0, thruDate: ymd(day(1)) })
        const byClass = {}
        for (const line of classes.topCustomerClassList || []) if (line.customerClassId) byClass[line.customerClassId] = num(line.invoiceTotal)
        return { products: top.topProductList || [], byClass }
    },
    then({ products, byClass }) {
        products.some((product) => product.productId == "DEMO_1_1")
        // both invoices fall in this month only when the month is old enough; either way each class has at least its own total
        byClass.CustConsumer == null || byClass.CustConsumer >= 20
        byClass.CustWholesale == null || byClass.CustWholesale >= 15
    },
})

// open order quantity per product from the order items, and the available quantity from the assets
feature("projected inventory of the fixture's products", {
    when() {
        const out = call("mantle.product.InventoryReportServices.get#InventoryProjectedInfo", { productIdList: ["DEMO_1_1", "DEMO_2_1"] })
        return { info: out.infoByProductId || {} }
    },
    then({ info }) {
        // the approved order's quantity is in it; completed and cancelled orders are out
        num(info.DEMO_2_1?.orderQuantitySum) >= 3
        num(info.DEMO_1_1?.availableToPromiseTotalSum) > 0
    },
})

feature("party search by any field finds both fixture customers", {
    when() {
        const out = call("mantle.party.PartyServices.search#Party", { anyField: "Sfixture" })
        return { ids: (out.documentList || []).map((doc) => doc.partyId) }
    },
    then({ ids }) {
        ids.includes("SF_CUST_A")
        ids.includes("SF_CUST_B")
    },
})

// as an administrator: typed results with titles and links, the facility found by its title prefix; a mode the backend
// lacks is a message, not a silent fallback
feature("the universal search as an administrator", {
    when() {
        const typed = call("mantle.search.UniversalSearchServices.search#Universal", { q: "sfixture", entityType: "MantleOrder,MantleInvoice" })
        const suggest = call("mantle.search.UniversalSearchServices.search#Universal", { q: "ziziwork ret", mode: "autocomplete" })
        let semanticError = ""
        try {
            call("mantle.search.UniversalSearchServices.search#Universal", { q: "pump", mode: "semantic" })
        } catch (e) { semanticError = String(e.message) }
        semanticError += ec.message.getErrorsString() || ""
        ec.message.clearErrors()
        return { typed, suggested: (suggest.results || []).map((result) => result.title), semanticError }
    },
    then({ typed, suggested, semanticError }) {
        // three orders and two invoices for the fixture customers
        num(typed.total) == 5
        typed.results.every((result) => String(result.url).includes("AutoEditMaster"))
        suggested.includes("Ziziwork Retail Warehouse")
        semanticError.includes("semantic capability")
    },
})

// the general and universal searches as a user of the retail org: everything found is owned by one of the user's
// organizations, and less is found than without the limit
feature("a user limited to their organizations finds only their records", {
    when() {
        // an administrator with no active organization has no limit
        const everything = num(generalSearch().documentListCount)
        const universalAll = num(universalSearch().total)
        // the fixture user has no password
        ec.user.internalLoginUser("sf.org.user")
        ec.artifactExecution.enableAuthz()
        try {
            const allowed = call("mantle.party.PartyServices.setup#UserOrganizationInfo", {}).filterOrgIds || []
            const limited = generalSearch()
            const universal = universalSearch()
            // the type facet's counts, and the owners of each party, facility and asset found
            const facetTotal = (universal.facetCounts?.entityType || []).reduce((acc, facet) => acc + num(facet.count), 0)
            const unowned = universal.results.filter((result) => ["MantleParty", "MantleFacility", "MantleAsset"].includes(result.entityType))
                .filter((result) => !["ownerPartyId", "fromPartyId", "toPartyId"]
                    .map((name) => result.attributes?.[name] ?? result.key?.[name]).filter((owner) => owner != null)
                    .some((owner) => allowed.includes(owner) || owner == "_NA_"))
                .map((result) => `${result.entityType}:${result.id}`)
            return { everything, universalAll, allowed, limited, universal, facetTotal, unowned }
        } finally {
            ec.artifactExecution.disableAuthz()
            for (const name of ["userOrgIds", "filterOrgIds", "activeOrgId"]) delete ec.user.context[name]
            login("john.doe")
        }
    },
    then({ everything, universalAll, allowed, limited, universal, facetTotal, unowned }) {
        allowed.includes("ORG_ZIZI_RETAIL")
        // the user's own organization's records
        limited.documentList.length > 0
        limited.documentList.every((document) => allowed.includes(document.ownerPartyId))
        // the limit removes other organizations' records
        num(limited.documentListCount) < everything

        // the universal search under the same limit: only the user's organizations, and no type without an organization
        num(universal.total) > 0
        num(universal.total) < universalAll
        // the type facet counts the same authorized matches as the total
        facetTotal == num(universal.total)
        universal.results.every((result) => result.entityType != "MantleCommunicationEvent")
        unowned.length == 0
    },
})
