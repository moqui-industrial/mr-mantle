// Maintenance's stack contributions in Mantle (IronStone Maintenance design §1.4 Comms hooks, Sync and Meetings, §12; impl-maintenance
// P19; MaintenanceStack.js): the projected calendars (my work orders for the technician assigned, read only, a PUT refused 403; due PM
// of the planner's team only, not the other team's, and of every team for a reader on none; a user without the read not admitted);
// the calendar file of a work order's planned window (one with none NOT_SCHEDULED, another technician's NOT_ASSIGNED) and of a plan's
// next due; Report a problem from a chat message (read under the room check: a user outside the room gets nothing and cannot report
// from it, a user without MAINTENANCE_REQUEST is refused, two messages are ONE_SOURCE; the report files the message on the request); and a video call about a work order (the event related to it with the
// call link, the vendor and the technician invited; another technician, an unreachable attendee and another user's personal contact
// refused). Standalone: spec-local
// organization, teams, users, work and plans; the services as each user.
// Run: ./moq test mr-mantle --spec MaintenanceStack
const prefix = "MNT_STACK_SPEC"
const org = prefix + "_ORG",
    since = "2000-01-01T00:00:00Z"
const state = {}
const hour = 3600000,
    day = 24 * hour
const M = "mantle.work.MaintenanceServices."

// the call as a user (artifact authorization off), its result or the reason code it is refused with
function as(username, service, parameters = {}) {
    login(username)
    ec.artifactExecution.disableAuthz()
    try {
        return call(service, parameters)
    } catch (error) {
        const match = /([A-Z][A-Z0-9_]+):/.exec(String(error.message))
        return match ? match[1] : "ERROR " + error.message
    } finally {
        ec.message.clearErrors()
        login("john.doe")
        ec.artifactExecution.disableAuthz()
    }
}
function user(kind, permissions) {
    const id = prefix + "_U_" + kind
    call("create#moqui.security.UserGroup", {userGroupId: id, description: "Maintenance stack " + kind})
    for (const permission of permissions)
        call("create#moqui.security.UserGroupPermission", {userGroupId: id, userPermissionId: permission, fromDate: since})
    const partyId = prefix + "_P_" + kind
    call("create#mantle.party.Party", {partyId, partyTypeEnumId: "PtyPerson"})
    call("create#mantle.party.Person", {partyId, firstName: "Stack", lastName: kind})
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
        partyId,
        currentPassword: "16ac58bbfa332c1c55bd98b53e60720bfa90d394",
        passwordHashType: "SHA"
    })
    call("create#moqui.security.UserGroupMember", {userId: id, userGroupId: id, fromDate: since})
    state[kind + "_PARTY"] = partyId
    return id
}
function team(suffix, memberPartyIds) {
    const partyId = prefix + "_TEAM_" + suffix
    call("create#mantle.party.Party", {partyId, partyTypeEnumId: "PtyOrganization", ownerPartyId: org})
    call("create#mantle.party.Organization", {partyId, organizationName: "Stack team " + suffix})
    call("create#mantle.party.PartyRole", {partyId, roleTypeId: "OrgTeam"})
    for (const member of memberPartyIds)
        call("create#mantle.party.PartyRelationship", {
            relationshipTypeEnumId: "PrtMember",
            fromPartyId: member,
            fromRoleTypeId: "Assignee",
            toPartyId: partyId,
            toRoleTypeId: "OrgTeam",
            fromDate: since
        })
    return partyId
}
const localDay = ms => new Date(ms).toISOString().substring(0, 10)
const rows = (entity, conditions) => Array.from(ec.entity.find(entity).condition(conditions).disableAuthz().list())

