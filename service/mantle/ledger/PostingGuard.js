// The finance posting choke point. Verification reads only; callers decide whether a refusal is an error or a queue item.
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/AccountingPolicy.js")
const T = "mantle.ledger.transaction.AcctgTrans",
    E = "mantle.ledger.transaction.AcctgTransEntry"
const {find, one, rows, map, ms, active, preference, hash} = lib
const A = "mantle.account.payment.PaymentApplication"
// A source's cash or document posting, and the postings of an application, by AcctgTrans type.
const cashTypes = ["AttPayment", "AttDisbursement", "AttReceipt", "AttIncomingPayment", "AttOutgoingPayment"]
// A period's closing entries (create#PeriodCloseAcctgTrans).
const closingTypes = ["AttPeriodClosing", "AttNetIncomeClosing"]
const applicationTypes = [
    "AttOutgoingPaymentAp",
    "AttIncomingPaymentAp",
    "AttPaymentInOutAppl",
    "AttInvoiceInOutAppl",
    "AttPaymentApplied",
    "AttPaymentAdjust"
]
function fiscal(org, date, lock = false, visited = [], calendarDay = null) {
    if (visited.includes(org))
        return {
            periods: [],
            findings: [
                {
                    code: "PERIOD_CYCLE",
                    message: "Fiscal organization hierarchy contains a cycle"
                }
            ]
        }
    if (ms(date) == null || !Number.isFinite(ms(date)))
        return {
            periods: [],
            findings: [{code: "DATE_INVALID", message: "Choose a transaction date"}]
        }
    const at = calendarDay || ec.l10n.format(date, "yyyy-MM-dd")
    const periods = Array.from(
        find("mantle.party.time.TimePeriodAndType", {
            partyId: org,
            periodPurposeEnumId: "Fiscal"
        })
            .condition("fromDate", "less-equals", at)
            .condition("thruDate", "greater-equals", at)
            .orderBy("timePeriodId")
            .list()
    )
    const findings = []
    let selected = []
    for (const period of periods) {
        const current = lock
            ? find("mantle.party.time.TimePeriod", {
                  timePeriodId: period.timePeriodId
              })
                  .forUpdate(true)
                  .one()
            : period
        selected.push(current)
        if (current.isClosed === "Y")
            findings.push({
                code: "PERIOD_CLOSED",
                message: "Fiscal period " + current.timePeriodId + " is closed"
            })
    }
    const parents = rows("mantle.party.PartyRelationship", {
        fromPartyId: org,
        relationshipTypeEnumId: "PrtOrgRollup"
    }).filter(r => active(r, date))
    for (const parent of parents) {
        const out = fiscal(parent.toPartyId, date, lock, [...visited, org], calendarDay)
        selected = selected.concat(out.periods)
        findings.push(...out.findings)
    }
    if (!selected.length)
        findings.push({
            code: "PERIOD_MISSING",
            message: "No fiscal period configured for this date"
        })
    return {periods: selected, findings}
}
function scopes(tx, lines) {
    const scopes = new Set(["all"])
    if (tx.invoiceId) {
        const invoice = one("mantle.account.invoice.Invoice", {
            invoiceId: tx.invoiceId
        })
        if (invoice?.financeOrganizationPartyId === tx.organizationPartyId && invoice.financeDirection) {
            scopes.add(invoice.financeDirection === "receivable" ? "sales" : "purchases")
        } else {
            const source = invoice?.creditForInvoiceId
                ? one("mantle.account.invoice.Invoice", {invoiceId: invoice.creditForInvoiceId})
                : invoice
            if (source?.fromPartyId === tx.organizationPartyId) scopes.add("sales")
            if (source?.toPartyId === tx.organizationPartyId) scopes.add("purchases")
        }
    }
    if (
        ["AttTaxDue", "AttTaxInvoice"].includes(tx.acctgTransTypeEnumId) ||
        lines.some(line => {
            const account =
                line.glAccountId &&
                one("mantle.ledger.account.GlAccount", {
                    glAccountId: line.glAccountId
                })
            return line.glAccountTypeEnumId === "GatTax" || account?.glAccountTypeEnumId === "GatTax"
        })
    )
        scopes.add("tax")
    return [...scopes]
}
// A physical source's posting (an asset receipt or issuance, a physical inventory, a financial account transaction) or a
// project's cost on its timesheet's approval (post#WorkEffortCost) that fails the guard goes to the error journal,
// unposted, instead of failing its source's write.
function automatic(tx) {
    return (
        !!(
            tx.assetReceiptId ||
            tx.assetIssuanceId ||
            tx.physicalInventoryId ||
            tx.finAccountTransId ||
            tx.acctgTransTypeEnumId === "AttWorkEffortCost"
        ) && !tx.reverseOfAcctgTransId
    )
}
// The one payment a public Billing page has checked and is completing (Portal.js sets PORTAL_PAYMENT in the execution
// context's shared map around its gateway calls; Shop's checkout does too, through PaymentAttempts.js asAttempt): a
// customer's card payment to the organization, which no user of the organization makes. Its own posting, or its application's, skips the user's organization check; nothing else does.
const PORTAL_PAYMENT = "mantle.portalPaymentId"
function portalPayment(tx) {
    const marked = ec.context.sharedMap[PORTAL_PAYMENT]
    if (!marked || tx.reverseOfAcctgTransId) return false
    const paymentId = tx.paymentId || (tx.paymentApplicationId && one(A, {paymentApplicationId: tx.paymentApplicationId})?.paymentId)
    if (paymentId !== marked) return false
    return one("mantle.account.payment.Payment", {paymentId})?.toPartyId === tx.organizationPartyId
}
// The source document fields of a posting; a posting with none, or a reversal, is a manual one.
const sourceFields = [
    "invoiceId",
    "paymentId",
    "paymentApplicationId",
    "assetReceiptId",
    "assetIssuanceId",
    "physicalInventoryId",
    "finAccountTransId",
    "assetId",
    "assetDepreciationId",
    "inventoryCostDetailId"
]
function postingLocks(tx, applicable, lock = false, sourceDay = null, enabled = true) {
    const locks = enabled
        ? rows("mantle.ledger.config.AccountingLock", {
              organizationPartyId: tx.organizationPartyId
          })
        : []
    const findings = []
    const fail = (code, message) => findings.push({code, message})
    for (const initial of locks.sort((a, b) => a.accountingLockId.localeCompare(b.accountingLockId))) {
        const row = lock
            ? find("mantle.ledger.config.AccountingLock", {
                  accountingLockId: initial.accountingLockId
              })
                  .forUpdate(true)
                  .one()
            : initial
        if (
            !applicable.includes(row.lockScope) ||
            (sourceDay || ec.l10n.format(tx.transactionDate, "yyyy-MM-dd")) > lib.calendarDateText(row.lockThroughDate)
        )
            continue
        const exceptions =
            row.isHard === "Y"
                ? []
                : rows("mantle.ledger.config.AccountingLockException", {
                      accountingLockId: row.accountingLockId
                  })
        const allowed = exceptions.some(
            e =>
                active(e) &&
                e.organizationPartyId === tx.organizationPartyId &&
                (e.userId === ec.user.userId || (e.userGroupId && ec.user.isInGroup(e.userGroupId))) &&
                (!e.acctgTransId || e.acctgTransId === tx.acctgTransId) &&
                e.lockScope === row.lockScope
        )
        if (!allowed)
            fail(
                row.isHard === "Y" ? "HARD_LOCK" : "SOFT_LOCK",
                "Posting lock " + row.accountingLockId + " (" + row.lockScope + "): " + row.changeReason
            )
    }
    return {locks, findings}
}
function calendarDay(tx, sources, sourceDatesEnabled) {
    if (tx.accountingDate) return lib.calendarDateText(tx.accountingDate)
    if (tx.isPosted === "Y" || !sourceDatesEnabled) return null
    // An undated legacy reversal keeps the original timestamp basis; a linked document's SQL day cannot move it.
    if (tx.reverseOfAcctgTransId) return lib.postingDay(tx)
    const originalSource = [
        [sources.paymentApplicationId, "appliedDate"],
        [sources.paymentId, "effectiveDate"],
        [sources.invoiceId, "invoiceDate"]
    ].find(([source, dateField]) => source?.accountingDate && ms(tx.transactionDate) === ms(source[dateField]))
    return originalSource ? lib.calendarDateText(originalSource[0].accountingDate) : null
}
// Whether a transaction is a closing entry of the close in progress: a closing type, on the last day of the fiscal year
// the caller names, of the posting organization or one it rolls up to, while this user's AccountingCloseRun of that year
// is closing; that run exists only inside close#Period's own transaction until it commits as closed.
function closingInProgress(tx, closingTimePeriodId) {
    if (!closingTimePeriodId || !closingTypes.includes(tx.acctgTransTypeEnumId)) return false
    const period = one("mantle.party.time.TimePeriod", {timePeriodId: closingTimePeriodId})
    if (!period || period.timePeriodTypeId !== "FiscalYear") return false
    if (!lib.organizationChain(tx.organizationPartyId, tx.transactionDate).includes(period.partyId)) return false
    if (!tx.accountingDate || lib.calendarDateText(tx.accountingDate) !== lib.calendarDateText(period.thruDate)) return false
    return !!find("mantle.ledger.transaction.AccountingCloseRun", {
        timePeriodId: closingTimePeriodId,
        statusId: "CrnClosing",
        closedByUserId: ec.user.userId
    }).one()
}
function validate(p, lock = false) {
    const tx = (lock ? find(T, {acctgTransId: p.acctgTransId}).forUpdate(true) : find(T, {acctgTransId: p.acctgTransId})).one()
    if (!tx) throw new Error("Accounting transaction is not available")
    const lines = Array.from(find(E, {acctgTransId: tx.acctgTransId}).orderBy("acctgTransEntrySeqId").list())
    const pref = preference(tx.organizationPartyId),
        enabled = pref.postingGuardEnabled === "Y"
    if (lock && enabled) {
        const ids = [...new Set(lines.map(r => r.glAccountId).filter(Boolean))].sort()
        if (ids.length) {
            Array.from(
                find("mantle.ledger.account.GlAccount")
                    .condition("glAccountId", "in", ids)
                    .orderBy("glAccountId")
                    .forUpdate(true)
                    .list()
            )
            Array.from(
                find("mantle.ledger.account.GlAccountOrganization")
                    .condition("glAccountId", "in", ids)
                    .condition("organizationPartyId", "in", lib.organizationChain(tx.organizationPartyId, tx.transactionDate))
                    .orderBy("glAccountId,organizationPartyId")
                    .forUpdate(true)
                    .list()
            )
        }
    }
    const findings = [],
        debit = lines.filter(r => r.debitCreditFlag === "D").reduce((a, r) => a.add(r.amount ?? 0), toDecimal(0)),
        credit = lines.filter(r => r.debitCreditFlag === "C").reduce((a, r) => a.add(r.amount ?? 0), toDecimal(0))
    const fail = (code, message) => findings.push({code, message})
    if (!debit.eq(credit) || !lines.length) fail("UNBALANCED", "Transaction must have balanced debit and credit lines")
    if (tx.scheduledPostingDate && ms(tx.scheduledPostingDate) > ms(ec.user.nowTimestamp))
        fail("NOT_DUE", "Scheduled posting date has not arrived")
    const sourceEvidence = {}
    for (const [field, entity, key] of [
        ["invoiceId", "mantle.account.invoice.Invoice", "invoiceId"],
        ["paymentId", "mantle.account.payment.Payment", "paymentId"]
    ]) {
        if (!tx[field]) continue
        const source = (
            lock && enabled ? find(entity, {[key]: tx[field]}).forUpdate(true) : find(entity, {[key]: tx[field]})
        ).one()
        sourceEvidence[field] = map(source)
        if (enabled && (!source || ![source.fromPartyId, source.toPartyId].includes(tx.organizationPartyId)))
            fail("SOURCE_SCOPE", "The posting source does not belong to this organization")
    }
    const applicationSource = tx.paymentApplicationId
        ? (lock && enabled
              ? find("mantle.account.payment.PaymentApplication", {paymentApplicationId: tx.paymentApplicationId}).forUpdate(true)
              : find("mantle.account.payment.PaymentApplication", {paymentApplicationId: tx.paymentApplicationId})
          ).one()
        : null
    if (applicationSource) sourceEvidence.paymentApplicationId = map(applicationSource)
    // Captured history remains authoritative even if the general guard is later disabled.
    const sourceDay = calendarDay(tx, sourceEvidence, true)
    const fiscalOut = fiscal(tx.organizationPartyId, tx.transactionDate, lock, [], sourceDay)
    findings.push(...fiscalOut.findings)
    if (enabled) {
        if (
            !one("mantle.party.PartyRole", {
                partyId: tx.organizationPartyId,
                roleTypeId: "OrgInternal"
            })
        )
            fail("ORGANIZATION", "Posting organization must be internal")
        const currency = tx.amountUomId && one("moqui.basic.Uom", {uomId: tx.amountUomId})
        if (!currency || currency.uomTypeEnumId !== "UT_CURRENCY_MEASURE" || !pref.baseCurrencyUomId)
            fail("CURRENCY_MISMATCH", "Posting requires a currency and the organization's base currency")
        else if (tx.amountUomId !== pref.baseCurrencyUomId) {
            // post#AcctgTrans converts a transaction with a rate before this check; one still in another currency has none
            const rated = ec.resource
                .script("component://mr-mantle/service/mantle/ledger/Currencies.js")
                .execute("convertible", {acctgTransId: tx.acctgTransId})
            if (rated.missing) fail("RATE_MISSING", rated.message)
        }
        const domain = ec.resource.script("component://mr-mantle/service/mantle/product/ProductAccess.js")
        const orgs =
            domain.systemAdmin() || domain.has("ACCOUNTING_ADMIN") || portalPayment(tx)
                ? null
                : lib.call("mantle.party.PartyServices.get#PartyOrganizationInfo").userOrgIds || []
        if (orgs && !orgs.includes(tx.organizationPartyId)) fail("ORGANIZATION", "Posting organization is not available")
    }
    for (const line of lines) {
        const account =
            line.glAccountId &&
            one("mantle.ledger.account.GlAccount", {
                glAccountId: line.glAccountId
            })
        if (!account || account.disallowPosting === "Y" || line.amount == null || !["D", "C"].includes(line.debitCreditFlag))
            fail("ENTRY_INVALID", "Line " + line.acctgTransEntrySeqId + " needs an amount and a posting account")
        if (enabled) {
            try {
                lib.dimensions(tx.organizationPartyId, line, tx.transactionDate)
            } catch (error) {
                fail("DIMENSION_SCOPE", "Line " + line.acctgTransEntrySeqId + ": " + error.message)
            }
        }
        if (enabled && account) {
            const assignment = lib.accountAssignment(tx.organizationPartyId, account.glAccountId, tx.transactionDate)
            if (!assignment || !active(assignment, tx.transactionDate))
                fail("ACCOUNT_INACTIVE", "Account " + account.glAccountId + " is not active for this organization and date")
            if (pref.requiredLedgerDimensionsEnabled === "Y" && assignment) {
                for (const [field, required] of [
                    ["facilityId", "facilityRequired"],
                    ["costCenterId", "costCenterRequired"]
                ]) {
                    if (assignment[required] === "Y" && !line[field])
                        fail("DIMENSION_REQUIRED", "Line " + line.acctgTransEntrySeqId + " requires " + field)
                }
            }
        }
    }
    const applicable = scopes(tx, lines)
    const lockOut = postingLocks(tx, applicable, lock, sourceDay, enabled)
    const locks = lockOut.locks
    findings.push(...lockOut.findings)
    // The closing entries close#Period posts go into the fiscal year it is closing: only those pass its closed-period
    // finding, never a lock's; check asks FISCAL_CLOSE of them.
    if (closingInProgress(tx, p.closingTimePeriodId))
        for (let i = findings.length - 1; i >= 0; i--) if (findings[i].code === "PERIOD_CLOSED") findings.splice(i, 1)
    const evidence = {
        sources: sourceEvidence,
        tx: map(tx),
        lines: lines.map(map),
        periods: fiscalOut.periods.map(r =>
            lib.pick(map(r), ["timePeriodId", "partyId", "timePeriodTypeId", "fromDate", "thruDate", "isClosed"])
        ),
        locks: locks.map(r => ({
            lock: map(r),
            exceptions: rows("mantle.ledger.config.AccountingLockException", {
                accountingLockId: r.accountingLockId
            }).map(map)
        })),
        preferences: lib.pick(map(pref), ["postingGuardEnabled", "requiredLedgerDimensionsEnabled", "baseCurrencyUomId"]),
        accounts: lines.map(r => ({
            account: map(
                one("mantle.ledger.account.GlAccount", {
                    glAccountId: r.glAccountId
                })
            ),
            assignment: map(lib.accountAssignment(tx.organizationPartyId, r.glAccountId, tx.transactionDate))
        }))
    }
    return {
        tx,
        lines,
        preference: pref,
        enabled,
        findings,
        periods: fiscalOut.periods,
        authoritativePeriods: !!sourceDay,
        captureAccountingDate: sourceDay && !tx.accountingDate && tx.isPosted !== "Y" ? sourceDay : null,
        debitTotal: debit,
        creditTotal: credit,
        inputFingerprint: hash(evidence),
        valid: findings.length === 0,
        automatic: automatic(tx)
    }
}
// The book day of an application: its reviewed accounting day, else the day of its applied date in the user's zone.
function applicationDay(application) {
    return lib.bookDay(application.accountingDate, application.appliedDate)
}
// The positive applications that consume a posting's source documents. A cash posting consumes only its payment.
function positiveApplications(tx) {
    const cf = ec.entity.conditionFactory,
        conditions = [],
        linked = tx.paymentApplicationId ? one(A, {paymentApplicationId: tx.paymentApplicationId}) : null,
        cash = tx.paymentId && cashTypes.includes(tx.acctgTransTypeEnumId)
    for (const [sources, fields] of [
        [cash ? [] : [tx.invoiceId, tx.toInvoiceId, linked?.invoiceId, linked?.toInvoiceId], ["invoiceId", "toInvoiceId"]],
        [
            [tx.paymentId, tx.toPaymentId, linked?.paymentId, linked?.toPaymentId],
            ["paymentId", "toPaymentId"]
        ]
    ])
        for (const id of [...new Set(sources.filter(Boolean))])
            for (const field of fields) conditions.push(cf.makeCondition(field, "equals", id))
    if (!conditions.length) return []
    return Array.from(
        find(A)
            .condition(cf.makeCondition(conditions, "or"))
            .condition("amountApplied", "greater", 0)
            .orderBy("paymentApplicationId")
            .list()
    )
}
// A source document posts no later than the book day of an application that already consumes it.
function checkSourceDay(tx) {
    if (tx.isPosted === "Y" || tx.reverseOfAcctgTransId || applicationTypes.includes(tx.acctgTransTypeEnumId)) return
    if (!tx.invoiceId && !tx.paymentId) return
    const day = lib.postingDay(tx)
    if (positiveApplications(tx).some(application => applicationDay(application) < day))
        throw new Error("APPLICATION_BEFORE_SOURCE_POSTING: A source cannot post after the day of an existing application")
}
// An application's posting without its own accounting day takes the reviewed book day of its application (the day an
// apply service was given), when it posts on the application's date. Other postings take theirs only through validate
// with the posting guard on.
function captureSourceDay(tx) {
    if (tx.isPosted === "Y" || tx.accountingDate || !tx.paymentApplicationId) return
    if (!applicationTypes.includes(tx.acctgTransTypeEnumId) || tx.reverseOfAcctgTransId) return
    const application = one(A, {paymentApplicationId: tx.paymentApplicationId})
    const day = calendarDay(tx, {paymentApplicationId: map(application)}, true)
    if (day) lib.call("update#" + T, {acctgTransId: tx.acctgTransId, accountingDate: day})
}
// A posting that backs a positive application keeps its evidence: reverse or move it after the application is unapplied.
// An unpost (operation "unpost") is not held to that: Mantle's revert#PaymentApplicationPost and
// repost#PaymentAndApplications unpost, delete and post a source again in one transaction, and check#AcctgTrans checks
// the new posting.
function assertMutable(p) {
    const initial = one(T, {acctgTransId: p.acctgTransId})
    if (!initial) return
    if (p.operation === "unpost" || initial.isPosted !== "Y") return
    if (!initial.invoiceId && !initial.paymentId && !initial.paymentApplicationId) return
    // The organization first, as the application writers lock it, then the transaction.
    find("mantle.party.Party", {partyId: initial.organizationPartyId}).forUpdate(true).one()
    const tx = find(T, {acctgTransId: initial.acctgTransId}).forUpdate(true).one()
    const ownApplication = applicationTypes.includes(tx.acctgTransTypeEnumId) && !tx.reverseOfAcctgTransId
    const linked = ownApplication && tx.paymentApplicationId ? one(A, {paymentApplicationId: tx.paymentApplicationId}) : null
    const consumed = ownApplication ? toDecimal(linked?.amountApplied ?? 0).compare(0) > 0 : positiveApplications(tx).length > 0
    // A void or cancelled payment's own cash posting may be reversed first: its PaymentCancelledCleanup SECA unapplies the
    // payment in the same transaction.
    const voided =
        !ownApplication &&
        !!tx.paymentId &&
        ["PmntVoid", "PmntCancelled"].includes(one("mantle.account.payment.Payment", {paymentId: tx.paymentId})?.statusId)
    if (consumed && !voided)
        throw new Error("SOURCE_HAS_APPLICATIONS: Unapply the financial application before changing its posting evidence")
}
// The net amount the posted entries put on one account and side equals the document amount.
function controlProof(evidence, account, flag, amount) {
    const net = evidence.entries
        .filter(row => row.glAccountId === account)
        .reduce(
            (sum, row) => (row.debitCreditFlag === flag ? sum.add(row.amount || 0) : sum.subtract(row.amount || 0)),
            toDecimal(0)
        )
    if (!net.eq(amount || 0))
        throw new Error("SOURCE_POSTING_INCOMPLETE: The posted control amount does not match its financial document")
}
function check(p) {
    const initial = one(T, {acctgTransId: p.acctgTransId})
    if (!initial) throw new Error("Accounting transaction is not available")
    const pref = preference(initial.organizationPartyId)
    if (!p.verifyOnly) checkSourceDay(initial)
    const adopted = pref.postingGuardEnabled === "Y"
    if (!p.verifyOnly && !adopted) {
        captureSourceDay(initial)
        return {handled: false, valid: true, findings: []}
    }
    if (!p.verifyOnly) find("mantle.party.Party", {partyId: initial.organizationPartyId}).forUpdate(true).one()
    const out = validate(p, !p.verifyOnly)
    if (out.findings.some(r => r.code === "ORGANIZATION")) throw new Error("Posting organization is not available")
    if (!p.verifyOnly && out.enabled && out.valid) {
        // A manual posting or a reversal needs GL posting authority unless its caller says it is reviewed: Mantle's
        // posting and reverting services of a source document. A source document's own posting is its service's.
        const manual = !!out.tx.reverseOfAcctgTransId || !sourceFields.some(field => out.tx[field])
        if (manual && !p.reviewed && !lib.lib.access.has("ACCOUNTING_GL_POST"))
            throw new Error("REVIEW_REQUIRED: Use a reviewed posting operation")
        if (closingTypes.includes(out.tx.acctgTransTypeEnumId) && !lib.lib.access.has("FISCAL_CLOSE"))
            throw new Error("PERMISSION_DENIED: Closing entries need period close authority (FISCAL_CLOSE)")
        if (out.captureAccountingDate)
            lib.call("update#" + T, {acctgTransId: p.acctgTransId, accountingDate: out.captureAccountingDate})
    }
    if (!p.verifyOnly && out.enabled && !out.valid) {
        if (out.automatic && out.preference.errorGlJournalId) {
            lib.call("update#" + T, {
                acctgTransId: p.acctgTransId,
                glJournalId: out.preference.errorGlJournalId,
                postingFailureCode: out.findings[0].code,
                postingFailureMessage: out.findings.map(r => r.message).join("; ")
            })
        } else throw new Error(out.findings[0].code + ": " + out.findings.map(r => r.message).join("; "))
    }
    return {
        handled: p.verifyOnly || (out.enabled && !out.valid),
        valid: out.valid,
        findings: out.findings,
        timePeriodList: out.periods.map(map),
        authoritativePeriods: out.authoritativePeriods,
        debitTotal: out.debitTotal,
        creditTotal: out.creditTotal
    }
}
function completed(acctgTransId) {
    const tx = one(T, {acctgTransId})
    if (!tx || preference(tx.organizationPartyId).postingGuardEnabled !== "Y" || tx.isPosted !== "Y") return
    const operationKey = "lp:" + hash(acctgTransId).slice(0, 37),
        entity = "mantle.ledger.transaction.PostingOperation"
    if (!one(entity, {operationKey}))
        lib.call("create#" + entity, {
            operationKey,
            operationType: "LedgerPost",
            organizationPartyId: tx.organizationPartyId,
            userId: ec.user.userId,
            submittedDate: ec.user.nowTimestamp,
            requestHash: hash({
                acctgTransId,
                lines: rows(E, {acctgTransId}).map(map)
            }),
            status: "complete",
            resultEntityName: T,
            resultId: acctgTransId,
            completedDate: ec.user.nowTimestamp
        })
}
;({
    validate,
    check,
    completed,
    fiscal,
    scopes,
    postingLocks,
    calendarDay,
    assertMutable,
    applicationDay,
    controlProof,
    cashTypes,
    applicationTypes,
    PORTAL_PAYMENT
})
