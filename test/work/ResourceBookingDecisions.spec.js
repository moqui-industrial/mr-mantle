// Resource booking decisions (mantle.work.ResourceBookingServices find#ResourceBookingRequests, decide#ResourceBooking,
// decide#ResourceBookings and the ResourceBooking topic's services; EventServices' booking guard; IronStone Maintenance design §7.1,
// BookingRequests; impl-maintenance P16, F15, F165, F171, F172): a request tells the room's approvers; two approvers of overlapping
// requests cannot both assign (the second is answered the conflict); a non-approver and a holder who approves nothing here are
// refused; a denial needs its reason; a moved booking returns to requested and its old notice decides nothing, the new span does;
// the bulk decision names each failure and goes on; the availability read answers planned, requested, assigned and down intervals
// apart with no title of a hidden event; an unmanaged room's daily series is refused by a blackout on its third meeting, while a
// conflict past its first meeting is not checked (as before); an inventory asset with no policy is booked as before P15; and
// Manufacturing's offline time of a work center, recorded with its center locked, refuses a booking of the center under it; and a request
// withdrawn (its booking or its event cancelled) leaves the approvers' inboxes. F356–F358: People's interview (an event People keeps)
// is booked by its organizer and by no attendee; People's change rechecks the booking as the system (a clash refused and named Busy,
// F358; a free time asks the approved booking again) and its cancel withdraws the booking and its notices.
// Standalone: spec-local organization, building, rooms, equipment, a plant with a work center, groups and users; the services
// called as each user with the artifact check aside.
// Run: ./moq test mr-mantle --spec ResourceBookingDecisions
const prefix = "RBD"
const org = prefix + "_A",
    building = prefix + "_BLDG",
    room = prefix + "_ROOM_M",
    plainRoom = prefix + "_ROOM_U",
    projector = prefix + "_PROJ",
    stock = prefix + "_STOCK",
    plant = prefix + "_PLANT",
    line = prefix + "_LINE",
    since = "2000-01-01T00:00:00Z"
const R = "mantle.work.ResourceBookingServices.",
    E = "mantle.work.EventServices."
const state = {}
const hour = 3600000,
    day = 24 * hour
// four days ahead at 09:00 UTC, so every booking lies in the future
const base = Math.floor(Date.now() / day) * day + 4 * day + 9 * hour
const at = (hours, days = 0) => new Date(base + days * day + hours * hour)
const ms = value =>
    value instanceof Date ? value.getTime() : /^-?\d+$/.test(String(value)) ? Number(value) : Date.parse(String(value))

// the service's answer as a user, with its error text ("" when none), in its own transaction
function as(username, service, parameters = {}) {
    login(username)
    ec.artifactExecution.disableAuthz()
    ec.message.pushErrors()
    try {
        const out = ec.service.sync().name(service).parameters(parameters).requireNewTransaction(true).call() || {}
        return Object.assign({}, out, {error: ec.message.hasError() ? ec.message.getErrorsString() : ""})
    } catch (error) {
        return {error: String(error.message)}
    } finally {
        ec.message.clearErrors()
        ec.message.popErrors()
        login("john.doe")
        ec.artifactExecution.disableAuthz()
    }
}
const code = answer => (/([A-Z][A-Z0-9_]+):/.exec(answer.error || "") || [])[1] || answer.error
function user(kind, permissions) {
    const id = prefix + "_U_" + kind
    call("create#moqui.security.UserGroup", {userGroupId: id, description: "Booking decisions " + kind})
    for (const permission of permissions)
        call("create#moqui.security.UserGroupPermission", {userGroupId: id, userPermissionId: permission, fromDate: since})
    const partyId = prefix + "_P_" + kind
    call("create#mantle.party.Party", {partyId, partyTypeEnumId: "PtyPerson"})
    call("create#mantle.party.Person", {partyId, firstName: "Decision", lastName: kind})
    call("create#mantle.party.PartyRelationship", {
        relationshipTypeEnumId: "PrtAgent",
        fromPartyId: partyId,
        toPartyId: org,
        toRoleTypeId: "OrgInternal",
        fromDate: since
    })
    call("create#moqui.security.UserAccount", {
        userId: id,
        username: id,
        userFullName: "Decision " + kind,
        partyId,
        currentPassword: "16ac58bbfa332c1c55bd98b53e60720bfa90d394",
        passwordHashType: "SHA"
    })
    call("create#moqui.security.UserGroupMember", {userId: id, userGroupId: id, fromDate: since})
    state[kind + "_PARTY"] = partyId
    return id
}
function event(username, name, from, to, rrule) {
    return as(username, E + "create#Event", {
        workEffortName: name,
        estimatedStartDate: from,
        estimatedCompletionDate: to,
        rrule: rrule || null
    }).workEffortId
}
const roomBooking = workEffortId =>
    ec.entity.find("mantle.work.effort.WorkEffortFacility").condition({workEffortId, facilityId: room}).disableAuthz().one()
