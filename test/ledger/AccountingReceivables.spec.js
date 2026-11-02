const helper = () => ec.resource.script("component://mr-mantle/test/ledger/AccountingReceivablesFixtures.js")
const native = (name, p) => helper().call("mantle.account.InvoiceServices." + name, p)
let f, invoiceId, finalized, creditId, originalRevision
spec({
    stepwise: true,
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        f = helper().fixtures("NATIVE_AR")
    },
    setup() {
        ec.artifactExecution.disableAuthz()
    },
    cleanup() {
        login("john.doe")
    },
    cleanupSpec() {
        login("john.doe")
        helper().cleanupLocks(f.org)
    }
})
feature("an edit-only finance user creates and finalizes without opening Accounting reads", {
    when() {
        login(f.users.edit)
        const invoice = helper().draft(f)
        invoiceId = invoice.invoiceId
        originalRevision = invoice.lastUpdatedStamp
        const readDenied = helper().rejected("mantle.account.InvoiceServices.get#InvoiceFinanceDetail", {invoiceId})
        finalized = native("change#InvoiceState", {
            invoiceId,
            action: "finalize",
            lastUpdatedStamp: invoice.lastUpdatedStamp,
            operationKey: "native-ar-finalize"
        })
        return {readDenied, finalized}
    },
    then({readDenied, finalized}) {
        readDenied.includes("PERMISSION_DENIED")
        finalized.statusId == "InvoiceFinalized"
        finalized.reasonCode == "OK"
    }
})
feature("finalization replay returns the original result and rejects changed key reuse", {
    when() {
        login(f.users.edit)
        const op = helper().lib.one("mantle.ledger.transaction.PostingOperation", {operationKey: "native-ar-finalize"})
        const original = JSON.parse(op.resultJson)
        const replay = native("change#InvoiceState", {
            invoiceId,
            action: "finalize",
            lastUpdatedStamp: originalRevision,
            operationKey: "native-ar-finalize"
        })
        return {replay}
    },
    then({replay}) {
        replay.alreadyApplied == true
    }
})
feature("invoice detail omits ledger authority fields for AR while reporting readers retain ledger evidence", {
    when() {
        login(f.users.ar)
        const ar = native("get#InvoiceFinanceDetail", {invoiceId})
        login(f.users.read)
        const read = native("get#InvoiceFinanceDetail", {invoiceId})
        return {ar, read}
    },
    then({ar, read}) {
        ar.ledgerRows.length == 0
        ar.lines.every(row => row.overrideGlAccountId == null)
        ar.paymentRows.every(row => row.overrideGlAccountId == null)
        ar.capabilities.canCancel == false
        ar.capabilities.canResume == false
        read.ledgerRows.length > 0
    }
})
feature("active organization selection narrows an otherwise authorized child for AR and finance administrators", {
    when() {
        const child = helper().fixtures("NATIVE_AR_CHILD")
        helper().call("create#mantle.party.PartyRelationship", {
            fromPartyId: child.org,
            toPartyId: f.org,
            relationshipTypeEnumId: "PrtOrgRollup",
            fromDate: 0
        })
        const document = helper().draft(child, "3")
        const outcomes = []
        for (const user of [f.users.ar, f.users.financeadmin]) {
            login(user)
            const savedPreference = ec.user.getPreference("ACTIVE_ORGANIZATION")
            try {
                ec.user.setPreference("ACTIVE_ORGANIZATION", null)
                const allowed = native("get#InvoiceFinanceDetail", {
                    invoiceId: document.invoiceId,
                    organizationPartyId: child.org
                })
                ec.user.setPreference("ACTIVE_ORGANIZATION", f.org)
                const denied = [
                    ["get#InvoiceFinanceDetail", {invoiceId: document.invoiceId, organizationPartyId: child.org}],
                    ["find#Receivables", {organizationPartyId: child.org}],
                    ["get#ReceivableSummary", {organizationPartyId: child.org}]
                ].map(([name, parameters]) => helper().rejected("mantle.account.InvoiceServices." + name, parameters))
                const parent = native("find#Receivables", {organizationPartyId: f.org})
                outcomes.push({allowed: allowed.invoice.invoiceId, denied, parent: parent.recordsCount})
            } finally {
                ec.user.setPreference("ACTIVE_ORGANIZATION", savedPreference)
            }
        }
        return {outcomes, id: document.invoiceId}
    },
    then({outcomes, id}) {
        outcomes.length == 2
        outcomes.every(
            row => row.allowed == id && row.denied.every(message => message.includes("ORGANIZATION_DENIED")) && row.parent > 0
        )
    }
})
feature("another currency with no rate is refused at finalize; every invoice gets its book day", {
    when() {
        // XTS, the ISO code reserved for testing: a currency no other spec gives a rate
        if (!helper().lib.one("moqui.basic.Uom", {uomId: "XTS"}))
            helper().call("create#moqui.basic.Uom", {
                uomId: "XTS",
                uomTypeEnumId: "UT_CURRENCY_MEASURE",
                description: "Testing currency",
                abbreviation: "XTS"
            })
        const foreign = helper().draft(f, "25", "XTS")
        const adopted = helper().rejected("mantle.account.InvoiceServices.change#InvoiceState", {
            invoiceId: foreign.invoiceId,
            action: "finalize",
            lastUpdatedStamp: foreign.lastUpdatedStamp
        })
        const legacyFixture = helper().fixtures("NATIVE_LEGACY_AR")
        helper().call("update#mantle.ledger.config.PartyAcctgPreference", {
            organizationPartyId: legacyFixture.org,
            postingGuardEnabled: "N"
        })
        // without the guard a document with no rate cannot finalize either (its posting must complete), so this one is
        // in the base currency
        const legacyInvoice = helper().draft(legacyFixture, "25", "USD")
        const legacyPrimitive = helper().call("mantle.account.InvoiceServices.create#Invoice", {
            fromPartyId: legacyFixture.org,
            toPartyId: legacyFixture.customer,
            currencyUomId: "USD"
        })
        const primitive = helper().lib.one(helper().lib.invoiceEntity, {invoiceId: legacyPrimitive.invoiceId})
        const legacy = native("change#InvoiceState", {
            invoiceId: legacyInvoice.invoiceId,
            action: "finalize",
            lastUpdatedStamp: legacyInvoice.lastUpdatedStamp
        })
        return {adopted, legacy, explicit: legacyInvoice, primitive}
    },
    then({adopted, legacy, explicit, primitive}) {
        adopted.includes("RATE_MISSING")
        legacy.statusId == "InvoiceFinalized"
        !!explicit.accountingDate
        !!explicit.draftedByUserId
        helper().lib.policy.calendarDateText(primitive.accountingDate) == ec.l10n.format(primitive.invoiceDate, "yyyy-MM-dd")
        primitive.draftedByUserId == ec.user.userId
    }
})
feature("an approval-only user approves another drafter while AR cannot approve", {
    when() {
        login(f.users.ar)
        const record = helper().draft(f, "40")
        const parameters = {invoiceId: record.invoiceId, action: "approve", lastUpdatedStamp: record.lastUpdatedStamp}
        const denied = helper().rejected("mantle.account.InvoiceServices.change#InvoiceState", parameters)
        login(f.users.approve)
        const approved = native("change#InvoiceState", parameters)
        return {denied, approved}
    },
    then({denied, approved}) {
        denied.includes("PERMISSION_DENIED")
        approved.statusId == "InvoiceFinalized"
    }
})
feature("stale header edits and posted resumes are refused without changing history", {
    when() {
        const record = helper().draft(f, "12")
        const stale = helper().rejected("mantle.account.InvoiceServices.store#InvoiceDraft", {
            invoiceId: record.invoiceId,
            lastUpdatedStamp: 0,
            description: "Stale"
        })
        const resume = helper().rejected("mantle.account.InvoiceServices.change#InvoiceState", {
            invoiceId,
            action: "resume",
            changeReason: "Attempt old rewrite",
            lastUpdatedStamp: helper().lib.one(helper().lib.invoiceEntity, {invoiceId}).lastUpdatedStamp
        })
        return {stale, resume}
    },
    then({stale, resume}) {
        stale.includes("STALE_REVISION")
        resume.includes("INVOICE_POSTED")
    }
})
feature("legacy invoice date edits recompute the chosen book day and ignore caller authority fields", {
    when() {
        login(f.users.ar)
        const invoice = helper().draft(f, "9")
        helper().call("mantle.account.InvoiceServices.update#Invoice", {
            invoiceId: invoice.invoiceId,
            invoiceDate: new Date(Date.UTC(2026, 9, 29, 4, 30)),
            accountingDate: "2020-01-01",
            draftedByUserId: "john.doe",
            approvedByUserId: "john.doe"
        })
        const detail = native("get#InvoiceFinanceDetail", {invoiceId: invoice.invoiceId})
        return {detail}
    },
    then({detail}) {
        detail.invoice.invoiceDateValue == "2026-10-28"
        detail.invoice.draftedByUserId == f.users.ar
        detail.invoice.approvedByUserId == null
    }
})
feature("an AR-only user creates finalizes and applies a linked credit with original revenue accounts", {
    when() {
        const originalTransactions = helper()
            .lib.rows("mantle.ledger.transaction.AcctgTrans", {
                invoiceId,
                organizationPartyId: f.org,
                isPosted: "Y"
            })
            .filter(row => !row.paymentApplicationId && !row.reverseOfAcctgTransId && !row.reversedByAcctgTransId)
        const originalEntries = originalTransactions.flatMap(row =>
            helper().lib.rows("mantle.ledger.transaction.AcctgTransEntry", {
                acctgTransId: row.acctgTransId,
                debitCreditFlag: "C"
            })
        )
        const expected = {}
        const sourceTotal = originalEntries.reduce((sum, row) => sum.add(row.amount || 0), toDecimal(0))
        for (const row of originalEntries)
            expected[row.glAccountId] = (expected[row.glAccountId] || toDecimal(0)).add(row.amount || 0)
        const mappingKey = {organizationPartyId: f.org, itemTypeEnumId: "ItemTimeEntry", direction: "O"}
        const previousMapping = helper().lib.one("mantle.ledger.config.ItemTypeGlAccount", mappingKey)
        const changedAccount = helper()
            .lib.rows("mantle.ledger.account.GlAccountAndOrganization", {organizationPartyId: f.org})
            .find(row => row.disallowPosting !== "Y" && !expected[row.glAccountId]).glAccountId
        helper().call(
            "store#mantle.ledger.config.ItemTypeGlAccount",
            Object.assign({}, mappingKey, {glAccountId: changedAccount})
        )
        try {
            login(f.users.ar)
            const credit = native("create#InvoiceCreditMemo", {
                originalInvoiceId: invoiceId,
                amount: "25",
                linkToOriginal: true,
                allocateToLines: true,
                operationKey: "native-ar-credit"
            })
            creditId = credit.invoiceId
            const status = native("change#InvoiceState", {
                invoiceId: creditId,
                organizationPartyId: f.org,
                action: "finalize",
                lastUpdatedStamp: helper().lib.one(helper().lib.invoiceEntity, {invoiceId: creditId}).lastUpdatedStamp
            })
            const applied = native("apply#InvoiceCredit", {
                invoiceId: creditId,
                toInvoiceId: invoiceId,
                organizationPartyId: f.org,
                amount: "25",
                operationKey: "native-ar-credit-apply"
            })
            const replay = native("apply#InvoiceCredit", {
                invoiceId: creditId,
                toInvoiceId: invoiceId,
                organizationPartyId: f.org,
                amount: "25",
                operationKey: "native-ar-credit-apply"
            })
            const creditTransactions = helper()
                .lib.rows("mantle.ledger.transaction.AcctgTrans", {
                    invoiceId: creditId,
                    organizationPartyId: f.org,
                    isPosted: "Y"
                })
                .filter(row => !row.paymentApplicationId && !row.reverseOfAcctgTransId && !row.reversedByAcctgTransId)
            const creditEntries = creditTransactions.flatMap(row =>
                helper().lib.rows("mantle.ledger.transaction.AcctgTransEntry", {
                    acctgTransId: row.acctgTransId,
                    debitCreditFlag: "D"
                })
            )
            const actual = {}
            for (const row of creditEntries)
                actual[row.glAccountId] = (actual[row.glAccountId] || toDecimal(0)).add(row.amount || 0)
            return {
                status,
                applied,
                replay,
                expected,
                actual,
                sourceTotal,
                changedAccount,
                creditTotal: creditEntries.reduce((sum, row) => sum.add(row.amount || 0), toDecimal(0))
            }
        } finally {
            login("john.doe")
            if (previousMapping) helper().call("store#mantle.ledger.config.ItemTypeGlAccount", helper().lib.map(previousMapping))
            else helper().call("delete#mantle.ledger.config.ItemTypeGlAccount", mappingKey)
        }
    },
    then({status, applied, replay, expected, actual, sourceTotal, changedAccount, creditTotal}) {
        status.statusId == "InvoiceFinalized"
        applied.amountApplied.eq(25)
        replay.paymentApplicationId == applied.paymentApplicationId
        replay.alreadyApplied == true
        creditTotal.eq(25)
        actual[changedAccount] == null
        Object.keys(actual).length == Object.keys(expected).length
        Object.entries(expected).every(([account, amount]) =>
            actual[account]?.eq(ec.l10n.roundCurrency(amount.multiply(25).divide(sourceTotal, 12, "HALF_UP"), "USD"))
        )
    }
})
feature("receivable credits stay in AR and unauthorized private counterparties stay outside counts and aggregates", {
    when() {
        helper().call("update#mantle.party.Party", {partyId: f.customer, privateOwnerUserId: f.users.ar})
        login(f.users.read)
        const hidden = native("find#Receivables", {organizationPartyId: f.org})
        const totals = native("get#ReceivableSummary", {organizationPartyId: f.org})
        login(f.users.ar)
        const credits = native("find#Receivables", {organizationPartyId: f.org, queue: "credits"})
        return {hidden, totals, credits}
    },
    then({hidden, totals, credits}) {
        hidden.recordsCount == 0
        totals.summaryRows.length == 0
        credits.records.some(row => row.invoiceId == creditId)
    }
})
feature("fresh state changes require an authoritative revision and approval policy blocks AR finalization", {
    when() {
        helper().call("update#mantle.party.Party", {partyId: f.customer, privateOwnerUserId: null})
        login(f.users.ar)
        const invoice = helper().draft(f, "15")
        const missing = helper().rejected("mantle.account.InvoiceServices.change#InvoiceState", {
            invoiceId: invoice.invoiceId,
            action: "finalize"
        })
        login("john.doe")
        helper().call("update#mantle.ledger.config.PartyAcctgPreference", {
            organizationPartyId: f.org,
            invoiceApprovalRequired: "Y"
        })
        login(f.users.ar)
        const policy = helper().rejected("mantle.account.InvoiceServices.change#InvoiceState", {
            invoiceId: invoice.invoiceId,
            action: "finalize",
            lastUpdatedStamp: invoice.lastUpdatedStamp
        })
        login(f.users.approve)
        const approved = native("change#InvoiceState", {
            invoiceId: invoice.invoiceId,
            action: "approve",
            lastUpdatedStamp: invoice.lastUpdatedStamp
        })
        login("john.doe")
        helper().call("update#mantle.ledger.config.PartyAcctgPreference", {
            organizationPartyId: f.org,
            invoiceApprovalRequired: "N"
        })
        return {missing, policy, approved}
    },
    then({missing, policy, approved}) {
        missing.includes("STALE_REVISION")
        policy.includes("APPROVAL_REQUIRED")
        approved.statusId == "InvoiceFinalized"
    }
})
feature("self approval is refused by default and explicitly recorded when organization policy allows it", {
    when() {
        const invoice = helper().draft(f, "18")
        const parameters = {invoiceId: invoice.invoiceId, action: "approve", lastUpdatedStamp: invoice.lastUpdatedStamp}
        const refused = helper().rejected("mantle.account.InvoiceServices.change#InvoiceState", parameters)
        helper().call("update#mantle.ledger.config.PartyAcctgPreference", {
            organizationPartyId: f.org,
            allowAccountingSelfApproval: "Y"
        })
        native("change#InvoiceState", parameters)
        const saved = helper().lib.one(helper().lib.invoiceEntity, {invoiceId: invoice.invoiceId})
        helper().call("update#mantle.ledger.config.PartyAcctgPreference", {
            organizationPartyId: f.org,
            allowAccountingSelfApproval: "N"
        })
        return {refused, saved}
    },
    then({refused, saved}) {
        refused.includes("SELF_APPROVAL_DENIED")
        saved.isSelfApproved == "Y"
        !!saved.approvedSourceVersion
    }
})
feature("negative customer drafts become positive credits using outgoing revenue and credit edits cannot exceed the original", {
    when() {
        login(f.users.ar)
        const negative = helper().draft(f, "-10")
        native("reverse#DraftInvoice", {invoiceId: negative.invoiceId, lastUpdatedStamp: negative.lastUpdatedStamp})
        const normalized = helper().lib.one(helper().lib.invoiceEntity, {invoiceId: negative.invoiceId})
        const status = native("change#InvoiceState", {
            invoiceId: negative.invoiceId,
            action: "finalize",
            lastUpdatedStamp: normalized.lastUpdatedStamp
        })
        const linked = native("create#InvoiceCreditMemo", {
            originalInvoiceId: invoiceId,
            amount: "5",
            linkToOriginal: true,
            allocateToLines: true,
            operationKey: "native-cap-credit"
        })
        const line = helper().lib.rows("mantle.account.invoice.InvoiceItem", {invoiceId: linked.invoiceId})[0]
        const cap = helper().rejected("mantle.account.InvoiceServices.store#InvoiceDraftItem", {
            invoiceId: linked.invoiceId,
            invoiceItemSeqId: line.invoiceItemSeqId,
            lastUpdatedStamp: line.lastUpdatedStamp,
            amount: "200"
        })
        return {normalized, status, cap}
    },
    then({normalized, status, cap}) {
        normalized.invoiceTypeEnumId == "InvoiceCreditMemo"
        normalized.financeDirection == "receivable"
        status.statusId == "InvoiceFinalized"
        cap.includes("CREDIT_EXCEEDS_INVOICE")
    }
})
feature("finance bills only approved project time without a Projects permission and source retries never duplicate it", {
    when() {
        helper().call("update#mantle.party.Party", {partyId: f.customer, privateOwnerUserId: null})
        const id = "NATIVE_AR_PROJECT",
            sheetId = "NATIVE_AR_SHEET"
        const start = Number(ec.user.nowTimestamp) - 3600000,
            end = Number(ec.user.nowTimestamp) - 60000
        helper().call("create#mantle.work.effort.WorkEffort", {
            workEffortId: id,
            workEffortTypeEnumId: "WetProject",
            ownerPartyId: f.org,
            workEffortName: "Native approved billing"
        })
        for (const [partyId, roleTypeId] of [
            [f.org, "Vendor"],
            [f.customer, "Customer"]
        ])
            helper().call("create#mantle.work.effort.WorkEffortParty", {workEffortId: id, partyId, roleTypeId, fromDate: 0})
        helper().call("create#mantle.work.time.Timesheet", {
            timesheetId: sheetId,
            partyId: f.users.ar,
            statusId: "TmshApproved",
            fromDate: start,
            thruDate: end
        })
        helper().call("create#mantle.work.time.TimeEntry", {
            timeEntryId: "NATIVE_AR_TIME",
            timesheetId: sheetId,
            partyId: f.users.ar,
            vendorPartyId: f.org,
            clientPartyId: f.customer,
            workEffortId: id,
            fromDate: start,
            thruDate: end,
            hours: "1",
            clientHourRate: "85",
            vendorHourRate: "40",
            hasModifiedRates: "Y"
        })
        login(f.users.ar)
        const ready = native("find#ApprovedTimeBilling", {organizationPartyId: f.org, workEffortId: id})
        const parameters = {organizationPartyId: f.org, workEffortId: id, operationKey: "native-approved-time"}
        const made = native("create#InvoiceFromApprovedTime", parameters)
        const retry = native("create#InvoiceFromApprovedTime", parameters)
        return {ready, made, retry}
    },
    then({ready, made, retry}) {
        ready.records.length == 1
        ready.records[0].approvedHours.eq(1)
        made.invoiceItemCreatedCount == 1
        retry.invoiceId == made.invoiceId
        retry.alreadyApplied == true
    }
})
feature("worker billing uses vendor-unbilled time and vendor rates after the client side has already been billed", {
    when() {
        login(f.users.ar)
        const refused = helper().rejected("mantle.account.InvoiceServices.find#ApprovedTimeBilling", {
            organizationPartyId: f.org,
            workEffortId: "NATIVE_AR_PROJECT",
            direction: "payable"
        })
        login(f.users.ap)
        const ready = native("find#ApprovedTimeBilling", {
            organizationPartyId: f.org,
            workEffortId: "NATIVE_AR_PROJECT",
            direction: "payable"
        })
        const made = native("create#InvoiceFromApprovedTime", {
            organizationPartyId: f.org,
            workEffortId: "NATIVE_AR_PROJECT",
            workerPartyId: f.users.ar,
            direction: "payable",
            operationKey: "native-worker-time"
        })
        const invoice = helper().lib.one(helper().lib.invoiceEntity, {invoiceId: made.invoiceId})
        const entry = helper().lib.one("mantle.work.time.TimeEntry", {timeEntryId: "NATIVE_AR_TIME"})
        return {refused, ready, made, invoice, entry}
    },
    then({refused, ready, made, invoice, entry}) {
        refused.includes("PERMISSION_DENIED")
        ready.records.length == 1
        ready.records[0].approvedAmount.eq(40)
        made.invoiceItemCreatedCount == 1
        invoice.fromPartyId == f.users.ar
        invoice.toPartyId == f.org
        entry.vendorInvoiceId == made.invoiceId
        !!entry.invoiceId
        entry.vendorInvoiceId != entry.invoiceId
    }
})
feature("appending approved time preserves the original draft author", {
    when() {
        const target = helper().draft(f, "4")
        const entry = helper().lib.one("mantle.work.time.TimeEntry", {timeEntryId: "NATIVE_AR_TIME"})
        helper().call("create#mantle.work.time.TimeEntry", {
            timeEntryId: "NATIVE_AR_APPEND_TIME",
            timesheetId: entry.timesheetId,
            partyId: entry.partyId,
            vendorPartyId: f.org,
            clientPartyId: f.customer,
            workEffortId: "NATIVE_AR_PROJECT",
            fromDate: entry.fromDate,
            thruDate: entry.thruDate,
            hours: "1",
            clientHourRate: "85",
            vendorHourRate: "40",
            hasModifiedRates: "Y"
        })
        login(f.users.ar)
        const result = native("create#InvoiceFromApprovedTime", {
            organizationPartyId: f.org,
            workEffortId: "NATIVE_AR_PROJECT",
            invoiceId: target.invoiceId,
            operationKey: "native-approved-append"
        })
        const stored = helper().lib.one(helper().lib.invoiceEntity, {invoiceId: target.invoiceId})
        return {result, stored, creator: target.draftedByUserId}
    },
    then({result, stored, creator}) {
        result.invoiceItemCreatedCount == 1
        stored.draftedByUserId == creator
        stored.draftedByUserId != f.users.ar
    }
})
feature("fully applied invoices with a retained sent status stay outside unpaid and overdue queues", {
    when() {
        login(f.users.ar)
        const invoice = helper().draft(f, "11")
        native("change#InvoiceState", {
            invoiceId: invoice.invoiceId,
            action: "finalize",
            lastUpdatedStamp: invoice.lastUpdatedStamp
        })
        const credit = native("create#InvoiceCreditMemo", {
            originalInvoiceId: invoice.invoiceId,
            amount: "11",
            linkToOriginal: true,
            allocateToLines: true,
            operationKey: "native-paid-credit"
        })
        const creditRecord = helper().lib.one(helper().lib.invoiceEntity, {invoiceId: credit.invoiceId})
        native("change#InvoiceState", {
            invoiceId: creditRecord.invoiceId,
            action: "finalize",
            lastUpdatedStamp: creditRecord.lastUpdatedStamp
        })
        native("apply#InvoiceCredit", {
            invoiceId: creditRecord.invoiceId,
            toInvoiceId: invoice.invoiceId,
            amount: "11",
            operationKey: "native-paid-apply"
        })
        // Imported legacy records may retain a sent status after an application. Balance remains authoritative for queues.
        const stored = helper().lib.one(helper().lib.invoiceEntity, {invoiceId: invoice.invoiceId})
        stored.set("statusId", "InvoiceSent")
        stored.set("dueDate", Number(ec.user.nowTimestamp) - 86400000)
        stored.update()
        const all = native("find#Receivables", {organizationPartyId: f.org, invoiceId: invoice.invoiceId})
        const unpaid = native("find#Receivables", {organizationPartyId: f.org, invoiceId: invoice.invoiceId, queue: "unpaid"})
        const overdue = native("find#Receivables", {organizationPartyId: f.org, invoiceId: invoice.invoiceId, queue: "overdue"})
        return {all, unpaid, overdue}
    },
    then({all, unpaid, overdue}) {
        all.recordsCount == 1
        all.records[0].unpaidTotal.eq(0)
        unpaid.recordsCount == 0
        overdue.recordsCount == 0
    }
})
feature("missing posting mappings roll back finalization instead of leaving an issued error-journal invoice", {
    when() {
        login(f.users.ar)
        const invoice = helper().draft(f, "10")
        native("store#InvoiceDraftItem", {invoiceId: invoice.invoiceId, itemTypeEnumId: "ItemSales", amount: "5", quantity: "1"})
        const current = helper().lib.one(helper().lib.invoiceEntity, {invoiceId: invoice.invoiceId})
        const failure = helper().rejected("mantle.account.InvoiceServices.change#InvoiceState", {
            invoiceId: invoice.invoiceId,
            action: "finalize",
            lastUpdatedStamp: current.lastUpdatedStamp
        })
        const saved = helper().lib.one(helper().lib.invoiceEntity, {invoiceId: invoice.invoiceId})
        const count = helper().lib.find("mantle.ledger.transaction.AcctgTrans", {invoiceId: invoice.invoiceId}).count()
        return {failure, saved, count}
    },
    then({failure, saved, count}) {
        failure.includes("ENTRY_INVALID")
        saved.statusId == "InvoiceInProcess"
        count == 0
    }
})
feature("a named active soft-lock exception permits invoice posting while a hard lock remains absolute", {
    when() {
        const soft = helper().draft(f, "7"),
            hard = helper().draft(f, "8")
        helper().call("create#mantle.ledger.config.AccountingLock", {
            accountingLockId: "NATIVE_AR_LOCK",
            organizationPartyId: f.org,
            lockScope: "sales",
            lockThroughDate: ec.l10n.format(ec.user.nowTimestamp, "yyyy-MM-dd"),
            isHard: "N",
            changeReason: "Native lock review"
        })
        helper().call("create#mantle.ledger.config.AccountingLockException", {
            accountingLockExceptionId: "NATIVE_AR_EXCEPTION",
            accountingLockId: "NATIVE_AR_LOCK",
            organizationPartyId: f.org,
            userId: f.users.ar,
            lockScope: "sales",
            fromDate: Number(ec.user.nowTimestamp) - 60000,
            thruDate: Number(ec.user.nowTimestamp) + 60000,
            changeReason: "Allowed invoice"
        })
        login(f.users.ar)
        const posted = native("change#InvoiceState", {
            invoiceId: soft.invoiceId,
            action: "finalize",
            lastUpdatedStamp: soft.lastUpdatedStamp
        })
        login("john.doe")
        helper().call("update#mantle.ledger.config.AccountingLock", {accountingLockId: "NATIVE_AR_LOCK", isHard: "Y"})
        login(f.users.ar)
        const refused = helper().rejected("mantle.account.InvoiceServices.change#InvoiceState", {
            invoiceId: hard.invoiceId,
            action: "finalize",
            lastUpdatedStamp: hard.lastUpdatedStamp
        })
        login("john.doe")
        helper().call("delete#mantle.ledger.config.AccountingLockException", {accountingLockExceptionId: "NATIVE_AR_EXCEPTION"})
        helper().call("delete#mantle.ledger.config.AccountingLock", {accountingLockId: "NATIVE_AR_LOCK"})
        return {posted, refused}
    },
    then({posted, refused}) {
        posted.statusId == "InvoiceFinalized"
        refused.includes("HARD_LOCK")
    }
})
feature("Chicago book dates retain hard locks when a UTC approver views and directly posts the same source timestamp", {
    when() {
        helper().call("update#moqui.security.UserAccount", {userId: f.users.ar, timeZone: "America/Chicago"})
        helper().call("update#moqui.security.UserAccount", {userId: f.users.approve, timeZone: "UTC"})
        login(f.users.ar)
        const source = native("create#Receivable", {
            organizationPartyId: f.org,
            customerPartyId: f.customer,
            invoiceDate: new Date(Date.UTC(2026, 9, 29, 4, 30))
        })
        native("store#InvoiceDraftItem", {
            invoiceId: source.invoiceId,
            itemTypeEnumId: "ItemTimeEntry",
            quantity: "1",
            amount: "16"
        })
        const invoice = helper().lib.one(helper().lib.invoiceEntity, {invoiceId: source.invoiceId})
        const fingerprint = helper().lib.fingerprint(invoice)
        const bookDate = helper().lib.policy.calendarDateText(invoice.accountingDate)
        login("john.doe")
        helper().call("create#mantle.ledger.config.AccountingLock", {
            accountingLockId: "NATIVE_AR_ZONE_LOCK",
            organizationPartyId: f.org,
            lockScope: "sales",
            lockThroughDate: "2026-10-28",
            isHard: "Y",
            changeReason: "Zone-independent book date"
        })
        const transaction = helper().call("mantle.ledger.LedgerServices.create#AcctgTrans", {
            organizationPartyId: f.org,
            invoiceId: source.invoiceId,
            transactionDate: invoice.invoiceDate,
            acctgTransTypeEnumId: "AttSalesInvoice",
            amountUomId: "USD"
        })
        const accounts = helper()
            .lib.rows("mantle.ledger.account.GlAccountAndOrganization", {organizationPartyId: f.org})
            .filter(row => row.disallowPosting !== "Y")
        for (const [glAccountId, debitCreditFlag] of [
            [accounts[0].glAccountId, "D"],
            [accounts[1].glAccountId, "C"]
        ])
            helper().call("mantle.ledger.LedgerServices.create#AcctgTransEntry", {
                acctgTransId: transaction.acctgTransId,
                glAccountId,
                debitCreditFlag,
                amount: "16"
            })
        login(f.users.approve)
        const visibleDay = ec.l10n.format(invoice.invoiceDate, "yyyy-MM-dd")
        const detail = native("get#InvoiceFinanceDetail", {invoiceId: source.invoiceId})
        const printed = native("get#InvoiceOutput", {invoiceId: source.invoiceId})
        const refused = helper().rejected("mantle.account.InvoiceServices.change#InvoiceState", {
            invoiceId: source.invoiceId,
            action: "approve",
            lastUpdatedStamp: invoice.lastUpdatedStamp
        })
        const direct = helper().call("mantle.ledger.LedgerServices.post#AcctgTrans", {
            acctgTransId: transaction.acctgTransId,
            verifyOnly: true
        })
        const unchanged = helper().lib.one(helper().lib.invoiceEntity, {invoiceId: source.invoiceId})
        login("john.doe")
        helper().call("delete#mantle.ledger.config.AccountingLock", {accountingLockId: "NATIVE_AR_ZONE_LOCK"})
        return {bookDate, visibleDay, refused, direct, fingerprint, detail, printed, after: helper().lib.fingerprint(unchanged)}
    },
    then({bookDate, visibleDay, refused, direct, fingerprint, detail, printed, after}) {
        bookDate == "2026-10-28"
        visibleDay == "2026-10-29"
        detail.invoice.invoiceDateText == "2026-10-28"
        detail.invoice.invoiceDateValue == "2026-10-28"
        printed.printHtml.includes("<th>Date</th><td>2026-10-28</td>")
        refused.includes("HARD_LOCK")
        direct.valid == false
        direct.findings.some(row => row.code == "HARD_LOCK")
        after == fingerprint
    }
})
feature("a linked customer credit meets sales locks at the posting choke point despite its reversed parties", {
    when() {
        const credit = helper().lib.one(helper().lib.invoiceEntity, {invoiceId: creditId})
        const day = helper().lib.policy.calendarDateText(credit.accountingDate)
        helper().call("create#mantle.ledger.config.AccountingLock", {
            accountingLockId: "NATIVE_AR_CREDIT_LOCK",
            organizationPartyId: f.org,
            lockScope: "sales",
            lockThroughDate: day,
            isHard: "Y",
            changeReason: "Logical receivables lock"
        })
        const transaction = helper().lib.rows("mantle.ledger.transaction.AcctgTrans", {
            invoiceId: creditId,
            organizationPartyId: f.org,
            isPosted: "Y"
        })[0]
        login(f.users.approve)
        const result = helper().call("mantle.ledger.LedgerServices.post#AcctgTrans", {
            acctgTransId: transaction.acctgTransId,
            verifyOnly: true
        })
        login("john.doe")
        helper().call("delete#mantle.ledger.config.AccountingLock", {accountingLockId: "NATIVE_AR_CREDIT_LOCK"})
        return {result}
    },
    then({result}) {
        result.valid == false
        result.findings.some(row => row.code == "HARD_LOCK" && row.message.includes("sales"))
    }
})
feature("an open-period credit settles a closed-period original without rewriting its posted history", {
    when() {
        let october, fixture
        try {
            ec.user.setEffectiveTime(Date.UTC(2026, 10, 15, 18))
            fixture = helper().fixtures("NATIVE_SETTLE")
            const months = helper().lib.rows("mantle.party.time.TimePeriod", {
                partyId: fixture.org,
                timePeriodTypeId: "FiscalMonth"
            })
            const november = months.find(row => helper().lib.policy.calendarDateText(row.fromDate) == "2026-11-01")
            helper().call("mantle.party.TimeServices.getOrCreate#PreviousTimePeriod", {timePeriodId: november.timePeriodId})
            october = helper()
                .lib.rows("mantle.party.time.TimePeriod", {partyId: fixture.org, timePeriodTypeId: "FiscalMonth"})
                .find(row => helper().lib.policy.calendarDateText(row.fromDate) == "2026-10-01")
            login(fixture.users.ar)
            const source = native("create#Receivable", {
                organizationPartyId: fixture.org,
                customerPartyId: fixture.customer,
                invoiceDate: Date.UTC(2026, 9, 15, 18)
            })
            native("store#InvoiceDraftItem", {
                invoiceId: source.invoiceId,
                itemTypeEnumId: "ItemTimeEntry",
                amount: "14",
                quantity: "1"
            })
            const current = helper().lib.one(helper().lib.invoiceEntity, {invoiceId: source.invoiceId})
            native("change#InvoiceState", {
                invoiceId: source.invoiceId,
                action: "finalize",
                lastUpdatedStamp: current.lastUpdatedStamp
            })
            const original = helper().lib.rows("mantle.ledger.transaction.AcctgTrans", {
                invoiceId: source.invoiceId,
                isPosted: "Y"
            })[0]
            const originalJson = JSON.stringify(helper().lib.map(original))
            helper().call("update#mantle.party.time.TimePeriod", {timePeriodId: october.timePeriodId, isClosed: "Y"})
            const credit = native("create#InvoiceCreditMemo", {
                originalInvoiceId: source.invoiceId,
                amount: "14",
                linkToOriginal: true,
                allocateToLines: true,
                operationKey: "native-closed-source-credit"
            })
            const creditRow = helper().lib.one(helper().lib.invoiceEntity, {invoiceId: credit.invoiceId})
            native("change#InvoiceState", {
                invoiceId: creditRow.invoiceId,
                action: "finalize",
                lastUpdatedStamp: creditRow.lastUpdatedStamp
            })
            helper().call("create#mantle.ledger.config.AccountingLock", {
                accountingLockId: "NATIVE_SETTLE_LOCK",
                organizationPartyId: fixture.org,
                lockScope: "sales",
                lockThroughDate: "2026-11-15",
                isHard: "Y",
                changeReason: "Current settlement lock"
            })
            const parameters = {
                invoiceId: creditRow.invoiceId,
                toInvoiceId: source.invoiceId,
                amount: "14",
                operationKey: "native-closed-source-apply"
            }
            const denied = helper().rejected("mantle.account.InvoiceServices.apply#InvoiceCredit", parameters)
            helper().call("delete#mantle.ledger.config.AccountingLock", {accountingLockId: "NATIVE_SETTLE_LOCK"})
            const result = native("apply#InvoiceCredit", parameters)
            const application = helper().lib.one("mantle.account.payment.PaymentApplication", {
                paymentApplicationId: result.paymentApplicationId
            })
            const transactions = helper().lib.rows("mantle.ledger.transaction.AcctgTrans", {
                paymentApplicationId: result.paymentApplicationId
            })
            const unchanged = helper().lib.one("mantle.ledger.transaction.AcctgTrans", {acctgTransId: original.acctgTransId})
            return {
                denied,
                result,
                application,
                transactions,
                originalJson,
                afterJson: JSON.stringify(helper().lib.map(unchanged))
            }
        } finally {
            login("john.doe")
            if (october) helper().call("update#mantle.party.time.TimePeriod", {timePeriodId: october.timePeriodId, isClosed: "N"})
            if (fixture) helper().cleanupLocks(fixture.org)
            ec.user.setEffectiveTime(null)
        }
    },
    then({denied, result, application, transactions, originalJson, afterJson}) {
        denied.includes("HARD_LOCK")
        result.amountApplied.eq(14)
        helper().lib.policy.calendarDateText(application.appliedDate) == "2026-11-15"
        transactions.length > 0
        transactions.every(row => row.isPosted == "Y")
        originalJson == afterJson
    }
})
