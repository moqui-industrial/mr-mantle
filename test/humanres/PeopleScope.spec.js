// People scope (mantle.humanres.PeopleServices; IronStone People design §1.1, impl-people P1): a staff reader's employers and the
// units under them, another employer and a forged one refused by reason code, an edit permission alone reading nothing, and
// PEOPLE_ALL_ORGANIZATIONS widening a staff read to every internal organization while reading nothing by itself; a person
// admitted by employment and its dates (a directory reader the current employments, an HR reader the history too), by the live
// reporting line and as self, and a person outside the scope refused as a missing one; Home's counts (distinct people against
// employments, the joins and exits of 30 days, an HR reader's due work); the setup readiness answering Admin's contract; and (P8)
// the manager's team (their reports' employments at the employers of the lines, none at another) and their own self-service,
// neither reading a supplied party.
// Standalone: spec-local organizations, people, employments, groups and users, with artifact authorization disabled (the rules
// are the services' own permission and scope checks).
// Run: ./moq test mr-mantle --spec PeopleScope
const prefix = "PEOPLE_SCOPE_SPEC"
const orgA = prefix + "_A",
    orgB = prefix + "_B",
    department = prefix + "_DEPT",
    since = "2000-01-01T00:00:00Z"
const S = "mantle.humanres.PeopleServices."
const day = 24 * 60 * 60 * 1000
const state = {}

// a call as a user: its result with its error text ("" when it succeeds), in its own transaction
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
function organization(partyId, name, roleTypeId) {
    call("create#mantle.party.Party", {partyId, partyTypeEnumId: "PtyOrganization", ownerPartyId: partyId})
    call("create#mantle.party.Organization", {partyId, organizationName: name})
    call("create#mantle.party.PartyRole", {partyId, roleTypeId})
}
function person(kind) {
    const partyId = prefix + "_" + kind
    call("create#mantle.party.Party", {partyId, partyTypeEnumId: "PtyPerson"})
    call("create#mantle.party.Person", {partyId, firstName: "Scope", lastName: kind})
    return partyId
}
function employ(partyId, organizationPartyId, fromDate = since, thruDate = null) {
    return call("mantle.humanres.EmploymentServices.create#Employment", {
        fromPartyId: partyId,
        toPartyId: organizationPartyId,
        fromDate,
        thruDate
    }).partyRelationshipId
}
// a user of a spec-local group with the permissions, an agent of the organizations (or the person given, whose own employment
// makes them a member)
function user(kind, permissions, organizationPartyIds, partyId = null) {
    const id = prefix + "_U_" + kind
    call("create#moqui.security.UserGroup", {userGroupId: id, description: "People scope " + kind})
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

spec({
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        const now = ec.user.timestampMillis(ec.user.nowTimestamp)
        organization(orgA, "People Scope Spec A", "OrgInternal")
        organization(orgB, "People Scope Spec B", "OrgInternal")
        organization(department, "People Scope Spec Department", "OrgDepartment")
        call("create#mantle.party.PartyRelationship", {
            relationshipTypeEnumId: "PrtOrgRollup",
            fromPartyId: department,
            fromRoleTypeId: "OrgDepartment",
            toPartyId: orgA,
            toRoleTypeId: "OrgInternal",
            fromDate: since
        })
        // A: a manager and their report, an employee with no manager, one ended ten days ago, one joined five days ago and one
        // employed by A and B; B: its own employee; and a contractor of A who is not an employee
        for (const kind of ["MANAGER", "REPORT", "UNMANAGED", "ENDED", "JOINED", "DUAL", "BETA", "CONTRACTOR"])
            state[kind] = person(kind)
        for (const kind of ["MANAGER", "REPORT", "UNMANAGED", "DUAL"]) employ(state[kind], orgA)
        state.endedEmployment = employ(state.ENDED, orgA, since, now - 10 * day)
        employ(state.JOINED, orgA, now - 5 * day)
        employ(state.DUAL, orgB)
        employ(state.BETA, orgB)
        call("create#mantle.party.PartyRelationship", {
            relationshipTypeEnumId: "PrtAgent",
            fromPartyId: state.CONTRACTOR,
            toPartyId: orgA,
            toRoleTypeId: "OrgInternal",
            fromDate: since
        })
        call("create#mantle.party.PartyRelationship", {
            relationshipTypeEnumId: "PrtManager",
            fromPartyId: state.MANAGER,
            fromRoleTypeId: "Manager",
            toPartyId: state.REPORT,
            toRoleTypeId: "Employee",
            fromDate: since
        })
        state.reader = user("READER", ["PEOPLE_DIRECTORY_VIEW"], [orgA])
        state.hr = user("HR", ["PEOPLE_HR_VIEW", "PEOPLE_HR_EDIT"], [orgA])
        state.hrBoth = user("HRBOTH", ["PEOPLE_HR_VIEW"], [orgA, orgB])
        state.editOnly = user("EDITONLY", ["PEOPLE_HR_EDIT"], [orgA])
        state.configure = user("CONFIGURE", ["PEOPLE_CONFIGURE"], [orgA, orgB])
        state.manager = user("MGR", ["PEOPLE_TEAM_VIEW", "PEOPLE_SELF_SERVICE"], [], state.MANAGER)
        state.everyHr = user("EVERYHR", ["PEOPLE_HR_VIEW", "PEOPLE_ALL_ORGANIZATIONS"], [orgA])
        state.everyOnly = user("EVERYONLY", ["PEOPLE_ALL_ORGANIZATIONS"], [orgA])
    },
    cleanupSpec() {
        ec.message.clearErrors()
        login("john.doe")
    }
})

