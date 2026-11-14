// Sales' quote drafts (mantle.order.SalesQuoteServices, Q of IronStone Sales design §12.1; design §5 Quotes and OrderDetail's quote
// context; impl-sales P7, SAL-QUOTE, CX-PRICING).
//
// - A quote is the native OrderHeader, OrderPart and OrderItem, never a table of its own: an order of purpose SalesQuote
//   (orderPurposeEnumId OrpSalesQuote) with one selling part (one seller of the caller's sales scope, one customer that is an
//   account of it, one currency), Open while it is a draft. create#Quote makes it through create#Order; its lines go through
//   create#OrderItem and the entity's own update and delete, so the native order rules (totals, the revision, X1's tax) run once.
// - Access (SalesAccess.js quoteOf): a Sales reader sees the quotes assigned to them or a team of theirs (the part's
//   SalesRepresentative and SalesTeam rows), a holder of SALES_TEAM_VIEW the organization's; an edit needs SALES_QUOTE_EDIT. A quote
//   outside the scope answers RECORD_UNAVAILABLE. Every party, opportunity, store, address and product given is checked.
// - Prices: a product line takes the one resolver's price for the seller and the customer (get#SellerProductPrice, as the seller's
//   authority after these checks), keeping its provenance (productPriceId, priceListId, priceRuleId, unitListPrice, priceSource) and
//   the calculated basis (calculatedUnitAmount). A missing price blocks the line (PRICE_UNAVAILABLE) unless the rep enters one; an
//   entered price keeps the basis with the value, reason and actor; a free line is an explicit choice with its reason. P9 (the user's
//   call of Nov 13): a free or zero-price line is drafted by the rep when an approval rule will need it approved (the unconfigured
//   manual-price rule, a free-line, discount or floor rule; SalesApprovals.js freeLineCovered) and needs SALES_APPROVE only where
//   none does (FREE_LINE_DENIED). Cost is never read or answered here.
// - Freight on a storeless quote is a shipping charge line the rep enters (design §19 item 1, impl-sales §4 Nov 13); tax is X1's
//   (calculate#OrderSalesTax through the store's or the seller's gateway), recalculated by the native rules on each change.
// - Every change names the order revision it read (orderRevision, REVISION_CHANGED naming the current one) and is refused once the
//   quote is no longer a draft (QUOTE_NOT_DRAFT); issue, revise and the response are P10's.
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const salesAccess = ec.resource.script("component://mr-mantle/service/mantle/sales/SalesAccess.js")
const {find, one, rows, denied, call, ms} = lib
// P9: the organization's defaults and approval rules (SalesApprovals.js), read when a quote is made, a free line entered and a quote shown
const approvals = () => ec.resource.script("component://mr-mantle/service/mantle/order/SalesApprovals.js")

const ORDER = "mantle.order.OrderHeader"
const PART = "mantle.order.OrderPart"
const ITEM = "mantle.order.OrderItem"
const PART_PARTY = "mantle.order.OrderPartParty"
const ORDER_LINK = "mantle.sales.opportunity.SalesOpportunityOrder"
const purpose = salesAccess.quotePurpose
const roles = salesAccess.quoteRoles
const draftStatuses = ["OrderOpen"]
const states = {
    draft: ["OrderOpen"],
    requested: ["OrderRequested"],
    proposed: ["OrderProposed"],
    open: ["OrderOpen", "OrderRequested", "OrderProposed"],
    cancelled: ["OrderCancelled"],
    all: null
}
const taxTypes = ["ItemSalesTax", "ItemVatTax"]
const kinds = {product: "ItemProduct", shipping: "ItemShipping"}
const sourceTexts = {
    "product-price": "Price",
    "price-list": "Price list",
    "list-price-fallback": "List price",
    manual: "Entered price",
    free: "Free line"
}
const addressPurposes = ["PostalShippingDest", "PostalBilling", "PostalPrimary"]
const dayMs = 24 * 60 * 60 * 1000
const expiringDays = 7

const blank = value => value == null || String(value).trim() === ""
const text = value => (blank(value) ? null : String(value).trim())
const flag = value => value === true || value === "true" || value === "Y"
const L = value => ec.l10n.localize(value)
const dayText = value => (value == null || value === "" ? "" : ec.l10n.format(new Date(ms(value)), "d MMM yyyy"))
const moneyText = (value, currencyUomId) =>
    value == null ? "" : ec.l10n.formatCurrency(ec.l10n.roundCurrency(toDecimal(value), currencyUomId), currencyUomId)
const quantityText = value => (value == null ? "" : String(Number(String(value))))
const likeText = value => "%" + String(value).replace(/[\\%_]/g, character => "\\" + character) + "%"
const partyName = partyId => (partyId ? lib.partyNames([partyId])[partyId] || partyId : "")
const statusText = statusId => (statusId ? one("moqui.basic.StatusItem", {statusId})?.description || statusId : "")

