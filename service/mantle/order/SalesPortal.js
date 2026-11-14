// PASS Sales: a customer's quotes and orders (mantle.order.SalesPortalServices, P of IronStone Sales design §12.1; design §10
// CustomerQuotes, CustomerQuote, QuoteResponse, CustomerOrders and CustomerOrder; impl-sales P13, P17, X6, F17, F36, F42, F48).
// CC0 1.0 Universal plus Grant of Patent License. The orders' rules are in the P17 block below.
//
// - Every operation first finds the organization the page serves: the sales mount's target on a published site, an internal
//   organization. Then who asks: a bearer link (ExternalAccess.check, the SalesOrder kind's QuoteView or QuoteRespond scope, bound
//   to one issue's revision by send#Quote), or a signed-in account acting for the quote's customer, as a contact invited for it to
//   the sales app (ExternalAccessContact) or as the customer's own party with a verified email (the self relationship). The
//   customer and organization come from the capability or the relationship, never from the request; an order ID beside a token
//   must be the token's.
// - A bearer link reaches its one issue while it stands (not ended, the quote Proposed at its revision, within its validity) and
//   its response's receipt once answered (a placement moving the revision does not end that; revise#Quote and withdraw#Quote
//   revoke the link, a native change supersedes the issue, the link ends with the validity). It never lists: find#CustomerQuotes
//   is a signed-in account's, over the issues of the customers it acts for. A contact's quote is its latest issue.
// - The answers are allow-listed projections: the offer's lines and totals as text (no cost, margin, price trace or internal
//   note), the seller's and rep's names, validity, the issue's PDF (streamed by the facade, its location never answered) and what
//   the page may do.
// - respond#CustomerQuote is the staff path's lifecycle (SalesQuoteIssues.js respondTo: the order locked, one response an issue,
//   place#Order once, a decline through Cancel Quote) with the customer's evidence (the capability or the signed-in account, the
//   acceptor's name and title, the PO) and an operation key bound to that identity, the organization, the issue and the payload
//   (F36), so a bearer's retry answers its own first result and another's key is a conflict. An acceptance names the revision
//   it saw and acknowledges the terms. Above the seller's acceptance threshold for the quote's currency (SalesPolicyThreshold,
//   unset by default; impl-sales §4) a bearer link alone cannot accept: the customer signs in as an invited contact (or as
//   the customer's own verified account).
// - Refusals are PASS error kinds (NotFound, AuthenticationRequired, Unprocessable, Conflict, Tarpit): a forged, expired, revoked
//   or another customer's link, a changed order ID and an ended offer all answer the same NotFound. Posts count against the
//   requester's limit; every token lookup does already (ExternalAccess.js).
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const issues = ec.resource.script("component://mr-mantle/service/mantle/order/SalesQuoteIssues.js")
const access = () => ec.resource.script("component://mr-mantle/service/mantle/party/ExternalAccess.js")
const apps = () => ec.resource.script("component://mr-mantle/service/mantle/public/PublicApps.js")
const {find, one, rows, ms} = lib

const ORDER = "mantle.order.OrderHeader"
const PART = "mantle.order.OrderPart"
const ISSUE = "mantle.sales.quote.SalesQuoteIssue"
const THRESHOLD = "mantle.sales.policy.SalesPolicyThreshold"
const RECORD_TYPE = "SalesOrder"
const POST_LIMIT = 30
const LIST_CAP = 50

const blank = value => value == null || String(value).trim() === ""
const text = value => (blank(value) ? null : String(value).trim())
const L = words => ec.l10n.localize(words)
const nowMs = () => Number(ms(ec.user.nowTimestamp))
const dayText = value => (value == null || value === "" ? "" : ec.l10n.format(new Date(Number(ms(value))), "d MMM yyyy"))
const dateText = value => (value == null || value === "" ? "" : ec.l10n.format(new Date(Number(ms(value))), "d MMM yyyy HH:mm"))
const partyName = partyId => (partyId ? lib.partyNames([partyId])[partyId] || partyId : "")
const fail = (kind, message) => {
    const error = new Error(message)
    error.moquiErrorKind = kind
    throw error
}
const unavailable = () => fail("NotFound", "This page is not available")
const signInRequired = () => fail("AuthenticationRequired", "Sign in to continue")
// A post counts against its requester's limit first (the framework's sign-in limits, as a token lookup does).
function throttle(kind, limit = POST_LIMIT) {
    const key = ec.resource.script("component://framework/service/org/moqui/public/Account.js").requesterKey()
    const allowed = ec.service
        .sync()
        .throwOnError(true)
        .name("org.moqui.public.AccountServices.record#Attempt")
        .parameters({input: {key: kind + ":" + key, limit, windowMillis: 600000}})
        .requireNewTransaction(true)
        .call().result.allowed
    if (!allowed) fail("Tarpit", "RATE_LIMITED: Too many attempts. Wait a few minutes and try again.")
}
// The page's request key (PASS operationId), as the operation key of the customer's response, kept apart from staff keys.
function operationKey(p) {
    const value = String(p.operationId || "")
    if (!/^[A-Za-z0-9_-]{8,32}$/.test(value)) fail("Unprocessable", "Reload the page and try again")
    return "sqp-" + value
}
// A refusal of a Mantle rule below the checks, as a page shows it (SupportPortal.js' pattern): an offer no longer open is not
// found, as an ended link is; a second, different response a conflict; the customer's own mistakes their message.
function refused(error) {
    if (error?.moquiErrorKind) throw error
    const first = String(error?.message || "")
        .split("\n")[0]
        .replace(/^(Error: )+/, "")
    const code = error?.reason || /^([A-Z][A-Z0-9_]+): /.exec(first)?.[1]
    if (!code) throw error
    ec.message.clearErrors()
    const message = first.replace(/^[A-Z][A-Z0-9_]+: /, "")
    if (
        [
            "RECORD_UNAVAILABLE",
            "PERMISSION_DENIED",
            "ISSUE_UNAVAILABLE",
            "ISSUE_ENDED",
            "ISSUE_SUPERSEDED",
            "ISSUE_EXPIRED",
            "QUOTE_NOT_PROPOSED"
        ].includes(code)
    )
        unavailable()
    if (code === "RESPONSE_EXISTS") fail("Conflict", "RESPONSE_RECORDED: This quote was answered already")
    if (code === "OPERATION_KEY_CONFLICT") fail("Conflict", "Reload the page and try again")
    fail("Unprocessable", message)
}