// the user's unviewed notices of a topic, newest first
const notices = (userId, topic) =>
    Array.from(
        ec.entity
            .find("moqui.security.user.NotificationMessageUser")
            .condition("userId", userId)
            .condition("viewedDate", "is-null", null)
            .disableAuthz()
            .list()
    )
        .map(row =>
            ec.entity
                .find("moqui.security.user.NotificationMessage")
                .condition("notificationMessageId", row.notificationMessageId)
                .disableAuthz()
                .one()
        )
        .filter(notice => notice?.topic === topic)
        .sort((a, b) => ms(b.sentDate) - ms(a.sentDate))
const noticeFor = (userId, workEffortId) =>
    notices(userId, "ResourceBooking").find(notice => notice.recordId === workEffortId) || null

spec({
    stepwise: true,
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        call("create#mantle.party.Party", {partyId: org, partyTypeEnumId: "PtyOrganization", ownerPartyId: org})
        call("create#mantle.party.Organization", {partyId: org, organizationName: org})
        call("create#mantle.party.PartyRole", {partyId: org, roleTypeId: "OrgInternal"})
        call("create#mantle.facility.Facility", {
            facilityId: building,
            facilityTypeEnumId: "FcTpBuilding",
            facilityName: "Decision building",
            ownerPartyId: org
        })
        for (const [facilityId, facilityName] of [
            [room, "Decision room"],
            [plainRoom, "Plain decision room"]
        ])
            call("create#mantle.facility.Facility", {
                facilityId,
                facilityTypeEnumId: "FcTpRoom",
                facilityName,
                parentFacilityId: building,
                bookable: "Y",
                capacity: 6
            })
        call("create#mantle.product.asset.Asset", {
            assetId: projector,
            assetTypeEnumId: "AstTpEquipment",
            assetName: "Decision projector",
            statusId: "AstAvailable",
            ownerPartyId: org,
            facilityId: building,
            bookable: "Y"
        })
        call("create#mantle.product.asset.Asset", {
            assetId: stock,
            assetTypeEnumId: "AstTpInventory",
            assetName: "Decision cable stock",
            ownerPartyId: org,
            facilityId: building
        })
        call("create#mantle.facility.Facility", {
            facilityId: plant,
            facilityTypeEnumId: "FcTpPlant",
            facilityName: "Decision plant",
            ownerPartyId: org
        })
        call("create#mantle.facility.Facility", {
            facilityId: line,
            facilityTypeEnumId: "FcTpLine",
            facilityName: "Decision line",
            parentFacilityId: plant,
            ownerPartyId: org,
            bookable: "Y"
        })
        call("create#mantle.work.production.WorkCenter", {facilityId: line})
        state.first = user("FIRST", ["RESOURCE_BOOKING_VIEW_ASSIGNED", "RESOURCE_BOOKING_APPROVE"])
        state.second = user("SECOND", ["RESOURCE_BOOKING_VIEW_ASSIGNED", "RESOURCE_BOOKING_APPROVE"])
        state.elsewhere = user("ELSEWHERE", ["RESOURCE_BOOKING_VIEW_ASSIGNED", "RESOURCE_BOOKING_APPROVE"])
        state.policyReader = user("READER", ["RESOURCE_POLICY_VIEW", "MAINTENANCE_RESOURCE_VIEW"])
        state.ann = user("ANN", [])
        state.bob = user("BOB", ["RESOURCE_BOOKING_OVERRIDE"])
        state.scheduler = user("SCHEDULER", ["PRODUCTION_SCHEDULE", "PRODUCTION_VIEW"])
        state.recruiter = user("RECRUITER", ["PEOPLE_RECRUIT_VIEW", "PEOPLE_RECRUIT_EDIT"])
        // the room is managed: approved by its two approvers, an override allowed with a reason
        call("create#mantle.work.effort.ResourceBookingPolicy", {
            facilityId: room,
            organizationPartyId: org,
            fromDate: since,
            bookable: "Y",
            approvalModeEnumId: "RbamApprovers",
            bookingHorizonDays: 60,
            softConflictOverride: "Y",
            revision: 1
        })
        for (const partyId of [state.FIRST_PARTY, state.SECOND_PARTY])
            call("create#mantle.facility.FacilityParty", {
                facilityId: room,
                partyId,
                roleTypeId: "BookingApprover",
                fromDate: since
            })
        // the plain room is not managed; it is closed on the third day of the week ahead
        call("create#mantle.work.effort.ResourceUnavailability", {
            unavailabilityKindEnumId: "RukPlanned",
            facilityId: plainRoom,
            organizationPartyId: org,
            fromDate: at(0, 2),
            thruDate: at(8, 2),
            unavailabilityReasonEnumId: "RurClosure",
            plannedOutage: "Y",
            description: "Painting",
            revision: 1
        })
        // the projector is out of service from the fifth day (an actual outage)
        call("create#mantle.work.effort.ResourceUnavailability", {
            unavailabilityKindEnumId: "RukActual",
            assetId: projector,
            organizationPartyId: org,
            fromDate: at(0, 5),
            unavailabilityReasonEnumId: "RurEquipmentFault",
            plannedOutage: "N",
            description: "Lamp failed",
            revision: 1
        })
    },
    cleanupSpec() {
        ec.message.clearErrors()
        login("john.doe")
    }
})

