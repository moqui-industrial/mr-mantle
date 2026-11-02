// A document's calendar date survives another actor's zone and every ledger read/rebuild path.
const helper = () => ec.resource.script("component://mr-mantle/test/ledger/AccountingReceivablesFixtures.js")
const lib = () => helper().lib
const call = (name, parameters = {}) => helper().call(name, parameters)
const invoice = (name, parameters) => call("mantle.account.InvoiceServices." + name, parameters)
const ledger = (name, parameters) => call("mantle.ledger.LedgerServices." + name, parameters)
const sourceTime = Date.UTC(2026, 10, 1, 4, 30) // October 31, 23:30 in Chicago; November 1 in UTC.
const reversalTime = Date.UTC(2026, 10, 6, 12)
const amount = toDecimal(16)
let f, invoiceId, transactionId, originalEntries, october, november, debitAccountId, creditAccountId

const sum = (rows, field) => rows.reduce((total, row) => total.add(row[field] || 0), toDecimal(0))
const date = value => lib().policy.calendarDateText(value)
const transaction = id => lib().one("mantle.ledger.transaction.AcctgTrans", {acctgTransId: id})
const entries = id =>
    lib()
        .rows("mantle.ledger.transaction.AcctgTransEntry", {acctgTransId: id})
        .sort((a, b) => String(a.acctgTransEntrySeqId).localeCompare(String(b.acctgTransEntrySeqId)))
function period(organizationPartyId, month) {
    const row = lib()
        .rows("mantle.party.time.TimePeriod", {partyId: organizationPartyId, timePeriodTypeId: "FiscalMonth"})
        .find(row => date(row.fromDate) === month + "-01")
    if (!row) throw new Error("Book-date fixture requires fiscal month " + month)
    return row
}
function bookPeriods(organizationPartyId) {
    const november = period(organizationPartyId, "2026-11")
    // The shared fixture initializes current/next periods. Its November clock does not create earlier months;
    // fiscal lookup can already succeed on the year/quarter without filling October's missing month.
    call("mantle.party.TimeServices.getOrCreate#PreviousTimePeriod", {timePeriodId: november.timePeriodId})
    return {october: period(organizationPartyId, "2026-10"), november}
}
function movement(organizationPartyId, timePeriodId) {
    const rows = lib().rows("mantle.ledger.account.GlAccountOrgTimePeriod", {organizationPartyId, timePeriodId})
    return {
        debits: sum(rows, "postedDebits"),
        credits: sum(rows, "postedCredits"),
        debitAccount: rows.find(row => row.glAccountId === debitAccountId),
        creditAccount: rows.find(row => row.glAccountId === creditAccountId)
    }
}
function reports(organizationPartyId, timePeriodId, range = {}) {
    const parameters = Object.assign({organizationPartyId, timePeriodId, amountUomId: "USD"}, range)
    const trial = call("mantle.ledger.FinanceReportServices.run#TrialBalance", parameters)
    const general = call("mantle.ledger.FinanceReportServices.run#GeneralLedger", parameters)
    return {
        trial,
        general,
        debits: sum(trial.reportRows, "debits"),
        credits: sum(trial.reportRows, "credits")
    }
}
function newInvoice(fixture) {
    const created = invoice("create#Receivable", {
        organizationPartyId: fixture.org,
        customerPartyId: fixture.customer,
        invoiceDate: sourceTime
    })
    invoice("store#InvoiceDraftItem", {
        invoiceId: created.invoiceId,
        itemTypeEnumId: "ItemTimeEntry",
        quantity: "1",
        amount: String(amount),
        description: "Chicago month-end consulting"
    })
    return lib().one(lib().invoiceEntity, {invoiceId: created.invoiceId})
}
function postedFor(id) {
    const rows = lib().rows("mantle.ledger.transaction.AcctgTrans", {invoiceId: id, isPosted: "Y"})
    if (rows.length !== 1) throw new Error("Book-date fixture requires exactly one posted invoice transaction")
    return rows[0]
}
function recalculateMonths(organizationPartyId, first, second) {
    ledger("recalculate#GlAccountOrgTimePeriodAmounts", {timePeriodId: first.timePeriodId})
    ledger("recalculate#GlAccountOrgTimePeriodAmounts", {timePeriodId: second.timePeriodId})
    return {
        october: movement(organizationPartyId, first.timePeriodId),
        november: movement(organizationPartyId, second.timePeriodId)
    }
}

