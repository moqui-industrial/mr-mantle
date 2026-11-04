// The comparison and award of an RFQ's supplier quotes (design-purchasing §5 QuoteComparison and Award; impl-purchasing P12,
// §2, §4, R-PUR-35, D8, D10, D19, F19, F35). No award record: an award is the placed quote order with its links (§4).
// - compare#SupplierQuotes: each RFQ item (the demand) with its offers, the quote lines linked to it and the quote's other
//   lines of a pack or a declared substitute (PatEquivalent, PatReplacement) of its product, in the demand's unit through
//   the unit conversions and pack products (PatPackagingFor), priced at the compared quantity by the quote's published tier
//   rows (ProductPrice with the quote as its source, publish#SupplierQuotePrice) else the line's price, in a display
//   currency at Accounting's dated rate (Currencies.js rateOn). A missing rate, unit or price is Not comparable with its
//   reason, never zero or cheapest; a missing freight leaves the estimated landed cost Unknown. The committed price and the
//   estimated landed cost (with the quote's freight lines, ItemShipping) stay apart. Ranking explains and never chooses.
// - preview#Award and commit#Award: allocations of demand quantity to quote lines, grouped per quote (one supplier each);
//   each group checked for the quote's state, validity and revision, the buying policy's supplier check, each product's use
//   for buying, the demand left (the RFQ item less what is awarded, and its purchase request requirement less what covers
//   it), a substitute's acceptance and the budget (check#Budget, for a user who may read it). commit places each group in
//   its own transaction (commit#AwardGroup) under the lock of its quote and its requirements: each chosen line's quantity
//   set to its allocation (audit-logged with the award's reason, a tier price where one applies), the quote's other product
//   lines removed and named in a note, RequestItemOrder and RequirementSupply for request demand, and the quote placed
//   ("Place from Quote") where P3/P4's gate meets it; it never approves or sends. A group fails by name and the others go
//   on; the same operation key answers the first result. Where the organization has award (PasAward) approval policy rows
//   in effect, commit places nothing: the award waits on the PurchaseAwardApproval topic (its allocations kept as the
//   operation's request), and the last step's approval places it (decide#AwardApproval); a refusal leaves the quotes as
//   they were.
// - close#QuoteRequest: the quotes left (requested or proposed) cancelled as Not awarded ("Cancel Quote"), their access
//   capabilities revoked, an optional regret notice reviewed (preview) and sent per recipient with a result each, and the
//   RFQ completed. The EDI acknowledgement SECA on OrderCancelled returns at once for a quote (none comes by EDI, F35).
// Every verb checks its permission and the organization (Sourcing.js rfqOf, PurchaseOrders.js purchaseOrder).
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const policyModule = ec.resource.script("component://mr-mantle/service/mantle/order/PurchasePolicy.js")
const sourcingScript = () => ec.resource.script("component://mr-mantle/service/mantle/order/Sourcing.js")
const ordersScript = () => ec.resource.script("component://mr-mantle/service/mantle/order/PurchaseOrders.js")
const approvalsScript = () => ec.resource.script("component://mr-mantle/service/mantle/order/PurchaseApprovals.js")
const documentsScript = () => ec.resource.script("component://mr-mantle/service/mantle/order/PurchaseOrderDocuments.js")
const planningScript = () => ec.resource.script("component://mr-mantle/service/mantle/product/SupplyPlanning.js")
const currenciesScript = () => ec.resource.script("component://mr-mantle/service/mantle/ledger/Currencies.js")
const catalogScript = () => ec.resource.script("component://mr-mantle/service/mantle/product/CatalogPolicy.js")
const {find, one, rows, call, probe, denied, access, ms, dateText} = lib

const S = "mantle.order.SourcingServices."
const REQUEST = "mantle.request.Request",
    ITEM = "mantle.request.RequestItem",
    ITEM_ORDER = "mantle.request.RequestItemOrder",
    ITEM_ASSOC = "mantle.request.RequestItemAssoc",
    REQUIREMENT = "mantle.request.requirement.Requirement",
    REQUIREMENT_ITEM = "mantle.request.requirement.RequirementRequestItem",
    SUPPLY = "mantle.request.requirement.RequirementSupply",
    ORDER = "mantle.order.OrderHeader",
    PART = "mantle.order.OrderPart",
    ORDER_ITEM = "mantle.order.OrderItem",
    PRICE = "mantle.product.ProductPrice",
    ASSOC = "mantle.product.ProductAssoc",
    DECISION = "mantle.order.purchase.PurchaseApprovalDecision",
    POLICY = "mantle.order.purchase.PurchaseApprovalPolicy",
    CAPABILITY = "mantle.party.ExternalAccessCapability",
    OPERATION = lib.operationEntity
const quoteStatuses = ["OrderRequested", "OrderProposed"]
const deadStatuses = ["OrderCancelled", "OrderRejected"]
const closedRequestStatuses = ["ReqCompleted", "ReqCancelled"]
const readPermissions = ["PURCHASE_ORDER_EDIT", "PURCHASE_APPROVE", "PURCHASE_ORDER_APPROVE"]
// who may read a budget decision (check#Budget's own permissions); a buyer without them sees it withheld, and the purchase
// order's approval decides the budget (P4)
const budgetPermissions = [
    "INVOICE_APPROVE",
    "PURCHASE_APPROVE",
    "BUDGET_EDIT",
    "ACCOUNTING_ADMIN",
    "PAYABLE_EDIT",
    "ACCOUNTING_VIEW",
    "BUDGET_OVERRIDE"
]
const substituteTypes = ["PatEquivalent", "PatReplacement"]
// the group failures a retry (a new operation with the group's allocations) may cure once the supplier, product or budget is
// fixed
const retryableCodes = [
    "SUPPLIER_BLOCKED",
    "SUPPLIER_SUSPENDED",
    "SUPPLIER_UNAPPROVED",
    "SUPPLIER_UNAVAILABLE",
    "PRODUCT_NOT_USABLE",
    "BUDGET_STOP",
    "FAILED"
]
// a capability of a quote order's supplier (P16 issues them for the quote's response page): every one ends when the quote
// is not awarded
const capabilityRecordTypes = ["Order", "Quote", "SupplierQuote"]
const dayMs = 24 * 60 * 60 * 1000

const blank = value => value == null || String(value).trim() === ""
const text = value => (blank(value) ? null : String(value).trim())
const dec = value => toDecimal(value == null || value === "" ? 0 : value)
const zero = () => toDecimal(0)
const truthy = value => value === true || value === "true" || value === "Y"
const qty = value => (value == null ? "" : dec(value).compare(0) === 0 ? "0" : String(dec(value).toNumber()))
const quantityText = value => (value == null ? "" : ec.l10n.format(dec(value), "#,##0.###"))
const plain = (value, scale = 6) => (value == null ? "" : String(dec(value).setScale(scale, "HALF_UP").toNumber()))
const partyName = partyId => (partyId ? lib.partyNames([partyId])[partyId] || partyId : "")
const statusText = statusId => (statusId ? one("moqui.basic.StatusItem", {statusId})?.description || statusId : "")
const money = (value, currencyUomId) =>
    value == null ? "" : currencyUomId ? ec.l10n.formatCurrency(lib.money(value, currencyUomId), currencyUomId) : String(value)
// a unit price shown with up to four places (a normalized price is finer than the currency)
const unitMoney = (value, currencyUomId) =>
    value == null ? "" : (currencyUomId ? currencyUomId + " " : "") + ec.l10n.format(dec(value), "#,##0.00##")
const dayOf = value =>
    /^\d{4}-\d{2}-\d{2}/.test(String(value)) ? String(value).slice(0, 10) : ec.l10n.format(new Date(ms(value)), "yyyy-MM-dd")
const keyOf = (requestId, requestItemSeqId) => requestId + ":" + requestItemSeqId

function requirePermission(...permissions) {
    if (!permissions.some(permission => access.has(permission)))
        denied("PERMISSION_DENIED", permissions.join(" or ") + " is required")
}
function requireOpen(rfq) {
    if (closedRequestStatuses.includes(rfq.request.statusId)) denied("REQUEST_CLOSED", "RFQ " + rfq.requestId + " is closed")
}
function decimal(value, label) {
    let number
    try {
        number = toDecimal(value)
    } catch (_) {
        number = null
    }
    if (number == null || number.compare(0) < 0) denied("QUANTITY_INVALID", "Enter a " + label + " of zero or more")
    return number
}

// ===== products and units =====
// Per-call caches of products and units: a comparison reads the same few many times.
function cacheOf() {
    const products = {},
        uoms = {}
    return {
        product: productId => (productId ? (products[productId] ??= one("mantle.product.Product", {productId})) : null),
        uomText: uomId => (uomId ? (uoms[uomId] ??= one("moqui.basic.Uom", {uomId})?.abbreviation || uomId) : "")
    }
}
function productText(cache, productId) {
    const product = cache.product(productId)
    return product ? [product.pseudoId || productId, product.productName].filter(Boolean).join(" · ") : productId || ""
}
// A quantity of one unit in another through the dated unit conversions (Products' convert); the same unit as it is. An
// incompatible unit or a missing conversion is refused (UOM_INCOMPATIBLE).
function convertUnit(quantity, fromUomId, toUomId) {
    if (fromUomId === toUomId) return dec(quantity)
    try {
        return dec(catalogScript().convert(dec(quantity), fromUomId, toUomId, ec.user.nowTimestamp).quantity)
    } catch (error) {
        denied("UOM_INCOMPATIBLE", "No conversion from " + fromUomId + " to " + toUomId)
    }
}
// The base product's quantity one pack holds (PatPackagingFor, a pack of packs followed down), in the base's stock unit, or
// null when the product is not a pack of it.
function packContent(cache, packProductId, baseProductId, depth = 0) {
    if (!packProductId || !baseProductId || depth > 8) return null
    for (const row of rows(ASSOC, {productId: packProductId, productAssocTypeEnumId: "PatPackagingFor"})) {
        if (!lib.active(row)) continue
        const base = cache.product(row.toProductId)
        if (!base || dec(row.quantity).compare(0) <= 0) continue
        const contained = convertUnit(row.quantity, row.quantityUomId || base.amountUomId, base.amountUomId)
        if (row.toProductId === baseProductId) return {quantity: contained, uomId: base.amountUomId}
        const inner = packContent(cache, row.toProductId, baseProductId, depth + 1)
        if (inner) return {quantity: contained.multiply(inner.quantity), uomId: inner.uomId}
    }
    return null
}
// Whether a product is a declared substitute of another (PatEquivalent or PatReplacement, either way, in effect).
const substituteOf = (productId, otherProductId) =>
    [
        [productId, otherProductId],
        [otherProductId, productId]
    ].some(([from, to]) =>
        rows(ASSOC, {productId: from, toProductId: to}).some(
            row => substituteTypes.includes(row.productAssocTypeEnumId) && lib.active(row)
        )
    )
