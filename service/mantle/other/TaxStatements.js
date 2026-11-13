// Tax statements (AC-08): the sales tax lines of an organization's invoices for an authority and period, a sales tax
// statement over them, the vendor 1099 run on payments of the year, and a statement's export. The writers check
// TAX_STATEMENT_EDIT and the organization, which is the statement period's party.
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const policy = ec.resource.script("component://mr-mantle/service/mantle/ledger/AccountingPolicy.js")
const {find, one, rows, call, denied} = lib
const STATEMENT = "mantle.other.tax.TaxStatement"
const salesTaxForm = "LocalSalesTaxReturn"
const vendorForm = "UsaIrs1099Misc"
// A sales invoice's tax counts once it is issued: not a draft, not cancelled.
const issuedStatuses = ["InvoiceFinalized", "InvoiceSent", "InvoiceAcked", "InvoicePmtRecvd", "InvoiceWriteOff"]
// Card and third-party network payments are reported by the network (1099-K), not on the payer's 1099-MISC.
const networkInstruments = ["PiCreditCard", "PiDebitCard", "PiPayPalAccount", "PiAmazonPay", "PiGiftCard", "PiBitcoinWallet"]
const lockParty = partyId => find("mantle.party.Party", {partyId}).forNoKeyUpdate(true).one()

// The period of a statement, which must be one of the organization's (its party).
function period(timePeriodId, organizationPartyId) {
    const timePeriod = one("mantle.party.time.TimePeriod", {timePeriodId})
    if (!timePeriod || timePeriod.partyId !== organizationPartyId)
        denied("PERIOD_UNAVAILABLE", "Choose a period of the organization")
    const info = call("mantle.party.TimeServices.get#TimePeriodInfo", {timePeriod})
    return {timePeriod, fromTimestamp: info.fromTimestamp, thruTimestamp: info.thruTimestamp}
}
function authority(taxAuthorityId) {
    const row = taxAuthorityId ? one("mantle.other.tax.TaxAuthority", {taxAuthorityId}) : null
    if (!row) denied("AUTHORITY_UNAVAILABLE", "Choose a tax authority")
    return row
}
// A statement and its organization, which the user must work in with the permission named.
function statementScope(p, need) {
    const statement = one(STATEMENT, {taxStatementId: p.taxStatementId})
    const timePeriod = statement?.timePeriodId
        ? one("mantle.party.time.TimePeriod", {timePeriodId: statement.timePeriodId})
        : null
    if (!statement || !timePeriod) denied("STATEMENT_UNAVAILABLE", "Tax statement is not available")
    const scope = policy.organization({organizationPartyId: timePeriod.partyId}, need)
    return {statement, timePeriod, organizationPartyId: scope.organizationPartyId}
}

// The issued sales invoices' tax lines of an authority in a period, oldest first: an invoice with a book day
// (accountingDate) by that calendar day within the period's days, so the zone of the user who makes the statement does
// not move an invoice to another month; an older one without it by its timestamp within the period's timestamps.
function lineRows(organizationPartyId, taxAuthorityId, dates) {
    const cf = ec.entity.conditionFactory
    const fromDay = lib.calendarDateText(dates.timePeriod.fromDate),
        thruDay = lib.calendarDateText(dates.timePeriod.thruDate)
    const inPeriod = cf.makeCondition(
        [
            cf.makeCondition(
                [
                    cf.makeCondition("accountingDate", "is-not-null", null),
                    cf.makeCondition("accountingDate", "greater-equals", fromDay),
                    cf.makeCondition("accountingDate", "less-equals", thruDay)
                ],
                "and"
            ),
            cf.makeCondition(
                [
                    cf.makeCondition("accountingDate", "is-null", null),
                    cf.makeCondition("invoiceDate", "greater-equals", dates.fromTimestamp),
                    cf.makeCondition("invoiceDate", "less-equals", dates.thruTimestamp)
                ],
                "and"
            )
        ],
        "or"
    )
    return Array.from(
        find("mantle.other.tax.InvoiceTaxLine", {fromPartyId: organizationPartyId, taxAuthorityId})
            .condition("itemTypeEnumId", "in", ["ItemSalesTax", "ItemVatTax"])
            .condition("statusId", "in", issuedStatuses)
            .condition(inPeriod)
            .orderBy("invoiceDate,invoiceId,invoiceItemSeqId")
            .list()
    )
}
function totals(lines) {
    return lines.reduce(
        (sum, line) => ({
            reportedAmount: sum.reportedAmount.add(toDecimal(line.taxableAmount ?? 0)),
            taxAmount: sum.taxAmount.add(toDecimal(line.quantity ?? 1).multiply(toDecimal(line.amount ?? 0)))
        }),
        {reportedAmount: toDecimal(0), taxAmount: toDecimal(0)}
    )
}

