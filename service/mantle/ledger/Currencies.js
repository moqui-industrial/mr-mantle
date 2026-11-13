// Currencies (AC-16, AC-19): the rate CSV import, the provider rate proposals (refresh#Rates and their acceptance), the
// rate in effect for a day, and base-currency posting: post#AcctgTrans converts a transaction from its document's currency
// to the organization's base currency (convert), and post#PaymentApplication converts an application at its documents'
// rates and books the realized difference (convertApplication). store#Rate and store#Currency are inline XML Actions in
// CurrencyServices.xml.
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/AccountingPolicy.js")
const {find, one, rows, map, ms, call, denied} = lib
const T = "mantle.ledger.transaction.AcctgTrans",
    E = "mantle.ledger.transaction.AcctgTransEntry",
    PROPOSAL = "mantle.ledger.config.CurrencyRateProposal"
const FX_TYPES = ["GatForExGain", "GatForExLoss"]
// the transaction types of post#PaymentApplication's postings
const APPLICATION_TYPES = ["AttOutgoingPaymentAp", "AttIncomingPaymentAp", "AttPaymentInOutAppl", "AttInvoiceInOutAppl"]
// The decimal text of a rate: up to 12 places, without trailing zeros.
function rateText(value) {
    const text = String(toDecimal(value).setScale(12, "HALF_UP"))
    return text.includes(".") ? text.replace(/0+$/, "").replace(/\.$/, "") : text
}
// The conversion row of a pair in effect at a time: the latest start at or before it, not ended by then.
function effective(uomId, toUomId, at) {
    const cf = ec.entity.conditionFactory
    return Array.from(
        find("moqui.basic.UomConversion", {uomId, toUomId})
            .condition(
                cf.makeCondition(
                    [cf.makeCondition("fromDate", "less-equals", at), cf.makeCondition("fromDate", "is-null", null)],
                    "or"
                )
            )
            .orderBy("-fromDate")
            .list()
    ).find(row => row.thruDate == null || ms(row.thruDate) > ms(at))
}
// The rate of one fromUomId in toUomId on a calendar day (the last in effect that day, in the user's zone): the pair's own
// dated rate, else the inverse of the opposite pair's; null when there is none. {rate, rateDate, rateSource}
function rateOn(fromUomId, toUomId, day) {
    if (!fromUomId || !toUomId || !day) return null
    if (fromUomId === toUomId) return {rate: toDecimal(1), rateDate: null, rateSource: "Same currency"}
    const at = ec.l10n.parseTimestamp(day + " 23:59:59.999", "yyyy-MM-dd HH:mm:ss.SSS")
    const direct = effective(fromUomId, toUomId, at)
    if (direct && direct.conversionFactor != null)
        return {
            rate: toDecimal(rateText(String(direct.conversionFactor))),
            rateDate: direct.fromDate,
            rateSource: direct.rateSource || "Manual"
        }
    const inverse = effective(toUomId, fromUomId, at)
    if (inverse && inverse.conversionFactor != null && Number(inverse.conversionFactor) > 0)
        return {
            rate: toDecimal(rateText(toDecimal(1).divide(toDecimal(String(inverse.conversionFactor)), 12, "HALF_UP"))),
            rateDate: inverse.fromDate,
            rateSource: (inverse.rateSource || "Manual") + " (inverse)"
        }
    return null
}
function missingText(fromUomId, toUomId, day) {
    return "No exchange rate from " + fromUomId + " to " + toUomId + " on " + day
}
// A decimal rate text that is a positive number, else null (F422).
function positiveRate(text) {
    if (text == null || !/^\d+(\.\d+)?$/.test(String(text).trim())) return null
    const value = toDecimal(String(text).trim())
    return value.compare(0) > 0 ? value : null
}
const INVOICE_TYPES = [
    "AttSalesInvoice",
    "AttVendRtnInvoice",
    "AttPurchaseInvoice",
    "AttCustRtnInvoice",
    "AttCreditMemo",
    "AttVendCreditMemo",
    "AttPayrollInvoice",
    "AttTaxInvoice",
    "AttGarnishmentInvoice",
    "AttCommissionInvoice"
]
const CASH_TYPES = ["AttPayment", "AttDisbursement", "AttReceipt", "AttIncomingPayment", "AttOutgoingPayment"]
// Whether a document has a transaction depending on its kept rate: an unreversed posting of its own, of an adjustment or
// of an application (posted or held), other than the one being converted.
function hasDependents(kind, id, org, exceptTxId) {
    const cf = ec.entity.conditionFactory
    const fields = kind === "invoice" ? ["invoiceId", "toInvoiceId"] : ["paymentId", "toPaymentId"]
    let q = find(T, {organizationPartyId: org})
        .condition(
            cf.makeCondition(
                fields.map(field => cf.makeCondition(field, "equals", id)),
                "or"
            )
        )
        .condition("reversedByAcctgTransId", "is-null", null)
        .condition("reverseOfAcctgTransId", "is-null", null)
    if (exceptTxId) q = q.condition("acctgTransId", "not-equals", exceptTxId)
    return !!q.limit(1).one()
}
// The rate a document posts at in an organization's base currency, kept on the document so its adjustments and
// applications use it; null for a document in the base currency or with no rate. The kept rate stands while anything
// depends on it, or when it was chosen (no rate date) or taken for the document's book day; otherwise (a re-post after
// its postings were reversed, its book day changed) and when the base currency changed, the rate of the book day is
// taken again (F421). A later rate change affects later documents only.
function documentRate(kind, id, organizationPartyId, exceptTxId = null, keep = true) {
    const base = lib.preference(organizationPartyId).baseCurrencyUomId
    const invoice = kind === "invoice"
    const entity = invoice ? "mantle.account.invoice.Invoice" : "mantle.account.payment.Payment"
    const key = invoice ? "invoiceId" : "paymentId"
    const record = id ? one(entity, {[key]: id}) : null
    const currency = record && (invoice ? record.currencyUomId : record.amountUomId)
    if (!record || !base || !currency || currency === base) return null
    const day = lib.lib.bookDay(record.accountingDate, invoice ? record.invoiceDate : record.effectiveDate)
    const keptRate = record.exchangeRateToUomId === base ? positiveRate(record.exchangeRate) : null
    const kept = keptRate && {
        exchangeRate: rateText(keptRate),
        exchangeRateDate: record.exchangeRateDate,
        exchangeRateSource: record.exchangeRateSource
    }
    if (
        kept &&
        (!record.exchangeRateDate ||
            ec.l10n.format(record.exchangeRateDate, "yyyy-MM-dd") === day ||
            hasDependents(kind, id, organizationPartyId, exceptTxId))
    )
        return kept
    const found = rateOn(currency, base, day)
    if (!found) return kept || null
    const out = {exchangeRate: rateText(found.rate), exchangeRateDate: found.rateDate, exchangeRateSource: found.rateSource}
    if (keep && (!kept || kept.exchangeRate !== out.exchangeRate || record.exchangeRateSource !== out.exchangeRateSource))
        call("update#" + entity, Object.assign({[key]: id, exchangeRateToUomId: base}, out))
    return out
}
// The rate an asset's cost converts at (F417): the one its first posting kept on the asset (its receipt's), else the rate
// of its acquisition day, then kept; so its receipt, issues and variances post at one rate and its inventory account
// clears. Null when there is none.
function assetRate(asset, base, fallbackDay) {
    const keptRate = asset.exchangeRateToUomId === base ? positiveRate(asset.exchangeRate) : null
    if (keptRate) return {rate: keptRate, rateDate: asset.exchangeRateDate, rateSource: asset.exchangeRateSource}
    const day = lib.lib.bookDay(null, asset.acquiredDate || asset.receivedDate) || fallbackDay
    const found = rateOn(asset.acquireCostUomId, base, day)
    if (!found) return null
    call("update#mantle.product.asset.Asset", {
        assetId: asset.assetId,
        exchangeRate: rateText(found.rate),
        exchangeRateDate: found.rateDate,
        exchangeRateSource: found.rateSource,
        exchangeRateToUomId: base
    })
    return found
}
// Each line's amount in the base currency at the rate, rounded to it; each side is trued up on its largest line to the
// side's total at the rate, so a single control line holds exactly its document total at the rate.
function convertLines(lines, rate, base) {
    const out = lines.map(line => {
        const original = line.amount == null ? null : toDecimal(line.amount)
        return {line, original, amount: original == null ? null : lib.lib.money(original.multiply(rate), base)}
    })
    for (const flag of ["D", "C"]) {
        const side = out.filter(row => row.line.debitCreditFlag === flag && row.original != null)
        if (!side.length) continue
        const target = lib.lib.money(side.reduce((sum, row) => sum.add(row.original), toDecimal(0)).multiply(rate), base)
        const difference = target.subtract(side.reduce((sum, row) => sum.add(row.amount), toDecimal(0)))
        if (difference.isZero()) continue
        const largest = side.reduce((best, row) => (row.original.abs().compare(best.original.abs()) > 0 ? row : best))
        largest.amount = largest.amount.add(difference)
    }
    return out
}
function writeLines(converted) {
    for (const row of converted) {
        if (row.original == null) continue
        call("update#" + E, {
            acctgTransId: row.line.acctgTransId,
            acctgTransEntrySeqId: row.line.acctgTransEntrySeqId,
            amount: row.amount,
            originalCurrencyAmount: row.original
        })
    }
}
// The rate a transaction converts at, {rate, rateDate, rateSource} or {missing, message}: the one it carries; a
// document's own posting at its document's rate (kept on the document, F423); a posting of an asset's cost at the
// asset's rate (F417), refused when it holds another currency or several assets' costs; else the rate of its book day.
function transactionRate(tx, base, lines = null, keep = true) {
    const carried = positiveRate(tx.exchangeRate)
    if (carried) return {rate: carried, rateDate: tx.exchangeRateDate, rateSource: tx.exchangeRateSource}
    const day = lib.postingDay(tx)
    const missing = message => ({missing: true, message: message || missingText(tx.amountUomId, base, day)})
    const own =
        tx.invoiceId && !tx.paymentId && !tx.paymentApplicationId && INVOICE_TYPES.includes(tx.acctgTransTypeEnumId)
            ? ["invoice", tx.invoiceId]
            : tx.paymentId && !tx.paymentApplicationId && CASH_TYPES.includes(tx.acctgTransTypeEnumId)
              ? ["payment", tx.paymentId]
              : null
    if (own && !tx.reverseOfAcctgTransId) {
        const found = keep ? documentRate(own[0], own[1], tx.organizationPartyId, tx.acctgTransId) : null
        if (found)
            return {rate: toDecimal(found.exchangeRate), rateDate: found.exchangeRateDate, rateSource: found.exchangeRateSource}
        if (keep) return missing()
    }
    if ((tx.assetReceiptId || tx.assetIssuanceId || tx.physicalInventoryId) && !tx.reverseOfAcctgTransId) {
        const lineAssets = [...new Set((lines || rows(E, {acctgTransId: tx.acctgTransId})).map(l => l.assetId).filter(Boolean))]
        const assetId = tx.assetId || (lineAssets.length === 1 ? lineAssets[0] : null)
        const asset = assetId ? one("mantle.product.asset.Asset", {assetId}) : null
        if (!asset || asset.acquireCostUomId !== tx.amountUomId)
            return missing(
                "ASSET_CURRENCY: An inventory posting in " + tx.amountUomId + " converts only at its asset's cost rate"
            )
        const keptRate = asset.exchangeRateToUomId === base ? positiveRate(asset.exchangeRate) : null
        if (!keep) return keptRate || rateOn(asset.acquireCostUomId, base, day) ? {rate: keptRate} : missing()
        return assetRate(asset, base, day) || missing()
    }
    return rateOn(tx.amountUomId, base, day) || missing()
}
// Whether an unposted transaction in another currency would convert, without changing it (verifyOnly and the guard).
function convertible(p) {
    const tx = one(T, {acctgTransId: p.acctgTransId})
    const base = tx && lib.preference(tx.organizationPartyId).baseCurrencyUomId
    if (!tx || !base || !tx.amountUomId || tx.amountUomId === base) return {missing: false}
    // an application's posting is checked as convertApplication converts it: its shape, documents' rates, accounts
    if (APPLICATION_TYPES.includes(tx.acctgTransTypeEnumId) && tx.paymentApplicationId && !tx.reverseOfAcctgTransId) {
        const checked = convertApplication({acctgTransId: tx.acctgTransId, verifyOnly: true})
        return checked.missing ? {missing: true, message: checked.message} : {missing: false}
    }
    const found = transactionRate(tx, base, null, false)
    return found.missing ? found : {missing: false}
}
// post#AcctgTrans: an unposted transaction in another currency than its organization's base currency is converted to
// it, at the rate the transaction carries (its document's, which the auto-post services pass) or else the rate of its book
// day; amountUomId becomes the base currency, originalCurrencyUomId and each line's originalCurrencyAmount keep the
// document's. A transaction with no rate is left as it is and answered missing, for the posting guard to refuse or the
// error journal to hold.
function convert(p) {
    const initial = one(T, {acctgTransId: p.acctgTransId})
    if (!initial || initial.isPosted === "Y") return {converted: false}
    const base = lib.preference(initial.organizationPartyId).baseCurrencyUomId
    if (!base || !initial.amountUomId || initial.amountUomId === base) return {converted: false}
    // the posting guard's lock order: the organization, then the transaction
    find("mantle.party.Party", {partyId: initial.organizationPartyId}).forNoKeyUpdate(true).one()
    const tx = find(T, {acctgTransId: p.acctgTransId}).forUpdate(true).one()
    if (tx.isPosted === "Y" || tx.amountUomId === base) return {converted: false}
    // an application's posting held in the error journal and posted again books its realized difference (F418); the
    // organization and the transaction are locked above, before the hand-off
    if (APPLICATION_TYPES.includes(tx.acctgTransTypeEnumId) && tx.paymentApplicationId && !tx.reverseOfAcctgTransId)
        return convertApplication({acctgTransId: tx.acctgTransId})
    const lines = Array.from(find(E, {acctgTransId: tx.acctgTransId}).orderBy("acctgTransEntrySeqId").list())
    const found = transactionRate(tx, base, lines)
    if (found.missing) return {converted: false, missing: true, message: found.message}
    writeLines(
        tx.acctgTransTypeEnumId === "AttInvoiceAdjust" && tx.invoiceId && !tx.reverseOfAcctgTransId
            ? convertAdjustment(tx, lines, found.rate, base)
            : convertLines(lines, found.rate, base)
    )
    call("update#" + T, {
        acctgTransId: tx.acctgTransId,
        amountUomId: base,
        originalCurrencyUomId: tx.amountUomId,
        exchangeRate: rateText(found.rate),
        exchangeRateDate: found.rateDate,
        exchangeRateSource: found.rateSource
    })
    return {converted: true}
}
// An invoice adjustment's lines (F419): its control line (the invoice's receivable or payable account) is what brings the
// invoice's posted control total to its total after the adjustment at the rate, as an application clears (F413); the
// largest line of the other side takes the rounding, so the transaction balances.
function convertAdjustment(tx, lines, rate, base) {
    const out = convertLines(lines, rate, base)
    const invoice = one("mantle.account.invoice.Invoice", {invoiceId: tx.invoiceId})
    const control = call("mantle.ledger.InvoiceAutoPostServices.get#InvoiceTypeTransType", {
        invoiceTypeEnumId: invoice.invoiceTypeEnumId,
        organizationPartyId: tx.organizationPartyId,
        isPayable: invoice.toPartyId === tx.organizationPartyId ? "Y" : "N"
    }).glAccountId
    const controlRows = out.filter(row => row.line.glAccountId === control && row.original != null)
    if (!control || controlRows.length !== 1) return out
    const row = controlRows[0],
        sign = row.line.debitCreditFlag === "D" ? 1 : -1
    let priorDoc = toDecimal(0),
        priorBase = toDecimal(0)
    for (const posting of find(T, {organizationPartyId: tx.organizationPartyId, invoiceId: tx.invoiceId, isPosted: "Y"})
        .condition("acctgTransTypeEnumId", "in", INVOICE_TYPES.concat(["AttInvoiceAdjust"]))
        .condition("originalCurrencyUomId", "is-not-null", null)
        .condition("reversedByAcctgTransId", "is-null", null)
        .condition("reverseOfAcctgTransId", "is-null", null)
        .condition("paymentId", "is-null", null)
        .condition("paymentApplicationId", "is-null", null)
        .orderBy("acctgTransId")
        .list())
        for (const line of rows(E, {acctgTransId: posting.acctgTransId}).filter(l => l.glAccountId === control)) {
            const lineSign = line.debitCreditFlag === "D" ? 1 : -1
            priorDoc = priorDoc.add(toDecimal(line.originalCurrencyAmount ?? 0).multiply(lineSign))
            priorBase = priorBase.add(toDecimal(line.amount ?? 0).multiply(lineSign))
        }
    const target = lib.lib
        .money(priorDoc.add(row.original.multiply(sign)).multiply(rate), base)
        .subtract(priorBase)
        .multiply(sign)
    const difference = target.subtract(row.amount)
    if (difference.isZero()) return out
    row.amount = target
    const other = out.filter(r => r.line.debitCreditFlag !== row.line.debitCreditFlag && r.original != null)
    if (other.length) {
        const largest = other.reduce((best, r) => (r.original.abs().compare(best.original.abs()) > 0 ? r : best))
        largest.amount = largest.amount.add(difference)
    }
    return out
}
// The document of each line of an application's posting: the first line is its base record's (the payment, else the
// invoice), the second the other document's (the invoice, the to payment or the to invoice).
function applicationDocuments(tx) {
    return tx.paymentId
        ? [["payment", tx.paymentId], tx.invoiceId ? ["invoice", tx.invoiceId] : ["payment", tx.toPaymentId]]
        : [
              ["invoice", tx.invoiceId],
              ["invoice", tx.toInvoiceId]
          ]
}
// What the organization's earlier converted application postings cleared of a document: in its own currency and in the
// base currency, from the document's line of each posted, unreversed one.
function cleared(kind, id, tx) {
    const cf = ec.entity.conditionFactory
    const fields = kind === "invoice" ? ["invoiceId", "toInvoiceId"] : ["paymentId", "toPaymentId"]
    const postings = Array.from(
        find(T, {organizationPartyId: tx.organizationPartyId, isPosted: "Y"})
            .condition(
                cf.makeCondition(
                    fields.map(field => cf.makeCondition(field, "equals", id)),
                    "or"
                )
            )
            .condition("acctgTransTypeEnumId", "in", APPLICATION_TYPES)
            .condition("originalCurrencyUomId", "is-not-null", null)
            .condition("reversedByAcctgTransId", "is-null", null)
            .condition("reverseOfAcctgTransId", "is-null", null)
            .condition("acctgTransId", "not-equals", tx.acctgTransId)
            .orderBy("acctgTransId")
            .list()
    )
    let original = toDecimal(0),
        baseAmount = toDecimal(0)
    for (const posting of postings) {
        const index = applicationDocuments(posting).findIndex(([k, d]) => k === kind && d === id)
        const lines = rows(E, {acctgTransId: posting.acctgTransId})
            .filter(line => !FX_TYPES.includes(line.glAccountTypeEnumId))
            .sort((a, b) => a.acctgTransEntrySeqId.localeCompare(b.acctgTransEntrySeqId))
        const line = lines[index]
        if (!line || line.originalCurrencyAmount == null) continue
        original = original.add(toDecimal(line.originalCurrencyAmount))
        baseAmount = baseAmount.add(toDecimal(line.amount ?? 0))
    }
    return {original, baseAmount}
}
// post#PaymentApplication: an application posting in another currency than the organization's base currency is
// converted line by line at its documents' rates. Each document's line is what brings its cleared total to the cleared
// amount at its rate (so a document applied in full clears exactly what it posted), and the difference between the two
// documents' lines is the realized exchange difference, booked to GatForExGain (a credit) or GatForExLoss (a debit).
// Answers missing (with the reason) when a document has no rate or the exchange account is not mapped; the caller
// then refuses or sends the posting to the error journal.
// With p.verifyOnly it answers the same refusals and writes nothing (post#AcctgTrans verifyOnly and the guard).
function convertApplication(p) {
    const keep = !p.verifyOnly
    const tx = one(T, {acctgTransId: p.acctgTransId})
    if (!tx || tx.isPosted === "Y") return {converted: false}
    const org = tx.organizationPartyId,
        base = lib.preference(org).baseCurrencyUomId
    if (!base || !tx.amountUomId || tx.amountUomId === base) return {converted: false}
    const lines = Array.from(find(E, {acctgTransId: tx.acctgTransId}).orderBy("acctgTransEntrySeqId").list())
    if (lines.length !== 2)
        return {converted: false, missing: true, code: "APPLICATION_SHAPE", message: "An application posting needs two lines"}
    const documents = applicationDocuments(tx)
    const rates = documents.map(([kind, id]) => documentRate(kind, id, org, tx.acctgTransId, keep))
    const missingIndex = rates.findIndex(rate => !rate)
    if (missingIndex >= 0) {
        const [kind, id] = documents[missingIndex]
        return {
            converted: false,
            missing: true,
            code: "RATE_MISSING",
            message: "No exchange rate to " + base + " for " + kind + " " + id
        }
    }
    const converted = lines.map((line, i) => {
        const original = toDecimal(line.amount ?? 0)
        const before = cleared(documents[i][0], documents[i][1], tx)
        const target = lib.lib.money(before.original.add(original).multiply(toDecimal(rates[i].exchangeRate)), base)
        return {line, original, amount: target.subtract(before.baseAmount)}
    })
    const net = converted.reduce(
        (sum, row) => (row.line.debitCreditFlag === "D" ? sum.add(row.amount) : sum.subtract(row.amount)),
        toDecimal(0)
    )
    let exchange = null
    if (!net.isZero()) {
        const gain = net.compare(0) > 0
        const glAccountTypeEnumId = gain ? "GatForExGain" : "GatForExLoss"
        const glAccountId = call("mantle.ledger.LedgerServices.get#DefaultGlAccountByType", {
            glAccountTypeEnumId,
            organizationPartyId: org
        }).glAccountId
        if (!glAccountId)
            return {
                converted: false,
                missing: true,
                code: "MAPPING_MISSING",
                message: "Map the " + (gain ? "exchange gain" : "exchange loss") + " account"
            }
        exchange = {glAccountTypeEnumId, glAccountId, debitCreditFlag: gain ? "C" : "D", amount: net.abs()}
    }
    if (!keep) return {converted: false, missing: false}
    writeLines(converted)
    if (exchange)
        call("mantle.ledger.LedgerServices.create#AcctgTransEntry", {
            acctgTransId: tx.acctgTransId,
            debitCreditFlag: exchange.debitCreditFlag,
            amount: exchange.amount,
            originalCurrencyAmount: 0,
            glAccountTypeEnumId: exchange.glAccountTypeEnumId,
            glAccountId: exchange.glAccountId,
            description: "Realized exchange " + (exchange.debitCreditFlag === "C" ? "gain" : "loss")
        })
    call("update#" + T, {
        acctgTransId: tx.acctgTransId,
        amountUomId: base,
        originalCurrencyUomId: tx.amountUomId,
        exchangeRate: rates[0].exchangeRate,
        exchangeRateDate: rates[0].exchangeRateDate,
        exchangeRateSource: rates[0].exchangeRateSource
    })
    return {converted: true, exchangeAmount: exchange ? exchange.amount : toDecimal(0)}
}
function csv(text) {
    const result = [],
        row = []
    let value = "",
        quoted = false
    for (let i = 0; i <= text.length; i++) {
        const ch = text[i] || "\n"
        if (quoted) {
            if (ch === '"' && text[i + 1] === '"') {
                value += '"'
                i++
            } else if (ch === '"') quoted = false
            else if (i === text.length) throw new Error("CSV has an unterminated quoted field")
            else value += ch
        } else if (ch === '"' && !value) quoted = true
        else if (ch === ",") {
            row.push(value)
            value = ""
        } else if (ch === "\n") {
            row.push(value.replace(/\r$/, ""))
            if (row.some(v => v !== "")) result.push(row.slice())
            row.length = 0
            value = ""
        } else value += ch
    }
    return result
}
function importRates(p) {
    lib.organization(p, "admin")
    ratesAdmin()
    lib.reason(p)
    const text = String(p.csvText || "")
    if (!text || text.length > 2097152) throw new Error("Supply a CSV file of at most 2 MiB")
    const parsed = csv(text),
        header = parsed.shift() || [],
        fields = ["uomId", "toUomId", "fromDate", "thruDate", "conversionFactor", "rateSource"]
    if (
        header.some(h => !fields.includes(h)) ||
        fields.filter(f => f !== "thruDate").some(f => !header.includes(f)) ||
        new Set(header).size !== header.length ||
        parsed.length > 5000
    )
        throw new Error("CSV needs currency, target, effective date, factor and source headers; at most 5,000 rows")
    const results = []
    for (const [i, row] of parsed.entries()) {
        ec.message.pushErrors()
        try {
            if (row.length !== header.length) throw new Error("Column count does not match headers")
            const params = Object.assign(Object.fromEntries(header.map((h, j) => [h, row[j] || null])), {
                organizationPartyId: p.organizationPartyId,
                changeReason: p.changeReason
            })
            const out = ec.service
                .sync()
                .name("mantle.ledger.CurrencyServices.store#Rate")
                .parameters(params)
                .disableAuthz()
                .requireNewTransaction(true)
                .call()
            if (ec.message.hasError()) throw new Error(ec.message.getErrorsString())
            results.push({
                rowNumber: i + 2,
                success: true,
                uomConversionId: out.uomConversionId,
                message: out.alreadyStored ? "Already stored" : "Stored"
            })
        } catch (error) {
            ec.logger.error("Currency CSV row " + (i + 2) + ": " + error.message)
            results.push({
                rowNumber: i + 2,
                success: false,
                message: error.message
            })
        } finally {
            ec.message.clearErrors()
            ec.message.popErrors()
        }
    }
    const {importId} = lib.call("create#mantle.ledger.config.CurrencyRateImport", {
        organizationPartyId: p.organizationPartyId,
        userId: ec.user.userId,
        submittedDate: ec.user.nowTimestamp,
        resultJson: JSON.stringify(results)
    })
    return {importId, results, complete: results.every(r => r.success)}
}
// ---- provider rates (refresh#Rates): proposed, then accepted or rejected by a finance user ----
const ECB_URL = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml"
// The European Central Bank's daily reference rates: one euro in each currency, for the day the file names. Reads the
// file given (sourceText), else fetches it.
function ecbRates(p) {
    let text = p.sourceText
    if (!text) {
        const response = ec.service.rest().method("GET").uri(ECB_URL).timeout(20).call()
        const status = Number(response.getStatusCode())
        if (status < 200 || status >= 300) denied("RATE_PROVIDER_FAILED", "The European Central Bank answered HTTP " + status)
        text = response.text()
    }
    text = String(text || "")
    if (text.length > 1048576) denied("RATE_FILE_INVALID", "The rate file is larger than 1 MiB")
    const day = /<Cube\s+time=['"](\d{4}-\d{2}-\d{2})['"]/.exec(text)
    if (!day) denied("RATE_FILE_INVALID", "The rate file has no reference day")
    const rates = []
    for (const match of text.matchAll(/<Cube\s+currency=['"]([A-Z]{3})['"]\s+rate=['"]([0-9]+(?:\.[0-9]+)?)['"]/g))
        rates.push({uomId: match[1], rate: match[2]})
    if (!rates.length) denied("RATE_FILE_INVALID", "The rate file has no rates")
    return {fromUomId: "EUR", rateDay: day[1], rates, rateSource: "ECB reference rate " + day[1]}
}
// The currencies an organization deals in besides its base currency: those of its invoices and payments.
function currenciesInUse(org, base) {
    const cf = ec.entity.conditionFactory
    const sides = cf.makeCondition(
        [cf.makeCondition("fromPartyId", "equals", org), cf.makeCondition("toPartyId", "equals", org)],
        "or"
    )
    const found = new Set()
    for (const [entity, field] of [
        ["mantle.account.invoice.Invoice", "currencyUomId"],
        ["mantle.account.payment.Payment", "amountUomId"]
    ])
        for (const row of find(entity).condition(sides).selectField(field).distinct(true).list())
            if (row[field]) found.add(row[field])
    found.delete(base)
    return [...found].sort()
}
// refresh#Rates: the organization's provider (rateProviderServiceName) gives one currency's rates in the others; each
// currency the organization deals in (or each of uomIdList) gets a proposed rate to the base currency, a cross rate
// through the provider's currency. A rate already proposed or accepted for the pair and day answers that proposal.
function refreshRates(p) {
    const scope = lib.organization(p, "admin")
    const org = scope.organizationPartyId
    const pref = lib.preference(org),
        base = pref.baseCurrencyUomId
    if (!base) denied("BASE_CURRENCY_REQUIRED", "Choose the organization's base currency")
    const providerService = pref.rateProviderServiceName
    if (!providerService) denied("RATE_PROVIDER_MISSING", "Choose an exchange rate provider in the accounting preferences")
    const provider = one("moqui.basic.Enumeration", {enumTypeId: "ExchangeRateProvider", enumCode: providerService})
    if (!provider) denied("RATE_PROVIDER_MISSING", "The exchange rate provider is not a known provider")
    // the provider is asked outside any transaction (refresh#Rates has none); the proposals are written in their own (F425)
    const fetched = call(providerService, {sourceText: p.sourceText || null})
    return ec.service
        .sync()
        .name("mantle.ledger.CurrencyServices.propose#Rates")
        .parameters({
            organizationPartyId: org,
            uomIdList: p.uomIdList || null,
            fromUomId: fetched.fromUomId,
            rateDay: fetched.rateDay,
            rates: fetched.rates || [],
            rateSource: fetched.rateSource,
            providerServiceName: providerService
        })
        .disableAuthz()
        .requireNewTransaction(true)
        .call()
}
// propose#Rates: a provider's rates as proposals to the base currency, cross rates through the provider's currency.
function proposeRates(p) {
    const scope = lib.organization(p, "admin")
    const org = scope.organizationPartyId
    const base = lib.preference(org).baseCurrencyUomId
    if (!base) denied("BASE_CURRENCY_REQUIRED", "Choose the organization's base currency")
    const fetched = p,
        providerService = p.providerServiceName
    const quotes = {[fetched.fromUomId]: toDecimal(1)}
    for (const row of fetched.rates || []) {
        const value = toDecimal(String(row.rate))
        if (value.compare(0) > 0 && one("moqui.basic.Uom", {uomId: row.uomId})) quotes[row.uomId] = value
    }
    if (!quotes[base]) denied("RATE_PROVIDER_NO_BASE", "The provider has no rate for " + base)
    const wanted = (p.uomIdList && p.uomIdList.length ? [...p.uomIdList] : currenciesInUse(org, base)).filter(
        uomId => uomId !== base
    )
    const rateDate = ec.l10n.parseTimestamp(fetched.rateDay + " 00:00:00", "yyyy-MM-dd HH:mm:ss")
    const proposals = [],
        skipped = []
    for (const uomId of wanted.sort()) {
        if (!quotes[uomId]) {
            skipped.push(uomId)
            continue
        }
        const conversionFactor = rateText(quotes[base].divide(quotes[uomId], 12, "HALF_UP"))
        const earlier = Array.from(
            find(PROPOSAL, {organizationPartyId: org, uomId, toUomId: base, rateDate})
                .condition("statusId", "in", ["RateProposed", "RateAccepted"])
                .orderBy("rateProposalId")
                .list()
        )[0]
        if (earlier) {
            proposals.push(proposalRow(earlier))
            continue
        }
        const {rateProposalId} = call("create#" + PROPOSAL, {
            organizationPartyId: org,
            uomId,
            toUomId: base,
            conversionFactor,
            rateDate,
            rateSource: fetched.rateSource,
            providerServiceName: providerService,
            statusId: "RateProposed",
            fetchedDate: ec.user.nowTimestamp,
            fetchedByUserId: ec.user.userId
        })
        proposals.push(proposalRow(one(PROPOSAL, {rateProposalId})))
    }
    return {proposals, skippedUomIds: skipped, rateDay: fetched.rateDay}
}
function proposalRow(row) {
    const out = lib.display(row)
    out.statusText = {RateProposed: "Proposed", RateAccepted: "Accepted", RateRejected: "Rejected"}[row.statusId] || ""
    return out
}
// The organization's proposals still to decide, oldest day first, at most 200.
function getProposals(p) {
    const scope = lib.organization(p, "admin")
    return {
        proposals: Array.from(
            find(PROPOSAL, {organizationPartyId: scope.organizationPartyId, statusId: "RateProposed"})
                .orderBy("rateDate,uomId,rateProposalId")
                .limit(200)
                .list()
        ).map(proposalRow)
    }
}
// Exchange rates are global UomConversion rows, so every writer of an active rate (store#Rate, the CSV import, an accepted
// proposal) needs finance administration of every organization: ACCOUNTING_ADMIN, which AccountingPolicy scopes to
// every internal organization, or a system administrator; never a capability limited to some organizations (F420).
function ratesAdmin() {
    const domain = ec.resource.script("component://mr-mantle/service/mantle/product/ProductAccess.js")
    if (!(domain.systemAdmin() || lib.capabilities().admin))
        denied("PERMISSION_DENIED", "Exchange rates are shared by every organization: finance administration is required")
    // ACCOUNTING_ADMIN covers every internal organization today, so this cannot fail yet; it guards a future
    // organization-limited finance administrator, who must not set the rates every organization posts at
    const internal = find("mantle.party.PartyRole", {roleTypeId: "OrgInternal"}).count()
    if (!domain.systemAdmin() && lib.access("admin").organizationPartyIds.length < internal)
        denied("PERMISSION_DENIED", "Exchange rates need finance administration of every organization")
}
// accept#RateProposals and reject#RateProposals: each proposal decided in its own transaction, re-read under lock (the
// organization's, still proposed); an accepted one becomes an active dated rate through store#Rate. A failure is named
// in the results and the others go on.
function decideProposals(p, accept) {
    const scope = lib.organization(p, "admin")
    const ids = [...new Set((p.rateProposalIdList || []).map(String))].sort()
    if (!ids.length) denied("PROPOSAL_REQUIRED", "Choose the proposed rates")
    const changeReason = String(p.changeReason || "").trim()
    const results = []
    for (const rateProposalId of ids) {
        ec.message.pushErrors()
        try {
            const out = ec.service
                .sync()
                .name("mantle.ledger.CurrencyServices.decide#RateProposal")
                .parameters({organizationPartyId: scope.organizationPartyId, rateProposalId, accept, changeReason})
                .disableAuthz()
                .requireNewTransaction(true)
                .call()
            if (ec.message.hasError()) throw new Error(ec.message.getErrorsString())
            results.push({rateProposalId, success: true, uomConversionId: out?.uomConversionId || null})
        } catch (error) {
            ec.logger.error("Rate proposal " + rateProposalId + ": " + error.message)
            results.push({rateProposalId, success: false, message: error.message})
        } finally {
            ec.message.clearErrors()
            ec.message.popErrors()
        }
    }
    return {results, complete: results.every(row => row.success)}
}
function decideProposal(p) {
    const scope = lib.organization(p, "admin")
    if (p.accept) ratesAdmin()
    find("mantle.party.Party", {partyId: scope.organizationPartyId}).forNoKeyUpdate(true).one()
    const row = find(PROPOSAL, {rateProposalId: p.rateProposalId}).forUpdate(true).one()
    if (!row || row.organizationPartyId !== scope.organizationPartyId)
        denied("PROPOSAL_UNAVAILABLE", "The proposed rate is not available")
    if (row.statusId !== "RateProposed") denied("PROPOSAL_DECIDED", "The proposed rate was already decided")
    let uomConversionId = null
    if (p.accept) {
        uomConversionId = call("mantle.ledger.CurrencyServices.store#Rate", {
            organizationPartyId: scope.organizationPartyId,
            uomId: row.uomId,
            toUomId: row.toUomId,
            conversionFactor: toDecimal(row.conversionFactor),
            fromDate: row.rateDate,
            rateSource: row.rateSource,
            changeReason: p.changeReason || "Accepted " + row.rateSource
        }).uomConversionId
    }
    call("update#" + PROPOSAL, {
        rateProposalId: row.rateProposalId,
        statusId: p.accept ? "RateAccepted" : "RateRejected",
        decidedDate: ec.user.nowTimestamp,
        decidedByUserId: ec.user.userId,
        uomConversionId
    })
    return {uomConversionId}
}
const operations = {
    importRates,
    ecbRates,
    refreshRates,
    proposeRates,
    getProposals,
    acceptProposals: p => decideProposals(p, true),
    rejectProposals: p => decideProposals(p, false),
    decideProposal,
    convertible,
    convert,
    convertApplication
}
;({
    // the CSV reader, also for accounting setup's trial balance and open items (AccountingActivation.js)
    csv,
    // the rate in effect on a day, and the rate a document posts at (the posting guard, period close, readiness)
    rateOn,
    documentRate,
    missingText,
    ratesAdmin,
    // the rate an asset's cost keeps (F417), for a revaluation of that cost
    assetKeptRate: (asset, base) => (asset.exchangeRateToUomId === base ? positiveRate(asset.exchangeRate) : null),
    execute: (op, p) => {
        if (!operations[op]) throw new Error("Unknown currency operation " + op)
        return operations[op](p)
    }
})
