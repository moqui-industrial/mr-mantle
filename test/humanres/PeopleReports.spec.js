// People's reports and employer preferences (mantle.humanres.PeopleReportServices get#Options and run#Report, PeopleServices
// get#Settings, store#Settings and get#Readiness; impl-people P29, design-people §12 Reports and Settings, PE-17): headcount is as of
// a date (distinct people at the start and the end of a period, joins and exits counted as employments, turnover over the average
// headcount with its denominator said), another employer is refused by name and the export is the same rows with a cell a
// spreadsheet would read as a formula behind an apostrophe; qualification expiry lists the current employees' verified ones
// expired and not renewed or expiring, never a number; leave balances sum the ledger as of a date, never an entry's description; the payroll register is a payroll reader's alone (an HR reader asking
// for it is refused PERMISSION_DENIED with the same parameters a payroll reader is answered with, and is never offered it); the
// clocking default is changed by an HR editor of the employer, audit-logged with its reason, the case intake handlers by the People
// administrator alone, each an eligible handler, and the setup readiness says when nobody may take a case.
// Standalone: spec-local organizations, people, employments, groups and users, with artifact authorization disabled (the rules are
// the services' own checks).
// Run: ./moq test mr-mantle --spec PeopleReports
const prefix = "PEOPLE_RPT_SPEC"
const orgA = prefix + "_A",
    orgB = prefix + "_B",
    since = "2001-01-01 12:00:00",
    zone = "America/Chicago"
const R = "mantle.humanres.PeopleReportServices."
const S = "mantle.humanres.PeopleServices."
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
function organization(partyId, name) {
    call("create#mantle.party.Party", {partyId, partyTypeEnumId: "PtyOrganization", ownerPartyId: partyId})
    call("create#mantle.party.Organization", {partyId, organizationName: name})
    call("create#mantle.party.PartyRole", {partyId, roleTypeId: "OrgInternal"})
}
function person(kind) {
    const partyId = prefix + "_" + kind
    call("create#mantle.party.Party", {partyId, partyTypeEnumId: "PtyPerson"})
    call("create#mantle.party.Person", {partyId, firstName: "Report", lastName: kind})
    return partyId
}
const employ = (partyId, organizationPartyId, fromDate = since, thruDate = null) =>
    call("mantle.humanres.EmploymentServices.create#Employment", {
        fromPartyId: partyId,
        toPartyId: organizationPartyId,
        fromDate,
        thruDate
    }).partyRelationshipId
function user(kind, permissions, partyId) {
    const id = prefix + "_U_" + kind
    call("create#moqui.security.UserGroup", {userGroupId: id, description: "People reports " + kind})
    for (const permission of permissions)
        call("create#moqui.security.UserGroupPermission", {userGroupId: id, userPermissionId: permission, fromDate: since})
    call("create#moqui.security.UserAccount", {
        userId: id,
        username: id,
        partyId,
        currentPassword: "16ac58bbfa332c1c55bd98b53e60720bfa90d394",
        passwordHashType: "SHA",
        timeZone: zone
    })
    call("create#moqui.security.UserGroupMember", {userId: id, userGroupId: id, fromDate: since})
    return id
}
const headcount = (username, parameters) => run(username, R + "run#Report", Object.assign({reportId: "headcount"}, parameters))

spec({
    stepwise: true,
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        // A's name begins with "=", which a spreadsheet would read as a formula
        organization(orgA, "=People Reports Spec A")
        organization(orgB, "People Reports Spec B")
        // A employs its HR officer, payroll operator, People administrator and case handler since 2001, Ben from 2025 until
        // March 10, Ana from January 15 and Cy from February 1 (Cy at B too); B employs its HR officer and Cy
        for (const kind of ["HR", "PAY", "ADMIN", "CASE", "DIR"]) employ((state[kind] = person(kind)), orgA)
        state.ben = person("BEN")
        employ(state.ben, orgA, "2025-01-01 12:00:00", "2026-03-10 12:00:00")
        state.ana = person("ANA")
        state.anaEmp = employ(state.ana, orgA, "2026-01-15 12:00:00")
        state.cy = person("CY")
        employ(state.cy, orgA, "2026-02-01 12:00:00")
        employ(state.cy, orgB, "2026-02-01 12:00:00")
        employ((state.HRB = person("HRB")), orgB)
        state.hr = user("HR", ["PEOPLE_HR_VIEW", "PEOPLE_HR_EDIT"], state.HR)
        state.pay = user("PAY", ["PAYROLL_VIEW"], state.PAY)
        state.admin = user("ADMIN", ["PEOPLE_CONFIGURE"], state.ADMIN)
        state.caseUser = user("CASE", ["PEOPLE_CASE_HANDLE"], state.CASE)
        state.dir = user("DIR", ["PEOPLE_DIRECTORY_VIEW"], state.DIR)
        state.hrB = user("HRB", ["PEOPLE_HR_VIEW", "PEOPLE_HR_EDIT"], state.HRB)
    }
})