// find#SalesTaxLines: a statement's lines (taxStatementId) or an organization's for an authority and period.
function salesTaxLines(p) {
    let organizationPartyId, taxAuthorityId, timePeriodId
    if (p.taxStatementId) {
        const scope = statementScope(p, "read")
        organizationPartyId = scope.organizationPartyId
        taxAuthorityId = scope.statement.taxAuthorityId
        timePeriodId = scope.statement.timePeriodId
    } else {
        organizationPartyId = policy.organization(p, "read").organizationPartyId
        taxAuthorityId = authority(p.taxAuthorityId).taxAuthorityId
        timePeriodId = p.timePeriodId
    }
    const dates = period(timePeriodId, organizationPartyId)
    const lines = lineRows(organizationPartyId, taxAuthorityId, dates)
    const names = lib.partyNames(lines.map(line => line.toPartyId))
    return Object.assign(totals(lines), {
        lines: lines.map(line => {
            const shown = lib.display(line)
            return Object.assign(shown, {
                // the invoice's day is its book day when it has one, as the statement selects it
                invoiceDateText: line.accountingDate ? shown.accountingDateText : shown.invoiceDateText,
                customerName: names[line.toPartyId] || "",
                taxAmount: toDecimal(line.quantity ?? 1).multiply(toDecimal(line.amount ?? 0))
            })
        }),
        lineCount: lines.length
    })
}

// create#SalesTaxStatement: a statement of an authority's tax on the organization's invoices of a period, with its
// taxable sales, tax and line count on the LocalSalesTaxReturn form. A later one for the same period is a revision.
function createSalesTax(p) {
    const organizationPartyId = policy.organization(p, "taxEdit").organizationPartyId
    const taxAuthority = authority(p.taxAuthorityId)
    const dates = period(p.timePeriodId, organizationPartyId)
    // a retry under the same operation key answers the first statement
    let operation = null
    if (p.operationKey) {
        lockParty(organizationPartyId)
        operation = lib.operation(p, "SalesTaxStatement", organizationPartyId, {
            organizationPartyId,
            taxAuthorityId: taxAuthority.taxAuthorityId,
            timePeriodId: dates.timePeriod.timePeriodId
        })
        if (operation?.old) return lib.previous(operation)
    }
    const lines = lineRows(organizationPartyId, taxAuthority.taxAuthorityId, dates)
    const sums = totals(lines)
    const currency = policy.preference(organizationPartyId).baseCurrencyUomId
    const formMap = {
        str_period: dates.timePeriod.periodName || dates.timePeriod.timePeriodId,
        str_authority: taxAuthority.description || taxAuthority.taxAuthorityId,
        str_taxable: ec.l10n.format(sums.reportedAmount, "#,##0.00"),
        str_tax: ec.l10n.format(sums.taxAmount, "#,##0.00"),
        str_lines: String(lines.length)
    }
    const made = call("mantle.other.TaxServices.create#TaxStatement", {
        timePeriodId: dates.timePeriod.timePeriodId,
        partyId: organizationPartyId,
        taxAuthorityId: taxAuthority.taxAuthorityId,
        formId: salesTaxForm,
        formMap
    })
    call("update#" + STATEMENT, {
        taxStatementId: made.taxStatementId,
        reportedAmount: ec.l10n.roundCurrency(sums.reportedAmount, currency),
        taxAmount: ec.l10n.roundCurrency(sums.taxAmount, currency),
        lineCount: lines.length,
        createdDate: ec.user.nowTimestamp,
        createdByUserId: ec.user.userId
    })
    const result = {taxStatementId: made.taxStatementId, lineCount: lines.length, taxAmount: sums.taxAmount}
    if (operation) lib.complete(operation, STATEMENT, made.taxStatementId, result)
    return result
}

