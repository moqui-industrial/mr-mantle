// Accounting setup and activation (AC-01): a new organization set up from the chart template, its opening trial balance
// and open items tying before activation, one bad open item named and the rest kept, an import repeated without making
// anything twice, activation posting once however often it is asked, and aging, dunning and a payment run working on the
// imported items. Standalone: spec-local organization, counterparties and users.
const helper = () => ec.resource.script("component://mr-mantle/test/account/AccountingSettlementFixtures.js")
const svc = (name, p) => helper().call(name, p)
const setup = (name, p) => helper().call("mantle.ledger.SetupServices." + name, p)
const refused = (name, p) => helper().rejected(name.includes(".") ? name : "mantle.ledger.SetupServices." + name, p)
const one = (entity, key) => helper().lib.one(entity, key)
const policy = () => ec.resource.script("component://mr-mantle/service/mantle/ledger/AccountingPolicy.js")
const bookDay = value => policy().lib.bookDay(null, value)
const calendar = value => policy().calendarDateText(value)
const rows = (entity, key) => helper().lib.rows(entity, key)
const prefix = "NATIVE_SETUP"
const org = prefix + "_ORG",
    customer = prefix + "_CUST",
    supplier = prefix + "_SUP"
const day = offset => ec.l10n.format(new Date(Number(ec.user.nowTimestamp) + offset * 86400000), "yyyy-MM-dd")
const opening = day(-1)
const balances = (receivable, payable) => [
    {glAccountId: "111100000", debitAmount: "1000"},
    {glAccountId: "141300000", debitAmount: "400"},
    {glAccountId: "121000000", debitAmount: receivable},
    {glAccountId: "212000000", creditAmount: payable},
    {glAccountId: "331100000", creditAmount: "1000"},
    {glAccountId: "335000000", creditAmount: "800"}
]
let users, version, items, firstTrans

function party(partyId, roleTypeId) {
    svc("create#mantle.party.Party", {partyId, partyTypeEnumId: "PtyOrganization"})
    svc("create#mantle.party.Organization", {partyId, organizationName: partyId + " name"})
    svc("create#mantle.party.PartyRole", {partyId, roleTypeId})
}
function runVersion() {
    return Number(rows("mantle.ledger.config.AccountingSetupRun", {organizationPartyId: org})[0].runVersion)
}

spec({
    stepwise: true,
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        // an internal organization with no accounting configuration, a customer and a supplier
        party(org, "OrgInternal")
        party(customer, "Customer")
        party(supplier, "Supplier")
        svc("mantle.party.ContactServices.create#EmailAddress", {
            partyId: customer,
            emailAddress: "billing@setup.example",
            contactMechPurposeId: "EmailBilling"
        })
        const h = helper(),
            f = {org}
        users = {
            admin: h.user(f, "ADMIN", ["ACCOUNTING_ADMIN", "INVOICE_APPROVE"]),
            read: h.user(f, "READ", ["ACCOUNTING_VIEW"]),
            ar: h.user(f, "AR", ["RECEIVABLE_EDIT", "RECEIVABLE_VIEW"]),
            ap: h.user(f, "AP", ["PAYABLE_EDIT", "PAYABLE_VIEW"])
        }
    },
    setup() {
        ec.artifactExecution.disableAuthz()
    },
    cleanup() {
        login("john.doe")
    }
})

