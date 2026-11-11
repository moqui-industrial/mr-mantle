// Accounting setup and activation (AC-01): what XML Actions do not express well. The opening trial balance's lines and
// their tie-out to the open items, the readiness checks, the open item import loop with a result per row, and the
// opening entry activation posts. The run, an open item and activation are inline XML Actions in SetupServices.xml,
// which call these.
const policy = ec.resource.script("component://mr-mantle/service/mantle/ledger/AccountingPolicy.js")
const setup = ec.resource.script("component://mr-mantle/service/mantle/ledger/AccountingSetup.js")
const {find, one, rows, map, call, denied, display} = policy
const entityLib = policy.lib
const RUN = "mantle.ledger.config.AccountingSetupRun",
    BALANCE = "mantle.ledger.config.AccountingSetupBalance",
    INVOICE = "mantle.account.invoice.Invoice",
    TRANS = "mantle.ledger.transaction.AcctgTrans",
    ENTRY = "mantle.ledger.transaction.AcctgTransEntry"
const zero = () => toDecimal(0)

function setupRun(organizationPartyId) {
    return organizationPartyId ? one(RUN, {organizationPartyId}) : null
}
// The chart templates: organizations with the OrgAccountingTemplate role and an accounting preference.
function templates() {
    const ids = rows("mantle.party.PartyRole", {roleTypeId: "OrgAccountingTemplate"}).map(row => row.partyId)
    const names = entityLib.partyNames(ids)
    return ids
        .filter(id => one("mantle.ledger.config.PartyAcctgPreference", {organizationPartyId: id}))
        .map(id => ({partyId: id, name: names[id] || id}))
        .sort((a, b) => a.name.localeCompare(b.name))
}
function accountNames(ids) {
    const unique = [...new Set(ids.filter(Boolean))]
    if (!unique.length) return {}
    return Object.fromEntries(
        Array.from(find("mantle.ledger.account.GlAccount").condition("glAccountId", "in", unique).list()).map(row => [
            row.glAccountId,
            (row.accountCode || row.glAccountId) + " " + (row.accountName || "")
        ])
    )
}
// A day text (yyyy-MM-dd) as the timestamp of its start in the user's zone.
function dayStamp(day) {
    return ec.l10n.parseTimestamp(policy.calendarDateText(day) + " 00:00:00", "yyyy-MM-dd HH:mm:ss")
}
// The base currency of the organization (its own or inherited preference).
function baseCurrency(organizationPartyId) {
    return policy.preference(organizationPartyId).baseCurrencyUomId || null
}
// One opening balance line checked and rounded: an active posting account of the organization on the opening day other
// than the migration account, and a positive debit or credit, not both.
function balanceLine(p) {
    const line = p.line || {}
    let glAccountId = String(line.glAccountId || line.account || "").trim()
    if (glAccountId && !one("mantle.ledger.account.GlAccount", {glAccountId})) {
        const byCode = one("mantle.ledger.account.GlAccount", {accountCode: glAccountId})
        if (byCode) glAccountId = byCode.glAccountId
    }
    if (!glAccountId) denied("ACCOUNT_REQUIRED", "Choose the account of each opening balance line")
    if (glAccountId === p.migrationGlAccountId)
        denied("MIGRATION_ACCOUNT_LINE", "The migration clearing account is not an opening balance line")
    try {
        policy.account(p.organizationPartyId, glAccountId, dayStamp(p.openingDate))
    } catch (error) {
        denied("ACCOUNT_UNAVAILABLE", "Account " + glAccountId + " is not an active posting account of the organization")
    }
    const amount = value =>
        value == null || String(value).trim() === "" || toDecimal(value).isZero()
            ? null
            : entityLib.amount(value, p.currencyUomId)
    const debitAmount = amount(line.debitAmount ?? line.debit),
        creditAmount = amount(line.creditAmount ?? line.credit)
    if (debitAmount && creditAmount)
        denied("BALANCE_SIDE_INVALID", "Account " + glAccountId + " has a debit and a credit; enter its net balance")
    return {glAccountId, debitAmount, creditAmount, empty: !debitAmount && !creditAmount}
}
// The opening balance lines of a CSV text with the headers account (an account ID or code), debit and credit.
function balanceRows(p) {
    const parsed = ec.resource.script("component://mr-mantle/service/mantle/ledger/Currencies.js").csv(String(p.csvText || ""))
    const header = (parsed.shift() || []).map(text => text.trim())
    if (!header.includes("account") || !header.some(text => text === "debit" || text === "credit"))
        denied("CSV_HEADER_INVALID", "The trial balance needs the headers account, debit and credit")
    if (parsed.length > 5000) denied("CSV_TOO_LONG", "A trial balance of at most 5,000 lines")
    return {lines: parsed.map(row => Object.fromEntries(header.map((name, index) => [name, row[index] ?? null])))}
}
// The receivable and payable control accounts: the organization's defaults and what the opening items posted to,
// less the migration account.
function controlAccounts(run) {
    const ids = new Set()
    for (const glAccountTypeEnumId of ["GatAccountsReceivable", "GatAccountsPayable"]) {
        const out = call("mantle.ledger.LedgerServices.get#DefaultGlAccountByType", {
            organizationPartyId: run.organizationPartyId,
            glAccountTypeEnumId
        })
        if (out.glAccountId) ids.add(out.glAccountId)
    }
    for (const accountId of Object.keys(openItemNet(run))) ids.add(accountId)
    ids.delete(run.migrationGlAccountId)
    return ids
}
// What the opening items' postings put on each account (debit positive): their posted transactions that are not
// reversals or reversed.
function openItemNet(run) {
    const invoiceIds = Array.from(
        find(INVOICE, {openingSetupRunId: run.setupRunId}).selectField("invoiceId").orderBy("invoiceId").list()
    ).map(row => row.invoiceId)
    const net = {}
    if (!invoiceIds.length) return net
    const transIds = Array.from(
        find(TRANS)
            .condition("invoiceId", "in", invoiceIds)
            .condition("organizationPartyId", run.organizationPartyId)
            .condition("isPosted", "Y")
            .condition("reverseOfAcctgTransId", "is-null", null)
            .condition("reversedByAcctgTransId", "is-null", null)
            .selectField("acctgTransId")
            .list()
    ).map(row => row.acctgTransId)
    if (!transIds.length) return net
    for (const entry of find(ENTRY).condition("acctgTransId", "in", transIds).orderBy("acctgTransId,acctgTransEntrySeqId").list()) {
        const amount = toDecimal(entry.amount ?? 0)
        net[entry.glAccountId] = (net[entry.glAccountId] || zero())[entry.debitCreditFlag === "D" ? "add" : "subtract"](amount)
    }
    return net
}
// The opening trial balance against the open items: the lines, their totals, each control account's tie-out, and the
// entries activation posts (a control account's balance goes to the migration account, which then nets to zero).
function tieOut(run) {
    const lines = Array.from(find(BALANCE, {setupRunId: run.setupRunId}).orderBy("glAccountId").list()).map(map)
    const controls = controlAccounts(run),
        items = openItemNet(run)
    let debitTotal = zero(),
        creditTotal = zero()
    const lineNet = {}
    for (const line of lines) {
        const debit = toDecimal(line.debitAmount ?? 0),
            credit = toDecimal(line.creditAmount ?? 0)
        debitTotal = debitTotal.add(debit)
        creditTotal = creditTotal.add(credit)
        lineNet[line.glAccountId] = debit.subtract(credit)
        line.controlAccount = controls.has(line.glAccountId)
    }
    const tieRows = [...controls]
        .sort()
        .map(glAccountId => {
            const balanceAmount = lineNet[glAccountId] || zero(),
                openItemsAmount = items[glAccountId] || zero()
            const difference = balanceAmount.subtract(openItemsAmount)
            return {glAccountId, balanceAmount, openItemsAmount, difference, ties: difference.isZero()}
        })
        .filter(row => !row.balanceAmount.isZero() || !row.openItemsAmount.isZero() || !row.ties)
    const posting = {}
    const add = (glAccountId, amount) => (posting[glAccountId] = (posting[glAccountId] || zero()).add(amount))
    for (const [glAccountId, net] of Object.entries(lineNet))
        add(controls.has(glAccountId) ? run.migrationGlAccountId : glAccountId, net)
    const entries = Object.entries(posting)
        .filter(([, net]) => !net.isZero())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([glAccountId, net]) => ({
            glAccountId,
            debitCreditFlag: net.compare(0) > 0 ? "D" : "C",
            amount: net.compare(0) > 0 ? net : net.negate()
        }))
    const migrationNet = (items[run.migrationGlAccountId] || zero()).add(posting[run.migrationGlAccountId] || zero())
    return {
        lines,
        debitTotal,
        creditTotal,
        balanced: debitTotal.eq(creditTotal),
        tieRows,
        ties: tieRows.every(row => row.ties),
        entries,
        migrationNet
    }
}
// The setup screen's data: the run and its basis, the template choices, the opening balance lines with their totals and
// tie-out, and a page of the open items with the counts and totals of each side.
function preview(p) {
    const scope = policy.scope(p, "admin")
    const out = {templateOptions: templates(), balanceRows: [], tieRows: [], openItemRows: [], openItemsCount: 0}
    if (!scope.organizationPartyId) return Object.assign(out, {organizationPartyId: null, setupRun: null})
    const org = scope.organizationPartyId
    const own = one("mantle.ledger.config.PartyAcctgPreference", {organizationPartyId: org})
    // configured with its own preference or one inherited through its rollup (PrtOrgRollup)
    const preference = policy.preference(org)
    const configured = !!preference.organizationPartyId
    out.organizationPartyId = org
    out.configured = configured
    out.inheritedFrom = configured && !own ? preference.organizationPartyId : null
    out.basis = Object.assign(
        policy.pick(map(preference), ["baseCurrencyUomId", "fiscalYearStartMonth", "fiscalYearStartDay", "cogsMethodEnumId"]),
        {configured}
    )
    out.currencyUomId = preference.baseCurrencyUomId || null
    const run = setupRun(org)
    if (!run) {
        const migration = configured
            ? call("mantle.ledger.LedgerServices.get#DefaultGlAccountByType", {
                  organizationPartyId: org,
                  glAccountTypeEnumId: "GatMigrationClearing"
              }).glAccountId
            : null
        return Object.assign(out, {setupRun: null, defaultMigrationGlAccountId: migration || null})
    }
    const tie = tieOut(run)
    const names = accountNames([run.migrationGlAccountId, ...tie.lines.map(row => row.glAccountId)])
    const status = one("moqui.basic.StatusItem", {statusId: run.statusId})
    out.lastImport = entityLib.json(run.lastImportJson, null)
    out.lastCheck = entityLib.json(run.lastCheckJson, null)
    const shown = display(run)
    delete shown.lastImportJson
    delete shown.lastCheckJson
    out.setupRun = Object.assign(shown, {
        statusDescription: status?.description || run.statusId,
        migrationAccountName: names[run.migrationGlAccountId] || run.migrationGlAccountId,
        sourceName: run.sourcePartyId ? entityLib.partyNames([run.sourcePartyId])[run.sourcePartyId] || run.sourcePartyId : "",
        openingDateText: policy.calendarDateText(run.openingDate),
        activated: run.statusId === "AsrActivated"
    })
    out.balanceRows = tie.lines.map(row =>
        Object.assign(row, {
            accountName: names[row.glAccountId] || row.glAccountId,
            postsToText: row.controlAccount ? "Open items; activation posts it to migration clearing" : ""
        })
    )
    out.debitTotal = tie.debitTotal
    out.creditTotal = tie.creditTotal
    out.balanced = tie.balanced
    const tieNames = accountNames(tie.tieRows.map(row => row.glAccountId))
    out.tieRows = tie.tieRows.map(row => Object.assign(row, {accountName: tieNames[row.glAccountId] || row.glAccountId}))
    out.ties = tie.ties
    out.migrationNet = tie.migrationNet
    // the open items: a page, and each side's count and total
    const query = () => find(INVOICE, {openingSetupRunId: run.setupRunId})
    const paged = entityLib.page(query().orderBy("dueDate,invoiceId"), p, "openItemRows", query().count())
    const parties = entityLib.partyNames(paged.rows.flatMap(row => [row.fromPartyId, row.toPartyId]))
    Object.assign(out, policy.pick(paged, Object.keys(paged).filter(key => key.startsWith("openItemRows"))))
    out.openItemRows = paged.rows.map(row => {
        const receivable = row.fromPartyId === org
        const partyId = receivable ? row.toPartyId : row.fromPartyId
        return Object.assign(display(row), {
            direction: receivable ? "receivable" : "payable",
            directionText: receivable ? "Customer invoice" : "Supplier bill",
            partyId,
            partyName: parties[partyId] || partyId,
            documentDateText: entityLib.bookDay(null, row.invoiceDate),
            dueDateText: entityLib.bookDay(null, row.dueDate)
        })
    })
    out.openItemsCount = paged.recordCount
    for (const [side, fromField] of [
        ["receivable", "fromPartyId"],
        ["payable", "toPartyId"]
    ]) {
        const sideRows = Array.from(
            query().condition(fromField, org).selectField("invoiceId").selectField("invoiceTotal").list()
        )
        out[side + "Count"] = sideRows.length
        out[side + "Total"] = sideRows.reduce((sum, row) => sum.add(row.invoiceTotal ?? 0), zero())
    }
    return out
}