feature(
    "a staff reader's scope is their employers and the units under them; another employer is refused by reason code, an edit permission alone reads nothing, and PEOPLE_ALL_ORGANIZATIONS widens a read to every employer",
    {
        when() {
            const hr = run(state.hr, S + "get#Scope")
            const both = run(state.hrBoth, S + "get#Scope", {organizationPartyId: orgB})
            const other = run(state.hr, S + "get#Scope", {organizationPartyId: orgB})
            const forged = run(state.hr, S + "get#Scope", {organizationPartyId: prefix + "_FORGED"})
            const editOnly = run(state.editOnly, S + "get#Scope")
            // an agent of A holding PEOPLE_ALL_ORGANIZATIONS with an HR read: B and its employee too; the permission alone: nothing
            const every = run(state.everyHr, S + "get#Scope")
            const everyB = run(state.everyHr, S + "get#Scope", {organizationPartyId: orgB, partyId: state.BETA})
            const everyOnly = run(state.everyOnly, S + "get#Scope")
            const everyEmployers = [orgA, orgB, department].map(id => (every.organizationPartyIds || []).includes(id))
            return {hr, both, other, forged, editOnly, every, everyEmployers, everyB, everyOnly}
        },
        then({hr, both, other, forged, editOnly, every, everyEmployers, everyB, everyOnly}) {
            hr.error == ""
            hr.organizationPartyIds == [orgA]
            hr.unitPartyIds == [department]
            hr.capabilities.hrView == true
            hr.capabilities.directory == false
            hr.allOrganizations == false
            both.error == ""
            both.organizationPartyIds == [orgB]
            other.error.includes("ORGANIZATION_DENIED")
            forged.error.includes("ORGANIZATION_DENIED")
            editOnly.error == ""
            editOnly.capabilities.hrEdit == true
            editOnly.capabilities.staff == false
            editOnly.organizationPartyIds == []
            every.error == ""
            every.allOrganizations == true
            everyEmployers == [true, true, false]
            everyB.error == ""
            everyB.unitPartyIds == []
            everyB.partyAccess == ["staff"]
            everyOnly.error == ""
            everyOnly.capabilities.allOrganizations == true
            everyOnly.organizationPartyIds == []
        }
    }
)

