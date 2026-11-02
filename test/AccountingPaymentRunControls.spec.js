// Payment run and term controls: a supplier paid once whatever runs it twice, an execution answered from its operation
// record, a run whose bank file fails stays approved and holds its bills until the same key resumes it, a pay date in
// the past and a bank account without NACHA settings are refused, a due schedule rewritten after Resume Changes and kept
// in calendar days, bank accounts added or ended void approvals, a return imported twice changes nothing, and a payable
// discount within its terms is issued without approval while a write-off needs an approver. Standalone.
const helper = () => ec.resource.script("component://mr-mantle/test/AccountingSettlementFixtures.js")
const runs = (name, p) => helper().call("mantle.account.PaymentRunServices." + name, p)
const refused = (name, p) => helper().rejected(name.includes(".") ? name : "mantle.account.PaymentRunServices." + name, p)
const one = (entity, key) => helper().lib.one(entity, key)
const rows = (entity, key) => helper().lib.rows(entity, key)
const num = value => Number(String(value))
const prefix = "NATIVE_RUNC"
const supplierA = prefix + "_SUP_A",
    supplierB = prefix + "_SUP_B"
let f, users, bankId, today

function supplier(partyId, account) {
    const h = helper()
    h.call("create#mantle.party.Party", {partyId, partyTypeEnumId: "PtyOrganization"})
    h.call("create#mantle.party.Organization", {partyId, organizationName: partyId})
    h.call("create#mantle.party.PartyRole", {partyId, roleTypeId: "Supplier"})
    return h.call("mantle.account.PaymentMethodServices.create#BankAccount", {
        ownerPartyId: partyId,
        bankName: "Supplier Bank",
        routingNumber: "011000015",
        accountNumber: account,
        typeEnumId: "BatChecking",
        companyNameOnAccount: partyId
    }).paymentMethodId
}
function bill(fromPartyId, amount, extra = {}) {
    login("john.doe")
    return helper().invoice(f, amount, "payable", Object.assign({fromPartyId}, extra))
}
const stamp = paymentRunId => one("mantle.account.payment.PaymentRun", {paymentRunId}).lastUpdatedStamp
// A run of the organization's bank paying its due bills, approved by the run approver; AP leaves out the bills not named.
function approvedRun(instrument, keep) {
    login(users.ap)
    const made = runs("create#Run", {
        organizationPartyId: f.org,
        paymentMethodId: bankId,
        paymentInstrumentEnumId: instrument,
        dueThroughDate: "2099-12-31",
        payDate: today
    })
    for (const item of rows("mantle.account.payment.PaymentRunItem", {paymentRunId: made.paymentRunId}))
        if (item.selectedIndicator === "Y" && !keep.includes(item.invoiceId))
            runs("store#RunItem", {
                paymentRunId: made.paymentRunId,
                paymentRunItemSeqId: item.paymentRunItemSeqId,
                selectedIndicator: "N"
            })
    login(users.runApprover)
    runs("approve#Run", {paymentRunId: made.paymentRunId, lastUpdatedStamp: stamp(made.paymentRunId)})
    return made.paymentRunId
}
const runItem = (paymentRunId, invoiceId) =>
    rows("mantle.account.payment.PaymentRunItem", {paymentRunId}).find(row => row.invoiceId === invoiceId)

spec({
    stepwise: true,
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        const h = helper()
        f = h.fixtures(prefix)
        today = ec.l10n.format(ec.user.nowTimestamp, "yyyy-MM-dd")
        users = Object.assign({}, f.users, {
            runApprover: h.user(f, "RUNAPP", ["PAYABLE_VIEW", "PAYMENT_RUN_APPROVE"]),
            far: h.user(f, "FAR", ["PAYABLE_VIEW"])
        })
        bankId = h.call("mantle.account.PaymentMethodServices.create#BankAccount", {
            ownerPartyId: f.org,
            bankName: "Test Bank",
            routingNumber: "021000021",
            accountNumber: "5550001111",
            typeEnumId: "BatChecking",
            currencyUomId: "USD",
            companyNameOnAccount: "Run Org",
            lastCheckNumber: 7000,
            nachaImmedDest: "021000021",
            nachaImmedOrig: "1234567890",
            nachaCompanyId: "1234567890",
            nachaEntryDescription: "SUPPLIERS"
        }).paymentMethodId
        supplier(supplierA, "4441001")
        supplier(supplierB, "4441002")
    },
    setup() {
        ec.artifactExecution.disableAuthz()
    },
    cleanup() {
        login("john.doe")
    }
})

