// People's organization and reporting lines (mantle.humanres.OrganizationServices; IronStone People design §4 OrgStructure and
// OrgChart, PE-03; impl-people P3): a department and a team under an employer, a cycle, a department under a team, a move to
// another employer, a stale date and a stale revision refused, a move dated with the old parent ended and both parents read by
// as-of date; a team membership and its lead changing no employment, the lead before staying a member, a person not employed
// refused, a lead changed since the unit was read refused (its revision); a manager change dated and refused when self, cyclic,
// to a manager the employer does not employ or on a line another employer the caller does not read keeps too, with the people
// with no manager at the top of the tree; and a reporting line per employment: a manager at one employer of a person employed by two is
// that employment's alone, for the team reader, the tree, the directory and Home's due work. A directory reader reads and changes
// nothing; another employer's unit is refused as a missing one. Standalone: spec-local organizations, people, employments, groups
// and users, with artifact authorization disabled (the rules are the services' own permission and scope checks).
// Run: ./moq test mr-mantle --spec PeopleOrganization
const prefix = "PEOPLE_ORG_SPEC"
const orgA = prefix + "_A",
    orgB = prefix + "_B",
    since = "2000-01-01T00:00:00Z"
const O = "mantle.humanres.OrganizationServices."
const P = "mantle.humanres.PeopleServices."
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
// the reason code of a refusal, or "" when the call succeeds
const code = out => (out.error ? /[A-Z][A-Z0-9_]{3,}(?=:)/.exec(out.error)?.[0] || out.error : "")
function organization(partyId, name) {
    call("create#mantle.party.Party", {partyId, partyTypeEnumId: "PtyOrganization", ownerPartyId: partyId})
    call("create#mantle.party.Organization", {partyId, organizationName: name})
    call("create#mantle.party.PartyRole", {partyId, roleTypeId: "OrgInternal"})
}
function person(kind) {
    const partyId = prefix + "_" + kind
    call("create#mantle.party.Party", {partyId, partyTypeEnumId: "PtyPerson"})
    call("create#mantle.party.Person", {partyId, firstName: "Org", lastName: kind})
    return partyId
}
function employ(partyId, organizationPartyId) {
    return call("mantle.humanres.EmploymentServices.create#Employment", {
        fromPartyId: partyId,
        toPartyId: organizationPartyId,
        fromDate: since
    }).partyRelationshipId
}
function manage(managerPartyId, partyId) {
    call("create#mantle.party.PartyRelationship", {
        relationshipTypeEnumId: "PrtManager",
        fromPartyId: managerPartyId,
        fromRoleTypeId: "Manager",
        toPartyId: partyId,
        toRoleTypeId: "Employee",
        fromDate: since
    })
}
// a user of a spec-local group with the permissions, an agent of the organizations, or the person given
function user(kind, permissions, organizationPartyIds, partyId = null) {
    const id = prefix + "_U_" + kind
    call("create#moqui.security.UserGroup", {userGroupId: id, description: "People organization " + kind})
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
const unitIds = out => (out.units || []).map(row => row.partyId)

spec({
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        state.now = ec.user.timestampMillis(ec.user.nowTimestamp)
        organization(orgA, "People Org Spec A")
        organization(orgB, "People Org Spec B")
        // A: a lead (HEAD) over a manager (MGR) over a report (REPORT), and two more employees; DUAL employed by A and B and
        // managed by MGR, who is employed by A only; B: its own employee (BETA); BOTH and SHARED employed by A and B, BOTH managing
        // SHARED, so their line is at both employers
        for (const kind of ["HEAD", "MGR", "REPORT", "PEER", "OTHER", "DUAL", "BETA", "BOTH", "SHARED"])
            state[kind] = person(kind)
        for (const kind of ["HEAD", "MGR", "REPORT", "PEER", "OTHER", "DUAL", "BOTH", "SHARED"]) employ(state[kind], orgA)
        for (const kind of ["DUAL", "BETA", "BOTH", "SHARED"]) employ(state[kind], orgB)
        manage(state.HEAD, state.MGR)
        manage(state.MGR, state.REPORT)
        manage(state.MGR, state.DUAL)
        manage(state.BOTH, state.SHARED)
        state.hr = user("HR", ["PEOPLE_HR_VIEW", "PEOPLE_HR_EDIT"], [orgA])
        state.hrB = user("HRB", ["PEOPLE_HR_VIEW", "PEOPLE_HR_EDIT"], [orgB])
        state.hrBoth = user("HRBOTH", ["PEOPLE_HR_VIEW", "PEOPLE_HR_EDIT"], [orgA, orgB])
        state.reader = user("READER", ["PEOPLE_DIRECTORY_VIEW"], [orgA])
        state.manager = user("MGR", ["PEOPLE_TEAM_VIEW"], [], state.MGR)
    },
    cleanupSpec() {
        ec.message.clearErrors()
        login("john.doe")
    }
})