function decimal(value, label, allowZero) {
    let number
    try {
        number = toDecimal(value)
    } catch (_) {
        number = null
    }
    if (number == null || number.compare(0) < 0 || (!allowZero && number.isZero()))
        denied("QUANTITY_INVALID", "Enter a " + (allowZero ? "" : "positive ") + label)
    return number
}
function dateOf(value, label) {
    if (blank(value)) return null
    const millis = ms(value)
    if (!Number.isFinite(millis)) denied("DATE_INVALID", label + " is not a date")
    return new Date(millis)
}
function revisionOf(order) {
    return Number(order.orderRevision ?? 1)
}
// The revision a change was made on: refused when missing or not the current one, naming the current one.
function requireRevision(order, given) {
    if (blank(given)) denied("REVISION_REQUIRED", "Reload the quote and try again (revision " + revisionOf(order) + ")")
    if (Number(given) !== revisionOf(order))
        denied("REVISION_CHANGED", "Quote " + order.orderId + " changed; its current revision is " + revisionOf(order))
}
function requireDraft(quote) {
    if (!draftStatuses.includes(quote.order.statusId))
        denied("QUOTE_NOT_DRAFT", "Quote " + quote.order.orderId + " is " + statusText(quote.order.statusId) + ", not a draft")
}
// The customer's postal address for a quote: shipping, else billing, else primary, current.
function customerAddress(partyId) {
    if (!partyId) return null
    const purposes = rows("mantle.party.contact.PartyContactMech", {partyId}).filter(row => lib.active(row))
    for (const wanted of addressPurposes) {
        const row = purposes.find(candidate => candidate.contactMechPurposeId === wanted)
        if (row) return row.contactMechId
    }
    return null
}
function customerAddresses(partyId) {
    if (!partyId) return []
    return Array.from(
        new Set(
            rows("mantle.party.contact.PartyContactMech", {partyId})
                .filter(row => lib.active(row) && addressPurposes.includes(row.contactMechPurposeId))
                .map(row => row.contactMechId)
        )
    )
}
function addressText(contactMechId) {
    const address = contactMechId ? one("mantle.party.contact.PostalAddress", {contactMechId}) : null
    if (!address) return ""
    const state = address.stateProvinceGeoId ? one("moqui.basic.Geo", {geoId: address.stateProvinceGeoId}) : null
    return [
        address.address1,
        address.city,
        state?.geoCodeAlpha2 || state?.geoName || address.stateProvinceGeoId,
        address.postalCode
    ]
        .filter(Boolean)
        .join(", ")
}
// The team a quote's part is assigned to: the opportunity's current team, else the caller's only team of the organization.
function teamFor(userScope, organizationPartyId, salesOpportunityId) {
    if (salesOpportunityId) {
        const row = rows("mantle.sales.opportunity.SalesOpportunityParty", {salesOpportunityId, roleTypeId: roles.team}).find(
            row => lib.active(row)
        )
        if (row) return row.partyId
    }
    const teams = salesAccess
        .memberTeams(userScope.partyId)
        .filter(teamPartyId => salesAccess.teamOrganization(teamPartyId) === organizationPartyId)
    if (teams.length === 1) return teams[0]
    // P9: else the organization's default team (SalesPolicy)
    return approvals().policyOf(organizationPartyId)?.defaultTeamPartyId || null
}

