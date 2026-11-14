// A quote's issue, send and the customer's response (mantle.order.SalesQuoteIssueServices, Q of IronStone Sales design §12.1;
// design §5 OrderDetail's quote context and QuoteBatch, §13.2, §16; impl-sales P10, F9, F10, F16, F70, F151, F166).
//
// - propose#Quote (P9's approval guard, P10's issue checks): one seller, customer and currency on every part; each product line
//   still usable for selling and priced; a validity that ends in the future; the tax current (F151: a storeless quote of a gateway
//   seller with no address of its own takes the customer's now, refused once so the rep sees the new total); every approval current;
//   then the native propose#Order.
// - send#Quote issues a proposed quote at its commercial revision, only where the seller's salesCommercialRevisionOnly is on (F9;
//   COMMERCIAL_REVISION_OFF otherwise): the PDF rendered and stored as an OrderContent (OctSalesQuoteIssued) and a SalesQuoteIssue
//   with its validity. A send to more recipients, or again, reuses the issue standing at the revision: a resend is a delivery, not
//   another issue. Each recipient (the customer or one of its current contacts) gets the quote either from the rep's own mail account
//   (the quote's owner: a mail client draft with the PDF attached, sent through send#EmailDraft and filed on the order) or from the
//   organization through the delivery ledger (X8: send#EmailTemplate with MANTLE_SALES_QUOTE or the organization's template, one
//   delivery per issue and recipient, its build making the message fresh at each attempt). A recipient already sent to is skipped; a
//   failed one is tried again, so a second send retries only what failed and keeps the one issue.
// - The text of the mail and of the print's cover and terms is the organization's stored .html.fancy-locked resource
//   (SalesPolicy.quoteTextLocation, else Mantle's default), rendered with an explicit map (F70); the print itself is a trusted
//   .html.fancy. No cost or margin is read here.
// - An issue stands while it is not ended, the order is Proposed at its revision and its validity has not passed. revise#Quote moves
//   a proposed quote to Being changed and counts a commercial revision, so its approvals and issue end (the PDF stays);
//   withdraw#Quote cancels it (Cancel Quote) and ends the issue; respond#Quote records the customer's acceptance (place#Order, once,
//   its result placed, approved or held) or decline (Cancel Quote), under the order's lock, one response for an issue, the same key
//   or a second acceptance answering the first.
// - Each verb checks SALES_QUOTE_EDIT on a quote the caller sees (SalesAccess.js requireQuote), and send also SALES_QUOTE_SEND;
//   every write names the revision read (or the issue) and carries an operation key where a retry must answer the first result.
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const salesAccess = ec.resource.script("component://mr-mantle/service/mantle/sales/SalesAccess.js")
const {find, one, rows, denied, call, ms} = lib
const approvals = () => ec.resource.script("component://mr-mantle/service/mantle/order/SalesApprovals.js")
const confirmations = () => ec.resource.script("component://mr-mantle/service/mantle/order/OrderConfirmations.js")

const ORDER = "mantle.order.OrderHeader"
const PART = "mantle.order.OrderPart"
const ITEM = "mantle.order.OrderItem"
const PART_PARTY = "mantle.order.OrderPartParty"
const CONTENT = "mantle.order.OrderContent"
const EMAIL = "mantle.order.OrderEmailMessage"
const ISSUE = "mantle.sales.quote.SalesQuoteIssue"
const RESPONSE = "mantle.sales.quote.SalesQuoteResponse"
const DELIVERY = "mantle.party.MessageDelivery"
const ORDER_LINK = "mantle.sales.opportunity.SalesOpportunityOrder"
const contentType = "OctSalesQuoteIssued"
const sources = {quote: "MdsrcSalesQuote", reminder: "MdsrcSalesQuoteReminder"}
const templates = {quote: "MANTLE_SALES_QUOTE", reminder: "MANTLE_SALES_QUOTE_REMINDER"}
const textLocations = {
    quote: "component://mr-mantle/template/order/SalesQuoteText.html.fancy-locked",
    reminder: "component://mr-mantle/template/order/SalesQuoteReminder.html.fancy-locked"
}
const printLocation = "component://mr-mantle/template/order/SalesQuote.print.html.fancy"
const emailLocation = "component://mr-mantle/template/order/SalesQuoteEmail.html.fancy"
const draftStatuses = ["OrderOpen", "OrderBeingChanged"]
const taxTypes = ["ItemSalesTax", "ItemVatTax"]
const contactRelationships = ["PrtContact", "PrtEmployee", "PrtRepresentative"]
const addressPurposes = ["PostalShippingDest", "PostalBilling", "PostalPrimary"]
const responseTypes = {accept: "SqrAccept", decline: "SqrDecline"}
const ends = {revised: "SqeRevised", withdrawn: "SqeWithdrawn", declined: "SqeDeclined", superseded: "SqeSuperseded"}
const dayMs = 24 * 60 * 60 * 1000

const blank = value => value == null || String(value).trim() === ""
const text = value => (blank(value) ? null : String(value).trim())
const flag = value => value === true || value === "true" || value === "Y"
const L = value => ec.l10n.localize(value)
const nowMs = () => ms(ec.user.nowTimestamp)
const revisionOf = order => Number(order?.orderRevision ?? 1)
const partyName = partyId => (partyId ? lib.partyNames([partyId])[partyId] || partyId : "")
const dayText = value => (value == null || value === "" ? "" : ec.l10n.format(new Date(ms(value)), "d MMM yyyy"))
const moneyText = (value, currencyUomId) =>
    value == null ? "" : ec.l10n.formatCurrency(ec.l10n.roundCurrency(toDecimal(value), currencyUomId), currencyUomId)
const quantityText = value => (value == null ? "" : ec.l10n.format(toDecimal(value), "#,##0.###"))
const statusText = statusId => (statusId ? one("moqui.basic.StatusItem", {statusId})?.description || statusId : "")
const enumText = enumId => (enumId ? one("moqui.basic.Enumeration", {enumId})?.description || enumId : "")
const userName = userId => {
    if (!userId) return ""
    const account = one("moqui.security.UserAccount", {userId})
    return account?.userFullName || account?.username || userId
}
const listOf = value =>
    value == null
        ? []
        : typeof value === "string"
          ? value
                .split(",")
                .map(item => item.trim())
                .filter(Boolean)
          : Array.from(value)
                .map(item => String(item).trim())
                .filter(Boolean)
const reasonCodeOf = error => lib.reasonCode(error) || /\b([A-Z][A-Z0-9_]{2,}):/.exec(String(error?.message || ""))?.[1] || null

function requireRevision(order, given) {
    if (blank(given)) denied("REVISION_REQUIRED", "Reload the quote and try again (revision " + revisionOf(order) + ")")
    if (Number(given) !== revisionOf(order))
        denied("REVISION_CHANGED", "Quote " + order.orderId + " changed; its current revision is " + revisionOf(order))
}
// The quote the caller may change (SALES_QUOTE_EDIT on a quote they see), read again under the order's lock when asked.
function editableQuote(userScope, orderId, lock = false) {
    const quote = salesAccess.requireQuote(userScope, text(orderId), true)
    if (lock) quote.order = find(ORDER, {orderId: quote.order.orderId}).forUpdate(true).one()
    return quote
}
function policyOf(organizationPartyId) {
    return approvals().policyOf(organizationPartyId) || {}
}
// The seller's effective commercial revision flag (X2, F9; a parent organization's preference when it has none of its own).
function commercialRevisionOn(organizationPartyId) {
    const found = call("mantle.ledger.LedgerServices.find#PartyAcctgPreference", {organizationPartyId}).partyAcctgPreference
    return found?.salesCommercialRevisionOnly === "Y"
}
function ownerOf(order) {
    return rows(PART_PARTY, {orderId: order.orderId, roleTypeId: salesAccess.quoteRoles.owner})[0]?.partyId || null
}
function contactOf(order) {
    return rows(PART_PARTY, {orderId: order.orderId, roleTypeId: salesAccess.quoteRoles.contact})[0]?.partyId || null
}

