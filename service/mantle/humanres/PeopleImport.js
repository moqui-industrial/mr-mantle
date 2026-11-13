// The employees import (mantle.humanres.PeopleServices validate#EmployeeImportRow, apply#EmployeeImportRow and
// find#EmployeeImportScopes; IronStone People design §12 EmployeeImport, Admin §11, PE-19, F16; impl-people P7): the row services
// of the framework's import target `employees` (data/PeopleLifecycleSetupData.xml), called by org.moqui.admin.DataTransferServices
// for each row of a staged file, as the importer. A row is one hire into the batch's employer (its scope): an existing person by
// id (admitted as the hire wizard admits one) or a new one by name and work email, the start and optional end, and the first
// assignment by id; it is validated by preview#Hire's own checks and applied by hire#Employee itself, under the row's operation
// key, so an import is the single hire made many times: the same permission, scope and rules. The target names PEOPLE_IMPORT and
// PEOPLE_HR_EDIT to import and PEOPLE_HR_VIEW to view, and no ADMIN_* permission (a target's permissions are all required, so
// Admin's transfer permission beside them would shut HR out, §4); these services check PEOPLE_IMPORT again with the hire's own
// permissions. It never imports a password, a group, a wage or tax history: the registration refuses those columns.
// The first salary (the user's call of Nov 12, 2026: the import's exception to a first salary's approval): a row may give the
// amount, currency, pay frequency (a Payroll TimePeriodType) and from date (the start when empty). An importer who also holds
// PAYROLL_EDIT and PAYROLL_VIEW (at the batch's employer, which their scope holds already) has it written at once through
// PayrollAssignments.js writeSalary, its terms checked as a pay change's (checkPayTerms), logged with no amount and audited with
// the change reason "Employee import"; for anyone else the salary columns alone are refused (PERMISSION_DENIED, a warning and
// the row's result) and the hire is made. A salary already present for the employment (a repeat of a row under its key with
// other terms) is never changed by import (PAY_CHANGE_REQUIRED): a salary in place changes through the approved pay change.
const people = ec.resource.script("component://mr-mantle/service/mantle/humanres/People.js")
const payroll = () => ec.resource.script("component://mr-mantle/service/mantle/humanres/PayrollAssignments.js")
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")

// the registered fields a row may give, as preview#Hire and hire#Employee name them
const fields = [
    "partyId",
    "firstName",
    "lastName",
    "preferredName",
    "workEmail",
    "workPhone",
    "fromDate",
    "thruDate",
    "departmentPartyId",
    "emplPositionId",
    "managerPartyId",
    "facilityId",
    "confirmNewPerson",
    "reason"
]
// the first salary's fields, the pay change's names (checkPayTerms) and its start
const salaryFields = ["salaryAmount", "salaryCurrencyUomId", "salaryPeriodTypeId", "salaryFromDate"]
const text = value => String(value ?? "").trim()
const mapOf = value => (value?.getMap ? value.getMap() : Object.assign({}, value || {}))
const messageOf = error => String(error?.message ?? error).replace(/^(Error: )?[A-Z][A-Z0-9_]+: /, "")
// the importer: an HR editor who also holds PEOPLE_IMPORT, of the batch's employer
function importer(scopeKey) {
    const userScope = people.scopeOf()
    const caps = userScope.capabilities
    if (!caps.import || !caps.hrView || !caps.hrEdit)
        lib.denied("PERMISSION_DENIED", "Importing employees needs PEOPLE_IMPORT, PEOPLE_HR_VIEW and PEOPLE_HR_EDIT")
    const organizationPartyId = text(scopeKey)
    if (!organizationPartyId) throw new Error("Choose the employer the employees are hired by")
    people.requireOrganization(userScope, organizationPartyId)
    return {organizationPartyId, userScope}
}
// The row's values as preview#Hire takes them: the registered fields given, a date as the day, the employer the batch's (a row
// naming another employer is refused: import another employer's employees apart).
function hireValues(p) {
    const {organizationPartyId, userScope} = importer(p.scopeKey)
    const values = mapOf(p.rowValues)
    const rowOrganization = text(values.organizationPartyId)
    if (rowOrganization && rowOrganization !== organizationPartyId)
        throw new Error(
            "This import is for " +
                (people.organizationNames([organizationPartyId])[organizationPartyId] || organizationPartyId) +
                ": import another employer's employees apart"
        )
    const normalized = {}
    for (const field of fields.concat(salaryFields)) if (text(values[field])) normalized[field] = text(values[field])
    if (normalized.confirmNewPerson)
        normalized.confirmNewPerson = /^(y|yes|true|1)$/i.test(normalized.confirmNewPerson) ? "Y" : "N"
    const hire = {}
    for (const field of fields) if (normalized[field]) hire[field] = normalized[field]
    return {organizationPartyId, userScope, normalized, hire}
}

