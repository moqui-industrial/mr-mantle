// A campaign's actual cost (mantle.marketing.CampaignServices store#CampaignCost and find#CampaignCosts; IronStone Marketing design
// §3 CostEntries, §14.1 CampaignCost; impl-marketing P2, F81).
//
// - A cost is manual (a description and an amount) or an Accounting source line of the campaign's organization, never both
//   (COST_SOURCE_INVALID): a purchase invoice item (the invoice billed to the organization, not cancelled), read with the caller's
//   PAYABLE_VIEW or ACCOUNTING_VIEW, or a posted ledger debit of the organization, read with ACCOUNTING_VIEW (SOURCE_FORBIDDEN
//   without it). Neither carries a campaign: the link is the CampaignCost row alone. No Accounting budget applies (F81).
// - A source line's allocations, over every campaign, never pass its amount (ALLOCATION_EXCEEDS), and one campaign counts a line
//   once (SOURCE_ALREADY_COUNTED) until that row is reversed. The amount is in the campaign's currency, which the source must be in
//   (CURRENCY_MISMATCH: no conversion is made).
// - A correction is a reversal (reversalOfCostId): a negative row with the same source, the original marked reversed
//   (ALREADY_REVERSED for a second; a reversal is never reversed). Rows are never changed or deleted otherwise.
// - MarketingCampaign.actualCost is the sum of the campaign's rows, in its currency, kept on each write; a parent's and its
//   children's are never added together.
// - An operation key, when given, answers a retry with the first result (EntityLib operation: OPERATION_KEY_CONFLICT for another
//   request).
// - A reader sees each row; a source's Accounting details only with the source's read permission (masked otherwise).
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const marketingAccess = ec.resource.script("component://mr-mantle/service/mantle/marketing/MarketingAccess.js")
const campaigns = ec.resource.script("component://mr-mantle/service/mantle/marketing/MarketingCampaigns.js")
const {find, one, rows, denied, call} = lib

const COST = "mantle.marketing.campaign.CampaignCost"
const CAMPAIGN = "mantle.marketing.campaign.MarketingCampaign"
const sourceText = {CcsManual: "Manual", CcsInvoiceItem: "Purchase invoice item", CcsLedgerEntry: "Ledger entry"}
const text = value => (value == null ? "" : String(value).trim())
const money = (value, currencyUomId) =>
    value == null ? "" : currencyUomId ? ec.l10n.formatCurrency(value, currencyUomId) || String(value) : String(value)

