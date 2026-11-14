// Sales' storeless confirmation (impl-sales P11, X1, §4 Nov 11, F15, F16; design-sales §16; mantle.order.SalesOrderServices
// send#OrderConfirmation over the delivery ledger, the OrderPlacedSalesConfirmation rule): a storeless direct order placed sends one
// confirmation (Customer Service's stored confirmation as placed, attached, from the seller's own address) to its customer; its
// approval, and a hold released back to Approved, send none again; a store order of the seller sends none (its store mail is the
// store's). The seller's own confirmation template is used. Standalone: SalesQuoteIssueFixtures (C storeless with a tax gateway, A with a store) and a spec-local user.
// Run: ./moq test mr-mantle --spec StorelessOrderConfirmation
const fx = ec.resource.script("component://mr-mantle/test/order/SalesQuoteIssueFixtures.js")
const {call, system, as, make, one, revision, status} = fx
const orders = "mantle.order.SalesOrderServices."
const capture = ec.factory.getTool("MailCapture")
let f, seller
// the placement's tx-commit rules run on a service worker (send#OrderConfirmation among them): wait for them
const drain = () => ec.factory.waitWorkerPoolEmpty(50)

const deliveries = orderId =>
    system(() =>
        Array.from(
            ec.entity
                .find("mantle.party.MessageDelivery")
                .condition("eventKey", "like", "SalesOrderConfirmation:" + orderId + "@%")
                .list()
        )
    )
// a direct order of the organization for the account, one line of the product (with or without the organization's store), placed
function placedOrder(organizationPartyId, customerPartyId, productStoreId) {
    const orderId = as(seller, orders + "create#SalesOrder", {organizationPartyId, customerPartyId, productStoreId}).orderId
    as(seller, orders + "store#SalesOrderLine", {orderId, orderRevision: revision(orderId), productId: f.product, quantity: 2})
    const placed = as(seller, orders + "place#SalesOrder", {orderId, orderRevision: revision(orderId)})
    if (placed.refused) throw new Error(placed.refused)
    return orderId
}

spec({
    stepwise: true,
    setupSpec() {
        capture.enable()
        f = fx.setup("SOC")
        system(() => {
            seller = fx.addUser(
                f,
                "seller",
                [f.orgA, f.orgC],
                ["SALES_VIEW", "SALES_TEAM_VIEW", "SALES_ORDER_EDIT", "ORDER_APPROVE"]
            )
            fx.email(f.accounts.c, "buyer@account-c.example.test")
            // C's confirmations through the spec's mail server (SalesPolicy.confirmationEmailTemplateId; Mantle's own is the default)
            const policy = ec.entity.find("mantle.sales.policy.SalesPolicy").condition("organizationPartyId", f.orgC).one()
            call("update#mantle.sales.policy.SalesPolicy", {
                salesPolicyId: policy.salesPolicyId,
                confirmationEmailTemplateId: f.template
            })
            make("mantle.product.store.ProductStore", {
                productStoreId: f.orgA + "_STORE",
                storeName: "Confirmation store",
                organizationPartyId: f.orgA,
                defaultCurrencyUomId: "USD",
                requireInventory: "N"
            })
        })
    },
    cleanupSpec() {
        capture.reset()
        login("john.doe")
    }
})

feature("a storeless order's placement sends one confirmation; its approval and a released hold send none; a store order none", {
    when() {
        capture.clear()
        const orderId = placedOrder(f.orgC, f.accounts.c, null)
        drain()
        const placed = deliveries(orderId)
        const mails = capture.getMessages().filter(mail => String(mail.subject).includes(orderId))
        as(seller, orders + "approve#SalesOrder", {orderId, orderRevision: revision(orderId)})
        const held = as(seller, orders + "hold#SalesOrder", {
            orderId,
            holdTypeEnumId: "OhtManual",
            holdComment: "Check the address"
        })
        as(seller, orders + "release#SalesOrderHold", {orderHoldReasonId: held.orderHoldReasonId, releaseComment: "Confirmed"})
        drain()
        const after = deliveries(orderId)
        const stored = system(() =>
            ec.entity
                .find("mantle.order.OrderContent")
                .condition({orderId, orderContentTypeEnumId: "OctOrderConfirmation"})
                .count()
        )
        const storeOrder = placedOrder(f.orgA, f.accounts.a, f.orgA + "_STORE")
        drain()
        return {placed, mails, after, stored, statusId: status(orderId), storeDeliveries: deliveries(storeOrder)}
    },
    then({placed, mails, after, stored, statusId, storeDeliveries}) {
        placed.length == 1 && placed[0].recipientPartyId == f.accounts.c
        // from the seller, whose suppressions it meets (Marketing P3's delivery organization)
        placed[0].organizationPartyId == f.orgC
        placed[0].stateEnumId + ":" + placed[0].lastError == "MdsSent:null"
        mails.length == 1
        mails[0].toList.includes("buyer@account-c.example.test")
        mails[0].fromAddress.startsWith("sales@")
        mails[0].attachmentNames.some(name => name.endsWith(".pdf"))
        statusId == "OrderApproved"
        after.length == 1
        stored == 1
        storeDeliveries.length == 0
    }
})
