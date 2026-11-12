// The employees import (mantle.humanres.PeopleServices validate#EmployeeImportRow, apply#EmployeeImportRow and
// find#EmployeeImportScopes; IronStone People design §12 EmployeeImport, Admin §11, PE-19, F16; impl-people P7): the row services
// of the framework's import target `employees` (data/PeopleLifecycleSetupData.xml), called by org.moqui.admin.DataTransferServices
// for each row of a staged file, as the importer. A row is one hire into the batch's employer (its scope): an existing person by
// id (admitted as the hire wizard admits one) or a new one by name and work email, the start and optional end, and the first
// assignment by id; it is validated by preview#Hire's own checks and applied by hire#Employee itself, under the row's operation
// key, so an import is the single hire made many times: the same permission, scope and rules. The target names PEOPLE_IMPORT and
// PEOPLE_HR_EDIT to import and PEOPLE_HR_VIEW to view, and no ADMIN_* permission (a target's permissions are all required, so
// Admin's transfer permission beside them would shut HR out, §4); these services check PEOPLE_IMPORT again with the hire's own
// permissions. It never imports a password, a group or pay: the registration refuses those columns, and no field here names one.
const people = ec.resource.script("component://mr-mantle/service/mantle/humanres/People.js")
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
const text = value => String(value ?? "").trim()
const mapOf = value => (value?.getMap ? value.getMap() : Object.assign({}, value || {}))
// the importer: an HR editor who also holds PEOPLE_IMPORT, of the batch's employer
function importer(scopeKey) {
    const userScope = people.scopeOf()
    const caps = userScope.capabilities
    if (!caps.import || !caps.hrView || !caps.hrEdit)
        lib.denied("PERMISSION_DENIED", "Importing employees needs PEOPLE_IMPORT, PEOPLE_HR_VIEW and PEOPLE_HR_EDIT")
    const organizationPartyId = text(scopeKey)
    if (!organizationPartyId) throw new Error("Choose the employer the employees are hired by")
    people.requireOrganization(userScope, organizationPartyId)
    return organizationPartyId
}
// The row's values as preview#Hire takes them: the registered fields given, a date as the day, the employer the batch's (a row
// naming another employer is refused: import another employer's employees apart).
function hireValues(p) {
    const organizationPartyId = importer(p.scopeKey)
    const values = mapOf(p.rowValues)
    const rowOrganization = text(values.organizationPartyId)
    if (rowOrganization && rowOrganization !== organizationPartyId)
        throw new Error(
            "This import is for " +
                (people.organizationNames([organizationPartyId])[organizationPartyId] || organizationPartyId) +
                ": import another employer's employees apart"
        )
    const normalized = {}
    for (const field of fields) if (text(values[field])) normalized[field] = text(values[field])
    if (normalized.confirmNewPerson)
        normalized.confirmNewPerson = /^(y|yes|true|1)$/i.test(normalized.confirmNewPerson) ? "Y" : "N"
    return {organizationPartyId, normalized}
}
function validateRow(p) {
    const {organizationPartyId, normalized} = hireValues(p)
    let preview
    try {
        preview = lib.probe("mantle.humanres.PeopleServices.preview#Hire", Object.assign({organizationPartyId}, normalized))
    } catch (error) {
        return {
            valid: false,
            errors: [String(error.message).replace(/^(Error: )?[A-Z][A-Z0-9_]+: /, "")],
            normalizedValues: normalized
        }
    }
    const findings = Array.from(preview.findings || [])
    const errors = findings.filter(finding => finding.severity === "error").map(finding => finding.message)
    if (!preview.person) errors.push("Give the person's first and last name, or an existing person's ID")
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
        warnings: findings.filter(finding => finding.severity === "warning").map(finding => finding.message),
        normalizedValues: normalized,
        displayText: [preview.person?.personName, preview.planText].filter(Boolean).join(": ")
    }
}
function applyRow(p) {
    const {organizationPartyId, normalized} = hireValues(p)
    ec.message.pushErrors()
    try {
        const hired = ec.service
            .sync()
            .name("mantle.humanres.PeopleServices.hire#Employee")
            .parameters(
                Object.assign(
                    {organizationPartyId, reason: "Imported", operationKey: text(p.operationKey), requestAccount: false},
                    normalized
                )
            )
            .call()
        if (ec.message.hasError()) throw new Error(ec.message.getErrorsString())
        const name = people.personNames([hired.partyId])[hired.partyId] || hired.partyId
        return {
            applied: true,
            resultRef: hired.partyRelationshipId,
            resultText: (hired.repeated ? "Hired already: " : "Hired: ") + name
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
