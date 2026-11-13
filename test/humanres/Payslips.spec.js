// People's payslips (mantle.humanres.PayrollResultServices find#Payslips, get#Payslip, get#MyPayslip, issue#Payslip;
// PayrollRunServices create#Correction and the off-cycle run; IronStone People design §8.1 Payslip, §8.2 corrections, Payslips,
// PayslipDetail, §15; PE-10; impl-people P26): an approved run's results become preview slips, payroll's alone and never issued;
// an off-cycle slip of the same pay date keeps its own identity; a correction is a new slip linked to the original, which stays,
// with the net effect; the person reads their own issued slips alone (a line kept off the payslip left out of their view), told
// on PayslipIssued with no amount; the legacy pay history is read by its own key, never recalculated. With P25 review's
// carry-overs: a payroll approver employed in the group does not approve a run holding their own pay, and calculating an approved
// run with nothing changed keeps its approval. No invoice or payment is made. Standalone: spec-local organizations, people,
// employments, pay configuration (published as data), salaries, inputs and users; a final slip is made as data where P27's
// finalization would make it. Run: ./moq test mr-mantle --spec Payslips
const prefix = "PAYSLIP_SPEC"
const orgA = prefix + "_A",
    orgB = prefix + "_B",
    since = "2001-01-01T00:00:00Z",
    payFrom = "2026-01-01T00:00:00Z"
const R = "mantle.humanres.PayrollRunServices."
const P = "mantle.humanres.PayrollResultServices."
const SLIP = "mantle.humanres.payroll.Payslip"
const ITEM = "mantle.humanres.payroll.PayslipItem"
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
    call("create#mantle.party.Person", {partyId, firstName: "Slip", lastName: kind})
    return partyId
}
const employ = (partyId, organizationPartyId) =>
    call("mantle.humanres.EmploymentServices.create#Employment", {
        fromPartyId: partyId,
        toPartyId: organizationPartyId,
        fromDate: since
    }).partyRelationshipId