// ---- readiness ----
const labels = {
    BASIS: "Preferences",
    CHART: "Chart of accounts",
    PERIODS: "Fiscal periods",
    POSTING_GUARD: "Posting guard",
    MIGRATION_ACCOUNT: "Migration clearing account",
    CONTROL_ACCOUNTS: "Receivable and payable accounts",
    MAPPINGS_NOT_POSTABLE: "Mappings to summary accounts",
    MAPPINGS_UNASSIGNED: "Mapped accounts not in the chart",
    WIP_TRANSFER: "Inventory WIP and transfer accounts",
    EXCHANGE_RATES: "Exchange rates",
    TAX_METHOD: "Sales tax",
    BANK_METHODS: "Bank accounts",
    REMINDER_JOB: "Past due email job",
    PRODUCTION_ACCOUNTS: "Production cost accounts",
    POSTED_HISTORY: "Entries already posted",
    OPENING_BALANCED: "Opening balances",
    OPEN_ITEM_TIE: "Open items against the opening balances"
}
// Every posting mapping row of the organization naming an account, as [kind label, key text, account ID].
// The mapping rows that apply to the organization: its own, else those of the nearest organization it rolls up to.
function chainRows(entity, org, orderBy) {
    for (const organizationPartyId of policy.organizationChain(org)) {
        const found = Array.from(find(entity, {organizationPartyId}).orderBy(orderBy).list())
        if (found.length) return found
    }
    return []
}
function mappedAccounts(org) {
    const out = []
    for (const [kind, descriptor] of Object.entries(setup.mappings)) {
        if (kind === "assignment") continue
        const entity = descriptor[0].includes(".") ? descriptor[0] : "mantle.ledger.config." + descriptor[0]
        const accountFields = descriptor[2].filter(field => field === "glAccountId" || field.endsWith("GlAccountId"))
        for (const row of chainRows(entity, org, descriptor[1].join(",")))
            for (const field of accountFields)
                if (row[field]) out.push([kind, descriptor[1].map(key => row[key]).filter(Boolean).join(" / "), row[field]])
    }
    return out
}
// A row's details text: at most five items, then how many more.
function detailText(items) {
    return items.slice(0, 5).join("; ") + (items.length > 5 ? "; and " + (items.length - 5) + " more" : "")
}
function readiness(p) {
    const scope = policy.scope(p, "admin")
    const org = scope.organizationPartyId
    if (!org) return {readinessRows: [], blockerCount: 1, warningCount: 0, ready: false, organizationPartyId: null}
    const run = setupRun(org)
    const preference = policy.preference(org)
    const openingDay = run?.openingDate ? policy.calendarDateText(run.openingDate) : ec.l10n.format(ec.user.nowTimestamp, "yyyy-MM-dd")
    const openingStamp = dayStamp(openingDay)
    const chain = policy.organizationChain(org)
    const checks = [
        [
            "BASIS",
            () => {
                if (!preference.organizationPartyId) return ["blocker", "Set up the organization from a chart template"]
                if (!preference.baseCurrencyUomId) return ["blocker", "Choose a base currency"]
                if (!preference.errorGlJournalId) return ["blocker", "Choose an error journal"]
                return ["ok", "Base currency " + preference.baseCurrencyUomId]
            }
        ],
        [
            "CHART",
            () => {
                const count = find("mantle.ledger.account.GlAccountOrganization").condition("organizationPartyId", "in", chain).count()
                return count ? ["ok", count + " accounts"] : ["blocker", "Assign a chart of accounts"]
            }
        ],
        [
            "PERIODS",
            () => {
                const periods = Array.from(
                    find("mantle.party.time.TimePeriod")
                        .condition("partyId", "in", chain)
                        .condition("timePeriodTypeId", "in", ["FiscalYear", "FiscalQuarter", "FiscalMonth"])
                        .condition("fromDate", "less-equals", openingDay)
                        .condition("thruDate", "greater-equals", openingDay)
                        .list()
                )
                if (!periods.length) return ["blocker", "Generate the fiscal periods of " + openingDay]
                const closed = periods.filter(row => row.isClosed === "Y").map(row => row.periodName || row.timePeriodId)
                if (closed.length) return ["blocker", "Reopen the periods of the opening day", closed]
                return ["ok", "The periods of " + openingDay + " are open"]
            }
        ],
        [
            "POSTING_GUARD",
            () =>
                preference.postingGuardEnabled === "Y"
                    ? ["ok", "On: opening items and balances post under the period and lock checks"]
                    : ["blocker", "Turn on the posting guard in the preferences"]
        ],
        [
            "MIGRATION_ACCOUNT",
            () => {
                if (!run) return ["blocker", "Save the setup basis"]
                const name = accountNames([run.migrationGlAccountId])[run.migrationGlAccountId] || run.migrationGlAccountId
                return entityLib.check(() => policy.account(org, run.migrationGlAccountId, openingStamp)).allowed
                    ? ["ok", name]
                    : ["blocker", name + " is not an active posting account of the organization on the opening day"]
            }
        ],
        [
            "CONTROL_ACCOUNTS",
            () => {
                const missing = []
                for (const [type, text] of [
                    ["GatAccountsReceivable", "receivable"],
                    ["GatAccountsPayable", "payable"]
                ]) {
                    const id = call("mantle.ledger.LedgerServices.get#DefaultGlAccountByType", {
                        organizationPartyId: org,
                        glAccountTypeEnumId: type
                    }).glAccountId
                    const usable = id && entityLib.check(() => policy.account(org, id, openingStamp)).allowed
                    if (!usable) missing.push("Map an active " + text + " account")
                }
                return missing.length ? ["blocker", missing.join("; ")] : ["ok", "Mapped"]
            }
        ],
        [
            "MAPPINGS_NOT_POSTABLE",
            () => {
                const mapped = mappedAccounts(org)
                const ids = [...new Set(mapped.map(row => row[2]))]
                const summary = new Set(
                    ids.length
                        ? Array.from(
                              find("mantle.ledger.account.GlAccount")
                                  .condition("glAccountId", "in", ids)
                                  .condition("disallowPosting", "Y")
                                  .list()
                          ).map(row => row.glAccountId)
                        : []
                )
                const items = mapped.filter(row => summary.has(row[2])).map(row => row[0] + " " + row[1] + ": " + row[2])
                return items.length
                    ? ["warning", items.length + " mappings name a summary account; their postings go to the error journal", items]
                    : ["ok", "Every mapping names a posting account"]
            }
        ],
        [
            "MAPPINGS_UNASSIGNED",
            () => {
                const mapped = mappedAccounts(org)
                const unassigned = new Set()
                for (const id of new Set(mapped.map(row => row[2]))) {
                    const assignment = policy.accountAssignment(org, id, openingStamp)
                    if (!assignment || !policy.active(assignment, openingStamp)) unassigned.add(id)
                }
                const items = mapped.filter(row => unassigned.has(row[2])).map(row => row[0] + " " + row[1] + ": " + row[2])
                return items.length
                    ? [
                          "warning",
                          unassigned.size + " mapped accounts are not in the organization's chart; postings to them are refused",
                          items
                      ]
                    : ["ok", "Every mapped account is in the chart"]
            }
        ],
        [
            "WIP_TRANSFER",
            () => {
                const inventory = chainRows("mantle.ledger.config.AssetTypeGlAccount", org, "assetTypeGlAccountId").filter(
                    row => row.assetTypeEnumId === "AstTpInventory"
                )
                if (!inventory.length) return ["blocker", "Map the inventory accounts"]
                const missing = inventory
                    .filter(row => !row.wipAssetGlAccountId || !row.transferGlAccountId)
                    .map(row => "Inventory " + (row.classEnumId || "default"))
                if (missing.length) return ["blocker", "Map the WIP and transfer accounts of inventory", missing]
                if (!preference.cogsMethodEnumId) return ["blocker", "Choose the costing basis"]
                return ["ok", "Mapped; costing basis " + preference.cogsMethodEnumId]
            }
        ],
        [
            "EXCHANGE_RATES",
            () => {
                const base = preference.baseCurrencyUomId
                if (!base) return ["blocker", "Choose a base currency"]
                // documents in another currency post at the rate of their day; each currency open on the opening day
                // needs a rate to the base currency then, and a settled difference needs the exchange accounts
                const open = ["InvoiceInProcess", "InvoiceIncoming", "InvoiceReceived", "InvoiceFinalized", "InvoiceSent", "InvoiceApproved"]
                const cf = ec.entity.conditionFactory
                const sides = cf.makeCondition([cf.makeCondition("fromPartyId", "equals", org), cf.makeCondition("toPartyId", "equals", org)], "or")
                const used = new Set()
                for (const row of find(INVOICE)
                    .condition(sides)
                    .condition("statusId", "in", open)
                    .condition("currencyUomId", "not-equals", base)
                    .selectField("currencyUomId")
                    .distinct(true)
                    .list())
                    used.add(row.currencyUomId)
                for (const row of find("mantle.account.payment.Payment")
                    .condition(sides)
                    .condition("statusId", "in", ["PmntProposed", "PmntPromised", "PmntAuthorized"])
                    .condition("amountUomId", "not-equals", base)
                    .selectField("amountUomId")
                    .distinct(true)
                    .list())
                    used.add(row.amountUomId)
                const currencies = ec.resource.script("component://mr-mantle/service/mantle/ledger/Currencies.js")
                const missing = [...used].sort().filter(uomId => !currencies.rateOn(uomId, base, openingDay))
                if (missing.length)
                    return ["blocker", "Add the exchange rates to " + base + " of " + openingDay + " for the open documents", missing]
                const unmapped = ["GatForExGain", "GatForExLoss"].filter(
                    type => !call("mantle.ledger.LedgerServices.get#DefaultGlAccountByType", {glAccountTypeEnumId: type, organizationPartyId: org}).glAccountId
                )
                if (unmapped.length) return ["warning", "Map the exchange gain and loss accounts; a settled exchange difference needs them", unmapped]
                // postings made before base-currency posting in another currency stay as they are; reports name them
                // incomplete (impl-accounting F428)
                const unconverted = find("mantle.ledger.transaction.AcctgTrans", {organizationPartyId: org, isPosted: "Y"})
                    .condition("amountUomId", "not-equals", base)
                    .count()
                if (unconverted)
                    return [
                        "warning",
                        unconverted + " postings in another currency were made before base-currency posting; reports name them incomplete"
                    ]
                return used.size
                    ? ["ok", "Documents in " + [...used].sort().join(", ") + " post at their rates in " + base]
                    : ["ok", "Postings convert to " + base + " at the rate of their day"]
            }
        ],
        [
            "TAX_METHOD",
            () => {
                if (preference.taxGatewayConfigId) return ["ok", "Organization gateway " + preference.taxGatewayConfigId]
                const storeGateway = find("mantle.product.store.ProductStore", {organizationPartyId: org})
                    .condition("taxGatewayConfigId", "is-not-null", null)
                    .count()
                return storeGateway
                    ? ["ok", "Calculated by the stores' gateways"]
                    : ["warning", "Choose a sales tax gateway; invoices without a store's gateway are not taxed"]
            }
        ],
        [
            "BANK_METHODS",
            () => {
                const banks = rows("mantle.account.method.PaymentMethod", {
                    ownerPartyId: org,
                    paymentMethodTypeEnumId: "PmtBankAccount"
                }).filter(row => policy.active(row))
                return banks.length
                    ? ["ok", banks.length + " bank accounts"]
                    : ["warning", "Add the organization's bank account for payments and payment runs"]
            }
        ],
        [
            "REMINDER_JOB",
            () => {
                const job = one("moqui.service.job.ServiceJob", {jobName: "send_SalesInvoicePastDueEmails"})
                return !job || job.paused === "Y"
                    ? ["ok", "Paused: dunning sends the payment reminders"]
                    : ["warning", "Pause the send_SalesInvoicePastDueEmails job; dunning sends the payment reminders"]
            }
        ],
        [
            "PRODUCTION_ACCOUNTS",
            () => {
                // the account types the production cost close (Manufacturing, not built yet) posts to
                const missing = ["GatLaborApplied", "GatOverheadApplied", "GatOutsideProcessAccrued", "GatProductionVariance"]
                    .filter(
                        glAccountTypeEnumId =>
                            !call("mantle.ledger.LedgerServices.get#DefaultGlAccountByType", {
                                organizationPartyId: org,
                                glAccountTypeEnumId
                            }).glAccountId
                    )
                    .map(id => one("moqui.basic.Enumeration", {enumId: id})?.description || id)
                return missing.length
                    ? ["warning", "Map the production cost accounts before closing production runs", missing]
                    : ["ok", "Mapped"]
            }
        ],
        [
            "POSTED_HISTORY",
            () => {
                // entries posted other than the open items' and the opening entry: the opening balances add to them
                const opening = run
                    ? Array.from(find(INVOICE, {openingSetupRunId: run.setupRunId}).selectField("invoiceId").list()).map(
                          row => row.invoiceId
                      )
                    : []
                let query = find(TRANS, {organizationPartyId: org, isPosted: "Y"}).condition(
                    "acctgTransTypeEnumId",
                    "not-equals",
                    "AttOpeningBalance"
                )
                if (opening.length)
                    query = query.condition(
                        ec.entity.conditionFactory.makeCondition([
                            ec.entity.conditionFactory.makeCondition("invoiceId", "is-null", null),
                            ec.entity.conditionFactory.makeCondition("invoiceId", "not-in", opening)
                        ], "or")
                    )
                const count = query.count()
                return count
                    ? ["warning", count + " entries are posted already; the opening balances add to them"]
                    : ["ok", "No entries posted before the opening balances"]
            }
        ],
        [
            "OPENING_BALANCED",
            () => {
                if (!run) return ["blocker", "Save the setup basis"]
                const tie = tieOut(run)
                return tie.balanced
                    ? ["ok", "Debits and credits are " + ec.l10n.format(tie.debitTotal, "#,##0.00")]
                    : [
                          "blocker",
                          "Debits " +
                              ec.l10n.format(tie.debitTotal, "#,##0.00") +
                              " and credits " +
                              ec.l10n.format(tie.creditTotal, "#,##0.00") +
                              " differ"
                      ]
            }
        ],
        [
            "OPEN_ITEM_TIE",
            () => {
                if (!run) return ["blocker", "Save the setup basis"]
                const tie = tieOut(run)
                const names = accountNames(tie.tieRows.map(row => row.glAccountId))
                const items = tie.tieRows
                    .filter(row => !row.ties)
                    .map(
                        row =>
                            (names[row.glAccountId] || row.glAccountId) +
                            ": balance " +
                            ec.l10n.format(row.balanceAmount, "#,##0.00") +
                            ", open items " +
                            ec.l10n.format(row.openItemsAmount, "#,##0.00")
                    )
                if (items.length) return ["blocker", "The open items do not tie to the control account balances", items]
                return ["ok", "The open items tie; migration clearing nets to zero once activated"]
            }
        ]
    ]
    const readinessRows = []
    for (const [code, check] of checks) {
        let status, message, items
        try {
            ;[status, message, items] = check()
        } catch (error) {
            ec.logger.error("Accounting setup readiness " + code + " for " + org + ": " + error.message)
            status = "blocker"
            message = "Not available: " + error.message
        }
        readinessRows.push({
            code,
            label: labels[code],
            status,
            statusText: {ok: "Ready", warning: "Check", blocker: "Blocks activation"}[status],
            message,
            detailText: items?.length ? detailText(items) : "",
            itemCount: items?.length || 0
        })
    }
    const blockerCount = readinessRows.filter(row => row.status === "blocker").length
    const warningCount = readinessRows.filter(row => row.status === "warning").length
    return {
        organizationPartyId: org,
        readinessRows,
        blockerCount,
        warningCount,
        ready: blockerCount === 0,
        runVersion: run?.runVersion ?? null,
        activated: run?.statusId === "AsrActivated"
    }
}

