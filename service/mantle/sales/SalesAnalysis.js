// Sales analysis (design-accounting §13 SalesAnalysis) of one organization over a span of days: what it sold, by product,
// customer or customer class, as ordered (its sales orders placed), issued (shipped from those orders), invoiced (its
// issued sales invoices, by book day) and returned (returns to it), each with its quantity and value in the document's
// currency. Only sales lines count (the item types under ItemSales: products, services, time and the like), not tax,
// shipping, discounts or other adjustments; a return counts once requested (not a draft or a cancelled one); credit memos
// that no return made are not counted. Every read is the organization's own, so top products and customer classes never
// mix another organization's sales (F6); a user without report read in the organization is refused. Without a period or
// days it reads the organization's fiscal month holding today. A read capped at its limit is named (complete false),
// never cut silently.
//
// Sales' report scope (impl-sales P19, design-sales §8 SalesAnalysis; Z10: Sales owns the report, Accounting mounts it): a report
// reader (ACCOUNTING_VIEW) of the organization is answered as before, with the cost of what was shipped and its margin (Accounting's
// finance columns); a holder of SALES_REPORT_VIEW without it is answered for an organization of their sales scope (SalesAccess.js
// reportOrganizations), the cost and margin only when they read both prices and costs (PRICE_VIEW and PRODUCT_COST_VIEW), else
// withheld (null, never zero; costShown false). A shipped line's cost is its issuances' quantity times their asset's acquire cost,
// and only where that cost is in the sale's currency: a cost in another currency or none makes the row's cost unknown (named in
// costIncomplete), never converted or counted as zero.
const policy = ec.resource.script("component://mr-mantle/service/mantle/ledger/AccountingPolicy.js")
const reports = ec.resource.script("component://mr-mantle/service/mantle/ledger/FinanceReports.js")
const {find, denied} = policy
const access = ec.resource.script("component://mr-mantle/service/mantle/product/ProductAccess.js")
const LIMIT = 2000
const PLACED = ["OrderPlaced", "OrderProcessing", "OrderApproved", "OrderSent", "OrderCompleted", "OrderHold"]
const ISSUED = ["InvoiceFinalized", "InvoiceSent", "InvoiceAcked", "InvoicePmtRecvd", "InvoiceWriteOff"]
const GROUPINGS = ["product", "customer", "customerClass"]
const NOT_RETURNED = ["ReturnCreated", "ReturnCancelled"]
// The sales line types: ItemSales and the types under it.
function salesTypes() {
    return new Set(["ItemSales", ...Array.from(find("moqui.basic.Enumeration", {parentEnumId: "ItemSales"}).list()).map(row => row.enumId)])
}

const zero = () => toDecimal(0)
const dec = value => toDecimal(value ?? 0)
function inChunks(ids, read) {
    const out = []
    for (let index = 0; index < ids.length; index += 500) out.push(...read(ids.slice(index, index + 500)))
    return out
}
// A capped read: at most LIMIT rows, and the kind named in incomplete when there were more.
function capped(query, kind, incomplete) {
    const rows = Array.from(query.limit(LIMIT + 1).list())
    if (rows.length <= LIMIT) return rows
    incomplete.push(kind)
    return rows.slice(0, LIMIT)
}
// The book day condition of an invoice: its accounting day when it has one, else its invoice date.
function invoiceDays(p) {
    const cf = ec.entity.conditionFactory
    const dated = [cf.makeCondition("accountingDate", "is-not-null", null)]
    const legacy = [cf.makeCondition("accountingDate", "is-null", null)]
    if (p.fromDate) {
        dated.push(cf.makeCondition("accountingDate", "greater-equals", p.fromAccountingDate))
        legacy.push(cf.makeCondition("invoiceDate", "greater-equals", p.fromDate))
    }
    if (p.thruDate) {
        dated.push(cf.makeCondition("accountingDate", "less", p.thruAccountingDate))
        legacy.push(cf.makeCondition("invoiceDate", "less", p.thruDate))
    }
    return cf.makeCondition([cf.makeCondition(dated, "and"), cf.makeCondition(legacy, "and")], "or")
}
function stampRange(query, field, p) {
    if (p.fromDate) query = query.condition(field, "greater-equals", p.fromDate)
    if (p.thruDate) query = query.condition(field, "less", p.thruDate)
    return query
}
// The customer class (PcltCustomer) each customer holds now.
function customerClasses(customerIds) {
    const ids = [...new Set(customerIds.filter(Boolean))]
    const out = {}
    if (!ids.length) return out
    const classes = new Map(
        Array.from(find("mantle.party.PartyClassification", {classificationTypeEnumId: "PcltCustomer"}).list()).map(row => [
            row.partyClassificationId,
            row.description || row.partyClassificationId
        ])
    )
    if (!classes.size) return out
    for (const row of inChunks(ids, chunk =>
        Array.from(
            find("mantle.party.PartyClassificationAppl")
                .condition("partyId", "in", chunk)
                .condition("partyClassificationId", "in", [...classes.keys()])
                .orderBy("partyId,-fromDate")
                .list()
        )
    )) {
        if (out[row.partyId] || !policy.active(row)) continue
        out[row.partyId] = {id: row.partyClassificationId, name: classes.get(row.partyClassificationId)}
    }
    return out
}

