// Sales' quote templates (mantle.order.SalesQuoteServices, Q of IronStone Sales design §12.1; design §5 QuoteTemplates and
// QuoteTemplateDetail, §17 SAL-TEMPLATE; impl-sales P12, §4 Nov 11, 2026).
//
// - A template is the native OrderHeader, OrderPart and OrderItem of purpose SalesQuoteTemplate (orderPurposeEnumId
//   OrpSalesQuoteTemplate), never a table of its own: one part of a selling organization with no customer, Open for ever
//   (OrderServices.update#OrderStatus refuses it any other status), in one currency. Its published interval is the part's validity:
//   a draft has none; publish#QuoteTemplate gives it a start (and ends the template it succeeds from that start); end#QuoteTemplate
//   gives it an end. A published template is not changed: store#QuoteTemplate with a predecessor starts its successor, a draft copy
//   made with clone#Order, whose parentOrderId names the template it replaces.
// - Access (SalesAccess.js templateOf): a Sales reader sees the current templates of the organizations of their scope; a template
//   manager (SALES_QUOTE_EDIT with SALES_TEAM_MANAGE or SALES_CONFIGURE) every one, and changes a draft only. A template outside the
//   scope answers RECORD_UNAVAILABLE.
// - Lines are the quote draft's (store#QuoteLine and delete#QuoteLine admit a template draft, SalesQuotes.js): a product at the
//   price of the quote's own date, a fixed price entered with its reason (a free one under the quote's free-line rule), or a
//   shipping charge. A quote is copied from a current template by create#Quote (templateOrderId) through clone#Order
//   (copyPayment false, no notes, files or parties) and priced as of its own date: each product line at the seller's price for the
//   quote's customer now, a fixed line keeping its price and reason with today's calculated basis beside it, a line with no price
//   left for the rep to enter (propose#Quote refuses it until then). The quote's parentOrderId names the template; a successor
//   changes no quote made from the template before it.
// - Every reader that leaves out a recurring base (OrpRecurringTemplate, F7) leaves this purpose out too, so a template never
//   reserves, invoices, counts as an order or credit, or is offered as a quote (SalesAccess.js quoteOf and orderOf read their own
//   purposes). Cost is never read or answered here.
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const salesAccess = ec.resource.script("component://mr-mantle/service/mantle/sales/SalesAccess.js")
const {find, one, rows, denied, call, ms} = lib
const quotes = () => ec.resource.script("component://mr-mantle/service/mantle/order/SalesQuotes.js")
const approvals = () => ec.resource.script("component://mr-mantle/service/mantle/order/SalesApprovals.js")

const ORDER = "mantle.order.OrderHeader"
const PART = "mantle.order.OrderPart"
const ITEM = "mantle.order.OrderItem"
const purpose = salesAccess.templatePurpose
const taxTypes = ["ItemSalesTax", "ItemVatTax"]
const shippingType = "ItemShipping"
const fixedSources = ["manual", "free"]
const stateTexts = {draft: "Draft", scheduled: "Scheduled", current: "Published", ended: "Ended"}
const stateNames = ["open", "current", "draft", "scheduled", "ended", "all"]

const blank = value => value == null || String(value).trim() === ""
const text = value => (blank(value) ? null : String(value).trim())
const L = value => ec.l10n.localize(value)
const dayText = value => (value == null || value === "" ? "" : ec.l10n.format(new Date(ms(value)), "d MMM yyyy"))
const moneyText = (value, currencyUomId) =>
    value == null ? "" : ec.l10n.formatCurrency(ec.l10n.roundCurrency(toDecimal(value), currencyUomId), currencyUomId)
const quantityText = value => (value == null ? "" : String(Number(String(value))))
const likeText = value => "%" + String(value).replace(/[\\%_]/g, character => "\\" + character) + "%"
const partyName = partyId => (partyId ? lib.partyNames([partyId])[partyId] || partyId : "")
const nowMs = () => ms(ec.user.nowTimestamp)

