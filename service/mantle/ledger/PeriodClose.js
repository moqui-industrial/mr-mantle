// Period close (CloseServices): the checklist of what keeps a fiscal period from closing, the close that commits Mantle's
// close#FinancialTimePeriod, the closing entries and the period's GL summary rows at once, and the audited reopen. Each
// checklist row is a PeriodCloseCheck enumeration naming its service, so another source adds a row with its own service;
// the standard rows are the functions of checks below.
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/AccountingPolicy.js")
const {find, one, rows, map, call, ms, display, denied} = lib
const T = "mantle.ledger.transaction.AcctgTrans"
const ITEM_LIMIT = 20
// The page of documents a check reads at a time
const PAGE = 500

// The organization and period of a request, with the period's days: fromDay and thruDay inclusive, afterDay the day after,
// and their midnights in the user's zone for legacy postings dated by timestamp.
function periodScope(p, need = "read", lock = false) {
    const s = lib.organization(p, need)
    if (!p.timePeriodId) denied("PERIOD_REQUIRED", "Choose a fiscal period")
    const found = lib.record({kind: "periods", recordId: p.timePeriodId, organizationPartyId: s.organizationPartyId})
    if (found.partyId !== s.organizationPartyId) denied("PERIOD_UNAVAILABLE", "Choose a fiscal period of this organization")
    const period = lock ? find("mantle.party.time.TimePeriod", {timePeriodId: found.timePeriodId}).forUpdate(true).one() : found
    const fromDay = lib.calendarDateText(period.fromDate),
        thruDay = lib.calendarDateText(period.thruDate)
    const afterDay = lib.calendarDateText(Date.parse(thruDay) + 86400000)
    const stamp = day => ec.l10n.parseTimestamp(day, "yyyy-MM-dd")
    const organizations = call("mantle.ledger.LedgerServices.expand#ChildOrganizationList", {
        organizationPartyId: s.organizationPartyId
    }).orgPartyIdList
    return {s, period, fromDay, thruDay, afterDay, fromStamp: stamp(fromDay), afterStamp: stamp(afterDay), organizations}
}
// The same scope over another period of the organization (the closed month and quarter that end with a closed year).
function scopeOf(c, period) {
    const fromDay = lib.calendarDateText(period.fromDate),
        thruDay = lib.calendarDateText(period.thruDate)
    const afterDay = lib.calendarDateText(Date.parse(thruDay) + 86400000)
    const stamp = day => ec.l10n.parseTimestamp(day, "yyyy-MM-dd")
    return Object.assign({}, c, {period, fromDay, thruDay, afterDay, fromStamp: stamp(fromDay), afterStamp: stamp(afterDay)})
}
// The condition of a book day in the period: the accounting day when there is one, else the timestamp field.
function inPeriod(c, stampField = "transactionDate", dayField = "accountingDate") {
    const cf = ec.entity.conditionFactory
    const legacy = [
        cf.makeCondition(stampField, "greater-equals", c.fromStamp),
        cf.makeCondition(stampField, "less", c.afterStamp)
    ]
    if (!dayField) return cf.makeCondition(legacy, "and")
    const dated = [cf.makeCondition(dayField, "is-not-null", null)]
    dated.push(cf.makeCondition(dayField, "greater-equals", c.fromDay), cf.makeCondition(dayField, "less", c.afterDay))
    legacy.unshift(cf.makeCondition(dayField, "is-null", null))
    return cf.makeCondition([cf.makeCondition(dated, "and"), cf.makeCondition(legacy, "and")], "or")
}
const stampInPeriod = (c, field) => inPeriod(c, field, null)
function either(fields, values) {
    const cf = ec.entity.conditionFactory
    return cf.makeCondition(
        fields.map(field => cf.makeCondition(field, "in", values)),
        "or"
    )
}
function amountText(value, currencyUomId) {
    return value == null ? "" : ec.l10n.formatCurrency(toDecimal(value), currencyUomId)
}
function result(found, toItem) {
    return {count: found.length, items: found.slice(0, ITEM_LIMIT).map(toItem)}
}
function errorJournals(c) {
    return c.organizations.map(org => lib.preference(org).errorGlJournalId).filter(Boolean)
}
function unposted(c) {
    const cf = ec.entity.conditionFactory
    return find(T)
        .condition("organizationPartyId", "in", c.organizations)
        .condition(
            cf.makeCondition([cf.makeCondition("isPosted", "is-null", null), cf.makeCondition("isPosted", "equals", "N")], "or")
        )
        .condition(inPeriod(c))
        .orderBy("transactionDate,acctgTransId")
}
const transactionItem = tx => ({
    recordKind: "journals",
    recordId: tx.acctgTransId,
    text: [tx.acctgTransId, tx.description || tx.acctgTransTypeEnumId].filter(Boolean).join(" · "),
    detail: tx.postingFailureCode ? tx.postingFailureCode + ": " + (tx.postingFailureMessage || "") : null
})