// ===== the first salary =====
const paysSalary = userScope => !!(userScope.capabilities.payrollView && userScope.capabilities.payrollEdit)
// The row's salary: null when it gives none; {refused, message} when its columns are refused for the importer; else its start
// and terms, checked as a pay change's (CURRENCY_*, AMOUNT_INVALID, FREQUENCY_*), within the employment (DATE_OUTSIDE), an
// error for the row thrown.
function salaryPlan(userScope, organizationPartyId, values) {
    if (!salaryFields.some(field => values[field])) return null
    if (!paysSalary(userScope))
        return {
            refused: "PERMISSION_DENIED",
            message: "Salary not imported: setting pay needs PAYROLL_EDIT and PAYROLL_VIEW; the rest of the row is"
        }
    if (!values.salaryAmount) lib.denied("AMOUNT_REQUIRED", "Give the salary's amount, or leave the salary columns empty")
    const startMs = ec.user.timestampMillis(values.fromDate)
    const thruMs = values.thruDate ? ec.user.timestampMillis(values.thruDate) : null
    const fromMs = values.salaryFromDate ? ec.user.timestampMillis(values.salaryFromDate) : startMs
    if (fromMs < startMs || (thruMs != null && fromMs >= thruMs))
        lib.denied("DATE_OUTSIDE", "The salary starts within the employment, on or after its start")
    return {fromMs, terms: payroll().checkPayTerms({organizationPartyId}, values, fromMs)}
}
const presentText = "Salary not imported: the employment has a salary already; change it with a pay change"
// A hired row's salary: written at once for a payroll editor, as checked; else named. {written, reasonCode, text}
function applySalary(userScope, organizationPartyId, values, hired, operationKey) {
    let plan
    try {
        plan = salaryPlan(userScope, organizationPartyId, values)
    } catch (error) {
        return {
            written: false,
            reasonCode: lib.reasonCode(error) || "SALARY_INVALID",
            text: "Salary not set: " + messageOf(error)
        }
    }
    if (!plan) return {written: false, reasonCode: null, text: ""}
    if (plan.refused) return {written: false, reasonCode: plan.refused, text: plan.message}
    const partyRelationshipId = hired.partyRelationshipId
    const present = payroll().salariesOf(partyRelationshipId)
    if (present.length) {
        // a repeat of this row answers the salary its first apply wrote
        const same = row =>
            lib.ms(row.fromDate) === plan.fromMs &&
            row.amount != null &&
            toDecimal(String(row.amount)).compare(plan.terms.amount) === 0 &&
            row.currencyUomId === plan.terms.currencyUomId &&
            row.timePeriodTypeId === plan.terms.timePeriodTypeId
        if (hired.repeated && present.some(same)) return {written: false, reasonCode: null, text: "salary set already"}
        return {written: false, reasonCode: "PAY_CHANGE_REQUIRED", text: presentText}
    }
    try {
        payroll().writeSalary(
            partyRelationshipId,
            {
                fromMs: plan.fromMs,
                amount: plan.terms.amount,
                currencyUomId: plan.terms.currencyUomId,
                timePeriodTypeId: plan.terms.timePeriodTypeId
            },
            "Employee import"
        )
    } catch (error) {
        return {
            written: false,
            reasonCode: lib.reasonCode(error) || "SALARY_INVALID",
            text: "Salary not set: " + messageOf(error)
        }
    }
    ec.logger.info(
        "Employee import set the first salary of employment " +
            partyRelationshipId +
            " at once, without a pay change (import row " +
            (operationKey || "without a key") +
            ")"
    )
    return {written: true, reasonCode: null, text: "first salary set"}
}
function validateRow(p) {
    const {organizationPartyId, userScope, normalized, hire} = hireValues(p)
    let preview
    try {
        preview = lib.probe("mantle.humanres.PeopleServices.preview#Hire", Object.assign({organizationPartyId}, hire))
    } catch (error) {
        return {valid: false, errors: [messageOf(error)], normalizedValues: normalized}
    }
    const findings = Array.from(preview.findings || [])
    const errors = findings.filter(finding => finding.severity === "error").map(finding => finding.message)
    if (!preview.person) errors.push("Give the person's first and last name, or an existing person's ID")
    // the first salary: an error of a payroll editor's terms; a warning when its columns are refused
    const salaryWarnings = []
    let salaryReasonCode = null
    try {
        const plan = salaryPlan(userScope, organizationPartyId, normalized)
        if (plan?.refused) {
            salaryReasonCode = plan.refused
            salaryWarnings.push(plan.message)
        }
    } catch (error) {
        salaryReasonCode = lib.reasonCode(error) || "SALARY_INVALID"
        errors.push(messageOf(error))
    }
    // a row repeated after its hire was made under its key still says valid at the apply (the overlap is the hire itself)
    if (text(p.operationKey) && errors.length) {
        const made = Array.from(
            lib
                .find("mantle.humanres.employment.EmploymentChange")
                .condition({operationKey: text(p.operationKey), changeKindEnumId: "EckHire"})
                .list()
        )
        if (made.length)
            return {
                valid: true,
                errors: [],
                warnings: [],
                normalizedValues: normalized,
                displayText: preview.person?.personName || ""
            }
    }
    return {
        valid: !errors.length,
        errors,
        warnings: salaryWarnings.concat(
            findings.filter(finding => finding.severity === "warning").map(finding => finding.message)
        ),
        normalizedValues: normalized,
        displayText: [preview.person?.personName, preview.planText].filter(Boolean).join(": "),
        salaryReasonCode
    }
}
function applyRow(p) {
    const {organizationPartyId, userScope, normalized, hire} = hireValues(p)
    ec.message.pushErrors()
    try {
        const hired = ec.service
            .sync()
            .name("mantle.humanres.PeopleServices.hire#Employee")
            .parameters(
                Object.assign(
                    {organizationPartyId, reason: "Imported", operationKey: text(p.operationKey), requestAccount: false},
                    hire
                )
            )
            .call()
        if (ec.message.hasError()) throw new Error(ec.message.getErrorsString())
        const name = people.personNames([hired.partyId])[hired.partyId] || hired.partyId
        const salary = applySalary(userScope, organizationPartyId, normalized, hired, text(p.operationKey))
        return {
            applied: true,
            resultRef: hired.partyRelationshipId,
            resultText: (hired.repeated ? "Hired already: " : "Hired: ") + name + (salary.text ? "; " + salary.text : ""),
            salaryWritten: salary.written,
            salaryReasonCode: salary.reasonCode
        }
    } catch (error) {
        const message = String(error.message || error)
        return {
            applied: false,
            reasonCode: lib.reasonCode(error) || /\b([A-Z][A-Z0-9_]{3,}):/.exec(message)?.[1] || "HIRE_REFUSED",
            reason: message
        }
    } finally {
        ec.message.clearErrors()
        ec.message.popErrors()
    }
}
function findScopes() {
    const userScope = people.scopeOf()
    if (!userScope.capabilities.hrView) return {scopeList: []}
    const names = people.organizationNames(userScope.organizationPartyIds)
    return {
        scopeList: userScope.organizationPartyIds
            .map(scopeKey => ({scopeKey, title: names[scopeKey] || scopeKey}))
            .sort((a, b) => a.title.localeCompare(b.title))
    }
}

const operations = {validateRow, applyRow, findScopes}
;({
    execute: (op, parameters) => {
        if (!Object.hasOwn(operations, op)) throw new Error("Unknown employee import operation " + op)
        return operations[op](parameters || {})
    }
})