feature("a request tells the room's two approvers; two approvers of overlapping requests cannot both assign", {
    when() {
        const annEvent = event(state.ann, "Ann planning", at(1), at(2))
        const annBooked = as(state.ann, E + "book#Resource", {workEffortId: annEvent, facilityId: room})
        // Bob's overlapping request: refused while Ann's waits (its provisional hold), requested with the override and a reason
        const bobEvent = event(state.bob, "Bob review", at(1.5), at(2.5))
        const bobRefused = as(state.bob, E + "book#Resource", {workEffortId: bobEvent, facilityId: room})
        const bobBooked = as(state.bob, E + "book#Resource", {
            workEffortId: bobEvent,
            facilityId: room,
            allowConflicts: true,
            overrideReason: "Client visit"
        })
        state.annEvent = annEvent
        state.bobEvent = bobEvent
        const firstNotice = noticeFor(state.first, annEvent)
        const secondNotice = noticeFor(state.second, annEvent)
        const listed = as(state.first, R + "find#ResourceBookingRequests", {facilityId: room})
        const annRow = listed.requestList.find(row => row.workEffortId === annEvent)
        const bobRow = listed.requestList.find(row => row.workEffortId === bobEvent)
        // the first approves Ann's from the list; the second approves Bob's, which now clashes with an assigned booking
        const firstApproves = as(state.first, R + "decide#ResourceBooking", {
            workEffortId: annEvent,
            facilityId: room,
            decision: "approve",
            expectedStatusId: annRow.expectedStatusId,
            expectedFromDate: annRow.expectedFromDate,
            expectedThruDate: annRow.expectedThruDate
        })
        const secondApproves = as(state.second, R + "decide#ResourceBooking", {
            workEffortId: bobEvent,
            facilityId: room,
            decision: "approve",
            expectedFromDate: bobRow.expectedFromDate,
            expectedThruDate: bobRow.expectedThruDate
        })
        return {
            annBooked,
            bobRefused,
            bobBooked,
            firstNotice,
            secondNotice,
            listed,
            annRow,
            firstApproves,
            secondApproves,
            annStatus: roomBooking(annEvent).statusId,
            bobStatus: roomBooking(bobEvent).statusId,
            annNoticeLeft: noticeFor(state.second, annEvent),
            annTold: notices(state.ann, "ResourceBookingNotice").filter(notice => notice.recordId === annEvent).length
        }
    },
    then(r) {
        r.annBooked.statusId == "WefRequested"
        r.bobRefused.error.includes("is booked then: Busy")
        r.bobBooked.statusId == "WefRequested"
        r.firstNotice != null
        r.secondNotice != null
        JSON.parse(r.firstNotice.messageJson).facilityId == room
        // the notice names the room and the span, never the meeting's title
        !r.firstNotice.messageJson.includes("Ann planning")
        r.listed.requestList.length == 2
        r.annRow.canDecide == true
        r.annRow.purpose == "Not shared with you"
        r.annRow.requesterName == "Decision ANN"
        r.firstApproves.error == ""
        r.firstApproves.statusId == "WefAssigned"
        code(r.secondApproves) == "CONFLICT"
        r.secondApproves.error.includes("Busy")
        r.annStatus == "WefAssigned"
        r.bobStatus == "WefRequested"
        // the decision took Ann's request out of the other approver's inbox and told Ann
        r.annNoticeLeft == null
        r.annTold == 1
    }
})

