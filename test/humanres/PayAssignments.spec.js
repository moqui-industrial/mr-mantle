// People's pay assignments and compensation (mantle.humanres.PayrollSetupServices find#Assignments, assign#PayStructure,
// store#PayrollProfile, get#Compensation; EmploymentServices create#EmploymentSalary as P23 extends it; PeopleServices'
// pay change; IronStone People design §8.1, §8 PayAssignments, §4 Employee360's Compensation and EmploymentChange; PE-08,
// PE-12; impl-people P23, F4, F33): overlapping primary assignments refused (one per employment and date, or the one in effect
// replaced from the date with a reason), the assignment's employer, currency, published structure, inputs and elections checked,
// a structure in use not ended; only a first salary set directly, a later one through the approved pay change or by an audited
// repair (PAYROLL_REPAIR), the row in effect ended, a later or same-dated one refused, PAYROLL_EDIT and the employer's scope
// required; a pay change (the first salary too) waiting for the employer's payroll approvers with a notice naming no one and no
// amount, never decided by who asked, then applied, a manager reading the salary of the one change a rule routes to them alone,
// and HR neither asking for it nor reading it (the user's calls of Nov 12, 2026); compensation absent for HR without PAYROLL_VIEW, with the same
// parameters, and another employer's employment missing to its payroll; the tax profile holding the demonstration localization's
// declared fields alone, benefits added and ended, and the readiness clear once salary, assignment and profile are in place.
// Standalone: spec-local organizations, people, employments, structures, groups and users, with artifact authorization disabled
// (the rules are the services' own checks). Run: ./moq test mr-mantle --spec PayAssignments
const prefix = "PAY_ASGN_SPEC"
const orgA = prefix + "_A",
    orgB = prefix + "_B",
    since = "2001-01-01T00:00:00Z"
const G = "mantle.humanres.PayrollSetupServices."
const P = "mantle.humanres.PeopleServices."
const SALARY = "mantle.humanres.EmploymentServices.create#EmploymentSalary"
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
const rows = (entity, conditions) => Array.from(ec.entity.find(entity).condition(conditions).disableAuthz().list())
const ms = value => (value == null ? null : ec.user.timestampMillis(value))
// a day from today in the user's zone, as the screens' date fields give it
const dayText = offset => ec.l10n.format(new Date(Date.now() + offset * day), "yyyy-MM-dd")
const dayMs = offset => ec.user.timestampMillis(dayText(offset))
function organization(partyId, name) {
    call("create#mantle.party.Party", {partyId, partyTypeEnumId: "PtyOrganization", ownerPartyId: partyId})
    call("create#mantle.party.Organization", {partyId, organizationName: name})
    call("create#mantle.party.PartyRole", {partyId, roleTypeId: "OrgInternal"})
}
function person(kind) {
    const partyId = prefix + "_" + kind
    call("create#mantle.party.Party", {partyId, partyTypeEnumId: "PtyPerson"})
    call("create#mantle.party.Person", {partyId, firstName: "Pay", lastName: kind})
    return partyId
}
const employ = (partyId, organizationPartyId) =>
    call("mantle.humanres.EmploymentServices.create#Employment", {
        fromPartyId: partyId,
        toPartyId: organizationPartyId,
        fromDate: since
    }).partyRelationshipId