feature("finance administration sets up a new organization from the chart template; others and a non-template are refused", {
    when() {
        const request = {
            organizationPartyId: org,
            sourcePartyId: "DefaultSettings",
            baseCurrencyUomId: "USD",
            fiscalYearStartMonth: "1",
            fiscalYearStartDay: "1",
            openingDate: opening
        }
        login(users.read)
        const denied = refused("store#SetupRun", request)
        login(users.admin)
        const before = setup("preview#OpeningBalances", {organizationPartyId: org})
        const notTemplate = refused("store#SetupRun", Object.assign({}, request, {sourcePartyId: "ORG_ZIZI_RETAIL"}))
        const stored = setup("store#SetupRun", request)
        const stale = refused("store#SetupRun", Object.assign({}, request, {runVersion: 9}))
        return {
            denied,
            before,
            notTemplate,
            stored,
            stale,
            preference: one("mantle.ledger.config.PartyAcctgPreference", {organizationPartyId: org}),
            run: rows("mantle.ledger.config.AccountingSetupRun", {organizationPartyId: org})[0],
            periods: helper()
                .lib.find("mantle.party.time.TimePeriod", {partyId: org})
                .condition("fromDate", "less-equals", opening)
                .condition("thruDate", "greater-equals", opening)
                .count()
        }
    },
    then({denied, before, notTemplate, stored, stale, preference, run, periods}) {
        denied.includes("PERMISSION_DENIED")
        before.setupRun == null
        before.configured == false
        before.templateOptions.some(row => row.partyId == "DefaultSettings")
        notTemplate.includes("TEMPLATE_INVALID")
        stored.runVersion == 1
        stale.includes("STALE_REVISION")
        preference.baseCurrencyUomId == "USD"
        preference.postingGuardEnabled == "Y"
        run.statusId == "AsrDraft"
        run.sourcePartyId == "DefaultSettings"
        run.migrationGlAccountId == "913000000"
        periods > 0
    }
})

feature("the opening balances are saved, a summary or migration account line is refused, and the totals show", {
    when() {
        login(users.admin)
        const base = {organizationPartyId: org}
        const summary = refused(
            "store#SetupRun",
            Object.assign({}, base, {runVersion: runVersion(), balanceLine: {glAccountId: "330000000", creditAmount: "5"}})
        )
        const migration = refused(
            "store#SetupRun",
            Object.assign({}, base, {runVersion: runVersion(), balanceLine: {glAccountId: "913000000", debitAmount: "5"}})
        )
        const both = refused(
            "store#SetupRun",
            Object.assign({}, base, {
                runVersion: runVersion(),
                balanceLine: {glAccountId: "111100000", debitAmount: "5", creditAmount: "5"}
            })
        )
        // the receivable line is 650: the open items will not tie, and the lines do not balance
        setup("store#SetupRun", Object.assign({}, base, {runVersion: runVersion(), balances: balances("650", "300")}))
        // a line saved on its own, then removed
        setup("store#SetupRun", Object.assign({}, base, {runVersion: runVersion(), balanceLine: {glAccountId: "334000000", debitAmount: "5"}}))
        setup("store#SetupRun", Object.assign({}, base, {runVersion: runVersion(), balanceLine: {glAccountId: "334000000"}}))
        return {summary, migration, both, preview: setup("preview#OpeningBalances", base)}
    },
    then({summary, migration, both, preview}) {
        summary.includes("ACCOUNT_UNAVAILABLE")
        migration.includes("MIGRATION_ACCOUNT_LINE")
        both.includes("BALANCE_SIDE_INVALID")
        preview.balanceRows.length == 6
        preview.debitTotal.eq(2050)
        preview.creditTotal.eq(2100)
        preview.balanced == false
        preview.balanceRows.find(row => row.glAccountId == "121000000").controlAccount == true
    }
})

