// People's Accounting handoff (mantle.humanres.PayrollRunServices finalize#Run and get#Settlement; IronStone People design §8.1
// PayrollObligation, §8.2 steps 6 and 7, §8.3, §9's payroll route, PayRunDetail's Finalize and Settlement; PE-11; impl-people P27).
//
// Finalization makes an approved run's pay facts and obligations, and no more: draft invoices through Mantle's invoice services,
// never a ledger entry, an approval of a payable or a bank transfer (design §8.3). Posting, approval for payment, payment and
// returns stay Accounting's, read back here as the settlement.
// - It is refused for a group that is not live (liveReasons: no localization, the synthetic demonstration one, coverage missing,
//   Accounting's payroll-origin projection not in place, or the group not enabled for live pay), which is every group of this build:
//   the demonstration localization can never be live (impl-people §4). A spec makes its own live localization.
// - Under locks: the run (no key update, so the units' own transactions may insert the rows that name it), then each employment. The
//   approval must still hold (the run's revision as approved), and every amount it posts must have its account (a term's expense or
//   liability account, the group's localization binding).
// - Each employment in its own transaction: its slip made final (PayrollResults.js finalSlip: Final, not a preview), the inputs its
//   calculation took finalized, and its obligations: its net pay as an invoice from the person (InvoicePayroll: each earning on its
//   term's expense account, each deduction and the localization's employee amount withheld on its liability account; a reimbursement
//   left out), each expense claim it reimburses linked as it is (the claim's own invoice: no second expense, design §9), and an
//   overpayment (a correction whose net is negative) to recover (recoveryOf). A failure leaves that employment pending with its
//   reason and the others go on; a retry finds the obligations made (their unique keys) and makes nothing twice.
// - Once every employment is final, the payee buckets from the final slips alone: the localization's employee and employer amounts as
//   one invoice from the group's localization payee (InvoiceTax, statutory). Then, and only then, the run's invoices are released to
//   Accounting (received) and the run is finalized: an incomplete finalization releases nothing (design §8.2 step 6).
// - An overpayment is recovered (the user's call of Nov 12, 2026): by deductions on the next regular runs (PitOverpaymentRecovery
//   inputs of the employer's recovery component, which prepare#Inputs makes, each at most the employer's cap a period, the rest
//   carried on), or, once the person has left, by a receivable from them through Accounting. Each keyed by its correction slip.
// Pay never leaves its lane: every answer is a payroll reader's (PAYROLL_VIEW) of an employer in their People scope, finalizing a
// payroll editor's (PAYROLL_EDIT); another employer's run is a missing one. Accounting's reads of the invoices made here are
// PAYROLL_VIEW's too (mantle/account/PayrollOrigin.js, AC-23).
const people = ec.resource.script("component://mr-mantle/service/mantle/humanres/People.js")
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const {find, one, rows, denied, call, calendarDateText} = lib
const runs = () => ec.resource.script("component://mr-mantle/service/mantle/humanres/PayrollRuns.js")
const configuration = () => ec.resource.script("component://mr-mantle/service/mantle/humanres/PayrollConfiguration.js")
const slips = () => ec.resource.script("component://mr-mantle/service/mantle/humanres/PayrollResults.js")
const origin = () => ec.resource.script("component://mr-mantle/service/mantle/account/PayrollOrigin.js")

const RUN = "mantle.humanres.payroll.PayrollRun"
const UNIT = "mantle.humanres.payroll.PayrollRunEmployment"
const GROUP = "mantle.humanres.payroll.PayrollGroup"
const LOCALIZATION = "mantle.humanres.payroll.PayrollLocalization"
const TERM = "mantle.humanres.payroll.PayrollComponentTerm"
const COMPONENT = "mantle.humanres.payroll.PayrollComponent"
const RESULT = "mantle.humanres.payroll.PayrollRunResult"
const INPUT = "mantle.humanres.payroll.PayrollInput"
const SOURCE = "mantle.humanres.payroll.PayrollInputSource"
const SLIP = "mantle.humanres.payroll.Payslip"
const ITEM = "mantle.humanres.payroll.PayslipItem"
const OBLIGATION = "mantle.humanres.payroll.PayrollObligation"
const RECOVERY = "mantle.humanres.payroll.PayrollRecovery"
const CLAIM = "mantle.humanres.expense.ExpenseClaim"
const INVOICE = "mantle.account.invoice.Invoice"
const APPLICATION = "mantle.account.payment.PaymentApplication"
const PAYMENT = "mantle.account.payment.Payment"
const RELATIONSHIP = "mantle.party.PartyRelationship"
const PERIOD = "mantle.party.time.TimePeriod"
const SETTING = "mantle.party.PartySetting"

const kindTexts = {
    PokNetPay: "Net pay",
    PokPayee: "Payee",
    PokClaim: "Expense claim settled",
    PokReceivable: "Receivable from the person"
}
const routeTexts = {PrcPayroll: "Deducted from the next regular runs", PrcReceivable: "A receivable from the person"}
const finalSlipStatuses = ["PssFinal", "PssIssued"]

const text = value => String(value ?? "").trim()
const unique = people.unique
const zero = () => toDecimal(0)
const decimalOf = value => (value == null || value === "" ? zero() : toDecimal(value))
const nowMs = () => lib.ms(ec.user.nowTimestamp)
const moneyText = (amount, currencyUomId) =>
    amount == null ? "" : currencyUomId ? ec.l10n.formatCurrency(amount, currencyUomId) : String(amount)
const rowsIn = (entityName, field, ids) => {
    const out = []
    const list = unique(Array.from(ids || []).filter(Boolean))
    for (let index = 0; index < list.length; index += 1000)
        out.push(
            ...Array.from(
                find(entityName)
                    .condition(field, "in", list.slice(index, index + 1000))
                    .list()
            )
        )
    return out
}
const names = value =>
    text(value)
        .split(/[\s,;]+/)
        .filter(Boolean)
// a component reads the reimbursement input: its line pays an expense claim, settled on the claim's own invoice (design §9)
const readsReimbursement = term => names(term?.inputNames).includes("reimbursement")
const dayStamp = dayText => ec.l10n.parseTimestamp(dayText + " 12:00:00", "yyyy-MM-dd HH:mm:ss")

// ===== access =====
function readerScope() {
    const userScope = people.scopeOf()
    if (!userScope.capabilities.payrollView) denied("PERMISSION_DENIED", "Pay runs are not available")
    return userScope
}
function editorScope() {
    const userScope = people.scopeOf()
    if (!(userScope.capabilities.payrollView && userScope.capabilities.payrollEdit))
        denied("PERMISSION_DENIED", "Finalizing a pay run needs PAYROLL_VIEW and PAYROLL_EDIT")
    return userScope
}
function runIn(userScope, payrollRunId) {
    const id = text(payrollRunId)
    const run = id ? one(RUN, {payrollRunId: id}) : null
    if (!run || !userScope.organizationPartyIds.includes(run.organizationPartyId))
        denied("RECORD_UNAVAILABLE", "Pay run " + id + " is not available")
    return run
}

// ===== live readiness =====
// Why a group's runs cannot be finalized, each a reason code and its words: the group's readiness (PayrollConfiguration.js
// groupReadiness: no localization, the demonstration one, coverage, Accounting's projection) and its own live switch. None: live.
function liveReasons(group) {
    const localization = group.payrollLocalizationId
        ? one(LOCALIZATION, {payrollLocalizationId: group.payrollLocalizationId})
        : null
    const readiness = configuration().groupReadiness(group, localization, nowMs())
    const reasons = []
    if (!readiness.liveAllowed) reasons.push({reasonCode: readiness.reasonCode, message: readiness.message})
    if (group.liveEnabled !== "Y")
        reasons.push({
            reasonCode: "LIVE_NOT_ENABLED",
            message: "The pay group is not enabled for live pay, so its runs are previews"
        })
    return reasons
}
function requireLive(group) {
    const reasons = liveReasons(group)
    if (reasons.length)
        denied(
            "NOT_LIVE",
            "This pay group is not live: " + reasons.map(reason => reason.message + " (" + reason.reasonCode + ")").join("; ")
        )
}
// Native finalization and P28's live external results (which make the same payroll invoices) are refused for an organization until
// Accounting's payroll-origin projection is in place (impl-people §4, F30).
function requireProjection(organizationPartyId) {
    if (!origin().inPlace())
        denied(
            "PROJECTION_PENDING",
            "Live payroll waits on Accounting's payroll-origin projection for " + (organizationPartyId || "the organization")
        )
}

