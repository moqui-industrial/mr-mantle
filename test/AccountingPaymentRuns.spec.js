// Payment terms and payment runs: a term's discount lines and the due schedule an invoice keeps from them, a settlement
// discount on the discount account, and a supplier payment run that selects due approved bills, leaves out a held one,
// is approved by another user, has its approval voided by a bank-detail change, pays each supplier on its own, writes one
// NACHA file that downloads the same again, and reopens a bill whose payment the bank returns. Standalone: spec-local
// organization, suppliers and users.
const helper = () => ec.resource.script("component://mr-mantle/test/AccountingSettlementFixtures.js")
const runs = (name, p) => helper().call("mantle.account.PaymentRunServices." + name, p)
const refused = (name, p) => helper().rejected(name.includes(".") ? name : "mantle.account.PaymentRunServices." + name, p)
const one = (entity, key) => helper().lib.one(entity, key)
const rows = (entity, key) => helper().lib.rows(entity, key)
const num = value => Number(String(value))
const prefix = "NATIVE_RUN"
const supplierA = prefix + "_SUP_A",
    supplierB = prefix + "_SUP_B",
    term = prefix + "_2_10"
let f, users, bankId, bankA, billA, billB, billHeld, runId, operationKey

function supplier(partyId, name) {
    const h = helper()
    h.call("create#mantle.party.Party", {partyId, partyTypeEnumId: "PtyOrganization"})
    h.call("create#mantle.party.Organization", {partyId, organizationName: name})
    h.call("create#mantle.party.PartyRole", {partyId, roleTypeId: "Supplier"})
    return h.call("mantle.account.PaymentMethodServices.create#BankAccount", {
        ownerPartyId: partyId,
        description: name + " checking",
        bankName: "Supplier Bank",
        routingNumber: "011000015",
        accountNumber: "4440001" + partyId.slice(-1).charCodeAt(0),
        typeEnumId: "BatChecking",
        companyNameOnAccount: name
    }).paymentMethodId
}
function bill(fromPartyId, amount, extra = {}) {
    login("john.doe")
    return helper().invoice(f, amount, "payable", Object.assign({fromPartyId}, extra))
}

spec({
    stepwise: true,
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        const h = helper()
        f = h.fixtures(prefix)
        users = Object.assign({}, f.users, {
            runApprover: h.user(f, "RUNAPP", ["PAYABLE_VIEW", "PAYMENT_RUN_APPROVE"]),
            apAll: h.user(f, "APALL", ["PAYABLE_EDIT", "PAYABLE_VIEW", "PAYMENT_RUN_APPROVE", "INVOICE_HOLD"])
        })
        bankId = h.call("mantle.account.PaymentMethodServices.create#BankAccount", {
            ownerPartyId: f.org,
            description: "Operating account",
            bankName: "Test Bank",
            routingNumber: "021000021",
            accountNumber: "5550009876",
            typeEnumId: "BatChecking",
            currencyUomId: "USD",
            companyNameOnAccount: "Run Org",
            nachaImmedDest: "021000021",
            nachaImmedOrig: "1234567890",
            nachaCompanyId: "1234567890",
            nachaEntryDescription: "SUPPLIERS"
        }).paymentMethodId
        bankA = supplier(supplierA, "Run supplier A")
        supplier(supplierB, "Run supplier B")
    },
    setup() {
        ec.artifactExecution.disableAuthz()
    },
    cleanup() {
        login("john.doe")
    }
})

