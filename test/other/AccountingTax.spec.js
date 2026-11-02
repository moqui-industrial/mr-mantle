// Local sales tax and tax statements (AC-08; mantle.other.TaxServices): authorities and dated rate versions, an invoice
// without a store taxed by its organization's gateway when it is finalized, its tax lines posting to the authority's
// account, refusals when its tax cannot be calculated, a sales tax statement with its export, the simulation, and the
// vendor 1099 run on the year's payments with its failures named.
const helper = () => ec.resource.script("component://mr-mantle/test/ledger/AccountingReceivablesFixtures.js")
const tax = (name, p) => helper().call("mantle.other.TaxServices." + name, p)
const one = (entity, conditions) => helper().lib.one(entity, conditions)
const rows = (entity, conditions) => helper().lib.rows(entity, conditions)
const hour = 3600000
let f, authorityId, firstRateId, secondRateId, taxedInvoiceId, monthId, yearId, statementId
const accountId = "NATIVE_TAX_PAYABLE"

function customer(id, stateProvinceGeoId) {
    helper().call("create#mantle.party.Party", {partyId: id, partyTypeEnumId: "PtyOrganization"})
    helper().call("create#mantle.party.Organization", {partyId: id, organizationName: id + " customer"})
    helper().call("create#mantle.party.PartyRole", {partyId: id, roleTypeId: "Customer"})
    if (stateProvinceGeoId)
        helper().call("mantle.party.ContactServices.store#PartyContactInfo", {
            partyId: id,
            postalContactMechPurposeId: "PostalShippingDest",
            address1: "1 Main St",
            city: "Somewhere",
            stateProvinceGeoId,
            postalCode: "84057",
            countryGeoId: "USA"
        })
    return id
}
// A draft sales invoice of two product lines, 2 × 100.00 and 1 × 33.33, by the AR user.
function productInvoice(customerPartyId, lines = null) {
    login(f.users.ar)
    const made = helper().call("mantle.account.InvoiceServices.create#Receivable", {
        organizationPartyId: f.org,
        customerPartyId,
        currencyUomId: "USD"
    })
    for (const [quantity, amount] of lines || [
        ["2", "100"],
        ["1", "33.33"]
    ])
        helper().call("mantle.account.InvoiceServices.store#InvoiceDraftItem", {
            invoiceId: made.invoiceId,
            itemTypeEnumId: "ItemProduct",
            quantity,
            amount,
            description: "Taxable goods"
        })
    return one("mantle.account.invoice.Invoice", {invoiceId: made.invoiceId})
}
function finalize(invoice) {
    return helper().rejected("mantle.account.InvoiceServices.change#InvoiceState", {
        invoiceId: invoice.invoiceId,
        action: "finalize",
        lastUpdatedStamp: invoice.lastUpdatedStamp
    })
}
function taxLines(invoiceId) {
    return rows("mantle.account.invoice.InvoiceItem", {invoiceId, itemTypeEnumId: "ItemSalesTax"}).sort((a, b) =>
        String(a.parentItemSeqId).localeCompare(String(b.parentItemSeqId))
    )
}
const rateFields = {taxAuthorityId: null, taxPercentage: "6.1", changeReason: "Spec rate"}

spec({
    stepwise: true,
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        f = helper().fixtures("NATIVE_TAX")
        helper().call("create#mantle.ledger.account.GlAccount", {
            glAccountId: accountId,
            accountCode: "224900001",
            accountName: "Spec sales tax payable",
            glAccountClassEnumId: "ACCRUED_EXPENSES",
            glAccountTypeEnumId: "GatAccruedExpenses",
            glResourceTypeEnumId: "GlrtMoney",
            isDebit: "N"
        })
        helper().call("create#mantle.ledger.account.GlAccountOrganization", {
            glAccountId: accountId,
            organizationPartyId: f.org,
            fromDate: 0
        })
        customer("NATIVE_TAX_UT", "USA_UT")
        customer("NATIVE_TAX_CA", "USA_CA")
        customer("NATIVE_TAX_NOWHERE", null)
        const periods = type =>
            helper().call("mantle.ledger.LedgerServices.get#OrganizationFiscalTimePeriods", {
                organizationPartyId: f.org,
                filterDate: ec.user.nowTimestamp,
                timePeriodTypeId: type
            }).timePeriodList[0].timePeriodId
        monthId = periods("FiscalMonth")
        yearId = periods("FiscalYear")
    },
    setup() {
        ec.artifactExecution.disableAuthz()
    },
    cleanup() {
        login("john.doe")
    }
})

