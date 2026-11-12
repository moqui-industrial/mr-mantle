// A change applied for a later date (mantle.humanres.PeopleServices withdraw#EmploymentChange, apply#EmploymentChange's superseding,
// apply#DueAssignments' routing; impl-people P7, F131, F134): HR withdraws a scheduled transfer, which never takes effect (its seat,
// department and line stay as they were); a separation dated before a scheduled transfer withdraws it; a return comes before the
// leave's scheduled return; and the daily job routes the employer's waiting decisions again on the date a later separation comes.
// Standalone: spec-local organizations, people, employments, groups and users, with artifact authorization disabled (the rules
// are the services' own checks). Run: ./moq test mr-mantle --spec PeopleScheduledChanges
const prefix = "PEOPLE_SCHED_SPEC"
const orgA = prefix + "_A",
    orgB = prefix + "_B",
    since = "2001-01-01T00:00:00Z"
const P = "mantle.humanres.PeopleServices."
const day = 24 * 60 * 60 * 1000
const state = {}

function run(username, service, parameters = {}) {
    login(username)
    ec.artifactExecution.disableAuthz()
    ec.message.pushErrors()
    try {
        const out = ec.service.sync().name(service).parameters(parameters).requireNewTransaction(true).call() || {}
        return Object.assign({}, out, {error: ec.message.hasError() ? ec.message.getErrorsString() : ""})
    } catch (error) {
        return {error: String(error.message || error)}
    } finally {
        ec.message.clearErrors()
        ec.message.popErrors()
        login("john.doe")
        ec.artifactExecution.disableAuthz()
    }
}
const code = out => (out.error ? /[A-Z][A-Z0-9_]{3,}(?=:)/.exec(out.error)?.[0] || out.error : "")
const rows = (entity, conditions) => Array.from(ec.entity.find(entity).condition(conditions).disableAuthz().list())
const one = (entity, conditions) => ec.entity.find(entity).condition(conditions).disableAuthz().one()
const ms = value => (value == null ? null : ec.user.timestampMillis(value))
const dayText = offset => ec.l10n.format(new Date(Date.now() + offset * day), "yyyy-MM-dd")
function organization(partyId, name) {
    call("create#mantle.party.Party", {partyId, partyTypeEnumId: "PtyOrganization", ownerPartyId: partyId})
    call("create#mantle.party.Organization", {partyId, organizationName: name})
    call("create#mantle.party.PartyRole", {partyId, roleTypeId: "OrgInternal"})
}
function person(kind) {
    const partyId = prefix + "_" + kind
    call("create#mantle.party.Party", {partyId, partyTypeEnumId: "PtyPerson"})
    call("create#mantle.party.Person", {partyId, firstName: "Sched", lastName: kind})
    return partyId
}
const employ = (partyId, organizationPartyId) =>
    call("mantle.humanres.EmploymentServices.create#Employment", {
        fromPartyId: partyId,
        toPartyId: organizationPartyId,
        fromDate: since
    }).partyRelationshipId
function user(kind, permissions, organizationPartyIds, partyId = null) {
    const id = prefix + "_U_" + kind
    call("create#moqui.security.UserGroup", {userGroupId: id, description: "People scheduled " + kind})
    for (const permission of permissions)
        call("create#moqui.security.UserGroupPermission", {userGroupId: id, userPermissionId: permission, fromDate: since})
    if (!partyId) {
        partyId = person("USER_" + kind)
        for (const organizationPartyId of organizationPartyIds)
            call("create#mantle.party.PartyRelationship", {
                relationshipTypeEnumId: "PrtAgent",
                fromPartyId: partyId,
                toPartyId: organizationPartyId,
                toRoleTypeId: "OrgInternal",
                fromDate: since
            })
    }
    call("create#moqui.security.UserAccount", {
        userId: id,
        username: id,
        partyId,
        currentPassword: "16ac58bbfa332c1c55bd98b53e60720bfa90d394",
        passwordHashType: "SHA",
        timeZone: ec.user.userAccount?.timeZone || "America/Chicago"
    })
    call("create#moqui.security.UserGroupMember", {userId: id, userGroupId: id, fromDate: since})
    return id
}
const revisionOf = partyRelationshipId =>
    run(state.hr, P + "preview#EmploymentChange", {partyRelationshipId, changeKind: "manager"}).revision