// ===== what a slip line posts =====
// A component's term for a line: its own, else the component's published term in effect on the day.
function termFor(row, atMs, terms) {
    if (row.payrollComponentTermId) {
        if (!terms.has(row.payrollComponentTermId))
            terms.set(row.payrollComponentTermId, one(TERM, {payrollComponentTermId: row.payrollComponentTermId}))
        return terms.get(row.payrollComponentTermId)
    }
    if (!row.payrollComponentId) return null
    const key = row.payrollComponentId + "@" + atMs
    if (!terms.has(key))
        terms.set(
            key,
            rows(TERM, {payrollComponentId: row.payrollComponentId, statusId: "PtsPublished"}).find(
                term => (lib.ms(term.fromDate) ?? -Infinity) <= atMs && (lib.ms(term.thruDate) ?? Infinity) > atMs
            ) || null
        )
    return terms.get(key)
}
// What a line of a slip (or a run's result) is for the handoff: on the person's net pay invoice (an earning on its expense account,
// a deduction or the localization's employee amount withheld on its liability account, with its sign), a payee's (the bucket of
// its payee and liability account: the localization's employee and employer amounts, and since the People P27 review a deduction's
// or an employer contribution's whose term names a payee), a reimbursement (settled on the claim's invoice), or nothing posted (a
// statistical value). problem names what is not mapped (ACCOUNT_MAPPING_MISSING): an account, the localization binding, or an
// employer contribution's payee (a contribution owed to no one would be paid nowhere, so a live run waits for its payee).
function lineRole(row, term, group) {
    if (row.inTotals === "N" || row.componentKindEnumId === "PckStatistical") return {role: "none"}
    const name = row.resultName || row.itemName || row.componentCode
    const localization = {
        payeePartyId: group.localizationPayeePartyId || null,
        liabilityGlAccountId: group.localizationLiabilityGlAccountId || null,
        localization: true
    }
    const binding = "the pay group's localization binding (its payee and accounts)"
    if (row.localizationParty === "employee")
        return {
            role: "withheld",
            itemTypeEnumId: "ItemPayrollDeduct",
            sign: -1,
            glAccountId: group.localizationLiabilityGlAccountId || null,
            bucket: Object.assign({part: "withheld", glAccountId: group.localizationLiabilityGlAccountId || null}, localization),
            problem: !group.localizationLiabilityGlAccountId || !group.localizationPayeePartyId ? binding : null
        }
    if (row.localizationParty === "employer")
        return {
            role: "employer",
            bucket: Object.assign({part: "employer", glAccountId: group.localizationExpenseGlAccountId || null}, localization),
            problem:
                !group.localizationExpenseGlAccountId ||
                !group.localizationPayeePartyId ||
                !group.localizationLiabilityGlAccountId
                    ? binding
                    : null
        }
    if (row.componentKindEnumId === "PckEarning") {
        if (readsReimbursement(term)) return {role: "reimbursement"}
        return {
            role: "pay",
            itemTypeEnumId: "ItemPayrollIncome",
            sign: 1,
            glAccountId: term?.expenseGlAccountId || null,
            problem: term?.expenseGlAccountId ? null : name + "'s expense account"
        }
    }
    const payee = term?.payeePartyId
        ? {payeePartyId: term.payeePartyId, liabilityGlAccountId: term.liabilityGlAccountId || null, localization: false}
        : null
    if (row.componentKindEnumId === "PckDeduction")
        return {
            role: "pay",
            itemTypeEnumId: "ItemPayrollDeduct",
            sign: -1,
            glAccountId: term?.liabilityGlAccountId || null,
            bucket: payee ? Object.assign({part: "withheld", glAccountId: term.liabilityGlAccountId || null}, payee) : null,
            problem: term?.liabilityGlAccountId ? null : name + "'s liability account"
        }
    if (row.componentKindEnumId === "PckContribution")
        return {
            role: "employer",
            bucket: payee ? Object.assign({part: "employer", glAccountId: term.expenseGlAccountId || null}, payee) : null,
            problem: !payee
                ? name + "'s payee"
                : !term.expenseGlAccountId || !term.liabilityGlAccountId
                  ? name + "'s expense and liability accounts"
                  : null
        }
    return {role: "none"}
}
// The accounts (and payees) a run's calculated results would post to and do not have, named (ACCOUNT_MAPPING_MISSING before
// anything is made).
function mappingProblems(run, group) {
    const atMs = lib.ms(run.payDate) ?? nowMs()
    const terms = new Map()
    const problems = new Set()
    const calculated = new Set(
        rows(UNIT, {payrollRunId: run.payrollRunId})
            .filter(unit => unit.statusId === "PruCalculated" || unit.statusId === "PruFinalized")
            .map(unit => unit.payrollRunEmploymentId)
    )
    for (const result of rows(RESULT, {payrollRunId: run.payrollRunId})) {
        if (!calculated.has(result.payrollRunEmploymentId) || decimalOf(result.amount).isZero()) continue
        const problem = lineRole(result, termFor(result, atMs, terms), group).problem
        if (problem) problems.add(problem)
    }
    return Array.from(problems)
}

// ===== invoices =====
// An invoice a finalization makes is payroll-origin: marked, so Accounting's reads keep it to PAYROLL_VIEW (PayrollOrigin.js)
function makeInvoice(values, lines, description) {
    const created = call(
        "mantle.account.InvoiceServices.create#Invoice",
        Object.assign({description, payrollOrigin: "Y"}, values)
    )
    for (const line of lines)
        call("mantle.account.InvoiceServices.create#InvoiceItem", {
            invoiceId: created.invoiceId,
            itemTypeEnumId: line.itemTypeEnumId,
            overrideGlAccountId: line.glAccountId,
            amount: line.amount,
            quantity: 1,
            description: line.description
        })
    return created.invoiceId
}
const invoiceTotal = invoiceId => decimalOf(call("mantle.account.InvoiceServices.get#InvoiceTotal", {invoiceId}).invoiceTotal)
function obligation(values) {
    const existing = one(OBLIGATION, {obligationKey: values.obligationKey})
    if (existing) return existing
    call(
        "create#" + OBLIGATION,
        Object.assign({createdDate: ec.user.nowTimestamp, createdByUserId: ec.user.userId || null}, values)
    )
    return one(OBLIGATION, {obligationKey: values.obligationKey})
}
function periodWords(run) {
    const period = one(PERIOD, {timePeriodId: run.timePeriodId})
    return period ? calendarDateText(period.fromDate) + " to " + calendarDateText(period.thruDate) : run.timePeriodId
}

