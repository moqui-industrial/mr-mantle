// People's pay runs (mantle.humanres.PayrollRunServices find#Runs, create#Run, select#Employments, calculate#Run, get#Run,
// submit#Run, approve#Run and return#Run; IronStone People design §8.1, §8.2 steps 1 to 5, PayRuns, PayRunDetail; PE-10; impl-people
// P25): each employment is calculated in its own unit, so one bad worker leaves the others calculated, and a resumed run calculates
// only the pending and failed ones, making no second result; a mid-period salary change splits the period, prorated by calendar
// days; salaried, hourly and piece pay, an adjustment and the demonstration localization reconcile to the cent; the run's approval
// is a payroll approver's, never a preparer's, and a changed input invalidates it; a second regular run over consumed inputs is
// refused. No invoice or payment is made.
// Standalone: spec-local organizations, people, employments, pay configuration (published as data: publishing is PayConfiguration's
// spec), salaries, rates, approved inputs and users. Run: ./moq test mr-mantle --spec PayRuns
const prefix = "PAY_RUN_SPEC"
const orgA = prefix + "_A",
    orgB = prefix + "_B",
    since = "2001-01-01T00:00:00Z",
    payFrom = "2026-01-01T00:00:00Z"
const S = "mantle.humanres.PayrollRunServices."
const UNIT = "mantle.humanres.payroll.PayrollRunEmployment"
const RESULT = "mantle.humanres.payroll.PayrollRunResult"
const INPUT = "mantle.humanres.payroll.PayrollInput"
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
const code = out => (out.error ? /[A-Z][A-Z0-9_]{3,}(?=:)/.exec(out.error)?.[0] || out.error : "")
const rows = (entity, conditions) => Array.from(ec.entity.find(entity).condition(conditions).disableAuthz().list())
const one = (entity, conditions) => ec.entity.find(entity).condition(conditions).disableAuthz().one()
const money = value => (value == null ? null : String(toDecimal(value).setScale(2)))
function organization(partyId, name) {
    call("create#mantle.party.Party", {partyId, partyTypeEnumId: "PtyOrganization", ownerPartyId: partyId})
    call("create#mantle.party.Organization", {partyId, organizationName: name})
    call("create#mantle.party.PartyRole", {partyId, roleTypeId: "OrgInternal"})
}
function person(kind) {
    const partyId = prefix + "_" + kind
    call("create#mantle.party.Party", {partyId, partyTypeEnumId: "PtyPerson"})
    call("create#mantle.party.Person", {partyId, firstName: "Run", lastName: kind})
    return partyId
}
const employ = (partyId, organizationPartyId) =>
    call("mantle.humanres.EmploymentServices.create#Employment", {
        fromPartyId: partyId,
        toPartyId: organizationPartyId,
        fromDate: since
    }).partyRelationshipId