// The read permission of each source kind.
const readsInvoice = () => ec.user.hasPermission("PAYABLE_VIEW") || ec.user.hasPermission("ACCOUNTING_VIEW")
const readsLedger = () => ec.user.hasPermission("ACCOUNTING_VIEW")
// A source line of the organization: {eligible, currencyUomId, label}, or a refusal.
function invoiceLine(organizationPartyId, invoiceId, invoiceItemSeqId) {
    if (!readsInvoice()) denied("SOURCE_FORBIDDEN", "Reading a purchase invoice needs Accounting's payable view")
    const invoice = invoiceId ? one("mantle.account.invoice.Invoice", {invoiceId}) : null
    const item = invoice && invoiceItemSeqId ? one("mantle.account.invoice.InvoiceItem", {invoiceId, invoiceItemSeqId}) : null
    // another organization's line answers as missing
    if (!item || invoice.toPartyId !== organizationPartyId || invoice.statusId === "InvoiceCancelled")
        denied("RECORD_UNAVAILABLE", "Invoice item " + invoiceId + " " + invoiceItemSeqId + " is not available")
    const quantity = item.quantity == null ? toDecimal(1) : toDecimal(item.quantity)
    const eligible = ec.l10n.roundCurrency(toDecimal(item.amount ?? 0).multiply(quantity), invoice.currencyUomId)
    return {
        eligible,
        currencyUomId: invoice.currencyUomId,
        label: "Invoice " + invoiceId + " item " + invoiceItemSeqId + (item.description ? ": " + item.description : "")
    }
}
function ledgerLine(organizationPartyId, acctgTransId, acctgTransEntrySeqId) {
    if (!readsLedger()) denied("SOURCE_FORBIDDEN", "Reading a ledger entry needs Accounting view")
    const trans = acctgTransId ? one("mantle.ledger.transaction.AcctgTrans", {acctgTransId}) : null
    const entry =
        trans && acctgTransEntrySeqId
            ? one("mantle.ledger.transaction.AcctgTransEntry", {acctgTransId, acctgTransEntrySeqId})
            : null
    if (!entry || trans.organizationPartyId !== organizationPartyId || trans.isPosted !== "Y")
        denied("RECORD_UNAVAILABLE", "Ledger entry " + acctgTransId + " " + acctgTransEntrySeqId + " is not available")
    if (entry.debitCreditFlag !== "D") denied("SOURCE_INVALID", "A campaign's cost is a ledger debit")
    return {
        eligible: toDecimal(entry.amount ?? 0),
        currencyUomId: trans.amountUomId,
        label: "Ledger " + acctgTransId + " entry " + acctgTransEntrySeqId + (entry.description ? ": " + entry.description : "")
    }
}
// The source fields of a row and its line's conditions.
function sourceKey(row) {
    if (row.costSourceEnumId === "CcsInvoiceItem")
        return {costSourceEnumId: "CcsInvoiceItem", invoiceId: row.invoiceId, invoiceItemSeqId: row.invoiceItemSeqId}
    if (row.costSourceEnumId === "CcsLedgerEntry")
        return {
            costSourceEnumId: "CcsLedgerEntry",
            acctgTransId: row.acctgTransId,
            acctgTransEntrySeqId: row.acctgTransEntrySeqId
        }
    return null
}
// The net already allocated of a line over every campaign: the sum of its rows (a reversal cancels its row).
function allocated(key) {
    let total = toDecimal(0)
    for (const row of rows(COST, key)) total = total.add(toDecimal(row.amount ?? 0))
    return total
}
// Keeps actualCost the sum of the campaign's rows.
function refreshActual(marketingCampaignId, currencyUomId) {
    let total = toDecimal(0)
    for (const row of rows(COST, {marketingCampaignId})) total = total.add(toDecimal(row.amount ?? 0))
    call("update#" + CAMPAIGN, {
        marketingCampaignId,
        actualCost: currencyUomId ? ec.l10n.roundCurrency(total, currencyUomId) : total
    })
    return total
}