feature(
    "a department and a team are units under their employer; a cycle, a department under a team, another employer, a stale date or revision are refused; a move is dated and both parents read by as-of date",
    {
        when() {
            const store = (user, parameters) => run(user, O + "store#Unit", parameters)
            const sales = store(state.hr, {unitKind: "department", organizationName: "Sales", parentPartyId: orgA}).partyId
            const east = store(state.hr, {unitKind: "department", organizationName: "East", parentPartyId: sales}).partyId
            const team = store(state.hr, {unitKind: "team", organizationName: "Floor", parentPartyId: east}).partyId
            const service = store(state.hr, {unitKind: "department", organizationName: "Service", parentPartyId: orgA}).partyId
            const unitB = store(state.hrB, {unitKind: "department", organizationName: "B Ops", parentPartyId: orgB}).partyId
            const read = (user, partyId) => run(user, O + "get#Unit", {partyId})
            const revision = partyId => read(state.hr, partyId).unit.revision
            // the refusals, each with parameters a successful call differs from in one value
            const refusals = {
                cycle: code(store(state.hr, {partyId: sales, parentPartyId: east, expectedRevision: revision(sales)})),
                underTeam: code(store(state.hr, {unitKind: "department", organizationName: "X", parentPartyId: team})),
                otherEmployer: code(store(state.hrBoth, {partyId: east, parentPartyId: unitB, expectedRevision: revision(east)})),
                otherEmployerB: code(store(state.hrB, {partyId: east, parentPartyId: unitB, expectedRevision: revision(east)})),
                stale: code(
                    store(state.hr, {
                        partyId: east,
                        parentPartyId: service,
                        fromDate: state.now - 40 * 365 * day,
                        expectedRevision: revision(east)
                    })
                ),
                revision: code(store(state.hr, {partyId: east, parentPartyId: service, expectedRevision: "0"})),
                kind: code(store(state.hr, {unitKind: "division", organizationName: "X", parentPartyId: orgA})),
                reader: code(store(state.reader, {unitKind: "department", organizationName: "X", parentPartyId: orgA})),
                legal: code(store(state.hr, {partyId: orgA, organizationName: "A", expectedRevision: ""}))
            }
            // East moves under Service from next month: the old parent ends then, both rows kept
            const next = state.now + 30 * day
            const moved = store(state.hr, {
                partyId: east,
                parentPartyId: service,
                fromDate: next,
                changeReason: "Reorganized",
                expectedRevision: revision(east)
            })
            const scheduled = code(store(state.hr, {partyId: east, parentPartyId: orgA, expectedRevision: revision(east)}))
            const parentNow = run(state.reader, O + "find#Units", {parentPartyId: sales})
            const parentLater = run(state.reader, O + "find#Units", {parentPartyId: service, asOfDate: next + day})
            const top = run(state.hr, O + "find#Units")
            const level = run(state.hr, O + "find#Units", {parentPartyId: orgA})
            const history = read(state.hr, east).parents
            const searched = run(state.reader, O + "find#Units", {term: "floor"})
            state.sales = sales
            state.team = team
            return {
                created: [sales, east, team, service, unitB].every(Boolean),
                refusals,
                moved: moved.error,
                scheduled,
                parentNow: unitIds(parentNow),
                parentLater: unitIds(parentLater),
                top: unitIds(top),
                level: level.units.map(row => [row.organizationName, row.unitKind, row.childCount, row.canEdit].join(" ")),
                readerEdit: (run(state.reader, O + "find#Units", {parentPartyId: orgA}).units || []).some(row => row.canEdit),
                history: history.map(row => [row.parentPartyId, row.state, row.reason].join(" ")),
                searched: unitIds(searched),
                otherUnit: code(read(state.hr, unitB)),
                otherParent: code(run(state.hr, O + "find#Units", {parentPartyId: orgB})),
                sales,
                east,
                team,
                service
            }
        },
        then({
            created,
            refusals,
            moved,
            scheduled,
            parentNow,
            parentLater,
            top,
            level,
            readerEdit,
            history,
            searched,
            otherUnit,
            otherParent,
            sales,
            east,
            team,
            service
        }) {
            created == true
            refusals ==
                {
                    cycle: "PARENT_CYCLE",
                    underTeam: "PARENT_KIND",
                    otherEmployer: "EMPLOYER_CHANGE",
                    otherEmployerB: "RECORD_UNAVAILABLE",
                    stale: "DATE_STALE",
                    revision: "REVISION_CHANGED",
                    kind: "KIND_INVALID",
                    reader: "PERMISSION_DENIED",
                    legal: "NOT_A_UNIT"
                }
            moved == ""
            scheduled == "PARENT_SCHEDULED"
            parentNow == [east]
            parentLater == [east]
            top == [orgA]
            level == ["Sales department 1 true", "Service department 0 true"]
            readerEdit == false
            history == [service + " future Reorganized", sales + " current "]
            searched == [team]
            otherUnit == "RECORD_UNAVAILABLE"
            otherParent == "RECORD_UNAVAILABLE"
        }
    }
)

