// People's leave requests (mantle.humanres.LeaveServices preview#Request, submit#Request, get#Request, decide#Request, find#Requests
// and get#TeamAbsences; impl-people P12, design-people §7, PE-07, PE-21): a morning and an afternoon of one day are two requests and a
// second morning is refused; a preview counts the days from the employment's week less the employer's holiday and the weekend; an
// approval the balance cannot hold, with the other reservations, is refused and records nothing, while another is approved and
// posts the leave taken once (a retry posts nothing); a cancellation asked by the person and approved reverses once, and HR's
// cancellation at once too; a blocked day is refused and one an approver may override is a warning; the reason is read on the
// request by the person, the approver and HR, and never in a list, a notice or the team calendar; another employer's HR is refused.
// Standalone: spec-local organizations, people, employments, groups and users, with artifact authorization disabled (the rules are
// the services' own checks). Days of March 2027 (Monday the 1st) in America/Chicago.
// Run: ./moq test mr-mantle --spec LeaveRequests
const prefix = "PEOPLE_LREQ_SPEC"
const orgA = prefix + "_A",
    orgB = prefix + "_B",
    since = "2001-01-01T00:00:00Z"
const L = "mantle.humanres.LeaveServices."
const ENTRY = "mantle.humanres.leave.LeaveLedgerEntry"
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
const entries = conditions => Array.from(ec.entity.find(ENTRY).condition(conditions).disableAuthz().list())
const total = list => Math.round(list.reduce((sum, row) => sum + Number(String(row.amount)), 0) * 10000) / 10000
function organization(partyId, name) {
    call("create#mantle.party.Party", {partyId, partyTypeEnumId: "PtyOrganization", ownerPartyId: partyId})
    call("create#mantle.party.Organization", {partyId, organizationName: name})
    call("create#mantle.party.PartyRole", {partyId, roleTypeId: "OrgInternal"})
}
function person(kind) {
    const partyId = prefix + "_" + kind
    call("create#mantle.party.Party", {partyId, partyTypeEnumId: "PtyPerson"})
    call("create#mantle.party.Person", {partyId, firstName: "Leave", lastName: kind})
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
    call("create#moqui.security.UserGroup", {userGroupId: id, description: "People leave requests " + kind})
    for (const permission of permissions)
        call("create#moqui.security.UserGroupPermission", {userGroupId: id, userPermissionId: permission, fromDate: since})
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
const submit = (values, username = state.uAna) =>
    run(username, L + "submit#Request", Object.assign({leaveTypeEnumId: "PltAnnual"}, values))
const decide = (leaveRequestId, decision, username = state.uMgr, extra = {}) =>
    run(username, L + "decide#Request", Object.assign({leaveRequestId, decision}, extra))
const statusOf = leaveRequestId =>
    ec.entity.find("mantle.humanres.leave.LeaveRequest").condition({leaveRequestId}).disableAuthz().one()?.statusEnumId

spec({
    stepwise: true,
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        organization(orgA, "People Leave Requests Spec A")
        organization(orgB, "People Leave Requests Spec B")
        // Ana works for A, managed by Max; HR of A and of B
        state.ana = person("ANA")
        state.anaEmp = employ(state.ana, orgA)
        state.max = person("MAX")
        employ(state.max, orgA)
        call("create#mantle.party.PartyRelationship", {
            relationshipTypeEnumId: "PrtManager",
            fromPartyId: state.max,
            toPartyId: state.ana,
            fromDate: since
        })
        state.hrParty = person("HR")
        employ(state.hrParty, orgA)
        state.hrBParty = person("HRB")
        employ(state.hrBParty, orgB)
        state.uAna = user("ANA", ["PEOPLE_SELF_SERVICE"], state.ana)
        state.uMgr = user("MAX", ["PEOPLE_SELF_SERVICE", "PEOPLE_TEAM_VIEW", "PEOPLE_REQUEST_APPROVE"], state.max)
        state.hr = user("HR", ["PEOPLE_HR_VIEW", "PEOPLE_HR_EDIT"], state.hrParty)
        state.hrB = user("HRB", ["PEOPLE_HR_VIEW", "PEOPLE_HR_EDIT"], state.hrBParty)
        // A's holiday on Monday the 15th
        call("create#mantle.work.effort.WorkEffort", {
            workEffortId: prefix + "_HOLIDAY",
            workEffortTypeEnumId: "WetEvent",
            purposeEnumId: "WepHoliday",
            workEffortName: "Founders' day",
            ownerPartyId: orgA,
            allDayStart: "2027-03-15"
        })
        // annual leave by allocation (days, an entitlement needed), assigned to Ana, 3 days granted for 2026
        const policy = run(state.hr, L + "store#Policy", {
            organizationPartyId: orgA,
            policyName: "Annual leave",
            leaveTypeEnumId: "PltAnnual",
            unitEnumId: "LuDays",
            allocationRequired: "Y",
            fromDate: "2026-01-01"
        })
        state.policy = policy.leavePolicyId
        state.setup = [
            policy.error,
            run(state.hr, L + "assign#Policy", {
                leavePolicyId: state.policy,
                partyRelationshipIds: [state.anaEmp],
                fromDate: "2026-01-01",
                reason: "Spec"
            }).error,
            run(state.hr, L + "allocate#Leave", {
                leavePolicyId: state.policy,
                partyRelationshipIds: [state.anaEmp],
                amount: "3",
                periodFromDate: "2026-01-01",
                periodThruDate: "2026-12-31",
                operationKey: prefix + "_GRANT"
            }).error
        ].join("")
    },
    cleanupSpec() {
        ec.message.clearErrors()
        login("john.doe")
    }
})

