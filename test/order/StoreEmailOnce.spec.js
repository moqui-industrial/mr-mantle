// A store order's email goes once (send#OrderStoreEmail, the OrderPlacedSendEmail rule): the tx-commit rule runs again
// from its ServiceOutbox row when its first run did not commit, so its call again sends nothing while the first message
// is ready or sent, and the link to the message is kept when the run that sent it rolls back; forceByType still sends.
// Standalone: spec-local organization, customer, store, template and mail server; the mail capture keeps the sends.
// Run: ./moq test mr-mantle --spec StoreEmailOnce
const prefix = "SEO"
const org = prefix + "_ORG",
    customer = prefix + "_CUST",
    store = prefix + "_STORE",
    since = "2000-01-01T00:00:00Z"
const SEND = "mantle.order.OrderInfoServices.send#OrderStoreEmail"
const find = (entity, conditions = {}) => ec.entity.find(entity).condition(conditions).disableAuthz()
const rows = (entity, conditions) => Array.from(find(entity, conditions).list())
const capture = ec.factory.getTool("MailCapture")
const drain = () => assert(ec.factory.waitWorkerPoolEmpty(50), "Store email worker pool did not drain")

function order(orderId) {
    call("create#mantle.order.OrderHeader", {orderId, statusId: "OrderOpen", currencyUomId: "USD", productStoreId: store})
    call("create#mantle.order.OrderPart", {
        orderId,
        orderPartSeqId: "01",
        vendorPartyId: org,
        customerPartyId: customer,
        statusId: "OrderOpen"
    })
}

spec({
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        capture.enable()
        call("create#mantle.party.Party", {partyId: org, partyTypeEnumId: "PtyOrganization"})
        call("create#mantle.party.Organization", {partyId: org, organizationName: "Store email spec org"})
        call("create#mantle.party.PartyRole", {partyId: org, roleTypeId: "OrgInternal"})
        call("create#mantle.party.Party", {partyId: customer, partyTypeEnumId: "PtyPerson"})
        call("create#mantle.party.Person", {partyId: customer, firstName: "Store", lastName: "Customer"})
        call("create#mantle.party.PartyRole", {partyId: customer, roleTypeId: "Customer"})
        const contactMechId = call("create#mantle.party.contact.ContactMech", {
            contactMechTypeEnumId: "CmtEmailAddress",
            infoString: "buyer@store-email.example"
        }).contactMechId
        call("create#mantle.party.contact.PartyContactMech", {
            partyId: customer,
            contactMechId,
            contactMechPurposeId: "EmailPrimary",
            fromDate: since
        })
        call("create#moqui.basic.email.EmailServer", {
            emailServerId: prefix + "_SMTP",
            smtpHost: "127.0.0.1",
            smtpPort: 9,
            smtpStartTls: "N",
            smtpSsl: "N"
        })
        call("create#moqui.basic.email.EmailTemplate", {
            emailTemplateId: prefix + "_PLACED",
            emailServerId: prefix + "_SMTP",
            fromAddress: "store@store-email.example",
            subject: prefix + " placed",
            bodyScreenLocation: "component://framework/screen/ScreenRenderEmail.xml"
        })
        call("create#mantle.product.store.ProductStore", {
            productStoreId: store,
            storeName: "Store email spec store",
            organizationPartyId: org
        })
        call("create#mantle.product.store.ProductStoreEmail", {
            productStoreId: store,
            emailTypeEnumId: "PsetOrderPlaced",
            fromDate: 0,
            emailTemplateId: prefix + "_PLACED"
        })
        order(prefix + "_SO")
        order(prefix + "_SO_ROLLBACK")
    },
    cleanupSpec() {
        capture.reset()
        ec.artifactExecution.enableAuthz()
    }
})

feature("a placed order's email goes once: its call again sends nothing while the message is ready or sent", {
    when() {
        const orderId = prefix + "_SO"
        capture.clear()
        call("update#mantle.order.OrderHeader", {orderId, statusId: "OrderPlaced"})
        drain()
        const placed = capture.count()
        const again = {orderId, emailTypeEnumId: "PsetOrderPlaced"}
        call(SEND, again)
        drain()
        const replayed = capture.count()
        // a message still on its way (ready: its send failed and is retried from the mail queue) holds it back too
        const emailMessageId = rows("mantle.order.OrderEmailMessage", {orderId})[0]?.emailMessageId
        // (written directly: no status flow goes from sent back to ready)
        const message = find("moqui.basic.email.EmailMessage", {emailMessageId}).one()
        message.set("statusId", "ES_READY")
        message.update()
        call(SEND, again)
        drain()
        const whileReady = capture.count()
        call(SEND, Object.assign({forceByType: true}, again))
        drain()
        return {placed, replayed, whileReady, forced: capture.count(), links: rows("mantle.order.OrderEmailMessage", {orderId})}
    },
    then({placed, replayed, whileReady, forced, links}) {
        placed == 1
        replayed == 1
        whileReady == 1
        forced == 2
        links.length == 2
    }
})

feature("a run that rolls back after the send keeps its link, so the call again sends nothing", {
    when() {
        const orderId = prefix + "_SO_ROLLBACK"
        capture.clear()
        const began = ec.transaction.begin(null)
        try {
            call(SEND, {orderId, emailTypeEnumId: "PsetOrderPlaced"})
        } finally {
            ec.transaction.rollback(began, "Store email spec: the rule's run fails after its send", null)
        }
        drain()
        const sent = capture.count()
        call(SEND, {orderId, emailTypeEnumId: "PsetOrderPlaced"})
        drain()
        return {sent, again: capture.count(), links: rows("mantle.order.OrderEmailMessage", {orderId})}
    },
    then({sent, again, links}) {
        sent == 1
        again == 1
        links.length == 1
    }
})