feature(
    "a team's members and lead are dated memberships that change no employment; a new lead's predecessor stays a member; a person not employed is refused",
    {
        when() {
            const employments = () =>
                ec.entity
                    .find("mantle.party.PartyRelationship")
                    .condition("relationshipTypeEnumId", "PrtEmployee")
                    .condition("fromPartyId", "in", [state.REPORT, state.PEER, state.OTHER])
                    .count()
            const before = employments()
            const join = (partyId, memberRole, extra = {}) =>
                run(state.hr, O + "store#Membership", Object.assign({unitPartyId: state.team, partyId, memberRole}, extra))
            const member = join(state.REPORT, "member")
            const lead = join(state.PEER, "lead")
            const again = code(join(state.REPORT, "member"))
            const notEmployed = code(join(state.BETA, "member"))
            // the unit as an editor read it with PEER the lead; a new lead since makes that form's save (its lead) stale
            const readRevision = run(state.hr, O + "get#Unit", {partyId: state.team}).unit.revision
            const newLead = join(state.OTHER, "lead", {changeReason: "Rotation"})
            const staleLead = code(
                run(state.hr, O + "store#Unit", {partyId: state.team, headPartyId: state.PEER, expectedRevision: readRevision})
            )
            const unit = run(state.reader, O + "get#Unit", {partyId: state.team})
            const current = unit.members.filter(row => row.state == "current")
            const reportRow = current.find(row => row.partyId == state.REPORT)
            const stale = code(
                run(state.hr, O + "store#Membership", {
                    unitPartyId: state.team,
                    partyRelationshipId: reportRow.partyRelationshipId,
                    expectedRevision: "x"
                })
            )
            const ended = run(state.hr, O + "store#Membership", {
                unitPartyId: state.team,
                partyRelationshipId: reportRow.partyRelationshipId,
                expectedRevision: reportRow.revision,
                changeReason: "Moved on"
            })
            const roles = Array.from(
                ec.entity
                    .find("mantle.party.PartyRelationship")
                    .condition("relationshipTypeEnumId", "PrtMember")
                    .condition("toPartyId", state.team)
                    .list()
            ).map(row => row.fromPartyId + " " + row.fromRoleTypeId)
            const after = run(state.reader, O + "get#Unit", {partyId: state.team})
            return {
                errors: [member.error, lead.error, newLead.error, ended.error],
                again,
                notEmployed,
                staleLead,
                stale,
                current: current.map(row => row.personName + " " + row.roleText).sort(),
                roles: roles.sort(),
                employmentsUnchanged: employments() == before,
                teamPeople: (after.unit || {}).peopleCount,
                headName: (after.unit || {}).headName,
                readerMembers: unit.error
            }
        },
        then({
            errors,
            again,
            notEmployed,
            staleLead,
            stale,
            current,
            roles,
            employmentsUnchanged,
            teamPeople,
            headName,
            readerMembers
        }) {
            errors == ["", "", "", ""]
            again == "ALREADY_MEMBER"
            notEmployed == "NOT_EMPLOYED"
            staleLead == "REVISION_CHANGED"
            stale == "REVISION_CHANGED"
            current == ["Org OTHER Lead", "Org PEER Member", "Org REPORT Member"]
            roles ==
                [state.OTHER + " Manager", state.PEER + " Assignee", state.PEER + " Manager", state.REPORT + " Assignee"].sort()
            employmentsUnchanged == true
            teamPeople == 2
            headName == "Org OTHER"
            readerMembers == ""
        }
    }
)