const change = (partyRelationshipId, parameters, username = state.hr) =>
    run(
        username,
        P + "apply#EmploymentChange",
        Object.assign({partyRelationshipId, expectedRevision: revisionOf(partyRelationshipId)}, parameters)
    )
// a change asked for and, when it waits, approved by the manager
function applied(partyRelationshipId, parameters) {
    const asked = change(partyRelationshipId, parameters)
    if (asked.error || asked.applied) return asked
    const decided = run(state.uMgr, P + "decide#EmploymentChange", {employmentChangeId: asked.employmentChangeId})
    return Object.assign({}, asked, {error: decided.error, applied: decided.applied})
}
const voided = row => row.thruDate != null && ms(row.thruDate) <= ms(row.fromDate)
const openRows = (entity, conditions) =>
    rows(entity, conditions).filter(row => !voided(row) && (row.thruDate == null || ms(row.thruDate) > Date.now() + 400 * day))
// the person's terms as their rows read far ahead: open assignment, open seats, departments and managers
function terms(partyRelationshipId, partyId) {
    const assignment = rows("mantle.humanres.employment.EmploymentAssignment", {partyRelationshipId})
        .filter(row => !voided(row) && row.thruDate == null)
        .map(row => [row.departmentPartyId, row.emplPositionId, row.managerPartyId, row.stateEnumId].join("/"))
        .join(";")
    const seats = openRows("mantle.humanres.position.EmplPositionParty", {partyId})
        .map(row => row.emplPositionId)
        .sort()
        .join(",")
    const members = openRows("mantle.party.PartyRelationship", {
        relationshipTypeEnumId: "PrtMember",
        fromPartyId: partyId,
        fromRoleTypeId: "Assignee"
    })
        .map(row => row.toPartyId)
        .join(",")
    const managers = openRows("mantle.party.PartyRelationship", {relationshipTypeEnumId: "PrtManager", toPartyId: partyId})
        .map(row => row.fromPartyId)
        .join(",")
    return [assignment, seats, members, managers].join("|")
}

spec({
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        organization(orgA, "People Scheduled Spec A")
        organization(orgB, "People Scheduled Spec B")
        state.mgr = person("MGR")
        employ(state.mgr, orgA)
        state.boss = person("BOSS")
        employ(state.boss, orgA)
        call("create#mantle.party.PartyRelationship", {
            relationshipTypeEnumId: "PrtManager",
            fromPartyId: state.mgr,
            toPartyId: state.boss,
            fromDate: since
        })
        state.hr = user("HR", ["PEOPLE_HR_VIEW", "PEOPLE_HR_EDIT"], [orgA])
        state.hrB = user("HRB", ["PEOPLE_HR_VIEW", "PEOPLE_HR_EDIT"], [orgB])
        state.reader = user("READER", ["PEOPLE_DIRECTORY_VIEW"], [orgA])
        state.uMgr = user("MGR", ["PEOPLE_TEAM_VIEW", "PEOPLE_REQUEST_APPROVE"], [], state.mgr)
        const unit = organizationName =>
            run(state.hr, "mantle.humanres.OrganizationServices.store#Unit", {
                unitKind: "department",
                organizationName,
                parentPartyId: orgA,
                fromDate: since
            }).partyId
        state.stores = unit("Stores")
        state.office = unit("Office")
        const classId = run(state.hr, "mantle.humanres.PositionServices.store#JobClass", {
            title: "Sched clerk"
        }).emplPositionClassId
        const seat = (departmentPartyId, description) => {
            const emplPositionId = run(state.hr, "mantle.humanres.PositionServices.store#Position", {
                organizationPartyId: orgA,
                departmentPartyId,
                emplPositionClassId: classId,
                description,
                fromDate: since
            }).emplPositionId
            call("update#mantle.humanres.position.EmplPosition", {emplPositionId, statusId: "EmpsActive"})
            return emplPositionId
        }
        state.seatStores = seat(state.stores, "Stores clerk")
        state.seatStores2 = seat(state.stores, "Stores clerk two")
        state.seatOffice = seat(state.office, "Office clerk")
        state.seatOffice2 = seat(state.office, "Office clerk two")
        const hire = (firstName, emplPositionId, key) =>
            run(state.hr, P + "hire#Employee", {
                organizationPartyId: orgA,
                firstName,
                lastName: "Sched",
                workEmail: firstName.toLowerCase() + "@sched.example",
                confirmNewPerson: true,
                fromDate: dayText(-30),
                departmentPartyId: state.stores,
                emplPositionId,
                managerPartyId: state.mgr,
                operationKey: key
            })
        state.ana = hire("Ana", state.seatStores, "SCHED-ANA")
        state.ben = hire("Ben", state.seatStores2, "SCHED-BEN")
        state.cal = hire("Cal", null, "SCHED-CAL")
    },
    cleanupSpec() {
        ec.message.clearErrors()
        login("john.doe")
    }
})

