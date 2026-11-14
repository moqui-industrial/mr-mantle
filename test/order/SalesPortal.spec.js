// PASS Sales' customer quotes (impl-sales P13; design-sales §10 CustomerQuotes, CustomerQuote and QuoteResponse; X6, F36;
// mantle.order.SalesPortalServices over SalesPortal.js, the SalesOrder kind's quote scopes in ExternalAccess.js): a quote's mail
// carries its recipient's bearer link to the organization's Sales mount; the link reads its one issue and its PDF and lists
// nothing; another customer's quote, a changed order ID, a forged token and a revised issue give the same nothing; a double submit
// gives one response and one placed order, a retry answering the first and another link's use of the key a conflict; a contact
// invited for the customer lists only its account's issued quotes; above the seller's acceptance threshold a bearer is refused and
// the signed-in contact accepts. Standalone: SalesQuoteIssueFixtures, a spec-local site.
// Run: ./moq test mr-mantle --spec SalesPortal
const fx = ec.resource.script("component://mr-mantle/test/order/SalesQuoteIssueFixtures.js")
const {system, as, make, one, revision, status, proposedQuote, key, call} = fx
const capture = ec.factory.getTool("MailCapture")
const P = "mantle.order.SalesPortalServices."
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