// The invoice item totals a vendor was paid in a period: each payment application to the vendor's invoices, by the
// payment's date, spread over the invoice's item types in proportion to their totals.
function paidItemTypeTotals(organizationPartyId, vendorPartyId, fromTimestamp, thruTimestamp, currency) {
    const payments = Array.from(
        find("mantle.account.payment.Payment", {fromPartyId: organizationPartyId, toPartyId: vendorPartyId})
            .condition("statusId", "in", ["PmntDelivered", "PmntConfirmed"])
            .condition(
                ec.entity.conditionFactory.makeCondition(
                    [
                        ec.entity.conditionFactory.makeCondition("paymentInstrumentEnumId", "is-null", null),
                        ec.entity.conditionFactory.makeCondition("paymentInstrumentEnumId", "not-in", networkInstruments)
                    ],
                    "or"
                )
            )
            .condition("effectiveDate", "greater-equals", fromTimestamp)
            .condition("effectiveDate", "less-equals", thruTimestamp)
            .list()
    )
    if (!payments.length) return []
    const applications = Array.from(
        find("mantle.account.payment.PaymentApplication")
            .condition(
                "paymentId",
                "in",
                payments.map(row => row.paymentId)
            )
            .condition("invoiceId", "is-not-null", null)
            .list()
    )
    const byType = {}
    for (const application of applications) {
        const invoice = one("mantle.account.invoice.Invoice", {invoiceId: application.invoiceId})
        if (!invoice || ["InvoicePayroll", "InvoiceTax"].includes(invoice.invoiceTypeEnumId)) continue
        const items = rows("mantle.account.invoice.InvoiceItem", {invoiceId: application.invoiceId}).map(item => ({
            itemTypeEnumId: item.itemTypeEnumId,
            total: toDecimal(item.quantity ?? 1).multiply(toDecimal(item.amount ?? 0))
        }))
        const invoiceTotal = items.reduce((sum, item) => sum.add(item.total), toDecimal(0))
        if (invoiceTotal.isZero()) continue
        for (const item of items) {
            const share = toDecimal(application.amountApplied ?? 0)
                .multiply(item.total)
                .divide(invoiceTotal)
            byType[item.itemTypeEnumId] = (byType[item.itemTypeEnumId] || toDecimal(0)).add(share)
        }
    }
    return Object.entries(byType).map(([itemTypeEnumId, itemsTotal]) => ({
        itemTypeEnumId,
        itemsTotal: ec.l10n.roundCurrency(itemsTotal, currency)
    }))
}

// run#Vendor1099Statements: a 1099 statement for each vendor the organization paid in the period who is registered
// with the authority and not exempt (TaxAuthorityParty), at least the threshold, from the payments of the period. Each
// vendor is its own step: one without a taxpayer number or address, or with a statement for the period already, is named
// with its reason and the run goes on. Paid vendors under the threshold or not registered are listed as skipped.
function run1099(p) {
    const organizationPartyId = policy.organization(p, "taxEdit").organizationPartyId
    const taxAuthorityId = authority(p.taxAuthorityId || "UsaIrs").taxAuthorityId
    const dates = period(p.timePeriodId, organizationPartyId)
    const threshold = toDecimal(p.amountThreshold ?? 600)
    const currency = policy.preference(organizationPartyId).baseCurrencyUomId
    const paid = Array.from(
        find("mantle.account.payment.Payment", {fromPartyId: organizationPartyId})
            .condition("statusId", "in", ["PmntDelivered", "PmntConfirmed"])
            .condition("effectiveDate", "greater-equals", dates.fromTimestamp)
            .condition("effectiveDate", "less-equals", dates.thruTimestamp)
            .selectField("toPartyId")
            .distinct(true)
            .list()
    )
    const vendorIds = [...new Set(paid.map(row => row.toPartyId).filter(id => id && id !== organizationPartyId))]
    const registered = new Set(
        (vendorIds.length
            ? Array.from(
                  find("mantle.other.tax.TaxAuthorityParty", {taxAuthorityId}).condition("partyId", "in", vendorIds).list()
              )
            : []
        )
            .filter(row => row.isExempt !== "Y" && lib.active(row, dates.thruTimestamp))
            .map(row => row.partyId)
    )
    const names = lib.partyNames(vendorIds)
    const created = [],
        failures = [],
        skipped = []
    for (const partyId of vendorIds) {
        const name = names[partyId] || partyId
        if (!registered.has(partyId)) {
            skipped.push({partyId, name, total: null, reason: "Not registered as a 1099 payee"})
            continue
        }
        try {
            const itemTypeTotals = paidItemTypeTotals(
                organizationPartyId,
                partyId,
                dates.fromTimestamp,
                dates.thruTimestamp,
                currency
            )
            const total = itemTypeTotals.reduce((sum, row) => sum.add(row.itemsTotal), toDecimal(0))
            if (total.compare(threshold) < 0) {
                skipped.push({partyId, name, total, reason: "Paid less than the threshold"})
                continue
            }
            // a vendor done by an earlier run is skipped; the lock keeps two runs from both making it
            lockParty(partyId)
            const existing = find(STATEMENT, {partyId, timePeriodId: dates.timePeriod.timePeriodId, formId: vendorForm}).count()
            if (existing) {
                skipped.push({partyId, name, total, reason: "Already has a statement for the period"})
                continue
            }
            const recipient = call("mantle.other.TaxServices.get#RecipientTaxInfo", {partyId})
            if (!recipient.ssn && !recipient.ein) denied("TIN_MISSING", "no taxpayer identification number")
            if (!recipient.homeStreetString) denied("ADDRESS_MISSING", "no payment address")
            // the checks above name a vendor's failure before anything is written; the statement is in the run's transaction,
            // which holds the vendor's lock
            const made = call("mantle.other.TaxServices.create#Vendor1099MiscStatement", {
                timePeriodId: dates.timePeriod.timePeriodId,
                partyId,
                taxAuthorityId,
                formId: vendorForm,
                itemTypeTotals
            })
            call("update#" + STATEMENT, {
                taxStatementId: made.taxStatementId,
                reportedAmount: total,
                lineCount: itemTypeTotals.length,
                createdDate: ec.user.nowTimestamp,
                createdByUserId: ec.user.userId
            })
            created.push({partyId, name, taxStatementId: made.taxStatementId, total})
        } catch (error) {
            const reasonCode = lib.reasonCode(error) || "STATEMENT_FAILED"
            ec.logger.error("1099 statement for " + partyId + ": " + error.message)
            failures.push({partyId, name, reasonCode, message: String(error.message).replace(/^[A-Z_]+: /, "")})
        }
    }
    return {created, failures, skipped}
}

