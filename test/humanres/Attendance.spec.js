// People's attendance (mantle.humanres.AttendanceServices; impl-people P13, design-people §6 Attendance and TimeImport, PE-05,
// PE-19): a device file imported twice records its rows once (a duplicate source key ignored, a row repeated in the file skipped)
// and names the bad row; a day with an in-punch and no out is flagged; an overnight shift counts on the day it started; a
// correction asked by the person and approved by their manager is the day's attendance and keeps the raw punches, the person may
// not approve it and another employer's HR does not read it; the self-service clock records the session's own employment only
// where clocking is on, refuses clocking in twice and answers a retry with the first punch; an import needs PEOPLE_IMPORT.
// Standalone: spec-local organizations, people, employments, groups and users, with artifact authorization disabled (the rules are
// the services' own checks). Days of March 2026 (Monday the 2nd) in America/Chicago.
// Run: ./moq test mr-mantle --spec Attendance
const prefix = "PEOPLE_ATT_SPEC"
const orgA = prefix + "_A",
    orgB = prefix + "_B",
    since = "2001-01-01T00:00:00Z",
    zone = "America/Chicago"
const A = "mantle.humanres.AttendanceServices."
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
    call("create#mantle.party.Person", {partyId, firstName: "Attendance", lastName: kind})
    return partyId
}
const employ = (partyId, organizationPartyId) =>
    call("mantle.humanres.EmploymentServices.create#Employment", {
        fromPartyId: partyId,
        toPartyId: organizationPartyId,
        fromDate: since
    }).partyRelationshipId
function user(kind, permissions, partyId) {
    const id = prefix + "_U_" + kind
    call("create#moqui.security.UserGroup", {userGroupId: id, description: "People attendance " + kind})
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
const days = conditions =>
    Array.from(ec.entity.find("mantle.humanres.attendance.AttendanceDay").condition(conditions).disableAuthz().list())
const punchCount = conditions =>
    ec.entity.find("mantle.humanres.attendance.AttendancePunch").condition(conditions).disableAuthz().count()
const header = "worker,time,direction,id,device\n"
const file = lines => header + lines.join("\n") + "\n"
const importOf = (text, username = state.hr, extra = {}) =>
    run(
        username,
        A + "preview#Import",
        Object.assign(
            {organizationPartyId: orgA, importText: text, fileName: "door.csv", sourceSystem: "Front door", timeZone: zone},
            extra
        )
    )

spec({
    stepwise: true,
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        organization(orgA, "People Attendance Spec A")
        organization(orgB, "People Attendance Spec B")
        // Ana and Bob work for A, managed by Max; Carl works nights at A; HR of A and of B
        state.ana = person("ANA")
        state.anaEmp = employ(state.ana, orgA)
        state.bob = person("BOB")
        state.bobEmp = employ(state.bob, orgA)
        state.carl = person("CARL")
        state.carlEmp = employ(state.carl, orgA)
        state.max = person("MAX")
        employ(state.max, orgA)
        for (const report of [state.ana, state.bob])
            call("create#mantle.party.PartyRelationship", {
                relationshipTypeEnumId: "PrtManager",
                fromPartyId: state.max,
                toPartyId: report,
                fromDate: since
            })
        state.hrParty = person("HR")
        employ(state.hrParty, orgA)
        state.hrBParty = person("HRB")
        employ(state.hrBParty, orgB)
        state.uAna = user("ANA", ["PEOPLE_SELF_SERVICE"], state.ana)
        // Bob decides others' requests too, so his own correction is refused as his own, not for the permission
        state.uBob = user("BOB", ["PEOPLE_SELF_SERVICE", "PEOPLE_REQUEST_APPROVE"], state.bob)
        state.uMgr = user("MAX", ["PEOPLE_SELF_SERVICE", "PEOPLE_TEAM_VIEW", "PEOPLE_REQUEST_APPROVE"], state.max)
        state.hr = user("HR", ["PEOPLE_HR_VIEW", "PEOPLE_HR_EDIT", "PEOPLE_IMPORT"], state.hrParty)
        // HR of A without the import permission, and HR of B with it
        state.hrNoImport = user("HRN", ["PEOPLE_HR_VIEW", "PEOPLE_HR_EDIT"], state.hrParty)
        state.hrB = user("HRB", ["PEOPLE_HR_VIEW", "PEOPLE_HR_EDIT", "PEOPLE_IMPORT"], state.hrBParty)
    },
    cleanupSpec() {
        ec.message.clearErrors()
        login("john.doe")
    }
})