feature(
    "a person is admitted by employment and its dates, by the live reporting line and as self; one outside the scope is refused as a missing one",
    {
        when() {
            const access = (user, partyId) => {
                const out = run(user, S + "get#Scope", {partyId})
                return out.error ? /[A-Z][A-Z0-9_]+(?=:)/.exec(out.error)?.[0] || out.error : out.partyAccess.join(",")
            }
            return {
                // the directory reader: a current employee, not one ended, a contractor, B's employee or a forged party
                reader: ["REPORT", "ENDED", "CONTRACTOR", "BETA"].map(kind => access(state.reader, state[kind])),
                forged: access(state.reader, prefix + "_FORGED"),
                // the HR reader: the ended employment too, with that employment shown
                hrEnded: run(state.hr, S + "get#Scope", {partyId: state.ENDED}),
                hrBeta: access(state.hr, state.BETA),
                // the employment shown of a person employed by both: A's only to an HR reader of A
                hrDual: run(state.hr, S + "get#Scope", {partyId: state.DUAL}).partyEmployments.map(
                    row => row.organizationPartyId
                ),
                // a reader of A and B asking within A: B's employee is not admitted there
                bothNarrowed: access(state.hrBoth, state.BETA),
                bothInA: run(state.hrBoth, S + "get#Scope", {organizationPartyId: orgA, partyId: state.BETA}).error,
                // the manager: self and their report, not another employee of their employer
                manager: ["MANAGER", "REPORT", "UNMANAGED"].map(kind => access(state.manager, state[kind])),
                managerReports: run(state.manager, S + "get#Scope").reportPartyIds,
                managerEmployments: run(state.manager, S + "get#Scope").employments.map(row => row.organizationPartyId),
                editOnly: access(state.editOnly, state.REPORT)
            }
        },
        then({
            reader,
            forged,
            hrEnded,
            hrBeta,
            hrDual,
            bothNarrowed,
            bothInA,
            manager,
            managerReports,
            managerEmployments,
            editOnly
        }) {
            reader == ["staff", "RECORD_UNAVAILABLE", "RECORD_UNAVAILABLE", "RECORD_UNAVAILABLE"]
            forged == "RECORD_UNAVAILABLE"
            hrEnded.error == ""
            hrEnded.partyAccess == ["staff"]
            hrEnded.partyEmployments.map(row => row.partyRelationshipId) == [state.endedEmployment]
            hrBeta == "RECORD_UNAVAILABLE"
            hrDual == [orgA]
            bothNarrowed == "staff"
            bothInA.includes("RECORD_UNAVAILABLE")
            manager == ["self", "team", "RECORD_UNAVAILABLE"]
            managerReports == [state.REPORT]
            managerEmployments == [orgA]
            editOnly == "RECORD_UNAVAILABLE"
        }
    }
)

feature(
    "Home counts distinct people apart from employments, the joins and exits of 30 days and an HR reader's due work; a reader of no employer is refused",
    {
        when() {
            const hr = run(state.hr, S + "get#Home")
            const both = run(state.hrBoth, S + "get#Home")
            const reader = run(state.reader, S + "get#Home")
            const other = run(state.hr, S + "get#Home", {organizationPartyId: orgB})
            const editOnly = run(state.editOnly, S + "get#Home")
            return {hr, both, reader, other, editOnly}
        },
        then({hr, both, reader, other, editOnly}) {
            hr.error == ""
            // P8: the vacant seats too (none: the spec makes no position)
            hr.counts == {headcount: 5, employments: 5, joins: 1, exits: 1, vacancies: 0}
            hr.hasEmployees == true
            hr.dueWorkCount == 4
            hr.dueWork.map(row => row.partyId).sort() == [state.DUAL, state.JOINED, state.MANAGER, state.UNMANAGED].sort()
            hr.dueWork.every(row => row.organizationPartyId == orgA && row.dueKind == "noManager")
            both.counts.headcount == 6
            both.counts.employments == 7
            reader.error == ""
            reader.counts == {headcount: 5, employments: 5}
            reader.dueWork == []
            other.error.includes("ORGANIZATION_DENIED")
            editOnly.error.includes("PERMISSION_DENIED")
        }
    }
)