spec({
    stepwise: true,
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        call("create#mantle.party.Party", {partyId: org, partyTypeEnumId: "PtyOrganization", ownerPartyId: org})
        call("create#mantle.party.Organization", {partyId: org, organizationName: "Maintenance Stack Spec"})
        call("create#mantle.party.PartyRole", {partyId: org, roleTypeId: "OrgInternal"})
        call("create#mantle.facility.Facility", {
            facilityId: prefix + "_SITE",
            facilityName: "Stack site",
            facilityTypeEnumId: "FcTpBuilding",
            ownerPartyId: org,
            timeZone: "America/Chicago"
        })
        for (const room of ["ROOM_A", "ROOM_B"])
            call("create#mantle.facility.Facility", {
                facilityId: prefix + "_" + room,
                facilityName: "Stack " + room,
                facilityTypeEnumId: "FcTpRoom",
                parentFacilityId: prefix + "_SITE"
            })
        state.planner = user("PLANNER", ["MAINTENANCE_VIEW", "MAINTENANCE_PLAN", "MAINTENANCE_REQUEST"])
        state.reader = user("READER", ["MAINTENANCE_VIEW"])
        state.tech = user("TECH", ["MAINTENANCE_ASSIGNED_VIEW", "MAINTENANCE_EXECUTE", "MAINTENANCE_REQUEST"])
        state.tech2 = user("TECH2", ["MAINTENANCE_ASSIGNED_VIEW", "MAINTENANCE_EXECUTE", "MAINTENANCE_REQUEST"])
        state.member = user("MEMBER", [])
        state.teamA = team("A", [state.PLANNER_PARTY, state.TECH_PARTY])
        state.teamB = team("B", [state.TECH2_PARTY])
        // a vendor's expert with an email address and no account, and a person with neither
        call("create#mantle.party.Party", {partyId: prefix + "_VENDOR", partyTypeEnumId: "PtyPerson"})
        call("create#mantle.party.Person", {partyId: prefix + "_VENDOR", firstName: "Vera", lastName: "Vendor"})
        call("mantle.party.ContactServices.create#EmailAddress", {
            partyId: prefix + "_VENDOR",
            emailAddress: "vera.vendor@example.com",
            contactMechPurposeId: "EmailPrimary"
        })
        // the technician's personal contact, with an email address (another user's to the planner)
        call("create#mantle.party.Party", {
            partyId: prefix + "_PRIVATE",
            partyTypeEnumId: "PtyPerson",
            privateOwnerUserId: state.tech
        })
        call("create#mantle.party.Person", {partyId: prefix + "_PRIVATE", firstName: "Pat", lastName: "Private"})
        call("mantle.party.ContactServices.create#EmailAddress", {
            partyId: prefix + "_PRIVATE",
            emailAddress: "pat.private@example.com",
            contactMechPurposeId: "EmailPrimary"
        })
        call("create#mantle.party.Party", {partyId: prefix + "_NOBODY", partyTypeEnumId: "PtyPerson"})
        call("create#mantle.party.Person", {partyId: prefix + "_NOBODY", firstName: "No", lastName: "Address"})
        // the technician's scheduled work order (tomorrow, two hours) and one with no planned window
        const now = Date.now()
        state.scheduled = as(state.planner, M + "create#MaintenanceWorkOrder", {
            facilityId: prefix + "_ROOM_A",
            workEffortName: "Replace the lamps",
            estimatedStartDate: new Date(now + day),
            estimatedCompletionDate: new Date(now + day + 2 * hour)
        }).workEffortId
        state.unscheduled = as(state.planner, M + "create#MaintenanceWorkOrder", {
            facilityId: prefix + "_ROOM_B",
            workEffortName: "Check the door closer"
        }).workEffortId
        for (const workEffortId of [state.scheduled, state.unscheduled])
            as(state.planner, M + "schedule#MaintenanceWorkOrder", {workEffortId, assigneePartyIds: [state.TECH_PARTY]})
        // two active calendar plans due in ten days, one of each team
        const firstDueLocal = localDay(now + 10 * day) + " 09:00"
        state.plans = {}
        for (const [key, room, teamPartyId] of [
            ["A", "ROOM_A", state.teamA],
            ["B", "ROOM_B", state.teamB]
        ]) {
            const made = as(state.planner, "mantle.work.MaintenancePlanServices.store#MaintenanceSchedule", {
                facilityId: prefix + "_" + room,
                scheduleName: "Stack plan " + key,
                intervalQuantity: 1,
                intervalUomId: "TF_mon",
                firstDueLocal,
                teamPartyId
            })
            as(state.planner, "mantle.work.MaintenancePlanServices.store#MaintenanceSchedule", {
                maintenanceScheduleId: made.maintenanceScheduleId,
                action: "activate"
            })
            state.plans[key] = made.maintenanceScheduleId
        }
    },
    cleanupSpec() {
        ec.message.clearErrors()
        login("john.doe")
    }
})