// a user of a spec-local group with the permissions: the person given, else a new agent of the organizations
function user(kind, permissions, organizationPartyIds, partyId = null) {
    const id = prefix + "_U_" + kind
    call("create#moqui.security.UserGroup", {userGroupId: id, description: "Pay assignments " + kind})
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
// a published component of the employer with one published term (configuration is P22's, made here as data)
function component(organizationPartyId, componentCode, fields) {
    const payrollComponentId = prefix + "_C_" + componentCode
    call("create#mantle.humanres.payroll.PayrollComponent", {
        payrollComponentId,
        organizationPartyId,
        componentCode,
        componentName: componentCode,
        componentKindEnumId: "PckEarning"
    })
    call(
        "create#mantle.humanres.payroll.PayrollComponentTerm",
        Object.assign(
            {payrollComponentId, statusId: "PtsPublished", fromDate: "2000-01-01T00:00:00Z", currencyUomId: "USD"},
            fields
        )
    )
    return payrollComponentId
}
// a structure of the employer, published from since unless told, with its lines (component, eligibility)
function structure(id, organizationPartyId, currencyUomId, lines, statusId = "PtsPublished") {
    call("create#mantle.humanres.payroll.PayrollStructure", {
        payrollStructureId: id,
        organizationPartyId,
        structureName: id,
        currencyUomId,
        payBasisEnumId: "PpbSalaried",
        statusId,
        // published before the employments start, so an assignment before them is refused for the employment's dates
        fromDate: statusId === "PtsPublished" ? "2000-01-01T00:00:00Z" : null
    })
    lines.forEach(([payrollComponentId, eligibilityEnumId], index) =>
        call("create#mantle.humanres.payroll.PayrollStructureComponent", {
            payrollStructureId: id,
            payrollComponentId,
            statusId,
            fromDate: "2000-01-01T00:00:00Z",
            sequenceNum: (index + 1) * 10,
            eligibilityEnumId: eligibilityEnumId || null
        })
    )
    return id
}
function group(id, organizationPartyId, currencyUomId) {
    call("create#mantle.humanres.payroll.PayrollGroup", {
        payrollGroupId: id,
        organizationPartyId,
        groupName: id,
        currencyUomId,
        timePeriodTypeId: "PayrollMonth",
        firstPeriodFromDate: "2026-01-01",
        periodsPerYear: 12,
        payDateOffsetDays: 0,
        prorationEnumId: "PprCalendarDays",
        timeBasisEnumId: "PtbSchedule",
        payrollLocalizationId: "PlzDemonstration",
        liveEnabled: "N",
        fromDate: since
    })
    return id
}
const salaries = partyRelationshipId =>
    rows("mantle.humanres.employment.EmploymentSalary", {partyRelationshipId}).sort((a, b) => ms(a.fromDate) - ms(b.fromDate))
const assignmentsOf = partyRelationshipId =>
    rows("mantle.humanres.payroll.PayrollAssignment", {partyRelationshipId}).sort((a, b) => ms(a.fromDate) - ms(b.fromDate))

spec({
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        organization(orgA, "Pay Assignments Spec A")
        organization(orgB, "Pay Assignments Spec B")
        state.ana = person("ANA")
        state.ben = person("BEN")
        state.cy = person("CY")
        state.mia = person("MIA")
        state.kit = person("KIT")
        state.anaEmp = employ(state.ana, orgA)
        state.benEmp = employ(state.ben, orgA)
        state.cyEmp = employ(state.cy, orgA)
        state.miaEmp = employ(state.mia, orgA)
        state.kitEmp = employ(state.kit, orgB)
        // Mia manages Ana: a pay change's approver only when a rule routes it to the manager (P23 review)
        call("create#mantle.party.PartyRelationship", {
            relationshipTypeEnumId: "PrtManager",
            fromPartyId: state.mia,
            toPartyId: state.ana,
            fromDate: since
        })
        state.payroll = user("PAYROLL", ["PAYROLL_VIEW", "PAYROLL_EDIT"], [orgA])
        state.payrollB = user("PAYROLLB", ["PAYROLL_VIEW", "PAYROLL_EDIT"], [orgB])
        state.reader = user("READER", ["PAYROLL_VIEW"], [orgA])
        state.config = user("CONFIG", ["PAYROLL_VIEW", "PAYROLL_EDIT", "PAYROLL_CONFIGURE"], [orgA])
        state.hr = user("HR", ["PEOPLE_HR_VIEW", "PEOPLE_HR_EDIT", "PEOPLE_REQUEST_APPROVE"], [orgA])
        state.manager = user("MANAGER", ["PEOPLE_TEAM_VIEW", "PEOPLE_REQUEST_APPROVE"], [], state.mia)
        // P23 review: the employer's payroll approver (a pay change's default route), a payroll editor who approves too (never their
        // own request), an editor reading no employer, and a repairer (PAYROLL_REPAIR, ADMIN's in Mantle's data)
        state.approver = user("APPROVER", ["PAYROLL_VIEW", "PAYROLL_APPROVE"], [orgA])
        state.payApprover = user("PAYAPPROVER", ["PAYROLL_VIEW", "PAYROLL_EDIT", "PAYROLL_APPROVE"], [orgA])
        state.editOnly = user("EDITONLY", ["PAYROLL_EDIT"], [orgA])
        state.repair = user("REPAIR", ["PAYROLL_EDIT", "PAYROLL_REPAIR"], [])
        state.salaryComp = component(orgA, "BASE", {basisEnumId: "PcbAmount", amount: "100"})
        state.pensionComp = component(orgA, "PENSION", {
            basisEnumId: "PcbFormula",
            formula: "round(BASE * pensionRate, 2)",
            inputNames: "pensionRate",
            dependencyCodes: "BASE"
        })
        state.structure = structure(prefix + "_S_MONTHLY", orgA, "USD", [
            [state.salaryComp, "PleAll"],
            [state.pensionComp, "PleElected"]
        ])
        state.euro = structure(prefix + "_S_EURO", orgA, "EUR", [[state.salaryComp, "PleAll"]])
        state.draft = structure(prefix + "_S_DRAFT", orgA, "USD", [[state.salaryComp, "PleAll"]], "PtsDraft")
        state.extra = structure(prefix + "_S_EXTRA", orgA, "USD", [[state.salaryComp, "PleAll"]])
        state.structureB = structure(prefix + "_S_B", orgB, "USD", [])
        state.group = group(prefix + "_G_MONTHLY", orgA, "USD")
        state.groupB = group(prefix + "_G_B", orgB, "USD")
    },
    cleanupSpec() {
        ec.message.clearErrors()
        login("john.doe")
    }
})