feature(
    "a non-approver and an approver of other rooms are refused; a denial needs its reason; the bulk decision names its failures",
    {
        when() {
            const outsider = as(state.ann, R + "decide#ResourceBooking", {
                workEffortId: state.bobEvent,
                facilityId: room,
                decision: "deny",
                reason: "No"
            })
            const elsewhere = as(state.elsewhere, R + "decide#ResourceBooking", {
                workEffortId: state.bobEvent,
                facilityId: room,
                decision: "deny",
                reason: "No"
            })
            const readerList = as(state.policyReader, R + "find#ResourceBookingRequests", {facilityId: room})
            const elsewhereList = as(state.elsewhere, R + "find#ResourceBookingRequests", {})
            const noReason = as(state.second, R + "decide#ResourceBooking", {
                workEffortId: state.bobEvent,
                facilityId: room,
                decision: "deny"
            })
            // the bulk denial: Bob's request denied, Ann's (assigned now) named as no longer waiting
            const bulk = as(state.second, R + "decide#ResourceBookings", {
                bookingList: ["facility|" + room + "|" + state.bobEvent, "facility|" + room + "|" + state.annEvent].join(","),
                decision: "deny",
                reason: "The room is taken"
            })
            return {
                outsider,
                elsewhere,
                readerList,
                elsewhereList,
                noReason,
                bulk,
                bob: roomBooking(state.bobEvent),
                bobTold: notices(state.bob, "ResourceBookingNotice").filter(notice => notice.recordId === state.bobEvent)
            }
        },
        then(r) {
            code(r.outsider) == "PERMISSION_DENIED"
            code(r.elsewhere) == "NOT_APPROVER"
            // a policy reader sees the requests, read only; an approver of no room here sees none
            r.readerList.requestList.length == 1
            r.readerList.requestList[0].canDecide == false
            r.elsewhereList.requestList.length == 0
            code(r.noReason) == "REASON_REQUIRED"
            r.bulk.decidedCount == 1
            r.bulk.failedCount == 1
            r.bulk.resultList.find(row => row.workEffortId == state.annEvent).reasonCode == "STATE_CHANGED"
            r.bob.statusId == "WefRequestDenied"
            r.bob.comments.startsWith("Denied: The room is taken")
            r.bobTold.length == 1
            JSON.parse(r.bobTold[0].messageJson).outcome == "denied"
        }
    }
)