function user(kind, permissions, organizationPartyIds) {
    const id = prefix + "_U_" + kind
    call("create#moqui.security.UserGroup", {userGroupId: id, description: "Pay runs " + kind})
    for (const permission of permissions)
        call("create#moqui.security.UserGroupPermission", {userGroupId: id, userPermissionId: permission, fromDate: since})
    const partyId = person("USER_" + kind)
    for (const organizationPartyId of organizationPartyIds)
        call("create#mantle.party.PartyRelationship", {
            relationshipTypeEnumId: "PrtAgent",
            fromPartyId: partyId,
            toPartyId: organizationPartyId,
            toRoleTypeId: "OrgInternal",
            fromDate: since
        })
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
// a component with one published term (a formula over its declared inputs and dependencies, or a fixed amount)
function component(componentCode, componentKindEnumId, term) {
    const payrollComponentId = prefix + "_C_" + componentCode
    call("create#mantle.humanres.payroll.PayrollComponent", {
        payrollComponentId,
        organizationPartyId: orgA,
        componentCode,
        componentName: componentCode,
        componentKindEnumId
    })
    call(
        "create#mantle.humanres.payroll.PayrollComponentTerm",
        Object.assign(
            {
                payrollComponentId,
                statusId: "PtsPublished",
                fromDate: "2000-01-01T00:00:00Z",
                basisEnumId: term.formula ? "PcbFormula" : "PcbAmount",
                currencyUomId: "USD"
            },
            term
        )
    )
    return payrollComponentId
}
function structure(id, payBasisEnumId, lines) {
    call("create#mantle.humanres.payroll.PayrollStructure", {
        payrollStructureId: id,
        organizationPartyId: orgA,
        structureName: id,
        currencyUomId: "USD",
        payBasisEnumId,
        statusId: "PtsPublished",
        fromDate: "2000-01-01T00:00:00Z"
    })
    lines.forEach(([payrollComponentId, extra], index) =>
        call(
            "create#mantle.humanres.payroll.PayrollStructureComponent",
            Object.assign(
                {
                    payrollStructureId: id,
                    payrollComponentId,
                    statusId: "PtsPublished",
                    fromDate: "2000-01-01T00:00:00Z",
                    sequenceNum: index + 1
                },
                extra || {}
            )
        )
    )
}
const assign = (partyRelationshipId, partyId, payrollStructureId, extra = {}) =>
    call(
        "create#mantle.humanres.payroll.PayrollAssignment",
        Object.assign(
            {
                partyRelationshipId,
                partyId,
                organizationPartyId: orgA,
                payrollStructureId,
                payrollGroupId: state.group,
                isPrimary: "Y",
                fromDate: payFrom
            },
            extra
        )
    )
const salary = (partyRelationshipId, amount, fromDate, thruDate = null) =>
    call("create#mantle.humanres.employment.EmploymentSalary", {
        partyRelationshipId,
        fromDate,
        thruDate,
        amount,
        currencyUomId: "USD",
        timePeriodTypeId: "PayrollYear"
    })
const rate = (partyId, rateAmount, timePeriodUomId) =>
    call("create#mantle.humanres.rate.RateAmount", {
        partyId,
        ratePurposeEnumId: "RaprVendor",
        rateAmount,
        rateCurrencyUomId: "USD",
        timePeriodUomId,
        fromDate: payFrom
    })
let inputSeq = 0
function input(partyRelationshipId, partyId, values) {
    inputSeq++
    return call(
        "create#" + INPUT,
        Object.assign(
            {
                partyRelationshipId,
                partyId,
                organizationPartyId: orgA,
                payrollGroupId: state.group,
                timePeriodId: state.march,
                statusId: "PinApproved",
                entitlementKey: prefix + "_E" + inputSeq,
                activeEntitlementKey: prefix + "_E" + inputSeq
            },
            values
        )
    ).payrollInputId
}
const unitOf = partyRelationshipId => one(UNIT, {payrollRunId: state.runId, partyRelationshipId})
const lineAmount = (partyRelationshipId, componentCode) =>
    money(one(RESULT, {payrollRunEmploymentId: unitOf(partyRelationshipId).payrollRunEmploymentId, componentCode})?.amount)

spec({
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        organization(orgA, "Pay Runs Spec A")
        organization(orgB, "Pay Runs Spec B")
        for (const kind of ["SAL", "HRL", "PCE", "BAD", "MID"]) {
            state[kind] = person(kind)
            state[kind + "Emp"] = employ(state[kind], orgA)
        }
        state.payroll = user("PAYROLL", ["PAYROLL_VIEW", "PAYROLL_EDIT"], [orgA])
        state.maker = user("MAKER", ["PAYROLL_VIEW", "PAYROLL_EDIT", "PAYROLL_APPROVE"], [orgA])
        state.approver = user("APPROVER", ["PAYROLL_VIEW", "PAYROLL_APPROVE"], [orgA])
        state.payrollB = user("PAYROLLB", ["PAYROLL_VIEW", "PAYROLL_EDIT"], [orgB])
        state.hr = user("HR", ["PEOPLE_HR_VIEW", "PEOPLE_HR_EDIT"], [orgA])
        state.group = prefix + "_MONTHLY"
        call("create#mantle.humanres.payroll.PayrollGroup", {
            payrollGroupId: state.group,
            organizationPartyId: orgA,
            groupName: "Run spec monthly",
            currencyUomId: "USD",
            timePeriodTypeId: "PayrollMonth",
            firstPeriodFromDate: "2026-03-01",
            periodsPerYear: 12,
            payDateOffsetDays: 0,
            prorationEnumId: "PprCalendarDays",
            timeBasisEnumId: "PtbTimesheets",
            payrollLocalizationId: "PlzDemonstration",
            liveEnabled: "N",
            fromDate: since
        })
        state.march = call("mantle.party.TimeServices.create#TimePeriod", {
            partyId: orgA,
            timePeriodTypeId: "PayrollMonth",
            fromDate: "2026-03-01",
            thruDate: "2026-03-31"
        }).timePeriodId
        call("create#mantle.humanres.payroll.PayrollGroupPeriod", {
            payrollGroupId: state.group,
            timePeriodId: state.march,
            payDate: "2026-03-31"
        })
        const salaryC = component("SALARY", "PckEarning", {
            formula: "round(annualSalary / periodsPerYear, 2)",
            inputNames: "annualSalary,periodsPerYear"
        })
        const pension = component("PENSION", "PckDeduction", {
            formula: "round(SALARY * pensionRate, 2)",
            inputNames: "pensionRate",
            dependencyCodes: "SALARY"
        })
        const hourly = component("HOURLY", "PckEarning", {
            formula: "workedHours * hourlyRate",
            inputNames: "workedHours,hourlyRate"
        })
        const piece = component("PIECE", "PckEarning", {formula: "pieces * pieceRate", inputNames: "pieces,pieceRate"})
        state.bonus = component("BONUS", "PckEarning", {amount: "0"})
        structure(prefix + "_SAL", "PpbSalaried", [
            [salaryC],
            [pension, {parameterValues: '{"pensionRate":"0.05"}'}],
            [state.bonus]
        ])
        structure(prefix + "_HOUR", "PpbHourly", [[hourly], [piece, {eligibilityEnumId: "PleElected"}]])
        assign(state.SALEmp, state.SAL, prefix + "_SAL")
        assign(state.BADEmp, state.BAD, prefix + "_SAL")
        assign(state.MIDEmp, state.MID, prefix + "_SAL")
        assign(state.HRLEmp, state.HRL, prefix + "_HOUR")
        assign(state.PCEEmp, state.PCE, prefix + "_HOUR", {electedComponentIds: piece})
        salary(state.SALEmp, "60000", payFrom)
        // Mid's raise from March 16: 36,000 a year through the 15th, 72,000 from the 16th
        salary(state.MIDEmp, "36000", payFrom, "2026-03-16T06:00:00Z")
        salary(state.MIDEmp, "72000", "2026-03-16T06:00:00Z")
        rate(state.HRL, "20", "TF_hr")
        rate(state.PCE, "15", "TF_hr")
        rate(state.PCE, "0.5", "OTH_ea")
        const worked = (emp, partyId, dayText, hours) =>
            input(emp, partyId, {
                inputTypeEnumId: "PitWorked",
                inputName: "workedHours",
                inputDate: dayText,
                quantity: hours,
                quantityUomId: "TF_hr"
            })
        state.hrlMonday = worked(state.HRLEmp, state.HRL, "2026-03-02", "8")
        worked(state.HRLEmp, state.HRL, "2026-03-03", "8")
        worked(state.PCEEmp, state.PCE, "2026-03-02", "8")
        input(state.PCEEmp, state.PCE, {
            inputTypeEnumId: "PitPieces",
            inputName: "pieces",
            inputDate: "2026-03-02",
            quantity: "100",
            quantityUomId: "OTH_ea"
        })
        state.bonusInput = input(state.SALEmp, state.SAL, {
            inputTypeEnumId: "PitAdjustment",
            payrollComponentId: state.bonus,
            inputDate: "2026-03-10",
            amount: "200",
            currencyUomId: "USD",
            isAdjustment: "Y"
        })
        state.invoicesBefore = rows("mantle.account.invoice.Invoice", {toPartyId: orgA}).length
    },
    cleanupSpec() {
        ec.message.clearErrors()
        login("john.doe")
    }
})