function revisionOf(order) {
    return Number(order.orderRevision ?? 1)
}
function requireRevision(order, given) {
    if (blank(given)) denied("REVISION_REQUIRED", "Reload the template and try again (revision " + revisionOf(order) + ")")
    if (Number(given) !== revisionOf(order))
        denied("REVISION_CHANGED", "Quote template " + order.orderId + " changed; its current revision is " + revisionOf(order))
}
function dateOf(value, label) {
    if (blank(value)) return null
    const millis = ms(value)
    if (!Number.isFinite(millis)) denied("DATE_INVALID", label + " is not a date")
    return new Date(millis)
}
function validityDays(value) {
    if (blank(value)) return null
    const days = Number(value)
    if (!Number.isInteger(days) || days < 0) denied("VALIDITY_INVALID", "Enter the days a quote is valid for, or leave it empty")
    return days
}
function requireManager(userScope) {
    if (!salesAccess.templateManager(userScope))
        denied("PERMISSION_DENIED", "Quote templates are maintained by a Sales manager or administrator")
}
function intervalText(part) {
    const from = dayText(part.validFromDate)
    const thru = dayText(part.validThruDate)
    if (!from) return L("Not published")
    return thru ? from + " – " + thru : L("From") + " " + from
}
// The template's lines (no tax line or child), sorted.
function linesOf(orderId) {
    return rows(ITEM, {orderId})
        .filter(item => !taxTypes.includes(item.itemTypeEnumId) && !item.parentItemSeqId)
        .sort((a, b) => String(a.orderItemSeqId).localeCompare(String(b.orderItemSeqId)))
}
// The drafts and published successors of a template (the templates whose parentOrderId names it).
function successorsOf(orderId) {
    return Array.from(find(ORDER).condition("parentOrderId", orderId).condition("orderPurposeEnumId", purpose).list()).map(
        order => ({order, part: rows(PART, {orderId: order.orderId})[0]})
    )
}

// ===== find#QuoteTemplates =====
// The templates of the caller's scope (design §5 TemplateList): a reader's current ones; a manager's in the state asked (open by
// default: drafts, scheduled and current; current; draft; scheduled; ended; all), by organization, text and product, paged.
function findTemplates(p) {
    const userScope = salesAccess.scope()
    salesAccess.requireCapability(userScope, "anyRead")
    const manager = salesAccess.templateManager(userScope)
    const organizationPartyId = text(p.organizationPartyId)
    if (organizationPartyId) salesAccess.requireOrganization(userScope, organizationPartyId)
    const state = manager ? text(p.state) || "open" : "current"
    if (!stateNames.includes(state)) denied("STATE_INVALID", "Choose a template state")
    const factory = ec.entity.conditionFactory
    const conditions = [factory.makeCondition("orderPurposeEnumId", "equals", purpose)]
    const add = (field, operator, value) => conditions.push(factory.makeCondition(field, operator, value))
    let none = false
    if (organizationPartyId) add("vendorPartyId", "equals", organizationPartyId)
    else if (userScope.organizationPartyIds != null) {
        if (!userScope.organizationPartyIds.length) none = true
        else add("vendorPartyId", "in", Array.from(userScope.organizationPartyIds))
    }
    const now = new Date(nowMs())
    const openEnd = () =>
        factory.makeCondition(
            [factory.makeCondition("validThruDate", "is-null", null), factory.makeCondition("validThruDate", "greater", now)],
            "or"
        )
    if (state === "draft") add("validFromDate", "is-null", null)
    else if (state === "scheduled") {
        add("validFromDate", "greater", now)
        conditions.push(openEnd())
    } else if (state === "current") {
        add("validFromDate", "less-equals", now)
        conditions.push(openEnd())
    } else if (state === "ended") add("validThruDate", "less-equals", now)
    else if (state === "open") conditions.push(openEnd())
    const productId = text(p.productId)
    if (productId) {
        const withProduct = Array.from(
            find(ITEM).condition("productId", productId).selectField("orderId").distinct(true).list()
        ).map(row => row.orderId)
        if (!withProduct.length) none = true
        else add("orderId", "in", withProduct)
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
            .selectField("currencyUomId")
            .selectField("vendorPartyId")
            .selectField("validFromDate")
            .selectField("validThruDate")
            .selectField("entryDate")
            .distinct(true)
    }
    const count = none ? 0 : query().count()
    const paged = lib.page(
        none ? query().condition("orderId", "_NONE_") : query().orderBy(["orderName", "-entryDate", "orderId"]),
        p,
        "templateList",
        count,
        {noLimitCap: 1000}
    )
    const pageRows = paged.rows
    const orderIds = pageRows.map(row => row.orderId)
    const names = lib.partyNames(pageRows.map(row => row.vendorPartyId))
    const headers = orderIds.length
        ? Object.fromEntries(Array.from(find(ORDER).condition("orderId", "in", orderIds).list()).map(row => [row.orderId, row]))
        : {}
    const lineCounts = {}
    if (orderIds.length)
        for (const item of Array.from(find(ITEM).condition("orderId", "in", orderIds).list()))
            if (!taxTypes.includes(item.itemTypeEnumId) && !item.parentItemSeqId)
                lineCounts[item.orderId] = (lineCounts[item.orderId] || 0) + 1
    const templateList = pageRows.map(row => {
        const rowState = salesAccess.templateState(row)
        return {
            orderId: row.orderId,
            orderName: row.orderName || row.orderId,
            description: headers[row.orderId]?.templateDescription || "",
            organizationPartyId: row.vendorPartyId,
            organizationName: names[row.vendorPartyId] || row.vendorPartyId,
            currencyUomId: row.currencyUomId,
            intervalText: intervalText(row),
            lineCount: lineCounts[row.orderId] || 0,
            state: rowState,
            stateText: L(stateTexts[rowState])
        }
    })
    return Object.assign(
        {templateList, canManage: manager},
        Object.fromEntries(Object.entries(paged).filter(([key]) => key.startsWith("templateList") && key !== "templateList"))
    )
}

