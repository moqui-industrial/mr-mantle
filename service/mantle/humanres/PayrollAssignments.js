// People's pay assignments and compensation (mantle.humanres.PayrollSetupServices find#Assignments, assign#PayStructure,
// store#PayrollProfile and get#Compensation, and EmploymentServices create#EmploymentSalary; IronStone People design §8.1,
// §8 PayAssignments, §4 Employee360's Compensation; PE-08, PE-12; impl-people P23, F4, F33).
//
// The records (PeoplePayrollEntities.xml):
// - a pay assignment (PayrollAssignment) puts an employment on a published structure and a pay group of its employer, in one
//   currency, from a date: one primary per employment and date across every group (an overlap is refused, or with replaceCurrent
//   the one in effect is ended on the date), a secondary one beside it for another structure; the employment's own values of the
//   structure's declared inputs, and the elective lines it takes (a line's eligibility, PleElected). It keeps no salary:
//   EmploymentSalary stays the salary and RateAmount the hourly rate, and assigning a structure changes neither;
// - a payroll tax profile (PayrollTaxProfile) holds the values of the fields a localization declares (PayrollLocalizationField)
//   from a date, so only the installed localizations' fields exist (the demonstration's alone in this build); Employment's and
//   Employee's historical US tax fields are neither read nor written (F33). Bank details stay the person's payment methods,
//   changed through Accounting's payment-method services: here only a masked reference is read;
// - benefits are Mantle's EmploymentBenefit rows (a type from a date, its cost and the employer's share), added and ended here;
// - a salary (EmploymentSalary) from a date ends the row in effect on it (F4); a later row set already, or one from the same
//   moment, is refused. The pay change (Employment.js, kind EckPayChange) writes through writeSalary after its approval.
//
// Pay never leaves its lane (design §1.1, §2): every answer here is a payroll reader's (PAYROLL_VIEW) of the employers in their
// People scope, and every change a payroll editor's (PAYROLL_VIEW and PAYROLL_EDIT). Another employer's employment or record is
// a missing one (RECORD_UNAVAILABLE). No amount goes to a notice, the shell, the palette or Chatter from here. Each service
// checks its caller first and reads and writes with authorization off after it.
const people = ec.resource.script("component://mr-mantle/service/mantle/humanres/People.js")
const configuration = () => ec.resource.script("component://mr-mantle/service/mantle/humanres/PayrollConfiguration.js")
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const {find, one, rows, denied, call, dateText} = lib

const ASSIGNMENT = "mantle.humanres.payroll.PayrollAssignment"
const PROFILE = "mantle.humanres.payroll.PayrollTaxProfile"
const FIELD = "mantle.humanres.payroll.PayrollLocalizationField"
const LOCALIZATION = "mantle.humanres.payroll.PayrollLocalization"
const STRUCTURE = "mantle.humanres.payroll.PayrollStructure"
const LINE = "mantle.humanres.payroll.PayrollStructureComponent"
const COMPONENT = "mantle.humanres.payroll.PayrollComponent"
const TERM = "mantle.humanres.payroll.PayrollComponentTerm"
const GROUP = "mantle.humanres.payroll.PayrollGroup"
const RELATIONSHIP = "mantle.party.PartyRelationship"
const EMPLOYMENT = "mantle.humanres.employment.Employment"
const CHANGE = "mantle.humanres.employment.EmploymentChange"
const SALARY = "mantle.humanres.employment.EmploymentSalary"
const BENEFIT = "mantle.humanres.employment.EmploymentBenefit"
const RATE = "mantle.humanres.rate.RateAmount"
// the most employments a list reads, and an assignment batch takes
const listCap = 2000
const batchCap = 500
const maxTextLength = 255

const frequencyWords = {
    PayrollYear: "a year",
    PayrollQuarter: "a quarter",
    PayrollMonth: "a month",
    PayrollSemiMonth: "twice a month",
    PayrollBiWeek: "every two weeks",
    PayrollWeek: "a week"
}
const payBases = {PpbSalaried: "Salaried", PpbHourly: "Hourly", PpbMixed: "Salaried and hourly"}
const fieldKinds = ["PpfIndicator", "PpfChoice", "PpfDecimal", "PpfText"]
const identifier = /^[A-Za-z_][A-Za-z0-9_]*$/

const ms = lib.ms
const text = value => String(value ?? "").trim()
const blank = value => value == null || String(value).trim() === ""
const nowMs = () => ms(ec.user.nowTimestamp)
const truthy = value => value === true || value === "true" || value === "Y"
// an effective date (now when empty): the start of a date alone, in the user's zone
const effective = value => (blank(value) ? nowMs() : ec.user.timestampMillis(value))
const when = value => (blank(value) ? null : ec.user.timestampMillis(value))
const stamp = millis => (millis == null ? null : new Date(Number(millis)))
const openAt = (row, at) => (ms(row.fromDate) ?? -Infinity) <= at && (ms(row.thruDate) ?? Infinity) > at
// a row ended on its own start never took effect
const voided = row => row.thruDate != null && ms(row.thruDate) <= (ms(row.fromDate) ?? -Infinity)
const overlaps = (row, fromMs, thruMs) =>
    !voided(row) && (ms(row.fromDate) ?? -Infinity) < (thruMs ?? Infinity) && (ms(row.thruDate) ?? Infinity) > fromMs
const stampOf = row => ms(row?.lastUpdatedStamp) ?? 0
const revisionOf = list => String(Math.max(0, ...list.filter(Boolean).map(stampOf)))
const unique = people.unique
const splitIds = value =>
    blank(value)
        ? []
        : unique((Array.isArray(value) ? value : String(value).split(/[\s,;]+/)).map(id => text(id)).filter(Boolean))
const likeText = value => "%" + String(value).replace(/[\\%_]/g, character => "\\" + character) + "%"

// ===== access =====
function readerScope() {
    const userScope = people.scopeOf()
    if (!userScope.capabilities.payrollView) denied("PERMISSION_DENIED", "Pay and compensation are not available")
    return userScope
}
const edits = userScope => !!(userScope.capabilities.payrollView && userScope.capabilities.payrollEdit)
function editorScope() {
    const userScope = people.scopeOf()
    if (!edits(userScope)) denied("PERMISSION_DENIED", "Changing pay needs PAYROLL_VIEW and PAYROLL_EDIT")
    return userScope
}
const employmentOf = row => ({
    partyRelationshipId: row.partyRelationshipId,
    partyId: row.fromPartyId,
    organizationPartyId: row.toPartyId,
    fromMs: ms(row.fromDate),
    thruMs: ms(row.thruDate)
})
// An employment (a PrtEmployee relationship with its Employment row) of an employer in the caller's scope; refused alike when
// missing or outside (RECORD_UNAVAILABLE).
function employmentIn(userScope, partyRelationshipId) {
    const id = text(partyRelationshipId)
    const row = id ? one(RELATIONSHIP, {partyRelationshipId: id}) : null
    if (
        !row ||
        row.relationshipTypeEnumId !== "PrtEmployee" ||
        !userScope.organizationPartyIds.includes(row.toPartyId) ||
        !one(EMPLOYMENT, {partyRelationshipId: id})
    )
        denied("RECORD_UNAVAILABLE", "Employment " + id + " is not available")
    return employmentOf(row)
}
// a structure or group of an employer in the caller's scope, else a missing one
function readable(userScope, entityName, key, id, label) {
    const row = id ? one(entityName, {[key]: id}) : null
    if (!row || !userScope.organizationPartyIds.includes(row.organizationPartyId))
        denied("RECORD_UNAVAILABLE", label + " " + (id || "") + " is not available")
    return row
}