// ===== store#CampaignCost =====
function store(p) {
    const userScope = marketingAccess.scope()
    marketingAccess.requireCapability(userScope, "campaignEdit")
    const campaign = campaigns.campaignOf(userScope, p.marketingCampaignId, true)
    campaigns.requireOpen(campaign)
    const reversalOfCostId = text(p.reversalOfCostId)
    const request = {
        marketingCampaignId: campaign.marketingCampaignId,
        reversalOfCostId,
        costSourceEnumId: text(p.costSourceEnumId),
        invoiceId: text(p.invoiceId),
        invoiceItemSeqId: text(p.invoiceItemSeqId),
        acctgTransId: text(p.acctgTransId),
        acctgTransEntrySeqId: text(p.acctgTransEntrySeqId),
        amount: text(p.amount),
        description: text(p.description)
    }
    const op = text(p.operationKey) ? lib.operation(p, "MarketingCampaignCost", campaign.organizationPartyId, request) : null
    const previous = op ? lib.previous(op) : null
    if (previous) return previous
    const result = reversalOfCostId ? reverse(campaign, reversalOfCostId, p) : add(campaign, request, p)
    result.actualCost = refreshActual(campaign.marketingCampaignId, campaign.costUomId)
    if (op) lib.complete(op, COST, result.campaignCostId, {campaignCostId: result.campaignCostId})
    return result
}
function add(campaign, request, p) {
    const currencyUomId = campaign.costUomId
    if (!currencyUomId) denied("CURRENCY_REQUIRED", "Set the campaign's currency before its costs")
    const hasInvoice = !!(request.invoiceId || request.invoiceItemSeqId)
    const hasLedger = !!(request.acctgTransId || request.acctgTransEntrySeqId)
    const kind = request.costSourceEnumId || (hasInvoice ? "CcsInvoiceItem" : hasLedger ? "CcsLedgerEntry" : "CcsManual")
    // manual or one source line, never both
    if (
        (kind === "CcsManual" && (hasInvoice || hasLedger)) ||
        (hasInvoice && hasLedger) ||
        (kind === "CcsInvoiceItem" && hasLedger) ||
        (kind === "CcsLedgerEntry" && hasInvoice) ||
        !sourceText[kind]
    )
        denied("COST_SOURCE_INVALID", "A cost is manual or one Accounting line, never both")
    const amount = lib.amount(request.amount, currencyUomId)
    const fields = {
        marketingCampaignId: campaign.marketingCampaignId,
        costSourceEnumId: kind,
        costDate: p.costDate ? new Date(lib.ms(p.costDate)) : ec.user.nowTimestamp,
        amount,
        currencyUomId,
        description: request.description || null,
        operationKey: text(p.operationKey) || null,
        createdByUserId: ec.user.userId,
        createdDate: ec.user.nowTimestamp
    }
    if (kind === "CcsManual") {
        if (!request.description) denied("DESCRIPTION_REQUIRED", "Describe a manual cost")
    } else {
        const line =
            kind === "CcsInvoiceItem"
                ? invoiceLine(campaign.organizationPartyId, request.invoiceId, request.invoiceItemSeqId)
                : ledgerLine(campaign.organizationPartyId, request.acctgTransId, request.acctgTransEntrySeqId)
        if (line.currencyUomId !== currencyUomId)
            denied("CURRENCY_MISMATCH", "The line is in " + line.currencyUomId + "; the campaign's costs are in " + currencyUomId)
        const key =
            kind === "CcsInvoiceItem"
                ? {costSourceEnumId: kind, invoiceId: request.invoiceId, invoiceItemSeqId: request.invoiceItemSeqId}
                : {costSourceEnumId: kind, acctgTransId: request.acctgTransId, acctgTransEntrySeqId: request.acctgTransEntrySeqId}
        // a line is counted once by a campaign, until that row is reversed
        if (
            rows(COST, Object.assign({marketingCampaignId: campaign.marketingCampaignId}, key)).some(
                row => !row.reversalOfCostId && !row.reversedByCostId
            )
        )
            denied("SOURCE_ALREADY_COUNTED", "This line is already a cost of campaign " + campaign.marketingCampaignId)
        if (allocated(key).add(amount).compare(line.eligible) > 0)
            denied("ALLOCATION_EXCEEDS", "The line's amount is already allocated up to " + money(line.eligible, currencyUomId))
        Object.assign(fields, key)
        if (!fields.description) fields.description = line.label
    }
    const campaignCostId = call("create#" + COST, fields).campaignCostId
    return {campaignCostId}
}
function reverse(campaign, reversalOfCostId, p) {
    const original = find(COST, {campaignCostId: reversalOfCostId}).forUpdate(true).one()
    if (!original || original.marketingCampaignId !== campaign.marketingCampaignId)
        denied("RECORD_UNAVAILABLE", "Cost " + reversalOfCostId + " is not a cost of this campaign")
    if (original.reversalOfCostId) denied("COST_SOURCE_INVALID", "A reversal is not reversed; record the cost again")
    if (original.reversedByCostId) denied("ALREADY_REVERSED", "Cost " + reversalOfCostId + " is already reversed")
    const campaignCostId = call(
        "create#" + COST,
        Object.assign({}, sourceKey(original) || {costSourceEnumId: original.costSourceEnumId}, {
            marketingCampaignId: campaign.marketingCampaignId,
            costDate: ec.user.nowTimestamp,
            amount: toDecimal(original.amount ?? 0).multiply(-1),
            currencyUomId: original.currencyUomId,
            description: text(p.description) || "Reversal of " + reversalOfCostId,
            reversalOfCostId,
            operationKey: text(p.operationKey) || null,
            createdByUserId: ec.user.userId,
            createdDate: ec.user.nowTimestamp
        })
    ).campaignCostId
    call("update#" + COST, {campaignCostId: reversalOfCostId, reversedByCostId: campaignCostId})
    return {campaignCostId}
}