feature(
    "a morning and an afternoon of one day are two requests, a second morning is refused, and a preview counts working days",
    {
        when() {
            const out = {setup: state.setup}
            // the week of the 15th: the holiday and the weekend charge nothing
            const preview = run(state.uAna, L + "preview#Request", {
                leaveTypeEnumId: "PltAnnual",
                fromDate: "2027-03-12",
                thruDate: "2027-03-16"
            }).preview
            out.preview = preview
            const morning = submit({
                fromDate: "2027-03-02",
                dayPartEnumId: "LdpMorning",
                reason: "Dentist, private",
                operationKey: prefix + "_AM"
            })
            const afternoon = submit({fromDate: "2027-03-02", dayPartEnumId: "LdpAfternoon"})
            state.am = morning.leaveRequestId
            state.pm = afternoon.leaveRequestId
            out.amRetry = submit({fromDate: "2027-03-02", dayPartEnumId: "LdpMorning", operationKey: prefix + "_AM"})
            out.again = code(submit({fromDate: "2027-03-02", dayPartEnumId: "LdpMorning"}))
            out.made = [morning.error, afternoon.error, morning.chargedAmount, afternoon.chargedAmount].join("|")
            out.balance = (run(state.uAna, L + "get#MyBalances").balances || [])[0] || {}
            out.other = code(
                run(state.hrB, L + "preview#Request", {
                    partyRelationshipId: state.anaEmp,
                    leaveTypeEnumId: "PltAnnual",
                    fromDate: "2027-03-02"
                })
            )
            return out
        },
        then({setup, preview, made, amRetry, again, balance, other}) {
            setup == ""
            // Friday, the weekend, the holiday Monday and Tuesday: two days
            preview.chargedAmount == 2 && preview.canSubmit
            preview.days.map(day => day.charged).join() == "1,0,0,0,1"
            preview.days[3].holidayName == "Founders' day"
            preview.approverSteps.length == 1 && preview.approverSteps[0].approverNames == "Leave MAX"
            made == "||0.5|0.5"
            amRetry.repeated && amRetry.leaveRequestId == state.am
            again == "OVERLAP"
            // granted 3, nothing taken, 1 reserved by the two waiting requests
            balance.balance == 3 && balance.pending == 1 && balance.available == 2
            other == "RECORD_UNAVAILABLE"
        }
    }
)