feature("a device file imported twice records its rows once and names the bad one; an in-punch with no out is flagged", {
    when() {
        const text = file([
            state.ana + ",2026-03-02 08:00,in,E1,door",
            state.ana + ",2026-03-02 16:30,out,E2,door",
            state.bob + ",2026-03-03 08:00,in,E3,door",
            "NOBODY,2026-03-03 08:05,in,E4,door",
            state.ana + ",2026-03-02 08:00,in,E1,door",
            state.carl + ",2026-03-03 07:00,sideways,E5,door"
        ])
        const preview = importOf(text)
        const imported = run(state.hr, A + "import#Records", {attendanceImportId: preview.attendanceImportId})
        const again = run(state.hr, A + "import#Records", {attendanceImportId: preview.attendanceImportId})
        const rows = run(state.hr, A + "get#Import", {attendanceImportId: preview.attendanceImportId, outcome: "problems"}).rows
        // the same file once more: everything known, nothing added
        const second = importOf(text)
        const secondImported = run(state.hr, A + "import#Records", {attendanceImportId: second.attendanceImportId})
        const found = run(state.hr, A + "find#Attendance", {fromDate: "2026-03-02", thruDate: "2026-03-03"})
        const exceptions = run(state.hr, A + "find#Attendance", {
            fromDate: "2026-03-02",
            thruDate: "2026-03-03",
            exceptionsOnly: true
        })
        const runs = run(state.hr, A + "find#ImportRuns", {targetId: "timeAndAttendance"}).runList
        return {preview, imported, again, rows, second, secondImported, found, exceptions, runs}
    },
    then({preview, imported, again, rows, second, secondImported, found, exceptions, runs}) {
        preview.error == "" && preview.rowCount == 6 && preview.readyCount == 3
        // the repeated E1 is skipped, the unknown worker and the bad direction refused
        preview.skippedCount == 1 && preview.errorCount == 2
        imported.importedCount == 3 && imported.errorCount == 2 && !imported.repeated
        again.repeated && again.importedCount == 3
        rows
            .map(row => row.reasonCode)
            .sort()
            .join(",") == "DIRECTION_INVALID,WORKER_UNKNOWN"
        rows.find(row => row.reasonCode == "WORKER_UNKNOWN").lineNumber == 5
        second.readyCount == 0 && second.skippedCount == 4 && secondImported.importedCount == 0
        punchCount({organizationPartyId: orgA}) == 3
        const ana = found.days.find(row => row.partyId == state.ana)
        ana.attendanceDate == "2026-03-02" && ana.workedText == "8:30" && ana.flags.length == 0
        ana.firstInText == "08:00" && ana.lastOutText == "16:30"
        const bob = found.days.find(row => row.partyId == state.bob)
        bob.flagsText == "Missing out-punch" && bob.exception
        exceptions.days.map(row => row.partyId).join(",") == state.bob
        runs.length == 2 && runs.some(row => row.ownerParameters.attendanceImportId == second.attendanceImportId)
        runs.some(row => row.appliedCount == 3 && row.errorCount == 2 && row.state == "complete")
    }
})

feature("an overnight shift counts on the day it started, its out-punch the next morning", {
    when() {
        const preview = importOf(
            file([state.carl + ",2026-03-06 22:00,in,N1,door", state.carl + ",2026-03-07 06:15,out,N2,door"]),
            state.hr
        )
        const imported = run(state.hr, A + "import#Records", {attendanceImportId: preview.attendanceImportId})
        return {imported, carlDays: days({partyRelationshipId: state.carlEmp})}
    },
    then({imported, carlDays}) {
        imported.importedCount == 2
        carlDays.length == 1
        Number(carlDays[0].attendanceDate) == Date.UTC(2026, 2, 6) && Number(carlDays[0].workedMinutes) == 495
        !carlDays[0].flagsText && Number(carlDays[0].punchCount) == 2
    }
})