feature("open items: a bad row is named and the rest kept; importing again makes nothing twice", {
    when() {
        login(users.admin)
        const csvText = [
            "direction,partyId,documentNumber,documentDate,dueDate,openAmount",
            ["receivable", customer, "OLD-INV-1", day(-40), day(-10), "500"].join(","),
            ["receivable", customer, "OLD-INV-2", day(-5), day(25), "200"].join(","),
            ["payable", supplier, "OLD-BILL-1", day(-30), day(-2), "300"].join(","),
            ["payable", prefix + "_NOBODY", "OLD-BILL-2", day(-30), day(-2), "90"].join(","),
            ["payable", supplier, "OLD-BILL-3", day(3), day(20), "90"].join(",")
        ].join("\n")
        const checked = setup("import#OpenItems", {organizationPartyId: org, csvText, verifyOnly: true})
        const madeBefore = rows("mantle.account.invoice.Invoice", {fromPartyId: org}).length
        const first = setup("import#OpenItems", {organizationPartyId: org, csvText})
        const again = setup("import#OpenItems", {organizationPartyId: org, csvText})
        const conflict = setup("import#OpenItems", {
            organizationPartyId: org,
            rows: [{direction: "receivable", partyId: customer, documentNumber: "OLD-INV-1", documentDate: day(-40),
                dueDate: day(-10), openAmount: "501"}]
        })
        login(users.read)
        const denied = refused("import#OpenItems", {organizationPartyId: org, csvText})
        items = Object.fromEntries(first.rowResults.filter(row => row.invoiceId).map(row => [row.documentNumber, row.invoiceId]))
        const invoice = one("mantle.account.invoice.Invoice", {invoiceId: items["OLD-INV-1"]})
        const bill = one("mantle.account.invoice.Invoice", {invoiceId: items["OLD-BILL-1"]})
        const posting = helper()
            .lib.find("mantle.ledger.transaction.AcctgTrans", {invoiceId: items["OLD-INV-1"], organizationPartyId: org})
            .one()
        return {
            checked,
            madeBefore,
            first,
            again,
            conflict,
            denied,
            invoice,
            bill,
            posting,
            entries: rows("mantle.ledger.transaction.AcctgTransEntry", {acctgTransId: posting.acctgTransId}),
            schedule: rows("mantle.account.invoice.InvoiceDueSchedule", {invoiceId: items["OLD-INV-1"]}),
            opened: rows("mantle.account.invoice.Invoice", {openingSetupRunId: invoice.openingSetupRunId}).length
        }
    },
    then(r) {
        r.checked.validCount == 3
        r.checked.failedCount == 2
        r.madeBefore == 0
        r.first.createdCount == 3
        r.first.failedCount == 2
        r.first.rowResults.find(row => row.documentNumber == "OLD-BILL-2").reasonCode == "PARTY_UNAVAILABLE"
        r.first.rowResults.find(row => row.documentNumber == "OLD-BILL-2").rowNumber == 5
        r.first.rowResults.find(row => row.documentNumber == "OLD-BILL-3").reasonCode == "DOCUMENT_AFTER_OPENING"
        r.again.createdCount == 0
        r.again.existingCount == 3
        r.again.rowResults.find(row => row.documentNumber == "OLD-INV-1").invoiceId == items["OLD-INV-1"]
        r.conflict.rowResults[0].reasonCode == "OPEN_ITEM_CONFLICT"
        r.denied.includes("PERMISSION_DENIED")
        r.opened == 3
        r.invoice.statusId == "InvoiceFinalized"
        r.bill.statusId == "InvoiceApproved"
        r.bill.approvedByUserId == users.admin
        r.bill.isSelfApproved == "Y"
        bookDay(r.invoice.dueDate) == day(-10)
        bookDay(r.invoice.invoiceDate) == day(-40)
        r.posting.isPosted == "Y"
        calendar(r.posting.accountingDate) == opening
        r.entries.some(row => row.glAccountId == "913000000" && row.debitCreditFlag == "C")
        r.entries.some(row => row.glAccountId == "121000000" && row.debitCreditFlag == "D")
        r.schedule.length == 1
        calendar(r.schedule[0].dueDate) == day(-10)
    }
})

