// post#Invoice numbers its ledger lines, and create#InvoiceBillThroughItems its new items, in invoice item order, also
// after an item was changed (impl-accounting F429). Without an order on their item queries Postgres returned the items
// in row-storage order: an update that moves a row (here a product change, which a heap-only update cannot do because
// product_id is indexed), or an insert into space a vacuum freed, put that item elsewhere. New spec, no Groovy original.
const effectiveTime = Date.now()
let orgId, customerId

// a sales invoice of three products whose first item then changes product, which moves its row
function changedInvoice() {
    const invoiceId = call("mantle.account.InvoiceServices.create#Invoice", { fromPartyId: orgId, toPartyId: customerId,
            invoiceTypeEnumId: "InvoiceSales", invoiceDate: effectiveTime - 3600000, currencyUomId: "USD" }).invoiceId
    for (const [productId, amount] of [["DEMO_1_1", 10], ["DEMO_2_1", 20], ["DEMO_3_1", 30]])
        call("mantle.account.InvoiceServices.create#InvoiceItem", { invoiceId, itemTypeEnumId: "ItemProduct", productId, quantity: 1, amount })
    call("update#mantle.account.invoice.InvoiceItem", { invoiceId, invoiceItemSeqId: "01", productId: "DEMO_1_2" })
    return invoiceId
}

spec({
    tempSequences: { start: 58200, banks: { "mantle.party.Party": 10, "mantle.account.invoice.Invoice": 10,
        "mantle.ledger.transaction.AcctgTrans": 10 } },
    setupSpec() {
        login("john.doe")
        ec.user.setEffectiveTime(effectiveTime)
    },
    setup() { ec.artifactExecution.disableAuthz() },
    cleanup() { ec.artifactExecution.enableAuthz() },
})

feature("a sales invoice whose first item was changed posts its lines in item order", {
    when() {
        orgId = call("mantle.party.PartyServices.create#Organization", { organizationName: "Post Order Org", roleTypeId: "Supplier" }).partyId
        call("create#mantle.party.PartyRole", { partyId: orgId, roleTypeId: "OrgInternal" })
        call("mantle.ledger.LedgerServices.init#PartyAccountingConfiguration",
                { sourcePartyId: "DefaultSettings", organizationPartyId: orgId, startYear: String(new Date(effectiveTime).getUTCFullYear()) })
        customerId = call("mantle.party.PartyServices.create#Organization", { organizationName: "Post Order Customer", roleTypeId: "Customer" }).partyId
        const invoiceId = changedInvoice()
        // finalizing posts the invoice
        call("update#mantle.account.invoice.Invoice", { invoiceId, statusId: "InvoiceFinalized" })
        const acctgTransId = ec.entity.find("mantle.ledger.transaction.AcctgTrans").condition("invoiceId", invoiceId).one()?.acctgTransId
        const entries = Array.from(ec.entity.find("mantle.ledger.transaction.AcctgTransEntry")
                .condition("acctgTransId", acctgTransId).orderBy("acctgTransEntrySeqId").list())
        return { lines: entries.map((e) => `${e.acctgTransEntrySeqId}:${e.invoiceItemSeqId ?? ""}:${e.debitCreditFlag}`).join(",") }
    },
    then({ lines }) { lines == "01:01:C,02:02:C,03:03:C,04::D" },
})

feature("bill-through items are created in the original invoice's item order", {
    when() {
        const originalInvoiceId = changedInvoice()
        const newInvoiceId = call("mantle.account.InvoiceServices.create#Invoice", { fromPartyId: orgId, toPartyId: customerId,
                invoiceTypeEnumId: "InvoiceSales", invoiceDate: effectiveTime - 3600000, currencyUomId: "USD" }).invoiceId
        call("mantle.account.InvoiceServices.create#InvoiceBillThroughItems", { originalInvoiceId, newInvoiceId })
        const items = Array.from(ec.entity.find("mantle.account.invoice.InvoiceItem")
                .condition("invoiceId", newInvoiceId).orderBy("invoiceItemSeqId").list())
        return { amounts: items.map((i) => `${i.invoiceItemSeqId}:${dec(i.amount).toNumber()}`).join(",") }
    },
    then({ amounts }) { amounts == "01:10,02:20,03:30" },
})