feature(
    "one primary pay assignment per employment and date: an overlap refused, the one in effect replaced from a date with a reason; the terms checked once",
    {
        when() {
            const assign = (username, extra) =>
                run(
                    username,
                    G + "assign#PayStructure",
                    Object.assign(
                        {
                            partyRelationshipIds: [state.anaEmp],
                            payrollStructureId: state.structure,
                            payrollGroupId: state.group,
                            fromDate: dayText(-30)
                        },
                        extra
                    )
                )
            const outcome = out =>
                out.error
                    ? code(out)
                    : Array.from(out.rows || [])
                          .map(row => row.reasonCode || row.outcome)
                          .join(",")
            const preview = assign(state.payroll, {preview: true})
            const previewWrote = assignmentsOf(state.anaEmp).length
            const first = assign(state.payroll, {inputValues: "pensionRate = 0.05", electedComponentIds: state.pensionComp})
            const overlap = assign(state.payroll, {fromDate: dayText(-10)})
            const noReason = assign(state.payroll, {fromDate: dayText(-10), replaceCurrent: true})
            const replaced = assign(state.payroll, {fromDate: dayText(-10), replaceCurrent: true, reason: "New terms"})
            const sameSecondary = assign(state.payroll, {fromDate: dayText(-5), isPrimary: "N"})
            const secondary = assign(state.payroll, {fromDate: dayText(-5), isPrimary: "N", payrollStructureId: state.extra})
            const history = assignmentsOf(state.anaEmp)
            state.anaAssignment = history[history.length - 1].payrollAssignmentId
            return {
                codes: {
                    preview: outcome(preview),
                    previewWrote,
                    first: outcome(first),
                    overlap: outcome(overlap),
                    noReason: outcome(noReason),
                    replaced: outcome(replaced),
                    sameSecondary: outcome(sameSecondary),
                    secondary: outcome(secondary),
                    hr: outcome(assign(state.hr, {fromDate: dayText(-5)})),
                    reader: outcome(assign(state.reader, {fromDate: dayText(-5)})),
                    otherEmployer: outcome(assign(state.payroll, {partyRelationshipIds: [state.kitEmp], fromDate: dayText(-5)})),
                    otherGroup: outcome(assign(state.payroll, {payrollGroupId: state.groupB})),
                    currency: outcome(assign(state.payroll, {payrollStructureId: state.euro})),
                    draft: outcome(assign(state.payroll, {payrollStructureId: state.draft})),
                    unknownInput: outcome(
                        assign(state.payroll, {partyRelationshipIds: [state.benEmp], inputValues: "bonusRate = 1"})
                    ),
                    shadowInput: outcome(assign(state.payroll, {partyRelationshipIds: [state.benEmp], inputValues: "BASE = 1"})),
                    election: outcome(
                        assign(state.payroll, {partyRelationshipIds: [state.benEmp], electedComponentIds: state.salaryComp})
                    ),
                    beforeEmployment: outcome(
                        assign(state.payroll, {partyRelationshipIds: [state.benEmp], fromDate: "2000-06-01"})
                    ),
                    // Ben and Kit together: Ben's is made, Kit's (another employer's) named and refused, the batch going on
                    batch: outcome(
                        assign(state.payroll, {partyRelationshipIds: [state.benEmp, state.kitEmp], fromDate: dayText(-20)})
                    )
                },
                history: history.map(row => [row.isPrimary, row.thruDate == null ? "open" : "ended"].join(" ")),
                firstEnded: ms(history[0].thruDate) == dayMs(-10),
                // the end is audited with its reason (P23 review: thruDate audited from its first value)
                endAudit: rows("moqui.entity.EntityAuditLog", {
                    changedEntityName: "mantle.humanres.payroll.PayrollAssignment",
                    changedFieldName: "thruDate",
                    pkPrimaryValue: history[0].payrollAssignmentId
                }).map(row => row.changeReason),
                inputs: JSON.parse(history[0].inputValues || "{}").pensionRate,
                elected: history[0].electedComponentIds,
                count: run(state.reader, G + "find#Structures", {organizationPartyId: orgA}).structures?.find(
                    row => row.payrollStructureId === state.structure
                )?.assignmentCount,
                endInUse: code(
                    run(state.config, G + "store#Structure", {
                        payrollStructureId: state.structure,
                        expectedRevision: run(state.config, G + "find#Structures", {payrollStructureId: state.structure})
                            .structure?.revision,
                        end: true
                    })
                )
            }
        },
        then({codes, history, firstEnded, endAudit, inputs, elected, count, endInUse}) {
            codes ==
                {
                    preview: "ready",
                    previewWrote: 0,
                    first: "done",
                    overlap: "PRIMARY_OVERLAP",
                    noReason: "REASON_REQUIRED",
                    replaced: "done",
                    sameSecondary: "STRUCTURE_ASSIGNED",
                    secondary: "done",
                    hr: "PERMISSION_DENIED",
                    reader: "PERMISSION_DENIED",
                    otherEmployer: "EMPLOYMENT_OUTSIDE",
                    otherGroup: "RECORD_UNAVAILABLE",
                    currency: "CURRENCY_MISMATCH",
                    draft: "STRUCTURE_NOT_PUBLISHED",
                    unknownInput: "INPUT_UNKNOWN",
                    shadowInput: "INPUT_INVALID",
                    election: "ELECTION_INVALID",
                    beforeEmployment: "DATE_OUTSIDE",
                    batch: "done,EMPLOYMENT_OUTSIDE"
                }
            history == ["Y ended", "Y open", "N open"]
            firstEnded
            endAudit == ["New terms"]
            inputs == "0.05"
            elected == state.pensionComp
            count == 2
            endInUse == "STILL_ASSIGNED"
        }
    }
)