feature("readiness names the untied open items and blocks activation, which posts once the balances tie", {
    when() {
        login(users.admin)
        const before = setup("check#Readiness", {organizationPartyId: org})
        const blocked = refused("activate#Accounting", {organizationPartyId: org, runVersion: runVersion(), operationKey: "SETUP-BLOCKED"})
        setup("store#SetupRun", {organizationPartyId: org, runVersion: runVersion(), balances: balances("700", "300")})
        const preview = setup("preview#OpeningBalances", {organizationPartyId: org})
        const ready = setup("check#Readiness", {organizationPartyId: org})
        const stale = refused("activate#Accounting", {organizationPartyId: org, runVersion: 1, operationKey: "SETUP-STALE"})
        login(users.read)
        const denied = refused("activate#Accounting", {organizationPartyId: org, runVersion: runVersion(), operationKey: "SETUP-READ"})
        login(users.admin)
        const first = setup("activate#Accounting", {organizationPartyId: org, runVersion: runVersion(), operationKey: "SETUP-ONE"})
        firstTrans = first.acctgTransId
        const retry = setup("activate#Accounting", {organizationPartyId: org, runVersion: runVersion(), operationKey: "SETUP-ONE"})
        const second = setup("activate#Accounting", {organizationPartyId: org, runVersion: runVersion(), operationKey: "SETUP-TWO"})
        const changed = refused("store#SetupRun", {organizationPartyId: org, runVersion: runVersion(), balances: []})
        const late = setup("import#OpenItems", {
            organizationPartyId: org,
            rows: [{direction: "payable", partyId: supplier, documentNumber: "LATE", documentDate: day(-3), dueDate: day(9),
                openAmount: "10"}]
        })
        const migration = helper()
            .lib.rows("mantle.ledger.transaction.AcctgTransEntry", {glAccountId: "913000000"})
            .filter(row => one("mantle.ledger.transaction.AcctgTrans", {acctgTransId: row.acctgTransId}).organizationPartyId == org)
            .reduce((sum, row) => sum + (row.debitCreditFlag == "D" ? 1 : -1) * Number(String(row.amount)), 0)
        return {
            row: code => before.readinessRows.find(row => row.code == code),
            readyRow: code => ready.readinessRows.find(row => row.code == code),
            before,
            blocked,
            preview,
            ready,
            stale,
            denied,
            first,
            retry,
            second,
            changed,
            late,
            migration,
            openings: rows("mantle.ledger.transaction.AcctgTrans", {organizationPartyId: org, acctgTransTypeEnumId: "AttOpeningBalance"}),
            entries: rows("mantle.ledger.transaction.AcctgTransEntry", {acctgTransId: first.acctgTransId}),
            run: rows("mantle.ledger.config.AccountingSetupRun", {organizationPartyId: org})[0]
        }
    },
    then(r) {
        r.row("OPEN_ITEM_TIE").status == "blocker"
        r.row("OPEN_ITEM_TIE").detailText.includes("open items 500.00") || r.row("OPEN_ITEM_TIE").detailText.includes("open items 700.00")
        r.row("OPENING_BALANCED").status == "blocker"
        r.row("POSTING_GUARD").status == "ok"
        r.row("EXCHANGE_RATES").status == "ok"
        !r.before.readinessRows.some(row => row.code == "SINGLE_CURRENCY")
        r.row("REMINDER_JOB").status == "ok"
        r.row("POSTED_HISTORY").status == "ok"
        r.row("PRODUCTION_ACCOUNTS").status == "warning"
        r.row("PRODUCTION_ACCOUNTS").detailText.includes("Applied production labor")
        r.row("WIP_TRANSFER").status == "ok"
        r.row("BANK_METHODS").status == "warning"
        r.blocked.includes("SETUP_NOT_READY")
        r.preview.ties == true
        r.preview.balanced == true
        r.preview.receivableCount == 2
        r.preview.receivableTotal.eq(700)
        r.preview.payableTotal.eq(300)
        r.preview.lastImport.failedRows[0].reasonCode == "OPEN_ITEM_CONFLICT"
        r.ready.ready == true
        r.readyRow("OPEN_ITEM_TIE").status == "ok"
        r.stale.includes("STALE_REVISION")
        r.denied.includes("PERMISSION_DENIED")
        r.first.alreadyActivated == false
        !!r.first.acctgTransId
        r.retry.alreadyActivated == true
        r.retry.acctgTransId == r.first.acctgTransId
        r.second.alreadyActivated == true
        r.second.acctgTransId == r.first.acctgTransId
        r.openings.length == 1
        r.openings[0].isPosted == "Y"
        calendar(r.openings[0].accountingDate) == opening
        !r.entries.some(row => row.glAccountId == "121000000" || row.glAccountId == "212000000")
        r.migration == 0
        r.run.statusId == "AsrActivated"
        r.run.activatedAcctgTransId == r.first.acctgTransId
        r.changed.includes("SETUP_ACTIVATED")
        r.late.rowResults[0].reasonCode == "SETUP_ACTIVATED"
    }
})