// ===== salaries (F4) =====
// The salary rows of an employment, oldest first, those that never took effect left out.
const salariesOf = partyRelationshipId =>
    rows(SALARY, {partyRelationshipId})
        .filter(row => !voided(row))
        .sort((a, b) => (ms(a.fromDate) ?? 0) - (ms(b.fromDate) ?? 0))
// The salary revision of an employment: the last change of its salary rows, what a pay change names.
const salaryRevision = partyRelationshipId => revisionOf(rows(SALARY, {partyRelationshipId}))
// A salary from fromMs: the row in effect then ends on it, and the new one starts; a row from the same moment, or a later one set
// already, is refused, so a change never silently chooses between two rows. Written with authorization off: the caller has been
// checked (create#EmploymentSalary for PAYROLL_EDIT, the pay change by its request and approval).
function writeSalary(partyRelationshipId, values, reason) {
    const fromMs = values.fromMs
    checkSalaryDate(partyRelationshipId, fromMs)
    const inEffect = salariesOf(partyRelationshipId).find(row => openAt(row, fromMs))
    if (inEffect) call("update#" + SALARY, {partyRelationshipId, fromDate: inEffect.fromDate, thruDate: stamp(fromMs)})
    call("create#" + SALARY, {
        partyRelationshipId,
        fromDate: stamp(fromMs),
        thruDate: stamp(values.thruMs ?? null),
        amount: values.amount,
        amount_changeReason: reason || null,
        currencyUomId: values.currencyUomId || null,
        timePeriodTypeId: values.timePeriodTypeId || null,
        payGradeId: values.payGradeId || null,
        comments: values.comments || null
    })
    return {fromDate: stamp(fromMs), endedFromDate: inEffect ? inEffect.fromDate : null}
}
// create#EmploymentSalary (extended in P23, F4): PAYROLL_EDIT is checked, and the row in effect is ended on the new one's date.
// The defaults and the band's warnings stay the service's own (EmploymentServices.xml), for its existing callers.
function salaryAccess(p) {
    const userScope = people.scopeOf()
    if (!userScope.capabilities.payrollEdit) denied("PERMISSION_DENIED", "Setting a salary needs PAYROLL_EDIT")
    const relationship = one(RELATIONSHIP, {partyRelationshipId: text(p.partyRelationshipId)})
    if (!relationship || !one(EMPLOYMENT, {partyRelationshipId: text(p.partyRelationshipId)}))
        denied("RECORD_UNAVAILABLE", "Employment " + text(p.partyRelationshipId) + " is not available")
    // an employer outside the caller's scope is a missing one, for a payroll reader (a payroll editor who reads no employer,
    // such as a system integration with PAYROLL_EDIT alone, writes the employment it names, as before)
    if (userScope.capabilities.payrollView && !userScope.organizationPartyIds.includes(relationship.toPartyId))
        denied("RECORD_UNAVAILABLE", "Employment " + text(p.partyRelationshipId) + " is not available")
    return relationship
}
function createSalary(p) {
    const relationship = salaryAccess(p)
    if (p.amount == null || p.amount === "") denied("AMOUNT_REQUIRED", "Enter the salary")
    return writeSalary(
        relationship.partyRelationshipId,
        {
            fromMs: effective(p.fromDate),
            thruMs: when(p.thruDate),
            amount: toDecimal(String(p.amount)),
            currencyUomId: text(p.currencyUomId) || null,
            timePeriodTypeId: text(p.timePeriodTypeId) || null,
            payGradeId: text(p.payGradeId) || null,
            comments: text(p.comments) || null
        },
        text(p.comments) || null
    )
}
// The salary checks of a change from a date (SALARY_EXISTS, SALARY_SCHEDULED), as writeSalary makes them, without writing.
function checkSalaryDate(partyRelationshipId, fromMs) {
    const existing = salariesOf(partyRelationshipId)
    if (existing.some(row => ms(row.fromDate) === fromMs))
        denied("SALARY_EXISTS", "A salary from " + dateText(fromMs) + " is set already")
    const later = existing.find(row => (ms(row.fromDate) ?? -Infinity) > fromMs)
    if (later)
        denied("SALARY_SCHEDULED", "A salary from " + dateText(later.fromDate) + " is set already; a change starts after it")
}
// A pay change's terms (Employment.js, kind EckPayChange): the currency (CURRENCY_REQUIRED, CURRENCY_INVALID), a positive amount
// in its precision (AMOUNT_INVALID, CURRENCY_PRECISION), the pay frequency, a payroll period (FREQUENCY_REQUIRED,
// FREQUENCY_INVALID), and the grade when one is named, the employer's or a shared one (GRADE_INVALID). Answers the terms and,
// as a note, whether the amount is outside the band of the grade in effect then (a note: payroll decides, as before, F4).
function checkPayTerms(employment, p, at) {
    const currencyUomId = text(p.salaryCurrencyUomId)
    if (!currencyUomId) denied("CURRENCY_REQUIRED", "Choose the currency")
    const currency = one("moqui.basic.Uom", {uomId: currencyUomId})
    if (!currency || currency.uomTypeEnumId !== "UT_CURRENCY_MEASURE")
        denied("CURRENCY_INVALID", currencyUomId + " is not a currency")
    const amount = lib.amount(text(p.salaryAmount), currencyUomId)
    const timePeriodTypeId = text(p.salaryPeriodTypeId)
    if (!timePeriodTypeId) denied("FREQUENCY_REQUIRED", "Choose the pay frequency")
    if (!timePeriodTypeId.startsWith("Payroll") || !one("mantle.party.time.TimePeriodType", {timePeriodTypeId}))
        denied("FREQUENCY_INVALID", timePeriodTypeId + " is not a pay frequency")
    const payGradeId = text(p.payGradeId) || null
    let note = null
    if (payGradeId) {
        const grade = one("mantle.humanres.rate.PayGrade", {payGradeId})
        if (!grade || (grade.organizationPartyId && grade.organizationPartyId !== employment.organizationPartyId))
            denied("GRADE_INVALID", "Pay grade " + payGradeId + " is not one of the employer's")
        const band = rows("mantle.humanres.rate.PayGradeSalary", {payGradeId, timePeriodTypeId}).find(
            row => openAt(row, at) && row.currencyUomId === currencyUomId
        )
        if (band?.minAmount != null && amount.compare(band.minAmount) < 0) note = "The salary is below the grade's band"
        if (band?.maxAmount != null && amount.compare(band.maxAmount) > 0) note = "The salary is above the grade's band"
    }
    return {amount, currencyUomId, timePeriodTypeId, payGradeId, note}
}
function frequencyText(timePeriodTypeId) {
    if (!timePeriodTypeId) return ""
    if (frequencyWords[timePeriodTypeId]) return frequencyWords[timePeriodTypeId]
    const type = one("mantle.party.time.TimePeriodType", {timePeriodTypeId})
    return type
        ? String(type.description || timePeriodTypeId)
              .replace(/^Payroll /, "per ")
              .toLowerCase()
        : timePeriodTypeId
}
const moneyText = (amount, currencyUomId) =>
    amount == null ? "" : currencyUomId ? ec.l10n.formatCurrency(amount, currencyUomId) : String(amount)
const salaryText = row =>
    row ? [moneyText(row.amount, row.currencyUomId), frequencyText(row.timePeriodTypeId)].filter(Boolean).join(" ") : ""