// How a quote line compares with a demand line: the demand units one line unit makes (factor), its kind (same product, pack,
// substitute, a described item) and the basis in words; or not comparable with its reason (another product, no unit, no
// conversion).
function basisOf(cache, line, item) {
    const demandProduct = cache.product(item.productId)
    const demandUom = item.quantityUomId || demandProduct?.amountUomId || null
    const lineProduct = cache.product(line.productId)
    const lineUom = line.quantityUomId || lineProduct?.amountUomId || null
    const notComparable = (reasonCode, reasonText, kind = "other") => ({
        comparable: false,
        kind,
        factor: null,
        reasonCode,
        reasonText,
        basisText: ""
    })
    const sameUnit = kind => {
        if (!lineUom && !demandUom) return {comparable: true, kind, factor: dec(1), basisText: ""}
        if (!lineUom || !demandUom) return notComparable("UOM_MISSING", "The quote or the item names no unit", kind)
        const factor = convertUnit(1, lineUom, demandUom)
        return {
            comparable: true,
            kind,
            factor,
            basisText:
                lineUom === demandUom
                    ? ""
                    : "1 " + cache.uomText(lineUom) + " = " + quantityText(factor) + " " + cache.uomText(demandUom)
        }
    }
    try {
        if (!item.productId || line.productId === item.productId) return sameUnit(item.productId ? "same" : "described")
        if (!line.productId) return notComparable("PRODUCT_DIFFERENT", "The line names no product")
        const pack = packContent(cache, line.productId, item.productId)
        if (pack) {
            const factor = convertUnit(pack.quantity, pack.uomId, demandUom || pack.uomId)
            return {
                comparable: true,
                kind: "pack",
                factor,
                basisText:
                    "1 " +
                    (lineProduct?.productName || line.productId) +
                    " = " +
                    quantityText(factor) +
                    " " +
                    cache.uomText(demandUom)
            }
        }
        if (substituteOf(line.productId, item.productId)) {
            const basis = sameUnit("substitute")
            return Object.assign(basis, {basisText: ["Substitute", basis.basisText].filter(Boolean).join(" · ")})
        }
        return notComparable("PRODUCT_DIFFERENT", "Another product, not a pack or a declared substitute of the item")
    } catch (error) {
        return notComparable(lib.reasonCode(error) || "UOM_INCOMPATIBLE", String(error.message).replace(/^[A-Z_]+: /, ""))
    }
}
// The price of a quote line at a quantity of its own unit: the quote's published tier row in effect with the highest minimum
// quantity at or below it (publish#SupplierQuotePrice), else the line's quoted price; null when nothing is quoted.
function priceAt(line, currencyUomId, lineQuantity) {
    const tier = rows(PRICE, {sourceOrderId: line.orderId, sourceOrderItemSeqId: line.orderItemSeqId})
        .filter(row => lib.active(row) && (!row.priceUomId || row.priceUomId === currencyUomId))
        .filter(row => dec(row.minQuantity).compare(lineQuantity) <= 0 && dec(row.price).compare(0) > 0)
        .sort((a, b) => dec(b.minQuantity).compare(dec(a.minQuantity)))[0]
    if (tier)
        return {
            price: dec(tier.price),
            productPriceId: tier.productPriceId,
            tierText: dec(tier.minQuantity).compare(0) > 0 ? "tier from " + quantityText(tier.minQuantity) : ""
        }
    if (dec(line.unitAmount).compare(0) <= 0) return null
    return {price: dec(line.unitAmount), productPriceId: null, tierText: ""}
}
// A quote's freight estimate: its freight lines (ItemShipping) in its currency, or null when it quotes none.
function freightOf(lines) {
    const freight = lines.filter(line => line.itemTypeEnumId === "ItemShipping")
    if (!freight.length) return null
    return freight.reduce((total, line) => total.add(dec(line.quantity || 1).multiply(dec(line.unitAmount))), zero())
}

// ===== the RFQ's demand and quotes =====
// An RFQ item's purchase request requirement: the request line it was made from (RequestItemAssoc) and that line's
// requirement (RequirementRequestItem), or nulls for an item entered on the RFQ.
function sourceOf(requestId, requestItemSeqId) {
    const assoc = rows(ITEM_ASSOC, {requestId, requestItemSeqId})[0]
    if (!assoc) return {sourceRequestId: null, sourceRequestItemSeqId: null, requirementId: null}
    const link = rows(REQUIREMENT_ITEM, {requestId: assoc.otherRequestId, requestItemSeqId: assoc.otherRequestItemSeqId})[0]
    return {
        sourceRequestId: assoc.otherRequestId,
        sourceRequestItemSeqId: assoc.otherRequestItemSeqId,
        requirementId: link?.requirementId || null
    }
}
// The RFQ's items (its demand) and its quotes (the invitations, with their lines and the RFQ's links to them).
function contextOf(rfq) {
    const items = rows(ITEM, {requestId: rfq.requestId})
        .filter(item => item.statusId !== "ReqCancelled")
        .sort((a, b) => String(a.requestItemSeqId).localeCompare(String(b.requestItemSeqId)))
        .map(item => Object.assign(lib.map(item), sourceOf(rfq.requestId, item.requestItemSeqId)))
    const quotes = sourcingScript()
        .invitationsOf(rfq.requestId)
        .map(invitation =>
            Object.assign(invitation, {
                lines: rows(ORDER_ITEM, {orderId: invitation.orderId}).map(lib.map),
                links: rows(ITEM_ORDER, {orderId: invitation.orderId}).filter(link => link.requestId === rfq.requestId)
            })
        )
    return {rfq, items, quotes, cache: cacheOf()}
}
const awardedStatus = statusId => !quoteStatuses.includes(statusId) && !deadStatuses.includes(statusId)
// What an item has awarded: the demand quantity of its lines on the placed quotes (links of the RFQ to placed orders).
function awardedOf(ctx, item, exceptOrderId = null) {
    let total = zero()
    for (const quote of ctx.quotes) {
        if (!awardedStatus(quote.order.statusId) || quote.orderId === exceptOrderId) continue
        for (const link of quote.links.filter(row => row.requestItemSeqId === item.requestItemSeqId)) {
            const line = quote.lines.find(row => row.orderItemSeqId === link.orderItemSeqId)
            if (!line) continue
            const basis = basisOf(ctx.cache, line, item)
            const quantity = dec(line.quantity).subtract(dec(line.quantityCancelled))
            total = total.add(basis.comparable ? quantity.multiply(basis.factor) : dec(link.quantity))
        }
    }
    return total
}
// What is left of an item to award: the item less what is awarded and, for request demand, no more than its requirement less
// what covers it (RequirementSupply: this RFQ's awards and any other sourcing).
function remainingOf(ctx, item, exceptOrderId = null) {
    let remaining = dec(item.quantity).subtract(awardedOf(ctx, item, exceptOrderId))
    if (item.requirementId) {
        const requirement = one(REQUIREMENT, {requirementId: item.requirementId})
        const open = requirement ? dec(requirement.quantity).subtract(planningScript().coveredOf(item.requirementId)) : zero()
        if (open.compare(remaining) < 0) remaining = open
    }
    return remaining.compare(0) > 0 ? remaining : zero()
}
// The offers of an item: the quote lines linked to it, and each quote's other product lines of a pack or substitute of it.
function offerLinesOf(ctx, item) {
    const offers = []
    for (const quote of ctx.quotes) {
        if (deadStatuses.includes(quote.order.statusId)) continue
        for (const link of quote.links.filter(row => row.requestItemSeqId === item.requestItemSeqId)) {
            const line = quote.lines.find(row => row.orderItemSeqId === link.orderItemSeqId)
            if (line) offers.push({quote, line, linked: true})
        }
        if (!item.productId || !quoteStatuses.includes(quote.order.statusId)) continue
        for (const line of quote.lines) {
            if (!line.productId || line.productId === item.productId || line.itemTypeEnumId === "ItemShipping") continue
            if (quote.links.some(row => row.orderItemSeqId === line.orderItemSeqId)) continue
            let related = false
            try {
                related = !!packContent(ctx.cache, line.productId, item.productId) || substituteOf(line.productId, item.productId)
            } catch (_) {
                related = substituteOf(line.productId, item.productId)
            }
            if (related) offers.push({quote, line, linked: false})
        }
    }
    return offers
}

