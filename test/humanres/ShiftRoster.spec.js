// People's shift roster (mantle.humanres.ScheduleServices get#Roster, store#Shift, publish#Shifts, get#MyShifts, get#TeamShifts and
// get#ShiftProjection; impl-people P14, design-people §6 ShiftRoster, PE-06): a shift over another of the person, over their
// approved leave, after their employment ends or before now is refused, leave still waiting is a warning, and a preview writes
// nothing; the person themselves, an HR reader who does not edit and another employer's HR roster nothing, while the manager and HR
// of the employer do, each only with PEOPLE_ROSTER_EDIT (the user's call of Nov 12, 2026: without it they read the roster and save
// and publish nothing); a work location not the employer's is refused, and an overlap with a shift at an employer the caller does
// not read does not name its times; a draft changes no capacity, and a published shift takes its day's planned hours in place of the
// schedule's (not on top of them), once, its worker told once and seeing it in their shifts, on the team calendar and in the My
// shifts projection (a colleague sees its times alone, the worker never the rosterer's comments); a published shift changed or
// removed changes capacity again and is told.
// Standalone: spec-local organizations, people, employments, schedule, leave rows, groups and users, with artifact authorization
// disabled (the rules are the services' own checks). The weeks after next, in America/Chicago.
// Run: ./moq test mr-mantle --spec ShiftRoster
const prefix = "PEOPLE_SHIFT_SPEC"
const orgA = prefix + "_A",
    orgB = prefix + "_B",
    since = "2001-01-01T00:00:00Z",
    zone = "America/Chicago"
const S = "mantle.humanres.ScheduleServices."
const SHIFT = "mantle.humanres.schedule.ShiftAssignment"
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
const shiftCount = () => ec.entity.find(SHIFT).condition("partyId", state.ana).disableAuthz().count()
function addDay(day, count) {
    const [y, m, d] = day.split("-").map(Number)
    return new Date(Date.UTC(y, m - 1, d + count)).toISOString().slice(0, 10)
}
function organization(partyId, name) {
    call("create#mantle.party.Party", {partyId, partyTypeEnumId: "PtyOrganization", ownerPartyId: partyId})
    call("create#mantle.party.Organization", {partyId, organizationName: name})
    call("create#mantle.party.PartyRole", {partyId, roleTypeId: "OrgInternal"})
}
function person(kind) {
    const partyId = prefix + "_" + kind
    call("create#mantle.party.Party", {partyId, partyTypeEnumId: "PtyPerson"})
    call("create#mantle.party.Person", {partyId, firstName: "Shift", lastName: kind})
    return partyId
}
const employ = (partyId, organizationPartyId) =>
    call("mantle.humanres.EmploymentServices.create#Employment", {
        fromPartyId: partyId,
        toPartyId: organizationPartyId,
        fromDate: since
    }).partyRelationshipId
const manage = (managerPartyId, partyId) =>
    call("create#mantle.party.PartyRelationship", {
        relationshipTypeEnumId: "PrtManager",
        fromPartyId: managerPartyId,
        toPartyId: partyId,
        fromDate: since
    })
