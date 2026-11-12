// A hire and an employment's dated changes (mantle.humanres.PeopleServices preview#Hire, hire#Employee, preview#EmploymentChange,
// apply#EmploymentChange, decide#EmploymentChange and the PeopleEmploymentChangeApproval topic; EmploymentServices create#Employment's
// overlap check; OrganizationServices change#Manager, store#Membership and store#Unit's closure as P6 changes them; IronStone People
// design §4, PE-02; impl-people P6): a contractor hired beside their contractor relationship, an overlapping employment refused, a
// retry with the key answering the first hire, a person employed by another employer found and not made again, an orphan
// relationship completed and a rehire beside the ended employment; a transfer waiting for the manager's approval and applied from
// its date (the old assignment ended, the department membership, seat and line moved), a stale revision and a change superseded
// meanwhile refused; the manager per employment; a separation ending one employment and leaving the other, its reports with no
// manager and its waiting decision sent to the alternate; a department's members read only and its closure reassigning them.
// Standalone: spec-local organizations, people, employments, groups and users, with artifact authorization disabled (the rules
// are the services' own checks). Run: ./moq test mr-mantle --spec PeopleEmployment
const prefix = "PEOPLE_EMP_SPEC"
const orgA = prefix + "_A",
    orgB = prefix + "_B",
    since = "2001-01-01T00:00:00Z"