// ===== find#Quotes =====
// The scoped list of quotes (design §5 QuoteList): the caller's quotes of the organizations of their scope, in the states asked
// (open by default: Open, Requested, Proposed; cancelled; all), never a cart, a recurring base or any order of another purpose.
function findQuotes(p) {
    const userScope = salesAccess.scope()
    salesAccess.requireCapability(userScope, "anyRead")
    const organizationPartyId = text(p.organizationPartyId)
    if (organizationPartyId) salesAccess.requireOrganization(userScope, organizationPartyId)
    const factory = ec.entity.conditionFactory
    const conditions = [factory.makeCondition("orderPurposeEnumId", "equals", purpose)]
    const add = (field, operator, value) => conditions.push(factory.makeCondition(field, operator, value))
    let none = false
    if (organizationPartyId) add("vendorPartyId", "equals", organizationPartyId)
    else if (userScope.organizationPartyIds != null) {
        if (!userScope.organizationPartyIds.length) none = true
        else add("vendorPartyId", "in", Array.from(userScope.organizationPartyIds))
    }
    let ids = salesAccess.assignedQuoteOrderIds(userScope)
    const narrow = found => {
        ids = ids == null ? found : ids.filter(id => found.includes(id))
    }
    const ownerPartyId = flag(p.mine) ? userScope.partyId : text(p.ownerPartyId)
    const withRole = (roleTypeId, partyId) =>
        Array.from(find(PART_PARTY, {roleTypeId, partyId}).selectField("orderId").list()).map(row => row.orderId)
    if (ownerPartyId) narrow(withRole(roles.owner, ownerPartyId))
    if (text(p.teamPartyId)) narrow(withRole(roles.team, text(p.teamPartyId)))
    if (text(p.salesOpportunityId))
        narrow(rows(ORDER_LINK, {salesOpportunityId: text(p.salesOpportunityId)}).map(row => row.orderId))
    if (ids != null) {
        if (!ids.length) none = true
        else add("orderId", "in", ids)
    }
    if (text(p.customerPartyId)) add("customerPartyId", "equals", text(p.customerPartyId))
    if (text(p.currencyUomId)) add("currencyUomId", "equals", text(p.currencyUomId))
    const state = text(p.state) || "open"
    if (!Object.hasOwn(states, state)) denied("STATE_INVALID", "Choose a quote state")
    if (states[state]) add("statusId", "in", states[state])
    // a cancelled quote is one withdrawn or declined before placement; an accepted quote placed and later cancelled is an order's
    if (state === "cancelled") add("placedDate", "is-null", null)
    const now = ms(ec.user.nowTimestamp)
    if (p.validity === "expired") {
        add("validThruDate", "is-not-null", null)
        add("validThruDate", "less", new Date(now))
    } else if (p.validity === "expiring") {
        add("validThruDate", "greater-equals", new Date(now))
        add("validThruDate", "less", new Date(now + expiringDays * dayMs))
    }
    const term = text(p.text)
    if (term)
        conditions.push(
            factory.makeCondition(
                ["orderId", "orderName"].map(field => factory.makeCondition(field, "like", likeText(term)).ignoreCase()),
                "or"
            )
        )
    const query = () => {
        let found = find("mantle.order.OrderHeaderAndPart")
        for (const condition of conditions) found = found.condition(condition)
        return found
            .selectField("orderId")
            .selectField("orderName")
            .selectField("statusId")
            .selectField("entryDate")
            .selectField("grandTotal")
            .selectField("currencyUomId")
            .selectField("orderRevision")
            .selectField("vendorPartyId")
            .selectField("customerPartyId")
            .selectField("validThruDate")
            .selectField("productStoreId")
            .distinct(true)
    }
    const orderBy = text(p.orderByField)
    const sort =
        orderBy && /^[-+^]?(orderName|entryDate|grandTotal|validThruDate)$/.test(orderBy)
            ? [orderBy, "orderId"]
            : ["-entryDate", "orderId"]
    const count = none ? 0 : query().count()
    const paged = lib.page(none ? query().condition("orderId", "_NONE_") : query().orderBy(sort), p, "quoteList", count, {
        noLimitCap: 1000
    })
    const pageRows = paged.rows
    const orderIds = pageRows.map(row => row.orderId)
    const names = lib.partyNames(pageRows.flatMap(row => [row.vendorPartyId, row.customerPartyId]))
    const owners = {}
    if (orderIds.length)
        for (const row of find(PART_PARTY).condition("orderId", "in", orderIds).condition("roleTypeId", roles.owner).list())
            owners[row.orderId] = row.partyId
    const ownerNames = lib.partyNames(Object.values(owners))
    const links = {}
    if (orderIds.length)
        for (const row of find(ORDER_LINK).condition("orderId", "in", orderIds).list())
            links[row.orderId] = links[row.orderId] || row.salesOpportunityId
    const statusNames = {}
    for (const row of pageRows) statusNames[row.statusId] = statusNames[row.statusId] || statusText(row.statusId)
    const quoteList = pageRows.map(row => {
        const thru = ms(row.validThruDate)
        const expired = thru != null && thru < now
        const account = salesAccess.accountOf(userScope, row.customerPartyId)
        return {
            orderId: row.orderId,
            orderName: row.orderName || row.orderId,
            statusId: row.statusId,
            statusText: statusNames[row.statusId],
            customerPartyId: account ? row.customerPartyId : null,
            customerName: account ? names[row.customerPartyId] || row.customerPartyId : "",
            organizationName: names[row.vendorPartyId] || row.vendorPartyId,
            grandTotal: row.grandTotal,
            currencyUomId: row.currencyUomId,
            totalText: moneyText(row.grandTotal ?? 0, row.currencyUomId),
            entryText: dayText(row.entryDate),
            validThruText: dayText(row.validThruDate),
            validityText: expired
                ? L("Expired")
                : thru != null && thru < now + expiringDays * dayMs
                  ? L("Expiring")
                  : thru != null
                    ? L("Valid")
                    : "",
            expired,
            orderRevision: revisionOf(row),
            ownerName: owners[row.orderId] ? ownerNames[owners[row.orderId]] || "" : "",
            salesOpportunityId: links[row.orderId] || null,
            storeless: !row.productStoreId
        }
    })
    return Object.assign(
        {quoteList},
        Object.fromEntries(Object.entries(paged).filter(([key]) => key.startsWith("quoteList") && key !== "quoteList"))
    )
}