feature(
    "only a first salary is set directly; a later one is refused but to an audited repair, dated, the row in effect ended; a later or same-dated row refused; PAYROLL_EDIT and the employer's scope required",
    {
        when() {
            const set = (username, offset, amount, comments = null, partyRelationshipId = state.anaEmp) =>
                code(
                    run(username, SALARY, {
                        partyRelationshipId,
                        amount,
                        currencyUomId: "USD",
                        timePeriodTypeId: "PayrollMonth",
                        fromDate: dayText(offset),
                        comments
                    })
                )
            const codes = {
                editOnly: set(state.editOnly, -60, "4000"),
                first: set(state.payroll, -60, "4000"),
                raise: set(state.payroll, -20, "4200"),
                repairNoReason: set(state.repair, -20, "4200"),
                repaired: set(state.repair, -20, "4200", "Imported at the wrong amount"),
                sameDay: set(state.repair, -20, "4300", "Again"),
                beforeLater: set(state.repair, -40, "4100", "Earlier"),
                hr: set(state.hr, -5, "9000"),
                otherEmployer: set(state.payrollB, -5, "9000")
            }
            const list = salaries(state.anaEmp)
            const audit = rows("moqui.entity.EntityAuditLog", {
                changedEntityName: "mantle.humanres.employment.EmploymentSalary",
                changedFieldName: "thruDate",
                pkPrimaryValue: state.anaEmp
            })
            return {
                codes,
                amounts: list.map(row => String(row.amount)),
                endedOnRaise: ms(list[0].thruDate) == dayMs(-20),
                openLast: list[1].thruDate == null,
                auditReasons: audit.map(row => row.changeReason)
            }
        },
        then({codes, amounts, endedOnRaise, openLast, auditReasons}) {
            codes ==
                {
                    editOnly: "RECORD_UNAVAILABLE",
                    first: "",
                    raise: "PAY_CHANGE_REQUIRED",
                    repairNoReason: "REASON_REQUIRED",
                    repaired: "",
                    sameDay: "SALARY_EXISTS",
                    beforeLater: "SALARY_SCHEDULED",
                    hr: "PERMISSION_DENIED",
                    otherEmployer: "RECORD_UNAVAILABLE"
                }
            amounts.map(amount => Number(amount)) == [4000, 4200]
            endedOnRaise
            openLast
            auditReasons == ["Imported at the wrong amount"]
        }
    }
)

