// People's job classes, positions and pay grades (mantle.humanres.PositionServices and PayrollSetupServices; IronStone People
// design §5, PE-03, PE-08; impl-people P4): a job class with its work types and skills, ended and then offered for no position;
// a planned seat in a department of its employer, a department of another employer or a team refused; vacancy computed from
// the holders at a date, a second holder in the same period refused, an end before a holder's last day refused, the directory's
// job title from the seat held; a manager reading the positions of the department they lead only; a pay grade's dated band, in
// order and with its currency and frequency, ending the band before it and changing no salary; and a grade's amounts absent for
// an HR reader without PAYROLL_VIEW, on the grade and the position alike. Standalone: spec-local organizations, people,
// employments, groups and users, with artifact authorization disabled (the rules are the services' own checks).
// Run: ./moq test mr-mantle --spec PeoplePositions
const prefix = "PEOPLE_POS_SPEC"
const orgA = prefix + "_A",
    orgB = prefix + "_B",
    since = "2000-01-01T00:00:00Z"
const S = "mantle.humanres.PositionServices."
const G = "mantle.humanres.PayrollSetupServices."
const O = "mantle.humanres.OrganizationServices."
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
    call("create#mantle.party.Person", {partyId, firstName: "Pos", lastName: kind})
    return partyId
}
function employ(partyId, organizationPartyId) {
    return call("mantle.humanres.EmploymentServices.create#Employment", {
        fromPartyId: partyId,
        toPartyId: organizationPartyId,
        fromDate: since
    }).partyRelationshipId
}
// a user of a spec-local group with the permissions, an agent of the organizations, or the person given
function user(kind, permissions, organizationPartyIds, partyId = null) {
    const id = prefix + "_U_" + kind
    call("create#moqui.security.UserGroup", {userGroupId: id, description: "People positions " + kind})
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
const ids = (out, list, field) => (out[list] || []).map(row => row[field])

spec({
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        state.now = ec.user.timestampMillis(ec.user.nowTimestamp)
        organization(orgA, "People Pos Spec A")
        organization(orgB, "People Pos Spec B")
        for (const kind of ["LEAD", "HOLDER", "OTHER", "BETA"]) state[kind] = person(kind)
        for (const kind of ["LEAD", "HOLDER", "OTHER"]) state[kind + "_EMP"] = employ(state[kind], orgA)
        employ(state.BETA, orgB)
        state.hr = user("HR", ["PEOPLE_HR_VIEW", "PEOPLE_HR_EDIT"], [orgA])
        state.hrB = user("HRB", ["PEOPLE_HR_VIEW", "PEOPLE_HR_EDIT"], [orgB])
        state.reader = user("READER", ["PEOPLE_DIRECTORY_VIEW"], [orgA])
        state.payroll = user("PAY", ["PAYROLL_VIEW", "PAYROLL_EDIT"], [orgA])
        state.manager = user("LEAD", ["PEOPLE_TEAM_VIEW"], [], state.LEAD)
        // A's departments (Stores led by LEAD, Office) with a team under Stores; B's department
        const unit = (username, unitKind, organizationName, parentPartyId, headPartyId = null) =>
            run(username, O + "store#Unit", {unitKind, organizationName, parentPartyId, headPartyId, fromDate: since}).partyId
        state.stores = unit(state.hr, "department", "Stores", orgA, state.LEAD)
        state.office = unit(state.hr, "department", "Office", orgA)
        state.floor = unit(state.hr, "team", "Floor", state.stores)
        state.depB = unit(state.hrB, "department", "B Ops", orgB)
    },
    cleanupSpec() {
        ec.message.clearErrors()
        login("john.doe")
    }
})