feature("a moved booking returns to requested; its old notice decides nothing, the new span is decided", {
    when() {
        // Ann's approved meeting moves an hour later: asked again, her approvers told of the new time
        call("update#mantle.work.effort.WorkEffort", {
            workEffortId: state.annEvent,
            estimatedStartDate: at(3),
            estimatedCompletionDate: at(4)
        })
        const moved = as(state.ann, E + "check#ResourceBookings", {workEffortId: state.annEvent})
        const status = roomBooking(state.annEvent).statusId
        const notice = noticeFor(state.first, state.annEvent)
        const message = JSON.parse(notice.messageJson)
        // it moves again before anyone decides: the notice of the hour before is stale
        call("update#mantle.work.effort.WorkEffort", {
            workEffortId: state.annEvent,
            estimatedStartDate: at(5),
            estimatedCompletionDate: at(6)
        })
        const stale = as(state.first, R + "approve#ResourceBooking", {
            recordEntityName: "mantle.work.effort.WorkEffort",
            recordId: state.annEvent,
            message
        })
        const again = as(state.ann, E + "check#ResourceBookings", {workEffortId: state.annEvent})
        const fresh = JSON.parse(noticeFor(state.first, state.annEvent).messageJson)
        const approved = as(state.first, R + "approve#ResourceBooking", {
            recordEntityName: "mantle.work.effort.WorkEffort",
            recordId: state.annEvent,
            message: fresh
        })
        return {moved, status, message, stale, again, fresh, approved, after: roomBooking(state.annEvent).statusId}
    },
    then(r) {
        r.moved.error == ""
        r.moved.rerequestedCount == 1
        r.status == "WefRequested"
        r.message.fromMs == at(3).getTime()
        code(r.stale) == "SPAN_CHANGED"
        r.again.error == ""
        r.fresh.fromMs == at(5).getTime()
        r.approved.error == ""
        r.after == "WefAssigned"
    }
})

feature("the availability read answers planned, requested, assigned and down apart, with no title of a hidden event", {
    when() {
        // a request of the room by Bob on the second day; Ann's assigned meeting today; the plain room's closure; the projector's outage
        const bobLater = event(state.bob, "Bob private", at(1, 1), at(2, 1))
        as(state.bob, E + "book#Resource", {workEffortId: bobLater, facilityId: room})
        const roomRead = as(state.ann, R + "get#ResourceAvailability", {facilityId: room, fromDate: at(-1), thruDate: at(0, 3)})
        const plainRead = as(state.ann, R + "get#ResourceAvailability", {
            facilityId: plainRoom,
            fromDate: at(-1),
            thruDate: at(0, 3)
        })
        const projectorRead = as(state.ann, R + "get#ResourceAvailability", {
            assetId: projector,
            fromDate: at(0, 4),
            thruDate: at(0, 6)
        })
        return {roomRead, plainRead, projectorRead}
    },
    then({roomRead, plainRead, projectorRead}) {
        roomRead.intervalList.find(row => row.kind == "assigned").label == "Ann planning"
        roomRead.intervalList.find(row => row.kind == "requested").label == "Busy"
        roomRead.intervalList.find(row => row.kind == "requested").workEffortId == null
        !JSON.stringify(roomRead.intervalList).includes("Bob private")
        plainRead.intervalList.map(row => row.kind) == ["planned"]
        !JSON.stringify(plainRead.intervalList).includes("Painting")
        projectorRead.intervalList.map(row => row.kind) == ["actual"]
        projectorRead.intervalList[0].label == "Out of service"
    }
})