function stateAt(row, at) {
    if ((ms(row.thruDate) ?? Infinity) <= at) return {state: "ended", stateText: "Ended"}
    if ((ms(row.fromDate) ?? -Infinity) > at) return {state: "future", stateText: "From " + dateText(row.fromDate)}
    return {state: "current", stateText: "In effect"}
}
function gradeNames(payGradeIds) {
    const ids = unique(payGradeIds.filter(Boolean))
    if (!ids.length) return {}
    return Object.fromEntries(
        Array.from(find("mantle.humanres.rate.PayGrade").condition("payGradeId", "in", ids).list()).map(row => [
            row.payGradeId,
            row.description || row.payGradeId
        ])
    )
}
function salaryRow(row, at, grades) {
    return Object.assign(
        {
            fromDateText: dateText(row.fromDate),
            thruDateText: dateText(row.thruDate),
            amount: row.amount,
            currencyUomId: row.currencyUomId || null,
            timePeriodTypeId: row.timePeriodTypeId || null,
            frequencyText: frequencyText(row.timePeriodTypeId),
            payGradeId: row.payGradeId || null,
            payGradeName: grades[row.payGradeId] || "",
            salaryText: salaryText(row),
            comments: row.comments || ""
        },
        stateAt(row, at)
    )
}
// The pay rates of people in effect on the date (RaprVendor rows: an employee's pay rate, read with PAYROLL_VIEW as
// get#PayRateAccess decides), each {partyId: [row]}.
function ratesAt(partyIds, at) {
    const found = {}
    if (!partyIds.length) return found
    const query = find(RATE).condition("partyId", "in", unique(partyIds)).condition("ratePurposeEnumId", "RaprVendor")
    for (const row of Array.from(people.current(query, at).orderBy("-fromDate").list()))
        (found[row.partyId] || (found[row.partyId] = [])).push(row)
    return found
}
const rateText = row =>
    row
        ? moneyText(row.rateAmount, row.rateCurrencyUomId) +
          (row.timePeriodUomId === "TF_hr" ? " an hour" : row.timePeriodUomId ? " per " + row.timePeriodUomId : "")
        : ""

// ===== assignments =====
const assignmentsOf = partyRelationshipId =>
    rows(ASSIGNMENT, {partyRelationshipId}).sort((a, b) => (ms(a.fromDate) ?? 0) - (ms(b.fromDate) ?? 0))
const isPrimary = row => row.isPrimary !== "N"
const primaryAt = (assignments, at) => assignments.find(row => isPrimary(row) && !voided(row) && openAt(row, at)) || null
const nextPrimary = (assignments, at) =>
    assignments.find(row => isPrimary(row) && !voided(row) && (ms(row.fromDate) ?? -Infinity) > at) || null
// A structure in effect on a date: published, started, not ended.
const structureInEffect = (structure, at) => !!structure && structure.statusId === "PtsPublished" && openAt(structure, at)
function byIds(entityName, key, ids) {
    const list = unique(ids.filter(Boolean))
    if (!list.length) return {}
    return Object.fromEntries(Array.from(find(entityName).condition(key, "in", list).list()).map(row => [row[key], row]))
}
// The required fields of each localization ({payrollLocalizationId: [field]}) and the fields of one, in order.
function fieldsOf(payrollLocalizationId) {
    return Array.from(find(FIELD, {payrollLocalizationId}).orderBy("sequenceNum").list())
}
// An employment's profile of a localization in effect on the date.
const profileAt = (partyRelationshipId, payrollLocalizationId, at) =>
    rows(PROFILE, {partyRelationshipId, payrollLocalizationId}).find(row => !voided(row) && openAt(row, at)) || null
// An employment's payroll readiness on a date (design §8 PayAssignments' readiness; HireEmployee's "missing payroll setup is a
// visible exception, not an invented salary"): what still stops its preview run, never an amount. The group's own readiness
// (preview only in this build) is the group's, on PayGroups.
function readinessOf(facts, at) {
    const out = (state, reasonCode, message) => ({state, reasonCode, message})
    const {primary, structure, group, salary, rates, localization, requiredFields, profile} = facts
    if (!primary) return out("warning", "NO_ASSIGNMENT", "No pay assignment: give the employment a structure and a pay group")
    if (!structureInEffect(structure, at))
        return out("failed", "STRUCTURE_NOT_IN_EFFECT", "The structure " + (structure?.structureName || "") + " is not in effect")
    if (!group || (ms(group.thruDate) ?? Infinity) <= at)
        return out("failed", "GROUP_ENDED", "The pay group " + (group?.groupName || "") + " has ended")
    const basis = structure.payBasisEnumId
    if ((basis === "PpbSalaried" || basis === "PpbMixed") && !salary)
        return out("warning", "SALARY_MISSING", "The structure pays a salary and the employment has none")
    if (salary && salary.currencyUomId && salary.currencyUomId !== group.currencyUomId)
        return out("failed", "CURRENCY_MISMATCH", "The salary is not in the pay group's currency, " + group.currencyUomId)
    if ((basis === "PpbHourly" || basis === "PpbMixed") && !(rates || []).length)
        return out("warning", "RATE_MISSING", "The structure pays by the hour and the person has no pay rate")
    if ((rates || []).some(rate => rate.rateCurrencyUomId && rate.rateCurrencyUomId !== group.currencyUomId))
        return out("failed", "CURRENCY_MISMATCH", "The pay rate is not in the pay group's currency, " + group.currencyUomId)
    if (localization && (requiredFields || []).length) {
        if (!profile)
            return out(
                "warning",
                "PROFILE_MISSING",
                "No tax profile for " + (localization.localizationName || localization.payrollLocalizationId)
            )
        const values = lib.json(profile.profileValues, {}) || {}
        const missing = requiredFields.filter(field => blank(values[field.fieldName]))
        if (missing.length)
            return out(
                "warning",
                "PROFILE_INCOMPLETE",
                "The tax profile lacks " + missing.map(field => field.fieldLabel || field.fieldName).join(", ")
            )
    }
    return out("ready", null, "Ready for a preview run")
}
// The readiness facts of employments on a date, read in a few queries ({partyRelationshipId: facts}).
function factsOf(employments, at) {
    const ids = employments.map(row => row.partyRelationshipId)
    const assignments = {}
    if (ids.length)
        for (const row of Array.from(find(ASSIGNMENT).condition("partyRelationshipId", "in", ids).list()))
            (assignments[row.partyRelationshipId] = assignments[row.partyRelationshipId] || []).push(row)
    for (const list of Object.values(assignments)) list.sort((a, b) => (ms(a.fromDate) ?? 0) - (ms(b.fromDate) ?? 0))
    const primaries = Object.fromEntries(ids.map(id => [id, primaryAt(assignments[id] || [], at)]))
    const next = Object.fromEntries(ids.map(id => [id, nextPrimary(assignments[id] || [], at)]))
    const shown = Object.values(primaries).concat(Object.values(next)).filter(Boolean)
    const structures = byIds(
        STRUCTURE,
        "payrollStructureId",
        shown.map(row => row.payrollStructureId)
    )
    const groups = byIds(
        GROUP,
        "payrollGroupId",
        shown.map(row => row.payrollGroupId)
    )
    const localizations = byIds(
        LOCALIZATION,
        "payrollLocalizationId",
        Object.values(groups).map(row => row.payrollLocalizationId)
    )
    const required = {}
    for (const payrollLocalizationId of Object.keys(localizations))
        required[payrollLocalizationId] = fieldsOf(payrollLocalizationId).filter(field => field.isRequired === "Y")
    const salaries = {}
    if (ids.length)
        for (const row of Array.from(people.current(find(SALARY).condition("partyRelationshipId", "in", ids), at).list()))
            if (!voided(row)) salaries[row.partyRelationshipId] = row
    const rates = ratesAt(
        employments.map(row => row.partyId),
        at
    )
    const profiles = {}
    if (ids.length)
        for (const row of Array.from(people.current(find(PROFILE).condition("partyRelationshipId", "in", ids), at).list()))
            if (!voided(row)) profiles[row.partyRelationshipId + "/" + row.payrollLocalizationId] = row
    const facts = {}
    for (const employment of employments) {
        const id = employment.partyRelationshipId
        const primary = primaries[id]
        const group = primary ? groups[primary.payrollGroupId] : null
        const localization = group?.payrollLocalizationId ? localizations[group.payrollLocalizationId] : null
        facts[id] = {
            employment,
            assignments: assignments[id] || [],
            primary,
            next: next[id],
            structure: primary ? structures[primary.payrollStructureId] : null,
            group,
            salary: salaries[id] || null,
            rates: rates[employment.partyId] || [],
            localization,
            requiredFields: localization ? required[localization.payrollLocalizationId] || [] : [],
            profile: localization ? profiles[id + "/" + localization.payrollLocalizationId] || null : null,
            structures,
            groups
        }
    }
    return facts
}
// The current employments of the employers on the date with no primary pay assignment in effect, counted (People's readiness).
function unassignedCount(organizationPartyIds, at) {
    if (!organizationPartyIds.length) return 0
    const employments = Array.from(
        people.current(people.employmentFind().condition("toPartyId", "in", organizationPartyIds), at).list()
    ).map(row => row.partyRelationshipId)
    if (!employments.length) return 0
    const assigned = new Set(
        Array.from(
            people
                .current(
                    find(ASSIGNMENT)
                        .condition("partyRelationshipId", "in", employments)
                        .condition("isPrimary", "not-equals", "N"),
                    at
                )
                .selectField("partyRelationshipId")
                .list()
        ).map(row => row.partyRelationshipId)
    )
    return unique(employments).filter(id => !assigned.has(id)).length
}
function assignmentRow(row, at, structures, groups, components, userScope) {
    const structure = structures[row.payrollStructureId]
    const group = groups[row.payrollGroupId]
    const inputs = lib.json(row.inputValues, {}) || {}
    const elected = splitIds(row.electedComponentIds)
    return Object.assign(
        {
            payrollAssignmentId: row.payrollAssignmentId,
            partyRelationshipId: row.partyRelationshipId,
            payrollStructureId: row.payrollStructureId,
            structureName: structure?.structureName || row.payrollStructureId,
            payBasisText: payBases[structure?.payBasisEnumId] || "",
            payrollGroupId: row.payrollGroupId,
            groupName: group?.groupName || row.payrollGroupId,
            currencyUomId: group?.currencyUomId || structure?.currencyUomId || null,
            isPrimary: isPrimary(row),
            kindText: isPrimary(row) ? "Primary" : "Secondary",
            fromDateText: dateText(row.fromDate),
            thruDateText: dateText(row.thruDate),
            inputValuesText: Object.entries(inputs)
                .map(([name, value]) => name + " = " + value)
                .join(", "),
            electedText: elected
                .map(id => (components[id] ? components[id].componentCode + " · " + components[id].componentName : id))
                .join(", "),
            reason: row.reason || "",
            revision: String(stampOf(row)),
            canEnd: edits(userScope) && (ms(row.thruDate) ?? Infinity) > nowMs() && !voided(row)
        },
        voided(row) ? {state: "withdrawn", stateText: "Never in effect"} : stateAt(row, at)
    )
}

