// People's reports (mantle.humanres.PeopleReportServices; IronStone People design §12 Reports, §1.4 Shipped reports, PE-17;
// impl-people P29): one registered family of reports, each with the capability that reads it, over the employers of the caller's
// People scope (People.js scopeOf) narrowed to the one asked for (refused outside it, ORGANIZATION_DENIED):
// - headcount: headcount as of the start and the end of a period (distinct people), the employments at its end, the joins and
//   exits in it (employments) and the turnover with its denominator (exits over the average headcount); an HR reader's or the
//   People administrator's;
// - recruiting: the vacant seats now and the hiring funnel of the openings (applications received in the period by their stage
//   now, and by how they came); a recruiter's or an HR reader's;
// - attendance: the attendance days of the period whose punches lack something (a missing in or out, a repeated punch), and
//   whether they were corrected; an HR reader's;
// - leaveBalances: each employment's leave by type as of a date, from the ledger (granted, accrued, taken, expired, adjusted,
//   the balance); never a request's reason; an HR reader's;
// - expenses: the claims submitted in the period by employer and state, their count and total in each currency apart; a holder
//   of PEOPLE_EXPENSE_MANAGE or an HR reader;
// - qualifications: the verified qualifications expired and not renewed or expiring within the window, by type and expiry, never
//   a document's number; a development or HR reader's;
// - reviews: each review cycle's reviews by state and the share completed (finalized, released or acknowledged), never a rating,
//   an answer or a note; a development or HR reader's;
// - payrollRegister: the employees of the pay runs paid in the period (calculated, approved or finalized), their gross,
//   deductions, contributions, net and employer cost, totals in each currency apart; a payroll reader's alone (PAYROLL_VIEW): pay
//   never reaches another report, and a caller without the grant is refused (PERMISSION_DENIED).
// A report not readable to the caller is refused (PERMISSION_DENIED); an unknown one REPORT_UNAVAILABLE. Each answer is the
// report's columns, its rows (capped, `capped` said), its totals and what it counts (`basisText`, `denominatorText`), and the
// export (format csv) is the same rows as text, each cell a spreadsheet could read as a formula behind an apostrophe.
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const people = ec.resource.script("component://mr-mantle/service/mantle/humanres/People.js")
const {find, rows, denied, dateText, calendarDateText, ms} = lib
const {stamp, unique} = people

const day = 24 * 60 * 60 * 1000
// the most rows a report reads; past it the answer says so
const rowCap = 20000
// the qualification window's default length, in days
const expiryWindowDays = 90
const ASSIGNMENT = "mantle.humanres.employment.EmploymentAssignment"
const cf = () => ec.entity.conditionFactory
const either = (...conditions) => cf().makeCondition(conditions, "or")
const isNull = field => cf().makeCondition(field, "is-null", null)
const compare = (field, operator, value) => cf().makeCondition(field, operator, value)

// ===== values =====
const text = value => (value == null ? "" : String(value).trim())
const percentText = value => (value == null ? "–" : (Math.round(value * 10) / 10).toFixed(1) + "%")
const moneyText = (value, currencyUomId) =>
    currencyUomId ? ec.l10n.formatCurrency(lib.money(value, currencyUomId), currencyUomId) : String(lib.money(value, null))
const enumNames = enumIds => {
    const ids = unique(enumIds.filter(Boolean))
    if (!ids.length) return {}
    return Object.fromEntries(
        Array.from(find("moqui.basic.Enumeration").condition("enumId", "in", ids).list()).map(row => [
            row.enumId,
            row.description || row.enumId
        ])
    )
}
const statusNames = statusIds => {
    const ids = unique(statusIds.filter(Boolean))
    if (!ids.length) return {}
    return Object.fromEntries(
        Array.from(find("moqui.basic.StatusItem").condition("statusId", "in", ids).list()).map(row => [
            row.statusId,
            row.description || row.statusId
        ])
    )
}
// A period's bounds in milliseconds: from the start of fromDate (the first of thruDate's month when empty) to the end of thruDate
// (now when empty), a date-only through being the end of that day (People.js asOfMillis).
function periodOf(p) {
    const thruMs = people.asOfMillis(p.thruDate || null)
    let fromMs = text(p.fromDate) ? ec.user.timestampMillis(p.fromDate) : null
    if (fromMs == null) fromMs = ec.user.timestampMillis(ec.l10n.format(new Date(thruMs), "yyyy-MM") + "-01")
    if (fromMs > thruMs) denied("PERIOD_INVALID", "The period's start is after its end")
    return {fromMs, thruMs, fromText: dateText(new Date(fromMs)), thruText: ec.l10n.format(new Date(thruMs), "yyyy-MM-dd")}
}
const capList = (query, found) => {
    const list = Array.from(query.limit(rowCap + 1).list())
    if (list.length > rowCap) {
        found.capped = true
        list.length = rowCap
    }
    return list
}