feature(
    "a job class has work types and required skills; an ended class is listed only when asked and offered for no new position",
    {
        when() {
            const store = (username, parameters) => run(username, S + "store#JobClass", parameters)
            const created = store(state.hr, {
                title: "Pos spec clerk",
                description: "Serves customers on the floor",
                workTypeEnumIds: "WktpGeneralLabor,WktpSupport"
            })
            const classId = created.emplPositionClassId
            call("create#moqui.basic.Enumeration", {
                enumId: prefix + "_SK_POS",
                enumTypeId: "SkillType",
                description: "Point of sale"
            })
            const requirement = (parameters, username = state.hr) =>
                code(run(username, S + "store#JobRequirement", Object.assign({emplPositionClassId: classId}, parameters)))
            const skills = {
                added: requirement({skillTypeEnumId: prefix + "_SK_POS"}),
                again: requirement({skillTypeEnumId: prefix + "_SK_POS"}),
                notSkill: requirement({skillTypeEnumId: "WktpSupport"}),
                reader: requirement({skillTypeEnumId: prefix + "_SK_POS", remove: true}, state.reader)
            }
            const read = run(state.reader, S + "get#JobClass", {emplPositionClassId: classId})
            const refusals = {
                title: code(store(state.hr, {title: " "})),
                workType: code(store(state.hr, {title: "X", workTypeEnumIds: "PtyPerson"})),
                reader: code(store(state.reader, {title: "X"})),
                revision: code(store(state.hr, {emplPositionClassId: classId, title: "Associate", expectedRevision: "0"}))
            }
            // an unchanged description when only the title is given
            const renamed = store(state.hr, {
                emplPositionClassId: classId,
                title: "Pos spec associate",
                expectedRevision: read.jobClass.revision
            })
            const listed = run(state.reader, S + "find#JobClasses", {term: "POS SPEC ASSOC"})
            const ended = store(state.hr, {
                emplPositionClassId: classId,
                thruDate: state.now - day,
                expectedRevision: renamed.revision
            })
            return {
                classId,
                skills,
                read: [read.jobClass.title, read.jobClass.canEdit, read.skills.map(row => row.skillName), read.workTypes.length],
                refusals,
                renamed: renamed.error,
                description: run(state.hr, S + "get#JobClass", {emplPositionClassId: classId}).jobClass.description,
                listed: ids(listed, "jobClasses", "emplPositionClassId"),
                ended: ended.error,
                current: ids(run(state.hr, S + "find#JobClasses", {term: "pos spec assoc"}), "jobClasses", "emplPositionClassId"),
                withEnded: ids(
                    run(state.hr, S + "find#JobClasses", {term: "pos spec assoc", includeEnded: true}),
                    "jobClasses",
                    "emplPositionClassId"
                ),
                position: code(run(state.hr, S + "store#Position", {organizationPartyId: orgA, emplPositionClassId: classId}))
            }
        },
        then({classId, skills, read, refusals, renamed, description, listed, ended, current, withEnded, position}) {
            skills == {added: "", again: "ALREADY_REQUIRED", notSkill: "SKILL_INVALID", reader: "PERMISSION_DENIED"}
            read == ["Pos spec clerk", false, ["Point of sale"], 2]
            refusals ==
                {
                    title: "TITLE_REQUIRED",
                    workType: "WORK_TYPE_INVALID",
                    reader: "PERMISSION_DENIED",
                    revision: "REVISION_CHANGED"
                }
            renamed == ""
            description == "Serves customers on the floor"
            listed == [classId]
            ended == ""
            current == []
            withEnded == [classId]
            position == "CLASS_ENDED"
        }
    }
)