const P = "mantle.humanres.PeopleServices."
const O = "mantle.humanres.OrganizationServices."
const S = "mantle.humanres.PositionServices."
const A = "mantle.humanres.PeopleApprovalServices."
const NOTIFY = "org.moqui.ui.NotificationServices."
const state = {}
const day = 24 * 60 * 60 * 1000

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
const rows = (entity, conditions) => Array.from(ec.entity.find(entity).condition(conditions).disableAuthz().list())
const one = (entity, conditions) => ec.entity.find(entity).condition(conditions).disableAuthz().one()
const ms = value => (value == null ? null : ec.user.timestampMillis(value))
// a day from today in the user's zone, as the screens' date fields give it
const dayText = offset => ec.l10n.format(new Date(Date.now() + offset * day), "yyyy-MM-dd")
function organization(partyId, name) {
    call("create#mantle.party.Party", {partyId, partyTypeEnumId: "PtyOrganization", ownerPartyId: partyId})
    call("create#mantle.party.Organization", {partyId, organizationName: name})
    call("create#mantle.party.PartyRole", {partyId, roleTypeId: "OrgInternal"})
}
// a person with a work email: someone with no relationship to the HR user's employers is found and hired by it alone
const emailOf = partyId => partyId.toLowerCase() + "@spec.example"
function person(kind, firstName = "Emp") {
    const partyId = prefix + "_" + kind
    call("create#mantle.party.Party", {partyId, partyTypeEnumId: "PtyPerson"})
    call("create#mantle.party.Person", {partyId, firstName, lastName: kind})
    call("mantle.party.ContactServices.create#EmailAddress", {
        emailAddress: emailOf(partyId),
        partyId,
        contactMechPurposeId: "EmailWork"
    })
    return partyId
}
function employ(partyId, organizationPartyId, fromDate = since) {
    return call("mantle.humanres.EmploymentServices.create#Employment", {
        fromPartyId: partyId,
        toPartyId: organizationPartyId,
        fromDate
    }).partyRelationshipId
}
// a user of a spec-local group with the permissions: the person given, else a new agent of the organizations
function user(kind, permissions, organizationPartyIds, partyId = null) {
    const id = prefix + "_U_" + kind
    call("create#moqui.security.UserGroup", {userGroupId: id, description: "People employment " + kind})
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
// the employments (PrtEmployee relationships) of a person with an employer, and with an Employment row
const employments = (partyId, organizationPartyId) =>
    rows("mantle.party.PartyRelationship", {
        relationshipTypeEnumId: "PrtEmployee",
        fromPartyId: partyId,
        toPartyId: organizationPartyId
    })
const assignments = partyRelationshipId =>
    rows("mantle.humanres.employment.EmploymentAssignment", {partyRelationshipId}).sort((a, b) => ms(a.fromDate) - ms(b.fromDate))
const openMembers = (partyId, unitPartyId) =>
    rows("mantle.party.PartyRelationship", {
        relationshipTypeEnumId: "PrtMember",
        fromPartyId: partyId,
        toPartyId: unitPartyId
    }).filter(row => row.thruDate == null).length
const holding = (emplPositionId, partyId) =>
    rows("mantle.humanres.position.EmplPositionParty", {emplPositionId, partyId}).sort((a, b) => ms(a.fromDate) - ms(b.fromDate))
// a person's managers at an employer now (People.js linesOf, the directory's)
function managersAt(partyId, organizationPartyId) {
    const lines = ec.resource
        .script("component://mr-mantle/service/mantle/humanres/People.js")
        .linesOf({reportPartyIds: [partyId]}, null)
    return lines
        .filter(line => line.organizationPartyIds.includes(organizationPartyId))
        .map(line => line.managerPartyId)
        .join(",")
}
// the unread PeopleEmploymentChangeApproval notices of a change, by user
function notices(employmentChangeId) {
    const messageIds = rows("moqui.security.user.NotificationMessage", {
        topic: "PeopleEmploymentChangeApproval",
        recordId: employmentChangeId
    }).map(row => row.notificationMessageId)
    if (!messageIds.length) return {}
    const found = {}
    for (const row of Array.from(
        ec.entity
            .find("moqui.security.user.NotificationMessageUser")
            .condition("notificationMessageId", "in", messageIds)
            .condition("viewedDate", "is-null", null)
            .disableAuthz()
            .list()
    ))
        found[row.userId] = row.notificationMessageId
    return found
}
const revisionOf = partyRelationshipId =>
    ec.resource.script("component://mr-mantle/service/mantle/humanres/People.js").employmentRevision(partyRelationshipId)
const previewHire = (parameters, username = state.hr) =>
    run(username, P + "preview#Hire", Object.assign({organizationPartyId: orgA, fromDate: since}, parameters))
// a hire of a person chosen by id gives the email they are found by
const hire = (parameters, username = state.hr) =>
    run(
        username,
        P + "hire#Employee",
        Object.assign(
            {organizationPartyId: orgA, fromDate: since},
            parameters.partyId ? {workEmail: emailOf(parameters.partyId)} : {},
            parameters
        )
    )
const change = (partyRelationshipId, parameters, username = state.hr) =>
    run(
        username,
        P + "apply#EmploymentChange",
        Object.assign({partyRelationshipId, expectedRevision: revisionOf(partyRelationshipId)}, parameters)
    )

spec({
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        organization(orgA, "People Emp Spec A")
        organization(orgB, "People Emp Spec B")
        for (const kind of ["BOSS", "MGR", "ALT"]) {
            state[kind] = person(kind)
            state[kind + "_EMP"] = employ(state[kind], orgA)
        }
        state.hr = user("HR", ["PEOPLE_HR_VIEW", "PEOPLE_HR_EDIT", "PEOPLE_REQUEST_APPROVE"], [orgA])
        state.hrB = user("HRB", ["PEOPLE_HR_VIEW", "PEOPLE_HR_EDIT"], [orgB])
        state.hrBoth = user("HRBOTH", ["PEOPLE_HR_VIEW", "PEOPLE_HR_EDIT"], [orgA, orgB])
        state.reader = user("READER", ["PEOPLE_DIRECTORY_VIEW"], [orgA])
        state.admin = user("ADMIN", ["PEOPLE_CONFIGURE", "PEOPLE_HR_VIEW"], [orgA])
        const approve = ["PEOPLE_TEAM_VIEW", "PEOPLE_REQUEST_APPROVE"]
        state.uMGR = user("MGR", approve, [], state.MGR)
        state.uBOSS = user("BOSS", approve, [], state.BOSS)
        state.uALT = user("ALT", approve, [], state.ALT)
        // A's departments (Stores led by BOSS, Office) and a team; the seats of Stores and Office
        const unit = (unitKind, organizationName, parentPartyId, headPartyId = null) =>
            run(state.hr, O + "store#Unit", {unitKind, organizationName, parentPartyId, headPartyId, fromDate: since}).partyId
        state.stores = unit("department", "Stores", orgA, state.BOSS)
        state.office = unit("department", "Office", orgA)
        state.yard = unit("department", "Yard", orgA)
        state.team = unit("team", "Floor", state.stores)
        state.classId = run(state.hr, S + "store#JobClass", {title: "Emp spec clerk"}).emplPositionClassId
        const seat = (departmentPartyId, description) => {
            const emplPositionId = run(state.hr, S + "store#Position", {
                organizationPartyId: orgA,
                departmentPartyId,
                emplPositionClassId: state.classId,
                description,
                fromDate: since
            }).emplPositionId
            call("update#mantle.humanres.position.EmplPosition", {emplPositionId, statusId: "EmpsActive"})
            return emplPositionId
        }
        state.seatStores = seat(state.stores, "Stores clerk")
        state.seatOffice = seat(state.office, "Office clerk")
        state.seatYard = seat(state.yard, "Yard clerk")
        // the manager MGR reports to BOSS at A
        call("create#mantle.party.PartyRelationship", {
            relationshipTypeEnumId: "PrtManager",
            fromPartyId: state.BOSS,
            toPartyId: state.MGR,
            fromDate: since
        })
    },
    cleanupSpec() {
        ec.message.clearErrors()
        login("john.doe")
    }
})