feature(
    "a manager change is dated, the line before ended; self, cyclic and outside managers and a stale revision are refused; people with no manager stay at the top",
    {
        when() {
            const tree = (parameters = {}) =>
                run(state.hr, O + "get#ReportingTree", Object.assign({organizationPartyId: orgA}, parameters))
            const nodeOf = (parameters, partyId) => (tree(parameters).nodes || []).find(row => row.partyId == partyId)
            const peer = nodeOf({partyId: state.PEER}, state.PEER)
            const change = parameters =>
                run(state.hr, O + "change#Manager", Object.assign({organizationPartyId: orgA}, parameters))
            const report = nodeOf({partyId: state.REPORT}, state.REPORT)
            const dual = nodeOf({partyId: state.DUAL}, state.DUAL)
            const shared = nodeOf({partyId: state.SHARED}, state.SHARED)
            const refusals = {
                self: code(change({partyId: state.PEER, managerPartyId: state.PEER, expectedRevision: peer.lineRevision})),
                cycle: code(change({partyId: state.HEAD, managerPartyId: state.REPORT, expectedRevision: ""})),
                outside: code(change({partyId: state.PEER, managerPartyId: state.BETA, expectedRevision: peer.lineRevision})),
                stale: code(change({partyId: state.REPORT, managerPartyId: state.PEER, expectedRevision: ""})),
                unchanged: code(
                    change({partyId: state.REPORT, managerPartyId: state.MGR, expectedRevision: report.lineRevision})
                ),
                reader: code(
                    run(state.reader, O + "change#Manager", {
                        organizationPartyId: orgA,
                        partyId: state.PEER,
                        managerPartyId: state.MGR
                    })
                ),
                otherEmployer: code(run(state.hr, O + "change#Manager", {partyId: state.BETA, managerPartyId: state.DUAL})),
                // A's HR may not start a line that would be B's too (BOTH and DUAL both employed by B), nor end one that is
                sharedNew: code(change({partyId: state.DUAL, managerPartyId: state.BOTH, expectedRevision: dual.lineRevision})),
                sharedEnded: code(
                    change({partyId: state.SHARED, managerPartyId: state.MGR, expectedRevision: shared.lineRevision})
                )
            }
            // REPORT moves from MGR to PEER from next month
            const next = state.now + 30 * day
            const changed = change({
                partyId: state.REPORT,
                managerPartyId: state.PEER,
                fromDate: next,
                changeReason: "Team change",
                expectedRevision: report.lineRevision
            })
            const lines = Array.from(
                ec.entity
                    .find("mantle.party.PartyRelationship")
                    .condition("relationshipTypeEnumId", "PrtManager")
                    .condition("toPartyId", state.REPORT)
                    .orderBy("fromDate")
                    .list()
            ).map(row => [row.fromPartyId, row.thruDate ? ec.user.timestampMillis(row.thruDate) == next : "open"].join(" "))
            const top = tree()
                .nodes.map(row => row.partyId)
                .sort()
            const mgrNow = tree({managerPartyId: state.MGR})
                .nodes.map(row => row.partyId)
                .sort()
            const peerLater = tree({parentNodeId: orgA + "/" + state.PEER, asOfDate: next + day}).nodes.map(row => row.partyId)
            const readerTop = run(state.reader, O + "get#ReportingTree").nodes
            return {refusals, changed: changed.error, lines, top, mgrNow, peerLater, readerTop}
        },
        then({refusals, changed, lines, top, mgrNow, peerLater, readerTop}) {
            refusals ==
                {
                    self: "SELF_REPORTING",
                    cycle: "REPORTING_CYCLE",
                    outside: "MANAGER_NOT_EMPLOYED",
                    stale: "REVISION_CHANGED",
                    unchanged: "MANAGER_UNCHANGED",
                    reader: "PERMISSION_DENIED",
                    otherEmployer: "RECORD_UNAVAILABLE",
                    sharedNew: "LINE_SHARED",
                    sharedEnded: "LINE_SHARED"
                }
            changed == ""
            lines == [state.MGR + " true", state.PEER + " open"]
            // HEAD and BOTH lead; PEER and OTHER have no manager, listed at the top rather than lost
            top == [state.HEAD, state.OTHER, state.PEER, state.BOTH].sort()
            mgrNow == [state.DUAL, state.REPORT].sort()
            peerLater == [state.REPORT]
            readerTop.every(row => row.lineRevision == null && row.workEmail != null)
            readerTop.some(row => row.partyId == state.HEAD && row.reportCount == 1 && row.noManager)
        }
    }
)