feature(
    "a planned seat belongs to a department of its employer; another employer's department, a team, another employer and a reader are refused; a manager reads their department's seats",
    {
        when() {
            state.classId = run(state.hr, S + "store#JobClass", {title: "Clerk"}).emplPositionClassId
            const plan = (username, parameters) =>
                run(
                    username,
                    S + "store#Position",
                    Object.assign({organizationPartyId: orgA, emplPositionClassId: state.classId}, parameters)
                )
            const first = plan(state.hr, {departmentPartyId: state.stores, description: "Clerk 1", fromDate: since})
            const second = plan(state.hr, {departmentPartyId: state.stores, description: "Clerk 2", fromDate: since})
            const office = plan(state.hr, {departmentPartyId: state.office, description: "Office clerk", fromDate: since})
            state.first = first.emplPositionId
            state.second = second.emplPositionId
            const refusals = {
                otherDepartment: code(plan(state.hr, {departmentPartyId: state.depB})),
                team: code(plan(state.hr, {departmentPartyId: state.floor})),
                otherEmployer: code(plan(state.hr, {organizationPartyId: orgB, departmentPartyId: state.depB})),
                reader: code(plan(state.reader, {departmentPartyId: state.stores})),
                dates: code(plan(state.hr, {fromDate: state.now, thruDate: state.now - day})),
                hours: code(plan(state.hr, {standardHoursPerWeek: 200})),
                noClass: code(plan(state.hr, {emplPositionClassId: ""}))
            }
            const found = run(state.hr, S + "find#Positions", {organizationPartyId: orgA, departmentPartyId: state.stores})
            return {
                created: [first, second, office].map(out => out.error),
                refusals,
                rows: (found.positions || []).map(row =>
                    [row.positionName, row.departmentName, row.state, row.vacancy].join(" ")
                ),
                vacantCount: found.vacantCount,
                managerRows: ids(run(state.manager, S + "find#Positions"), "positions", "emplPositionId").sort(),
                managerOffice: code(run(state.manager, S + "get#Position", {emplPositionId: office.emplPositionId})),
                readerFind: code(run(state.reader, S + "find#Positions")),
                otherHr: code(run(state.hrB, S + "get#Position", {emplPositionId: first.emplPositionId})),
                otherHrFind: code(run(state.hrB, S + "find#Positions", {organizationPartyId: orgA}))
            }
        },
        then({created, refusals, rows, vacantCount, managerRows, managerOffice, readerFind, otherHr, otherHrFind}) {
            created == ["", "", ""]
            refusals ==
                {
                    otherDepartment: "DEPARTMENT_OUTSIDE",
                    team: "NOT_A_DEPARTMENT",
                    otherEmployer: "ORGANIZATION_DENIED",
                    reader: "PERMISSION_DENIED",
                    dates: "DATES_INVALID",
                    hours: "HOURS_INVALID",
                    noClass: "CLASS_REQUIRED"
                }
            rows == ["Clerk 1 Stores planned vacant", "Clerk 2 Stores planned vacant"]
            vacantCount == 2
            managerRows == [state.first, state.second].sort()
            managerOffice == "RECORD_UNAVAILABLE"
            readerFind == "PERMISSION_DENIED"
            otherHr == "RECORD_UNAVAILABLE"
            otherHrFind == "ORGANIZATION_DENIED"
        }
    }
)