// ===== find#Assignments =====
// The employments of the employers the caller reads (or the one asked for) current on asOfDate, each with its primary pay
// assignment in effect (or the next one), its structure and group, its salary and pay rate references and its readiness; found
// by the person's name ignoring case, filtered by group, structure or readiness (ready, attention or unassigned), paged. With
// partyRelationshipId, that employment alone (any dates) and every pay assignment it has had.
const readinessFilters = {
    ready: row => row.readinessState === "ready",
    attention: row => row.readinessState !== "ready",
    unassigned: row => row.readinessCode === "NO_ASSIGNMENT"
}
function findAssignments(p) {
    const userScope = readerScope()
    const at = people.asOfMillis(p.asOfDate)
    const out = {canEdit: edits(userScope), asOfDate: at, assignments: [], employment: null, history: []}
    if (!blank(p.readiness) && !Object.hasOwn(readinessFilters, text(p.readiness)))
        denied("FILTER_INVALID", "Choose ready, attention or unassigned")
    let employments
    if (text(p.partyRelationshipId)) employments = [employmentIn(userScope, p.partyRelationshipId)]
    else {
        const organizationPartyIds = text(p.organizationPartyId)
            ? (people.requireOrganization(userScope, text(p.organizationPartyId)), [text(p.organizationPartyId)])
            : userScope.organizationPartyIds
        if (!organizationPartyIds.length) return Object.assign(out, lib.pageList([], p, "assignments"))
        let query = find("mantle.party.PartyFromAndRelationship")
            .condition("relationshipTypeEnumId", "PrtEmployee")
            .condition("toPartyId", "in", organizationPartyIds)
            .selectField(["partyRelationshipId", "fromPartyId", "toPartyId", "fromDate", "thruDate"])
        if (text(p.term)) {
            const factory = ec.entity.conditionFactory
            query = query.condition(
                factory.makeCondition(
                    ["fromPartyId", "firstName", "lastName"].map(field =>
                        factory.makeCondition(field, "like", likeText(text(p.term))).ignoreCase()
                    ),
                    "or"
                )
            )
        }
        employments = Array.from(people.current(query, at).limit(listCap).list()).map(employmentOf)
    }
    const facts = factsOf(employments, at)
    const names = people.personNames(unique(employments.map(row => row.partyId)))
    const organizations = people.organizationNames(unique(employments.map(row => row.organizationPartyId)))
    let list = employments.map(employment => {
        const fact = facts[employment.partyRelationshipId]
        const shown = fact.primary || fact.next
        const structure = shown ? fact.structures[shown.payrollStructureId] : null
        const group = shown ? fact.groups[shown.payrollGroupId] : null
        const readiness = readinessOf(fact, at)
        return {
            partyRelationshipId: employment.partyRelationshipId,
            partyId: employment.partyId,
            personName: names[employment.partyId] || employment.partyId,
            organizationPartyId: employment.organizationPartyId,
            organizationName: organizations[employment.organizationPartyId] || "",
            payrollAssignmentId: shown?.payrollAssignmentId || null,
            payrollStructureId: shown?.payrollStructureId || null,
            structureName: structure?.structureName || "",
            payBasisText: payBases[structure?.payBasisEnumId] || "",
            payrollGroupId: shown?.payrollGroupId || null,
            groupName: group?.groupName || "",
            fromDateText: shown ? dateText(shown.fromDate) : "",
            thruDateText: shown ? dateText(shown.thruDate) : "",
            assignmentText: !shown ? "None" : fact.primary ? "In effect" : "From " + dateText(shown.fromDate),
            salaryText: salaryText(fact.salary),
            rateText: rateText(fact.rates[0]),
            readinessState: readiness.state,
            readinessCode: readiness.reasonCode,
            readinessText: readiness.message,
            canEdit: out.canEdit
        }
    })
    // the filters narrow a list; an employment asked for by id is answered whatever they say
    if (!text(p.partyRelationshipId)) {
        if (text(p.payrollGroupId)) list = list.filter(row => row.payrollGroupId === text(p.payrollGroupId))
        if (text(p.payrollStructureId)) list = list.filter(row => row.payrollStructureId === text(p.payrollStructureId))
        if (text(p.readiness)) list = list.filter(readinessFilters[text(p.readiness)])
    }
    list.sort((a, b) => a.personName.localeCompare(b.personName) || a.organizationName.localeCompare(b.organizationName))
    if (text(p.partyRelationshipId)) {
        const fact = facts[employments[0].partyRelationshipId]
        out.employment = list[0]
        const structures = byIds(
            STRUCTURE,
            "payrollStructureId",
            fact.assignments.map(row => row.payrollStructureId)
        )
        const groups = byIds(
            GROUP,
            "payrollGroupId",
            fact.assignments.map(row => row.payrollGroupId)
        )
        const components = byIds(
            COMPONENT,
            "payrollComponentId",
            fact.assignments.flatMap(row => splitIds(row.electedComponentIds))
        )
        out.history = fact.assignments
            .slice()
            .reverse()
            .map(row => assignmentRow(row, at, structures, groups, components, userScope))
    }
    return Object.assign(out, lib.pageList(list, p, "assignments", {noLimitCap: listCap}))
}

