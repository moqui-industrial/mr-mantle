// PASS Sales' customer quotes (impl-sales P13; design-sales §10 CustomerQuotes, CustomerQuote and QuoteResponse; X6, F36;
// mantle.order.SalesPortalServices over SalesPortal.js, the SalesOrder kind's quote scopes in ExternalAccess.js): a quote's mail
// carries its recipient's bearer link to the organization's Sales mount; the link reads its one issue and its PDF and lists
// nothing; another customer's quote, a changed order ID, a forged token and a revised issue give the same nothing; a double submit
// gives one response and one placed order, a retry answering the first and another link's use of the key a conflict; a contact
// invited for the customer lists only its account's issued quotes; above the seller's acceptance threshold a bearer is refused and
// the signed-in contact accepts. P17 (design-sales §10 CustomerOrders, CustomerOrder; F42, F48, F236): the storeless confirmation
// carries its recipient's link to the order's Sales page, which reads its one order (lines, the accepted quote, shipments with
// tracking, invoices with their open amount, the PDF) and lists nothing, while a store order's link stays Shop's; a contact lists
// only its account's placed storeless orders (no draft, base, store order or other customer's); an accepted quote's page shows the
// issued offer, not a later change of the order. Standalone: SalesQuoteIssueFixtures, a spec-local site.
// Run: ./moq test mr-mantle --spec SalesPortal
const fx = ec.resource.script("component://mr-mantle/test/order/SalesQuoteIssueFixtures.js")
const {system, as, make, one, revision, status, proposedQuote, key, call} = fx
const capture = ec.factory.getTool("MailCapture")
const P = "mantle.order.SalesPortalServices."
const orders = "mantle.order.SalesOrderServices."
// the placement's tx-commit rules run on a service worker (send#OrderConfirmation among them): wait for them
const drain = () => ec.factory.waitWorkerPoolEmpty(50)
const siteId = "SPT_SITE"
let f
const shared = {}

