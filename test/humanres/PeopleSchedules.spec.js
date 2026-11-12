// People's working schedules and holiday calendars (mantle.humanres.ScheduleServices; impl-people P9, F23, F31) and the capacity
// that reads them (mantle.work.ResourceServices.get#PartyCapacity, TimesheetServices.get#WeekDays): a schedule's intervals that
// overlap are refused (on one day, across midnight); a person who follows a schedule gets its hours from the date they follow it,
// and one who follows none today's (the timesheet policy's); a holiday of the schedule's calendar takes the day and one of another
// calendar does not, the assignment's calendar replacing the schedule's; a line changed from a date keeps the weeks before it; a
// night shift across a daylight saving change counts its true length on the day it starts; a later change of the employment keeps
// the schedule. HR editors of the employer change and assign; a reader, another employer's HR and a stale revision are refused.
// Standalone: spec-local organizations, people, employments, groups and users, with artifact authorization disabled (the rules
// are the services' own checks). Weeks of 2027. Run: ./moq test mr-mantle --spec PeopleSchedules
const prefix = "PEOPLE_WSCHED_SPEC"
const orgA = prefix + "_A",
    orgB = prefix + "_B",
    since = "2001-01-01T00:00:00Z"
const S = "mantle.humanres.ScheduleServices."
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
function organization(partyId, name) {
    call("create#mantle.party.Party", {partyId, partyTypeEnumId: "PtyOrganization", ownerPartyId: partyId})
    call("create#mantle.party.Organization", {partyId, organizationName: name})
    call("create#mantle.party.PartyRole", {partyId, roleTypeId: "OrgInternal"})
}
function person(kind) {
    const partyId = prefix + "_" + kind
    call("create#mantle.party.Party", {partyId, partyTypeEnumId: "PtyPerson"})
    call("create#mantle.party.Person", {partyId, firstName: "Wsched", lastName: kind})
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
    call("create#moqui.security.UserGroup", {userGroupId: id, description: "People schedules " + kind})
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
        timeZone: "America/Chicago"
    })
    call("create#moqui.security.UserGroupMember", {userId: id, userGroupId: id, fromDate: since})
    return id
}
const revisionOf = workingScheduleId => run(state.hr, S + "get#Schedule", {workingScheduleId}).schedule?.revision
const line = (workingScheduleId, values, username = state.hr) =>
    run(
        username,
        S + "store#ScheduleLine",
        Object.assign({workingScheduleId, expectedRevision: revisionOf(workingScheduleId)}, values)
    )
// a person's capacity by day: {day: [base, capacity, holiday]}, and its source
function capacity(partyId, fromDate, thruDate) {
    const entry = run(state.hr, "mantle.work.ResourceServices.get#PartyCapacity", {partyId, fromDate, thruDate}).capacityList?.[0]
    const days = {}
    for (const row of Array.from(entry?.dayList || []))
        days[row.day] = [Number(row.base), Number(row.capacity), row.holiday || ""]
    return {source: entry?.source, days}
}

spec({
    stepwise: true,
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        organization(orgA, "People Schedules Spec A")
        organization(orgB, "People Schedules Spec B")
        state.ana = person("ANA")
        state.anaEmp = employ(state.ana, orgA)
        state.ben = person("BEN")
        employ(state.ben, orgA)
        state.cal = person("CAL")
        state.calEmp = employ(state.cal, orgA)
        state.mgr = person("MGR")
        employ(state.mgr, orgA)
        call("create#mantle.party.PartyRelationship", {
            relationshipTypeEnumId: "PrtManager",
            fromPartyId: state.mgr,
            toPartyId: state.ana,
            fromDate: since
        })
        state.hr = user("HR", ["PEOPLE_HR_VIEW", "PEOPLE_HR_EDIT"], [orgA])
        state.hrB = user("HRB", ["PEOPLE_HR_VIEW", "PEOPLE_HR_EDIT"], [orgB])
        state.reader = user("READER", ["PEOPLE_DIRECTORY_VIEW"], [orgA])
        state.uMgr = user("MGR", ["PEOPLE_TEAM_VIEW"], [], state.mgr)
    },
    cleanupSpec() {
        ec.message.clearErrors()
        login("john.doe")
    }
})