feature(
    "HR withdraws a transfer applied for a later date: it never takes effect, the seat, department and line stay as they were; a reader, another employer's HR officer and a change in effect are refused",
    {
        when() {
            const out = {}
            const employment = state.ana.partyRelationshipId
            const before = terms(employment, state.ana.partyId)
            const transfer = applied(employment, {
                changeKind: "transfer",
                effectiveDate: dayText(10),
                departmentPartyId: state.office,
                emplPositionId: state.seatOffice,
                managerPartyId: state.boss,
                reason: "Moving to the office"
            })
            out.transfer = [transfer.error, transfer.applied]
            out.scheduled = terms(employment, state.ana.partyId) !== before
            out.listed = run(state.hr, P + "find#EmploymentChanges", {
                partyId: state.ana.partyId,
                includeDone: true
            }).changes.find(row => row.employmentChangeId === transfer.employmentChangeId)?.canWithdraw
            const withdraw = (username, parameters) =>
                run(
                    username,
                    P + "withdraw#EmploymentChange",
                    Object.assign({employmentChangeId: transfer.employmentChangeId}, parameters)
                )
            out.reader = code(withdraw(state.reader, {reason: "No"}))
            out.hrB = code(withdraw(state.hrB, {reason: "No"}))
            out.noReason = code(withdraw(state.hr, {}))
            const done = withdraw(state.hr, {reason: "She stays in the stores"})
            out.done = [done.error, done.statusId, done.whole]
            out.after = terms(employment, state.ana.partyId) === before
            const row = one("mantle.humanres.employment.EmploymentChange", {employmentChangeId: transfer.employmentChangeId})
            out.recorded = [row.statusId, row.withdrawnByUserId === state.hr, row.withdrawReason]
            out.officeFree = openRows("mantle.humanres.position.EmplPositionParty", {emplPositionId: state.seatOffice}).length
            out.again = code(withdraw(state.hr, {reason: "Again"}))
            // a manager change in effect now is not withdrawn
            const now = change(employment, {changeKind: "manager", managerPartyId: state.boss, reason: "New manager"})
            out.inEffect = code(
                run(state.hr, P + "withdraw#EmploymentChange", {employmentChangeId: now.employmentChangeId, reason: "No"})
            )
            return out
        },
        then(out) {
            out.transfer.join("|") === "|true"
            out.scheduled === true
            out.listed === true
            out.reader === "PERMISSION_DENIED"
            out.hrB === "RECORD_UNAVAILABLE"
            out.noReason === "REASON_REQUIRED"
            out.done.join("|") === "|EchWithdrawn|true"
            out.after === true
            out.recorded.join("|") === "EchWithdrawn|true|She stays in the stores"
            out.officeFree === 0
            out.again === "NOT_WITHDRAWABLE"
            out.inEffect === "CHANGE_IN_EFFECT"
        }
    }
)