// ===== get#QuoteTemplate =====
// QuoteTemplateDetail's template as the caller may see it, else templateFound false: its facts, state and interval, the template
// it replaces and its successor (when the caller sees them), its lines in the quote draft's shape (with each line's pricing: the
// quote's date or a fixed price and its reason), the history of its audited fields and what the caller may do.
function getTemplate(p) {
    const userScope = salesAccess.scope()
    const template = salesAccess.templateOf(userScope, text(p.orderId))
    if (!template) return {templateFound: false}
    const {order, part} = template
    const currencyUomId = order.currencyUomId
    const items = linesOf(order.orderId)
    const productIds = Array.from(new Set(items.map(item => item.productId).filter(Boolean)))
    const products = productIds.length
        ? Object.fromEntries(
              Array.from(find("mantle.product.Product").condition("productId", "in", productIds).list()).map(row => [
                  row.productId,
                  row
              ])
          )
        : {}
    let total = toDecimal(0)
    const lines = items.map(item => {
        const product = item.productId ? products[item.productId] : null
        const shipping = item.itemTypeEnumId === shippingType
        const fixed = !!item.productId && fixedSources.includes(item.priceSource)
        const amount = toDecimal(item.quantity ?? 1).multiply(toDecimal(item.unitAmount ?? 0))
        total = total.add(amount)
        return {
            orderItemSeqId: item.orderItemSeqId,
            itemTypeEnumId: item.itemTypeEnumId,
            shipping,
            productId: item.productId || null,
            productName: product ? product.productName || product.productId : "",
            description: item.itemDescription || product?.productName || "",
            quantity: item.quantity,
            quantityText: quantityText(item.quantity),
            unitAmount: item.unitAmount,
            // a line with no seller's price of its own shows none: each quote prices it for its customer
            unitText:
                item.unitAmount == null || (!!item.productId && !fixed && item.calculatedUnitAmount == null)
                    ? ""
                    : moneyText(item.unitAmount, currencyUomId),
            amountText: moneyText(amount, currencyUomId),
            calculatedText: item.calculatedUnitAmount == null ? "" : moneyText(item.calculatedUnitAmount, currencyUomId),
            priceAvailable: item.calculatedUnitAmount != null,
            overridden: fixed,
            fixed,
            overrideReason: item.priceOverrideReason || "",
            pricingText: shipping
                ? L("Charge as entered")
                : fixed
                  ? L(item.priceSource === "free" ? "Free line" : "Fixed price") +
                    (item.priceOverrideReason ? ": " + item.priceOverrideReason : "")
                  : L("Priced on the quote's date")
        }
    })
    const predecessor = order.parentOrderId ? salesAccess.templateOf(userScope, order.parentOrderId) : null
    const successors = template.canManage ? successorsOf(order.orderId) : []
    const draftSuccessor = successors.find(row => row.part && salesAccess.templateState(row.part) === "draft")
    const publishedSuccessor = successors.find(row => row.part && salesAccess.templateState(row.part) !== "draft")
    const manage = template.canManage
    return {
        templateFound: true,
        template: {
            orderId: order.orderId,
            orderPartSeqId: part.orderPartSeqId,
            orderName: order.orderName || "",
            templateDescription: order.templateDescription || "",
            templateValidityDays: order.templateValidityDays ?? null,
            validityText:
                order.templateValidityDays != null
                    ? String(order.templateValidityDays) + " " + L("days")
                    : L("The organization's default"),
            orderRevision: revisionOf(order),
            organizationPartyId: template.organizationPartyId,
            organizationName: partyName(template.organizationPartyId),
            currencyUomId,
            state: template.state,
            stateText: L(stateTexts[template.state]),
            intervalText: intervalText(part),
            validFromText: dayText(part.validFromDate),
            validThruText: dayText(part.validThruDate),
            enteredByName: partyName(order.enteredByPartyId),
            entryText: dayText(order.entryDate),
            exampleTotalText: moneyText(total, currencyUomId),
            predecessorOrderId: predecessor ? order.parentOrderId : null,
            predecessorName: predecessor ? predecessor.order.orderName || order.parentOrderId : "",
            successorOrderId: (draftSuccessor || publishedSuccessor)?.order.orderId || null,
            successorName: (draftSuccessor || publishedSuccessor)?.order.orderName || "",
            canManage: manage,
            canEdit: template.canEdit,
            canPublish: template.canEdit && lines.length > 0,
            canSucceed: manage && template.state !== "draft" && !draftSuccessor && !publishedSuccessor,
            canEnd: manage && ["draft", "scheduled", "current"].includes(template.state),
            canQuote: template.state === "current" && !!userScope.capabilities.quoteEdit,
            canFreeLine:
                template.canEdit &&
                (!!userScope.capabilities.approve ||
                    approvals().freeLineCovered(template, {productId: null, calculatedUnitAmount: toDecimal(1)}))
        },
        lines,
        history: quotes().history(order.orderId)
    }
}