feature(
    "a contractor is hired beside their contractor relationship; an overlapping employment is refused and a retry answers the first hire; create#Employment's overlap is of employments alone",
    {
        when() {
            const out = {}
            const contractor = person("CONTRACTOR", "Nadia")
            call("create#mantle.party.PartyRelationship", {
                relationshipTypeEnumId: "PrtAgent",
                fromPartyId: contractor,
                toPartyId: orgA,
                toRoleTypeId: "OrgInternal",
                fromDate: since
            })
            const terms = {
                partyId: contractor,
                departmentPartyId: state.stores,
                emplPositionId: state.seatStores,
                managerPartyId: state.MGR,
                operationKey: "HIRE-CONTRACTOR"
            }
            const preview = previewHire(terms)
            out.preview = [preview.canHire, preview.plan, preview.findings.map(row => row.code).includes("OTHER_RELATIONSHIP")]
            out.reader = code(hire(terms, state.reader))
            out.otherHr = code(hire(terms, state.hrB))
            const hired = hire(terms)
            out.hired = [hired.error, hired.repeated]
            out.retry = hire(terms)
            out.retryText = [out.retry.partyRelationshipId === hired.partyRelationshipId, out.retry.repeated]
            out.employments = employments(contractor, orgA).length
            out.agent = rows("mantle.party.PartyRelationship", {
                relationshipTypeEnumId: "PrtAgent",
                fromPartyId: contractor
            }).filter(row => row.thruDate == null).length
            const assigned = assignments(hired.partyRelationshipId)
            out.assignment = assigned
                .map(row => [row.departmentPartyId, row.emplPositionId, row.managerPartyId].join("|"))
                .join(";")
            out.projections = [
                openMembers(contractor, state.stores),
                holding(state.seatStores, contractor).length,
                managersAt(contractor, orgA),
                one("mantle.humanres.employment.Employment", {partyRelationshipId: hired.partyRelationshipId}).emplPositionId
            ]
            // a second hire of the same person over the same dates
            out.overlap = code(hire({partyId: contractor, fromDate: "2010-01-01T00:00:00Z"}))
            // create#Employment refuses an overlapping employment, not a contact relationship (F3)
            const contact = person("CONTACT")
            call("create#mantle.party.PartyRelationship", {
                relationshipTypeEnumId: "PrtContact",
                fromPartyId: contact,
                toPartyId: orgA,
                fromDate: since
            })
            out.direct = employ(contact, orgA) != null
            state.CONTRACTOR = contractor
            state.CONTRACTOR_EMP = hired.partyRelationshipId
            return out
        },
        then(out) {
            out.preview.join() == "true,new,true"
            out.reader == "PERMISSION_DENIED"
            out.otherHr == "ORGANIZATION_DENIED"
            out.hired.join() == ",false"
            out.retryText.join() == "true,true"
            out.employments == 1
            out.agent == 1
            out.assignment == [state.stores, state.seatStores, state.MGR].join("|")
            out.projections.join() == ["1", "1", state.MGR, state.seatStores].join()
            out.overlap == "EMPLOYMENT_OVERLAP"
            out.direct == true
        }
    }
)