// ===== headcount, joins, exits and turnover =====
// Whether an employment is in effect at a moment (fromDate inclusive, thruDate exclusive).
const inEffect = (row, at) => (ms(row.fromDate) ?? -Infinity) <= at && (ms(row.thruDate) ?? Infinity) > at
// The primary assignments of the employments, read once: the department of one at a moment.
function departmentsOf(partyRelationshipIds) {
    const byEmployment = {}
    for (let index = 0; index < partyRelationshipIds.length; index += 500)
        for (const row of Array.from(
            find(ASSIGNMENT)
                .condition("partyRelationshipId", "in", partyRelationshipIds.slice(index, index + 500))
                .condition("isPrimary", "Y")
                .selectField(["partyRelationshipId", "departmentPartyId", "fromDate", "thruDate"])
                .orderBy("-fromDate")
                .list()
        ))
            (byEmployment[row.partyRelationshipId] || (byEmployment[row.partyRelationshipId] = [])).push(row)
    return (partyRelationshipId, at) =>
        (byEmployment[partyRelationshipId] || []).find(row => inEffect(row, at))?.departmentPartyId || null
}
function headcount(ctx) {
    const {employers, p, found} = ctx
    const {fromMs, thruMs} = periodOf(p)
    const groupBy = p.groupBy === "department" || p.groupBy === "none" ? p.groupBy : "organization"
    // every employment that overlaps the period: begun by its end, not ended before its start
    const query = people
        .employmentFind()
        .condition("toPartyId", "in", employers)
        .condition(either(isNull("fromDate"), compare("fromDate", "less-equals", stamp(thruMs))))
        .condition(either(isNull("thruDate"), compare("thruDate", "greater-equals", stamp(fromMs))))
    const employments = capList(query, found)
    const departmentAt = groupBy === "department" ? departmentsOf(employments.map(row => row.partyRelationshipId)) : null
    const groups = new Map()
    const groupOf = key => {
        if (!groups.has(key))
            groups.set(key, {groupKey: key, start: new Set(), end: new Set(), employments: 0, joins: 0, exits: 0})
        return groups.get(key)
    }
    const keyAt = (row, at) =>
        groupBy === "organization"
            ? row.toPartyId
            : groupBy === "department"
              ? departmentAt(row.partyRelationshipId, at) || ""
              : "all"
    const all = {start: new Set(), end: new Set(), employments: 0, joins: 0, exits: 0}
    const before = fromMs - 1
    for (const row of employments) {
        const fromAt = ms(row.fromDate)
        const thruAt = ms(row.thruDate)
        if (inEffect(row, before)) {
            groupOf(keyAt(row, before)).start.add(row.fromPartyId)
            all.start.add(row.fromPartyId)
        }
        if (inEffect(row, thruMs)) {
            const group = groupOf(keyAt(row, thruMs))
            group.end.add(row.fromPartyId)
            group.employments++
            all.end.add(row.fromPartyId)
            all.employments++
        }
        if (fromAt != null && fromAt >= fromMs && fromAt <= thruMs) {
            groupOf(keyAt(row, fromAt)).joins++
            all.joins++
        }
        if (thruAt != null && thruAt >= fromMs && thruAt <= thruMs) {
            groupOf(keyAt(row, thruAt - 1)).exits++
            all.exits++
        }
    }
    const names = people.organizationNames(Array.from(groups.keys()).filter(key => key && key !== "all"))
    const measured = (name, group) => {
        const average = (group.start.size + group.end.size) / 2
        return {
            groupKey: group.groupKey || null,
            groupName: name,
            startHeadcount: group.start.size,
            endHeadcount: group.end.size,
            employmentCount: group.employments,
            joinCount: group.joins,
            exitCount: group.exits,
            averageHeadcount: average,
            turnoverPercent: average ? (group.exits / average) * 100 : null,
            turnoverText: percentText(average ? (group.exits / average) * 100 : null)
        }
    }
    const list = Array.from(groups.values())
        .map(group =>
            measured(
                groupBy === "none"
                    ? "Every employer"
                    : group.groupKey
                      ? names[group.groupKey] || group.groupKey
                      : groupBy === "department"
                        ? "No department"
                        : "",
                group
            )
        )
        .sort((a, b) => String(a.groupName).localeCompare(String(b.groupName)))
    const totals = measured("Total", all)
    return {
        groupBy,
        rows: list,
        totals,
        basisText:
            "Headcount is distinct people with an employment in effect, at the start of the period and as of its end; joins and exits are employments begun and ended in the period, so a person employed by two employers counts once in headcount and twice in employments.",
        denominatorText:
            "Turnover is exits over the average headcount, (start + end) ÷ 2: " +
            totals.exitCount +
            " ÷ " +
            totals.averageHeadcount +
            " = " +
            totals.turnoverText,
        columns: [
            ["groupName", groupBy === "department" ? "Department" : "Employer"],
            ["startHeadcount", "Headcount at start"],
            ["endHeadcount", "Headcount at end"],
            ["employmentCount", "Employments at end"],
            ["joinCount", "Joins"],
            ["exitCount", "Exits"],
            ["averageHeadcount", "Average headcount"],
            ["turnoverText", "Turnover"]
        ]
    }
}