feature(
    "vacancy is computed from the holders at a date; a second holder in the same period, a person not employed and an end before a holder's last day are refused",
    {
        when() {
            const from = state.now + 10 * day
            const hold = (parameters, username = state.hr) =>
                run(username, S + "store#PositionHolder", Object.assign({emplPositionId: state.first}, parameters))
            const held = hold({partyId: state.HOLDER, fromDate: from, changeReason: "Hired"})
            const refusals = {
                occupied: code(hold({partyId: state.OTHER, fromDate: from + 5 * day})),
                notEmployed: code(hold({partyId: state.BETA, fromDate: from + 5 * day, emplPositionId: state.second})),
                reader: code(hold({partyId: state.OTHER, fromDate: from, emplPositionId: state.second}, state.reader))
            }
            const vacancy = asOfDate =>
                run(state.hr, S + "find#Positions", {departmentPartyId: state.stores, asOfDate}).positions.map(row =>
                    [row.positionName, row.vacancy, row.holderName].join(" ").trim()
                )
            const before = vacancy(state.now)
            const after = vacancy(from + day)
            const filled = run(state.hr, S + "find#Positions", {vacancy: "filled", asOfDate: from + day})
            // the directory's job title is the class of the seat held (P2's column)
            const title = asOfDate =>
                run(state.hr, "mantle.humanres.PeopleServices.find#Employees", {term: "HOLDER", asOfDate}).employees.map(
                    row => row.jobTitle
                )
            const position = run(state.hr, S + "get#Position", {emplPositionId: state.first})
            const revision = position.position.revision
            const endEarly = code(
                run(state.hr, S + "store#Position", {
                    emplPositionId: state.first,
                    thruDate: from + 20 * day,
                    expectedRevision: revision
                })
            )
            const ended = hold({partyId: state.HOLDER, holderFromDate: String(from), thruDate: from + 15 * day})
            const endAfter = run(state.hr, S + "store#Position", {
                emplPositionId: state.first,
                thruDate: from + 20 * day,
                changeReason: "Seat closed",
                expectedRevision: revision
            })
            const reread = run(state.hr, S + "get#Position", {emplPositionId: state.first})
            return {
                held: held.error,
                refusals,
                before,
                after,
                filled: ids(filled, "positions", "emplPositionId"),
                titleBefore: title(state.now),
                titleAfter: title(from + day),
                holders: position.holders.map(row => [row.personName, row.state, row.source].join(" ")),
                endEarly,
                ended: ended.error,
                endAfter: endAfter.error,
                stale: code(
                    run(state.hr, S + "store#Position", {
                        emplPositionId: state.first,
                        description: "X",
                        expectedRevision: revision
                    })
                ),
                employer: code(
                    run(state.hr, S + "store#Position", {
                        emplPositionId: state.first,
                        organizationPartyId: orgB,
                        expectedRevision: reread.position.revision
                    })
                ),
                kept: [reread.position.positionName, reread.position.departmentName, reread.position.thruDateText != ""]
            }
        },
        then({
            held,
            refusals,
            before,
            after,
            filled,
            titleBefore,
            titleAfter,
            holders,
            endEarly,
            ended,
            endAfter,
            stale,
            employer,
            kept
        }) {
            held == ""
            refusals == {occupied: "POSITION_OCCUPIED", notEmployed: "NOT_EMPLOYED", reader: "PERMISSION_DENIED"}
            before == ["Clerk 1 vacant", "Clerk 2 vacant"]
            after == ["Clerk 1 filled Pos HOLDER", "Clerk 2 vacant"]
            filled == [state.first]
            titleBefore == [""]
            titleAfter == ["Clerk"]
            holders == ["Pos HOLDER future position"]
            endEarly == "OCCUPIED_AFTER_END"
            ended == ""
            endAfter == ""
            stale == "REVISION_CHANGED"
            employer == "EMPLOYER_CHANGE"
            kept == ["Clerk 1", "Stores", true]
        }
    }
)