// ===== the organization and the asker =====
// The organization the Sales app of a published site serves (the sales mount's target, an internal organization).
function served(siteId) {
    const site = siteId && one("mantle.public.PublicSite", {siteId})
    if (!site || site.state !== "published") unavailable()
    const mount = apps().mount(siteId, "sales")
    if (!mount?.targetId || !one("mantle.party.PartyRole", {partyId: mount.targetId, roleTypeId: "OrgInternal"})) unavailable()
    return mount.targetId
}
// The customers of the organization a signed-in account acts for on the sales app: its contact grants and its own customer
// party through the self relationship. [] for a visitor.
function actingFor(organizationPartyId) {
    if (!ec.user.userId) return []
    return access()
        .actingParties(organizationPartyId, "sales", "Customer")
        .map(row => row.partyId)
}
// The quote's sales part (the seller's to the customer).
const salesPart = (orderId, organizationPartyId, customerPartyId) =>
    rows(PART, {orderId}).find(row => row.vendorPartyId === organizationPartyId && row.customerPartyId === customerPartyId) ||
    null
// The quote a request reaches and its issue: a token's issue at the revision its capability binds, standing or answered; a signed-in
// account's latest issue of a quote of a customer it acts for. {checked, order, part, issue, response, organizationPartyId,
// customerPartyId, signedIn}.
function quoteFor(p, organizationPartyId, scope) {
    const token = text(p.token)
    const orderId = text(p.orderId)
    if (!token && !orderId) unavailable()
    if (!token && !ec.user.userId) signInRequired()
    const checked = access().check({token, scope, recordType: RECORD_TYPE, recordId: token ? null : orderId, organizationPartyId})
    // a changed order ID beside a token gives nothing
    if (token && orderId && orderId !== checked.recordId) unavailable()
    const order = one(ORDER, {orderId: checked.recordId})
    const part = order ? salesPart(order.orderId, organizationPartyId, checked.partyId) : null
    if (!part) unavailable()
    const issueList = issues
        .issuesOf(order.orderId)
        .filter(row => row.customerPartyId === checked.partyId && row.organizationPartyId === organizationPartyId)
    const issue =
        checked.via === "token"
            ? issueList.find(
                  row => checked.recordRevision != null && Number(row.orderRevision) === Number(checked.recordRevision)
              )
            : issueList[0]
    if (!issue) unavailable()
    const response = issues.responseOf(issue.issueId)
    if (checked.via === "token" && !response && !issues.stands(issue, order)) unavailable()
    // P13 review: an unanswered quote whose revision moved past its latest issue (revised, or proposed again and not yet sent) shows
    // nothing to a signed-in contact either: its lines and totals are the seller's unissued work, not an offer
    if (!response && !issuedAsIs(issue, order)) unavailable()
    // signed in for the customer: the account reached the quote as its contact or its own party, or a link's reader acts for it
    const signedIn = checked.via !== "token" || actingFor(organizationPartyId).includes(checked.partyId)
    return {checked, order, part, issue, response, organizationPartyId, customerPartyId: checked.partyId, signedIn}
}
// Whether the order is still at its issue's revision and out of a revision's draft, so its lines and totals are the issue's.
const issuedAsIs = (issue, order) =>
    Number(issue.orderRevision) === Number(issues.revisionOf(order)) &&
    !["OrderOpen", "OrderBeingChanged"].includes(order.statusId)
// The seller's acceptance threshold for a currency (its SalesPolicy in effect), or null: unset by default.
function thresholdOf(organizationPartyId, currencyUomId) {
    const policy = issues.policyOf(organizationPartyId)
    if (!policy?.salesPolicyId || !currencyUomId) return null
    const row = rows(THRESHOLD, {salesPolicyId: policy.salesPolicyId}).find(found => found.currencyUomId === currencyUomId)
    return row?.thresholdAmount == null ? null : toDecimal(row.thresholdAmount)
}
// Whether accepting needs the customer signed in: the quote's total above the threshold, for a request not signed in for it.
function signInToAccept(q) {
    const threshold = thresholdOf(q.organizationPartyId, q.order.currencyUomId)
    return !!threshold && toDecimal(q.order.grandTotal ?? 0).compare(threshold) > 0 && !q.signedIn
}