feature("one bad worker leaves the others calculated, each employee in its own unit, and no money is made", {
    when() {
        const hr = run(state.hr, S + "create#Run", {payrollGroupId: state.group, timePeriodId: state.march})
        const otherEmployer = run(state.payrollB, S + "create#Run", {payrollGroupId: state.group, timePeriodId: state.march})
        const offCycle = run(state.payroll, S + "create#Run", {
            payrollGroupId: state.group,
            timePeriodId: state.march,
            runKindEnumId: "PrkOffCycle"
        })
        const created = run(state.payroll, S + "create#Run", {payrollGroupId: state.group, timePeriodId: state.march})
        state.runId = created.payrollRunId
        const calculated = run(state.payroll, S + "calculate#Run", {payrollRunId: state.runId})
        const bad = unitOf(state.BADEmp)
        const sal = unitOf(state.SALEmp)
        const found = run(state.payroll, S + "get#Run", {payrollRunId: state.runId, partyRelationshipId: state.SALEmp})
        const otherReads = run(state.payrollB, S + "get#Run", {payrollRunId: state.runId})
        const attention = run(state.payroll, S + "find#Runs", {show: "attention"})
        return {hr, otherEmployer, offCycle, created, calculated, bad, sal, found, otherReads, attention}
    },
    then({hr, otherEmployer, offCycle, created, calculated, bad, sal, found, otherReads, attention}) {
        code(hr) == "PERMISSION_DENIED"
        code(otherEmployer) == "RECORD_UNAVAILABLE"
        code(offCycle) == "KIND_NOT_AVAILABLE"
        created.error == ""
        created.selectedCount == 5
        calculated.calculatedCount == 4
        calculated.errorCount == 1
        calculated.statusId == "PrnReview"
        bad.statusId == "PruError"
        bad.reasonCode == "SALARY_MISSING"
        // Sal: 5,000.00 a month and a 200 bonus; pension 5% of the salary; the demonstration levy 2% of earnings (104)
        lineAmount(state.SALEmp, "SALARY") == "5000.00"
        lineAmount(state.SALEmp, "BONUS") == "200.00"
        lineAmount(state.SALEmp, "PENSION") == "250.00"
        lineAmount(state.SALEmp, "DEMO_LEVY_EMPLOYEE") == "104.00"
        money(sal.grossAmount) == "5200.00"
        money(sal.netAmount) == "4846.00"
        money(sal.employerCostAmount) == "5252.00"
        // hourly 16 h at 20; pieces elected by Pce alone: 8 h at 15 and 100 pieces at 0.50
        money(unitOf(state.HRLEmp).grossAmount) == "320.00"
        lineAmount(state.HRLEmp, "PIECE") == null
        money(unitOf(state.PCEEmp).grossAmount) == "170.00"
        money(unitOf(state.PCEEmp).netAmount) == "166.60"
        one(INPUT, {payrollInputId: state.bonusInput}).payrollRunId == state.runId
        found.counts.error == 1
        found.counts.calculated == 4
        found.employment.results.length == 5
        code(otherReads) == "RECORD_UNAVAILABLE"
        attention.runs.some(row => row.payrollRunId == state.runId && row.errorCount == 1)
        rows("mantle.account.invoice.Invoice", {toPartyId: orgA}).length == state.invoicesBefore
    }
})