// ===== vacancies and the hiring funnel =====
const funnelStages = ["EaReceived", "EaScreening", "EaInterview", "EaOffer", "EaHired", "EaRefused", "EaWithdrawn"]
const stageFields = {
    EaReceived: "receivedCount",
    EaScreening: "screeningCount",
    EaInterview: "interviewCount",
    EaOffer: "offerCount",
    EaHired: "hiredCount",
    EaRefused: "refusedCount",
    EaWithdrawn: "withdrawnCount"
}
function recruiting(ctx) {
    const {employers, p, found} = ctx
    const {fromMs, thruMs} = periodOf(p)
    const applications = capList(
        find("mantle.humanres.employment.EmploymentApplication")
            .condition("organizationPartyId", "in", employers)
            .condition("applicationDate", ">=", stamp(fromMs))
            .condition("applicationDate", "<=", stamp(thruMs))
            .selectField(["employmentApplicationId", "jobOpeningId", "statusId", "referredByEnumId", "duplicateOfApplicationId"]),
        found
    ).filter(row => !row.duplicateOfApplicationId)
    const openingIds = unique(applications.map(row => row.jobOpeningId).filter(Boolean))
    const openings = openingIds.length
        ? Object.fromEntries(
              Array.from(find("mantle.humanres.recruitment.JobOpening").condition("jobOpeningId", "in", openingIds).list()).map(
                  row => [row.jobOpeningId, row]
              )
          )
        : {}
    const statuses = statusNames(Object.values(openings).map(row => row.statusId))
    const organizations = people.organizationNames(unique(Object.values(openings).map(row => row.organizationPartyId)))
    const byOpening = new Map()
    const bySource = new Map()
    const blankCounts = () => Object.fromEntries(Object.values(stageFields).map(field => [field, 0]))
    for (const row of applications) {
        const key = row.jobOpeningId || ""
        if (!byOpening.has(key)) {
            const opening = openings[key]
            byOpening.set(
                key,
                Object.assign(
                    {
                        jobOpeningId: key || null,
                        openingTitle: opening?.title || "No opening",
                        organizationName: opening ? organizations[opening.organizationPartyId] || "" : "",
                        openingStatusName: opening ? statuses[opening.statusId] || "" : "",
                        applicationCount: 0
                    },
                    blankCounts()
                )
            )
        }
        const counts = byOpening.get(key)
        counts.applicationCount++
        if (stageFields[row.statusId]) counts[stageFields[row.statusId]]++
        const source = row.referredByEnumId || ""
        if (!bySource.has(source)) bySource.set(source, {referredByEnumId: source || null, applicationCount: 0, hiredCount: 0})
        bySource.get(source).applicationCount++
        if (row.statusId === "EaHired") bySource.get(source).hiredCount++
    }
    const sources = enumNames(Array.from(bySource.keys()))
    // the vacant seats in effect now (P4's positions, find#Positions' own scope), each employer asked apart; one that cannot be
    // counted is logged and left out
    let vacancyCount = 0
    for (const organizationPartyId of employers) {
        try {
            vacancyCount +=
                Number(
                    lib.probe("mantle.humanres.PositionServices.find#Positions", {
                        organizationPartyId,
                        vacancy: "vacant",
                        pageSize: 1
                    }).positionsCount
                ) || 0
        } catch (error) {
            ec.logger.warn(
                "People recruiting report: the vacancies of " + organizationPartyId + " were not counted: " + error.message
            )
        }
    }
    const totals = Object.assign({openingTitle: "Total", applicationCount: applications.length}, blankCounts())
    for (const row of applications) if (stageFields[row.statusId]) totals[stageFields[row.statusId]]++
    return {
        rows: Array.from(byOpening.values()).sort((a, b) => b.applicationCount - a.applicationCount),
        sourceRows: Array.from(bySource.values())
            .map(row => Object.assign(row, {sourceName: row.referredByEnumId ? sources[row.referredByEnumId] || "" : "Not said"}))
            .sort((a, b) => b.applicationCount - a.applicationCount),
        totals,
        vacancyCount,
        basisText:
            "Applications received in the period, each by its stage now (a duplicate of another application left out); vacant seats are the approved seats in effect with no one in them now.",
        columns: [
            ["openingTitle", "Opening"],
            ["organizationName", "Employer"],
            ["applicationCount", "Applications"]
        ].concat(funnelStages.map(statusId => [stageFields[statusId], statusId.slice(2)]))
    }
}

// ===== attendance exceptions =====
const flagTexts = {MISSING_OUT: "No clock out", MISSING_IN: "No clock in", REPEATED: "Repeated punch"}
function attendance(ctx) {
    const {employers, p, found} = ctx
    const {fromMs, thruMs} = periodOf(p)
    const days = capList(
        find("mantle.humanres.attendance.AttendanceDay")
            .condition("organizationPartyId", "in", employers)
            .condition("attendanceDate", ">=", new Date(fromMs))
            .condition("attendanceDate", "<=", new Date(thruMs))
            .condition("flagsText", "is-not-null", null)
            .condition("flagsText", "not-equals", "")
            .orderBy(["-attendanceDate", "partyId"]),
        found
    )
    const names = people.personNames(unique(days.map(row => row.partyId)))
    const organizations = people.organizationNames(unique(days.map(row => row.organizationPartyId)))
    const states = enumNames(days.map(row => row.statusEnumId))
    const byFlag = {}
    const list = days.map(row => {
        const flags = text(row.flagsText)
            .split(",")
            .map(flag => flag.trim())
            .filter(Boolean)
        for (const flag of flags) byFlag[flag] = (byFlag[flag] || 0) + 1
        return {
            attendanceDayId: row.attendanceDayId,
            partyId: row.partyId,
            personName: names[row.partyId] || row.partyId,
            organizationName: organizations[row.organizationPartyId] || "",
            attendanceDateText: calendarDateText(row.attendanceDate),
            flagsText: flags.map(flag => flagTexts[flag] || flag).join(", "),
            stateName: states[row.statusEnumId] || "",
            corrected: row.statusEnumId === "AdsCorrected"
        }
    })
    return {
        rows: list,
        totals: {
            dayCount: list.length,
            missingOutCount: byFlag.MISSING_OUT || 0,
            missingInCount: byFlag.MISSING_IN || 0,
            repeatedCount: byFlag.REPEATED || 0,
            correctedCount: list.filter(row => row.corrected).length
        },
        basisText: "Attendance days in the period whose punches lack a clock in or out or repeat one; a corrected day says so.",
        columns: [
            ["personName", "Employee"],
            ["organizationName", "Employer"],
            ["attendanceDateText", "Day"],
            ["flagsText", "Exception"],
            ["stateName", "State"]
        ]
    }
}

