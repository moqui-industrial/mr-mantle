// Landed costs and cost data repair (AssetBookServices). A landed cost spreads one charge line of a posted bill over
// receipt lines by quantity, value, weight or volume: the share of each receipt still on hand raises its asset's cost
// from the accounting date (forward cost, as a revaluation does), the share already issued goes to cost of goods sold or
// production variance, and the charge's own account is credited, in one posted transaction. A charge line is allocated
// once. Cost data repair is the finance administrator's audited rewrite of a product's acquire cost, which reposts its
// history (update#AssetAcquireCost), in open periods only.
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/AccountingPolicy.js")
const books = () => ec.resource.script("component://mr-mantle/service/mantle/ledger/AssetBooks.js")
const forward = () => ec.resource.script("component://mr-mantle/service/mantle/ledger/ForwardInventoryCosts.js")
const {find, one, rows, map, call, ms, denied} = lib
const ALLOCATION = "mantle.account.invoice.LandedCostAllocation"
const ASSET = "mantle.product.asset.Asset"
const RECEIPT_LIMIT = 50
// the decimals Asset.acquireCost keeps (currency-amount): a new unit cost is rounded to them before the inventory posts
const COST_SCALE = 4
const BASIS_DIMENSIONS = {LcbWeight: ["Weight", "ShippingWeight"], LcbVolume: ["Volume"]}

