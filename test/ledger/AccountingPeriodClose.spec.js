// Period close (CloseServices): the checklist names an unposted invoice and an unfinished bank statement and leaves out
// another organization's open work; once they are dealt with the period closes with its summary rows stored; a
// backdated invoice, refund and reversal are then refused alike; a reopen is audited and keeps the close; a fiscal
// year's close posts its closing entries to the organization's own net income account. With the invoice
// reconciliation report. Spec-local organizations, periods and users.
const fixtures = () => ec.resource.script("component://mr-mantle/test/account/AccountingSettlementFixtures.js")
const close = "mantle.ledger.CloseServices."
let f, other
function asUser(userId, run) {
    login(userId)
    try {
        return run()
    } finally {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
    }
}
function rejected(name, p) {
    return fixtures().rejected(name, p)
}
function period(timePeriodId) {
    return ec.entity.find("mantle.party.time.TimePeriod").condition("timePeriodId", timePeriodId).disableAuthz().one()
}
function row(rows, checkEnumId) {
    return Array.from(rows).find(r => r.checkEnumId === checkEnumId) || {items: []}
}
// The first and last day of the month before today's, and a timestamp at noon on its 15th.
function lastMonth(day) {
    const [y, m] = day.split("-").map(Number)
    const first = new Date(Date.UTC(y, m - 2, 1)),
        last = new Date(Date.UTC(y, m - 1, 0))
    const text = d =>
        [d.getUTCFullYear(), String(d.getUTCMonth() + 1).padStart(2, "0"), String(d.getUTCDate()).padStart(2, "0")].join("-")
    const mid = text(first).slice(0, 8) + "15"
    return {from: text(first), thru: text(last), mid, noon: ec.l10n.parseTimestamp(mid + " 12:00:00", "yyyy-MM-dd HH:mm:ss")}
}
function monthPeriod(org, month) {
    return call("mantle.party.TimeServices.create#TimePeriod", {
        partyId: org,
        timePeriodTypeId: "FiscalMonth",
        fromDate: month.from,
        thruDate: month.thru
    }).timePeriodId
}
function draftInvoice(org, customer, month) {
    const made = call("create#mantle.account.invoice.Invoice", {
        invoiceTypeEnumId: "InvoiceSales",
        fromPartyId: org,
        toPartyId: customer,
        statusId: "InvoiceInProcess",
        invoiceDate: month.noon,
        accountingDate: month.mid,
        currencyUomId: "USD",
        draftedByUserId: ec.user.userId
    })
    call("mantle.account.InvoiceServices.create#InvoiceItem", {
        invoiceId: made.invoiceId,
        quantity: "1",
        amount: "100",
        itemTypeEnumId: "ItemTimeEntry",
        overrideGlAccountId: "412000000",
        description: "Close source"
    })
    return made.invoiceId
}

spec({
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        const h = fixtures()
        f = h.fixtures("ACCT_P11_CLOSE")
        other = h.fixtures("ACCT_P11_OTHER")
        f.month = lastMonth(f.day)
        f.periodId = monthPeriod(f.org, f.month)
        other.periodId = monthPeriod(other.org, f.month)
        f.users.closer = h.user(f, "CLOSER", ["ACCOUNTING_VIEW", "FISCAL_CLOSE"])
        f.users.reopener = h.user(f, "REOPENER", ["ACCOUNTING_VIEW", "FISCAL_REOPEN"])
        f.users.gl = h.user(f, "GLPOST", ["ACCOUNTING_VIEW", "ACCOUNTING_GL_POST"])
        // a user who holds both GL posting and period close, for the refusals of closing entries outside a close
        f.users.glClose = h.user(f, "GLCLOSE", ["ACCOUNTING_VIEW", "ACCOUNTING_GL_POST", "FISCAL_CLOSE"])
        // last month's work: a draft invoice, a delivered receipt, a bank line no statement cleared
        f.invoiceId = draftInvoice(f.org, f.customer, f.month)
        f.receiptId = h.payment(f, "40", "receivable", {effectiveDate: f.month.noon})
        f.bankId = "ACCT_P11_CLOSE_BANK"
        call("create#mantle.account.method.PaymentMethod", {
            paymentMethodId: f.bankId,
            ownerPartyId: f.org,
            paymentMethodTypeEnumId: "PmtBankAccount",
            currencyUomId: "USD",
            fromDate: 0,
            description: "Close bank",
            glAccountId: "111100000"
        })
        call("mantle.account.ReconciliationServices.create#PaymentMethodTrans", {
            paymentMethodId: f.bankId,
            fitId: "P11-FEE",
            postedDate: f.month.noon,
            transAmount: "-5",
            transType: "PMTT_SRVCHG"
        })
        // the other organization's open work of the same month
        call("mantle.ledger.LedgerServices.create#AcctgTrans", {
            acctgTransTypeEnumId: "AttInternal",
            organizationPartyId: other.org,
            transactionDate: f.month.noon,
            description: "Other organization's draft"
        })
        draftInvoice(other.org, other.customer, f.month)
    },
    setup() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
    }
})