// ===== an employment finalized =====
// The obligations of a final slip: its net pay invoice (the wage net: the slip's net less what it reimburses), the claims it
// reimburses linked as they are, and an overpayment to recover. Refused, leaving the employment pending: a reimbursement line that
// is not the claims' amounts (REIMBURSEMENT_MISMATCH), an invoice whose total is not the wage net (RECONCILE_FAILED), a recovery
// with no recovery component set up (RECOVERY_SETUP_MISSING).
function slipObligations(run, group, slip, taken) {
    const payDay = calendarDateText(run.payDate)
    const atMs = lib.ms(run.payDate) ?? nowMs()
    const terms = new Map()
    const items = rows(ITEM, {payslipId: slip.payslipId})
    const reimbursements = taken.filter(input => input.inputTypeEnumId === "PitReimbursement")
    const reimbursed = reimbursements.reduce((sum, input) => sum.add(decimalOf(input.amount)), zero())
    const lines = []
    let reimbursementLines = zero()
    for (const item of items) {
        const role = lineRole(item, termFor(item, atMs, terms), group)
        if (role.role === "reimbursement") reimbursementLines = reimbursementLines.add(decimalOf(item.amount))
        else if ((role.role === "pay" || role.role === "withheld") && !decimalOf(item.amount).isZero())
            lines.push({
                itemTypeEnumId: role.itemTypeEnumId,
                glAccountId: role.glAccountId,
                amount: decimalOf(item.amount).multiply(toDecimal(role.sign)),
                description: item.itemName || item.componentCode
            })
    }
    if (!reimbursementLines.eq(reimbursed))
        denied(
            "REIMBURSEMENT_MISMATCH",
            "The lines that pay reimbursements (" +
                String(reimbursementLines) +
                ") are not the expense claims taken (" +
                String(reimbursed) +
                "): a component reading the reimbursement input pays it alone"
        )
    const wageNet = decimalOf(slip.netAmount).subtract(reimbursementLines)
    const what = "Pay of " + periodWords(run) + ", pay run " + run.payrollRunId
    const out = []
    if (wageNet.compare(0) > 0) {
        const key = "NET:" + slip.payslipId
        let made = one(OBLIGATION, {obligationKey: key})
        if (!made) {
            const invoiceId = makeInvoice(
                {
                    invoiceTypeEnumId: "InvoicePayroll",
                    fromPartyId: slip.partyId,
                    toPartyId: run.organizationPartyId,
                    invoiceDate: dayStamp(payDay),
                    dueDate: dayStamp(payDay),
                    currencyUomId: run.currencyUomId,
                    partyRelationshipId: slip.partyRelationshipId,
                    timePeriodId: run.timePeriodId
                },
                lines,
                what
            )
            if (!invoiceTotal(invoiceId).eq(wageNet))
                denied("RECONCILE_FAILED", "The net pay invoice does not total the wage net " + String(wageNet))
            made = obligation({
                obligationKey: key,
                obligationKindEnumId: "PokNetPay",
                payrollRunId: run.payrollRunId,
                payslipId: slip.payslipId,
                partyRelationshipId: slip.partyRelationshipId,
                partyId: slip.partyId,
                organizationPartyId: run.organizationPartyId,
                payeePartyId: slip.partyId,
                currencyUomId: run.currencyUomId,
                invoiceId,
                amount: wageNet
            })
        }
        out.push(made)
    } else if (wageNet.compare(0) < 0) out.push(...recoveryOf(run, group, slip, lines, wageNet.negate(), what))
    // each claim reimbursed: its own invoice, linked (design §9: no second expense; a combined payment pays both)
    for (const input of reimbursements) {
        const source = rows(SOURCE, {payrollInputId: input.payrollInputId}).find(row => row.sourceEntityName === CLAIM)
        if (!source) continue
        out.push(
            obligation({
                obligationKey: "CLAIM:" + source.sourceId,
                obligationKindEnumId: "PokClaim",
                payrollRunId: run.payrollRunId,
                payslipId: slip.payslipId,
                partyRelationshipId: slip.partyRelationshipId,
                partyId: slip.partyId,
                organizationPartyId: run.organizationPartyId,
                payeePartyId: slip.partyId,
                currencyUomId: run.currencyUomId,
                invoiceId: source.sourceId,
                amount: decimalOf(input.amount)
            })
        )
    }
    return out
}
// An overpayment to recover (a correction whose wage net is negative; the user's call of Nov 12, 2026), keyed by the correction slip:
// a receivable from the person when they have left (their employment ended by now: no regular run will pay them), each of the slip's
// lines reversed on its own account so the receivable puts back what was paid; else deductions on the next regular runs, of the
// employer's recovery component (PartySetting PayrollRecoveryComponent, a deduction of the employer: RECOVERY_SETUP_MISSING without
// one), which prepare#Inputs makes period by period up to the employer's cap.
function recoveryOf(run, group, slip, lines, amount, what) {
    const existing = one(RECOVERY, {payslipId: slip.payslipId})
    if (existing) return existing.invoiceId ? [one(OBLIGATION, {invoiceId: existing.invoiceId})].filter(Boolean) : []
    const relationship = one(RELATIONSHIP, {partyRelationshipId: slip.partyRelationshipId})
    const left = relationship?.thruDate != null && lib.ms(relationship.thruDate) <= nowMs()
    const base = {
        payslipId: slip.payslipId,
        payrollRunId: run.payrollRunId,
        partyRelationshipId: slip.partyRelationshipId,
        partyId: slip.partyId,
        organizationPartyId: run.organizationPartyId,
        payrollGroupId: run.payrollGroupId,
        currencyUomId: run.currencyUomId,
        amount,
        createdDate: ec.user.nowTimestamp,
        createdByUserId: ec.user.userId || null
    }
    if (left) {
        const payDay = calendarDateText(run.payDate)
        const invoiceId = makeInvoice(
            {
                invoiceTypeEnumId: "InvoicePayroll",
                fromPartyId: run.organizationPartyId,
                toPartyId: slip.partyId,
                invoiceDate: dayStamp(payDay),
                dueDate: dayStamp(payDay),
                currencyUomId: run.currencyUomId,
                partyRelationshipId: slip.partyRelationshipId,
                timePeriodId: run.timePeriodId
            },
            lines.map(line => Object.assign({}, line, {amount: line.amount.negate()})),
            "Overpayment to recover: " + what
        )
        if (!invoiceTotal(invoiceId).eq(amount))
            denied("RECONCILE_FAILED", "The receivable does not total the overpayment " + String(amount))
        call("create#" + RECOVERY, Object.assign({recoveryRouteEnumId: "PrcReceivable", invoiceId}, base))
        return [
            obligation({
                obligationKey: "RECEIVABLE:" + slip.payslipId,
                obligationKindEnumId: "PokReceivable",
                payrollRunId: run.payrollRunId,
                payslipId: slip.payslipId,
                partyRelationshipId: slip.partyRelationshipId,
                partyId: slip.partyId,
                organizationPartyId: run.organizationPartyId,
                payeePartyId: slip.partyId,
                currencyUomId: run.currencyUomId,
                invoiceId,
                amount
            })
        ]
    }
    const setup = recoverySetup(run.organizationPartyId)
    const component = setup.payrollComponentId ? one(COMPONENT, {payrollComponentId: setup.payrollComponentId}) : null
    if (
        !component ||
        component.organizationPartyId !== run.organizationPartyId ||
        component.componentKindEnumId !== "PckDeduction"
    )
        denied(
            "RECOVERY_SETUP_MISSING",
            "An overpayment is recovered through the employer's recovery deduction (its setting PayrollRecoveryComponent), and none is set"
        )
    call(
        "create#" + RECOVERY,
        Object.assign({recoveryRouteEnumId: "PrcPayroll", payrollComponentId: component.payrollComponentId}, base)
    )
    return []
}
// The employer's recovery settings: the deduction recovery inputs are made to, and the most a period recovers (none: the whole
// rest): an amount, a percentage of net pay, or both (the user's calls of Nov 13, 2026; capFor), the percentage read as the share of
// the employee's wage net on their latest finalized regular run (the net a recovery is planned against: a period's own net is not
// known until its run calculates, after its inputs are prepared).
const RECOVERY_SETTINGS = ["PayrollRecoveryComponent", "PayrollRecoveryCap", "PayrollRecoveryCapPercent"]
function recoverySetup(organizationPartyId) {
    const value = id => text(one(SETTING, {partyId: organizationPartyId, partySettingTypeId: id})?.settingValue) || null
    const cap = value("PayrollRecoveryCap")
    const percent = value("PayrollRecoveryCapPercent")
    return {
        payrollComponentId: value("PayrollRecoveryComponent"),
        cap: cap ? toDecimal(cap) : null,
        capPercent: percent ? toDecimal(percent) : null
    }
}
// An employment's wage net on its latest finalized regular run (its net pay obligation), or null.
function lastWageNet(partyRelationshipId) {
    const regular = rows(OBLIGATION, {partyRelationshipId, obligationKindEnumId: "PokNetPay"})
        .map(row => ({row, run: one(RUN, {payrollRunId: row.payrollRunId})}))
        .filter(entry => entry.run?.runKindEnumId === "PrkRegular" && entry.run.statusId === "PrnFinalized")
        .sort((a, b) => (lib.ms(b.run.payDate) ?? 0) - (lib.ms(a.run.payDate) ?? 0))
    return regular.length ? decimalOf(regular[0].row.amount) : null
}
// The cap of a period's recovery for an employment (the user's calls of Nov 13, 2026, impl-people P28): with a percentage, that share of
// its last finalized regular wage net (rounded to the currency), at most the amount when one is set too; with no earlier net to take
// the percentage of, the amount when one is set, else zero (the recovery waits for the period after the employee's first finalized
// regular run, never uncapped). An amount alone is the cap; neither: null, no cap, the whole rest.
function capFor(setup, partyRelationshipId, currencyUomId) {
    const amount = setup.cap && setup.cap.compare(0) > 0 ? setup.cap : null
    if (setup.capPercent && setup.capPercent.compare(0) > 0) {
        const net = lastWageNet(partyRelationshipId)
        if (net == null) return amount || zero()
        const share = ec.l10n.roundCurrency(net.multiply(setup.capPercent).divide(toDecimal(100)), currencyUomId)
        return amount && amount.compare(share) < 0 ? amount : share
    }
    return amount
}