// ===== create#Quote =====
// A draft quote (design §5 NewQuote): one selling part of an organization of the caller's scope for a customer that is an account
// of it (or a shared one), in one currency (the one given, else the opportunity's, else the seller's base currency), with or without
// a store of the organization (X1: without one the seller's gateway taxes it), its validity on the part, the customer's address, the
// caller as its owner and the opportunity's team (else the caller's only team of the organization), and the opportunity linked.
function createQuote(p) {
    const userScope = salesAccess.scope()
    salesAccess.requireCapability(userScope, "anyRead")
    salesAccess.requireCapability(userScope, "quoteEdit")
    const organizationPartyId = text(p.organizationPartyId) || salesAccess.defaultOrganization(userScope)
    if (!organizationPartyId) denied("ORGANIZATION_DENIED", "Choose the selling organization")
    if (!salesAccess.isInternal(organizationPartyId))
        denied("ORGANIZATION_DENIED", "Organization " + organizationPartyId + " is not available")
    salesAccess.requireOrganization(userScope, organizationPartyId)
    const customerPartyId = text(p.customerPartyId)
    if (!customerPartyId) denied("CUSTOMER_REQUIRED", "Choose the customer")
    const account = salesAccess.requireAccount(userScope, customerPartyId)
    if (account.organizationPartyId && account.organizationPartyId !== organizationPartyId)
        denied("CUSTOMER_INVALID", "The customer is an account of another organization")
    let opportunity = null
    const salesOpportunityId = text(p.salesOpportunityId)
    if (salesOpportunityId) {
        opportunity = salesAccess.requireOpportunity(userScope, salesOpportunityId).opportunity
        if (opportunity.organizationPartyId !== organizationPartyId)
            denied("OPPORTUNITY_INVALID", "The opportunity is of another organization")
        if (opportunity.accountPartyId && opportunity.accountPartyId !== customerPartyId)
            denied("OPPORTUNITY_INVALID", "The opportunity is for another account")
    }
    const contactPartyId = text(p.contactPartyId)
    if (
        contactPartyId &&
        !salesAccess.contactAccounts(userScope, contactPartyId).some(row => row.party.partyId === customerPartyId)
    )
        denied("CONTACT_INVALID", "The contact is not a contact of the customer")
    const productStoreId = text(p.productStoreId)
    if (productStoreId && one("mantle.product.store.ProductStore", {productStoreId})?.organizationPartyId !== organizationPartyId)
        denied("STORE_INVALID", "Choose a store of the selling organization")
    const preference =
        call("mantle.ledger.LedgerServices.find#PartyAcctgPreference", {organizationPartyId}).partyAcctgPreference || {}
    const currencyUomId = text(p.currencyUomId) || opportunity?.currencyUomId || preference.baseCurrencyUomId || null
    if (!currencyUomId) denied("CURRENCY_REQUIRED", "Choose the quote's currency")
    if (one("moqui.basic.Uom", {uomId: currencyUomId})?.uomTypeEnumId !== "UT_CURRENCY_MEASURE")
        denied("CURRENCY_INVALID", "Choose a currency")
    const validFromDate = dateOf(p.validFromDate, "Valid from") || ec.user.nowTimestamp
    // P9: with no end given, the organization's quote validity in days from the start (SalesPolicy; none, an open end)
    const validityDays = Number(approvals().policyOf(organizationPartyId)?.quoteValidityDays || 0)
    const validThruDate =
        dateOf(p.validThruDate, "Valid through") || (validityDays > 0 ? new Date(ms(validFromDate) + validityDays * dayMs) : null)
    if (validThruDate && ms(validThruDate) <= ms(validFromDate))
        denied("VALIDITY_INVALID", "Valid through must be after valid from")
    const created = call("mantle.order.OrderServices.create#Order", {
        vendorPartyId: organizationPartyId,
        customerPartyId,
        currencyUomId,
        productStoreId,
        orderName: text(p.orderName) || (opportunity ? opportunity.opportunityName : null),
        orderPurposeEnumId: purpose,
        statusId: "OrderOpen",
        validFromDate,
        validThruDate,
        postalContactMechId: customerAddress(customerPartyId),
        otherPartyOrderId: text(p.otherPartyOrderId)
    })
    const assign = (partyId, roleTypeId) => {
        if (partyId && !one(PART_PARTY, {orderId: created.orderId, orderPartSeqId: created.orderPartSeqId, partyId, roleTypeId}))
            call("create#" + PART_PARTY, {orderId: created.orderId, orderPartSeqId: created.orderPartSeqId, partyId, roleTypeId})
    }
    assign(userScope.partyId, roles.owner)
    assign(teamFor(userScope, organizationPartyId, salesOpportunityId), roles.team)
    assign(contactPartyId, roles.contact)
    if (salesOpportunityId) call("create#" + ORDER_LINK, {salesOpportunityId, orderId: created.orderId})
    const order = one(ORDER, {orderId: created.orderId})
    return {orderId: created.orderId, orderPartSeqId: created.orderPartSeqId, orderRevision: revisionOf(order)}
}

// ===== update#Quote =====
// A draft's name, validity, customer reference (the customer's PO) and address (one of the customer's).
function updateQuote(p) {
    const userScope = salesAccess.scope()
    const quote = salesAccess.requireQuote(userScope, text(p.orderId), true)
    requireDraft(quote)
    requireRevision(quote.order, p.orderRevision)
    if (p.orderName != null) call("update#" + ORDER, {orderId: quote.order.orderId, orderName: text(p.orderName)})
    const changes = {}
    if (p.validFromDate != null) changes.validFromDate = dateOf(p.validFromDate, "Valid from")
    if (p.validThruDate != null) changes.validThruDate = dateOf(p.validThruDate, "Valid through")
    const from = changes.validFromDate != null ? changes.validFromDate : quote.part.validFromDate
    const thru = changes.validThruDate != null ? changes.validThruDate : quote.part.validThruDate
    if (from && thru && ms(thru) <= ms(from)) denied("VALIDITY_INVALID", "Valid through must be after valid from")
    if (p.otherPartyOrderId != null) changes.otherPartyOrderId = text(p.otherPartyOrderId)
    if (!blank(p.postalContactMechId)) {
        if (!customerAddresses(quote.customerPartyId).includes(String(p.postalContactMechId)))
            denied("ADDRESS_INVALID", "Choose an address of the customer")
        changes.postalContactMechId = String(p.postalContactMechId)
    }
    if (Object.keys(changes).length)
        call("update#" + PART, Object.assign({orderId: quote.order.orderId, orderPartSeqId: quote.part.orderPartSeqId}, changes))
    return {orderId: quote.order.orderId, orderRevision: revisionOf(one(ORDER, {orderId: quote.order.orderId}))}
}