feature(
    "an unmanaged room's daily series is refused by a blackout on its third meeting; a conflict past its first is not checked",
    {
        when() {
            // another booking of the plain room on the second day only
            const other = event(state.bob, "Bob day two", at(0, 1), at(1, 1))
            const otherBooked = as(state.bob, E + "book#Resource", {workEffortId: other, facilityId: plainRoom})
            const daily = event(state.ann, "Ann daily", at(0), at(1), "FREQ=DAILY;COUNT=5")
            const dailyBooked = as(state.ann, E + "book#Resource", {workEffortId: daily, facilityId: plainRoom})
            const twoDays = event(state.ann, "Ann two days", at(0), at(1), "FREQ=DAILY;COUNT=2")
            const twoDaysBooked = as(state.ann, E + "book#Resource", {workEffortId: twoDays, facilityId: plainRoom})
            return {otherBooked, dailyBooked, twoDaysBooked}
        },
        then({otherBooked, dailyBooked, twoDaysBooked}) {
            otherBooked.statusId == "WefAssigned"
            dailyBooked.error.includes("Plain decision room is not available then (closed (blackout))")
            // its second meeting clashes with Bob's: conflicts are checked on the first meeting only, as before
            twoDaysBooked.error == ""
            twoDaysBooked.statusId == "WefAssigned"
        }
    }
)

feature("an inventory asset with no policy is booked as before; a work center's offline time refuses a booking of it under it", {
    when() {
        const cables = event(state.ann, "Ann cables", at(1), at(2))
        const stockBooked = as(state.ann, E + "book#Resource", {workEffortId: cables, assetId: stock})
        const created = as(state.ann, E + "create#Event", {
            workEffortName: "Ann more cables",
            estimatedStartDate: at(3),
            estimatedCompletionDate: at(4),
            assetId: stock
        })
        const assigned = ec.entity
            .find("mantle.work.effort.WorkEffortAssetAssign")
            .condition({workEffortId: created.workEffortId, assetId: stock})
            .disableAuthz()
            .one()?.statusId
        const freeBusy = as(state.ann, E + "get#FreeBusy", {assetIdList: [stock], fromDate: at(0), thruDate: at(5)})
        // the scheduler takes the line offline through Manufacturing's call (its center locked, its moves none here)
        const offline = as(state.scheduler, "mantle.work.ProductionPlanningServices.store#WorkCenterOffline", {
            operationKey: prefix + "-offline-1",
            action: "apply",
            facilityId: line,
            fromDate: at(0, 1),
            thruDate: at(8, 1),
            reason: "Retooling"
        })
        const lineEvent = event(state.ann, "Ann line walk", at(2, 1), at(3, 1))
        const lineBooked = as(state.ann, E + "book#Resource", {workEffortId: lineEvent, facilityId: line})
        return {stockBooked, created, assigned, freeBusy, offline, lineBooked}
    },
    then({stockBooked, created, assigned, freeBusy, offline, lineBooked}) {
        stockBooked.error == ""
        stockBooked.statusId == "WeaaAssigned"
        created.error == ""
        assigned == "WeaaAssigned"
        freeBusy.error == ""
        freeBusy.freeBusyList.find(row => row.assetId == stock).busyList.length == 2
        offline.error == ""
        offline.result.resultCode == "OFFLINE_RECORDED"
        lineBooked.error.includes("Decision line is not available then (planned offline (production))")
    }
})

feature("a request withdrawn leaves the approvers' inboxes: its booking cancelled, or its event cancelled", {
    when() {
        const dropped = event(state.bob, "Bob dropped", at(1, 2), at(2, 2))
        as(state.bob, E + "book#Resource", {workEffortId: dropped, facilityId: room})
        const droppedAsked = noticeFor(state.first, dropped) != null
        const cancelled = as(state.bob, E + "cancel#ResourceBooking", {workEffortId: dropped, facilityId: room})
        const called = event(state.bob, "Bob called off", at(1, 3), at(2, 3))
        as(state.bob, E + "book#Resource", {workEffortId: called, facilityId: room})
        const calledAsked = noticeFor(state.second, called) != null
        const eventCancelled = as(state.bob, E + "cancel#EventOccurrence", {workEffortId: called})
        return {
            droppedAsked,
            cancelled,
            droppedLeft: [noticeFor(state.first, dropped), noticeFor(state.second, dropped)],
            calledAsked,
            eventCancelled,
            calledLeft: [noticeFor(state.first, called), noticeFor(state.second, called)]
        }
    },
    then(r) {
        r.droppedAsked == true
        r.cancelled.error == ""
        r.cancelled.cancelledCount == 1
        r.droppedLeft == [null, null]
        r.calledAsked == true
        r.eventCancelled.error == ""
        r.calledLeft == [null, null]
    }
})