// ===== get#RecoverySettings and store#RecoverySettings (the user's call of Nov 13, 2026) =====
// Each employer of the payroll reader's scope with its overpayment recovery settings: the recovery deduction, and the cap a period
// as an amount, a percentage of net pay or both; the employer's deductions to choose from; whether the user changes them (PAYROLL_VIEW,
// PAYROLL_EDIT and PAYROLL_CONFIGURE) and the revision each change names.
function settingsRevision(organizationPartyId) {
    const stamps = RECOVERY_SETTINGS.map(
        id => lib.ms(one(SETTING, {partyId: organizationPartyId, partySettingTypeId: id})?.lastUpdatedStamp) ?? 0
    )
    return String(Math.max(0, ...stamps))
}
// The cap as a person reads it: a percentage (with the amount beside it, the most a period and what is taken before a first net),
// an amount, or none.
function capText(setup) {
    const amount = setup.cap != null ? String(setup.cap) : null
    if (setup.capPercent != null)
        return (
            String(setup.capPercent) +
            "% of net pay a period" +
            (amount
                ? ", at most " + amount + " (" + amount + " before the employee's first finalized pay)"
                : " (from the period after the employee's first finalized pay)")
        )
    return amount ? amount + " a period" : "No cap: the whole rest on the next run"
}
const configures = caps => !!(caps.payrollView && caps.payrollEdit && caps.payrollConfigure)
function getRecoverySettings(p) {
    const userScope = readerScope()
    const organizationPartyIds = text(p.organizationPartyId)
        ? (people.requireOrganization(userScope, text(p.organizationPartyId)), [text(p.organizationPartyId)])
        : userScope.organizationPartyIds
    const names = people.organizationNames(organizationPartyIds)
    const employers = organizationPartyIds
        .map(organizationPartyId => {
            const setup = recoverySetup(organizationPartyId)
            const deductions = rows(COMPONENT, {organizationPartyId, componentKindEnumId: "PckDeduction"})
                .filter(row => !row.thruDate || (lib.ms(row.thruDate) ?? Infinity) > nowMs())
                .map(row => ({
                    value: row.payrollComponentId,
                    label: (row.componentName || row.componentCode) + " (" + row.componentCode + ")"
                }))
                .sort((a, b) => a.label.localeCompare(b.label))
            const component = setup.payrollComponentId ? one(COMPONENT, {payrollComponentId: setup.payrollComponentId}) : null
            return {
                organizationPartyId,
                organizationName: names[organizationPartyId] || organizationPartyId,
                payrollComponentId: setup.payrollComponentId,
                componentText: component ? component.componentName || component.componentCode : "",
                capAmount: setup.cap == null ? null : String(setup.cap),
                capPercent: setup.capPercent == null ? null : String(setup.capPercent),
                capText: capText(setup),
                deductions,
                revision: settingsRevision(organizationPartyId)
            }
        })
        .sort((a, b) => a.organizationName.localeCompare(b.organizationName))
    return {employers, canEdit: configures(userScope.capabilities)}
}
// An employer's recovery settings changed at the revision read (PAYROLL_VIEW, PAYROLL_EDIT and PAYROLL_CONFIGURE): the recovery
// deduction (one of the employer's deductions) and the cap: an amount (above 0), a percentage of net pay (above 0, at most 100), or
// both (the percentage at most the amount, which is taken before the employee's first finalized pay: the user's call of Nov 13, 2026,
// impl-people P28); an empty value clears it (its setting kept, empty, so the change is in the setting's audit log).
function storeRecoverySettings(p) {
    const userScope = people.scopeOf()
    if (!configures(userScope.capabilities))
        denied("PERMISSION_DENIED", "Changing the overpayment recovery needs PAYROLL_EDIT and PAYROLL_CONFIGURE")
    const organizationPartyId = text(p.organizationPartyId)
    if (!organizationPartyId) denied("ORGANIZATION_REQUIRED", "Choose the employer")
    people.requireOrganization(userScope, organizationPartyId)
    const revision = settingsRevision(organizationPartyId)
    if (text(p.expectedRevision) !== revision)
        denied(
            "REVISION_CHANGED",
            "The recovery settings changed since you read them; open them again (revision " + revision + ")"
        )
    const payrollComponentId = text(p.payrollComponentId) || null
    if (payrollComponentId) {
        const component = one(COMPONENT, {payrollComponentId})
        if (
            !component ||
            component.organizationPartyId !== organizationPartyId ||
            component.componentKindEnumId !== "PckDeduction"
        )
            denied("COMPONENT_INVALID", "The recovery is made through one of the employer's deductions")
    }
    const number = (value, label) => {
        if (value == null || text(value) === "") return null
        if (!/^[0-9]+(\.[0-9]+)?$/.test(text(value))) denied("CAP_INVALID", label + " is a positive number")
        return toDecimal(text(value))
    }
    const capAmount = number(p.capAmount, "The cap")
    const capPercent = number(p.capPercent, "The percentage")
    if (capAmount && capAmount.compare(0) <= 0) denied("CAP_INVALID", "The cap is above zero")
    if (capPercent && (capPercent.compare(0) <= 0 || capPercent.compare(100) > 0))
        denied("CAP_INVALID", "The percentage is above 0 and at most 100")
    const values = {
        PayrollRecoveryComponent: payrollComponentId,
        PayrollRecoveryCap: capAmount == null ? null : String(capAmount),
        PayrollRecoveryCapPercent: capPercent == null ? null : String(capPercent)
    }
    for (const [partySettingTypeId, settingValue] of Object.entries(values)) {
        const existing = one(SETTING, {partyId: organizationPartyId, partySettingTypeId})
        if (existing) {
            if ((text(existing.settingValue) || null) !== settingValue)
                call("update#" + SETTING, {partyId: organizationPartyId, partySettingTypeId, settingValue})
        } else if (settingValue != null)
            call("create#" + SETTING, {partyId: organizationPartyId, partySettingTypeId, settingValue})
    }
    return {organizationPartyId, revision: settingsRevision(organizationPartyId)}
}