// ===== leave balances =====
const ledgerColumns = {
    LletOpening: "grantedQuantity",
    LletGrant: "grantedQuantity",
    LletAccrual: "accruedQuantity",
    LletConsumption: "takenQuantity",
    LletExpiry: "expiredQuantity",
    LletAdjustment: "adjustedQuantity",
    LletReversal: "adjustedQuantity"
}
function leaveBalances(ctx) {
    const {employers, p, found} = ctx
    const asOf = people.asOfMillis(p.thruDate || null)
    const entries = capList(
        find("mantle.humanres.leave.LeaveLedgerEntry")
            .condition("organizationPartyId", "in", employers)
            .condition("effectiveDate", "<=", stamp(asOf))
            .selectField([
                "partyRelationshipId",
                "partyId",
                "organizationPartyId",
                "leaveTypeEnumId",
                "unitEnumId",
                "entryTypeEnumId",
                "amount"
            ]),
        found
    )
    const balances = new Map()
    for (const row of entries) {
        const key = row.partyRelationshipId + "/" + row.leaveTypeEnumId
        if (!balances.has(key))
            balances.set(key, {
                partyRelationshipId: row.partyRelationshipId,
                partyId: row.partyId,
                organizationPartyId: row.organizationPartyId,
                leaveTypeEnumId: row.leaveTypeEnumId,
                unitEnumId: row.unitEnumId,
                grantedQuantity: 0,
                accruedQuantity: 0,
                takenQuantity: 0,
                expiredQuantity: 0,
                adjustedQuantity: 0,
                balanceQuantity: 0
            })
        const balance = balances.get(key)
        const quantity = Number(row.amount == null ? 0 : row.amount.toNumber ? row.amount.toNumber() : row.amount)
        const column = ledgerColumns[row.entryTypeEnumId] || "adjustedQuantity"
        balance[column] += quantity
        balance.balanceQuantity += quantity
    }
    const list = Array.from(balances.values())
    const names = people.personNames(unique(list.map(row => row.partyId)))
    const organizations = people.organizationNames(unique(list.map(row => row.organizationPartyId)))
    const types = enumNames(list.flatMap(row => [row.leaveTypeEnumId, row.unitEnumId]))
    const round = value => Math.round(value * 100) / 100
    return {
        rows: list
            .map(row =>
                Object.assign(row, {
                    personName: names[row.partyId] || row.partyId,
                    organizationName: organizations[row.organizationPartyId] || "",
                    leaveTypeName: types[row.leaveTypeEnumId] || row.leaveTypeEnumId,
                    unitName: types[row.unitEnumId] || "",
                    grantedQuantity: round(row.grantedQuantity),
                    accruedQuantity: round(row.accruedQuantity),
                    takenQuantity: round(row.takenQuantity),
                    expiredQuantity: round(row.expiredQuantity),
                    adjustedQuantity: round(row.adjustedQuantity),
                    balanceQuantity: round(row.balanceQuantity)
                })
            )
            .sort((a, b) => a.personName.localeCompare(b.personName) || a.leaveTypeName.localeCompare(b.leaveTypeName)),
        totals: {balanceCount: list.length},
        asOfText: ec.l10n.format(new Date(asOf), "yyyy-MM-dd"),
        basisText:
            "Each employment's leave by type from the ledger as of the date: granted (opening balances and allocations), accrued, taken (signed), expired and adjusted add up to the balance. Requests waiting for approval reserve days they have not taken yet; they are not in the ledger.",
        columns: [
            ["personName", "Employee"],
            ["organizationName", "Employer"],
            ["leaveTypeName", "Leave type"],
            ["unitName", "Unit"],
            ["grantedQuantity", "Granted"],
            ["accruedQuantity", "Accrued"],
            ["takenQuantity", "Taken"],
            ["expiredQuantity", "Expired"],
            ["adjustedQuantity", "Adjusted"],
            ["balanceQuantity", "Balance"]
        ]
    }
}

