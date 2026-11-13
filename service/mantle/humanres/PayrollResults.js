// People's payslips (mantle.humanres.PayrollResultServices; IronStone People design §8.1 Payslip and PayslipItem, §8.2 corrections,
// Payslips, PayslipDetail, §15 the payslip; PE-10, PE-17; impl-people P26): pay results with identities of their own, made from a
// pay run's calculated employments when the run is approved (PayrollRuns.js calls makeSlips), read, explained and issued here.
//
// - A slip is one employment of one approved run (Payslip.payrollRunEmploymentId), never keyed by employment and pay date, so a
//   regular, an off-cycle and a correction slip of the same day are three slips. A correction names the slip it corrects (the
//   original); its lines are the change, and the original stays as it was, retrievable beside it with the net effect.
// - Preview mode (every pay group of this build, §5 Q3): an approved run's results become preview slips, payroll's alone, never
//   issued and never an obligation. When the run's approval is taken back (it is selected or calculated again) its preview slips
//   are withdrawn; approved again, they are made again in place. A final slip is P27's finalization's; issue#Payslip renders its
//   statement once, stores it and tells the person (PayslipIssued, direct only, with no amount); a stored statement is never
//   rendered again.
// - Who reads: a payroll reader (PAYROLL_VIEW) of the slip's employer reads every slip of it, preview or not; the person reads their
//   own issued slips alone (PEOPLE_SELF_SERVICE), never a preview, a withdrawn or a final one not yet issued, and never a line its
//   term keeps off the payslip (payslipVisible N, still in the totals). Another's slip and a missing one are refused alike
//   (RECORD_UNAVAILABLE). Issuing and the slip's files are a payroll editor's (PAYROLL_EDIT).
// - Year to date is derived on read (design §8.1 accumulators: from final and issued pay facts, drafts and previews counting
//   nothing): the person's slips of the employer in the same year (the employer's fiscal year holding the pay date, else the
//   calendar year) up to the slip's pay date, by line, with this slip added. Nothing is stored.
// - The legacy pay history (EmploymentPayHistory and EmploymentPayDetail, design §8.4, §5 Q8) is read only, by its own key
//   (partyRelationshipId and payDate), labelled historical and never recalculated; payroll's alone.
// Amounts never leave pay's lane (design §1.1, §2): no notice, title or list for anyone else names one.
const people = ec.resource.script("component://mr-mantle/service/mantle/humanres/People.js")
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const {find, one, rows, denied, call, dateText, calendarDateText} = lib

const SLIP = "mantle.humanres.payroll.Payslip"
const ITEM = "mantle.humanres.payroll.PayslipItem"
const CONTENT = "mantle.humanres.payroll.PayslipContent"
const RUN = "mantle.humanres.payroll.PayrollRun"
const UNIT = "mantle.humanres.payroll.PayrollRunEmployment"
const RESULT = "mantle.humanres.payroll.PayrollRunResult"
const GROUP = "mantle.humanres.payroll.PayrollGroup"
const TERM = "mantle.humanres.payroll.PayrollComponentTerm"
const INPUT = "mantle.humanres.payroll.PayrollInput"
const SOURCE = "mantle.humanres.payroll.PayrollInputSource"
const PERIOD = "mantle.party.time.TimePeriod"
const RELATIONSHIP = "mantle.party.PartyRelationship"
const HISTORY = "mantle.humanres.employment.EmploymentPayHistory"
const HISTORY_DETAIL = "mantle.humanres.employment.EmploymentPayDetail"

const listCap = 2000
const kindTexts = {PrkRegular: "Regular", PrkOffCycle: "Off-cycle", PrkCorrection: "Correction"}
const stateTexts = {PssPreview: "Preview", PssWithdrawn: "Withdrawn", PssFinal: "Final", PssIssued: "Issued"}
const states = {PssPreview: "preview", PssWithdrawn: "withdrawn", PssFinal: "final", PssIssued: "issued"}
// the slips whose lines are pay: a preview and a withdrawn slip are not (design §8.1: drafts do not contribute)
const factStatuses = ["PssFinal", "PssIssued"]
// the slips a correction is made against and adds to: not a withdrawn one
const liveStatuses = ["PssPreview", "PssFinal", "PssIssued"]
const groups = [
    ["earning", "Earnings"],
    ["deduction", "Deductions"],
    ["employer", "Employer costs"],
    ["statistical", "Other values"]
]

const text = value => String(value ?? "").trim()
const blank = value => value == null || String(value).trim() === ""
const truthy = value => value === true || value === "true" || value === "Y"
const unique = people.unique
const zero = () => toDecimal(0)
const decimalOf = value => (value == null || value === "" ? zero() : toDecimal(value))
const moneyText = (amount, currencyUomId) =>
    amount == null ? "" : currencyUomId ? ec.l10n.formatCurrency(amount, currencyUomId) : String(amount)