// The standard checks, by PeriodCloseCheck id: each finds the period's items of its kind for the organization and the
// organizations that roll up to it, and names each item with the record that resolves it.
const checks = {
    PccUnpostedTransactions(c) {
        const journals = errorJournals(c)
        return result(
            Array.from(unposted(c).list()).filter(tx => !journals.includes(tx.glJournalId)),
            transactionItem
        )
    },
    PccErrorJournal(c) {
        const journals = errorJournals(c)
        if (!journals.length) return {count: 0, items: []}
        return result(Array.from(unposted(c).condition("glJournalId", "in", journals).list()), transactionItem)
    },
    // The period's posted debits and credits; only when they differ, the transactions that do not balance.
    PccImbalance(c) {
        const summary = find("mantle.ledger.transaction.AcctgTransAndEntrySummary")
            .condition("organizationPartyId", "in", c.organizations)
            .condition("isPosted", "Y")
            .condition(inPeriod(c))
            .selectField("debitCreditFlag")
            .selectField("amount")
        const totals = {D: toDecimal(0), C: toDecimal(0)}
        for (const row of summary.list()) totals[row.debitCreditFlag] = totals[row.debitCreditFlag].add(row.amount ?? 0)
        if (totals.D.eq(totals.C)) return {count: 0, items: []}
        const byTransaction = {}
        for (const row of find("mantle.ledger.transaction.AcctgTransAndEntrySummary")
            .condition("organizationPartyId", "in", c.organizations)
            .condition("isPosted", "Y")
            .condition(inPeriod(c))
            .selectField("acctgTransId")
            .selectField("debitCreditFlag")
            .selectField("amount")
            .list()) {
            const sign = row.debitCreditFlag === "D" ? 1 : -1
            byTransaction[row.acctgTransId] = (byTransaction[row.acctgTransId] || toDecimal(0)).add(
                toDecimal(row.amount ?? 0).multiply(sign)
            )
        }
        const ids = Object.keys(byTransaction).filter(id => !byTransaction[id].isZero())
        return result(ids.sort(), id => ({
            recordKind: "journals",
            recordId: id,
            text: id,
            detail: "Debits minus credits " + String(byTransaction[id])
        }))
    },
    // Invoices and bills of the period that have no posting (drafts, and finalized ones whose posting failed), and
    // delivered payments without one. The documents are read in pages and checked against their postings a page at a
    // time, so no query carries more than a page of ids.
    PccUnpostedDocuments(c) {
        const found = []
        let count = 0
        const unpostedOf = (query, field, toItem) => {
            for (let page = 0; ; page++) {
                const docs = Array.from(
                    query()
                        .offset(page * PAGE)
                        .limit(PAGE)
                        .list()
                )
                if (!docs.length) break
                const ids = docs.map(row => row[field])
                const posted = new Set(
                    Array.from(
                        find(T)
                            .condition(field, "in", ids)
                            .condition("isPosted", "Y")
                            .condition("paymentApplicationId", "is-null", null)
                            .selectField(field)
                            .distinct(true)
                            .list()
                    ).map(row => row[field])
                )
                for (const doc of docs) {
                    if (posted.has(doc[field])) continue
                    if (field === "invoiceId" && doc.invoiceTotal != null && toDecimal(doc.invoiceTotal).isZero()) continue
                    count++
                    if (found.length < ITEM_LIMIT) found.push(toItem(doc))
                }
                if (docs.length < PAGE) break
            }
        }
        unpostedOf(
            () =>
                find("mantle.account.invoice.Invoice")
                    .condition(either(["fromPartyId", "toPartyId"], c.organizations))
                    .condition("statusId", "not-in", ["InvoiceCancelled"])
                    .condition(inPeriod(c, "invoiceDate"))
                    .orderBy("invoiceId"),
            "invoiceId",
            invoice => {
                const receivable = c.organizations.includes(invoice.fromPartyId)
                return {
                    recordKind: receivable ? "invoices" : "bills",
                    recordId: invoice.invoiceId,
                    text:
                        (receivable ? "Invoice " : "Bill ") +
                        invoice.invoiceId +
                        (invoice.description ? " · " + invoice.description : ""),
                    detail: [
                        ec.entity.find("moqui.basic.StatusItem").condition("statusId", invoice.statusId).useCache(true).one()
                            ?.description,
                        amountText(invoice.invoiceTotal, invoice.currencyUomId)
                    ]
                        .filter(Boolean)
                        .join(" · ")
                }
            }
        )
        unpostedOf(
            () =>
                find("mantle.account.payment.Payment")
                    .condition(either(["fromPartyId", "toPartyId"], c.organizations))
                    .condition("statusId", "in", ["PmntDelivered", "PmntConfirmed"])
                    .condition(stampInPeriod(c, "effectiveDate"))
                    .orderBy("paymentId"),
            "paymentId",
            payment => ({
                recordKind: "payments",
                recordId: payment.paymentId,
                text: "Payment " + payment.paymentId + (payment.paymentRefNum ? " · " + payment.paymentRefNum : ""),
                detail: amountText(payment.amount, payment.amountUomId)
            })
        )
        return {count, items: found}
    },
    // Each bank account's lines of the period that no finished statement cleared.
    PccBankStatements(c) {
        const banks = Array.from(
            find("mantle.account.method.PaymentMethod")
                .condition("ownerPartyId", "in", c.organizations)
                .condition("paymentMethodTypeEnumId", "PmtBankAccount")
                .orderBy("paymentMethodId")
                .list()
        )
        const found = []
        for (const bank of banks) {
            // the period's lines a page at a time, each page against its clearing and the finished statements
            let open = 0
            for (let page = 0; ; page++) {
                const lines = Array.from(
                    find("mantle.account.method.PaymentMethodTrans", {paymentMethodId: bank.paymentMethodId})
                        .condition(stampInPeriod(c, "postedDate"))
                        .selectField("fitId")
                        .orderBy("fitId")
                        .offset(page * PAGE)
                        .limit(PAGE)
                        .list()
                ).map(row => row.fitId)
                if (!lines.length) break
                const cleared = Array.from(
                    find("mantle.account.method.BankReconciliationLine", {paymentMethodId: bank.paymentMethodId})
                        .condition("fitId", "in", lines)
                        .list()
                )
                const sessions = [...new Set(cleared.map(row => row.bankReconciliationId))]
                const finished = new Set(
                    sessions.length
                        ? Array.from(
                              find("mantle.account.method.BankReconciliation")
                                  .condition("bankReconciliationId", "in", sessions)
                                  .condition("statusId", "BrecFinished")
                                  .selectField("bankReconciliationId")
                                  .list()
                          ).map(row => row.bankReconciliationId)
                        : []
                )
                const done = new Set(cleared.filter(row => finished.has(row.bankReconciliationId)).map(row => row.fitId))
                open += lines.filter(fitId => !done.has(fitId)).length
                if (lines.length < PAGE) break
            }
            if (!open) continue
            found.push({
                recordKind: "banks",
                recordId: bank.paymentMethodId,
                text: (bank.description || bank.paymentMethodId) + ": " + open + " lines not on a finished statement",
                detail: null
            })
        }
        return result(found, item => item)
    },
    // Documents of the period in a currency other than the organization's base currency with no rate: none kept from their
    // posting and none in effect on their book day (Currencies.rateOn, the rate posting converts at).
    PccMissingRates(c) {
        const baseCurrency = lib.preference(c.s.organizationPartyId).baseCurrencyUomId
        if (!baseCurrency) return {count: 0, items: []}
        const found = []
        const currencies = ec.resource.script("component://mr-mantle/service/mantle/ledger/Currencies.js")
        const hasRate = (currency, date, record) =>
            (!!record.exchangeRate && record.exchangeRateToUomId === baseCurrency) ||
            !!currencies.rateOn(currency, baseCurrency, lib.lib.bookDay(record.accountingDate, date))
        for (const invoice of find("mantle.account.invoice.Invoice")
            .condition(either(["fromPartyId", "toPartyId"], c.organizations))
            .condition("currencyUomId", "not-equals", baseCurrency)
            .condition("statusId", "not-in", ["InvoiceCancelled"])
            .condition(inPeriod(c, "invoiceDate"))
            .list())
            if (!hasRate(invoice.currencyUomId, invoice.invoiceDate, invoice))
                found.push({
                    recordKind: c.organizations.includes(invoice.fromPartyId) ? "invoices" : "bills",
                    recordId: invoice.invoiceId,
                    text: invoice.invoiceId + ": no " + invoice.currencyUomId + " rate",
                    detail: null
                })
        for (const payment of find("mantle.account.payment.Payment")
            .condition(either(["fromPartyId", "toPartyId"], c.organizations))
            .condition("amountUomId", "not-equals", baseCurrency)
            .condition("statusId", "not-in", ["PmntCancelled", "PmntVoid"])
            .condition(stampInPeriod(c, "effectiveDate"))
            .list())
            if (!hasRate(payment.amountUomId, payment.effectiveDate, payment))
                found.push({
                    recordKind: "payments",
                    recordId: payment.paymentId,
                    text: payment.paymentId + ": no " + payment.amountUomId + " rate",
                    detail: null
                })
        return result(found, item => item)
    },
    // Bills of the period with an open hold: the organization's bills of the period, a page at a time, then their holds.
    PccPayableHolds(c) {
        const found = []
        let count = 0
        for (let page = 0; ; page++) {
            const bills = Array.from(
                find("mantle.account.invoice.Invoice")
                    .condition("toPartyId", "in", c.organizations)
                    .condition("statusId", "not-in", ["InvoiceCancelled"])
                    .condition(inPeriod(c, "invoiceDate"))
                    .orderBy("invoiceId")
                    .offset(page * PAGE)
                    .limit(PAGE)
                    .list()
            )
            if (!bills.length) break
            const holds = Array.from(
                find("mantle.account.invoice.InvoiceHold")
                    .condition(
                        "invoiceId",
                        "in",
                        bills.map(bill => bill.invoiceId)
                    )
                    .condition("releasedDate", "is-null", null)
                    .list()
            )
            for (const bill of bills) {
                const own = holds.filter(hold => hold.invoiceId === bill.invoiceId)
                if (!own.length) continue
                count++
                if (found.length < ITEM_LIMIT)
                    found.push({
                        recordKind: "bills",
                        recordId: bill.invoiceId,
                        text: "Bill " + bill.invoiceId + (bill.referenceNumber ? " · " + bill.referenceNumber : ""),
                        detail: own
                            .map(
                                hold =>
                                    ec.entity
                                        .find("moqui.basic.Enumeration")
                                        .condition("enumId", hold.holdReasonEnumId)
                                        .useCache(true)
                                        .one()?.description || hold.holdReasonEnumId
                            )
                            .join(", ")
                    })
            }
            if (bills.length < PAGE) break
        }
        return {count, items: found}
    },
    // Receipts and issues of the period's stock that posted nothing (no cost, no accounting preference, a failed
    // posting) for the organizations' assets (impl-accounting F10).
    PccStockPostings(c) {
        const failed = ["AtrNoAcquireCost", "AtrNoAcctgPreference", "AtrPostingFailed"]
        const found = []
        let count = 0
        const cf = ec.entity.conditionFactory
        // an inventory receipt without a cost is PccReceiptCostBasis's; another kind's (supplies, fixed assets) is here
        const receiptResults = cf.makeCondition(
            [
                cf.makeCondition("acctgTransResultEnumId", "in", failed.slice(1)),
                cf.makeCondition(
                    [
                        cf.makeCondition("acctgTransResultEnumId", "equals", "AtrNoAcquireCost"),
                        cf.makeCondition("assetTypeEnumId", "not-equals", "AstTpInventory")
                    ],
                    "and"
                )
            ],
            "or"
        )
        for (const [entity, idField, dateField, label, results] of [
            ["mantle.product.receipt.AssetReceiptValuation", "assetReceiptId", "receivedDate", "Receipt", receiptResults],
            [
                "mantle.product.issuance.AssetIssuanceAndOwner",
                "assetIssuanceId",
                "issuedDate",
                "Issue",
                cf.makeCondition("acctgTransResultEnumId", "in", failed)
            ]
        ]) {
            const query = () =>
                find(entity)
                    .condition("ownerPartyId", "in", c.organizations)
                    .condition(results)
                    .condition(stampInPeriod(c, dateField))
            count += query().count()
            for (const movement of query().orderBy(idField).limit(ITEM_LIMIT).list())
                if (found.length < ITEM_LIMIT)
                    found.push({
                        recordKind: "assets",
                        recordId: movement.assetId,
                        text: label + " " + movement[idField] + " of " + (movement.productId || movement.assetId),
                        detail:
                            ec.entity
                                .find("moqui.basic.Enumeration")
                                .condition("enumId", movement.acctgTransResultEnumId)
                                .useCache(true)
                                .one()?.description || movement.acctgTransResultEnumId
                    })
        }
        return {count, items: found}
    },
    // Kit and repack work completed in the period whose issued stock value differs from the value it received, which
    // leaves WIP open.
    PccOpenWip(c) {
        const facilityIds = Array.from(
            find("mantle.facility.Facility").condition("ownerPartyId", "in", c.organizations).selectField("facilityId").list()
        ).map(row => row.facilityId)
        const cf = ec.entity.conditionFactory
        const owned = cf.makeCondition(
            [cf.makeCondition("ownerPartyId", "in", c.organizations)].concat(
                facilityIds.length ? [cf.makeCondition("facilityId", "in", facilityIds)] : []
            ),
            "or"
        )
        const efforts = Array.from(
            find("mantle.work.effort.WorkEffort")
                .condition(owned)
                .condition("purposeEnumId", "in", ["WepPickAssembly", "WepAssembling"])
                .condition("statusId", "in", ["WeComplete", "WeClosed"])
                .condition(stampInPeriod(c, "actualCompletionDate"))
                .orderBy("workEffortId")
                .list()
        )
        const found = []
        for (const effort of efforts) {
            const facility = effort.facilityId ? one("mantle.facility.Facility", {facilityId: effort.facilityId}) : null
            if (!c.organizations.includes(facility?.ownerPartyId || effort.ownerPartyId)) continue
            const value = (entity, quantityField) =>
                rows(entity, {workEffortId: effort.workEffortId}).reduce((sum, row) => {
                    const asset = row.assetId ? one("mantle.product.asset.Asset", {assetId: row.assetId}) : null
                    return sum.add(toDecimal(row[quantityField] ?? 0).multiply(toDecimal(asset?.acquireCost ?? 0)))
                }, toDecimal(0))
            const open = value("mantle.product.issuance.AssetIssuance", "quantity").subtract(
                value("mantle.product.receipt.AssetReceipt", "quantityAccepted")
            )
            if (open.isZero()) continue
            found.push({
                recordKind: "workEfforts",
                recordId: effort.workEffortId,
                text: effort.workEffortName || effort.workEffortId,
                detail: "Open WIP " + String(open)
            })
        }
        return result(found, item => item)
    },
    // A hard lock through a fiscal year's last day keeps its closing entries out (locks are never skipped), so it blocks a
    // year's close: set the lock after the close.
    PccHardLock(c) {
        if (c.period.timePeriodTypeId !== "FiscalYear") return {count: 0, items: []}
        const chain = [...new Set(c.organizations.flatMap(org => lib.organizationChain(org)))]
        const locks = Array.from(
            find("mantle.ledger.config.AccountingLock")
                .condition("organizationPartyId", "in", chain)
                .condition("isHard", "Y")
                .condition("lockThroughDate", "greater-equals", c.thruDay)
                .list()
        )
        return result(locks, lock => ({
            recordKind: "locks",
            recordId: lock.accountingLockId,
            text:
                "Hard lock " + lock.accountingLockId + " (" + lock.lockScope + ") through " +
                lib.calendarDateText(lock.lockThroughDate),
            detail: lock.changeReason
        }))
    },
    // Approved project time of the period whose cost posting differs from its cost (with project cost posting on).
    PccProjectCost(c) {
        const pending = ec.resource
            .script("component://mr-mantle/service/mantle/ledger/ProjectCosts.js")
            .pending(c.s.organizationPartyId, c.fromStamp, c.afterStamp)
        return result(pending, row => ({
            recordKind: "timeEntries",
            recordId: row.timeEntryId,
            text: "Time entry " + row.timeEntryId + (row.workEffortId ? " · " + row.workEffortId : ""),
            detail: row.failureMessage || "To post " + String(row.delta)
        }))
    }
}
function standardCheck(p) {
    const check = checks[p.checkEnumId]
    if (!check) throw new Error("Unknown period close check " + p.checkEnumId)
    return check(periodScope(p))
}