spec({
    stepwise: true,
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        ec.user.setEffectiveTime(Date.UTC(2026, 10, 15, 12))
        f = helper().fixtures("NATIVE_BOOK")
        call("update#mantle.ledger.config.PartyAcctgPreference", {organizationPartyId: f.org, realTimeGlSummary: "Y"})
        call("update#moqui.security.UserAccount", {userId: f.users.ar, timeZone: "America/Chicago"})
        call("update#moqui.security.UserAccount", {userId: f.users.approve, timeZone: "UTC"})
        call("create#moqui.security.UserGroupPermission", {
            userGroupId: f.users.approve,
            userPermissionId: "ACCOUNTING_GL_POST",
            fromDate: 0
        })
        const periods = bookPeriods(f.org)
        october = periods.october
        november = periods.november
    },
    setup() {
        ec.artifactExecution.disableAuthz()
        login(f.users.approve)
    },
    cleanupSpec() {
        login("john.doe")
        ec.user.setEffectiveTime(null)
    }
})

feature("a Chicago month-end invoice posts to October when a UTC user finalizes it", {
    when() {
        login(f.users.ar)
        const source = newInvoice(f)
        invoiceId = source.invoiceId
        login(f.users.approve)
        const finalized = invoice("change#InvoiceState", {
            invoiceId,
            action: "approve",
            lastUpdatedStamp: source.lastUpdatedStamp,
            operationKey: "native-book-finalize"
        })
        const posted = postedFor(invoiceId)
        transactionId = posted.acctgTransId
        originalEntries = JSON.stringify(entries(transactionId).map(lib().map))
        debitAccountId = entries(transactionId).find(row => row.debitCreditFlag === "D").glAccountId
        creditAccountId = entries(transactionId).find(row => row.debitCreditFlag === "C").glAccountId
        return {
            finalized,
            source,
            posted,
            utcDay: ec.l10n.format(source.invoiceDate, "yyyy-MM-dd"),
            october: movement(f.org, october.timePeriodId),
            november: movement(f.org, november.timePeriodId)
        }
    },
    then({finalized, source, posted, utcDay, october, november}) {
        finalized.statusId == "InvoiceFinalized"
        date(source.accountingDate) == "2026-10-31"
        utcDay == "2026-11-01"
        lib().ms(source.invoiceDate) == sourceTime
        lib().ms(posted.transactionDate) == sourceTime
        date(posted.accountingDate) == "2026-10-31"
        october.debits.eq(amount)
        october.credits.eq(amount)
        toDecimal(october.debitAccount.endingBalance).eq(amount)
        toDecimal(october.creditAccount.endingBalance).eq(amount)
        november.debits.isZero()
        november.credits.isZero()
    }
})

feature("UTC trial balance and ledger select the same October movement without changing source timestamps", {
    when() {
        return {
            october: reports(f.org, october.timePeriodId),
            november: reports(f.org, november.timePeriodId),
            octoberRange: reports(f.org, null, {fromDate: "2026-10-01T00:00:00.000Z", thruDate: "2026-11-01T00:00:00.000Z"}),
            novemberRange: reports(f.org, null, {fromDate: "2026-11-01T00:00:00.000Z", thruDate: "2026-12-01T00:00:00.000Z"})
        }
    },
    then({october, november, octoberRange, novemberRange}) {
        october.trial.complete == true
        october.general.complete == true
        october.debits.eq(amount)
        october.credits.eq(amount)
        october.general.reportRows.length == entries(transactionId).length
        october.general.reportRows.every(row => row.acctgTransId == transactionId)
        october.general.reportRows.every(row => lib().ms(row.transactionDate) == sourceTime)
        october.general.reportRows.every(row => date(row.accountingDate) == "2026-10-31")
        october.trial.reportRows.find(row => row.glAccountId == debitAccountId).ending.eq(amount)
        october.trial.reportRows.find(row => row.glAccountId == creditAccountId).ending.eq(amount.negate())
        november.debits.isZero()
        november.credits.isZero()
        november.general.reportRows.length == 0
        octoberRange.trial.complete == true
        octoberRange.general.complete == true
        octoberRange.debits.eq(october.debits)
        octoberRange.credits.eq(october.credits)
        octoberRange.general.reportRows.length == october.general.reportRows.length
        octoberRange.general.reportRows.every(row => row.acctgTransId == transactionId)
        octoberRange.general.reportRows.every(row => lib().ms(row.transactionDate) == sourceTime)
        novemberRange.trial.complete == true
        novemberRange.general.complete == true
        novemberRange.debits.isZero()
        novemberRange.credits.isZero()
        novemberRange.general.reportRows.length == 0
    }
})