function user(kind, permissions, partyId) {
    const id = prefix + "_U_" + kind
    call("create#moqui.security.UserGroup", {userGroupId: id, description: "People shift roster " + kind})
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
// a leave request of a day, entered as its rows (the leave rules are LeaveRequests'): approved or waiting, whole or a half
function leaveDay(leaveRequestId, day, statusEnumId, dayPartEnumId) {
    call("create#mantle.humanres.leave.LeaveRequest", {
        leaveRequestId,
        partyRelationshipId: state.anaEmp,
        partyId: state.ana,
        organizationPartyId: orgA,
        leaveTypeEnumId: "PltAnnual",
        statusEnumId,
        fromDay: day,
        thruDay: day
    })
    call("create#mantle.humanres.leave.LeaveRequestSegment", {
        leaveRequestId,
        segmentSeqId: "01",
        fromDay: day,
        thruDay: day,
        dayPartEnumId
    })
    // approved leave's projection (Leave.js project), which capacity reads
    if (statusEnumId !== "LrsApproved") return
    const dayStart = ec.l10n.parseTimestamp(day + " 00:00:00.000", "yyyy-MM-dd HH:mm:ss.SSS", null, zone)
    const workEffortId = call("create#mantle.work.effort.WorkEffort", {
        workEffortTypeEnumId: "WetTimeOff",
        workEffortName: "Out of office",
        statusId: "WeApproved",
        ownerPartyId: state.ana,
        allDayStart: day,
        allDayEnd: day,
        estimatedStartDate: dayStart,
        estimatedCompletionDate: ec.l10n.parseTimestamp(addDay(day, 1) + " 00:00:00.000", "yyyy-MM-dd HH:mm:ss.SSS", null, zone)
    }).workEffortId
    call("create#mantle.work.effort.WorkEffortParty", {
        workEffortId,
        partyId: state.ana,
        roleTypeId: "Assignee",
        fromDate: since,
        statusId: "WeptAssigned"
    })
}
const shift = (username, values) => run(username, S + "store#Shift", Object.assign({action: "apply", timeZone: zone}, values))
// Ana's capacity by day: {day: [base, capacity]}
function capacity() {
    const entry = run(state.hr, "mantle.work.ResourceServices.get#PartyCapacity", {
        partyId: state.ana,
        fromDate: state.mon,
        thruDate: addDay(state.mon, 6)
    }).capacityList?.[0]
    const days = {}
    for (const row of Array.from(entry?.dayList || [])) days[row.day] = [Number(row.base), Number(row.capacity)]
    return days
}
function notices() {
    const ids = Array.from(
        ec.entity.find("moqui.security.user.NotificationMessageUser").condition("userId", state.uAna).disableAuthz().list()
    ).map(row => row.notificationMessageId)
    if (!ids.length) return []
    return Array.from(
        ec.entity
            .find("moqui.security.user.NotificationMessage")
            .condition("notificationMessageId", "in", ids)
            .condition("topic", "PeopleShiftChange")
            .disableAuthz()
            .list()
    ).map(row => row.titleText)
}

spec({
    stepwise: true,
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        // the Monday after next, in the users' zone
        const today = ec.l10n.format(ec.user.nowTimestamp, "yyyy-MM-dd", null, zone)
        const iso = new Date(today + "T12:00:00Z").getUTCDay() || 7
        state.mon = addDay(today, 15 - iso)
        state.tue = addDay(state.mon, 1)
        state.wed = addDay(state.mon, 2)
        state.thu = addDay(state.mon, 3)
        state.fri = addDay(state.mon, 4)
        state.sat = addDay(state.mon, 5)
        organization(orgA, "People Shift Roster Spec A")
        organization(orgB, "People Shift Roster Spec B")
        // Ana and Leo work for A, managed by Max; Leo's employment ends on Ana's Wednesday
        state.ana = person("ANA")
        state.anaEmp = employ(state.ana, orgA)
        state.leo = person("LEO")
        state.leoEmp = employ(state.leo, orgA)
        call("update#mantle.party.PartyRelationship", {
            partyRelationshipId: state.leoEmp,
            thruDate: ec.l10n.parseTimestamp(state.wed + " 00:00:00.000", "yyyy-MM-dd HH:mm:ss.SSS", null, zone)
        })
        state.max = person("MAX")
        employ(state.max, orgA)
        manage(state.max, state.ana)
        manage(state.max, state.leo)
        state.hrParty = person("HR")
        employ(state.hrParty, orgA)
        state.readerParty = person("READER")
        employ(state.readerParty, orgA)
        state.hrBParty = person("HRB")
        employ(state.hrBParty, orgB)
        // Ana also works for B, whose HR rosters her there
        state.anaEmpB = employ(state.ana, orgB)
        state.uAna = user("ANA", ["PEOPLE_SELF_SERVICE"], state.ana)
        state.uLeo = user("LEO", ["PEOPLE_SELF_SERVICE"], state.leo)
        state.uMgr = user("MAX", ["PEOPLE_SELF_SERVICE", "PEOPLE_TEAM_VIEW", "PEOPLE_ROSTER_EDIT"], state.max)
        state.hr = user("HR", ["PEOPLE_HR_VIEW", "PEOPLE_HR_EDIT", "PEOPLE_ROSTER_EDIT"], state.hrParty)
        state.reader = user("READER", ["PEOPLE_HR_VIEW", "PEOPLE_ROSTER_EDIT"], state.readerParty)
        state.hrB = user("HRB", ["PEOPLE_HR_VIEW", "PEOPLE_HR_EDIT", "PEOPLE_ROSTER_EDIT"], state.hrBParty)
        // the same manager and HR officer without PEOPLE_ROSTER_EDIT (accounts of the same people)
        state.uMgrRead = user("MAX_READ", ["PEOPLE_SELF_SERVICE", "PEOPLE_TEAM_VIEW"], state.max)
        state.hrRead = user("HR_READ", ["PEOPLE_HR_VIEW", "PEOPLE_HR_EDIT"], state.hrParty)
        // A's shop and B's
        for (const [facilityId, ownerPartyId] of [
            [prefix + "_SHOP_A", orgA],
            [prefix + "_SHOP_B", orgB]
        ])
            call("create#mantle.facility.Facility", {
                facilityId,
                facilityName: facilityId,
                ownerPartyId,
                facilityTypeEnumId: "FcTpRetailStore"
            })
        // Ana follows a week of 09:00 to 17:00, Monday to Friday, from today
        const week = run(state.hr, S + "store#Schedule", {
            organizationPartyId: orgA,
            scheduleName: "Shift spec week",
            timeZone: zone
        })
        state.week = week.workingScheduleId
        const revisionOf = () => run(state.hr, S + "get#Schedule", {workingScheduleId: state.week}).schedule?.revision
        const lines = [1, 2, 3, 4, 5].map(
            isoDay =>
                run(state.hr, S + "store#ScheduleLine", {
                    workingScheduleId: state.week,
                    expectedRevision: revisionOf(),
                    isoDay,
                    startTime: "09:00",
                    endTime: "17:00"
                }).error
        )
        const assigned = run(state.hr, S + "assign#Schedule", {
            partyRelationshipId: state.anaEmp,
            workingScheduleId: state.week,
            reason: "Spec"
        })
        // Ana's approved leave on Wednesday, and an afternoon off on Thursday still waiting
        leaveDay(prefix + "_LEAVE", state.wed, "LrsApproved", "LdpFull")
        leaveDay(prefix + "_ASKED", state.thu, "LrsRequested", "LdpAfternoon")
        state.setup = [week.error, ...lines, assigned.error].join("")
    },
    cleanupSpec() {
        ec.message.clearErrors()
        login("john.doe")
    }
})