// a PASS operation as an account (null: a visitor), as pass.Facade calls it: its result, or the error's kind and message
function page(username, verb, input) {
    if (username) login(username)
    else logout()
    ec.artifactExecution.disableAuthz()
    ec.message.pushErrors()
    try {
        return ec.service
            .sync()
            .throwOnError(true)
            .name(P + verb)
            .parameters({input: Object.assign({siteId}, input)})
            .requireNewTransaction(true)
            .call().result
    } catch (error) {
        return {kind: error.moquiErrorKind || "Error", error: String(error.message)}
    } finally {
        ec.message.clearErrors()
        ec.message.popErrors()
        login("john.doe")
    }
}
// a quote of A for the account, sent to the mailed contact: {orderId, issueId, revision, token (from the mail)}
function issued(customerPartyId = f.accounts.a, contactPartyId = f.contacts.mailed) {
    capture.clear()
    const {orderId} = proposedQuote(f, f.users.rep, f.orgA, customerPartyId, contactPartyId)
    const sent = as(f.users.rep, "send#Quote", {orderId, orderRevision: revision(orderId), operationKey: key("send")})
    fx.attempt(sent.issueId)
    const body = String(capture.getMessages()[0]?.body || "")
    const found = /\/sales\/CustomerQuote\?token=([^"'\s<&]+)/.exec(body)
    return {orderId, issueId: sent.issueId, revision: revision(orderId), token: found ? decodeURIComponent(found[1]) : null, body}
}
// another link to an issue, as a second recipient's mail makes it
const secondLink = quote =>
    system(
        () =>
            ec.resource.script("component://mr-mantle/service/mantle/party/ExternalAccess.js").create({
                recordType: "SalesOrder",
                recordId: quote.orderId,
                scopes: "QuoteView,QuoteRespond",
                recordRevision: quote.revision,
                thruDate: one("mantle.sales.quote.SalesQuoteIssue", {issueId: quote.issueId}).validThruDate
            }).token
    )
const acceptance = (quote, more) =>
    Object.assign(
        {
            action: "accept",
            expectedRevision: quote.revision,
            acknowledge: "Y",
            purchaseOrder: "PO-SPT",
            acceptorName: "Ann Buyer",
            acceptorTitle: "Purchasing",
            operationId: key("spt")
                .replace(/[^A-Za-z0-9_-]/g, "")
                .slice(0, 30)
        },
        more
    )

spec({
    stepwise: true,
    setupSpec() {
        capture.enable()
        f = fx.setup("SPT")
        system(() => {
            make("mantle.public.PublicSite", {
                siteId,
                name: "Sales portal spec",
                state: "published",
                registrationMode: "invitation",
                locale: "en",
                timeZone: "UTC",
                policyRevision: 1,
                generation: 1
            })
            make("mantle.public.PublicSiteHost", {hostname: "spt.example.test", siteId, canonical: "Y"})
            make("mantle.public.PublicSiteApp", {
                siteId,
                appMountId: "sales",
                app: "sales",
                pathPrefix: "/sales",
                enabled: "Y",
                targetId: f.orgA
            })
            // another customer of A, and an account invited for A's account (a contact grant, as redeeming Invite to Sales makes)
            make("mantle.party.Party", {partyId: "SPT_ACC_X", partyTypeEnumId: "PtyOrganization", ownerPartyId: f.orgA})
            make("mantle.party.Organization", {partyId: "SPT_ACC_X", organizationName: "Account x"})
            make("mantle.party.PartyRole", {partyId: "SPT_ACC_X", roleTypeId: "Customer"})
            for (const partyId of ["SPT_BUYER", "SPT_OUTSIDER"]) {
                make("mantle.party.Party", {partyId, partyTypeEnumId: "PtyPerson"})
                make("mantle.party.Person", {partyId, firstName: partyId, lastName: "Spec"})
                make("moqui.security.UserAccount", {
                    userId: partyId,
                    username: partyId,
                    partyId,
                    emailAddress: partyId.toLowerCase() + "@buyer.example.test",
                    currentPassword: "16ac58bbfa332c1c55bd98b53e60720bfa90d394",
                    passwordHashType: "SHA"
                })
            }
            make("mantle.party.ExternalAccessContact", {
                partyId: "SPT_BUYER",
                outsidePartyId: f.accounts.a,
                organizationPartyId: f.orgA,
                app: "sales",
                fromDate: ec.user.nowTimestamp
            })
            // P17: a seller of A's direct orders, and A's confirmations through the spec's mail server
            shared.seller = fx.addUser(
                f,
                "seller",
                [f.orgA],
                ["SALES_VIEW", "SALES_TEAM_VIEW", "SALES_ORDER_EDIT", "ORDER_APPROVE"]
            )
            const policy = ec.entity.find("mantle.sales.policy.SalesPolicy").condition("organizationPartyId", f.orgA).one()
            call("update#mantle.sales.policy.SalesPolicy", {
                salesPolicyId: policy.salesPolicyId,
                confirmationEmailTemplateId: f.template
            })
        })
    },
    cleanupSpec() {
        capture.reset()
        login("john.doe")
    }
})

feature(
    "a bearer link reads its one issue and PDF and lists nothing; another quote, a changed ID and a revised issue give nothing",
    {
        when() {
            const quote = issued()
            const other = system(() => {
                const {orderId} = proposedQuote(f, f.users.rep, f.orgA, "SPT_ACC_X", null)
                return orderId
            })
            const view = page(null, "get#CustomerQuote", {token: quote.token})
            const document = page(null, "get#QuoteDocument", {token: quote.token})
            const list = page(null, "find#CustomerQuotes", {})
            const receipt = page(null, "get#QuoteResponse", {token: quote.token})
            const changed = page(null, "get#CustomerQuote", {token: quote.token, orderId: other})
            const forged = page(null, "get#CustomerQuote", {token: "x".repeat(48)})
            const byId = page(null, "get#CustomerQuote", {orderId: quote.orderId})
            // the print carries the quote's page for a signed-in contact (no token) and its QR
            const print = as(f.users.rep, "get#QuotePrint", {orderId: quote.orderId})
            as(f.users.rep, "revise#Quote", {orderId: quote.orderId, orderRevision: quote.revision, reason: "New terms"})
            const revised = page(null, "get#CustomerQuote", {token: quote.token})
            const issueRow = one("mantle.sales.quote.SalesQuoteIssue", {issueId: quote.issueId})
            shared.revised = quote.orderId
            // P13 review: a quote link is made only by send#Quote, never by create#AccessCapability (even for a quote sender)
            // (as the rep, with the service's own checks: artifact authorization off as a screen's transition would grant it)
            login(f.users.rep)
            ec.artifactExecution.disableAuthz()
            ec.message.pushErrors()
            let minted
            try {
                ec.service
                    .sync()
                    .name("mantle.party.ExternalAccessServices.create#AccessCapability")
                    .parameters({recordType: "SalesOrder", recordId: other, scopes: "QuoteView,QuoteRespond"})
                    .requireNewTransaction(true)
                    .call()
                minted = {refused: ec.message.getErrorsString()}
            } catch (error) {
                minted = {refused: String(error.message)}
            } finally {
                ec.message.clearErrors()
                ec.message.popErrors()
                login("john.doe")
            }
            return {quote, view, document, list, receipt, changed, forged, byId, revised, issueRow, print, minted}
        },
        then({quote, view, document, list, receipt, changed, forged, byId, revised, issueRow, print, minted}) {
            print.printHtml.includes("https://spt.example.test/sales/CustomerQuote?orderId=" + quote.orderId)
            print.printHtml.includes("<svg") && !print.printHtml.includes("token=")
            quote.token != null && quote.body.includes("https://spt.example.test/sales/CustomerQuote?token=")
            view.quote.orderId == quote.orderId && view.quote.state == "open" && view.quote.revision == quote.revision
            view.quote.lines.length == 1 && view.quote.totalText.includes("200")
            view.capabilities.canAccept == true && view.capabilities.signInToAccept == false
            view.document.fileName.endsWith(".pdf")
            !JSON.stringify(view).includes("dbresource")
            document.file.mimeType == "application/pdf" && document.location == issueRow.contentLocation
            list.kind == "AuthenticationRequired"
            receipt.kind == "NotFound"
            changed.kind == "NotFound"
            forged.kind == "NotFound"
            byId.kind == "AuthenticationRequired"
            revised.kind == "NotFound"
            minted.refused.includes("SCOPE_INVALID")
        }
    }
)

feature(
    "a double submit gives one response and one placed order; another link's use of the key conflicts; a decline after it is refused",
    {
        when() {
            const quote = issued()
            const otherToken = secondLink(quote)
            const request = acceptance(quote)
            // P13 review: an acceptance names its acceptor (the page's required field, required by the service too)
            const nameless = page(
                null,
                "respond#CustomerQuote",
                Object.assign({token: quote.token}, acceptance(quote, {acceptorName: ""}))
            )
            const first = page(null, "respond#CustomerQuote", Object.assign({token: quote.token}, request))
            const repeat = page(null, "respond#CustomerQuote", Object.assign({token: quote.token}, request))
            const otherSameKey = page(null, "respond#CustomerQuote", Object.assign({token: otherToken}, request))
            const otherNewKey = page(null, "respond#CustomerQuote", Object.assign({token: otherToken}, acceptance(quote)))
            const decline = page(null, "respond#CustomerQuote", {
                token: quote.token,
                action: "decline",
                reason: "Too late",
                operationId: key("dec")
                    .replace(/[^A-Za-z0-9_-]/g, "")
                    .slice(0, 30)
            })
            const receipt = page(null, "get#QuoteResponse", {token: quote.token})
            const responses = system(() =>
                Array.from(ec.entity.find("mantle.sales.quote.SalesQuoteResponse").condition("orderId", quote.orderId).list())
            )
            shared.accepted = quote.orderId
            shared.acceptedToken = quote.token
            return {
                quote,
                nameless,
                first,
                repeat,
                otherSameKey,
                otherNewKey,
                decline,
                receipt,
                responses,
                statusId: status(quote.orderId)
            }
        },
        then({quote, nameless, first, repeat, otherSameKey, otherNewKey, decline, receipt, responses, statusId}) {
            nameless.kind == "Unprocessable" && nameless.error.includes("ACCEPTOR_REQUIRED")
            first.alreadyApplied == false && first.response.accepted == true && first.response.outcome == "placed"
            repeat.alreadyApplied == true && repeat.response.responseId == first.response.responseId
            otherSameKey.kind == "Conflict"
            otherNewKey.alreadyApplied == true && otherNewKey.response.responseId == first.response.responseId
            decline.kind == "Conflict" && decline.error.includes("RESPONSE_RECORDED")
            receipt.response.purchaseOrder == "PO-SPT" && receipt.response.acceptorName == "Ann Buyer"
            receipt.quote.state == "accepted"
            responses.length == 1
            responses[0].responseSourceEnumId == "SqsPortal" &&
                responses[0].capabilityId != null &&
                responses[0].recordedByUserId == null
            statusId == "OrderPlaced"
        }
    }
)

feature(
    "a contact invited for the account lists only its account's issued quotes; an uninvited account and another customer's quote get nothing",
    {
        when() {
            const draft = as(f.users.rep, fx.quoteService + "create#Quote", {
                organizationPartyId: f.orgA,
                customerPartyId: f.accounts.a
            }).orderId
            const other = issued("SPT_ACC_X", null)
            const list = page("SPT_BUYER", "find#CustomerQuotes", {})
            const open = page("SPT_BUYER", "find#CustomerQuotes", {state: "open"})
            const outsider = page("SPT_OUTSIDER", "find#CustomerQuotes", {})
            const otherQuote = page("SPT_BUYER", "get#CustomerQuote", {orderId: other.orderId})
            const own = page("SPT_BUYER", "get#CustomerQuote", {orderId: shared.accepted})
            // P13 review: the quote revised in the first feature, changed and proposed again but not sent, shows nothing unissued
            const revisedOrderId = shared.revised
            as(f.users.rep, fx.quoteService + "store#QuoteLine", {
                orderId: revisedOrderId,
                orderRevision: revision(revisedOrderId),
                productId: f.product,
                quantity: 3
            })
            const reproposed = as(f.users.rep, fx.quoteService + "propose#Quote", {
                orderId: revisedOrderId,
                orderRevision: revision(revisedOrderId)
            })
            const unissued = page("SPT_BUYER", "get#CustomerQuote", {orderId: revisedOrderId})
            const listAfter = page("SPT_BUYER", "find#CustomerQuotes", {})
            return {draft, other, list, open, outsider, otherQuote, own, reproposed, unissued, listAfter, revisedOrderId}
        },
        then({draft, other, list, open, outsider, otherQuote, own, reproposed, unissued, listAfter, revisedOrderId}) {
            list.count >= 1 && list.quoteList.some(row => row.orderId == shared.accepted && row.state == "accepted")
            !list.quoteList.some(row => row.orderId == draft || row.orderId == other.orderId)
            !list.quoteList.some(row => row.orderId == revisedOrderId)
            reproposed.refused == "" && unissued.kind == "NotFound"
            !listAfter.quoteList.some(row => row.orderId == revisedOrderId)
            !open.quoteList.some(row => row.state != "open")
            outsider.count == 0 && outsider.quoteList.length == 0
            otherQuote.kind == "NotFound"
            own.response.accepted == true && own.capabilities.canAccept == false
        }
    }
)

feature("above the seller's acceptance threshold a bearer link is refused and the signed-in contact accepts", {
    when() {
        const policy = system(
            () =>
                Array.from(
                    ec.entity
                        .find("mantle.sales.policy.SalesPolicy")
                        .condition("organizationPartyId", f.orgA)
                        .orderBy("-fromDate")
                        .list()
                )[0]
        )
        system(() =>
            make("mantle.sales.policy.SalesPolicyThreshold", {
                salesPolicyId: policy.salesPolicyId,
                currencyUomId: "USD",
                thresholdAmount: "150"
            })
        )
        const quote = issued()
        const bearerView = page(null, "get#CustomerQuote", {token: quote.token})
        const bearer = page(null, "respond#CustomerQuote", Object.assign({token: quote.token}, acceptance(quote)))
        const contactView = page("SPT_BUYER", "get#CustomerQuote", {orderId: quote.orderId})
        const contact = page("SPT_BUYER", "respond#CustomerQuote", Object.assign({orderId: quote.orderId}, acceptance(quote)))
        const response = system(() =>
            ec.entity.find("mantle.sales.quote.SalesQuoteResponse").condition("orderId", quote.orderId).one()
        )
        return {bearerView, bearer, contactView, contact, response, statusId: status(quote.orderId)}
    },
    then({bearerView, bearer, contactView, contact, response, statusId}) {
        bearerView.capabilities.canAccept == false && bearerView.capabilities.signInToAccept == true
        bearerView.capabilities.canDecline == true
        bearer.kind == "Unprocessable" && bearer.error.includes("ACCEPTANCE_SIGN_IN_REQUIRED")
        contactView.capabilities.canAccept == true
        contact.response.accepted == true
        response.contactPartyId == "SPT_BUYER" && response.capabilityId == null
        statusId == "OrderPlaced"
    }
})

// ===== P17: a customer's orders =====
// a direct order of A for a customer, one line of the product, placed by the seller (productStoreId: a store's order)
function placedOrder(customerPartyId, more = {}) {
    const orderId = as(
        shared.seller,
        orders + "create#SalesOrder",
        Object.assign({organizationPartyId: f.orgA, customerPartyId}, more)
    ).orderId
    as(shared.seller, orders + "store#SalesOrderLine", {
        orderId,
        orderRevision: revision(orderId),
        productId: f.product,
        quantity: 2
    })
    const placed = as(shared.seller, orders + "place#SalesOrder", {orderId, orderRevision: revision(orderId)})
    if (placed.refused) throw new Error(placed.refused)
    return orderId
}
// a shipped shipment of the order's line with two tracked packages (one with a carrier's https link, one with a script URL), and a
// finalized invoice of the line, unpaid
function shipAndInvoice(orderId) {
    system(() => {
        const item = Array.from(ec.entity.find("mantle.order.OrderItem").condition("orderId", orderId).list())[0]
        const shipmentId = make("mantle.shipment.Shipment", {
            shipmentTypeEnumId: "ShpTpSales",
            statusId: "ShipShipped",
            fromPartyId: f.orgA,
            toPartyId: f.accounts.a,
            shipDate: ec.user.nowTimestamp
        }).shipmentId
        make("mantle.shipment.ShipmentItem", {shipmentId, productId: f.product, quantity: 2})
        make("mantle.shipment.ShipmentItemSource", {
            shipmentId,
            productId: f.product,
            orderId,
            orderItemSeqId: item.orderItemSeqId,
            quantity: 2
        })
        make("mantle.shipment.ShipmentRouteSegment", {shipmentId, shipmentRouteSegmentSeqId: "01"})
        for (const [seq, url] of [
            ["01", "https://carrier.example.test/track/SPT1"],
            ["02", "javascript:alert(1)"]
        ]) {
            make("mantle.shipment.ShipmentPackage", {shipmentId, shipmentPackageSeqId: seq})
            make("mantle.shipment.ShipmentPackageRouteSeg", {
                shipmentId,
                shipmentPackageSeqId: seq,
                shipmentRouteSegmentSeqId: "01",
                trackingCode: "SPT" + seq,
                trackingUrl: url
            })
        }
        const invoiceId = make("mantle.account.invoice.Invoice", {
            invoiceTypeEnumId: "InvoiceSales",
            fromPartyId: f.orgA,
            toPartyId: f.accounts.a,
            statusId: "InvoiceFinalized",
            invoiceDate: ec.user.nowTimestamp,
            currencyUomId: "USD"
        }).invoiceId
        make("mantle.account.invoice.InvoiceItem", {
            invoiceId,
            invoiceItemSeqId: "01",
            itemTypeEnumId: "ItemProduct",
            productId: f.product,
            quantity: 2,
            amount: 100
        })
        make("mantle.order.OrderItemBilling", {
            orderId,
            orderItemSeqId: item.orderItemSeqId,
            invoiceId,
            invoiceItemSeqId: "01",
            quantity: 2,
            amount: 100
        })
    })
}
const orderTokenOf = body => {
    const found = /\/sales\/CustomerOrder\?token=([^"'\s<&]+)/.exec(String(body || ""))
    return found ? decodeURIComponent(found[1]) : null
}

feature(
    "the confirmation's link reads its one order and lists nothing; a quote's link, another order and a store order's give nothing",
    {
        when() {
            capture.clear()
            const orderId = placedOrder(f.accounts.a, {contactPartyId: f.contacts.mailed, otherPartyOrderId: "PO-P17"})
            drain()
            const mail = capture.getMessages().find(message => String(message.subject).includes(orderId))
            const token = orderTokenOf(mail?.body)
            shipAndInvoice(orderId)
            const other = placedOrder("SPT_ACC_X")
            const view = page(null, "get#CustomerOrder", {token})
            const document = page(null, "get#OrderDocument", {token})
            const list = page(null, "find#CustomerOrders", {})
            const changed = page(null, "get#CustomerOrder", {token, orderId: other})
            const asQuote = page(null, "get#CustomerQuote", {token})
            const byQuoteLink = page(null, "get#CustomerOrder", {token: shared.acceptedToken})
            const byId = page(null, "get#CustomerOrder", {orderId})
            // a store order's OrderView link opens Shop's page on the store's site, and the Sales page refuses it
            const store = system(() => {
                make("mantle.product.store.ProductStore", {
                    productStoreId: "SPT_STORE",
                    storeName: "Portal spec store",
                    organizationPartyId: f.orgA,
                    defaultCurrencyUomId: "USD",
                    requireInventory: "N"
                })
                make("mantle.public.PublicSiteApp", {
                    siteId,
                    appMountId: "shop",
                    app: "shop",
                    pathPrefix: "/shop",
                    enabled: "Y",
                    targetId: "SPT_STORE"
                })
                return null
            })
            const storeOrder = placedOrder(f.accounts.a, {productStoreId: "SPT_STORE"})
            const storeLink = system(() =>
                ec.resource
                    .script("component://mr-mantle/service/mantle/party/ExternalAccess.js")
                    .create({recordType: "SalesOrder", recordId: storeOrder, scopes: "OrderView"})
            )
            const storeView = page(null, "get#CustomerOrder", {token: storeLink.token})
            shared.direct = orderId
            shared.other = other
            shared.storeOrder = storeOrder
            return {orderId, mail, token, view, document, list, changed, asQuote, byQuoteLink, byId, store, storeLink, storeView}
        },
        then({orderId, mail, token, view, document, list, changed, asQuote, byQuoteLink, byId, storeLink, storeView}) {
            token != null && mail.body.includes("https://spt.example.test/sales/CustomerOrder?token=")
            view.order.orderId == orderId && view.order.purchaseOrder == "PO-P17" && view.order.customerName == "Account a"
            view.order.lines.length == 1 && view.order.totalText.includes("200")
            view.acceptedQuote == null && view.capabilities.quoteLink == false
            view.shipments.length == 1 && view.shipments[0].shipped == true
            view.shipments[0].tracking.length == 2 &&
                view.shipments[0].tracking[0].url == "https://carrier.example.test/track/SPT1"
            view.shipments[0].tracking[1].url == null
            view.invoices.length == 1 && view.invoices[0].openText.includes("200") && view.invoices[0].billingUrl == null
            view.document.fileName.endsWith(".pdf") && !JSON.stringify(view).includes("dbresource")
            view.actions.askUrl == null && view.actions.requestCancelUrl == null
            document.file.mimeType == "application/pdf" && document.location.startsWith("dbresource://")
            list.kind == "AuthenticationRequired"
            changed.kind == "NotFound"
            asQuote.kind == "NotFound"
            byQuoteLink.kind == "NotFound"
            byId.kind == "AuthenticationRequired"
            storeLink.url == "https://spt.example.test/shop/Orders/Status?token=" + encodeURIComponent(storeLink.token)
            storeView.kind == "NotFound"
        }
    }
)

feature(
    "a contact lists its account's placed orders only; an accepted quote's page keeps the issued offer once the order changes",
    {
        when() {
            const draft = as(shared.seller, orders + "create#SalesOrder", {
                organizationPartyId: f.orgA,
                customerPartyId: f.accounts.a
            }).orderId
            const base = placedOrder(f.accounts.a)
            system(() => call("update#mantle.order.OrderHeader", {orderId: base, orderPurposeEnumId: "OrpRecurringTemplate"}))
            system(() =>
                make("mantle.public.PublicSiteApp", {
                    siteId,
                    appMountId: "billing",
                    app: "billing",
                    pathPrefix: "/billing",
                    enabled: "Y",
                    targetId: f.orgA
                })
            )
            const list = page("SPT_BUYER", "find#CustomerOrders", {})
            const byPo = page("SPT_BUYER", "find#CustomerOrders", {reference: "po-p17"})
            const own = page("SPT_BUYER", "get#CustomerOrder", {orderId: shared.direct})
            const accepted = page("SPT_BUYER", "get#CustomerOrder", {orderId: shared.accepted})
            const otherOrder = page("SPT_BUYER", "get#CustomerOrder", {orderId: shared.other})
            const outsider = page("SPT_OUTSIDER", "find#CustomerOrders", {})
            const outsiderOwn = page("SPT_OUTSIDER", "get#CustomerOrder", {orderId: shared.direct})
            const card = page("SPT_BUYER", "get#AccountCard", {})
            // F236: the accepted quote's page shows the issued offer; after a commercial change of the order it shows none of the change
            const before = page("SPT_BUYER", "get#CustomerQuote", {orderId: shared.accepted})
            system(() =>
                call("mantle.order.OrderServices.increment#OrderRevision", {orderId: shared.accepted, revisionKind: "commercial"})
            )
            const after = page("SPT_BUYER", "get#CustomerQuote", {orderId: shared.accepted})
            const receipt = page(null, "get#QuoteResponse", {token: shared.acceptedToken})
            return {draft, base, list, byPo, own, accepted, otherOrder, outsider, outsiderOwn, card, before, after, receipt}
        },
        then({draft, base, list, byPo, own, accepted, otherOrder, outsider, outsiderOwn, card, before, after, receipt}) {
            list.orderList.some(row => row.orderId == shared.direct) && list.orderList.some(row => row.orderId == shared.accepted)
            !list.orderList.some(row => [draft, base, shared.other, shared.storeOrder].includes(row.orderId))
            list.orderList.find(row => row.orderId == shared.direct).deliveryText == "Shipped"
            list.orderList.find(row => row.orderId == shared.direct).billingText.includes("200")
            byPo.orderList.length == 1 && byPo.orderList[0].orderId == shared.direct
            own.invoices[0].billingUrl == "https://spt.example.test/billing/InvoicePay?invoiceId=" + own.invoices[0].invoiceId
            accepted.acceptedQuote.purchaseOrder == "PO-SPT" && accepted.capabilities.quoteLink == true
            otherOrder.kind == "NotFound"
            outsider.count == 0 && outsiderOwn.kind == "NotFound"
            card.lines.some(line => line.includes("open order")) &&
                card.links.some(link => link.url.endsWith("/sales/CustomerOrders"))
            before.quote.lines.length == 1 && before.quote.changedSinceAccepted == false
            after.quote.lines.length == 0 && after.quote.totalText == "" && after.quote.changedSinceAccepted == true
            receipt.quote.totalText == "" && receipt.response.accepted == true
        }
    }
)

// Sales P19 (the user's call of Nov 14, P17's review): a cancelled order stays on My orders and opens from its link, marked Cancelled
// and read only; its link is not revoked by the cancellation, and it is never counted open
feature("a cancelled order stays listed and opens from its link marked Cancelled, read only, and is not counted open", {
    when() {
        capture.clear()
        const orderId = placedOrder(f.accounts.a, {contactPartyId: f.contacts.mailed})
        drain()
        const mail = capture.getMessages().find(message => String(message.subject).includes(orderId))
        const token = orderTokenOf(mail?.body)
        const cardBefore = page("SPT_BUYER", "get#AccountCard", {})
        system(() => call("mantle.order.OrderServices.cancel#Order", {orderId}))
        const header = system(() => one("mantle.order.OrderHeader", {orderId}))
        const byLink = page(null, "get#CustomerOrder", {token})
        const byId = page("SPT_BUYER", "get#CustomerOrder", {orderId})
        const all = page("SPT_BUYER", "find#CustomerOrders", {})
        const open = page("SPT_BUYER", "find#CustomerOrders", {state: "open"})
        const cardAfter = page("SPT_BUYER", "get#AccountCard", {})
        const revoked = system(() =>
            ec.entity
                .find("mantle.party.ExternalAccessCapability")
                .condition("recordType", "SalesOrder")
                .condition("recordId", orderId)
                .condition("revokedDate", "is-not-null", null)
                .count()
        )
        return {orderId, token, header, byLink, byId, all, open, cardBefore, cardAfter, revoked}
    },
    then({orderId, token, header, byLink, byId, all, open, cardBefore, cardAfter, revoked}) {
        token != null && header.statusId == "OrderCancelled" && revoked == 0
        byLink.order.orderId == orderId && byLink.order.cancelled == true && byLink.order.stateText == "Cancelled"
        byLink.order.lines.length == 1
        byLink.actions.requestCancelUrl == null && byLink.actions.requestReturnUrl == null
        byId.order.cancelled == true && byId.actions.requestCancelUrl == null && byId.actions.requestReturnUrl == null
        byId.actions.cancellationRequested == false && byId.invoices.every(row => row.billingUrl == null)
        all.orderList.find(row => row.orderId == orderId).stateText == "Cancelled"
        all.orderList.find(row => row.orderId == orderId).cancelled == true
        !open.orderList.some(row => row.orderId == orderId)
        cardBefore.lines.join(" ") != cardAfter.lines.join(" ")
    }
})