// ===== issues =====
const issuesOf = orderId => rows(ISSUE, {orderId}).sort((a, b) => (ms(b.issuedDate) ?? 0) - (ms(a.issuedDate) ?? 0))
const responseOf = issueId => rows(RESPONSE, {issueId})[0] || null
// Whether an issue stands now: not ended, no response, the order Proposed at its revision, its validity not passed.
function stands(issue, order, at = nowMs()) {
    if (!issue || issue.endedDate || responseOf(issue.issueId)) return false
    if (order.statusId !== "OrderProposed" || Number(issue.orderRevision) !== revisionOf(order)) return false
    const thru = ms(issue.validThruDate)
    return thru == null || thru > at
}
function standingIssue(order) {
    return issuesOf(order.orderId).find(issue => stands(issue, order)) || null
}
// An issue's state in words: accepted or declined (its response), ended (why), superseded (a later revision), expired, current.
function issueState(issue, order) {
    const response = responseOf(issue.issueId)
    if (response) return response.responseTypeEnumId === responseTypes.accept ? "accepted" : "declined"
    if (issue.endedDate) return issue.endReasonEnumId === ends.withdrawn ? "withdrawn" : "ended"
    if (Number(issue.orderRevision) !== revisionOf(order)) return "superseded"
    const thru = ms(issue.validThruDate)
    if (thru != null && thru <= nowMs()) return "expired"
    return order.statusId === "OrderProposed" ? "current" : "ended"
}
const stateTexts = {
    current: "Current",
    accepted: "Accepted",
    declined: "Declined",
    withdrawn: "Withdrawn",
    ended: "Ended",
    superseded: "Superseded by a later revision",
    expired: "Expired"
}
// The issues standing on an order that a revision, withdrawal or decline ends (with who, when and why).
function endIssues(order, reasonEnumId, note) {
    let ended = 0
    for (const issue of rows(ISSUE, {orderId: order.orderId}).filter(row => !row.endedDate)) {
        call("update#" + ISSUE, {
            issueId: issue.issueId,
            endedDate: ec.user.nowTimestamp,
            endReasonEnumId: Number(issue.orderRevision) === revisionOf(order) ? reasonEnumId : ends.superseded,
            endedByUserId: ec.user.userId,
            endNote: text(note)
        })
        ended++
    }
    return ended
}

// ===== recipients =====
// The current email of a party: its primary email, else any current email.
function emailOf(partyId) {
    const mechRows = rows("mantle.party.contact.PartyContactMech", {partyId}).filter(row => lib.active(row))
    if (!mechRows.length) return null
    const mechs = Object.fromEntries(
        Array.from(
            find("mantle.party.contact.ContactMech")
                .condition(
                    "contactMechId",
                    "in",
                    mechRows.map(row => row.contactMechId)
                )
                .condition("contactMechTypeEnumId", "CmtEmailAddress")
                .list()
        ).map(mech => [mech.contactMechId, mech])
    )
    const ordered = mechRows
        .filter(row => mechs[row.contactMechId])
        .sort((a, b) => (b.contactMechPurposeId === "EmailPrimary" ? 1 : 0) - (a.contactMechPurposeId === "EmailPrimary" ? 1 : 0))
    return text(mechs[ordered[0]?.contactMechId]?.infoString)
}
// Who a quote may go to: the customer and its current contacts, employees and representatives, each with its current email.
function recipientOptions(customerPartyId) {
    const partyIds = [customerPartyId]
    for (const row of rows("mantle.party.PartyRelationship", {toPartyId: customerPartyId}))
        if (contactRelationships.includes(row.relationshipTypeEnumId) && lib.active(row) && !partyIds.includes(row.fromPartyId))
            partyIds.push(row.fromPartyId)
    const names = lib.partyNames(partyIds)
    return partyIds.map(partyId => ({
        partyId,
        name: names[partyId] || partyId,
        emailAddress: emailOf(partyId),
        customer: partyId === customerPartyId
    }))
}
// The recipients a send names (recipientPartyIds), else the quote's contact, else the customer; each one of recipientOptions.
function chosenRecipients(quote, given) {
    const options = recipientOptions(quote.customerPartyId)
    let ids = listOf(given)
    if (!ids.length) {
        const contact = contactOf(quote.order)
        ids = [contact && options.some(option => option.partyId === contact) ? contact : quote.customerPartyId]
    }
    const chosen = []
    for (const partyId of Array.from(new Set(ids))) {
        const option = options.find(row => row.partyId === partyId)
        if (!option) denied("RECIPIENT_INVALID", partyName(partyId) + " is not the customer or one of its contacts")
        chosen.push(option)
    }
    return {options, chosen}
}
// The mail account the caller may send from as themselves, or null.
function ownAccount(emailAccountId) {
    let access
    try {
        access = call("org.moqui.mail.EmailClientServices.get#EmailAccountAccess")
    } catch (error) {
        ec.message.clearErrors()
        return null
    }
    const sendable = Array.from(access.accountList || []).filter(account => account.canSend)
    return blank(emailAccountId) ? sendable[0] || null : sendable.find(row => row.emailAccountId === emailAccountId) || null
}