feature(
    "a separation dated before a scheduled transfer withdraws it, naming the separation: the employment ends from its date and the transfer's seat is never held",
    {
        when() {
            const out = {}
            const employment = state.ben.partyRelationshipId
            const transfer = applied(employment, {
                changeKind: "transfer",
                effectiveDate: dayText(10),
                departmentPartyId: state.office,
                emplPositionId: state.seatOffice2,
                reason: "Moving to the office"
            })
            out.transfer = [transfer.error, transfer.applied]
            const preview = run(state.hr, P + "preview#EmploymentChange", {
                partyRelationshipId: employment,
                changeKind: "separation",
                effectiveDate: dayText(5),
                reason: "Resigned"
            })
            out.preview = [preview.canApply, preview.impact.some(row => row.kind === "withdrawn")]
            const separation = applied(employment, {changeKind: "separation", effectiveDate: dayText(5), reason: "Resigned"})
            out.separation = [separation.error, separation.applied]
            const row = one("mantle.humanres.employment.EmploymentChange", {employmentChangeId: transfer.employmentChangeId})
            out.withdrawn = [row.statusId, row.supersededByChangeId === separation.employmentChangeId]
            const ended = one("mantle.party.PartyRelationship", {partyRelationshipId: employment}).thruDate
            out.ends = ec.l10n.format(ended, "yyyy-MM-dd") === dayText(5)
            out.officeHeld = rows("mantle.humanres.position.EmplPositionParty", {emplPositionId: state.seatOffice2}).filter(
                row => !voided(row)
            ).length
            return out
        },
        then(out) {
            out.transfer.join("|") === "|true"
            out.preview.join("|") === "true|true"
            out.separation.join("|") === "|true"
            out.withdrawn.join("|") === "EchWithdrawn|true"
            out.ends === true
            out.officeHeld === 0
        }
    }
)

feature("a return from leave comes before the leave's scheduled return, which it withdraws; the leave keeps its start", {
    when() {
        const out = {}
        const employment = state.cal.partyRelationshipId
        const leave = applied(employment, {changeKind: "leave", returnDate: dayText(20), reason: "Study leave"})
        out.leave = [leave.error, leave.applied]
        const early = applied(employment, {changeKind: "return", effectiveDate: dayText(5), reason: "Back early"})
        out.early = [early.error, early.applied]
        const assignments = rows("mantle.humanres.employment.EmploymentAssignment", {partyRelationshipId: employment})
            .filter(row => !voided(row))
            .sort((a, b) => ms(a.fromDate) - ms(b.fromDate))
        out.states = assignments.map(row => row.stateEnumId).join(",")
        out.returnsOn = ec.l10n.format(assignments[assignments.length - 1].fromDate, "yyyy-MM-dd") === dayText(5)
        const row = one("mantle.humanres.employment.EmploymentChange", {employmentChangeId: leave.employmentChangeId})
        out.leaveRow = [row.statusId, row.returnDate == null, row.supersededByChangeId === early.employmentChangeId]
        return out
    },
    then(out) {
        out.leave.join("|") === "|true"
        out.early.join("|") === "|true"
        out.states === "EasActive,EasLeave,EasActive"
        out.returnsOn === true
        out.leaveRow.join("|") === "EchApplied|true|true"
    }
})

feature(
    "a manager's separation dated later routes the employer's waiting decisions on its date: the daily job routes them and marks the change, and a rerun routes nothing",
    {
        when() {
            const out = {}
            const boss = rows("mantle.party.PartyRelationship", {
                relationshipTypeEnumId: "PrtEmployee",
                fromPartyId: state.boss,
                toPartyId: orgA
            })[0]
            const separation = applied(boss.partyRelationshipId, {
                changeKind: "separation",
                effectiveDate: dayText(3),
                reason: "Retiring"
            })
            out.separation = [separation.error, separation.applied]
            const row = () =>
                one("mantle.humanres.employment.EmploymentChange", {employmentChangeId: separation.employmentChangeId})
            const job = () => run("john.doe", P + "apply#DueAssignments", {})
            job()
            out.before = row().reroutedDate == null
            ec.user.setEffectiveTime(Date.now() + 4 * day)
            try {
                const first = job()
                out.onDate = [first.error, first.rerouted > 0, row().reroutedDate != null, job().rerouted]
            } finally {
                ec.user.setEffectiveTime(null)
            }
            return out
        },
        then(out) {
            out.separation.join("|") === "|true"
            out.before === true
            out.onDate.join("|") === "|true|true|0"
        }
    }
)