// The checks Mantle's close#FinancialTimePeriod makes of the period itself: it has ended, the previous period is closed
// and so are its child periods.
function periodOrder(c) {
    const items = []
    const period = c.period
    if (ms(ec.user.nowTimestamp) < ms(c.afterStamp))
        items.push({recordKind: "periods", recordId: period.timePeriodId, text: "The period ends on " + c.thruDay})
    if (period.previousPeriodId) {
        const previous = one("mantle.party.time.TimePeriod", {timePeriodId: period.previousPeriodId})
        if (previous && previous.isClosed !== "Y")
            items.push({
                recordKind: "periods",
                recordId: previous.timePeriodId,
                text: "The previous period " + (previous.periodName || previous.timePeriodId) + " is open"
            })
    }
    for (const child of rows("mantle.party.time.TimePeriod", {parentPeriodId: period.timePeriodId}))
        if (child.isClosed !== "Y")
            items.push({
                recordKind: "periods",
                recordId: child.timePeriodId,
                text: "The period " + (child.periodName || child.timePeriodId) + " within it is open"
            })
    return {count: items.length, items}
}
function checkRow(enumeration, out, error) {
    const blocking = enumeration.optionIndicator === "Y"
    const count = error ? null : Number(out.count || 0)
    return {
        checkEnumId: enumeration.enumId,
        title: enumeration.description,
        blocking,
        count,
        items: error ? [] : Array.from(out.items || []),
        status: error ? "unavailable" : count === 0 ? "clear" : blocking ? "blocked" : "warning",
        message: error ? "This check could not run: " + error : null
    }
}
// The checklist rows of a period scope, each check in its own error frame: a check that fails is unavailable, which
// blocks the close, and the others still run.
function checklistRows(c) {
    const out = [
        checkRow({enumId: "PccPeriodOrder", description: "Period dates and order", optionIndicator: "Y"}, periodOrder(c))
    ]
    const enumerations = Array.from(
        find("moqui.basic.Enumeration", {enumTypeId: "PeriodCloseCheck"}).orderBy("sequenceNum,enumId").useCache(true).list()
    )
    for (const enumeration of enumerations) {
        const parameters = {
            organizationPartyId: c.s.organizationPartyId,
            timePeriodId: c.period.timePeriodId,
            checkEnumId: enumeration.enumId
        }
        ec.message.pushErrors()
        try {
            // each check reads in its own transaction, so one that fails leaves the close's transaction usable
            const found =
                ec.service
                    .sync()
                    .name(enumeration.enumCode)
                    .parameters(parameters)
                    .disableAuthz()
                    .requireNewTransaction(true)
                    .call() || {}
            if (ec.message.hasError()) throw new Error(ec.message.getErrorsString())
            out.push(checkRow(enumeration, found))
        } catch (error) {
            ec.logger.error("Period close check " + enumeration.enumId + " of " + c.period.timePeriodId + ": " + error.message)
            out.push(checkRow(enumeration, null, error.message))
        } finally {
            ec.message.clearErrors()
            ec.message.popErrors()
        }
    }
    return out
}
function closeRuns(timePeriodId) {
    return Array.from(
        find("mantle.ledger.transaction.AccountingCloseRun", {timePeriodId}).orderBy("-closedDate,-closeRunId").list()
    ).map(run => display(run))
}
function checklist(p) {
    const c = periodScope(p)
    const checkRows = c.period.isClosed === "Y" ? [] : checklistRows(c)
    const blockers = checkRows.filter(row => row.status === "blocked" || row.status === "unavailable")
    const capabilities = c.s.capabilities
    return {
        period: Object.assign(display(c.period), {fromDay: c.fromDay, thruDay: c.thruDay}),
        checkRows,
        blockerCount: blockers.length,
        canClose: c.period.isClosed !== "Y" && !blockers.length && !!capabilities.fiscalClose,
        canReopen: c.period.isClosed === "Y" && !!capabilities.fiscalReopen,
        closeRuns: closeRuns(c.period.timePeriodId)
    }
}

