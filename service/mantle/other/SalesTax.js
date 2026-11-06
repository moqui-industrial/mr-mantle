// Local sales tax (AC-08): the local gateway's calculation over TaxAuthorityRate (calculate#SalesTaxLocal), an invoice's
// tax lines through the store's or the organization's gateway (calculate#InvoiceSalesTax), and the simulation that
// explains a calculation (simulate#SalesTax). An authority taxes a sale when the organization has nexus there
// (TaxAuthorityParty.isNexus) and its geo is one of the destination's; it must then have a sales tax rate in effect.
// A failure is a refusal with a reason code; an exemption or no nexus is an explicit zero, never a fallback.
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const policy = ec.resource.script("component://mr-mantle/service/mantle/ledger/AccountingPolicy.js")
const {find, one, rows, call, denied, active, ms} = lib
const RATE = "mantle.other.tax.TaxAuthorityRate"
const AUTHORITY_PARTY = "mantle.other.tax.TaxAuthorityParty"
const ITEM = "mantle.account.invoice.InvoiceItem"
const taxTypes = ["ItemSalesTax", "ItemVatTax", "ItemVatTaxTotal"]
const addressPurposes = ["PostalShippingDest", "PostalBilling", "PostalPrimary"]

function productItemTypes() {
    return rows("moqui.basic.EnumGroupMember", {enumGroupEnumId: "EngItemsProduct"}).map(row => row.enumId)
}
// Whether an item is a sale the rates may tax: a product line whose product and line are not marked non-taxable, a
// shipping line (taxed when its rate says so), or any other line marked taxable. Tax and discount lines are not.
function taxableKind(item, productTypes) {
    if (taxTypes.includes(item.itemTypeEnumId) || item.itemTypeEnumId === "ItemDiscount") return null
    if (item.taxableFlag === "N") return null
    if (item.itemTypeEnumId === "ItemShipping") return "shipping"
    if (item.taxableFlag === "Y") return "line"
    if (!productTypes.includes(item.itemTypeEnumId)) return null
    const product = item.productId ? one("mantle.product.Product", {productId: item.productId}) : null
    return product?.taxable === "N" ? null : "line"
}
// The geos of a destination: the given ones, else the postal address's country, state, county, city and postal code; a
// sale with no destination address (an order part picked up) is taxed where it leaves, its origin address.
function addressGeos(contactMechId) {
    const address = contactMechId ? one("mantle.party.contact.PostalAddress", {contactMechId}) : null
    if (!address) return []
    return ["countryGeoId", "stateProvinceGeoId", "countyGeoId", "cityGeoId", "postalCodeGeoId"]
        .map(field => address[field])
        .filter(Boolean)
}
function destinationGeos(p) {
    if (p.destinationGeoIds?.length) return Array.from(p.destinationGeoIds).filter(Boolean)
    const geos = addressGeos(p.destinationAddressContactMechId)
    return geos.length ? geos : addressGeos(p.originAddressContactMechId)
}
// The authorities where the organization (or one it rolls up to) has nexus on the date.
function nexusAuthorityIds(organizations, date) {
    if (!organizations.length) return []
    const rows = Array.from(find(AUTHORITY_PARTY).condition("partyId", "in", organizations).condition("isNexus", "Y").list())
    return [...new Set(rows.filter(row => active(row, date)).map(row => row.taxAuthorityId))]
}
function categoriesOf(productId, date) {
    if (!productId) return []
    return rows("mantle.product.category.ProductCategoryMember", {productId})
        .filter(row => active(row, date))
        .map(row => row.productCategoryId)
}
// The rate of an authority for an item: the most specific in effect (category, then store, then organization). Two
// equally specific rows are ambiguous; none in effect is refused (rateFor is only asked of an authority with nexus).
function rateFor(authority, effective, item, p, date, categories) {
    if (!effective.length)
        denied(
            "TAX_RATE_MISSING",
            "No sales tax rate of " +
                (authority.description || authority.taxAuthorityId) +
                " is in effect on " +
                lib.dateText(date)
        )
    const matching = effective.filter(
        row =>
            (!row.productStoreId || row.productStoreId === p.productStoreId) &&
            (!row.productCategoryId || categories.includes(row.productCategoryId))
    )
    if (!matching.length) return null
    const score = row => (row.productCategoryId ? 4 : 0) + (row.productStoreId ? 2 : 0) + (row.organizationPartyId ? 1 : 0)
    const best = Math.max(...matching.map(score))
    const top = matching.filter(row => score(row) === best)
    if (top.length > 1)
        denied(
            "TAX_RATE_AMBIGUOUS",
            "More than one rate of the same scope applies; end one of them (" + top[0].taxAuthorityId + ")"
        )
    return top[0]
}
// An item's base: its total less its own discounts (discountTotal is negative, as calculate#OrderSalesTax gives it).
function base(item) {
    const total =
        item.itemTotal != null
            ? toDecimal(item.itemTotal)
            : toDecimal(item.quantity ?? 1).multiply(toDecimal(item.unitAmount ?? 0))
    return total.add(toDecimal(item.discountTotal ?? 0))
}
// The discounts of the whole sale (ItemDiscount items with no parent item) spread over the taxable lines, shipping aside,
// in proportion to their bases; the last line takes what rounding leaves. Each item gets its taxable base.
function spreadDiscounts(items, discounts, currency) {
    const round = value => (currency ? ec.l10n.roundCurrency(value, currency) : value.setScale(2, "HALF_UP"))
    for (const item of items) item.taxable = base(item)
    const lines = items.filter(item => item.kind === "line" && item.taxable.compare(0) > 0)
    const total = lines.reduce((sum, item) => sum.add(item.taxable), toDecimal(0))
    const discount = discounts.reduce((sum, item) => sum.add(base(item)), toDecimal(0))
    if (discount.isZero() || total.isZero()) return
    let left = discount.compare(total.multiply(toDecimal(-1))) < 0 ? total.multiply(toDecimal(-1)) : discount
    lines.forEach((item, index) => {
        const share = index === lines.length - 1 ? left : round(discount.multiply(item.taxable).divide(total))
        item.taxable = item.taxable.add(share)
        left = left.subtract(share)
    })
}