feature("a supplier is paid once when its payment runs twice, and the completed execution answers from its record", {
    when() {
        const billA = bill(supplierA, "100")
        const paymentRunId = approvedRun("PiCompanyCheck", [billA])
        login(users.treasury)
        const operationKey = prefix + "-CHK-" + paymentRunId
        runs("claim#RunExecution", {paymentRunId, operationKey})
        runs("pay#RunSupplier", {paymentRunId, supplierPartyId: supplierA})
        runs("pay#RunSupplier", {paymentRunId, supplierPartyId: supplierA})
        const executed = runs("execute#Run", {paymentRunId, operationKey})
        const again = runs("execute#Run", {paymentRunId, operationKey})
        login("john.doe")
        const payments = rows("mantle.account.payment.Payment", {toPartyId: supplierA, fromPartyId: f.org})
        return {executed, again, payments, record: one("mantle.ledger.transaction.PostingOperation", {operationKey})}
    },
    then({executed, again, payments, record}) {
        payments.length == 1
        executed.complete == true
        executed.statusId == "PrunExecuted"
        again.alreadyExecuted == true
        record.operationType == "PaymentRunExecute"
    }
})

feature("an ACH run whose bank file fails stays approved, holds its bills from other runs, and its key resumes it", {
    when() {
        const billB = bill(supplierB, "200")
        const paymentRunId = approvedRun("PiAch", [billB])
        // the bank's entry description is now too long for a NACHA file: the file fails after the payment is made
        helper().call("update#mantle.account.method.BankAccount", {
            paymentMethodId: bankId,
            nachaEntryDescription: "SUPPLIERS-LONG"
        })
        login(users.treasury)
        const operationKey = prefix + "-ACH-" + paymentRunId
        const stuck = runs("execute#Run", {paymentRunId, operationKey})
        const held = runs("get#Run", {paymentRunId})
        login(users.ap)
        const other = runs("create#Run", {
            organizationPartyId: f.org,
            paymentMethodId: bankId,
            paymentInstrumentEnumId: "PiCompanyCheck",
            dueThroughDate: "2099-12-31",
            payDate: today
        })
        const otherItem = runItem(other.paymentRunId, billB)
        runs("cancel#Run", {paymentRunId: other.paymentRunId})
        login("john.doe")
        helper().call("update#mantle.account.method.BankAccount", {paymentMethodId: bankId, nachaEntryDescription: "SUPPLIERS"})
        login(users.treasury)
        const resumed = runs("execute#Run", {paymentRunId, operationKey})
        login("john.doe")
        return {stuck, held, otherItem, resumed, bill: one("mantle.account.invoice.Invoice", {invoiceId: billB}), paymentRunId}
    },
    then({stuck, held, otherItem, resumed, bill}) {
        stuck.complete == false
        stuck.statusId == "PrunApproved"
        stuck.executionMessage.includes("bank file")
        held.capabilities.canResume == true
        held.capabilities.canExecute == false
        held.run.executeOperationKey != null
        otherItem.excludeReasonEnumId == "PrxInOtherRun"
        otherItem.excludeComment.includes("not applied yet")
        resumed.complete == true
        resumed.statusId == "PrunExecuted"
        bill.statusId == "InvoicePmtSent"
    }
})