// ===== the print and the text =====
// The organization's stored text (quote or reminder) rendered locked with its explicit map; an unknown location renders empty.
function storedText(kind, organizationPartyId, map) {
    const policy = policyOf(organizationPartyId)
    const location = text(kind === "reminder" ? policy.reminderTextLocation : policy.quoteTextLocation) || textLocations[kind]
    try {
        if (!ec.resource.getLocationReference(location).getExists()) return ""
        return ec.resource.template(location, map) || ""
    } catch (error) {
        ec.logger.error(
            "The " + kind + " text of " + organizationPartyId + " at " + location + " did not render: " + error.message
        )
        return ""
    }
}
function addressText(contactMechId) {
    const address = contactMechId ? one("mantle.party.contact.PostalAddress", {contactMechId}) : null
    if (!address) return ""
    return [address.toName, address.address1, address.address2, [address.city, address.postalCode].filter(Boolean).join(" ")]
        .filter(Boolean)
        .join(", ")
}
// The map the locked text sees (only these names, F70).
function textMap(order, part, issue, part2) {
    const contact = contactOf(order)
    return {
        part: part2 || "cover",
        quoteId: order.orderId,
        quoteName: order.orderName || "",
        customerName: partyName(part.customerPartyId),
        contactName: contact ? partyName(contact) : "",
        sellerName: partyName(part.vendorPartyId),
        repName: ownerOf(order) ? partyName(ownerOf(order)) : "",
        issuedText: issue ? dayText(issue.issuedDate) : "",
        validThruText: dayText(issue ? issue.validThruDate : part.validThruDate),
        totalText: moneyText(order.grandTotal ?? 0, order.currencyUomId),
        // the PASS quote link comes with PASS Sales (impl-sales P13); none until then
        linkUrl: ""
    }
}
// The quote's print as it is now: the lines, the totals by kind, the cover and terms; draft Y when it is not an issue's.
function printOf(order, part, issue) {
    const currencyUomId = order.currencyUomId
    const items = rows(ITEM, {orderId: order.orderId}).sort((a, b) =>
        String(a.orderItemSeqId).localeCompare(String(b.orderItemSeqId))
    )
    const totals = {products: toDecimal(0), shipping: toDecimal(0), tax: toDecimal(0)}
    const lines = []
    for (const item of items) {
        const amount = toDecimal(item.quantity ?? 1).multiply(toDecimal(item.unitAmount ?? 0))
        if (taxTypes.includes(item.itemTypeEnumId)) {
            totals.tax = totals.tax.add(amount)
            continue
        }
        if (item.itemTypeEnumId === "ItemShipping") totals.shipping = totals.shipping.add(amount)
        else totals.products = totals.products.add(amount)
        if (item.parentItemSeqId) continue
        const product = item.productId ? one("mantle.product.Product", {productId: item.productId}) : null
        lines.push({
            seq: item.orderItemSeqId,
            productText: product
                ? [product.pseudoId || product.productId, product.productName].filter(Boolean).join(" · ")
                : item.itemDescription || "",
            description:
                product && item.itemDescription && item.itemDescription !== product.productName ? item.itemDescription : "",
            quantityText: quantityText(item.quantity ?? 1),
            priceText: moneyText(item.unitAmount ?? 0, currencyUomId),
            amountText: moneyText(amount, currencyUomId),
            requiredText: dayText(item.requiredByDate)
        })
    }
    const map = textMap(order, part, issue)
    const printHtml = ec.resource.template(printLocation, {
        orderId: order.orderId,
        orderName: order.orderName || "",
        revisionText: L("Revision") + " " + revisionOf(order),
        organizationName: partyName(part.vendorPartyId),
        customerName: partyName(part.customerPartyId),
        contactName: map.contactName,
        ownerName: map.repName,
        customerReference: part.otherPartyOrderId || "",
        issuedText: issue ? dayText(issue.issuedDate) : "",
        validThruText: dayText(issue ? issue.validThruDate : part.validThruDate),
        shipToText: addressText(part.postalContactMechId),
        currencyText: currencyUomId || "",
        productsText: moneyText(totals.products, currencyUomId),
        shippingText: totals.shipping.isZero() ? "" : moneyText(totals.shipping, currencyUomId),
        taxText: totals.tax.isZero() ? "" : moneyText(totals.tax, currencyUomId),
        totalText: moneyText(order.grandTotal ?? 0, currencyUomId),
        coverHtml: storedText("quote", part.vendorPartyId, Object.assign({}, map, {part: "cover"})),
        termsHtml: storedText("quote", part.vendorPartyId, Object.assign({}, map, {part: "terms"})),
        linkUrl: "",
        qrSvg: "",
        draft: issue ? "N" : "Y",
        lines
    })
    return {printHtml, fileName: "Quote-" + order.orderId + "-r" + revisionOf(order) + ".pdf"}
}
// get#QuotePrint: the quote as it is now (an issue's stored PDF is its own document, get#QuoteIssueDocument).
function quotePrint(p) {
    const userScope = salesAccess.scope()
    const quote = salesAccess.requireQuote(userScope, text(p.orderId))
    const printed = printOf(quote.order, quote.part, standingIssue(quote.order))
    return {orderId: quote.order.orderId, printHtml: printed.printHtml, fileName: printed.fileName}
}
// get#QuoteIssueDocument: an issue's stored PDF location, for one who sees the quote.
function issueDocument(p) {
    const userScope = salesAccess.scope()
    const quote = salesAccess.requireQuote(userScope, text(p.orderId))
    const issue = one(ISSUE, {issueId: text(p.issueId) || "-"})
    if (!issue || issue.orderId !== quote.order.orderId || !issue.contentLocation)
        denied("RECORD_UNAVAILABLE", "That issue of quote " + quote.order.orderId + " is not available")
    return {
        contentLocation: issue.contentLocation,
        fileName: String(issue.contentLocation).substring(String(issue.contentLocation).lastIndexOf("/") + 1)
    }
}

// ===== propose#Quote =====
// The customer's postal address for the quote (shipping, else billing, else primary), current.
function customerAddress(partyId) {
    const found = rows("mantle.party.contact.PartyContactMech", {partyId}).filter(row => lib.active(row))
    for (const wanted of addressPurposes) {
        const row = found.find(candidate => candidate.contactMechPurposeId === wanted)
        if (row) return row.contactMechId
    }
    return null
}
// F151: a storeless quote of a gateway seller with no address of its own is taxed at the customer's address once it has one; the
// address is set in a transaction of its own (X1 retaxes the part) so it stays when the proposal is then refused for the rep to
// see the new total. A storeless quote with no address at all is refused: an issue goes out taxed or not at all.
function refreshTax(quote) {
    if (quote.order.productStoreId) return
    if (!call("mantle.other.TaxServices.check#OrderTaxGateway", {orderId: quote.order.orderId}).taxed) return
    if (quote.part.postalContactMechId) return
    const contactMechId = customerAddress(quote.customerPartyId)
    if (!contactMechId)
        denied("ADDRESS_REQUIRED", "The customer has no address to tax the quote at; add one, then choose it in Edit quote")
    lib.probe("update#" + PART, {
        orderId: quote.order.orderId,
        orderPartSeqId: quote.part.orderPartSeqId,
        postalContactMechId: contactMechId
    })
    const order = one(ORDER, {orderId: quote.order.orderId})
    denied(
        "TAX_UPDATED",
        "Quote " +
            quote.order.orderId +
            " is now taxed at the customer's address (" +
            addressText(contactMechId) +
            "), total " +
            moneyText(order.grandTotal ?? 0, order.currencyUomId) +
            " at revision " +
            revisionOf(order) +
            "; review it and propose again"
    )
}
function proposeQuote(p) {
    const userScope = salesAccess.scope()
    const quote = editableQuote(userScope, p.orderId)
    const order = quote.order
    if (!draftStatuses.includes(order.statusId)) denied("QUOTE_NOT_DRAFT", "Quote " + order.orderId + " is not a draft")
    requireRevision(order, p.orderRevision)
    // one seller, one customer and the one currency (the header's) on every part (design §5: a response never places hidden parts)
    for (const part of rows(PART, {orderId: order.orderId}))
        if (part.vendorPartyId !== quote.organizationPartyId || part.customerPartyId !== quote.customerPartyId)
            denied("PARTS_INVALID", "Every part of quote " + order.orderId + " must be of one seller and one customer")
    const lines = approvals().linesOf(order.orderId)
    if (!lines.length) denied("LINES_REQUIRED", "Add a line before proposing the quote")
    for (const item of lines) {
        if (item.unitAmount == null) denied("PRICE_UNAVAILABLE", "Line " + item.orderItemSeqId + " has no price")
        const usable = call("mantle.product.ProductServices.check#ProductUsable", {
            productId: item.productId,
            usage: "Sell",
            quantity: item.quantity ?? 1,
            productStoreId: order.productStoreId || null,
            vendorPartyId: quote.organizationPartyId,
            customerPartyId: quote.customerPartyId
        })
        if (!usable.usable)
            denied(
                "PRODUCT_NOT_USABLE",
                "Line " + item.orderItemSeqId + ": " + (usable.reason || item.productId + " is not for sale")
            )
    }
    if (toDecimal(order.grandTotal ?? 0).compare(0) < 0)
        denied("TOTAL_INVALID", "Quote " + order.orderId + " totals less than zero")
    const from = ms(quote.part.validFromDate)
    const thru = ms(quote.part.validThruDate)
    if (thru == null) denied("VALIDITY_REQUIRED", "Set the date the quote is valid through (Edit quote)")
    if (thru <= nowMs()) denied("QUOTE_EXPIRED", "Quote " + order.orderId + " expired " + dayText(quote.part.validThruDate))
    if (from != null && from > thru) denied("VALIDITY_INVALID", "Valid through must be after valid from")
    refreshTax(quote)
    approvals().requireApproved(userScope, quote)
    call("mantle.order.OrderServices.propose#Order", {orderId: order.orderId})
    const after = one(ORDER, {orderId: order.orderId})
    return {orderId: after.orderId, statusId: after.statusId, orderRevision: revisionOf(after)}
}