// ===== expenses =====
function expenses(ctx) {
    const {employers, p, found} = ctx
    const {fromMs, thruMs} = periodOf(p)
    const claims = capList(
        find("mantle.humanres.expense.ExpenseClaim")
            .condition("organizationPartyId", "in", employers)
            .condition("submittedDate", ">=", stamp(fromMs))
            .condition("submittedDate", "<=", stamp(thruMs))
            .selectField(["invoiceId", "organizationPartyId", "statusEnumId"]),
        found
    )
    const invoices = {}
    const invoiceIds = claims.map(row => row.invoiceId)
    for (let index = 0; index < invoiceIds.length; index += 500)
        for (const row of Array.from(
            find("mantle.account.invoice.Invoice")
                .condition("invoiceId", "in", invoiceIds.slice(index, index + 500))
                .selectField(["invoiceId", "invoiceTotal", "currencyUomId"])
                .list()
        ))
            invoices[row.invoiceId] = row
    const groups = new Map()
    const currencies = new Map()
    for (const claim of claims) {
        const invoice = invoices[claim.invoiceId] || {}
        const currencyUomId = invoice.currencyUomId || ""
        const key = claim.organizationPartyId + "/" + claim.statusEnumId + "/" + currencyUomId
        if (!groups.has(key))
            groups.set(key, {
                organizationPartyId: claim.organizationPartyId,
                statusEnumId: claim.statusEnumId,
                currencyUomId: currencyUomId || null,
                claimCount: 0,
                total: toDecimal(0)
            })
        const group = groups.get(key)
        group.claimCount++
        group.total = group.total.add(toDecimal(invoice.invoiceTotal ?? 0))
        if (!currencies.has(currencyUomId))
            currencies.set(currencyUomId, {currencyUomId: currencyUomId || null, claimCount: 0, total: toDecimal(0)})
        currencies.get(currencyUomId).claimCount++
        currencies.get(currencyUomId).total = currencies.get(currencyUomId).total.add(toDecimal(invoice.invoiceTotal ?? 0))
    }
    const list = Array.from(groups.values())
    const organizations = people.organizationNames(unique(list.map(row => row.organizationPartyId)))
    const states = enumNames(list.map(row => row.statusEnumId))
    const shown = row =>
        Object.assign(row, {
            total: lib.money(row.total, row.currencyUomId),
            totalText: moneyText(row.total, row.currencyUomId)
        })
    return {
        rows: list
            .map(row =>
                shown(
                    Object.assign(row, {
                        organizationName: organizations[row.organizationPartyId] || "",
                        stateName: states[row.statusEnumId] || ""
                    })
                )
            )
            .sort((a, b) => a.organizationName.localeCompare(b.organizationName) || a.stateName.localeCompare(b.stateName)),
        currencyRows: Array.from(currencies.values()).map(shown),
        totals: {claimCount: claims.length},
        basisText:
            "Expense claims submitted in the period, by employer and state now, each currency apart: amounts in different currencies are never added together.",
        columns: [
            ["organizationName", "Employer"],
            ["stateName", "State"],
            ["currencyUomId", "Currency"],
            ["claimCount", "Claims"],
            ["totalText", "Total"]
        ]
    }
}

// ===== qualification expiry =====
function qualifications(ctx) {
    const {employers, p, found} = ctx
    const asOf = text(p.fromDate) ? ec.user.timestampMillis(p.fromDate) : ms(ec.user.nowTimestamp)
    const windowEnd = text(p.thruDate) ? people.asOfMillis(p.thruDate) : asOf + expiryWindowDays * day
    // the current employees of the employers, each with the first employer found (a person employed by two is listed once)
    const employerOf = {}
    for (const row of Array.from(people.current(people.employmentFind().condition("toPartyId", "in", employers), asOf).list()))
        if (!employerOf[row.fromPartyId]) employerOf[row.fromPartyId] = row.toPartyId
    const employees = Object.keys(employerOf)
    const qualificationRows = []
    for (let index = 0; index < employees.length && !found.capped; index += 500) {
        const batch = Array.from(
            find("mantle.humanres.ability.PartyQualification")
                .condition("partyId", "in", employees.slice(index, index + 500))
                .condition("verificationStatusId", "QlVerVerified")
                .condition("thruDate", "is-not-null", null)
                .condition("thruDate", "<=", stamp(windowEnd))
                .selectField(["partyQualificationId", "partyId", "qualificationTypeEnumId", "title", "thruDate"])
                .list()
        )
        qualificationRows.push(...batch)
        if (qualificationRows.length > rowCap) {
            found.capped = true
            qualificationRows.length = rowCap
        }
    }
    // a qualification renewed by a later verified one of the same person is no longer due
    const renewed = new Set()
    const ids = qualificationRows.map(row => row.partyQualificationId)
    for (let index = 0; index < ids.length; index += 500)
        for (const row of Array.from(
            find("mantle.humanres.ability.PartyQualification")
                .condition("renewsQualificationId", "in", ids.slice(index, index + 500))
                .condition("verificationStatusId", "QlVerVerified")
                .selectField(["renewsQualificationId"])
                .list()
        ))
            renewed.add(row.renewsQualificationId)
    const due = qualificationRows.filter(row => !renewed.has(row.partyQualificationId))
    const names = people.personNames(unique(due.map(row => row.partyId)))
    const organizations = people.organizationNames(unique(Object.values(employerOf)))
    const types = enumNames(due.map(row => row.qualificationTypeEnumId))
    const list = due
        .map(row => {
            const expired = ms(row.thruDate) <= asOf
            return {
                partyQualificationId: row.partyQualificationId,
                partyId: row.partyId,
                personName: names[row.partyId] || row.partyId,
                organizationName: organizations[employerOf[row.partyId]] || "",
                qualificationTypeName: types[row.qualificationTypeEnumId] || row.qualificationTypeEnumId || "",
                title: row.title || "",
                expiryText: dateText(row.thruDate),
                expiryMillis: ms(row.thruDate),
                expired,
                stateName: expired ? "Expired" : "Expiring"
            }
        })
        .sort((a, b) => a.expiryMillis - b.expiryMillis || a.personName.localeCompare(b.personName))
    return {
        rows: list,
        totals: {expiredCount: list.filter(row => row.expired).length, expiringCount: list.filter(row => !row.expired).length},
        windowText: ec.l10n.format(new Date(asOf), "yyyy-MM-dd") + " to " + ec.l10n.format(new Date(windowEnd), "yyyy-MM-dd"),
        basisText:
            "The current employees' verified qualifications that expired and were not renewed, or expire by the end of the window (90 days when not chosen); never a document's number.",
        columns: [
            ["personName", "Employee"],
            ["organizationName", "Employer"],
            ["qualificationTypeName", "Type"],
            ["title", "Qualification"],
            ["expiryText", "Expires"],
            ["stateName", "State"]
        ]
    }
}