feature("a return imported again changes nothing", {
    when() {
        login("john.doe")
        const run = rows("mantle.account.payment.PaymentRun", {organizationPartyId: f.org}).find(
            row => row.paymentInstrumentEnumId === "PiAch" && row.statusId === "PrunExecuted"
        )
        const item = rows("mantle.account.payment.PaymentRunItem", {paymentRunId: run.paymentRunId}).find(row => row.paymentId)
        const pad = (text, n) => String(text).padEnd(n, " ").slice(0, n)
        const text = [
            "6" +
                "22" +
                "01100001" +
                "5" +
                pad("4441002", 17) +
                "0000020000" +
                pad(item.paymentId, 15) +
                pad("B", 22) +
                "  1011000010000001",
            "7" + "99" + "R01" + "011000010000001" + "      " + "01100001" + pad("Insufficient funds", 44) + "011000010000009",
            "9" + " ".repeat(93)
        ].join("\n")
        login(users.treasury)
        const first = runs("import#RunReturn", {paymentRunId: run.paymentRunId, nachaString: text})
        const second = runs("import#RunReturn", {paymentRunId: run.paymentRunId, nachaString: text})
        login("john.doe")
        return {
            first,
            second,
            responses: rows("mantle.account.method.PaymentGatewayResponse", {paymentId: item.paymentId}).length,
            returned: runItem(run.paymentRunId, item.invoiceId)
        }
    },
    then({first, second, responses, returned}) {
        first.returnedPaymentIds.length == 1
        second.returnedPaymentIds.length == 0
        responses == 1
        returned.resultEnumId == "PrrReturned"
    }
})

feature("a pay date in the past and a bank account without NACHA settings are refused", {
    when() {
        const billC = bill(supplierA, "30")
        const paymentRunId = approvedRun("PiCompanyCheck", [billC])
        login("john.doe")
        helper().call("update#mantle.account.payment.PaymentRun", {paymentRunId, payDate: "2000-01-03"})
        login(users.treasury)
        const late = refused("execute#Run", {paymentRunId, operationKey: prefix + "-LATE"})
        login(users.ap)
        runs("cancel#Run", {paymentRunId})
        login("john.doe")
        const plainBank = helper().call("mantle.account.PaymentMethodServices.create#BankAccount", {
            ownerPartyId: f.org,
            bankName: "Plain Bank",
            routingNumber: "021000021",
            accountNumber: "5550002222",
            typeEnumId: "BatChecking"
        }).paymentMethodId
        login(users.ap)
        const noNacha = refused("create#Run", {
            organizationPartyId: f.org,
            paymentMethodId: plainBank,
            paymentInstrumentEnumId: "PiAch",
            dueThroughDate: today,
            payDate: today
        })
        return {late, noNacha}
    },
    then({late, noNacha}) {
        late.includes("PAY_DATE_PAST")
        noNacha.includes("BANK_ACCOUNT_NACHA_MISSING")
    }
})

feature("a supplier's bank account added or ended voids an approved run that pays it", {
    when() {
        const billD = bill(supplierA, "40")
        const paymentRunId = approvedRun("PiAch", [billD])
        login("john.doe")
        const newBank = helper().call("mantle.account.PaymentMethodServices.create#BankAccount", {
            ownerPartyId: supplierA,
            bankName: "New Bank",
            routingNumber: "011000015",
            accountNumber: "4449999",
            typeEnumId: "BatChecking",
            companyNameOnAccount: supplierA
        }).paymentMethodId
        const afterAdd = one("mantle.account.payment.PaymentRun", {paymentRunId})
        const takesNew = runItem(paymentRunId, billD).toPaymentMethodId
        login(users.runApprover)
        runs("approve#Run", {paymentRunId, lastUpdatedStamp: stamp(paymentRunId)})
        login("john.doe")
        helper().call("mantle.account.PaymentMethodServices.delete#PaymentMethod", {paymentMethodId: newBank})
        const afterEnd = one("mantle.account.payment.PaymentRun", {paymentRunId})
        login(users.ap)
        runs("cancel#Run", {paymentRunId})
        return {newBank, afterAdd, takesNew, afterEnd}
    },
    then({newBank, afterAdd, takesNew, afterEnd}) {
        afterAdd.statusId == "PrunDraft"
        takesNew == newBank
        afterEnd.statusId == "PrunDraft"
    }
})