// ===== send#Quote =====
// The issue standing at the revision, or a new one: the PDF rendered and stored at the revision (an OrderContent, which with the
// commercial revision on does not move it) and the SalesQuoteIssue with the part's validity; earlier unended issues end superseded.
function issueOf(quote, operationKey) {
    const existing = standingIssue(quote.order)
    if (existing) return {issue: existing, created: false}
    const order = quote.order
    endIssues(order, ends.superseded, null)
    const issuedDate = ec.user.nowTimestamp
    const draftIssue = {issuedDate, validThruDate: quote.part.validThruDate}
    const printed = printOf(order, quote.part, draftIssue)
    const pdf = ec.resource.xslFoTransform(printed.printHtml, null, null, "application/pdf")
    const key = ec.user
        .singleUseCodeHash(printed.printHtml + String(nowMs()))
        .replace(/[^A-Za-z0-9]/g, "")
        .slice(0, 24)
    const location = "dbresource://mantle/content/sales-quote/" + order.orderId + "/" + key + "/" + printed.fileName
    ec.resource.getLocationReference(location).putBytes(pdf)
    const orderContentId = call("create#" + CONTENT, {
        orderId: order.orderId,
        orderContentTypeEnumId: contentType,
        partyId: quote.customerPartyId,
        roleTypeId: "Customer",
        contentLocation: location,
        contentDate: issuedDate,
        userId: ec.user.userId,
        description: L("Quote") + " " + order.orderId + " " + L("as issued at revision") + " " + revisionOf(order)
    }).orderContentId
    const created = call("create#" + ISSUE, {
        orderId: order.orderId,
        orderPartSeqId: quote.part.orderPartSeqId,
        orderRevision: revisionOf(one(ORDER, {orderId: order.orderId})),
        organizationPartyId: quote.organizationPartyId,
        customerPartyId: quote.customerPartyId,
        issuedDate,
        issuedByUserId: ec.user.userId,
        validFromDate: quote.part.validFromDate || issuedDate,
        validThruDate: quote.part.validThruDate,
        orderContentId,
        contentLocation: location,
        operationKey: text(operationKey)
    })
    return {issue: one(ISSUE, {issueId: created.issueId}), created: true}
}
const eventOf = (kind, issueId) => (kind === "reminder" ? "SalesQuoteReminder:" : "SalesQuoteIssue:") + issueId
// The ledger's deliveries of an issue's send and reminder, by recipient.
function deliveriesOf(issueId) {
    return rows(DELIVERY, {eventKey: eventOf("quote", issueId)}).concat(rows(DELIVERY, {eventKey: eventOf("reminder", issueId)}))
}
// The rep's own sends of an issue (OrderEmailMessage rows naming its PDF), with their mail's state.
function ownSendsOf(issue) {
    if (!issue.orderContentId) return []
    return rows(EMAIL, {orderId: issue.orderId, orderContentId: issue.orderContentId}).map(row => {
        const message = one("moqui.basic.email.EmailMessage", {emailMessageId: row.emailMessageId})
        const state =
            message?.statusId === "ES_SENT"
                ? "sent"
                : message?.sendError || message?.statusId === "ES_CANCELLED"
                  ? "failed"
                  : "queued"
        return {partyId: row.partyId, emailMessageId: row.emailMessageId, state, error: message?.sendError || ""}
    })
}
const ledgerStates = {
    MdsQueued: "queued",
    MdsRetry: "retrying",
    MdsSent: "sent",
    MdsFailed: "failed",
    MdsUncertain: "uncertain",
    MdsSuppressed: "suppressed"
}
// One recipient by the rep's own account: a mail client draft with the PDF attached, sent through send#EmailDraft and filed on the
// order, recorded as an OrderEmailMessage of the issue's PDF.
function sendOwn(quote, issue, recipient, account, subject, note) {
    if (!recipient.emailAddress) return {state: "failed", error: L("The recipient has no email address")}
    const fileName = String(issue.contentLocation).substring(String(issue.contentLocation).lastIndexOf("/") + 1)
    const body = ec.resource.template(emailLocation, {
        note: text(note),
        textHtml: storedText(
            "quote",
            quote.organizationPartyId,
            Object.assign(textMap(quote.order, quote.part, issue), {part: "cover"})
        )
    })
    const draft = call("org.moqui.mail.EmailClientServices.save#Draft", {
        emailAccountId: account.emailAccountId,
        toAddresses: recipient.emailAddress,
        subject,
        body,
        attachmentList: [{attachmentLocation: issue.contentLocation, fileName, contentType: "application/pdf"}]
    })
    const sent = call("mantle.party.CommunicationServices.send#EmailDraft", {
        emailMessageId: draft.emailMessageId,
        recordEntityName: ORDER,
        recordId: quote.order.orderId
    })
    call("create#" + EMAIL, {
        orderId: quote.order.orderId,
        emailMessageId: draft.emailMessageId,
        orderRevision: Number(issue.orderRevision),
        partyId: recipient.partyId,
        roleTypeId: recipient.customer ? "Customer" : null,
        orderContentId: issue.orderContentId
    })
    return {state: sent.sent ? "sent" : sent.sendError ? "failed" : "queued", error: sent.sendError || ""}
}
// One recipient by the organization through the ledger (one delivery per issue and recipient): queued, or a failed or waiting one
// queued again; the attempt runs once this transaction commits (attempt#QuoteDeliveries).
function sendLedger(quote, issue, recipient, emailTemplateId, subject, note) {
    const queued = call("mantle.party.MessageServices.queue#Delivery", {
        eventKey: eventOf("quote", issue.issueId),
        sourceEnumId: sources.quote,
        recipientPartyId: recipient.partyId,
        templateKey: emailTemplateId,
        transactional: true,
        bodyParameters: {subject, note: text(note)}
    })
    if (queued.created) return {state: "queued", deliveryId: queued.deliveryId}
    if (["MdsFailed", "MdsRetry"].includes(queued.stateEnumId)) {
        const again = call("mantle.party.MessageServices.requeue#Delivery", {deliveryId: queued.deliveryId})
        return {
            state: again.requeued ? "queued" : ledgerStates[again.stateEnumId] || "queued",
            deliveryId: queued.deliveryId,
            retried: true
        }
    }
    return {state: ledgerStates[queued.stateEnumId] || "queued", deliveryId: queued.deliveryId, skipped: true}
}
// send#Quote: the issue (reused or made) and each recipient's send; previewOnly answers what would go and writes nothing.
function sendQuote(p) {
    const userScope = salesAccess.scope()
    const quote = editableQuote(userScope, p.orderId)
    salesAccess.requireCapability(userScope, "quoteSend")
    const order = quote.order
    const preview = flag(p.previewOnly)
    const {options, chosen} = chosenRecipients(quote, p.recipientPartyIds)
    const caller = userScope.partyId
    const account = ownAccount(p.emailAccountId)
    const ownAllowed = !!account && !!caller && caller === ownerOf(order)
    const sendMode = text(p.sendMode) || (ownAllowed ? "own" : "organization")
    if (!["own", "organization"].includes(sendMode)) denied("SEND_MODE_INVALID", "Send from your mail or from the organization")
    const request = {
        orderId: order.orderId,
        orderRevision: p.orderRevision ?? null,
        recipients: chosen.map(row => row.partyId).sort(),
        sendMode,
        note: text(p.note)
    }
    const operation = preview ? null : lib.operation(p, "SalesQuoteSend", quote.organizationPartyId, request)
    if (operation?.old) return lib.previous(operation)
    if (order.statusId !== "OrderProposed") denied("QUOTE_NOT_PROPOSED", "Propose quote " + order.orderId + " before you send it")
    requireRevision(order, p.orderRevision)
    if (!commercialRevisionOn(quote.organizationPartyId))
        denied(
            "COMMERCIAL_REVISION_OFF",
            "A quote is issued only where the seller counts commercial changes only (Sales settings › Defaults › Commercial revision)"
        )
    const thru = ms(quote.part.validThruDate)
    if (thru == null) denied("VALIDITY_REQUIRED", "Set the date the quote is valid through")
    if (thru <= nowMs()) denied("QUOTE_EXPIRED", "Quote " + order.orderId + " has expired")
    if (sendMode === "own" && !ownAllowed)
        denied(
            "SEND_ACCOUNT_REQUIRED",
            account ? "Only the quote's owner sends it from their own mail" : "You have no mail account to send from"
        )
    const policy = policyOf(quote.organizationPartyId)
    const emailTemplateId = text(policy.quoteEmailTemplateId) || templates.quote
    const subject =
        text(p.subject) ||
        L("Quote") +
            " " +
            order.orderId +
            (order.orderName ? " · " + order.orderName : "") +
            " · " +
            partyName(quote.organizationPartyId)
    const standing = standingIssue(order)
    const sentTo = new Map()
    if (standing) {
        for (const row of deliveriesOf(standing.issueId).filter(row => row.eventKey === eventOf("quote", standing.issueId)))
            sentTo.set(row.recipientPartyId, ledgerStates[row.stateEnumId] || "queued")
        for (const row of ownSendsOf(standing)) if (sentTo.get(row.partyId) !== "sent") sentTo.set(row.partyId, row.state)
    }
    if (preview)
        return {
            orderId: order.orderId,
            orderRevision: revisionOf(order),
            issueId: standing?.issueId || null,
            newIssue: !standing,
            sendMode,
            ownAllowed,
            accountText: account ? account.emailAddress || account.accountName || account.emailAccountId : "",
            emailTemplateId,
            templateName: one("moqui.basic.email.EmailTemplate", {emailTemplateId})?.description || emailTemplateId,
            subject,
            fileName: standing
                ? String(standing.contentLocation).substring(String(standing.contentLocation).lastIndexOf("/") + 1)
                : "Quote-" + order.orderId + "-r" + revisionOf(order) + ".pdf",
            recipients: chosen.map(row =>
                Object.assign({}, row, {state: sentTo.get(row.partyId) || "", willSend: sentTo.get(row.partyId) !== "sent"})
            ),
            recipientOptions: options
        }
    // a new issue is offered only with every approval current at its revision (a change made since the proposal, outside Sales'
    // draft verbs, asks for them again)
    if (!standing) approvals().requireApproved(userScope, quote)
    const made = issueOf(quote, p.operationKey)
    const results = []
    for (const recipient of chosen) {
        if (sentTo.get(recipient.partyId) === "sent" && !made.created) {
            results.push({partyId: recipient.partyId, name: recipient.name, state: "sent", skipped: true})
            continue
        }
        const out =
            sendMode === "own"
                ? sendOwn(quote, made.issue, recipient, account, subject, p.note)
                : sendLedger(quote, made.issue, recipient, emailTemplateId, subject, p.note)
        results.push(Object.assign({partyId: recipient.partyId, name: recipient.name}, out))
    }
    if (sendMode === "organization")
        ec.service
            .special()
            .name("mantle.order.SalesQuoteIssueServices.attempt#QuoteDeliveries")
            .parameters({issueId: made.issue.issueId})
            .registerOnCommit()
    const result = {
        orderId: order.orderId,
        orderRevision: revisionOf(one(ORDER, {orderId: order.orderId})),
        issueId: made.issue.issueId,
        newIssue: made.created,
        sendMode,
        recipients: results,
        failedCount: results.filter(row => row.state === "failed").length
    }
    lib.complete(operation, ISSUE, made.issue.issueId, result)
    return Object.assign(result, {alreadyApplied: false})
}
// attempt#QuoteDeliveries (after the send commits): each queued delivery of the issue's send and reminder, each in its own
// transaction; one that fails is logged by its id and the rest go on.
function attemptDeliveries(p) {
    let attempted = 0
    for (const delivery of deliveriesOf(text(p.issueId) || "-").filter(row => row.stateEnumId === "MdsQueued")) {
        ec.message.pushErrors()
        try {
            ec.service
                .sync()
                .name("mantle.party.MessageServices.attempt#Delivery")
                .parameters({deliveryId: delivery.deliveryId})
                .disableAuthz()
                .requireNewTransaction(true)
                .call()
            attempted++
        } catch (error) {
            ec.logger.error(
                "Quote delivery " + delivery.deliveryId + " was not attempted: " + String(error.message).split("\n")[0]
            )
        } finally {
            ec.message.clearErrors()
            ec.message.popErrors()
        }
    }
    return {attempted}
}