feature("a finance administrator adds an authority with its account and nexus; others are refused", {
    when() {
        const fields = {
            organizationPartyId: f.org,
            description: "Spec Utah sales tax",
            taxAuthorityTypeEnumId: "TatState",
            taxAuthGeoId: "USA_UT",
            glAccountId: accountId,
            isNexus: "Y",
            partyTaxId: "UT-12345",
            changeReason: "Spec authority"
        }
        login(f.users.tax)
        const taxUser = helper().rejected("mantle.other.TaxServices.store#Authority", fields)
        login(f.users.financeadmin)
        authorityId = tax("store#Authority", fields).taxAuthorityId
        rateFields.taxAuthorityId = authorityId
        return {
            taxUser,
            account: one("mantle.ledger.config.TaxAuthorityGlAccount", {taxAuthorityId: authorityId, organizationPartyId: f.org}),
            nexus: rows("mantle.other.tax.TaxAuthorityParty", {taxAuthorityId: authorityId, partyId: f.org})
        }
    },
    then({taxUser, account, nexus}) {
        taxUser.includes("PERMISSION_DENIED")
        account.glAccountId == accountId
        nexus.length == 1
        nexus[0].isNexus == "Y"
        nexus[0].partyTaxId == "UT-12345"
    }
})

feature("an authority's shared fields are a system administrator's; a registration change starts a new dated row", {
    when() {
        login(f.users.financeadmin)
        const renamed = helper().rejected("mantle.other.TaxServices.store#Authority", {
            organizationPartyId: f.org,
            taxAuthorityId: authorityId,
            description: "Renamed by one organization",
            changeReason: "Spec rename"
        })
        tax("store#Authority", {
            organizationPartyId: f.org,
            taxAuthorityId: authorityId,
            description: "Spec Utah sales tax",
            glAccountId: accountId,
            partyTaxId: "",
            changeReason: "Spec registration cleared"
        })
        const registrations = rows("mantle.other.tax.TaxAuthorityParty", {taxAuthorityId: authorityId, partyId: f.org})
        return {renamed, registrations}
    },
    then({renamed, registrations}) {
        renamed.includes("AUTHORITY_SHARED")
        registrations.length == 2
        registrations.filter(row => row.thruDate == null).length == 1
        registrations.find(row => row.thruDate == null).partyTaxId == null
        registrations.find(row => row.thruDate == null).isNexus == "Y"
    }
})

feature("rates are dated versions: a new version ends the one it replaces, and an overlap is refused", {
    when() {
        const start = Date.now() - 48 * hour
        const fields = Object.assign({}, rateFields, {organizationPartyId: f.org, fromDate: start})
        login(f.users.ar)
        const arUser = helper().rejected("mantle.other.TaxServices.store#Rate", fields)
        login(f.users.financeadmin)
        firstRateId = tax("store#Rate", fields).taxAuthorityRateId
        const overlap = helper().rejected("mantle.other.TaxServices.store#Rate", fields)
        const badRate = helper().rejected(
            "mantle.other.TaxServices.store#Rate",
            Object.assign({}, fields, {taxPercentage: "120"})
        )
        return {arUser, overlap, badRate, first: one("mantle.other.tax.TaxAuthorityRate", {taxAuthorityRateId: firstRateId})}
    },
    then({arUser, overlap, badRate, first}) {
        arUser.includes("PERMISSION_DENIED")
        overlap.includes("RATE_OVERLAP")
        badRate.includes("RATE_INVALID")
        first.organizationPartyId == f.org
        first.rateTypeEnumId == "TarSalesTax"
        first.thruDate == null
    }
})

feature("an organization without a gateway finalizes an untaxed invoice as before", {
    when() {
        const invoice = productInvoice("NATIVE_TAX_UT")
        return {refused: finalize(invoice), lines: taxLines(invoice.invoiceId)}
    },
    then({refused, lines}) {
        refused == ""
        lines.length == 0
    }
})

