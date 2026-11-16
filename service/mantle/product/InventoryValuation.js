// Inventory valuation for Accounting (InventoryReportServices): stock valued at each asset's current cost
// (AssetValuationSummary) beside the inventory and WIP account balances, with the movements that explain a difference
// (receipts and issues that posted nothing, zero-cost receipts, postings in the error journal, open WIP by run); the
// stock transactions report; a product's accounting context for Product360; and the valuation rows of the period close
// checklist. Every read checks the organization and Accounting's report read.
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/AccountingPolicy.js")
const {find, one, rows, map, call, ms, denied} = lib
const FAILED = ["AtrNoAcquireCost", "AtrNoAcctgPreference", "AtrPostingFailed"]
const LIST_LIMIT = 50
const ROW_LIMIT = 1000
const RECEIPT = "mantle.product.receipt.AssetReceiptValuation",
    ISSUE = "mantle.product.issuance.AssetIssuanceValuation",
    VARIANCE = "mantle.product.asset.AssetVarianceValuation"

const dayAfter = day => lib.calendarDateText(Date.parse(day) + 86400000)
const midnight = day => ec.l10n.parseTimestamp(day, "yyyy-MM-dd")
const today = () => ec.l10n.format(ec.user.nowTimestamp, "yyyy-MM-dd")
function money(value, currency) {
    return lib.lib.money(value ?? 0, currency)
}
function enumText(ids) {
    const unique = [...new Set(ids.filter(Boolean))]
    if (!unique.length) return {}
    return Object.fromEntries(
        Array.from(find("moqui.basic.Enumeration").condition("enumId", "in", unique).useCache(true).list()).map(r => [
            r.enumId,
            r.description || r.enumId
        ])
    )
}
function productNames(ids) {
    const unique = [...new Set(ids.filter(Boolean))]
    if (!unique.length) return {}
    return Object.fromEntries(
        Array.from(find("mantle.product.Product").condition("productId", "in", unique).list()).map(r => [
            r.productId,
            r.productName || r.productId
        ])
    )
}
function defaultAccount(org, type) {
    return call("mantle.ledger.LedgerServices.get#DefaultGlAccountByType", {organizationPartyId: org, glAccountTypeEnumId: type})
        .glAccountId
}
// The organization's inventory and WIP accounts: the account type defaults and every inventory asset mapping's accounts.
function stockAccounts(org) {
    const inventory = new Set([defaultAccount(org, "GatInventory")].filter(Boolean)),
        wip = new Set([defaultAccount(org, "GatWipInventory")].filter(Boolean))
    for (const mapping of find("mantle.ledger.config.AssetTypeGlAccount")
        .condition("organizationPartyId", "in", lib.organizationChain(org))
        .list()) {
        if (mapping.assetTypeEnumId && mapping.assetTypeEnumId !== "AstTpInventory") continue
        if (mapping.assetGlAccountId) inventory.add(mapping.assetGlAccountId)
        if (mapping.wipAssetGlAccountId) wip.add(mapping.wipAssetGlAccountId)
    }
    for (const id of inventory) wip.delete(id)
    return {inventory: [...inventory].sort(), wip: [...wip].sort()}
}
// Posted ledger net (debit less credit) on accounts through a day, by the field given (productId, glAccountId).
function ledgerNet(org, accounts, afterDay, byField, conditions = {}) {
    const out = {}
    if (!accounts.length) return out
    let q = find("mantle.ledger.transaction.AcctgTransAndEntrySummary", {organizationPartyId: org, isPosted: "Y"})
        .condition("glAccountId", "in", accounts)
        .condition(lib.accountingDateCondition({thruDate: midnight(afterDay), thruDay: afterDay}))
    for (const [field, value] of Object.entries(conditions))
        if (Array.isArray(value)) q = q.condition(field, "in", value.length ? value : ["_NA_"])
        else if (value) q = q.condition(field, value)
    for (const field of [byField, "debitCreditFlag", "amount"]) q = q.selectField(field)
    for (const row of q.list()) {
        const key = row[byField] || ""
        const amount = toDecimal(row.amount ?? 0)
        out[key] = (out[key] || toDecimal(0)).add(row.debitCreditFlag === "D" ? amount : amount.negate())
    }
    return out
}
// The organization's inventory through a day, by asset: its quantity then, at its cost then. The cost is the asset's
// current cost, back to the cost before each revaluation or landed cost dated after the day (a repair reposts history,
// so it is not undone). Today it reads the assets holding stock; for an earlier day those received by then that hold
// stock now or moved after it. Up to ASSET_LIMIT assets (MOVED_LIMIT moved ones); beyond that the stock is incomplete,
// and its difference with the ledger is unavailable.
const ASSET_LIMIT = 5000,
    MOVED_LIMIT = 20000