// ===== store#QuoteTemplate =====
// A template's header: a new draft (name, organization of the scope, description, currency, default validity), a draft's changes
// at its revision, or the successor of a published template (a draft copy of it, its lines included, that replaces it when
// published).
function storeTemplate(p) {
    const userScope = salesAccess.scope()
    salesAccess.requireCapability(userScope, "anyRead")
    requireManager(userScope)
    const days = validityDays(p.templateValidityDays)
    if (text(p.orderId)) {
        const template = salesAccess.requireTemplate(userScope, text(p.orderId), true)
        requireRevision(template.order, p.orderRevision)
        const changes = {orderId: template.order.orderId}
        if (p.orderName != null) {
            if (!text(p.orderName)) denied("NAME_REQUIRED", "Name the template")
            changes.orderName = text(p.orderName)
        }
        if (p.templateDescription != null) changes.templateDescription = text(p.templateDescription)
        if (p.templateValidityDays != null) changes.templateValidityDays = days
        const currencyUomId = text(p.currencyUomId)
        if (currencyUomId && currencyUomId !== template.order.currencyUomId) {
            if (linesOf(template.order.orderId).length)
                denied("CURRENCY_FIXED", "The template has lines in " + template.order.currencyUomId + "; its currency stays")
            changes.currencyUomId = requireCurrency(currencyUomId)
        }
        call("update#" + ORDER, changes)
        return {orderId: template.order.orderId, orderRevision: revisionOf(one(ORDER, {orderId: template.order.orderId}))}
    }
    const predecessorOrderId = text(p.predecessorOrderId)
    if (predecessorOrderId) {
        const predecessor = salesAccess.requireTemplate(userScope, predecessorOrderId)
        if (predecessor.state === "draft")
            denied("TEMPLATE_DRAFT", "Quote template " + predecessorOrderId + " is a draft; change it as it is")
        const existing = successorsOf(predecessorOrderId)[0]
        if (existing)
            denied("SUCCESSOR_EXISTS", "Quote template " + predecessorOrderId + " has its successor " + existing.order.orderId)
        const cloned = call("mantle.order.OrderServices.clone#Order", {
            baseOrderId: predecessorOrderId,
            statusId: "OrderOpen",
            orderPurposeEnumId: purpose,
            orderName: text(p.orderName) || predecessor.order.orderName,
            enteredByPartyId: userScope.partyId,
            productItemsOnly: false,
            copyContactMech: false,
            copyContent: false,
            copyNote: false,
            copyPartParty: false,
            copyItemWorkEffort: false,
            copyPayment: false
        })
        for (const item of rows(ITEM, {orderId: cloned.orderId}).filter(item => taxTypes.includes(item.itemTypeEnumId)))
            call("delete#" + ITEM, {orderId: cloned.orderId, orderItemSeqId: item.orderItemSeqId})
        return {orderId: cloned.orderId, orderRevision: revisionOf(one(ORDER, {orderId: cloned.orderId}))}
    }
    const organizationPartyId = text(p.organizationPartyId) || salesAccess.defaultOrganization(userScope)
    if (!organizationPartyId) denied("ORGANIZATION_DENIED", "Choose the selling organization")
    if (!salesAccess.isInternal(organizationPartyId))
        denied("ORGANIZATION_DENIED", "Organization " + organizationPartyId + " is not available")
    salesAccess.requireOrganization(userScope, organizationPartyId)
    const orderName = text(p.orderName)
    if (!orderName) denied("NAME_REQUIRED", "Name the template")
    const preference =
        call("mantle.ledger.LedgerServices.find#PartyAcctgPreference", {organizationPartyId}).partyAcctgPreference || {}
    const currencyUomId = requireCurrency(text(p.currencyUomId) || preference.baseCurrencyUomId)
    const created = call("mantle.order.OrderServices.create#Order", {
        vendorPartyId: organizationPartyId,
        currencyUomId,
        orderName,
        orderPurposeEnumId: purpose,
        statusId: "OrderOpen",
        templateDescription: text(p.templateDescription),
        templateValidityDays: days
    })
    return {orderId: created.orderId, orderRevision: revisionOf(one(ORDER, {orderId: created.orderId}))}
}
function requireCurrency(currencyUomId) {
    if (!currencyUomId) denied("CURRENCY_REQUIRED", "Choose the template's currency")
    if (one("moqui.basic.Uom", {uomId: currencyUomId})?.uomTypeEnumId !== "UT_CURRENCY_MEASURE")
        denied("CURRENCY_INVALID", "Choose a currency")
    return currencyUomId
}
function setPublished(order, part, fromDate, thruDate) {
    call("update#" + PART, {
        orderId: order.orderId,
        orderPartSeqId: part.orderPartSeqId,
        validFromDate: fromDate,
        validThruDate: thruDate
    })
}