feature(
    "a person employed by another employer is found, not made again; a new person someone matches needs confirming; an orphan relationship is completed and a rehire keeps the old employment",
    {
        when() {
            const out = {}
            // B's employee: A's HR does not find them by name (no relationship with A; the user's call), only by their exact
            // email, by public identity only; a person related to A (the contractor) is found by name
            const dual = person("DUAL", "Priya")
            employ(dual, orgB)
            const dualEmail = emailOf(dual)
            out.byName = previewHire({term: "Priya"}).matches.some(row => row.partyId === dual)
            out.related = previewHire({term: "Nadia"}).matches.some(row => row.partyId === state.CONTRACTOR)
            const preview = previewHire({term: dualEmail.toUpperCase()})
            const match = preview.matches.find(row => row.partyId === dual)
            out.found = [!!match, match?.relationshipText || "", match?.matchedBy, Object.keys(match || {}).includes("workEmail")]
            // a new person by the same names and email is refused unless confirmed
            out.duplicate = code(hire({firstName: "Priya", lastName: "DUAL", workEmail: dualEmail}))
            // chosen by id alone they are not available (an id names no one); with the email they were found by, hired
            out.byId = code(previewHire({partyId: dual}))
            const hired = hire({partyId: dual, managerPartyId: state.MGR})
            out.hired = [hired.error, employments(dual, orgA).length, employments(dual, orgB).length]
            out.persons = rows("mantle.party.Person", {firstName: "Priya", lastName: "DUAL"}).length
            out.owner = one("mantle.party.Party", {partyId: dual}).ownerPartyId
            // an orphan PrtEmployee relationship (no Employment row) is completed, not duplicated
            const orphan = person("ORPHAN")
            const orphanRelationship = call("create#mantle.party.PartyRelationship", {
                relationshipTypeEnumId: "PrtEmployee",
                fromPartyId: orphan,
                fromRoleTypeId: "Employee",
                toPartyId: orgA,
                toRoleTypeId: "OrgEmployer",
                fromDate: since
            }).partyRelationshipId
            const orphanPreview = previewHire({partyId: orphan})
            out.orphanPlan = orphanPreview.plan
            const completed = hire({partyId: orphan, departmentPartyId: state.office})
            out.orphan = [
                completed.partyRelationshipId === orphanRelationship,
                employments(orphan, orgA).length,
                !!one("mantle.humanres.employment.Employment", {partyRelationshipId: orphanRelationship})
            ]
            // a rehire: an ended employment, and a new one beside it
            const leaver = person("REHIRE")
            const old = call("mantle.humanres.EmploymentServices.create#Employment", {
                fromPartyId: leaver,
                toPartyId: orgA,
                fromDate: since,
                thruDate: "2005-01-01T00:00:00Z"
            }).partyRelationshipId
            const rehirePreview = previewHire({partyId: leaver, fromDate: "2010-01-01T00:00:00Z"})
            out.rehirePlan = rehirePreview.plan
            const rehired = hire({partyId: leaver, fromDate: "2010-01-01T00:00:00Z"})
            const oldRow = one("mantle.party.PartyRelationship", {partyRelationshipId: old})
            out.rehire = [
                rehired.partyRelationshipId !== old,
                employments(leaver, orgA).length,
                ms(oldRow.thruDate) === ms("2005-01-01T00:00:00Z")
            ]
            // a new person: named, with a work email the directory shows (EmailWork)
            const fresh = hire({
                firstName: "Zed",
                lastName: "Newcomer",
                workEmail: "zed.newcomer@spec.example",
                confirmNewPerson: true
            })
            out.fresh = [
                fresh.error,
                rows("mantle.party.contact.PartyContactMech", {partyId: fresh.partyId, contactMechPurposeId: "EmailWork"}).length,
                one("mantle.party.Party", {partyId: fresh.partyId}).ownerPartyId || "_NA_"
            ]
            // matched by the email now
            const byEmail = previewHire({firstName: "Z", lastName: "Other", workEmail: "ZED.NEWCOMER@spec.example"})
            out.byEmail = byEmail.matches.map(row => row.partyId + ":" + row.matchedBy).join()
            state.freshId = fresh.partyId
            return out
        },
        then(out) {
            out.byName == false
            out.related == true
            out.found.join() == "true,,email,false"
            out.duplicate == "PERSON_MATCHES"
            out.byId == "RECORD_UNAVAILABLE"
            out.hired.join() == ",1,1"
            out.persons == 1
            out.owner != orgA
            out.orphanPlan == "complete"
            out.orphan.join() == "true,1,true"
            out.rehirePlan == "rehire"
            out.rehire.join() == "true,2,true"
            out.fresh.join() == ",1,_NA_"
            out.byEmail == state.freshId + ":email"
        }
    }
)