function stockOf(org, afterDay, p = {}) {
    const currency = lib.preference(org).baseCurrencyUomId
    const before = midnight(afterDay)
    const cf = ec.entity.conditionFactory
    const owned = entity => {
        let q = find(entity, {ownerPartyId: org, assetTypeEnumId: "AstTpInventory"})
        if (p.facilityId) q = q.condition("facilityId", p.facilityId)
        if (p.productId) q = q.condition("productId", p.productId)
        return q
    }
    let complete = true,
        assets
    if (afterDay > today()) {
        let q = owned("mantle.product.asset.Asset").condition("quantityOnHandTotal", "not-equals", 0)
        for (const field of ["assetId", "productId", "acquireCost", "acquireCostUomId", "quantityOnHandTotal"])
            q = q.selectField(field)
        const found = Array.from(
            q
                .orderBy("assetId")
                .limit(ASSET_LIMIT + 1)
                .list()
        )
        complete = found.length <= ASSET_LIMIT
        assets = found.slice(0, ASSET_LIMIT).map(r => Object.assign(map(r), {quantityOnHandDiff: r.quantityOnHandTotal}))
    } else {
        const moved = Array.from(
            find("mantle.product.asset.AssetDetail")
                .condition("effectiveDate", "greater-equals", before)
                .selectField("assetId")
                .distinct(true)
                .limit(MOVED_LIMIT + 1)
                .list()
        ).map(r => r.assetId)
        if (moved.length > MOVED_LIMIT) complete = false
        const held = [cf.makeCondition("quantityOnHandTotal", "not-equals", 0)]
        if (moved.length) held.push(cf.makeCondition("assetId", "in", moved.slice(0, MOVED_LIMIT)))
        const candidates = Array.from(
            owned("mantle.product.asset.Asset")
                .condition(cf.makeCondition(held, "or"))
                .condition(
                    cf.makeCondition(
                        [cf.makeCondition("receivedDate", "is-null", null), cf.makeCondition("receivedDate", "less", before)],
                        "or"
                    )
                )
                .selectField("assetId")
                .orderBy("assetId")
                .limit(ASSET_LIMIT + 1)
                .list()
        ).map(r => r.assetId)
        if (candidates.length > ASSET_LIMIT) complete = false
        let q = owned("mantle.product.asset.AssetValuationSummary")
            .condition("assetId", "in", candidates.length ? candidates.slice(0, ASSET_LIMIT) : ["_NA_"])
            .condition("effectiveDate", "less", before)
        for (const field of ["assetId", "productId", "acquireCost", "acquireCostUomId", "quantityOnHandDiff"])
            q = q.selectField(field)
        assets = Array.from(q.orderBy("assetId").list())
    }
    assets = assets.filter(r => toDecimal(r.quantityOnHandDiff ?? 0).compare(0) !== 0)
    const earlierCost = {}
    if (afterDay <= today() && assets.length)
        for (const event of find("mantle.product.asset.AssetBookEvent")
            .condition(
                "assetId",
                "in",
                assets.map(a => a.assetId)
            )
            .condition("eventTypeEnumId", "in", ["AbeInventoryRevaluation", "AbeLandedCost"])
            .condition("eventDate", "greater-equals", before)
            .orderBy("-eventDate")
            .list())
            earlierCost[event.assetId] = event.previousUnitCost
    const byProduct = {}
    let total = toDecimal(0),
        otherCurrency = false,
        unpricedQuantity = toDecimal(0),
        unpricedCount = 0
    for (const asset of assets) {
        const entry =
            byProduct[asset.productId] ||
            (byProduct[asset.productId] = {quantity: toDecimal(0), value: toDecimal(0), minCost: null, maxCost: null})
        const quantity = toDecimal(asset.quantityOnHandDiff)
        const cost = Object.prototype.hasOwnProperty.call(earlierCost, asset.assetId)
            ? earlierCost[asset.assetId]
            : asset.acquireCost
        entry.quantity = entry.quantity.add(quantity)
        if (asset.acquireCostUomId && asset.acquireCostUomId !== currency) {
            entry.otherCurrency = otherCurrency = true
            continue
        }
        // stock with no cost is counted at none, so a summary that agrees says how much it leaves out (ACC-UI-013)
        if (cost == null && quantity.compare(0) !== 0) {
            unpricedQuantity = unpricedQuantity.add(quantity)
            unpricedCount++
        }
        const value = quantity.multiply(toDecimal(cost ?? 0))
        entry.value = entry.value.add(value)
        total = total.add(value)
        if (cost != null) {
            if (entry.minCost == null || toDecimal(cost).compare(entry.minCost) < 0) entry.minCost = toDecimal(cost)
            if (entry.maxCost == null || toDecimal(cost).compare(entry.maxCost) > 0) entry.maxCost = toDecimal(cost)
        }
    }
    return {currency, byProduct, total: money(total, currency), otherCurrency, unpricedQuantity, unpricedCount, complete}
}
// The ledger conditions of a valuation's filters: a product, and for a facility the organization's assets there (stock
// postings name their asset; few name a facility).
function ledgerFilter(org, p) {
    const out = {}
    if (p.productId) out.productId = p.productId
    if (p.facilityId)
        out.assetId = Array.from(
            find("mantle.product.asset.Asset", {ownerPartyId: org, facilityId: p.facilityId})
                .selectField("assetId")
                .limit(ASSET_LIMIT)
                .list()
        ).map(r => r.assetId)
    return out
}
// The stock value and the inventory and WIP balances of an organization through a day, and the difference.
function tieOut(org, afterDay, p = {}) {
    const accounts = stockAccounts(org)
    const stock = stockOf(org, afterDay, p)
    const currency = stock.currency
    const filter = ledgerFilter(org, p)
    const inventoryByAccount = ledgerNet(org, accounts.inventory, afterDay, "glAccountId", filter)
    const wipByAccount = ledgerNet(org, accounts.wip, afterDay, "glAccountId", filter)
    const sum = byAccount => Object.values(byAccount).reduce((total, v) => total.add(v), toDecimal(0))
    const inventoryBalance = money(sum(inventoryByAccount), currency),
        wipBalance = money(sum(wipByAccount), currency)
    const names = Object.fromEntries(
        accounts.inventory.length + accounts.wip.length
            ? Array.from(
                  find("mantle.ledger.account.GlAccount")
                      .condition("glAccountId", "in", accounts.inventory.concat(accounts.wip))
                      .list()
              ).map(r => [r.glAccountId, (r.accountCode || r.glAccountId) + " " + (r.accountName || "")])
            : []
    )
    const accountRows = [
        ...accounts.inventory.map(id => ({kind: "Inventory", glAccountId: id, balance: inventoryByAccount[id]})),
        ...accounts.wip.map(id => ({kind: "WIP", glAccountId: id, balance: wipByAccount[id]}))
    ].map(r =>
        Object.assign(r, {accountText: names[r.glAccountId] || r.glAccountId, balance: money(r.balance, currency), currency})
    )
    return {
        currency,
        stock,
        stockValue: stock.total,
        inventoryBalance,
        wipBalance,
        difference: stock.complete ? stock.total.subtract(inventoryBalance) : null,
        otherCurrency: stock.otherCurrency,
        unpricedQuantity: stock.unpricedQuantity,
        unpricedCount: stock.unpricedCount,
        complete: stock.complete,
        accounts,
        accountRows,
        filter
    }
}
function asOf(p) {
    const day = p.asOfDate ? lib.calendarDateText(p.asOfDate) : today()
    if (day > today()) denied("DATE_FUTURE", "Choose today or an earlier day")
    return day
}
function scopeOf(p) {
    const s = lib.organization(p, "reportRead")
    if (p.facilityId) lib.dimensions(s.organizationPartyId, {facilityId: p.facilityId})
    return s
}
function valuation(p) {
    const s = scopeOf(p)
    const org = s.organizationPartyId
    const day = asOf(p),
        afterDay = dayAfter(day)
    const totals = tieOut(org, afterDay, p)
    const wip = wipByRun(org, afterDay, p)
    const currency = totals.currency
    const stock = totals.stock.byProduct
    const truncated = !totals.complete
    const ledger = ledgerNet(org, totals.accounts.inventory, afterDay, "productId", totals.filter)
    // when the stock is incomplete, only its products are compared with their ledger
    if (truncated) for (const key of Object.keys(ledger)) if (key && !stock[key]) delete ledger[key]
    const ids = [...new Set([...Object.keys(stock), ...Object.keys(ledger).filter(Boolean)])]
    const names = productNames(ids)
    const standards = {}
    if (ids.length)
        for (const row of find("mantle.product.cost.ProductStandardCost", {organizationPartyId: org, state: "approved"})
            .condition("productId", "in", ids.slice(0, ROW_LIMIT))
            .list())
            if (lib.active(row)) standards[row.productId] = row.productStandardCostId
    const valuationRows = ids.map(productId => {
        const entry = stock[productId] || {quantity: toDecimal(0), value: toDecimal(0)}
        const value = money(entry.value, currency),
            balance = money(ledger[productId], currency)
        return {
            productId,
            productName: names[productId] || productId,
            quantity: entry.quantity,
            value,
            unitCostText:
                entry.minCost == null
                    ? ""
                    : toDecimal(entry.minCost).compare(toDecimal(entry.maxCost)) === 0
                      ? String(entry.minCost)
                      : String(entry.minCost) + " – " + String(entry.maxCost),
            ledgerBalance: balance,
            difference: value.subtract(balance),
            otherCurrency: !!entry.otherCurrency,
            currency,
            productStandardCostId: standards[productId] || null
        }
    })
    if (ledger[""] && !p.productId)
        valuationRows.push({
            productId: "",
            productName: "Not by product",
            quantity: null,
            value: toDecimal(0),
            ledgerBalance: money(ledger[""], currency),
            difference: money(ledger[""], currency).negate(),
            currency
        })
    valuationRows.sort(
        (a, b) => b.difference.abs().compare(a.difference.abs()) || String(a.productName).localeCompare(String(b.productName))
    )
    const pageSize = Math.min(100, Math.max(1, Number(p.pageSize) || 25)),
        maxIndex = Math.max(0, Math.ceil(valuationRows.length / pageSize) - 1),
        pageIndex = Math.min(maxIndex, Math.max(0, Number(p.pageIndex) || 0))
    return {
        organizationPartyId: org,
        asOfDay: day,
        summary: {
            stockValue: totals.stockValue,
            inventoryBalance: totals.inventoryBalance,
            wipBalance: totals.wipBalance,
            difference: totals.difference,
            agrees: totals.difference != null && totals.difference.compare(0) === 0,
            otherCurrency: totals.otherCurrency,
            unpricedQuantity: totals.unpricedQuantity,
            unpricedCount: totals.unpricedCount,
            currency
        },
        accountRows: totals.accountRows,
        valuationRows: valuationRows.slice(pageIndex * pageSize, (pageIndex + 1) * pageSize),
        valuationRowsCount: valuationRows.length,
        valuationRowsPageIndex: pageIndex,
        valuationRowsPageSize: pageSize,
        valuationRowsPageMaxIndex: maxIndex,
        valuationRowsPageRangeLow: valuationRows.length ? pageIndex * pageSize + 1 : 0,
        valuationRowsPageRangeHigh: Math.min(valuationRows.length, (pageIndex + 1) * pageSize),
        complete: !truncated,
        exceptionRows: exceptions(org, afterDay, p),
        facilityFiltered: !!p.facilityId,
        pastDay: day < today(),
        wipRows: wip.rows,
        wipComplete: wip.complete,
        canRepair: !!s.capabilities.admin,
        canRevalue: !!s.capabilities.glPost
    }
}
// The movements that explain a difference, up to LIST_LIMIT of each kind.
function exceptions(org, afterDay, p = {}) {
    const before = midnight(afterDay)
    const out = []
    const scoped = (entity, dateField) => {
        let q = find(entity, {ownerPartyId: org}).condition(dateField, "less", before)
        if (p.facilityId) q = q.condition("facilityId", p.facilityId)
        if (p.productId) q = q.condition("productId", p.productId)
        return q
    }
    const add = (kind, kindText, rowsFound, idField, dateField, quantityField) => {
        for (const row of rowsFound)
            out.push({
                kind,
                kindText,
                movementId: row[idField],
                movementDate: row[dateField],
                movementDateText: lib.dateText(row[dateField]),
                productId: row.productId,
                productName: row.productName || row.productId,
                assetId: row.assetId,
                quantity: row[quantityField],
                resultEnumId: row.acctgTransResultEnumId
            })
    }
    add(
        "receipt",
        "Receipt",
        scoped(RECEIPT, "receivedDate")
            .condition("acctgTransResultEnumId", "in", FAILED)
            .orderBy("-receivedDate")
            .limit(LIST_LIMIT)
            .list(),
        "assetReceiptId",
        "receivedDate",
        "quantityAccepted"
    )
    add(
        "zeroCost",
        "Zero-cost receipt",
        scoped(RECEIPT, "receivedDate")
            .condition("acctgTransResultEnumId", "AtrSuccess")
            .condition("acquireCost", "equals", 0)
            .condition("quantityAccepted", "greater", 0)
            .orderBy("-receivedDate")
            .limit(LIST_LIMIT)
            .list(),
        "assetReceiptId",
        "receivedDate",
        "quantityAccepted"
    )
    add(
        "issue",
        "Issue",
        scoped(ISSUE, "issuedDate")
            .condition("acctgTransResultEnumId", "in", FAILED)
            .orderBy("-issuedDate")
            .limit(LIST_LIMIT)
            .list(),
        "assetIssuanceId",
        "issuedDate",
        "quantity"
    )
    add(
        "variance",
        "Count variance",
        scoped(VARIANCE, "effectiveDate")
            .condition("physicalInventoryId", "is-not-null", null)
            .condition("acctgTransResultEnumId", "in", FAILED)
            .orderBy("-effectiveDate")
            .limit(LIST_LIMIT)
            .list(),
        "assetDetailId",
        "effectiveDate",
        "quantityOnHandDiff"
    )
    const results = enumText(out.map(r => r.resultEnumId))
    for (const row of out) row.resultText = row.kind === "zeroCost" ? "Posted at zero cost" : results[row.resultEnumId] || ""
    // stock postings waiting in the error journal
    const errorJournalId = lib.preference(org).errorGlJournalId
    if (errorJournalId) {
        const cf = ec.entity.conditionFactory
        let q = find("mantle.ledger.transaction.AcctgTrans", {
            organizationPartyId: org,
            glJournalId: errorJournalId,
            isPosted: "N"
        })
            .condition(
                cf.makeCondition(
                    ["assetReceiptId", "assetIssuanceId", "physicalInventoryId", "assetId"].map(field =>
                        cf.makeCondition(field, "is-not-null", null)
                    ),
                    "or"
                )
            )
            .condition("transactionDate", "less", before)
        for (const row of q.orderBy("-transactionDate").limit(LIST_LIMIT).list())
            out.push({
                kind: "errorJournal",
                kindText: "In the error journal",
                movementId: row.assetReceiptId || row.assetIssuanceId || row.physicalInventoryId || row.assetId,
                movementDate: row.transactionDate,
                movementDateText: lib.dateText(row.transactionDate),
                assetId: row.assetId,
                acctgTransId: row.acctgTransId,
                resultText: row.postingFailureMessage || row.postingFailureCode || "Not posted"
            })
    }
    return out
}
// Production runs and other work with stock issued to it that its receipts have not taken back out, by the assets'
// current cost: the WIP a run holds until its cost close.
function wipByRun(org, afterDay, p = {}) {
    const net = {}
    let complete = true
    const add = (entity, quantityField, dateField, sign) => {
        let q = find(entity, {ownerPartyId: org})
            .condition("workEffortId", "is-not-null", null)
            .condition(dateField, "less", midnight(afterDay))
        if (p.facilityId) q = q.condition("facilityId", p.facilityId)
        const found = Array.from(
            q
                .orderBy(dateField + ",workEffortId")
                .limit(ROW_LIMIT + 1)
                .list()
        )
        if (found.length > ROW_LIMIT) complete = false
        for (const row of found.slice(0, ROW_LIMIT)) {
            const value = toDecimal(row[quantityField] ?? 0).multiply(toDecimal(row.acquireCost ?? 0))
            net[row.workEffortId] = (net[row.workEffortId] || toDecimal(0)).add(sign > 0 ? value : value.negate())
        }
    }
    add(ISSUE, "quantity", "issuedDate", 1)
    add(RECEIPT, "quantityAccepted", "receivedDate", -1)
    const ids = Object.keys(net).filter(id => net[id].compare(0) !== 0)
    if (!ids.length) return {rows: [], complete}
    const currency = lib.preference(org).baseCurrencyUomId
    const efforts = Object.fromEntries(
        Array.from(find("mantle.work.effort.WorkEffort").condition("workEffortId", "in", ids).list()).map(r => [
            r.workEffortId,
            r
        ])
    )
    const statuses = {}
    for (const row of find("moqui.basic.StatusItem")
        .condition(
            "statusId",
            "in",
            [
                ...new Set(
                    Object.values(efforts)
                        .map(e => e.statusId)
                        .filter(Boolean)
                )
            ].concat(["_"])
        )
        .useCache(true)
        .list())
        statuses[row.statusId] = row.description
    const open = ids.filter(id => !["WeCancelled"].includes(efforts[id]?.statusId)).sort()
    if (open.length > LIST_LIMIT) complete = false
    const rowsOut = open.slice(0, LIST_LIMIT).map(id => ({
        workEffortId: id,
        workEffortName: efforts[id]?.workEffortName || id,
        statusText: statuses[efforts[id]?.statusId] || "",
        openWip: money(net[id], currency),
        currency
    }))
    return {rows: rowsOut, complete}
}