// ===== publish#QuoteTemplate =====
// A draft published from its start (now, or a later date) to its end (none, or a date after the start); the template it succeeds
// ends at that start, so one template of the line is current at a time. Refuses a draft with no lines (LINES_REQUIRED), a start in
// the past (DATE_INVALID) and a predecessor another successor already replaced (SUCCESSOR_EXISTS).
function publishTemplate(p) {
    const userScope = salesAccess.scope()
    const template = salesAccess.requireTemplate(userScope, text(p.orderId), true)
    requireRevision(template.order, p.orderRevision)
    if (!linesOf(template.order.orderId).length) denied("LINES_REQUIRED", "Add a line before publishing the template")
    const now = nowMs()
    let fromDate = dateOf(p.fromDate, "Published from")
    // a start a moment ago (the form's now) is now; an earlier one would rewrite which template a quote came from
    if (fromDate && ms(fromDate) < now - 24 * 60 * 60 * 1000) denied("DATE_INVALID", "Publish from today or a later date")
    if (!fromDate || ms(fromDate) < now) fromDate = new Date(now)
    const thruDate = dateOf(p.thruDate, "Published through")
    if (thruDate && ms(thruDate) <= ms(fromDate)) denied("VALIDITY_INVALID", "Published through must be after published from")
    const predecessorOrderId = template.order.parentOrderId
    const predecessor = predecessorOrderId ? one(ORDER, {orderId: predecessorOrderId}) : null
    if (predecessor?.orderPurposeEnumId === purpose) {
        const other = successorsOf(predecessorOrderId).find(
            row => row.order.orderId !== template.order.orderId && row.part?.validFromDate != null
        )
        if (other) denied("SUCCESSOR_EXISTS", "Quote template " + predecessorOrderId + " was replaced by " + other.order.orderId)
        const predecessorPart = rows(PART, {orderId: predecessorOrderId})[0]
        const predecessorThru = ms(predecessorPart.validThruDate)
        if (predecessorThru == null || predecessorThru > ms(fromDate))
            setPublished(predecessor, predecessorPart, predecessorPart.validFromDate || fromDate, fromDate)
    }
    setPublished(template.order, template.part, fromDate, thruDate)
    const order = one(ORDER, {orderId: template.order.orderId})
    return {
        orderId: order.orderId,
        state: salesAccess.templateState(rows(PART, {orderId: order.orderId})[0]),
        predecessorOrderId: predecessor?.orderPurposeEnumId === purpose ? predecessorOrderId : null,
        orderRevision: revisionOf(order)
    }
}