// The period's GL summary rows (GlAccountOrgTimePeriod) computed from its posted entries and stored, every account with
// a posting before or in the period getting its row: the beginning balance from all earlier postings, the period's
// debits and credits with and without closing entries, and the ending balance, each in the account's own sign.
function snapshot(c, org) {
    // the totals the statement reports sum for an open period (FinanceReports.periodTotals), stored for the closed one
    const reports = ec.resource.script("component://mr-mantle/service/mantle/ledger/FinanceReports.js")
    const {totals} = reports.periodTotals(org, c)
    const total = id => totals[id] || (totals[id] = reports.blankTotal())
    const stored = new Map(
        Array.from(
            find("mantle.ledger.account.GlAccountOrgTimePeriod", {organizationPartyId: org, timePeriodId: c.period.timePeriodId})
                .forUpdate(true)
                .list()
        ).map(row => [row.glAccountId, row])
    )
    for (const id of stored.keys()) total(id)
    const ids = Object.keys(totals).sort()
    const debitAccounts = new Set(
        ids.length
            ? Array.from(
                  find("mantle.ledger.account.GlAccount").condition("glAccountId", "in", ids).condition("isDebit", "Y").list()
              ).map(row => row.glAccountId)
            : []
    )
    let debitTotal = toDecimal(0),
        creditTotal = toDecimal(0)
    const endings = {}
    for (const id of ids) {
        const entry = totals[id],
            sign = debitAccounts.has(id) ? 1 : -1
        const beginning = entry.before.multiply(sign)
        const values = {
            glAccountId: id,
            organizationPartyId: org,
            timePeriodId: c.period.timePeriodId,
            beginningBalance: beginning,
            postedDebits: entry.debits,
            postedCredits: entry.credits,
            postedDebitsNoClosing: entry.debitsNoClosing,
            postedCreditsNoClosing: entry.creditsNoClosing,
            endingBalance: beginning.add(entry.debits.subtract(entry.credits).multiply(sign)),
            balanceLastUpdated: ec.user.nowTimestamp
        }
        call((stored.has(id) ? "update#" : "create#") + "mantle.ledger.account.GlAccountOrgTimePeriod", values)
        endings[id] = values.endingBalance
        debitTotal = debitTotal.add(entry.debits)
        creditTotal = creditTotal.add(entry.credits)
    }
    return {accountCount: ids.length, debitTotal, creditTotal, endings}
}
// The later periods' existing summary rows begin where the closed period's stored rows end (their own movement kept);
// no row is made and no period's posted sums are recalculated.
function carryForward(c, org, endings) {
    let previousId = c.period.timePeriodId,
        carried = endings
    for (let depth = 0; depth < 240; depth++) {
        const next = one("mantle.party.time.TimePeriod", {previousPeriodId: previousId})
        if (!next) return
        const following = {}
        for (const row of find("mantle.ledger.account.GlAccountOrgTimePeriod", {
            organizationPartyId: org,
            timePeriodId: next.timePeriodId
        })
            .forUpdate(true)
            .list()) {
            const beginning = carried[row.glAccountId]
            if (beginning == null) {
                following[row.glAccountId] = toDecimal(row.endingBalance ?? 0)
                continue
            }
            const ending = toDecimal(row.endingBalance ?? 0)
                .subtract(toDecimal(row.beginningBalance ?? 0))
                .add(beginning)
            call("update#mantle.ledger.account.GlAccountOrgTimePeriod", {
                glAccountId: row.glAccountId,
                organizationPartyId: org,
                timePeriodId: next.timePeriodId,
                beginningBalance: beginning,
                endingBalance: ending,
                balanceLastUpdated: ec.user.nowTimestamp
            })
            following[row.glAccountId] = ending
        }
        previousId = next.timePeriodId
        carried = following
    }
}