feature("finance administration saves a term's discount line; other users and portions short of 100 are refused", {
    when() {
        const request = {
            organizationPartyId: f.org,
            settlementTermId: term,
            description: "2% 10, net 30",
            lines: [{portionPercent: "100", daysBasis: 30, discountPercent: "2", discountDays: 10}],
            changeReason: "Supplier terms"
        }
        login(users.ap)
        const denied = helper().rejected("mantle.ledger.SetupServices.store#SettlementTerm", request)
        login(users.financeadmin)
        const short = helper().rejected(
            "mantle.ledger.SetupServices.store#SettlementTerm",
            Object.assign({}, request, {lines: [{portionPercent: "60", daysBasis: 30}]})
        )
        helper().call("create#mantle.account.invoice.SettlementTerm", {
            settlementTermId: term,
            termTypeEnumId: "TtFinPaymentDays"
        })
        const saved = helper().call(
            "mantle.ledger.SetupServices.store#SettlementTerm",
            Object.assign({}, request, {
                lastUpdatedStamp: one("mantle.account.invoice.SettlementTerm", {settlementTermId: term}).lastUpdatedStamp
            })
        )
        const lines = rows("mantle.account.invoice.SettlementTermLine", {settlementTermId: term})
        return {denied, short, saved, lines, stored: one("mantle.account.invoice.SettlementTerm", {settlementTermId: term})}
    },
    then({denied, short, saved, lines, stored}) {
        denied.includes("PERMISSION_DENIED")
        short.includes("TERM_PORTIONS_INVALID")
        saved.linesChanged == true
        lines.length == 1
        num(lines[0].discountPercent) == 2
        num(stored.termValue) == 30
    }
})

feature("an issued bill keeps the due schedule of its term, which a later term change does not alter", {
    when() {
        billA = bill(supplierA, "500", {settlementTermId: term})
        login(users.financeadmin)
        helper().call("mantle.ledger.SetupServices.store#SettlementTerm", {
            organizationPartyId: f.org,
            settlementTermId: term,
            description: "Net 30",
            lines: [{portionPercent: "100", daysBasis: 30}],
            changeReason: "Discount withdrawn",
            lastUpdatedStamp: one("mantle.account.invoice.SettlementTerm", {settlementTermId: term}).lastUpdatedStamp
        })
        login(users.ap)
        const schedule = helper().call("mantle.account.InvoiceServices.get#InvoiceDueSchedule", {invoiceId: billA})
        login(users.ar)
        const denied = helper().rejected("mantle.account.InvoiceServices.get#InvoiceDueSchedule", {invoiceId: billA})
        return {schedule, denied, stored: rows("mantle.account.invoice.InvoiceDueSchedule", {invoiceId: billA})}
    },
    then({schedule, denied, stored}) {
        stored.length == 1
        num(stored[0].amount) == 500
        num(stored[0].discountAmount) == 10
        schedule.scheduleStored == true
        num(schedule.discountAvailable) == 10
        denied.includes("PERMISSION_DENIED")
    }
})

feature("a settlement discount within its date posts to the discount account; more than the terms offer is refused", {
    when() {
        const h = helper()
        login("john.doe")
        const invoiceId = h.invoice(f, "200", "receivable", {settlementTermId: "Net30Disc2Pct10"})
        login(f.users.ar)
        const tooMuch = (() => {
            try {
                h.review(f, [], [{invoiceId, itemTypeEnumId: "ItemPromptDiscount", amount: "5", reason: "Early"}])
                return ""
            } catch (error) {
                ec.message.clearErrors()
                return String(error.message)
            }
        })()
        const preview = h.review(f, [], [{invoiceId, itemTypeEnumId: "ItemPromptDiscount", amount: "4", reason: "Early"}])
        return {tooMuch, preview}
    },
    then({tooMuch, preview}) {
        tooMuch.includes("DISCOUNT_NOT_AVAILABLE")
        preview.adjustmentRows[0].glAccountId == "521000000"
    }
})