// calculate#SalesTaxLocal: a result for each taxable item and each authority with nexus whose geo is the destination's,
// with the rate version, base, exact and rounded tax, rounding, and an exemption or reason when it is zero. An
// organization with no nexus gets no results; a taxed sale without a destination, or an authority with nexus there and
// no rate in effect, is refused.
function local(p) {
    const date = p.taxDate || ec.user.nowTimestamp
    const organizations = p.organizationPartyId ? policy.organizationChain(p.organizationPartyId, date) : []
    const nexus = nexusAuthorityIds(organizations, date)
    if (!nexus.length) return {taxResults: []}
    const productTypes = productItemTypes()
    const all = Array.from(p.items || []).map(item => Object.assign({}, item, {kind: taxableKind(item, productTypes)}))
    const items = all.filter(item => item.kind)
    if (!items.length) return {taxResults: []}
    const geos = destinationGeos(p)
    if (!geos.length) denied("TAX_ADDRESS_MISSING", "The customer needs a postal address to calculate its sales tax")
    const authorities = Array.from(
        find("mantle.other.tax.TaxAuthority")
            .condition("taxAuthorityId", "in", nexus)
            .condition("taxAuthGeoId", "in", geos)
            .list()
    )
    if (!authorities.length) return {taxResults: []}
    const currency = p.currencyUomId
    const round = value => (currency ? ec.l10n.roundCurrency(value, currency) : value.setScale(2, "HALF_UP"))
    spreadDiscounts(
        items,
        all.filter(item => item.itemTypeEnumId === "ItemDiscount" && !item.parentItemId),
        currency
    )
    const purchase = items.reduce((sum, item) => sum.add(item.taxable), toDecimal(0))
    const rates = Array.from(
        find(RATE)
            .condition(
                "taxAuthorityId",
                "in",
                authorities.map(row => row.taxAuthorityId)
            )
            .condition("rateTypeEnumId", "in", ["TarSalesTax", "TarVatTax"])
            .list()
    ).filter(row => (!row.organizationPartyId || organizations.includes(row.organizationPartyId)) && active(row, date))
    const results = []
    for (const authority of authorities) {
        const exemption = p.customerPartyId
            ? rows(AUTHORITY_PARTY, {partyId: p.customerPartyId, taxAuthorityId: authority.taxAuthorityId, isExempt: "Y"}).find(
                  row => active(row, date)
              )
            : null
        const effective = rates.filter(row => row.taxAuthorityId === authority.taxAuthorityId)
        const isVatAuthority = authority.taxAuthorityRateTypeEnumId === "TartVatTax"
        const vatBuckets = new Map()
        for (const item of items) {
            const rate = rateFor(authority, effective, item, p, date, categoriesOf(item.productId, date))
            if (!rate) continue
            const reason =
                item.kind === "shipping" && rate.taxShipping !== "Y"
                    ? "Shipping is not taxed"
                    : rate.minItemPrice != null && toDecimal(item.unitAmount ?? 0).compare(rate.minItemPrice) < 0
                      ? "Below the minimum item price"
                      : rate.minPurchase != null && purchase.compare(rate.minPurchase) < 0
                        ? "Below the minimum purchase"
                        : exemption
                          ? "Exempt" + (exemption.partyTaxId ? " (" + exemption.partyTaxId + ")" : "")
                          : null
            const isVat = isVatAuthority || rate.rateTypeEnumId === "TarVatTax"
            if (isVat && !reason) {
                const key = rate.taxAuthorityRateId || (authority.taxAuthorityId + "_" + (rate.taxPercentage ?? 0))
                if (!vatBuckets.has(key)) vatBuckets.set(key, {rate, taxableAmount: toDecimal(0)})
                const bucket = vatBuckets.get(key)
                bucket.taxableAmount = bucket.taxableAmount.add(item.taxable)
            } else {
                const taxable = item.taxable
                const percentage = toDecimal(rate.taxPercentage ?? 0)
                const exact = reason ? toDecimal(0) : taxable.multiply(percentage).divide(toDecimal(100))
                const rounded = round(exact)
                results.push({
                    itemId: item.itemId,
                    taxQuantity: toDecimal(1),
                    taxAmount: rounded,
                    taxRate: percentage.divide(toDecimal(100)),
                    taxAuthorityId: authority.taxAuthorityId,
                    taxName: authority.description || authority.taxAuthorityId,
                    taxAuthorityRateId: rate.taxAuthorityRateId,
                    taxableAmount: taxable,
                    taxPercentage: percentage,
                    exactTaxAmount: exact,
                    taxRoundingAmount: rounded.subtract(exact),
                    exemptReason: reason
                })
            }
        }
        for (const [key, bucket] of vatBuckets.entries()) {
            const percentage = toDecimal(bucket.rate.taxPercentage ?? 0)
            const exact = bucket.taxableAmount.multiply(percentage).divide(toDecimal(100))
            const rounded = round(exact)
            results.push({
                isVat: true,
                itemId: "VAT_" + key,
                itemTypeEnumId: "ItemVatTaxTotal",
                taxQuantity: toDecimal(1),
                taxAmount: rounded,
                taxRate: percentage.divide(toDecimal(100)),
                taxAuthorityId: authority.taxAuthorityId,
                taxName: (authority.description || authority.taxAuthorityId) + " " + percentage + "%",
                taxAuthorityRateId: bucket.rate.taxAuthorityRateId,
                taxableAmount: bucket.taxableAmount,
                taxPercentage: percentage,
                exactTaxAmount: exact,
                taxRoundingAmount: rounded.subtract(exact),
                exemptReason: null
            })
        }
    }
    return {taxResults: results}
}