// ===== the ledger's builds =====
// The sender of an organization's quote mail: its primary email, else the issuer's.
function senderOf(issue) {
    let fromAddress = null
    try {
        fromAddress = text(
            call("mantle.party.ContactServices.get#PartyContactInfo", {
                partyId: issue.organizationPartyId,
                emailContactMechPurposeId: "EmailPrimary"
            }).emailAddress
        )
    } catch (error) {
        ec.message.clearErrors()
    }
    if (!fromAddress) {
        const issuer = issue.issuedByUserId ? one("moqui.security.UserAccount", {userId: issue.issuedByUserId}) : null
        fromAddress = issuer?.partyId ? emailOf(issuer.partyId) : null
    }
    return {fromAddress, fromName: partyName(issue.organizationPartyId)}
}
// build#QuoteMessage and build#QuoteReminderMessage (each attempt): suppressed once the issue no longer stands (revised, withdrawn,
// answered, expired); else the recipient's current email, the subject and sender, the organization's text (locked) and the PDF.
function buildMessage(p, kind) {
    const issueId = String(p.eventKey || "").replace(/^SalesQuote(Issue|Reminder):/, "")
    const issue = one(ISSUE, {issueId})
    if (!issue) return {suppress: "The quote's issue is gone"}
    const order = one(ORDER, {orderId: issue.orderId})
    const part = order ? one(PART, {orderId: issue.orderId, orderPartSeqId: issue.orderPartSeqId}) : null
    if (!order || !part) return {suppress: "The quote is gone"}
    if (!stands(issue, order))
        return {suppress: "The quote's issue no longer stands (" + L(stateTexts[issueState(issue, order)]) + ")"}
    const delivery = one(DELIVERY, {deliveryId: p.deliveryId})
    const queued = lib.json(delivery?.parametersJson, {}) || {}
    const sender = senderOf(issue)
    const map = textMap(order, part, issue)
    const subject =
        kind === "reminder"
            ? L("Reminder") + ": " + L("quote") + " " + order.orderId + " · " + partyName(issue.organizationPartyId)
            : text(queued.subject) || L("Quote") + " " + order.orderId + " · " + partyName(issue.organizationPartyId)
    const body = ec.resource.template(emailLocation, {
        note: kind === "reminder" ? null : text(queued.note),
        textHtml: storedText(kind === "reminder" ? "reminder" : "quote", issue.organizationPartyId, map)
    })
    const fileName = String(issue.contentLocation).substring(String(issue.contentLocation).lastIndexOf("/") + 1)
    const toAddress = emailOf(String(p.recipientPartyId || ""))
    // the PDF's bytes (the mail sender reads a file path, not the content store)
    const stream = ec.resource.getLocationStream(issue.contentLocation)
    if (!stream) throw new Error("The issued PDF of quote " + order.orderId + " is not there")
    let contentBytes
    try {
        contentBytes = stream.readAllBytes()
    } finally {
        stream.close()
    }
    return Object.assign(toAddress ? {toAddress} : {}, {
        bodyParameters: {subject, fromAddress: sender.fromAddress, fromName: sender.fromName},
        body,
        attachments: [{fileName, contentType: "application/pdf", contentBytes}]
    })
}