feature("a resumed run calculates only the pending and failed employees, making no second result", {
    when() {
        const salResults = rows(RESULT, {payrollRunEmploymentId: unitOf(state.SALEmp).payrollRunEmploymentId})
            .map(row => row.payrollRunResultId)
            .sort()
            .join(",")
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        salary(state.BADEmp, "48000", payFrom)
        const resumed = run(state.maker, S + "calculate#Run", {payrollRunId: state.runId})
        const again = run(state.maker, S + "calculate#Run", {payrollRunId: state.runId})
        const salAfter = rows(RESULT, {payrollRunEmploymentId: unitOf(state.SALEmp).payrollRunEmploymentId})
            .map(row => row.payrollRunResultId)
            .sort()
            .join(",")
        return {salResults, resumed, again, salAfter}
    },
    then({salResults, resumed, again, salAfter}) {
        resumed.processedCount == 1
        resumed.calculatedCount == 1
        unitOf(state.BADEmp).statusId == "PruCalculated"
        money(unitOf(state.BADEmp).grossAmount) == "4000.00"
        again.processedCount == 0
        salAfter == salResults
        rows(RESULT, {payrollRunId: state.runId}).length ==
            rows(UNIT, {payrollRunId: state.runId}).reduce(
                (sum, unit) => sum + rows(RESULT, {payrollRunEmploymentId: unit.payrollRunEmploymentId}).length,
                0
            )
    }
})

feature("a mid-period salary change splits the period by calendar days", {
    when() {
        const mid = unitOf(state.MIDEmp)
        return {mid}
    },
    then({mid}) {
        mid.segmentCount == 2
        mid.splitText.includes("15/31 calendar days")
        mid.splitText.includes("16/31 calendar days")
        // 36,000 x 15/31 / 12 = 1,451.61 and 72,000 x 16/31 / 12 = 3,096.77; the pension per part, 72.58 + 154.84
        lineAmount(state.MIDEmp, "SALARY") == "4548.38"
        lineAmount(state.MIDEmp, "PENSION") == "227.42"
    }
})