feature(
    "a pay change waits for the employer's payroll approvers, the first salary too, its notice naming no one and no amount; never decided by who asked or the manager; a rule routes it to the manager, who reads that change's salary alone; HR neither asks for it nor reads it",
    {
        when() {
            const MESSAGE = "moqui.security.user.NotificationMessage"
            const payChange = (username, partyRelationshipId, partyId, extra = {}) =>
                run(
                    username,
                    P + "apply#EmploymentChange",
                    Object.assign(
                        {
                            partyRelationshipId,
                            changeKind: "pay",
                            effectiveDate: dayText(1),
                            salaryAmount: "4500",
                            salaryCurrencyUomId: "USD",
                            salaryPeriodTypeId: "PayrollMonth",
                            reason: "Annual review",
                            expectedRevision: run(state.payroll, G + "get#Compensation", {partyId}).payRevision
                        },
                        extra
                    )
                )
            const decide = (username, employmentChangeId) =>
                run(username, P + "decide#EmploymentChange", {employmentChangeId, decision: "approve"})
            const changeOf = employmentChangeId => rows("mantle.humanres.employment.EmploymentChange", {employmentChangeId})[0]
            const recipients = employmentChangeId =>
                rows(MESSAGE, {topic: "PeopleEmploymentChangeApproval", recordId: employmentChangeId}).flatMap(notice =>
                    rows("moqui.security.user.NotificationMessageUser", {
                        notificationMessageId: notice.notificationMessageId
                    }).map(row => row.userId)
                )
            const salaryOf = (username, employmentChangeId, includeDone = false) =>
                (run(username, P + "find#EmploymentChanges", {partyId: state.ana, includeDone}).changes || []).find(
                    row => row.employmentChangeId === employmentChangeId
                )?.salaryText ?? null
            const hr = payChange(state.hr, state.anaEmp, state.ana)
            const noFrequency = payChange(state.payroll, state.anaEmp, state.ana, {salaryPeriodTypeId: ""})
            const payRevision = run(state.payroll, G + "get#Compensation", {partyId: state.ana}).payRevision
            const preview = run(state.payroll, P + "preview#EmploymentChange", {
                partyRelationshipId: state.anaEmp,
                changeKind: "pay",
                effectiveDate: dayText(1),
                salaryAmount: "4500",
                salaryCurrencyUomId: "USD",
                salaryPeriodTypeId: "PayrollMonth",
                reason: "Annual review"
            })
            const asked = payChange(state.payroll, state.anaEmp, state.ana)
            const waiting = changeOf(asked.employmentChangeId)
            const notices = rows(MESSAGE, {topic: "PeopleEmploymentChangeApproval", recordId: asked.employmentChangeId})
            const title = notices.map(row => String(row.titleText || "")).join(" | ")
            const routedTo = recipients(asked.employmentChangeId)
            const salariesWhileWaiting = salaries(state.anaEmp).length
            const reads = {
                hrSeesPay: (
                    run(state.hr, P + "find#EmploymentChanges", {partyId: state.ana, includeDone: true}).changes || []
                ).some(row => row.changeKindEnumId === "EckPayChange"),
                payroll: salaryOf(state.payroll, asked.employmentChangeId),
                approver: salaryOf(state.approver, asked.employmentChangeId),
                manager: salaryOf(state.manager, asked.employmentChangeId)
            }
            const byManager = decide(state.manager, asked.employmentChangeId)
            const approved = decide(state.approver, asked.employmentChangeId)
            const after = salaries(state.anaEmp)
            // Cy has no salary: his first waits too, and the payroll editor who asked, an approver too, may not decide it
            const first = payChange(state.payApprover, state.cyEmp, state.cy, {effectiveDate: dayText(-20), reason: "Starting"})
            const firstWaiting = changeOf(first.employmentChangeId)?.statusId
            const cyWhileWaiting = salaries(state.cyEmp).length
            const own = decide(state.payApprover, first.employmentChangeId)
            const firstApproved = decide(state.approver, first.employmentChangeId)
            // an employer's rule routes a pay change to the manager: Mia decides it and reads its salary, and nothing else of Ana's pay
            call("create#mantle.humanres.approval.PeopleApprovalPolicy", {
                organizationPartyId: orgA,
                approvalKindEnumId: "PakPayChange",
                sequenceNum: 1,
                approverRoleEnumId: "ParManager",
                fromDate: since
            })
            const routed = payChange(state.payroll, state.anaEmp, state.ana, {effectiveDate: dayText(5), salaryAmount: "4600"})
            const manager = {
                routed: salaryOf(state.manager, routed.employmentChangeId),
                appliedBefore: salaryOf(state.manager, asked.employmentChangeId, true),
                compensation: code(run(state.manager, G + "get#Compensation", {partyId: state.ana})),
                approverNow: salaryOf(state.approver, routed.employmentChangeId)
            }
            return {
                codes: {
                    hr: code(hr),
                    noFrequency: code(noFrequency),
                    asked: code(asked),
                    byManager: code(byManager),
                    approved: code(approved),
                    first: code(first),
                    own: code(own),
                    firstApproved: code(firstApproved),
                    routed: code(routed)
                },
                preview: [
                    code(preview),
                    preview.needsApproval,
                    Array.from(preview.route || [])
                        .map(step => (step.unresolved ? "unresolved" : "routed"))
                        .join(","),
                    preview.revision === payRevision
                ],
                waitingStatus: waiting?.statusId,
                waitingAmount: String(waiting?.salaryAmount),
                noticeCount: notices.length,
                title,
                routedTo,
                salariesWhileWaiting,
                reads,
                applied: approved.applied,
                amounts: after.map(row => Number(String(row.amount))),
                raiseEnded: ms(after[1].thruDate) == dayMs(1),
                firstWaiting,
                cyWhileWaiting,
                firstApplied: firstApproved.applied,
                cySalaries: salaries(state.cyEmp).map(row => Number(String(row.amount))),
                manager
            }
        },
        then(result) {
            result.codes ==
                {
                    hr: "PERMISSION_DENIED",
                    noFrequency: "FREQUENCY_REQUIRED",
                    asked: "",
                    byManager: "NOT_APPROVER",
                    approved: "",
                    first: "",
                    own: "SELF_APPROVAL",
                    firstApproved: "",
                    routed: ""
                }
            // the payroll editor previews it: it waits for the payroll approvers, at the salary revision (P23 review)
            result.preview == ["", true, "routed", true]
            result.waitingStatus == "EchRequested"
            Number(result.waitingAmount) == 4500
            result.noticeCount == 1
            !result.title.includes("4500") && !result.title.includes("4,500") && !result.title.includes("Pay ANA")
            result.title.includes("a pay change")
            result.routedTo.includes(state.approver) && result.routedTo.includes(state.payApprover)
            !result.routedTo.includes(state.manager) && !result.routedTo.includes(state.payroll)
            result.salariesWhileWaiting == 2
            !result.reads.hrSeesPay
            result.reads.payroll.includes("4,500")
            result.reads.approver.includes("4,500")
            result.reads.manager == null
            result.applied
            result.amounts == [4000, 4200, 4500]
            result.raiseEnded
            result.firstWaiting == "EchRequested"
            result.cyWhileWaiting == 0
            result.firstApplied
            result.cySalaries == [4500]
            result.manager.routed.includes("4,600")
            result.manager.appliedBefore == null
            result.manager.compensation == "PERMISSION_DENIED"
            result.manager.approverNow.includes("4,600")
        }
    }
)

