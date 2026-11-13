// People's employer preferences (mantle.humanres.PeopleServices get#Settings and store#Settings; IronStone People design §12 Settings
// PeoplePreferences; impl-people P29, §4 Nov 12): the settings earlier phases left to People's Settings, each an employer's
// PartySetting, each change audit-logged with its reason (PartySetting.settingValue is audit-logged):
// - the clocking default (PeopleClocking, Y or N; P13's rule, Attendance.js isClockingOn, stays the one reader: an employment's own
//   Y or N first, else this), changed by the People administrator (PEOPLE_CONFIGURE) or an HR editor (PEOPLE_HR_VIEW and
//   PEOPLE_HR_EDIT) of the employer;
// - the confidential case intake handlers (PeopleCaseIntake, party ids; P21's rule, PeopleCases.js, reads it at each filing),
//   changed by the People administrator of the employer alone, each handler checked as a filing checks them (an enabled account
//   holding PEOPLE_CASE_HANDLE, working for the employer: HANDLER_NOT_ELIGIBLE otherwise); shown with the handlers' names, never a
//   case.
// The employer is one of the caller's People scope (ORGANIZATION_DENIED otherwise); a write names the revision it read
// (expectedRevision: the later change of the employer's settings; required for the intake handlers, checked when given for the
// clocking default) and is refused when it changed since (REVISION_STALE).
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const people = ec.resource.script("component://mr-mantle/service/mantle/humanres/People.js")
const cases = () => ec.resource.script("component://mr-mantle/service/mantle/request/PeopleCases.js")
const {find, one, denied, call, ms} = lib

const SETTING = "mantle.party.PartySetting"
const CLOCKING = "PeopleClocking"
const INTAKE = "PeopleCaseIntake"
const HANDLE = "PEOPLE_CASE_HANDLE"
// the most intake candidates listed
const candidateLimit = 200
const text = value => (value == null ? "" : String(value).trim())

const configures = (userScope, organizationPartyId) =>
    !!userScope.capabilities.configure && userScope.organizationPartyIds.includes(organizationPartyId)
const editsClocking = (userScope, organizationPartyId) =>
    configures(userScope, organizationPartyId) ||
    !!(
        userScope.capabilities.hrView &&
        userScope.capabilities.hrEdit &&
        userScope.organizationPartyIds.includes(organizationPartyId)
    )
const settingOf = (organizationPartyId, partySettingTypeId) => one(SETTING, {partyId: organizationPartyId, partySettingTypeId})
// an employer's settings revision: the later change of its two rows ("0" when it has neither)
function revisionOf(organizationPartyId) {
    const stamps = [CLOCKING, INTAKE].map(type => ms(settingOf(organizationPartyId, type)?.lastUpdatedStamp) ?? 0)
    return String(Math.max(...stamps))
}
// The people who may take the employer's confidential cases now: enabled accounts holding PEOPLE_CASE_HANDLE, working for it.
function intakeCandidates(organizationPartyId) {
    const at = ms(ec.user.nowTimestamp)
    const open = (from, thru) => (ms(from) ?? -Infinity) <= at && (ms(thru) ?? Infinity) > at
    const userIds = Array.from(
        find("moqui.security.UserPermissionCheck").condition("userPermissionId", HANDLE).limit(5000).list()
    )
        .filter(row => open(row.groupFromDate, row.groupThruDate) && open(row.permissionFromDate, row.permissionThruDate))
        .map(row => row.userId)
    if (!userIds.length) return []
    const partyIds = people.unique(
        Array.from(
            find("moqui.security.UserAccount")
                .condition("userId", "in", people.unique(userIds))
                .condition("partyId", "is-not-null", null)
                .list()
        )
            .filter(row => row.disabled !== "Y")
            .map(row => row.partyId)
    )
    const eligible = partyIds.filter(partyId => cases().eligibleHandler(partyId, organizationPartyId)).slice(0, candidateLimit)
    const names = people.personNames(eligible)
    return eligible.map(partyId => ({partyId, name: names[partyId] || partyId})).sort((a, b) => a.name.localeCompare(b.name))
}
function employerSettings(userScope, organizationPartyId, names, withCandidates) {
    const clocking = settingOf(organizationPartyId, CLOCKING)?.settingValue === "Y" ? "Y" : "N"
    const out = {
        organizationPartyId,
        organizationName: names[organizationPartyId] || organizationPartyId,
        revision: revisionOf(organizationPartyId),
        clocking,
        clockingText: clocking === "Y" ? "Employees clock in and out" : "Clocking is off unless set for an employee",
        canChangeClocking: editsClocking(userScope, organizationPartyId),
        canChangeIntake: configures(userScope, organizationPartyId)
    }
    // the intake handlers are the People administrator's to read and change
    if (out.canChangeIntake) {
        const ids = cases().listOf(settingOf(organizationPartyId, INTAKE)?.settingValue)
        const handlerNames = people.personNames(ids)
        out.intakeHandlers = ids.map(partyId => ({
            partyId,
            name: handlerNames[partyId] || partyId,
            eligible: cases().eligibleHandler(partyId, organizationPartyId)
        }))
        out.intakeHandlerIds = ids
        out.eligibleHandlerCount = out.intakeHandlers.filter(row => row.eligible).length
        out.intakeText = out.eligibleHandlerCount
            ? out.intakeHandlers
                  .filter(row => row.eligible)
                  .map(row => row.name)
                  .join(", ")
            : "Nobody: a confidential case filed here is refused"
        if (withCandidates) out.intakeCandidates = intakeCandidates(organizationPartyId)
    }
    return out
}