// a user of a person (agentOf: the organizations they work for as an agent; an employee needs none)
function account(kind, permissions, partyId, agentOf = []) {
    const id = prefix + "_U_" + kind
    call("create#moqui.security.UserGroup", {userGroupId: id, description: "Payslips " + kind})
    for (const permission of permissions)
        call("create#moqui.security.UserGroupPermission", {userGroupId: id, userPermissionId: permission, fromDate: since})
    for (const organizationPartyId of agentOf)
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
const assign = (partyRelationshipId, partyId) =>
    call("create#mantle.humanres.payroll.PayrollAssignment", {
        partyRelationshipId,
        partyId,
        organizationPartyId: orgA,
        payrollStructureId: prefix + "_SAL",
        payrollGroupId: state.group,
        isPrimary: "Y",
        fromDate: payFrom
    })
const salary = (partyRelationshipId, amount) =>
    call("create#mantle.humanres.employment.EmploymentSalary", {
        partyRelationshipId,
        fromDate: payFrom,
        amount,
        currencyUomId: "USD",
        timePeriodTypeId: "PayrollYear"
    })
// a run of the group's March made, calculated, asked and approved by the approver
function approvedRun(parameters) {
    const created = run(
        state.payroll,
        R + "create#Run",
        Object.assign({payrollGroupId: state.group, timePeriodId: state.march}, parameters)
    )
    const calculated = run(state.payroll, R + "calculate#Run", {payrollRunId: created.payrollRunId})
    const submitted = run(state.payroll, R + "submit#Run", {payrollRunId: created.payrollRunId})
    const approved = run(state.approver, R + "approve#Run", {payrollRunId: created.payrollRunId})
    return {created, calculated, submitted, approved, payrollRunId: created.payrollRunId}
}
const slipOf = (payrollRunId, partyRelationshipId) => one(SLIP, {payrollRunId, partyRelationshipId})
const lineOf = (payslipId, componentCode) => one(ITEM, {payslipId, componentCode})

spec({
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        organization(orgA, "Payslips Spec A")
        organization(orgB, "Payslips Spec B")
        state.SAL = person("SAL")
        state.SALEmp = employ(state.SAL, orgA)
        state.OTHER = person("OTHER")
        state.OTHEREmp = employ(state.OTHER, orgA)
        // a payroll approver who is also an employee paid by the group
        state.APR = person("APR")
        state.APREmp = employ(state.APR, orgA)
        state.payroll = account("PAYROLL", ["PAYROLL_VIEW", "PAYROLL_EDIT"], person("USER_PAYROLL"), [orgA])
        state.approver = account("APPROVER", ["PAYROLL_VIEW", "PAYROLL_APPROVE"], person("USER_APPROVER"), [orgA])
        state.employedApprover = account("APR", ["PAYROLL_VIEW", "PAYROLL_APPROVE", "PEOPLE_SELF_SERVICE"], state.APR)
        state.payrollB = account("PAYROLLB", ["PAYROLL_VIEW", "PAYROLL_EDIT"], person("USER_PAYROLLB"), [orgB])
        state.hr = account("HR", ["PEOPLE_HR_VIEW", "PEOPLE_HR_EDIT"], person("USER_HR"), [orgA])
        state.employee = account("SAL", ["PEOPLE_SELF_SERVICE"], state.SAL)
        state.other = account("OTHER", ["PEOPLE_SELF_SERVICE"], state.OTHER)
        state.group = prefix + "_MONTHLY"
        call("create#mantle.humanres.payroll.PayrollGroup", {
            payrollGroupId: state.group,
            organizationPartyId: orgA,
            groupName: "Payslip spec monthly",
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
        state.bonus = component("BONUS", "PckEarning", {amount: "0"})
        // an employer contribution its term keeps off the person's payslip (still in the employer cost)
        const fund = component("FUND", "PckContribution", {amount: "50", payslipVisible: "N"})
        call("create#mantle.humanres.payroll.PayrollStructure", {
            payrollStructureId: prefix + "_SAL",
            organizationPartyId: orgA,
            structureName: "Payslip spec salaried",
            currencyUomId: "USD",
            payBasisEnumId: "PpbSalaried",
            statusId: "PtsPublished",
            fromDate: "2000-01-01T00:00:00Z"
        })
        ;[salaryC, state.bonus, fund].forEach((payrollComponentId, index) =>
            call("create#mantle.humanres.payroll.PayrollStructureComponent", {
                payrollStructureId: prefix + "_SAL",
                payrollComponentId,
                statusId: "PtsPublished",
                fromDate: "2000-01-01T00:00:00Z",
                sequenceNum: index + 1
            })
        )
        assign(state.SALEmp, state.SAL)
        assign(state.OTHEREmp, state.OTHER)
        assign(state.APREmp, state.APR)
        salary(state.SALEmp, "60000")
        salary(state.OTHEREmp, "48000")
        salary(state.APREmp, "36000")
        // the legacy pay history of Sal's employment, read by its own key (F71: no demo data makes one)
        call("create#mantle.humanres.employment.EmploymentPayHistory", {
            partyRelationshipId: state.SALEmp,
            payDate: "2025-12-31",
            payAmount: "4500",
            netPayAmount: "3600",
            taxableYtdIncome: "54000",
            currencyUomId: "USD"
        })
        call("create#mantle.humanres.employment.EmploymentPayDetail", {
            partyRelationshipId: state.SALEmp,
            payDate: "2025-12-31",
            amount: "4500",
            quantity: "1"
        })
        state.invoicesBefore = rows("mantle.account.invoice.Invoice", {toPartyId: orgA}).length
        state.historiesBefore = rows("mantle.humanres.employment.EmploymentPayHistory", {
            partyRelationshipId: state.SALEmp
        }).length
    },
    cleanupSpec() {
        ec.message.clearErrors()
        login("john.doe")
    }
})

feature("an approved run's results become preview slips, payroll's alone, never issued; nobody paid by the run approves it", {
    when() {
        const created = run(state.payroll, R + "create#Run", {payrollGroupId: state.group, timePeriodId: state.march})
        state.regular = created.payrollRunId
        const calculated = run(state.payroll, R + "calculate#Run", {payrollRunId: state.regular})
        const submitted = run(state.payroll, R + "submit#Run", {payrollRunId: state.regular})
        const notices = rows("moqui.security.user.NotificationMessage", {topic: "PayrollRunApproval", recordId: state.regular})
        const noticeUsers = notices.flatMap(notice =>
            rows("moqui.security.user.NotificationMessageUser", {notificationMessageId: notice.notificationMessageId}).map(
                row => row.userId
            )
        )
        const byEmployed = run(state.employedApprover, R + "approve#Run", {payrollRunId: state.regular})
        const approved = run(state.approver, R + "approve#Run", {payrollRunId: state.regular})
        const slip = slipOf(state.regular, state.SALEmp)
        state.slipA = slip?.payslipId
        const listed = run(state.payroll, P + "find#Payslips", {payrollRunId: state.regular})
        const detail = run(state.payroll, P + "get#Payslip", {payslipId: state.slipA})
        const mine = run(state.employee, P + "find#Payslips", {})
        const ownPreview = run(state.employee, P + "get#Payslip", {payslipId: state.slipA})
        const issuePreview = run(state.payroll, P + "issue#Payslip", {payslipId: state.slipA})
        const otherEmployer = run(state.payrollB, P + "get#Payslip", {payslipId: state.slipA})
        // P25 review's finding: calculating an approved run with nothing changed keeps its approval
        const recalculated = run(state.payroll, R + "calculate#Run", {payrollRunId: state.regular})
        const after = run(state.payroll, R + "get#Run", {payrollRunId: state.regular})
        return {
            calculated,
            submitted,
            noticeUsers,
            byEmployed,
            approved,
            slip,
            listed,
            detail,
            mine,
            ownPreview,
            issuePreview,
            otherEmployer,
            recalculated,
            after
        }
    },
    then({
        calculated,
        submitted,
        noticeUsers,
        byEmployed,
        approved,
        slip,
        listed,
        detail,
        mine,
        ownPreview,
        issuePreview,
        otherEmployer,
        recalculated,
        after
    }) {
        calculated.calculatedCount == 3
        submitted.error == ""
        noticeUsers.includes(state.approver)
        !noticeUsers.includes(state.employedApprover)
        code(byEmployed) == "SELF_APPROVAL"
        approved.statusId == "PrnApproved"
        slip.statusId == "PssPreview"
        slip.isPreview == "Y"
        slip.runKindEnumId == "PrkRegular"
        // 5,000.00 a month; the demonstration levy 2% of earnings (100) and 1% from the employer (50); the employer fund 50
        money(slip.grossAmount) == "5000.00"
        money(slip.netAmount) == "4900.00"
        money(slip.employerCostAmount) == "5100.00"
        listed.payslips.length == 3
        detail.payslip.state == "preview"
        detail.items.some(
            item =>
                item.componentCode == "SALARY" &&
                item.explanation.includes("annualSalary") &&
                item.ruleText.startsWith("Rule from")
        )
        detail.items.some(item => item.componentCode == "FUND" && item.hiddenFromPerson)
        detail.yearToDate.basisText.includes("preview")
        detail.canIssue == false
        detail.canCorrect == true
        mine.payslips.length == 0
        code(ownPreview) == "RECORD_UNAVAILABLE"
        code(issuePreview) == "PREVIEW_ONLY"
        code(otherEmployer) == "RECORD_UNAVAILABLE"
        recalculated.processedCount == 0
        recalculated.statusId == "PrnApproved"
        after.approvalHolds == true
        one(SLIP, {payslipId: state.slipA}).statusId == "PssPreview"
        rows("mantle.account.invoice.Invoice", {toPartyId: orgA}).length == state.invoicesBefore
    }
})

feature("an off-cycle slip on the same pay date keeps its own identity", {
    when() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        state.bonusInput = call("create#" + INPUT, {
            partyRelationshipId: state.SALEmp,
            partyId: state.SAL,
            organizationPartyId: orgA,
            payrollGroupId: state.group,
            timePeriodId: state.march,
            statusId: "PinApproved",
            inputTypeEnumId: "PitAdjustment",
            payrollComponentId: state.bonus,
            inputDate: "2026-03-20",
            amount: "300",
            currencyUomId: "USD",
            isAdjustment: "Y",
            entitlementKey: prefix + "_BONUS",
            activeEntitlementKey: prefix + "_BONUS"
        }).payrollInputId
        const offCycle = approvedRun({runKindEnumId: "PrkOffCycle", payDate: "2026-03-31"})
        state.offCycle = offCycle.payrollRunId
        const slip = slipOf(state.offCycle, state.SALEmp)
        state.slipB = slip?.payslipId
        const regular = run(state.payroll, R + "get#Run", {payrollRunId: state.regular})
        const nothingLeft = run(state.payroll, R + "create#Run", {
            payrollGroupId: state.group,
            timePeriodId: state.march,
            runKindEnumId: "PrkOffCycle"
        })
        return {offCycle, slip, regular, nothingLeft}
    },
    then({offCycle, slip, regular, nothingLeft}) {
        offCycle.created.selectedCount == 1
        offCycle.calculated.calculatedCount == 1
        offCycle.approved.statusId == "PrnApproved"
        slip.payslipId != state.slipA
        slip.partyRelationshipId == state.SALEmp
        slip.payDate == one(SLIP, {payslipId: state.slipA}).payDate
        slip.runKindEnumId == "PrkOffCycle"
        // the bonus alone, no salary line; the levy 2% of it
        money(lineOf(state.slipB, "BONUS").amount) == "300.00"
        lineOf(state.slipB, "SALARY") == null
        money(slip.netAmount) == "294.00"
        one(INPUT, {payrollInputId: state.bonusInput}).payrollRunId == state.offCycle
        // the regular run, whose calculation the bonus is no part of, still holds
        regular.approvalHolds == true
        code(nothingLeft) == "NOTHING_TO_PAY"
    }
})

feature("a correction is a new slip linked to the original, which stays, with the net effect", {
    when() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        // Sal's salary was recorded wrong: 72,000 a year (a data fix here; a pay change's approval is its own spec's)
        const salaryRow = rows("mantle.humanres.employment.EmploymentSalary", {partyRelationshipId: state.SALEmp})[0]
        call("update#mantle.humanres.employment.EmploymentSalary", {
            partyRelationshipId: state.SALEmp,
            fromDate: salaryRow.fromDate,
            amount: "72000"
        })
        const originalBefore = rows(ITEM, {payslipId: state.slipA})
            .map(row => row.componentCode + "=" + money(row.amount))
            .sort()
            .join(",")
        const staleOriginal = run(state.payroll, P + "get#Payslip", {payslipId: state.slipA})
        const noReason = run(state.payroll, R + "create#Correction", {payslipId: state.slipA})
        const byHr = run(state.hr, R + "create#Correction", {payslipId: state.slipA, reason: "Salary recorded wrong"})
        const byOther = run(state.payrollB, R + "create#Correction", {payslipId: state.slipA, reason: "Salary recorded wrong"})
        const created = run(state.payroll, R + "create#Correction", {payslipId: state.slipA, reason: "Salary recorded wrong"})
        state.correction = created.payrollRunId
        const twice = run(state.payroll, R + "create#Correction", {payslipId: state.slipA, reason: "Again"})
        run(state.payroll, R + "calculate#Run", {payrollRunId: state.correction})
        run(state.payroll, R + "submit#Run", {payrollRunId: state.correction})
        const approved = run(state.approver, R + "approve#Run", {payrollRunId: state.correction})
        const slip = slipOf(state.correction, state.SALEmp)
        state.slipC = slip?.payslipId
        const originalAfter = rows(ITEM, {payslipId: state.slipA})
            .map(row => row.componentCode + "=" + money(row.amount))
            .sort()
            .join(",")
        const original = run(state.payroll, P + "get#Payslip", {payslipId: state.slipA})
        const correction = run(state.payroll, P + "get#Payslip", {payslipId: state.slipC})
        const corrections = run(state.payroll, P + "find#Payslips", {show: "corrections"})
        return {
            originalBefore,
            staleOriginal,
            noReason,
            byHr,
            byOther,
            created,
            twice,
            approved,
            slip,
            originalAfter,
            original,
            correction,
            corrections
        }
    },
    then({
        originalBefore,
        staleOriginal,
        noReason,
        byHr,
        byOther,
        created,
        twice,
        approved,
        slip,
        originalAfter,
        original,
        correction,
        corrections
    }) {
        staleOriginal.payslip.state == "stale"
        code(noReason) == "REASON_REQUIRED"
        code(byHr) == "PERMISSION_DENIED"
        code(byOther) == "RECORD_UNAVAILABLE"
        created.originalPayslipId == state.slipA
        code(twice) == "CORRECTION_EXISTS"
        approved.statusId == "PrnApproved"
        slip.payslipId != state.slipA
        slip.correctsPayslipId == state.slipA
        slip.runKindEnumId == "PrkCorrection"
        slip.statusId == "PssPreview"
        // the change alone: 1,000 more salary, 20 more levy; the bonus paid off-cycle is no part of it
        money(lineOf(state.slipC, "SALARY").amount) == "1000.00"
        money(lineOf(state.slipC, "SALARY").previousAmount) == "5000.00"
        lineOf(state.slipC, "BONUS") == null
        money(slip.netAmount) == "980.00"
        // the original stays as it was
        originalAfter == originalBefore
        one(SLIP, {payslipId: state.slipA}).statusId == "PssPreview"
        money(one(SLIP, {payslipId: state.slipA}).netAmount) == "4900.00"
        original.corrections.chain.length == 2
        original.corrections.netEffectText.includes("5,880.00")
        correction.payslip.correctsPayslipId == state.slipA
        correction.payslip.correctionReason == "Salary recorded wrong"
        correction.items.find(item => item.componentCode == "SALARY").nowText.includes("6,000.00")
        corrections.payslips.some(row => row.payslipId == state.slipC)
        rows("mantle.account.invoice.Invoice", {toPartyId: orgA}).length == state.invoicesBefore
    }
})