feature("a correction asked by the person and approved by their manager is the day's attendance and keeps the raw punches", {
    when() {
        const day = days({partyRelationshipId: state.bobEmp})[0]
        const noReason = run(state.uBob, A + "request#Correction", {
            attendanceDayId: day.attendanceDayId,
            fromTime: "08:00",
            thruTime: "16:00"
        })
        const asked = run(state.uBob, A + "request#Correction", {
            attendanceDayId: day.attendanceDayId,
            fromTime: "08:00",
            thruTime: "12:00",
            fromTime2: "12:30",
            thruTime2: "16:00",
            reason: "Forgot to clock out",
            operationKey: prefix + "_CORR"
        })
        const retried = run(state.uBob, A + "request#Correction", {
            attendanceDayId: day.attendanceDayId,
            fromTime: "08:00",
            thruTime: "16:00",
            reason: "Again",
            operationKey: prefix + "_CORR"
        })
        const second = run(state.uMgr, A + "request#Correction", {
            attendanceDayId: day.attendanceDayId,
            fromTime: "08:00",
            thruTime: "16:00",
            reason: "Another"
        })
        const own = run(state.uBob, A + "decide#Correction", {attendanceCorrectionId: asked.attendanceCorrectionId})
        const outsider = run(state.hrB, A + "get#Day", {attendanceDayId: day.attendanceDayId})
        const outsiderDecides = run(state.hrB, A + "decide#Correction", {attendanceCorrectionId: asked.attendanceCorrectionId})
        const toDecide = run(state.uMgr, A + "find#Attendance", {toDecide: true}).days
        const refusedNoReason = run(state.uMgr, A + "decide#Correction", {
            attendanceCorrectionId: asked.attendanceCorrectionId,
            decision: "refuse"
        })
        const approved = run(state.uMgr, A + "decide#Correction", {attendanceCorrectionId: asked.attendanceCorrectionId})
        const read = run(state.uBob, A + "get#Day", {attendanceDayId: day.attendanceDayId})
        return {day, noReason, asked, retried, second, own, outsider, outsiderDecides, toDecide, refusedNoReason, approved, read}
    },
    then({day, noReason, asked, retried, second, own, outsider, outsiderDecides, toDecide, refusedNoReason, approved, read}) {
        code(noReason) == "REASON_REQUIRED"
        asked.error == "" && asked.statusEnumId == "AcsRequested"
        retried.repeated && retried.attendanceCorrectionId == asked.attendanceCorrectionId
        code(second) == "CORRECTION_PENDING"
        code(own) == "SELF_APPROVAL"
        code(outsider) == "RECORD_UNAVAILABLE" && code(outsiderDecides) == "RECORD_UNAVAILABLE"
        toDecide.length == 1 && toDecide[0].attendanceDayId == day.attendanceDayId && toDecide[0].toDecide
        code(refusedNoReason) == "REASON_REQUIRED"
        approved.statusEnumId == "AcsApproved"
        read.day.statusEnumId == "AdsCorrected" && read.day.workedText == "7:30" && read.day.flags.length == 0
        // the raw punch is kept as it came
        read.punches.length == 1 && read.punches[0].directionText == "In" && read.punches[0].externalKey == "E3"
        read.corrections[0].intervalsText == "08:00 to 12:00, 12:30 to 16:00" && read.corrections[0].statusText == "Approved"
        punchCount({partyRelationshipId: state.bobEmp}) == 1
    }
})

feature("the self-service clock records the session's own employment where clocking is on, once per state and per retry", {
    when() {
        const off = run(state.uAna, A + "record#Punch", {})
        const notHrs = run(state.uMgr, A + "store#Clocking", {partyRelationshipId: state.anaEmp, clockingEnabled: "Y"})
        const turnedOn = run(state.hr, A + "store#Clocking", {
            partyRelationshipId: state.anaEmp,
            clockingEnabled: "Y",
            reason: "Store floor"
        })
        const othersEmployment = run(state.uAna, A + "record#Punch", {partyRelationshipId: state.bobEmp})
        const clockIn = run(state.uAna, A + "record#Punch", {operationKey: prefix + "_IN"})
        const retry = run(state.uAna, A + "record#Punch", {operationKey: prefix + "_IN"})
        const twice = run(state.uAna, A + "record#Punch", {directionEnumId: "AtdIn"})
        const clock = run(state.uAna, A + "get#MyClock", {})
        const clockOut = run(state.uAna, A + "record#Punch", {})
        const outAgain = run(state.uAna, A + "record#Punch", {directionEnumId: "AtdOut"})
        const after = run(state.uAna, A + "get#MyClock", {})
        return {off, notHrs, turnedOn, othersEmployment, clockIn, retry, twice, clock, clockOut, outAgain, after}
    },
    then({off, notHrs, turnedOn, othersEmployment, clockIn, retry, twice, clock, clockOut, outAgain, after}) {
        code(off) == "CLOCKING_OFF"
        code(notHrs) == "RECORD_UNAVAILABLE" && turnedOn.error == "" && turnedOn.changed
        code(othersEmployment) == "RECORD_UNAVAILABLE"
        clockIn.directionEnumId == "AtdIn" && !clockIn.repeated
        retry.repeated && retry.attendancePunchId == clockIn.attendancePunchId
        code(twice) == "ALREADY_IN"
        clock.clocking && clock.employments[0].clockedIn && clock.employments[0].actionText == "Clock out"
        clockOut.directionEnumId == "AtdOut" && code(outAgain) == "NOT_IN"
        !after.employments[0].clockedIn && after.employments[0].actionText == "Clock in"
        punchCount({partyRelationshipId: state.anaEmp, sourceEnumId: "AtsSelf"}) == 2
    }
})

feature("an import needs PEOPLE_IMPORT and the employer: HR without it and another employer's HR are refused", {
    when() {
        const text = file([state.ana + ",2026-03-09 08:00,in,P1,door"])
        return {
            allowed: importOf(text),
            noImport: importOf(text, state.hrNoImport),
            otherEmployer: importOf(text, state.hrB),
            otherRuns: run(state.hrB, A + "find#ImportRuns", {targetId: "timeAndAttendance"}).runList
        }
    },
    then({allowed, noImport, otherEmployer, otherRuns}) {
        allowed.error == "" && allowed.readyCount == 1
        code(noImport) == "PERMISSION_DENIED"
        code(otherEmployer) == "ORGANIZATION_DENIED"
        otherRuns.length == 0
    }
})