feature(
    "a transfer waits for the manager's approval and is applied from its date: the old assignment ends, the department membership, seat and line move; a stale revision and a change superseded meanwhile are refused",
    {
        when() {
            const out = {}
            const worker = person("WORKER")
            const hired = hire({
                partyId: worker,
                departmentPartyId: state.stores,
                emplPositionId: state.seatYard,
                managerPartyId: state.MGR
            })
            // the yard seat is Yard's: a position of another department refused
            out.positionDepartment = code(hired)
            const ok = hire({partyId: worker, emplPositionId: state.seatYard, managerPartyId: state.MGR})
            const employment = ok.partyRelationshipId
            const from = dayText(10)
            const transfer = {
                changeKind: "transfer",
                effectiveDate: from,
                emplPositionId: state.seatOffice,
                managerPartyId: state.BOSS,
                reason: "Moves to the office",
                operationKey: "TRANSFER-1"
            }
            out.stale = code(
                run(
                    state.hr,
                    P + "apply#EmploymentChange",
                    Object.assign({partyRelationshipId: employment, expectedRevision: "1"}, transfer)
                )
            )
            out.noReason = code(change(employment, Object.assign({}, transfer, {reason: ""})))
            const preview = run(
                state.hr,
                P + "preview#EmploymentChange",
                Object.assign({partyRelationshipId: employment}, transfer)
            )
            out.preview = [
                preview.needsApproval,
                preview.canApply,
                preview.terms.departmentPartyId,
                preview.impact.map(row => row.kind).join("|"),
                preview.route.map(step => step.explanation).join()
            ]
            const asked = change(employment, transfer)
            out.asked = [asked.error, asked.statusId, asked.applied]
            out.retry = change(employment, transfer).employmentChangeId === asked.employmentChangeId
            out.notified = Object.keys(notices(asked.employmentChangeId)).join()
            // HR asked: it may not decide; the manager approves through the notice
            out.hrDecides = code(run(state.hr, P + "decide#EmploymentChange", {employmentChangeId: asked.employmentChangeId}))
            const notice = notices(asked.employmentChangeId)[state.uMGR]
            const approved = run(state.uMGR, NOTIFY + "approve#NotificationMessage", {notificationMessageId: notice})
            out.approved = [
                approved.error,
                one("mantle.humanres.employment.EmploymentChange", {employmentChangeId: asked.employmentChangeId}).statusId
            ]
            const assigned = assignments(employment)
            out.assignments = assigned.length
            out.ended =
                ms(assigned[0].thruDate) === ms(assigned[1].fromDate) &&
                ms(assigned[1].fromDate) === ec.user.timestampMillis(from)
            out.newTerms = [assigned[1].departmentPartyId, assigned[1].emplPositionId, assigned[1].managerPartyId].join("|")
            // from the date: the seat held and the old one ended, the memberships and lines moved
            const seats = rows("mantle.humanres.position.EmplPositionParty", {partyId: worker})
            out.seats = seats
                .map(row => row.emplPositionId + (row.thruDate ? ":ended" : ":open"))
                .sort()
                .join()
            out.member = rows("mantle.party.PartyRelationship", {relationshipTypeEnumId: "PrtMember", fromPartyId: worker})
                .map(row => row.toPartyId + (row.thruDate ? ":ended" : ":open"))
                .sort()
                .join()
            out.lines = rows("mantle.party.PartyRelationship", {relationshipTypeEnumId: "PrtManager", toPartyId: worker})
                .map(row => row.fromPartyId + (row.thruDate ? ":ended" : ":open"))
                .sort()
                .join()
            // Employment.emplPositionId holds the seat in effect (the user's call): the yard until the transfer's date, when the
            // daily job sets the office; a rerun changes nothing
            const seatOf = () => one("mantle.humanres.employment.Employment", {partyRelationshipId: employment}).emplPositionId
            const job = () => run("john.doe", P + "apply#DueAssignments", {partyRelationshipIds: [employment]}).applied
            out.employmentSeat = [seatOf(), job()]
            ec.user.setEffectiveTime(ec.user.timestampMillis(from) + 60 * 60 * 1000)
            try {
                out.employmentSeat.push(job(), seatOf(), job())
            } finally {
                ec.user.setEffectiveTime(null)
            }
            // the manager now is MGR (the transfer is next week's); BOSS from its date
            out.managerNow = managersAt(worker, orgA)
            // a second transfer asked, then a manager change applied meanwhile: the waiting transfer is superseded
            const second = change(employment, {
                changeKind: "transfer",
                effectiveDate: dayText(20),
                emplPositionId: state.seatYard,
                reason: "Back to the yard"
            })
            out.secondWaiting = second.statusId
            const manager = change(employment, {changeKind: "manager", effectiveDate: dayText(15), managerPartyId: state.MGR})
            out.managerApplied = [manager.error, manager.statusId]
            out.superseded = [
                one("mantle.humanres.employment.EmploymentChange", {employmentChangeId: second.employmentChangeId}).statusId,
                code(run(state.uBOSS, P + "decide#EmploymentChange", {employmentChangeId: second.employmentChangeId}))
            ]
            state.WORKER = worker
            state.WORKER_EMP = employment
            return out
        },
        then(out) {
            out.positionDepartment == "POSITION_DEPARTMENT"
            out.stale == "REVISION_CHANGED"
            out.noReason == "REASON_REQUIRED"
            out.preview.slice(0, 4).join() == ["true", "true", state.office, "position|position|department|manager"].join()
            out.preview[4].includes("Emp MGR")
            out.asked.join() == ",EchRequested,false"
            out.retry == true
            out.notified == state.uMGR
            out.hrDecides == "SELF_APPROVAL"
            out.approved.join() == ",EchApplied"
            out.assignments == 2
            out.ended == true
            out.newTerms == [state.office, state.seatOffice, state.BOSS].join("|")
            out.seats == [state.seatOffice + ":open", state.seatYard + ":ended"].join()
            out.member == [state.office + ":open", state.yard + ":ended"].join()
            out.lines == [state.BOSS + ":open", state.MGR + ":ended"].join()
            out.employmentSeat.join() == [state.seatYard, 0, 1, state.seatOffice, 0].join()
            out.managerNow == state.MGR
            out.secondWaiting == "EchRequested"
            out.managerApplied.join() == ",EchApplied"
            out.superseded.join() == "EchSuperseded,NOT_PENDING"
        }
    }
)