// One employment finalized, in the caller's (new) transaction under its lock: its slip final, its inputs finalized, its obligations.
function finalizeUnit(run, group, unitId) {
    let unit = one(UNIT, {payrollRunEmploymentId: unitId})
    find(RELATIONSHIP, {partyRelationshipId: unit.partyRelationshipId}).forUpdate(true).one()
    unit = one(UNIT, {payrollRunEmploymentId: unitId})
    if (unit.statusId === "PruFinalized") return "done"
    if (unit.statusId !== "PruCalculated") return "skipped"
    if (!runs().unitHolds(run, unitId, unit.sourceRevision))
        denied("SOURCE_CHANGED", "The employee's pay sources changed since the run was approved")
    const slip = slips().finalSlip(run, unit)
    const taken = rows(INPUT, {payrollRunId: run.payrollRunId, partyRelationshipId: unit.partyRelationshipId}).filter(
        input => input.statusId === "PinApproved"
    )
    slipObligations(run, group, slip, taken)
    for (const input of taken)
        call("update#" + INPUT, {
            payrollInputId: input.payrollInputId,
            statusId: "PinFinalized",
            statusId_changeReason: "Pay run " + run.payrollRunId + " finalized"
        })
    call("update#" + UNIT, {
        payrollRunEmploymentId: unitId,
        statusId: "PruFinalized",
        finalizedDate: ec.user.nowTimestamp,
        reasonCode: null,
        message: null
    })
    return "finalized"
}
// The payee buckets of a run whose employments are all final, from its final slips alone (design §8.3: third-party obligations only
// for a configured payee): for each payee and liability account (the localization's binding; since the People P27 review, a
// deduction's or an employer contribution's payee, the user's call of Nov 13, 2026), the amounts withheld (on the liability account,
// so paying them does not expense the wages twice) and the employer's (on their expense account, so an employer contribution is
// posted with the run's invoices), one invoice from the payee: the localization's statutory (InvoiceTax), any other a payroll
// invoice. A bucket that nets to nothing or less (a correction lowering it) makes no invoice and says so.
function payeeBuckets(run, group) {
    const atMs = lib.ms(run.payDate) ?? nowMs()
    const terms = new Map()
    const slipIds = rows(SLIP, {payrollRunId: run.payrollRunId})
        .filter(slip => finalSlipStatuses.includes(slip.statusId))
        .map(slip => slip.payslipId)
    const buckets = new Map()
    for (const item of rowsIn(ITEM, "payslipId", slipIds)) {
        if (decimalOf(item.amount).isZero()) continue
        const bucket = lineRole(item, termFor(item, atMs, terms), group).bucket
        if (!bucket?.payeePartyId) continue
        const key = bucket.payeePartyId + ":" + (bucket.liabilityGlAccountId || "")
        const entry = buckets.get(key) || {
            key,
            payeePartyId: bucket.payeePartyId,
            liabilityGlAccountId: bucket.liabilityGlAccountId,
            localization: bucket.localization,
            lines: new Map()
        }
        entry.localization = entry.localization || bucket.localization
        const lineKey = bucket.part + ":" + (bucket.glAccountId || "")
        const line = entry.lines.get(lineKey) || {part: bucket.part, glAccountId: bucket.glAccountId, amount: zero()}
        line.amount = line.amount.add(decimalOf(item.amount))
        entry.lines.set(lineKey, line)
        buckets.set(key, entry)
    }
    return Array.from(buckets.values()).sort((a, b) => a.key.localeCompare(b.key))
}
// One payee bucket's invoice and obligation, once (its key: the run, the payee and the liability account); a note when it nets to
// nothing or less.
function payeeBucket(run, bucket) {
    const lines = Array.from(bucket.lines.values()).filter(line => !line.amount.isZero())
    const amount = lines.reduce((sum, line) => sum.add(line.amount), zero())
    const payeeName = lib.partyNames([bucket.payeePartyId])[bucket.payeePartyId] || bucket.payeePartyId
    if (amount.compare(0) <= 0)
        return {note: payeeName + "'s amounts of this run net to " + String(amount) + ": no payee invoice"}
    const key = "PAYEE:" + run.payrollRunId + ":" + bucket.key
    const existing = one(OBLIGATION, {obligationKey: key})
    if (existing) return {obligation: existing}
    const payDay = calendarDateText(run.payDate)
    const invoiceId = makeInvoice(
        {
            invoiceTypeEnumId: bucket.localization ? "InvoiceTax" : "InvoicePayroll",
            fromPartyId: bucket.payeePartyId,
            toPartyId: run.organizationPartyId,
            invoiceDate: dayStamp(payDay),
            dueDate: dayStamp(payDay),
            currencyUomId: run.currencyUomId,
            timePeriodId: run.timePeriodId
        },
        lines
            .sort((a, b) =>
                a.part === b.part ? String(a.glAccountId).localeCompare(String(b.glAccountId)) : a.part === "withheld" ? -1 : 1
            )
            .map(line => ({
                itemTypeEnumId: "ItemPayrollDeduct",
                glAccountId: line.glAccountId,
                amount: line.amount,
                description: line.part === "withheld" ? "Withheld from employees" : "Employer amounts"
            })),
        "Payroll amounts of " + periodWords(run) + ", pay run " + run.payrollRunId
    )
    if (!invoiceTotal(invoiceId).eq(amount)) denied("RECONCILE_FAILED", "The payee invoice does not total " + String(amount))
    return {
        obligation: obligation({
            obligationKey: key,
            obligationKindEnumId: "PokPayee",
            payrollRunId: run.payrollRunId,
            organizationPartyId: run.organizationPartyId,
            payeePartyId: bucket.payeePartyId,
            currencyUomId: run.currencyUomId,
            invoiceId,
            amount
        })
    }
}