// The gateway of a sale: its store's when the store has one, else the organization's (PartyAcctgPreference).
function gateway(organizationPartyId, productStoreId) {
    const store = productStoreId ? one("mantle.product.store.ProductStore", {productStoreId}) : null
    let taxGatewayConfigId = store?.taxGatewayConfigId
    if (!taxGatewayConfigId && organizationPartyId) taxGatewayConfigId = policy.preference(organizationPartyId).taxGatewayConfigId
    return taxGatewayConfigId ? one("mantle.other.tax.TaxGatewayConfig", {taxGatewayConfigId}) : null
}
// The customer's postal address for tax: shipping, else billing, else primary.
function customerAddress(partyId, date) {
    if (!partyId) return null
    const purposes = rows("mantle.party.contact.PartyContactMech", {partyId}).filter(row => active(row, date))
    for (const purpose of addressPurposes) {
        const row = purposes.find(candidate => candidate.contactMechPurposeId === purpose)
        if (row) return row.contactMechId
    }
    return null
}

// The invoice's calculated tax lines, whichever gateway made them (InvoiceItem.taxCalculated).
function calculatedLines(invoiceId) {
    return rows(ITEM, {invoiceId, taxCalculated: "Y"})
}
const draftStatuses = ["InvoiceInProcess", "InvoiceIncoming", "InvoiceReceived"]
function lineKey(row) {
    return [
        row.parentItemSeqId,
        row.taxAuthorityId,
        row.taxAuthorityRateId,
        String(toDecimal(row.amount ?? 0).toNumber()),
        String(toDecimal(row.taxableAmount ?? 0).toNumber())
    ].join("|")
}
function clearLines(lines) {
    for (const line of lines) call("delete#" + ITEM, {invoiceId: line.invoiceId, invoiceItemSeqId: line.invoiceItemSeqId})
}