feature("my work orders is a projected collection of the technician's planned work, read only; a PUT is refused", {
    when() {
        const collections = username =>
            Array.from(as(username, "mantle.work.CalendarDavServices.get#DavCollections").collectionList || []).map(
                row => row.collectionId
            )
        const objects = as(state.tech, "mantle.work.CalendarDavServices.get#DavObjects", {
            collectionId: "projected-MaintenanceMyWork",
            withData: true
        }).objectList
        const put = as(state.tech, "mantle.work.CalendarDavServices.put#DavObject", {
            collectionId: "projected-MaintenanceMyWork",
            objectName: "maintenance-work-" + state.scheduled + ".ics",
            data: "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n"
        })
        const collection = Array.from(
            as(state.tech, "mantle.work.CalendarDavServices.get#DavCollections").collectionList || []
        ).find(row => row.collectionId === "projected-MaintenanceMyWork")
        return {
            techCollections: collections(state.tech),
            memberCollections: collections(state.member),
            collection,
            objects: Array.from(objects || []),
            put
        }
    },
    then({techCollections, memberCollections, collection, objects, put}) {
        collection.readOnly == true
        !techCollections.includes("projected-MaintenanceTeamDue")
        !memberCollections.includes("projected-MaintenanceMyWork")
        objects.length == 1
        objects[0].name == "maintenance-work-" + state.scheduled + ".ics"
        objects[0].data.includes("Work order " + state.scheduled + ": Replace the lamps")
        put.status == 403
    }
})

feature(
    "due PM for my teams projects the next due of the planner's team, every team's for a reader on none, nothing for a technician",
    {
        when() {
            const summaries = username =>
                Array.from(as(username, M + "get#MaintenanceDueProjection", {}).eventList || []).map(event => event.summary)
            return {
                planner: summaries(state.planner),
                reader: summaries(state.reader),
                tech: as(state.tech, M + "get#MaintenanceDueProjection", {checkOnly: true}).admitted
            }
        },
        then({planner, reader, tech}) {
            planner.length == 1
            planner[0].startsWith("Due: Stack plan A")
            reader.some(summary => summary.startsWith("Due: Stack plan A"))
            reader.some(summary => summary.startsWith("Due: Stack plan B"))
            tech == false
        }
    }
)

feature("a calendar file of a work order's planned window or a plan's next due; none for unscheduled or unassigned work", {
    when() {
        return {
            work: as(state.tech, M + "get#MaintenanceCalendarFile", {workEffortId: state.scheduled}),
            unscheduled: as(state.tech, M + "get#MaintenanceCalendarFile", {workEffortId: state.unscheduled}),
            unassigned: as(state.tech2, M + "get#MaintenanceCalendarFile", {workEffortId: state.scheduled}),
            due: as(state.reader, M + "get#MaintenanceCalendarFile", {maintenanceScheduleId: state.plans.A})
        }
    },
    then({work, unscheduled, unassigned, due}) {
        work.text.includes("BEGIN:VEVENT")
        work.text.includes("SUMMARY:Work order " + state.scheduled)
        work.fileName == "work-order-" + state.scheduled + ".ics"
        unscheduled == "NOT_SCHEDULED"
        unassigned == "NOT_ASSIGNED"
        due.text.includes("SUMMARY:Due: Stack plan A")
    }
})