// ===== finalize#Run =====
// An approved run of a live group finalized (PAYROLL_VIEW and PAYROLL_EDIT): the approval still holding, every amount's account
// mapped, then each employment in its own transaction, the payee buckets, and the release; or, run again, the rest of a pending one.
function finalizeRun(p) {
    const userScope = editorScope()
    const payrollRunId = runIn(userScope, p.payrollRunId).payrollRunId
    // Each step commits in a transaction of its own, under its lock (the People P27 review; the service itself holds none): the
    // checks and the move to Finalizing first, so a Finalizing run never rolls back to Approved behind an employment made final (a
    // timeout or a failed release did, and its revision, which counts the employments' states, was then no longer the approved one:
    // the run could never be finalized); each employment; each payee bucket; then the release and Finalized together, under the
    // run's lock again; then the statements. A retry of a Finalizing run, or one made at the same time, finishes the rest: what is
    // made is found by its key, and an employment or a run already final is left as it is.
    let refusal = null
    ec.transaction.runRequireNew(null, "Starting the finalization of pay run " + payrollRunId + " failed", () => {
        try {
            begin(payrollRunId)
        } catch (error) {
            if (!lib.reasonCode(error)) throw error
            refusal = error
        }
    })
    if (refusal) throw refusal
    const run = one(RUN, {payrollRunId})
    if (run.statusId === "PrnFinalized") return Object.assign(answer(run, true), issueStatements(run))
    if (run.statusId !== "PrnFinalizing") denied("NOT_APPROVED", "Only an approved pay run is finalized")
    const group = one(GROUP, {payrollGroupId: run.payrollGroupId})
    const units = rows(UNIT, {payrollRunId: run.payrollRunId}).filter(unit => unit.statusId === "PruCalculated")
    let finalizedCount = 0
    for (const unit of units) {
        let outcome = "failed"
        ec.message.pushErrors()
        try {
            ec.transaction.runRequireNew(null, "Finalizing the pay of " + unit.partyRelationshipId + " failed", () => {
                outcome = finalizeUnit(run, group, unit.payrollRunEmploymentId)
                if (ec.message.hasError()) throw new Error(ec.message.getErrorsString())
            })
        } catch (error) {
            const reasonCode = lib.reasonCode(error) || "FAILED"
            const message = String(error?.message || error).replace(/^[A-Z][A-Z0-9_]+: /, "")
            if (!lib.reasonCode(error))
                ec.logger.error("Finalizing the pay of " + unit.partyRelationshipId + " failed: " + message)
            ec.message.clearErrors()
            try {
                ec.transaction.runRequireNew(null, "Recording a finalization's error failed", () =>
                    call("update#" + UNIT, {payrollRunEmploymentId: unit.payrollRunEmploymentId, reasonCode, message})
                )
            } catch (inner) {
                ec.logger.error("The error of pay unit " + unit.payrollRunEmploymentId + " was not recorded: " + inner.message)
            }
        } finally {
            ec.message.clearErrors()
            ec.message.popErrors()
        }
        if (outcome === "finalized") finalizedCount++
    }
    const pending = rows(UNIT, {payrollRunId: run.payrollRunId}).filter(unit => unit.statusId === "PruCalculated")
    let note = null
    let payeeFailed = false
    if (!pending.length) {
        // the payee buckets from the final slips alone, each in its own transaction (one that fails leaves the run finalizing and
        // the others made), then the release
        const notes = []
        for (const bucket of payeeBuckets(run, group)) {
            ec.message.pushErrors()
            try {
                ec.transaction.runRequireNew(
                    null,
                    "Finalizing the payee amounts of pay run " + run.payrollRunId + " failed",
                    () => {
                        const made = payeeBucket(run, bucket)
                        if (made?.note) notes.push(made.note)
                        if (ec.message.hasError()) throw new Error(ec.message.getErrorsString())
                    }
                )
            } catch (error) {
                payeeFailed = true
                if (!lib.reasonCode(error))
                    ec.logger.error("A payee bucket of pay run " + run.payrollRunId + " failed: " + error.message)
                notes.push(
                    "The payee amounts were not made: " + String(error?.message || error).replace(/^[A-Z][A-Z0-9_]+: /, "")
                )
            } finally {
                ec.message.clearErrors()
                ec.message.popErrors()
            }
        }
        note = notes.join("; ") || null
    }
    const complete = !pending.length && !payeeFailed
    ec.transaction.runRequireNew(null, "Completing the finalization of pay run " + run.payrollRunId + " failed", () =>
        end(run.payrollRunId, complete, pending, note)
    )
    // each final slip's statement issued once the finalization is complete (the user's call of Nov 13, 2026)
    const issued =
        one(RUN, {payrollRunId: run.payrollRunId}).statusId === "PrnFinalized"
            ? issueStatements(run)
            : {issuedCount: 0, issueFailedCount: 0}
    return Object.assign(answer(one(RUN, {payrollRunId: run.payrollRunId}), false), issued, {
        finalizedCount,
        failedCount: pending.length
    })
}
// The statements of a finalized run's final slips issued (the user's call of Nov 13, 2026: PayrollResults.js issue#Payslip, the
// stored PDF and the person's direct-only PayslipIssued notice), each in its own transaction: one that fails is logged and counted,
// its slip stays final for PayslipDetail's Issue statement or a Finalize again, and the others go on. A slip issued already is left.
function issueStatements(run) {
    const out = {issuedCount: 0, issueFailedCount: 0}
    const finals = rows(SLIP, {payrollRunId: run.payrollRunId}).filter(slip => slip.statusId === "PssFinal")
    for (const slip of finals) {
        ec.message.pushErrors()
        try {
            ec.transaction.runRequireNew(null, "Issuing payslip " + slip.payslipId + " failed", () => {
                const issued = call("mantle.humanres.PayrollResultServices.issue#Payslip", {payslipId: slip.payslipId})
                if (ec.message.hasError()) throw new Error(ec.message.getErrorsString())
                if (!issued.repeated) out.issuedCount++
            })
        } catch (error) {
            out.issueFailedCount++
            ec.logger.error(
                "Issuing payslip " + slip.payslipId + " of pay run " + run.payrollRunId + " failed: " + (error?.message || error)
            )
        } finally {
            ec.message.clearErrors()
            ec.message.popErrors()
        }
    }
    return out
}
// A finalization's end, in its own transaction under the run's lock: complete, the run's invoices released to Accounting and the run
// Finalized together; else why it is pending. A run another call finalized meanwhile is left as it is.
function end(payrollRunId, complete, pending, note) {
    const run = find(RUN, {payrollRunId}).forNoKeyUpdate(true).one()
    if (run.statusId !== "PrnFinalizing") return
    if (complete) {
        release(run)
        call("update#" + RUN, {
            payrollRunId,
            statusId: "PrnFinalized",
            finalizedDate: ec.user.nowTimestamp,
            finalizedByUserId: ec.user.userId || null,
            finalizeMessage: note
        })
    } else
        call("update#" + RUN, {
            payrollRunId,
            finalizeMessage: pending.length
                ? pending.length +
                  (pending.length === 1 ? " employee is" : " employees are") +
                  " not finalized yet (" +
                  unique(pending.map(unit => unit.reasonCode).filter(Boolean)).join(", ") +
                  "): fix and finalize again; nothing is released to Accounting until every employee is"
                : note
        })
}
// A finalization begun, in its own transaction under the run's lock: a finalized run is left as it is; else the run must be approved
// (or finalizing, a retry) and its group live, and an approved one must still hold its approval and have every account mapped, then
// it is Finalizing. A refusal changes nothing.
function begin(payrollRunId) {
    const run = find(RUN, {payrollRunId}).forNoKeyUpdate(true).one()
    if (run.statusId === "PrnFinalized") return
    if (!["PrnApproved", "PrnFinalizing"].includes(run.statusId)) denied("NOT_APPROVED", "Only an approved pay run is finalized")
    const group = one(GROUP, {payrollGroupId: run.payrollGroupId})
    requireLive(group)
    requireProjection(run.organizationPartyId)
    if (run.statusId !== "PrnApproved") return
    if (run.approvedRevision !== runs().runRevision(run.payrollRunId))
        denied("APPROVAL_NO_LONGER_HOLDS", "The run changed since it was approved: calculate it and ask for approval again")
    const missing = mappingProblems(run, group)
    if (missing.length) denied("ACCOUNT_MAPPING_MISSING", "Map the accounts before finalizing: " + missing.join(", "))
    call("update#" + RUN, {payrollRunId: run.payrollRunId, statusId: "PrnFinalizing", finalizeMessage: null})
}
// The run's invoices released to Accounting: a payable made received (Accounting reviews, approves and pays it), a receivable left
// in process for Accounting to finalize.
function release(run) {
    for (const row of rows(OBLIGATION, {payrollRunId: run.payrollRunId})) {
        if (!row.invoiceId || row.obligationKindEnumId === "PokClaim") continue
        const invoice = one(INVOICE, {invoiceId: row.invoiceId})
        if (invoice?.statusId === "InvoiceIncoming")
            call("update#" + INVOICE, {
                invoiceId: row.invoiceId,
                statusId: "InvoiceReceived",
                statusId_changeReason: "Pay run " + run.payrollRunId + " finalized"
            })
    }
}
function answer(run, repeated) {
    return {
        payrollRunId: run.payrollRunId,
        statusId: run.statusId,
        complete: run.statusId === "PrnFinalized",
        obligationCount: rows(OBLIGATION, {payrollRunId: run.payrollRunId}).length,
        message: run.finalizeMessage || "",
        repeated
    }
}