// ===== compare#SupplierQuotes =====
const quoteStateText = {OrderRequested: "Awaiting the supplier", OrderProposed: "Quoted"}
function currencyOf(organizationPartyId) {
    const fromPolicy = policyModule.effective(organizationPartyId).policy.currencyUomId
    if (fromPolicy) return fromPolicy
    return (
        call("mantle.ledger.LedgerServices.find#PartyAcctgPreference", {organizationPartyId}).partyAcctgPreference
            ?.baseCurrencyUomId || null
    )
}
// One offer at the compared quantity: the original and the normalized basis, the committed price and amount, the freight and
// estimated landed cost, the lead time, validity and risk, and why it cannot be compared or selected.
function offerRow(ctx, basisContext, item, offer, comparedQuantity) {
    const {quote, line} = offer
    const cache = ctx.cache
    const part = quote.part
    const quoteCurrency = quote.order.currencyUomId
    const displayCurrency = basisContext.displayCurrencyUomId
    const status = quote.order.statusId
    const awarded = awardedStatus(status)
    const expired = status === "OrderProposed" && sourcingScript().expired(part)
    const basis = basisOf(cache, line, item)
    const lineUom = line.quantityUomId || cache.product(line.productId)?.amountUomId || null
    const risk = policyModule.supplierUsable(ctx.rfq.organizationPartyId, quote.supplierPartyId)
    const row = {
        requestItemSeqId: item.requestItemSeqId,
        orderId: quote.orderId,
        orderItemSeqId: line.orderItemSeqId,
        orderRevision: Number(quote.order.orderRevision ?? 1),
        supplierPartyId: quote.supplierPartyId,
        supplierName: partyName(quote.supplierPartyId),
        statusId: status,
        statusText: awarded ? "Awarded" : expired ? "Expired" : quoteStateText[status] || statusText(status),
        productId: line.productId || null,
        productText: productText(cache, line.productId) || line.itemDescription || "",
        otherPartyProductId: line.otherPartyProductId || "",
        kind: basis.kind,
        substitute: basis.kind === "substitute",
        pack: basis.kind === "pack",
        linked: offer.linked,
        quotedQuantityText: quantityText(line.quantity) + (lineUom ? " " + cache.uomText(lineUom) : ""),
        quotedPrice: dec(line.unitAmount).compare(0) > 0 ? plain(line.unitAmount) : "",
        currencyUomId: quoteCurrency,
        originalText:
            (dec(line.unitAmount).compare(0) > 0 ? money(line.unitAmount, quoteCurrency) : "Not quoted") +
            " / " +
            (cache.uomText(lineUom) || "unit") +
            " · " +
            quantityText(line.quantity) +
            " quoted",
        basisText: basis.basisText || (basis.comparable ? "Same unit" : ""),
        factor: basis.factor == null ? "" : plain(basis.factor, 12),
        comparable: false,
        reasonCode: null,
        reasonText: "",
        normalizedPrice: "",
        normalizedText: "",
        committedAmount: "",
        committedText: "",
        freightText: "Unknown",
        landedAmount: "",
        landedText: "Unknown",
        leadDays: null,
        leadText: "Unknown",
        late: false,
        validityText: part.validThruDate ? "until " + dateText(part.validThruDate) : "No end given",
        expired,
        riskResult: risk.result,
        riskText: risk.result === "OK" ? "None" : risk.message || risk.result,
        rank: null,
        rankText: "",
        canSelect: false
    }
    // the lead time: the line's promise, else the quote's delivery date
    const promised = line.promisedDate || part.estimatedDeliveryDate || null
    if (promised) {
        row.leadDays = Math.max(0, Math.ceil((ms(promised) - Number(ec.user.nowTimestamp)) / dayMs))
        row.leadText = dateText(promised) + " · " + row.leadDays + (row.leadDays === 1 ? " day" : " days")
        row.late = !!item.requiredByDate && ms(promised) > ms(item.requiredByDate)
    }
    const fail = (reasonCode, reasonText) => {
        row.reasonCode = row.reasonCode || reasonCode
        row.reasonText = row.reasonText || reasonText
    }
    if (!basis.comparable) fail(basis.reasonCode, basis.reasonText)
    if (status === "OrderRequested") fail("NOT_QUOTED", "Awaiting the supplier's answer")
    const lineQuantity = basis.comparable ? dec(comparedQuantity).divide(basis.factor, 12, "HALF_UP") : null
    const price = lineQuantity != null && status !== "OrderRequested" ? priceAt(line, quoteCurrency, lineQuantity) : null
    if (lineQuantity != null && status !== "OrderRequested" && !price) fail("NOT_QUOTED", "No price quoted")
    if (price) {
        const unitQuoted = price.price.divide(basis.factor, 12, "HALF_UP")
        if (price.tierText)
            row.basisText = [row.basisText === "Same unit" ? "" : row.basisText, price.tierText].filter(Boolean).join(" · ")
        const rate = displayCurrency ? currenciesScript().rateOn(quoteCurrency, displayCurrency, basisContext.fxDay) : null
        if (!rate) {
            fail(
                "RATE_MISSING",
                "Not comparable: no exchange rate from " + quoteCurrency + " to " + displayCurrency + " on " + basisContext.fxDay
            )
            row.normalizedText = unitMoney(unitQuoted, quoteCurrency) + " (not converted)"
        } else {
            const unitDisplay = unitQuoted.multiply(rate.rate)
            const committed = unitDisplay.multiply(dec(comparedQuantity))
            row.normalizedPrice = plain(unitDisplay)
            row.normalizedText = unitMoney(unitDisplay, displayCurrency)
            row.committedAmount = plain(committed, 2)
            row.committedText = money(committed, displayCurrency)
            // the freight estimate shared by the lines' quoted amounts, per demand unit
            const freight = freightOf(quote.lines)
            if (freight != null) {
                const productLines = quote.lines.filter(other => other.itemTypeEnumId !== "ItemShipping")
                const total = productLines.reduce(
                    (sum, other) => sum.add(dec(other.quantity).multiply(dec(other.unitAmount))),
                    zero()
                )
                const lineAmount = dec(line.quantity).multiply(dec(line.unitAmount))
                const lineDemand = dec(line.quantity).multiply(basis.factor)
                if (total.compare(0) > 0 && lineDemand.compare(0) > 0) {
                    const perUnit = freight.multiply(lineAmount).divide(total, 12, "HALF_UP").divide(lineDemand, 12, "HALF_UP")
                    const freightDisplay = perUnit.multiply(rate.rate).multiply(dec(comparedQuantity))
                    row.freightText = money(freightDisplay, displayCurrency)
                    row.landedAmount = plain(committed.add(freightDisplay), 2)
                    row.landedText = money(committed.add(freightDisplay), displayCurrency)
                }
            }
        }
    }
    if (expired) fail("QUOTE_EXPIRED", "Expired " + dateText(part.validThruDate))
    if (awarded) fail("AWARDED", "Awarded on purchase order " + quote.orderId)
    row.comparable = !row.reasonCode
    // selectable: a proposed quote, unexpired, priced, of a comparable basis, from a supplier the policy does not stop
    row.canSelect =
        status === "OrderProposed" && !expired && !!price && basis.comparable && risk.result !== "STOP" && !!line.productId
    return row
}
// Ranking by the committed unit price: the comparable offers first, cheapest first, with the reason; it chooses nothing.
function rank(offerRows) {
    const ranked = offerRows.filter(row => row.comparable).sort((a, b) => dec(a.normalizedPrice).compare(dec(b.normalizedPrice)))
    const lowest = ranked.length ? dec(ranked[0].normalizedPrice) : null
    ranked.forEach((row, index) => {
        row.rank = index + 1
        const over =
            lowest && lowest.compare(0) > 0
                ? dec(row.normalizedPrice).subtract(lowest).multiply(100).divide(lowest, 1, "HALF_UP")
                : zero()
        row.rankText = index === 0 ? "1 · lowest unit price" : index + 1 + " · " + plain(over, 1) + "% over the lowest"
    })
    for (const row of offerRows.filter(row => !row.comparable))
        row.rankText = row.reasonCode === "AWARDED" ? "Awarded" : "Not comparable"
    return ranked.concat(offerRows.filter(row => !row.comparable))
}
// compare#SupplierQuotes: the RFQ's demand lines (or the one chosen) with their offers on one basis, and its print or CSV.
function compare(p) {
    requirePermission(...readPermissions)
    const rfq = sourcingScript().rfqOf(p.requestId)
    const ctx = contextOf(rfq)
    const displayCurrencyUomId = text(p.displayCurrencyUomId) || rfq.request.currencyUomId || currencyOf(rfq.organizationPartyId)
    if (displayCurrencyUomId && one("moqui.basic.Uom", {uomId: displayCurrencyUomId})?.uomTypeEnumId !== "UT_CURRENCY_MEASURE")
        denied("CURRENCY_INVALID", "Choose a currency")
    const fxDay = blank(p.fxDate) ? dayOf(ec.user.nowTimestamp) : dayOf(p.fxDate)
    const revision = sourcingScript().revisionOf(rfq.requestId)
    const basisContext = {displayCurrencyUomId, fxDay}
    const chosen = text(p.requestItemSeqId)
    const items = chosen ? ctx.items.filter(item => item.requestItemSeqId === chosen) : ctx.items
    if (chosen && !items.length) denied("ITEM_UNAVAILABLE", "Item " + chosen + " is not on RFQ " + rfq.requestId)
    const demandRows = []
    let offerRows = []
    for (const item of items) {
        const remaining = remainingOf(ctx, item)
        const comparedQuantity =
            chosen && !blank(p.quantity)
                ? decimal(p.quantity, "quantity")
                : remaining.compare(0) > 0
                  ? remaining
                  : dec(item.quantity)
        const offers = rank(offerLinesOf(ctx, item).map(offer => offerRow(ctx, basisContext, item, offer, comparedQuantity)))
        const uomId = item.quantityUomId || ctx.cache.product(item.productId)?.amountUomId || null
        const best = offers.find(row => row.rank === 1)
        demandRows.push({
            requestItemSeqId: item.requestItemSeqId,
            requestItemKey: keyOf(rfq.requestId, item.requestItemSeqId),
            productId: item.productId || null,
            productText: productText(ctx.cache, item.productId) || item.description || "",
            description: item.description || "",
            quantity: plain(item.quantity),
            quantityText: quantityText(item.quantity),
            comparedQuantity: plain(comparedQuantity),
            comparedText: quantityText(comparedQuantity),
            quantityUomId: uomId,
            uomText: ctx.cache.uomText(uomId),
            requiredByText: dateText(item.requiredByDate),
            awardedText: quantityText(awardedOf(ctx, item)),
            remaining: plain(remaining),
            remainingText: quantityText(remaining),
            sourceText: item.sourceRequestId ? keyOf(item.sourceRequestId, item.sourceRequestItemSeqId) : "",
            requirementId: item.requirementId,
            offerCount: offers.length,
            comparableCount: offers.filter(row => row.comparable).length,
            bestText: best ? best.supplierName + " · " + best.normalizedText : offers.length ? "Not comparable" : "No offer"
        })
        offerRows = offerRows.concat(offers)
    }
    const basis = {
        requestId: rfq.requestId,
        requestName: rfq.request.requestName || rfq.requestId,
        organizationPartyId: rfq.organizationPartyId,
        organizationName: partyName(rfq.organizationPartyId),
        sourceRevision: revision,
        revisionText: revision ? "Revision of " + dateText(revision) : "Draft",
        displayCurrencyUomId,
        fxDay,
        basisText:
            "Prices per demand unit in " +
            (displayCurrencyUomId || "the quote's currency") +
            " at the rates of " +
            fxDay +
            "; committed price and estimated landed cost apart"
    }
    const result = {basis, demandRows, offerRows}
    const output = text(p.output)
    if (output === "csv")
        Object.assign(result, {
            csvText: csvOf(basis, demandRows, offerRows),
            fileName: "RFQ-" + rfq.requestId + "-comparison.csv"
        })
    if (output === "print")
        Object.assign(result, {
            printHtml: printOf(basis, demandRows, offerRows),
            fileName: "RFQ-" + rfq.requestId + "-comparison.pdf"
        })
    return result
}
const csvCell = value => {
    const textValue = value == null ? "" : String(value)
    return /[",\n\r]/.test(textValue) ? '"' + textValue.replace(/"/g, '""') + '"' : textValue
}
// The comparison as CSV: one row per offer with the original basis (quoted quantity, unit, price, currency) and the normalized
// one (unit price in the display currency per demand unit, committed amount, estimated landed amount), plain numbers.
function csvOf(basis, demandRows, offerRows) {
    const header = [
        "RFQ",
        "Item",
        "Product",
        "Demand quantity",
        "Demand unit",
        "Supplier",
        "Quote",
        "Line",
        "State",
        "Offered product",
        "Quoted quantity",
        "Quoted unit price",
        "Quote currency",
        "Basis",
        "Unit price",
        "Display currency",
        "Committed amount",
        "Estimated landed amount",
        "Lead days",
        "Validity",
        "Risk",
        "Rank",
        "Not comparable"
    ]
    const lines = [header.map(csvCell).join(",")]
    for (const row of offerRows) {
        const demand = demandRows.find(other => other.requestItemSeqId === row.requestItemSeqId) || {}
        lines.push(
            [
                basis.requestId,
                row.requestItemSeqId,
                demand.productText,
                demand.comparedQuantity,
                demand.uomText,
                row.supplierName,
                row.orderId,
                row.orderItemSeqId,
                row.statusText,
                row.productText,
                row.quotedQuantityText,
                row.quotedPrice,
                row.currencyUomId,
                row.basisText,
                row.normalizedPrice,
                basis.displayCurrencyUomId,
                row.committedAmount,
                row.landedAmount,
                row.leadDays == null ? "" : row.leadDays,
                row.validityText,
                row.riskText,
                row.rank == null ? "" : row.rank,
                row.comparable ? "" : row.reasonText
            ]
                .map(csvCell)
                .join(",")
        )
    }
    return lines.join("\r\n") + "\r\n"
}
function printOf(basis, demandRows, offerRows) {
    return ec.resource.template("component://mr-mantle/template/order/QuoteComparison.print.html.fancy", {
        requestId: basis.requestId,
        requestName: basis.requestName,
        organizationName: basis.organizationName,
        revisionText: basis.revisionText,
        basisText: basis.basisText,
        demands: demandRows.map(demand => ({
            productText: demand.productText,
            quantityText: demand.comparedText,
            uomText: demand.uomText,
            requiredText: demand.requiredByText,
            remainingText: demand.remainingText,
            offers: offerRows
                .filter(row => row.requestItemSeqId === demand.requestItemSeqId)
                .map(row => ({
                    rankText: row.rankText,
                    supplierName: row.supplierName,
                    statusText: row.statusText,
                    originalText: row.originalText,
                    basisText: row.basisText,
                    normalizedText: row.comparable ? row.normalizedText : "Not comparable",
                    committedText: row.committedText || "",
                    freightText: row.freightText,
                    landedText: row.landedText,
                    leadText: row.leadText,
                    validityText: row.validityText,
                    riskText: row.riskText,
                    reasonText: row.comparable ? "" : row.reasonText
                }))
        }))
    })
}

// ===== allocations =====
// The allocations of an award: a list of {orderId, orderItemSeqId, requestItemSeqId, quantity, substituteApproved}, or a text
// of "orderId:orderItemSeqId:requestItemSeqId:quantity[:S]" entries separated by ";" or new lines (S accepts a substitute);
// an empty or zero quantity is no allocation.
function allocationsOf(p) {
    const list = []
    for (const row of Array.from(p.allocations || []))
        list.push({
            orderId: text(row.orderId),
            orderItemSeqId: text(row.orderItemSeqId),
            requestItemSeqId: text(row.requestItemSeqId),
            quantity: row.quantity,
            substituteApproved: truthy(row.substituteApproved)
        })
    for (const entry of String(p.allocationsText || "").split(/[;\n]+/)) {
        const fields = entry.trim().split(":")
        if (fields.length < 4) continue
        list.push({
            orderId: text(fields[0]),
            orderItemSeqId: text(fields[1]),
            requestItemSeqId: text(fields[2]),
            quantity: fields[3],
            substituteApproved:
                String(fields[4] || "")
                    .trim()
                    .toUpperCase() === "S"
        })
    }
    return list
        .filter(row => row.orderId && row.orderItemSeqId && !blank(row.quantity))
        .map(row => Object.assign(row, {quantity: decimal(row.quantity, "quantity")}))
        .filter(row => row.quantity.compare(0) > 0)
        .map(row => Object.assign(row, {quantity: plain(row.quantity)}))
        .sort((a, b) => (a.orderId + ":" + a.orderItemSeqId).localeCompare(b.orderId + ":" + b.orderItemSeqId))
}
const quoteRevisionsOf = p =>
    Object.fromEntries(
        String(p.quoteRevisions || "")
            .split(",")
            .map(entry => entry.trim().split(":"))
            .filter(pair => pair.length === 2 && pair[0] && /^\d+$/.test(pair[1]))
            .map(([orderId, revision]) => [orderId, Number(revision)])
    )
// The budget decision of an award group's lines that no purchase request reserved, at the PO stage (check#Budget, nothing
// written): NONE when no line is under an approved budget, WITHHELD for a user who may not read budgets (the purchase order's
// approval decides it, P4), else OK, WARN or STOP with the rows.
function budgetOf(organizationPartyId, supplierPartyId, lines) {
    const byAccount = {}
    for (const line of lines.filter(row => !row.requirementId && row.amount.compare(0) > 0)) {
        let glAccountId = null
        try {
            glAccountId =
                call("mantle.ledger.InvoiceAutoPostServices.get#InvoiceItemGlAccount", {
                    organizationPartyId,
                    otherPartyId: supplierPartyId,
                    itemTypeEnumId: "ItemProduct",
                    productId: line.productId || null,
                    direction: "I"
                }).glAccountId || null
        } catch (error) {
            ec.logger.warn("Award budget account of " + line.productId + " not found: " + error.message)
        }
        if (glAccountId) byAccount[glAccountId] = dec(byAccount[glAccountId]).add(line.amount)
    }
    if (!Object.keys(byAccount).length) return {result: "NONE", message: ""}
    if (!budgetPermissions.some(permission => access.has(permission)))
        return {result: "WITHHELD", message: "The purchase order's approval decides its budget"}
    try {
        const checked = probe("mantle.other.BudgetServices.check#Budget", {
            organizationPartyId,
            stageEnumId: "BcsOrder",
            lines: Object.entries(byAccount).map(([glAccountId, amount]) => ({glAccountId, amount}))
        })
        const checkRows = Array.from(checked.checkList || [])
        if (!checkRows.some(row => row.budgetId)) return {result: "NONE", message: ""}
        const message = checkRows
            .filter(row => row.message)
            .map(row => row.message)
            .join("; ")
        return {result: checked.blocked ? "STOP" : checked.warned ? "WARN" : "OK", message}
    } catch (error) {
        return {result: "WITHHELD", message: String(error.message || error).replace(/^(Error: )+/, "")}
    }
}
// The award planned: each allocation read against its quote, line and demand item, grouped per quote (one supplier each),
// each line's and group's refusal named; the demand rows with what is allocated against what is left. Nothing written.
function planAward(rfq, allocations, p, ctx = contextOf(rfq)) {
    const quoteRevisions = quoteRevisionsOf(p)
    const groups = new Map()
    const allocatedByItem = {}
    for (const allocation of allocations) {
        const quote = ctx.quotes.find(row => row.orderId === allocation.orderId)
        const key = allocation.orderId
        if (!groups.has(key))
            groups.set(key, {orderId: allocation.orderId, quote: quote || null, lines: [], errorCode: null, errorMessage: null})
        const group = groups.get(key)
        const lineRow = {allocation, errorCode: null, errorMessage: null}
        group.lines.push(lineRow)
        const fail = (code, message) => {
            lineRow.errorCode = lineRow.errorCode || code
            lineRow.errorMessage = lineRow.errorMessage || message
        }
        if (!quote) {
            fail("INVITATION_UNAVAILABLE", "Order " + allocation.orderId + " is not a quote of RFQ " + rfq.requestId)
            continue
        }
        const line = quote.lines.find(row => row.orderItemSeqId === allocation.orderItemSeqId)
        if (!line) {
            fail("ITEM_UNAVAILABLE", "Line " + allocation.orderItemSeqId + " is not on quote " + quote.orderId)
            continue
        }
        const linkedSeq = quote.links.find(row => row.orderItemSeqId === line.orderItemSeqId)?.requestItemSeqId || null
        const item = ctx.items.find(row => row.requestItemSeqId === (allocation.requestItemSeqId || linkedSeq))
        lineRow.line = line
        lineRow.item = item || null
        if (!item) {
            fail("DEMAND_REQUIRED", "Choose the RFQ item line " + line.orderItemSeqId + " of quote " + quote.orderId + " is for")
            continue
        }
        if (linkedSeq && linkedSeq !== item.requestItemSeqId)
            fail("DEMAND_INVALID", "Line " + line.orderItemSeqId + " of quote " + quote.orderId + " answers item " + linkedSeq)
        const basis = basisOf(ctx.cache, line, item)
        lineRow.basis = basis
        if (!basis.comparable) {
            fail(basis.reasonCode, basis.reasonText)
            continue
        }
        const demandQuantity = dec(allocation.quantity)
        const lineQuantity = demandQuantity.divide(basis.factor, 12, "HALF_UP")
        if (basis.kind === "pack" && lineQuantity.compare(lineQuantity.setScale(0, "DOWN")) !== 0)
            fail("QUANTITY_NOT_WHOLE", "Allocate whole packs of " + (line.productId || "") + ": " + basis.basisText)
        if (basis.kind === "substitute" && !allocation.substituteApproved)
            fail(
                "INVALID_SUBSTITUTE",
                (ctx.cache.product(line.productId)?.productName || line.productId) +
                    " is a substitute for item " +
                    item.requestItemSeqId +
                    "; accept the substitute to award it"
            )
        lineRow.demandQuantity = demandQuantity
        lineRow.lineQuantity = basis.kind === "pack" ? lineQuantity.setScale(0, "HALF_UP") : lineQuantity.setScale(6, "HALF_UP")
        lineRow.price = priceAt(line, quote.order.currencyUomId, lineRow.lineQuantity)
        if (!lineRow.price) fail("NOT_QUOTED", "Line " + line.orderItemSeqId + " of quote " + quote.orderId + " has no price")
        lineRow.amount = lineRow.price ? lineRow.price.price.multiply(lineRow.lineQuantity) : zero()
        allocatedByItem[item.requestItemSeqId] = dec(allocatedByItem[item.requestItemSeqId]).add(demandQuantity)
    }
    // each item's allocation against what is left of it
    const demandRows = ctx.items.map(item => {
        const remaining = remainingOf(ctx, item)
        const allocated = dec(allocatedByItem[item.requestItemSeqId])
        const uomId = item.quantityUomId || ctx.cache.product(item.productId)?.amountUomId || null
        return {
            requestItemSeqId: item.requestItemSeqId,
            productText: productText(ctx.cache, item.productId) || item.description || "",
            demandedText: quantityText(item.quantity),
            remaining,
            remainingText: quantityText(remaining),
            allocatedText: quantityText(allocated),
            leftText: quantityText(remaining.subtract(allocated).compare(0) > 0 ? remaining.subtract(allocated) : zero()),
            uomText: ctx.cache.uomText(uomId),
            over: allocated.compare(remaining) > 0,
            requirementId: item.requirementId
        }
    })
    // the demand left, taken by the groups in the order commit places them: a line past it is DEMAND_ALREADY_COVERED
    const left = Object.fromEntries(demandRows.map(row => [row.requestItemSeqId, row.remaining]))
    for (const group of groups.values())
        for (const lineRow of group.lines) {
            if (!lineRow.item || lineRow.demandQuantity == null) continue
            const seq = lineRow.item.requestItemSeqId
            if (lineRow.demandQuantity.compare(left[seq]) > 0 && !lineRow.errorCode)
                Object.assign(lineRow, {
                    errorCode: "DEMAND_ALREADY_COVERED",
                    errorMessage: "Item " + seq + " has " + quantityText(left[seq]) + " left to award"
                })
            if (!lineRow.errorCode) left[seq] = left[seq].subtract(lineRow.demandQuantity)
        }
    for (const group of groups.values()) {
        const quote = group.quote
        const groupFail = (code, message) => {
            group.errorCode = group.errorCode || code
            group.errorMessage = group.errorMessage || message
        }
        if (!quote) {
            groupFail("INVITATION_UNAVAILABLE", "Order " + group.orderId + " is not a quote of RFQ " + rfq.requestId)
            continue
        }
        group.supplierPartyId = quote.supplierPartyId
        group.supplierName = partyName(quote.supplierPartyId)
        const status = quote.order.statusId
        if (status !== "OrderProposed")
            groupFail(
                "QUOTE_CLOSED",
                group.supplierName +
                    "'s quote " +
                    quote.orderId +
                    (status === "OrderRequested" ? " is not answered yet" : " is " + statusText(status).toLowerCase())
            )
        else if (sourcingScript().expired(quote.part))
            groupFail(
                "QUOTE_EXPIRED",
                group.supplierName + "'s quote " + quote.orderId + " expired " + dateText(quote.part.validThruDate)
            )
        const revision = Number(quote.order.orderRevision ?? 1)
        group.quoteRevision = revision
        // the revision the award was made against (compared, or submitted for approval): commit#AwardGroup checks it under lock
        group.expectedRevision = quoteRevisions[quote.orderId] ?? revision
        if (quoteRevisions[quote.orderId] != null && quoteRevisions[quote.orderId] !== revision)
            groupFail(
                "SOURCE_CHANGED",
                group.supplierName + "'s quote " + quote.orderId + " changed since it was compared (revision " + revision + ")"
            )
        const checked = policyModule.supplierUsable(rfq.organizationPartyId, quote.supplierPartyId)
        group.supplierResult = checked.result
        group.supplierMessage = checked.message || ""
        if (checked.result === "STOP") groupFail(checked.reasonCode, checked.message)
        for (const lineRow of group.lines.filter(row => row.line?.productId && !row.errorCode)) {
            const usable = call("mantle.product.ProductServices.check#ProductUsable", {
                productId: lineRow.line.productId,
                usage: "Purchase",
                quantity: lineRow.lineQuantity || 1,
                facilityId: quote.part.facilityId || null,
                vendorPartyId: quote.supplierPartyId,
                customerPartyId: rfq.organizationPartyId
            })
            if (!usable.usable)
                Object.assign(lineRow, {
                    errorCode: "PRODUCT_NOT_USABLE",
                    errorMessage: usable.reason || lineRow.line.productId + " is not usable for buying"
                })
        }
        const firstLineError = group.lines.find(row => row.errorCode)
        if (firstLineError) groupFail(firstLineError.errorCode, firstLineError.errorMessage)
        group.currencyUomId = quote.order.currencyUomId
        group.amount = group.lines.reduce((total, row) => total.add(row.amount || zero()), zero())
        group.budget = budgetOf(
            rfq.organizationPartyId,
            quote.supplierPartyId,
            group.lines
                .filter(row => row.line)
                .map(row => ({
                    productId: row.line.productId,
                    requirementId: row.item?.requirementId,
                    amount: row.amount || zero()
                }))
        )
        if (group.budget.result === "STOP") groupFail("BUDGET_STOP", group.budget.message || "The budget stops this award")
        if (group.budget.result === "WARN" && group.budget.message) ec.message.addMessage(group.budget.message, "warning")
        const due = group.lines.map(row => ms(row.line?.promisedDate || quote.part.estimatedDeliveryDate)).filter(Number.isFinite)
        group.dueText = due.length ? dateText(Math.min(...due)) : ""
    }
    return {groups: Array.from(groups.values()), demandRows, ctx}
}
// The result envelope of an award group (design RequestSourcing's fields, RequestSourcing and Award alike).
function envelope(rfq, operationKey, group, fields) {
    const cache = cacheOf()
    const lines = group.lines || []
    const uoms = [...new Set(lines.map(row => row.item?.quantityUomId).filter(Boolean))]
    const requested = lines.reduce((total, row) => total.add(dec(row.allocation?.quantity)), zero())
    return Object.assign(
        {
            operationId: operationKey || null,
            supplierGroupId: group.orderId,
            supplierPartyId: group.supplierPartyId || null,
            supplierName: group.supplierName || "",
            orderId: group.orderId,
            orderPartSeqId: group.quote?.part?.orderPartSeqId || null,
            quoteRevision: group.quoteRevision ?? null,
            rfqRequestId: rfq.requestId,
            requestItemKeys: lines.filter(row => row.item).map(row => keyOf(rfq.requestId, row.item.requestItemSeqId)),
            requirementIds: lines.map(row => row.item?.requirementId).filter(Boolean),
            requestedQuantity: qty(requested),
            allocatedQuantity: "0",
            quantityUomId: uoms.length === 1 ? uoms[0] : null,
            currencyUomId: group.currencyUomId || null,
            amountText: group.amount != null ? money(group.amount, group.currencyUomId) : "",
            dueText: group.dueText || "",
            supplierResult: group.supplierResult || null,
            supplierMessage: group.supplierMessage || "",
            budgetResult: group.budget?.result || "NONE",
            budgetMessage: group.budget?.message || "",
            resultStatus: group.errorCode ? "FAILED" : "READY",
            statusId: group.quote?.order?.statusId || null,
            errorCode: group.errorCode || null,
            errorMessage: group.errorMessage || null,
            retryable: retryableCodes.includes(group.errorCode),
            lineRows: lines.map(row => ({
                orderItemSeqId: row.allocation.orderItemSeqId,
                requestItemSeqId: row.item?.requestItemSeqId || row.allocation.requestItemSeqId || null,
                productText: productText(cache, row.line?.productId) || row.line?.itemDescription || "",
                quantityText:
                    quantityText(row.allocation.quantity) + (row.item ? " " + cache.uomText(row.item.quantityUomId) : ""),
                lineQuantityText: row.lineQuantity != null ? quantityText(row.lineQuantity) : "",
                priceText: row.price ? money(row.price.price, group.currencyUomId) : "",
                amountText: row.amount ? money(row.amount, group.currencyUomId) : "",
                substitute: row.basis?.kind === "substitute",
                errorCode: row.errorCode || null,
                errorMessage: row.errorMessage || ""
            }))
        },
        fields
    )
}

// ===== the award's approval (PurchaseAwardApproval, D8) =====
// A quote's terms as an award saw them: its lines (product, quantity, unit, price) and validity. The order's revision does not
// count a line's change on a purchase order outside commercialRevisionOnly (increment#OrderRevision's item kind), so an award
// waiting for its approval keeps this stamp, and a quote changed since fails SOURCE_CHANGED when it is placed.
function quoteStamp(orderId) {
    const lines = rows(ORDER_ITEM, {orderId})
        .map(line =>
            [
                line.orderItemSeqId,
                line.itemTypeEnumId,
                line.productId,
                plain(line.quantity),
                plain(line.unitAmount),
                line.quantityUomId
            ]
                .map(value => (value == null ? "" : String(value)))
                .join("|")
        )
        .sort()
    const validThru = rows(PART, {orderId})[0]?.validThruDate
    return lib.hash({lines, validThru: validThru == null ? null : ms(validThru)})
}
// The award as an approval source: the RFQ at the award's revision (the time it was submitted), its amount in the RFQ's
// currency (each group at the day's rate; none when a rate is missing), the categories of its products, the submitter.
function awardSource(rfq, plan, revision, submitterUserId, awardKey) {
    const currencyUomId = rfq.request.currencyUomId || currencyOf(rfq.organizationPartyId)
    const day = dayOf(ec.user.nowTimestamp)
    let amount = zero()
    for (const group of plan.groups.filter(row => row.quote)) {
        const rate = currenciesScript().rateOn(group.currencyUomId, currencyUomId, day)
        if (!rate) {
            amount = null
            break
        }
        amount = amount.add(dec(group.amount).multiply(rate.rate))
    }
    const productIds = [...new Set(plan.groups.flatMap(group => group.lines.map(row => row.line?.productId).filter(Boolean)))]
    const categoryIds = productIds.length
        ? [
              ...new Set(
                  Array.from(
                      find("mantle.product.category.ProductCategoryMember").condition("productId", "in", productIds).list()
                  )
                      .filter(row => lib.active(row))
                      .map(row => row.productCategoryId)
              )
          ]
        : []
    const supplierText = plan.groups
        .filter(group => group.supplierName)
        .map(group => group.supplierName)
        .join(", ")
    return {
        sourceEntityName: REQUEST,
        sourceId: rfq.requestId,
        sourceTypeEnumId: "PasAward",
        topic: "PurchaseAwardApproval",
        organizationPartyId: rfq.organizationPartyId,
        supplierPartyId: null,
        amount: amount ?? zero(),
        amountKnown: amount != null,
        currencyUomId,
        facilityId: rfq.request.facilityId || null,
        categoryIds,
        revision,
        statusId: rfq.request.statusId,
        label: "the award of RFQ " + rfq.requestId,
        message: {
            requestId: rfq.requestId,
            requestName: rfq.request.requestName || rfq.requestId,
            awardKey,
            revisionText: dateText(revision),
            supplierText
        },
        submittedBy: userId => userId === submitterUserId
    }
}
// Whether the organization's policy has award approval rows in effect (else an award places at once, P3/P4's gate meeting
// each placed order).
const awardPolicyInEffect = organizationPartyId =>
    rows(POLICY, {organizationPartyId, sourceTypeEnumId: "PasAward"}).some(row => lib.active(row))

// ===== preview#Award and commit#Award =====
function preview(p) {
    requirePermission("PURCHASE_ORDER_EDIT")
    const rfq = sourcingScript().rfqOf(p.requestId)
    const allocations = allocationsOf(p)
    const revision = sourcingScript().revisionOf(rfq.requestId)
    const plan = planAward(rfq, allocations, p)
    const sourceChanged = !blank(p.sourceRevision) && Number(p.sourceRevision) !== revision
    const groupRows = plan.groups.map(group => envelope(rfq, null, group, {}))
    const approvalRequired = awardPolicyInEffect(rfq.organizationPartyId)
    let approvalText = "No award approval: each placed quote meets the purchase order approval"
    if (approvalRequired && plan.groups.length) {
        const source = awardSource(rfq, plan, revision, ec.user.userId, null)
        const state = approvalsScript().progress(Object.assign({}, source, {sourceId: "_NA_"}))
        approvalText = !source.amountKnown
            ? "The award needs an exchange rate to the RFQ's currency for its approval"
            : state.missing
              ? "No award approval policy covers " + money(source.amount, source.currencyUomId)
              : "The award is sent for approval (" +
                state.steps.length +
                (state.steps.length === 1 ? " step" : " steps") +
                ") before the quotes are placed"
    }
    return {
        requestId: rfq.requestId,
        sourceRevision: revision,
        sourceChanged,
        sourceChangedText: sourceChanged ? "The RFQ changed since it was compared; compare it again" : "",
        groupRows,
        demandRows: plan.demandRows.map(row => Object.assign({}, row, {remaining: plain(row.remaining)})),
        approvalRequired,
        approvalText,
        readyCount: groupRows.filter(row => row.resultStatus === "READY").length,
        failedCount: groupRows.filter(row => row.resultStatus === "FAILED").length,
        canCommit: !sourceChanged && groupRows.some(row => row.resultStatus === "READY")
    }
}
// Each group placed in its own transaction (commit#AwardGroup), a failure named while the others go on.
function placeAll(rfq, plan, operationKey, awardKey, quoteStamps = {}) {
    const results = []
    for (const group of plan.groups) {
        if (!group.quote || group.lines.every(row => ["INVITATION_UNAVAILABLE", "ITEM_UNAVAILABLE"].includes(row.errorCode))) {
            results.push(envelope(rfq, operationKey, group, {}))
            continue
        }
        try {
            const out = probe(S + "commit#AwardGroup", {
                requestId: rfq.requestId,
                orderId: group.orderId,
                lines: group.lines.map(row => ({
                    orderItemSeqId: row.allocation.orderItemSeqId,
                    requestItemSeqId: row.item?.requestItemSeqId || row.allocation.requestItemSeqId || null,
                    quantity: row.allocation.quantity,
                    substituteApproved: !!row.allocation.substituteApproved
                })),
                operationKey,
                quoteRevision: group.expectedRevision ?? group.quoteRevision ?? null,
                quoteStamp: quoteStamps[group.orderId] || null,
                awardKey: awardKey || null
            })
            results.push(
                envelope(rfq, operationKey, Object.assign({}, group, {errorCode: null, errorMessage: null}), {
                    resultStatus: out.existing ? "EXISTING" : "PLACED",
                    statusId: out.statusId,
                    allocatedQuantity: out.allocatedQuantity,
                    retryable: false
                })
            )
        } catch (error) {
            const message = String(error.message || error).replace(/^(Error: )+/, "")
            const errorCode = lib.reasonCode({message}) || (/([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+):/.exec(message) || [])[1] || "FAILED"
            ec.logger.warn("Award of RFQ " + rfq.requestId + " to quote " + group.orderId + " failed: " + message)
            results.push(
                envelope(rfq, operationKey, group, {
                    resultStatus: "FAILED",
                    errorCode,
                    errorMessage: message.replace(/^[A-Z_]+: /, ""),
                    retryable: retryableCodes.includes(errorCode)
                })
            )
        }
    }
    return {
        requestId: rfq.requestId,
        resultStatus: results.some(row => ["PLACED", "EXISTING"].includes(row.resultStatus)) ? "PLACED" : "FAILED",
        groupRows: results,
        placedCount: results.filter(row => row.resultStatus === "PLACED").length,
        existingCount: results.filter(row => row.resultStatus === "EXISTING").length,
        failedCount: results.filter(row => row.resultStatus === "FAILED").length
    }
}
// commit#Award: the allocations placed per quote (or sent for the award's approval where policy needs it), the same key
// answering the first result.
function commit(p) {
    requirePermission("PURCHASE_ORDER_EDIT")
    const rfq = sourcingScript().rfqOf(p.requestId, true)
    requireOpen(rfq)
    const allocations = allocationsOf(p)
    if (!allocations.length) denied("ALLOCATION_REQUIRED", "Allocate a quantity to at least one quote line")
    const quoteRevisions = quoteRevisionsOf(p)
    const request = {requestId: rfq.requestId, allocations, quoteRevisions}
    const operation = lib.operation(p, "QuoteAward", rfq.organizationPartyId, request)
    if (operation.old) return lib.previous(operation)
    const revision = sourcingScript().revisionOf(rfq.requestId)
    if (!blank(p.sourceRevision) && Number(p.sourceRevision) !== revision)
        denied("SOURCE_CHANGED", "RFQ " + rfq.requestId + " changed since it was compared; compare it again")
    const plan = planAward(rfq, allocations, p)
    if (awardPolicyInEffect(rfq.organizationPartyId)) {
        // the award waits for its decision: its allocations are the operation's, the quotes stay as they are
        const submitted = Number(ec.user.nowTimestamp)
        const source = awardSource(rfq, plan, submitted, ec.user.userId, operation.operationKey)
        if (!source.amountKnown)
            denied(
                "RATE_MISSING",
                "The award's approval needs an exchange rate from each quote's currency to " + source.currencyUomId
            )
        const state = approvalsScript().progress(source)
        if (state.missing)
            denied("POLICY_MISSING", "No award approval policy covers " + money(source.amount, source.currencyUomId))
        // each quote's revision as submitted: a quote changed while the award waits fails SOURCE_CHANGED when it is placed
        const submittedRevisions = Object.assign(
            Object.fromEntries(plan.groups.filter(group => group.quote).map(group => [group.orderId, group.quoteRevision])),
            quoteRevisions
        )
        const result = {
            requestId: rfq.requestId,
            resultStatus: "PENDING_APPROVAL",
            awardKey: operation.operationKey,
            sourceRevision: submitted,
            allocations,
            quoteRevisions: submittedRevisions,
            quoteStamps: Object.fromEntries(
                plan.groups.filter(group => group.quote).map(group => [group.orderId, quoteStamp(group.orderId)])
            ),
            amountText: money(source.amount, source.currencyUomId),
            stepText: state.current ? approvalsScript().stepText(state, state.current) : "",
            groupRows: plan.groups.map(group =>
                envelope(rfq, operation.operationKey, group, {resultStatus: group.errorCode ? "FAILED" : "PENDING_APPROVAL"})
            ),
            placedCount: 0,
            existingCount: 0,
            failedCount: 0
        }
        call("create#" + OPERATION, {
            operationKey: operation.operationKey,
            operationType: operation.operationType,
            organizationPartyId: rfq.organizationPartyId,
            userId: ec.user.userId,
            submittedDate: new Date(submitted),
            requestHash: operation.requestHash,
            status: "pending",
            resultEntityName: REQUEST,
            resultId: rfq.requestId,
            resultJson: JSON.stringify(result)
        })
        const notified = approvalsScript().notify(source, state)
        return Object.assign(result, {notifiedCount: notified.notifiedCount, alreadyApplied: false})
    }
    const result = placeAll(rfq, plan, operation.operationKey, null)
    lib.complete(operation, REQUEST, rfq.requestId, result)
    return Object.assign(result, {alreadyApplied: false})
}
// Whether this award placed a quote already: its note names the operation (an award has no record of its own).
const awardedBy = (orderId, operationKey) =>
    rows("mantle.order.OrderNote", {orderId}).some(note => String(note.noteText || "").includes("(award " + operationKey + ")"))
// The approver's placing of an approved award: the user decides purchase approvals, and the award's operation is approved
// (every step done) and names the quote.
function requireAwardApproved(requestId, awardKey, orderId) {
    requirePermission("PURCHASE_APPROVE")
    const op = one(OPERATION, {operationKey: awardKey})
    const pending = op ? lib.json(op.resultJson, {}) : {}
    if (
        !op ||
        op.operationType !== "QuoteAward" ||
        op.resultId !== requestId ||
        !["approved", "complete"].includes(op.status) ||
        !Array.from(pending.allocations || []).some(row => row.orderId === orderId)
    )
        denied("AWARD_NOT_APPROVED", "The award of RFQ " + requestId + " is not approved")
}
// commit#AwardGroup: one quote placed as its award group, in the caller's transaction, under the lock of the quote and of its
// lines' requirements; each refusal by name.
function commitGroup(p) {
    const awardKey = text(p.awardKey)
    if (awardKey) requireAwardApproved(String(p.requestId), awardKey, String(p.orderId))
    else requirePermission("PURCHASE_ORDER_EDIT")
    const operationKey = text(p.operationKey)
    if (!operationKey) denied("OPERATION_KEY_REQUIRED", "An operation key is required")
    const requestId = String(p.requestId || "")
    const po = ordersScript().purchaseOrder(p.orderId, true)
    // an award where the organization's award approval is in effect is placed only as an approved award (decide#AwardApproval)
    if (!awardKey && awardPolicyInEffect(po.organizationPartyId))
        denied(
            "AWARD_APPROVAL_REQUIRED",
            "The award of RFQ " + requestId + " needs its approval before quote " + po.orderId + " is placed"
        )
    const supplierName = partyName(po.supplierPartyId)
    const links = rows(ITEM_ORDER, {orderId: po.orderId}).filter(link => link.requestId === requestId)
    if (!links.length) denied("INVITATION_UNAVAILABLE", "Order " + po.orderId + " is not a quote of RFQ " + requestId)
    if (po.order.statusId !== "OrderProposed") {
        if (awardedStatus(po.order.statusId) && awardedBy(po.orderId, operationKey))
            return {orderId: po.orderId, statusId: po.order.statusId, existing: true, allocatedQuantity: ""}
        denied("QUOTE_CLOSED", supplierName + "'s quote " + po.orderId + " is " + statusText(po.order.statusId).toLowerCase())
    }
    if (
        (!blank(p.quoteRevision) && Number(p.quoteRevision) !== Number(po.order.orderRevision ?? 1)) ||
        (!blank(p.quoteStamp) && quoteStamp(po.orderId) !== String(p.quoteStamp))
    )
        denied("SOURCE_CHANGED", supplierName + "'s quote " + po.orderId + " changed since it was compared")
    if (sourcingScript().expired(po.part))
        denied("QUOTE_EXPIRED", supplierName + "'s quote " + po.orderId + " expired " + dateText(po.part.validThruDate))
    const checked = policyModule.supplierUsable(po.organizationPartyId, po.supplierPartyId)
    if (checked.result === "STOP") denied(checked.reasonCode, checked.message)
    // the RFQ's items (read without its header row, which the award's caller holds) and their requirements, locked in id order
    const cache = cacheOf()
    const items = rows(ITEM, {requestId})
        .filter(item => item.statusId !== "ReqCancelled")
        .map(item => Object.assign(lib.map(item), sourceOf(requestId, item.requestItemSeqId)))
    const lines = Array.from(p.lines || []).map(row => ({
        orderItemSeqId: text(row.orderItemSeqId),
        requestItemSeqId: text(row.requestItemSeqId),
        quantity: decimal(row.quantity, "quantity"),
        substituteApproved: truthy(row.substituteApproved)
    }))
    if (!lines.length) denied("ALLOCATION_REQUIRED", "Allocate a quantity to a line of quote " + po.orderId)
    const requirementIds = [
        ...new Set(
            lines.map(row => items.find(item => item.requestItemSeqId === row.requestItemSeqId)?.requirementId).filter(Boolean)
        )
    ].sort()
    for (const requirementId of requirementIds) find(REQUIREMENT, {requirementId}).forUpdate(true).one()
    // what the other quotes of the RFQ awarded, read after the locks
    const ctx = {
        rfq: {requestId},
        items,
        cache,
        quotes: sourcingScript()
            .invitationsOf(requestId)
            .map(invitation =>
                Object.assign(invitation, {
                    lines: rows(ORDER_ITEM, {orderId: invitation.orderId}).map(lib.map),
                    links: rows(ITEM_ORDER, {orderId: invitation.orderId}).filter(link => link.requestId === requestId)
                })
            )
    }
    const quoteLines = rows(ORDER_ITEM, {orderId: po.orderId}).map(lib.map)
    const allocatedByItem = {}
    const chosen = []
    for (const row of lines) {
        const line = quoteLines.find(other => other.orderItemSeqId === row.orderItemSeqId)
        if (!line) denied("ITEM_UNAVAILABLE", "Line " + row.orderItemSeqId + " is not on quote " + po.orderId)
        const link = links.find(other => other.orderItemSeqId === line.orderItemSeqId)
        const item = items.find(other => other.requestItemSeqId === (row.requestItemSeqId || link?.requestItemSeqId))
        if (!item) denied("DEMAND_REQUIRED", "Choose the RFQ item line " + line.orderItemSeqId + " is for")
        if (link && link.requestItemSeqId !== item.requestItemSeqId)
            denied("DEMAND_INVALID", "Line " + line.orderItemSeqId + " answers item " + link.requestItemSeqId)
        const basis = basisOf(cache, line, item)
        if (!basis.comparable) denied(basis.reasonCode, basis.reasonText)
        if (basis.kind === "substitute" && !row.substituteApproved)
            denied("INVALID_SUBSTITUTE", (line.productId || "") + " is a substitute for item " + item.requestItemSeqId)
        const lineQuantity = row.quantity.divide(basis.factor, 12, "HALF_UP")
        if (basis.kind === "pack" && lineQuantity.compare(lineQuantity.setScale(0, "DOWN")) !== 0)
            denied("QUANTITY_NOT_WHOLE", "Allocate whole packs: " + basis.basisText)
        const remaining = remainingOf(ctx, item, po.orderId).subtract(dec(allocatedByItem[item.requestItemSeqId]))
        if (row.quantity.compare(remaining) > 0)
            denied(
                "DEMAND_ALREADY_COVERED",
                "Item " + item.requestItemSeqId + " of RFQ " + requestId + " has " + quantityText(remaining) + " left to award"
            )
        allocatedByItem[item.requestItemSeqId] = dec(allocatedByItem[item.requestItemSeqId]).add(row.quantity)
        if (line.productId) {
            const usable = call("mantle.product.ProductServices.check#ProductUsable", {
                productId: line.productId,
                usage: "Purchase",
                quantity: lineQuantity,
                facilityId: po.part.facilityId || null,
                vendorPartyId: po.supplierPartyId,
                customerPartyId: po.organizationPartyId
            })
            if (!usable.usable) denied("PRODUCT_NOT_USABLE", usable.reason || line.productId + " is not usable for buying")
        }
        const scaled = basis.kind === "pack" ? lineQuantity.setScale(0, "HALF_UP") : lineQuantity.setScale(6, "HALF_UP")
        const price = priceAt(line, po.order.currencyUomId, scaled)
        if (!price) denied("NOT_QUOTED", "Line " + line.orderItemSeqId + " of quote " + po.orderId + " has no price")
        chosen.push({row, line, link, item, lineQuantity: scaled, price, amount: price.price.multiply(scaled)})
    }
    const budget = budgetOf(
        po.organizationPartyId,
        po.supplierPartyId,
        chosen.map(entry => ({productId: entry.line.productId, requirementId: entry.item.requirementId, amount: entry.amount}))
    )
    if (budget.result === "STOP") denied("BUDGET_STOP", budget.message || "The budget stops this award")

    // the award: each chosen line's quantity (and a tier's price), the lines not chosen taken off and named in a note
    const reason = "Awarded from RFQ " + requestId
    const chosenSeqIds = chosen.map(entry => entry.line.orderItemSeqId)
    for (const entry of chosen) {
        // the price always given: update#OrderItem without one prices the line again by the resolver
        const values = {quantity: entry.lineQuantity, unitAmount: entry.price.price, isModifiedPrice: "Y"}
        if (entry.price.productPriceId) values.productPriceId = entry.price.productPriceId
        const changed = ["quantity"].concat(entry.price.price.compare(dec(entry.line.unitAmount)) !== 0 ? ["unitAmount"] : [])
        const reasons = Object.fromEntries(changed.map(field => [field + "_changeReason", reason]))
        call(
            "mantle.order.OrderServices.update#OrderItem",
            Object.assign({orderId: po.orderId, orderItemSeqId: entry.line.orderItemSeqId}, values, reasons)
        )
    }
    const removed = []
    for (const line of quoteLines) {
        if (chosenSeqIds.includes(line.orderItemSeqId) || line.itemTypeEnumId === "ItemShipping" || line.parentItemSeqId) continue
        for (const link of rows(ITEM_ORDER, {orderId: po.orderId, orderItemSeqId: line.orderItemSeqId}))
            call("delete#" + ITEM_ORDER, {requestItemOrderId: link.requestItemOrderId})
        call("mantle.order.OrderServices.delete#OrderItem", {orderId: po.orderId, orderItemSeqId: line.orderItemSeqId})
        removed.push(
            line.orderItemSeqId +
                " (" +
                (productText(cache, line.productId) || line.itemDescription || "") +
                ", " +
                quantityText(line.quantity) +
                " at " +
                money(line.unitAmount, po.order.currencyUomId) +
                ")"
        )
    }
    // the lineage: the RFQ's link at the awarded quantity, and for request demand the request line's link and its supply
    let allocated = zero()
    for (const entry of chosen) {
        const demandQuantity = entry.row.quantity
        if (entry.link)
            call("update#" + ITEM_ORDER, {requestItemOrderId: entry.link.requestItemOrderId, quantity: demandQuantity})
        else
            call("create#" + ITEM_ORDER, {
                requestId,
                requestItemSeqId: entry.item.requestItemSeqId,
                orderId: po.orderId,
                orderItemSeqId: entry.line.orderItemSeqId,
                quantity: demandQuantity
            })
        if (entry.item.requirementId) {
            call("create#" + ITEM_ORDER, {
                requestId: entry.item.sourceRequestId,
                requestItemSeqId: entry.item.sourceRequestItemSeqId,
                orderId: po.orderId,
                orderItemSeqId: entry.line.orderItemSeqId,
                quantity: demandQuantity
            })
            call("create#" + SUPPLY, {
                requirementId: entry.item.requirementId,
                supplyTypeEnumId: "RstPurchaseOrder",
                orderId: po.orderId,
                orderItemSeqId: entry.line.orderItemSeqId,
                requestId: entry.item.sourceRequestId,
                requestItemSeqId: entry.item.sourceRequestItemSeqId,
                quantity: demandQuantity,
                quantityUomId: entry.item.quantityUomId || null,
                operationKey,
                fromDate: ec.user.nowTimestamp,
                createdByUserId: ec.user.userId
            })
            const requirement = one(REQUIREMENT, {requirementId: entry.item.requirementId})
            if (
                requirement.statusId === "RqmtStApproved" &&
                planningScript().coveredOf(entry.item.requirementId).compare(dec(requirement.quantity)) >= 0
            )
                call("update#" + REQUIREMENT, {requirementId: entry.item.requirementId, statusId: "RqmtStOrdered"})
        }
        allocated = allocated.add(demandQuantity)
    }
    call("create#mantle.order.OrderNote", {
        orderId: po.orderId,
        noteDate: ec.user.nowTimestamp,
        noteText:
            reason +
            " (award " +
            operationKey +
            "): lines " +
            chosenSeqIds.join(", ") +
            (removed.length ? "; not awarded and taken off: " + removed.join("; ") : ""),
        internalNote: "Y",
        userId: ec.user.userId
    })
    // the awarded prices kept: a line repriced (update#OrderItem without a price) or a zero total would let Mantle's
    // autoApprove#Order approve the placed order with the gate off, so the group is refused by name instead (F-P12-4)
    for (const entry of chosen) {
        const kept = one(ORDER_ITEM, {orderId: po.orderId, orderItemSeqId: entry.line.orderItemSeqId})
        if (!kept || dec(kept.unitAmount).compare(entry.price.price) !== 0)
            denied(
                "AWARD_PRICE_LOST",
                "Line " + entry.line.orderItemSeqId + " of quote " + po.orderId + " lost its awarded price"
            )
    }
    if (dec(one(ORDER, {orderId: po.orderId}).grandTotal).compare(0) <= 0)
        denied("AWARD_PRICE_LOST", supplierName + "'s quote " + po.orderId + " totals zero; it is not placed")
    // Place from Quote: Mantle's OrderPlaced rules run, and with the approval gate on the order waits for its decision (P3/P4)
    call("mantle.order.OrderServices.place#Order", {orderId: po.orderId})
    const statusId = one(ORDER, {orderId: po.orderId}).statusId
    if (statusId === "OrderPlaced")
        approvalsScript().notify(approvalsScript().orderSource(ordersScript().purchaseOrder(po.orderId)))
    return {orderId: po.orderId, orderPartSeqId: po.orderPartSeqId, statusId, existing: false, allocatedQuantity: qty(allocated)}
}
// record#AwardDecision: one approver's decision on an award waiting, in its own transaction (so the placing that follows
// sees it): the step's checks (Purchasing's policy steps for PasAward), the decision kept at the award's revision; a refusal
// ends the award (its quotes as they were), the last step's approval marks it approved for placing, another step is sent on.
function recordDecision(p) {
    requirePermission("PURCHASE_APPROVE")
    const rfq = sourcingScript().rfqOf(p.requestId, true)
    const awardKey = text(p.awardKey)
    const op = awardKey ? find(OPERATION, {operationKey: awardKey}).forUpdate(true).one() : null
    if (!op || op.operationType !== "QuoteAward" || op.resultId !== rfq.requestId)
        denied("AWARD_UNAVAILABLE", "No award " + (awardKey || "") + " of RFQ " + rfq.requestId + " waits for a decision")
    const pending = lib.json(op.resultJson, {})
    if (["complete", "refused"].includes(op.status)) return {resultStatus: "DECIDED"}
    if (op.status === "approved") return {resultStatus: "APPROVED"}
    const revision = Number(pending.sourceRevision)
    if (!blank(p.sourceRevision) && Number(p.sourceRevision) !== revision)
        denied(
            "STALE_REVISION",
            "The award of RFQ " + rfq.requestId + " is at revision " + dateText(revision) + "; review it again"
        )
    requireOpen(rfq)
    const decision = String(p.decision || "approve")
    if (!["approve", "refuse"].includes(decision)) denied("DECISION_INVALID", "Approve or refuse the award")
    // the RFQ changed after the award was submitted: it may be refused, not approved (the buyer awards it again)
    if (decision === "approve" && sourcingScript().revisionOf(rfq.requestId) > revision)
        denied("STALE_REVISION", "RFQ " + rfq.requestId + " changed after its award was submitted; refuse it and award again")
    const reason = text(p.reason)
    if (decision === "refuse" && !reason) denied("REASON_REQUIRED", "Give the reason for refusing the award")
    const plan = planAward(rfq, Array.from(pending.allocations || []), {quoteRevisions: ""})
    const source = awardSource(rfq, plan, revision, op.userId, awardKey)
    const state = approvalsScript().progress(source)
    if (state.missing) denied("POLICY_MISSING", "No award approval policy covers " + money(source.amount, source.currencyUomId))
    const partyId = ec.user.userAccount?.partyId || null
    const refusal = approvalsScript().refusalFor(source, state, ec.user.userId, partyId)
    if (refusal) denied(refusal[0], refusal[1])
    const policyRow = policyModule.effective(rfq.organizationPartyId).row
    call("create#" + DECISION, {
        sourceEntityName: REQUEST,
        sourceId: rfq.requestId,
        sourceRevision: revision,
        organizationPartyId: rfq.organizationPartyId,
        decisionEnumId: decision === "approve" ? "PadApproved" : "PadRefused",
        decisionDate: ec.user.nowTimestamp,
        decidedByUserId: ec.user.userId,
        decidedByPartyId: partyId,
        reason,
        policyFromDate: policyRow ? policyRow.fromDate : null,
        approvalPolicyId: state.current?.purchaseApprovalPolicyId || null,
        stepSeqId: state.current ? String(state.current.sequenceNum) : null
    })
    if (decision === "refuse") {
        const refused = Object.assign({}, pending, {resultStatus: "REFUSED", reason, placedCount: 0})
        refused.groupRows = Array.from(pending.groupRows || []).map(row => Object.assign({}, row, {resultStatus: "REFUSED"}))
        call("update#" + OPERATION, {
            operationKey: awardKey,
            status: "refused",
            completedDate: ec.user.nowTimestamp,
            resultJson: JSON.stringify(refused)
        })
        approvalsScript().clearNotices(source)
        return {resultStatus: "REFUSED"}
    }
    const after = approvalsScript().progress(source)
    if (after.complete) {
        call("update#" + OPERATION, {operationKey: awardKey, status: "approved"})
        approvalsScript().clearNotices(source)
        return {resultStatus: "APPROVED"}
    }
    approvalsScript().notify(source, after)
    return {resultStatus: "WAITING", stepText: after.current ? approvalsScript().stepText(after, after.current) : ""}
}
// decide#AwardApproval: the decision recorded (record#AwardDecision, committed on its own), and on the last approval the
// award's groups placed as commit#Award places them, the award's result kept; a retry answers the first result, and an
// approval whose placing was cut short places what is left (each group answers EXISTING once placed).
function decide(p) {
    requirePermission("PURCHASE_APPROVE")
    const recorded = probe(S + "record#AwardDecision", {
        requestId: p.requestId,
        awardKey: p.awardKey,
        sourceRevision: p.sourceRevision ?? null,
        decision: p.decision,
        reason: p.reason
    })
    const op = one(OPERATION, {operationKey: String(p.awardKey)})
    if (recorded.resultStatus === "DECIDED") return Object.assign(lib.json(op.resultJson, {}), {alreadyApplied: true})
    if (recorded.resultStatus !== "APPROVED")
        return {
            requestId: String(p.requestId),
            resultStatus: recorded.resultStatus,
            stepText: recorded.stepText || "",
            groupRows: []
        }
    // the placing under the RFQ's lock, as commit#Award's (another award or a close waits); an approval placed already by a
    // concurrent decision answers its result
    const rfq = sourcingScript().rfqOf(p.requestId, true)
    const current = one(OPERATION, {operationKey: String(p.awardKey)})
    if (current.status === "complete") return Object.assign(lib.json(current.resultJson, {}), {alreadyApplied: true})
    const pending = lib.json(current.resultJson, {})
    // each quote at its revision when the award was submitted (SOURCE_CHANGED for one changed since)
    const quoteRevisions = Object.entries(pending.quoteRevisions || {})
        .map(([orderId, revision]) => orderId + ":" + revision)
        .join(",")
    const plan = planAward(rfq, Array.from(pending.allocations || []), {quoteRevisions})
    const result = placeAll(rfq, plan, String(p.awardKey), String(p.awardKey), pending.quoteStamps || {})
    call("update#" + OPERATION, {
        operationKey: String(p.awardKey),
        status: "complete",
        completedDate: ec.user.nowTimestamp,
        resultJson: JSON.stringify(Object.assign({}, result, {awardKey: String(p.awardKey), allocations: pending.allocations}))
    })
    return Object.assign(result, {alreadyApplied: false})
}

// ===== close#QuoteRequest =====
const defaultRegret = (rfq, organizationName) =>
    "Thank you for your quote for our request " +
    rfq.requestId +
    (rfq.request.requestName ? " (" + rfq.request.requestName + ")" : "") +
    ". We have closed this request, and your quote was not selected this time. We appreciate your time and hope to work with you on a future request.\n\n" +
    organizationName
// The capabilities of a quote's supplier pages, ended now (P16 issues them; a quote not awarded takes no more answers).
function revokeCapabilities(orderId) {
    let revoked = 0
    for (const row of rows(CAPABILITY, {recordId: orderId})) {
        if (!capabilityRecordTypes.includes(row.recordType) || row.revokedDate) continue
        if (row.thruDate && ms(row.thruDate) <= Number(ec.user.nowTimestamp)) continue
        call("update#" + CAPABILITY, {
            capabilityId: row.capabilityId,
            revokedDate: ec.user.nowTimestamp,
            revokedByUserId: ec.user.userId
        })
        revoked++
    }
    return revoked
}
// One recipient's regret notice, in its own transaction: sent, queued or failed; one that went is the quote's
// OrderEmailMessage in the supplier's role.
function mailRegret(rfq, quote, recipient, fromAddress, fromName, body, subject, emailTemplateId) {
    let emailMessageId = null
    ec.message.pushErrors()
    try {
        const out =
            ec.service
                .sync()
                .name("org.moqui.impl.EmailServices.send#EmailTemplate")
                .parameters({
                    emailTemplateId: emailTemplateId || "MANTLE_RFQ_REGRET_EMAIL",
                    toAddresses: recipient,
                    bodyParameters: {requestId: rfq.requestId, orderId: quote.orderId, subject, fromAddress, fromName},
                    body
                })
                .requireNewTransaction(true)
                .disableAuthz()
                .call() || {}
        if (!ec.message.hasError()) emailMessageId = out.emailMessageId || null
    } catch (error) {
        ec.logger.error("Regret notice of RFQ " + rfq.requestId + " to " + recipient + " was not sent: " + error.message)
    } finally {
        ec.message.clearErrors()
        ec.message.popErrors()
    }
    const message = emailMessageId ? one("moqui.basic.email.EmailMessage", {emailMessageId}) : null
    if (message)
        call("create#mantle.order.OrderEmailMessage", {
            orderId: quote.orderId,
            emailMessageId,
            orderRevision: Number(quote.order.orderRevision ?? 1),
            partyId: quote.supplierPartyId,
            roleTypeId: "Supplier"
        })
    return message?.statusId === "ES_SENT"
        ? "sent"
        : ["ES_READY", "ES_SCHEDULED"].includes(message?.statusId)
          ? "queued"
          : "failed"
}
const addressValid = recipient => /^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(recipient)
// close#QuoteRequest: the quotes left cancelled as Not awarded, their capabilities revoked, the regret notice (reviewed in
// the preview) sent per recipient, and the RFQ completed; with preview, what it would do, writing nothing.
function close(p) {
    requirePermission("PURCHASE_ORDER_EDIT")
    const isPreview = truthy(p.preview)
    const rfq = sourcingScript().rfqOf(p.requestId, !isPreview)
    requireOpen(rfq)
    const pendingAward =
        find(OPERATION, {operationType: "QuoteAward", resultId: rfq.requestId})
            .condition("status", "in", ["pending", "approved"])
            .count() > 0
    if (pendingAward && !isPreview)
        denied("AWARD_PENDING", "An award of RFQ " + rfq.requestId + " waits for its approval; close it once it is decided")
    const ctx = contextOf(rfq)
    const closing = ctx.quotes.filter(quote => quoteStatuses.includes(quote.order.statusId))
    const awardedQuotes = ctx.quotes.filter(quote => awardedStatus(quote.order.statusId))
    const organizationName = partyName(rfq.organizationPartyId)
    const sendRegret = truthy(p.sendRegret)
    const regretMessage = text(p.regretMessage) || defaultRegret(rfq, organizationName)
    // warnings: draft purchase orders still open for the same demand, and the demand left uncovered for the next run
    const requirementIds = ctx.items.map(item => item.requirementId).filter(Boolean)
    const draftIds = requirementIds.length
        ? [
              ...new Set(
                  Array.from(find(SUPPLY).condition("requirementId", "in", requirementIds).list())
                      .map(row => row.orderId)
                      .filter(orderId => orderId && one(ORDER, {orderId})?.statusId === "OrderOpen")
              )
          ]
        : []
    const uncovered = ctx.items
        .map(item => ({item, remaining: remainingOf(ctx, item)}))
        .filter(entry => entry.remaining.compare(0) > 0)
    const warnings = []
    if (draftIds.length) warnings.push("Draft purchase orders " + draftIds.join(", ") + " remain for the same demand")
    if (uncovered.length)
        warnings.push(
            "Left uncovered for the next run: " +
                uncovered.map(entry => "item " + entry.item.requestItemSeqId + " " + quantityText(entry.remaining)).join(", ")
        )
    if (pendingAward) warnings.push("An award of this RFQ waits for its approval")
    const recipientsOf = quote => documentsScript().recipientsOf(quote.supplierPartyId)
    const closingRows = closing.map(quote => ({
        orderId: quote.orderId,
        supplierPartyId: quote.supplierPartyId,
        supplierName: partyName(quote.supplierPartyId),
        statusId: quote.order.statusId,
        statusText: quoteStateText[quote.order.statusId] || statusText(quote.order.statusId),
        recipientsText: recipientsOf(quote).join(", ")
    }))
    const awardedRows = awardedQuotes.map(quote => ({
        orderId: quote.orderId,
        supplierName: partyName(quote.supplierPartyId),
        statusText: statusText(quote.order.statusId)
    }))
    if (isPreview)
        return {
            requestId: rfq.requestId,
            closingRows,
            awardedRows,
            recipientRows: closing.flatMap(quote => {
                const addresses = recipientsOf(quote)
                return addresses.length
                    ? addresses.map(recipient => ({
                          orderId: quote.orderId,
                          supplierName: partyName(quote.supplierPartyId),
                          recipient,
                          resultStatus: addressValid(recipient) ? "TO_SEND" : "RECIPIENT_INVALID"
                      }))
                    : [
                          {
                              orderId: quote.orderId,
                              supplierName: partyName(quote.supplierPartyId),
                              recipient: "",
                              resultStatus: "RECIPIENT_REQUIRED"
                          }
                      ]
            }),
            regretMessage,
            warningText: warnings.join("; "),
            sentCount: 0,
            failedCount: 0,
            statusId: rfq.request.statusId
        }
    const operation = lib.operation(p, "QuoteRequestClose", rfq.organizationPartyId, {
        requestId: rfq.requestId,
        sendRegret,
        regretMessage: sendRegret ? regretMessage : null
    })
    if (operation.old) return lib.previous(operation)
    const reason = text(p.reason) || "RFQ " + rfq.requestId + " closed"
    for (const quote of closing) {
        // Cancel Quote (OrderProposed) or Cancel Quote Request (OrderRequested, never answered): Not awarded
        call("mantle.order.OrderServices.update#OrderStatus", {orderId: quote.orderId, statusId: "OrderCancelled"})
        call("create#mantle.order.OrderNote", {
            orderId: quote.orderId,
            noteDate: ec.user.nowTimestamp,
            noteText: "Not awarded: " + reason,
            internalNote: "Y",
            userId: ec.user.userId
        })
        revokeCapabilities(quote.orderId)
    }
    // the RFQ completed; a draft never sent with nothing awarded is cancelled, one with an award goes by Submitted (the flow)
    const closedStatusId = !awardedQuotes.length && rfq.request.statusId === "ReqDraft" ? "ReqCancelled" : "ReqCompleted"
    if (closedStatusId === "ReqCompleted" && rfq.request.statusId === "ReqDraft")
        call("update#" + REQUEST, {requestId: rfq.requestId, statusId: "ReqSubmitted"})
    call("update#" + REQUEST, {requestId: rfq.requestId, statusId: closedStatusId})
    // the regret notice, per recipient, each in its own transaction; a failure named while the others go
    const recipientRows = []
    if (sendRegret) {
        const fromAddress = documentsScript().recipientsOf(rfq.organizationPartyId)[0] || null
        const subject = "Request for quotation " + rfq.requestId + " from " + organizationName + ": not awarded"
        for (const quote of closing) {
            const supplierName = partyName(quote.supplierPartyId)
            const body = ec.resource.template("component://mr-mantle/template/order/QuoteRegretEmail.html.fancy", {
                message: regretMessage,
                requestId: rfq.requestId,
                requestName: rfq.request.requestName || "",
                reference: quote.part.otherPartyOrderId || ""
            })
            const addresses = recipientsOf(quote)
            if (!addresses.length) {
                recipientRows.push({
                    orderId: quote.orderId,
                    supplierName,
                    recipient: "",
                    resultStatus: "FAILED",
                    errorCode: "RECIPIENT_REQUIRED",
                    errorMessage: supplierName + " has no order or primary email address"
                })
                continue
            }
            for (const recipient of addresses) {
                if (!addressValid(recipient)) {
                    recipientRows.push({
                        orderId: quote.orderId,
                        supplierName,
                        recipient,
                        resultStatus: "FAILED",
                        errorCode: "RECIPIENT_INVALID",
                        errorMessage: recipient + " is not a valid address"
                    })
                    continue
                }
                const status = mailRegret(
                    rfq,
                    quote,
                    recipient,
                    fromAddress,
                    organizationName,
                    body,
                    subject,
                    text(p.emailTemplateId)
                )
                recipientRows.push({
                    orderId: quote.orderId,
                    supplierName,
                    recipient,
                    resultStatus: status === "failed" ? "FAILED" : status === "queued" ? "QUEUED" : "SENT",
                    errorCode: status === "failed" ? "DELIVERY_FAILED" : null,
                    errorMessage: status === "failed" ? recipient + " was not delivered" : ""
                })
            }
        }
        for (const row of recipientRows.filter(row => row.resultStatus === "FAILED"))
            ec.logger.warn("Regret notice of RFQ " + rfq.requestId + " to " + row.supplierName + ": " + row.errorMessage)
    }
    const result = {
        requestId: rfq.requestId,
        closingRows: closingRows.map(row => Object.assign({}, row, {statusId: "OrderCancelled", statusText: "Not awarded"})),
        awardedRows,
        recipientRows,
        regretMessage: sendRegret ? regretMessage : "",
        warningText: warnings.join("; "),
        sentCount: recipientRows.filter(row => row.resultStatus !== "FAILED").length,
        failedCount: recipientRows.filter(row => row.resultStatus === "FAILED").length,
        statusId: closedStatusId
    }
    lib.complete(operation, REQUEST, rfq.requestId, result)
    return Object.assign(result, {alreadyApplied: false})
}

// ===== the freight estimate =====
// store#SupplierQuoteFreight: a requested or proposed quote's freight estimate, its one freight line (ItemShipping, no
// product), set, changed with its reason (audit-logged) or taken off with an empty amount. The comparison's landed cost
// adds it; without it the landed cost is Unknown.
function storeFreight(p) {
    requirePermission("PURCHASE_ORDER_EDIT")
    const po = ordersScript().purchaseOrder(p.orderId, true)
    if (!quoteStatuses.includes(po.order.statusId))
        denied("QUOTE_CLOSED", "Order " + po.orderId + " is not a requested or proposed quote")
    const line = rows(ORDER_ITEM, {orderId: po.orderId}).find(row => row.itemTypeEnumId === "ItemShipping" && !row.productId)
    const amount = blank(p.amount) ? null : decimal(p.amount, "freight amount")
    const reason = text(p.changeReason)
    if (amount == null || amount.isZero()) {
        if (line) call("mantle.order.OrderServices.delete#OrderItem", {orderId: po.orderId, orderItemSeqId: line.orderItemSeqId})
        return {orderId: po.orderId, orderItemSeqId: null}
    }
    if (line) {
        call(
            "mantle.order.OrderServices.update#OrderItem",
            Object.assign(
                {orderId: po.orderId, orderItemSeqId: line.orderItemSeqId, unitAmount: amount, quantity: 1, isModifiedPrice: "Y"},
                reason ? {unitAmount_changeReason: reason} : {}
            )
        )
        return {orderId: po.orderId, orderItemSeqId: line.orderItemSeqId}
    }
    const created = call("mantle.order.OrderServices.create#OrderItem", {
        orderId: po.orderId,
        orderPartSeqId: po.orderPartSeqId,
        itemTypeEnumId: "ItemShipping",
        itemDescription: "Freight estimate",
        quantity: 1,
        unitAmount: amount,
        isModifiedPrice: "Y"
    })
    return {orderId: po.orderId, orderItemSeqId: created.orderItemSeqId}
}

const operations = {compare, preview, commit, commitGroup, recordDecision, decide, close, storeFreight}
;({
    basisOf,
    priceAt,
    awardedStatus,
    execute: (op, parameters) => {
        if (!operations[op]) throw new Error("Unknown award operation " + op)
        return operations[op](parameters || {})
    }
})
