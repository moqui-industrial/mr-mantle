// Base-currency posting (AC-19) and provider rates (AC-16): an invoice in another currency posts at its rate in the base
// currency, kept on the invoice and the transaction; it is paid at another rate and the difference is booked as a realized
// exchange gain or loss; partial payments clear the receivable exactly; the GL holds the base currency only; a posting with
// no rate is refused (posting guard on) or held in the error journal (off); a provider's file proposes rates a finance
// administrator accepts or rejects; readiness asks for the open documents' rates, not a single currency. Standalone:
// spec-local organizations and users; the provider reads a copy of the European Central Bank's file, never the network.
const helper = () => ec.resource.script("component://mr-mantle/test/ledger/AccountingReceivablesFixtures.js")
const call = (name, p) => helper().call(name, p)
const refused = (name, p) => helper().rejected(name, p)
const one = (entity, key) => helper().lib.one(entity, key)
const rows = (entity, key) => helper().lib.rows(entity, key)
const T = "mantle.ledger.transaction.AcctgTrans",
    E = "mantle.ledger.transaction.AcctgTransEntry"
const day = offset => ec.l10n.format(new Date(Number(ec.user.nowTimestamp) + offset * 86400000), "yyyy-MM-dd")
const stamp = offsetMs => new Date(Number(ec.user.nowTimestamp) + offsetMs)
const text = value => String(toDecimal(value ?? 0).setScale(2, "HALF_UP"))
const ecbFile = () =>
    "<?xml version='1.0' encoding='UTF-8'?>\n<gesmes:Envelope><Cube><Cube time='" +
    day(-5) +
    "'>\n<Cube currency='USD' rate='1.1000'/>\n<Cube currency='GBP' rate='0.85'/>\n" +
    "<Cube currency='JPY' rate='160.50'/>\n<Cube currency='CHF' rate='0.94'/>\n</Cube></Cube></gesmes:Envelope>"
let f, off, chfInvoice, chfPayment, lossInvoice, gbpInvoice
const storedRates = []

function rate(uomId, conversionFactor, fromDate) {
    const out = call("mantle.ledger.CurrencyServices.store#Rate", {
        organizationPartyId: f.org,
        uomId,
        toUomId: "USD",
        conversionFactor,
        fromDate,
        rateSource: "Spec FX",
        changeReason: "Spec rate"
    })
    storedRates.push(out.uomConversionId)
    return out
}
function finalize(invoice, key) {
    return call("mantle.account.InvoiceServices.change#InvoiceState", {
        invoiceId: invoice.invoiceId,
        action: "finalize",
        lastUpdatedStamp: invoice.lastUpdatedStamp,
        operationKey: key
    })
}
function postings(field, id, types) {
    return rows(T, {[field]: id})
        .filter(tx => types.includes(tx.acctgTransTypeEnumId) && !tx.reverseOfAcctgTransId && !tx.reversedByAcctgTransId)
        .sort((a, b) => a.acctgTransId.localeCompare(b.acctgTransId))
}
function lines(acctgTransId) {
    return rows(E, {acctgTransId}).sort((a, b) => a.acctgTransEntrySeqId.localeCompare(b.acctgTransEntrySeqId))
}
// what an invoice's postings left on the receivable account (debit positive), in the base currency
function receivableNet(invoiceId) {
    let net = toDecimal(0)
    for (const tx of rows(T, {invoiceId, organizationPartyId: f.org, isPosted: "Y"}))
        for (const line of lines(tx.acctgTransId).filter(line => line.glAccountId == "121000000"))
            net = line.debitCreditFlag == "D" ? net.add(line.amount) : net.subtract(line.amount)
    return net
}
function pay(invoice, amount) {
    return call("mantle.account.PaymentServices.create#InvoicePayment", {
        invoiceId: invoice.invoiceId,
        amount,
        paymentInstrumentEnumId: "PiCompanyCheck",
        effectiveDate: ec.user.nowTimestamp
    })
}