// ===== assign#PayStructure =====
// The declared inputs of a structure's components (a term's inputNames: of its published terms in effect from the date, else
// any of its terms) and the components of its elective lines on the date.
function structureTerms(structure, at) {
    const lines = rows(LINE, {payrollStructureId: structure.payrollStructureId}).filter(
        line => line.statusId === "PtsPublished" && !voided(line) && (ms(line.thruDate) ?? Infinity) > at
    )
    const componentIds = unique(lines.map(line => line.payrollComponentId))
    const inputs = new Set()
    if (componentIds.length)
        for (const term of Array.from(
            find(TERM).condition("payrollComponentId", "in", componentIds).condition("statusId", "PtsPublished").list()
        ))
            if ((ms(term.thruDate) ?? Infinity) > at)
                for (const name of splitIds(term.inputNames)) if (identifier.test(name)) inputs.add(name)
    return {
        inputs,
        electable: new Set(lines.filter(line => line.eligibilityEnumId === "PleElected").map(line => line.payrollComponentId))
    }
}
// The terms of an assignment checked once for every employment: the structure and the group of one employer in scope, in one
// currency, the structure published and in effect on the date and the group not ended; the inputs the structure's components
// declare (and no name that is one of the employer's component codes, which an input would shadow); the elections among its
// elective lines.
function assignmentTerms(userScope, p) {
    const structure = readable(userScope, STRUCTURE, "payrollStructureId", text(p.payrollStructureId), "Pay structure")
    const group = readable(userScope, GROUP, "payrollGroupId", text(p.payrollGroupId), "Pay group")
    if (group.organizationPartyId !== structure.organizationPartyId)
        denied("EMPLOYER_CHANGE", "The pay group and the structure are different employers'")
    if (group.currencyUomId !== structure.currencyUomId)
        denied(
            "CURRENCY_MISMATCH",
            "The group pays in " + group.currencyUomId + " and the structure is in " + structure.currencyUomId
        )
    const fromMs = effective(p.fromDate)
    const thruMs = when(p.thruDate)
    if (thruMs != null && thruMs <= fromMs) denied("DATES_INVALID", "The end is after the start")
    if (!structureInEffect(structure, fromMs))
        denied(
            "STRUCTURE_NOT_PUBLISHED",
            "The structure " + structure.structureName + " is not published and in effect on that date"
        )
    if ((ms(group.thruDate) ?? Infinity) <= fromMs)
        denied("GROUP_ENDED", "The pay group " + group.groupName + " has ended by then")
    const terms = structureTerms(structure, fromMs)
    const inputs = configuration().valuesOf(p.inputValues, "inputs")
    const codes = new Set(
        rows(COMPONENT, {organizationPartyId: structure.organizationPartyId}).map(component => component.componentCode)
    )
    for (const name of Object.keys(inputs)) {
        if (codes.has(name)) denied("INPUT_INVALID", name + " is a component's code; an input may not take it")
        if (!terms.inputs.has(name)) denied("INPUT_UNKNOWN", name + " is not an input the structure's components declare")
    }
    const elected = splitIds(p.electedComponentIds)
    for (const payrollComponentId of elected)
        if (!terms.electable.has(payrollComponentId))
            denied("ELECTION_INVALID", "Component " + payrollComponentId + " is not an elective line of the structure")
    return {
        structure,
        group,
        fromMs,
        thruMs,
        inputs,
        elected,
        primary: p.isPrimary == null || p.isPrimary === "" ? true : truthy(p.isPrimary)
    }
}
// Whether an employment may take the assignment: the structure's employer's, in scope (EMPLOYMENT_OUTSIDE), employed on the date
// (DATE_OUTSIDE), and no other primary assignment then (PRIMARY_OVERLAP), but the one in effect on the date that replaceCurrent
// ends there; a secondary one is refused beside the same structure (STRUCTURE_ASSIGNED). Answers the assignment it would end.
function checkAssignable(userScope, terms, partyRelationshipId, replaceCurrent) {
    const relationship = one(RELATIONSHIP, {partyRelationshipId})
    if (
        !relationship ||
        relationship.relationshipTypeEnumId !== "PrtEmployee" ||
        relationship.toPartyId !== terms.structure.organizationPartyId ||
        !userScope.organizationPartyIds.includes(relationship.toPartyId)
    )
        denied("EMPLOYMENT_OUTSIDE", "Employment " + partyRelationshipId + " is not one of the structure's employer")
    const employment = employmentOf(relationship)
    if (!openAt({fromDate: employment.fromMs, thruDate: employment.thruMs}, terms.fromMs))
        denied("DATE_OUTSIDE", "The person is not employed on that date")
    const existing = assignmentsOf(partyRelationshipId)
    if (!terms.primary) {
        if (
            existing.some(
                row => row.payrollStructureId === terms.structure.payrollStructureId && overlaps(row, terms.fromMs, terms.thruMs)
            )
        )
            denied("STRUCTURE_ASSIGNED", "The employment has this structure then already")
        return {employment, replaced: null}
    }
    const clashes = existing.filter(row => isPrimary(row) && overlaps(row, terms.fromMs, terms.thruMs))
    const current = clashes.find(row => (ms(row.fromDate) ?? -Infinity) < terms.fromMs)
    const blocking = clashes.filter(row => !(replaceCurrent && row === current))
    if (blocking.length) {
        const structure = one(STRUCTURE, {payrollStructureId: blocking[0].payrollStructureId})
        denied(
            "PRIMARY_OVERLAP",
            "Already paid under " +
                (structure?.structureName || blocking[0].payrollStructureId) +
                " from " +
                dateText(blocking[0].fromDate) +
                (replaceCurrent ? "" : "; replace it from the date, or end it first")
        )
    }
    return {employment, replaced: replaceCurrent ? current || null : null}
}
// a row of a batch: the person, and the outcome (ready, done, repeated or refused with its code)
function refusedRow(row, error) {
    row.outcome = "refused"
    row.reasonCode = lib.reasonCode(error) || "FAILED"
    row.message = String(error?.message || error).replace(/^[A-Z][A-Z0-9_]+: /, "")
    return row
}
const outcomeTexts = {ready: "Ready", done: "Assigned", repeated: "Already assigned", refused: "Not assigned"}
// fn for one row in its own transaction; a refusal or failure names the row and the rest go on
function inOwnTransaction(row, what, fn) {
    ec.message.pushErrors()
    try {
        ec.transaction.runRequireNew(null, what + " " + row.partyRelationshipId + " failed", () => {
            fn()
            if (ec.message.hasError()) throw new Error(ec.message.getErrorsString())
        })
    } catch (error) {
        if (!lib.reasonCode(error)) ec.logger.error(what + " " + row.partyRelationshipId + " failed: " + error.message)
        refusedRow(row, error)
    } finally {
        ec.message.clearErrors()
        ec.message.popErrors()
    }
}
const lockEmployment = partyRelationshipId => find(RELATIONSHIP, {partyRelationshipId}).forUpdate(true).one()
function endAssignment(userScope, p) {
    const row = one(ASSIGNMENT, {payrollAssignmentId: text(p.payrollAssignmentId)})
    if (!row || !userScope.organizationPartyIds.includes(row.organizationPartyId))
        denied("RECORD_UNAVAILABLE", "Pay assignment " + text(p.payrollAssignmentId) + " is not available")
    if (text(p.expectedRevision) !== String(stampOf(row)))
        denied("REVISION_CHANGED", "This pay assignment changed since you read it; open it again (revision " + stampOf(row) + ")")
    const thruMs = effective(p.thruDate)
    if (voided(row) || (row.thruDate != null && ms(row.thruDate) <= thruMs))
        denied("ASSIGNMENT_ENDED", "The pay assignment has ended by then")
    if (thruMs < nowMs() - 24 * 60 * 60 * 1000 && (ms(row.fromDate) ?? -Infinity) < thruMs)
        denied("EFFECTIVE_DATE_PAST", "A pay assignment in effect is ended from today on, not in the past")
    call("update#" + ASSIGNMENT, {
        payrollAssignmentId: row.payrollAssignmentId,
        thruDate: stamp(Math.max(thruMs, ms(row.fromDate) ?? -Infinity)),
        thruDate_changeReason: text(p.reason) || null
    })
    return {rows: [], assignedCount: 0, readyCount: 0, repeatedCount: 0, refusedCount: 0, ended: true}
}
// assign#PayStructure: employments put on a structure and a pay group from a date (those named, at most 500), each in its own
// transaction under the employment's lock, a refusal named and the rest going on; with preview, the rows and their outcome,
// nothing written; with an operation key, a retry answers the rows assigned already. Or, with end, one assignment ended.
function assignPayStructure(p) {
    const userScope = editorScope()
    if (truthy(p.end)) return endAssignment(userScope, p)
    const terms = assignmentTerms(userScope, p)
    const replaceCurrent = truthy(p.replaceCurrent)
    if (replaceCurrent && blank(p.reason)) denied("REASON_REQUIRED", "Say why the pay assignment in effect is replaced")
    const listed =
        p.partyRelationshipIds == null
            ? []
            : typeof p.partyRelationshipIds === "string"
              ? splitIds(p.partyRelationshipIds)
              : Array.from(p.partyRelationshipIds)
    const named = splitIds(listed.concat(text(p.partyRelationshipId) ? [text(p.partyRelationshipId)] : []))
    if (!named.length) denied("EMPLOYMENT_REQUIRED", "Choose the employees")
    if (named.length > batchCap) denied("TOO_MANY", "Assign at most " + batchCap + " employees at once")
    const operationKey = text(p.operationKey) || null
    const batchRows = named.map(partyRelationshipId => {
        const relationship = one(RELATIONSHIP, {partyRelationshipId})
        const row = {partyRelationshipId, partyId: relationship?.fromPartyId || null, outcome: "ready"}
        try {
            if (
                operationKey &&
                rows(ASSIGNMENT, {operationKey, partyRelationshipId, payrollStructureId: terms.structure.payrollStructureId})
                    .length
            )
                row.outcome = "repeated"
            else {
                const checked = checkAssignable(userScope, terms, partyRelationshipId, replaceCurrent)
                row.replacesText = checked.replaced ? "Ends the assignment from " + dateText(checked.replaced.fromDate) : ""
            }
        } catch (error) {
            refusedRow(row, error)
        }
        return row
    })
    if (!truthy(p.preview))
        for (const row of batchRows.filter(row => row.outcome === "ready"))
            inOwnTransaction(row, "Assigning a pay structure to employment", () => {
                lockEmployment(row.partyRelationshipId)
                const checked = checkAssignable(userScope, terms, row.partyRelationshipId, replaceCurrent)
                if (checked.replaced)
                    call("update#" + ASSIGNMENT, {
                        payrollAssignmentId: checked.replaced.payrollAssignmentId,
                        thruDate: stamp(terms.fromMs),
                        thruDate_changeReason: text(p.reason) || null
                    })
                const created = call("create#" + ASSIGNMENT, {
                    partyRelationshipId: row.partyRelationshipId,
                    partyId: checked.employment.partyId,
                    organizationPartyId: checked.employment.organizationPartyId,
                    payrollStructureId: terms.structure.payrollStructureId,
                    payrollGroupId: terms.group.payrollGroupId,
                    isPrimary: terms.primary ? "Y" : "N",
                    fromDate: stamp(terms.fromMs),
                    thruDate: stamp(terms.thruMs),
                    inputValues: Object.keys(terms.inputs).length ? JSON.stringify(terms.inputs) : null,
                    electedComponentIds: terms.elected.length ? terms.elected.join(",") : null,
                    reason: text(p.reason) || null,
                    operationKey,
                    assignedByUserId: ec.user.userId || null,
                    createdDate: ec.user.nowTimestamp
                })
                row.payrollAssignmentId = created.payrollAssignmentId
                row.outcome = "done"
            })
    const persons = people.personNames(unique(batchRows.map(row => row.partyId).filter(Boolean)))
    for (const row of batchRows) {
        row.personName = persons[row.partyId] || row.partyId || row.partyRelationshipId
        row.outcomeText = outcomeTexts[row.outcome] || row.outcome
        row.message = row.message || row.replacesText || ""
    }
    batchRows.sort((a, b) => String(a.personName).localeCompare(String(b.personName)))
    return {
        rows: batchRows,
        assignedCount: batchRows.filter(row => row.outcome === "done").length,
        readyCount: batchRows.filter(row => row.outcome === "ready").length,
        repeatedCount: batchRows.filter(row => row.outcome === "repeated").length,
        refusedCount: batchRows.filter(row => row.outcome === "refused").length,
        ended: false
    }
}