// ---- open items ----
const itemFields = ["direction", "partyId", "documentNumber", "documentDate", "dueDate", "currencyUomId", "openAmount", "description"]
// Import open invoices and bills, each row through create#OpenItem in its own transaction: a refused row is named with
// its reason and the others go on; a row imported before answers the invoice it made.
function importItems(p) {
    const scope = policy.organization(p, "admin")
    let items
    if (p.rows != null) items = Array.from(p.rows).map(row => Object.assign({}, row))
    else {
        let text = p.csvText
        if (p.openItemFile != null && p.openItemFile.size > 0) text = p.openItemFile.getString("UTF-8")
        if (!text || String(text).length > 2097152) denied("CSV_REQUIRED", "Choose a CSV file of at most 2 MiB")
        const parsed = ec.resource.script("component://mr-mantle/service/mantle/ledger/Currencies.js").csv(String(text))
        const header = (parsed.shift() || []).map(text => text.trim())
        const required = ["direction", "partyId", "documentNumber", "documentDate", "dueDate", "openAmount"]
        if (required.some(field => !header.includes(field)) || header.some(field => !itemFields.includes(field)))
            denied("CSV_HEADER_INVALID", "The open items need the headers " + required.join(", ") + ", and may have currencyUomId and description")
        items = parsed.map(row => Object.fromEntries(header.map((field, index) => [field, row[index] ?? null])))
    }
    if (items.length > 5000) denied("CSV_TOO_LONG", "At most 5,000 open items in one import")
    const rowResults = []
    items.forEach((item, index) => {
        const rowNumber = p.rows != null ? index + 1 : index + 2
        const result = {rowNumber, documentNumber: item.documentNumber || "", partyId: item.partyId || ""}
        ec.message.pushErrors()
        try {
            const out = ec.service
                .sync()
                .name("mantle.ledger.SetupServices.create#OpenItem")
                .parameters(
                    Object.assign(policy.pick(item, itemFields), {
                        organizationPartyId: scope.organizationPartyId,
                        verifyOnly: p.verifyOnly === true
                    })
                )
                .disableAuthz()
                .requireNewTransaction(true)
                .call()
            if (ec.message.hasError()) throw new Error(ec.message.getErrorsString())
            Object.assign(result, {result: out.result, invoiceId: out.invoiceId || null, reasonCode: "OK", message: ""})
        } catch (error) {
            ec.logger.error("Accounting setup open item row " + rowNumber + " (" + result.documentNumber + "): " + error.message)
            const text = String(error.message).replace(/^Error: /, "")
            Object.assign(result, {
                result: "failed",
                invoiceId: null,
                reasonCode: entityLib.reasonCode({message: text}) || "ROW_FAILED",
                message: text.replace(/^[A-Z][A-Z0-9_]+: /, "")
            })
        } finally {
            ec.message.clearErrors()
            ec.message.popErrors()
        }
        rowResults.push(result)
    })
    const count = kind => rowResults.filter(row => row.result === kind).length
    const result = {
        rowResults,
        createdCount: count("created"),
        existingCount: count("existing"),
        validCount: count("valid"),
        failedCount: count("failed"),
        complete: count("failed") === 0
    }
    // the counts and the refused rows (the first 500, with how many there were) kept on the run for review: an import's
    // and a check's apart, so a check never hides what the last import refused
    const run = find(RUN, {organizationPartyId: scope.organizationPartyId}).one()
    if (run) {
        const failedRows = rowResults.filter(row => row.result === "failed")
        call("update#" + RUN, {
            setupRunId: run.setupRunId,
            [p.verifyOnly === true ? "lastCheckJson" : "lastImportJson"]: JSON.stringify(
                Object.assign(policy.pick(result, ["createdCount", "existingCount", "validCount", "failedCount"]), {
                    verifyOnly: p.verifyOnly === true,
                    importedDate: ec.l10n.format(ec.user.nowTimestamp, "yyyy-MM-dd HH:mm"),
                    failedRows: failedRows.slice(0, 500),
                    failedRowsShown: Math.min(500, failedRows.length)
                })
            )
        })
    }
    return result
}
// The opening entry activation posts, after the run's tie-out: refused when the lines do not balance or the open items do
// not tie, so the migration account nets to zero.
function activationEntries(p) {
    const run = one(RUN, {setupRunId: p.setupRunId})
    const tie = tieOut(run)
    if (!tie.balanced) denied("OPENING_UNBALANCED", "The opening balances' debits and credits differ")
    if (!tie.ties || !tie.migrationNet.isZero())
        denied("OPEN_ITEMS_UNTIED", "The open items do not tie to the control account balances")
    return {entries: tie.entries}
}
// The last import of opening open items of each organization the caller administers in Accounting (the framework's
// DataTransferServices.find#TargetRuns): the setup run keeps one result, the latest, so each organization answers at most
// one run. Finance administration only, as import#OpenItems.
function openItemImportRuns(p) {
    let ids
    try {
        const a = policy.access("read")
        if (!a.capabilities.admin) return {runList: []}
        ids = a.allowedOrganizationPartyIds
    } catch (error) {
        return {runList: []}
    }
    if (p.scopeKey) ids = ids.filter(id => id === p.scopeKey)
    const runList = []
    for (const organizationPartyId of ids)
        for (const run of rows("mantle.ledger.config.AccountingSetupRun", {organizationPartyId})) {
            const last = policy.lib.json(run.lastImportJson, null)
            if (!last) continue
            const started = Date.parse(String(last.importedDate || ""))
            const failed = Number(last.failedCount) || 0
            runList.push({
                runId: run.setupRunId,
                fileLabel: "Opening open items",
                scopeKey: organizationPartyId,
                scopeTitle: one("mantle.party.Organization", {partyId: organizationPartyId})?.organizationName || organizationPartyId,
                state: failed ? "partial" : "complete",
                stateText: failed ? "Imported with refused rows" : "Imported",
                startedDate: Number.isFinite(started) ? started : policy.ms(run.lastUpdatedStamp),
                rowCount: (Number(last.createdCount) || 0) + (Number(last.existingCount) || 0) + failed,
                appliedCount: Number(last.createdCount) || 0,
                errorCount: failed,
                skippedCount: Number(last.existingCount) || 0,
                ownerParameters: {organizationPartyId}
            })
        }
    return {runList: runList.sort((a, b) => (b.startedDate || 0) - (a.startedDate || 0)).slice(0, Math.min(Number(p.maxRows) || 100, 200))}
}
const operations = {preview, readiness, importItems, balanceLine, balanceRows, activationEntries, openItemImportRuns}
;({
    templates,
    dayStamp,
    baseCurrency,
    execute: (op, p) => {
        if (!operations[op]) throw new Error("Unknown accounting activation operation " + op)
        return operations[op](p)
    }
})