feature(
    "the setup readiness answers Admin's contract for an organization with employees; another organization and a caller without PEOPLE_CONFIGURE are refused",
    {
        when() {
            const all = run(state.configure, S + "get#Readiness", {providerKey: "people.setup"})
            const one = run(state.configure, S + "get#Readiness", {providerKey: "people.setup", organizationPartyId: orgA})
            const hr = run(state.hr, S + "get#Readiness", {providerKey: "people.setup", organizationPartyId: orgA})
            const outside = run(state.configure, S + "get#Readiness", {
                providerKey: "people.setup",
                organizationPartyId: prefix + "_FORGED"
            })
            const summary = checks =>
                checks.map(row => [row.organizationPartyId, row.checkKey, row.state, row.reasonCode].join(" "))
            return {all: summary(all.checks || []), one: one.checks || [], hr, outside}
        },
        then({all, one, hr, outside}) {
            all.sort() ==
                [
                    orgA + " people.departments ready ",
                    orgA + " people.managers warning EMPLOYEE_NO_MANAGER",
                    orgB + " people.departments warning NO_DEPARTMENT",
                    orgB + " people.managers warning EMPLOYEE_NO_MANAGER"
                ].sort()
            one.length == 2
            one.every(row => row.fixRoute == "peopleSettings" && row.subject && row.scope.organizationPartyId == orgA && row.title && row.message)
            one.find(row => row.checkKey == "people.managers").message == "4 employees have no manager"
            hr.error.includes("PERMISSION_DENIED")
            outside.error.includes("ORGANIZATION_DENIED")
        }
    }
)

feature(
    "a manager's team is their reports' employments at the employers of their lines, not a report's at another employer; self-service is the caller's own; a supplied party changes neither",
    {
        when() {
            // the manager manages the person employed by A and B too: the line is at A, where both work
            login("john.doe")
            ec.artifactExecution.disableAuthz()
            call("create#mantle.party.PartyRelationship", {
                relationshipTypeEnumId: "PrtManager",
                fromPartyId: state.MANAGER,
                fromRoleTypeId: "Manager",
                toPartyId: state.DUAL,
                toRoleTypeId: "Employee",
                fromDate: since
            })
            const rowsOf = out =>
                (out.team || []).map(row => [row.partyId, row.organizationPartyId, row.availabilityText].join(" "))
            const team = run(state.manager, S + "get#Team")
            // a supplied party is not a parameter of either service: it is dropped and changes nothing
            const forged = run(state.manager, S + "get#Team", {partyId: state.BETA, managerPartyId: state.BETA})
            const self = run(state.manager, S + "get#SelfService", {partyId: state.REPORT})
            return {
                team: rowsOf(team),
                ids: (team.team || []).filter(row => row.partyRelationshipId).length,
                forged: rowsOf(forged),
                readerTeam: run(state.reader, S + "get#Team").error,
                self,
                readerSelf: run(state.reader, S + "get#SelfService").error,
                readerCheck: run(state.reader, S + "get#SelfService", {checkOnly: true}),
                requests: run(state.manager, S + "find#MyRequests", {partyId: state.REPORT})
            }
        },
        then({team, ids, forged, readerTeam, self, readerSelf, readerCheck, requests}) {
            team == [state.DUAL + " " + orgA + " Working", state.REPORT + " " + orgA + " Working"]
            ids == 0
            forged == team
            readerTeam.includes("PERMISSION_DENIED")
            self.error == ""
            self.partyId == state.MANAGER
            self.employments.map(row => row.organizationPartyId) == [orgA]
            self.emergencyContacts == []
            readerSelf.includes("PERMISSION_DENIED")
            readerCheck.error == ""
            readerCheck.available == false
            requests.error == ""
            requests.requestsCount == 0
        }
    }
)