feature(
    "the manager is per employment: a manager kept by one employment's assignment manages that employment alone, and the chart's change of an assigned employment is the assignment's",
    {
        when() {
            const out = {}
            // two people both employed by A and B; a line at A by assignment is not the line at B
            const lead = person("LEAD")
            const both = person("BOTH")
            for (const party of [lead, both]) employ(party, orgB)
            employ(lead, orgA)
            const hired = hire({partyId: both, managerPartyId: lead})
            out.at = [managersAt(both, orgA), managersAt(both, orgB)]
            // B's HR sets no manager at B: no line shared, nothing to refuse; B's employment has none
            const tree = run(state.hrBoth, O + "get#ReportingTree", {organizationPartyId: orgA, partyId: both})
            const node = tree.nodes[0]
            out.revision = (node?.lineRevision || "").startsWith("A:")
            // the chart's change at A is the assignment's: a new assignment from the date, the line moved
            const changed = run(state.hrBoth, O + "change#Manager", {
                partyId: both,
                organizationPartyId: orgA,
                managerPartyId: state.MGR,
                fromDate: dayText(5),
                expectedRevision: node.lineRevision
            })
            out.changed = changed.error
            out.assignments = assignments(hired.partyRelationshipId)
                .map(row => row.managerPartyId)
                .join()
            out.stale = code(
                run(state.hrBoth, O + "change#Manager", {
                    partyId: both,
                    organizationPartyId: orgA,
                    managerPartyId: state.BOSS,
                    fromDate: dayText(8),
                    expectedRevision: node.lineRevision
                })
            )
            return out
        },
        then(out) {
            out.at.join() == ["PEOPLE_EMP_SPEC_LEAD", ""].join()
            out.revision == true
            out.changed == ""
            out.assignments == ["PEOPLE_EMP_SPEC_LEAD", state.MGR].join()
            out.stale == "REVISION_CHANGED"
        }
    }
)