// ===== end#QuoteTemplate =====
// A published template ended (now, or at a later date), or a draft set aside (ended without being published). Refuses one ended
// already (TEMPLATE_ENDED).
function endTemplate(p) {
    const userScope = salesAccess.scope()
    requireManager(userScope)
    const template = salesAccess.requireTemplate(userScope, text(p.orderId))
    requireRevision(template.order, p.orderRevision)
    if (template.state === "ended") denied("TEMPLATE_ENDED", "Quote template " + template.order.orderId + " has ended")
    const now = nowMs()
    const given = dateOf(p.thruDate, "Ends on")
    const thru = new Date(given && ms(given) > now ? ms(given) : now)
    const from = template.part.validFromDate && ms(template.part.validFromDate) < ms(thru) ? template.part.validFromDate : thru
    setPublished(template.order, template.part, from, thru)
    return {orderId: template.order.orderId, orderRevision: revisionOf(one(ORDER, {orderId: template.order.orderId}))}
}

// ===== preview#QuoteTemplate =====
// An example quote of the template (design §5 TemplatePreview): each line priced for a customer (an account of the organization, or
// none: the seller's public price) in the template's currency as of a date (now when not given), with its source and warnings (no
// price yet, a product not usable for selling to the customer, a fixed price beside today's calculated one), and the total; no tax,
// which the quote's address decides. Nothing is written.
function previewTemplate(p) {
    const userScope = salesAccess.scope()
    const template = salesAccess.requireTemplate(userScope, text(p.orderId))
    const customerPartyId = text(p.customerPartyId)
    if (customerPartyId) {
        const account = salesAccess.requireAccount(userScope, customerPartyId)
        if (account.organizationPartyId && account.organizationPartyId !== template.organizationPartyId)
            denied("CUSTOMER_INVALID", "The customer is an account of another organization")
    }
    const validDate = dateOf(p.validDate, "Priced on") || ec.user.nowTimestamp
    const currencyUomId = template.order.currencyUomId
    let total = toDecimal(0)
    let warningCount = 0
    const lines = linesOf(template.order.orderId).map(item => {
        const quantity = toDecimal(item.quantity ?? 1)
        const warnings = []
        let unitAmount = item.unitAmount == null ? null : toDecimal(item.unitAmount)
        let sourceText = L("Charge as entered")
        if (item.productId) {
            const price = sellerPrice(template.organizationPartyId, customerPartyId, item, currencyUomId, validDate)
            if (fixedSources.includes(item.priceSource)) {
                sourceText = L(item.priceSource === "free" ? "Free line" : "Fixed price")
                if (price.priceAvailable && unitAmount != null && !toDecimal(price.price).eq(unitAmount))
                    warnings.push(L("Calculated") + " " + moneyText(price.price, currencyUomId))
            } else if (price.priceAvailable) {
                unitAmount = toDecimal(price.price)
                sourceText = L(price.priceSource === "price-list" ? "Price list" : "Price")
            } else {
                unitAmount = null
                sourceText = L("No price set")
                warnings.push(L("No price for this customer: the rep enters one on the quote"))
            }
            const usable = call("mantle.product.ProductServices.check#ProductUsable", {
                productId: item.productId,
                usage: "Sell",
                quantity,
                vendorPartyId: template.organizationPartyId,
                customerPartyId
            })
            if (!usable.usable) warnings.push(usable.reason || L("Not usable for selling"))
        }
        const amount = unitAmount == null ? null : quantity.multiply(unitAmount)
        if (amount != null) total = total.add(amount)
        warningCount += warnings.length
        const product = item.productId ? one("mantle.product.Product", {productId: item.productId}) : null
        return {
            orderItemSeqId: item.orderItemSeqId,
            description: item.itemDescription || product?.productName || item.productId || "",
            productId: item.productId || null,
            quantityText: quantityText(item.quantity),
            unitText: unitAmount == null ? "" : moneyText(unitAmount, currencyUomId),
            amountText: amount == null ? "" : moneyText(amount, currencyUomId),
            sourceText,
            warningText: warnings.join(" · ")
        }
    })
    return {
        preview: {
            orderId: template.order.orderId,
            customerName: customerPartyId ? partyName(customerPartyId) : L("No customer: the seller's price"),
            currencyUomId,
            validText: dayText(validDate),
            totalText: moneyText(total, currencyUomId),
            warningCount
        },
        lines
    }
}
function sellerPrice(organizationPartyId, customerPartyId, item, currencyUomId, validDate) {
    return call("mantle.product.PriceServices.get#SellerProductPrice", {
        productId: item.productId,
        organizationPartyId,
        customerPartyId: customerPartyId || null,
        quantity: toDecimal(item.quantity ?? 1),
        quantityUomId: item.quantityUomId || null,
        priceUomId: currencyUomId,
        validDate
    })
}