// ===== the projections =====
const outcomeTexts = {
    placed: "Your order is placed. We will confirm it shortly.",
    approved: "Your order is confirmed.",
    held: "Your order is placed and waiting for us to review it.",
    declined: "You declined this quote. Thank you for letting us know."
}
function responseView(q) {
    const response = q.response
    if (!response) return null
    const result = issues.resultOf(response, one(ORDER, {orderId: q.order.orderId}))
    const accepted = response.responseTypeEnumId === "SqrAccept"
    return {
        responseId: response.responseId,
        accepted,
        responseText: accepted ? L("Accepted") : L("Declined"),
        respondedText: dateText(response.respondedDate),
        byText: response.responseSourceEnumId === "SqsPortal" ? L("You, online") : L("Recorded by us"),
        purchaseOrder: response.otherPartyOrderId || "",
        acceptorName: response.acceptorName || "",
        acceptorTitle: response.acceptorTitle || "",
        reason: accepted ? "" : response.reasonText || "",
        orderId: accepted ? q.order.orderId : null,
        outcome: result.outcome,
        message: L(outcomeTexts[result.outcome] || "")
    }
}
// The quote's state as the customer reads it: open, accepted, declined, or no longer open (ended, superseded, expired).
function stateOf(q) {
    if (q.response) return q.response.responseTypeEnumId === "SqrAccept" ? "accepted" : "declined"
    return issues.stands(q.issue, q.order) ? "open" : "closed"
}
const stateTexts = {open: "Open", accepted: "Accepted", declined: "Declined", closed: "No longer open"}
const fileNameOf = issue =>
    String(issue.contentLocation || "").substring(String(issue.contentLocation || "").lastIndexOf("/") + 1)
// P17 (F236): once accepted, a commercial change of the placed order moves its revision past the issue's; the quote's page then shows
// none of the changed order's lines or totals (the issued PDF stays the offer) and points to the order's page (CustomerOrder).
const changedSinceAccepted = q =>
    q.response?.responseTypeEnumId === "SqrAccept" && Number(q.issue.orderRevision) !== Number(issues.revisionOf(q.order))
const noOffer = {lines: [], productsText: "", shippingText: "", taxText: "", totalText: ""}
function quoteView(q) {
    const changed = changedSinceAccepted(q)
    const offer = changed ? noOffer : issues.offerOf(q.order)
    const map = issues.textMap(q.order, q.part, q.issue, "terms", "")
    const termsText = String(issues.storedText("quote", q.organizationPartyId, map) || "")
        .replace(/<\/p>|<br\s*\/?>/gi, "\n")
        .replace(/<[^>]*>/g, "")
        .replace(/&nbsp;/g, " ")
        .replace(/\n{3,}/g, "\n\n")
        .trim()
    const state = stateOf(q)
    const needsSignIn = state === "open" && signInToAccept(q)
    const policy = issues.policyOf(q.organizationPartyId)
    return {
        quote: {
            orderId: q.order.orderId,
            name: q.order.orderName || "",
            revision: Number(q.issue.orderRevision),
            sellerName: partyName(q.organizationPartyId),
            customerName: partyName(q.customerPartyId),
            repName: issues.ownerOf(q.order) ? partyName(issues.ownerOf(q.order)) : "",
            issuedText: dayText(q.issue.issuedDate),
            validThruText: dayText(q.issue.validThruDate),
            currencyUomId: q.order.currencyUomId || "",
            yourReference: q.part.otherPartyOrderId || "",
            lines: offer.lines.map(line => ({
                productText: line.productText,
                description: line.description,
                quantityText: line.quantityText,
                priceText: line.priceText,
                amountText: line.amountText
            })),
            productsText: offer.productsText,
            shippingText: offer.shippingText,
            taxText: offer.taxText,
            totalText: offer.totalText,
            termsText,
            state,
            stateText: L(stateTexts[state]),
            changedSinceAccepted: changed
        },
        document: q.issue.contentLocation ? {fileName: fileNameOf(q.issue)} : null,
        response: responseView(q),
        capabilities: {
            canAccept: state === "open" && !needsSignIn,
            canDecline: state === "open",
            signInToAccept: needsSignIn,
            poRequired: policy?.responsePoRequired === "Y"
        }
    }
}