feature("an invoice without a store gets its tax lines by organization policy, posted to the authority's account", {
    when() {
        helper().call("update#mantle.ledger.config.PartyAcctgPreference", {
            organizationPartyId: f.org,
            taxGatewayConfigId: "LOCAL"
        })
        const invoice = productInvoice("NATIVE_TAX_UT")
        taxedInvoiceId = invoice.invoiceId
        const refused = finalize(invoice)
        const saved = one("mantle.account.invoice.Invoice", {invoiceId: taxedInvoiceId})
        const lines = taxLines(taxedInvoiceId)
        const entries = rows("mantle.ledger.transaction.AcctgTransEntry", {glAccountId: accountId}).filter(entry =>
            lines.some(line => line.invoiceItemSeqId === entry.invoiceItemSeqId)
        )
        return {refused, saved, lines, entries}
    },
    then({refused, saved, lines, entries}) {
        refused == ""
        saved.statusId == "InvoiceFinalized"
        lines.length == 2
        lines.every(line => line.taxAuthorityId == authorityId && line.taxAuthorityRateId == firstRateId)
        lines.every(line => toDecimal(line.taxPercentage).eq(toDecimal("6.1")))
        toDecimal(lines[0].taxableAmount).eq(toDecimal("200"))
        toDecimal(lines[0].amount).eq(toDecimal("12.2"))
        toDecimal(lines[1].taxableAmount).eq(toDecimal("33.33"))
        toDecimal(lines[1].amount).eq(toDecimal("2.03"))
        toDecimal(lines[1].taxRoundingAmount).eq(toDecimal("-0.00313"))
        toDecimal(saved.invoiceTotal).eq(toDecimal("247.56"))
        entries.length == 2
        entries.every(entry => entry.debitCreditFlag == "C")
    }
})

feature("an invoice whose tax cannot be calculated cannot be finalized; another state's sale has no tax", {
    when() {
        const noAddress = finalize(productInvoice("NATIVE_TAX_NOWHERE"))
        const elsewhere = productInvoice("NATIVE_TAX_CA")
        const elsewhereRefused = finalize(elsewhere)
        return {noAddress, elsewhereRefused, elsewhereLines: taxLines(elsewhere.invoiceId)}
    },
    then({noAddress, elsewhereRefused, elsewhereLines}) {
        noAddress.includes("TAX_ADDRESS_MISSING")
        elsewhereRefused == ""
        elsewhereLines.length == 0
    }
})

feature("a new rate version applies to later invoices while issued lines keep theirs; no rate in effect refuses", {
    when() {
        login(f.users.financeadmin)
        secondRateId = tax("store#Rate", {
            organizationPartyId: f.org,
            taxAuthorityRateId: firstRateId,
            taxPercentage: "7.25",
            fromDate: Date.now() - hour,
            changeReason: "Spec rate change"
        }).taxAuthorityRateId
        const first = one("mantle.other.tax.TaxAuthorityRate", {taxAuthorityRateId: firstRateId})
        const later = productInvoice("NATIVE_TAX_UT")
        const laterRefused = finalize(later)
        login(f.users.financeadmin)
        tax("store#Rate", {
            organizationPartyId: f.org,
            taxAuthorityRateId: secondRateId,
            thruDate: Date.now() - 60000,
            changeReason: "Spec rate end"
        })
        const missing = finalize(productInvoice("NATIVE_TAX_UT"))
        login(f.users.financeadmin)
        tax("store#Rate", {
            organizationPartyId: f.org,
            taxAuthorityRateId: secondRateId,
            taxPercentage: "7.25",
            fromDate: Date.now() - 30000,
            changeReason: "Spec rate restored"
        })
        return {first, laterRefused, laterLines: taxLines(later.invoiceId), earlier: taxLines(taxedInvoiceId), missing}
    },
    then({first, laterRefused, laterLines, earlier, missing}) {
        first.thruDate != null
        laterRefused == ""
        laterLines.every(line => line.taxAuthorityRateId == secondRateId)
        toDecimal(laterLines[0].amount).eq(toDecimal("14.5"))
        earlier.every(line => line.taxAuthorityRateId == firstRateId)
        missing.includes("TAX_RATE_MISSING")
    }
})

feature("the simulation explains each rate, base and rounding, and a sale elsewhere has none", {
    when() {
        login(f.users.tax)
        const utah = tax("simulate#SalesTax", {
            organizationPartyId: f.org,
            destinationGeoId: "USA_UT",
            amount: "33.33",
            shippingAmount: "5"
        })
        const california = tax("simulate#SalesTax", {organizationPartyId: f.org, destinationGeoId: "USA_CA", amount: "10"})
        return {utah, california}
    },
    then({utah, california}) {
        utah.reasonCode == "OK"
        utah.rows.length == 2
        utah.rows[0].authorityName == "Spec Utah sales tax"
        toDecimal(utah.rows[0].taxAmount).eq(toDecimal("2.42"))
        utah.rows[1].exemptReason == "Shipping is not taxed"
        california.rows.length == 0
        california.message.includes("No tax applies")
    }
})