// ===== review completion =====
const reviewStateFields = {
    PrvInProgress: "assessingCount",
    PrvApproval: "approvalCount",
    PrvFinalized: "finalizedCount",
    PrvReleased: "releasedCount",
    PrvAcknowledged: "acknowledgedCount",
    PrvExcluded: "excludedCount"
}
const completed = ["PrvFinalized", "PrvReleased", "PrvAcknowledged"]
function reviews(ctx) {
    const {employers, p, found} = ctx
    let cycleQuery = find("mantle.humanres.ability.ReviewCycle")
        .condition("organizationPartyId", "in", employers)
        .condition("statusEnumId", "in", ["RcsActive", "RcsClosed"])
    if (text(p.fromDate))
        cycleQuery = cycleQuery.condition(
            either(isNull("periodThruDate"), compare("periodThruDate", ">=", new Date(ec.user.timestampMillis(p.fromDate))))
        )
    if (text(p.thruDate))
        cycleQuery = cycleQuery.condition(
            either(isNull("periodFromDate"), compare("periodFromDate", "<=", new Date(people.asOfMillis(p.thruDate))))
        )
    const cycles = capList(cycleQuery.orderBy("-periodThruDate"), found)
    const counts = {}
    const cycleIds = cycles.map(row => row.reviewCycleId)
    for (let index = 0; index < cycleIds.length; index += 500)
        for (const row of Array.from(
            find("mantle.humanres.ability.PerformanceReview")
                .condition("reviewCycleId", "in", cycleIds.slice(index, index + 500))
                .selectField(["reviewCycleId", "statusEnumId"])
                .list()
        )) {
            const cycleCounts = counts[row.reviewCycleId] || (counts[row.reviewCycleId] = {})
            cycleCounts[row.statusEnumId] = (cycleCounts[row.statusEnumId] || 0) + 1
        }
    const organizations = people.organizationNames(unique(cycles.map(row => row.organizationPartyId)))
    const states = enumNames(cycles.map(row => row.statusEnumId))
    const list = cycles.map(cycle => {
        const cycleCounts = counts[cycle.reviewCycleId] || {}
        const row = {
            reviewCycleId: cycle.reviewCycleId,
            cycleName: cycle.cycleName || cycle.reviewCycleId,
            organizationName: organizations[cycle.organizationPartyId] || "",
            cycleStateName: states[cycle.statusEnumId] || "",
            periodText: [calendarDateText(cycle.periodFromDate), calendarDateText(cycle.periodThruDate)]
                .filter(Boolean)
                .join(" to ")
        }
        for (const [statusId, field] of Object.entries(reviewStateFields)) row[field] = cycleCounts[statusId] || 0
        const counted = Object.entries(cycleCounts)
            .filter(([statusId]) => statusId !== "PrvExcluded")
            .reduce((sum, [, count]) => sum + count, 0)
        const done = completed.reduce((sum, statusId) => sum + (cycleCounts[statusId] || 0), 0)
        row.reviewCount = counted
        row.completedCount = done
        row.completionText = percentText(counted ? (done / counted) * 100 : null)
        return row
    })
    return {
        rows: list,
        totals: {
            reviewCount: list.reduce((sum, row) => sum + row.reviewCount, 0),
            completedCount: list.reduce((sum, row) => sum + row.completedCount, 0)
        },
        basisText:
            "Each started review cycle's reviews by their state now; completed is finalized, released or acknowledged, over the reviews not excluded. Never a rating, an answer or a note.",
        columns: [
            ["cycleName", "Review cycle"],
            ["organizationName", "Employer"],
            ["cycleStateName", "Cycle state"],
            ["reviewCount", "Reviews"],
            ["assessingCount", "Assessing"],
            ["approvalCount", "Waiting for approval"],
            ["completedCount", "Completed"],
            ["completionText", "Completed share"]
        ]
    }
}