feature("headcount is as of a date, turnover says its denominator, another employer is refused and the export is safe", {
    when() {
        const january = headcount(state.hr, {fromDate: "2026-01-01", thruDate: "2026-02-28"})
        const march = headcount(state.hr, {fromDate: "2026-03-01", thruDate: "2026-03-31", organizationPartyId: orgA})
        const before = headcount(state.hr, {fromDate: "2025-12-01", thruDate: "2025-12-31"})
        const otherEmployer = headcount(state.hr, {organizationPartyId: orgB})
        const exported = headcount(state.hr, {fromDate: "2026-03-01", thruDate: "2026-03-31", format: "csv"})
        const lines = String(exported.csvText || "").split("\r\n")
        return {january, march, before, otherEmployer, exported, lines}
    },
    then({january, march, before, otherEmployer, exported, lines}) {
        january.error == ""
        // by December 31 Ben and the four staff (and the directory reader): 6; by February 28 Ana and Cy joined
        january.totals.startHeadcount == 6
        january.totals.endHeadcount == 8
        january.totals.joinCount == 2
        january.totals.exitCount == 0
        january.rows.length == 1
        january.rows[0].groupName == "=People Reports Spec A"
        // March: Ben left on the 10th, one exit over the average of 8 and 7
        march.totals.startHeadcount == 8
        march.totals.endHeadcount == 7
        march.totals.exitCount == 1
        march.totals.turnoverText == "13.3%"
        march.denominatorText.includes("1 ÷ 7.5")
        // as of the end of 2025, before Ana and Cy were employed
        before.totals.endHeadcount == 6
        before.totals.joinCount == 0
        code(otherEmployer) == "ORGANIZATION_DENIED"
        exported.error == ""
        exported.fileName.startsWith("people-headcount-")
        lines[0] == "Headcount and turnover"
        lines.some(line => line.startsWith("'=People Reports Spec A,8,7,7,0,1,"))
        lines.some(line => line.startsWith("Total,8,7,7,0,1,"))
    }
})

feature("qualification expiry leaves out the renewed and a number; leave balances add up the ledger as of a date", {
    when() {
        const Q = "mantle.humanres.ability.PartyQualification"
        const at = days => new Date(Date.now() + days * 24 * 60 * 60 * 1000)
        const qualification = (id, partyId, thruDays, extra = {}) =>
            call(
                "create#" + Q,
                Object.assign(
                    {
                        partyQualificationId: prefix + "_Q_" + id,
                        partyId,
                        qualificationTypeEnumId: "QualCertification",
                        title: "Spec certificate " + id,
                        referenceNumber: "SECRET-" + id,
                        fromDate: at(-400),
                        thruDate: at(thruDays),
                        verificationStatusId: "QlVerVerified"
                    },
                    extra
                )
            )
        // Ana's expires in 20 days, Ben's (a leaver) too, Cy's expired 10 days ago and was renewed, the HR officer's expired
        // and was not, and one waiting for verification expires tomorrow
        qualification("ANA", state.ana, 20)
        qualification("BEN", state.ben, 20)
        qualification("CY_OLD", state.cy, -10)
        qualification("CY_NEW", state.cy, 700, {renewsQualificationId: prefix + "_Q_CY_OLD"})
        qualification("HR", state.HR, -5)
        qualification("PENDING", state.ADMIN, 1, {verificationStatusId: "QlVerPending"})
        const L = "mantle.humanres.leave.LeaveLedgerEntry"
        const ledger = (id, entryTypeEnumId, amount, effectiveDate) =>
            call("create#" + L, {
                leaveLedgerEntryId: prefix + "_L_" + id,
                partyRelationshipId: state.anaEmp,
                partyId: state.ana,
                organizationPartyId: orgA,
                leaveTypeEnumId: prefix + "_LT",
                unitEnumId: "LuDays",
                entryTypeEnumId,
                amount,
                effectiveDate,
                sourceKey: prefix + "_L_" + id,
                description: "Spec ledger " + id
            })
        call("create#moqui.basic.Enumeration", {
            enumId: prefix + "_LT",
            enumTypeId: "PeopleLeaveType",
            description: "Spec annual leave"
        })
        ledger("GRANT", "LletGrant", 20, "2026-01-15 12:00:00")
        ledger("TAKEN", "LletConsumption", -3, "2026-02-10 12:00:00")
        ledger("LATER", "LletConsumption", -2, "2026-06-10 12:00:00")
        return {
            expiry: run(state.hr, R + "run#Report", {reportId: "qualifications"}),
            leave: run(state.hr, R + "run#Report", {reportId: "leaveBalances", thruDate: "2026-03-31"})
        }
    },
    then({expiry, leave}) {
        expiry.error == ""
        expiry.rows.map(row => row.partyQualificationId + " " + row.stateName) ==
            [prefix + "_Q_HR Expired", prefix + "_Q_ANA Expiring"]
        !JSON.stringify(expiry.rows).includes("SECRET")
        expiry.totals.expiredCount == 1
        leave.error == ""
        leave.rows.length == 1
        leave.rows[0].grantedQuantity == 20
        leave.rows[0].takenQuantity == -3
        leave.rows[0].balanceQuantity == 17
        leave.rows[0].leaveTypeName == "Spec annual leave"
        !JSON.stringify(leave.rows).includes("Spec ledger")
    }
})