// Close the period, all in one transaction: under its lock, the checklist again (a blocked or unavailable row refuses,
// naming each); the close run, closing while this transaction runs; Mantle's close#FinancialTimePeriod; the summary rows of
// the organization and each organization that rolls up to it; for a fiscal year each one's closing entries to its own net
// income account, every one of them posted or the whole close rolls back, and the summary rows again; the later periods'
// beginning balances; and the run, closed, with the checklist it passed.
function close(p) {
    const s = lib.organization(p, "fiscalClose")
    let op = null
    if (p.operationKey) {
        op = lib.lib.operation(p, "PeriodClose", s.organizationPartyId, {timePeriodId: p.timePeriodId})
        if (op.old) return lib.lib.previous(op)
    }
    find("mantle.party.Party", {partyId: s.organizationPartyId}).forNoKeyUpdate(true).one()
    const c = periodScope(p, "fiscalClose", true)
    if (c.period.isClosed === "Y") denied("PERIOD_CLOSED", "The period is already closed")
    const checkRows = checklistRows(c)
    const blockers = checkRows.filter(row => row.status === "blocked" || row.status === "unavailable")
    if (blockers.length)
        denied(
            "CLOSE_BLOCKED",
            "The period cannot close: " +
                blockers.map(row => row.title + (row.count == null ? " (unavailable)" : " (" + row.count + ")")).join("; ")
        )
    const reason = String(p.changeReason || "").trim() || "Period close"
    // the run, closing: the posting guard lets this close's closing entries into the year (closingInProgress)
    const run = call("create#mantle.ledger.transaction.AccountingCloseRun", {
        organizationPartyId: s.organizationPartyId,
        timePeriodId: c.period.timePeriodId,
        statusId: "CrnClosing",
        closedByUserId: ec.user.userId,
        closedDate: ec.user.nowTimestamp,
        closeReason: reason.slice(0, 255),
        operationKey: p.operationKey || null
    })
    call("mantle.ledger.LedgerServices.close#FinancialTimePeriod", {timePeriodId: c.period.timePeriodId})
    const summaries = {}
    for (const org of c.organizations) summaries[org] = snapshot(c, org)
    const closingIds = []
    let netIncomeGlAccountId = null
    if (c.period.timePeriodTypeId === "FiscalYear") {
        for (const org of c.organizations) {
            if (!summaries[org].accountCount) continue
            const closing = call("mantle.ledger.LedgerServices.create#PeriodCloseAcctgTrans", {
                timePeriodId: c.period.timePeriodId,
                organizationPartyId: org,
                netIncomeGlAccountId: org === s.organizationPartyId ? p.netIncomeGlAccountId || null : null,
                reviewed: true
            })
            const ids = Object.values(closing.acctgTransIdByClassId || {})
            for (const acctgTransId of ids) {
                const tx = one(T, {acctgTransId})
                if (tx?.isPosted !== "Y")
                    denied(
                        "CLOSE_POSTING_FAILED",
                        "Closing entry " +
                            acctgTransId +
                            " did not post" +
                            (tx?.postingFailureMessage ? ": " + tx.postingFailureMessage : "")
                    )
                if (org === s.organizationPartyId && !netIncomeGlAccountId)
                    netIncomeGlAccountId = Array.from(
                        find("mantle.ledger.transaction.AcctgTransEntry", {acctgTransId}).orderBy("-acctgTransEntrySeqId").list()
                    )[0]?.glAccountId
            }
            closingIds.push(...ids)
            if (ids.length) summaries[org] = snapshot(c, org)
        }
    }
    for (const org of c.organizations) carryForward(c, org, summaries[org].endings)
    // the closing entries are dated the year's last day, inside the year's last month and quarter: their stored rows
    // are made again, for each organization, as are the later periods after them
    if (closingIds.length)
        for (const inner of Array.from(
            find("mantle.party.time.TimePeriod", {partyId: c.period.partyId, isClosed: "Y"})
                .condition("timePeriodId", "not-equals", c.period.timePeriodId)
                .condition("fromDate", "less-equals", c.thruDay)
                .condition("thruDate", "greater-equals", c.thruDay)
                .list()
        )) {
            const innerScope = scopeOf(c, inner)
            for (const org of c.organizations) carryForward(innerScope, org, snapshot(innerScope, org).endings)
        }
    const own = summaries[s.organizationPartyId]
    call("update#mantle.ledger.transaction.AccountingCloseRun", {
        closeRunId: run.closeRunId,
        statusId: "CrnClosed",
        checklistJson: JSON.stringify(checkRows),
        closingAcctgTransIds: closingIds.join(","),
        netIncomeGlAccountId,
        summaryAccountCount: own.accountCount,
        summaryDebitTotal: own.debitTotal,
        summaryCreditTotal: own.creditTotal
    })
    const answer = {closeRunId: run.closeRunId, closingAcctgTransIdList: closingIds, summaryAccountCount: own.accountCount}
    if (op) lib.lib.complete(op, "mantle.ledger.transaction.AccountingCloseRun", run.closeRunId, answer)
    // the close as a marker on the organization's time series, after the commit (BusinessEvents.js)
    ec.resource.script("component://mr-mantle/service/mantle/party/BusinessEvents.js").register("PeriodClosed", run.closeRunId)
    return answer
}