// ===== get#Settlement =====
// What Accounting did with a run's obligations (design §8.2 step 7), as payroll reads it: each obligation's invoice, its state and
// posting, what is paid and unpaid, the payments applied and their states (a returned one shown as such); for each person their wage
// net, the reimbursement still due on their claims and the total payment instruction (design §9: a combined payment pays both);
// the overpayments to recover with what remains; and why a finalization is still pending.
function getSettlement(p) {
    const userScope = readerScope()
    const run = runIn(userScope, p.payrollRunId)
    const obligations = rows(OBLIGATION, {payrollRunId: run.payrollRunId})
    const invoiceIds = obligations.map(row => row.invoiceId).filter(Boolean)
    const invoices = Object.fromEntries(rowsIn(INVOICE, "invoiceId", invoiceIds).map(row => [row.invoiceId, row]))
    const applications = rowsIn(APPLICATION, "invoiceId", invoiceIds).filter(row => row.paymentId)
    const payments = Object.fromEntries(
        rowsIn(
            PAYMENT,
            "paymentId",
            applications.map(row => row.paymentId)
        ).map(row => [row.paymentId, row])
    )
    const statusTexts = Object.fromEntries(
        rowsIn(
            "moqui.basic.StatusItem",
            "statusId",
            Object.values(invoices)
                .map(row => row.statusId)
                .concat(Object.values(payments).map(row => row.statusId))
        ).map(row => [row.statusId, row.description])
    )
    const posted = new Set(
        invoiceIds.length
            ? rowsIn("mantle.ledger.transaction.AcctgTrans", "invoiceId", invoiceIds)
                  .filter(row => row.isPosted === "Y")
                  .map(row => row.invoiceId)
            : []
    )
    const partyNames = lib.partyNames(
        unique(obligations.map(row => row.payeePartyId).concat(obligations.map(row => row.partyId)))
    )
    const currencyUomId = run.currencyUomId
    const obligationRows = obligations
        .map(row => {
            const invoice = invoices[row.invoiceId] || null
            const paid = applications.filter(app => app.invoiceId === row.invoiceId)
            const paymentTexts = paid.map(app => {
                const payment = payments[app.paymentId]
                return (
                    app.paymentId +
                    " " +
                    moneyText(app.amountApplied, currencyUomId) +
                    (payment ? " " + (statusTexts[payment.statusId] || payment.statusId).toLowerCase() : "")
                )
            })
            const unpaid = invoice ? decimalOf(invoice.unpaidTotal ?? invoice.invoiceTotal) : null
            return {
                payrollObligationId: row.payrollObligationId,
                obligationKindEnumId: row.obligationKindEnumId,
                kindText: kindTexts[row.obligationKindEnumId] || row.obligationKindEnumId,
                partyId: row.partyId || null,
                payeeName: partyNames[row.payeePartyId] || row.payeePartyId || "",
                personName: row.partyId ? partyNames[row.partyId] || row.partyId : "",
                amountText: moneyText(row.amount, row.currencyUomId),
                invoiceId: row.invoiceId || null,
                invoiceStateText: invoice ? statusTexts[invoice.statusId] || invoice.statusId : "",
                postedText: !invoice ? "" : posted.has(row.invoiceId) ? "Posted" : "Not posted",
                unpaidText: unpaid == null ? "" : moneyText(unpaid, currencyUomId),
                paymentsText: paymentTexts.join("; "),
                returned: paid.some(app =>
                    ["PmntReturned", "PmntVoid", "PmntCancelled"].includes(payments[app.paymentId]?.statusId)
                ),
                settled: !!invoice && unpaid != null && unpaid.compare(0) <= 0
            }
        })
        .sort((a, b) => String(a.personName).localeCompare(String(b.personName)) || a.kindText.localeCompare(b.kindText))
    // per person: wage net, reimbursement due, the total payment instruction
    const byPerson = {}
    for (const row of obligations) {
        if (!row.partyId || row.obligationKindEnumId === "PokReceivable") continue
        const entry = (byPerson[row.partyId] ||= {partyId: row.partyId, wageNet: zero(), reimbursementDue: zero(), paid: zero()})
        const invoice = invoices[row.invoiceId]
        const unpaid = invoice ? decimalOf(invoice.unpaidTotal ?? invoice.invoiceTotal) : zero()
        if (row.obligationKindEnumId === "PokNetPay") entry.wageNet = entry.wageNet.add(decimalOf(row.amount))
        if (row.obligationKindEnumId === "PokClaim") entry.reimbursementDue = entry.reimbursementDue.add(unpaid)
        if (row.obligationKindEnumId === "PokNetPay") entry.netUnpaid = (entry.netUnpaid || zero()).add(unpaid)
    }
    const personRows = Object.values(byPerson)
        .map(entry => ({
            partyId: entry.partyId,
            personName: partyNames[entry.partyId] || entry.partyId,
            wageNetText: moneyText(entry.wageNet, currencyUomId),
            reimbursementDueText: moneyText(entry.reimbursementDue, currencyUomId),
            instructionText: moneyText((entry.netUnpaid || zero()).add(entry.reimbursementDue), currencyUomId)
        }))
        .sort((a, b) => String(a.personName).localeCompare(String(b.personName)))
    const recoveryRows = rows(RECOVERY, {payrollRunId: run.payrollRunId}).map(row => recoveryRow(row, partyNames))
    const failed = rows(UNIT, {payrollRunId: run.payrollRunId}).filter(
        unit => unit.statusId === "PruCalculated" && unit.reasonCode
    )
    return {
        payrollRunId: run.payrollRunId,
        statusId: run.statusId,
        complete: run.statusId === "PrnFinalized",
        finalizedDateText: lib.dateText(run.finalizedDate),
        pendingText: run.statusId === "PrnFinalizing" ? run.finalizeMessage || "Finalizing" : run.finalizeMessage || "",
        failedCount: failed.length,
        obligations: obligationRows,
        people: personRows,
        recoveries: recoveryRows
    }
}
// An overpayment's state: what is to be recovered, what finalized recovery inputs (or the receivable's payments) recovered, what is
// left, and the route.
function recoveryState(recovery) {
    let recovered = zero()
    if (recovery.recoveryRouteEnumId === "PrcReceivable" && recovery.invoiceId) {
        const invoice = one(INVOICE, {invoiceId: recovery.invoiceId})
        recovered = decimalOf(recovery.amount).subtract(decimalOf(invoice?.unpaidTotal ?? recovery.amount))
    } else {
        const inputIds = rows(SOURCE, {sourceEntityName: RECOVERY, sourceId: recovery.payrollRecoveryId}).map(
            row => row.payrollInputId
        )
        recovered = rowsIn(INPUT, "payrollInputId", inputIds)
            .filter(input => input.statusId === "PinFinalized")
            .reduce((sum, input) => sum.add(decimalOf(input.amount)), zero())
    }
    const remaining = decimalOf(recovery.amount).subtract(recovered)
    return {recovered, remaining: remaining.compare(0) > 0 ? remaining : zero()}
}
function recoveryRow(recovery, partyNames = null) {
    const state = recoveryState(recovery)
    const namesOf = partyNames || lib.partyNames([recovery.partyId])
    return {
        payrollRecoveryId: recovery.payrollRecoveryId,
        payslipId: recovery.payslipId,
        personName: namesOf[recovery.partyId] || recovery.partyId,
        routeText: routeTexts[recovery.recoveryRouteEnumId] || recovery.recoveryRouteEnumId,
        amountText: moneyText(recovery.amount, recovery.currencyUomId),
        recoveredText: moneyText(state.recovered, recovery.currencyUomId),
        remainingText: moneyText(state.remaining, recovery.currencyUomId),
        invoiceId: recovery.invoiceId || null,
        recovered: state.remaining.isZero()
    }
}