spec({
    stepwise: true,
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        f = helper().fixtures("NATIVE_FX")
        off = helper().fixtures("NATIVE_FX_OFF")
        call("update#mantle.ledger.config.PartyAcctgPreference", {organizationPartyId: off.org, postingGuardEnabled: "N"})
    },
    setup() {
        ec.artifactExecution.disableAuthz()
        login(f.users.financeadmin)
    },
    cleanupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        // the spec's rates are global UomConversion rows; other specs' documents must not convert at them
        for (const row of rows("moqui.basic.UomConversion", {rateSource: "Spec FX"}).concat(
            rows("moqui.basic.UomConversion", {rateSource: "ECB reference rate " + day(-5)})
        )) {
            try {
                call("delete#moqui.basic.UomConversion", {uomConversionId: row.uomConversionId})
            } catch (error) {
                ec.logger.error("Spec rate cleanup " + row.uomConversionId + ": " + error.message)
            }
        }
    }
})
feature("an invoice in another currency posts at its rate in the base currency, kept on the transaction and the invoice", {
    when() {
        rate("CHF", "1.10", stamp(-30 * 86400000))
        chfInvoice = helper().draft(f, "100", "CHF")
        const finalized = finalize(chfInvoice, "fx-chf-1")
        const tx = postings("invoiceId", chfInvoice.invoiceId, ["AttSalesInvoice"])[0]
        return {
            finalized,
            tx,
            entries: lines(tx.acctgTransId),
            invoice: one("mantle.account.invoice.Invoice", {invoiceId: chfInvoice.invoiceId})
        }
    },
    then({finalized, tx, entries, invoice}) {
        finalized.statusId == "InvoiceFinalized"
        tx.isPosted == "Y"
        tx.amountUomId == "USD"
        tx.originalCurrencyUomId == "CHF"
        tx.exchangeRate == "1.1"
        tx.exchangeRateSource == "Spec FX"
        !!tx.exchangeRateDate
        entries.find(line => line.glAccountId == "121000000").amount.eq(110)
        entries.find(line => line.glAccountId == "121000000").originalCurrencyAmount.eq(100)
        entries
            .filter(line => line.debitCreditFlag == "C")
            .reduce((sum, line) => sum.add(line.amount), toDecimal(0))
            .eq(110)
        invoice.exchangeRate == "1.1"
        invoice.exchangeRateToUomId == "USD"
        invoice.exchangeRateSource == "Spec FX"
    }
})
feature("paid at a higher rate, the payment posts at its own rate and the application books the realized gain", {
    when() {
        rate("CHF", "1.20", stamp(-60000))
        chfPayment = pay(chfInvoice, "100")
        const payment = postings("paymentId", chfPayment.paymentId, ["AttIncomingPayment"])[0]
        const application = postings("paymentApplicationId", chfPayment.paymentApplicationId, ["AttIncomingPaymentAp"])[0]
        return {
            payment,
            paymentLines: lines(payment.acctgTransId),
            application,
            applicationLines: lines(application.acctgTransId),
            ar: receivableNet(chfInvoice.invoiceId),
            stored: one("mantle.account.payment.Payment", {paymentId: chfPayment.paymentId})
        }
    },
    then({payment, paymentLines, application, applicationLines, ar, stored}) {
        payment.isPosted == "Y"
        payment.exchangeRate == "1.2"
        stored.exchangeRate == "1.2"
        paymentLines.every(line => line.amount.eq(120) && line.originalCurrencyAmount.eq(100))
        application.isPosted == "Y"
        application.amountUomId == "USD"
        application.originalCurrencyUomId == "CHF"
        applicationLines.find(line => line.glAccountId == "121000000").amount.eq(110)
        applicationLines.find(line => line.glAccountTypeEnumId == "GatForExGain").debitCreditFlag == "C"
        applicationLines.find(line => line.glAccountTypeEnumId == "GatForExGain").amount.eq(10)
        applicationLines.find(line => line.glAccountTypeEnumId == "GatForExGain").glAccountId == "817000000"
        ar.isZero()
    }
})
feature("paid at a lower rate, the application books the realized loss", {
    when() {
        lossInvoice = helper().draft(f, "100", "CHF")
        finalize(lossInvoice, "fx-chf-2")
        rate("CHF", "1.15", stamp(0))
        const paid = pay(lossInvoice, "100")
        const application = postings("paymentApplicationId", paid.paymentApplicationId, ["AttIncomingPaymentAp"])[0]
        return {application: lines(application.acctgTransId), ar: receivableNet(lossInvoice.invoiceId)}
    },
    then({application, ar}) {
        application.find(line => line.glAccountId == "121000000").amount.eq(120)
        application.find(line => line.glAccountTypeEnumId == "GatForExLoss").debitCreditFlag == "D"
        application.find(line => line.glAccountTypeEnumId == "GatForExLoss").amount.eq(5)
        application.find(line => line.glAccountTypeEnumId == "GatForExLoss").glAccountId == "797000000"
        ar.isZero()
    }
})
feature("partial payments clear the receivable exactly what the invoice posted, whatever each one rounds to", {
    when() {
        rate("NOK", "1.5", stamp(-30 * 86400000))
        const invoice = helper().draft(f, "0.03", "NOK")
        finalize(invoice, "fx-nok-1")
        const posted = receivableNet(invoice.invoiceId)
        const applications = []
        for (let i = 0; i < 3; i++) applications.push(pay(invoice, "0.01").paymentApplicationId)
        const applicationLines = applications
            .flatMap(id => postings("paymentApplicationId", id, ["AttIncomingPaymentAp"]))
            .flatMap(tx => lines(tx.acctgTransId))
        // what the three payments' applications took off the unapplied account, less what they cleared of the receivable,
        // is the exchange they booked
        const unapplied = applicationLines
            .filter(line => line.debitCreditFlag == "D" && !line.glAccountTypeEnumId?.startsWith("GatForEx"))
            .reduce((sum, line) => sum.add(line.amount), toDecimal(0))
        const exchange = applicationLines
            .filter(line => line.glAccountTypeEnumId?.startsWith("GatForEx"))
            .reduce((sum, line) => (line.debitCreditFlag == "C" ? sum.add(line.amount) : sum.subtract(line.amount)), toDecimal(0))
        return {posted, ar: receivableNet(invoice.invoiceId), unapplied, exchange}
    },
    then({posted, ar, unapplied, exchange}) {
        posted.eq(ec.l10n.roundCurrency(toDecimal("0.045"), "USD"))
        unapplied.eq(ec.l10n.roundCurrency(toDecimal("0.015"), "USD").multiply(3))
        ar.isZero()
        exchange.eq(unapplied.subtract(posted))
    }
})
feature("the trial balance holds the base currency only", {
    when() {
        login(f.users.read)
        return call("mantle.ledger.FinanceReportServices.run#TrialBalance", {
            organizationPartyId: f.org,
            fromDate: stamp(-86400000),
            thruDate: stamp(86400000)
        })
    },
    then({reportRows}) {
        reportRows.length > 0
        reportRows.every(row => row.amountUomId == "USD")
    }
})
feature("with no rate a finance user's posting is refused, and with the guard off it waits in the error journal", {
    when() {
        gbpInvoice = helper().draft(f, "50", "GBP")
        const denied = refused("mantle.account.InvoiceServices.change#InvoiceState", {
            invoiceId: gbpInvoice.invoiceId,
            action: "finalize",
            lastUpdatedStamp: gbpInvoice.lastUpdatedStamp,
            operationKey: "fx-gbp-refused"
        })
        // an organization without the guard: Mantle's own posting holds the transaction in the error journal
        login(off.users.financeadmin)
        const heldId = call("mantle.ledger.LedgerServices.create#AcctgTrans", {
            organizationPartyId: off.org,
            amountUomId: "GBP",
            acctgTransTypeEnumId: "AttInternal"
        }).acctgTransId
        for (const [glAccountId, debitCreditFlag] of [
            ["111100000", "D"],
            ["331100000", "C"]
        ])
            call("mantle.ledger.LedgerServices.create#AcctgTransEntry", {
                acctgTransId: heldId,
                glAccountId,
                debitCreditFlag,
                amount: "50"
            })
        call("mantle.ledger.LedgerServices.post#AcctgTrans", {acctgTransId: heldId})
        return {
            denied,
            draft: one("mantle.account.invoice.Invoice", {invoiceId: gbpInvoice.invoiceId}),
            tx: one(T, {acctgTransId: heldId})
        }
    },
    then({denied, draft, tx}) {
        denied.includes("RATE_MISSING")
        draft.statusId == "InvoiceInProcess"
        tx.isPosted == "N"
        tx.glJournalId == off.org + "Error"
        tx.amountUomId == "GBP"
    }
})
feature("readiness names an open document's currency with no rate instead of asking for a single currency", {
    when() {
        const readiness = call("mantle.ledger.SetupServices.check#Readiness", {organizationPartyId: f.org})
        return {
            row: readiness.readinessRows.find(row => row.code == "EXCHANGE_RATES"),
            codes: readiness.readinessRows.map(row => row.code)
        }
    },
    then({row, codes}) {
        !codes.includes("SINGLE_CURRENCY")
        row.status == "blocker"
        row.detailText.includes("GBP")
    }
})
feature("a provider's file proposes cross rates to the base currency, active only once accepted", {
    when() {
        const noProvider = refused("mantle.ledger.CurrencyServices.refresh#Rates", {
            organizationPartyId: f.org,
            sourceText: ecbFile()
        })
        const settings = call("mantle.ledger.SetupServices.get#Preferences", {organizationPartyId: f.org}).settings
        const notProvider = refused("mantle.ledger.SetupServices.store#Preferences", {
            organizationPartyId: f.org,
            settings: {rateProviderServiceName: "mantle.ledger.LedgerServices.post#AcctgTrans"},
            lastUpdatedStamp: settings.lastUpdatedStamp,
            changeReason: "Spec provider"
        })
        call("mantle.ledger.SetupServices.store#Preferences", {
            organizationPartyId: f.org,
            settings: {rateProviderServiceName: "mantle.ledger.CurrencyServices.get#EcbRates"},
            lastUpdatedStamp: settings.lastUpdatedStamp,
            changeReason: "Spec provider"
        })
        login(f.users.ar)
        const reader = refused("mantle.ledger.CurrencyServices.refresh#Rates", {
            organizationPartyId: f.org,
            sourceText: ecbFile()
        })
        login(f.users.financeadmin)
        const refreshed = call("mantle.ledger.CurrencyServices.refresh#Rates", {
            organizationPartyId: f.org,
            sourceText: ecbFile()
        })
        const again = call("mantle.ledger.CurrencyServices.refresh#Rates", {organizationPartyId: f.org, sourceText: ecbFile()})
        const gbp = refreshed.proposals.find(row => row.uomId == "GBP")
        const chf = refreshed.proposals.find(row => row.uomId == "CHF")
        const beforeAccept = refused("mantle.account.InvoiceServices.change#InvoiceState", {
            invoiceId: gbpInvoice.invoiceId,
            action: "finalize",
            lastUpdatedStamp: gbpInvoice.lastUpdatedStamp,
            operationKey: "fx-gbp-before"
        })
        const accepted = call("mantle.ledger.CurrencyServices.accept#RateProposals", {
            organizationPartyId: f.org,
            rateProposalIdList: [gbp.rateProposalId],
            changeReason: "Spec accept"
        })
        const rejected = call("mantle.ledger.CurrencyServices.reject#RateProposals", {
            organizationPartyId: f.org,
            rateProposalIdList: [chf.rateProposalId, gbp.rateProposalId]
        })
        const pending = call("mantle.ledger.CurrencyServices.get#RateProposals", {organizationPartyId: f.org}).proposals
        const draft = one("mantle.account.invoice.Invoice", {invoiceId: gbpInvoice.invoiceId})
        const finalized = finalize(draft, "fx-gbp-after")
        const tx = postings("invoiceId", gbpInvoice.invoiceId, ["AttSalesInvoice"])[0]
        const readiness = call("mantle.ledger.SetupServices.check#Readiness", {organizationPartyId: f.org})
        return {
            noProvider,
            notProvider,
            reader,
            refreshed,
            again,
            gbp,
            beforeAccept,
            accepted,
            rejected,
            pending,
            finalized,
            tx,
            row: readiness.readinessRows.find(row => row.code == "EXCHANGE_RATES")
        }
    },
    then(r) {
        r.noProvider.includes("RATE_PROVIDER_MISSING")
        r.notProvider.includes("Choose an exchange rate provider")
        r.reader.includes("PERMISSION_DENIED")
        r.refreshed.rateDay == day(-5)
        r.refreshed.proposals.map(row => row.uomId).join(",") == "CHF,GBP"
        r.gbp.conversionFactor == "1.294117647059"
        r.gbp.statusId == "RateProposed"
        r.again.proposals.map(row => row.rateProposalId).join(",") ==
            r.refreshed.proposals.map(row => row.rateProposalId).join(",")
        r.beforeAccept.includes("RATE_MISSING")
        r.accepted.complete == true
        !!r.accepted.results[0].uomConversionId
        r.rejected.results.find(row => row.rateProposalId == r.gbp.rateProposalId).success == false
        r.rejected.results.find(row => row.rateProposalId != r.gbp.rateProposalId).success == true
        r.pending.length == 0
        r.finalized.statusId == "InvoiceFinalized"
        r.tx.exchangeRate == "1.294117647059"
        r.tx.exchangeRateSource == "ECB reference rate " + day(-5)
        r.row.status == "ok"
    }
})
// what an organization's postings of a record left on an account (debit positive), in the base currency
function accountNet(org, field, id, glAccountId) {
    let net = toDecimal(0)
    for (const tx of rows(T, {[field]: id, organizationPartyId: org, isPosted: "Y"}))
        for (const line of lines(tx.acctgTransId).filter(line => line.glAccountId == glAccountId))
            net = line.debitCreditFlag == "D" ? net.add(line.amount) : net.subtract(line.amount)
    return net
}
// an invoice made and issued as Mantle's own services do, its status set so the posting SECA runs
function document(from, to, amount, currencyUomId, statusId, glAccountId) {
    const made = call("create#mantle.account.invoice.Invoice", {
        invoiceTypeEnumId: "InvoiceSales",
        fromPartyId: from,
        toPartyId: to,
        statusId: statusId == "InvoiceApproved" ? "InvoiceIncoming" : "InvoiceInProcess",
        invoiceDate: ec.user.nowTimestamp,
        currencyUomId,
        draftedByUserId: ec.user.userId
    })
    call("mantle.account.InvoiceServices.create#InvoiceItem", {
        invoiceId: made.invoiceId,
        quantity: "1",
        amount,
        itemTypeEnumId: "ItemTimeEntry",
        overrideGlAccountId: glAccountId,
        description: "Currency spec"
    })
    call("update#mantle.account.invoice.Invoice", {invoiceId: made.invoiceId, statusId})
    return made.invoiceId
}
feature("inventory costed in another currency posts every movement at its receipt's rate, so the account clears (F417)", {
    when() {
        rate("DKK", "1.10", stamp(-30 * 86400000))
        call("create#mantle.facility.Facility", {
            facilityId: "NATIVE_FX_WH",
            facilityTypeEnumId: "FcTpWarehouse",
            ownerPartyId: f.org,
            facilityName: "Currency spec warehouse"
        })
        call("create#mantle.product.Product", {
            productId: "NATIVE_FX_STOCK",
            productName: "Currency spec stock",
            productTypeEnumId: "PtAsset",
            assetTypeEnumId: "AstTpInventory",
            ownerPartyId: f.org,
            amountUomId: "OTH_ea"
        })
        // cost of goods sold, which DefaultSettings leaves unassigned (impl-accounting F271)
        call("create#mantle.ledger.account.GlAccountOrganization", {glAccountId: "512000000", organizationPartyId: f.org})
        // the asset costed in kroner, as a purchase order in kroner leaves it, then received
        const assetId = call("create#mantle.product.asset.Asset", {
            productId: "NATIVE_FX_STOCK",
            assetTypeEnumId: "AstTpInventory",
            facilityId: "NATIVE_FX_WH",
            ownerPartyId: f.org,
            acquireCost: "10",
            acquireCostUomId: "DKK",
            acquiredDate: ec.user.nowTimestamp,
            quantityOnHandTotal: 0,
            availableToPromiseTotal: 0
        }).assetId
        const received = call("mantle.product.AssetServices.receive#Asset", {
            assetId,
            productId: "NATIVE_FX_STOCK",
            facilityId: "NATIVE_FX_WH",
            quantity: 2,
            ownerPartyId: f.org
        })
        rate("DKK", "1.05", stamp(0))
        const issuance = call("create#mantle.product.issuance.AssetIssuance", {
            assetId: received.assetId,
            productId: "NATIVE_FX_STOCK",
            quantity: 2,
            issuedDate: ec.user.nowTimestamp
        })
        const receipt =
            postings("assetReceiptId", received.assetReceiptId, ["AttInventoryReceipt"])[0] ||
            rows(T, {assetReceiptId: received.assetReceiptId})[0]
        const issue = rows(T, {assetIssuanceId: issuance.assetIssuanceId})[0]
        const inventory = lines(receipt.acctgTransId).find(line => line.debitCreditFlag == "D").glAccountId
        return {
            receipt,
            issue,
            asset: one("mantle.product.asset.Asset", {assetId: received.assetId}),
            net: accountNet(f.org, "assetId", received.assetId, inventory)
        }
    },
    then({receipt, issue, asset, net}) {
        receipt.isPosted == "Y"
        receipt.exchangeRate == "1.1"
        issue.isPosted == "Y"
        issue.exchangeRate == "1.1"
        asset.exchangeRate == "1.1"
        net.isZero()
    }
})
feature("an adjustment posts the receivable the invoice's total after it, at its rate, less what it posted (F419)", {
    when() {
        const invoice = helper().draft(f, "0.03", "NOK")
        finalize(invoice, "fx-nok-adjust")
        call("mantle.account.InvoiceServices.adjust#Invoice", {
            invoiceId: invoice.invoiceId,
            amount: "0.01",
            itemTypeEnumId: "ItemLateCharge"
        })
        return {ar: receivableNet(invoice.invoiceId)}
    },
    then({ar}) {
        ar.eq(ec.l10n.roundCurrency(toDecimal("0.06"), "USD"))
    }
})
feature("an invoice posted again after its posting was reversed takes the rate of its day again (F421)", {
    when() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        // Mantle's own reopen and issue again: the status changes whose SECAs reverse and post the invoice
        const invoiceId = document(f.org, f.customer, "10", "NOK", "InvoiceFinalized", "412000000")
        const first = one("mantle.account.invoice.Invoice", {invoiceId}).exchangeRate
        rate("NOK", "1.6", stamp(0))
        call("update#mantle.account.invoice.Invoice", {invoiceId, statusId: "InvoiceInProcess"})
        call("update#mantle.account.invoice.Invoice", {invoiceId, statusId: "InvoiceFinalized"})
        return {
            first,
            again: one("mantle.account.invoice.Invoice", {invoiceId}).exchangeRate,
            tx: postings("invoiceId", invoiceId, ["AttSalesInvoice"])[0]
        }
    },
    then({first, again, tx}) {
        first == "1.5"
        again == "1.6"
        tx.exchangeRate == "1.6"
    }
})
feature("a bill paid at a higher rate books a loss, again after it is unapplied and applied anew; a credit at its own rate", {
    when() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        const billId = document(f.customer, f.org, "100", "CHF", "InvoiceApproved", "550000000")
        const bill = postings("invoiceId", billId, ["AttPurchaseInvoice"])[0]
        const payable = lines(bill.acctgTransId).find(line => line.debitCreditFlag == "C").glAccountId
        rate("CHF", "1.25", stamp(0))
        const paymentId = call("mantle.account.PaymentServices.create#Payment", {
            fromPartyId: f.org,
            toPartyId: f.customer,
            paymentTypeEnumId: "PtInvoicePayment",
            paymentInstrumentEnumId: "PiCompanyCheck",
            amount: "100",
            amountUomId: "CHF",
            statusId: "PmntDelivered",
            effectiveDate: ec.user.nowTimestamp
        }).paymentId
        const first = call("mantle.account.PaymentServices.apply#InvoicePayment", {paymentId, invoiceId: billId})
        const loss = id =>
            postings("paymentApplicationId", id, ["AttOutgoingPaymentAp"])
                .flatMap(tx => lines(tx.acctgTransId))
                .find(line => line.glAccountTypeEnumId == "GatForExLoss")
        const firstLoss = loss(first.paymentApplicationId)
        call("mantle.account.PaymentServices.unapply#PaymentApplication", {paymentApplicationId: first.paymentApplicationId})
        const unapplied = accountNet(f.org, "invoiceId", billId, payable)
        const again = call("mantle.account.PaymentServices.apply#InvoicePayment", {paymentId, invoiceId: billId})
        // a credit memo at a later rate applied to a receivable at the earlier one
        const invoiceId = document(f.org, f.customer, "100", "CHF", "InvoiceFinalized", "412000000")
        rate("CHF", "1.30", stamp(0))
        login(f.users.financeadmin)
        const creditId = call("mantle.account.InvoiceServices.create#InvoiceCreditMemo", {
            originalInvoiceId: invoiceId,
            amount: "40",
            linkToOriginal: true,
            allocateToLines: true,
            operationKey: "fx-credit"
        }).invoiceId
        call("mantle.account.InvoiceServices.change#InvoiceState", {
            invoiceId: creditId,
            organizationPartyId: f.org,
            action: "finalize",
            lastUpdatedStamp: one("mantle.account.invoice.Invoice", {invoiceId: creditId}).lastUpdatedStamp
        })
        const applied = call("mantle.account.InvoiceServices.apply#InvoiceCredit", {
            invoiceId: creditId,
            toInvoiceId: invoiceId,
            organizationPartyId: f.org,
            amount: "40",
            operationKey: "fx-credit-apply"
        })
        const creditLines = postings("invoiceId", creditId, ["AttInvoiceInOutAppl"]).flatMap(tx => lines(tx.acctgTransId))
        return {
            firstLoss,
            unapplied,
            againLoss: loss(again.paymentApplicationId),
            paid: accountNet(f.org, "invoiceId", billId, payable),
            creditLines,
            applied
        }
    },
    then({firstLoss, unapplied, againLoss, paid, creditLines}) {
        firstLoss.debitCreditFlag == "D"
        firstLoss.amount.eq(10)
        unapplied.eq(-115)
        againLoss.amount.eq(10)
        paid.isZero()
        creditLines
            .filter(line => !line.glAccountTypeEnumId?.startsWith("GatForEx"))
            .map(line => text(line.amount))
            .sort()
            .join(",") == "50.00,52.00"
        creditLines.find(line => line.glAccountTypeEnumId?.startsWith("GatForEx")).amount.eq(2)
    }
})
feature("an application held in the error journal for a missing exchange account books its difference when posted again (F418)", {
    when() {
        login(off.users.financeadmin)
        for (const type of ["GatForExGain", "GatForExLoss"])
            call("delete#mantle.ledger.config.GlAccountTypeDefault", {organizationPartyId: off.org, glAccountTypeEnumId: type})
        const invoice = helper().draft(off, "100", "CHF")
        finalize(invoice, "fx-off-held")
        rate("CHF", "1.40", stamp(0))
        const paid = pay(invoice, "100")
        const held = postings("paymentApplicationId", paid.paymentApplicationId, ["AttIncomingPaymentAp"])[0]
        call("create#mantle.ledger.config.GlAccountTypeDefault", {
            organizationPartyId: off.org,
            glAccountTypeEnumId: "GatForExGain",
            glAccountId: "817000000"
        })
        call("mantle.ledger.LedgerServices.post#AcctgTrans", {acctgTransId: held.acctgTransId})
        return {held, posted: one(T, {acctgTransId: held.acctgTransId}), heldLines: lines(held.acctgTransId)}
    },
    then({held, posted, heldLines}) {
        held.isPosted == "N"
        held.amountUomId == "CHF"
        posted.isPosted == "Y"
        posted.amountUomId == "USD"
        heldLines.find(line => line.glAccountTypeEnumId == "GatForExGain").amount.eq(10)
    }
})
feature("only a finance administrator of every organization stores, imports or accepts a rate (F420)", {
    when() {
        login(f.users.ar)
        return {
            store: refused("mantle.ledger.CurrencyServices.store#Rate", {
                organizationPartyId: f.org,
                uomId: "DKK",
                toUomId: "USD",
                conversionFactor: "1.2",
                fromDate: stamp(0),
                rateSource: "Spec FX",
                changeReason: "Spec rate"
            }),
            imported: refused("mantle.ledger.CurrencyServices.import#Rates", {
                organizationPartyId: f.org,
                csvText: "uomId,toUomId,fromDate,conversionFactor,rateSource\nDKK,USD,2026-01-01,1.2,Spec FX\n",
                changeReason: "Spec rate"
            })
        }
    },
    then({store, imported}) {
        store.includes("PERMISSION_DENIED")
        imported.includes("PERMISSION_DENIED")
    }
})
feature("a revaluation of a cost in another currency changes it at the asset's kept rate, so later issues clear (F417)", {
    when() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        call("create#mantle.product.Product", {
            productId: "NATIVE_FX_REVAL",
            productName: "Currency spec revalued stock",
            productTypeEnumId: "PtAsset",
            assetTypeEnumId: "AstTpInventory",
            ownerPartyId: f.org,
            amountUomId: "OTH_ea"
        })
        // acquired when the krone was at 1.10; revalued and issued now, at 1.05
        const assetId = call("create#mantle.product.asset.Asset", {
            productId: "NATIVE_FX_REVAL",
            assetTypeEnumId: "AstTpInventory",
            facilityId: "NATIVE_FX_WH",
            ownerPartyId: f.org,
            acquireCost: "10",
            acquireCostUomId: "DKK",
            acquiredDate: stamp(-10 * 86400000),
            quantityOnHandTotal: 0,
            availableToPromiseTotal: 0
        }).assetId
        const received = call("mantle.product.AssetServices.receive#Asset", {
            assetId,
            productId: "NATIVE_FX_REVAL",
            facilityId: "NATIVE_FX_WH",
            quantity: 2,
            ownerPartyId: f.org
        })
        call("create#mantle.ledger.config.GlAccountTypeDefault", {
            organizationPartyId: f.org,
            glAccountTypeEnumId: "GatInventoryRevaluation",
            glAccountId: "525000000"
        })
        call("update#mantle.ledger.config.PartyAcctgPreference", {organizationPartyId: f.org, inventoryRevaluationEnabled: "Y"})
        call("create#mantle.product.cost.ProductStandardCost", {
            productStandardCostId: "NATIVE_FX_REVAL_STD",
            productId: "NATIVE_FX_REVAL",
            organizationPartyId: f.org,
            state: "approved",
            fromDate: "2000-01-01T00:00:00Z",
            quantity: 1,
            quantityUomId: "OTH_ea",
            priceUomId: "DKK",
            unitCost: 11,
            totalCost: 11,
            complete: "Y"
        })
        const args = {productStandardCostId: "NATIVE_FX_REVAL_STD", organizationPartyId: f.org, changeReason: "Krone cost rise"}
        const previewed = call("mantle.ledger.AssetBookServices.preview#Revaluation", args)
        const reval = call("mantle.ledger.AssetBookServices.post#Revaluation", {
            previewId: previewed.previewId,
            inputFingerprint: previewed.inputFingerprint,
            operationKey: "fx-reval"
        })
        const issuance = call("create#mantle.product.issuance.AssetIssuance", {
            assetId,
            productId: "NATIVE_FX_REVAL",
            quantity: 2,
            issuedDate: ec.user.nowTimestamp
        })
        const receipt = rows(T, {assetReceiptId: received.assetReceiptId})[0]
        const inventory = lines(receipt.acctgTransId).find(line => line.debitCreditFlag == "D").glAccountId
        let net = toDecimal(0)
        for (const id of [
            receipt.acctgTransId,
            reval.acctgTransId,
            rows(T, {assetIssuanceId: issuance.assetIssuanceId})[0].acctgTransId
        ])
            for (const line of lines(id).filter(
                line => line.glAccountId == inventory && (!line.assetId || line.assetId == assetId)
            ))
                net = line.debitCreditFlag == "D" ? net.add(line.amount) : net.subtract(line.amount)
        return {receipt, revalLines: lines(reval.acctgTransId), net}
    },
    then({receipt, revalLines, net}) {
        receipt.exchangeRate == "1.1"
        revalLines.find(line => line.debitCreditFlag == "D").amount.eq("2.2")
        net.isZero()
    }
})