// ===== send#QuoteReminders (the daily job; off until an organization sets its reminder days) =====
// For each issue standing past its organization's reminder days (SalesPolicy.reminderDays; none set, no reminder) and not
// answered: one reminder to each recipient it was sent to, through the ledger (deduplicated by the issue and recipient). Each issue
// in its own try; a failing one is logged and the rest go on.
function sendReminders(p) {
    const limit = Math.min(Number(p.limit || 500), 2000)
    const now = nowMs()
    const candidates = Array.from(
        find(ISSUE)
            .condition("endedDate", "is-null", null)
            .condition("validThruDate", "greater", new Date(now))
            .orderBy("issuedDate")
            .limit(limit)
            .list()
    )
    let queued = 0
    const days = {}
    const issueIds = []
    for (const issue of candidates) {
        try {
            if (!(issue.organizationPartyId in days))
                days[issue.organizationPartyId] = Number(policyOf(issue.organizationPartyId).reminderDays || 0)
            const wait = days[issue.organizationPartyId]
            if (!wait || (ms(issue.issuedDate) ?? now) + wait * dayMs > now) continue
            const order = one(ORDER, {orderId: issue.orderId})
            if (!order || !stands(issue, order, now)) continue
            const recipients = new Set(
                rows(DELIVERY, {eventKey: eventOf("quote", issue.issueId), stateEnumId: "MdsSent"}).map(
                    row => row.recipientPartyId
                )
            )
            for (const row of ownSendsOf(issue)) if (row.state === "sent" && row.partyId) recipients.add(row.partyId)
            const emailTemplateId = text(policyOf(issue.organizationPartyId).reminderEmailTemplateId) || templates.reminder
            for (const recipientPartyId of recipients) {
                const out = call("mantle.party.MessageServices.queue#Delivery", {
                    eventKey: eventOf("reminder", issue.issueId),
                    sourceEnumId: sources.reminder,
                    recipientPartyId,
                    templateKey: emailTemplateId,
                    transactional: true
                })
                if (out.created) queued++
            }
            if (recipients.size) issueIds.push(issue.issueId)
        } catch (error) {
            ec.message.clearErrors()
            ec.logger.error("Reminder of quote issue " + issue.issueId + " failed: " + String(error.message).split("\n")[0])
        }
    }
    for (const issueId of issueIds) attemptDeliveries({issueId})
    return {queuedCount: queued}
}

// ===== respond#Quote =====
// The customer's acceptance or decline of an issue, recorded by staff with its evidence (design §5 Record acceptance and decline):
// under the order's lock, the issue current (not ended, the order Proposed at its revision) and the response made within its
// validity; one response an issue (a second acceptance answers the first, a decline after it is refused). An acceptance records the
// customer's purchase order on the part (not a commercial change) and places the order once through place#Order, its result
// placed, approved or held by the native rules; a decline needs its reason and cancels the quote through Cancel Quote.
function respondQuote(p) {
    const userScope = salesAccess.scope()
    const quote = editableQuote(userScope, p.orderId)
    const action = text(p.responseType) || "accept"
    if (!Object.hasOwn(responseTypes, action)) denied("RESPONSE_INVALID", "Record an acceptance or a decline")
    const request = {
        orderId: quote.order.orderId,
        issueId: text(p.issueId),
        action,
        otherPartyOrderId: text(p.otherPartyOrderId),
        contactPartyId: text(p.contactPartyId),
        reason: text(p.reason)
    }
    const operation = lib.operation(p, "SalesQuoteRespond", quote.organizationPartyId, request)
    if (operation.old) return lib.previous(operation)
    const order = find(ORDER, {orderId: quote.order.orderId}).forUpdate(true).one()
    const issue = request.issueId ? one(ISSUE, {issueId: request.issueId}) : issuesOf(order.orderId)[0] || null
    if (!issue || issue.orderId !== order.orderId) denied("ISSUE_UNAVAILABLE", "Quote " + order.orderId + " has no such issue")
    const earlier = responseOf(issue.issueId)
    if (earlier) {
        if (earlier.responseTypeEnumId === responseTypes[action] && action === "accept") {
            const result = resultOf(earlier, order)
            lib.complete(operation, RESPONSE, earlier.responseId, result)
            return Object.assign(result, {alreadyApplied: true})
        }
        denied(
            "RESPONSE_EXISTS",
            "Issue " + issue.issueId + " was " + enumText(earlier.responseTypeEnumId).toLowerCase() + " already"
        )
    }
    if (issue.endedDate) denied("ISSUE_ENDED", "Issue " + issue.issueId + " was " + enumText(issue.endReasonEnumId).toLowerCase())
    if (order.statusId !== "OrderProposed")
        denied("QUOTE_NOT_PROPOSED", "Quote " + order.orderId + " is " + statusText(order.statusId))
    if (Number(issue.orderRevision) !== revisionOf(order))
        denied(
            "ISSUE_SUPERSEDED",
            "Quote " + order.orderId + " changed after this issue; its current revision is " + revisionOf(order)
        )
    const respondedMs = blank(p.respondedDate) ? nowMs() : ms(p.respondedDate)
    if (!Number.isFinite(respondedMs) || respondedMs > nowMs() + 60000 || respondedMs < (ms(issue.issuedDate) ?? 0) - 60000)
        denied("DATE_INVALID", "The response is between the issue and now")
    const thru = ms(issue.validThruDate)
    if (thru != null && respondedMs > thru)
        denied("ISSUE_EXPIRED", "Issue " + issue.issueId + " expired " + dayText(issue.validThruDate))
    if (request.contactPartyId && !recipientOptions(quote.customerPartyId).some(row => row.partyId === request.contactPartyId))
        denied("CONTACT_INVALID", "The contact is not the customer or one of its contacts")
    const evidenceOrderContentId = text(p.evidenceOrderContentId)
    if (evidenceOrderContentId && one(CONTENT, {orderContentId: evidenceOrderContentId})?.orderId !== order.orderId)
        denied("EVIDENCE_INVALID", "The evidence is not a file of quote " + order.orderId)
    const evidenceEmailMessageId = text(p.evidenceEmailMessageId)
    if (evidenceEmailMessageId && !one("moqui.basic.email.EmailMessage", {emailMessageId: evidenceEmailMessageId}))
        denied("EVIDENCE_INVALID", "The evidence mail is not available")
    if (action === "decline" && !request.reason) denied("REASON_REQUIRED", "Give the customer's reason for the decline")
    if (action === "accept" && policyOf(quote.organizationPartyId).responsePoRequired === "Y" && !request.otherPartyOrderId)
        denied("PO_REQUIRED", "The organization records the customer's purchase order with an acceptance")
    const created = call("create#" + RESPONSE, {
        issueId: issue.issueId,
        orderId: order.orderId,
        responseTypeEnumId: responseTypes[action],
        responseSourceEnumId: "SqsStaff",
        respondedDate: new Date(respondedMs),
        recordedDate: ec.user.nowTimestamp,
        recordedByUserId: ec.user.userId,
        contactPartyId: request.contactPartyId,
        otherPartyOrderId: request.otherPartyOrderId,
        evidenceEmailMessageId,
        evidenceOrderContentId,
        reasonText: request.reason,
        operationKey: text(p.operationKey)
    })
    if (action === "accept") {
        if (request.otherPartyOrderId && request.otherPartyOrderId !== (quote.part.otherPartyOrderId || null))
            call("update#" + PART, {
                orderId: order.orderId,
                orderPartSeqId: issue.orderPartSeqId,
                otherPartyOrderId: request.otherPartyOrderId
            })
        // every placement goes through place#Order (impl-sales §2; Marketing's attribution sees it)
        call("mantle.order.OrderServices.place#Order", {orderId: order.orderId})
    } else {
        call("mantle.order.OrderServices.cancel#Order", {orderId: order.orderId})
        endIssues(order, ends.declined, request.reason)
    }
    const after = one(ORDER, {orderId: order.orderId})
    call("update#" + RESPONSE, {responseId: created.responseId, resultStatusId: after.statusId})
    const result = resultOf(one(RESPONSE, {responseId: created.responseId}), after)
    lib.complete(operation, RESPONSE, created.responseId, result)
    return Object.assign(result, {alreadyApplied: false})
}
// A response's result: placed, approved or held (an acceptance; held while the order or a part is on hold), or declined.
function resultOf(response, order) {
    const held =
        order.statusId === "OrderHold" ||
        rows(PART, {orderId: order.orderId}).some(part => part.statusId === "OrderHold") ||
        rows("mantle.order.OrderHoldReason", {orderId: order.orderId}).some(row => !row.releasedDate)
    const outcome =
        response.responseTypeEnumId === responseTypes.decline
            ? "declined"
            : held
              ? "held"
              : ["OrderApproved", "OrderSent", "OrderCompleted"].includes(order.statusId)
                ? "approved"
                : "placed"
    return {
        orderId: order.orderId,
        issueId: response.issueId,
        responseId: response.responseId,
        statusId: order.statusId,
        outcome
    }
}