feature(
    "HR defines a four-day week in another zone and a night shift: overlapping intervals are refused, on a day and across midnight; a reader, another employer's HR and a stale revision are refused",
    {
        when() {
            const out = {}
            const newSchedule = (username, scheduleName, timeZone, organizationPartyId = orgA) =>
                run(username, S + "store#Schedule", {organizationPartyId, scheduleName, timeZone, fromDate: "2027-01-01"})
            out.reader = code(newSchedule(state.reader, "Reader week", "Europe/Berlin"))
            out.hrB = code(newSchedule(state.hrB, "B's week", "Europe/Berlin"))
            out.zone = code(newSchedule(state.hr, "No zone", "Mars/Olympus"))
            const four = newSchedule(state.hr, "Four-day week", "Europe/Berlin")
            state.four = four.workingScheduleId
            out.four = four.error
            const night = newSchedule(state.hr, "Night shift", "America/New_York")
            state.night = night.workingScheduleId
            state.other = newSchedule(state.hrB, "B's week", "Europe/Berlin", orgB).workingScheduleId
            // Monday to Thursday, 08:00 to 18:30 with a half-hour break: 10 hours a day
            out.lines = [1, 2, 3, 4].map(
                isoDay =>
                    line(state.four, {isoDay, startTime: "08:00", endTime: "18:30", breakMinutes: 30, fromDate: "2027-01-01"})
                        .error
            )
            out.overlap = code(line(state.four, {isoDay: 1, startTime: "18:00", endTime: "20:00", fromDate: "2027-01-01"}))
            out.breakTooLong = code(line(state.four, {isoDay: 5, startTime: "08:00", endTime: "09:00", breakMinutes: 60}))
            out.badTime = code(line(state.four, {isoDay: 5, startTime: "8 am", endTime: "12:00"}))
            out.stale = code(
                run(state.hr, S + "store#ScheduleLine", {
                    workingScheduleId: state.four,
                    expectedRevision: "1",
                    isoDay: 5,
                    startTime: "08:00",
                    endTime: "12:00"
                })
            )
            out.hrBLine = code(line(state.four, {isoDay: 5, startTime: "08:00", endTime: "12:00"}, state.hrB))
            // Saturday 22:00 to Sunday 06:00; a Sunday line from 05:00 overlaps its morning
            out.nightLine = line(state.night, {isoDay: 6, startTime: "22:00", endTime: "06:00", fromDate: "2027-01-01"}).error
            out.midnight = code(line(state.night, {isoDay: 7, startTime: "05:00", endTime: "08:00", fromDate: "2027-01-01"}))
            const found = run(state.hr, S + "find#Schedules", {term: "four"}).schedules || []
            out.found = found.map(row => [row.scheduleName, row.weeklyHours, row.timeZone, row.canEdit].join("/")).join(";")
            out.readerFinds = (run(state.reader, S + "find#Schedules", {}).schedules || []).map(row => row.canEdit).join(",")
            out.hrBFinds = (run(state.hrB, S + "find#Schedules", {}).schedules || []).map(row => row.workingScheduleId).join(",")
            return out
        },
        then(out) {
            out.reader === "PERMISSION_DENIED"
            out.hrB === "ORGANIZATION_DENIED"
            out.zone === "ZONE_INVALID"
            out.four === ""
            out.lines.join(",") === ",,,"
            out.overlap === "OVERLAP"
            out.breakTooLong === "BREAK_INVALID"
            out.badTime === "TIME_INVALID"
            out.stale === "REVISION_CHANGED"
            out.hrBLine === "RECORD_UNAVAILABLE"
            out.nightLine === ""
            out.midnight === "OVERLAP"
            out.found === "Four-day week/40/Europe/Berlin/true"
            out.readerFinds === "false,false"
            out.hrBFinds === state.other
        }
    }
)