feature("the person reads their own issued slips alone, told with no amount; the legacy history is read by its own key", {
    when() {
        // the original made final as P27's finalization would (preview mode makes none)
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        // (a value written directly: the status flow has no preview-to-final step, finalization makes its own final slips)
        ec.entity
            .find(SLIP)
            .condition("payslipId", state.slipA)
            .disableAuthz()
            .one()
            .setAll({statusId: "PssFinal", isPreview: "N"})
            .update()
        const beforeIssue = run(state.employee, P + "find#Payslips", {})
        const myBefore = run(state.employee, P + "get#MyPayslip", {})
        const byHr = run(state.hr, P + "issue#Payslip", {payslipId: state.slipA})
        const issued = run(state.payroll, P + "issue#Payslip", {payslipId: state.slipA})
        const again = run(state.payroll, P + "issue#Payslip", {payslipId: state.slipA})
        const notices = rows("moqui.security.user.NotificationMessage", {topic: "PayslipIssued", recordId: state.slipA})
        const noticeUsers = notices.flatMap(notice =>
            rows("moqui.security.user.NotificationMessageUser", {notificationMessageId: notice.notificationMessageId}).map(
                row => row.userId
            )
        )
        const noticeText = notices.map(notice => notice.messageJson || "").join(" ")
        const mine = run(state.employee, P + "find#Payslips", {partyId: state.OTHER})
        const own = run(state.employee, P + "get#Payslip", {payslipId: state.slipA})
        const ownOffCycle = run(state.employee, P + "get#Payslip", {payslipId: state.slipB})
        const latest = run(state.employee, P + "get#MyPayslip", {forTool: true})
        const byOther = run(state.other, P + "get#Payslip", {payslipId: state.slipA})
        // a payroll reader with self-service of their own reads only their own slip through the self-only service
        const payrollAsSelf = run(state.employedApprover, P + "get#MyPayslip", {payslipId: state.slipA})
        const history = run(state.payroll, P + "find#Payslips", {partyRelationshipId: state.SALEmp})
        const legacyKey = history.payslips?.find(row => row.historical)?.legacyKey
        const legacy = run(state.payroll, P + "get#Payslip", {legacyKey})
        const legacyAsSelf = run(state.employee, P + "get#Payslip", {legacyKey})
        return {
            beforeIssue,
            myBefore,
            byHr,
            issued,
            again,
            noticeUsers,
            noticeText,
            mine,
            own,
            ownOffCycle,
            latest,
            byOther,
            payrollAsSelf,
            history,
            legacy,
            legacyAsSelf
        }
    },
    then({
        beforeIssue,
        myBefore,
        byHr,
        issued,
        again,
        noticeUsers,
        noticeText,
        mine,
        own,
        ownOffCycle,
        latest,
        byOther,
        payrollAsSelf,
        history,
        legacy,
        legacyAsSelf
    }) {
        beforeIssue.payslips.length == 0
        code(myBefore) == "RECORD_UNAVAILABLE"
        code(byHr) == "PERMISSION_DENIED"
        issued.statusId == "PssIssued"
        again.repeated == true
        one(SLIP, {payslipId: state.slipA}).contentLocation != null
        noticeUsers.length == 1
        noticeUsers[0] == state.employee
        noticeText.includes("Payslips Spec A") && !noticeText.includes("4900") && !noticeText.includes("4,900")
        // their own issued slip alone: not the off-cycle or correction previews, not another person's whatever they ask
        mine.payslips.length == 1
        mine.payslips[0].payslipId == state.slipA
        own.payslip.payslipId == state.slipA
        own.payslip.payrollRunId == null
        own.items.some(item => item.componentCode == "SALARY")
        !own.items.some(item => item.componentCode == "FUND")
        own.totalsText.employerCost.includes("5,100.00")
        own.yearToDate.basisText.includes("this slip included")
        own.corrections.chain.length == 1
        code(ownOffCycle) == "RECORD_UNAVAILABLE"
        latest.payslip.payslipId == state.slipA
        latest.file == null
        code(byOther) == "RECORD_UNAVAILABLE"
        code(payrollAsSelf) == "RECORD_UNAVAILABLE"
        history.payslips.some(row => row.historical && row.netText.includes("3,600.00"))
        legacy.payslip.historical == true
        legacy.totalsText.taxableYearToDate.includes("54,000.00")
        code(legacyAsSelf) == "RECORD_UNAVAILABLE"
        rows("mantle.humanres.employment.EmploymentPayHistory", {partyRelationshipId: state.SALEmp}).length ==
            state.historiesBefore
    }
})