// The period or dates of a report, checked against the organization.
function reportDates(org, p) {
    if (p.timePeriodId) {
        const period = lib.record({kind: "periods", recordId: p.timePeriodId, organizationPartyId: org})
        if (period.partyId !== org) denied("PERIOD_UNAVAILABLE", "Choose a fiscal period of this organization")
        const fromDay = lib.calendarDateText(period.fromDate),
            thruDay = lib.calendarDateText(period.thruDate)
        return {fromDay, thruDay, period: lib.display(period)}
    }
    const thruDay = p.thruDate ? lib.calendarDateText(p.thruDate) : today()
    const fromDay = p.fromDate ? lib.calendarDateText(p.fromDate) : thruDay.slice(0, 8) + "01"
    if (fromDay > thruDay) denied("DATES_INVALID", "Choose an increasing report date range")
    return {fromDay, thruDay, period: null}
}
// The organization's stock movements of a period: receipts, issues and count variances with their cost and posting.
function stockTransactions(p) {
    const s = scopeOf(p)
    const org = s.organizationPartyId
    const {fromDay, thruDay, period} = reportDates(org, p)
    const from = midnight(fromDay),
        before = midnight(dayAfter(thruDay))
    const limit = Math.min(2000, Math.max(1, Number(p.listLimit) || 500))
    const currency = lib.preference(org).baseCurrencyUomId
    const kinds = p.movementKind ? [p.movementKind] : ["receipt", "issue", "variance"]
    const sources = {
        receipt: [RECEIPT, "assetReceiptId", "receivedDate", "quantityAccepted", "Receipt", 1],
        issue: [ISSUE, "assetIssuanceId", "issuedDate", "quantity", "Issue", -1],
        variance: [VARIANCE, "assetDetailId", "effectiveDate", "quantityOnHandDiff", "Count variance", 1]
    }
    const movements = []
    const totals = []
    let incomplete = false
    for (const kind of kinds) {
        const source = sources[kind]
        if (!source) denied("KIND_INVALID", "Choose receipts, issues or count variances")
        const [entity, idField, dateField, quantityField, kindText, sign] = source
        const query = () => {
            let q = find(entity, {ownerPartyId: org, assetTypeEnumId: "AstTpInventory"})
                .condition(dateField, "greater-equals", from)
                .condition(dateField, "less", before)
            if (kind === "variance") q = q.condition("physicalInventoryId", "is-not-null", null)
            if (p.facilityId) q = q.condition("facilityId", p.facilityId)
            if (p.productId) q = q.condition("productId", p.productId)
            if (p.postedOnly === "Y" || p.postedOnly === true) q = q.condition("acctgTransResultEnumId", "AtrSuccess")
            return q
        }
        const count = query().count()
        if (count > limit) incomplete = true
        let quantity = toDecimal(0),
            value = toDecimal(0)
        for (const row of query()
            .orderBy("-" + dateField)
            .limit(limit)
            .list()) {
            const q = toDecimal(row[quantityField] ?? 0).multiply(sign)
            const v = money(q.multiply(toDecimal(row.acquireCost ?? 0)), currency)
            quantity = quantity.add(q)
            value = value.add(v)
            movements.push({
                kind,
                kindText,
                movementId: row[idField],
                movementDate: row[dateField],
                movementDateText: lib.dateText(row[dateField]),
                facilityId: row.facilityId,
                productId: row.productId,
                productName: row.productName || row.productId,
                assetId: row.assetId,
                lotId: row.lotId,
                shipmentId: row.shipmentId,
                orderId: row.orderId,
                workEffortId: row.workEffortId,
                quantity: q,
                unitCost: row.acquireCost,
                value,
                currency,
                resultEnumId: row.acctgTransResultEnumId
            })
        }
        totals.push({kind, kindText, count, quantity, value: money(value, currency), currency})
    }
    const results = enumText(movements.map(r => r.resultEnumId))
    for (const row of movements) row.resultText = results[row.resultEnumId] || row.resultEnumId || "Not posted"
    movements.sort((a, b) => ms(b.movementDate) - ms(a.movementDate) || String(a.movementId).localeCompare(b.movementId))
    const pageSize = Math.min(100, Math.max(1, Number(p.pageSize) || 25)),
        maxIndex = Math.max(0, Math.ceil(movements.length / pageSize) - 1),
        pageIndex = Math.min(maxIndex, Math.max(0, Number(p.pageIndex) || 0))
    return {
        organizationPartyId: org,
        fromDay,
        thruDay,
        period,
        totalRows: totals,
        movementRows: movements.slice(pageIndex * pageSize, (pageIndex + 1) * pageSize),
        movementRowsCount: movements.length,
        movementRowsPageIndex: pageIndex,
        movementRowsPageSize: pageSize,
        movementRowsPageMaxIndex: maxIndex,
        movementRowsPageRangeLow: movements.length ? pageIndex * pageSize + 1 : 0,
        movementRowsPageRangeHigh: Math.min(movements.length, (pageIndex + 1) * pageSize),
        complete: !incomplete
    }
}