const rowsIn = (entityName, field, ids) => (ids.length ? Array.from(find(entityName).condition(field, "in", ids).list()) : [])
const enc = value =>
    String(value == null ? "" : value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
const L = value => ec.l10n.localize(value)
const lineKey = row => (row.componentCode || "") + "|" + (row.localizationParty || "")
const lineGroup = row =>
    row.localizationParty
        ? row.localizationParty === "employer"
            ? "employer"
            : "deduction"
        : {PckEarning: "earning", PckDeduction: "deduction", PckContribution: "employer", PckStatistical: "statistical"}[
              row.componentKindEnumId
          ] || "statistical"
const kindTextOf = row =>
    row.localizationParty
        ? row.localizationParty === "employer"
            ? "Localization, employer"
            : "Localization, employee"
        : {
              PckEarning: "Earning",
              PckDeduction: "Deduction",
              PckContribution: "Employer contribution",
              PckStatistical: "Statistical"
          }[row.componentKindEnumId] || ""
function periodTextOf(timePeriodId) {
    const period = timePeriodId ? one(PERIOD, {timePeriodId}) : null
    return period ? calendarDateText(period.fromDate) + " to " + calendarDateText(period.thruDate) : timePeriodId || ""
}

// ===== access =====
// The caller's payroll scope and own party: payroll (PAYROLL_VIEW, at the employers of their People scope), edit (with
// PAYROLL_EDIT), and self (their own party with PEOPLE_SELF_SERVICE).
function scopes() {
    const userScope = people.scopeOf()
    const caps = userScope.capabilities
    return {
        userScope,
        payroll: !!caps.payrollView,
        edit: !!(caps.payrollView && caps.payrollEdit),
        partyId: userScope.partyId || null,
        self: !!(userScope.partyId && caps.self)
    }
}
const inScope = (scope, organizationPartyId) => scope.userScope.organizationPartyIds.includes(organizationPartyId)
// How the caller reads a slip: "payroll" (a payroll reader of its employer), "self" (their own issued slip), else false.
function howRead(scope, slip) {
    if (!slip) return false
    if (scope.payroll && inScope(scope, slip.organizationPartyId)) return "payroll"
    if (scope.self && slip.partyId === scope.partyId && slip.statusId === "PssIssued") return "self"
    return false
}
const unavailable = id => denied("RECORD_UNAVAILABLE", "Payslip " + (id || "") + " is not available")

// ===== slips made from an approved run (PayrollRuns.js) =====
// An approved run's calculated employments as preview slips (preview mode: the group is not live, which every group of this build
// is not; a live group's slips are P27's finalization's): each made, or made again in place with its lines replaced, from the
// employment's results; a final or issued slip is never touched. A slip of an employment no longer calculated (excluded since) is
// withdrawn. Answers the number of slips made.
function makeSlips(run) {
    const group = one(GROUP, {payrollGroupId: run.payrollGroupId})
    if (group?.liveEnabled === "Y") return 0
    const units = rows(UNIT, {payrollRunId: run.payrollRunId})
    const existing = Object.fromEntries(
        rows(SLIP, {payrollRunId: run.payrollRunId}).map(row => [row.payrollRunEmploymentId, row])
    )
    const results = rowsIn(RESULT, "payrollRunId", [run.payrollRunId])
    const byUnit = {}
    for (const result of results) (byUnit[result.payrollRunEmploymentId] ||= []).push(result)
    const termIds = unique(results.map(row => row.payrollComponentTermId).filter(Boolean))
    const visible = Object.fromEntries(
        rowsIn(TERM, "payrollComponentTermId", termIds).map(row => [row.payrollComponentTermId, row])
    )
    const now = ec.user.nowTimestamp
    let made = 0
    for (const unit of units) {
        const slip = existing[unit.payrollRunEmploymentId]
        if (slip && factStatuses.includes(slip.statusId)) continue
        if (unit.statusId !== "PruCalculated") {
            if (slip?.statusId === "PssPreview")
                call("update#" + SLIP, {
                    payslipId: slip.payslipId,
                    statusId: "PssWithdrawn",
                    statusId_changeReason: "Excluded from the run"
                })
            continue
        }
        const values = {
            payrollRunId: run.payrollRunId,
            payrollRunEmploymentId: unit.payrollRunEmploymentId,
            organizationPartyId: run.organizationPartyId,
            partyRelationshipId: unit.partyRelationshipId,
            partyId: unit.partyId,
            payrollGroupId: run.payrollGroupId,
            timePeriodId: run.timePeriodId,
            payDate: run.payDate,
            currencyUomId: run.currencyUomId,
            runKindEnumId: run.runKindEnumId,
            correctsPayslipId: run.correctsPayslipId || null,
            statusId: "PssPreview",
            isPreview: "Y",
            grossAmount: unit.grossAmount,
            deductionAmount: unit.deductionAmount,
            contributionAmount: unit.contributionAmount,
            localEmployeeAmount: unit.localEmployeeAmount,
            localEmployerAmount: unit.localEmployerAmount,
            netAmount: unit.netAmount,
            employerCostAmount: unit.employerCostAmount,
            splitText: unit.splitText,
            sourceRevision: unit.sourceRevision,
            approvedDate: now
        }
        let payslipId
        if (slip) {
            payslipId = slip.payslipId
            for (const item of rows(ITEM, {payslipId})) call("delete#" + ITEM, {payslipItemId: item.payslipItemId})
            call("update#" + SLIP, Object.assign({payslipId}, values))
        } else payslipId = call("create#" + SLIP, Object.assign({createdDate: now}, values)).payslipId
        for (const result of byUnit[unit.payrollRunEmploymentId] || [])
            call("create#" + ITEM, {
                payslipId,
                payrollComponentId: result.payrollComponentId || null,
                payrollComponentTermId: result.payrollComponentTermId || null,
                componentCode: result.componentCode,
                itemName: result.resultName,
                componentKindEnumId: result.componentKindEnumId || null,
                localizationParty: result.localizationParty || null,
                amount: result.amount,
                previousAmount: result.previousAmount ?? null,
                currencyUomId: result.currencyUomId || null,
                quantityUomId: result.quantityUomId || null,
                inTotals: result.inTotals || "Y",
                payslipVisible: visible[result.payrollComponentTermId]?.payslipVisible === "N" ? "N" : "Y",
                sequenceNum: result.sequenceNum ?? null,
                explanation: result.explanation
            })
        made++
    }
    return made
}
// A run's preview slips withdrawn: its approval was taken back (it is selected or calculated again), so they no longer stand;
// approved again, they are made again in place.
function withdrawSlips(payrollRunId, reason) {
    let count = 0
    for (const slip of rows(SLIP, {payrollRunId, statusId: "PssPreview"})) {
        call("update#" + SLIP, {payslipId: slip.payslipId, statusId: "PssWithdrawn", statusId_changeReason: reason || null})
        count++
    }
    return count
}
// What an original slip and the corrections made of it before a correction run paid (exceptRunId: that run's own slip left out),
// by line (component code and localization party) and in totals: what a correction pays the change from. The slips of the chain:
// the original and its corrections not withdrawn.
function paidBefore(original, exceptRunId = null) {
    const chain = [original].concat(
        rows(SLIP, {correctsPayslipId: original.payslipId}).filter(
            row => liveStatuses.includes(row.statusId) && row.payrollRunId !== exceptRunId
        )
    )
    const lines = {}
    for (const item of rowsIn(
        ITEM,
        "payslipId",
        chain.map(row => row.payslipId)
    )) {
        const key = lineKey(item)
        if (!lines[key]) lines[key] = Object.assign(lib.map(item), {amount: zero()})
        lines[key].amount = lines[key].amount.add(decimalOf(item.amount))
    }
    const total = field => chain.reduce((sum, row) => sum.add(decimalOf(row[field])), zero())
    return {
        lines,
        runIds: unique(chain.map(row => row.payrollRunId).filter(Boolean)),
        key: chain.map(row => row.payslipId + ":" + row.statusId + ":" + (lib.ms(row.lastUpdatedStamp) ?? 0)).join(","),
        totals: {
            gross: total("grossAmount"),
            deductions: total("deductionAmount"),
            contributions: total("contributionAmount"),
            localEmployee: total("localEmployeeAmount"),
            localEmployer: total("localEmployerAmount"),
            net: total("netAmount"),
            employerCost: total("employerCostAmount")
        }
    }
}
const originalOf = slip => (slip?.correctsPayslipId ? one(SLIP, {payslipId: slip.correctsPayslipId}) : slip)

// ===== find#Payslips =====
// A payroll reader's slips of the employers in their scope (filtered by employer, person, employment, run, period, state, kind or
// show: corrections, historical), newest pay date first, with the legacy pay history labelled historical; or, for anyone without
// PAYROLL_VIEW or with mine, the caller's own issued slips alone (a supplied party never widens it).
function slipRow(slip, names, orgNames, groupNames, corrections, scope) {
    return {
        payslipId: slip.payslipId,
        legacyKey: null,
        historical: false,
        organizationPartyId: slip.organizationPartyId,
        organizationName: orgNames[slip.organizationPartyId] || slip.organizationPartyId,
        partyId: slip.partyId,
        personName: names[slip.partyId] || slip.partyId,
        partyRelationshipId: slip.partyRelationshipId,
        payrollRunId: scope === "payroll" ? slip.payrollRunId : null,
        groupName: groupNames[slip.payrollGroupId] || slip.payrollGroupId || "",
        periodText: periodTextOf(slip.timePeriodId),
        payDate: calendarDateText(slip.payDate),
        payDateText: calendarDateText(slip.payDate),
        kindText: kindTexts[slip.runKindEnumId] || slip.runKindEnumId || "",
        statusId: slip.statusId,
        state: states[slip.statusId] || "preview",
        stateText: stateTexts[slip.statusId] || slip.statusId,
        isPreview: slip.isPreview === "Y",
        grossText: moneyText(slip.grossAmount, slip.currencyUomId),
        netText: moneyText(slip.netAmount, slip.currencyUomId),
        correctsPayslipId: slip.correctsPayslipId || null,
        correctionCount: corrections[slip.payslipId] || 0,
        issuedDateText: dateText(slip.issuedDate)
    }
}
function findPayslips(p) {
    const scope = scopes()
    const mine = truthy(p.mine) || !scope.payroll
    let found
    if (mine) {
        if (!scope.self) denied("PERMISSION_DENIED", "Your payslips need PEOPLE_SELF_SERVICE and a person")
        const query = find(SLIP).condition({partyId: scope.partyId, statusId: "PssIssued"})
        if (text(p.organizationPartyId)) query.condition("organizationPartyId", text(p.organizationPartyId))
        found = Array.from(query.orderBy(["-payDate", "-payslipId"]).limit(listCap).list())
    } else {
        if (!scope.userScope.organizationPartyIds.length || text(p.show) === "historical") found = []
        else {
            const query = find(SLIP).condition("organizationPartyId", "in", scope.userScope.organizationPartyIds)
            for (const field of [
                "organizationPartyId",
                "payrollGroupId",
                "partyId",
                "partyRelationshipId",
                "payrollRunId",
                "timePeriodId",
                "runKindEnumId"
            ])
                if (text(p[field])) query.condition(field, text(p[field]))
            if (text(p.statusId)) query.condition("statusId", text(p.statusId))
            else query.condition("statusId", "not-equals", "PssWithdrawn")
            if (text(p.show) === "corrections") query.condition("correctsPayslipId", "is-not-null", null)
            found = Array.from(query.orderBy(["-payDate", "-payslipId"]).limit(listCap).list())
        }
    }
    const names = people.personNames(unique(found.map(row => row.partyId)))
    const orgNames = people.organizationNames(unique(found.map(row => row.organizationPartyId)))
    const groupNames = Object.fromEntries(
        rowsIn(GROUP, "payrollGroupId", unique(found.map(row => row.payrollGroupId).filter(Boolean))).map(row => [
            row.payrollGroupId,
            row.groupName
        ])
    )
    const corrections = {}
    for (const row of rowsIn(
        SLIP,
        "correctsPayslipId",
        found.map(row => row.payslipId)
    ))
        if (row.statusId !== "PssWithdrawn" && (!mine || row.statusId === "PssIssued"))
            corrections[row.correctsPayslipId] = (corrections[row.correctsPayslipId] || 0) + 1
    let list = found.map(slip => slipRow(slip, names, orgNames, groupNames, corrections, mine ? "self" : "payroll"))
    // the legacy pay history, payroll's alone, unless the list is of a run, a state or corrections
    if (
        !mine &&
        !text(p.payrollRunId) &&
        !text(p.payrollGroupId) &&
        !text(p.statusId) &&
        !text(p.runKindEnumId) &&
        text(p.show) !== "corrections"
    )
        list = list.concat(legacyRows(scope, p))
    list.sort((a, b) => b.payDate.localeCompare(a.payDate) || String(b.payslipId || "").localeCompare(String(a.payslipId || "")))
    return Object.assign({canIssue: scope.edit && !mine}, lib.pageList(list, p, "payslips", {noLimitCap: listCap}))
}
// The legacy pay history of the employments at the employers in scope (by person or employment when asked), read by its own key.
function legacyRows(scope, p) {
    const query = find(HISTORY)
    if (text(p.partyRelationshipId)) query.condition("partyRelationshipId", text(p.partyRelationshipId))
    const histories = Array.from(query.orderBy("-payDate").limit(listCap).list())
    if (!histories.length) return []
    const relationships = Object.fromEntries(
        rowsIn(RELATIONSHIP, "partyRelationshipId", unique(histories.map(row => row.partyRelationshipId))).map(row => [
            row.partyRelationshipId,
            row
        ])
    )
    const kept = histories.filter(row => {
        const relationship = relationships[row.partyRelationshipId]
        if (!relationship || !inScope(scope, relationship.toPartyId)) return false
        if (text(p.organizationPartyId) && relationship.toPartyId !== text(p.organizationPartyId)) return false
        if (text(p.partyId) && relationship.fromPartyId !== text(p.partyId)) return false
        return true
    })
    const names = people.personNames(unique(kept.map(row => relationships[row.partyRelationshipId].fromPartyId)))
    const orgNames = people.organizationNames(unique(kept.map(row => relationships[row.partyRelationshipId].toPartyId)))
    return kept.map(row => {
        const relationship = relationships[row.partyRelationshipId]
        const payDay = calendarDateText(row.payDate)
        return {
            payslipId: null,
            legacyKey: row.partyRelationshipId + "|" + payDay,
            historical: true,
            organizationPartyId: relationship.toPartyId,
            organizationName: orgNames[relationship.toPartyId] || relationship.toPartyId,
            partyId: relationship.fromPartyId,
            personName: names[relationship.fromPartyId] || relationship.fromPartyId,
            partyRelationshipId: row.partyRelationshipId,
            payrollRunId: null,
            groupName: "",
            periodText: periodTextOf(row.timePeriodId),
            payDate: payDay,
            payDateText: payDay,
            kindText: "Historical",
            statusId: null,
            state: "historical",
            stateText: "Historical",
            isPreview: false,
            grossText: moneyText(row.payAmount, row.currencyUomId),
            netText: moneyText(row.netPayAmount, row.currencyUomId),
            correctsPayslipId: null,
            correctionCount: 0,
            issuedDateText: ""
        }
    })
}

// ===== get#Payslip and get#MyPayslip =====
// The year a slip's pay date is in for its year-to-date: the employer's fiscal year holding it, else the calendar year.
function yearOf(slip) {
    const payDay = calendarDateText(slip.payDate)
    const fiscal = rows(PERIOD, {partyId: slip.organizationPartyId, timePeriodTypeId: "FiscalYear"}).find(
        row => calendarDateText(row.fromDate) <= payDay && calendarDateText(row.thruDate) >= payDay
    )
    if (fiscal)
        return {
            fromDay: calendarDateText(fiscal.fromDate),
            text: "fiscal year " + calendarDateText(fiscal.fromDate) + " to " + calendarDateText(fiscal.thruDate)
        }
    return {fromDay: payDay.slice(0, 4) + "-01-01", text: "calendar year " + payDay.slice(0, 4)}
}
// The derived accumulators of a slip: the person's final and issued slips of the employer in the slip's currency and year, up to
// its pay date, by line and in totals, with this slip added (a preview counts nothing for another slip, but its own lines are
// shown with what it would add). keep: the lines the reader is shown.
function accumulatorsOf(slip, items, keep) {
    const year = yearOf(slip)
    const payDay = calendarDateText(slip.payDate)
    const counted = Array.from(
        find(SLIP)
            .condition({partyId: slip.partyId, organizationPartyId: slip.organizationPartyId, currencyUomId: slip.currencyUomId})
            .condition("statusId", "in", factStatuses)
            .condition("payslipId", "not-equals", slip.payslipId)
            .limit(listCap)
            .list()
    ).filter(row => {
        const day = calendarDateText(row.payDate)
        return day >= year.fromDay && day <= payDay
    })
    const byKey = {}
    const add = (item, amount) => {
        const key = lineKey(item)
        if (!byKey[key]) byKey[key] = {item, amount: zero()}
        byKey[key].amount = byKey[key].amount.add(decimalOf(amount))
    }
    for (const item of rowsIn(
        ITEM,
        "payslipId",
        counted.map(row => row.payslipId)
    ))
        if (keep(item)) add(item, item.amount)
    for (const item of items) if (keep(item)) add(item, item.amount)
    const total = field => counted.reduce((sum, row) => sum.add(decimalOf(row[field])), decimalOf(slip[field]))
    return {
        basisText:
            "Year to date, " +
            year.text +
            ": final and issued pay up to " +
            payDay +
            (slip.statusId === "PssPreview" || slip.statusId === "PssWithdrawn"
                ? ", with this preview slip added (a preview counts for no other slip)"
                : ", this slip included"),
        countedCount: counted.length,
        lines: Object.values(byKey)
            .filter(entry => entry.item.inTotals !== "N" || entry.item.componentKindEnumId === "PckStatistical")
            .sort((a, b) => (Number(a.item.sequenceNum) || 0) - (Number(b.item.sequenceNum) || 0))
            .map(entry => ({
                itemName: entry.item.itemName || entry.item.componentCode,
                kindText: kindTextOf(entry.item),
                yearToDateText: entry.item.currencyUomId
                    ? moneyText(entry.amount, entry.item.currencyUomId)
                    : String(entry.amount) + (entry.item.quantityUomId ? " " + entry.item.quantityUomId : "")
            })),
        grossText: moneyText(total("grossAmount"), slip.currencyUomId),
        netText: moneyText(total("netAmount"), slip.currencyUomId)
    }
}
// The inputs a slip's run took for its employment, each with its sources (a time entry, a leave request, a claim, an advance).
function inputsOf(slip) {
    const taken = rows(INPUT, {payrollRunId: slip.payrollRunId, partyRelationshipId: slip.partyRelationshipId})
    const sources = {}
    for (const row of rowsIn(
        SOURCE,
        "payrollInputId",
        taken.map(input => input.payrollInputId)
    ))
        (sources[row.payrollInputId] ||= []).push(row)
    const typeNames = Object.fromEntries(
        rowsIn("moqui.basic.Enumeration", "enumId", unique(taken.map(input => input.inputTypeEnumId).filter(Boolean))).map(
            row => [row.enumId, row.description]
        )
    )
    const sourceNames = {
        "mantle.work.time.TimeEntry": "time entry",
        "mantle.humanres.attendance.AttendanceDay": "attendance day",
        "mantle.humanres.leave.LeaveRequest": "leave request",
        "mantle.humanres.expense.ExpenseClaim": "expense claim",
        "mantle.humanres.expense.EmployeeAdvance": "advance"
    }
    return taken
        .sort((a, b) => calendarDateText(a.inputDate).localeCompare(calendarDateText(b.inputDate)))
        .map(input => ({
            payrollInputId: input.payrollInputId,
            inputDateText: calendarDateText(input.inputDate),
            typeText: typeNames[input.inputTypeEnumId] || input.inputTypeEnumId || "",
            quantityText:
                input.amount != null
                    ? moneyText(input.amount, input.currencyUomId)
                    : String(input.quantity ?? "") + " " + (input.quantityUomId || ""),
            sourceText: (sources[input.payrollInputId] || [])
                .map(row => (sourceNames[row.sourceEntityName] || "source") + " " + row.sourceId)
                .join(", "),
            reason: input.reason || input.description || ""
        }))
}
// A slip's lines as a reader is shown them: grouped (earnings, deductions with the localization's employee items, employer costs,
// other values), each its amount, on a correction what was paid before and now, its rule (the term's dates) and explanation.
function itemRows(items, currencyUomId, correction) {
    const terms = Object.fromEntries(
        rowsIn(TERM, "payrollComponentTermId", unique(items.map(row => row.payrollComponentTermId).filter(Boolean))).map(row => [
            row.payrollComponentTermId,
            row
        ])
    )
    const amountOf = (item, value) =>
        item.currencyUomId
            ? moneyText(value, item.currencyUomId)
            : String(value ?? "") + (item.quantityUomId ? " " + item.quantityUomId : "")
    return items
        .slice()
        .sort(
            (a, b) =>
                groups.findIndex(([key]) => key === lineGroup(a)) - groups.findIndex(([key]) => key === lineGroup(b)) ||
                (Number(a.sequenceNum) || 0) - (Number(b.sequenceNum) || 0) ||
                String(a.componentCode).localeCompare(String(b.componentCode))
        )
        .map(item => {
            const term = terms[item.payrollComponentTermId]
            return {
                payslipItemId: item.payslipItemId,
                componentCode: item.componentCode,
                itemName: item.itemName || item.componentCode,
                group: lineGroup(item),
                groupText: (groups.find(([key]) => key === lineGroup(item)) || [null, ""])[1],
                kindText: kindTextOf(item),
                amountText: amountOf(item, item.amount),
                previousText: correction && item.previousAmount != null ? amountOf(item, item.previousAmount) : "",
                nowText:
                    correction && item.previousAmount != null
                        ? amountOf(item, decimalOf(item.previousAmount).add(decimalOf(item.amount)))
                        : "",
                inTotals: item.inTotals !== "N",
                hiddenFromPerson: item.payslipVisible === "N",
                ruleText: term
                    ? "Rule from " +
                      calendarDateText(term.fromDate) +
                      (term.thruDate ? " to " + calendarDateText(term.thruDate) : "")
                    : item.localizationParty
                      ? "The localization"
                      : "",
                explanation: item.explanation || ""
            }
        })
}
// A slip whole as the reader may read it (how: payroll or self): its header, lines, totals, year to date, the correction chain
// with the net effect, the inputs taken, the stored statement and what the reader may do.
function slipView(scope, slip, how, forTool = false) {
    const self = how === "self"
    const allItems = rows(ITEM, {payslipId: slip.payslipId})
    const keep = item => !self || item.payslipVisible !== "N"
    const items = allItems.filter(keep)
    const currencyUomId = slip.currencyUomId
    const run = one(RUN, {payrollRunId: slip.payrollRunId})
    const group = one(GROUP, {payrollGroupId: slip.payrollGroupId})
    const names = people.personNames([slip.partyId])
    const orgNames = people.organizationNames([slip.organizationPartyId])
    const correction = !!slip.correctsPayslipId
    const original = originalOf(slip)
    // the chain: the original and its corrections (a person sees the issued ones alone), with the net effect of those standing
    const chainRows = rows(SLIP, {correctsPayslipId: original.payslipId})
        .filter(row => (self ? row.statusId === "PssIssued" : true))
        .sort((a, b) => String(a.payslipId).localeCompare(String(b.payslipId)))
    const standing = [original].concat(chainRows).filter(row => liveStatuses.includes(row.statusId))
    const netEffect = standing.reduce((sum, row) => sum.add(decimalOf(row.netAmount)), zero())
    const chain = [original].concat(chainRows).map(row => ({
        payslipId: row.payslipId,
        original: row.payslipId === original.payslipId,
        current: row.payslipId === slip.payslipId,
        payDateText: calendarDateText(row.payDate),
        kindText: row.payslipId === original.payslipId ? kindTexts[row.runKindEnumId] || "" : "Correction",
        stateText: stateTexts[row.statusId] || row.statusId,
        netText: moneyText(row.netAmount, row.currencyUomId),
        reason: row.payslipId === original.payslipId ? "" : one(RUN, {payrollRunId: row.payrollRunId})?.correctionReason || ""
    }))
    // a preview slip whose sources changed since its run was approved: it no longer stands until the run is approved again
    let changedSinceApproved = false
    if (!self && slip.statusId === "PssPreview" && run && slip.payrollRunEmploymentId)
        try {
            changedSinceApproved = !ec.resource
                .script("component://mr-mantle/service/mantle/humanres/PayrollRuns.js")
                .unitHolds(run, slip.payrollRunEmploymentId, slip.sourceRevision)
        } catch (error) {
            ec.logger.error("Payslip " + slip.payslipId + " was not checked against its sources: " + error.message)
        }
    const openCorrection = self
        ? null
        : rows(RUN, {correctsPayslipId: original.payslipId}).find(
              row =>
                  ["PrnDraft", "PrnCalculating", "PrnReview", "PrnApproved"].includes(row.statusId) &&
                  !rows(SLIP, {payrollRunId: row.payrollRunId}).some(slipRow => liveStatuses.includes(slipRow.statusId))
          ) || null
    let state = states[slip.statusId] || "preview"
    let stateText = stateTexts[slip.statusId] || slip.statusId
    if (slip.statusId === "PssPreview") stateText = "Preview: payroll's alone, never issued as pay"
    if (changedSinceApproved) [state, stateText] = ["stale", "Preview: changed since its run was approved"]
    const sum = field => moneyText(slip[field], currencyUomId)
    const view = {
        payslip: {
            payslipId: slip.payslipId,
            historical: false,
            organizationPartyId: slip.organizationPartyId,
            organizationName: orgNames[slip.organizationPartyId] || slip.organizationPartyId,
            partyId: slip.partyId,
            personName: names[slip.partyId] || slip.partyId,
            partyRelationshipId: slip.partyRelationshipId,
            payrollRunId: self ? null : slip.payrollRunId,
            groupName: group?.groupName || slip.payrollGroupId || "",
            periodText: periodTextOf(slip.timePeriodId),
            payDateText: calendarDateText(slip.payDate),
            currencyUomId,
            runKindEnumId: slip.runKindEnumId,
            kindText: kindTexts[slip.runKindEnumId] || slip.runKindEnumId || "",
            statusId: slip.statusId,
            state,
            stateText,
            isPreview: slip.isPreview === "Y",
            correctsPayslipId: slip.correctsPayslipId || null,
            correctionReason: correction ? run?.correctionReason || "" : "",
            splitText: slip.splitText || "",
            approvedDateText: dateText(slip.approvedDate),
            issuedDateText: dateText(slip.issuedDate),
            hiddenCount: allItems.length - items.length
        },
        items: itemRows(self ? items : allItems, currencyUomId, correction),
        totalsText: {
            gross: sum("grossAmount"),
            deductions: sum("deductionAmount"),
            contributions: sum("contributionAmount"),
            localEmployee: sum("localEmployeeAmount"),
            localEmployer: sum("localEmployerAmount"),
            net: sum("netAmount"),
            employerCost: sum("employerCostAmount")
        },
        yearToDate: correction ? null : accumulatorsOf(slip, allItems, keep),
        corrections: {
            chain,
            hasCorrections: chainRows.length > 0,
            netEffectText: moneyText(netEffect, currencyUomId),
            originalNetText: moneyText(original.netAmount, original.currencyUomId)
        },
        inputs: inputsOf(slip),
        canIssue: !self && scope.edit && slip.statusId === "PssFinal",
        canCorrect: !self && scope.edit && liveStatuses.includes(original.statusId) && !openCorrection,
        openCorrectionRunId: openCorrection?.payrollRunId || null,
        file:
            slip.contentLocation && !forTool
                ? {
                      location: slip.contentLocation,
                      fileName: slip.fileName,
                      contentType: slip.contentType,
                      issuedDateText: dateText(slip.issuedDate)
                  }
                : null
    }
    return view
}
function getPayslip(p) {
    const scope = scopes()
    if (!blank(p.legacyKey)) return legacyView(scope, text(p.legacyKey))
    const id = text(p.payslipId)
    const slip = id ? one(SLIP, {payslipId: id}) : null
    const how = howRead(scope, slip)
    if (!how) unavailable(id)
    return slipView(scope, slip, how)
}
// The Assistant's tool and the person's own slip screen: the caller's own issued slip alone (the latest when none is named), never
// another person's, a preview or one not issued, whatever the caller's payroll rights; no file location. The amounts are the
// person's own (impl-people P26 Built note: the user's call on the self-only tool and pay's AI opt-out).
function getMyPayslip(p) {
    const scope = scopes()
    if (!scope.self) denied("PERMISSION_DENIED", "Your payslips need PEOPLE_SELF_SERVICE and a person")
    const id = text(p.payslipId)
    const slip = id
        ? one(SLIP, {payslipId: id})
        : find(SLIP).condition({partyId: scope.partyId, statusId: "PssIssued"}).orderBy(["-payDate", "-issuedDate"]).one()
    if (!slip || slip.partyId !== scope.partyId || slip.statusId !== "PssIssued")
        denied("RECORD_UNAVAILABLE", id ? "Payslip " + id + " is not available" : "You have no issued payslip yet")
    return slipView(scope, slip, "self", truthy(p.forTool))
}
// A legacy pay record by its own key (partyRelationshipId|payDate), payroll's alone, as recorded: its details and the year-to-date
// figures it stored, never recalculated.
function legacyView(scope, legacyKey) {
    const [partyRelationshipId, payDay] = legacyKey.split("|")
    const relationship = partyRelationshipId ? one(RELATIONSHIP, {partyRelationshipId}) : null
    if (!scope.payroll || !relationship || !inScope(scope, relationship.toPartyId) || !payDay)
        denied("RECORD_UNAVAILABLE", "Pay record " + legacyKey + " is not available")
    const history = rows(HISTORY, {partyRelationshipId}).find(row => calendarDateText(row.payDate) === payDay)
    if (!history) denied("RECORD_UNAVAILABLE", "Pay record " + legacyKey + " is not available")
    const currencyUomId = history.currencyUomId
    const details = rows(HISTORY_DETAIL, {partyRelationshipId}).filter(row => calendarDateText(row.payDate) === payDay)
    const typeNames = Object.fromEntries(
        rowsIn("moqui.basic.Enumeration", "enumId", unique(details.map(row => row.itemTypeEnumId).filter(Boolean))).map(row => [
            row.enumId,
            row.description
        ])
    )
    const names = people.personNames([relationship.fromPartyId])
    const orgNames = people.organizationNames([relationship.toPartyId])
    return {
        payslip: {
            payslipId: null,
            legacyKey,
            historical: true,
            organizationPartyId: relationship.toPartyId,
            organizationName: orgNames[relationship.toPartyId] || relationship.toPartyId,
            partyId: relationship.fromPartyId,
            personName: names[relationship.fromPartyId] || relationship.fromPartyId,
            partyRelationshipId,
            periodText: periodTextOf(history.timePeriodId),
            payDateText: payDay,
            currencyUomId,
            kindText: "Historical",
            state: "historical",
            stateText: "Historical pay record: shown as it was recorded, never recalculated",
            isPreview: false,
            hiddenCount: 0
        },
        items: details.map(row => ({
            itemName: typeNames[row.itemTypeEnumId] || row.itemTypeEnumId || "",
            group: row.isEmployerPaid === "Y" ? "employer" : "earning",
            groupText: row.isEmployerPaid === "Y" ? "Employer costs" : "Recorded lines",
            kindText: row.isEmployerPaid === "Y" ? "Employer paid" : "",
            amountText: moneyText(row.amount, currencyUomId),
            previousText: "",
            nowText: "",
            ruleText: "",
            explanation: row.quantity != null ? "Quantity " + String(row.quantity) : ""
        })),
        totalsText: {
            gross: moneyText(history.payAmount, currencyUomId),
            net: moneyText(history.netPayAmount, currencyUomId),
            taxable: moneyText(history.taxablePayAmount, currencyUomId),
            taxableYearToDate: moneyText(history.taxableYtdIncome, currencyUomId)
        },
        yearToDate: null,
        corrections: {chain: [], hasCorrections: false},
        inputs: [],
        canIssue: false,
        canCorrect: false,
        openCorrectionRunId: null,
        file: null
    }
}

// ===== issue#Payslip =====
// The statement of a slip as the person reads it, rendered once when issued: the employer, the person, the period and pay date,
// the lines by group with their explanations, the totals, the year to date, a correction's original and reason. Every value
// escaped.
function statementHtml(view) {
    const slip = view.payslip
    const row = (cells, header = false) =>
        "<tr>" +
        cells
            .map(
                cell =>
                    (header ? "<th" : "<td") +
                    ' class="field-value" style="padding:2pt 6pt">' +
                    enc(cell) +
                    (header ? "</th>" : "</td>")
            )
            .join("") +
        "</tr>"
    const lines = groups
        .map(([key, title]) => {
            const own = view.items.filter(item => item.group === key)
            if (!own.length) return ""
            return (
                '<div class="group-title" style="margin:10pt 0 4pt 0">' +
                enc(L(title)) +
                '</div><table class="field" style="width:100%">' +
                row([L("Line"), L("Amount"), L("How")], true) +
                own.map(item => row([item.itemName, item.amountText, item.explanation])).join("") +
                "</table>"
            )
        })
        .join("")
    const totals = view.totalsText
    const ytd = view.yearToDate
    return (
        '<html><head><meta charset="utf-8"/><title>' +
        enc(L("Payslip") + " " + slip.payslipId) +
        '</title></head><body><div class="box-header">' +
        enc(slip.organizationName) +
        "</div>" +
        '<p style="margin:0 0 8pt 0">' +
        enc(
            [slip.personName, L("Period") + " " + slip.periodText, L("Pay date") + " " + slip.payDateText, slip.kindText].join(
                " · "
            )
        ) +
        "</p>" +
        (slip.correctsPayslipId
            ? '<p style="margin:0 0 8pt 0">' +
              enc(
                  L("Corrects payslip") +
                      " " +
                      slip.correctsPayslipId +
                      (slip.correctionReason ? ": " + slip.correctionReason : "")
              ) +
              "</p>"
            : "") +
        lines +
        '<table class="field" style="margin:12pt 0 0 0">' +
        [
            ["Gross", totals.gross],
            ["Deductions", totals.deductions],
            ["Localization, employee", totals.localEmployee],
            ["Net", totals.net],
            ["Employer cost", totals.employerCost]
        ]
            .map(([label, value]) => row([L(label), value]))
            .join("") +
        "</table>" +
        (ytd
            ? '<p style="margin:10pt 0 2pt 0">' +
              enc(ytd.basisText) +
              '</p><table class="field">' +
              ytd.lines.map(line => row([line.itemName, line.yearToDateText])).join("") +
              row([L("Net"), ytd.netText]) +
              "</table>"
            : "") +
        '<p style="color:#555;margin:12pt 0 0 0">' +
        enc(L("Issued") + " " + ec.l10n.format(ec.user.nowTimestamp, "yyyy-MM-dd")) +
        "</p></body></html>"
    )
}
// A final slip issued by a payroll editor of its employer: its statement rendered once now as the person reads it, stored (its
// PDF, else its html-print page) and the slip issued; the person is told on PayslipIssued (direct only: their own accounts; the
// title names the employer and the period, never an amount; the link needs a sign-in). A preview slip is never issued
// (PREVIEW_ONLY), a slip not final is not (NOT_FINAL); a repeat answers the first issue.
function issuePayslip(p) {
    const scope = scopes()
    if (!scope.edit) denied("PERMISSION_DENIED", "Issuing a payslip needs PAYROLL_VIEW and PAYROLL_EDIT")
    const id = text(p.payslipId)
    let slip = id ? one(SLIP, {payslipId: id}) : null
    if (!slip || !inScope(scope, slip.organizationPartyId)) unavailable(id)
    slip = find(SLIP, {payslipId: id}).forUpdate(true).one()
    if (slip.statusId === "PssIssued")
        return {
            payslipId: id,
            statusId: slip.statusId,
            issuedDateText: dateText(slip.issuedDate),
            repeated: true,
            notifiedCount: 0
        }
    if (slip.isPreview === "Y" || slip.statusId === "PssPreview" || slip.statusId === "PssWithdrawn")
        denied(
            "PREVIEW_ONLY",
            "A preview slip is payroll's alone and is never issued: its pay group is in preview mode and makes no pay"
        )
    if (slip.statusId !== "PssFinal") denied("NOT_FINAL", "Only a final slip is issued")
    const view = slipView(scope, slip, "self")
    const document = statementHtml(view)
    const root = ec.user.getPreference("mantle.content.large.root") || "dbresource://mantle/content"
    const folder = root + "/payslip/" + id + "/"
    const baseName = ("Payslip-" + id + "-" + view.payslip.payDateText).replace(/[^A-Za-z0-9._-]/g, "_")
    let fileName = baseName + ".pdf"
    let contentType = "application/pdf"
    try {
        const pdf = ec.resource.xslFoTransform(document, null, null, "application/pdf")
        ec.resource.getLocationReference(folder + fileName).putBytes(pdf)
    } catch (error) {
        ec.logger.warn("Payslip " + id + ": no PDF engine, its html-print page is stored: " + error.message)
        fileName = baseName + ".html"
        contentType = "text/html"
        ec.resource.getLocationReference(folder + fileName).putText(document)
    }
    const now = ec.user.nowTimestamp
    call("update#" + SLIP, {
        payslipId: id,
        statusId: "PssIssued",
        issuedDate: now,
        issuedByUserId: ec.user.userId || null,
        contentLocation: folder + fileName,
        contentType,
        fileName
    })
    const notifiedCount = tellPerson(slip, view)
    return {payslipId: id, statusId: "PssIssued", issuedDateText: dateText(now), repeated: false, notifiedCount}
}
// PayslipIssued to the person's own accounts alone (directOnly): the employer, the period and the pay date, never an amount. A
// failure is logged and the issue stays.
function tellPerson(slip, view) {
    try {
        const userIds = unique(
            rows("moqui.security.UserAccount", {partyId: slip.partyId})
                .filter(row => row.disabled !== "Y")
                .map(row => row.userId)
        ).filter(Boolean)
        if (!userIds.length) return 0
        ec.makeNotificationMessage()
            .topic("PayslipIssued")
            .message({
                payslipId: slip.payslipId,
                organizationName: view.payslip.organizationName,
                periodText: view.payslip.periodText,
                payDateText: view.payslip.payDateText
            })
            .record(SLIP, slip.payslipId)
            .userIds(userIds)
            .directOnly()
            .send()
        return userIds.length
    } catch (error) {
        ec.logger.error("Payslip notice of " + slip.payslipId + " was not sent: " + error.message)
        return 0
    }
}

// ===== check#PayslipAccess and the payslip's files =====
// Whether the caller sees a slip as a record (its files' host, get#RecordLinkInfo): a payroll reader of its employer alone; canEdit
// for a payroll editor of it. The person reads their own issued slip through get#MyPayslip, never payroll's files or notes of it.
// A missing slip is not visible.
function payslipAccess(p) {
    if (!ec.user.userId) return {recordVisible: false, canEdit: false}
    const scope = scopes()
    const slip = text(p.payslipId) ? one(SLIP, {payslipId: text(p.payslipId)}) : null
    const payroll = howRead(scope, slip) === "payroll"
    return {recordVisible: payroll, canEdit: payroll && scope.edit, partyId: slip?.partyId || null}
}
// create#PayslipContent's check: a payroll editor of the slip's employer (RECORD_UNAVAILABLE outside the scope, PERMISSION_DENIED
// for a reader).
function contentAccess(p) {
    const found = payslipAccess(p)
    if (!found.recordVisible) unavailable(p.payslipId)
    if (!found.canEdit) denied("PERMISSION_DENIED", "A payslip's files are changed by payroll")
    return found
}

const operations = {findPayslips, getPayslip, getMyPayslip, issuePayslip, payslipAccess, contentAccess}
function run(op, p) {
    if (!Object.hasOwn(operations, op)) throw new Error("Unknown payslip operation " + op)
    // each operation checks its caller first; the statement's storage is written as the service, not the caller
    const wasDisabled = ec.artifactExecution.disableAuthz()
    try {
        return operations[op](p || {})
    } finally {
        if (!wasDisabled) ec.artifactExecution.enableAuthz()
    }
}
;({
    execute: run,
    // for PayrollRuns.js: an approved run's slips, a run's preview slips withdrawn, what a correction pays the change from
    makeSlips,
    withdrawSlips,
    paidBefore,
    originalOf
})