// get#Settings: the preferences of the employers of the caller's scope (or the one asked) they may change, with the intake
// candidates when one employer is asked by its People administrator.
function getSettings(p) {
    const userScope = people.scopeOf()
    const caps = userScope.capabilities
    if (!caps.configure && !(caps.hrView && caps.hrEdit))
        denied("PERMISSION_DENIED", "People's preferences are the People administrator's and HR editors'")
    const organizationPartyId = text(p.organizationPartyId) || null
    people.requireOrganization(userScope, organizationPartyId)
    const organizationPartyIds = organizationPartyId ? [organizationPartyId] : userScope.organizationPartyIds
    const names = people.organizationNames(organizationPartyIds)
    return {
        employers: organizationPartyIds
            .filter(id => editsClocking(userScope, id))
            .map(id => employerSettings(userScope, id, names, !!organizationPartyId))
            .sort((a, b) => a.organizationName.localeCompare(b.organizationName))
    }
}

// store#Settings: an employer's clocking default and, for its People administrator, its intake handlers; each one given is
// written when it changed, with the reason.
function storeSettings(p) {
    const userScope = people.scopeOf()
    const organizationPartyId = text(p.organizationPartyId)
    if (!organizationPartyId) denied("ORGANIZATION_REQUIRED", "Choose the employer")
    people.requireOrganization(userScope, organizationPartyId)
    const clockingGiven = text(p.clocking) !== ""
    const intakeGiven = p.intakeHandlerIds != null
    if (!clockingGiven && !intakeGiven) denied("NOTHING_TO_CHANGE", "Choose a setting to change")
    if (clockingGiven && !editsClocking(userScope, organizationPartyId))
        denied("PERMISSION_DENIED", "The clocking default is the People administrator's and the employer's HR editors'")
    if (intakeGiven && !configures(userScope, organizationPartyId))
        denied("PERMISSION_DENIED", "The confidential case intake is the People administrator's")
    // the intake handlers replace the whole list, so a change of them names the revision it read; the clocking default is one value,
    // which Who clocks sets without reading the rest, so its revision is checked when given
    const revision = revisionOf(organizationPartyId)
    if ((intakeGiven || text(p.expectedRevision)) && text(p.expectedRevision) !== revision)
        denied("REVISION_STALE", "The employer's settings changed since you read them (revision " + revision + ")")
    const reason = text(p.reason) || null
    const changed = []
    const write = (partySettingTypeId, settingValue) => {
        const existing = settingOf(organizationPartyId, partySettingTypeId)
        if ((existing?.settingValue ?? "") === settingValue) return
        call((existing ? "update#" : "create#") + SETTING, {
            partyId: organizationPartyId,
            partySettingTypeId,
            settingValue,
            settingValue_changeReason: reason
        })
        changed.push(partySettingTypeId)
    }
    if (clockingGiven) {
        const given = text(p.clocking)
        if (!["Y", "N", "true", "false"].includes(given)) denied("CLOCKING_INVALID", "The clocking default is Y or N")
        write(CLOCKING, given === "Y" || given === "true" ? "Y" : "N")
    }
    if (intakeGiven) {
        const ids = people.unique(cases().listOf(p.intakeHandlerIds))
        // named only by the id given: a party who does not work for the employer is no one the caller may read
        for (const partyId of ids)
            if (!cases().eligibleHandler(partyId, organizationPartyId))
                denied(
                    "HANDLER_NOT_ELIGIBLE",
                    partyId +
                        " cannot take this employer's cases: an enabled account holding PEOPLE_CASE_HANDLE, working for it, is needed"
                )
        write(INTAKE, ids.join(","))
    }
    const names = people.organizationNames([organizationPartyId])
    return Object.assign(employerSettings(userScope, organizationPartyId, names, false), {changed})
}

const operations = {getSettings, storeSettings}
;({
    execute: (op, parameters) => {
        if (!Object.hasOwn(operations, op)) throw new Error("Unknown People settings operation " + op)
        return operations[op](parameters || {})
    }
})