feature("Report a problem from a chat message reads it under the room check and files it on the request", {
    when() {
        login(state.tech)
        ec.artifactExecution.disableAuthz()
        const room = call("org.moqui.chat.ChatServices.create#Room", {roomTypeEnumId: "CrtPrivate", roomName: "Stack shift"})
        const sent = call("org.moqui.chat.ChatServices.send#Message", {
            chatRoomId: room.chatRoomId,
            body: "<p>The door closer in room B is leaking oil</p><p>It drips on the floor</p>"
        })
        login("john.doe")
        const source = {chatRoomId: room.chatRoomId, eventSeq: sent.eventSeq}
        const prefill = as(state.tech, M + "get#MaintenanceProblemSource", source)
        const outsider = as(state.tech2, M + "get#MaintenanceProblemSource", source)
        const noRequest = as(state.reader, M + "get#MaintenanceProblemSource", source)
        const twoSources = as(state.tech, M + "get#MaintenanceProblemSource", Object.assign({voicemailId: "X"}, source))
        const outsiderReport = as(
            state.tech2,
            M + "report#MaintenanceProblem",
            Object.assign({facilityId: prefix + "_ROOM_B", summary: "Leak"}, source)
        )
        const report = as(
            state.tech,
            M + "report#MaintenanceProblem",
            Object.assign({facilityId: prefix + "_ROOM_B", summary: prefill.summary, description: prefill.description}, source)
        )
        // filed by the request's own join (link#CommunicationEventRecord)
        const filed = rows("mantle.request.RequestCommEvent", {requestId: report.requestId || "-"})
        return {prefill, outsider, noRequest, twoSources, outsiderReport, report, filed}
    },
    then({prefill, outsider, noRequest, twoSources, outsiderReport, report, filed}) {
        prefill.sourceKind == "chat"
        prefill.summary == "The door closer in room B is leaking oil"
        prefill.description.includes("It drips on the floor")
        prefill.sourceText.includes("Stack shift")
        outsider == "SOURCE_UNAVAILABLE"
        noRequest == "PERMISSION_DENIED"
        twoSources == "ONE_SOURCE"
        outsiderReport == "SOURCE_UNAVAILABLE"
        report.requestId != null
        filed.length == 1
    }
})

feature("a video call about a work order: an event related to it with the call link, the vendor and technician invited", {
    when() {
        const start = new Date(Date.now() + 2 * day)
        const made = as(state.tech, M + "add#MaintenanceVideoCall", {
            workEffortId: state.scheduled,
            attendeePartyId: prefix + "_VENDOR",
            startDate: start,
            durationMinutes: 45,
            note: "Bring the closer's model number"
        })
        const event = made.eventWorkEffortId
            ? ec.entity
                  .find("mantle.work.effort.WorkEffort")
                  .condition("workEffortId", made.eventWorkEffortId)
                  .disableAuthz()
                  .one()
            : null
        const parties = event
            ? rows("mantle.work.effort.WorkEffortParty", {workEffortId: event.workEffortId}).map(
                  row => row.partyId + ":" + row.statusId
              )
            : []
        const related = event
            ? rows("mantle.work.effort.WorkEffortAssoc", {
                  workEffortId: state.scheduled,
                  toWorkEffortId: event.workEffortId,
                  workEffortAssocTypeEnumId: "WeatRelatesTo"
              }).length
            : 0
        return {
            made,
            event,
            parties,
            related,
            otherTech: as(state.tech2, M + "add#MaintenanceVideoCall", {
                workEffortId: state.scheduled,
                attendeePartyId: prefix + "_VENDOR",
                startDate: start
            }),
            unreachable: as(state.planner, M + "add#MaintenanceVideoCall", {
                workEffortId: state.scheduled,
                attendeePartyId: prefix + "_NOBODY",
                startDate: start
            }),
            past: as(state.planner, M + "add#MaintenanceVideoCall", {
                workEffortId: state.scheduled,
                attendeePartyId: prefix + "_VENDOR",
                startDate: new Date(Date.now() - day)
            }),
            // another user's personal contact, as Commons' attendees leave it out (review R3)
            privateContact: as(state.planner, M + "add#MaintenanceVideoCall", {
                workEffortId: state.scheduled,
                attendeePartyId: prefix + "_PRIVATE",
                startDate: start
            })
        }
    },
    then({made, event, parties, related, otherTech, unreachable, past, privateContact}) {
        made.joinUrl.includes("/call/")
        event.infoUrl == made.joinUrl
        event.workEffortName.includes("work order " + state.scheduled)
        event.ownerPartyId == state.TECH_PARTY
        related == 1
        parties.includes(prefix + "_VENDOR:WeptOffered")
        parties.includes(state.TECH_PARTY + ":WeptAssigned")
        otherTech == "NOT_ASSIGNED"
        unreachable == "ATTENDEE_UNREACHABLE"
        privateContact == "ATTENDEE_UNAVAILABLE"
        past == "DATE_PAST"
    }
})