// The bill and its organization, read through the Accounting record check (a bill of an organization the user works in).
function billOf(p) {
    if (!p.invoiceId) denied("RECORD_REQUIRED", "Choose a bill")
    const bill = lib.record({kind: "bills", recordId: p.invoiceId, organizationPartyId: p.organizationPartyId})
    const org = bill.financeOrganizationPartyId || bill.toPartyId
    return {bill, org, scope: lib.scope({organizationPartyId: org})}
}
function chargeGroup() {
    return Array.from(find("moqui.basic.EnumGroupMember", {enumGroupEnumId: "EngItemsLandedCost"}).useCache(true).list()).map(
        r => r.enumId
    )
}
// The bill's lines, each with its total, the account its posting debited and whether it was allocated.
function chargeLines(bill) {
    const types = chargeGroup()
    const posted = rows("mantle.ledger.transaction.AcctgTrans", {invoiceId: bill.invoiceId, isPosted: "Y"}).filter(
        r => !r.reversedByAcctgTransId && !r.reverseOfAcctgTransId
    )
    const debits = {}
    if (posted.length)
        for (const entry of find("mantle.ledger.transaction.AcctgTransEntry")
            .condition(
                "acctgTransId",
                "in",
                posted.map(r => r.acctgTransId)
            )
            .condition("debitCreditFlag", "D")
            .list())
            if (entry.invoiceItemSeqId) debits[entry.invoiceItemSeqId] = entry.glAccountId
    const allocated = new Set(rows(ALLOCATION, {invoiceId: bill.invoiceId, statusId: "LcaPosted"}).map(r => r.invoiceItemSeqId))
    const typeNames = Object.fromEntries(
        Array.from(find("moqui.basic.Enumeration", {enumTypeId: "ItemType"}).useCache(true).list()).map(r => [
            r.enumId,
            r.description
        ])
    )
    return rows("mantle.account.invoice.InvoiceItem", {invoiceId: bill.invoiceId})
        .sort((a, b) => a.invoiceItemSeqId.localeCompare(b.invoiceItemSeqId))
        .map(item => {
            const total = lib.lib.money(toDecimal(item.quantity ?? 1).multiply(toDecimal(item.amount ?? 0)), bill.currencyUomId)
            const charge = types.includes(item.itemTypeEnumId) && !item.productId
            return {
                invoiceItemSeqId: item.invoiceItemSeqId,
                itemTypeEnumId: item.itemTypeEnumId,
                itemTypeText: typeNames[item.itemTypeEnumId] || item.itemTypeEnumId,
                description: item.description || "",
                amount: total,
                currencyUomId: bill.currencyUomId,
                chargeGlAccountId: debits[item.invoiceItemSeqId] || null,
                allocated: allocated.has(item.invoiceItemSeqId),
                eligible: charge && !!debits[item.invoiceItemSeqId] && !allocated.has(item.invoiceItemSeqId),
                label: [item.invoiceItemSeqId, item.description || typeNames[item.itemTypeEnumId] || "", String(total)].join(
                    " · "
                )
            }
        })
}
// The organization's posted inventory receipts a charge may go to, newest first, matching a search text on the receipt,
// shipment, order or product.
function candidateReceipts(org, text, selectedIds = []) {
    const cf = ec.entity.conditionFactory
    let query = find("mantle.product.receipt.AssetReceiptValuation", {ownerPartyId: org, assetTypeEnumId: "AstTpInventory"})
        .condition("quantityAccepted", "greater", 0)
        .condition("acctgTransResultEnumId", "AtrSuccess")
    const term = String(text || "").trim()
    if (term)
        query = query.condition(
            cf.makeCondition(
                ["assetReceiptId", "shipmentId", "orderId", "productId", "productName"].map(field =>
                    cf.makeCondition(field, "like", "%" + term + "%").ignoreCase()
                ),
                "or"
            )
        )
    const found = Array.from(query.orderBy("-receivedDate,assetReceiptId").limit(RECEIPT_LIMIT).list()).map(lib.display)
    const missing = selectedIds.filter(id => !found.some(r => r.assetReceiptId === id))
    if (missing.length)
        for (const row of find("mantle.product.receipt.AssetReceiptValuation", {ownerPartyId: org})
            .condition("assetReceiptId", "in", missing)
            .list())
            found.push(lib.display(row))
    const ids = found.map(r => r.assetReceiptId)
    const allocated = new Set(
        ids.length
            ? Array.from(
                  find(ALLOCATION, {statusId: "LcaPosted"})
                      .condition("assetReceiptId", "in", ids)
                      .selectField("assetReceiptId")
                      .list()
              ).map(r => r.assetReceiptId)
            : []
    )
    return found.map(r =>
        Object.assign(r, {
            selected: selectedIds.includes(r.assetReceiptId),
            landedBefore: allocated.has(r.assetReceiptId),
            label: r.assetReceiptId + " · " + (r.productName || r.productId) + " · " + String(r.quantityAccepted)
        })
    )
}
function sources(p) {
    const {bill, org, scope} = billOf(p)
    const selected = String(p.assetReceiptIds || "")
        .split(",")
        .map(s => s.trim())
        .filter(Boolean)
    const allocations = rows(ALLOCATION, {invoiceId: bill.invoiceId})
        .sort((a, b) => (a.invoiceItemSeqId + a.assetReceiptId).localeCompare(b.invoiceItemSeqId + b.assetReceiptId))
        .map(lib.display)
    return {
        organizationPartyId: org,
        bill: lib.display(bill),
        chargeRows: chargeLines(bill),
        receiptRows: candidateReceipts(org, p.receiptText, selected),
        allocationRows: allocations,
        canPost: !!scope.capabilities.glPost
    }
}
// A receipt's asset and the assets its stock went on to: those a revaluation split it into or a move put it in
// (AssetDetail.otherAssetId), and those a transfer shipment's issue received at another facility of the organization,
// each counted for no more than that issue sent (a destination also holds what other sources sent). Each asset once (a
// move out and back is not followed twice), with the most of its stock that can be this receipt's (cap; null for all).
// Stock issued to a transfer that has not been received is in transit.
const CHAIN_LIMIT = 50
function successors(asset, org, cap) {
    const out = []
    const moved = new Set(
        rows("mantle.product.asset.AssetDetail", {otherAssetId: asset.assetId})
            .filter(r => toDecimal(r.quantityOnHandDiff || 0).compare(0) > 0)
            .map(r => r.assetId)
    )
    for (const id of [...moved].sort()) out.push({assetId: id, cap})
    let inTransit = toDecimal(0)
    for (const issue of rows("mantle.product.issuance.AssetIssuance", {assetId: asset.assetId})
        .filter(r => r.shipmentId)
        .sort((a, b) => a.assetIssuanceId.localeCompare(b.assetIssuanceId))) {
        if (one("mantle.shipment.Shipment", {shipmentId: issue.shipmentId})?.shipmentTypeEnumId !== "ShpTpTransfer") continue
        let sent = toDecimal(issue.quantity ?? 0).subtract(toDecimal(issue.quantityCancelled ?? 0))
        if (cap != null && sent.compare(cap) > 0) sent = cap
        for (const receipt of rows("mantle.product.receipt.AssetReceipt", {shipmentId: issue.shipmentId})
            .filter(r => r.productId === asset.productId)
            .sort((a, b) => a.assetReceiptId.localeCompare(b.assetReceiptId))) {
            if (sent.compare(0) <= 0) break
            const received = toDecimal(receipt.quantityAccepted ?? 0)
            const part = received.compare(sent) < 0 ? received : sent
            out.push({assetId: receipt.assetId, cap: part})
            sent = sent.subtract(part)
        }
        if (sent.compare(0) > 0) inTransit = inTransit.add(sent)
    }
    const found = out
        .filter(r => r.assetId && r.assetId !== asset.assetId)
        .map(r => ({asset: one(ASSET, {assetId: r.assetId}), cap: r.cap}))
        .filter(r => r.asset && r.asset.ownerPartyId === org)
    return {found, inTransit}
}
// The chain of a receipt's asset: [{asset, cap}], with what is in transit and whether it was cut at CHAIN_LIMIT assets.
function heldBy(asset, org, lock, state = {visited: new Set(), inTransit: toDecimal(0), cut: false}, cap = null) {
    if (state.visited.has(asset.assetId)) return []
    if (state.visited.size >= CHAIN_LIMIT) {
        state.cut = true
        return []
    }
    state.visited.add(asset.assetId)
    const current = lock ? find(ASSET, {assetId: asset.assetId}).forUpdate(true).one() : asset
    const out = [{asset: current, cap}]
    const next = successors(asset, org, cap)
    state.inTransit = state.inTransit.add(next.inTransit)
    for (const r of next.found) out.push(...heldBy(r.asset, org, lock, state, r.cap))
    return out
}
// What left a chain's own assets by issue (not those a transfer reached, which other sources also fed; a transfer itself
// stays held): to work, and otherwise (a sale, a return to a supplier).
function issuedByKind(chain) {
    const out = {run: toDecimal(0), other: toDecimal(0)}
    for (const {asset} of chain.filter(r => r.cap == null))
        for (const issue of rows("mantle.product.issuance.AssetIssuance", {assetId: asset.assetId})) {
            const quantity = toDecimal(issue.quantity ?? 0).subtract(toDecimal(issue.quantityCancelled ?? 0))
            if (quantity.compare(0) <= 0) continue
            if (
                issue.shipmentId &&
                one("mantle.shipment.Shipment", {shipmentId: issue.shipmentId})?.shipmentTypeEnumId === "ShpTpTransfer"
            )
                continue
            if (issue.workEffortId) out.run = out.run.add(quantity)
            else out.other = out.other.add(quantity)
        }
    return out
}
function measure(receipt, asset, basis) {
    const quantity = toDecimal(receipt.quantityAccepted)
    if (basis === "LcbQuantity") return {value: quantity, uomId: null}
    if (basis === "LcbValue") {
        const unit = forward().at(asset, receipt.receivedDate).unitCost
        if (unit == null) denied("COST_BASIS_MISSING", "Receipt " + receipt.assetReceiptId + " has no cost basis")
        return {value: quantity.multiply(toDecimal(unit)), uomId: null}
    }
    for (const dimension of BASIS_DIMENSIONS[basis] || []) {
        const row = rows("mantle.product.ProductUomDimension", {productId: receipt.productId, uomDimensionTypeId: dimension})
            .filter(r => r.value != null && !r.marketSegmentId)
            .sort((a, b) => a.productUomDimensionId.localeCompare(b.productUomDimensionId))[0]
        if (row) return {value: quantity.multiply(toDecimal(row.value)), uomId: row.uomId || null}
    }
    denied("BASIS_MISSING", "Product " + receipt.productId + " has no " + (basis === "LcbWeight" ? "weight" : "volume"))
}
function defaultAccount(org, type) {
    return call("mantle.ledger.LedgerServices.get#DefaultGlAccountByType", {organizationPartyId: org, glAccountTypeEnumId: type})
        .glAccountId
}
function assetAccounts(org, asset) {
    const mapping = call("mantle.ledger.AssetAutoPostServices.get#AssetTypeGlAccount", {
        organizationPartyId: org,
        assetTypeEnumId: asset.assetTypeEnumId,
        classEnumId: asset.classEnumId,
        assetId: asset.assetId
    }).assetTypeGlAccount
    return {
        assetGlAccountId: mapping?.assetGlAccountId || defaultAccount(org, "GatInventory"),
        cogsGlAccountId: mapping?.issuanceGlAccountId || defaultAccount(org, "GatCogs"),
        varianceGlAccountId: defaultAccount(org, "GatProductionVariance")
    }
}
// The allocation of a charge line over receipts, with the findings that keep it from posting.
function calculate(p, lock = false) {
    const {bill, org, scope} = billOf(p)
    if (!scope.capabilities.glPost && !scope.capabilities.apRead && !scope.capabilities.reportRead)
        denied("PERMISSION_DENIED", "Accounting read authority is required")
    const currency = lib.preference(org).baseCurrencyUomId
    const basis = p.basisEnumId || "LcbQuantity"
    if (!one("moqui.basic.Enumeration", {enumId: basis, enumTypeId: "LandedCostBasis"}))
        denied("BASIS_INVALID", "Choose quantity, value, weight or volume")
    const day = p.accountingDate ? lib.calendarDateText(p.accountingDate) : ec.l10n.format(ec.user.nowTimestamp, "yyyy-MM-dd")
    const today = ec.l10n.format(ec.user.nowTimestamp, "yyyy-MM-dd")
    if (day > today) denied("DATE_FUTURE", "A landed cost cannot be dated in the future")
    const receiptIds = [
        ...new Set(
            (Array.isArray(p.assetReceiptIds) ? p.assetReceiptIds : String(p.assetReceiptIds || "").split(","))
                .map(s => String(s).trim())
                .filter(Boolean)
        )
    ].sort()
    const request = {
        invoiceId: bill.invoiceId,
        invoiceItemSeqId: p.invoiceItemSeqId || null,
        assetReceiptIds: receiptIds,
        basisEnumId: basis,
        accountingDate: day,
        organizationPartyId: org
    }
    const findings = []
    const finding = (recordId, message) => findings.push({recordId, message})
    if (bill.currencyUomId !== currency) finding(bill.invoiceId, "The bill is not in the organization's base currency")
    const line = chargeLines(bill).find(r => r.invoiceItemSeqId === p.invoiceItemSeqId)
    if (!line) denied("CHARGE_REQUIRED", "Choose a charge line of the bill")
    if (line.allocated) finding(bill.invoiceId, "Line " + line.invoiceItemSeqId + " is already allocated")
    else if (!line.chargeGlAccountId) finding(bill.invoiceId, "Post the bill before allocating its charges")
    else if (!line.eligible) finding(bill.invoiceId, "Line " + line.invoiceItemSeqId + " is not a freight, fee or charge line")
    if (toDecimal(line.amount).compare(0) <= 0) finding(bill.invoiceId, "The charge line has no amount")
    if (!receiptIds.length) denied("RECEIPTS_REQUIRED", "Choose the receipts that carry the charge")
    if (receiptIds.length > RECEIPT_LIMIT) denied("RECEIPTS_LIMIT", "Choose at most " + RECEIPT_LIMIT + " receipts")
    try {
        books().fiscal(org, ec.l10n.parseTimestamp(day + " 12:00:00", "yyyy-MM-dd HH:mm:ss"), lock)
    } catch (error) {
        finding(bill.invoiceId, String(error.message || error))
    }
    const evidence = [{bill: lib.pick(map(bill), ["invoiceId", "statusId", "lastUpdatedStamp"]), line}]
    const measured = []
    let uomId
    for (const assetReceiptId of receiptIds)
        try {
            const receipt = one("mantle.product.receipt.AssetReceipt", {assetReceiptId})
            const asset = receipt && one(ASSET, {assetId: receipt.assetId})
            if (!asset || asset.ownerPartyId !== org)
                denied("RECEIPT_UNAVAILABLE", "Receipt " + assetReceiptId + " is not available")
            if (asset.assetTypeEnumId !== "AstTpInventory")
                denied("RECEIPT_KIND", "Receipt " + assetReceiptId + " is not inventory")
            if (receipt.acctgTransResultEnumId !== "AtrSuccess" || !toDecimal(receipt.quantityAccepted || 0).compare(0))
                denied("RECEIPT_UNPOSTED", "Receipt " + assetReceiptId + " has no posted cost basis")
            if (asset.acquireCostUomId && asset.acquireCostUomId !== currency)
                denied("RECEIPT_CURRENCY", "Receipt " + assetReceiptId + " is costed in another currency")
            const m = measure(receipt, asset, basis)
            if (measured.length && (m.uomId || null) !== (uomId || null))
                denied("BASIS_UNITS", "The receipts' products are measured in different units")
            uomId = m.uomId
            measured.push({receipt, asset, basisValue: m.value})
        } catch (error) {
            finding(assetReceiptId, String(error.message || error))
        }
    const totalBasis = measured.reduce((sum, r) => sum.add(r.basisValue), toDecimal(0))
    if (measured.length && totalBasis.compare(0) <= 0) finding(bill.invoiceId, "The receipts' basis adds up to zero")
    const allocationRows = []
    const holderShares = new Map()
    const debitRows = []
    const debit = (glAccountId, amount, assetId, productId, facilityId) => {
        if (amount.compare(0) === 0) return
        const row = debitRows.find(r => r.glAccountId === glAccountId && r.assetId === assetId)
        if (row) row.amount = row.amount.add(amount)
        else debitRows.push({glAccountId, amount, assetId, productId, facilityId: facilityId || null})
    }
    let remaining = toDecimal(line.amount)
    measured.forEach((m, index) => {
        const last = index === measured.length - 1
        const share =
            totalBasis.compare(0) > 0
                ? last
                    ? remaining
                    : lib.lib.money(toDecimal(line.amount).multiply(m.basisValue).divide(totalBasis, 12, "HALF_UP"), currency)
                : toDecimal(0)
        remaining = remaining.subtract(share)
        const accepted = toDecimal(m.receipt.quantityAccepted)
        const state = {visited: new Set(), inTransit: toDecimal(0), cut: false}
        const chain = heldBy(m.asset, org, lock, state)
        if (state.cut) finding(m.receipt.assetReceiptId, "The receipt's stock moved through more than " + CHAIN_LIMIT + " assets")
        if (state.inTransit.compare(0) > 0) finding(m.receipt.assetReceiptId, "Stock in transit: allocate after it is received")
        // each holder's quantity that can be this receipt's: its stock, at most what a transfer sent it from this chain
        const holders = chain
            .map(r => {
                const stock = toDecimal(r.asset.quantityOnHandTotal || 0)
                return {asset: r.asset, quantity: r.cap != null && stock.compare(r.cap) > 0 ? toDecimal(r.cap) : stock}
            })
            .filter(r => r.quantity.compare(0) > 0)
        let onHand = holders.reduce((sum, r) => sum.add(r.quantity), toDecimal(0))
        if (onHand.compare(accepted) > 0) onHand = accepted
        const issued = accepted.subtract(onHand)
        const onHandAmount = lib.lib.money(share.multiply(onHand).divide(accepted, 12, "HALF_UP"), currency)
        const issuedAmount = share.subtract(onHandAmount)
        const accounts = assetAccounts(org, m.asset)
        // the issued share by what took the stock: work to production variance, the rest to cost of goods sold
        const kinds = issuedByKind(chain)
        const kindTotal = kinds.run.add(kinds.other)
        const runAmount =
            kindTotal.compare(0) > 0 && issuedAmount.compare(0) !== 0
                ? lib.lib.money(issuedAmount.multiply(kinds.run).divide(kindTotal, 12, "HALF_UP"), currency)
                : toDecimal(0)
        const cogsAmount = issuedAmount.subtract(runAmount)
        if (runAmount.compare(0) !== 0 && !accounts.varianceGlAccountId)
            finding(m.receipt.assetReceiptId, "Map the production variance account")
        if (cogsAmount.compare(0) !== 0 && !accounts.cogsGlAccountId)
            finding(m.receipt.assetReceiptId, "Map the cost of goods sold account")
        debit(accounts.varianceGlAccountId, runAmount, m.asset.assetId, m.receipt.productId)
        debit(accounts.cogsGlAccountId, cogsAmount, m.asset.assetId, m.receipt.productId)
        // the on-hand share goes to the assets holding the receipt's stock, by their quantity
        let left = onHandAmount,
            leftQuantity = onHand
        for (const {asset: holder, quantity: holds} of holders) {
            if (leftQuantity.compare(0) <= 0) break
            const quantity = holds.compare(leftQuantity) > 0 ? leftQuantity : holds
            const amount =
                quantity.compare(leftQuantity) === 0
                    ? left
                    : lib.lib.money(onHandAmount.multiply(quantity).divide(onHand, 12, "HALF_UP"), currency)
            left = left.subtract(amount)
            leftQuantity = leftQuantity.subtract(quantity)
            const held = holderShares.get(holder.assetId) || {holder, amount: toDecimal(0), receiptIds: []}
            held.amount = held.amount.add(amount)
            held.receiptIds.push(m.receipt.assetReceiptId)
            holderShares.set(holder.assetId, held)
        }
        allocationRows.push({
            assetReceiptId: m.receipt.assetReceiptId,
            assetId: m.asset.assetId,
            shipmentId: m.receipt.shipmentId,
            productId: m.receipt.productId,
            productName: one("mantle.product.Product", {productId: m.receipt.productId})?.productName || m.receipt.productId,
            receivedDateText: lib.dateText(m.receipt.receivedDate),
            acceptedQuantity: accepted,
            basisValue: m.basisValue,
            basisUomId: uomId || null,
            amount: share,
            onHandQuantity: onHand,
            issuedQuantity: issued,
            onHandAmount,
            issuedAmount,
            amountUomId: currency,
            assetGlAccountId: accounts.assetGlAccountId,
            issuedGlAccountId:
                runAmount.compare(0) !== 0 && cogsAmount.compare(0) === 0
                    ? accounts.varianceGlAccountId
                    : accounts.cogsGlAccountId,
            runIssuedAmount: runAmount,
            previousUnitCost: toDecimal(m.asset.acquireCost ?? 0)
        })
        // the receipt's own asset is evidence even when it holds no stock: a sale from it changes the split
        evidence.push(lib.pick(map(m.asset), ["assetId", "quantityOnHandTotal", "acquireCost", "lastUpdatedStamp"]))
        for (const {asset, cap} of chain.slice(1))
            evidence.push(
                Object.assign(lib.pick(map(asset), ["assetId", "quantityOnHandTotal", "acquireCost", "lastUpdatedStamp"]), {
                    cap: cap == null ? null : String(cap)
                })
            )
        evidence.push(lib.pick(map(m.receipt), ["assetReceiptId", "quantityAccepted", "lastUpdatedStamp"]))
    })
    // each holding asset's new cost from the sum of its shares; the inventory posts quantity x unit change, and the
    // rounding left goes to cost of goods sold, so the stock value and the inventory account move alike
    const assetRows = []
    for (const [assetId, held] of [...holderShares.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
        const holder = held.holder
        const quantity = toDecimal(holder.quantityOnHandTotal)
        const perUnit = held.amount.divide(quantity, COST_SCALE, "HALF_UP")
        const posted = lib.lib.money(perUnit.multiply(quantity), currency)
        const accounts = assetAccounts(org, holder)
        if (!accounts.assetGlAccountId) finding(assetId, "Map the inventory account")
        const previous = toDecimal(holder.acquireCost ?? 0)
        assetRows.push({
            assetId,
            assetReceiptIds: held.receiptIds,
            productId: holder.productId,
            facilityId: holder.facilityId,
            quantity,
            amount: posted,
            previousUnitCost: previous,
            newUnitCost: previous.add(perUnit),
            assetGlAccountId: accounts.assetGlAccountId
        })
        debit(accounts.assetGlAccountId, posted, assetId, holder.productId, holder.facilityId)
        const residue = held.amount.subtract(posted)
        if (residue.compare(0) !== 0) {
            if (!accounts.cogsGlAccountId) finding(assetId, "Map the cost of goods sold account")
            debit(accounts.cogsGlAccountId, residue, assetId, holder.productId)
        }
    }
    for (const row of allocationRows)
        row.newUnitCost = assetRows.find(r => r.assetId === row.assetId)?.newUnitCost ?? row.previousUnitCost
    // every account the posting would use must be an active posting account of the organization
    const accounts = new Set([line.chargeGlAccountId, ...debitRows.map(r => r.glAccountId)])
    for (const glAccountId of [...accounts].filter(Boolean).sort())
        try {
            lib.account(org, glAccountId, ec.l10n.parseTimestamp(day + " 12:00:00", "yyyy-MM-dd HH:mm:ss"))
        } catch (error) {
            finding(glAccountId, "Account " + glAccountId + " is not an active posting account of the organization")
        }
    const total = allocationRows.reduce((sum, r) => sum.add(r.amount), toDecimal(0))
    return {
        request,
        bill,
        line,
        currency,
        chargeGlAccountId: line.chargeGlAccountId,
        allocationRows,
        assetRows,
        debitRows,
        findings,
        complete: findings.length === 0 && allocationRows.length > 0,
        totalAmount: total,
        amountUomId: currency,
        inputFingerprint: lib.hash({
            request,
            evidence,
            allocationRows: allocationRows.map(r =>
                lib.pick(r, [
                    "assetReceiptId",
                    "amount",
                    "onHandQuantity",
                    "onHandAmount",
                    "issuedAmount",
                    "runIssuedAmount",
                    "assetGlAccountId",
                    "issuedGlAccountId"
                ])
            ),
            assetRows: assetRows.map(r => lib.pick(r, ["assetId", "amount", "newUnitCost", "assetGlAccountId"])),
            debitRows: debitRows.map(r => lib.pick(r, ["glAccountId", "amount", "assetId"]))
        })
    }
}
function shape(out) {
    return {
        organizationPartyId: out.request.organizationPartyId,
        invoiceId: out.request.invoiceId,
        invoiceItemSeqId: out.request.invoiceItemSeqId,
        basisEnumId: out.request.basisEnumId,
        accountingDate: out.request.accountingDate,
        assetReceiptIds: out.request.assetReceiptIds.join(","),
        allocationRows: out.allocationRows,
        findings: out.findings,
        complete: out.complete,
        totalAmount: out.totalAmount,
        amountUomId: out.amountUomId,
        chargeGlAccountId: out.chargeGlAccountId,
        inputFingerprint: out.inputFingerprint
    }
}
function preview(p) {
    return shape(calculate(p))
}
function post(p) {
    const {org, scope} = billOf(p)
    if (!scope.capabilities.glPost) denied("PERMISSION_DENIED", "Accounting glPost authority is required")
    const why = lib.reason(p)
    if (!p.inputFingerprint) denied("PREVIEW_REQUIRED", "Preview the allocation before posting it")
    const requestKey = {
        invoiceId: p.invoiceId,
        invoiceItemSeqId: p.invoiceItemSeqId,
        inputFingerprint: p.inputFingerprint,
        changeReason: why
    }
    const op = lib.lib.operation(p, "landed-cost", org, requestKey)
    const before = lib.lib.previous(op)
    if (before) return before
    // the organization, then the bill, then the receipts' assets: the order every landed cost locks in
    find("mantle.party.Party", {partyId: org}).forNoKeyUpdate(true).one()
    find("mantle.account.invoice.Invoice", {invoiceId: p.invoiceId}).forUpdate(true).one()
    if (rows(ALLOCATION, {invoiceId: p.invoiceId, invoiceItemSeqId: p.invoiceItemSeqId, statusId: "LcaPosted"}).length)
        denied("ALREADY_ALLOCATED", "This charge line is already allocated")
    const out = calculate(p, true)
    if (out.inputFingerprint !== p.inputFingerprint) denied("STALE_PREVIEW", "The receipts or the charge changed; preview again")
    if (!out.complete) denied("ALLOCATION_INCOMPLETE", out.findings.map(f => f.message).join("; ") || "Nothing to allocate")
    // today's landed cost is dated now, so a later revaluation or movement of today follows it; an earlier day at noon
    const stamp =
        out.request.accountingDate === ec.l10n.format(ec.user.nowTimestamp, "yyyy-MM-dd")
            ? ec.user.nowTimestamp
            : ec.l10n.parseTimestamp(out.request.accountingDate + " 12:00:00", "yyyy-MM-dd HH:mm:ss")
    const transaction = call("mantle.ledger.LedgerServices.create#AcctgTrans", {
        organizationPartyId: org,
        acctgTransTypeEnumId: "AttLandedCost",
        transactionDate: stamp,
        accountingDate: out.request.accountingDate,
        amountUomId: out.currency,
        invoiceId: out.bill.invoiceId,
        otherPartyId: out.bill.fromPartyId,
        description: "Landed cost of bill " + out.bill.invoiceId + " line " + out.line.invoiceItemSeqId + ": " + why
    })
    const acctgTransId = transaction.acctgTransId
    const entry = values =>
        call("mantle.ledger.LedgerServices.create#AcctgTransEntry", Object.assign({acctgTransId, description: why}, values))
    for (const row of out.debitRows)
        entry({
            glAccountId: row.glAccountId,
            debitCreditFlag: "D",
            amount: row.amount,
            assetId: row.assetId,
            productId: row.productId,
            facilityId: row.facilityId
        })
    entry({
        glAccountId: out.chargeGlAccountId,
        debitCreditFlag: "C",
        amount: out.totalAmount,
        invoiceItemSeqId: out.line.invoiceItemSeqId
    })
    call("mantle.ledger.LedgerServices.post#AcctgTrans", {acctgTransId})
    const posted = one("mantle.ledger.transaction.AcctgTrans", {acctgTransId})
    if (posted?.isPosted !== "Y")
        denied("POSTING_REFUSED", posted?.postingFailureMessage || "The landed cost did not post to the ledger")
    const now = ec.user.nowTimestamp
    for (const row of out.assetRows) {
        if (row.amount.compare(0) === 0) continue
        forward().apply(row.assetId, row.newUnitCost, why)
        call("create#mantle.product.asset.AssetBookEvent", {
            assetId: row.assetId,
            productId: row.productId,
            organizationPartyId: org,
            facilityId: row.facilityId,
            eventTypeEnumId: "AbeLandedCost",
            eventDate: stamp,
            quantity: row.quantity,
            previousUnitCost: row.previousUnitCost,
            newUnitCost: row.newUnitCost,
            unitCostUomId: out.currency,
            amount: row.amount,
            amountUomId: out.currency,
            acctgTransId,
            assetGlAccountId: row.assetGlAccountId,
            offsetGlAccountId: out.chargeGlAccountId,
            operationKey: op.operationKey,
            postedByUserId: ec.user.userId,
            postedDate: now,
            changeReason: why
        })
    }
    const allocationIds = []
    for (const row of out.allocationRows)
        allocationIds.push(
            call("create#" + ALLOCATION, {
                organizationPartyId: org,
                invoiceId: out.bill.invoiceId,
                invoiceItemSeqId: out.line.invoiceItemSeqId,
                assetReceiptId: row.assetReceiptId,
                assetId: row.assetId,
                shipmentId: row.shipmentId,
                productId: row.productId,
                statusId: "LcaPosted",
                basisEnumId: out.request.basisEnumId,
                basisValue: row.basisValue,
                amount: row.amount,
                onHandQuantity: row.onHandQuantity,
                issuedQuantity: row.issuedQuantity,
                onHandAmount: row.onHandAmount,
                issuedAmount: row.issuedAmount,
                amountUomId: out.currency,
                previousUnitCost: row.previousUnitCost,
                newUnitCost: row.newUnitCost,
                assetGlAccountId: row.assetGlAccountId,
                issuedGlAccountId: row.issuedGlAccountId,
                chargeGlAccountId: out.chargeGlAccountId,
                accountingDate: out.request.accountingDate,
                acctgTransId,
                operationKey: op.operationKey,
                postedByUserId: ec.user.userId,
                postedDate: now,
                changeReason: why
            }).landedCostAllocationId
        )
    const result = {acctgTransId, landedCostAllocationIds: allocationIds, totalAmount: String(out.totalAmount)}
    lib.lib.complete(op, "mantle.ledger.transaction.AcctgTrans", acctgTransId, result)
    return Object.assign(result, {alreadyApplied: false})
}

// Cost data repair: the organization's inventory assets of a product (and facility) get a new acquire cost and their
// receipts, issues and count variances are reposted, when every posted transaction of those assets is in an open period.
function repair(p) {
    const s = lib.organization(p, "admin")
    const org = s.organizationPartyId
    const why = lib.reason(p)
    if (!p.productId) denied("PRODUCT_REQUIRED", "Choose a product")
    let cost
    try {
        cost = toDecimal(p.acquireCost)
    } catch (_) {
        denied("COST_INVALID", "Enter the acquire cost")
    }
    if (cost == null || cost.compare(0) < 0) denied("COST_INVALID", "The acquire cost must be zero or more")
    if (p.facilityId) lib.dimensions(org, {facilityId: p.facilityId})
    const request = {productId: p.productId, facilityId: p.facilityId || null, acquireCost: String(cost), why}
    const op = lib.lib.operation(p, "cost-data-repair", org, request)
    const before = lib.lib.previous(op)
    if (before) return before
    find("mantle.party.Party", {partyId: org}).forNoKeyUpdate(true).one()
    let query = find(ASSET, {ownerPartyId: org, productId: p.productId, assetTypeEnumId: "AstTpInventory"})
    if (p.facilityId) query = query.condition("facilityId", p.facilityId)
    const assets = Array.from(query.orderBy("assetId").forUpdate(true).list())
    if (!assets.length) denied("ASSETS_NONE", "The organization holds no inventory of this product")
    // a repair reposts receipts and issues at the new cost, and does not know the forward cost changes a revaluation or
    // a landed cost posted beside them: refused, naming those transactions, so they are reversed first
    const bookEvents = Array.from(
        find("mantle.product.asset.AssetBookEvent")
            .condition(
                "assetId",
                "in",
                assets.map(a => a.assetId)
            )
            .condition("eventTypeEnumId", "in", ["AbeInventoryRevaluation", "AbeLandedCost"])
            .orderBy("acctgTransId")
            .list()
    )
    if (bookEvents.length)
        denied(
            "BOOK_EVENTS",
            "The product's stock has revaluation or landed cost postings (transactions " +
                [...new Set(bookEvents.map(r => r.acctgTransId))].join(", ") +
                "); a repair would leave them wrong, so it is unavailable for this product until those postings can be reversed"
        )
    const posted = Array.from(
        find("mantle.ledger.transaction.AcctgTrans", {organizationPartyId: org, isPosted: "Y"})
            .condition(
                "assetId",
                "in",
                assets.map(a => a.assetId)
            )
            .selectField("transactionDate")
            .list()
    )
    const days = [...new Set(posted.map(r => ec.l10n.format(r.transactionDate, "yyyy-MM-dd")))].sort()
    for (const day of days)
        try {
            books().fiscal(org, ec.l10n.parseTimestamp(day + " 12:00:00", "yyyy-MM-dd HH:mm:ss"), true)
        } catch (error) {
            denied("PERIOD_CLOSED", "The product's postings of " + day + " are in a closed period: " + error.message)
        }
    const currency = lib.preference(org).baseCurrencyUomId
    const now = ec.user.nowTimestamp
    for (const asset of assets) {
        const previous = asset.acquireCost
        call("mantle.product.AssetServices.update#AssetAcquireCost", {assetId: asset.assetId, acquireCost: cost})
        call("create#mantle.product.asset.AssetBookEvent", {
            assetId: asset.assetId,
            productId: asset.productId,
            organizationPartyId: org,
            facilityId: asset.facilityId,
            eventTypeEnumId: "AbeCostDataRepair",
            eventDate: now,
            quantity: asset.quantityOnHandTotal,
            previousUnitCost: previous,
            newUnitCost: cost,
            unitCostUomId: asset.acquireCostUomId || currency,
            operationKey: op.operationKey,
            postedByUserId: ec.user.userId,
            postedDate: now,
            changeReason: why
        })
    }
    const result = {repairedCount: assets.length, assetIds: assets.map(a => a.assetId)}
    lib.lib.complete(op, ASSET, assets[0].assetId, result)
    return Object.assign(result, {alreadyApplied: false})
}

const operations = {sources, preview, post, repair}
;({
    execute: (op, p) => {
        if (!operations[op]) throw new Error("Unknown asset cost operation " + op)
        return operations[op](p)
    }
})