feature(
    "an approval the balance cannot hold with the other reservations is refused and records nothing; refused, its reservation goes, and another posts the leave taken once",
    {
        when() {
            const out = {}
            const long = submit({fromDate: "2027-03-08", thruDate: "2027-03-09"})
            state.long = long.leaveRequestId
            out.long = long.error
            // HR takes a day back: 2 left, 1 reserved by the morning and the afternoon, so two days no longer fit
            out.adjusted = run(state.hr, L + "allocate#Leave", {
                leavePolicyId: state.policy,
                partyRelationshipIds: [state.anaEmp],
                amount: "-1",
                adjustment: true,
                reason: "Spec correction",
                operationKey: prefix + "_ADJUST"
            }).error
            out.overspend = code(decide(state.long, "approve"))
            out.longStatus = statusOf(state.long)
            out.longDecisions = (
                run(state.uMgr, L + "get#Request", {leaveRequestId: state.long}).approval?.decisions || []
            ).length
            out.selfApprove = code(decide(state.am, "approve", state.uAna))
            // refused (a reason needed), its reservation goes; then the morning fits and is approved
            out.refusedNoReason = code(decide(state.long, "refuse"))
            out.refused = decide(state.long, "refuse", state.uMgr, {reason: "Busy week"}).statusEnumId
            out.approved = decide(state.am, "approve").statusEnumId
            out.retry = decide(state.am, "approve").repeated
            out.taken = entries({sourceKey: "leave:" + state.am})
            out.projection = Array.from(
                ec.entity
                    .find("mantle.humanres.leave.LeaveRequestSegment")
                    .condition({leaveRequestId: state.am})
                    .disableAuthz()
                    .list()
            )
            out.effort = out.projection[0]?.workEffortId
                ? ec.entity
                      .find("mantle.work.effort.WorkEffort")
                      .condition({workEffortId: out.projection[0].workEffortId})
                      .disableAuthz()
                      .one()
                : null
            out.reminders = out.effort
                ? Array.from(
                      ec.entity
                          .find("mantle.work.effort.WorkEffortReminder")
                          .condition({workEffortId: out.effort.workEffortId})
                          .disableAuthz()
                          .list()
                  )
                : []
            return out
        },
        then({
            long,
            adjusted,
            overspend,
            longStatus,
            longDecisions,
            selfApprove,
            approved,
            retry,
            taken,
            effort,
            reminders,
            refusedNoReason,
            refused
        }) {
            long == "" && adjusted == ""
            overspend == "BALANCE_INSUFFICIENT"
            longStatus == "LrsRequested" && longDecisions == 0
            // the person decides nothing (no PEOPLE_REQUEST_APPROVE; with it, record#Decision refuses their own request)
            selfApprove == "PERMISSION_DENIED"
            approved == "LrsApproved" && retry
            taken.length == 1 && total(taken) == -0.5
            // the projection: the person's time off, no type and no reason, and a reminder a day before
            effort.workEffortTypeEnumId == "WetTimeOff" && effort.workEffortName == "Out of office" && !effort.description
            reminders.length == 1 && reminders[0].partyId == state.ana
            refusedNoReason == "REASON_REQUIRED"
            refused == "LrsRefused"
        }
    }
)

feature("the reason is read on the request by the person, the approver and HR, never in a list, a notice or the team calendar", {
    when() {
        const out = {}
        out.own = run(state.uAna, L + "get#Request", {leaveRequestId: state.am}).request?.reason
        out.approver = run(state.uMgr, L + "get#Request", {leaveRequestId: state.am}).request?.reason
        out.hr = run(state.hr, L + "get#Request", {leaveRequestId: state.am}).request?.reason
        out.hrB = code(run(state.hrB, L + "get#Request", {leaveRequestId: state.am}))
        out.list = JSON.stringify(run(state.uMgr, L + "find#Requests", {}).requests || [])
        out.calendar = run(state.uMgr, L + "get#TeamAbsences", {start: "2027-03-01", end: "2027-03-31"}).eventList || []
        out.projection = run(state.uMgr, L + "get#AbsenceProjection", {
            start: Date.parse("2027-03-01T00:00:00Z"),
            end: Date.parse("2027-03-31T00:00:00Z")
        })
        // the Team absence projected CalDAV collection (CalendarDavServices): read only, the same items, no type or reason
        login(state.uMgr)
        try {
            out.collection =
                Array.from(
                    ec.service.sync().name("mantle.work.CalendarDavServices.get#DavCollections").call().collectionList || []
                ).find(row => row.collectionId === "projected-PeopleTeamAbsence") || null
            out.objects = Array.from(
                ec.service
                    .sync()
                    .name("mantle.work.CalendarDavServices.get#DavObjects")
                    .parameters({collectionId: "projected-PeopleTeamAbsence", withData: true})
                    .call().objectList || []
            )
            out.put = ec.service
                .sync()
                .name("mantle.work.CalendarDavServices.put#DavObject")
                .parameters({
                    collectionId: "projected-PeopleTeamAbsence",
                    objectName: "x.ics",
                    data: "BEGIN:VCALENDAR\nEND:VCALENDAR"
                })
                .call().status
        } finally {
            ec.message.clearErrors()
            login("john.doe")
            ec.artifactExecution.disableAuthz()
        }
        out.notices = Array.from(
            ec.entity
                .find("moqui.security.user.NotificationMessage")
                .condition({topic: "PeopleLeaveApproval"})
                .condition("recordId", "in", [state.am, state.pm, state.long])
                .disableAuthz()
                .list()
        ).map(row => String(row.messageJson || "") + String(row.titleText || ""))
        return out
    },
    then({own, approver, hr, hrB, list, calendar, projection, collection, objects, put, notices}) {
        own == "Dentist, private" && approver == "Dentist, private" && hr == "Dentist, private"
        hrB == "RECORD_UNAVAILABLE"
        list.includes(state.am) && !list.includes("Dentist")
        calendar.length == 1 && calendar[0].title == "Leave ANA · Out (morning)" && !JSON.stringify(calendar).includes("Dentist")
        !JSON.stringify(calendar).includes("Annual")
        projection.admitted && projection.eventList.length == 1 && projection.eventList[0].summary == "Leave ANA · Out (morning)"
        collection.readOnly && collection.components == "VEVENT"
        objects.length == 1 &&
            objects[0].data.includes("Leave ANA") &&
            !objects[0].data.includes("Dentist") &&
            !objects[0].data.includes("Annual")
        put == 403
        notices.length >= 3 && notices.every(text => !text.includes("Dentist") && !text.includes("Annual"))
    }
})