feature(
    "a reporting line is per employment: a manager at one employer of a person employed by two manages that employment alone",
    {
        when() {
            // MGR (employed by A) manages DUAL (employed by A and B): A's line, not B's
            const managerScope = run(state.manager, P + "get#Scope", {partyId: state.DUAL})
            const managerList = run(state.manager, P + "find#Employees")
            const dueB = run(state.hrB, P + "get#Home", {organizationPartyId: orgB})
            const treeB = run(state.hrB, O + "get#ReportingTree")
            const directoryB = run(state.hrB, P + "find#Employees", {term: "DUAL"})
            const filteredB = run(state.hrB, P + "find#Employees", {managerPartyId: state.MGR})
            return {
                employments: managerScope.partyEmployments.map(row => row.organizationPartyId),
                listed: managerList.employees.filter(row => row.partyId == state.DUAL).map(row => row.organizationPartyId),
                dueB: dueB.dueWork.map(row => row.partyId).sort(),
                treeB: treeB.nodes
                    .filter(row => row.partyId == state.DUAL)
                    .map(row => [row.organizationPartyId, row.noManager].join(" ")),
                directoryB: directoryB.employees.map(row => row.managerName),
                filteredB: filteredB.employees.length
            }
        },
        then({employments, listed, dueB, treeB, directoryB, filteredB}) {
            employments == [orgA]
            listed == [orgA]
            // SHARED is managed at B (BOTH's line is at both employers), DUAL is not
            dueB == [state.BETA, state.BOTH, state.DUAL].sort()
            treeB == [orgB + " true"]
            directoryB == [""]
            filteredB == 0
        }
    }
)