// calculate#InvoiceSalesTax: replace a draft sales invoice's calculated tax lines with the gateway's results, leaving
// them as they are when the results are the same. Not for other invoice types, invoices billed from orders (their tax
// came with the order) or an organization with no gateway, which each answer a reason code. With clear, only removes the
// calculated lines (an invoice reopened to draft).
function invoice(p) {
    const record = one("mantle.account.invoice.Invoice", {invoiceId: p.invoiceId})
    if (!record) denied("INVOICE_UNAVAILABLE", "Invoice " + p.invoiceId + " is not available")
    const existing = calculatedLines(record.invoiceId)
    if (p.clear) {
        if (!draftStatuses.includes(record.statusId)) denied("INVOICE_NOT_DRAFT", "Tax lines are removed from a draft invoice")
        clearLines(existing)
        return {reasonCode: "CLEARED", taxTotal: toDecimal(0), lineCount: 0, changed: existing.length > 0}
    }
    const skip = reasonCode => ({reasonCode, taxTotal: toDecimal(0), lineCount: 0, changed: false})
    if (record.invoiceTypeEnumId !== "InvoiceSales") return skip("NOT_APPLICABLE")
    const lines = rows(ITEM, {invoiceId: record.invoiceId})
    const billed = find("mantle.order.OrderItemBilling", {invoiceId: record.invoiceId}).count()
    if (billed) return skip("ORDER_TAX")
    const config = gateway(record.fromPartyId, record.productStoreId)
    if (!config) return skip("NO_GATEWAY")
    if (!draftStatuses.includes(record.statusId)) denied("INVOICE_NOT_DRAFT", "Sales tax is calculated on a draft invoice")
    const date = record.invoiceDate || ec.user.nowTimestamp
    const currency = record.currencyUomId
    // tax lines are not items; a line's own discounts are in its discountTotal, the sale's discounts are items with no parent
    const items = lines
        .filter(
            line => !taxTypes.includes(line.itemTypeEnumId) && !(line.itemTypeEnumId === "ItemDiscount" && line.parentItemSeqId)
        )
        .map(line => {
            const itemTotal = ec.l10n.roundCurrency(toDecimal(line.quantity ?? 1).multiply(toDecimal(line.amount ?? 0)), currency)
            const discountTotal = lines
                .filter(child => child.parentItemSeqId === line.invoiceItemSeqId && child.itemTypeEnumId === "ItemDiscount")
                .reduce(
                    (sum, child) => sum.add(toDecimal(child.quantity ?? 1).multiply(toDecimal(child.amount ?? 0))),
                    toDecimal(0)
                )
            return {
                itemId: line.invoiceItemSeqId,
                itemTypeEnumId: line.itemTypeEnumId,
                quantity: line.quantity,
                unitAmount: line.amount,
                itemTotal,
                discountTotal,
                productId: line.productId,
                taxableFlag: line.taxableFlag,
                parentItemId: line.parentItemSeqId || null
            }
        })
    const out = call(config.calculateServiceName, {
        referenceId: record.invoiceId,
        saveResults: true,
        taxGatewayConfigId: config.taxGatewayConfigId,
        customerPartyId: record.toPartyId,
        organizationPartyId: record.fromPartyId,
        productStoreId: record.productStoreId,
        destinationAddressContactMechId: customerAddress(record.toPartyId, date),
        taxDate: date,
        currencyUomId: currency,
        items
    })
    const wanted = Array.from(out.taxResults || [])
        .filter(result => result.taxAmount != null && !toDecimal(result.taxAmount).isZero())
        .map(result => ({
            parentItemSeqId: result.isVat ? null : result.itemId,
            itemTypeEnumId: result.isVat ? (result.itemTypeEnumId || "ItemVatTaxTotal") : "ItemSalesTax",
            quantity: toDecimal(result.taxQuantity ?? 1),
            amount: ec.l10n.roundCurrency(toDecimal(result.taxAmount), currency),
            taxAuthorityId: result.taxAuthorityId,
            taxAuthorityRateId: result.taxAuthorityRateId || null,
            taxableAmount: result.taxableAmount ?? null,
            taxPercentage:
                result.taxPercentage ?? (result.taxRate != null ? toDecimal(result.taxRate).multiply(toDecimal(100)) : null),
            taxRoundingAmount: result.taxRoundingAmount ?? null,
            taxCalculated: "Y",
            description: (result.taxName || (result.isVat ? "VAT" : "Sales")) + " tax"
        }))
    const taxTotal = wanted.reduce((sum, line) => sum.add(line.quantity.multiply(line.amount)), toDecimal(0))
    const same =
        wanted.length === existing.length &&
        JSON.stringify(wanted.map(lineKey).sort()) === JSON.stringify(existing.map(lineKey).sort())
    if (same) return {reasonCode: "OK", taxTotal, lineCount: wanted.length, changed: false}
    clearLines(existing)
    for (const line of wanted)
        call("mantle.account.InvoiceServices.create#InvoiceItem", Object.assign({invoiceId: record.invoiceId}, line))
    return {reasonCode: "OK", taxTotal, lineCount: wanted.length, changed: true}
}