// ===== find#CampaignCosts and the summary =====
// A campaign's rows as of a date (created by then), newest first, each source masked without its read permission, and the
// summary: the actual cost, the budget and what is left, in the campaign's currency.
function summary(userScope, campaign, asOf = ec.user.nowTimestamp) {
    const asOfMs = lib.ms(asOf)
    const currencyUomId = campaign.costUomId
    const found = rows(COST, {marketingCampaignId: campaign.marketingCampaignId})
        .filter(row => (lib.ms(row.createdDate) ?? 0) <= asOfMs)
        .sort((a, b) => (lib.ms(b.createdDate) ?? 0) - (lib.ms(a.createdDate) ?? 0))
    const names = lib.partyNames(
        found.map(row => one("moqui.security.UserAccount", {userId: row.createdByUserId})?.partyId).filter(Boolean)
    )
    let total = toDecimal(0)
    const costs = found.map(row => {
        total = total.add(toDecimal(row.amount ?? 0))
        const readable =
            row.costSourceEnumId === "CcsManual" ||
            (row.costSourceEnumId === "CcsInvoiceItem" && readsInvoice()) ||
            (row.costSourceEnumId === "CcsLedgerEntry" && readsLedger())
        const creator = one("moqui.security.UserAccount", {userId: row.createdByUserId})
        return {
            campaignCostId: row.campaignCostId,
            costSourceEnumId: row.costSourceEnumId,
            sourceText: sourceText[row.costSourceEnumId] || row.costSourceEnumId,
            sourceRef: readable
                ? row.invoiceId
                    ? row.invoiceId + " / " + row.invoiceItemSeqId
                    : row.acctgTransId
                      ? row.acctgTransId + " / " + row.acctgTransEntrySeqId
                      : ""
                : "Not shown",
            description: readable ? row.description || "" : "An Accounting line",
            costDateText: lib.dateText(row.costDate),
            amount: row.amount,
            amountText: money(row.amount, row.currencyUomId),
            currencyUomId: row.currencyUomId,
            reversal: !!row.reversalOfCostId,
            reversed:
                !!row.reversedByCostId && (lib.ms(one(COST, {campaignCostId: row.reversedByCostId})?.createdDate) ?? 0) <= asOfMs,
            stateText: row.reversalOfCostId ? "Reversal" : row.reversedByCostId ? "Reversed" : "Counted",
            createdByName: names[creator?.partyId] || row.createdByUserId || ""
        }
    })
    const actual = currencyUomId ? ec.l10n.roundCurrency(total, currencyUomId) : total
    const budget = campaign.budgetedCost == null ? null : toDecimal(campaign.budgetedCost)
    return {
        costs,
        summary: {
            actualCost: actual,
            actualText: money(actual, currencyUomId),
            budgetText: money(budget, currencyUomId),
            remainingText: budget == null ? "" : money(budget.subtract(actual), currencyUomId),
            overBudget: budget != null && actual.compare(budget) > 0,
            costCount: costs.length
        }
    }
}
function findCosts(p) {
    const userScope = marketingAccess.scope()
    if (!userScope.capabilities.anyRead) denied("PERMISSION_DENIED", "Marketing is not open to you")
    const campaign = campaigns.campaignOf(userScope, p.marketingCampaignId)
    return summary(userScope, campaign, p.asOf ? new Date(lib.ms(p.asOf)) : ec.user.nowTimestamp)
}

const operations = {store, find: findCosts}
;({
    execute: (op, parameters) => {
        if (!Object.hasOwn(operations, op)) throw new Error("Unknown marketing cost operation " + op)
        return operations[op](parameters || {})
    },
    summary
})