feature("the checklist names the unposted invoice and the unfinished statement; another organization's work is not in it", {
    when() {
        const p = {organizationPartyId: f.org, timePeriodId: f.periodId}
        const checklist = asUser(f.users.closer, () => call(close + "get#Checklist", p))
        const blocked = asUser(f.users.closer, () => rejected(close + "close#Period", p))
        const denied = asUser(f.users.read, () => rejected(close + "close#Period", p))
        const foreign = asUser(f.users.closer, () =>
            rejected(close + "get#Checklist", {organizationPartyId: f.org, timePeriodId: other.periodId})
        )
        // Mantle's own close counts only the organization's unposted transactions
        return {checklist, blocked, denied, foreign, closedState: period(f.periodId).isClosed}
    },
    then({checklist, blocked, denied, foreign, closedState}) {
        row(checklist.checkRows, "PccPeriodOrder").status == "clear"
        row(checklist.checkRows, "PccUnpostedDocuments")
            .items.map(i => i.recordId)
            .join() == f.invoiceId
        row(checklist.checkRows, "PccUnpostedDocuments").items[0].recordKind == "invoices"
        row(checklist.checkRows, "PccBankStatements").items[0].recordKind == "banks"
        row(checklist.checkRows, "PccBankStatements").items[0].text.includes("1 lines not on a finished statement")
        row(checklist.checkRows, "PccUnpostedTransactions").count == 0
        checklist.blockerCount == 2 && checklist.canClose == false
        blocked.includes("CLOSE_BLOCKED") && blocked.includes("Unposted invoices") && blocked.includes("Bank lines")
        denied.includes("PERMISSION_DENIED")
        foreign.includes("PERIOD_UNAVAILABLE") || foreign.includes("RECORD_UNAVAILABLE")
        closedState == "N"
    }
})
feature("once the invoice is posted and the statement finished, the period closes with its summary rows stored", {
    when() {
        call("update#mantle.account.invoice.Invoice", {invoiceId: f.invoiceId, statusId: "InvoiceFinalized"})
        asUser(f.users.treasury, () => {
            const statement = call("mantle.account.ReconciliationServices.create#Reconciliation", {
                paymentMethodId: f.bankId,
                statementReference: "Close statement",
                statementFromDate: f.month.from,
                statementThruDate: f.month.thru,
                openingBalance: "0",
                closingBalance: "-5"
            })
            call("mantle.account.ReconciliationServices.noReconcile#PaymentMethodTrans", {
                paymentMethodId: f.bankId,
                fitId: "P11-FEE",
                noReconcileReason: "Fee booked at month end"
            })
            call("mantle.account.ReconciliationServices.store#Reconciliation", {
                bankReconciliationId: statement.bankReconciliationId,
                clearFitIdList: ["P11-FEE"]
            })
            call("mantle.account.ReconciliationServices.finish#Reconciliation", {
                bankReconciliationId: statement.bankReconciliationId
            })
        })
        const p = {organizationPartyId: f.org, timePeriodId: f.periodId, changeReason: "Month end", operationKey: "p11-close-1"}
        const checklist = asUser(f.users.closer, () => call(close + "get#Checklist", p))
        const closed = asUser(f.users.closer, () => call(close + "close#Period", p))
        const again = asUser(f.users.closer, () => call(close + "close#Period", p))
        const summaries = Array.from(
            ec.entity
                .find("mantle.ledger.account.GlAccountOrgTimePeriod")
                .condition({organizationPartyId: f.org, timePeriodId: f.periodId})
                .disableAuthz()
                .list()
        )
        const trial = asUser(f.users.read, () =>
            call("mantle.ledger.FinanceReportServices.run#TrialBalance", {organizationPartyId: f.org, timePeriodId: f.periodId})
        )
        const reconciliation = asUser(f.users.read, () =>
            call("mantle.ledger.LedgerReportServices.run#InvoiceReconciliation", {
                organizationPartyId: f.org,
                timePeriodId: f.periodId
            })
        )
        const truncated = asUser(f.users.read, () =>
            call("mantle.ledger.LedgerReportServices.run#InvoiceReconciliation", {
                organizationPartyId: f.org,
                timePeriodId: f.periodId,
                listLimit: 0
            })
        )
        const otherReport = asUser(f.users.read, () =>
            rejected("mantle.ledger.LedgerReportServices.run#InvoiceReconciliation", {
                organizationPartyId: other.org,
                timePeriodId: other.periodId
            })
        )
        const run = ec.entity
            .find("mantle.ledger.transaction.AccountingCloseRun")
            .condition("closeRunId", closed.closeRunId)
            .disableAuthz()
            .one()
        return {
            checklist,
            closed,
            again,
            summaries,
            trial,
            reconciliation,
            truncated,
            otherReport,
            run,
            state: period(f.periodId).isClosed
        }
    },
    then({checklist, closed, again, summaries, trial, reconciliation, truncated, otherReport, run, state}) {
        reconciliation.complete == true
        truncated.complete == false && truncated.incompleteChecks.includes("invoiceVsGl")
        checklist.blockerCount == 0 && checklist.canClose == true
        state == "Y"
        run.statusId == "CrnClosed" && run.closeReason == "Month end" && run.checklistJson.includes("PccBankStatements")
        again.alreadyApplied == true && again.closeRunId == closed.closeRunId
        summaries.find(s => s.glAccountId == "412000000").postedCredits == 100
        summaries.find(s => s.glAccountId == "412000000").endingBalance == 100
        summaries.length == run.summaryAccountCount
        trial.reportRows.find(r => r.glAccountId == "412000000").credits == 100
        trial.reportRows.find(r => r.glAccountId == "412000000").closedSummary == true
        reconciliation.reportRows.filter(r => r.check == "invoiceVsGl").length == 0
        reconciliation.summary.agingOpen.compare(0) > 0
        otherReport.includes("ORGANIZATION_DENIED") || otherReport.includes("RECORD_UNAVAILABLE")
    }
})
feature("after the close a backdated invoice, refund and reversal are refused alike", {
    when() {
        const invoiceId = draftInvoice(f.org, f.customer, f.month)
        f.lateInvoiceId = invoiceId
        const invoice = ec.entity.find("mantle.account.invoice.Invoice").condition("invoiceId", invoiceId).disableAuthz().one()
        const invoiceRefused = asUser(f.users.ar, () =>
            rejected("mantle.account.InvoiceServices.change#InvoiceState", {
                organizationPartyId: f.org,
                invoiceId,
                action: "finalize",
                lastUpdatedStamp: invoice.lastUpdatedStamp,
                operationKey: "p11-late-invoice"
            })
        )
        const refundRefused = rejected("mantle.account.PaymentServices.create#RefundPayment", {
            paymentId: f.receiptId,
            amount: "10",
            statusId: "PmntDelivered",
            effectiveDate: f.month.noon
        })
        const posting = ec.entity
            .find("mantle.ledger.transaction.AcctgTrans")
            .condition({invoiceId: f.invoiceId, isPosted: "Y"})
            .disableAuthz()
            .list()[0]
        const reversalRefused = asUser(f.users.gl, () =>
            rejected("mantle.ledger.LedgerServices.post#ReverseAcctgTrans", {
                acctgTransId: posting.acctgTransId,
                reversalDate: f.month.noon,
                changeReason: "Late correction"
            })
        )
        return {invoiceRefused, refundRefused, reversalRefused}
    },
    then({invoiceRefused, refundRefused, reversalRefused}) {
        invoiceRefused.includes("PERIOD_CLOSED") || invoiceRefused.includes("closed")
        refundRefused.includes("PERIOD_CLOSED") || refundRefused.includes("closed")
        reversalRefused.includes("PERIOD_CLOSED") || reversalRefused.includes("closed")
    }
})
feature("a reopen needs FISCAL_REOPEN and a reason, keeps the close run marked reopened, and the next close is a new run", {
    when() {
        const p = {organizationPartyId: f.org, timePeriodId: f.periodId}
        const closerRefused = asUser(f.users.closer, () =>
            rejected(close + "reopen#Period", Object.assign({changeReason: "x"}, p))
        )
        const noReason = asUser(f.users.reopener, () => rejected(close + "reopen#Period", p))
        const reopened = asUser(f.users.reopener, () =>
            call(close + "reopen#Period", Object.assign({changeReason: "Late supplier bill"}, p))
        )
        const openState = period(f.periodId).isClosed
        call("update#mantle.account.invoice.Invoice", {invoiceId: f.lateInvoiceId, statusId: "InvoiceCancelled"})
        const closedAgain = asUser(f.users.closer, () => call(close + "close#Period", p))
        const runs = Array.from(
            ec.entity
                .find("mantle.ledger.transaction.AccountingCloseRun")
                .condition("timePeriodId", f.periodId)
                .orderBy("closedDate")
                .disableAuthz()
                .list()
        )
        return {closerRefused, noReason, reopened, openState, closedAgain, runs}
    },
    then({closerRefused, noReason, reopened, openState, closedAgain, runs}) {
        closerRefused.includes("PERMISSION_DENIED")
        noReason.includes("CHANGE_REASON_REQUIRED")
        openState == "N"
        runs.length == 2
        runs.find(r => r.closeRunId == reopened.closeRunId).statusId == "CrnReopened"
        runs.find(r => r.closeRunId == reopened.closeRunId).reopenReason == "Late supplier bill"
        runs.find(r => r.closeRunId == closedAgain.closeRunId).statusId == "CrnClosed"
    }
})
feature("a fiscal year's close posts its closing entries to the organization's own net income account", {
    when() {
        const yearId = call("mantle.party.TimeServices.create#TimePeriod", {
            partyId: f.org,
            timePeriodTypeId: "FiscalYear",
            fromDate: "2023-01-01",
            thruDate: "2023-12-31"
        }).timePeriodId
        const made = call("mantle.ledger.LedgerServices.create#AcctgTrans", {
            acctgTransTypeEnumId: "AttInternal",
            organizationPartyId: f.org,
            transactionDate: ec.l10n.parseTimestamp("2023-06-15 12:00:00", "yyyy-MM-dd HH:mm:ss"),
            description: "Year revenue"
        })
        for (const [glAccountId, debitCreditFlag] of [
            ["111100000", "D"],
            ["412000000", "C"]
        ])
            call("mantle.ledger.LedgerServices.create#AcctgTransEntry", {
                acctgTransId: made.acctgTransId,
                glAccountId,
                debitCreditFlag,
                amount: "70"
            })
        asUser(f.users.gl, () => call("mantle.ledger.LedgerServices.post#AcctgTrans", {acctgTransId: made.acctgTransId}))
        const closed = asUser(f.users.closer, () =>
            call(close + "close#Period", {organizationPartyId: f.org, timePeriodId: yearId, changeReason: "Year end"})
        )
        const entries = Array.from(
            ec.entity
                .find("mantle.ledger.transaction.AcctgTransEntry")
                .condition("acctgTransId", "in", Array.from(closed.closingAcctgTransIdList))
                .disableAuthz()
                .list()
        )
        const revenue = ec.entity
            .find("mantle.ledger.account.GlAccountOrgTimePeriod")
            .condition({organizationPartyId: f.org, timePeriodId: yearId, glAccountId: "412000000"})
            .disableAuthz()
            .one()
        return {closed, entries, revenue}
    },
    then({closed, entries, revenue}) {
        closed.closingAcctgTransIdList.length == 1
        entries.find(e => e.glAccountId == "412000000").debitCreditFlag == "D"
        entries.find(e => e.glAccountId == "850000000").amount == 70
        revenue.endingBalance == 0 && revenue.postedCreditsNoClosing == 70
    }
})
// Closing entries are posted only by close#Period: a closing-typed draft, template, template instance or reversal is
// refused, and a closing-typed transaction posted directly into the closed month or a hard-locked one is refused too,
// for a user who holds GL posting and period close.
feature("closing-typed entries outside a close are refused, into a closed month or past a hard lock", {
    when() {
        const day = f.month.noon
        const draft = asUser(f.users.glClose, () =>
            rejected("mantle.ledger.JournalServices.store#DraftEntry", {
                organizationPartyId: f.org,
                acctgTransTypeEnumId: "AttNetIncomeClosing",
                transactionDate: day,
                description: "Not a close"
            })
        )
        const template = asUser(f.users.glClose, () =>
            rejected("mantle.ledger.JournalServices.store#Template", {
                organizationPartyId: f.org,
                templateName: "Closing template",
                acctgTransTypeEnumId: "AttNetIncomeClosing"
            })
        )
        call("create#mantle.ledger.transaction.AcctgTransTemplate", {
            acctgTransTemplateId: "P11_CLOSING_TEMPLATE",
            organizationPartyId: f.org,
            templateName: "Old closing template",
            acctgTransTypeEnumId: "AttNetIncomeClosing",
            amountUomId: "USD",
            isPublished: "Y",
            fromDate: 0,
            templateVersion: 1
        })
        const instance = asUser(f.users.glClose, () =>
            rejected("mantle.ledger.JournalServices.create#FromTemplate", {
                organizationPartyId: f.org,
                acctgTransTemplateId: "P11_CLOSING_TEMPLATE",
                transactionDate: day
            })
        )
        // a closing-typed transaction made directly, posted into the closed month
        const raw = type => {
            const made = call("mantle.ledger.LedgerServices.create#AcctgTrans", {
                acctgTransTypeEnumId: type,
                organizationPartyId: f.org,
                transactionDate: day,
                description: "Direct closing entry"
            })
            call("update#mantle.ledger.transaction.AcctgTrans", {acctgTransId: made.acctgTransId, accountingDate: f.month.mid})
            for (const [glAccountId, debitCreditFlag] of [
                ["412000000", "D"],
                ["850000000", "C"]
            ])
                call("mantle.ledger.LedgerServices.create#AcctgTransEntry", {
                    acctgTransId: made.acctgTransId,
                    glAccountId,
                    debitCreditFlag,
                    amount: "1"
                })
            return made.acctgTransId
        }
        const closedId = raw("AttNetIncomeClosing")
        const closedPost = asUser(f.users.glClose, () =>
            rejected("mantle.ledger.LedgerServices.post#AcctgTrans", {acctgTransId: closedId, closingTimePeriodId: f.periodId})
        )
        // a reversal of a closing entry is refused whatever its date
        call("update#mantle.ledger.transaction.AcctgTrans", {acctgTransId: closedId, isPosted: "Y"})
        const reversal = asUser(f.users.glClose, () =>
            rejected("mantle.ledger.JournalServices.reverse#Entry", {
                organizationPartyId: f.org,
                acctgTransId: closedId,
                reversalDate: day,
                operationKey: "p11-closing-reversal",
                changeReason: "Undo the close"
            })
        )
        call("update#mantle.ledger.transaction.AcctgTrans", {acctgTransId: closedId, isPosted: "N"})
        // a hard lock through today, in this month's open period
        const lock = asUser(f.users.financeadmin, () =>
            call("mantle.ledger.CloseServices.store#Lock", {
                organizationPartyId: f.org,
                lockScope: "all",
                lockThroughDate: f.day,
                isHard: "Y",
                changeReason: "Audit lock"
            })
        )
        const locked = call("mantle.ledger.LedgerServices.create#AcctgTrans", {
            acctgTransTypeEnumId: "AttNetIncomeClosing",
            organizationPartyId: f.org,
            transactionDate: f.timestamp,
            description: "Closing past a lock"
        })
        for (const [glAccountId, debitCreditFlag] of [
            ["412000000", "D"],
            ["850000000", "C"]
        ])
            call("mantle.ledger.LedgerServices.create#AcctgTransEntry", {
                acctgTransId: locked.acctgTransId,
                glAccountId,
                debitCreditFlag,
                amount: "1"
            })
        const lockedPost = asUser(f.users.glClose, () =>
            rejected("mantle.ledger.LedgerServices.post#AcctgTrans", {acctgTransId: locked.acctgTransId})
        )
        // a year's close is blocked while a hard lock covers its last day
        const lockedYearId = call("mantle.party.TimeServices.create#TimePeriod", {
            partyId: f.org,
            timePeriodTypeId: "FiscalYear",
            fromDate: "2020-01-01",
            thruDate: "2020-12-31"
        }).timePeriodId
        const lockedYear = asUser(f.users.closer, () =>
            call(close + "get#Checklist", {organizationPartyId: f.org, timePeriodId: lockedYearId})
        )
        fixtures().base.cleanupLocks(f.org)
        return {draft, template, instance, closedPost, reversal, lockedPost, lock, lockedYear}
    },
    then({draft, template, instance, closedPost, reversal, lockedPost, lockedYear}) {
        row(lockedYear.checkRows, "PccHardLock").status == "blocked" && lockedYear.canClose == false
        draft.includes("CLOSING_ENTRY")
        template.includes("CLOSING_ENTRY")
        instance.includes("CLOSING_ENTRY")
        closedPost.includes("PERIOD_CLOSED")
        reversal.includes("CLOSING_ENTRY")
        lockedPost.includes("HARD_LOCK")
    }
})
// A rollup child posts under its parent's fiscal year: the year's close closes the child to its own net income account
// and stores the child's summary rows, so the child's trial balance of the closed year reads them; the closed December
// and fourth quarter are stored again with the closing entries.
feature("a parent's year close closes a rollup child to its own net income account and stores its summary rows", {
    when() {
        const child = fixtures().fixtures("ACCT_P11_CHILD")
        call("create#mantle.party.PartyRelationship", {
            fromPartyId: child.org,
            fromRoleTypeId: "OrgInternal",
            toPartyId: f.org,
            toRoleTypeId: "OrgInternal",
            relationshipTypeEnumId: "PrtOrgRollup",
            fromDate: 0
        })
        const yearId = call("mantle.party.TimeServices.create#TimePeriod", {
            partyId: f.org,
            timePeriodTypeId: "FiscalYear",
            fromDate: "2022-01-01",
            thruDate: "2022-12-31"
        }).timePeriodId
        const entry = (org, amount) => {
            const made = call("mantle.ledger.LedgerServices.create#AcctgTrans", {
                acctgTransTypeEnumId: "AttInternal",
                organizationPartyId: org,
                transactionDate: ec.l10n.parseTimestamp("2022-06-15 12:00:00", "yyyy-MM-dd HH:mm:ss"),
                description: "Year revenue of " + org
            })
            for (const [glAccountId, debitCreditFlag] of [
                ["111100000", "D"],
                ["412000000", "C"]
            ])
                call("mantle.ledger.LedgerServices.create#AcctgTransEntry", {
                    acctgTransId: made.acctgTransId,
                    glAccountId,
                    debitCreditFlag,
                    amount
                })
            call("mantle.ledger.LedgerServices.post#AcctgTrans", {acctgTransId: made.acctgTransId})
        }
        entry(f.org, "30")
        entry(child.org, "45")
        // the year's last quarter and month, closed before the year
        const quarterId = call("mantle.party.TimeServices.create#TimePeriod", {
            partyId: f.org,
            timePeriodTypeId: "FiscalQuarter",
            parentPeriodId: yearId,
            fromDate: "2022-10-01",
            thruDate: "2022-12-31"
        }).timePeriodId
        const decemberId = call("mantle.party.TimeServices.create#TimePeriod", {
            partyId: f.org,
            timePeriodTypeId: "FiscalMonth",
            parentPeriodId: quarterId,
            fromDate: "2022-12-01",
            thruDate: "2022-12-31"
        }).timePeriodId
        for (const timePeriodId of [decemberId, quarterId])
            asUser(f.users.closer, () => call(close + "close#Period", {organizationPartyId: f.org, timePeriodId}))
        const closed = asUser(f.users.closer, () =>
            call(close + "close#Period", {organizationPartyId: f.org, timePeriodId: yearId, changeReason: "Group year end"})
        )
        const closing = Array.from(
            ec.entity
                .find("mantle.ledger.transaction.AcctgTrans")
                .condition("acctgTransId", "in", Array.from(closed.closingAcctgTransIdList))
                .disableAuthz()
                .list()
        )
        const childRevenue = ec.entity
            .find("mantle.ledger.account.GlAccountOrgTimePeriod")
            .condition({organizationPartyId: child.org, timePeriodId: yearId, glAccountId: "412000000"})
            .disableAuthz()
            .one()
        const childTrial = asUser(child.users.read, () =>
            call("mantle.ledger.FinanceReportServices.run#TrialBalance", {organizationPartyId: child.org, timePeriodId: yearId})
        )
        const december = asUser(f.users.read, () =>
            call("mantle.ledger.FinanceReportServices.run#TrialBalance", {organizationPartyId: f.org, timePeriodId: decemberId})
        )
        const childDecember = ec.entity
            .find("mantle.ledger.account.GlAccountOrgTimePeriod")
            .condition({organizationPartyId: child.org, timePeriodId: decemberId, glAccountId: "412000000"})
            .disableAuthz()
            .one()
        return {child, closing, childRevenue, childTrial, december, childDecember}
    },
    then({child, closing, childRevenue, childTrial, december, childDecember}) {
        december.reportRows.find(r => r.glAccountId == "412000000").ending == 0
        december.reportRows.find(r => r.glAccountId == "850000000").closedSummary == true
        childDecember.postedDebits == 45 && childDecember.endingBalance == 0
        closing
            .map(tx => tx.organizationPartyId)
            .sort()
            .join() == [child.org, f.org].sort().join()
        childRevenue.postedCreditsNoClosing == 45 && childRevenue.endingBalance == 0
        childTrial.reportRows.find(r => r.glAccountId == "412000000").closedSummary == true
        childTrial.reportRows.find(r => r.glAccountId == "850000000").ending == -45
    }
})
// A close that fails after Mantle's close and the summary rows (here, the net income account is no longer the
// organization's, so the year's closing entry cannot post) rolls back whole: the period stays open, with no run and no
// summary rows.
feature("a close that fails midway leaves the period open, with no run and no summary rows", {
    when() {
        const h = fixtures()
        const g = h.fixtures("ACCT_P11_FAIL")
        const closer = h.user(g, "CLOSER", ["ACCOUNTING_VIEW", "FISCAL_CLOSE"])
        const yearId = call("mantle.party.TimeServices.create#TimePeriod", {
            partyId: g.org,
            timePeriodTypeId: "FiscalYear",
            fromDate: "2021-01-01",
            thruDate: "2021-12-31"
        }).timePeriodId
        const made = call("mantle.ledger.LedgerServices.create#AcctgTrans", {
            acctgTransTypeEnumId: "AttInternal",
            organizationPartyId: g.org,
            transactionDate: ec.l10n.parseTimestamp("2021-06-15 12:00:00", "yyyy-MM-dd HH:mm:ss"),
            description: "Revenue without a net income account"
        })
        for (const [glAccountId, debitCreditFlag] of [
            ["111100000", "D"],
            ["412000000", "C"]
        ])
            call("mantle.ledger.LedgerServices.create#AcctgTransEntry", {
                acctgTransId: made.acctgTransId,
                glAccountId,
                debitCreditFlag,
                amount: "20"
            })
        call("mantle.ledger.LedgerServices.post#AcctgTrans", {acctgTransId: made.acctgTransId})
        call("delete#mantle.ledger.account.GlAccountOrganization", {glAccountId: "850000000", organizationPartyId: g.org})
        const refused = asUser(closer, () =>
            rejected(close + "close#Period", {organizationPartyId: g.org, timePeriodId: yearId, changeReason: "Year end"})
        )
        const count = entity => ec.entity.find(entity).condition("timePeriodId", yearId).disableAuthz().count()
        return {
            refused,
            state: period(yearId).isClosed,
            runs: count("mantle.ledger.transaction.AccountingCloseRun"),
            summaries: count("mantle.ledger.account.GlAccountOrgTimePeriod")
        }
    },
    then({refused, state, runs, summaries}) {
        refused.includes("NET_INCOME_ACCOUNT_MISSING") || refused.includes("ACCOUNT_INACTIVE")
        state == "N"
        runs == 0 && summaries == 0
    }
})