feature("a due schedule is rewritten when an approved bill is changed and approved again", {
    when() {
        const billE = bill(supplierA, "1000", {settlementTermId: "Net30Disc2Pct10"})
        const first = rows("mantle.account.invoice.InvoiceDueSchedule", {invoiceId: billE})
        helper().call("update#mantle.account.invoice.Invoice", {invoiceId: billE, statusId: "InvoiceReceived"})
        const cleared = rows("mantle.account.invoice.InvoiceDueSchedule", {invoiceId: billE})
        const item = rows("mantle.account.invoice.InvoiceItem", {invoiceId: billE})[0]
        helper().call("update#mantle.account.invoice.InvoiceItem", {
            invoiceId: billE,
            invoiceItemSeqId: item.invoiceItemSeqId,
            amount: "800"
        })
        helper().call("update#mantle.account.invoice.Invoice", {invoiceId: billE, statusId: "InvoiceApproved"})
        const second = rows("mantle.account.invoice.InvoiceDueSchedule", {invoiceId: billE})
        // read by a user far ahead of the server's zone: the dates are the bill's book day and its days
        helper().call("update#moqui.security.UserAccount", {userId: users.far, timeZone: "Pacific/Kiritimati"})
        login(users.far)
        const far = helper().call("mantle.account.InvoiceServices.get#InvoiceDueSchedule", {invoiceId: billE})
        login("john.doe")
        const bookDay = helper().lib.policy.calendarDateText(
            one("mantle.account.invoice.Invoice", {invoiceId: billE}).accountingDate
        )
        const terms = ec.resource.script("component://mr-mantle/service/mantle/account/PaymentTerms.js")
        return {first, cleared, second, far, expected: terms.addDays(bookDay, 10)}
    },
    then({first, cleared, second, far, expected}) {
        num(first[0].discountAmount) == 20
        cleared.length == 0
        num(second[0].amount) == 800
        num(second[0].discountAmount) == 16
        far.scheduleRows[0].discountDateText == expected
    }
})

feature("a payable discount within its terms is issued without approval; AP's write-off is refused for approval", {
    when() {
        const h = helper()
        const billF = bill(supplierA, "500", {settlementTermId: "Net30Disc2Pct10"})
        const scope = {organizationPartyId: f.org, partyId: supplierA, direction: "payable", currencyUomId: "USD"}
        const review = adjustments => {
            const keys = adjustments.map(row => h.key("invoice", row.invoiceId))
            const selected = h.native("find#OpenItems", Object.assign({selectedKeyList: keys}, scope)).selectedRows
            return h.native(
                "preview#Settlement",
                Object.assign({}, scope, {
                    effectiveDate: f.timestamp,
                    adjustments,
                    sourceVersions: Object.fromEntries(selected.map(row => [row.sourceKey, row.version]))
                })
            )
        }
        login(users.ap)
        let writeOff = ""
        try {
            review([{invoiceId: billF, itemTypeEnumId: "ItemWriteOff", amount: "5", glAccountId: "550000000", reason: "Small"}])
        } catch (error) {
            ec.message.clearErrors()
            writeOff = String(error.message)
        }
        const preview = review([{invoiceId: billF, itemTypeEnumId: "ItemPromptDiscount", amount: "10", reason: "Early"}])
        const applied = h.confirm(preview)
        login("john.doe")
        const credit = one("mantle.account.invoice.Invoice", {invoiceId: applied.adjustmentInvoiceIds[0]})
        const issued = ["InvoiceFinalized", "InvoicePmtRecvd", "InvoicePmtSent"].includes(credit.statusId)
        return {writeOff, applied, credit, issued}
    },
    then({writeOff, applied, credit, issued}) {
        writeOff.includes("ADJUSTMENT_APPROVAL_REQUIRED")
        applied.adjustmentInvoiceIds.length == 1
        credit.creditForInvoiceId != null
        credit.financeDirection == "payable"
        issued == true
    }
})