feature(
    "a separation ends one employment and leaves the other: its seat, membership and line end, its reports keep no manager and its waiting decision goes to the alternate",
    {
        when() {
            const out = {}
            // the leaver: employed by A (managing a report, leading a team, holding a seat) and by B
            const leaver = person("LEAVER")
            const leaverEmp = hire({partyId: leaver, emplPositionId: state.seatStores, managerPartyId: state.BOSS})
            // the contractor's seat is Stores': this hire takes the seat after the contractor's holding? the seat is held, so refused
            out.occupied = code(leaverEmp)
            const hired = hire({partyId: leaver, departmentPartyId: state.stores, managerPartyId: state.BOSS})
            employ(leaver, orgB)
            run(state.hr, O + "store#Membership", {unitPartyId: state.team, partyId: leaver, memberRole: "lead", fromDate: since})
            const report = person("REPORT")
            const reportHired = hire({partyId: report, departmentPartyId: state.stores, managerPartyId: leaver})
            // a position activation waiting on the leaver: an employer's rule names them, with ALT as the alternate
            user("LEAVERU", ["PEOPLE_TEAM_VIEW", "PEOPLE_REQUEST_APPROVE"], [], leaver)
            run(state.admin, A + "store#Policy", {
                organizationPartyId: orgA,
                approvalKindEnumId: "PakPosition",
                departmentPartyId: state.office,
                sequenceNum: 1,
                approverRoleEnumId: "ParPerson",
                approverPartyId: leaver,
                alternatePartyId: state.ALT,
                fromDate: since
            })
            const planned = run(state.hr, S + "store#Position", {
                organizationPartyId: orgA,
                departmentPartyId: state.office,
                emplPositionClassId: state.classId,
                description: "Office trainee"
            })
            const request = run(state.hr, S + "request#PositionApproval", {
                emplPositionId: planned.emplPositionId,
                expectedRevision: planned.revision,
                justification: "Season"
            })
            out.before = approverOf(request.peopleApprovalId)
            // the separation, now: asked by HR, decided by the leaver's manager (BOSS)
            const asked = change(hired.partyRelationshipId, {
                changeKind: "separation",
                effectiveDate: "",
                terminationTypeEnumId: "TtResigned",
                reason: "Resigned"
            })
            const decided = run(state.uBOSS, P + "decide#EmploymentChange", {employmentChangeId: asked.employmentChangeId})
            out.decided = [decided.error, decided.applied]
            const employmentRow = one("mantle.party.PartyRelationship", {partyRelationshipId: hired.partyRelationshipId})
            out.ended = [employmentRow.thruDate != null, employments(leaver, orgB).filter(row => row.thruDate == null).length]
            out.termination = one("mantle.humanres.employment.Employment", {
                partyRelationshipId: hired.partyRelationshipId
            }).terminationTypeEnumId
            out.memberships = [openMembers(leaver, state.stores), openMembers(leaver, state.team)]
            out.line = managersAt(leaver, orgA)
            // the report's assignment continues with no manager, and no line from the leaver stays
            out.report = [
                assignments(reportHired.partyRelationshipId)
                    .map(row => row.managerPartyId || "none")
                    .join(),
                managersAt(report, orgA)
            ]
            // the waiting activation moved to the alternate, who is told
            out.after = approverOf(request.peopleApprovalId)
            out.altNotified = rows("moqui.security.user.NotificationMessage", {
                topic: "PeoplePositionApproval",
                recordId: planned.emplPositionId
            })
                .flatMap(message =>
                    rows("moqui.security.user.NotificationMessageUser", {notificationMessageId: message.notificationMessageId})
                        .filter(row => row.viewedDate == null)
                        .map(row => row.userId)
                )
                .join()
            return out
        },
        then(out) {
            out.occupied == "POSITION_OCCUPIED"
            out.before == "PEOPLE_EMP_SPEC_LEAVER"
            out.decided.join() == ",true"
            out.ended.join() == "true,1"
            out.termination == "TtResigned"
            out.memberships.join() == "0,0"
            out.line == ""
            out.report.join() == ["PEOPLE_EMP_SPEC_LEAVER,none", ""].join()
            out.after == state.ALT
            out.altNotified == state.uALT
        }
    }
)

// the parties who may decide a request's step waiting now
function approverOf(peopleApprovalId) {
    const approval = one("mantle.humanres.approval.PeopleApproval", {peopleApprovalId})
    const summary = ec.resource
        .script("component://mr-mantle/service/mantle/humanres/Approvals.js")
        .sourceSummary(approval.approvalKindEnumId, approval.sourceId)
    const waiting = (summary.steps || []).find(step => step.stateText === "Waiting")
    return (waiting?.approverPartyIds || []).join(",")
}