// ===== the payroll register (payroll only) =====
const registeredRunStates = ["PrnReview", "PrnApproved", "PrnFinalizing", "PrnFinalized"]
const registeredUnitStates = ["PruCalculated", "PruFinalized"]
const payFields = ["grossAmount", "deductionAmount", "contributionAmount", "netAmount", "employerCostAmount"]
function payrollRegister(ctx) {
    const {employers, p, found} = ctx
    const {fromMs, thruMs} = periodOf(p)
    const runs = Array.from(
        find("mantle.humanres.payroll.PayrollRun")
            .condition("organizationPartyId", "in", employers)
            .condition("statusId", "in", registeredRunStates)
            .condition("payDate", ">=", new Date(fromMs))
            .condition("payDate", "<=", new Date(thruMs))
            .orderBy(["payDate", "payrollRunId"])
            .list()
    )
    const runsById = Object.fromEntries(runs.map(row => [row.payrollRunId, row]))
    const units = capList(
        find("mantle.humanres.payroll.PayrollRunEmployment")
            .condition("payrollRunId", "in", runs.length ? runs.map(row => row.payrollRunId) : ["_NA_"])
            .condition("statusId", "in", registeredUnitStates),
        found
    )
    const names = people.personNames(unique(units.map(row => row.partyId)))
    const groups = Object.fromEntries(
        rows("mantle.humanres.payroll.PayrollGroup", {}).map(row => [row.payrollGroupId, row.groupName || row.payrollGroupId])
    )
    const totals = new Map()
    const list = units.map(unit => {
        const run = runsById[unit.payrollRunId]
        const currencyUomId = run.currencyUomId || null
        const row = {
            payrollRunId: unit.payrollRunId,
            partyId: unit.partyId,
            personName: names[unit.partyId] || unit.partyId,
            groupName: groups[run.payrollGroupId] || run.payrollGroupId || "",
            payDateText: calendarDateText(run.payDate),
            currencyUomId
        }
        if (!totals.has(currencyUomId || ""))
            totals.set(
                currencyUomId || "",
                Object.assign(
                    {currencyUomId, employeeCount: 0},
                    Object.fromEntries(payFields.map(field => [field, toDecimal(0)]))
                )
            )
        const total = totals.get(currencyUomId || "")
        total.employeeCount++
        for (const field of payFields) {
            const value = lib.money(unit[field] ?? 0, currencyUomId)
            row[field] = value
            row[field.replace("Amount", "Text")] = moneyText(value, currencyUomId)
            total[field] = total[field].add(value)
        }
        return row
    })
    const currencyRows = Array.from(totals.values()).map(total => {
        for (const field of payFields) total[field.replace("Amount", "Text")] = moneyText(total[field], total.currencyUomId)
        return total
    })
    return {
        rows: list.sort((a, b) => a.payDateText.localeCompare(b.payDateText) || a.personName.localeCompare(b.personName)),
        currencyRows,
        totals: {employeeCount: list.length, runCount: runs.length},
        basisText:
            "The employees calculated in the pay runs paid in the period (in review, approved or finalized), each run in its own currency; amounts in different currencies are never added together.",
        columns: [
            ["personName", "Employee"],
            ["groupName", "Pay group"],
            ["payDateText", "Pay date"],
            ["currencyUomId", "Currency"],
            ["grossText", "Gross"],
            ["deductionText", "Deductions"],
            ["contributionText", "Contributions"],
            ["netText", "Net"],
            ["employerCostText", "Employer cost"]
        ]
    }
}

// ===== the registered reports =====
// Each: its id, title, description, the capabilities any one of which reads it, the options it takes, and whether it carries pay.
// A later phase adds a report here.
const reports = [
    {
        reportId: "headcount",
        title: "Headcount and turnover",
        description:
            "Headcount at the start and end of a period, joins, exits and turnover with its denominator, by employer or department.",
        needs: ["hrView", "configure"],
        options: ["organizationPartyId", "fromDate", "thruDate", "groupBy"],
        run: headcount
    },
    {
        reportId: "recruiting",
        title: "Vacancies and hiring funnel",
        description: "Vacant seats now and the applications of a period by opening, stage and source.",
        needs: ["recruitView", "hrView"],
        options: ["organizationPartyId", "fromDate", "thruDate"],
        run: recruiting
    },
    {
        reportId: "attendance",
        title: "Attendance exceptions",
        description: "Days of a period with a missing clock in or out or a repeated punch, and whether they were corrected.",
        needs: ["hrView"],
        options: ["organizationPartyId", "fromDate", "thruDate"],
        run: attendance
    },
    {
        reportId: "leaveBalances",
        title: "Leave balances",
        description: "Each employee's leave by type as of a date: granted, accrued, taken, expired, adjusted and the balance.",
        needs: ["hrView"],
        options: ["organizationPartyId", "thruDate"],
        run: leaveBalances
    },
    {
        reportId: "expenses",
        title: "Expense claims",
        description: "Claims submitted in a period by employer and state, counted and totalled in each currency.",
        needs: ["expenseManage", "hrView"],
        options: ["organizationPartyId", "fromDate", "thruDate"],
        run: expenses
    },
    {
        reportId: "qualifications",
        title: "Qualification expiry",
        description: "Verified qualifications of the employees expired and not renewed, or expiring within a window.",
        needs: ["developView", "hrView"],
        options: ["organizationPartyId", "fromDate", "thruDate"],
        run: qualifications
    },
    {
        reportId: "reviews",
        title: "Review completion",
        description: "Each review cycle's reviews by state and the share completed.",
        needs: ["developView", "hrView"],
        options: ["organizationPartyId", "fromDate", "thruDate"],
        run: reviews
    },
    {
        reportId: "payrollRegister",
        title: "Payroll register",
        description:
            "Each employee's gross, deductions, contributions, net and employer cost in the pay runs of a period, by currency.",
        needs: ["payrollView"],
        pay: true,
        options: ["organizationPartyId", "fromDate", "thruDate"],
        run: payrollRegister
    }
]
const readable = (report, caps) => report.needs.some(capability => caps[capability])