// Reopen a closed period with a reason, through Mantle's reopen#FinancialTimePeriod (FISCAL_REOPEN; refused while the
// next period or the parent period is closed). The close run is kept, marked reopened; the next close is a new run.
function reopen(p) {
    const s = lib.organization(p, "fiscalReopen")
    const reason = lib.reason(p)
    find("mantle.party.Party", {partyId: s.organizationPartyId}).forNoKeyUpdate(true).one()
    const c = periodScope(p, "fiscalReopen", true)
    if (c.period.isClosed !== "Y") denied("PERIOD_OPEN", "The period is not closed")
    call("mantle.ledger.LedgerServices.reopen#FinancialTimePeriod", {timePeriodId: c.period.timePeriodId})
    const reopened = {
        statusId: "CrnReopened",
        reopenedByUserId: ec.user.userId,
        reopenedDate: ec.user.nowTimestamp,
        reopenReason: reason
    }
    lib.audit(Object.keys(reopened), reason)
    const latest = Array.from(
        find("mantle.ledger.transaction.AccountingCloseRun", {timePeriodId: c.period.timePeriodId, statusId: "CrnClosed"})
            .orderBy("-closedDate,-closeRunId")
            .forUpdate(true)
            .list()
    )[0]
    if (latest) {
        call("update#mantle.ledger.transaction.AccountingCloseRun", Object.assign({closeRunId: latest.closeRunId}, reopened))
        return {closeRunId: latest.closeRunId}
    }
    // a period Mantle's own close closed has no run: the reopen is recorded on one
    const run = call(
        "create#mantle.ledger.transaction.AccountingCloseRun",
        Object.assign({organizationPartyId: s.organizationPartyId, timePeriodId: c.period.timePeriodId}, reopened)
    )
    return {closeRunId: run.closeRunId}
}

const operations = {checklist, standardCheck, close, reopen}
;({
    execute: (op, parameters) => {
        if (!operations[op]) throw new Error("Unknown period close operation " + op)
        return operations[op](parameters)
    },
    checks,
    periodScope,
    stampInPeriod
})