feature("aging, dunning and a payment run work on the imported items", {
    when() {
        login("john.doe")
        const server = prefix + "_SMTP"
        svc("create#moqui.basic.email.EmailServer", {emailServerId: server, smtpHost: "127.0.0.1", smtpPort: "9", smtpStartTls: "N", smtpSsl: "N"})
        svc("create#moqui.basic.email.EmailTemplate", {emailTemplateId: prefix + "_EMAIL", description: "Setup reminders",
            emailServerId: server, fromAddress: "ar@setup.example", subject: "Reminder"})
        const bankId = svc("mantle.account.PaymentMethodServices.create#BankAccount", {
            ownerPartyId: org,
            description: "Operating account",
            bankName: "Test Bank",
            routingNumber: "021000021",
            accountNumber: "5550001234",
            typeEnumId: "BatChecking",
            currencyUomId: "USD",
            companyNameOnAccount: "Setup Org",
            nachaImmedDest: "021000021",
            nachaImmedOrig: "1234567890",
            nachaCompanyId: "1234567890",
            nachaEntryDescription: "SUPPLIERS"
        }).paymentMethodId
        svc("mantle.account.PaymentMethodServices.create#BankAccount", {
            ownerPartyId: supplier,
            description: "Supplier checking",
            bankName: "Supplier Bank",
            routingNumber: "011000015",
            accountNumber: "4440001777",
            typeEnumId: "BatChecking",
            companyNameOnAccount: "Setup supplier"
        })
        login(users.admin)
        svc("mantle.account.CollectionServices.store#Level", {
            organizationPartyId: org,
            description: "Reminder",
            daysOverdueFrom: 1,
            emailTemplateId: prefix + "_EMAIL",
            changeReason: "Setup"
        })
        login(users.read)
        const aging = svc("mantle.ledger.LedgerReportServices.run#Aging", {organizationPartyId: org, partyId: customer})
        const payables = svc("mantle.ledger.LedgerReportServices.run#Aging", {
            organizationPartyId: org,
            invoiceType: "payable",
            partyId: supplier
        })
        login(users.ar)
        const dunning = svc("mantle.account.CollectionServices.preview#Dunning", {organizationPartyId: org})
        login(users.ap)
        const run = svc("mantle.account.PaymentRunServices.create#Run", {
            organizationPartyId: org,
            paymentMethodId: bankId,
            paymentInstrumentEnumId: "PiAch",
            dueThroughDate: day(0),
            payDate: day(0)
        })
        return {
            aging,
            payables,
            notices: rows("mantle.account.invoice.DunningNotice", {dunningRunId: dunning.dunningRunId}),
            runItems: rows("mantle.account.payment.PaymentRunItem", {paymentRunId: run.paymentRunId})
        }
    },
    then({aging, payables, notices, runItems}) {
        aging.detailRows.some(row => row.invoiceId == items["OLD-INV-1"] && row.bucket > 0)
        aging.detailRows.some(row => row.invoiceId == items["OLD-INV-2"] && row.bucket == 0)
        payables.detailRows.some(row => row.invoiceId == items["OLD-BILL-1"])
        notices.some(row => row.customerPartyId == customer && String(row.invoiceIds).includes(items["OLD-INV-1"]))
        !notices.some(row => String(row.invoiceIds || "").includes(items["OLD-INV-2"]))
        runItems.some(row => row.invoiceId == items["OLD-BILL-1"] && row.selectedIndicator == "Y")
    }
})