feature("the payroll register is a payroll reader's alone", {
    when() {
        const parameters = {reportId: "payrollRegister", fromDate: "2026-01-01", thruDate: "2026-12-31"}
        return {
            hrRegister: run(state.hr, R + "run#Report", parameters),
            payRegister: run(state.pay, R + "run#Report", parameters),
            hrOptions: run(state.hr, R + "get#Options"),
            payOptions: run(state.pay, R + "get#Options"),
            dirOptions: run(state.dir, R + "get#Options")
        }
    },
    then({hrRegister, payRegister, hrOptions, payOptions, dirOptions}) {
        code(hrRegister) == "PERMISSION_DENIED"
        hrRegister.rows == null
        payRegister.error == ""
        payRegister.pay == true
        payRegister.columns.map(column => column.title).includes("Gross")
        hrOptions.reports.map(report => report.reportId) ==
            ["headcount", "recruiting", "attendance", "leaveBalances", "expenses", "qualifications", "reviews"]
        payOptions.reports.map(report => report.reportId) == ["payrollRegister"]
        hrOptions.employers.map(row => row.organizationPartyId) == [orgA]
        code(dirOptions) == "PERMISSION_DENIED"
    }
})

feature("the clocking default is HR's and the administrator's, the case intake the administrator's, each change audited", {
    when() {
        const hrClocking = run(state.hr, S + "store#Settings", {
            organizationPartyId: orgA,
            clocking: "Y",
            reason: "Spec clocking"
        })
        const audit = Array.from(
            ec.entity
                .find("moqui.entity.EntityAuditLog")
                .condition({changedEntityName: "mantle.party.PartySetting", changedFieldName: "settingValue"})
                .condition("pkPrimaryValue", orgA)
                .useCache(false)
                .list()
        ).map(row => row.newValueText + " " + row.changeReason)
        const hrIntake = run(state.hr, S + "store#Settings", {organizationPartyId: orgA, intakeHandlerIds: [state.CASE]})
        const before = run(state.admin, S + "get#Readiness", {organizationPartyId: orgA})
        const ineligible = run(state.admin, S + "store#Settings", {organizationPartyId: orgA, intakeHandlerIds: [state.ben]})
        const settings = run(state.admin, S + "get#Settings", {organizationPartyId: orgA})
        const stale = run(state.admin, S + "store#Settings", {
            organizationPartyId: orgA,
            intakeHandlerIds: [state.CASE],
            expectedRevision: "1"
        })
        const named = run(state.admin, S + "store#Settings", {
            organizationPartyId: orgA,
            intakeHandlerIds: state.CASE,
            expectedRevision: settings.employers?.[0]?.revision
        })
        const after = run(state.admin, S + "get#Readiness", {organizationPartyId: orgA})
        const otherEmployer = run(state.hr, S + "store#Settings", {organizationPartyId: orgB, clocking: "Y"})
        const hrSettings = run(state.hr, S + "get#Settings", {})
        const intakeOf = out => out.checks?.find(check => check.checkKey === "people.caseIntake") || {}
        return {
            hrClocking,
            audit,
            hrIntake,
            before: intakeOf(before),
            ineligible,
            settings,
            stale,
            named,
            after: intakeOf(after),
            otherEmployer,
            hrSettings,
            checks: after.checks || []
        }
    },
    then({hrClocking, audit, hrIntake, before, ineligible, settings, stale, named, after, otherEmployer, hrSettings, checks}) {
        hrClocking.error == ""
        hrClocking.changed == ["PeopleClocking"]
        hrClocking.settings.clocking == "Y"
        audit.includes("Y Spec clocking")
        code(hrIntake) == "PERMISSION_DENIED"
        before.state == "warning"
        before.reasonCode == "NO_CASE_HANDLER"
        // Ben left A, so he cannot take its cases
        code(ineligible) == "HANDLER_NOT_ELIGIBLE"
        settings.employers[0].intakeCandidates.map(row => row.partyId) == [state.CASE]
        code(stale) == "REVISION_STALE"
        named.error == ""
        named.settings.intakeHandlers.map(row => row.name) == ["Report CASE"]
        after.state == "ready"
        code(otherEmployer) == "ORGANIZATION_DENIED"
        // an HR editor reads the clocking default and not the intake handlers
        hrSettings.employers.length == 1
        hrSettings.employers[0].clocking == "Y"
        hrSettings.employers[0].intakeHandlers == null
        // every phase's check is answered for an employer with employees
        checks.map(check => check.checkKey) ==
            [
                "people.departments",
                "people.managers",
                "people.payroll",
                "people.positions",
                "people.approvals",
                "people.checklists",
                "people.schedules",
                "people.leave",
                "people.caseIntake"
            ]
    }
})