feature("single-period reconciliation retains October movement and leaves November movement empty", {
    when() {
        return recalculateMonths(f.org, october, november)
    },
    then({october, november}) {
        october.debits.eq(amount)
        october.credits.eq(amount)
        toDecimal(october.debitAccount.endingBalance).eq(amount)
        toDecimal(october.creditAccount.endingBalance).eq(amount)
        november.debits.isZero()
        november.credits.isZero()
    }
})

feature("the background summary rebuild preserves the same month and trial balance", {
    when() {
        ledger("recalculate#GlAccountOrgSummaries", {organizationPartyId: f.org})
        return {
            october: movement(f.org, october.timePeriodId),
            november: movement(f.org, november.timePeriodId),
            read: reports(f.org, october.timePeriodId)
        }
    },
    then({october, november, read}) {
        october.debits.eq(amount)
        october.credits.eq(amount)
        november.debits.isZero()
        november.credits.isZero()
        read.debits.eq(october.debits)
        read.credits.eq(october.credits)
    }
})

feature("unposting subtracts October and reviewed reposting restores the same transaction and source date", {
    when() {
        ledger("unpost#AcctgTrans", {acctgTransId: transactionId})
        const removed = {
            transaction: lib().map(transaction(transactionId)),
            october: movement(f.org, october.timePeriodId),
            november: movement(f.org, november.timePeriodId),
            read: reports(f.org, october.timePeriodId)
        }
        const preview = call("mantle.ledger.JournalServices.preview#Entry", {acctgTransId: transactionId})
        const posted = call(
            "mantle.ledger.JournalServices.post#Entry",
            Object.assign({}, preview, {
                acctgTransId: transactionId,
                operationKey: "native-book-repost",
                changeReason: "Recheck the original calendar month"
            })
        )
        return {
            removed,
            posted,
            transaction: transaction(transactionId),
            october: movement(f.org, october.timePeriodId),
            november: movement(f.org, november.timePeriodId),
            entriesAfter: JSON.stringify(entries(transactionId).map(lib().map))
        }
    },
    then({removed, posted, transaction, october, november, entriesAfter}) {
        removed.transaction.isPosted == "N"
        removed.october.debits.isZero()
        removed.october.credits.isZero()
        removed.november.debits.isZero()
        removed.november.credits.isZero()
        removed.read.debits.isZero()
        removed.read.credits.isZero()
        removed.read.general.reportRows.length == 0
        posted.acctgTransId == transactionId
        transaction.isPosted == "Y"
        lib().ms(transaction.transactionDate) == sourceTime
        date(transaction.accountingDate) == "2026-10-31"
        entriesAfter == originalEntries
        october.debits.eq(amount)
        october.credits.eq(amount)
        november.debits.isZero()
        november.credits.isZero()
    }
})

feature("legacy transaction primitives cannot supply or move the authoritative posting day", {
    when() {
        let draftId
        try {
            const created = ledger("create#AcctgTrans", {
                organizationPartyId: f.org,
                acctgTransTypeEnumId: "AttInternal",
                amountUomId: "USD",
                transactionDate: sourceTime,
                accountingDate: "2030-01-01"
            })
            draftId = created.acctgTransId
            for (const [glAccountId, debitCreditFlag] of [
                [debitAccountId, "D"],
                [creditAccountId, "C"]
            ])
                ledger("create#AcctgTransEntry", {acctgTransId: draftId, glAccountId, debitCreditFlag, amount})
            const afterCreate = lib().map(transaction(draftId))
            ledger("update#AcctgTrans", {acctgTransId: draftId, accountingDate: "2031-01-01"})
            const afterUpdate = lib().map(transaction(draftId))
            ledger("update#AcctgTransPosted", {acctgTransId: transactionId, accountingDate: "2032-01-01"})
            return {afterCreate, afterUpdate, posted: lib().map(transaction(transactionId)), draftId}
        } finally {
            if (draftId) ledger("delete#AcctgTrans", {acctgTransId: draftId})
        }
    },
    then({afterCreate, afterUpdate, posted, draftId}) {
        !afterCreate.accountingDate
        !afterUpdate.accountingDate
        lib().ms(afterCreate.transactionDate) == sourceTime
        lib().ms(afterUpdate.transactionDate) == sourceTime
        posted.isPosted == "Y"
        date(posted.accountingDate) == "2026-10-31"
        lib().ms(posted.transactionDate) == sourceTime
        !transaction(draftId)
        entries(draftId).length == 0
    }
})