// A product as Accounting sees it: its stock and value beside its inventory balance, its cost history (approved standard
// costs, revaluations, landed costs and repairs), its recent movements, its prices when the user may read them, and its
// GL mappings for the organization and the categories it is in.
function productAccounting(p) {
    const s = lib.organization(p, "reportRead")
    const org = s.organizationPartyId
    const product = p.productId && one("mantle.product.Product", {productId: p.productId})
    const owners = ["_NA_", ...lib.organizationChain(org)]
    const held = product
        ? find("mantle.product.asset.Asset", {productId: product.productId, ownerPartyId: org}).count() > 0
        : false
    if (!product || (product.ownerPartyId && !owners.includes(product.ownerPartyId) && !held))
        return {productFound: false, organizationPartyId: org}
    const productId = product.productId
    const currency = lib.preference(org).baseCurrencyUomId
    const afterDay = dayAfter(today())
    const totals = tieOut(org, afterDay, {productId})
    const quantity = totals.stock.byProduct[productId]?.quantity ?? toDecimal(0)
    const standards = rows("mantle.product.cost.ProductStandardCost", {productId, organizationPartyId: org, state: "approved"})
        .sort((a, b) => (ms(b.fromDate) ?? 0) - (ms(a.fromDate) ?? 0))
        .slice(0, LIST_LIMIT)
    const current = standards.find(r => lib.active(r))
    const eventTypes = enumText(["AbeInventoryRevaluation", "AbeLandedCost", "AbeCostDataRepair"])
    const costRows = [
        ...standards.map(r => ({
            kindText: "Standard cost",
            dateText: lib.dateText(r.fromDate),
            date: r.fromDate,
            unitCost: r.unitCost,
            currency: r.priceUomId || currency,
            description: (r.thruDate ? "Until " + lib.dateText(r.thruDate) : "In effect") + " · " + r.productStandardCostId,
            acctgTransId: null
        })),
        ...Array.from(
            find("mantle.product.asset.AssetBookEvent", {productId, organizationPartyId: org})
                .orderBy("-eventDate")
                .limit(LIST_LIMIT)
                .list()
        ).map(r => ({
            kindText: eventTypes[r.eventTypeEnumId] || r.eventTypeEnumId,
            dateText: lib.dateText(r.eventDate),
            date: r.eventDate,
            unitCost: r.newUnitCost,
            previousUnitCost: r.previousUnitCost,
            amount: r.amount,
            currency: r.unitCostUomId || currency,
            description: (r.assetId ? "Asset " + r.assetId + " · " : "") + (r.changeReason || ""),
            acctgTransId: r.acctgTransId
        }))
    ].sort((a, b) => (ms(b.date) ?? 0) - (ms(a.date) ?? 0))
    const movements = stockTransactions({
        organizationPartyId: org,
        productId,
        fromDate: "2000-01-01",
        thruDate: today(),
        pageSize: 20
    }).movementRows
    const pricesPermitted = lib.lib.access.has("PRICE_VIEW") || lib.lib.access.has("PRICE_EDIT")
    const priceRows = pricesPermitted
        ? rows("mantle.product.ProductPrice", {productId})
              .filter(r => lib.active(r) && (!r.vendorPartyId || owners.includes(r.vendorPartyId)))
              .sort((a, b) => String(a.priceTypeEnumId).localeCompare(String(b.priceTypeEnumId)))
              .slice(0, LIST_LIMIT)
              .map(r => lib.display(r))
        : []
    const priceTypes = enumText(priceRows.flatMap(r => [r.priceTypeEnumId, r.pricePurposeEnumId]))
    for (const row of priceRows)
        row.typeText = [priceTypes[row.priceTypeEnumId], priceTypes[row.pricePurposeEnumId]].filter(Boolean).join(" · ")
    const categoryIds = rows("mantle.product.category.ProductCategoryMember", {productId})
        .filter(r => lib.active(r))
        .map(r => r.productCategoryId)
    const glRows = [
        ...Array.from(
            find("mantle.ledger.config.ProductGlAccount", {productId})
                .condition("organizationPartyId", "in", lib.organizationChain(org))
                .list()
        ).map(r => Object.assign(map(r), {mappingKind: "product", scopeText: "This product"})),
        ...(categoryIds.length
            ? Array.from(
                  find("mantle.ledger.config.ProductCategoryGlAccount")
                      .condition("productCategoryId", "in", categoryIds)
                      .condition("organizationPartyId", "in", lib.organizationChain(org))
                      .list()
              ).map(r => Object.assign(map(r), {mappingKind: "category", scopeText: "Category " + r.productCategoryId}))
            : [])
    ]
    const typeTexts = enumText(glRows.map(r => r.glAccountTypeEnumId))
    const accountIds = [...new Set(glRows.flatMap(r => [r.glAccountId, r.contraGlAccountId]).filter(Boolean))]
    const accountNames = accountIds.length
        ? Object.fromEntries(
              Array.from(find("mantle.ledger.account.GlAccount").condition("glAccountId", "in", accountIds).list()).map(r => [
                  r.glAccountId,
                  (r.accountCode || r.glAccountId) + " " + (r.accountName || "")
              ])
          )
        : {}
    for (const row of glRows) {
        row.typeText = typeTexts[row.glAccountTypeEnumId] || row.glAccountTypeEnumId
        row.accountText = accountNames[row.glAccountId] || row.glAccountId || ""
        row.contraText = accountNames[row.contraGlAccountId] || row.contraGlAccountId || ""
    }
    return {
        productFound: true,
        organizationPartyId: org,
        product: lib.pick(map(product), ["productId", "pseudoId", "productName", "productTypeEnumId", "ownerPartyId"]),
        summary: {
            quantity,
            stockValue: totals.stockValue,
            ledgerBalance: totals.inventoryBalance,
            difference: totals.difference,
            standardUnitCost: current?.unitCost ?? null,
            productStandardCostId: current?.productStandardCostId || null,
            currency
        },
        costRows,
        movementRows: movements,
        pricesPermitted,
        priceRows,
        glRows,
        categoryIds,
        canEditGl: !!s.capabilities.admin
    }
}