feature("a run selects the due approved bills and leaves out a held one with its reason", {
    when() {
        billB = bill(supplierB, "300")
        billHeld = bill(supplierB, "75")
        login(users.apAll)
        helper().call("mantle.account.InvoiceServices.hold#Invoice", {
            invoiceId: billHeld,
            holdReasonEnumId: "IhrSupplierDispute",
            holdComment: "Short shipment"
        })
        login(users.apAll)
        const today = ec.l10n.format(ec.user.nowTimestamp, "yyyy-MM-dd")
        const made = runs("create#Run", {
            organizationPartyId: f.org,
            paymentMethodId: bankId,
            paymentInstrumentEnumId: "PiAch",
            dueThroughDate: "2099-12-31",
            payDate: today
        })
        runId = made.paymentRunId
        const detail = runs("get#Run", {paymentRunId: runId})
        login(users.treasury)
        const deniedCreate = refused("create#Run", {
            organizationPartyId: f.org,
            paymentMethodId: bankId,
            dueThroughDate: today,
            payDate: today
        })
        return {made, detail, deniedCreate}
    },
    then({made, detail, deniedCreate}) {
        made.selectedCount == 2
        made.excludedCount == 1
        num(made.selectedTotal) == 790
        detail.runItems.find(row => row.invoiceId === billHeld).excludeText == "On hold: Supplier dispute"
        num(detail.runItems.find(row => row.invoiceId === billA).discountAmount) == 10
        detail.runItems.find(row => row.invoiceId === billA).bankText.includes("•••• ")
        !JSON.stringify(detail).includes("5550009876")
        detail.run.statusId == "PrunDraft"
        deniedCreate.includes("PERMISSION_DENIED")
    }
})

feature("the run's creator and a user without run approval cannot approve; another approver can", {
    when() {
        const stamp = () => one("mantle.account.payment.PaymentRun", {paymentRunId: runId}).lastUpdatedStamp
        login(users.ap)
        const notice = runs("request#RunApproval", {paymentRunId: runId})
        const noPermission = refused("approve#Run", {paymentRunId: runId, lastUpdatedStamp: stamp()})
        login(users.apAll)
        const self = refused("approve#Run", {paymentRunId: runId, lastUpdatedStamp: stamp()})
        login(users.approve)
        const notApprover = refused("approve#Run", {paymentRunId: runId, lastUpdatedStamp: stamp()})
        login(users.runApprover)
        const approved = runs("approve#Run", {paymentRunId: runId, lastUpdatedStamp: stamp()})
        return {notice, noPermission, self, notApprover, approved}
    },
    then({notice, noPermission, self, notApprover, approved}) {
        notice.notificationMessageId != null
        noPermission.includes("PERMISSION_DENIED")
        self.includes("SELF_APPROVAL_DENIED")
        notApprover.includes("PERMISSION_DENIED")
        approved.statusId == "PrunApproved"
        num(approved.approvedTotal) == 790
    }
})

feature("a supplier's bank-detail change voids the run's approval and the run takes the new account", {
    when() {
        login("john.doe")
        const changed = helper().call("mantle.account.PaymentMethodServices.update#BankAccount", {
            paymentMethodId: bankA,
            accountNumber: "4440999"
        }).paymentMethodId
        const after = one("mantle.account.payment.PaymentRun", {paymentRunId: runId})
        const item = rows("mantle.account.payment.PaymentRunItem", {paymentRunId: runId}).find(row => row.invoiceId === billA)
        login(users.runApprover)
        runs("approve#Run", {paymentRunId: runId, lastUpdatedStamp: after.lastUpdatedStamp})
        return {changed, after, item}
    },
    then({changed, after, item}) {
        changed != bankA
        after.statusId == "PrunDraft"
        after.approvalVoidReason.includes("Bank details of Run supplier A changed")
        item.toPaymentMethodId == changed
    }
})