feature("a bill another run took is not put back nor paid twice, and a failed supplier's bills are free again", {
    when() {
        const billX = bill(supplierA, "70"),
            billW = bill(supplierB, "35")
        // run A selects X, then AP leaves it out
        login(users.ap)
        const runA = runs("create#Run", {
            organizationPartyId: f.org,
            paymentMethodId: bankId,
            paymentInstrumentEnumId: "PiCompanyCheck",
            dueThroughDate: "2099-12-31",
            payDate: today
        }).paymentRunId
        const itemA = runItem(runA, billX)
        for (const item of rows("mantle.account.payment.PaymentRunItem", {paymentRunId: runA}))
            if (item.selectedIndicator === "Y")
                runs("store#RunItem", {paymentRunId: runA, paymentRunItemSeqId: item.paymentRunItemSeqId, selectedIndicator: "N"})
        // run B pays X and W; W is held after approval and its supplier fails; B's bank file fails, so X's payment waits
        const runB = approvedRun("PiAch", [billX, billW])
        login("john.doe")
        helper().call("mantle.account.InvoiceServices.hold#Invoice", {invoiceId: billW, holdReasonEnumId: "IhrApReview"})
        login("john.doe")
        helper().call("update#mantle.account.method.BankAccount", {
            paymentMethodId: bankId,
            nachaEntryDescription: "SUPPLIERS-LONG"
        })
        login(users.treasury)
        const keyB = prefix + "-B-" + runB
        const stuck = runs("execute#Run", {paymentRunId: runB, operationKey: keyB})
        const failedW = runItem(runB, billW)
        // X cannot go back into A
        login(users.ap)
        const putBack = refused("store#RunItem", {
            paymentRunId: runA,
            paymentRunItemSeqId: itemA.paymentRunItemSeqId,
            selectedIndicator: "Y"
        })
        // forced back (a race): paying it in A is refused while B's payment for it is not applied
        login("john.doe")
        helper().call("update#mantle.account.payment.PaymentRunItem", {
            paymentRunId: runA,
            paymentRunItemSeqId: itemA.paymentRunItemSeqId,
            selectedIndicator: "Y",
            excludeReasonEnumId: null
        })
        login(users.runApprover)
        runs("approve#Run", {paymentRunId: runA, lastUpdatedStamp: stamp(runA)})
        login(users.treasury)
        runs("claim#RunExecution", {paymentRunId: runA, operationKey: prefix + "-A-" + runA})
        const payTwice = refused("pay#RunSupplier", {paymentRunId: runA, supplierPartyId: supplierA})
        // W, which failed in the unfinished run B, is selected by a new run once its hold is released
        login("john.doe")
        const hold = rows("mantle.account.invoice.InvoiceHold", {invoiceId: billW})[0]
        helper().call("update#mantle.account.invoice.InvoiceHold", {
            invoiceHoldId: hold.invoiceHoldId,
            releasedDate: ec.user.nowTimestamp
        })
        login(users.ap)
        const runE = runs("create#Run", {
            organizationPartyId: f.org,
            paymentMethodId: bankId,
            paymentInstrumentEnumId: "PiCompanyCheck",
            dueThroughDate: "2099-12-31",
            payDate: today
        }).paymentRunId
        const itemW = runItem(runE, billW)
        runs("cancel#Run", {paymentRunId: runE})
        // B finishes once its file is written
        login("john.doe")
        helper().call("update#mantle.account.method.BankAccount", {paymentMethodId: bankId, nachaEntryDescription: "SUPPLIERS"})
        login(users.treasury)
        const resumed = runs("execute#Run", {paymentRunId: runB, operationKey: keyB})
        login("john.doe")
        return {stuck, putBack, payTwice, itemW, resumed, failedW}
    },
    then({stuck, putBack, payTwice, itemW, resumed, failedW}) {
        stuck.complete == false
        failedW.resultEnumId == "PrrFailed"
        putBack.includes("RUN_ITEM_IN_OTHER_RUN")
        payTwice.includes("RUN_ITEM_IN_OTHER_RUN")
        itemW.selectedIndicator == "Y"
        resumed.complete == true
    }
})