// ===== withdraw#Quote, revise#Quote, clone#Quote =====
// withdraw#Quote: the seller cancels a proposed quote (Cancel Quote) and its issue ends, with the reason.
function withdrawQuote(p) {
    const userScope = salesAccess.scope()
    const quote = editableQuote(userScope, p.orderId, true)
    const order = quote.order
    if (order.statusId !== "OrderProposed") denied("QUOTE_NOT_PROPOSED", "Only a proposed quote is withdrawn")
    requireRevision(order, p.orderRevision)
    const reason = text(p.reason)
    if (!reason) denied("REASON_REQUIRED", "Give the reason for withdrawing the quote")
    call("mantle.order.OrderServices.cancel#Order", {orderId: order.orderId})
    const ended = endIssues(order, ends.withdrawn, reason)
    const after = one(ORDER, {orderId: order.orderId})
    return {orderId: after.orderId, statusId: after.statusId, endedCount: ended}
}
// revise#Quote: a proposed quote back to Being changed (Begin Changes) with a commercial revision counted, so its approvals and issue
// end and it is proposed and sent again; the issued PDF stays among its files. Not for an accepted quote, which is an order.
function reviseQuote(p) {
    const userScope = salesAccess.scope()
    const quote = editableQuote(userScope, p.orderId, true)
    const order = quote.order
    if (order.statusId !== "OrderProposed") denied("QUOTE_NOT_PROPOSED", "Only a proposed quote is revised")
    requireRevision(order, p.orderRevision)
    endIssues(order, ends.revised, text(p.reason))
    call("mantle.order.OrderServices.update#OrderStatus", {orderId: order.orderId, statusId: "OrderBeingChanged"})
    call("mantle.order.OrderServices.increment#OrderRevision", {orderId: order.orderId, revisionKind: "commercial"})
    const after = one(ORDER, {orderId: order.orderId})
    return {orderId: after.orderId, statusId: after.statusId, orderRevision: revisionOf(after)}
}
// clone#Quote: a separate draft from a quote (clone#Order without its files, notes or payments), the caller its owner, the team,
// contact and opportunity kept, valid from now for the organization's days, retaxed by the native rules.
function cloneQuote(p) {
    const userScope = salesAccess.scope()
    const source = editableQuote(userScope, p.orderId)
    const cloned = call("mantle.order.OrderServices.clone#Order", {
        baseOrderId: source.order.orderId,
        statusId: "OrderOpen",
        orderPurposeEnumId: salesAccess.quotePurpose,
        orderName: source.order.orderName ? L("Copy of") + " " + source.order.orderName : null,
        productItemsOnly: false,
        copyContent: false,
        copyNote: false,
        copyPayment: false,
        copyItemWorkEffort: false
    })
    const orderId = cloned.orderId
    const part = rows(PART, {orderId})[0]
    for (const row of rows(PART_PARTY, {orderId, roleTypeId: salesAccess.quoteRoles.owner}))
        call("delete#" + PART_PARTY, {
            orderId,
            orderPartSeqId: row.orderPartSeqId,
            partyId: row.partyId,
            roleTypeId: row.roleTypeId
        })
    if (userScope.partyId)
        call("create#" + PART_PARTY, {
            orderId,
            orderPartSeqId: part.orderPartSeqId,
            partyId: userScope.partyId,
            roleTypeId: salesAccess.quoteRoles.owner
        })
    for (const link of rows(ORDER_LINK, {orderId: source.order.orderId}))
        if (!one(ORDER_LINK, {orderId, salesOpportunityId: link.salesOpportunityId}))
            call("create#" + ORDER_LINK, {orderId, salesOpportunityId: link.salesOpportunityId})
    const days = Number(policyOf(source.organizationPartyId).quoteValidityDays || 0)
    call("update#" + PART, {
        orderId,
        orderPartSeqId: part.orderPartSeqId,
        validFromDate: ec.user.nowTimestamp,
        validThruDate: days > 0 ? new Date(nowMs() + days * dayMs) : null,
        otherPartyOrderId: null
    })
    call("mantle.order.OrderServices.handle#OrderMajorChange", {orderId, orderPartSeqId: part.orderPartSeqId})
    return {orderId, orderRevision: revisionOf(one(ORDER, {orderId}))}
}