feature("an interview's organizer books the managed room; People's change rechecks it and its cancel withdraws it", {
    when() {
        // the recruiter's interview, kept by People (an ApplicationInterview names it), with Ann on the panel
        const interview = event(state.recruiter, "Interview: decision analyst", at(1, 6), at(2, 6))
        call("create#mantle.humanres.employment.EmploymentApplication", {
            employmentApplicationId: prefix + "_APP",
            organizationPartyId: org,
            applyingPartyId: state.BOB_PARTY,
            statusId: "EaInterview"
        })
        call("create#mantle.humanres.recruitment.ApplicationInterview", {
            workEffortId: interview,
            employmentApplicationId: prefix + "_APP",
            organizationPartyId: org
        })
        call("create#mantle.work.effort.WorkEffortParty", {
            workEffortId: interview,
            partyId: state.ANN_PARTY,
            roleTypeId: "Assignee",
            fromDate: since,
            statusId: "WeptAssigned"
        })
        const access = as(state.recruiter, E + "check#EventAccess", {workEffortId: interview, permission: "check"})
        const panelBooks = as(state.ann, E + "book#Resource", {workEffortId: interview, facilityId: room})
        const booked = as(state.recruiter, E + "book#Resource", {workEffortId: interview, facilityId: room})
        const asked = noticeFor(state.first, interview)
        const approved = as(state.first, R + "approve#ResourceBooking", {
            recordEntityName: "mantle.work.effort.WorkEffort",
            recordId: interview,
            message: JSON.parse(asked.messageJson)
        })
        const afterApproval = roomBooking(interview).statusId
        // Bob holds the room later that day: a change into it is refused, the clash named Busy (the recheck runs as the system)
        const bobLater = event(state.bob, "Bob vendor demo", at(4, 6), at(5, 6))
        as(state.bob, E + "book#Resource", {workEffortId: bobLater, facilityId: room})
        const I = "mantle.humanres.RecruitingServices."
        const clash = as(state.recruiter, I + "change#Interview", {
            workEffortId: interview,
            startDate: at(4.5, 6),
            durationMinutes: 60
        })
        const keptAt = ms(
            ec.entity.find("mantle.work.effort.WorkEffort").condition("workEffortId", interview).disableAuthz().one()
                .estimatedStartDate
        )
        const moved = as(state.recruiter, I + "change#Interview", {
            workEffortId: interview,
            startDate: at(7, 6),
            durationMinutes: 60
        })
        const afterMove = roomBooking(interview).statusId
        const movedNotice = noticeFor(state.first, interview)
        const cancelled = as(state.recruiter, I + "cancel#Interview", {workEffortId: interview, reason: "Position filled"})
        return {
            access,
            panelBooks,
            booked,
            approved,
            afterApproval,
            clash,
            keptAt,
            moved,
            afterMove,
            movedFrom: movedNotice ? JSON.parse(movedNotice.messageJson).fromMs : null,
            cancelled,
            afterCancel: roomBooking(interview),
            left: [noticeFor(state.first, interview), noticeFor(state.second, interview)]
        }
    },
    then(r) {
        r.access.canEdit == false
        r.access.canBook == true
        r.access.managedBy != null
        r.panelBooks.error.includes("Only the organizer of Interview: decision analyst books its rooms and equipment")
        r.booked.error == ""
        r.booked.statusId == "WefRequested"
        r.approved.error == ""
        r.afterApproval == "WefAssigned"
        r.clash.error.includes("Decision room is booked then: Busy")
        !r.clash.error.includes("Bob vendor demo")
        r.keptAt == at(1, 6).getTime()
        r.moved.error == ""
        r.afterMove == "WefRequested"
        r.movedFrom == at(7, 6).getTime()
        r.cancelled.error == ""
        r.afterCancel == null
        r.left == [null, null]
    }
})