// ===== lines =====
// The seller's price of a product for the quote's customer (get#SellerProductPrice, the seller's authority after the quote checks).
function resolvedPrice(quote, productId, quantity, quantityUomId) {
    return call("mantle.product.PriceServices.get#SellerProductPrice", {
        productId,
        organizationPartyId: quote.organizationPartyId,
        customerPartyId: quote.customerPartyId,
        productStoreId: quote.order.productStoreId || null,
        quantity,
        quantityUomId: quantityUomId || null,
        priceUomId: quote.order.currencyUomId,
        validDate: ec.user.nowTimestamp
    })
}
// The price fields of a line from its resolved price and the rep's choice: the calculated basis and provenance always; the entered
// price or the free line with its reason and actor, or the calculated price (PRICE_UNAVAILABLE when there is none).
function priceFields(userScope, quote, productId, price, p, current) {
    const fields = {
        calculatedUnitAmount: price.priceAvailable ? price.price : null,
        unitListPrice: price.listPriceAvailable ? price.listPrice : null,
        productPriceId: price.productPriceId || null,
        priceListId: price.priceListId || null,
        priceRuleId: price.priceRuleId || null
    }
    const free = flag(p.freeLine)
    const entered = !blank(p.unitAmount)
    const keepOverride =
        current && !free && !entered && !flag(p.useCalculatedPrice) && ["manual", "free"].includes(current.priceSource)
    if (free || entered) {
        const reason = text(p.overrideReason)
        if (!reason) denied("OVERRIDE_REASON_REQUIRED", "Give the reason for the entered price")
        const unitAmount = free ? toDecimal(0) : decimal(p.unitAmount, "price", true)
        // P9: a free or zero line an approval rule will need approved is the rep's to draft; elsewhere a sales approver's
        if (
            unitAmount.isZero() &&
            !userScope.capabilities.approve &&
            !approvals().freeLineCovered(quote, {productId, calculatedUnitAmount: fields.calculatedUnitAmount})
        )
            denied("FREE_LINE_DENIED", "No approval rule covers a free line here; it needs a sales approver (SALES_APPROVE)")
        return Object.assign(fields, {
            unitAmount,
            isModifiedPrice: "Y",
            priceSource: unitAmount.isZero() ? "free" : "manual",
            priceOverrideReason: reason,
            priceOverrideUserId: ec.user.userId,
            priceOverrideDate: ec.user.nowTimestamp,
            unitAmount_changeReason: reason
        })
    }
    if (keepOverride) return fields
    if (!price.priceAvailable)
        denied("PRICE_UNAVAILABLE", "No price is set for this product and customer; enter a price with its reason")
    return Object.assign(fields, {
        unitAmount: price.price,
        isModifiedPrice: "N",
        priceSource: price.priceSource || "product-price",
        priceOverrideReason: null,
        priceOverrideUserId: null,
        priceOverrideDate: null
    })
}
// store#QuoteLine: a draft's product line (new: a product usable for selling, at the resolved price unless one is entered;
// changed: quantity, unit, entered price or back to the calculated one, description, required date) or shipping charge line
// (itemTypeEnumId ItemShipping: an amount the rep enters, the storeless quote's freight).
function storeLine(p) {
    const userScope = salesAccess.scope()
    const quote = salesAccess.requireQuote(userScope, text(p.orderId), true)
    requireDraft(quote)
    requireRevision(quote.order, p.orderRevision)
    const orderId = quote.order.orderId
    const orderItemSeqId = text(p.orderItemSeqId)
    const requiredByDate = p.requiredByDate == null ? undefined : dateOf(p.requiredByDate, "Required by")
    if (orderItemSeqId) {
        const item = one(ITEM, {orderId, orderItemSeqId})
        if (!item || taxTypes.includes(item.itemTypeEnumId) || item.parentItemSeqId)
            denied("ITEM_UNAVAILABLE", "Line " + orderItemSeqId + " is not on quote " + orderId)
        const changes = {orderId, orderItemSeqId}
        if (p.itemDescription != null) changes.itemDescription = text(p.itemDescription)
        if (requiredByDate != null) changes.requiredByDate = requiredByDate
        if (item.itemTypeEnumId === kinds.shipping) {
            if (!blank(p.unitAmount)) changes.unitAmount = decimal(p.unitAmount, "shipping amount", true)
        } else {
            const quantity = blank(p.quantity) ? toDecimal(item.quantity ?? 1) : decimal(p.quantity, "quantity", false)
            const quantityUomId = text(p.quantityUomId) || item.quantityUomId
            changes.quantity = quantity
            if (quantityUomId) changes.quantityUomId = quantityUomId
            if (item.productId) {
                const price = resolvedPrice(quote, item.productId, quantity, quantityUomId)
                Object.assign(changes, priceFields(userScope, quote, item.productId, price, p, item))
            } else if (!blank(p.unitAmount)) changes.unitAmount = decimal(p.unitAmount, "price", true)
        }
        call("update#" + ITEM, changes)
        return {orderId, orderItemSeqId, orderRevision: revisionOf(one(ORDER, {orderId}))}
    }
    const itemTypeEnumId = text(p.itemTypeEnumId) || kinds.product
    if (itemTypeEnumId === kinds.shipping) {
        const created = call("mantle.order.OrderServices.create#OrderItem", {
            orderId,
            orderPartSeqId: quote.part.orderPartSeqId,
            itemTypeEnumId,
            quantity: toDecimal(1),
            unitAmount: decimal(p.unitAmount, "shipping amount", true),
            itemDescription: text(p.itemDescription) || L("Shipping"),
            priceSource: "manual",
            requireInventory: false
        })
        return {orderId, orderItemSeqId: created.orderItemSeqId, orderRevision: revisionOf(one(ORDER, {orderId}))}
    }
    if (itemTypeEnumId !== kinds.product) denied("ITEM_TYPE_INVALID", "A quote line is a product or a shipping charge")
    const productId = text(p.productId)
    if (!productId || !one("mantle.product.Product", {productId})) denied("PRODUCT_REQUIRED", "Choose a product")
    const quantity = decimal(blank(p.quantity) ? 1 : p.quantity, "quantity", false)
    const usable = call("mantle.product.ProductServices.check#ProductUsable", {
        productId,
        usage: "Sell",
        quantity,
        productStoreId: quote.order.productStoreId || null,
        vendorPartyId: quote.organizationPartyId,
        customerPartyId: quote.customerPartyId
    })
    if (!usable.usable) denied("PRODUCT_NOT_USABLE", usable.reason || productId + " is not usable for selling")
    const quantityUomId = text(p.quantityUomId)
    const price = resolvedPrice(quote, productId, quantity, quantityUomId)
    const link = rows(ORDER_LINK, {orderId})[0]
    const line = Object.assign(
        {
            orderId,
            orderPartSeqId: quote.part.orderPartSeqId,
            productId,
            quantity,
            quantityUomId,
            itemTypeEnumId,
            itemDescription: text(p.itemDescription),
            requiredByDate: requiredByDate || null,
            salesOpportunityId: link?.salesOpportunityId || null,
            requireInventory: false
        },
        priceFields(userScope, quote, productId, price, p, null)
    )
    const created = call("mantle.order.OrderServices.create#OrderItem", line)
    return {orderId, orderItemSeqId: created.orderItemSeqId, orderRevision: revisionOf(one(ORDER, {orderId}))}
}
// delete#QuoteLine: a draft's line removed, with its tax (the native delete, which retaxes the part).
function deleteLine(p) {
    const userScope = salesAccess.scope()
    const quote = salesAccess.requireQuote(userScope, text(p.orderId), true)
    requireDraft(quote)
    requireRevision(quote.order, p.orderRevision)
    const orderId = quote.order.orderId
    const item = blank(p.orderItemSeqId) ? null : one(ITEM, {orderId, orderItemSeqId: String(p.orderItemSeqId)})
    if (!item || taxTypes.includes(item.itemTypeEnumId) || item.parentItemSeqId)
        denied("ITEM_UNAVAILABLE", "Line " + (p.orderItemSeqId || "") + " is not on quote " + orderId)
    call("mantle.order.OrderServices.delete#OrderItem", {orderId, orderItemSeqId: item.orderItemSeqId})
    return {orderId, orderRevision: revisionOf(one(ORDER, {orderId}))}
}