// The reader of the analysis (impl-sales P19): {organizationPartyId, finance, costShown}. Accounting's report reader of the
// organization first; else a Sales report reader of an organization of their scope; else Accounting's refusal, as before.
function analysisReader(p) {
    const named = p.organizationPartyId ? String(p.organizationPartyId) : null
    const caps = policy.capabilities()
    const salesReader = access.has("SALES_REPORT_VIEW")
    if (caps.reportRead && caps.read) {
        const a = policy.access("reportRead")
        if (!salesReader || !named || a.allowedOrganizationPartyIds.includes(named))
            return {organizationPartyId: policy.organization(p, "reportRead").organizationPartyId, finance: true, costShown: true}
    }
    if (!salesReader) return {organizationPartyId: policy.organization(p, "reportRead").organizationPartyId, finance: true, costShown: true}
    const salesAccess = ec.resource.script("component://mr-mantle/service/mantle/sales/SalesAccess.js")
    const userScope = salesAccess.scope()
    const org = named || salesAccess.defaultOrganization(userScope)
    if (!org) denied("ORGANIZATION_REQUIRED", "Choose an organization")
    salesAccess.reportOrganizations([org])
    return {organizationPartyId: org, finance: false, costShown: access.has("PRICE_VIEW") && access.has("PRODUCT_COST_VIEW")}
}
// A Sales report reader's days (impl-sales P19): a fiscal or sales period of the organization itself (its own records, read
// without Accounting's period check), else the days given, else the organization's fiscal month holding today, else the calendar
// month; the same bounds as Accounting's options (the period's days from midnight in the user's zone).
const salesPeriodTypes = ["FiscalYear", "FiscalQuarter", "FiscalMonth", "SalesYear", "SalesQuarter", "SalesMonth"]
function salesOptions(p, org) {
    const out = Object.assign({}, p, {organizationPartyId: org})
    const day = value => ec.l10n.format(value, "yyyy-MM-dd")
    const afterDay = value => policy.lib.calendarDateText(Date.parse(policy.lib.calendarDateText(value)) + 86400000)
    let period = null
    if (p.timePeriodId) {
        period = find("mantle.party.time.TimePeriod", {timePeriodId: String(p.timePeriodId)}).one()
        if (!period || period.partyId !== org || !salesPeriodTypes.includes(period.timePeriodTypeId))
            denied("PERIOD_INVALID", "Choose a period of the organization")
    } else if (!p.fromDate && !p.thruDate) {
        const today = day(ec.user.nowTimestamp)
        period =
            Array.from(find("mantle.party.time.TimePeriod", {partyId: org, timePeriodTypeId: "FiscalMonth"}).list()).find(
                row => policy.lib.calendarDateText(row.fromDate) <= today && policy.lib.calendarDateText(row.thruDate) >= today
            ) || null
        if (!period) {
            const range = ec.user.getPeriodRange("month", 0, ec.user.nowTimestamp)
            out.fromDate = new Date(Number(range[0]))
            out.thruDate = new Date(Number(range[1]))
        }
    }
    if (period) {
        const fromDay = policy.lib.calendarDateText(period.fromDate)
        const thruDay = afterDay(period.thruDate)
        out.fromDate = ec.l10n.parseTimestamp(fromDay, "yyyy-MM-dd")
        out.thruDate = ec.l10n.parseTimestamp(thruDay, "yyyy-MM-dd")
    }
    out.fromAccountingDate = out.fromDate ? day(out.fromDate) : null
    out.thruAccountingDate = out.thruDate ? day(out.thruDate) : null
    if (out.fromDate && out.thruDate && policy.lib.ms(out.fromDate) >= policy.lib.ms(out.thruDate))
        throw new Error("Choose an increasing report date range")
    return out
}