feature(
    "A person who follows the schedule from a date gets its hours from then, one who follows none keeps today's; a holiday of the schedule's calendar takes the day, another calendar's does not, and the assignment's calendar replaces the schedule's",
    {
        when() {
            const out = {}
            const calendar = (calendarName, organizationPartyId, username = state.hr) =>
                run(username, S + "store#HolidayCalendar", {calendarName, organizationPartyId})
            out.shared = code(calendar("Shared spec calendar", null))
            state.c1 = calendar("Spec A holidays", orgA).holidayCategoryId
            state.c3 = calendar("Spec A regional", orgA).holidayCategoryId
            state.cB = calendar("Spec B holidays", orgB, state.hrB).holidayCategoryId
            const holiday = (holidayCategoryId, workEffortName, holidayDate) =>
                run(state.hr, S + "store#Holiday", {holidayCategoryId, workEffortName, holidayDate})
            holiday(state.c1, "Spec day", "2027-03-03")
            holiday(state.c1, "Spec day two", "2027-03-10")
            holiday(state.c3, "Regional day", "2027-03-02")
            holiday(state.c3, "Regional day two", "2027-03-09")
            out.taken = code(holiday(state.c1, "Again", "2027-03-03"))
            out.calendarB = code(
                run(state.hr, S + "store#Schedule", {
                    workingScheduleId: state.four,
                    expectedRevision: revisionOf(state.four),
                    holidayCategoryId: state.cB
                })
            )
            out.calendar = run(state.hr, S + "store#Schedule", {
                workingScheduleId: state.four,
                expectedRevision: revisionOf(state.four),
                holidayCategoryId: state.c1
            }).error
            const assign = (parameters, username = state.hr) => run(username, S + "assign#Schedule", parameters)
            out.hrBAssign = code(
                assign({partyRelationshipId: state.anaEmp, workingScheduleId: state.four, fromDate: "2027-03-01"}, state.hrB)
            )
            out.outside = code(
                assign({partyRelationshipId: state.anaEmp, workingScheduleId: state.other, fromDate: "2027-03-01"})
            )
            const assigned = assign({
                partyRelationshipId: state.anaEmp,
                workingScheduleId: state.four,
                fromDate: "2027-03-01",
                operationKey: "WSCHED-ANA"
            })
            out.assigned = [assigned.error, assigned.applied].join("/")
            out.retry = assign({
                partyRelationshipId: state.anaEmp,
                workingScheduleId: state.four,
                fromDate: "2027-03-01",
                operationKey: "WSCHED-ANA"
            }).repeated
            out.same = code(assign({partyRelationshipId: state.anaEmp, workingScheduleId: state.four, fromDate: "2027-03-04"}))
            out.before = code(assign({partyRelationshipId: state.anaEmp, workingScheduleId: state.four, fromDate: "2027-02-15"}))
            out.override = assign({
                partyRelationshipId: state.anaEmp,
                workingScheduleId: state.four,
                holidayCategoryId: state.c3,
                fromDate: "2027-03-08"
            }).error
            const ana = capacity(state.ana, "2027-02-22", "2027-03-14")
            out.anaSource = ana.source
            // the week before: the policy's; the first week: Monday to Thursday, Wednesday the schedule's holiday and Tuesday
            // another calendar's working; the second week: the assignment's calendar takes Tuesday, the schedule's no longer
            // Wednesday
            out.weekBefore = ["2027-02-22", "2027-02-26", "2027-02-28"].map(day => ana.days[day].slice(0, 2).join("/")).join(",")
            out.first = ["2027-03-01", "2027-03-02", "2027-03-03", "2027-03-05"].map(day => ana.days[day].join("/")).join(",")
            out.second = ["2027-03-09", "2027-03-10"].map(day => ana.days[day].join("/")).join(",")
            const ben = capacity(state.ben, "2027-03-01", "2027-03-07")
            out.ben = [ben.source, ben.days["2027-03-01"].join("/"), ben.days["2027-03-06"].join("/")].join(",")
            out.zoneInUse = code(
                run(state.hr, S + "store#Schedule", {
                    workingScheduleId: state.four,
                    expectedRevision: revisionOf(state.four),
                    timeZone: "Asia/Tokyo"
                })
            )
            out.endAssigned = code(
                run(state.hr, S + "store#Schedule", {
                    workingScheduleId: state.four,
                    expectedRevision: revisionOf(state.four),
                    end: true,
                    thruDate: "2027-06-01"
                })
            )
            out.mgrFinds = (run(state.uMgr, S + "find#Schedules", {}).schedules || []).map(row => row.scheduleName).join(",")
            out.mgrSees = Array.from(
                new Set(
                    (run(state.uMgr, S + "get#Schedule", {workingScheduleId: state.four}).assignments || []).map(
                        row => row.partyId
                    )
                )
            ).join(",")
            out.mgrNight = code(run(state.uMgr, S + "get#Schedule", {workingScheduleId: state.night}))
            return out
        },
        then(out) {
            out.shared === "PERMISSION_DENIED"
            out.taken === "DAY_TAKEN"
            out.calendarB === "CALENDAR_UNAVAILABLE"
            out.calendar === ""
            out.hrBAssign === "RECORD_UNAVAILABLE"
            out.outside === "SCHEDULE_OUTSIDE"
            out.assigned === "/true"
            out.retry === true
            out.same === "NOTHING_CHANGES"
            out.override === ""
            out.anaSource === "schedule"
            out.before === "ASSIGNMENT_SCHEDULED"
            out.weekBefore === "8/8,8/8,0/0"
            out.first === "10/10/,10/10/,10/0/Spec day,0/0/"
            out.second === "10/0/Regional day two,10/10/"
            out.ben === "policy,8/8/,0/0/"
            out.zoneInUse === "ZONE_IN_USE"
            out.endAssigned === "SCHEDULE_ASSIGNED"
            out.mgrFinds === "Four-day week"
            out.mgrSees === state.ana
            out.mgrNight === "RECORD_UNAVAILABLE"
        }
    }
)