// ===== store#PayrollProfile =====
// A choice's values ("value = label" lines) as options.
const optionsOf = field =>
    String(field.optionValues || "")
        .split(/\n+/)
        .map(line => line.trim())
        .filter(Boolean)
        .map(line => {
            const at = line.indexOf("=")
            return at < 0 ? {value: line, label: line} : {value: line.slice(0, at).trim(), label: line.slice(at + 1).trim()}
        })
// The profile's values given: a map, a JSON object or "name = value" pairs separated by semicolons or lines.
function profileEntries(value) {
    if (value == null || value === "") return {}
    if (typeof value === "object") return Object.assign({}, value)
    const source = String(value).trim()
    if (!source) return {}
    if (source.startsWith("{")) {
        try {
            return JSON.parse(source)
        } catch (_) {
            denied("VALUE_INVALID", "The profile's values are not readable")
        }
    }
    const out = {}
    for (const part of source
        .split(/[;\n]+/)
        .map(item => item.trim())
        .filter(Boolean)) {
        const at = part.indexOf("=")
        if (at < 0) denied("VALUE_INVALID", "Write the profile's values as name = value: " + part)
        out[part.slice(0, at).trim()] = part.slice(at + 1).trim()
    }
    return out
}
// Each value checked by its declared field (FIELD_UNKNOWN for a field the localization does not declare), a required one given
// (FIELD_REQUIRED); answers the values kept, empty ones left out.
function checkedProfile(fields, given) {
    const byName = Object.fromEntries(fields.map(field => [field.fieldName, field]))
    const values = {}
    for (const [name, raw] of Object.entries(given)) {
        const field = byName[name]
        if (!field) denied("FIELD_UNKNOWN", name + " is not a field of the localization")
        const value = text(raw)
        if (!value) continue
        switch (field.fieldKindEnumId) {
            case "PpfIndicator":
                if (!["Y", "N"].includes(value)) denied("VALUE_INVALID", (field.fieldLabel || name) + " is yes or no")
                break
            case "PpfChoice":
                if (!optionsOf(field).some(option => option.value === value))
                    denied("VALUE_INVALID", (field.fieldLabel || name) + " is one of its listed values")
                break
            case "PpfDecimal":
                try {
                    toDecimal(value)
                } catch (_) {
                    denied("VALUE_INVALID", (field.fieldLabel || name) + " is a number")
                }
                break
            default:
                if (value.length > maxTextLength) denied("VALUE_INVALID", (field.fieldLabel || name) + " is too long")
        }
        values[name] = value
    }
    for (const field of fields)
        if (field.isRequired === "Y" && blank(values[field.fieldName]))
            denied("FIELD_REQUIRED", "Give " + (field.fieldLabel || field.fieldName))
    return values
}
const profileRevision = (partyRelationshipId, payrollLocalizationId) =>
    revisionOf(rows(PROFILE, {partyRelationshipId, payrollLocalizationId}))