feature("after approval one supplier's payment fails and the other keeps its payment, discount and file", {
    when() {
        // a hold placed after approval: execution reads the holds again and supplier B is not paid
        login(users.apAll)
        helper().call("mantle.account.InvoiceServices.hold#Invoice", {invoiceId: billB, holdReasonEnumId: "IhrApReview"})
        login(users.ap)
        const notTreasury = refused("execute#Run", {paymentRunId: runId, operationKey: prefix + "-X"})
        login(users.treasury)
        operationKey = prefix + "-" + runId
        const executed = runs("execute#Run", {paymentRunId: runId, operationKey})
        const again = runs("execute#Run", {paymentRunId: runId, operationKey})
        const otherKey = refused("execute#Run", {paymentRunId: runId, operationKey: prefix + "-Y"})
        const detail = runs("get#Run", {paymentRunId: runId})
        const file = runs("get#RunFile", {paymentRunId: runId})
        const regenerated = runs("generate#RunFile", {paymentRunId: runId})
        login("john.doe")
        const paymentA = one("mantle.account.payment.Payment", {
            paymentId: detail.runItems.find(row => row.invoiceId === billA).paymentId
        })
        const credit = rows("mantle.account.invoice.Invoice", {creditForInvoiceId: billA})[0]
        const creditItem = credit && rows("mantle.account.invoice.InvoiceItem", {invoiceId: credit.invoiceId})[0]
        return {
            notTreasury,
            executed,
            again,
            otherKey,
            detail,
            file,
            regenerated,
            paymentA,
            creditItem,
            a: one("mantle.account.invoice.Invoice", {invoiceId: billA}),
            b: one("mantle.account.invoice.Invoice", {invoiceId: billB})
        }
    },
    then({notTreasury, executed, again, otherKey, detail, file, regenerated, paymentA, creditItem, a, b}) {
        notTreasury.includes("PERMISSION_DENIED")
        executed.statusId == "PrunExecuted"
        executed.paidCount == 1
        executed.failedCount == 1
        again.alreadyExecuted == true
        otherKey.includes("RUN_EXECUTED")
        detail.runItems.find(row => row.invoiceId === billB).resultMessage.includes("INVOICE_HELD")
        num(paymentA.amount) == 490
        paymentA.statusId == "PmntDelivered"
        paymentA.toPaymentMethodId == detail.runItems.find(row => row.invoiceId === billA).toPaymentMethodId
        creditItem.itemTypeEnumId == "ItemPromptDiscount"
        creditItem.overrideGlAccountId == "864000000"
        a.statusId == "InvoicePmtSent"
        b.statusId == "InvoiceApproved"
        file.fileText.split("\n").filter(line => line.startsWith("6")).length == 1
        file.fileText.includes(paymentA.paymentId)
        regenerated.fileText == file.fileText
        regenerated.paymentMethodFileId == file.paymentMethodFileId
    }
})

feature("a NACHA return declines the payment, reverses its posting and reopens the bill it paid in full", {
    when() {
        const detail = runs("get#Run", {paymentRunId: runId})
        const paymentId = detail.runItems.find(row => row.invoiceId === billA).paymentId
        const pad = (text, n) => String(text).padEnd(n, " ").slice(0, n)
        const entry =
            "6" +
            "22" +
            "01100001" +
            "5" +
            pad("4440999", 17) +
            "0000049000" +
            pad(paymentId, 15) +
            pad("Run supplier A", 22) +
            "  " +
            "1" +
            "011000010000001"
        const addenda = "7" + "99" + "R03" + "011000010000001" + "      " + "01100001" + pad("No account", 44) + "011000010000009"
        login(users.treasury)
        const imported = runs("import#RunReturn", {
            paymentRunId: runId,
            nachaString: [entry, addenda, "9" + " ".repeat(93)].join("\n")
        })
        const after = runs("get#Run", {paymentRunId: runId})
        login("john.doe")
        const transactions = rows("mantle.ledger.transaction.AcctgTrans", {paymentId})
        return {
            imported,
            item: after.runItems.find(row => row.invoiceId === billA),
            payment: one("mantle.account.payment.Payment", {paymentId}),
            bill: one("mantle.account.invoice.Invoice", {invoiceId: billA}),
            transactions
        }
    },
    then({imported, item, payment, bill, transactions}) {
        imported.returnedPaymentIds.length == 1
        payment.statusId == "PmntDeclined"
        item.resultEnumId == "PrrReturned"
        item.resultMessage.startsWith("R03")
        bill.statusId == "InvoiceApproved"
        num(bill.unpaidTotal) == 500
        transactions.some(row => row.reverseOfAcctgTransId)
    }
})
