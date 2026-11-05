// Business time (impl-customer-service P4, F13, F65; mantle.work.CalendarServices get#BusinessTimeDue, get#BusinessTimeElapsed,
// store#WorkingHours, get#WorkingHours; BusinessTime.js): a team's working hours on its schedule calendar, stored by its
// manager and refused to someone else; minutes due across a weekend and the organization's holiday (an all-day WepHoliday it
// owns), to the minute in the schedule's zone; elapsed minutes less a pause; around the clock with no hours; and hours
// changed from a date leaving the days before as they were. Standalone: spec-local parties and users, the clock pinned to
// Friday 6 Nov 2026 16:30 in Chicago. Run: ./moq test mr-mantle --spec BusinessTime
const prefix = "BTS"
const org = prefix + "_ORG",
    otherOrg = prefix + "_OTHER_ORG",
    team = prefix + "_TEAM",
    zone = "America/Chicago",
    since = "2000-01-01T00:00:00Z"
const C = "mantle.work.CalendarServices."
// Chicago is UTC-6 in November: a wall time there as a Date
const chicago = (day, clock) => new Date(Date.parse(day + "T" + clock + ":00-06:00"))
const friday = chicago("2026-11-06", "16:30")
// a timestamp a service answers as epoch millis
const at = value => (value == null ? null : /^-?\d+$/.test(String(value)) ? Number(value) : Date.parse(String(value)))
const state = {}

function run(username, service, parameters) {
    login(username)
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
    }
}
const code = out => (/([A-Z][A-Z0-9_]+):/.exec(out.error || "") || [])[1] || (out.error ? "ERROR" : "")
function person(id, managesTeam) {
    call("create#mantle.party.Party", {partyId: id, partyTypeEnumId: "PtyPerson"})
    call("create#mantle.party.Person", {partyId: id, firstName: "Hours", lastName: id})
    if (managesTeam)
        call("create#mantle.party.PartyRelationship", {
            relationshipTypeEnumId: "PrtMember",
            fromPartyId: id,
            fromRoleTypeId: "Manager",
            toPartyId: team,
            fromDate: since
        })
    call("create#moqui.security.UserAccount", {
        userId: id,
        username: id,
        partyId: id,
        currentPassword: "16ac58bbfa332c1c55bd98b53e60720bfa90d394",
        passwordHashType: "SHA",
        timeZone: zone
    })
    return id
}
const due = (minutes, startDate = friday, organizationPartyId = org) =>
    call(C + "get#BusinessTimeDue", {partyId: team, organizationPartyId, startDate, minutes})

spec({
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        for (const [partyId, name, owner] of [
            [org, "Hours Spec Org", "_NA_"],
            [otherOrg, "Hours Spec Other Org", "_NA_"],
            [team, "Hours Spec Team", org]
        ]) {
            call("create#mantle.party.Party", {partyId, partyTypeEnumId: "PtyOrganization", ownerPartyId: owner})
            call("create#mantle.party.Organization", {partyId, organizationName: name})
        }
        call("create#mantle.party.PartyRole", {partyId: org, roleTypeId: "OrgInternal"})
        // the Monday after is the organization's holiday
        call("create#mantle.work.effort.WorkEffort", {
            workEffortTypeEnumId: "WetEvent",
            purposeEnumId: "WepHoliday",
            workEffortName: "Spec holiday",
            ownerPartyId: org,
            allDayStart: "2026-11-09"
        })
        state.manager = person(prefix + "_MANAGER", true)
        state.outsider = person(prefix + "_OUTSIDER", false)
        ec.user.setEffectiveTime(friday.getTime())
    },
    setup() {
        ec.artifactExecution.disableAuthz()
    },
    cleanup() {
        ec.artifactExecution.enableAuthz()
        login("john.doe")
    }
})

feature("a team's manager stores its working hours on its schedule calendar; someone else is refused", {
    when() {
        const hours = {partyId: team, workDays: "1,2,3,4,5", workStart: "09:00", workEnd: "17:00", timeZone: zone}
        const refused = run(state.outsider, C + "store#WorkingHours", hours)
        const stored = run(state.manager, C + "store#WorkingHours", hours)
        state.calendarId = stored.calendarId
        return {
            refused,
            stored,
            read: call(C + "get#WorkingHours", {partyId: team}),
            backwards: run(state.manager, C + "store#WorkingHours", Object.assign({}, hours, {workStart: "18:00"}))
        }
    },
    then({refused, stored, read, backwards}) {
        code(refused) == "PERMISSION_DENIED"
        stored.error == ""
        stored.calendarId != null
        read.text == "Mon-Fri 09:00-17:00 (America/Chicago)"
        code(backwards) == "HOURS_INVALID"
    }
})

feature("business minutes skip the weekend and the organization's holiday, to the minute in the schedule's zone", {
    when() {
        return {
            // Friday 16:30-17:00, then Tuesday from 9:00 (Monday is the holiday)
            tuesday: due(240),
            // another organization has no holiday: Monday
            monday: due(240, friday, otherOrg),
            elapsed: call(C + "get#BusinessTimeElapsed", {
                partyId: team,
                organizationPartyId: org,
                fromDate: friday,
                thruDate: chicago("2026-11-10", "12:30")
            }),
            paused: call(C + "get#BusinessTimeElapsed", {
                partyId: team,
                organizationPartyId: org,
                fromDate: friday,
                thruDate: chicago("2026-11-10", "12:30"),
                pauseList: [{fromDate: chicago("2026-11-10", "09:00"), thruDate: chicago("2026-11-10", "10:00")}]
            }),
            clock: call(C + "get#BusinessTimeDue", {organizationPartyId: org, startDate: friday, minutes: 240})
        }
    },
    then({tuesday, monday, elapsed, paused, clock}) {
        tuesday.configured == true
        at(tuesday.dueDate) == chicago("2026-11-10", "12:30").getTime()
        at(monday.dueDate) == chicago("2026-11-09", "12:30").getTime()
        elapsed.minutes == 240
        paused.minutes == 180
        // no schedule: around the clock
        clock.configured == false
        at(clock.dueDate) == chicago("2026-11-06", "20:30").getTime()
    }
})

feature("hours changed from a date leave the days before as they were", {
    when() {
        const changed = run(state.manager, C + "store#WorkingHours", {
            partyId: team,
            workDays: [1, 2, 3, 4, 5],
            workStart: "10:00",
            workEnd: "16:00",
            fromDate: chicago("2026-11-16", "00:00")
        })
        return {
            changed,
            // Thursday the 12th keeps 9:00-17:00
            thursday: call(C + "get#BusinessTimeElapsed", {
                partyId: team,
                organizationPartyId: org,
                fromDate: chicago("2026-11-12", "00:00"),
                thruDate: chicago("2026-11-13", "00:00")
            }),
            // from Friday the 13th 16:30: half an hour that day, then Monday the 16th from 10:00
            later: due(60, chicago("2026-11-13", "16:30")),
            now: call(C + "get#WorkingHours", {partyId: team})
        }
    },
    then({changed, thursday, later, now}) {
        changed.error == ""
        changed.calendarId == state.calendarId
        thursday.minutes == 480
        at(later.dueDate) == chicago("2026-11-16", "10:30").getTime()
        now.workStart == "09:00"
    }
})