// ===== get#Obligation =====
// An invoice a run's obligation names (one its finalization made, or an expense claim it settled), as payroll reads it on People's
// InvoiceDetail (design §13 InvoiceDetail, payroll's branch): a payroll reader of the employer (PAYROLL_VIEW), never anyone else
// (RECORD_UNAVAILABLE, as an invoice no obligation names): the obligation (its kind, run, slip and person), the invoice's header,
// state and posting, its lines with their accounts, and the payments applied. Read and reconcile only: Accounting changes it.
function getObligation(p) {
    const userScope = readerScope()
    const invoiceId = text(p.invoiceId)
    const row = invoiceId ? one(OBLIGATION, {invoiceId}) : null
    if (!row || !userScope.organizationPartyIds.includes(row.organizationPartyId))
        denied("RECORD_UNAVAILABLE", "Invoice " + invoiceId + " is no pay obligation you read")
    const invoice = one(INVOICE, {invoiceId})
    const currencyUomId = invoice?.currencyUomId || row.currencyUomId
    const status = invoice ? one("moqui.basic.StatusItem", {statusId: invoice.statusId}) : null
    const posted = invoice
        ? rows("mantle.ledger.transaction.AcctgTrans", {invoiceId}).some(trans => trans.isPosted === "Y")
        : false
    const partyNames = lib.partyNames(unique([row.partyId, row.payeePartyId, invoice?.fromPartyId, invoice?.toPartyId]))
    const accountNames = {}
    const lines = rows("mantle.account.invoice.InvoiceItem", {invoiceId}).map(item => {
        const glAccountId = item.overrideGlAccountId || null
        if (glAccountId && !(glAccountId in accountNames))
            accountNames[glAccountId] = one("mantle.ledger.account.GlAccount", {glAccountId})?.accountName || glAccountId
        return {
            invoiceItemSeqId: item.invoiceItemSeqId,
            description: item.description || "",
            accountText: glAccountId ? glAccountId + " " + accountNames[glAccountId] : "",
            amountText: moneyText(decimalOf(item.amount).multiply(decimalOf(item.quantity ?? 1)), currencyUomId)
        }
    })
    const applications = rows(APPLICATION, {invoiceId})
    const payments = Object.fromEntries(
        rowsIn(
            PAYMENT,
            "paymentId",
            applications.map(app => app.paymentId)
        ).map(payment => [payment.paymentId, payment])
    )
    const paymentRows = applications.map(app => {
        const payment = app.paymentId ? payments[app.paymentId] : null
        return {
            paymentId: app.paymentId || null,
            appliedText: app.paymentId
                ? "Payment " +
                  app.paymentId +
                  (payment
                      ? " (" +
                        (one("moqui.basic.StatusItem", {statusId: payment.statusId})?.description || payment.statusId) +
                        ")"
                      : "")
                : "Credit " + (app.invoiceId === invoiceId ? app.toInvoiceId || "" : app.invoiceId || ""),
            appliedDateText: lib.dateText(app.appliedDate),
            amountText: moneyText(app.amountApplied, currencyUomId)
        }
    })
    const slip = row.payslipId ? one(SLIP, {payslipId: row.payslipId}) : null
    return {
        obligation: {
            payrollObligationId: row.payrollObligationId,
            kindText: kindTexts[row.obligationKindEnumId] || row.obligationKindEnumId,
            obligationKindEnumId: row.obligationKindEnumId,
            payrollRunId: row.payrollRunId,
            payslipId: slip ? slip.payslipId : null,
            personName: row.partyId ? partyNames[row.partyId] || row.partyId : "",
            payeeName: partyNames[row.payeePartyId] || row.payeePartyId || "",
            amountText: moneyText(row.amount, row.currencyUomId),
            periodText: periodWords(one(RUN, {payrollRunId: row.payrollRunId}) || {timePeriodId: ""})
        },
        invoice: invoice
            ? {
                  invoiceId,
                  fromName: partyNames[invoice.fromPartyId] || invoice.fromPartyId,
                  toName: partyNames[invoice.toPartyId] || invoice.toPartyId,
                  invoiceDateText: calendarDateText(invoice.accountingDate || invoice.invoiceDate),
                  dueDateText: invoice.dueDate ? calendarDateText(invoice.dueDate) : "",
                  statusText: status?.description || invoice.statusId,
                  postedText: posted ? "Posted" : "Not posted",
                  totalText: moneyText(invoice.invoiceTotal, currencyUomId),
                  unpaidText: moneyText(invoice.unpaidTotal ?? invoice.invoiceTotal, currencyUomId)
              }
            : null,
        lines,
        payments: paymentRows
    }
}

// ===== for other modules =====
// A slip's overpayment, for its reader (PayrollResults.js get#Payslip): what remains to recover and how, or null.
function slipRecovery(payslipId) {
    const recovery = payslipId ? one(RECOVERY, {payslipId}) : null
    return recovery ? recoveryRow(recovery) : null
}
// A slip's obligations, for its payroll reader: each its kind, invoice and amount.
function slipObligationRows(payslipId) {
    return rows(OBLIGATION, {payslipId}).map(row => ({
        kindText: kindTexts[row.obligationKindEnumId] || row.obligationKindEnumId,
        invoiceId: row.invoiceId || null,
        amountText: moneyText(row.amount, row.currencyUomId)
    }))
}
// The overpayment recovery inputs a period of the employment's group makes (PayInputs.js planOf): for each recovery on the payroll
// route with something left, at most the employer's cap less what other periods' live inputs of it hold, in the group's currency,
// keyed by the recovery and the period (so it is made once a period, and a period's own input is kept or made again).
function recoveryInputs(member, group, period) {
    const out = []
    const open = rows(RECOVERY, {partyRelationshipId: member.partyRelationshipId, recoveryRouteEnumId: "PrcPayroll"})
    for (const recovery of open) {
        if (recovery.currencyUomId !== group.currencyUomId) continue
        const state = recoveryState(recovery)
        if (state.remaining.compare(0) <= 0) continue
        const sources = rows(SOURCE, {sourceEntityName: RECOVERY, sourceId: recovery.payrollRecoveryId}).filter(
            row => row.activeSourceKey
        )
        const elsewhere = rowsIn(
            INPUT,
            "payrollInputId",
            sources.map(row => row.payrollInputId)
        ).filter(input => input.statusId !== "PinFinalized" && input.timePeriodId !== period.timePeriodId)
        let left = elsewhere.reduce((sum, input) => sum.subtract(decimalOf(input.amount)), state.remaining)
        if (left.compare(0) <= 0) continue
        const cap = capFor(recoverySetup(recovery.organizationPartyId), member.partyRelationshipId, recovery.currencyUomId)
        if (cap != null && left.compare(cap) > 0) left = cap
        // a percentage cap with no earlier net waits a period (P28's call): no input this period
        if (left.compare(0) <= 0) continue
        const key = "RECOVERY:" + recovery.payrollRecoveryId + ":" + period.timePeriodId
        out.push({
            entitlementKey: key,
            inputTypeEnumId: "PitOverpaymentRecovery",
            inputDate: period.thruDay,
            payrollComponentId: recovery.payrollComponentId,
            amount: left,
            currencyUomId: recovery.currencyUomId,
            deferred: false,
            sources: [
                {
                    sourceEntityName: RECOVERY,
                    sourceId: recovery.payrollRecoveryId,
                    sourcePart: period.timePeriodId,
                    sourceKey: key,
                    amount: left,
                    sourceRevision: String(left)
                }
            ]
        })
    }
    return out
}
// Accounting's guard (InvoiceWorkflow.js issue, so approve#Payable and change#InvoiceState; PaymentRuns.js): an invoice a payroll
// obligation names (made by a finalization, or an expense claim it settles) is approved, finalized or paid only once its run's
// finalization is complete (PAYROLL_NOT_FINALIZED). Answers the obligation, or null for an invoice that is no payroll obligation's.
function approvalCheck(invoiceId) {
    const row = invoiceId ? one(OBLIGATION, {invoiceId}) : null
    if (!row) return null
    const run = one(RUN, {payrollRunId: row.payrollRunId})
    if (run?.statusId !== "PrnFinalized")
        denied("PAYROLL_NOT_FINALIZED", "This invoice's pay run is not finalized yet: nothing of it is approved or paid before")
    return row
}
// Whether an expense claim is settled on the payroll route by a finalized run (Expense.js: then finance approves it and a payment
// run pays it with the person's net pay).
function claimSettled(invoiceId) {
    const row = invoiceId ? one(OBLIGATION, {invoiceId, obligationKindEnumId: "PokClaim"}) : null
    return !!row && one(RUN, {payrollRunId: row.payrollRunId})?.statusId === "PrnFinalized"
}
// The invoices of a list that a finalized run's obligations name, by kind (PaymentRuns.js: the payment type and a payroll account).
function obligationKinds(invoiceIds) {
    return Object.fromEntries(rowsIn(OBLIGATION, "invoiceId", invoiceIds).map(row => [row.invoiceId, row.obligationKindEnumId]))
}

const operations = {finalizeRun, getSettlement, getObligation, getRecoverySettings, storeRecoverySettings}
function run(op, p) {
    if (!Object.hasOwn(operations, op)) throw new Error("Unknown payroll obligation operation " + op)
    return operations[op](p || {})
}
;({
    execute: run,
    // PayRunDetail's Finalize (PayrollRuns.js get#Run) and P28's live external results: why a group is not live, the projection
    liveReasons,
    requireLive,
    requireProjection,
    // PayrollResults.js get#Payslip
    slipRecovery,
    slipObligationRows,
    // PayInputs.js prepare#Inputs
    recoveryInputs,
    // Accounting's owner contracts: InvoiceWorkflow.js, Expense.js, PaymentRuns.js
    approvalCheck,
    claimSettled,
    obligationKinds
})