feature(
    "an overlap, approved leave, an ended employment and a past start are refused; a preview writes nothing; only the manager and HR roster",
    {
        when() {
            const out = {setup: state.setup}
            const monday = {partyRelationshipId: state.anaEmp, startText: state.mon + " 10:00", endText: state.mon + " 20:00"}
            out.preview = run(state.uMgr, S + "store#Shift", Object.assign({timeZone: zone}, monday)).preview
            out.afterPreview = shiftCount()
            const made = shift(state.uMgr, Object.assign({operationKey: prefix + "_MON"}, monday))
            state.monShift = made.shiftAssignmentId
            out.made = [made.error, made.statusEnumId].join("|")
            out.retry = shift(state.uMgr, Object.assign({operationKey: prefix + "_MON"}, monday))
            out.overlap = code(
                shift(state.uMgr, {
                    partyRelationshipId: state.anaEmp,
                    startText: state.mon + " 19:00",
                    endText: state.mon + " 22:00"
                })
            )
            out.leave = code(
                shift(state.uMgr, {
                    partyRelationshipId: state.anaEmp,
                    startText: state.wed + " 09:00",
                    endText: state.wed + " 17:00"
                })
            )
            out.asked = run(state.uMgr, S + "store#Shift", {
                partyRelationshipId: state.anaEmp,
                startText: state.thu + " 13:00",
                endText: state.thu + " 17:00",
                timeZone: zone
            }).preview
            out.ended = code(
                shift(state.uMgr, {
                    partyRelationshipId: state.leoEmp,
                    startText: state.thu + " 09:00",
                    endText: state.thu + " 17:00"
                })
            )
            out.past = code(
                shift(state.uMgr, {partyRelationshipId: state.leoEmp, startText: "2020-01-06 09:00", endText: "2020-01-06 17:00"})
            )
            out.long = code(
                shift(state.uMgr, {
                    partyRelationshipId: state.leoEmp,
                    startText: state.mon + " 06:00",
                    endText: state.tue + " 07:00"
                })
            )
            // the same shift on Tuesday by the person, an HR reader, another employer's HR, then HR of the employer
            const tuesday = {partyRelationshipId: state.anaEmp, startText: state.tue + " 09:00", endText: state.tue + " 13:00"}
            out.self = code(shift(state.uAna, tuesday))
            out.reader = code(shift(state.reader, tuesday))
            out.hrB = code(shift(state.hrB, tuesday))
            // the manager and HR without PEOPLE_ROSTER_EDIT: refused the same shift, preview included; the manager reads the roster
            out.mgrRead = code(shift(state.uMgrRead, tuesday))
            out.mgrReadPreview = code(run(state.uMgrRead, S + "store#Shift", Object.assign({timeZone: zone}, tuesday)))
            out.hrRead = code(shift(state.hrRead, tuesday))
            out.mgrReadRoster = run(state.uMgrRead, S + "get#Roster", {fromDay: state.mon}).roster
            // B's shop for A's shift is refused; B's HR rostering Ana at B over A's Monday is told of an overlap without its times
            out.otherShop = code(shift(state.uMgr, Object.assign({facilityId: prefix + "_SHOP_B"}, tuesday)))
            out.overlapB = run(state.hrB, S + "store#Shift", {
                partyRelationshipId: state.anaEmpB,
                startText: state.mon + " 12:00",
                endText: state.mon + " 14:00",
                timeZone: zone
            }).preview
            out.overlapA = run(
                state.uMgr,
                S + "store#Shift",
                Object.assign({timeZone: zone}, monday, {startText: state.mon + " 12:00"})
            ).preview
            const byHr = shift(state.hr, tuesday)
            state.tueShift = byHr.shiftAssignmentId
            out.byHr = byHr.error
            out.rosterSelf = code(run(state.uAna, S + "get#Roster", {fromDay: state.mon}))
            out.roster = run(state.uMgr, S + "get#Roster", {fromDay: state.mon}).roster
            out.readerRoster = run(state.reader, S + "get#Roster", {fromDay: state.mon}).roster
            out.hrBRoster = run(state.hrB, S + "get#Roster", {fromDay: state.mon}).roster
            return out
        },
        then({
            setup,
            preview,
            afterPreview,
            made,
            retry,
            overlap,
            leave,
            asked,
            ended,
            past,
            long,
            self,
            reader,
            hrB,
            byHr,
            rosterSelf,
            roster,
            readerRoster,
            hrBRoster,
            mgrRead,
            mgrReadPreview,
            hrRead,
            mgrReadRoster,
            otherShop,
            overlapB,
            overlapA
        }) {
            setup == ""
            preview.canApply && preview.hours == 10 && preview.shiftDate == state.mon && preview.refusals.length == 0
            afterPreview == 0
            made == "|ShsDraft"
            retry.repeated && retry.shiftAssignmentId == state.monShift
            overlap == "OVERLAP"
            leave == "LEAVE_CONFLICT"
            asked.canApply && asked.warnings.map(item => item.code).join() == "LEAVE_REQUESTED"
            ended == "EMPLOYMENT_ENDED"
            past == "DATE_PAST"
            long == "TOO_LONG"
            // the person holds no roster permission; an HR reader and another employer's HR are answered as for a missing employment
            self == "PERMISSION_DENIED" && reader == "RECORD_UNAVAILABLE" && hrB == "RECORD_UNAVAILABLE"
            // without PEOPLE_ROSTER_EDIT the manager and HR save nothing, a preview neither; the manager still reads the roster
            mgrRead == "PERMISSION_DENIED" && mgrReadPreview == "PERMISSION_DENIED" && hrRead == "PERMISSION_DENIED"
            mgrReadRoster.lanes.map(lane => lane.personName).join() == "Shift ANA,Shift LEO"
            mgrReadRoster.lanes.every(lane => !lane.canRoster) && !mgrReadRoster.canRoster && mgrReadRoster.draftCount == 0
            mgrReadRoster.shifts.length == 1 && mgrReadRoster.shifts.every(row => !row.canChange)
            otherShop == "FACILITY_INVALID"
            overlapB.refusals.map(item => item.code + ": " + item.message).join() ==
                "OVERLAP: It overlaps another shift of the same person"
            overlapA.refusals.map(item => item.code).join() == "OVERLAP" &&
                overlapA.refusals[0].message.includes(state.mon + " 10:00")
            byHr == ""
            rosterSelf == "PERMISSION_DENIED"
            // the manager's lanes: Ana and Leo, rostered by them; Ana's leave and working hours drawn, her two drafts
            roster.lanes.map(lane => lane.personName).join() == "Shift ANA,Shift LEO"
            roster.lanes.every(lane => lane.canRoster)
            roster.lanes[0].leaveList.map(row => row.day + " " + row.partText).join() == state.wed + " Whole day"
            roster.lanes[0].plannedList.length == 5
            roster.shifts.map(row => row.shiftDate + " " + row.statusEnumId + " " + row.hours).join() ==
                state.mon + " ShsDraft 10," + state.tue + " ShsDraft 4"
            roster.draftCount == 2
            // the HR reader reads the employer's roster and changes none of it; B's HR sees none of A's people
            readerRoster.lanes.some(lane => lane.personName == "Shift ANA") && readerRoster.lanes.every(lane => !lane.canRoster)
            readerRoster.draftCount == 0
            hrBRoster.lanes.every(lane => lane.organizationPartyId == orgB)
        }
    }
)