// ===== get#Quote =====
const historyFields = {
    "mantle.order.OrderHeader": {statusId: "Status"},
    "mantle.order.OrderItem": {
        quantity: "Quantity",
        unitAmount: "Price",
        calculatedUnitAmount: "Calculated price",
        priceOverrideReason: "Price reason",
        productId: "Product"
    }
}
function history(orderId) {
    const found = Array.from(
        find("moqui.entity.EntityAuditLog")
            .condition("changedEntityName", "in", Object.keys(historyFields))
            .condition("pkPrimaryValue", orderId)
            .orderBy("-changedDate")
            .limit(50)
            .list()
    ).filter(row => historyFields[row.changedEntityName]?.[row.changedFieldName])
    const users = {}
    for (const userId of Array.from(new Set(found.map(row => row.changedByUserId).filter(Boolean)))) {
        const account = one("moqui.security.UserAccount", {userId})
        users[userId] = account?.userFullName || account?.username || userId
    }
    return found.map(row => ({
        changedText: lib.dateText(row.changedDate),
        fieldText: L(historyFields[row.changedEntityName][row.changedFieldName]),
        lineText: row.changedEntityName === "mantle.order.OrderItem" ? row.pkSecondaryValue || "" : "",
        oldText: row.oldValueText || "",
        newText: row.newValueText || "",
        reason: row.changeReason || "",
        userName: users[row.changedByUserId] || ""
    }))
}
// The tax gateway note of a quote: the store's gateway, the seller's (X1), or none.
function taxNote(quote) {
    const store = quote.order.productStoreId
        ? one("mantle.product.store.ProductStore", {productStoreId: quote.order.productStoreId})
        : null
    const configId = store
        ? store.taxGatewayConfigId
        : (
              call("mantle.ledger.LedgerServices.find#PartyAcctgPreference", {organizationPartyId: quote.organizationPartyId})
                  .partyAcctgPreference || {}
          ).taxGatewayConfigId
    const config = configId ? one("mantle.other.tax.TaxGatewayConfig", {taxGatewayConfigId: configId}) : null
    if (!config) return L("No tax: the seller has no tax gateway")
    const note =
        (store ? L("Tax by the store's gateway") : L("Tax by the seller's gateway")) +
        " (" +
        (config.description || configId) +
        ")"
    // X1 taxes a storeless part at its address, else the customer's when the quote changes, and leaves it untaxed with neither; a
    // customer address added later is taken at the next change, so a quote with no address of its own says where to set it
    if (!store && !quote.part.postalContactMechId)
        return note + " · " + L("the quote has no address: choose the customer's in Edit quote to tax at it")
    return note
}
// OrderDetail's quote as the caller may see it (SalesAccess.js quoteOf), else quoteFound false: its facts with names, validity,
// owner, team and opportunity (when the caller sees it), lines with their price provenance and tax, the totals by kind, the tax
// note, the history of its audited fields and what the caller may do. No cost or margin.
function getQuote(p) {
    const userScope = salesAccess.scope()
    const quote = salesAccess.quoteOf(userScope, text(p.orderId))
    if (!quote) return {quoteFound: false}
    const {order, part} = quote
    const currencyUomId = order.currencyUomId
    const items = rows(ITEM, {orderId: order.orderId}).sort((a, b) =>
        String(a.orderItemSeqId).localeCompare(String(b.orderItemSeqId))
    )
    const taxOf = itemSeqId =>
        items
            .filter(item => item.parentItemSeqId === itemSeqId && taxTypes.includes(item.itemTypeEnumId))
            .reduce((sum, item) => sum.add(toDecimal(item.quantity ?? 1).multiply(toDecimal(item.unitAmount ?? 0))), toDecimal(0))
    const productIds = Array.from(new Set(items.map(item => item.productId).filter(Boolean)))
    const products = productIds.length
        ? Object.fromEntries(
              Array.from(find("mantle.product.Product").condition("productId", "in", productIds).list()).map(row => [
                  row.productId,
                  row
              ])
          )
        : {}
    const overrideUsers = {}
    for (const userId of Array.from(new Set(items.map(item => item.priceOverrideUserId).filter(Boolean)))) {
        const account = one("moqui.security.UserAccount", {userId})
        overrideUsers[userId] = account?.userFullName || account?.username || userId
    }
    const totals = {products: toDecimal(0), shipping: toDecimal(0), tax: toDecimal(0)}
    const lines = []
    for (const item of items) {
        const amount = toDecimal(item.quantity ?? 1).multiply(toDecimal(item.unitAmount ?? 0))
        if (taxTypes.includes(item.itemTypeEnumId)) {
            totals.tax = totals.tax.add(amount)
            continue
        }
        if (item.itemTypeEnumId === kinds.shipping) totals.shipping = totals.shipping.add(amount)
        else totals.products = totals.products.add(amount)
        if (item.parentItemSeqId) continue
        const product = item.productId ? products[item.productId] : null
        const tax = taxOf(item.orderItemSeqId)
        const overridden = ["manual", "free"].includes(item.priceSource) && !!item.productId
        lines.push({
            orderItemSeqId: item.orderItemSeqId,
            itemTypeEnumId: item.itemTypeEnumId,
            shipping: item.itemTypeEnumId === kinds.shipping,
            productId: item.productId || null,
            productName: product ? product.productName || product.productId : "",
            description: item.itemDescription || product?.productName || "",
            quantity: item.quantity,
            quantityText: quantityText(item.quantity),
            quantityUomId: item.quantityUomId || null,
            unitAmount: item.unitAmount,
            unitText: moneyText(item.unitAmount ?? 0, currencyUomId),
            amountText: moneyText(amount, currencyUomId),
            calculatedText:
                item.calculatedUnitAmount == null
                    ? item.productId
                        ? L("No price set")
                        : ""
                    : moneyText(item.calculatedUnitAmount, currencyUomId),
            priceAvailable: item.calculatedUnitAmount != null,
            priceSource: item.priceSource || null,
            priceSourceText: L(sourceTexts[item.priceSource] || (item.productId ? "Price" : "Entered amount")),
            overridden,
            overrideReason: item.priceOverrideReason || "",
            overrideText: overridden
                ? [overrideUsers[item.priceOverrideUserId], dayText(item.priceOverrideDate)].filter(Boolean).join(" · ")
                : "",
            taxText: tax.isZero() ? "" : moneyText(tax, currencyUomId),
            requiredByText: dayText(item.requiredByDate)
        })
    }
    const now = ms(ec.user.nowTimestamp)
    const thru = ms(part.validThruDate)
    const links = rows(ORDER_LINK, {orderId: order.orderId})
    const opportunity = links
        .map(link => salesAccess.opportunityOf(userScope, link.salesOpportunityId))
        .find(found => !!found)?.opportunity
    const partParties = rows(PART_PARTY, {orderId: order.orderId, orderPartSeqId: part.orderPartSeqId})
    const partyOf = roleTypeId => partParties.find(row => row.roleTypeId === roleTypeId)?.partyId || null
    const account = salesAccess.accountOf(userScope, quote.customerPartyId)
    const store = order.productStoreId ? one("mantle.product.store.ProductStore", {productStoreId: order.productStoreId}) : null
    const draft = draftStatuses.includes(order.statusId)
    const purposeEnum = one("moqui.basic.Enumeration", {enumId: order.orderPurposeEnumId})
    return {
        quoteFound: true,
        quote: {
            orderId: order.orderId,
            orderPartSeqId: part.orderPartSeqId,
            orderName: order.orderName || "",
            statusId: order.statusId,
            statusText: statusText(order.statusId),
            purposeText: purposeEnum?.description || "",
            orderRevision: revisionOf(order),
            organizationPartyId: quote.organizationPartyId,
            organizationName: partyName(quote.organizationPartyId),
            customerPartyId: account ? quote.customerPartyId : null,
            customerName: account ? partyName(quote.customerPartyId) : "",
            contactName: partyOf(roles.contact) ? partyName(partyOf(roles.contact)) : "",
            ownerName: partyOf(roles.owner) ? partyName(partyOf(roles.owner)) : "",
            teamName: partyOf(roles.team) ? partyName(partyOf(roles.team)) : "",
            salesOpportunityId: opportunity?.salesOpportunityId || null,
            opportunityName: opportunity ? opportunity.opportunityName || opportunity.salesOpportunityId : "",
            currencyUomId,
            productStoreId: order.productStoreId || null,
            storeName: store ? store.storeName || store.productStoreId : "",
            storeless: !order.productStoreId,
            entryText: dayText(order.entryDate),
            validFromDate: part.validFromDate,
            validThruDate: part.validThruDate,
            validFromText: dayText(part.validFromDate),
            validThruText: dayText(part.validThruDate),
            expired: thru != null && thru < now,
            otherPartyOrderId: part.otherPartyOrderId || "",
            postalContactMechId: part.postalContactMechId || null,
            addressText: addressText(part.postalContactMechId),
            productsText: moneyText(totals.products, currencyUomId),
            shippingText: moneyText(totals.shipping, currencyUomId),
            taxTotalText: moneyText(totals.tax, currencyUomId),
            grandTotal: order.grandTotal,
            totalText: moneyText(order.grandTotal ?? 0, currencyUomId),
            taxNote: taxNote(quote),
            canEdit: draft && quote.canEdit,
            canFreeLine:
                draft &&
                quote.canEdit &&
                (!!userScope.capabilities.approve ||
                    approvals().freeLineCovered(quote, {productId: null, calculatedUnitAmount: toDecimal(1)}))
        },
        // P9: the approvals the quote needs at its revision (SalesApprovals.js; preview#Quote's answer)
        approval: approvals().summary(userScope, quote),
        lines,
        history: history(order.orderId),
        addresses: customerAddresses(quote.customerPartyId).map(contactMechId => ({
            value: contactMechId,
            label: addressText(contactMechId)
        }))
    }
}