// simulate#SalesTax: what the organization's gateway would charge for a sample sale, item by item, with each rate,
// base, rounding and exemption, or the reason it cannot be calculated. Writes nothing.
function simulate(p) {
    const scope = policy.organization(p, "read")
    return sample(scope.organizationPartyId, p)
}
// The sample sale's tax for an organization (and its store) the caller has checked: simulate#SalesTax after its Accounting
// read check, and Commerce's store tax preview (StoreCheckout.js) after its store check (impl-commerce P6).
function sample(organizationPartyId, p) {
    const date = p.taxDate || ec.user.nowTimestamp
    const config = gateway(organizationPartyId, p.productStoreId)
    const currency = p.currencyUomId || policy.preference(organizationPartyId).baseCurrencyUomId
    const answer = {gatewayName: config?.description || "", currencyUomId: currency, rows: [], reasonCode: "OK", message: ""}
    if (!config) return Object.assign(answer, {reasonCode: "NO_GATEWAY", message: "The organization has no sales tax gateway"})
    const items = []
    if (p.amount != null && p.amount !== "")
        items.push({
            itemId: "1",
            itemTypeEnumId: p.itemTypeEnumId || "ItemProduct",
            productId: p.productId || null,
            quantity: toDecimal(p.quantity || 1),
            unitAmount: toDecimal(p.amount),
            itemTotal: toDecimal(p.quantity || 1).multiply(toDecimal(p.amount))
        })
    if (p.shippingAmount != null && p.shippingAmount !== "")
        items.push({itemId: "2", itemTypeEnumId: "ItemShipping", quantity: toDecimal(1), unitAmount: toDecimal(p.shippingAmount)})
    const destination = p.destinationGeoId ? {destinationGeoIds: [p.destinationGeoId]} : {}
    let out
    try {
        out = lib.probe(config.calculateServiceName, {
            taxGatewayConfigId: config.taxGatewayConfigId,
            organizationPartyId,
            customerPartyId: p.customerPartyId || null,
            productStoreId: p.productStoreId || null,
            destinationAddressContactMechId: p.destinationGeoId ? null : customerAddress(p.customerPartyId, date),
            ...destination,
            taxDate: date,
            currencyUomId: currency,
            items
        })
    } catch (error) {
        return Object.assign(answer, {
            reasonCode: lib.reasonCode(error) || "TAX_CALCULATION_FAILED",
            message: String(error.message).replace(/^[A-Z_]+: /, "")
        })
    }
    const results = Array.from(out.taxResults || [])
    const authorityIds = [...new Set(results.map(result => result.taxAuthorityId))]
    const names = Object.fromEntries(
        Array.from(
            authorityIds.length
                ? find("mantle.other.tax.TaxAuthority").condition("taxAuthorityId", "in", authorityIds).list()
                : []
        ).map(row => [row.taxAuthorityId, row.description || row.taxAuthorityId])
    )
    answer.rows = results.map(result => ({
        itemText: result.itemId === "2" ? "Shipping" : "Sale",
        authorityName: names[result.taxAuthorityId] || result.taxAuthorityId,
        taxAuthorityRateId: result.taxAuthorityRateId,
        taxPercentage: result.taxPercentage,
        taxableAmount: result.taxableAmount,
        exactTaxAmount: result.exactTaxAmount,
        taxAmount: result.taxAmount,
        taxRoundingAmount: result.taxRoundingAmount,
        exemptReason: result.exemptReason || ""
    }))
    if (!answer.rows.length) answer.message = "No tax applies: the organization has no nexus or rate where this sale goes"
    return answer
}

const operations = {local, invoice, simulate}
;({
    sample,
    execute: (op, parameters) => {
        if (!operations[op]) throw new Error("Unknown sales tax operation " + op)
        return operations[op](parameters)
    }
})