feature(
    "a leave of absence and the return are dated assignments on the same terms; a department's members are read only and its closure moves them to another department",
    {
        when() {
            const out = {}
            const leave = change(state.CONTRACTOR_EMP, {changeKind: "leave", effectiveDate: dayText(30), returnDate: dayText(60)})
            const rowsNow = assignments(state.CONTRACTOR_EMP)
            out.leave = [leave.statusId, rowsNow.map(row => row.stateEnumId).join(), rowsNow.length]
            // inside the leave a later change is set already (the return); after it, working, there is no leave to return from
            out.again = code(change(state.CONTRACTOR_EMP, {changeKind: "leave", effectiveDate: dayText(40)}))
            out.notOnLeave = code(change(state.CONTRACTOR_EMP, {changeKind: "return", effectiveDate: dayText(70)}))
            // a department's members come from the assignments
            out.member = code(run(state.hr, O + "store#Membership", {unitPartyId: state.office, partyId: state.MGR}))
            out.teamMember = code(run(state.hr, O + "store#Membership", {unitPartyId: state.team, partyId: state.MGR}))
            out.editable = [
                run(state.hr, O + "get#Unit", {partyId: state.office}).unit.membersEditable,
                run(state.hr, O + "get#Unit", {partyId: state.team}).unit.membersEditable
            ]
            // Annex, with a seat and a person working there, is closed from today with its people moved to Stores; its seat ends first
            const annex = run(state.hr, O + "store#Unit", {
                unitKind: "department",
                organizationName: "Annex",
                parentPartyId: orgA,
                fromDate: since
            })
            const annexSeat = run(state.hr, S + "store#Position", {
                organizationPartyId: orgA,
                departmentPartyId: annex.partyId,
                emplPositionClassId: state.classId,
                description: "Annex clerk",
                fromDate: since
            }).emplPositionId
            const annexed = hire({partyId: person("ANNEXED"), departmentPartyId: annex.partyId})
            const revision = () => run(state.hr, O + "get#Unit", {partyId: annex.partyId}).unit.revision
            const close = parameters =>
                run(
                    state.hr,
                    O + "store#Unit",
                    Object.assign({partyId: annex.partyId, expectedRevision: revision(), close: true}, parameters)
                )
            out.positions = code(close({reassignPartyId: state.stores}))
            call("update#mantle.humanres.position.EmplPosition", {emplPositionId: annexSeat, thruDate: ec.user.nowTimestamp})
            out.required = code(close({}))
            out.invalid = code(close({reassignPartyId: state.team}))
            const closed = close({reassignPartyId: state.stores, changeReason: "Annex merged into Stores"})
            out.closed = [closed.error, closed.moved]
            out.annexMembers = rows("mantle.party.PartyRelationship", {
                relationshipTypeEnumId: "PrtMember",
                toPartyId: annex.partyId
            }).filter(row => row.thruDate == null).length
            out.rollup = rows("mantle.party.PartyRelationship", {
                relationshipTypeEnumId: "PrtOrgRollup",
                fromPartyId: annex.partyId
            }).every(row => row.thruDate != null)
            out.moved = assignments(annexed.partyRelationshipId)
                .map(
                    row =>
                        (row.thruDate ? "ended:" : "open:") +
                        (row.departmentPartyId === annex.partyId ? "annex" : row.departmentPartyId)
                )
                .join()
            out.storesMember = openMembers(annexed.partyId, state.stores)
            return out
        },
        then(out) {
            out.leave.join() == "EchApplied,EasActive,EasLeave,EasActive,3"
            out.again == "ASSIGNMENT_SCHEDULED"
            out.notOnLeave == "NOT_ON_LEAVE"
            out.member == "DEPARTMENT_MEMBERSHIP"
            out.teamMember == ""
            out.editable.join() == "false,true"
            out.positions == "UNIT_HAS_POSITIONS"
            out.required == "REASSIGNMENT_REQUIRED"
            out.invalid == "REASSIGNMENT_INVALID"
            out.closed.join() == ",1"
            out.annexMembers == 0
            out.rollup == true
            out.moved == ["ended:annex", "open:" + state.stores].join()
            out.storesMember == 1
        }
    }
)

feature(
    "a wizard's draft is a dated record of its HR user's alone: resumed with its operation key, kept to the kind's fields, discarded by its owner only",
    {
        when() {
            const draft = (service, parameters, username = state.hr) =>
                run(username, P + service + "#EmploymentDraft", parameters)
            const stored = draft("store", {
                draftKind: "hire",
                draft: {organizationPartyId: orgA, firstName: "Ada", lastName: "Draft", workPhone: "", salary: "100"}
            })
            const again = draft("store", {
                draftKind: "hire",
                draft: {organizationPartyId: orgA, firstName: "Ada", lastName: "Drafted"}
            })
            const resumed = draft("get", {draftKind: "hire"})
            const out = {
                stored: [stored.error, !!stored.operationKey, Object.keys(stored.draft).sort().join("|")],
                resumed: [
                    again.employmentDraftId === stored.employmentDraftId,
                    resumed.operationKey === stored.operationKey,
                    resumed.draft.lastName,
                    !!resumed.fromDateText
                ],
                // another HR user: their own drafts only; the id of this one is missing
                other: [
                    draft("get", {draftKind: "hire"}, state.hrBoth).employmentDraftId || "",
                    code(draft("get", {draftKind: "hire", employmentDraftId: stored.employmentDraftId}, state.hrBoth)),
                    draft("delete", {employmentDraftId: stored.employmentDraftId}, state.hrBoth).deleted
                ],
                reader: code(draft("get", {draftKind: "hire"}, state.reader)),
                otherEmployer: code(draft("store", {draftKind: "hire", draft: {organizationPartyId: orgB}})),
                // a change's draft is of an employment in the caller's scope
                change: code(
                    draft(
                        "store",
                        {draftKind: "change", partyRelationshipId: state.WORKER_EMP, changeKind: "transfer", draft: {}},
                        state.hrB
                    )
                ),
                deleted: draft("delete", {employmentDraftId: stored.employmentDraftId}).deleted,
                gone: draft("get", {draftKind: "hire"}).employmentDraftId || ""
            }
            return out
        },
        then(out) {
            out.stored.join() == ",true,firstName|lastName|organizationPartyId|workPhone"
            out.resumed.join() == "true,true,Drafted,true"
            out.other.join() == ",RECORD_UNAVAILABLE,false"
            out.reader == "PERMISSION_DENIED"
            out.otherEmployer == "ORGANIZATION_DENIED"
            out.change == "RECORD_UNAVAILABLE"
            out.deleted == true
            out.gone == ""
        }
    }
)