// ===== explain#QuoteLinePrice =====
// The safe explanation of a quote line's price for a rep (design §7: the selected price, where it came from, the entered price
// and its reason); the full trace is Products' PriceExplain for a holder of PRICE_VIEW. No cost, no other party's price.
function explainLine(p) {
    const userScope = salesAccess.scope()
    const quote = salesAccess.requireQuote(userScope, text(p.orderId))
    const item = blank(p.orderItemSeqId)
        ? null
        : one(ITEM, {orderId: quote.order.orderId, orderItemSeqId: String(p.orderItemSeqId)})
    if (!item || !item.productId)
        denied("ITEM_UNAVAILABLE", "Line " + (p.orderItemSeqId || "") + " is not a product line of the quote")
    const currencyUomId = quote.order.currencyUomId
    const current = resolvedPrice(quote, item.productId, item.quantity ?? 1, item.quantityUomId)
    const list = item.priceListId ? one("mantle.product.ProductPriceList", {priceListId: item.priceListId}) : null
    const product = one("mantle.product.Product", {productId: item.productId})
    return {
        explanation: {
            orderId: quote.order.orderId,
            orderItemSeqId: item.orderItemSeqId,
            productId: item.productId,
            productName: product?.productName || item.productId,
            customerPartyId: quote.customerPartyId,
            organizationPartyId: quote.organizationPartyId,
            currencyUomId,
            quantityText: quantityText(item.quantity),
            unitText: moneyText(item.unitAmount ?? 0, currencyUomId),
            priceSourceText: L(sourceTexts[item.priceSource] || "Price"),
            calculatedText:
                item.calculatedUnitAmount == null ? L("No price set") : moneyText(item.calculatedUnitAmount, currencyUomId),
            listText: item.unitListPrice == null ? "" : moneyText(item.unitListPrice, currencyUomId),
            priceListName: list ? list.priceListName || list.priceListId : "",
            customerPrice:
                !!item.productPriceId &&
                !!one("mantle.product.ProductPrice", {productPriceId: item.productPriceId})?.customerPartyId,
            overridden: ["manual", "free"].includes(item.priceSource),
            overrideReason: item.priceOverrideReason || "",
            currentText: current.priceAvailable ? moneyText(current.price, currencyUomId) : L("No price set"),
            currentChanged:
                current.priceAvailable &&
                item.calculatedUnitAmount != null &&
                !toDecimal(current.price).eq(item.calculatedUnitAmount)
        }
    }
}

// ===== check#QuoteAccess =====
// Whether the caller sees the quote and may change it (get#RecordLinkInfo and RecordFiles for a quote not placed); a call with no
// user sees none.
function quoteAccess(p) {
    if (!ec.user.userId) return {recordVisible: false, canEdit: false}
    const found = salesAccess.quoteOf(salesAccess.scope(), text(p.orderId))
    return {recordVisible: !!found, canEdit: !!found?.canEdit}
}

const operations = {findQuotes, createQuote, updateQuote, storeLine, deleteLine, getQuote, explainLine, quoteAccess}
;({
    execute: (op, parameters) => {
        if (!operations[op]) throw new Error("Unknown sales quote operation " + op)
        return operations[op](parameters)
    }
})