feature("a payroll approver approves the exact run, never a preparer, and a changed input invalidates the approval", {
    when() {
        const submitted = run(state.payroll, S + "submit#Run", {payrollRunId: state.runId, justification: "March"})
        const approval = one("mantle.humanres.approval.PeopleApproval", {peopleApprovalId: submitted.peopleApprovalId})
        const notices = rows("moqui.security.user.NotificationMessage", {topic: "PayrollRunApproval", recordId: state.runId})
        const noticeUsers = notices.flatMap(notice =>
            rows("moqui.security.user.NotificationMessageUser", {notificationMessageId: notice.notificationMessageId}).map(
                row => row.userId
            )
        )
        const noticeText = notices.map(notice => notice.messageJson || "").join(" ")
        const byPreparer = run(state.maker, S + "approve#Run", {payrollRunId: state.runId})
        const byAsker = run(state.payroll, S + "approve#Run", {payrollRunId: state.runId})
        const byHr = run(state.hr, S + "approve#Run", {payrollRunId: state.runId})
        const approved = run(state.approver, S + "approve#Run", {
            payrollRunId: state.runId,
            sourceRevision: approval.sourceRevision
        })
        const holding = run(state.payroll, S + "get#Run", {payrollRunId: state.runId})
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        call("update#" + INPUT, {payrollInputId: state.hrlMonday, quantity: "6"})
        const changed = run(state.payroll, S + "get#Run", {payrollRunId: state.runId, state: "stale"})
        const resubmit = run(state.payroll, S + "submit#Run", {payrollRunId: state.runId})
        const recalculated = run(state.payroll, S + "calculate#Run", {payrollRunId: state.runId})
        return {
            submitted,
            approval,
            notices,
            noticeUsers,
            noticeText,
            byPreparer,
            byAsker,
            byHr,
            approved,
            holding,
            changed,
            resubmit,
            recalculated
        }
    },
    then({
        submitted,
        approval,
        notices,
        noticeUsers,
        noticeText,
        byPreparer,
        byAsker,
        byHr,
        approved,
        holding,
        changed,
        resubmit,
        recalculated
    }) {
        submitted.error == ""
        noticeUsers.includes(state.approver)
        !noticeUsers.includes(state.maker)
        !noticeUsers.includes(state.payroll)
        !noticeText.includes("4846") && !noticeText.includes("Run SAL")
        code(byPreparer) == "SELF_APPROVAL"
        code(byAsker) == "PERMISSION_DENIED"
        code(byHr) == "PERMISSION_DENIED"
        approved.statusId == "PrnApproved"
        holding.approvalHolds == true
        holding.steps.approved == true
        changed.approvalHolds == false
        changed.run.state == "stale"
        changed.employments.length == 1
        changed.employments[0].partyRelationshipId == state.HRLEmp
        code(resubmit) == "NOT_IN_REVIEW"
        recalculated.processedCount == 1
        recalculated.statusId == "PrnReview"
        money(unitOf(state.HRLEmp).grossAmount) == "280.00"
    }
})

feature("a second regular run over the period's consumed inputs is refused, and an employee is excluded only with a reason", {
    when() {
        const second = run(state.payroll, S + "create#Run", {payrollGroupId: state.group, timePeriodId: state.march})
        const noReason = run(state.payroll, S + "select#Employments", {payrollRunId: state.runId, excludeIds: state.PCEEmp})
        const excluded = run(state.payroll, S + "select#Employments", {
            payrollRunId: state.runId,
            excludeIds: state.PCEEmp,
            exclusionReason: "Paid by hand this month"
        })
        const found = run(state.payroll, S + "get#Run", {payrollRunId: state.runId})
        return {second, noReason, excluded, found}
    },
    then({second, noReason, excluded, found}) {
        code(second) == "INPUTS_CONSUMED"
        code(noReason) == "REASON_REQUIRED"
        excluded.excludedCount == 1
        unitOf(state.PCEEmp).statusId == "PruExcluded"
        rows(INPUT, {partyRelationshipId: state.PCEEmp}).every(row => row.payrollRunId == null)
        found.counts.excluded == 1
        found.employments.find(row => row.partyRelationshipId == state.PCEEmp).exclusionReason == "Paid by hand this month"
    }
})