feature("a sales tax statement for a period lists its invoice lines and exports once checked", {
    when() {
        login(f.users.ar)
        const arUser = helper().rejected("mantle.other.TaxServices.create#SalesTaxStatement", {
            organizationPartyId: f.org,
            taxAuthorityId: authorityId,
            timePeriodId: monthId
        })
        login(f.users.tax)
        const made = tax("create#SalesTaxStatement", {
            organizationPartyId: f.org,
            taxAuthorityId: authorityId,
            timePeriodId: monthId
        })
        statementId = made.taxStatementId
        const lines = tax("find#SalesTaxLines", {taxStatementId: statementId})
        const exported = tax("export#Statement", {taxStatementId: statementId})
        const statement = one("mantle.other.tax.TaxStatement", {taxStatementId: statementId})
        const deleted = helper().rejected("mantle.other.TaxServices.delete#TaxStatement", {taxStatementId: statementId})
        const keyed = {
            organizationPartyId: f.org,
            taxAuthorityId: authorityId,
            timePeriodId: monthId,
            operationKey: "native-tax-st"
        }
        const first = tax("create#SalesTaxStatement", keyed)
        const retry = tax("create#SalesTaxStatement", keyed)
        return {arUser, made, lines, exported, statement, deleted, first, retry}
    },
    then({arUser, made, lines, exported, statement, deleted, first, retry}) {
        retry.taxStatementId == first.taxStatementId
        retry.alreadyApplied == true
        arUser.includes("PERMISSION_DENIED")
        made.lineCount == 4
        lines.lines.some(line => line.invoiceId == taxedInvoiceId && line.customerName.includes("NATIVE_TAX_UT"))
        toDecimal(lines.taxAmount).eq(toDecimal(statement.taxAmount))
        toDecimal(statement.reportedAmount).eq(toDecimal("466.66"))
        exported.exportFormat == "local-sales-tax-v1"
        exported.text.includes(taxedInvoiceId)
        statement.exportedDate != null
        deleted.includes("STATEMENT_EXPORTED")
    }
})

feature("a statement takes an invoice by its book day, not its timestamp's day in the statement user's zone", {
    when() {
        // two invoices at the month's end: one on its last day in the Americas whose timestamp is the next month in UTC,
        // one on the next month's first day whose timestamp is the month's last day at noon UTC
        const month = one("mantle.party.time.TimePeriod", {timePeriodId: monthId})
        const lastDay = helper().lib.policy.calendarDateText(month.thruDate)
        const [y, m, d] = lastDay.split("-").map(Number)
        const nextDay = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10)
        const invoice = (invoiceId, accountingDate, invoiceDate) => {
            helper().call("create#mantle.account.invoice.Invoice", {
                invoiceId,
                invoiceTypeEnumId: "InvoiceSales",
                fromPartyId: f.org,
                toPartyId: "NATIVE_TAX_UT",
                statusId: "InvoiceFinalized",
                invoiceDate,
                accountingDate,
                currencyUomId: "USD"
            })
            helper().call("create#mantle.account.invoice.InvoiceItem", {
                invoiceId,
                invoiceItemSeqId: "01",
                itemTypeEnumId: "ItemSalesTax",
                taxAuthorityId: authorityId,
                quantity: "1",
                amount: "1.00"
            })
        }
        invoice("NATIVE_TAX_MONTH_END", lastDay, Date.UTC(y, m - 1, d + 1, 4, 30))
        invoice("NATIVE_TAX_NEXT_MONTH", nextDay, Date.UTC(y, m - 1, d, 12))
        login(f.users.tax)
        const found = tax("find#SalesTaxLines", {organizationPartyId: f.org, taxAuthorityId: authorityId, timePeriodId: monthId})
        return {lastDay, lines: Array.from(found.lines)}
    },
    then({lastDay, lines}) {
        lines.some(line => line.invoiceId == "NATIVE_TAX_MONTH_END" && line.invoiceDateText == lastDay)
        !lines.some(line => line.invoiceId == "NATIVE_TAX_NEXT_MONTH")
    }
})