// export#Statement: the statement as CSV data, with its format version, after checking it: a sales tax statement still
// agrees with its lines, and a 1099 has the recipient's taxpayer number and name. Records who exported it and when.
// Other forms are not supported.
function exportStatement(p) {
    const scope = statementScope(p, "taxEdit")
    const statement = scope.statement
    const csv = value => '"' + String(value ?? "").replace(/"/g, '""') + '"'
    const lines = []
    let format
    if (statement.formId === salesTaxForm) {
        const detail = salesTaxLines({taxStatementId: statement.taxStatementId})
        const lineTax = detail.taxAmount
        if (statement.taxAmount != null && !lineTax.eq(toDecimal(statement.taxAmount)))
            denied("STATEMENT_STALE", "Its invoices changed since it was made; create a new statement for the period")
        format = "local-sales-tax-v1"
        lines.push(["invoiceId", "invoiceDate", "customer", "taxableAmount", "taxPercentage", "taxAmount"].join(","))
        for (const line of detail.lines)
            lines.push(
                [line.invoiceId, line.invoiceDateText, line.customerName, line.taxableAmount, line.taxPercentage, line.taxAmount]
                    .map(csv)
                    .join(",")
            )
    } else if (statement.formId === vendorForm) {
        const response = call("org.moqui.impl.ScreenServices.get#FormResponse", {formResponseId: statement.formResponseId})
        const answers = response.responseMap || {}
        if (!answers["1099m_c"]) denied("TIN_MISSING", "The recipient has no taxpayer identification number")
        if (!String(answers["1099m_d1"] || "").trim()) denied("RECIPIENT_MISSING", "The recipient has no name")
        format = "usa-1099-misc-data-v1"
        lines.push(["field", "title", "value"].join(","))
        for (const field of Array.from(response.dbFormFieldList || []))
            lines.push([field.fieldName, field.title, answers[field.fieldName]].map(csv).join(","))
    } else {
        denied("EXPORT_UNSUPPORTED", "This statement's form has no supported export")
    }
    call("update#" + STATEMENT, {
        taxStatementId: statement.taxStatementId,
        exportedDate: ec.user.nowTimestamp,
        exportedByUserId: ec.user.userId,
        exportFormat: format
    })
    return {
        fileName: "TaxStatement-" + statement.taxStatementId + ".csv",
        contentType: "text/csv",
        text: lines.join("\n") + "\n",
        exportFormat: format
    }
}

const operations = {salesTaxLines, createSalesTax, run1099, exportStatement}
;({
    execute: (op, parameters) => {
        if (!operations[op]) throw new Error("Unknown tax statement operation " + op)
        return operations[op](parameters)
    }
})