feature("a cancellation the person asks reverses once when approved, and HR's cancellation reverses at once", {
    when() {
        const out = {}
        out.asked = decide(state.am, "cancel", state.uAna).statusEnumId
        out.cancelled = decide(state.am, "approve").statusEnumId
        out.retry = decide(state.am, "approve").repeated
        out.reversals = entries({sourceKey: "leave-reversal:" + state.am})
        const effortId = Array.from(
            ec.entity
                .find("mantle.humanres.leave.LeaveRequestSegment")
                .condition({leaveRequestId: state.am})
                .disableAuthz()
                .list()
        )[0].workEffortId
        out.effortStatus = ec.entity
            .find("mantle.work.effort.WorkEffort")
            .condition({workEffortId: effortId})
            .disableAuthz()
            .one().statusId
        // the afternoon: approved, then cancelled by HR at once (a reason needed)
        decide(state.pm, "approve")
        out.hrNoReason = code(decide(state.pm, "cancel", state.hr))
        out.hrCancel = decide(state.pm, "cancel", state.hr, {reason: "Shop closed"}).statusEnumId
        out.pmReversals = entries({sourceKey: "leave-reversal:" + state.pm})
        out.balance = (run(state.uAna, L + "get#MyBalances").balances || [])[0] || {}
        // only the person (or who asked) withdraws, and only a request that waits
        out.withdrawOther = code(decide(state.long, "withdraw", state.uMgr))
        out.withdrawRefused = code(decide(state.long, "withdraw", state.uAna))
        return out
    },
    then({
        asked,
        cancelled,
        retry,
        reversals,
        effortStatus,
        hrNoReason,
        hrCancel,
        pmReversals,
        balance,
        withdrawOther,
        withdrawRefused
    }) {
        asked == "LrsCancelRequested" && cancelled == "LrsCancelled" && retry
        reversals.length == 1 && total(reversals) == 0.5
        effortStatus == "WeCancelled"
        hrNoReason == "REASON_REQUIRED" && hrCancel == "LrsCancelled" && pmReversals.length == 1
        // 3 granted, 1 taken back, the half days taken and given back: 2, nothing pending
        balance.balance == 2 && balance.pending == 0 && balance.available == 2
        withdrawOther == "NOT_YOURS" && withdrawRefused == "NOT_PENDING"
    }
})

feature("a blocked day is refused, and one an approver may override is a warning the request carries", {
    when() {
        const out = {}
        const revision = run(state.hr, L + "get#Policy", {leavePolicyId: state.policy}).policy?.revision
        const block = run(state.hr, L + "store#BlockedInterval", {
            leavePolicyId: state.policy,
            fromDate: "2027-03-22",
            thruDate: "2027-03-24",
            reason: "Stocktake",
            expectedRevision: revision
        })
        out.block = block.error
        out.blocked = code(submit({fromDate: "2027-03-23"}))
        run(state.hr, L + "store#BlockedInterval", {
            leavePolicyId: state.policy,
            fromDate: "2027-03-29",
            thruDate: "2027-03-29",
            overrideAllowed: "Y",
            reason: "Inventory"
        })
        const preview = run(state.uAna, L + "preview#Request", {leaveTypeEnumId: "PltAnnual", fromDate: "2027-03-29"}).preview
        out.warning = preview.warnings.map(item => item.code).join()
        const made = submit({fromDate: "2027-03-29"})
        out.made = made.error
        // the requests the stocktake overlaps are listed for review
        const again = run(state.hr, L + "store#BlockedInterval", {
            leavePolicyId: state.policy,
            fromDate: "2027-03-29",
            thruDate: "2027-03-29",
            reason: "Inventory again"
        })
        out.overlapping = (again.overlappingRequests || []).map(row => row.leaveRequestId)
        out.request = made.leaveRequestId
        return out
    },
    then({block, blocked, warning, made, overlapping, request}) {
        block == ""
        blocked == "BLOCKED_DAY"
        warning == "BLOCKED_OVERRIDABLE"
        made == ""
        overlapping.join() == request
    }
})