const benefitRevision = partyRelationshipId => revisionOf(rows(BENEFIT, {partyRelationshipId}))
function storeBenefit(employment, p) {
    const benefitTypeId = text(p.benefitTypeId)
    const partyRelationshipId = employment.partyRelationshipId
    if (truthy(p.endBenefit)) {
        const wanted = /^\d+$/.test(text(p.benefitFromDate)) ? Number(text(p.benefitFromDate)) : when(p.benefitFromDate)
        const row = rows(BENEFIT, {partyRelationshipId, benefitTypeId}).find(item => ms(item.fromDate) === wanted)
        if (!row) denied("RECORD_UNAVAILABLE", "That benefit is not this employment's")
        const thruMs = effective(p.thruDate)
        if (row.thruDate != null && ms(row.thruDate) <= thruMs) denied("BENEFIT_ENDED", "The benefit has ended by then")
        call("update#" + BENEFIT, {
            partyRelationshipId,
            benefitTypeId,
            fromDate: row.fromDate,
            thruDate: stamp(Math.max(thruMs, ms(row.fromDate) ?? -Infinity))
        })
        return {revision: benefitRevision(partyRelationshipId)}
    }
    if (!one("mantle.humanres.employment.BenefitType", {benefitTypeId})) denied("VALUE_INVALID", "Choose a benefit")
    const fromMs = effective(p.fromDate)
    const thruMs = when(p.thruDate)
    if (thruMs != null && thruMs <= fromMs) denied("DATES_INVALID", "The end is after the start")
    if (!openAt({fromDate: employment.fromMs, thruDate: employment.thruMs}, fromMs))
        denied("DATE_OUTSIDE", "The person is not employed on that date")
    if (rows(BENEFIT, {partyRelationshipId, benefitTypeId}).some(row => overlaps(row, fromMs, thruMs)))
        denied("BENEFIT_EXISTS", "The employment has this benefit then already")
    let cost = null
    if (!blank(p.cost)) {
        try {
            cost = toDecimal(text(p.cost))
        } catch (_) {
            denied("AMOUNT_INVALID", "The cost is a number")
        }
        if (cost.compare(0) < 0) denied("AMOUNT_INVALID", "The cost is not negative")
    }
    let share = null
    if (!blank(p.employerPaidPercent)) {
        share = Number(text(p.employerPaidPercent))
        if (!Number.isFinite(share) || share < 0 || share > 100)
            denied("PERCENT_INVALID", "The employer's share is a percentage from 0 to 100")
    }
    call("create#" + BENEFIT, {
        partyRelationshipId,
        benefitTypeId,
        fromDate: stamp(fromMs),
        thruDate: stamp(thruMs),
        cost,
        actualEmployerPaidPercent: share
    })
    return {revision: benefitRevision(partyRelationshipId)}
}
// store#PayrollProfile: an employment's tax profile for a localization from a date (the one in effect ends then; one from the same
// moment is replaced, a later one refused), at its revision; or a benefit added or ended.
function storePayrollProfile(p) {
    const userScope = editorScope()
    const employment = employmentIn(userScope, p.partyRelationshipId)
    if (!blank(p.benefitTypeId)) return Object.assign({payrollTaxProfileId: null}, storeBenefit(employment, p))
    const payrollLocalizationId = text(p.payrollLocalizationId)
    const localization = payrollLocalizationId ? one(LOCALIZATION, {payrollLocalizationId}) : null
    if (!localization) denied("LOCALIZATION_INVALID", "Choose a registered localization")
    const partyRelationshipId = employment.partyRelationshipId
    const revision = profileRevision(partyRelationshipId, payrollLocalizationId)
    if (text(p.expectedRevision) !== revision)
        denied("REVISION_CHANGED", "This tax profile changed since you read it; open it again (revision " + revision + ")")
    const fields = fieldsOf(payrollLocalizationId)
    if (!fields.length)
        denied("NO_FIELDS", (localization.localizationName || payrollLocalizationId) + " declares no profile fields")
    for (const field of fields)
        if (!fieldKinds.includes(field.fieldKindEnumId)) denied("FIELD_INVALID", field.fieldName + " has no known kind")
    const values = checkedProfile(fields, profileEntries(p.profileValues))
    const fromMs = effective(p.fromDate)
    if (!openAt({fromDate: employment.fromMs, thruDate: employment.thruMs}, fromMs))
        denied("DATE_OUTSIDE", "The person is not employed on that date")
    const existing = rows(PROFILE, {partyRelationshipId, payrollLocalizationId}).filter(row => !voided(row))
    const later = existing.find(row => (ms(row.fromDate) ?? -Infinity) > fromMs)
    if (later) denied("PROFILE_SCHEDULED", "A profile from " + dateText(later.fromDate) + " is set already")
    const inEffect = existing.find(row => openAt(row, fromMs))
    if (inEffect)
        call("update#" + PROFILE, {
            payrollTaxProfileId: inEffect.payrollTaxProfileId,
            thruDate: stamp(fromMs),
            thruDate_changeReason: text(p.reason) || null
        })
    const created = call("create#" + PROFILE, {
        partyRelationshipId,
        partyId: employment.partyId,
        organizationPartyId: employment.organizationPartyId,
        payrollLocalizationId,
        profileValues: JSON.stringify(values),
        fromDate: stamp(fromMs),
        reason: text(p.reason) || null,
        createdByUserId: ec.user.userId || null,
        createdDate: ec.user.nowTimestamp
    })
    return {
        payrollTaxProfileId: created.payrollTaxProfileId,
        revision: profileRevision(partyRelationshipId, payrollLocalizationId)
    }
}