feature(
    "a pay grade's band is dated, in order and complete; a new band ends the one before and changes no salary; an HR reader without PAYROLL_VIEW gets the grade's name and no amount",
    {
        when() {
            const store = (username, parameters) => run(username, G + "store#PayGrade", parameters)
            const band = {
                currencyUomId: "USD",
                timePeriodTypeId: "PayrollMonth",
                minAmount: "2000",
                amount: "2500",
                maxAmount: "3000"
            }
            const created = store(state.payroll, Object.assign({gradeName: "Grade 4", fromDate: since}, band))
            const gradeId = created.payGradeId
            // an employment salary on the grade, which a band change leaves as it is
            call("create#mantle.humanres.employment.EmploymentSalary", {
                partyRelationshipId: state.HOLDER_EMP,
                fromDate: since,
                payGradeId: gradeId,
                amount: "2400",
                currencyUomId: "USD",
                timePeriodTypeId: "PayrollMonth"
            })
            const next = state.now + 30 * day
            const refusals = {
                order: code(store(state.payroll, Object.assign({gradeName: "X"}, band, {minAmount: "2600"}))),
                currency: code(store(state.payroll, Object.assign({gradeName: "X"}, band, {currencyUomId: ""}))),
                frequency: code(store(state.payroll, Object.assign({gradeName: "X"}, band, {timePeriodTypeId: "FiscalMonth"}))),
                missing: code(store(state.payroll, Object.assign({gradeName: "X"}, band, {maxAmount: ""}))),
                hr: code(store(state.hr, Object.assign({gradeName: "X"}, band))),
                revision: code(
                    store(state.payroll, Object.assign({payGradeId: gradeId, expectedRevision: "0", fromDate: next}, band))
                )
            }
            const revision = run(state.payroll, G + "find#PayGrades", {payGradeId: gradeId}).payGrades[0].revision
            const raised = store(
                state.payroll,
                Object.assign({payGradeId: gradeId, expectedRevision: revision, fromDate: next}, band, {
                    amount: "2700",
                    maxAmount: "3200"
                })
            )
            const scheduled = code(
                store(
                    state.payroll,
                    Object.assign(
                        {
                            payGradeId: gradeId,
                            expectedRevision: run(state.payroll, G + "find#PayGrades", {payGradeId: gradeId}).payGrades[0]
                                .revision,
                            fromDate: state.now
                        },
                        band
                    )
                )
            )
            const payroll = run(state.payroll, G + "find#PayGrades", {payGradeId: gradeId})
            const later = run(state.payroll, G + "find#PayGrades", {payGradeId: gradeId, asOfDate: next + day})
            const hr = run(state.hr, G + "find#PayGrades", {term: "grade 4"})
            // the position's grade, as HR reads it: its name only
            run(state.hr, S + "store#Position", {
                emplPositionId: state.second,
                payGradeId: gradeId,
                expectedRevision: run(state.hr, S + "get#Position", {emplPositionId: state.second}).position.revision
            })
            const position = run(state.hr, S + "get#Position", {emplPositionId: state.second}).position
            const salary = ec.entity
                .find("mantle.humanres.employment.EmploymentSalary")
                .condition("partyRelationshipId", state.HOLDER_EMP)
                .one()
            return {
                created: created.error,
                refusals,
                raised: raised.error,
                scheduled,
                payrollNow: [
                    payroll.amountsShown,
                    String(payroll.payGrades[0].band.amount),
                    payroll.payGrades[0].band.frequencyText
                ],
                bands: payroll.bands.map(row => [String(row.amount), row.state, row.thruDateText != ""].join(" ")),
                payrollLater: String(later.payGrades[0].band.amount),
                hrRows: hr.payGrades.map(row => row.gradeName),
                hrAnswer: JSON.stringify({payGrades: hr.payGrades, bands: hr.bands}),
                hrShown: hr.amountsShown,
                positionGrade: position.payGradeName,
                positionAnswer: JSON.stringify(position),
                salary: String(salary.amount)
            }
        },
        then({
            created,
            refusals,
            raised,
            scheduled,
            payrollNow,
            bands,
            payrollLater,
            hrRows,
            hrAnswer,
            hrShown,
            positionGrade,
            positionAnswer,
            salary
        }) {
            created == ""
            refusals ==
                {
                    order: "BAND_ORDER",
                    currency: "CURRENCY_REQUIRED",
                    frequency: "FREQUENCY_INVALID",
                    missing: "AMOUNT_REQUIRED",
                    hr: "PERMISSION_DENIED",
                    revision: "REVISION_CHANGED"
                }
            raised == ""
            scheduled == "BAND_SCHEDULED"
            payrollNow == [true, "2500", "Month"]
            bands == ["2700 future false", "2500 current true"]
            payrollLater == "2700"
            hrRows == ["Grade 4"]
            hrShown == false
            !/2500|2700|USD|PayrollMonth|minAmount|maxAmount|"band"/.test(hrAnswer)
            positionGrade == "Grade 4"
            !/2500|2700|USD/.test(positionAnswer)
            salary == "2400"
        }
    }
)