// ===== apply#QuoteBatch =====
// Send or withdraw the quotes chosen ("orderId@revision"), each on its own through send#Quote (the organization's mail to the
// quote's contact or customer) or withdraw#Quote, in its own transaction with an operation key of its own; previewOnly answers
// each one's eligibility. A refused or failed quote is named with its reason and the rest go on.
function applyBatch(p) {
    salesAccess.requireCapability(salesAccess.scope(), "quoteEdit")
    const operation = text(p.operation)
    if (!["send", "withdraw"].includes(operation)) denied("OPERATION_INVALID", "Choose send or withdraw")
    const preview = flag(p.previewOnly)
    if (!preview && blank(p.operationKey)) denied("OPERATION_KEY_REQUIRED", "A batch carries an operation key")
    if (operation === "withdraw" && !preview && !text(p.reason)) denied("REASON_REQUIRED", "Give the reason for withdrawing")
    const keys = Array.from(new Set(listOf(p.quoteKeys)))
    if (!keys.length) denied("SELECTION_REQUIRED", "Choose the quotes")
    const results = []
    for (const key of keys) {
        const [orderId, orderRevision] = key.split("@")
        const itemKey = (String(p.operationKey || "") + "-" + orderId).slice(-40)
        try {
            if (operation === "send") {
                const out = lib.probe("mantle.order.SalesQuoteIssueServices.send#Quote", {
                    orderId,
                    orderRevision: orderRevision || "",
                    sendMode: "organization",
                    note: text(p.note),
                    previewOnly: preview ? "Y" : null,
                    operationKey: preview ? null : itemKey
                })
                results.push({
                    orderId,
                    ok: true,
                    reasonCode: null,
                    message: preview
                        ? L("To") +
                          " " +
                          Array.from(out.recipients || [])
                              .map(row => row.name)
                              .join(", ")
                        : Array.from(out.recipients || [])
                              .map(row => row.name + ": " + row.state)
                              .join(", ")
                })
            } else {
                if (preview) {
                    const quote = salesAccess.requireQuote(salesAccess.scope(), orderId, true)
                    if (quote.order.statusId !== "OrderProposed")
                        denied("QUOTE_NOT_PROPOSED", "Only a proposed quote is withdrawn")
                    requireRevision(quote.order, orderRevision)
                } else
                    lib.probe("mantle.order.SalesQuoteIssueServices.withdraw#Quote", {
                        orderId,
                        orderRevision: orderRevision || "",
                        reason: text(p.reason)
                    })
                results.push({orderId, ok: true, reasonCode: null, message: ""})
            }
        } catch (error) {
            results.push({orderId, ok: false, reasonCode: reasonCodeOf(error), message: String(error.message || error)})
        }
    }
    return {results, successCount: results.filter(row => row.ok).length}
}

// ===== get#QuoteIssues =====
// OrderDetail's Issues and responses: each issue with its state, PDF, recipients (the ledger's deliveries and the rep's own sends)
// and response; what the caller may do now (propose, send, record a response, withdraw, revise, clone); the send's recipient
// options and whether the seller counts commercial changes only. Another's quote answers quoteFound false.
function getIssues(p) {
    const userScope = salesAccess.scope()
    const quote = salesAccess.quoteOf(userScope, text(p.orderId))
    if (!quote) return {quoteFound: false}
    const order = quote.order
    const names = {}
    const nameOf = partyId => (partyId ? (names[partyId] = names[partyId] || partyName(partyId)) : "")
    const issues = issuesOf(order.orderId).map(issue => {
        const state = issueState(issue, order)
        const response = responseOf(issue.issueId)
        const recipients = deliveriesOf(issue.issueId)
            .map(row => ({
                partyId: row.recipientPartyId,
                name: nameOf(row.recipientPartyId),
                kindText: row.eventKey.startsWith("SalesQuoteReminder:") ? L("Reminder") : L("From the organization"),
                state: ledgerStates[row.stateEnumId] || "queued",
                stateText: L(enumText(row.stateEnumId)),
                error: row.lastError || ""
            }))
            .concat(
                ownSendsOf(issue).map(row => ({
                    partyId: row.partyId,
                    name: nameOf(row.partyId),
                    kindText: L("From the rep's mail"),
                    state: row.state,
                    stateText: L({sent: "Sent", failed: "Failed", queued: "Queued"}[row.state]),
                    error: row.error
                }))
            )
        return {
            issueId: issue.issueId,
            orderRevision: Number(issue.orderRevision),
            issuedText: lib.dateText(issue.issuedDate),
            issuedByName: userName(issue.issuedByUserId),
            validThruText: dayText(issue.validThruDate),
            state,
            stateText: L(stateTexts[state]),
            endText: issue.endedDate
                ? [L(enumText(issue.endReasonEnumId)), lib.dateText(issue.endedDate), issue.endNote].filter(Boolean).join(" · ")
                : "",
            hasDocument: !!issue.contentLocation,
            recipients,
            recipientsText: recipients.map(row => row.name + ": " + row.stateText).join(" · "),
            failedCount: recipients.filter(row => row.state === "failed").length,
            response: response
                ? {
                      responseId: response.responseId,
                      typeText: L(enumText(response.responseTypeEnumId)),
                      accepted: response.responseTypeEnumId === responseTypes.accept,
                      respondedText: lib.dateText(response.respondedDate),
                      recordedByName: userName(response.recordedByUserId),
                      contactName: nameOf(response.contactPartyId),
                      otherPartyOrderId: response.otherPartyOrderId || "",
                      reason: response.reasonText || "",
                      resultText: statusText(response.resultStatusId)
                  }
                : null,
            responseText: response
                ? [
                      L(enumText(response.responseTypeEnumId)),
                      lib.dateText(response.respondedDate),
                      nameOf(response.contactPartyId),
                      response.otherPartyOrderId ? L("PO") + " " + response.otherPartyOrderId : "",
                      response.reasonText,
                      statusText(response.resultStatusId)
                  ]
                      .filter(Boolean)
                      .join(" · ")
                : ""
        }
    })
    const standing = standingIssue(order)
    const canEdit = !!quote.canEdit
    const proposed = order.statusId === "OrderProposed"
    const revisionOn = commercialRevisionOn(quote.organizationPartyId)
    const thru = ms(quote.part.validThruDate)
    const options = recipientOptions(quote.customerPartyId).map(row =>
        Object.assign(row, {label: row.name + (row.emailAddress ? " · " + row.emailAddress : " · " + L("no email address"))})
    )
    const contact = contactOf(order)
    const policy = policyOf(quote.organizationPartyId)
    return {
        quoteFound: true,
        orderId: order.orderId,
        orderRevision: revisionOf(order),
        statusId: order.statusId,
        issues,
        standingIssueId: standing?.issueId || null,
        commercialRevisionOn: revisionOn,
        canPropose: canEdit && draftStatuses.includes(order.statusId),
        canSend: canEdit && !!userScope.capabilities.quoteSend && proposed && revisionOn && thru != null && thru > nowMs(),
        canRespond: canEdit && !!standing,
        canWithdraw: canEdit && proposed,
        canRevise: canEdit && proposed,
        canClone: canEdit && !!userScope.capabilities.quoteEdit,
        poRequired: policy.responsePoRequired === "Y",
        // the quote's files a response may name as its evidence (not its issued PDFs)
        evidenceOptions: rows(CONTENT, {orderId: order.orderId})
            .filter(row => row.orderContentTypeEnumId !== contentType && row.contentLocation)
            .map(row => ({
                value: row.orderContentId,
                label: row.description || String(row.contentLocation).substring(String(row.contentLocation).lastIndexOf("/") + 1)
            })),
        recipientOptions: options,
        defaultRecipientPartyIds: [contact && options.some(row => row.partyId === contact) ? contact : quote.customerPartyId]
    }
}

const operations = {
    proposeQuote,
    sendQuote,
    attemptDeliveries,
    buildQuoteMessage: p => buildMessage(p, "quote"),
    buildReminderMessage: p => buildMessage(p, "reminder"),
    sendReminders,
    respondQuote,
    withdrawQuote,
    reviseQuote,
    cloneQuote,
    applyBatch,
    getIssues,
    quotePrint,
    issueDocument
}
;({
    execute: (op, parameters) => {
        if (!operations[op]) throw new Error("Unknown sales quote issue operation " + op)
        return operations[op](parameters || {})
    }
})