// ===== the operations =====
// find#CustomerQuotes: a signed-in account's issued quotes of the customers it acts for at the organization (the latest issue of
// each), newest first; state open or all. Drafts, templates, other customers and unissued quotes are absent; the count obeys the
// same filter. Never a bearer link's.
function findCustomerQuotes(p) {
    const organizationPartyId = served(p.siteId)
    if (!ec.user.userId) signInRequired()
    const customers = actingFor(organizationPartyId)
    const limit = Math.min(Math.max(Number(p.limit) || 20, 1), LIST_CAP)
    const offset = Math.max(Number(p.cursor) || 0, 0)
    if (!customers.length) return {quoteList: [], count: 0, nextCursor: null, actingFor: 0}
    const found = Array.from(
        find(ISSUE)
            .condition("organizationPartyId", organizationPartyId)
            .condition("customerPartyId", "in", customers)
            .orderBy("-issuedDate")
            .limit(500)
            .list()
    )
    const latest = new Map()
    for (const issue of found) if (!latest.has(issue.orderId)) latest.set(issue.orderId, issue)
    const all = []
    for (const issue of latest.values()) {
        const order = one(ORDER, {orderId: issue.orderId})
        const part = order ? salesPart(order.orderId, organizationPartyId, issue.customerPartyId) : null
        if (!part || order.orderPurposeEnumId !== "OrpSalesQuote") continue
        const q = {order, part, issue, response: issues.responseOf(issue.issueId)}
        // P13 review: a quote revised past its latest issue and not yet sent again is not listed (its total is unissued work)
        if (!q.response && !issuedAsIs(issue, order)) continue
        const state = stateOf(q)
        if (p.state === "open" && state !== "open") continue
        all.push({
            orderId: order.orderId,
            name: order.orderName || "",
            customerName: customers.length > 1 ? partyName(issue.customerPartyId) : "",
            issuedText: dayText(issue.issuedDate),
            validThruText: dayText(issue.validThruDate),
            totalText: changedSinceAccepted(q) ? "" : issues.offerOf(order).totalText,
            state,
            stateText: L(stateTexts[state])
        })
    }
    const page = all.slice(offset, offset + limit)
    return {
        quoteList: page,
        count: all.length,
        nextCursor: offset + limit < all.length ? String(offset + limit) : null,
        actingFor: customers.length
    }
}
// get#CustomerQuote: the offer a link or a signed-in contact reaches, with its response and what the page may do.
function getCustomerQuote(p) {
    const organizationPartyId = served(p.siteId)
    return quoteView(quoteFor(p, organizationPartyId, "QuoteView"))
}
// get#QuoteDocument: the issue's stored PDF for the download (its location stays with the transport).
function getQuoteDocument(p) {
    const organizationPartyId = served(p.siteId)
    const q = quoteFor(p, organizationPartyId, "QuoteView")
    if (!q.issue.contentLocation) unavailable()
    return {file: {mimeType: "application/pdf", filename: fileNameOf(q.issue)}, location: q.issue.contentLocation}
}
// get#QuoteResponse: the receipt of the issue's response; not available before one.
function getQuoteResponse(p) {
    const organizationPartyId = served(p.siteId)
    const q = quoteFor(p, organizationPartyId, "QuoteView")
    if (!q.response) unavailable()
    const view = quoteView(q)
    return {quote: view.quote, document: view.document, response: view.response}
}
// respond#CustomerQuote (a bearer link's write, TOKEN_WRITES): the customer's acceptance (the revision seen, the terms
// acknowledged, the PO when the seller asks it, the acceptor's name and title) or decline (its reason), through the staff path's
// lifecycle with the customer's identity; the answer is the receipt. A repeat answers the first.
function respondCustomerQuote(p) {
    throttle("sales-quote-respond")
    const organizationPartyId = served(p.siteId)
    const key = operationKey(p)
    const action = text(p.action) || "accept"
    if (!["accept", "decline"].includes(action)) fail("Unprocessable", "Accept or decline the quote")
    const found = quoteFor(p, organizationPartyId, "QuoteRespond")
    // P13 review: the offer's checks (revision, terms, the threshold against the total) read the order under its lock, as
    // respondTo's do, so a change committed between the read and the lock is seen (design §10: eligibility revalidated under lock)
    const order = find(ORDER, {orderId: found.order.orderId}).forUpdate(true).one()
    const q = Object.assign({}, found, {order, response: issues.responseOf(found.issue.issueId)})
    // a repeat of an answered quote's request answers its receipt before the offer's checks (design §10 QuoteResponse)
    if (!q.response) {
        if (action === "accept") {
            if (blank(p.expectedRevision) || Number(p.expectedRevision) !== Number(q.issue.orderRevision))
                fail("Conflict", "STALE_REVISION: This quote changed since you opened it. Reload the page and try again.")
            if (!["Y", "true", true].includes(p.acknowledge))
                fail("Unprocessable", "Confirm that you accept the quote and its terms")
            // P13 review: the acceptor's name is the acceptance's evidence (design §10 AcceptQuote), required as the page requires it
            if (blank(p.acceptorName)) fail("Unprocessable", "ACCEPTOR_REQUIRED: Give your name to accept the quote")
            if (signInToAccept(q))
                fail(
                    "Unprocessable",
                    "ACCEPTANCE_SIGN_IN_REQUIRED: Sign in as a contact invited for your company to accept a quote of this amount"
                )
        }
    }
    const quote = {order, part: q.part, organizationPartyId, customerPartyId: q.customerPartyId}
    const ownParty = q.signedIn ? ec.user.userAccount?.partyId || null : null
    const result = issues.respondTo(
        quote,
        {
            responseType: action,
            otherPartyOrderId: action === "accept" ? text(p.purchaseOrder) : null,
            reason: action === "decline" ? text(p.reason) : null
        },
        {
            staff: false,
            operationType: "SalesQuotePortalRespond",
            operationKey: key,
            identity: q.checked.via === "token" ? "capability:" + q.checked.capabilityId : "party:" + ownParty,
            issueId: q.issue.issueId,
            contactPartyId: ownParty,
            capabilityId: q.checked.via === "token" ? q.checked.capabilityId : null,
            acceptorName: action === "accept" ? String(p.acceptorName || "").slice(0, 120) : null,
            acceptorTitle: action === "accept" ? String(p.acceptorTitle || "").slice(0, 120) : null
        }
    )
    const answered = Object.assign({}, q, {
        order: one(ORDER, {orderId: q.order.orderId}),
        response: issues.responseOf(q.issue.issueId)
    })
    const view = responseView(answered)
    return {
        alreadyApplied: !!result.alreadyApplied,
        orderId: q.order.orderId,
        response: view,
        receipt: {message: view?.message || ""}
    }
}
// check#SalesAppReadiness: the Sales app's checks of a site (PublicApps.js): its target an internal organization with Sales
// defaults and the commercial revision a quote's issue binds, and the site's canonical host, from which every link is made.
function appReadiness(p) {
    const organization = !!p.targetId && !!one("mantle.party.PartyRole", {partyId: p.targetId, roleTypeId: "OrgInternal"})
    const preference = organization
        ? lib.call("mantle.ledger.LedgerServices.find#PartyAcctgPreference", {organizationPartyId: p.targetId})
              .partyAcctgPreference
        : null
    return {
        checks: [
            {name: "organization", ready: organization},
            {name: "sales defaults", ready: organization && !!issues.policyOf(p.targetId)?.salesPolicyId},
            {name: "commercial revision", ready: organization && preference?.salesCommercialRevisionOnly === "Y"},
            {name: "canonical host", ready: !!apps().pageUrl(p.siteId, p.app || "sales", "/")}
        ]
    }
}
// get#AccountCard: the PASS Account hub's Quotes and orders card: the open quotes and (P17) open orders of the customers the account
// acts for; none for an account that acts for no customer here.
function accountCard(p) {
    const organizationPartyId = served(p.siteId)
    if (!ec.user.userId) signInRequired()
    const customers = actingFor(organizationPartyId)
    if (!customers.length) return null
    const open = findCustomerQuotes({siteId: p.siteId, state: "open", limit: LIST_CAP}).count
    const url = apps().pageUrl(p.siteId, "sales", "/CustomerQuotes")
    // P17: the open orders (not completed) and My orders
    const openOrders = findCustomerOrders({siteId: p.siteId, state: "open", limit: 1}).count
    const ordersUrl = apps().pageUrl(p.siteId, "sales", "/CustomerOrders")
    return {
        title: L("Quotes and orders"),
        lines: [
            open + " " + (open === 1 ? L("open quote") : L("open quotes")),
            openOrders + " " + (openOrders === 1 ? L("open order") : L("open orders"))
        ],
        url,
        links: [
            {text: L("My quotes"), url},
            {text: L("My orders"), url: ordersUrl}
        ]
    }
}