// A row's cost and margin (impl-sales P19): for the cost reader, the cost of what was shipped and the margin over the shipped
// value, in the sale's currency, unknown (null) when a cost is missing or in another currency; withheld (null) for anyone else.
function costOf(total, costShown) {
    if (!costShown || total.costUnknown) return {issuedCost: null, marginValue: null, marginPercent: null}
    const cost = ec.l10n.roundCurrency(total.issuedCost, total.currencyUomId)
    const margin = total.issuedValue.subtract(total.issuedCost)
    return {
        issuedCost: cost,
        marginValue: ec.l10n.roundCurrency(margin, total.currencyUomId),
        marginPercent: total.issuedValue.isZero() ? null : margin.divide(total.issuedValue, 6, "HALF_EVEN").multiply(toDecimal(100))
    }
}

function analysis(p) {
    const reader = analysisReader(p)
    const org = reader.organizationPartyId
    if (reader.finance) {
        if (!p.timePeriodId && !p.fromDate && !p.thruDate) {
            const month = policy.call("mantle.ledger.LedgerServices.get#OrganizationFiscalTimePeriods", {
                organizationPartyId: org,
                filterDate: ec.user.nowTimestamp,
                timePeriodTypeId: "FiscalMonth"
            }).timePeriodList
            p = Object.assign({}, p, {timePeriodId: Array.from(month || [])[0]?.timePeriodId || null})
        }
        p = reports.execute("options", Object.assign({}, p, {organizationPartyId: org}))
    } else p = salesOptions(p, org)
    const sales = salesTypes()
    const groupBy = p.groupBy || "product"
    if (!GROUPINGS.includes(groupBy)) denied("GROUPING_INVALID", "Group sales by product, customer or customer class")
    if (p.currencyUomId) policy.currency(p.currencyUomId)
    const incomplete = []

    // the organization's sales order lines placed in the span
    let orderQuery = stampRange(
        find("mantle.order.OrderHeaderAndPart", {vendorPartyId: org})
            .condition("statusId", "in", PLACED)
            .condition("partStatusId", "in", PLACED)
            // a recurring base or a quote template is never a sale, with or without a date span (impl-sales P16 review)
            .condition(
                ec.entity.conditionFactory.makeCondition(
                    ec.entity.conditionFactory.makeCondition("orderPurposeEnumId", "is-null", null),
                    "or",
                    ec.entity.conditionFactory.makeCondition("orderPurposeEnumId", "not-in", [
                        "OrpRecurringTemplate",
                        "OrpSalesQuoteTemplate"
                    ])
                )
            ),
        "placedDate",
        p
    )
    if (p.currencyUomId) orderQuery = orderQuery.condition("currencyUomId", p.currencyUomId)
    const parts = capped(
        orderQuery.selectField("orderId").selectField("orderPartSeqId").selectField("customerPartyId").selectField("currencyUomId").orderBy("placedDate,orderId,orderPartSeqId"),
        "orders",
        incomplete
    )
    const partOf = new Map(parts.map(row => [row.orderId + ":" + row.orderPartSeqId, row]))
    const orderIds = [...new Set(parts.map(row => row.orderId))]
    const orderItems = inChunks(orderIds, chunk =>
        Array.from(find("mantle.order.OrderItem").condition("orderId", "in", chunk).orderBy("orderId,orderItemSeqId").list())
    ).filter(row => partOf.has(row.orderId + ":" + row.orderPartSeqId))
    const issued = {}
    // P19: each issuance's cost (its quantity times its asset's acquire cost, in the asset's cost currency), for the cost reader
    const issuedCost = {}
    const issuances = inChunks(orderIds, chunk =>
        Array.from(find("mantle.product.issuance.AssetIssuance").condition("orderId", "in", chunk).list())
    )
    const assets = reader.costShown
        ? new Map(
              inChunks([...new Set(issuances.map(row => row.assetId).filter(Boolean))], chunk =>
                  Array.from(
                      find("mantle.product.asset.Asset")
                          .condition("assetId", "in", chunk)
                          .selectField("assetId")
                          .selectField("acquireCost")
                          .selectField("acquireCostUomId")
                          .list()
                  )
              ).map(row => [row.assetId, row])
          )
        : new Map()
    for (const row of issuances) {
        const key = row.orderId + ":" + row.orderItemSeqId
        issued[key] = dec(issued[key]).add(dec(row.quantity))
        if (!reader.costShown) continue
        const asset = assets.get(row.assetId)
        const costs = (issuedCost[key] = issuedCost[key] || [])
        costs.push({
            amount: asset?.acquireCost == null ? null : dec(row.quantity).multiply(dec(asset.acquireCost)),
            currencyUomId: asset?.acquireCostUomId || null
        })
    }

    // the organization's issued sales invoices of the span, by book day
    let invoiceQuery = find("mantle.account.invoice.Invoice", {fromPartyId: org, invoiceTypeEnumId: "InvoiceSales"})
        .condition("statusId", "in", ISSUED)
        .condition(invoiceDays(p))
    if (p.currencyUomId) invoiceQuery = invoiceQuery.condition("currencyUomId", p.currencyUomId)
    const invoices = capped(
        invoiceQuery.selectField("invoiceId").selectField("toPartyId").selectField("currencyUomId").orderBy("invoiceDate,invoiceId"),
        "invoices",
        incomplete
    )
    const invoiceOf = new Map(invoices.map(row => [row.invoiceId, row]))
    const invoiceItems = inChunks(invoices.map(row => row.invoiceId), chunk =>
        Array.from(find("mantle.account.invoice.InvoiceItem").condition("invoiceId", "in", chunk).orderBy("invoiceId,invoiceItemSeqId").list())
    )

    // returns to the organization entered in the span, not cancelled
    let returnQuery = stampRange(
        find("mantle.order.return.ReturnHeader", {vendorPartyId: org}).condition("statusId", "not-in", NOT_RETURNED),
        "entryDate",
        p
    )
    if (p.currencyUomId) returnQuery = returnQuery.condition("currencyUomId", p.currencyUomId)
    const returns = capped(returnQuery.orderBy("entryDate,returnId"), "returns", incomplete)
    const returnOf = new Map(returns.map(row => [row.returnId, row]))
    const returnItems = inChunks(returns.map(row => row.returnId), chunk =>
        Array.from(find("mantle.order.return.ReturnItem").condition("returnId", "in", chunk).orderBy("returnId,returnItemSeqId").list())
    ).filter(row => !NOT_RETURNED.includes(row.statusId) && (!row.itemTypeEnumId || sales.has(row.itemTypeEnumId)))

    const customers = [
        ...parts.map(row => row.customerPartyId),
        ...invoices.map(row => row.toPartyId),
        ...returns.map(row => row.customerPartyId)
    ]
    const classes = groupBy === "customerClass" ? customerClasses(customers) : {}
    const names = groupBy === "customer" ? policy.lib.partyNames(customers) : {}
    const productIds = groupBy === "product" ? [...new Set([...orderItems, ...invoiceItems, ...returnItems].map(row => row.productId).filter(Boolean))] : []
    const products = Object.fromEntries(
        productIds.length
            ? inChunks(productIds, chunk => Array.from(find("mantle.product.Product").condition("productId", "in", chunk).list())).map(row => [
                  row.productId,
                  row
              ])
            : []
    )
    const groupOf = (productId, customerPartyId) => {
        if (groupBy === "product")
            return productId
                ? {key: productId, label: products[productId]?.productName || products[productId]?.pseudoId || productId, productId}
                : {key: "", label: "Lines without a product"}
        if (groupBy === "customer") {
            if (!customerPartyId) return {key: "", label: "No customer"}
            // a customer another user keeps private is counted without its name
            return names[customerPartyId]
                ? {key: customerPartyId, label: names[customerPartyId], customerPartyId}
                : {key: "_PRIVATE_", label: "Private contacts"}
        }
        const found = classes[customerPartyId]
        return found ? {key: found.id, label: found.name, customerClassId: found.id} : {key: "", label: "Unclassified"}
    }
    const rows = new Map()
    const row = (group, currencyUomId) => {
        const key = group.key + ":" + currencyUomId
        if (!rows.has(key))
            rows.set(
                key,
                Object.assign({}, group, {
                    currencyUomId,
                    orderedQuantity: zero(),
                    orderedValue: zero(),
                    issuedQuantity: zero(),
                    invoicedQuantity: zero(),
                    invoicedValue: zero(),
                    returnedQuantity: zero(),
                    returnedValue: zero(),
                    issuedValue: zero(),
                    issuedCost: zero(),
                    costUnknown: false
                })
            )
        return rows.get(key)
    }
    for (const item of orderItems) {
        if (!sales.has(item.itemTypeEnumId)) continue
        const part = partOf.get(item.orderId + ":" + item.orderPartSeqId)
        const total = row(groupOf(item.productId, part.customerPartyId), part.currencyUomId)
        const quantity = item.quantity == null ? toDecimal(1) : dec(item.quantity)
        total.orderedQuantity = total.orderedQuantity.add(quantity)
        total.orderedValue = total.orderedValue.add(quantity.multiply(dec(item.unitAmount)))
        const shipped = dec(issued[item.orderId + ":" + item.orderItemSeqId])
        total.issuedQuantity = total.issuedQuantity.add(shipped)
        total.issuedValue = total.issuedValue.add(shipped.multiply(dec(item.unitAmount)))
        // a cost in another currency than the sale's, or none, is unknown: never converted, never zero
        for (const cost of issuedCost[item.orderId + ":" + item.orderItemSeqId] || []) {
            if (cost.amount == null || (cost.currencyUomId && cost.currencyUomId !== part.currencyUomId)) total.costUnknown = true
            else total.issuedCost = total.issuedCost.add(cost.amount)
        }
    }
    for (const item of invoiceItems) {
        if (!sales.has(item.itemTypeEnumId)) continue
        const invoice = invoiceOf.get(item.invoiceId)
        const total = row(groupOf(item.productId, invoice.toPartyId), invoice.currencyUomId)
        const quantity = item.quantity == null ? toDecimal(1) : dec(item.quantity)
        total.invoicedQuantity = total.invoicedQuantity.add(quantity)
        total.invoicedValue = total.invoicedValue.add(quantity.multiply(dec(item.amount)))
    }
    for (const item of returnItems) {
        const header = returnOf.get(item.returnId)
        const total = row(groupOf(item.productId, header.customerPartyId), header.currencyUomId)
        const quantity = dec(item.returnQuantity)
        total.returnedQuantity = total.returnedQuantity.add(quantity)
        total.returnedValue = total.returnedValue.add(quantity.multiply(dec(item.returnPrice)))
    }
    const analysisRows = [...rows.values()]
        .map(total =>
            Object.assign(total, {
                orderedValue: ec.l10n.roundCurrency(total.orderedValue, total.currencyUomId),
                invoicedValue: ec.l10n.roundCurrency(total.invoicedValue, total.currencyUomId),
                returnedValue: ec.l10n.roundCurrency(total.returnedValue, total.currencyUomId),
                netValue: ec.l10n.roundCurrency(total.invoicedValue.subtract(total.returnedValue), total.currencyUomId),
                issuedValue: ec.l10n.roundCurrency(total.issuedValue, total.currencyUomId)
            }, costOf(total, reader.costShown))
        )
        .sort(
            (a, b) =>
                b.invoicedValue.compare(a.invoicedValue) || b.orderedValue.compare(a.orderedValue) || a.label.localeCompare(b.label)
        )
    const costIncomplete = reader.costShown && analysisRows.some(total => total.costUnknown)
    return {
        analysisRows,
        costShown: reader.costShown,
        costIncomplete: costIncomplete
            ? "Some shipped lines have no cost, or a cost in another currency than the sale's; their cost and margin are shown as unknown."
            : null,
        organizationPartyId: org,
        groupBy,
        fromDate: p.fromDate,
        thruDate: p.thruDate,
        asOf: ec.l10n.format(ec.user.nowTimestamp, "yyyy-MM-dd HH:mm:ss"),
        complete: !incomplete.length,
        incompleteReason: incomplete.length
            ? "More than " + LIMIT + " " + incomplete.join(", ") + " in these days; the first " + LIMIT + " are counted. Choose fewer days."
            : null
    }
}
// The organizations of the search-backed sales summaries (get#SalesOrderSummary and the others): those named, each one
// the user may read, else every one the user works in; refuses a user without report read.
//
// Store-scoped reads (impl-commerce P11, F21; X11): a user without report read (ACCOUNTING_VIEW) who holds COMMERCE_VIEW
// is answered for productStoreIds all in their store scope (StoreAdmin.js: their organizations' stores, a store-limited
// staff member's own; one outside it RECORD_UNAVAILABLE), read as the stores' organizations (an organization named must be
// one of them), with the costs withheld unless PRODUCT_COST_VIEW (costWithheld). A holder of ACCOUNTING_VIEW is answered
// as before, whatever stores they name.
//
// Sales reads (impl-sales P1, F2; the answer to impl-accounting §5's open question): a user without report read who holds
// SALES_REPORT_VIEW, and is not answered as a store-scoped reader, is answered for the organizations of their sales scope
// (SalesAccess.js reportOrganizations: their own, the active one when it is theirs; an organization named must be one of them),
// with the costs withheld unless PRODUCT_COST_VIEW.
function organizations(p) {
    const named = Array.from(p.organizationPartyIds || []).filter(Boolean)
    const storeIds = Array.from(new Set(Array.from(p.productStoreIds || []).filter(Boolean)))
    const reportRead = policy.capabilities().reportRead
    if (storeIds.length && !reportRead && access.has("COMMERCE_VIEW")) return storeOrganizations(named, storeIds)
    if (!reportRead && access.has("SALES_REPORT_VIEW"))
        return ec.resource.script("component://mr-mantle/service/mantle/sales/SalesAccess.js").reportOrganizations(named)
    const scope = policy.scope({}, "reportRead")
    const allowed = scope.organizationPartyIds
    for (const id of named) if (!allowed.includes(id)) denied("ORGANIZATION_DENIED", "Accounting organization is not available")
    return {organizationPartyIds: named.length ? named : allowed.length ? allowed : ["_NA_"], costWithheld: false}
}
function storeOrganizations(named, storeIds) {
    const stores = ec.resource.script("component://mr-mantle/service/mantle/product/StoreAdmin.js")
    const s = stores.scope("view")
    const owners = Array.from(new Set(storeIds.map(productStoreId => stores.storeOf(s, productStoreId).organizationPartyId)))
    for (const id of named) if (!owners.includes(id)) denied("ORGANIZATION_DENIED", "Organization " + id + " is not the stores'")
    return {organizationPartyIds: named.length ? named : owners, costWithheld: !access.has("PRODUCT_COST_VIEW")}
}
const operations = {analysis, organizations}
;({
    execute: (op, p) => {
        if (!operations[op]) throw new Error("Unknown sales report " + op)
        return operations[op](p)
    }
})