feature("A line changed from a date keeps the weeks before it, and a later change of the employment keeps the schedule", {
    when() {
        const out = {}
        const thursday = (run(state.hr, S + "get#Schedule", {workingScheduleId: state.four}).lines || []).find(
            row => row.isoDay === 4 && row.state === "current"
        )
        out.changed = line(state.four, {
            workingScheduleLineId: thursday.workingScheduleLineId,
            startTime: "08:00",
            endTime: "12:00",
            breakMinutes: 0,
            fromDate: "2027-04-01"
        }).error
        const ana = capacity(state.ana, "2027-03-25", "2027-04-01")
        out.thursdays = [ana.days["2027-03-25"][0], ana.days["2027-04-01"][0]].join("/")
        const leave = run(state.hr, "mantle.humanres.PeopleServices.apply#EmploymentChange", {
            partyRelationshipId: state.anaEmp,
            expectedRevision: run(state.hr, "mantle.humanres.PeopleServices.preview#EmploymentChange", {
                partyRelationshipId: state.anaEmp,
                changeKind: "leave"
            }).revision,
            changeKind: "leave",
            effectiveDate: "2027-05-03"
        })
        out.leave = [leave.error, leave.applied].join("/")
        out.carried = rows("mantle.humanres.employment.EmploymentAssignment", {partyRelationshipId: state.anaEmp})
            .filter(row => row.thruDate == null)
            .map(row => [row.stateEnumId, row.workingScheduleId === state.four, row.holidayCategoryId === state.c3].join("/"))
            .join(";")
        return out
    },
    then(out) {
        out.changed === ""
        out.thursdays === "10/4"
        out.leave === "/true"
        out.carried === "EasLeave/true/true"
    }
})

feature(
    "A night shift across a daylight saving change counts its true length on the day it starts, in capacity and a timesheet's week",
    {
        when() {
            const out = {}
            out.assigned = run(state.hr, S + "assign#Schedule", {
                partyRelationshipId: state.calEmp,
                workingScheduleId: state.night,
                fromDate: "2027-03-01"
            }).error
            // New York's clocks go forward early on Sunday, March 14 2027 and back early on Sunday, November 7 2027
            const spring = capacity(state.cal, "2027-03-06", "2027-03-14")
            out.spring = [
                spring.source,
                spring.days["2027-03-06"][0],
                spring.days["2027-03-13"][0],
                spring.days["2027-03-14"][0]
            ].join("/")
            out.fall = capacity(state.cal, "2027-11-06", "2027-11-06").days["2027-11-06"][0]
            const days = ["2027-03-08", "2027-03-09", "2027-03-10", "2027-03-11", "2027-03-12", "2027-03-13", "2027-03-14"]
            const week = run(state.hr, "mantle.work.TimesheetServices.get#WeekDays", {
                dayList: days,
                policy: {dayHours: 8, workDays: [1, 2, 3, 4, 5]},
                organizationPartyId: orgA,
                partyId: state.cal
            })
            out.week = [
                Number(week.expectedTotal),
                Array.from(week.weekDayList || []).find(row => row.day === "2027-03-13")?.isWorkday
            ].join("/")
            return out
        },
        then(out) {
            out.assigned === ""
            out.spring === "schedule/8/7/0"
            out.fall === 9
            out.week === "7/true"
        }
    }
)