// ===== P17: a customer's orders (impl-sales P17; design-sales §10 CustomerOrders, CustomerOrder; SAL-R01, F42, F48) =====
// - Who: a bearer link (the SalesOrder kind's OrderView, made for each recipient of the storeless confirmation, SalesOrders.js
//   orderLink) reaches its one order and never lists; a signed-in account acting for the order's customer (a contact grant of the
//   sales app, or the customer's own verified party: actingFor) reaches every order of the customers it acts for and lists them.
// - What: a placed sales order of the site's organization to that customer, every part the seller's to it, with no store (a store
//   order's one public page is Shop's, F42) and not a recurring base or a template (F7); an order being changed, a cart, a quote
//   in progress and a cancelled or rejected order are not shown. Every miss is the same NotFound.
// - The answers: the lines and totals as text, promised dates, the accepted quote, shipments with tracking (a carrier's https link
//   only), invoices with their open amount (Billing's InvoicePay for a signed-in account where the site mounts Billing; the page
//   never takes payment), Support's pages for a change, cancel or return where the site mounts Support (each app checks its own
//   access), and the stored confirmation's PDF (streamed by the facade, its location never answered). Read only.
const CONTENT = "mantle.order.OrderContent"
const orderStatuses = ["OrderPlaced", "OrderProcessing", "OrderApproved", "OrderSent", "OrderCompleted", "OrderHold"]
const excludedPurposes = ["OrpRecurringTemplate", "OrpSalesQuoteTemplate"]
const cancellableStatuses = ["OrderPlaced", "OrderProcessing", "OrderApproved", "OrderHold"]
const issuedInvoices = ["InvoiceFinalized", "InvoiceSent", "InvoiceAcked", "InvoicePmtRecvd"]
const shownShipments = ["ShipPacked", "ShipShipped", "ShipDelivered"]
const openCaseStatuses = ["ReqSubmitted", "ReqReviewed", "ReqWaitingCustomer", "ReqInProgress"]
const orderStateTexts = {
    OrderPlaced: "Received",
    OrderProcessing: "Received",
    OrderApproved: "Confirmed",
    OrderSent: "Shipped",
    OrderCompleted: "Completed",
    OrderHold: "Received, being reviewed"
}
const ORDER_LIST_CAP = 500
const moneyText = (value, currencyUomId) =>
    value == null ? "" : ec.l10n.formatCurrency(ec.l10n.roundCurrency(toDecimal(value), currencyUomId), currencyUomId)