// ===== get#Compensation =====
// The person's bank accounts as masked references: changed through Accounting's payment-method services, never here.
function paymentMethodsOf(partyId, at) {
    const methods = Array.from(
        people
            .current(
                find("mantle.account.method.PaymentMethod")
                    .condition("ownerPartyId", partyId)
                    .condition("paymentMethodTypeEnumId", "PmtBankAccount"),
                at
            )
            .list()
    )
    const accounts = byIds(
        "mantle.account.method.BankAccount",
        "paymentMethodId",
        methods.map(row => row.paymentMethodId)
    )
    return methods.map(row => {
        const number = String(accounts[row.paymentMethodId]?.accountNumber || "")
        const bank = accounts[row.paymentMethodId]?.bankName || row.description || "Bank account"
        return {paymentMethodId: row.paymentMethodId, referenceText: bank + (number ? " •••• " + number.slice(-4) : "")}
    })
}
// The employment's tax profile for the localization: its declared fields with the values in effect, and its revision.
function profileOf(employment, localization, at) {
    if (!localization) return null
    const fields = fieldsOf(localization.payrollLocalizationId)
    const profile = profileAt(employment.partyRelationshipId, localization.payrollLocalizationId, at)
    const values = profile ? lib.json(profile.profileValues, {}) || {} : {}
    return {
        payrollLocalizationId: localization.payrollLocalizationId,
        localizationName: localization.localizationName || localization.payrollLocalizationId,
        isDemonstration: localization.isDemonstration === "Y",
        hasProfile: !!profile,
        fromDateText: profile ? dateText(profile.fromDate) : "",
        revision: profileRevision(employment.partyRelationshipId, localization.payrollLocalizationId),
        fields: fields.map(field => {
            const options = field.fieldKindEnumId === "PpfChoice" ? optionsOf(field) : []
            const value = values[field.fieldName] ?? null
            const valueText =
                value == null
                    ? ""
                    : field.fieldKindEnumId === "PpfIndicator"
                      ? value === "Y"
                          ? "Yes"
                          : "No"
                      : options.find(option => option.value === value)?.label || String(value)
            return {
                fieldName: field.fieldName,
                fieldLabel: field.fieldLabel || field.fieldName,
                fieldKindEnumId: field.fieldKindEnumId,
                options,
                required: field.isRequired === "Y",
                value,
                valueText
            }
        })
    }
}
function benefitRows(partyRelationshipId, at) {
    const list = rows(BENEFIT, {partyRelationshipId}).sort((a, b) => (ms(b.fromDate) ?? 0) - (ms(a.fromDate) ?? 0))
    const types = byIds(
        "mantle.humanres.employment.BenefitType",
        "benefitTypeId",
        list.map(row => row.benefitTypeId)
    )
    return list.map(row =>
        Object.assign(
            {
                benefitTypeId: row.benefitTypeId,
                benefitText: types[row.benefitTypeId]?.description || row.benefitTypeId,
                fromDate: ms(row.fromDate),
                fromDateText: dateText(row.fromDate),
                thruDateText: dateText(row.thruDate),
                costText: row.cost == null ? "" : String(row.cost),
                employerPaidText: row.actualEmployerPaidPercent == null ? "" : row.actualEmployerPaidPercent + "%"
            },
            stateAt(row, at)
        )
    )
}
// get#Compensation: a person's pay as a payroll reader of their employer reads it, for one employment (partyRelationshipId, else
// the current one in scope, then the newest): the salaries (dated, the one in effect first), the pay rates in effect, the pay
// assignments, the benefits, the tax profile of the primary group's localization, the bank account references (masked), the pay
// changes waiting, the readiness, and whether the caller changes pay. Refused without PAYROLL_VIEW, and for a person with no
// employment at an employer in scope (RECORD_UNAVAILABLE), alike.
function getCompensation(p) {
    const userScope = readerScope()
    const partyId = text(p.partyId)
    const at = people.asOfMillis(p.asOfDate)
    const found = userScope.organizationPartyIds.length
        ? Array.from(
              people
                  .employmentFind()
                  .condition("fromPartyId", partyId || "_NA_")
                  .condition("toPartyId", "in", userScope.organizationPartyIds)
                  .orderBy("-fromDate")
                  .list()
          ).map(employmentOf)
        : []
    if (!found.length) denied("RECORD_UNAVAILABLE", "Person " + partyId + " is not available")
    const employment = text(p.partyRelationshipId)
        ? found.find(row => row.partyRelationshipId === text(p.partyRelationshipId))
        : found.find(row => openAt({fromDate: row.fromMs, thruDate: row.thruMs}, at)) || found[0]
    if (!employment) denied("RECORD_UNAVAILABLE", "Employment " + text(p.partyRelationshipId) + " is not available")
    const fact = factsOf([employment], at)[employment.partyRelationshipId]
    const organizations = people.organizationNames(unique(found.map(row => row.organizationPartyId)))
    const salaries = salariesOf(employment.partyRelationshipId).reverse()
    const grades = gradeNames(salaries.map(row => row.payGradeId))
    const structures = byIds(
        STRUCTURE,
        "payrollStructureId",
        fact.assignments.map(row => row.payrollStructureId)
    )
    const groups = byIds(
        GROUP,
        "payrollGroupId",
        fact.assignments.map(row => row.payrollGroupId)
    )
    const components = byIds(
        COMPONENT,
        "payrollComponentId",
        fact.assignments.flatMap(row => splitIds(row.electedComponentIds))
    )
    // the localization of the primary group in effect (else the next one's), or the one asked for
    const shown = fact.primary || fact.next
    const shownGroup = shown ? groups[shown.payrollGroupId] : null
    const payrollLocalizationId = text(p.payrollLocalizationId) || shownGroup?.payrollLocalizationId || null
    const localization = payrollLocalizationId ? one(LOCALIZATION, {payrollLocalizationId}) : null
    const waiting = rows(CHANGE, {
        partyRelationshipId: employment.partyRelationshipId,
        changeKindEnumId: "EckPayChange",
        statusId: "EchRequested"
    }).map(row => ({
        employmentChangeId: row.employmentChangeId,
        effectiveDateText: dateText(row.effectiveDate),
        salaryText: salaryText({
            amount: row.salaryAmount,
            currencyUomId: row.salaryCurrencyUomId,
            timePeriodTypeId: row.salaryPeriodTypeId
        }),
        reason: row.reason || ""
    }))
    const readiness = readinessOf(fact, at)
    const current = fact.salary
    return {
        partyId,
        personName: people.personNames([partyId])[partyId] || partyId,
        partyRelationshipId: employment.partyRelationshipId,
        organizationPartyId: employment.organizationPartyId,
        organizationName: organizations[employment.organizationPartyId] || "",
        employments: found.map(row =>
            Object.assign(
                {
                    partyRelationshipId: row.partyRelationshipId,
                    organizationName: organizations[row.organizationPartyId] || ""
                },
                stateAt({fromDate: row.fromMs, thruDate: row.thruMs}, at)
            )
        ),
        currentSalary: current ? salaryRow(current, at, grades) : null,
        salaries: salaries.map(row => salaryRow(row, at, grades)),
        rates: fact.rates.map(row => ({
            rateAmountId: row.rateAmountId,
            rateText: rateText(row),
            fromDateText: dateText(row.fromDate)
        })),
        assignments: fact.assignments
            .slice()
            .reverse()
            .map(row => assignmentRow(row, at, structures, groups, components, userScope)),
        primary: shown ? assignmentRow(shown, at, structures, groups, components, userScope) : null,
        benefits: benefitRows(employment.partyRelationshipId, at),
        benefitRevision: benefitRevision(employment.partyRelationshipId),
        profile: profileOf(employment, localization, at),
        paymentMethods: paymentMethodsOf(partyId, at),
        payChanges: waiting,
        readiness,
        canEdit: edits(userScope),
        payRevision: salaryRevision(employment.partyRelationshipId)
    }
}

const operations = {
    findAssignments,
    assignPayStructure,
    storePayrollProfile,
    getCompensation,
    salaryAccess: p => (salaryAccess(p), {}),
    createSalary
}
function run(op, p) {
    if (!Object.hasOwn(operations, op)) throw new Error("Unknown pay assignment operation " + op)
    return operations[op](p || {})
}
;({
    execute: run,
    // for Employment.js's pay change and People.js's readiness: the salary writer, checks and revision, the texts, the counts
    writeSalary,
    checkSalaryDate,
    checkPayTerms,
    salariesOf,
    salaryRevision,
    salaryText,
    frequencyText,
    unassignedCount
})