feature("a November effective reversal keeps its own date and preserves the posted October source", {
    when() {
        const reversal = call("mantle.ledger.JournalServices.reverse#Entry", {
            acctgTransId: transactionId,
            reversalDate: reversalTime,
            operationKey: "native-book-forward-reversal",
            changeReason: "Correct the original invoice in November"
        })
        const reversed = transaction(reversal.acctgTransId)
        const original = transaction(transactionId)
        const rebuilt = recalculateMonths(f.org, october, november)
        return {
            original,
            reversed,
            rebuilt,
            octoberRead: reports(f.org, october.timePeriodId),
            novemberRead: reports(f.org, november.timePeriodId),
            entriesAfter: JSON.stringify(entries(transactionId).map(lib().map))
        }
    },
    then({original, reversed, rebuilt, octoberRead, novemberRead, entriesAfter}) {
        original.isPosted == "Y"
        reversed.isPosted == "Y"
        original.reversedByAcctgTransId == reversed.acctgTransId
        reversed.reverseOfAcctgTransId == transactionId
        lib().ms(original.transactionDate) == sourceTime
        date(original.accountingDate) == "2026-10-31"
        lib().ms(reversed.transactionDate) == reversalTime
        date(reversed.accountingDate) == "2026-11-06"
        entriesAfter == originalEntries
        rebuilt.october.debits.eq(amount)
        rebuilt.october.credits.eq(amount)
        rebuilt.november.debits.eq(amount)
        rebuilt.november.credits.eq(amount)
        octoberRead.debits.eq(amount)
        octoberRead.credits.eq(amount)
        octoberRead.general.reportRows.every(row => row.acctgTransId == transactionId)
        novemberRead.debits.eq(amount)
        novemberRead.credits.eq(amount)
        novemberRead.general.reportRows.length == entries(transactionId).length
        novemberRead.general.reportRows.every(row => row.acctgTransId == reversed.acctgTransId)
        novemberRead.general.reportRows.every(row => lib().ms(row.transactionDate) == reversalTime)
        novemberRead.trial.reportRows.every(row => row.ending.isZero())
    }
})

feature("adopting controls leaves already posted legacy timestamps and fiscal movement unchanged", {
    when() {
        login("john.doe")
        const legacy = helper().fixtures("NATIVE_BOOK_LEGACY")
        const legacyPeriods = bookPeriods(legacy.org)
        call("update#mantle.ledger.config.PartyAcctgPreference", {
            organizationPartyId: legacy.org,
            postingGuardEnabled: "N",
            realTimeGlSummary: "Y"
        })
        call("update#moqui.security.UserAccount", {userId: legacy.users.ar, timeZone: "America/Chicago"})
        call("update#moqui.security.UserAccount", {userId: legacy.users.approve, timeZone: "UTC"})
        login(legacy.users.ar)
        const source = newInvoice(legacy)
        login(legacy.users.approve)
        invoice("change#InvoiceState", {
            invoiceId: source.invoiceId,
            action: "approve",
            lastUpdatedStamp: source.lastUpdatedStamp
        })
        const before = lib().map(postedFor(source.invoiceId))
        const oldOctober = legacyPeriods.october
        const oldNovember = legacyPeriods.november
        const legacyOctober = reports(legacy.org, oldOctober.timePeriodId)
        const legacyNovember = reports(legacy.org, oldNovember.timePeriodId)
        login("john.doe")
        call("update#mantle.ledger.config.PartyAcctgPreference", {organizationPartyId: legacy.org, postingGuardEnabled: "Y"})
        login(legacy.users.approve)
        ledger("recalculate#GlAccountOrgTimePeriodAmounts", {timePeriodId: oldOctober.timePeriodId})
        ledger("recalculate#GlAccountOrgTimePeriodAmounts", {timePeriodId: oldNovember.timePeriodId})
        return {
            before,
            after: lib().map(transaction(before.acctgTransId)),
            legacyOctober,
            legacyNovember,
            adoptedOctober: reports(legacy.org, oldOctober.timePeriodId),
            adoptedNovember: reports(legacy.org, oldNovember.timePeriodId),
            october: movement(legacy.org, oldOctober.timePeriodId),
            november: movement(legacy.org, oldNovember.timePeriodId)
        }
    },
    then({before, after, legacyOctober, legacyNovember, adoptedOctober, adoptedNovember, october, november}) {
        !before.accountingDate
        !after.accountingDate
        JSON.stringify(after) == JSON.stringify(before)
        lib().ms(after.transactionDate) == sourceTime
        legacyOctober.debits.isZero()
        legacyOctober.credits.isZero()
        legacyNovember.debits.eq(amount)
        legacyNovember.credits.eq(amount)
        adoptedOctober.debits.isZero()
        adoptedOctober.credits.isZero()
        adoptedNovember.debits.eq(amount)
        adoptedNovember.credits.eq(amount)
        october.debits.isZero()
        october.credits.isZero()
        november.debits.eq(amount)
        november.credits.eq(amount)
    }
})