const statusName = statusId => (statusId ? one("moqui.basic.StatusItem", {statusId})?.description || "" : "")
const enumName = enumId => (enumId ? one("moqui.basic.Enumeration", {enumId})?.description || "" : "")
const httpsUrl = value => (/^https:\/\/[^\s"'<>]+$/i.test(String(value || "")) ? String(value) : null)
// The order's sales part when it is a customer's order of the organization as above, else null.
function customerOrderPart(order, organizationPartyId, customerPartyId) {
    if (!order || order.productStoreId || !order.placedDate || order.recurCronExpression) return null
    if (!orderStatuses.includes(order.statusId) || excludedPurposes.includes(order.orderPurposeEnumId)) return null
    const parts = rows(PART, {orderId: order.orderId}).sort((a, b) =>
        String(a.orderPartSeqId).localeCompare(String(b.orderPartSeqId))
    )
    if (
        !parts.length ||
        !parts.every(row => row.vendorPartyId === organizationPartyId && row.customerPartyId === customerPartyId)
    )
        return null
    return parts[0]
}
// The order a request reaches: a token's one order (OrderView), an order ID beside it the token's own; else a signed-in account's
// order of a customer it acts for. {order, part, organizationPartyId, customerPartyId, via, customers}.
function orderFor(p, organizationPartyId) {
    const token = text(p.token)
    const orderId = text(p.orderId)
    if (!token && !orderId) unavailable()
    if (!token && !ec.user.userId) signInRequired()
    let order
    let customerPartyId
    let customers = []
    if (token) {
        const checked = access().check({token, scope: "OrderView", recordType: RECORD_TYPE, organizationPartyId})
        if (orderId && orderId !== checked.recordId) unavailable()
        order = one(ORDER, {orderId: checked.recordId})
        customerPartyId = checked.partyId
    } else {
        order = one(ORDER, {orderId})
        customers = actingFor(organizationPartyId)
        customerPartyId = order
            ? rows(PART, {orderId: order.orderId}).find(row => customers.includes(row.customerPartyId))?.customerPartyId
            : null
        if (!customerPartyId) unavailable()
    }
    const part = customerOrderPart(order, organizationPartyId, customerPartyId)
    if (!part) unavailable()
    return {order, part, organizationPartyId, customerPartyId, via: token ? "token" : "account", customers}
}
const held = order =>
    order.statusId === "OrderHold" ||
    rows("mantle.order.OrderHoldReason", {orderId: order.orderId}).some(row => !row.releasedDate)
const orderStateText = order => L(held(order) ? orderStateTexts.OrderHold : orderStateTexts[order.statusId] || "")
// The order's shipments the customer may follow: packed, shipped or delivered, each with its carrier, tracking and items of this order.
function orderShipments(orderId) {
    const sources = rows("mantle.shipment.ShipmentItemSource", {orderId})
    const ids = [...new Set(sources.map(row => row.shipmentId))]
    if (!ids.length) return []
    return Array.from(
        find("mantle.shipment.Shipment")
            .condition("shipmentId", "in", ids)
            .condition("statusId", "in", shownShipments)
            .orderBy("shipmentId")
            .list()
    ).map(shipment => {
        const segments = rows("mantle.shipment.ShipmentRouteSegment", {shipmentId: shipment.shipmentId})
        const carrier = segments.find(row => row.carrierPartyId && row.carrierPartyId !== "_NA_")?.carrierPartyId
        const method = segments.find(row => row.shipmentMethodEnumId)?.shipmentMethodEnumId
        const arrival = segments.find(row => row.estimatedArrivalDate)?.estimatedArrivalDate
        const tracking = rows("mantle.shipment.ShipmentPackageRouteSeg", {shipmentId: shipment.shipmentId})
            .filter(row => row.trackingCode)
            .map(row => ({code: row.trackingCode, url: httpsUrl(row.trackingUrl)}))
        const items = sources
            .filter(row => row.shipmentId === shipment.shipmentId)
            .map(row => {
                const product = row.productId ? one("mantle.product.Product", {productId: row.productId}) : null
                return {
                    productText: product
                        ? [product.pseudoId || product.productId, product.productName].filter(Boolean).join(" · ")
                        : "",
                    quantityText: row.quantity == null ? "" : ec.l10n.format(toDecimal(row.quantity), "#,##0.###")
                }
            })
        return {
            shipmentId: shipment.shipmentId,
            statusText: statusName(shipment.statusId),
            shipped: ["ShipShipped", "ShipDelivered"].includes(shipment.statusId),
            delivered: shipment.statusId === "ShipDelivered",
            shippedText: dayText(shipment.shipDate || shipment.estimatedShipDate),
            arrivalText: shipment.statusId === "ShipDelivered" ? "" : dayText(arrival || shipment.estimatedArrivalDate),
            carrierText: [carrier ? partyName(carrier) : "", enumName(method)].filter(Boolean).join(" · "),
            tracking,
            items
        }
    })
}
// The order's issued invoices of the organization to the customer, with their open amount, and Billing's page for a signed-in
// account where the site's Billing serves the organization (Billing checks its own access; a link's reader pays from the invoice's
// own link).
function orderInvoices(o, siteId) {
    const ids = [...new Set(rows("mantle.order.OrderItemBilling", {orderId: o.order.orderId}).map(row => row.invoiceId))]
    if (!ids.length) return []
    const billingMount = o.via === "account" ? apps().mount(siteId, "billing") : null
    const billing = billingMount?.targetId === o.organizationPartyId
    return Array.from(
        find("mantle.account.invoice.Invoice")
            .condition("invoiceId", "in", ids)
            .condition("statusId", "in", issuedInvoices)
            .condition("fromPartyId", o.organizationPartyId)
            .condition("toPartyId", o.customerPartyId)
            .orderBy("invoiceDate")
            .list()
    ).map(invoice => {
        const totals = lib.call("mantle.account.InvoiceServices.get#InvoiceTotal", {invoiceId: invoice.invoiceId})
        const open = toDecimal(totals.unpaidTotal ?? 0)
        return {
            invoiceId: invoice.invoiceId,
            invoiceDateText: dayText(invoice.invoiceDate),
            dueText: dayText(invoice.dueDate),
            totalText: moneyText(totals.invoiceTotal ?? 0, invoice.currencyUomId),
            openText: open.compare(0) > 0 ? moneyText(open, invoice.currencyUomId) : "",
            paid: open.compare(0) <= 0,
            billingUrl: billing
                ? apps().pageUrl(siteId, "billing", "/InvoicePay?invoiceId=" + encodeURIComponent(invoice.invoiceId))
                : null
        }
    })
}
// Support's pages for this order where the site mounts Support (RequestReturn, NewCustomerCase with the order and its
// OrderCancelRequest), and whether a cancellation request is open; Support checks its own access (a link's reader through the order
// link the page keeps in its session, as Shop's guest's).
function orderActions(o, siteId) {
    // (a mount serving this organization: another organization's Support or Billing would not know the order)
    const support = apps().mount(siteId, "support")?.targetId === o.organizationPartyId
    const supportUrl = path => (support ? apps().pageUrl(siteId, "support", path) : null)
    const openCancel = rows("mantle.request.Request", {
        orderId: o.order.orderId,
        requestTypeEnumId: "RqtOrderChange",
        orderChangeKindEnumId: "OckCancel"
    }).some(row => openCaseStatuses.includes(row.statusId))
    const q = "?orderId=" + encodeURIComponent(o.order.orderId)
    return {
        askUrl: supportUrl("/NewCustomerCase" + q),
        requestCancelUrl:
            cancellableStatuses.includes(o.order.statusId) && !openCancel
                ? supportUrl("/NewCustomerCase" + q + "#OrderCancelRequest")
                : null,
        requestReturnUrl: orderShipments(o.order.orderId).some(row => row.shipped) ? supportUrl("/RequestReturn" + q) : null,
        cancellationRequested: openCancel
    }
}
// The order's confirmation as placed (Customer Service's stored PDF, OctOrderConfirmation, the one the confirmation mail attached),
// or null: never made here.
const orderDocument = orderId =>
    rows(CONTENT, {orderId, orderContentTypeEnumId: "OctOrderConfirmation"}).sort(
        (a, b) => Number(ms(a.contentDate)) - Number(ms(b.contentDate))
    )[0] || null
const contentFileName = location => String(location || "").substring(String(location || "").lastIndexOf("/") + 1)
// The quote the order was accepted from (a placed quote: its accepted issue and response), or null.
function acceptedQuoteOf(order) {
    if (order.orderPurposeEnumId !== "OrpSalesQuote") return null
    for (const issue of issues.issuesOf(order.orderId)) {
        const response = issues.responseOf(issue.issueId)
        if (response?.responseTypeEnumId === "SqrAccept")
            return {
                orderId: order.orderId,
                revision: Number(issue.orderRevision),
                issuedText: dayText(issue.issuedDate),
                acceptedText: dateText(response.respondedDate),
                purchaseOrder: response.otherPartyOrderId || ""
            }
    }
    return null
}
function orderLines(order) {
    const offer = issues.offerOf(order)
    return {
        lines: offer.lines.map(line => ({
            productText: line.productText,
            description: line.description,
            quantityText: line.quantityText,
            priceText: line.priceText,
            amountText: line.amountText,
            promisedText: line.requiredText || ""
        })),
        productsText: offer.productsText,
        shippingText: offer.shippingText,
        taxText: offer.taxText,
        totalText: offer.totalText
    }
}
// The delivery and billing states of an order in words, for the list.
function deliveryText(orderId) {
    const shipments = orderShipments(orderId)
    if (!shipments.length) return L("Not shipped yet")
    if (shipments.every(row => row.delivered)) return L("Delivered")
    return shipments.some(row => row.shipped) ? L("Shipped") : L("Being prepared")
}
function billingText(o, siteId) {
    const invoices = orderInvoices(o, siteId)
    if (!invoices.length) return L("Not invoiced yet")
    const open = invoices.filter(row => !row.paid)
    return open.length ? L("Open") + ": " + open.map(row => row.openText).join(", ") : L("Paid")
}
function orderView(o, siteId) {
    const order = o.order
    const part = o.part
    const document = orderDocument(order.orderId)
    const quote = acceptedQuoteOf(order)
    return {
        order: Object.assign(
            {
                orderId: order.orderId,
                name: order.orderName || "",
                sellerName: partyName(o.organizationPartyId),
                customerName: partyName(o.customerPartyId),
                repName: issues.ownerOf(order) ? partyName(issues.ownerOf(order)) : "",
                placedText: dayText(order.placedDate),
                stateText: orderStateText(order),
                purchaseOrder: part.otherPartyOrderId || "",
                currencyUomId: order.currencyUomId || "",
                shipByText: dayText(part.estimatedShipDate || part.shipBeforeDate),
                deliveryByText: dayText(part.estimatedDeliveryDate)
            },
            orderLines(order)
        ),
        acceptedQuote: quote,
        shipments: orderShipments(order.orderId),
        invoices: orderInvoices(o, siteId),
        document: document ? {fileName: contentFileName(document.contentLocation)} : null,
        actions: orderActions(o, siteId),
        // a signed-in account opens the accepted quote's page by its order; a link's reader has no quote link
        capabilities: {quoteLink: !!quote && o.via === "account"}
    }
}
// find#CustomerOrders: a signed-in account's orders of the customers it acts for at the organization, newest first; state open
// (not completed) or all; reference matches the order or the customer's PO, ignoring case. Never a bearer link's.
function findCustomerOrders(p) {
    const organizationPartyId = served(p.siteId)
    if (!ec.user.userId) signInRequired()
    const customers = actingFor(organizationPartyId)
    const limit = Math.min(Math.max(Number(p.limit) || 20, 1), LIST_CAP)
    const offset = Math.max(Number(p.cursor) || 0, 0)
    if (!customers.length) return {orderList: [], count: 0, nextCursor: null, actingFor: 0}
    // the candidates by the order's header and part together, newest first, so the cap never fills with a store's orders, drafts
    // or older orders (Sales P17 review)
    const statuses = p.state === "open" ? orderStatuses.filter(id => id !== "OrderCompleted") : orderStatuses
    const partFind = find("mantle.order.OrderHeaderAndPart")
        .condition("vendorPartyId", organizationPartyId)
        .condition("customerPartyId", "in", customers)
        .condition("productStoreId", "is-null", null)
        .condition("statusId", "in", statuses)
        .condition("placedDate", "is-not-null", null)
    const reference = text(String(p.reference ?? "").slice(0, 60))
    if (reference) {
        const like = "%" + reference.replace(/[\\%_]/g, character => "\\" + character) + "%"
        const ecf = ec.entity.conditionFactory
        partFind.condition(
            ecf.makeCondition(
                [
                    ecf.makeCondition("orderId", "like", like).ignoreCase(),
                    ecf.makeCondition("otherPartyOrderId", "like", like).ignoreCase()
                ],
                "or"
            )
        )
    }
    const ids = [
        ...new Set(
            Array.from(
                partFind
                    .selectField("orderId")
                    .orderBy("-placedDate")
                    .orderBy("-orderId")
                    .limit(ORDER_LIST_CAP * 2)
                    .list()
            ).map(row => row.orderId)
        )
    ]
    if (!ids.length) return {orderList: [], count: 0, nextCursor: null, actingFor: customers.length}
    const orders = Array.from(
        find(ORDER)
            .condition("orderId", "in", ids)
            .condition("productStoreId", "is-null", null)
            .condition("statusId", "in", statuses)
            .orderBy("-placedDate")
            .orderBy("-orderId")
            .limit(ORDER_LIST_CAP)
            .list()
    )
    const all = []
    for (const order of orders) {
        const customerPartyId = rows(PART, {orderId: order.orderId}).find(row =>
            customers.includes(row.customerPartyId)
        )?.customerPartyId
        const part = customerOrderPart(order, organizationPartyId, customerPartyId)
        if (part) all.push({order, part, organizationPartyId, customerPartyId, via: "account"})
    }
    const page = all.slice(offset, offset + limit).map(o => ({
        orderId: o.order.orderId,
        name: o.order.orderName || "",
        customerName: customers.length > 1 ? partyName(o.customerPartyId) : "",
        placedText: dayText(o.order.placedDate),
        purchaseOrder: o.part.otherPartyOrderId || "",
        totalText: moneyText(o.order.grandTotal ?? 0, o.order.currencyUomId),
        stateText: orderStateText(o.order),
        deliveryText: deliveryText(o.order.orderId),
        billingText: billingText(o, p.siteId)
    }))
    return {
        orderList: page,
        count: all.length,
        nextCursor: offset + limit < all.length ? String(offset + limit) : null,
        actingFor: customers.length
    }
}
// get#CustomerOrder: the order a link or a signed-in account reaches: what was ordered, its delivery and billing, read only.
function getCustomerOrder(p) {
    const organizationPartyId = served(p.siteId)
    return orderView(orderFor(p, organizationPartyId), p.siteId)
}
// get#OrderDocument: the order's stored confirmation as placed for the download (its location stays with the transport).
function getOrderDocument(p) {
    const organizationPartyId = served(p.siteId)
    const o = orderFor(p, organizationPartyId)
    const document = orderDocument(o.order.orderId)
    if (!document?.contentLocation) unavailable()
    return {
        file: {mimeType: "application/pdf", filename: contentFileName(document.contentLocation)},
        location: document.contentLocation
    }
}

const operations = {
    findCustomerQuotes,
    getCustomerQuote,
    getQuoteDocument,
    getQuoteResponse,
    respondCustomerQuote,
    appReadiness,
    accountCard,
    // P17
    findCustomerOrders,
    getCustomerOrder,
    getOrderDocument
}
const internalOperations = new Set(["appReadiness"])
;({
    served,
    // the PASS operations check the asker first; Mantle's reads and writes below them run without artifact authorization, and a
    // refusal of a Mantle rule is the page's error kind
    execute(op, input) {
        if (!operations[op]) fail("NotFound", "Unknown sales portal operation")
        const wasDisabled = ec.artifactExecution.disableAuthz()
        try {
            return operations[op](input || {})
        } catch (error) {
            if (internalOperations.has(op)) throw error
            refused(error)
        } finally {
            if (!wasDisabled) ec.artifactExecution.enableAuthz()
        }
    }
})