feature("a published shift takes its day's hours in place of the schedule's, once, and its worker is told and sees it", {
    when() {
        const out = {}
        out.saturday = shift(state.uMgr, {
            partyRelationshipId: state.anaEmp,
            startText: state.sat + " 10:00",
            endText: state.sat + " 14:00",
            facilityId: prefix + "_SHOP_A",
            reason: "Covering the stocktake"
        }).error
        out.draft = capacity()
        // the manager without PEOPLE_ROSTER_EDIT publishes nothing, with the parameters the holder then publishes with
        out.readPublish = code(run(state.uMgrRead, S + "publish#Shifts", {fromDay: state.mon, days: 7}))
        const published = run(state.uMgr, S + "publish#Shifts", {fromDay: state.mon, days: 7})
        out.published = [published.error, published.publishedCount, published.notifiedCount, published.skipped?.length].join("|")
        out.again = run(state.uMgr, S + "publish#Shifts", {fromDay: state.mon, days: 7}).publishedCount
        out.after = capacity()
        out.notices = notices()
        out.mine = run(state.uAna, S + "get#MyShifts", {fromDay: state.mon, days: 7})
        out.team = run(state.uAna, S + "get#TeamShifts", {start: state.mon, end: state.sat}).eventList
        out.colleague = run(state.uLeo, S + "get#TeamShifts", {start: state.mon, end: state.sat}).eventList
        out.managerTeam = run(state.uMgr, S + "get#TeamShifts", {start: state.mon, end: state.sat}).eventList
        out.projection = run(state.uAna, S + "get#ShiftProjection", {}).eventList
        out.hrBProjection = run(state.hrB, S + "get#ShiftProjection", {checkOnly: true}).admitted
        // a Friday draft added after publishing changes nothing; the Monday shortened to 8 hours and the Saturday removed do
        out.friday = shift(state.uMgr, {
            partyRelationshipId: state.anaEmp,
            startText: state.fri + " 06:00",
            endText: state.fri + " 18:00"
        }).error
        const monday = run(state.uMgr, S + "get#Roster", {fromDay: state.mon}).roster.shifts.find(
            row => row.shiftDate == state.mon
        )
        out.changed = shift(state.uMgr, {
            shiftAssignmentId: state.monShift,
            endText: state.mon + " 18:00",
            expectedRevision: monday.revision
        })
        out.stale = code(
            shift(state.uMgr, {shiftAssignmentId: state.monShift, endText: state.mon + " 19:00", expectedRevision: "1"})
        )
        const saturday = run(state.uMgr, S + "get#Roster", {fromDay: state.mon}).roster.shifts.find(
            row => row.shiftDate == state.sat
        )
        out.removed = run(state.uMgr, S + "store#Shift", {
            action: "remove",
            shiftAssignmentId: saturday.shiftAssignmentId
        }).statusEnumId
        out.later = capacity()
        out.laterNotices = notices().length
        return out
    },
    then({
        saturday,
        draft,
        readPublish,
        colleague,
        published,
        again,
        after,
        notices,
        mine,
        team,
        managerTeam,
        projection,
        hrBProjection,
        friday,
        changed,
        stale,
        removed,
        later,
        laterNotices
    }) {
        saturday == ""
        // drafts plan nothing: the schedule's 8 hours on weekdays, none on Saturday, and Wednesday's leave
        draft[state.mon].join() == "8,8" && draft[state.sat].join() == "0,0" && draft[state.wed].join() == "8,0"
        readPublish == "PERMISSION_DENIED"
        published == "|3|1|0"
        again == 0
        // published: Monday's 10 hours replace the schedule's 8 (not 18), Tuesday's 4, Saturday's 4; Wednesday still on leave
        after[state.mon].join() == "10,10" && after[state.tue].join() == "4,4" && after[state.sat].join() == "4,4"
        after[state.wed].join() == "8,0" && after[state.thu].join() == "8,8"
        // told once, of the three
        notices.length == 1 && notices[0].includes("3 shifts published")
        mine.shifts.length == 3 && mine.nextShiftText.length > 0
        // the worker reads the work location, never the rosterer's comments
        mine.shifts.every(row => row.comments == "") && mine.shifts.some(row => row.facilityName == prefix + "_SHOP_A")
        team.length == 3 && team.every(event => event.kind == "workHours" && event.title.startsWith("Shift ANA · Shift"))
        team.some(event => event.title == "Shift ANA · Shift · " + prefix + "_SHOP_A")
        // a colleague (the same manager) sees Ana's shifts as their times alone
        colleague.filter(event => event.partyId == state.ana).length == 3
        colleague.every(event => event.title == "Shift ANA · Shift")
        managerTeam.filter(event => event.partyId == state.ana).length == 3
        projection.length == 3 && projection.every(event => event.uid.startsWith("people-shift-"))
        hrBProjection == false
        friday == ""
        changed.error == "" && changed.statusEnumId == "ShsPublished"
        stale == "REVISION_CHANGED"
        removed == "ShsCancelled"
        later[state.mon].join() == "8,8" && later[state.sat].join() == "0,0" && later[state.fri].join() == "8,8"
        laterNotices == 3
    }
})