// A vendor's approved bill and a delivered payment applied to it, in the year.
function paidVendor(id, registered, amount, ssn) {
    helper().call("create#mantle.party.Party", {partyId: id, partyTypeEnumId: "PtyPerson"})
    helper().call("create#mantle.party.Person", {partyId: id, firstName: "Vendor", lastName: id})
    if (registered)
        helper().call("create#mantle.other.tax.TaxAuthorityParty", {partyId: id, taxAuthorityId: "UsaIrs", fromDate: 0})
    if (ssn) {
        helper().call("create#mantle.party.PartyIdentification", {partyId: id, partyIdTypeEnumId: "PtidSsn", idValue: ssn})
        helper().call("mantle.party.ContactServices.store#PartyContactInfo", {
            partyId: id,
            postalContactMechPurposeId: "PostalPayment",
            address1: "9 Vendor Rd",
            city: "Provo",
            stateProvinceGeoId: "USA_UT",
            postalCode: "84601",
            countryGeoId: "USA"
        })
    }
    const invoiceId = helper().call("mantle.account.InvoiceServices.create#Invoice", {
        fromPartyId: id,
        toPartyId: f.org,
        invoiceTypeEnumId: "InvoiceSales",
        currencyUomId: "USD"
    }).invoiceId
    helper().call("mantle.account.InvoiceServices.create#InvoiceItem", {
        invoiceId,
        itemTypeEnumId: "ItemExpServLabor",
        quantity: 1,
        amount
    })
    helper().call("update#mantle.account.invoice.Invoice", {invoiceId, statusId: "InvoiceReceived"})
    // without statusId, as its REST callers do: the payment is delivered (F301)
    const paymentId = helper().call("mantle.account.PaymentServices.create#InvoicePayment", {
        invoiceId,
        amount,
        effectiveDate: ec.user.nowTimestamp
    }).paymentId
    return one("mantle.account.payment.Payment", {paymentId})
}

feature("1099 data is generated per registered vendor from the year's payments, with failures named", {
    when() {
        login("john.doe")
        const payment = paidVendor("NATIVE_TAX_V_OK", true, "700", "123-45-6780")
        paidVendor("NATIVE_TAX_V_NOTIN", true, "650", null)
        paidVendor("NATIVE_TAX_V_UNREG", false, "900", "123-45-6781")
        paidVendor("NATIVE_TAX_V_SMALL", true, "100", "123-45-6782")
        login(f.users.ar)
        const arUser = helper().rejected("mantle.other.TaxServices.run#Vendor1099Statements", {
            organizationPartyId: f.org,
            timePeriodId: yearId
        })
        login(f.users.tax)
        const run = tax("run#Vendor1099Statements", {organizationPartyId: f.org, timePeriodId: yearId})
        const again = tax("run#Vendor1099Statements", {organizationPartyId: f.org, timePeriodId: yearId})
        const created = run.created.find(row => row.partyId == "NATIVE_TAX_V_OK")
        const exported = created ? tax("export#Statement", {taxStatementId: created.taxStatementId}) : {text: ""}
        return {arUser, run, again, exported, payment}
    },
    then({arUser, run, again, exported, payment}) {
        arUser.includes("PERMISSION_DENIED")
        run.created.map(row => row.partyId).join() == "NATIVE_TAX_V_OK"
        run.failures.some(row => row.partyId == "NATIVE_TAX_V_NOTIN" && row.reasonCode == "TIN_MISSING")
        run.skipped.some(row => row.partyId == "NATIVE_TAX_V_SMALL")
        run.skipped.some(row => row.partyId == "NATIVE_TAX_V_UNREG" && row.reason.includes("Not registered"))
        !run.created.concat(run.failures).some(row => row.partyId == "NATIVE_TAX_V_UNREG")
        again.skipped.some(row => row.partyId == "NATIVE_TAX_V_OK" && row.reason.includes("Already"))
        payment.statusId == "PmntDelivered"
        exported.text.includes("1099m_07")
        exported.text.includes("700.00")
    }
})

feature("a discount of the whole sale is spread over the taxed lines, and tax lines are marked as calculated", {
    when() {
        const invoice = productInvoice("NATIVE_TAX_UT", [["1", "300"]])
        helper().call("mantle.account.InvoiceServices.store#InvoiceDraftItem", {
            invoiceId: invoice.invoiceId,
            itemTypeEnumId: "ItemDiscount",
            quantity: "1",
            amount: "-50",
            description: "Order discount"
        })
        const refused = finalize(one("mantle.account.invoice.Invoice", {invoiceId: invoice.invoiceId}))
        return {refused, lines: taxLines(invoice.invoiceId)}
    },
    then({refused, lines}) {
        refused == ""
        lines.length == 1
        toDecimal(lines[0].taxableAmount).eq(toDecimal("250"))
        lines[0].taxCalculated == "Y"
    }
})

feature("an authority with nexus in the destination and no rate in effect refuses the sale", {
    when() {
        login(f.users.financeadmin)
        tax("store#Authority", {
            organizationPartyId: f.org,
            description: "Spec Utah county tax",
            taxAuthorityTypeEnumId: "TatCounty",
            taxAuthGeoId: "USA_UT",
            isNexus: "Y",
            changeReason: "Spec county nexus"
        })
        return {refused: finalize(productInvoice("NATIVE_TAX_UT"))}
    },
    then({refused}) {
        refused.includes("TAX_RATE_MISSING")
        refused.includes("Spec Utah county tax")
    }
})