feature(
    "compensation is absent for HR without PAYROLL_VIEW, with the same parameters; another employer's payroll is refused; the readiness clears with salary, assignment and tax profile",
    {
        when() {
            const regions = username =>
                Array.from(
                    run(username, P + "get#Employee360", {partyId: state.ana, partyRelationshipId: state.anaEmp}).regions || []
                )
            const read = (username, partyId = state.ana) => run(username, G + "get#Compensation", {partyId})
            const payroll = read(state.payroll)
            const readiness = () =>
                Object.fromEntries(
                    Array.from(run(state.payroll, G + "find#Assignments", {organizationPartyId: orgA}).assignments || []).map(
                        row => [row.partyId, row.readinessCode || "ready"]
                    )
                )
            const before = readiness()
            const profile = (values, extra = {}) =>
                code(
                    run(
                        state.payroll,
                        G + "store#PayrollProfile",
                        Object.assign(
                            {
                                partyRelationshipId: state.anaEmp,
                                payrollLocalizationId: "PlzDemonstration",
                                profileValues: values,
                                expectedRevision: read(state.payroll).profile?.revision,
                                fromDate: dayText(-30)
                            },
                            extra
                        )
                    )
                )
            const profileCodes = {
                unknown: profile("levyRegion = NORTH; filingStatus = single"),
                missing: profile("levyExempt = Y"),
                badChoice: profile("levyRegion = EAST"),
                stale: profile("levyRegion = NORTH", {expectedRevision: "1"}),
                hr: code(
                    run(state.hr, G + "store#PayrollProfile", {
                        partyRelationshipId: state.anaEmp,
                        payrollLocalizationId: "PlzDemonstration",
                        profileValues: "levyRegion = NORTH",
                        expectedRevision: read(state.payroll).profile?.revision
                    })
                ),
                stored: profile("levyRegion = NORTH")
            }
            const benefit = extra =>
                code(
                    run(
                        state.payroll,
                        G + "store#PayrollProfile",
                        Object.assign(
                            {
                                partyRelationshipId: state.anaEmp,
                                benefitTypeId: "Health",
                                fromDate: dayText(-30),
                                expectedRevision: read(state.payroll).benefitRevision
                            },
                            extra
                        )
                    )
                )
            const benefitCodes = {
                stale: benefit({cost: "120.00", expectedRevision: "1"}),
                added: benefit({cost: "120.00", employerPaidPercent: "75"}),
                overlap: benefit({}),
                badShare: benefit({fromDate: dayText(-200), thruDate: dayText(-100), employerPaidPercent: "120"}),
                ended: benefit({endBenefit: true, benefitFromDate: dayText(-30), thruDate: dayText(5)})
            }
            const after = read(state.payroll)
            return {
                regions: {payroll: regions(state.payroll), hr: regions(state.hr)},
                refusals: {
                    hr: code(read(state.hr)),
                    otherPayroll: code(read(state.payrollB)),
                    unknownPerson: code(read(state.payroll, prefix + "_NOBODY"))
                },
                payroll: {
                    salary: payroll.currentSalary?.salaryText || "",
                    structure: payroll.primary?.structureName,
                    canEdit: payroll.canEdit,
                    fields: Array.from(payroll.profile?.fields || []).map(field => field.fieldName)
                },
                before,
                profileCodes,
                benefitCodes,
                after: {
                    readiness: after.readiness.state,
                    region: after.profile.fields.find(field => field.fieldName === "levyRegion")?.valueText,
                    benefits: after.benefits.map(row =>
                        [row.benefitText, row.employerPaidText, row.thruDateText ? "ending" : "open"].join(" ")
                    )
                },
                readinessAfter: readiness(),
                legacyUntouched:
                    rows("mantle.humanres.employment.Employment", {partyRelationshipId: state.anaEmp})[0].taxFederalAllowances ==
                    null
            }
        },
        then(result) {
            result.regions.payroll.includes("compensation")
            !result.regions.hr.includes("compensation")
            result.refusals == {hr: "PERMISSION_DENIED", otherPayroll: "RECORD_UNAVAILABLE", unknownPerson: "RECORD_UNAVAILABLE"}
            result.payroll.salary.includes("4,200")
            result.payroll.structure == state.structure
            result.payroll.canEdit
            result.payroll.fields == ["levyRegion", "levyExempt"]
            result.before[state.ana] == "PROFILE_MISSING"
            result.before[state.cy] == "NO_ASSIGNMENT"
            result.profileCodes ==
                {
                    unknown: "FIELD_UNKNOWN",
                    missing: "FIELD_REQUIRED",
                    badChoice: "VALUE_INVALID",
                    stale: "REVISION_CHANGED",
                    hr: "PERMISSION_DENIED",
                    stored: ""
                }
            result.benefitCodes ==
                {stale: "REVISION_CHANGED", added: "", overlap: "BENEFIT_EXISTS", badShare: "PERCENT_INVALID", ended: ""}
            result.after.readiness == "ready"
            result.after.region == "North (synthetic)"
            result.after.benefits == ["Health Insurance 75% ending"]
            result.readinessAfter[state.ana] == "ready"
            // Ben's first salary is not set (a pay change waits for approval; P23 review)
            result.readinessAfter[state.ben] == "SALARY_MISSING"
            result.legacyUntouched
        }
    }
)