// The valuation rows of the period close checklist (CloseServices.define#CloseCheck): the period's receipts with no cost
// basis, and the difference between the stock value and the inventory accounts at the period's end for each organization.
function closeCheck(p) {
    const close = ec.resource.script("component://mr-mantle/service/mantle/ledger/PeriodClose.js")
    const c = close.periodScope(p)
    if (p.checkEnumId === "PccReceiptCostBasis") {
        const cf = ec.entity.conditionFactory
        const query = () =>
            find(RECEIPT)
                .condition("ownerPartyId", "in", c.organizations)
                .condition("assetTypeEnumId", "AstTpInventory")
                .condition("quantityAccepted", "greater", 0)
                .condition(close.stampInPeriod(c, "receivedDate"))
                .condition(
                    cf.makeCondition(
                        [
                            cf.makeCondition("acctgTransResultEnumId", "equals", "AtrNoAcquireCost"),
                            cf.makeCondition(
                                [
                                    cf.makeCondition("acctgTransResultEnumId", "equals", "AtrSuccess"),
                                    cf.makeCondition("acquireCost", "equals", 0)
                                ],
                                "and"
                            )
                        ],
                        "or"
                    )
                )
        const items = Array.from(query().orderBy("assetReceiptId").limit(20).list()).map(r => ({
            recordKind: "inventoryValuation",
            recordId: r.ownerPartyId,
            text: "Receipt " + r.assetReceiptId + " of " + (r.productName || r.productId),
            detail: r.acctgTransResultEnumId === "AtrNoAcquireCost" ? "No acquire cost" : "Posted at zero cost"
        }))
        return {count: query().count(), items}
    }
    if (p.checkEnumId === "PccValuationTieOut") {
        const items = []
        for (const org of c.organizations) {
            const totals = tieOut(org, c.afterDay)
            if (totals.difference == null) {
                items.push({
                    recordKind: "inventoryValuation",
                    recordId: org,
                    text: "The tie-out is not available: the organization holds more stock than one valuation reads",
                    detail: "Value it by facility or product"
                })
                continue
            }
            if (totals.difference.compare(0) === 0 && !totals.otherCurrency) continue
            const text = amount => ec.l10n.formatCurrency(amount, totals.currency)
            items.push({
                recordKind: "inventoryValuation",
                recordId: org,
                text:
                    "Stock " +
                    text(totals.stockValue) +
                    ", inventory accounts " +
                    text(totals.inventoryBalance) +
                    ": a difference of " +
                    text(totals.difference),
                detail: totals.otherCurrency ? "Some stock is costed in another currency" : "See the valuation exceptions"
            })
        }
        return {count: items.length, items}
    }
    throw new Error("Unknown valuation check " + p.checkEnumId)
}

const operations = {valuation, stockTransactions, productAccounting, closeCheck}
;({
    execute: (op, p) => {
        if (!operations[op]) throw new Error("Unknown inventory valuation operation " + op)
        return operations[op](p)
    },
    tieOut
})