// ===== a quote from a template (create#Quote, SalesQuotes.js) =====
// The current template a quote of the organization starts from, or a refusal: one the caller does not see answers RECORD_UNAVAILABLE,
// one not current TEMPLATE_UNAVAILABLE, another organization's TEMPLATE_INVALID.
function usableTemplate(userScope, orderId, organizationPartyId) {
    const template = salesAccess.templateOf(userScope, orderId)
    if (!template) denied("RECORD_UNAVAILABLE", "Quote template " + orderId + " is not available")
    if (template.state !== "current")
        denied(
            "TEMPLATE_UNAVAILABLE",
            "Quote template " + orderId + " is " + L(stateTexts[template.state]).toLowerCase() + ", not current"
        )
    if (organizationPartyId && organizationPartyId !== template.organizationPartyId)
        denied("TEMPLATE_INVALID", "Quote template " + orderId + " is of another organization")
    return template
}
// The quote's order copied from the template with clone#Order (its header and part values given; no notes, files, parties or
// payments; the template's description and validity cleared): {orderId, orderPartSeqId}.
function cloneForQuote(template, values) {
    const cloned = call(
        "mantle.order.OrderServices.clone#Order",
        Object.assign(
            {
                baseOrderId: template.order.orderId,
                productItemsOnly: false,
                copyContactMech: false,
                copyContent: false,
                copyNote: false,
                copyPartParty: false,
                copyItemWorkEffort: false,
                copyPayment: false
            },
            values
        )
    )
    const orderId = cloned.orderId
    call("update#" + ORDER, {orderId, templateDescription: null, templateValidityDays: null})
    return {orderId, orderPartSeqId: rows(PART, {orderId})[0].orderPartSeqId}
}
// The copied quote priced as of its own date: each product line at the seller's price for the customer now (with its provenance),
// a fixed line keeping its price and reason with today's calculated basis, a line with no price left without one; the charges as
// entered; no tax line copied (the native rules tax the quote). Returns each line's warning.
function priceCopy(quote) {
    const {orderId, organizationPartyId, customerPartyId, productStoreId, currencyUomId, salesOpportunityId} = quote
    const warnings = []
    for (const item of rows(ITEM, {orderId})) {
        if (taxTypes.includes(item.itemTypeEnumId)) {
            call("delete#" + ITEM, {orderId, orderItemSeqId: item.orderItemSeqId})
            continue
        }
        if (!item.productId) continue
        const quantity = toDecimal(item.quantity ?? 1)
        const price = call("mantle.product.PriceServices.get#SellerProductPrice", {
            productId: item.productId,
            organizationPartyId,
            customerPartyId,
            productStoreId: productStoreId || null,
            quantity,
            quantityUomId: item.quantityUomId || null,
            priceUomId: currencyUomId,
            validDate: ec.user.nowTimestamp
        })
        const changes = {
            orderId,
            orderItemSeqId: item.orderItemSeqId,
            calculatedUnitAmount: price.priceAvailable ? price.price : null,
            unitListPrice: price.listPriceAvailable ? price.listPrice : null,
            productPriceId: price.productPriceId || null,
            priceListId: price.priceListId || null,
            priceRuleId: price.priceRuleId || null,
            salesOpportunityId: salesOpportunityId || null
        }
        if (fixedSources.includes(item.priceSource)) {
            // the template's authorized fixed price, its reason and author kept (the quote's approval rules read them as entered)
        } else if (price.priceAvailable) {
            Object.assign(changes, {
                unitAmount: price.price,
                isModifiedPrice: "N",
                priceSource: price.priceSource || "product-price"
            })
        } else {
            Object.assign(changes, {unitAmount: null, isModifiedPrice: "N", priceSource: null})
            warnings.push({orderItemSeqId: item.orderItemSeqId, reasonCode: "PRICE_UNAVAILABLE", productId: item.productId})
        }
        const usable = call("mantle.product.ProductServices.check#ProductUsable", {
            productId: item.productId,
            usage: "Sell",
            quantity,
            productStoreId: productStoreId || null,
            vendorPartyId: organizationPartyId,
            customerPartyId
        })
        if (!usable.usable)
            warnings.push({orderItemSeqId: item.orderItemSeqId, reasonCode: "PRODUCT_NOT_USABLE", productId: item.productId})
        call("update#" + ITEM, changes)
    }
    return warnings
}

const operations = {findTemplates, getTemplate, storeTemplate, publishTemplate, endTemplate, previewTemplate}
;({
    usableTemplate,
    cloneForQuote,
    priceCopy,
    execute: (op, parameters) => {
        if (!operations[op]) throw new Error("Unknown quote template operation " + op)
        return operations[op](parameters)
    }
})