feature("a rolled-up organization inherits its configuration: it is not set up from a template, keeps its parent's basis, and needs the guard for open items", {
    when() {
        login("john.doe")
        const parent = prefix + "_PARENT",
            child = prefix + "_CHILD"
        party(parent, "OrgInternal")
        party(child, "OrgInternal")
        svc("mantle.ledger.LedgerServices.init#PartyAccountingConfiguration", {
            organizationPartyId: parent,
            sourcePartyId: "DefaultSettings",
            baseCurrencyUomId: "USD"
        })
        svc("create#mantle.party.PartyRelationship", {
            relationshipTypeEnumId: "PrtOrgRollup",
            fromPartyId: child,
            fromRoleTypeId: "OrgInternal",
            toPartyId: parent,
            toRoleTypeId: "OrgInternal",
            fromDate: 0
        })
        login(users.admin)
        const status = svc("mantle.ledger.SetupServices.get#Readiness", {organizationPartyId: child}).setupStatus
        const preview = setup("preview#OpeningBalances", {organizationPartyId: child})
        const otherCurrency = refused("store#SetupRun", {organizationPartyId: child, baseCurrencyUomId: "EUR", openingDate: opening})
        const stored = setup("store#SetupRun", {organizationPartyId: child, baseCurrencyUomId: "USD", openingDate: opening})
        // the parent's posting guard is off (init's default), so an open item would post on its document date
        const unguarded = setup("import#OpenItems", {
            organizationPartyId: child,
            verifyOnly: true,
            rows: [{direction: "receivable", partyId: customer, documentNumber: "CHILD-1", documentDate: day(-9),
                dueDate: day(9), openAmount: "10"}]
        })
        const readiness = setup("check#Readiness", {organizationPartyId: child})
        const own = one("mantle.ledger.config.PartyAcctgPreference", {organizationPartyId: child})
        // its first own preferences, naming one flag, start from the parent's: the base currency stays
        setup("store#Preferences", {organizationPartyId: child, settings: {returnSettlementRequired: "Y"}, changeReason: "Spec flag"})
        return {
            status,
            preview,
            otherCurrency,
            stored,
            unguarded,
            row: code => readiness.readinessRows.find(row => row.code == code),
            own,
            firstOwn: one("mantle.ledger.config.PartyAcctgPreference", {organizationPartyId: child}),
            run: rows("mantle.ledger.config.AccountingSetupRun", {organizationPartyId: child})[0]
        }
    },
    then(r) {
        r.status == "configured"
        r.preview.configured == true
        r.preview.inheritedFrom == prefix + "_PARENT"
        r.preview.defaultMigrationGlAccountId == "913000000"
        r.otherCurrency.includes("BASIS_INHERITED")
        r.stored.runVersion == 1
        r.own == null
        r.run.sourcePartyId == null
        r.unguarded.rowResults[0].reasonCode == "POSTING_GUARD_REQUIRED"
        r.row("WIP_TRANSFER").status == "ok"
        r.row("CHART").status == "ok"
        r.row("POSTING_GUARD").status == "blocker"
        r.firstOwn.returnSettlementRequired == "Y"
        r.firstOwn.baseCurrencyUomId == "USD"
    }
})

feature("a credit on an open item posts to the account mapped to opening balances, never to migration clearing", {
    when() {
        login("john.doe")
        const credit = key => ({
            organizationPartyId: org,
            originalInvoiceId: items["OLD-INV-2"],
            amount: "20",
            linkToOriginal: true,
            allocateToLines: true,
            operationKey: "SETUP-CREDIT-" + key
        })
        const unmapped = refused("mantle.account.InvoiceServices.create#InvoiceCreditMemo", credit("A"))
        svc("create#mantle.ledger.config.ItemTypeGlAccount", {
            organizationPartyId: org,
            itemTypeEnumId: "ItemOpeningBalance",
            direction: "O",
            glAccountId: "412000000"
        })
        const made = svc("mantle.account.InvoiceServices.create#InvoiceCreditMemo", credit("B"))
        return {unmapped, lines: rows("mantle.account.invoice.InvoiceItem", {invoiceId: made.invoiceId})}
    },
    then({unmapped, lines}) {
        unmapped.includes("CREDIT_ACCOUNT_MISSING")
        lines.length == 1
        lines[0].overrideGlAccountId == "412000000"
    }
})