// get#Options: the reports the caller reads (with the options each takes) and the employers of their scope; a caller who reads
// none is refused (PERMISSION_DENIED), so Insights' catalog hides People's entries from them.
function options(p) {
    const userScope = people.scopeOf()
    const caps = userScope.capabilities
    const list = reports.filter(report => readable(report, caps))
    if (!list.length) denied("PERMISSION_DENIED", "People reports need HR, recruiting, development, expense or payroll access")
    const names = people.organizationNames(userScope.organizationPartyIds)
    return {
        reports: list.map(report => ({
            reportId: report.reportId,
            title: report.title,
            description: report.description,
            options: report.options,
            pay: !!report.pay
        })),
        employers: userScope.organizationPartyIds
            .map(organizationPartyId => ({
                organizationPartyId,
                organizationName: names[organizationPartyId] || organizationPartyId
            }))
            .sort((a, b) => a.organizationName.localeCompare(b.organizationName))
    }
}

// A cell for a spreadsheet: text a spreadsheet would read as a formula (starting =, +, -, @, a tab or a carriage return) behind an
// apostrophe, a plain number left as it is; quoted when it holds a comma, a quote or a line break.
function csvCell(value) {
    let cell = value == null ? "" : String(value)
    if (!(typeof value === "number" || /^-?\d+(\.\d+)?$/.test(cell)) && /^[=+\-@\t\r]/.test(cell)) cell = "'" + cell
    return /[",\n\r]/.test(cell) ? '"' + cell.replace(/"/g, '""') + '"' : cell
}
function csvOf(report, answer) {
    const lines = [[report.title], ["Options", answer.optionsText], ["Basis", answer.basisText]]
    if (answer.denominatorText) lines.push(["Denominator", answer.denominatorText])
    if (answer.capped) lines.push(["Left out", "Rows past " + rowCap + " were not read"])
    lines.push([])
    lines.push(answer.columns.map(column => column.title))
    for (const row of answer.rows) lines.push(answer.columns.map(column => row[column.name]))
    if (answer.totals && answer.columns.some(column => answer.totals[column.name] != null))
        lines.push(answer.columns.map((column, index) => (index === 0 ? "Total" : (answer.totals[column.name] ?? ""))))
    return lines.map(cells => cells.map(csvCell).join(",")).join("\r\n") + "\r\n"
}

// run#Report: one report the caller reads, over the employers of their scope or the one asked (ORGANIZATION_DENIED outside it);
// with format csv, also its rows as CSV text and a file name.
function run(p) {
    const report = reports.find(row => row.reportId === text(p.reportId))
    if (!report) denied("REPORT_UNAVAILABLE", "Report " + text(p.reportId) + " is not available")
    const userScope = people.scopeOf()
    if (!readable(report, userScope.capabilities))
        denied(
            "PERMISSION_DENIED",
            report.pay ? "The payroll register needs PAYROLL_VIEW" : report.title + " is not available to you"
        )
    const organizationPartyId = text(p.organizationPartyId) || null
    people.requireOrganization(userScope, organizationPartyId)
    const employers = organizationPartyId ? [organizationPartyId] : userScope.organizationPartyIds
    const found = {capped: false}
    const answer = employers.length ? report.run({employers, p, found, userScope}) : {rows: [], totals: {}, columns: []}
    const columns = (answer.columns || []).map(([name, title]) => ({name, title}))
    const optionNames = people.organizationNames(organizationPartyId ? [organizationPartyId] : [])
    const optionsText = [
        organizationPartyId
            ? "Employer: " + (optionNames[organizationPartyId] || organizationPartyId)
            : "Every employer of yours",
        text(p.fromDate) ? "From " + dateText(p.fromDate) : "",
        text(p.thruDate) ? "Through " + dateText(p.thruDate) : "",
        answer.groupBy ? "By " + answer.groupBy : ""
    ]
        .filter(Boolean)
        .join("; ")
    const out = Object.assign({}, answer, {
        reportId: report.reportId,
        title: report.title,
        pay: !!report.pay,
        columns,
        rows: answer.rows || [],
        totals: answer.totals || {},
        capped: found.capped,
        organizationPartyIds: employers,
        optionsText,
        generatedText: ec.l10n.format(new Date(ms(ec.user.nowTimestamp)), "yyyy-MM-dd HH:mm")
    })
    if (p.format === "csv") {
        out.csvText = csvOf(report, out)
        out.fileName =
            "people-" + report.reportId + "-" + ec.l10n.format(new Date(ms(ec.user.nowTimestamp)), "yyyy-MM-dd") + ".csv"
    }
    return out
}

const operations = {options, run}
;({
    execute: (op, parameters) => {
        if (!Object.hasOwn(operations, op)) throw new Error("Unknown People report operation " + op)
        return operations[op](parameters || {})
    },
    csvCell
})