feature("a run payment declined by a NACHA return imported outside the run shows Returned", {
    when() {
        login("john.doe")
        const run = rows("mantle.account.payment.PaymentRun", {organizationPartyId: f.org})
            .filter(row => row.paymentInstrumentEnumId === "PiAch" && row.statusId === "PrunExecuted")
            .sort((a, b) => b.paymentRunId.localeCompare(a.paymentRunId))[0]
        const item = rows("mantle.account.payment.PaymentRunItem", {paymentRunId: run.paymentRunId}).find(
            row => row.paymentId && row.resultEnumId === "PrrPaid"
        )
        const payment = one("mantle.account.payment.Payment", {paymentId: item.paymentId})
        const pad = (text, n) => String(text).padEnd(n, " ").slice(0, n)
        const cents = String(Math.round(num(payment.amount) * 100)).padStart(10, "0")
        const text = [
            "6" +
                "22" +
                "01100001" +
                "5" +
                pad("4441001", 17) +
                cents +
                pad(item.paymentId, 15) +
                pad("A", 22) +
                "  1011000010000001",
            "7" + "99" + "R02" + "011000010000001" + "      " + "01100001" + pad("Account closed", 44) + "011000010000009",
            "9" + " ".repeat(93)
        ].join("\n")
        helper().call("mantle.ext.account.NachaServices.import#NachaReturn", {paymentMethodId: bankId, nachaString: text})
        return {item: runItem(run.paymentRunId, item.invoiceId)}
    },
    then({item}) {
        item.resultEnumId == "PrrReturned"
        item.resultMessage.startsWith("R02")
    }
})

feature("a lapsed discount is not taken by dating the settlement back, nor on another account without approval", {
    when() {
        const h = helper()
        const back = n => ec.l10n.format(new Date(Number(ec.user.nowTimestamp) - n * 86400000), "yyyy-MM-dd")
        const oldDay = back(20)
        const billG = bill(supplierA, "300", {
            settlementTermId: "Net30Disc2Pct10",
            invoiceDate: ec.l10n.parseTimestamp(oldDay + " 12:00:00", "yyyy-MM-dd HH:mm:ss"),
            accountingDate: oldDay
        })
        const billH = bill(supplierA, "400", {settlementTermId: "Net30Disc2Pct10"})
        const scope = {organizationPartyId: f.org, partyId: supplierA, direction: "payable", currencyUomId: "USD"}
        const review = (adjustments, effectiveDate) => {
            const keys = adjustments.map(row => h.key("invoice", row.invoiceId))
            const selected = h.native("find#OpenItems", Object.assign({selectedKeyList: keys}, scope)).selectedRows
            return h.native(
                "preview#Settlement",
                Object.assign({}, scope, {
                    effectiveDate,
                    adjustments,
                    sourceVersions: Object.fromEntries(selected.map(row => [row.sourceKey, row.version]))
                })
            )
        }
        const refusal = run => {
            try {
                run()
                return ""
            } catch (error) {
                ec.message.clearErrors()
                return String(error.message)
            }
        }
        login(users.ap)
        const backdated = refusal(() =>
            review([{invoiceId: billG, itemTypeEnumId: "ItemPromptDiscount", amount: "6", reason: "Early"}], back(15))
        )
        const otherAccount = refusal(() =>
            review(
                [
                    {
                        invoiceId: billH,
                        itemTypeEnumId: "ItemPromptDiscount",
                        amount: "8",
                        glAccountId: "550000000",
                        reason: "Early"
                    }
                ],
                f.timestamp
            )
        )
        const direct = h.rejected("mantle.account.InvoiceServices.create#InvoiceCreditMemo", {
            originalInvoiceId: billH,
            organizationPartyId: f.org,
            linkToOriginal: true,
            promptDiscount: true,
            amount: "8",
            overrideGlAccountId: "550000000"
        })
        return {backdated, otherAccount, direct}
    },
    then({backdated, otherAccount, direct}) {
        backdated.includes("DISCOUNT_NOT_AVAILABLE")
        otherAccount.includes("ADJUSTMENT_APPROVAL_REQUIRED")
        direct.includes("DISCOUNT_ACCOUNT_FIXED")
    }
})
